import { CronExpressionParser } from "cron-parser";
import connection from "../utils/dbUtil";
import { logger } from "../utils/logger";
import { liveSocket } from "../whatsapp/registry";
import { composeMessage } from "../whatsapp/compose";
import { send } from "../whatsapp/sender";

/**
 * Scheduled messages, every 30 s. Due rows are claimed with one UPDATE …
 * FOR UPDATE SKIP LOCKED, so each is sent once even if two ticks overlap
 * (WA-AKG ran two schedulers over the same rows and could send twice).
 * A number that isn't connected keeps its messages for the next tick.
 * Recurring messages (cron, IST) move to their next run after each send.
 */
export const SCHEDULE_TZ = "Asia/Kolkata";

export function nextRun(cronExpression: string, after = new Date()): Date {
    return CronExpressionParser.parse(cronExpression, { tz: SCHEDULE_TZ, currentDate: after })
        .next()
        .toDate();
}

async function sendOne(row: any) {
    if (!liveSocket(row.session_id)) {
        await connection("wa_scheduled_messages")
            .where({ id: row.id })
            .update({ status: "PENDING", updated_at: new Date() });
        return;
    }
    let error: string | null = null;
    try {
        const message = await composeMessage(row.content, row.media_url, row.media_type);
        await send({ id: row.session_id }, row.jid, message);
    } catch (err: any) {
        error = err?.message || "Send failed";
    }

    const now = new Date();
    if (row.cron_expression) {
        await connection("wa_scheduled_messages")
            .where({ id: row.id })
            .update({
                status: "PENDING",
                send_at: nextRun(row.cron_expression, now),
                last_sent_at: error ? row.last_sent_at : now,
                last_error: error,
                updated_at: now,
            });
    } else {
        await connection("wa_scheduled_messages")
            .where({ id: row.id })
            .update({
                status: error ? "FAILED" : "SENT",
                last_sent_at: error ? null : now,
                last_error: error,
                updated_at: now,
            });
    }
    if (error) logger.warn(`[scheduler] message ${row.id} failed: ${error}`);
}

let running = false;
export async function runDueSchedules() {
    if (running) return;
    running = true;
    try {
        // A crash mid-send leaves rows SENDING: give them back after 10 minutes.
        await connection("wa_scheduled_messages")
            .where({ status: "SENDING" })
            .where("updated_at", "<", connection.raw("now() - interval '10 minutes'"))
            .update({ status: "PENDING", updated_at: new Date() });

        const claimed = await connection.raw(`
            UPDATE wa_scheduled_messages SET status = 'SENDING', updated_at = now()
            WHERE id IN (
                SELECT id FROM wa_scheduled_messages
                WHERE status = 'PENDING' AND send_at <= now()
                ORDER BY send_at LIMIT 50
                FOR UPDATE SKIP LOCKED
            )
            RETURNING *`);
        for (const row of claimed.rows) await sendOne(row);
    } catch (err: any) {
        logger.error(`[scheduler] ${err?.message}`);
    } finally {
        running = false;
    }
}
