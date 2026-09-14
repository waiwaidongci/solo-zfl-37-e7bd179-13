// 数据层测试：状态机 / 越权 / 冲突 / 过期 / 回滚 / 幂等（内存库，确定性时钟）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, StationStore } from "../station/db.js";

function fresh() {
  return new StationStore(openDb(":memory:"), { allowTestInjection: true });
}
const R = {
  admin: { actor: "admin1", role: "admin" },
  cleaner: { actor: "cleaner1", role: "cleaner" },
  inspector: { actor: "inspector1", role: "inspector" },
  tester: { actor: "tester1", role: "tester" }
};
const H = 3600000;

// 构造一件走到「可用」的器具，返回 { store, u, batch, now, expiresAt }
function readyReleased(validHours = 72, t0 = 1_000_000_000_000) {
  const s = fresh();
  const u = s.createUtensil({ ...R.admin, now: t0 }, { code: "Y1", name: "bowl" });
  const b = s.startBatch({ ...R.cleaner, now: t0 }, {
    detergent: "soda", temperature: 50, durationMin: 15, location: "slot", utensilIds: [u.id]
  });
  s.submitBatch({ ...R.cleaner, now: t0 }, b.id);
  s.releaseBatch({ ...R.inspector, now: t0 }, b.id, { validHours });
  const expiresAt = t0 + validHours * H;
  return { s, u, b, t0, expiresAt };
}

test("完整流转：待清洗→清洗中→待检验→可用→领用→待清洗", () => {
  const { s, u, expiresAt } = readyReleased();
  assert.equal(s._decorate({ status: "可用", expires_at: expiresAt }, expiresAt - H).expired, false);
  const got = s.requisition({ ...R.tester, now: expiresAt - H }, u.id);
  assert.equal(got.status, "待清洗");
  assert.equal(got.expires_at, null);
});

test("同一器具不能同时进入两个清洗批次", () => {
  const s = fresh();
  const a = s.createUtensil(R.admin, { code: "A", name: "a" });
  s.startBatch(R.cleaner, { detergent: "x", temperature: 50, durationMin: 15, location: "L", utensilIds: [a.id] });
  assert.throws(
    () => s.startBatch(R.cleaner, { detergent: "y", temperature: 50, durationMin: 15, location: "L2", utensilIds: [a.id] }),
    (e) => e.code === "utensil_busy"
  );
  // 失败后器具仍只挂在第一个批次
  const row = s.db.prepare("SELECT active_batch_id, status FROM utensils WHERE id=?").get(a.id);
  assert.equal(row.status, "清洗中");
  assert.ok(row.active_batch_id != null);
});

test("领用后不能重复领用（真实并发只成功一次在 http 测试验证）", () => {
  const { s, u, expiresAt } = readyReleased();
  const atValid = { ...R.tester, now: expiresAt - H };
  const outcomes = [];
  // better-sqlite3 为同步库，同一连接上无法交错；临界区守卫的真并发验证在 http 测试。
  // 这里验证首次领用成功、状态立即离开「可用」，第二次必然失败。
  outcomes.push(s.requisition(atValid, u.id).status);
  assert.throws(() => s.requisition(atValid, u.id), (e) => e.code === "not_usable");
  assert.deepEqual(outcomes, ["待清洗"]);
  // 只产生一条领用记录
  assert.equal(s.db.prepare("SELECT COUNT(*) c FROM requisitions WHERE utensil_id=?").get(u.id).c, 1);
});

test("非可用状态不能领用（待清洗/清洗中/待检验/过期/停用）", () => {
  const s = fresh();
  const admin = s.createUtensil(R.admin, { code: "M", name: "m" });
  assert.throws(() => s.requisition(R.tester, admin.id), (e) => e.code === "not_usable");
  const b = s.startBatch(R.cleaner, { detergent: "x", temperature: 50, durationMin: 15, location: "L", utensilIds: [admin.id] });
  assert.throws(() => s.requisition(R.tester, admin.id), (e) => e.code === "not_usable");
  s.submitBatch(R.cleaner, b.id);
  assert.throws(() => s.requisition(R.tester, admin.id), (e) => e.code === "not_usable");
});

test("批次中的器具不能停用", () => {
  const s = fresh();
  const u = s.createUtensil(R.admin, { code: "P", name: "p" });
  s.startBatch(R.cleaner, { detergent: "x", temperature: 50, durationMin: 15, location: "L", utensilIds: [u.id] });
  assert.throws(() => s.retireUtensil(R.admin, u.id), (e) => e.code === "in_batch");
});

test("参数越界不得放行；驳回后可重洗", () => {
  const s = fresh();
  const u = s.createUtensil(R.admin, { code: "O", name: "o" });
  const b = s.startBatch(R.cleaner, { detergent: "x", temperature: 80, durationMin: 15, location: "L", utensilIds: [u.id] });
  s.submitBatch(R.cleaner, b.id);
  assert.throws(() => s.releaseBatch(R.inspector, b.id, {}), (e) => e.code === "param_out_of_range");
  // 越界放行失败后状态不变
  assert.equal(s.batchDetail(b.id).status, "待检验");
  assert.equal(s.db.prepare("SELECT status FROM utensils WHERE id=?").get(u.id).status, "待检验");
});

test("边界参数 40/60℃、10/30min 判定", () => {
  const s = fresh();
  const mk = (temp, dur) => {
    const code = `E${temp}-${dur}`;
    const u = s.createUtensil(R.admin, { code, name: code });
    const b = s.startBatch(R.cleaner, { detergent: "x", temperature: temp, durationMin: dur, location: "L", utensilIds: [u.id] });
    s.submitBatch(R.cleaner, b.id);
    return b;
  };
  // 下界、上界内放行
  for (const [t, d] of [[40, 10], [60, 30], [50, 20]]) {
    const b = mk(t, d);
    const r = s.releaseBatch(R.inspector, b.id, { validHours: 1 });
    assert.equal(r.status, "已放行");
  }
  // 越界
  for (const [t, d] of [[39.5, 20], [60.5, 20], [50, 9], [50, 31]]) {
    const b = mk(t, d);
    assert.throws(() => s.releaseBatch(R.inspector, b.id, {}), (e) => e.code === "param_out_of_range");
  }
});

test("到期自动失效：sweep 与 mutate 都会触发；过期不可领用", () => {
  const { s, u, expiresAt } = readyReleased(1); // 1 小时有效
  // 到期前仍可用
  assert.equal(s.db.prepare("SELECT status FROM utensils WHERE id=?").get(u.id).status, "可用");
  const n = s.sweepExpired(expiresAt + 1);
  assert.equal(n, 1);
  assert.equal(s.db.prepare("SELECT status FROM utensils WHERE id=?").get(u.id).status, "过期");
  // 再扫一次幂等（0 行）
  assert.equal(s.sweepExpired(expiresAt + 10), 0);
  // 过期不可领用
  assert.throws(() => s.requisition({ ...R.tester, now: expiresAt + 10 }, u.id), (e) => e.code === "not_usable");
  // 过期器具可重新清洗
  const b = s.startBatch({ ...R.cleaner, now: expiresAt + 10 }, {
    detergent: "soda", temperature: 50, durationMin: 15, location: "L", utensilIds: [u.id]
  });
  assert.equal(b.items[0].status, "清洗中");
});

test("任何变更操作在到期临界点会先自动失效", () => {
  const { s, u, expiresAt } = readyReleased(1);
  // 用一个已过期的时刻做「停用」，操作前应先 sweep
  s.retireUtensil({ ...R.admin, now: expiresAt + 5 }, u.id);
  assert.equal(s.db.prepare("SELECT status FROM utensils WHERE id=?").get(u.id).status, "停用");
  const logs = s.db.prepare("SELECT action FROM audit_log WHERE target=? AND action='到期失效'").all(u.code);
  assert.equal(logs.length, 1);
});

test("注入磁盘故障时整事务回滚：批次/关联/器具状态/审计/幂等无半条", () => {
  const s = fresh();
  const u = s.createUtensil(R.admin, { code: "F", name: "f" });
  const before = {
    batches: s.db.prepare("SELECT COUNT(*) c FROM cleaning_batches").get().c,
    links: s.db.prepare("SELECT COUNT(*) c FROM batch_items").get().c,
    utensils: s.db.prepare("SELECT status, active_batch_id FROM utensils WHERE id=?").get(u.id),
    audit: s.db.prepare("SELECT COUNT(*) c FROM audit_log").get().c,
    idem: s.db.prepare("SELECT COUNT(*) c FROM idempotency").get().c
  };
  assert.throws(
    () => s.startBatch({ ...R.cleaner, idemKey: "K1", failAt: "afterUtensilUpdate" },
      { detergent: "x", temperature: 50, durationMin: 15, location: "L", utensilIds: [u.id] }),
    (e) => e.code === "disk_error"
  );
  const after = {
    batches: s.db.prepare("SELECT COUNT(*) c FROM cleaning_batches").get().c,
    links: s.db.prepare("SELECT COUNT(*) c FROM batch_items").get().c,
    utensils: s.db.prepare("SELECT status, active_batch_id FROM utensils WHERE id=?").get(u.id),
    audit: s.db.prepare("SELECT COUNT(*) c FROM audit_log").get().c,
    idem: s.db.prepare("SELECT COUNT(*) c FROM idempotency").get().c
  };
  assert.deepEqual(after, before);
  assert.equal(after.utensils.status, "待清洗");
  assert.equal(after.utensils.active_batch_id, null);
  // 同一幂等键在失败后仍可用于成功的请求
  const b = s.startBatch({ ...R.cleaner, idemKey: "K1" },
    { detergent: "x", temperature: 50, durationMin: 15, location: "L", utensilIds: [u.id] });
  assert.ok(b.id);
});

test("幂等：同键重放返回首次结果；不同动作复用键被拒", () => {
  const s = fresh();
  const u = s.createUtensil(R.admin, { code: "I", name: "i" });
  const payload = { detergent: "x", temperature: 50, durationMin: 15, location: "L", utensilIds: [u.id] };
  const first = s.startBatch({ ...R.cleaner, idemKey: "DUP" }, payload);
  const replay = s.startBatch({ ...R.cleaner, idemKey: "DUP" }, payload);
  assert.equal(replay.__replay, true);
  assert.equal(replay.batch_no, first.batch_no);
  assert.equal(s.db.prepare("SELECT COUNT(*) c FROM cleaning_batches").get().c, 1);
  assert.throws(
    () => s.retireUtensil({ ...R.admin, idemKey: "DUP" }, u.code),
    (e) => e.code === "idem_key_conflict"
  );
});

test("越权：每个角色只能执行被授权动作，并写失败审计", () => {
  const s = fresh();
  const denied = [
    () => s.createUtensil(R.tester, { code: "Z", name: "z" }),
    () => s.createUtensil(R.cleaner, { code: "Z", name: "z" }),
    () => s.createUtensil(R.inspector, { code: "Z", name: "z" }),
    () => s.startBatch(R.tester, {}),
    () => s.startBatch(R.admin, {}),
    () => s.submitBatch(R.inspector, 1),
    () => s.releaseBatch(R.cleaner, 1, {}),
    () => s.releaseBatch(R.tester, 1, {}),
    () => s.rejectBatch(R.cleaner, 1, {}),
    () => s.requisition(R.cleaner, 1),
    () => s.requisition(R.admin, 1),
    () => s.retireUtensil(R.tester, 1)
  ];
  for (const fn of denied) assert.throws(fn, (e) => e.code === "forbidden" && e.status === 403);
  const failAudit = s.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE ok=0").get().c;
  assert.equal(failAudit, denied.length);
});

test("重复放行只能成功一次", () => {
  const { s, b } = readyReleased();
  assert.throws(() => s.releaseBatch(R.inspector, b.id, {}), (e) => e.code === "bad_state");
});

test("重复停用/启用守卫", () => {
  const s = fresh();
  s.createUtensil(R.admin, { code: "R", name: "r" });
  s.retireUtensil(R.admin, "R");
  assert.throws(() => s.retireUtensil(R.admin, "R"), (e) => e.code === "already");
  s.reactivateUtensil(R.admin, "R");
  assert.equal(s.db.prepare("SELECT status FROM utensils WHERE code='R'").get().status, "待清洗");
  assert.throws(() => s.reactivateUtensil(R.admin, "R"), (e) => e.code === "not_retired");
});

test("编号唯一", () => {
  const s = fresh();
  s.createUtensil(R.admin, { code: "DUP1", name: "x" });
  assert.throws(() => s.createUtensil(R.admin, { code: "DUP1", name: "y" }), (e) => e.code === "duplicate_code");
});

test("dashboard 统计六态数量、临期与异常", () => {
  const { s, u, expiresAt } = readyReleased(1);
  const now = expiresAt - 1; // 已可用且 1h 内到期 -> 临期
  const d = s.dashboard(now);
  assert.equal(d.counts["可用"], 1);
  assert.equal(d.nearExpiry.some((x) => x.code === u.code), true);
  // 越界待检验批次 -> 异常
  const u2 = s.createUtensil({ ...R.admin, now }, { code: "BAD", name: "bad" });
  const b = s.startBatch({ ...R.cleaner, now }, { detergent: "x", temperature: 90, durationMin: 15, location: "L", utensilIds: [u2.id] });
  s.submitBatch({ ...R.cleaner, now }, b.id);
  const d2 = s.dashboard(now);
  assert.ok(d2.abnormal.some((x) => x.code === "BAD"));
  // 到期后
  const d3 = s.dashboard(expiresAt + 1);
  assert.equal(d3.counts["过期"], 1);
  assert.ok(d3.abnormal.some((x) => x.code === u.code));
});
