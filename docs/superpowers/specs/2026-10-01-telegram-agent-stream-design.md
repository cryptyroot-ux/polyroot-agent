# Telegram Agent Stream — Design Spec (PM-OBS-01 refinement)

Date: 2026-10-01. Status: approved by owner (full-English wording).

## 1. Goal

Every Telegram DM from the agent must answer, at a glance: **which market
(human question, never a token id), what decision, why / why-not, and how
much money is at stake.** No placeholder lines, no mock-market spam, no
repeated identical rejections.

## 2. Message formats (all English)

### 2.1 Per-pass digest (one message per pass, always sent)

```
🌐 PASS [SHADOW] 10:58:04
Scanned 12 → evaluating 3, deferred 9
• "Will Trump leave office in 2026?" — evaluating
• "Fed rate cut Q3?" — evaluating
• "BTC above $100k by Friday?" — evaluating
• 9 more deferred (ranked below this pass's top-K cut)
```

Counts come from the real allocator (`selectMarketsForPass`); names come
from discovery question text. Deferred markets are summarized as a count,
not enumerated, to bound length.

### 2.2 Per-market evaluation (full story, deduped)

```
🧠 "Will Trump leave office in 2026?"
Book: YES 52.0¢ / NO 48.0¢ · spread 4.0¢ · 24h vol $1.2M
AI: p(YES) 67% (confidence 34% = 2·|0.67 − 0.50|)
Reasoning: "CPI down 0.2%; real probability above market price."
Factors: • inflation data • informed volume
---
🛡️ DECISION: ⏭️ NO_TRADE
Why not: edge +1.0% below +3.0% floor (4¢ spread too wide)
At stake: $0 (held)
```

Sent once per market per distinct reason, where "first time" means first
time since process start (the memory is process-local, never persisted).
Resent only when the decision flips (NO_TRADE→TRADE) or the reason
changes. Restart clears the memory (fail-open: at most one repeated line,
trading never gated on it). Confidence is derived certainty,
`2·|p − 0.5|` (not a model self-report), consistent with the profit
contract; a missing `p` renders as abstain with no confidence value.

### 2.3 TRADE / fill / reject / error / mode change (always sent, never deduped)

```
🚀 TRADE: BUY 12 shares @ 52.0¢ ≈ $6.24
"Will Trump leave office in 2026?"
Edge +15.0% > floor +3.0% · Kelly 25%
Bankroll $100.00 · exposure $6.24
```

Money movement is always reported. AI reasoning is quoted verbatim
(English as produced); the agent never translates or invents it. Missing
reasoning renders as "no rationale recorded", never fabricated.

## 3. Data plumbing

1. **Question threading**: `marketSource.snapshot()` additionally returns
   `question` + `volume24h` (already present in discovery output — no new
   fetches, no cost). Loop inputs carry them to every event.
2. **Real ranking**: digest order and evaluated-vs-deferred split reuse the
   allocator score (`edge × conviction`); nothing is invented for display.
3. **Dedupe memory**: in-memory `marketId → lastSentReason`. Match →
   silent. Mismatch → send + update. Process-local only.
4. **No trading-logic changes**: all work is observer code at the edges
   (pipeline deps, `bootstrapAgent` wiring). G4 core, risk gate, executor,
   sizing untouched.

## 4. Delivery rules

| Situation | Behavior |
|---|---|
| Per-pass digest | Always, one message per pass |
| Evaluated market, first time / changed reason | One full message |
| Rejected market, same reason as before | Silent |
| TRADE / fill / reject / error / mode change | Always, never deduped |
| `--once` / test runs (mock fixture) | Fully silent — never touches owner DM |
| Above 30/min rate cap | Non-money messages dropped; TRADE/error prioritized |
| Dead Bot API | Trading loop unaffected; messages dropped (gap, never stale backlog) |

## 5. Non-goals

- No translation of model reasoning. No new data vendors. No changes to
  edge floors, sizing, risk policy, or mode logic. No persistence of
  dedupe memory across restarts.

## 6. Acceptance

- Owner sees market questions (never bare token ids) in digest + reports.
- `--once` run produces zero Telegram traffic (verified by absence of the
  `agent stream ON` line and zero sends).
- Repeated identical NO_TRADE reasons produce no repeat messages; a
  changed reason produces exactly one new message.
- Full gate green: lint 13/13, build 13/13, 882 contract + 12 property.
