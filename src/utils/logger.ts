import { config } from "../../config/options";
import { createLogger, format, transports } from "winston";
import type { Request, NextFunction, Response } from "express";

const { combine, timestamp, printf } = format;

const loggerFormat = printf((info) => {
    const correlation = info.correlationId ? ` [${info.correlationId}]` : "";
    return `${info.timestamp} | ${info.level}${correlation}: ${info.message}`;
});

export const logger = createLogger({
    level: config.loggerLevel,
    format: combine(format.colorize(), timestamp(), loggerFormat),
    transports: [new transports.Console()],
});

// Keys whose values must never reach the logs. Matched case-insensitively
// against object keys at any depth.
const SECRET_KEYS =
    /^(password|currentpassword|newpassword|password_hash|token|access_token|refresh_token|authorization|otp|otp_code|pan|pan_number|aadhaar|data_encryption_key|secret)$/i;
const MOBILE_KEYS = /^(mobile|mobile_number|phone|corporate_channel_person_mobile)$/i;

const maskMobile = (value: string) =>
    value.length >= 4 ? `${"X".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}` : "XXXX";

/** Returns a deep copy with secrets replaced by "***" and mobile numbers masked. */
export const maskSensitiveData = (input: any, depth = 0): any => {
    if (input === null || input === undefined || depth > 6) return input;
    if (Array.isArray(input)) return input.map((item) => maskSensitiveData(item, depth + 1));
    if (typeof input !== "object") return input;
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(input)) {
        if (SECRET_KEYS.test(key)) {
            out[key] = "***";
        } else if (MOBILE_KEYS.test(key) && typeof value === "string") {
            out[key] = maskMobile(value);
        } else {
            out[key] = maskSensitiveData(value, depth + 1);
        }
    }
    return out;
};

/** Logs query, params and body of every request at debug level, masked. */
export const requestInfo = (req: Request, res: Response, next: NextFunction) => {
    if (logger.isDebugEnabled()) {
        logger.debug(
            `${req.method} ${req.originalUrl} | query=${JSON.stringify(
                maskSensitiveData(req.query)
            )} | body=${JSON.stringify(maskSensitiveData(req.body))}`
        );
    }
    next();
};
