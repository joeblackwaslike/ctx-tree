import type { Database } from 'bun:sqlite';
import type { MemtreeNode, NodeStatus } from './types';

interface InsertNodeParams {
  parent_id: string | null;
  kind: MemtreeNode['kind'];
  source_uri: string | null;
  content: string;
  content_hash: string;
  status: NodeStatus;
  mtime: number;
  truncated: number;
  original_bytes: number;
  metadata: string;
}

export function insertNode(db: Database, id: string, p: InsertNodeParams): void {
  const now = Date.now();
  db.run(
    `INSERT INTO nodes (id,parent_id,kind,source_uri,content,content_hash,
                       status,mtime,created_at,updated_at,truncated,original_bytes,metadata)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, p.parent_id, p.kind, p.source_uri, p.content, p.content_hash,
    p.status, p.mtime, now, now, p.truncated, p.original_bytes, p.metadata
  );
}

export function getNode(db: Database, id: string): MemtreeNode | null {
  return (db.query('SELECT * FROM nodes WHERE id = ?').get(id) as MemtreeNode | undefined) ?? null;
}

export function updateNodeStatus(db: Database, id: string, status: NodeStatus): void {
  db.run('UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?', status, Date.now(), id);
}

export function getNodeBySourceUri(db: Database, sourceUri: string): MemtreeNode | null {
  return (db.query(
    "SELECT * FROM nodes WHERE source_uri = ? AND status = 'live' ORDER BY created_at DESC LIMIT 1"
  ).get(sourceUri) as MemtreeNode | undefined) ?? null;
}

export function getNodeByContentHash(db: Database, hash: string): MemtreeNode | null {
  return (db.query(
    "SELECT * FROM nodes WHERE content_hash = ? AND status = 'live' LIMIT 1"
  ).get(hash) as MemtreeNode | undefined) ?? null;
}

export function listChildren(
  db: Database,
  parentId: string,
  status: NodeStatus = 'live'
): MemtreeNode[] {
  return db.query(
    'SELECT * FROM nodes WHERE parent_id = ? AND status = ? ORDER BY created_at'
  ).all(parentId, status) as MemtreeNode[];
}

export function getOrCreateSessionNode(
  db: Database,
  sessionId: string
): MemtreeNode {
  const { ulid } = require('ulid');
  const existing = db.query(
    "SELECT * FROM nodes WHERE kind = 'session' AND json_extract(metadata,'$.session_id') = ?"
  ).get(sessionId) as MemtreeNode | undefined;
  if (existing) return existing;

  const id = ulid();
  insertNode(db, id, {
    parent_id: null, kind: 'session', source_uri: null,
    content: '', content_hash: '', status: 'live', mtime: 0,
    truncated: 0, original_bytes: 0,
    metadata: JSON.stringify({ session_id: sessionId }),
  });
  return getNode(db, id)!;
}

export function countPendingNodes(db: Database): number {
  return (db.query("SELECT COUNT(*) as n FROM nodes WHERE status = 'pending'").get() as { n: number }).n;
}

export function getPendingNodes(db: Database, limit = 100): MemtreeNode[] {
  return db.query(
    "SELECT * FROM nodes WHERE status = 'pending' ORDER BY created_at LIMIT ?"
  ).all(limit) as MemtreeNode[];
}

export function getLiveFileChunks(
  db: Database,
  olderThanMs: number
): MemtreeNode[] {
  return db.query(
    "SELECT * FROM nodes WHERE kind = 'file_chunk' AND status = 'live' AND mtime > 0 AND updated_at < ?"
  ).all(olderThanMs) as MemtreeNode[];
}

export function getStaleNodes(
  db: Database,
  olderThanMs: number
): MemtreeNode[] {
  return db.query(
    "SELECT * FROM nodes WHERE status = 'stale' AND updated_at < ?"
  ).all(olderThanMs) as MemtreeNode[];
}

export function getSupersededNodes(
  db: Database,
  olderThanMs: number
): MemtreeNode[] {
  return db.query(
    "SELECT * FROM nodes WHERE status = 'superseded' AND updated_at < ?"
  ).all(olderThanMs) as MemtreeNode[];
}

export function pruneNode(db: Database, id: string): void {
  db.run("UPDATE nodes SET status = 'pruned', content = '', updated_at = ? WHERE id = ?", Date.now(), id);
}
