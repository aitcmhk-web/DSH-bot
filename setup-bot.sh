#!/bin/sh
# 老入口，保留兼容 —— 以前让人跑的那条命令现在照样能用：
#   curl -fsSL https://raw.githubusercontent.com/aitcmhk-web/DSH-bot/main/setup-bot.sh | zsh
#
# 它自己什么都不干了，只把活交给新的 setupbot.sh（同一个仓库根目录，主入口）。
# 完整流程（装 dsh、选工作区、装插件、绑 TG、绑微信）都在 setupbot.sh 里，
# 以后甚至只要敲 setupbot 一个词（第一次跑完它就装进 PATH 了）。

set -u

URL="${SETUPBOT_URL:-https://raw.githubusercontent.com/aitcmhk-web/DSH-bot/main/setupbot.sh}"
TMP="$(mktemp -t setupbot.XXXXXX 2>/dev/null || echo "/tmp/setupbot.$$.sh")"

if curl -fsSL --max-time 60 "$URL" -o "$TMP" 2>/dev/null && [ -s "$TMP" ]; then
  /bin/zsh "$TMP" "$@"
  RC=$?
  rm -f "$TMP" 2>/dev/null
  exit $RC
fi

rm -f "$TMP" 2>/dev/null
printf '\n⛔ 没能把 setupbot.sh 下载下来（大概是没网）。\n' >&2
printf '   有网了再跑一次这条命令就行。\n' >&2
exit 1
