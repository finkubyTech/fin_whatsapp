import createHttpError from "http-errors";
import connection from "../utils/dbUtil";
import { requireUuid } from "../helpers/ids";
import { toJid } from "../helpers/jid";
import { pageOf, paged } from "../helpers/pagination";
import type { WaSessionRow } from "../types";

const COLUMNS = [
    "id",
    "message",
    "media_url",
    "media_type",
    "status",
    "total",
    "sent",
    "failed",
    "skipped",
    "delay_min_ms",
    "delay_max_ms",
    "created_by",
    "started_at",
    "completed_at",
];

/**
 * Creates a broadcast; the broadcaster job sends it (see jobs/broadcaster).
 * Recipients are de-duplicated. Personal, one-to-one messages only: identical
 * bulk messages are what gets a number banned, so keep lists small and the
 * delays long.
 */
export async function createBroadcast(
    session: WaSessionRow,
    input: {
        recipients: string[];
        message?: string;
        media_url?: string;
        media_type?: string;
        delay_min_ms?: number;
        delay_max_ms?: number;
    },
    staffId: string | null
) {
    if (!input.message && !input.media_url)
        throw new createHttpError.BadRequest("Give a message, a media_url, or both");
    if (input.media_url && !input.media_type)
        throw new createHttpError.BadRequest("media_type is required with media_url");
    const delayMin = input.delay_min_ms ?? 10_000;
    const delayMax = input.delay_max_ms ?? Math.max(delayMin, 30_000);
    if (delayMax < delayMin)
        throw new createHttpError.BadRequest("delay_max_ms must be at least delay_min_ms");

    const jids = [...new Set(input.recipients.map(toJid))];
    return connection.transaction(async (trx) => {
        const [broadcast] = await trx("wa_broadcasts")
            .insert({
                session_id: session.id,
                message: input.message || null,
                media_url: input.media_url || null,
                media_type: input.media_type || null,
                total: jids.length,
                delay_min_ms: delayMin,
                delay_max_ms: delayMax,
                created_by: staffId,
            })
            .returning(COLUMNS);
        for (let i = 0; i < jids.length; i += 500) {
            await trx("wa_broadcast_recipients").insert(
                jids.slice(i, i + 500).map((jid) => ({ broadcast_id: broadcast.id, jid }))
            );
        }
        return broadcast;
    });
}

export async function listBroadcasts(session: WaSessionRow, query: Record<string, any>) {
    const page = pageOf(query, 20, 100);
    const base = connection("wa_broadcasts").where({ session_id: session.id });
    const [{ count }] = await base.clone().count({ count: "*" });
    const rows = await base
        .clone()
        .select(COLUMNS)
        .orderBy("started_at", "desc")
        .limit(page.perPage)
        .offset(page.offset);
    return paged(rows, Number(count), page, "Broadcasts fetched");
}

/** One broadcast with its recipients (?status= filters them). */
export async function getBroadcast(session: WaSessionRow, id: string, query: Record<string, any>) {
    const broadcast = await connection("wa_broadcasts")
        .where({ id: requireUuid(id, "Broadcast"), session_id: session.id })
        .first(COLUMNS);
    if (!broadcast) throw new createHttpError.NotFound("Broadcast not found");
    const recipients = await connection("wa_broadcast_recipients")
        .where({ broadcast_id: id })
        .modify((q) => {
            if (query.status) q.where({ status: String(query.status) });
        })
        .select("jid", "status", "error", "sent_at")
        .orderBy("sent_at", "desc")
        .limit(1000);
    return { ...broadcast, recipients };
}

export async function cancelBroadcast(session: WaSessionRow, id: string) {
    const [row] = await connection("wa_broadcasts")
        .where({ id: requireUuid(id, "Broadcast"), session_id: session.id, status: "RUNNING" })
        .update({ status: "CANCELLED", completed_at: new Date() })
        .returning(COLUMNS);
    if (!row) throw new createHttpError.Conflict("Only a running broadcast can be cancelled");
    return row;
}
