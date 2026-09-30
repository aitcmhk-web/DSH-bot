#!/bin/zsh
# 双击运行：自动装到 ~/DSH/mybot，完成后弹出使用说明。
set -e
# 先把「安装包自己所在的目录」定死。下面会多次 cd，$0 的相对路径会失效，
# 所以用 PKGDIR 记住它，后面取 使用说明.txt 全靠这个绝对路径。
PKGDIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PKGDIR"

# 找到 dsh：PATH 里没有就翻 npx 缓存
DSHBIN="$(command -v dsh 2>/dev/null || true)"
if [ -z "$DSHBIN" ]; then
  DSHBIN="$(ls "$HOME"/.npm/_npx/*/node_modules/.bin/dsh 2>/dev/null | head -1)"
fi
if [ -z "$DSHBIN" ]; then
  echo "⛔ 没找到 dsh。请先在这台机器上安装 DeepSeek Harness（能运行 dsh 命令）再试。"
  exit 1
fi

TARGET="$HOME/DSH/mybot"
export DSH_HOME="$TARGET"   # 装到哪，dsh 的工作主目录就指哪（否则会写进 ~/.dsh）

# 已有安装：只覆盖插件本体，绝不覆盖用户已填的 token 配置
if [ -d "$TARGET/profiles/mybot" ]; then
  echo "发现已有 ~/DSH/mybot —— 保留你的配置，只更新插件本体。"
  rm -rf "$TARGET/botplugin.old"
  [ -d "$TARGET/botplugin" ] && mv "$TARGET/botplugin" "$TARGET/botplugin.old"
else
  mkdir -p "$TARGET/profiles/mybot"
  cp profiles/mybot/cordis.yml profiles/mybot/package.json "$TARGET/profiles/mybot/"
  cp profiles/mybot/cordis.patch.yml "$TARGET/profiles/mybot/"
  sed -i '' "s|PLACEHOLDER_CWD|$HOME/DSH/mybot|g" "$TARGET/profiles/mybot/cordis.patch.yml"
  sed -i '' "s|PLACEHOLDER_WX_ACCOUNT|$HOME/DSH/mybot/weixin-account.json|g" "$TARGET/profiles/mybot/cordis.patch.yml"
fi
cp -R botplugin "$TARGET/botplugin"

# 生成启动器（写死本次找到的 dsh 路径，双击就能用）
cat > "$TARGET/启动-mybot.command" <<LAUNCH
#!/bin/zsh
cd "\$(dirname "\$0")"
export DSH_HOME="\$PWD"
exec "$DSHBIN" --profile mybot
LAUNCH
chmod +x "$TARGET/启动-mybot.command"

# 生成微信扫码登录器（凭据写到配置文件指向的位置，扫码后重启即启用微信）
cat > "$TARGET/登录微信.command" <<LAUNCH
#!/bin/zsh
cd "\$(dirname "\$0")"
if ! command -v node >/dev/null 2>&1; then echo "⛔ 没找到 node 命令"; exit 1; fi
exec node botplugin/weixin-login.mjs --out "\$HOME/DSH/mybot/weixin-account.json"
LAUNCH
chmod +x "$TARGET/登录微信.command"

# 把插件装进 profile（官方方式）
cd "$TARGET/profiles/mybot"
"$DSHBIN" plugin --profile mybot add "$TARGET/botplugin"

# 弹出使用说明
cd "$TARGET"
cp "$PKGDIR/使用说明.txt" "$TARGET/使用说明.txt" 2>/dev/null || true
open -e "$TARGET/使用说明.txt"

echo ""
echo "✅ 安装完成。"
echo "下一步：① 在 ~/DSH/mybot/profiles/mybot/cordis.patch.yml 里填入你的 token"
echo "        ② 双击 ~/DSH/mybot/启动-mybot.command"
echo "现在帮你打开配置文件吗？(y=打开，其他=退出)"
read -r ans
[ "$ans" = "y" ] && open -e "$TARGET/profiles/mybot/cordis.patch.yml"
exit 0
