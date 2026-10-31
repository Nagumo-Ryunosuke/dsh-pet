/**
 * `POST /chat` 的幂等键契约：解析、校验顺序与透传。
 *
 * 幂等本身（只生成一次、回放已完成的回复）由灵魂侧的单测覆盖；这里只钉路由这一层——
 * 客户端给的 `requestId` 会不会原样交给后端，非法值会不会在产生任何副作用之前被拦下。
 *
 * 跑法：node --experimental-strip-types --test src/host/routes/chat-idempotency.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { PetImageRef, PetImageSink } from '../image-attachment.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import { handleChatRoutes } from './chat.ts';

/** 一次 chatWithPet 调用（断言路由透传了什么）。 */
type ChatCall = { petId: string; text: string; image?: PetImageRef; requestId?: string };

/** 最小 PNG 头：用来验证「入参非法时不该落盘」。 */
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

/** 造附件服务桩；`saved` 记录实际交进来的字节，用来断言「没落盘」。 */
function makeSink(): { sink: PetImageSink; saved: { data: Uint8Array; mediaType: string }[] } {
  const saved: { data: Uint8Array; mediaType: string }[] = [];
  const sink: PetImageSink = {
    imageLimits: { maxImageBytes: 1024 },
    saveImages: async (inputs) => {
      saved.push(...inputs);
      return inputs.map((input) => ({
        attachmentId: 'sha256:' + 'a'.repeat(64),
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 8,
        height: 8,
      }));
    },
  };
  return { sink, saved };
}

/** 造最小路由依赖：requirePet 固定回 main，chatWithPet 记录全部入参。 */
function makeDeps(sink?: PetImageSink, extra: Record<string, unknown> = {}): { deps: PetRouteDeps; calls: ChatCall[] } {
  const calls: ChatCall[] = [];
  const deps = {
    configPaths: {},
    log: { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} },
    memoryPath: '/tmp/dsh-pet-memory.json',
    memoryRounds: () => 5,
    readMemory: async () => ({}),
    requirePet: () => ({ ok: true, petId: 'main', entry: 'main', conf: {} }),
    optionalService: (name: string) => (name === 'attachments' ? sink : undefined),
    chatWithPet: async (petId: string, text: string, image?: PetImageRef, requestId?: string) => {
      calls.push({ petId, text, image, requestId });
      return { ok: true as const, text: '嗯' };
    },
    ...extra,
  } as unknown as PetRouteDeps;
  return { deps, calls };
}

/** 一次 POST /chat；`payload` 直接序列化进请求体。 */
function post(payload: unknown): RouteInput {
  return {
    url: new URL('http://127.0.0.1/dsh-pet-7340/chat?pet=main&surface=web'),
    rest: 'chat',
    method: 'POST',
    body: JSON.stringify(payload),
  };
}

/** 取应答的 JSON 体。 */
function body(result: Awaited<ReturnType<typeof handleChatRoutes>>): Record<string, unknown> {
  assert.equal(result?.kind, 'json');
  return (result as { obj: Record<string, unknown> }).obj;
}

describe('POST /chat 的 requestId', () => {
  test('不传 → 透传 undefined（老行为，不去重）', async () => {
    const { deps, calls } = makeDeps();
    const res = await handleChatRoutes(deps, post({ text: '在吗' }));
    assert.equal(body(res).ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].requestId, undefined);
  });

  test('传了 → 原样透传给后端', async () => {
    const { deps, calls } = makeDeps();
    const res = await handleChatRoutes(deps, post({ text: '在吗', requestId: 'req-abc' }));
    assert.equal(body(res).ok, true);
    assert.equal(calls[0].requestId, 'req-abc');
  });

  test('首尾空白被 trim 掉再透传（同一句重试不该因为空格变成另一个键）', async () => {
    const { deps, calls } = makeDeps();
    await handleChatRoutes(deps, post({ text: '在吗', requestId: '  req-abc  ' }));
    assert.equal(calls[0].requestId, 'req-abc');
  });

  test('空串 / 纯空白 / 非字符串 / 超长 → bad-request，且一次都不调用后端', async () => {
    const cases: unknown[] = ['', '   ', 42, true, {}, 'x'.repeat(201)];
    for (const requestId of cases) {
      const { deps, calls } = makeDeps();
      const res = await handleChatRoutes(deps, post({ text: '在吗', requestId }));
      const payload = body(res);
      assert.equal(payload.ok, false, `requestId=${JSON.stringify(requestId)} 应当被拒`);
      assert.equal(payload.reason, 'bad-request');
      assert.equal(calls.length, 0, '非法键必须在调用后端之前被拦下');
    }
  });

  test('200 字整好可以，201 字不行（边界钉死）', async () => {
    const ok = makeDeps();
    await handleChatRoutes(ok.deps, post({ text: '在吗', requestId: 'x'.repeat(200) }));
    assert.equal(ok.calls.length, 1, '200 字是合法上界');

    const tooLong = makeDeps();
    const res = await handleChatRoutes(tooLong.deps, post({ text: '在吗', requestId: 'x'.repeat(201) }));
    assert.equal(body(res).reason, 'bad-request');
    assert.equal(tooLong.calls.length, 0);
  });

  test('带着图片且键合法 → 图片照常准入，键一并透传', async () => {
    const { sink, saved } = makeSink();
    const { deps, calls } = makeDeps(sink);
    const res = await handleChatRoutes(
      deps,
      post({ text: '看图', requestId: 'req-img', attachment: { mediaType: 'image/png', data: PNG_BASE64 } }),
    );
    assert.equal(body(res).ok, true);
    assert.equal(saved.length, 1, '合法请求不该被键的校验影响');
    assert.equal(calls[0].requestId, 'req-img');
    assert.notEqual(calls[0].image, undefined);
  });

  test('键非法时图片不该先落盘（顺序：先验入参，再做副作用）', async () => {
    const { sink, saved } = makeSink();
    const { deps, calls } = makeDeps(sink);
    const res = await handleChatRoutes(
      deps,
      post({ text: '看图', requestId: '', attachment: { mediaType: 'image/png', data: PNG_BASE64 } }),
    );
    assert.equal(body(res).reason, 'bad-request');
    assert.equal(saved.length, 0, '入参没验完就落盘会留下孤儿附件');
    assert.equal(calls.length, 0);
  });
});
