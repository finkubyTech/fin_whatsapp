import { logger } from "../utils/logger";
import { pruneWebhookLogs } from "../whatsapp/webhooks";
import { runBroadcasts } from "./broadcaster";
import { runDueSchedules } from "./scheduler";

/** Background work of the one fin_whatsapp instance: schedules, broadcasts, log retention. */
const timers: NodeJS.Timeout[] = [];

export function startJobs() {
    timers.push(setInterval(() => void runDueSchedules(), 30_000));
    timers.push(setInterval(() => void runBroadcasts(), 10_000));
    timers.push(
        setInterval(
            () =>
                pruneWebhookLogs().catch((err: any) =>
                    logger.error(`[jobs] webhook log retention: ${err?.message}`)
                ),
            60 * 60_000
        )
    );
    void runDueSchedules();
    void runBroadcasts();
}

export function stopJobs() {
    for (const timer of timers.splice(0)) clearInterval(timer);
}
