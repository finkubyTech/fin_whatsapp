import createHttpError from "http-errors";
import connection from "../utils/dbUtil";
import { bareJid, isLidJid, phoneOf, toJid } from "../helpers/jid";
import { pageOf, paged } from "../helpers/pagination";
import type { WaSessionRow } from "../types";
import { liveSocket, requireSocket } from "../whatsapp/registry";

const CONTACT_COLUMNS = [
    "jid",
    "lid",
    "phone_jid",
    "name",
    "notify",
    "verified_name",
    "updated_at",
];

export async function listContacts(session: WaSessionRow, query: Record<string, any>) {
    const page = pageOf(query, 50, 500);
    const base = connection("wa_contacts")
        .where({ session_id: session.id })
        .modify((q) => {
            if (query.search) {
                const term = `%${String(query.search).trim()}%`;
                q.where((w) =>
                    w
                        .whereILike("jid", term)
                        .orWhereILike("phone_jid", term)
                        .orWhereILike("lid", term)
                        .orWhereILike("name", term)
                        .orWhereILike("notify", term)
                        .orWhereILike("verified_name", term)
                );
            }
        });
    const [{ count }] = await base.clone().count({ count: "*" });
    const rows = await base
        .clone()
        .select(CONTACT_COLUMNS)
        .orderByRaw("COALESCE(name, notify, verified_name, jid)")
        .limit(page.perPage)
        .offset(page.offset);
    return paged(rows, Number(count), page, "Contacts fetched");
}

export async function getContact(session: WaSessionRow, jidOrPhone: string) {
    const jid = toJid(jidOrPhone);
    const row = await connection("wa_contacts")
        .where({ session_id: session.id })
        .andWhere((q) => q.where({ jid }).orWhere({ phone_jid: jid }).orWhere({ lid: jid }))
        .first(CONTACT_COLUMNS);
    if (!row) throw new createHttpError.NotFound("Contact not found");
    return row;
}

/** The phone-number JID of a hidden-number (@lid) contact, from stored contacts or WhatsApp's own mapping. */
export async function phoneForLid(session: WaSessionRow, lid: string) {
    const plain = bareJid(lid.includes("@") ? lid : `${lid}@lid`);
    if (!isLidJid(plain)) throw new createHttpError.BadRequest("Not a @lid address");
    const row = await connection("wa_contacts")
        .where({ session_id: session.id })
        .andWhere((q) => q.where({ lid: plain }).orWhere({ jid: plain }))
        .whereNotNull("phone_jid")
        .first("phone_jid");
    let jid: string | null = row?.phone_jid ?? null;
    if (!jid) {
        const pn = await (liveSocket(session.id) as any)?.signalRepository?.lidMapping
            ?.getPNForLID(plain)
            .catch(() => null);
        jid = pn ? bareJid(pn) : null;
    }
    if (!jid)
        throw new createHttpError.NotFound("The phone number behind this @lid isn't known yet");
    return { lid: plain, jid, phone: phoneOf(jid) };
}

/** Which of these numbers have WhatsApp. */
export async function checkNumbers(session: WaSessionRow, numbers: string[]) {
    const sock = requireSocket(session.id);
    const jids = [...new Set(numbers.map(toJid))];
    const found = (await sock.onWhatsApp(...jids)) || [];
    const byJid = new Map(found.map((r: any) => [bareJid(r.jid), r]));
    return jids.map((jid) => ({ jid, phone: phoneOf(jid), exists: !!byJid.get(jid)?.exists }));
}

export async function setBlocked(session: WaSessionRow, jidOrPhone: string, block: boolean) {
    const jid = toJid(jidOrPhone);
    await requireSocket(session.id).updateBlockStatus(jid, block ? "block" : "unblock");
    return { jid, blocked: block };
}
