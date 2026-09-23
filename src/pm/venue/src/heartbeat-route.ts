/**
 * @polyroot/venue — Heartbeat route contracts (CT-21, CT-22).
 *
 *   CT-21 route — heartbeat POST carries method, path, auth and the body
 *           with the previous heartbeat id carried forward; an invalid or
 *           missing id recovers by re-establishing (never by guessing).
 *   CT-22 lifetime/scope — heartbeat ids have a TTL; coverage is explicit
 *           (accounts + orders); two writers on one id collide; a restart
 *           re-establishes instead of resuming the old id.
 *
 * Pure request builders/validators (no I/O): the adapter sends what these
 * contracts accept.
 */

export interface HeartbeatRequest {
  method: "POST";
  path: "/v1/heartbeats";
  auth: string;
  body: {
    heartbeat_id?: string;
    accounts: string[];
    orderIds: string[];
  };
}

export type HeartbeatBuildResult =
  | { ok: true; request: HeartbeatRequest }
  | { ok: false; code: "HEARTBEAT_INVALID"; reason: string };

/**
 * CT-21: build a heartbeat request. Auth is required; the previous id is
 * carried forward when known. An explicitly invalid id (empty string)
 * recovers via re-establish instead of being sent.
 */
export function buildHeartbeatRequest(input: {
  auth: string;
  previousId?: string | null;
  accounts?: string[];
  orderIds?: string[];
}): HeartbeatBuildResult {
  if (!input.auth) {
    return {
      ok: false,
      code: "HEARTBEAT_INVALID",
      reason: "heartbeat requires auth",
    };
  }
  const body: HeartbeatRequest["body"] = {
    accounts: input.accounts ?? [],
    orderIds: input.orderIds ?? [],
  };
  if (input.previousId !== undefined && input.previousId !== null) {
    if (input.previousId.length === 0) {
      return {
        ok: false,
        code: "HEARTBEAT_INVALID",
        reason: "empty heartbeat id: re-establish instead of sending",
      };
    }
    body.heartbeat_id = input.previousId;
  }
  return {
    ok: true,
    request: { method: "POST", path: "/v1/heartbeats", auth: input.auth, body },
  };
}

export type HeartbeatScopeResult =
  | { ok: true; note: string }
  | {
      ok: false;
      code:
        | "HEARTBEAT_EXPIRED"
        | "HEARTBEAT_WRITER_CONFLICT"
        | "HEARTBEAT_SCOPE_EMPTY";
      reason: string;
    };

/**
 * CT-22: lifetime and scope. Expired ids, second writers, and empty
 * coverage (no accounts AND no orders) all refuse — a heartbeat that
 * covers nothing proves nothing.
 */
export function checkHeartbeatScope(input: {
  issuedAt: Date | string;
  ttlMs: number;
  writerId: string;
  expectedWriterId: string;
  accountCount: number;
  orderCount: number;
  now?: Date;
}): HeartbeatScopeResult {
  const now = input.now ?? new Date();
  const issued =
    input.issuedAt instanceof Date ? input.issuedAt : new Date(input.issuedAt);
  if (Number.isNaN(issued.getTime()) || !(input.ttlMs > 0)) {
    return {
      ok: false,
      code: "HEARTBEAT_EXPIRED",
      reason: "invalid heartbeat timing measurement",
    };
  }
  if (now.getTime() - issued.getTime() > input.ttlMs) {
    return {
      ok: false,
      code: "HEARTBEAT_EXPIRED",
      reason: "heartbeat id expired; re-establish after restart",
    };
  }
  if (input.writerId !== input.expectedWriterId) {
    return {
      ok: false,
      code: "HEARTBEAT_WRITER_CONFLICT",
      reason: `writer ${input.writerId} is not the expected ${input.expectedWriterId}`,
    };
  }
  if (input.accountCount <= 0 && input.orderCount <= 0) {
    return {
      ok: false,
      code: "HEARTBEAT_SCOPE_EMPTY",
      reason: "heartbeat covers no accounts and no orders",
    };
  }
  return { ok: true, note: "heartbeat live with explicit coverage" };
}
