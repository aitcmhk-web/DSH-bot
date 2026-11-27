/**
 * test-wecom-card-settle.mjs —— 企微审批卡「点完置灰改字」的回归（2026-11-27 A 方案）。
 *
 * 为什么单独一份：这条只能靠真发一张卡才看得到效果，但**请求体错一个字**就静默失败
 *   （errcode 不 0 时我们按老板口径只记日志、不补提示），线上表现是「点了没反应」，
 *   排障时根本看不出是字段写错还是企微不认。所以这里把请求体钉死：
 *     · 走的是 message/update_template_card，不是 message/send；
 *     · response_code / task_id 原样带上（都取自回调 XML，缺一个就更新不了）；
 *     · 按钮文案走 template_card.button.replace_name（企微的「灰 + 不可点」就是它）。
 *
 * 跑法：node test-wecom-card-settle.mjs
 * 退出码：0 = 全过；1 = 有用例失败。
 */

import { 企微应用 } from './qiwei/wecom.mjs';

let failed = 0;
const check = (cond, msg) => {
  if (cond) console.log(`✅ ${msg}`);
  else {
    console.error(`❌ ${msg}`);
    failed += 1;
  }
};

const 真fetch = globalThis.fetch;
let 调用 = [];

/** 假 fetch：gettoken 给令牌，其余记下请求体并按 errcode 返回。 */
function 装假企微(errcode = 0) {
  调用 = [];
  globalThis.fetch = async (url, opt = {}) => {
    const 址 = String(url);
    if (址.includes('/cgi-bin/gettoken')) {
      return new Response(JSON.stringify({ errcode: 0, access_token: 'tok-1', expires_in: 7200 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    调用.push({ 址, 体: opt.body ? JSON.parse(opt.body) : null });
    return new Response(JSON.stringify({ errcode, errmsg: errcode ? 'mock-fail' : 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

try {
  // ---- ① 正常更新：端点和请求体 ----
  装假企微(0);
  const 应用 = new 企微应用({ corpId: 'corp', secret: 'sec', agentId: 1000011 });
  await 应用.更新卡片按钮('zhangsan', { responseCode: 'RC-1', taskId: 'TASK-1' }, '✅ 已允许', [
    { text: '允许一次', style: 1, type: 0, key: 'qiwei_appr_ok_A' },
    { text: '拒绝', style: 3, type: 0, key: 'qiwei_appr_no_A' },
  ]);

  check(调用.length === 1, '只发了一次请求（不是发消息、也没重复）');
  const { 址, 体 } = 调用[0] ?? {};
  check(String(址).includes('/cgi-bin/message/update_template_card'), '走的是 update_template_card 接口');
  check(String(址).includes('access_token=tok-1'), '带上了 access_token');
  check(Array.isArray(体?.userids) && 体.userids[0] === 'zhangsan', 'userids 是数组且为本人');
  check(体?.agentid === 1000011, 'agentid 是数字');
  check(体?.response_code === 'RC-1', 'response_code 原样带上（一次性，不能编）');
  check(体?.template_card?.card_type === 'button_interaction', 'card_type 是按钮交互型');
  // 更新接口是整卡替换，按钮交互型缺 main_title 会被企微回 41016 missing title（2026-11-27 实证）
  check(体?.template_card?.main_title?.title === 'DSH 等待审批', 'main_title 必填带上（缺了会 41016）');
  check(体?.template_card?.task_id === 'TASK-1', 'task_id 与发卡时一致');
  check(体?.template_card?.button_list?.[0]?.text === '允许一次', '按钮列原样带上（结果靠那颗按钮的文案与 style）');
  check(!体?.template_card?.button, '不再依赖 button.replace_name');
  // 整卡替换：button_list 必填，漏传企微回 40016 invalid button size（2026-11-27 实证）
  check(
    Array.isArray(体?.template_card?.button_list) && 体.template_card.button_list.length === 2,
    'button_list 必填带上（缺了会 40016）',
  );
  check(体?.template_card?.button_list?.[0]?.key === 'qiwei_appr_ok_A', 'button_list 的 key 与发卡时一致');

  // ---- ② 拒绝文案同样能走 ----
  装假企微(0);
  await 应用.更新卡片按钮('zhangsan', { responseCode: 'RC-2', taskId: 'TASK-2' }, '❌ 已拒绝', [
    { text: '❌ 已拒绝', style: 2, type: 0, key: 'qiwei_appr_no_B' },
  ]);
  check(调用[0]?.体?.template_card?.button_list?.[0]?.text === '❌ 已拒绝', '拒绝文案同样画进 button_list');

  // ---- ③ 缺 response_code / task_id：必须当场抛，不许白调一次接口 ----
  装假企微(0);
  let 抛了 = false;
  try {
    await 应用.更新卡片按钮('zhangsan', { taskId: 'TASK-3' }, '✅ 已允许');
  } catch {
    抛了 = true;
  }
  check(抛了 && 调用.length === 0, '缺 response_code 时直接抛错，不发请求');

  装假企微(0);
  抛了 = false;
  try {
    await 应用.更新卡片按钮('zhangsan', { responseCode: 'RC-4' }, '✅ 已允许');
  } catch {
    抛了 = true;
  }
  check(抛了 && 调用.length === 0, '缺 task_id 时直接抛错，不发请求');

  // ---- ④ 企微回非 0：必须抛（调用方只记日志、不补提示）----
  装假企微(60001);
  抛了 = false;
  try {
    await 应用.更新卡片按钮('zhangsan', { responseCode: 'RC-5', taskId: 'TASK-5' }, '✅ 已允许');
  } catch (错) {
    抛了 = String(错?.message ?? 错).includes('60001');
  }
  check(抛了, '企微返回非 0 时抛错，且错误里带 errcode');
} finally {
  globalThis.fetch = 真fetch;
}

if (failed > 0) {
  console.error(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n✅ 企微审批卡结算用例全过');
