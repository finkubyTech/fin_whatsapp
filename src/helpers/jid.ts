import createHttpError from "http-errors";

/**
 * WhatsApp addresses (JIDs):
 *   919876543210@s.whatsapp.net  a person, by phone number
 *   123456789012345@lid          a person whose number WhatsApp hides
 *   120363…@g.us                 a group
 * Baileys adds a device suffix to its own id (91…:12@s.whatsapp.net).
 */
const PERSON = "@s.whatsapp.net";

export const isGroupJid = (jid?: string | null) => !!jid && jid.endsWith("@g.us");
export const isLidJid = (jid?: string | null) => !!jid && jid.endsWith("@lid");
export const isPersonJid = (jid?: string | null) =>
    !!jid && (jid.endsWith(PERSON) || isLidJid(jid));

/** Drops the device suffix and turns the old @c.us form into @s.whatsapp.net. */
export const bareJid = (jid?: string | null): string => {
    if (!jid) return "";
    const [user, domain] = jid.split("@");
    if (!domain) return jid;
    return `${user.split(":")[0]}@${domain === "c.us" ? "s.whatsapp.net" : domain}`;
};

export type ChatType = "PERSONAL" | "GROUP" | "STATUS" | "NEWSLETTER" | "UNKNOWN";
export const chatTypeOf = (jid?: string | null): ChatType => {
    if (!jid) return "UNKNOWN";
    if (jid === "status@broadcast") return "STATUS";
    if (isGroupJid(jid)) return "GROUP";
    if (jid.endsWith("@newsletter")) return "NEWSLETTER";
    return isPersonJid(jid) ? "PERSONAL" : "UNKNOWN";
};

/** Chats the gateway keeps: people and groups (not status updates, channels or broadcasts). */
export const isStoredChat = (jid?: string | null) =>
    chatTypeOf(jid) === "PERSONAL" || chatTypeOf(jid) === "GROUP";

/** "919876543210@s.whatsapp.net" -> "919876543210"; "" for groups and hidden numbers. */
export const phoneOf = (jid?: string | null) =>
    jid && jid.endsWith(PERSON) ? bareJid(jid).split("@")[0] : "";

/**
 * A recipient as an API caller gives it -> a JID. Accepts a JID as is, or a
 * phone number in any common form; a 10-digit Indian number gets 91.
 */
export function toJid(input: string): string {
    const value = String(input || "").trim();
    if (value.includes("@")) {
        const jid = bareJid(value);
        if (!isGroupJid(jid) && !isPersonJid(jid)) {
            throw new createHttpError.BadRequest(`Not a WhatsApp address: ${value}`);
        }
        return jid;
    }
    let digits = value.replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    if (digits.length === 10) digits = `91${digits}`;
    if (digits.length < 10 || digits.length > 15) {
        throw new createHttpError.BadRequest(`Not a valid phone number: ${value}`);
    }
    return `${digits}${PERSON}`;
}

/** Masks a JID's number for logs: 91XXXXXX3210. */
export const maskJid = (jid?: string | null) => {
    const user = bareJid(jid).split("@")[0];
    return user.length > 6
        ? `${user.slice(0, 2)}${"X".repeat(user.length - 6)}${user.slice(-4)}`
        : "XXXX";
};
