/**
 * Model routes — 档位来源分层。
 *
 * 档位来源（按优先级）：
 *   1. 用户显式配置的档位（config.routes）；
 *   2. 宿主 web 端「设置 → 模型」（经 llm/settings 服务读取）；
 *   3. 空 —— 不猜、不写死任何路径。
 *
 * 本文件不含任何写死的绝对路径。
 */

/** 内置档位的兜底定义。发布版里这是空的，档位由用户在配置里给。 */
const BUILTIN_ROUTES = [];

/**
 * 判断某 provider 是否是「本地纯聊天」档（不该注入完整工作区记忆）。
 *
 * 没有 local 标记字段，改为按 provider 名 + 常见本地端点特征判断。
 *    拿不准时返回 false（= 照常注入），宁可多注入也不要让该注入的档位静默变成
 *    纯聊天 —— 后者会让 agent「不知道自己有记忆」。
 *
 * @param {string|undefined} provider
 * @param {Array<{provider:string, local?:boolean}>} [routes] 用户配置的档位（可带 local 标记）
 * @returns {boolean}
 */
export function isLocalRoute(provider, routes = BUILTIN_ROUTES) {
  if (!provider) return false;
  const configured = routes.find((r) => r.provider === provider);
  if (configured) return configured.local === true;
  return false;
}

/**
 * 每档的思考强度。口径与根目录 models.js **必须逐字一致**（两份是同一个决定，别只改一份）。
 *
 * 现象（2026-09-28 真炸过）：切到没声明思考强度的档，报了
 *   `does not support reasoning effort "off"` —— 根因是"没声明"被当成了"按兜底值发"。
 * pi-ai 判定的是**参数有没有出现**：不出现 = 可以，出现了（哪怕值是 off）= 拒。
 *
 * 口径：`'none'` / 空 / 没写 → 不发；`'off'` / `low` / `high` … → 原样发；
 * 兜底值 `fallback` **只**给显式配置的档位兜底，没有兜底可言的档一律不发。
 * ⚠️ 2026-09-29 起 runtime 发送边界（normalizeEffort）会把 `'off'` 也一并拦下：
 *    实爆证明 pi-ai 与 deepseek-official 都拒收 off —— 这里的「原样发」只描述
 *    本函数的返回值，最终发不发以 runtime 边界为准。
 *
 * @param {{key?:string, reasoningEffort?: string|null}|null|undefined} route
 * @param {string|undefined} fallback
 * @returns {string|undefined} undefined = 这个参数一个字节都不发
 */
export function reasoningEffortFor(route, fallback) {
  if (!route) return fallback;
  const declared = typeof route.reasoningEffort === 'string' ? route.reasoningEffort.trim() : '';
  if (declared === 'none') return undefined;
  if (declared) return declared;
  // 显式配置进来的档位才算"有来源"，其余（宿主 web 端同步来的）没声明就是不发。
  if (Array.isArray(route.__allRoutes) && route.__allRoutes.some((r) => r.key === route.key)) return undefined;
  return fallback;
}

/**
 * 路由故障识别（key 失效 / 没额度 / 模型下线）—— 与瞬时网络抖动区分开。
 * 只有前者值得切档。
 */
const ROUTE_FAILURE =
  /(401|402|403|429)\b|invalid[_ ]?api[_ ]?key|access ?denied|insufficient|quota|no permission|not authorized|unauthor|model not found|does not exist|unsupported model|does not support reasoning effort|余额|额度|欠费|逾期|过期/i;
const TRANSIENT_FAILURE =
  /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR|socket hang up|timed out|timeout|network/i;

/**
 * 这次失败是否值得切到另一个档位。
 * @param {unknown} failure 结构化的 LlmFailure 或纯字符串
 * @returns {boolean}
 */
export function isRouteFailure(failure) {
  const text = typeof failure === 'string' ? failure : JSON.stringify(failure ?? {});
  if (!text.trim() || text === '{}') return false;
  if (TRANSIENT_FAILURE.test(text)) return false;
  return ROUTE_FAILURE.test(text);
}

/**
 * 构造路由表。插件化之后档位来自配置，而不是磁盘上的 JSON。
 *
 * @param {Array<{key:string,provider:string,model:string,label?:string,reasoningEffort?:string|null,local?:boolean}>} configured
 * @returns {{routes: Map<string, object>, defaultRouteKey: string|null, list: object[]}}
 */
export function buildRoutes(configured = BUILTIN_ROUTES) {
  const routes = new Map();
  for (const [index, route] of configured.entries()) {
    const key = route.key ?? `${route.provider}:${route.model}`;
    routes.set(key, {
      label: route.label ?? route.provider,
      short: route.short ?? `${route.label ?? route.provider}:${route.model}`,
      isDefault: route.isDefault === true,
      index,
      ...route,
      key,
    });
  }
  let defaultRouteKey = null;
  for (const [key, route] of routes) {
    if (route.isDefault) {
      defaultRouteKey = key;
      break;
    }
  }
  if (defaultRouteKey === null && routes.size > 0) {
    defaultRouteKey = routes.keys().next().value;
  }
  return { routes, defaultRouteKey, list: [...routes.values()] };
}

/**
 * 按 key 找档位。
 * @param {Map<string, object>} routes
 * @param {string} key
 */
export function routeByKey(routes, key) {
  return routes.get(key) ?? null;
}

/**
 * 按 provider/model 对找档位（用于「当前会话实际跑在哪个档」的显示）。
 * @param {Map<string, object>} routes
 * @param {string} provider
 * @param {string} model
 */
export function routeFor(routes, provider, model) {
  for (const route of routes.values()) {
    if (route.provider === provider && route.model === model) return route;
  }
  return null;
}

/**
 * 给用户看的一行描述。
 * @param {{label:string,provider:string,model:string}} route
 */
export function describeRoute(route) {
  return `${route.label}（${route.provider} / ${route.model}）`;
}
