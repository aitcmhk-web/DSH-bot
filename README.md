# dsh-botplugin

把 Telegram / 微信变成 DSH 的聊天入口的插件。三大功能：**Telegram 入口、微信入口、handoff 记忆接续**，外加语音转文字。

> 🔰 **第一次接触、想知道"这东西到底能干什么"** → 先看 [功能说明.txt](功能说明.txt)（大白话版，不用懂技术）。
> 装的时候怎么填、怎么启动 → 看 [使用说明.txt](使用说明.txt)。下面这份是给要自己动手的人的完整文档。

## 环境要求

- Node ≥ 18
- 机器上装好 DSH（有 `dsh` 命令）
- 一个 Telegram bot token（在 Telegram 里找 @BotFather 发送 `/newbot` 新建，不要和其他 bot 共用）

## 安装方式一：在线安装（从 git 装，会敲命令的，推荐）

> ⚠️ **必须用 `dsh plugin`，不要用裸 `pnpm add`。**
> 插件只有装进 **profile 的 `node_modules`**（`~/.dsh/profiles/<profile>/node_modules/`）才会被 DSH 加载。
> `dsh plugin` 会自动切到 profile 目录再装，所以**在哪个目录打开终端都行**；
> 裸 `pnpm add` 会装到你当前所在目录，DSH 看不见，插件静默失效。

1. 装进目标 profile（下面以 `mybot` 为例，没有就先建一个）：

   ```
   dsh plugin --profile mybot add github:aitcmhk-web/DSH-bot
   ```

   > ⚠️ `mybot` 只是**示例名**，要换成**你自己的 profile 名**。
   > profile 名 = `~/.dsh/profiles/` 下的目录名，用 `ls ~/.dsh/profiles/` 看有哪些
   > （常见的是 `bot`、`web`、`tui`）。
   > **填错名字不会报错** —— DSH 会新建一个空 profile，插件装进去，
   > 但你原来的会话一点变化都没有。

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

## 安装方式一之二：本地安装（用你手上这份源码）

已经有一份源码（比如你自己 clone 下来的、或者要改着调试的），就用 `file:` 指向**那个目录**：

```
dsh plugin --profile mybot add file:/绝对路径/dsh-botplugin
```

例如源码在 `/Users/tcm/DSH/BOT/botplugin`：

```
dsh plugin --profile mybot add file:/Users/tcm/DSH/BOT/botplugin
```

> 用 `file:` 装出来的是**软链** —— 改完源码不用重装，重启 profile 就生效。
> 调试的时候用这个；平时用上面的 git 方式。**两种选一种，别都装**
> （会装出两份同名插件，加载哪份不好说）。
>
> ⚠️ 路径必须是**绝对路径**，且指向**含 `package.json` 的那一层**（也就是仓库根），
> 不要指到 `src/` 或上一层。

## 安装方式二：下载安装包（不想敲命令的）

1. 下载安装包：[dsh-mybot-安装包.zip](dsh-mybot-安装包.zip)（在本页文件列表里，点它再点 Download / Download raw）。
2. 解压，双击里面的 `安装-mybot.command` —— 它会自动装到 `~/DSH/mybot` 并弹出图文说明。
3. 按弹出的说明填 token（打开 `~/DSH/mybot/profiles/mybot/cordis.patch.yml`，把 telegramToken 换成你的）。
4. 以后每次使用：双击 `~/DSH/mybot/启动-mybot.command`。想加微信：双击 `登录微信.command` 扫码。

> 三种方式装出来的是同一个插件，选一种就行。安装包方式自带图文说明和启动器，适合第一次接触命令行的人；git 方式升级最省事（重跑一条命令）；本地方式改了源码立刻生效，适合调试。

## 怎么确认装对了

插件**装对了**的话，`ls ~/.dsh/profiles/mybot/node_modules/` 里能看到 `dsh-botplugin`。

看不到 = 装到别处去了，插件不会生效（而且**不报错**，只会静默什么都没发生）。
把装错的那份删掉，再用 `dsh plugin --profile mybot add ...` 重装一次。

## 配置项速查

| 配置 | 说明 |
|---|---|
| `telegramToken` / `telegramApiRoot` | TG 必填；apiRoot 指向代理时改 |
| `telegramAllowedUsers` | 允许的 TG 用户 ID；空 = 首个发消息者认领为主人 |
| `weixinToken` / `weixinApiRoot` / `weixinAccountFile` | 微信入口（通常用扫码登录，不用填 token） |
| `routes` + `defaultRouteKey` | 手工指定模型档位；留空 = 自动跟随 web 端「设置 → 模型」 |
| `cwd` | 模型的工作目录 |
| `memoryDir` / `memoryScript` | handoff 记忆接续：**默认开启**（`<工作目录>/memory` + 插件自带的记账程序），不用配；要关闭把 memoryDir 设成空串 |
| `restartCommand` | 重启用的启动器 .command 路径；不填默认找 `<工作目录>/启动-mybot.command` |
| `turnTimeoutMs` | 单轮超时，默认 30 分钟 |
| `asrBackend` / `asrWhisperBin` / `asrPythonBin` | 语音转文字（不填则语音报"没配"） |

## 远程审批（手机点按钮，不用守着电脑）

DSH 的审批服务用 waterfall 广播 `approval/request`，插件把它桥接到 Telegram——
推一张和 web 端审批面板**同口径**的卡片（`等待审批 / 已允许 / 已拒绝 / 已取消 / 已超时`
+ 命令、工作目录、原因），下面挂两个内联按钮【✅ 允许一次】【❌ 拒绝】。
点完卡片收成终态并去掉按钮。

> 桥是**只读旁路**：卡片渲染失败、编辑失败、按钮超时，统统只记日志，
> **绝不影响审批本身的结果**（该通过的照常通过）。
> 行动端入口在 `src/approval-bridge.js`，默认超时 10 分钟。

## 多端互通（TG ⇄ 微信，同一个大脑）

`src/hub.js` 是所有端点的唯一交汇点，纯逻辑、零依赖。两条规则，都是「同步到所有」：

| 方向 | 行为 |
|---|---|
| 端点到 hub | 同步给 ① DSH ② **其他所有端点** |
| DSH 到 hub | 同步发到**所有端点** |

新增端点 = 加一个数组项（O(n)），**不是**两两镜像（O(n²)）。
微信消息并入**主人的 TG 会话**，所以两边聊的是同一段上下文，
在微信里 `/new`、`/model` 操作的是同一个会话。

> ⛔ 这里刻意**不做去重/合并**：TG 和微信各进来一条就是两次真实输入，进来几条算几条。

## 指令

`/whoami` `/status` `/model` `/new`（新会话） `/restart`（重启进程，先留档） `/help`

> `/restart` 与老 bot 同路：先把进展写进 handoff，再由**进程外的接力脚本**延迟几秒杀掉宿主并重新拉起（有 `启动-mybot.command` 就重开终端窗口；没有就按原始命令行后台拉起）。两者都没有时退化为只重开会话。重启完成后发条消息，新会话自动带上刚才的记忆。

## 记忆（流水账 + handoff）

默认开启，什么都不用配：

- **流水账**：每轮对话原文追加到 `<工作目录>/memory/conversation-cache/raw/ledger/`，按月一个文件，只增不删。
- **handoff**：`/new`、切换模型（本次会话满 20 条才写，调试期反复切不会覆盖）、`/restart`（无条件）和启动补写时，把最近 20 条进展落盘到 `<工作目录>/memory/handoff/handoff.md`。
- **冷启动注入**：新会话的第一条消息会自动带上最近一次 handoff，模型直接接着上段干，不用你复述上文。
- 记账程序随插件自带（`vendor/conversation-cache/`），不依赖机器上是否装过 DSH 的其它项目。
- 想换位置或关闭：配置里写 `memoryDir`（自定路径；**空串 = 关闭**）、`memoryScript`（自定程序路径）。

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
