/**
 * src/llm-budget.js —— 模型调用的「分钟预算闸」。
 *
 * 目标（2026-10-19 老板口径）：**滚动 60 秒窗口内，模型请求数 ≤ rpm（默认 50）、
 *   token 合计 ≤ tpm（默认 3000000）**；超了不丢请求，而是让下一次调用**排队等**，
 *   等窗口腾出位置再发 —— 主动把流量压在供应商的 TPM/RPM 限额之下，避免撞 429
 *   （撞了也要按对方的 retry-after 退避，那是另一层，见 dsh-llm-retry）。
 *
 * 为什么挂在 `llm/stream` 上：宿主 llm 服务每次模型调用都走这条 waterfall
 *   （`ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(...))`），
 *   子代理、工具循环里每一发请求也都经过它 —— 是进程内**唯一**能一处管住全部模型流量的口子。
 *
 * 记账口径（保守优先，宁可多算）：
 *   · **请求数**：每发一次算 1（进窗口即计，不看成功失败 —— 失败也占过供应商的额）。
 *   · **token**：调用前先按「请求体的可读字符量」**预估**（中文按 1 token/字、其余按 1/4）
 *     再加一段输出预留；流里收到 `usage` 块后，用**实际用量**替换掉那次预估
 *     （替换不是叠加：预估值与实际值只算一次）。
 *   · **失败/中断**：流的迭代中途抛错时，那次仍按预估值留在账上（保守），不回收。
 *   · 窗口是**滚动**的：每条记录带自己的时间戳，满 60 秒自动过期。
 *
 * 等待策略：要额度不够时，等到「最早那条记录过期」再重试；单次调用累计等待超过
 *   `最长等待毫秒`（默认 10 分钟）就**放行并告警**（fail-open）—— 宁可偶尔超一次限额，
 *   也不让整台 bot 卡死；这条口径写在这里，改之前先想清楚。
 *
 * 维护：改默认上限、改预估口径、改等待策略都在本档；自测见 `test-llm-budget.mjs`。
 */

/**
 * 默认口径：每分钟 token 300 万、每分钟请求 50 次（老板 2026-10-19 定，同日放宽 token 上限）。
 *
 * 为什么 token 上限从 80 万放到 300 万：一条请求就带十几万 token（整段历史重发），
 *   80 万只够放五六条，而干活一轮有十几发请求 —— 后面每发都要排队等几秒到十几秒，
 *   体感就是「慢」。供应商限的是**请求密度**而不是 token 量（撞过的是
 *   `token_plan_person_rate_limit_exceeded`），所以只放宽 token 上限，
 *   `rpm` 保持 50 不动，继续当防撞闸。
 */
export const 默认预算 = Object.freeze({
  tpm: 3000000,
  rpm: 50,
  输出预留: 8000,          // 每次调用先按这么多输出 token 占位（实际用量回来后再校正）
  最长等待毫秒: 10 * 60 * 1000,
  记日志: true,
});

/** 一分钟（窗口长度）。 */
export const 窗口毫秒 = 60 * 1000;

/** 数一段文本里的字符：中文类（含全角标点）按 1 token/字，其余按 1/4 token/字。 */
export function 估文本token(文) {
  const s = String(文 ?? '');
  if (!s) return 0;
  let 汉 = 0;
  let 其他 = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    // CJK 统一汉字 / 扩展 A / 兼容 / 全角标点 / 中文标点：按「一字≈一 token」算（保守）
    const 是汉 = (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3000 && c <= 0x303f)
      || (c >= 0xff00 && c <= 0xffef) || (c >= 0x2000 && c <= 0x206f);
    if (是汉) 汉 += 1; else 其他 += 1;
  }
  return 汉 + Math.ceil(其他 / 4);
}

/** 从任意值里收集可读文本（跳过明显的元数据字段），用于预估。 */
function 收文本(值, 键, 出, 深度 = 0) {
  if (出.length > 4000 || 深度 > 8) return;           // 兜底：别把预估本身跑成开销
  if (值 === null || 值 === undefined) return;
  if (typeof 值 === 'string') { 出.push(值); return; }
  if (typeof 值 === 'number' || typeof 值 === 'boolean') return;
  if (Array.isArray(值)) { for (const v of 值) 收文本(v, 键, 出, 深度 + 1); return; }
  if (typeof 值 === 'object') {
    for (const [k, v] of Object.entries(值)) {
      // 这些键不是「发给模型的正文」，别算进预估（算了会虚高得离谱）
      if (['provider', 'model', 'sessionId', 'signal', 'apiKey', 'baseURL', 'id', 'type', 'role', 'name', 'url'].includes(k)) continue;
      收文本(v, k, 出, 深度 + 1);
    }
  }
}

/**
 * 预估一次调用的 token（输入 + 输出预留）。入参：宿主 `llm/stream` 的请求对象、输出预留数。
 * 出参：预估 token（整数）。副作用：无。
 */
export function 预估请求(request, 输出预留 = 默认预算.输出预留) {
  const 文 = [];
  收文本(request, null, 文);
  let 入 = 0;
  for (const s of 文) 入 += 估文本token(s);
  const 请求的输出上限 = Number(request?.maxTokens ?? request?.maxOutputTokens ?? 0);
  const 出 = 请求的输出上限 > 0 ? Math.min(请求的输出上限, 输出预留) : 输出预留;
  return Math.max(1, 入 + Math.max(0, 出));
}

/** 从流里的一块里取实际用量（宿主 usage 块：inputTokens / outputTokens / totalTokens …）。 */
export function 取用量(块) {
  const u = 块?.usage ?? (块?.type === 'usage' ? 块.usage : null);
  if (!u || typeof u !== 'object') return 0;
  const 总 = Number(u.totalTokens);
  if (Number.isFinite(总) && 总 > 0) return 总;
  const 入 = Number(u.inputTokens ?? u.promptTokens ?? 0) || 0;
  const 出 = Number(u.outputTokens ?? u.completionTokens ?? 0) || 0;
  const 缓存 = Number(u.cacheReadTokens ?? 0) + Number(u.cacheWriteTokens ?? 0);
  return 入 + 出 + 缓存;
}

/**
 * 造一道闸。入参（都可空）：`{ tpm, rpm, 输出预留, 最长等待毫秒, 记日志, 现在, 睡, 日志 }`。
 * 出参：`{ 要额度(预估), 记用量(号, 实际), 快照() }`。副作用：要额度会 await（等窗口腾位置）。
 */
export function 建闸(选项 = {}) {
  const 预算 = { ...默认预算, ...选项 };
  const tpm = Math.max(1, Number(预算.tpm) || 默认预算.tpm);
  const rpm = Math.max(1, Number(预算.rpm) || 默认预算.rpm);
  const 现在 = typeof 预算.现在 === 'function' ? 预算.现在 : () => Date.now();
  const 睡 = typeof 预算.睡 === 'function' ? 预算.睡 : (ms) => new Promise((r) => setTimeout(r, ms));
  const 日志 = typeof 预算.日志 === 'function' ? 预算.日志 : (() => {});

  /** 账：每条 { 时, token, 请求:1, 状态 }，按时间升序。 */
  const 账 = [];
  let 号 = 0;
  const 统计 = { 总请求: 0, 等待次数: 0, 等待毫秒: 0, 放行超限: 0, 见过的最大窗口token: 0 };

  /** 清掉过期记录。入参：无。出参：无。副作用：改 `账`。 */
  function 清() {
    while (账.length && 现在() - 账[0].时 >= 窗口毫秒) 账.shift();
  }

  /** 当前窗口合计。入参：无。出参：{ 请求数, token }。副作用：无（顺带清过期）。 */
  function 窗口() {
    清();
    let tk = 0;
    for (const 条 of 账) tk += 条.token;
    return { 请求数: 账.length, token: tk };
  }

  /**
   * 要额度：不放行就一直等。入参：预估 token、可空的 { 标签 }。出参：Promise<号>。
   * 副作用：入账、可能 await（睡到窗口腾位置）；超过最长等待就放行并告警（fail-open）。
   */
  async function 要额度(预估token, { 标签 = '' } = {}) {
    const 起等 = 现在();
    for (;;) {
      const w = 窗口();
      const 加请求超 = w.请求数 + 1 > rpm;
      const 加token超 = w.token + 预估token > tpm;
      if (!加请求超 && !加token超) {
        const 我 = ++号;
        账.push({ 时: 现在(), token: 预估token, 请求: 1, 状态: '预留', 号: 我, 标签 });
        统计.总请求 += 1;
        if (w.token > 统计.见过的最大窗口token) 统计.见过的最大窗口token = w.token;
        return 我;
      }
      const 已等 = 现在() - 起等;
      const 剩 = 预算.最长等待毫秒 - 已等;
      if (剩 <= 0) {
        统计.放行超限 += 1;
        const 我 = ++号;
        账.push({ 时: 现在(), token: 预估token, 请求: 1, 状态: '预留-超限放行', 号: 我, 标签 });
        统计.总请求 += 1;
        if (预算.记日志) 日志(`[llmbudget] 等满 ${Math.round(已等 / 1000)}s 仍无额度，放行一次（窗口 ${w.请求数} 请求 / ${w.token} token）${标签}`);
        return 我;
      }
      // 等到「最早那条过期」为止；但一次只睡「剩余可等」那么多，免得越过最长等待才醒。
      const 最早 = 账.length ? 账[0].时 : 现在();
      const 该等 = Math.max(1, Math.min(最早 + 窗口毫秒 - 现在(), 剩));
      统计.等待次数 += 1;
      统计.等待毫秒 += 该等;
      if (预算.记日志) 日志(`[llmbudget] 窗口紧张（${w.请求数}/${rpm} 请求、${w.token}/${tpm} token），这次等 ${Math.round(该等 / 1000)}s${标签}`);
      await 睡(该等);
    }
  }

  /** 记实际用量：把那次预留**替换**成实记（不叠加）。入参：号、实际 token。出参：无。副作用：改 `账`。 */
  function 记用量(我号, 实际) {
    const 条 = 账.find((x) => x.号 === 我号);
    if (!条) return;
    const n = Number(实际);
    if (!Number.isFinite(n) || n <= 0) return;          // 没拿到用量就保留预估（保守）
    条.token = Math.round(n);
    条.状态 = '实记';
  }

  /** 快照（给日志与自测看）。入参：无。出参：{ 窗口, 统计, tpm, rpm }。副作用：无。 */
  const 快照 = () => ({ 窗口: 窗口(), 统计: { ...统计 }, tpm, rpm });

  return { 要额度, 记用量, 快照 };
}

/**
 * 把闸挂到宿主的 `llm/stream` waterfall 上。入参：ctx、预算选项、日志函数。
 * 出参：闸（便于自测与诊断）。副作用：注册监听——每次模型调用先要额度，流里顺手取用量。
 */
export function 挂闸(ctx, 选项 = {}, 日志 = () => {}) {
  const 闸 = 建闸({ ...选项, 日志 });
  const 记日志 = 选项.记日志 !== false;

  ctx.on('llm/stream', (request, next) => (async function* () {
    const 预估 = 预估请求(request, 选项.输出预留 ?? 默认预算.输出预留);
    const 标签 = `（${request?.provider ?? '?'}/${request?.model ?? '?'}）`;
    const 我号 = await 闸.要额度(预估, { 标签 });
    let 实际 = 0;
    let 成 = false;
    try {
      for await (const 块 of next()) {
        const u = 取用量(块);
        if (u > 0) 实际 = u;
        yield 块;                                        // ⛔ 原样转发，不拦不改
      }
      成 = true;
    } finally {
      if (成 && 实际 > 0) 闸.记用量(我号, 实际);
      else if (记日志) 日志(`[llmbudget] 这次没拿到用量，按预估 ${预估} 记（保守）${标签}`);
    }
  })());

  return 闸;
}