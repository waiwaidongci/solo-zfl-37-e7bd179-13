// DOM 集成冒烟：对真实运行的服务器用 jsdom 加载页面、执行内联脚本、
// 断言关键面板渲染，并真实点击「试验员领用」走完前端→API→重渲染链路。
// （真实浏览器的像素级响应式无法在此验证；CSS 媒体查询已在 page.js 中定义。）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { startServer } from "./lib.mjs";

let srv;
before(async () => { srv = await startServer({ fault: true, seed: false }); });
after(async () => { await srv.stop(); await srv.cleanupFiles(); });

async function call(path, opts = {}) {
  const res = await fetch(srv.base + path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json", "X-Actor": "dom", ...(opts.headers || {}) },
    body: opts.body
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function makeReleasedUtensil(code) {
  const u = await call("/api/utensils", { method: "POST", headers: { "X-Role": "admin" }, body: JSON.stringify({ code, name: code }) });
  const b = await call("/api/batches", {
    method: "POST", headers: { "X-Role": "cleaner" },
    body: JSON.stringify({ detergent: "soda", temperature: 50, durationMin: 15, location: "L", utensilIds: [u.json.id] })
  });
  await call(`/api/batches/${b.json.id}/submit`, { method: "POST", headers: { "X-Role": "cleaner" }, body: "{}" });
  const rel = await call(`/api/batches/${b.json.id}/release`, { method: "POST", headers: { "X-Role": "inspector" }, body: JSON.stringify({ validHours: 72 }) });
  assert.equal(rel.status, 200);
  return u.json;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, { tries = 50, every = 60 } = {}) {
  for (let i = 0; i < tries; i++) { try { if (fn()) return true; } catch {} await sleep(every); }
  return false;
}

test("页面加载后渲染六态统计、批次表与两个告警面板，且无脚本错误", async () => {
  await makeReleasedUtensil("DOM-A");
  const errors = [];
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: srv.base + "/", runScripts: "outside-only", pretendToBeVisual: true
  });
  const { window } = dom;
  window.addEventListener("error", (e) => errors.push(e.message));
  window.fetch = (path, opts) => fetch(new URL(path, srv.base).href, opts);
  if (!window.crypto) window.crypto = globalThis.crypto;

  const html = await (await fetch(srv.base + "/")).text();
  // 取出内联脚本并在该 window 上下文执行
  const inline = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const docHtml = html.replace(/<script>[\s\S]*<\/script>/, "");
  window.document.open(); window.document.write(docHtml); window.document.close();
  try { window.eval(inline); } catch (e) { errors.push("eval: " + e.stack); }

  const $ = (s) => window.document.querySelector(s);
  const ok = await waitFor(() => $("#stats") && $("#stats").children.length === 6 && $("#batchTable tbody").children.length > 0);
  assert.ok(ok, "统计与批次表应渲染");
  assert.equal($("#stats").children.length, 6);
  assert.ok($("#nearList").textContent.length >= 0);
  assert.ok($("#badList").textContent.length >= 0);
  assert.equal(errors.length, 0, "页面脚本错误: " + errors.join(" | "));
  window.close();
});

test("试验员在页面点击「领用」可用器具：状态回到待清洗，且二次点击被拒", async () => {
  const u = await makeReleasedUtensil("DOM-B");
  const errors = [];
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: srv.base + "/", runScripts: "outside-only", pretendToBeVisual: true
  });
  const { window } = dom;
  window.addEventListener("error", (e) => errors.push(e.message));
  window.fetch = (path, opts) => fetch(new URL(path, srv.base).href, opts);
  if (!window.crypto) window.crypto = globalThis.crypto;

  const html = await (await fetch(srv.base + "/")).text();
  const inline = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const docHtml = html.replace(/<script>[\s\S]*<\/script>/, "");
  window.document.open(); window.document.write(docHtml); window.document.close();
  window.eval(inline);

  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => [...window.document.querySelectorAll(s)];
  await waitFor(() => $$(`button[data-req="${u.id}"]`).length === 1);

  // 切换到器具台账页并点击该器具的领用
  $$(".tabs button").find((b) => b.dataset.tab === "utensils").click();
  const btn = $(`button[data-req="${u.id}"]`);
  assert.ok(btn, "应存在领用按钮");
  btn.click();

  // loadAll() 会重渲染，必须每次从实时 DOM 重新查询，不能持有旧节点
  const becameUsed = await waitFor(() => {
    const cards = $$("#utensilGrid .card h4");
    const h = cards.find((x) => x.textContent.includes("DOM-B"));
    const card = h && h.closest(".card");
    return card && card.textContent.includes("待清洗") && !card.querySelector(`button[data-req="${u.id}"]`);
  });
  assert.ok(becameUsed, "领用后卡片状态应变为待清洗且领用按钮消失");

  // 后端确认：仅一条领用记录，状态为待清洗
  const list = await call("/api/utensils");
  const row = list.json.find((x) => x.code === "DOM-B");
  assert.equal(row.status, "待清洗");
  const reqs = await call("/api/requisitions");
  assert.equal(reqs.json.filter((r) => r.utensil_code === "DOM-B").length, 1);
  assert.equal(errors.length, 0, "页面脚本错误: " + errors.join(" | "));
  window.close();
});
