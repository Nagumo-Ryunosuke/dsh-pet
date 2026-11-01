/**
 * 模型调用用量端点：`GET /usage` 取一份当前用量快照。
 *
 * 为什么单独一个端点：用量和「某只宠物的记忆」不是一类东西——它是整个灵魂后端共用的，
 * 不按宠物分桶，所以不要求 `?pet=`。快照里只有「调了几次」（按对话 / 事实抽取 / 摘要重建分）、
 * token 永远是「未知」：宿主模型层对灵魂不透明，拿不到用量，绝不臆造一个数字填进去。
 * @module dsh-pet/src/host/routes/usage
 */
import type { RouteResult } from '../http.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import { failResult, okResult } from './result.ts';

/**
 * 模型调用用量路由：`GET /usage` 返回快照。
 *
 * @param deps - 路由依赖。
 * @param input - 路由输入。
 * @returns 未命中 `rest = usage` 时返回 `undefined`，交给下一个处理器。
 */
export async function handleUsageRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { rest, method } = input;
  if (rest !== 'usage') return undefined;
  if (deps.usage === undefined) {
    return failResult('bad-request', '当前对话后端不提供模型调用用量');
  }
  if (method !== 'GET') {
    return failResult('method-not-allowed', 'usage 只支持 GET');
  }
  const usage = deps.usage();
  deps.log.info(
    `[dsh-pet][soul] 用量快照 chat=${usage.calls.chat} extract=${usage.calls.extract} summarize=${usage.calls.summarize} tokens=${usage.tokens}`,
  );
  return okResult({ ok: true, usage });
}
