/**
 * 路由层的依赖契约：`apply` 在挂载时构造一次，各路由模块只读消费。
 *
 * 显式依赖是这一层的全部意义——路由不再从 `apply` 的闭包里"抓"变量，
 * 于是每个领域模块都能单独读、单独改、单独测，改路由不必改装配。
 * 不负责生命周期：store 的创建与销毁归 `apply`，路由只调用。
 * @module dsh-pet/src/host/routes/types
 */
import type { ChatMemoryMessage } from '../chat.ts';
import type { ConfigPaths } from '../config.ts';
import type { RouteResult } from '../http.ts';
import type { ModelUsage } from '@deepseek-pet/soul';
import type { PetImageRef } from '../image-attachment.ts';
import type { LockStore } from '../lock.ts';
import type { FileLogger } from '../log-file.ts';
import type { MenuRegistry } from '../menu.ts';
import type { PlaybackStore } from '../playback.ts';
import type { PoseStore } from '../pose.ts';
import type { SleepStore } from '../sleep.ts';
import type { PollStateStore } from '../state.ts';
import type { VoiceTarget } from '../surface.ts';
import type { TodoStore } from '../todo/store.ts';
import type { HearService } from '../voice/hear.ts';
import type { VoiceService } from '../voice/speak.ts';
import type { WorkStatusStore } from '../work-status.ts';

/** 一条长期记忆（列表与检索共用的形状）。 */
export interface MemoryItem {
  /** 稳定 id，删除按它定位。 */
  readonly id: string;
  /** 发生时刻（毫秒）。 */
  readonly occurredAt: number;
  /** 说话方：`user` / `assistant`。 */
  readonly role: string;
  /** 正文。 */
  readonly text: string;
  /** 事件种类（`user_message` / `assistant_message`）。 */
  readonly kind: string;
  /** 来源（`chat` = 用户在宠物聊天里主动说的）。 */
  readonly source: string;
  /**
   * 检索命中走的通道（只有带 `q=` 检索时才有）。
   *
   * 界面上用来回答「为什么想起这一条」：原文命中 / 短词回退 / 拆词匹配。
   * 浏览全部时没有匹配过程，所以缺省。
   */
  readonly via?: 'fts' | 'substring' | 'decomposed';
}

/** 一条长期事实（`GET /facts` 的条目，只取显示与纠错用到的字段）。 */
export interface FactItem {
  /** 稳定 id，「这条不对」按它定位。 */
  readonly id: string;
  /** 关于谁/什么。 */
  readonly subject: string;
  /** 属性名。 */
  readonly predicate: string;
  /** 属性值。 */
  readonly value: string;
  /** 模型自报的置信度 `[0,1]`，只作展示参考。 */
  readonly confidence: number;
  /** 最后更新时间（毫秒）。 */
  readonly updatedAt: number;
  /** 还活着的来源条数（她是从几处对话里提炼出这条的）。 */
  readonly sources: number;
  /** 最新一处来源的正文与时刻：回答「你从哪知道的」的那句话。 */
  readonly from?: { readonly text: string; readonly occurredAt: number };
}

/** 一段对话摘要（`GET /summaries` 的条目）。 */
export interface SummaryItem {
  /** 稳定 id（「宠物 + 起止时刻」确定）。 */
  readonly id: string;
  /** 覆盖范围起点（毫秒）。 */
  readonly periodStart: number;
  /** 覆盖范围终点（毫秒）。 */
  readonly periodEnd: number;
  /** 梗概正文。 */
  readonly text: string;
}

/**
 * 记忆删除回执：把「删到了什么、清到了哪一层」一次说清。
 *
 * 删除是软删除（退出检索、原文留痕），并且会推进数据版本让在途的后台抽取作废——
 * 所以运行系统里她立刻想不起这条；但磁盘上的 WAL / 备份快照仍可能保留原文，
 * 直到备份轮转或手动清理。`cleanup` 字段就是用来在 UI 上区分这两层的，
 * 别让用户误以为「删了 = 从磁盘彻底消失」。
 */
export interface MemoryDeleteResult {
  /** 运行系统里被软删除（退出检索）的事件条数。 */
  readonly removed: number;
  /** 因来源被删而解绑的派生事实条数（来源全失的事实会被撤回，不会变成「无源事实」）。 */
  readonly detached: number;
  /** 因来源被删而整条退出检索的摘要条数。 */
  readonly dirtied: number;
  /**
   * 清理范围：
   * - `system-invisible`：运行系统已不可见（软删除 + 数据版本前进，后台抽取不会复活），
   *   但磁盘上的 WAL / 备份快照仍可能保留原文，直到备份轮转或手动清理；
   * - `purged`：已从磁盘彻底清除（需另行触发 VACUUM / 备份清理，本操作不直接做）。
   */
  readonly cleanup: 'system-invisible' | 'purged';
}

/** 一次路由调用的输入：URL 已解析，`rest` 是去掉前缀并解码后的路径。 */
export interface RouteInput {
  /** 完整请求 URL（含查询串）。 */
  readonly url: URL;
  /** 去掉 `/dsh-pet-7340/` 前缀后的剩余路径（已解码）。 */
  readonly rest: string;
  /** HTTP 方法（大写）。 */
  readonly method: string;
  /** 请求体文本；只有 PUT/POST 才有值。 */
  readonly body?: string;
  /** 调用方断开信号：挂起等待的路由据此提前收尾。 */
  readonly signal?: AbortSignal;
}

/** 碎碎念与对话共用的生成结果。 */
export type GeneratedReply =
  | { ok: true; text: string; image?: string }
  | {
      ok: false;
      reason: 'provider-missing' | 'generate-error' | 'unknown-pet' | 'unknown-image';
      message?: string;
    };

/** 宠物定位结果：命中给出所在层与条目，未命中给出可直接返回的应答。 */
export type PetLookup =
  | {
      ok: true;
      petId: string;
      entry: string;
      conf: Record<string, unknown>;
      pet: Record<string, unknown>;
    }
  | { ok: false; res: RouteResult };

/** 单个路由处理函数：未命中返回 undefined，命中返回应答。 */
export type RouteHandler = (deps: PetRouteDeps, input: RouteInput) => Promise<RouteResult | undefined>;

/**
 * 路由层需要的全部外部能力。
 *
 * 字段分三类：只读路径与配置、进程内 store、`apply` 里已有的动作函数。
 * 唯一有副作用的是 `nextExternalWorkSeq`：它推进外部写入序号并返回新值。
 */
export interface PetRouteDeps {
  /** 配置路径集（内置默认 + 用户主配置 + 文件宠物目录）。 */
  readonly configPaths: ConfigPaths;
  /** 第三方右键菜单注册表（进程内存态）。 */
  readonly menuRegistry: MenuRegistry;
  /** 轮询快照（前端 1s 轮询的唯一数据源）。 */
  readonly state: PollStateStore;
  /** 待办清单（单个 JSON 文件，读改写串行）。 */
  readonly todos: TodoStore;
  /** 工作状态联动快照。 */
  readonly workStatus: WorkStatusStore;
  /** 外部写入用的固定会话 id。 */
  readonly EXTERNAL_WORK_SESSION: string;
  /** 占用锁拦截：被别的会话占着时直接给出应答。 */
  readonly surfaceBlocked: (
    cfg: Record<string, Record<string, unknown>>,
    petId: string,
    params: URLSearchParams,
  ) => RouteResult | null;
  /** 同上，按 petId 判定。 */
  readonly lockBlocked: (petId: string, params: URLSearchParams) => RouteResult | null;
  /** 用户主配置路径。 */
  readonly userConfigPath: string;
  /** 请求重载桌面 Helper：是否真的重启、如何串行与退避由桌面侧决定（调用方只表达意图）。 */
  readonly requestRestart: () => Promise<void>;
  /** 按 `?pet=` 定位宠物；缺参/未知宠物给出可直接返回的应答。 */
  readonly requirePet: (
    params: URLSearchParams,
    cfg: () => Record<string, Record<string, unknown>>,
    opts?: { surface?: boolean },
  ) => PetLookup;
  /** 播放记录表。 */
  readonly playback: PlaybackStore;
  /** 用户数据根。 */
  readonly userRoot: string;
  /** 占用锁。 */
  readonly lock: LockStore;
  /** 睡觉状态（进睡 / 醒来由 /sleep 与 /wake 驱动）。 */
  readonly sleep: SleepStore;
  /** 睡觉闸门：在睡且未持锁时拒绝并弹拒绝台词；放行回 null。 */
  readonly sleepBlocked: (petId: string, params: URLSearchParams) => RouteResult | null;
  /** 插件日志出口（文件 + 终端）。 */
  readonly log: FileLogger;
  /** 宿主上下文的最小结构：路由只用到 logger 与 llm 服务。 */
  readonly ctx: { logger?: { warn?(message: string): void }; llm?: unknown };
  /** 文件宠物目录（`pet/`）。 */
  readonly petConfigDir: string;
  /** 把最新工作状态写进轮询快照。 */
  readonly publishWorkStatus: () => void;
  /** 推进外部写入序号并返回新值（前端据此判断是否新的一拍）。 */
  readonly nextExternalWorkSeq: () => number;
  /** 表情包目录链（与 /thumb 同一套归属语义）。 */
  readonly memeDirsFor: (assetRoot: string) => string[];
  /** 姿态上报存储。 */
  readonly pose: PoseStore;
  /** 软取宿主可选服务（缺失返回 undefined）。 */
  readonly optionalService: (name: string) => unknown;
  /** 用户动画目录。 */
  readonly thumbUserRoot: string;
  /** 用户表情包目录。 */
  readonly memesUserRoot: string;
  /** 刷新余额（manual 表示用户主动触发）。 */
  readonly refreshBalance: (manual?: boolean) => Promise<void>;
  /** 生成一条碎碎念；image 给了就用这张图（需在池内），缺省 = 按配置随机抽一张或纯文本。
   *  voiceTo 由带 `?surface=` 的路由传请求面；kind=whisper 时按 voiceWhisperEnabled 决定要不要念。 */
  readonly publishWhisper: (
    petId: string,
    image?: string,
    voiceTo?: VoiceTarget,
    kind?: 'whisper' | 'manual',
  ) => Promise<GeneratedReply>;
  /** 读取对话记忆文件。 */
  readonly readMemory: () => Promise<Record<string, Record<string, { messages: ChatMemoryMessage[] }>>>;
  /** 对话记忆文件路径。 */
  readonly memoryPath: string;
  /** 单次对话保留的轮数。 */
  readonly memoryRounds: (conf: Record<string, unknown>) => number;
  /**
   * 与本机宠物对话；image 缺省 = 纯文本，数据路径与加入图片前一致。
   *
   * `requestId` 是可选幂等键：同一次「发送动作」重试时复用，后端据此只生成一次。
   * 缺省表示不去重——只有客户端知道两次到达算不算同一件事，所以由它决定。
   */
  readonly chatWithPet: (
    petId: string,
    text: string,
    image?: PetImageRef,
    requestId?: string,
  ) => Promise<GeneratedReply>;
  /** 当前对话后端是否支持图片附件。`false` 时路由在**落盘之前**就拒绝，不产生孤儿附件；
   *  缺省视为支持（原生路径与既有调用方行为不变）。 */
  readonly chatSupportsImages?: boolean;
  /**
   * 列出（`query` 缺省）或检索（`query` 给定）某只宠物的长期记忆。
   *
   * 可选：原生后端没有独立记忆层。缺省时记忆端点返回明确的「不提供」，而不是假装空列表——
   * 用户会以为她真的什么都不记得。
   */
  readonly listMemories?: (petId: string, query: string | undefined, limit: number) => Promise<readonly MemoryItem[]>;
  /**
   * 删除若干条记忆（软删除：退出检索、推进数据版本作废在途抽取、解绑派生事实、退出相关摘要）。
   * 缺省时端点同样返回「不提供」。回执见 {@link MemoryDeleteResult}。
   */
  readonly deleteMemories?: (petId: string, ids: readonly string[]) => Promise<MemoryDeleteResult>;
  /**
   * 列出某只宠物的 active 事实（她「确定知道」的事）。
   *
   * 可选：原生/假后端没有事实层。缺省时 `/facts` 明确回「不提供」，而不是空列表。
   */
  readonly listFacts?: (petId: string, limit: number) => Promise<readonly FactItem[]>;
  /**
   * 列出某只宠物的 active 摘要（她「记得聊过什么」）。
   *
   * 只给 `active`：来源被删过的摘要转 `dirty` 后不再列出，也不参与召回——
   * 界面上看不见的东西，提示词里也不该有。
   */
  readonly listSummaries?: (petId: string, limit: number) => Promise<readonly SummaryItem[]>;
  /**
   * 把若干条事实标记为「不对」（置 `superseded` 并关闭有效区间）。
   *
   * 这是纠正，不是删除：旧条留痕，供解释「为什么她不再这么认为」。
   * @returns 实际纠正的条数。
   */
  readonly correctFacts?: (petId: string, ids: readonly string[]) => Promise<number>;
  /**
   * 模型调用用量快照：按用途（对话 / 事实抽取 / 摘要重建）累计的调用次数；
   * token 永远是「未知」——宿主模型层不透明，灵魂拿不到，绝不臆造。缺省时端点返回「不提供」。
   */
  readonly usage?: () => ModelUsage;
  /** 删除该宠物的对话记忆：ts 缺省 = 清空全部，否则只删命中的轮（成对）。 */
  readonly deleteHistory: (
    petId: string,
    ts?: readonly number[],
  ) => Promise<{ ok: true; removed: number } | { ok: false; reason: 'unknown-pet'; message: string }>;
  /** 已删宠物残留的记忆桶（配置里已没有这只宠物）。 */
  readonly orphanHistory: () => Promise<{ entry: string; petId: string; messages: number; lastTs: number }[]>;
  /** 清掉所有已删宠物的历史。 */
  readonly deleteOrphans: () => Promise<{ ok: true; pets: number; messages: number }>;
  /** 用户动画目录（按扩展名）。 */
  readonly userRootFor: (ext: string) => string;
  /** 包内动画目录（按扩展名）。 */
  readonly assetRootFor: (ext: string) => string;
  /** 语音合成服务（校验、排队、缓存与上游调用都在里面）。 */
  readonly voice: VoiceService;
  /** 语音识别服务（音频转文字；宿主没启用语音输入时由它自己回 unsupported）。 */
  readonly speech: HearService;
}
