# Runtime Mode Hot-Reload & Dynamic Watcher Design

> **Polyroot enforces fail-closed execution modes (PAPER, SHADOW, MICRO_LIVE, LIVE). Operational safety requires an immediate live kill-switch or mode-switching capability without restarting the Node.js process. This design introduces a database-driven dynamic mode watcher with atomic transition validation, fail-closed offline fallback, and zero-downtime hot-reload.**

**Goal:** Enable runtime mode switches (PAPER ↔ SHADOW ↔ MICRO_LIVE ↔ LIVE) driven by PostgreSQL `live_guard_state`, polled by a background watcher with fail-closed fallback to READ_ONLY on DB partition.

**Approach:** Extend `live_guard_state` with `runtime_mode` and `mode_updated_at`. Introduce `ModeWatcher` in `@polyroot/runtime` that provides a reactive `getMode(): RuntimeMode` callback to the executor/orchestrator loop.

---

## Global Constraints

*   **Zero new external dependencies:** Uses existing `pg` Pool and native `node:events` / intervals.
*   **Fail-closed on connection loss:** If polling DB fails for 3 consecutive intervals (15 seconds), mode automatically degrades to `READ_ONLY` / `UNKNOWN` to block any order submission.
*   **Emergency Kill-Switch (Immediate Downgrade):** Downgrading (`LIVE` → `PAPER` or `READ_ONLY`) is ALWAYS permitted and immediate.
*   **Promotion Guard (Hard Policy):** Upgrading from `PAPER`/`SHADOW` to `LIVE`/`MICRO_LIVE` via database requires `halted = FALSE` and passing bounds/preflight. If `halted = TRUE`, the upgrade is rejected and stays in current mode.
*   **Audit Trail:** Every mode change emits a structured log and updates `mode_updated_at`.

---

## Data Model & Migration

**Migration file:** `migrations/0022_runtime_mode_hot_reload.sql`

```sql
-- Migration 0022: Runtime Mode Hot-Reload column on live_guard_state
ALTER TABLE live_guard_state
  ADD COLUMN IF NOT EXISTS runtime_mode TEXT NOT NULL DEFAULT 'PAPER',
  ADD COLUMN IF NOT EXISTS mode_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE live_guard_state
  SET runtime_mode = 'PAPER', mode_updated_at = now()
  WHERE key = 'micro-live' AND runtime_mode IS NULL;
```

---

## Core Components

### 1. `ModeWatcher` (`src/pm/runtime/src/mode-watcher.ts`)

```typescript
export type RuntimeMode = "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE";

export interface ModeWatcherOptions {
  pool: QueryablePool;
  pollIntervalMs?: number; // default: 5000ms
  maxFailuresBeforeDegrade?: number; // default: 3
  initialMode?: RuntimeMode;
  onModeChange?: (from: RuntimeMode, to: RuntimeMode, reason: string) => void;
  onDegrade?: (reason: string) => void;
}
```

*   `start()`: Memulai `setInterval` polling `SELECT runtime_mode, halted FROM live_guard_state WHERE key = 'micro-live'`.
*   `stop()`: Membersihkan timer (clean shutdown).
*   `getMode(): RuntimeMode`: Mengembalikan mode aktif saat ini (O(1) memory read).
*   `isOperational(): boolean`: Mengembalikan `true` jika polling sehat, `false` jika sedang degraded.
*   `requestModeChange(newMode: RuntimeMode, operator: string): Promise<Result>`: Melakukan `UPDATE` ke database setelah validasi guard.

### 2. Integrasi ke `G4Loop` & `Orchestrator`

Mengganti dependency mode statis dengan fungsi dynamic getter `getMode: () => RuntimeMode` pada setiap evaluasi loop, bukan nilai tetap saat proses dimulai.

---

## Testing Plan (TDD)

1.  **Contract Tests (`tests/pm/contracts/mode-watcher.test.ts`)**:
    *   Menguji polling awal memuat mode dari DB.
    *   Menguji perubahan nilai DB memicu callback `onModeChange`.
    *   Menguji downgrade darurat (`LIVE` → `PAPER`) langsung efektif pada `getMode()`.
    *   Menguji kegagalan koneksi DB 3x berturut-turut memicu degrade fail-closed.
    *   Menguji pemulihan koneksi DB mengembalikan mode dari database.
2.  **Property / Invariant Tests**:
    *   Memastikan tidak ada kondisi balapan (race condition) pada pembacaan `getMode()`.
