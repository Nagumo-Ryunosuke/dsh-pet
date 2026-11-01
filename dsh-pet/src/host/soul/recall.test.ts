/**
 * 召回融合：事实在原文之前，且两者共用同一份预算。
 *
 * 这层最容易出的错不是「没想起来」，而是「想起来的是无关的旧闲聊」——
 * 预算只有 5 条，事实被挤掉时用户会先感觉到她忘了重要偏好。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { Fact, MemoryHit } from '@deepseek-pet/soul';

import { factHit, recallWithFacts } from './recall.ts';

/** 造一条事实。 */
function fact(id: string, subject: string, predicate: string, value: string, overrides: Partial<Fact> = {}): Fact {
  return {
    id,
    petId: 'main',
    subject,
    predicate,
    value,
    confidence: 0.8,
    status: 'active',
    validFrom: 1000,
    validTo: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/** 造一条聊天原文命中。 */
function hit(id: string, text: string, occurredAt = 1000): MemoryHit {
  return {
    event: {
      id,
      petId: 'main',
      occurredAt,
      kind: 'user_message',
      role: 'user',
      text,
      source: 'chat',
      privacy: 'normal',
    },
    score: 1,
    via: 'fts',
  };
}

describe('召回融合', () => {
  test('相关事实排在聊天原文之前，无关事实不进提示词', () => {
    const facts = [fact('f1', '用户', '喜欢', '手冲咖啡'), fact('f2', '用户', '在做', '桌面宠物项目')];
    const recalled = recallWithFacts({
      petId: 'main',
      query: '想喝点手冲咖啡',
      facts,
      searchEvents: () => [hit('e1', '昨天聊了聊天气')],
    });
    assert.equal(recalled[0]?.role, 'fact');
    assert.equal(recalled[0]?.text, '用户喜欢手冲咖啡');
    assert.ok(!recalled.some((one) => one.text.includes('桌面宠物')));
    assert.ok(recalled.some((one) => one.id === 'e1'));
  });

  test('事实与原文共享 5 条预算：原文再多也不会把事实挤掉', () => {
    const facts = [fact('f1', '用户', '喜欢', '手冲咖啡')];
    const events = Array.from({ length: 10 }, (_, i) => hit(`e${i}`, `第 ${i} 段旧聊天`));
    const recalled = recallWithFacts({
      petId: 'main',
      query: '手冲咖啡',
      facts,
      searchEvents: () => events,
    });
    assert.equal(recalled.length, 5, '总条数仍受预算限制');
    assert.equal(recalled[0]?.role, 'fact', '事实占用第一个位置');
    assert.equal(recalled.filter((one) => one.role === 'user').length, 4);
  });

  test('事实正文按单条 token 上限截断', () => {
    const facts = [fact('f1', '用户', '喜欢', '咖啡'.repeat(100))];
    const recalled = recallWithFacts({ petId: 'main', query: '咖啡', facts, searchEvents: () => [] });
    assert.equal(recalled[0]?.role, 'fact');
    assert.ok((recalled[0]?.text.length ?? 0) < 300, '超长事实不能整段塞进提示词');
  });

  test('没有相关事实时只返回原文', () => {
    const recalled = recallWithFacts({
      petId: 'main',
      query: '今天好累',
      facts: [fact('f1', '用户', '喜欢', '手冲咖啡')],
      searchEvents: () => [hit('e1', '今天加班到很晚')],
    });
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0]?.id, 'e1');
  });

  test('事实包装保留稳定 id 与更新时间，供日志与排序使用', () => {
    const one = factHit('main', fact('f9', '用户', '养', '猫', { updatedAt: 12345 }));
    assert.equal(one.event.id, 'f9');
    assert.equal(one.event.occurredAt, 12345);
    assert.equal(one.via, 'fact');
    assert.equal(one.event.role, 'fact');
  });
});

describe('召回预算可配置', () => {
  test('条数与事实条数都按传入预算生效', () => {
    const facts = [fact('f1', '用户', '喜欢', '手冲咖啡'), fact('f2', '用户', '在做', '手冲咖啡实验')];
    const recalled = recallWithFacts({
      petId: 'main',
      query: '手冲咖啡',
      facts,
      searchEvents: () => [hit('e1', '手冲咖啡'), hit('e2', '手冲咖啡'), hit('e3', '手冲咖啡')],
      budget: { maxItems: 2, maxTokens: 400, maxTokensPerItem: 120 },
      maxFacts: 1,
    });
    assert.equal(recalled.length, 2, 'maxItems=2 时只注入两条');
    assert.equal(recalled[0]?.role, 'fact', '事实仍然优先');
    assert.equal(recalled[0]?.id, 'f1');
  });

  test('总预算调小后长记忆被截断而不是全部丢弃', () => {
    const recalled = recallWithFacts({
      petId: 'main',
      query: '加班',
      facts: [],
      searchEvents: () => [hit('e1', '今天加班到很晚'.repeat(40))],
      budget: { maxItems: 5, maxTokens: 60, maxTokensPerItem: 40 },
    });
    assert.equal(recalled.length, 1, '截断后仍要放进去');
    assert.ok((recalled[0]?.text.length ?? 0) < 200, '正文被截短');
    assert.match(recalled[0]?.text ?? '', /…$/);
  });

  test('事实条数设为 0 时只带聊天原文', () => {
    const recalled = recallWithFacts({
      petId: 'main',
      query: '手冲咖啡',
      facts: [fact('f1', '用户', '喜欢', '手冲咖啡')],
      searchEvents: () => [hit('e1', '手冲咖啡')],
      maxFacts: 0,
    });
    assert.deepEqual(
      recalled.map((one) => one.id),
      ['e1'],
    );
  });
});

describe('摘要进入召回', () => {
  /** 造一条摘要。 */
  function summary(id: string, text: string, periodEnd: number) {
    return {
      id,
      petId: 'main',
      periodStart: periodEnd - 1000,
      periodEnd,
      text,
      status: 'active' as const,
      sourceVersion: 1,
      createdAt: periodEnd,
      updatedAt: periodEnd,
    };
  }

  test('顺序是事实 → 摘要 → 原文；摘要不按关键词筛', () => {
    const recalled = recallWithFacts({
      petId: 'main',
      query: '今天好累', // 与摘要、事实都不同词
      facts: [fact('f1', '用户', '喜欢', '手冲咖啡')],
      // selectFacts 不会命中这条事实，这里只验排序：传一个能命中的查询
      summaries: [summary('s1', '之前在做毕设，聊了很多猫。', 500)],
      searchEvents: () => [hit('e1', '今天加班到很晚')],
    });
    assert.deepEqual(
      recalled.map((one) => one.role),
      ['summary', 'user'],
      '摘要排在原文之前；事实因不相关没有进来',
    );
    assert.equal(recalled[0]?.text, '之前在做毕设，聊了很多猫。');
  });

  test('最多两段摘要：再多会把最近的原话挤掉', () => {
    const recalled = recallWithFacts({
      petId: 'main',
      query: '随便聊聊',
      facts: [],
      summaries: [summary('s1', '一', 300), summary('s2', '二', 200), summary('s3', '三', 100)],
      searchEvents: () => [],
    });
    assert.deepEqual(
      recalled.map((one) => one.id),
      ['s1', 's2'],
    );
  });

  test('摘要按 periodEnd 参与窗口去重：刚聊过的时段不再用梗概重述', () => {
    const recalled = recallWithFacts({
      petId: 'main',
      query: '随便聊聊',
      facts: [],
      summaries: [summary('s1', '刚聊过的事', 5000)],
      searchEvents: () => [],
      // 预算足够，这里只确认摘要被当作普通条目返回；窗口去重在 soul 侧按 occurredAt 过滤
    });
    assert.equal(recalled[0]?.occurredAt, 5000, 'occurredAt 用 periodEnd，供窗口去重判断');
  });
});

describe('最近话题召回（指代/近指的最小可行版）', () => {
  test('查询与事实零字面重叠，但最近聊到过 → 仍能召回', () => {
    const recalled = recallWithFacts({
      petId: 'main',
      // 「战队」是查询的二字片段，会经 selectFacts 命中值「IG战队」——这里刻意用值「IG」，
      // 让查询与事实**真的零重叠**，才能证明召回来自最近话题而不是关键词匹配
      query: '那个战队昨天赢了吗',
      facts: [fact('f1', '用户', '支持', 'IG')],
      recentText: ['我支持IG，昨天看比赛了'],
      searchEvents: () => [],
    });
    assert.equal(recalled.length, 1, '指代句也能想起刚聊过的事');
    assert.equal(recalled[0]?.id, 'f1');
  });

  test('最近话题没提过 → 不凭空补全', () => {
    const recalled = recallWithFacts({
      petId: 'main',
      query: '那个战队昨天赢了吗',
      facts: [fact('f1', '用户', '支持', 'IG')],
      recentText: ['今天吃什么好呢'],
      searchEvents: () => [],
    });
    assert.deepEqual(recalled, [], '没有可靠线索就不注入，而不是猜一个');
  });

  test('查询已命中的事实不重复注入', () => {
    const recalled = recallWithFacts({
      petId: 'main',
      query: 'IG最近怎么样',
      facts: [fact('f1', '用户', '支持', 'IG')],
      recentText: ['IG'],
      searchEvents: () => [],
    });
    assert.deepEqual(
      recalled.map((one) => one.id),
      ['f1'],
    );
  });

  test('主语不作为近指依据，值太短也不认', () => {
    // 「用户」人人都一样，「x」「好」单字到处重叠——都不是可靠的近指线索
    const recalled = recallWithFacts({
      petId: 'main',
      query: '今天吃什么',
      facts: [fact('f1', '用户', '是', 'x'), fact('f2', '用户', '喜欢', '好')],
      recentText: ['用户觉得饿了，好想吃东西'],
      searchEvents: () => [],
    });
    assert.deepEqual(recalled, []);
  });

  test('查询命中的排在最近话题之前，且两者合计不超上限', () => {
    const facts = [
      fact('f1', '用户', '喜欢', '手冲咖啡'),
      fact('f2', '用户', '支持', 'IG'),
      fact('f3', '用户', '在弄', '毕设'),
      fact('f4', '用户', '养', '猫豆豆'),
    ];
    const recalled = recallWithFacts({
      petId: 'main',
      query: '手冲咖啡',
      facts,
      recentText: ['IG', '毕设', '猫豆豆'],
      searchEvents: () => [],
      maxFacts: 3,
    });
    assert.equal(recalled.length, 3, '总数仍受 maxFacts 约束');
    assert.equal(recalled[0]?.id, 'f1', '查询命中的排最前');
  });
});

describe('上下文窗口去重', () => {
  test('窗口内命中不占预算：追问时窗口外的旧记忆仍然进得来', () => {
    // 6 条窗口内（更新鲜、排序天然靠前）+ 1 条窗口外的老记忆
    const inWindow = [1, 2, 3, 4, 5, 6].map((n) => hit('w' + n, '最近聊的第' + n + '句', 5000 + n));
    const old = hit('old', '很久以前说过的事', 100);
    const recalled = recallWithFacts({
      petId: 'main',
      query: '追问一句',
      facts: [],
      contextOldestTs: 4000,
      searchEvents: () => [...inWindow, old],
    });
    // 先裁剪再滤的话：top-5 全是窗口内 → 全部丢弃 → 召回清零；
    // 先滤再裁剪：只剩 old 一条，它必须在
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0]?.id, 'old', '窗口外的老记忆不能被窗口内命中挤掉');
  });

  test('不给窗口边界时行为不变（全部参与预算）', () => {
    const hits = [1, 2, 3].map((n) => hit('e' + n, '第' + n + '句', 5000 + n));
    const recalled = recallWithFacts({
      petId: 'main',
      query: '随便问问',
      facts: [],
      searchEvents: () => hits,
    });
    assert.equal(recalled.length, 3);
  });
});
