/**
 * Deterministic signal evaluation and scoring for people candidates.
 * Extracts grounded signals without fabricating facts or hallucinating activity.
 */
import type { RawPerson } from "../storage/models.js";
import type {
  CareerStage,
  EvidenceStatus,
  PeopleDeterministicEvidence,
  PeopleScoreBreakdown,
} from "./types.js";

// Exclusion patterns: senior PMs, directors, recruiters, marketing agencies
const EXCLUSION_PATTERNS = [
  /\b(director of product|vp of product|vice president|cpo|chief product officer|head of product)\b/i,
  /\b(senior product manager|lead product manager|principal product manager|staff product manager)\b/i,
  /\b(technical recruiter|talent acquisition|recruiting|headhunter|hr manager)\b/i,
  /\b(founder & ceo|venture capital|managing director|partner at)\b/i,
  /\b(agency|consultancy firm|saas platform|company page)\b/i,
];

// High intent patterns: explicit desire to break into or learn PM
const EXPLICIT_INTENT_PATTERNS = [
  /\baspiring (?:pm|product manager)\b/i,
  /\bbreaking into (?:product|pm|product management)\b/i,
  /\btransitioning to (?:product|pm|product management)\b/i,
  /\bwant(?:ing)? to be a (?:pm|product manager)\b/i,
  /\bseeking (?:entry level|associate|apm) product\b/i,
  /\blearning (?:product management|pm)\b/i,
  /\bpm aspirant\b/i,
  /\bapm aspirant\b/i,
  /\bexploring (?:pm|product management)\b/i,
];

// Career switch patterns: current technical/design/analytical role moving to PM
const CAREER_SWITCHER_ROLES = [
  /\b(software engineer|developer|sde|frontend|backend|fullstack|qa engineer)\b/i,
  /\b(ui\/ux|ux designer|product designer|graphic designer)\b/i,
  /\b(data analyst|business analyst|bi analyst|analytics)\b/i,
  /\b(project manager|scrum master|agile coach)\b/i,
  /\b(marketing manager|operations|consultant)\b/i,
];

// Student / MBA patterns
const STUDENT_PATTERNS = [
  /\b(mba|iim|isb|stanford|harvard|wharton|insofe|b-school)\b/i,
  /\b(student|graduate student|undergraduate|university|college|intern)\b/i,
  /\b(cs student|engineering student|b\.tech|btech|mtech)\b/i,
];

// APM / Early PM patterns (0-2 years)
const EARLY_PM_PATTERNS = [
  /\b(associate product manager|junior product manager|apm|product management intern)\b/i,
];

// PM learning / certification signals
const PM_LEARNING_PATTERNS = [
  /\b(reforge|google pm certificate|coursera pm|product school|upraised|pragmatic institute)\b/i,
  /\b(pm interview|case study|prd|roadmap|product frameworks)\b/i,
  /\b(pm portfolio|product teardown|mock interview)\b/i,
];

export function evaluatePeopleSignals(raw: RawPerson): PeopleScoreBreakdown {
  const fullText = [
    raw.name,
    raw.headline,
    ...(raw.snippets || []),
  ].join(" ").toLowerCase();

  // 1. Check exclusions
  for (const pattern of EXCLUSION_PATTERNS) {
    const match = raw.headline.match(pattern);
    if (match) {
      const evidence: PeopleDeterministicEvidence = {
        canonicalProfileUrl: raw.profileUrl,
        name: raw.name,
        headline: raw.headline,
        careerStage: "senior_or_excluded",
        careerStageEvidence: `Matched exclusion filter: "${match[0]}"`,
        pmIntentStatus: "unknown",
        pmIntentEvidence: "Excluded profile",
        activityStatus: "unknown",
        activityEvidence: "Excluded profile",
        profileCompleteness: "low",
        profileCompletenessEvidence: "Profile filtered out",
        learningOrSwitchingNeed: "None (Senior/Recruiter role)",
        isExcluded: true,
        exclusionReason: `Senior role or recruiter detected: "${match[0]}"`,
      };

      return {
        icpScore: 10,
        activityScore: 20,
        intentScore: 10,
        overallScore: 10,
        evidence,
      };
    }
  }

  // 2. Determine Career Stage
  let careerStage: CareerStage = "non_pm_professional";
  let careerStageEvidence = "Professional with interest in product";

  const isEarlyPm = EARLY_PM_PATTERNS.some((p) => p.test(raw.headline));
  const isStudent = STUDENT_PATTERNS.some((p) => p.test(raw.headline));
  const isSwitcher = CAREER_SWITCHER_ROLES.some((p) => p.test(raw.headline));

  if (isEarlyPm) {
    careerStage = "early_career_pm";
    careerStageEvidence = "Associate or Junior Product Manager role detected";
  } else if (isStudent) {
    careerStage = "student";
    careerStageEvidence = "Student or MBA candidate targeting PM roles";
  } else if (isSwitcher) {
    careerStage = "career_switcher";
    careerStageEvidence = "Technical/Design/Business background transitioning to PM";
  }

  // 3. Determine PM Intent
  let pmIntentStatus: EvidenceStatus = "unknown";
  let pmIntentEvidence = "No explicit PM intent found in public snippet";
  let intentScore = 30;

  const hasExplicitIntent = EXPLICIT_INTENT_PATTERNS.some((p) => p.test(raw.headline) || p.test(fullText));
  const hasLearningSignal = PM_LEARNING_PATTERNS.some((p) => p.test(fullText));

  if (hasExplicitIntent) {
    pmIntentStatus = "verified";
    pmIntentEvidence = "Public headline explicitly expresses aspiring or transitioning PM intent";
    intentScore = 90;
  } else if (hasLearningSignal || isEarlyPm) {
    pmIntentStatus = "inferred";
    pmIntentEvidence = "PM courses, certifications, or APM role indicate product career focus";
    intentScore = 75;
  } else if (fullText.includes("product") || fullText.includes("pm")) {
    pmIntentStatus = "inferred";
    pmIntentEvidence = "Mentions product management concepts in profile snippet";
    intentScore = 55;
  }

  // 4. Activity Evidence (Strictly grounded: never invent activity!)
  let activityStatus: EvidenceStatus = "unknown";
  let activityEvidence = "No recent activity or post date found in public search snippet";
  let activityScore = 40; // Default neutral score when unverified

  // Check for recent activity markers in snippet (e.g. "ago", "recent", "completed")
  const recentRegex = /\b(\d+\s*(?:d|day|days|h|hour|hours|w|week|weeks|mo|month|months)\s*ago)\b/i;
  const recentMatch = fullText.match(recentRegex);

  if (recentMatch) {
    activityStatus = "verified";
    activityEvidence = `Public search snippet contains recent timeline marker: "${recentMatch[0]}"`;
    activityScore = 85;
  } else if (
    fullText.includes("currently") ||
    fullText.includes("present") ||
    fullText.includes("incoming")
  ) {
    activityStatus = "inferred";
    activityEvidence = "Profile snippet indicates active current enrollment or transition";
    activityScore = 70;
  }

  // 5. Profile Completeness
  let profileCompleteness: "high" | "medium" | "low" = "medium";
  let completenessEvidence = "Standard headline and search snippet available";

  if (raw.headline.length > 50 && (raw.snippets?.length || 0) > 0) {
    profileCompleteness = "high";
    completenessEvidence = "Detailed headline with rich context snippets";
  } else if (raw.headline.length < 20) {
    profileCompleteness = "low";
    completenessEvidence = "Minimal headline with limited context";
  }

  // 6. Calculate ICP Score
  let icpScore = 50;
  if (careerStage === "career_switcher" && pmIntentStatus === "verified") {
    icpScore = 92;
  } else if (careerStage === "student" && pmIntentStatus === "verified") {
    icpScore = 88;
  } else if (careerStage === "early_career_pm") {
    icpScore = 85;
  } else if (pmIntentStatus === "verified") {
    icpScore = 82;
  } else if (pmIntentStatus === "inferred") {
    icpScore = 70;
  } else {
    icpScore = 45;
  }

  // 7. Learning / Switching Need
  let learningOrSwitchingNeed = "Practicing structured PM fundamentals";
  if (careerStage === "career_switcher") {
    learningOrSwitchingNeed = "Translating existing domain experience into structured PM execution";
  } else if (careerStage === "student") {
    learningOrSwitchingNeed = "Building real PM portfolio and interview case studies";
  } else if (careerStage === "early_career_pm") {
    learningOrSwitchingNeed = "Mastering advanced frameworks, PRDs, and prioritisation";
  }

  // 8. Overall Composite Score (weighted)
  // 40% ICP alignment + 35% PM intent + 25% activity/presence
  const overallScore = Math.round(
    0.4 * icpScore + 0.35 * intentScore + 0.25 * activityScore
  );

  const evidence: PeopleDeterministicEvidence = {
    canonicalProfileUrl: raw.profileUrl,
    name: raw.name,
    headline: raw.headline,
    careerStage,
    careerStageEvidence,
    pmIntentStatus,
    pmIntentEvidence,
    activityStatus,
    activityEvidence,
    profileCompleteness,
    profileCompletenessEvidence: completenessEvidence,
    learningOrSwitchingNeed,
    isExcluded: false,
    exclusionReason: null,
  };

  return {
    icpScore,
    activityScore,
    intentScore,
    overallScore,
    evidence,
  };
}
