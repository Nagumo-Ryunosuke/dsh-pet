import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startOwnerUiBeforeHelper } from './owner-ui-lifecycle.ts';

test('unloading while the local service starts closes it without starting helper', async () => {
  let resolve!: (value: { close(): void }) => void;
  const starting = new Promise<{ close(): void }>((done) => {
    resolve = done;
  });
  let disposed = false,
    closed = 0,
    started = 0,
    ready = 0;
  const pending = startOwnerUiBeforeHelper({
    startUi: () => starting,
    disposed: () => disposed,
    ready: () => {
      ready += 1;
    },
    startHelper: () => {
      started += 1;
    },
    failed: () => assert.fail(),
  });
  disposed = true;
  resolve({
    close: () => {
      closed += 1;
    },
  });
  await pending;
  assert.deepEqual({ closed, started, ready }, { closed: 1, started: 0, ready: 0 });
});

test('ready failure closes the UI and never starts the helper', async () => {
  let closed = 0,
    started = 0,
    failed = 0;
  await startOwnerUiBeforeHelper({
    startUi: async () => ({
      close: () => {
        closed += 1;
      },
    }),
    disposed: () => false,
    ready: () => {
      throw new Error('ready');
    },
    startHelper: () => {
      started += 1;
    },
    failed: () => {
      failed += 1;
    },
  });
  assert.deepEqual({ closed, started, failed }, { closed: 1, started: 0, failed: 1 });
});

test('helper failure closes the UI and does not retry', async () => {
  let closed = 0,
    started = 0,
    failed = 0;
  await startOwnerUiBeforeHelper({
    startUi: async () => ({
      close: () => {
        closed += 1;
      },
    }),
    disposed: () => false,
    ready: () => {},
    startHelper: () => {
      started += 1;
      throw new Error('helper');
    },
    failed: () => {
      failed += 1;
    },
  });
  assert.deepEqual({ closed, started, failed }, { closed: 1, started: 1, failed: 1 });
});

test('service failure attempts the helper at most once even if it throws', async () => {
  let started = 0,
    failed = 0;
  await startOwnerUiBeforeHelper({
    startUi: async (): Promise<{ close(): void }> => {
      throw new Error('listen');
    },
    disposed: () => false,
    ready: () => assert.fail(),
    startHelper: () => {
      started += 1;
      throw new Error('helper');
    },
    failed: () => {
      failed += 1;
    },
  });
  assert.deepEqual({ started, failed }, { started: 1, failed: 2 });
});
