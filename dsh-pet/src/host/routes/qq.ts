/**
 * 渠道绑定端点：签发绑定码、列出已绑定、断开绑定。
 *
 * 为什么需要它：灵魂侧早就支持「按 scope 隔离记忆」，但**没有入口**让用户把某个 QQ
 * 接进来——码只能从脚本里调。一个能力没有界面入口，等于没有。
 *
 * 三条规矩：
 *
 * 1. **绑定码只返回一次**。库里存哈希，刷新页面就拿不回来；用户要重来就再生成一个。
 * 2. **断开 = 撤权 + 清数据**。只撤权不清数据的话，用户看到「已断开」，磁盘上那份对话
 *    还在，下次重新绑定就全回来了——那是最容易让人误会「删了」的一种假象。
 * 3. **后端不支持时明确说「不提供」**，不返回假码。原生后端没有独立记忆层，
 *    渠道隔离也就无从谈起。
 *
 * 权限边界：这些端点只在本机回环上暴露（与其它路由一致），不额外做鉴权；
 * 拿到面板的人本来就能读全部对话，多加一层「绑定鉴权」只是自欺。
 *
 * @module dsh-pet/src/host/routes/qq
 */
import { readAllConfig } from '../config.ts';
import type { RouteResult } from '../http.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import { failResult, methodNotAllowed, okResult } from './result.ts';

/** `scopeId` 的长度上限（形如 `qq:账号:形态:会话:发言人`）。 */
export const MAX_SCOPE_ID_CHARS = 200;

/** 解析 `?scope=`。 */
function parseScopeId(raw: string | null): string | null {
  if (raw === null) return null;
  const id = raw.trim();
  if (id === '' || id.length > MAX_SCOPE_ID_CHARS) return null;
  if (!/^[A-Za-z0-9:._-]+$/.test(id)) return null;
  return id;
}

/**
 * 渠道绑定路由。
 *
 * - `POST /qq/bind/code?pet=`：签发一个一次性码（5 分钟、单次）。
 * - `GET  /qq/grants`：列出当前有效的绑定。
 * - `DELETE /qq/grants?pet=&scope=`：断开并清除该会话的记忆。
 *
 * @param deps - 路由依赖。
 * @param input - 路由输入。
 * @returns 未命中时返回 `undefined`，交给下一个处理器。
 */
export async function handleQqRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { rest, method, url } = input;
  if (rest !== 'qq/bind/code' && rest !== 'qq/grants') return undefined;

  // 三件能力缺一不可：缺了就当后端不支持，而不是「能生成码但不能断开」
  if (
    deps.issueBindCode === undefined ||
    deps.listChannelGrants === undefined ||
    deps.revokeChannelGrant === undefined
  ) {
    return failResult('bad-request', '当前对话后端不提供渠道绑定（只有 soul 后端有）');
  }

  try {
    let cfgCache: Record<string, Record<string, unknown>> | undefined;
    const cfg = (): Record<string, Record<string, unknown>> => (cfgCache ??= readAllConfig(deps.configPaths));

    if (rest === 'qq/bind/code') {
      if (method !== 'POST') return methodNotAllowed();
      // 码属于某只宠物：列表接口是全局的，但生成必须指名归属，否则不知道记到谁名下
      const who = deps.requirePet(url.searchParams, cfg, { surface: false });
      if (!who.ok) return who.res;
      const issued = await deps.issueBindCode(who.petId);
      return okResult({
        ok: true,
        code: issued.code,
        expiresAt: issued.expiresAt,
        // 有效期由服务端算出来，前端别自己猜（时钟不同步时猜出来的倒计时是错的）
        expiresInMs: Math.max(0, issued.expiresAt - Date.now()),
      });
    }

    if (method === 'GET') {
      const grants = await deps.listChannelGrants();
      return okResult({ ok: true, grants });
    }

    if (method === 'DELETE') {
      const who = deps.requirePet(url.searchParams, cfg, { surface: false });
      if (!who.ok) return who.res;
      const scopeId = parseScopeId(url.searchParams.get('scope'));
      if (scopeId === null) return failResult('bad-request', 'scope 缺失或格式不对');
      const result = await deps.revokeChannelGrant(who.petId, scopeId);
      return okResult({ ok: true, revoked: result.revoked, removed: result.removed });
    }

    return methodNotAllowed();
  } catch (error) {
    return failResult('generate-error', error instanceof Error ? error.message : String(error));
  }
}
