/**
 * AI scoring and comment generation for post candidates.
 * Enforces authentic, high-value, non-spam comments grounded in the post.
 */
import { z } from "zod";
import { getAiClient, getMockAiClient, chatJson } from "./client.js";
import { ICP_DEFINITION, MAX_POSTS, AI_PROVIDER } from "../config.js";
import type { RawPost, ScoredPost } from "../storage/models.js";
import type { PostScoreBreakdown } from "../signals/types.js";
import { evaluatePostSignals } from "../signals/postSignals.js";

// -- Zod schema ---------------------------------------------------------------

const ScoredPostSchema = z.object({
  authorName: z.string(),
  postUrl: z.string().url(),
  postSummary: z.string(),
  relevanceScore: z.number().min(0).max(100),
  whyRelevant: z.string(),
  suggestedComment: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  warnings: z.array(z.string()),
});

const ScoredPostsResponseSchema = z.object({
  posts: z.array(ScoredPostSchema),
});

// -- Main function with batching ---------------------------------------------

const BATCH_SIZE = 10;

export async function scorePosts(
  candidates: RawPost[],
  deterministicMap?: Map<string, PostScoreBreakdown>
): Promise<ScoredPost[]> {
  if (candidates.length === 0) return [];

  const client =
    (process.env["AI_PROVIDER"] ?? AI_PROVIDER) === "mock"
      ? getMockAiClient()
      : getAiClient();

  const signalsMap =
    deterministicMap ||
    new Map(
      candidates.map((c) => [
        c.postUrl.trim().toLowerCase().replace(/\/$/, ""),
        evaluatePostSignals(c),
      ])
    );

  const batches: RawPost[][] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    batches.push(candidates.slice(i, i + BATCH_SIZE));
  }

  const allScored: ScoredPost[] = [];

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]!;
    try {
      const scoredBatch = await scorePostsBatch(
        client,
        batch,
        signalsMap,
        b + 1,
        batches.length
      );
      allScored.push(...scoredBatch);
    } catch (err) {
      console.warn(
        `[ai/posts] Post batch ${b + 1}/${batches.length} (${batch.length} posts) failed after retries: ${String(err)}. Skipping batch.`
      );
    }
  }

  return allScored
    .filter((p) => p.relevanceScore >= 45)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, MAX_POSTS);
}

async function scorePostsBatch(
  client: ReturnType<typeof getAiClient>,
  batch: RawPost[],
  signalsMap: Map<string, PostScoreBreakdown>,
  batchNum: number,
  totalBatches: number
): Promise<ScoredPost[]> {
  const candidateList = batch
    .map((p, i) => {
      const key = p.postUrl.trim().toLowerCase().replace(/\/$/, "");
      const sig = signalsMap.get(key);
      const topicStr = sig?.evidence.topic || "Product Management";
      const convStr = sig?.evidence.conversationEvidence || "None detected";
      const relStr = sig?.evidence.relevanceEvidence || "None detected";
      const dateStr = sig?.evidence.dateEvidence || "Unknown";

      return (
        "[" + (i + 1) + "] Author: " + p.authorName + "\n" +
        "    postUrl: " + p.postUrl + "\n" +
        "    Snippet: " + p.snippet + "\n" +
        "    Topic: " + topicStr + "\n" +
        "    Conversation Signal: " + convStr + "\n" +
        "    Relevance Signal: " + relStr + "\n" +
        "    Date / Freshness Signal: " + dateStr + "\n" +
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
    "TASK: Select and rank LinkedIn posts where a genuine, value-adding comment can",
    "be made. Prioritise posts about aspiring PMs, learning PM, PM interviews,",
    "PM career transitions, PM portfolios, and practical PM skills.",
    "",
    "STRICT COMMENT GENERATION RULES (CRITICAL):",
    "- Add genuine, specific value by answering questions or expanding on their point.",
    "- Reference specific concepts from the actual post.",
    "- NEVER use generic praise (e.g. 'Great post!', 'Thanks for sharing!', 'So insightful!').",
    "- Avoid promotional spam. Do NOT mention Prodily unless contextually completely appropriate and natural.",
    "- NEVER fabricate personal work experience or fake authority.",
    "- Keep suggested comments concise (2 to 4 sentences max) — LinkedIn comments must be readable.",
    "- Sound like a real, thoughtful human practitioner.",
    "- Score relevanceScore 0-100.",
    "",
    "Respond with ONLY valid JSON (no markdown fences):",
    '{"posts":[{"authorName":"...","postUrl":"...","postSummary":"...","relevanceScore":78,"whyRelevant":"...","suggestedComment":"...","confidence":"medium","warnings":[]}]}',
  ].join("\n");

  const userPrompt = `Score and select from these ${batch.length} LinkedIn post candidates:\n\n${candidateList}`;

  const result = await chatJson(
    client,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    (raw) => ScoredPostsResponseSchema.parse(raw),
    {
      expectedShapeHint: '{"posts":[{"authorName":"...","postUrl":"...","postSummary":"...","relevanceScore":78,"whyRelevant":"...","suggestedComment":"...","confidence":"high|medium|low","warnings":[]}]}',
    }
  );

  return result.posts;
}