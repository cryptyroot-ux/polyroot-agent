/**
 * @polyroot/observability — System status board (Phase 27, PRD §5.3/§5.4).
 *
 * Three orthogonal signals, never merged into one "all good" boolean:
 *
 *   SystemHealth — READY | PAUSED | DEGRADED | BLOCKED | RECOVERING
 *   VenueMode    — NORMAL | POST_ONLY | CANCEL_ONLY | READ_ONLY | ...
 *   AccountMode  — NORMAL | CLOSE_ONLY | BANNED | AUTH_INVALID | UNKNOWN
 *
 * Plus: alerts with owner + severity + dedupe + incident link, and an
 * unconfirmed-action list that is always surfaced — the dashboard must
 * show what is NOT confirmed without ever declaring it safe.
 */

export type SystemHealth = "READY" | "PAUSED" | "DEGRADED" | "BLOCKED" | "RECOVERING";

export interface SystemStatus {
  systemHealth: SystemHealth;
  venueMode: string;
  accountMode: string;
  /** Worst-of rollup for at-a-glance display; details stay split above. */
  overall: "OK" | "ATTENTION" | "HALTED";
  note: string;
}

const HALTED_HEALTH: readonly SystemHealth[] = ["BLOCKED"];
const ATTENTION_HEALTH: readonly SystemHealth[] = ["PAUSED", "DEGRADED", "RECOVERING"];
const HALTED_VENUE = ["UNAVAILABLE", "UNKNOWN"];
const HALTED_ACCOUNT = ["BANNED", "AUTH_INVALID", "UNKNOWN"];

/**
 * Combine the three streams. Each stays visible; `overall` is only a
 * rollup: any HALTED signal halts, any ATTENTION signal attends.
 */
export function systemStatus(input: {
  systemHealth: SystemHealth;
  venueMode: string;
  accountMode: string;
}): SystemStatus {
  const { systemHealth, venueMode, accountMode } = input;
  if (
    (HALTED_HEALTH as readonly string[]).includes(systemHealth) ||
    HALTED_VENUE.includes(venueMode) ||
    HALTED_ACCOUNT.includes(accountMode)
  ) {
    return {
      systemHealth,
      venueMode,
      accountMode,
      overall: "HALTED",
      note: `halted: health=${systemHealth} venue=${venueMode} account=${accountMode}`,
    };
  }
  if (
    (ATTENTION_HEALTH as readonly string[]).includes(systemHealth) ||
    venueMode !== "NORMAL" ||
    accountMode !== "NORMAL"
  ) {
    return {
      systemHealth,
      venueMode,
      accountMode,
      overall: "ATTENTION",
      note: `attention: health=${systemHealth} venue=${venueMode} account=${accountMode}`,
    };
  }
  return {
    systemHealth,
    venueMode,
    accountMode,
    overall: "OK",
    note: "ready/normal/normal",
  };
}

/* ─── Alerts: owner + severity + dedupe + incident link ───────────────── */

export type AlertSeverity = "INFO" | "WARN" | "CRITICAL";

export interface AlertSpec {
  metric: string;
  value: number;
  threshold: number;
  owner: string;
  severity: AlertSeverity;
  incidentId?: string;
}

export interface RaisedAlert extends AlertSpec {
  dedupeKey: string;
  raisedAt: Date;
}

export class StatusBoardAlerts {
  private readonly open = new Map<string, RaisedAlert>();

  /**
   * Raise an alert when value breaches threshold. Re-breaches while open
   * dedupe to the SAME alert (same key, original timestamp) instead of
   * spamming; a new incident link re-opens explicitly.
   */
  raise(
    spec: AlertSpec,
    now: Date = new Date(),
  ): { fired: boolean; alert: RaisedAlert | null } {
    if (!(spec.value > spec.threshold)) return { fired: false, alert: null };
    if (!spec.owner) {
      throw new Error("alerts require an owner");
    }
    const dedupeKey = `${spec.metric}|${spec.threshold}|${spec.severity}`;
    const existing = this.open.get(dedupeKey);
    if (existing && existing.incidentId === spec.incidentId) {
      return { fired: false, alert: existing };
    }
    const alert: RaisedAlert = { ...spec, dedupeKey, raisedAt: now };
    this.open.set(dedupeKey, alert);
    return { fired: true, alert };
  }

  resolve(dedupeKey: string): boolean {
    return this.open.delete(dedupeKey);
  }

  listOpen(): RaisedAlert[] {
    return [...this.open.values()];
  }
}

/* ─── Unconfirmed actions: surfaced, never declared safe ──────────────── */

export interface UnconfirmedAction {
  id: string;
  kind: string;
  since: Date;
}

/**
 * Render the unconfirmed-action list for the dashboard. Every entry is
 * shown with its age and an explicit NOT-CONFIRMED marker — the function
 * has no "all clear" return: an empty list reports zero unconfirmed, not
 * safety.
 */
export function unconfirmedActions(actions: UnconfirmedAction[], now: Date = new Date()): {
  count: number;
  lines: string[];
} {
  const lines = actions.map(
    (a) =>
      `NOT-CONFIRMED ${a.kind} ${a.id} (open ${Math.max(0, now.getTime() - a.since.getTime())}ms)`,
  );
  return { count: actions.length, lines };
}
