#!/bin/sh
# setupbot — 一条命令干完：装/升级 DSH、装/升级插件、挑工作区、绑 TG、绑微信。
# setupbot-self-marker（别删这行：脚本靠它认出「我自己」，避免把别的文件当自己复制）
#
# 给用户的命令（第一次跑一次，之后只要敲 setupbot）：
#   curl -fsSL https://raw.githubusercontent.com/aitcmhk-web/DSH-bot/main/setupbot.sh | zsh
#
# 它自己会办完：
#   0) 把 setupbot 命令装进 PATH（以后直接敲 setupbot，可重复跑）
#   1) dsh 没有就装，有就升到最新
#   2) 列出已有工作区让你选编号，或直接回车新建（问你名字，直接回车就叫 mybot）
#      （想直接指定：zsh setupbot.sh 你的工作区名）
#   3) 把插件装进这个工作区 / 升级到最新
#   4) TG：列出这台机器上已用过的 token 让你选，或粘一个新的
#   5) 微信：用已有的凭据、重新扫码、或先不绑
#   6) 生成双击启动器 + 复核配置
#
# 测试钩子（不写进用户文档）：
#   BOT_TOKEN=...                预置 token，跳过询问
#   BOTPLUGIN_SPEC=...           插件来源，默认 github:aitcmhk-web/DSH-bot
#   SETUPBOT_IN=文件             从文件逐行读答案（非交互测试）
#   SETUPBOT_URL=...             脚本自身的下载地址
#   SETUPBOT_NO_SELF_INSTALL=1   不安装 setupbot 命令
#   SETUPBOT_SKIP_DSH_UPGRADE=1  不升级 dsh

set -u

# ⚠️ zsh 在函数体里会把 $0 换成函数名，必须在这一层先记住脚本自己的路径
SRC_PATH="$0"
# 也支持老用法：zsh setupbot.sh 工作区名（不指定就问你）
ARG_PROFILE="${1:-}"

SETUPBOT_URL="${SETUPBOT_URL:-https://raw.githubusercontent.com/aitcmhk-web/DSH-bot/main/setupbot.sh}"
SPEC="${BOTPLUGIN_SPEC:-github:aitcmhk-web/DSH-bot}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILES="$DSH_HOME_DIR/profiles"
SELF_DIR="$HOME/.dsh/setupbot"
SELF_PATH="$SELF_DIR/setupbot.sh"
LAUNCH_DIR="$HOME/DSH"

# 让接下来每一次调 dsh 都认准同一个家目录
export DSH_HOME="$DSH_HOME_DIR"

say()  { printf '%s\n' "$*"; }
die()  { printf '\n⛔ %s\n' "$*" >&2; exit 1; }

# 问一句、读一行。⚠️ curl … | zsh 时脚本正文占着 stdin，必须从 /dev/tty 读。
ask() {
  printf '%s' "$*"
  REPLY_V=""
  if [ -n "${SETUPBOT_IN:-}" ] && [ -r "$SETUPBOT_IN" ]; then
    IFS= read -r REPLY_V <&3 || REPLY_V=""
  elif [ -r /dev/tty ]; then
    read -r REPLY_V < /dev/tty || REPLY_V=""
  elif [ -t 0 ]; then
    read -r REPLY_V || REPLY_V=""
  fi
}

# 只露头尾，别把整串密钥打到屏幕上
mask_secret() {
  s="$1"
  n="${#s}"
  if [ "$n" -le 10 ]; then printf '****'; return; fi
  printf '%s…%s' "$(printf '%s' "$s" | cut -c1-6)" "$(printf '%s' "$s" | cut -c$((n - 3))-$n)"
}

# 从 cordis.patch.yml 里取一个键的值（去引号、去行尾注释）
cfg_get() {
  [ -f "$1" ] || return 0
  grep -E "^[[:space:]]*$2[[:space:]]*:" "$1" 2>/dev/null | head -1 \
    | sed -E "s/^[[:space:]]*$2[[:space:]]*:[[:space:]]*//; s/^\"//; s/\"[[:space:]]*(#.*)?\$//; s/[[:space:]]*#.*\$//"
}

has_botplugin_block() {
  [ -f "$1" ] && grep -qE '^[[:space:]]*-[[:space:]]*id:[[:space:]]*botplugin[[:space:]]*$' "$1"
}

# 顶层数组里有没有这个 id 的条目（如 agent-default-model）
has_patch_entry() {
  [ -f "$2" ] && grep -qE "^[[:space:]]*-[[:space:]]*id:[[:space:]]*$1[[:space:]]*\$" "$2"
}

# 在某个 id 的块里「改/加」一个键，注释和别的键都留着
set_block_key() {
  bid="$1"; key="$2"; val="$3"; cfg="$4"
  tmp="$cfg.$$.tmp"
  awk -v bid="$bid" -v key="$key" -v val="$val" '
    function emit() { if (!gotcfg) print "  config:"; print "    " key ": \"" val "\"" }
    BEGIN { inblk = 0; seen = 0; gotcfg = 0 }
    {
      if ($0 ~ ("^[[:space:]]*-[[:space:]]*id:[[:space:]]*" bid "[[:space:]]*$")) { inblk = 1; print; next }
      if (inblk && $0 ~ /^[[:space:]]*-[[:space:]]*id:/) {
        if (!seen) { emit(); seen = 1 }
        inblk = 0; print; next
      }
      if (inblk) {
        if ($0 ~ ("^[[:space:]]*" key "[[:space:]]*:")) { print "    " key ": \"" val "\""; seen = 1; next }
        if ($0 ~ /^[[:space:]]*config:[[:space:]]*$/) { print; gotcfg = 1; next }
      }
      print
    }
    END { if (inblk && !seen) emit() }
  ' "$cfg" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$cfg"
}

set_cfg_key() { set_block_key botplugin "$1" "$2" "$3"; }

workspace_list() {
  find "$PROFILES" -mindepth 1 -maxdepth 1 -type d ! -name node_modules 2>/dev/null | sort
}

TMP_ROOT="$(mktemp -d)"
WS_FILE="$TMP_ROOT/ws"
TOK_FILE="$TMP_ROOT/tokens"
WX_FILE="$TMP_ROOT/wechat"
: > "$WS_FILE"; : > "$TOK_FILE"; : > "$WX_FILE"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

if [ -n "${SETUPBOT_IN:-}" ] && [ -r "$SETUPBOT_IN" ]; then
  exec 3<"$SETUPBOT_IN" || true
fi

# ============ 0. 把自己装成 setupbot 命令 ============
install_self() {
  mkdir -p "$SELF_DIR" 2>/dev/null || return 0
  # 有实体脚本文件（在线下载的 / 安装包里的）就复制自己；curl|zsh 没有实体才去下载
  if [ -f "$SRC_PATH" ] && grep -q 'setupbot-self-marker' "$SRC_PATH" 2>/dev/null; then
    cp "$SRC_PATH" "$SELF_PATH" 2>/dev/null || true
  fi
  if [ ! -s "$SELF_PATH" ]; then
    curl -fsSL "$SETUPBOT_URL" -o "$SELF_PATH.new" 2>/dev/null \
      && mv "$SELF_PATH.new" "$SELF_PATH" || rm -f "$SELF_PATH.new" 2>/dev/null
  fi
  [ -s "$SELF_PATH" ] || return 0
  chmod +x "$SELF_PATH" 2>/dev/null || true

  # 挑一个「在 PATH 里、又能写」的目录放启动器
  BIN_DIR=""
  FALLBACK=""
  for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
    [ -d "$d" ] || mkdir -p "$d" 2>/dev/null || true
    [ -d "$d" ] && [ -w "$d" ] || continue
    case ":${PATH}:" in
      *":${d}:"*) BIN_DIR="$d"; break ;;
      *) [ -n "$FALLBACK" ] || FALLBACK="$d" ;;
    esac
  done
  [ -n "$BIN_DIR" ] || BIN_DIR="$FALLBACK"
  [ -n "$BIN_DIR" ] || BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR" 2>/dev/null || return 0

  {
    printf '#!/bin/zsh\n'
    printf '# setupbot — 自动生成。每次运行先试着从网上更新自己，没网就用本地这份。\n'
    printf 'URL="%s"\n' "$SETUPBOT_URL"
    printf '%s\n' 'SELF="$HOME/.dsh/setupbot/setupbot.sh"'
    printf '%s\n' 'mkdir -p "$(dirname "$SELF")" 2>/dev/null'
    printf '%s\n' 'if curl -fsSL --max-time 25 "$URL" -o "$SELF.new" 2>/dev/null && [ -s "$SELF.new" ]; then'
    printf '%s\n' '  mv "$SELF.new" "$SELF"'
    printf '%s\n' 'else'
    printf '%s\n' '  rm -f "$SELF.new" 2>/dev/null'
    printf '%s\n' 'fi'
    printf '%s\n' '[ -s "$SELF" ] || { echo "⛔ setupbot 本体不在（可能没网）。请重跑一次安装命令。"; exit 1; }'
    printf '%s\n' 'exec /bin/zsh "$SELF" "$@"'
  } > "$BIN_DIR/setupbot" 2>/dev/null || return 0
  chmod +x "$BIN_DIR/setupbot" 2>/dev/null || true
  SELF_BIN_DIR="$BIN_DIR"

  case ":${PATH}:" in
    *":${BIN_DIR}:"*) : ;;
    *)
      if ! grep -qF "$BIN_DIR" "$HOME/.zshrc" 2>/dev/null; then
        printf '\n# setupbot\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$HOME/.zshrc" 2>/dev/null || true
        say "（已把 ${BIN_DIR} 写进 ~/.zshrc，新开一个终端 setupbot 就能直接敲）"
      fi
      ;;
  esac
}

# ============ 1. dsh 本体 ============
DSHBIN=""
ensure_dsh() {
  DSHBIN="$(command -v dsh 2>/dev/null || true)"
  if [ -z "$DSHBIN" ]; then
    command -v npm >/dev/null 2>&1 || die "这台机器没有 npm。先装 Node.js（nodejs.org）再跑一次。"
    say "这台机器还没装 dsh，先装它（一两分钟）…"
    npm i -g @deepseek-ai/dsh || die "装 dsh 失败了，看上面的报错。"
    DSHBIN="$(command -v dsh 2>/dev/null || true)"
    [ -n "$DSHBIN" ] || die "装完还是找不到 dsh 命令（可能要重开一个终端）。"
  elif [ "${SETUPBOT_SKIP_DSH_UPGRADE:-}" != "1" ]; then
    say "把 dsh 升到最新…"
    if npm i -g @deepseek-ai/dsh >/dev/null 2>&1; then
      say "✅ dsh 已是最新。"
    else
      say "⚠️ dsh 没升成（大概是没网），用现在这版继续。"
    fi
  fi
}

# ============ 2. 选工作区 ============
PROFILE=""
IS_NEW=0
BOTCWD=""
pick_workspace() {
  # ⚠️ 先列一遍：后面挑 token / 挑微信都靠这份清单，提前 return 的分支也得有
  workspace_list > "$WS_FILE"
  if [ -n "$ARG_PROFILE" ]; then
    case "$ARG_PROFILE" in
      .|..|*/*|*\\*|*:*|-*) die "工作区名字不能用：${ARG_PROFILE}" ;;
    esac
    PROFILE="$ARG_PROFILE"
    if [ -d "$PROFILES/$PROFILE" ]; then
      say "好，用工作区：${PROFILE}"
    else
      IS_NEW=1
      mkdir -p "$LAUNCH_DIR/$PROFILE" 2>/dev/null || true
      BOTCWD="$LAUNCH_DIR/$PROFILE"
      say "好，新建工作区：${PROFILE}"
    fi
    return
  fi
  COUNT="$(wc -l < "$WS_FILE" | tr -d ' ')"
  say ""
  ANS=""
  if [ "$COUNT" -gt 0 ]; then
    say "这台机器上已有这些工作区："
    i=0
    while IFS= read -r p; do
      i=$((i + 1))
      say "  ${i}. $(basename "$p")"
    done < "$WS_FILE"
    say ""
    ask "请输入工作区编号；直接回车 = 新建一个："
    ANS="$(printf '%s' "${REPLY_V}" | tr -d '[:space:]')"
    case "$ANS" in
      "") : ;;
      *[!0-9]*) say "只认数字编号，这次当成新建。"; ANS="" ;;
    esac
    if [ -n "$ANS" ] && [ "$ANS" -ge 1 ] 2>/dev/null && [ "$ANS" -le "$COUNT" ] 2>/dev/null; then
      PROFILE="$(basename "$(sed -n "${ANS}p" "$WS_FILE")")"
      say "好，用工作区：${PROFILE}"
    elif [ -n "$ANS" ]; then
      say "没有这个编号，改成新建。"
      ANS=""
    fi
  else
    say "这台机器上还没有工作区，直接新建一个。"
  fi

  if [ -z "$PROFILE" ]; then
    n=0
    while [ "$n" -lt 3 ]; do
      ask "给新工作区起个名字（直接回车 = mybot）："
      NAME="$(printf '%s' "${REPLY_V}" | tr -d '[:space:]')"
      [ -n "$NAME" ] || NAME="mybot"
      case "$NAME" in
        .|..) say "这个名字不能用，再来一次。"; n=$((n + 1)); continue ;;
        */*|*\\*|*:*) say "名字里不能有 / \\ : 这些符号，再来一次。"; n=$((n + 1)); continue ;;
        -*) say "名字不能以 - 开头，再来一次。"; n=$((n + 1)); continue ;;
      esac
      PROFILE="$NAME"
      break
    done
    [ -n "$PROFILE" ] || die "没拿到工作区名字，先停。"
    if [ -d "$PROFILES/$PROFILE" ]; then
      say "这个工作区已经有了，就用它。"
    else
      IS_NEW=1
      mkdir -p "$LAUNCH_DIR/$PROFILE" 2>/dev/null || true
      BOTCWD="$LAUNCH_DIR/$PROFILE"
    fi
  fi
}

# ============ 3. 插件（装 / 升级） ============
install_plugin() {
  PLUGDIR="$PROFILES/$PROFILE/node_modules/dsh-botplugin"
  say ""
  if [ -d "$PLUGDIR" ]; then
    say "工作区 ${PROFILE} 里已经装了插件，升级到最新…"
  else
    say "给工作区 ${PROFILE} 装插件…（一两分钟）"
  fi
  ( cd "$HOME" && "$DSHBIN" plugin --profile "$PROFILE" add "$SPEC" ) || die "插件没装上，看上面的报错。"
  say "✅ 插件好了。"
}

# ============ 4. TG token ============
TOKEN=""
collect_tokens() {
  : > "$TOK_FILE"
  while IFS= read -r p; do
    t="$(cfg_get "$p/cordis.patch.yml" telegramToken)"
    [ -n "$t" ] || continue
    printf '%s\t%s\n' "$(basename "$p")" "$t" >> "$TOK_FILE"
  done < "$WS_FILE"
}

pick_token() {
  say ""
  OLD_TOKEN="$(cfg_get "$PROFILES/$PROFILE/cordis.patch.yml" telegramToken)"
  if [ -n "${BOT_TOKEN:-}" ]; then
    TOKEN="${BOT_TOKEN}"
    say "用预置的 token。"
    return 0
  fi
  collect_tokens
  TCOUNT="$(wc -l < "$TOK_FILE" | tr -d ' ')"
  # 先检查本工作区自己有没有绑过 —— 别让用户以为「从来没人问过」
  if [ -n "$OLD_TOKEN" ]; then
    say "本工作区（${PROFILE}）已经绑过 TG：$(mask_secret "$OLD_TOKEN")"
  fi
  if [ "$TCOUNT" -gt 0 ]; then
    say "这台机器上已经用过的 TG token："
    i=0
    while IFS="$(printf '\t')" read -r pn tt; do
      i=$((i + 1))
      say "  ${i}. ${pn} 用过的  $(mask_secret "$tt")"
    done < "$TOK_FILE"
    say ""
    if [ -n "$OLD_TOKEN" ]; then
      ask "输编号 = 换成那个；打 new = 重新粘一个；直接回车 = 不换，继续用本工作区原来那串："
    else
      ask "输编号 = 继续用它；打 new = 重新粘一个；直接回车 = 现在粘一个新的："
    fi
    ANS="$(printf '%s' "${REPLY_V}" | tr -d '[:space:]')"
    case "$ANS" in
      ""|*[!0-9]*) ANS="" ;;
    esac
    if [ -n "$ANS" ] && [ "$ANS" -ge 1 ] 2>/dev/null && [ "$ANS" -le "$TCOUNT" ] 2>/dev/null; then
      TOKEN="$(sed -n "${ANS}p" "$TOK_FILE" | cut -f2)"
      say "好，沿用第 ${ANS} 个。"
    fi
  elif [ -n "$OLD_TOKEN" ]; then
    say ""
    ask "直接回车 = 不换，继续用本工作区原来那串；打 new = 重新粘一个："
    ANS="$(printf '%s' "${REPLY_V}" | tr -d '[:space:]')"
    if [ -z "$ANS" ]; then
      TOKEN="$OLD_TOKEN"
    fi
  fi

  # 上文答复为空 = 走「粘一个新的」；此时若本工作区有旧串，空回车按「保留旧的」算，
  # 免得用户手一滑把已经绑好的 token 弄丢。
  if [ -z "$TOKEN" ] && [ -n "$OLD_TOKEN" ]; then
    say ""
    ask "本工作区原来那串还留着。回车 = 保留它；要换就现在粘新的："
    NEWV="$(printf '%s' "${REPLY_V}" | tr -d '[:space:]')"
    if [ -z "$NEWV" ]; then
      TOKEN="$OLD_TOKEN"
      say "好，保留原来的。"
    else
      case "$NEWV" in
        [0-9]*:[A-Za-z0-9_-]*) TOKEN="$NEWV" ;;
        *) say "这串看着不像 token，先按保留原来那串处理。" ; TOKEN="$OLD_TOKEN" ;;
      esac
    fi
  fi

  if [ -z "$TOKEN" ]; then
    n=0
    while [ "$n" -lt 3 ]; do
      ask "把 @BotFather 给你的 token 粘进来，回车（形如 123456:AA...；不填直接回车 = 跳过）："
      TOKEN="${REPLY_V}"
      case "$TOKEN" in
        "") say "好，先跳过 TG。"; break ;;
        [0-9]*:[A-Za-z0-9_-]*) break ;;
        *) say "这串看着不像 token，再粘一次。"; TOKEN="" ;;
      esac
      n=$((n + 1))
    done
  fi
  if [ -n "$TOKEN" ]; then
    say "✅ 收到 TG token：$(mask_secret "$TOKEN")"
  else
    say "⚠️ 这次没绑 TG。"
  fi
}

# ============ 5. 微信 ============
WXFILE=""
# 本工作区的微信凭据可能在两个地方：profile 目录里，或工作区目录（~/DSH/<名字>）里。
# 只扫前者会漏掉 setupbot 自己写的那份（2026-09-30 用户报「没检查有没有绑过」就是这个）。
collect_wechat() {
  : > "$WX_FILE"
  while IFS= read -r p; do
    pn="$(basename "$p")"
    f="$(cfg_get "$p/cordis.patch.yml" weixinAccountFile)"
    if [ -n "$f" ]; then
      case "$f" in /*) ;; *) f="$p/$f" ;; esac
      if [ -f "$f" ]; then printf '%s\t%s\n' "$pn" "$f" >> "$WX_FILE"; fi
    fi
    for c in "$p/weixin-account.json" "$LAUNCH_DIR/$pn/weixin-account.json"; do
      if [ -f "$c" ] && ! grep -qF "$c" "$WX_FILE" 2>/dev/null; then
        printf '%s\t%s\n' "$pn" "$c" >> "$WX_FILE"
      fi
    done
  done < "$WS_FILE"
}

pick_wechat() {
  say ""
  OLD_WX="$(cfg_get "$PROFILES/$PROFILE/cordis.patch.yml" weixinAccountFile)"
  if [ -z "$OLD_WX" ] && [ -f "$LAUNCH_DIR/$PROFILE/weixin-account.json" ]; then
    OLD_WX="$LAUNCH_DIR/$PROFILE/weixin-account.json"
  fi
  collect_wechat
  WCOUNT="$(wc -l < "$WX_FILE" | tr -d ' ')"
  N1=$((WCOUNT + 1))
  N2=$((WCOUNT + 2))
  if [ -n "$OLD_WX" ]; then
    say "本工作区（${PROFILE}）已经绑过微信：${OLD_WX}"
  fi
  if [ "$WCOUNT" -gt 0 ]; then
    say "这台机器上已有的微信绑定："
    i=0
    while IFS="$(printf '\t')" read -r pn wf; do
      i=$((i + 1))
      say "  ${i}. ${pn} 的  ${wf}"
    done < "$WX_FILE"
  else
    say "这台机器上还没有微信绑定。"
  fi
  say "  ${N1}. 重新扫码，绑一个"
  say "  ${N2}. 先不绑，跳过"
  say ""
  ask "请输入编号（直接回车 = 先不绑）："
  ANS="$(printf '%s' "${REPLY_V}" | tr -d '[:space:]')"
  case "$ANS" in
    ""|*[!0-9]*) ANS="$N2" ;;
  esac

  if [ "$ANS" -ge 1 ] 2>/dev/null && [ "$ANS" -le "$WCOUNT" ] 2>/dev/null; then
    src="$(sed -n "${ANS}p" "$WX_FILE" | cut -f2)"
    dst="$LAUNCH_DIR/$PROFILE/weixin-account.json"
    mkdir -p "$LAUNCH_DIR/$PROFILE" 2>/dev/null || true
    if [ "$src" = "$dst" ]; then
      WXFILE="$dst"
      say "✅ 微信沿用本工作区原来那份凭据。"
    elif cp "$src" "$dst" 2>/dev/null; then
      WXFILE="$dst"
      say "✅ 微信绑好了：把那份凭据拷进本工作区了（${dst}）。"
    else
      WXFILE="$src"
      say "✅ 微信绑好了：直接用原来那份凭据（${src}）。"
    fi
  elif [ "$ANS" = "$N1" ]; then
    WXLOGIN="$PROFILES/$PROFILE/node_modules/dsh-botplugin/weixin-login.mjs"
    if [ ! -f "$WXLOGIN" ]; then
      say "⚠️ 找不到扫码程序，先跳过微信（重跑 setupbot 再试）。"
      return 0
    fi
    dst="$LAUNCH_DIR/$PROFILE/weixin-account.json"
    mkdir -p "$LAUNCH_DIR/$PROFILE" 2>/dev/null || true
    command -v node >/dev/null 2>&1 || { say "⚠️ 这台机器没有 node 命令，先跳过微信。"; return 0; }
    say "这就开始扫码：用微信扫屏幕上出现的二维码，扫完这个窗口自己回来。"
    node "$WXLOGIN" --out "$dst" || { say "⚠️ 扫码没成功，先跳过微信。"; return 0; }
    WXFILE="$dst"
    say "✅ 微信绑好了（bot 重启后生效）。"
  else
    say "好，先不绑微信。"
  fi
}

# ============ 5.5 模型自检（没有模型 = 瞎子） ============
MODEL_STATUS=""

# 把 DeepSeek 的 key 存进官方凭据库（$DSH_HOME/.credentials.yaml，权限必须 600）
save_ds_key() {
  key="$1"
  f="$DSH_HOME_DIR/.credentials.yaml"
  tmp="$f.$$.tmp"
  if [ ! -f "$f" ]; then
    ( umask 077; printf 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: %s\n' "$key" > "$tmp" ) || { rm -f "$tmp"; return 1; }
    mv "$tmp" "$f" || { rm -f "$tmp"; return 1; }
    return 0
  fi
  grep -qE '^refs:[[:space:]]*$' "$f" || return 1
  cp -p "$f" "$f.bak.setupbot-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
  awk -v val="$key" '
    BEGIN { inrefs = 0; done = 0 }
    {
      if ($0 ~ /^refs:[[:space:]]*$/) { print; inrefs = 1; next }
      if (inrefs) {
        if ($0 ~ /^[^[:space:]#]/) { if (!done) { print "  DEEPSEEK_API_KEY: " val; done = 1 } inrefs = 0; print; next }
        if ($0 ~ /^[[:space:]]+DEEPSEEK_API_KEY[[:space:]]*:/) { print "  DEEPSEEK_API_KEY: " val; done = 1; next }
      }
      print
    }
    END { if (inrefs && !done) print "  DEEPSEEK_API_KEY: " val }
  ' "$f" > "$tmp" || { rm -f "$tmp"; return 1; }
  chmod 600 "$tmp" 2>/dev/null || true
  mv "$tmp" "$f" || { rm -f "$tmp"; return 1; }
  return 0
}

# 把默认模型钉到某个「非本地」档位（写进本工作区的 cordis.patch.yml）
set_default_model() {
  pp="$1"; pm="$2"
  cfg="$PROFILES/$PROFILE/cordis.patch.yml"
  mkdir -p "$PROFILES/$PROFILE" 2>/dev/null || true
  tmp="$cfg.$$.tmp"
  body=""
  if [ -s "$cfg" ]; then body="$(grep -vE '^[[:space:]]*(#|$)' "$cfg" | tr -d '[:space:]')"; fi
  if [ -z "$body" ] || [ "$body" = "[]" ]; then
    {
      grep -E '^[[:space:]]*#' "$cfg" 2>/dev/null
      printf -- '- id: agent-default-model\n  config:\n    provider: "%s"\n    model: "%s"\n' "$pp" "$pm"
    } > "$tmp" || { rm -f "$tmp"; return 1; }
    mv "$tmp" "$cfg" || { rm -f "$tmp"; return 1; }
    return 0
  fi
  if has_patch_entry agent-default-model "$cfg"; then
    set_block_key agent-default-model provider "$pp" "$cfg" || return 1
    set_block_key agent-default-model model "$pm" "$cfg" || return 1
    return 0
  fi
  {
    cat "$cfg"
    printf -- '- id: agent-default-model\n  config:\n    provider: "%s"\n    model: "%s"\n' "$pp" "$pm"
  } > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$cfg" || { rm -f "$tmp"; return 1; }
  return 0
}

# 只读自检：机器上有什么模型、默认档是不是本地那个（逻辑跟插件 hostModelTable 对齐）
write_probe_script() {
  cat > "$TMP_ROOT/model-probe.mjs" <<'PROBE_EOF'
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const home = process.argv[2];
const profile = process.argv[3];

function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  const first = lines.find((l) => l.trim() && !l.trim().startsWith('#'));
  const root = /^\s*-\s+/.test(first ?? '') ? [] : {};
  const stack = [{ indent: -1, node: root }];
  const stripComment = (s) => {
    let out = ''; let q = null;
    for (const ch of s) {
      if (q) { out += ch; if (ch === q) q = null; }
      else if (ch === '"' || ch === "'") { q = ch; out += ch; }
      else if (ch === '#') break;
      else out += ch;
    }
    return out.trimEnd();
  };
  const scalar = (raw) => {
    const v = raw.trim();
    if (v === '') return '';
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null' || v === '~') return null;
    if (/^-?\d+$/.test(v)) return Number(v);
    return v;
  };
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const line = stripComment(raw);
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    const body = line.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (body.startsWith('- ')) {
      const top = stack[stack.length - 1];
      if (top.key !== undefined && top.node && !Array.isArray(top.node) && top.parent) {
        const arr = [];
        top.parent[top.key] = arr;
        top.node = arr;
      }
      if (!Array.isArray(top.node)) continue;
      const item = body.slice(2).trim();
      const m = item.match(/^(["']?[\w.$-]+["']?):\s*(.*)$/);
      if (m) {
        const obj = {};
        const k = m[1].replace(/^["']|["']$/g, '');
        if (m[2] !== '') obj[k] = scalar(m[2]);
        top.node.push(obj);
        stack.push({ indent, node: obj });
      } else {
        top.node.push(scalar(item));
      }
      continue;
    }
    const m = body.match(/^(["']?[\w.$-]+["']?):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].replace(/^["']|["']$/g, '');
    if (m[2] === '') {
      const container = {};
      parent[key] = container;
      stack.push({ indent, node: container, key, parent });
    } else {
      parent[key] = scalar(m[2]);
    }
  }
  return root;
}

const read = (p) => { try { return existsSync(p) ? parseYaml(readFileSync(p, 'utf8')) : null; } catch { return null; } };
const cfgOf = (doc, id) => {
  if (Array.isArray(doc)) { const e = doc.find((x) => x && x.id === id); return e ? (e.config ?? null) : null; }
  if (doc && typeof doc === 'object') return doc[id] ?? null;
  return null;
};
const nonEmpty = (o) => o && typeof o === 'object' && Object.keys(o).length > 0;

const webPatch = read(join(home, 'profiles', 'web', 'cordis.patch.yml'));
const myPatch = read(join(home, 'profiles', profile, 'cordis.patch.yml'));
const settingsDocs = [
  join(home, 'profiles', profile, 'settings.yaml'),
  join(home, 'settings.yaml'),
  join(home, 'settings.yaml.imported'),
  join(home, 'profiles', 'web', 'settings.yaml'),
].map(read).filter((d) => d && typeof d === 'object');

// 跟插件一致：web 端 patch 优先，其次本 profile patch，最后才回落到 settings
let providers = cfgOf(webPatch, 'llm-pi-ai')?.providers;
if (!nonEmpty(providers)) providers = cfgOf(myPatch, 'llm-pi-ai')?.providers;
if (!nonEmpty(providers)) {
  for (const d of settingsDocs) {
    const p = d['llm-pi-ai']?.providers;
    if (nonEmpty(p)) { providers = p; break; }
  }
}

const routes = [];
for (const [pid, p] of Object.entries(nonEmpty(providers) ? providers : {})) {
  const models = Array.isArray(p?.models) ? p.models : [];
  for (const m of models) {
    if (!m || m.id === undefined) continue;
    routes.push({
      provider: pid,
      model: String(m.id),
      label: String(p.displayName ?? pid),
      baseURL: String(p.baseURL ?? ''),
      apiKeyEnv: String(p.apiKeyEnv ?? ''),
    });
  }
}

let dsModels = [];
for (const src of [cfgOf(myPatch, 'llm-deepseek'), ...settingsDocs.map((d) => d['llm-deepseek'])]) {
  if (src && Array.isArray(src.models) && src.models.length) { dsModels = src.models.map((m) => String(m.id)); break; }
}
const creds = read(join(home, '.credentials.yaml'));
const refs = (creds && typeof creds === 'object' && creds.refs) || {};
const dsKey = Boolean(refs.DEEPSEEK_API_KEY) || Boolean(process.env.DEEPSEEK_API_KEY);

let def = null;
const pd = cfgOf(myPatch, 'agent-default-model');
if (pd && pd.provider && pd.model) def = { provider: String(pd.provider), model: String(pd.model) };
if (!def) {
  for (const d of settingsDocs) {
    const s = d['agent-default-model'];
    if (s && typeof s === 'object' && s.provider && s.model) { def = { provider: String(s.provider), model: String(s.model) }; break; }
  }
}

const isLocal = (r) => /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(r.baseURL);
const defRoute = def ? routes.find((r) => r.provider === def.provider && r.model === def.model) ?? null : null;
const effective = defRoute ?? routes[0] ?? null;
const hasModels = routes.length > 0 || dsModels.length > 0 || dsKey;
const keyOk = (r) => !r.apiKeyEnv || Boolean(refs[r.apiKeyEnv]) || Boolean(process.env[r.apiKeyEnv]);
const nameDs = (r) =>
  /deepseek|深度求索|(^|[-_])ds([-_]|$)/i.test(r.provider) || /deepseek|深度求索/i.test(r.label);
const nonLocal = routes.filter((r) => !isLocal(r));
const dsBuiltin = dsKey && dsModels.length
  ? { provider: 'deepseek-official', model: dsModels[0], label: '深度求索', apiKeyEnv: 'DEEPSEEK_API_KEY' }
  : null;
// 挑一个「非本地 + key 已经存过」的档位：改默认不能改成另一个连不上的
const pick =
  nonLocal.find((r) => nameDs(r) && keyOk(r)) ??
  dsBuiltin ??
  nonLocal.find((r) => keyOk(r)) ??
  nonLocal[0] ??
  null;

const line = (k, v) => process.stdout.write(`${k}=${v}\n`);
line('hasModels', hasModels ? 1 : 0);
line('routeCount', routes.length);
line('defaultProvider', effective ? effective.provider : '');
line('defaultModel', effective ? effective.model : '');
line('defaultLabel', effective ? effective.label : '');
line('defaultIsLocal', effective && isLocal(effective) ? 1 : 0);
line('pickProvider', pick ? pick.provider : '');
line('pickModel', pick ? pick.model : '');
line('pickLabel', pick ? pick.label : '');
line('pickKeyEnv', pick ? (pick.apiKeyEnv ?? '') : '');
line('pickKeyOk', pick && keyOk(pick) ? 1 : 0);
line('dsKey', dsKey ? 1 : 0);
PROBE_EOF
}

ensure_model() {
  say ""
  command -v node >/dev/null 2>&1 || { say "⚠️ 没有 node，跳过模型自检。"; return 0; }
  write_probe_script
  PROBE="$(node "$TMP_ROOT/model-probe.mjs" "$DSH_HOME_DIR" "$PROFILE" 2>/dev/null)" || PROBE=""
  if [ -z "$PROBE" ]; then
    say "⚠️ 模型自检没跑成（不影响绑定），跳过。"
    return 0
  fi
  pget() { printf '%s\n' "$PROBE" | sed -n "s/^$1=//p" | head -1; }

  if [ "$(pget hasModels)" != "1" ]; then
    say "⚠️ 这台机器一个模型都没配 —— 没有模型的机器人收得到消息、答不上话（瞎子）。"
    ask "把 DeepSeek 的 API key 粘进来（形如 sk-...；不填直接回车 = 先跳过）："
    K="$(printf '%s' "${REPLY_V}" | tr -d '[:space:]')"
    case "$K" in
      "") say "好，先跳过模型。" ;;
      sk-*)
        if save_ds_key "$K"; then
          say "✅ 模型绑好了：DeepSeek key 已存进 ${DSH_HOME_DIR}/.credentials.yaml。"
          MODEL_STATUS="新绑了 DeepSeek key"
        else
          say "⛔ DeepSeek key 没存进去（${DSH_HOME_DIR}/.credentials.yaml 不可写或格式不对）。"
        fi ;;
      *) say "这串不像 DeepSeek 的 key（应该 sk- 开头），先跳过。" ;;
    esac
    return 0
  fi

  DP="$(pget defaultProvider)"; DM="$(pget defaultModel)"; DL="$(pget defaultLabel)"
  if [ "$(pget defaultIsLocal)" = "1" ]; then
    PP="$(pget pickProvider)"; PM="$(pget pickModel)"; PL="$(pget pickLabel)"
    say "⚠️ 现在的默认模型是本地那个：${DL}（${DP} / ${DM}）。"
    if [ -n "$PP" ] && [ -n "$PM" ]; then
      if set_default_model "$PP" "$PM"; then
        say "✅ 默认模型已改成 ${PL}（${PP} / ${PM}）—— 不再默认跑本地模型。"
        MODEL_STATUS="默认模型改成 ${PP} / ${PM}"
        PKE="$(pget pickKeyEnv)"
        if [ -n "$PKE" ] && [ "$(pget pickKeyOk)" != "1" ]; then
          say "⚠️ 这个档位的 key（${PKE}）还没存 —— 去 web 端「设置 → 模型」把它填上。"
        fi
      else
        say "⛔ 默认模型没改成功，回头去 web 端「设置 → 模型」换一个。"
      fi
    else
      say "⚠️ 这台机器上只有本地模型，没法换 —— 去 web 端「设置 → 模型」加一个云端模型。"
    fi
    return 0
  fi

  if [ -n "$DP" ] && [ -n "$DM" ]; then
    say "✅ 模型没问题：默认 ${DL}（${DP} / ${DM}）。"
  elif [ "$(pget dsKey)" = "1" ]; then
    say "✅ 模型没问题：用内置的 DeepSeek（key 已存好）。"
  else
    say "✅ 模型表里有 $(pget routeCount) 个档位可用。"
  fi
}

# ============ 配置落盘 ============
write_bot_config() {
  cfg="$PROFILES/$PROFILE/cordis.patch.yml"
  mkdir -p "$PROFILES/$PROFILE" 2>/dev/null || true
  if ! has_botplugin_block "$cfg"; then
    if [ -z "$TOKEN" ] && [ -z "$WXFILE" ] && [ -z "$BOTCWD" ]; then
      # ⚠️ 这里以前是静默 return 0：什么都没写还当成功，用户看到「全部搞定」以为绑好了（2026-09-30 撞过）
      say "⚠️ 这次没有任何绑定要写，${cfg} 没动。"
      return 0
    fi
    tmp="$cfg.$$.tmp"
    {
      if [ -s "$cfg" ]; then
        body="$(grep -vE '^[[:space:]]*(#|$)' "$cfg" | tr -d '[:space:]')"
      else
        body=""
      fi
      if [ -n "$body" ] && [ "$body" != "[]" ]; then cat "$cfg"; fi
      printf -- '- id: botplugin\n  config:\n'
      [ -n "$TOKEN" ] && printf '    telegramToken: "%s"\n' "$TOKEN"
      printf '    telegramAllowedUsers: []\n'
      [ -n "$WXFILE" ] && printf '    weixinAccountFile: "%s"\n' "$WXFILE"
      [ -n "$BOTCWD" ] && printf '    cwd: "%s"\n' "$BOTCWD"
      # ⚠️ 收尾这句不能删：上面几条 `&&` 遇到空值会返回 1，整组就被误判成「写失败」，
      #    刚写好、内容完全正确的临时文件会被下面那句删掉（2026-09-30 在已有工作区上撞过）。
      :
    } > "$tmp" || { rm -f "$tmp"; return 1; }
    mv "$tmp" "$cfg" || return 1
    return 0
  fi
  # 逐键改也必须认失败：原来用 `&&` 串联，改失败了也当没事（配置静默没落地）
  rc=0
  wrote=0
  if [ -n "$TOKEN" ];  then set_cfg_key telegramToken     "$TOKEN"  "$cfg" || rc=1; wrote=1; fi
  if [ -n "$WXFILE" ]; then set_cfg_key weixinAccountFile "$WXFILE" "$cfg" || rc=1; wrote=1; fi
  if [ -n "$BOTCWD" ]; then set_cfg_key cwd               "$BOTCWD" "$cfg" || rc=1; wrote=1; fi
  [ "$wrote" = "1" ] || say "⚠️ 这次没有任何绑定要写，${cfg} 没动。"
  return "$rc"
}

# ============ 6. 复核 + 启动器 ============
finish() {
  cfg="$PROFILES/$PROFILE/cordis.patch.yml"
  say ""
  # 只认文件里的实际内容：--dump-config 会重写 cordis.yml（不是只读），在受限环境里会假报警
  if [ -f "$cfg" ] && has_botplugin_block "$cfg"; then
    say "✅ 复核通过：插件配置已经在工作区 ${PROFILE} 里。"
  else
    say "⚠️ 复核没看到插件条目（${cfg}），把上面几行发我。"
  fi

  # 逐项复核「说绑了的是不是真写进去了」—— 光看条目存在不算数（2026-09-30 假绿过）
  if [ -n "$TOKEN" ]; then
    got="$(cfg_get "$cfg" telegramToken)"
    if [ "$got" = "$TOKEN" ]; then
      say "✅ TG 绑好了：$(mask_secret "$TOKEN")（重启 bot 后生效）"
    else
      say "⛔ TG 没写进配置（配置里现在是：$(mask_secret "$got")）—— 把上面几行发我。"
    fi
  elif [ -n "$(cfg_get "$cfg" telegramToken)" ]; then
    say "ℹ️ TG 沿用配置里原来那串：$(mask_secret "$(cfg_get "$cfg" telegramToken)")"
  else
    say "⚠️ 目前没有绑 TG。"
  fi

  if [ -n "$WXFILE" ]; then
    got="$(cfg_get "$cfg" weixinAccountFile)"
    if [ -n "$got" ]; then
      say "✅ 微信绑好了：${got}（重启 bot 后生效）"
    else
      say "⛔ 微信凭据没写进配置 —— 把上面几行发我。"
    fi
  elif [ -n "$(cfg_get "$cfg" weixinAccountFile)" ]; then
    say "ℹ️ 微信沿用配置里原来那份：$(cfg_get "$cfg" weixinAccountFile)"
  else
    say "⚠️ 目前没有绑微信。"
  fi

  if [ -n "$MODEL_STATUS" ]; then say "✅ 模型：${MODEL_STATUS}"; fi

  # 同一个 token 别在两个工作区同时开
  if [ -n "$TOKEN" ]; then
    i=0
    while IFS="$(printf '\t')" read -r pn tt; do
      if [ "$tt" = "$TOKEN" ] && [ "$pn" != "$PROFILE" ]; then
        say "⚠️ 同一个 TG token 还在工作区 ${pn} 里用着 —— 两个别同时开，会互相抢消息。"
      fi
    done < "$TOK_FILE"
  fi

  L="$LAUNCH_DIR/$PROFILE/启动-${PROFILE}.command"
  mkdir -p "$LAUNCH_DIR/$PROFILE" 2>/dev/null || true
  {
    printf '#!/bin/zsh\n'
    printf '# 双击启动「%s」工作区。此文件由 setupbot 生成，可以重复生成。\n' "$PROFILE"
    printf 'cd "$(dirname "$0")"\n'
    printf 'export DSH_HOME="%s"\n' "$DSH_HOME_DIR"
    printf 'exec "%s" --profile "%s"\n' "$DSHBIN" "$PROFILE"
  } > "$L" 2>/dev/null || L=""
  [ -n "$L" ] && chmod +x "$L" 2>/dev/null

  say ""
  say "============ 全部搞定 ============"
  say "工作区：${PROFILE}"
  if [ -n "$L" ]; then say "启动：双击 ${L}"; fi
  say "      或者敲 dsh --profile ${PROFILE}"
  if [ -n "${SELF_BIN_DIR:-}" ]; then
    say "以后重绑 TG / 微信、升级，全都只要敲：setupbot"
  else
    say "以后重绑 TG / 微信、升级，把开头那条命令再跑一遍就行。"
  fi
  say "=================================="
}

# ============ 主流程 ============
say ""
say "=================================="
say "  DSH 机器人 · 一条命令全搞定"
say "=================================="

if [ "${SETUPBOT_NO_SELF_INSTALL:-}" != "1" ]; then
  install_self
fi
ensure_dsh
pick_workspace
install_plugin
pick_token
pick_wechat
ensure_model
write_bot_config || die "配置文件没写成功（${PROFILES}/${PROFILE}/cordis.patch.yml）。把 setupbot 再跑一遍；还不行就把上面几行发我。"
finish
exit 0
