-- SHOAL: Conservation-Bounded Semantic Search Oracle
-- Schema for D1 (SQLite)

-- Documents store embeddings as Float32Array BLOBs.
-- Each document belongs to a source/crate and has a type for filtering.
CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  embedding   BLOB,           -- Float32Array serialized as Buffer
  source      TEXT DEFAULT NULL,
  crate_name  TEXT DEFAULT NULL,
  doc_type    TEXT DEFAULT 'generic',
  relevance_score REAL DEFAULT 0,  -- adjusted by feedback over time
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_crate ON documents(crate_name);
CREATE INDEX IF NOT EXISTS idx_documents_type  ON documents(doc_type);

-- Every query is logged with its conservation metadata.
-- gamma_used  = attention weight consumed (information gained)
-- eta_budget  = remaining uncertainty budget
-- conservation_c = the hard bound C = log2(3) ≈ 1.585
CREATE TABLE IF NOT EXISTS queries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  query_text      TEXT NOT NULL,
  results_returned INTEGER NOT NULL DEFAULT 0,
  gamma_used      REAL NOT NULL DEFAULT 0,
  eta_budget      REAL NOT NULL DEFAULT 0,
  conservation_c  REAL NOT NULL DEFAULT 1.584962500721156,
  rejected        INTEGER NOT NULL DEFAULT 0,
  timestamp       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_queries_ts ON queries(timestamp);

-- Relevance feedback adjusts future rankings.
-- When a user marks a result relevant/not-relevant, we store it
-- and bump the document's relevance_score accordingly.
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  query_id    INTEGER NOT NULL,
  document_id INTEGER NOT NULL,
  relevant    INTEGER NOT NULL,  -- 1 = relevant, 0 = not relevant
  timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (query_id) REFERENCES queries(id),
  FOREIGN KEY (document_id) REFERENCES documents(id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_doc ON feedback(document_id);
CREATE INDEX IF NOT EXISTS idx_feedback_query ON feedback(query_id);
