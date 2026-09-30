/**
 * AI scoring and message generation for people candidates.
 * Grounded in deterministic signals — no fabricated facts or hallucinations.
 */
import { z } from "zod";
import { getAiClient, getMockAiClient, chatJson } from "./client.js";
import { ICP_DEFINITION, MAX_PEOPLE, AI_PROVIDER, FOUNDER_CONTEXT } from "../config.js";
import type { RawPerson, ScoredPerson } from "../storage/models.js";
import type { PeopleScoreBreakdown } from "../signals/types.js";
import { evaluatePeopleSignals } from "../signals/peopleSignals.js";
import { containsFabricatedBackstory, stripFabricatedBackstory } from "./posts.js";

// -- Zod schema ---------------------------------------------------------------

const ScoredPersonSchema = z.object({
  name: z.string(),
  profileUrl: z.string(),
  headline: z.string().default(""),
  icpScore: z.number().min(0).max(100),
  segment: z.string().default("Career Switcher"),
  whyRelevant: z.array(z.string()).default([]),
  painPoints: z.array(z.string()).default([]),
  personalizationHook: z.string().default(""),
  suggestedMessage: z.string(),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
  warnings: z.array(z.string()).default([]),
});

const ScoredPeopleResponseSchema = z.object({
  people: z.array(ScoredPersonSchema),
});

// -- Quality & Segmentation helpers -------------------------------------------

export type OutreachSegment = "Career Switcher" | "Student / APM Aspirant" | "Builder";

export function determineOutreachAngle(
  raw: RawPerson,
  careerStage?: string
): OutreachSegment {
  const text = `${raw.headline} ${(raw.snippets || []).join(" ")}`.toLowerCase();

  // 1. Builder check: building, founder, maker, shipping, indie, side project, creator
  if (/\b(building|builder|founder|co-founder|maker|shipped|shipping|indie|side project|creator)\b/i.test(text)) {
    return "Builder";
  }

  // 2. Student / APM Aspirant check: student, undergrad, grad, mba, apm aspirant, campus
  if (
    careerStage === "student" ||
    /\b(student|undergraduate|graduate student|mba|apm aspirant|aspiring apm|campus|intern)\b/i.test(text)
  ) {
    return "Student / APM Aspirant";
  }

  // 3. Career switcher check: engineers, analysts, designers, consultants, or explicit switchers
  return "Career Switcher";
}

export function cleanSuggestedDm(text: string): string {
  let cleaned = text.trim();
  const openerPatterns = [
    /^(?:hope this message finds you well[!.,]?\s*)/i,
    /^(?:hope you're having a great week[!.,]?\s*)/i,
    /^(?:hope you're doing well[!.,]?\s*)/i,
    /^(?:i came across your profile and (?:noticed|saw)[!.,\s]*)/i,
    /^(?:i saw your profile and wanted to reach out because[!.,\s]*)/i,
  ];
  for (const pat of openerPatterns) {
    cleaned = cleaned.replace(pat, "").trim();
  }
  if (containsFabricatedBackstory(cleaned)) {
    cleaned = stripFabricatedBackstory(cleaned);
  }
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  return cleaned;
}

// -- Main function with batching ---------------------------------------------

const BATCH_SIZE = 10;

export async function scorePeople(
  candidates: RawPerson[],
  deterministicMap?: Map<string, PeopleScoreBreakdown>
): Promise<ScoredPerson[]> {
  if (candidates.length === 0) return [];

  const client =
    (process.env["AI_PROVIDER"] ?? AI_PROVIDER) === "mock"
      ? getMockAiClient()
      : getAiClient();

  // If deterministic signals map not supplied, calculate on the fly
  const signalsMap =
    deterministicMap ||
    new Map(
      candidates.map((c) => [
        c.profileUrl.trim().toLowerCase().replace(/\/$/, ""),
        evaluatePeopleSignals(c),
      ])
    );

  const batches: RawPerson[][] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    batches.push(candidates.slice(i, i + BATCH_SIZE));
  }

  const allScored: ScoredPerson[] = [];

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]!;
    try {
      const scoredBatch = await scorePeopleBatch(
        client,
        batch,
        signalsMap,
        b + 1,
        batches.length
      );
      allScored.push(...scoredBatch);
    } catch (err) {
      console.warn(
        `[ai/people] Candidate batch ${b + 1}/${batches.length} (${batch.length} people) failed after retries: ${String(err)}. Skipping batch.`
      );
    }
  }

  return allScored
    .filter((p) => p.icpScore >= 40)
    .sort((a, b) => b.icpScore - a.icpScore)
    .slice(0, MAX_PEOPLE);
}

async function scorePeopleBatch(
  client: ReturnType<typeof getAiClient>,
  batch: RawPerson[],
  signalsMap: Map<string, PeopleScoreBreakdown>,
  batchNum: number,
  totalBatches: number
): Promise<ScoredPerson[]> {
  const candidateList = batch
    .map((p, i) => {
      const key = p.profileUrl.trim().toLowerCase().replace(/\/$/, "");
      const sig = signalsMap.get(key);
      const stageStr = sig?.evidence.careerStage || "unknown";
      const intentStr = sig?.evidence.pmIntentEvidence || "unspecified";
      const actStr = sig?.evidence.activityEvidence || "unknown";
      const needStr = sig?.evidence.learningOrSwitchingNeed || "unspecified";
      const angle = determineOutreachAngle(p, stageStr);

      return (
        "[" + (i + 1) + "] Name: " + p.name + "\n" +
        "    profileUrl: " + p.profileUrl + "\n" +
        "    Headline: " + p.headline + "\n" +
        "    Snippets: " + (p.snippets.join(" | ") || "(none)") + "\n" +
        "    Recommended Outreach Angle: " + angle + "\n" +
        "    Grounded Career Stage: " + stageStr + "\n" +
        "    PM Intent Evidence: " + intentStr + "\n" +
        "    Activity Evidence: " + actStr + "\n" +
        "    Learning / Switching Need: " + needStr + "\n" +
        "    Source: " + p.source
      );
    })
    .join("\n\n");

  const systemPrompt = [
    "You are writing founder-to-peer outreach messages on behalf of Aditya Gangwani, founder of Prodily.",
    "",
    FOUNDER_CONTEXT.promptBlock,
    "",
    ICP_DEFINITION,
    "",
    "OUTREACH ANGLES (Select and apply the designated angle per candidate):",
    "",
    "1. CAREER SWITCHERS (Engineers, Analysts, Designers, Consultants moving to PM):",
    "   - Focus: Explain how Prodily helps translate their existing domain experience",
    "     into PM portfolio evidence, structured case studies, and PRDs.",
    "   - Tone: Professional, peer-to-peer, recognizing their functional strengths.",
    "",
    "2. STUDENTS / APM ASPIRANTS (Students, MBA candidates, APM seekers):",
    "   - Focus: Structured practice, product sense, execution, interview prep, and",
    "     building demonstrable evidence of PM ability.",
    "   - Tone: Encouraging, practical, coaching/peer vibe.",
    "",
    "3. BUILDERS (Founders, side-project builders, indie makers):",
    "   - Focus: Peer-to-peer connection around what they are building or shipping.",
    "   - Angle: How Prodily provides structured product strategy and prioritisation",
    "     alongside their active building work.",
    "   - Tone: Builder-to-builder, concise, no fluff.",
    "",
    "STRICT DM QUALITY RULES (PREVENT TEMPLATE COLLAPSE):",
    "- MENTION SPECIFIC DETAILS: Ground the message in a genuinely specific detail from their",
    "  headline or snippets (their specific background, university, project, or role) whenever available.",
    "- NEVER FABRICATE: Never invent facts, projects, or background not found in the profile.",
    "- STRICT FOUNDER CONTEXT: Never invent past employers, previous roles, or past career transitions for Aditya.",
    "- EXPLAIN SPECIFIC VALUE: Explain why Prodily is useful specifically to their situation.",
    "- NEVER ASK FOR FEEDBACK FIRST: Do not ask for feedback before establishing clear value.",
    "- AVOID MASS TEMPLATES: Strictly avoid robotic openers like 'Hope you are doing well',",
    "  'I came across your profile and noticed', or 'I was impressed by'. Vary sentence structure naturally.",
    "- CONCISE & HUMAN: Max 3 to 4 sentences. Write like an authentic human founder reaching out 1-on-1.",
    "- Score icpScore 0-100.",
    "",
    "Respond with ONLY valid JSON in this exact shape (no markdown fences):",
    '{"people":[{"name":"...","profileUrl":"...","headline":"...","icpScore":85,"segment":"Career Switcher|Student / APM Aspirant|Builder","whyRelevant":["..."],"painPoints":["..."],"personalizationHook":"...","suggestedMessage":"...","confidence":"high|medium|low","warnings":[]}]}',
  ].join("\n");

  const userPrompt = `Score and rank these ${batch.length} LinkedIn profile candidates:\n\n${candidateList}`;

  const result = await chatJson(
    client,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    (raw) => ScoredPeopleResponseSchema.parse(raw),
    {
      expectedShapeHint: '{"people":[{"name":"...","profileUrl":"...","headline":"...","icpScore":85,"segment":"...","whyRelevant":[],"painPoints":[],"personalizationHook":"...","suggestedMessage":"...","confidence":"high|medium|low","warnings":[]}]}',
    }
  );

  return result.people.map((p) => {
    let msg = cleanSuggestedDm(p.suggestedMessage);
    const warnings = [...(p.warnings || [])];
    if (containsFabricatedBackstory(msg)) {
      msg = stripFabricatedBackstory(msg);
      warnings.push("Prevented fabricated first-person backstory");
    }
    return {
      ...p,
      suggestedMessage: msg,
      warnings,
    };
  });
}