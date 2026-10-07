// weixin.mjs · 微信通道适配器（D12 三件套：收/发/归一）
// 收=getupdates 长轮询（游标+context_token 只记内存·零数据）；发=sendmessage（message_id 三件套）；
// 归一=原始 iLink 消息→标准消息（图片走 CDN 下载+AES 解密+魔数嗅探+jpg/png 归一）。
// #18 ④：发文字补线——项目推文字走 sendSafe，context_token 缺失报错口径与发图统一成同一句。
import { createWeixin, extractText, extractVoiceText, extractImage, isUserMessage } from '../access/weixin.js';
import { toJpgPng, 存临时文件 } from '../convert/convert.mjs';

// context_token 缺失统一口径（#18 ④）：文字/图片同一句，谁收到都知道该怎么办（顾客发条消息即补令牌）
export const CTX缺失 = '没有该顾客的 context_token（他还没发过消息），发不出去';

export function createWeixinChannel(item) {
  const wx = createWeixin(item.微信 ?? {});
  if (!wx) return null; // 凭据不可用：通道不起（装配层负责 log，不静默）

  const 适配器 = {
    通道: '微信',
    token: item.token,
    项目: item.项目,
    item,
    轮询间隔ms: 0, // 长轮询本身阻塞 ~30s，循环不必再睡
    重试次数: 1,   // sendSafe 内置三件套重试，外层不再叠
    _cursor: '',
    _ctx: new Map(), // 发送者 → 最新 context_token（回信用，只记内存；重启后顾客发条消息即补上）

    async 收() {
      const { msgs, buf, ret, errmsg } = await wx.getUpdates(适配器._cursor);
      适配器._cursor = buf; // ret≠0（如 -14 会话超时）也要用服务端回的 buf，否则游标卡死
      if (ret && ret !== 0) console.log(`[微信 ${适配器.项目}] getupdates ret=${ret} ${errmsg ?? ''}`);
      const 消息们 = [];
      const 失败们 = [];
      for (const m of msgs ?? []) {
        if (!isUserMessage(m)) continue;
        const from = String(m.from_user_id ?? m.from_user ?? '');
        if (!from) continue;
        if (m.context_token) 适配器._ctx.set(from, m.context_token); // 新鲜令牌必存
        try {
          const 标准 = 适配器.归一(m);
          if (标准) 消息们.push(标准);
        } catch (e) {
          // 单条归一失败：进失败清单照常推进（与 TG 侧同口径，坏消息不卡通道）
          console.log(`[微信 ${适配器.项目}] 单条归一失败，进失败清单: ${e?.message ?? e}`);
          失败们.push({ 通道: '微信', chatId: from, 错误: String(e?.message ?? e) });
        }
      }
      return { 消息们, 失败们 };
    },

    // 原始消息 → 标准消息；下载/解密失败抛错（由 收() 接进失败清单，不静默丢）
    async 归一(m) {
      const 文字 = extractText(m);
      const 语音文字 = extractVoiceText(m); // 微信语音服务端已转好，直接当文字用（契约）
      const 图信息 = 文字 == null && 语音文字 == null ? extractImage(m) : null;
      const 标准 = {
        类型: 文字 != null ? '文字' : 语音文字 != null ? '语音' : 图信息 ? '图片' : '其他',
        文件: null,
        文字: 文字 ?? 语音文字 ?? '',
        通道: '微信',
        chatId: String(m.from_user_id ?? m.from_user ?? ''),
        项目: 适配器.项目,
      };
      if (标准.类型 === '图片') {
        const img = await wx.downloadImage(图信息); // 下载 + AES 解密 + 魔数嗅探
        标准.文件 = toJpgPng(存临时文件(img.buffer, `${Date.now()}${img.ext}`)); // 归一 jpg/png（契约默认）
      }
      return 标准;
    },

    // 发：文字走 sendSafe（#18 ④ 补线）；图片走 sendImage（说明文字先发一条，微信一条消息一个 item）；
    // 成功判据统一 message_id，sendSafe 的 {ok:false} 在这里转成 throw（不许上层当成功）。
    async 发(chatId, 内容 = {}) {
      const 类型 = 内容.类型 ?? '文字';
      const ctxToken = 适配器._ctx.get(chatId);
      if (!ctxToken) throw new Error(CTX缺失);
      if (类型 === '文字') {
        if (!内容.文字) throw new Error('微信发文字缺内容');
        const r = await wx.sendSafe(chatId, String(内容.文字), ctxToken);
        if (!r.ok) throw new Error(r.错误 ?? '微信发文字失败');
        return { message_id: r.message_id };
      }
      if (类型 === '图片') {
        if (!内容.文件) throw new Error('微信发图缺文件（本地临时路径）');
        if (内容.文字) await wx.sendSafe(chatId, String(内容.文字), ctxToken);
        const r = await wx.sendImage(chatId, 内容.文件, ctxToken);
        if (!r.ok) throw new Error(r.错误 ?? '微信发图失败');
        return { message_id: r.message_id };
      }
      throw new Error(`微信通道暂不支持发${类型}`);
    },
  };
  return 适配器;
}
