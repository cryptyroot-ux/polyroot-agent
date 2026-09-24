# PolyRoot Production Readiness & Public Release Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute all remaining critical readiness work: Public Documentation, Open Source Licensing & Legal, SemVer/Changelog Governance, CI/CD Pipeline Expansion, Monitoring/Observability hooks, Security hardening / Pen-test readiness, and Support/SLA setup.

**Architecture:** Systematic remediation across 7 distinct domains, ensuring all gates (`npm run ci`) pass and all components are robustly ready for production-grade public deployment.

**Tech Stack:** Node.js 24, TypeScript 5, PostgreSQL / Drizzle ORM, GitHub Actions, Docker, SBOM (SPDX), Gitleaks, Changesets.

## Global Constraints
- **Node version:** >= 24.0.0
- **Strict TypeScript:** `verbatimModuleSyntax: true`, `exactOptionalPropertyTypes: true`
- **Zero Regression:** `npm run ci` must pass with 0 errors/warnings on every commit.
- **Security First:** No private keys in AI core; financial blockades enforced until Autonomy Charter sign-off.

---

### Task 2: Open Source Licensing & Legal Compliance

**Files:**
- Create: `LICENSE`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `.github/CODEOWNERS`

**Interfaces:**
- Consumes: Upstream CloddsBot provenance license (`docs/spec_pack/Polyroot_v1.1_Specification_Pack/LICENSE_CloddsBot.txt`)
- Produces: Formal MIT License with upstream attribution, contribution guidelines, security reporting policy, and code ownership rules.

- [ ] **Step 1: Create LICENSE (MIT + Upstream CloddsBot Attribution)**
- [ ] **Step 2: Create CONTRIBUTING.md and SECURITY.md**
- [ ] **Step 3: Create .github/CODEOWNERS**
- [ ] **Step 4: Commit legal and policy files**

### Task 1: Public Documentation & Quickstart Refinement

**Files:**
- Create: `docs/PUBLIC_API.md`
- Modify: `README.md`
- Test: Manual validation of quickstart instructions

**Interfaces:**
- Consumes: Existing specification pack and implementation blueprints
- Produces: Comprehensive public documentation, API spec reference, and 5-minute quickstart guide

- [ ] **Step 1: Write public API and usage reference**
- [ ] **Step 2: Update main README.md with complete production status, environment variables, and troubleshooting**
- [ ] **Step 3: Run link / format check**
- [ ] **Step 4: Commit documentation update**

### Task 3: SemVer & Changelog Governance

**Files:**
- Create: `.changeset/config.json`
- Modify: `package.json`
- Test: Changeset validation

**Interfaces:**
- Consumes: `@changesets/cli` configuration
- Produces: Automated release notes and semantic version bumping pipeline

- [ ] **Step 1: Configure Changesets (`.changeset/config.json`)**
- [ ] **Step 2: Add initial changeset for v0.1.1 production readiness**
- [ ] **Step 3: Verify changelog generation command**
- [ ] **Step 4: Commit versioning files**

### Task 4: CI/CD Pipeline & Staging Infra Hardening

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `docker-compose.prod.yml`
- Test: Run full CI checks locally via `npm run ci`

**Interfaces:**
- Consumes: Existing CI workflow and Dockerfile
- Produces: Enhanced CI pipeline with vulnerability scanning, automated smoke tests, and production Docker compose setup

- [ ] **Step 1: Enhance CI workflow with strict verification gates**
- [ ] **Step 2: Create production docker-compose configuration (`docker-compose.prod.yml`)**
- [ ] **Step 3: Run local validation (`npm run ci`)**
- [ ] **Step 4: Commit CI/CD improvements**

### Task 5: Production Monitoring & Observability Setup

**Files:**
- Create: `src/pm/runtime/src/metrics-exporter.ts`
- Modify: `src/pm/runtime/src/g4-core.ts`
- Test: `tests/pm/contracts/runtime-observability-loop.test.ts`

**Interfaces:**
- Consumes: G4 observability hooks
- Produces: Prometheus-compatible metrics endpoint and health check probes

- [ ] **Step 1: Implement metrics exporter for Prometheus**
- [ ] **Step 2: Integrate health check endpoints in gateway**
- [ ] **Step 3: Run observability contract tests**
- [ ] **Step 4: Commit monitoring additions**

### Task 6: Security Hardening & Vulnerability Baseline

**Files:**
- Create: `.gitleaks_baseline.json`
- Modify: `.gitleaksignore`
- Test: Run Gitleaks check

**Interfaces:**
- Consumes: Gitleaks scanner
- Produces: Clean security scan baseline with zero unacknowledged secrets

- [ ] **Step 2: Run gitleaks scan and verify clean state**
- [ ] **Step 3: Commit security baseline config**

### Task 7: Support, SLA & Incident Response Plan

**Files:**
- Create: `SUPPORT.md`
- Create: `SECURITY_INCIDENT_RESPONSE.md`

**Interfaces:**
- Consumes: Issue template configurations
- Produces: Support policy, SLA commitments, and security incident response runbook

- [ ] **Step 1: Create SUPPORT.md and incident response runbook**
- [ ] **Step 2: Verify all deliverables and test suite status**
- [ ] **Step 3: Final commit and push to main**
