/**
 * 真灵魂后端（M1 第一步）：把 `@deepseek-pet/soul` 适配成上游的 `ChatMemory` 形状。
 *
 * 分工：
 * - **灵魂**（`@deepseek-pet/soul`）负责人格、提示词、历史与编排，不碰宿主；
 * - **身体**（本文件）负责三件宿主相关的事：定位人格文件、把模型能力以网关形式注入、
 *   把结果写进既有的展示链路（`state.writePet('say')`）。
 *
 * 模型走的是宿主已有的 `generateChat`（内含 `ctx.llm`、模型候选与降级），
 * 也就是 ADR-001 说的「优先注入宿主已有能力」——灵魂因此不必持有任何凭据。
 *
 * 人格加载是**同步**的：`apply()` 不能 await，而人格文件很小。读不到或校验失败时
 * 不猜、不补默认值：把后端降级成「明确报错」而不是静默用旧人设（见 docs/SOUL.md 第 2 节）。
 * @module dsh-pet/src/host/soul/real-soul
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createEventRecorder,
  createSoul,
  DEFAULT_PERSONA_YAML,
  defaultPersonaFile,
  openSoulDatabase,
  parsePersona,
  SqliteEventStore,
  SqliteTurnStore,
  trimToBudget,
  TurnHistory,
  type EventStore,
  type ModelGateway,
  type Persona,
  type RecalledMemory,
  type Soul,
  type TurnStore,
} from '@deepseek-pet/soul';

import { generateChat } from '../chat.ts';
import type { ChatMemoryMessage } from '../chat.ts';
import { findPetInstance, flattenPetList, readAllConfig } from '../config.ts';
import type { PetImageRef } from '../image-attachment.ts';
import type { ChatMemory } from '../plugin/chat-memory.ts';
import type { HostContext } from '../plugin/context.ts';
import type { HostSetup } from '../plugin/setup.ts';

/** 指定人格文件的环境变量（不设则用用户数据目录下的 persona.yaml）。 */
export const PERSONA_ENV = 'DSH_PET_PERSONA';

/**
 * 模型网关的测试开关：`DSH_PET_SOUL_MODEL=echo` 时用回声模型，不调宿主模型。
 *
 * 存在的意义只有一个：在拿不到模型凭据的环境（隔离 profile、CI）里，把「人格 → 提示词 →
 * 模型 → 回复 → 气泡 → 历史」这条链路整段走通。正常使用永远不该打开它。
 */
export const MODEL_ENV = 'DSH_PET_SOUL_MODEL';

/** 真灵魂后端的输入。 */
export type RealSoulInput = Pick<HostSetup, 'configPaths' | 'log' | 'state'> & { ctx: HostContext; userRoot: string };

/** 真灵魂后端的额外观测点。 */
export type RealSoul = ChatMemory & {
  /** 固定标识，便于日志与测试区分后端。 */
  readonly backend: 'soul';
  /** 生效的人格 id；人格不可用时为 `undefined`。 */
  readonly personaId: string | undefined;
};

/** 与上游一致：条目级 `chatMemoryRounds`，非法或缺失回落 5。 */
function roundsOf(conf: Record<string, unknown>): number {
  const v = Number(conf.chatMemoryRounds);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5;
}

/** 同步读人格：失败时返回原因，由调用方决定怎么降级。 */
function readPersona(file: string): { ok: true; persona: Persona } | { ok: false; message: string } {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    return {
      ok: false,
      message: `人格文件读不到：${file}（${error instanceof Error ? error.message : String(error)}）`,
    };
  }
  try {
    return { ok: true, persona: parsePersona(raw) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 依次尝试若干候选路径，返回第一个读成功的人格（附带实际用到的文件）。 */
function readFirst(
  files: readonly string[],
): { ok: true; persona: Persona; file: string } | { ok: false; message: string } {
  let last: { ok: false; message: string } = { ok: false, message: '没有可读的人格文件候选' };
  for (const file of files) {
    const result = readPersona(file);
    if (result.ok) return { ok: true, persona: result.persona, file };
    last = result;
  }
  return last;
}

/**
 * 打开历史与记忆：优先落库，装不上才退回内存。
 *
 * 两者共用一个句柄是刻意的：它们写在同一个文件里，两条连接会在同一进程内互相抢写锁，
 * 迁移也会变成「谁先打开谁建表」。记忆不可用时退回 `null`——聊天照常，只是不记长期记忆。
 *
 * 这里**允许降级**但必须说得出来：数据库不可用时宠物照样能说话，只是重启会丢历史——
 * 对一个每天在用的桌面伙伴，这比「因为 SQLite 不可用就完全不回复」体验好得多。
 * 代价是必须留一行 error，让人知道当前不是持久化状态。
 */
function openStores(
  userRoot: string,
  log: HostSetup['log'],
): { turns: TurnStore; events: EventStore | null; file: string | null } {
  const file = join(userRoot, 'soul.db');
  try {
    const db = openSoulDatabase({ file });
    return {
      turns: new SqliteTurnStore({ database: db }),
      events: new SqliteEventStore({ database: db }),
      file,
    };
  } catch (error) {
    log.error(
      `[dsh-pet][soul] 历史落库不可用，本次运行的历史只在内存里（重启丢失）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { turns: new TurnHistory(), events: null, file: null };
  }
}

/**
 * 创建真灵魂后端。
 *
 * @param deps - 配置路径、日志、状态写入器与宿主上下文（用于调模型）。
 * @returns 满足 `ChatMemory` 形状的后端。
 */
export function createRealSoul(deps: RealSoulInput): RealSoul {
  const { configPaths, ctx, log, state, userRoot } = deps;
  // 人格放在用户数据目录（可编辑），首次运行用包内默认值播种；显式给 DSH_PET_PERSONA
  // 则完全尊重那个路径（不存在就直接报错，不悄悄播种到别处）。
  const override = process.env[PERSONA_ENV];
  const personaFile = override ?? join(userRoot, 'persona.yaml');
  if (override === undefined && !existsSync(personaFile)) {
    try {
      writeFileSync(personaFile, DEFAULT_PERSONA_YAML, 'utf8');
      log.info(`[dsh-pet][soul] 已写入默认人格，可直接编辑：${personaFile}`);
    } catch (error) {
      log.warn(
        `[dsh-pet][soul] 默认人格写入失败（将退回包内副本）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // 用户目录里没有（且写了也没成功）时，退回包内那份，保证首次运行一定能说话
  const candidates = [personaFile, defaultPersonaFile()];
  const loaded = readFirst(candidates);
  let soul: Soul | null = null;
  let personaId: string | undefined;
  if (loaded.ok) {
    personaId = loaded.persona.personaId;
    const echo = process.env[MODEL_ENV] === 'echo';
    if (echo) log.warn('[dsh-pet][soul] 使用回声模型（DSH_PET_SOUL_MODEL=echo）：仅用于链路验证，不调模型');
    // 模型网关：把宿主的生成能力包成「给 system + 历史 + 本次输入，回一句文本」。
    // 回声分支只服务链路验证，正常路径永远走 generateChat（内含 ctx.llm、模型候选与降级）。
    const model: ModelGateway = echo
      ? { complete: async (request) => ({ text: `（回声）收到 ${request.userText.length} 个字。` }) }
      : {
          complete: async (request) => {
            const result = await generateChat({
              ctx,
              system: request.system,
              history: request.messages as readonly ChatMemoryMessage[],
              userText: request.userText,
              // M1 不做表情包联动与动作标记：这两条是上游对话路径的扩展，等灵魂自己有策略再接
              pool: [],
              actions: [],
            });
            if (!result.ok) {
              throw new Error(result.reason + (result.message === undefined ? '' : '：' + result.message));
            }
            return { text: result.text };
          },
        };
    // 历史与记忆：落库优先，失败退回内存（见 openStores 的说明）
    const { turns, events, file: storeFile } = openStores(userRoot, log);
    if (storeFile !== null) log.info(`[dsh-pet][soul] 历史落库：${storeFile}`);

    soul = createSoul({
      persona: loaded.persona,
      model,
      // 历史落库（`<userRoot>/soul.db`）：重启后还能接上，这是 M1 第二阶段的目标
      history: turns,
      // 长期记忆：每轮落两条事件，删聊天时同步遗忘。库不可用时不挂，聊天照常
      ...(events === null
        ? {}
        : {
            memory: createEventRecorder(events, log),
            // 召回：按当前输入查事件库，按默认预算裁剪（最多 5 条 / 400 token / 单条 120）
            recall: (petId: string, query: string): RecalledMemory[] =>
              trimToBudget(events.search(petId, query)).map((hit) => ({
                id: hit.event.id,
                occurredAt: hit.event.occurredAt,
                role: hit.event.role,
                text: hit.event.text,
              })),
          }),
      log,
    });
    log.info(`[dsh-pet][soul] 人格已加载 id=${personaId} v=${loaded.persona.version}（${loaded.file}）`);
  } else {
    // 停用生成、保留身体其它能力：这是设计里写明的降级方式，不静默换回旧人设
    log.error(`[dsh-pet][soul] 人格不可用，已停用对话生成：${loaded.message}`);
  }

  let activePetId = '';

  /** 人格不可用时的统一拒绝：说明原因，别让用户以为宠物坏了。 */
  const personaUnavailable = {
    ok: false as const,
    reason: 'generate-error' as const,
    message: `人格文件不可用，暂时无法对话（${personaFile}）`,
  };

  /** 定位宠物所属条目：上游用 `mem[entry][petId]`，这里必须同构。 */
  const entryOf = (petId: string): string | undefined => findPetInstance(readAllConfig(configPaths), petId)?.entry;

  const readMemory = async (): Promise<Record<string, Record<string, { messages: ChatMemoryMessage[] }>>> => {
    const cfg = readAllConfig(configPaths);
    const out: Record<string, Record<string, { messages: ChatMemoryMessage[] }>> = {};
    for (const pet of flattenPetList(cfg)) {
      const petId = String(pet.id ?? '');
      if (!petId) continue;
      const entry = findPetInstance(cfg, petId)?.entry ?? petId;
      const turns = soul === null ? [] : soul.turns(petId);
      out[entry] ??= {};
      out[entry][petId] = { messages: turns.map((m) => ({ role: m.role, content: m.content, ts: m.ts })) };
    }
    return out;
  };

  const chatWithPet = async (
    petId: string,
    text: string,
    image?: PetImageRef,
    requestId?: string,
  ): Promise<
    | { ok: true; text: string; image?: string }
    | { ok: false; reason: 'provider-missing' | 'generate-error' | 'unknown-pet'; message?: string }
  > => {
    if (soul === null) return personaUnavailable;
    if (findPetInstance(readAllConfig(configPaths), petId) === undefined) {
      return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
    }
    if (image !== undefined) {
      return { ok: false, reason: 'generate-error', message: 'soul 模式暂不支持图片附件' };
    }
    // 顺带把幂等键交给灵魂：重复到达的那一次不会二次生成，也不会在历史里多出一轮
    const result = await soul.chat(petId, text, requestId === undefined ? undefined : { requestId });
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason === 'invalid-input' ? 'generate-error' : result.reason,
        message: result.message,
      };
    }
    // 与上游同一条展示链路：气泡读的是这个叶子，窗口与气泡必然一致
    state.writePet(petId, 'say', { text: result.text, anim: false });
    return { ok: true, text: result.text };
  };

  const deleteHistory = async (
    petId: string,
    ts?: readonly number[],
  ): Promise<{ ok: true; removed: number } | { ok: false; reason: 'unknown-pet'; message: string }> => {
    if (entryOf(petId) === undefined) {
      return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
    }
    const removed = soul === null ? 0 : soul.deleteTurns(petId, ts);
    log.info(`[dsh-pet][soul] 删除历史 pet=${petId} removed=${removed}` + (ts === undefined ? '（清空）' : ''));
    return { ok: true, removed };
  };

  /** 主动发言：M1 第一步没做意图与调度，明确拒绝而不是假装成功。 */
  const publishWhisper = async (petId: string): Promise<{ ok: false; reason: 'generate-error'; message: string }> => {
    log.warn(`[dsh-pet][soul] 拒绝碎碎念 pet=${petId}（M1 尚未实现主动发言）`);
    return { ok: false, reason: 'generate-error', message: 'soul 模式暂不提供碎碎念' };
  };

  const publishSleepTalk = async (petId: string): Promise<boolean> => {
    log.warn(`[dsh-pet][soul] 拒绝梦话 pet=${petId}（M1 尚未实现主动发言）`);
    return false;
  };

  return {
    backend: 'soul' as const,
    personaId,
    lastWhisperAt: new Map<string, number>(),
    memoryPath: `(soul: ${personaFile})`,
    readMemory,
    memoryRounds: roundsOf,
    publishWhisper,
    publishSleepTalk,
    chatWithPet,
    deleteHistory,
    orphanHistory: async () => [],
    deleteOrphans: async () => ({ ok: true as const, pets: 0, messages: 0 }),
    getActivePetId: () => activePetId,
    setActivePetId: (id: string) => {
      activePetId = id;
    },
  };
}
