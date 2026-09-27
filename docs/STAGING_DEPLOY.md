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
curl -fsSL https://raw.githubusercontent.com/cryptyroot-ux/polyroot-agent/main/scripts/install.sh | bash
# then open a NEW terminal so ~/.local/bin is on PATH
```

(Developers who prefer manual builds: `git clone`, `npm ci`,
`npm run build`, `docker compose up -d postgres`, `npm run migrate:latest`,
`npm run migrate:status` — every file must show as applied.)

## 2. Configure (guided, safe defaults)

```bash
polyroot setup     # guided: mode, caps, markets (Auto default), wallet, API
polyroot shadow-fund --amount 1000   # $1000 play bankroll for SHADOW sims
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
setsid nohup polyroot run > ~/.polyroot/shadow-48h.log 2>&1 < /dev/null &
curl http://127.0.0.1:9090/healthz   # must be {"status":"ok"}
```

Market discovery defaults to Auto (liquid markets within your guardrails);
no manual token IDs needed. Watch from the console — no terminal skills
required: run `polyroot`, then `logs --follow` to see fills and the AI's
probabilities/edges live.

Watch daily: no repeated `ERROR`, no stuck `ACTIVE` reservations
(`SELECT count(*) FROM reservations WHERE status='ACTIVE'` returns to 0
when idle). Restart any time — state is durable in PostgreSQL.
See `docs/RUNBOOK_SHADOW_MICROLIVE.md` for the full runbook and evidence
queries (`trade_intents`, `risk_decisions`, `balance_entries`,
`shadow_baseline`: `observed_days`, `resolved_clusters`).

## 5. MICRO_LIVE with a small cap (owner money, owner risk)

1. Fund a dedicated wallet; keep signer, account, funder distinct.
2. `polyroot setup` → MICRO_LIVE, capital **$50–100**, loss latch **5%**.
3. `polyroot doctor --live` → all PASS.
4. `polyroot run` → run 1–2 weeks. Review PnL, fills, fees, latch behavior.

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
