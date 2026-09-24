# Runbook: SHADOW 30 Hari → MICRO_LIVE Cap Kecil

> Bahasa Indonesia. Perintah persis; jangan improvisasi urutan.

## 0. Prinsip

- SHADOW = baca data live, eksekusi simulasi, **tanpa transaksi finansial**.
- MICRO_LIVE = order real dengan cap eksplisit. Dana real = risiko real.
- Setiap gerbang yang gagal = BERHENTI, bukan bypass.

## 1. Prasyarat

```bash
cp .env.example .env   # lalu isi DATABASE_URL, RPC_URL
docker compose up -d postgres
npm run migrate:latest
```

## 2. Smoke test (tanpa secret, tanpa agent)

```bash
npm start -- wallet verify
node src/pm/runtime/dist/cli.js venue check --asset <token-id>
# PASS = baca order book live OK (contoh lolos: YES 0.002 / NO 0.003)
```

SHADOW tidak butuh private key / API credentials (public client). Kalau
`venue check` FAIL, jangan lanjut: perbaiki koneksi dulu.

## 3. Menjalankan SHADOW 30 hari

```bash
RUNTIME_MODE=SHADOW docker compose -f docker-compose.prod.yml up -d --build
curl http://127.0.0.1:9090/healthz
```

Monitoring harian:

- `GET /healthz` harus `{"status":"ok"}`.
- Log agent: tidak ada `ERROR` berulang, tidak ada `VENUE_MARKET_UNRESOLVED` massal (artinya daftar market tidak valid).
- Restart kapan pun aman: state persisten di PostgreSQL.

## 4. Bukti SHADOW (dibaca dari DB, bukan klaim)

```sql
-- Baseline G5: butuh observed_days >= 30 DAN resolved_clusters >= 100
SELECT observed_days, resolved_clusters, preregistered, updated_at
FROM shadow_baseline
WHERE id = '00000000-0000-0000-0000-000000000001';

-- Volume keputusan simulasi (harus tumbuh tiap hari)
SELECT action, COUNT(*) FROM paper_log GROUP BY action;

-- Kualitas forecast (diisi saat eksperimen di-conclude)
SELECT * FROM experiment_results;
```

Kriteria promosi SHADOW → MICRO_LIVE (kode: `g4-core.ts`, `micro-live-guard.ts`):

1. `observed_days >= 30`, `resolved_clusters >= 100`.
2. Reality-gap PASS (paper fill vs live book dalam toleransi).
3. Loss cap owner di-set eksplisit (angka, mis. 100 USDC).

## 5. Go-live MICRO_LIVE (cap kecil) — checklist

- [ ] Dompet KHUSUS uji (bukan dompet utama), 3 alamat berbeda (signer/account/funder) — cek via `wallet verify`, semua PASS.
- [ ] USDC masuk + approval CTF selesai (manual, via UI Polymarket/cast).
- [ ] `POLYMARKET_API_KEY/_SECRET/_PASSPHRASE` terisi dari profil Polymarket.
- [ ] Bukti SHADOW poin 4 lengkap (30 hari + 100 cluster + reality-gap PASS).
- [ ] Cap: jangan ubah default 500 USDC sebelum 2 minggu hasil dievaluasi.
- [ ] Monitoring `/metrics` (Bearer key) + alert loss harian aktif.

Start:

```bash
RUNTIME_MODE=MICRO_LIVE docker compose -f docker-compose.prod.yml up -d
```

Kill criteria (hentikan saat salah satu terjadi):

- Realized loss menyentuh loss cap.
- `VENUE_REJECTED` / `SUBMISSION_UNKNOWN` beruntun tanpa penjelasan.
- Saldo/posisi di Polymarket tidak cocok dengan ledger (`reconcile`).

## 6. Peringatan jujur (baca sebelum danai wallet)

1. **Enforcement otomatis SUDAH di-wire** (sejak rilis berikutnya): exposure
   cap, loss-cap latch persisten (DB `live_guard_state`, selamat dari
   restart), dan gerbang startup SHADOW 30d/100-cluster. Buka latch hanya
   via `polyroot guard reset --loss <pusd>` saat loss kembali di bawah cap.
   Kill criteria manual di poin 5 tetap berlaku sebagai lapisan kedua.
2. **Signer = hot key dari env** (KMS/HSM belum diimplementasikan). Batasi
   dana di dompet uji; anggap key bisa bocor.
3. **LIVE penuh butuh Autonomy Charter + G5 gates.** MICRO_LIVE bukan jalan
   pintas ke LIVE.
