import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import connection from "../utils/dbUtil";
import { logger } from "../utils/logger";
import {
    bareJid,
    chatTypeOf,
    isGroupJid,
    isLidJid,
    isPersonJid,
    isStoredChat,
} from "../helpers/jid";
import { classifyMessage, ParsedContent, previewOf, timestampOf } from "../helpers/messageParse";
import type { MessageStatus } from "../types";
import { mediaUrl, storeMessageMedia } from "./media";
import { dispatch } from "./webhooks";
import { onIncoming } from "./automations";

/**
 * Baileys events -> wa_* rows, webhooks and automations.
 *
 * Live messages: one insert-if-new per message (the unique key id makes a
 * repeated event a no-op), one chat upsert that also says whether the chat is
 * new (for the welcome message), then media, webhook, automations.
 * History sync: batched inserts and one chat upsert per chat, no media
 * downloads, no webhooks, no automations (WA-AKG did each history message
 * one by one and downloaded all of its media).
 */
export interface IngestContext {
    session: { id: string; session_key: string };
    sock: WASocket;
    ownJid: () => string | null;
}

// proto.WebMessageInfo.Status: 0 ERROR, 1 PENDING, 2 SERVER_ACK, 3 DELIVERY_ACK, 4 READ, 5 PLAYED.
// (WA-AKG read these one step off: a delivered message showed as read.)
const ACK_STATUS: Record<number, MessageStatus> = {
    0: "FAILED",
    1: "PENDING",
    2: "SENT",
    3: "DELIVERED",
    4: "READ",
    5: "READ",
};
// A status only ever moves forward; FAILED and DELETED are final.
const RANK: Record<MessageStatus, number> = {
    PENDING: 0,
    SENT: 1,
    DELIVERED: 2,
    READ: 3,
    FAILED: 9,
    DELETED: 9,
};

// ---------------------------------------------------------------- @lid -> phone number

const lidCache = new Map<string, string>();
const remember = (key: string, phone: string) => {
    if (lidCache.size > 10_000) lidCache.clear();
    lidCache.set(key, phone);
};

/** A person's JID by phone number when it can be found; otherwise the JID as given. */
export async function phoneJidFor(
    ctx: IngestContext,
    jid: string,
    alt?: string | null
): Promise<string> {
    const plain = bareJid(jid);
    if (!isLidJid(plain)) return plain;
    if (alt && isPersonJid(alt) && !isLidJid(alt)) {
        remember(`${ctx.session.id}:${plain}`, bareJid(alt));
        return bareJid(alt);
    }
    const cacheKey = `${ctx.session.id}:${plain}`;
    const cached = lidCache.get(cacheKey);
    if (cached) return cached;

    const contact = await connection("wa_contacts")
        .where({ session_id: ctx.session.id })
        .andWhere((q) => q.where({ jid: plain }).orWhere({ lid: plain }))
        .whereNotNull("phone_jid")
        .first("phone_jid");
    let phone: string | null = contact?.phone_jid ?? null;
    if (!phone) {
        try {
            const pn = await (ctx.sock as any).signalRepository?.lidMapping?.getPNForLID(plain);
            phone = pn ? bareJid(pn) : null;
        } catch {
            phone = null;
        }
    }
    if (!phone) return plain;
    remember(cacheKey, phone);
    return phone;
}

// ---------------------------------------------------------------- rows

interface MessageRow {
    session_id: string;
    chat_jid: string;
    sender_jid: string | null;
    from_me: boolean;
    key_id: string;
    push_name: string | null;
    type: ParsedContent["type"];
    content: string | null;
    file_name: string | null;
    media_mime: string | null;
    status: MessageStatus;
    quoted_key_id: string | null;
    message_at: Date;
}

function rowOf(
    sessionId: string,
    message: WAMessage,
    content: ParsedContent,
    chatJid: string,
    senderJid: string | null
): MessageRow {
    const fromMe = !!message.key.fromMe;
    return {
        session_id: sessionId,
        chat_jid: chatJid,
        sender_jid: senderJid,
        from_me: fromMe,
        key_id: message.key.id!,
        push_name: fromMe ? null : (message.pushName ?? null),
        type: content.type,
        content: content.text || null,
        file_name: content.fileName,
        media_mime: content.mime,
        status: fromMe ? "SENT" : "DELIVERED",
        quoted_key_id: content.quotedKeyId,
        message_at: timestampOf(message.messageTimestamp),
    };
}

/** Chat and sender of a message, by phone number where possible. */
async function addressOf(ctx: IngestContext, message: WAMessage) {
    const key = message.key as any;
    const chatJid = await phoneJidFor(ctx, key.remoteJid, key.remoteJidAlt);
    let senderJid: string | null;
    if (key.fromMe) senderJid = ctx.ownJid();
    else if (isGroupJid(chatJid)) {
        senderJid = key.participant
            ? await phoneJidFor(ctx, key.participant, key.participantAlt)
            : null;
    } else senderJid = chatJid;
    return { chatJid, senderJid };
}

/** Insert-if-new. True when this call stored it. */
async function insertMessage(row: MessageRow): Promise<string | null> {
    const inserted = await connection("wa_messages")
        .insert(row)
        .onConflict(["session_id", "key_id"])
        .ignore()
        .returning("id");
    return inserted[0]?.id ?? null;
}

/**
 * Moves the chat's latest message forward (never back) and counts an incoming
 * live message as unread (a newer message of ours clears it). Returns whether
 * the chat row was created.
 */
async function touchChat(row: MessageRow, preview: string, countUnread: boolean): Promise<boolean> {
    const result = await connection.raw(
        `INSERT INTO wa_chats (session_id, jid, is_group, last_message_at, last_message_preview, last_message_from_me, unread_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, jid) DO UPDATE SET
           last_message_at = GREATEST(wa_chats.last_message_at, EXCLUDED.last_message_at),
           last_message_preview = CASE WHEN wa_chats.last_message_at IS NULL OR EXCLUDED.last_message_at >= wa_chats.last_message_at
                                       THEN EXCLUDED.last_message_preview ELSE wa_chats.last_message_preview END,
           last_message_from_me = CASE WHEN wa_chats.last_message_at IS NULL OR EXCLUDED.last_message_at >= wa_chats.last_message_at
                                       THEN EXCLUDED.last_message_from_me ELSE wa_chats.last_message_from_me END,
           unread_count = CASE WHEN EXCLUDED.last_message_from_me
                                 AND EXCLUDED.last_message_at >= COALESCE(wa_chats.last_message_at, '-infinity'::timestamptz)
                               THEN 0 ELSE wa_chats.unread_count + EXCLUDED.unread_count END,
           updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [
            row.session_id,
            row.chat_jid,
            isGroupJid(row.chat_jid),
            row.message_at,
            preview,
            row.from_me,
            countUnread && !row.from_me ? 1 : 0,
        ]
    );
    return !!result.rows[0]?.inserted;
}

async function upsertContacts(
    sessionId: string,
    contacts: {
        jid: string;
        lid?: string | null;
        phone_jid?: string | null;
        name?: string | null;
        notify?: string | null;
        verified_name?: string | null;
    }[]
) {
    const rows = contacts
        .filter((c) => isPersonJid(c.jid))
        .map((c) => ({
            session_id: sessionId,
            jid: c.jid,
            lid: c.lid ?? (isLidJid(c.jid) ? c.jid : null),
            phone_jid: c.phone_jid ?? (isLidJid(c.jid) ? null : c.jid),
            name: c.name ?? null,
            notify: c.notify ?? null,
            verified_name: c.verified_name ?? null,
        }));
    // One row per jid per statement (Postgres refuses to update a row twice in one INSERT).
    const unique = [...new Map(rows.map((r) => [r.jid, r])).values()];
    for (let i = 0; i < unique.length; i += 500) {
        const batch = unique.slice(i, i + 500);
        await connection.raw(
            `INSERT INTO wa_contacts (session_id, jid, lid, phone_jid, name, notify, verified_name)
             SELECT * FROM jsonb_to_recordset(?::jsonb)
               AS x(session_id uuid, jid text, lid text, phone_jid text, name text, notify text, verified_name text)
             ON CONFLICT (session_id, jid) DO UPDATE SET
               lid = COALESCE(EXCLUDED.lid, wa_contacts.lid),
               phone_jid = COALESCE(EXCLUDED.phone_jid, wa_contacts.phone_jid),
               name = COALESCE(EXCLUDED.name, wa_contacts.name),
               notify = COALESCE(EXCLUDED.notify, wa_contacts.notify),
               verified_name = COALESCE(EXCLUDED.verified_name, wa_contacts.verified_name),
               updated_at = now()`,
            [JSON.stringify(batch)]
        );
    }
}

// ---------------------------------------------------------------- webhook payload

function messagePayload(
    ctx: IngestContext,
    row: MessageRow,
    message: WAMessage,
    content: ParsedContent,
    media: string | null
) {
    const own = ctx.ownJid();
    const isGroup = isGroupJid(row.chat_jid);
    const isMedia = !!content.mediaField;
    return {
        key: {
            id: row.key_id,
            remoteJid: row.chat_jid,
            fromMe: row.from_me,
            participant: isGroup ? row.sender_jid : undefined,
        },
        pushName: message.pushName ?? null,
        messageTimestamp: Math.floor(row.message_at.getTime() / 1000),
        from: row.from_me ? own : row.chat_jid,
        receiver: row.from_me ? row.chat_jid : own,
        sender: row.from_me ? "ME" : row.sender_jid,
        isGroup,
        chatType: chatTypeOf(row.chat_jid),
        type: row.type,
        content: row.content,
        caption: isMedia ? row.content : undefined,
        fileName: row.file_name,
        mimetype: row.media_mime,
        fileUrl: mediaUrl(media),
        quoted: content.quoted,
        mentions: content.mentions,
    };
}

// ---------------------------------------------------------------- live messages

async function revoke(ctx: IngestContext, targetKeyId: string, message: WAMessage) {
    const updated = await connection("wa_messages")
        .where({ session_id: ctx.session.id, key_id: targetKeyId })
        .update({ status: "DELETED" });
    if (updated) {
        dispatch(ctx.session, "message.deleted", {
            keyId: targetKeyId,
            remoteJid: bareJid(message.key.remoteJid),
            fromMe: !!message.key.fromMe,
        });
    }
}

async function edit(ctx: IngestContext, targetKeyId: string, text: string, message: WAMessage) {
    const updated = await connection("wa_messages")
        .where({ session_id: ctx.session.id, key_id: targetKeyId })
        .update({ content: text });
    if (updated) {
        dispatch(ctx.session, "message.edited", {
            keyId: targetKeyId,
            newContent: text,
            remoteJid: bareJid(message.key.remoteJid),
            fromMe: !!message.key.fromMe,
        });
    }
}

export async function ingestLive(ctx: IngestContext, messages: WAMessage[], type: string) {
    for (const message of messages) {
        try {
            if (!message.key?.id || !isStoredChat(bareJid(message.key.remoteJid))) continue;
            const classified = classifyMessage(message.message);
            if (classified.kind === "revoke") await revoke(ctx, classified.targetKeyId, message);
            else if (classified.kind === "edit")
                await edit(ctx, classified.targetKeyId, classified.text, message);
            if (classified.kind !== "content") continue;

            const { content } = classified;
            const { chatJid, senderJid } = await addressOf(ctx, message);
            const row = rowOf(ctx.session.id, message, content, chatJid, senderJid);
            if (!(await insertMessage(row))) continue; // seen before

            const chatIsNew = await touchChat(row, previewOf(content), true);
            if (!isGroupJid(chatJid)) {
                await upsertContacts(ctx.session.id, [
                    {
                        jid: chatJid,
                        lid: isLidJid(message.key.remoteJid)
                            ? bareJid(message.key.remoteJid)
                            : null,
                        notify: row.from_me ? null : row.push_name,
                    },
                ]);
            }

            let media: string | null = null;
            if (content.mediaField) {
                media = await storeMessageMedia(
                    ctx.sock,
                    message,
                    ctx.session.session_key,
                    content.mediaField,
                    content.mime
                );
                if (media) {
                    await connection("wa_messages")
                        .where({ session_id: ctx.session.id, key_id: row.key_id })
                        .update({ media_path: media });
                }
            }

            dispatch(
                ctx.session,
                row.from_me ? "message.sent" : "message.received",
                messagePayload(ctx, row, message, content, media)
            );

            if (!row.from_me && type === "notify") {
                await onIncoming({
                    session: ctx.session,
                    sock: ctx.sock,
                    message,
                    chatJid,
                    senderJid: senderJid || chatJid,
                    content,
                    chatIsNew,
                });
            }
        } catch (err: any) {
            logger.error(
                `[ingest] message ${message.key?.id} on ${ctx.session.session_key}: ${err?.message}`
            );
        }
    }
}

// ---------------------------------------------------------------- history sync

export async function ingestHistory(ctx: IngestContext, messages: WAMessage[]) {
    const rows: MessageRow[] = [];
    const previews = new Map<string, { row: MessageRow; preview: string }>();
    for (const message of messages) {
        if (!message.key?.id || !isStoredChat(bareJid(message.key.remoteJid))) continue;
        const classified = classifyMessage(message.message);
        if (classified.kind !== "content") continue;
        const { chatJid, senderJid } = await addressOf(ctx, message);
        const row = rowOf(ctx.session.id, message, classified.content, chatJid, senderJid);
        rows.push(row);
        const latest = previews.get(chatJid);
        if (!latest || row.message_at > latest.row.message_at) {
            previews.set(chatJid, { row, preview: previewOf(classified.content) });
        }
    }
    for (let i = 0; i < rows.length; i += 500) {
        await connection("wa_messages")
            .insert(rows.slice(i, i + 500))
            .onConflict(["session_id", "key_id"])
            .ignore();
    }
    for (const { row, preview } of previews.values()) {
        await touchChat(row, preview, false); // history never counts as unread
    }
    if (rows.length)
        logger.info(
            `[ingest] ${ctx.session.session_key}: ${rows.length} history messages in ${previews.size} chats`
        );
}

// ---------------------------------------------------------------- statuses, contacts, groups

export async function applyStatusUpdates(ctx: IngestContext, updates: { key: any; update: any }[]) {
    for (const { key, update } of updates) {
        const ack = update?.status;
        if (!key?.id || typeof ack !== "number" || !(ack in ACK_STATUS)) continue;
        const status = ACK_STATUS[ack];
        const updated = await connection("wa_messages")
            .where({ session_id: ctx.session.id, key_id: key.id })
            .whereIn(
                "status",
                (Object.keys(RANK) as MessageStatus[]).filter((s) => RANK[s] < RANK[status])
            )
            .update({ status });
        if (updated) {
            dispatch(ctx.session, "message.status", {
                keyId: key.id,
                remoteJid: bareJid(key.remoteJid),
                status,
            });
        }
    }
}

export async function saveContacts(ctx: IngestContext, contacts: any[], notify: boolean) {
    const rows = contacts
        .filter((c) => c?.id)
        .map((c) => ({
            jid: bareJid(c.id),
            lid: c.lid ? bareJid(c.lid) : null,
            phone_jid: c.phoneNumber ? bareJid(c.phoneNumber) : null,
            name: c.name ?? null,
            notify: c.notify ?? null,
            verified_name: c.verifiedName ?? null,
        }));
    if (rows.length === 0) return;
    await upsertContacts(ctx.session.id, rows);
    if (notify) {
        for (const c of rows)
            dispatch(ctx.session, "contact.update", { jid: c.jid, name: c.name, notify: c.notify });
    }
}

const groupRow = (sessionId: string, g: any) => ({
    session_id: sessionId,
    jid: g.id,
    subject: g.subject ?? null,
    description: g.desc ?? null,
    owner_jid: g.owner ? bareJid(g.owner) : null,
    participants: JSON.stringify(
        (g.participants || []).map((p: any) => ({
            id: bareJid(p.id),
            phone: p.phoneNumber ? bareJid(p.phoneNumber) : null,
            admin: p.admin ?? null,
        }))
    ),
    announce: g.announce ?? null,
    restrict: g.restrict ?? null,
    is_community: !!g.isCommunity,
    created_on_whatsapp: g.creation ? new Date(g.creation * 1000) : null,
    updated_at: new Date(),
});

export async function saveGroups(sessionId: string, groups: any[]) {
    const rows = groups.filter((g) => g?.id).map((g) => groupRow(sessionId, g));
    for (let i = 0; i < rows.length; i += 200) {
        await connection("wa_groups")
            .insert(rows.slice(i, i + 200))
            .onConflict(["session_id", "jid"])
            .merge([
                "subject",
                "description",
                "owner_jid",
                "participants",
                "announce",
                "restrict",
                "is_community",
                "created_on_whatsapp",
                "updated_at",
            ]);
    }
}

export async function syncGroups(ctx: IngestContext) {
    try {
        const groups = Object.values(await ctx.sock.groupFetchAllParticipating());
        await saveGroups(ctx.session.id, groups);
        logger.info(`[ingest] ${ctx.session.session_key}: ${groups.length} groups synced`);
    } catch (err: any) {
        logger.error(`[ingest] group sync for ${ctx.session.session_key} failed: ${err?.message}`);
    }
}

/** Registers every listener the store needs on a new socket. */
export function bindIngest(ctx: IngestContext) {
    const ev = ctx.sock.ev;
    const guard = (what: string, run: () => Promise<unknown>) =>
        run().catch((err: any) =>
            logger.error(`[ingest] ${what} on ${ctx.session.session_key}: ${err?.message}`)
        );

    ev.on("messages.upsert", ({ messages, type }) =>
        guard("messages.upsert", () => ingestLive(ctx, messages, type))
    );
    ev.on("messaging-history.set", ({ messages, contacts }) =>
        guard("history", async () => {
            if (contacts?.length) await saveContacts(ctx, contacts, false);
            if (messages?.length) await ingestHistory(ctx, messages);
        })
    );
    ev.on("messages.update", (updates) =>
        guard("messages.update", () => applyStatusUpdates(ctx, updates))
    );
    ev.on("contacts.upsert", (contacts) =>
        guard("contacts.upsert", () => saveContacts(ctx, contacts, true))
    );
    ev.on("contacts.update", (contacts) =>
        guard("contacts.update", () => saveContacts(ctx, contacts, false))
    );
    ev.on("groups.upsert", (groups) =>
        guard("groups.upsert", () => saveGroups(ctx.session.id, groups))
    );
    ev.on("groups.update", (updates) =>
        guard("groups.update", async () => {
            for (const u of updates) {
                if (!u.id) continue;
                const patch: Record<string, unknown> = {};
                if (u.subject !== undefined) patch.subject = u.subject;
                if (u.desc !== undefined) patch.description = u.desc;
                if (u.announce !== undefined) patch.announce = u.announce;
                if (u.restrict !== undefined) patch.restrict = u.restrict;
                if (Object.keys(patch).length) {
                    await connection("wa_groups")
                        .where({ session_id: ctx.session.id, jid: u.id })
                        .update({ ...patch, updated_at: new Date() });
                }
                dispatch(ctx.session, "group.update", { jid: u.id, ...patch });
            }
        })
    );
    ev.on("group-participants.update", (update) =>
        guard("group-participants.update", async () => {
            dispatch(ctx.session, "group.participants", {
                jid: update.id,
                action: update.action,
                participants: (update.participants || []).map((p: any) =>
                    bareJid(typeof p === "string" ? p : p?.id)
                ),
            });
            const metadata = await ctx.sock.groupMetadata(update.id);
            await saveGroups(ctx.session.id, [metadata]);
        })
    );
}
