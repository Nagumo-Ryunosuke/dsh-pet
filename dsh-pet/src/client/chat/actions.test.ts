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

import { createMemoryActions, createSendActions, type ActionPorts } from './actions.ts';
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

/** 桩 fetch：按序回放 memory 响应，facts / summaries / usage 各走兜底（默认空），互不吃对方的响应。 */
function stubFetch(
  responses: unknown[],
  factsResponses: unknown[] = [],
): {
  bodies: Record<string, unknown>[];
  urls: string[];
  restore: () => void;
} {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const original = globalThis.fetch;
  let index = 0;
  let factsIndex = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const href = String(url);
    urls.push(href);
    // GET（记忆卷帘）没有请求体：占一个空对象，让 bodies 与 urls 的下标始终对齐
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    if (href.includes('/facts')) {
      const payload = factsResponses[Math.min(factsIndex, Math.max(factsResponses.length - 1, 0))] ?? {
        ok: true,
        facts: [],
      };
      factsIndex += 1;
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    // 一次 refresh 会并行取 memory + facts + summaries + usage：后两者只兜底、不占主队列，
    // 主队列只排「记忆列表 / DELETE / 历史」这些被断言的请求
    if (href.includes('/summaries') || href.includes('/usage')) {
      return new Response(JSON.stringify({ ok: true, summaries: [], usage: null }), { status: 200 });
    }
    const payload = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  return {
    bodies,
    urls,
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

describe('记忆卷帘的动作', () => {
  /** 带好记忆相关初始状态的面板。 */
  function memoryPanel(): PanelData {
    return panel({
      petId: 'main',
      memoryOpen: false,
      memories: [],
      facts: [],
      memoryQuery: '',
      memoryLoading: false,
      pendingMemoryId: null,
      pendingFactId: null,
    });
  }

  test('展开时取数；再点一下收起不取数', async () => {
    const captured = stubFetch([
      { ok: true, events: [{ id: 'e1', occurredAt: 1000, role: 'user', text: '记得的事' }] },
    ]);
    const { ports, box } = makePorts(memoryPanel());
    const actions = createSendActions(ports);
    const memory = createMemoryActions(ports);
    void actions;
    try {
      memory.toggleMemory();
      await settle();
      assert.equal(box.state.memoryOpen, true);
      assert.equal(box.state.memories.length, 1);
      assert.equal(box.state.memoryLoading, false, '取完要解锁');

      const callsAfterOpen = captured.bodies.length;
      memory.toggleMemory();
      await settle();
      assert.equal(box.state.memoryOpen, false);
      assert.equal(captured.bodies.length, callsAfterOpen, '收起不该再取数');
    } finally {
      captured.restore();
    }
  });

  test('检索词为空时浏览全部（不带 q），带词时透传', async () => {
    const captured = stubFetch([{ ok: true, events: [] }]);
    const { ports } = makePorts(memoryPanel());
    const memory = createMemoryActions(ports);
    try {
      memory.toggleMemory();
      await settle();
      memory.searchMemories('  豆豆  ');
      await settle();
      const memoryUrl = captured.urls.filter((one) => one.includes('/memory')).pop() ?? '';
      assert.match(memoryUrl, /q=%E8%B1%86%E8%B1%86/, '检索词要透传（trim 后编码）');
    } finally {
      captured.restore();
    }
  });

  test('忘掉一条：先弹确认，确认后才删并按当前检索词重取', async () => {
    // 第 1 次响应 = 首次展开；第 2 次 = DELETE；第 3 次 = 删后重取
    const captured = stubFetch([
      {
        ok: true,
        events: [
          { id: 'e1', occurredAt: 1000, role: 'user', text: '旧' },
          { id: 'e2', occurredAt: 2000, role: 'user', text: '新' },
        ],
      },
      { ok: true, removed: 1, detached: 0, dirtied: 0, turnsRemoved: 1, cleanup: 'system-invisible' },
      { ok: true, events: [{ id: 'e2', occurredAt: 2000, role: 'user', text: '新' }] },
    ]);
    const { ports, box } = makePorts(memoryPanel());
    const memory = createMemoryActions(ports);
    try {
      memory.toggleMemory();
      await settle();
      assert.equal(box.state.memories.length, 2);

      memory.deleteMemory('e1');
      assert.equal(box.state.pending, 'forget-memory', '先弹确认条');
      assert.equal(box.state.pendingMemoryId, 'e1');
      assert.equal(box.state.memories.length, 2, '确认前不执行');

      memory.forgetConfirmed('e1');
      await settle();
      assert.equal(box.state.memories.length, 1, '以服务端重取的结果为准');
      assert.equal(box.state.memories[0]?.id, 'e2');
      assert.equal(box.state.pendingMemoryId, null, '执行完清掉待办');
      assert.equal(box.reloads, 1, '聊天视图要跟着刷新——后端把这一轮删了，界面上不能还留着');
      assert.match(box.state.forgetNote, /这一轮已从聊天里消失/, '说明文案要把删整轮说清楚');
    } finally {
      captured.restore();
    }
  });

  test('「这条不对」：先弹确认，确认后纠正并按当前检索词重取', async () => {
    const captured = stubFetch(
      [
        { ok: true, events: [] },
        { ok: true, events: [] },
      ],
      [
        {
          ok: true,
          facts: [
            {
              id: 'f1',
              subject: '用户',
              predicate: '喜欢',
              value: '手冲咖啡',
              confidence: 0.8,
              updatedAt: 1000,
            },
          ],
        },
        { ok: true, facts: [] },
      ],
    );
    const { ports, box } = makePorts(memoryPanel());
    const memory = createMemoryActions(ports);
    try {
      memory.toggleMemory();
      await settle();
      assert.equal(box.state.facts.length, 1);

      memory.correctFact('f1');
      assert.equal(box.state.pending, 'correct-fact', '先弹确认条');
      assert.equal(box.state.pendingFactId, 'f1');
      assert.equal(box.state.facts.length, 1, '确认前不执行');

      memory.correctFactConfirmed('f1');
      await settle();
      assert.equal(box.state.facts.length, 0, '以服务端重取的结果为准');
      assert.equal(box.state.pendingFactId, null, '执行完清掉待办');
      assert.ok(
        captured.urls.some((one) => one.includes('/facts') && one.includes('id=f1')),
        '纠正走 /facts?id=',
      );
    } finally {
      captured.restore();
    }
  });

  test('慢的旧检索响应不会覆盖新结果', async () => {
    const original = globalThis.fetch;
    const resolvers: ((response: Response) => void)[] = [];
    globalThis.fetch = ((url: string) => {
      // 事实、摘要与用量单独取，且立即返回：这条例只关心 memory 的乱序
      if (String(url).includes('/facts') || String(url).includes('/summaries') || String(url).includes('/usage')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              facts: [],
              summaries: [],
              usage: { calls: { chat: 0, extract: 0, summarize: 0 }, tokens: 'unknown' },
            }),
            { status: 200 },
          ),
        );
      }
      return new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      });
    }) as typeof fetch;
    try {
      const { ports, box } = makePorts(memoryPanel());
      const memory = createMemoryActions(ports);
      memory.searchMemories('第一词');
      memory.searchMemories('第二词');
      await settle();

      // 先回来的是旧请求：它必须被丢掉，而不是把新结果盖掉
      resolvers[0]?.(
        new Response(
          JSON.stringify({ ok: true, events: [{ id: 'a', occurredAt: 1, role: 'user', text: '旧词的结果' }] }),
          { status: 200 },
        ),
      );
      await settle();
      assert.equal(box.state.memories.length, 0, '旧响应不算数');

      resolvers[1]?.(
        new Response(
          JSON.stringify({ ok: true, events: [{ id: 'b', occurredAt: 2, role: 'user', text: '新词的结果' }] }),
          { status: 200 },
        ),
      );
      await settle();
      assert.deepEqual(
        box.state.memories.map((one) => one.id),
        ['b'],
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test('换宠物后，旧宠物的慢响应不能再写进当前面板', async () => {
    const original = globalThis.fetch;
    const resolvers: ((response: Response) => void)[] = [];
    globalThis.fetch = ((url: string) => {
      if (String(url).includes('/facts') || String(url).includes('/summaries') || String(url).includes('/usage')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, facts: [], summaries: [] }), { status: 200 }));
      }
      return new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      });
    }) as typeof fetch;
    try {
      const { ports, box } = makePorts(memoryPanel());
      const memory = createMemoryActions(ports);
      memory.searchMemories('旧宠物的词');
      await settle();
      // 切换宠物（pickPet 会清空记忆并按新宠物重取；这里只模拟 petId 已变）
      ports.patch({ petId: 'other' });
      resolvers[0]?.(
        new Response(
          JSON.stringify({ ok: true, events: [{ id: 'old', occurredAt: 1, role: 'user', text: '旧宠物的记忆' }] }),
          { status: 200 },
        ),
      );
      await settle();
      assert.equal(box.state.memories.length, 0, '旧宠物的结果不能写进另一只的卷帘');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('换宠递增序号后旧请求作废：冻结快照也骗不过去', async () => {
    // 真实 hook 里 read() 读的是发起请求那一渲染的快照（现已修成实时镜像），
    // 但换宠还有第二道保险：pickPet 递增检索序号。这条钉住序号机制本身
    const original = globalThis.fetch;
    const resolvers: ((response: Response) => void)[] = [];
    globalThis.fetch = ((url: string) => {
      if (String(url).includes('/facts') || String(url).includes('/summaries') || String(url).includes('/usage')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, facts: [], summaries: [] }), { status: 200 }));
      }
      return new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      });
    }) as typeof fetch;
    try {
      const { ports, box } = makePorts(memoryPanel());
      const seq = { token: 0 };
      const memory = createMemoryActions(ports, seq);
      memory.searchMemories('旧宠物的词');
      await settle();
      // state.ts 的 pickPet 在换宠时会做这件事
      seq.token += 1;
      resolvers[0]?.(
        new Response(
          JSON.stringify({ ok: true, events: [{ id: 'old', occurredAt: 1, role: 'user', text: '旧宠物的记忆' }] }),
          { status: 200 },
        ),
      );
      await settle();
      assert.equal(box.state.memories.length, 0, '序号已推进：旧响应必须作废');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('后端不提供记忆时报错给用户，而不是静默空列表', async () => {
    const captured = stubFetch([{ ok: false, message: '当前对话后端不提供长期记忆' }]);
    const { ports, box } = makePorts(memoryPanel());
    const memory = createMemoryActions(ports);
    try {
      memory.toggleMemory();
      await settle();
      assert.equal(box.state.memories.length, 0);
      assert.match(box.state.error, /不提供/);
    } finally {
      captured.restore();
    }
  });
});

describe('异步回执的宠物归属', () => {
  /** 与「记忆卷帘」同款的初始面板（helper 在别的 describe 作用域里，这里自带一份）。 */
  function memPanel(): PanelData {
    return panel({
      petId: 'main',
      memoryOpen: false,
      memories: [],
      facts: [],
      memoryQuery: '',
      memoryLoading: false,
      pendingMemoryId: null,
      pendingFactId: null,
    });
  }

  test('换宠后，旧的「忘掉」回执不动新面板', async () => {
    const original = globalThis.fetch;
    const resolvers: ((response: Response) => void)[] = [];
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      })) as typeof fetch;
    try {
      const { ports, box } = makePorts(memPanel());
      const memory = createMemoryActions(ports);
      memory.forgetConfirmed('e1');
      await settle();
      // 等待时切到 B
      ports.patch({ petId: 'other', forgetNote: '', pendingMemoryId: null });
      resolvers[0]?.(
        new Response(JSON.stringify({ ok: true, removed: 1, detached: 0, dirtied: 0, cleanup: 'system-invisible' }), {
          status: 200,
        }),
      );
      await settle();
      assert.equal(box.state.forgetNote, '', '旧回执不能把提示写进新面板');
      assert.equal(box.reloads, 0, '也不能按旧宠物的词刷新新面板');
      assert.equal(box.state.petId, 'other');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('发送期间换宠：旧回复不清掉新宠物的草稿', async () => {
    const original = globalThis.fetch;
    const resolvers: ((response: Response) => void)[] = [];
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      })) as typeof fetch;
    try {
      const { ports, box } = makePorts(panel({ draft: '给 A 的话' }));
      const actions = createSendActions(ports);
      actions.send();
      await settle();
      // 切到 B 并开始打字（pickPet 会复位 busy）
      ports.patch({ petId: 'other', draft: 'B 的草稿', busy: false });
      resolvers[0]?.(new Response(JSON.stringify({ ok: true, text: '好' }), { status: 200 }));
      await settle();
      assert.equal(box.state.draft, 'B 的草稿', '旧回复不能清掉正在编辑的草稿');
      assert.equal(box.reloads, 0);
    } finally {
      globalThis.fetch = original;
    }
  });
});
