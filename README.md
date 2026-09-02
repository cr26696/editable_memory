# editable_memory — AI 长期记忆 CLI

轻量且结构化的 AI 长期记忆机制。将经验、事实与偏好持久化至本地 Joplin，通过零依赖 Node CLI（`memory.mjs`）实现精准按需召回与提炼写入。

---

## 核心设计理念

1. **按需召回，杜绝上下文污染**
   不搞“全量注入提示词”。任务前仅按关键词召回最相关的极少数条目（严格限制 ≤5 条 / ≤800 Token）。
2. **算法负责数学判定，模型负责语义提炼**
   条目重复度、相关度、预算裁剪由脚本基于向量余弦相似度计算（确定性高、执行快）；模型仅负责总结经验结论和分层。
3. **四层结构化分类**
   按知识属性拆分为四层，分属不同 Joplin 笔记本并赋予不同检索权重：
   - **fact** (权重 1.0): 确定、长期有效的客观环境/系统事实。
   - **summary** (权重 0.9): 针对特定项目/实体的宏观画像与全貌。
   - **exp** (权重 0.7): 一次性排错排坑经验、踩坑记录。
   - **belief** (权重 0.6): 带置信度的推断、偏好假设（随复现验证逐步升降级）。

---

## 快速上手

### 1. 安装配置

将本项目放入 Agent 的 skills 目录：

```bash
# 复制模板配置
cp config.example.json config.json
```

编辑 `config.json` 填入本地 Joplin Web Clipper Token 及 Embedding API Key（也支持通过环境变量 `JOPLIN_TOKEN` 与 `EMBED_API_KEY` 传入）。

运行诊断确认环境正常：
```bash
node memory.mjs doctor
```
> `doctor` 会自动在 Joplin 中寻找或创建 `AI-Memory` 笔记本及四层子笔记本，并自动把映射 ID 写入 `config.json`。

### 2. 核心指令

```bash
# 任务前：按关键词召回（返回匹配 JSON）
node memory.mjs recall "关键词"

# 任务后：提炼沉淀（自动去重/判定重复）
node memory.mjs retain fact "CentOS 8 缺失 musl 静态链接库" "详情..."
node memory.mjs retain belief "用户倾向使用精简纯 CLI 工具" "详情..." --conf 0.8

# 周期维护：发现碎片聚合、置信度升级
node memory.mjs reflect

# 诊断与单测
node memory.mjs doctor
node memory.mjs test
```

详细参数交互说明与调用契约见 [SKILL.md](./SKILL.md)。

---

## 目录说明

- `memory.mjs`: CLI 核心脚本（零第三方依赖，Node.js >= 18）
- `SKILL.md`: 供 Agent 读取的 Skill 规范与使用指引
- `DESIGN.md`: 系统设计理念、架构权衡与运行机制详解
- `docs/`: 演进过程中的设计初稿、实施计划与实测调研文档
  - `docs/PLAN.md`: CLI 改造与分步实施路线
  - `docs/ai-memory-sync-design.md`: 早期多端同步与架构权衡草案
  - `docs/notes/embedding-api.md`: 向量模型分辨力与选型实测记录
- `config.example.json`: 配置模版（生产配置 `config.json` 与本地向量缓存 `state.json` 默认被 `.gitignore` 忽略）
- `LICENSE`: MIT License
