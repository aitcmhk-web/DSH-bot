#!/bin/sh
# dsh-botplugin 一键装 + 填 token（在线方式）
#
# 给用户的一条命令：
#   curl -fsSL https://raw.githubusercontent.com/aitcmhk-web/DSH-bot/main/setup-bot.sh | zsh
#
# 它会自己干完这些事，中间只问你一样东西：token。
#   1) 没装 dsh 就先 npm i -g @deepseek-ai/dsh
#   2) 定 profile：已经装过本插件的那个 → 就用它；没装过 → 用 mybot（新建，不动别的 profile）
#      （想指定别的名字：zsh setup-bot.sh 你的名字）
#   3) dsh plugin --profile <名> add github:aitcmhk-web/DSH-bot
#   4) 问你要 token，写进 <profile>/cordis.patch.yml（原子替换，不破坏文件里别的内容）
#   5) --dump-config 复核一遍，最后打一行启动命令
#
# 测试用钩子（不写进用户文档）：BOT_TOKEN=... 预置 token；BOTPLUGIN_SPEC=... 换成本地路径。

set -u

SPEC="${BOTPLUGIN_SPEC:-github:aitcmhk-web/DSH-bot}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILES="$DSH_HOME_DIR/profiles"
DEFAULT_PROFILE="mybot"

say()  { printf '%s\n' "$*"; }
die()  { printf '\n⛔ %s\n' "$*" >&2; exit 1; }
ask()  {
  printf '%s' "$*"
  REPLY_V=""
  # ⚠️ curl … | zsh 时脚本正文就在 stdin 上：必须从 /dev/tty 读，别把后面的脚本当 token 吃掉
  if [ -r /dev/tty ]; then read -r REPLY_V < /dev/tty || REPLY_V=""
  elif [ -t 0 ]; then read -r REPLY_V || REPLY_V=""
  fi
}

# ---- 1. dsh 本体 ----------------------------------------------------------
DSHBIN="$(command -v dsh 2>/dev/null || true)"
if [ -z "$DSHBIN" ]; then
  say "这台机器还没装 dsh，先装它（一两分钟）…"
  npm i -g @deepseek-ai/dsh || die "装 dsh 失败了，看上面的报错。"
  DSHBIN="$(command -v dsh 2>/dev/null || true)"
  [ -n "$DSHBIN" ] || die "装完了还是找不到 dsh 命令（可能要重开一个终端）。"
fi

# ---- 2. 定 profile --------------------------------------------------------
PROFILE="${1:-}"
if [ -z "$PROFILE" ]; then
  if [ -d "$PROFILES/$DEFAULT_PROFILE/node_modules/dsh-botplugin" ]; then
    PROFILE="$DEFAULT_PROFILE"      # mybot 里装过 → 就用它
  else
    # 哪个 profile 里装过本插件（⚠️ 不用 glob：zsh 遇到无匹配会直接报错退出）
    PROFILE=""
    for pd in $(find "$PROFILES" -mindepth 1 -maxdepth 1 -type d 2>/dev/null); do
      pn="$(basename "$pd")"
      [ "$pn" = "node_modules" ] && continue
      if [ -d "$pd/node_modules/dsh-botplugin" ]; then PROFILE="$pn"; break; fi
    done
    [ -n "$PROFILE" ] || PROFILE="$DEFAULT_PROFILE"    # 哪儿都没装过 → 新建 mybot
  fi
fi
case "$PROFILE" in
  ""|*[!A-Za-z0-9._-]*) die "profile 名只能有字母、数字、点、下划线、减号。" ;;
esac
if [ -d "$PROFILES/$PROFILE" ]; then
  say "profile：$PROFILE"
else
  say "profile：${PROFILE}（新建一个，你现有的别的 profile 不动）"
fi

# ---- 3. 装插件 -------------------------------------------------------------
say "装插件…（一两分钟）"
( cd "$HOME" && "$DSHBIN" plugin --profile "$PROFILE" add "$SPEC" ) || die "插件没装上，看上面的报错。"
say "✅ 插件装好了。"

# ---- 4. 要 token，写进配置 -------------------------------------------------
CFG="$PROFILES/$PROFILE/cordis.patch.yml"
TOKEN="${BOT_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  n=0
  while [ "$n" -lt 3 ]; do
    ask "把 @BotFather 给你的 token 粘进来，回车（形如 123456:AA...，不填就直接回车）："
    TOKEN="${REPLY_V:-}"
    case "$TOKEN" in
      "") say "好，先跳过 token。"; break ;;
      [0-9]*:[A-Za-z0-9_-]*) break ;;
      *) say "这串看着不像 token（一般长这样 123456:AA...），再粘一次。"; TOKEN="" ;;
    esac
    n=$((n + 1))
  done
fi

if [ -n "$TOKEN" ]; then
  mkdir -p "$(dirname "$CFG")"
  TMP="$(dirname "$CFG")/.cordis.patch.yml.$$.tmp"
  trap 'rm -f "$TMP"' EXIT INT TERM
  BODY="$(grep -vE '^[[:space:]]*(#|$)' "$CFG" 2>/dev/null | tr -d '[:space:]' || true)"
  if [ -f "$CFG" ] && [ "$BODY" != "" ] && [ "$BODY" != "[]" ] && grep -q '^[[:space:]]*-[[:space:]]*id:[[:space:]]*botplugin[[:space:]]*$' "$CFG"; then
    # 文件里已经有 botplugin 条目：只改块里的 telegramToken，别的不动
    awk -v tok="$TOKEN" '
      BEGIN { inblk = 0; seen = 0; gotcfg = 0 }
      {
        if ($0 ~ /^[[:space:]]*-[[:space:]]*id:[[:space:]]*botplugin[[:space:]]*$/) { inblk = 1; print; next }
        if (inblk && $0 ~ /^[[:space:]]*-[[:space:]]*id:/) {
          if (!seen) { if (!gotcfg) print "  config:"; print "    telegramToken: \"" tok "\""; seen = 1 }
          inblk = 0; print; next
        }
        if (inblk) {
          if ($0 ~ /^[[:space:]]*telegramToken:/) { print "    telegramToken: \"" tok "\""; seen = 1; next }
          if ($0 ~ /^[[:space:]]*config:[[:space:]]*$/) { print; gotcfg = 1; next }
        }
        print
      }
      END { if (inblk && !seen) { if (!gotcfg) print "  config:"; print "    telegramToken: \"" tok "\"" } }
    ' "$CFG" > "$TMP" || die "配置文件写不动，看上面的报错。"
  elif [ -f "$CFG" ] && [ "$BODY" != "" ] && [ "$BODY" != "[]" ]; then
    # 文件里有别的插件条目：把我们这条追加在后面
    { cat "$CFG"; printf -- '- id: botplugin\n  config:\n    telegramToken: "%s"\n' "$TOKEN"; } > "$TMP"
  else
    # 空文件 / 全新 profile 的 scaffold（只有注释和 []）：整份写成我们的条目
    printf -- '- id: botplugin\n  config:\n    telegramToken: "%s"\n' "$TOKEN" > "$TMP"
  fi
  mv "$TMP" "$CFG" || die "配置文件没能替换成功。"
  say "✅ token 写进配置了：$CFG"
else
  say "⚠️ 还没填 token。想补的时候，把同一条命令再跑一遍就行。"
fi

# ---- 5. 复核 + 收尾 --------------------------------------------------------
say ""
if [ -n "$TOKEN" ]; then
  if "$DSHBIN" --profile "$PROFILE" --dump-config 2>/dev/null | grep -q 'id: botplugin'; then
    say "✅ 复核通过：配置已经生效。"
  else
    say "⚠️ 复核没看到插件条目，可能要重启一下 DSH 再看。"
  fi
fi
say "启动：dsh --profile $PROFILE"
