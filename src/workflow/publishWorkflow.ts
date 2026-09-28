/**
 * Workflow: Automatic publishing of approved comments through official LinkedIn API.
 * Command: npm run growth --publish-comments [--resume] [--dry-run]
 */
import chalk from "chalk";
import ora from "ora";
import { GrowthRepository } from "../database/repository.js";
import { isAuthorized } from "../linkedin/auth.js";
import { publishComment } from "../linkedin/comments.js";
import { sleep } from "../discovery/firecrawl.js";

const DIVIDER = chalk.dim("=".repeat(56));

export interface PublishWorkflowOptions {
  resume?: boolean;
  dryRun?: boolean;
}

export async function runPublishWorkflow(
  repo: GrowthRepository,
  options: PublishWorkflowOptions = {}
): Promise<void> {
  const session = repo.createSession("publish-comments", {
    dryRun: !!options.dryRun,
    resume: !!options.resume,
  });

  console.log(chalk.bold.cyan("\n  === OFFICIAL LINKEDIN COMMENT PUBLISHING ==="));

  if (options.dryRun) {
    console.log(chalk.yellow("  [DRY RUN] Will simulate publishing without calling LinkedIn API."));
  }

  // 1. Load ONLY comments with durable status 'approved'
  const approvedItems = repo.getApprovedCommentsForPublishing();

  if (approvedItems.length === 0) {
    console.log(chalk.yellow("\n  No approved comments ready for publishing."));
    console.log(
      chalk.dim(
        "  Run review first to approve comments:\n" +
          "    npm run growth --review-posts\n"
      )
    );
    repo.completeSession(session.id, "completed");
    return;
  }

  console.log(
    chalk.white(
      `  Found ${chalk.green.bold(approvedItems.length)} comment(s) with durable status 'approved'.\n`
    )
  );

  // 2. Verify OAuth authorization (do NOT silently fall back to manual!)
  if (!isAuthorized() && !options.dryRun) {
    console.log(chalk.red.bold("  ERROR: LinkedIn API is not authorized."));
    console.log(
      chalk.yellow(
        "\n  --publish-comments requires official LinkedIn API authorization.\n" +
          "  To authorize, run:\n" +
          "    npm run growth --linkedin-auth\n\n" +
          "  (If you want to manually copy comments to clipboard instead,\n" +
          "  use: npm run growth --manual-comments)\n"
      )
    );
    repo.completeSession(session.id, "failed");
    return;
  }

  let publishedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < approvedItems.length; i++) {
    const item = approvedItems[i]!;
    const comment = item.comment;
    const post = item.post;

    console.log(DIVIDER);
    console.log(
      chalk.bold(`  Publishing [${i + 1}/${approvedItems.length}]: `) +
        chalk.cyan(post.canonical_post_url)
    );
    console.log(`  Author: ${post.author_name}`);
    console.log(`  Comment preview: ${chalk.italic(comment.content.slice(0, 100))}...`);

    if (options.dryRun) {
      console.log(chalk.yellow("  [DRY RUN] Would submit to LinkedIn Comments API."));
      publishedCount++;
      continue;
    }

    const spinner = ora("Submitting comment via LinkedIn API...").start();

    try {
      const result = await publishComment(post.canonical_post_url, comment.content);

      if (result.status === "published" && result.commentUrn) {
        spinner.succeed(
          chalk.green.bold("Published successfully! ") +
            chalk.dim(`URN: ${result.commentUrn}`)
        );

        repo.recordPublishSuccess(comment.id, result.commentUrn, session.id);
        publishedCount++;
      } else {
        const errorReason = result.reason || "LinkedIn API did not return HTTP 201";
        spinner.fail(chalk.red.bold(`Publishing failed: ${errorReason}`));

        repo.recordPublishFailure(comment.id, errorReason, session.id);
        failedCount++;
      }
    } catch (err) {
      const msg = String(err);
      spinner.fail(chalk.red.bold(`Network or API exception: ${msg}`));
      repo.recordPublishFailure(comment.id, msg, session.id);
      failedCount++;
    }

    // Pacing delay between consecutive comment creations (LinkedIn allows ~1/min)
    if (i < approvedItems.length - 1 && !options.dryRun) {
      console.log(chalk.dim("  Waiting 2.5s pacing before next request..."));
      await sleep(2500);
    }
  }

  console.log("\n" + DIVIDER);
  console.log(chalk.bold.white("  PUBLISHING SUMMARY"));
  console.log(DIVIDER);
  console.log(`  Total Attempted: ${approvedItems.length}`);
  console.log(`  Published      : ${chalk.green.bold(publishedCount)}`);
  console.log(`  Failed         : ${failedCount > 0 ? chalk.red.bold(failedCount) : chalk.dim("0")}`);
  console.log(DIVIDER + "\n");

  if (failedCount > 0) {
    console.log(
      chalk.yellow(
        "  Failed comments have status 'publish_failed' and error details recorded in SQLite.\n" +
          "  Run 'npm run growth --status' to view state.\n"
      )
    );
  }

  repo.completeSession(session.id, "completed");
}
