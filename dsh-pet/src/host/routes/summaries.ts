/**
 * 摘要端点：把「她记得聊过什么」列出来，只读。
 *
 * 为什么摘要需要可见：它会被拼进提示词，而且不像事实那样能逐条纠正——用户看到
 * 「之前聊过：……」才发现她把两次聊天揉成了一段离谱的梗概，唯一能做的就是知道它存在。
 * 只列 `active`：来源被删过的摘要（`dirty`）既不参与召回，也不该在界面上出现，
 * 否则用户会以为「她还在提那件事」而实际召回里并没有。
 * @module dsh-pet/src/host/routes/summaries
 */
import { readAllConfig } from '../config.ts';
import type { RouteResult } from '../http.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import { failResult, methodNotAllowed, okResult } from './result.ts';

/** 一次最多列几条。 */
export const MAX_SUMMARY_LIMIT = 50;
/** 默认列几条：界面上一屏够看，再多也没人翻。 */
export const DEFAULT_SUMMARY_LIMIT = 10;

/** 解析 `?limit=`。 */
function parseLimit(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return DEFAULT_SUMMARY_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SUMMARY_LIMIT) return null;
  return n;
}

/**
 * 摘要路由：`GET /summaries` 列出。
 *
 * @param deps - 路由依赖。
 * @param input - 路由输入。
 * @returns 未命中 `rest = summaries` 时返回 `undefined`，交给下一个处理器。
 */
export async function handleSummariesRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { rest, method, url } = input;
  if (rest !== 'summaries') return undefined;
  if (deps.listSummaries === undefined) return failResult('bad-request', '当前对话后端不提供对话摘要');
  // 只读端点：其它方法明确 405，而不是落到「不支持」的模糊报错
  if (method !== 'GET') return methodNotAllowed();
  try {
    let cfgCache: Record<string, Record<string, unknown>> | undefined;
    const cfg = (): Record<string, Record<string, unknown>> => (cfgCache ??= readAllConfig(deps.configPaths));
    const who = deps.requirePet(url.searchParams, cfg, { surface: false });
    if (!who.ok) return who.res;
    const limit = parseLimit(url.searchParams.get('limit'));
    if (limit === null) return failResult('bad-request', `limit 必须是 1–${MAX_SUMMARY_LIMIT} 的整数`);
    const summaries = await deps.listSummaries(who.petId, limit);
    return okResult({ ok: true, summaries });
  } catch (error) {
    return failResult('generate-error', error instanceof Error ? error.message : String(error));
  }
}
