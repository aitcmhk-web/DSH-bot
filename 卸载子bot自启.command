#!/bin/sh
# 卸载子 bot（001bot…004bot）的 launchd 自启。
# 版本：2026-10-06.1

APP="$(cd "$(dirname "$0")" || exit 1)"

echo "卸载子 bot 自启"
echo "────────────────────────────────────────"

for INST in 001bot 002bot 003bot 004bot; do
  LABEL="com.local.dshbot.${INST}"
  PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
  echo "--- $INST ---"
  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null && echo "✅ ${LABEL} 已卸载" || echo "⚠️ ${LABEL} 未加载或卸载失败"
  else
    echo "（没有 plist，跳过）"
  fi
done

echo
echo "全部完成。"
