#!/bin/bash
# bot.sh —— BOT 项目的启停脚本（独立项目，支持 launchd 开机自启）。
#
# ⚠️ 本脚本只操作 /Users/tcm/DSH/BOT，**绝不触碰 /Users/tcm/DSH/TG**。
#    TG 已完工封存，两者是互相独立、互不引用的项目。
#
# 与 tg.sh 的关系：借鉴其经验（pidfile + .bot.lock + 自动解析 dsh 绝对路径），
# 但是**独立实现**，不 source、不调用 tg.sh。
#
# ⚠️ 2026-09-19 变更：**BOT 已加 launchd 开机自启**（用户改定 A 方案）。
#    此前"纯手动、无自启"的旧决定已作废。现在两条启动路径并存：
#      · 手动   → ./bot.sh start（后台，双击 BOT/启动.command）
#      · 自动   → launchd 调 ./bot.sh daemon（前台，plist: com.local.dsbot）
#    两者靠 .bot.lock + daemon 的"让位 exit 0"互斥，不会起两个实例。
#
# 用法:
#   ./bot.sh start     后台启动
#   ./bot.sh stop      停止（pidfile + kill -0 判定，不依赖 pgrep）
#   ./bot.sh restart   重启
#   ./bot.sh status    查看状态
#   ./bot.sh run       前台运行（完整报错，排错用）
#   ./bot.sh daemon    launchd 前台模式（开机自启用，别手敲）
#   ./bot.sh logs      跟踪日志

set -uo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # = /Users/tcm/DSH/BOT

# --- 多开实例（2026-10-06）--------------------------------------------------
# 用法：./bot.sh -n <名字> start   （等价 BOT_INSTANCE=<名字> ./bot.sh start）
#   · 不带 -n = 主实例，行为与从前完全一致（pid/log/锁的文件名都不变）；
#   · 带 -n 时所有文件带 -<名字> 后缀，并给 bot.js 传 BOT_INSTANCE=名字；
#   · bot.js 侧的同名后缀见 bot.js「多开实例」段 —— 两边名字必须一致，别单边改；
#   · 配置文件 = .env.<名字>（模板见 .env.instance.example），必须有自己的 token；
#   · daemon（launchd）只伺候主实例；实例要开机自启得另配 plist，别走这个口。
INST_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--name)
      [ $# -ge 2 ] || { echo "❌ $1 后面要跟实例名"; exit 1; }
      INST_NAME="$2"; shift 2 ;;
    -n=*|--name=*) INST_NAME="${1#*=}"; shift ;;
    *) break ;;
  esac
done
case "$INST_NAME" in
  *[!A-Za-z0-9_-]*) echo "❌ 实例名只能含字母/数字/_/-：$INST_NAME"; exit 1 ;;
esac
if [ -n "$INST_NAME" ]; then
  SUFFIX="-${INST_NAME}"
  export BOT_INSTANCE="$INST_NAME"
else
  SUFFIX=""
fi

PID_FILE="$APP/bot${SUFFIX}.pid"
LOG_FILE="$APP/bot${SUFFIX}.log"
LOCK_DIR="$APP/.bot.lock${SUFFIX}"
SELF="./$(basename "${BASH_SOURCE[0]}")${SUFFIX:+ -n $INST_NAME}"

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_DIM=$'\033[2m'
else
  C_RESET=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_DIM=''
fi
ok()   { printf '%s%s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
bad()  { printf '%s%s%s\n' "$C_RED" "$*" "$C_RESET"; }
warn() { printf '%s%s%s\n' "$C_YELLOW" "$*" "$C_RESET"; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }

# --- 进程判定 --------------------------------------------------------------
# ⚠️ 本机 pgrep 看不见 launchd 拉起的 bot 进程（tg.sh 里实测记录过）。
#    唯一可靠判据 = pidfile + kill -0。

# 从 pidfile / 锁里取 pid（优先 PID_FILE，回落 .bot.lock/pid）。
current_pid() {
  local p=""
  [ -f "$PID_FILE" ] && p="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "$p" ] && [ -f "$LOCK_DIR/pid" ]; then
    p="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  fi
  printf '%s' "$p"
}

# 进程是否活着。注意还要确认它确实是**本目录**的 bot.js，避免误判/误杀。
#
# 🚨 2026-09-19 修「status 误报未运行」：
#    原实现只做 `kill -0 <pidfile 里的 pid>`，**从不核对这个 pid 是不是本目录的 bot.js**
#    —— 尽管上面的注释早就写了「还要确认它确实是本目录的 bot.js」，代码却没做。
#    实测翻车：17:01 有个进程（pid 36386）启动后失败退出，但它已经把 pid 写进了
#    .bot.lock/pid；而真正在服务的是更早启动的 32288（从 16:12 就在跑）。
#    于是 status 读到 36386 → `kill -0` 失败 → 报「⏹ 未运行」，
#    **而 bot 其实活得好好的、微信回合一直在正常完成**。
#    这个假阴性直接把我带偏、去查了根本不存在的「幽灵进程抢通道」。
#
#    ✅ 判据必须是「pid 活着」**且**「该 pid 的 cwd == 本目录」。
#       取不到 cwd 时（权限等）不武断判死，退回认为是活的（宁可误报活，不可误报死）。
running() {
  local p; p="$(current_pid)"
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  # 核对 cwd：pidfile 可能是**已死进程留下的残骸**，而真身是另一个 pid。
  local pcwd=""
  pcwd="$(lsof -a -d cwd -p "$p" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)"
  if [ -n "$pcwd" ] && [ "$pcwd" != "$APP" ]; then
    return 1
  fi
  return 0
}

# 找出**真实**在跑的本目录 bot.js（用于 status 显示 / 纠正残骸 pidfile）。
# 与 running() 互补：running() 判「pidfile 说的那个还在不在」，
# 本函数答「到底有没有人在服务」。两者不一致 = pidfile 是残骸。
#
# ⚠️ 2026-09-19 实测：**不能用 `pgrep -f 'bot\.js'` 当候选来源**。
#    本机 pgrep 对 node 进程严重漏报 —— 真身在跑的 32288 完全扫不到，
#    却扫到了 TG 的 25721（假阴性 + 假阳性同时发生，AGENTS.md 早就记过
#    「本机 pgrep 漏报运行中 bot」）。凡以 pgrep 为唯一判据必然翻车。
#    ✅ 改为**从 lsof 反查**：直接问「哪些 node 进程的 cwd 是本目录」，
#       这是唯一既准确又不依赖 pgrep 的办法（实测能稳定拿到 32288）。
#
# 🚨 2026-10-07 #5 打回重修（实例归属）：旧法两处翻车——
#    ① -n 校验查 `ps -o command=`（argv）里含 BOT_INSTANCE=<名字>：**死代码**，
#       BOT_INSTANCE 是环境变量（bot.sh:51 export）、spawn 是纯 `node bot.js`，
#       argv 里永远没有 → -n 的残骸让位分支永不生效，双开全靠 bot.js 锁兜底；
#    ② 主模式按 cwd 认回的第一个候选可能是**小工** —— 主 bot 死、小工活时，
#       主 daemon 错误让位、launchd 永不重拉 → 主 bot 躺死（同款 bug 反方向）。
#    ✅ 新法 = **纯文件判据**（不依赖 argv/环境变量读取）：
#       每个实例的「活记录」都落盘 —— bot.sh 侧 bot[SUFFIX].pid + .bot.lock[SUFFIX]/pid，
#       bot.js 侧 .bot.pid[SUFFIX]。候选 pid 出现在**别人**的活记录里 → 是别人的
#       实例，跳过（双向防误认）；-n 模式还要求候选在**自己**的活记录里
#       （pidfile 残骸时锁 pid 仍是活的 —— current_pid() 的回落顺序同款依据）；
#       主模式接受「无任何记录」的裸候选（= 没登记过的主实例，同旧版行为）。
#       副作用顺带修好：cmd_status 主模式从此不会把小工认成主 bot。

# 候选 pid 是否出现在给定文件里（$@ 可含 glob，无匹配自动跳过）
_pid_in_record_files() {
  local pid="$1"; shift
  local pat f p
  for pat in "$@"; do
    for f in $pat; do
      [ -f "$f" ] || continue
      p="$(cat "$f" 2>/dev/null || true)"
      if [ "$p" = "$pid" ]; then return 0; fi
    done
  done
  return 1
}

# 候选 pid 是否属于**别的**实例（主↔小工互斥的关键）：
#   小工记录 = bot-*.pid / .bot.lock-*/pid / .bot.pid-*（剔除自己的三件）
#   主实例记录 = bot.pid / .bot.lock/pid / .bot.pid（仅 -n 模式需要排除主）
_pid_claimed_by_other_instance() {
  local pid="$1" pat f p
  local my1="$APP/bot${SUFFIX}.pid" my2="$LOCK_DIR/pid" my3="$APP/.bot.pid${SUFFIX}"
  for pat in "$APP"/bot-*.pid "$APP"/.bot.lock-*/pid "$APP"/.bot.pid-*; do
    for f in $pat; do
      [ -f "$f" ] || continue
      [ "$f" = "$my1" ] && continue
      [ "$f" = "$my2" ] && continue
      [ "$f" = "$my3" ] && continue
      p="$(cat "$f" 2>/dev/null || true)"
      if [ "$p" = "$pid" ]; then return 0; fi
    done
  done
  if [ -n "$INST_NAME" ]; then
    for f in "$APP/bot.pid" "$APP/.bot.lock/pid" "$APP/.bot.pid"; do
      [ -f "$f" ] || continue
      p="$(cat "$f" 2>/dev/null || true)"
      if [ "$p" = "$pid" ]; then return 0; fi
    done
  fi
  return 1
}

find_live_bot_pid() {
  local line p cwd tmp ret argv
  tmp="$(mktemp "${TMPDIR:-/tmp}/botsh-find.XXXXXX")" || return 1
  lsof -a -d cwd -c node -Fn >"$tmp" 2>/dev/null || true
  ret=1
  while IFS= read -r line; do
    case "$line" in
      p*) p="${line#p}" ;;
      n*)
        cwd="${line#n}"
        # cwd 命中本目录 → 疑似在跑的本项目进程
        if [ "$cwd" = "$APP" ] && [ -n "$p" ] && [ "$p" != "$$" ]; then
          # 别人的实例 → 跳过（-n 不认主/兄弟，主不认小工）
          if _pid_claimed_by_other_instance "$p"; then continue; fi
          # 🚨 2026-10-07 修（小工占位主 bot）：
          #   小工 bot.js 会 spawn 出 `dsh --profile bot-00Xbot` 子进程，
          #   它的 cwd 同样是 BOT、又不在任何记录档里 → 被主模式当"裸候选"认领，
          #   主 daemon 于是错误让位、launchd 永不重拉 → 主 bot 躺死。
          #   ✅ 判据：主实例真身 argv 必为 `node .../bot.js`，
          #      argv 含 --profile（= dsh 进程，无论主/小工）一律不是 bot 本体，跳过。
          argv="$(ps -o command= -p "$p" 2>/dev/null || true)"
          case "$argv" in
            *--profile*) continue ;;
          esac
          case "$argv" in
            *bot.js*) ;;
            *) continue ;;
          esac
          # 🚨 第二道鎖（2026-10-07，macOS `ps eww` 实测可读别的进程 env）：
          #   小工 bot.js 带 BOT_INSTANCE=<名字>；主 bot 该变量为空。
          #   主模式：必须无 BOT_INSTANCE；-n 模式：必须等于自己名字。
          #   两道锁互补（argv 看形态，env 看身份），任一条不符就跳过。
          local be
          be="$(ps eww -p "$p" 2>/dev/null | tail -1 | tr ' ' '\n' | sed -n 's/^BOT_INSTANCE=//p' | head -1)"
          if [ -n "$INST_NAME" ]; then
            [ "$be" = "$INST_NAME" ] || continue
          else
            [ -z "$be" ] || continue
          fi
          if [ -n "$INST_NAME" ]; then
            # -n 模式：只认自己名下的活记录（锁/pidfile）
            if _pid_in_record_files "$p" "$APP/bot${SUFFIX}.pid" "$LOCK_DIR/pid" "$APP/.bot.pid${SUFFIX}"; then
              printf '%s' "$p"; ret=0; break
            fi
          else
            # 主模式：确认是 bot.js 本体、又不是任何命名实例 → 当主实例兜底
            printf '%s' "$p"; ret=0; break
          fi
        fi
        ;;
    esac
  done <"$tmp"
  rm -f "$tmp"
  return $ret
}

# --- 工具解析（借鉴 tg.sh:199-221 的经验） ---------------------------------
# Finder 双击 / 干净 PATH 下 `command -v dsh` 会落空，回落到 npx 缓存。
# ⚠️ 不写死路径：npx 缓存目录名是哈希，清理/重建后会变。
NODE_BIN=""
DSH_BIN_RESOLVED=""

# 从 Web 端设置（~/.dsh/settings.yaml）同步模型档位到 web-models.json。
# ⚠️ 刻意**不阻断启动**：同步失败只警告，沿用上次生成的文件（BOT 照常能起）。
#    理由：Web 端配置文件被改坏时，不该连带把 bot 也弄得起不来。
sync_models_from_web() {
  local script="$APP/sync-from-web.mjs"
  [ -f "$script" ] || { dim "(未找到 sync-from-web.mjs，跳过模型同步)"; return 0; }
  [ -n "$NODE_BIN" ] || { dim "(没有 node，跳过模型同步)"; return 0; }
  local out
  if out="$("$NODE_BIN" "$script" 2>&1)"; then
    echo "$out" | while IFS= read -r line; do dim "  $line"; done
  else
    warn "⚠️  模型档位同步失败（沿用上次的 web-models.json）:"
    echo "$out" | while IFS= read -r line; do dim "  $line"; done
  fi
}

# 识图能力自动探测（用户 2026-09-28 定的方案）：
#   假设所有模型都识图（defaultInput），启动前真发一张测试图逐个验证，
#   不支持的自动标记 input: [text]。⚠️ 刻意**不阻断启动**（与上面同一哲学）：
#   无网/超时/脚本挂了都只警告，bot 照常起。
sync_vision_autodetect() {
  local script="$APP/vision-auto.mjs"
  [ -f "$script" ] || { dim "(未找到 vision-auto.mjs，跳过识图探测)"; return 0; }
  [ -n "$NODE_BIN" ] || { dim "(没有 node，跳过识图探测)"; return 0; }
  local out
  if out="$("$NODE_BIN" "$script" --quiet 2>&1)"; then
    [ -n "$out" ] && echo "$out" | while IFS= read -r line; do dim "  $line"; done
  else
    warn "⚠️  识图探测失败（不影响启动）:"
    echo "$out" | while IFS= read -r line; do dim "  $line"; done
  fi
}

resolve_tools() {
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  DSH_BIN_RESOLVED="$(command -v dsh 2>/dev/null || true)"
  if [ -z "$NODE_BIN" ]; then
    local c
    for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
      [ -x "$c" ] && { NODE_BIN="$c"; break; }
    done
  fi
  if [ -z "$DSH_BIN_RESOLVED" ]; then
    local c
    for c in "$HOME"/.npm/_npx/*/node_modules/.bin/dsh; do
      [ -x "$c" ] && { DSH_BIN_RESOLVED="$c"; break; }
    done
  fi
}

# --- 锁（简单互斥，防两个 start 同时跑） -----------------------------------
lock_acquire() {
  if [ -f "$LOCK_DIR/pid" ]; then
    local old; old="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
      LOCK_HOLDER="$old"
      return 1
    fi
  fi
  mkdir -p "$LOCK_DIR"
  printf '%s' "$$" > "$LOCK_DIR/pid"
  printf '%s' "${1:-manual}" > "$LOCK_DIR/mode"
  return 0
}
lock_release() { rm -rf "$LOCK_DIR"; }

# --- 命令 ------------------------------------------------------------------

cmd_start() {
  if running; then
    warn "已经在跑 (PID $(current_pid))，不重复启动。"
    return 0
  fi

  resolve_tools
  if [ -z "$NODE_BIN" ]; then
    bad "❌ 找不到 node"; return 1
  fi
  if [ -z "$DSH_BIN_RESOLVED" ]; then
    bad "❌ 找不到 dsh 可执行文件"
    dim "  先确认能在 npx 缓存里找到，或把完整路径写进 .env 的 HARNESS_BIN="
    return 1
  fi

  if ! lock_acquire manual; then
    warn "另一个启动流程正在跑 (PID ${LOCK_HOLDER:-?})，没有重复启动。"
    return 1
  fi

  cd "$APP" || { lock_release; return 1; }

  # ⚠️ 关键：把解析到的 dsh 路径经 HARNESS_BIN 传给子进程。
  #    env.js:30 —— 真实环境变量优先于 .env，所以这里 export 会覆盖 .env 里的 "dsh"。
  #    PATH 里没有 dsh 时，这是唯一能让 dsh.js 的 spawn('dsh') 成功的办法。
  local display="$DSH_BIN_RESOLVED"
  if command -v dsh >/dev/null 2>&1; then
    dim "(PATH 里已有 dsh,仍固定用 $display)"
  else
    dim "(PATH 里没有 dsh,自动改用 $display)"
  fi
  export HARNESS_BIN="$DSH_BIN_RESOLVED"

  # ── 模型档位自动同步（用户 2026-09-19 定死：模型只有一份，在 Web 端改）────────
  # 从 ~/.dsh/settings.yaml（Web 端「设置 → 模型」写的）生成 web-models.json，
  # models.js 启动时读它当菜单。放在这里而不是 bot.js 里：无需把 YAML 解析塞进主进程，
  # 且同步失败**不阻断启动**（保留上次生成的档位，只是菜单可能旧一点）。
  sync_models_from_web
  sync_vision_autodetect

  nohup "$NODE_BIN" bot.js >>"$LOG_FILE" 2>&1 &
  local pid=$!

  # ⚠️ 2026-09-19：pidfile / 锁**不再由这里写** —— bot.js 登录成功后会自己认领
  #    （bot.js#claimInstanceLock）。原因：/restart 走的是 restart-helper.sh 而非本脚本，
  #    老代码只有这里写锁 → /restart 之后锁里永远是被杀掉的旧 pid（本次实测：
  #    锁=22128 已死、真在跑的是 5913，于是 status 误报未运行、stop 杀不到）。
  #    让进程自己登记 = 无论从哪条路径拉起都必然是真 pid。
  #    这里只**等它认领**，认领不到就报错退出（不再遗留一个假锁）。
  local waited=0
  while [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
    [ -f "$LOCK_DIR/pid" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$pid" ] && break
  done

  if running && [ "$(current_pid)" = "$pid" ]; then
    ok "✅ 已启动 (PID $pid)"
    dim "  日志: $SELF logs"
    dim "  停止: $SELF stop"
    return 0
  fi

  if kill -0 "$pid" 2>/dev/null; then
    # 进程还在但没认领锁（多半还在连 Telegram）——不当失败处理。
    warn "⚠️ 进程 $pid 已起但尚未认领实例锁（可能还在连接 Telegram）。"
    dim "  稍后用 $SELF status 确认；日志: $SELF logs"
    return 0
  fi

  bad "❌ 启动失败，最后 25 行日志:"
  echo
  tail -n 25 "$LOG_FILE" 2>/dev/null || echo "(没有日志)"
  rm -f "$PID_FILE"
  lock_release
  return 1
}

cmd_stop() {
  if ! running; then
    # 进程不在，但可能有残留文件
    rm -f "$PID_FILE"; rm -rf "$LOCK_DIR"
    warn "当前没有在跑。"
    return 0
  fi

  local p; p="$(current_pid)"
  dim "停止 PID $p ..."
  kill "$p" 2>/dev/null

  local i
  for i in $(seq 1 12); do
    kill -0 "$p" 2>/dev/null || break
    sleep 1
  done

  if kill -0 "$p" 2>/dev/null; then
    warn "未退出，发 SIGKILL"
    kill -9 "$p" 2>/dev/null
    sleep 1
  fi

  rm -f "$PID_FILE"; rm -rf "$LOCK_DIR"
  ok "✅ 已停止。"
}

cmd_status() {
  if running; then
    local p; p="$(current_pid)"
    ok "✅ 运行中 (PID $p)"
    dim "  目录: $APP"
    [ -f "$LOCK_DIR/mode" ] && dim "  模式: $(cat "$LOCK_DIR/mode" 2>/dev/null)"
    dim "  日志: $LOG_FILE"
    return 0
  fi

  # pidfile 说的那个不在了 —— 但**不代表真没人服务**。
  # ⚠️ 2026-09-19：pidfile 可能是已死进程留下的残骸（实测锁里写 36386[死]，
  #    真身在跑的是 32288）。这里必须再扫一次真实进程，否则会误报「未运行」。
  # ⚠️ 2026-10-06 多开：按 cwd 反查只能认出「本目录的某个 bot」，分不清是哪个实例
  #    （多实例 cwd 都是 APP）—— 所以这层兜底只给主实例用，命名实例只认自己的锁。
  if [ -z "$SUFFIX" ]; then
    local live; live="$(find_live_bot_pid || true)"
    if [ -n "$live" ]; then
      warn "⚠️  运行中 (PID $live) —— 但 pidfile 是残骸: $(current_pid)"
      dim "  pidfile 与实际进程不一致，已按实际进程判定为【运行中】"
      dim "  下次 $SELF stop/restart 会一并清理残骸"
      dim "  目录: $APP"
      dim "  日志: $LOG_FILE"
      return 0
    fi
  fi

  warn "⏹  未运行"
  [ -f "$PID_FILE" ] && dim "  (有残留 pidfile: $(cat "$PID_FILE" 2>/dev/null) —— 用 $SELF stop 清理)"
  return 1
}

cmd_run() {
  resolve_tools
  [ -z "$NODE_BIN" ] && { bad "❌ 找不到 node"; return 1; }
  [ -z "$DSH_BIN_RESOLVED" ] && { bad "❌ 找不到 dsh"; return 1; }
  cd "$APP" || return 1
  export HARNESS_BIN="$DSH_BIN_RESOLVED"
  dim "前台运行 (Ctrl-C 退出)，HARNESS_BIN=$HARNESS_BIN"
  exec "$NODE_BIN" bot.js
}

# --- launchd 前台模式（2026-09-19 新增，用户定 A 方案：BOT 也要开机自启）-----
#
# 与 tg.sh daemon 同构，语义刻意保持一致：
#   · 由 launchd 拉起，**前台运行**（不 nohup），退出码交给 launchd 判断
#   · 已有实例在跑 → 打印一行并 **exit 0 主动让位**
#     （配合 plist 的 KeepAlive.SuccessfulExit=false，让位不会被反复重拉）
#   · 手动 ./bot.sh stop 是 SIGTERM → bot.js 自己 exit 0 → 同样不会被拽起来
#
# ⚠️ 绝不能在这里 nohup 成后台 —— 那样 bot.js 会脱离 launchd 看管的进程，
#    launchd 看到 daemon 秒退会以为它崩了，于是无限重拉（Trojan 式刷屏）。
#
# 多开实例支持（2026-10-06 #2 修复）：
#   · 无 -n = 主实例，行为与从前完全一致
#   · 有 -n = 子 bot 实例，pid/log/锁自动带后缀（脚本开头已设 INST_NAME/SUFFIX）
#     plist 调法：./bot.sh -n 00Xbot daemon
cmd_daemon() {
  if running; then
    dim "已有实例在跑 (PID $(current_pid))，本次让位（exit 0，不会被 launchd 重拉）。"
    return 0
  fi
  # pidfile 残骸但真身没跑：清掉再继续，避免拿着死 pid 反复让位。
  local live; live="$(find_live_bot_pid || true)"
  if [ -n "$live" ]; then
    dim "已有实例在跑 (PID ${live}，pidfile 是残骸)，本次让位。"
    return 0
  fi

  resolve_tools
  [ -z "$NODE_BIN" ] && { bad "❌ 找不到 node"; return 1; }
  [ -z "$DSH_BIN_RESOLVED" ] && { bad "❌ 找不到 dsh，daemon 无法启动"; return 1; }
  cd "$APP" || return 1
  export HARNESS_BIN="$DSH_BIN_RESOLVED"

  # 模型档位自动同步（与 cmd_start 同一份逻辑，daemon 路径同样需要）
  sync_models_from_web
  sync_vision_autodetect

  ok "launchd daemon 启动中 (前台运行，日志见 $LOG_FILE)"
  # exec 让 bot.js 取代本 shell 成为 launchd 直接看管的进程：
  # launchd 的 KeepAlive 判据、SIGTERM 传递都落在这一个进程上。
  exec "$NODE_BIN" bot.js
}

cmd_logs() { tail -f "$LOG_FILE"; }

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; sleep 1; cmd_start ;;
  status)  cmd_status ;;
  run)     cmd_run ;;
  daemon)  cmd_daemon ;;
  logs)    cmd_logs ;;
  *)
    echo "用法: $SELF {start|stop|restart|status|run|daemon|logs} [-n <实例名>]"
    echo "  start   后台启动（手动）"
    echo "  daemon  launchd 前台模式（开机自启用，别手敲）"
    echo "  -n 名字  多开实例：pid/log/锁带 -名字 后缀，配置读 .env.名字（模板 .env.instance.example）"
    exit 1
    ;;
esac
