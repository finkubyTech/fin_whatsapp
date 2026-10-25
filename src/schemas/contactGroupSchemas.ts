const address = { type: "string", minLength: 3, maxLength: 100 };

export const listContactsSchema = {
    type: "object",
    properties: {
        search: { type: "string", maxLength: 100 },
        page_number: { type: "string", pattern: "^[0-9]+$" },
        per_page: { type: "string", pattern: "^[0-9]+$" },
    },
};

export const checkNumbersSchema = {
    type: "object",
    required: ["numbers"],
    additionalProperties: false,
    properties: { numbers: { type: "array", minItems: 1, maxItems: 100, items: address } },
};

export const createGroupSchema = {
    type: "object",
    required: ["subject", "participants"],
    additionalProperties: false,
    properties: {
        subject: { type: "string", minLength: 1, maxLength: 100 },
        participants: { type: "array", minItems: 1, maxItems: 256, items: address },
    },
};

export const updateGroupSchema = {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
        subject: { type: "string", minLength: 1, maxLength: 100 },
        description: { type: "string", maxLength: 2048 },
        announce: { type: "boolean", description: "announce: only admins can send messages" },
        restrict: { type: "boolean", description: "restrict: only admins can edit group info" },
    },
};

export const participantsSchema = {
    type: "object",
    required: ["action", "participants"],
    additionalProperties: false,
    properties: {
        action: { type: "string", enum: ["add", "remove", "promote", "demote"] },
        participants: { type: "array", minItems: 1, maxItems: 256, items: address },
    },
};

export const joinGroupSchema = {
    type: "object",
    required: ["code"],
    additionalProperties: false,
    properties: {
        code: {
            type: "string",
            minLength: 5,
            maxLength: 200,
            description: "code: the invite code or link",
        },
    },
};
