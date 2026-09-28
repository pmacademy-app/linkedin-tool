/**
 * Post discovery — provider abstraction + implementations:
 *   FirecrawlPostProvider  (default real provider)
 *   SerperPostProvider     (secondary)
 *   MockPostProvider       (test/dry-run)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  SEARCH_PROVIDER,
  SEARCH_API_KEY,
  POST_SEARCH_QUERIES,
} from "../config.js";
import {
  firecrawlSearch,
  isLinkedInPostUrl,
  extractPostAuthor,
  cleanTitle,
  sleep,
  getInterQueryDelayMs,
  FirecrawlRateLimitError,
} from "./firecrawl.js";
import type { RawPost } from "../storage/models.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface PostDiscoveryProvider {
  name: string;
  discoverPosts(limit: number): Promise<RawPost[]>;
}

// ---------------------------------------------------------------------------
// Dedupe helper
// ---------------------------------------------------------------------------

function dedupeByPostUrl(posts: RawPost[]): RawPost[] {
  const seen = new Set<string>();
  return posts.filter((p) => {
    const key = p.postUrl.toLowerCase().replace(/\/$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Firecrawl provider
// ---------------------------------------------------------------------------

class FirecrawlPostProvider implements PostDiscoveryProvider {
  name = "firecrawl";

  async discoverPosts(limit: number): Promise<RawPost[]> {
    const collected: RawPost[] = [];
    const seenUrls = new Set<string>();

    for (let i = 0; i < POST_SEARCH_QUERIES.length; i++) {
      if (collected.length >= limit) {
        break; // Stop immediately once enough unique candidates are found
      }

      const query = POST_SEARCH_QUERIES[i]!;

      // Pacing delay between consecutive requests
      if (i > 0 && getInterQueryDelayMs() > 0) {
        await sleep(getInterQueryDelayMs());
      }

      try {
        const results = await firecrawlSearch(query, 10);
        for (const item of results) {
          const url = item.url ?? "";
          if (!isLinkedInPostUrl(url)) continue;

          const normUrl = url.toLowerCase().replace(/\/$/, "");
          if (seenUrls.has(normUrl)) continue;
          seenUrls.add(normUrl);

          const authorName = extractPostAuthor(item.title ?? "");
          const snippet =
            item.description ?? item.markdown?.slice(0, 500) ?? "";

          collected.push({ postUrl: url, authorName, snippet, source: "firecrawl" });

          if (collected.length >= limit) {
            break;
          }
        }
      } catch (err) {
        const isRateLimit =
          err instanceof FirecrawlRateLimitError ||
          String(err).includes("429") ||
          String(err).toLowerCase().includes("rate limit");

        if (isRateLimit) {
          console.warn(
            `[discovery/posts] Skipped query "${query}": Firecrawl rate limit exceeded after retries.`
          );
        } else {
          console.warn(
            `[discovery/posts] Skipped query "${query}": ${String(err)}`
          );
        }
      }
    }

    return collected.slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Serper provider
// ---------------------------------------------------------------------------

class SerperPostProvider implements PostDiscoveryProvider {
  name = "serper";

  async discoverPosts(limit: number): Promise<RawPost[]> {
    if (!SEARCH_API_KEY) {
      throw new Error("SEARCH_API_KEY is not set. Add your serper.dev API key to .env.");
    }

    const collected: RawPost[] = [];

    for (const query of POST_SEARCH_QUERIES) {
      if (collected.length >= limit * 2) break;
      try {
        const res = await fetch("https://google.serper.dev/search", {
          method: "POST",
          headers: {
            "X-API-KEY": SEARCH_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ q: query, num: 10 }),
        });

        if (!res.ok) {
          throw new Error(`Serper API error ${res.status}: ${await res.text()}`);
        }

        const data = (await res.json()) as {
          organic?: Array<{ link?: string; title?: string; snippet?: string }>;
        };

        for (const item of data.organic ?? []) {
          const url = item.link ?? "";
          if (!isLinkedInPostUrl(url)) continue;
          collected.push({
            postUrl: url,
            authorName: extractPostAuthor(item.title ?? ""),
            snippet: item.snippet ?? "",
            source: "serper",
          });
        }
      } catch (err) {
        console.warn(
          `[discovery/posts] Serper query "${query}" failed: ${String(err)}`
        );
      }
    }

    return dedupeByPostUrl(collected).slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

class MockPostProvider implements PostDiscoveryProvider {
  name = "mock";

  async discoverPosts(limit: number): Promise<RawPost[]> {
    const fixturePath = path.resolve(__dirname, "../../data/fixtures/posts.json");
    if (!fs.existsSync(fixturePath)) {
      throw new Error(`Mock fixture not found: ${fixturePath}`);
    }
    const raw = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as RawPost[];
    return raw.slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function getPostProvider(): PostDiscoveryProvider {
  const provider = process.env["SEARCH_PROVIDER"] ?? SEARCH_PROVIDER;
  switch (provider) {
    case "firecrawl":
      return new FirecrawlPostProvider();
    case "serper":
      return new SerperPostProvider();
    case "mock":
    default:
      return new MockPostProvider();
  }
}