import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSoul,
  DEFAULT_PERSONA_YAML,
  openSoulDatabase,
  parsePersona,
  QqOwnerBindingService,
  type QqAccountObservation,
} from '@deepseek-pet/soul';
import { createQqOwnerControl } from './qq-owner-control.ts';
import { createRequestSecurity } from './request-security.ts';
import { listenStandaloneServer } from './server.ts';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

test('独立设置的 QQ 控制入口要求令牌与同源，并通过虚拟观察器配置同一灵魂', async () => {
  const database = openSoulDatabase({ file: ':memory:' });
  let observation: QqAccountObservation = { state: 'authenticated', accountId: '11' };
  const observe = () => observation;
  const binding = new QqOwnerBindingService({ database, observeAccount: observe });
  const control = createQqOwnerControl(binding, observe, (pet) => pet === 'main');
  const soul = createSoul({
    persona: parsePersona(DEFAULT_PERSONA_YAML),
    model: { complete: async () => ({ text: '好' }) },
    qqOwnerBinding: binding,
  });
  const security = createRequestSecurity();
  const server = await listenStandaloneServer({ routes: [], logger, port: 0, security, qqOwner: control });
  const url = `http://127.0.0.1:${server.port}/standalone-qq/owner?pet=main`;
  const headers = { 'x-dsh-pet-token': security.token, 'content-type': 'application/json' };
  const body = JSON.stringify({ ownerId: '22', expectedAccountId: '11' });
  const msg = {
    channel: 'qq' as const,
    accountId: '11',
    conversationType: 'private' as const,
    conversationId: '22',
    actorId: '22',
    text: '你好',
    messageId: '1',
    requestId: '1',
  };
  try {
    assert.equal(
      (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status,
      403,
    );
    assert.equal(
      (await fetch(url, { method: 'POST', headers: { ...headers, origin: 'http://evil.test' }, body })).status,
      403,
    );
    assert.equal(
      (await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ownerId: '22', expectedAccountId: '99' }) }))
        .status,
      400,
    );
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ownerId: '22', expectedAccountId: '11', accountId: '99' }),
        })
      ).status,
      400,
    );
    assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 200);
    assert.equal((await soul.respond('main', msg)).ok, true);
    assert.equal((await soul.respond('other', { ...msg, requestId: '2', messageId: '2' })).ok, false);
    assert.equal((await fetch(url, { method: 'DELETE', headers })).status, 200);
    assert.equal((await soul.respond('main', { ...msg, requestId: '3', messageId: '3' })).ok, false);
    observation = { state: 'offline' };
    assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 400);
  } finally {
    await server.close();
    database.close();
  }
});

test('缺少可信控制器或访问保护时无法保存', async () => {
  const security = createRequestSecurity();
  const server = await listenStandaloneServer({ routes: [], logger, port: 0, security });
  try {
    const url = `http://127.0.0.1:${server.port}/standalone-qq/owner?pet=main`;
    const headers = { 'x-dsh-pet-token': security.token, 'content-type': 'application/json' };
    assert.deepEqual(await (await fetch(url, { headers })).json(), {
      available: false,
      configured: false,
      clearable: false,
    });
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 503);
  } finally {
    await server.close();
  }
  const unprotected = await listenStandaloneServer({ routes: [], logger, port: 0 });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${unprotected.port}/standalone-qq/owner?pet=main`)).status, 503);
  } finally {
    await unprotected.close();
  }
});

test('确认 A 后若观察器切换账号或离线，不得把 B 绑定给新账号', () => {
  for (const second of [{ state: 'authenticated', accountId: '33' } as const, { state: 'offline' } as const]) {
    const database = openSoulDatabase({ file: ':memory:' });
    try {
      let calls = 0;
      const observe = (): QqAccountObservation =>
        ++calls === 1 ? { state: 'authenticated', accountId: '11' } : second;
      const binding = new QqOwnerBindingService({ database, observeAccount: observe });
      const control = createQqOwnerControl(binding, observe, (pet) => pet === 'main');
      assert.throws(() => control.configure('main', '22', '11'));
      assert.equal(binding.state('main').binding, null);
    } finally {
      database.close();
    }
  }
});

test('换号或离线后不把旧账号的主人配置显示为当前已配置', () => {
  const database = openSoulDatabase({ file: ':memory:' });
  try {
    let observation: QqAccountObservation = { state: 'authenticated', accountId: '11' };
    const observe = () => observation;
    const binding = new QqOwnerBindingService({ database, observeAccount: observe });
    const control = createQqOwnerControl(binding, observe, (pet) => pet === 'main');
    control.configure('main', '22', '11');
    assert.equal(control.status('main').configured, true);
    observation = { state: 'authenticated', accountId: '33' };
    assert.deepEqual(control.status('main'), { available: true, accountId: '33', configured: false, clearable: true });
    observation = { state: 'offline' };
    assert.deepEqual(control.status('main'), { available: false, configured: false, clearable: true });
    control.clear('main');
    assert.deepEqual(control.status('main'), { available: false, configured: false, clearable: false });
  } finally {
    database.close();
  }
});
