// dbUtils
export interface IPgConfig {
    user: string;
    database: string;
    password: string;
    host: string;
    port: number;
    keepAlive?: boolean;
    ssl?: any;
}

// connection pool
export interface IPgPoolConfig {
    min: number;
    max: number;
}

// config
export interface IConfig {
    serviceName: string;
    port: number;
    loggerLevel: string;
    env: string;
    db: IPgConfig;
    pool: IPgPoolConfig;
    corsOrigins: string[];
    /** Only the public key: this service verifies staff tokens, it never issues them. */
    publicKey: string;
    /** Lets other fin_ services call with x-internal-key (e.g. fin_notifications sending). */
    internalApiKey: string;
    encryption: {
        responseEncryptionKey: string;
        /** 32 bytes: encrypts the stored WhatsApp logins and webhook secrets. */
        dataKey: Buffer;
    };
    whatsapp: {
        /** Received media is written here (a volume in Docker). */
        mediaDir: string;
        /** Largest media upload accepted for sending. */
        maxUploadBytes: number;
        /** Ask WhatsApp for the full chat history when a number is linked (heavy). */
        syncFullHistory: boolean;
        /** Reconnect the numbers that were connected when the service last stopped. */
        autoStart: boolean;
        baileysLogLevel: string;
        /** Webhook hosts allowed although they are private/internal (e.g. fin_ services on the Docker network). */
        webhookAllowedHosts: string[];
    };
}

export type WaPermission = "whatsapp_read" | "whatsapp_send" | "whatsapp_admin";

/** A linked number as the API returns it. */
export interface WaSessionRow {
    id: string;
    session_key: string;
    name: string;
    status: SessionStatus;
    phone_jid: string | null;
    push_name: string | null;
    last_connected_at: Date | null;
    created_by: string | null;
    created_at: Date;
    updated_at: Date;
}

export type SessionStatus =
    "STOPPED" | "CONNECTING" | "SCAN_QR" | "CONNECTED" | "DISCONNECTED" | "LOGGED_OUT";

export interface WaSessionSettings {
    session_id: string;
    welcome_message: string | null;
    auto_reply_enabled: boolean;
    auto_reply_mode: "ALL" | "SPECIFIC" | "BLACKLIST";
    auto_reply_jids: string[];
    throttle_enabled: boolean;
    throttle_limit: number;
    throttle_window_seconds: number;
    throttle_delay_min_ms: number;
    throttle_delay_max_ms: number;
    auto_read: boolean;
    always_online: boolean;
}

export type MessageType =
    | "TEXT"
    | "IMAGE"
    | "VIDEO"
    | "AUDIO"
    | "DOCUMENT"
    | "STICKER"
    | "LOCATION"
    | "CONTACT"
    | "OTHER";
export type MessageStatus = "PENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "DELETED";
export type MediaKind = "image" | "video" | "audio" | "document";

export type WebhookEvent =
    | "message.received"
    | "message.sent"
    | "message.status"
    | "message.deleted"
    | "message.edited"
    | "connection.update"
    | "contact.update"
    | "group.update"
    | "group.participants"
    | "opt_out"
    | "test";
