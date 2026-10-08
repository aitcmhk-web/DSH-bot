#!/bin/sh
# setupdsh — 一条命令干完：装/升级 Git、Node、DSH 本体，外加已装机器人的工作区里的插件。
#           （不建工作区、不绑 TG/微信 —— 那是 setupbot 的活）
# setupdsh-self-marker（别删这行：脚本靠它认出「我自己」，避免把别的文件当自己复制）
#
# 给用户的命令（第一次跑一次，之后只要敲 setupdsh）：
#   curl -fsSL https://raw.githubusercontent.com/aitcmhk-web/DSH-bot/main/setupdsh.sh | sh
#
# 它自己会办完：
#   0) 把 setupdsh 命令装进 PATH（以后直接敲 setupdsh，可重复跑）
#   1) Git：没有就装；装了 Homebrew 且是 brew 管的那份，顺手升到最新
#   2) Node/npm：没有就装（有 brew 用 brew），装不上就告诉你怎么办
#   3) DSH 本体：没有就装，有就升到最新
#   4) 插件：凡是已装机器人的工作区，把插件一起升到最新，报「原版本 → 新版本」
#
# ⚠️ 分工（2026-10-01 用户定的）：升级是天天干的事，绑 TG / 微信一辈子跑一次。
#    → 升级（git / node / dsh / 插件）全归这儿：敲一次 setupdsh 就升完，不用再走绑定问答。
#    → 建工作区、首次装插件、重绑 TG / 微信 —— 那些归 setupbot。
#
# 测试钩子（不写进用户文档）：
#   SETUPDSH_URL=...             脚本自身的下载地址
#   SETUPDSH_NO_SELF_INSTALL=1   不安装 setupdsh 命令
#   SETUPDSH_SKIP_UPGRADE=1      只装不升（离线 / 测试用；插件也一起跳过）

set -u

# ⚠️ 别在函数里再取 $0：有的 shell（zsh）会把函数名塞给它，必须在最外层先记住脚本自己的路径
SRC_PATH="$0"

# ⚠️ 脚本自己的版本号：改了本文件就把它一起改。
#    2026-10-01 用户反馈「github 没有提示版本」——跑起来必须先报自己是谁，才看得出手上这份是新是旧。
SELF_VERSION="2026-10-02.8"

SETUPDSH_URL="${SETUPDSH_URL:-https://raw.githubusercontent.com/aitcmhk-web/DSH-bot/main/setupdsh.sh}"
SELF_DIR="$HOME/.dsh/setupdsh"
SELF_PATH="$SELF_DIR/setupdsh.sh"
SKIP_UPGRADE="${SETUPDSH_SKIP_UPGRADE:-}"

say() { printf '%s\n' "$*"; }
die() { printf '\n⛔ %s\n' "$*" >&2; exit 1; }

# ============ 0. 把自己装成 setupdsh 命令 ============
install_self() {
  mkdir -p "$SELF_DIR" 2>/dev/null || return 0
  # 有实体脚本文件（安装包里的）就复制自己；curl|sh 手上没有实体文件，从网上留一份备用。
  # ⚠️ curl|sh 这条**每次都要刷本地副本**：否则启动器一旦联不上网就退回旧脚本，
  #    用户看到的还是老行为（2026-10-01 实测：GitHub 上已是新版，本机跑出来还是旧的）。
  if [ -f "$SRC_PATH" ] && grep -q 'setupdsh-self-marker' "$SRC_PATH" 2>/dev/null; then
    cp "$SRC_PATH" "$SELF_PATH" 2>/dev/null || true
  else
    if curl -fsSL --max-time 25 "$SETUPDSH_URL" -o "$SELF_PATH.new" 2>/dev/null && [ -s "$SELF_PATH.new" ]; then
      mv "$SELF_PATH.new" "$SELF_PATH" 2>/dev/null || rm -f "$SELF_PATH.new" 2>/dev/null
    else
      rm -f "$SELF_PATH.new" 2>/dev/null
    fi
  fi
  if [ ! -s "$SELF_PATH" ]; then
    curl -fsSL --max-time 25 "$SETUPDSH_URL" -o "$SELF_PATH.new" 2>/dev/null \
      && mv "$SELF_PATH.new" "$SELF_PATH" || rm -f "$SELF_PATH.new" 2>/dev/null
  fi
  [ -s "$SELF_PATH" ] || return 0
  chmod +x "$SELF_PATH" 2>/dev/null || true

  # 版本比较：远程有新版本就覆盖本地（防止本地副本长期不更新）
  REMOTE_VER=""
  LOCAL_VER="$(grep '^SELF_VERSION=' "$SELF_PATH" 2>/dev/null | sed "s/.*\"\([^\"]*\)\".*/\1/")"
  if curl -fsSL --max-time 25 "$SETUPDSH_URL" -o "$SELF_PATH.new" 2>/dev/null && [ -s "$SELF_PATH.new" ]; then
    REMOTE_VER="$(grep '^SELF_VERSION=' "$SELF_PATH.new" 2>/dev/null | sed "s/.*\"\([^\"]*\)\".*/\1/")"
    if [ -n "$REMOTE_VER" ] && [ -n "$LOCAL_VER" ] && [ "$REMOTE_VER" != "$LOCAL_VER" ]; then
      say "（setupdsh 有新版本：${LOCAL_VER} → ${REMOTE_VER}，正在更新）"
      mv "$SELF_PATH.new" "$SELF_PATH" 2>/dev/null || rm -f "$SELF_PATH.new" 2>/dev/null
    else
      rm -f "$SELF_PATH.new" 2>/dev/null
    fi
  fi

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
    printf '#!/bin/sh\n'
    printf '# setupdsh — 自动生成。每次运行先试着从网上更新自己，没网就用本地这份。\n'
    printf 'URL="%s"\n' "$SETUPDSH_URL"
    printf '%s\n' 'SELF="$HOME/.dsh/setupdsh/setupdsh.sh"'
    printf '%s\n' 'mkdir -p "$(dirname "$SELF")" 2>/dev/null'
    printf '%s\n' 'if curl -fsSL --max-time 25 "$URL" -o "$SELF.new" 2>/dev/null && [ -s "$SELF.new" ]; then'
    printf '%s\n' '  mv "$SELF.new" "$SELF"'
    printf '%s\n' 'else'
    printf '%s\n' '  rm -f "$SELF.new" 2>/dev/null'
    printf '%s\n' '  echo "（这次没联上更新服务器，用本机存的那份 setupdsh 跑）"'
    printf '%s\n' 'fi'
    printf '%s\n' '[ -s "$SELF" ] || { echo "⛔ setupdsh 本体不在（可能没网）。请重跑一次安装命令。"; exit 1; }'
    printf '%s\n' 'exec /bin/sh "$SELF" "$@"'
  } > "$BIN_DIR/setupdsh" 2>/dev/null || return 0
  chmod +x "$BIN_DIR/setupdsh" 2>/dev/null || true
  SELF_BIN_DIR="$BIN_DIR"

  case ":${PATH}:" in
    *":${BIN_DIR}:"*) : ;;
    *)
      # ⚠️ 以前只写 ~/.zshrc —— 没装 zsh 的机器（多数 Linux 服务器）等于没写，
      #    还会凭空造出一个 ~/.zshrc。现在只往**已经存在**的登录 rc 里加，不新建文件、不动别的配置。
      ADDED_RC=""
      for RC in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
        [ -f "$RC" ] || continue
        grep -qF "$BIN_DIR" "$RC" 2>/dev/null && continue
        printf '\n# setupdsh\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$RC" 2>/dev/null || continue
        ADDED_RC="${ADDED_RC} ${RC}"
      done
      if [ -n "$ADDED_RC" ]; then
        say "（已把 ${BIN_DIR} 写进${ADDED_RC}，新开一个终端 setupdsh 就能直接敲）"
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

# ============ 4. 插件（已装机器人的工作区，一起升） ============
# ⚠️ 分工（2026-10-01 用户指出）：升级是频繁动作，绑 TG / 微信用的少。
#    所以插件升级放在这儿 —— 敲一次 setupdsh 就连插件一起升，不必再走绑定那套问答。
#    建工作区 / 首次装插件 / 重绑，仍然在 setupbot 里。
# ⚠️ 这里写死的 tag 必须是**本次发布自己的 tag**（发新版本时同步改，别漏）。
#    走 TG 菜单那条路会先上网拉最新这份脚本再跑，所以实际生效的永远是网上最新的 tag；
#    没网时才退回包里这份 —— 那时它也只能装这个 tag。
SPEC="${BOTPLUGIN_SPEC:-github:aitcmhk-web/DSH-bot#v1.0.48}"
# ⚠️ 版本号只从装好的插件里读（package.json 是唯一版本源）；读不到就返回空、显示「?」，
#    ⛔ 绝不拿日期或路径冒充版本号（2026-10-01 用户骂过）。
plugin_version() {
  [ -n "${1:-}" ] || return 0
  [ -f "$1/package.json" ] || return 0
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/package.json" | head -1
}
upgrade_plugins() {
  [ -n "${DSHBIN:-}" ] || return 0
  if [ -n "${SKIP_UPGRADE:-}" ]; then
    say ""
    say "（跳过了插件升级：SETUPDSH_SKIP_UPGRADE=1）"
    return 0
  fi
  # ⚠️ 不能用 `for X in $(find …)`：路径里有空格会被拆开，多行结果还会被当成一个路径，
  #    多个工作区时静默出错。改成 while read 逐行读，sh / zsh 都稳。
  PLUGLIST="$(find "${DSH_HOME:-$HOME/.dsh}/profiles" -maxdepth 4 \( -type d -o -type l \) -name dsh-botplugin 2>/dev/null || true)"
  if [ -z "$PLUGLIST" ]; then
    say ""
    say "这台机器还没装过机器人插件（第一次要在工作区里装，跑 setupbot），这一步跳过。"
    return 0
  fi
  say ""
  say "把已经装了机器人的工作区里的插件，一起升到最新…"
  # ⚠️ 用临时文件 + `while read`，不用管道：管道会把循环扔进子 shell，
  #    里面记的 PLUG_CHANGED 传不出来，收尾就会在「一个插件都没升」时也提示重启。
  PLUG_CHANGED=0
  PLUGLIST_FILE="${TMPDIR:-/tmp}/setupdsh-pluglist.$$"
  if ! printf '%s\n' "$PLUGLIST" > "$PLUGLIST_FILE" 2>/dev/null; then
    say "⚠️ 临时文件写不进去（${PLUGLIST_FILE}），插件升级这一步跳过。"
    return 0
  fi
  while IFS= read -r PD; do
    [ -n "$PD" ] || continue
    PROF="$(basename "$(dirname "$(dirname "$PD")")")"
    OLDV="$(plugin_version "$PD")"
    # 先更新 package.json 里的依赖声明为最新 tag（否则 pnpm 看到同 tag 就报 Already up to date）
    PKG_JSON="$PD/package.json"
    if [ -f "$PKG_JSON" ]; then
      NEWTAG="${SPEC#*#}"
      if printf '%s' "$NEWTAG" | grep -q '^v[0-9]'; then
        # ⚠️ 不用 `sed -i ''`：那是 macOS 专用写法，Linux 的 GNU sed 会报错，被 `|| true` 吞掉后
        #    依赖声明其实没改。改成「写临时文件再 mv」，两个系统都能真正改到。
        sed "s|github:aitcmhk-web/DSH-bot#[^\"[:space:]]*|github:aitcmhk-web/DSH-bot#${NEWTAG}|g" "$PKG_JSON" >"${PKG_JSON}.setupdsh-tmp" 2>/dev/null \
          && mv "${PKG_JSON}.setupdsh-tmp" "$PKG_JSON" \
          || rm -f "${PKG_JSON}.setupdsh-tmp"
      fi
    fi
    # pnpm lockfile 会让同仓库的 add 报 "Already up to date"；先删掉让它重新解析。
    LOCKFILE="$PD/pnpm-lock.yaml"
    if [ -f "$LOCKFILE" ]; then mv "$LOCKFILE" "${LOCKFILE}.setupdsh-bak"; fi
    if ( cd "$HOME" && "$DSHBIN" plugin --profile "$PROF" add "$SPEC" ); then
      NEWV="$(plugin_version "$PD")"
      if [ -n "$NEWV" ] && [ "$NEWV" != "$OLDV" ]; then
        say "✅ 工作区 ${PROF} 的插件：${OLDV:-?} → ${NEWV}"
        PLUG_CHANGED=1
      else
        say "✅ 工作区 ${PROF} 的插件：${NEWV:-${OLDV:-?}}（没有变化）"
      fi
    else
      say "⚠️ 工作区 ${PROF} 的插件没升成（大概是没网），现在还是：${OLDV:-?}"
    fi
    # 升级插件时删掉 lockfile 让它重新解析，⛔ 不恢复——否则旧 lockfile 会把版本锁死在老 commit。
    if [ -f "${LOCKFILE}.setupdsh-bak" ]; then mv "${LOCKFILE}.setupdsh-bak" "$LOCKFILE"; fi
  done < "$PLUGLIST_FILE"
  rm -f "$PLUGLIST_FILE" 2>/dev/null || true
}

# ensure_hardrules_block — 给缺「最高指令」块的 profile 幂等补挂 file:// v2 插件。
# 背景（2026-10-08 老板令收口双挂载）：npm 包内 hard-rules.js v1 已随 v1.0.42 退役，
# 全机权威源 = /Users/tcm/DSH/hard-rules/index.mjs（v2，含教训注入），由各 profile 的
# cordis.patch.yml 以 file:// 挂载。缺块的 profile 补上，已有的原样不动（幂等）；
# 改前逐份备份，临时文件 + mv 原子替换（bot 运行时 HMR 会热重载 patch，不能留中间态）。
# ⚠️ sync-from-web.mjs 只重写 llm 托管块、其余原样搬运（2026-10-08 #37 修复后），补的块不会被冲。
HARD_RULES_MARK='id: hard-rules'
ensure_hardrules_block() {
  HARD_BLOCK='
# ── 最高指令：每次动手类工具（bash/edit/write）跑完，把规则原文重新顶进上下文 ──
#    实现 /Users/tcm/DSH/hard-rules/index.mjs，规则 /Users/tcm/DSH/BOT/HARD-RULES.md
#    本块由 setupdsh.sh 幂等补挂（2026-10-08 v1.0.42 收口）；sync-from-web.mjs 不托管它。
- insert:
    - id: hard-rules
      name: "file:///Users/tcm/DSH/hard-rules/index.mjs"
'
  PATCHLIST="$(find "${DSH_HOME:-$HOME/.dsh}/profiles" -maxdepth 2 -name cordis.patch.yml 2>/dev/null || true)"
  [ -n "$PATCHLIST" ] || return 0
  PATCHLIST_FILE="${TMPDIR:-/tmp}/setupdsh-patchlist.$$"
  printf '%s\n' "$PATCHLIST" > "$PATCHLIST_FILE" 2>/dev/null || return 0
  while IFS= read -r PF; do
    [ -n "$PF" ] || continue
    if grep -q "$HARD_RULES_MARK" "$PF" 2>/dev/null; then continue; fi
    STAMP="$(date +%Y%m%d-%H%M%S)"
    cp "$PF" "${PF}.bak-hardrules-${STAMP}" || { say "⚠️ ${PF} 备份失败，跳过补挂"; continue; }
    if cp "$PF" "${PF}.setupdsh-tmp" && printf '%s\n' "$HARD_BLOCK" >> "${PF}.setupdsh-tmp" && mv "${PF}.setupdsh-tmp" "$PF"; then
      say "✅ 最高指令块已补挂：$(basename "$(dirname "$PF")")（备份 ${PF}.bak-hardrules-${STAMP}）"
    else
      rm -f "${PF}.setupdsh-tmp" 2>/dev/null || true
      say "⚠️ ${PF} 补挂失败（保留原文件），可重跑本脚本重试"
    fi
  done < "$PATCHLIST_FILE"
  rm -f "$PATCHLIST_FILE" 2>/dev/null || true
}

# ============ 主流程 ============
say ""
say "=================================="
say "  DSH 本体 · 安装 / 升级"
say "=================================="
say "setupdsh 版本：${SELF_VERSION}"

if [ "${SETUPDSH_NO_SELF_INSTALL:-}" != "1" ]; then
  install_self
fi
ensure_git
ensure_node
ensure_dsh
upgrade_plugins
ensure_hardrules_block

say ""
say "============ 机器环境安装完成 ============"
say "git ：$("$GITBIN" --version 2>/dev/null || echo '?')"
say "node：$(node -v 2>/dev/null || echo '?')"
say "dsh ：$(dsh_version "$DSHBIN")"
say ""
if [ "${PLUG_CHANGED:-0}" = "1" ]; then
  say "插件升完了：要重启一次机器人才生效 —— 双击工作区里的 restart.command"
fi
say "建工作区 / 换 TG / 换微信 —— 跑 setupbot"
if [ -n "${SELF_BIN_DIR:-}" ]; then
  say "（以后升级这些，直接敲：setupdsh）"
else
  say "（以后升级这些，把开头那条命令再跑一遍就行）"
fi
say "=================================="
exit 0
