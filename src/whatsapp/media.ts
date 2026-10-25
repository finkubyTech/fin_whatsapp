import fs from "fs/promises";
import path from "path";
import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { config } from "../../config/options";
import { logger } from "../utils/logger";
import { downloadMediaMessage } from "./baileys";
import { baileysLogger } from "./baileysLogger";

/**
 * Media files under WHATSAPP_MEDIA_DIR, named <session_key>-<message key id>.<ext>
 * (only [A-Za-z0-9_-] from either part). Served at /api/whatsapp/media/<name>.
 */
export const MEDIA_NAME = /^[A-Za-z0-9_-]+\.[a-z0-9]{1,10}$/;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

const EXT_BY_TYPE: Record<string, string> = {
    imageMessage: "jpg",
    videoMessage: "mp4",
    audioMessage: "ogg",
    documentMessage: "bin",
    stickerMessage: "webp",
};

const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "");

export function mediaFileName(
    sessionKey: string,
    keyId: string,
    mime: string | null,
    field: string
): string | null {
    const session = safe(sessionKey);
    const key = safe(keyId);
    if (!session || !key) return null;
    const fromMime =
        mime
            ?.split("/")[1]
            ?.split(";")[0]
            ?.toLowerCase()
            .replace(/[^a-z0-9]/g, "") || "";
    const ext = fromMime && fromMime.length <= 10 ? fromMime : EXT_BY_TYPE[field] || "bin";
    return `${session}-${key}.${ext}`;
}

/** Absolute path of a stored file, or null when the name isn't one this service wrote. */
export function mediaPath(name: string): string | null {
    if (!MEDIA_NAME.test(name)) return null;
    const full = path.resolve(config.whatsapp.mediaDir, name);
    return path.dirname(full) === config.whatsapp.mediaDir ? full : null;
}

export const mediaUrl = (name: string | null) => (name ? `/api/whatsapp/media/${name}` : null);

async function write(name: string, buffer: Buffer) {
    await fs.mkdir(config.whatsapp.mediaDir, { recursive: true });
    await fs.writeFile(path.join(config.whatsapp.mediaDir, name), buffer);
}

// Files this service just sent: written from the buffer it already has, so the
// stored copy of an outgoing message never has to be downloaded back from WhatsApp.
const outgoing = new Map<string, Buffer>();
export const expectOutgoingMedia = (keyId: string, buffer: Buffer) => {
    outgoing.set(keyId, buffer);
    setTimeout(() => outgoing.delete(keyId), 60_000).unref();
};

/** Downloads (or takes the just-sent buffer of) a message's media and stores it. Returns the file name. */
export async function storeMessageMedia(
    sock: WASocket,
    message: WAMessage,
    sessionKey: string,
    field: string,
    mime: string | null
): Promise<string | null> {
    const keyId = message.key.id || "";
    const name = mediaFileName(sessionKey, keyId, mime, field);
    if (!name) return null;
    try {
        let buffer = outgoing.get(keyId) ?? null;
        outgoing.delete(keyId);
        if (!buffer) {
            const declared = Number((message.message as any)?.[field]?.fileLength ?? 0);
            if (declared > MAX_DOWNLOAD_BYTES) {
                logger.warn(
                    `[media] ${keyId}: ${declared} bytes, larger than the download limit; not stored`
                );
                return null;
            }
            buffer = (await downloadMediaMessage(
                message,
                "buffer",
                {},
                {
                    reuploadRequest: sock.updateMediaMessage,
                    logger: baileysLogger as any,
                }
            )) as Buffer;
        }
        await write(name, buffer);
        return name;
    } catch (err: any) {
        logger.error(`[media] could not store media of ${keyId}: ${err?.message}`);
        return null;
    }
}

/** Removes stored files (data retention). Missing files are fine. */
export async function deleteMediaFiles(names: string[]) {
    let removed = 0;
    for (const name of names) {
        const full = mediaPath(name);
        if (!full) continue;
        try {
            await fs.unlink(full);
            removed++;
        } catch {
            /* already gone */
        }
    }
    return removed;
}
