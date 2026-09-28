/**
 * 记忆/流水账读写 —— 从 BOT/bot.js 搬运而来。
 *
 * ⚠️ 搬运时**唯一真正改动的语义**（其余是等价重写）：
 *
 *   ① 所有路径从**写死在 BOT 目录**改成**构造时传入**。
 *      原版 `LEDGER_DIR = join(ROOT, 'memory/conversation-cache/raw/ledger')`，
 *      `MEMORY_SCRIPT = process.env.HARNESS_MEMORY_SCRIPT` —— 插件是给别人用的，
 *      记忆目录必须由配置给（`config.memoryDir`），不能假设装在哪个目录。
 *
 *   ② `ledgerRecord()` 的 `MEMORY_SCRIPT` 仍然是**共享程序、每项目数据**。
 *      ⚠️ 每次调用必须带 `--memory-dir`，漏了就静默读到**别人项目的账本**（不报错）。
 *      这条是 BOT 踩过的坑，原样保留注释。
 *
 *   ③ 保留原版对「程序」和「数据」的区分：程序从 `memoryScript` 找，
 *      数据从 `memoryDir` 找。⛔ 不要把两者混成一个路径。
 *
 * ⚠️ 关于 `classifyUserText`（语气词过滤）：
 *   原版 `readRecentLedgerEntries()` 调用了 `classifyUserText()`（来自
 *   摘要程序的 `summarizer.mjs`），用来筛掉「嗯」「好」「对」这类无信息量的用户消息，
 *   并把同轮的助手回复一并丢弃。插件版**没有**这份程序（它属于摘要链路，不在
 *   bot 插件职责内），所以这里退化为「**不过滤，直接取末尾 N 条**」。
 *
 *   ⚠️ 这是**有意的行为差异**，不是遗漏：少了它，handoff 里可能混进几句语气词，
 *      但**绝不会丢真内容**（过滤只做减法）。宁可多留，不可误杀 ——
 *      这也正是原版 `isFillerEntry()` 里那句 catch 的取向。
 *      如果将来要恢复过滤，注入一个 `filterUserText` 回调即可（见下）。
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** 会话内不足这么多条 = 在频繁调试，不覆盖 handoff（用户 2026-09-16 定）。 */
export const HANDOFF_MIN_TURNS = 20;

/** handoff 触发原因的人话描述（写进正文，让新会话知道"上次是怎么断的"）。 */
export const REASON_TEXT = {
  restart: {
    by: '/restart 指令',
    why: '在 Telegram 里执行了 **/restart**，目的是让 bot 加载新代码。',
  },
  new: {
    by: '/new 指令',
    why: '在 Telegram 里执行了 **/new**（开启全新会话、清空上下文），断开前留下本次进展。',
  },
  model: {
    by: '模型切换',
    why: '用户切换了模型。DSH 的模型在一个进程内固定，换模型 = 重启子进程 + 清空会话上下文。',
  },
  boot: {
    by: '启动补写',
    why: 'bot 进程重启（launchd 拉起 / 崩溃自愈 / 开机）。⚠️ 这类断开**来不及**在断开前写，'
      + '本文件是启动时**事后补写**的：内容取自流水账，正确；但时间戳是启动时刻，晚于真实断开时刻。',
  },
};

/** 账本按月分文件：`2026-09.md`。 */
export function ledgerMonthFile(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}.md`;
}

/**
 * 记忆读写器。
 *
 * @param {object} opts
 * @param {string} opts.memoryDir    本项目独占的记忆目录（**必填**）
 * @param {string} [opts.memoryScript] 共享的 cache-manager.mjs 路径（记账用，缺失则静默跳过）
 * @param {(body:string)=>boolean} [opts.filterUserText] 语气词过滤器（可选，见文件头 ③）
 * @param {(line:string)=>void} [opts.log]
 * @param {(line:string)=>void} [opts.error]
 */
export class Memory {
  constructor({ memoryDir, memoryScript = null, filterUserText = null, log = null, error = null } = {}) {
    if (!memoryDir) throw new Error('Memory 需要 memoryDir（记忆是每项目独占的数据）');
    this.memoryDir = memoryDir;
    this.memoryScript = memoryScript;
    this.filterUserText = filterUserText;
    this.log = log ?? ((line) => console.log(line));
    this.error = error ?? ((line) => console.error(line));
    Object.defineProperty(this, 'ledgerDir', {
      value: join(memoryDir, 'conversation-cache', 'raw', 'ledger'),
      enumerable: true,
    });
  }

  /** 本月账本绝对路径（不存在也照返回，调用方自己 existsSync）。 */
  ledgerPathFor(d = new Date()) {
    return join(this.ledgerDir, ledgerMonthFile(d));
  }

  /**
   * 读账本正文：优先本月；本月不存在则回退**最新的历史月份**。
   * 为什么要回退：月初第一天的会话里，本月文件可能还没创建，
   * 直接读会得到"文件不存在" → handoff 写出「无法提取」的空壳。
   */
  readLedgerText(d = new Date()) {
    const cur = this.ledgerPathFor(d);
    if (existsSync(cur)) return readFileSync(cur, 'utf8');
    try {
      const all = readdirSync(this.ledgerDir)
        .filter((f) => /^\d{4}-\d{2}\.md$/.test(f))
        .sort()
        .reverse();
      for (const f of all) {
        const p = join(this.ledgerDir, f);
        if (existsSync(p)) return readFileSync(p, 'utf8');
      }
    } catch {
      /* 目录不存在等 → 交给调用方按"读不到"处理 */
    }
    return null;
  }

  /**
   * 记一条流水账（fire-and-forget）。
   *
   * ⚠️ 两件事要分开看（2026-09-19 修）：
   *   ① **程序**（cache-manager.mjs）是共享的 → 从 `memoryScript` 找
   *   ② **数据**（流水账）落在 `memoryDir` → 用 `--memory-dir` 显式传给程序
   * 漏传 `--memory-dir` 不报错，只是**静默读到别人项目的账本**。
   *
   * @param {'user'|'assistant'} role
   * @param {string} text
   * @param {number|string} [chatId] 仅作日志/兼容用；文件名按月，不再含 chat id
   */
  ledgerRecord(role, text, chatId) {
    try {
      const clean = String(text ?? '').trim();
      if (!clean) return;
      if (!this.memoryScript || !existsSync(this.memoryScript)) return; // 记忆系统不在 → 静默跳过
      const child = spawn(
        process.execPath, // 用当前 node，避免 PATH 里没有 node
        [this.memoryScript, 'ledger-append', role, clean,
         '--chat', String(chatId ?? 'default'),
         '--memory-dir', this.memoryDir],
        { detached: true, stdio: 'ignore' },
      );
      child.unref();
    } catch (err) {
      this.error(`[ledger] 记账失败(已忽略,不影响对话): ${err.message}`);
    }
  }

  /** 语气词过滤器（未注入时恒为"保留"）。 */
  #isFiller(body) {
    if (typeof this.filterUserText !== 'function') return false;
    try {
      return this.filterUserText(body) === true;
    } catch {
      return false; // 判不了就保留，宁可多留不可误杀
    }
  }

  /**
   * 读流水账，从**最末尾往回倒数 N 条**对话原文（👤 用户 + 🤖 助手 都留）。
   *
   * 用户 2026-09-16 定死（原话）：「重启前的文件是聊天记录最新开始倒数取 20 条」。
   * 即：起点 = 流水账最新那条（不管是谁发的），往回数满 N 个条目就停。
   *
   * ⚠️ 别自作聪明加条件（原版连错两版，记在这里防复发）：
   *   - ❌ 不要按「轮」配对成 20 轮 —— 就是字面的 N 个条目
   *   - ❌ 不要按摘要生成时间切边界 —— 摘要不参与这个切分
   *
   * @param {string|null} ledgerRaw 流水账**正文**（由 readLedgerText() 读好传入）
   * @param {number} maxEntries 取末尾多少条（默认 20）
   */
  readRecentLedgerEntries(ledgerRaw, maxEntries = 20) {
    try {
      if (ledgerRaw === null || ledgerRaw === undefined) return '（流水账文件不存在，无法提取）';
      const raw = String(ledgerRaw);

      // 条目分隔：`## 2026-09-16 04:40:40  👤 用户` / `  🤖 助手`
      const parts = raw.split(/^## /m).slice(1); // 丢掉文件头
      const entries = [];
      for (const p of parts) {
        const nl = p.indexOf('\n');
        if (nl < 0) continue;
        const head = p.slice(0, nl).trim();          // 2026-09-16 04:40:40  👤 用户
        const body = p.slice(nl + 1).trim();
        const m = head.match(/^(\S+ \S+)\s+(👤|🤖)\s*(\S*)/);
        if (!m) continue;
        entries.push({ ts: m[1], icon: m[2], who: m[3] || (m[2] === '👤' ? '用户' : '助手'), body });
      }
      if (entries.length === 0) return '（流水账里没有可提取的对话条目）';

      // 用户 2026-09-16 改定：取「**有用的**末尾 20 条」，不是机械数 20 条。
      // 现改为：先筛掉无信息量的 👤，其所属那轮的 🤖 回复一并丢弃，再取末尾 20 条。
      // ⚠️ 插件版在没有注入 filterUserText 时**不过滤**（见文件头 ③）。
      const turns = [];
      for (const e of entries) {
        if (e.icon === '👤') {
          turns.push({ keep: !this.#isFiller(e.body), items: [e] });
        } else {
          // 没有前置 👤 的孤儿助手消息，挂到当前轮；都没有就自己开一轮
          if (turns.length === 0) turns.push({ keep: true, items: [] });
          turns[turns.length - 1].items.push(e);
        }
      }
      const kept = turns.filter((t) => t.keep).flatMap((t) => t.items);
      const picked = (kept.length ? kept : entries).slice(-maxEntries);

      const out = picked.map((e) => {
        // 正文可能是多行（回答里有缩进代码块），统一压成引用块
        const quoted = e.body
          .split('\n')
          .map((l) => `> ${l}`.trimEnd())
          .join('\n');
        return `### ${e.icon} ${e.who} · ${e.ts}\n${quoted}`;
      }).join('\n\n');

      const userCount = picked.filter((e) => e.icon === '👤').length;
      const asstCount = picked.filter((e) => e.icon === '🤖').length;
      return `（共 ${picked.length} 条：👤 用户 ${userCount} / 🤖 助手 ${asstCount}）\n\n${out}`;
    } catch (err) {
      return `（读取流水账失败：${err.message}）`;
    }
  }

  /**
   * 数「某时刻之后」流水账里有多少条 —— 判断本次会话是不是只聊了几句。
   *
   * ⚠️ 为什么不能直接数总条数：流水账是**永久累积**的（只增不删，跨几十个会话），
   * `/new` 不清它。所以「总条数 ≥ 20」永远为真，等于没判断。必须按时间戳过滤。
   *
   * @param {string} ledgerRaw 流水账正文
   * @param {number} sinceMs 起始毫秒时间戳（会话 createdAt）
   */
  countLedgerEntriesSince(ledgerRaw, sinceMs) {
    try {
      if (ledgerRaw === null || ledgerRaw === undefined) return 0;
      const parts = String(ledgerRaw).split(/^## /m).slice(1);
      let n = 0;
      for (const p of parts) {
        const nl = p.indexOf('\n');
        if (nl < 0) continue;
        const head = p.slice(0, nl).trim();
        const m = head.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/);
        if (!m) continue;
        // 流水账时间戳是本地时间（见 ledger 写入格式），按本地解析。
        const t = new Date(`${m[1]}T${m[2]}`).getTime();
        if (Number.isFinite(t) && t >= sinceMs) n += 1;
      }
      return n;
    } catch {
      return 0;
    }
  }

  /**
   * 生成 handoff 文件。失败返回 null（调用方降级）。
   *
   * ⚠️ 用户 2026-09-16 改定：**不只是 /restart 写 handoff**。
   * 任何「会话会断」的时机都要写：
   *   - `/restart`  断开前写（reason='restart'）
   *   - `/new`      断开前写（reason='new'，条数不足则跳过）
   *   - 切模型      断开前写（reason='model'，条数不足则跳过）
   *   - 启动补写    断开后补（reason='boot'，仅当确有新内容时）
   *
   * @param {object} opts
   * @param {string} opts.sessionId 归属会话
   * @param {string} [opts.reason] restart | new | model | boot
   * @param {() => ({key:string,provider:string,model:string})} [opts.currentRoute] 快照用
   * @param {string|null} [opts.ownerUserId] 快照用
   * @param {string} [opts.workspace] 快照用
   */
  writeHandoff({ sessionId, reason = 'restart', currentRoute = null, ownerUserId = null, workspace = '' }) {
    try {
      const handoffDir = join(this.memoryDir, 'handoff');
      mkdirSync(handoffDir, { recursive: true });

      const now = new Date();
      // ⚠️ 固定文件名，**永远覆盖，不新增**（用户 2026-09-16 定死）。
      // 曾用 `${stamp}-restart.md`（时间戳命名）→ 每次重启新建一个，堆了 59 份历史垃圾。
      // 与摘要（summaries/summary.md 单份覆盖）对齐：只保留**一份**。
      const file = join(handoffDir, 'handoff.md');

      // ⚠️ 用户 2026-09-16 定死：handoff **不是**模板，是「摘要之后 → 重启之前」
      // 这一段的实录。旧代码这里写死了 3 条常量 → 每次重启都写同一份旧事，
      // 新会话接不上真正进度（这就是"重启后忘光"的根因）。现改为读流水账。
      const ledgerText = this.readLedgerText();
      const recent = this.readRecentLedgerEntries(ledgerText, 20); // 末尾往回 20 条
      const ledgerRel = `memory/conversation-cache/raw/ledger/${ledgerMonthFile()}`;
      const route = typeof currentRoute === 'function' ? currentRoute() : currentRoute;

      const lines = [
        `# Handoff · 重启前记录（${now.toISOString()}）`,
        ``,
        `> 由 ${REASON_TEXT[reason]?.by ?? '系统'} 自动生成。用途:会话断了之后续不上(SDK 硬限制),`,
        `> 新会话先读本文件接续记忆。会话 id: \`${sessionId}\`。`,
        ``,
        `## 本文件记的是什么`,
        ``,
        `| 项 | 值 |`,
        `|---|---|`,
        `| 取法 | 流水账**最新一条**开始，往回**倒数 20 条**（👤/🤖 都留，不配对） |`,
        `| 流水账全集 | \`${ledgerRel}\`（按月分文件，旧月份为同目录下的 YYYY-MM.md） |`,
        ``,
        `## 本次触发的原因`,
        REASON_TEXT[reason]?.why ?? `会话断开（${reason}）。`,
        ``,
        `## 上次进展（聊天记录最新开始，往回倒数 20 条原文；👤 用户 / 🤖 助手 都留）`,
        ``,
        recent,
        ``,
        `## 快照(证据)`,
        `| 项 | 值 |`,
        `|---|---|`,
        `| 触发时间 | ${now.toISOString()} |`,
        `| 触发会话 | ${sessionId} |`,
        `| 归属 owner | ${ownerUserId ?? '?'} |`,
        route ? `| 当前模型 | ${route.key} (${route.provider}/${route.model}) |` : `| 当前模型 | (未知) |`,
        `| 工作目录 | ${workspace} |`,
        ``,
        `## 重启后最简单试法`,
        `直接给 bot 发一句正常消息 → 恢复回应,即说明重启成功。`,
        `然后发一条带 \`**\` 的长消息验证富文本。`,
        ``,
      ].join('\n');

      // ⚠️ 必须**直接覆盖**，不能用 `{ flag: 'wx' }`（用户 2026-09-16 定死）。
      // 改成固定名 `handoff.md` 后还留着 `wx`，语义就反转成「只写第一次，之后永远
      // EEXIST 拒绝」—— 2026-09-16 那次 /restart 就是这样静默失败的。
      writeFileSync(file, lines); // 固定单份，每次直接覆盖
      this.log(`[handoff] (${reason}) 已写入 ${file}`);
      return file;
    } catch (err) {
      this.error(`[handoff] (${reason}) 写入失败: ${err.message}`);
      return null;
    }
  }

  /**
   * 断开「之前」写 handoff，但**只在本次会话真的聊过东西时才写**。
   *
   * ⚠️ 用户 2026-09-16 定死的判据：会话内**不足 20 条**说明是在频繁调试
   * （刚开就 /new、反复切模型），**不要覆盖**已有的好记忆。
   * 判据必须是「本次会话 createdAt 之后」的条数 —— 流水账总数永远 ≥ 20，数它没意义。
   *
   * @returns {'written'|'skipped'|'failed'} 实际结果（便于回话里如实交代）
   */
  maybeWriteHandoff(opts) {
    try {
      const n = this.countLedgerEntriesSince(this.readLedgerText(), opts.sessionCreatedAt);
      if (n < HANDOFF_MIN_TURNS) {
        this.log(`[handoff] (${opts.reason}) 跳过 — 本次会话仅 ${n} 条(<${HANDOFF_MIN_TURNS}，视为调试)`);
        return 'skipped';
      }
      return this.writeHandoff(opts) ? 'written' : 'failed';
    } catch (err) {
      this.error(`[handoff] (${opts.reason}) 出错跳过: ${err.message}`);
      return 'failed';
    }
  }

  /**
   * 启动时**补写** handoff —— 断电/崩溃/launchd 拉起这类「来不及在断开前写」的场合。
   *
   * ⚠️ 判据：handoff 文件的 mtime 是否早于流水账末条时间。
   */
  catchUpHandoffOnBoot(opts) {
    try {
      if (opts.ownerUserId === null || opts.ownerUserId === undefined) return; // 还没有主人
      const handoffFile = join(this.memoryDir, 'handoff', 'handoff.md');
      const ledgerText = this.readLedgerText();
      if (ledgerText === null) return;

      // 流水账最后一条的时间（本地时间格式，与写入端一致）
      // ⚠️ 正则必须用 [ \t]+ 而不是单个空格：写入端是 `## 时间  👤 用户`
      //    （**两个**空格），写 `## 时间 ` 会漏配 → 匹配数恒为 0 → 恒判"已是最新"。
      //    这一字之差让 boot 补写自 2026-09-16 起就没生效过（2026-09-16 实测修复）。
      let lastEntryMs = 0;
      try {
        const heads = ledgerText.match(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[ \t]/gm);
        if (heads && heads.length) {
          const t = heads[heads.length - 1].slice(3).trim();
          lastEntryMs = new Date(t.replace(' ', 'T')).getTime();
        }
      } catch { /* 读不到就当没新内容 */ }
      // ⚠️ 抓不到时间戳时**必须保守地补写**，不能静默 return ——
      //    旧代码 return 的语义是"当作没有新内容"，可真相是"我读不懂流水账"。
      //    两者混淆 ⇒ 解析一坏，补写永久静默失效，而日志还显示一切正常。
      const parseFailed = !Number.isFinite(lastEntryMs) || lastEntryMs === 0;
      if (parseFailed) {
        this.error('[handoff] (boot) ⚠️ 流水账末条时间解析失败，改为保守补写');
      }

      const handoffMs = existsSync(handoffFile) ? statSync(handoffFile).mtimeMs : 0;
      if (!parseFailed && handoffMs >= lastEntryMs) {
        this.log('[handoff] (boot) 已是最新，跳过补写');
        return;
      }

      const saved = this.writeHandoff({ ...opts, reason: 'boot' });
      if (saved) this.log('[handoff] (boot) 补写完成（旧 handoff 早于流水账末条）');
    } catch (err) {
      // 补写失败绝不影响启动 —— 只是记忆旧一点，bot 必须照常服务。
      this.error(`[handoff] (boot) 失败: ${err.message}`);
    }
  }
}
