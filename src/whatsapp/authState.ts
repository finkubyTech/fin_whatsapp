import type {
    AuthenticationCreds,
    AuthenticationState,
    SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import connection from "../utils/dbUtil";
import { logger } from "../utils/logger";
import { decryptText, encryptText } from "../helpers/crypto";
import { BufferJSON, initAuthCreds, proto } from "./baileys";

/**
 * Baileys' login keys in wa_auth_states, encrypted. Same shape as Baileys'
 * useMultiFileAuthState (one value per "<type>-<id>"), but each batch Baileys
 * reads or writes is one query, not one per key (WA-AKG did one per key).
 */
const TABLE = "wa_auth_states";
const CREDS = "creds";

const encode = (value: unknown) => encryptText(JSON.stringify(value, BufferJSON.replacer));
const decode = (stored: string) => JSON.parse(decryptText(stored), BufferJSON.reviver);

const chunks = <T>(items: T[], size: number) =>
    Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
        items.slice(i * size, i * size + size)
    );

export async function useDbAuthState(sessionId: string): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
}> {
    const row = await connection(TABLE).where({ session_id: sessionId, key: CREDS }).first("value");
    const creds: AuthenticationCreds = row ? decode(row.value) : initAuthCreds();

    const state: AuthenticationState = {
        creds,
        keys: {
            get: async (type, ids) => {
                const out: { [id: string]: SignalDataTypeMap[typeof type] } = {};
                if (ids.length === 0) return out;
                const rows = await connection(TABLE)
                    .where({ session_id: sessionId })
                    .whereIn(
                        "key",
                        ids.map((id) => `${type}-${id}`)
                    )
                    .select("key", "value");
                for (const r of rows) {
                    try {
                        let value = decode(r.value);
                        if (type === "app-state-sync-key" && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        out[r.key.slice(type.length + 1)] = value;
                    } catch (err: any) {
                        // A key encrypted with another WHATSAPP_ENCRYPTION_KEY: treated as missing.
                        logger.error(
                            `[authState] unreadable ${type} key for session ${sessionId}: ${err?.message}`
                        );
                    }
                }
                return out;
            },
            set: async (data) => {
                const now = new Date();
                const upserts: {
                    session_id: string;
                    key: string;
                    value: string;
                    updated_at: Date;
                }[] = [];
                const removals: string[] = [];
                for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
                    for (const [id, value] of Object.entries(data[type] || {})) {
                        const key = `${type}-${id}`;
                        if (value)
                            upserts.push({
                                session_id: sessionId,
                                key,
                                value: encode(value),
                                updated_at: now,
                            });
                        else removals.push(key);
                    }
                }
                await connection.transaction(async (trx) => {
                    for (const batch of chunks(upserts, 500)) {
                        await trx(TABLE)
                            .insert(batch)
                            .onConflict(["session_id", "key"])
                            .merge(["value", "updated_at"]);
                    }
                    for (const batch of chunks(removals, 500)) {
                        await trx(TABLE)
                            .where({ session_id: sessionId })
                            .whereIn("key", batch)
                            .del();
                    }
                });
            },
        },
    };

    return {
        state,
        saveCreds: async () => {
            await connection(TABLE)
                .insert({
                    session_id: sessionId,
                    key: CREDS,
                    value: encode(creds),
                    updated_at: new Date(),
                })
                .onConflict(["session_id", "key"])
                .merge(["value", "updated_at"]);
        },
    };
}

/** True when the number has a stored login (it was linked at some point). */
export const hasStoredLogin = async (sessionId: string) =>
    !!(await connection(TABLE).where({ session_id: sessionId, key: CREDS }).first("session_id"));

/** Forgets the login: the number has to be linked again by QR. */
export const clearStoredLogin = (sessionId: string) =>
    connection(TABLE).where({ session_id: sessionId }).del();
