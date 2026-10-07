// 直通.mjs · 「信封」处理器：老直通口 { 模型名, 输入 } —— 输入体 100% 透传、上游应答原样回
// 形状红线（#19）：主 bot asr.js、消息窗口 convert.mjs、插件版转写都指着这个口，对外形状一字不改。
// 它是信封注册表的**兜底**（认() 恒真、最后注册）——不匹配任何专用信封的请求都归它，与旧版 else 分支语义一致。
export default {
  名字: '直通',
  说明: '老直通口 {模型名, 输入}：输入体透传、上游应答原样回',
  认() {
    return true; // 兜底
  },
  准备(信封, registry) {
    const m = 信封?.模型名 ? registry.get(信封.模型名) : null;
    if (!m) return { 错误: '模型未登记', 状态码: 400 };
    return { m, 上游体: 信封?.输入 ?? {} };
  },
  // 上游应答 → 对外响应：2xx 原样透传（含 content-type）；非 2xx → 502「模型不可达」（形状与旧版逐字段一致）
  包装(应答, json, res) {
    const 上游ok = 应答.status >= 200 && 应答.status <= 299; // 等价旧版 up.ok
    if (!上游ok) {
      return json(res, 502, { 错误: '模型不可达', 上游状态: 应答.status, 上游返回: 应答.text.slice(0, 500) });
    }
    res.writeHead(200, { 'content-type': 应答.contentType ?? 'application/json; charset=utf-8' });
    return res.end(应答.text); // 原样返回上游输出
  },
};
