# Telegram Digest Redesign Design

**Date**: 2026-10-01
**Status**: Approved
**Problem**: 234 messages/hour spam, unclear reports, raw market IDs

## Problem Analysis

Current PolyRoot agent spams Telegram with individual NO_TRADE reports. Data from VPS logs shows:
- 234 messages in 1 hour (rate capped at 30/min)
- Every NO_TRADE triggers full market report
- Portfolio balance repeated in every message
- Raw market IDs like `35097…48126` shown instead of clean names
- Technical jargon: "TIGHT_CONSENSUS (untradeable as taker)"

## Solution: Batched Digest + Trade Alerts

### Core Principles
1. **Reduce volume**: 234 → ~4 messages/hour (94% reduction)
2. **Focus on value**: Trade alerts instant, summaries batched
3. **Clean format**: Human-friendly, no technical jargon
4. **Context preservation**: Show what was evaluated, not just what failed

### Message Types

**A. Batched Digest** (every 15 minutes)
```
14:30 UTC · SHADOW
Scanned 12 | gates passed 2 | trades 0

Markets evaluated:
• Bitcoin >$100k 2026 [YES] — edge 1.2% (floor 1.0%)
• Fed cut Sept [NO] — spread 1¢, too tight

Portfolio: $100.00 | PnL $0.00 | Exposure $0.00
```

**B. Trade Alert** (instant on trade execution)
```
🚀 TRADE · Bitcoin >$100k 2026 [YES]
Beli 42 shares @ $0.55 = $23.10
AI 67% · edge +12.0% (floor 1.0%)
Alasan: tren naik, inflow ETF melambat

Portfolio: $100.00 | PnL $0.00 | Exposure $23.10
```

**C. Risk Gate Alert** (instant on gate state change)
```
🔒 RISK_GATE [RISK_FEE_RATE] (mode PRODUCER) — no exposure
```

### Data Structures

**AgentStreamEvent Types**:
- `"PASS_DIGEST"` - batched summary
- `"TRADE"` - instant trade execution alert
- `"RISK_GATE"` - risk gate state change
- `"ERROR"` - critical errors only

**Summary Metadata**:
- `scanned`: total markets evaluated
- `gates_passed`: markets that passed risk gates
- `trades`: number of trades executed
- `portfolio`: current portfolio summary

### Implementation Scope

**Files to modify**:
1. `src/pm/observability/src/telegram-stream.ts` - Add format functions, update event types
2. `src/pm/runtime/src/main.ts` - Wire digest scheduling, trade alerts, risk gate alerts
3. `tests/pm/contracts/telegram-stream-v2.test.ts` - Update tests for new format

**New functions**:
- `formatDigest()` - batched summary message
- `formatTradeAlert()` - instant trade notification
- `formatRiskGateAlert()` - risk gate change notification

**Modified logic**:
- `onUniversePass` hook - throttle to 15-minute intervals
- `emitStepComplete` - route trade decisions to TRADE events
- Portfolio summary - collect once per digest, not per market

### Success Criteria

1. Message volume < 5/hour (excluding trade alerts)
2. Trade alerts sent instantly (< 1 second after execution)
3. No raw market IDs in any message
4. Portfolio summary appears only in digests, not every market report
5. All existing tests pass (891+ tests)
6. No regression in trade execution logic

### Non-Goals

- No changes to trading logic, risk gates, or forecast provider
- No changes to database schema or persistence
- No changes to CLI commands or onboarding
- No changes to market discovery or scoring

### Rollout Plan

1. Implement formatters + tests
2. Wire into runtime with 15-minute throttle
3. Deploy to VPS
4. Monitor message volume for 24 hours
5. Adjust throttle interval if needed (configurable via env var)

### Configuration

Add environment variable:
```bash
POLYROOT_DIGEST_INTERVAL_MINUTES=15  # Default: 15
```

### Testing Strategy

**Unit tests**:
- `formatDigest()` produces expected output for various scan results
- `formatTradeAlert()` includes all required fields
- `formatRiskGateAlert()` formats gate changes correctly
- Throttle logic prevents duplicate digests within interval

**Integration tests**:
- Verify digest scheduler emits at correct intervals
- Verify trade alerts bypass digest throttle
- Verify risk gate alerts send immediately on state change

### Dependencies

- Existing TelegramStreamEmitter class
- Existing formatPassDigest, formatMarketReport functions
- Existing g4-core pipeline onUniversePass hook
- Existing emitStepComplete, emitFinancialGate callbacks

### Timeline

- Implementation: 2-3 hours
- Testing: 1 hour
- Deployment: 30 minutes
- Monitoring: 24 hours
