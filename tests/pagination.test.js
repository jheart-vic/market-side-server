import { describe, it, expect } from 'vitest';
import { parsePagination, paginationMeta } from '../src/utils/pagination.js';

describe('parsePagination', () => {
  it('defaults to page 1 / limit 20', () => {
    expect(parsePagination()).toEqual({ page: 1, limit: 20, skip: 0 });
    expect(parsePagination({ page: 'junk', limit: 'junk' })).toEqual({ page: 1, limit: 20, skip: 0 });
  });

  it('computes skip and honors bounds', () => {
    expect(parsePagination({ page: '3', limit: '10' })).toEqual({ page: 3, limit: 10, skip: 20 });
    expect(parsePagination({ page: '-2' }).page).toBe(1);
    expect(parsePagination({ limit: '10000' }).limit).toBe(100); // maxLimit
    expect(parsePagination({ limit: '0' }).limit).toBe(20); // parses falsy → default
  });
});

describe('paginationMeta', () => {
  it('reports total pages, minimum 1', () => {
    expect(paginationMeta(45, 2, 20)).toEqual({ total: 45, page: 2, limit: 20, pages: 3 });
    expect(paginationMeta(0, 1, 20).pages).toBe(1);
  });
});
