import type { Filters } from '../store/types';

export interface FilterSQL {
  where: string;
  params: (string | number)[];
}

export function buildFilterSQL(filters: Filters = {}): FilterSQL {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  const statuses = (filters.status?.length ? filters.status : null) ?? ['live'];
  clauses.push(`status IN (${statuses.map(() => '?').join(',')})`);
  params.push(...statuses);

  if (filters.kind?.length) {
    clauses.push(`kind IN (${filters.kind.map(() => '?').join(',')})`);
    params.push(...filters.kind);
  }
  if (filters.since != null) { clauses.push('created_at >= ?'); params.push(filters.since); }
  if (filters.until != null) { clauses.push('created_at <= ?'); params.push(filters.until); }
  if (filters.parent_id)     { clauses.push('parent_id = ?'); params.push(filters.parent_id); }
  if (filters.session_id) {
    clauses.push("json_extract(metadata,'$.session_id') = ?");
    params.push(filters.session_id);
  }

  return { where: clauses.join(' AND '), params };
}
