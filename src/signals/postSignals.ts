/**
 * Deterministic signal evaluation and scoring for LinkedIn posts.
 * Filters low-quality / stale / promotional content before AI scoring.
 */
import type { RawPost } from "../storage/models.js";
import type {
  EvidenceStatus,
  PostDeterministicEvidence,
  PostScoreBreakdown,
} from "./types.js";

// Positive discussion & conversation triggers
const CONVERSATION_TRIGGERS = [
  /\?/,
  /\bwhat do you think\b/i,
  /\bhow do you (?:approach|handle|structure|decide)\b/i,
  /\bany advice\b/i,
  /\bthoughts\?/i,
  /\bseeking (?:feedback|suggestions|recommendations)\b/i,
  /\banyone else (?:struggling|facing|experiencing)\b/i,
  /\bcurious to hear\b/i,
  /\bwould love to know\b/i,
  /\bwhat framework\b/i,
  /\bhow should i\b/i,
  /\bmock interview\b/i,
  /\bcase study prep\b/i,
];

// Negative broadcast / promotional patterns
const BROADCAST_EXCLUSIONS = [
  /\bwe are hiring\b/i,
  /\bwe're hiring\b/i,
  /\bjob alert\b/i,
  /\bjob opening\b/i,
  /\bjoin our team\b/i,
  /\bcheck out our new feature\b/i,
  /\bdiscount code\b/i,
  /\bwebinar tomorrow\b/i,
  /\bpress release\b/i,
];

// Relative date / freshness patterns
const FRESH_RELATIVE_PATTERNS = [
  /\b(\d+\s*(?:m|min|minute|minutes|h|hour|hours|d|day|days)\s*ago)\b/i,
  /\b(today|yesterday|just now)\b/i,
  /\b(\d+\s*(?:w|week|weeks)\s*ago)\b/i,
];

const STALE_DATE_PATTERNS = [
  /\b(\d+\s*(?:mo|month|months|y|year|years)\s*ago)\b/i,
  /\b(?:2020|2021|2022|2023)\b/,
];

// Relevant PM topics
const PM_TOPICS = [
  { name: "Interview Preparation", pattern: /\b(mock interview|case study|pm interview|product sense|execution questions)\b/i },
  { name: "Portfolio & Projects", pattern: /\b(pm portfolio|product teardown|side project|capstone|prd)\b/i },
  { name: "Breaking Into PM / Transition", pattern: /\b(breaking into product|transitioning to pm|aspiring pm|career switch)\b/i },
  { name: "PM Frameworks & Skills", pattern: /\b(prioritisation|roadmap|metrics|user research|jobs to be done|ice|rice)\b/i },
  { name: "Learning Resources", pattern: /\b(learning pm|product books|cagan|lenny|reforge|coursera)\b/i },
];

export function extractAuthorProfileUrlFromPostUrl(postUrl: string): string | null {
  try {
    const u = new URL(postUrl);
    // Patterns like /posts/author-name_slug-activity-12345
    const match = u.pathname.match(/\/posts\/([a-zA-Z0-9_-]+?)_/);
    if (match?.[1]) {
      return `https://www.linkedin.com/in/${match[1]}`;
    }
    return null;
  } catch {
    return null;
  }
}

export function evaluatePostSignals(
  raw: RawPost,
  options: {
    alreadyCommented?: boolean;
    isDuplicate?: boolean;
  } = {}
): PostScoreBreakdown {
  const text = `${raw.authorName} ${raw.snippet}`.toLowerCase();

  // 1. Topic Identification
  let topic = "General Product Management";
  for (const t of PM_TOPICS) {
    if (t.pattern.test(raw.snippet)) {
      topic = t.name;
      break;
    }
  }

  // 2. Canonical URL & Author Profile URL
  let canonicalPostUrl = raw.postUrl;
  try {
    const u = new URL(raw.postUrl);
    canonicalPostUrl = (u.origin + u.pathname).replace(/\/$/, "").toLowerCase();
  } catch {
    canonicalPostUrl = raw.postUrl.trim().toLowerCase();
  }
  const authorProfileUrl = extractAuthorProfileUrlFromPostUrl(raw.postUrl);

  // 3. Freshness & Date Detection
  let freshnessStatus: EvidenceStatus = "unknown";
  let dateEvidence = "No post timestamp found in public snippet";
  let isTooOld = false;
  let freshnessScore = 50; // default unknown

  const freshMatch = raw.snippet.match(FRESH_RELATIVE_PATTERNS[0]!) || raw.snippet.match(FRESH_RELATIVE_PATTERNS[1]!);
  const staleMatch = raw.snippet.match(STALE_DATE_PATTERNS[0]!) || raw.snippet.match(STALE_DATE_PATTERNS[1]!);

  if (freshMatch) {
    freshnessStatus = "verified";
    dateEvidence = `Recent timestamp detected in search snippet: "${freshMatch[0]}"`;
    freshnessScore = 95;
    isTooOld = false;
  } else if (staleMatch) {
    freshnessStatus = "verified";
    dateEvidence = `Post date appears older than desirable: "${staleMatch[0]}"`;
    freshnessScore = 20;
    isTooOld = true;
  } else if (raw.snippet.includes("ago")) {
    freshnessStatus = "inferred";
    dateEvidence = "Snippet contains relative time markers";
    freshnessScore = 70;
  }

  // 4. Conversation / Discussion Signal
  let conversationStatus: EvidenceStatus = "unknown";
  let conversationEvidence = "No explicit question or discussion trigger detected";
  let conversationScore = 40;

  const hasExclusion = BROADCAST_EXCLUSIONS.some((p) => p.test(raw.snippet));
  if (hasExclusion) {
    conversationStatus = "verified";
    conversationEvidence = "Broadcast, recruitment, or commercial announcement";
    conversationScore = 15;
  } else {
    const triggerMatch = CONVERSATION_TRIGGERS.find((p) => p.test(raw.snippet));
    if (triggerMatch) {
      conversationStatus = "verified";
      conversationEvidence = "Contains direct question or request for feedback/discussion";
      conversationScore = 90;
    } else if (
      raw.snippet.includes("learn") ||
      raw.snippet.includes("experience") ||
      raw.snippet.includes("journey") ||
      raw.snippet.includes("struggle")
    ) {
      conversationStatus = "inferred";
      conversationEvidence = "Personal reflective post conducive to insightful comment";
      conversationScore = 75;
    }
  }

  // 5. Audience Relevance Signal
  let relevanceStatus: EvidenceStatus = "unknown";
  let relevanceEvidence = "General LinkedIn post snippet";
  let relevanceScore = 45;

  let topicMatches = 0;
  for (const t of PM_TOPICS) {
    if (t.pattern.test(raw.snippet)) topicMatches++;
  }

  if (topicMatches >= 2) {
    relevanceStatus = "verified";
    relevanceEvidence = `Strong match with Prodily target audience (${topic})`;
    relevanceScore = 92;
  } else if (topicMatches === 1) {
    relevanceStatus = "verified";
    relevanceEvidence = `Direct match with PM topic: ${topic}`;
    relevanceScore = 80;
  } else if (text.includes("product") || text.includes("pm")) {
    relevanceStatus = "inferred";
    relevanceEvidence = "Contains generic product keywords";
    relevanceScore = 60;
  }

  // 6. Author Activity Signal
  let authorActivityStatus: EvidenceStatus = "unknown";
  let authorActivityEvidence = "No direct activity logs available from public search snippet";
  let activityScore = 50;

  if (freshnessStatus === "verified" && !isTooOld) {
    authorActivityStatus = "verified";
    authorActivityEvidence = `Author posted recent content (${dateEvidence})`;
    activityScore = 85;
  } else if (freshnessStatus === "inferred") {
    authorActivityStatus = "inferred";
    authorActivityEvidence = "Author appears active based on search engine indexing";
    activityScore = 70;
  }

  // 7. Engagement Evidence
  let engagementEvidence = "unknown";
  const engageMatch = raw.snippet.match(/(\d+[\d,.]*)\s*(?:reactions|likes|comments)/i);
  if (engageMatch) {
    engagementEvidence = `Snippet displays engagement: "${engageMatch[0]}"`;
  }

  // 8. Overall Composite Score
  // 35% relevance + 25% conversation + 20% freshness + 20% activity
  let overallScore = Math.round(
    0.35 * relevanceScore +
      0.25 * conversationScore +
      0.20 * freshnessScore +
      0.20 * activityScore
  );

  // Penalize stale or excluded posts
  if (isTooOld) overallScore = Math.min(overallScore, 40);
  if (hasExclusion) overallScore = Math.min(overallScore, 30);
  if (options.alreadyCommented) overallScore = 0;

  const evidence: PostDeterministicEvidence = {
    canonicalPostUrl,
    authorName: raw.authorName,
    authorProfileUrl,
    topic,
    dateEvidence,
    freshnessStatus,
    isTooOld,
    conversationStatus,
    conversationEvidence,
    relevanceStatus,
    relevanceEvidence,
    authorActivityStatus,
    authorActivityEvidence,
    engagementEvidence,
    alreadyCommented: !!options.alreadyCommented,
    isDuplicate: !!options.isDuplicate,
  };

  return {
    relevanceScore,
    activityScore,
    conversationScore,
    freshnessScore,
    overallScore,
    evidence,
  };
}
