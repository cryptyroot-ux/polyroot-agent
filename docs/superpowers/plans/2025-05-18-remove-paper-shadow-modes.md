# Remove PAPER and SHADOW Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all PAPER and SHADOW operation/execution modes from the codebase (`src/pm`), leaving only `MICRO_LIVE` and `LIVE` modes, and delete orphaned files like `paper-engine.ts`.

**Architecture:** Update schemas and type definitions in domain, runtime, control, strategy, risk, and venue to restrict modes to `MICRO_LIVE` | `LIVE`. Remove simulation branches in execution cores (e.g. `g4-core.ts`), and update CLI/main entry points.

**Tech Stack:** TypeScript, Node.js

## Global Constraints
- Only `MICRO_LIVE` and `LIVE` modes are permitted.
- Fail-closed invariant maintained across all gates.

---

### Task 1: Remove Paper Engine & Update Domain / Schemas
**Files:**
- Delete: `src/pm/runtime/src/paper-engine.ts`
- Modify: `src/pm/domain/src/index.ts`

- [ ] **Step 1: Delete paper-engine.ts**
- [ ] **Step 2: Update OperationModeSchema and ExecutionModeSchema in src/pm/domain/src/index.ts to only allow ["MICRO_LIVE", "LIVE"]**
- [ ] **Step 3: Commit**

### Task 2: Update Runtime, Control, Risk, Venue, and Strategy Modes
**Files:**
- Modify: `src/pm/runtime/src/g4-core.ts`, `src/pm/runtime/src/g4-loop.ts`, `src/pm/runtime/src/g4-pipeline.ts`, `src/pm/runtime/src/cli.ts`, `src/pm/runtime/src/main.ts`
- Modify: Risk, venue, strategy mode definitions/types

- [ ] **Step 1: Update G4Mode and related types to "MICRO_LIVE" | "LIVE"**
- [ ] **Step 2: Remove PAPER/SHADOW branching in execution logic (g4-core.ts)**
- [ ] **Step 3: Update CLI and main entry points to validate only MICRO_LIVE | LIVE**
- [ ] **Step 4: Commit**

### Task 3: Verification & Test Run
**Files:**
- Test / Build verification

- [ ] **Step 1: Run build / tests to ensure no type errors or broken references**
- [ ] **Step 2: Commit**
