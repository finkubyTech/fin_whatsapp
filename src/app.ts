// Module Imports
import express from "express";
import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

// File Imports
import { config } from "../config/options";
import { options } from "../config/configOptions";
import connection from "./utils/dbUtil";
import { logger, requestInfo } from "./utils/logger";
import { correlationMiddleware } from "./utils/correlation";
import { errorHandler } from "./utils/errorHandler";
import { authProtected } from "./utils/jwt";
import { decryptionMiddleware, encryptionMiddleware } from "./encryption/encryption";
import { manager } from "./whatsapp/manager";
import { startJobs, stopJobs } from "./jobs";

// Controller Imports
import healthRouter from "./controllers/healthCheckController";
import sessionRouter from "./controllers/sessionController";
import messageRouter from "./controllers/messageController";
import chatRouter from "./controllers/chatController";
import contactGroupRouter from "./controllers/contactGroupController";
import automationRouter from "./controllers/automationController";
import mediaRouter from "./controllers/mediaController";

const routeURL: string = options.defaultRouteURL;

export const app: express.Express = express();

const tooMany = (message: string) => (req: Request, res: Response) =>
    res.status(429).json({ error: true, status: 429, message, data: {} });

// ---------------------------------------------------------------- middleware chain
app.use(
    cors({
        origin: config.corsOrigins,
        methods: "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
        allowedHeaders: ["Content-Type", "Authorization", "x-api-encrypt", "x-correlation-id"],
        exposedHeaders: ["x-correlation-id"],
        optionsSuccessStatus: 204,
    })
);
// JSON bodies; media uploads are multipart and parsed by multer on their route.
app.use(express.json({ limit: "1mb" }));

// Malformed JSON body -> 400 in the standard envelope.
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
        return res
            .status(400)
            .json({
                error: true,
                status: 400,
                message: "Invalid JSON format in request body",
                data: {},
            });
    }
    next(err);
});

// The nginx gateway is the one proxy in front: req.ip is the real client.
app.set("trust proxy", 1);
app.use(helmet());
app.use(
    rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 2000,
        standardHeaders: true,
        legacyHeaders: false,
        handler: tooMany("Too many requests from this IP, please try again later."),
    })
);
app.use(
    morgan(":remote-addr - :method :url HTTP/:http-version :status - :response-time ms", {
        stream: { write: (message: string) => logger.info(message.trim()) },
    })
);
app.use(correlationMiddleware);
app.use(decryptionMiddleware);
app.use(requestInfo);

// ---------------------------------------------------------------- routes
// Each router is followed by encryptionMiddleware (the response stage); see
// sendApiResponse for why exactly one route answers per request.
app.get(`${routeURL}/health`, (req: Request, res: Response) => {
    res.status(200).json({ status: "OK", timestamp: new Date() });
});
app.use(`${routeURL}/check`, healthRouter, encryptionMiddleware);

// Media files are streamed as they are (no envelope, no encryption), staff only.
app.use(`${routeURL}/media`, authProtected, mediaRouter);

// Staff (with whatsapp_* permissions) and other fin_ services (x-internal-key).
const sessions = `${routeURL}/sessions`;
app.use(sessions, authProtected);
for (const router of [
    sessionRouter,
    messageRouter,
    chatRouter,
    contactGroupRouter,
    automationRouter,
]) {
    app.use(sessions, router, encryptionMiddleware);
}

// Handle 404 Routes
app.use((req: Request, res: Response) => {
    res.status(404).json({ error: true, status: 404, message: "Route doesn't exists.", data: {} });
});

// Error Handler (must be the last middleware)
app.use(errorHandler);

if (require.main === module) {
    const server = app.listen(config.port, () => {
        logger.info(`${config.serviceName} listening on port ${config.port} (${config.env})`);
        if (config.whatsapp.autoStart) {
            manager
                .startAll()
                .catch((err) =>
                    logger.error(`[boot] reconnecting numbers failed: ${err?.message}`)
                );
        }
        startJobs();
    });

    // Docker stop / redeploy: close the WhatsApp sockets without logging out,
    // so the next container reconnects them.
    const shutdown = (signal: string) => {
        logger.info(`${signal}: shutting down`);
        stopJobs();
        manager.shutdownAll();
        server.close(() => {
            connection.destroy().finally(() => process.exit(0));
        });
        setTimeout(() => process.exit(0), 10_000).unref();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}

export default app;
