/**
 * Workflow: Discover and score post candidates, generate comments.
 * Command: npm run growth --posts [--resume] [--dry-run]
 */
import chalk from "chalk";
import ora from "ora";
import { MAX_POSTS, SEARCH_PROVIDER, AI_PROVIDER } from "../config.js";
import { getPostProvider } from "../discovery/posts.js";
import { evaluatePostSignals } from "../signals/postSignals.js";
import type { PostScoreBreakdown } from "../signals/types.js";
import { scorePosts } from "../ai/posts.js";
import type { RawPost } from "../storage/models.js";
import { GrowthRepository } from "../database/repository.js";

export interface PostsWorkflowOptions {
  resume?: boolean;
  dryRun?: boolean;
}

export async function runPostsWorkflow(
  repo: GrowthRepository,
  options: PostsWorkflowOptions = {}
): Promise<void> {
  const session = repo.createSession("posts", {
    provider: SEARCH_PROVIDER,
    aiProvider: AI_PROVIDER,
    maxPosts: MAX_POSTS,
    resume: !!options.resume,
    dryRun: !!options.dryRun,
  });

  console.log(chalk.bold.cyan("\n  === POST DISCOVERY & COMMENT GENERATION ==="));
  if (options.dryRun) {
    console.log(chalk.yellow("  [DRY RUN] Posts will be evaluated but not persisted to DB."));
  }
  if (options.resume) {
    console.log(chalk.dim("  [RESUME] Checking for existing unreviewed posts..."));
    const pending = repo.getPendingPostReviews();
    if (pending.length > 0) {
      console.log(
        chalk.green(`  Found ${pending.length} pending post reviews in database.`) +
          chalk.dim(" To review them, run: npm run growth --review-posts")
      );
    }
  }

  let rawCandidates: RawPost[] = [];
  const knownUrls = repo.getAllKnownPostUrls();

  // Discover fresh posts
  const spinner = ora(`Discovering posts via ${SEARCH_PROVIDER}...`).start();
  try {
    const raw = await getPostProvider().discoverPosts(MAX_POSTS);
    rawCandidates = raw;
    spinner.succeed(`Discovered ${chalk.cyan(raw.length)} raw posts from ${SEARCH_PROVIDER}`);
  } catch (err) {
    spinner.fail(`Post discovery failed: ${String(err)}`);
    repo.completeSession(session.id, "failed");
    throw err;
  }

  // Filter out posts already in database
  const newCandidates: RawPost[] = [];
  let existingCount = 0;

  for (const p of rawCandidates) {
    const norm = p.postUrl.trim().toLowerCase().replace(/\/$/, "");
    if (knownUrls.has(norm)) {
      existingCount++;
      if (!options.dryRun) {
        const signals = evaluatePostSignals(p);
        repo.upsertPost(
          {
            postUrl: p.postUrl,
            authorName: p.authorName,
            authorProfileUrl: signals.evidence.authorProfileUrl,
            rawData: p,
            source: p.source,
            activityScore: signals.activityScore,
            relevanceScore: signals.relevanceScore,
            conversationScore: signals.conversationScore,
            freshnessScore: signals.freshnessScore,
            overallScore: signals.overallScore,
            evidence: signals.evidence,
          },
          session.id
        );
      }
    } else {
      newCandidates.push(p);
    }
  }

  if (existingCount > 0) {
    console.log(
      chalk.dim(`  ${existingCount} post(s) already existed in database (updated last_seen_at).`)
    );
  }

  if (newCandidates.length === 0) {
    console.log(chalk.yellow("  No new posts to process today."));
    repo.completeSession(session.id, "completed");
    return;
  }

  // Deterministic signals evaluation
  console.log(chalk.dim(`  Evaluating deterministic signals for ${newCandidates.length} post(s)...`));
  const deterministicMap = new Map<string, PostScoreBreakdown>();
  const qualifiedCandidates: RawPost[] = [];

  for (const p of newCandidates) {
    const signals = evaluatePostSignals(p);
    const key = p.postUrl.trim().toLowerCase().replace(/\/$/, "");
    deterministicMap.set(key, signals);

    if (signals.evidence.isTooOld) {
      console.log(chalk.dim(`    - Stale post skipped: ${p.postUrl} (${signals.evidence.dateEvidence})`));
      continue;
    }
    if (signals.conversationScore < 30) {
      console.log(chalk.dim(`    - Non-conversational post skipped: ${p.authorName} (${signals.evidence.conversationEvidence})`));
      continue;
    }
    qualifiedCandidates.push(p);
  }

  console.log(
    chalk.cyan(`  ${qualifiedCandidates.length} posts qualified after deterministic quality signals.`)
  );

  if (qualifiedCandidates.length === 0) {
    console.log(chalk.yellow("  No posts passed quality and conversation thresholds."));
    repo.completeSession(session.id, "completed");
    return;
  }

  // AI scoring and comment drafting
  const aiSpinner = ora(`Scoring & drafting comments with AI (${AI_PROVIDER})...`).start();
  let scoredPosts: import("../storage/models.js").ScoredPost[] = [];
  try {
    scoredPosts = await scorePosts(qualifiedCandidates, deterministicMap);
    aiSpinner.succeed(
      `AI generated ${chalk.green(scoredPosts.length)} thoughtful, value-adding comments.`
    );
  } catch (err) {
    aiSpinner.fail(`AI post scoring failed: ${String(err)}`);
    repo.completeSession(session.id, "failed");
    throw err;
  }

  // Persist posts, reviews, and draft comments
  if (!options.dryRun) {
    let createdCount = 0;
    for (const p of scoredPosts) {
      const key = p.postUrl.trim().toLowerCase().replace(/\/$/, "");
      const sig = deterministicMap.get(key) || evaluatePostSignals({
        postUrl: p.postUrl,
        authorName: p.authorName,
        snippet: p.postSummary,
        source: "firecrawl",
      });

      const { post } = repo.upsertPost(
        {
          postUrl: p.postUrl,
          authorName: p.authorName,
          authorProfileUrl: sig.evidence.authorProfileUrl,
          rawData: p,
          source: SEARCH_PROVIDER,
          activityScore: sig.activityScore,
          relevanceScore: p.relevanceScore,
          conversationScore: sig.conversationScore,
          freshnessScore: sig.freshnessScore,
          overallScore: sig.overallScore,
          evidence: {
            deterministic: sig.evidence,
            ai: {
              postSummary: p.postSummary,
              whyRelevant: p.whyRelevant,
              confidence: p.confidence,
              warnings: p.warnings,
            },
          },
        },
        session.id
      );

      // Create review record and draft comment
      repo.createPostReviewAndComment(
        post.id,
        session.id,
        {
          postSummary: p.postSummary,
          whyRelevant: p.whyRelevant,
          confidence: p.confidence,
          warnings: p.warnings,
          scores: {
            relevanceScore: p.relevanceScore,
            conversationScore: sig.conversationScore,
            freshnessScore: sig.freshnessScore,
            activityScore: sig.activityScore,
            overallScore: sig.overallScore,
          },
        },
        p.suggestedComment
      );
      createdCount++;
    }

    console.log(
      chalk.green.bold(
        `\n  Successfully persisted ${createdCount} post review & draft comment records in SQLite.`
      )
    );
    console.log(chalk.bold("  To review and approve comments, run:"));
    console.log(chalk.cyan("    npm run growth --review-posts\n"));
    console.log(chalk.dim("  (Comments will NOT publish until explicitly authorized and published.)"));
  } else {
    console.log(
      chalk.yellow.bold(`\n  [DRY RUN] Would have persisted ${scoredPosts.length} post reviews.`)
    );
  }

  repo.completeSession(session.id, "completed");
}
