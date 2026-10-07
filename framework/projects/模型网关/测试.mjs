// 测试.mjs · #19 模型网关改造验收测试（跑法：node 测试.mjs）
// 四段：
//   ① 新旧对拍 —— 旧版（#19 改造前备份）与新版（注册表分发）双实例，同一组请求逐字段比响应+假上游收到的请求体
//   ② 演示链 —— 加假模型条目（假 key 走 env）→ POST /reload → /call 可达；删条目 → reload → 不可达（验收硬判据）
//   ③ reload fail-closed —— key 引用的 env 变量缺失 → reload 500 指名
//   ④ 类型注册「加同类项不改核心」—— 注册一个假类型处理器走通（D11）
// 全程不碰 9310 现网进程、不碰真模型表.json、不打印真 key（测试只用假 key）。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const 项目根 = dirname(fileURLToPath(import.meta.url));
const 工作区 = join('/tmp', `gw19-测试-${process.pid}`);
const 假上游端口 = 9410, 旧端口 = 9411, 新端口 = 9412;
let 过 = 0, 挂 = 0;

function 断言(名, 条件, 额外) {
  if (条件) { 过++; console.log(`  ✓ ${名}`); }
  else { 挂++; console.error(`  ✗ ${名}${额外 !== undefined ? ` —— ${JSON.stringify(额外)}` : ''}`); }
}

async function 等就绪(port, 名) {
  const 限时 = Date.now() + 5000;
  while (Date.now() < 限时) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/models`);
      if (r.ok) return;
    } catch {}
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error(`${名}（:${port}）5 秒没起来`);
}

async function post(port, 路径, 体) {
  const r = await fetch(`http://127.0.0.1:${port}${路径}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(体),
  });
  return { status: r.status, contentType: r.headers.get('content-type'), body: await r.text() };
}

async function postRaw(port, 路径, 原文) {
  const r = await fetch(`http://127.0.0.1:${port}${路径}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 原文,
  });
  return { status: r.status, body: await r.text() };
}

// ---------- 假上游（同一进程内）：按 authorization 分桶记录最后请求（供请求体对拍） ----------
const 收件桶 = new Map();
function 假上游服务() {
  return new Promise((ok) => {
    const s = createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/record') {
        const k = url.searchParams.get('k');
        const rec = 收件桶.get(k) ?? null;
        收件桶.delete(k);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(rec));
      }
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => {
        const auth = req.headers.authorization ?? '';
        收件桶.set(auth, { authorization: auth, contentType: req.headers['content-type'] ?? '', body: d });
        const 坏key = auth !== 'Bearer sk-test-fake' && auth !== 'Bearer sk-env-fake' && auth !== 'Bearer sk-demo-fake' && auth !== 'Bearer ';
        if (坏key) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'InvalidKey' }));
        }
        if (url.pathname === '/plain') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('纯文本应答');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '假上游应答' } }] }));
      });
    });
    s.listen(假上游端口, '127.0.0.1', () => ok(s));
  });
}

// ---------- 实例 ----------
function 起实例(cwd, 端口, env) {
  return spawn(process.execPath, ['modules/api/api.mjs'], { cwd, env: { ...process.env, ...env, 网关端口: String(端口) }, stdio: ['ignore', 'pipe', 'pipe'] });
}

const 假key = 'sk-test-fake';
// 共享表：新旧实例各一份内容相同（对拍基准一致）；envkey 条目对旧版=字面量 key（401→502 预期新能力差异）
const 共享表 = [
  { 名字: '假上游', 地址: `http://127.0.0.1:${假上游端口}/up`, key: 假key, 参数: {} },
  { 名字: '假上游·明文坏key', 地址: `http://127.0.0.1:${假上游端口}/up`, key: 'sk-wrong', 参数: {} },
  { 名字: '假上游·纯文本', 地址: `http://127.0.0.1:${假上游端口}/plain`, key: 假key, 参数: {} },
  { 名字: '假上游·envkey', 地址: `http://127.0.0.1:${假上游端口}/up`, key: '${GW_TEST_KEY}', 参数: {} },
  { 名字: 'AITCM·测试', 地址: `http://127.0.0.1:${假上游端口}/up`, key: 假key, 参数: { model: '测试模型', enable_thinking: false } },
  { 名字: 'AITCM·缺model', 地址: `http://127.0.0.1:${假上游端口}/up`, key: 假key, 参数: {} },
];
const env表 = 共享表;

// 对拍用例：[名, 请求体, 判定(响应)=>bool]
const 对拍用例 = [
  ['AITCM 信封 200 {原文}', { 项目: 'AITCM', 模块: '测试', 载荷: { 提示词: '你是测试', 症状: '头疼三天', chatId: '内部字段不上送' } },
    (r) => r.status === 200 && r.body === JSON.stringify({ 原文: '假上游应答' })],
  ['AITCM 带图信封', { 项目: 'AITCM', 模块: '测试', 载荷: { 图片: { base64: 'aGk=', mime: 'image/png' }, 主诉: '舌象' } },
    (r) => r.status === 200 && r.body === JSON.stringify({ 原文: '假上游应答' })],
  ['AITCM 未登记 400', { 项目: 'AITCM', 模块: '不存在', 载荷: {} },
    (r) => r.status === 400 && r.body === JSON.stringify({ 错误: '模型未登记（AITCM·不存在）' })],
  ['AITCM 缺 参数.model 500', { 项目: 'AITCM', 模块: '缺model', 载荷: { x: 1 } },
    (r) => r.status === 500 && r.body === JSON.stringify({ 错误: '表记录 AITCM·缺model 缺 参数.model' })],
  ['直通口 200 透传（content-type 原样）', { 模型名: '假上游·纯文本', 输入: { a: 1 } },
    (r) => r.status === 200 && r.contentType === 'text/plain; charset=utf-8' && r.body === '纯文本应答'],
  ['直通口 未登记 400', { 模型名: '查无此模', 输入: {} },
    (r) => r.status === 400 && r.body === JSON.stringify({ 错误: '模型未登记' })],
  ['直通口 坏key 502 上游401', { 模型名: '假上游·明文坏key', 输入: {} },
    (r) => r.status === 502 && JSON.parse(r.body).错误 === '模型不可达' && JSON.parse(r.body).上游状态 === 401 && JSON.parse(r.body).上游返回.includes('InvalidKey')],
  ['直通口 输入缺省 {}', { 模型名: '假上游' },
    (r) => r.status === 200 && JSON.parse(r.body).choices[0].message.content === '假上游应答'],
];

async function 假上游收到的(port, auth) {
  const r = await fetch(`http://127.0.0.1:${假上游端口}/record?k=${encodeURIComponent(auth)}`);
  return JSON.parse(await r.text());
}

// ---------- ④ 类型注册「加同类项不改核心」----------
async function 假类型演示() {
  const 代码 = `
    import * as 注册表 from ${JSON.stringify(join(项目根, 'modules/api/types/注册表.mjs'))};
    // 注册一个假类型处理器（新同类项：只加文件+一行注册，核心零改动）
    注册表.注册类型({
      名字: '假类型',
      说明: '测试用假协议',
      async 调用(记录, 上游体, key) {
        return { 可达: true, status: 200, contentType: 'application/json', text: JSON.stringify({ 假类型收到: { 记录: 记录.名字, 上游体, key } }) };
      },
    });
    const h = 注册表.条目的类型处理器({ 名字: '某条目', 类型: '假类型' });
    const 应答 = await h.调用({ 名字: '某条目', 地址: 'x' }, { a: 1 }, 'sk-fake');
    console.log(JSON.stringify(应答));
  `;
  const r = spawn(process.execPath, ['--input-type=module', '-e', 代码], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  r.stdout.on('data', (c) => (out += c));
  r.stderr.on('data', (c) => (err += c));
  await new Promise((ok) => r.on('close', ok));
  return { out, err };
}

// ---------- ③ reload fail-closed（env 缺失指名）----------
async function reload缺失演示(表路径, 变量名) {
  const 代码 = `
    import * as registry from ${JSON.stringify(join(项目根, 'modules/registry/registry.mjs'))};
    process.env.模型表路径 = ${JSON.stringify(表路径)};
    try { registry.reload(); console.log('没报错=错'); }
    catch (e) { console.log('抛了：' + e.message); }
  `;
  const r = spawn(process.execPath, ['--input-type=module', '-e', 代码], {
    env: { ...process.env, 模型表路径: 表路径 },
    // ⚠️ 故意不在 env 里放 ${变量名} 对应的值
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  r.stdout.on('data', (c) => (out += c));
  r.stderr.on('data', (c) => (err += c));
  await new Promise((ok) => r.on('close', ok));
  return { out, err, 变量名 };
}

// ---------- 主流程 ----------
const 假上游 = await 假上游服务();
const 孩子们 = [];
try {
  mkdirSync(工作区, { recursive: true });
  // 旧版实例：#19 改造前备份 + 测试表（旧 registry 写死 ROOT/模型表.json）
  const 旧目录 = join(工作区, '旧版');
  mkdirSync(join(旧目录, 'modules/api'), { recursive: true });
  mkdirSync(join(旧目录, 'modules/registry'), { recursive: true });
  cpSync(join(项目根, 'modules/api/api.mjs.bak.#19改造前-20261007-151711'), join(旧目录, 'modules/api/api.mjs'));
  cpSync(join(项目根, 'modules/registry/registry.mjs.bak.#19改造前-20261007-151711'), join(旧目录, 'modules/registry/registry.mjs'));
  writeFileSync(join(旧目录, '模型表.json'), JSON.stringify(共享表, null, 2));
  // 新版实例：项目内代码 + env 指共享表（绝对路径）+ env key
  writeFileSync(join(工作区, '共享表.json'), JSON.stringify(env表, null, 2));
  writeFileSync(join(工作区, '演示表.json'), JSON.stringify(env表.filter((m) => m.名字 !== '假上游·envkey'), null, 2));

  console.log('① 新旧对拍（旧版=#19 改造前备份，逐字段比响应与假上游收到的请求体）');
  const 旧 = 起实例(旧目录, 旧端口, {});
  const 新 = 起实例(项目根, 新端口, { 模型表路径: join(工作区, '共享表.json'), GW_TEST_KEY: 'sk-env-fake' });
  孩子们.push(旧, 新);
  await 等就绪(旧端口, '旧版实例');
  await 等就绪(新端口, '新版实例');

  for (const [名, 请求体, 判定] of 对拍用例) {
    const ro = await post(旧端口, '/call', 请求体);
    断言(`${名} · 旧版基准成立`, 判定(ro), ro);
    // AITCM 用例：先读走旧版的上游请求体记录，再打新版、读新版记录（假上游 /record 读了即清）
    let bo = null, bn = null;
    if (请求体.项目 === 'AITCM' && ro.status === 200) {
      bo = await 假上游收到的(旧端口, 'Bearer sk-test-fake');
    }
    const rn = await post(新端口, '/call', 请求体);
    断言(`${名} · 新旧响应逐字段一致`, ro.status === rn.status && ro.body === rn.body && ro.contentType === rn.contentType, { 旧: ro, 新: rn });
    if (bo) {
      bn = await 假上游收到的(旧端口, 'Bearer sk-test-fake');
      断言(`${名} · 上游请求体逐字段一致`, !!bn && JSON.stringify(bo) === JSON.stringify(bn), { 旧: bo, 新: bn });
    }
  }
  // AITCM 翻译产物形状直接断言（旧版=现网 9310 同款代码为真值基准，原样复刻）
  // ⚠️ 现网行为实测：system 拼的是系统字段**键名**（如「提示词」），不是提示词正文——疑似现网 bug（提示词正文被丢弃），
  //    形状红线内原样复刻不动，已单独上报主 bot 定夺。
  await post(旧端口, '/call', { 项目: 'AITCM', 模块: '测试', 载荷: { 图片: { base64: 'aGk=', mime: 'image/png' }, 提示词: '你是测试', 症状: '头疼三天', chatId: '内部字段' } });
  const 翻译基准 = await 假上游收到的(旧端口, 'Bearer sk-test-fake');
  const 翻译体 = JSON.parse(翻译基准.body);
  断言('AITCM 翻译：system=键名（现网行为原样复刻）、图片 data URL 在 user 最前、chatId 不上送',
    翻译体.messages.length === 2 && 翻译体.messages[0].role === 'system' && 翻译体.messages[0].content === '提示词'
    && 翻译体.messages[1].role === 'user' && Array.isArray(翻译体.messages[1].content) && 翻译体.messages[1].content[0].type === 'image_url'
    && 翻译体.messages[1].content[0].image_url.url === 'data:image/png;base64,aGk='
    && 翻译体.model === '测试模型' && JSON.stringify(翻译体.messages).includes('头疼三天') && !JSON.stringify(翻译体).includes('内部字段'),
    翻译体);
  await 假上游收到的(旧端口, 'Bearer sk-test-fake'); // 清桶
  // 新版打同一信封，请求体与旧版逐字节同
  await post(新端口, '/call', { 项目: 'AITCM', 模块: '测试', 载荷: { 图片: { base64: 'aGk=', mime: 'image/png' }, 提示词: '你是测试', 症状: '头疼三天', chatId: '内部字段' } });
  const 翻译新版 = await 假上游收到的(新端口, 'Bearer sk-test-fake');
  断言('AITCM 翻译：新版请求体与旧版逐字节一致', JSON.stringify(翻译新版) === JSON.stringify(翻译基准), { 旧: 翻译基准, 新: 翻译新版 });

  const m旧 = await fetch(`http://127.0.0.1:${旧端口}/models`).then((r) => r.text());
  const m新 = await fetch(`http://127.0.0.1:${新端口}/models`).then((r) => r.text());
  断言('GET /models 形状一致', m旧 === m新, { 旧: m旧, 新: m新 });
  const j404旧 = await post(旧端口, '/别的', {}); const j404新 = await post(新端口, '/别的', {});
  断言('404 形状一致', j404旧.status === 404 && j404新.status === 404 && j404旧.body === j404新.body);
  const jBad旧 = await postRaw(旧端口, '/call', '{坏'); const jBad新 = await postRaw(新端口, '/call', '{坏');
  断言('坏 JSON 400 形状一致', jBad旧.status === 400 && jBad旧.body === jBad新.body, { 旧: jBad旧, 新: jBad新 });
  // env 引用条目：新能力（旧版把 "${...}" 当字面量 → 401；新版解析 env → 200），不算形状破坏
  const env旧 = await post(旧端口, '/call', { 模型名: '假上游·envkey', 输入: {} });
  const env新 = await post(新端口, '/call', { 模型名: '假上游·envkey', 输入: {} });
  断言('env key：新版解析 ${GW_TEST_KEY} 可达（旧版字面量 401 属预期新能力差异）', env新.status === 200 && env旧.status === 502, { 旧: env旧.status, 新: env新.status });

  console.log('② 演示链（验收硬判据）：加假模型条目（假 key 走 env）→ reload → 可达；删 → reload → 不可达');
  const 演示表路径 = join(工作区, '演示表.json');
  // 起演示实例（env 带 GW_DEMO_KEY 假 key）
  const 演 = 起实例(项目根, 9413, { 模型表路径: 演示表路径, GW_DEMO_KEY: 'sk-demo-fake' });
  孩子们.push(演);
  await 等就绪(9413, '演示实例');
  const 不在 = await post(9413, '/call', { 模型名: '演示假模型', 输入: {} });
  断言('演示：条目未加时 /call 不可达（400 模型未登记）', 不在.status === 400 && JSON.parse(不在.body).错误 === '模型未登记', 不在);
  // 加条目（假 key 走 env 引用）
  const 表现值 = JSON.parse(readFileSync(演示表路径, 'utf8'));
  表现值.push({ 名字: '演示假模型', 地址: `http://127.0.0.1:${假上游端口}/up`, key: '${GW_DEMO_KEY}', 类型: 'chat', 参数: { model: '演示模型' } });
  writeFileSync(演示表路径, JSON.stringify(表现值, null, 2));
  const rl = await post(9413, '/reload', {});
  断言('演示：POST /reload 200 + 条数=6（5 条基础 + 新加 1 条）', rl.status === 200 && JSON.parse(rl.body).重读完成 === true && JSON.parse(rl.body).条数 === 6, rl);
  const 可达 = await post(9413, '/call', { 模型名: '演示假模型', 输入: {} });
  断言('演示：加条目 → reload → /call 可达（假 key 经 env 解析）', 可达.status === 200 && JSON.parse(可达.body).choices[0].message.content === '假上游应答', 可达);
  // 删条目
  writeFileSync(演示表路径, JSON.stringify(env表.filter((m) => m.名字 !== '假上游·envkey'), null, 2));
  const rl2 = await post(9413, '/reload', {});
  const 不可达 = await post(9413, '/call', { 模型名: '演示假模型', 输入: {} });
  断言('演示：删条目 → reload → /call 不可达（400 模型未登记）', rl2.status === 200 && 不可达.status === 400 && JSON.parse(不可达.body).错误 === '模型未登记', { rl2, 不可达 });

  console.log('③ reload fail-closed：key 引用的 env 变量缺失 → 指名报错');
  const 缺失表 = join(工作区, '缺失表.json');
  writeFileSync(缺失表, JSON.stringify([{ 名字: '缺key条目', 地址: `http://127.0.0.1:${假上游端口}/up`, key: '${GW_MISSING_KEY}' }], null, 2));
  const 缺 = await reload缺失演示(缺失表, 'GW_MISSING_KEY');
  断言('reload 缺 env 指名报错', 缺.out.includes('GW_MISSING_KEY') && 缺.out.includes('缺key条目'), 缺);

  console.log('④ 类型注册「加同类项不改核心」（D11）');
  const 假 = await 假类型演示();
  const 假应答 = (() => { try { return JSON.parse(假.out); } catch { return null; } })();
  断言('注册假类型处理器 → 条目类型=假类型 → 调用走通', !!假应答 && 假应答.可达 === true && String(假应答.text).includes('假类型收到'), { out: 假.out, err: 假.err });

  console.log('⑤ 零硬编码 grep（代码零写死上游端点/key）');
  let 硬编码命中 = [];
  for (const f of ['modules/api/api.mjs', 'modules/api/types/chat.mjs', 'modules/api/types/aitcm.mjs', 'modules/api/types/直通.mjs', 'modules/api/types/注册表.mjs', 'modules/registry/registry.mjs', 'modules/registry/env文件.mjs', 'scripts/key抽env.mjs']) {
    const 文 = readFileSync(join(项目根, f), 'utf8');
    if (/dashscope|aliyuncs|sk-[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9_\-]{8,}/i.test(文)) 硬编码命中.push(f);
  }
  断言('代码文件 grep 零写死上游端点/key', 硬编码命中.length === 0, 硬编码命中);
  断言('models.example.json 无真 key（key 全 env 引用/空）', (() => {
    const e = JSON.parse(readFileSync(join(项目根, 'models.example.json'), 'utf8'));
    return e.every((m) => !m.key || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(m.key));
  })());

  console.log('⑥ 迁移脚本实测（假旧表，项目副本内跑，不碰真表）');
  const 副本根 = join(工作区, '项目副本');
  cpSync(项目根, join(工作区, '项目副本'), { recursive: true, filter: (s) => !s.includes('logs') && !s.includes('临时文件') && !s.includes('.git') });
  writeFileSync(join(副本根, '模型表.json'), JSON.stringify([
    { 名字: 'A', 地址: 'https://例/compatible-mode/v1/chat/completions', key: 'sk-test-aaa', 参数: { model: 'qwen3.7-flash' } },
    { 名字: 'B', 地址: 'https://例/compatible-mode/v1/chat/completions', key: 'sk-test-aaa', 参数: { model: 'qwen-vl-max' } },
    { 名字: 'C', 地址: 'http://127.0.0.1:9911/v1/audio/transcriptions', key: '', 参数: {} },
  ], null, 2));
  const 迁 = spawn(process.execPath, ['scripts/key抽env.mjs'], { cwd: 副本根, stdio: ['ignore', 'pipe', 'pipe'] });
  let 迁out = '', 迁err = '';
  迁.stdout.on('data', (c) => (迁out += c));
  迁.stderr.on('data', (c) => (迁err += c));
  await new Promise((ok) => 迁.on('close', ok));
  const 新表生成 = existsSync(join(副本根, 'models.json')) ? JSON.parse(readFileSync(join(副本根, 'models.json'), 'utf8')) : null;
  const env生成 = existsSync(join(副本根, '.env')) ? readFileSync(join(副本根, '.env'), 'utf8') : '';
  断言('迁移：models.json 生成，同值 key 同变量、空 key 保留、类型推导对',
    !!新表生成 && 新表生成[0].key === '${GW_KEY_1}' && 新表生成[1].key === '${GW_KEY_1}' && 新表生成[2].key === ''
    && 新表生成[1].类型 === '视觉' && 新表生成[2].类型 === '转写' && 新表生成[0].类型 === 'chat' && 新表生成[0].参数.model === 'qwen3.7-flash',
    { 新表生成, 迁out, 迁err });
  断言('迁移：.env 生成且只一条 GW_KEY_1（同值去重）', env生成.trim() === 'GW_KEY_1=sk-test-aaa', env生成);
  断言('迁移：stdout 不泄漏 key 值', !迁out.includes('sk-test-aaa'), 迁out);
  断言('迁移：models.json 已存在时拒跑不覆盖', await (async () => {
    const 迁2 = spawn(process.execPath, ['scripts/key抽env.mjs'], { cwd: 副本根, stdio: ['ignore', 'pipe', 'pipe'] });
    let e2 = '';
    迁2.stderr.on('data', (c) => (e2 += c));
    await new Promise((ok) => 迁2.on('close', ok));
    return e2.includes('已存在');
  })());

  console.log(`\n===== 结果：${过} 过 / ${挂} 挂 =====`);
  process.exitCode = 挂 ? 1 : 0;
} finally {
  for (const c of 孩子们) { try { c.kill(); } catch {} }
  try { 假上游.close(); } catch {}
  await new Promise((ok) => setTimeout(ok, 200)); // 等端口释放、孩子退出
  try { rmSync(工作区, { recursive: true, force: true }); } catch {}
}
