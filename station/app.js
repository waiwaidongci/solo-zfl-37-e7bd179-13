// 器具清洗放行台 HTTP 层：装配在主应用 /station 前缀下。
// 身份通过请求头传递：X-Role（admin/cleaner/inspector/tester）、X-Actor。
// 幂等：Idempotency-Key；测试故障/时钟：仅当 STATION_ALLOW_FAULT=1 时
//       识别 X-Fail-At 与 X-Now 头。
import { StationStore, DomainError, ROLES, STATUSES, LIMITS } from "./db.js";
import { renderPage } from "./page.js";

const FAULT = process.env.STATION_ALLOW_FAULT === "1";

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new DomainError("too_large", "请求体过大", 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new DomainError("bad_json", "请求体不是合法 JSON", 400)); }
    });
    req.on("error", reject);
  });
}

export function createStationServer(store) {
  if (!(store instanceof StationStore)) throw new Error("need StationStore");

  function ctx(req) {
    const role = String(req.headers["x-role"] || "").trim();
    // 客户端对中文姓名做了百分号编码；解码失败时按 Latin-1 原文兜底
    let actor = String(req.headers["x-actor"] || "匿名").trim() || "匿名";
    try { actor = decodeURIComponent(actor); } catch {}
    const idemKey = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : undefined;
    const c = { role, actor, idemKey };
    if (FAULT) {
      if (req.headers["x-fail-at"]) c.failAt = String(req.headers["x-fail-at"]);
      if (req.headers["x-now"]) c.now = Number(req.headers["x-now"]);
    }
    return c;
  }

  const wrap = (fn) => async (req, res, seg) => {
    try { await fn(req, res, seg); }
    catch (e) {
      if (e instanceof DomainError) return json(res, e.status, { error: e.code, message: e.message, details: e.details });
      json(res, 500, { error: "internal", message: e.message });
    }
  };

  // 仅允许「在批次内」的写操作走幂等/状态守卫
  const routes = [];
  const add = (method, re, fn) => routes.push({ method, re, fn: wrap(fn) });

  add("GET", /^\/station\/?$/, (_req, res) => htmlPage(res));
  add("GET", /^\/station\/api\/meta\/?$/, (_req, res) =>
    json(res, 200, { roles: ROLES, statuses: STATUSES, limits: LIMITS, fault: FAULT }));
  add("GET", /^\/station\/api\/summary\/?$/, (_req, res) =>
    json(res, 200, store.dashboard()));
  add("GET", /^\/station\/api\/utensils\/?$/, (_req, res) =>
    json(res, 200, store.listUtensils()));
  add("POST", /^\/station\/api\/utensils\/?$/, async (req, res) => {
    const input = await readBody(req);
    json(res, 201, store.createUtensil(ctx(req), input));
  });
  add("POST", /^\/station\/api\/utensils\/([^/]+)\/requisition\/?$/, async (req, res, seg) => {
    await readBody(req);
    json(res, 200, store.requisition(ctx(req), decode(seg[0])));
  });
  add("POST", /^\/station\/api\/utensils\/([^/]+)\/retire\/?$/, async (req, res, seg) => {
    await readBody(req);
    json(res, 200, store.retireUtensil(ctx(req), decode(seg[0])));
  });
  add("POST", /^\/station\/api\/utensils\/([^/]+)\/reactivate\/?$/, async (req, res, seg) => {
    await readBody(req);
    json(res, 200, store.reactivateUtensil(ctx(req), decode(seg[0])));
  });
  add("GET", /^\/station\/api\/batches\/?$/, (_req, res) =>
    json(res, 200, store.listBatches()));
  add("GET", /^\/station\/api\/batches\/([^/]+)\/?$/, (req, res, seg) => {
    const d = store.batchDetail(decode(seg[0]));
    if (!d) return json(res, 404, { error: "not_found", message: "批次不存在" });
    json(res, 200, d);
  });
  add("POST", /^\/station\/api\/batches\/?$/, async (req, res) => {
    const input = await readBody(req);
    json(res, 201, store.startBatch(ctx(req), input));
  });
  add("POST", /^\/station\/api\/batches\/([^/]+)\/submit\/?$/, async (req, res, seg) => {
    await readBody(req);
    json(res, 200, store.submitBatch(ctx(req), decode(seg[0])));
  });
  add("POST", /^\/station\/api\/batches\/([^/]+)\/release\/?$/, async (req, res, seg) => {
    const input = await readBody(req);
    json(res, 200, store.releaseBatch(ctx(req), decode(seg[0]), input));
  });
  add("POST", /^\/station\/api\/batches\/([^/]+)\/reject\/?$/, async (req, res, seg) => {
    const input = await readBody(req);
    json(res, 200, store.rejectBatch(ctx(req), decode(seg[0]), input));
  });
  add("GET", /^\/station\/api\/audit\/?$/, (_req, res) => json(res, 200, store.listAudit(200)));
  add("GET", /^\/station\/api\/requisitions\/?$/, (_req, res) => json(res, 200, store.listRequisitions(200)));

  function decode(s) { return decodeURIComponent(s); }
  function htmlPage(res) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderPage());
  }

  return async function stationHandler(req, res, pathname) {
    const p = pathname || new URL(req.url, "http://x").pathname;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = p.match(r.re);
      if (!m) continue;
      req.__seg = m.slice(1);
      return r.fn(req, res, m.slice(1));
    }
    json(res, 404, { error: "not_found", message: "清洗台接口不存在" });
  };
}
