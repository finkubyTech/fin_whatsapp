import type { NextFunction, Request, Response, Router } from "express";
import { sendErrorResponse } from "../utils/apiResponse";
import { requireSession } from "../whatsapp/sessions";
import type { WaSessionRow } from "../types";

/** Every route with :session gets the number in res.locals.session, or a 404. */
export function bindSessionParam(router: Router) {
    router.param(
        "session",
        async (req: Request, res: Response, next: NextFunction, key: string) => {
            try {
                res.locals.session = await requireSession(String(key));
                next();
            } catch (err) {
                sendErrorResponse(res, err);
            }
        }
    );
}

export const sessionOf = (res: Response) => res.locals.session as WaSessionRow;
