/**
 * Workflow: Interactive human-in-the-loop review of pending people candidates.
 * Command: npm run growth --review-people [--resume] [--dry-run]
 */
import readline from "node:readline";
import chalk from "chalk";
import { GrowthRepository } from "../database/repository.js";
import { copyToClipboard } from "../utils/clipboard.js";
import { openInBrowser } from "../utils/browser.js";

const DIVIDER = chalk.dim("=".repeat(56));

function scoreBadge(score: number): string {
  if (score >= 75) return chalk.bgGreen.black.bold(` ${score}/100 `);
  if (score >= 50) return chalk.bgYellow.black.bold(` ${score}/100 `);
  return chalk.bgRed.white.bold(` ${score}/100 `);
}

let rl: readline.Interface | null = null;
function getRL(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return rl;
}

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => getRL().question(prompt, resolve));
}

function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");
    const handler = (key: string) => {
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener("data", handler);
      resolve(key);
    };
    stdin.on("data", handler);
  });
}

export function closeRL(): void {
  rl?.close();
  rl = null;
}

export interface ReviewPeopleOptions {
  resume?: boolean;
  dryRun?: boolean;
}

export async function runReviewPeopleWorkflow(
  repo: GrowthRepository,
  options: ReviewPeopleOptions = {}
): Promise<void> {
  const session = repo.createSession("review-people", {
    dryRun: !!options.dryRun,
    resume: !!options.resume,
  });

  const pending = repo.getPendingPersonReviews();

  if (pending.length === 0) {
    console.log(chalk.yellow("\n  No pending people reviews found in storage."));
    console.log(chalk.dim("  Run discovery first: npm run growth --people\n"));
    repo.completeSession(session.id, "completed");
    return;
  }

  console.log(
    chalk.bold.cyan(
      `\n  === REVIEWING PENDING PEOPLE CANDIDATES (${pending.length} pending) ===\n`
    )
  );

  let approvedCount = 0;
  let skippedCount = 0;
  let quitEarly = false;

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i]!;
    const person = item.person;
    const review = item.review;

    let aiData: any = {};
    try {
      aiData = review.ai_analysis ? JSON.parse(review.ai_analysis) : {};
    } catch {
      // ignore
    }

    let evidenceData: any = {};
    try {
      evidenceData = person.evidence_json ? JSON.parse(person.evidence_json) : {};
    } catch {
      // ignore
    }

    const detEvidence = evidenceData?.deterministic || evidenceData;

    console.log("\n" + DIVIDER);
    console.log(
      chalk.cyan.bold(`  CANDIDATE ${i + 1} / ${pending.length}`) +
        `  (v${review.version})`
    );
    console.log(DIVIDER);
    console.log(`  ${chalk.bold("Name:")}         ${person.name}`);
    console.log(`  ${chalk.bold("Headline:")}     ${person.headline || "(none)"}`);
    console.log(`  ${chalk.bold("Profile:")}      ${chalk.underline(person.canonical_profile_url)}`);
    console.log(
      `  ${chalk.bold("Overall Score:")} ${scoreBadge(person.overall_score)}   ` +
        `ICP: ${person.icp_score}/100   ` +
        `Segment: ${chalk.magenta(aiData?.segment || detEvidence?.careerStage || "N/A")}`
    );

    if (detEvidence?.pmIntentEvidence) {
      console.log(`  ${chalk.bold("PM Intent:")}     ${detEvidence.pmIntentEvidence} [${detEvidence.pmIntentStatus || "unknown"}]`);
    }
    if (detEvidence?.activityEvidence) {
      console.log(`  ${chalk.bold("Activity:")}      ${detEvidence.activityEvidence} [${detEvidence.activityStatus || "unknown"}]`);
    }

    if (aiData?.whyRelevant?.length) {
      console.log(`\n  ${chalk.bold.underline("WHY RELEVANT")}`);
      aiData.whyRelevant.forEach((r: string) => console.log(`    - ${r}`));
    }
    if (aiData?.painPoints?.length) {
      console.log(`\n  ${chalk.bold.underline("LIKELY PAIN POINTS")}`);
      aiData.painPoints.forEach((p: string) => console.log(`    - ${p}`));
    }
    if (aiData?.personalizationHook) {
      console.log(`\n  ${chalk.bold.underline("PERSONALIZATION HOOK")}`);
      console.log(`    ${chalk.italic(aiData.personalizationHook)}`);
    }
    if (aiData?.warnings?.length) {
      console.log(`\n  ${chalk.yellow.bold("  WARNINGS")}`);
      aiData.warnings.forEach((w: string) => console.log(`    ${chalk.yellow("-")} ${w}`));
    }

    console.log(`\n  ${chalk.bold.underline("SUGGESTED OUTREACH MESSAGE")}`);
    review.suggested_message.split("\n").forEach((line: string) => {
      console.log(`    ${chalk.green(line)}`);
    });
    console.log(chalk.dim("\n  * DMs are never sent automatically. You send manually after approval."));

    // User action prompt
    console.log();
    console.log(
      `  ${chalk.bgGreen.black(" Y ")} Approve   ` +
        `${chalk.bgRed.white(" N ")} Skip   ` +
        `${chalk.bgYellow.black(" E ")} Edit   ` +
        `${chalk.bgGray.white(" Q ")} Quit`
    );
    console.log(DIVIDER);

    let resolvedAction: "approved" | "skipped" | "quit" = "skipped";
    let messageToSend = review.suggested_message;
    let wasEdited = false;

    while (true) {
      const key = (await readKey()).toLowerCase();

      if (key === "y") {
        resolvedAction = "approved";
        break;
      }
      if (key === "n") {
        resolvedAction = "skipped";
        break;
      }
      if (key === "e") {
        console.log(chalk.dim(`\n  Current message:\n  ${messageToSend}\n`));
        const edited = await question(chalk.cyan("  Enter edited message (or Enter to cancel): "));
        if (edited.trim()) {
          messageToSend = edited.trim();
          wasEdited = true;
          console.log(chalk.green(`\n  Edited message ready.`));
          console.log(
            `  ${chalk.bgGreen.black(" Y ")} Approve edited   ` +
              `${chalk.bgRed.white(" N ")} Discard   ` +
              `${chalk.bgGray.white(" Q ")} Quit`
          );
          const k2 = (await readKey()).toLowerCase();
          if (k2 === "y") {
            resolvedAction = "approved";
            break;
          }
          if (k2 === "q") {
            resolvedAction = "quit";
            break;
          }
          resolvedAction = "skipped";
          break;
        }
      }
      if (key === "q" || key === "\u0003") {
        resolvedAction = "quit";
        break;
      }
    }

    if (resolvedAction === "quit") {
      console.log(chalk.yellow("\n  Exiting review session. Remaining candidates saved for next run."));
      quitEarly = true;
      break;
    }

    if (resolvedAction === "approved") {
      if (!options.dryRun) {
        repo.updatePersonReviewDecision(
          review.id,
          "approved",
          wasEdited ? messageToSend : null,
          session.id
        );
        try {
          await copyToClipboard(messageToSend);
          await openInBrowser(person.canonical_profile_url);
          console.log(chalk.green.bold("\n  Approved & copied to clipboard! Profile opened in browser."));
          console.log(chalk.dim("  Paste the message and send the DM yourself."));
        } catch (err) {
          console.log(chalk.yellow(`  Note: Browser/clipboard action: ${String(err)}`));
        }
      } else {
        console.log(chalk.yellow("\n  [DRY RUN] Would have marked approved and opened profile."));
      }
      approvedCount++;
    } else {
      if (!options.dryRun) {
        repo.updatePersonReviewDecision(review.id, "skipped", null, session.id);
      }
      console.log(chalk.dim("  Skipped."));
      skippedCount++;
    }
  }

  closeRL();

  console.log("\n" + DIVIDER);
  console.log(chalk.bold.white("  PEOPLE REVIEW SUMMARY"));
  console.log(DIVIDER);
  console.log(`  Approved : ${chalk.green(approvedCount)}`);
  console.log(`  Skipped  : ${chalk.dim(skippedCount)}`);
  console.log(`  Remaining: ${chalk.cyan(pending.length - (approvedCount + skippedCount))}`);
  console.log(DIVIDER + "\n");

  repo.completeSession(session.id, quitEarly ? "interrupted" : "completed");
}
