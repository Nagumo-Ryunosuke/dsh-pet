import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { openSoulDatabase, ProactiveStore } from '@deepseek-pet/soul';
import { LockStore } from '../lock.ts';
import { commitProactiveDecision } from './proactive-runner.ts';

const snapshot = {
  enabled: true,
  visible: true,
  sleeping: false,
  doNotDisturb: false,
  paused: false,
  busy: false,
  revision: 7,
};
const gates = {
  enabled: true,
  hidden: false,
  sleeping: false,
  doNotDisturb: false,
  paused: false,
  busy: false,
  revision: 7,
};

test('ready decision is claimed and committed through the host gate once', async () => {
  const db = openSoulDatabase({ file: ':memory:' });
  try {
    const store = new ProactiveStore(db);
    store.addIntention(
      {
        id: 'i',
        petId: 'p',
        origin: 'user',
        sourceId: 's',
        goal: '提醒',
        nextStep: '问候',
        dueAt: 1,
        expiresAt: 10000,
      },
      0,
    );
    const result = await store.decide(
      'p',
      { complete: async () => ({ text: '{"act":"say","text":"你好"}' }) },
      () => gates,
      1000,
      () => 1000,
    );
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;
    let writes = 0;
    const deps = {
      now: () => 1000,
      snapshot: () => snapshot,
      lock: new LockStore({ now: () => 1000 }),
      animations: () => [],
      display: () => {
        writes++;
      },
    };
    assert.deepEqual(commitProactiveDecision(store, deps, result.decision), { status: 'displayed' });
    assert.deepEqual(commitProactiveDecision(store, deps, result.decision), { status: 'blocked' });
    assert.equal(writes, 1);
  } finally {
    db.close();
  }
});

test('sleep after the model returns discards without displaying', async () => {
  const db = openSoulDatabase({ file: ':memory:' });
  try {
    const store = new ProactiveStore(db);
    store.addIntention(
      {
        id: 'i',
        petId: 'p',
        origin: 'user',
        sourceId: 's',
        goal: '提醒',
        nextStep: '问候',
        dueAt: 1,
        expiresAt: 10000,
      },
      0,
    );
    const result = await store.decide(
      'p',
      { complete: async () => ({ text: '{"act":"say","text":"你好"}' }) },
      () => gates,
      1000,
      () => 1000,
    );
    if (result.status !== 'ready') throw new Error('expected a ready decision');
    let writes = 0;
    const deps = {
      now: () => 1000,
      snapshot: () => ({ ...snapshot, sleeping: true }),
      lock: new LockStore({ now: () => 1000 }),
      animations: () => [],
      display: () => {
        writes++;
      },
    };
    assert.deepEqual(commitProactiveDecision(store, deps, result.decision), { status: 'blocked' });
    assert.equal(writes, 0);
    assert.equal(store.claimDisplay(result.decision, gates, 1000), false);
  } finally {
    db.close();
  }
});
