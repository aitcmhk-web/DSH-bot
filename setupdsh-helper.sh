#!/bin/bash
# setupdsh-helper.sh —— 由 TG 菜单 /setupdsh 调用的辅助脚本。
# 把 setupdsh.sh 复制到临时目录执行，不依赖用户 PATH。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETUPDSH_SRC="${SCRIPT_DIR}/setupdsh.sh"

if [ ! -f "$SETUPDSH_SRC" ]; then
  echo "❌ 找不到 setupdsh.sh（${SETUPDSH_SRC}）"
  exit 1
fi

echo "⬆️ SetupDSH&BOT 升级启动中…"
bash "$SETUPDSH_SRC"
