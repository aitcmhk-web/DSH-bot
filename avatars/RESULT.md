# Avatar Set Results

## 重做后头像生成结果

- ✅ avatar-1.png (1) - 红色对角渐变底 + 白描边 + 白色粗体字居中
- ✅ avatar-2.png (2) - 蓝色对角渐变底 + 白描边 + 白色粗体字居中
- ✅ avatar-3.png (3) - 绿色对角渐变底 + 白描边 + 白色粗体字居中
- ✅ avatar-4.png (4) - 橙色对角渐变底 + 白描边 + 白色粗体字居中
- ✅ avatar-main.png (主) - 紫色对角渐变底 + 白描边 + 白色粗体字居中
- ✅ avatar-review.png (审) - 青色对角渐变底 + 白描边 + 白色粗体字居中

## setMyProfilePhoto 结果

| Bot | Token 文件 | 图片 | 结果 |
|---|---|---|---|
| 主 bot (@DSHTG_bot) | .env | avatar-main.png | ✅ {"ok":true,"result":true} |
| 001bot (@aitcm001bot) | .env.001bot | avatar-1.png | ✅ {"ok":true,"result":true} |
| 002bot (@aitcm002bot) | .env.002bot | avatar-2.png | ✅ {"ok":true,"result":true} |
| 003bot (@aitcm003bot) | .env.003bot | avatar-3.png | ✅ {"ok":true,"result":true} |
| 004bot (@aitcm004bot) | .env.004bot | avatar-4.png | ✅ {"ok":true,"result":true} |
| @newdshbot | 无 token | avatar-review.png | ⛔ 不设头像（仅出图） |

## 2026-10-06 22:34 映射纠正（主 bot 执行）

- 首次设置映射整体错位一格（主 bot 戴「1」、004bot 戴「主」，原文见 .bak 备份），老板指出后按「主=主、1=001bot、2=002bot、3=003bot、4=004bot」全部重设，5 个号 setMyProfilePhoto 均返回 {"ok":true,"result":true}；
- 逐号重新下载 TG 最新头像复验：main=主紫 / 001bot=1红 / 002bot=2蓝 / 003bot=3绿 / 004bot=4橙，全部正确；
- ⚠️ 遗留：数字加粗没落盘——重设后 TG 存储图与上一版逐字节同 sha（avatar-1 两次下载均 sha256=11720bf4…），磁盘 avatars/avatar-1…4.png 仍是 21:19 版字重，「数字再粗点」那条没生效。

## 2026-10-07 06:50 数字加粗返工（001bot，22:34 打回的剩余活）

- 六张重出：512×512 满幅对角渐变 + 白圈 r246/3px + 白字 bbox 居中，**只动字重**——渐变端点色逐张照抄旧图实测值（四角取样），布局与旧版一致
- 字重：数字 STHeiti Light → **Arial Black**（系统最重字重）；主/审 → **PingFangSC-Semibold**（黑体粗档；STHeiti Medium 名字在 CoreText 解析不到，自动回落）
- 客观对照（y=256 行笔画宽）：1: 19→58px / 2: 23→74px / 3: 28→88px / 4: 23→52px / 主: 17→23px / 审: 17→24px
- 生成方式：PIL 装不了（沙箱拒 --user 安装）、qlmanage 被沙箱挡（要起 XPC）→ **Swift CoreGraphics+CoreText 本机渲染**（.staging/gen-avatar.swift，exit=0）
- setMyProfilePhoto 按纠正后映射重跑：5 个号全部 {"ok":true,"result":true}；逐号下载 TG 存储图亲眼复验（1红/2蓝/3绿/4橙/主紫 全为粗字版 ✅，五号 sha 互不相同）
- 旧图备份：.staging/avatars-backup.bak-bold-rework-20261007-065056/（6 份）；RESULT.md 改前另存 .bak.bold-*
- ⛔ 未 git 提交推送

## 说明

- 字体：STHeiti Light.ttc（系统可用中文字体）；「数字加粗」经 22:34 复验未落盘，实际仍为上一版字重
- 尺寸：512×512 PNG
- 设计：对角线性渐变底 + 外圈细白描边 + 文字严格居中（bbox 定位）
- 六色板：1红 / 2蓝 / 3绿 / 4橙 / 主紫 / 审青
- 所有 token 从 .env 读取，⛔ 未打印回显
