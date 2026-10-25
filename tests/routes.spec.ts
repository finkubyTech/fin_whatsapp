// Who may call what: staff tokens, x-internal-key and the whatsapp_* permissions,
// with the database stubbed (every query's .first() answers mockFirst).
const mockFirst = jest.fn();
jest.mock("../src/utils/dbUtil", () => {
    const chain: any = new Proxy(function () {}, {
        get: (_target, prop) =>
            prop === "then"
                ? undefined
                : prop === "first"
                  ? (...args: unknown[]) => mockFirst(...args)
                  : chain,
        apply: () => chain,
    });
    return { __esModule: true, default: chain };
});
jest.mock("../src/whatsapp/baileys", () => require("./support/baileysMock"));

import jwt from "jsonwebtoken";
import request from "supertest";
import { app } from "../src/app";
import { decryptAsync } from "../src/encryption/encryption";

const BASE = "/api/whatsapp";
const SESSION_ROW = {
    id: "6a1f8f5e-3c55-4f43-9a7e-2f1d1d9e0c01",
    session_key: "sales",
    name: "Sales",
    status: "STOPPED",
};

const token = (claims: Record<string, unknown>, options: jwt.SignOptions = { expiresIn: "5m" }) =>
    jwt.sign(
        claims,
        { key: process.env.TEST_PRIVATE_KEY!, passphrase: process.env.TEST_JWT_PASSPHRASE! },
        { algorithm: "RS256", ...options }
    );

const staff = (permissions: string[], role = "EMPLOYEE") =>
    `Bearer ${token({ staff_id: "staff-1", session_key: "login-1", role, permissions })}`;

const plain = { "x-api-encrypt": "false" };

beforeEach(() => {
    mockFirst.mockReset();
    // The login session is ACTIVE and the number exists.
    mockFirst.mockResolvedValue(SESSION_ROW);
});

describe("health", () => {
    it("answers without a token", async () => {
        const res = await request(app).get(`${BASE}/health`);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("OK");
    });
});

describe("authentication", () => {
    it("needs a token or the internal key", async () => {
        const res = await request(app).get(`${BASE}/sessions`);
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ error: true, status: 401 });
    });

    it("refuses a wrong internal key", async () => {
        const res = await request(app)
            .get(`${BASE}/sessions`)
            .set("x-internal-key", "test-internal-kez");
        expect(res.status).toBe(401);
    });

    it("refuses customer tokens", async () => {
        const res = await request(app)
            .get(`${BASE}/sessions`)
            .set("Authorization", `Bearer ${token({ user_id: "u1", session_key: "s" })}`);
        expect(res.status).toBe(403);
    });

    it("refuses forged and expired tokens", async () => {
        const forged = jwt.sign({ staff_id: "x", session_key: "y" }, "not-the-key", {
            algorithm: "HS256",
        });
        expect(
            (await request(app).get(`${BASE}/sessions`).set("Authorization", `Bearer ${forged}`))
                .status
        ).toBe(401);

        const expired = token(
            { staff_id: "x", session_key: "y", iat: Math.floor(Date.now() / 1000) - 120 },
            { expiresIn: 60 }
        );
        const res = await request(app)
            .get(`${BASE}/sessions`)
            .set("Authorization", `Bearer ${expired}`);
        expect(res.status).toBe(401);
        expect(res.body.message).toMatch(/expired/i);
    });

    it("refuses a staff token whose login was ended", async () => {
        mockFirst.mockResolvedValueOnce(undefined); // no ACTIVE session
        const res = await request(app)
            .get(`${BASE}/sessions/sales`)
            .set("Authorization", staff(["whatsapp_admin"]));
        expect(res.status).toBe(401);
        expect(res.body.message).toMatch(/login again/i);
    });
});

describe("permissions", () => {
    const sendText = (auth: Record<string, string>, body: object) =>
        request(app)
            .post(`${BASE}/sessions/sales/messages/text`)
            .set({ ...plain, ...auth })
            .send(body);

    it("read-only staff can't send or administer", async () => {
        expect((await sendText({ Authorization: staff(["whatsapp_read"]) }, {})).status).toBe(403);
        const res = await request(app)
            .post(`${BASE}/sessions`)
            .set({ ...plain, Authorization: staff(["whatsapp_read"]) })
            .send({});
        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/whatsapp_admin/);
    });

    it("staff without any WhatsApp permission can't read", async () => {
        const res = await request(app)
            .get(`${BASE}/sessions/sales`)
            .set({ ...plain, Authorization: staff(["crm_read"]) });
        expect(res.status).toBe(403);
    });

    it("send, admin, SUPER_ADMIN and service calls get past the check (to validation)", async () => {
        for (const auth of <Record<string, string>[]>[
            { Authorization: staff(["whatsapp_send"]) },
            { Authorization: staff(["whatsapp_admin"]) },
            { Authorization: staff([], "SUPER_ADMIN") },
            { "x-internal-key": "test-internal-key" },
        ]) {
            const res = await sendText(auth, { to: "9876543210" });
            expect(res.status).toBe(400);
        }
    });

    it("a number that isn't connected is a 409, not a hang", async () => {
        const res = await sendText(
            { "x-internal-key": "test-internal-key" },
            { to: "9876543210", text: "hello" }
        );
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(/not connected/);
    });

    it("an unknown number is a 404", async () => {
        mockFirst.mockResolvedValueOnce(undefined); // wa_sessions lookup (internal call: no login check)
        const res = await sendText(
            { "x-internal-key": "test-internal-key" },
            { to: "9876543210", text: "hello" }
        );
        expect(res.status).toBe(404);
    });
});

describe("responses", () => {
    it("encrypt data unless the caller opts out", async () => {
        const auth = { Authorization: staff(["whatsapp_read"]) };
        const encrypted = await request(app).get(`${BASE}/sessions/sales`).set(auth);
        expect(encrypted.status).toBe(200);
        expect(typeof encrypted.body.data).toBe("string");
        expect(await decryptAsync(encrypted.body.data)).toMatchObject({
            session_key: "sales",
            has_qr: false,
        });

        const open = await request(app)
            .get(`${BASE}/sessions/sales`)
            .set({ ...auth, ...plain });
        expect(open.body.data).toMatchObject({ session_key: "sales" });
    });

    it("media needs a token and only serves names this service wrote", async () => {
        expect((await request(app).get(`${BASE}/media/sales-ABC.jpg`)).status).toBe(401);
        const auth = { Authorization: staff(["whatsapp_read"]) };
        expect(
            (await request(app).get(`${BASE}/media/..%2F..%2Fetc%2Fpasswd`).set(auth)).status
        ).toBe(404);
        expect((await request(app).get(`${BASE}/media/sales-MISSING.jpg`).set(auth)).status).toBe(
            404
        );
    });

    it("unknown routes are a 404 in the envelope", async () => {
        const res = await request(app).get(`${BASE}/nope`);
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ error: true, status: 404 });
    });
});
