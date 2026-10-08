/**
 * sync-from-web.mjs — 从 Web 端设置生成 BOT 的模型菜单（单向同步）。
 *
 * 用户 2026-09-19 定死：**模型只有一份，在 Web 端改**（设置 → 模型）。
 * Web 端把配置写进 `~/.dsh/settings.yaml`，本脚本读它 → 生成
 * `web-models.json` → models.js 读它当菜单来源。
 *
 * 为什么不是让 BOT 每次启动直接读 `~/.dsh/settings.yaml`：
 *   1. 那份文件是 YAML，BOT 不想为此引入依赖（现有代码零依赖靠手写 parser）；
 *   2. Web 端随时可能改，解析失败不能让 BOT 起不来 —— 落成缓存后坏了还有旧的可用；
 *   3. 转换逻辑（provider → 菜单档位）需要单点维护，别散在 models.js 里。
 *
 * 用法:
 *   node sync-from-web.mjs            # 读 web settings → 写 web-models.json
 *   node sync-from-web.mjs --check    # 只看会生成什么，不写文件
 *   node sync-from-web.mjs --print    # 打印生成结果
 *
 * ⚠️ 本脚本**只读** `~/.dsh/settings.yaml`，**绝不写它** —— 那是 Web 端的领地。
 */

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = dirname(fileURLToPath(import.meta.url));

// ── Web 端设置在哪 ─────────────────────────────────────────────
// ⚠️ 2026-09-30 实证：DSH 0.2.0-rc.2 起，home 级 `~/.dsh/settings.yaml` **会被搬走**。
//    `dsh-settings` 在加载器稳定后调 `importLegacyDocument()`：把那份
//    **改名成 `settings.yaml.imported`**，再把各节 `update()` 进当前 profile。
//    现象：`~/.dsh/settings.yaml` 已不存在，`.imported` 停在 2026-09-29 03:10
//    （正是升级窗口），本脚本却还在读那个空路径 → 每次启动都报「找不到 web 端设置」。
//
// ❓ 迁移后 Web 端到底写哪：一次**错误**的推断是「写 profile 的 cordis.patch.yml」。
//    实测否掉：`~/.dsh/profiles/web/cordis.patch.yml` 是 217 B 的模板，内容就是个 `[]`，
//    从未被写过；`profiles/web/settings.yaml` 则是 09-27 的旧内容，比 `.imported` **旧**。
//    ⇒ Web 端写的始终是 home 级那份；那份现在叫 `.imported`。
//
// ⇒ 读取顺序（谁在就用谁，⚠️ **不按路径优先级，按「存在」**）：
//    1. `SETTINGS_PATH` —— 测试用覆盖，最高优先
//    2. `~/.dsh/settings.yaml` —— 老版本（0.1.5 及更早）的活路径，回滚时仍是真的
//    3. `~/.dsh/settings.yaml.imported` —— 0.2.0 迁移后的存放处（名字像墓碑，内容却是最新的）
// ⚠️ 刻意**不**把 `profiles/web/settings.yaml` 放进候选：它是旧一代内容，
//    用它会把菜单从 7 档缩到 5 档、默认档从智谱退回本地 VQ（实测过，见备份 diff）。
const SETTINGS_CANDIDATES = [
  process.env.SETTINGS_PATH,
  join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml'),
  join(homedir(), '.dsh', 'settings.yaml'),
  join(homedir(), '.dsh', 'settings.yaml.imported'),
].filter(Boolean);

/** 选中的那份。找不到时停在最后一个候选上，只为把路径打进报错信息。 */
let SETTINGS = SETTINGS_CANDIDATES[SETTINGS_CANDIDATES.length - 1];

/** 在候选里挑第一份**存在**的。刻意不要求「非空」——空文件会走到后面
 *  「没解析出任何 provider」的分支，那里的报错更准确。 */
function resolveSettingsPath() {
  const found = SETTINGS_CANDIDATES.find((p) => existsSync(p));
  if (found) SETTINGS = found;
  return found ?? null;
}

const OUT = join(ROOT, 'web-models.json');

// ── 兼容两种输入格式 ───────────────────────────────────────────
// ① 老式 settings.yaml：顶层直接是 `llm-pi-ai:` 等键
// ② 新式 cordis.patch.yml（2026-09-30 起 Web 端实际写的那份）：
//    顶层是**数组**，模型藏在 `- id: llm-pi-ai` 条目的 `config.providers` 下
//
// 本函数把 ② 摊平成 ① 的形状，下游 buildRoutes/extractWebProviderBlocks 不用改。
function normalizeSettings(parsed) {
  if (!Array.isArray(parsed)) return parsed; // 已经是 ① 形状

  const out = {};
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const id = entry.id;
    if (!id || !entry.config) continue;
    out[id] = entry.config;
  }
  return out;
}

/** 读新式 patch 文件时，provider 块的缩进更深，抽取函数要按实际缩进找。 */
function isPatchFormat() {
  try {
    return /^\s*-\s+id:/m.test(readFileSync(SETTINGS, 'utf8').split('\n').slice(0, 40).join('\n'));
  } catch {
    return false;
  }
}

// ── 极简 YAML 读取 ─────────────────────────────────────────────
// 只认缩进 + `key: value` + `- ` 列表项，够读 settings.yaml 的结构。
// 不引 js-yaml：BOT 是独立项目，不该依赖 ~/.dsh 里的 node_modules
// （那正是「项目间串味」；而且搬家后路径就断了）。
function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  // ⚠️ 顶层可能是 map（settings.yaml）也可能是 **array**（cordis.patch.yml）。
  //    先探测：第一行有效行以 `- ` 开头 → 数组。不定这层，patch 文件会被解析成
  //    一个只含最后一个条目字段的 map，`['llm-pi-ai']` 取不到 → provider 全丢。
  const firstLine = lines.find((l) => l.trim() && !l.trim().startsWith('#'));
  const isArrayDoc = /^\s*-\s+/.test(firstLine ?? '');
  const root = isArrayDoc ? [] : {};
  // 栈：每层记录缩进量与对应容器
  const stack = [{ indent: -1, node: root }];

  const stripComment = (s) => {
    // 只在「非引号内」时去掉 # 注释；settings.yaml 里值都没有内嵌 #
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
    if (v === '' ) return '';
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

  // 后处理：把「只有 0..n 数字键」的 map 还原成 array（YAML 列表被我上面建成了 map）
  const fixArrays = (node) => {
    if (Array.isArray(node)) {
      node.forEach(fixArrays);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const keys = Object.keys(node);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      // 不还原 —— 上面列表项其实已 push 进 array，这里只兜底
    }
    for (const k of keys) fixArrays(node[k]);
  };
  fixArrays(root);
  return root;
}

// ── provider → BOT 菜单档位 key ────────────────────────────────
// ⚠️ 这些 key 是**历史固定值**，被 .env 的 HARNESS_MODEL_ROUTE 和 .state.json 的
//    routeKey 引用着，**不能**跟着 provider 名改（改了会让用户已选的档失配、回落默认）。
//    未列出的 provider 才用 provider 名当 key。
const KEY_ALIAS = {
  alibailian: 'ali',
  'deepseek-official': 'ds',
  // 2026-10-02：DeepSeek **账户**档（桌面版登录账户后 Web 端多出来的那一档）。
  //    和 `ds`（API key 档）是两个不同的 provider —— 模型名一模一样，靠 key 前缀区分。
  'deepseek-account': 'dsa',
  // 2026-09-27：VQ（MLX）接替 IQ4 成为 `local` 档（开机自启、日常默认）。
  // IQ4 退为备用档，用独立 key `iq4` —— 两个 provider 抢同一个 key 会互相覆盖，
  // 菜单里只会剩最后一个（实测过，别改回去）。
  qwen36vq: 'local',
  qwen36iq4xs: 'iq4',
};

/** provider id → 菜单 key */
function menuKey(pid) {
  return KEY_ALIAS[pid] ?? pid;
}

// ── 从 web settings 抽出「档位」────────────────────────────────
// 内置 provider（llm-deepseek 等）走顶层 `llm-xxx` 段；
// 自定义 provider 走 `llm-pi-ai.providers.<id>`。
//
// ⭐ 平铺：**一个模型 = 一个档**（用户 2026-09-19 定：菜单不搞二级，全铺开）。
//    所以 provider 下有 N 个模型就产生 N 个 route，各自可点。
//
// key 规则（重要，别乱改）：
//   · provider 只有 1 个模型 → 用固定的简短别名（ali / ds / local）——
//     这是**历史 key**，被 .env 的 HARNESS_MODEL_ROUTE 和 .state.json 的 routeKey
//     引用着，保持不变才不会让用户已选的档失配。
//   · provider 有多个模型 → 每个模型一个 key，形如 `<别名>:<模型id>`。
//     用 `:` 分隔是安全的：菜单回调本身是 `model:<key>`，解析时按首个 `:` 拆即可。
function routeKeyFor(pid, modelId, isOnlyModel) {
  const alias = menuKey(pid);
  return isOnlyModel ? alias : `${alias}:${modelId}`;
}

/** 该 provider 的 displayName（供菜单显示，user 在 web 端可改） */
function providerLabel(pid, p) {
  return p?.displayName ?? pid;
}

/**
 * 平铺菜单的按钮文字。
 *
 * ⚠️ 必须截断：Telegram 按钮放不下长文本，而本地档的模型 id 长达 62 字符
 *    （旧 IQ4 是 `HauhauCS/Qwen3.6-35B-A3B-Uncensored-...:IQ4_XS`；
 *      现 VQ 为 hf 缓存绝对路径，更长）。
 *    多模型时拼成「provider · 模型」会变成一屏宽，按钮直接没法看。
 *    截断只影响**显示**；真正定位用什么模型靠 key（`<别名>:<完整模型id>`），不受影响。
 */
// ⚠️ 24 太宽：Telegram inline 按钮一行放不下会折行，看起来就是错位。
//    现在统一格式后（`DS:V4-Pro`）一般不会超，超了也不截断 —— 见 menuLabel 注释。
const LABEL_MAX = 15;
/**
 * 菜单按钮文字 —— **统一格式：`短名:模型名`**（用户 2026-09-19 定死）。
 *
 * ⚠️ 用户原话：「所有的，不管是一个还是多个，统一用标准模式，DS：具体模型，Ali：具体模型」
 *    → **不要**再区分"单模型只显示 provider 名"「多模型才带模型名」。
 *    一律 `DS:V4-Pro` / `阿里:qwen3.7-flash` / `本地:VQ-4.6bpw`（本地档 2026-09-27 起为 VQ）。
 *
 * ⚠️ **不截断**（用户抱怨过「DS：」「Ali：」那种看不全的观感）：
 *    宁可按钮宽一点，也要让模型名完整可读。Telegram 会自己折行，不会丢字。
 */
function menuLabel(label, modelName) {
  return `${label}:${modelName}`;
}

/**
 * 菜单按钮上的 provider 前缀 —— **用 Web 端的全名**（用户 2026-09-19 定死）。
 *
 * ⚠️ 用户原话：「我说的是前缀」—— 我之前擅自缩成 `DS`/`阿里`/`本地`，
 *    用户要的是**全名前缀**：`深度求索:DeepSeek-V4-Pro`、`阿里百炼:qwen3.7-flash`。
 *    provider 名 = Web 端 `displayName`（用户可改），没写才退回 pid。
 */
function providerPrefix(pid, displayName) {
  return displayName ?? pid;
}

/**
 * DeepSeek **账户**档当前可不可用（= 账户登录过没）。
 *
 * 凭据由 `dsh-deepseek-account-platform` 写进共享的 `~/.dsh/.credentials.yaml`，
 * 记录形状是 `kind: grant`（见 dsh-deepseek-account-platform/lib/index.js:1030）。
 * 文件不存在 / 没有这条记录 → false，菜单里就不出现账户档。
 *
 * ⚠️ 只做**存在性**判断，绝不读出、更不打印内容 —— 那是钥匙串。
 */
function accountSignedIn() {
  try {
    const f = join(homedir(), '.dsh', '.credentials.yaml');
    return readFileSync(f, 'utf8').includes('kind: grant');
  } catch {
    return false;
  }
}

export function buildRoutes(settings) {
  const routes = [];
  const def = settings['agent-default-model'] ?? {};
  const defaultProvider = def.provider;
  const defaultModel = def.model;

  // 1) 自定义 provider（llm-pi-ai）
  const providers = settings['llm-pi-ai']?.providers ?? {};
  for (const [pid, p] of Object.entries(providers)) {
    const models = (Array.isArray(p.models) ? p.models : []).filter((m) => m?.id);
    if (models.length === 0) continue;
    const isLocal = /localhost|127\.0\.0\.1/.test(String(p.baseURL ?? ''));
    const label = providerLabel(pid, p);
    const provPrefix = providerPrefix(pid, label);
    for (const m of models) {
      routes.push({
        key: routeKeyFor(pid, m.id, models.length === 1),
        label,
        // ⚠️ 用户 2026-09-19 定死：**一律全名，不截断**。
        //    短名只用 provider 部分（DS/阿里/本地），模型名部分用原名。
        short: menuLabel(provPrefix, m.name ?? m.id),
        provider: pid,
        model: m.id,
        displayName: m.name ?? m.id,
        // ⚠️ 绝不用 'off' 当默认值（2026-09-28 实测炸过：zhipu/glm-5.3-flash 报
        //    `does not support reasoning effort "off"`，整个档位切不过去）。
        //    'none' = **不发这个参数**，由模型自己的默认档决定。
        //    ⛔ 不能写成 undefined：JSON.stringify 会把值为 undefined 的键整个丢掉，
        //    读的人分不清「没声明」和「生成时没看见」，于是又落回兜底值 —— 这个坑当天踩过。
        reasoningEffort: p.reasoning ?? 'none',
        local: isLocal || undefined,
        // 是否 web 端当前选中的默认档
        isDefault: pid === defaultProvider && m.id === defaultModel,
      });
    }
  }

  // 2) 内置 provider（llm-deepseek）
  //
  // ⚠️ 坑（2026-09-19 用户报「菜单只有阿里和本地」）：原来这里要求
  //    `settings['llm-deepseek']` 必须自带 `models` 数组，但 Web 端那段**通常只有
  //    `reasoningEffort: off`、没有 models**（deepseek-official 是 DSH 内置 provider，
  //    由 dsh-llm-deepseek 自己注册模型，Web 端不需要声明）。
  //    结果循环一次都不跑 → `ds` 档整个从菜单消失，且**不报错**。
  //
  // ⚠️ 第二个坑（同日，用户报「实际 DS 有多个，并没有出来」）：我第一版兜底**写死**
  //    只给一个 `deepseek-flash` —— 而 DS 实际有 4 个模型。写死 = 以后 DSH 升级加模型，
  //    菜单永远看不到。**正解：从 DSH 插件源码里读 DEFAULT_MODELS**，动态跟随。
  const deepseek = settings['llm-deepseek'] ?? {};
  const declared = (Array.isArray(deepseek.models) ? deepseek.models : []).filter((m) => m?.id);
  // Web 端声明了就以 Web 端为准；没声明则从 DSH 插件源码读内置模型表
  const dsModels = declared.length > 0 ? declared : readBuiltinDeepseekModels();
  {
    const models = dsModels;
    const label = '深度求索';
    const provPrefix = providerPrefix('deepseek-official', label);
    for (const m of models) {
      // ⚠️ 用户 2026-09-19 定死：按钮用**全名**，不要剥 `DeepSeek-` 前缀。
      //    我原来剥了前缀想省宽度，用户明确要全名 —— 显示宽度够（最宽约 21），别自作主张截。
      routes.push({
        key: routeKeyFor('deepseek-official', m.id, models.length === 1),
        label,
        short: menuLabel(provPrefix, m.name ?? m.id),
        provider: 'deepseek-official',
        model: m.id,
        displayName: m.name ?? m.id,
        // 同上：deepseek 没显式配 reasoningEffort 就不发（'none'），交给模型默认。
        reasoningEffort: deepseek.reasoningEffort ?? 'none',
        isDefault: defaultProvider === 'deepseek-official' && m.id === defaultModel,
      });
    }
  }

  // 3) DeepSeek **账户**档（dsh-base 内置的 dsh-llm-deepseek-account，provider = deepseek-account）
  //
  //    用户 2026-10-02 要求：桌面版登录账户后 Web 端模型列表多出这一档，菜单要跟上。
  //
  //    ⚠️ 这一档的模型表和上面内置 ds **逐字相同** —— 账户档的 Config 直接复用
  //       dsh-llm-deepseek 那份 `DEFAULT_MODELS`，它的 discoverModels 也只是把
  //       `connection.models` 返回出去，并没有另一份表。名字重样是正常的，
  //       两档靠 provider 区分（key 前缀 `dsa:` vs `ds:`，菜单前缀
  //       `DeepSeek Account` vs `深度求索`），不能靠模型名区分。
  //    ⚠️ reasoningEffort 固定 'none'（= 不发这个参数）：账户档没有独立的 settings
  //       段可读，与 ds 档同口径，交给模型自己的默认档。
  if (accountSignedIn()) {
    const acctPid = 'deepseek-account';
    const acctLabel = 'DeepSeek Account';
    const acctPrefix = providerPrefix(acctPid, acctLabel);
    for (const m of dsModels) {
      routes.push({
        key: routeKeyFor(acctPid, m.id, dsModels.length === 1),
        label: acctLabel,
        short: menuLabel(acctPrefix, m.name ?? m.id),
        provider: acctPid,
        model: m.id,
        displayName: m.name ?? m.id,
        reasoningEffort: 'none',
        isDefault: defaultProvider === acctPid && m.id === defaultModel,
      });
    }
  }

  // ⭐ 本地档永远垫底（用户 2026-09-28 定）：这份顺序就是 /model 菜单的展示顺序，
  //    本地排第一看起来像默认首选，也是「回退一挂就撞本地」的根源
  //    （回退链在 bot.js 另有兜底，这里把源头顺序摆正，两处口径一致）。
  //    稳定分区：只把 local 档挪到最后，其余相对顺序原样；按 baseURL 判定的
  //    local 标记识别，不认 key（以后换本地 provider 也不用改这里）。
  const ordered = [...routes.filter((r) => !r.local), ...routes.filter((r) => r.local)];
  return { routes: ordered, defaultProvider, defaultModel };
}

/** 找 defaultRouteKey：优先 web 端标记的默认档，否则 web 的 agent-default-model 匹配，再否则第一个。 */
function pickDefaultKey(routes) {
  const flagged = routes.find((r) => r.isDefault);
  if (flagged) return flagged.key;
  return routes[0]?.key ?? null;
}

// ── 生成 cordis.patch.yml ──────────────────────────────────────
// 为什么必须生成它：SDK profile 只吃这份 patch（patch 的 config 是**整体替换**、
// 不深合并），所以光同步 settings.yaml **不生效** —— Web 端新加的 provider
// 在 BOT 里会报 `no adapter registered for provider "xxx"`。
//
// ⚠️⚠️ 这份文件里**还有别的块**（`compaction-basic` 会话压缩阈值）。
//    绝不能整体重写 —— 我以前就这么干过，删掉了整个 compaction-basic，
//    导致压缩阈值回落默认 0.8（100 万窗口要 80 万 token 才压缩）→ token 暴涨且静默。
//    所以本函数**只生成 llm-pi-ai 块**，其余块从现有文件里**原样搬运**。
const PATCH_PATH = process.env.PATCH_PATH
  || join(homedir(), '.dsh', 'profiles', 'bot', 'cordis.patch.yml');

/** YAML 标量编码：只在必要时加引号 */
function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  // 含特殊字符或会被误解析成别的类型时加引号
  if (s === '' || /^[\s]|[\s]$/.test(s) || /[:#{}[\],&*?|>%@`"']/.test(s) || /^(true|false|null|~|-?\d)/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/** 把对象递归写成 YAML（缩进 2 空格），用于 llm-pi-ai 块 */
function toYaml(node, indent = 0) {
  const pad = ' '.repeat(indent);
  const lines = [];
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === 'object') {
        const sub = toYaml(item, indent + 2);
        // 第一行接在 `- ` 后面
        const subLines = sub.split('\n');
        lines.push(`${pad}- ${subLines[0].trimStart()}`);
        for (const l of subLines.slice(1)) if (l.trim()) lines.push(l);
      } else {
        lines.push(`${pad}- ${yamlScalar(item)}`);
      }
    }
    return lines.join('\n');
  }
  for (const [k, v] of Object.entries(node)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && Object.keys(v).length > 0) {
      lines.push(`${pad}${k}:`);
      lines.push(toYaml(v, indent + 2));
    } else if (v && typeof v === 'object') {
      lines.push(`${pad}${k}: {}`);
    } else {
      lines.push(`${pad}${k}: ${yamlScalar(v)}`);
    }
  }
  return lines.filter((l) => l !== '').join('\n');
}

/**
 * 生成新的 cordis.patch.yml 全文。
 *
 * @param {object} settings - web settings 解析结果
 * @param {string} existing - 现有 patch 文件内容（用于搬运 compaction-basic 等其它块）
 */
export function buildPatch(settings, existing) {
  const providers = settings['llm-pi-ai']?.providers ?? {};

  // ⚠️ 保留「旧 patch 里有、Web 端没有」的 provider（如 qwen-token-plan）。
  //    理由：Web 端是模型定义的**主**来源，但它并不认识所有 BOT 专用 provider；
  //    直接按 Web 端全量重建会**静默删掉**它们（我 2026-09-19 第一版就删了 qwen-token-plan）。
  //    策略：Web 端有的以 Web 端为准；Web 端没有的，原样保留旧文本块。
  const preserved = extractProviderBlocks(existing, new Set(Object.keys(providers)));

  // ⭐ 直接**从 Web 端 settings.yaml 原文搬运 provider 块**（而非逐字段重建）。
  //
  // 为什么这么做（我 2026-09-19 第一版栽过）：
  //   逐字段重建 = 只搬我枚举到的字段 + **注释全丢**。后果有两个，都是静默的：
  //   ① Web 端 `qwen36iq4xs` 那段有 8 行注释解释「为什么必须用 qwen-chat-template 关思考、
  //      为什么 low 是必需占位档、为什么不能改成 reasoningEfforts: false」——
  //      全丢之后，下一个会话看到这个值会以为写错了，很可能改回 `qwen`，**把思考打开**。
  //   ② 我没枚举到的字段（如 `imagePixelBudget`）会**凭空消失**，且不报错。
  //   文本搬运则天然保留注释、字段顺序、以及所有我还没见过的字段。
  const webBlocks = extractWebProviderBlocks(new Set(Object.keys(providers)));

  // 搬运现有文件里「除 llm-pi-ai / llm-deepseek 之外」的顶层块（原样文本，不做解析再生成，
  // 避免把我自己没读懂的格式改正 —— 尤其 compaction-basic 那段带注释）
  const others = extractOtherBlocks(existing);

  // llm-deepseek 段同样**从 Web 端生成**，不硬编码任何字段。
  // Web 端没写这一段 → 返回空串（不注入空壳，让 DSH 内置层自己生效）。
  const deepseekBlock = buildDeepseekBlock(settings);

  const head = [
    '# llm-pi-ai provider 表 —— ⚠️ 本文件的 `llm-pi-ai` 块由 BOT/sync-from-web.mjs 自动生成，',
    '#    来源是 Web 端「设置 → 模型」（~/.dsh/settings.yaml）。手改会被下次同步覆盖。',
    '#    provider 块连同其注释**原样搬运**自 Web 端，所以下面那些解释性注释也是 Web 端的。',
    '#    下方其它块（compaction-basic 等）是手工维护的，同步脚本原样保留、不动。',
    '#',
    '# 为什么 SDK profile 只吃这份 patch：patch 的 config 是**整体替换**、不深合并，',
    '#    所以只改 settings.yaml 不生效（新 provider 会报 no adapter registered）。',
  ].join('\n');

  // Web 端块按 settings.yaml 里的原缩进（6 空格 = providers 下一层）搬过来
  const llmBlock = `- id: llm-pi-ai\n  config:\n    providers:\n${webBlocks}${preserved}`;

  return `${head}\n${llmBlock}\n${deepseekBlock}${others}`;
}

/**
 * 生成 `llm-deepseek` 段 —— 整段照抄 Web 端，不硬编码任何字段。
 *
 * ⚠️ 为什么不再手写：BOT 端此前把这一段当「手工块」维护，写了 `models: [三个]`，
 *    其中 `deepseek-v4-flash` 在 DSH 出厂表里**不存在**（出厂只有 deepseek-flash、
 *    deepseek-v4-pro，见 dsh-llm-deepseek/lib/index.js 的 DEFAULT_MODELS）。
 *    手写 = 与出厂表漂移，DSH 升级后打架。
 *
 * 用户 2026-09-30 定死：**这一段的唯一来源是 Web 端 `cordis.patch.yml`**。
 *   · Web 端有 `- id: llm-deepseek` → 把它的 config 原样序列化过来
 *   · Web 端没有 → 返回空串，**不注入空壳**（让 DSH 内置层自己生效）
 *
 * @param {object} settings - normalizeSettings 摊平后的结果（settings['llm-deepseek'] = config）
 */
function buildDeepseekBlock(settings) {
  const cfg = settings['llm-deepseek'];
  if (!cfg || typeof cfg !== 'object' || Object.keys(cfg).length === 0) return '';

  const lines = ['- id: llm-deepseek', '  name: "@deepseek-ai/dsh-llm-deepseek-api-key"'];
  const keys = Object.keys(cfg);
  if (keys.length > 0) {
    lines.push('  config:');
    for (const k of keys) lines.push(...renderYamlField(k, cfg[k], 4));
  }
  return lines.join('\n') + '\n';
}

/** 把任意 YAML 值渲染成缩进块（标量 / 数组 / 嵌套对象都吃）。 */
function renderYamlField(key, value, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${key}: []`];
    // 标量数组走行内，省得每个元素占一行
    if (value.every((v) => v === null || typeof v !== 'object')) {
      return [`${pad}${key}:`, ...value.map((v) => `${pad}  - ${yamlScalar(v)}`)];
    }
    const out = [`${pad}${key}:`];
    for (const item of value) {
      const entries = Object.entries(item ?? {});
      if (entries.length === 0) { out.push(`${pad}  - {}`); continue; }
      const [k0, v0] = entries[0];
      if (v0 !== null && typeof v0 === 'object') {
        out.push(`${pad}  - ${k0}:`);
        out.push(...renderYamlField(k0, v0, indent + 4).slice(1));
      } else {
        out.push(`${pad}  - ${k0}: ${yamlScalar(v0)}`);
      }
      for (const [k, v] of entries.slice(1)) out.push(...renderYamlField(k, v, indent + 4));
    }
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${pad}${key}: {}`];
    const out = [`${pad}${key}:`];
    for (const [k, v] of entries) out.push(...renderYamlField(k, v, indent + 2));
    return out;
  }
  return [`${pad}${key}: ${yamlScalar(value)}`];
}

/**
 * 从 DSH 内置的 `dsh-llm-deepseek` 插件源码里读出 `DEFAULT_MODELS`（id + name）。
 *
 * 为什么读源码而不是写死列表：DS 的模型是**插件自己注册**的，Web 端 settings.yaml 里
 * 根本不出现（deepseek-official 写进 `llm-pi-ai.providers` 会 DUPLICATE_ADAPTER 全盘挂）。
 * 写死 = DSH 升级加了模型，菜单永远看不到（用户 2026-09-19 就是这么发现我漏了 3 个模型的）。
 *
 * 失败时返回单个 `deepseek-flash` 兜底，并打警告 —— 菜单少几个档好过整个 ds 档消失。
 */
function readBuiltinDeepseekModels() {
  const FALLBACK = [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }];
  const candidates = [
    // npx 缓存里的实际路径（HARNESS_BIN 指向的那份）
    '/Users/tcm/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js',
  ];
  // 再从 HARNESS_BIN 反推，兼容换 npx 缓存 hash 的情况
  const bin = process.env.HARNESS_BIN;
  if (bin) {
    const m = bin.match(/^(.*)\/node_modules\/\.bin\/dsh$/);
    if (m) candidates.unshift(`${m[1]}/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`);
  }
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const src = readFileSync(p, 'utf8');
      const start = src.indexOf('const DEFAULT_MODELS = [');
      if (start < 0) continue;
      const end = src.indexOf('\n];', start);
      if (end < 0) continue;
      const block = src.slice(start, end);
      const out = [];
      // 逐个模型块：抓 id 和（可选的）name
      for (const chunk of block.split(/\},\s*\{/)) {
        const idm = chunk.match(/id:\s*"([^"]+)"/);
        if (!idm) continue;
        const nm = chunk.match(/name:\s*"([^"]+)"/);
        out.push({ id: idm[1], name: nm ? nm[1] : idm[1] });
      }
      if (out.length > 0) return out;
    } catch {
      // 读不到就试下一个候选
    }
  }
  console.error('[websync] ⚠️  读不到 dsh-llm-deepseek 的内置模型表，ds 档退回单个 deepseek-flash');
  return FALLBACK;
}

/**
 * 从 **Web 端 settings.yaml 原文**抽出 `llm-pi-ai.providers` 下的 provider 块（含注释）。
 *
 * 返回可直接拼在 `providers:` 之后的文本（缩进已是 6 空格），只含 `want` 里的名字。
 *
 * 为什么要原文搬运而不是解析后重建：见调用处的注释 —— 重建会丢注释、丢未枚举字段。
 * ⚠️ 抽出的块会**去掉** BOT 不需要的字段吗？不会。Web 端 settings.yaml 里 provider
 *    下面是模型定义，patch 要的就是这些；多带的字段 dsh 会忽略（未知键不报错）。
 */
function extractWebProviderBlocks(want) {
  const raw = readFileSync(SETTINGS, 'utf8');
  const lines = raw.split('\n');

  // 1) 定位 llm-pi-ai → providers:
  //    两种格式：
  //      ① settings.yaml —— 顶层 `llm-pi-ai:`，缩进 0
  //      ② cordis.patch.yml —— `- id: llm-pi-ai` 数组条目，providers 嵌在 config 下
  let inLlm = false;
  let providersIndent = -1;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // ② 数组条目形式：`- id: llm-pi-ai`
    const arr = line.match(/^(\s*)-\s+id:\s*llm-pi-ai\s*$/);
    if (arr) { inLlm = true; continue; }
    // ① 顶层键形式
    if (/^\S/.test(line) && !/^\s/.test(line)) {
      inLlm = /^llm-pi-ai:\s*$/.test(line);
      continue;
    }
    // ② 遇到下一个数组条目就停，防止串到别的条目里
    if (inLlm && /^\s*-\s+id:/.test(line)) break;
    if (!inLlm) continue;
    const m = line.match(/^(\s*)providers:\s*$/);
    if (m) {
      providersIndent = m[1].length;
      start = i + 1;
      break;
    }
  }
  if (start < 0) return '';

  // 2) 找到 providers 段结束：缩进 <= providersIndent 且非空的行
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= providersIndent) { end = i; break; }
  }

  // 3) 按 provider 名切块（缩进 = providersIndent + 2 的 `name:` 行）
  const nameIndent = providersIndent + 2;
  const chunks = [];
  let cur = null;
  // 先把 providers 之后、第一个 provider 之前的注释挂到第一个块上
  let pendingComments = [];
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (!line.trim()) { if (cur) cur.lines.push(line); else pendingComments.push(line); continue; }
    const indent = line.match(/^\s*/)[0].length;
    if (indent === nameIndent && /^[\w.$-]+:\s*$/.test(line.trim())) {
      if (cur) chunks.push(cur);
      cur = { name: line.trim().replace(/:$/, ''), lines: [...pendingComments, line] };
      pendingComments = [];
    } else if (cur) {
      cur.lines.push(line);
    } else {
      pendingComments.push(line);
    }
  }
  if (cur) chunks.push(cur);

  const kept = chunks.filter((c) => want.has(c.name));
  if (kept.length === 0) return '';
  // ⚠️ 缩进对齐：patch 里 provider 名必须落在 6 空格（providers 的下一层）。
  //    ① settings.yaml 格式：provider 名原本在 4 空格 → 需整体 +2
  //    ② cordis.patch.yml 格式：原本就在 6 空格（嵌在 config 下）→ **不能再缩**
  //    不处理会让 provider 名与 `providers:` 平级 → YAML 解析成 null → 整个表消失。
  const body = kept.map((c) => c.lines.join('\n').replace(/\s+$/, '')).join('\n');
  const needShift = nameIndent < 6;
  const shifted = needShift
    ? body.split('\n').map((l) => (l.trim() ? '  ' + l : l)).join('\n')
    : body;
  return shifted + '\n';
}

/**
 *
 * 用途：Web 端不认识的 BOT 专用 provider（如 qwen-token-plan）要保住。
 * 返回可直接拼在 `providers:` 之后的字符串（带前导换行），缩进按 6 空格（= providers 的下一层）。
 *
 * ⚠️ 这里刻意用**文本搬运**而不是解析再生成：这些块里可能有我没读懂的字段/注释，
 *    重新生成有丢值风险（我在 cordis.patch.yml 上已经栽过一次）。
 *    只有 Web 端完全没提到的 provider 才走这条路；Web 端提到的以 Web 端为准。
 */
function extractProviderBlocks(text, webProviders) {
  const lines = text.split('\n');
  // 定位 llm-pi-ai 块 → 其 config.providers 行
  let inLlm = false;
  let providersIndent = -1;
  let start = -1;
  const chunks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^- id:/.test(line)) {
      inLlm = /^- id:\s*llm-pi-ai\s*$/.test(line);
      continue;
    }
    if (!inLlm) continue;
    const m = line.match(/^(\s*)providers:\s*$/);
    if (m) {
      providersIndent = m[1].length;
      start = i + 1;
      break;
    }
  }
  if (start < 0) return '';

  // 从 providers 之后扫到 llm-pi-ai 块结束（下一个顶层 `- id:` 或文件尾）
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^- id:/.test(lines[i])) { end = i; break; }
  }

  // provider 名所在缩进 = providersIndent + 2
  const nameIndent = providersIndent + 2;
  let cur = null;
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    const isProvName = indent === nameIndent && /^[\w.$-]+:\s*$/.test(line.trim());
    if (isProvName) {
      if (cur) chunks.push(cur);
      cur = { name: line.trim().replace(/:$/, ''), lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) chunks.push(cur);

  // 只保留 Web 端没声明的（Web 端有的会被重新生成，避免重复 key）
  const kept = chunks.filter((c) => !webProviders.has(c.name));
  if (kept.length === 0) return '';
  const body = kept.map((c) => c.lines.join('\n').replace(/\s+$/, '')).join('\n');
  return '\n' + body;
}

/**
 * 从现有 patch 文本里抽出「非 llm-pi-ai」的顶层块（含其前的注释）。
 * 以 `- id: xxx` 为块起点，到下一个块的头部注释起点（或文件尾）为终点。
 * ⚠️ #37（2026-10-08）：终点不能用下一个 `- id:` 行 —— 否则下一块的头部注释
 *    会先被算进本块尾部、下一块自己又「向上吸收」一遍 → 每跑一次同步凭空多一份注释
 *    （实测：LLITE 门控注释 09-30 起每次 bot 启动 +1 遍，堆到 333 遍）。
 */
function extractOtherBlocks(text) {
  const lines = text.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^- id:/.test(lines[i])) starts.push(i);
  }
  if (starts.length === 0) return '\n';
  // 每块先算「头部注释起点」（向上吸收紧邻的注释行，遇非注释/空行停）
  const heads = starts.map((from) => {
    let begin = from;
    while (begin > 0 && /^\s*#/.test(lines[begin - 1])) begin--;
    return begin;
  });
  const chunks = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const id = lines[from].replace(/^- id:\s*/, '').trim();
    // ⚠️ 这两个块**由 Web 端同步生成**，不从旧文件照搬（照搬 = Web 端改动永远进不来）：
    //    · llm-pi-ai      → extractWebProviderBlocks() 生成
    //    · llm-deepseek   → buildDeepseekBlock() 生成
    //    用户 2026-09-30 原话：「不要硬编码，作为程序员这点常识都没有吗？」
    //    此前 llm-deepseek 被当成「手工块」原样保留，导致 BOT 端手写了 models 数组
    //    并写死第三个模型 deepseek-v4-flash —— 出厂表里根本没有它，且会随 DSH 升级漂移。
    if (id === 'llm-pi-ai' || id === 'llm-deepseek') continue;
    // 本块范围 = 头部注释起点 → 下一块头部注释起点（注释只归属一次，不重不漏）
    const to = s + 1 < starts.length ? heads[s + 1] : lines.length;
    chunks.push(lines.slice(heads[s], to).join('\n').replace(/\s+$/, ''));
  }
  return chunks.length ? '\n' + chunks.join('\n\n') + '\n' : '\n';
}

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const printOnly = args.includes('--print');

  if (!resolveSettingsPath()) {
    console.error(`[websync] ❌ 找不到 web 端设置，候选路径都没有：`);
    for (const p of SETTINGS_CANDIDATES) console.error(`[websync]      · ${p}`);
    console.error('[websync]    BOT 将回退使用 model-registry.json（旧行为）。');
    process.exit(1);
  }

  let settings;
  try {
    settings = normalizeSettings(parseYaml(readFileSync(SETTINGS, 'utf8')));
  } catch (err) {
    console.error(`[websync] ❌ 解析失败 ${SETTINGS}: ${err.message}`);
    process.exit(1);
  }

  const { routes, defaultProvider, defaultModel } = buildRoutes(settings);
  if (routes.length === 0) {
    console.error('[websync] ❌ 没解析出任何 provider —— 不覆盖现有配置。');
    process.exit(1);
  }

  const defaultRouteKey = pickDefaultKey(routes);
  const out = {
    _generated: '由 sync-from-web.mjs 自动生成 —— 请勿手改，改 Web 端「设置 → 模型」',
    _source: SETTINGS,
    _generatedFrom: { defaultProvider, defaultModel },
    defaultRouteKey,
    models: Object.fromEntries(routes.map((r) => [r.key, r])),
  };

  const text = JSON.stringify(out, null, 2) + '\n';

  // ── cordis.patch.yml（SDK profile 真正吃的 provider 表）───────────────────
  // ⚠️ 目标在 ~/.dsh 下（沙箱外）。读不到就跳过，**不报错退出** ——
  //    菜单同步（web-models.json）是主功能，不该被它拖垮。
  let patchText = null;
  let patchExisting = null;
  try {
    patchExisting = readFileSync(PATCH_PATH, 'utf8');
  } catch {
    patchExisting = null;
  }
  if (patchExisting !== null) {
    patchText = buildPatch(settings, patchExisting);
  }

  if (printOnly || checkOnly) {
    console.log(text);
    if (patchText) {
      console.log('// ===== cordis.patch.yml（将写入 ' + PATCH_PATH + '）=====');
      console.log(patchText);
    }
    if (checkOnly) console.error('[websync] --check：未写入文件。');
    return;
  }

  writeFileSync(OUT, text);
  console.log(`[websync] ✅ 已生成 ${OUT}`);
  console.log(`[websync]    档位: ${routes.map((r) => `${r.key}(${r.short})`).join(', ')}`);
  console.log(`[websync]    默认: ${defaultRouteKey}`);

  if (patchText) {
    // ⚠️ 原子替换：bot 运行时 HMR 会热重载这份文件，原地写的中间态会让插件树崩掉
    //    （文件自己的注释里写着这条，2026-09-17 实际踩过：连续重启失败 8 次）。
    const tmp = PATCH_PATH + '.tmp-' + process.pid;
    try {
      writeFileSync(tmp, patchText);
      renameSync(tmp, PATCH_PATH);
      console.log(`[websync] ✅ 已同步 provider 表 → ${PATCH_PATH}`);
      console.log(`[websync]    providers: ${Object.keys(settings['llm-pi-ai']?.providers ?? {}).join(', ')}`);
      // ── 多开实例广播（2026-10-06）───────────────────────────────────────────
      // bot-<名字> 的 profile 是 bot 的整份副本（多开实例，见 bot.js「多开实例」段），
      // provider 表必须跟着同步，否则实例侧永远装不上 Web 端新加的 provider。
      // 只同步「已存在 cordis.patch.yml」的 bot-* profile；写失败只警告不阻断（与上面同一哲学）。
      try {
        const profilesDir = join(homedir(), '.dsh', 'profiles');
        const siblings = readdirSync(profilesDir).filter((d) => /^bot-/.test(d)).sort();
        for (const dir of siblings) {
          const p = join(profilesDir, dir, 'cordis.patch.yml');
          try {
            if (!existsSync(p)) {
              console.log(`[websync]    跳过实例 profile ${dir}（没有 cordis.patch.yml）`);
              continue;
            }
            // ⚠️ #37（2026-10-08）：必须**逐份用该 profile 自己的 patch 为底重建**，
            //    不能拿主 profile 的成品 patchText 整份覆盖 —— agent-instructions 门控
            //    （DSH_WORKER_INSTRUCTIONS 三分支）是各实例自己的非托管内容，小工和
            //    主 bot 不一样；拿主 bot 版盖过去会把小工门控冲回两分支（07:42 部署车
            //    换上的三分支 09:53 就这么被冲掉）。托管块（llm-pi-ai / llm-deepseek）
            //    的权威源仍是 Web 端 settings，各份一致；其余块各归各（AGENTS.md 第 1 条）。
            let ownExisting = null;
            try {
              ownExisting = readFileSync(p, 'utf8');
            } catch {
              ownExisting = null;
            }
            // 读得到自己的旧 patch → 以它为底重建（非托管内容原样保留）；
            // 读不到 → 退回主 profile 的成品（首次装机兜底，维持原行为）。
            const perProfileText = ownExisting !== null ? buildPatch(settings, ownExisting) : patchText;
            const tmp2 = p + '.tmp-' + process.pid;
            writeFileSync(tmp2, perProfileText);
            renameSync(tmp2, p);
            console.log(`[websync] ✅ 已同步 provider 表 → ${p}（以该 profile 自己的 patch 为底重建）`);
          } catch (err2) {
            console.error(`[websync] ⚠️  实例 provider 表写入失败（${err2.code ?? err2.message}）: ${p}`);
          }
        }
      } catch (err3) {
        console.error(`[websync] ⚠️  枚举实例 profile 失败（${err3.message}），本次只同步了主 profile。`);
      }
    } catch (err) {
      console.error(`[websync] ⚠️  provider 表写入失败（${err.code ?? err.message}）: ${PATCH_PATH}`);
      console.error('[websync]    菜单已更新，但 BOT 里新 provider 可能仍不可用。');
      try { unlinkSync(tmp); } catch {}
    }
  } else {
    console.error(`[websync] ⚠️  读不到 ${PATCH_PATH}，跳过 provider 表同步。`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
