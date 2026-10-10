// test-review-multi.mjs — 审核卡「只认第一行」缺陷最小复现（任务 #71）。
//
// 判据（第 22 条）：从 src/index.js 抽**真实函数文本**（findReviewRow/findReviewRows + reviewTick）
// 直接跑，不复制算法。两行同时「待审核」时：
//   - 改前（只取第一行）：只发出 #17 一张卡 → 断言失败（红）
//   - 改后（扫所有行）  ：#17、#69 两张卡都发 → 断言通过（绿）
// 另测节流语义：每 #N 每进程恰发一次；发送失败下一轮重试，成功过的行不重发。
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const SRC = process.env.REVIEW_SRC ?? '/Users/tcm/DSH/BOT/src/index.js';
const idx = readFileSync(SRC, 'utf8');
console.log(`[被测源码] ${SRC}`);

/** 按函数名抽大括号配对的真实源码文本。 */
function extractFn(src, name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  if (start < 0) return null;
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`函数括号不平衡: ${name}`);
}

const findSrc = extractFn(idx, 'findReviewRows') ?? extractFn(idx, 'findReviewRow');
assert.ok(findSrc, 'src/index.js 里既没有 findReviewRow 也没有 findReviewRows');
const tickSrc = extractFn(idx, 'reviewTick');
assert.ok(tickSrc, 'src/index.js 里没有 reviewTick');
console.log(`[抽取] ${findSrc.split('\n')[0].trim()}`);

/** 每个场景用一份全新 harness（reviewCardsSent 每进程一次的状态要干净）。 */
function makeHarness(reviewerMode = true) {
  const body = `
    const reviewCardsSent = new Set();
    const REVIEWER_MODE = ${reviewerMode ? 'true' : 'false'};
    const sent = [];
    const errors = [];
    const failOnce = new Set();
    const log = () => {};
    const error = (...a) => errors.push(a.map(String).join(' '));
    // 打桩只记录「发给谁」——本 bug 的判据就是哪几行被发到，桩不比真实现宽容。
    const sendReviewCard = (row) => {
      sent.push(row.no);
      if (failOnce.has(String(row.no))) {
        failOnce.delete(String(row.no));
        return Promise.reject(new Error('模拟发送失败'));
      }
      return Promise.resolve();
    };
    ${findSrc}
    ${tickSrc}
    return { reviewTick, sent, reviewCardsSent, errors, failOnce };
  `;
  return new Function(body)();
}

const flush = () => new Promise((r) => setTimeout(r, 10));
const TABLE = [
  '# 任务表',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 17 | 更老的待审行 | 001bot | 待审核 | 等老板 |',
  '| 40 | 进行中的活 | 002bot | 进行中 | — |',
  '| 69 | 后面的待审行 | 004bot | 待审核 | 等老板 |',
].join('\n');

let failed = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  PASS ${label}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${label}`);
    console.log(`       ${e.message.split('\n')[0]}`);
  }
};

console.log('\n=== 场景 1：两行同时待审核 → 两行都必须发卡（本 bug 的判据） ===');
{
  const h = makeHarness();
  h.reviewTick(TABLE);
  await flush();
  console.log(`  [原始输出] sent=${JSON.stringify(h.sent)}`);
  check('两行都发（#17 和 #69）', () => assert.deepStrictEqual(h.sent, ['17', '69']));
}

console.log('\n=== 场景 2：节流 = 同一行不重复发；success 后再 tick 零新增 ===');
{
  const h = makeHarness();
  h.reviewTick(TABLE);
  await flush();
  h.reviewTick(TABLE);
  await flush();
  console.log(`  [原始输出] sent=${JSON.stringify(h.sent)}`);
  check('两次 tick 仍各恰一次', () => assert.deepStrictEqual(h.sent, ['17', '69']));
}

console.log('\n=== 场景 3：发送失败下一轮重试，成功行不重发 ===');
{
  const h = makeHarness();
  h.failOnce.add('17');
  h.reviewTick(TABLE);
  await flush();
  console.log(`  [原始输出] 第一轮 sent=${JSON.stringify(h.sent)} 失败留待重试=${JSON.stringify([...h.reviewCardsSent])}`);
  check('第一轮两行都尝试，#17 失败后未记入已发', () => {
    assert.deepStrictEqual(h.sent, ['17', '69']);
    assert.ok(!h.reviewCardsSent.has('17'), '#17 失败必须移除，下一轮重试');
    assert.ok(h.reviewCardsSent.has('69'), '#69 成功必须记住，不再重发');
  });
  h.reviewTick(TABLE);
  await flush();
  console.log(`  [原始输出] 第二轮 sent=${JSON.stringify(h.sent)}`);
  check('第二轮只重试 #17，#69 不重发', () => assert.deepStrictEqual(h.sent, ['17', '69', '17']));
}

console.log('\n=== 场景 4：REVIEWER_MODE 关闭 → 零发卡（角色门不许被动到） ===');
{
  const h = makeHarness(false);
  h.reviewTick(TABLE);
  await flush();
  console.log(`  [原始输出] sent=${JSON.stringify(h.sent)}`);
  check('门关时零发卡', () => assert.deepStrictEqual(h.sent, []));
}

console.log(`\n[结果] ${failed === 0 ? 'GREEN 全过 ✅' : `RED ${failed} 处失败 ❌`}（改前只发第一行会在此判红）`);
process.exit(failed === 0 ? 0 : 1);
