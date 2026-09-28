/**
 * SQLite database schema definitions for the Prodily Growth OS.
 */

export const MIGRATION_V1 = `
-- Schema migrations tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- Sessions tracking for CLI invocations and resume state
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  configuration_snapshot TEXT,
  status TEXT NOT NULL
);

-- Persistent discovery candidates: People
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  canonical_profile_url TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  headline TEXT,
  raw_discovery_data TEXT,
  discovery_source TEXT,
  discovered_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  current_status TEXT NOT NULL DEFAULT 'discovered',
  activity_score REAL NOT NULL DEFAULT 0,
  icp_score REAL NOT NULL DEFAULT 0,
  intent_score REAL NOT NULL DEFAULT 0,
  overall_score REAL NOT NULL DEFAULT 0,
  evidence_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_people_url ON people(canonical_profile_url);
CREATE INDEX IF NOT EXISTS idx_people_status ON people(current_status);
CREATE INDEX IF NOT EXISTS idx_people_overall_score ON people(overall_score);

-- Persistent discovery candidates: Posts
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  canonical_post_url TEXT UNIQUE NOT NULL,
  author_name TEXT NOT NULL,
  author_profile_url TEXT,
  raw_discovery_data TEXT,
  discovery_source TEXT,
  discovered_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  activity_score REAL NOT NULL DEFAULT 0,
  relevance_score REAL NOT NULL DEFAULT 0,
  conversation_score REAL NOT NULL DEFAULT 0,
  freshness_score REAL NOT NULL DEFAULT 0,
  overall_score REAL NOT NULL DEFAULT 0,
  evidence_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_posts_url ON posts(canonical_post_url);
CREATE INDEX IF NOT EXISTS idx_posts_overall_score ON posts(overall_score);

-- Persistent versioned reviews: People
CREATE TABLE IF NOT EXISTS person_reviews (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  session_id TEXT REFERENCES sessions(id),
  ai_analysis TEXT,
  suggested_message TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_at TEXT,
  reviewer_action TEXT
);
CREATE INDEX IF NOT EXISTS idx_person_reviews_person ON person_reviews(person_id);
CREATE INDEX IF NOT EXISTS idx_person_reviews_status ON person_reviews(status);

-- Persistent versioned reviews: Posts
CREATE TABLE IF NOT EXISTS post_reviews (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id),
  session_id TEXT REFERENCES sessions(id),
  ai_analysis TEXT,
  suggested_comment TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_at TEXT,
  reviewer_action TEXT
);
CREATE INDEX IF NOT EXISTS idx_post_reviews_post ON post_reviews(post_id);
CREATE INDEX IF NOT EXISTS idx_post_reviews_status ON post_reviews(status);

-- Comments lifecycle and publishing attempts
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id),
  review_id TEXT REFERENCES post_reviews(id),
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  linkedin_comment_urn TEXT,
  publish_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);

-- Append-only event log
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_data TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
`;
