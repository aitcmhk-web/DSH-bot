# dsh-botplugin

把 Telegram / 微信变成 DSH 的聊天入口的插件。三大功能：**Telegram 入口、微信入口、handoff 记忆接续**，外加语音转文字。

## 环境要求

- Node ≥ 18
- 机器上装好 DSH（有 `dsh` 命令）
- 一个 Telegram bot token（在 Telegram 里找 @BotFather 发送 `/newbot` 新建，不要和其他 bot 共用）

## 安装方式一：在线安装（会敲命令的，推荐）

1. 装进目标 profile（下面以 `mybot` 为例，没有就先建一个）：

   ```
   dsh plugin --profile mybot add github:aitcmhk-web/DSH-bot
   ```

2. 编辑该 profile 的 `cordis.patch.yml`，加上配置（**token 必填**）：

   ```yaml
   - id: botplugin
     config:
       telegramToken: "123456:ABC你的token"
   ```

3. 启动：

   ```
   dsh --profile mybot
   ```

以后升级也是同一条命令（重新 add 会拉最新版本）。npm 发布后还可以用 `dsh plugin --profile mybot add dsh-botplugin`。

## 安装方式二：下载安装包（不想敲命令的）

1. 下载安装包：[dsh-mybot-安装包.zip](dsh-mybot-安装包.zip)（在本页文件列表里，点它再点 Download / Download raw）。
2. 解压，双击里面的 `安装-mybot.command` —— 它会自动装到 `~/DSH/mybot` 并弹出图文说明。
3. 按弹出的说明填 token（打开 `~/DSH/mybot/profiles/mybot/cordis.patch.yml`，把 telegramToken 换成你的）。
4. 以后每次使用：双击 `~/DSH/mybot/启动-mybot.command`。想加微信：双击 `登录微信.command` 扫码。

> 两种方式装出来的是同一个插件，选一种就行。安装包方式自带图文说明和启动器，适合第一次接触命令行的人；在线方式升级最省事（重跑一条命令）。

## 配置项速查

| 配置 | 说明 |
|---|---|
| `telegramToken` / `telegramApiRoot` | TG 必填；apiRoot 指向代理时改 |
| `telegramAllowedUsers` | 允许的 TG 用户 ID；空 = 首个发消息者认领为主人 |
| `weixinToken` / `weixinApiRoot` / `weixinAccountFile` | 微信入口（通常用扫码登录，不用填 token） |
| `routes` + `defaultRouteKey` | 手工指定模型档位；留空 = 自动跟随 web 端「设置 → 模型」 |
| `cwd` | 模型的工作目录 |
| `memoryDir` / `memoryScript` | handoff 记忆接续的存储与脚本（不填就没有记忆） |
| `turnTimeoutMs` | 单轮超时，默认 30 分钟 |
| `asrBackend` / `asrWhisperBin` / `asrPythonBin` | 语音转文字（不填则语音报"没配"） |

## 指令

`/whoami` `/status` `/model` `/new`（新会话） `/help`

## 微信入口（扫码绑定）

1. 运行（本目录下）：

   ```
   node weixin-login.mjs --out 你的账号文件路径
   ```

2. 手机微信扫终端二维码（约 2 分钟过期，自动刷新；备用链接发到手机微信里点开）。
3. 凭据写入账号文件（0600）→ 在配置里加 `weixinAccountFile: 那个路径` → 重启即启用。
4. 扫码的这个微信就是主人，只有它能和 bot 对话。

## ⚠️ 三条硬注意事项

1. **一个 token 只能一个进程**。两个进程抢同一个 token，先启动的会 409 冲突。
2. **Telegram 游标在内存里**：重启后从当前时刻开始拉消息，不补发离线期间的旧消息。
3. **409 冲突时插件只停自己的轮询并打日志**，不会拖垮宿主；原因要去启动日志里看（通常是同一个 token 另有进程在用）。

## 已知限制

- 微信扫码工具用 macOS 原生 CoreImage 渲染二维码（零依赖），Windows/Linux 机器上会退化为只打印链接。
