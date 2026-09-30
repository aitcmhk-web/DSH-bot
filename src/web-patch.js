/**
 * 读 web 端「设置 → 模型」的真实落盘：`~/.dsh/profiles/web/cordis.patch.yml`。
 *
 * 为什么必须自己读文件，而不是只问宿主的 settings 服务（2026-09-30 定案）：
 *   - DSH 0.2.0 起，home 级 `~/.dsh/settings.yaml` 被升级流程搬走（只剩 `.imported`），
 *     web 端配置改落 `profiles/web/cordis.patch.yml`；
 *   - 而 patch **按 profile 隔离**（`dsh-app-boot/lib/index.js:946,1141`
 *     `patchPath = join(dir, PROFILE_PATCH_FILENAME)`）：插件跑在 bot profile 里，
 *     读不到 web profile 那份；
 *   - 本机 `~/.dsh/profiles/bot/cordis.patch.yml` 之所以有 llm-pi-ai，是因为
 *     `BOT/sync-from-web.mjs` 复制了一份 —— 但**别人机器上没有那个脚本**，
 *     插件装上去菜单会是空的。
 *   ⇒ 插件自己按默认安装路径读 web 那份；读不到再退回 settings 服务（本模块不管退回）。
 *
 * ⚠️ 路径用「默认安装路径」，不做遍历猜测。
 * ⚠️ 本文件**只读** web 端配置，绝不写它 —— 那是 web 端的领地。
 * ⚠️ 刻意不引 `yaml` 包：插件要发给别人，多一个依赖多一处装不上的风险；
 *    `sync-from-web.mjs` 早已定过同样口径（「不引 js-yaml，自己解析」）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** web profile 的 patch（web 端「设置 → 模型」实际写的那份）。 */
export function webPatchPath() {
  return join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml');
}

// ── 极简 YAML 读取（与 BOT/sync-from-web.mjs:98 同源，保持同构）────────────
// 只认缩进 + `key: value` + `- ` 列表项，够读 patch 的结构。
function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  // ⚠️ 顶层可能是 map（settings.yaml）也可能是 **array**（cordis.patch.yml）。
  //    先探测：第一行有效行以 `- ` 开头 → 数组。不定这层，patch 文件会被解析成
  //    一个只含最后一个条目字段的 map，`['llm-pi-ai']` 取不到 → provider 全丢。
  const firstLine = lines.find((l) => l.trim() && !l.trim().startsWith('#'));
  const isArrayDoc = /^\s*-\s+/.test(firstLine ?? '');
  const root = isArrayDoc ? [] : {};
  const stack = [{ indent: -1, node: root }];

  const stripComment = (s) => {
    let out = '';
    let q = null;
    for (const ch of s) {
      if (q) {
        out += ch;
        if (ch === q) q = null;
      } else if (ch === '"' || ch === "'") {
        q = ch;
        out += ch;
      } else if (ch === '#') break;
      else out += ch;
    }
    return out.trimEnd();
  };

  const parseScalar = (raw) => {
    const v = raw.trim();
    if (v === '') return '';
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null' || v === '~') return null;
    if (/^-?\d+$/.test(v)) return Number(v);
    if (/^-?\d*\.\d+$/.test(v)) return Number(v);
    return v;
  };

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const noComment = stripComment(raw);
    if (!noComment.trim()) continue;
    const indent = noComment.match(/^\s*/)[0].length;
    const body = noComment.trim();

    // 回退到能容纳当前缩进的层
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;

    if (body.startsWith('- ')) {
      const item = body.slice(2).trim();
      // ⚠️ 数组的父容器：上面遇到 `models:`（空值）时建的是 map，
      //    这里必须就地换成 array，否则 push 全丢（实测踩过：解析结果为空）。
      // ⚠️⚠️ 换完必须**重新取 parent** —— parent 是在换之前取的，仍指向被丢弃的旧 map，
      //    不重取就会走到 `!Array.isArray(parent)` 分支被 continue 掉（实测踩过）。
      if (stack.length > 1) {
        const top = stack[stack.length - 1];
        if (top.node && !Array.isArray(top.node) && top.parent && top.key !== undefined) {
          const arr = [];
          top.parent[top.key] = arr;
          top.node = arr;
        }
      }
      const listParent = stack[stack.length - 1].node;
      if (!Array.isArray(listParent)) continue;
      // 列表项：本结构里只有「标量项」和「key: value 开头的新 map」
      const m = item.match(/^(["']?[\w.$-]+["']?):\s*(.*)$/);
      if (m) {
        const obj = {};
        const k = m[1].replace(/^["']|["']$/g, '');
        if (m[2] !== '') obj[k] = parseScalar(m[2]);
        listParent.push(obj);
        stack.push({ indent, node: obj });
      } else {
        listParent.push(parseScalar(item));
      }
      continue;
    }

    const m = body.match(/^(["']?[\w.$-]+["']?):\s*(.*)$/);
    if (!m) continue;
    // 剥掉键上的引号：`"off": null` 的键是 off，不是 "off"（带引号会匹配不上 web 端的档名）
    const key = m[1].replace(/^["']|["']$/g, '');
    const rest = m[2];
    if (rest === '') {
      // 值在下一层 —— 可能是 map 也可能是 list，先占位 map，遇到 `- ` 再换成 array
      const container = {};
      parent[key] = container;
      stack.push({ indent, node: container, key, parent });
    } else {
      parent[key] = parseScalar(rest);
    }
  }

  return root;
}

/**
 * 读 web 端 patch 里的 `llm-pi-ai` 段（providers 表）。
 * 任何异常都返回 null —— 调用方据此退回 settings 服务，绝不抛。
 */
export function readWebLlmPiAi() {
  try {
    const p = webPatchPath();
    if (!existsSync(p)) return null;
    const doc = parseYaml(readFileSync(p, 'utf8'));
    const entries = Array.isArray(doc) ? doc : [];
    const entry = entries.find((e) => e?.id === 'llm-pi-ai');
    const providers = entry?.config?.providers;
    if (!providers || typeof providers !== 'object') return null;
    if (Object.keys(providers).length === 0) return null;
    return providers;
  } catch {
    return null;
  }
}
