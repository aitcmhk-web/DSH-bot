#!/bin/sh
# 打包安装包（2026-11-27 加）—— 把当前工作树打成「双击安装」zip。
#
# 为什么要脚本：2026-11-27 审计发现仓库里的 zip 停在 1.0.87（39 个版本前），
# README 还让人下载它 —— 双击装回来的是旧插件。手工打包必然再漂，所以定成一条命令。
#
# 用法：sh 打包安装包.sh      （或 npm run pack:zip）
# 产物：dsh-mybot-安装包.zip（覆盖旧的，随发版同一 commit 提交）
set -eu
TOP=$(cd "$(dirname "$0")" && pwd)
cd "$TOP"
OUT="dsh-mybot-安装包.zip"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ROOT="$TMP/DSH-mybot安装包"
mkdir -p "$ROOT/botplugin"

# 用工作树而不是 git archive：新文件还没 commit 时也要能打。
# 排除：版本库、钩子、依赖、打包素材（已单独拷到顶层）、旧备份、安装包自身。
tar -c \
  --exclude='./.git' --exclude='./.githooks' --exclude='./node_modules' \
  --exclude='./.backups' --exclude='./.staging' --exclude='./.备份' \
  --exclude='./packaging' --exclude="./$OUT" --exclude='*.bak.*' --exclude='*.bak-*' \
  . | tar -x -C "$ROOT/botplugin"

cp "$TOP/packaging/使用说明.txt" "$ROOT/"
cp "$TOP/packaging/功能说明.txt" "$ROOT/"
cp "$TOP/packaging/安装-mybot.command" "$ROOT/"
chmod +x "$ROOT/安装-mybot.command"

rm -f "$OUT"
ditto -c -k --keepParent --norsrc "$ROOT" "$OUT"
echo "✅ 已重打：$OUT（$(du -h "$OUT" | awk '{print $1}')）"
