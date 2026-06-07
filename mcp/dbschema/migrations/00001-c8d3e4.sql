-- PGlite compatibility note: no CREATE EXTENSION required for this migration.
-- TSVECTOR, to_tsvector(), plainto_tsquery(), ts_rank(), the @@ operator,
-- GIN indexes, and plpgsql are all core PostgreSQL features included in
-- PGlite's WASM build. pg_trgm is NOT used here (trigram similarity is a
-- separate extension). pgvector is handled separately in 00002.
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  content TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  mtime BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  truncated BOOLEAN NOT NULL DEFAULT FALSE,
  original_bytes BIGINT NOT NULL DEFAULT 0,
  source_uri TEXT,
  metadata JSONB DEFAULT '{}',
  summary TEXT,
  parent_id TEXT REFERENCES nodes(id)
);
ALTER TABLE nodes ADD COLUMN fts_vector TSVECTOR;
CREATE INDEX ON nodes USING GIN (fts_vector);
CREATE OR REPLACE FUNCTION nodes_fts_update() RETURNS TRIGGER AS $$
BEGIN
  NEW.fts_vector := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER nodes_fts_trigger
BEFORE INSERT OR UPDATE ON nodes
FOR EACH ROW EXECUTE FUNCTION nodes_fts_update();
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  src_id TEXT NOT NULL REFERENCES nodes(id),
  dst_id TEXT NOT NULL REFERENCES nodes(id),
  UNIQUE(src_id, dst_id, kind)
);