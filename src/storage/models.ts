// Central data models for the Prodily Growth Assistant

// ---------------------------------------------------------------------------
// Status types
// ---------------------------------------------------------------------------

/** Status values for DM/person outreach */
export type PersonStatus =
  | "discovered"     // Found by discovery, not yet reviewed
  | "approved"       // You approved the DM — not yet confirmed sent
  | "contacted"      // You confirmed you manually sent the DM
  | "skipped"        // You chose to skip
  | "not_relevant"   // Explicitly marked as not relevant
  | "do_not_contact"; // Never show again

/** Status values for post comments */
export type CommentStatus =
  | "discovered"      // Found by discovery, not yet reviewed
  | "approved"        // You approved the comment (initial state before publish attempt)
  | "published"       // LinkedIn API confirmed successfully published (HTTP 201)
  | "publish_failed"  // API call failed — manual fallback used
  | "manual_fallback" // No API auth/URN — clipboard+browser shown
  | "skipped";        // You chose to skip

/** Legacy union for backwards compatibility in history.ts helper signatures */
export type ItemStatus = PersonStatus | CommentStatus;

// ---------------------------------------------------------------------------
// Raw candidates from discovery
// ---------------------------------------------------------------------------

export interface RawPerson {
  /** Normalised LinkedIn profile URL */
  profileUrl: string;
  /** Display name as returned by the search result */
  name: string;
  /** Headline / snippet from search result */
  headline: string;
  /** Any extra context snippets provided by the discovery source */
  snippets: string[];
  /** Name of the discovery provider that found this person */
  source: string;
}

export interface RawPost {
  /** Normalised LinkedIn post URL */
  postUrl: string;
  /** Author display name */
  authorName: string;
  /** Post text snippet from search result */
  snippet: string;
  /** Name of the discovery provider */
  source: string;
}

// ---------------------------------------------------------------------------
// AI-enriched outputs
// ---------------------------------------------------------------------------

export interface ScoredPerson {
  name: string;
  profileUrl: string;
  headline: string;
  icpScore: number;       // 0-100
  segment: string;        // e.g. "Career Switcher", "MBA Student"
  whyRelevant: string[];
  painPoints: string[];
  personalizationHook: string;
  suggestedMessage: string;
  confidence: "high" | "medium" | "low";
  warnings: string[];
}

export interface ScoredPost {
  authorName: string;
  postUrl: string;
  postSummary: string;
  relevanceScore: number; // 0-100
  whyRelevant: string;
  suggestedComment: string;
  confidence: "high" | "medium" | "low";
  warnings: string[];
}

// ---------------------------------------------------------------------------
// History records
// ---------------------------------------------------------------------------

export interface HistoryPersonRecord {
  profileUrl: string;
  name: string;
  headline: string;
  icpScore: number;
  segment: string;
  status: PersonStatus;
  discoveredAt: string;  // ISO timestamp
  updatedAt: string;
  suggestedMessage?: string;
  editedMessage?: string;
  notes?: string;
}

export interface HistoryPostRecord {
  postUrl: string;
  authorName: string;
  postSummary: string;
  relevanceScore: number;
  status: CommentStatus;
  discoveredAt: string;
  updatedAt: string;
  suggestedComment?: string;
  editedComment?: string;
  /** LinkedIn comment URN if successfully published via API */
  commentUrn?: string;
  /** Human-readable reason for failure or fallback */
  statusReason?: string;
}

export interface DailyRun {
  runId: string;
  date: string;           // YYYY-MM-DD
  startedAt: string;
  finishedAt?: string;
  peopleDiscovered: number;
  peopleSelected: number;
  peopleApproved: number;
  peopleSkipped: number;
  postsDiscovered: number;
  postsSelected: number;
  commentsApproved: number;
  commentsSkipped: number;
  commentsPublished: number;  // Successfully published via LinkedIn API
  commentsFallback: number;   // Fell back to manual
  errors: string[];
}

export interface HistoryFile {
  version: number;
  people: Record<string, HistoryPersonRecord>; // key = normalised profileUrl
  posts: Record<string, HistoryPostRecord>;    // key = normalised postUrl
  runs: DailyRun[];
}