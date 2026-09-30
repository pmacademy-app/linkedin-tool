/**
 * People discovery — provider abstraction + implementations:
 *   FirecrawlPeopleProvider  (default real provider)
 *   SerperPeopleProvider     (kept as secondary)
 *   MockPeopleProvider       (test/dry-run)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  SEARCH_PROVIDER,
  SEARCH_API_KEY,
  PEOPLE_SEARCH_QUERIES,
} from "../config.js";
import {
  firecrawlSearch,
  extractLinkedInProfileUrl,
  normalizeLinkedInProfileUrl,
  cleanTitle,
  sleep,
  getInterQueryDelayMs,
  FirecrawlRateLimitError,
} from "./firecrawl.js";
import type { RawPerson } from "../storage/models.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface PeopleDiscoveryProvider {
  name: string;
  discoverPeople(limit: number): Promise<RawPerson[]>;
}

// ---------------------------------------------------------------------------
// Dedupe helper
// ---------------------------------------------------------------------------

export function dedupeByProfileUrl(people: RawPerson[]): RawPerson[] {
  const map = new Map<string, RawPerson>();
  for (const p of people) {
    const canonical = normalizeLinkedInProfileUrl(p.profileUrl) || p.profileUrl.toLowerCase().replace(/\/$/, "");
    if (!map.has(canonical)) {
      map.set(canonical, {
        ...p,
        profileUrl: canonical,
      });
    } else {
      const existing = map.get(canonical)!;
      // Preserve candidate with richer headline or snippets
      if ((p.headline?.length || 0) > (existing.headline?.length || 0)) {
        map.set(canonical, {
          ...p,
          profileUrl: canonical,
        });
      }
    }
  }
  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// Firecrawl provider (primary real provider)
// ---------------------------------------------------------------------------

class FirecrawlPeopleProvider implements PeopleDiscoveryProvider {
  name = "firecrawl";

  async discoverPeople(limit: number): Promise<RawPerson[]> {
    const collected: RawPerson[] = [];
    const seenUrls = new Set<string>();

    for (let i = 0; i < PEOPLE_SEARCH_QUERIES.length; i++) {
      if (collected.length >= limit) {
        break; // Stop immediately once enough unique candidates are found
      }

      const query = PEOPLE_SEARCH_QUERIES[i]!;

      // Pacing delay between consecutive requests
      if (i > 0 && getInterQueryDelayMs() > 0) {
        await sleep(getInterQueryDelayMs());
      }

      try {
        const results = await firecrawlSearch(query, 10);
        for (const item of results) {
          const profileUrl = extractLinkedInProfileUrl(item.url ?? "");
          if (!profileUrl) continue;

          // Skip obvious non-person LinkedIn URLs
          if (this.isCompanyOrJobUrl(item.url)) continue;

          const normUrl = normalizeLinkedInProfileUrl(profileUrl) || profileUrl;
          if (seenUrls.has(normUrl)) continue;
          seenUrls.add(normUrl);

          const name = cleanTitle(item.title ?? "");
          const headline = item.description ?? item.markdown?.slice(0, 300) ?? "";
          const snippets: string[] = [];
          if (item.description) snippets.push(item.description);
          if (item.markdown) snippets.push(item.markdown.slice(0, 500));

          collected.push({ profileUrl: normUrl, name, headline, snippets, source: "firecrawl" });

          if (collected.length >= limit) {
            break;
          }
        }
      } catch (err) {
        // Non-fatal: log as skipped query and continue with remaining queries
        const isRateLimit =
          err instanceof FirecrawlRateLimitError ||
          String(err).includes("429") ||
          String(err).toLowerCase().includes("rate limit");

        if (isRateLimit) {
          console.warn(
            `[discovery/people] Skipped query "${query}": Firecrawl rate limit exceeded after retries.`
          );
        } else {
          console.warn(
            `[discovery/people] Skipped query "${query}": ${String(err)}`
          );
        }
      }
    }

    return collected.slice(0, limit);
  }

  private isCompanyOrJobUrl(url: string): boolean {
    try {
      const u = new URL(url);
      const path = u.pathname;
      return (
        path.startsWith("/company/") ||
        path.startsWith("/jobs/") ||
        path.startsWith("/school/") ||
        path.includes("/job-")
      );
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Serper provider (secondary — requires SEARCH_API_KEY)
// ---------------------------------------------------------------------------

class SerperPeopleProvider implements PeopleDiscoveryProvider {
  name = "serper";

  async discoverPeople(limit: number): Promise<RawPerson[]> {
    if (!SEARCH_API_KEY) {
      throw new Error(
        "SEARCH_API_KEY is not set. Add your serper.dev API key to .env.\n" +
          "Get a free key at https://serper.dev\n" +
          "Or use SEARCH_PROVIDER=firecrawl or SEARCH_PROVIDER=mock"
      );
    }

    const collected: RawPerson[] = [];

    for (const query of PEOPLE_SEARCH_QUERIES) {
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
          const profileUrl = extractLinkedInProfileUrl(item.link ?? "");
          if (!profileUrl) continue;
          collected.push({
            profileUrl,
            name: cleanTitle(item.title ?? ""),
            headline: item.snippet ?? "",
            snippets: item.snippet ? [item.snippet] : [],
            source: "serper",
          });
        }
      } catch (err) {
        console.warn(
          `[discovery/people] Serper query "${query}" failed: ${String(err)}`
        );
      }
    }

    return dedupeByProfileUrl(collected).slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Mock provider — reads data/fixtures/people.json (no API key needed)
// ---------------------------------------------------------------------------

class MockPeopleProvider implements PeopleDiscoveryProvider {
  name = "mock";

  async discoverPeople(limit: number): Promise<RawPerson[]> {
    const fixturePath = path.resolve(__dirname, "../../data/fixtures/people.json");
    if (!fs.existsSync(fixturePath)) {
      throw new Error(
        `Mock fixture not found: ${fixturePath}\n` +
          "Create data/fixtures/people.json or set SEARCH_PROVIDER=firecrawl."
      );
    }
    const raw = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as RawPerson[];
    return raw.slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function getPeopleProvider(): PeopleDiscoveryProvider {
  const provider = process.env["SEARCH_PROVIDER"] ?? SEARCH_PROVIDER;
  switch (provider) {
    case "firecrawl":
      return new FirecrawlPeopleProvider();
    case "serper":
      return new SerperPeopleProvider();
    case "mock":
    default:
      return new MockPeopleProvider();
  }
}