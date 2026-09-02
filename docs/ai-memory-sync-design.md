# AI 记忆同步系统 · 设计要点记录

> 阶段：需求对齐完成，架构方向已收敛（阶段性认同）
> 日期：待补充（记录于一次 grill-me 讨论后）

---

## 1. 环境现状

### 本机（CentOS 云服务器，常开）
- CentOS 8，glibc 2.28，资源受限（1 核 / 1.8GB RAM / 50GB 磁盘）
- 已装：Node v24.20.0、git 2.27.0、sqlite3、curl
- 未装：docker
- 角色：**常开枢纽**（当前未充分利用，目标补上）

### 另一台腾讯云服务器
- 提供代理云服务
- 已搭建 **WebDAV**（Joplin 的同步目标）

### 个人 PC（性能更强）
- 必装 VS Code（md 易用性高）
- 跑 Joplin 桌面版

### 手机（Android）
- 用 Termius SSH 连云服务器
- 跑 Joplin app

### 已有基础设施
- WebDAV 已搭建 ✅
- Joplin 已接入 WebDAV ✅
- Joplin MCP 已配置（可增删查改笔记）✅

---

## 2. 核心需求（对齐结论）

1. **多设备运行 pi agent**——至少 PC + 云服务器两个独立 agent
2. **共享 AI 记忆**——agent 之间维护一份共享知识
3. **及时同步**——agent 间记忆修改后最好及时同步
4. **人类友好界面**——查看/修改知识（PC + 手机）
5. **agent 按需查询人类笔记**——作为了解用户的补充信息，**不全量注入提示词**（轻量）
6. **少引入大型工具**——能写胶水代码、链路速度要快、性能要保证
7. **复用已有工具**——WebDAV、Joplin、MCP 都是既有资产

### 「AI 记忆」的本质（已对齐）
- 会话历史 (a) 与笔记知识库 (c) **提炼**到持久知识层 (b)
- 核心是 (b)：跨设备、跨会话的持久知识层
- (a)(c) 是输入源，(b) 是统一收敛点

---

## 3. 探索过并排除的方案

| 方案 | 结论 | 原因 |
|------|------|------|
| 自建 Joplin Server | ❌ 排除 | 臃肿（多用户/Web UI/Postgres 都是供应商用的），内存占用大，服务器性能吃紧 |
| Syncthing 同步 md | ⚠️ 备用 | P2P 实时同步可行，但官方 Android app 已停更（Syncthing-Fork 偏技术），且引入新工具 |
| git 自动提交同步 | ⚠️ 备用 | 有历史 diff 审计，但「及时性」受拉取间隔限制，只适合做审计而非主同步 |
| Obsidian 统一载体 | ❌ 排除 | 用户已在 Joplin 生态（WebDAV+MCP 配好），切换成本高 |
| 独立 md 目录 + 桥接 | ⚠️ 翻转前方案 | 见下节「关键翻转」 |

---

## 4. 收敛后的架构（阶段性认同）

### 核心洞察
**Joplin Server（重）≠ Joplin CLI（轻）**

| | Joplin Server | Joplin CLI（终端版） |
|---|---|---|
| 定位 | 多用户/供应商服务端 | 单用户无头同步引擎 + API |
| 组成 | Web UI + 多用户 + Postgres | 一个 Node 进程 |
| 内存 | 大 | 小（~100-250MB） |

Joplin CLI 官方支持：
- `joplin sync` → 同步到 WebDAV（可 cron 定时）
- `joplin server start` → 启动 REST API（`api.port`，默认 41184）

### 架构图

```
                ┌─────────────────────────────────────┐
                │  CentOS 服务器（常开，枢纽）            │
                │  · Joplin CLI（无头）                  │
                │     ├─ joplin sync → WebDAV（定时）     │
                │     └─ joplin server start → :41184   │
                │  · pi agent ──写/读──→ localhost:41184 │
                └──────────────┬──────────────────────┘
                               │ WebDAV 同步
                               ▼
                  ┌────────────────────────────┐
                  │ 腾讯云 WebDAV（已搭好）        │
                  └──────────────┬─────────────┘
                    ┌────────────┴────────────┐
                    ▼                         ▼
             手机 Joplin app            电脑 Joplin 桌面
             （24/7 可见）               （localhost:41184 API）
```

### 关键点
1. **PC 关机不断链**——服务器 Joplin CLI 常开，agent 改记忆 → CLI → WebDAV → 手机，不经过 PC
2. **云服务器当枢纽**——同步枢纽 + agent 的 API 出口，充分利用常开机器
3. **agent 走 localhost API**——每个跑 pi 的机器（PC 上 Joplin 桌面、服务器上 Joplin CLI）自带 `localhost:41184`，链路最短
4. **E2EE 不再是障碍**——agent 跟 CLI 对话，CLI 本地解密，agent 拿明文
5. **Syncthing / git 都不需要**——Joplin 自带 WebDAV 同步就是「同步系统」

---

## 5. 关键翻转（已认同，待最终确认）

### 翻转内容
**AI 记忆从「独立 md 目录」翻转为「Joplin 专用笔记本」（如 "AI Memory"）**
agent 通过 REST API 读写，而非 grep 本地 md 文件。

### 代价
- ❌ 失去 VS Code 直接编辑 md
- ❌ 失去 git 历史审计
- ❌ 失去 grep 原生速查

### 换来
- ✅ 手机 24/7 可见（PC 关机不影响）
- ✅ 零副本漂移（单一数据源）
- ✅ 零新增工具（复用 WebDAV + Joplin）
- ✅ 服务器当枢纽
- ✅ agent 有全文搜索接口（`/search?query=`，比 grep 更强）

### 审查路径说明
- **git/SSH 是「备用/审计」路径，不是人类日常审阅路径**
- PC 端日常审改：VS Code（md 易用性高）——若保留 md；或 Joplin 桌面——若走 notebook 翻转
- 手机端：Joplin app（24/7 查看，随手记个人笔记）

---

## 6. 待讨论 / 待定事项（当前状态）

1. ✅ **AI 记忆 schema**——已定（见第 8 节：notebook + tag 分层 + 标题约定）
2. ✅ **memory skill 实现**——已定（见第 8 节调用协议 v2）
3. ⏳ **实测 Joplin CLI 内存占用**——待装好后实测
4. ⏳ **E2EE 是否开启**——走 CLI API 则无影响，待装好后确认
5. ✅ **记忆提炼规则**——已定（retain：会话结束提炼 1-3 条，非全量日志）
6. ✅ **人类笔记与 AI 记忆边界**——已定（AI 记忆专用 notebook，个人笔记另存）

---

## 7. 下一步

1. 在 CentOS 服务器上安装 Joplin CLI，实测真实内存占用
2. 创建 AI-Memory notebook + 配置 API token
3. 落地 memory skill（SKILL.md）
4. 配置 cron 定时同步

---

## 8. 记忆库 schema 与调用协议（已确认 v2）

### schema
- **载体**：Joplin 专用 notebook「AI-Memory」
- **分层**：四层（子笔记本 `AI-Memory/fact` / `belief` / `exp` / `summary`，靠 parent_id 区分）
  - fact=客观事实；belief=带置信度推断；exp=一次性经历；summary=实体聚合画像
  - `fact` —— 客观事实（证据）
  - `belief` —— 带置信度的推断（推理）
  - （后续按需加 `summary` / `exp`）
- **条目格式**：
  - **标题** = `[一句话结论]（含核心关键词）` —— 关键词必须进标题（标题即索引）
  - **标签** = `fact` / `belief`
  - **正文** = 详情 + 置信度（仅 belief）+ 更新时间，≤ 200 字

### 调用协议 v2

```
【retain 写入】
  1. 任务结束时提炼 1-3 条（不是全量日志）
  2. 三步判据去重：
     关键词相同？否→新建
     结论等价？是→合并更新（刷新时间戳/置信度）
     结论互补→保留两条 / 结论冲突→reflect（证据强方升级 fact）
  3. 分层互斥：一条信息只归一层；belief→fact 是「改标签迁移」不新建
  4. 核心关键词必须写进标题

【recall 召回】
  1. 一次 search（不维护单独 index，标题即索引）
     标题命中关键词 → 强相关 / 仅正文命中 → 弱相关 / 零命中 → 不查
  2. 结果按层权重排序（默认 fact > belief）
  3. 同主题合并去重（高权重层为主，低层补增量）
  4. 硬预算：≤ 5 条 / ≤ 800 token 注入
  硬上限：每任务 ≤ 2 次 recall

【reflect 反思】
  冲突时：belief↔fact 改标签迁移，证据强方升级
  定期：清理低置信度、长期未命中条目
```

### 已确认的三个决策点
1. **层用 Joplin tag**（不是标题前缀）——可 `tag:fact` 过滤
2. **关键词/结论 agent 自拟**，用户随时可在 Joplin 里改
3. **fact + belief 两层起步**，按需渐进加层

---

## 9. 后续改进点（程序化判决）

**原则**：能用程序化判决就用程序化判决，不交给 LLM「费劲想」。

理由：① 省 token、加速流程；② 程序更准确、可控、可调。

**应用点**：
1. **去重/相近度判定**——用词嵌入模型：一句话 → 嵌入向量，两向量算余弦相似度，相似度超阈值即判「相同」→ 合并。取代 LLM 语义比对。
2. **门控判定**——任务关键词 → 与记忆标题的嵌入相似度，超阈值才召回。
3. **层权重排序**——已是程序化（固定表），无需改进。

**落地时机**：v1 先跑通（search 关键词 + 极小范围 LLM 比对），嵌入模型作为 v2 优化（需评估 1c2G 服务器跑轻量嵌入模型的可行性，或走 API）。

## 10. 部署状态（已落地 2026-09-02）

### 已完成
- ✅ **Joplin CLI 已装**（npm `joplin@3.6.2`，Node v24）
- ✅ **版本兼容补丁**：npm CLI 3.6.2 无法同步 3.7.0 目标（`MustUpgradeApp`）。已把官方 3.6.16 的**向前兼容逻辑**（`forwardCompatibleAppMinVersion` + `noteLockKey` 字段）回移植到 `@joplin/lib/.../syncInfoUtils.js`，补丁后同步成功
- ✅ **同步成功**：378 items（117 笔记 / 44 笔记本 / 10 资源 / 6 标签 / 196 revisions），0 冲突，34s
- ✅ **REST API server 运行中**：`localhost:41184`，token 已设（`~/.config/joplin/settings.json`）
- ✅ **AI-Memory 笔记本已建**：id `e53f3582ad4347a2b6bb59d774494eeb`
- ✅ **cron 已配**：`*/5 * * * * ~/joplin-cron.sh`（确保 server 存活 + 周期同步）
- ✅ **备份已做**：`~/joplin-backup/`（4.8MB，391 文件）

### 实测数据
- **内存占用**：Joplin CLI server ≈ **150 MB RSS**（远低于 Joplin Server 的臃肿），机器可用内存 887 MB → **性能担忧解除**
- **E2EE**：远程 `info.json` 确认 `e2ee: false`（已关）
- **同步目标**：`http://tkdrive.lawaias.top/dav/joplin`（不是 `/dav` 根目录，探测发现真实结构在 `/joplin` 子目录）

### 注意事项（重要）
1. **搜索需 sync 才索引新笔记**：REST API 新建的 note 不会立刻被 `/search` 命中，要等下一次 sync（FTS 索引在 sync 时更新）。memory skill 的 recall 依赖此——所以 cron 5 分钟同步是必要环节
2. **中文搜索需 URL 编码**：`/search?query=服务器` 要传 `%E6%9C%8D...`，curl 不会自动编码
3. **`joplin version` 命令有无害 bug**（`../package.json` 路径），但所有功能命令（sync/server/config/ls）正常
4. **版本坑**：用户的桌面是 3.7.x 预发布（为内置 API/MCP）。若以后桌面升级到 3.7 正式版，npm CLI 可能仍滞后——届时或需重新评估（可能正式版会同步发布 npm CLI）

### 待办
- [ ] 在 PC 上验证：PC 的 pi agent 走桌面版 `localhost:41184` 的链路
- [ ] 实测 memory skill 的 retain/recall 端到端流程（真实场景）

---

## 附：讨论中的关键决策记录

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | AI 记忆本质 | 持久知识层 (b)，会话/笔记为输入源 |
| 2 | 人类查看层 | 分离：AI 记忆 vs 个人笔记，不强行统一 |
| 3 | 同步机制 | 排除 git 手动/自动、Syncthing，采用 Joplin 自带 WebDAV 同步 |
| 4 | Joplin vs Obsidian | 保留 Joplin（已有基础设施），排除 Obsidian |
| 5 | 服务端形态 | Joplin CLI（轻）而非 Joplin Server（重） |
| 6 | AI 记忆存储 | 从 md 目录翻转为 Joplin 专用笔记本 ✅ 已确认 |
| 7 | 分层结构 | 四层 fact/belief/exp/summary，用子笔记本（AI-Memory 下四个子文件夹），靠 parent_id 过滤；权重 fact>summary>exp>belief |
| 8 | 索引方案 | 标题即索引，不维护单独 index 副本 |
| 9 | 去重判据 | 关键词相同 + 结论等价 = 相同；全局唯一（跨层唯一） |
| 10 | 去重实现 | v1 = search 缩小候选 + 极小范围比对；v2 = 嵌入向量相似度程序化 |
| 11 | 召回门控 | 一次 search，标题命中=强相关 / 正文命中=弱相关 / 零命中=不查 |
