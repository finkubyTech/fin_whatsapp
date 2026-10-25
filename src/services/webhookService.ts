import createHttpError from "http-errors";
import { config } from "../../config/options";
import connection from "../utils/dbUtil";
import { decryptText, encryptText } from "../helpers/crypto";
import { requireUuid } from "../helpers/ids";
import { checkUrl } from "../helpers/safeFetch";
import { pageOf, paged } from "../helpers/pagination";
import type { WaSessionRow } from "../types";
import { deliver, invalidateWebhooks } from "../whatsapp/webhooks";

// The secret is stored encrypted and never returned; has_secret says whether one is set.
const COLUMNS = [
    "id",
    "name",
    "url",
    "events",
    "is_active",
    "created_by",
    "created_at",
    "updated_at",
];
const shape = (row: any) => ({ ...row, has_secret: !!row.secret, secret: undefined });

type Input = Partial<{
    name: string;
    url: string;
    secret: string | null;
    events: string[];
    is_active: boolean;
}>;

/** The URL must pass the same checks a delivery does (https, public address, or an allowed internal host). */
async function assertUrl(url: string) {
    try {
        await checkUrl(url, { trustedHosts: config.whatsapp.webhookAllowedHosts });
    } catch (err: any) {
        throw new createHttpError.BadRequest(`Webhook URL not allowed: ${err?.message}`);
    }
}

export async function listWebhooks(session: WaSessionRow) {
    const rows = await connection("wa_webhooks")
        .where({ session_id: session.id })
        .orderBy("created_at")
        .select([...COLUMNS, "secret"]);
    return rows.map(shape);
}

async function requireWebhook(session: WaSessionRow, id: string) {
    const row = await connection("wa_webhooks")
        .where({ id: requireUuid(id, "Webhook"), session_id: session.id })
        .first([...COLUMNS, "secret"]);
    if (!row) throw new createHttpError.NotFound("Webhook not found");
    return row;
}

export async function createWebhook(session: WaSessionRow, input: Input, staffId: string | null) {
    await assertUrl(input.url!);
    const [row] = await connection("wa_webhooks")
        .insert({
            session_id: session.id,
            name: input.name,
            url: input.url,
            secret: input.secret ? encryptText(input.secret) : null,
            events: JSON.stringify(input.events?.length ? input.events : ["*"]),
            is_active: input.is_active ?? true,
            created_by: staffId,
        })
        .returning([...COLUMNS, "secret"]);
    invalidateWebhooks(session.id);
    return shape(row);
}

export async function updateWebhook(session: WaSessionRow, id: string, input: Input) {
    await requireWebhook(session, id);
    if (input.url) await assertUrl(input.url);
    const [row] = await connection("wa_webhooks")
        .where({ id })
        .update({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.url !== undefined ? { url: input.url } : {}),
            ...(input.secret !== undefined
                ? { secret: input.secret ? encryptText(input.secret) : null }
                : {}),
            ...(input.events !== undefined
                ? { events: JSON.stringify(input.events.length ? input.events : ["*"]) }
                : {}),
            ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
            updated_at: new Date(),
        })
        .returning([...COLUMNS, "secret"]);
    invalidateWebhooks(session.id);
    return shape(row);
}

export async function deleteWebhook(session: WaSessionRow, id: string) {
    await requireWebhook(session, id);
    await connection("wa_webhooks").where({ id }).del();
    invalidateWebhooks(session.id);
}

export async function webhookLogs(session: WaSessionRow, id: string, query: Record<string, any>) {
    await requireWebhook(session, id);
    const page = pageOf(query, 50, 200);
    const base = connection("wa_webhook_logs")
        .where({ webhook_id: id })
        .modify((q) => {
            if (query.status) q.where({ status: String(query.status) });
        });
    const [{ count }] = await base.clone().count({ count: "*" });
    const rows = await base
        .clone()
        .select(
            "id",
            "event",
            "status",
            "response_status",
            "response_body",
            "error",
            "duration_ms",
            "created_at"
        )
        .orderBy("created_at", "desc")
        .limit(page.perPage)
        .offset(page.offset);
    return paged(rows, Number(count), page, "Webhook deliveries fetched");
}

/** Sends a "test" event now and returns how the endpoint answered. */
export async function testWebhook(session: WaSessionRow, id: string) {
    const row = await requireWebhook(session, id);
    const body = JSON.stringify({
        event: "test",
        sessionId: session.session_key,
        timestamp: new Date().toISOString(),
        data: { message: "fin_whatsapp webhook test" },
    });
    return deliver(
        {
            id: row.id,
            url: row.url,
            secret: row.secret ? decryptText(row.secret) : null,
            events: [],
        },
        "test",
        body
    );
}
