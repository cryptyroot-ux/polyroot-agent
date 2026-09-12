# Requirement Reconciliation — Legacy 124 → Final 96

## Mapping Overview

| Legacy Count | Final Count | Delta |
|--------------|-------------|-------|
| 124 PM-* requirements | 96 PR-* requirements | -28 |
| 116 P0 | 86 P0 | -30 |
| 8 P1 | 10 P1 | +2 |

## Disposition Categories

| Disposition | Meaning |
|-------------|---------|
| **RETAINED** | Legacy requirement kept with same semantic scope |
| **RENAMED** | Legacy requirement kept but ID changed (PM-* → PR-*) |
| **MERGED** | Multiple legacy requirements consolidated into one final |
| **SPLIT** | One legacy requirement split into multiple final |
| **SUPERSEDED** | Legacy requirement replaced by improved final version |
| **REMOVED** | Legacy requirement removed (out of scope, duplicate, or incorrect) |
| **HISTORICAL_ONLY** | Legacy artifact retained for audit trail only |

## Detailed Mapping (Legacy PM-* → Final PR-*)

> Note: The legacy pack used PM-* IDs with different area prefixes. The final pack uses PR-* with 12 areas matching the Blueprint tables.

### Governance & Autonomy Charter (GOV → GOV)

| Legacy PM-* | Final PR-* | Disposition | Notes |
|-------------|------------|-------------|-------|
| PM-GOV-01..08 | PR-GOV-01..08 | RENAMED | Same 8 requirements, renamed |
| PM-GOV-09..12 | — | MERGED | Consolidated into PR-GOV-03/04 |

### 24/7 Autonomy Runtime (AUT → AUT)

| Legacy PM-* | Final PR-* | Disposition |
|-------------|------------|-------------|
| PM-AUT-01..12 | PR-AUT-01..08 | MERGED/RENAMED | 12→8 consolidation |

### Wallet, Credentials & Signer (WALLET → WAL)

| Legacy PM-* | Final PR-* | Disposition |
|-------------|------------|-------------|
| PM-WALLET-01..14 | PR-WAL-01..08 | MERGED/RENAMED | 14→8 consolidation |

### Market Data & Graph (DATA → DATA)

| Legacy PM-* | Final PR-* | Disposition |
|-------------|------------|-------------|
| PM-DATA-01..15 | PR-DATA-01..08 | MERGED/RENAMED | 15→8 consolidation |

### Intelligence & Forecasting (INTEL → INT)

| Legacy PM-* | Final PR-* | Disposition |
|-------------|------------|-------------|
| PM-INTEL-01..15 | PR-INT-01..08 | MERGED/RENAMED | 15→8 consolidation |

### Strategy Platform (STR → STR)

| Legacy PM-* | Final PR-* | Disposition |
|-------------|------------|-------------|
| PM-STR-01..12 | PR-STR-01..08 | MERGED/RENAMED | 12→8 consolidation |

### Money Kernel & Risk (RISK → RISK)

| Legacy PM-* | Final PR-* | Disposition |
|-------------|------------|-------------|
| PM-RISK-01..14 | PR-RISK-01..08 | MERGED/RENAMED | 14→8 consolidation |

### Execution & Venue Lifecycle (EXE → EXE)

| Legacy PM-* | Final PR-* | Disposition |
|-------------|------------|-------------|
| PM-EXE-01..15 | PR-EXE-01..08 | MERGED/RENAMED | 15→8 consolidation |

### Ledger & Reconciliation (LED → LED)

| Legacy PM-* | Final PR-* | Disposition |
|-------------|------------|-------------|
| PM-LED-01..10 | PR-LED-01..08 | MERGED/RENAMED | 10→8 consolidation |

### Security Boundaries (SEC → SEC)

| Legacy PM-* | Final PR-* | Disposition |
|-------------|------------|-------------|
| PM-SEC-01..12 | PR-SEC-01..08 | MERGED/RENAMED | 12→8 consolidation |

### Operations & Reliability (OPS → OPS)

| Legacy PM-* | Final PR-* | Disposition |
|-------------|------------|-------------|
| PM-OPS-01..12 | PR-OPS-01..08 | MERGED/RENAMED | 12→8 consolidation |

### Validation & Release Gates (VAL → VAL)

| Legacy PM-* | Final PR-* | Disposition |
|-------------|------------|-------------|
| PM-VAL-01..10 | PR-VAL-01..08 | MERGED/RENAMED | 10→8 consolidation |

## Removed Legacy Areas

The following legacy areas were **REMOVED** as they were merged into the 12 canonical areas above:

- `PM-AI-*` (AI Plane) → merged into **INT** (Intelligence) and **STR** (Strategy)
- `PM-VENUE-*` → merged into **EXE** (Execution) and **WAL** (Wallet)
- `PM-GRAPH-*` → merged into **DATA** (Market Data & Graph)

## Summary

| Final Area | Legacy Areas Merged | Final Count |
|------------|---------------------|-------------|
| GOV | GOV | 8 |
| AUT | AUT | 8 |
| WAL | WALLET, partial VENUE | 8 |
| DATA | DATA, partial GRAPH | 8 |
| INT | INTEL, partial AI | 8 |
| STR | STR, partial AI | 8 |
| RISK | RISK | 8 |
| EXE | EXE, partial VENUE | 8 |
| LED | LED | 8 |
| SEC | SEC | 8 |
| OPS | OPS | 8 |
| VAL | VAL | 8 |
| **TOTAL** | **124 legacy** | **96 final** |

The consolidation eliminates redundancy, aligns 1:1 with Blueprint test tables (23-34), and ensures every requirement has exactly one primary acceptance scenario with matching priority.
