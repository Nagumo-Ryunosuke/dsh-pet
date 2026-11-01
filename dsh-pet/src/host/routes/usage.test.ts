/**
 * `GET /usage` 的契约测试：参数、依赖缺省的行为与快照透传。
 *
 * 关键的一条是「token 永远是 unknown」：端点只是把灵魂的快照透传出去，
 * 无论后端给了什么，客户端视图里的 token 都不该出现一个像模像样的数字。
 *
 * 跑法：node --experimental-strip-types --test src/host/routes/usage.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { ModelUsage } from '@deepseek-pet/soul';
import type { PetRouteDeps, RouteInput } from './types.ts';
import { handleUsageRoutes } from './usage.ts';

/** 造最小依赖：requirePet 固定回 main，usage 返回给定快照。 */
function makeDeps(overrides: Partial<PetRouteDeps> = {}): { deps: PetRouteDeps; state: { read: number } } {
  const state = { read: 0 };
  const snapshot: ModelUsage = {
    calls: { chat: 3, extract: 1, summarize: 0 },
    tokens: 'unknown',
  };
  const deps = {
    configPaths: {},
    log: { error: () => {}, info: () => {}, warn: () => {} },
    memoryPath: '/tmp/x',
    requirePet: () => ({ ok: true as const, petId: 'main', entry: 'main', conf: {} }),
    usage: () => {
      state.read += 1;
      return snapshot;
    },
    ...overrides,
  } as unknown as PetRouteDeps;
  return { deps, state };
}

/** 一次 /usage 调用。 */
function call(method: 'GET' | 'POST'): RouteInput {
  return {
    url: new URL('http://127.0.0.1/dsh-pet-7340/usage'),
    rest: 'usage',
    method,
  };
}

/** 取应答的 JSON 体。 */
function payload(result: Awaited<ReturnType<typeof handleUsageRoutes>>): Record<string, unknown> {
  assert.notEqual(result, undefined, 'usage 路由应当接住这个请求');
  assert.equal(result?.kind, 'json');
  return (result as { obj: Record<string, unknown> }).obj;
}

describe('GET /usage', () => {
  test('rest 不是 usage → undefined，交给下一个处理器', async () => {
    const { deps } = makeDeps();
    const result = await handleUsageRoutes(deps, { ...call('GET'), rest: 'memory' });
    assert.equal(result, undefined);
  });

  test('依赖缺省 → bad-request，且明确说「不提供」', async () => {
    const { deps } = makeDeps({ usage: undefined });
    const res = payload(await handleUsageRoutes(deps, call('GET')));
    assert.equal(res.ok, false);
    assert.match(String(res.message), /不提供/);
  });

  test('只支持 GET：POST → method-not-allowed', async () => {
    const { deps } = makeDeps();
    const res = payload(await handleUsageRoutes(deps, call('POST')));
    assert.equal(res.ok, false);
    assert.match(String(res.message), /GET/);
  });

  test('透传快照：分桶调用次数原样返回，token 恒为 unknown', async () => {
    const { deps, state } = makeDeps();
    const res = payload(await handleUsageRoutes(deps, call('GET')));
    assert.equal(res.ok, true);
    const usage = res.usage as ModelUsage;
    assert.deepEqual(usage.calls, { chat: 3, extract: 1, summarize: 0 });
    assert.equal(usage.tokens, 'unknown', 'token 不臆造数字，永远记未知');
    assert.equal(state.read, 1, 'deps.usage 恰好被读一次');
  });
});
