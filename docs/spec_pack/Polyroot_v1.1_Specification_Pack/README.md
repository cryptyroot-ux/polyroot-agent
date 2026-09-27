# Polyroot v1.1 Specification Pack

Companion document to PRD and Technical Blueprint v1.1, research baseline 9 September 2026.

## Start here

- `Audit_Correction_Matrix.csv`: 30 corrections → requirement → acceptance ID → design section.
- `Requirements_v1.1.csv` / `.json`: 124 requirements, 116 P0 and 8 P1; 53 baseline IDs preserved (43 retained, 10 revised) and 71 new.
- `Fork_Disposition_Matrix.csv` / `.json`: all 827 upstream blobs, hashes, targets, rationale, coverage and gates. CSV holds lists/dicts as JSON-in-cell.
- `Subsystem_Coverage.csv`: whole-subsystem aggregation, including removed/quarantined.
- `Dependency_Disposition.csv`: 80 direct runtime + 9 dev dependencies; production closure not yet approved.
- `SDK_Candidate_Matrix.csv`, `SDK_Candidate_Manifest.json`, `SDK_Contract_Tests.csv`: exact candidates and 32 NOT_RUN contract tests.
- `Fault_Matrix.csv`: 46 failure scenarios, requirements and invariants; all NOT_RUN.
- `schemas/`: 18 draft JSON Schemas, not domain-validator implementations or release-ready APIs.
- `Policy_Defaults.json`, `Open_Decisions.csv`, `Baseline_Traceability.csv`: candidate policies, blockers and preservation trace.
- `Research_Findings.md`, `Sources.json`, `Source_Snapshot_Manifest.json`: findings, bibliography and source hashes.
- `Validation_Report.json`: specification-artifact validation actually performed; does not claim bot tests have run.
- `MANIFEST_SHA256.json`: integrity for this package.

## Status meanings

All 827 files byte-verified and statically inventoried. Targeted semantic review covers 42 files. `evidence_locator` points at source ranges/locations, not a promise that every line in range was audited. `STATIC_INVENTORY` requires semantic review before code admission. `production_admitted=false` applies to all candidate sources until implementation/gates complete.

KEEP / KEEP+HARDEN / ADAPT are not security certification. REWRITE is a plan to replace boundaries/semantics; not a claim that all old helpers are bad. REMOVE means absent from the production dependency graph. QUARANTINE and RESEARCH-ONLY cannot be loaded by the executor/vault. A complete list does not hide audit limits.

## Reproduction and attribution

Upstream source is neither executed nor installed. Retrieve commit `715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8` from repository `alsk1992/CloddsBot`, match Git blob hashes and the SHA256 in the matrix. Renaming to Polyroot does not remove MIT/copyright upstream. `LICENSE_CloddsBot.txt` is included for adoptable-source provenance.

Schema files use the `polyroot.invalid` URL as a local identifier. Cross-object rules — probability normalization, balanced journal, graph proof, permit authentication, authority and risk bounds — need separate domain validators. Do not execute orders just because JSON passes schema.

## Specification conflicts

The PRD governs product outcomes; the Blueprint governs contracts and invariants; this package is normative detail. Conflicts must be closed with versioned revisions and releases held. Candidate specification is not implementation freeze or LIVE readiness.
