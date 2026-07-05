/** Parse ?page=&limit= into { page, limit, skip } with sane bounds. */
export function parsePagination(query = {}, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

/** Standard pagination meta for list responses. */
export function paginationMeta(total, page, limit) {
  return { total, page, limit, pages: Math.ceil(total / limit) || 1 };
}
