-- Temporary message objects stored as bounded BLOB chunks in libSQL.
-- Apply this migration outside the Worker request path.
CREATE TABLE IF NOT EXISTS turso_objects (
  object_key TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
  ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS turso_objects_staging_age
  ON turso_objects (ready, created_at);

CREATE TABLE IF NOT EXISTS turso_object_chunks (
  object_key TEXT NOT NULL,
  part INTEGER NOT NULL CHECK (part >= 0),
  data BLOB NOT NULL,
  PRIMARY KEY (object_key, part),
  FOREIGN KEY (object_key) REFERENCES turso_objects(object_key) ON DELETE CASCADE
);
