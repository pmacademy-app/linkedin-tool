/**
 * AI scoring and comment generation for post candidates.
 * Enforces authentic, high-value, non-spam comments grounded in the post.
 */
import { z } from "zod";
import { getAiClient, getMockAiClient, chatJson } from "./client.js";
import { ICP_DEFINITION, MAX_POSTS, AI_PROVIDER, FOUNDER_CONTEXT } from "../config.js";
import type { RawPost, ScoredPost } from "../storage/models.js";
import type { PostScoreBreakdown } from "../signals/types.js";
import { evaluatePostSignals } from "../signals/postSignals.js";

// -- Zod schema ---------------------------------------------------------------

const ScoredPostSchema = z.object({
  authorName: z.string(),
  postUrl: z.string(),
  postSummary: z.string().default(""),
  relevanceScore: z.number().min(0).max(100),
  whyRelevant: z.string().default(""),
  suggestedComment: z.string(),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
  warnings: z.array(z.string()).default([]),
});

const ScoredPostsResponseSchema = z.object({
  posts: z.array(ScoredPostSchema),
});

// -- Quality helpers ----------------------------------------------------------

export function cleanSuggestedComment(text: string): string {
  let cleaned = text.trim();
  // Strip common generic flattering / robotic openers if present
  const openerPatterns = [
    /^(?:great post|thanks for sharing|so insightful|love this post|such an important topic|spot on|agreed 100%|couldn't agree more)[!.,\s]+/i,
    /^(?:your point (?:about|on) [^.!?]+ resonates(?: with me)?[!.,\s]*)/i,
    /^(?:your point (?:about|on) [^.!?]+[.!?]\s*)/i,
    /^(?:your call (?:for|to) [^.!?]+ is spot on[!.,\s]*)/i,
    /^(?:your call (?:for|to) [^.!?]+[.!?]\s*)/i,
    /^(?:i appreciate (?:this|the) [^.!?]+[.!?]\s*)/i,
    /^(?:this resonates deeply[!.,\s]+)/i,
    /^(?:i really (?:like|love) (?:how you|your)[!.,\s]+)/i,
    /^(?:starting with .+? is key[!.,\s]+)/i,
    /^(?:choosing the right .+? is crucial[!.,\s]+)/i,
    /^(?:curating a .+? is essential[!.,\s]+)/i,
    /^(?:you highlight that [^.!?]+[.!?]\s*)/i,
  ];
  for (const pat of openerPatterns) {
    cleaned = cleaned.replace(pat, "").trim();
  }
  // Capitalize first character
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  return cleaned;
}

export function containsFabricatedBackstory(text: string): boolean {
  const patterns = [
    /\bwhen i was an? (?:engineer|analyst|developer|designer|sde|pm|product manager|consultant)\b/i,
    /\bin my previous company\b/i,
    /\bat my last job\b/i,
    /\bin my own journey\b/i,
    /\bin my career\b/i,
    /\b(?:on|in) my team\b/i,
    /\bmy analytics background\b/i,
    /\bmy engineering background\b/i,
    /\bwhen transitioning from engineering\b/i,
    /\bwhen i worked at\b/i,
  ];
  return patterns.some((p) => p.test(text));
}

export function stripFabricatedBackstory(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const filtered = sentences.filter((s) => !containsFabricatedBackstory(s));
  if (filtered.length > 0) {
    return filtered.join(" ").trim();
  }
  let cleaned = text;
  const patterns = [
    /\bwhen i was an? (?:engineer|analyst|developer|designer|sde|pm|product manager|consultant)[^,.!?]*[,.]?\s*/gi,
    /\bin my previous company[^,.!?]*[,.]?\s*/gi,
    /\bat my last job[^,.!?]*[,.]?\s*/gi,
    /\bin my own journey[^,.!?]*[,.]?\s*/gi,
    /\bin my career[^,.!?]*[,.]?\s*/gi,
    /\b(?:on|in) my team[^,.!?]*[,.]?\s*/gi,
    /\bmy analytics background[^,.!?]*[,.]?\s*/gi,
    /\bmy engineering background[^,.!?]*[,.]?\s*/gi,
    /\bwhen transitioning from engineering[^,.!?]*[,.]?\s*/gi,
    /\bwhen i worked at [^,.!?]*[,.]?\s*/gi,
  ];
  for (const pat of patterns) {
    cleaned = cleaned.replace(pat, "").trim();
  }
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  return cleaned;
}

export function containsUnnecessaryAcronym(text: string, postText: string): boolean {
  const acronyms = ["RICE", "RACI", "OKR"];
  return acronyms.some((acronym) => {
    const hasInComment = new RegExp(`\\b${acronym}\\b`, "i").test(text);
    const hasInPost = new RegExp(`\\b${acronym}\\b`, "i").test(postText);
    return hasInComment && !hasInPost;
  });
}

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
      const scaleStr = sig?.evidence.creatorScale || "standard_creator";
      const convStr = sig?.evidence.conversationEvidence || "None detected";
      const relStr = sig?.evidence.relevanceEvidence || "None detected";
      const dateStr = sig?.evidence.dateEvidence || "Unknown";

      return (
        "[" + (i + 1) + "] Author: " + p.authorName + "\n" +
        "    postUrl: " + p.postUrl + "\n" +
        "    Snippet: " + p.snippet + "\n" +
        "    Topic: " + topicStr + "\n" +
        "    Creator Scale: " + scaleStr + "\n" +
        "    Conversation Signal: " + convStr + "\n" +
        "    Relevance Signal: " + relStr + "\n" +
        "    Date / Freshness Signal: " + dateStr + "\n" +
        "    Source: " + p.source
      );
    })
    .join("\n\n");

  const systemPrompt = [
    "You are a growth assistant drafting LinkedIn comments on behalf of Aditya Gangwani, founder of Prodily.",
    "",
    FOUNDER_CONTEXT.promptBlock,
    "",
    ICP_DEFINITION,
    "",
    "TASK: Select and rank LinkedIn posts where Aditya can make a genuine, value-adding comment.",
    "Prioritize founder-led peer conversations with aspiring PMs, APMs, career switchers,",
    "rising PM creators, and people actively asking questions or seeking advice.",
    "Posts from mega-influencers should only be ranked highly if exceptionally relevant.",
    "",
    "STRICT COMMENT GENERATION RULES (CRITICAL):",
    "1. START DIRECTLY WITH THE INSIGHT:",
    "   - Begin immediately with an observation, trade-off, counter-perspective, or practical addition.",
    "   - NO throat-clearing, filler, or intro fluff.",
    "",
    "2. STRICTLY PROHIBIT GENERIC FLATTERING OPENERS:",
    "   - NEVER use: 'Great post!', 'Thanks for sharing!', 'So insightful!', 'Your point resonates...',",
    "     'Your call is spot on', 'I appreciate this emphasis...', 'Starting with X is key', etc.",
    "",
    "3. NEVER FABRICATE PERSONAL CAREER HISTORY OR PAST JOBS:",
    "   - NEVER make claims like: 'When I was an engineer...', 'When I was an analyst...',",
    "     'In my previous company...', 'At my last job...', 'In my team we introduced...'",
    "   - NEVER invent personal career transitions, past employers, or fake personal experience.",
    "   - Comment purely as a thoughtful founder / product builder grounded in product principles.",
    "",
    "4. NO UNNECESSARY PM ACRONYM NAME-DROPPING:",
    "   - Do NOT drop acronyms like RICE, RACI, OKR, MoSCoW unless the post explicitly discusses them.",
    "",
    "5. GROUNDED ENTIRELY IN THE ACTUAL POST:",
    "   - Anchor your response directly to the specific trade-offs, questions, or ideas raised in the post.",
    "   - Add useful perspective rather than simply agreeing.",
    "",
    "6. CREATE A NATURAL REASON TO ENGAGE:",
    "   - End with a thoughtful, context-specific question or conversational hook that naturally prompts the author to respond.",
    "",
    "7. CONCISE & READABLE:",
    "   - 2 to 4 sentences maximum. Sound natural, thoughtful, and human.",
    "",
    "8. NO UNINVITED SELF-PROMOTION:",
    "   - Do NOT plug Prodily unless the post is explicitly asking for learning tools or courses.",
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

  return result.posts.map((p) => {
    let comment = cleanSuggestedComment(p.suggestedComment);
    const warnings = [...(p.warnings || [])];

    if (containsFabricatedBackstory(comment)) {
      comment = stripFabricatedBackstory(comment);
      warnings.push("Prevented fabricated first-person backstory");
    }

    const matchingRaw = batch.find(
      (b) =>
        b.postUrl.trim().toLowerCase().replace(/\/$/, "") ===
        p.postUrl.trim().toLowerCase().replace(/\/$/, "")
    );
    if (matchingRaw && containsUnnecessaryAcronym(comment, matchingRaw.snippet)) {
      warnings.push("Flagged unnecessary PM acronym");
    }

    return {
      ...p,
      suggestedComment: comment,
      warnings,
    };
  });
}