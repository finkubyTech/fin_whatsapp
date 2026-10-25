import type { WaSessionSettings } from "../types";

/**
 * Send throttle per number: at most throttle_limit messages per
 * throttle_window_seconds; past that, each send waits a random
 * throttle_delay_min_ms..max_ms and checks again. Sends from one number go
 * through in order, one at a time. WhatsApp bans numbers that send in bursts,
 * so this sits in front of every send (API, auto-replies, schedules, broadcasts).
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const between = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

const tails = new Map<string, Promise<void>>();
const recent = new Map<string, number[]>();

export async function throttle<T>(
    sessionId: string,
    settings: WaSessionSettings,
    send: () => Promise<T>
): Promise<T> {
    if (!settings.throttle_enabled) return send();

    const previous = tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => mine);
    tails.set(sessionId, tail);
    await previous;

    try {
        for (;;) {
            const windowStart = Date.now() - settings.throttle_window_seconds * 1000;
            const sent = (recent.get(sessionId) || []).filter((t) => t > windowStart);
            recent.set(sessionId, sent);
            if (sent.length < settings.throttle_limit) break;
            await sleep(between(settings.throttle_delay_min_ms, settings.throttle_delay_max_ms));
        }
        recent.get(sessionId)!.push(Date.now());
        return await send();
    } finally {
        release();
        if (tails.get(sessionId) === tail) tails.delete(sessionId);
    }
}
