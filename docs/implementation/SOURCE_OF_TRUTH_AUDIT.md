# SOURCE OF TRUTH AUDIT — PolyRoot v1.1

## 1. Document Inventory

| Filename | Path | SHA256 | Version | Status | Requirement Count | Gate Model | Candidate/Final | Authoritative | Reason |
|----------|------|--------|---------|--------|-------------------|------------|-----------------|---------------|--------|
| PolyRoot_PRD_v1.1.docx | /root/projects/Polyroot/PolyRoot_PRD_v1.1.docx | (binary) | v1.1 | Correction & Completion Release • 9 Sep 2026 | **96** (86 P0 + 10 P1) | G0–G7 | **FINAL** | **YES** | Explicitly states "96 traceable requirements: 86 P0 and 10 P1". Defines gates G0–G7. Same ID/priority/gate mapping as Blueprint. |
| PolyRoot_Technical_Blueprint_v1.1.docx | /root/projects/Polyroot/PolyRoot_Technical_Blueprint_v1.1.docx | (binary) | v1.1 | Correction & Completion Release • 9 Sep 2026 | 96 (same IDs) | G0–G7 | **FINAL** | **YES** | Same 96 IDs, priorities, owners/gates, primary test IDs as PRD. B16 traceability section. |
| Requirements_v1.1.csv | docs/spec_pack/Polyroot_v1.1_Specification_Pack/Requirements_v1.1.csv | (text) | v1.1 | Working/Spec Pack | **124** (116 P0 + 8 P1) | None defined | CANDIDATE/Working | NO | Contains 124 rows (116 P0 + 8 P1). Different count from PRD. All `implemented=False`, `acceptance_status=NOT_RUN`. No gate column. |
| Requirements_v1.1.json | docs/spec_pack/Polyroot_v1.1_Specification_Pack/Requirements_v1.1.json | (text) | v1.1 | Working/Spec Pack | 124 | None defined | CANDIDATE/Working | NO | Same 124 rows as CSV. All `implemented=False`, `acceptance_status=NOT_RUN`. Has `test_id` field for traceability script. |

## 2. Conflict Resolution

**Conflict**: PRD/Blueprint define **96 requirements** (86 P0 + 10 P1). The spec pack CSV/JSON contains **124 requirements** (116 P0 + 8 P1) with different grouping and no gate mapping.

**Resolution**: The PRD and Blueprint are the **authoritative final specification**. They:
- Explicitly state "96 traceable requirements: 86 P0 and 10 P1"
- Define the release gate model G0–G7
- State "PRD and Blueprint use the same 96 IDs, priorities, owners/gates and primary test IDs"
- Are the released v1.1 documents dated 9 September 2026

The 124-row CSV/JSON is a **working/spec pack artifact** with expanded granularity (different grouping: "Wallet dan kredensial", "Kontrak Polymarket", etc.) and NO gate mapping. It is NOT the authoritative final specification.

## 3. Authoritative Declaration

**AUTHORITATIVE_PRD** = `/root/projects/Polyroot/PolyRoot_PRD_v1.1.docx`

**AUTHORITATIVE_BLUEPRINT** = `/root/projects/Polyroot/PolyRoot_Technical_Blueprint_v1.1.docx`

**FINAL REQUIREMENT COUNT** = **96** (86 P0 + 10 P1)

**GATE MODEL** = G0, G1, G2, G3, G4, G5 (Prospective SHADOW), G6 (micro-LIVE), G7 (autonomous-LIVE 24/7)

The 124-row CSV/JSON is a **candidate/working artifact** and must NOT be used as the compliance baseline.