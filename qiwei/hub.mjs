// 企微 ↔ 主 bot Hub 的 sidecar。
//
// 只做三件事：
//   1. 企微回调验签/解密，把文字、图片归一成一条 JSON 交给主 bot 的 wecom 端点；
//   2. 接主 bot 的出站 POST，把回答用企微 message/send 发回主人；
//   3. 不启动 DSH、不建会话——会话在主 bot 里，和 TG/微信同一个。
//
// 公网入口仍是腾讯 nginx/TLS → SSH 隧道 → 127.0.0.1:<port>。

import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { 算签名, 签名相符, 解包, 取标签 } from './crypto.mjs';
import { 企微应用 } from './wecom.mjs';

const 本目录 = dirname(fileURLToPath(import.meta.url));
const 配置路径 = resolve(process.env.QIWEI_CONFIG || join(本目录, 'config.json'));
if (!existsSync(配置路径)) {
  console.error(`缺少配置：${配置路径}`);
  process.exit(1);
}
const 配置 = JSON.parse(readFileSync(配置路径, 'utf8'));
const 端口 = Number(process.env.QIWEI_PORT || 配置.port || 8790);
const 路径 = 配置.path || '/qiwei/callback';
const HUB地址 = String(process.env.QIWEI_HUB_URL || 配置.hubUrl || 'http://127.0.0.1:8793').replace(/\/$/, '');
const HUB令牌 = String(process.env.QIWEI_HUB_TOKEN || 配置.hubToken || '');
if (!HUB令牌) {
  console.error('缺少 hubToken：sidecar 不能裸奔');
  process.exit(1);
}

const 允许 = new Set(
  (process.env.QIWEI_ALLOWED_USERS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .concat(Array.isArray(配置.allowedUserIds) ? 配置.allowedUserIds : []),
);
const 主人 = String(配置.ownerUserId || [...允许][0] || '');

const 企微 = new 企微应用(配置);
/** 点「切换模型」后，下一条纯数字自动变成 /model N。 */
const 待选模型 = new Map();

/** 数字键 0-5 = 常驻指令菜单（2026-11-27 老板定：永久生效，⛔ 不用先按 0）。 */
/** 升级这类动作要二次审核：点了只发确认，回 y 才真投。 */
const 待确认 = new Map();
const 待确认毫秒 = 120_000;
/** 主 bot 发来的审批：按用户排队，只认卡片按钮结算（2026-11-27 去掉「回 1/2」，1/2 归指令菜单）。 */
const 待审批 = new Map();
const 审批毫秒 = 10 * 60 * 1000;
const 确认提示 = '升级会重启插件版，三个通道会断一小会儿。\n确认回 y，取消回 n。（120 秒内有效）';
const 菜单项 = {
  1: { 命令: '/new', 说明: '开启会话' },
  2: { 命令: '/model', 说明: '切换模型' },
  3: { 命令: '/status', 说明: '查看状态' },
  4: { 确认: '/setupdsh', 说明: '升级插件（需二次确认）' },
  5: { 命令: '/restart', 说明: '重启 BOT' },
};
const 菜单文字 = [
  '0 . 显示菜单',
  '1 . 开启会话',
  '2 . 切换模型',
  '3 . 查看状态',
  '4 . 升级插件',
  '5 . 重启BOT',
].join('\n');
const 队列目录 = process.env.QIWEI_QUEUE_DIR || join(本目录, '.hub-queue');
const 队列上限 = 80;
const 排队最长毫秒 = 24 * 60 * 60 * 1000;
const 补发间隔 = Math.max(500, Number(process.env.QIWEI_QUEUE_RETRY_MS || 15_000));
let 补发中 = false;
const 记 = (o) => console.log(JSON.stringify({ 时间: new Date().toISOString(), 动作: '企微Hub', ...o }));
const 截 = (s, n) => {
  const 文 = String(s ?? '').replace(/\s+/g, ' ').trim();
  return 文.length <= n ? 文 : `${文.slice(0, n - 1)}…`;
};

/** 企微会重试回调；同一 MsgId 10 分钟内只处理一次。 */
const 已见 = new Map();
function 首次见到(键) {
  const 现在 = Date.now();
  for (const [k, t] of 已见) if (现在 - t > 10 * 60 * 1000) 已见.delete(k);
  if (已见.has(键)) return false;
  已见.set(键, 现在);
  if (已见.size > 3000) 已见.delete(已见.keys().next().value);
  return true;
}

function 回JSON(res, 码, 体) {
  const 文 = JSON.stringify(体);
  res.writeHead(码, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(文),
  });
  res.end(文);
}

function 读体(req, 上限 = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const 块 = [];
    let 长 = 0;
    req.on('data', (c) => {
      长 += c.length;
      if (长 > 上限) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      块.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(块).toString('utf8')));
    req.on('error', reject);
  });
}

function 校验请求(req) {
  const 址 = new URL(req.url ?? '/', `http://127.0.0.1:${端口}`);
  const 查询 = 址.searchParams;
  const 签名 = 查询.get('msg_signature') ?? '';
  const 时间 = 查询.get('timestamp') ?? '';
  const 随机 = 查询.get('nonce') ?? '';
  return { 址, 签名, 时间, 随机 };
}

/** 队列文件按“时间-id”命名，补发时自然按先后走。 */
function 队列文件名(id) {
  const 安全 = String(id || randomUUID()).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
  return `${Date.now()}-${安全}.json`;
}

/**
 * 主 bot 暂时不在时落盘。
 *
 * 这是企微通道“最稳”的关键：sidecar 不依赖主 bot 进程活着；
 * 企微回调照收，消息先排队，主 bot 回来后补投。
 */
function 入队(item) {
  try {
    mkdirSync(队列目录, { recursive: true });
    const 文 = JSON.stringify({ ...item, at: Date.now() });
    const 名 = 队列文件名(item.id);
    const 临 = join(队列目录, `.tmp-${process.pid}-${名}`);
    writeFileSync(临, 文, { encoding: 'utf8', mode: 0o600 });
    renameSync(临, join(队列目录, 名));

    const 文件 = readdirSync(队列目录)
      .filter((x) => x.endsWith('.json'))
      .sort();
    if (文件.length > 队列上限) {
      for (const 旧 of 文件.slice(0, 文件.length - 队列上限)) {
        unlinkSync(join(队列目录, 旧));
      }
    }
    return true;
  } catch (错) {
    记({ 入队失败: 截(错?.message ?? 错, 200) });
    return false;
  }
}

/**
 * 交给主 bot。
 *
 * @returns {Promise<boolean>} true=已送达；false=已排队（等补发）；抛错=永久拒绝
 */
async function 发到Hub({ id, 用户ID, 正文, 图片块 = [] }, { 再排队 = true } = {}) {
  const 块 = [];
  if (正文) 块.push({ type: 'text', text: 正文 });
  块.push(...图片块);
  if (块.length === 0) return true;

  const 消息 = {
    id: id || randomUUID(),
    用户ID,
    正文: 正文 || '',
    图片块,
  };
  try {
    const 回 = await fetch(`${HUB地址}/hub/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-wecom-token': HUB令牌,
      },
      body: JSON.stringify({
        id: 消息.id,
        chatId: 用户ID,
        text: 正文 || '[图片]',
        blocks: 块,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (回.ok) return true;
    const 文 = await 回.text().catch(() => '');
    const 错 = new Error(`主 bot 拒收 HTTP ${回.status}${文 ? `: ${截(文, 200)}` : ''}`);
    错.永久 = 回.status >= 400 && 回.status < 500;
    throw 错;
  } catch (错) {
    if (!再排队 || 错?.永久) throw 错;
    const 成功 = 入队(消息);
    记({ 主bot不可用: 截(错?.message ?? 错, 200), 已排队: 成功, id: 消息.id });
    return false;
  }
}

/** 主 bot 回来后按时间顺序补投；失败就停，下一拍再试。 */
async function 补发队列() {
  if (补发中) return;
  补发中 = true;
  try {
    mkdirSync(队列目录, { recursive: true });
    const 文件 = readdirSync(队列目录).filter((x) => x.endsWith('.json')).sort();
    for (const 名 of 文件) {
      const 路径 = join(队列目录, 名);
      let 项;
      try {
        项 = JSON.parse(readFileSync(路径, 'utf8'));
      } catch {
        unlinkSync(路径);
        continue;
      }
      if (!项?.at || Date.now() - 项.at > 排队最长毫秒) {
        unlinkSync(路径);
        continue;
      }
      try {
        await 发到Hub(项, { 再排队: false });
        unlinkSync(路径);
        记({ 补发成功: 项.id });
      } catch (错) {
        记({ 补发暂停: 截(错?.message ?? 错, 200) });
        break;
      }
    }
  } finally {
    补发中 = false;
  }
}

/** 图片先下载再交给主 bot；下载失败只回一句，不把整条消息吞掉。 */
async function 处理图片(用户ID, 媒体ID, 投递ID) {
  try {
    const 图 = await 企微.取图片(媒体ID);
    const 送达 = await 发到Hub({
      id: 投递ID,
      用户ID,
      正文: '',
      图片块: [{ type: 'image', data: 图.data.toString('base64'), mediaType: 图.mimeType }],
    });
    if (!送达) await 企微.发文字(用户ID, '主 bot 暂时没接上，图片已排队，恢复后补投。').catch(() => {});
  } catch (错) {
    记({ 图片失败: 截(错?.message ?? 错, 240), 用户: 用户ID });
    await 企微.发文字(用户ID, `图片没收到：${截(错?.message ?? 错, 200)}`).catch(() => {});
  }
}

/** 自定义菜单 → 主 bot 命令。命令走同一条共享会话，不再操作本地子进程。 */
const 菜单命令 = {
  qiwei_new: '/new',
  qiwei_restart: '/restart',
  qiwei_model: '/model',
  qiwei_status: '/status',
};

/** 审批卡按钮 key：qiwei_appr_ok_<id> / qiwei_appr_no_<id>。 */
const 审批键 = /^qiwei_appr_(ok|no)_([A-Za-z0-9_-]{1,64})$/;

/** 结算一条审批：从队列摘掉 → 回调主 bot → 回一句人话。 */
async function 结算审批(用户ID, 编号, 允许) {
  const 列 = (待审批.get(用户ID) ?? []).filter((x) => x.到期 > Date.now() && x.id !== 编号);
  待审批.set(用户ID, 列);
  const 送达 = await 报审批(编号, 允许 ? 'ok' : 'no');
  记({ 审批: 允许 ? '允许' : '拒绝', id: 编号, 送达, 来源: '卡片' });
  // ⛔ 不再补发「已允许一次。」这类文字（2026-11-27 老板定）：结果由卡片按钮自己显示。
  return 送达;
}

/** 模板卡片按钮点击：只认审批键，其它一律记下忽略。 */
async function 处理卡片按钮(用户ID, 键, 回调 = {}) {
  const 配 = 审批键.exec(String(键 || ''));
  if (!配) {
    记({ 未接卡片按钮: 键 });
    return;
  }
  // 重复点同一张卡：队列里已经没有了，静默忽略（按钮此时已灰，正常点不到）。
  const 在列 = (待审批.get(用户ID) ?? []).some((x) => x.id === 配[2] && x.到期 > Date.now());
  if (!在列) {
    记({ 审批卡: '重复点击，已忽略', id: 配[2] });
    return;
  }
  const 允许 = 配[1] === 'ok';
  const 送达 = await 结算审批(用户ID, 配[2], 允许);
  // 点完就把这颗按钮改成结果并置灰（企微的 button.replace_name 就是「灰 + 不可点」）。
  // ⛔ 更新失败只记日志：不补发文字、不指路去 TG（2026-11-27 老板定「失败了就失败了」）。
  const 文案 = 送达 ? (允许 ? '✅ 已允许' : '❌ 已拒绝') : '⚠️ 未生效';
  // 更新接口是「整卡替换」：直接把这颗按成结果（style 2 = 灰），不再靠 button.replace_name
  //    —— 2026-11-27 实证：replace_name 返回 0，界面纹丝不动。
  const 按钮列 = [{ text: 文案, style: 2, type: 0, key: `qiwei_appr_${允许 ? 'ok' : 'no'}_${配[2]}` }];
  try {
    await 企微.更新卡片按钮(用户ID, 回调, 文案, 按钮列);
    记({ 审批卡: '已置灰', id: 配[2], 文案 });
  } catch (错) {
    // 没更新成 = 没有「变灰」这个反馈，必须补一句话，否则主人点了像没点（2026-11-27 实证）。
    记({ 审批卡: '更新失败，改发文字', id: 配[2], 错误: 截(错?.message ?? 错, 200) });
    await 企微.发文字(用户ID, 文案).catch(() => {});
  }
}

async function 处理事件(用户ID, 正文, 投递ID) {
  const 事件 = 取标签(正文, 'Event');
  const 键 = 取标签(正文, 'EventKey');
  if (事件 === 'template_card_event') {
    // response_code 一次性、72 小时内有效；task_id 是发卡时我们自己写的那串。
    await 处理卡片按钮(用户ID, 键, {
      responseCode: 取标签(正文, 'ResponseCode'),
      taskId: 取标签(正文, 'TaskId'),
    });
    return;
  }
  if (事件 !== 'click' && 事件 !== 'view') {
    记({ 忽略事件: 事件, 键 });
    return;
  }
  if (键 === 'qiwei_upgrade') {
    await 企微.发文字(用户ID, '升级插件请在 Telegram 里发 /setupdsh，企微这边不直接动生产。');
    return;
  }
  const 命令 = 菜单命令[键];
  if (命令) {
    const 送达 = await 发到Hub({ id: 投递ID, 用户ID, 正文: 命令 });
    if (!送达) await 企微.发文字(用户ID, '主 bot 暂时没接上，命令已排队。').catch(() => {});
    return;
  }
  记({ 未接菜单: 键 });
}

async function 处理消息(用户ID, 正文) {
  const 类型 = 取标签(正文, 'MsgType');
  const 消息ID = 取标签(正文, 'MsgId');
  const 事件 = 取标签(正文, 'Event');
  const 键 = 取标签(正文, 'EventKey');
  const 去重键 = `${消息ID || `${用户ID}:${取标签(正文, 'CreateTime')}`}:${类型}:${事件}:${键}`;
  if (!首次见到(去重键)) return;
  const 投递ID = 消息ID || randomUUID();

  if (类型 === 'event') {
    await 处理事件(用户ID, 正文, 投递ID);
    return;
  }
  if (类型 === 'text') {
    let 文字 = 取标签(正文, 'Content').trim();

    // 审核窗口：只有 y 才真投，n 或其它文字都作废
    const 确认 = 待确认.get(用户ID);
    if (确认) {
      if (确认.到期 <= Date.now()) {
        待确认.delete(用户ID);
      } else if (/^(y|yes|是)$/i.test(文字)) {
        待确认.delete(用户ID);
        const 送达 = await 发到Hub({ id: 投递ID, 用户ID, 正文: 确认.命令 });
        if (!送达) await 企微.发文字(用户ID, '主 bot 暂时没接上，命令已排队。').catch(() => {});
        记({ 已确认: 确认.命令, 用户: 用户ID });
        return;
      } else if (/^(n|no|否)$/i.test(文字)) {
        待确认.delete(用户ID);
        await 企微.发文字(用户ID, '已取消，没有升级。').catch(() => {});
        记({ 已取消: 确认.命令, 用户: 用户ID });
        return;
      } else {
        待确认.delete(用户ID);
      }
    }

    // 先看「刚发过模型清单」：那串数字是回答上一个问题，归模型选择
    const 模型到期 = 待选模型.get(用户ID) ?? 0;
    if (模型到期 > Date.now() && /^\d{1,2}$/.test(文字.trim())) {
      文字 = `/model ${文字.trim()}`;
      待选模型.delete(用户ID);
    } else if (/^\/model(?:\s|$)/i.test(文字.trim())) {
      待选模型.delete(用户ID);
    } else if (/^\/new(?:\s|$)/i.test(文字.trim())) {
      待选模型.delete(用户ID);
    } else if (/^[0-5]$/.test(文字)) {
      // 数字键 = 常驻指令菜单（2026-11-27 老板定：永久生效，⛔ 不用先按 0）
      if (文字 === '0') {
        await 企微.发文字(用户ID, 菜单文字).catch(() => {});
        记({ 菜单: '已弹出', 用户: 用户ID });
        return;
      }
      const 选 = 菜单项[文字];
      if (选?.确认) {
        待确认.set(用户ID, { 命令: 选.确认, 到期: Date.now() + 待确认毫秒 });
        await 企微.发文字(用户ID, 确认提示).catch(() => {});
        记({ 待确认: 选.确认, 用户: 用户ID });
        return;
      }
      if (选?.本地) {
        await 企微.发文字(用户ID, 选.说明).catch(() => {});
        return;
      }
      文字 = 选.命令;
    }

    if (文字) {
      const 送达 = await 发到Hub({ id: 投递ID, 用户ID, 正文: 文字 });
      if (!送达) await 企微.发文字(用户ID, '主 bot 暂时没接上，消息已排队，恢复后补投。').catch(() => {});
    }
    return;
  }
  if (类型 === 'image') {
    const 媒体 = 取标签(正文, 'MediaId');
    if (媒体) await 处理图片(用户ID, 媒体, 投递ID);
    return;
  }
  记({ 忽略类型: 类型, 用户: 用户ID });
}

async function 报审批(id, action) {
  try {
    const 回 = await fetch(`${HUB地址}/hub/approval`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-wecom-token': HUB令牌,
      },
      body: JSON.stringify({ id, action }),
      signal: AbortSignal.timeout(8000),
    });
    const 果 = await 回.json().catch(() => ({}));
    return Boolean(回.ok && 果?.handled);
  } catch (err) {
    记({ 审批回调失败: 截(err?.message ?? err, 200) });
    return false;
  }
}

const 服务 = createServer(async (req, res) => {
  try {
    const { 址, 签名, 时间, 随机 } = 校验请求(req);

    if (req.method === 'GET' && 址.pathname === '/health') {
      回JSON(res, 200, { ok: true, mode: 'wecom-hub', hub: HUB地址, port: 端口 });
      return;
    }

    if (req.method === 'GET' && 址.pathname === 路径) {
      const 密文 = 址.searchParams.get('echostr') ?? '';
      const 期望 = 算签名(配置.token, 时间, 随机, 密文);
      if (!签名相符(期望, 签名)) {
        res.writeHead(403).end('bad signature');
        return;
      }
      const { 正文 } = 解包(密文, 配置.encodingAesKey);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(正文);
      return;
    }

    if (req.method === 'POST' && 址.pathname === 路径) {
      const 体 = await 读体(req);
      const 密文 = 取标签(体, 'Encrypt');
      if (!密文) {
        res.writeHead(400).end('missing encrypt');
        return;
      }
      const 期望 = 算签名(配置.token, 时间, 随机, 密文);
      if (!签名相符(期望, 签名)) {
        res.writeHead(403).end('bad signature');
        return;
      }
      const { 正文, 接收方 } = 解包(密文, 配置.encodingAesKey);
      if (配置.corpId && 接收方 !== 配置.corpId) {
        res.writeHead(403).end('bad receiver');
        return;
      }
      const 用户ID = 取标签(正文, 'FromUserName');
      if (!用户ID || (允许.size > 0 && !允许.has(用户ID))) {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('success');
        记({ 拒绝用户: 用户ID });
        return;
      }

      // 企微要求 5 秒内回；先回成功，再异步处理。
      res.writeHead(200, { 'content-type': 'text/plain' }).end('success');
      处理消息(用户ID, 正文).catch((错) => {
        记({ 处理失败: 截(错?.stack ?? 错?.message ?? 错, 400), 用户: 用户ID });
        // 主 bot 没接上时给一句人话，避免用户发完石沉大海。
        企微.发文字(用户ID, `主 bot 没接上：${截(错?.message ?? 错, 180)}`).catch(() => {});
      });
      return;
    }

    if (req.method === 'POST' && 址.pathname === '/hub/approval/ask') {
      if (!签名相符(req.headers['x-dsh-wecom-token'], HUB令牌)) {
        回JSON(res, 401, { ok: false, error: 'bad token' });
        return;
      }
      const 体 = JSON.parse(await 读体(req, 256 * 1024));
      const 编号 = String(体?.id ?? '');
      const 目标 = String(体?.chatId || 主人 || '');
      const 正文 = String(体?.text ?? '');
      if (!编号 || !目标 || !正文) {
        回JSON(res, 400, { ok: false, error: 'id/chatId/text required' });
        return;
      }
      const 列 = (待审批.get(目标) ?? []).filter((x) => x.到期 > Date.now());
      列.push({ id: 编号, 到期: Date.now() + 审批毫秒 });
      待审批.set(目标, 列);
      // 真卡片：两个按钮直接结算；卡发不出去只提示去 TG 点（数字键已归指令菜单，不再吃 1/2）。
      const 卡片 = /^[A-Za-z0-9_-]{1,64}$/.test(编号)
        ? {
            card_type: 'button_interaction',
            main_title: { title: 'DSH 等待审批' },
            sub_title_text: 截(正文, 120),
            button_list: [
              { text: '允许一次', style: 1, type: 0, key: `qiwei_appr_ok_${编号}` },
              { text: '拒绝', style: 3, type: 0, key: `qiwei_appr_no_${编号}` },
            ],
            task_id: `qiwei_appr_${编号}_${Date.now().toString(36)}`,
          }
        : null;
      try {
        if (!卡片) throw new Error(`审批 id 含非法字符：${编号}`);
        await 企微.发卡片(目标, 卡片);
        记({ 审批卡: '已发卡片', id: 编号, 排队: 列.length });
      } catch (错) {
        // 卡发不出去就发不出去：⛔ 不补文字、⛔ 不叫人去 TG 点（2026-11-27 老板定）。
        //   审批本身在 TG 也有一张卡，那边点照样算；这边只留痕迹给排障。
        记({ 审批卡: '卡片失败（不补文字）', id: 编号, 错误: 截(错?.message ?? 错, 200) });
      }
      回JSON(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && 址.pathname === '/hub/send') {
      if (!签名相符(req.headers['x-dsh-wecom-token'], HUB令牌)) {
        回JSON(res, 401, { ok: false, error: 'bad token' });
        return;
      }
      const 体 = JSON.parse(await 读体(req, 1024 * 1024));
      const 目标 = String(体?.chatId || 主人 || '');
      const 文字 = String(体?.text ?? '');
      const 格式 = 体?.format === 'text' ? 'text' : 'markdown';
      if (!目标 || !文字) {
        回JSON(res, 400, { ok: false, error: 'chatId/text required' });
        return;
      }
      // 模型清单发出后 10 分钟内，允许主人直接回 1/2/3。
      if (/选择模型|可用模型/.test(文字)) {
        待选模型.set(目标, Date.now() + 10 * 60 * 1000);
      }
      await 企微.发文字(目标, 文字, 格式);
      回JSON(res, 200, { ok: true });
      return;
    }

    回JSON(res, 404, { ok: false, error: 'not found' });
  } catch (错) {
    记({ 请求失败: 截(错?.stack ?? 错?.message ?? 错, 400) });
    if (!res.headersSent) 回JSON(res, 500, { ok: false, error: 'internal error' });
    else res.destroy();
  }
});

服务.listen(端口, '127.0.0.1', () => {
  记({ 启动: true, 端口, 路径, 主人, hub: HUB地址, 队列: 队列目录 });
  // 主 bot 可能比 sidecar 晚起；启动后先补一次，再每 15 秒补。
  setTimeout(() => 补发队列().catch((错) => 记({ 补发失败: 截(错?.message ?? 错, 200) })), 800);
  setInterval(() => 补发队列().catch((错) => 记({ 补发失败: 截(错?.message ?? 错, 200) })), 补发间隔);
});

for (const 信号 of ['SIGINT', 'SIGTERM']) {
  process.on(信号, () => {
    记({ 退出: 信号 });
    服务.close(() => process.exit(0));
  });
}
