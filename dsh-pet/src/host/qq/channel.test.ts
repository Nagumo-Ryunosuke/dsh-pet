/**
 * 渠道接线的契约测试：默认休眠、缺令牌明确报错、加载失败不拖垮宿主、卸载会停。
 *
 * 用一个临时的假网关模块代替真实包：这里要钉的是「接线逻辑」，不是网关行为
 * （那是网关仓库自己的测试）。
 *
 * 跑法：node --experimental-strip-types --test src/host/qq/channel.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startQqChannel } from './channel.ts';

/** 收集日志。 */
function logger(): { info: string[]; warn: string[]; error: string[]; sink: {
  info(m: string): void; warn(m: string): void; error(m: string): void;
} } {
  const info: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  return {
    info,
    warn,
    error,
    sink: {
      info: (m) => info.push(m),
      warn: (m) => warn.push(m),
      error: (m) => error.push(m),
    },
  };
}

/** 假的 ctx：只记录清理函数。 */
function fakeCtx(): { effect(fn: () => () => void): void; cleanups: (() => void)[] } {
  const cleanups: (() => void)[] = [];
  return { effect: (fn) => cleanups.push(fn()), cleanups };
}

/** 写一个假网关模块，记录创建与启停。 */
function writeFakeModule(dir: string, options: { throwOnImport?: boolean } = {}): string {
  const file = join(dir, 'fake-gateway.mjs');
  if (options.throwOnImport === true) {
    writeFileSync(file, 'throw new Error("包没有编译");\n', 'utf8');
    return file;
  }
  writeFileSync(
    file,
    `
globalThis.__qqTrace = [];
export class OneBotClient {
  constructor(options) { globalThis.__qqTrace.push(['client', options.url]); }
}
export class QqChannelAdapter {
  constructor(options) { globalThis.__qqTrace.push(['adapter', options.policy.groupPolicy]); }
}
export class QqChannelService {
  constructor() { globalThis.__qqTrace.push(['service']); }
  async start() { globalThis.__qqTrace.push(['start']); }
  async stop() { globalThis.__qqTrace.push(['stop']); }
  state() { return { running: true }; }
}
export function createSoulChannelConnector(options) {
  globalThis.__qqTrace.push(['connector', options.petId]);
  return { respond: async () => null };
}
`,
    'utf8',
  );
  return file;
}

/** 等异步加载落地。 */
function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('QQ 渠道接线', () => {
  test('没配置就不启动（默认休眠）', () => {
    const ctx = fakeCtx();
    const log = logger();
    const started = startQqChannel({ ctx, soul: {}, log: log.sink, env: {} });
    assert.equal(started, false);
    assert.equal(ctx.cleanups.length, 0, '休眠时不该注册清理');
    assert.deepEqual(log.error, []);
  });

  test('配了模块但缺令牌：明确报错，不启动', () => {
    const ctx = fakeCtx();
    const log = logger();
    const started = startQqChannel({
      ctx,
      soul: {},
      log: log.sink,
      env: { DSH_PET_QQ_MODULE: '/tmp/x.mjs' },
    });
    assert.equal(started, false);
    assert.match(log.error.join(' '), /QGW_ONEBOT_TOKEN/);
  });

  test('正常加载：按配置建连接、用 off 的群策略、启动服务', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-'));
    try {
      const modulePath = writeFakeModule(dir);
      const ctx = fakeCtx();
      const log = logger();
      const started = startQqChannel({
        ctx,
        soul: {},
        log: log.sink,
        env: {
          DSH_PET_QQ_MODULE: modulePath,
          QGW_ONEBOT_TOKEN: 'test-token',
          DSH_PET_QQ_URL: 'ws://127.0.0.1:6799/',
          DSH_PET_QQ_PET: 'main',
        },
      });
      assert.equal(started, true);
      await settle();

      const trace = (globalThis as { __qqTrace?: unknown[][] }).__qqTrace ?? [];
      assert.deepEqual(trace[0], ['client', 'ws://127.0.0.1:6799/']);
      // 连接器是当参数先被求值的，所以它出现在 adapter 之前——这里只关心「都用上了」
      assert.ok(trace.some((one) => one[0] === 'connector' && one[1] === 'main'), '应当按 pet 建连接器');
      // 群聊默认 off：不因为「接口能发」就进群说话
      assert.ok(trace.some((one) => one[0] === 'adapter' && one[1] === 'off'), '群策略必须是 off');
      assert.ok(trace.some((one) => one[0] === 'service'));
      assert.ok(trace.some((one) => one[0] === 'start'), '应当启动服务');
      assert.match(log.info.join(' '), /渠道已接线/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('卸载时停掉服务（否则连接会挂着不退）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-'));
    try {
      const modulePath = writeFakeModule(dir);
      const ctx = fakeCtx();
      startQqChannel({
        ctx,
        soul: {},
        log: logger().sink,
        env: { DSH_PET_QQ_MODULE: modulePath, QGW_ONEBOT_TOKEN: 't' },
      });
      await settle();
      assert.equal(ctx.cleanups.length, 1);
      ctx.cleanups[0]?.();
      await settle();
      const trace = (globalThis as { __qqTrace?: unknown[][] }).__qqTrace ?? [];
      assert.ok(trace.some((one) => one[0] === 'stop'), '卸载必须调用 stop');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('加载失败只记日志，不抛（可选渠道不该拖垮宿主）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-'));
    try {
      const modulePath = writeFakeModule(dir, { throwOnImport: true });
      const log = logger();
      const started = startQqChannel({
        ctx: fakeCtx(),
        soul: {},
        log: log.sink,
        env: { DSH_PET_QQ_MODULE: modulePath, QGW_ONEBOT_TOKEN: 't' },
      });
      assert.equal(started, true, '尝试过就算启动过，失败在日志里');
      await settle();
      assert.match(log.error.join(' '), /加载网关包失败/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
