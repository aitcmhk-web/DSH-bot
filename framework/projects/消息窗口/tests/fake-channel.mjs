// fake-channel.mjs · #18 验收演示（D11 通用判据）：注册一个假通道适配器 / 假类型处理器，不改核心收发走通
// 附带验收：/send 注册表查找（零通道分叉）+ 送达参数序 + 临时文件生命周期（登记/成功即删/失败保留/扫尾归零）
// 全程不碰真 token / 真临时目录 / 9320 端口（api 用 PORT=0 随机端口起）。
// ⚠️ 端口 env 必须设在任何动态 import 之前——api.mjs 顶层固化 PORT，随 run.mjs 的 import 链加载。
process.env.窗口端口 = '0';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let 过 = 0;
const 失败们 = [];
function 断言(名, 条件, 附注) {
  if (条件) { 过++; console.log(`  ✅ ${名}`); }
  else { 失败们.push(名); console.log(`  ❌ ${名}${附注 ? ` —— ${附注}` : ''}`); }
}

// —— 假项目接收端：把收到的标准消息记下来，可切换「已回发」行为 ——
const 项目收到的 = [];
let 已回发 = true;
let 回复文本 = '项目回复A';
const 假项目服务 = createServer((req, res) => {
  let d = '';
  req.on('data', (c) => (d += c));
  req.on('end', () => {
    项目收到的.push(JSON.parse(d || '{}'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ 已回发, 回复文本 }));
  });
});
await new Promise((ok) => 假项目服务.listen(0, '127.0.0.1', ok));
const 项目地址 = `http://127.0.0.1:${假项目服务.address().port}/receive`;

// —— 假通道适配器：三件套齐（收/发/归一），发=记录并回 message_id ——
const 发出的 = [];
const 待收 = [];
const 假通道 = {
  通道: '假通道',
  token: 'fake-token',
  项目: '假项目',
  item: { 项目: '假项目', 接收地址: 项目地址, 打包间隔秒: 0, 回显: true },
  轮询间隔ms: 0,
  重试次数: 1,
  async 收() { return { 消息们: 待收.splice(0), 失败们: [] }; },
  归一: (原始) => 原始,
  async 发(chatId, 内容) { 发出的.push({ chatId, 内容 }); return { message_id: `fake-${发出的.length}` }; },
};

console.log('—— ① 注册表：缺三件套拒收 / 重复拒收 / 数量不限 ——');
const { createRegistry } = await import('../modules/channels/registry.mjs');
const registry = createRegistry();
try { registry.注册({ 通道: '残', token: 't' }); 断言('缺三件套应拒收', false); }
catch { 断言('缺三件套应拒收', true); }
registry.注册(假通道);
try { registry.注册({ ...假通道 }); 断言('重复注册应拒收', false); }
catch { 断言('重复注册应拒收', true); }
const 第二假通道 = { ...假通道, 通道: '假通道二', token: 'fake-token-2' };
registry.注册(第二假通道);
断言('注册表数量不限（两个假通道并存）', registry.全部().length === 2);

console.log('—— ② D11 演示：假通道走核心收发（flush→dispatch→假项目→发送函数回顾客）——');
const { flush, 装配通道们 } = await import('../run.mjs');
const cfg = { 项目们: [{ 项目: '假项目', 接收地址: 项目地址, 打包间隔秒: 0, 回显: true }] };
const item = cfg.项目们[0];
const 发送文字 = (chatId, 文字) => 假通道.发(chatId, { 类型: '文字', 文字 });
项目收到的.length = 0; 发出的.length = 0; 已回发 = true;
await flush([{ 类型: '文字', 文字: '你好', 通道: '假通道', chatId: 'c1', 项目: '假项目', 段数: 1 }], item, cfg, 发送文字);
断言('假项目收到标准消息', 项目收到的[0]?.类型 === '文字' && 项目收到的[0]?.文字 === '你好');
断言('回显走假通道.发（我：你好）', 发出的.some((x) => x.chatId === 'c1' && x.内容?.文字 === '我：你好'));

console.log('—— ③ D11 演示：注册假类型处理器，不改 flush 走通 ——');
注册类型处理器演示: {
  const { 注册类型处理器 } = await import('../run.mjs');
  注册类型处理器('假类型', (段们, 上下文) => 段们.map((p) => ({
    类型: '假类型', 文件: null, 文字: `假类型收到:${p.文字}`, 通道: p.通道, chatId: p.chatId, 项目: 上下文.item.项目, 段数: 1,
  })));
  项目收到的.length = 0;
  await flush([{ 类型: '假类型', 文字: 'X', 通道: '假通道', chatId: 'c1', 项目: '假项目', 段数: 1 }], item, cfg, 发送文字);
  断言('假类型包原样投给项目（未注册前会掉文字兜底，注册后零改动生效）', 项目收到的[0]?.类型 === '假类型' && 项目收到的[0]?.文字 === '假类型收到:X');
}

console.log('—— ④ 临时文件生命周期：登记→成功即删 / 失败保留 / 未登记不删 / 扫尾归零 ——');
const { 存临时文件, 删临时文件, 扫尾临时文件 } = await import('../modules/convert/convert.mjs');
const dirB = mkdtempSync(join(tmpdir(), 'mwindow-test-'));
项目收到的.length = 0; 已回发 = true;
const p1 = 存临时文件(Buffer.from('A'), 'a.bin', dirB);
断言('谁写谁登记（文件在）', existsSync(p1));
await flush([{ 类型: '图片', 文件: p1, 文字: '', 通道: '假通道', chatId: 'c1', 项目: '假项目', 段数: 1 }], item, cfg, 发送文字);
断言('投递成功即删（#18 ③）', !existsSync(p1));
const p2 = 存临时文件(Buffer.from('B'), 'b.bin', dirB);
const 坏cfg = { 项目们: [{ 项目: '假项目', 接收地址: 'http://127.0.0.1:1/receive', 打包间隔秒: 0, 回显: true }] };
await flush([{ 类型: '图片', 文件: p2, 文字: '', 通道: '假通道', chatId: 'c1', 项目: '假项目', 段数: 1 }], item, 坏cfg, 发送文字);
断言('投递失败保留待查不静默（#18 ③）', existsSync(p2));
const p3 = join(dirB, '手动写的未登记文件.bin');
writeFileSync(p3, 'C');
删临时文件(p3);
断言('未登记的文件不删（防误删防御）', existsSync(p3));
const dirC = mkdtempSync(join(tmpdir(), 'mwindow-sweep-'));
for (let i = 0; i < 3; i++) writeFileSync(join(dirC, `残骸${i}.tmp`), 'x');
const 扫 = 扫尾临时文件(dirC);
断言('启动扫尾报数正确', 扫.删了 === 3 && 扫.字节 > 0, JSON.stringify(扫));
断言('扫尾后残骸归零（#18 验收判据）', readdirSync(dirC).length === 0);

console.log('—— ⑤ /send 全链：注册表查找（零通道分叉）+ 送达参数序 ——');
const { start: 起api } = await import('../modules/api/api.mjs');
const 送达记录 = [];
const api服务 = 起api((token, 通道, chatId) => 送达记录.push([token, 通道, chatId]), (token, 通道) => registry.查找(token, 通道));
await new Promise((ok) => api服务.once('listening', ok));
const api端口 = api服务.address().port;
async function postSend(body) {
  const r = await fetch(`http://127.0.0.1:${api端口}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { 状态: r.status, body: await r.json() };
}
发出的.length = 0;
const r1 = await postSend({ token: 'fake-token', 通道: '假通道', chatId: 'c1', 类型: '文字', 文字: '回信测试' });
断言('/send 经注册表走假通道.发', r1.状态 === 200 && r1.body.message_id === `fake-${发出的.length}` && 发出的[0]?.内容?.文字 === '回信测试');
断言('送达回调参数序 token,通道,chatId（#18 顺手修的存量 bug）', JSON.stringify(送达记录.at(-1)) === JSON.stringify(['fake-token', '假通道', 'c1']));
const r2 = await postSend({ token: '没注册', 通道: '假通道', chatId: 'c1', 类型: '文字', 文字: 'x' });
断言('未起通道报错口径明确', r2.状态 === 400 && String(r2.body.错误).includes('没起 假通道 通道'));

console.log('—— ⑥ 微信适配器装配：凭据不可用不起通道（不静默）+ CTX 缺失口径 ——');
const { createWeixinChannel, CTX缺失 } = await import('../modules/channels/weixin.mjs');
断言('凭据不可用 → 适配器为 null（装配层跳过）', createWeixinChannel({ token: 't', 微信: {} }) === null);
断言('context_token 缺失报错口径已定义', typeof CTX缺失 === 'string' && CTX缺失.includes('context_token'));

// —— 装配线冒烟：配置驱动装配（假配置 → 假形状无法进 createTg/createWeixin，只验装配不炸）——
console.log('—— ⑦ 装配冒烟：无 token 无微信 → 注册表为空不炸 ——');
const 空registry = 装配通道们({ 项目们: [{ 项目: '空项目' }] });
断言('空配置装配不炸、注册表为空', 空registry.全部().length === 0);

// —— ⑧ 忙闸门端到端（#23）：攒住的第二条消息必须由 /send 送达放行，且在 120 秒保底之前 ——
// 走生产真接线：建通道上下文（真 makeBatcher/放行/投）+ 造送达放行（真闸门 key 拼法）+ 真 api /send。
console.log('—— ⑧ 忙闸门端到端：/send 送达 → 攒住的消息放行（≤2 秒，保底之前）——');
{
  const { 造送达放行, 建通道上下文 } = await import('../run.mjs');
  const 等待 = async (条件, 上限ms = 3000) => {
    const 止 = Date.now() + 上限ms;
    while (!条件()) { if (Date.now() > 止) return false; await new Promise((r) => setTimeout(r, 20)); }
    return true;
  };
  const 闸门们 = new Map();
  const 闸门registry = createRegistry();
  闸门registry.注册(假通道);
  const 上下文 = 建通道上下文(假通道, cfg, 闸门们);
  const 闸门api = 起api(造送达放行(闸门们), (t, c) => 闸门registry.查找(t, c));
  await new Promise((ok) => 闸门api.once('listening', ok));
  const 闸门端口 = 闸门api.address().port;
  项目收到的.length = 0; 发出的.length = 0; 已回发 = true;
  上下文.batch({ 类型: '文字', 文字: '第一句', 通道: '假通道', chatId: 'c9', 项目: '假项目', 段数: 1 });
  断言('第一包投出、闸门进忙（项目已收到）', await 等待(() => 项目收到的.length === 1) && 项目收到的[0]?.文字 === '第一句');
  上下文.batch({ 类型: '文字', 文字: '第二句', 通道: '假通道', chatId: 'c9', 项目: '假项目', 段数: 1 });
  await new Promise((r) => setTimeout(r, 150));
  断言('忙闸门把第二条攒住（未到项目）', 项目收到的.length === 1);
  const t0 = Date.now();
  const rr = await fetch(`http://127.0.0.1:${闸门端口}/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'fake-token', 通道: '假通道', chatId: 'c9', 类型: '文字', 文字: '项目回复' }),
  });
  const 送达ok = rr.status === 200 && 'message_id' in (await rr.json());
  const 放行了 = await 等待(() => 项目收到的.length === 2, 2000);
  const 放行耗时 = Date.now() - t0;
  断言('/send 成功送达（判据 message_id）', 送达ok);
  断言('回复送达 → 攒住的第二条 ≤2 秒放行投递（120 秒保底之前）', 放行了 && 项目收到的[1]?.文字 === '第二句' && 放行耗时 < 2000, `实际 ${放行耗时}ms，收到 ${项目收到的.length} 条`);
  闸门api.close();
}

api服务.close(); 假项目服务.close();
console.log(`\n结果：${过} 过 / ${失败们.length} 败${失败们.length ? ` → ${失败们.join('；')}` : ''}`);
if (失败们.length) process.exit(1);
console.log('ALL PASS');
