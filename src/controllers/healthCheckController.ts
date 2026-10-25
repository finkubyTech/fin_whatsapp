import { Router, Request, Response, NextFunction } from "express";
import { sendApiResponse, getOkResponse } from "../utils/apiResponse";
import connection from "../utils/dbUtil";

const healthRouter: Router = Router();

/** Liveness: the process is up. */
healthRouter.get("/health", (req: Request, res: Response, next: NextFunction) => {
    sendApiResponse(req, res, next, async () =>
        getOkResponse({ status: "OK", timestamp: new Date() }, 0, "Service is up")
    );
});

/** Readiness: the database answers, with how many numbers are connected. */
healthRouter.get("/ready", (req: Request, res: Response, next: NextFunction) => {
    sendApiResponse(req, res, next, async () => {
        const rows = await connection("wa_sessions")
            .select("status")
            .count({ count: "*" })
            .groupBy("status");
        const numbers = Object.fromEntries(rows.map((r: any) => [r.status, Number(r.count)]));
        return getOkResponse(
            { status: "READY", timestamp: new Date(), numbers },
            0,
            "Service is ready"
        );
    });
});

export default healthRouter;
