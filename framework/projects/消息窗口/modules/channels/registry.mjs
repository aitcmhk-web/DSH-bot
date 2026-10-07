// registry.mjs · 通道注册表（D12 通道注册制）
// 通道 = 适配器三件套（收=拉新消息 / 发=send / 归一=原始消息→标准消息）+ 注册表；
// 数量不限、即插即用：加新通道 = 一个适配器文件 + 一行注册，⛔ 核心逻辑零改动。
// 适配器缺三件套或重复注册一律拒收（起不来就大声死，不许静默半残跑着）。
export function createRegistry() {
  const 们 = new Map(); // key = `${token}:${通道}`
  return {
    注册(适配器) {
      if (!适配器?.通道 || !适配器?.token) throw new Error('适配器缺 通道/token，注册表拒收');
      for (const fn of ['收', '发', '归一']) {
        if (typeof 适配器[fn] !== 'function') throw new Error(`适配器[${适配器.通道}] 缺三件套.${fn}()，注册表拒收`);
      }
      const key = `${适配器.token}:${适配器.通道}`;
      if (们.has(key)) throw new Error(`通道重复注册：${key}`);
      们.set(key, 适配器);
      return 适配器;
    },
    全部: () => [...们.values()],
    查找: (token, 通道) => 们.get(`${token}:${通道}`) ?? null, // /send 路由用：token+通道 → 适配器
  };
}
