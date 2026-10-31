/**
 * `GET/DELETE /memory` 的契约测试：参数解析、依赖缺省的行为与透传。
 *
 * 关键的一条是「依赖缺省时说『不提供』而不是返回空列表」：空列表会让用户以为她真的
 * 什么都不记得，那是撒谎。
 *
 * 跑法：node --experimental-strip-types --test src/host/routes/memory.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { MemoryItem, PetRouteDeps, RouteInput } from './types.ts';
import { handleMemoryRoutes, MAX_DELETE_IDS } from './memory.ts';

/** 造最小依赖：requirePet 固定回 main，list/delete 记录入参。 */
function makeDeps(overrides: Partial<PetRouteDeps> = {}): {
  deps: PetRouteDeps;
  listed: { petId: string; query: string | undefined; limit: number }[];
  deleted: { petId: string; ids: readonly string[] }[];
} {
  const listed: { petId: string; query: string | undefined; limit: number }[] = [];
  const deleted: { petId: string; ids: readonly string[] }[] = [];
  const item: MemoryItem = {
    id: 'e1',
    occurredAt: 1000,
    role: 'user',
    text: '正文',
    kind: 'user_message',
    source: 'chat',
  };
  const deps = {
    configPaths: {},
    log: { error: () => {}, info: () => {}, warn: () => {} },
    memoryPath: '/tmp/x',
    requirePet: () => ({ ok: true as const, petId: 'main', entry: 'main', conf: {} }),
    listMemories: async (petId: string, query: string | undefined, limit: number) => {
      listed.push({ petId, query, limit });
      return [item];
    },
    deleteMemories: async (petId: string, ids: readonly string[]) => {
      deleted.push({ petId, ids });
      return ids.length;
    },
    ...overrides,
  } as unknown as PetRouteDeps;
  return { deps, listed, deleted };
}

/** 一次 /memory 调用。 */
function call(method: 'GET' | 'DELETE' | 'PUT', query = '', body?: string): RouteInput {
  return {
    url: new URL(`http://127.0.0.1/dsh-pet-7340/memory?pet=main${query}`),
    rest: 'memory',
    method,
    body,
  };
}

/** 取应答的 JSON 体。 */
function payload(result: Awaited<ReturnType<typeof handleMemoryRoutes>>): Record<string, unknown> {
  assert.notEqual(result, undefined, 'memory 路由应当接住这个请求');
  assert.equal(result?.kind, 'json');
  return (result as { obj: Record<string, unknown> }).obj;
}

describe('GET /memory', () => {
  test('rest 不是 memory → undefined，交给下一个处理器', async () => {
    const { deps } = makeDeps();
    const result = await handleMemoryRoutes(deps, { ...call('GET'), rest: 'chat' });
    assert.equal(result, undefined);
  });

  test('依赖缺省 → bad-request，且明确说「不提供」', async () => {
    const { deps } = makeDeps({ listMemories: undefined, deleteMemories: undefined });
    const res = payload(await handleMemoryRoutes(deps, call('GET')));
    assert.equal(res.ok, false);
    assert.match(String(res.message), /不提供/);
  });

  test('不带 q：以 undefined 查询、默认 50 条（浏览全部）', async () => {
    const { deps, listed } = makeDeps();
    const res = payload(await handleMemoryRoutes(deps, call('GET')));
    assert.equal(res.ok, true);
    assert.equal(res.query, null);
    assert.deepEqual(listed, [{ petId: 'main', query: undefined, limit: 50 }]);
  });

  test('带 q：检索词 trim 后下传', async () => {
    const { deps, listed } = makeDeps();
    const res = payload(await handleMemoryRoutes(deps, call('GET', '&q=%20%E8%B1%86%E8%B1%86%20')));
    assert.equal(res.query, '豆豆');
    assert.equal(listed[0]?.query, '豆豆');
  });

  test('limit 透传；非法值 → bad-request，且一次都不调用', async () => {
    const ok = makeDeps();
    payload(await handleMemoryRoutes(ok.deps, call('GET', '&limit=7')));
    assert.equal(ok.listed[0]?.limit, 7);

    for (const bad of ['0', '201', '1.5', 'abc']) {
      const { deps, listed } = makeDeps();
      const res = payload(await handleMemoryRoutes(deps, call('GET', `&limit=${bad}`)));
      assert.equal(res.ok, false, `limit=${bad} 应被拒`);
      assert.equal(listed.length, 0);
    }
  });

  test('q 超长 → bad-request', async () => {
    const { deps, listed } = makeDeps();
    const res = payload(await handleMemoryRoutes(deps, call('GET', `&q=${'x'.repeat(101)}`)));
    assert.equal(res.ok, false);
    assert.equal(listed.length, 0);
  });

  test('宠物不存在：requirePet 的应答原样透传', async () => {
    const { deps } = makeDeps({
      requirePet: () => ({
        ok: false as const,
        res: { kind: 'json', status: 400, obj: { ok: false, reason: 'unknown-pet' } },
      }),
    });
    const res = payload(await handleMemoryRoutes(deps, call('GET')));
    assert.equal(res.reason, 'unknown-pet');
  });
});

describe('DELETE /memory', () => {
  test('id 去重后下传，返回删除条数', async () => {
    const { deps, deleted } = makeDeps();
    const res = payload(await handleMemoryRoutes(deps, call('DELETE', '&id=a&id=b&id=a')));
    assert.equal(res.ok, true);
    assert.equal(res.removed, 2);
    assert.deepEqual(deleted[0]?.ids, ['a', 'b']);
  });

  test('一个 id 都没有 / 空串 / 超上限 → bad-request，且一次都不调用', async () => {
    const noIds = makeDeps();
    const empty = payload(await handleMemoryRoutes(noIds.deps, call('DELETE')));
    assert.equal(empty.ok, false);
    assert.equal(noIds.deleted.length, 0);

    const blank = makeDeps();
    const blankRes = payload(await handleMemoryRoutes(blank.deps, call('DELETE', '&id=%20')));
    assert.equal(blankRes.ok, false);
    assert.equal(blank.deleted.length, 0);

    const tooMany = makeDeps();
    const ids = Array.from({ length: MAX_DELETE_IDS + 1 }, (_, i) => `&id=e${i}`).join('');
    const tooManyRes = payload(await handleMemoryRoutes(tooMany.deps, call('DELETE', ids)));
    assert.equal(tooManyRes.ok, false);
    assert.equal(tooMany.deleted.length, 0);
  });

  test('PUT → 405（协议失败保留真实状态码）', async () => {
    const { deps } = makeDeps();
    const result = await handleMemoryRoutes(deps, call('PUT'));
    assert.notEqual(result, undefined);
    assert.equal((result as { status: number }).status, 405);
    const res = payload(result);
    assert.equal(res.reason, 'method-not-allowed');
  });
});
