# Staging Deploy Guide (English)

Goal: prove PolyRoot on real infrastructure with zero financial risk,
then promote step by step. **Any failed gate = STOP, never bypass.**

## 0. Rules

- STAGING = real PostgreSQL + real venue reads, **no orders, no money**.
- SHADOW = live data, simulated fills, **zero financial I/O**.
- MICRO_LIVE = real orders with a small explicit cap. Real money = real risk.
- Only the owner promotes between stages (never the AI, never auto).

## 1. Provision staging

```bash
git clone https://github.com/cryptyroot-ux/polyroot-agent.git
cd polyroot-agent
npm ci
npm run build
docker compose up -d postgres
npm run migrate:latest
npm run migrate:status   # every file must show as applied
```

## 2. Configure (guided, safe defaults)

```bash
polyroot onboard     # first time: 3 steps, Enter = safe default
# or, to change settings later without touching keys:
polyroot setup
polyroot status      # confirm Mode, Wallet, Loss Cap
```

## 3. Prove readiness (hard gate)

```bash
polyroot doctor --live
```

All 9 checks must be ✅ PASS (db, schema, bounds, universe, wallet,
venue creds, venue read, metrics key, loss latch). Any ❌ = fix it first.
A PASS proves infrastructure, **not** permission to trade.

## 4. SHADOW soak (minimum 48 hours)

```bash
RUNTIME_MODE=SHADOW POLYROOT_MARKET_IDS=<id1,id2> \
  docker compose -f docker-compose.prod.yml up -d --build
curl http://127.0.0.1:9090/healthz   # must be {"status":"ok"}
```

Watch daily: no repeated `ERROR`, no mass `VENUE_MARKET_UNRESOLVED`
(bad market list). Restart any time — state is durable in PostgreSQL.
See `docs/RUNBOOK_SHADOW_MICROLIVE.md` for the 30-day baseline evidence
queries (`shadow_baseline`: `observed_days`, `resolved_clusters`).

## 5. MICRO_LIVE with a small cap (owner money, owner risk)

1. Fund a dedicated wallet; keep signer, account, funder distinct.
2. `polyroot setup` → LIVE, capital **$50–100**, loss latch **5%**.
3. `polyroot doctor --live` → all PASS.
4. `polyroot` → run 1–2 weeks. Review PnL, fills, fees, latch behavior.

## 6. Promote to LIVE (owner sign-off only)

- [ ] SHADOW baseline met (or explicit owner waiver with reason recorded)
- [ ] MICRO_LIVE reviewed: fills match expectations, no stuck reservations
      (`SELECT count(*) FROM reservations WHERE status='ACTIVE'` returns to 0)
- [ ] Loss latch drill done: breach halts, `polyroot guard reset` clears
- [ ] Owner records the promotion decision (who, when, deployed SHA)

## Rollback

Kill-switch first, then redeploy the previous verified SHA with the same
bounds. Export `recovery_ledger`, `seen_orders`, `ledger_events` before
redeploying for forensics.
