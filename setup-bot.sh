#!/bin/sh
# 老入口，保留兼容 —— 以前让人跑的那条命令现在照样能用：
#   curl -fsSL https://raw.githubusercontent.com/aitcmhk-web/DSH-bot/main/setup-bot.sh | sh
#
# 它自己什么都不干了，只把活交给新的 setupbot.sh（同一个仓库根目录，主入口）。
#
# ⚠️ 现在这事分成两个（各管一头，互不越界）：
#   setupdsh —— 机器上的家伙：Git、Node、DSH 本体（装 + 升级）
#               在线入口：curl -fsSL .../setupdsh.sh | sh
#   setupbot —— 建/选工作区、装插件、绑 TG / 微信、生成工作区里那 5 个文件（英文名）
#               在线入口：curl -fsSL .../setupbot.sh | sh（就是这个文件转发的那个）
# 机器上还没有 dsh 的时候，setupbot 会自己把 setupdsh 跑一遍，顺序不用你操心；
# 以后升级本体敲 setupdsh，重新绑 TG / 微信敲 setupbot。

set -u

URL="${SETUPBOT_URL:-https://raw.githubusercontent.com/aitcmhk-web/DSH-bot/main/setupbot.sh}"
TMP="$(mktemp -t setupbot.XXXXXX 2>/dev/null || echo "/tmp/setupbot.$$.sh")"

if curl -fsSL --max-time 60 "$URL" -o "$TMP" 2>/dev/null && [ -s "$TMP" ]; then
  /bin/sh "$TMP" "$@"
  RC=$?
  rm -f "$TMP" 2>/dev/null
  exit $RC
fi

rm -f "$TMP" 2>/dev/null
printf '\n⛔ 没能把 setupbot.sh 下载下来（大概是没网）。\n' >&2
printf '   有网了再跑一次这条命令就行。\n' >&2
exit 1
