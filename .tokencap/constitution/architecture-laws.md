# Architecture Laws

> TokenCap Constitution Engine

## 🟠 CONST-ARCH-001 — HIGH

**Services cannot import UI components.**

> **Why:** Importing UI components into services couples server-side logic to browser rendering. This breaks SSR, testability, and separation of concerns.

> **What breaks:** Server-side services gain browser-only dependencies. Unit tests for services fail. SSR breaks.

## 🟠 CONST-ARCH-002 — HIGH

**Controllers cannot access the database directly.**

> **Why:** Direct DB access in controllers bypasses the service layer. This breaks the layered architecture and makes logic untestable.

> **What breaks:** Business logic leaks into controllers. Database coupling makes refactoring expensive.

## 🟠 CONST-ARCH-003 — HIGH

**Route handlers cannot access the database directly.**

> **Why:** Routes should delegate to services/controllers, not query the database themselves.

> **What breaks:** Business logic scattered across route files. Impossible to test in isolation.

## 🟠 CONST-ARCH-004 — HIGH

**UI components cannot import server-only modules.**

> **Why:** Server-only modules may contain secrets or Node.js-only APIs that crash in the browser.

> **What breaks:** Build errors in browser environments. Potential secret exposure.

## 🟠 CONST-ARCH-005 — HIGH

**High-impact clusters (Other, Database, Config) must not gain new circular dependencies.**

> **Why:** High-impact clusters already coordinate many modules. Adding circular imports makes builds fragile.

> **What breaks:** Module resolution fails. Build tools (webpack, esbuild) may hang or produce incorrect output.
