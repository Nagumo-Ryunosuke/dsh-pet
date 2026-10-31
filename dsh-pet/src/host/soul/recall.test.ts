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
