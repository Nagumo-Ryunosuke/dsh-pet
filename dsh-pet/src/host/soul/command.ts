/**
 * soul 模式下的 `/chat` 斜杠命令：明确拒绝，不用上游的 fire-and-forget 回执冒充成功。
 *
 * 上游命令对两个分支都是「先回成功、再异步生成」：有参数时调用 `chatWithPet` 后立刻回
 * 「已发送，桌宠马上回应」，生成失败只写日志；无参数时调用 `publishWhisper` 后回
 * 「已让桌宠碎碎念一句」。套到 soul 模式上，这两句都会变成假成功——用户看不到回复，也没有
 * 任何错误提示。M0 的验收要求是「不能报假成功」，所以这里注册一个同名命令并直接返回错误，
 * 明确指向真正可用的入口（聊天窗口）。
 *
 * 后续若要让命令也走灵魂，应改成能等待异步结果的回执形态，而不是恢复 fire-and-forget。
 * @module dsh-pet/src/host/soul/command
 */

import type { HostContext } from '../plugin/context.ts';

/** 拒绝文案：说明当前模式、限制来源和可用入口，避免让用户以为是宠物出了故障。 */
const refusalOf = (label: string): string => `${label}：斜杠命令暂不支持，请在聊天窗口里对话`;

/**
 * 注册 soul 模式的 `/chat` 占位命令。
 *
 * @param deps - 宿主上下文（只用 `ctx.commands` 与 `ctx.effect` 生命周期）；
 *   `label` 是拒绝文案里的模式名（如「M0 假后端」「soul」）——写死一个会误导排错的人。
 */
export function registerSoulChatCommand(deps: { ctx: HostContext; label?: string }): void {
  const { ctx } = deps;
  const refusal = refusalOf(deps.label ?? 'soul 模式');
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'chat',
        description: '与桌宠对话（soul 模式下暂不支持，请用聊天窗口）',
        input: { hint: '[消息]' },
        handler: () => ({ kind: 'error', text: refusal }),
      }),
    'dsh-pet: /chat command (soul stub)',
  );
}
