import type { QqAccountObservation } from '@deepseek-pet/soul';

/**
 * Identity is populated only by the configured QQ adapter after its gateway
 * handshake. This local cache is not proof that the gateway is connected to
 * an actual QQ session; it inherits the configured gateway's trust boundary.
 */
export function createQqOwnerObservation(petId: string) {
  let accountId: string | null = null;
  let disposed = false;
  return {
    observe(requestedPet: string): QqAccountObservation {
      return !disposed && requestedPet === petId && accountId !== null
        ? { state: 'authenticated', accountId }
        : { state: 'offline' };
    },
    update(value: string | null): void {
      if (disposed) return;
      accountId = typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) ? value : null;
    },
    dispose(): void {
      disposed = true;
      accountId = null;
    },
  };
}
