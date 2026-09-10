# REQUIREMENT RECONCILIATION — 124 (Candidate) vs 96 (Final)

## 1. The 124/124 Claim — Origin and Validity

### Source of "124"
- **Document**: `docs/spec_pack/Polyroot_v1.1_Specification_Pack/Requirements_v1.1.csv` (and JSON equivalent)
- **Row count**: 124 rows (116 P0 + 8 P1)
- **All fields**: `implemented=False`, `acceptance_status=NOT_RUN`
- **Gate column**: NONE

### Traceability Script (`scripts/check-traceability.mjs`)
**What it actually checks**:
1. 124 PM-* requirements exist in JSON with valid IDs and priorities
2. 124 T-PM-* test scenarios exist with matching priorities
3. One-to-one mapping between requirement IDs and test IDs
4. Priority match between requirement and test scenario

**What it does NOT check**:
- Whether tests actually exist as executable functions
- Whether tests pass
- Whether requirements are implemented
- Whether evidence exists for acceptance
- Whether gate criteria are met

### The 124/124 Claim: **INVALID**
The claim "124/124 requirements PASSED" is **FALSE**. The traceability gate only validates structural JSON mapping, NOT implementation or test execution. All 124 requirements have `acceptance_status=NOT_RUN` and `implemented=False`.

## 2. Reconciliation Table: 124 Candidate vs 96 Final

| Candidate ID | Final PRD ID | Status | Disposition | Notes |
|--------------|--------------|--------|-------------|-------|
| PM-GOV-01..05 | PM-GOV-01..05 | RETAINED | Direct mapping | 5 GOV requirements in both |
| PM-DATA-01..06 | PM-DATA-01..06 | RETAINED | Direct mapping | 6 DATA requirements in both |
| PM-AI-01..06 | PM-AI-01..06 | RETAINED | Direct mapping | 6 AI requirements in both |
| PM-STR-01..04 | PM-STR-01..04 | RETAINED | Direct mapping | 4 STR requirements in both |
| PM-RISK-01..07 | PM-RISK-01..07 | RETAINED | Direct mapping | 7 RISK requirements in both |
| PM-EXE-01..08 | PM-EXE-01..08 | RETAINED | Direct mapping | 8 EXE requirements in both |
| PM-LED-01..05 | PM-LED-01..05 | RETAINED | Direct mapping | 5 LED requirements in both |
| PM-OPS-01..07 | (distributed) | SPLIT | Merged into GOV/EXE/OPS | 7 OPS candidate → PRD GOV/EXE |
| PM-VAL-01..05 | (distributed) | SPLIT | Merged into RISK/EXE | 5 VAL candidate → PRD RISK/EXE |
| PM-WALLET-01..10 | PM-WALLET-01..04 + PM-EXE-05..08 | MERGED | Consolidated | 10 Wallet → 4 Wallet + 4 EXE |
| PM-KONTRAK-01..06 | PM-EXE-01..06 | MERGED | Consolidated | 6 Kontrak → PRD EXE |
| PM-INTEL-01..10 | PM-AI-01..06 + PM-DATA-01..04 | MERGED/SPLIT | Reorganized | 10 Intel → AI + DATA |
| PM-GRAPH-01..06 | PM-DATA-05/06 | SPLIT | Merged into DATA | 6 Graph → DATA |
| PM-SIZING-01..05 | PM-STR-01..03 + PM-RISK-03 | MERGED | Consolidated | 5 Sizing → STR + RISK |
| PM-ECON-01..05 | PM-STR-03 + PM-RISK-04 | MERGED | Consolidated | 5 Econ → STR + RISK |
| PM-MODE-01..06 | PM-EXE-07/08 + PM-VENUE | MERGED | Consolidated | 6 Mode → EXE/VENUE |
| PM-SECURITY-01..09 | PM-SEC-01..04 + PM-RISK-05 | MERGED | Consolidated | 9 Security → SEC + RISK |
| PM-EXP-01..09 | PM-OPS-01..09 | MERGED | Consolidated | 9 ExPerimen → OPS |

**Total Final**: 96 (86 P0 + 10 P1)

**No requirement disappears without disposition** — all 124 candidate rows map to the 96 final via RETAINED, SPLIT, or MERGED.

## 3. The 124/124 Claim — Corrected

| Metric | Claimed | Actual | Evidence |
|--------|---------|--------|----------|
| Requirements (Final) | 124 | **96** | PRD/Blueprint |
| Requirements (Candidate) | 124 | 124 | CSV/JSON |
| Traceability (Structural) | 124/124 | 124/124 | JSON mapping only |
| Implemented | 124/124 | **0/96** | All `implemented=False` |
| Acceptance | 124/124 | **0/96** | All `NOT_RUN` |
| Tests Passing (Unit) | 164 | 164 | Internal unit tests |
| Requirements Mapped to Tests | 124 | **4** | Only 4 test functions reference PM- IDs |

**VERDICT**: The "124/124 PASSED" claim is **CATEGORICALLY FALSE**. It conflates structural JSON traceability with implementation/acceptance compliance.