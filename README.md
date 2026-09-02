# editable_memory — AI 长期记忆（程序化 CLI）

Agent 的「蒸馏知识层」，持久化到 Joplin 笔记本 `AI-Memory`（四层：fact / belief / exp / summary）。
**按需召回，永不整库注入；提炼写入，绝不堆积日志。**
判定（去重 / 门控 / 排序）全走 embedding 余弦，零依赖 Node CLI（Node >= 18）。

## 安装

```bash
# 1. 复制到 skill 目录（例如 pi 的 skills 下）
cp -r . ~/.pi/agent/skills/memory/

# 2. 准备本地配置（真实密钥不进仓库）
cp config.example.json config.json
#    在 config.json 里填 Joplin token / notebook id / embedding apiKey
#    或用环境变量注入：JOPLIN_TOKEN、EMBED_API_KEY
```

> 首次运行 `node memory.mjs doctor` 会自动发现并缓存 Joplin 层 id、解析 token。

## 用法

```bash
node memory.mjs recall <关键词...>   # 门控召回 → JSON（任务开始前）
node memory.mjs retain <layer> <title> [body]  # 去重写入 → JSON（任务结束后）
node memory.mjs reflect              # 检测冲突/聚合/升级建议 → JSON
node memory.mjs reflect --apply '<json>'  # 执行聚合/迁移（两段式第二步）
node memory.mjs doctor               # 诊断：连通性/token/层id/embedding
node memory.mjs test                 # 自检
```

完整使用说明见 [SKILL.md](./SKILL.md)。

## 项目结构

- `memory.mjs` — 程序化 CLI（recall/retain/reflect/doctor/test）
- `SKILL.md` — skill 文档（工作流 + layer 判定速查表）
- `config.example.json` — 配置模板（不含密钥）
- `LICENSE` — MIT

## 不提交的文件

- `config.json` — 本地配置，含 Joplin token / embedding API key（模板见 `config.example.json`）
- `state.json` — 本地 embedding 向量缓存

## 阈值（config.json 可调）

`same_th=0.75`（相同→合并）、`rel_th=0.30`（相关→门控/保持）、`N=3`（互补聚合触发）、`M=20`（周期 reflect 触发）。
初值来自小样本实测，随使用积累校准。
