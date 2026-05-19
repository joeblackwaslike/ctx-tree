import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Filters } from '../store/types';

export interface FilterSQL {
  where: string;
  params: (string | number)[];
}

export function buildFilterSQL(filters: Filters = {}, tableAlias = ''): FilterSQL {
  if (tableAlias && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableAlias)) {
    throw new Error(`Invalid tableAlias: ${tableAlias}`);
  }
  if (filters.session_id && filters.metadata?.session_id) {
    throw new McpError(ErrorCode.InvalidParams,
      'filters.session_id and filters.metadata.session_id cannot both be set');
  }
  const p = tableAlias ? `${tableAlias}.` : '';
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  const statuses = (filters.status?.length ? filters.status : null) ?? ['live'];
  clauses.push(`${p}status IN (${statuses.map(() => '?').join(',')})`);
  params.push(...statuses);

  if (filters.kind?.length) {
    clauses.push(`${p}kind IN (${filters.kind.map(() => '?').join(',')})`);
    params.push(...filters.kind);
  }
  if (filters.since != null) { clauses.push(`${p}created_at >= ?`); params.push(filters.since); }
  if (filters.until != null) { clauses.push(`${p}created_at <= ?`); params.push(filters.until); }
  if (filters.parent_id)     { clauses.push(`${p}parent_id = ?`); params.push(filters.parent_id); }
  if (filters.session_id) {
    clauses.push(`json_extract(${p}metadata,'$.session_id') = ?`);
    params.push(filters.session_id);
  }

  if (filters.metadata !== undefined) {
    const KNOWN_KEYS = new Set(['tool', 'session_id', 'gitignored']);
    for (const key of Object.keys(filters.metadata)) {
      if (!KNOWN_KEYS.has(key)) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown metadata filter key: ${key}`);
      }
    }
    if (filters.metadata.tool !== undefined) {
      clauses.push(`json_extract(${p}metadata,'$.tool') = ?`);
      params.push(filters.metadata.tool);
    }
    if (filters.metadata.session_id !== undefined) {
      clauses.push(`json_extract(${p}metadata,'$.session_id') = ?`);
      params.push(filters.metadata.session_id);
    }
    if (filters.metadata.gitignored !== undefined) {
      clauses.push(`json_extract(${p}metadata,'$.gitignored') = ?`);
      params.push(filters.metadata.gitignored ? 1 : 0);
    }
  }

  return { where: clauses.join(' AND '), params };
}
