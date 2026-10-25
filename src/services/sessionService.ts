import QRCode from "qrcode";
import createHttpError from "http-errors";
import connection from "../utils/dbUtil";
import type { WaSessionRow, WaSessionSettings } from "../types";
import { manager } from "../whatsapp/manager";
import { getSettings, invalidateSettings, SESSION_COLUMNS } from "../whatsapp/sessions";

/** A number with its live status (this process is the one running it). */
const withLive = (row: WaSessionRow) => {
    const live = manager.state(row.id);
    return { ...row, status: live?.status ?? row.status, has_qr: !!live?.qr };
};

export async function listSessions() {
    const rows: WaSessionRow[] = await connection("wa_sessions")
        .orderBy("created_at")
        .select(SESSION_COLUMNS);
    return rows.map(withLive);
}

export const getSession = (session: WaSessionRow) => withLive(session);

export async function createSession(
    input: { session_key: string; name: string },
    createdBy: string | null
) {
    const exists = await connection("wa_sessions")
        .where({ session_key: input.session_key })
        .first("id");
    if (exists)
        throw new createHttpError.Conflict(`A number called "${input.session_key}" already exists`);
    return connection.transaction(async (trx) => {
        const [row] = await trx("wa_sessions")
            .insert({ session_key: input.session_key, name: input.name, created_by: createdBy })
            .returning(SESSION_COLUMNS);
        await trx("wa_session_settings").insert({ session_id: row.id, updated_by: createdBy });
        return withLive(row);
    });
}

export async function updateSessionName(session: WaSessionRow, name: string) {
    const [row] = await connection("wa_sessions")
        .where({ id: session.id })
        .update({ name, updated_at: connection.fn.now() })
        .returning(SESSION_COLUMNS);
    return withLive(row);
}

/** QR to link the number (WhatsApp > Linked devices > Link a device), as text and as a PNG data URL. */
export async function getQr(session: WaSessionRow) {
    const live = manager.state(session.id);
    if (!live) throw new createHttpError.Conflict("Start the number to get a QR code");
    if (live.status === "CONNECTED") return { status: live.status, qr: null, qr_image: null };
    return {
        status: live.status,
        qr: live.qr,
        qr_image: live.qr ? await QRCode.toDataURL(live.qr, { margin: 1, width: 320 }) : null,
    };
}

export async function start(session: WaSessionRow) {
    await manager.start(session);
    return getSession(session);
}

export async function stop(session: WaSessionRow) {
    await manager.stop(session);
    return { ...session, status: "STOPPED" as const, has_qr: false };
}

export async function restart(session: WaSessionRow) {
    await manager.restart(session);
    return getSession(session);
}

export async function logout(session: WaSessionRow) {
    await manager.logout(session);
    return { ...session, status: "LOGGED_OUT" as const, has_qr: false };
}

/** Logs out and deletes the number with all its chats, messages and settings (media files are kept). */
export async function deleteSession(session: WaSessionRow) {
    await manager.logout(session).catch(() => undefined);
    invalidateSettings(session.id);
    await connection("wa_sessions").where({ id: session.id }).del();
}

export const requestPairingCode = async (session: WaSessionRow, phone: string) => ({
    pairing_code: await manager.requestPairingCode(session, phone),
});

export const getSessionSettings = (session: WaSessionRow) => getSettings(session.id);

export async function updateSessionSettings(
    session: WaSessionRow,
    patch: Partial<WaSessionSettings>,
    updatedBy: string | null
) {
    const current = await getSettings(session.id);
    const merged = { ...current, ...patch };
    if (merged.throttle_delay_max_ms < merged.throttle_delay_min_ms) {
        throw new createHttpError.BadRequest(
            "throttle_delay_max_ms must be at least throttle_delay_min_ms"
        );
    }
    const row = {
        welcome_message: merged.welcome_message?.trim() || null,
        auto_reply_enabled: merged.auto_reply_enabled,
        auto_reply_mode: merged.auto_reply_mode,
        auto_reply_jids: JSON.stringify(merged.auto_reply_jids || []),
        throttle_enabled: merged.throttle_enabled,
        throttle_limit: merged.throttle_limit,
        throttle_window_seconds: merged.throttle_window_seconds,
        throttle_delay_min_ms: merged.throttle_delay_min_ms,
        throttle_delay_max_ms: merged.throttle_delay_max_ms,
        auto_read: merged.auto_read,
        always_online: merged.always_online,
        updated_by: updatedBy,
        updated_at: new Date(),
    };
    await connection("wa_session_settings")
        .insert({ session_id: session.id, ...row })
        .onConflict("session_id")
        .merge(Object.keys(row));
    invalidateSettings(session.id);
    return getSettings(session.id);
}
