/**
 * Model routes — 来源分层（插件版）。
 *
 * ⭐ 与 BOT/models.js 的差别：
 *   BOT 版从**文件**读档位（`web-models.json`，由 sync-from-web.mjs 从
 *   `~/.dsh/settings.yaml` 生成），因为 BOT 是**独立项目**，它的模型菜单要跟
 *   Web 端设置对齐。
 *
 *   插件住在 DSH 进程**内部**，不需要「同步」这一步 —— 宿主已经知道有哪些
 *   provider/model（`llm` 服务），所以插件版以**配置项**为事实源：
 *     1. 用户显式配置的档位（config.routes）；
 *     2. 宿主 llm 服务里已注册的 provider（后续接入）；
 *     3. 空 —— 不猜、不写死任何本机路径。
 *
 * ⚠️ 本文件**故意不含任何本机绝对路径**：
 *   写死路径正是 BOT 版无法发布的原因之一（见 plan.md「必须改的三块」）。
 */

/** 内置档位的兜底定义。发布版里这是空的，档位由用户在配置里给。 */
const BUILTIN_ROUTES = [];

/**
 * 判断某 provider 是否是「本地纯聊天」档（不该注入完整工作区记忆）。
 *
 * ⚠️ 插件版**没有** `local: true` 标记可用（那是 BOT 的 model-registry 字段），
 *    改为按 provider 名 + 常见本地端点特征判断。
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
 * 每档的思考强度。`null` = 不发该字段（用模型默认）；`undefined` = 用兜底值。
 *
 * @param {{reasoningEffort?: string|null}|null|undefined} route
 * @param {string|undefined} fallback
 * @returns {string|undefined}
 */
export function reasoningEffortFor(route, fallback) {
  if (!route) return fallback;
  if (route.reasoningEffort === null) return undefined;
  return route.reasoningEffort ?? fallback;
}

/**
 * 路由故障识别（key 失效 / 没额度 / 模型下线）—— 与瞬时网络抖动区分开。
 * 只有前者值得切档。判定规则与 BOT 版一致（经过实跑验证，不重新发明）。
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
