/**
 * 面板发送动作的幂等键生命周期：首次生成、失败保留、成功清空、改字作废。
 *
 * 这一层是幂等真正对用户有意义的唯一地方——宿主只知道「这个键见过没有」，
 * 是客户端决定「哪两次点击算同一件事」。所以这里钉的是键的沿用与作废时机。
 *
 * 跑法：node --experimental-strip-types --test src/client/chat/actions.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createSendActions, type ActionPorts } from './actions.ts';
import type { PanelData } from './types.ts';

/** 造一份够用的面板状态快照。 */
function panel(overrides: Partial<PanelData> = {}): PanelData {
  return {
    pets: [],
    petId: 'main',
    messages: [],
    draft: '在吗',
    requestId: null,
    attachment: undefined,
    busy: false,
    loading: false,
    error: '',
    selected: [],
    selecting: false,
    orphans: [],
    pending: null,
    visibleRounds: 10,
    previewUrl: undefined,
    roundsByEntry: {},
    personas: {},
    personaOpen: false,
    speaking: null,
    ...overrides,
  } as PanelData;
}

/** 可写状态 + 端口：patch 真的改快照，便于连续动作看到上一次的结果。 */
function makePorts(initial: PanelData): {
  ports: ActionPorts;
  box: { state: PanelData; errors: string[]; reloads: number };
} {
  const box = { state: initial, errors: [] as string[], reloads: 0 };
  const ports: ActionPorts = {
    read: () => box.state,
    patch: (next) => {
      box.state = { ...box.state, ...next };
    },
    fail: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      box.errors.push(message);
      box.state = { ...box.state, error: message };
    },
    reload: async () => {
      box.reloads += 1;
    },
  };
  return { ports, box };
}

/** 等发送动作内部的 async 链跑完（它不在返回值上，只能让出事件循环）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

/** 桩 fetch：按序回放给定的响应体，并收集每个请求体。 */
function stubFetch(responses: unknown[]): { bodies: Record<string, unknown>[]; restore: () => void } {
  const bodies: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    const payload = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  return {
    bodies,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe('发送动作的幂等键', () => {
  test('首次发送生成键；失败后重按发送复用同一个键', async () => {
    const captured = stubFetch([{ ok: false, reason: 'generate-error', message: '超时了' }, { ok: true }]);
    const { ports, box } = makePorts(panel());
    const actions = createSendActions(ports);
    try {
      actions.send();
      await settle();
      const first = box.state.requestId;
      assert.equal(typeof first, 'string', '第一次发送必须留下键');
      assert.notEqual(first, '', '键不能是空串');
      assert.equal(box.state.busy, false, '失败后要解锁');

      actions.send();
      await settle();
      assert.equal(captured.bodies.length, 2);
      assert.equal(captured.bodies[0]?.requestId, first);
      assert.equal(captured.bodies[1]?.requestId, first, '重试必须是同一个键，宿主才认得出是同一件事');
    } finally {
      captured.restore();
    }
  });

  test('发送成功后键被清空，下一句是新请求', async () => {
    const captured = stubFetch([{ ok: true }, { ok: true }]);
    const { ports, box } = makePorts(panel());
    const actions = createSendActions(ports);
    try {
      actions.send();
      await settle();
      assert.equal(box.state.requestId, null, '成功之后这一句已经结束');
      assert.equal(box.state.draft, '', '成功后要清空草稿');
      assert.equal(box.reloads, 1, '成功后要重读历史');

      // 同一句话再发一次：这是用户真的要再说一遍，必须是新键
      box.state = { ...box.state, draft: '在吗' };
      actions.send();
      await settle();
      assert.equal(captured.bodies.length, 2);
      assert.notEqual(captured.bodies[1]?.requestId, captured.bodies[0]?.requestId);
    } finally {
      captured.restore();
    }
  });

  test('改了草稿就作废：不能把新的一句话当成旧请求的重试', async () => {
    const captured = stubFetch([{ ok: false, reason: 'generate-error' }, { ok: true }]);
    const { ports, box } = makePorts(panel());
    const actions = createSendActions(ports);
    try {
      actions.send();
      await settle();
      const first = box.state.requestId;
      assert.equal(typeof first, 'string');

      // 模拟用户改了字：setDraft 会把键清掉（见 state.ts）
      box.state = { ...box.state, draft: '在吗（改过）', requestId: null };
      actions.send();
      await settle();
      assert.equal(captured.bodies[1]?.text, '在吗（改过）');
      assert.notEqual(captured.bodies[1]?.requestId, first);
    } finally {
      captured.restore();
    }
  });

  test('空草稿不发送、不产生键', async () => {
    const captured = stubFetch([{ ok: true }]);
    const { ports, box } = makePorts(panel({ draft: '   ' }));
    const actions = createSendActions(ports);
    try {
      actions.send();
      await settle();
      assert.equal(captured.bodies.length, 0);
      assert.equal(box.state.requestId, null);
      assert.equal(box.state.busy, false);
    } finally {
      captured.restore();
    }
  });
});
