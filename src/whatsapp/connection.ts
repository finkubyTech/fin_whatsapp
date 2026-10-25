import type { ConnectionState, WAMessageKey, WASocket } from "@whiskeysockets/baileys";
import { config } from "../../config/options";
import connection from "../utils/dbUtil";
import { logger } from "../utils/logger";
import { bareJid } from "../helpers/jid";
import type { SessionStatus } from "../types";
import {
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    makeWASocket,
} from "./baileys";
import { baileysLogger } from "./baileysLogger";
import { clearStoredLogin, useDbAuthState } from "./authState";
import { bindIngest, IngestContext, syncGroups } from "./ingest";
import { setLiveSocket } from "./registry";
import { getSettings, setSessionStatus } from "./sessions";
import { dispatch } from "./webhooks";

// The WhatsApp Web version, asked once per 6 hours (WA-AKG asked on every
// connect). Baileys' built-in version is used if the lookup fails.
let versionCache: { at: number; version?: [number, number, number] } | null = null;
async function waVersion() {
    if (versionCache && Date.now() - versionCache.at < 6 * 3600_000) return versionCache.version;
    try {
        const { version } = await fetchLatestBaileysVersion();
        versionCache = { at: Date.now(), version };
    } catch {
        versionCache = { at: Date.now() };
    }
    return versionCache.version;
}

const MAX_BACKOFF_MS = 5 * 60_000;
const UNSCANNED_QR_LIMIT = 3;

/**
 * One linked number's connection. Reconnects on its own after a network drop
 * (2 s, 4 s, … up to 5 min apart, without the 3-try limit WA-AKG had); stops
 * for good when WhatsApp logs it out (the login is deleted: link it again by
 * QR) or when another connection takes the number over.
 */
export class SessionConnection {
    status: SessionStatus = "STOPPED";
    qr: string | null = null;
    private sock: WASocket | null = null;
    private stopping = false;
    private attempts = 0;
    private qrShown = 0;
    private timer: NodeJS.Timeout | null = null;

    constructor(readonly session: { id: string; session_key: string }) {}

    get ownJid(): string | null {
        return this.sock?.user?.id ? bareJid(this.sock.user.id) : null;
    }

    async start() {
        this.stopping = false;
        this.attempts = 0;
        this.qrShown = 0;
        await this.open();
    }

    private async setStatus(status: SessionStatus, extra: Record<string, unknown> = {}) {
        const changed = status !== this.status;
        this.status = status;
        await setSessionStatus(this.session.id, status, extra as any);
        if (changed || status === "SCAN_QR") {
            dispatch(this.session, "connection.update", {
                status,
                qr: status === "SCAN_QR" ? this.qr : null,
            });
        }
    }

    private async open() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        await this.setStatus("CONNECTING");

        const { state, saveCreds } = await useDbAuthState(this.session.id);
        const settings = await getSettings(this.session.id);
        const sessionId = this.session.id;
        const sock = makeWASocket({
            version: await waVersion(),
            logger: baileysLogger as any,
            browser: Browsers.ubuntu("Chrome"),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, baileysLogger as any),
            },
            markOnlineOnConnect: settings.always_online,
            syncFullHistory: config.whatsapp.syncFullHistory,
            generateHighQualityLinkPreview: false,
            // Lets Baileys resend a text when the recipient's phone asks for it again.
            getMessage: async (key: WAMessageKey) => {
                if (!key.id) return undefined;
                const row = await connection("wa_messages")
                    .where({ session_id: sessionId, key_id: key.id })
                    .first("content");
                return row?.content ? { conversation: row.content } : undefined;
            },
        });
        this.sock = sock;

        const ctx: IngestContext = { session: this.session, sock, ownJid: () => this.ownJid };
        sock.ev.on("creds.update", saveCreds);
        sock.ev.on("connection.update", (update) =>
            this.onUpdate(update, ctx, !!state.creds.me).catch((err: any) =>
                logger.error(`[connection] ${this.session.session_key}: ${err?.message}`)
            )
        );
        bindIngest(ctx);
    }

    private async onUpdate(update: Partial<ConnectionState>, ctx: IngestContext, linked: boolean) {
        const { connection: state, lastDisconnect, qr } = update;

        if (qr) {
            this.qr = qr;
            this.qrShown++;
            await this.setStatus("SCAN_QR");
        }

        if (state === "open") {
            this.attempts = 0;
            this.qrShown = 0;
            this.qr = null;
            setLiveSocket(this.session.id, ctx.sock);
            await this.setStatus("CONNECTED", {
                phone_jid: this.ownJid,
                push_name: ctx.sock.user?.name ?? null,
                last_connected_at: new Date(),
            });
            logger.info(`[connection] ${this.session.session_key} connected`);
            void syncGroups(ctx);
        }

        if (state === "close") {
            setLiveSocket(this.session.id, null);
            this.sock = null;
            this.qr = null;
            const code = (lastDisconnect?.error as any)?.output?.statusCode;

            if (this.stopping) return;
            if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
                await clearStoredLogin(this.session.id);
                await this.setStatus("LOGGED_OUT");
                logger.warn(
                    `[connection] ${this.session.session_key} was logged out (${code}); link it again by QR`
                );
                return;
            }
            if (
                code === DisconnectReason.connectionReplaced ||
                code === DisconnectReason.forbidden
            ) {
                await this.setStatus("DISCONNECTED");
                logger.error(
                    `[connection] ${this.session.session_key} closed (${code}): another connection took the number, ` +
                        "or WhatsApp refused it. Not reconnecting; start it again once only one fin_whatsapp runs."
                );
                return;
            }
            if (!linked && this.qrShown >= UNSCANNED_QR_LIMIT) {
                await this.setStatus("STOPPED");
                logger.warn(`[connection] ${this.session.session_key}: QR not scanned, stopped`);
                return;
            }

            const delay =
                code === DisconnectReason.restartRequired
                    ? 0
                    : Math.min(MAX_BACKOFF_MS, 2000 * 2 ** this.attempts++);
            await this.setStatus("DISCONNECTED");
            logger.warn(
                `[connection] ${this.session.session_key} closed (${code ?? "unknown"}); reconnecting in ${Math.round(delay / 1000)} s`
            );
            this.timer = setTimeout(() => {
                this.open().catch((err: any) =>
                    logger.error(`[connection] reopen ${this.session.session_key}: ${err?.message}`)
                );
            }, delay);
        }
    }

    async requestPairingCode(phone: string): Promise<string> {
        if (!this.sock) throw Object.assign(new Error("Start the number first"), { status: 409 });
        return this.sock.requestPairingCode(phone.replace(/\D/g, ""));
    }

    /** Closes the connection, keeping the login, and records STOPPED. */
    async stop() {
        this.halt();
        await this.setStatus("STOPPED");
    }

    /** Logs the number out of WhatsApp (it disappears from the phone's linked devices) and deletes the login. */
    async logout() {
        this.stopping = true;
        if (this.timer) clearTimeout(this.timer);
        try {
            await this.sock?.logout();
        } catch (err: any) {
            logger.warn(`[connection] logout of ${this.session.session_key}: ${err?.message}`);
        }
        this.halt();
        await clearStoredLogin(this.session.id);
        await this.setStatus("LOGGED_OUT");
    }

    /** Closes the socket without touching the stored status (service shutdown: it reconnects on the next boot). */
    halt() {
        this.stopping = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        setLiveSocket(this.session.id, null);
        this.sock?.end(undefined);
        this.sock = null;
        this.qr = null;
    }
}
