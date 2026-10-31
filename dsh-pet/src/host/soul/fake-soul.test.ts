/**
 * 假灵魂后端的单元测试：钉住 M0 的几条硬约束。
 *
 * 1. 一轮输入只打一次后端，且问答必须能被 `GET /chat` 那条读取路径取到（否则 UI 发送后重载
 *    历史会看到空窗——上游 UI 不直接展示 POST 的回复）；
 * 2. 气泡写的是与返回值同一份文本（窗口与气泡不能各说一句）；
 * 3. 失败与主动发言路径都不落模型、不写历史，避免「看起来成功」；
 * 4. 轮次时间戳严格递增（上游 UI 按 ts 分轮、按 ts 成对删，撞 ts 会并轮并误删）。
 *
 * 配置取仓库内 assets/config.jsonc（与生产同一份，不手抄第二份），历史与气泡全在内存里，
 * 不产生任何磁盘写入——这正是 soul 模式「不碰用户原 memory.json」的证据。
 * 临时目录按仓库惯例在每个用例结束时删除。
 *
 * 跑法：node --experimental-strip-types --test src/host/soul/fake-soul.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createFakeSoul, FAIL_PREFIX, type FakeSoul } from './fake-soul.ts';
import type { ConfigPaths } from '../config.ts';
import type { HostSetup } from '../plugin/setup.ts';

/** 一次写气泡的记录：[petId, 叶子名, 载荷]。 */
type Write = [string, string, Record<string, unknown>];

/** 用例上下文：只用 `after` 收尾临时目录。 */
type Ctx = { after: (fn: () => void) => void };

/** 临时工作区：用户配置隔离，默认配置指回仓库里那一份。 */
function tempWorkspace(overlay: Record<string, unknown> = {}): { configPaths: ConfigPaths; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-soul-test-'));
  const configPaths: ConfigPaths = {
    defaultFile: fileURLToPath(new URL('../../../assets/config.jsonc', import.meta.url)),
    userFile: join(dir, 'main-config.jsonc'),
    petDir: join(dir, 'pet'), // 不存在 = 无文件宠物
  };
  writeFileSync(configPaths.userFile, JSON.stringify(overlay));
  return { configPaths, dir };
}

/**
 * 造一个假后端。
 *
 * @param t - 用例上下文，用于注册临时目录清理。
 * @param opts - 用户配置覆盖、故障注入开关与时钟。
 * @returns 后端与气泡写入记录。
 */
function makeSoul(
  t: Ctx,
  opts: { overlay?: Record<string, unknown>; faultInjection?: boolean; now?: () => number; maxRounds?: number } = {},
): { soul: FakeSoul; writes: Write[] } {
  const { configPaths, dir } = tempWorkspace(opts.overlay ?? {});
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const writes: Write[] = [];
  const log = { info: (): void => {}, warn: (): void => {}, error: (): void => {} };
  const soul = createFakeSoul({
    configPaths,
    log,
    faultInjection: opts.faultInjection ?? false,
    now: opts.now,
    maxRounds: opts.maxRounds,
    state: { writePet: (petId: string, leaf: string, data: unknown) => writes.push([petId, leaf, data as Write[2]]) },
  } as unknown as Pick<HostSetup, 'configPaths' | 'log' | 'state'>);
  return { soul, writes };
}

/** 取某只宠物在假历史里的消息（按上游的 entry → petId → messages 三层结构找）。 */
async function messagesOf(soul: FakeSoul, petId: string): Promise<{ role: string; content: string; ts: number }[]> {
  const mem = await soul.readMemory();
  for (const byPet of Object.values(mem)) {
    if (byPet[petId]) return byPet[petId].messages as { role: string; content: string; ts: number }[];
  }
  return [];
}

describe('假灵魂后端（M0）', () => {
  test('一轮输入 → 一次后端调用 → 历史里出现一问一答', async (t) => {
    const { soul } = makeSoul(t);
    const result = await soul.chatWithPet('main', '你好呀');
    assert.equal(result.ok, true);
    assert.equal(soul.callCount(), 1, '每次输入只打一次后端');

    const messages = await messagesOf(soul, 'main');
    assert.equal(messages.length, 2, '一问一答必须成对写入');
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[0].ts, messages[1].ts, '同一轮共享 ts：不同 ts 会被 UI 画成两轮');
  });

  test('气泡与返回值是同一份文本，且带 anim:false 不顶掉动作', async (t) => {
    const { soul, writes } = makeSoul(t);
    const result = await soul.chatWithPet('main', '在吗');
    assert.equal(writes.length, 1, '必须恰好写一次气泡');
    const [petId, leaf, data] = writes[0];
    assert.equal(petId, 'main');
    assert.equal(leaf, 'say', '展示链路必须与上游同一条叶子');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(data.text, result.text, '窗口与气泡不能说两句不同的话');
    assert.equal(data.anim, false);
  });

  test('多轮只增不覆盖；时钟冻结在同一毫秒时轮次 ts 仍严格递增', async (t) => {
    // 冻结时钟复现最坏情况：两次输入落在同一毫秒（Windows 上 Date.now 常驻同值）。
    // 不注入时钟就测不出这条——真实调用之间夹着配置文件读盘，通常自然错开。
    const { soul } = makeSoul(t, { now: () => 1000 });
    await soul.chatWithPet('main', '第一句');
    await soul.chatWithPet('main', '第二句');
    assert.equal(soul.callCount(), 2);

    const messages = await messagesOf(soul, 'main');
    assert.equal(messages.length, 4);
    assert.equal(messages[0].ts, 1000, '第一轮用注入的时钟');
    assert.equal(messages[2].ts, 1001, '同毫秒的第二轮必须被顶到下一毫秒，否则 UI 并轮、按 ts 删除会误删');
  });

  test('故障注入开启时：返回失败、不写历史、不写气泡，但计入调用次数', async (t) => {
    const { soul, writes } = makeSoul(t, { faultInjection: true });
    const result = await soul.chatWithPet('main', FAIL_PREFIX + ' 触发错误');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'generate-error');
    assert.equal(writes.length, 0, '失败时不得写气泡');
    assert.equal((await messagesOf(soul, 'main')).length, 0, '失败时不得写历史');
    assert.equal(soul.callCount(), 1, '失败也要计数，才能证明没有二次重试');
  });

  test('故障注入关闭时：同样以 !fail 开头也按正常输入处理（不向用户暴露魔术字）', async (t) => {
    const { soul, writes } = makeSoul(t);
    const result = await soul.chatWithPet('main', FAIL_PREFIX + ' 这不是指令');
    assert.equal(result.ok, true, '默认配置下这个前缀不该变成错误');
    assert.equal(writes.length, 1);
    assert.equal((await messagesOf(soul, 'main')).length, 2);
  });

  test('未知宠物明确失败，不静默建桶', async (t) => {
    const { soul } = makeSoul(t);
    const result = await soul.chatWithPet('nobody', '喂');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'unknown-pet');
    assert.equal((await messagesOf(soul, 'nobody')).length, 0);
  });

  test('图片附件明确拒绝，不静默丢弃', async (t) => {
    const { soul, writes } = makeSoul(t);
    const result = await soul.chatWithPet('main', '看图', {
      attachmentId: 'a1',
      mediaType: 'image/png',
      bytes: 10,
      width: 1,
      height: 1,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(String(result.message), /暂不支持图片/);
    assert.equal(writes.length, 0);
  });

  test('按 ts 删除只删命中那一轮，清空则连历史一起消失', async (t) => {
    const { soul } = makeSoul(t);
    await soul.chatWithPet('main', '一');
    await soul.chatWithPet('main', '二');
    const firstTs = (await messagesOf(soul, 'main'))[0].ts;

    const removed = await soul.deleteHistory('main', [firstTs]);
    assert.equal(removed.ok, true);
    if (removed.ok) assert.equal(removed.removed, 2, '一轮 = 一对消息，按 ts 成对删，且不能连累下一轮');
    assert.equal((await messagesOf(soul, 'main')).length, 2);

    const cleared = await soul.deleteHistory('main');
    assert.equal(cleared.ok, true);
    if (cleared.ok) assert.equal(cleared.removed, 2);
    assert.equal((await messagesOf(soul, 'main')).length, 0);
  });

  test('内存历史有上限：超过后丢弃最旧的整轮，轮次序号继续累加', async (t) => {
    const { soul } = makeSoul(t, { maxRounds: 2 });
    for (let i = 1; i <= 4; i += 1) await soul.chatWithPet('main', `第${i}句`);

    const messages = await messagesOf(soul, 'main');
    assert.equal(messages.length, 4, '上限 2 轮 = 4 条消息');
    assert.equal(messages[0].content, '第3句', '丢的是最旧的整轮，不能把一问一答切开');
    assert.equal(messages[0].role, 'user');

    const fifth = await soul.chatWithPet('main', '第5句');
    assert.ok(fifth.ok && /第 5 轮/.test(fifth.text), '序号用独立计数器，裁剪后不会倒着数');
  });

  test('主动发言路径恒失败，且拒绝次数可观测', async (t) => {
    const { soul, writes } = makeSoul(t);
    const whisper = await soul.publishWhisper('main');
    assert.equal(whisper.ok, false);
    assert.equal(await soul.publishSleepTalk('main'), false);
    assert.equal(writes.length, 0, '主动发言不得写气泡');
    assert.equal(soul.proactiveRefusals(), 2, '碎碎念与梦话各记一次，便于证明循环撞上了桩');
  });

  test('残留历史清理恒为空（只对 memory.json 有意义）', async (t) => {
    const { soul } = makeSoul(t);
    assert.deepEqual(await soul.orphanHistory(), []);
    assert.deepEqual(await soul.deleteOrphans(), { ok: true, pets: 0, messages: 0 });
  });
});
