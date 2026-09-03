#!/usr/bin/env node
// e2e 测试 runner：自动启动 dev server → 依次运行全部 Playwright 冒烟测试 → 关闭 dev server。
//
// 行为约定：
//   1) 若 http://localhost:1420 已有 dev server 在运行，则直接复用（不重复启动、不自动关闭）；
//   2) 否则由本脚本启动 vite，并在所有测试结束后关闭它；
//   3) 任一测试失败/超时，最终退出码为 1；dev server 自身启动失败，退出码为 2。
//
// 用法： node tests/run-e2e.cjs          （或 npm run test:e2e）
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const PORT = 1420;
const URL = `http://localhost:${PORT}/`;
const ROOT = path.resolve(__dirname, "..");
const VITE_BIN = path.join(ROOT, "node_modules", ".bin", "vite");
const TEST_TIMEOUT_MS = 120000;
const START_TIMEOUT_MS = 30000;

const TESTS = [
  { file: "i18n-smoke.cjs", name: "i18n 三语冒烟", env: { I18N_URL: URL } },
  { file: "merge-smoke.cjs", name: "合并编辑冒烟", env: { MERGE_URL: URL } },
  { file: "markdown-smoke.cjs", name: "Markdown 预览冒烟", env: { MD_URL: URL } },
  { file: "core-features-smoke.cjs", name: "核心功能冒烟", env: { MD_URL: URL } },
  { file: "verify-features.cjs", name: "端到端功能验证", env: { MD_URL: URL } },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
  return new Promise((resolve) => {
    // 用 localhost 而非 127.0.0.1：vite 默认可能只监听 IPv6 [::1]，只探测 IPv4 会误判端口空闲
    const req = http.get(
      { host: "localhost", port, path: "/", timeout: 800 },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitPort(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portOpen(port)) return true;
    await sleep(400);
  }
  return false;
}

function runTest({ file, name, env }) {
  return new Promise((resolve) => {
    console.log(`\n===== ${name} (${file}) =====`);
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    const timer = setTimeout(() => {
      console.error(`  ✗ ${name} 超过 ${TEST_TIMEOUT_MS / 1000}s 未结束，强制终止`);
      child.kill("SIGKILL");
      resolve(false);
    }, TEST_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      console.error(`  ✗ ${name} 启动失败: ${e.message}`);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

(async () => {
  const alreadyUp = await portOpen(PORT);
  let viteProc = null;

  if (alreadyUp) {
    console.log(`检测到 ${URL} 已有 dev server 在运行，直接复用（不会自动关闭）`);
  } else {
    console.log(`启动 dev server → ${URL}`);
    viteProc = spawn(VITE_BIN, [], { cwd: ROOT, stdio: "inherit" });
    viteProc.on("error", (e) => {
      console.error(`  ✗ 无法启动 vite: ${e.message}（请先 npm install）`);
      process.exit(2);
    });
    const ok = await waitPort(PORT, START_TIMEOUT_MS);
    if (!ok) {
      console.error(`  ✗ dev server 在 ${START_TIMEOUT_MS / 1000}s 内未就绪`);
      viteProc.kill("SIGKILL");
      process.exit(2);
    }
    console.log("dev server 就绪");
  }

  let pass = 0;
  const failed = [];
  for (const t of TESTS) {
    const ok = await runTest(t);
    if (ok) pass += 1;
    else failed.push(t.name);
  }

  if (viteProc) {
    console.log("\n关闭 dev server…");
    viteProc.kill("SIGTERM");
    // 最多等 5s 让端口释放
    for (let i = 0; i < 25; i++) {
      if (!(await portOpen(PORT))) break;
      await sleep(200);
    }
  }

  console.log(`\n===== e2e 汇总：${pass}/${TESTS.length} 通过 =====`);
  if (failed.length) {
    console.log(`未通过：${failed.join("、")}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error("runner 异常:", e);
  process.exit(2);
});
