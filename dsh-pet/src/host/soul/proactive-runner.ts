/** Bridges a ready soul decision to the synchronous host display gate. */
import type { ProactiveGates, ReadyDecision } from '@deepseek-pet/soul';
import {
  displayProactive,
  type ProactiveDisplayDependencies,
  type ProactiveDisplaySnapshot,
} from './proactive-display.ts';

type ProactiveReceiptStore = {
  claimDisplay(decision: ReadyDecision, gates: ProactiveGates, now?: number): boolean;
  acknowledgeShown(decision: ReadyDecision): boolean;
  discardDecision(
    decision: ReadyDecision,
    reason: 'host-gate' | 'user-interrupted' | 'expired' | 'display-failed',
    now?: number,
  ): boolean;
};

function soulGates(state: ProactiveDisplaySnapshot): ProactiveGates {
  return {
    enabled: state.enabled,
    sleeping: state.sleeping,
    doNotDisturb: state.doNotDisturb,
    paused: state.paused,
    hidden: !state.visible,
    busy: state.busy,
    revision: state.revision,
  };
}

/**
 * A ready decision is never replayed after a denied display. A claim conservatively
 * counts against budget even when a later display or receipt write fails.
 */
export function commitProactiveDecision(
  store: ProactiveReceiptStore,
  deps: ProactiveDisplayDependencies,
  decision: ReadyDecision,
): { status: 'displayed' | 'displayed-receipt-unknown' | 'blocked' | 'failed' } {
  let displayAttempted = false;
  try {
    const result = displayProactive(
      {
        ...deps,
        claim: () => store.claimDisplay(decision, soulGates(deps.snapshot(decision.petId)), deps.now()),
        display: (action) => {
          displayAttempted = true;
          deps.display(action);
        },
      },
      {
        petId: decision.petId,
        expectedRevision: decision.gateRevision,
        expiresAt: decision.expiresAt,
        text: decision.text,
        ...(decision.animation === undefined ? {} : { animation: decision.animation }),
      },
    );
    if (!result.ok) {
      store.discardDecision(decision, result.reason === 'expired' ? 'expired' : 'host-gate', deps.now());
      return { status: 'blocked' };
    }
    return { status: store.acknowledgeShown(decision) ? 'displayed' : 'displayed-receipt-unknown' };
  } catch {
    if (displayAttempted) return { status: 'displayed-receipt-unknown' };
    try {
      store.discardDecision(decision, 'display-failed', deps.now());
    } catch {
      // The claim may already have been persisted; do not retry this decision.
    }
    return { status: 'failed' };
  }
}
