---
name: memory
description: "Programmatic long-term memory: recall/persist distilled knowledge in a Joplin notebook (AI-Memory) via a zero-dep Node CLI (memory.mjs). RECALL on-demand before a task (never inject the whole base): search by task keywords, embedding-gated, layer-ranked, budgeted ≤5 notes/≤800 tokens, ≤2 recalls per task. RETAIN after a non-trivial task: distill 1-3 durable facts, never raw logs. REFLECT on conflict/staleness. All judgment thresholds are programmatic (embedding cosine), LLM only does semantic layer-classification and hindsight merging. Config auto-bootstraps from localhost:41184."
allowed-tools: Bash
---

# memory — AI 长期记忆（程序化 CLI）

持久化 agent 的「蒸馏知识层」，存于 Joplin 笔记本 `AI-Memory`（四层：fact/belief/exp/summary）。
**原则：按需召回，永不整库注入。提炼写入，绝不堆积日志。**
**判定已程序化：去重/门控/排序全走 embedding 余弦（`memory.mjs`），不再手拼 curl。**

## 用法

```bash
M=<skill-dir>/memory.mjs          # 本 skill 目录下

node $M recall <关键词...>         # 门控召回 → JSON（任务开始前）
node $M retain <layer> <title> [body]   # 去重写入 → JSON（任务结束后）
node $M reflect                   # 检测冲突/聚合/升级建议 → JSON
node $M reflect --apply '<json>'  # 执行聚合/迁移（两段式第二步）
node $M doctor                    # 诊断：连通性/token/层id/embedding
node $M test                      # 自检
```

输出均为 JSON。config.json / state.json（向量缓存）在 skill 目录，`doctor` 自动发现并缓存层 id、token 自动解析。

## 工作流

### retain —— 写入（任务结束后）

1. 任务结束时**提炼 1-3 条**（结论/事实/决策，非全量日志）
2. **layer 由你（LLM）判断**，依据下方速查表（语义理解比机械规则准）
3. 调用 `retain <layer> <title> <body>`：程序自动 search 候选 → embedding 判「相同(合并)/互补(保持)/无关(新建)」
4. 输出 `action: created|updated`；若 `aggregateHint` 出现 → 互补已达阈值，跑 reflect
5. **写后提醒**：运行 `joplin sync`（或等 cron ≤5min），否则新笔记不被 search 索引

### recall —— 召回（任务开始前，按需）

1. 门控 = 一次 `recall <关键词>`：程序 search → 过滤四层 → embedding 门控 → 层权重排序 → 预算裁剪
2. 零命中 → 不查记忆，直接干（可先 `joplin sync` 再试一次）
3. **硬预算**：≤ 5 条 / ≤ 800 token 注入；每任务 recall ≤ 2 次

### reflect —— 反思（冲突 / 积累触发）

- **程序检测**：`reflect` 输出建议（冲突审查 / 聚合为 summary / 互补保持 / belief 升级）
- **两段式执行**（默认路线 B）：
  1. `reflect` 输出建议 + 材料 → **你结合当前上下文**合并/提炼内容
  2. `reflect --apply '{"action":"aggregate|migrate","targetLayer":"...","title":"...","body":"...","sourceIds":[...]}'` 写回
- 触发时机：冲突时 / retain 后增量 / 每积累 M=20 条

## layer 判定速查表（LLM 依据，语义判断）

| 特征 | layer |
|---|---|
| 客观、可验证、长期有效的陈述（证据） | **fact** |
| 推断、观点、偏好，含不确定性；**正文必须写置信度 0~1** | **belief** |
| 一次性经历、踩坑、教训，有具体时间点 | **exp** |
| 对某实体（项目/人/工具）的聚合画像，只聚合不复制细节 | **summary** |

分层边界：持续状态→fact；一次性事件→exp。客观事实→fact；主观推断→belief。单个事实/事件→fact/exp；实体总体认识→summary。一条信息只归一层。

## 条目格式（schema）

- **标题** = `一句话结论（含核心关键词）`——**关键词必须写进标题**（标题即索引）。⚠️ 英文/拉丁词搜索不可靠（Joplin FTS），**关键词优先中文**
- **正文** ≤ 200 字，结构：`详情：…\n置信度：<0~1 仅 belief>`。时间由 Joplin 自带 `created_time/updated_time` 维护，**不写文本形式的时间**
- **禁止相对指代**：记忆跨设备共享，不用「本机/我/这里/上次」，用明确名称
- 示例：
  - fact：`CentOS 云服务器是 1c2G glibc 2.28（环境·服务器）`
  - belief：`用户偏好极简工具链，避免重量级依赖（偏好·工具）`
  - exp：`npm CLI 3.6.2 无法同步 3.7.0 目标，回移植向前兼容补丁解决（部署·Joplin）`
  - summary：`rs-search 项目画像：Rust 搜索桥，GitHub Actions 出 musl 产物（项目·rs-search）`

## 硬性限制（必须遵守）

- 每任务 recall ≤ **2 次**；每次注入 ≤ **5 条 / 800 token**
- **永不**整库注入、**永不**把笔记原文全量塞进提示词
- retain 只写**蒸馏结论**，不写对话日志

## 阈值（程序化，config.json 可调）

`same_th=0.75`（相同→合并）、`rel_th=0.30`（相关→门控/保持）、`N=3`（互补聚合触发）、`M=20`（周期 reflect 触发）。
初值来自小样本实测，**优化值随使用积累校准**。
