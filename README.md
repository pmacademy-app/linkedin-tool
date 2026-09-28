# Prodily Growth OS

A reliable, persistent daily founder-led user acquisition engine for Prodily. Built with Node.js, SQLite, Firecrawl search, NVIDIA NIM AI (`openai/gpt-oss-20b`), and official LinkedIn Comments API integration.

> **Human-in-the-loop by design.** Messages and comments require explicit review and approval. All history, events, and versions are durably recorded in SQLite.

---

## Architecture & Commands Overview

The Growth OS decomposes the single-run prototype into explicit, resumable commands:

```powershell
# 1. Discovery & Scoring
npm run growth --people              # Discover candidates, calculate deterministic signals, score with AI
npm run growth --people -resume      # Resume candidate discovery/scoring session

npm run growth --posts               # Discover posts, calculate deterministic signals, draft comments
npm run growth --posts -resume       # Resume post discovery/scoring session

# 2. Interactive Review
npm run growth --review-people       # Review pending candidates (approve, skip, edit, copy DM)
npm run growth --review-posts        # Review pending comments (authorize for publishing)

# 3. Automated LinkedIn Publishing
npm run growth --publish-comments    # Publish approved comments via official LinkedIn API
npm run growth --publish-comments -resume # Resume interrupted publication from still-pending approved comments

# 4. Status & History
npm run growth --status              # View real-time database counts, pending queues, and health
npm run growth --history             # Inspect append-only audit trail and session history

# 5. Utilities
npm run growth --manual-comments     # Explicit manual clipboard + browser fallback
npm run growth --linkedin-auth       # Run official LinkedIn OAuth 2.0 flow
npm run growth --help                # View available commands and flags
```

### Global Options
- `--dry-run`: Preview without writing to the database or calling external APIs.
- `-resume`, `--resume`: Resume incomplete sessions or remaining pending queue items.
- `--limit <n>`: Limit rows displayed in `--history`.
- `--entity <type>`: Filter audit events by entity (`person`, `post`, `comment`, `session`).
- `--event <type>`: Filter audit events by event type (`published`, `approved`, etc.).

---

## Workflow Lifecycle

```
[ Discovery ]
npm run growth --people / --posts
       │
       ▼
[ Deterministic Quality Signals ]
Filters stale content, non-conversational posts, senior PMs, and recruiters.
Calculates transparent scores: ICP / Activity / Intent / Relevance / Freshness / Conversation.
       │
       ▼
[ AI Grounded Scoring & Generation ]
NVIDIA NIM (openai/gpt-oss-20b) scores candidates and generates authentic comments/DMs.
Never fabricates facts.
       │
       ▼
[ Persistent Storage in SQLite ]
Raw candidates, signals, versions, and draft reviews stored in data/database/growth.db.
       │
       ▼
[ Interactive Review ]
npm run growth --review-people   ──> Approved DMs copied to clipboard for manual sending
npm run growth --review-posts    ──> Approved comments marked status: 'approved'
       │
       ▼
[ Official LinkedIn Publishing ]
npm run growth --publish-comments
Loads ONLY comments with status 'approved'.
Attempts publication through official LinkedIn Comments API (HTTP 201).
On success: status = 'published', records comment URN and timestamp.
On failure: status = 'publish_failed', records sanitized error.
Never silently falls back to manual mode.
```

---

## Persistent Storage (`data/database/growth.db`)

All mutable state is durably stored in SQLite with WAL mode (`PRAGMA journal_mode = WAL;`) and strict transactions:

- **`people`**: Canonical profile URL, name, headline, discovery source, deterministic signals, `icp_score`, `activity_score`, `intent_score`, `overall_score`, `evidence_json`.
- **`posts`**: Canonical post URL, author, `relevance_score`, `activity_score`, `conversation_score`, `freshness_score`, `overall_score`, `evidence_json`.
- **`person_reviews`**: Versioned outreach messages, AI analysis, reviewer action, review timestamp.
- **`post_reviews`**: Versioned suggested comments, AI analysis, reviewer action.
- **`comments`**: Comment content, versioning, status (`draft`, `approved`, `published`, `publish_failed`, `manual_copied`, `skipped`), LinkedIn comment URN, publish attempt count, last error.
- **`sessions`**: CLI command, started at, completed at, configuration snapshot, status.
- **`events`**: Append-only audit log tracking every discovery, scoring, review, and publishing attempt.

### Data Integrity Rules
- Historical records are never destructively overwritten.
- Re-discovered profiles/posts update only `last_seen_at` and append an audit event.
- AI iterations create incremented version records (`version 1`, `version 2`, etc.).
- Publish attempts increment `publish_attempt_count` and record audit log entries.

---

## Deterministic Quality Signals

Before AI scoring, deterministic signal extractors evaluate candidates and posts:

### Post Signals
- **Freshness**: Detects timestamps and relative dates. Penalizes posts > 6 months old.
- **Conversation**: Detects questions, advice requests, and discussion prompts. Excludes commercial broadcast alerts.
- **Relevance**: Evaluates Prodily audience alignment (PM learning, interview prep, case studies, PRDs).
- **Author Activity**: Verified, inferred, or unknown activity evidence.
- **Duplicate Check**: Prevents commenting on duplicate or already-addressed posts.

### People Signals
- **Career Stage**: Student, career switcher, early-career PM, or excluded senior role.
- **Exclusion Filters**: Automatically filters out Directors, VPs, CPOs, and recruiters.
- **PM Intent**: Grounded evidence of aspiring PM intent (`verified`, `inferred`, `unknown`).
- **Activity Evidence**: Never fabricates active status; marks `unknown` if no timestamp is present in public search snippet.

---

## Comment Quality Standards

Generated comments strictly adhere to the following principles:
- Add genuine, specific value by answering questions or expanding on insights.
- Reference concepts from the actual post.
- Avoid generic praise ("Great post!", "Thanks for sharing!").
- Avoid promotional spam. Do NOT mention Prodily unless contextually natural.
- Never fabricate personal experience.
- Keep comments concise (2 to 4 sentences) and human-sounding.

---

## Setup & Configuration

### Prerequisites
- Node.js 18+ (tested on Node 22 and Node 24 with native SQLite)

```powershell
# Install dependencies
npm install

# Environment setup
Copy-Item .env.example .env
```

### Environment Variables (.env)

```env
# AI Provider
AI_PROVIDER=nvidia
NVIDIA_API_KEY=nvapi-...
NVIDIA_MODEL=openai/gpt-oss-20b
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1

# Discovery Provider
SEARCH_PROVIDER=firecrawl
FIRECRAWL_API_KEY=fc-...
FIRECRAWL_BASE_URL=https://api.firecrawl.dev

# LinkedIn OAuth 2.0 (for automated comment publishing)
LINKEDIN_CLIENT_ID=your-client-id
LINKEDIN_CLIENT_SECRET=your-client-secret
LINKEDIN_REDIRECT_URI=http://localhost:8899/oauth/linkedin/callback
```

---

## Running Tests

```powershell
# Type-check TypeScript
npm run typecheck

# Run full test suite (Node built-in test runner)
npm test
```