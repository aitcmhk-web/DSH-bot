// 转写.mjs · 模型「类型」处理器：转写上游（#22 回归修复：#19 改造时漏注册，转写条目全 400）
// 协议实锤（实读 modules/stt/server.mjs + 改造前 api.mjs 备份）：
//   本地转文字 = 9911 /v1/audio/transcriptions 收 JSON {文件:路径} → {文本}，**不是 multipart**；
//   阿里转文字 = qwen3-asr-flash 走兼容口 chat/completions JSON（model/messages/asr_options 都在 输入 里，信封只供地址+key）。
// 两条转写上游线协议与 chat 同形（JSON POST 透传）→ 调用复用 chat 的实现（一份线协议代码，不复制）；
// 将来若真出现 multipart 上游，只改本文件实现自己的 调用，核心不动（D11）。
//
// 处理器契约见 注册表.mjs：调用(记录, 上游体, key) → { 可达:true, status, contentType, text } | { 可达:false, 原因 }
import chat类型 from './chat.mjs';

export default {
  名字: '转写',
  说明: '转写上游（阿里兼容口 JSON / 本地 FunASR 9911 JSON {文件}）——现与 chat 同为 JSON POST，复用同一实现',
  调用: chat类型.调用,
};
