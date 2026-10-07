#!/bin/bash
#
# 双击本文件 = 给四个小工 profile 换上「小工精简指令」门控（任务表 #35，2026-10-08）。
#
# 为什么要你代劳：`~/.dsh/profiles/` 在 agent 工作区之外（沙箱写不进去）。
#
# 改的是：~/.dsh/profiles/bot-001bot…bot-004bot 的 cordis.patch.yml（只这四份，⛔ 不碰 bot/web 等）
# 改什么：agent-instructions 的 instructionFileCandidates 表达式，从两分支换三分支：
#         小工（bot.js 设 DSH_WORKER_INSTRUCTIONS=1）→ AGENTS.worker.md（AGENTS.md 门五前切片，bot.js 每次小工启动自动生成）
#         本地档（dsh.js 设 DSH_LITE_INSTRUCTIONS=1）→ LITE.md（原样保留）
#         其余                                       → AGENTS.md + CLAUDE.md（原样保留，主 bot 走这里）
# 配套：AGENTS.worker.md 由 bot.js（#35）在 worker 启动时生成并 gitignore；本脚本只换表达式。
#
# 本脚本只做四件事：
#   1. 备份原文件（带时间戳）
#   2. 校验形状（表达式不是预期形状就跳过该 profile，绝不瞎改）
#   3. 临时文件改好 → mv 原子替换（宿主 HMR 热重载，原地编辑的中间态会崩插件树）
#   4. 复核替换结果
# 不碰 TG，不动主 bot，不改任何别的文件。改完需要重启对应小工才生效。

cd "$(dirname "$0")" || exit 1
printf '\033]0;BOT — 启用小工精简指令\007'
clear

OLD="    instructionFileCandidates: !!js 'process.env.DSH_LITE_INSTRUCTIONS ? [\"LITE.md\"]
      : [\"AGENTS.md\", \"CLAUDE.md\"]'"
NEW="    instructionFileCandidates: !!js 'process.env.DSH_WORKER_INSTRUCTIONS ? [\"AGENTS.worker.md\"] : process.env.DSH_LITE_INSTRUCTIONS ? [\"LITE.md\"] : [\"AGENTS.md\", \"CLAUDE.md\"]'"

echo "BOT · 启用小工精简指令（bot-001bot … bot-004bot）"
echo "────────────────────────────────────────"
echo

FAIL=0
for NAME in bot-001bot bot-002bot bot-003bot bot-004bot; do
  PATCH="$HOME/.dsh/profiles/$NAME/cordis.patch.yml"
  echo "── $NAME"
  if [ ! -f "$PATCH" ]; then
    echo "   ❌ 找不到 $PATCH，跳过（没改）"; FAIL=1; continue
  fi

  if grep -q 'DSH_WORKER_INSTRUCTIONS' "$PATCH"; then
    echo "   ℹ️  已经是小工门控，跳过（幂等）"; continue
  fi

  if ! grep -q 'instructionFileCandidates' "$PATCH"; then
    echo "   ❌ 这份 patch 里没有 agent-instructions 块，形状不符，跳过（没改）"; FAIL=1; continue
  fi

  if ! grep -qF 'process.env.DSH_LITE_INSTRUCTIONS ? ["LITE.md"]' "$PATCH"; then
    echo "   ❌ 表达式不是预期的 LITE 两分支形状，跳过（没改，请人工看一眼）"; FAIL=1; continue
  fi

  STAMP="$(date +%Y%m%d-%H%M%S)"
  BAK="$PATCH.bak-$STAMP-before-worker-instructions"
  cp -p "$PATCH" "$BAK" || { echo "   ❌ 备份失败，跳过（没改）"; FAIL=1; continue; }
  echo "   ✅ 已备份 → $(basename "$BAK")"

  TMP="$PATCH.tmp-$$"
  python3 - "$PATCH" "$TMP" "$OLD" "$NEW" <<'PYEOF' || { echo "   ❌ 替换失败（没改）"; rm -f "$TMP"; FAIL=1; continue; }
import sys
src, dst, old, new = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
text = open(src, encoding="utf-8").read()
if text.count(old) != 1:
    sys.exit("old block count = %d (expect 1)" % text.count(old))
open(dst, "w", encoding="utf-8").write(text.replace(old, new, 1))
PYEOF

  chmod --reference="$PATCH" "$TMP" 2>/dev/null || chmod 644 "$TMP"
  mv -f "$TMP" "$PATCH" || { echo "   ❌ mv 失败"; FAIL=1; continue; }

  if grep -q 'DSH_WORKER_INSTRUCTIONS' "$PATCH"; then
    echo "   ✅ 已换上三分支门控（小工 → AGENTS.worker.md）"
  else
    echo "   ❌ 替换后复核失败，正在还原备份…"
    cp -p "$BAK" "$PATCH" && echo "   ✅ 已还原"
    FAIL=1
  fi
done

echo
if [ "$FAIL" -eq 0 ]; then
  echo "全部完成。生效条件：对应小工进程重启（新 bot.js 会带 DSH_WORKER_INSTRUCTIONS=1）。"
else
  echo "部分 profile 没改成（见上），改过的已有备份，可人工核对。"
fi
echo
read -n 1 -s -r -p "按任意键关闭窗口…"
