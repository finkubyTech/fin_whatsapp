import { randomUUID } from "crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Carries a correlation id through the request: taken from x-correlation-id /
 * x-operation-id when a caller (gateway, another fin_ service) sends one,
 * generated otherwise. Echoed back in the response header.
 */
export const correlationMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers["x-correlation-id"] || req.headers["x-operation-id"];
    const correlationId = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
    res.locals.correlationId = correlationId;
    res.setHeader("x-correlation-id", correlationId);
    next();
};
