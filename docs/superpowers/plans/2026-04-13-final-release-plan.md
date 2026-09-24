# PolyRoot Final Public Release Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve license attribution and lint warnings, run full CI validation, merge Dependabot PRs, and publish the official public release of PolyRoot Agent v0.1.1.

**Architecture:** Systematic final polish and branch cleanup to meet all open-source release criteria and zero-regression standards.

**Tech Stack:** Node.js 24, TypeScript, Changesets, GitHub Actions, Docker.

## Global Constraints
- **Node version:** >= 24.0.0
- **Strict TypeScript:** `verbatimModuleSyntax: true`, `exactOptionalPropertyTypes: true`
- **Zero Regression:** `npm run ci` must pass with 0 errors/warnings on every commit.
- **Security First:** No private keys in AI core; strict scan baselines.

---

### Task 1: Fix LICENSE Upstream CloddsBot Attribution

**Files:**
- Modify: `LICENSE`

**Interfaces:**
- Consumes: Upstream CloddsBot provenance notice (`docs/spec_pack/Polyroot_v1.1_Specification_Pack/LICENSE_CloddsBot.txt`)
- Produces: Formal MIT License with explicit upstream CloddsBot and alsk1992 attribution.

- [ ] **Step 1: Read upstream license notice**
  Read `docs/spec_pack/Polyroot_v1.1_Specification_Pack/LICENSE_CloddsBot.txt` to verify copyright years and details.
- [ ] **Step 2: Update `LICENSE`**
  Modify `LICENSE` to include the proper attribution header followed by the standard MIT terms.
- [ ] **Step 3: Commit license update**
  ```bash
  git add LICENSE
  git commit -m "docs: add upstream CloddsBot attribution to LICENSE"
  ```

### Task 2: Eliminate TypeScript Lint Warnings

**Files:**
- Modify: Multiple source files across packages experiencing `@typescript-eslint/no-explicit-any` or related warnings.

**Interfaces:**
- Consumes: ESLint configuration
- Produces: Zero lint warnings when running `npm run lint`.

- [ ] **Step 1: Run linter and inspect output**
  ```bash
  npm run lint
  ```
- [ ] **Step 2: Fix lint warnings package by package**
  Replace explicit `any` types with unknown/type guards, remove unused variables, and fix any remaining style issues.
- [ ] **Step 3: Verify zero warnings**
  Run `npm run lint` and verify 0 errors and 0 warnings.
- [ ] **Step 4: Commit lint fixes**
  ```bash
  git add .
  git commit -m "style: resolve all TypeScript lint warnings for zero regression"
  ```

### Task 3: Track Untracked Metrics Exporter & Run Final CI Check

**Files:**
- Modify: `git status` check / stage `src/pm/runtime/src/metrics-exporter.ts` if needed.
- Test: `npm run ci`

**Interfaces:**
- Consumes: Full monorepo codebase
- Produces: Pristine working tree and green CI run.

- [ ] **Step 1: Stage untracked observability file**
  ```bash
  git add src/pm/runtime/src/metrics-exporter.ts
  ```
- [ ] **Step 2: Run full verification suite**
  ```bash
  npm run ci
  ```
  Expected: Exit code 0, 560+ tests passing, 0 errors/warnings.
- [ ] **Step 3: Commit final polish**
  ```bash
  git commit -m "chore: track metrics exporter and verify clean CI"
  ```

### Task 4: Push Branch and Prepare Release PR

**Files:**
- Remote: `origin/release/production-readiness`

**Interfaces:**
- Consumes: Verified local branch
- Produces: Remote branch pushed and ready for PR to `main`.

- [ ] **Step 1: Push branch**
  ```bash
  git push origin release/production-readiness
  ```
- [ ] **Step 2: Open Pull Request to main**
  Use `gh pr create` to create the pull request targeting `main`.
