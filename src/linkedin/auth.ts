/**
 * LinkedIn OAuth 2.0 authentication.
 *
 * Uses the official LinkedIn OAuth 2.0 (3-legged) flow:
 *   https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
 *
 * Scope required: w_member_social
 *   Granted via "Share on LinkedIn" product in the LinkedIn Developer Portal.
 *   This is an Open Permission — no formal review process required.
 *
 * Token storage: data/linkedin-auth.json (gitignored, never printed to terminal)
 *
 * IMPORTANT: This module NEVER stores LinkedIn passwords, cookies, or sessions.
 * It only handles official OAuth access tokens issued by LinkedIn's auth server.
 */
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { LINKEDIN } from "../config.js";
import { openInBrowser } from "../utils/browser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.resolve(__dirname, "../../data/linkedin-auth.json");

// ---------------------------------------------------------------------------
// Token storage types
// ---------------------------------------------------------------------------

interface LinkedInToken {
  accessToken: string;      // Never logged to terminal
  expiresAt: number;        // Unix ms
  refreshToken?: string;
  personUrn?: string;       // urn:li:person:<id> — needed as actor for comments
}

// ---------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------

export function loadToken(): LinkedInToken | null {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  try {
    const raw = fs.readFileSync(TOKEN_PATH, "utf-8");
    return JSON.parse(raw) as LinkedInToken;
  } catch {
    return null;
  }
}

function saveToken(token: LinkedInToken): void {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  // Write with restricted permissions — tokens stay local only
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2), {
    encoding: "utf-8",
    mode: 0o600,  // owner read/write only
  });
}

export function clearToken(): void {
  if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
}

// ---------------------------------------------------------------------------
// Auth state checks
// ---------------------------------------------------------------------------

export function isAuthorized(): boolean {
  const token = loadToken();
  if (!token) return false;
  if (Date.now() >= token.expiresAt) return false; // expired
  return true;
}

export function getAccessToken(): string | null {
  const token = loadToken();
  if (!token) return null;
  if (Date.now() >= token.expiresAt) return null;
  return token.accessToken;
}

export function getPersonUrn(): string | null {
  return loadToken()?.personUrn ?? null;
}

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

export function buildAuthorizationUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: LINKEDIN.clientId,
    redirect_uri: LINKEDIN.redirectUri,
    state,
    scope: "w_member_social",
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
}

async function exchangeCodeForToken(code: string): Promise<LinkedInToken> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: LINKEDIN.redirectUri,
    client_id: LINKEDIN.clientId,
    client_secret: LINKEDIN.clientSecret,
  });

  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LinkedIn token exchange failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  if (!data.access_token) {
    throw new Error("LinkedIn OAuth: access_token missing in response");
  }

  const token: LinkedInToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    refreshToken: data.refresh_token,
  };

  // Fetch the member's person URN (needed as actor for comments)
  token.personUrn = await fetchPersonUrn(data.access_token);

  return token;
}

async function fetchPersonUrn(accessToken: string): Promise<string | undefined> {
  try {
    // Use OpenID userinfo endpoint to get the member sub (LinkedIn person ID)
    const res = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { sub?: string };
    if (!data.sub) return undefined;
    return `urn:li:person:${data.sub}`;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Local OAuth callback server
// ---------------------------------------------------------------------------

/**
 * Runs a temporary HTTP server on LINKEDIN.callbackPort to receive the OAuth
 * authorization code, then shuts itself down.
 *
 * Returns the authorization code on success or throws on timeout/error.
 */
function waitForOAuthCallback(
  expectedState: string,
  timeoutMs = 120_000
): Promise<string> {
  return new Promise((resolve, reject) => {
    let server: http.Server | null = null;
    const timer = setTimeout(() => {
      server?.close();
      reject(new Error("LinkedIn OAuth timed out waiting for callback (120s)"));
    }, timeoutMs);

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${LINKEDIN.callbackPort}`);

      if (url.pathname !== "/oauth/linkedin/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      const errorDesc = url.searchParams.get("error_description");
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<h2>LinkedIn authorization failed</h2><p>${errorDesc ?? error}</p><p>You can close this tab.</p>`
        );
        clearTimeout(timer);
        server?.close();
        reject(new Error(`LinkedIn OAuth error: ${errorDesc ?? error}`));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h2>Invalid state parameter</h2><p>You can close this tab.</p>");
        clearTimeout(timer);
        server?.close();
        reject(new Error("LinkedIn OAuth: state mismatch (possible CSRF)"));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h2>Missing authorization code</h2><p>You can close this tab.</p>");
        clearTimeout(timer);
        server?.close();
        reject(new Error("LinkedIn OAuth: no authorization code received"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h2 style='color:green'>Authorization successful!</h2>" +
          "<p>You can close this tab and return to the terminal.</p>"
      );
      clearTimeout(timer);
      server?.close();
      resolve(code);
    });

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`OAuth callback server error: ${err.message}`));
    });

    server.listen(LINKEDIN.callbackPort);
  });
}

// ---------------------------------------------------------------------------
// Public: run the full OAuth flow
// ---------------------------------------------------------------------------

/**
 * Checks for credentials, starts local callback server, opens browser,
 * waits for user to authorize, exchanges code for token, saves token.
 *
 * Never prints the access token to terminal.
 */
export async function runOAuthFlow(): Promise<void> {
  if (!LINKEDIN.clientId || !LINKEDIN.clientSecret) {
    throw new Error(
      "LinkedIn OAuth requires LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET.\n" +
        "See README for setup instructions."
    );
  }

  // Crypto-random state to prevent CSRF
  const { randomBytes } = await import("crypto");
  const state = randomBytes(16).toString("hex");

  const authUrl = buildAuthorizationUrl(state);

  console.log(
    "\n  LinkedIn Authorization URL:\n  " + authUrl +
      "\n\n  Opening in browser... authorize the app, then return here."
  );

  try {
    await openInBrowser(authUrl);
  } catch {
    console.log("  Could not open browser automatically. Please open the URL above manually.");
  }

  console.log(`\n  Waiting for LinkedIn to redirect to http://localhost:${LINKEDIN.callbackPort}...`);

  const code = await waitForOAuthCallback(state);
  const token = await exchangeCodeForToken(code);
  saveToken(token);

  // Log actor URN only — never the token itself
  console.log(
    `\n  LinkedIn authorized! Actor: ${token.personUrn ?? "(unknown)"}\n` +
      "  Token saved locally. It will never be printed or committed."
  );
}