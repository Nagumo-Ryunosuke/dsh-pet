/**
 * `GET/DELETE /facts` 的契约测试：列出、纠正、参数校验与依赖缺省。
 *
 * 纠正必须走「标记不对」而不是静默删除：用户需要知道她为什么不再这么认为；
 * 后端没有事实层时也要明确说「不提供」，不能假装空列表。
 *
 * 跑法：node --experimental-strip-types --test src/host/routes/facts.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { FactItem, PetRouteDeps, RouteInput } from './types.ts';
import { handleFactsRoutes, MAX_CORRECT_IDS } from './facts.ts';

/** 造最小依赖。 */
function makeDeps(overrides: Partial<PetRouteDeps> = {}): {
  deps: PetRouteDeps;
  listed: { petId: string; limit: number }[];
  corrected: { petId: string; ids: readonly string[] }[];
} {
  const listed: { petId: string; limit: number }[] = [];
  const corrected: { petId: string; ids: readonly string[] }[] = [];
  const item: FactItem = {
    id: 'fact:main:用户|喜欢|手冲咖啡',
    subject: '用户',
    predicate: '喜欢',
    value: '手冲咖啡',
    confidence: 0.8,
    updatedAt: 1000,
  };
  const deps = {
    configPaths: {},
    log: { error: () => {}, info: () => {}, warn: () => {} },
    memoryPath: '/tmp/x',
    requirePet: () => ({ ok: true as const, petId: 'main', entry: 'main', conf: {} }),
    listFacts: async (petId: string, limit: number) => {
      listed.push({ petId, limit });
      return [item];
    },
    correctFacts: async (petId: string, ids: readonly string[]) => {
      corrected.push({ petId, ids });
      return ids.length;
    },
    ...overrides,
  } as unknown as PetRouteDeps;
  return { deps, listed, corrected };
}

/** 一次 /facts 调用。 */
function call(method: 'GET' | 'DELETE' | 'PUT', query = ''): RouteInput {
  return {
    url: new URL(`http://127.0.0.1/dsh-pet-7340/facts?pet=main${query}`),
    rest: 'facts',
    method,
  };
}

/** 取应答的 JSON 体。 */
function payload(result: Awaited<ReturnType<typeof handleFactsRoutes>>): Record<string, unknown> {
  assert.notEqual(result, undefined, 'facts 路由应当接住这个请求');
  assert.equal(result?.kind, 'json');
  return (result as { obj: Record<string, unknown> }).obj;
}

describe('GET /facts', () => {
  test('rest 不是 facts → undefined', async () => {
    const { deps } = makeDeps();
    const result = await handleFactsRoutes(deps, { ...call('GET'), rest: 'memory' });
    assert.equal(result, undefined);
  });

  test('依赖缺省 → 明确说「不提供」，不是空列表', async () => {
    const { deps } = makeDeps({ listFacts: undefined, correctFacts: undefined });
    const res = payload(await handleFactsRoutes(deps, call('GET')));
    assert.equal(res.ok, false);
    assert.match(String(res.message), /不提供/);
  });

  test('默认 100 条，limit 透传；非法 limit 拒绝且不取数', async () => {
    const ok = makeDeps();
    const res = payload(await handleFactsRoutes(ok.deps, call('GET')));
    assert.equal(res.ok, true);
    assert.deepEqual(ok.listed, [{ petId: 'main', limit: 100 }]);
    assert.equal(Array.isArray(res.facts), true);

    const withLimit = makeDeps();
    payload(await handleFactsRoutes(withLimit.deps, call('GET', '&limit=7')));
    assert.equal(withLimit.listed[0]?.limit, 7);

    for (const bad of ['0', '201', '1.5', 'abc']) {
      const { deps, listed } = makeDeps();
      const badRes = payload(await handleFactsRoutes(deps, call('GET', `&limit=${bad}`)));
      assert.equal(badRes.ok, false, `limit=${bad} 应被拒`);
      assert.equal(listed.length, 0);
    }
  });

  test('宠物不存在：requirePet 的应答原样透传', async () => {
    const { deps } = makeDeps({
      requirePet: () => ({
        ok: false as const,
        res: { kind: 'json', status: 400, obj: { ok: false, reason: 'unknown-pet' } },
      }),
    });
    const res = payload(await handleFactsRoutes(deps, call('GET')));
    assert.equal(res.reason, 'unknown-pet');
  });
});

describe('DELETE /facts', () => {
  test('id 去重后下传，返回纠正条数', async () => {
    const { deps, corrected } = makeDeps();
    const res = payload(await handleFactsRoutes(deps, call('DELETE', '&id=a&id=b&id=a')));
    assert.equal(res.ok, true);
    assert.equal(res.corrected, 2);
    assert.deepEqual(corrected[0]?.ids, ['a', 'b']);
  });

  test('没有 id / 空串 / 超上限 → bad-request，且不调用', async () => {
    for (const query of ['', '&id=%20', Array.from({ length: MAX_CORRECT_IDS + 1 }, (_, i) => `&id=f${i}`).join('')]) {
      const { deps, corrected } = makeDeps();
      const res = payload(await handleFactsRoutes(deps, call('DELETE', query)));
      assert.equal(res.ok, false);
      assert.equal(corrected.length, 0);
    }
  });

  test('PUT → 405', async () => {
    const { deps } = makeDeps();
    const result = await handleFactsRoutes(deps, call('PUT'));
    assert.notEqual(result, undefined);
    assert.equal((result as { status: number }).status, 405);
  });
});
