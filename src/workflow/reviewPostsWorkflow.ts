/**
 * Workflow: Interactive human-in-the-loop review of post comments.
 * Approves comments for subsequent official publication via --publish-comments.
 * Command: npm run growth --review-posts [--resume] [--dry-run]
 */
import readline from "node:readline";
import chalk from "chalk";
import { GrowthRepository } from "../database/repository.js";

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

export interface ReviewPostsOptions {
  resume?: boolean;
  dryRun?: boolean;
}

export async function runReviewPostsWorkflow(
  repo: GrowthRepository,
  options: ReviewPostsOptions = {}
): Promise<void> {
  const session = repo.createSession("review-posts", {
    dryRun: !!options.dryRun,
    resume: !!options.resume,
  });

  const pending = repo.getPendingPostReviews();

  if (pending.length === 0) {
    console.log(chalk.yellow("\n  No pending post reviews found in storage."));
    console.log(chalk.dim("  Run discovery first: npm run growth --posts\n"));
    repo.completeSession(session.id, "completed");
    return;
  }

  console.log(
    chalk.bold.cyan(
      `\n  === REVIEWING PENDING POST COMMENTS (${pending.length} pending) ===\n`
    )
  );
  console.log(
    chalk.dim(
      "  * Approving authorizes comments for official API publication via:\n" +
        "    npm run growth --publish-comments\n"
    )
  );

  let approvedCount = 0;
  let skippedCount = 0;
  let quitEarly = false;

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i]!;
    const post = item.post;
    const review = item.review;
    const comment = item.comment;

    let aiData: any = {};
    try {
      aiData = review.ai_analysis ? JSON.parse(review.ai_analysis) : {};
    } catch {
      // ignore
    }

    let evidenceData: any = {};
    try {
      evidenceData = post.evidence_json ? JSON.parse(post.evidence_json) : {};
    } catch {
      // ignore
    }

    const detEvidence = evidenceData?.deterministic || evidenceData;

    console.log("\n" + DIVIDER);
    console.log(
      chalk.blue.bold(`  POST ${i + 1} / ${pending.length}`) +
        `  (review v${review.version})`
    );
    console.log(DIVIDER);
    console.log(`  ${chalk.bold("Author:")}         ${post.author_name}`);
    console.log(`  ${chalk.bold("URL:")}            ${chalk.underline(post.canonical_post_url)}`);
    if (post.author_profile_url) {
      console.log(`  ${chalk.bold("Author Profile:")} ${chalk.underline(post.author_profile_url)}`);
    }
    console.log(
      `  ${chalk.bold("Overall Score:")}  ${scoreBadge(post.overall_score)}   ` +
        `Relevance: ${post.relevance_score}/100   ` +
        `Topic: ${chalk.magenta(detEvidence?.topic || "Product Management")}`
    );

    if (detEvidence?.conversationEvidence) {
      console.log(`  ${chalk.bold("Discussion:")}     ${detEvidence.conversationEvidence} [${detEvidence.conversationStatus || "unknown"}]`);
    }
    if (detEvidence?.dateEvidence) {
      console.log(`  ${chalk.bold("Freshness:")}      ${detEvidence.dateEvidence} [${detEvidence.freshnessStatus || "unknown"}]`);
    }

    if (aiData?.postSummary) {
      console.log(`\n  ${chalk.bold.underline("POST SUMMARY")}`);
      console.log(`    ${aiData.postSummary}`);
    }
    if (aiData?.whyRelevant) {
      console.log(`\n  ${chalk.bold.underline("WHY RELEVANT")}`);
      console.log(`    ${aiData.whyRelevant}`);
    }
    if (aiData?.warnings?.length) {
      console.log(`\n  ${chalk.yellow.bold("  WARNINGS")}`);
      aiData.warnings.forEach((w: string) => console.log(`    ${chalk.yellow("-")} ${w}`));
    }

    console.log(`\n  ${chalk.bold.underline("SUGGESTED COMMENT")}`);
    review.suggested_comment.split("\n").forEach((line: string) => {
      console.log(`    ${chalk.cyan(line)}`);
    });

    console.log();
    console.log(
      `  ${chalk.bgGreen.black(" Y ")} Approve for publishing   ` +
        `${chalk.bgRed.white(" N ")} Skip   ` +
        `${chalk.bgYellow.black(" E ")} Edit   ` +
        `${chalk.bgGray.white(" Q ")} Quit`
    );
    console.log(DIVIDER);

    let resolvedAction: "approved" | "skipped" | "quit" = "skipped";
    let commentText = review.suggested_comment;
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
        console.log(chalk.dim(`\n  Current comment:\n  ${commentText}\n`));
        const edited = await question(chalk.cyan("  Enter edited comment (or Enter to cancel): "));
        if (edited.trim()) {
          commentText = edited.trim();
          wasEdited = true;
          console.log(chalk.green(`\n  Edited comment ready.`));
          console.log(
            `  ${chalk.bgGreen.black(" Y ")} Approve edited for publishing   ` +
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
      console.log(chalk.yellow("\n  Exiting review session. Progress saved."));
      quitEarly = true;
      break;
    }

    if (resolvedAction === "approved") {
      if (!options.dryRun) {
        repo.updatePostReviewDecision(
          review.id,
          "approved",
          wasEdited ? commentText : null,
          session.id
        );
        console.log(
          chalk.green.bold("\n  Comment approved and authorized for publishing.") +
            chalk.dim(" Status: 'approved'.")
        );
      } else {
        console.log(chalk.yellow("\n  [DRY RUN] Would have marked comment as approved."));
      }
      approvedCount++;
    } else {
      if (!options.dryRun) {
        repo.updatePostReviewDecision(review.id, "skipped", null, session.id);
      }
      console.log(chalk.dim("  Skipped."));
      skippedCount++;
    }
  }

  closeRL();

  console.log("\n" + DIVIDER);
  console.log(chalk.bold.white("  POST REVIEW SUMMARY"));
  console.log(DIVIDER);
  console.log(`  Approved : ${chalk.green(approvedCount)} (ready to publish via --publish-comments)`);
  console.log(`  Skipped  : ${chalk.dim(skippedCount)}`);
  console.log(`  Remaining: ${chalk.cyan(pending.length - (approvedCount + skippedCount))}`);
  console.log(DIVIDER);

  if (approvedCount > 0 && !options.dryRun) {
    console.log(chalk.bold.white("\n  Next step to publish approved comments:"));
    console.log(chalk.cyan.bold("    npm run growth --publish-comments\n"));
  }

  repo.completeSession(session.id, quitEarly ? "interrupted" : "completed");
}
