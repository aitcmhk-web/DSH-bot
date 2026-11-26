// 企业微信自建应用回调的验签、解密、加密。
// 只做协议，不碰网络；明文结构：16 字节随机串 + 4 字节长度 + 消息 + 接收方 ID。
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const 块 = 32;

/** EncodingAESKey（43 字符）→ 32 字节密钥。 */
export function 解密钥(encodingAesKey) {
  const 原 = String(encodingAesKey ?? '').trim();
  if (原.length !== 43) throw new Error('EncodingAESKey 必须是 43 个字符');
  const 钥 = Buffer.from(`${原}=`, 'base64');
  if (钥.length !== 32) throw new Error('EncodingAESKey 解出来不是 32 字节');
  return 钥;
}

/** 企微回调签名：token、timestamp、nonce、密文四者排序后 sha1。 */
export function 算签名(token, timestamp, nonce, encrypt) {
  return createHash('sha1')
    .update([token, timestamp, nonce, encrypt].map((x) => String(x)).sort().join(''))
    .digest('hex');
}

/** 定长比较，避免把签名比较做成时序侧信道。 */
export function 签名相符(a, b) {
  const 左 = Buffer.from(String(a ?? ''), 'utf8');
  const 右 = Buffer.from(String(b ?? ''), 'utf8');
  return 左.length === 右.length && timingSafeEqual(左, 右);
}

/** 解一包企微密文。出参：{ 正文, 接收方 }。 */
export function 解包(encrypt, encodingAesKey) {
  const 钥 = 解密钥(encodingAesKey);
  const 密文 = Buffer.from(String(encrypt ?? '').trim(), 'base64');
  if (!密文.length || 密文.length % 16 !== 0) throw new Error('回调密文长度不对');

  const 解 = createDecipheriv('aes-256-cbc', 钥, 钥.subarray(0, 16));
  解.setAutoPadding(false);
  let 明 = Buffer.concat([解.update(密文), 解.final()]);

  const 补 = 明[明.length - 1];
  if (补 < 1 || 补 > 块 || 补 > 明.length) throw new Error('回调补位不对');
  for (let i = 明.length - 补; i < 明.length; i++) {
    if (明[i] !== 补) throw new Error('回调补位不一致');
  }
  明 = 明.subarray(0, 明.length - 补);
  if (明.length < 20) throw new Error('回调明文太短');

  const 长 = 明.readUInt32BE(16);
  if (20 + 长 > 明.length) throw new Error('回调消息长度越界');
  return {
    正文: 明.subarray(20, 20 + 长).toString('utf8'),
    接收方: 明.subarray(20 + 长).toString('utf8'),
  };
}

/** 加密一包，给自测和本地回调模拟用；企微回调本身只要求解包。 */
export function 打包(正文, encodingAesKey, 接收方) {
  const 钥 = 解密钥(encodingAesKey);
  const 文 = Buffer.from(String(正文), 'utf8');
  const 长 = Buffer.alloc(4);
  长.writeUInt32BE(文.length, 0);
  let 明 = Buffer.concat([randomBytes(16), 长, 文, Buffer.from(String(接收方), 'utf8')]);
  const 补 = 块 - (明.length % 块);
  明 = Buffer.concat([明, Buffer.alloc(补, 补)]);
  const 加 = createCipheriv('aes-256-cbc', 钥, 钥.subarray(0, 16));
  加.setAutoPadding(false);
  return Buffer.concat([加.update(明), 加.final()]).toString('base64');
}

/** 从企微 XML 里取一个标签，兼容 CDATA。 */
export function 取标签(xml, 名) {
  const m = String(xml ?? '').match(new RegExp(`<${名}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${名}>`));
  return m ? m[1].trim() : '';
}
