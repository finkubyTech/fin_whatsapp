import createHttpError from "http-errors";
import connection from "../utils/dbUtil";
import { toJid } from "../helpers/jid";
import { requireUuid } from "../helpers/ids";
import type { WaSessionRow } from "../types";

/** Labels are this service's own tags on chats (one set per number). */
const LABEL_COLUMNS = ["id", "name", "color", "created_at", "updated_at"];

export async function listLabels(session: WaSessionRow) {
    return connection("wa_labels as l")
        .where("l.session_id", session.id)
        .select(
            LABEL_COLUMNS.map((c) => `l.${c}`),
            connection("wa_chat_labels as cl")
                .whereRaw("cl.label_id = l.id")
                .count("*")
                .as("chat_count")
        )
        .orderBy("l.name");
}

async function requireLabel(session: WaSessionRow, id: string) {
    const label = await connection("wa_labels")
        .where({ id: requireUuid(id, "Label"), session_id: session.id })
        .first(LABEL_COLUMNS);
    if (!label) throw new createHttpError.NotFound("Label not found");
    return label;
}

export async function createLabel(session: WaSessionRow, input: { name: string; color?: string }) {
    const [label] = await connection("wa_labels")
        .insert({
            session_id: session.id,
            name: input.name.trim(),
            ...(input.color ? { color: input.color } : {}),
        })
        .onConflict(["session_id", "name"])
        .ignore()
        .returning(LABEL_COLUMNS);
    if (!label)
        throw new createHttpError.Conflict(`A label called "${input.name.trim()}" already exists`);
    return label;
}

export async function updateLabel(
    session: WaSessionRow,
    id: string,
    input: { name?: string; color?: string }
) {
    await requireLabel(session, id);
    try {
        const [label] = await connection("wa_labels")
            .where({ id })
            .update({
                ...(input.name ? { name: input.name.trim() } : {}),
                ...(input.color ? { color: input.color } : {}),
                updated_at: new Date(),
            })
            .returning(LABEL_COLUMNS);
        return label;
    } catch (err: any) {
        if (err?.code === "23505")
            throw new createHttpError.Conflict("Another label already has that name");
        throw err;
    }
}

export async function deleteLabel(session: WaSessionRow, id: string) {
    await requireLabel(session, id);
    await connection("wa_labels").where({ id }).del();
}

export async function chatLabels(session: WaSessionRow, chat: string) {
    return connection("wa_chat_labels as cl")
        .join("wa_labels as l", "l.id", "cl.label_id")
        .where({ "l.session_id": session.id, "cl.chat_jid": toJid(chat) })
        .select("l.id", "l.name", "l.color")
        .orderBy("l.name");
}

/** add / remove the given labels on a chat, or set them to exactly that list. */
export async function changeChatLabels(
    session: WaSessionRow,
    chat: string,
    input: { label_ids: string[]; action: "add" | "remove" | "set" }
) {
    const jid = toJid(chat);
    const ids = [...new Set(input.label_ids)];
    if (ids.length) {
        const found = await connection("wa_labels")
            .where({ session_id: session.id })
            .whereIn("id", ids)
            .pluck("id");
        if (found.length !== ids.length)
            throw new createHttpError.BadRequest("Unknown label for this number");
    }
    await connection.transaction(async (trx) => {
        const ofSession = trx("wa_labels").where({ session_id: session.id }).select("id");
        if (input.action === "set")
            await trx("wa_chat_labels")
                .where({ chat_jid: jid })
                .whereIn("label_id", ofSession)
                .del();
        if (input.action === "remove") {
            if (ids.length)
                await trx("wa_chat_labels").where({ chat_jid: jid }).whereIn("label_id", ids).del();
        } else if (ids.length) {
            await trx("wa_chat_labels")
                .insert(ids.map((label_id) => ({ label_id, chat_jid: jid })))
                .onConflict(["label_id", "chat_jid"])
                .ignore();
        }
    });
    return chatLabels(session, jid);
}
