// chat.mjs · 模型「类型」处理器：OpenAI 兼容 chat completions 上游协议
// chat / 视觉 / 转写条目现都走此协议（线上兼容口、本地 FunASR 口均兼容）；
// 视觉（图片进 messages content）、转写（input_audio）都是 chat completions 形状的载荷，协议不分家。
// 将来若出现真正不同协议的上游（如 multipart 文件直传），加一个新类型文件+注册表一行注册，核心不动（D11）。
//
// 处理器契约：调用(记录, 上游体, key) →
//   { 可达: true, status, contentType, text }   —— 上游有应答（无论 2xx/4xx/5xx，形状判定交给信封层）
//   { 可达: false, 原因: '连接失败' }            —— 连不上（超时/DNS/拒连）
// key 由 registry.解析key(m) 解析好传入（"${ENV名}" → env 值；明文原样），处理器不碰 env 细节。
export default {
  名字: 'chat',
  说明: 'OpenAI 兼容 chat completions（chat/视觉/转写同协议）',
  async 调用(记录, 上游体, key) {
    let up;
    try {
      up = await fetch(记录.地址, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key ?? ''}` },
        body: JSON.stringify(上游体),
      });
    } catch {
      return { 可达: false, 原因: '连接失败' };
    }
    const text = await up.text();
    return { 可达: true, status: up.status, contentType: up.headers.get('content-type'), text };
  },
};
