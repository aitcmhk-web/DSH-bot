#!/usr/bin/env node
/**
 * 微信扫码登录（dsh-botplugin 版）—— 从 BOT 的 weixin-login.mjs 移植。
 *
 * 与原版的**唯一差别**（其余流程逐行同构，含全部实测坑修复）：
 *   · 凭据落盘路径不写死在脚本目录 —— `--out <path>` 指定（安装器会生成
 *     指好的 启动命令），其次环境变量 WEIXIN_ACCOUNT_FILE，最后才回落
 *     当前目录 ./weixin-account.json。多用户/多实例各自指各自的文件。
 *   · 结尾提示改成「重启你的 bot」—— 插件没有 bot.sh。
 *
 * 用法:
 *   node weixin-login.mjs                # 终端渲染二维码
 *   node weixin-login.mjs --url-only     # 不渲染二维码，只打印链接
 *   node weixin-login.mjs --out <path>   # 指定凭据落盘路径
 *   node weixin-login.mjs --reuse        # 沿用旧 botId（默认全新建 bot，见下）
 *
 * 作用:
 *   1. 向微信 iLink 服务端（ilinkai.weixin.qq.com）申请二维码
 *   2. 终端渲染二维码（macOS 原生 CoreImage，零 npm 依赖，见 qr-terminal.mjs）+ 备用链接
 *   3. 扫码成功拿到 bot_token / baseurl / 扫码者微信 userId
 *   4. 凭据写入账号文件（0600）；插件启动时读取 → 微信入口自动启用
 *
 * 扫码者 = bot 的「主人」，只允许他使用。
 *
 * ⚠️ 两个已知坑（2026-09-13 实测，原版注释照录）:
 *   - 接口返回的 `qrcode_img_content` **是 URL 不是图片**。必须把它编码成二维码
 *     去扫；直接把这个 URL 拷进**电脑浏览器**会显示「二维码已过期」——
 *     那个页面是给微信内打开的。要在手机上用时，把链接发到微信里再点开。
 *   - **二维码实测约 2 分钟就过期**（2026-09-13 探测：125.6s 时服务端返回
 *     `expired`）。过期后本脚本会自动刷新，旧码立即作废，以最新一次为准。
 *     所以别慢慢复制链接 —— 直接扫屏幕。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTerminalQR } from './qr-terminal.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BASE_URL = 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = '3';
const LOGIN_TIMEOUT_MS = 8 * 60 * 1000; // 8 分钟
const MAX_QR_EXPIRES = 3;
const URL_ONLY = process.argv.includes('--url-only');
// ⚠️ `--fresh` = 不把旧 botId 回传给服务端（见下方 localTokenList 的说明）。
const FRESH = process.argv.includes('--fresh');

/** 凭据落盘路径：--out > 环境变量 > ./weixin-account.json。 */
function accountFile() {
  const i = process.argv.indexOf('--out');
  if (i !== -1 && process.argv[i + 1]) return resolvePath(process.argv[i + 1]);
  if (process.env.WEIXIN_ACCOUNT_FILE) return resolvePath(process.env.WEIXIN_ACCOUNT_FILE);
  return resolvePath(join(process.cwd(), 'weixin-account.json'));
}
const ACCOUNT_FILE = accountFile();

// 与官方 openclaw-weixin@2.4.8 对齐的报头。
const CHANNEL_VERSION = '2.4.8';
const ILINK_APP_ID = 'bot';
const BOT_AGENT = 'DSH-Weixin/1.0.0';

function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((p) => parseInt(p, 10));
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}
const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION); // 0x020408

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authHeaders(token) {
  const uint32 = Math.floor(Math.random() * 0xffffffff);
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(uint32, 0);
  const headers = {
    'Content-Type': 'application/json',
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(buf.readUInt32BE(0)), 'utf-8').toString('base64'),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function post(endpoint, body, token) {
  const url = new URL(endpoint, BASE_URL + '/');
  const res = await fetch(url, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function get(endpoint, token) {
  const url = new URL(endpoint, BASE_URL + '/');
  const res = await fetch(url, { method: 'GET', headers: authHeaders(token) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function fetchQRCode(localTokenList) {
  return post(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, { local_token_list: localTokenList });
}

async function pollQRStatus(qrcode, verifyCode) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    return await get(endpoint);
  } catch (err) {
    console.warn(`状态轮询出错（将重试）: ${err.message}`);
    return { status: 'wait' };
  }
}

function readLine(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let acc = '';
    const onData = (chunk) => {
      acc += chunk.toString();
      if (acc.includes('\n')) {
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        resolve(acc.trim());
      }
    };
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', onData);
  });
}

function showQR(url, { fresh = false } = {}) {
  const art = URL_ONLY ? null : renderTerminalQR(url);
  console.log('\n' + (fresh ? '🔄 二维码已刷新（上面那个作废）：' : '📱 请用手机微信「扫一扫」下面的二维码：') + '\n');
  if (art) {
    console.log(art);
    console.log('\n（终端字号别太小、别换行；扫不动就用下面的链接）');
  } else if (!URL_ONLY) {
    console.log('（本机无法在终端渲染二维码 —— 请用下面的链接）');
  }
  // 备用：把链接发到手机微信里点开；⚠️ 电脑浏览器打开会显示「已过期」。
  console.log('\n备用链接（发到手机微信里点开，**不要**用电脑浏览器）：\n  ' + url);
  console.log('\n⏳ 二维码实测约 2 分钟就过期；过期会自动刷新，以最新一次为准 —— 请直接扫屏幕。');
}

function saveAccount(statusObj) {
  const account = {
    botId: statusObj.ilink_bot_id,
    token: statusObj.bot_token,
    baseUrl: statusObj.baseurl || BASE_URL,
    ownerWxUserId: statusObj.ilink_user_id,
    createdAt: Date.now(),
  };
  writeFileSync(ACCOUNT_FILE, JSON.stringify(account, null, 2) + '\n', { mode: 0o600 });
  return account;
}

async function main() {
  console.log(`微信扫码登录 — 凭据将保存到：${ACCOUNT_FILE}`);
  console.log('正在向微信申请二维码…');

  // ⚠️ 为什么默认**不回传**旧 botId（2026-09-19 实测，原版注释照录）：
  //    旧 botId 若在服务端已失效，服务端直接拒绝整个申请（ret:-3），
  //    连二维码都不给 —— 那正是「想重扫但扫不了」的真凶。
  //    ⇒ 默认全新建 bot（空列表）。要沿用旧 bot 时用 `--reuse` 显式打开。
  const REUSE = process.argv.includes('--reuse');
  let localTokenList = [];
  if (REUSE) {
    try {
      const old = JSON.parse(readFileSync(ACCOUNT_FILE, 'utf8'));
      if (old?.botId) localTokenList = [old.botId];
    } catch {}
  } else if (!FRESH) {
    console.log('（全新建 bot 模式：不回传旧 botId；要沿用旧的加 --reuse）');
  }

  let qr;
  try {
    qr = await fetchQRCode(localTokenList);
  } catch (err) {
    console.error('❌ 申请二维码失败：' + err.message);
    console.error('   请检查网络能否访问 ilinkai.weixin.qq.com');
    process.exit(1);
  }
  if (!qr.qrcode || !qr.qrcode_img_content) {
    console.error('❌ 服务端未返回二维码：' + JSON.stringify(qr));
    process.exit(1);
  }
  showQR(qr.qrcode_img_content);

  let qrcode = qr.qrcode;
  let pendingVerifyCode = undefined;
  let qrExpireCount = 0;
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const status = await pollQRStatus(qrcode, pendingVerifyCode);

    switch (status.status) {
      case 'wait':
        break;
      case 'scaned':
        process.stdout.write('.');
        break;
      case 'need_verifycode':
        pendingVerifyCode = await readLine(
          pendingVerifyCode ? '❌ 配对码不匹配，请重新输入：' : '请输入手机微信上显示的数字：',
        );
        continue;
      case 'verify_code_blocked':
        console.error('\n⛔ 配对码多次输错，请稍后再试。');
        process.exit(1);
        break;
      case 'expired':
        qrExpireCount += 1;
        if (qrExpireCount > MAX_QR_EXPIRES) {
          console.error('二维码多次失效，请重新运行本脚本。');
          process.exit(1);
        }
        console.log('\n二维码过期，正在刷新…');
        try {
          const fresh = await fetchQRCode(localTokenList);
          qrcode = fresh.qrcode;
          pendingVerifyCode = undefined;
          showQR(fresh.qrcode_img_content, { fresh: true });
        } catch (err) {
          console.error('刷新二维码失败：' + err.message);
        }
        break;
      case 'binded_redirect':
        console.log('\n✅ 这个微信 bot 之前已连接过，凭据仍有效。');
        return;
      case 'scaned_but_redirect':
        console.log('检测到线路切换，继续等待确认…');
        break;
      case 'confirmed': {
        const account = saveAccount(status);
        console.log('\n🎉 微信连接成功！凭据已保存到 ' + ACCOUNT_FILE);
        console.log('  bot id:   ' + account.botId);
        console.log('  主人微信: ' + account.ownerWxUserId);
        console.log('  服务端:   ' + account.baseUrl);
        console.log('\n重启你的 bot 以启用微信入口（停掉再启动即可）。');
        console.log('扫码的这个微信就是主人 —— 只有它能和 bot 对话。');
        return;
      }
      default:
        console.log('未知状态：' + status.status);
        break;
    }
    await sleep(1000);
  }

  console.error('\n登录超时，请重新运行本脚本。');
  process.exit(1);
}

main().catch((err) => {
  console.error('错误：' + err.message);
  process.exit(1);
});
