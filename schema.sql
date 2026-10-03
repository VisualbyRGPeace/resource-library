-- Cloudflare D1 schema for Resource Library
CREATE TABLE IF NOT EXISTS resources (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  file_key      TEXT NOT NULL UNIQUE,
  file_name     TEXT NOT NULL,
  file_type     TEXT NOT NULL,          -- extension, lowercase (png, psd, zip...)
  mime_type     TEXT NOT NULL,
  file_size     INTEGER NOT NULL,       -- bytes
  width         INTEGER,
  height        INTEGER,
  category      TEXT NOT NULL DEFAULT 'Other',
  tags          TEXT NOT NULL DEFAULT '[]',   -- JSON array
  thumbnail_key TEXT,
  created_at    TEXT NOT NULL,          -- ISO 8601
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resources_created  ON resources (created_at);
CREATE INDEX IF NOT EXISTS idx_resources_category ON resources (category);
CREATE INDEX IF NOT EXISTS idx_resources_size     ON resources (file_size);
CREATE INDEX IF NOT EXISTS idx_resources_name     ON resources (name COLLATE NOCASE);

-- Giới hạn đăng nhập sai theo IP
CREATE TABLE IF NOT EXISTS login_attempts (
  ip           TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
