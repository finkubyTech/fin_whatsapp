// `to`: a phone number (10 digits get 91) or a WhatsApp address (…@s.whatsapp.net, …@g.us).
const to = {
    type: "string",
    minLength: 3,
    maxLength: 100,
    description: "to: a phone number or WhatsApp address",
};
const replyTo = { type: "string", minLength: 1, maxLength: 128 };

export const sendTextSchema = {
    type: "object",
    required: ["to", "text"],
    additionalProperties: false,
    properties: {
        to,
        text: { type: "string", minLength: 1, maxLength: 65536, description: "text is required" },
        reply_to: replyTo,
        mentions: {
            type: "array",
            maxItems: 256,
            items: { type: "string", minLength: 3, maxLength: 100 },
        },
    },
};

// multipart (file) or JSON (url): fields arrive as strings from multipart.
export const sendMediaSchema = {
    type: "object",
    required: ["to", "type"],
    additionalProperties: false,
    properties: {
        to,
        type: { type: "string", enum: ["image", "video", "audio", "document"] },
        url: { type: "string", format: "uri", maxLength: 2048 },
        caption: { type: "string", maxLength: 4096 },
        file_name: { type: "string", maxLength: 255 },
        voice_note: { type: ["boolean", "string"] },
        reply_to: replyTo,
    },
};

export const sendLocationSchema = {
    type: "object",
    required: ["to", "latitude", "longitude"],
    additionalProperties: false,
    properties: {
        to,
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 },
        name: { type: "string", maxLength: 255 },
        address: { type: "string", maxLength: 500 },
    },
};

export const sendContactSchema = {
    type: "object",
    required: ["to", "name", "phone"],
    additionalProperties: false,
    properties: {
        to,
        name: { type: "string", minLength: 1, maxLength: 255 },
        phone: {
            type: "string",
            pattern: "^\\+?[0-9 ]{8,20}$",
            description: "phone: digits with country code",
        },
    },
};

export const reactSchema = {
    type: "object",
    required: ["emoji"],
    additionalProperties: false,
    properties: {
        emoji: {
            type: "string",
            maxLength: 16,
            description: "emoji: one emoji, or empty to remove",
        },
    },
};
