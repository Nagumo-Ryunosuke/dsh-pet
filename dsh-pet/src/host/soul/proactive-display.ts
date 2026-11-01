/** Host-side, synchronous gate for a proposed proactive display. */
import type { LockStore } from '../lock.ts';

export interface ProactiveDisplaySnapshot {
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly sleeping: boolean;
  readonly doNotDisturb: boolean;
  readonly paused: boolean;
  readonly busy: boolean;
  /** Changes whenever a user interaction supersedes a pending proposal. */
  readonly revision: number;
}

export interface ProactiveDisplayAction {
  readonly petId: string;
  readonly expectedRevision: number;
  readonly expiresAt: number;
  readonly text: string;
  readonly animation?: string;
}

export interface ProactiveDisplayDependencies {
  readonly now: () => number;
  readonly snapshot: (petId: string) => ProactiveDisplaySnapshot;
  readonly lock: Pick<LockStore, 'acquire' | 'release' | 'gate'>;
  readonly animations: (petId: string) => readonly string[];
  /** Reserve the decision and its budget immediately before the synchronous display. */
  readonly claim?: () => boolean;
  /** Synchronous: it must commit to the existing display state before returning. */
  readonly display: (action: ProactiveDisplayAction) => void;
}

function allowed(s: ProactiveDisplaySnapshot, revision: number): boolean {
  return (
    s.enabled === true &&
    s.visible === true &&
    s.sleeping === false &&
    s.doNotDisturb === false &&
    s.paused === false &&
    s.busy === false &&
    s.revision === revision
  );
}

/**
 * The lock is obtained directly, without the HTTP endpoint that wakes sleeping pets.
 * All checks and the display commit are synchronous: no model call occurs under the lock.
 */
export function displayProactive(
  deps: ProactiveDisplayDependencies,
  action: ProactiveDisplayAction,
): { ok: true } | { ok: false; reason: 'invalid' | 'expired' | 'blocked' | 'locked' | 'preempted' } {
  if (
    !action.petId ||
    !action.text.trim() ||
    Array.from(action.text).length > 500 ||
    !Number.isFinite(action.expiresAt) ||
    !Number.isSafeInteger(action.expectedRevision) ||
    (action.animation !== undefined && !deps.animations(action.petId).includes(action.animation))
  ) {
    return { ok: false, reason: 'invalid' };
  }
  if (deps.now() >= action.expiresAt) return { ok: false, reason: 'expired' };
  if (!allowed(deps.snapshot(action.petId), action.expectedRevision)) return { ok: false, reason: 'blocked' };
  const lease = deps.lock.acquire({ petId: action.petId, ttl: 1000 });
  if (!lease.ok) return { ok: false, reason: 'locked' };
  try {
    if (deps.now() >= action.expiresAt) return { ok: false, reason: 'expired' };
    if (!allowed(deps.snapshot(action.petId), action.expectedRevision)) return { ok: false, reason: 'blocked' };
    if (!deps.lock.gate(action.petId, lease.lockId).ok) return { ok: false, reason: 'preempted' };
    if (deps.claim !== undefined && !deps.claim()) return { ok: false, reason: 'blocked' };
    if (deps.now() >= action.expiresAt) return { ok: false, reason: 'expired' };
    if (!allowed(deps.snapshot(action.petId), action.expectedRevision)) return { ok: false, reason: 'blocked' };
    if (!deps.lock.gate(action.petId, lease.lockId).ok) return { ok: false, reason: 'preempted' };
    deps.display(action);
    return { ok: true };
  } finally {
    deps.lock.release({ petId: action.petId, lockId: lease.lockId });
  }
}
