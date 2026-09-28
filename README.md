# dsh-botplugin

把 Telegram / 微信变成 DSH 的聊天入口的插件。三大功能：**Telegram 入口、微信入口、handoff 记忆接续**，外加语音转文字和 TG→微信镜像。

**与现有 bot 完全独立**：不动任何现有文件，装在哪个 profile、哪台机器都行。

---

## 环境要求

- Node ≥ 18
- 机器上装好 DSH（有 `dsh` 命令）
- 一个 Telegram bot token（找 @BotFather 新建一个，**不要和现有 bot 共用**）

## 安装（三步）

1. 把整个 `botplugin/` 目录拷到新机器任意路径，比如 `~/botplugin`。
2. 装进目标 profile（下面以 `mybot` 为例，没有就先建一个）：

   ```
   dsh plugin --profile mybot add ~/botplugin
   ```

3. 编辑该 profile 的 `cordis.patch.yml`，加上配置（**token 必填**，其余按需）：

   ```yaml
   - id: botplugin
     config:
       telegramToken: "123456:ABC你的token"
       telegramAllowedUsers: [你的TG数字ID]   # 空数组 = 第一个发消息的人认领为主人
       routes:
         - key: ds
           provider: deepseek-official
           model: deepseek-flash
       defaultRouteKey: ds
       cwd: /你希望它工作的目录
       # 可选：handoff 记忆（不填就没有记忆接续）
       memoryDir: /你的记忆目录
       memoryScript: /conversation-cache/cache-manager.mjs 的路径
   ```

## 配置项速查

| 配置 | 说明 |
|---|---|
| `telegramToken` / `telegramApiRoot` | TG 必填；apiRoot 指向代理时改 |
| `telegramAllowedUsers` | 允许的 TG 用户 ID；空 = 首个发消息者认领 |
| `weixinToken` / `weixinApiRoot` / `weixinAccountFile` | 微信入口（三选一即可用） |
| `routes` + `defaultRouteKey` | 模型档位表，`/model` 指令切换 |
| `cwd` | 模型的工作目录 |
| `memoryDir` / `memoryScript` | handoff 接续的存储与脚本 |
| `turnTimeoutMs` | 单轮超时，默认 30 分钟 |
| `asrBackend` / `asrWhisperBin` / `asrPythonBin` | 语音转文字（不填则语音报"没配"） |

## ⚠️ 三条硬注意事项

1. **profile 必须是"有客户端"的形态**。如果这个 profile 用的是 sdk 类组合（`dsh-sdk-app`），必须有个程序握着它的 stdin（BOT 那种架构天然满足）；直接后台裸跑 `dsh --profile xxx` 会变成"假活"——日志在、轮询在，但模型树已被关停。拿不准就用 web 类 profile。
2. **一个 token 只能一个进程**。两个进程抢同一个 token，先启动的会 409 冲突。
3. **Telegram 游标在内存里**：重启后从当前时刻开始拉消息，不补发离线期间的旧消息。

## 指令

`/whoami` `/status` `/model` `/new`（新会话） `/help`

## 微信入口（扫码绑定）

双击安装器生成的「登录微信.command」，或手动运行：

```
node weixin-login.mjs --out ~/DSH/mybot/weixin-account.json
```

手机微信扫终端二维码（约 2 分钟过期，自动刷新）→ 凭据写入 `weixin-account.json`（0600）→ 重启 bot → 微信入口自动启用，无需改配置。扫码的这个微信就是主人，只有它能和 bot 对话。

## 已知缺口（诚实交底）

- Telegram 409 冲突时插件只停自己的轮询并打日志（BOT 旧版是直接退出进程），行为更温和但要去日志里看原因。
- 微信扫码工具用 macOS 原生 CoreImage 渲染二维码（零依赖），Windows/Linux 机器上会退化为只打印链接。

## 本机已验证

真实 DSH 宿主内端到端：TG 消息 → 认领 → 真模型回答 → 回传；会话重启接续（resume）；配置错误启动即吼；48 项 Telegram 客户端回归全绿。
