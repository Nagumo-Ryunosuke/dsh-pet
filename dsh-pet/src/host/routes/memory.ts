/**
 * 记忆端点：把她记得的东西列出来、搜出来、删掉。
 *
 * 为什么要这个端点：召回只在日志里留 id，用户看不到她到底记得什么——而「她怎么知道
 * 这个」必须有一个能回答的地方。这里走的是**同一条检索链路**（同一个存储、同一套
 * 排序），所以带 `?q=` 时看到的就是她会想起来的，所见即所得。
 *
 * 删除是软删除：退出检索、她再也不会提起，但原文留痕（可解释「为什么想不起来」），
 * 与删聊天轮次的语义一致。
 *
 * 两个依赖都是可选的（原生后端没有独立记忆层）：缺省时明确说「不提供」，
 * 而不是返回空列表让用户以为她真的什么都不记得。
 * @module dsh-pet/src/host/routes/memory
 */
import { readAllConfig } from '../config.ts';
import type { RouteResult } from '../http.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import { failResult, methodNotAllowed, okResult } from './result.ts';

/** 一次列出的条数上限：浏览器一次渲染得动，也防一次拖出整库。 */
export const MAX_MEMORY_LIMIT = 200;
/** 一次删除的条数上限。 */
export const MAX_DELETE_IDS = 100;
/** 检索词的长度上限：它只是查询，没有语义。 */
export const MAX_QUERY_CHARS = 100;
/** 不带 `?q=` 时默认列出的条数。 */
export const DEFAULT_MEMORY_LIMIT = 50;

/**
 * 解析 `?limit=`。
 *
 * @param raw - 查询串原值；`null` 表示没传。
 * @returns 合法值；`null` 表示非法（调用方转 bad-request）。
 */
function parseLimit(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return DEFAULT_MEMORY_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_MEMORY_LIMIT) return null;
  return n;
}

/**
 * 解析 `?q=`。
 *
 * @param raw - 查询串原值；`null` 表示没传。
 * @returns 检索词（空串 = 浏览全部）；`null` 表示非法。
 */
function parseQuery(raw: string | null): string | null {
  if (raw === null) return '';
  const q = raw.trim();
  if (q.length > MAX_QUERY_CHARS) return null;
  return q;
}

/**
 * 解析 `?id=`（可重复）。
 *
 * @param raws - 查询串里所有 `id` 的原值。
 * @returns 去重后的 id 数组；为空或非法时返回 `null`。
 */
function parseIds(raws: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const raw of raws) {
    const id = raw.trim();
    if (id === '' || id.length > 200) return null;
    if (!out.includes(id)) out.push(id);
  }
  if (out.length === 0 || out.length > MAX_DELETE_IDS) return null;
  return out;
}

/**
 * 记忆路由：`GET /memory` 列出或检索，`DELETE /memory?id=` 删除。
 *
 * @param deps - 路由依赖。
 * @param input - 路由输入。
 * @returns 未命中 `rest = memory` 时返回 `undefined`，交给下一个处理器。
 */
export async function handleMemoryRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { rest, method, url } = input;
  if (rest !== 'memory') return undefined;
  if (deps.listMemories === undefined || deps.deleteMemories === undefined) {
    return failResult('bad-request', '当前对话后端不提供长期记忆');
  }
  if (method !== 'GET' && method !== 'DELETE') return methodNotAllowed();
  try {
    // pet 校验与对话路由同一套：不存在的宠物不能建出没人消费的分桶
    let cfgCache: Record<string, Record<string, unknown>> | undefined;
    const cfg = (): Record<string, Record<string, unknown>> => (cfgCache ??= readAllConfig(deps.configPaths));
    const who = deps.requirePet(url.searchParams, cfg, { surface: false });
    if (!who.ok) return who.res;

    if (method === 'DELETE') {
      const ids = parseIds(url.searchParams.getAll('id'));
      if (ids === null) {
        return failResult('bad-request', `id 必须是非空字符串，一次最多 ${MAX_DELETE_IDS} 个`);
      }
      const removed = await deps.deleteMemories(who.petId, ids);
      return okResult({ ok: true, removed });
    }

    const limit = parseLimit(url.searchParams.get('limit'));
    if (limit === null) return failResult('bad-request', `limit 必须是 1–${MAX_MEMORY_LIMIT} 的整数`);
    const q = parseQuery(url.searchParams.get('q'));
    if (q === null) return failResult('bad-request', `q 最长 ${MAX_QUERY_CHARS} 字`);
    const events = await deps.listMemories(who.petId, q === '' ? undefined : q, limit);
    return okResult({ ok: true, events, query: q === '' ? null : q });
  } catch (error) {
    return failResult('generate-error', error instanceof Error ? error.message : String(error));
  }
}
