/**
 * 渠道绑定端点的契约测试：签发、列出、断开，以及「后端不支持时怎么说」。
 *
 * 重点在三条：码按宠物签发、断开要带上 scope、不支持时明确回「不提供」而不是假成功。
 * 跑法：node --experimental-strip-types --test src/host/routes/qq.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { ChannelGrantView, PetRouteDeps, RouteInput } from './types.ts';
import { handleQqRoutes } from './qq.ts';

/** 造最小依赖，并记录调用。 */
function makeDeps(overrides: Partial<PetRouteDeps> = {}): {
  deps: PetRouteDeps;
  calls: { issued: string[]; revoked: { petId: string; scopeId: string }[] };
} {
  const calls = { issued: [] as string[], revoked: [] as { petId: string; scopeId: string }[] };
  const grant: ChannelGrantView = {
    scopeId: 'qq:10001:private:20002:20002',
    display: 'QQ 20002',
    capabilities: ['可以回话'],
    grantedAt: 1_700_000_000_000,
  };
  const deps = {
    configPaths: {},
    log: { error: () => {}, info: () => {}, warn: () => {} },
    memoryPath: '/tmp/x',
    requirePet: () => ({ ok: true as const, petId: 'main', entry: 'main', conf: {} }),
    issueBindCode: async (petId: string) => {
      calls.issued.push(petId);
      return { code: 'ABCD2345', expiresAt: Date.now() + 300_000 };
    },
    listChannelGrants: async () => [grant],
    revokeChannelGrant: async (petId: string, scopeId: string) => {
      calls.revoked.push({ petId, scopeId });
      return { revoked: true, removed: 4 };
    },
    ...overrides,
  } as unknown as PetRouteDeps;
  return { deps, calls };
}

/** 一次调用。 */
function call(method: string, rest: string, query = ''): RouteInput {
  return {
    url: new URL(`http://127.0.0.1/dsh-pet-7340/${rest}?pet=main${query}`),
    rest,
    method,
  };
}

/** 取应答的 JSON 体。 */
function payload(result: Awaited<ReturnType<typeof handleQqRoutes>>): Record<string, unknown> {
  assert.notEqual(result, undefined, 'qq 路由应当接住这个请求');
  assert.equal(result?.kind, 'json');
  return (result as { obj: Record<string, unknown> }).obj;
}

describe('路由匹配与依赖缺省', () => {
  test('rest 不是 qq/* → undefined（交给下一个处理器）', async () => {
    const { deps } = makeDeps();
    assert.equal(await handleQqRoutes(deps, call('GET', 'facts')), undefined);
  });

  test('后端不支持（native/fake）→ 明确说「不提供」，不是假成功', async () => {
    const { deps } = makeDeps({
      issueBindCode: undefined,
      listChannelGrants: undefined,
      revokeChannelGrant: undefined,
    });
    const res = payload(await handleQqRoutes(deps, call('GET', 'qq/grants')));
    assert.equal(res.ok, false);
    assert.match(String(res.message), /不提供/);
  });

  test('三件能力缺一件也算不支持：不留「能生成码但不能断开」的半套', async () => {
    const { deps } = makeDeps({ revokeChannelGrant: undefined });
    const res = payload(await handleQqRoutes(deps, call('POST', 'qq/bind/code')));
    assert.equal(res.ok, false);
  });
});

describe('POST /qq/bind/code', () => {
  test('签发：返回码、到期时刻与剩余毫秒，并按宠物签发', async () => {
    const { deps, calls } = makeDeps();
    const res = payload(await handleQqRoutes(deps, call('POST', 'qq/bind/code')));
    assert.equal(res.ok, true);
    assert.equal(res.code, 'ABCD2345');
    assert.equal(typeof res.expiresAt, 'number');
    // 剩余时间由服务端算：前端自己按本地时钟倒计时会漂
    assert.ok((res.expiresInMs as number) > 0);
    assert.deepEqual(calls.issued, ['main']);
  });

  test('GET 方法不允许', async () => {
    const { deps } = makeDeps();
    const result = await handleQqRoutes(deps, call('GET', 'qq/bind/code'));
    assert.equal(result?.kind, 'json');
    assert.equal((result as { status?: number }).status, 405);
  });

  test('未知宠物 → 直接返回定位失败，不签发', async () => {
    const { deps, calls } = makeDeps({
      requirePet: () => ({
        ok: false as const,
        res: { kind: 'json', status: 200, obj: { ok: false, reason: 'unknown-pet', message: '没有这只宠物' } },
      }),
    });
    const res = payload(await handleQqRoutes(deps, call('POST', 'qq/bind/code')));
    assert.equal(res.reason, 'unknown-pet');
    assert.deepEqual(calls.issued, []);
  });

  test('签发抛错 → generate-error，不是 500', async () => {
    const { deps } = makeDeps({
      issueBindCode: async () => {
        throw new Error('数据库只读');
      },
    });
    const res = payload(await handleQqRoutes(deps, call('POST', 'qq/bind/code')));
    assert.equal(res.reason, 'generate-error');
    assert.match(String(res.message), /数据库只读/);
  });
});

describe('GET /qq/grants', () => {
  test('列出已绑定', async () => {
    const { deps } = makeDeps();
    const res = payload(await handleQqRoutes(deps, call('GET', 'qq/grants')));
    assert.equal(res.ok, true);
    const grants = res.grants as ChannelGrantView[];
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.display, 'QQ 20002');
  });

  test('POST 方法不允许', async () => {
    const { deps } = makeDeps();
    const result = await handleQqRoutes(deps, call('POST', 'qq/grants'));
    assert.equal(result?.kind, 'json');
    assert.equal((result as { status?: number }).status, 405);
  });
});

describe('DELETE /qq/grants', () => {
  test('断开：透传撤权与清除条数', async () => {
    const { deps, calls } = makeDeps();
    const res = payload(
      await handleQqRoutes(deps, call('DELETE', 'qq/grants', '&scope=qq:10001:private:20002:20002')),
    );
    assert.equal(res.ok, true);
    assert.equal(res.revoked, true);
    assert.equal(res.removed, 4);
    assert.deepEqual(calls.revoked, [{ petId: 'main', scopeId: 'qq:10001:private:20002:20002' }]);
  });

  test('缺 scope → bad-request，且不会去删任何东西', async () => {
    const { deps, calls } = makeDeps();
    const res = payload(await handleQqRoutes(deps, call('DELETE', 'qq/grants')));
    assert.equal(res.reason, 'bad-request');
    assert.deepEqual(calls.revoked, []);
  });

  test('scope 含非法字符 → bad-request（不拿它去猜 scope 删数据）', async () => {
    const { deps, calls } = makeDeps();
    const res = payload(await handleQqRoutes(deps, call('DELETE', 'qq/grants', '&scope=qq:1;DROP')));
    assert.equal(res.reason, 'bad-request');
    assert.deepEqual(calls.revoked, []);
  });

  test('撤销抛错（例如认不出的 scope）→ generate-error', async () => {
    const { deps } = makeDeps({
      revokeChannelGrant: async () => {
        throw new Error('无法识别的渠道会话标识');
      },
    });
    const res = payload(
      await handleQqRoutes(deps, call('DELETE', 'qq/grants', '&scope=qq:1:private:2:2')),
    );
    assert.equal(res.reason, 'generate-error');
  });
});
