/**
 * Workflow: Display historical sessions and audit events with filtering.
 * Command: npm run growth --history [--limit N] [--entity TYPE] [--event TYPE]
 */
import chalk from "chalk";
import { GrowthRepository } from "../database/repository.js";

const DIVIDER = chalk.dim("=".repeat(70));

export interface HistoryWorkflowOptions {
  limit?: number;
  entityType?: string;
  eventType?: string;
}

export function runHistoryWorkflow(
  repo: GrowthRepository,
  options: HistoryWorkflowOptions = {}
): void {
  const limit = options.limit || 30;

  console.log();
  console.log(chalk.bgMagenta.white.bold("  PRODILY GROWTH OS -- HISTORICAL EVENT LOG  "));
  console.log(DIVIDER);

  // Filters display
  const filterDesc = [];
  if (options.entityType) filterDesc.push(`entity: ${options.entityType}`);
  if (options.eventType) filterDesc.push(`event: ${options.eventType}`);
  filterDesc.push(`limit: ${limit}`);
  console.log(chalk.dim(`  Active filters: [${filterDesc.join(", ")}]\n`));

  // 1. Recent Sessions
  console.log(chalk.bold.white("  RECENT SESSIONS"));
  const sessions = repo.getRecentSessions(10);
  if (sessions.length === 0) {
    console.log(chalk.dim("    No sessions found."));
  } else {
    for (const s of sessions) {
      const statusColor =
        s.status === "completed"
          ? chalk.green
          : s.status === "failed"
          ? chalk.red
          : chalk.yellow;
      const started = new Date(s.started_at).toLocaleString();
      const dur = s.completed_at
        ? `${Math.round((new Date(s.completed_at).getTime() - new Date(s.started_at).getTime()) / 1000)}s`
        : "in progress";

      console.log(
        `  ${chalk.dim(started)}  ` +
          `cmd: ${chalk.cyan(s.command.padEnd(16))}  ` +
          `status: ${statusColor(s.status.padEnd(11))}  ` +
          `dur: ${chalk.dim(dur)}`
      );
    }
  }

  console.log("\n" + DIVIDER);
  console.log(chalk.bold.white("  AUDIT EVENTS (APPEND-ONLY)"));
  console.log(DIVIDER);

  const events = repo.getRecentEvents(limit, {
    entityType: options.entityType,
    eventType: options.eventType,
  });

  if (events.length === 0) {
    console.log(chalk.dim("  No events matching query."));
  } else {
    for (const ev of events) {
      const time = new Date(ev.created_at).toLocaleTimeString();
      const date = new Date(ev.created_at).toISOString().slice(0, 10);

      let payloadStr = "";
      try {
        const parsed = JSON.parse(ev.event_data || "{}");
        const keys = Object.keys(parsed);
        if (keys.length > 0) {
          payloadStr = chalk.dim(
            " " +
              keys
                .slice(0, 3)
                .map((k) => `${k}=${JSON.stringify(parsed[k])}`)
                .join(" ")
          );
        }
      } catch {
        // ignore
      }

      const entityBadge = chalk.magenta(`[${ev.entity_type}]`);
      const eventBadge = formatEventBadge(ev.event_type);

      console.log(
        `  ${chalk.dim(date + " " + time)}  ${entityBadge.padEnd(16)}  ${eventBadge.padEnd(20)}  ${chalk.dim(ev.entity_id.slice(0, 8))}${payloadStr}`
      );
    }
  }

  console.log(DIVIDER + "\n");
}

function formatEventBadge(type: string): string {
  switch (type) {
    case "published":
      return chalk.green.bold(type);
    case "publish_failed":
      return chalk.red.bold(type);
    case "approved":
      return chalk.green(type);
    case "skipped":
      return chalk.dim(type);
    case "discovered":
      return chalk.cyan(type);
    case "re_discovered":
      return chalk.blue(type);
    default:
      return chalk.white(type);
  }
}
