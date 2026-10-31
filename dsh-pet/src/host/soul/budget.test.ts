/**
 * 记忆预算配置的解析。
 *
 * 这里的重点不是「能读到值」，而是**坏配置不能变成「她想不起来」**：一个写错的
 * `chatMemoryItemTokens` 如果照原样生效，每一条记忆都会因为「放不下」被跳过，
 * 表现却和「没有相关记忆」一模一样——用户查不出原因。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryBudgetOf } from './budget.ts';

describe('记忆预算配置', () => {
  test('没有配置时用灵魂的默认值', () => {
    const warnings: string[] = [];
    const budget = memoryBudgetOf({}, (message) => warnings.push(message));
    assert.deepEqual(budget, { maxItems: 5, maxTokens: 400, maxTokensPerItem: 120, maxFacts: 3 });
    assert.deepEqual(warnings, [], '缺省不算配置错误，不该刷日志');
  });

  test('四项配置都生效', () => {
    const budget = memoryBudgetOf({
      chatMemoryItems: 8,
      chatMemoryTokens: 900,
      chatMemoryItemTokens: 200,
      chatMemoryFacts: 5,
    });
    assert.deepEqual(budget, { maxItems: 8, maxTokens: 900, maxTokensPerItem: 200, maxFacts: 5 });
  });

  test('数字字符串也接受（jsonc 里常被写成字符串）', () => {
    assert.equal(memoryBudgetOf({ chatMemoryItems: '7' }).maxItems, 7);
  });

  test('写坏的值回落默认并留 warn', () => {
    const warnings: string[] = [];
    const budget = memoryBudgetOf(
      { chatMemoryItems: 0, chatMemoryTokens: '很多', chatMemoryItemTokens: 9999, chatMemoryFacts: -1 },
      (message) => warnings.push(message),
    );
    assert.deepEqual(budget, { maxItems: 5, maxTokens: 400, maxTokensPerItem: 120, maxFacts: 3 });
    assert.equal(warnings.length, 4, '每一项都要说清楚为什么回落到默认');
    assert.match(warnings[0] ?? '', /chatMemoryItems/);
  });

  test('单条上限不会超过总预算：否则每一条都会被「放不下」跳过', () => {
    const budget = memoryBudgetOf({ chatMemoryTokens: 100, chatMemoryItemTokens: 600 });
    assert.equal(budget.maxTokens, 100);
    assert.equal(budget.maxTokensPerItem, 100, '单条上限被总预算压住，否则一条都注入不进来');
  });

  test('小数与空字符串按写错处理', () => {
    const warnings: string[] = [];
    assert.equal(memoryBudgetOf({ chatMemoryItems: 2.5 }, (m) => warnings.push(m)).maxItems, 5);
    assert.equal(memoryBudgetOf({ chatMemoryItems: '' }, (m) => warnings.push(m)).maxItems, 5);
    assert.equal(warnings.length, 2, '两者都要留下原因，而不是静默取默认');
  });

  test('写错类型也按写错处理：布尔与数组不能被宽松转换成数字', () => {
    const warnings: string[] = [];
    const budget = memoryBudgetOf(
      // Number(true) === 1、Number([5]) === 5、Number({}) === NaN：前两个会被静默当合法值，
      // 用户看到的是「我明明写了 5 条，怎么像是没生效」
      { chatMemoryItems: true, chatMemoryTokens: [900], chatMemoryFacts: {} },
      (m) => warnings.push(m),
    );
    assert.equal(budget.maxItems, 5);
    assert.equal(budget.maxTokens, 400);
    assert.equal(budget.maxFacts, 3);
    assert.equal(warnings.length, 3);
  });
});
