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
 * 「最近话题」看几轮用户原话。
 *
 * 6 轮大约是一段对话的自然长度：再短看不出话题，再长就退化成全量匹配（什么事实都能
 * 在某段话里找到字面重叠），等于把无关事实挤进提示词。
 */
export const RECENT_USER_TURNS = 6;
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
    // 摘要不是检索命中，但走同一份预算与同一套渲染，用 via 标清来源（日志里能分辨）
    via: 'summary',
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
  /** 最近几轮的用户原话（正序），用于「最近话题」召回；缺省不启用。 */
  readonly recentText?: readonly string[];
  /**
   * 上下文窗口最老一轮的时刻（窗口空时缺省）。
   *
   * **必须在裁预算之前**用它过滤窗口内的原文/摘要：最近几轮必然最新鲜、排序最靠前，
   * 先裁剪再过滤的话，追问场景的 top-5 全是窗口内内容，丢弃后召回直接清零。
   * 事实豁免窗口去重（它不是「某一轮说过的话」）。
   */
  readonly contextOldestTs?: number;
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
/**
 * 最近话题里提到过的事实（补「指代/近指」这一小块）。
 *
 * 事实与查询的匹配只认字面重叠（值/主语/谓语），于是「那个战队赢了吗」永远召不回
 * 「用户 支持 IG战队」——用户刚聊过这件事，她却想不起来，看起来就是「存了不记」。
 *
 * 这里只做**最小可行的近指**：事实的值或主语出现在最近几轮对话里，就当作话题相关、
 * 直接召回。不做同义词、不做向量（那是语义检索，代价完全不同），仍然字面、可解释、可测试。
 *
 * @param petId - 宠物 id。
 * @param facts - 候选事实。
 * @param recentText - 最近几轮的用户原话（按时间正序）。
 * @param options - `exclude` 排除已被查询命中的事实（不重复注入）。
 * @returns 召回命中。
 */
export function recentFactHits(
  petId: string,
  facts: readonly Fact[],
  recentText: readonly string[],
  options: { exclude?: ReadonlySet<string> } = {},
): MemoryHit[] {
  const window = recentText.join(' ').trim();
  if (window === '') return [];
  const exclude = options.exclude ?? new Set<string>();
  const out: MemoryHit[] = [];
  for (const fact of facts) {
    if (exclude.has(fact.id)) continue;
    // 只认「值」：值是结论（手冲咖啡、IG），主语只是「谁」（用户）——后者人人一样，
    // 拿它做近指等于「最近说过『用户』两个字」就把所有事实都召回来。
    // 值本身短于 2 字也不认：单字重叠在中文里到处都是，命中没有意义。
    const key = fact.value;
    if (Array.from(key).length < 2) continue;
    if (!window.includes(key)) continue;
    out.push(factHit(petId, fact));
    if (out.length >= MAX_RECALLED_FACTS) break;
  }
  return out;
}

export function recallWithFacts(input: RecallInput): RecalledMemory[] {
  const picked = selectFacts(input.query, input.facts, {
    maxFacts: input.maxFacts ?? MAX_RECALLED_FACTS,
  });
  const factHits = picked.map((fact) => factHit(input.petId, fact));
  // 查询没命中、但最近聊到过的事实：指代（「那个战队」）时唯一的可靠线索
  const exclude = new Set(picked.map((fact) => fact.id));
  const recentHits = recentFactHits(input.petId, input.facts, input.recentText ?? [], { exclude }).slice(
    0,
    Math.max(0, (input.maxFacts ?? MAX_RECALLED_FACTS) - factHits.length),
  );
  // 摘要不按关键词筛：它的价值是「接上上次」，与当前这句话是否同词无关；
  // 顺序上排在事实之后、原文之前——事实最确定，原文最具体，梗概居中
  const summaryHits = (input.summaries ?? [])
    .slice(0, MAX_RECALLED_SUMMARIES)
    .map((summary) => summaryHit(input.petId, summary));
  // 上下文窗口内的原文/摘要在**裁预算之前**就滤掉：它们已经在对话里，再以「往事」
  // 的身份占预算纯属浪费——最近几轮最新鲜、排序最靠前，先裁剪再滤会把追问场景的
  // 名额全部吃光，窗口外真正该想起的反而进不来。事实豁免（不是「某一轮说过的话」）
  const outsideWindow = (hit: MemoryHit): boolean =>
    input.contextOldestTs === undefined || hit.event.occurredAt < input.contextOldestTs;
  // trimToBudget 保持输入顺序：事实在前，预算不够时先保事实
  const kept = trimToBudget(
    [...factHits, ...recentHits, ...summaryHits.filter(outsideWindow), ...input.searchEvents().filter(outsideWindow)],
    input.budget ?? {},
  );
  return kept.map((hit) => ({
    id: hit.event.id,
    occurredAt: hit.event.occurredAt,
    role: hit.event.role,
    text: hit.event.text,
  }));
}
