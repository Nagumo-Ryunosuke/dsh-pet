import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { LockStore } from '../lock.ts';
import { displayProactive, type ProactiveDisplaySnapshot } from './proactive-display.ts';

const ready: ProactiveDisplaySnapshot = {
  enabled: true,
  visible: true,
  sleeping: false,
  doNotDisturb: false,
  paused: false,
  busy: false,
  revision: 1,
};
const action = { petId: 'pet', expectedRevision: 1, expiresAt: 2000, text: '你好', animation: 'wave' };

test('proactive display is quiet for sleep, DND and disabled states', () => {
  for (const state of [
    { ...ready, sleeping: true },
    { ...ready, doNotDisturb: true },
    { ...ready, enabled: false },
  ]) {
    let writes = 0;
    const lock = new LockStore({ now: () => 1000 });
    assert.equal(
      displayProactive(
        {
          now: () => 1000,
          snapshot: () => state,
          lock,
          animations: () => ['wave'],
          display: () => {
            writes++;
          },
        },
        action,
      ).ok,
      false,
    );
    assert.equal(writes, 0);
    assert.equal(lock.locked('pet'), false);
  }
});

test('rechecks user interruption and sleep after taking lock', () => {
  for (const next of [
    { ...ready, sleeping: true },
    { ...ready, revision: 2 },
  ]) {
    let reads = 0;
    let writes = 0;
    const lock = new LockStore({ now: () => 1000 });
    const result = displayProactive(
      {
        now: () => 1000,
        snapshot: () => (++reads === 1 ? ready : next),
        lock,
        animations: () => ['wave'],
        display: () => {
          writes++;
        },
      },
      action,
    );
    assert.deepEqual(result, { ok: false, reason: 'blocked' });
    assert.equal(writes, 0);
    assert.equal(lock.locked('pet'), false);
  }
});

test('refuses expired, unknown animations and preempted leases', () => {
  const lock = new LockStore({ now: () => 1000 });
  let writes = 0;
  const deps = {
    now: () => 1000,
    snapshot: () => ready,
    lock,
    animations: () => ['wave'],
    display: () => {
      writes++;
    },
  };
  assert.deepEqual(displayProactive(deps, { ...action, expiresAt: 1000 }), { ok: false, reason: 'expired' });
  assert.deepEqual(displayProactive(deps, { ...action, animation: 'unknown' }), { ok: false, reason: 'invalid' });
  let reads = 0;
  const result = displayProactive(
    {
      ...deps,
      snapshot: () => {
        if (++reads === 2) lock.release({ petId: 'pet', force: true });
        return ready;
      },
    },
    action,
  );
  assert.deepEqual(result, { ok: false, reason: 'preempted' });
  assert.equal(writes, 0);
});

test('commits once and releases the lease', () => {
  const lock = new LockStore({ now: () => 1000 });
  let writes = 0;
  const result = displayProactive(
    {
      now: () => 1000,
      snapshot: () => ready,
      lock,
      animations: () => ['wave'],
      display: () => {
        writes++;
      },
    },
    action,
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(writes, 1);
  assert.equal(lock.locked('pet'), false);
});
