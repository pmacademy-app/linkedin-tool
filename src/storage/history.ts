import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type {
  HistoryFile,
  HistoryPersonRecord,
  HistoryPostRecord,
  DailyRun,
  PersonStatus,
  CommentStatus,
} from "./models.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = path.resolve(__dirname, "../../data/history.json");

const EMPTY_HISTORY: HistoryFile = {
  version: 2,
  people: {},
  posts: {},
  runs: [],
};

// ---------------------------------------------------------------------------
// URL normalisation
// ---------------------------------------------------------------------------

/** Strip query params and trailing slashes — same profile always = same key. */
export function normaliseUrl(url: string): string {
  try {
    const u = new URL(url);
    return (u.origin + u.pathname).replace(/\/$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase().replace(/\/$/, "");
  }
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

export function loadHistory(): HistoryFile {
  if (!fs.existsSync(HISTORY_PATH)) {
    return structuredClone(EMPTY_HISTORY);
  }
  try {
    const raw = fs.readFileSync(HISTORY_PATH, "utf-8");
    const parsed = JSON.parse(raw) as HistoryFile;
    return {
      ...EMPTY_HISTORY,
      ...parsed,
      people: parsed.people ?? {},
      posts: parsed.posts ?? {},
      runs: parsed.runs ?? [],
    };
  } catch {
    console.error("Warning: history.json is corrupted — starting with empty history.");
    return structuredClone(EMPTY_HISTORY);
  }
}

export function saveHistory(history: HistoryFile): void {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), "utf-8");
}

export function getHistoryPath(): string {
  return HISTORY_PATH;
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function isPersonKnown(history: HistoryFile, profileUrl: string): boolean {
  return normaliseUrl(profileUrl) in history.people;
}

export function isPostKnown(history: HistoryFile, postUrl: string): boolean {
  return normaliseUrl(postUrl) in history.posts;
}

// ---------------------------------------------------------------------------
// Upsert helpers
// ---------------------------------------------------------------------------

export function upsertPerson(
  history: HistoryFile,
  record: Omit<HistoryPersonRecord, "updatedAt">
): void {
  const key = normaliseUrl(record.profileUrl);
  history.people[key] = { ...record, updatedAt: new Date().toISOString() };
}

export function upsertPost(
  history: HistoryFile,
  record: Omit<HistoryPostRecord, "updatedAt">
): void {
  const key = normaliseUrl(record.postUrl);
  history.posts[key] = { ...record, updatedAt: new Date().toISOString() };
}

export function setPersonStatus(
  history: HistoryFile,
  profileUrl: string,
  status: PersonStatus,
  extra?: { notes?: string }
): boolean {
  const key = normaliseUrl(profileUrl);
  if (!history.people[key]) return false;
  history.people[key]!.status = status;
  history.people[key]!.updatedAt = new Date().toISOString();
  if (extra?.notes) history.people[key]!.notes = extra.notes;
  return true;
}

export function setPostStatus(
  history: HistoryFile,
  postUrl: string,
  status: CommentStatus,
  extra?: { commentUrn?: string; statusReason?: string }
): boolean {
  const key = normaliseUrl(postUrl);
  if (!history.posts[key]) return false;
  const rec = history.posts[key]!;
  rec.status = status;
  rec.updatedAt = new Date().toISOString();
  if (extra?.commentUrn) rec.commentUrn = extra.commentUrn;
  if (extra?.statusReason) rec.statusReason = extra.statusReason;
  return true;
}

// ---------------------------------------------------------------------------
// Daily run helpers
// ---------------------------------------------------------------------------

export function startRun(history: HistoryFile, runId: string): DailyRun {
  const run: DailyRun = {
    runId,
    date: new Date().toISOString().slice(0, 10),
    startedAt: new Date().toISOString(),
    peopleDiscovered: 0,
    peopleSelected: 0,
    peopleApproved: 0,
    peopleSkipped: 0,
    postsDiscovered: 0,
    postsSelected: 0,
    commentsApproved: 0,
    commentsSkipped: 0,
    commentsPublished: 0,
    commentsFallback: 0,
    errors: [],
  };
  history.runs.push(run);
  return run;
}

export function finishRun(history: HistoryFile, run: DailyRun): void {
  run.finishedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export function resetHistory(): void {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(
    HISTORY_PATH,
    JSON.stringify(EMPTY_HISTORY, null, 2),
    "utf-8"
  );
}