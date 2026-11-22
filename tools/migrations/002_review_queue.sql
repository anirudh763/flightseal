CREATE TABLE review_queue (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE(owner, digest)
);
CREATE INDEX review_queue_owner ON review_queue(owner, processed_at, created_at);
