import createHttpError from "http-errors";
import connection from "../utils/dbUtil";
import type { SessionStatus, WaSessionRow, WaSessionSettings } from "../types";

/**
 * wa_sessions rows and their settings, cached in memory for a few seconds:
 * every incoming message needs its number's settings, and they change rarely.
 * Writes go through here (or call invalidate) so the cache never serves stale
 * settings for long.
 */
const TTL_MS = 30_000;
const settingsCache = new Map<string, { value: WaSessionSettings; at: number }>();

export const SESSION_COLUMNS = [
    "id",
    "session_key",
    "name",
    "status",
    "phone_jid",
    "push_name",
    "last_connected_at",
    "created_by",
    "created_at",
    "updated_at",
];

export const findSessionByKey = (sessionKey: string): Promise<WaSessionRow | undefined> =>
    connection("wa_sessions").where({ session_key: sessionKey }).first(SESSION_COLUMNS);

export const findSessionById = (id: string): Promise<WaSessionRow | undefined> =>
    connection("wa_sessions").where({ id }).first(SESSION_COLUMNS);

/** The number named in the URL, or a 404. */
export async function requireSession(sessionKey: string): Promise<WaSessionRow> {
    const session = await findSessionByKey(sessionKey);
    if (!session) throw new createHttpError.NotFound(`WhatsApp number "${sessionKey}" not found`);
    return session;
}

export async function setSessionStatus(
    id: string,
    status: SessionStatus,
    extra: Partial<WaSessionRow> = {}
) {
    await connection("wa_sessions")
        .where({ id })
        .update({ status, ...extra, updated_at: connection.fn.now() });
}

const DEFAULT_SETTINGS = (sessionId: string): WaSessionSettings => ({
    session_id: sessionId,
    welcome_message: null,
    auto_reply_enabled: true,
    auto_reply_mode: "ALL",
    auto_reply_jids: [],
    throttle_enabled: true,
    throttle_limit: 5,
    throttle_window_seconds: 10,
    throttle_delay_min_ms: 1000,
    throttle_delay_max_ms: 3000,
    auto_read: false,
    always_online: false,
});

export async function getSettings(sessionId: string): Promise<WaSessionSettings> {
    const cached = settingsCache.get(sessionId);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
    const row = await connection("wa_session_settings").where({ session_id: sessionId }).first();
    const value: WaSessionSettings = row
        ? { ...row, auto_reply_jids: Array.isArray(row.auto_reply_jids) ? row.auto_reply_jids : [] }
        : DEFAULT_SETTINGS(sessionId);
    settingsCache.set(sessionId, { value, at: Date.now() });
    return value;
}

export const invalidateSettings = (sessionId: string) => settingsCache.delete(sessionId);
