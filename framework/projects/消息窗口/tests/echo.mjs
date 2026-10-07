// echo.mjs · T001 收发实测：收到文字原样回给发送者（走 access 的收发口）
import { loadConfig } from '../modules/route/route.mjs';
import { pollOnce, send } from '../modules/access/access.mjs';

const cfg = loadConfig();
const item = cfg.项目们[0];
console.log(`echo 已起：监听「${item.项目}」，收到文字就原样回（Ctrl+C 结束）`);

let offset = 0;
for (;;) {
  try {
    const { offset: next, 消息 } = await pollOnce(item.token, offset);
    offset = next;
    for (const m of 消息) {
      console.log('收到:', JSON.stringify(m));
      if (m.类型 === '文字') {
        const out = await send(item.token, 'tg', m.chatId, { 类型: '文字', 文字: `收到：${m.文字}` });
        console.log('已回:', JSON.stringify(out));
      } else {
        console.log('（非文字消息，本轮只记录不回）');
      }
    }
  } catch (e) {
    console.log('出错:', e?.message ?? e);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
