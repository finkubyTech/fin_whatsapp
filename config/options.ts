import path from "path";
import dotenv from "dotenv";
//DO NOT COMMIT YOUR .env FILE
dotenv.config({ path: ".env", quiet: true });
import { IConfig } from "../src/types/index";

/**
 * Keys the service cannot run without. Checked once at boot so a missing value
 * fails loudly instead of surfacing later as an empty string.
 */
export const REQUIRED_ENV = ["PUBLIC_KEY", "RESPONSE_ENCRYPTION_KEY", "WHATSAPP_ENCRYPTION_KEY"];

const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}

const env = (key: string, fallback = ""): string => process.env[key] ?? fallback;
const positive = (key: string, fallback: number) => {
    const value = Number(process.env[key]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
};
const list = (key: string, fallback = "") =>
    env(key, fallback)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

// AES-256-GCM needs exactly 32 bytes; the web apps use the same key.
if (Buffer.byteLength(env("RESPONSE_ENCRYPTION_KEY"), "utf8") !== 32) {
    throw new Error("RESPONSE_ENCRYPTION_KEY must be exactly 32 bytes");
}

// Encrypts every stored WhatsApp login: losing or changing it means linking
// every number again, so it is never derived from another secret.
const dataKeyHex = env("WHATSAPP_ENCRYPTION_KEY");
if (!/^[0-9a-fA-F]{64}$/.test(dataKeyHex)) {
    throw new Error("WHATSAPP_ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)");
}

export const config: IConfig = {
    serviceName: env("SERVICENAME", "fin_whatsapp"),
    port: Number(process.env.PORT) || 5109,
    loggerLevel: env("LOGGER_LEVEL", "debug"),
    // LOCAL: no DB SSL · STAGING: SSL, self-signed accepted · anything else: strict SSL.
    env: env("ENVIRONMENT", env("NODE_ENV", "LOCAL")).toUpperCase(),
    db: {
        user: env("DB_USER", "postgres"),
        database: env("DB_SCHEMA", "loan_management"),
        password: env("DB_PASSWORD", "postgres"),
        host: env("DB_HOST", "localhost"),
        port: Number(process.env.DB_PORT) || 5432,
        keepAlive: true,
    },
    pool: {
        min: Number(process.env.DB_MIN_CLIENTS) || 2,
        max: Number(process.env.DB_MAX_CLIENTS) || 10,
    },
    corsOrigins: list("CORS_ORIGINS", "http://localhost:3001"),
    // PEM keys are stored on one line in .env files with literal "\n" escapes.
    publicKey: env("PUBLIC_KEY").replace(/\\n/g, "\n"),
    internalApiKey: env("INTERNAL_API_KEY"),
    encryption: {
        responseEncryptionKey: env("RESPONSE_ENCRYPTION_KEY"),
        dataKey: Buffer.from(dataKeyHex, "hex"),
    },
    whatsapp: {
        mediaDir: path.resolve(env("WHATSAPP_MEDIA_DIR", "data/media")),
        maxUploadBytes: positive("WHATSAPP_MAX_UPLOAD_MB", 16) * 1024 * 1024,
        syncFullHistory: env("WHATSAPP_SYNC_FULL_HISTORY", "false") === "true",
        autoStart: env("WHATSAPP_AUTOSTART", "true") === "true",
        baileysLogLevel: env("BAILEYS_LOG_LEVEL", "error"),
        webhookAllowedHosts: list("WHATSAPP_WEBHOOK_ALLOWED_HOSTS").map((h) => h.toLowerCase()),
    },
};
