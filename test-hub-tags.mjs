/**
 * test-hub-tags.mjs —— 通道来源标回归（2026-11-27 老板定）。
 *
 * 口径：一条消息**只有一个标识 = 来源**。
 *   · 电报说的话广播到企微 → 正文前加 `[电报]`；
 *   · 来源端自己不加（刚在那边打的字，不用再标）；
 *   · 回话（`[DSH] …`）不加 —— 它没有通道来源，`[DSH]` 就是它的标识。
 *
 * 为什么单独一份：加了标却给来源端也加、或者给回话也加，聊天里就会
 *   出现「[电报] [DSH]」两条标 —— 那正是 2026-11-27 老板当场否掉的写法。
 *
 * 跑法：node test-hub-tags.mjs
 * 退出码：0 = 全过；1 = 有用例失败。
 */

import { Hub, makeMessage, markAsHubOutput, isHubOutput, withSourceTag } from './src/hub.js';

let failed = 0;
const check = (cond, msg) => {
  if (cond) console.log(`✅ ${msg}`);
  else {
    console.error(`❌ ${msg}`);
    failed += 1;
  }
};

/** 假端点：只记下收到的消息。 */
const 造端点 = (id) => ({
  id,
  got: [],
  async send(msg) {
    this.got.push(msg);
  },
  start() {},
});

// ---------------------------------------------------------------- 单元：withSourceTag
{
  const tg = makeMessage({ source: 'tg', chatId: '1', text: '在吗' });
  check(withSourceTag(tg, 'tg').text === '在吗', '来源端（电报自己）不加标');
  check(withSourceTag(tg, 'wecom').text === '[电报] 在吗', '电报的话到企微 → [电报] 在吗');
  check(withSourceTag(tg, 'wx').text === '[电报] 在吗', '电报的话到微信 → [电报] 在吗');

  const wx = makeMessage({ source: 'wx', chatId: '2', text: '[图片]' });
  check(withSourceTag(wx, 'wecom').text === '[微信] [图片]', '微信的图到企微 → [微信] [图片]');

  const wc = makeMessage({ source: 'wecom', chatId: '3', text: '在吗' });
  check(withSourceTag(wc, 'tg').text === '[企微] 在吗', '企微的话到电报 → [企微] 在吗');

  const 回话 = markAsHubOutput(makeMessage({ source: 'hub', chatId: null, text: '[DSH] 主人…', viaHub: true }));
  check(withSourceTag(回话, 'tg').text === '[DSH] 主人…', '回话（[DSH]）不加通道标');
  check(withSourceTag(回话, 'wecom').text === '[DSH] 主人…', '回话到企微也是 [DSH]，不叠第二条标');

  const 空 = makeMessage({ source: 'tg', chatId: '1', text: '' });
  check(withSourceTag(空, 'wecom') === 空, '空正文原样返回（不出现孤零零的 [电报]）');

  const 已标 = markAsHubOutput(makeMessage({ source: 'tg', chatId: '1', text: 'x' }));
  const 副本 = withSourceTag(已标, 'wecom');
  check(isHubOutput(副本), '克隆一条加标消息时，本系统产出的结构标记不能丢');
}

// ---------------------------------------------------------------- 端到端：inbound 镜像
{
  const tg = 造端点('tg');
  const wx = 造端点('wx');
  const wecom = 造端点('wecom');
  const hub = new Hub({ onInbound: async () => {}, log: () => {} });
  hub.add(tg).add(wx).add(wecom);

  await hub.inbound(makeMessage({ source: 'tg', chatId: '1', text: '在吗' }));
  check(tg.got.length === 0, '入站：来源端不重复收自己那条');
  check(wx.got[0]?.text === '[电报] 在吗', '入站镜像到微信 → [电报] 在吗');
  check(wecom.got[0]?.text === '[电报] 在吗', '入站镜像到企微 → [电报] 在吗');
}

// ---------------------------------------------------------------- 端到端：回话广播
{
  const tg = 造端点('tg');
  const wx = 造端点('wx');
  const wecom = 造端点('wecom');
  const hub = new Hub({ onInbound: async () => {}, log: () => {} });
  hub.add(tg).add(wx).add(wecom);

  await hub.outbound('[DSH] 主人，好了');
  for (const ep of [tg, wx, wecom]) {
    check(ep.got[0]?.text === '[DSH] 主人，好了', `回话到 ${ep.id} 保持 [DSH]，不加通道标`);
  }
}

if (failed > 0) {
  console.error(`\n❌ ${failed} 条失败`);
  process.exit(1);
}
console.log('\n✅ 全过');
