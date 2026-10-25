import createHttpError from "http-errors";
import connection from "../utils/dbUtil";
import { requireUuid } from "../helpers/ids";
import type { WaSessionRow } from "../types";
import { invalidateAutoReplies } from "../whatsapp/automations";

const COLUMNS = [
    "id",
    "keyword",
    "match_type",
    "trigger_type",
    "response",
    "media_url",
    "media_type",
    "priority",
    "is_active",
    "created_at",
    "updated_at",
];

type Input = Partial<{
    keyword: string;
    match_type: "EXACT" | "CONTAINS" | "REGEX";
    trigger_type: "ALL" | "GROUP" | "PRIVATE";
    response: string | null;
    media_url: string | null;
    media_type: string | null;
    priority: number;
    is_active: boolean;
}>;

function validate(rule: Input) {
    if (rule.match_type === "REGEX") {
        try {
            new RegExp(rule.keyword || "", "i");
        } catch {
            throw new createHttpError.BadRequest("keyword is not a valid regular expression");
        }
    }
    if (!rule.response && !rule.media_url)
        throw new createHttpError.BadRequest("Give a response, a media_url, or both");
    if (rule.media_url && !rule.media_type)
        throw new createHttpError.BadRequest("media_type is required with media_url");
}

export const listAutoReplies = (session: WaSessionRow) =>
    connection("wa_auto_replies")
        .where({ session_id: session.id })
        .orderBy([{ column: "priority", order: "desc" }, { column: "created_at" }])
        .select(COLUMNS);

async function requireRule(session: WaSessionRow, id: string) {
    const rule = await connection("wa_auto_replies")
        .where({ id: requireUuid(id, "Auto-reply"), session_id: session.id })
        .first(COLUMNS);
    if (!rule) throw new createHttpError.NotFound("Auto-reply not found");
    return rule;
}

export async function createAutoReply(session: WaSessionRow, input: Input, staffId: string | null) {
    validate(input);
    const [rule] = await connection("wa_auto_replies")
        .insert({ ...input, session_id: session.id, created_by: staffId, updated_by: staffId })
        .returning(COLUMNS);
    invalidateAutoReplies(session.id);
    return rule;
}

export async function updateAutoReply(
    session: WaSessionRow,
    id: string,
    input: Input,
    staffId: string | null
) {
    const current = await requireRule(session, id);
    validate({ ...current, ...input });
    const [rule] = await connection("wa_auto_replies")
        .where({ id })
        .update({ ...input, updated_by: staffId, updated_at: new Date() })
        .returning(COLUMNS);
    invalidateAutoReplies(session.id);
    return rule;
}

export async function deleteAutoReply(session: WaSessionRow, id: string) {
    await requireRule(session, id);
    await connection("wa_auto_replies").where({ id }).del();
    invalidateAutoReplies(session.id);
}
