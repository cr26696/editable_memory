#!/usr/bin/env bash
# editable_memory —— 安装/更新到本机 pi 技能目录
# 用法:
#   ./install.sh          # 安装或更新（把本 repo 同步到 ~/.agents/skills/memory）
#   ./install.sh --dry    # 只预览会复制哪些文件，不改动
#
# 设计: repo 是真源(git)，技能目录是运行副本。
# 运行副本保留 config.json / state.json(本地生成, 不入 git)，
# 其余文件(.mjs/SKILL.md/docs/README...)每次从 repo 覆盖同步。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${DEST_DIR:-$HOME/.agents/skills/memory}"
PI_LINK="$HOME/.pi/agent/skills/memory"

# 若目标是 ~/.pi/... 下某个已存在的真实目录，自动转成 ~/.agents/...(共享真身)
case "$DEST_DIR" in
  */.pi/*)
    REAL="${DEST_DIR%%/.pi/*}/.agents${DEST_DIR#*/.pi}"
    echo "[info] 目标在 ~/.pi 下，改用共享真身: $REAL"
    DEST_DIR="$REAL" ;;
esac

dry=0
[[ "${1:-}" == "--dry" ]] && dry=1

echo "==> 源: $REPO_DIR"
echo "==> 目标: $DEST_DIR"

# 需同步的清单（排除本地生成/敏感文件）
mapfile -t FILES < <(cd "$REPO_DIR" && git ls-files | grep -vE '^\.gitignore$|config\.json$|state\.json$' || true)
# git ls-files 可能为空(浅克隆无 index?) —— 兜底用 find
if [[ ${#FILES[@]} -eq 0 ]]; then
  FILES=($(cd "$REPO_DIR" && find . -type f -not -path './.git/*' -not -name 'config.json' -not -name 'state.json' -not -name '.gitignore' | sed 's|^\./||'))
fi

if [[ $dry -eq 1 ]]; then
  echo "==> [dry] 将同步 ${#FILES[@]} 个文件:"
  printf '    %s\n' "${FILES[@]}"
  exit 0
fi

mkdir -p "$DEST_DIR"
for f in "${FILES[@]}"; do
  mkdir -p "$DEST_DIR/$(dirname "$f")"
  cp "$REPO_DIR/$f" "$DEST_DIR/$f"
done

# 若 DEST 有本地 config.json/state.json 而 repo 没有则保留（运行配置不覆盖）
[[ -f "$DEST_DIR/config.json" ]] || cp "$REPO_DIR/config.example.json" "$DEST_DIR/config.json" 2>/dev/null || true

# pi symlink（指向共享真身，仅当 ~/.pi 存在）
if [[ -d "$HOME/.pi" ]]; then
  mkdir -p "$(dirname "$PI_LINK")"
  ln -sfn "$DEST_DIR" "$PI_LINK"
  echo "==> symlink: $PI_LINK -> $DEST_DIR"
fi

echo "==> 完成: $DEST_DIR ($(printf '%s' "${FILES[@]}" | wc -w) 文件同步)"
echo "==> 本地保留: config.json(密钥) / state.json(向量缓存) 未覆盖"
