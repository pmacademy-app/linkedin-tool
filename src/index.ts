/**
 * Prodily Growth OS -- Main CLI entrypoint.
 *
 * Commands:
 *   npm run growth --people             Discover candidates & generate DMs
 *   npm run growth --people -resume     Resume people discovery / scoring
 *   npm run growth --posts              Discover posts & draft comments
 *   npm run growth --posts -resume      Resume post discovery / scoring
 *   npm run growth --review-people      Interactive review of people
 *   npm run growth --review-posts       Interactive review of posts & comments
 *   npm run growth --publish-comments   Publish approved comments via official LinkedIn API
 *   npm run growth --publish-comments -resume
 *   npm run growth --status             Display OS health, metrics, and activity
 *   npm run growth --history            Inspect persistent audit log and sessions
 *   npm run growth --manual-comments    Explicit manual fallback for comments
 *   npm run growth --linkedin-auth      Run OAuth 2.0 flow for LinkedIn Comments API
 *   npm run growth --help               Show usage instructions
 */
import "dotenv/config";
import chalk from "chalk";
import { GrowthRepository } from "./database/repository.js";
import { isAuthorized, hasValidToken, runOAuthFlow } from "./linkedin/auth.js";
import { runPeopleWorkflow } from "./workflow/peopleWorkflow.js";
import { runPostsWorkflow } from "./workflow/postsWorkflow.js";
import { runReviewPeopleWorkflow, closeRL as closePeopleRL } from "./workflow/reviewPeopleWorkflow.js";
import { runReviewPostsWorkflow, closeRL as closePostsRL } from "./workflow/reviewPostsWorkflow.js";
import { runPublishWorkflow } from "./workflow/publishWorkflow.js";
import { runStatusWorkflow } from "./workflow/statusWorkflow.js";
import { runHistoryWorkflow } from "./workflow/historyWorkflow.js";
import { runManualCommentsWorkflow, closeRL as closeManualRL } from "./workflow/manualWorkflow.js";

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function printHeader(): void {
  console.log();
  console.log(chalk.bgMagenta.white.bold("  PRODILY GROWTH OS  "));
  console.log(chalk.dim("  Persistent founder-led user acquisition engine  *  " + new Date().toDateString()));
  if (isAuthorized()) {
    console.log(chalk.green("  LinkedIn API: authorized (w_member_social)"));
  } else if (hasValidToken()) {
    console.log(chalk.yellow("  LinkedIn API: token valid, but person URN missing (Set LINKEDIN_PERSON_URN in .env)"));
  } else {
    console.log(chalk.dim("  LinkedIn API: not authorized (Run --linkedin-auth to enable automated comments)"));
  }
}

// ---------------------------------------------------------------------------
// Help Menu
// ---------------------------------------------------------------------------

function printHelp(): void {
  printHeader();
  console.log(`
${chalk.bold.white("COMMANDS:")}
  ${chalk.cyan("npm run growth --people")}              Discover & score people candidates (generates draft DMs)
  ${chalk.cyan("npm run growth --people -resume")}       Resume incomplete people discovery/scoring session
  ${chalk.cyan("npm run growth --posts")}               Discover & score LinkedIn posts (drafts comments)
  ${chalk.cyan("npm run growth --posts -resume")}        Resume incomplete post discovery/scoring session

  ${chalk.cyan("npm run growth --review-people")}        Review pending people (approve, skip, edit, copy DM)
  ${chalk.cyan("npm run growth --review-posts")}         Review pending comments (authorize for publishing)

  ${chalk.cyan("npm run growth --publish-comments")}     Publish approved comments via official LinkedIn API
  ${chalk.cyan("npm run growth --publish-comments --limit 1")} Publish at most 1 approved comment (safe controlled test)
  ${chalk.cyan("npm run growth --publish-comments -resume")} Resume interrupted comment publication

  ${chalk.cyan("npm run growth --status")}               View counts, pending queue sizes, and system health
  ${chalk.cyan("npm run growth --history")}              Audit trail of all sessions and events

${chalk.bold.white("ADDITIONAL UTILITIES:")}
  ${chalk.cyan("npm run growth --manual-comments")}      Manually copy approved comments to clipboard
  ${chalk.cyan("npm run growth --linkedin-auth")}        Run official LinkedIn OAuth 2.0 authentication
  ${chalk.cyan("npm run growth --help")}                 Display this help guide

${chalk.bold.white("GLOBAL OPTIONS:")}
  ${chalk.yellow("--dry-run")}                          Simulate execution without modifying DB or calling APIs
  ${chalk.yellow("-resume, --resume")}                  Continue from existing persistent state
  ${chalk.yellow("--limit <n>")}                        Limit items (for publishing or history)
  ${chalk.yellow("--comment-id <id>")}                  Select specific comment ID for publishing
  ${chalk.yellow("--entity <type>")}                    Filter by entity (person, post, comment, session)
  ${chalk.yellow("--event <type>")}                     Filter by event (published, approved, etc.)
`);
}

// ---------------------------------------------------------------------------
// Main Dispatcher
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // Normalize flag arguments (support both --flag and -flag, or standalone words)
  const args = rawArgs.map((a) => a.trim());
  const hasFlag = (name: string) =>
    args.includes(`--${name}`) || args.includes(`-${name}`) || args.includes(name);

  const dryRun = hasFlag("dry-run");
  const resume = hasFlag("resume");

  // Parse filters
  let limit: number | undefined;
  const limitIdx = args.findIndex((a) => a === "--limit" || a === "-limit");
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1]!, 10);
  }

  let commentId: string | undefined;
  const commentIdIdx = args.findIndex((a) => a === "--comment-id" || a === "--id" || a === "-id");
  if (commentIdIdx !== -1 && args[commentIdIdx + 1]) {
    commentId = args[commentIdIdx + 1];
  }

  let entityType: string | undefined;
  const entityIdx = args.findIndex((a) => a === "--entity" || a === "-entity");
  if (entityIdx !== -1 && args[entityIdx + 1]) {
    entityType = args[entityIdx + 1];
  }

  let eventType: string | undefined;
  const eventIdx = args.findIndex((a) => a === "--event" || a === "-event");
  if (eventIdx !== -1 && args[eventIdx + 1]) {
    eventType = args[eventIdx + 1];
  }

  // Help command
  if (hasFlag("help") || args.length === 0) {
    printHelp();
    return;
  }

  // OAuth authentication
  if (hasFlag("linkedin-auth")) {
    printHeader();
    try {
      await runOAuthFlow();
    } catch (err) {
      console.error(chalk.red("\n  LinkedIn OAuth flow failed:"), String(err));
      process.exit(1);
    }
    return;
  }

  const repo = new GrowthRepository();

  // Status command
  if (hasFlag("status")) {
    runStatusWorkflow(repo);
    return;
  }

  // History command
  if (hasFlag("history")) {
    runHistoryWorkflow(repo, { limit, entityType, eventType });
    return;
  }

  // People discovery workflow
  if (hasFlag("people")) {
    printHeader();
    await runPeopleWorkflow(repo, { resume, dryRun });
    return;
  }

  // Posts discovery workflow
  if (hasFlag("posts")) {
    printHeader();
    await runPostsWorkflow(repo, { resume, dryRun });
    return;
  }

  // Review people workflow
  if (hasFlag("review-people")) {
    printHeader();
    await runReviewPeopleWorkflow(repo, { resume, dryRun });
    return;
  }

  // Review posts workflow
  if (hasFlag("review-posts")) {
    printHeader();
    await runReviewPostsWorkflow(repo, { resume, dryRun });
    return;
  }

  // Publish comments workflow
  if (hasFlag("publish-comments")) {
    printHeader();
    await runPublishWorkflow(repo, { resume, dryRun, limit, commentId });
    return;
  }

  // Manual comments workflow
  if (hasFlag("manual-comments")) {
    printHeader();
    await runManualCommentsWorkflow(repo, { dryRun });
    return;
  }

  console.log(chalk.red(`\n  Unknown command or arguments: "${rawArgs.join(" ")}"`));
  console.log(chalk.dim("  Run 'npm run growth --help' to see available options.\n"));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  closePeopleRL();
  closePostsRL();
  closeManualRL();
  console.error(chalk.red("\n  Fatal error:"), err instanceof Error ? err.message : String(err));
  process.exit(1);
});