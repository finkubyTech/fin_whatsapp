import { Request, Response, NextFunction } from "express";
import createError from "http-errors";
import { mapDatabaseError } from "./dbErrorMessages";
import { logger } from "./logger";

/**
 * Every response this service sends, success or error, has this shape:
 *   { error: boolean, status: number, message: string, data: any }
 * Paginated responses add count, total_pages, per_page, page_number,
 * total_count and field_search_filters.
 */
export interface ApiResponse {
    error: boolean;
    status: number;
    message: any;
    data: any;
    count?: number;
}

export const getOkResponse = (
    data: any = {},
    _count = 0,
    message = "OK",
    status = 200
): ApiResponse => {
    return { error: false, status, message, data };
};

export interface IPaginationResponse {
    data: any;
    total_pages: number;
    per_page: number;
    page_number: number;
    message?: string;
    count: number;
    total_count: number;
    field_search_filters?: string[];
}

export const getPaginationResponse = ({
    data,
    total_pages,
    per_page,
    page_number,
    message = "Successfully fetched the results",
    count,
    total_count,
    field_search_filters,
}: IPaginationResponse) => {
    return {
        error: false,
        status: 200,
        message,
        data,
        count,
        total_pages,
        per_page,
        page_number,
        total_count,
        field_search_filters,
    };
};

export const getErrorResponse = (err: any): ApiResponse => {
    const apiResponse: ApiResponse = {
        error: true,
        status: 500,
        message: "There was an error, please try again",
        data: {},
    };
    if (err) {
        if (typeof err === "string") {
            apiResponse.message = err;
        } else {
            // A raw Postgres constraint-violation error arrives as the driver's
            // own error — no `status`/`statusCode`, and `message` is the full SQL
            // statement — so it must be special-cased before the generic
            // status/message copy below, or that SQL text leaks to the client.
            const dbError = mapDatabaseError(err);
            if (dbError) {
                apiResponse.status = dbError.status;
                apiResponse.message = dbError.message;
            } else {
                if (err.status) {
                    apiResponse.status = err.status;
                } else if (err.statusCode) {
                    apiResponse.status = err.statusCode;
                }
                if (err.message) {
                    apiResponse.message = err.message;
                }
                if (err.data) {
                    apiResponse.data = err.data;
                }
            }
        }
    }

    if (apiResponse.status >= 500) {
        logger.error(`[API Error Response]: ${apiResponse.message} | ${err?.stack || err}`);
    } else {
        logger.info(`[API Error Response]: ${apiResponse.status} ${apiResponse.message}`);
    }
    return apiResponse;
};

/** Sends an error in the standard envelope (used by middleware that rejects a request). */
export const sendErrorResponse = (res: Response, err: any) => {
    const errResponse = getErrorResponse(err);
    return res.status(errResponse.status).json(errResponse);
};

// Re-export createError and its aliases/default export
export { createError };
export const createHttpError = createError;
export default createError;

/**
 * Runs a handler and stores its result (or error) in res.locals.apiResponse.
 *
 * It then calls next("router"): Express leaves the current router, so no later
 * route in it can also match and overwrite the response, and continues with
 * the middleware mounted after the router (encryptionMiddleware), which sends it.
 */
export const sendApiResponse = (
    req: Request,
    res: Response,
    next: NextFunction,
    cb: (req: Request, res: Response, next: NextFunction) => Promise<ApiResponse>
) => {
    cb(req, res, next)
        .then((apiResponse) => {
            res.locals.apiResponse = apiResponse;
            next("router");
        })
        .catch((err) => {
            res.locals.apiResponse = getErrorResponse(err);
            next("router");
        });
};
