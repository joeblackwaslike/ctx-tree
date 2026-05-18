import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

export function openDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id            TEXT PRIMARY KEY,
      parent_id     TEXT REFERENCES nodes(id) ON DELETE SET NULL,
      kind          TEXT NOT NULL CHECK(kind IN ('session','file_chunk','tool_output','summary','note','observation')),
      source_uri    TEXT,
      content       TEXT NOT NULL DEFAULT '',
      content_hash  TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','live','stale','superseded','pruned')),
      mtime         INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      truncated     INTEGER NOT NULL DEFAULT 0,
      original_bytes INTEGER NOT NULL DEFAULT 0,
      metadata      TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
    CREATE INDEX IF NOT EXISTS idx_nodes_created ON nodes(created_at, parent_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_source_uri ON nodes(source_uri);
    CREATE INDEX IF NOT EXISTS idx_nodes_content_hash ON nodes(content_hash);

    CREATE TABLE IF NOT EXISTS edges (
      src_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      dst_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL CHECK(kind IN ('derived_from','references','summarizes','supersedes')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (src_id, dst_id, kind)
    );

    CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      id UNINDEXED,
      content,
      content='nodes',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS nodes_fts_insert AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, id, content) VALUES (new.rowid, new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS nodes_fts_update AFTER UPDATE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, id, content) VALUES ('delete', old.rowid, old.id, old.content);
      INSERT INTO nodes_fts(rowid, id, content) VALUES (new.rowid, new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS nodes_fts_delete AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, id, content) VALUES ('delete', old.rowid, old.id, old.content);
    END;

    CREATE TABLE IF NOT EXISTS nodes_vec (
      id              TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      embedding       BLOB,
      embedding_model TEXT NOT NULL,
      embedding_dim   INTEGER NOT NULL,
      embedded_at     INTEGER NOT NULL
    );
  `);

  return db;
}

export function closeDb(db: Database): void {
  try { db.close(); } catch { /* ignore */ }
}
