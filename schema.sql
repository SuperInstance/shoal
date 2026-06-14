-- SHOAL: Semantic Hybrid Oracle for Agent Learning
-- D1 (SQLite) schema for conservation-bounded semantic search.
--
-- Run locally:    npx wrangler d1 execute shoal-db --local --file=./schema.sql
-- Run remotely:   npx wrangler d1 execute shoal-db --remote --file=./schema.sql

-- ─── Documents ──────────────────────────────────────────────────────────────
-- Knowledge items stored with embeddings as Float32Array BLOBs.
-- Embeddings are 384-dimensional (bge-small-en-v1.5) or hash-based fallback.
CREATE TABLE IF NOT EXISTS documents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  text            TEXT NOT NULL,
  metadata        TEXT NOT NULL DEFAULT '{}',   -- JSON object
  tags            TEXT NOT NULL DEFAULT '',      -- comma-separated
  embedding       BLOB,                          -- Float32Array (384 floats)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  query_count     INTEGER NOT NULL DEFAULT 0,    -- how many times returned
  relevance_score REAL NOT NULL DEFAULT 0.0      -- adjusted by feedback [-1, 1]
);

CREATE INDEX IF NOT EXISTS idx_documents_tags ON documents(tags);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at);

-- ─── Query Log ──────────────────────────────────────────────────────────────
-- Every query is logged with conservation metadata for audit and analytics.
-- gamma = mutual information gained (attention consumed) in bits
-- eta   = remaining information budget = C - cumulative_gamma for that window
CREATE TABLE IF NOT EXISTS query_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  query       TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  gamma       REAL NOT NULL DEFAULT 0,   -- bits spent on this query
  eta         REAL NOT NULL DEFAULT 0,   -- remaining budget after this query
  timestamp   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_query_log_agent ON query_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_query_log_ts ON query_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_query_log_agent_ts ON query_log(agent_id, timestamp);

-- ─── Feedback ───────────────────────────────────────────────────────────────
-- Relevance feedback from agents. Adjusts document relevance_score over time.
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  query       TEXT NOT NULL,
  doc_id      INTEGER NOT NULL,
  relevant    INTEGER NOT NULL,  -- 1 = relevant, 0 = not relevant
  timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (doc_id) REFERENCES documents(id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_doc ON feedback(doc_id);
CREATE INDEX IF NOT EXISTS idx_feedback_ts ON feedback(timestamp);
