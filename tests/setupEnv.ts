// Runs before every test file (jest setupFiles): gives config/options.ts the
// keys it requires, so modules can be imported without a .env file.
import { generateKeyPairSync, randomBytes } from "crypto";
import os from "os";
import path from "path";

const passphrase = "test-passphrase";
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase },
});

process.env.PUBLIC_KEY = publicKey;
// Only tests use the private key, to mint staff tokens.
process.env.TEST_PRIVATE_KEY = privateKey;
process.env.TEST_JWT_PASSPHRASE = passphrase;
process.env.RESPONSE_ENCRYPTION_KEY = randomBytes(16).toString("hex"); // 32 chars
process.env.WHATSAPP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.INTERNAL_API_KEY = "test-internal-key";
process.env.WHATSAPP_MEDIA_DIR = path.join(os.tmpdir(), `fin_whatsapp_test_media_${process.pid}`);
process.env.ENVIRONMENT = "TESTING";
process.env.LOGGER_LEVEL = "error";
