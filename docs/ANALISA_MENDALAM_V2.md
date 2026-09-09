# ANALISA MENDALAM V2: PERBANDINGAN CROSS-DOKUMEN

## 1. Ringkasan Eksekutif

Draf baru Polyroot v1.1 menghadirkan **perbaikan penting** pada PRD/Blueprint dari kloning CloddsBot 1.9.0 (commit 715fd4a6) untuk memenuhi audit **30 poin** yang user lakukan sebelumnya.

## 2. Temuan Kritis dari Source Code CloddsBot (kebocoran)

### 2.1 Sistem Tanda Tangan (EIP-712)

```typescript
Order struct V2:
  (salt, maker, signer, tokenId, makerAmount, takerAmount,
   side, signatureType, timestamp, metadata, builder)

enum SignatureType { EOA=0, POLY_PROXY=1, GNOSIS_SAFE=2, POLY_1271=3 }
```

**P0**: CloddsBot memiliki **dukungan indikatif** untuk POLYGON 1271 tetapi **belum diimplementasikan**:
- `if (signatureType === SignatureType.POLY_1271) { throw new Error('POLY_1271 signing not implemented...'); }`
- Ini menunjukkan **KESENANGAN**: Menyatakan dukungan tetapi tidak mengimplementasinya.

### 2.2 Tata Letak Risiko

**R1**: Risiko Engine diimplementasikan sebagai:
- Pengelola verifikasi keselamatan, penalaran risk, dan pencegahan gagal
- Mengelola 9 domain keselamatan: kill switch, sirkuit breaker, ukuran pesanan, batas eksposur, drawdown harian, konsentrasi, VaR, volatilitas, Kelly
- **P0**: Saat ini belum memiliki **logika kompensasi untuk lari cepat** untuk posisi delta + harga besar yang terintegrasi dengan Poli Market CLOB V2 yang baru

### 2.3 Sistem Subsystems (layanan kode lengkap)

```
src/gateway              (WebSocket control/UI)
src/execution          (CLOB order placement)
src/feeds/polymarket    (Real-time market data + user WebSocket)
src/risk                (Kill switches, stress, VaR, volatilitas)
src/opportunity         (Arbitrage, mencari peluang)
src/agents/handlers     (Per-platform: polymarket, kalshi, solana, dll.)
src/strategies/hft-divergence (Pasar berjalan, lebih tinggi)
src/skills/bundled/trading-polymarket (CLI Skill)
```

**Temuan P0**: 
- CloddsBot menyediakan **28+ platform**, **630+ skills**
- Blueprint (v1.0) hanya menyantumkan **9 saja**
- Ini adalah **pita pengukur `terlalu dangkal`** yang user catat

## 3. Ketidakcocokan Cross-Dokumen Utama (v1.0 → v1.1)

### 3.1 Produk Identity

| Dimensions | v1.0 (Polymarket AI Trader) | v1.1 (Polyroot) |
|------------|----------------------------|----------------|
| **Nama produk** | "Polymarket AI Trader" | "Modular Autonomous Prediction-Market Intelligence & Trading System" |
| **Scope** | Satu wallet, satu strategi (`evidence_directional_v1`), satu execution service | Modular autonomous, multi-strategy intelligence & trading system |
| **Tujuan** | Directional trading dengan AI | Sistem prediksi pasarg secara otonom dengan banyak strategi |

**Validasi**: v1.0 **belum memenuhi** spesifikasi Polyroot, v1.1 **memenuhi**

### 3.2 Arsitektur

**v1.0**: "Satu bot directional dengan AI"
**v1.1**: "Modular autonomous prediction-market intelligence & trading system"
- **Kerangka konseptual**: Penanganan risiko, koordinasi platform, safety kernel, execution service
- **User menyetujui**: Kecukupan safety dan eksekusi v1.0; tetapi tidak sesuai dengan arsitektur akhir Polyroot

### 3.3Wallet & Sistem Tanda Tangan

**Temuan P0**: CloddsBot hanya mendukung **EOA, POLY_PROXY, GNOSIS_SAFE**
**Kebutuhan**: **POLY_1271** dan **Deposit Wallet (wallet type=3)** untuk CLOB V2

### 3.4Integrasi CLOB

**Temuan**: CloddsBot **memiliki** `getCurrentPolymarketOrderVersion()` tetapi **tidak digunakan**
**Kebutuhan**: 
- **CLOB V2** contract addresses
- **EIP-712 domain** v2 (pUSD, builder, metadata)
- **Serde/V2** order strukture (timestamp, builder)

### 3.5Kesenjangan Kebijakan

| Domains | v1.0 | v1.1 |
|---------|------|------|
| **Eksklusi strategi** | Arbitrase, copy trading, weather, HFT, LP | **Modular** (mendukung banyak strategi) |
| **Kesenjangan prioritas keselamatan** | Fokus pada konsistensi internal | Autonomi yang dibatasi oleh program mandat dasar (Auth --> Money Kernel --> Signer Vault) |
| **Eksperimen** | Tidak ada | **Eksperimen** (`PAPER/SHADOW` untuk bebas regulasi) |

## 4. Roadmap Item/Kesenjangan Berdasarkan Perbaikan Lanjutan

### 4.1Implementasi Tanda Tangan POLYGON 1271 (P0)

```typescript
if (signatureType === SignatureType.POLY_1271) {
  // NEW IMPLEMENTATION:
  // 1. Deteksi tipe wallet melalui RPC:
  const walletType = await provider.getWalletType(address);
  if (walletType !== 'DEPOSIT_WALLET') {
    throw new Error('POLY_1271 requires wallet type 3');
  }
  // 2. Tanda tangan menggunakan ekstensi EIP-6492 (validator per metadata) atau EIP-3770 + agregator relayer;
}
```

**Rencana**: 5+ hari

### 4.2Rute Penyesuaian Platform (P0)

| Targets | v1.0 | Rencana v1.1 |
|---------|------|-------------|
| **Platform yang didukung** | 28+ | • CLOB V2 (polymarket) • Kalshi • Betfair • Solana DEX • Traditional finance pasar (CBOE, CME) |
| **Sumber data** | WebSocket, REST | Mengimplementasikan sistem pipelines: • PolygMarket WebSocket • Alpha • API • Feeds • Komunitas • Weather • Ekonomi • Kecelakaan |
| **Pemetaan SDK** | `src/agents/handlers/polymarket` • `src/agents/handlers/kalshi` • `src/agents/handlers/betfair` | **VenueAdapter** framework yang kuat: • Mengikat ke @polymarket/client v0.9.0 • @polymarket/clob-client-v2 untuk margin-trading • @kalshi/js-client • @betfair/js-api • @jupiter-ag/token • Solana web3 SDK |

### 4.3Struktur Fork Matrix (P0)

**Cakupan saat ini**: Hanya **9 path** (feeds, penyedia, agent/tool, eksekusi, trading skill, HFT divergence, persistensi, penandatanganan, gateway)
**Kebutuhan**: **Byte-level Fork Disposition Matrix** dari **semua** subsistem

**Kategori**: 
- `KEEP` (Sistem saat ini memiliki keamanan, skalabilitas, kompatibilitas yang tepat)
- `KEEP+HARDEN` (Pertahankan tetapi perkuat keamanan, error handling, ketahanan)
- `ADAPT` (Sesuaikan dengan CLOB V2, pUSD, POLYGON 1271)
- `REWRITE` (Tulis ulang untuk CLOB V2 atau berdasarkan kebijakan baru)
- `REMOVE` (Hapus)/`QUARANTINE` (Tempatkan dalam area terisolasi)
- `RESEARCH-ONLY` (Lanjutkan penelitian, jangan diintegrasikan)

### 4.4Penyesuaian Keamanan/Alpha P0 (Berisiko tinggi)

**Subsystems**
- **Signer Vault**: Implementasi isolasi penuh (L1 --> L2 --> Signer) dan tipe wallet pemeriksaan
- **SSRF**: Membatasi panggilan HTTP eksternal, melarang IPv4 internal, validasi header, reject redirect ke luar jaringan
- **Sandbox Plugin**: Isolasi `Process` vs `worker threads` (Node), Konteks terbatas (`--disable-parent` pada ts-node)
- **Dependency Amputation**: Hapus dependensi yang tidak diperlukan ke Solana, Drift, Marginfi, Kamino, Orca, Raydium, Jup, Pump.fun, Bittensor, dll. (Pertahankan hanya untuk platform yang diperlukan)
- **Rate Governor**: Menerapkan tingkat ke, memvalidasi `deadline` dan `queueAge` sebelum submit

### 4.5CLOB V2+POLY_1271 Integration (P0)

**Implementasi**
1. **Adaptasi SDK**: @polymarket/client 0.9.0 + @polymarket/clob-client-v2 v2 (status)
2. **Adaptor baru**: `CLOBV2Adapter`:
   ```typescript
   async placeOrder(order: OrderV2): Promise<OrderResult> {
     // 1. Tambahkan cek signatureType
     // 2. Set deposit wallet (walletType=3)
     // 3. Gunakan ctf-exchange-v2 contract (0xE111...)
     // 4. Tanda tangan metadata builder
     // 5. Hit /order pada CLOB V2 API
   }
   ```

3. **Tangani kasus**: 
   - Mengambil Tager Rebate dari API
   - Menerapkan kecerdasan pembuat dan penerima

### 4.6Struktur Strategies Ecosystem (P1)

**Untuk persyaratan v1.1**: 
- **Inteligensi multi-sinyal**: Market graph (berdasarkan kontrak/hasil)
- **Source Intelligence**: Berita, mikro makro, utama (kemampuan dasar)
- **Market Intelligence**: Orderbook depth, spread, harga, likuiditas, velocity, orderflow
- **Position Sizer**: Mengukur kelicinan, Kelly, batas portofolio
- **Correlator Engine**: Cross asset, cross market, korelasi
- **Strategy Sandboxes**: Isolasi terpisah untuk setiap strategi

### 4.7Funds Safe Kernel (P0)

**Mekanisme**
```
Owner  --> Auth (Creatable signers: L1, L2, Builder) --> Money Kernel (Vault) --> SignerVault (Narrow)
                                             ^
                                             |
                                             +--> Restrict # ... (Only signed per-model permmissions) --> Execution (Designated agents)
```

**Validasi**: 
- Autentikasi pemohon penandatanganan
- Logika: Token EIP-712 untuk deposit wallet
- Kompatibilitas: Tidak membocorkan hash

### 4.8Observability & Recovery (P1)

**Rencana**: Implementasikan **Runtime Supervisor** (V1 tidak memiliki):
- Liveness monitoring (service, feed, platform)
- Scheduler (triggers, operasi)
- Backpressure & backstop recovery
- Service failover state

## 5. Rencana Persiapan Implementasi (G0 → BETA)

### 5.1G0: Persiapan Fork (6-10 hari)

1. **Implementasi Fork Matrix** untuk subsistem `~130`
2. **Adaptasi SDK**: Tidak perlu membangun client baru, tetapi **menghapus** `dst/contract lama`
3. **Penyesuaian Keamanan**: 
   - Signer Vault
   - SSRF
   - Sandbox
   - Dependency
4. **Diuji dengan sandbox kecil**: `node ./test-polyroot-v1.1.js`

### 5.2G0+ : Core Implementation (45-60 hari)

| Components | Tim | Owner |
|------------|-----|-------|
| **Core** | Backend | Tokitsukaze |
| **Frontend** | UI/UX | Potro |
| **Keamanan** | Secure + Audit | Sugoi |
| **Ops** | CI/CD | Lotus |
| **Keberlanjutan** | ETL + Observability | Liubert |

### 5.3Rute Release (BETA, ALPHA)

1. **BETA** (G1-G2): CLOB V2, POLY_1271, SDK V2
2. **ALPHA** (G3): Market graph, multi-signal intelligence, strategy ecosystem
3. **LIVENGROUND** (G4-G5): Observability, pemulihan, komite risiko, kombinasi perbankan

## 6. Bukti Pengembalian

**Path perbaikan**
```
/PRD_v1.1_clean.txt
/BLUEPRINT_v1.1_clean.txt
/src/feeds/polymarket
/src/utils/polymarket-order-signer.ts
/src/risk/engine.ts
/src/execution/circuit-breaker.ts
/src/opportunity/index.ts
/src/skills/bundled/trading-polymarket

Required fix calls:
1. copy documents into /root/projects/Polyroot/docs/
2. Run docx-extract untuk kedua file
3. Hasil analisis disimpan di /root/projects/Polyroot/docs/ANALISA_MENDALAM_V2.md
```

## 7. Autonomi dan Etika

**Ketidak-pastian**:
- Tidak menjanjikan profit, edge, atau kinerja yang dijamin (asas "kontrak cerdas, tidak ada janji janji)"
- Kejelasan: Autonomi atas mandat, tidak atas modal; Owner tetap memiliki hak penuh atas Hak Pribadi
- Tidak ada noaa
- Geoblok memerlukan pihak berwenang
- Perbaikan hanya “ex-periment” (PAPER/SHADOW)

## 8. Autentikasi dan Signer yang Aman

**Kerangka konseptual**
```
Owner (L1) --> Signer --> Money Kernel --> SignerVault --> Execution
   ^
   |
   +--> Auth (L2) – Buat kunci L2 + API API builder (tokenized)
```

**Tujuan**
- L1: Non-custodial, pemilik yang ditandatangani
- L2: Small trust, role-based, origin verification
- SignerVault: Narrow kernel, hanya sign tipe yang diizinkan
- Keamanan: Kunci terisolasi, tipe wallet, penandatanganan EIP-1271

## 9. Integrasi Platform/Pasar Baru

**Design**
1. **Venue Adapter** : Platform interface dengan batasan
2. **Consistency Adapter** : Validasi MAtriks per-platform (kebijakan, harga, likuiditas, cap, slippage)
3. **Universal Wallet**: Adapter PUSD + USDC (Approvals)
4. **Market Graph**: Penanganan atribut yang didefinisikan pengguna
5. **Penghargaan**: Skor yang dihasilkan, label kesalahan, bukti validasi

## 10. Catatan Kesimpulan

- **Perbaikan P0 kritis**: Implementasi POLYGON_1271, CLOB V2, Money Kernel, Signer Vault, Dependency amputation, SSRF
- **Tim 8**: Core, frontend, keamanan, ops, keberlanjutan, etc.
- **Validasi**: Rencana G0 → BETA (G1-G2) seperti di atas
- **Rencana**:   Implementasi baru dengan ketahanan pada rasa sakit wallet dan manajemen uji coba

## 11. Bukti Validasi

```
--- /root/projects/Polyroot/docs/ANALISA_MENDALAM_V2.md ---
Proyeksi keseluruhan tanggal target awal: 9 September 2026 (Hari ini) + 120 hari = 12 Januari 2026
Pengambilan risiko: Proses polymarket tidak mencapai bagian yang berhasil
```