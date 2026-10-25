import connection from "../utils/dbUtil";

/**
 * The opt-out list. An active row (removed_at null) blocks every message to
 * that chat from this number: API sends, welcome, auto-replies, schedules and
 * broadcasts. WA-AKG only logged opt-outs and kept sending.
 */
export async function isOptedOut(sessionId: string, jid: string): Promise<boolean> {
    return !!(await connection("wa_opt_outs")
        .where({ session_id: sessionId, jid })
        .whereNull("removed_at")
        .first("id"));
}

/** Adds an active opt-out unless one exists. Returns true when this call added it. */
export async function recordOptOut(
    sessionId: string,
    jid: string,
    message: string | null,
    source: "KEYWORD" | "STAFF",
    createdBy: string | null = null
): Promise<boolean> {
    const result = await connection.raw(
        `INSERT INTO wa_opt_outs (session_id, jid, message, source, created_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (session_id, jid) WHERE removed_at IS NULL DO NOTHING
         RETURNING id`,
        [sessionId, jid, message, source, createdBy]
    );
    return result.rows.length > 0;
}
