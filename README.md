# 墨锭试磨室

运行：

```bash
npm install   # better-sqlite3 有预编译二进制，通常无需本地编译
npm start
```

- 墨锭功能：`http://localhost:3037/`
- **器具清洗放行台：`http://localhost:3037/station/`**

数据：墨锭仍保存在 `data/ink-stick-testing.json`；清洗台使用独立的
SQLite（WAL，`synchronous=FULL`）文件 `data/station.db`（已 gitignore）。

测试：

```bash
npm test      # node:test：28 项（数据层 16 + 真实子进程 HTTP 10 + jsdom 页面 2）
```

## 器具清洗放行台

### 状态流转

```
待清洗 ──开洗──▶ 清洗中 ──送检──▶ 待检验 ──放行(参数界内)──▶ 可用
  ▲               │                 │                         │
  │               │                 └──驳回──▶ 待清洗          ├─领用(用毕)─▶ 待清洗
  └───────────────┴──────────────(过期也可重新清洗)             └─到期──▶ 过期 ──重洗──▶ 清洗中
管理员可 停用(仅非批次中) / 启用(回到待清洗)
```

- 每件器具编号唯一（数据库 UNIQUE 约束）。
- 同一器具不能同时进入两个清洗批次：进入批次用条件
  `UPDATE … WHERE active_batch_id IS NULL AND status IN ('待清洗','过期')`，
  并发写入时只有一个事务成功（`BEGIN IMMEDIATE` 串行化 + 条件更新）。
- 只有「可用」且未过期的器具能被试验员领用；领用是条件更新，
  并发领用恰好一次成功，其余返回 409。
- 清洗员登记：清洗剂、水温、时长、位置。
- 放行接受区间：**水温 40~60℃、时长 10~30 分钟**；越界可登记送检，
  但检验时禁止放行（422），须驳回重洗。边界值 40/60℃、10/30min 可放行。
- 放行时写入有效期（默认 72 小时）。到期在任意请求前的扫描中自动变为
  「过期」并写审计；过期器具不可领用，重新清洗后才能再用。
- 重复放行、重复批次写入均只能成功一次（状态守卫 + 幂等键）。

### 原子性与持久性

开批次、送检、放行、驳回、领用、停用都在单个 `BEGIN IMMEDIATE` 事务内完成，
批次行、批次-器具关联、器具状态、有效期计时、审计、幂等记录要么全部提交，
要么整体回滚，不会留下半条数据。WAL + `synchronous=FULL` 保证已提交事务
在崩溃/断电（测试用 `SIGKILL` 模拟）后不丢。

### 角色（请求头 `X-Role` / `X-Actor`，页面右上角可切换）

| 角色 | 权限 |
|---|---|
| 清洗员 cleaner | 登记清洗、送检 |
| 检验员 inspector | 放行（按参数边界）、驳回 |
| 试验员 tester | 领用可用器具 |
| 管理员 admin | 建档、停用、启用 |

越权返回 403 并写一条 `ok=0` 审计。所有成功与被拒操作都有审计记录。

### API（前缀 `/station/api`）

`GET /summary`、`/utensils`、`/batches`、`/audit`、`/requisitions`、`/meta`
`POST /utensils`（admin）
`POST /utensils/:id/requisition|retire|reactivate`
`POST /batches`（cleaner）、`POST /batches/:id/submit|release|reject`

写请求支持 `Idempotency-Key`：相同键的重放返回首次结果，不重复落库；
失败请求不消耗该键。

### 测试用故障注入（默认关闭）

以 `STATION_ALLOW_FAULT=1` 启动后，写请求可带头 `X-Fail-At: <阶段>`
模拟磁盘失败以验证整体回滚；`X-Now: <ms>` 注入时钟以构造到期场景。
生产模式（不设该环境变量）会忽略这两个头。

可用的阶段名与代码中的注入点一一对应（`station/db.js`）：

| `X-Fail-At` 阶段 | 作用的写接口 | 注入时机 / 回滚效果 |
|---|---|---|
| `afterUtensilInsert` | `POST /utensils`（建档） | 插入器具行之后；建档整体回滚，编号不被占用 |
| `afterBatchInsert` | `POST /batches`（登记清洗） | 插入批次行之后、改器具状态之前；批次不留、器具仍待清洗 |
| `afterUtensilUpdate` | `POST /batches`（登记清洗） | 批次行与器具状态都写入之后、提交之前；整批回滚，无批次、无关联、状态不变 |
| `afterReleaseUpdate` | `POST /batches/:id/release`（放行） | 器具置「可用」之后、批次置「已放行」之前；放行整体回滚，器具回到「待检验」，批次仍「待检验」 |

### 页面

总览显示六态数量、临期（≤24h）与异常（越界待检验 / 已过期）器具、批次列表；
另含清洗登记、检验放行、器具台账、审计与领用四个页签。纯原生 JS、
无构建步骤，使用响应式布局，桌面与手机均可操作。
