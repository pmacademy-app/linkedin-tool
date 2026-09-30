/**
 * Firecrawl discovery provider — shared HTTP client and helpers.
 *
 * Uses the Firecrawl /v1/search endpoint (public web search).
 * Does NOT scrape LinkedIn directly, does NOT authenticate to LinkedIn,
 * and does NOT bypass any platform restrictions.
 *
 * Firecrawl Search API reference:
 *   https://docs.firecrawl.dev/api-reference/endpoint/search
 */
import { FIRECRAWL_API_KEY, FIRECRAWL_BASE_URL } from "../config.js";

// ---------------------------------------------------------------------------
// Types mirroring Firecrawl /v1/search response
// ---------------------------------------------------------------------------

export interface FirecrawlSearchResult {
  url: string;
  title: string;
  description: string;
  /** Scraped markdown content (may be empty for search-only requests) */
  markdown?: string;
}

export interface FirecrawlSearchResponse {
  success: boolean;
  data: FirecrawlSearchResult[];
  warning?: string;
}

// ---------------------------------------------------------------------------
// Error types & delay utilities
// ---------------------------------------------------------------------------

export class FirecrawlRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirecrawlRateLimitError";
  }
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let interQueryDelayMs = 1500;

export function setInterQueryDelayMs(ms: number): void {
  interQueryDelayMs = ms;
}

export function getInterQueryDelayMs(): number {
  return interQueryDelayMs;
}

// ---------------------------------------------------------------------------
// Core search function with 429 exponential backoff
// ---------------------------------------------------------------------------

export interface FirecrawlSearchOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
  backoffFactor?: number;
}

export async function firecrawlSearch(
  query: string,
  limit = 10,
  options: FirecrawlSearchOptions = {}
): Promise<FirecrawlSearchResult[]> {
  const apiKey = process.env["FIRECRAWL_API_KEY"] ?? FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "FIRECRAWL_API_KEY is not set.\n" +
        "Copy .env.example to .env and add your Firecrawl API key.\n" +
        "Get a free key at https://firecrawl.dev\n" +
        "For testing without keys, set SEARCH_PROVIDER=mock in .env"
    );
  }

  const maxRetries = options.maxRetries ?? 3;
  const initialBackoffMs =
    options.initialBackoffMs ??
    (process.env["FIRECRAWL_INITIAL_BACKOFF_MS"]
      ? parseInt(process.env["FIRECRAWL_INITIAL_BACKOFF_MS"], 10)
      : 2000);
  const backoffFactor = options.backoffFactor ?? 2;

  let lastStatus = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${FIRECRAWL_BASE_URL}/v1/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, limit }),
      });
    } catch (networkErr) {
      if (attempt < maxRetries) {
        const delay = initialBackoffMs * Math.pow(backoffFactor, attempt);
        console.warn(
          `[Firecrawl] Network error on query "${query}". Retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`
        );
        await sleep(delay);
        continue;
      }
      throw new Error(`Firecrawl network error: ${String(networkErr)}`);
    }

    lastStatus = res.status;

    if (res.status === 401) {
      throw new Error("Firecrawl: invalid API key (401). Check FIRECRAWL_API_KEY.");
    }

    if (res.status === 429) {
      if (attempt < maxRetries) {
        const retryAfterHeader = res.headers.get("retry-after");
        let delay = initialBackoffMs * Math.pow(backoffFactor, attempt);
        if (retryAfterHeader) {
          const parsedSeconds = parseInt(retryAfterHeader, 10);
          if (!isNaN(parsedSeconds) && parsedSeconds > 0) {
            delay = Math.max(delay, parsedSeconds * 1000);
          }
        }
        console.warn(
          `[Firecrawl] Rate limited (429) on query "${query}". Retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`
        );
        await sleep(delay);
        continue;
      }

      throw new FirecrawlRateLimitError(
        `Firecrawl: rate limit exceeded (429) after ${maxRetries} retries for query: "${query}".`
      );
    }

    // Retry on 5xx server errors if retries remain
    if (res.status >= 500 && attempt < maxRetries) {
      const delay = initialBackoffMs * Math.pow(backoffFactor, attempt);
      console.warn(
        `[Firecrawl] Server error (${res.status}) on query "${query}". Retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`
      );
      await sleep(delay);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Firecrawl search failed (${res.status}): ${body.slice(0, 200)}`);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new Error("Firecrawl returned non-JSON response.");
    }

    const data = parsed as FirecrawlSearchResponse;
    if (!data.success || !Array.isArray(data.data)) {
      throw new Error(
        `Firecrawl search returned unexpected shape: ${JSON.stringify(parsed).slice(0, 200)}`
      );
    }

    return data.data;
  }

  throw new Error(`Firecrawl search failed after retries (HTTP ${lastStatus}).`);
}

// ---------------------------------------------------------------------------
// URL helpers shared by people and posts providers
// ---------------------------------------------------------------------------

/**
 * Normalizes any LinkedIn profile URL into a canonical format:
 *   https://www.linkedin.com/in/<username>
 *
 * Handles:
 * - Trailing slashes: /in/john-doe/ -> /in/john-doe
 * - Query parameters: /in/john-doe?miniProfileUrn=...&trk=... -> /in/john-doe
 * - Hash fragments: /in/john-doe#experience -> /in/john-doe
 * - Country subdomains: in.linkedin.com, uk.linkedin.com, ca.linkedin.com -> www.linkedin.com
 * - Protocol variants: http:// -> https://
 * - Case variations: /in/John-Doe -> /in/john-doe
 * - Extra path segments: /in/john-doe/overlay/contact-info/ -> /in/john-doe
 * - Excludes non-profile URLs (company, jobs, school, pulse)
 */
export function normalizeLinkedInProfileUrl(url: string): string | null {
  if (!url || typeof url !== "string") return null;
  try {
    const raw = url.trim();
    const parsed = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes("linkedin.com")) return null;

    // Exclude non-person routes
    const pathLower = parsed.pathname.toLowerCase();
    if (
      pathLower.startsWith("/company/") ||
      pathLower.startsWith("/school/") ||
      pathLower.startsWith("/jobs/") ||
      pathLower.startsWith("/pulse/") ||
      pathLower.startsWith("/posts/") ||
      pathLower.startsWith("/feed/")
    ) {
      return null;
    }

    // Match /in/<username> segment
    const match = parsed.pathname.match(/\/in\/([^/?#]+)/i);
    if (!match?.[1]) return null;

    let slug = decodeURIComponent(match[1]).trim().toLowerCase();
    slug = slug.replace(/\/+$/, "");
    if (!slug) return null;

    return `https://www.linkedin.com/in/${slug}`;
  } catch {
    return null;
  }
}

export function extractLinkedInProfileUrl(url: string): string | null {
  return normalizeLinkedInProfileUrl(url);
}

export function isLinkedInPostUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("linkedin.com")) return false;
    return (
      u.pathname.startsWith("/posts/") ||
      u.pathname.startsWith("/feed/update/") ||
      u.pathname.includes("/activity-") ||
      u.pathname.startsWith("/pulse/")
    );
  } catch {
    return false;
  }
}

/** Strip " - LinkedIn" and similar suffixes from page titles */
export function cleanTitle(title: string): string {
  return title
    .replace(/\s*[-|]\s*(LinkedIn|LinkedIn Profile|Profile)\s*$/i, "")
    .replace(/\s*\|\s*(LinkedIn|Profile)\s*$/i, "")
    .trim();
}

/** Extract author name from LinkedIn post page title patterns */
export function extractPostAuthor(title: string): string {
  const match = title.match(/^([^|:]+?)\s+(?:on LinkedIn|LinkedIn Post)/i);
  if (match?.[1]) return match[1].trim();
  return cleanTitle(title) || "Unknown";
}