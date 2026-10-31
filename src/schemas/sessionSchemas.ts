export const createSessionSchema = {
    type: "object",
    required: ["session_key", "name"],
    additionalProperties: false,
    properties: {
        session_key: {
            type: "string",
            pattern: "^[a-z0-9][a-z0-9_-]{1,63}$",
            description: "session_key: 2-64 lowercase letters, digits, - or _ (e.g. finkuby-leads)",
        },
        name: { type: "string", minLength: 1, maxLength: 150, description: "name is required" },
    },
};

export const renameSessionSchema = {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: {
        name: { type: "string", minLength: 1, maxLength: 150, description: "name is required" },
    },
};

export const pairingCodeSchema = {
    type: "object",
    required: ["phone"],
    additionalProperties: false,
    properties: {
        phone: {
            type: "string",
            pattern: "^\\+?[0-9 ]{10,20}$",
            description: "phone: the number to link, with country code",
        },
    },
};

export const sessionSettingsSchema = {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
        welcome_message: { type: ["string", "null"], maxLength: 4096 },
        auto_reply_enabled: { type: "boolean" },
        auto_reply_mode: { type: "string", enum: ["ALL", "SPECIFIC", "BLACKLIST"] },
        auto_reply_jids: {
            type: "array",
            maxItems: 1000,
            items: { type: "string", minLength: 3, maxLength: 100 },
        },
        throttle_enabled: { type: "boolean" },
        throttle_limit: { type: "integer", minimum: 1, maximum: 100 },
        throttle_window_seconds: { type: "integer", minimum: 1, maximum: 3600 },
        throttle_delay_min_ms: { type: "integer", minimum: 0, maximum: 600000 },
        throttle_delay_max_ms: { type: "integer", minimum: 0, maximum: 600000 },
        auto_read: { type: "boolean" },
        always_online: { type: "boolean" },
    },
};
