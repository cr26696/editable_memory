# memory skill 程序化改造 · 实施计划（v3）

> 状态：**待确认**
> 依据：`ai-memory-sync-design.md`（§9 程序化判决）+ `notes/embedding-api.md`（embedding 选型实测）
> 原则：能用程序化判决就不交给 LLM（省 token、更准、可控可调）

---

## 0. 已确认决策

| # | 决策 | 结论 |
|---|------|------|
| 1 | 形态 | Node.js 单文件 CLI `memory.mjs`（零依赖，内置 fetch）✅ |
| 2 | embedding | 接外部 API；**固定 `text-embedding-3-large` 全维度(3072)，开发期不切换维度** ✅ |
| 3 | 范围 | recall / retain / reflect / doctor 四子命令 ✅ |
| 4 | 文件 | 项目集中到 `~/ai-memory/`，清理根目录 ✅ |

---

## 1. 目录结构

```
~/ai-memory/                            ← 项目工作区（已建）
├── PLAN.md
├── ai-memory-sync-design.md            ← 原设计文档（已移入）
└── notes/
    └── embedding-api.md                ← embedding 实测选型（已建）
~/.pi/agent/skills/memory/              ← skill 本体（pi 加载）
├── SKILL.md                            ← 改薄壳
├── memory.mjs                          ← Node CLI（新）
└── config.json                         ← 运行配置（自举生成）
```

---

## 2. 技术选型要点（来自实测）

- **模型**：`text-embedding-3-large`，**固定全 3072 维**——开发期不设 `dimensions` 开关、不切换维度（锁定一个最好模型开发，避免中途改向）
- **判定阈值**（初始，待真实数据校准）：相同 ≥0.55 / 相关 ≥0.40 / 无关 <0.25
- **可靠性**：端点重试(3次) → 失败降级字符 n-gram（流程不断链）
- **层权重**：fact > summary > exp > belief（固定程序化表）
- **预算**：recall ≤5 条 / ≤800 token；每任务 recall ≤2 次

---

## 3. CLI 命令接口

```
memory.mjs recall <关键词...>        # 门控召回 → JSON
memory.mjs retain <layer> <title> <body>   # 去重写入 → JSON
memory.mjs reflect [--dry-run|--apply]     # 冲突/迁移 → JSON
memory.mjs doctor                    # 诊断 → JSON
memory.mjs --help
```

config.json：`base`(默认 localhost:41184) + token(自动解析 settings.json) + 四层 id(自动发现缓存) + weights + budget + embedding + sim 阈值。

---

## 4. 实施步骤（按执行顺序）

> ⚠️ 本计划按「简单环节快速引导 / 复杂易错环节明确验收」分级。每步有**可检验的完成信号**。

### Step 0 — 预检（简单）
- 确认 `localhost:41184` 可 ping（`/ping` 返回 `JoplinClipperServer`）
- 确认 `text-embedding-3-large` 可调用（带 key）
- **完成信号**：两步 curl 均 200

### Step 1 — 搭骨架（简单）
- 在 skill 目录建 `memory.mjs` 空壳 + `--help` + 子命令路由
- **完成信号**：`node memory.mjs --help` 输出四子命令用法

### Step 2 — config 自举 + doctor（简单）
- `memory doctor`：连通性、token 解析、自动发现并缓存四层 id（fact/belief/exp/summary + AI-Memory 根）
- **完成信号**：首次运行生成 `config.json`，输出 `{ok:true, checks:[...]}` 且 `doctor` 幂等（二次运行不再重建）

### Step 3 — embedding 模块（中等·复杂）
- 可插拔：`callEmbed(text)` → 向量；`ngram(text)` 降级；失败重试(3) + 降级
- **验收指标**（明确）：
  1. 对 `["服务器 CPU 紧张","早餐吃鸡蛋"]` 调用，返回 512 维数组
  2. 相同句子两次调用余弦 ≈ 1.0（±0.01）
  3. 断开/伪造 API 时自动降级 n-gram 且不抛错、有 `degraded:true` 标记
  4. 中文关键词正确 URL 编码（`服务器` → `%E6%9C%8D%E5%8A%A1%E5%99%A8`）

### Step 4 — recall（复杂·易错）
- 流程：search → 过滤四层 → 层权重排序 → embedding 门控(标题相似度) → 去重合并 → 预算裁剪 → 输出 JSON
- **验收指标**：
  1. 关键词「服务器」召回只含 `parent_id∈四层` 的记忆条目，**不含**用户笔记（如「Redox 调研」）
  2. 输出条数 ≤5、token ≤800
  3. 层权重序正确：fact 排在 exp/belief 前
  4. 空结果输出 `{results:[],meta}` 而非报错
  5. 门控生效：无关关键词（如「香蕉」）零命中
- 🔧 **开发完全结束后加一步**：对 recall 做 **1-2 轮头脑风暴**，讨论更好的架构以**减少查询/embedding 调用次数**（如本地向量缓存、batch 化、索引预计算、分层粗筛+精排）——产出记录到 `notes/architecture-brainstorm.md`，但不改变当前已开发实现

### Step 5 — retain（写入记忆）—— ✅ 已讨论定稿

**接口**：`memory.mjs retain <layer> <title> <body>`

**layer 归属**：由 **LLM 判断**（语义理解比机械规则透彻），SKILL.md 提供**固定速查表**作依据（触发词/特征 → fact/belief/exp/summary），保证可复现、非随性发挥。

**去重判定（标题级为主）**：
- 相似度算在**标题 embedding** 上（标题=一句话结论+核心关键词，语义已浓缩）
- **灰色区**（相似度落带）才回退正文级精判

**判定树**（程序化，唯一触发点）：
```
同实体？（标题 embedding 相似度）
  ├─ NO → 无关 → 新建
  └─ YES →
       ├─ 结论等价 → 相同 → 合并更新（刷新时间戳/置信度）
       └─ 结论不等价 → 互补
             ├─ 互补条数 < N → 保持独立
             └─ 互补条数 ≥ N → 触发 reflect → 聚合成 summary
```

**互补与计数**：
- 互补是**负面规则**（同实体结论不等价 → 不合并、保持独立），非第三种写入动作
- 计数 = **按整条标题 embedding 相似度**聚类近邻条数，**不用实体词**（实体词不承载句义，如「8月A揍B vs 9月B揍A」语义相反却同实体词）
- 计数是**单点近邻查询**：retain 时用 search 把候选缩到小集，仅对候选做本地余弦比对（O(k)，k≈几十），**不遍历全库**

**缓存（性能关键）**：
- `title → embedding` 本地字典，**仅标题变化时重算**（否则走本地向量，零远程 API）
- 缓存**持久化**到 state 文件跨会话保留（否则冷启动需全库重算 embedding，卡）
- 查询/聚类/门控全部基于本地缓存向量

**同步**：写入后触发 `joplin sync`（或提示等待 cron ≤5min）。

**验收指标**：
  1. 首次 `retain fact <t> <b>` 新建，`GET /notes` 可见，`parent_id`=fact 层
  2. 重复 retain 同结论 → **更新**（不新建重复条目）
  3. 同实体结论不等价（互补）→ 保持两条独立
  4. 互补条数 ≥ N → 触发聚合为 summary（依赖 reflect，见 Step 6）
  5. 非法 layer 输入 → 报错拒绝，不写
  6. 标题不变时重复 retain 不触发远程 embedding（走本地缓存）
  7. 写入后 sync，sync 后 search 可命中

### Step 6 — reflect（反思）—— ✅ 已讨论定稿（hindsight 结合）

**职责（两层结合）**：
1. **一致性维护**（程序化、可全自动）：冲突检测（belief vs fact 同实体）、belief→fact 升级（置信度≥0.9 多次验证）、exp→fact 沉淀规律、清理低置信度/过时条目
2. **洞察生成**（hindsight，需 LLM）：周期性回顾积累的 exp/fact 簇，提炼「对未来行动的建议」或实体画像 → 生成 summary / 建议型 fact（retain「互补≥N→聚合 summary」的上游实现者）

**执行模式（默认路线 B，两段式）**：
```
reflect 脚本（程序化）：检测冲突/迁移/聚合需求 →
  输出「建议 + 材料 + 目标层」JSON 给当前 pi 会话
当前 pi 会话（LLM）：结合上下文合并/提炼内容
再次调用脚本 → retain/update 写回存储
```
- 脚本负责：检测、候选、阈值触发（全程序化）；LLM 负责：合并文本生成（语义理解）
- 路线 A（脚本自助调外部 LLM API）保留为**降级/无会话批量场景**的可选
- 理由：当前会话上下文热（含为什么有这条/当时场景），API 新起是冷启动仅两条 dry 文本，合并质量差；且复用当前会话零额外 API 成本；结果经 agent 思考可见可改

**触发时机**：① 冲突时（程序自动检测，性价比最高）② retain 后增量（互补≥N 天然触发）③ 按积累条数触发（每新增 M 条记忆跑一次 hindsight 回顾式洞察，M 可配；非固定时间 cron，避免低频白跑/高频漏跑）

**验证指标**：
  1. `--dry-run` 输出建议 JSON 不落库
  2. `--apply` 后 `GET /notes` 的 parent_id/内容已按建议变更
  3. 冲突检测：同实体 belief/fact 冲突被识别并输出升级/降级建议
  4. 聚合触发：互补条目 ≥N 时输出聚合为 summary 的建议 + 材料
  5. 两段式验证：脚本输出建议后，agent 合并、二次调用写回成功，无重复条目

**⚠️ 待验证优化项（功能实现后评估，非本期）**：克隆当前会话上下文 → 开子 agent → 并行执行 → 拆分多条合并任务。关注点：上下文能否被克隆、子 agent 写同一存储的权限与冲突。

### Step 7 — SKILL.md 薄壳化（简单）
- 重写 SKILL.md：说明调用 CLI、保留召回/写入语义约束（蒸馏原则、硬预算）
- **完成信号**：SKILL.md 不再出现「手拼 curl」，全部指向 `memory.mjs`

### Step 8 — 测试环境 + 典型业务逻辑测试例（复杂）

**⚠️ 阈值定标策略（已讨论）**：
- **现状**：真实条目太少，不做完整定标集实验
- **现在**：每类 5 条小样本（相同/互补/无关各 5 对）粗测 embedding 相似度分布 → 定**大概初值**，粗糙先用
- **后续**：随使用积累数据后，再做**完整标定集实验**（每类 15~20 对，真实记忆+业务变体，画分布、看重叠区、定分界，独立校验集验证 ≥80%）
- **优化值在使用中持续调整**（已确认：初值只是起点）

**阈值初值（2026-09-02 小样本实测，text-embedding-3-large）**：
- 实测分布：相同 0.81~0.95(med 0.91) / 互补 0.38~0.68(med 0.63) / 无关 0.08~0.20(med 0.11)，三分布无重叠
- `same_th=0.75`（相同与互补空隙中点）、`rel_th=0.30`（互补与无关空隙中点，偏保守防漏召回）
- `N=3`（互补条数触发聚合）、`M=20`（按条数触发周期 hindsight 回顾）
- 判定：≥0.75 相同→合并；0.30~0.75 相关/互补→门控召回/保持；<0.30 无关→新建

**构造隔离测试环境**不与真实 Joplin 库混写。方案：独立的测试 notebook / 独立的 config（指向测试 token 与测试文件夹），或 mock REST 层
- **编写典型业务逻辑对应的测试例**（脚本化，`memory test`）：
  1. recall：正常召回 / 过滤用户笔记 / 空结果 / 无关关键词零命中 / 预算裁剪 / embedding 故障降级
  2. retain：新建 / 重复去重更新 / 互补保留两条 / 非法 layer 拒绝
  3. reflect：冲突检测 / 迁移（若已定，见 Step 5/6 讨论）
  4. embedding：维数 / 同句余弦≈1.0 / 中文编码 / 重试与降级
- **验收指标**：测试例全部可脚本运行、在隔离环境通过；无真实库污染

---

## 5. 全局验收标准

- `memory doctor` → `{ok:true}`
- retain 后 sync 完成，`search` 命中
- 重复 retain 同结论不产生重复条目
- recall 只返回记忆条目（过滤正确）、≤5 条/≤800 token
- embedding 故障时全流程仍可用（降级）
- SKILL.md 纯 CLI 调用，无手拼 curl

---

## 6. 风险清单

| 风险 | 缓解 |
|------|------|
| small/ada-002 端点不稳 | 选 large；CLI 重试+降级 |
| embedding 出域隐私 | 仅嵌标题/轻量脱敏，正文不进 embedding（可选开关） |
| embedding 维度/模型改向 | 已锁定 large 全维度，开发期不变更（除非讨论推翻） |
| 中文 FTS 搜索不可靠 | 标题强制含中文关键词；门控仍靠 embedding 兜底 |
| 阈值初始不准 | Step 8 用真实样本校准，阈值写入 config 可调 |
| 预算失控（embedding 每次 2.6s） | 预算开关、缓存已算向量、batch 化；Step 4 后头脑风暴再优化 |
