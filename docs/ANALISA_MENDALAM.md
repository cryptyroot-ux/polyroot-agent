# Analisa Mendalam — Polymarket AI Trader (PolyRoot)

> Status: **MODE PLAN / DISKUSI** — belum ada kode yang ditulis
> Dokumen sumber: PRD v1.0 + Blueprint v1.0 (9 September 2026)
> Basis: fork CloddsBot commit `715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8` (MIT)

---

## 1. INTISARI PRODUK

**PolyRoot** = bot pribadi yang:

- **Riset** pasar Polymarket dengan AI (berbasis bukti, probabilitas terstruktur)
- **Eksekusi** order secara otonom di dalam mandat pemilik
- Mulai dari **PAPER**, satu wallet, satu strategi (`evidence_directional_v1`)
- Ledger keuangan di **PostgreSQL**; AI hanya bisa _mengusulkan intent_, tidak bisa sign/submit

---

## 2. ARSITEKTUR (7 Komponen Utama)

| Komponen              | Fungsi                                                    | Otoritas                                    |
| --------------------- | --------------------------------------------------------- | ------------------------------------------- |
| **Control + Gateway** | Session pemilik → command, mandat, read model             | TIDAK pegang key trading                    |
| **Data Service**      | Metadata/book/evidence → MarketSnapshot, EvidenceItem     | Tulis ke research schema saja               |
| **Intelligence**      | Pertanyaan pasar + bukti → Forecast tervalidasi           | Tool jaringan read-only, tanpa shell/signer |
| **Strategy**          | Forecast + quote → TradeIntent atau NO_TRADE              | Tidak asumsikan sinyal = fill               |
| **Risk + Executor**   | Intent + mandat → reservation, signed order, venue events | **Financial writer tunggal**                |
| **Reconciler**        | Venue orders/trades/balance → discrepancy, readiness      | Berjalan walau AI berhenti                  |
| **Ledger + Outbox**   | Event append-only → projections, jobs, audit              | DB privat; role dipisah                     |

**Key insight**: Hanya **executor** yang berhubungan dengan kredensial trading. Kompromi prompt/gateway tidak bisa sign order.

---

## 3. STATISTIK REQUIREMENT

| Kategori                    | P0     | P1    | Total  |
| --------------------------- | ------ | ----- | ------ |
| GOV (Kendali produk)        | 5      | 0     | 5      |
| DATA (Identitas pasar)      | 6      | 0     | 6      |
| AI (Riset & probabilitas)   | 5      | 1     | 6      |
| STR (Strategi & seleksi)    | 3      | 1     | 4      |
| RISK (Modal & risiko)       | 4      | 0     | 4      |
| EXEC (Eksekusi)             | 8      | 0     | 8      |
| LED (Ledger & rekonsiliasi) | 6      | 0     | 6      |
| OPS (Keamanan & operasi)    | 8      | 0     | 8      |
| DASH (Dashboard)            | 3      | 1     | 4      |
| VAL (Verifikasi)            | 1      | 1     | 2      |
| **TOTAL**                   | **49** | **4** | **53** |

---

## 4. MODE OPERASI

| Mode         | I/O Finansial                          | Fungsi                                 |
| ------------ | -------------------------------------- | -------------------------------------- |
| **RESEARCH** | Tidak ada order                        | Kumpulkan bukti & forecast             |
| **PAPER**    | Simulasi eksekusi terpisah             | Uji biaya, sizing, perilaku gagal      |
| **SHADOW**   | Tidak kirim order, catat prospektif    | Ukur drift forecast & peluang tersedia |
| **LIVE**     | Order riil via executor + mandat aktif | Otonomi rutin, micro-LIVE              |

Instalasi baru **selalu PAPER**. Restart tidak menaikkan mode.

---

## 5. OBJECT KEUANGAN KUNCI

### 5.1 Expected Value (EV)

```
EV = q_net × E[payout per share] − cash_debit − allocated_costs
edge_per_net_share = EV / q_net
```

### 5.2 Risk Limits (Policy Default)

- Order: 0.5% dari cap
- Market: 2% dari cap
- Event (korelasi): 5% dari cap
- Portfolio: 10% dari cap
- Stop harian: 2%
- Drawdown: 5%
- Maks 10 order (termasuk unknown)
- Min edge: 0.03/share
- Slippage absolut: 0.01

### 5.3 Lifecycle State Machine

```
Intent: CREATED → VALIDATED → RESERVED → [REJECTED/EXPIRED]
Submit: SUBMITTING → ACKNOWLEDGED / SUBMISSION_UNKNOWN
Order:  LIVE / PARTIAL / MATCHED
Cancel: CANCEL_REQUESTED → CANCELED / CANCEL_UNKNOWN
Trade:  MATCHED → MINED/RETRYING → CONFIRMED/FAILED
Position: pending → settled → redeemable → redeemed
```

---

## 6. STRATEGI v1: `evidence_directional_v1`

**Universe**: pasar biner biasa dengan payout termodelkan, aturan jelas

**Pipeline**:

1. Discovery market → validasi rules & identitas
2. Book snapshot/stream → ambil bukti → deduplikasi
3. Forecast → quote → intent
4. Scan setiap **120 detik** (parameter usulan, bukan HFT)

**Evidence Gate**: minimal 2 sumber independen yang relevan (1 sumber resolusi primer otoritatif bisa jadi pengecualian)

**Reason Code NO_TRADE**:
`RULES_CHANGED`, `DATA_STALE`, `FEE_UNKNOWN`, `NO_EDGE`, `MIN_SIZE_EXCEEDS_CAP`, `BUDGET_EXHAUSTED`, `POLICY_EXPIRED`, `MODEL_UNCALIBRATED`, `ACCESS_BLOCKED`, `RECONCILIATION_REQUIRED`

---

## 7. CHECKLIST RISK ENGINE (6 Lapisan)

1. **Mode + Authority** — LIVE + mandat aktif + strategi/market eligible
2. **Data + Price** — rules_hash cocok, quote valid, fee known, clock sehat
3. **Economics + Sizing** — EV memenuhi buffer, all-in cost di bawah cap
4. **Portfolio + Loss** — posisi + open + reservation tanpa celah; loss latch lulus
5. **DB Transaction** — kunci baris, validasi ulang, tulis reservation atomik
6. **Pre-Submit** — Risk permit TTL 1s, intent TTL 30s, dicek ulang

---

## 8. KEAMANAN & BATASAN

### Actor/Capability Matrix

| Actor        | Bisa                                    | Tidak Bisa                                   |
| ------------ | --------------------------------------- | -------------------------------------------- |
| Pemilik      | Buat mandat, pause/cancel, ekspor audit | Ubah event historis, bypass validasi         |
| Gateway      | Tulis command inbox                     | Key trading, sign, tulis ledger              |
| LLM/Strategy | Baca evidence, propose forecast/intent  | Shell, secret, sign, withdraw, aktifkan LIVE |
| Executor     | Validasi, reserve, sign, submit, cancel | Transfer arbitrary, tool browsing            |

### Prompt Injection Defense

- Konten web = data, bukan instruksi
- Signer tidak punya browser/shell tool
- Secret canary diuji di prompt/log/export
- Validasi output & allowlist capability = kontrol utama

---

## 9. DEPLOYMENT & INFRA

| Komponen    | Spesifikasi                                          |
| ----------- | ---------------------------------------------------- |
| Target awal | 1 VPS Linux: 4 vCPU, 8 GiB RAM, 40 GiB SSD           |
| Runtime     | Node 24 LTS + PostgreSQL 17                          |
| Backup      | RPO 15 menit, RTO 60 menit, encrypted off-host       |
| TLS         | Gateway di balik TLS, DB/executor privat             |
| Image       | Immutable, SBOM, secret scan, schema migration check |

---

## 10. RENCANA PENELITIAN

### Gate Observasi Awal

- ≥30 hari + ≥100 event resolved independen
- Lower bound CI 95% net edge > 0 setelah biaya
- Tidak melakukan repeated peeking (stop pada hasil pertama yang menguntungkan)

### Metrik Forecast

- Brier score, log loss, calibration diagram, sharpness, abstention/coverage
- Benchmark = probabilitas pasar saat forecast dibuat

### Metrik Trading

- Net PnL, drawdown, turnover, fill/cancel ratio, capacity/depth
- Biaya LLM/infra, event count, concentration
- Sensitivity biaya/latensi

---

## 11. RISIKO & PERHATIAN

| Risiko                                       | Level  | Mitigasi                                            |
| -------------------------------------------- | ------ | --------------------------------------------------- |
| Upstream CloddsBot belum terbukti profitable | Tinggi | PAPER/SHADOW dulu, gate ketat sebelum LIVE          |
| AI hallucination → forecast salah            | Tinggi | Conservative probability, calibrator, evidence gate |
| Race condition order                         | Sedang | Dedupe key, fencing epoch, reservation atomik       |
| Prompt injection dari berita                 | Sedang | Content = data, signer terpisah, allowlist tool     |
| Fee/rule berubah mendadak                    | Sedang | rules_hash tracking, invalidasi forecast lama       |
| LLM cost overrun                             | Rendah | Budget token/biaya/durasi, abstain saat habis       |

---

## 12. REKOMENDASI IMPLEMENTASI (URUTAN)

1. **G0: Foundation** — fork CloddsBot, setup PostgreSQL, release manifest, schema migration
2. **G1: Data Layer** — market-data adapter, identitas kontrak, fee metadata, order book
3. **G1: Intelligence** — provider adapter, forecast schema, evidence pipeline
4. **G2: Risk + Executor** — risk engine 6-lapisan, signer terisolasi, order lifecycle
5. **G2: Ledger** — append-only event, posting, reconciliation
6. **G3: Strategy + PAPER** — evidence_directional_v1, paper engine, scoring
7. **G3: Dashboard** — overview, markets, orders, experiments, settings
8. **G4: SHADOW** — prospective decision recording, drift measurement
9. **G5: LIVE** — mandat, micro-LIVE gate, owner resume protocol
10. **Ops** — monitoring, backup, runbook, observability

---

_Dokumen ini adalah hasil studi dan diskusi. Belum ada implementasi kode._
