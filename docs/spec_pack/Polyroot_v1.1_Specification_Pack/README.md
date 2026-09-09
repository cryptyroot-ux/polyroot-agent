# Polyroot v1.1 Specification Pack

Dokumen pendamping PRD dan Technical Blueprint v1.1, baseline riset 9 September 2026.

## Mulai dari sini

- `Audit_Correction_Matrix.csv`: 30 koreksi → requirement → acceptance ID → bagian desain.
- `Requirements_v1.1.csv` / `.json`: 124 requirements, 116 P0 dan 8 P1; 53 baseline IDs dipertahankan (43 retained, 10 revised) dan 71 baru.
- `Fork_Disposition_Matrix.csv` / `.json`: seluruh 827 blob commit upstream, hashes, target, rationale, coverage dan gates. CSV memiliki list/dict sebagai JSON dalam cell.
- `Subsystem_Coverage.csv`: agregasi seluruh subsystem, termasuk yang dihapus/quarantine.
- `Dependency_Disposition.csv`: 80 direct runtime + 9 dev dependencies; production closure belum disetujui.
- `SDK_Candidate_Matrix.csv`, `SDK_Candidate_Manifest.json`, `SDK_Contract_Tests.csv`: kandidat exact dan 32 tes kontrak NOT_RUN.
- `Fault_Matrix.csv`: 46 skenario gangguan, requirement dan invariant; semua NOT_RUN.
- `schemas/`: 18 draft JSON Schemas, bukan implementasi validator domain atau release-ready API.
- `Policy_Defaults.json`, `Open_Decisions.csv`, `Baseline_Traceability.csv`: policy kandidat, blocker dan preservation trace.
- `Research_Findings.md`, `Sources.json`, `Source_Snapshot_Manifest.json`: findings, bibliografi dan source hashes.
- `Validation_Report.json`: validasi artefak spesifikasi yang benar-benar dilakukan; tidak mengklaim tes bot sudah berjalan.
- `MANIFEST_SHA256.json`: integrity untuk file paket ini.

## Arti status

Semua 827 file byte-verified dan static-inventoried. Targeted semantic review ada pada 42 file. `evidence_locator` menunjukkan rentang/lokasi sumber, bukan janji setiap baris dalam rentang telah diaudit. `STATIC_INVENTORY` memerlukan review semantik sebelum code admission. `production_admitted=false` berlaku pada seluruh source kandidat sampai implementasi/gates selesai.

KEEP / KEEP+HARDEN / ADAPT bukan security certification. REWRITE adalah rencana mengganti boundary/semantics; bukan klaim semua helper lama buruk. REMOVE berarti tidak ada di production dependency graph. QUARANTINE dan RESEARCH-ONLY tidak dapat dimuat oleh executor/vault. Daftar yang lengkap tidak menyamarkan batas audit.

## Reproduksi dan atribusi

Source code upstream tidak dieksekusi atau dipasang. Retrieve commit `715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8` dari repository `alsk1992/CloddsBot`, cocokkan Git blob hash serta SHA256 dalam matrix. Perubahan nama menjadi Polyroot tidak menghapus MIT/copyright upstream. `LICENSE_CloddsBot.txt` disertakan untuk provenance source yang akan diadopsi.

File schema memakai URL `polyroot.invalid` sebagai identifier lokal. Rules lintas objek—probability normalization, balanced journal, graph proof, permit authentication, authority dan risk bounds—memerlukan validator domain terpisah. Jangan mengeksekusi order hanya karena JSON lolos schema.

## Konflik spesifikasi

PRD mengatur hasil produk; Blueprint mengatur kontrak dan invariant; paket ini adalah rincian normatif. Konflik harus ditutup dengan revisi versioned dan release ditahan. Candidate specification tidak sama dengan implementation freeze atau LIVE readiness.
