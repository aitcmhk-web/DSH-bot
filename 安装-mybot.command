#!/bin/sh
# 双击运行 = 用安装包里自带的这份插件，走一遍完整安装流程。
#
# 这里什么都不实现，只负责两件事：
#   ① 找到「安装包自己所在的目录」（下面要调别的东西，相对路径会失效，所以定死绝对路径）
#   ② 用包里的插件（file: 指向它），把活全部交给 botplugin/setupbot.sh
#
# 于是选工作区、绑 TG、绑微信、升级，全部都和「一条命令在线安装」是同一套逻辑、同一个界面。
# 想重新绑 TG / 微信，把这个文件再双击一次就行。

PKGDIR="$(cd "$(dirname "$0")" && pwd)"
SETUP="$PKGDIR/botplugin/setupbot.sh"

if [ ! -f "$SETUP" ]; then
  echo "⛔ 安装包不完整：没找到 botplugin/setupbot.sh"
  echo "   请重新下载完整的安装包（或改用在线命令安装）。"
  echo
  echo "按回车键关闭这个窗口。"
  read -r _ || true
  exit 1
fi

env BOTPLUGIN_SPEC="file:$PKGDIR/botplugin" /bin/sh "$SETUP" "$@"
RC=$?

# 双击进来的窗口默认「成功就自动关掉」，那样上面的结果会一闪而过 —— 留一步等回车
echo
if [ "$RC" -eq 0 ]; then
  echo "✅ 全部完成。按回车键关掉这个窗口。"
else
  echo "⛔ 上面有报错，把这段截图发给帮你装的人。按回车键关掉这个窗口。"
fi
read -r _ || true
exit "$RC"
