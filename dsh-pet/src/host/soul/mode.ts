/**
 * 聊天后端的运行模式。
 *
 * - `native`：上游原有生成路径（默认）。
 * - `soul`：真灵魂，`@deepseek-pet/soul` 负责人格、提示词与历史，身体只提供模型与展示。
 * - `fake`：M0 的假后端，纯内存固定回复，用来在拿不到模型时验证接线是否通。
 *
 * 只用环境变量显式选择，暂不写进宠物配置：上游配置层「未知字段不透传」（见 config/merge），
 * 新增一个字段要同时改白名单、内置默认与设置页，超出当前阶段的最小改动范围。
 *
 * 模式在 `apply()` 期只读一次，因此切换方式 = 重启。这同时保证「旧模式的在途结果不会显示到
 * 新模式」——三种模式的后端对象从头到尾不是同一份，不存在共享队列或迟到回写。
 * @module dsh-pet/src/host/soul/mode
 */

/** 聊天后端模式。 */
export type ChatBackendMode = 'native' | 'soul' | 'fake';

/** 选择模式的环境变量名。 */
export const CHAT_BACKEND_ENV = 'DSH_PET_CHAT_BACKEND';

/**
 * 从环境变量解析模式。
 *
 * 只认 `soul` 与 `fake` 两个值；缺省、拼错或空值一律按 `native` 处理——
 * 配置写错时宁可回到上游原有行为，也不要静默进入一个可能没有模型的后端。
 *
 * @param env - 环境变量表；缺省取 `process.env`（测试注入用）。
 * @returns 生效的模式。
 */
export function chatBackendMode(env: NodeJS.ProcessEnv = process.env): ChatBackendMode {
  const value = env[CHAT_BACKEND_ENV];
  if (value === 'soul') return 'soul';
  if (value === 'fake') return 'fake';
  return 'native';
}
