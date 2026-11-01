/**
 * 对话面板的动作：记忆删除、发送、附图、确认分发与「加载更早」。
 *
 * 由 ./state 用当前状态装配；这里不持有状态，只把一次用户动作翻译成「调接口 → 补丁」。
 * 每个动作自己兜住异常并交给 fail 端口，调用方拿到的永远是同步的空返回。
 * @module dsh-pet/src/client/chat/actions
 */
import { encodeImageFile } from '../../shared/chat/encode.ts';
import {
  clearHistory,
  clearOrphans as clearOrphansApi,
  correctFactsById,
  deleteMemoriesById,
  deleteRounds,
  fetchFacts,
  fetchMemories,
  fetchSummaries,
  fetchUsage,
  sendMessage,
  type DeleteResult,
} from './api.ts';
import type { ConfirmKind, PanelData } from './types.ts';

/**
 * 给一次发送动作生成幂等键。
 *
 * 优先用 `crypto.randomUUID`（Electron 与 localhost 都是安全上下文，正常都有）；拿不到时
 * 退回「时间戳 + 随机串」——这个键只要求在同一只宠物下不重复，不要求密码学强度。
 *
 * @returns 一个新的请求标识。
 */
function newRequestId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const uuid = cryptoApi?.randomUUID?.();
  if (typeof uuid === 'string' && uuid !== '') return uuid;
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** 动作需要的最小端口。 */
export interface ActionPorts {
  /** 读写当前状态快照（每次渲染重建，取到的就是最新值）。 */
  readonly read: () => PanelData;
  /** 合并一次状态补丁。 */
  readonly patch: (next: Partial<PanelData>) => void;
  /** 把任何异常归一成可展示文案。 */
  readonly fail: (error: unknown) => void;
  /** 重新拉取某只宠物的历史。 */
  readonly reload: (petId: string) => Promise<void>;
}

/** 记忆动作：按轮删除与清空整只。 */
export function createHistoryActions(ports: ActionPorts): {
  deleteSelected: () => void;
  clearAll: () => void;
} {
  /** 跑一次删除：失败只报错；成功后清勾选并以服务端为准重读。 */
  const apply = async (run: () => Promise<DeleteResult>): Promise<void> => {
    try {
      const result = await run();
      if (!result.ok) {
        ports.fail(result.message);
        return;
      }
      ports.patch({ selected: [], error: '' });
      await ports.reload(ports.read().petId);
    } catch (error) {
      ports.fail(error);
    }
  };

  return {
    deleteSelected: (): void => {
      const { petId, selected } = ports.read();
      if (petId === '' || selected.length === 0) return;
      void apply(() => deleteRounds(petId, selected));
    },
    clearAll: (): void => {
      const { petId } = ports.read();
      if (petId === '') return;
      void apply(() => clearHistory(petId));
    },
  };
}

/** 发送动作：附图压缩、发送、成功后重读。 */
export function createSendActions(ports: ActionPorts): {
  send: () => void;
  pickFile: (file: File) => void;
} {
  return {
    send: (): void => {
      const data = ports.read();
      const text = data.draft.trim();
      if (text === '' || data.busy || data.petId === '') return;
      // 幂等键跟着「这一句草稿」走：首次点发送时生成，失败后重按发送复用它，
      // 宿主就能认出上一把是不是其实已经生成好了——只是回执在路上丢了
      const requestId = data.requestId ?? newRequestId();
      ports.patch(data.requestId === null ? { busy: true, error: '', requestId } : { busy: true, error: '' });
      void (async () => {
        try {
          const attachment =
            data.attachment === undefined
              ? undefined
              : { mediaType: data.attachment.mediaType, data: data.attachment.base64 };
          const result = await sendMessage(data.petId, text, attachment, requestId);
          if (!result.ok) {
            // 失败时保留 requestId：不清空，用户重按发送才是「重试同一件事」
            ports.fail(result.message);
            return;
          }
          // 这一句已经落地，键的任务结束：下一句是另一件事
          ports.patch({ draft: '', attachment: undefined, requestId: null });
          await ports.reload(data.petId);
        } catch (error) {
          ports.fail(error);
        } finally {
          ports.patch({ busy: false });
        }
      })();
    },
    pickFile: (file: File): void => {
      void (async () => {
        try {
          ports.patch({ attachment: await encodeImageFile(file), error: '' });
        } catch (error) {
          ports.fail(error);
        }
      })();
    },
  };
}

/** 外壳动作需要的额外句柄。 */
export interface ShellDeps {
  readonly ports: ActionPorts;
  /** 记忆删除动作（确认后要分发到它们）。 */
  readonly history: { deleteSelected: () => void; clearAll: () => void };
  /** 「忘掉一条记忆」与「这条事实不对」动作（确认后要分发到它们）。 */
  readonly memory: { forgetConfirmed: (id: string) => void; correctFactConfirmed: (id: string) => void };
  /** 消息列表容器：展开更早的轮时要按高度差补偿滚动。 */
  readonly listRef: { current: HTMLDivElement | null };
  /** 每次「加载更早」放出的轮数。 */
  readonly pageRounds: number;
}

/** 外壳动作：孤儿清理、确认条分发、「加载更早」。 */
export function createShellActions(deps: ShellDeps): {
  clearOrphans: () => void;
  ask: (kind: ConfirmKind) => void;
  cancelAsk: () => void;
  confirmAsk: () => void;
  showOlder: () => void;
} {
  const { ports, history, memory, listRef, pageRounds } = deps;

  /** 清掉已删宠物残留的历史。 */
  const clearOrphans = (): void => {
    void (async () => {
      try {
        const result = await clearOrphansApi();
        if (!result.ok) {
          ports.fail(result.message);
          return;
        }
        ports.patch({ orphans: [], error: '' });
      } catch (error) {
        ports.fail(error);
      }
    })();
  };

  /** 确认条点「确定」后按待办类型分发；先清 pending，避免重复触发。 */
  const confirmAsk = (): void => {
    const kind = ports.read().pending;
    const memoryId = ports.read().pendingMemoryId;
    const factId = ports.read().pendingFactId;
    // 一起清：先分发再清的话，「忘掉」这边就拿到 null 了
    ports.patch({ pending: null, pendingMemoryId: null, pendingFactId: null });
    if (kind === 'delete-selected') history.deleteSelected();
    else if (kind === 'clear-all') history.clearAll();
    else if (kind === 'clear-orphans') clearOrphans();
    else if (kind === 'forget-memory' && memoryId !== null) memory.forgetConfirmed(memoryId);
    else if (kind === 'correct-fact' && factId !== null) memory.correctFactConfirmed(factId);
  };

  /** 多放一批更早的轮；按高度差补偿滚动位置，视线不跳。 */
  const showOlder = (): void => {
    const el = listRef.current;
    const before = el?.scrollHeight ?? 0;
    ports.patch({ visibleRounds: ports.read().visibleRounds + pageRounds });
    if (el === null) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight - before;
    });
  };

  return {
    clearOrphans,
    ask: (kind: ConfirmKind) => ports.patch({ pending: kind }),
    cancelAsk: () => ports.patch({ pending: null, pendingMemoryId: null, pendingFactId: null, forgetNote: '' }),
    confirmAsk,
    showOlder,
  };
}

/**
 * 记忆卷帘的动作：展开取数、按词检索、删单条 / 纠正事实后按当前词重取。
 *
 * 删除是软删除（退出检索、原文留痕），删完重取而不是本地移除——条数以服务端为准。
 * 事实与聊天原文分开取：前者是「知道」，后者是「说过」。
 * @param ports - 动作端口。
 * @returns 记忆卷帘的动作。
 */
export function createMemoryActions(ports: ActionPorts): {
  toggleMemory: () => void;
  setMemoryQuery: (query: string) => void;
  searchMemories: (query: string) => void;
  deleteMemory: (id: string) => void;
  forgetConfirmed: (id: string) => void;
  correctFact: (id: string) => void;
  correctFactConfirmed: (id: string) => void;
} {
  /**
   * 取数次序号：只有最新一次请求能写状态。
   *
   * 检索是用户手触发的，两次请求的完成顺序不保证——慢的旧响应后到，会把新结果
   * 覆盖成旧结果，用户看到的就是「搜 A 出现了 B 的结果」。
   */
  let searchToken = 0;

  /** 按当前检索词取一次数；失败只落在 error 上，已列出的条目不动。 */
  const refresh = async (query: string): Promise<void> => {
    const token = ++searchToken;
    const data = ports.read();
    if (data.petId === '') return;
    ports.patch({ memoryLoading: true });
    try {
      // 事实层单独兜底：旧版后端没有 /facts 时，记忆列表照常可用，只是事实段为空
      const [items, facts, summaries, usage] = await Promise.all([
        fetchMemories(data.petId, query),
        fetchFacts(data.petId).catch(() => []),
        // 摘要单独兜底：旧后端没有 /summaries 时，事实与记忆照常显示
        fetchSummaries(data.petId).catch(() => []),
        // 用量单独兜底：旧后端没有 /usage 时只是不显示调用记录段，别把整次刷新拖下水
        fetchUsage().catch(() => null),
      ]);
      if (token !== searchToken) return; // 已被更新的请求取代，丢掉这份结果
      ports.patch({ memories: items, facts, summaries, usage });
    } catch (error) {
      if (token !== searchToken) return;
      ports.fail(error);
    } finally {
      if (token === searchToken) ports.patch({ memoryLoading: false });
    }
  };

  return {
    toggleMemory: (): void => {
      const opening = !ports.read().memoryOpen;
      ports.patch({ memoryOpen: opening });
      // 展开时才取数：收着的时候数据会过期，展开那一刻取的是最新的
      if (opening) void refresh(ports.read().memoryQuery);
    },
    // 只改词不发请求：请求由 Enter 触发，敲字打爆检索比多按一次 Enter 糟糕得多
    setMemoryQuery: (query: string): void => ports.patch({ memoryQuery: query }),
    searchMemories: (query: string): void => {
      ports.patch({ memoryQuery: query });
      void refresh(query);
    },
    // 删除也走确认条：与清空历史同一待遇。「她再也不会提起」是用户可见的变化，
    // 误触一下就少一件她记得的事，不该省这一次确认
    deleteMemory: (id: string): void => ports.patch({ pending: 'forget-memory', pendingMemoryId: id, forgetNote: '' }),
    forgetConfirmed: (id: string): void => {
      void (async () => {
        const data = ports.read();
        try {
          const result = await deleteMemoriesById(data.petId, [id]);
          if (!result.ok) {
            ports.fail(result.message);
            return;
          }
          // 把「清到了哪一层」如实告诉用户：运行系统已不可见，但磁盘备份/WAL 未必清掉——
          // 别让他以为删了就等于从磁盘彻底消失
          const note =
            result.cleanup === 'purged'
              ? `已从运行系统与磁盘备份中清除 ${result.removed} 条。`
              : `已从运行系统移除 ${result.removed} 条（她不会再提起）；磁盘上的备份 / WAL 可能仍保留，直到备份轮转或手动清理。`;
          ports.patch({ forgetNote: note });
          await refresh(data.memoryQuery);
        } catch (error) {
          ports.fail(error);
        } finally {
          ports.patch({ pendingMemoryId: null });
        }
      })();
    },
    // 纠正一条事实：旧条置 superseded 留痕，她之后不再把它当事实；同样先确认
    correctFact: (id: string): void => ports.patch({ pending: 'correct-fact', pendingFactId: id }),
    correctFactConfirmed: (id: string): void => {
      void (async () => {
        const data = ports.read();
        try {
          const result = await correctFactsById(data.petId, [id]);
          if (!result.ok) {
            ports.fail(result.message);
            return;
          }
          await refresh(data.memoryQuery);
        } catch (error) {
          ports.fail(error);
        } finally {
          ports.patch({ pendingFactId: null });
        }
      })();
    },
  };
}
