#!/bin/sh
# setupdsh — 一条命令干完：装/升级 Git、Node、DSH 本体。（不碰任何工作区、不绑 TG/微信）
# setupdsh-self-marker（别删这行：脚本靠它认出「我自己」，避免把别的文件当自己复制）
#
# 给用户的命令（第一次跑一次，之后只要敲 setupdsh）：
#   curl -fsSL https://raw.githubusercontent.com/aitcmhk-web/DSH-bot/main/setupdsh.sh | zsh
#
# 它自己会办完：
#   0) 把 setupdsh 命令装进 PATH（以后直接敲 setupdsh，可重复跑）
#   1) Git：没有就装；装了 Homebrew 且是 brew 管的那份，顺手升到最新
#   2) Node/npm：没有就装（有 brew 用 brew），装不上就告诉你怎么办
#   3) DSH 本体：没有就装，有就升到最新
#
# ⚠️ 这个脚本从今往后只管「机器上的家伙」（git/node/dsh）。
#    建工作区、装插件、绑 TG / 微信 —— 全在 setupbot 里，别搬到这儿来。
#
# 测试钩子（不写进用户文档）：
#   SETUPDSH_URL=...             脚本自身的下载地址
#   SETUPDSH_NO_SELF_INSTALL=1   不安装 setupdsh 命令
#   SETUPDSH_SKIP_UPGRADE=1      只装不升（离线 / 测试用）

set -u

# ⚠️ zsh 在函数体里会把 $0 换成函数名，必须在这一层先记住脚本自己的路径
SRC_PATH="$0"

SETUPDSH_URL="${SETUPDSH_URL:-https://raw.githubusercontent.com/aitcmhk-web/DSH-bot/main/setupdsh.sh}"
SELF_DIR="$HOME/.dsh/setupdsh"
SELF_PATH="$SELF_DIR/setupdsh.sh"
SKIP_UPGRADE="${SETUPDSH_SKIP_UPGRADE:-}"

say() { printf '%s\n' "$*"; }
die() { printf '\n⛔ %s\n' "$*" >&2; exit 1; }

# ============ 0. 把自己装成 setupdsh 命令 ============
install_self() {
  mkdir -p "$SELF_DIR" 2>/dev/null || return 0
  # 有实体脚本文件（在线下载的 / 安装包里的）就复制自己；curl|zsh 没有实体才去下载
  if [ -f "$SRC_PATH" ] && grep -q 'setupdsh-self-marker' "$SRC_PATH" 2>/dev/null; then
    cp "$SRC_PATH" "$SELF_PATH" 2>/dev/null || true
  fi
  if [ ! -s "$SELF_PATH" ]; then
    curl -fsSL "$SETUPDSH_URL" -o "$SELF_PATH.new" 2>/dev/null \
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
    printf '# setupdsh — 自动生成。每次运行先试着从网上更新自己，没网就用本地这份。\n'
    printf 'URL="%s"\n' "$SETUPDSH_URL"
    printf '%s\n' 'SELF="$HOME/.dsh/setupdsh/setupdsh.sh"'
    printf '%s\n' 'mkdir -p "$(dirname "$SELF")" 2>/dev/null'
    printf '%s\n' 'if curl -fsSL --max-time 25 "$URL" -o "$SELF.new" 2>/dev/null && [ -s "$SELF.new" ]; then'
    printf '%s\n' '  mv "$SELF.new" "$SELF"'
    printf '%s\n' 'else'
    printf '%s\n' '  rm -f "$SELF.new" 2>/dev/null'
    printf '%s\n' 'fi'
    printf '%s\n' '[ -s "$SELF" ] || { echo "⛔ setupdsh 本体不在（可能没网）。请重跑一次安装命令。"; exit 1; }'
    printf '%s\n' 'exec /bin/zsh "$SELF" "$@"'
  } > "$BIN_DIR/setupdsh" 2>/dev/null || return 0
  chmod +x "$BIN_DIR/setupdsh" 2>/dev/null || true
  SELF_BIN_DIR="$BIN_DIR"

  case ":${PATH}:" in
    *":${BIN_DIR}:"*) : ;;
    *)
      if ! grep -qF "$BIN_DIR" "$HOME/.zshrc" 2>/dev/null; then
        printf '\n# setupdsh\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$HOME/.zshrc" 2>/dev/null || true
        say "（已把 ${BIN_DIR} 写进 ~/.zshrc，新开一个终端 setupdsh 就能直接敲）"
      fi
      ;;
  esac
}

# ============ 1. Git ============
GITBIN=""
BREW=""
ensure_git() {
  BREW="$(command -v brew 2>/dev/null || true)"
  GITBIN="$(command -v git 2>/dev/null || true)"

  if [ -z "$GITBIN" ]; then
    if [ -n "$BREW" ]; then
      say "这台机器还没装 git，先用 Homebrew 装上…"
      HOMEBREW_NO_AUTO_UPDATE=1 "$BREW" install git || die "brew install git 失败了，看上面的报错。"
      GITBIN="$(command -v git 2>/dev/null || true)"
    fi
    if [ -z "$GITBIN" ]; then
      say "这台机器还没装 git。现在弹一个系统安装窗（Xcode 命令行工具）——"
      say "在弹出的窗里点「安装」，等它跑完，再跑一次 setupdsh。"
      xcode-select --install 2>/dev/null || true
      die "等你把 Xcode 命令行工具装完。"
    fi
    say "✅ git 装好了：$("$GITBIN" --version 2>/dev/null || echo "$GITBIN")"
    return 0
  fi

  say "✅ git 已有：$("$GITBIN" --version 2>/dev/null || echo "$GITBIN")"
  if [ -n "$SKIP_UPGRADE" ]; then return 0; fi
  # 只升「Homebrew 管的」那一份；macOS 自带的那份归系统更新，brew 碰不到
  if [ -n "$BREW" ] && HOMEBREW_NO_AUTO_UPDATE=1 "$BREW" list --versions git >/dev/null 2>&1; then
    OLDG="$("$GITBIN" --version 2>/dev/null || echo '?')"
    say "把 git 升到最新（Homebrew）… 现在是：$OLDG"
    if HOMEBREW_NO_AUTO_UPDATE=1 "$BREW" upgrade git >/dev/null 2>&1; then
      NEWG="$("$GITBIN" --version 2>/dev/null || echo '?')"
      if [ "$NEWG" != "$OLDG" ]; then
        say "✅ git 升好了：$OLDG → $NEWG"
      else
        say "✅ git 已是最新：$NEWG"
      fi
    else
      say "⚠️ git 没升成（可能本来就最新 / 没网），用现在这版继续：$OLDG"
    fi
  fi
}

# ============ 2. Node / npm ============
ensure_node() {
  if command -v npm >/dev/null 2>&1; then
    say "✅ Node 已有：$(node -v 2>/dev/null || echo '?')"
    return 0
  fi
  if [ -n "$BREW" ]; then
    say "这台机器还没装 Node.js，先用 Homebrew 装上…"
    HOMEBREW_NO_AUTO_UPDATE=1 "$BREW" install node || die "brew install node 失败了，看上面的报错。"
  fi
  command -v npm >/dev/null 2>&1 \
    || die "这台机器没有 Node.js。去 nodejs.org 装一个 LTS 版，再跑一次 setupdsh。"
  say "✅ Node 装好了：$(node -v 2>/dev/null || echo '?')"
}

# ============ 3. DSH 本体 ============
DSHBIN=""
# ⚠️ 取不到版本就返回空，调用处显示 `?`，绝不拿路径冒充版本号。
#    2026-10-01 用户反馈：升级那段一直静默，既不报原版本也不报新版本，看不出到底升没升。
dsh_version() {
  [ -n "${1:-}" ] || return 0
  "$1" --version 2>/dev/null | head -1 | tr -d '\r'
}
ensure_dsh() {
  DSHBIN="$(command -v dsh 2>/dev/null || true)"
  if [ -z "$DSHBIN" ]; then
    say "这台机器还没装 dsh，现在装（一两分钟）…"
    npm i -g @deepseek-ai/dsh || die "装 dsh 失败了，看上面的报错。"
  elif [ -n "$SKIP_UPGRADE" ]; then
    say "✅ dsh 已有（跳过升级）：$(dsh_version "$DSHBIN")"
    return 0
  else
    OLDV="$(dsh_version "$DSHBIN")"
    say "当前 dsh：${OLDV:-?}（${DSHBIN}）"
    say "把 dsh 升到最新…"
    if npm i -g @deepseek-ai/dsh >/dev/null 2>&1; then
      DSHBIN="$(command -v dsh 2>/dev/null || printf '%s' "$DSHBIN")"
      NEWV="$(dsh_version "$DSHBIN")"
      if [ -n "$NEWV" ] && [ "$NEWV" != "$OLDV" ]; then
        say "✅ dsh 升好了：${OLDV:-?} → $NEWV"
      else
        say "✅ dsh 已是最新：${NEWV:-${OLDV:-?}}"
      fi
    else
      say "⚠️ dsh 没升成（大概是没网），现在还是：${OLDV:-?}"
    fi
  fi
  DSHBIN="$(command -v dsh 2>/dev/null || true)"
  [ -n "$DSHBIN" ] || die "装完还是找不到 dsh 命令（可能要重开一个终端，或 npm 的全局 bin 目录不在 PATH 里）。"
  say "✅ dsh：$(dsh_version "$DSHBIN")  （${DSHBIN}）"
}

# ============ 主流程 ============
say ""
say "=================================="
say "  DSH 本体 · 安装 / 升级"
say "=================================="

if [ "${SETUPDSH_NO_SELF_INSTALL:-}" != "1" ]; then
  install_self
fi
ensure_git
ensure_node
ensure_dsh

say ""
say "============ 全部搞定 ============"
say "git ：$("$GITBIN" --version 2>/dev/null || echo '?')"
say "node：$(node -v 2>/dev/null || echo '?')"
say "dsh ：$(dsh_version "$DSHBIN")"
say ""
say "下一步：建工作区 + 绑 TG / 微信 —— 跑 setupbot"
if [ -n "${SELF_BIN_DIR:-}" ]; then
  say "（以后升级这些，直接敲：setupdsh）"
else
  say "（以后升级这些，把开头那条命令再跑一遍就行）"
fi
say "=================================="
exit 0
