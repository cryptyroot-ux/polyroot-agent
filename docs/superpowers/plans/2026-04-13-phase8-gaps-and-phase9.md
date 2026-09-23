# Phase 8 Gaps & Phase 9 Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement remaining Phase 8 gaps (SHADOW/MICRO_LIVE integration tests, mode transition tests, metrics accumulation, observability hooks, continuous run) and robust Phase 9 Observability & Alerting wiring into the G4 pipeline.

**Architecture:** Add dedicated integration tests and observability wiring in `@polyroot/runtime` and `@polyroot/observability` to ensure full test coverage and enterprise-grade operational telemetry.

**Tech Stack:** TypeScript, Node.js test runner (`node:test`), Node.js assert.

## Global Constraints
- Zero test failures (`npm test`)
- Strict type-checking (`npm run build`)
- Zero lint errors (`npm run lint`)
- Traceability mapping (`npm run traceability`)

---

## Tasks

### Task 1: SHADOW Mode Integration Tests
**Files:**
- Create: `tests/pm/contracts/runtime-shadow.test.ts`

- [ ] **Step 1: Write the failing test for SHADOW mode execution**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Write implementation/test code to pass**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

### Task 2: MICRO_LIVE Mode Integration Tests
**Files:**
- Create: `tests/pm/contracts/runtime-micro-live.test.ts`

- [ ] **Step 1: Write the failing test for MICRO_LIVE mode cap enforcement & real wallet/venue**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Write test implementation**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

### Task 3: Mode Transitions & Metrics Accumulation Tests
**Files:**
- Create: `tests/pm/contracts/runtime-transitions-metrics.test.ts`

- [ ] **Step 1: Write the failing test for valid/invalid mode transitions and metrics accumulation**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement test coverage**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

### Task 4: Observability Hooks & Continuous Run Tests
**Files:**
- Create: `tests/pm/contracts/runtime-observability-loop.test.ts`

- [ ] **Step 1: Write the failing test for G4CoreObservability hooks and runContinuous**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement test coverage**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**
