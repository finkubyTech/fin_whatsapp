import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import connection from "../utils/dbUtil";
import { logger } from "../utils/logger";
import { isGroupJid, maskJid } from "../helpers/jid";
import { safeFetchBuffer } from "../helpers/safeFetch";
import type { ParsedContent } from "../helpers/messageParse";
import type { MediaKind, WaSessionSettings } from "../types";
import { getSettings } from "./sessions";
import { isOptedOut, recordOptOut } from "./optOuts";
import { send } from "./sender";
import { dispatch } from "./webhooks";

/**
 * What happens to a new incoming message after it is stored:
 *  1. auto-read (setting)
 *  2. STOP / UNSUBSCRIBE / OPT OUT on its own adds the chat to the opt-out list;
 *     that message gets no welcome and no auto-reply
 *  3. nothing more for a chat on the opt-out list
 *  4. welcome, on a brand-new private chat (skipped when the auto-reply would
 *     send the same text, so a first "hi" isn't answered twice)
 *  5. the first matching auto-reply rule (highest priority first)
 */
export const OPT_OUT_PATTERN = /^\s*(stop|unsubscribe|opt[\s-]?out)\W*$/i;

export interface AutoReplyRule {
    id: string;
    keyword: string;
    match_type: "EXACT" | "CONTAINS" | "REGEX";
    trigger_type: "ALL" | "GROUP" | "PRIVATE";
    response: string | null;
    media_url: string | null;
    media_type: MediaKind | null;
}

/** Whether auto-replies answer this sender at all (ALL, only SPECIFIC numbers, or everyone but a BLACKLIST). */
export function canAutoReply(settings: WaSessionSettings, senderJid: string): boolean {
    if (!settings.auto_reply_enabled) return false;
    const listed = settings.auto_reply_jids.some((entry) => entry && senderJid.includes(entry));
    if (settings.auto_reply_mode === "SPECIFIC") return listed;
    if (settings.auto_reply_mode === "BLACKLIST") return !listed;
    return true;
}

export function ruleMatches(
    rule: Pick<AutoReplyRule, "keyword" | "match_type" | "trigger_type">,
    text: string,
    isGroup: boolean
) {
    if (rule.trigger_type === "GROUP" && !isGroup) return false;
    if (rule.trigger_type === "PRIVATE" && isGroup) return false;
    const incoming = text.trim().toLowerCase();
    const keyword = rule.keyword.trim().toLowerCase();
    if (rule.match_type === "EXACT") return incoming === keyword;
    if (rule.match_type === "CONTAINS") return incoming.includes(keyword);
    try {
        return new RegExp(rule.keyword, "i").test(text);
    } catch {
        return false; // saving validates the pattern; an old bad one just never matches
    }
}

// Rules are read for every incoming message: cached per number, dropped on any change.
const TTL_MS = 60_000;
const rulesCache = new Map<string, { rules: AutoReplyRule[]; at: number }>();
export const invalidateAutoReplies = (sessionId: string) => rulesCache.delete(sessionId);

async function rulesFor(sessionId: string): Promise<AutoReplyRule[]> {
    const cached = rulesCache.get(sessionId);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.rules;
    const rules = await connection("wa_auto_replies")
        .where({ session_id: sessionId, is_active: true })
        .orderBy([{ column: "priority", order: "desc" }, { column: "created_at" }])
        .select(
            "id",
            "keyword",
            "match_type",
            "trigger_type",
            "response",
            "media_url",
            "media_type"
        );
    rulesCache.set(sessionId, { rules, at: Date.now() });
    return rules;
}

export async function findRule(sessionId: string, text: string, isGroup: boolean) {
    if (!text) return null;
    return (await rulesFor(sessionId)).find((rule) => ruleMatches(rule, text, isGroup)) ?? null;
}

const MIME_FALLBACK: Record<MediaKind, string> = {
    image: "image/jpeg",
    video: "video/mp4",
    audio: "audio/mp4",
    document: "application/octet-stream",
};

async function sendRule(
    session: { id: string },
    jid: string,
    rule: AutoReplyRule,
    quoted: WAMessage
) {
    if (rule.media_url && rule.media_type) {
        try {
            const file = await safeFetchBuffer(rule.media_url, { maxBytes: 25 * 1024 * 1024 });
            await send(
                session,
                jid,
                {
                    kind: "media",
                    media: rule.media_type,
                    buffer: file.buffer,
                    mime: file.contentType || MIME_FALLBACK[rule.media_type],
                    fileName: file.fileName,
                    caption: rule.response,
                },
                { quoted }
            );
            return;
        } catch (err: any) {
            logger.warn(
                `[automations] media auto-reply ${rule.id} failed (${err?.message}); sending its text instead`
            );
            if (!rule.response) return;
        }
    }
    if (rule.response) await send(session, jid, { kind: "text", text: rule.response }, { quoted });
}

export interface IncomingContext {
    session: { id: string; session_key: string };
    sock: WASocket;
    message: WAMessage;
    chatJid: string;
    senderJid: string;
    content: ParsedContent;
    chatIsNew: boolean;
}

export async function onIncoming(ctx: IncomingContext): Promise<void> {
    const { session, chatJid, content } = ctx;
    const settings = await getSettings(session.id);
    const isGroup = isGroupJid(chatJid);

    if (settings.auto_read) {
        ctx.sock
            .readMessages([ctx.message.key])
            .catch((err: any) => logger.debug(`[automations] auto-read: ${err?.message}`));
    }

    const text = content.type === "TEXT" ? content.text : "";
    if (!isGroup && text && OPT_OUT_PATTERN.test(text)) {
        if (await isOptedOut(session.id, chatJid)) return;
        // The one reply an opting-out customer gets: an auto-reply rule that matches the STOP message itself
        // (e.g. "Understood, we've noted your request."), sent once, before the opt-out blocks every send.
        const ack = canAutoReply(settings, ctx.senderJid)
            ? await findRule(session.id, text, false)
            : null;
        if (ack) {
            await sendRule(session, chatJid, ack, ctx.message).catch((err: any) =>
                logger.warn(
                    `[automations] opt-out acknowledgement to ${maskJid(chatJid)} failed: ${err?.message}`
                )
            );
        }
        if (await recordOptOut(session.id, chatJid, text.trim(), "KEYWORD")) {
            logger.info(`[automations] ${maskJid(chatJid)} opted out on ${session.session_key}`);
            dispatch(session, "opt_out", { jid: chatJid, message: text.trim(), source: "KEYWORD" });
        }
        return;
    }
    if (!isGroup && (await isOptedOut(session.id, chatJid))) return;

    const rule =
        text && canAutoReply(settings, ctx.senderJid)
            ? await findRule(session.id, text, isGroup)
            : null;

    if (!isGroup && ctx.chatIsNew && settings.welcome_message?.trim()) {
        const sameAsRule =
            rule && !rule.media_url && rule.response?.trim() === settings.welcome_message.trim();
        if (!sameAsRule)
            await send(session, chatJid, { kind: "text", text: settings.welcome_message });
    }
    if (rule) await sendRule(session, chatJid, rule, ctx.message);
}
