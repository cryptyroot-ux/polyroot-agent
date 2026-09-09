# ANALISA MENDALAM V2: POLYROOT v1.1 CROSS-REFERENCE
# ════════════════════════════════════════════════════════
# Basis: 9 September 2026
# Sumber: PRD v1.1 + Blueprint v1.1 + Spec Pack artefak
#         CloddsBot commit 715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8
#         Polymarket docs (live, 12+ halaman diekstrak)
#         3 kandidat SDK (SHA512 terverifikasi)
# ════════════════════════════════════════════════════════

## STATUS VERIFIKASI PER TEMUAN

### 1. POLY_1271 — Deposit Wallet Signing
**Klaim v1.1:** CloddsBot menolak POLY_1271; Polyroot harus implement full deposit-wallet path.
**Bukti source:** CONFIRMED. Line 604-609 `polymarket-order-signer.ts`:
  ```
  if (signatureType === SignatureType.POLY_1271) {
    throw new Error('POLY_1271 (smart-contract wallet) signing is not implemented...');
  }
  ```
**Bukti Polymarket docs:** Deposit Wallet (type 3) adalah default untuk semua wallet baru sejak 4 Mei 2026.
**Verdict:** ✅ KLAIM VALID. Ini P0 blocker nyata. Fresh user tidak bisa trading tanpa ini.

---

### 2. V2 Order Struct — Contract Address & Domain
**Klaim v1.1:** CloddsBot sudah punya V2 signing, tapi perlu verifikasi.
**Bukti source:** CONFIRMED. CloddsBot punya:
  - V2 contract addresses: `0xE111180000d2663C0091e4f400237545B87B996B` (CTF V2)
  - V2 EIP-712 domain: `{name: "Polymarket CTF Exchange", version: "2", chainId: 137}`
  - V2 type string: `Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)`
  - V2 removes: taker, expiration(struct), nonce, feeRateBps
  - V2 adds: timestamp, metadata, builder
**Bukti Polymarket docs:** Matches. V2 production sejak 28 April 2026.
**Verdict:** ✅ KLAIM VALID. V2 signing sudah ada di CloddsBot. Yang missing hanya POLY_1271 wrapper.

---

### 3. SDK Candidate Matrix
**Klaim v1.1:** 3 kandidat diverifikasi SHA512: @polymarket/client 0.9.0, clob-client-v2 1.1.0, builder-relayer-client 0.0.10.
**Bukti spec pack:** SDK_Candidate_Matrix.csv menunjukkan ketiga kandidat dengan SHA512 hash.
**Bukti live docs:** Polymarket mengarahkan migrasi ke unified @polymarket/client.
**Status implementasi:** NOT_RUN — belum ada acceptance test.
**Verdict:** ✅ KLAIM VALID (riset). ⚠️ IMPLEMENTASI BELUM ADA. Ini benar — spec pack jujur menyatakan NOT_RUN.

---

### 4. maxSpend Ambiguity
**Klaim v1.1:** maxSpend changelog = "estimated spending", tapi order prose = "cap". Tidak boleh jadi hard cap.
**Bukti source:** maxSpend TIDAK DITEMUKAN di CloddsBot source. Ini field Polymarket API, bukan CloddsBot.
**Bukti PRD v1.1:** "path LIVE harus menunjukkan batas debit yang dapat ditegakkan"
**Verdict:** ✅ KLAIM VALID. Polymarket API ambiguity yang harus ditangani. CloddsBot tidak memakai maxSpend — ini masalah baru yang harus dipecahkan.

---

### 5. Dependency Amputation — 245 REMOVE
**Klaim v1.1:** 89 packages, 245 files REMOVE, hanya 13 packages production-admitted.
**Bukti source:** Dependency_Disposition.csv mencatat:
  - REMOVE: Solana, DeFi (Orca, Raydium, Meteora, Jupiter, Kamino, Drift), messaging (Discord, Slack, WhatsApp), exchanges (Binance, Bybit, Hyperliquid), Polkadot, Wormhole, PumpFun, PredictFun
  - KEEP+HARDEN: pino (structured logging)
  - ADAPT: ws, zod, @anthropic-ai/sdk, TypeScript
  - RESEARCH-ONLY: dotenv, tsx, pino-pretty
**Verdict:** ✅ KLAIM VALID. Amputation masif ini justified — CloddsBot multi-chain/multi-exchange, Polyroot hanya Polymarket.

---

### 6. Risk Engine — Selective Reuse
**Klaim v1.1:** CloddsBot punya SafetyManager + risk engine, tapi perlu hardening.
**Bukti source:** CONFIRMED. `src/risk/engine.ts` punya 10-layer checks:
  1. Kill switch (safety.ts)
  2. Circuit breaker (8 trip reasons, cooldown, auto-reset)
  3. Max order size
  4. Exposure limits
  5. Daily loss limit
  6. Max drawdown
  7. Concentration limit
  8. VaR limit (parametric + historical)
  9. Volatility regime (LOW/NORMAL/HIGH/EXTREME)
  10. Kelly sizing
**Masalah yang ditemukan v1.1:**
  - initialBankroll masih bernilai contoh (hardcoded)
  - Copy success = filled (tidak accounted unfilled)
  - Cancel error menghapus local ID meski cancel gagal
**Verdict:** ✅ KLAIM VALID. Risk engine kuat tapi ada bug lifecycle yang harus di-REWRITE.

---

### 7. Circuit Breaker — Venue-Specific
**Klaim v1.1:** CloddsBot circuit breaker Polymarket-agnostic; perlu venue mode state machine.
**Bukti source:** CONFIRMED. Circuit breaker punya 8 trip reasons:
  - max_loss, max_loss_pct, consecutive_losses, high_error_rate
  - max_position, max_daily_trades, manual, system_error
  - Tidak ada: POST_ONLY mode, CANCEL_ONLY mode, 425 handling, venue downtime
**Verdict:** ✅ KLAIM VALID. Venue mode (NORMAL/POST_ONLY/CANCEL_ONLY/READ_ONLY/UNAVAILABLE) belum ada.

---

### 8. Fee Handling V1 vs V2
**Klaim v1.1:** V2 menghilangkan feeRateBps dari order struct; fee handling berubah.
**Bukti source:** CONFIRMED.
  - V1 struct: punya `feeRateBps` field (line 94)
  - V2 struct: TIDAK punya `feeRateBps` — replaced by timestamp/metadata/builder
  - CloddsBot masih punya `feeRateBps` di V1 signing
  - V2 signing: `feeRateBps` tidak ada di `PostOrderBodyV2`
  - Smart router mencatat: "Polymarket: 0 fees on most markets; 15-min crypto markets have dynamic fees"
**Verdict:** ✅ KLAIM VALID. Fee semantics berubah signifikan dari V1 ke V2.

---

### 9. Maker Rebate / Incentive Attribution
**Klaim v1.1:** Maker rebate, liquidity reward, dan taker incentive terpisah; tidak boleh dicampur.
**Bukti source:** CloddsBot punya:
  - `src/trading/logger.ts`: feePaid, rebateEarned (positive), isMaker
  - `src/skills/bundled/execution/SKILL.md`: "-0.5% maker rebate" (klaim lama)
  - Smart router: "0 fees on most markets" vs "up to ~315bps at 50/50 odds"
**Bukti v1.1:** "receipt/profile asset identity, no symbol guessing"
**Verdict:** ✅ KLAIM VALID. Fee/rebate attribution belum terstruktur dengan benar.

---

### 10. Strategy Ecosystem Expansion
**Klaim v1.1:** 8 keluarga strategi (vs 1 di v1.0).
**Bukti source:** CloddsBot punya:
  - `src/solana/swarm-strategies.ts`: 50+ StrategyType (solana-specific)
  - `src/skills/bundled/trading-futures/SKILL.md`: RSIStrategy
  - `src/trading/futures/index.ts`: StrategyEngine
  - Tidak ada Polymarket prediction-market strategy framework
**Verdict:** ✅ KLAIM VALID. CloddsBot strategies = multi-chain DeFi/futures. Polymarket prediction strategies = REWRITE baru.

---

### 11. Market Graph & Correlation
**Klaim v1.1:** MarketRelation, RelationProof, GraphSnapshot, conservative risk grouping.
**Bukti source:** CloddsBot punya:
  - `src/market-link-service/`: persistence, canonical links, market relations
  - Tapi: regex-based correlation, combinatorial assumptions tanpa proof
**Bukti v1.1:** Versioned relation proof, verified exhaustive/exclusive, MarketRelation object dengan provenance.
**Verdict:** ✅ KLAIM VALID. Upstream punya dasar, tapi proof layer = REWRITE.

---

### 12. Ledger & Double-Entry
**Klaim v1.1:** Decision ledger upstream bukan double-entry financial journal.
**Bukti source:** CloddsBot punya:
  - `src/ledger/`: hash chain, anchoring, audit trail
  - Tapi: event-based logging, bukan double-entry accounting
**Verdict:** ✅ KLAIM VALID. Financial ledger = REWRITE.

---

### 13. Signer Vault Isolation
**Klaim v1.1:** Signer Vault proses terpisah, verifikasi typed SignRequest.
**Bukti source:** CloddsBot signer = inline function di `polymarket-order-signer.ts`, tidak ada process isolation.
**Verdict:** ✅ KLAIM VALID. Vault isolation = REWRITE total.

---

## TEMUAN YANG TIDAK DITEMUKAN DI v1.1

### A. WebSocket Reconnection Strategy
CloddsBot punya WebSocket market data feed (`src/feeds/polymarket/`). v1.1 tidak secara eksplisit membahas reconnection, backoff, atau stale detection strategy untuk WS.

### B. Order Persistence & Recovery
CloddsBot punya order persistence di DB. v1.1 menyebut "cancel/fill race" dan "recovery" tapi detail implementasi masih DESIGN.

### C. Multi-Wallet Nonce Management
v1.1 menyebut "many wallet actors" tapi tidak detail tentang nonce management concurrent wallets.

### D. Paper Trading Simulator
v1.1 menyebut PAPER mode tapi calibrated simulator belum terdefinisi detail.

---

## RINGKASAN SKOR

| Aspek | v1.0 Gap | v1.1 Addressed | Source Verified | Status |
|-------|----------|----------------|-----------------|--------|
| POLY_1271 | ❌ Missing | ✅ P0 req | ✅ Line 604-609 | VALID |
| CLOB V2 | ❌ Boundary | ✅ Verified | ✅ Contract match | VALID |
| SDK Matrix | ❌ Tidak ada | ✅ 3 kandidat SHA512 | ✅ Registry match | VALID |
| Dependency | ❌ 80+ packages | ✅ 245 REMOVE | ✅ CSV evidence | VALID |
| Risk Hardening | ⚠️ Partial | ✅ 10-layer + bugs | ✅ engine.ts match | VALID |
| Venue Mode | ❌ Tidak ada | ✅ State machine | ✅ No 425 handler | VALID |
| Fee Semantics | ⚠️ V1 only | ✅ V1→V2 delta | ✅ struct match | VALID |
| Market Graph | ⚠️ Regex only | ✅ Proof layer | ✅ market-link match | VALID |
| Strategy Ecosystem | ❌ 1 strategy | ✅ 8 families | ✅ No PM strategy | VALID |
| Signer Vault | ❌ Inline | ✅ Process isolation | ✅ No vault class | VALID |
| Ledger | ⚠️ Event log | ✅ Double-entry | ✅ ledger/ match | VALID |
| Rebate Attribution | ⚠️ Mixed | ✅ Separated | ✅ logger.ts match | VALID |

**Kesimpulan:** Semua 12 P0 gap dari v1.0 audit **VALID** dan **dibuktikan** oleh source code + Polymarket live docs. v1.1 spec pack **bukan klaim kosong** — setiap temuan punya locator sumber (R01–R46) dan bukti konkret.

**Tapi:** Status semua = DESIGN/NOT_RUN. Belum ada satu baris kode Polyroot yang ditulis. Spec pack adalah **riset dan desain yang solid**, bukan implementasi.

---

## REKOMENDASI LANGKAH SELANJUTNYA

1. **G0 Gate Preparation:** SDK acceptance tests (32 kontrak tests) harus jadi prioritas pertama. Ini membuktikan kandidat SDK benar-benar bisa signing V2 + POLY_1271.
2. **Signer Vault Prototype:** Proses terisolasi pertama yang harus dibuktikan.
3. **Dependency Pin:** `npm pack` + SHA512 verification untuk production packages.
4. **Paper Trading Framework:** Simulasi tanpa uang, membuktikan ledger dan risk engine.
5. **Fork CloddsBot Secara Resmi:** Git fork dengan disposition matrix sebagai guide, mulai dari KEEP+HARDEN (3 files) dan ADAPT (134 files).
