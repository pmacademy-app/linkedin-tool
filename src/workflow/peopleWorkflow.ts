/**
 * Workflow: Discover and score people candidates.
 * Command: npm run growth --people [--resume] [--dry-run]
 */
import chalk from "chalk";
import ora from "ora";
import {
  MAX_PEOPLE,
  SEARCH_PROVIDER,
  AI_PROVIDER,
  SKIPPED_PERSON_COOLDOWN_DAYS,
} from "../config.js";
import { getPeopleProvider } from "../discovery/people.js";
import { normalizeLinkedInProfileUrl } from "../discovery/firecrawl.js";
import { evaluatePeopleSignals } from "../signals/peopleSignals.js";
import type { PeopleScoreBreakdown } from "../signals/types.js";
import { scorePeople } from "../ai/people.js";
import type { RawPerson } from "../storage/models.js";
import { GrowthRepository, normaliseCanonicalUrl } from "../database/repository.js";

export interface PeopleWorkflowOptions {
  resume?: boolean;
  dryRun?: boolean;
}

export async function runPeopleWorkflow(
  repo: GrowthRepository,
  options: PeopleWorkflowOptions = {}
): Promise<void> {
  const session = repo.createSession("people", {
    provider: SEARCH_PROVIDER,
    aiProvider: AI_PROVIDER,
    maxPeople: MAX_PEOPLE,
    resume: !!options.resume,
    dryRun: !!options.dryRun,
    skippedCooldownDays: SKIPPED_PERSON_COOLDOWN_DAYS,
  });

  console.log(chalk.bold.cyan("\n  === PEOPLE DISCOVERY & SCORING ==="));
  if (options.dryRun) {
    console.log(chalk.yellow("  [DRY RUN] Candidates will be evaluated but not persisted to DB."));
  }
  if (options.resume) {
    console.log(chalk.dim("  [RESUME] Checking for unreviewed or existing discovered candidates..."));
  }

  // Load existing ineligibility map (approved, contacted, pending, cooling down)
  const ineligibleMap = repo.getIneligibleProfileMap({
    skippedCooldownDays: SKIPPED_PERSON_COOLDOWN_DAYS,
  });

  if (options.resume) {
    const pending = repo.getPendingPersonReviews();
    if (pending.length > 0) {
      console.log(
        chalk.green(`  Found ${pending.length} pending people reviews in database.`) +
          chalk.dim(" To review them, run: npm run growth --review-people")
      );
    }
  }

  // Discover fresh candidates
  const spinner = ora(`Discovering people via ${SEARCH_PROVIDER}...`).start();
  let rawCandidates: RawPerson[] = [];
  try {
    const raw = await getPeopleProvider().discoverPeople(MAX_PEOPLE);
    rawCandidates = raw;
    spinner.succeed(`Discovered ${chalk.cyan(raw.length)} raw candidates from ${SEARCH_PROVIDER}`);
  } catch (err) {
    spinner.fail(`People discovery failed: ${String(err)}`);
    repo.completeSession(session.id, "failed");
    throw err;
  }

  // Cross-run & Intra-run Deduplication and Lifecycle Filtering
  const seenInRun = new Set<string>();
  const newCandidates: RawPerson[] = [];
  let duplicatesInRunCount = 0;
  let suppressedApprovedCount = 0;
  let suppressedContactedCount = 0;
  let suppressedPendingCount = 0;
  let suppressedSkippedCooldownCount = 0;

  for (const c of rawCandidates) {
    const canonical = normalizeLinkedInProfileUrl(c.profileUrl) || normaliseCanonicalUrl(c.profileUrl);

    // 1. Deduplicate within the same discovery run
    if (seenInRun.has(canonical)) {
      duplicatesInRunCount++;
      continue;
    }
    seenInRun.add(canonical);

    // 2. Check existing SQLite history
    const ineligibility = ineligibleMap.get(canonical);
    if (ineligibility) {
      if (ineligibility === "already_approved") suppressedApprovedCount++;
      else if (ineligibility === "already_contacted") suppressedContactedCount++;
      else if (ineligibility === "pending_review") suppressedPendingCount++;
      else if (ineligibility === "skipped_cooldown") suppressedSkippedCooldownCount++;

      // Non-destructively record re-discovery timestamp in database
      if (!options.dryRun) {
        const signals = evaluatePeopleSignals({ ...c, profileUrl: canonical });
        repo.upsertPerson(
          {
            profileUrl: canonical,
            name: c.name,
            headline: c.headline,
            rawData: c,
            source: c.source,
            activityScore: signals.activityScore,
            icpScore: signals.icpScore,
            intentScore: signals.intentScore,
            overallScore: signals.overallScore,
            evidence: signals.evidence,
          },
          session.id
        );
      }
      continue;
    }

    newCandidates.push({
      ...c,
      profileUrl: canonical,
    });
  }

  // Print transparent candidate audit summary
  console.log(chalk.dim("  --------------------------------------------------------"));
  console.log(chalk.bold("  CANDIDATE DISCOVERY AUDIT:"));
  console.log(`    Total Discovered           : ${chalk.white.bold(rawCandidates.length)}`);
  if (duplicatesInRunCount > 0) {
    console.log(`    Duplicates in Same Run     : ${chalk.yellow(duplicatesInRunCount)}`);
  }
  if (suppressedApprovedCount > 0) {
    console.log(`    Suppressed (Already Approved): ${chalk.yellow(suppressedApprovedCount)}`);
  }
  if (suppressedContactedCount > 0) {
    console.log(`    Suppressed (Already Contacted): ${chalk.yellow(suppressedContactedCount)}`);
  }
  if (suppressedPendingCount > 0) {
    console.log(`    Suppressed (Already in Queue): ${chalk.yellow(suppressedPendingCount)}`);
  }
  if (suppressedSkippedCooldownCount > 0) {
    console.log(`    Suppressed (Skipped Cooldown) : ${chalk.yellow(suppressedSkippedCooldownCount)}`);
  }
  console.log(`    Genuinely New Candidates   : ${chalk.green.bold(newCandidates.length)}`);
  console.log(chalk.dim("  --------------------------------------------------------"));

  if (newCandidates.length === 0) {
    console.log(chalk.yellow("  No new people candidates to process today (all filtered as existing/approved/cooling)."));
    repo.completeSession(session.id, "completed");
    return;
  }

  // Deterministic signal evaluation
  console.log(chalk.dim(`  Evaluating deterministic signals for ${newCandidates.length} candidate(s)...`));
  const deterministicMap = new Map<string, PeopleScoreBreakdown>();
  const qualifiedCandidates: RawPerson[] = [];

  for (const c of newCandidates) {
    const signals = evaluatePeopleSignals(c);
    const key = c.profileUrl.trim().toLowerCase().replace(/\/$/, "");
    deterministicMap.set(key, signals);

    if (signals.evidence.isExcluded) {
      console.log(
        chalk.dim(`    - Excluded: ${c.name} (${signals.evidence.exclusionReason})`)
      );
      continue;
    }
    qualifiedCandidates.push(c);
  }

  console.log(
    chalk.cyan(`  ${qualifiedCandidates.length} candidates qualified after deterministic filtering.`)
  );

  if (qualifiedCandidates.length === 0) {
    console.log(chalk.yellow("  No candidates passed ICP signal thresholds."));
    repo.completeSession(session.id, "completed");
    return;
  }

  // AI scoring and DM generation
  const aiSpinner = ora(`Scoring ${qualifiedCandidates.length} candidates with AI (${AI_PROVIDER})...`).start();
  let scoredPeople: import("../storage/models.js").ScoredPerson[] = [];
  try {
    scoredPeople = await scorePeople(qualifiedCandidates, deterministicMap);
    aiSpinner.succeed(
      `AI generated ${chalk.green(scoredPeople.length)} tailored reviews & outreach drafts.`
    );
  } catch (err) {
    aiSpinner.fail(`AI scoring failed: ${String(err)}`);
    repo.completeSession(session.id, "failed");
    throw err;
  }

  // Persist raw candidates, deterministic evidence, AI analysis, and review records
  if (!options.dryRun) {
    let createdCount = 0;
    for (const p of scoredPeople) {
      const key = p.profileUrl.trim().toLowerCase().replace(/\/$/, "");
      const sig = deterministicMap.get(key) || evaluatePeopleSignals({
        profileUrl: p.profileUrl,
        name: p.name,
        headline: p.headline,
        snippets: [],
        source: "firecrawl",
      });

      const { person } = repo.upsertPerson(
        {
          profileUrl: p.profileUrl,
          name: p.name,
          headline: p.headline,
          rawData: p,
          source: SEARCH_PROVIDER,
          activityScore: sig.activityScore,
          icpScore: p.icpScore,
          intentScore: sig.intentScore,
          overallScore: sig.overallScore,
          evidence: {
            deterministic: sig.evidence,
            ai: {
              segment: p.segment,
              whyRelevant: p.whyRelevant,
              painPoints: p.painPoints,
              personalizationHook: p.personalizationHook,
              confidence: p.confidence,
              warnings: p.warnings,
            },
          },
        },
        session.id
      );

      // Create persistent versioned review record
      repo.createPersonReview(
        person.id,
        session.id,
        {
          segment: p.segment,
          whyRelevant: p.whyRelevant,
          painPoints: p.painPoints,
          personalizationHook: p.personalizationHook,
          confidence: p.confidence,
          warnings: p.warnings,
          deterministicScores: {
            activityScore: sig.activityScore,
            intentScore: sig.intentScore,
            icpScore: p.icpScore,
            overallScore: sig.overallScore,
          },
        },
        p.suggestedMessage
      );
      createdCount++;
    }

    console.log(
      chalk.green.bold(
        `\n  Successfully persisted ${createdCount} candidate review records in SQLite.`
      )
    );
    console.log(chalk.bold("  To review and approve candidates, run:"));
    console.log(chalk.cyan("    npm run growth --review-people\n"));
  } else {
    console.log(
      chalk.yellow.bold(`\n  [DRY RUN] Would have persisted ${scoredPeople.length} reviews.`)
    );
  }

  repo.completeSession(session.id, "completed");
}
