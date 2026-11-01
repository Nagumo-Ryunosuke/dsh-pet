/**
 * 本机 HTTP 的访问边界：回环 Host 校验、CSRF 校验与进程能力令牌。
 *
 * 负责判定请求能否进入路由，并清掉上游写出的宽 CORS 头；不处理业务语义。
 * 必须始终成立：只接受当前回环地址；令牌只出现在启动清单与请求头，绝不进日志或响应。
 * @module dsh-pet/src/standalone/request-security
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 请求安全门面。 */
export interface RequestSecurity {
  /** 进程能力令牌，只写入本机启动清单，绝不进 HTTP 响应或日志。 */
  readonly token: string;
  /** 生成带令牌的设置页地址。 */
  authenticatedUrl(baseUrl: string): string;
  /** 判定请求是否放行；拒绝时已经写好响应。 */
  authorize(req: IncomingMessage, res: ServerResponse, allowFileOrigin?: boolean): boolean;
}

/** 回一个结构化错误并返回 false，便于调用方直接 return。 */
export function rejectRequest(res: ServerResponse, status: number, error: string): false {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error }));
  return false;
}

/** 无需令牌的只读路径；写操作与敏感路径必须带令牌。 */
function publicRead(req: IncomingMessage): boolean {
  // 插件在分发前会解码路径，鉴权必须用同一种拼写判断。
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (['/standalone-ai/settings', '/shutdown'].includes(path)) return false;
  if (['/', '/health', '/standalone-ai/', '/standalone-ai/settings.js', '/standalone-ai/settings.css'].includes(path)) {
    return true;
  }
  // 插件路由只公开**打包随附的静态素材**（动画缩略图 / 表情 / 音效 / 字体 / logo）、
  // 渲染端引导要读的 config，以及第三方集成读的 pose 快照（坐标/动作，无对话内容）。
  // 注意：/config 含用户手写的 whisperPrompt 等人设文本——它公开是渲染端引导的产品取舍
  // （渲染端由 desktop-auth 注令牌，收进令牌内亦可行），不是「不含用户生成内容」。
  // 聊天原文、记忆、事实、摘要、用量、state（say.text=模型回复原文）、附件一律要令牌。
  //
  // config 只放行精确的 /config：/config/meta 会吐 homedir、日志/待办文件路径、插件根
  // 等文件系统布局，收进令牌内。
  if (/^\/dsh-pet-\d+\/config$/.test(path)) return true;
  return /^\/dsh-pet-\d+\/(?:thumb|pic|sound|fonts?|logo|pose)(?:\/|$)/.test(path);
}

/** 创建请求安全门面。 */
export function createRequestSecurity(): RequestSecurity {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    authenticatedUrl(baseUrl) {
      const base = new URL(baseUrl);
      if (
        base.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost'].includes(base.hostname) ||
        base.username ||
        base.password
      ) {
        throw new Error('设置地址必须是本机 HTTP 地址');
      }
      return `${base.origin}/standalone-ai/#token=${token}`;
    },
    authorize(req, res, allowFileOrigin = false) {
      const host = req.headers.host;
      const port = req.socket.localPort;
      if (!port || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
        return rejectRequest(res, 403, '仅允许当前本机地址');
      }
      // 文件页渲染器也要带令牌：沙箱网页同样会发来 null 来源。
      // 同一渲染器加载媒体时可能完全不带 Origin，只有这种情况才放行。
      const fileOrigin = allowFileOrigin && (req.headers.origin === 'null' || req.headers.origin === undefined);
      if (
        !fileOrigin &&
        ((req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) ||
          req.headers['sec-fetch-site'] === 'cross-site')
      ) {
        return rejectRequest(res, 403, '不允许跨站请求');
      }
      try {
        if (publicRead(req) && !fileOrigin) return true;
      } catch {
        return rejectRequest(res, 400, '请求地址无效');
      }
      const supplied = req.headers['x-dsh-pet-token'];
      // 先按固定形状校验，再走定时安全比较，避免长度与内容泄漏。
      if (
        typeof supplied !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      ) {
        return rejectRequest(res, 403, '请从桌宠菜单重新打开设置');
      }
      return true;
    },
  };
}

/** 清掉上游写出的宽 CORS 头，并补上安全响应头。 */
export function secureResponse(res: ServerResponse, pathname?: string): void {
  const writeHead = res.writeHead.bind(res);
  const isPublicOp = pathname === '/' || pathname === '/health';
  res.writeHead = ((status: number, ...args: unknown[]) => {
    const filtered = isPublicOp
      ? args
      : args.map((value) => {
          if (Array.isArray(value)) {
            return value.reduce<string[]>((result, item, index) => {
              if (index % 2 === 0 && !String(item).toLowerCase().startsWith('access-control-')) {
                return [...result, String(item), String(value[index + 1])];
              }
              return result;
            }, []);
          }
          if (value !== null && typeof value === 'object') {
            return Object.fromEntries(
              Object.entries(value).filter(([name]) => !name.toLowerCase().startsWith('access-control-')),
            );
          }
          return value;
        });
    if (!isPublicOp) {
      for (const name of res.getHeaderNames()) {
        if (name.toLowerCase().startsWith('access-control-')) res.removeHeader(name);
      }
    }
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'no-store');
    return Reflect.apply(writeHead, res, [status, ...filtered]);
  }) as typeof res.writeHead;
}
