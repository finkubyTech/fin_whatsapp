import { logger } from "./logger";

// Postgres error codes this module translates into client-safe responses.
// https://www.postgresql.org/docs/current/errcodes-appendix.html
const PG_ERROR_CODE = {
    UNIQUE_VIOLATION: "23505",
    FOREIGN_KEY_VIOLATION: "23503",
    NOT_NULL_VIOLATION: "23502",
    CHECK_VIOLATION: "23514",
} as const;

// node-postgres doesn't export a typed error class for consumers to import —
// it throws a plain Error with these fields attached at runtime. This is the
// minimal structural shape this module relies on.
export interface PostgresDriverError extends Error {
    code?: string;
    constraint?: string;
    table?: string;
    column?: string;
}

const isPostgresError = (err: unknown): err is PostgresDriverError =>
    !!err && typeof err === "object" && typeof (err as any).code === "string";

// Unique constraint name -> client-facing message, for the constraints staff
// are actually likely to hit by normal use. Anything not listed here still
// gets a safe generic message (see mapDatabaseError) — this table only
// exists to make the common cases read naturally instead of generically.
const UNIQUE_VIOLATION_MESSAGES: Record<string, string> = {
    users_email_unique: "This email is already registered to another user",
    users_mobile_number_unique: "This mobile number is already registered",
    staff_users_email_unique: "This email is already registered to a staff account",
    staff_users_employee_id_unique: "This Employee ID is already in use",
    user_kyc_document_number_unique: "This document number is already registered to another user",
    loan_types_code_unique: "This loan type code is already in use",
};

export interface MappedDatabaseError {
    status: number;
    message: string;
}

/**
 * Translates a raw Postgres driver error into a client-safe {status, message},
 * or null if `err` isn't a constraint violation this module handles — callers
 * fall back to their own generic error handling in that case.
 *
 * This is a last-resort safety net, not the primary way to report a
 * conflict. A call site that already knows the specific business rule (e.g.
 * StaffService.createStaff pre-checking email uniqueness) should keep
 * throwing its own createHttpError.Conflict(...) with a precise message —
 * that runs before any query and reads better than a constraint-name lookup.
 * This function exists purely to stop a *raw* driver error — whose
 * `.message` contains the full SQL statement — from ever reaching a client
 * unfiltered when nothing upstream anticipated the failure.
 */
export const mapDatabaseError = (err: unknown): MappedDatabaseError | null => {
    if (!isPostgresError(err)) return null;

    switch (err.code) {
        case PG_ERROR_CODE.UNIQUE_VIOLATION: {
            const message = err.constraint ? UNIQUE_VIOLATION_MESSAGES[err.constraint] : undefined;
            if (!message) {
                logger.warn(
                    `[mapDatabaseError] Unmapped unique constraint "${err.constraint}" on table "${err.table}" — ` +
                        `add a message to UNIQUE_VIOLATION_MESSAGES in dbErrorMessages.ts instead of relying on the generic fallback.`
                );
            }
            return { status: 409, message: message ?? "This value is already in use" };
        }

        case PG_ERROR_CODE.FOREIGN_KEY_VIOLATION:
            return {
                status: 409,
                message: "This action references a record that no longer exists",
            };

        case PG_ERROR_CODE.NOT_NULL_VIOLATION:
            return { status: 400, message: `${err.column ?? "A required field"} is missing` };

        case PG_ERROR_CODE.CHECK_VIOLATION:
            return { status: 400, message: "One of the submitted values is not valid" };

        default:
            return null;
    }
};
