jest.mock("../src/utils/dbUtil", () => ({ __esModule: true, default: {} }));
jest.mock("../src/whatsapp/baileys", () => require("./support/baileysMock"));

import { bareJid, chatTypeOf, isStoredChat, maskJid, phoneOf, toJid } from "../src/helpers/jid";
import {
    classifyMessage,
    previewOf,
    timestampOf,
    unwrapMessage,
} from "../src/helpers/messageParse";
import { decryptText, encryptText } from "../src/helpers/crypto";
import { checkUrl, isPrivateOrReservedIp } from "../src/helpers/safeFetch";
import { canAutoReply, OPT_OUT_PATTERN, ruleMatches } from "../src/whatsapp/automations";
import { throttle } from "../src/whatsapp/throttle";
import type { WaSessionSettings } from "../src/types";

describe("jid", () => {
    it.each([
        ["9876543210", "919876543210@s.whatsapp.net"],
        ["+91 98765 43210", "919876543210@s.whatsapp.net"],
        ["09876543210", "919876543210@s.whatsapp.net"],
        ["447911123456", "447911123456@s.whatsapp.net"],
        ["919876543210:12@s.whatsapp.net", "919876543210@s.whatsapp.net"],
        ["919876543210@c.us", "919876543210@s.whatsapp.net"],
        ["120363000000000000@g.us", "120363000000000000@g.us"],
        ["123456789012345@lid", "123456789012345@lid"],
    ])("toJid(%s) -> %s", (input, jid) => {
        expect(toJid(input)).toBe(jid);
    });

    it("rejects what can't be a recipient", () => {
        for (const bad of ["12345", "abc", "status@broadcast", "x@newsletter", ""]) {
            expect(() => toJid(bad)).toThrow();
        }
    });

    it("classifies chats and keeps only people and groups", () => {
        expect(chatTypeOf("1@g.us")).toBe("GROUP");
        expect(chatTypeOf("1@lid")).toBe("PERSONAL");
        expect(chatTypeOf("status@broadcast")).toBe("STATUS");
        expect(isStoredChat("status@broadcast")).toBe(false);
        expect(isStoredChat("x@newsletter")).toBe(false);
        expect(isStoredChat("919876543210@s.whatsapp.net")).toBe(true);
    });

    it("reads phone numbers and masks them for logs", () => {
        expect(phoneOf("919876543210:3@s.whatsapp.net")).toBe("919876543210");
        expect(phoneOf("1@g.us")).toBe("");
        expect(bareJid("91:4@s.whatsapp.net")).toBe("91@s.whatsapp.net");
        expect(maskJid("919876543210@s.whatsapp.net")).toBe("91XXXXXX3210");
        expect(maskJid("12345@lid")).toBe("XXXX");
    });
});

describe("message parsing", () => {
    it("reads text, captions, documents and replies", () => {
        const text = classifyMessage({ conversation: "hello" });
        expect(text).toMatchObject({ kind: "content", content: { type: "TEXT", text: "hello" } });

        const reply = classifyMessage({
            extendedTextMessage: {
                text: "yes",
                contextInfo: {
                    stanzaId: "Q1",
                    participant: "9@s.whatsapp.net",
                    quotedMessage: { conversation: "ok?" },
                    mentionedJid: ["8@s.whatsapp.net"],
                },
            },
        });
        expect(reply).toMatchObject({
            kind: "content",
            content: {
                text: "yes",
                quotedKeyId: "Q1",
                quoted: { keyId: "Q1", type: "TEXT", text: "ok?" },
                mentions: ["8@s.whatsapp.net"],
            },
        });

        const doc = classifyMessage({
            documentWithCaptionMessage: {
                message: {
                    documentMessage: {
                        fileName: "payslip.pdf",
                        caption: "March",
                        mimetype: "application/pdf",
                    },
                },
            },
        });
        expect(doc).toMatchObject({
            kind: "content",
            content: {
                type: "DOCUMENT",
                text: "March",
                fileName: "payslip.pdf",
                mime: "application/pdf",
                mediaField: "documentMessage",
            },
        });
    });

    it("unwraps disappearing and view-once messages", () => {
        const wrapped = {
            ephemeralMessage: {
                message: { viewOnceMessageV2: { message: { imageMessage: { caption: "pan" } } } },
            },
        };
        expect(unwrapMessage(wrapped)).toEqual({ imageMessage: { caption: "pan" } });
        expect(classifyMessage(wrapped)).toMatchObject({
            kind: "content",
            content: { type: "IMAGE", text: "pan" },
        });
    });

    it("spots deletions, edits and technical messages", () => {
        expect(classifyMessage({ protocolMessage: { type: 0, key: { id: "K1" } } })).toEqual({
            kind: "revoke",
            targetKeyId: "K1",
        });
        expect(
            classifyMessage({
                protocolMessage: {
                    type: 14,
                    key: { id: "K2" },
                    editedMessage: { conversation: "fixed" },
                },
            })
        ).toEqual({ kind: "edit", targetKeyId: "K2", text: "fixed" });
        expect(
            classifyMessage({ senderKeyDistributionMessage: {}, messageContextInfo: {} })
        ).toEqual({ kind: "ignore" });
        expect(classifyMessage({ reactionMessage: { text: "👍" } })).toEqual({ kind: "ignore" });
        expect(classifyMessage(null)).toEqual({ kind: "ignore" });
    });

    it("previews and timestamps", () => {
        const image = classifyMessage({ imageMessage: {} });
        expect(image.kind === "content" && previewOf(image.content)).toBe("📷 Photo");
        expect(timestampOf(1_700_000_000).toISOString()).toBe("2023-11-14T22:13:20.000Z");
        expect(timestampOf("1700000000").getTime()).toBe(1_700_000_000_000);
        expect(timestampOf({ low: 1_700_000_000, high: 0 }).getTime()).toBe(1_700_000_000_000);
        expect(timestampOf({ low: -1, high: 0 }).getTime()).toBe(4_294_967_295_000); // unsigned
    });
});

describe("at-rest encryption", () => {
    it("round-trips and refuses a tampered value", () => {
        const stored = encryptText("secret login");
        expect(stored.startsWith("v1:")).toBe(true);
        expect(stored).not.toContain("secret");
        expect(decryptText(stored)).toBe("secret login");
        expect(encryptText("same")).not.toBe(encryptText("same")); // fresh IV each time
        const [, iv, tag, body] = stored.split(":");
        const flipped = Buffer.from(body, "base64");
        flipped[0] ^= 1;
        expect(() => decryptText(`v1:${iv}:${tag}:${flipped.toString("base64")}`)).toThrow();
    });
});

describe("outbound URL checks", () => {
    it("knows internal addresses", () => {
        for (const ip of [
            "127.0.0.1",
            "10.1.2.3",
            "172.20.0.5",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "fd00::1",
            "::ffff:127.0.0.1",
        ]) {
            expect(isPrivateOrReservedIp(ip)).toBe(true);
        }
        for (const ip of ["8.8.8.8", "142.250.183.14", "2606:4700::1111"]) {
            expect(isPrivateOrReservedIp(ip)).toBe(false);
        }
    });

    it("allows only https to public addresses, unless the host is trusted", async () => {
        await expect(checkUrl("http://8.8.8.8/x")).rejects.toThrow("Only https");
        await expect(checkUrl("https://127.0.0.1/x")).rejects.toThrow("internal address");
        await expect(checkUrl("https://169.254.169.254/latest/meta-data")).rejects.toThrow(
            "internal address"
        );
        await expect(checkUrl("https://localhost/x")).rejects.toThrow("localhost");
        await expect(checkUrl("https://user:pass@8.8.8.8/x")).rejects.toThrow("credentials");
        await expect(checkUrl("https://8.8.8.8/x")).resolves.toMatchObject({
            ips: ["8.8.8.8"],
            trusted: false,
        });
        await expect(
            checkUrl("http://127.0.0.1:5200/hook", { trustedHosts: ["127.0.0.1"] })
        ).resolves.toMatchObject({ trusted: true });
    });
});

const settings = (patch: Partial<WaSessionSettings> = {}): WaSessionSettings => ({
    session_id: "s",
    welcome_message: null,
    auto_reply_enabled: true,
    auto_reply_mode: "ALL",
    auto_reply_jids: [],
    throttle_enabled: true,
    throttle_limit: 2,
    throttle_window_seconds: 1,
    throttle_delay_min_ms: 50,
    throttle_delay_max_ms: 50,
    auto_read: false,
    always_online: false,
    ...patch,
});

describe("automations", () => {
    it("recognises opt-out messages on their own", () => {
        for (const yes of ["STOP", " stop ", "Unsubscribe.", "opt out", "OPT-OUT!"])
            expect(OPT_OUT_PATTERN.test(yes)).toBe(true);
        for (const no of [
            "please stop calling",
            "don't stop",
            "stopping by",
            "unsubscribe me from emails",
        ]) {
            expect(OPT_OUT_PATTERN.test(no)).toBe(false);
        }
    });

    it("picks who gets auto-replies", () => {
        const sender = "919876543210@s.whatsapp.net";
        expect(canAutoReply(settings(), sender)).toBe(true);
        expect(canAutoReply(settings({ auto_reply_enabled: false }), sender)).toBe(false);
        expect(
            canAutoReply(
                settings({ auto_reply_mode: "SPECIFIC", auto_reply_jids: ["9876543210"] }),
                sender
            )
        ).toBe(true);
        expect(
            canAutoReply(
                settings({ auto_reply_mode: "SPECIFIC", auto_reply_jids: ["111"] }),
                sender
            )
        ).toBe(false);
        expect(
            canAutoReply(
                settings({ auto_reply_mode: "BLACKLIST", auto_reply_jids: ["9876543210"] }),
                sender
            )
        ).toBe(false);
        expect(
            canAutoReply(settings({ auto_reply_mode: "BLACKLIST", auto_reply_jids: [] }), sender)
        ).toBe(true);
    });

    it("matches rules by type and context", () => {
        const rule = (match_type: any, keyword: string, trigger_type: any = "ALL") => ({
            match_type,
            keyword,
            trigger_type,
        });
        expect(ruleMatches(rule("EXACT", "Hi"), " hi ", false)).toBe(true);
        expect(ruleMatches(rule("EXACT", "hi"), "hi there", false)).toBe(false);
        expect(ruleMatches(rule("CONTAINS", "loan"), "I need a LOAN", false)).toBe(true);
        expect(ruleMatches(rule("REGEX", "^(hi|hello)\\b"), "Hello team", false)).toBe(true);
        expect(ruleMatches(rule("REGEX", "("), "anything", false)).toBe(false); // bad pattern never matches
        expect(ruleMatches(rule("CONTAINS", "loan", "PRIVATE"), "loan", true)).toBe(false);
        expect(ruleMatches(rule("CONTAINS", "loan", "GROUP"), "loan", true)).toBe(true);
    });
});

describe("send throttle", () => {
    it("sends in order and holds back past the limit", async () => {
        const order: number[] = [];
        const started = Date.now();
        await Promise.all(
            [1, 2, 3, 4].map((n) => throttle("t1", settings(), async () => order.push(n)))
        );
        expect(order).toEqual([1, 2, 3, 4]);
        // 2 per second: the 3rd and 4th had to wait for the window to move.
        expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    });

    it("sends straight away when switched off", async () => {
        const started = Date.now();
        await Promise.all(
            [1, 2, 3, 4, 5].map(() =>
                throttle("t2", settings({ throttle_enabled: false }), async () => 1)
            )
        );
        expect(Date.now() - started).toBeLessThan(200);
    });
});
