/**
 * Parameterized permission checks (SECURITY_AND_PERMISSIONS, permission.schema.json).
 *
 * Two operations matter:
 *  - `check`: does this grant set authorize this action at this scope?
 *  - `isSubset`: are a worker's grants within the manager's own? (least authority,
 *    CONTRACT_TESTS #5) — enforced when a delegation is created.
 */
import { resolve, sep } from "node:path";
import type { Permission, PermissionKind, PermissionScope } from "../domain/types.ts";

export type CheckRequest = {
  kind: PermissionKind;
  path?: string;
  host?: string;
  cost_usd?: number;
};

export type CheckResult = { allowed: boolean; reason?: string; grant?: Permission };

const norm = (p: string): string => resolve(p);

/** True when `child` is the same as or nested under `parent`. */
export function pathWithin(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

function hostAllowed(host: string, allow: string[]): boolean {
  return allow.some((a) => a === host || (a.startsWith("*.") && host.endsWith(a.slice(1))));
}

export function check(grants: Permission[], req: CheckRequest): CheckResult {
  const candidates = grants.filter((g) => g.kind === req.kind);
  if (candidates.length === 0) return { allowed: false, reason: `no grant for ${req.kind}` };

  for (const g of candidates) {
    const s: PermissionScope = g.scope ?? {};
    if (req.path !== undefined) {
      const roots = s.paths ?? [];
      if (!roots.some((root) => pathWithin(req.path as string, root))) continue;
    }
    if (req.host !== undefined) {
      if (s.unrestricted !== true && !hostAllowed(req.host, s.allow ?? [])) continue;
    }
    if (req.cost_usd !== undefined && s.budget_usd_per_day !== undefined) {
      if (req.cost_usd > s.budget_usd_per_day) continue;
    }
    return { allowed: true, grant: g };
  }
  return { allowed: false, reason: `${req.kind} not granted for the requested scope` };
}

const NUMERIC_SCOPE_KEYS = [
  "budget_usd_per_day",
  "max_tokens_per_execution",
  "max_concurrent",
] as const;

/** Scope-level containment used by `isSubset`. */
function scopeWithin(child: PermissionScope | undefined, parent: PermissionScope | undefined): boolean {
  const c = child ?? {};
  const p = parent ?? {};

  if (p.paths && !c.paths) return false;
  if (c.paths) {
    if (!p.paths) return false;
    if (!c.paths.every((cp) => p.paths!.some((pp) => pathWithin(cp, pp)))) return false;
  }
  if (c.unrestricted && !p.unrestricted) return false;
  if (p.allow && p.unrestricted !== true && !c.allow && !c.unrestricted) return false;
  if (c.allow) {
    if (p.unrestricted !== true) {
      if (!p.allow) return false;
      if (!c.allow.every((h) => hostAllowed(h, p.allow!))) return false;
    }
  }
  for (const key of NUMERIC_SCOPE_KEYS) {
    const cv = c[key];
    const pv = p[key];
    // An omitted numeric ceiling means unlimited authority. A constrained parent may
    // therefore delegate only an explicit equal-or-lower ceiling; an unconstrained
    // parent may still narrow the worker by supplying one.
    if (pv !== undefined && (cv === undefined || cv > pv)) return false;
    // Unlike the other numeric ceilings, an absent daily budget is replaced at runtime by
    // a platform default. Without that value here, an explicit child cap cannot be proven
    // narrower than the parent's effective cap, so fail closed.
    if (key === "budget_usd_per_day" && pv === undefined && cv !== undefined) return false;
  }
  for (const key of ["backend", "policy"] as const) {
    // These selectors are recorded rather than operationally enforced today, but they
    // still describe authority. Omitting or changing a selector constrained by the
    // parent would broaden the delegated grant.
    if (p[key] !== undefined && c[key] !== p[key]) return false;
  }
  return true;
}

/**
 * True when every grant in `child` is held by `parent` at an equal or narrower scope.
 * A worker grant exceeding the manager's is rejected at delegation time.
 */
export function isSubset(child: Permission[], parent: Permission[]): { ok: boolean; offending?: Permission } {
  for (const c of child) {
    const matches = parent.filter((p) => p.kind === c.kind);
    if (matches.length === 0) return { ok: false, offending: c };
    if (!matches.some((p) => scopeWithin(c.scope, p.scope))) return { ok: false, offending: c };
  }
  return { ok: true };
}

export function describe(p: Permission): string {
  const s = p.scope;
  if (!s) return p.kind;
  const bits: string[] = [];
  if (s.paths) bits.push(`paths=${s.paths.join(",")}`);
  if (s.allow) bits.push(`allow=${s.allow.join(",")}`);
  if (s.unrestricted) bits.push("unrestricted");
  if (s.budget_usd_per_day !== undefined) bits.push(`$${s.budget_usd_per_day}/day`);
  if (s.max_concurrent !== undefined) bits.push(`max=${s.max_concurrent}`);
  return bits.length ? `${p.kind}(${bits.join(" ")})` : p.kind;
}
