# Critical Flows

> TokenCap Constitution Engine

## 🔴 CONST-FLOW-001 — CRITICAL

**Authentication Flow is repository-critical and must remain intact end-to-end.**

> **Why:** Every protected page and authenticated feature depends on this flow working correctly.

> **What breaks:** Users cannot log in. All authenticated features become unreachable. Sessions invalidated.

*Files:* `src/linkedin/auth.ts`
