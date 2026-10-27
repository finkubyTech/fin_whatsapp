// The store, automations, webhooks and jobs against a real Postgres (the
// fin_migrations schema): set TEST_DATABASE_URL to run it, e.g.
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/fin_test npx jest gateway.db
// Skipped without it. WhatsApp itself is a fake socket that records what it is
// asked to send. Creates its own number (wa_sessions row) and deletes it after.
import http from "http";
import type { AddressInfo } from "net";

jest.mock("../src/utils/dbUtil", () => {
    const knex = require("knex");
    return {
        __esModule: true,
        default: knex({
            client: "pg",
            connection: process.env.TEST_DATABASE_URL || "postgres://unused",
        }),
    };
});
jest.mock("../src/whatsapp/baileys", () => require("./support/baileysMock"));

import db from "../src/utils/dbUtil";
import { config } from "../config/options";
import { encryptText } from "../src/helpers/crypto";
import { signatureOf } from "../src/whatsapp/webhooks";
import { setLiveSocket } from "../src/whatsapp/registry";
import { invalidateSettings } from "../src/whatsapp/sessions";
import { invalidateAutoReplies } from "../src/whatsapp/automations";
import {
    applyStatusUpdates,
    ingestHistory,
    ingestLive,
    IngestContext,
} from "../src/whatsapp/ingest";
import { send } from "../src/whatsapp/sender";
import { clearStoredLogin, hasStoredLogin, useDbAuthState } from "../src/whatsapp/authState";
import { runDueSchedules } from "../src/jobs/scheduler";
import { runBroadcasts } from "../src/jobs/broadcaster";
import { deleteStoredChat, listChats, listMessages } from "../src/services/chatService";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const SESSION_KEY = `test-${Date.now().toString(36)}`;
const OWN = "919000000001@s.whatsapp.net";
const CUSTOMER = "919876543210@s.whatsapp.net";
const SECRET = "hook-secret";

let session: any;
let ctx: IngestContext;
let clock = 1_800_000_000;
const sent: { jid: string; content: any; options: any }[] = [];
const hookCalls: { event: string; signature: string; body: any; raw: string }[] = [];
let hookServer: http.Server;

const fakeSock: any = {
    sendMessage: jest.fn(async (jid: string, content: any, options: any) => {
        sent.push({ jid, content, options });
        return { key: { id: options.messageId, remoteJid: jid, fromMe: true } };
    }),
    readMessages: jest.fn(async () => undefined),
    signalRepository: { lidMapping: { getPNForLID: jest.fn(async () => null) } },
};

const incoming = (text: string, extra: Record<string, any> = {}) => ({
    key: { id: `IN${++clock}`, remoteJid: CUSTOMER, fromMe: false, ...extra.key },
    pushName: "Ravi",
    messageTimestamp: clock,
    message: { conversation: text },
    ...extra.rest,
});

const waitFor = async (check: () => Promise<boolean> | boolean, ms = 8000) => {
    const until = Date.now() + ms;
    while (!(await check())) {
        if (Date.now() > until) throw new Error("timed out waiting");
        await new Promise((r) => setTimeout(r, 50));
    }
};
const eventsOf = (name: string) => hookCalls.filter((c) => c.event === name);
const messageRow = (keyId: string) =>
    db("wa_messages").where({ session_id: session.id, key_id: keyId }).first();
const chatRow = (jid = CUSTOMER) => db("wa_chats").where({ session_id: session.id, jid }).first();

describeDb("WhatsApp gateway (Postgres)", () => {
    beforeAll(async () => {
        hookServer = http.createServer((req, res) => {
            let raw = "";
            req.on("data", (chunk) => (raw += chunk));
            req.on("end", () => {
                hookCalls.push({
                    event: String(req.headers["x-webhook-event"]),
                    signature: String(req.headers["x-webhook-signature"]),
                    body: JSON.parse(raw),
                    raw,
                });
                res.end("ok");
            });
        });
        await new Promise<void>((resolve) => hookServer.listen(0, "127.0.0.1", resolve));
        config.whatsapp.webhookAllowedHosts.push("127.0.0.1");

        [session] = await db("wa_sessions")
            .insert({ session_key: SESSION_KEY, name: "Test", status: "CONNECTED" })
            .returning("*");
        await db("wa_session_settings").insert({
            session_id: session.id,
            welcome_message: "Welcome to Finkuby",
            throttle_enabled: false,
        });
        await db("wa_webhooks").insert({
            session_id: session.id,
            name: "test",
            url: `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/hook`,
            secret: encryptText(SECRET),
        });
        ctx = { session, sock: fakeSock, ownJid: () => OWN };
        setLiveSocket(session.id, fakeSock);
    });

    beforeEach(() => {
        sent.length = 0;
        hookCalls.length = 0;
    });

    afterAll(async () => {
        setLiveSocket(session.id, null);
        await db("wa_sessions").where({ id: session.id }).del(); // cascades to every wa_* row of the number
        await new Promise((resolve) => hookServer.close(resolve));
        await db.destroy();
    });

    describe("incoming messages", () => {
        it("stores a first message, counts it unread, welcomes the customer and posts the webhook", async () => {
            const message = incoming("hi");
            await ingestLive(ctx, [message as any], "notify");

            expect(await messageRow(message.key.id)).toMatchObject({
                chat_jid: CUSTOMER,
                sender_jid: CUSTOMER,
                from_me: false,
                type: "TEXT",
                content: "hi",
                status: "DELIVERED",
                push_name: "Ravi",
            });
            expect(await chatRow()).toMatchObject({
                unread_count: 1,
                last_message_preview: "hi",
                last_message_from_me: false,
            });
            expect(
                await db("wa_contacts").where({ session_id: session.id, jid: CUSTOMER }).first()
            ).toMatchObject({ notify: "Ravi" });
            expect(sent).toEqual([
                {
                    jid: CUSTOMER,
                    content: { text: "Welcome to Finkuby" },
                    options: expect.any(Object),
                },
            ]);

            await waitFor(() => eventsOf("message.received").length === 1);
            const [hook] = eventsOf("message.received");
            expect(hook.signature).toBe(signatureOf(SECRET, hook.raw));
            expect(hook.body).toMatchObject({
                event: "message.received",
                sessionId: SESSION_KEY,
                data: {
                    key: { id: message.key.id, remoteJid: CUSTOMER, fromMe: false },
                    from: CUSTOMER,
                    receiver: OWN,
                    content: "hi",
                },
            });
            await waitFor(
                async () => !!(await db("wa_webhook_logs").where({ status: "SUCCESS" }).first())
            );
        });

        it("ignores the same event twice", async () => {
            const message = incoming("again");
            await ingestLive(ctx, [message as any], "notify");
            await ingestLive(ctx, [message as any], "notify");
            expect(
                await db("wa_messages")
                    .where({ session_id: session.id, key_id: message.key.id })
                    .count({ n: "*" })
            ).toEqual([{ n: "1" }]);
            expect((await chatRow()).unread_count).toBe(2);
            expect(sent).toHaveLength(0); // not a new chat any more: no second welcome
        });

        it("answers with the matching auto-reply, as a reply", async () => {
            await db("wa_auto_replies").insert([
                {
                    session_id: session.id,
                    keyword: "loan",
                    match_type: "CONTAINS",
                    response: "Our loan team will call you",
                    priority: 1,
                },
                {
                    session_id: session.id,
                    keyword: "home loan",
                    match_type: "CONTAINS",
                    response: "Home loans: see finkuby.com",
                    priority: 5,
                },
            ]);
            invalidateAutoReplies(session.id);
            const message = incoming("I want a HOME LOAN");
            await ingestLive(ctx, [message as any], "notify");
            expect(sent).toHaveLength(1);
            expect(sent[0].content).toEqual({ text: "Home loans: see finkuby.com" });
            expect(sent[0].options.quoted.key.id).toBe(message.key.id);
        });

        it("STOP opts the customer out: the matching rule's acknowledgement once, nothing sent later", async () => {
            await db("wa_auto_replies").insert({
                session_id: session.id,
                keyword: "stop",
                match_type: "EXACT",
                response: "Understood, we've noted your request.",
            });
            invalidateAutoReplies(session.id);
            await ingestLive(ctx, [incoming("STOP") as any], "notify");
            expect(sent.map((s) => s.content)).toEqual([
                { text: "Understood, we've noted your request." },
            ]);
            sent.length = 0;
            await ingestLive(ctx, [incoming("stop") as any], "notify");
            expect(sent).toHaveLength(0); // already opted out: no second acknowledgement
            expect(
                await db("wa_opt_outs")
                    .where({ session_id: session.id, jid: CUSTOMER })
                    .whereNull("removed_at")
                    .first()
            ).toMatchObject({
                source: "KEYWORD",
                message: "STOP",
            });
            await waitFor(() => eventsOf("opt_out").length === 1);

            await ingestLive(ctx, [incoming("loan please") as any], "notify");
            expect(sent).toHaveLength(0);
            await expect(send(session, CUSTOMER, { kind: "text", text: "offer" })).rejects.toThrow(
                /opted out/
            );

            await db("wa_opt_outs")
                .where({ session_id: session.id, jid: CUSTOMER })
                .update({ removed_at: new Date(), removed_reason: "test" });
        });

        it("stores our own message from the echo and clears unread", async () => {
            const result = await send(session, CUSTOMER, {
                kind: "text",
                text: "Sure, calling you now",
            });
            expect(sent[0].options.messageId).toBe(result.key_id);
            expect(result.key_id).toMatch(/^3EB0[0-9A-F]{20}$/);

            const echo = {
                key: { id: result.key_id, remoteJid: CUSTOMER, fromMe: true },
                messageTimestamp: ++clock,
                message: { conversation: "Sure, calling you now" },
            };
            await ingestLive(ctx, [echo as any], "append");
            expect(await messageRow(result.key_id)).toMatchObject({
                from_me: true,
                sender_jid: OWN,
                status: "SENT",
                push_name: null,
            });
            expect(await chatRow()).toMatchObject({ unread_count: 0, last_message_from_me: true });
            await waitFor(() => eventsOf("message.sent").length === 1);
            expect(eventsOf("message.sent")[0].body.data).toMatchObject({
                from: OWN,
                receiver: CUSTOMER,
                sender: "ME",
            });
        });

        it("moves message status forward only, and marks deletions", async () => {
            const message = {
                key: { id: `OUT${++clock}`, remoteJid: CUSTOMER, fromMe: true },
                messageTimestamp: clock,
                message: { conversation: "status" },
            };
            await ingestLive(ctx, [message as any], "append");
            const update = (status: number) =>
                applyStatusUpdates(ctx, [{ key: message.key, update: { status } }]);

            await update(3);
            expect((await messageRow(message.key.id)).status).toBe("DELIVERED");
            await update(2); // a late server ack doesn't move it back
            expect((await messageRow(message.key.id)).status).toBe("DELIVERED");
            await update(4);
            expect((await messageRow(message.key.id)).status).toBe("READ");

            const revoke = {
                key: { id: `RV${++clock}`, remoteJid: CUSTOMER, fromMe: true },
                messageTimestamp: clock,
                message: { protocolMessage: { type: 0, key: { id: message.key.id } } },
            };
            await ingestLive(ctx, [revoke as any], "notify");
            expect((await messageRow(message.key.id)).status).toBe("DELETED");
            await update(4); // final
            expect((await messageRow(message.key.id)).status).toBe("DELETED");
            await waitFor(() => eventsOf("message.deleted").length === 1);
        });

        it("files @lid chats under the phone number when WhatsApp gives it", async () => {
            const lid = "123456789012345@lid";
            const phone = "919811111111@s.whatsapp.net";
            const message = incoming("hello from lid", {
                key: { remoteJid: lid, remoteJidAlt: phone },
            });
            await ingestLive(ctx, [message as any], "notify");
            expect(await messageRow(message.key.id)).toMatchObject({
                chat_jid: phone,
                sender_jid: phone,
            });
            expect(
                await db("wa_contacts").where({ session_id: session.id, jid: phone }).first()
            ).toMatchObject({ lid });
        });

        it("history sync stores in bulk without unread counts, webhooks or replies", async () => {
            const other = "919822222222@s.whatsapp.net";
            const old = clock - 10_000;
            const history = [
                {
                    key: { id: `H1-${clock}`, remoteJid: other, fromMe: false },
                    messageTimestamp: old,
                    message: { conversation: "old one" },
                },
                {
                    key: { id: `H2-${clock}`, remoteJid: other, fromMe: true },
                    messageTimestamp: old + 5,
                    message: { conversation: "old reply" },
                },
                {
                    key: { id: `H3-${clock}`, remoteJid: "status@broadcast", fromMe: false },
                    messageTimestamp: old,
                    message: { conversation: "status" },
                },
            ];
            await ingestHistory(ctx, history as any);
            expect(await chatRow(other)).toMatchObject({
                unread_count: 0,
                last_message_preview: "old reply",
                last_message_from_me: true,
            });
            expect(
                await db("wa_messages")
                    .where({ session_id: session.id, chat_jid: other })
                    .count({ n: "*" })
            ).toEqual([{ n: "2" }]);
            expect(await messageRow(`H3-${clock}`)).toBeUndefined();
            expect(sent).toHaveLength(0);
            await new Promise((r) => setTimeout(r, 200));
            expect(hookCalls).toHaveLength(0);
        });
    });

    describe("chats", () => {
        it("lists chats newest first and pages messages back", async () => {
            const chats = await listChats(session, {});
            expect(chats.data[0].jid).toBe("919811111111@s.whatsapp.net");
            expect(chats.data.map((c: any) => c.jid)).toContain(CUSTOMER);

            const first = await listMessages(session, "9876543210", { limit: 2 });
            expect(first.messages).toHaveLength(2);
            expect(first.has_more).toBe(true);
            const next = await listMessages(session, "9876543210", {
                limit: 200,
                before: first.next_before,
            });
            expect(
                next.messages.every(
                    (m: any) => new Date(m.message_at) < new Date(first.next_before)
                )
            ).toBe(true);
        });

        it("deletes the stored copy of a chat", async () => {
            const result = await deleteStoredChat(session, "919822222222");
            expect(result).toMatchObject({ messages: 2 });
            expect(await chatRow("919822222222@s.whatsapp.net")).toBeUndefined();
        });
    });

    describe("login keys", () => {
        it("round-trip encrypted, in batches", async () => {
            const { state, saveCreds } = await useDbAuthState(session.id);
            await saveCreds();
            expect(await hasStoredLogin(session.id)).toBe(true);

            await state.keys.set({
                "pre-key": {
                    "1": { public: Buffer.from("pub-1"), private: Buffer.from("priv-1") } as any,
                    "2": { public: Buffer.from("pub-2") } as any,
                },
            });
            const stored = await db("wa_auth_states")
                .where({ session_id: session.id, key: "pre-key-1" })
                .first("value");
            expect(stored.value.startsWith("v1:")).toBe(true);
            expect(stored.value).not.toContain("priv-1");

            const got = await state.keys.get("pre-key", ["1", "2", "3"]);
            expect(Buffer.from((got["1"] as any).private).toString()).toBe("priv-1");
            expect(Object.keys(got).sort()).toEqual(["1", "2"]);

            await state.keys.set({ "pre-key": { "1": null as any } });
            expect(Object.keys(await state.keys.get("pre-key", ["1", "2"]))).toEqual(["2"]);

            await clearStoredLogin(session.id);
            expect(await hasStoredLogin(session.id)).toBe(false);
        });
    });

    describe("jobs", () => {
        it("sends each due scheduled message once, and moves a recurring one on", async () => {
            const due = new Date(Date.now() - 1000);
            const [once, daily] = await db("wa_scheduled_messages")
                .insert([
                    {
                        session_id: session.id,
                        jid: CUSTOMER,
                        content: "EMI due tomorrow",
                        send_at: due,
                    },
                    {
                        session_id: session.id,
                        jid: CUSTOMER,
                        content: "Good morning",
                        send_at: due,
                        cron_expression: "0 9 * * *",
                    },
                ])
                .returning("id");

            await Promise.all([runDueSchedules(), runDueSchedules()]);
            expect(sent.map((s) => s.content.text).sort()).toEqual([
                "EMI due tomorrow",
                "Good morning",
            ]);

            expect(await db("wa_scheduled_messages").where({ id: once.id }).first()).toMatchObject({
                status: "SENT",
                last_error: null,
            });
            const recurring = await db("wa_scheduled_messages").where({ id: daily.id }).first();
            expect(recurring.status).toBe("PENDING");
            expect(recurring.last_sent_at).not.toBeNull();
            expect(recurring.send_at.getTime()).toBeGreaterThan(Date.now());
            // 09:00 IST
            expect(recurring.send_at.toISOString()).toMatch(/T03:30:00\.000Z$/);
        });

        it("keeps a scheduled message while the number is offline", async () => {
            setLiveSocket(session.id, null);
            const [row] = await db("wa_scheduled_messages")
                .insert({
                    session_id: session.id,
                    jid: CUSTOMER,
                    content: "later",
                    send_at: new Date(Date.now() - 1000),
                })
                .returning("id");
            await runDueSchedules();
            expect((await db("wa_scheduled_messages").where({ id: row.id }).first()).status).toBe(
                "PENDING"
            );
            setLiveSocket(session.id, fakeSock);
            await runDueSchedules();
            expect((await db("wa_scheduled_messages").where({ id: row.id }).first()).status).toBe(
                "SENT"
            );
        });

        it("works through a broadcast from the database, skipping opted-out numbers", async () => {
            const optedOut = "919833333333@s.whatsapp.net";
            await db("wa_opt_outs").insert({
                session_id: session.id,
                jid: optedOut,
                source: "STAFF",
            });
            const [broadcast] = await db("wa_broadcasts")
                .insert({
                    session_id: session.id,
                    message: "Festive offer",
                    total: 3,
                    delay_min_ms: 1000,
                    delay_max_ms: 1000,
                })
                .returning("*");
            await db("wa_broadcast_recipients").insert(
                [CUSTOMER, optedOut, "919844444444@s.whatsapp.net"].map((jid) => ({
                    broadcast_id: broadcast.id,
                    jid,
                }))
            );

            await runBroadcasts();
            await runBroadcasts(); // already running: not started twice
            await waitFor(
                async () =>
                    (await db("wa_broadcasts").where({ id: broadcast.id }).first()).status ===
                    "COMPLETED"
            );

            expect(await db("wa_broadcasts").where({ id: broadcast.id }).first()).toMatchObject({
                sent: 2,
                skipped: 1,
                failed: 0,
            });
            expect(sent.map((s) => s.jid).sort()).toEqual([
                "919844444444@s.whatsapp.net",
                CUSTOMER,
            ]);
            expect(
                await db("wa_broadcast_recipients")
                    .where({ broadcast_id: broadcast.id, jid: optedOut })
                    .first()
            ).toMatchObject({
                status: "SKIPPED",
            });
        }, 15_000);
    });

    it("settings changes apply once the cache is dropped", async () => {
        await db("wa_session_settings")
            .where({ session_id: session.id })
            .update({ auto_reply_enabled: false, welcome_message: null });
        invalidateSettings(session.id);
        await ingestLive(
            ctx,
            [incoming("loan", { key: { remoteJid: "919855555555@s.whatsapp.net" } }) as any],
            "notify"
        );
        expect(sent).toHaveLength(0);
    });
});
