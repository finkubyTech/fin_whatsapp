// The one module that loads Baileys at runtime. Baileys 7 is an ES module;
// Node 24 loads it from this CommonJS build with require(). Tests replace this
// module (jest can't load ES modules the same way), so everything else imports
// Baileys values from here and only types from the package itself.
import makeWASocket, {
    Browsers,
    BufferJSON,
    DisconnectReason,
    downloadMediaMessage,
    fetchLatestBaileysVersion,
    initAuthCreds,
    makeCacheableSignalKeyStore,
    proto,
} from "@whiskeysockets/baileys";

export {
    makeWASocket,
    Browsers,
    BufferJSON,
    DisconnectReason,
    downloadMediaMessage,
    fetchLatestBaileysVersion,
    initAuthCreds,
    makeCacheableSignalKeyStore,
    proto,
};
