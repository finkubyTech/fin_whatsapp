import createHttpError from "http-errors";
import connection from "../utils/dbUtil";
import { requireUuid } from "../helpers/ids";
import { toJid } from "../helpers/jid";
import { pageOf, paged } from "../helpers/pagination";
import type { WaSessionRow } from "../types";
import { nextRun } from "../jobs/scheduler";

const COLUMNS = [
    "id",
    "jid",
    "content",
    "media_url",
    "media_type",
    "send_at",
    "cron_expression",
    "status",
    "last_sent_at",
    "last_error",
    "created_by",
    "created_at",
    "updated_at",
];

type Input = {
    to: string;
    content?: string | null;
    media_url?: string | null;
    media_type?: string | null;
    send_at?: string;
    cron_expression?: string | null;
};

/** One-time (send_at) or recurring (cron_expression, IST; send_at defaults to its next run). */
function plan(input: Partial<Input>, current?: any) {
    const cron =
        input.cron_expression !== undefined ? input.cron_expression : current?.cron_expression;
    let sendAt = input.send_at ? new Date(input.send_at) : current?.send_at;
    if (cron) {
        try {
            if (!input.send_at) sendAt = nextRun(cron);
            else nextRun(cron);
        } catch {
            throw new createHttpError.BadRequest("cron_expression is not a valid cron expression");
        }
    }
    if (!sendAt)
        throw new createHttpError.BadRequest(
            "Give send_at, or a cron_expression for a recurring message"
        );
    const content = input.content !== undefined ? input.content : current?.content;
    const mediaUrl = input.media_url !== undefined ? input.media_url : current?.media_url;
    if (!content && !mediaUrl)
        throw new createHttpError.BadRequest("Give content, a media_url, or both");
    if (mediaUrl && !(input.media_type ?? current?.media_type))
        throw new createHttpError.BadRequest("media_type is required with media_url");
    return { cron_expression: cron || null, send_at: sendAt };
}

export async function listSchedules(session: WaSessionRow, query: Record<string, any>) {
    const page = pageOf(query, 50, 200);
    const base = connection("wa_scheduled_messages")
        .where({ session_id: session.id })
        .modify((q) => {
            if (query.status) q.where({ status: String(query.status) });
        });
    const [{ count }] = await base.clone().count({ count: "*" });
    const rows = await base
        .clone()
        .select(COLUMNS)
        .orderBy("send_at")
        .limit(page.perPage)
        .offset(page.offset);
    return paged(rows, Number(count), page, "Scheduled messages fetched");
}

async function requireSchedule(session: WaSessionRow, id: string) {
    const row = await connection("wa_scheduled_messages")
        .where({ id: requireUuid(id, "Scheduled message"), session_id: session.id })
        .first(COLUMNS);
    if (!row) throw new createHttpError.NotFound("Scheduled message not found");
    return row;
}

export async function createSchedule(session: WaSessionRow, input: Input, staffId: string | null) {
    const timing = plan(input);
    const [row] = await connection("wa_scheduled_messages")
        .insert({
            session_id: session.id,
            jid: toJid(input.to),
            content: input.content || null,
            media_url: input.media_url || null,
            media_type: input.media_type || null,
            ...timing,
            created_by: staffId,
        })
        .returning(COLUMNS);
    return row;
}

export async function updateSchedule(session: WaSessionRow, id: string, input: Partial<Input>) {
    const current = await requireSchedule(session, id);
    if (!["PENDING", "FAILED"].includes(current.status)) {
        throw new createHttpError.Conflict(
            `A ${current.status.toLowerCase()} message can't be changed`
        );
    }
    const timing = plan(input, current);
    const [row] = await connection("wa_scheduled_messages")
        .where({ id })
        .update({
            ...(input.to ? { jid: toJid(input.to) } : {}),
            ...(input.content !== undefined ? { content: input.content || null } : {}),
            ...(input.media_url !== undefined ? { media_url: input.media_url || null } : {}),
            ...(input.media_type !== undefined ? { media_type: input.media_type || null } : {}),
            ...timing,
            status: "PENDING",
            last_error: null,
            updated_at: new Date(),
        })
        .returning(COLUMNS);
    return row;
}

export async function cancelSchedule(session: WaSessionRow, id: string) {
    const current = await requireSchedule(session, id);
    if (current.status === "SENDING")
        throw new createHttpError.Conflict("This message is being sent right now");
    const [row] = await connection("wa_scheduled_messages")
        .where({ id })
        .update({ status: "CANCELLED", updated_at: new Date() })
        .returning(COLUMNS);
    return row;
}
