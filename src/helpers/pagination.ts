import { getPaginationResponse } from "../utils/apiResponse";

/** ?page_number=&per_page= from the query, as the other fin_ lists read them. */
export const pageOf = (query: Record<string, unknown>, defaultPerPage = 20, maxPerPage = 100) => {
    const perPage = Math.min(
        maxPerPage,
        Math.max(1, parseInt(String(query.per_page ?? ""), 10) || defaultPerPage)
    );
    const pageNumber = Math.max(1, parseInt(String(query.page_number ?? ""), 10) || 1);
    return { perPage, pageNumber, offset: (pageNumber - 1) * perPage };
};

/** The standard paginated envelope from a page of rows and the total. */
export const paged = (
    rows: any[],
    total: number,
    page: { perPage: number; pageNumber: number },
    message = "Successfully fetched the results"
) =>
    getPaginationResponse({
        data: rows,
        count: rows.length,
        total_count: total,
        per_page: page.perPage,
        page_number: page.pageNumber,
        total_pages: Math.max(1, Math.ceil(total / page.perPage)),
        message,
    });
