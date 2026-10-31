import createHttpError from "http-errors";
import type { WASocket } from "@whiskeysockets/baileys";

/**
 * The connected socket of each number (wa_sessions.id -> socket). Connections
 * register here when they open and leave when they close; senders only look
 * here, so sending never needs the connection manager itself.
 */
const sockets = new Map<string, WASocket>();

export const setLiveSocket = (sessionId: string, sock: WASocket | null) => {
    if (sock) sockets.set(sessionId, sock);
    else sockets.delete(sessionId);
};

export const liveSocket = (sessionId: string) => sockets.get(sessionId) ?? null;

/** The number's socket, or a 409 when it isn't connected right now. */
export function requireSocket(sessionId: string): WASocket {
    const sock = sockets.get(sessionId);
    if (!sock) throw new createHttpError.Conflict("This WhatsApp number is not connected");
    return sock;
}
