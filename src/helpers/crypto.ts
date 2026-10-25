import crypto from "crypto";
import { config } from "../../config/options";

/**
 * At-rest encryption for the stored WhatsApp logins (wa_auth_states) and
 * webhook secrets: AES-256-GCM with WHATSAPP_ENCRYPTION_KEY, a fresh 12-byte IV
 * per value. Stored as "v1:<iv>:<tag>:<ciphertext>" (base64 parts).
 */
const PREFIX = "v1:";

export function encryptText(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", config.encryption.dataKey, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return `${PREFIX}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${body.toString("base64")}`;
}

/** Throws when the value was encrypted with another key or was tampered with. */
export function decryptText(stored: string): string {
    if (!stored.startsWith(PREFIX)) {
        throw new Error("Not an encrypted value");
    }
    const [iv, tag, body] = stored.slice(PREFIX.length).split(":");
    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        config.encryption.dataKey,
        Buffer.from(iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString(
        "utf8"
    );
}
