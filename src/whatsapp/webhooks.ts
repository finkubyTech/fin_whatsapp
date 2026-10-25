import crypto from "crypto";
import { config } from "../../config/options";
import connection from "../utils/dbUtil";
import { logger } from "../utils/logger";
import { decryptText } from "../helpers/crypto";
import { safePostJson } from "../helpers/safeFetch";
import type { WebhookEvent } from "../types";

/**
 * Outgoing webhooks: each event is POSTed to the number's active webhooks that
 * subscribe to it, signed with HMAC-SHA256 (X-Webhook-Signature: sha256=<hex>)
 * when the webhook has a secret, and logged in wa_webhook_logs.
 *
 * WA-AKG ran four queries per event to find the webhooks; here they are cached
 * per number and the cache is dropped whenever a webhook changes.
 */
interface ActiveHook {
    id: string;
    url: string;
    secret: string | null;
    events: string[];
}

const TTL_MS = 60_000;
const cache = new Map<string, { hooks: ActiveHook[]; at: number }>();

async function hooksFor(sessionId: string): Promise<ActiveHook[]> {
    const cached = cache.get(sessionId);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.hooks;
    const rows = await connection("wa_webhooks")
        .where({ session_id: sessionId, is_active: true })
        .select("id", "url", "secret", "events");
    const hooks = rows.map((r: any) => ({
        id: r.id,
        url: r.url,
        secret: r.secret ? decryptText(r.secret) : null,
        events: Array.isArray(r.events) ? r.events : [],
    }));
    cache.set(sessionId, { hooks, at: Date.now() });
    return hooks;
}

export const invalidateWebhooks = (sessionId: string) => cache.delete(sessionId);

// Baileys timestamps can be Long objects or bigints.
const replacer = (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value;

export const signatureOf = (secret: string, body: string) =>
    `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

export interface DeliveryResult {
    ok: boolean;
    status: number | null;
    error: string | null;
    durationMs: number;
}

/** Sends one body to one webhook and logs the attempt. Never throws. */
export async function deliver(
    hook: ActiveHook,
    event: WebhookEvent,
    body: string
): Promise<DeliveryResult> {
    const started = Date.now();
    const headers: Record<string, string> = {
        "user-agent": "fin_whatsapp-webhook/1.0",
        "x-webhook-event": event,
    };
    if (hook.secret) headers["x-webhook-signature"] = signatureOf(hook.secret, body);

    let status: number | null = null;
    let responseBody: string | null = null;
    let error: string | null = null;
    try {
        const res = await safePostJson(hook.url, body, headers, {
            trustedHosts: config.whatsapp.webhookAllowedHosts,
        });
        status = res.status;
        responseBody = res.body || null;
        if (status < 200 || status >= 300) error = `Webhook answered ${status}`;
    } catch (err: any) {
        error = err?.message || "Webhook request failed";
    }
    const durationMs = Date.now() - started;

    connection("wa_webhook_logs")
        .insert({
            webhook_id: hook.id,
            event,
            status: error ? "FAILED" : "SUCCESS",
            response_status: status,
            response_body: responseBody,
            error,
            duration_ms: durationMs,
        })
        .catch((err: any) => logger.error(`[webhooks] could not log delivery: ${err?.message}`));
    if (error) logger.warn(`[webhooks] ${event} to webhook ${hook.id} failed: ${error}`);
    return { ok: !error, status, error, durationMs };
}

/** Fire-and-forget: posts the event to every matching webhook of the number. */
export function dispatch(
    session: { id: string; session_key: string },
    event: WebhookEvent,
    data: unknown
) {
    hooksFor(session.id)
        .then((hooks) => {
            const matching = hooks.filter(
                (h) => h.events.includes(event) || h.events.includes("*")
            );
            if (matching.length === 0) return;
            const body = JSON.stringify(
                {
                    event,
                    sessionId: session.session_key,
                    timestamp: new Date().toISOString(),
                    data,
                },
                replacer
            );
            for (const hook of matching) void deliver(hook, event, body);
        })
        .catch((err: any) => logger.error(`[webhooks] dispatch ${event} failed: ${err?.message}`));
}

/** Keeps 30 days and at most 500 deliveries per webhook (run hourly). */
export async function pruneWebhookLogs() {
    await connection("wa_webhook_logs")
        .where("created_at", "<", connection.raw("now() - interval '30 days'"))
        .del();
    await connection.raw(`
        DELETE FROM wa_webhook_logs l
        USING (
            SELECT id FROM (
                SELECT id, row_number() OVER (PARTITION BY webhook_id ORDER BY created_at DESC) AS n
                FROM wa_webhook_logs
            ) ranked WHERE n > 500
        ) old
        WHERE l.id = old.id`);
}
