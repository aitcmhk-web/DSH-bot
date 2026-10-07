// key抽env.mjs · 旧表（模型表.json，明文 key）→ 新表（models.json，key 走 "${ENV名}"）+ .env（真值）
// 部署时跑一次（总控/部署人执行，⛔ 不进自动流程）；跑完重启网关服务才吃到新表。
// 铁律：⛔ 本脚本任何路径都不打印 key 值——输出只报变量名和条目名。
// 用法：node scripts/key抽env.mjs [旧表路径]（缺省 ./模型表.json）
//   ① 读旧表 → 非空 key 按值去重 → 分配 env 变量名 GW_KEY_N
//   ② models.json：同条目（名字/地址/参数原样）+ key 换 "${GW_KEY_N}" + 类型推导（地址/名字/参数.model）
//   ③ .env：已有的行原样保留，缺的 GW_KEY_N=真值 追加（绝不覆盖已有值）
//   ④ 报告 + 提示重启
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { 解析env文本 } from '../modules/registry/env文件.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const 旧表路径 = process.argv[2] ? join(ROOT, process.argv[2]) : join(ROOT, '模型表.json');
const 新表路径 = join(ROOT, 'models.json');
const env路径 = join(ROOT, '.env');

if (!existsSync(旧表路径)) {
  console.error(`旧表不存在：${旧表路径}`);
  process.exit(1);
}
if (existsSync(新表路径)) {
  console.error(`models.json 已存在，不覆盖（防两份表并存）：${新表路径}。要重来先删/挪走它。`);
  process.exit(1);
}

const 旧表 = JSON.parse(readFileSync(旧表路径, 'utf8'));
if (!Array.isArray(旧表)) {
  console.error('旧表不是数组，形状不对，停。');
  process.exit(1);
}

// ① key 值去重 → 分配变量名（同一 key 复用同一变量，不复制多份）
const 值到变量 = new Map();
let 序号 = 0;
for (const m of 旧表) {
  const k = m?.key;
  if (typeof k === 'string' && k && !值到变量.has(k)) 值到变量.set(k, `GW_KEY_${++序号}`);
}

// ② 新表条目：key 换 env 引用；类型推导（仅语义标注，协议现同为 chat completions，可手改）
function 推类型(m) {
  const 地址 = String(m.地址 ?? '');
  const 名 = String(m.名字 ?? '');
  const model = String(m?.参数?.model ?? '');
  if (地址.includes('transcriptions') || 名.includes('转写') || 名.includes('转文字')) return '转写';
  if (/vl|vision/i.test(model)) return '视觉';
  return 'chat';
}
const 新表 = 旧表.map((m) => ({
  名字: m.名字,
  地址: m.地址,
  key: 值到变量.get(m.key) ? `\${${值到变量.get(m.key)}}` : '',
  类型: 推类型(m),
  ...(m.参数 && Object.keys(m.参数).length ? { 参数: m.参数 } : {}),
}));

// ③ .env：已有行保留，缺的追加（读旧表→写 env 是机器搬运，全程不打印）
const 已有 = existsSync(env路径) ? 解析env文本(readFileSync(env路径, 'utf8')) : {};
const 追加行 = [];
for (const [值, 名] of 值到变量) {
  if (已有[名] === undefined) 追加行.push(`${名}=${值}`);
}
if (追加行.length) appendFileSync(env路径, `${追加行.join('\n')}\n`);

writeFileSync(新表路径, `${JSON.stringify(新表, null, 2)}\n`);

// ④ 报告（只报名字，绝不报值）
console.log(`✅ 迁移完成：${旧表.length} 条条目 → ${新表路径}`);
console.log(`   env 变量：${[...值到变量.values()].join('、') || '（无需，旧表无 key）'} → 追加/补齐进 ${env路径}（已有 ${Object.keys(已有).length} 个变量保留未动）`);
console.log('   类型为脚本推导（转写/视觉/chat），可手改 models.json；改完 POST /reload 或重启服务生效。');
console.log('   下一步：重启网关服务（launchctl kickstart -k gui/$(id -u)/com.dsh.modelgw.api）吃新表。');
