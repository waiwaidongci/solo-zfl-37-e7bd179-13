// 端到端 HTTP 测试：真实服务器子进程，覆盖越权/冲突/过期/回滚/重启。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib.mjs";

let srv;
before(async () => { srv = await startServer({ fault: true, seed: false }); });
after(async () => { await srv.stop(); await srv.cleanupFiles(); });

const H = 3600000;
function headers(extra = {}) {
  return { "Content-Type": "application/json", "X-Actor": "tester", ...extra };
}
async function api(path, opts = {}) {
  const res = await fetch(srv.base + path, {
    method: opts.method || "GET",
    headers: headers(opts.headers),
    body: opts.body
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
async function mkUtensil(code) {
  const r = await api("/api/utensils", {
    method: "POST", headers: { "X-Role": "admin" }, body: JSON.stringify({ code, name: code })
  });
  assert.equal(r.status, 201, "建具 " + code + ": " + JSON.stringify(r.json));
  return r.json;
}
// 清洗→送检→放行，返回器具最新状态
async function cleanToReleased(id, { temp = 50, dur = 15, validHours = 72, now, release = true } = {}) {
  const h = { "X-Role": "cleaner", ...(now ? { "X-Now": String(now) } : {}) };
  const b = await api("/api/batches", {
    method: "POST", headers: h,
    body: JSON.stringify({ detergent: "soda", temperature: temp, durationMin: dur, location: "L", utensilIds: [id] })
  });
  assert.equal(b.status, 201, JSON.stringify(b.json));
  const bid = b.json.id;
  const sub = await api(`/api/batches/${bid}/submit`, { method: "POST", headers: h, body: "{}" });
  assert.equal(sub.status, 200);
  if (!release) return b.json;
  const rel = await api(`/api/batches/${bid}/release`, {
    method: "POST", headers: { "X-Role": "inspector", ...(now ? { "X-Now": String(now) } : {}) },
    body: JSON.stringify({ validHours })
  });
  return { batch: b.json, release: rel.json, releaseStatus: rel.status };
}

test("页面与元数据可访问", async () => {
  const res = await fetch(srv.base + "/");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("器具清洗放行台"));
  const meta = await api("/api/meta");
  assert.equal(meta.json.limits.temperatureMax, 60);
});

test("越权：试验员不能放行、清洗员不能领用/建档", async () => {
  const u = await mkUtensil("HTTP-RBAC");
  const b = await cleanToReleased(u.id, { release: false });
  const r1 = await api(`/api/batches/${b.id}/release`, {
    method: "POST", headers: { "X-Role": "tester" }, body: JSON.stringify({ validHours: 1 })
  });
  assert.equal(r1.status, 403);
  const r2 = await api(`/api/utensils/${u.id}/requisition`, {
    method: "POST", headers: { "X-Role": "cleaner" }, body: "{}"
  });
  assert.equal(r2.status, 403);
  const r3 = await api("/api/utensils", {
    method: "POST", headers: { "X-Role": "tester" }, body: JSON.stringify({ code: "X", name: "x" })
  });
  assert.equal(r3.status, 403);
  // 越权被拒绝但器具状态未被改动
  const cur = await api("/api/utensils");
  assert.equal(cur.json.find((x) => x.code === "HTTP-RBAC").status, "待检验");
});

test("参数越界不得放行（时长与水温），驳回后可重洗放行", async () => {
  const u1 = await mkUtensil("HTTP-TEMP");
  const a = await cleanToReleased(u1.id, { temp: 80, dur: 15 });
  assert.equal(a.releaseStatus, 422);
  const u2 = await mkUtensil("HTTP-DUR");
  const c = await cleanToReleased(u2.id, { temp: 50, dur: 9 });
  assert.equal(c.releaseStatus, 422);
  // 驳回 u2（仍在待检验），再重洗为界内参数后放行
  const bid = c.batch.id;
  const rej = await api(`/api/batches/${bid}/reject`, {
    method: "POST", headers: { "X-Role": "inspector" }, body: JSON.stringify({ reason: "duration" })
  });
  assert.equal(rej.status, 200);
  const again = await cleanToReleased(u2.id, { temp: 50, dur: 15, validHours: 24 });
  assert.equal(again.releaseStatus, 200);
});

test("并发领用 25 个请求恰好 1 个成功，且只产生 1 条领用记录", async () => {
  const u = await mkUtensil("HTTP-RACE");
  const r = await cleanToReleased(u.id, { validHours: 72 });
  assert.equal(r.releaseStatus, 200);
  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      api(`/api/utensils/${u.id}/requisition`, {
        method: "POST", headers: { "X-Role": "tester", "X-Actor": "t" + i }, body: "{}"
      })
    )
  );
  const ok = results.filter((x) => x.status === 200);
  const conflict = results.filter((x) => x.status === 409);
  assert.equal(ok.length, 1, "成功数应为1，实际 " + ok.length);
  assert.equal(conflict.length, 24);
  const reqs = await api("/api/requisitions");
  assert.equal(reqs.json.filter((x) => x.utensil_code === "HTTP-RACE").length, 1);
  const cur = await api("/api/utensils");
  assert.equal(cur.json.find((x) => x.code === "HTTP-RACE").status, "待清洗");
});

test("同一器具并发写入两个批次，恰好 1 个成功", async () => {
  const u = await mkUtensil("HTTP-BATCH");
  const payload = JSON.stringify({ detergent: "soda", temperature: 50, durationMin: 15, location: "L", utensilIds: [u.id] });
  const [x, y] = await Promise.all([
    api("/api/batches", { method: "POST", headers: { "X-Role": "cleaner", "X-Actor": "c1" }, body: payload }),
    api("/api/batches", { method: "POST", headers: { "X-Role": "cleaner", "X-Actor": "c2" }, body: payload })
  ]);
  const codes = [x.status, y.status].sort();
  assert.deepEqual(codes, [201, 409]);
  const cur = await api("/api/utensils");
  const row = cur.json.find((z) => z.code === "HTTP-BATCH");
  assert.equal(row.status, "清洗中");
  assert.ok(row.active_batch_id != null);
});

test("重复放行只能成功一次", async () => {
  const u = await mkUtensil("HTTP-DREL");
  const r = await cleanToReleased(u.id, { validHours: 3 });
  assert.equal(r.releaseStatus, 200);
  const second = await api(`/api/batches/${r.batch.id}/release`, {
    method: "POST", headers: { "X-Role": "inspector" }, body: JSON.stringify({ validHours: 3 })
  });
  assert.equal(second.status, 409);
});

test("注入磁盘故障：批次写入整体回滚，无批次/无关联/状态不变/无成功审计", async () => {
  const u = await mkUtensil("HTTP-FAIL");
  const before = await api("/api/utensils");
  const beforeBatchCount = (await api("/api/batches")).json.length;
  const r = await api("/api/batches", {
    method: "POST",
    headers: { "X-Role": "cleaner", "X-Fail-At": "afterUtensilUpdate" },
    body: JSON.stringify({ detergent: "soda", temperature: 50, durationMin: 15, location: "L", utensilIds: [u.id] })
  });
  assert.equal(r.status, 500);
  const after = await api("/api/utensils");
  assert.equal(after.json.find((x) => x.code === "HTTP-FAIL").status, "待清洗");
  assert.equal(after.json.find((x) => x.code === "HTTP-FAIL").active_batch_id, null);
  assert.equal((await api("/api/batches")).json.length, beforeBatchCount, "批次数量不应增加");
  // 不应出现该器具的成功『登记清洗』审计
  const logs = await api("/api/audit?limit=200");
  const successForUtensil = logs.json.filter((l) => l.ok === 1 && l.action === "登记清洗" && l.detail.includes("HTTP-FAIL"));
  assert.equal(successForUtensil.length, 0);
});

test("幂等：同键重放只产生一个批次，且返回同批次号", async () => {
  const u = await mkUtensil("HTTP-IDEM");
  const key = "http-idem-" + u.id;
  const payload = JSON.stringify({ detergent: "soda", temperature: 48, durationMin: 12, location: "L", utensilIds: [u.id] });
  const h = { "X-Role": "cleaner", "Idempotency-Key": key };
  const r1 = await api("/api/batches", { method: "POST", headers: h, body: payload });
  const r2 = await api("/api/batches", { method: "POST", headers: h, body: payload });
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.equal(r2.json.__replay, true);
  assert.equal(r1.json.batch_no, r2.json.batch_no);
});

test("重启：已提交数据不丢、回滚数据不在；跨重启到期自动失效", async () => {
  const dbFile = srv.dbFile;
  // 器具A：当前时刻放行、有效期 200h，重启后仍应是「可用」，验证已提交数据不丢
  const ua = await mkUtensil("HTTP-RESTART");
  const ra = await cleanToReleased(ua.id, { validHours: 200 });
  assert.equal(ra.releaseStatus, 200);
  // 器具B：2 小时前放行、有效期 1h，重启时真实时钟下确已「过期」
  const past = Date.now() - 2 * H;
  const ub = await mkUtensil("HTTP-EXPIRE");
  const rb = await cleanToReleased(ub.id, { validHours: 1, now: past });
  assert.equal(rb.releaseStatus, 200);
  // 重启前再制造一次回滚，确认它不会在崩溃后"复活"（该写操作也会触发到期扫描）
  const u2 = await mkUtensil("HTTP-ROLLBACK");
  const fb = await api("/api/batches", {
    method: "POST", headers: { "X-Role": "cleaner", "X-Fail-At": "afterBatchInsert" },
    body: JSON.stringify({ detergent: "soda", temperature: 50, durationMin: 15, location: "L", utensilIds: [u2.id] })
  });
  assert.equal(fb.status, 500);
  const committedBatchCount = (await api("/api/batches")).json.length;

  // 硬杀（模拟断电），再以同一数据库文件重启
  srv.killHard();
  await srv.waitExit();
  const srv2 = await startServer({ fault: true, seed: false, db: dbFile, reuse: true });
  try {
    const get = async (p) => (await fetch(srv2.base + p)).json();
    let utensils = await get("/api/utensils");
    const persisted = utensils.find((x) => x.code === "HTTP-RESTART");
    assert.equal(persisted.status, "可用", "已提交的放行状态应跨重启保留");
    assert.ok(persisted.expires_at > Date.now(), "有效期时间戳应保留且仍在未来");
    const expiredOne = utensils.find((x) => x.code === "HTTP-EXPIRE");
    assert.equal(expiredOne.status, "过期", "到期器具跨重启应为过期");
    const rolled = utensils.find((x) => x.code === "HTTP-ROLLBACK");
    assert.equal(rolled.status, "待清洗");
    assert.equal(rolled.active_batch_id, null);
    assert.equal((await get("/api/batches")).length, committedBatchCount, "回滚的批次不应在重启后出现");

    // 跨重启的「可用」器具仍可正常领用
    const reqA = await fetch(srv2.base + "/api/utensils/HTTP-RESTART/requisition", {
      method: "POST", headers: headers({ "X-Role": "tester" }), body: "{}"
    });
    assert.equal(reqA.status, 200, "重启后可用器具应能领用");
    // 过期器具不可领用
    const reqB = await fetch(srv2.base + "/api/utensils/HTTP-EXPIRE/requisition", {
      method: "POST", headers: headers({ "X-Role": "tester" }), body: "{}"
    });
    assert.equal(reqB.status, 409, "过期器具跨重启仍不可领用");
  } finally {
    await srv2.stop();
  }
});

test("生产模式（无 fault 开关）忽略 X-Fail-At 与 X-Now", async () => {
  const prod = await startServer({ fault: false, seed: false });
  try {
    const cr = await fetch(prod.base + "/api/utensils", {
      method: "POST", headers: headers({ "X-Role": "admin" }),
      body: JSON.stringify({ code: "PROD-1", name: "prod" })
    });
    const u = await cr.json();
    const r = await fetch(prod.base + "/api/batches", {
      method: "POST",
      headers: headers({ "X-Role": "cleaner", "X-Fail-At": "afterUtensilUpdate", "X-Now": "0" }),
      body: JSON.stringify({ detergent: "soda", temperature: 50, durationMin: 15, location: "L", utensilIds: [u.id] })
    });
    assert.equal(r.status, 201, "生产模式下故障头应被忽略，批次正常写入");
  } finally {
    await prod.stop();
    await prod.cleanupFiles();
  }
});
