# Telegram Onboarding & Extended Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Telegram onboarding wizard, interactive `/wallet` (view/create/import), and dynamic `/mode` switching.

**Architecture:** Extend `buildTelegramHandlers` and add conversational wizard state management in `telegram.ts` / `cli.ts`.

**Tech Stack:** TypeScript, Node.js, Telegram Bot API, PostgreSQL.

## Global Constraints
- Only approved operator IDs can execute commands.
- Secrets must never be logged or leaked in chat output.
- All configuration changes must persist to `~/.polyroot/.env`.

---

### Task 1: Telegram `/wallet` Command (View, Create, Import)

**Files:**
- Modify: `src/pm/runtime/src/cli.ts`
- Test: `src/pm/runtime/src/cli.test.ts` (or equivalent test runner)

**Interfaces:**
- Produces: `/wallet` handler supporting view, import, and create subcommands.

- [ ] **Step 1: Implement `/wallet` handler logic in `buildTelegramHandlers`**
- [ ] **Step 2: Test wallet command parsing and responses**
- [ ] **Step 3: Commit**

### Task 2: Telegram `/mode` Command (View & Switch)

**Files:**
- Modify: `src/pm/runtime/src/cli.ts`

**Interfaces:**
- Produces: `/mode` handler to query and switch runtime mode with safety checks.

- [ ] **Step 1: Implement `/mode` handler logic**
- [ ] **Step 2: Commit**

### Task 3: Telegram Onboarding Wizard (`/onboard`)

**Files:**
- Modify: `src/pm/runtime/src/cli.ts`, `src/pm/runtime/src/telegram.ts`

**Interfaces:**
- Produces: Stateful conversational wizard for full setup via Telegram chat.

- [ ] **Step 1: Implement wizard state handler and step prompts**
- [ ] **Step 2: Wire up completion and `.env` writing**
- [ ] **Step 3: Commit**
