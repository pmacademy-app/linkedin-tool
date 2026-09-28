/**
 * Terminal review interface — human-in-the-loop approval flow.
 *
 * DM flow (unchanged):
 *   Y -> copy to clipboard + open LinkedIn profile -> user pastes and sends manually
 *
 * Comment flow (updated):
 *   Y -> if LinkedIn API authorized: publish via API
 *        else: copy to clipboard + open LinkedIn post -> user pastes manually
 */
import readline from "readline";
import chalk from "chalk";
import type { ScoredPerson, ScoredPost, HistoryFile } from "../storage/models.js";
import { copyToClipboard } from "../utils/clipboard.js";
import { openInBrowser } from "../utils/browser.js";
import {
  upsertPerson,
  upsertPost,
  setPersonStatus,
  setPostStatus,
  saveHistory,
} from "../storage/history.js";
import { isAuthorized, runOAuthFlow } from "../linkedin/auth.js";
import { publishComment } from "../linkedin/comments.js";

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

const DIVIDER = chalk.dim("=".repeat(54));

function scoreColor(n: number): string {
  if (n >= 75) return chalk.green.bold(`${n}/100`);
  if (n >= 50) return chalk.yellow.bold(`${n}/100`);
  return chalk.red.bold(`${n}/100`);
}

const CONFIDENCE_COLOR: Record<string, (s: string) => string> = {
  high: chalk.green,
  medium: chalk.yellow,
  low: chalk.red,
};

// ---------------------------------------------------------------------------
// Readline helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Review result tracking
// ---------------------------------------------------------------------------

export interface ReviewResult {
  approved: number;
  skipped: number;
  published: number;   // LinkedIn API published
  fallback: number;    // Manual fallback used
  quit: boolean;
}

// ---------------------------------------------------------------------------
// People review (DMs — manual only, unchanged)
// ---------------------------------------------------------------------------

export async function reviewPeople(
  people: ScoredPerson[],
  history: HistoryFile,
  dryRun: boolean
): Promise<ReviewResult> {
  const result: ReviewResult = { approved: 0, skipped: 0, published: 0, fallback: 0, quit: false };
  const now = new Date().toISOString();

  for (let i = 0; i < people.length; i++) {
    const person = people[i]!;

    upsertPerson(history, {
      profileUrl: person.profileUrl,
      name: person.name,
      headline: person.headline,
      icpScore: person.icpScore,
      segment: person.segment,
      status: "discovered",
      discoveredAt: now,
      suggestedMessage: person.suggestedMessage,
    });
    saveHistory(history);

    printPersonCard(person, i + 1, people.length);

    const action = await promptPersonAction(person, dryRun);
    if (action === "quit") {
      result.quit = true;
      break;
    }
    if (action === "approved") {
      setPersonStatus(history, person.profileUrl, "approved");
      result.approved++;
    } else {
      setPersonStatus(history, person.profileUrl, "skipped");
      result.skipped++;
    }
    saveHistory(history);
    console.log();
  }

  return result;
}

function printPersonCard(p: ScoredPerson, index: number, total: number): void {
  console.log("\n" + DIVIDER);
  console.log(chalk.cyan.bold(`  PERSON ${index} / ${total}`));
  console.log(DIVIDER);
  console.log(`  ${chalk.bold("Name:")}     ${p.name}`);
  console.log(`  ${chalk.bold("Headline:")} ${p.headline}`);
  console.log(`  ${chalk.bold("Profile:")}  ${chalk.underline(p.profileUrl)}`);
  console.log(
    `  ${chalk.bold("ICP SCORE:")} ${scoreColor(p.icpScore)}   ` +
      `Segment: ${chalk.magenta(p.segment)}   ` +
      `Confidence: ${(CONFIDENCE_COLOR[p.confidence] ?? chalk.white)(p.confidence)}`
  );

  if (p.whyRelevant.length) {
    console.log(`\n  ${chalk.bold.underline("WHY RELEVANT")}`);
    p.whyRelevant.forEach((r) => console.log(`    - ${r}`));
  }
  if (p.painPoints.length) {
    console.log(`\n  ${chalk.bold.underline("LIKELY PAIN POINTS")}`);
    p.painPoints.forEach((r) => console.log(`    - ${r}`));
  }
  console.log(`\n  ${chalk.bold.underline("PERSONALIZATION HOOK")}`);
  console.log(`    ${chalk.italic(p.personalizationHook)}`);
  if (p.warnings.length) {
    console.log(`\n  ${chalk.yellow.bold("  WARNINGS")}`);
    p.warnings.forEach((w) => console.log(`    ${chalk.yellow("-")} ${w}`));
  }
  console.log(`\n  ${chalk.bold.underline("SUGGESTED DM")}`);
  p.suggestedMessage.split("\n").forEach((l) => console.log(`    ${chalk.green(l)}`));
  console.log(chalk.dim("\n  DMs are always sent manually — no automation."));
}

async function promptPersonAction(
  p: ScoredPerson,
  dryRun: boolean
): Promise<"approved" | "skipped" | "quit"> {
  console.log();
  console.log(
    `  ${chalk.bgGreen.black(" Y ")} Approve   ` +
      `${chalk.bgRed.white(" N ")} Skip   ` +
      `${chalk.bgYellow.black(" E ")} Edit   ` +
      `${chalk.bgGray.white(" Q ")} Quit`
  );
  console.log(DIVIDER);

  while (true) {
    const key = (await readKey()).toLowerCase();

    if (key === "y") {
      if (!dryRun) {
        try {
          await copyToClipboard(p.suggestedMessage);
          await openInBrowser(p.profileUrl);
          console.log(`\n  ${chalk.green.bold("Copied to clipboard. LinkedIn profile opened.")}`);
          console.log(chalk.dim("  -> Paste the message and send it yourself."));
        } catch (err) {
          console.log(`\n  ${chalk.red("Clipboard/browser error:")} ${String(err)}`);
          console.log(`  Message:\n  ${p.suggestedMessage}`);
        }
      } else {
        console.log(`\n  ${chalk.yellow("[DRY RUN]")} Would copy to clipboard + open: ${p.profileUrl}`);
      }
      return "approved";
    }

    if (key === "n") {
      console.log(`  ${chalk.dim("Skipped.")}`);
      return "skipped";
    }

    if (key === "e") {
      const edited = await editText("message", p.suggestedMessage);
      if (edited === null) continue;
      p.suggestedMessage = edited;

      console.log(`\n  ${chalk.bold.underline("EDITED MESSAGE")}`);
      edited.split("\n").forEach((l) => console.log(`    ${chalk.green(l)}`));
      console.log();
      console.log(
        `  ${chalk.bgGreen.black(" Y ")} Approve edited   ` +
          `${chalk.bgRed.white(" N ")} Discard   ` +
          `${chalk.bgGray.white(" Q ")} Quit`
      );

      const k2 = (await readKey()).toLowerCase();
      if (k2 === "y") {
        if (!dryRun) {
          try {
            await copyToClipboard(edited);
            await openInBrowser(p.profileUrl);
            console.log(`\n  ${chalk.green.bold("Edited message copied. LinkedIn opened.")}`);
            console.log(chalk.dim("  -> Paste manually and send yourself."));
          } catch (err) {
            console.log(`  ${chalk.red("Error:")} ${String(err)}`);
          }
        } else {
          console.log(`\n  ${chalk.yellow("[DRY RUN]")} Would copy edited message + open URL.`);
        }
        return "approved";
      }
      if (k2 === "q") return "quit";
      console.log(chalk.dim("  Edit discarded. Skipping."));
      return "skipped";
    }

    if (key === "q" || key === "\u0003") return "quit";
  }
}

// ---------------------------------------------------------------------------
// Post review (comments — LinkedIn API if authorized, else manual fallback)
// ---------------------------------------------------------------------------

export async function reviewPosts(
  posts: ScoredPost[],
  history: HistoryFile,
  dryRun: boolean,
  run: { commentsPublished: number; commentsFallback: number }
): Promise<ReviewResult> {
  const result: ReviewResult = { approved: 0, skipped: 0, published: 0, fallback: 0, quit: false };
  const now = new Date().toISOString();

  // Show LinkedIn API status once at the start
  const apiReady = isAuthorized();
  if (apiReady) {
    console.log(chalk.green.bold("  LinkedIn API authorized — comments will be published via API."));
  } else {
    console.log(
      chalk.yellow(
        "  LinkedIn API not authorized — comments will use clipboard + manual submit.\n" +
          "  To authorize, run: npm run growth -- --linkedin-auth"
      )
    );
  }

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i]!;

    upsertPost(history, {
      postUrl: post.postUrl,
      authorName: post.authorName,
      postSummary: post.postSummary,
      relevanceScore: post.relevanceScore,
      status: "discovered",
      discoveredAt: now,
      suggestedComment: post.suggestedComment,
    });
    saveHistory(history);

    printPostCard(post, i + 1, posts.length, apiReady);

    const action = await promptPostAction(post, dryRun, apiReady);
    if (action.quit) {
      result.quit = true;
      break;
    }
    if (action.skipped) {
      setPostStatus(history, post.postUrl, "skipped");
      result.skipped++;
    } else {
      // approved
      result.approved++;
      setPostStatus(history, post.postUrl, action.finalStatus, {
        commentUrn: action.commentUrn,
        statusReason: action.statusReason,
      });
      if (action.finalStatus === "published") {
        result.published++;
        run.commentsPublished++;
      } else {
        result.fallback++;
        run.commentsFallback++;
      }
    }
    saveHistory(history);
    console.log();
  }

  return result;
}

function printPostCard(
  p: ScoredPost,
  index: number,
  total: number,
  apiReady: boolean
): void {
  console.log("\n" + DIVIDER);
  console.log(chalk.blue.bold(`  POST ${index} / ${total}`));
  console.log(DIVIDER);
  console.log(`  ${chalk.bold("Author:")}  ${p.authorName}`);
  console.log(`  ${chalk.bold("URL:")}     ${chalk.underline(p.postUrl)}`);
  console.log(
    `  ${chalk.bold("Relevance:")} ${scoreColor(p.relevanceScore)}   ` +
      `Confidence: ${(CONFIDENCE_COLOR[p.confidence] ?? chalk.white)(p.confidence)}`
  );
  console.log(
    `  ${chalk.bold("Comment via:")} ${apiReady ? chalk.green("LinkedIn API") : chalk.yellow("Manual (clipboard)")}`
  );

  console.log(`\n  ${chalk.bold.underline("POST SUMMARY")}`);
  console.log(`    ${p.postSummary}`);

  console.log(`\n  ${chalk.bold.underline("WHY RELEVANT")}`);
  console.log(`    ${p.whyRelevant}`);

  if (p.warnings.length) {
    console.log(`\n  ${chalk.yellow.bold("  WARNINGS")}`);
    p.warnings.forEach((w) => console.log(`    ${chalk.yellow("-")} ${w}`));
  }

  console.log(`\n  ${chalk.bold.underline("SUGGESTED COMMENT")}`);
  p.suggestedComment.split("\n").forEach((l) => console.log(`    ${chalk.cyan(l)}`));
}

interface PostActionResult {
  skipped: boolean;
  quit: boolean;
  finalStatus: import("../storage/models.js").CommentStatus;
  commentUrn?: string;
  statusReason?: string;
}

async function promptPostAction(
  p: ScoredPost,
  dryRun: boolean,
  apiReady: boolean
): Promise<PostActionResult> {
  console.log();
  console.log(
    `  ${chalk.bgGreen.black(" Y ")} Approve   ` +
      `${chalk.bgRed.white(" N ")} Skip   ` +
      `${chalk.bgYellow.black(" E ")} Edit   ` +
      `${chalk.bgGray.white(" Q ")} Quit`
  );
  console.log(DIVIDER);

  while (true) {
    const key = (await readKey()).toLowerCase();

    if (key === "y") {
      return await executeCommentApproval(p.postUrl, p.suggestedComment, dryRun, apiReady);
    }

    if (key === "n") {
      console.log(chalk.dim("  Skipped."));
      return { skipped: true, quit: false, finalStatus: "skipped" };
    }

    if (key === "e") {
      const edited = await editText("comment", p.suggestedComment);
      if (edited === null) continue;
      p.suggestedComment = edited;

      console.log(`\n  ${chalk.bold.underline("EDITED COMMENT")}`);
      edited.split("\n").forEach((l) => console.log(`    ${chalk.cyan(l)}`));
      console.log();
      console.log(
        `  ${chalk.bgGreen.black(" Y ")} Approve edited   ` +
          `${chalk.bgRed.white(" N ")} Discard   ` +
          `${chalk.bgGray.white(" Q ")} Quit`
      );

      const k2 = (await readKey()).toLowerCase();
      if (k2 === "y") {
        return await executeCommentApproval(p.postUrl, edited, dryRun, apiReady);
      }
      if (k2 === "q") return { skipped: false, quit: true, finalStatus: "skipped" };
      console.log(chalk.dim("  Edit discarded. Skipping."));
      return { skipped: true, quit: false, finalStatus: "skipped" };
    }

    if (key === "q" || key === "\u0003") {
      return { skipped: false, quit: true, finalStatus: "skipped" };
    }
  }
}

/**
 * Executes the comment action after user presses Y.
 * In dry-run: shows what would happen, never calls API or opens browser.
 * With API auth: calls LinkedIn API, falls back to manual on failure.
 * Without API auth: clipboard + browser immediately.
 */
async function executeCommentApproval(
  postUrl: string,
  commentText: string,
  dryRun: boolean,
  apiReady: boolean
): Promise<PostActionResult> {
  if (dryRun) {
    const mode = apiReady ? "LinkedIn API" : "clipboard+browser (manual)";
    console.log(`\n  ${chalk.yellow("[DRY RUN]")} Would submit via ${mode}: ${postUrl}`);
    return { skipped: false, quit: false, finalStatus: "approved" };
  }

  if (apiReady) {
    // Attempt LinkedIn API publish
    console.log(chalk.dim("\n  Publishing via LinkedIn API..."));
    const result = await publishComment(postUrl, commentText);

    if (result.status === "published") {
      console.log(`\n  ${chalk.green.bold("Comment published successfully through LinkedIn API.")}`);
      return {
        skipped: false,
        quit: false,
        finalStatus: "published",
        commentUrn: result.commentUrn,
      };
    }

    if (result.status === "manual_fallback") {
      console.log(`\n  ${chalk.yellow("LinkedIn API authorization unavailable.")}`);
      console.log(chalk.dim(`  Reason: ${result.reason ?? "Unknown"}`));
      return await manualFallback(postUrl, commentText, "manual_fallback", result.reason);
    }

    // publish_failed — tell user clearly, then fall back to manual
    console.log(`\n  ${chalk.red.bold("LinkedIn API comment failed.")}`);
    console.log(chalk.dim(`  Reason: ${result.reason ?? "Unknown"}`));
    return await manualFallback(postUrl, commentText, "publish_failed", result.reason);
  }

  // Not authorized — go straight to manual
  return await manualFallback(postUrl, commentText, "manual_fallback", "LinkedIn API not authorized");
}

async function manualFallback(
  postUrl: string,
  commentText: string,
  finalStatus: import("../storage/models.js").CommentStatus,
  statusReason?: string
): Promise<PostActionResult> {
  try {
    await copyToClipboard(commentText);
    await openInBrowser(postUrl);
    console.log(`\n  ${chalk.cyan("Comment copied to clipboard. Post opened in browser.")}`);
    console.log(chalk.yellow.bold("  -> Paste the comment in the LinkedIn comment box and submit manually."));
  } catch (err) {
    console.log(`  ${chalk.red("Clipboard/browser error:")} ${String(err)}`);
    console.log(`  Comment to paste manually:\n  ${commentText}`);
  }
  return { skipped: false, quit: false, finalStatus, statusReason };
}

// ---------------------------------------------------------------------------
// Shared edit helper
// ---------------------------------------------------------------------------

async function editText(label: string, current: string): Promise<string | null> {
  console.log(chalk.dim(`\n  Current ${label} (shown below). Press Enter to cancel.`));
  console.log(chalk.dim(`  ${current}\n`));
  const answer = await question(chalk.cyan(`  Your edited ${label}: `));
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function closeRL(): void {
  rl?.close();
  rl = null;
}