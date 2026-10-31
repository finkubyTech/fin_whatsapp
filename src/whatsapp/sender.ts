import crypto from "crypto";
import createHttpError from "http-errors";
import type { AnyMessageContent, WAMessage } from "@whiskeysockets/baileys";
import connection from "../utils/dbUtil";
import { isGroupJid } from "../helpers/jid";
import type { MediaKind } from "../types";
import { requireSocket } from "./registry";
import { getSettings } from "./sessions";
import { isOptedOut } from "./optOuts";
import { throttle } from "./throttle";
import { expectOutgoingMedia } from "./media";

/**
 * Every message this service sends goes through send(): the opt-out list, the
 * send throttle, then Baileys. The stored copy and the message.sent webhook
 * come from the message Baileys echoes back (see ingest), exactly as for a
 * message sent from the phone, so there is one path for both.
 */
export type OutgoingMessage =
    | { kind: "text"; text: string; mentions?: string[] }
    | {
          kind: "media";
          media: MediaKind;
          buffer: Buffer;
          mime: string;
          fileName?: string | null;
          caption?: string | null;
          voiceNote?: boolean;
      }
    | {
          kind: "location";
          latitude: number;
          longitude: number;
          name?: string | null;
          address?: string | null;
      }
    | { kind: "contact"; name: string; phone: string };

export interface SendOptions {
    /** Reply to a stored message (its key id). */
    quotedKeyId?: string | null;
    /** Reply to a message that just arrived (automations). */
    quoted?: WAMessage;
}

export interface SendResult {
    key_id: string;
    jid: string;
}

// WhatsApp Web style ids (3EB0 + hex): set up front so the media of an
// outgoing message can be stored from the buffer before Baileys echoes it.
const newMessageId = () => `3EB0${crypto.randomBytes(10).toString("hex").toUpperCase()}`;

const vcard = (name: string, phone: string) => {
    const digits = phone.replace(/\D/g, "");
    const clean = name.replace(/[\r\n;]/g, " ").trim();
    return `BEGIN:VCARD\nVERSION:3.0\nFN:${clean}\nTEL;type=CELL;waid=${digits}:+${digits}\nEND:VCARD`;
};

export function toBaileysContent(message: OutgoingMessage): AnyMessageContent {
    switch (message.kind) {
        case "text":
            return {
                text: message.text,
                ...(message.mentions?.length ? { mentions: message.mentions } : {}),
            };
        case "location":
            return {
                location: {
                    degreesLatitude: message.latitude,
                    degreesLongitude: message.longitude,
                    ...(message.name ? { name: message.name } : {}),
                    ...(message.address ? { address: message.address } : {}),
                },
            };
        case "contact":
            return {
                contacts: {
                    displayName: message.name,
                    contacts: [{ vcard: vcard(message.name, message.phone) }],
                },
            };
        case "media": {
            const caption = message.caption || undefined;
            if (message.media === "image")
                return { image: message.buffer, mimetype: message.mime, caption };
            if (message.media === "video")
                return { video: message.buffer, mimetype: message.mime, caption };
            if (message.media === "audio") {
                return { audio: message.buffer, mimetype: message.mime, ptt: !!message.voiceNote };
            }
            return {
                document: message.buffer,
                mimetype: message.mime,
                fileName: message.fileName || "document",
                caption,
            };
        }
    }
}

/** A stored message as the quoted stub Baileys needs for a reply. */
async function quotedStub(sessionId: string, keyId: string): Promise<WAMessage> {
    const row = await connection("wa_messages")
        .where({ session_id: sessionId, key_id: keyId })
        .first("chat_jid", "from_me", "key_id", "sender_jid", "content");
    if (!row) throw new createHttpError.NotFound("The message to reply to was not found");
    return {
        key: {
            remoteJid: row.chat_jid,
            fromMe: row.from_me,
            id: row.key_id,
            ...(isGroupJid(row.chat_jid) && !row.from_me ? { participant: row.sender_jid } : {}),
        },
        message: { conversation: row.content || "" },
    } as WAMessage;
}

export async function send(
    session: { id: string },
    jid: string,
    message: OutgoingMessage,
    options: SendOptions = {}
): Promise<SendResult> {
    const sock = requireSocket(session.id);
    if (!isGroupJid(jid) && (await isOptedOut(session.id, jid))) {
        throw new createHttpError.Conflict(
            "This number has opted out of WhatsApp messages from us"
        );
    }
    const quoted =
        options.quoted ??
        (options.quotedKeyId ? await quotedStub(session.id, options.quotedKeyId) : undefined);
    const messageId = newMessageId();
    if (message.kind === "media") expectOutgoingMedia(messageId, message.buffer);

    const settings = await getSettings(session.id);
    const sent = await throttle(session.id, settings, () =>
        sock.sendMessage(jid, toBaileysContent(message), {
            messageId,
            ...(quoted ? { quoted } : {}),
        })
    );
    return { key_id: sent?.key?.id || messageId, jid };
}
