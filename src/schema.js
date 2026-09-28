/**
 * Schema —— Schemastery 的最小可用替身。
 *
 * ⚠️ **为什么需要这个文件**：官方插件用 `@deepseek-ai/schemastery` 的 `Schema`
 *    来声明 Config。但从插件目录解析不到这个包（
 *    在 `botplugin/` 下 Node 向上找 node_modules 什么也找不到，而 `NODE_PATH`
 *    对 ESM 无效）。插件要能发布给别人，就不能依赖「恰好装在某台机器的某个位置」。
 *
 * 所以这里实现一个**极小的兼容层**，只覆盖本插件实际用到的能力：
 *   · `Schema.object({...})` / `Schema.array(inner)` / `Schema.string()`
 *     / `Schema.number()` / `Schema.boolean()` / `Schema.any()`
 *   · `.default(v)` / `.description(s)` / `.required()` / `.optional()`
 *   · `.validate(value)` → 返回补好默认值的对象，或抛错
 *
 * ⚠️ **与 Schemastery 的行为差异**（诚实交底）：
 *   - 不做类型强转（Schemastery 会把 `"1"` 转成 `1`，这里直接报错）。宁可报错，
 *     不可静默改值 —— 配置写错就该当场看得见。
 *   - 不做 `.description()` 之外的表单元数据（DSH 的配置界面用不到就算了）。
 *   - 不实现 union / intersect / transform 等进阶能力（本插件不需要）。
 *
 * ⚠️ **如果宿主提供 Schemastery**：`apply()` 里可以优先用宿主的。
 *    当前实现刻意**不**这么做 —— 少一个「有时能拿到、有时拿不到」的分支，
 *    行为才是确定的。
 */

/** 一个字段的描述。 */
class Field {
  constructor(kind, extra = {}) {
    this.kind = kind;
    this.meta = { description: '', default: undefined, hasDefault: false, required: false, ...extra };
  }

  /** 给个默认值。有默认值即视为可选。 */
  default(value) {
    this.meta.default = value;
    this.meta.hasDefault = true;
    return this;
  }

  /** 人话说明（DSH 配置界面会展示）。 */
  description(text) {
    this.meta.description = String(text);
    return this;
  }

  /** 必填（没默认值时必须提供）。 */
  required() {
    this.meta.required = true;
    return this;
  }

  /** 可选（没默认值也允许缺）。 */
  optional() {
    this.meta.required = false;
    return this;
  }

  /**
   * 校验一个值。
   * @returns {{ok:true, value:any} | {ok:false, error:string}}
   */
  check(value, path) {
    const where = path || '(根)';
    switch (this.kind) {
      case 'any':
        return { ok: true, value };

      case 'string':
        if (value === undefined || value === null) break;
        if (typeof value !== 'string') return { ok: false, error: `${where} 应为字符串，实际是 ${typeof value}` };
        return { ok: true, value };

      case 'number':
        if (value === undefined || value === null) break;
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return { ok: false, error: `${where} 应为数字，实际是 ${typeof value}` };
        }
        return { ok: true, value };

      case 'boolean':
        if (value === undefined || value === null) break;
        if (typeof value !== 'boolean') return { ok: false, error: `${where} 应为布尔值，实际是 ${typeof value}` };
        return { ok: true, value };

      case 'array': {
        if (value === undefined || value === null) break;
        if (!Array.isArray(value)) return { ok: false, error: `${where} 应为数组，实际是 ${typeof value}` };
        const out = [];
        for (let i = 0; i < value.length; i += 1) {
          const r = this.inner.check(value[i], `${where}[${i}]`);
          if (!r.ok) return r;
          out.push(r.value);
        }
        return { ok: true, value: out };
      }

      case 'object': {
        if (value === undefined || value === null) break;
        if (typeof value !== 'object' || Array.isArray(value)) {
          return { ok: false, error: `${where} 应为对象，实际是 ${Array.isArray(value) ? '数组' : typeof value}` };
        }
        const out = {};
        for (const [key, field] of Object.entries(this.shape)) {
          const r = field.check(value[key], path ? `${path}.${key}` : key);
          if (!r.ok) return r;
          if (r.value !== undefined) out[key] = r.value;
        }
        // 保留未声明的字段（不静默丢弃用户写的配置）
        for (const [key, v] of Object.entries(value)) {
          if (!(key in this.shape)) out[key] = v;
        }
        return { ok: true, value: out };
      }

      default:
        return { ok: false, error: `${where} 未知类型 ${this.kind}` };
    }

    // 走到这里 = 值为空
    if (this.meta.hasDefault) {
      return { ok: true, value: typeof this.meta.default === 'function' ? this.meta.default() : this.meta.default };
    }
    if (this.meta.required) return { ok: false, error: `${where} 是必填项` };
    return { ok: true, value: undefined };
  }

  /**
   * 校验整个配置对象。失败抛错（Cordis 会捕获并报告）。
   * @param {object} config
   */
  validate(config) {
    const r = this.check(config ?? {}, '');
    if (!r.ok) throw new Error(`botplugin 配置无效：${r.error}`);
    return r.value;
  }

  /**
   * Standard Schema 接口 —— **Cordis 真正调用的入口**。
   *
   * ⚠️ 为什么必须有：Cordis 的 resolveConfig 是这么写的
   *      （@deepseek-ai/cordis/lib/index.js:957）：
   *        const result = runtime.Config['~standard'].validate(config);
   *        if (result.issues) throw new ValidationError(result.issues);
   *        else return result.value;
   *    它**不调** `.validate()`，只认 `'~standard'`。
   *
   *    只有 .validate() 而没有这个 getter 的实现，宿主启动时会崩在
   *    「Cannot read properties of undefined (reading 'validate')」。
   *
   *    契约细节（照官方 resolveConfig 反推）：
   *    - 返回**同步**对象；返回 Promise 会抛「Async config validation is not supported」。
   *    - 失败用 `issues` 表达，**不是**抛错。
   *    - 成功用 `value` 带出补好默认值的配置。
   *    - `vendor` 字段是规范要求的标识，值随意但要存在。
   */
  get '~standard'() {
    return {
      version: 1,
      vendor: 'dsh-botplugin',
      validate: (value) => {
        try {
          return { value: this.validate(value) };
        } catch (err) {
          // Cordis 只读 issues[].message 之类的字段，不读 cause，故拍平成人话。
          return { issues: [{ message: err?.message ?? String(err) }] };
        }
      },
    };
  }
}

function array(inner) {
  const f = new Field('array');
  f.inner = inner ?? new Field('any');
  return f;
}

function object(shape) {
  const f = new Field('object');
  f.shape = shape ?? {};
  return f;
}

export const Schema = {
  string: () => new Field('string'),
  number: () => new Field('number'),
  boolean: () => new Field('boolean'),
  any: () => new Field('any'),
  array,
  object,
};

export { Field };
