import createHttpError from "http-errors";
import connection from "../utils/dbUtil";
import { logger } from "../utils/logger";
import type { SessionStatus } from "../types";
import { clearStoredLogin, hasStoredLogin } from "./authState";
import { SessionConnection } from "./connection";
import { setSessionStatus } from "./sessions";

/**
 * The running connections of this process. fin_whatsapp runs as ONE instance:
 * a WhatsApp login can only be connected from one place, so a second replica
 * would knock the first off (both then stop, see SessionConnection).
 */
const connections = new Map<string, SessionConnection>();

type SessionRef = { id: string; session_key: string };

export const manager = {
    /** Live status and QR of a number, or null when this process isn't running it. */
    state(sessionId: string): { status: SessionStatus; qr: string | null } | null {
        const c = connections.get(sessionId);
        return c ? { status: c.status, qr: c.qr } : null;
    },

    async start(session: SessionRef) {
        const existing = connections.get(session.id);
        if (existing && ["CONNECTED", "CONNECTING", "SCAN_QR"].includes(existing.status))
            return existing;
        existing?.halt();
        const c = new SessionConnection(session);
        connections.set(session.id, c);
        await c.start();
        return c;
    },

    async stop(session: SessionRef) {
        const c = connections.get(session.id);
        connections.delete(session.id);
        if (c) await c.stop();
        else await setSessionStatus(session.id, "STOPPED");
    },

    async restart(session: SessionRef) {
        await manager.stop(session);
        return manager.start(session);
    },

    async logout(session: SessionRef) {
        const c = connections.get(session.id);
        connections.delete(session.id);
        if (c) {
            await c.logout();
        } else {
            await clearStoredLogin(session.id);
            await setSessionStatus(session.id, "LOGGED_OUT");
        }
    },

    async requestPairingCode(session: SessionRef, phone: string) {
        const c = connections.get(session.id);
        if (!c)
            throw new createHttpError.Conflict(
                "Start the number first, then ask for a pairing code"
            );
        return c.requestPairingCode(phone);
    },

    /** On boot: reconnect every number that was running and still has its login. */
    async startAll() {
        const rows = await connection("wa_sessions")
            .whereNotIn("status", ["STOPPED", "LOGGED_OUT"])
            .select("id", "session_key");
        let started = 0;
        for (const row of rows) {
            if (!(await hasStoredLogin(row.id))) {
                await setSessionStatus(row.id, "STOPPED");
                continue;
            }
            try {
                await manager.start(row);
                started++;
            } catch (err: any) {
                logger.error(`[manager] could not start ${row.session_key}: ${err?.message}`);
            }
        }
        logger.info(`[manager] ${started} WhatsApp number(s) reconnecting`);
    },

    /** Service shutdown: close sockets, keep logins and statuses so the next boot reconnects. */
    shutdownAll() {
        for (const c of connections.values()) c.halt();
        connections.clear();
    },
};
