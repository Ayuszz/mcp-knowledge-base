-- pgvector schema for the production-scale upgrade path (see docker-compose.yml
-- and README "Scaling this up" section). Not required to run the project as-is.
--
-- This mirrors exactly the fields src/store.js already stores in notes.json,
-- so swapping storage backends wouldn't change the tool logic in server.js at
-- all — only store.js's implementation, same separation-of-concerns argument
-- used for check_availability() vs the LLM in my hotel assistant project.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  tags        TEXT[] NOT NULL DEFAULT '{}',
  embedding   VECTOR(384) NOT NULL,  -- all-MiniLM-L6-v2 produces 384-dim vectors
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HNSW index for fast approximate nearest-neighbor search at scale.
-- vector_cosine_ops matches the cosine-similarity scoring used in store.js,
-- so ranking behavior stays identical after the swap.
CREATE INDEX IF NOT EXISTS notes_embedding_hnsw_idx
  ON notes USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS notes_tags_idx ON notes USING GIN (tags);

-- Equivalent of store.js's search(): find the top-k nearest notes to a query
-- embedding, e.g.:
--   SELECT id, title, content, tags, 1 - (embedding <=> $1) AS score
--   FROM notes
--   ORDER BY embedding <=> $1   -- <=> is pgvector's cosine-distance operator
--   LIMIT $2;
