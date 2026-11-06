import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { QqOwnerBindingService, openSoulDatabase } from '@deepseek-pet/soul';
import { createQqOwnerObservation } from '../host/qq/owner-observation.ts';
import { createQqOwnerControl, createQqOwnerControlSlot } from './qq-owner-control.ts';
import { createRequestSecurity } from './request-security.ts';
import { listenStandaloneServer } from './server.ts';

// The gateway is a separately built sibling project, not a production dependency.
const gatewayPath = fileURLToPath(
  new URL('../../../../deepseek-pet-qq-gateway/packages/dsh-plugin/dist/index.js', import.meta.url),
);

test(
  '模拟驱动离线后 WebSocket 仍连接，但主人设置不可修改',
  { skip: !existsSync(gatewayPath) && 'build sibling QQ gateway first' },
  async () => {
    const base = '../../../../deepseek-pet-qq-gateway/packages/';
    const gatewayModule = await import(new URL(base + 'gateway/dist/index.js', import.meta.url).href);
    const mockModule = await import(new URL(base + 'mock-driver/dist/index.js', import.meta.url).href);
    const plugin = await import(pathToFileURL(gatewayPath).href);
    const dir = mkdtempSync(join(tmpdir(), 'qq-owner-test-'));
    const driver = new mockModule.MockQqDriver({ accountId: '11' });
    const gateway = new gatewayModule.OneBotGateway({
      driver,
      token: 'test-token',
      port: 0,
      dataDir: dir,
      heartbeatIntervalMs: 0,
    });
    const observation = createQqOwnerObservation('main');
    const database = openSoulDatabase({ file: ':memory:' });
    const binding = new QqOwnerBindingService({ database, observeAccount: observation.observe });
    const security = createRequestSecurity();
    const server = await listenStandaloneServer({
      routes: [],
      logger,
      port: 0,
      security,
      qqOwner: createQqOwnerControl(binding, observation.observe, (pet) => pet === 'main'),
    });
    const { endpoint } = await gateway.start();
    const client = new plugin.OneBotClient({ url: endpoint, token: 'test-token', reconnect: { enabled: false } });
    const answer = deferred();
    let called = false;
    const adapter = new plugin.QqChannelAdapter({
      client,
      soul: {
        async respond() {
          called = true;
          return answer.promise;
        },
      },
      onVerifiedAccountChange: observation.update,
    });
    const url = `http://127.0.0.1:${server.port}/standalone-qq/owner?pet=main`;
    const headers = { 'x-dsh-pet-token': security.token, 'content-type': 'application/json' };
    const save = (ownerId: string) =>
      fetch(url, { method: 'POST', headers, body: JSON.stringify({ ownerId, expectedAccountId: '11' }) });
    try {
      await adapter.start();
      assert.equal((await save('22')).status, 200);
      driver.injectPrivate({ from: '22', text: '模拟消息' });
      for (let i = 0; i < 100 && !called; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(called, true);
      driver.goOffline();
      for (let i = 0; i < 100 && observation.observe('main').state !== 'offline'; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(client.connected, true);
      assert.equal(observation.observe('main').state, 'offline');
      assert.equal((await save('33')).status, 400);
      assert.equal(binding.state('main').binding?.ownerId, '22');
      driver.goOnline();
      answer.resolve({ text: '旧回复' });
      for (let i = 0; i < 100 && observation.observe('main').state !== 'authenticated'; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(observation.observe('main'), { state: 'authenticated', accountId: '11' });
      assert.equal(driver.sent.length, 0);
    } finally {
      await adapter.stop();
      await gateway.stop();
      await server.close();
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  '模拟网关身份确认、断线和停止传播到受保护的主人设置',
  { skip: !existsSync(gatewayPath) && 'build sibling QQ gateway first' },
  async () => {
    const { QqChannelAdapter } = await import(pathToFileURL(gatewayPath).href);
    const observation = createQqOwnerObservation('main');
    const database = openSoulDatabase({ file: ':memory:' });
    const binding = new QqOwnerBindingService({ database, observeAccount: observation.observe });
    const control = createQqOwnerControl(binding, observation.observe, (pet) => pet === 'main');
    const slot = createQqOwnerControlSlot();
    const security = createRequestSecurity();
    const server = await listenStandaloneServer({ routes: [], logger, port: 0, security, qqOwner: slot.control });
    let state = 'idle';
    let handler: ((state: string) => void) | undefined;
    let login = deferred();
    const change = (next: string) => {
      state = next;
      handler?.(next);
    };
    const client = {
      get connected() {
        return state === 'open';
      },
      onEvent() {
        return () => {};
      },
      onStateChange(fn: (state: string) => void) {
        handler = fn;
        return () => {
          handler = undefined;
        };
      },
      async start() {
        change('open');
      },
      async stop() {
        change('closed');
      },
      async call(action: string) {
        return action === 'get_login_info'
          ? login.promise
          : {
              status: 'ok',
              data: { online: true, good: true, qqgw: { account_bound_send: { protocol: 1, enforced: true } } },
            };
      },
    };
    const adapter = new QqChannelAdapter({
      client,
      soul: {
        async respond() {
          return null;
        },
      },
      onVerifiedAccountChange: observation.update,
    });
    const url = `http://127.0.0.1:${server.port}/standalone-qq/owner?pet=main`;
    const headers = { 'x-dsh-pet-token': security.token, 'content-type': 'application/json' };
    const save = (ownerId: string) =>
      fetch(url, { method: 'POST', headers, body: JSON.stringify({ ownerId, expectedAccountId: '11' }) });
    const status = async () => (await fetch(url, { headers })).json();
    try {
      assert.deepEqual(await status(), { available: false, configured: false, clearable: false });
      assert.equal((await save('22')).status, 400);
      slot.set(control);
      const starting = adapter.start();
      assert.deepEqual(await status(), { available: false, configured: false, clearable: false });
      assert.equal((await save('22')).status, 400);
      login.resolve({ status: 'ok', data: { user_id: '11' } });
      await starting;
      assert.deepEqual(await status(), { available: true, accountId: '11', configured: false, clearable: false });
      assert.equal((await save('22')).status, 200);
      assert.equal(binding.state('main').binding?.ownerId, '22');
      change('reconnecting');
      assert.deepEqual(await status(), { available: false, configured: false, clearable: true });
      assert.equal((await save('33')).status, 400);
      assert.equal(binding.state('main').binding?.ownerId, '22');
      login = deferred();
      change('open');
      login.resolve({ status: 'ok', data: { user_id: '11' } });
      await tick();
      assert.equal((await status()).available, true);
      await adapter.stop();
      assert.deepEqual(await status(), { available: false, configured: false, clearable: true });
      assert.equal((await save('33')).status, 400);
      assert.equal(binding.state('main').binding?.ownerId, '22');
      slot.set(null);
      assert.deepEqual(await status(), { available: false, configured: false, clearable: false });
      assert.equal((await save('33')).status, 400);
    } finally {
      await adapter.stop();
      observation.dispose();
      await server.close();
      database.close();
    }
  },
);
