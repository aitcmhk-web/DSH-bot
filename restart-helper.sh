#!/bin/bash
# restart-helper.sh —— 由 botplugin 的 /restart 指令通过 spawn(detached) 拉起的独立进程。
#
# 设计目的与老 bot 的 restart-helper.sh 完全同路：「重启」这个动作必须发生在
# 宿主进程之外 —— 插件活在 DSH 进程里，自己杀自己 = 连回复都发不出去；
# 而 detached(setsid 成独立进程组/会话)的子进程不受影响，可以替它收尸、再拉起新的。
#
# 传入（全部走环境变量，由 src/index.js 的 /restart 组装）：
#   RESTART_TARGET_PID     要重启的宿主进程 pid（必填）
#   RESTART_LAUNCHER       启动器 .command 路径（有它优先 `open` 拉起，macOS 安装包用户）
#   RESTART_NODE/RESTART_SCRIPT/RESTART_ARGS/RESTART_CWD
#                          没有启动器时按原始命令行 nohup 拉起（尽力而为）
#   RESTART_TG_TOKEN       Telegram token（用于等旧进程真正释放 token，防 409；可选）
#   RESTART_LOG            日志文件（默认 <工作目录>/dsh-restart.log）
#   RESTART_DELAY_SECONDS  动手前的延迟（默认 8s：让确认消息发出、当前回合走完）
#
# ⚠️ 已知边界：宿主若是 launchd 托管（KeepAlive），杀掉后 launchd 会自动拉起一份，
#   此时不要再走 nohup（会双实例抢 token）。检测不了 launchd，只能靠用户别这样装。

DELAY="${RESTART_DELAY_SECONDS:-8}"
TARGET_PID="${RESTART_TARGET_PID:-}"
LAUNCHER="${RESTART_LAUNCHER:-}"
LOG="${RESTART_LOG:-$PWD/dsh-restart.log}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

log "helper 启动，等 ${DELAY}s（目标 pid=${TARGET_PID:-?}，launcher=${LAUNCHER:-无}，script=${RESTART_SCRIPT:-无}）"
sleep "$DELAY"

[ -n "$TARGET_PID" ] || { log "❌ 没给目标 pid，放弃重启"; exit 1; }
kill -0 "$TARGET_PID" 2>/dev/null || { log "ℹ️ 目标 pid=$TARGET_PID 已不在（可能别人先停了），只负责拉起"; }

# 杀进程树：不假设目标是组长（nohup & 不新建进程组），先查真实 PGID；
# 递归收子孙（DSH 宿主下面挂着会话子进程），先杀子孙再杀本体；
# 整组补刀时绝不能打到自己所在的组。
kill_tree() {
  local pid="$1" sig="${2:-TERM}"
  local pgid=""
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"

  local kids=""
  kids="$(pgrep -P "$pid" 2>/dev/null || true)"
  local grandkids=""
  for k in $kids; do
    grandkids="$grandkids $(pgrep -P "$k" 2>/dev/null || true)"
  done

  for p in $grandkids $kids "$pid"; do
    [ -n "$p" ] || continue
    kill -"$sig" "$p" 2>/dev/null || true
  done

  local mypgid=""
  mypgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ' || true)"
  if [ -n "$pgid" ] && [ "$pgid" != "$mypgid" ]; then
    kill -"$sig" -- "-$pgid" 2>/dev/null || true
  fi
}

if kill -0 "$TARGET_PID" 2>/dev/null; then
  log "停止旧宿主 pid=$TARGET_PID（含子孙进程）"
  kill_tree "$TARGET_PID" TERM
  for _ in $(seq 1 15); do
    kill -0 "$TARGET_PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$TARGET_PID" 2>/dev/null; then
    log "⚠️ pid=$TARGET_PID 未退出，发 SIGKILL（整组）"
    kill_tree "$TARGET_PID" KILL
    sleep 2
  fi
fi

# 等 Telegram token 真正释放：光等 pid 消失不够（残留子孙还占着 token 时，
# 新实例 getUpdates 直接 409 自杀）。尽力而为：没 token / 网络不通就不等。
if [ -n "${RESTART_TG_TOKEN:-}" ]; then
  for i in $(seq 1 15); do
    resp="$(curl -s -m 5 "https://api.telegram.org/bot${RESTART_TG_TOKEN}/getUpdates?timeout=1&offset=-1" 2>/dev/null || echo '')"
    case "$resp" in
      *'"error_code":409'*|*'terminated by other getUpdates'*)
        [ "$i" = 1 ] && log "⏳ token 仍被占用(409)，等旧进程释放…"
        sleep 1
        ;;
      *'"ok":true'*)
        [ "$i" -gt 1 ] && log "✅ token 已释放(等了 ${i}s)"
        break
        ;;
      *)
        break   # 网络问题/响应不认识 → 不阻塞重启
        ;;
    esac
  done
fi

sleep 1

# 拉起新宿主：优先启动器（macOS `open` 会开一个新的终端窗口，用户看得见）；
# 没有启动器就按原始命令行 nohup 后台拉起（日志进 RESTART_LOG）。
if [ -n "$LAUNCHER" ] && [ -f "$LAUNCHER" ] && command -v open >/dev/null 2>&1; then
  log "通过启动器拉起：open $LAUNCHER"
  open "$LAUNCHER"
else
  if [ -z "${RESTART_SCRIPT:-}" ]; then
    log "❌ 没有启动器也没有原始命令行，无法拉起 —— 宿主已停，请手动启动"
    exit 1
  fi
  cd "${RESTART_CWD:-$PWD}" 2>/dev/null || { log "❌ cd ${RESTART_CWD:-?} 失败"; exit 1; }
  log "nohup 拉起：${RESTART_NODE:-node} ${RESTART_SCRIPT} ${RESTART_ARGS:-}"
  nohup "${RESTART_NODE:-node}" "$RESTART_SCRIPT" ${RESTART_ARGS:-} >> "$LOG" 2>&1 &
  log "已后台拉起（pid=$!）—— 若宿主原先是终端窗口里跑的，那个窗口已结束，bot 现在在后台"
fi

sleep 3
log "restart-helper 结束"
exit 0
