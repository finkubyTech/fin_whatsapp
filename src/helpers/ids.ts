import createHttpError from "http-errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id from the URL: a 404 when it can't be one, instead of a Postgres cast error (500). */
export function requireUuid(value: string, what: string): string {
    if (!UUID.test(value)) throw new createHttpError.NotFound(`${what} not found`);
    return value;
}
