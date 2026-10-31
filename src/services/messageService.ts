import createHttpError from "http-errors";
import connection from "../utils/dbUtil";
import { isGroupJid, toJid } from "../helpers/jid";
import { safeFetchBuffer } from "../helpers/safeFetch";
import type { MediaKind, WaSessionRow } from "../types";
import { requireSocket } from "../whatsapp/registry";
import { send, SendResult } from "../whatsapp/sender";

const MAX_URL_MEDIA_BYTES = 50 * 1024 * 1024;

export const sendText = (
    session: WaSessionRow,
    input: { to: string; text: string; reply_to?: string; mentions?: string[] }
) =>
    send(
        session,
        toJid(input.to),
        { kind: "text", text: input.text, mentions: (input.mentions || []).map(toJid) },
        { quotedKeyId: input.reply_to }
    );

/** Media from an upload (multer file) or from a URL (fetched with the SSRF checks). */
export async function sendMedia(
    session: WaSessionRow,
    input: {
        to: string;
        type: MediaKind;
        url?: string;
        caption?: string;
        file_name?: string;
        voice_note?: boolean | string;
        reply_to?: string;
    },
    upload?: { buffer: Buffer; mimetype: string; originalname: string }
): Promise<SendResult> {
    const jid = toJid(input.to);
    let file: { buffer: Buffer; mime: string; name: string };
    if (upload) {
        file = { buffer: upload.buffer, mime: upload.mimetype, name: upload.originalname };
    } else if (input.url) {
        const fetched = await safeFetchBuffer(input.url, { maxBytes: MAX_URL_MEDIA_BYTES }).catch(
            (err: any) => {
                throw new createHttpError.BadRequest(`Could not fetch the media: ${err?.message}`);
            }
        );
        file = { buffer: fetched.buffer, mime: fetched.contentType, name: fetched.fileName };
    } else {
        throw new createHttpError.BadRequest("Send the file in the 'file' field, or a 'url'");
    }
    if (file.buffer.length === 0) throw new createHttpError.BadRequest("The file is empty");
    return send(
        session,
        jid,
        {
            kind: "media",
            media: input.type,
            buffer: file.buffer,
            mime: file.mime,
            fileName: input.file_name || file.name,
            caption: input.caption || null,
            voiceNote: input.voice_note === true || input.voice_note === "true",
        },
        { quotedKeyId: input.reply_to }
    );
}

export const sendLocation = (
    session: WaSessionRow,
    input: { to: string; latitude: number; longitude: number; name?: string; address?: string }
) =>
    send(session, toJid(input.to), {
        kind: "location",
        latitude: input.latitude,
        longitude: input.longitude,
        name: input.name,
        address: input.address,
    });

export const sendContactCard = (
    session: WaSessionRow,
    input: { to: string; name: string; phone: string }
) => send(session, toJid(input.to), { kind: "contact", name: input.name, phone: input.phone });

async function storedMessage(session: WaSessionRow, keyId: string) {
    const row = await connection("wa_messages")
        .where({ session_id: session.id, key_id: keyId })
        .first("chat_jid", "from_me", "key_id", "sender_jid");
    if (!row) throw new createHttpError.NotFound("Message not found");
    return {
        remoteJid: row.chat_jid,
        fromMe: row.from_me,
        id: row.key_id,
        ...(isGroupJid(row.chat_jid) && !row.from_me ? { participant: row.sender_jid } : {}),
    };
}

/** React with an emoji; an empty emoji removes the reaction. */
export async function react(session: WaSessionRow, keyId: string, emoji: string) {
    const key = await storedMessage(session, keyId);
    await requireSocket(session.id).sendMessage(key.remoteJid, { react: { text: emoji, key } });
    return { key_id: keyId, emoji };
}

/** Deletes one of our own messages for everyone. */
export async function deleteForEveryone(session: WaSessionRow, keyId: string) {
    const key = await storedMessage(session, keyId);
    if (!key.fromMe)
        throw new createHttpError.BadRequest(
            "Only messages sent from this number can be deleted for everyone"
        );
    await requireSocket(session.id).sendMessage(key.remoteJid, { delete: key });
    return { key_id: keyId };
}

/** Marks a chat's incoming messages read (blue ticks) and clears its unread count. */
export async function markRead(session: WaSessionRow, chat: string) {
    const jid = toJid(chat);
    const unread = await connection("wa_messages")
        .where({ session_id: session.id, chat_jid: jid, from_me: false })
        .whereNot("status", "READ")
        .orderBy("message_at", "desc")
        .limit(100)
        .select("key_id", "sender_jid");
    if (unread.length) {
        await requireSocket(session.id).readMessages(
            unread.map((m: any) => ({
                remoteJid: jid,
                id: m.key_id,
                fromMe: false,
                ...(isGroupJid(jid) ? { participant: m.sender_jid } : {}),
            }))
        );
        await connection("wa_messages")
            .where({ session_id: session.id, chat_jid: jid, from_me: false })
            .whereNot("status", "READ")
            .update({ status: "READ" });
    }
    await connection("wa_chats").where({ session_id: session.id, jid }).update({ unread_count: 0 });
    return { jid, marked: unread.length };
}
