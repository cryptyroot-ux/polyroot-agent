# Runbook: Go Live

> English. Exact commands; do not improvise the order.

## 0. Principles

- **LIVE is the only runtime mode.** There is no PAPER or SHADOW to trade
  without money. Every order is real.
- LIVE requires an owner-signed promotion (`polyroot live-promote`). Without
  one the loop starts `FINANCIAL_BLOCKED` and sends nothing.
- Real money = real risk. Set a capital cap and a daily loss cap you can
  afford to lose before the first run.
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

If `venue check` FAILs, stop here: fix connectivity first.

## 3. Configure (guided, safe defaults)

```bash
polyroot setup
# Choose LIVE with a capital cap you can afford to lose. Market discovery defaults to
# Auto: the agent finds the most liquid markets itself (min 24h volume +
# max spread guardrails). No manual token-ID pasting required.
polyroot doctor                      # all checks must pass
```

Without a market universe (neither Auto nor curated IDs), the live modes
refuse to start (`MARKET_UNIVERSE_MISSING`) — the loop never falls back to
mock data when LIVE is configured.

## 4. Run and accumulate observation

```bash
setsid nohup polyroot run > ~/.polyroot/observe.log 2>&1 < /dev/null &
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
  full decide → reserve → fill → settle path runs.
- Restart any time: state is durable in PostgreSQL.

## 5. Observation evidence (read from the DB, never claimed)

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
-- Prefer: polyroot shadow-baseline status
SELECT observed_days, resolved_clusters, preregistered, versions_frozen_sha, updated_at
FROM shadow_baseline
WHERE id = '00000000-0000-0000-0000-000000000001';
```

The G5 observation baseline (code: `g4-core.ts`, `live-guard-store.ts`) is
**advisory evidence, not a startup gate**. Check it to see how long the agent
has been observing, then decide for yourself whether the evidence is enough:

1. `polyroot shadow-baseline status` reports 30/30 observed days AND
   100/100 resolved clusters, `preregistered: true`, and a frozen spec sha.
2. Fills settle: bankroll moves, no stuck reservations, no repeated ERROR.
3. Owner-explicit loss cap set (a number, e.g. 100 USDC).

Both counters are derived by the agent itself — never hand-edit them. The
only manual step is freezing the pre-live spec, which must happen BEFORE the
observation window counts:

```bash
polyroot shadow-baseline freeze <git-sha> --rule "<stopping rule text>"
```

`--rule` is mandatory; the command refuses without it.

## 6. Go live — checklist

- [ ] DEDICATED test wallet (not the main wallet), 3 distinct addresses (signer/account/funder) — `polyroot wallet verify`, all PASS.
- [ ] USDC funded + CTF approval done (manual, via Polymarket UI/cast).
- [ ] `POLYMARKET_API_KEY/_SECRET/_PASSPHRASE` filled from the Polymarket profile.
- [ ] Observation evidence from section 5 complete (`polyroot shadow-baseline status`).
- [ ] Caps: keep the $1000 capital default until 2 weeks of results are reviewed.
- [ ] `/metrics` (Bearer key) monitored + daily-loss alert active.

Start:

```bash
polyroot setup     # choose LIVE, small capital, 5% loss latch
polyroot doctor --live   # every check must be ✅ PASS
polyroot run
```

Kill criteria (stop when any one happens):

- Realized loss touches the loss cap.
- Repeated `VENUE_REJECTED` / `SUBMISSION_UNKNOWN` with no explanation.
- Polymarket balance/positions mismatch the ledger (`reconcile`).

## 7. Honest warnings (read before funding a wallet)

1. **Automatic enforcement IS wired**: exposure cap, persistent loss-cap
   latch (DB `live_guard_state`, survives restarts), and the G5 baseline gates.
   Unlock the latch only via `polyroot guard reset --loss <pusd>` once loss
   is back under cap. The manual kill criteria in section 6 stay as a
   second layer.
2. **Signer = encrypted keystore or KMS/HSM** (keystore: `wallet seal` +
   `POLYROOT_KEYSTORE_JSON` + `POLYROOT_KEYSTORE_PASSPHRASE`; KMS/HSM:
   optional). Limit funds in the test wallet; assume keys can leak.
3. **Grant the promotion.** `polyroot live-promote` issues the owner-signed
   promotion the loop requires. Until then it is `FINANCIAL_BLOCKED`.
