CREATE TABLE nodes_vec (
  id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  embedding vector NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dim INT NOT NULL,
  embedded_at BIGINT NOT NULL
);
