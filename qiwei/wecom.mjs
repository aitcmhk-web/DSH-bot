// 企业微信自建应用：只做发文字，access_token 内存缓存。
const 记 = (o) => console.log(JSON.stringify({ 时间: new Date().toISOString(), 动作: '企微', ...o }));

/** 按 UTF-8 字节切段，别把中文或 emoji 切成半个。 */
export function 切段(文字, 上限 = 1800) {
  const 段 = [];
  let 当前 = '';
  let 字节 = 0;
  for (const 字 of String(文字 ?? '')) {
    const 长 = Buffer.byteLength(字);
    if (字节 + 长 > 上限 && 当前) {
      段.push(当前);
      当前 = '';
      字节 = 0;
    }
    当前 += 字;
    字节 += 长;
  }
  if (当前) 段.push(当前);
  return 段.length ? 段 : ['（没有文字回复）'];
}

/** 把通用 Markdown 收成企微 markdown 能认的样子：表格拆行、去代码围栏、标题加粗。 */
export function 转企微Markdown(文字) {
  const 行们 = String(文字 ?? '').split('\n');
  const 出 = [];
  let 代码块 = false;
  for (const 原 of 行们) {
    const 行 = 原.replace(/ +$/, '');
    const 去空 = 行.trim();
    if (去空.startsWith('```') || 去空.startsWith('~~~')) {
      代码块 = !代码块;
      continue;
    }
    if (代码块) {
      出.push(行);
      continue;
    }
    if (去空.startsWith('|') && 去空.endsWith('|')) {
      const 格 = 去空.slice(1, -1).split('|').map((x) => x.trim());
      const 是分隔 = 格.every((x) => /^:?-{3,}:?$/.test(x));
      if (是分隔) continue;
      if (格.length === 2) 出.push(格[0] + "：" + 格[1]);
      else 出.push(格.join(' ｜ '));
      continue;
    }
    if (去空.startsWith('#')) {
      const 标题 = 去空.replace(/^#+/, '').trim();
      出.push('**' + 标题 + '**');
      continue;
    }
    if (去空.length >= 3 && /^[-*_]+$/.test(去空)) {
      出.push('———');
      continue;
    }
    出.push(行);
  }
  return 出.join('\n');
}

export class 企微应用 {
  #令牌 = '';
  #到期 = 0;

  constructor(配置) {
    this.配置 = 配置;
  }

  async #取令牌(强制 = false) {
    if (!强制 && this.#令牌 && this.#到期 > Date.now()) return this.#令牌;
    const 址 = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken');
    址.searchParams.set('corpid', this.配置.corpId);
    址.searchParams.set('corpsecret', this.配置.secret);
    const 回 = await fetch(址, { signal: AbortSignal.timeout(15000) });
    const 果 = await 回.json().catch(() => ({}));
    if (!回.ok || Number(果?.errcode) !== 0 || !果?.access_token) {
      throw new Error(`企微取令牌失败：${Number(果?.errcode) || 回.status} ${果?.errmsg || ''}`.trim());
    }
    this.#令牌 = 果.access_token;
    this.#到期 = Date.now() + Math.max(60, Number(果.expires_in) - 300) * 1000;
    return this.#令牌;
  }

  async #发一段(用户ID, 文字, 重试 = true, 模式 = 'text') {
    const 令牌 = await this.#取令牌();
    const 回 = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(令牌)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        touser: 用户ID,
        msgtype: 模式 === 'text' ? 'text' : 'markdown',
        agentid: Number(this.配置.agentId),
        ...(模式 === 'text' ? { text: { content: 文字 } } : { markdown: { content: 文字 } }),
      }),
      signal: AbortSignal.timeout(15000),
    });
    const 果 = await 回.json().catch(() => ({}));
    const 码 = Number(果?.errcode);
    if (重试 && (码 === 42001 || 码 === 40014)) {
      this.#令牌 = '';
      return this.#发一段(用户ID, 文字, false, 模式);
    }
    if (!回.ok || 码 !== 0) {
      throw new Error(`企微发消息失败：${码 || 回.status} ${果?.errmsg || ''}`.trim());
    }
  }

  /** 发一条，超长自动切段；返回实际段数。 */
  async 发文字(用户ID, 文字, 模式 = 'text') {
    const 段 = 切段(模式 === 'text' ? 文字 : 转企微Markdown(文字));
    for (const 一 of 段) await this.#发一段(用户ID, 一, true, 模式);
    记({ 已发: true, 段数: 段.length });
    return 段.length;
  }

  /** 发模板卡片（审批 / 模型选择按钮）。 */
  async 发卡片(用户ID, 卡片, 重试 = true) {
    const 令牌 = await this.#取令牌();
    const 回 = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(令牌)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        touser: 用户ID,
        msgtype: 'template_card',
        agentid: Number(this.配置.agentId),
        template_card: 卡片,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const 果 = await 回.json().catch(() => ({}));
    const 码 = Number(果?.errcode);
    if (重试 && (码 === 42001 || 码 === 40014)) {
      this.#令牌 = '';
      return this.发卡片(用户ID, 卡片, false);
    }
    if (!回.ok || 码 !== 0) {
      throw new Error(`企微发卡片失败：${码 || 回.status} ${果?.errmsg || ''}`.trim());
    }
    记({ 已发卡片: true });
    return 果;
  }

  /** 取企微临时图片，返回可供 DSH 使用的 base64 图片块数据。 */
  async 取图片(媒体ID, 重试 = true) {
    if (!媒体ID) throw new Error('图片缺少 MediaId');
    const 令牌 = await this.#取令牌();
    const 址 = new URL('https://qyapi.weixin.qq.com/cgi-bin/media/get');
    址.searchParams.set('access_token', 令牌);
    址.searchParams.set('media_id', 媒体ID);
    const 回 = await fetch(址, { signal: AbortSignal.timeout(30000) });
    const 类型 = String(回.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!回.ok || 类型.includes('application/json')) {
      const 果 = await 回.json().catch(() => ({}));
      const 码 = Number(果?.errcode) || 回.status;
      if (重试 && (码 === 42001 || 码 === 40014)) {
        this.#令牌 = '';
        return this.取图片(媒体ID, false);
      }
      throw new Error(`企微取图片失败：${码} ${果?.errmsg || ''}`.trim());
    }
    const 数据 = Buffer.from(await 回.arrayBuffer());
    if (!数据.length) throw new Error('企微图片为空');
    if (数据.length > 10 * 1024 * 1024) throw new Error('图片超过 10MB');

    const 标准 = {
      'image/jpeg': 'image/jpeg',
      'image/jpg': 'image/jpeg',
      'image/png': 'image/png',
      'image/webp': 'image/webp',
      'image/gif': 'image/gif',
    };
    let 类型标准 = 标准[类型] || '';
    if (!类型标准) {
      if (数据[0] === 0x89 && 数据[1] === 0x50 && 数据[2] === 0x4e && 数据[3] === 0x47) 类型标准 = 'image/png';
      else if (数据[0] === 0xff && 数据[1] === 0xd8) 类型标准 = 'image/jpeg';
      else if (数据.subarray(0, 4).toString('ascii') === 'GIF8') 类型标准 = 'image/gif';
      else if (数据.subarray(0, 4).toString('ascii') === 'RIFF' && 数据.subarray(8, 12).toString('ascii') === 'WEBP') 类型标准 = 'image/webp';
    }
    if (!类型标准) throw new Error(`不支持的图片类型：${类型 || '未知'}`);

    const 扩展 = 类型标准 === 'image/jpeg' ? 'jpg' : 类型标准.split('/')[1];
    const 名 = `wecom-${String(媒体ID).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'image'}.${扩展}`;
    记({ 已取图片: true, 字节: 数据.length, 类型: 类型标准 });
    return { data: 数据.toString('base64'), mimeType: 类型标准, bytes: 数据.length, name: 名 };
  }

  /** 创建应用菜单。按钮数组直接按企微 menu/create 格式传。 */
  async 建菜单(按钮) {
    const 令牌 = await this.#取令牌();
    const 址 = new URL('https://qyapi.weixin.qq.com/cgi-bin/menu/create');
    址.searchParams.set('access_token', 令牌);
    址.searchParams.set('agentid', String(this.配置.agentId));
    const 回 = await fetch(址, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ button: 按钮 }),
      signal: AbortSignal.timeout(15000),
    });
    const 果 = await 回.json().catch(() => ({}));
    if (!回.ok || Number(果?.errcode) !== 0) {
      throw new Error(`企微建菜单失败：${Number(果?.errcode) || 回.status} ${果?.errmsg || ''}`.trim());
    }
    记({ 菜单: '已创建' });
    return 果;
  }

  /** 删除应用菜单，供回退用。 */
  async 删菜单() {
    const 令牌 = await this.#取令牌();
    const 址 = new URL('https://qyapi.weixin.qq.com/cgi-bin/menu/delete');
    址.searchParams.set('access_token', 令牌);
    址.searchParams.set('agentid', String(this.配置.agentId));
    const 回 = await fetch(址, { signal: AbortSignal.timeout(15000) });
    const 果 = await 回.json().catch(() => ({}));
    if (!回.ok || Number(果?.errcode) !== 0) {
      throw new Error(`企微删菜单失败：${Number(果?.errcode) || 回.status} ${果?.errmsg || ''}`.trim());
    }
    记({ 菜单: '已删除' });
    return 果;
  }
}
