import { ulid } from './ulid.mjs';

/**
 * Returns the ULID id of the session node for sessionId, creating it if needed.
 * Uses INSERT OR IGNORE so concurrent hook + MCP server writes are safe.
 */
export function getOrCreateSession(db, sessionId) {
  const row = db.query(
    `SELECT id FROM nodes WHERE kind='session' AND json_extract(metadata,'$.session_id')=?`
  ).get(sessionId);
  if (row) return row.id;

  const id = ulid();
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO nodes
       (id, parent_id, kind, source_uri, content, content_hash,
        status, mtime, created_at, updated_at, truncated, original_bytes, metadata)
     VALUES (?,NULL,'session',NULL,'','','live',0,?,?,0,0,?)`,
    id, now, now, JSON.stringify({ session_id: sessionId })
  );
  // Re-query: whether INSERT succeeded or was ignored by a concurrent writer, return whichever row is now in the DB.
  const created = db.query(
    `SELECT id FROM nodes WHERE kind='session' AND json_extract(metadata,'$.session_id')=?`
  ).get(sessionId);
  return created?.id ?? id;
}

/** Most recently created node of a given kind under a session. */
export function lastNode(db, sessionId, kind) {
  return db.query(
    `SELECT id FROM nodes WHERE parent_id=? AND kind=? ORDER BY created_at DESC LIMIT 1`
  ).get(sessionId, kind);
}

/** Count of nodes of a given kind under a session (used for turn_index). */
export function countNodes(db, sessionId, kind) {
  return (db.query(
    `SELECT COUNT(*) AS n FROM nodes WHERE parent_id=? AND kind=?`
  ).get(sessionId, kind))?.n ?? 0;
}

export function insertEdge(db, srcId, dstId, kind, now) {
  db.run(
    `INSERT OR IGNORE INTO edges (src_id,dst_id,kind,created_at) VALUES (?,?,?,?)`,
    srcId, dstId, kind, now
  );
}
