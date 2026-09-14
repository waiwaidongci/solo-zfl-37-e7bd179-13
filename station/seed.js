// 首次启动（器具表为空）时写入一套演示数据，覆盖各状态、临期与异常。
// 仅在文件库为空时由 server.js 调用；测试用 :memory: 不受影响。
export function seedDemo(store) {
  const admin = { actor: "管理员-顾", role: "admin" };
  const cleaner = { actor: "清洗员-沈", role: "cleaner" };
  const inspector = { actor: "检验员-林", role: "inspector" };
  const now = Date.now();
  const H = 3600000;

  const mk = (code, name) => store.createUtensil(admin, { code, name });
  const y1 = mk("YJ-001", "研钵");
  const y2 = mk("YJ-002", "墨杵");
  const y3 = mk("YJ-003", "水盂");
  const y4 = mk("YJ-004", "瓷碟");
  mk("YJ-005", "铜勺");
  const y6 = mk("YJ-006", "滤架");

  // 界内批次：放行后有效期 20h -> 两件「可用」且临期
  const a = store.startBatch(cleaner, {
    detergent: "食用碱", temperature: 50, durationMin: 15, location: "清洗间1号槽", utensilIds: [y1.id, y2.id]
  });
  store.submitBatch(cleaner, a.id);
  store.releaseBatch(inspector, a.id, { validHours: 20 });

  // 越界批次（水温 80℃）：停在「待检验」，无法放行 -> 异常
  const b = store.startBatch(cleaner, {
    detergent: "专用清洗剂", temperature: 80, durationMin: 15, location: "清洗间2号槽", utensilIds: [y3.id]
  });
  store.submitBatch(cleaner, b.id);

  // 用 25 小时前的时钟完成一次放行（有效期 1h），首屏扫描时即「过期」-> 异常
  const t0 = now - 25 * H;
  const c = store.startBatch({ ...cleaner, now: t0 }, {
    detergent: "食用碱", temperature: 55, durationMin: 20, location: "清洗间1号槽", utensilIds: [y4.id]
  });
  store.submitBatch({ ...cleaner, now: t0 }, c.id);
  store.releaseBatch({ ...inspector, now: t0 }, c.id, { validHours: 1 });

  // 停用
  store.retireUtensil(admin, y6.id);
}
