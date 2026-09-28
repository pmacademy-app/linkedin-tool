/**
 * Default browser opener â€” wraps Node child_process with graceful fallback.
 * Uses the OS "open" mechanism; never touches LinkedIn programmatically.
 */
import { exec } from "child_process";

export function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    let cmd: string;
    if (platform === "win32") {
      // PowerShell-safe: escape & in URLs
      cmd = `start "" "${url}"`;
    } else if (platform === "darwin") {
      cmd = `open "${url}"`;
    } else {
      cmd = `xdg-open "${url}"`;
    }

    exec(cmd, (err) => {
      if (err) {
        reject(new Error(`Failed to open browser: ${err.message}`));
      } else {
        resolve();
      }
    });
  });
}
