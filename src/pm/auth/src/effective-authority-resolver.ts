/**
 * @polyroot/auth — Effective Authority Resolver (P0-8).
 * Ensures correct authorization lineage, attenuation, and scope composition.
 */

export interface AuthorityNode {
  id: string;
  parentId?: string;
  allowedDomains: string[];
  maxNotionalBase: bigint;
  policyVersion: string;
}

export interface EffectiveAuthContext {
  identity: string;
  lineage: AuthorityNode[];
}

export interface AuthResolutionResult {
  ok: boolean;
  code?: string;
  reason?: string;
  effectiveMaxNotional: bigint;
  effectiveDomains: string[];
}

export class EffectiveAuthorityResolver {
  /**
   * Resolves the effective authority by walking the lineage chain upwards,
   * applying strict attenuation (child max <= parent max, domains intersect).
   */
  resolve(
    context: EffectiveAuthContext,
    targetDomain: string,
    requestedNotional: bigint,
  ): AuthResolutionResult {
    if (!context.lineage || context.lineage.length === 0) {
      return {
        ok: false,
        code: "EMPTY_LINEAGE",
        reason: "Authority lineage is empty or undefined",
        effectiveMaxNotional: 0n,
        effectiveDomains: [],
      };
    }

    let currentMax = context.lineage[0].maxNotionalBase;
    let currentDomains = new Set(context.lineage[0].allowedDomains);

    for (let i = 0; i < context.lineage.length; i++) {
      const node = context.lineage[i];

      // Attenuation check: node cannot exceed parent's allowance if parent exists
      if (i > 0) {
        const parent = context.lineage[i - 1];
        if (node.maxNotionalBase > parent.maxNotionalBase) {
          return {
            ok: false,
            code: "ATTENUATION_VIOLATION",
            reason: `Node ${node.id} notional (${node.maxNotionalBase}) exceeds parent ${parent.id} (${parent.maxNotionalBase})`,
            effectiveMaxNotional: 0n,
            effectiveDomains: [],
          };
        }
      }

      currentMax =
        node.maxNotionalBase < currentMax ? node.maxNotionalBase : currentMax;

      const nodeDomainSet = new Set(node.allowedDomains);
      currentDomains = new Set(
        [...currentDomains].filter((d) => nodeDomainSet.has(d)),
      );
    }

    if (!currentDomains.has(targetDomain)) {
      return {
        ok: false,
        code: "DOMAIN_NOT_ALLOWED",
        reason: `Target domain '${targetDomain}' is not permitted by effective authority lineage`,
        effectiveMaxNotional: currentMax,
        effectiveDomains: Array.from(currentDomains),
      };
    }

    if (requestedNotional > currentMax) {
      return {
        ok: false,
        code: "EXCEEDS_EFFECTIVE_NOTIONAL",
        reason: `Requested notional ${requestedNotional} exceeds effective max ${currentMax}`,
        effectiveMaxNotional: currentMax,
        effectiveDomains: Array.from(currentDomains),
      };
    }

    return {
      ok: true,
      effectiveMaxNotional: currentMax,
      effectiveDomains: Array.from(currentDomains),
    };
  }
}
