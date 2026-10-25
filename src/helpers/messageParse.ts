import type { MediaKind, MessageType } from "../types";

/**
 * One reading of a WhatsApp message, shared by the store, the webhooks and the
 * automations (WA-AKG parsed every message twice, in the store and again for
 * the webhook). Works on the plain message object, so it needs no Baileys.
 */

// Containers that carry the real message one level down (disappearing,
// view-once, captioned documents, …). Baileys' normalizeMessageContent unwraps the same.
const WRAPPERS = [
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "documentWithCaptionMessage",
    "botInvokeMessage",
    "groupMentionedMessage",
    "associatedChildMessage",
    "groupStatusMessage",
    "groupStatusMessageV2",
    "lottieStickerMessage",
];

export function unwrapMessage(message: any): any {
    let current = message;
    for (let depth = 0; depth < 6 && current; depth++) {
        const wrapper = WRAPPERS.find((key) => current[key]?.message);
        if (!wrapper) break;
        current = current[wrapper].message;
    }
    return current || null;
}

// Keys that never make a message worth storing on their own.
const TECHNICAL = new Set([
    "protocolMessage",
    "senderKeyDistributionMessage",
    "messageContextInfo",
    "reactionMessage",
    "keepInChatMessage",
    "pollUpdateMessage",
]);

const MEDIA_FIELDS: Record<string, { type: MessageType; kind: MediaKind | null }> = {
    imageMessage: { type: "IMAGE", kind: "image" },
    videoMessage: { type: "VIDEO", kind: "video" },
    audioMessage: { type: "AUDIO", kind: "audio" },
    documentMessage: { type: "DOCUMENT", kind: "document" },
    stickerMessage: { type: "STICKER", kind: null },
};

export interface ParsedContent {
    type: MessageType;
    /** Text, or the caption of a photo / video / document. */
    text: string;
    fileName: string | null;
    mime: string | null;
    /** The message field holding downloadable media (imageMessage, …), if any. */
    mediaField: string | null;
    quotedKeyId: string | null;
    quoted: {
        keyId: string | null;
        participant: string | null;
        type: MessageType;
        text: string;
    } | null;
    mentions: string[];
}

export type Classified =
    | { kind: "content"; content: ParsedContent }
    | { kind: "revoke"; targetKeyId: string }
    | { kind: "edit"; targetKeyId: string; text: string }
    | { kind: "ignore" };

function readContent(message: any): ParsedContent {
    const m = unwrapMessage(message) || {};
    const base: ParsedContent = {
        type: "OTHER",
        text: "",
        fileName: null,
        mime: null,
        mediaField: null,
        quotedKeyId: null,
        quoted: null,
        mentions: [],
    };

    let inner: any = null;
    if (typeof m.conversation === "string") {
        base.type = "TEXT";
        base.text = m.conversation;
    } else if (m.extendedTextMessage) {
        inner = m.extendedTextMessage;
        base.type = "TEXT";
        base.text = inner.text || "";
    } else {
        const field = Object.keys(MEDIA_FIELDS).find((key) => m[key]);
        if (field) {
            inner = m[field];
            base.type = MEDIA_FIELDS[field].type;
            base.mediaField = field;
            base.text = inner.caption || "";
            base.mime = inner.mimetype || null;
            base.fileName = field === "documentMessage" ? inner.fileName || null : null;
        } else if (m.locationMessage) {
            inner = m.locationMessage;
            base.type = "LOCATION";
            base.text = `${inner.degreesLatitude},${inner.degreesLongitude}`;
        } else if (m.contactMessage) {
            inner = m.contactMessage;
            base.type = "CONTACT";
            base.text = inner.displayName || "";
        }
    }

    const context = inner?.contextInfo;
    if (context?.stanzaId) {
        base.quotedKeyId = context.stanzaId;
        if (context.quotedMessage) {
            const quoted = readContent(context.quotedMessage);
            base.quoted = {
                keyId: context.stanzaId,
                participant: context.participant || null,
                type: quoted.type,
                text: quoted.text,
            };
        }
    }
    if (Array.isArray(context?.mentionedJid)) base.mentions = context.mentionedJid;
    return base;
}

export function classifyMessage(message: any): Classified {
    if (!message) return { kind: "ignore" };
    const m = unwrapMessage(message) || {};

    const protocol = m.protocolMessage;
    const targetKeyId = protocol?.key?.id;
    if (protocol && targetKeyId) {
        // 0 = REVOKE (deleted for everyone), 14 = MESSAGE_EDIT
        if (protocol.type === 0) return { kind: "revoke", targetKeyId };
        if (protocol.type === 14 && protocol.editedMessage) {
            return { kind: "edit", targetKeyId, text: readContent(protocol.editedMessage).text };
        }
        return { kind: "ignore" };
    }

    const keys = Object.keys(m);
    if (keys.length === 0 || keys.every((key) => TECHNICAL.has(key))) return { kind: "ignore" };
    return { kind: "content", content: readContent(m) };
}

/** Short text for chat lists: the text, else a label for the kind of message. */
export function previewOf(content: ParsedContent): string {
    const label: Record<MessageType, string> = {
        TEXT: "",
        IMAGE: "📷 Photo",
        VIDEO: "🎥 Video",
        AUDIO: "🎤 Audio",
        DOCUMENT: "📄 Document",
        STICKER: "Sticker",
        LOCATION: "📍 Location",
        CONTACT: "👤 Contact",
        OTHER: "Message",
    };
    const text = content.text || (content.type === "DOCUMENT" ? content.fileName || "" : "");
    const preview = text || label[content.type];
    return preview.length > 250 ? `${preview.slice(0, 247)}...` : preview;
}

/** Baileys timestamps: seconds as a number, a numeric string or a Long { low, high }. */
export function timestampOf(value: unknown): Date {
    let seconds = 0;
    if (typeof value === "number" || typeof value === "string") seconds = Number(value);
    else if (value && typeof value === "object" && "low" in value) {
        const { low, high } = value as { low: number; high?: number };
        seconds = (high || 0) * 2 ** 32 + (low >>> 0);
    } else if (value && typeof (value as any).toNumber === "function")
        seconds = (value as any).toNumber();
    return seconds > 0 ? new Date(seconds * 1000) : new Date();
}
