const uuid = { type: "string", format: "uuid", description: "Must be a valid id" };
const color = { type: "string", pattern: "^#[0-9A-Fa-f]{6}$", description: "color: #RRGGBB" };

export const listChatsSchema = {
    type: "object",
    properties: {
        search: { type: "string", maxLength: 100 },
        label_id: uuid,
        type: { type: "string", enum: ["group", "personal"] },
        unread: { type: "string", enum: ["true", "false"] },
        page_number: { type: "string", pattern: "^[0-9]+$" },
        per_page: { type: "string", pattern: "^[0-9]+$" },
    },
};

export const listMessagesSchema = {
    type: "object",
    properties: {
        before: { type: "string", format: "date-time", description: "before: an ISO date-time" },
        limit: { type: "string", pattern: "^[0-9]+$" },
    },
};

export const createLabelSchema = {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: { name: { type: "string", minLength: 1, maxLength: 100 }, color },
};

export const updateLabelSchema = {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: { name: { type: "string", minLength: 1, maxLength: 100 }, color },
};

export const chatLabelsSchema = {
    type: "object",
    required: ["label_ids", "action"],
    additionalProperties: false,
    properties: {
        label_ids: { type: "array", maxItems: 50, items: uuid },
        action: { type: "string", enum: ["add", "remove", "set"] },
    },
};
