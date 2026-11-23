# Chat ↔ RPG Bridge (设计稿 v0.1)

## 0. M1 实施状态（v1.4.0 已完成）

| 能力 | 落地位置 |
|---|---|
| 增量世界书（稳定条目 id、只改自己的条目、旧条目收养） | `plugin/src/lorebook.js`，`buildEntries` / `mergeEntries` / `pushLorebook` |
| 只读状态镜像 | `plugin/src/bridge.js` → `trackerMirror`，`GET /campaigns/:id/bridge/mirror` |
| Tracker → 审核队列 | `pullTrackerNarrative`，`POST /campaigns/:id/bridge/tracker/pull` |
| 关系提案 tool | `strpg_propose_relation`（±2 上限、PENDING 去重） |
| 审核 → 事务应用 | `approveCandidate` / `rejectCandidate` + `bridge_apply_log` |
| 数据库 | `bridge_candidates`（部分唯一索引仅约束 PENDING）、`bridge_apply_log`，schema v4 |
| 前端 | `frontend/src/trackerBridge.js` + Integrations → **State & Memory Bridge** 面板 |
| 测试 | `tests/bridge.test.js`（9 例，套件合计 48） |

已实测（本机 Emberfall Demo）：旧世界书 13 条无标记条目被识别为遗留并替换，新写入 14 条带 `[STRPG]` 标记的条目，用户手写条目 0 条受影响。

尚未实现（M3）：scope 定义与扫描器、trade/barter tool、角色卡→NPC 导入、`chat` 交互类型。

## 0.1 M2 实施状态（v1.5.0 已完成）

| 能力 | 落地位置 |
|---|---|
| NPC 服务配置（招募/学费/恢复/砍价） | `npcSchema`：`recruit`、`teaching`、`recovery`、`shop.haggle` |
| 服务引擎（报价、校验、结算） | `plugin/src/social.js`：`quoteTrade` / `propose*` / `apply*` / `socialOptions` |
| 服务提案进审核队列 | 候选 kind：`trade` / `recruit` / `tuition` / `recovery`，审批走同一事务与审计 |
| 5 个新 tool | `strpg_get_social_options`、`strpg_propose_trade`、`strpg_propose_recruit`、`strpg_propose_tuition`、`strpg_propose_recovery` |
| 战败触发器 | `settleDefeat` 触发 `combat_defeat` 事件 + `advanceStory('combat.defeat')` |
| 新事件动作 | `adjust_relation`、`take_item`、`add_memory`、`open_chat` |
| 示例内容 | Borin 教 `quick_slash`（40 金，可砍价）；Mira 60 金可招募；Lina 30 金 + 2 草药可招募，低血量会求助；`defeat_at_shrine` 战败事件 |
| 测试 | `tests/social.test.js`（9 例，套件合计 57） |

M2 的语义：**聊天里发起 → 服务端报价/校验 → 审核 → 事务结算**。砍价的价格下限由服务端算
（关系 + 智力/幸运，受 `shop.haggle.maxDiscount` 限制）；低于标价 35% 视为侮辱性报价直接拒绝；
介于下限与标价之间返回还价。学徒/招募/恢复同样先出候选，批准后才扣钱、入队、学技能或回血。

尚未实现（M3）：scope 扫描器与高级 inbox、劳务抵账生成 quest（service-barter）、
角色卡→NPC 导入、独立 NPC 聊天模式、`open_chat` 的前端自动拉起。

---

目标：让 RPG 与聊天共用一套「记忆 + 关系 + 状态」，两个方向都能走：

1. **聊天里的角色进入 RPG**（复用现有 chat 的 persona/角色卡当 NPC 或玩家）
2. **RPG 里创建的角色进入聊天**（NPC → 角色卡 → 真实对话）

并解决三件事：

- RPG Tracker / Memory Books 的关键信息自动互通（有审核、有审计、有冲突规则）
- 世界书（lorebook）能同时承载「静态设定」和「动态 RPG 状态」，在聊天里按关键词/向量激活
- NPC 聊天不再是 3 个固定选项：`shop` / `quest` 这类仍是确定性交互，`chat` 则进入真正的对话，并且能通过 tool call + event hook 改数据（砍价、抵账、给物品、记承诺）

---

## 1. 现状盘点（本仓库真实代码）

| 能力 | 现状 | 位置 |
|---|---|---|
| 每回合 RPG 状态注入聊天 | 已实现：`setExtensionPrompt('STRPG_CONTEXT', ...)` 注入紧凑状态（位置 1、深度 2） | `frontend/src/App.jsx:452-476` |
| LLM → RPG 的动作提议 | 已实现但很窄：聊天里解析 `<strpg>{"tool":...}</strpg>`，只允许 3 个 tool | `frontend/src/App.jsx:400-429` |
| 服务端工具面 | 8 个 `strpg_*` tool，其中 3 个是"提议"（移动/遭遇/NPC 反应），其余只读 | `plugin/src/tools.js:9-21` |
| 聊天绑定战役 | 已实现：`chat_bindings` 表 + `/campaigns/:id/bind-chat` | `plugin/src/app.js:250-260` |
| NPC → 角色卡 | 已实现（`tavern` 字段记录 avatar/importedAt） | `plugin/src/tavern.js` |
| 角色卡 → NPC | **缺失**（反向没有） | — |
| 世界书生成 | 已实现：`buildMemoryBook` 生成整本书；`pushMemoryBook` 调 `/api/worldinfo/edit` 覆盖写 | `plugin/src/memorybook.js:41-77` |
| 世界书种子（当前局面） | 只写「当前地点/玩家等级」等 5 条基础条目，**不含**关系、承诺、债务、事件 | `plugin/src/memorybook.js:49-61` |
| Tracker 同步 | 只做 narrative 白名单写入 `narrative_state`，不读回、不推送 | `plugin/src/integrations.js:7-68` |
| Memory Books 适配 | 只导出 markdown 给人工粘贴，不写它内部存储 | `plugin/src/integrations.js:70-112` |
| NPC 交互 | 固定类型：talk/shop/accept_quest/turn_in_quest/join_party/heal/story/custom | `plugin/src/schemas.js:147` |
| NPC 关系 | 已有 `npc:<key>:relation` 变量（整数，+1 递增） | `plugin/src/interactions.js:27-35` |
| 商店买卖 | 已有 `npcBuy`/`npcSell`，价格 = 单价 × `shop.buyRate` | `plugin/src/interactions.js:193-207` |
| 事件系统 | 实际触发只有 `enter` / `interact` / `combat_victory` / `manual`；动作白名单 9 种 | `plugin/src/world.js:250-287`、`plugin/src/story.js:73-126` |

**结论**：底座已经够用，缺的是「身份绑定 + 双向记忆 + 可审核的 scope + 交易类 tool」。

---

## 2. 可借鉴的成熟机制

| 来源 | 机制 | 可借鉴点 |
|---|---|---|
| SillyTavern 世界书（[官方文档](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)） | 关键词/正则触发、递归、`sticky`/`cooldown`/`delay`、`outlet`、角色/人格/聊天级绑定、向量化条目 | 动态 RPG 状态不必塞进系统提示：写成带 key 的条目，聊到才注入；用 `sticky` 让「刚发生的事」保持 N 回合 |
| SillyTavern Function Calling（[getContext().registerFunctionTool](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/st-context.js)、[ToolManager](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/tool-calling.js)） | 扩展注册带 JSON Schema 的工具，LLM 直接结构化调用 | 用真 tool 替代 `<strpg>` 文本块：砍价、抵账、打赏、打探消息都能成为一击即中的结构化调用 |
| Memory Books（[aikohanasaki/SillyTavern-MemoryBooks](https://github.com/aikohanasaki/SillyTavern-MemoryBooks)） | 聊天绑定 lorebook；按间隔/场景区间自动摘要成条目；有 memory preview 可审核；side prompt 集合 | 聊天→记忆这段不必重写：复用它的摘要产物（同一个聊-bound lorebook），STRPG 只做「读入 + 结构化」 |
| Scene-Continuity-Bridge（本地扩展，本机扩展 `Scene-Continuity-Bridge/docs/rpg-tracker-integration.md`） | `Manager 输出 → 逐项审核（证据/置信度/锁定）→ 提交应用 → Delta Log`；不自动提交 | 这就是「scope 扫描 → 审核 → 落库」的现成范式；直接借用它的审核语义和 `RPGBridge` 接线方式 |
| RPG Tracker（[Soyo5800/rpg-tracker-for-sillytavern](https://github.com/Soyo5800/rpg-tracker-for-sillytavern)） | `window.RPGBridge` 暴露 `currentTrackerData` / `saveChatData` / 锁快照；Merged/Separated/Isolated 三种注入模式 | 双向同步走它的公开桥，不碰它源码；用「Separated 只读注入 + STRPG 推送」避免两套逻辑打架 |
| World Info Recommender（[bmen25124/SillyTavern-WorldInfo-Recommender](https://github.com/bmen25124/SillyTavern-WorldInfo-Recommender)） | 拿当前上下文让 LLM 推荐「该激活/该新建哪些条目」，弹窗勾选 | scope 的「推荐」模式；建议用连接配置（connection profile）跑便宜的模型 |
| AI Dungeon 脚本（[输入/上下文/输出三段钩子](https://worldsmythe.github.io/blog/intro-to-ai-dungeon-scripting/)） | Input hook 改玩家输入 → Context hook 组装记忆快照 → Output hook 更新世界 | 事件管线照这个顺序做：`onUserMessage` → `buildContext` → `onModelMessage` |
| Generative Agents（[论文](https://arxiv.org/abs/2304.03442)） | memory stream + 检索分数 = recency·α + importance·β + relevance·γ，另有 reflection | scope 检索排序、以及「定期反思生成高层记忆」的设计依据 |
| MemGPT（[论文](https://arxiv.org/abs/2310.08560)） | 分层记忆 + 用 function call 自我编辑记忆（core / archival / recall） | 把「记住这件事」做成 tool（`strpg_remember`），由模型主动写入候选区，而不是每回合全量重写 |

---

## 3. 总体架构：三条总线 + 一层对话能力

```text
        ┌──────────────── SillyTavern 聊天（角色卡 persona/世界书）────────────────┐
        │  ST World Info（动态条目）      ST 角色卡（NPC/玩家）      Memory Books   │
        └───────────▲───────────────────────────▲──────────────────────▲──────────┘
                    │ 注入(读取)                 │ 身份绑定              │ 摘要产物(只读)
   ┌────────────────┴───────────────────────────┴──────────────────────┴──────────┐
   │                        STRPG 前端桥（frontend/src/bridge/）                   │
   │  statePrompt · scopeScanner · trackerAdapter · npcChatLauncher · toolRouter  │
   └────────────────────────────────┬─────────────────────────────────────────────┘
                                    │ REST(/api/plugins/strpg)
   ┌────────────────────────────────▼─────────────────────────────────────────────┐
   │ STRPG 服务端（唯一权威）：campaign state · inventory · quests · relations    │
   │  scope registry · memory inbox · trade/barter engine · audit log             │
   └──────────────────────────────────────────────────────────────────────────────┘
```

设计原则（沿用现有「LLM 只能提议」）：

1. **服务端唯一权威**：HP/金币/物品/任务/关系数值只由服务端改。
2. **一切外部输入先落「候选区」**：LLM 提取的记忆、Tracker 回传、Memory Books 摘要，先进 inbox，审核后再生效。
3. **写外部扩展只用公开面**：Tracker 走 `window.RPGBridge`；世界书走 `/api/worldinfo/edit`；Memory Books 只读。
4. **可回滚**：每次 apply 记 `memory_apply_log`（before/after + 来源 + 操作者），支持撤销最近一次。

---

## 4. 两种入场方式

### 4.1 复用聊天角色 → RPG 角色/NPC

```text
ST 角色卡（avatar/name/description/personality/scenario/mes_example）
   │  Import（新增反向导入）
   ▼
NPC 资产（npc.key, npc.tavern.avatar, npc.dialogueProfile, npc.knowledge）
   │  Bind（character_bindings: campaign_id, npc_key, st_avatar, direction='chat2rpg'）
   ▼
聊天中的该角色 ⇄ 该 NPC（同一身份，双向共享记忆）
```

要点：

- 反向导入放在 Studio → World Workbench 的「从角色卡导入 NPC」按钮；只映射描述性字段，**不映射**数值。
- 角色卡自带的 character lorebook 不搬进 STRPG，只登记为 `npc.knowledge.book`（引用），避免双份设定互相打架。
- 玩家侧用 **persona lorebook**（ST 支持人格绑定的世界书，切人格即生效）承载「我的 RPG 状态」，比系统提示更稳。

### 4.2 RPG 角色 → 聊天

```text
NPC 资产 ──export──▶ ST 角色卡（已实现 tavern.js）──▶ 打开/绑定聊天
                                   │
                                   └─ 世界书绑定：STRPG 动态书 + 该 NPC 的静态设定
```

- 打开聊天时自动选择「该 NPC 的动态条目集」（`npc:<key>` 前缀），避免整本大全集污染上下文。
- 对话模式二选一：
  - `inline`：当前战役聊天里以该 NPC 身份发言（群聊/多角色）
  - `dedicated`：独立单聊（更像「陪伴」），但每回合注入同一份 STRPG 状态与 scope 记忆

---

## 5. 自动同步：STRPG ↔ RPG Tracker ↔ Memory Books

### 5.1 权威表（避免两边各写一套）

| 数据 | 权威 | Tracker 侧 | 方向 |
|---|---|---|---|
| HP/MP/EXP/金币/物品/技能/任务 | STRPG | 只读镜像 | STRPG → Tracker |
| 好感/信任/恐惧/态度/心情 | STRPG（`npc:<key>:relation` 等） | 可读可写白名单 | 双向（写回需审核） |
| 场景摘要/最近事件 | STRPG（`game_events`） | 叙事字段 `summary`/`lastInteraction` | STRPG → Tracker |
| 聊天里新发生的关系变化 | 聊天（LLM 观察） | — | 聊天 → 候选 → STRPG（审核后） |
| 长程记忆条目 | Memory Books / STRPG 动态书 | — | 只读引用 |

### 5.2 实现方式

前端新增 `trackerAdapter.js`，两种模式：

- **push（默认，自动）**：每次 dashboard 变化 → `RPGBridge.currentTrackerData` 写入只读块（`STRPG` 前缀），不触发 Tracker 的自动更新，避免它再生成一遍。
- **pull（手动/定时）**：读 Tracker 白名单字段 → `POST /integrations/tracker/sync`（现有接口）→ 进 inbox → 审核后写 `narrative_state` 与 `campaign_variables`。

Memory Books：

- **读**：STRPG 扫描「当前聊天绑定的 lorebook」，把 MB 生成的条目抽成 `memory_candidates`（按关键词/时间排序），不写它内部数据。
- **写**：STRPG 只维护自己的书（`STRPG — <campaign>`），并且**只改自己 uid 前缀的条目**（现有 `buildMemoryBook` 是整本重建，需要改成增量 upsert，否则会覆盖用户手改的条目）。

### 5.3 触发时机（自动化，但可关）

| 时机 | 动作 |
|---|---|
| 每 N 条消息（默认 8） | 跑一次「轻量 scope」：只提关系/承诺/债务 |
| 战斗结束（胜/负） | 跑「结算 scope」：战果、损失、NPC 反应 |
| 场景切换 / story 节点推进 | 跑「场景 scope」：地点变化、目击者、后果 |
| 手动按「扫描」 | 用户指定消息区间，跑任意 scope |

---

## 6. Scope：扫描 → 候选 → 审核 → 落库

### 6.1 Scope 定义

```json
{
  "key": "shop_haggle_memory",
  "name": "商店砍价记忆",
  "enabled": true,
  "source": { "type": "chat", "range": { "lastN": 12 } },
  "filter": { "speakers": ["Aevial", "{{user}}"], "requiresKey": ["price", "便宜", "gold"] },
  "extract": {
    "kind": "npc_state",
    "schema": { "npcKey": "string", "attitudeDelta": "number", "promise": "string?", "debt": "object?" }
  },
  "apply": { "targets": ["npc.relation", "campaign_variable", "lorebook_entry"] },
  "review": "required",
  "schedule": "every_n_messages:8"
}
```

### 6.2 管线

```text
[1] 取范围（消息索引区间 / lastN / 指定 speaker）
[2] 预处理（拼接、去系统消息、限 token）
[3] 抽取（generateQuietPrompt + 严格 JSON schema；失败即空，不猜）
[4] 去重（hash + 与现有条目做关键词/向量相似度）
[5] 入 inbox（含 evidence：消息索引、原文摘录、置信度）
[6] 审核（逐条勾选；支持编辑/拒绝）
[7] apply（事务内写 STRPG + 生成/更新世界书条目 + 写 tracker 白名单）
[8] 审计（memory_apply_log）+ 可撤销
```

### 6.3 与现有代码的对齐

- 审核 UI：仿 `Scene-Continuity-Bridge` 的 plan/apply（每项可勾、锁字段跳过、证据可见）。
- 抽取 prompt：`frontend/src/llm.js` 的 `generateQuietPrompt` 已可用；建议新增连接配置开关（便宜模型跑 scope）。
- 落库：复用 `campaign_variables`（`npc:<key>:relation`、`flag:*`）、`narrative_state`、`worldinfo/edit`。

### 6.4 世界书条目策略（关键）

| 条目类型 | key | 内容 | 时效 |
|---|---|---|---|
| 静态设定 | 世界/场景/NPC 名、别名 | 描述、性格、动机 | 常驻（关键词） |
| 当前局面 | `strpg`、`当前`、战役名 | 地点/任务/队伍/最近事件 | `sticky` 3–5 回合 |
| NPC 动态 | NPC 名 + 别名 + `npc:<key>` | 关系值、承诺、债务、态度变化 | `sticky` 5、`cooldown` 10 |
| 交易/欠账 | 物品名、`欠`、`抵账` | 当前债务、约定条件、截止 | 常驻直到结清 |

注意：条目内容要独立可读（key 不会进上下文），单条建议 ≤ 400 字，靠 `order` 控制优先级。

---

## 7. 沉浸式 NPC 对话：真 chat + tools + event hooks

### 7.1 交互类型扩展

| 类型 | 语义 | 是否确定性 |
|---|---|---|
| `shop` | 打开商店面板 | 是 |
| `accept_quest` / `turn_in_quest` | 接/交任务 | 是 |
| `chat`（新增） | 进入真实对话；允许 tool 提议 | 否（LLM 自由） |
| `chat_with_intent`（新增） | 带目标的对话（打探、谈判、道歉） | 半确定（有成功条件） |

### 7.2 对话中可用的 tool（注册到 ST Function Calling）

| tool | 输入 | 服务端校验 | 副作用（需确认） |
|---|---|---|---|
| `strpg_propose_trade` | npcKey, itemKey, qty, offerPrice, barterItemKeys | 库存、价格下限、关系折扣、魅力/幸运 | 金币/物品变更 + `relationship` |
| `strpg_propose_barter` | npcKey, serviceKey, rewardItemKey, deadlineDays | 是否存在该服务/任务模板、NPC 是否接受劳务 | 生成「抵账」任务 + flag `debt:<npc>` |
| `strpg_propose_gift` | npcKey, itemKey | 物品存在、NPC 喜好标签 | 关系 +，物品扣除 |
| `strpg_propose_reveal` | npcKey, loreKey/topic | NPC knowledge 是否包含、是否有条件 | 解锁世界书条目 + flag |
| `strpg_propose_remember` | scopeKey, text, importance | 长度、重要性、去重 | 写入 inbox（不直接生效） |
| `strpg_propose_relation` | npcKey, delta, reason, evidence | 单次 |delta| ≤ 2，24h 上限 | 关系变化 |

所有 tool 都返回 `{ proposalId, acceptedPreview, requiresConfirmation }`，前端渲染一张紧凑提案卡（接受/还价/取消），**绝不静默生效**。

### 7.3 砍价例子（端到端）

```text
玩家: 老板，这把铁剑多少钱？能不能便宜点？
LLM（以 NPC 身份回话，同时发出 tool call）:
  strpg_propose_trade({ npcKey:"blacksmith_borin", itemKey:"iron_sword", qty:1, offerPrice:70 })

服务端:
  listPrice = 100（shop.buyRate 1.0）
  relation  = +3（老主顾）
  允许区间  = [list*0.6, list*0.95] → [60, 95]
  魅力/幸运修正 = -2
  offerPrice 70 在区间内 → accept（margin=0.70），议价成功
  → 返回 { accepted:true, finalPrice:70, relationDelta:+1, proposalId }

玩家点「接受」→ 事务内扣 70 金币、加物品、写 tracker 白名单、记 game_events('trade.completed')
NPC 台词由 LLM 基于结果生成（"行吧，看你识货。"），数值不靠它编。
```

### 7.4 抵账例子（barter）

```text
玩家: 我帮你把地窖里的老鼠清了，抵这把剑行不行？
→ strpg_propose_barter({ npcKey, serviceKey:"cellar_rats", rewardItemKey:"iron_sword" })

服务端:
  校验：NPC 有该服务、玩家未接过同一债务、任务的等价金币 ≥ 剑价 × 0.8
  → 创建 quest(instance) "抵账：地窖鼠患"，rewards.items=[iron_sword]，并挂 flag debt:blacksmith_borin
  → 玩家完成清鼠、回来 turn_in → 自动交剑、清债务、关系 +2
```

这正是「event 万能接口」的用法：`barter` 不新增硬编码流程，而是生成一个 quest + flag，让现有 quest/event 引擎去推进。

---

## 8. Event 升级（让「万能接口」名副其实）

### 8.1 新增触发器

| trigger | 触发点 | 可携带 |
|---|---|---|
| `combat_defeat` | `settleDefeat`（见 docs/CLASS_RULES 已知缺口） | encounterKey, monsters |
| `chat_message` | 收到玩家/模型消息（可选 scope 过滤） | speaker, text, chatKey |
| `intent` | tool 被接受/拒绝后 | intentType, npcKey, accepted |
| `trade_completed` | 交易/抵账成交 | npcKey, itemKey, price |
| `scope_applied` | 审核通过后 | scopeKey, entryCount |

### 8.2 新增动作

| action | 作用 |
|---|---|
| `adjust_relation` | `npcKey, delta`（带上限） |
| `give_item` / `take_item` | 已有 give；补 take |
| `start_quest` / `complete_quest` | 任务生命周期 |
| `open_chat` | 以某 NPC 身份打开/切换聊天 |
| `add_memory` | 写候选记忆（进 inbox） |
| `set_lore` | upsert 世界书条目（只写自己的 uid 前缀） |

这样「战败后某人说那句话」可以写成：

```json
{ "trigger": "combat_defeat", "scope": "scene", "sceneKey": "old_shrine", "once": true,
  "actions": [
    { "type": "set_flag", "key": "lost_to_troll" },
    { "type": "adjust_relation", "npcKey": "mira", "delta": 1 },
    { "type": "add_memory", "scopeKey": "defeat_memory", "text": "米拉看见你拖着断剑回来，没有嘲笑。" }
  ] }
```

→ 条目进 inbox，审核后进世界书；下一次聊天提到米拉，`sticky` 条目就带出这段记忆。

---

## 9. 数据模型（新增表）

```sql
CREATE TABLE character_bindings (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  npc_key TEXT,                    -- NULL = 玩家 persona
  st_avatar TEXT NOT NULL,
  st_character_name TEXT,
  direction TEXT NOT NULL,         -- chat2rpg | rpg2chat
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE memory_scopes (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  key TEXT NOT NULL,
  config_json TEXT NOT NULL,       -- 见 6.1
  enabled INTEGER DEFAULT 1,
  last_run_at TEXT,
  UNIQUE (campaign_id, key)
);

CREATE TABLE memory_candidates (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  scope_id TEXT,
  source TEXT NOT NULL,            -- scope | tracker | manual | chat
  kind TEXT NOT NULL,              -- npc_state | lore | debt | event | item
  payload_json TEXT NOT NULL,
  evidence_json TEXT,             -- msg indexes + 摘录
  confidence REAL,
  status TEXT DEFAULT 'PENDING',   -- PENDING | APPROVED | REJECTED | APPLIED
  dedupe_hash TEXT,
  created_at TEXT, reviewed_at TEXT, applied_at TEXT
);

CREATE TABLE memory_apply_log (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  candidate_id TEXT,
  target TEXT NOT NULL,            -- narrative_state | campaign_variables | lorebook | quest
  before_json TEXT, after_json TEXT,
  applied_by TEXT, applied_at TEXT, undone_at TEXT
);
```

API（都在 `/api/plugins/strpg` 下，沿用现有 wrap/错误风格）：

```text
GET  /campaigns/:id/scopes
POST /campaigns/:id/scopes
POST /campaigns/:id/scopes/:key/run            → 返回候选（不落库）
GET  /campaigns/:id/memory-inbox?status=PENDING
POST /campaigns/:id/memory-inbox/:cid/approve  → apply（事务）
POST /campaigns/:id/memory-inbox/:cid/reject
POST /campaigns/:id/memory-inbox/apply-batch
POST /campaigns/:id/trades/propose             → tool 后端
POST /campaigns/:id/trades/:pid/confirm
GET  /campaigns/:id/lorebook                   → 增量导出（只含 STRPG 拥有的条目）
```

---

## 10. 分阶段实施

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M1 状态桥** ✅ v1.4.0 | `trackerAdapter`（push/pull）+ 动态世界书增量 upsert + `strpg_propose_relation` tool | 聊天里改关系 → 审核 → 世界书与 tracker 同步；RPG 状态在聊天首条消息即生效 |
| **M2 交易/对话**（2–3 天） | `chat` 交互类型 + `propose_trade` / `propose_barter` / `propose_gift` + 提案卡 + 事务 | 砍价成功/失败、抵账生成任务并自动结清，均有审计 |
| **M3 Scope**（3–4 天） | scope 表 + 扫描器 + inbox + 审核 UI + 去重/相似度 + 撤销 | 指定区间扫描 → 候选 → 审核 → 世界书/状态更新；重复运行不产生重复条目 |
| **M4 角色双向**（2 天） | 角色卡→NPC 导入、character_bindings、NPC 专属书选择、独立聊天模式 | 两种入场方式都能带着记忆来回切换，切聊天不丢状态 |

---

## 11. 风险与边界

| 风险 | 处理 |
|---|---|
| 双写打架（STRPG 与 Tracker 都改关系） | 单一权威 + 锁 + 审核；Tracker 侧只写白名单 |
| 世界书被覆盖 | STRPG 只改 `strpg:` uid 前缀；其余条目不动 |
| token 爆炸 | 条目 ≤400 字、`order` 分层、`sticky` 限时、scope 只用 `lastN` |
| LLM 编造记忆 | 抽取失败即空；必须带 evidence（消息索引+摘录）；审核必看 |
| 提示注入 / 越权 | 只有白名单 tool；数值变更永远服务端校验 + 玩家确认 |
| 记忆重复/漂移 | dedupe hash + 相似度阈值 + 定期 consolidation（参考 MB 的合并策略） |
| 剧透泄漏 | scope 抽取只允许「玩家角色已知」的视角；NPC knowledge 白名单 |

---

## 12. 为什么这样分工

- **Memory Books 已经解决了「聊天很长怎么办」**：摘要、分层、合并、preview 都有；STRPG 再做一遍是浪费，而且两套摘要会互相矛盾。
- **Scene-Continuity-Bridge 已经证明了「审核后应用」可行**，还验证了 `RPGBridge` 这层接线；STRPG 应当沿用同样的边界（只提议、不自动提交）。
- **ST 世界书是天然的共享介质**：它同时服务聊天（自动注入）和 RPG（数据源），还自带 `sticky`/`cooldown`/向量，省掉自研检索。
- **ST Function Calling 是「真聊天 + 能改数据」的正确接口**：比 `<strpg>` 文本块可靠，模型能一次给出结构化的砍价/抵账参数。

下一步：先做 M1（状态桥 + 动态世界书增量），这是所有后续能力的地基；M2/M3 可以并行。
