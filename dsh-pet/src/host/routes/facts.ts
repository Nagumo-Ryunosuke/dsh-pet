/**
 * 事实端点：把她「确定知道」的事列出来，并提供一条「这条不对」的纠正入口。
 *
 * 为什么事实需要单独可见：召回只在日志里留 id，而事实会直接改变她对用户的称呼、
 * 偏好和习惯。用户必须能回答「你从哪知道的」和「不对，改掉」——否则一条模型幻觉
 * 会无声地变成长期人设的一部分。
 *
 * 纠正不是删除：旧条置 `superseded` 并关闭有效区间，留痕可审计；冲突并存的两条
 * 各占一行，用户点掉错的那条，另一条继续有效。
 * @module dsh-pet/src/host/routes/facts
 */
import { readAllConfig } from '../config.ts';
import type { RouteResult } from '../http.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import { failResult, methodNotAllowed, okResult } from './result.ts';

/** 一次列出的条数上限。 */
export const MAX_FACT_LIMIT = 200;
/** 默认列出的条数。 */
export const DEFAULT_FACT_LIMIT = 100;
/** 一次最多纠正几条。 */
export const MAX_CORRECT_IDS = 50;

/** 解析 `?limit=`。 */
function parseLimit(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return DEFAULT_FACT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_FACT_LIMIT) return null;
  return n;
}

/** 解析 `?id=`（可重复）。 */
function parseIds(raws: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const raw of raws) {
    const id = raw.trim();
    if (id === '' || id.length > 200) return null;
    if (!out.includes(id)) out.push(id);
  }
  if (out.length === 0 || out.length > MAX_CORRECT_IDS) return null;
  return out;
}

/**
 * 事实路由：`GET /facts` 列出，`DELETE /facts?id=` 标记「不对」。
 *
 * @param deps - 路由依赖。
 * @param input - 路由输入。
 * @returns 未命中 `rest = facts` 时返回 `undefined`，交给下一个处理器。
 */
export async function handleFactsRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { rest, method, url } = input;
  if (rest !== 'facts') return undefined;
  if (deps.listFacts === undefined || deps.correctFacts === undefined) {
    return failResult('bad-request', '当前对话后端不提供长期事实');
  }
  if (method !== 'GET' && method !== 'DELETE') return methodNotAllowed();
  try {
    // pet 校验与对话/记忆路由同一套：不存在的宠物不能建出没人消费的分桶
    let cfgCache: Record<string, Record<string, unknown>> | undefined;
    const cfg = (): Record<string, Record<string, unknown>> => (cfgCache ??= readAllConfig(deps.configPaths));
    const who = deps.requirePet(url.searchParams, cfg, { surface: false });
    if (!who.ok) return who.res;

    if (method === 'DELETE') {
      const ids = parseIds(url.searchParams.getAll('id'));
      if (ids === null) {
        return failResult('bad-request', `id 必须是非空字符串，一次最多 ${MAX_CORRECT_IDS} 个`);
      }
      const corrected = await deps.correctFacts(who.petId, ids);
      return okResult({ ok: true, corrected });
    }

    const limit = parseLimit(url.searchParams.get('limit'));
    if (limit === null) return failResult('bad-request', `limit 必须是 1–${MAX_FACT_LIMIT} 的整数`);
    const facts = await deps.listFacts(who.petId, limit);
    return okResult({ ok: true, facts });
  } catch (error) {
    return failResult('generate-error', error instanceof Error ? error.message : String(error));
  }
}
