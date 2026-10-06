#!/bin/sh
# 修插件版 @newdshbot 的 launchd 自启：补上 KeepAlive（SuccessfulExit=false）。
# 版本：2026-10-06.3
#
# 旧 plist 只有 RunAtLoad，崩了/僵了 launchd 不管。
# 修法：以现网 plist 为底本，只新增 KeepAlive(SuccessfulExit=false)
#       + ThrottleInterval=15，其余一字不动（含 DSH_HOME、PATH 等）。
#
# ⛔ 本脚本只生成不安装（写 ~/Library 超出子 bot 沙箱），
#    安装由主 bot 派给插件版 @newdshbot 走权限申请执行。
#
# 用法：双击 / 终端运行  ./修插件版自启.command

SELF_VERSION="2026-10-06.3"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_DIR/com.local.dshbot.dshbot.plist"
BACKUP_NAME="com.local.dshbot.dshbot.plist.bak.$(date +%Y%m%d-%H%M%S)"

echo "修插件版自启 v${SELF_VERSION}"
echo "────────────────────────────────────────"

# --- 前置检查 ----------------------------------------------------------------
if ! mkdir -p "$LAUNCH_DIR" 2>/dev/null; then
  echo "⛔ 建不了 ~/Library/LaunchAgents，装不了。"; exit 1
fi

# --- 备份旧 plist -----------------------------------------------------------
if [ -f "$PLIST" ]; then
  cp -p "$PLIST" "$LAUNCH_DIR/$BACKUP_NAME" 2>/dev/null \
    && echo "✅ 已备份旧 plist → $LAUNCH_DIR/$BACKUP_NAME"
else
  echo "⚠️ 旧 plist 不存在，直接生成新文件。"
fi

# --- 生成新 plist（以现网 plist 为底本，只插 KeepAlive） ----------------------
cat > "$PLIST" <<'PLIST_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.local.dshbot.dshbot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/dsh</string>
    <string>--profile</string>
    <string>dshbot</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/tcm/DSH/dshbot</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DSH_HOME</key><string>/Users/tcm/.dsh</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/appleinternal/bin:/pkg/env/global/bin:/opt/homebrew/bin:/Users/tcm/.docker/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>

  <!-- 只在"异常退出"时重拉 -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>15</integer>

  <key>StandardOutPath</key><string>/Users/tcm/DSH/dshbot/bot.log</string>
  <key>StandardErrorPath</key><string>/Users/tcm/DSH/dshbot/bot.log</string>
</dict>
</plist>
PLIST_EOF

# --- 校验格式 ----------------------------------------------------------------
if ! plutil -lint "$PLIST" >/dev/null 2>&1; then
  echo "⛔ 新 plist 格式不对！回滚到备份。"
  if [ -f "$LAUNCH_DIR/$BACKUP_NAME" ]; then
    cp -p "$LAUNCH_DIR/$BACKUP_NAME" "$PLIST" 2>/dev/null
    echo "✅ 已回滚到备份"
  fi
  exit 1
fi
echo "✅ plist 格式校验通过（plutil -lint）"

# --- 确认 KeepAlive 是否写入成功（双验证） ------------------------------------
_KA=$(grep -c 'KeepAlive' "$PLIST")
_SE=$(grep -c 'SuccessfulExit' "$PLIST")
if [ "$_KA" -ge 1 ] && [ "$_SE" -ge 1 ]; then
  echo "✅ KeepAlive + SuccessfulExit 已写入"
else
  echo "⛔ KeepAlive 未写入成功！"
  exit 1
fi

# --- 与覆盖前的现网（备份）对比：剔掉 KeepAlive 等新增项后应零差异 ---------------
# 真底本=备份（执行到这里时现网早已被覆盖，不能拿新 plist 自己比自己）。
echo "--- diff 对比（覆盖前的备份 vs 新 plist）---"
_DIFF_TMP="${TMPDIR:-/tmp}/dshbot-plist-diff.$$"
_strip_added() {
  sed '/KeepAlive/,/<\/dict>/d; /ThrottleInterval/,/<\/integer>/d; /<!--/d' "$1" \
    | sed '/^[[:space:]]*$/d' | sort
}
_strip_added "$PLIST" > "$_DIFF_TMP"
if [ -f "$LAUNCH_DIR/$BACKUP_NAME" ]; then
  diff_output=$(_strip_added "$LAUNCH_DIR/$BACKUP_NAME" | diff - "$_DIFF_TMP") || true
  if [ -z "$diff_output" ]; then
    echo "✅ 除 KeepAlive/ThrottleInterval 外，新 plist 与覆盖前的现网逐行一致"
  else
    echo "⚠️ 发现差异："
    echo "$diff_output"
  fi
else
  echo "（旧 plist 本来不存在，无备份可比，跳过此对比）"
fi
rm -f "$_DIFF_TMP"

# --- 卸载旧版 → 加载新版 ------------------------------------------------------
echo
echo "--- launchctl unload/load ---"
launchctl unload "$PLIST" 2>/dev/null || true
if launchctl load "$PLIST" 2>/dev/null; then
  echo "✅ 新 plist 已加载"
else
  echo "⛔ launchctl load 失败（可能已在运行或需要重启插件进程）"
fi

# --- 打印状态确认 ------------------------------------------------------------
echo
echo "--- launchctl print 状态 ---"
launchctl print gui/$(id -u)/com.local.dshbot.dshbot 2>/dev/null || \
  echo "（launchctl print 无输出，可能是服务尚未完全注册；plist 文件本身已正确）"

echo
echo "────────────────────────────────────────"
echo "完成。想取消：去 ~/Library/LaunchAgents/ 删掉 com.local.dshbot.dshbot.plist"
