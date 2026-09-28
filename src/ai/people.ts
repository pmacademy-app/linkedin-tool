/**
 * AI scoring and message generation for people candidates.
 * Grounded in deterministic signals — no fabricated facts or hallucinations.
 */
import { z } from "zod";
import { getAiClient, getMockAiClient, chatJson } from "./client.js";
import { ICP_DEFINITION, MAX_PEOPLE, AI_PROVIDER } from "../config.js";
import type { RawPerson, ScoredPerson } from "../storage/models.js";
import type { PeopleScoreBreakdown } from "../signals/types.js";
import { evaluatePeopleSignals } from "../signals/peopleSignals.js";

// -- Zod schema ---------------------------------------------------------------

const ScoredPersonSchema = z.object({
  name: z.string(),
  profileUrl: z.string().url(),
  headline: z.string(),
  icpScore: z.number().min(0).max(100),
  segment: z.string(),
  whyRelevant: z.array(z.string()),
  painPoints: z.array(z.string()),
  personalizationHook: z.string(),
  suggestedMessage: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  warnings: z.array(z.string()),
});

const ScoredPeopleResponseSchema = z.object({
  people: z.array(ScoredPersonSchema),
});

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

      return (
        "[" + (i + 1) + "] Name: " + p.name + "\n" +
        "    profileUrl: " + p.profileUrl + "\n" +
        "    Headline: " + p.headline + "\n" +
        "    Snippets: " + (p.snippets.join(" | ") || "(none)") + "\n" +
        "    Grounded Career Stage: " + stageStr + "\n" +
        "    PM Intent Evidence: " + intentStr + "\n" +
        "    Activity Evidence: " + actStr + "\n" +
        "    Learning / Switching Need: " + needStr + "\n" +
        "    Source: " + p.source
      );
    })
    .join("\n\n");

  const systemPrompt = [
    "You are a growth assistant for Prodily, a free structured Product Management",
    "learning platform for aspiring PMs.",
    "",
    ICP_DEFINITION,
    "",
    "IMPORTANT RULES:",
    "- Do NOT invent any personal information. Only use the data and grounded signals provided below.",
    "- If you cannot personalise due to insufficient information, say so in the",
    "  warnings field and write a conservative, generic message.",
    "- The suggested DM must be short (max 5 sentences), natural, non-spammy,",
    "  founder-to-person in tone. Goal: invite the person to try Prodily and give",
    "  honest feedback. Do NOT use fake familiarity, false claims, or pressure.",
    "- Do NOT use manipulative language, urgency, fake social proof, or misleading statements.",
    "- Score icpScore 0-100.",
    "",
    "Respond with ONLY valid JSON in this exact shape (no markdown fences):",
    '{"people":[{"name":"...","profileUrl":"...","headline":"...","icpScore":85,"segment":"Career Switcher","whyRelevant":["reason 1"],"painPoints":["pain 1"],"personalizationHook":"...","suggestedMessage":"...","confidence":"high","warnings":[]}]}',
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

  return result.people;
}