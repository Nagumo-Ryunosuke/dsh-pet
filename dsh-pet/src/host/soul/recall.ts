/**
 * 召回融合：长期事实与聊天原文走同一个预算，事实排在最前。
 *
 * 为什么事实要先于原文：事实是「她一直知道的」，原文是「某天说过的一句话」。
 * 预算只有 5 条 / 400 token，先放原文会让一句无关的旧闲聊挤掉「用户对花生过敏」。
 * 事实仍然只是资料，不是指令——渲染层的边界声明对两者一视同仁。
 *
 * 这一层是纯函数：存储与检索都在调用方，测试可以直接喂假数据。
 * @module dsh-pet/src/host/soul/recall
 */

import {
  selectFacts,
  trimToBudget,
  type BudgetOptions,
  type Fact,
  type MemoryHit,
  type RecalledMemory,
  type Summary,
} from '@deepseek-pet/soul';

/** 每轮最多注入几条事实（总预算仍是 trimToBudget 的 5 条 / 400 token）。 */
export const MAX_RECALLED_FACTS = 3;
/**
 * 每轮最多注入几段摘要。
 *
 * 摘要回答的是「之前聊到哪了」，越近越有用；给两段就够接上话题，再多会把最近的原话挤掉。
 */
export const MAX_RECALLED_SUMMARIES = 2;

/** 把一条事实包装成召回命中，复用事件的 token 预算与渲染链路。 */
export function factHit(petId: string, fact: Fact): MemoryHit {
  return {
    event: {
      id: fact.id,
      petId,
      occurredAt: fact.updatedAt,
      kind: 'fact',
      // role=fact 让提示词渲染成「你记得」，而不是某个人说过的话
      role: 'fact',
      // 中文不需要分隔符；一行一句话，长度上限在抽取时已经卡过
      text: fact.subject + fact.predicate + fact.value,
      source: 'fact',
      privacy: 'normal',
    },
    score: 0,
    via: 'fact',
  };
}

/**
 * 把一条摘要包装成召回命中。
 *
 * `occurredAt` 用 `periodEnd`：这样它和聊天原文共用同一套「上下文窗口去重」——
 * 已经被最近几轮覆盖的时段不必再用梗概重述一遍。
 */
export function summaryHit(petId: string, summary: Summary): MemoryHit {
  return {
    event: {
      id: summary.id,
      petId,
      occurredAt: summary.periodEnd,
      kind: 'summary',
      role: 'summary',
      text: summary.text,
      source: 'summary',
      privacy: 'normal',
    },
    score: 0,
    via: 'fact',
  };
}

/** 融合召回输入。 */
export interface RecallInput {
  readonly petId: string;
  readonly query: string;
  /** 该宠物的 active 事实（已按存储上限取出）。 */
  readonly facts: readonly Fact[];
  /** 该宠物的 active 摘要（最近的在前）。 */
  readonly summaries?: readonly Summary[];
  /** 聊天原文的召回调；由调用方决定检索实现。 */
  readonly searchEvents: () => readonly MemoryHit[];
  /**
   * 注入预算（条数 / 总 token / 单条 token）。
   *
   * 缺省用灵魂的默认值（5 条 / 400 / 120）；用户可以用 `chatMemory*` 配置覆盖，
   * 解析与夹取在 `soul/budget.ts`。事实和原文共享这一份预算。
   */
  readonly budget?: BudgetOptions;
  /** 最多几条事实；缺省 {@link MAX_RECALLED_FACTS}。 */
  readonly maxFacts?: number;
}

/**
 * 融合事实与聊天原文，并裁剪到同一份预算。
 *
 * @param input - 宠物、当前输入、事实候选与原文检索。
 * @returns 已排序、已裁剪的往事列表；事实在前。
 */
export function recallWithFacts(input: RecallInput): RecalledMemory[] {
  const factHits = selectFacts(input.query, input.facts, {
    maxFacts: input.maxFacts ?? MAX_RECALLED_FACTS,
  }).map((fact) => factHit(input.petId, fact));
  // 摘要不按关键词筛：它的价值是「接上上次」，与当前这句话是否同词无关；
  // 顺序上排在事实之后、原文之前——事实最确定，原文最具体，梗概居中
  const summaryHits = (input.summaries ?? [])
    .slice(0, MAX_RECALLED_SUMMARIES)
    .map((summary) => summaryHit(input.petId, summary));
  // trimToBudget 保持输入顺序：事实在前，预算不够时先保事实
  const kept = trimToBudget([...factHits, ...summaryHits, ...input.searchEvents()], input.budget ?? {});
  return kept.map((hit) => ({
    id: hit.event.id,
    occurredAt: hit.event.occurredAt,
    role: hit.event.role,
    text: hit.event.text,
  }));
}
