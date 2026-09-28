/**
 * Workflow: Manual comments fallback.
 * Allows user to manually copy approved or failed comments to clipboard and open post in browser.
 * Command: npm run growth --manual-comments [--dry-run]
 */
import readline from "node:readline";
import chalk from "chalk";
import { GrowthRepository } from "../database/repository.js";
import { copyToClipboard } from "../utils/clipboard.js";
import { openInBrowser } from "../utils/browser.js";

const DIVIDER = chalk.dim("=".repeat(56));

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

export async function runManualCommentsWorkflow(
  repo: GrowthRepository,
  options: { dryRun?: boolean } = {}
): Promise<void> {
  const session = repo.createSession("manual-comments", {
    dryRun: !!options.dryRun,
  });

  console.log(chalk.bold.cyan("\n  === MANUAL COMMENTS SUBMISSION ==="));

  // Get comments that are approved or publish_failed
  const items = repo.getApprovedCommentsForPublishing();

  if (items.length === 0) {
    console.log(chalk.yellow("\n  No pending comments available for manual submission."));
    repo.completeSession(session.id, "completed");
    return;
  }

  console.log(
    chalk.white(`  Found ${chalk.cyan(items.length)} comment(s) to process manually.\n`)
  );

  let copiedCount = 0;
  for (let i = 0; i < items.length; i++) {
    const { comment, post } = items[i]!;

    console.log(DIVIDER);
    console.log(chalk.blue.bold(`  COMMENT ${i + 1} / ${items.length}`));
    console.log(`  Post:   ${chalk.underline(post.canonical_post_url)}`);
    console.log(`  Author: ${post.author_name}`);
    console.log(`\n  ${chalk.bold("Comment Text:")}`);
    console.log(`  ${chalk.cyan(comment.content)}\n`);

    console.log(
      `  ${chalk.bgGreen.black(" C ")} Copy & Open in Browser   ` +
        `${chalk.bgYellow.black(" S ")} Skip   ` +
        `${chalk.bgGray.white(" Q ")} Quit`
    );

    let choice = "s";
    while (true) {
      const k = (await readKey()).toLowerCase();
      if (k === "c" || k === "y") {
        choice = "c";
        break;
      }
      if (k === "s" || k === "n") {
        choice = "s";
        break;
      }
      if (k === "q" || k === "\u0003") {
        choice = "q";
        break;
      }
    }

    if (choice === "q") {
      console.log(chalk.yellow("\n  Exiting manual mode."));
      break;
    }

    if (choice === "c") {
      if (!options.dryRun) {
        try {
          await copyToClipboard(comment.content);
          await openInBrowser(post.canonical_post_url);
          repo.recordManualCommentCopy(comment.id, session.id);
          console.log(chalk.green.bold("\n  Copied to clipboard and post opened in browser!"));
          console.log(chalk.dim("  Paste and submit in LinkedIn."));
        } catch (err) {
          console.log(chalk.red(`  Error: ${String(err)}`));
        }
      } else {
        console.log(chalk.yellow("\n  [DRY RUN] Would copy comment and open post URL."));
      }
      copiedCount++;
    } else {
      console.log(chalk.dim("  Skipped."));
    }
  }

  closeRL();
  console.log(`\n  Done. ${copiedCount} comment(s) copied manually.\n`);
  repo.completeSession(session.id, "completed");
}
