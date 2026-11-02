/**
 * 对话面板的状态装配（注入 react 的工厂）。
 *
 * 只做装配：形状见 ./types、动作见 ./actions、副作用见 ./effects、取数在 ./api。
 * 用一个 state 对象装全部字段——切换宠物要同时清空消息与勾选，拆成多个 useState 会露出中间态。
 * @module dsh-pet/src/client/chat/state
 */
import { isDesktopVisible } from '../../shared/config.ts';
import { speakText } from '../../shared/voice.ts';
import { fetchChannelGrants, fetchHistory, groupRounds, playAction as requestPlayAction } from './api.ts';
import {
  createChannelActions,
  createHistoryActions,
  createMemoryActions,
  createSendActions,
  createShellActions,
} from './actions.ts';
import { createChatEffects } from './effects.ts';
import type { ChatPanelRuntime } from './runtime.ts';
import type { ChatPanelState, PanelData } from './types.ts';

/** 首屏与每次「加载更早」放出的轮数。 */
const PAGE_ROUNDS = 10;

/** 初始状态：空列表 + 加载中。 */
const INITIAL: PanelData = {
  pets: [],
  petId: '',
  messages: [],
  draft: '',
  requestId: null,
  attachment: undefined,
  busy: false,
  loading: true,
  error: '',
  selected: [],
  selecting: false,
  orphans: [],
  pending: null,
  visibleRounds: PAGE_ROUNDS,
  previewUrl: undefined,
  roundsByEntry: {},
  personas: {},
  personaOpen: false,
  memoryOpen: false,
  memories: [],
  facts: [],
  summaries: [],
  memoryQuery: '',
  memoryLoading: false,
  pendingMemoryId: null,
  pendingFactId: null,
  forgetNote: '',
  usage: null,
  speaking: null,
  channelGrants: [],
  bindCode: null,
  bindLoading: false,
  pendingScopeId: null,
  unlinkNote: '',
};

/**
 * 造状态 hook。
 *
 * @param rt - 注入的 react 能力。
 * @returns 无参 hook：每次渲染返回当前状态、派生值与动作。
 */
export function createPetChatState(rt: ChatPanelRuntime): () => ChatPanelState {
  const { useRef, useState } = rt;
  const useChatEffects = createChatEffects(rt);

  return function usePetChatState(): ChatPanelState {
    const [data, setData] = useState<PanelData>(INITIAL);
    /**
     * 「此刻」的状态镜像：ports.read() 必须读到当前值，而不是发起请求那一渲染的快照。
     * 否则异步续体（取数回来时）读到的是旧状态——换宠后的旧响应能骗过 petId 校验。
     */
    const dataRef = useRef(data);
    dataRef.current = data;
    const listRef = useRef<HTMLDivElement | null>(null);
    const draftRef = useRef<HTMLTextAreaElement | null>(null);
    /**
     * 记忆检索的取数次序号：必须放在 ref 里持久持有。
     *
     * 动作对象每次渲染都会重建，闭包里的计数器跟着重置——「慢的旧响应不覆盖新结果」
     * 的乱序保护就会失效。ref 让重建多少次都指同一个计数器。
     */
    const searchSeq = useRef({ token: 0 });
    /** 已贴到底的那条消息（`ts`）：只有它变化时才自动滚到底。 */
    const newestTs = useRef(0);

    const patch = (next: Partial<PanelData>): void => setData((prev) => ({ ...prev, ...next }));
    const fail = (error: unknown): void => patch({ error: error instanceof Error ? error.message : String(error) });

    /**
     * 换宠后重取一次绑定列表。
     *
     * 绑定码是按宠物签发的，列表却是全局的；换宠不清会让新面板显示上一只的码。
     */
    const channelRefresh = async (petId: string): Promise<void> => {
      try {
        const grants = await fetchChannelGrants();
        if (dataRef.current.petId !== petId) return;
        patch({ channelGrants: grants, bindCode: null, unlinkNote: '' });
      } catch {
        // 旧后端没有这个端点：不报错，卷帘里本来就不会有这一段
      }
    };

    /** 重读某只宠物的历史；失败只落在 error 上，不静默清空已有消息。 */
    const reload = async (petId: string): Promise<void> => {
      if (petId === '') return;
      try {
        const messages = await fetchHistory(petId);
        // 换宠后的旧响应不算数（与记忆取数同一口径）
        if (dataRef.current.petId !== petId) return;
        patch({ messages });
      } catch (error) {
        if (dataRef.current.petId !== petId) return;
        fail(error);
      }
    };

    useChatEffects({ data, patch, fail, reload, listRef, draftRef, newestTs });

    const ports = { read: () => dataRef.current, patch, fail, reload };
    const history = createHistoryActions(ports);
    const memory = createMemoryActions(ports, searchSeq.current);
    const channel = createChannelActions(ports);
    const shell = createShellActions({ ports, history, memory, channel, listRef, pageRounds: PAGE_ROUNDS });
    const pet = data.pets.find((one) => one.id === data.petId);
    const allRounds = groupRounds(data.messages);
    const rounds = allRounds.slice(-data.visibleRounds);

    return {
      ...data,
      ...createSendActions(ports),
      ...history,
      ...memory,
      ...channel,
      ...shell,
      rounds,
      hasOlder: allRounds.length > rounds.length,
      petName: pet?.name || '宠',
      assetRoot: pet?.assetRoot ?? '',
      desktopVisible: isDesktopVisible(pet?.display ?? 'none'),
      memoryRounds: data.roundsByEntry[pet?.assetRoot ?? ''],
      persona: data.personas[data.petId] ?? '',
      togglePersona: () => patch({ personaOpen: !data.personaOpen }),
      closePersona: () => patch({ personaOpen: false }),
      // 展开卷帘时顺带取一次绑定列表：这一段不随记忆检索变化，
      // 但「刚在别处生成过码」之后展开应当是新的
      toggleMemory: () => {
        const opening = !data.memoryOpen;
        memory.toggleMemory();
        if (opening) void channelRefresh(data.petId);
      },
      closeMemory: () => patch({ memoryOpen: false }),
      listRef,
      draftRef,
      toggleDisplay: () => shell.toggleDisplay(),
      pickPet: (petId: string) => {
        // 换宠 = 作废在途的记忆取数：旧宠物的慢响应不能写进另一只的卷帘（序号推进后被丢弃）
        searchSeq.current.token += 1;
        patch({
          petId,
          messages: [],
          selected: [],
          selecting: false,
          pending: null,
          visibleRounds: PAGE_ROUNDS,
          error: '',
          // 旧宠物在途发送的忙碌锁不该挡住新面板；发送回执另有 petId 守卫，不会写进来
          busy: false,
          // 换宠 = 换记忆：卷帘收起并清空，展开时会按新宠物重新取。
          // 下面这组是「按宠物分的数据」的全部字段——新增一类记忆，记得也在这里清掉，
          // 否则新宠物的卷帘会显示上一只的内容（摘要就漏过一次）
          memoryOpen: false,
          memories: [],
          facts: [],
          summaries: [],
          memoryQuery: '',
          memoryLoading: false,
          pendingMemoryId: null,
          pendingFactId: null,
          forgetNote: '',
          // 渠道绑定也是按宠物分的：换宠要清掉，否则新宠物的卷帘里会挂着上一只绑过的人
          channelGrants: [],
          bindCode: null,
          bindLoading: false,
          pendingScopeId: null,
          unlinkNote: '',
        });
        void reload(petId);
        // 绑定列表是全局的，但「谁能跟她说话」跟宠物无关，却要按当前宠物重新问一次：
        // 断开时要用当前 petId 去清记忆，显示的也必须是最新的
        void channelRefresh(petId);
      },
      toggleSelecting: () => patch({ selecting: !data.selecting, selected: [] }),
      toggleRound: (ts: number) =>
        patch({
          selected: data.selected.includes(ts) ? data.selected.filter((one) => one !== ts) : [...data.selected, ts],
        }),
      // 改字就是另一句话：把上一次发送动作的幂等键作废，否则重试会被误认成「同一句还在跑」
      setDraft: (draft: string) => patch({ draft, requestId: null }),
      speakRound: (ts: number, text: string) => {
        // 阶段回调只写「仍是这一轮」的状态：被别的一条顶掉时，旧请求的 idle 不能清掉新状态
        speakText(text, (phase) => {
          setData((prev) => {
            if (phase === 'idle') return prev.speaking?.ts === ts ? { ...prev, speaking: null } : prev;
            return { ...prev, speaking: { ts, phase } };
          });
        });
      },
      playAction: (name: string) => {
        // 没选中宠物时不发请求：空 id 会被宿主按 bad-request 拒掉
        if (data.petId !== '') void requestPlayAction(data.petId, name);
      },
      clearAttachment: () => patch({ attachment: undefined }),
      showImage: (previewUrl: string) => patch({ previewUrl }),
      closeImage: () => patch({ previewUrl: undefined }),
    };
  };
}
