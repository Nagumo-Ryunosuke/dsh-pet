# SOUL 接入说明（fork 定制部分）

本仓库是 `PC2005-cloud/dsh-pet` 的 fork，在上游 0.3.8（`0b8a6ad` 之后的 fork main）基础上加了一个可切换的「灵魂」聊天后端。上游代码除少数显式标注的改动外**未动**。

分支 `feat/m0-soul-backend`，全部工作已推送。完整的交接文档（现状、路线图、踩坑记录）在灵魂仓库：

> **https://github.com/Nagumo-Ryunosuke/deepseek-pet/blob/main/HANDOFF.md**

本文件只列 fork 相对上游的差异，供快速定位。

## 新增的环境变量

| 变量                   | 取值                              | 作用                                                                       |
| ---------------------- | --------------------------------- | -------------------------------------------------------------------------- |
| `DSH_PET_CHAT_BACKEND` | `native`（默认）/ `soul` / `fake` | 聊天后端选择，装配期读一次，切换需重启                                     |
| `DSH_PET_M0_FAULT`     | `1`                               | fake 后端的故障注入开关（默认关）                                          |
| `DSH_PET_PERSONA`      | 文件路径                          | 指定人格文件（soul 模式；缺省用数据目录 `persona.yaml`，首次运行自动播种） |
| `DSH_PET_SOUL_MODEL`   | `echo`                            | 回声模型，链路验证用，不调真实模型                                         |

## 新增的记忆配置（条目级，`main-config.jsonc` 顶层）

| 键                       | 默认 | 含义                                                                      |
| ------------------------ | ---- | ------------------------------------------------------------------------- |
| `chatMemoryItems`        | 5    | 每轮最多注入几条（事实 + 聊天原文合计），1–20                             |
| `chatMemoryTokens`       | 400  | 这些内容的 token 总预算，80–2000                                          |
| `chatMemoryItemTokens`   | 120  | 单条上限，超了截断而不是丢弃，20–600；会被总预算压住                      |
| `chatMemoryFacts`        | 3    | 其中最多几条是长期事实（其余额度留给原文），0–10                          |
| `memoryExtractDailyRuns` | 4    | 记忆维护（抽取 + 摘要重建）每日模型调用上限，1–20；撞上限时日志每天留一条 |

写坏（越界 / 非整数）回落默认并留一行 warn；配置每次召回现读，改完不必重启。
**这四个键必须在 `assets/config.jsonc` 里存在**——用户层只能覆盖默认文件已有的键，
否则会被静默丢弃（`mergeEntry` 只遍历默认键）。

## 新增/修改的文件（相对上游）

- `src/host/soul/`（新增目录）：`mode.ts`（模式选择）、`real-soul.ts`（真灵魂适配：人格播种、模型网关、历史与记忆存储、召回、事实抽取的宿主侧）、`fake-soul.ts`（M0 假后端，接线检查用）、`command.ts`（soul/fake 模式下的 `/chat` 拒绝桩）。
- `src/host/index.ts`：按模式装配聊天后端（核心改动约 20 行）。
- `src/host/routes/chat.ts` + `routes/types.ts`：`chatWithPet` 增加可选 `requestId`（幂等）与 `chatSupportsImages`（soul 模式在**落盘前**拒绝图片）；新增 `routes/memory.ts`（`GET/DELETE /memory`，记忆可见化）与 `routes/facts.ts`（`GET/DELETE /facts`，长期事实的列出与「不对」纠正；纠正为 `superseded`，不删原文）。
- `src/host/plugin/loops.ts`：`registerExtractionMaintenance` 每分钟唤醒一次灵魂侧的抽取节拍器（空闲 10 分钟 / 累计 10 条 / 每日 4 次预算 / 回复在途时跳过都由节拍器判断，宿主只提供时钟）。
- `src/host/soul/recall.ts`：把长期事实与聊天原文融合进同一份召回预算（事实在前，最多 3 条）。
- `src/host/soul/budget.ts`：记忆预算的配置解析（`chatMemory*` 四项），越界/类型错误回落默认并 warn（同一条告警每进程只报一次）。
- `src/host/routes/facts.ts` + `types.ts`：事实条目额外带 `sources`（仍存活的来源条数）与 `from`（最新那句原文，截 48 字）；`/memory?q=` 的条目带 `via`（`fts` / `substring` / `decomposed`，浏览时不带）。
- `src/host/routes/summaries.ts`：`GET /summaries` 只列 active 摘要（只读，DELETE 回 405）；面板卷帘多一段「聊过的大概」。
- `src/host/soul/real-soul.ts`：`openStores` 多开一个 `SqliteSummaryStore`（同库同句柄），并把它同时传给记录器（删聊天时转 `dirty`）、抽取器（顺手写梗概）与召回（事实 → 摘要 → 原文）。
- 摘要重建：`createSummaryRebuilder` 由灵魂侧提供，宿主挂进维护定时器的 `rebuild` 钩子；只在该宠物没有待抽取事件时才跑，任务行 `jobs.type = summarize`，与抽取共用每日预算。
- `src/client/chat/`：发送携带幂等键；「记忆」卷帘里把「她知道的事」（事实，可点「不对」）与「聊过的」（原文，可「忘掉」）分开展示。
- `tsdown.config.mjs`：`@deepseek-pet/soul`、`zod`、`openai`、`@anthropic-ai/sdk` 改为内联（`noExternal`）——灵魂包不在任何 registry 上，插件按目录拷贝安装，外部引用会断。
- `package.json` / `pnpm-lock.yaml`：依赖 `@deepseek-pet/soul`（`link:` 指向灵魂仓库，仅开发期）。

## 行为变化

- 默认（`native`）与上游一致，所有新代码休眠。
- `soul` 模式下：聊天由灵魂驱动（人格 + 长期记忆 + 召回），**暂不支持**图片附件、`/chat` 斜杠命令、碎碎念与梦话（均明确报错，不假成功）；历史与 native 互不相通（不自动迁移 `memory.json`）。

## 测试

`npm test` 全量 2214 项 0 失败（此前两处偶发已修：`withDeadline` 把截止定时器 `unref` 掉、body 超时与 413 的竞速）。新增测试集中在 `src/host/routes/memory.test.ts`、`routes/facts.test.ts`、`chat-idempotency.test.ts`、`src/host/soul/recall.test.ts`、`src/host/soul/budget.test.ts`、`src/client/chat/actions.test.ts`。
