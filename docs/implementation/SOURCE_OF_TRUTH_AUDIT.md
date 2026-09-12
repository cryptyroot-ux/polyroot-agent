# Source of Truth Audit — PolyRoot v1.1

## Authoritative Specification Documents

| Document | Role | SHA-256 |
|----------|------|---------|
| `PolyRoot_PRD_v1.1.docx` | Product Requirements Document (PRD) — Correction & Completion Release, 9 Sep 2026 | `a40ce3ab6579ec16d4f7e13775ab9b4b31a17ecc0cb184b9de9f278c221fbe8a` |
| `PolyRoot_Technical_Blueprint_v1.1.docx` | Technical Blueprint — Correction & Completion Release, 9 Sep 2026 | `f939d605dbdeb08306db24995db0f22c769a922dcb054752e7f3dd0195e42c72` |

## Final Requirements Baseline

| Metric | Value |
|--------|-------|
| **Total Requirements** | **96** |
| **P0 (Must Pass)** | **86** |
| **P1 (Should Pass)** | **10** |
| **Primary Acceptance Scenarios** | **96 (one-to-one T-PR-* mapping)** |
| **Gate Taxonomy** | G0–G7 (see GATE_STATUS.md) |

### Requirement Distribution by Area

| Area | Count | P0 | P1 | Gate Range |
|------|-------|-----|-----|------------|
| GOV (Governance & Autonomy Charter) | 8 | 7 | 1 | G0–G7 |
| AUT (24/7 Autonomy Runtime) | 8 | 7 | 1 | G1–G7 |
| WAL (Wallet, Credentials & Signer) | 8 | 7 | 1 | G0–G7 |
| DATA (Market Data & Graph) | 8 | 7 | 1 | G1–G7 |
| INT (Intelligence & Forecasting) | 8 | 7 | 1 | G1–G7 |
| STR (Strategy Platform) | 8 | 7 | 1 | G2–G7 |
| RISK (Money Kernel & Risk) | 8 | 8 | 0 | G1–G7 |
| EXE (Execution & Venue Lifecycle) | 8 | 8 | 0 | G0–G7 |
| LED (Ledger & Reconciliation) | 8 | 7 | 1 | G1–G7 |
| SEC (Security Boundaries) | 8 | 7 | 1 | G0–G7 |
| OPS (Operations & Reliability) | 8 | 7 | 1 | G2–G7 |
| VAL (Validation & Release Gates) | 8 | 7 | 1 | G0–G7 |
| **TOTAL** | **96** | **86** | **10** | |

## Machine-Readable Catalog

**Authoritative catalog:** `docs/implementation/FINAL_96_REQUIREMENTS.json`

Each entry contains:
- `id`: PR-* requirement identifier
- `priority`: P0 or P1
- `test_id`: Corresponding T-PR-* primary acceptance scenario
- `gate`: Gate range where requirement must pass
- `title`: Human-readable description

## Legacy Specification Pack (Historical / Compatibility Only)

| Artifact | Location | Status |
|----------|----------|--------|
| Legacy 124 PM-* requirements | `docs/spec_pack/Polyroot_v1.1_Specification_Pack/Requirements_v1.1.json` | **LEGACY_NON_AUTHORITATIVE** |
| Legacy 124 T-PM-* scenarios | Same file | **LEGACY_NON_AUTHORITATIVE** |
| Legacy traceability script | `scripts/check-traceability.mjs` | **TO BE REPLACED** |

### Legacy vs Final Comparison

| Metric | Legacy (v1.0 pack) | Final (v1.1) |
|--------|-------------------|--------------|
| Total requirements | 124 | **96** |
| P0 count | 116 | **86** |
| P1 count | 8 | **10** |
| Requirement IDs | PM-* | **PR-*** |
| Test IDs | T-PM-* | **T-PR-*** |
| Gate taxonomy | G0=Foundation, G1=PAPER, G2=Risk, G3=Execution, G4=Intelligence | **G0=Research&SourceFreeze, G1=Domain&Contract, G2=Fault&MoneySafety, G3=Security&Recovery, G4=PAPER, G5=ProspectiveSHADOW, G6=MicroLIVE, G7=AutonomousLIVE24/7** |

## Disposition of Legacy Artifacts

| Legacy Artifact | Disposition |
|-----------------|-------------|
| `Requirements_v1.1.json` (124) | **HISTORICAL_ONLY** — retained for audit trail, NOT release source of truth |
| `scripts/check-traceability.mjs` | **SUPERSEDED** — replaced by final 96 traceability script |
| `GATE_STATUS.md` (old taxonomy) | **SUPERSEDED** — updated to final G0–G7 taxonomy |
| `README.md` claims of "124/124" | **CORRECTED** — updated to "96/96" |

## Precedence Order (Enforced)

1. **FINAL PRD v1.1** — `PolyRoot_PRD_v1.1.docx`
2. **FINAL Technical Blueprint v1.1** — `PolyRoot_Technical_Blueprint_v1.1.docx`
3. **FINAL 96-requirement machine-readable catalog** — `docs/implementation/FINAL_96_REQUIREMENTS.json`
4. **Ratified ADRs compatible with final documents** — `docs/implementation/` ADR files
5. **Current verified official Polymarket contracts/docs** — pinned SDK, CLOB V2 spec
6. **Implementation** — source code in `src/pm/`
7. **README/comments/old reports** — secondary, must match evidence
8. **Legacy 124 pack** — `docs/spec_pack/...` — **HISTORICAL ONLY**

## Traceability Gate Requirement

The executable traceability gate (`npm run traceability`) MUST validate against the **FINAL 96** baseline, not the legacy 124.

Pass criteria:
- All 96 PR-* requirements present with correct priority
- All 96 T-PR-* scenarios present with matching priority
- One-to-one mapping (no orphans, no duplicates)
- Exit code 0 on success, 1 on failure with diff report
