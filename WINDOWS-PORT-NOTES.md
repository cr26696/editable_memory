# Windows 本机移植记录 & 走向成熟/可分发清单

> 日期：2026-09-02 · 设备：Windows 11 (本机 pi agent, Joplin Desktop 3.7.12)
> 状态：本机端到端验证通过（doctor 全绿 / recall 语义命中 / test 全绿）
> 迁移结论：与 CentOS 共用同一 WebDAV 记忆库（nb/layers ID 一致），config.json 已对齐

## 已完成的适配（最小改动，memory.mjs 零改动）

- [x] 技能装入 `~/.agents/skills/memory/`（+ `~/.pi/agent/skills/memory` symlink）
- [x] `config.json` 对齐 CentOS（nb/layers/embed/thresholds）
- [x] 本机 token 走自动解析（`joplin-desktop/settings.json`），不写死
- [x] `doctor` 全绿 / `recall` 语义命中 / `test` 全绿

## 现状架构（与 CentOS 一致）

```
本机 pi agent → memory.mjs → localhost:41184 (Joplin Desktop REST)
                                            └─ 手动/GUI sync → WebDAV (tkdrive.lawaias.top/dav/joplin)
CentOS 枢纽 (Joplin CLI, cron 5min sync) ──→ 同一 WebDAV ←── 手机/PC 查看
```

## ⚠️ 当前已知限制 / 待优化（按优先级）

### P0 — 数据安全与可分发硬伤
1. **同步依赖人工/GUI**：本机 Desktop 是唯一写者，`retain` 后必须手动 sync 才会推 WebDAV。
   成熟方案需「写后自动同步」——但 Windows 无原生 CLI，GUI sync 无法被外部触发。
   **候选**：a) Joplin MCP server（本机已装 joplin-mcp-server@2.2.2）是否暴露 sync 动作，待查；
   b) 接受「≤几分钟」延迟，靠 Desktop 自动 sync。
2. **config.json 明文存 key**：embedding apiKey 与(未来)token 落盘明文。可分发需支持
   环境变量覆盖（`EMBED_API_KEY`/`JOPLIN_TOKEN` 已支持）或系统密钥环。
3. **repo 与 skill 副本分离**：真实代码在 git，但本机运行的是 `~/.agents/skills/memory/` 的拷贝，
   改代码要手动同步回 repo —— 需建立安装/更新脚本（如 `install.sh` 软链或 copy）。

### P1 — 行为/健壮性
4. **recall 空库/embedding 故障路径**：已降级 n-gram，但阈值未按本机数据校准（沿用 CentOS 初值）。
5. **test 依赖真实 embedding**：`memory.mjs test` 会打 embedding API（非纯本地），离线时 `test` 失败。
   建议 test 拆「纯逻辑(离线)」与「embedding 集成(需网)」。
6. **`/folders/{id}/notes` 分页/limit 坑**：本机曾误读为「记忆层为空」，实为 Joplin 分页默认。
   成熟 CLI 应显式分页(limit/page)而非依赖默认。

### P2 — 可宣传/分发
7. **配置引导**：一键 `doctor` + 首次配置向导（而非手改 config.json）。
8. **文档**：README 目前面向「自用」，缺「他人快速上手/安装到任意 agent skills 目录」的分发说明。
9. **版本与升级**：git tag + CHANGELOG；skill 更新机制（当前靠手动重拉）。
10. **隐私说明**：embedding 会把标题发往中转 API —— 分发需明确标注「数据出域」，或提供本地模型选项。

## 待你拍板的（未做，避免过度工程）
- embedding key 已写入本机 config.json（明文）；是否改为仅环境变量？
- 是否将 repo_tmp 正式落地为 `C:/PI/mem/editable_memory`（去掉 -tmp），并建 `install`/`update` 脚本？
- 未来「提取核心 + 适配层」：目前 memory.mjs 单文件零依赖；建议维持到出现第二个存储/embedding 后端再拆。
