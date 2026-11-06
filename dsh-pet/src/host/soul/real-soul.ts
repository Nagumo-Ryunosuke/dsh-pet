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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BindingService,
  QqOwnerBindingService,
  createEventRecorder,
  createExtractionScheduler,
  createFactExtractor,
  createSummaryRebuilder,
  createSoul,
  DEFAULT_PERSONA_YAML,
  defaultPersonaFile,
  openSoulDatabase,
  parsePersona,
  parseScopeId,
  SqliteGrantStore,
  SqliteEventStore,
  SqliteFactStore,
  SqliteJobStore,
  SqliteSummaryStore,
  SqliteTurnStore,
  TurnHistory,
  type EventStore,
  type ExtractionScheduler,
  type ModelGateway,
  type ModelUsage,
  type Persona,
  type Summary,
  type MemoryHit,
  type Capability,
  type RecalledMemory,
  type Soul,
  type QqAccountObservation,
  type SqliteDatabase,
  type TurnStore,
  type UsageTracker,
  createUsageTracker,
  turnTsFromEventId,
  withUsage,
} from '@deepseek-pet/soul';

import { generateChat } from '../chat.ts';
import type { ChatMemoryMessage } from '../chat.ts';
import { findPetInstance, flattenPetList, readAllConfig } from '../config.ts';
import type { PetImageRef } from '../image-attachment.ts';
import type { ChatMemory } from '../plugin/chat-memory.ts';
import type { HostContext } from '../plugin/context.ts';
import type { HostSetup } from '../plugin/setup.ts';
import type { ChannelGrantView, PetRouteDeps } from '../routes/types.ts';
import { extractDailyRunsOf, memoryBudgetOf } from './budget.ts';
import { RECENT_USER_TURNS } from './recall.ts';
import { recallWithFacts } from './recall.ts';

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
export type RealSoulInput = Pick<HostSetup, 'configPaths' | 'log' | 'state'> & {
  ctx: HostContext;
  userRoot: string;
  /** 仅供隔离测试注入；生产接入前还需可信登录观察及发送前复核。 */
  experimentalQqAccountObserver?: (petId: string) => QqAccountObservation;
};

/** 真灵魂后端的额外观测点。 */
export type RealSoul = ChatMemory & {
  /** 固定标识，便于日志与测试区分后端。 */
  readonly backend: 'soul';
  /** 生效的人格 id；人格不可用时为 `undefined`。 */
  readonly personaId: string | undefined;
  /** 列出 / 检索长期记忆；存储不可用时为 `undefined`（端点会明确说「不提供」）。 */
  readonly listMemories: PetRouteDeps['listMemories'];
  /** 删除若干条记忆。 */
  readonly deleteMemories: PetRouteDeps['deleteMemories'];
  /** 列出长期事实（「她知道的事」）；存储不可用时为 `undefined`。 */
  readonly listFacts: PetRouteDeps['listFacts'];
  /** 把事实标记为「不对」（纠正，不是删除）。 */
  readonly correctFacts: PetRouteDeps['correctFacts'];
  /** 列出对话摘要（只读）；存储不可用时为 `undefined`。 */
  readonly listSummaries: PetRouteDeps['listSummaries'];
  /**
   * 灵魂实例本身，给渠道接线用（渠道消息要调 `respond(petId, input)`）。
   *
   * 只暴露给「会把消息送进来」的那一层，不挂到路由依赖上——路由拿不到它就不可能
   * 绕过 scope 直接调 `chat`。
   */
  readonly channelSoul?: Soul;
  /** 仅在显式注入测试观察器且持久存储可用时提供，不作为 HTTP 路由依赖。 */
  readonly experimentalQqOwnerBinding?: QqOwnerBindingService;
  /** 签发渠道绑定码；存储不可用时为 `undefined`。 */
  readonly issueBindCode: PetRouteDeps['issueBindCode'];
  /** 列出有效渠道绑定；存储不可用时为 `undefined`。 */
  readonly listChannelGrants: PetRouteDeps['listChannelGrants'];
  /** 撤销渠道授权并清除其记忆；存储不可用时为 `undefined`。 */
  readonly revokeChannelGrant: PetRouteDeps['revokeChannelGrant'];
  /**
   * 模型调用用量快照：按用途（对话 / 事实抽取 / 摘要重建）累计的调用次数；
   * token 永远是「未知」——宿主模型层不透明，灵魂拿不到，绝不臆造。存储不可用时为 `undefined`。
   */
  readonly usage?: () => ModelUsage;
  /**
   * 后台维护（事实抽取）。只有库可用时才有；宿主用定时器驱动。
   * 与对话主链路完全解耦：维护失败/没开始，都不影响说话。
   */
  readonly maintenance?: { tick(now?: number): Promise<void> };
};

/** 事实来源摘录的长度上限：面板上一行，长了会把条目挤散。 */
export const FACT_SOURCE_CHARS = 48;

/** 按字符截断并补省略号（单行显示用）。 */
function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? chars.slice(0, max).join('') + '…' : flat;
}

/**
 * 聊天原文的命中通道。
 *
 * `MemoryHit['via']` 还包含 `fact`（长期事实走的是另一条路），但 `/memory` 列的是聊天原文，
 * 把 `fact` 透出去会让界面标出一个不存在的来源。这里的收窄不是防御性冗余：
 * 该赋值点在条件表达式里，TypeScript 的上下文推断比看上去松（实测写 `via: 'fact'`
 * 不报错，写 `id: 999` 才报），所以把契约写在代码里而不是指望编译器。
 */
export function channelOf(via: MemoryHit['via']): 'fts' | 'substring' | 'decomposed' | undefined {
  return via === 'fts' || via === 'substring' || via === 'decomposed' ? via : undefined;
}

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
): {
  db: SqliteDatabase | null;
  turns: TurnStore;
  events: EventStore | null;
  facts: SqliteFactStore | null;
  jobs: SqliteJobStore | null;
  summaries: SqliteSummaryStore | null;
  file: string | null;
} {
  const file = join(userRoot, 'soul.db');
  try {
    const db = openSoulDatabase({ file });
    return {
      db,
      turns: new SqliteTurnStore({ database: db }),
      events: new SqliteEventStore({ database: db }),
      // 事实与任务共用同一个句柄：它们和事件在同一个文件里，分连接会互相抢写锁
      facts: new SqliteFactStore({ database: db }),
      jobs: new SqliteJobStore({ database: db }),
      // 摘要与事件同库同句柄：它和事件在同一个文件里，分连接会在同进程内抢写锁
      summaries: new SqliteSummaryStore({ database: db }),
      file,
    };
  } catch (error) {
    log.error(
      `[dsh-pet][soul] 历史落库不可用，本次运行的历史只在内存里（重启丢失）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { db: null, turns: new TurnHistory(), events: null, facts: null, jobs: null, summaries: null, file: null };
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
  try {
    mkdirSync(userRoot, { recursive: true });
  } catch (error) {
    log.warn(`[dsh-pet][soul] 用户数据目录不可用：${error instanceof Error ? error.message : String(error)}`);
  }
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
  // 记忆存储提到函数作用域：端点的列出/删除也要用它，不能困在人格可用的分支里
  let events: EventStore | null = null;
  // 渠道授权与绑定码同理：它们要在返回对象里被端点调用，而建库发生在「人格可用」的分支内
  let grantStoreRef: SqliteGrantStore | null = null;
  let bindingRef: BindingService | null = null;
  let qqOwnerBindingRef: QqOwnerBindingService | null = null;

  /** 聊天历史存储：模型上下文直接从这里读（最近几轮）；删记忆要连带删这里。 */
  let turnStore: TurnStore | null = null;

  /** 底层 SQLite 句柄：跨存储的删除要包成一个事务（任一步失败整体回滚）。 */
  let dbHandle: SqliteDatabase | null = null;
  /** 事实存储：删除单条记忆时要同步切断来源；端点后续也用它。 */
  let factStore: SqliteFactStore | null = null;
  /** 摘要存储：端点列摘要要用；它和事件/事实共用同一个句柄。 */
  let summaryStoreRef: SqliteSummaryStore | null = null;
  /**
   * 最近几轮的用户原话（每只宠物一列，只留最近 N 轮）。
   *
   * 召回时给「最近话题」用：查询本身没有字面重叠（「那个战队赢了吗」）时，最近聊到过的
   * 实体就是唯一的可靠线索。只记正文、不记时刻——它只做子串匹配，不参与排序。
   */
  const recentUserText = new Map<string, string[]>();
  /** 事实抽取器/节拍器：库可用时启用，失败只影响记忆整理，不影响说话。 */
  let scheduler: ExtractionScheduler | null = null;

  /**
   * 配置相关的告警去过重。
   *
   * 记忆预算在**每次召回**时解析（这样改配置不用重启），代价是坏配置会每轮刷一条 warn。
   * 一次写错换来满屏日志，真正的问题反而被埋掉——同样的消息只说一次。
   */
  const warnedConfig = new Set<string>();
  const warnConfigOnce = (message: string): void => {
    if (warnedConfig.has(message)) return;
    warnedConfig.add(message);
    log.warn(message);
  };

  /**
   * 取某只宠物所属条目的配置（记忆预算是条目级字段，与 `chatMemoryRounds` 同一口径）。
   *
   * 读不到（宠物已被删、配置坏了）就给空对象：召回只是少带几条往事，不该因此报错。
   * 每次召回现读一遍，是为了让用户改了 `chatMemory*` 之后不必重启应用——实测一次
   * `readAllConfig` 约 1.4ms，相对一次模型调用可以忽略。
   */
  const entryConfigOf = (petId: string): Record<string, unknown> => {
    try {
      return findPetInstance(readAllConfig(configPaths), petId)?.conf ?? {};
    } catch (error) {
      warnConfigOnce(
        `[dsh-pet][soul] 读取记忆预算配置失败（按默认值处理）：${error instanceof Error ? error.message : String(error)}`,
      );
      return {};
    }
  };
  /** 正在生成回复的轮数：抽取要让路，不与用户等待的那句话抢模型。 */
  let activeTurns = 0;
  // 用量累加器建在 if(loaded.ok) 块里，快照入口在块外的返回对象上——
  // 用这个引用跨过块作用域；人格加载失败时保持 null，端点回「不提供」
  let usageTracker: UsageTracker | null = null;
  if (loaded.ok) {
    personaId = loaded.persona.personaId;
    const echo = process.env[MODEL_ENV] === 'echo';
    if (echo) log.warn('[dsh-pet][soul] 使用回声模型（DSH_PET_SOUL_MODEL=echo）：仅用于链路验证，不调模型');
    // 模型网关：把宿主的生成能力包成「给 system + 历史 + 本次输入，回一句文本」。
    // 回声分支只服务链路验证，正常路径永远走 generateChat（内含 ctx.llm、模型候选与降级）。
    const baseModel: ModelGateway = echo
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
    // 用量计数：同一个底层网关按用途包成三份，各记各的——对话 / 事实抽取 / 摘要重建。
    // token 这一栏永远记「未知」：宿主模型层（ctx.llm）对灵魂不透明，拿不到用量，绝不臆造
    const usage = createUsageTracker();
    usageTracker = usage;
    const model = withUsage(baseModel, 'chat', usage);
    const extractModel = withUsage(baseModel, 'extract', usage);
    const summarizeModel = withUsage(baseModel, 'summarize', usage);
    // 历史与记忆：落库优先，失败退回内存（见 openStores 的说明）
    const {
      db,
      turns,
      events: opened,
      facts,
      jobs,
      summaries: summaryStore,
      file: storeFile,
    } = openStores(userRoot, log);
    events = opened;
    turnStore = turns;
    dbHandle = db;
    factStore = facts;
    summaryStoreRef = summaryStore;
    if (storeFile !== null) log.info(`[dsh-pet][soul] 历史落库：${storeFile}`);

    // 渠道授权与绑定码：与历史同库同句柄。库不可用时两者都不建——
    // 此时没有持久化，绑定也就无从谈起，路由会明确回「不提供」
    grantStoreRef = db === null ? null : new SqliteGrantStore({ database: db });
    bindingRef =
      db === null || grantStoreRef === null ? null : new BindingService({ database: db, grants: grantStoreRef });
    if (db !== null && deps.experimentalQqAccountObserver !== undefined) {
      qqOwnerBindingRef = new QqOwnerBindingService({
        database: db,
        observeAccount: deps.experimentalQqAccountObserver,
      });
    }

    // 记忆能力先在块外算好：条件展开（...?(x):{}）会让 TypeScript 丢掉上下文类型，
    // 回调参数全变隐式 any——与其到处标注，不如把可空性收敛到一个对象上
    const memoryCapabilities =
      opened === null || facts === null
        ? { memory: undefined, recall: undefined }
        : {
            // 长期记忆：每轮落两条事件，删聊天时同步清理由这一轮派生的事实。库不可用时不挂，聊天照常
            memory: createEventRecorder(opened, log, facts, summaryStore ?? undefined),
            // 召回：事实（「她知道的」）排在聊天原文之前，两者共享同一份预算。
            // 预算按条目级配置解析（chatMemoryItems / Tokens / ItemTokens / Facts），
            // 缺省 5 条 / 400 token / 单条 120 / 事实 3 条；写坏回落默认并留 warn
            recall: (petId: string, query: string, contextOldestTs?: number): RecalledMemory[] => {
              // 冷启动：重启后线索环是空的，事件表里却有历史原话——不补一次的话，
              // 近指（「那个战队」）在攒满几轮前完全失效
              if (!recentUserText.has(petId)) rebuildRecentText(petId);
              return recallWithFacts({
                petId,
                query,
                facts: facts.list(petId, { limit: 200 }),
                // 摘要不按关键词筛（它的价值是「接上上次」），只取最近几段
                summaries: summaryStore === null ? [] : summaryStore.list(petId, { limit: 5 }),
                recentText: recentUserText.get(petId) ?? [],
                contextOldestTs,
                searchEvents: () => opened.search(petId, query),
                budget: memoryBudgetOf(entryConfigOf(petId), warnConfigOnce),
              });
            },
          };

    soul = createSoul({
      persona: loaded.persona,
      model,
      // 历史落库（`<userRoot>/soul.db`）：重启后还能接上，这是 M1 第二阶段的目标
      history: turns,
      ...memoryCapabilities,
      // 渠道：授权每次现查库（撤权立刻生效），绑定码在未授权私聊里自动兑换
      ...(grantStoreRef === null ? {} : { grants: grantStoreRef }),
      ...(bindingRef === null ? {} : { binding: bindingRef }),
      ...(qqOwnerBindingRef === null ? {} : { qqOwnerBinding: qqOwnerBindingRef }),
      // 在途失效必须真的接到数据版本上：不传的话版本恒为 0，生成期间删除后
      // 旧回复照样落库——「删除使在途对话作废」就成了空话
      ...(opened === null ? {} : { dataVersionOf: (id: string) => opened.dataVersion(id) }),
      // 事务收口到一处：deleteTurns 的「删历史 + 忘记忆」自己会包事务，
      // 将来新增调用点忘包外层也不会退回半套状态
      atomic: (fn) => atomic('soul_write', fn),
      log,
    });

    // 后台事实抽取：库都可用才启用。跑不跑由节拍器决定（空闲 10 分钟 / 累计 10 条），
    // 这里只组装依赖；真正驱动在宿主侧的维护定时器里
    if (opened !== null && facts !== null && jobs !== null) {
      // 摘要存储与事件同库：库可用时它一定在；这里仍按可空处理，免得依赖装配顺序
      const rebuilder =
        summaryStore === null
          ? undefined
          : createSummaryRebuilder(
              summaryStore,
              summarizeModel,
              jobs,
              log,
              undefined,
              (id) => opened.dataVersion(id),
              // 落库三步（存新 + 撤旧 + 完成任务）整体提交：半途成功会重复调模型
              (fn) => {
                atomic('rebuild_summary', fn);
              },
            );
      const rebuildHook =
        rebuilder === undefined ? undefined : (petId: string, at: number) => rebuilder.rebuild(petId, at);
      // 每日预算是全局的，取第一个条目的配置（越界写坏时 warn 一次）
      const firstEntry = Object.values(readAllConfig(configPaths))[0] ?? {};
      scheduler = createExtractionScheduler({
        dailyMaxRuns: extractDailyRunsOf(firstEntry, warnConfigOnce),
        // 交给节拍器的是事件存储本体：它既有 listAfter（取未处理片段），也有 dataVersion
        // （删除计数）——后者让「作废在途抽取」成立：任务创建时记下的版本，落库前若被删除推进，
        // 这一批就整批丢弃、水位不前进，等下次重试绕开已删内容
        events: opened,
        jobs,
        extractor: createFactExtractor(facts, extractModel, log, summaryStore ?? undefined, (id) =>
          opened.dataVersion(id),
        ),
        pets: () =>
          flattenPetList(readAllConfig(configPaths))
            .map((pet) => String(pet.id ?? ''))
            .filter((id) => id !== ''),
        log,
        isBusy: () => activeTurns > 0,
        // 被「来源被删」拉下线的摘要：没有待抽取事件时补一条回来。
        // 任务记在 jobs（type=summarize），和抽取共用同一份每日预算
        rebuild: rebuildHook,
      });
      log.info('[dsh-pet][soul] 事实抽取已启用：空闲 10 分钟或累计 10 条触发，每天最多 4 次');
    } else {
      log.warn('[dsh-pet][soul] 事实抽取未启用（记忆库不可用）：聊天照常，长期事实不会更新');
    }
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
    | { ok: false; reason: 'provider-missing' | 'generate-error' | 'unknown-pet' | 'invalid-input'; message?: string }
  > => {
    if (soul === null) return personaUnavailable;
    if (findPetInstance(readAllConfig(configPaths), petId) === undefined) {
      return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
    }
    if (image !== undefined) {
      return { ok: false, reason: 'generate-error', message: 'soul 模式暂不支持图片附件' };
    }
    // 顺带把幂等键交给灵魂：重复到达的那一次不会二次生成，也不会在历史里多出一轮
    activeTurns += 1;
    let result: Awaited<ReturnType<Soul['chat']>>;
    try {
      result = await soul.chat(petId, text, requestId === undefined ? undefined : { requestId });
    } finally {
      activeTurns -= 1;
    }
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        message: result.message,
      };
    }
    // 记下这一轮的用户原话，给下一轮召回的「最近话题」用（指代「那个战队」时唯一的线索）。
    // 只在成功后记：失败的那一轮没进历史，也不该影响下一轮的线索。
    // 幂等回放不重复入环：同一句占两格会挤掉近指窗口里另一条线索（整环去重，防非末尾重放）
    const ring = recentUserText.get(petId) ?? [];
    if (!ring.includes(text.trim())) ring.push(text.trim());
    while (ring.length > RECENT_USER_TURNS) ring.shift();
    recentUserText.set(petId, ring);
    // 与上游同一条展示链路：气泡读的是这个叶子，窗口与气泡必然一致
    state.writePet(petId, 'say', { text: result.text, anim: false });
    // 这一轮事件已经落库，给节拍器一个「累计到 10 条」的即时检查机会；不 await，不拖慢回复
    scheduler?.notifyTurn(petId);
    return { ok: true, text: result.text };
  };

  /**
   * 「最近话题」召回线索按存活事件重建：删掉的原话不能再当线索。
   *
   * 删记忆和删历史都要走这里——缓存里留着已删原话的话，后续对话可能因这段
   * 已删内容召回其它事实，等于变相把删掉的话又用了一次。
   *
   * **绝不抛错**：这是派生态，且在删除事务提交之后跑——让它抛错会把已成功的
   * 删除谎报成「未做任何更改」。失败时**置空缓存**：宁可这轮少一条指代线索，
   * 也不能让旧缓存里的已删原话继续当召回依据。
   */
  const rebuildRecentText = (petId: string): void => {
    if (events === null) return;
    try {
      recentUserText.set(
        petId,
        events
          .list(petId, { limit: RECENT_USER_TURNS * 2, order: 'desc' })
          .filter((one) => one.role === 'user')
          .map((one) => one.text)
          .reverse(),
      );
    } catch (error) {
      recentUserText.set(petId, []);
      log.warn(
        `[dsh-pet][soul] 最近话题线索重建失败（已清空缓存；删除本身已生效）pet=${petId}：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  /**
   * 跨存储的多步写入包成一个事务：各 store 共用同一个 SQLite 句柄，
   * 外层 SAVEPOINT 罩得住它们各自的内层 SAVEPOINT。没有句柄（内存降级）就裸执行。
   */
  const atomic = <T>(name: string, fn: () => T): T => {
    if (dbHandle === null) return fn();
    dbHandle.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      dbHandle.exec(`RELEASE ${name}`);
      return out;
    } catch (error) {
      dbHandle.exec(`ROLLBACK TO ${name}`);
      dbHandle.exec(`RELEASE ${name}`);
      throw error;
    }
  };

  const deleteHistory = async (
    petId: string,
    ts?: readonly number[],
  ): Promise<
    { ok: true; removed: number } | { ok: false; reason: 'unknown-pet' | 'cleanup-failed'; message: string }
  > => {
    if (entryOf(petId) === undefined) {
      return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
    }
    try {
      // 整套（删历史 + 忘记忆）包成一个事务：清理失败要把历史一起回滚——
      // 否则轮次从界面上消失，用户再也选不中它补做清理（删记忆同款口径）
      if (soul === null) {
        // 人格不可用 ≠ 没有历史：假成功会让用户以为删了，修好人格后「已删除」的又全回来
        return {
          ok: false,
          reason: 'cleanup-failed',
          message: '人格不可用，删除未执行（历史未做任何更改）',
        };
      }
      const removed = atomic('del_history', () => soul.deleteTurns(petId, ts));
      // 已删原话退出「最近话题」线索环（与删记忆同一口径）
      rebuildRecentText(petId);
      log.info(`[dsh-pet][soul] 删除历史 pet=${petId} removed=${removed}` + (ts === undefined ? '（清空）' : ''));
      return { ok: true, removed };
    } catch (error) {
      // 已整体回滚：历史和记忆都没动，用户直接重试即可
      log.error(
        `[dsh-pet][soul] 删除历史失败（已回滚，可重试）pet=${petId}：${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        ok: false,
        reason: 'cleanup-failed',
        message: '删除未完成（未做任何更改），请重试：' + (error instanceof Error ? error.message : String(error)),
      };
    }
  };

  /** 主动发言：M1 第一步没做意图与调度，明确拒绝而不是假装成功。 */
  const whisperWarned = new Set<string>();
  const publishWhisper = async (petId: string): Promise<{ ok: false; reason: 'generate-error'; message: string }> => {
    // 调度约 5 分钟一拍：同一宠物只留一行 warn，不然日志每天几百行刷屏（fake-soul 同款口径）
    if (!whisperWarned.has(petId)) {
      whisperWarned.add(petId);
      log.warn(`[dsh-pet][soul] 拒绝碎碎念 pet=${petId}（M1 尚未实现主动发言；同一宠物只记一次）`);
    }
    return { ok: false, reason: 'generate-error', message: 'soul 模式暂不提供碎碎念' };
  };

  const publishSleepTalk = async (petId: string): Promise<boolean> => {
    if (!whisperWarned.has('sleep:' + petId)) {
      whisperWarned.add('sleep:' + petId);
      log.warn(`[dsh-pet][soul] 拒绝梦话 pet=${petId}（M1 尚未实现主动发言；同一宠物只记一次）`);
    }
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
    // 渠道接线拿它去调 respond：这里给的是灵魂实例本身，
    // 不是包装过的接口——包装会让「谁在说话」变成一层可以忘记传的东西
    ...(soul === null ? {} : { channelSoul: soul }),
    ...(qqOwnerBindingRef === null ? {} : { experimentalQqOwnerBinding: qqOwnerBindingRef }),
    // 记忆可见化：列出 / 检索 / 删除走的就是召回用的同一个存储与排序，
    // 面板里看到的就是她会想起来的
    listMemories:
      events === null
        ? undefined
        : async (petId, query, limit) => {
            if (query === undefined) {
              // 浏览：没有匹配过程，也就没有「为什么想起」
              return events.list(petId, { limit, order: 'desc' }).map((one) => ({
                id: one.id,
                occurredAt: one.occurredAt,
                role: one.role,
                text: one.text,
                kind: one.kind,
                source: one.source,
              }));
            }
            return events.search(petId, query, { candidateLimit: limit }).map((hit) => {
              // 命中通道：界面上用来解释「为什么想起这一条」
              const channel = channelOf(hit.via);
              return {
                id: hit.event.id,
                occurredAt: hit.event.occurredAt,
                role: hit.event.role,
                text: hit.event.text,
                kind: hit.event.kind,
                source: hit.event.source,
                ...(channel === undefined ? {} : { via: channel }),
              };
            });
          },
    deleteMemories:
      events === null
        ? undefined
        : async (petId, ids) => {
            // 「忘掉」按轮对齐：同一轮的两条事件同生共死——只删选中的那条，另一条
            // （比如复述了用户想忘掉内容的回复）还能被检索/抽取，她照样会提起。
            // 与删聊天历史同一口径：先按 id 解出轮次，再整轮处理（idsAt 取全量 id 供派生清理）。
            // 只认「确实属于这只宠物、确实存在」的事件 id：请求可以编造、也可以来自别的宠物，
            // 直接信它会误删当前宠物同一时间戳的整轮
            const turnTs = [
              ...new Set(
                ids
                  .map((id) => ({ id, ts: turnTsFromEventId(id) }))
                  .filter((one): one is { id: string; ts: number } => one.ts !== undefined)
                  .filter((one) => events.idsAt(petId, [one.ts]).includes(one.id))
                  .map((one) => one.ts),
              ),
            ];
            const extraIds = turnTs.length > 0 ? events.idsAt(petId, turnTs) : [];
            const targets = [...new Set([...ids, ...extraIds])];

            // 整套删除放进一个事务：软删除、派生清理、聊天原文删除要么全部成功、要么全部回滚。
            // 半途失败时条目会从面板消失，用户再也选不中它去重试——所以绝不能留下半套状态。
            // 各 store 共用同一个 SQLite 句柄，外层 SAVEPOINT 罩得住它们各自的内层 SAVEPOINT
            const cleanup = (): { removed: number; detached: number; dirtied: number; turns: number } => {
              const removed = events.softDelete(petId, targets);
              const now = Date.now();
              let detached = 0;
              if (factStore !== null) {
                for (const id of targets) detached += factStore.detachEvent(petId, id, now);
              }
              let dirtied = 0;
              if (summaryStoreRef !== null) {
                for (const id of targets) dirtied += summaryStoreRef.dirtyByEvent(petId, id, now);
              }
              if (turnTs.length > 0 && turnStore !== null) turnStore.delete(petId, turnTs);
              return { removed, detached, dirtied, turns: turnTs.length };
            };
            let done: ReturnType<typeof cleanup>;
            try {
              done = atomic('mem_delete', cleanup);
            } catch (error) {
              // 回滚后条目仍在面板里，用户可以直接重试；如实上报，绝不假成功
              const reason = error instanceof Error ? error.message : String(error);
              log.error(`[dsh-pet][soul] 删除记忆失败（已回滚，可重试）pet=${petId}：${reason}`);
              // 挂上原始异常：报错文案给用户看，cause 给排查看（原始栈不丢）
              throw new Error(`删除未完成（未做任何更改），请重试：${reason}`, { cause: error });
            }
            // 「最近话题」的召回线索按存活事件重建：删掉的原话不再当线索（自愈式，不怕漂移）
            rebuildRecentText(petId);
            log.info(
              `[dsh-pet][soul] 删除记忆 pet=${petId} removed=${done.removed}` +
                (done.detached > 0 ? ` 派生事实来源 ${done.detached} 条` : '') +
                (done.dirtied > 0 ? ` 摘要退出 ${done.dirtied} 条` : '') +
                (done.turns > 0 ? ` 聊天轮次 ${done.turns} 轮` : '') +
                ' 清理范围=运行系统不可见（磁盘 WAL/备份未清理）',
            );
            // cleanup 永远是 system-invisible：本操作只软删除，不会去动磁盘上的 WAL / 备份；
            // 要彻底清除得走备份轮转或手动清理，那是一条独立路径。UI 据此如实区分两层
            return {
              removed: done.removed,
              detached: done.detached,
              dirtied: done.dirtied,
              turnsRemoved: done.turns,
              cleanup: 'system-invisible' as const,
            };
          },
    // 事实可见化：面板里看到的就是提示词会用的事实（同一个库、同一条 active 过滤）
    listFacts:
      factStore === null
        ? undefined
        : async (petId, limit) => {
            const store = factStore;
            // 来源摘要一次查完（不是每条一次）：面板上「来自哪句话」要跟着列表一起出现
            const digest = store.sourceDigest(petId);
            return store.list(petId, { limit }).map((fact) => {
              const source = digest[fact.id];
              return {
                id: fact.id,
                subject: fact.subject,
                predicate: fact.predicate,
                value: fact.value,
                confidence: fact.confidence,
                updatedAt: fact.updatedAt,
                sources: source?.count ?? 0,
                ...(source?.latest === undefined
                  ? {}
                  : {
                      from: {
                        text: clipText(source.latest.text, FACT_SOURCE_CHARS),
                        occurredAt: source.latest.occurredAt,
                      },
                    }),
              };
            });
          },
    // 摘要可见化：只列 active（dirty/retracted 既不参与召回，也不该出现在界面上）
    listSummaries:
      summaryStoreRef === null
        ? undefined
        : async (petId, limit) => {
            const store = summaryStoreRef;
            const rows: Summary[] = store.list(petId, { limit });
            return rows.map((one) => ({
              id: one.id,
              periodStart: one.periodStart,
              periodEnd: one.periodEnd,
              text: one.text,
            }));
          },
    correctFacts:
      factStore === null
        ? undefined
        : async (petId, ids) => {
            const store = factStore;
            const now = Date.now();
            let corrected = 0;
            for (const id of ids) if (store.supersede(petId, id, now)) corrected += 1;
            log.info(`[dsh-pet][soul] 纠正事实 pet=${petId} corrected=${corrected}/${ids.length}`);
            return corrected;
          },
    // 渠道绑定：绑进来的 QQ 才能跟她说上话。
    // 码的明文只在这一次返回值里出现——库里存的是哈希，刷新页面就得重新生成
    issueBindCode: ((): RealSoul['issueBindCode'] => {
      const service = bindingRef;
      if (service === null) return undefined;
      return async (petId) => {
        const issued = service.issue(petId);
        // 只记到期时间与宠物，不记码本身
        log.info(`[dsh-pet][soul] 签发渠道绑定码 pet=${petId} 到期=${new Date(issued.expiresAt).toISOString()}`);
        return issued;
      };
    })(),
    // 只列未撤销的：撤销是「立刻不能再看」，界面上还挂着已断开的记录会让人以为没生效
    listChannelGrants: ((): RealSoul['listChannelGrants'] => {
      const store = grantStoreRef;
      if (store === null) return undefined;
      return async () =>
        store
          .list()
          .filter((record) => record.revokedAt === null)
          .map((record) => grantViewOf(record.scopeId, record.capabilities, record.grantedAt));
    })(),
    // 断开 = 撤权 + 清掉那段对话与派生记忆。只撤权不清数据的话，
    // 用户看到「已断开」而磁盘上还留着，下次重新绑定全回来
    revokeChannelGrant: ((): RealSoul['revokeChannelGrant'] => {
      const store = grantStoreRef;
      const current = soul;
      if (store === null || current === null) return undefined;
      return async (petId, scopeId) => {
        const scope = parseScopeId(scopeId);
        // 认不出来的标识不给删：宁可报错，也不能猜一个 scope 去清数据
        if (scope === null) throw new Error('无法识别的渠道会话标识');
        const result = current.revokeScope(petId, scope);
        log.info(
          `[dsh-pet][soul] 断开渠道 pet=${petId} 撤权=${result.revoked ? '是' : '无记录'} 清除=${result.removed} 条`,
        );
        return result;
      };
    })(),
    // 已删宠物的残留历史：配置里已经没有这只宠物，但库里还有它的历史。
    // 不能再从面板选中它——看不见、删不掉的残留只能改库，且 petId 被复用时旧内容会被召回。
    // 这里如实列出来（entry 无从恢复，用 petId 顶替；SQLite 只存 pet_id）
    orphanHistory: async () => {
      if (dbHandle === null) return [];
      const known = new Set(
        flattenPetList(readAllConfig(configPaths))
          .map((pet) => String(pet.id ?? ''))
          .filter((id) => id !== ''),
      );
      const rows = dbHandle
        .prepare('SELECT pet_id, COUNT(*) AS n, MAX(ts) AS last FROM turns GROUP BY pet_id')
        .all() as { pet_id: string; n: number | bigint; last: number | bigint }[];
      return rows
        .filter((row) => row.pet_id !== '' && !known.has(row.pet_id))
        .map((row) => ({
          entry: row.pet_id,
          petId: row.pet_id,
          messages: Number(row.n),
          lastTs: Number(row.last),
        }));
    },
    // 清残留与「删历史」同口径：事件软删（含派生清理、推进数据版本）+ 删 turns，整体一个事务
    deleteOrphans: async () => {
      if (dbHandle === null) return { ok: true as const, pets: 0, messages: 0 };
      const orphans = await (async () => {
        const known = new Set(
          flattenPetList(readAllConfig(configPaths))
            .map((pet) => String(pet.id ?? ''))
            .filter((id) => id !== ''),
        );
        const rows = dbHandle.prepare('SELECT pet_id, COUNT(*) AS n FROM turns GROUP BY pet_id').all() as {
          pet_id: string;
          n: number | bigint;
        }[];
        return rows.filter((row) => row.pet_id !== '' && !known.has(row.pet_id));
      })();
      let pets = 0;
      let messages = 0;
      let failed = 0;
      for (const orphan of orphans) {
        const petId = orphan.pet_id;
        try {
          atomic(`orphan_${pets}`, () => {
            events?.softDeleteAll(petId);
            factStore?.retractAll(petId, Date.now());
            summaryStoreRef?.retractAll(petId, Date.now());
            messages += turnStore?.delete(petId).removed ?? 0;
          });
          pets += 1;
          // 已删宠物的原话退出「最近话题」环：petId 被复用后，旧原话不能再当召回线索
          recentUserText.delete(petId);
        } catch (error) {
          // 逐只失败要计数上报：恒 ok:true 会让用户以为清干净了，下回它又出现在列表里
          failed += 1;
          log.error(
            `[dsh-pet][soul] 清理残留历史失败 pet=${petId}：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return { ok: true as const, pets, messages, failed };
    },
    // 后台维护入口：宿主定时器驱动；库不可用时没有这个入口
    maintenance: scheduler === null ? undefined : { tick: (now?: number) => scheduler!.tick(now) },
    // 模型调用用量：人格加载成功（网关已包装）时才有；否则不提供
    usage: usageTracker === null ? undefined : () => usageTracker!.snapshot(),
    getActivePetId: () => activePetId,
    setActivePetId: (id: string) => {
      activePetId = id;
    },
  };
}

/** 能力 → 面板上的中文短语。顺序与 {@link CAPABILITIES} 一致。 */
const CAPABILITY_TEXT: Record<Capability, string> = {
  reply: '可以回话',
  read_group: '可以在群里说话',
  share_desktop_memory: '能看到桌面记忆',
  proactive: '可以主动找你',
};

/**
 * 把一条授权记录翻成面板条目。
 *
 * `scopeId` 里的 QQ 号会显示出来：面板在本机，用户要认得出是谁；
 * 它不进日志、不进提示词（日志只记 scope 摘要，见灵魂侧 `describeScope`）。
 *
 * @param scopeId - `qq:账号:形态:会话:发言人`。
 * @param capabilities - 已授予的能力。
 * @param grantedAt - 授予时刻。
 * @returns 面板条目。
 */
function grantViewOf(scopeId: string, capabilities: readonly Capability[], grantedAt: number): ChannelGrantView {
  const scope = parseScopeId(scopeId);
  const display =
    scope === null
      ? scopeId
      : scope.conversationType === 'group'
        ? `群 ${scope.conversationId} 里的 ${scope.actorId}`
        : `QQ ${scope.actorId}`;
  return {
    scopeId,
    display,
    capabilities: capabilities.map((one) => CAPABILITY_TEXT[one]),
    grantedAt,
  };
}
