// test-asr-order.mjs — #7「默认语音转文字顺序：线上第一、本地第二」回归测试（主 bot 链 asr.js）
//
// 判据（任务 #7 要求两条实测）：
//   ① online   —— 不设 ASR_BACKEND（吃新默认 ali），真网关 → 转写成功且全程无「回退本地」日志
//   ② fallback —— ASR_GATEWAY_URL 指死端口（模拟线上不可用）→ 自动回落本地 sensevoice 转写成功
//
// 用法：
//   node test-asr-order.mjs online   <16k-mono-wav>
//   ASR_GATEWAY_URL=http://127.0.0.1:1/call node test-asr-order.mjs fallback <16k-mono-wav>
//   （网关地址是模块加载时读的，② 必须在进程外设 env；① 必须确保该 env 干净）

const mode = process.argv[2];
const wav = process.argv[3];
if (!wav || !['online', 'fallback'].includes(mode)) {
  console.error('用法: node test-asr-order.mjs online|fallback <16k-mono-wav>');
  process.exit(1);
}

const { transcribe, currentBackend } = await import('./asr.js');

// 收集 [asr] 的 console.error（回落日志走这里），同时原样透传不吞
let errLog = '';
const origErr = console.error;
console.error = (...a) => { errLog += a.join(' ') + '\n'; origErr(...a); };

const t = await transcribe(wav).catch((e) => { origErr('transcribe 抛错:', e.message); return null; });
console.error = origErr;

console.log('── 结果 ──');
console.log('currentBackend() =', currentBackend());
console.log('转写结果:', t === null ? '(失败)' : JSON.stringify(t));
console.log('回落日志:', errLog.includes('回退本地') ? '有（触发回落）' : '无');

if (mode === 'online') {
  const ok = currentBackend() === 'ali' && t !== null && t.trim().length > 0 && !errLog.includes('回退本地');
  console.log(ok ? '✅ ① 默认链路：语音走线上(ali)转写成功' : '❌ ① 失败');
  process.exit(ok ? 0 : 1);
} else {
  const ok = t !== null && t.trim().length > 0 && errLog.includes('回退本地');
  console.log(ok ? '✅ ② 线上不可用：自动回落本地转写成功' : '❌ ② 失败');
  process.exit(ok ? 0 : 1);
}
