// 视觉.mjs · 模型「类型」处理器：视觉上游（#22 回归修复：#19 改造时漏注册，视觉条目全 400）
// 视觉条目（AITCM·舌象 = qwen-vl-max）走 OpenAI 兼容 chat/completions：图片以 data URL image_url 进 messages content
//（AITCM 信封处理器负责把 载荷.图片 翻成 image_url；直通口则由调用方自带完整 messages）。
// 线协议与 chat 同形（JSON POST）→ 调用复用 chat 的实现（一份线协议代码，不复制）；将来协议分家只改本文件（D11）。
//
// 处理器契约见 注册表.mjs：调用(记录, 上游体, key) → { 可达:true, status, contentType, text } | { 可达:false, 原因 }
import chat类型 from './chat.mjs';

export default {
  名字: '视觉',
  说明: '视觉上游（图片进 messages content 的 OpenAI 兼容口）——现与 chat 同为 JSON POST，复用同一实现',
  调用: chat类型.调用,
};
