// 器具清洗放行台 —— SQLite 数据层
//
// 所有涉及多表的写操作（开批次 / 提交 / 放行 / 驳回 / 领用 / 停用）都在单个
// BEGIN IMMEDIATE 事务内完成：任一步失败或注入磁盘故障则整体 ROLLBACK，
// 「批次、器具状态、有效期计时、审计」要么全部落盘，要么一条都不留。
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = join(__dirname, "..", "data", "station.db");

export const STATUSES = ["待清洗", "清洗中", "待检验", "可用", "过期", "停用"];

// 放行时的参数接受边界（业务规则集中在此）
export const LIMITS = Object.freeze({
  temperatureMin: 40, // 水温下限 ℃
  temperatureMax: 60, // 水温上限 ℃
  durationMin: 10,    // 清洗时长下限 min
  durationMax: 30,    // 清洗时长上限 min
  nearExpiryHours: 24 // 距到期 ≤ 该小时数视为临期
});
export const DEFAULT_VALID_HOURS = 72; // 放行后默认有效期（小时）

// 登记时的物理合理范围（比放行范围宽，仅拦截明显脏数据）
const PHYSICAL = Object.freeze({ tempMin: 0, tempMax: 100, durMin: 1, durMax: 240 });

export const ROLES = Object.freeze({
  cleaner: "清洗员",
  inspector: "检验员",
  tester: "试验员",
  admin: "管理员"
});

export class DomainError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function openDb(filePath = DEFAULT_DB_PATH) {
  if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL"); // 提交即 fsync，崩溃/断电不丢已提交事务
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS utensils (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    code             TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,
    active_batch_id  INTEGER,
    status           TEXT NOT NULL DEFAULT '待清洗',
    current_batch_id INTEGER,
    expires_at       INTEGER,
    released_at      INTEGER,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    note             TEXT NOT NULL DEFAULT '',
    version          INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS cleaning_batches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_no        TEXT NOT NULL UNIQUE,
    status          TEXT NOT NULL DEFAULT '清洗中',
    detergent       TEXT NOT NULL,
    temperature     REAL NOT NULL,
    duration_min    INTEGER NOT NULL,
    location        TEXT NOT NULL,
    valid_hours     INTEGER,
    created_by      TEXT NOT NULL,
    released_by     TEXT,
    created_at      INTEGER NOT NULL,
    submitted_at    INTEGER,
    released_at     INTEGER
  );

  CREATE TABLE IF NOT EXISTS batch_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id   INTEGER NOT NULL REFERENCES cleaning_batches(id),
    utensil_id INTEGER NOT NULL REFERENCES utensils(id),
    added_at   INTEGER NOT NULL,
    UNIQUE(batch_id, utensil_id)
  );

  CREATE TABLE IF NOT EXISTS requisitions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    utensil_id   INTEGER NOT NULL REFERENCES utensils(id),
    utensil_code TEXT NOT NULL,
    batch_id     INTEGER,
    tester       TEXT NOT NULL,
    at           INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at     INTEGER NOT NULL,
    actor  TEXT NOT NULL,
    role   TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    detail TEXT NOT NULL,
    ok     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

  CREATE TABLE IF NOT EXISTS idempotency (
    idem_key   TEXT PRIMARY KEY,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    status     INTEGER NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`);
}

const HOUR_MS = 3600000;

function todayPrefix(now) {
  const d = new Date(now);
  return (
    "CB-" +
    d.getFullYear().toString().padStart(4, "0") +
    (d.getMonth() + 1).toString().padStart(2, "0") +
    d.getDate().toString().padStart(2, "0") +
    "-"
  );
}

function paramProblems(p) {
  const out = [];
  const duration = p.duration_min != null ? p.duration_min : p.durationMin;
  if (p.temperature < LIMITS.temperatureMin || p.temperature > LIMITS.temperatureMax)
    out.push(`水温 ${p.temperature}℃ 超出放行区间 ${LIMITS.temperatureMin}~${LIMITS.temperatureMax}℃`);
  if (duration < LIMITS.durationMin || duration > LIMITS.durationMax)
    out.push(`时长 ${duration}min 超出放行区间 ${LIMITS.durationMin}~${LIMITS.durationMax}min`);
  return out;
}

export class StationStore {
  constructor(db, { allowTestInjection = false } = {}) {
    this.db = db;
    this.allowTestInjection = allowTestInjection;
  }

  effectiveNow(ctx = {}) {
    if (ctx.now != null) return Number(ctx.now);
    if (this.allowTestInjection && ctx.testNow != null) return Number(ctx.testNow);
    return Date.now();
  }

  // ---- 统一变更入口：RBAC → 幂等 → 自动到期 → IMMEDIATE 事务 → 审计 ----
  mutate(action, allowedRoles, ctx, fn) {
    const now = this.effectiveNow(ctx);
    const actor = String(ctx.actor || "未知");
    const role = String(ctx.role || "");

    const deny = (code, msg, status) => {
      this._auditOne(now, actor, role, action, "(拒绝)", msg, 0);
      throw new DomainError(code, msg, status);
    };

    if (!allowedRoles.includes(role))
      deny("forbidden", `${ROLES[role] || role || "未登录角色"}无权执行「${action}」`, 403);

    if (ctx.idemKey) {
      const prior = this.db.prepare("SELECT * FROM idempotency WHERE idem_key = ?").get(ctx.idemKey);
      if (prior) {
        if (prior.action !== action) deny("idem_key_conflict", "幂等键已用于其它操作", 409);
        return { ...JSON.parse(prior.body), __replay: true };
      }
    }

    // 自动到期：独立提交，自身原子；把已到有效期的「可用」器具批量置为「过期」。
    this.sweepExpired(now);

    const auditRows = [];
    const c = {
      now,
      actor,
      role,
      failAt: ctx.failAt,
      failIf(point) {
        if (ctx.failAt === point)
          throw new Error(`injected_disk_failure@${point}`); // 模拟磁盘失败：事务将整体回滚
      },
      audit(target, detail) {
        auditRows.push({ target: String(target), detail: String(detail) });
      }
    };

    let result;
    const tx = this.db.transaction(() => {
      result = fn(c);
      for (const a of auditRows)
        this.db
          .prepare("INSERT INTO audit_log (at,actor,role,action,target,detail,ok) VALUES (?,?,?,?,?,?,1)")
          .run(now, actor, role, action, a.target, a.detail);
      if (ctx.idemKey)
        this.db
          .prepare("INSERT INTO idempotency (idem_key,actor,action,status,body,created_at) VALUES (?,?,?,?,?,?)")
          .run(ctx.idemKey, actor, action, 200, JSON.stringify(result), now);
    });

    try {
      tx.immediate(); // BEGIN IMMEDIATE：立即取写锁，把并发写串行化
    } catch (e) {
      if (e instanceof DomainError) {
        // 业务拒绝：业务数据未改动，独立持久化一条失败审计
        this._auditOne(now, actor, role, action, e.code, e.message, 0);
        throw e;
      }
      // 磁盘/基础设施错误：事务已回滚，批次/状态/计时/审计一条都不留
      throw new DomainError("disk_error", `写入失败，事务已回滚：${e.message}`, 500);
    }
    return result;
  }

  _auditOne(now, actor, role, action, target, detail, ok) {
    this.db
      .transaction(() => {
        this.db
          .prepare("INSERT INTO audit_log (at,actor,role,action,target,detail,ok) VALUES (?,?,?,?,?,?,?)")
          .run(now, actor, role, action, target, detail, ok ? 1 : 0);
      })
      .immediate();
  }

  // 把所有已过有效期的「可用」器具自动置为「过期」（同事务、带审计）。
  sweepExpired(now) {
    const rows = this.db
      .prepare("SELECT code FROM utensils WHERE status = '可用' AND expires_at IS NOT NULL AND expires_at <= ?")
      .all(now);
    if (!rows.length) return 0;
    const tx = this.db.transaction(() => {
      const upd = this.db.prepare(
        "UPDATE utensils SET status='过期', updated_at=?, version=version+1 WHERE status='可用' AND expires_at IS NOT NULL AND expires_at <= ?"
      );
      upd.run(now, now);
      const ins = this.db.prepare(
        "INSERT INTO audit_log (at,actor,role,action,target,detail,ok) VALUES (?,?,?,?,?,?,1)"
      );
      for (const r of rows)
        ins.run(now, "系统", "system", "到期失效", r.code, "有效期到期，自动由「可用」变为「过期」，需重新清洗");
    });
    tx.immediate();
    return rows.length;
  }

  // ---------------- 器具 ----------------
  _utensilById(id) {
    return this.db.prepare("SELECT * FROM utensils WHERE id = ?").get(Number(id) || -1);
  }
  _batchById(idOrNo) {
    const n = Number(idOrNo);
    return (
      this.db
        .prepare("SELECT * FROM cleaning_batches WHERE id = ? OR batch_no = ?")
        .get(Number.isFinite(n) ? n : -1, String(idOrNo)) || null
    );
  }

  createUtensil(ctx, input) {
    const code = String(input.code || "").trim();
    const name = String(input.name || "").trim();
    if (!code) throw new DomainError("bad_input", "器具编号不能为空");
    if (!name) throw new DomainError("bad_input", "器具名称不能为空");
    return this.mutate("建档器具", ["admin"], { ...ctx }, (c) => {
      if (this.db.prepare("SELECT 1 FROM utensils WHERE code = ?").get(code))
        throw new DomainError("duplicate_code", `编号 ${code} 已存在`, 409);
      const r = this.db
        .prepare("INSERT INTO utensils (code,name,status,created_at,updated_at,note) VALUES (?,?,'待清洗',?,?,?)")
        .run(code, name, c.now, c.now, String(input.note || ""));
      c.failIf("afterUtensilInsert");
      c.audit(code, `器具建档：${name}`);
      return this._utensilById(r.lastInsertRowid);
    });
  }

  retireUtensil(ctx, idOrCode) {
    return this.mutate("停用器具", ["admin"], { ...ctx }, (c) => {
      const u = this.db.prepare("SELECT * FROM utensils WHERE id=? OR code=?").get(Number(idOrCode) || -1, String(idOrCode));
      if (!u) throw new DomainError("not_found", "器具不存在", 404);
      if (u.status === "停用") throw new DomainError("already", "器具已是停用状态", 409);
      if (u.active_batch_id != null)
        throw new DomainError("in_batch", "器具处于未结束的清洗批次中，不能停用", 409);
      this.db
        .prepare("UPDATE utensils SET status='停用', expires_at=NULL, updated_at=?, version=version+1 WHERE id=?")
        .run(c.now, u.id);
      c.audit(u.code, "器具停用");
      return this._utensilById(u.id);
    });
  }

  reactivateUtensil(ctx, idOrCode) {
    return this.mutate("启用器具", ["admin"], { ...ctx }, (c) => {
      const u = this.db.prepare("SELECT * FROM utensils WHERE id=? OR code=?").get(Number(idOrCode) || -1, String(idOrCode));
      if (!u) throw new DomainError("not_found", "器具不存在", 404);
      if (u.status !== "停用") throw new DomainError("not_retired", "仅停用状态的器具可重新启用", 409);
      this.db
        .prepare("UPDATE utensils SET status='待清洗', expires_at=NULL, released_at=NULL, updated_at=?, version=version+1 WHERE id=?")
        .run(c.now, u.id);
      c.audit(u.code, "重新启用，回到「待清洗」");
      return this._utensilById(u.id);
    });
  }

  // ---------------- 领用 ----------------
  requisition(ctx, idOrCode) {
    return this.mutate("领用器具", ["tester"], { ...ctx }, (c) => {
      const u = this.db.prepare("SELECT * FROM utensils WHERE id=? OR code=?").get(Number(idOrCode) || -1, String(idOrCode));
      if (!u) throw new DomainError("not_found", "器具不存在", 404);
      // 条件 UPDATE：只有「可用、未过期、不在批次中」的器具能被领用。
      // 并发下第一人成功（changes=1），其余人 changes=0 → 409，保证只成功一次。
      const r = this.db
        .prepare(
          `UPDATE utensils SET status='待清洗', expires_at=NULL, released_at=NULL,
             active_batch_id=NULL, updated_at=?, version=version+1
           WHERE id=? AND status='可用' AND active_batch_id IS NULL
             AND (expires_at IS NULL OR expires_at > ?)`
        )
        .run(c.now, u.id, c.now);
      if (r.changes !== 1) {
        if (u.status === "可用")
          throw new DomainError("not_available", "器具已过期或已被他人领用", 409);
        throw new DomainError("not_usable", `器具当前为「${u.status}」，只有可用状态可领用`, 409);
      }
      this.db
        .prepare("INSERT INTO requisitions (utensil_id,utensil_code,batch_id,tester,at) VALUES (?,?,?,?,?)")
        .run(u.id, u.code, u.current_batch_id, c.actor, c.now);
      c.audit(u.code, `试验员领用（来自批次 #${u.current_batch_id ?? "-"}），用毕回到「待清洗」`);
      return this._utensilById(u.id);
    });
  }

  // ---------------- 清洗批次 ----------------
  startBatch(ctx, input) {
    return this.mutate("登记清洗", ["cleaner"], { ...ctx }, (c) => {
      const detergent = String(input.detergent || "").trim();
      const location = String(input.location || "").trim();
      const temperature = Number(input.temperature);
      const durationMin = parseInt(input.durationMin, 10);
      const ids = (input.utensilIds || []).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);

      if (!detergent) throw new DomainError("bad_input", "清洗剂必填");
      if (!location) throw new DomainError("bad_input", "清洗位置必填");
      if (!Number.isFinite(temperature) || temperature < PHYSICAL.tempMin || temperature > PHYSICAL.tempMax)
        throw new DomainError("bad_input", `水温需为 ${PHYSICAL.tempMin}~${PHYSICAL.tempMax}℃ 的数字`);
      if (!Number.isInteger(durationMin) || durationMin < PHYSICAL.durMin || durationMin > PHYSICAL.durMax)
        throw new DomainError("bad_input", `时长需为 ${PHYSICAL.durMin}~${PHYSICAL.durMax} 分钟的整数`);
      if (!ids.length) throw new DomainError("bad_input", "至少选择一件器具");

      const uniq = [...new Set(ids)];
      const utensils = this.db
        .prepare(`SELECT * FROM utensils WHERE id IN (${uniq.map(() => "?").join(",")})`)
        .all(...uniq);
      if (utensils.length !== uniq.length)
        throw new DomainError("not_found", "包含不存在的器具", 404);
      const blocked = utensils.filter((u) => !(u.status === "待清洗" || u.status === "过期") || u.active_batch_id != null);
      if (blocked.length)
        throw new DomainError(
          "utensil_busy",
          "存在不能进入本批次的器具（仅待清洗/过期、且不在其它批次中可加入）：" +
            blocked.map((u) => `${u.code}[${u.status}]`).join("，"),
          409,
          { blocked: blocked.map((u) => ({ code: u.code, status: u.status })) }
        );

      const prefix = todayPrefix(c.now);
      const last = this.db
        .prepare("SELECT batch_no FROM cleaning_batches WHERE batch_no LIKE ? ORDER BY batch_no DESC LIMIT 1")
        .get(prefix + "%");
      const seq = last ? parseInt(last.batch_no.slice(prefix.length), 10) + 1 : 1;
      const batchNo = prefix + String(seq).padStart(4, "0");

      const br = this.db
        .prepare(
          `INSERT INTO cleaning_batches (batch_no,status,detergent,temperature,duration_min,location,created_by,created_at)
           VALUES (?, '清洗中', ?,?,?,?,?,?)`
        )
        .run(batchNo, detergent, temperature, durationMin, location, c.actor, c.now);
      c.failIf("afterBatchInsert");
      const batchId = br.lastInsertRowid;
      for (const u of utensils) {
        const r = this.db
          .prepare(
            `UPDATE utensils SET status='清洗中', active_batch_id=?, current_batch_id=?, updated_at=?, version=version+1
             WHERE id=? AND active_batch_id IS NULL AND status IN ('待清洗','过期')`
          )
          .run(batchId, batchId, c.now, u.id);
        if (r.changes !== 1)
          throw new DomainError("utensil_busy", `器具 ${u.code} 已进入其它清洗批次`, 409);
        this.db.prepare("INSERT INTO batch_items (batch_id,utensil_id,added_at) VALUES (?,?,?)").run(batchId, u.id, c.now);
      }
      c.failIf("afterUtensilUpdate");
      c.audit(batchNo, `开洗 ${utensils.length} 件：${detergent}，${temperature}℃，${durationMin}min，${location}`);
      return this.batchDetail(batchId);
    });
  }

  submitBatch(ctx, idOrNo) {
    return this.mutate("清洗完成送检", ["cleaner"], { ...ctx }, (c) => {
      const b = this._batchById(idOrNo);
      if (!b) throw new DomainError("not_found", "批次不存在", 404);
      if (b.status !== "清洗中") throw new DomainError("bad_state", `批次为「${b.status}」，仅清洗中可送检`, 409);
      const items = this._batchUtensilIds(b.id);
      const r0 = this.db
        .prepare(
          `UPDATE utensils SET status='待检验', updated_at=?, version=version+1
           WHERE active_batch_id=? AND status='清洗中'`
        )
        .run(c.now, b.id);
      if (r0.changes !== items.length)
        throw new DomainError("conflict", "批次内器具状态不一致，已回滚", 409);
      this.db.prepare("UPDATE cleaning_batches SET status='待检验', submitted_at=? WHERE id=?").run(c.now, b.id);
      c.audit(b.batch_no, `清洗完成，送检 ${items.length} 件`);
      return this.batchDetail(b.id);
    });
  }

  releaseBatch(ctx, idOrNo, input = {}) {
    return this.mutate("检验放行", ["inspector"], { ...ctx }, (c) => {
      const b = this._batchById(idOrNo);
      if (!b) throw new DomainError("not_found", "批次不存在", 404);
      if (b.status !== "待检验") throw new DomainError("bad_state", `批次为「${b.status}」，仅待检验可放行`, 409);

      // 参数越界不得放行
      const problems = paramProblems(b);
      if (problems.length)
        throw new DomainError("param_out_of_range", "清洗参数越界，不能放行：" + problems.join("；"), 422, { problems });

      let validHours = input.validHours != null ? parseInt(input.validHours, 10) : DEFAULT_VALID_HOURS;
      if (!Number.isInteger(validHours) || validHours <= 0 || validHours > 24 * 365)
        throw new DomainError("bad_input", "有效期需为 1~8760 小时之间的整数");

      const items = this._batchUtensilIds(b.id);
      const expiresAt = c.now + validHours * HOUR_MS;
      const r = this.db
        .prepare(
          `UPDATE utensils SET status='可用', released_at=?, expires_at=?, updated_at=?, version=version+1
           WHERE active_batch_id=? AND status='待检验'`
        )
        .run(c.now, expiresAt, c.now, b.id);
      if (r.changes !== items.length)
        throw new DomainError("conflict", "批次内器具状态不一致，已回滚", 409);
      c.failIf("afterReleaseUpdate");
      this.db
        .prepare("UPDATE cleaning_batches SET status='已放行', released_by=?, released_at=?, valid_hours=? WHERE id=?")
        .run(c.actor, c.now, validHours, b.id);
      this.db.prepare("UPDATE utensils SET active_batch_id=NULL WHERE active_batch_id=?").run(b.id);
      c.audit(
        b.batch_no,
        `放行 ${items.length} 件，有效期 ${validHours} 小时，至 ${new Date(expiresAt).toLocaleString("zh-CN")}`
      );
      return this.batchDetail(b.id);
    });
  }

  rejectBatch(ctx, idOrNo, input = {}) {
    return this.mutate("检验驳回", ["inspector"], { ...ctx }, (c) => {
      const b = this._batchById(idOrNo);
      if (!b) throw new DomainError("not_found", "批次不存在", 404);
      if (b.status !== "待检验") throw new DomainError("bad_state", `批次为「${b.status}」，仅待检验可驳回`, 409);
      const items = this._batchUtensilIds(b.id);
      this.db
        .prepare(
          `UPDATE utensils SET status='待清洗', active_batch_id=NULL, expires_at=NULL, updated_at=?, version=version+1
           WHERE active_batch_id=? AND status='待检验'`
        )
        .run(c.now, b.id);
      if (this.db.prepare("SELECT COUNT(*) n FROM utensils WHERE active_batch_id=?").get(b.id).n !== 0)
        throw new DomainError("conflict", "批次内器具状态不一致，已回滚", 409);
      this.db.prepare("UPDATE cleaning_batches SET status='已驳回' WHERE id=?").run(b.id);
      c.audit(b.batch_no, `驳回 ${items.length} 件，退回待清洗重新清洗。原因：${String(input.reason || "未填写")}`);
      return this.batchDetail(b.id);
    });
  }

  _batchUtensilIds(batchId) {
    return this.db.prepare("SELECT utensil_id AS id FROM batch_items WHERE batch_id=? ORDER BY id").all(batchId).map((r) => r.id);
  }

  // ---------------- 查询 ----------------
  batchDetail(idOrNo) {
    const b = this._batchById(idOrNo);
    if (!b) return null;
    const items = this.db
      .prepare(
        `SELECT u.id,u.code,u.name,u.status FROM batch_items bi
         JOIN utensils u ON u.id=bi.utensil_id WHERE bi.batch_id=? ORDER BY bi.id`
      )
      .all(b.id);
    const problems = paramProblems(b);
    return { ...b, items, paramProblems: problems, withinLimits: problems.length === 0 };
  }

  listBatches() {
    return this.db
      .prepare("SELECT * FROM cleaning_batches ORDER BY id DESC")
      .all()
      .map((b) => ({ ...b, ...this._batchCounts(b.id), paramProblems: paramProblems(b), withinLimits: paramProblems(b).length === 0 }));
  }
  _batchCounts(batchId) {
    const row = this.db.prepare("SELECT COUNT(*) n FROM batch_items WHERE batch_id=?").get(batchId);
    return { itemCount: row.n };
  }

  listUtensils(now = Date.now()) {
    const rows = this.db
      .prepare(
        `SELECT u.*, b.batch_no AS active_batch_no FROM utensils u
         LEFT JOIN cleaning_batches b ON b.id=u.active_batch_id ORDER BY u.id`
      )
      .all();
    return rows.map((u) => this._decorate(u, now));
  }

  _decorate(u, now) {
    const expired = u.status === "过期" || (u.status === "可用" && u.expires_at != null && u.expires_at <= now);
    const nearExpiry =
      u.status === "可用" &&
      u.expires_at != null &&
      u.expires_at > now &&
      u.expires_at - now <= LIMITS.nearExpiryHours * HOUR_MS;
    const paramAbnormal = u.status === "待检验"; // 是否越界由批次参数决定，dashboard 里联表判断
    return { ...u, expired, nearExpiry, paramAbnormal };
  }

  dashboard(now = Date.now()) {
    this.sweepExpired(now);
    const utensils = this.listUtensils(now);
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const u of utensils) counts[u.status] = (counts[u.status] || 0) + 1;

    const near = utensils.filter((u) => u.nearExpiry);
    const expired = utensils.filter((u) => u.status === "过期");
    const inBatch = utensils.filter((u) => u.status === "清洗中");

    // 异常：处于「待检验」但其所在批次清洗参数越界的器具
    const pendingBatches = this.db.prepare("SELECT * FROM cleaning_batches WHERE status='待检验'").all();
    const badBatchIds = new Set(pendingBatches.filter((b) => paramProblems(b).length > 0).map((b) => b.id));
    const abnormal = utensils
      .filter((u) => (u.status === "待检验" && badBatchIds.has(u.active_batch_id)) || u.status === "过期")
      .map((u) => {
        let reason = u.status === "过期" ? "已过期，需重新清洗" : "批次清洗参数越界，不能放行";
        return { id: u.id, code: u.code, name: u.name, status: u.status, reason, activeBatchNo: u.active_batch_no };
      });

    return {
      now,
      counts,
      total: utensils.length,
      nearExpiry: near.map((u) => ({
        id: u.id, code: u.code, name: u.name,
        expiresAt: u.expires_at, hoursLeft: u.expires_at ? Math.round((u.expires_at - now) / HOUR_MS) : null
      })),
      abnormal,
      inWashing: inBatch.length,
      batches: this.listBatches()
    };
  }

  listAudit(limit = 100) {
    return this.db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(Math.min(Number(limit) || 100, 500));
  }
  listRequisitions(limit = 100) {
    return this.db.prepare("SELECT * FROM requisitions ORDER BY id DESC LIMIT ?").all(Math.min(Number(limit) || 100, 500));
  }
}


