#!/bin/bash
# setupdsh-helper.sh —— 由 TG 菜单 /setupdsh 调用的辅助脚本（软件版 bot.js 和插件版都调它）。
#
# ⚠️ 为什么先上网拉一份再跑（2026-10-01 用户问到「执行的固定版本？」）：
#    包里的 setupdsh.sh 里写着固定 tag（SPEC=…#vX.Y.Z），下一个版本一发，
#    老包里那份就永远只装老 tag —— 这个升级按钮等于失效。
#    所以这里每次先无条件拉网上最新那份 setupdsh.sh，拉到就用它跑；
#    拉不到（没网）才退回包里这份，并明说用的是本机那份。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETUPDSH_SRC="${SCRIPT_DIR}/setupdsh.sh"
SETUPDSH_URL="${SETUPDSH_URL:-https://raw.githubusercontent.com/aitcmhk-web/DSH-bot/main/setupdsh.sh}"
SELF_PATH="${HOME}/.dsh/setupdsh/setupdsh.sh"

if [ ! -f "$SETUPDSH_SRC" ]; then
  echo "❌ 找不到 setupdsh.sh（${SETUPDSH_SRC}）"
  exit 1
fi

echo "⬆️ SetupDSH&BOT 升级启动中…"

# ① 拉网上最新那份（必须是带 self-marker 的真脚本），拉到了就直接用它跑
mkdir -p "$(dirname "${SELF_PATH}")" 2>/dev/null || true
if curl -fsSL --max-time 25 "$SETUPDSH_URL" -o "${SELF_PATH}.new" 2>/dev/null \
   && [ -s "${SELF_PATH}.new" ] \
   && grep -q 'setupdsh-self-marker' "${SELF_PATH}.new" 2>/dev/null; then
  if mv "${SELF_PATH}.new" "$SELF_PATH" 2>/dev/null; then
    chmod +x "$SELF_PATH" 2>/dev/null || true
    exec /bin/sh "$SELF_PATH"
  fi
fi
rm -f "${SELF_PATH}.new" 2>/dev/null || true

# ② 没网：用包里这份（开头会报自己的版本号，一眼看出新不新）
echo "（这次没拿到网上那份最新脚本，用本机包里那份 setupdsh 跑）"
exec /bin/sh "$SETUPDSH_SRC"
