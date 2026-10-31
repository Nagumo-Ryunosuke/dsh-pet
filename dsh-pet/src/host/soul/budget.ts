/**
 * 记忆注入的预算配置：几条、多少 token、单条多长。
 *
 * 为什么值得做成配置：默认值（5 条 / 400 token）是给「偶尔聊两句」的场景定的。
 * 每天长聊的人会觉得太少（她老是只想起眼前这一条），而用本地小模型的人会觉得太多
 * （上下文一挤，最近的对话先被顶掉）。这类偏差没法用一个默认值满足，也不该让用户去改代码。
 *
 * 口径与 `chatMemoryRounds` 一致：**条目级**配置，同一素材根下的宠物共用。
 * 坏值不抛错——配置写错不该让宠物开不了口，回落到默认值并留一行 warn 让人能查。
 * @module dsh-pet/src/host/soul/budget
 */

import {
  DEFAULT_MAX_FACTS,
  DEFAULT_MAX_ITEMS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_TOKENS_PER_ITEM,
  type BudgetOptions,
} from '@deepseek-pet/soul';

/** 加上事实条数上限后的完整预算。 */
export interface MemoryBudget extends BudgetOptions {
  /** 最多注入几条事实（其余额度留给聊天原文）。 */
  readonly maxFacts: number;
  /** 最多注入几条（事实 + 原文）。 */
  readonly maxItems: number;
  /** 总 token 预算。 */
  readonly maxTokens: number;
  /** 单条 token 上限。 */
  readonly maxTokensPerItem: number;
}

/** 每项的合理区间：超出就当写错，回落默认值。 */
const RANGES = {
  chatMemoryItems: { min: 1, max: 20, fallback: DEFAULT_MAX_ITEMS },
  chatMemoryTokens: { min: 80, max: 2000, fallback: DEFAULT_MAX_TOKENS },
  chatMemoryItemTokens: { min: 20, max: 600, fallback: DEFAULT_MAX_TOKENS_PER_ITEM },
  chatMemoryFacts: { min: 0, max: 10, fallback: DEFAULT_MAX_FACTS },
} as const;

/** 键名 → 中文说明（日志里用中文，用户看得懂）。 */
const LABELS: Record<keyof typeof RANGES, string> = {
  chatMemoryItems: '注入条数',
  chatMemoryTokens: '注入 token 预算',
  chatMemoryItemTokens: '单条 token 上限',
  chatMemoryFacts: '事实条数',
};

/**
 * 读一个整数配置项。
 *
 * @param conf - 条目级配置。
 * @param key - 键名。
 * @param warn - 留痕口子；缺省静默（测试里不关心日志）。
 * @returns 合法值；缺失用默认，写坏用默认并 warn。
 */
function readInt(conf: Record<string, unknown>, key: keyof typeof RANGES, warn?: (message: string) => void): number {
  const raw = conf[key];
  const { min, max, fallback } = RANGES[key];
  if (raw === undefined || raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    warn?.(
      `[dsh-pet][soul] 配置 ${key}=${JSON.stringify(raw)} 不可用（应为 ${min}–${max} 的整数），按 ${fallback} 处理`,
    );
    return fallback;
  }
  return value;
}

/**
 * 从条目级配置解析记忆预算。
 *
 * 单条上限不会超过总预算：`chatMemoryItemTokens` 配得比 `chatMemoryTokens` 还大时，
 * 每一条都会被「放不下」跳过，等于一条记忆都注入不了——那是配置错误伪装成的「她想不起来」，
 * 这里直接按总预算压住。
 *
 * @param conf - 条目级配置（`findPetInstance(...).conf`）。
 * @param warn - 留痕口子。
 * @returns 生效预算。
 */
export function memoryBudgetOf(conf: Record<string, unknown>, warn?: (message: string) => void): MemoryBudget {
  const maxItems = readInt(conf, 'chatMemoryItems', warn);
  const maxTokens = readInt(conf, 'chatMemoryTokens', warn);
  const itemTokens = readInt(conf, 'chatMemoryItemTokens', warn);
  const maxFacts = readInt(conf, 'chatMemoryFacts', warn);
  return {
    maxItems,
    maxTokens,
    maxTokensPerItem: Math.min(itemTokens, maxTokens),
    maxFacts,
  };
}

/** 配置项的展示名，给文档与日志复用。 */
export const MEMORY_BUDGET_LABELS = LABELS;
