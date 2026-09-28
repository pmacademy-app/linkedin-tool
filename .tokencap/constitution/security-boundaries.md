# Security Boundaries

> TokenCap Constitution Engine

## 🟠 CONST-SEC-001 — HIGH

**Security middleware (helmet, CORS, CSRF) must remain enabled.**

> **Why:** These middleware prevent common web security vulnerabilities (XSS, CSRF, clickjacking).

> **What breaks:** Applications become vulnerable to XSS, clickjacking, and CSRF attacks.

*Files:* `src/linkedin/auth.ts`

## 🟠 CONST-SEC-002 — HIGH

**Rate limiting must not be removed from public endpoints.**

> **Why:** Rate limiting prevents brute-force attacks and denial-of-service.

> **What breaks:** Brute-force login attacks. API abuse. Service degradation under load.

*Files:* `src/linkedin/comments.ts`

## 🔴 CONST-SEC-003 — CRITICAL

**Environment variable files (.env) must never be committed to version control.**

> **Why:** .env files contain secrets. Committing them exposes credentials to all repository users.

> **What breaks:** All secrets in .env become public. Immediate security incident.

*Files:* `.env`, `.env.example`
