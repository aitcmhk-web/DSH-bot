/**
 * 终审核卡·DSH 侧投递件（任务 #57，照 #56 方案 DSH 半边）。
 *
 * 通路：AITCM 侧（001bot 终审.mjs）把请求写成 待审-<请求id>.json 落进 watchDir →
 * 本模块 5s 拍子扫描 → sendMessage 发审核卡到协作群（✅通过 / ❌打回 按钮，带
 * fin:ok:<id> / fin:no:<id> 回调）→ 老板按键 → 写 已审-<请求id>.json（'wx' 独占，
 * 首份回执落盘为准防双写）+ editMessageText 回改卡片；打回照 #20/#38 ForceReply
 * 原因条先例另发一条让老板 tap 引用直输理由。
 *
 * 接口面 = 纯文件 + 注入的 telegram（照 #56 主bot批复：接口面=待审/已审 json 文件）。
 * 零 token（第 29 条）：本模块不读任何 token、不连网——telegram 由宿主注入，
 * 测试用假 telegram 全链驱动（照 test-approval-429 形状）。
 *
 * 身份门照 #15/#16：只认 ownerUserId（发卡与判定同一来源，⛔ 不新增第二处判定）。
 * message_id 双形状取法照 #38/#37：顶层优先，result 兜底。
 *
 * ⚠️ 真发卡那步需宿主 telegram 实例（有 token 的进程加载本模块）——本进程无 token，
 * 故真发卡不在本目录自测范围；核心链路用假 telegram 全测。
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 打回原因 ForceReply 键盘（照 #20/#38：tap 引用即弹键盘直输）。 */
const FORCE_REPLY = { force_reply: { force_reply: true, input_field_placeholder: '打回原因…' } };

/** 从已发送结果取 message_id（#38 双形状：顶层优先，result 兜底）。 */
function msgId(res) {
  return res?.message_id ?? res?.result?.message_id ?? null;
}

/**
 * @param {object} deps
 * @param {object} deps.telegram   宿主注入的 telegram（需 sendMessage/editMessageText/answerCallbackQuery/sendRich）
 * @param {string} deps.watchDir   待审-*.json / 已审-*.json 所在目录
 * @param {string|number} deps.groupId 协作群 chat id（取法照 #39：表头优先，此处由宿主给）
 * @param {number|null} deps.ownerUserId 老板 id（身份门，唯一来源）
 * @param {string[]|number[]} [deps.extraAdmins] 额外可审批人（默认无）
 * @param {(s:string)=>void} [deps.log]
 * @param {(s:string)=>void} [deps.error]
 */
export function createFinalReview({ telegram, watchDir, groupId, ownerUserId, extraAdmins = [], log = () => {}, error = () => {} }) {
  const sent = new Map(); // 请求id -> { message_id, chat }（防同一请求重复发卡）
  const rejecting = new Map(); // 卡 message_id -> 请求id（等 ForceReply 理由回填）
  const nameOf = (id, prefix) => `${prefix}-${id}.json`;
  const safeId = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_'); // 文件名防穿越

  async function ensureDir() {
    if (!existsSync(watchDir)) await mkdir(watchDir, { recursive: true });
  }

  /** 读目录下所有 待审-*.json → {id, req} 列表（坏文件跳过并报错）。 */
  async function listPending() {
    let names;
    try {
      names = await readdir(watchDir);
    } catch {
      return [];
    }
    const out = [];
    for (const n of names) {
      if (!n.startsWith('待审-') || !n.endsWith('.json')) continue;
      const id = n.slice('待审-'.length, -'.json'.length);
      try {
        const req = JSON.parse(await readFile(join(watchDir, n), 'utf8'));
        out.push({ id, req, file: n });
      } catch (err) {
        error(`[终审] 待审文件坏 JSON 跳过 ${n}: ${err?.message ?? err}`);
      }
    }
    return out;
  }

  /** 是否已回写过（防双写第一步：已审存在就不动作）。 */
  function reviewed(id) {
    return existsSync(join(watchDir, nameOf(id, '已审')));
  }

  /** 发一张终审卡。返回 {message_id} 或 null。 */
  async function sendCard(id, req) {
    if (!telegram || ownerUserId === null) return null; // 身份门：没认领发卡=死卡，⛔ 不发
    const brief = (req?.卡面 ?? req?.卡 ?? '').slice(0, 500);
    try {
      const res = await telegram.sendMessage(
        groupId,
        [
          `🧪 终审请求 ${id}`,
          brief || '（AITCM 侧未带卡面字段）',
          '',
          '✅ 通过 → 写回 已审 文件放行 AITCM；❌ 打回 → 点 ❌ 后回复原因条（tap 引用直输）。',
        ].join('\n'),
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ 通过', callback_data: `fin:ok:${id}` },
              { text: '❌ 打回', callback_data: `fin:no:${id}` },
            ]],
          },
        },
      );
      const mid = msgId(res);
      if (!mid) {
        error(`[终审] ${id} 发卡没拿到 message_id —— 按第 16 条不算成功`);
        return null;
      }
      log(`[终审] ${id} 审核卡已发协作群（message_id=${mid}）`);
      return { message_id: mid, chat: groupId };
    } catch (err) {
      error(`[终审] ${id} 发卡失败，下轮重试: ${err?.message ?? err}`);
      return null;
    }
  }

  /** 一拍：扫待审 → 未发过且未回写的发卡（成功才记，失败下轮重试 = 恰好一次）。 */
  async function tick() {
    const pend = await listPending();
    for (const { id, req } of pend) {
      if (reviewed(id)) continue; // 已回写，跳过
      if (sent.has(id)) continue; // 已发过卡，等按键
      const card = await sendCard(id, req);
      if (card) sent.set(id, card); // 发送失败不记 → 下轮重试
    }
  }

  /** 首份回执落盘（'wx' 独占：已存在就 EEXIST，⛔ 不覆盖 = 防双写，照 #38）。 */
  async function writeReceipt(id, receipt) {
    const p = join(watchDir, nameOf(safeId(id), '已审'));
    try {
      await writeFile(p, JSON.stringify(receipt, null, 2), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err?.code === 'EEXIST') {
        log(`[终审] ${id} 已审已存在（首份回执为准），忽略后到的按下`);
        return false;
      }
      error(`[终审] ${id} 写已审失败: ${err?.message ?? err}`);
      return false;
    }
  }

  /** 回改卡片为终态。 */
  async function editCard(chat, mid, text) {
    if (!telegram || chat == null || mid == null) return;
    try {
      await telegram.editMessageText(chat, mid, text);
    } catch (err) {
      error(`[终审] 回改卡片失败(mid=${mid}): ${err?.message ?? err}`);
    }
  }

  /** 打回：回改卡片 + 另发 ForceReply 原因条（照 #20/#38），登记等理由回填。 */
  async function rejectFlow(id, chat, mid) {
    await editCard(chat, mid, `❌ ${id} 已选打回 —— 请回复下面的原因条（tap 引用直输理由）。`);
    try {
      const r = await telegram.sendMessage(chat, `📝 打回原因（${id}）：`, { reply_markup: FORCE_REPLY });
      const rid = msgId(r);
      if (rid) rejecting.set(String(rid), id);
      log(`[终审] ${id} 打回 → 卡片已提示 + ForceReply 原因条已发(mid=${rid})`);
    } catch (err) {
      error(`[终审] ${id} 打回原因条发送失败: ${err?.message ?? err}`);
    }
  }

  /**
   * 按钮回调（宿主 handleCallbackQuery 里调，照 approval-bridge 形状）。
   * 吃掉本模块的 fin:* 才返回 true，否则 false 让位给别处。
   * 身份门：非 owner 静默忽略（连应答都不发 = 零动作，照 #15）。
   * @returns {boolean}
   */
  async function handleCallback(query) {
    const data = String(query?.data ?? '');
    if (!data.startsWith('fin:ok:') && !data.startsWith('fin:no:')) return false;
    const id = data.slice(7); // 'fin:ok:' 与 'fin:no:' 同为 7 字符 → <请求id>
    const userId = query?.from?.id;
    // 身份门（#15）：只认老板，非老板静默忽略（仍须应答 TG 按钮）。
    await telegram?.answerCallbackQuery?.(query?.id).catch?.(() => {});
    if (ownerUserId === null || userId !== ownerUserId) return true; // 吃掉但零动作
    if (reviewed(id)) return true; // 已有首份回执，后到按下忽略（防双写）

    const chat = query?.message?.chat?.id;
    const mid = query?.message?.message_id;
    if (data.startsWith('fin:ok:')) {
      const wrote = await writeReceipt(id, { 通过: true, 理由: '', 审批人: userId, message_id: mid ?? null });
      if (wrote) {
        await editCard(chat, mid, `✅ ${id} 已通过 —— 已写回执，AITCM 侧读到后放行。`);
        log(`[终审] ${id} 老板点通过 → 已审已写（审批人=${userId}）`);
      }
    } else {
      // 打回：先发 ForceReply 原因条；理由由下方 noteReply 回填成 通过:false 的回执。
      await rejectFlow(id, chat, mid);
    }
    return true;
  }

  /**
   * 老板对 ForceReply 原因条的回复（宿主 message 分支调）→ 补写 通过:false 回执。
   * 只对登记过的回复 message_id 动作，否则 false。
   * @returns {boolean}
   */
  async function noteReply(msg) {
    const rid = String(msg?.reply_to_message?.message_id ?? '');
    if (!rejecting.has(rid)) return false;
    const id = rejecting.get(rid);
    rejecting.delete(rid);
    const reason = String(msg?.text ?? '').trim();
    const userId = msg?.from?.id ?? ownerUserId;
    if (reviewed(id)) return true;
    await writeReceipt(id, { 通过: false, 理由: reason, 审批人: userId, message_id: null });
    log(`[终审] ${id} 打回理由回填（${reason.slice(0, 40)}）`);
    return true;
  }

  return { tick, handleCallback, noteReply, _internal: { sent, rejecting } };
}
