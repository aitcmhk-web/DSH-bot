// 注册表.mjs · 两张注册表 + 自装配（#19 改造核心，D11/D12：加同类项=加文件+一行注册，核心不分叉）
//
// ① 信封注册表（请求形状维度：/call 的请求体怎么解析）——aitcm 先认、直通兜底最后；
//    未来新信封（如 OpenAI 原生信封）= types/ 加一个文件（认/准备/包装 三件套）+ 下面一行注册。
// ② 类型注册表（模型条目维度：条目「类型」字段 → 怎么调上游）——现只有 chat（chat/视觉/转写同协议）；
//    未来新协议 = types/ 加一个文件（名字/说明/调用 三件套）+ 下面一行注册，条目改「类型」字段即用。
//
// 处理器契约：
//   信封处理器：认(信封)→bool；准备(信封, registry)→{m,上游体}|{错误,状态码}；包装(应答, json, res)→响应
//   类型处理器：名字；说明；调用(记录, 上游体, key)→{可达:true,status,contentType,text}|{可达:false,原因}
import * as registry from '../../registry/registry.mjs';
import chat类型 from './chat.mjs';
import aitcm信封 from './aitcm.mjs';
import 直通信封 from './直通.mjs';

const 类型表 = new Map();
const 信封表 = [];

export function 注册类型(处理器) {
  if (!处理器?.名字 || typeof 处理器.调用 !== 'function') throw new Error('类型处理器要有 名字 + 调用');
  类型表.set(处理器.名字, 处理器);
}

export function 注册信封(处理器) {
  if (!处理器?.名字 || typeof 处理器.认 !== 'function' || typeof 处理器.准备 !== 'function' || typeof 处理器.包装 !== 'function') {
    throw new Error('信封处理器要有 名字 + 认 + 准备 + 包装');
  }
  信封表.push(处理器);
}

export function 取类型(名字) {
  return 类型表.get(名字) ?? null;
}

export function 类型名单() {
  return [...类型表.keys()];
}

// 按注册顺序找第一个认领的信封处理器（aitcm 先注册 → 先认；直通兜底）
export function 认信封(请求体) {
  return 信封表.find((h) => h.认(请求体)) ?? null;
}

// ---------- 自装配（新同类项在下面加一行，核心零改动） ----------
注册类型(chat类型);          // chat（chat/视觉/转写同协议）
注册信封(aitcm信封);         // AITCM 报名字信封（先认）
注册信封(直通信封);          // 老直通口（兜底，必须最后）

// 条目的类型 → 类型处理器；条目没写「类型」字段 → 缺省 chat（与旧版行为一致：旧表无类型字段照跑）
export function 条目的类型处理器(条目) {
  const h = 取类型(条目?.类型 ?? 'chat');
  if (!h) throw new Error(`模型「${条目.名字}」登记了未知类型：${条目.类型}（可用类型：${类型名单().join('、')}）`);
  return h;
}

export { registry };
