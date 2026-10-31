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

import { selectFacts, trimToBudget, type Fact, type MemoryHit, type RecalledMemory } from '@deepseek-pet/soul';

/** 每轮最多注入几条事实（总预算仍是 trimToBudget 的 5 条 / 400 token）。 */
export const MAX_RECALLED_FACTS = 3;

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

/** 融合召回输入。 */
export interface RecallInput {
  readonly petId: string;
  readonly query: string;
  /** 该宠物的 active 事实（已按存储上限取出）。 */
  readonly facts: readonly Fact[];
  /** 聊天原文的召回调；由调用方决定检索实现。 */
  readonly searchEvents: () => readonly MemoryHit[];
}

/**
 * 融合事实与聊天原文，并裁剪到同一份预算。
 *
 * @param input - 宠物、当前输入、事实候选与原文检索。
 * @returns 已排序、已裁剪的往事列表；事实在前。
 */
export function recallWithFacts(input: RecallInput): RecalledMemory[] {
  const factHits = selectFacts(input.query, input.facts, { maxFacts: MAX_RECALLED_FACTS }).map((fact) =>
    factHit(input.petId, fact),
  );
  // trimToBudget 保持输入顺序：事实在前，预算不够时先保事实
  const kept = trimToBudget([...factHits, ...input.searchEvents()]);
  return kept.map((hit) => ({
    id: hit.event.id,
    occurredAt: hit.event.occurredAt,
    role: hit.event.role,
    text: hit.event.text,
  }));
}
