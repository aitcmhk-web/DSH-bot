#!/bin/sh
# 安装子 bot（001bot…004bot）的 launchd 开机自启 + 崩溃自动拉起。
# 版本：2026-10-06.1
#
# 仿照 com.local.dsbot.plist（主 bot），为四个实例各生成一份 plist，
# 写入 ~/Library/LaunchAgents/，launchctl 加载后逐个打印 ./bot.sh -n 00Xbot status。
#
# ⛔ 本脚本只负责生成和安装，不执行安装——由主 bot 派给插件版 @newdshbot
#    走 TG 权限申请、老板按钮批准。
#
# 用法：双击 / 终端运行  ./安装子bot自启.command

SELF_VERSION="2026-10-06.1"
# $0 在中文文件名下 dirname 可能返回空，直接取绝对路径兜底。
_APP="${BASH_SOURCE[0]:-$0}"
_APP="$(cd "$(dirname "$_APP")" && pwd 2>/dev/null)" || _APP=""
if [ -z "$_APP" ]; then
  # Finder 双击或某些调用方式：脚本所在目录就是当前工作区
  _APP="$(pwd)"
fi
LAUNCH_DIR="$HOME/Library/LaunchAgents"
BOT_SH="${_APP}/bot.sh"

echo "安装子 bot 自启 v${SELF_VERSION}"
echo "────────────────────────────────────────"

# --- 前置检查 ---------------------------------------------------------------
if [ ! -f "${BOT_SH}" ]; then
  echo "⛔ 找不到 ${BOT_SH}，请确认在工作区目录运行。"; exit 1
fi
if ! mkdir -p "$LAUNCH_DIR" 2>/dev/null; then
  echo "⛔ 建不了 ~/Library/LaunchAgents，装不了。"; exit 1
fi

# --- 生成 + 安装 plist -------------------------------------------------------
for INST in 001bot 002bot 003bot 004bot; do
  LABEL="com.local.dshbot.${INST}"
  PLIST="$LAUNCH_DIR/${LABEL}.plist"
  LOG_FILE="${_APP}/bot-${INST}.log"

  echo
  echo "--- $INST ---"

  # 备份旧文件
  if [ -f "$PLIST" ]; then
    cp -p "$PLIST" "$PLIST.bak.$(date +%Y%m%d-%H%M%S)" 2>/dev/null \
      && echo "（旧的已备份）"
  fi

  # 生成 plist
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  ${INST} 开机自启（2026-10-06 新增）。
  Label: ${LABEL}
  调用方式：${BOT_SH} -n ${INST} daemon
  KeepAlive = 异常退出时重拉（SuccessfulExit=false）；让位或手动 stop 不重拉。
-->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${BOT_SH}</string>
    <string>-n</string>
    <string>${INST}</string>
    <string>daemon</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${_APP}</string>

  <!-- 登录就起来 -->
  <key>RunAtLoad</key>
  <true/>

  <!-- 只在"异常退出"时重拉 -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>15</integer>

  <!-- PATH 与主 bot plist 一致 -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key>
    <string>zh_CN.UTF-8</string>
  </dict>

  <!-- 日志独立文件 -->
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
</dict>
</plist>
PLIST_EOF

  # 校验格式
  if ! plutil -lint "$PLIST" >/dev/null 2>&1; then
    echo "⛔ ${LABEL} plist 格式不对，跳过安装。"; continue
  fi

  # 卸载旧版 → 加载新版
  launchctl unload "$PLIST" 2>/dev/null || true
  if launchctl load "$PLIST" 2>/dev/null; then
    echo "✅ ${LABEL} 已安装并加载"
  else
    echo "⛔ ${LABEL} launchctl load 失败"
  fi
done

# --- 验证 -------------------------------------------------------------------
echo
echo "────────────────────────────────────────"
echo "逐个检查状态："
for INST in 001bot 002bot 003bot 004bot; do
  echo
  echo "--- $INST ---"
  "$BOT_SH" -n "$INST" status
done

echo
echo "全部完成。想取消：跑 ./卸载子bot自启.command"
