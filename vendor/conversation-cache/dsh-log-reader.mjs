#!/usr/bin/env node
/**
 * dsh-log-reader — 读取 DSH 会话日志目录下的 session.v3.jsonl.zstd
 *
 * DSH 把每次会话落盘为一个 .zstd 文件：多个 zstd 帧首尾相接，每个帧解压后是
 * 一行或多行（\n 分隔）的 JSON 事件。本模块负责解码并按 chat/会话归组。
 *
 * 用法（模块化，供 cache-manager.mjs require）：
 *   import { listSessionFiles, readSessionEvents } from './dsh-log-reader.mjs'
 *
 * 命令行（调试）：
 *   node dsh-log-reader.mjs list
 *   node dsh-log-reader.mjs dump <sessionId>
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { zstdDecompressSync } from 'node:zlib';
import { homedir } from 'os';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** DSH 会话根目录（可按 DSH_HOME 覆盖）。 */
export function dshSessionsRoot() {
  const home = process.env.DSH_HOME || requireHome();
  return join(home, 'sessions', '--Users-tcm-DSH--');
}

function requireHome() {
  // 统一解析 DSH home（默认 ~/.dsh）
  return join(homedir(), '.dsh');
}

/** 解压一个 v3 压缩文件为原始文本（逐帧解压）。 */
export function decompressSessionFile(filePath) {
  let buf;
  try {
    buf = readFileSync(filePath);
  } catch (err) {
    return { ok: false, error: `读取失败: ${err.message}` };
  }
  const parts = [];
  let p = 0;
  while (p < buf.length) {
    const k = buf.indexOf(ZSTD_MAGIC, p);
    if (k < 0) break;
    let e = buf.indexOf(ZSTD_MAGIC, k + 4);
    if (e < 0) e = buf.length;
    try {
      const raw = zstdDecompressSync(buf.slice(k, e)).toString('utf8');
      if (raw.trim()) parts.push(raw.trim());
    } catch (err) {
      // 跳过不可解帧
    }
    p = e;
  }
  if (parts.length === 0) return { ok: false, error: '未找到可解码的 zstd 帧' };
  return { ok: true, text: parts.join('\n') };
}

/** 把解码文本拆成 JSON 事件数组（兼容一帧多事件）。 */
export function parseEvents(text) {
  const events = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      // 单行非合法 JSON -> 跳过
    }
  }
  return events;
}

/** 列出所有 tg 会话文件（按修改时间倒序）。 */
export function listSessionFiles() {
  const root = dshSessionsRoot();
  const out = [];
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    if (!/^tg-/.test(d.name)) continue;
    const f = join(root, d.name, 'session.v3.jsonl.zstd');
    if (!existsSync(f)) continue;
    try {
      const st = statSync(f);
      out.push({ sessionId: d.name, file: f, mtimeMs: st.mtimeMs, bytes: st.size });
    } catch {}
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 读出一个会话的全部事件。 */
export function readSessionEvents(sessionIdOrFile) {
  const file = sessionIdOrFile.includes('/') ? sessionIdOrFile : join(
    dshSessionsRoot(), sessionIdOrFile, 'session.v3.jsonl.zstd'
  );
  const res = decompressSessionFile(file);
  if (!res.ok) return { ok: false, events: [], error: res.error };
  return { ok: true, events: parseEvents(res.text), error: null };
}

/** 从会话 id 抽取 chatId（tg-<chatid>-<ts>-<rand>）。 */
export function chatIdFromSession(sessionId) {
  const m = /^tg-(\d+)-/.exec(sessionId);
  return m ? m[1] : null;
}

// ─── CLI 调试 ──────────────────────────────────────────────
if (process.argv[1] && basename(process.argv[1]).includes('dsh-log-reader')) {
  const cmd = process.argv[2];
  if (cmd === 'list') {
    const files = listSessionFiles();
    console.log(`找到 ${files.length} 个 tg 会话:`);
    for (const f of files) {
      const chat = chatIdFromSession(f.sessionId);
      console.log(`  [chat ${chat}] ${f.sessionId}  (${(f.bytes/1024).toFixed(0)}KB, ${new Date(f.mtimeMs).toLocaleString('zh-CN', { hour12: false })})`);
    }
  } else if (cmd === 'dump') {
    const sid = process.argv[3];
    const { ok, events, error } = readSessionEvents(sid);
    if (!ok) { console.error('❌', error); process.exit(1); }
    console.log(`会话 ${sid}: ${events.length} 个事件`);
    const types = {};
    for (const e of events) types[e.type] = (types[e.type]||0)+1;
    console.log('类型分布:', types);
  } else {
    console.log('用法: node dsh-log-reader.mjs list | dump <sessionId>');
  }
}