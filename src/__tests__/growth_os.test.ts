/**
 * Comprehensive test suite for Prodily Growth OS:
 * - SQLite persistent storage & migrations
 * - Non-destructive upserts & versioning
 * - Deterministic people & post signals
 * - Official LinkedIn comment publishing lifecycle
 * - Resume behavior & status tracking
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { GrowthRepository } from "../database/repository.js";
import { getDatabase, closeDatabase } from "../database/connection.js";
import { evaluatePeopleSignals } from "../signals/peopleSignals.js";
import { evaluatePostSignals, extractAuthorProfileUrlFromPostUrl } from "../signals/postSignals.js";
import {
  cleanSuggestedComment,
  containsFabricatedBackstory,
  stripFabricatedBackstory,
  containsUnnecessaryAcronym,
} from "../ai/posts.js";
import { determineOutreachAngle, cleanSuggestedDm } from "../ai/people.js";
import type { RawPerson, RawPost } from "../storage/models.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// 1. SQLite Persistent Storage & Schema Invariants
// ============================================================================

describe("SQLite Growth OS Database", () => {
  it("initializes schema migrations, WAL mode, and tables in a clean database", () => {
    const testDbPath = path.resolve(__dirname, "../../data/database/test_growth.db");
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    const db = getDatabase(testDbPath);
    const repo = new GrowthRepository(db);

    // Verify tables exist
    const tablesStmt = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const tables = (tablesStmt.all() as any[]).map((r) => r.name);

    assert.ok(tables.includes("people"));
    assert.ok(tables.includes("posts"));
    assert.ok(tables.includes("person_reviews"));
    assert.ok(tables.includes("post_reviews"));
    assert.ok(tables.includes("comments"));
    assert.ok(tables.includes("sessions"));
    assert.ok(tables.includes("events"));
    assert.ok(tables.includes("schema_migrations"));

    // Verify migration V1 was recorded
    const migration = db.prepare("SELECT * FROM schema_migrations WHERE version = 1").get();
    assert.ok(migration);

    closeDatabase();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });
});

// ============================================================================
// 2. Non-Destructive Storage & Event Log
// ============================================================================

describe("Non-Destructive Persistence & Versioning", () => {
  it("upserts people without destroying existing records upon re-discovery", () => {
    const testDbPath = path.resolve(__dirname, "../../data/database/test_upsert.db");
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    const db = getDatabase(testDbPath);
    const repo = new GrowthRepository(db);
    const session = repo.createSession("test-discovery");

    const profileUrl = "https://www.linkedin.com/in/rohit-kumar-pm";

    // 1. First discovery
    const firstResult = repo.upsertPerson(
      {
        profileUrl,
        name: "Rohit Kumar",
        headline: "Aspiring PM | CS Undergrad",
        rawData: { name: "Rohit" },
        source: "firecrawl",
        activityScore: 70,
        icpScore: 85,
        intentScore: 90,
        overallScore: 82,
        evidence: { test: true },
      },
      session.id
    );

    assert.equal(firstResult.isNew, true);
    assert.equal(firstResult.person.name, "Rohit Kumar");
    assert.equal(firstResult.person.current_status, "discovered");

    const firstSeenAt = firstResult.person.first_seen_at;
    const initialLastSeen = firstResult.person.last_seen_at;

    // Create a review
    const review = repo.createPersonReview(
      firstResult.person.id,
      session.id,
      { segment: "Student" },
      "Hi Rohit, original message"
    );
    assert.equal(review.version, 1);
    assert.equal(review.status, "pending");

    // Approve the review
    repo.updatePersonReviewDecision(review.id, "approved", null, session.id);
    const approvedPerson = repo.getPersonById(firstResult.person.id);
    assert.equal(approvedPerson?.current_status, "approved");

    // 2. Re-discovery of the SAME person later
    const secondResult = repo.upsertPerson(
      {
        profileUrl,
        name: "Rohit Kumar",
        headline: "Aspiring PM | CS Undergrad (Updated)",
        rawData: { name: "Rohit" },
        source: "firecrawl",
        activityScore: 75,
        icpScore: 85,
        intentScore: 90,
        overallScore: 84,
        evidence: { test: true },
      },
      session.id
    );

    assert.equal(secondResult.isNew, false);
    // Preserves original first_seen_at and does NOT reset status back to discovered
    assert.equal(secondResult.person.first_seen_at, firstSeenAt);
    assert.equal(secondResult.person.current_status, "approved");

    // Creates new version of review rather than overwriting
    const reviewV2 = repo.createPersonReview(
      firstResult.person.id,
      session.id,
      { segment: "Student" },
      "Hi Rohit, second improved message"
    );
    assert.equal(reviewV2.version, 2);

    // Verify audit events exist
    const events = repo.getRecentEvents(10, { entityType: "person" });
    assert.ok(events.some((e) => e.event_type === "discovered"));
    assert.ok(events.some((e) => e.event_type === "re_discovered"));

    closeDatabase();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });
});

// ============================================================================
// 3. Deterministic People Signals & Quality Filter
// ============================================================================

describe("Deterministic People Signals", () => {
  it("correctly identifies aspiring PM switcher with high intent", () => {
    const raw: RawPerson = {
      profileUrl: "https://www.linkedin.com/in/ananya-sharma",
      name: "Ananya Sharma",
      headline: "Software Engineer at Infosys | Aspiring Product Manager | Learning PM",
      snippets: ["Completed Google PM Certificate 2 weeks ago"],
      source: "firecrawl",
    };

    const breakdown = evaluatePeopleSignals(raw);

    assert.equal(breakdown.evidence.careerStage, "career_switcher");
    assert.equal(breakdown.evidence.pmIntentStatus, "verified");
    assert.equal(breakdown.evidence.isExcluded, false);
    assert.ok(breakdown.icpScore >= 80);
    assert.ok(breakdown.intentScore >= 85);
    assert.ok(breakdown.overallScore >= 75);
    assert.equal(breakdown.evidence.activityStatus, "verified"); // "2 weeks ago"
  });

  it("excludes senior PMs, Directors, and Recruiters", () => {
    const seniorPerson: RawPerson = {
      profileUrl: "https://www.linkedin.com/in/vp-product-leader",
      name: "Alex Vance",
      headline: "VP of Product Management at BigTech | 15+ years experience",
      snippets: [],
      source: "firecrawl",
    };

    const breakdown = evaluatePeopleSignals(seniorPerson);

    assert.equal(breakdown.evidence.isExcluded, true);
    assert.equal(breakdown.evidence.careerStage, "senior_or_excluded");
    assert.ok(breakdown.evidence.exclusionReason?.toLowerCase().includes("vp of product"));
    assert.ok(breakdown.overallScore <= 20);

    const recruiter: RawPerson = {
      profileUrl: "https://www.linkedin.com/in/talent-recruiter",
      name: "Sam Talent",
      headline: "Technical Recruiter hiring for PM and SDE roles",
      snippets: [],
      source: "firecrawl",
    };

    const recBreakdown = evaluatePeopleSignals(recruiter);
    assert.equal(recBreakdown.evidence.isExcluded, true);
  });

  it("never assumes active status when no activity evidence exists (marks unknown)", () => {
    const unknownActivityPerson: RawPerson = {
      profileUrl: "https://www.linkedin.com/in/quiet-student",
      name: "Quiet Student",
      headline: "Computer Science Student | Interested in PM",
      snippets: ["Student profile"],
      source: "firecrawl",
    };

    const breakdown = evaluatePeopleSignals(unknownActivityPerson);
    assert.equal(breakdown.evidence.activityStatus, "unknown");
    assert.ok(breakdown.evidence.activityEvidence.includes("No recent activity"));
  });
});

// ============================================================================
// 4. Deterministic Post Signals & Quality Filter
// ============================================================================

describe("Deterministic Post Signals", () => {
  it("detects genuine discussions with questions and high relevance", () => {
    const post: RawPost = {
      postUrl: "https://www.linkedin.com/posts/priya-pm_pminterview-casestudy-activity-7123456789012345678",
      authorName: "Priya PM",
      snippet: "Struggling with product sense case studies for upcoming mock interviews. How do you approach segmenting users under time pressure? Would love your advice! 2 days ago",
      source: "firecrawl",
    };

    const breakdown = evaluatePostSignals(post);

    assert.equal(breakdown.evidence.conversationStatus, "verified");
    assert.ok(breakdown.conversationScore >= 85);
    assert.equal(breakdown.evidence.freshnessStatus, "verified");
    assert.equal(breakdown.evidence.isTooOld, false);
    assert.ok(breakdown.relevanceScore >= 80);
    assert.ok(breakdown.overallScore >= 75);
  });

  it("extracts author profile URL from LinkedIn post URL pattern", () => {
    const postUrl = "https://www.linkedin.com/posts/siddharth-rao_breakingintopm-productthinking-activity-7123456789012345";
    const profileUrl = extractAuthorProfileUrlFromPostUrl(postUrl);
    assert.equal(profileUrl, "https://www.linkedin.com/in/siddharth-rao");
  });

  it("penalizes promotional broadcasts and stale posts (>6 months)", () => {
    const broadcastPost: RawPost = {
      postUrl: "https://www.linkedin.com/posts/hr_we-are-hiring-activity-7123456789012345678",
      authorName: "HR Agency",
      snippet: "We are hiring Associate Product Managers! Click here for job alert and application link. 2 years ago",
      source: "firecrawl",
    };

    const breakdown = evaluatePostSignals(broadcastPost);
    assert.equal(breakdown.evidence.isTooOld, true);
    assert.ok(breakdown.conversationScore <= 20);
    assert.ok(breakdown.overallScore <= 30);
  });
});

// ============================================================================
// 5. Official LinkedIn Comments Publishing Lifecycle & Resilience
// ============================================================================

describe("Official LinkedIn Comments Lifecycle", () => {
  it("enforces approval requirement and tracks published vs publish_failed states", () => {
    const testDbPath = path.resolve(__dirname, "../../data/database/test_publish.db");
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    const db = getDatabase(testDbPath);
    const repo = new GrowthRepository(db);
    const session = repo.createSession("test-publish");

    // Insert post
    const postRes = repo.upsertPost(
      {
        postUrl: "https://www.linkedin.com/posts/test-author_activity-7100000000000099",
        authorName: "Test Author",
        rawData: {},
        source: "firecrawl",
        activityScore: 80,
        relevanceScore: 85,
        conversationScore: 90,
        freshnessScore: 90,
        overallScore: 86,
        evidence: {},
      },
      session.id
    );

    // Create review & comment
    const { review, comment } = repo.createPostReviewAndComment(
      postRes.post.id,
      session.id,
      { whyRelevant: "Great discussion" },
      "This is a thoughtful, human-written comment adding value."
    );

    assert.equal(comment.status, "draft");

    // Cannot publish draft comments!
    let readyToPublish = repo.getApprovedCommentsForPublishing();
    assert.equal(readyToPublish.length, 0);

    // User explicitly approves the comment
    repo.updatePostReviewDecision(review.id, "approved", null, session.id);

    // Now it is ready to publish
    readyToPublish = repo.getApprovedCommentsForPublishing();
    assert.equal(readyToPublish.length, 1);
    assert.equal(readyToPublish[0]?.comment.id, comment.id);

    // Simulate API failure on first attempt
    repo.recordPublishFailure(comment.id, "LinkedIn API returned HTTP 429: Rate limit", session.id);
    const failedRow = db.prepare("SELECT * FROM comments WHERE id = ?").get(comment.id) as any;
    assert.equal(failedRow.status, "publish_failed");
    assert.equal(failedRow.publish_attempt_count, 1);
    assert.ok(failedRow.last_error?.includes("429"));

    // Simulate successful API publication on subsequent attempt
    const urn = "urn:li:comment:(urn:li:activity:7100000000000099,123456)";
    repo.recordPublishSuccess(comment.id, urn, session.id);

    // Verified published
    const remainingPending = repo.getApprovedCommentsForPublishing();
    assert.equal(remainingPending.length, 0); // Not in approved queue anymore

    const metrics = repo.getStatusCounts();
    assert.equal(metrics.comments.published, 1);

    closeDatabase();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });
});

// ============================================================================
// 6. Resume Workflow State
// ============================================================================

describe("Resumable Workflow State", () => {
  it("maintains pending review queue across sessions without losing state", () => {
    const testDbPath = path.resolve(__dirname, "../../data/database/test_resume.db");
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    const db = getDatabase(testDbPath);
    const repo = new GrowthRepository(db);
    const session1 = repo.createSession("posts");

    // Add 3 posts with reviews
    for (let i = 1; i <= 3; i++) {
      const p = repo.upsertPost(
        {
          postUrl: `https://www.linkedin.com/posts/author-${i}_activity-710000000000000${i}`,
          authorName: `Author ${i}`,
          rawData: {},
          source: "mock",
          activityScore: 70,
          relevanceScore: 70,
          conversationScore: 70,
          freshnessScore: 70,
          overallScore: 70,
          evidence: {},
        },
        session1.id
      );

      repo.createPostReviewAndComment(
        p.post.id,
        session1.id,
        {},
        `Comment ${i}`
      );
    }

    assert.equal(repo.getPendingPostReviews().length, 3);

    // User reviews 1 and approves it
    const firstReview = repo.getPendingPostReviews()[0]!;
    repo.updatePostReviewDecision(firstReview.review.id, "approved", null, session1.id);
    repo.completeSession(session1.id, "interrupted");

    // Session 2 resumes later
    const session2 = repo.createSession("review-posts-resume");
    const remaining = repo.getPendingPostReviews();
    assert.equal(remaining.length, 2); // Exactly 2 remaining

    closeDatabase();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });
});

// ============================================================================
// 7. AI Quality Guardrails & Creator Scale
// ============================================================================

describe("AI Quality Guardrails & Creator Scale", () => {
  it("prevents and cleans generic flattering comment openers", () => {
    const examples = [
      {
        input: "Great post! The real trade-off in discovery is user desire vs feasibility.",
        expected: "The real trade-off in discovery is user desire vs feasibility.",
      },
      {
        input: "Your point about PRDs resonates with me. The best specs serve as living alignment docs rather than rigid handoffs.",
        expected: "The best specs serve as living alignment docs rather than rigid handoffs.",
      },
      {
        input: "Your call for continuous discovery is spot on! How do you protect engineering bandwidth during early sprints?",
        expected: "How do you protect engineering bandwidth during early sprints?",
      },
      {
        input: "I appreciate this emphasis on metrics. Leading indicators usually reveal churn risks weeks before lagging revenue numbers do.",
        expected: "Leading indicators usually reveal churn risks weeks before lagging revenue numbers do.",
      },
      {
        input: "Spot on! Prioritising by customer impact rather than stakeholder volume is the hardest habit to build.",
        expected: "Prioritising by customer impact rather than stakeholder volume is the hardest habit to build.",
      },
      {
        input: "So insightful! Have you considered testing prototypes with non-core users?",
        expected: "Have you considered testing prototypes with non-core users?",
      },
    ];

    for (const { input, expected } of examples) {
      assert.equal(cleanSuggestedComment(input), expected);
    }
  });

  it("detects and strips fabricated first-person experience", () => {
    const fakeBackstories = [
      "When I was an engineer, I used to think roadmaps were set in stone.",
      "In my previous company, we struggled with sprint velocity.",
      "At my last job, product analytics was completely siloed.",
      "In my own journey transitioning from engineering, I learned this the hard way.",
      "In my team we introduced bi-weekly user feedback sessions.",
    ];

    for (const text of fakeBackstories) {
      assert.equal(
        containsFabricatedBackstory(text),
        true,
        `Expected fabricated backstory detection for: "${text}"`
      );
    }

    // Strips fabricated sentences while keeping the genuine observation
    const dirtyComment =
      "When I was an engineer, I thought PRDs were just task lists. The best product specs act as communication alignment documents. How do you balance PRD detail with dev agility?";
    const cleaned = stripFabricatedBackstory(dirtyComment);
    assert.equal(containsFabricatedBackstory(cleaned), false);
    assert.ok(cleaned.includes("The best product specs act as communication alignment documents."));
    assert.ok(cleaned.includes("How do you balance PRD detail with dev agility?"));
  });

  it("flags unnecessary PM acronyms unless grounded in the post", () => {
    const postWithoutAcronyms = "How do you decide what feature to work on next when user feedback is mixed?";
    const postWithRice = "We are comparing RICE vs weighted scoring for quarterly planning.";

    // Unnecessary acronym used
    assert.equal(
      containsUnnecessaryAcronym("You should use RICE scoring to rank your backlog items.", postWithoutAcronyms),
      true
    );
    assert.equal(
      containsUnnecessaryAcronym("Have you set up a RACI matrix with engineering?", postWithoutAcronyms),
      true
    );

    // Grounded acronym used because post explicitly discusses it
    assert.equal(
      containsUnnecessaryAcronym("RICE works well when confidence scores are backed by user interviews.", postWithRice),
      false
    );
  });

  it("determines appropriate segmented outreach angles for candidate types", () => {
    // 1. Career Switcher
    const engineer: RawPerson = {
      name: "Aman Gupta",
      profileUrl: "https://www.linkedin.com/in/aman-gupta-dev",
      headline: "Senior Software Engineer transitioning to Product Management",
      snippets: ["5 years in backend engineering, exploring PM roles"],
      source: "mock",
    };
    assert.equal(determineOutreachAngle(engineer, "career_switcher"), "Career Switcher");

    const analyst: RawPerson = {
      name: "Priya Shah",
      profileUrl: "https://www.linkedin.com/in/priya-analytics",
      headline: "Data Analyst | Aspiring PM",
      snippets: ["SQL, Tableau, product analytics, transitioning to product"],
      source: "mock",
    };
    assert.equal(determineOutreachAngle(analyst, "career_switcher"), "Career Switcher");

    // 2. Student / APM Aspirant
    const student: RawPerson = {
      name: "Karan Patel",
      profileUrl: "https://www.linkedin.com/in/karan-mba",
      headline: "MBA Candidate @ ISB | Aspiring Associate Product Manager",
      snippets: ["Product club head, prepping for PM case interviews"],
      source: "mock",
    };
    assert.equal(determineOutreachAngle(student, "student"), "Student / APM Aspirant");

    // 3. Builder
    const builder: RawPerson = {
      name: "Siddharth Rao",
      profileUrl: "https://www.linkedin.com/in/sid-builder",
      headline: "Building AI tools for creators | Indie Hacker | Maker",
      snippets: ["Shipped 3 micro-SaaS products this year"],
      source: "mock",
    };
    assert.equal(determineOutreachAngle(builder, "non_pm_professional"), "Builder");
  });

  it("cleans generic robotic DM openers while preserving candidate personalization", () => {
    const roboticDm =
      "Hope this message finds you well! I saw your profile and wanted to reach out because your background in data analytics would translate directly into product metrics practice on Prodily. We built guided case studies specifically for analysts moving into PM.";
    const cleaned = cleanSuggestedDm(roboticDm);
    assert.equal(cleaned.startsWith("Hope this message"), false);
    assert.equal(cleaned.startsWith("I saw your profile"), false);
    assert.ok(cleaned.toLowerCase().includes("your background in data analytics would translate directly"));
  });

  it("adjusts post ranking based on creator scale without hard-deleting mega creators", () => {
    // Peer / Rising Creator Post
    const peerPost: RawPost = {
      authorName: "Ananya Roy",
      postUrl: "https://www.linkedin.com/posts/ananya-roy_discovery-questions-activity-100",
      snippet: "Aspiring PM | today 2h ago How do you approach customer discovery interviews? Any advice for someone breaking into product?",
      source: "mock",
    };
    const peerSignals = evaluatePostSignals(peerPost);
    assert.equal(peerSignals.evidence.creatorScale, "peer_or_rising");

    // Standard Creator Post
    const standardPost: RawPost = {
      authorName: "Rohan Verma",
      postUrl: "https://www.linkedin.com/posts/rohan-verma_discovery-questions-activity-200",
      snippet: "Product Manager at Startup. today 2h ago Sharing how our product team structures customer discovery sprints across quarter milestones.",
      source: "mock",
    };
    const standardSignals = evaluatePostSignals(standardPost);
    assert.equal(standardSignals.evidence.creatorScale, "standard_creator");

    // Mega-Influencer Post
    const megaPost: RawPost = {
      authorName: "Marty Cagan",
      postUrl: "https://www.linkedin.com/posts/marty-cagan_discovery-questions-activity-300",
      snippet: "Partner at Silicon Valley Product Group. Bestselling author. today 2h ago Sharing how our product team structures customer discovery sprints across quarter milestones.",
      source: "mock",
    };
    const megaSignals = evaluatePostSignals(megaPost);
    assert.equal(megaSignals.evidence.creatorScale, "mega_influencer");

    // Verify creator scale ranking modifier:
    // Peer creator gets +10 bonus relative to standard
    assert.ok(peerSignals.overallScore >= standardSignals.overallScore);
    // Mega influencer receives a -15 penalty relative to standard
    assert.ok(megaSignals.overallScore < standardSignals.overallScore);
    // Mega creator is NOT hard-deleted (still has positive score >= 25)
    assert.ok(megaSignals.overallScore >= 25);
    assert.equal(megaSignals.evidence.authorName, "Marty Cagan");
  });
});

