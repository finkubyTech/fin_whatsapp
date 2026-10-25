import connection from "../utils/dbUtil";
import { toJid } from "../helpers/jid";
import { pageOf, paged } from "../helpers/pagination";
import type { WaSessionRow } from "../types";
import { deleteMediaFiles, mediaUrl } from "../whatsapp/media";

/**
 * Chats, newest activity first: one indexed read of wa_chats (WA-AKG grouped
 * every stored message by chat to build this list), with the contact's or
 * group's name and the chat's labels.
 */
export async function listChats(session: WaSessionRow, query: Record<string, any>) {
    const page = pageOf(query, 30);
    const base = connection("wa_chats as c")
        .leftJoin("wa_contacts as ct", (j) =>
            j.on("ct.session_id", "c.session_id").andOn("ct.jid", "c.jid")
        )
        .leftJoin("wa_groups as g", (j) =>
            j.on("g.session_id", "c.session_id").andOn("g.jid", "c.jid")
        )
        .where("c.session_id", session.id)
        .modify((q) => {
            if (query.search) {
                const term = `%${String(query.search).trim()}%`;
                q.where((w) =>
                    w
                        .whereILike("c.jid", term)
                        .orWhereILike("ct.name", term)
                        .orWhereILike("ct.notify", term)
                        .orWhereILike("g.subject", term)
                );
            }
            if (query.label_id) {
                q.whereExists(
                    connection("wa_chat_labels as cl")
                        .whereRaw("cl.chat_jid = c.jid")
                        .where("cl.label_id", String(query.label_id))
                );
            }
            if (query.type === "group") q.where("c.is_group", true);
            if (query.type === "personal") q.where("c.is_group", false);
            if (query.unread === "true") q.where("c.unread_count", ">", 0);
        });

    const [{ count }] = await base.clone().count({ count: "*" });
    const rows = await base
        .clone()
        .select(
            "c.jid",
            "c.is_group",
            "c.last_message_at",
            "c.last_message_preview",
            "c.last_message_from_me",
            "c.unread_count",
            connection.raw(
                "COALESCE(g.subject, ct.name, ct.notify, ct.verified_name, c.name) AS name"
            )
        )
        .orderByRaw("c.last_message_at DESC NULLS LAST")
        .limit(page.perPage)
        .offset(page.offset);

    // Labels for this page in one query.
    const jids = rows.map((r: any) => r.jid);
    const labels = jids.length
        ? await connection("wa_chat_labels as cl")
              .join("wa_labels as l", "l.id", "cl.label_id")
              .where("l.session_id", session.id)
              .whereIn("cl.chat_jid", jids)
              .select("cl.chat_jid", "l.id", "l.name", "l.color")
        : [];
    const byChat = new Map<string, any[]>();
    for (const l of labels)
        byChat.set(l.chat_jid, [
            ...(byChat.get(l.chat_jid) || []),
            { id: l.id, name: l.name, color: l.color },
        ]);

    return paged(
        rows.map((r: any) => ({ ...r, labels: byChat.get(r.jid) || [] })),
        Number(count),
        page,
        "Chats fetched"
    );
}

/** A chat's messages, newest first; ?before=<ISO time> pages back. */
export async function listMessages(
    session: WaSessionRow,
    chat: string,
    query: Record<string, any>
) {
    const jid = toJid(chat);
    const limit = Math.min(200, Math.max(1, parseInt(String(query.limit ?? ""), 10) || 50));
    const rows = await connection("wa_messages")
        .where({ session_id: session.id, chat_jid: jid })
        .modify((q) => {
            if (query.before) q.where("message_at", "<", new Date(String(query.before)));
        })
        .orderBy("message_at", "desc")
        .limit(limit + 1)
        .select(
            "key_id",
            "chat_jid",
            "sender_jid",
            "from_me",
            "push_name",
            "type",
            "content",
            "file_name",
            "media_path",
            "media_mime",
            "status",
            "quoted_key_id",
            "message_at"
        );
    const hasMore = rows.length > limit;
    const messages = rows
        .slice(0, limit)
        .map(({ media_path, ...m }: any) => ({ ...m, media_url: mediaUrl(media_path) }));
    return {
        messages,
        has_more: hasMore,
        next_before: hasMore ? messages[messages.length - 1].message_at : null,
    };
}

/**
 * Deletes this service's stored copy of a chat: messages, media files, the chat,
 * its labels and the contact. Nothing changes on WhatsApp. For data retention.
 */
export async function deleteStoredChat(session: WaSessionRow, chat: string) {
    const jid = toJid(chat);
    const files = await connection("wa_messages")
        .where({ session_id: session.id, chat_jid: jid })
        .whereNotNull("media_path")
        .pluck("media_path");
    const result = await connection.transaction(async (trx) => {
        const messages = await trx("wa_messages")
            .where({ session_id: session.id, chat_jid: jid })
            .del();
        await trx("wa_chats").where({ session_id: session.id, jid }).del();
        await trx("wa_chat_labels")
            .where({ chat_jid: jid })
            .whereIn("label_id", trx("wa_labels").where({ session_id: session.id }).select("id"))
            .del();
        const contacts = await trx("wa_contacts").where({ session_id: session.id, jid }).del();
        return { messages, contacts };
    });
    return { jid, ...result, media_files: await deleteMediaFiles(files) };
}
