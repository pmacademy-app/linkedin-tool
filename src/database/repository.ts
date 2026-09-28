/**
 * SQLite repository implementing the persistent storage layer for Prodily Growth OS.
 * Guarantees crash-safety, transactions for multi-step updates, and append-only event logging.
 */
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { getDatabase } from "./connection.js";
import { runMigrations } from "./migrations.js";

// ---------------------------------------------------------------------------
// Model Types
// ---------------------------------------------------------------------------

export interface PersonRow {
  id: string;
  canonical_profile_url: string;
  name: string;
  headline: string | null;
  raw_discovery_data: string | null;
  discovery_source: string | null;
  discovered_at: string;
  first_seen_at: string;
  last_seen_at: string;
  current_status: string;
  activity_score: number;
  icp_score: number;
  intent_score: number;
  overall_score: number;
  evidence_json: string | null;
}

export interface PostRow {
  id: string;
  canonical_post_url: string;
  author_name: string;
  author_profile_url: string | null;
  raw_discovery_data: string | null;
  discovery_source: string | null;
  discovered_at: string;
  first_seen_at: string;
  last_seen_at: string;
  activity_score: number;
  relevance_score: number;
  conversation_score: number;
  freshness_score: number;
  overall_score: number;
  evidence_json: string | null;
}

export interface PersonReviewRow {
  id: string;
  person_id: string;
  session_id: string | null;
  ai_analysis: string | null;
  suggested_message: string;
  version: number;
  status: string;
  reviewed_at: string | null;
  reviewer_action: string | null;
}

export interface PostReviewRow {
  id: string;
  post_id: string;
  session_id: string | null;
  ai_analysis: string | null;
  suggested_comment: string;
  version: number;
  status: string;
  reviewed_at: string | null;
  reviewer_action: string | null;
}

export interface CommentRow {
  id: string;
  post_id: string;
  review_id: string | null;
  content: string;
  version: number;
  status: string;
  linkedin_comment_urn: string | null;
  publish_attempt_count: number;
  last_error: string | null;
  created_at: string;
  approved_at: string | null;
  published_at: string | null;
}

export interface SessionRow {
  id: string;
  command: string;
  started_at: string;
  completed_at: string | null;
  configuration_snapshot: string | null;
  status: string;
}

export interface EventRow {
  id: string;
  session_id: string | null;
  entity_type: string;
  entity_id: string;
  event_type: string;
  event_data: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function normaliseCanonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    return (u.origin + u.pathname).replace(/\/$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase().replace(/\/$/, "");
  }
}

export function sanitizeError(err: unknown): string {
  const str = err instanceof Error ? err.message : String(err);
  return str
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/gi, "sk-[REDACTED]")
    .replace(/fc-[A-Za-z0-9._-]+/gi, "fc-[REDACTED]")
    .replace(/nvapi-[A-Za-z0-9._-]+/gi, "nvapi-[REDACTED]");
}

// ---------------------------------------------------------------------------
// GrowthRepository
// ---------------------------------------------------------------------------

export class GrowthRepository {
  private db: DatabaseSync;

  constructor(customDb?: DatabaseSync) {
    this.db = customDb || getDatabase();
    runMigrations(this.db);
  }

  // --- Transactions ---

  public transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = action();
      this.db.exec("COMMIT;");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  }

  // --- Sessions ---

  public createSession(
    command: string,
    configSnapshot: Record<string, unknown> = {}
  ): SessionRow {
    const id = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, command, started_at, completed_at, configuration_snapshot, status)
      VALUES (?, ?, ?, NULL, ?, 'running')
    `);
    stmt.run(id, command, startedAt, JSON.stringify(configSnapshot));

    this.logEvent(id, "session", id, "session_started", { command });
    return this.getSession(id)!;
  }

  public completeSession(
    sessionId: string,
    status: "completed" | "failed" | "interrupted" = "completed"
  ): void {
    const completedAt = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE sessions SET completed_at = ?, status = ? WHERE id = ?
    `);
    stmt.run(completedAt, status, sessionId);
    this.logEvent(sessionId, "session", sessionId, "session_finished", { status });
  }

  public getSession(id: string): SessionRow | null {
    const stmt = this.db.prepare("SELECT * FROM sessions WHERE id = ?");
    return (stmt.get(id) as unknown as SessionRow) || null;
  }

  public getLatestSession(command?: string): SessionRow | null {
    if (command) {
      const stmt = this.db.prepare(
        "SELECT * FROM sessions WHERE command = ? ORDER BY started_at DESC LIMIT 1"
      );
      return (stmt.get(command) as unknown as SessionRow) || null;
    }
    const stmt = this.db.prepare(
      "SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1"
    );
    return (stmt.get() as unknown as SessionRow) || null;
  }

  // --- Events (Append-only) ---

  public logEvent(
    sessionId: string | null,
    entityType: string,
    entityId: string,
    eventType: string,
    eventData: Record<string, unknown> = {}
  ): EventRow {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO events (id, session_id, entity_type, entity_id, event_type, event_data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      sessionId,
      entityType,
      entityId,
      eventType,
      JSON.stringify(eventData),
      createdAt
    );

    return {
      id,
      session_id: sessionId,
      entity_type: entityType,
      entity_id: entityId,
      event_type: eventType,
      event_data: JSON.stringify(eventData),
      created_at: createdAt,
    };
  }

  // --- People ---

  public isPersonKnown(profileUrl: string): boolean {
    const canonical = normaliseCanonicalUrl(profileUrl);
    const stmt = this.db.prepare(
      "SELECT 1 FROM people WHERE canonical_profile_url = ? LIMIT 1"
    );
    return !!stmt.get(canonical);
  }

  public getAllKnownProfileUrls(): Set<string> {
    const stmt = this.db.prepare("SELECT canonical_profile_url FROM people");
    const rows = stmt.all() as unknown as Array<{ canonical_profile_url: string }>;
    return new Set(rows.map((r) => r.canonical_profile_url));
  }

  public getPersonByUrl(profileUrl: string): PersonRow | null {
    const canonical = normaliseCanonicalUrl(profileUrl);
    const stmt = this.db.prepare(
      "SELECT * FROM people WHERE canonical_profile_url = ?"
    );
    return (stmt.get(canonical) as unknown as PersonRow) || null;
  }

  public upsertPerson(
    candidate: {
      profileUrl: string;
      name: string;
      headline: string;
      rawData: unknown;
      source: string;
      activityScore: number;
      icpScore: number;
      intentScore: number;
      overallScore: number;
      evidence: unknown;
    },
    sessionId: string
  ): { person: PersonRow; isNew: boolean } {
    const canonical = normaliseCanonicalUrl(candidate.profileUrl);
    const now = new Date().toISOString();

    return this.transaction(() => {
      const existing = this.getPersonByUrl(canonical);

      if (existing) {
        // Person already discovered: NEVER overwrite historical records destructively
        // Update only last_seen_at and record re_discovered event
        const updateStmt = this.db.prepare(`
          UPDATE people
          SET last_seen_at = ?,
              overall_score = MAX(overall_score, ?)
          WHERE id = ?
        `);
        updateStmt.run(now, candidate.overallScore, existing.id);

        this.logEvent(sessionId, "person", existing.id, "re_discovered", {
          profileUrl: canonical,
          previousSeenAt: existing.last_seen_at,
          newSeenAt: now,
        });

        return {
          person: this.getPersonById(existing.id)!,
          isNew: false,
        };
      }

      // New person candidate
      const id = crypto.randomUUID();
      const insertStmt = this.db.prepare(`
        INSERT INTO people (
          id, canonical_profile_url, name, headline, raw_discovery_data,
          discovery_source, discovered_at, first_seen_at, last_seen_at,
          current_status, activity_score, icp_score, intent_score, overall_score, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?, ?, ?)
      `);
      insertStmt.run(
        id,
        canonical,
        candidate.name,
        candidate.headline || "",
        JSON.stringify(candidate.rawData),
        candidate.source,
        now,
        now,
        now,
        candidate.activityScore,
        candidate.icpScore,
        candidate.intentScore,
        candidate.overallScore,
        JSON.stringify(candidate.evidence)
      );

      this.logEvent(sessionId, "person", id, "discovered", {
        canonicalUrl: canonical,
        overallScore: candidate.overallScore,
      });

      return {
        person: this.getPersonById(id)!,
        isNew: true,
      };
    });
  }

  public getPersonById(id: string): PersonRow | null {
    const stmt = this.db.prepare("SELECT * FROM people WHERE id = ?");
    return (stmt.get(id) as unknown as PersonRow) || null;
  }

  // --- Posts ---

  public isPostKnown(postUrl: string): boolean {
    const canonical = normaliseCanonicalUrl(postUrl);
    const stmt = this.db.prepare(
      "SELECT 1 FROM posts WHERE canonical_post_url = ? LIMIT 1"
    );
    return !!stmt.get(canonical);
  }

  public getAllKnownPostUrls(): Set<string> {
    const stmt = this.db.prepare("SELECT canonical_post_url FROM posts");
    const rows = stmt.all() as unknown as Array<{ canonical_post_url: string }>;
    return new Set(rows.map((r) => r.canonical_post_url));
  }

  public getPostByUrl(postUrl: string): PostRow | null {
    const canonical = normaliseCanonicalUrl(postUrl);
    const stmt = this.db.prepare(
      "SELECT * FROM posts WHERE canonical_post_url = ?"
    );
    return (stmt.get(canonical) as unknown as PostRow) || null;
  }

  public getPostById(id: string): PostRow | null {
    const stmt = this.db.prepare("SELECT * FROM posts WHERE id = ?");
    return (stmt.get(id) as unknown as PostRow) || null;
  }

  public upsertPost(
    candidate: {
      postUrl: string;
      authorName: string;
      authorProfileUrl?: string | null;
      rawData: unknown;
      source: string;
      activityScore: number;
      relevanceScore: number;
      conversationScore: number;
      freshnessScore: number;
      overallScore: number;
      evidence: unknown;
    },
    sessionId: string
  ): { post: PostRow; isNew: boolean } {
    const canonical = normaliseCanonicalUrl(candidate.postUrl);
    const now = new Date().toISOString();

    return this.transaction(() => {
      const existing = this.getPostByUrl(canonical);

      if (existing) {
        // Post already exists: update last_seen_at only, append event
        const updateStmt = this.db.prepare(`
          UPDATE posts
          SET last_seen_at = ?,
              overall_score = MAX(overall_score, ?)
          WHERE id = ?
        `);
        updateStmt.run(now, candidate.overallScore, existing.id);

        this.logEvent(sessionId, "post", existing.id, "re_discovered", {
          postUrl: canonical,
          previousSeenAt: existing.last_seen_at,
          newSeenAt: now,
        });

        return {
          post: this.getPostById(existing.id)!,
          isNew: false,
        };
      }

      // New post
      const id = crypto.randomUUID();
      const insertStmt = this.db.prepare(`
        INSERT INTO posts (
          id, canonical_post_url, author_name, author_profile_url, raw_discovery_data,
          discovery_source, discovered_at, first_seen_at, last_seen_at,
          activity_score, relevance_score, conversation_score, freshness_score, overall_score, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertStmt.run(
        id,
        canonical,
        candidate.authorName,
        candidate.authorProfileUrl || null,
        JSON.stringify(candidate.rawData),
        candidate.source,
        now,
        now,
        now,
        candidate.activityScore,
        candidate.relevanceScore,
        candidate.conversationScore,
        candidate.freshnessScore,
        candidate.overallScore,
        JSON.stringify(candidate.evidence)
      );

      this.logEvent(sessionId, "post", id, "discovered", {
        canonicalUrl: canonical,
        overallScore: candidate.overallScore,
      });

      return {
        post: this.getPostById(id)!,
        isNew: true,
      };
    });
  }

  // --- Versioned Reviews & Content ---

  public createPersonReview(
    personId: string,
    sessionId: string,
    aiAnalysis: unknown,
    suggestedMessage: string
  ): PersonReviewRow {
    return this.transaction(() => {
      // Determine next version
      const verStmt = this.db.prepare(
        "SELECT COALESCE(MAX(version), 0) as maxVer FROM person_reviews WHERE person_id = ?"
      );
      const row = verStmt.get(personId) as unknown as { maxVer: number };
      const nextVer = (row?.maxVer || 0) + 1;

      const reviewId = crypto.randomUUID();
      const insertStmt = this.db.prepare(`
        INSERT INTO person_reviews (
          id, person_id, session_id, ai_analysis, suggested_message, version, status, reviewed_at, reviewer_action
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL)
      `);
      insertStmt.run(
        reviewId,
        personId,
        sessionId,
        JSON.stringify(aiAnalysis),
        suggestedMessage,
        nextVer
      );

      this.logEvent(sessionId, "person_review", reviewId, "review_created", {
        personId,
        version: nextVer,
      });

      const selectStmt = this.db.prepare("SELECT * FROM person_reviews WHERE id = ?");
      return selectStmt.get(reviewId) as unknown as PersonReviewRow;
    });
  }

  public createPostReviewAndComment(
    postId: string,
    sessionId: string,
    aiAnalysis: unknown,
    suggestedComment: string
  ): { review: PostReviewRow; comment: CommentRow } {
    return this.transaction(() => {
      // Determine next version for review
      const revVerStmt = this.db.prepare(
        "SELECT COALESCE(MAX(version), 0) as maxVer FROM post_reviews WHERE post_id = ?"
      );
      const revRow = revVerStmt.get(postId) as unknown as { maxVer: number };
      const nextRevVer = (revRow?.maxVer || 0) + 1;

      const reviewId = crypto.randomUUID();
      const insertRevStmt = this.db.prepare(`
        INSERT INTO post_reviews (
          id, post_id, session_id, ai_analysis, suggested_comment, version, status, reviewed_at, reviewer_action
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL)
      `);
      insertRevStmt.run(
        reviewId,
        postId,
        sessionId,
        JSON.stringify(aiAnalysis),
        suggestedComment,
        nextRevVer
      );

      // Determine next version for comment
      const comVerStmt = this.db.prepare(
        "SELECT COALESCE(MAX(version), 0) as maxVer FROM comments WHERE post_id = ?"
      );
      const comRow = comVerStmt.get(postId) as unknown as { maxVer: number };
      const nextComVer = (comRow?.maxVer || 0) + 1;

      const commentId = crypto.randomUUID();
      const now = new Date().toISOString();
      const insertComStmt = this.db.prepare(`
        INSERT INTO comments (
          id, post_id, review_id, content, version, status, linkedin_comment_urn,
          publish_attempt_count, last_error, created_at, approved_at, published_at
        ) VALUES (?, ?, ?, ?, ?, 'draft', NULL, 0, NULL, ?, NULL, NULL)
      `);
      insertComStmt.run(
        commentId,
        postId,
        reviewId,
        suggestedComment,
        nextComVer,
        now
      );

      this.logEvent(sessionId, "post_review", reviewId, "review_created", {
        postId,
        version: nextRevVer,
      });

      this.logEvent(sessionId, "comment", commentId, "comment_created", {
        postId,
        reviewId,
        version: nextComVer,
      });

      const selectRev = this.db.prepare("SELECT * FROM post_reviews WHERE id = ?");
      const selectCom = this.db.prepare("SELECT * FROM comments WHERE id = ?");

      return {
        review: selectRev.get(reviewId) as unknown as PostReviewRow,
        comment: selectCom.get(commentId) as unknown as CommentRow,
      };
    });
  }

  // --- Pending Reviews Lookup (for --review-people and --review-posts) ---

  public getPendingPersonReviews(): Array<{ review: PersonReviewRow; person: PersonRow }> {
    const stmt = this.db.prepare(`
      SELECT r.*, p.name as p_name, p.headline as p_headline, p.canonical_profile_url as p_url,
             p.icp_score as p_icp_score, p.overall_score as p_overall_score, p.evidence_json as p_evidence
      FROM person_reviews r
      JOIN people p ON r.person_id = p.id
      WHERE r.status = 'pending'
      ORDER BY p.overall_score DESC, r.version ASC
    `);

    const rows = stmt.all() as any[];
    return rows.map((r) => {
      const person: PersonRow = {
        id: r.person_id,
        canonical_profile_url: r.p_url,
        name: r.p_name,
        headline: r.p_headline,
        raw_discovery_data: null,
        discovery_source: null,
        discovered_at: "",
        first_seen_at: "",
        last_seen_at: "",
        current_status: "discovered",
        activity_score: 0,
        icp_score: r.p_icp_score,
        intent_score: 0,
        overall_score: r.p_overall_score,
        evidence_json: r.p_evidence,
      };

      const review: PersonReviewRow = {
        id: r.id,
        person_id: r.person_id,
        session_id: r.session_id,
        ai_analysis: r.ai_analysis,
        suggested_message: r.suggested_message,
        version: r.version,
        status: r.status,
        reviewed_at: r.reviewed_at,
        reviewer_action: r.reviewer_action,
      };

      return { review, person };
    });
  }

  public getPendingPostReviews(): Array<{
    review: PostReviewRow;
    post: PostRow;
    comment: CommentRow;
  }> {
    const stmt = this.db.prepare(`
      SELECT r.*, p.author_name as p_author, p.canonical_post_url as p_url,
             p.author_profile_url as p_author_url, p.relevance_score as p_relevance_score,
             p.conversation_score as p_conversation_score, p.freshness_score as p_freshness_score,
             p.overall_score as p_overall_score, p.evidence_json as p_evidence,
             c.id as c_id, c.content as c_content, c.version as c_version, c.status as c_status
      FROM post_reviews r
      JOIN posts p ON r.post_id = p.id
      LEFT JOIN comments c ON c.review_id = r.id
      WHERE r.status = 'pending'
      ORDER BY p.overall_score DESC, r.version ASC
    `);

    const rows = stmt.all() as any[];
    return rows.map((r) => {
      const post: PostRow = {
        id: r.post_id,
        canonical_post_url: r.p_url,
        author_name: r.p_author,
        author_profile_url: r.p_author_url,
        raw_discovery_data: null,
        discovery_source: null,
        discovered_at: "",
        first_seen_at: "",
        last_seen_at: "",
        activity_score: 0,
        relevance_score: r.p_relevance_score,
        conversation_score: r.p_conversation_score,
        freshness_score: r.p_freshness_score,
        overall_score: r.p_overall_score,
        evidence_json: r.p_evidence,
      };

      const review: PostReviewRow = {
        id: r.id,
        post_id: r.post_id,
        session_id: r.session_id,
        ai_analysis: r.ai_analysis,
        suggested_comment: r.suggested_comment,
        version: r.version,
        status: r.status,
        reviewed_at: r.reviewed_at,
        reviewer_action: r.reviewer_action,
      };

      const comment: CommentRow = {
        id: r.c_id || crypto.randomUUID(),
        post_id: r.post_id,
        review_id: r.id,
        content: r.c_content || r.suggested_comment,
        version: r.c_version || 1,
        status: r.c_status || "draft",
        linkedin_comment_urn: null,
        publish_attempt_count: 0,
        last_error: null,
        created_at: "",
        approved_at: null,
        published_at: null,
      };

      return { review, post, comment };
    });
  }

  // --- Review Decisions ---

  public updatePersonReviewDecision(
    reviewId: string,
    decision: "approved" | "skipped",
    editedMessage?: string | null,
    sessionId?: string
  ): void {
    const now = new Date().toISOString();

    this.transaction(() => {
      const getStmt = this.db.prepare("SELECT * FROM person_reviews WHERE id = ?");
      const review = getStmt.get(reviewId) as unknown as PersonReviewRow;
      if (!review) return;

      const reviewerAction = editedMessage ? "edited" : decision;
      const finalMessage = editedMessage || review.suggested_message;

      // Update review row
      const updateRev = this.db.prepare(`
        UPDATE person_reviews
        SET status = ?,
            reviewed_at = ?,
            reviewer_action = ?,
            suggested_message = ?
        WHERE id = ?
      `);
      updateRev.run(decision, now, reviewerAction, finalMessage, reviewId);

      // Update person row current_status
      const updatePerson = this.db.prepare(`
        UPDATE people
        SET current_status = ?
        WHERE id = ?
      `);
      updatePerson.run(decision, review.person_id);

      this.logEvent(sessionId || null, "person_review", reviewId, decision, {
        personId: review.person_id,
        action: reviewerAction,
        hasEdit: !!editedMessage,
      });
    });
  }

  public updatePostReviewDecision(
    reviewId: string,
    decision: "approved" | "skipped",
    editedComment?: string | null,
    sessionId?: string
  ): void {
    const now = new Date().toISOString();

    this.transaction(() => {
      const getStmt = this.db.prepare("SELECT * FROM post_reviews WHERE id = ?");
      const review = getStmt.get(reviewId) as unknown as PostReviewRow;
      if (!review) return;

      const reviewerAction = editedComment ? "edited" : decision;
      const finalComment = editedComment || review.suggested_comment;

      // Update post review row
      const updateRev = this.db.prepare(`
        UPDATE post_reviews
        SET status = ?,
            reviewed_at = ?,
            reviewer_action = ?,
            suggested_comment = ?
        WHERE id = ?
      `);
      updateRev.run(decision, now, reviewerAction, finalComment, reviewId);

      // Update associated comment status
      const commentStatus = decision === "approved" ? "approved" : "skipped";
      const updateComment = this.db.prepare(`
        UPDATE comments
        SET status = ?,
            content = ?,
            approved_at = ?
        WHERE review_id = ?
      `);
      updateComment.run(
        commentStatus,
        finalComment,
        decision === "approved" ? now : null,
        reviewId
      );

      this.logEvent(sessionId || null, "post_review", reviewId, decision, {
        postId: review.post_id,
        action: reviewerAction,
        commentStatus,
        hasEdit: !!editedComment,
      });
    });
  }

  // --- LinkedIn Publishing (for --publish-comments) ---

  public getApprovedCommentsForPublishing(): Array<{ comment: CommentRow; post: PostRow }> {
    const stmt = this.db.prepare(`
      SELECT c.*, p.canonical_post_url as p_url, p.author_name as p_author,
             p.author_profile_url as p_author_url, p.relevance_score as p_relevance_score,
             p.overall_score as p_overall_score, p.evidence_json as p_evidence
      FROM comments c
      JOIN posts p ON c.post_id = p.id
      WHERE c.status = 'approved' AND c.published_at IS NULL
      ORDER BY c.created_at ASC
    `);

    const rows = stmt.all() as any[];
    return rows.map((r) => ({
      comment: {
        id: r.id,
        post_id: r.post_id,
        review_id: r.review_id,
        content: r.content,
        version: r.version,
        status: r.status,
        linkedin_comment_urn: r.linkedin_comment_urn,
        publish_attempt_count: r.publish_attempt_count,
        last_error: r.last_error,
        created_at: r.created_at,
        approved_at: r.approved_at,
        published_at: r.published_at,
      },
      post: {
        id: r.post_id,
        canonical_post_url: r.p_url,
        author_name: r.p_author,
        author_profile_url: r.p_author_url,
        raw_discovery_data: null,
        discovery_source: null,
        discovered_at: "",
        first_seen_at: "",
        last_seen_at: "",
        activity_score: 0,
        relevance_score: r.p_relevance_score,
        conversation_score: 0,
        freshness_score: 0,
        overall_score: r.p_overall_score,
        evidence_json: r.p_evidence,
      },
    }));
  }

  public recordPublishSuccess(
    commentId: string,
    commentUrn: string,
    sessionId?: string
  ): void {
    const now = new Date().toISOString();

    this.transaction(() => {
      const stmt = this.db.prepare(`
        UPDATE comments
        SET status = 'published',
            linkedin_comment_urn = ?,
            published_at = ?,
            publish_attempt_count = publish_attempt_count + 1,
            last_error = NULL
        WHERE id = ?
      `);
      stmt.run(commentUrn, now, commentId);

      this.logEvent(sessionId || null, "comment", commentId, "published", {
        commentUrn,
        publishedAt: now,
      });
    });
  }

  public recordPublishFailure(
    commentId: string,
    error: string,
    sessionId?: string
  ): void {
    const cleanErr = sanitizeError(error);

    this.transaction(() => {
      const stmt = this.db.prepare(`
        UPDATE comments
        SET status = 'publish_failed',
            last_error = ?,
            publish_attempt_count = publish_attempt_count + 1
        WHERE id = ?
      `);
      stmt.run(cleanErr, commentId);

      this.logEvent(sessionId || null, "comment", commentId, "publish_failed", {
        error: cleanErr,
      });
    });
  }

  public recordManualCommentCopy(commentId: string, sessionId?: string): void {
    this.transaction(() => {
      const stmt = this.db.prepare(`
        UPDATE comments
        SET status = 'manual_copied'
        WHERE id = ?
      `);
      stmt.run(commentId);

      this.logEvent(sessionId || null, "comment", commentId, "manual_copied", {});
    });
  }

  // --- Status and History Metrics ---

  public getStatusCounts(): {
    people: {
      total: number;
      discovered: number;
      pendingReview: number;
      approved: number;
      contacted: number;
      skipped: number;
    };
    posts: {
      total: number;
      discovered: number;
      pendingReview: number;
    };
    comments: {
      total: number;
      draft: number;
      approved: number;
      published: number;
      publish_failed: number;
      manual_copied: number;
      skipped: number;
    };
    sessions: SessionRow[];
  } {
    const countPeople = (status: string) => {
      const s = this.db.prepare("SELECT COUNT(*) as count FROM people WHERE current_status = ?");
      return (s.get(status) as any)?.count || 0;
    };
    const totalPeople = (this.db.prepare("SELECT COUNT(*) as c FROM people").get() as any)?.c || 0;
    const pendingPeople = (this.db.prepare("SELECT COUNT(*) as c FROM person_reviews WHERE status = 'pending'").get() as any)?.c || 0;

    const totalPosts = (this.db.prepare("SELECT COUNT(*) as c FROM posts").get() as any)?.c || 0;
    const pendingPosts = (this.db.prepare("SELECT COUNT(*) as c FROM post_reviews WHERE status = 'pending'").get() as any)?.c || 0;

    const countComment = (status: string) => {
      const s = this.db.prepare("SELECT COUNT(*) as count FROM comments WHERE status = ?");
      return (s.get(status) as any)?.count || 0;
    };
    const totalComments = (this.db.prepare("SELECT COUNT(*) as c FROM comments").get() as any)?.c || 0;

    const recentSessions = this.db.prepare(
      "SELECT * FROM sessions ORDER BY started_at DESC LIMIT 5"
    ).all() as unknown as SessionRow[];

    return {
      people: {
        total: totalPeople,
        discovered: countPeople("discovered"),
        pendingReview: pendingPeople,
        approved: countPeople("approved"),
        contacted: countPeople("contacted"),
        skipped: countPeople("skipped"),
      },
      posts: {
        total: totalPosts,
        discovered: totalPosts,
        pendingReview: pendingPosts,
      },
      comments: {
        total: totalComments,
        draft: countComment("draft"),
        approved: countComment("approved"),
        published: countComment("published"),
        publish_failed: countComment("publish_failed"),
        manual_copied: countComment("manual_copied"),
        skipped: countComment("skipped"),
      },
      sessions: recentSessions,
    };
  }

  public getRecentEvents(
    limit = 50,
    filters?: { entityType?: string; eventType?: string }
  ): EventRow[] {
    let query = "SELECT * FROM events";
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters?.entityType) {
      conditions.push("entity_type = ?");
      params.push(filters.entityType);
    }
    if (filters?.eventType) {
      conditions.push("event_type = ?");
      params.push(filters.eventType);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const stmt = this.db.prepare(query);
    return stmt.all(...params) as unknown as EventRow[];
  }

  public getRecentSessions(limit = 20): SessionRow[] {
    const stmt = this.db.prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?");
    return stmt.all(limit) as unknown as SessionRow[];
  }
}
