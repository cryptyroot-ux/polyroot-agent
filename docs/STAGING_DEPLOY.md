# Staging Deploy Guide (English)

Goal: prove PolyRoot on real infrastructure, then admit LIVE orders only
after the owner signs a promotion. **Any failed gate = STOP, never bypass.**

## 0. Rules

- **LIVE is the only runtime mode.** `PAPER`, `SHADOW`, and `MICRO_LIVE`
  are rejected by the CLI. `polyroot shadow-fund` is obsolete (no handler).
- `polyroot run` without `polyroot live-promote` starts `FINANCIAL_BLOCKED`
  and submits nothing. That is not a paper simulator. A promoted loop
  sends real orders.
- Only the owner grants the promotion (never the AI, never auto).
- Full order of operations: `docs/RUNBOOK_LIVE_GO_LIVE.md`.

## 1. Provision staging

```bash
curl -fsSL https://raw.githubusercontent.com/cryptyroot-ux/polyroot-agent/main/scripts/install.sh | bash
# then open a NEW terminal so ~/.local/bin is on PATH
```

(Developers who prefer manual builds: `git clone`, `npm ci`,
`npm run build`, `docker compose up -d postgres`, `npm run migrate:latest`,
`npm run migrate:status` — every file must show as applied.)

Compose defaults `RUNTIME_MODE` to `LIVE`. Do not set it to `PAPER`.

## 2. Configure

```bash
polyroot setup     # guided: LIVE, caps, markets (Auto default), wallet, API
polyroot status    # confirm Mode, Wallet, Loss Cap
```

The kernel does not insert a `(0, 0)` balance and does not read pUSD
off the chain. `polyroot doctor --live` and `polyroot run` refuse until
the funder row has positive available+committed. Record an owner
attestation (the source text is where you read the figure; it is not a
chain proof, and a decrease is refused):

```bash
polyroot bankroll credit --amount 50.00 --source "polymarket portfolio 2026-10-24"
```

## 3. Prove readiness (hard gate)

```bash
polyroot doctor --live
```

All checks must pass (db, schema, bounds, universe, wallet, venue creds,
venue read, metrics key, loss latch, stale unknowns, funder cash). Any
failure = fix it first. A PASS proves infrastructure, **not** permission
to trade.

## 4. Blocked loop (no orders until promotion)

```bash
setsid nohup polyroot run > ~/.polyroot/live.log 2>&1 < /dev/null &
curl http://127.0.0.1:9090/healthz   # must be {"status":"ok"}
```

Expect `FINANCIAL_BLOCKED` in the log until `live-promote` has been
granted and the process restarted. Watch from the console: `polyroot`,
then `logs --follow`.

Watch daily: no repeated `ERROR`, no stuck `ACTIVE` reservations
(`SELECT count(*) FROM reservations WHERE status='ACTIVE'` returns to 0
when idle). Restart any time — state is durable in PostgreSQL.
`polyroot shadow-baseline status` still reports the G4 observation
evidence promotion requires. It does not by itself unblock startup.

## 5. Go live (owner money, owner risk)

1. Fund a dedicated wallet; keep signer, account, and funder distinct.
2. `polyroot setup` with a capital cap and loss cap you can afford to lose.
3. `polyroot doctor --live` → all PASS.
4. `polyroot live-promote` (owner signature; gates G0–G4, including the
   baseline). Restart the loop after a grant.
5. Review fills, fees, exposure, and latch behavior. `polyroot halt` still
   latches first, then tries to cancel.

## 6. Before the first promoted run

- [ ] `polyroot doctor --live` passed on this host
- [ ] `polyroot shadow-baseline status` reviewed; G4 evidence is what promotion checks
- [ ] Loss latch drill done: breach halts, `polyroot guard reset` clears only when loss is back under the cap
- [ ] Owner records the promotion decision (who, when, deployed SHA)

## Rollback

Kill-switch first (`polyroot halt`), then redeploy the previous verified
SHA with the same bounds. Export `recovery_ledger`, `seen_orders`,
`ledger_events` before redeploying for forensics.
