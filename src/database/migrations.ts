/**
 * Database migration runner.
 * Handles schema versioning and optional automatic legacy history import.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { getDatabase } from "./connection.js";
import { MIGRATION_V1 } from "./schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_HISTORY_PATH = path.resolve(__dirname, "../../data/history.json");

export function runMigrations(
  customDb?: DatabaseSync,
  options: { importLegacy?: boolean } = {}
): void {
  const db = customDb || getDatabase();

  // Create migrations table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const stmt = db.prepare("SELECT version FROM schema_migrations WHERE version = ?");
  const row = stmt.get(1);

  if (!row) {
    // Apply migration V1
    db.exec(MIGRATION_V1);
    const insertMigration = db.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
    );
    insertMigration.run(1, new Date().toISOString());

    // Import legacy history if available and not explicitly disabled for custom test DBs
    const shouldImport = options.importLegacy ?? (!customDb && process.env.NODE_ENV !== "test");
    if (shouldImport) {
      migrateLegacyHistoryIfPresent(db);
    }
  }
}

function migrateLegacyHistoryIfPresent(db: DatabaseSync): void {
  if (!fs.existsSync(LEGACY_HISTORY_PATH)) return;

  try {
    const raw = fs.readFileSync(LEGACY_HISTORY_PATH, "utf-8");
    const data = JSON.parse(raw);

    const now = new Date().toISOString();
    const systemSessionId = crypto.randomUUID();

    // Create session record for legacy migration
    const insertSession = db.prepare(`
      INSERT OR IGNORE INTO sessions (id, command, started_at, completed_at, configuration_snapshot, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertSession.run(
      systemSessionId,
      "migrate-legacy-history",
      now,
      now,
      JSON.stringify({ source: "data/history.json" }),
      "completed"
    );

    // Import people
    if (data.people && typeof data.people === "object") {
      const insertPerson = db.prepare(`
        INSERT OR IGNORE INTO people (
          id, canonical_profile_url, name, headline, raw_discovery_data,
          discovery_source, discovered_at, first_seen_at, last_seen_at,
          current_status, activity_score, icp_score, intent_score, overall_score, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const [key, p] of Object.entries(data.people as Record<string, any>)) {
        const id = crypto.randomUUID();
        const profileUrl = p.profileUrl || key;
        const normUrl = profileUrl.trim().toLowerCase().replace(/\/$/, "");
        const status = p.status || "discovered";
        const score = typeof p.icpScore === "number" ? p.icpScore : 0;

        insertPerson.run(
          id,
          normUrl,
          p.name || "Unknown",
          p.headline || "",
          JSON.stringify(p),
          "legacy_history",
          p.discoveredAt || now,
          p.discoveredAt || now,
          p.updatedAt || now,
          status,
          50, // default activity score
          score,
          score,
          score,
          JSON.stringify({ importedFrom: "history.json", segment: p.segment })
        );

        if (p.suggestedMessage) {
          const insertReview = db.prepare(`
            INSERT OR IGNORE INTO person_reviews (
              id, person_id, session_id, ai_analysis, suggested_message, version, status, reviewed_at, reviewer_action
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          insertReview.run(
            crypto.randomUUID(),
            id,
            systemSessionId,
            JSON.stringify({ segment: p.segment, whyRelevant: [] }),
            p.suggestedMessage,
            1,
            status === "approved" ? "approved" : status === "contacted" ? "approved" : "pending",
            p.updatedAt || now,
            status === "approved" ? "approved" : null
          );
        }
      }
    }

    // Import posts
    if (data.posts && typeof data.posts === "object") {
      const insertPost = db.prepare(`
        INSERT OR IGNORE INTO posts (
          id, canonical_post_url, author_name, author_profile_url, raw_discovery_data,
          discovery_source, discovered_at, first_seen_at, last_seen_at,
          activity_score, relevance_score, conversation_score, freshness_score, overall_score, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertPostReview = db.prepare(`
        INSERT OR IGNORE INTO post_reviews (
          id, post_id, session_id, ai_analysis, suggested_comment, version, status, reviewed_at, reviewer_action
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertComment = db.prepare(`
        INSERT OR IGNORE INTO comments (
          id, post_id, review_id, content, version, status, linkedin_comment_urn,
          publish_attempt_count, last_error, created_at, approved_at, published_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const [key, p] of Object.entries(data.posts as Record<string, any>)) {
        const postId = crypto.randomUUID();
        const postUrl = p.postUrl || key;
        const normUrl = postUrl.trim().toLowerCase().replace(/\/$/, "");
        const status = p.status || "discovered";
        const score = typeof p.relevanceScore === "number" ? p.relevanceScore : 0;

        insertPost.run(
          postId,
          normUrl,
          p.authorName || "Unknown",
          null,
          JSON.stringify(p),
          "legacy_history",
          p.discoveredAt || now,
          p.discoveredAt || now,
          p.updatedAt || now,
          50,
          score,
          50,
          50,
          score,
          JSON.stringify({ importedFrom: "history.json", postSummary: p.postSummary })
        );

        if (p.suggestedComment) {
          const reviewId = crypto.randomUUID();
          const commentId = crypto.randomUUID();
          const isApproved = status === "approved" || status === "published";
          const isPublished = status === "published";

          insertPostReview.run(
            reviewId,
            postId,
            systemSessionId,
            JSON.stringify({ postSummary: p.postSummary }),
            p.suggestedComment,
            1,
            isApproved ? "approved" : "pending",
            p.updatedAt || now,
            isApproved ? "approved" : null
          );

          insertComment.run(
            commentId,
            postId,
            reviewId,
            p.suggestedComment,
            1,
            status,
            p.commentUrn || null,
            status === "published" || status === "publish_failed" ? 1 : 0,
            p.statusReason || null,
            p.discoveredAt || now,
            isApproved ? p.updatedAt || now : null,
            isPublished ? p.updatedAt || now : null
          );
        }
      }
    }
  } catch (err) {
    console.warn("[Database] Could not import legacy history.json:", String(err));
  }
}
