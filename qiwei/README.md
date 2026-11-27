# DSH 企微 sidecar（hub.mjs）

企业微信自建应用 ↔ 主 bot 的独立桥接进程。只监听 `127.0.0.1:8790`，公网入口由腾讯 nginx/隧道转发。

## 职责

1. 收企微回调：验签、解密、白名单，把文字/图片归一成 JSON POST 给主 bot 的 `wecom` 端点；
2. 接主 bot 出站：`/hub/send` 发文字/markdown，`/hub/approval/ask` 发审批按钮卡；
3. 接按钮回执：`template_card_event` → `/hub/approval` 结算主 bot 的审批；
4. 主 bot 不在时消息落盘排队，回来后按时间补投。

## 文件

- `hub.mjs`：入口，HTTP 服务、回调验签、排队、审批卡与按钮
- `crypto.mjs`：企微 AES 加解密与签名
- `wecom.mjs`：`message/send`（文字/markdown/模板卡片）、`media/get`、`menu/create|delete`
- `config.example.json`：脱敏样例；真实配置放 `config.json`，权限 600，git 不收录

## 配置

| 字段 | 说明 |
|---|---|
| `corpId` / `agentId` / `secret` | 自建应用凭据 |
| `token` / `encodingAesKey` | 回调校验 |
| `allowedUserIds` | 只认这些企微 UserID；为空全拒 |
| `hubToken` | 与主 bot `wecomBridgeToken` 一致 |
| `hubUrl` | 主 bot wecom 端点，默认 `http://127.0.0.1:8793` |
| `port` / `path` | 本机监听端口与回调路径 |

运行时数据（队列、日志）用环境变量 `QIWEI_QUEUE_DIR` 指到数据目录，不要写进包目录。

## 审批卡

`/hub/approval/ask` 发 `button_interaction` 卡：

```text
按钮 key：qiwei_appr_ok_<id> / qiwei_appr_no_<id>
点击 → template_card_event → POST /hub/approval {id, action}
```

卡发不出去只发一条文字提示「请在 Telegram 上点按钮结算」（2026-11-27 起数字键 0-5 归指令菜单，不再用 1/2 结算审批）；重复点或超时后点，回「这条审批已经结束或超时」。

## 启动（生产）

launchd：`com.local.dsh.qiwei`，登录自启、KeepAlive。

```bash
launchctl print gui/$(id -u)/com.local.dsh.qiwei
curl -s http://127.0.0.1:8790/health
```

## 注意

- `config.json` 含 secret/Token/EncodingAESKey，不要提交、不要贴聊天；
- 企微「企业可信 IP」是动态公网 IP，换网要更新，否则 `60020`；
- 只有白名单 userid 能驱动主 bot，其他人只记日志。
