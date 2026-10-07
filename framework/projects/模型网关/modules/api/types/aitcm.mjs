// aitcm.mjs · 「信封」处理器：AITCM 四模块报名字信封 { 项目:'AITCM', 模块, 载荷 }
// 形状红线（#19）：对外形状与 2026-10-06 版逐字段一字不改 —— 400/500/502/200 {原文} 全套原样。
// 翻译规则（01-契约「AITCM 信封」节，载荷 100% 透传、不发明内容）：
//   system = 提示词/审查要求/形状说明/修正指令（有哪个拼哪个，\n\n 连接）
//   载荷.图片 {base64,mime} → data URL image_url（放 user 最前）
//   其余字段按出现顺序进 user 文本：字符串原样、对象/数组 JSON 序列化、行首带「字段名：」；chatId 是内部字段不上送
const AITCM_系统字段 = ['提示词', '审查要求', '形状说明', '修正指令'];

function AITCM_翻译(载荷) {
  const p = 载荷 && typeof 载荷 === 'object' ? 载荷 : {};
  const system = AITCM_系统字段
    .filter((k) => typeof p[k] === 'string' && p[k].trim())
    .join('\n\n');
  const 行 = [];
  for (const [k, v] of Object.entries(p)) {
    if (k === 'chatId' || k === '图片' || AITCM_系统字段.includes(k)) continue;
    if (v == null || v === '') continue;
    行.push(`${k}：${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  const 图 = p.图片;
  const parts = [];
  if (图 && typeof 图 === 'object' && typeof 图.base64 === 'string' && 图.base64) {
    parts.push({ type: 'image_url', image_url: { url: `data:${图.mime || 'image/jpeg'};base64,${图.base64}` } });
  }
  if (行.length) parts.push({ type: 'text', text: 行.join('\n\n') });
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({
    role: 'user',
    content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
  });
  return messages;
}

export default {
  名字: 'aitcm',
  说明: 'AITCM 四模块报名字信封（项目=AITCM + 模块 + 载荷）',
  // 是否本处理器认领的信封形状
  认(信封) {
    return !!信封 && 信封.项目 === 'AITCM' && typeof 信封.模块 === 'string' && !!信封.模块;
  },
  // 信封 → 模型表条目 + 上游请求体；错 → { 错误, 状态码 }（形状与旧版逐字段一致）
  准备(信封, registry) {
    const m = registry.get(`AITCM·${信封.模块}`);
    if (!m) return { 错误: `模型未登记（AITCM·${信封.模块}）`, 状态码: 400 };
    const 参数 = m.参数 && typeof m.参数 === 'object' ? { ...m.参数 } : {};
    const model = 参数.model;
    delete 参数.model;
    if (!model) return { 错误: `表记录 AITCM·${信封.模块} 缺 参数.model`, 状态码: 500 };
    return { m, 上游体: { model, messages: AITCM_翻译(信封.载荷), ...参数 } };
  },
  // 上游应答 → 对外响应；ok200 返回 { 原文 }，抽不出 → 502（形状与旧版逐字段一致）
  包装(应答, json, res) {
    const 上游ok = 应答.status >= 200 && 应答.status <= 299; // 等价旧版 up.ok
    if (!上游ok) {
      return json(res, 502, { 错误: '模型不可达', 上游状态: 应答.status, 上游返回: 应答.text.slice(0, 500) });
    }
    try {
      const 原文 = JSON.parse(应答.text)?.choices?.[0]?.message?.content;
      if (typeof 原文 === 'string') return json(res, 200, { 原文 });
    } catch {}
    return json(res, 502, { 错误: '上游响应没有 choices[0].message.content（AITCM 信封要 {原文}）', 上游状态: 应答.status, 上游返回: 应答.text.slice(0, 500) });
  },
};
