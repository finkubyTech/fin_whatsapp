// Module Imports
import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import createHttpError from "http-errors";
// File Imports
import { config } from "../../config/options";
import { sendErrorResponse } from "./apiResponse";
import { logger } from "./logger";
import connection from "./dbUtil";
import type { WaPermission } from "../types";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            user?: Actor;
        }
    }
}

/** Who is calling: a staff user (CRM) or another fin_ service. Customers never reach WhatsApp. */
export type Actor =
    | { kind: "staff"; id: string; role: string; permissions: string[]; session_key: string }
    | { kind: "internal"; id: null };

/** x-internal-key matches INTERNAL_API_KEY (only when that key is configured). */
const isInternalCall = (req: Request) => {
    if (!config.internalApiKey) return false;
    const provided = Buffer.from(req.get("x-internal-key") || "", "utf8");
    const expected = Buffer.from(config.internalApiKey, "utf8");
    return provided.length === expected.length && timingSafeEqual(provided, expected);
};

const staffSessionValid = async (sessionKey: string, staffId: string) =>
    !!(await connection("sessions as s")
        .join("staff_users as su", "su.id", "s.staff_id")
        .where({ "s.session_key": sessionKey, "s.staff_id": staffId, "s.status": "ACTIVE" })
        .andWhere("s.expires_at", ">", connection.fn.now())
        .andWhere("su.is_active", true)
        .whereNull("su.deleted_at")
        .first("s.id"));

/**
 * Staff tokens (fin_crm_app, RS256, backed by an ACTIVE session) and
 * service-to-service calls carrying x-internal-key. A customer token is a 403:
 * the portal never talks to WhatsApp directly.
 */
export async function authProtected(req: Request, res: Response, next: NextFunction) {
    if (isInternalCall(req)) {
        req.user = { kind: "internal", id: null };
        res.locals.userInfo = req.user;
        return next();
    }
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
        return sendErrorResponse(res, new createHttpError.Unauthorized("JWT token required"));
    }
    try {
        const decoded = jwt.verify(token, config.publicKey, { algorithms: ["RS256"] }) as Record<
            string,
            any
        >;
        if (!decoded.staff_id || !decoded.session_key) {
            throw new createHttpError.Forbidden("Staff access only");
        }
        if (!(await staffSessionValid(decoded.session_key, decoded.staff_id))) {
            throw new createHttpError.Unauthorized("Invalid session, Please login again");
        }
        req.user = {
            kind: "staff",
            id: decoded.staff_id,
            role: decoded.role,
            permissions: decoded.permissions || [],
            session_key: decoded.session_key,
        };
        res.locals.userInfo = req.user;
        next();
    } catch (err: any) {
        logger.info(`[authProtected] ${err?.message}`);
        const httpErr = createHttpError.isHttpError(err)
            ? err
            : err?.name === "TokenExpiredError"
              ? new createHttpError.Unauthorized("Token expired, please login again")
              : new createHttpError.Unauthorized("Unauthorized. Token invalid");
        return sendErrorResponse(res, httpErr);
    }
}

// Each permission includes the ones below it: admin can send, send can read.
const RANK: Record<WaPermission, number> = {
    whatsapp_read: 1,
    whatsapp_send: 2,
    whatsapp_admin: 3,
};

/** True when the caller holds `permission` (or a higher one). Internal callers and SUPER_ADMIN always do. */
export const hasPermission = (actor: Actor | undefined, permission: WaPermission) => {
    if (!actor) return false;
    if (actor.kind === "internal" || actor.role === "SUPER_ADMIN") return true;
    const needed = RANK[permission];
    return actor.permissions.some((p) => (RANK as Record<string, number>)[p] >= needed);
};

export const requirePermission =
    (permission: WaPermission) => (req: Request, res: Response, next: NextFunction) => {
        if (hasPermission(req.user, permission)) return next();
        return sendErrorResponse(
            res,
            new createHttpError.Forbidden(`Forbidden. Missing permission: ${permission}`)
        );
    };

/** Staff id for created_by / updated_by columns (null for service calls). */
export const actorId = (req: Request) => (req.user?.kind === "staff" ? req.user.id : null);
