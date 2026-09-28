/**
 * SQLite database connection management.
 * Uses Node.js built-in DatabaseSync for zero-dependency, crash-safe local storage.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = path.resolve(__dirname, "../../data/database/growth.db");

let _instance: DatabaseSync | null = null;
let _currentPath: string | null = null;

export function getDatabasePath(): string {
  return process.env["GROWTH_DB_PATH"] || DEFAULT_DB_PATH;
}

export function getDatabase(customPath?: string): DatabaseSync {
  const targetPath = customPath || getDatabasePath();

  if (_instance && _currentPath === targetPath) {
    return _instance;
  }

  if (_instance) {
    try {
      _instance.close();
    } catch {
      // ignore
    }
    _instance = null;
  }

  if (targetPath !== ":memory:") {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(targetPath);

  // Crash-safe configuration
  db.exec("PRAGMA foreign_keys = ON;");
  if (targetPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }

  _instance = db;
  _currentPath = targetPath;

  return _instance;
}

export function closeDatabase(): void {
  if (_instance) {
    try {
      _instance.close();
    } catch {
      // ignore
    }
    _instance = null;
    _currentPath = null;
  }
}
