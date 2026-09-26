# Runbook: SHADOW 48 Hours → MICRO_LIVE Small Cap

> English. Exact commands; do not improvise the order.

## 0. Principles

- SHADOW = live data reads, simulated fills, **zero financial I/O**.
- MICRO_LIVE = real orders with an explicit cap. Real money = real risk.
- Any failed gate = STOP, never bypass.

## 1. Prerequisites

```bash
curl -fsSL https://raw.githubusercontent.com/cryptyroot-ux/polyroot-agent/main/scripts/install.sh | bash
# then open a NEW terminal so ~/.local/bin is on PATH
polyroot status   # confirm Mode, Database, Wallet
```

Recommended: seal the private key (never store raw hex):

```bash
PRIVATE_KEY_HEX=0x... POLYROOT_KEYSTORE_PASSPHRASE=... polyroot wallet seal --out ~/.polyroot/keystore.json
# Then remove the raw key from .env; keep only POLYROOT_KEYSTORE_JSON + POLYROOT_KEYSTORE_PASSPHRASE.
```

## 2. Smoke test (no secrets, no agent)

```bash
polyroot wallet verify
polyroot venue check --asset <token-id>
# PASS = live order-book read OK
```

SHADOW needs no private key or API credentials (public client). If
`venue check` FAILs, stop here: fix connectivity first.

## 3. Configure (guided, safe defaults)

```bash
polyroot setup
# Choose SHADOW. Market discovery defaults to Auto: the agent finds the
# most liquid markets itself (min 24h volume + max spread guardrails).
# No manual token-ID pasting required.
polyroot shadow-fund --amount 1000   # $1000 play bankroll (SHADOW only)
polyroot doctor                      # all checks must pass
```

Without a market universe (neither Auto nor curated IDs), non-PAPER modes
refuse to start (`MARKET_UNIVERSE_MISSING`) — the loop never falls back to
mock data when live/SHADOW is configured.

## 4. Run SHADOW 48 hours

```bash
setsid nohup polyroot run > ~/.polyroot/shadow-48h.log 2>&1 < /dev/null &
curl http://127.0.0.1:9090/healthz   # must be {"status":"ok"}
```

Watch from inside the console (no terminal skills needed):

```bash
polyroot          # opens the console
logs --follow     # live activity: fills, AI probabilities, edges
```

Daily monitoring:

- `GET /healthz` must return `{"status":"ok"}` with growing `uptime_s`.
- Agent log: no repeated `ERROR`, no stuck `ACTIVE` reservations.
  `⏭️  No trade: NEGATIVE_EDGE (AI p=..., edge=-...)` is normal thinking,
  not an error.
- `✅ Fill: FILLED @ <price> x <size> (AI p=..., edge=+...)` proves the
  full decide → reserve → fill → settle path runs on sim funds.
- Restart any time: state is durable in PostgreSQL.

## 5. SHADOW evidence (read from the DB, never claimed)

```sql
-- Simulated decision volume (must grow daily)
SELECT COUNT(*) FROM trade_intents;
SELECT status, COUNT(*) FROM risk_decisions GROUP BY status;

-- Play bankroll movement (fills consume simulated funds)
SELECT available_base, committed_base FROM balance_entries
WHERE asset = 'pUSD';

-- Stuck reservations (must return to 0 when idle)
SELECT COUNT(*) FROM reservations
WHERE status = 'ACTIVE' AND expires_at < now();

-- 30-day baseline row (G5 gate source of truth)
SELECT observed_days, resolved_clusters, preregistered, updated_at
FROM shadow_baseline
WHERE id = '00000000-0000-0000-0000-000000000001';
```

Promotion criteria SHADOW → MICRO_LIVE (code: `g4-core.ts`, `micro-live-guard.ts`):

1. 48 clean hours minimum (30 days + 100 resolved clusters for full G5).
2. Fills settle: bankroll moves, no stuck reservations, no repeated ERROR.
3. Owner-explicit loss cap set (a number, e.g. 100 USDC).

## 6. Go-live MICRO_LIVE (small cap) — checklist

- [ ] DEDICATED test wallet (not the main wallet), 3 distinct addresses (signer/account/funder) — `polyroot wallet verify`, all PASS.
- [ ] USDC funded + CTF approval done (manual, via Polymarket UI/cast).
- [ ] `POLYMARKET_API_KEY/_SECRET/_PASSPHRASE` filled from the Polymarket profile.
- [ ] SHADOW evidence from section 5 complete.
- [ ] Caps: keep the $1000 capital default until 2 weeks of results are reviewed.
- [ ] `/metrics` (Bearer key) monitored + daily-loss alert active.

Start:

```bash
polyroot setup     # choose MICRO_LIVE, small capital, 5% loss latch
polyroot doctor --live   # every check must be ✅ PASS
polyroot run
```

Kill criteria (stop when any one happens):

- Realized loss touches the loss cap.
- Repeated `VENUE_REJECTED` / `SUBMISSION_UNKNOWN` with no explanation.
- Polymarket balance/positions mismatch the ledger (`reconcile`).

## 7. Honest warnings (read before funding a wallet)

1. **Automatic enforcement IS wired**: exposure cap, persistent loss-cap
   latch (DB `live_guard_state`, survives restarts), and SHADOW gates.
   Unlock the latch only via `polyroot guard reset --loss <pusd>` once loss
   is back under cap. The manual kill criteria in section 6 stay as a
   second layer.
2. **Signer = encrypted keystore or KMS/HSM** (keystore: `wallet seal` +
   `POLYROOT_KEYSTORE_JSON` + `POLYROOT_KEYSTORE_PASSPHRASE`; KMS/HSM:
   optional). Limit funds in the test wallet; assume keys can leak.
3. **Full LIVE needs Autonomy Charter + G5 gates.** MICRO_LIVE is not a
   shortcut to LIVE.
