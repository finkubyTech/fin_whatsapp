// Stands in for src/whatsapp/baileys in tests: jest can't load Baileys (an ES
// module). BufferJSON behaves like Baileys' (Buffers survive a JSON round trip).
export const BufferJSON = {
    replacer: (_key: string, value: any) => {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === "Buffer") {
            return { type: "Buffer", data: Buffer.from(value?.data || value).toString("base64") };
        }
        return value;
    },
    reviver: (_key: string, value: any) => {
        if (
            typeof value === "object" &&
            value &&
            value.type === "Buffer" &&
            typeof value.data === "string"
        ) {
            return Buffer.from(value.data, "base64");
        }
        return value;
    },
};

export const initAuthCreds = () => ({ registrationId: 1, noiseKey: { private: Buffer.from("k") } });
export const proto = {
    Message: {
        AppStateSyncKeyData: { fromObject: (value: any) => ({ ...value, fromObject: true }) },
    },
};
export const Browsers = { ubuntu: (browser: string) => ["Ubuntu", browser, "22.04"] };
export const DisconnectReason = {
    loggedOut: 401,
    forbidden: 403,
    connectionReplaced: 440,
    badSession: 500,
    restartRequired: 515,
};
export const makeWASocket = jest.fn();
export const makeCacheableSignalKeyStore = jest.fn((keys: unknown) => keys);
export const fetchLatestBaileysVersion = jest.fn(async () => ({ version: [2, 3000, 1] }));
export const downloadMediaMessage = jest.fn(async () => Buffer.from("downloaded"));
