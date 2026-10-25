import { Request, Response, NextFunction } from "express";
import { logger, maskSensitiveData } from "./logger";
import { getErrorResponse } from "./apiResponse";
import { mapDatabaseError } from "./dbErrorMessages";

/**
 * Last-resort handler for errors thrown outside sendApiResponse (body parsing,
 * middleware). Responds in the standard envelope.
 */
// Express identifies error middleware by its 4-arg signature — `_next` must stay
export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
    logger.error(
        `${req.method} ${req.originalUrl} | ${err?.message} | Request Body: ${JSON.stringify(
            maskSensitiveData(req.body)
        )} | ${err?.stack}`
    );

    if (res.headersSent) {
        return;
    }

    // Malformed JSON body from express.json()
    if (err instanceof SyntaxError && "body" in err) {
        return res.status(400).json({
            error: true,
            status: 400,
            message: "Invalid JSON format in request body",
            data: {},
        });
    }

    // Objection model validation
    if (err?.name === "ValidationError") {
        return res.status(400).json({
            error: true,
            status: 400,
            message: "Validation Error",
            data: err.data ?? {},
        });
    }

    // DB constraint errors and http-errors carry a safe message and status;
    // anything else becomes a generic 500 so internals never reach the client.
    const isSafe = !!mapDatabaseError(err) || typeof (err?.status ?? err?.statusCode) === "number";
    const errResponse = getErrorResponse(isSafe ? err : { message: "Internal Server Error" });
    return res.status(errResponse.status).json(errResponse);
};
