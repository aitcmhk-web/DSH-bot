// wx-sendimage 本地回归（不联网）：加密回环 + 密文长度公式 + aes_key 参数格式反向验证
// 判据对齐 weixin.js 真实现（encrypt/decrypt 是同一份导出，不是测试复制算法）。
import { encryptAesEcb, decryptAesEcb, aesKeyHexToParam, aesPaddedSize } from '../modules/access/weixin.js';
import { randomBytes } from 'node:crypto';

let 失败 = 0;
const 断言 = (行, 条件, 说明) => {
  if (条件) return;
  失败++;
  console.error(`❌ 第 ${行} 条：${说明}`);
};

// ① 加密回环：整除 16 / 不整除都要还原（PKCS7 恒补 1..16 字节）
for (const n of [1, 15, 16, 17, 1000, 12345]) {
  const key = randomBytes(16);
  const plain = randomBytes(n);
  const cipher = encryptAesEcb(plain, key);
  断言('回环', decryptAesEcb(cipher, key.toString('base64')).equals(plain), `回环失败 n=${n}`);
  断言('长度公式', cipher.length === aesPaddedSize(n), `密文长度 n=${n}: ${cipher.length} ≠ ${aesPaddedSize(n)}`);
}

// ② aes_key 参数 = base64(hex字符串)：解码回来必须是原 hex 串
const hex = randomBytes(16).toString('hex');
const param = aesKeyHexToParam(hex);
断言('参数格式', Buffer.from(param, 'base64').toString('utf8') === hex, 'aes_key 参数不是 base64(hex)');

// ③ 反向验证：长度不对的 key（15 字节）必须被拒收——两型归一不是来者不拒
//（注：base64(hex字符串) 是合法的第二编码，能解出原文是设计内行为，不算反向案例）
const key = randomBytes(16);
const plain = randomBytes(100);
const cipher = encryptAesEcb(plain, key);
let 拒了 = false;
try { decryptAesEcb(cipher, randomBytes(15).toString('base64')); } catch { 拒了 = true; }
断言('反向', 拒了, '错长度 key 没被拒收');

if (失败) {
  console.error(`❌ ${失败} 条断言失败`);
  process.exit(1);
}
console.log('✅ wx-sendimage 本地回归全过：回环 6 种长度 + 长度公式 + aes_key 参数格式 + 反向验证');
