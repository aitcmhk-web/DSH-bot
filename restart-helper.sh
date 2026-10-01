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
#   RESTART_SUPERVISED     托管者名（systemd / launchd）。有它时**只杀宿主、不再拉起** ——
#                          托管者会把新实例拉起来，再 nohup 一份就是双实例抢 token（409）。
#   RESTART_LOG            日志文件（默认 <工作目录>/dsh-restart.log）
#   RESTART_DELAY_SECONDS  动手前的延迟（默认 8s：让确认消息发出、当前回合走完）
#
# 托管者检测（在 src/index.js 里做，这里只消费结果）：
#   systemd 给每个 unit 进程注入 INVOCATION_ID；launchd 注入 XPC_SERVICE_NAME。

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

  local mypgid=""
  mypgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ' || true)"

  for p in $grandkids $kids "$pid"; do
    [ -n "$p" ] || continue
    # ⚠️ 绝不能杀自己。本 helper 是宿主的**子进程**（detached 只改了会话/进程组，PPID 仍是宿主），
    #    所以它必然出现在 $kids 里 —— 不跳过的话会在杀到宿主之前先把自己杀掉，循环随即中断，
    #    症状是「日志停在『停止旧宿主』，宿主纹丝不动、进程从没重启」。同一进程组的也跳过。
    [ "$p" = "$$" ] && continue
    if [ -n "$mypgid" ]; then
      local ppg=""
      ppg="$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ' || true)"
      [ -n "$ppg" ] && [ "$ppg" = "$mypgid" ] && continue
    fi
    kill -"$sig" "$p" 2>/dev/null || true
  done

  if [ -n "$pgid" ] && [ "$pgid" != "$mypgid" ]; then
    kill -"$sig" -- "-$pgid" 2>/dev/null || true
  fi
}

if kill -0 "$TARGET_PID" 2>/dev/null; then
  if [ -n "${RESTART_SUPERVISED:-}" ]; then
    # 被托管：只杀**本体**，不遍历进程树 —— 进程组/残留由托管者清理（systemd 是 cgroup 整组杀）。
    # 遍历树的另一个坏处：连自己一起杀（见 kill_tree 注释），以及可能顺手打断在飞的其它子进程。
    # ⚠️ 这行要写在 kill **之前**：宿主一死，systemd 会按 cgroup 整组清理，
    #    本 helper 也在同一 cgroup 里 → 会被一起杀掉，之后的日志永远来不及写。
    log "ℹ️ 宿主由 ${RESTART_SUPERVISED} 托管：停止旧宿主 pid=$TARGET_PID（只杀本体，进程组由它清理并拉起；本 helper 不再 nohup，避免双实例抢 token）"
    kill -TERM "$TARGET_PID" 2>/dev/null || true
    for _ in $(seq 1 15); do
      kill -0 "$TARGET_PID" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$TARGET_PID" 2>/dev/null; then
      log "⚠️ pid=$TARGET_PID 未退出，发 SIGKILL"
      kill -KILL "$TARGET_PID" 2>/dev/null || true
      sleep 2
    fi
  else
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

# 被托管（systemd / launchd）：托管者会把新实例拉起来，这里只负责"停"，不负责"拉"。
# 再拉一份的后果：两份抢同一个 bot token → 其中一份吃 409 → 它只停轮询、进程不退，
# 表现就是「机器人静默变哑，而 systemctl 还显示 running」。
if [ -n "${RESTART_SUPERVISED:-}" ]; then
  log "ℹ️ 宿主由 ${RESTART_SUPERVISED} 托管：已停止旧宿主，新实例交由它拉起（本 helper 不再 nohup，避免双实例抢 token）"
  sleep 3
  log "restart-helper 结束"
  exit 0
fi

# 拉起新宿主：macOS .command 文件用 open 会弹终端窗口，改为 nohup 后台拉起（不弹窗）；
# Linux .sh 或原始命令行走 nohup 路径。
if [ -n "$LAUNCHER" ] && [ -f "$LAUNCHER" ]; then
  log "nohup 拉起启动器：$LAUNCHER"
  cd "$(dirname "$LAUNCHER")" 2>/dev/null || { log "❌ cd $(dirname "$LAUNCHER") 失败"; exit 1; }
  nohup "$LAUNCHER" >> "$LOG" 2>&1 &
elif [ -n "${RESTART_SCRIPT:-}" ]; then
  cd "${RESTART_CWD:-$PWD}" 2>/dev/null || { log "❌ cd ${RESTART_CWD:-?} 失败"; exit 1; }
  log "nohup 拉起：${RESTART_NODE:-node} ${RESTART_SCRIPT} ${RESTART_ARGS:-}"
  nohup "${RESTART_NODE:-node}" "$RESTART_SCRIPT" ${RESTART_ARGS:-} >> "$LOG" 2>&1 &
  log "已后台拉起（pid=$!）—— 若宿主原先是终端窗口里跑的，那个窗口已结束，bot 现在在后台"
else
  log "❌ 没有启动器也没有原始命令行，无法拉起 —— 宿主已停，请手动启动"
  exit 1
fi

sleep 3
log "restart-helper 结束"
exit 0
