// 测试工具：在临时文件库上启动真实服务器子进程，供并发与重启持久性测试。
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function startServer({ fault = true, seed = false, db, port, reuse = false } = {}) {
  port = port || (await freePort());
  const dbFile = db || join(tmpdir(), `station-${Math.random().toString(36).slice(2)}-${Date.now()}.db`);
  // 全新启动时清掉可能残留的同名库；reuse（重启）时必须保留已提交数据与 WAL
  if (!reuse) for (const suf of ["", "-wal", "-shm"]) { try { rmSync(dbFile + suf, { force: true }); } catch {} }

  const env = {
    ...process.env,
    PORT: String(port),
    STATION_DB: dbFile,
    STATION_NO_SEED: seed ? "0" : "1",
    STATION_ALLOW_FAULT: fault ? "1" : "0"
  };
  const proc = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  let errBuf = "";
  proc.stderr.on("data", (d) => { errBuf += d; });

  const base = `http://127.0.0.1:${port}/station`;
  // 等待端口就绪
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const tick = async () => {
      try {
        const r = await fetch(base + "/api/meta");
        if (r.ok) return resolve();
      } catch {}
      if (proc.killed || Date.now() > deadline)
        return reject(new Error("server not ready. stderr=" + errBuf));
      setTimeout(tick, 80);
    };
    tick();
  });

  return {
    proc, base, dbFile,
    /** 硬杀进程（-9），模拟断电/崩溃，不给优雅退出机会 */
    killHard() { proc.kill("SIGKILL"); },
    waitExit(ms = 5000) {
      return new Promise((resolve) => {
        if (proc.killed || proc.exitCode != null) return resolve();
        const t = setTimeout(() => resolve(), ms);
        proc.on("exit", () => { clearTimeout(t); resolve(); });
      });
    },
    async stop() { try { proc.kill("SIGTERM"); } catch {} },
    async cleanupFiles() { for (const suf of ["", "-wal", "-shm"]) { try { rmSync(dbFile + suf, { force: true }); } catch {} } }
  };
}
