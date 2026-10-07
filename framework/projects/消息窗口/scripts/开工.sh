#!/bin/sh
# 模块开工：./scripts/开工.sh 模块名
# 一次读齐：契约 + 任务表里本模块的活 + 本模块记忆；末尾附收工清单。
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOD="${1:?用法: ./scripts/开工.sh 模块名}"

echo "===== 01-契约 ====="
cat "${ROOT}/01-契约.md"

echo ""
echo "===== 02-任务表（本模块：${MOD}）====="
awk -F'\t' -v m="$MOD" 'NR==1 || $2==m' "${ROOT}/02-任务表.tsv"

if [ ! -f "${ROOT}/modules/${MOD}/记忆.md" ]; then
  echo ""
  echo "（modules/${MOD}/记忆.md 不存在——目录名必须和任务表「模块」列一致）"
  exit 1
fi
echo ""
echo "===== 本模块记忆 ====="
cat "${ROOT}/modules/${MOD}/记忆.md"

echo ""
echo "===== 收工三件事 ====="
echo "1. 任务表：更新自己那行的 状态 / 产出"
echo "2. 记忆：把进展和坑写回 modules/${MOD}/记忆.md"
echo "3. 群里吱一声（干完 / 卡住都要说）"
