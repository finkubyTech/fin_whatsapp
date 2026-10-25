import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../../config/options";
import { logger } from "../utils/logger";
import { sendErrorResponse } from "../utils/apiResponse";

/**
 * Payload encryption shared with the fin_ web apps (same scheme as the
 * reference platform): AES-256-GCM, 12-byte IV, wire format
 * "<ivHex>:<cipherHex>:<authTagHex>". Requests carry { data: "<cipher>" } in
 * the body (or ?data=<cipher> in the query); responses encrypt only `data`.
 * A client opts out per request with the header `x-api-encrypt: false`.
 */
const algorithm = "aes-256-gcm";
const key = Buffer.from(config.encryption.responseEncryptionKey, "utf8");

const CIPHER_FORMAT = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i;

const wantsEncryption = (req: Request) =>
    req.headers["x-api-encrypt"]?.toString().toLowerCase() !== "false";

export async function encryptAsync(value: any): Promise<string> {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return `${iv.toString("hex")}:${encrypted.toString("hex")}:${cipher.getAuthTag().toString("hex")}`;
}

export async function decryptAsync(text: string): Promise<any> {
    if (typeof text !== "string" || !CIPHER_FORMAT.test(text)) {
        throw Object.assign(new Error("Invalid encryption data format"), { status: 400 });
    }
    const [ivHex, cipherHex, tagHex] = text.split(":");
    try {
        const decipher = crypto.createDecipheriv(algorithm, key, Buffer.from(ivHex, "hex"));
        decipher.setAuthTag(Buffer.from(tagHex, "hex"));
        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(cipherHex, "hex")),
            decipher.final(),
        ]).toString("utf8");
        try {
            return JSON.parse(decrypted);
        } catch {
            return decrypted;
        }
    } catch {
        // Wrong key or tampered payload: the auth tag check fails.
        throw Object.assign(new Error("Unable to decrypt request data"), { status: 400 });
    }
}

/**
 * Decrypts body.data / query.data in place. Mounted once, before routing.
 * Skipped with `x-api-encrypt: false` or when nothing is encrypted.
 */
export const decryptionMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!wantsEncryption(req)) {
            return next();
        }
        if (typeof req.body?.data === "string") {
            req.body = await decryptAsync(req.body.data);
        }
        if (typeof req.query?.data === "string") {
            const decryptedQuery = await decryptAsync(req.query.data as string);
            Object.defineProperty(req, "query", {
                value: decryptedQuery,
                writable: false,
                enumerable: true,
                configurable: true,
            });
        }
        next();
    } catch (err: any) {
        logger.info(`[decryptionMiddleware] ${err?.message}`);
        return sendErrorResponse(res, err);
    }
};

/**
 * Sends res.locals.apiResponse, encrypting `data` unless the request opted out.
 * Mounted after every router (the reference's response stage). Errors are
 * sent as they are, without encryption.
 */
export const encryptionMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    const { apiResponse } = res.locals;
    if (!apiResponse) {
        return next();
    }
    try {
        if (apiResponse.error || !wantsEncryption(req)) {
            return res.status(apiResponse.status).json(apiResponse);
        }
        return res
            .status(apiResponse.status)
            .json({ ...apiResponse, data: await encryptAsync(apiResponse.data) });
    } catch (err: any) {
        logger.error(`[encryptionMiddleware] ${err?.message}`);
        return sendErrorResponse(res, err);
    }
};
