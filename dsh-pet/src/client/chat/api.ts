/**
 * 桌宠对话窗口的数据访问：宠物清单、历史窗口、发一句话、删轮。
 *
 * 只做 HTTP 与响应整形，不碰 DOM、不持状态；失败抛错或回判别联合，
 * 由调用方决定怎么展示——不把异常静默兜底成空列表。
 * @module dsh-pet/src/client/chat/api
 */
import { sendChat, type ChatAttachment } from '../../shared/chat/send.ts';
import { flattenConfigPets } from '../../shared/config.ts';
import { ROUTE_PATH } from '../../shared/constants.ts';
import { postAction } from '../../shared/state.ts';
import type { Pet } from '../../shared/types.ts';

/** 消息里带的图片引用（与宿主 `PetImageRef` 同形，只取显示用到的字段）。 */
export interface ChatImageRef {
  readonly attachmentId: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}

/** 历史里的一条消息（窗口只显示这几项）。 */
export interface ChatMessageView {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly ts: number;
  /** 该轮用户上传的图（`/attachment` 取回）；缺省 = 纯文字。 */
  readonly image?: ChatImageRef;
  /** 该轮 AI 配的表情包名（`/pic/memes` 取回）；缺省 = 没配图。 */
  readonly meme?: string;
  /** 该轮 AI 表演的动作名（重播按钮的入参）；缺省 = 没演动作。 */
  readonly action?: string;
}

/** 一轮对话：一问一答共享同一个 ts，缺一侧（例如删过）也只占一轮。 */
export interface ChatRound {
  readonly ts: number;
  readonly user?: ChatMessageView;
  readonly assistant?: ChatMessageView;
}

/** 删除回执。 */
export type DeleteResult = { ok: true; removed: number } | { ok: false; message: string };

/** 校验并收窄一条图片引用；形状不对返回 undefined（旧记录没有这个字段）。 */
function imageRefOf(raw: unknown): ChatImageRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const ref = raw as Record<string, unknown>;
  if (typeof ref.attachmentId !== 'string' || ref.attachmentId === '') return undefined;
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    attachmentId: ref.attachmentId,
    mediaType: typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png',
    bytes: num(ref.bytes),
    width: num(ref.width),
    height: num(ref.height),
  };
}

/**
 * `GET /chat` 的响应体 → 消息列表。
 *
 * @param body - 响应 JSON（未校验）。
 * @returns 角色与正文都合法的消息；坏条目直接丢弃，一条坏数据不该让整段历史报错。
 */
export function toChatMessages(body: unknown): ChatMessageView[] {
  const raw = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(raw)) return [];
  const out: ChatMessageView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : undefined;
    if (role === undefined || typeof m.content !== 'string') continue;
    const image = imageRefOf(m.image);
    const meme = typeof m.meme === 'string' && m.meme !== '' ? m.meme : undefined;
    const action = typeof m.action === 'string' && m.action !== '' ? m.action : undefined;
    out.push({
      role,
      text: m.content,
      ts: typeof m.ts === 'number' ? m.ts : 0,
      ...(image === undefined ? {} : { image }),
      ...(meme === undefined ? {} : { meme }),
      ...(action === undefined ? {} : { action }),
    });
  }
  return out;
}

/**
 * 按轮分组：同一 `ts` 的问与答合成一轮——显示按轮、删除也按轮。
 *
 * `ts` 为 0（历史里没有时间戳）时每条各自成轮：否则所有无时间戳的消息会被并进一轮。
 *
 * @param messages - 按时间正序的消息。
 * @returns 按出现顺序排列的轮。
 */
export function groupRounds(messages: readonly ChatMessageView[]): ChatRound[] {
  const rounds: ChatRound[] = [];
  for (const message of messages) {
    const last = rounds[rounds.length - 1];
    if (last !== undefined && last.ts === message.ts && message.ts !== 0) {
      rounds[rounds.length - 1] =
        message.role === 'user' ? { ...last, user: message } : { ...last, assistant: message };
      continue;
    }
    rounds.push(message.role === 'user' ? { ts: message.ts, user: message } : { ts: message.ts, assistant: message });
  }
  return rounds;
}

/** 插件 logo 地址：对话面板拿它当宠物头像。 */
export const LOGO_URL = ROUTE_PATH + '/logo';

/**
 * 让宠物重演一次记忆里记下的动作（聊天窗口「播放动作」按钮）。
 *
 * 走 `/anim` 而不是直接改 state：白名单校验、占用锁与显示端门禁、播放回执都由宿主那一条链路负责。
 *
 * @param petId - 宠物 id。
 * @param name - 记忆里记下的动作名（来自 `animations.categories`）。
 * @returns 是否受理成功；失败只留日志，不弹错误条——它只是重播，不影响对话主流程。
 */
export async function playAction(petId: string, name: string): Promise<boolean> {
  // surface=any：与对话同口径——重播不要求特定一端，宠物在哪端渲染就哪端播。
  // /anim 的 surface 是必填项（缺省直接 400），这里不能省。
  return postAction(ROUTE_PATH + '/anim?pet=' + encodeURIComponent(petId) + '&surface=any', { name });
}

/** 附件引用 → 取图地址（宿主按内容哈希回字节）。 */
export function attachmentUrl(ref: ChatImageRef): string {
  return ROUTE_PATH + '/attachment?id=' + encodeURIComponent(ref.attachmentId);
}

/**
 * 表情包名 → 图片地址。
 *
 * @param name - 记忆里记下的名称。
 * @param assetRoot - 宠物所属条目（素材根）；空串时退回两段形式（取不到 pet 包独占的图）。
 */
export function memeUrl(name: string, assetRoot: string): string {
  const root = assetRoot.trim();
  const prefix = root === '' ? '' : encodeURIComponent(root) + '/';
  return ROUTE_PATH + '/pic/memes/' + prefix + encodeURIComponent(name) + '.png';
}

/** 面板需要的配置：宠物列表 + 每个条目保留的对话轮数 + 每只宠物的人设正文。 */
export interface ChatConfig {
  readonly pets: Pet[];
  /** 条目（素材根）→ 该条目配置的 `chatMemoryRounds`；缺失的条目不出现在表里。 */
  readonly roundsByEntry: Readonly<Record<string, number>>;
  /** 宠物 id → 实际在用的人设正文；取值口径见 {@link personaText}。 */
  readonly personaByPet: Readonly<Record<string, string>>;
}

/**
 * 一只宠物实际在用的人设正文。
 *
 * 两级：实例级非空白优先（**替换**所属条目那份，不是拼接），否则用条目顶层那份
 * ——main 条目的条目顶层就是内置默认那句，所以正常配置下不会是空串。
 *
 * @param own - `pets[].whisperPrompt`；缺省或纯空白视为没写。
 * @param entry - 所属条目顶层 `whisperPrompt`；非字符串按没写处理。
 * @returns 实例级原文（保留排版，不 trim）或条目那份；两处都没有时是空串。
 */
export function personaText(own: unknown, entry: unknown): string {
  if (typeof own === 'string' && own.trim() !== '') return own;
  return typeof entry === 'string' ? entry : '';
}

/**
 * 拉成品配置：拍平宠物列表，同时把每个条目的对话记忆轮数与每只宠物的人设带出来。
 *
 * 设置页读的是同一份 `/config`（`merged.main.chatMemoryRounds`），这里按条目取，
 * 面板才能知道「最近几轮才算桌宠的记忆」——不额外发请求，也不在客户端抄一份默认值。
 *
 * @returns 宠物列表、条目轮数表与宠物人设表。
 * @throws 配置请求失败或响应不是成品聚合时。
 */
export async function fetchChatConfig(): Promise<ChatConfig> {
  const res = await fetch(ROUTE_PATH + '/config', { cache: 'no-store' });
  if (!res.ok) throw new Error('config HTTP ' + res.status);
  const body = (await res.json()) as Record<string, unknown>;
  // 业务失败也是 200：ok:false 的体不是成品配置，拿它拍平会静默退化成默认宠物
  if (body.ok === false) throw new Error('config: ' + String(body.reason ?? 'failed'));
  const merged = body as Record<string, Record<string, unknown>>;
  const roundsByEntry: Record<string, number> = {};
  for (const [entry, conf] of Object.entries(merged)) {
    const rounds = Number(conf?.chatMemoryRounds);
    if (Number.isFinite(rounds) && rounds >= 0) roundsByEntry[entry] = Math.floor(rounds);
  }
  const pets = flattenConfigPets(merged);
  const personaByPet: Record<string, string> = {};
  for (const pet of pets) {
    const entry = merged[pet.assetRoot ?? '']?.whisperPrompt;
    personaByPet[pet.id] = personaText(pet.whisperPrompt, entry);
  }
  return { pets, roundsByEntry, personaByPet };
}

/**
 * 记忆边界：最后 `memoryRounds` 轮才算桌宠记得的内容，线要画在它们之前。
 *
 * @param totalRounds - 当前展示的轮数。
 * @param memoryRounds - 该条目配置的保留轮数；`undefined` 表示配置里没有这个值。
 * @returns 分界下标（线插在该下标之前）；全部都在记忆里、或没有记忆时返回 `null`（不画线）。
 */
export function memoryBoundaryIndex(totalRounds: number, memoryRounds: number | undefined): number | null {
  if (memoryRounds === undefined || memoryRounds <= 0) return null;
  const cut = totalRounds - memoryRounds;
  return cut > 0 ? cut : null;
}

/** 一次取满接口允许的轮数（宿主上限 200）：面板在本地按需展示，不做分页取数。 */
export const HISTORY_ROUNDS = 200;

/**
 * 读某只宠物的对话历史。
 *
 * 一次请求取满 200 轮，展示层自己控制「先显示多少」；不传 `rounds` 只会拿到配置的默认轮数。
 *
 * @param petId - 宠物 id。
 * @returns 按时间正序的消息；没有历史时是空列表。
 * @throws 请求失败时。
 */
export async function fetchHistory(petId: string): Promise<ChatMessageView[]> {
  const url = ROUTE_PATH + '/chat?pet=' + encodeURIComponent(petId) + '&rounds=' + HISTORY_ROUNDS;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('chat HTTP ' + res.status);
  return toChatMessages(await res.json());
}

/**
 * 发一句给某只宠物。
 *
 * @param petId - 宠物 id。
 * @param text - 用户输入（宿主 trim 并校验 2000 字上限）。
 * @param attachment - 可选的一张图（已压缩的规范 base64）。
 * @param requestId - 可选的幂等键；同一次发送动作的重试要复用同一个值。
 * @returns 成功回执，或可直接展示的失败文案。
 * @throws 网络中断或响应不是 JSON 时。
 */
export async function sendMessage(
  petId: string,
  text: string,
  attachment?: ChatAttachment,
  requestId?: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  // surface=any：对话窗口不看渲染结果，隐藏（display: none）的宠物也应当能对话
  const url = ROUTE_PATH + '/chat?pet=' + encodeURIComponent(petId) + '&surface=any';
  const result = await sendChat(url, text, attachment, requestId);
  return result.ok ? { ok: true } : { ok: false, message: result.message ?? result.reason };
}

/** 把删除响应收窄成回执；`ts` 为空 = 清空整只。 */
async function deleteChat(petId: string, ts: readonly number[]): Promise<DeleteResult> {
  const query = ts.map((value) => '&ts=' + encodeURIComponent(String(value))).join('');
  const res = await fetch(ROUTE_PATH + '/chat?pet=' + encodeURIComponent(petId) + query, { method: 'DELETE' });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.ok === true) return { ok: true, removed: Number(body.removed ?? 0) };
  const reason = typeof body?.message === 'string' ? body.message : 'HTTP ' + res.status;
  return { ok: false, message: reason };
}

/**
 * 删除若干轮（按 `ts`，一问一答一起走）。
 *
 * @param petId - 宠物 id。
 * @param ts - 要删除的轮；空数组表示没有选中。
 * @returns 实际删除的条数，或失败文案。
 * @throws 网络中断时。
 */
export async function deleteRounds(petId: string, ts: readonly number[]): Promise<DeleteResult> {
  if (ts.length === 0) return { ok: true, removed: 0 };
  return deleteChat(petId, ts);
}

/**
 * 清空某只宠物的全部历史。
 *
 * @param petId - 宠物 id。
 * @returns 实际删除的条数，或失败文案。
 * @throws 网络中断时。
 */
export async function clearHistory(petId: string): Promise<DeleteResult> {
  return deleteChat(petId, []);
}

/** 已删宠物残留的一段历史（只给条数与最后时间，不含正文）。 */
export interface OrphanHistory {
  readonly entry: string;
  readonly petId: string;
  readonly messages: number;
  readonly lastTs: number;
}

/**
 * 读出已删宠物的残留历史。
 *
 * 这些宠物已不在配置里，`GET /chat` 一律 `unknown-pet`——不靠这个接口就既看不到也清不掉。
 *
 * @returns 每个残留分桶一条；没有残留时是空列表。
 * @throws 请求失败时。
 */
export async function fetchOrphans(): Promise<OrphanHistory[]> {
  const res = await fetch(ROUTE_PATH + '/chat/memory', { cache: 'no-store' });
  if (!res.ok) throw new Error('chat/memory HTTP ' + res.status);
  const body = (await res.json()) as { orphans?: unknown };
  const raw = Array.isArray(body.orphans) ? body.orphans : [];
  const out: OrphanHistory[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const one = item as Record<string, unknown>;
    if (typeof one.petId !== 'string') continue;
    out.push({
      entry: typeof one.entry === 'string' ? one.entry : '',
      petId: one.petId,
      messages: typeof one.messages === 'number' ? one.messages : 0,
      lastTs: typeof one.lastTs === 'number' ? one.lastTs : 0,
    });
  }
  return out;
}

/**
 * 清掉所有已删宠物的历史。
 *
 * @returns 删掉的宠物数与消息条数，或失败文案。
 * @throws 网络中断时。
 */
export async function clearOrphans(): Promise<
  { ok: true; pets: number; messages: number } | { ok: false; message: string }
> {
  const res = await fetch(ROUTE_PATH + '/chat/memory', { method: 'DELETE' });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.ok === true) return { ok: true, pets: Number(body.pets ?? 0), messages: Number(body.messages ?? 0) };
  return { ok: false, message: typeof body?.message === 'string' ? body.message : 'HTTP ' + res.status };
}

/** 一条长期记忆（`GET /memory` 的条目，只取显示用到的字段）。 */
export interface MemoryItemView {
  /** 稳定 id，删除按它定位。 */
  readonly id: string;
  /** 发生时刻（毫秒）。 */
  readonly occurredAt: number;
  /** 说话方：`user` / `assistant`。 */
  readonly role: string;
  /** 正文。 */
  readonly text: string;
}

/**
 * 列出或检索某只宠物的长期记忆。
 *
 * 带关键词时走的就是召回用的同一条检索链路——这里看到的就是她会想起来的，所见即所得。
 *
 * @param petId - 宠物 id。
 * @param query - 检索词；缺省浏览全部（最新在前）。
 * @returns 记忆条目。
 * @throws 后端不提供记忆、请求失败或响应非法时。
 */
export async function fetchMemories(petId: string, query?: string): Promise<MemoryItemView[]> {
  const q = query === undefined || query.trim() === '' ? '' : '&q=' + encodeURIComponent(query.trim());
  const url = ROUTE_PATH + '/memory?pet=' + encodeURIComponent(petId) + q;
  const res = await fetch(url, { cache: 'no-store' });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null || typeof body !== 'object') throw new Error('memory HTTP ' + res.status);
  if (body.ok !== true) {
    throw new Error(typeof body.message === 'string' ? body.message : 'memory HTTP ' + res.status);
  }
  const raw = Array.isArray(body.events) ? body.events : [];
  return raw.flatMap((one) => {
    if (one === null || typeof one !== 'object') return [];
    const item = one as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.text !== 'string') return [];
    return [
      {
        id: item.id,
        occurredAt: typeof item.occurredAt === 'number' ? item.occurredAt : 0,
        role: typeof item.role === 'string' ? item.role : 'user',
        text: item.text,
      },
    ];
  });
}

/**
 * 删除若干条长期记忆（软删除：她再也不会提起，但原文留痕）。
 *
 * @param petId - 宠物 id。
 * @param ids - 要删除的记忆 id。
 * @returns 实际删除条数，或失败文案。
 * @throws 网络中断时。
 */
export async function deleteMemoriesById(petId: string, ids: readonly string[]): Promise<DeleteResult> {
  if (ids.length === 0) return { ok: true, removed: 0 };
  const query = ids.map((value) => '&id=' + encodeURIComponent(value)).join('');
  const res = await fetch(ROUTE_PATH + '/memory?pet=' + encodeURIComponent(petId) + query, { method: 'DELETE' });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.ok === true) return { ok: true, removed: Number(body.removed ?? 0) };
  return { ok: false, message: typeof body?.message === 'string' ? body.message : 'HTTP ' + res.status };
}

/** 一条长期事实（「她知道的事」）的展示形状。 */
export interface FactItemView {
  /** 稳定 id，纠正按它定位。 */
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly value: string;
  readonly confidence: number;
  readonly updatedAt: number;
}

/**
 * 列出某只宠物的长期事实。
 *
 * 事实与「聊过的记忆」分开取：前者是提炼后的「知道」，后者是原文。两者可能都为空，
 * 但含义不同——界面上也要分开说，不能合成一个列表。
 *
 * @param petId - 宠物 id。
 * @returns 事实条目；后端不提供或响应非法时回空数组。
 * @throws 网络中断时。
 */
export async function fetchFacts(petId: string): Promise<FactItemView[]> {
  const res = await fetch(ROUTE_PATH + '/facts?pet=' + encodeURIComponent(petId), { cache: 'no-store' });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null || typeof body !== 'object') throw new Error('facts HTTP ' + res.status);
  if (body.ok !== true) {
    throw new Error(typeof body.message === 'string' ? body.message : 'facts HTTP ' + res.status);
  }
  const raw = Array.isArray(body.facts) ? body.facts : [];
  return raw.flatMap((one) => {
    if (one === null || typeof one !== 'object') return [];
    const item = one as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.value !== 'string') return [];
    return [
      {
        id: item.id,
        subject: typeof item.subject === 'string' ? item.subject : '用户',
        predicate: typeof item.predicate === 'string' ? item.predicate : '',
        value: item.value,
        confidence: typeof item.confidence === 'number' ? item.confidence : 0,
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
      },
    ];
  });
}

/** 纠正结果：成功带条数，失败带可展示原因。 */
export type CorrectResult =
  { readonly ok: true; readonly corrected: number } | { readonly ok: false; readonly message: string };

/**
 * 把若干条事实标记为「不对」。
 *
 * 纠正不是删除：旧条置 superseded 留痕；冲突并存的两条各点各的，另一条继续有效。
 *
 * @param petId - 宠物 id。
 * @param ids - 要纠正的事实 id。
 * @returns 实际纠正条数或失败文案。
 * @throws 网络中断时。
 */
export async function correctFactsById(petId: string, ids: readonly string[]): Promise<CorrectResult> {
  if (ids.length === 0) return { ok: true, corrected: 0 };
  const query = ids.map((value) => '&id=' + encodeURIComponent(value)).join('');
  const res = await fetch(ROUTE_PATH + '/facts?pet=' + encodeURIComponent(petId) + query, { method: 'DELETE' });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.ok === true) return { ok: true, corrected: Number(body.corrected ?? 0) };
  return { ok: false, message: typeof body?.message === 'string' ? body.message : 'HTTP ' + res.status };
}
