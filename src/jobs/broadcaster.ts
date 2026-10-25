import connection from "../utils/dbUtil";
import { logger } from "../utils/logger";
import { liveSocket } from "../whatsapp/registry";
import { isOptedOut } from "../whatsapp/optOuts";
import { composeMessage } from "../whatsapp/compose";
import { send } from "../whatsapp/sender";

/**
 * Broadcasts run from the database, not from the request that created them
 * (WA-AKG's ran in memory and were lost on a restart): every 10 s each RUNNING
 * broadcast whose number is connected is picked up and works through its
 * PENDING recipients one at a time, a random delay_min_ms..delay_max_ms apart
 * (10-30 s by default). Opted-out recipients are SKIPPED. Cancelling stops it
 * before the next recipient. A disconnect pauses it until the number is back.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const between = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

const active = new Set<string>();

async function work(broadcast: any) {
    // The media is fetched once per run, not once per recipient.
    const message = await composeMessage(
        broadcast.message,
        broadcast.media_url,
        broadcast.media_type
    );
    for (;;) {
        const current = await connection("wa_broadcasts")
            .where({ id: broadcast.id })
            .first("status");
        if (current?.status !== "RUNNING" || !liveSocket(broadcast.session_id)) return;

        const next = await connection("wa_broadcast_recipients")
            .where({ broadcast_id: broadcast.id, status: "PENDING" })
            .orderBy("id")
            .first("id", "jid");
        if (!next) {
            await connection("wa_broadcasts")
                .where({ id: broadcast.id, status: "RUNNING" })
                .update({ status: "COMPLETED", completed_at: new Date() });
            logger.info(`[broadcaster] broadcast ${broadcast.id} completed`);
            return;
        }

        let status: "SENT" | "FAILED" | "SKIPPED";
        let error: string | null = null;
        if (await isOptedOut(broadcast.session_id, next.jid)) {
            status = "SKIPPED";
            error = "Opted out";
        } else {
            try {
                await send({ id: broadcast.session_id }, next.jid, message);
                status = "SENT";
            } catch (err: any) {
                if (!liveSocket(broadcast.session_id)) return; // disconnected mid-send: retry this recipient later
                status = "FAILED";
                error = err?.message || "Send failed";
            }
        }

        const counter = status === "SENT" ? "sent" : status === "FAILED" ? "failed" : "skipped";
        await connection.transaction(async (trx) => {
            await trx("wa_broadcast_recipients")
                .where({ id: next.id })
                .update({ status, error, sent_at: status === "SENT" ? new Date() : null });
            await trx("wa_broadcasts").where({ id: broadcast.id }).increment(counter, 1);
        });
        if (status === "SENT") await sleep(between(broadcast.delay_min_ms, broadcast.delay_max_ms));
    }
}

export async function runBroadcasts() {
    try {
        const running = await connection("wa_broadcasts")
            .where({ status: "RUNNING" })
            .select(
                "id",
                "session_id",
                "message",
                "media_url",
                "media_type",
                "delay_min_ms",
                "delay_max_ms"
            );
        for (const broadcast of running) {
            if (active.has(broadcast.id) || !liveSocket(broadcast.session_id)) continue;
            active.add(broadcast.id);
            work(broadcast)
                .catch((err: any) =>
                    logger.error(`[broadcaster] broadcast ${broadcast.id}: ${err?.message}`)
                )
                .finally(() => active.delete(broadcast.id));
        }
    } catch (err: any) {
        logger.error(`[broadcaster] ${err?.message}`);
    }
}
