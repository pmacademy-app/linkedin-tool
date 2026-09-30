import "dotenv/config";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export type AiProvider = "nvidia" | "openai" | "mock";

export const AI_PROVIDER: AiProvider =
  optional("AI_PROVIDER", "nvidia") as AiProvider;

export const NVIDIA = {
  apiKey: optional("NVIDIA_API_KEY"),
  // Default model is intentionally read from env — change NVIDIA_MODEL to switch.
  model: optional("NVIDIA_MODEL", "openai/gpt-oss-20b"),
  baseUrl: optional("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"),
};

export const OPENAI = {
  apiKey: optional("OPENAI_API_KEY"),
  model: optional("OPENAI_MODEL", "gpt-4o-mini"),
};

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export type SearchProvider = "firecrawl" | "serper" | "mock";

export const SEARCH_PROVIDER: SearchProvider =
  optional("SEARCH_PROVIDER", "mock") as SearchProvider;

// Firecrawl (primary real provider)
export const FIRECRAWL_API_KEY = optional("FIRECRAWL_API_KEY");
export const FIRECRAWL_BASE_URL = optional(
  "FIRECRAWL_BASE_URL",
  "https://api.firecrawl.dev"
);

// Serper (kept as secondary provider)
export const SEARCH_API_KEY = optional("SEARCH_API_KEY");

// ---------------------------------------------------------------------------
// LinkedIn OAuth
// ---------------------------------------------------------------------------

export const LINKEDIN = {
  clientId: optional("LINKEDIN_CLIENT_ID"),
  clientSecret: optional("LINKEDIN_CLIENT_SECRET"),
  redirectUri: optional(
    "LINKEDIN_REDIRECT_URI",
    "http://localhost:8899/oauth/linkedin/callback"
  ),
  // Member person URN (urn:li:person:<id>) used as author/actor when publishing comments
  personUrn: optional("LINKEDIN_PERSON_URN"),
  // Port used by the local OAuth callback server
  callbackPort: parseInt(optional("LINKEDIN_CALLBACK_PORT", "8899"), 10),
  // Version header required by LinkedIn REST API (YYYYMM format)
  apiVersion: optional("LINKEDIN_API_VERSION", "202506"),
};

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_PEOPLE = parseInt(optional("MAX_PEOPLE", "30"), 10);
export const MAX_POSTS = parseInt(optional("MAX_POSTS", "10"), 10);

// Cooldown period before a skipped/rejected person can be considered again
export const SKIPPED_PERSON_COOLDOWN_DAYS = parseInt(
  optional("SKIPPED_PERSON_COOLDOWN_DAYS", "30"),
  10
);

// ---------------------------------------------------------------------------
// Founder Context
// ---------------------------------------------------------------------------

export { FOUNDER_CONTEXT } from "./ai/founder.js";

// ---------------------------------------------------------------------------
// ICP Definition
// Edit this block to change the target audience — no other file needs changing.
// ---------------------------------------------------------------------------

export const ICP_DEFINITION = `
TARGET AUDIENCE FOR PRODILY (v1)
=================================

Prodily is a free structured Product Management learning platform. The founder
is looking for early users who will test the product and provide honest feedback.

IDEAL CANDIDATES (score high):
- Aspiring Product Managers who have NOT yet entered the field
- Software engineers, designers, or analysts wanting to switch into PM
- MBA students / recent MBA graduates targeting PM roles
- Students or recent graduates interested in PM careers
- Early-career professionals (0-2 years PM experience max) exploring PM
- People actively studying PM (courses, bootcamps, books, certifications)
- People preparing for PM interviews / case studies
- People wanting to build a PM portfolio / capstone project
- People asking "how do I break into product management?" online

GOOD SIGNALS IN HEADLINES / BIO:
- "Aspiring PM", "Aspiring Product Manager"
- "Breaking into product", "Transitioning to PM"
- "Associate Product Manager", "APM"
- "Product Management enthusiast", "Learning PM"
- "MBA | Interested in Product"
- "Software Engineer | Want to be a PM"
- Current non-PM role + expressed desire to move into PM

EXCLUDE (score low or filter out):
- Senior PMs, Directors of Product, VPs of Product, CPOs
- PM recruiters and talent acquisition professionals
- PM coaches, influencers, content creators with large followings
- Agencies, consulting firms, SaaS company pages
- Generic career accounts ("I help people get jobs")
- People with zero connection to learning or entering Product Management
- People already well-established in PM (5+ years experience)
`;

// ---------------------------------------------------------------------------
// Search queries — discovery layer
// ---------------------------------------------------------------------------

export const PEOPLE_SEARCH_QUERIES = [
  "aspiring product manager site:linkedin.com/in",
  "breaking into product management site:linkedin.com/in",
  "transitioning to product management site:linkedin.com/in",
  "associate product manager site:linkedin.com/in",
  "aspiring PM software engineer site:linkedin.com/in",
  "product management career MBA student site:linkedin.com/in",
  "learning product management site:linkedin.com/in",
  "PM interview prep aspiring site:linkedin.com/in",
  "product manager portfolio site:linkedin.com/in",
  "product career transition aspiring site:linkedin.com/in",
  "product management roadmap student site:linkedin.com/in",
  "career switcher product management site:linkedin.com/in",
];

export const POST_SEARCH_QUERIES = [
  "aspiring product manager site:linkedin.com/posts",
  "breaking into product management linkedin discussion",
  "how to get into product management linkedin post",
  "PM interview tips preparation linkedin",
  "product management career transition linkedin post",
  "learning product management linkedin",
  "PM portfolio project linkedin post",
  "product thinking beginners linkedin",
  "associate product manager journey linkedin",
  "product management student linkedin post",
];