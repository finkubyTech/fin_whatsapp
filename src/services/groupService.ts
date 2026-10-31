import createHttpError from "http-errors";
import connection from "../utils/dbUtil";
import { isGroupJid, toJid } from "../helpers/jid";
import type { WaSessionRow } from "../types";
import { requireSocket } from "../whatsapp/registry";
import { saveGroups } from "../whatsapp/ingest";

const GROUP_COLUMNS = [
    "jid",
    "subject",
    "description",
    "owner_jid",
    "participants",
    "announce",
    "restrict",
    "is_community",
    "created_on_whatsapp",
    "updated_at",
];

const groupJid = (value: string) => {
    const jid = value.includes("@") ? value : `${value}@g.us`;
    if (!isGroupJid(jid)) throw new createHttpError.BadRequest("Not a group address (…@g.us)");
    return jid;
};

export const listGroups = (session: WaSessionRow) =>
    connection("wa_groups")
        .where({ session_id: session.id })
        .select(
            GROUP_COLUMNS,
            connection.raw("jsonb_array_length(participants) AS participant_count")
        )
        .orderBy("subject");

/** The group as WhatsApp has it now (and the stored copy refreshed). */
export async function getGroup(session: WaSessionRow, value: string) {
    const jid = groupJid(value);
    const metadata = await requireSocket(session.id).groupMetadata(jid);
    await saveGroups(session.id, [metadata]);
    return connection("wa_groups").where({ session_id: session.id, jid }).first(GROUP_COLUMNS);
}

export async function createGroup(
    session: WaSessionRow,
    input: { subject: string; participants: string[] }
) {
    const metadata = await requireSocket(session.id).groupCreate(
        input.subject,
        input.participants.map(toJid)
    );
    await saveGroups(session.id, [metadata]);
    return getGroup(session, metadata.id);
}

export async function updateGroup(
    session: WaSessionRow,
    value: string,
    input: { subject?: string; description?: string; announce?: boolean; restrict?: boolean }
) {
    const jid = groupJid(value);
    const sock = requireSocket(session.id);
    if (input.subject !== undefined) await sock.groupUpdateSubject(jid, input.subject);
    if (input.description !== undefined)
        await sock.groupUpdateDescription(jid, input.description || undefined);
    if (input.announce !== undefined)
        await sock.groupSettingUpdate(jid, input.announce ? "announcement" : "not_announcement");
    if (input.restrict !== undefined)
        await sock.groupSettingUpdate(jid, input.restrict ? "locked" : "unlocked");
    return getGroup(session, jid);
}

export async function changeParticipants(
    session: WaSessionRow,
    value: string,
    input: { action: "add" | "remove" | "promote" | "demote"; participants: string[] }
) {
    const jid = groupJid(value);
    const results = await requireSocket(session.id).groupParticipantsUpdate(
        jid,
        input.participants.map(toJid),
        input.action
    );
    await getGroup(session, jid);
    return results.map((r: any) => ({ jid: r.jid, status: r.status }));
}

export async function inviteCode(session: WaSessionRow, value: string, revoke: boolean) {
    const jid = groupJid(value);
    const sock = requireSocket(session.id);
    const code = revoke ? await sock.groupRevokeInvite(jid) : await sock.groupInviteCode(jid);
    return { jid, code, link: code ? `https://chat.whatsapp.com/${code}` : null };
}

export async function joinGroup(session: WaSessionRow, code: string) {
    const clean = code.replace(/^https?:\/\/chat\.whatsapp\.com\//, "").trim();
    const jid = await requireSocket(session.id).groupAcceptInvite(clean);
    if (!jid) throw new createHttpError.BadRequest("Could not join with that invite");
    return getGroup(session, jid);
}

export async function leaveGroup(session: WaSessionRow, value: string) {
    const jid = groupJid(value);
    await requireSocket(session.id).groupLeave(jid);
    await connection("wa_groups").where({ session_id: session.id, jid }).del();
    return { jid };
}
