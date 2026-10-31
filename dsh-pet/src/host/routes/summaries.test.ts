/**
 * `GET /summaries` 的契约测试：列出、条数参数、只读方法与依赖缺省。
 *
 * 摘要只读且只列 `active`：后端没有摘要层时要明确说「不提供」，而不是给一个空列表
 * 让用户以为「她什么都不记得我们聊过什么」。
 *
 * 跑法：node --experimental-strip-types --test src/host/routes/summaries.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { PetRouteDeps, RouteInput, SummaryItem } from './types.ts';
import { DEFAULT_SUMMARY_LIMIT, handleSummariesRoutes, MAX_SUMMARY_LIMIT } from './summaries.ts';

/** 造最小依赖。 */
function makeDeps(overrides: Partial<PetRouteDeps> = {}): {
  deps: PetRouteDeps;
  listed: { petId: string; limit: number }[];
} {
  const listed: { petId: string; limit: number }[] = [];
  const item: SummaryItem = {
    id: 'summary:main:1000-2000',
    periodStart: 1000,
    periodEnd: 2000,
    text: '用户在做毕设，顺便聊了猫。',
  };
  const deps = {
    configPaths: {},
    log: { error: () => {}, info: () => {}, warn: () => {} },
    memoryPath: '/tmp/x',
    requirePet: () => ({ ok: true as const, petId: 'main', entry: 'main', conf: {} }),
    listSummaries: async (petId: string, limit: number) => {
      listed.push({ petId, limit });
      return [item];
    },
    ...overrides,
  } as unknown as PetRouteDeps;
  return { deps, listed };
}

/** 一次调用。 */
function call(method: 'GET' | 'DELETE', query = ''): RouteInput {
  return {
    url: new URL(`http://127.0.0.1/dsh-pet-7340/summaries?pet=main${query}`),
    rest: 'summaries',
    method,
  };
}

/** 取应答的 JSON 体。 */
function payload(result: Awaited<ReturnType<typeof handleSummariesRoutes>>): Record<string, unknown> {
  assert.notEqual(result, undefined, 'summaries 路由应当接住这个请求');
  assert.equal(result?.kind, 'json');
  return (result as { obj: Record<string, unknown> }).obj;
}

describe('GET /summaries', () => {
  test('rest 不是 summaries → undefined', async () => {
    const { deps } = makeDeps();
    const result = await handleSummariesRoutes(deps, { ...call('GET'), rest: 'facts' });
    assert.equal(result, undefined);
  });

  test('依赖缺省 → 明确说「不提供」，不是空列表', async () => {
    const { deps } = makeDeps({ listSummaries: undefined });
    const res = payload(await handleSummariesRoutes(deps, call('GET')));
    assert.equal(res.ok, false);
    assert.match(String(res.message), /不提供/);
  });

  test('默认条数 + 透传 petId', async () => {
    const { deps, listed } = makeDeps();
    const res = payload(await handleSummariesRoutes(deps, call('GET')));
    assert.equal(res.ok, true);
    assert.deepEqual(listed, [{ petId: 'main', limit: DEFAULT_SUMMARY_LIMIT }]);
    const summaries = res.summaries as Record<string, unknown>[];
    assert.equal(summaries[0]?.text, '用户在做毕设，顺便聊了猫。');
  });

  test('limit 透传；非法值 → bad-request 且不取数', async () => {
    const ok = makeDeps();
    payload(await handleSummariesRoutes(ok.deps, call('GET', '&limit=3')));
    assert.equal(ok.listed[0]?.limit, 3);

    for (const bad of ['0', String(MAX_SUMMARY_LIMIT + 1), '1.5', 'abc']) {
      const { deps, listed } = makeDeps();
      const res = payload(await handleSummariesRoutes(deps, call('GET', `&limit=${bad}`)));
      assert.equal(res.ok, false, `limit=${bad} 应被拒`);
      assert.equal(listed.length, 0, '坏参数不该打到存储层');
    }
  });

  test('只读：DELETE → 405', async () => {
    const { deps } = makeDeps();
    const res = payload(await handleSummariesRoutes(deps, call('DELETE')));
    assert.equal(res.reason, 'method-not-allowed', '摘要不能被单条删掉，只能整段重写');
  });

  test('宠物不存在 → 用 requirePet 的拒绝，且不取数', async () => {
    const listed: unknown[] = [];
    const deps = {
      ...makeDeps().deps,
      requirePet: () => ({
        ok: false as const,
        res: { kind: 'json', status: 200, obj: { ok: false, reason: 'unknown-pet' } },
      }),
      listSummaries: async () => {
        listed.push(1);
        return [];
      },
    } as unknown as PetRouteDeps;
    payload(await handleSummariesRoutes(deps, call('GET')));
    assert.equal(listed.length, 0);
  });
});
