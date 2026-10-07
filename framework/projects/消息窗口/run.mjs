// run.mjs · 消息窗口总装（D12 通道注册制）：装配通道适配器 + 打包投递核心
// ⛔ 核心逻辑零通道分叉：通道 = 适配器三件套（收/发/归一）进注册表（modules/channels/），
//   加新通道 = 一个适配器文件 + 一行注册，本文件零改动；
//   类型 = 处理器进注册表（下方 注册类型处理器），加新类型 = 注册一个处理器，flush 零改动。
// 零数据：游标/令牌/打包缓冲/临时文件登记都只记内存；失败显式报告（防丢三件套见 access/weixin）
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, dispatch } from './modules/route/route.mjs';
import { createTgChannel } from './modules/channels/tg.mjs';
import { createWeixinChannel } from './modules/channels/weixin.mjs';
import { createRegistry } from './modules/channels/registry.mjs';
import { toText, concatMp3, 删临时文件, 扫尾临时文件 } from './modules/convert/convert.mjs';
import { start as 起api } from './modules/api/api.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toTimeString().slice(0, 8) + '.' + String(Date.now() % 1000).padStart(3, '0');
const log = (...a) => console.log(now(), ...a);

// —— 崩溃黑匣子（2026-10-06）：一天重启 17 次没留死因，先抓真凶再谈治本 ——
// console.error 走 stderr → 落 runner.err.log；退出后 launchd KeepAlive 负责拉起
process.on('uncaughtException', (e) => {
  console.error(`[崩溃] 未捕获异常 ${new Date().toISOString()}\n${e?.stack || e}`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(`[崩溃] 未处理的Promise拒绝 ${new Date().toISOString()}\n${e?.stack || e}`);
  process.exit(1);
});
process.on('SIGTERM', () => { console.error(`[退出] SIGTERM（launchd 主动重启）${new Date().toISOString()}`); process.exit(0); });
process.on('exit', (code) => console.error(`[退出] 退出码 ${code} ${new Date().toISOString()}`));

// 连接多段文字：段间加逗号；前段已有标点（。！？等）就不重复加
function 连接(数组, 标点 = '，') {
  const 尾标点 = /[。！？!?.…，,；;~]$/;
  let out = '';
  for (const seg of 数组) {
    const s = String(seg ?? '').trim();
    if (!s) continue;
    if (out && !尾标点.test(out)) out += 标点;
    out += s;
  }
  return out;
}

// —— 安全发送：通用三件套（重试 + message_id 唯一判据 + 显式失败），任何通道适配器通用 ——
// 重试次数由适配器自报（TG 底层无重试=3 次；微信 sendSafe 内置重试=1 次不叠罗汉）
async function 安全发送(适配器, chatId, 内容) {
  const 次 = Math.max(1, 适配器.重试次数 ?? 3);
  let lastErr = null;
  for (let i = 0; i < 次; i++) {
    try {
      const out = await 适配器.发(chatId, 内容);
      if (out?.message_id != null) return { ok: true, message_id: out.message_id };
      lastErr = new Error('无 message_id');
    } catch (e) {
      lastErr = e;
    }
    if (i < 次 - 1) await sleep(3000);
  }
  return { ok: false, 错误: String(lastErr?.message ?? lastErr) };
}

// —— 打包器：闲时 间隔秒 静默封包；忙闸门（2026-10-05 定稿）：上一包还在等项目回复时，
// 新消息全部攒住不投递，回复送达（/send 成功）才把攒的一起封包——比纯定时器更贴对话节奏。
// 保底：投递未全成 / 120 秒没回音 → 强制放行，顾客永不锁死。闸门状态只记内存（零数据）。
function makeBatcher(item, cfg, 发送文字, 注册放行) {
  const buffers = new Map(); // key=通道:chatId → { parts, timer, 忙, 保底 }
  const 间隔ms = Math.max(0, Number(item.打包间隔秒 ?? 5)) * 1000;
  const 忙超时ms = 120 * 1000;

  function 投(key) {
    const b = buffers.get(key);
    if (!b || !b.parts.length) return;
    clearTimeout(b.timer);
    b.timer = null;
    const parts = b.parts;
    b.parts = [];
    b.忙 = true; // 先占闸门再投递，防两包并发
    clearTimeout(b.保底);
    b.保底 = setTimeout(() => 放行(key), 忙超时ms);
    b.保底.unref?.(); // 保底是安全网不是心跳：runner 有轮询循环常驻不差它吊场；unref 后测试进程不被 120s 计时器吊住（#23）
    flush(parts, item, cfg, 发送文字).then((全成) => {
      if (!全成) 放行(key); // 项目没接住 → 不会有回复，立刻放行
    }).catch((e) => {
      log('打包投递失败:', e?.message ?? e);
      放行(key);
    });
  }

  function 放行(key) {
    const b = buffers.get(key);
    if (!b?.忙) return;
    clearTimeout(b.保底);
    b.保底 = null;
    b.忙 = false;
    if (b.parts.length) 投(key); // 攒着的立刻封包，不再等 5 秒
  }

  注册放行?.(放行);

  return (m) => {
    const key = `${m.通道}:${m.chatId}`;
    const b = buffers.get(key) ?? { parts: [], timer: null, 忙: false, 保底: null };
    b.parts.push(m);
    if (b.忙) {
      buffers.set(key, b);
      log(`收段 ${b.parts.length}（${m.通道}:${m.chatId}），处理中先攒着，回复送达后一起打包`);
      return;
    }
    clearTimeout(b.timer);
    if (间隔ms === 0) {
      buffers.set(key, b);
      投(key);
      return;
    }
    b.timer = setTimeout(() => 投(key), 间隔ms);
    buffers.set(key, b);
    log(`收段 ${b.parts.length}（${m.通道}:${m.chatId}），静默 ${间隔ms / 1000}s 后封包`);
  };
}

// —— 消息类型注册表（D11）：类型 → 处理器；处理器(段们, 上下文) → [投递包] ——
// 加同类项 = 注册一个处理器（注册类型处理器('卡片', 处理卡片)），flush 主体零改动。
const 类型处理器们 = new Map();
export function 注册类型处理器(类型, 处理器) {
  类型处理器们.set(类型, 处理器);
}

// 语音：多段拼一条音频、转写整段一次；微信语音（服务端已转写、无文件）也走这里，只带文字不碰音频
async function 处理语音(段们, { item, cfg, 发送文字 }) {
  const files = 段们.map((p) => p.文件).filter(Boolean);
  const s = {
    类型: '语音',
    文件: files.length === 1 ? files[0] : files.length ? concatMp3(files) : null,
    文字: 连接(段们.map((p) => p.文字)), // 语音附带的文字说明
    通道: 段们[0].通道,
    chatId: 段们[0].chatId,
    项目: item.项目,
    段数: 段们.length,
  };
  if (s.文件 && cfg.转换器?.地址) {
    try {
      s.转文字 = await toText(s.文件, cfg);
      log('转文字:', JSON.stringify(s.转文字));
      // 语音回显：顾客看到自己说的话（「我：识别的文字」，跟主 bot 同款文案）
      if (s.转文字?.文本 && item.回显 !== false) {
        const r = await 发送文字(s.chatId, `我：${s.转文字.文本}`);
        log('语音回显:', JSON.stringify(r));
      }
    } catch (e) {
      log('转文字失败（投占位文字，防空话进模型）:', e?.message ?? e);
      s.文字 = s.文字 || '（患者发了语音，转写失败）'; // 空文字会让下游模型输出歪掉（2026-10-06 JSON 漏出事故）
      if (item.回显 !== false) {
        const r = await 发送文字(s.chatId, '语音转文字失败，请再说一次');
        log('失败回显:', JSON.stringify(r));
      }
    }
  }
  // 转写文本必须进「文字」字段，下游模型才看得见（2026-10-06 抽风真因：转写挂在 转文字 字段，模型收到空文字）
  s.文字 = 连接([s.转文字?.文本, s.文字].filter(Boolean));
  return [s];
}

// 图片：一张一包（标准消息.文件 = 本地临时路径，同机项目直接读；契约零数据）；
// 缺文件的异常态并进文字兜底（与旧「其余全当文字」的兜底语义一致）
function 处理图片(段们, { item }) {
  return 段们.filter((p) => p.文件).map((p) => ({
    类型: '图片',
    文件: p.文件,
    文字: 连接([p.文字].filter(Boolean)),
    通道: p.通道,
    chatId: p.chatId,
    项目: item.项目,
    段数: 1,
  }));
}

// 视频（#18 ② 新增占位）：文件透传，不转码不转写，一视频一包；下游要不要吃是项目的事
function 处理视频(段们, { item }) {
  return 段们.filter((p) => p.文件).map((p) => ({
    类型: '视频',
    文件: p.文件,
    文字: 连接([p.文字].filter(Boolean)),
    通道: p.通道,
    chatId: p.chatId,
    项目: item.项目,
    段数: 1,
  }));
}

// 文字（兼兜底）：连成一句，段间自动补标点
function 处理文字(段们, { item }) {
  return [{
    类型: '文字',
    文件: null,
    文字: 连接(段们.map((p) => p.文字)),
    通道: 段们[0].通道,
    chatId: 段们[0].chatId,
    项目: item.项目,
    段数: 段们.length,
  }];
}

注册类型处理器('语音', 处理语音);
注册类型处理器('图片', 处理图片);
注册类型处理器('视频', 处理视频);
注册类型处理器('文字', 处理文字);

// —— 封包投递：按类型查注册表组包 → 逐包 dispatch；成功即删临时文件（#18 ③），失败保留待查不静默 ——
// 导出供测试注入（tests/fake-channel.mjs：假通道/假类型不改核心走通）
export async function flush(parts, item, cfg, 发送文字) {
  const 上下文 = { item, cfg, 发送文字 };
  const 组 = new Map(); // 类型 → [段们]
  for (const p of parts) {
    const 类型 = p.类型 ?? '其他';
    // 图片/视频缺文件（异常态）与未注册类型一样走文字兜底，保持旧「其余全当文字」的兜底语义
    const key = 类型处理器们.has(类型) && !(类型 === '图片' && !p.文件) ? 类型 : '兜底文字';
    if (!组.has(key)) 组.set(key, []);
    组.get(key).push(p);
  }
  const 投递s = [];
  for (const [类型, 段们] of 组) {
    const 处理器 = 类型处理器们.get(类型) ?? 处理文字; // 未注册类型 → 文字兜底
    投递s.push(...await 处理器(段们, 上下文));
  }

  let 全成 = true;
  for (const s of 投递s) {
    log(`打包投递（${s.段数} 段）:`, JSON.stringify({ ...s, 文字: String(s.文字).slice(0, 60) }));
    try {
      const 响应 = await dispatch(s, cfg);
      log(`已推给「${item.项目}」`);
      删临时文件(s.文件); // 投递成功即删（#18 ③）：谱系把原始文件/中间品一并带走
      // 项目接住了但回复没送到顾客（回发失败）→ 兜底：拿回复文本直接发顾客（2026-10-06 静默丢回复的洞）
      if (响应?.已回发 === false) {
        const 兜底 = await 发送文字(s.chatId, String(响应.回复文本 || '系统繁忙，请稍后再试。'));
        log('回发兜底:', JSON.stringify(兜底));
      }
    } catch (e) {
      全成 = false;
      log(`推给「${item.项目}」失败（临时文件保留待查: ${s.文件 ?? '无'}）:`, e?.message ?? e);
      // 投递失败也要让顾客知道（2026-10-06：任何失败必须有回显）——现在所有通道一视同仁
      const 失败提示 = await 发送文字(s.chatId, '系统繁忙，刚才那条消息可能没收到，麻烦再发一次。');
      log('投递失败回显:', JSON.stringify(失败提示));
    }
  }

  // 回显一次：语音整段转写 + 语音自带文字（微信服务端转写）+ 打的字 + 图片占位，都在
  if (item.回显 && 发送文字) {
    const 转写 = 投递s.find((s) => s.转文字?.开)?.转文字?.文本;
    const 语音说明 = 投递s.find((s) => s.类型 === '语音')?.文字;
    const 文字段 = 投递s.find((s) => s.类型 === '文字')?.文字;
    const 图数 = 投递s.filter((s) => s.类型 === '图片').length;
    const 回显文本 = 连接([转写, 语音说明, 文字段, 图数 ? `[图片]×${图数}` : ''].filter(Boolean));
    if (回显文本) {
      const r = await 发送文字(投递s[0].chatId, `我：${回显文本}`);
      log('回显:', JSON.stringify(r));
    }
  }
  return 全成; // 闸门判据：全成才等回复，否则立刻放行
}

// —— 装配（D12）：按配置起通道适配器、进注册表；配置说了算，装配层不做通道特判 ——
export function 装配通道们(cfg) {
  const registry = createRegistry();
  const 适配器们 = [];
  for (const item of cfg.项目们 ?? []) {
    if (item.token) 适配器们.push(createTgChannel(item));
    if (item.微信) {
      const wx适配器 = createWeixinChannel(item);
      if (wx适配器) 适配器们.push(wx适配器);
      else log(`[微信] ${item.项目} 凭据不可用，通道不起`);
    }
  }
  for (const a of 适配器们) registry.注册(a); // 缺三件套/重复注册在这里大声死
  return registry;
}

// —— 通道循环（通用，零通道分叉）：适配器.收 → 失败们统一回显 → 消息们进打包器 ——
async function 通道循环(适配器, cfg, batch, 发送文字) {
  for (;;) {
    try {
      const { 消息们, 失败们 } = await 适配器.收();
      for (const f of 失败们 ?? []) {
        log('失败清单:', JSON.stringify(f));
        // 拉取/处理失败必须让顾客知道（2026-10-06：任何失败必须有回显；不再依赖 item.回显 开关）
        if (f.chatId) {
          const r = await 发送文字(f.chatId, '刚才那条消息接收失败了，麻烦重发一次。');
          log('失败回显:', JSON.stringify(r));
        }
      }
      for (const m of 消息们 ?? []) {
        m.项目 = 适配器.项目;
        batch(m);
      }
    } catch (e) {
      log(`[${适配器.通道} ${适配器.项目}] 出错:`, e?.message ?? e);
      await sleep(3000);
    }
    if (适配器.轮询间隔ms > 0) await sleep(适配器.轮询间隔ms);
  }
}

// 每个适配器一套打包器+发送文字；闸门 key = token:通道（/send 送达后按此放行）
export function 建通道上下文(适配器, cfg, 闸门们) {
  const 发送文字 = (chatId, 文字) => 安全发送(适配器, chatId, { 类型: '文字', 文字 });
  const batch = makeBatcher(适配器.item, cfg, 发送文字, (放行) => 闸门们.set(`${适配器.token}:${适配器.通道}`, 放行));
  return { batch, 发送文字 };
}

// —— 送达放行（忙闸门的 /send 端，#23 回归锁定）：项目回复送达 → 按 token:通道 找闸门 → 按 通道:chatId 放行 ——
// 抽成导出：main 装配与 tests/fake-channel 闸门回归用同一份（测试测真接线，不复制算法）；
// 参数序 (token,通道,chatId) 与 api.mjs 送达调用对齐（#18 修过的存量错序 bug，此处再错忙闸门就瘫）。
export function 造送达放行(闸门们) {
  return (token, 通道, chatId) => 闸门们.get(`${token}:${通道}`)?.(`${通道}:${chatId}`);
}

// —— 总装：可测试（tests/fake-channel.mjs 注入假通道/假配置走通），isMain 才真起 ——
export async function main(cfg = loadConfig()) {
  const 残 = 扫尾临时文件(); // #18 ③：登记表只在内存，目录里现存的都是上个进程残骸——启动即清
  log(`[临时文件] 启动扫尾：清残骸 ${残.删了} 个 / ${(残.字节 / 1024 / 1024).toFixed(1)} MB`);
  const registry = 装配通道们(cfg);
  const 闸门们 = new Map(); // token:通道 → 放行(key)
  起api(
    造送达放行(闸门们), // 项目回复送达 → 放行该顾客的忙闸门
    (token, 通道) => registry.查找(token, 通道), // /send → 注册表查适配器，零通道分叉
  );
  const 上下文们 = new Map(); // 适配器 → { batch, 发送文字 }（测试注入时按适配器取）
  for (const a of registry.全部()) 上下文们.set(a, 建通道上下文(a, cfg, 闸门们));
  log(`消息窗口 runner 已起：通道 ${registry.全部().map((a) => a.通道).join(' + ') || '（无）'}，转换器${cfg.转换器?.地址 ? '开' : '关'}，打包间隔 ${cfg.项目们?.[0]?.打包间隔秒 ?? 3}s`);
  await Promise.allSettled([...上下文们.values()].map((上下文, i) => 通道循环(registry.全部()[i], cfg, 上下文.batch, 上下文.发送文字)));
}

const isMain =
  process.argv[1] &&
  decodeURIComponent(import.meta.url) === `file://${realpathSync(process.argv[1])}`;
if (isMain) await main();
