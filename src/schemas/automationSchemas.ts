const address = {
    type: "string",
    minLength: 3,
    maxLength: 100,
    description: "a phone number or WhatsApp address",
};
const mediaUrl = { type: ["string", "null"], format: "uri", maxLength: 2048 };
const mediaType = { type: ["string", "null"], enum: ["image", "video", "audio", "document", null] };
const pageFields = {
    page_number: { type: "string", pattern: "^[0-9]+$" },
    per_page: { type: "string", pattern: "^[0-9]+$" },
};

const autoReplyFields = {
    keyword: { type: "string", minLength: 1, maxLength: 500 },
    match_type: { type: "string", enum: ["EXACT", "CONTAINS", "REGEX"] },
    trigger_type: { type: "string", enum: ["ALL", "GROUP", "PRIVATE"] },
    response: { type: ["string", "null"], maxLength: 4096 },
    media_url: mediaUrl,
    media_type: mediaType,
    priority: { type: "integer", minimum: -1000, maximum: 1000 },
    is_active: { type: "boolean" },
};
export const createAutoReplySchema = {
    type: "object",
    required: ["keyword", "match_type"],
    additionalProperties: false,
    properties: autoReplyFields,
};
export const updateAutoReplySchema = {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: autoReplyFields,
};

export const listOptOutsSchema = {
    type: "object",
    properties: {
        ...pageFields,
        search: { type: "string", maxLength: 20 },
        include_removed: { type: "string", enum: ["true", "false"] },
    },
};
export const addOptOutSchema = {
    type: "object",
    required: ["to"],
    additionalProperties: false,
    properties: { to: address, reason: { type: "string", maxLength: 500 } },
};
export const removeOptOutSchema = {
    type: "object",
    required: ["reason"],
    additionalProperties: false,
    properties: {
        reason: {
            type: "string",
            minLength: 3,
            maxLength: 500,
            description: "reason: why this number may be messaged again",
        },
    },
};

const scheduleFields = {
    to: address,
    content: { type: ["string", "null"], maxLength: 65536 },
    media_url: mediaUrl,
    media_type: mediaType,
    send_at: { type: "string", format: "date-time" },
    cron_expression: {
        type: ["string", "null"],
        maxLength: 100,
        description: "cron_expression: 5 fields, IST",
    },
};
export const createScheduleSchema = {
    type: "object",
    required: ["to"],
    additionalProperties: false,
    properties: scheduleFields,
};
export const updateScheduleSchema = {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: scheduleFields,
};
export const listSchedulesSchema = {
    type: "object",
    properties: {
        ...pageFields,
        status: { type: "string", enum: ["PENDING", "SENDING", "SENT", "FAILED", "CANCELLED"] },
    },
};

export const createBroadcastSchema = {
    type: "object",
    required: ["recipients"],
    additionalProperties: false,
    properties: {
        recipients: { type: "array", minItems: 1, maxItems: 1000, items: address },
        message: { type: "string", minLength: 1, maxLength: 65536 },
        media_url: { type: "string", format: "uri", maxLength: 2048 },
        media_type: { type: "string", enum: ["image", "video", "audio", "document"] },
        delay_min_ms: { type: "integer", minimum: 5000, maximum: 600000 },
        delay_max_ms: { type: "integer", minimum: 5000, maximum: 600000 },
    },
};
export const broadcastQuerySchema = {
    type: "object",
    properties: {
        ...pageFields,
        status: { type: "string", enum: ["PENDING", "SENT", "FAILED", "SKIPPED"] },
    },
};

const EVENTS = [
    "*",
    "message.received",
    "message.sent",
    "message.status",
    "message.deleted",
    "message.edited",
    "connection.update",
    "contact.update",
    "group.update",
    "group.participants",
    "opt_out",
];
const webhookFields = {
    name: { type: "string", minLength: 1, maxLength: 150 },
    url: { type: "string", format: "uri", maxLength: 2048 },
    secret: {
        type: ["string", "null"],
        minLength: 16,
        maxLength: 256,
        description: "secret: at least 16 characters",
    },
    events: {
        type: "array",
        maxItems: EVENTS.length,
        uniqueItems: true,
        items: { type: "string", enum: EVENTS },
    },
    is_active: { type: "boolean" },
};
export const createWebhookSchema = {
    type: "object",
    required: ["name", "url"],
    additionalProperties: false,
    properties: webhookFields,
};
export const updateWebhookSchema = {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: webhookFields,
};
export const webhookLogsSchema = {
    type: "object",
    properties: { ...pageFields, status: { type: "string", enum: ["SUCCESS", "FAILED"] } },
};
