import createHttpError from "http-errors";
import connection from "../utils/dbUtil";
import { requireUuid } from "../helpers/ids";
import { toJid } from "../helpers/jid";
import { pageOf, paged } from "../helpers/pagination";
import type { WaSessionRow } from "../types";
import { recordOptOut } from "../whatsapp/optOuts";
import { dispatch } from "../whatsapp/webhooks";

const COLUMNS = [
    "id",
    "jid",
    "message",
    "source",
    "opted_out_at",
    "created_by",
    "removed_at",
    "removed_by",
    "removed_reason",
];

/** Active opt-outs by default; ?include_removed=true lists the history too. */
export async function listOptOuts(session: WaSessionRow, query: Record<string, any>) {
    const page = pageOf(query, 50, 500);
    const base = connection("wa_opt_outs")
        .where({ session_id: session.id })
        .modify((q) => {
            if (query.include_removed !== "true") q.whereNull("removed_at");
            if (query.search) q.whereILike("jid", `%${String(query.search).replace(/\D/g, "")}%`);
        });
    const [{ count }] = await base.clone().count({ count: "*" });
    const rows = await base
        .clone()
        .select(COLUMNS)
        .orderBy("opted_out_at", "desc")
        .limit(page.perPage)
        .offset(page.offset);
    return paged(rows, Number(count), page, "Opt-outs fetched");
}

/** Staff add a number themselves (e.g. the customer asked by phone). */
export async function addOptOut(
    session: WaSessionRow,
    input: { to: string; reason?: string },
    staffId: string | null
) {
    const jid = toJid(input.to);
    if (!(await recordOptOut(session.id, jid, input.reason?.trim() || null, "STAFF", staffId))) {
        throw new createHttpError.Conflict("This number is already opted out");
    }
    dispatch(session, "opt_out", { jid, message: input.reason?.trim() || null, source: "STAFF" });
    return connection("wa_opt_outs")
        .where({ session_id: session.id, jid })
        .whereNull("removed_at")
        .first(COLUMNS);
}

/** Lets a number receive messages again; the row stays as history with who and why. */
export async function removeOptOut(
    session: WaSessionRow,
    id: string,
    reason: string,
    staffId: string | null
) {
    const [row] = await connection("wa_opt_outs")
        .where({ id: requireUuid(id, "Opt-out"), session_id: session.id })
        .whereNull("removed_at")
        .update({ removed_at: new Date(), removed_by: staffId, removed_reason: reason.trim() })
        .returning(COLUMNS);
    if (!row) throw new createHttpError.NotFound("Active opt-out not found");
    return row;
}
