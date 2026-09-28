/**
 * Types and interfaces for deterministic quality signals and evidence.
 */

export type EvidenceStatus = "verified" | "inferred" | "unknown";

// ---------------------------------------------------------------------------
// People Deterministic Signals & Evidence
// ---------------------------------------------------------------------------

export type CareerStage =
  | "student"
  | "career_switcher"
  | "early_career_pm"
  | "non_pm_professional"
  | "senior_or_excluded";

export interface PeopleDeterministicEvidence {
  canonicalProfileUrl: string;
  name: string;
  headline: string;
  careerStage: CareerStage;
  careerStageEvidence: string;
  pmIntentStatus: EvidenceStatus;
  pmIntentEvidence: string;
  activityStatus: EvidenceStatus;
  activityEvidence: string;
  profileCompleteness: "high" | "medium" | "low";
  profileCompletenessEvidence: string;
  learningOrSwitchingNeed: string;
  isExcluded: boolean;
  exclusionReason?: string | null;
}

export interface PeopleScoreBreakdown {
  icpScore: number;       // 0-100: Alignment with aspiring PM / switcher / student
  activityScore: number;  // 0-100: Evidence of recent LinkedIn activity / presence
  intentScore: number;    // 0-100: Stated or demonstrated intent to learn/break into PM
  overallScore: number;   // 0-100: Weighted combination
  evidence: PeopleDeterministicEvidence;
}

// ---------------------------------------------------------------------------
// Post Deterministic Signals & Evidence
// ---------------------------------------------------------------------------

export interface PostDeterministicEvidence {
  canonicalPostUrl: string;
  authorName: string;
  authorProfileUrl: string | null;
  topic: string;
  dateEvidence: string;
  freshnessStatus: EvidenceStatus;
  isTooOld: boolean;
  conversationStatus: EvidenceStatus;
  conversationEvidence: string;
  relevanceStatus: EvidenceStatus;
  relevanceEvidence: string;
  authorActivityStatus: EvidenceStatus;
  authorActivityEvidence: string;
  engagementEvidence: string;
  alreadyCommented: boolean;
  isDuplicate: boolean;
}

export interface PostScoreBreakdown {
  relevanceScore: number;     // 0-100: Relevance to PM learning / career / audience
  activityScore: number;      // 0-100: Activity level of author / content
  conversationScore: number;  // 0-100: Whether it invites discussion vs broadcast
  freshnessScore: number;     // 0-100: Age of post / recent content
  overallScore: number;       // 0-100: Weighted combination
  evidence: PostDeterministicEvidence;
}
