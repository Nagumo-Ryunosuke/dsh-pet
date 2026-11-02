/**
 * QQ 渠道接线：把网关侧的适配器接到宿主灵魂上。
 *
 * ## 这是一个开发期桥接，不是最终形态
 *
 * 正常做法是给宿主加一条 `link:` 依赖，由打包器把 `@qqgw/dsh-plugin` 内联进来。
 * 那要改三处仓库级的东西（package.json、pnpm-lock、tsdown 的 noExternal），
 * 而这一步现在只想验证「绑定 → 对话」能不能走通，不值得先动整个依赖图。
 *
 * 所以这里改成**按绝对路径动态加载**网关包：
 * - 打包器解析不了运行时算出来的路径，因此不会把它内联进去；
 * - 那个包自己的依赖（`ws`）会从它所在的目录解析，宿主这边不用装任何东西；
 * - 代价是没有编译期类型检查（下面用局部接口+断言兜住），而且要求网关仓库在本机。
 *
 * 正式打包前必须换成真依赖。届时删掉本文件的动态导入，改成静态 import 即可，
 * 其余逻辑（谁启动、什么时候停、失败怎么报）不用动。
 *
 * ## 默认休眠
 *
 * 没有 `DSH_PET_QQ_MODULE` 就什么都不做。这条链路上有个会主动发消息的程序，
 * 默认打开是不合适的——用户必须显式配置。
 *
 * @module dsh-pet/src/host/qq/channel
 */

import { pathToFileURL } from 'node:url';

/** 网关包导出面的最小声明（只写用到的那几个）。 */
interface GatewayModule {
  readonly OneBotClient: new (options: {
    url: string;
    token: string;
    reconnect?: { enabled?: boolean };
    logger?: ChannelLogger;
  }) => unknown;
  readonly QqChannelAdapter: new (options: {
    client: unknown;
    soul: { respond(envelope: unknown): Promise<{ text: string } | null> };
    policy?: { groupPolicy?: 'off' | 'mention' | 'all'; replyToPrivate?: boolean };
    logger?: ChannelLogger;
  }) => unknown;
  readonly QqChannelService: new (options: {
    adapter: { start(): Promise<void>; stop(): Promise<void> };
    restart?: { maxAttempts?: number };
    logger?: ChannelLogger;
  }) => { start(): Promise<void>; stop(): Promise<void>; state(): { running: boolean } };
  readonly createSoulChannelConnector: (options: {
    soul: unknown;
    petId: string;
    logger?: ChannelLogger;
  }) => { respond(envelope: unknown): Promise<{ text: string } | null> };
}

/** 与网关侧 `ClientLogger` 同形。 */
export interface ChannelLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** 接线所需的最小上下文（只用到 `ctx.effect`）。 */
export interface ChannelHostContext {
  effect(setup: () => () => void): void;
}

export interface QqChannelOptions {
  readonly ctx: ChannelHostContext;
  /** 灵魂实例：渠道消息最终交给它（`respond(petId, input)`）。 */
  readonly soul: unknown;
  readonly log: ChannelLogger;
  /** 环境变量来源，测试可注入。 */
  readonly env?: Record<string, string | undefined>;
}

/** 读取环境变量时的默认值。 */
const DEFAULT_URL = 'ws://127.0.0.1:6700/';
/** 渠道默认以哪只宠物身份说话。 */
const DEFAULT_PET_ID = 'main';

/**
 * 启动 QQ 渠道（若已配置）。
 *
 * 失败一律只记日志，不向调用方抛：一条可选渠道连不上，不该让整个宿主起不来。
 *
 * @param options - 宿主上下文、灵魂、日志与环境。
 * @returns 是否真的启动了。
 */
export function startQqChannel(options: QqChannelOptions): boolean {
  const env = options.env ?? process.env;
  const modulePath = (env['DSH_PET_QQ_MODULE'] ?? '').trim();
  if (modulePath === '') return false;

  const token = (env['QGW_ONEBOT_TOKEN'] ?? '').trim();
  if (token === '') {
    options.log.error('[dsh-pet][qq] 已配置 DSH_PET_QQ_MODULE 但缺少 QGW_ONEBOT_TOKEN，渠道不启动');
    return false;
  }

  const url = (env['DSH_PET_QQ_URL'] ?? DEFAULT_URL).trim();
  const petId = (env['DSH_PET_QQ_PET'] ?? DEFAULT_PET_ID).trim();

  // 先注册清理：加载是异步的，中途插件被卸载时也要保证「加载完就立刻停」
  let stop: (() => Promise<void>) | null = null;
  let disposed = false;
  options.ctx.effect(() => () => {
    disposed = true;
    const current = stop;
    stop = null;
    if (current !== null) void current();
  });

  void (async () => {
    try {
      const loaded = (await import(pathToFileURL(modulePath).href)) as unknown as GatewayModule;
      if (disposed) return;

      const client = new loaded.OneBotClient({
        url,
        token,
        // 网关重启时自动重连；网关侧会补投离线期间攒下的事件
        reconnect: { enabled: true },
        logger: options.log,
      });
      const adapter = new loaded.QqChannelAdapter({
        client,
        // 关键：交给灵魂的是带 scope 的信封，不是 (petId, text)。
        // 拼成一句话再交给 chat 会让所有 QQ 用户共用一份记忆
        soul: loaded.createSoulChannelConnector({ soul: options.soul, petId, logger: options.log }),
        policy: { groupPolicy: 'off', replyToPrivate: true },
        logger: options.log,
      });
      const service = new loaded.QqChannelService({
        adapter: adapter as { start(): Promise<void>; stop(): Promise<void> },
        restart: { maxAttempts: 5 },
        logger: options.log,
      });
      stop = () => service.stop();
      if (disposed) {
        await service.stop();
        return;
      }
      // 不 await：启动失败会自己退避重试，不该拖住宿主起来
      void service.start();
      options.log.info(`[dsh-pet][qq] 渠道已接线（bridge，pet=${petId}），连 ${url}`);
    } catch (error) {
      // 路径写错、包没编译、导出面变了：说清楚是哪一个，别只留一句「启动失败」
      const reason = error instanceof Error ? error.message : String(error);
      options.log.error(`[dsh-pet][qq] 加载网关包失败（${modulePath}）：${reason}`);
    }
  })();

  return true;
}
