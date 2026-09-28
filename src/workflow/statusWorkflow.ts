/**
 * Workflow: Display current system status, record counts, and recent activity.
 * Command: npm run growth --status
 */
import chalk from "chalk";
import fs from "node:fs";
import { GrowthRepository } from "../database/repository.js";
import { isAuthorized } from "../linkedin/auth.js";
import { getDatabasePath } from "../database/connection.js";

const DIVIDER = chalk.dim("=".repeat(56));

export function runStatusWorkflow(repo: GrowthRepository): void {
  const counts = repo.getStatusCounts();
  const dbPath = getDatabasePath();
  const dbExists = fs.existsSync(dbPath);
  const dbSizeKb = dbExists ? Math.round(fs.statSync(dbPath).size / 1024) : 0;
  const authorized = isAuthorized();

  console.log();
  console.log(chalk.bgMagenta.white.bold("  PRODILY GROWTH OS -- SYSTEM STATUS  "));
  console.log(DIVIDER);

  // System & Connection State
  console.log(chalk.bold("  Database:     ") + chalk.cyan(dbPath) + chalk.dim(` (${dbSizeKb} KB)`));
  console.log(
    chalk.bold("  LinkedIn API: ") +
      (authorized
        ? chalk.green.bold("AUTHORIZED (Ready for automated comment publishing)")
        : chalk.yellow("NOT AUTHORIZED (Run: npm run growth --linkedin-auth)"))
  );
  console.log(DIVIDER);

  // People Breakdown
  console.log(chalk.bold.cyan("  PEOPLE OUTREACH (DMs)"));
  console.log(`    Total Discovered  : ${chalk.white.bold(counts.people.total)}`);
    console.log(`    Pending Review    : ${counts.people.pendingReview > 0 ? chalk.yellow.bold(counts.people.pendingReview) : chalk.dim("0")}`);
  console.log(`    Approved (to DM)  : ${chalk.green(counts.people.approved)}`);
  console.log(`    Contacted         : ${chalk.blue(counts.people.contacted)}`);
  console.log(`    Skipped           : ${chalk.dim(counts.people.skipped)}`);
  console.log();

  // Posts Breakdown
  console.log(chalk.bold.cyan("  POSTS DISCOVERED"));
  console.log(`    Total Discovered  : ${chalk.white.bold(counts.posts.total)}`);
  console.log(`    Pending Review    : ${counts.posts.pendingReview > 0 ? chalk.yellow.bold(counts.posts.pendingReview) : chalk.dim("0")}`);
  console.log();

  // Comments Lifecycle
  console.log(chalk.bold.cyan("  COMMENTS LIFECYCLE"));
  console.log(`    Total Generated   : ${chalk.white.bold(counts.comments.total)}`);
  console.log(`    Drafts (pending)  : ${chalk.dim(counts.comments.draft)}`);
  console.log(
    `    Approved (ready)  : ${
      counts.comments.approved > 0
        ? chalk.yellow.bold(counts.comments.approved) + chalk.dim(" -> run: npm run growth --publish-comments")
        : chalk.dim("0")
    }`
  );
  console.log(`    Published (API)   : ${chalk.green.bold(counts.comments.published)}`);
  console.log(
    `    Publish Failed    : ${
      counts.comments.publish_failed > 0
        ? chalk.red.bold(counts.comments.publish_failed)
        : chalk.dim("0")
    }`
  );
  console.log(`    Manually Copied   : ${chalk.cyan(counts.comments.manual_copied)}`);
  console.log(`    Skipped           : ${chalk.dim(counts.comments.skipped)}`);
  console.log(DIVIDER);

  // Recent Sessions
  console.log(chalk.bold.white("  RECENT SESSIONS"));
  if (counts.sessions.length === 0) {
    console.log(chalk.dim("    No recent sessions recorded."));
  } else {
    for (const s of counts.sessions) {
      const statusColor =
        s.status === "completed"
          ? chalk.green
          : s.status === "failed"
          ? chalk.red
          : chalk.yellow;
      const started = new Date(s.started_at).toLocaleString();
      console.log(
        `    ${chalk.dim(started)} | ${chalk.cyan(s.command.padEnd(16))} | ${statusColor(s.status)}`
      );
    }
  }
  console.log(DIVIDER + "\n");
}
