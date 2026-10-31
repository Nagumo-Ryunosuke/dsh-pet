/**
 * M0 假灵魂后端：同进程、纯内存、不调用任何模型。
 *
 * 目的只有一个——证明聊天入口可以整段换成另一套后端，而原聊天窗口、历史读取与气泡照常工作：
 * 1. 一轮问答写进进程内 Map，由 `GET /chat` 读出（**不写 memory.json**，不碰用户原历史）；
 * 2. 用与上游同一条写叶链路更新气泡（`state.writePet(petId, 'say', …)`），保证「窗口显示」
 *    与「气泡显示」是同一份文本；
 * 3. 主动发言（碎碎念 / 梦话）一律返回失败，绝不落到上游模型。
 *
 * 返回类型显式声明为 `ChatMemory`：接口一旦与上游漂移，typecheck 会直接失败，不会静默错位。
 * 真实灵魂（M1）替换本文件即可，装配处不需要再改。
 * @module dsh-pet/src/host/soul/fake-soul
 */

import { findPetInstance, flattenPetList, readAllConfig, removeRoundsByTs } from '../config.ts';
import type { ChatMemory } from '../plugin/chat-memory.ts';
import type { HostSetup } from '../plugin/setup.ts';
import type { ChatMemoryMessage } from '../chat.ts';
import type { PetImageRef } from '../image-attachment.ts';

/** 假后端的输入：只用跑配置解析、写气泡和日志这三件事。 */
export type FakeSoulInput = Pick<HostSetup, 'configPaths' | 'log' | 'state'>;

/** 触发一次模拟失败的输入前缀（M0 验收「失败时保留输入并提示错误」用）。 */
export const FAIL_PREFIX = '!fail';

/** 一轮问答的两种结果，与上游 ChatMemory.chatWithPet 完全同形。 */
type FakeReply =
  | { ok: true; text: string; image?: string }
  | { ok: false; reason: 'provider-missing' | 'generate-error' | 'unknown-pet'; message?: string };

/** 假后端对外暴露的额外观测点（不进 ChatMemory 契约，只给测试与日志用）。 */
export type FakeSoul = ChatMemory & {
  /** 已受理的对话轮数（含失败，用来证明「每次输入只打一次后端」）。 */
  callCount: () => number;
  /** 固定标识，便于日志与测试区分后端。 */
  readonly backend: 'soul-fake';
};

/** 记忆轮数规则与上游一致：条目级 `chatMemoryRounds`，非法或缺失回落 5。 */
function roundsOf(conf: Record<string, unknown>): number {
  const v = Number(conf.chatMemoryRounds);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5;
}

/**
 * 创建假灵魂后端。
 *
 * @param deps - 配置路径、日志与状态写入器（由装配处注入，不读全局）。
 * @returns 满足 `ChatMemory` 形状的后端，外加调用计数。
 */
export function createFakeSoul(deps: FakeSoulInput): FakeSoul {
  const { configPaths, log, state } = deps;
  /** 隔离的进程内历史：petId → 消息数组。绝不落到 memory.json。 */
  const messagesByPet = new Map<string, ChatMemoryMessage[]>();
  /** 当前活跃宠物（与上游相同的语义：/pet 选择、命令与余额共用）。 */
  let activePetId = '';
  let calls = 0;

  /** 定位宠物所属条目（素材根）：上游用 `mem[entry][petId]` 取历史，这里必须同构。 */
  const entryOf = (petId: string): string | undefined => {
    const found = findPetInstance(readAllConfig(configPaths), petId);
    return found?.entry;
  };

  /** 按上游的嵌套形状回吐隔离历史：{ <条目>: { <petId>: { messages } } }。 */
  const readMemory = async (): Promise<Record<string, Record<string, { messages: ChatMemoryMessage[] }>>> => {
    const cfg = readAllConfig(configPaths);
    const out: Record<string, Record<string, { messages: ChatMemoryMessage[] }>> = {};
    for (const pet of flattenPetList(cfg)) {
      const petId = String(pet.id ?? '');
      if (!petId) continue;
      const entry = findPetInstance(cfg, petId)?.entry ?? petId;
      (out[entry] ??= {})[petId] = { messages: messagesByPet.get(petId) ?? [] };
    }
    return out;
  };

  /** 记忆文件路径：soul 模式没有文件，仅用于日志里说明「读的不是 memory.json」。 */
  const memoryPath = '(soul: in-memory)';

  /**
   * 受理一轮对话：落隔离历史 + 写气泡，一步都不碰模型。
   *
   * @param petId - 目标宠物实例 id。
   * @param text - 已被路由层 trim 并校验过长度的正文。
   * @param image - 图片引用；M0 明确不支持，收到即拒绝（不静默丢弃）。
   * @returns 与上游同形的结果。
   */
  const chatWithPet = async (petId: string, text: string, image?: PetImageRef): Promise<FakeReply> => {
    calls += 1;
    const cfg = readAllConfig(configPaths);
    const found = findPetInstance(cfg, petId);
    if (!found) {
      log.warn(`[dsh-pet][soul] 未知宠物 pet=${petId}（第 ${calls} 次调用）`);
      return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
    }
    // 图片：M0 没有后端能处理它，明确拒绝并说明，避免「看起来发送成功但没有回复」。
    if (image !== undefined) {
      log.warn(`[dsh-pet][soul] 拒绝图片附件 pet=${petId}（M0 未实现）`);
      return { ok: false, reason: 'generate-error', message: 'soul 模式（M0）暂不支持图片附件' };
    }
    // 失败路径：不写历史、不写气泡，让 UI 走它自己的错误分支（输入保留）。
    if (text.startsWith(FAIL_PREFIX)) {
      log.warn(`[dsh-pet][soul] 模拟失败 pet=${petId} 第 ${calls} 次调用，len=${text.length}`);
      return { ok: false, reason: 'generate-error', message: '假后端按测试指令返回失败（M0）' };
    }

    const list = messagesByPet.get(petId) ?? [];
    const round = Math.floor(list.length / 2) + 1;
    // 固定回复：不含输入正文，避免看起来像模型生成，也避免把用户原话写进日志。
    const reply = `（假灵魂）第 ${round} 轮收到，M0 假后端不生成内容。`;
    const ts = Date.now();
    list.push({ role: 'user', content: text, ts });
    list.push({ role: 'assistant', content: reply, ts });
    messagesByPet.set(petId, list);
    // 与上游同一条展示链路：气泡读的是这个叶子，因此窗口与气泡必然一致。
    state.writePet(petId, 'say', { text: reply, anim: false });
    log.info(`[dsh-pet][soul] 受理一轮 pet=${petId} 第 ${round} 轮 调用 ${calls} 次 输入 ${text.length} 字`);
    return { ok: true, text: reply };
  };

  /**
   * 删除隔离历史：`ts` 缺省 = 清空该宠物，给了 ts = 只删命中的轮（与上游成对删同义）。
   *
   * @param petId - 目标宠物实例 id。
   * @param ts - 要删除的轮次时间戳。
   * @returns 删除数量。
   */
  const deleteHistory = async (
    petId: string,
    ts?: readonly number[],
  ): Promise<{ ok: true; removed: number } | { ok: false; reason: 'unknown-pet'; message: string }> => {
    if (entryOf(petId) === undefined) {
      return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
    }
    const list = messagesByPet.get(petId) ?? [];
    const kept = ts === undefined ? [] : removeRoundsByTs(list, ts).messages;
    const removed = list.length - kept.length;
    if (kept.length > 0) messagesByPet.set(petId, kept);
    else messagesByPet.delete(petId);
    log.info(`[dsh-pet][soul] 删除历史 pet=${petId} removed=${removed}` + (ts === undefined ? '（清空）' : ''));
    return { ok: true, removed };
  };

  /** 主动碎碎念：soul 模式不提供，返回失败让调用方显式看到，不落到上游模型。 */
  const publishWhisper = async (petId: string): Promise<{ ok: false; reason: 'generate-error'; message: string }> => {
    log.warn(`[dsh-pet][soul] 拒绝碎碎念 pet=${petId}（soul 模式未实现主动发言）`);
    return { ok: false, reason: 'generate-error', message: 'soul 模式（M0）不提供碎碎念' };
  };

  /** 梦话：同上，永远不生成。 */
  const publishSleepTalk = async (petId: string): Promise<boolean> => {
    log.warn(`[dsh-pet][soul] 拒绝梦话 pet=${petId}（soul 模式未实现主动发言）`);
    return false;
  };

  return {
    backend: 'soul-fake' as const,
    callCount: () => calls,
    lastWhisperAt: new Map<string, number>(),
    memoryPath,
    readMemory,
    memoryRounds: roundsOf,
    publishWhisper,
    publishSleepTalk,
    chatWithPet,
    deleteHistory,
    // 残留历史清理只对 memory.json 有意义：soul 模式恒为空，接口保留以免路由缺少依赖。
    orphanHistory: async () => [],
    deleteOrphans: async () => ({ ok: true as const, pets: 0, messages: 0 }),
    getActivePetId: () => activePetId,
    setActivePetId: (id: string) => {
      activePetId = id;
    },
  };
}
