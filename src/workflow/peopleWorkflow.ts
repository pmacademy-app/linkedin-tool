/**
 * Workflow: Discover and score people candidates.
 * Command: npm run growth --people [--resume] [--dry-run]
 */
import chalk from "chalk";
import ora from "ora";
import { MAX_PEOPLE, SEARCH_PROVIDER, AI_PROVIDER } from "../config.js";
import { getPeopleProvider } from "../discovery/people.js";
import { evaluatePeopleSignals } from "../signals/peopleSignals.js";
import type { PeopleScoreBreakdown } from "../signals/types.js";
import { scorePeople } from "../ai/people.js";
import type { RawPerson } from "../storage/models.js";
import { GrowthRepository } from "../database/repository.js";

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
  });

  console.log(chalk.bold.cyan("\n  === PEOPLE DISCOVERY & SCORING ==="));
  if (options.dryRun) {
    console.log(chalk.yellow("  [DRY RUN] Candidates will be evaluated but not persisted to DB."));
  }
  if (options.resume) {
    console.log(chalk.dim("  [RESUME] Checking for unreviewed or existing discovered candidates..."));
  }

  let rawCandidates: RawPerson[] = [];
  const knownUrls = repo.getAllKnownProfileUrls();

  if (options.resume) {
    // If resume is active, check if we already have pending reviews
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
  try {
    const raw = await getPeopleProvider().discoverPeople(MAX_PEOPLE);
    rawCandidates = raw;
    spinner.succeed(`Discovered ${chalk.cyan(raw.length)} raw candidates from ${SEARCH_PROVIDER}`);
  } catch (err) {
    spinner.fail(`People discovery failed: ${String(err)}`);
    repo.completeSession(session.id, "failed");
    throw err;
  }

  // Filter out profiles already in database (unless re-discovered)
  const newCandidates: RawPerson[] = [];
  let existingCount = 0;

  for (const c of rawCandidates) {
    const norm = c.profileUrl.trim().toLowerCase().replace(/\/$/, "");
    if (knownUrls.has(norm)) {
      existingCount++;
      if (!options.dryRun) {
        // Record re-discovery timestamp in database
        const signals = evaluatePeopleSignals(c);
        repo.upsertPerson(
          {
            profileUrl: c.profileUrl,
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
    } else {
      newCandidates.push(c);
    }
  }

  if (existingCount > 0) {
    console.log(
      chalk.dim(`  ${existingCount} candidate(s) already existed in database (updated last_seen_at).`)
    );
  }

  if (newCandidates.length === 0) {
    console.log(chalk.yellow("  No new people candidates to process today."));
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
