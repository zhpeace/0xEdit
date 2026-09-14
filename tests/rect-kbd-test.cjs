// 列编辑键盘行为验证（临时脚本）：验证
//  T1 列模式下无矩形时纯方向键不扩展选区（仅移动光标）
//  T2 Shift+↓×3 + Shift+→ 建立 4 行 1 列矩形
//  T3 纯 ← 塌缩为单光标（不选择内容）
//  T4 再 Shift+← 从原矩形锚点恢复多行（ranges.length === 4）
// 用法： node tests/rect-kbd-test.cjs
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright");
const fs = require("fs");

const PORT = 1420;
const URL = `http://localhost:${PORT}/`;
const ROOT = path.resolve(__dirname, "..");
const VITE_BIN = path.join(ROOT, "node_modules", ".bin", "vite");

function resolveChrome() {
  let exe;
  try { exe = chromium.executablePath(); } catch (_) { exe = undefined; }
  if (exe && fs.existsSync(exe)) return exe;
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const fallback = "/Users/hp/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  return fs.existsSync(fallback) ? fallback : undefined;
}

const CONTENT = "111111111\n222222222\n333333333\n444444444\n555555555\n666666666";
function invoke(cmd, args) {
  window.__calls = window.__calls || [];
  const CONTENT = "111111111\n222222222\n333333333\n444444444\n555555555\n666666666";
  const bytes = new TextEncoder().encode(CONTENT);
  let result = {};
  if (cmd === "read_text_file") {
    const p = (args && args.path) || "";
    result = p.endsWith("rect.txt")
      ? { text: CONTENT, encoding: "utf-8", line_endings: "lf", is_binary: false, truncated: false, size: CONTENT.length }
      : { text: "", encoding: "utf-8", line_endings: "lf", is_binary: false, truncated: false, size: 0 };
  } else if (cmd === "save_text_file") {
    window.__lastSave = args;
  } else if (cmd === "file_size") {
    result = bytes.length;
  } else if (cmd === "read_hex_range") {
    const off = (args && args.offset) || 0;
    const len = (args && args.length) || 0;
    result = Array.from(bytes.slice(off, off + len));
  } else if (cmd === "home_dir") {
    result = "/tmp";
  } else if (cmd === "list_dir" || cmd === "read_dir") {
    result = [];
  }
  window.__calls.push({ cmd, args });
  return Promise.resolve(result);
}

let failures = 0;
const fail = (m) => { failures++; console.log("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);

const getSel = (page) =>
  page.evaluate(() => {
    const v = window.__app.view;
    const s = v.state.selection;
    return {
      main: { from: s.main.from, to: s.main.to, head: s.main.head },
      ranges: s.ranges.map((r) => ({ from: r.from, to: r.to })),
      lines: v.state.doc.toString(),
    };
  });

async function waitPort(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((res, rej) => {
        const req = http.get({ host: "localhost", port, path: "/", timeout: 800 }, (r) => { r.resume(); res(); });
        req.on("error", rej); req.on("timeout", () => { req.destroy(); rej(new Error("t")); });
      });
      return true;
    } catch (_) { await new Promise((r) => setTimeout(r, 400)); }
  }
  return false;
}

(async () => {
  let server;
  const open = await new Promise((r) => {
    const req = http.get({ host: "localhost", port: PORT, path: "/", timeout: 600 }, (res) => { res.resume(); r(true); });
    req.on("error", () => r(false)); req.on("timeout", () => { req.destroy(); r(false); });
  });
  if (!open) {
    server = spawn(VITE_BIN, ["--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "ignore" });
    if (!(await waitPort(PORT, 30000))) { console.log("dev server 启动失败"); process.exit(2); }
    console.log("dev server 已启动");
  } else {
    console.log("复用已运行的 dev server");
  }

  try {
    const exe = resolveChrome();
    const launchOpts = { args: ["--no-sandbox"] };
    if (exe) launchOpts.executablePath = exe;
    const browser = await chromium.launch(launchOpts);
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));

    await page.addInitScript((inv) => {
      window.__TAURI_INTERNALS__ = { invoke: (c, a) => eval("(" + inv + ")")(c, a) };
    }, invoke.toString());

    await page.goto(URL, { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.setItem("uec.lang", "zh-CN"));
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#menubar .menu-item");
    await page.waitForTimeout(400);
    await page.locator('.modal-mask [data-act="ignore"]').click().catch(() => {});
    await page.waitForTimeout(200);

    // 打开多行文本
    await page.evaluate(() => window.__app.openFile("/tmp/rect.txt"));
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelectorAll(".modal-mask").forEach((m) => m.remove()));

    const doc = await page.evaluate(() => window.__app.view.state.doc.toString());
    if (!doc.includes("666666666")) { console.log("文档未加载: " + JSON.stringify(doc)); throw new Error("文档未加载"); }

    // 光标定位到第 3 行第 3 列（col=2），开启列编辑模式
    await page.evaluate(() => {
      const v = window.__app.view;
      const line = v.state.doc.line(3);
      v.dispatch({ selection: { anchor: line.from + 2, head: line.from + 2 } });
      v.focus();
    });
    await page.evaluate(() => window.__app.toggleColumn());

    // T1：无矩形时按纯 ↓，不应出现选区
    await page.keyboard.press("ArrowDown");
    let s1 = await getSel(page);
    const t1ok = s1.main.from === s1.main.head && s1.ranges.length === 1;
    t1ok ? ok("T1 无矩形纯 ↓ 仅移动光标（无选区）") : fail("T1 纯 ↓ 出现选区：" + JSON.stringify(s1.main));

    // T2：Shift+↓×3 + Shift+→ 建矩形（光标第4行起，文档共6行 → 3 行）
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowRight");
    let s2 = await getSel(page);
    const t2ok = s2.ranges.length === 3 && s2.ranges.every((r) => r.to > r.from);
    t2ok ? ok("T2 建立 3 行 1 列矩形（ranges=" + s2.ranges.length + "）") : fail("T2 矩形异常：" + JSON.stringify(s2.ranges));

    // T3：纯 ← 塌缩为单光标（不选择内容）
    await page.keyboard.press("ArrowLeft");
    let s3 = await getSel(page);
    const t3ok = s3.main.from === s3.main.head && s3.ranges.length === 1;
    t3ok ? ok("T3 纯 ← 塌缩为单光标，无选区") : fail("T3 纯 ← 后仍有选区：" + JSON.stringify(s3.main));

    // T4：Shift+← 从原矩形锚点恢复多行
    await page.keyboard.press("Shift+ArrowLeft");
    let s4 = await getSel(page);
    const t4ok = s4.ranges.length === 3;
    t4ok ? ok("T4 Shift+← 恢复 3 行矩形（ranges=" + s4.ranges.length + "）") : fail("T4 Shift+← 未恢复多行：" + JSON.stringify(s4.ranges));

    console.log("\nranges 明细：\n  T2: " + JSON.stringify(s2.ranges) + "\n  T3: " + JSON.stringify(s3.ranges) + "\n  T4: " + JSON.stringify(s4.ranges));
    await browser.close();
  } finally {
    if (server) server.kill();
  }

  console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
