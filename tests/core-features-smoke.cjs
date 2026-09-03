// 核心功能冒烟测试：在无头浏览器中验证 hex 编辑器、宏录制/回放、命令面板、编码转换对话框。
// 依赖本地 dev server（npm run dev，http://localhost:1420）；由 tests/run-e2e.cjs 自动起停。
// 用法： node tests/core-features-smoke.cjs
const { chromium } = require("playwright");
const fs = require("fs");

const URL = process.env.MD_URL || "http://localhost:1420/";

function resolveChrome() {
  let exe;
  try { exe = chromium.executablePath(); } catch (_) { exe = undefined; }
  if (exe && fs.existsSync(exe)) return exe;
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const fallback = "/Users/hp/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  return fs.existsSync(fallback) ? fallback : undefined;
}

// mock：/tmp/core.txt 固定内容 "Hello World"，hex 读取返回其字节。
// 注意：invoke 函数体会被 eval 注入页面执行，必须完全自包含（不能引用脚本外变量）；
//       因此 mock 内部的 CONTENT 与下方 Node 侧断言的 CONTENT 各定义一份。
const CONTENT = "Hello World";
function invoke(cmd, args) {
  window.__calls = window.__calls || [];
  const CONTENT = "Hello World";
  const bytes = new TextEncoder().encode(CONTENT);
  let result = {};
  if (cmd === "read_text_file") {
    const p = (args && args.path) || "";
    result = p.endsWith("core.txt")
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
const eq = (got, exp, name) => (got === exp ? ok(`${name}: ${JSON.stringify(got)}`) : fail(`${name}: 期望 ${JSON.stringify(exp)}，实际 ${JSON.stringify(got)}`));

(async () => {
  const exe = resolveChrome();
  const launchOpts = { args: ["--no-sandbox"] };
  if (exe) launchOpts.executablePath = exe;
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message + "\n" + (e.stack || "")));

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

  const setEditor = (text) => page.evaluate((t) => {
    const v = window.__app.view;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
    v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
  }, text);
  const getEditor = () => page.evaluate(() => window.__app.view.state.doc.toString());
  const cleanModals = () => page.evaluate(() => document.querySelectorAll(".modal-mask").forEach((m) => m.remove()));

  // 打开 /tmp/core.txt（打开后若弹恢复会话等确认框，先清掉避免遮挡工具栏按钮）
  await page.evaluate(() => window.__app.openFile("/tmp/core.txt"));
  await page.waitForTimeout(300);
  await cleanModals();
  eq(await getEditor(), CONTENT, "打开文件内容");

  // ===== A) 十六进制编辑器 =====
  await page.locator("#btn-mode").click();
  await page.waitForTimeout(400);
  const hexVisible = await page.evaluate(() => !document.getElementById("hex-container").classList.contains("hidden"));
  hexVisible ? ok("切换到十六进制模式") : fail("hex 容器未显示");
  const hexRows = await page.evaluate(() => document.querySelectorAll(".hex-rows .hex-row").length);
  hexRows > 0 ? ok(`hex 渲染了 ${hexRows} 行`) : fail("hex 未渲染数据行");
  const hexHasH = await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll(".hex-cell"));
    return cells.some((c) => c.textContent.startsWith("48")); // 'H' = 0x48
  });
  hexHasH ? ok("hex 单元格包含 'H'(0x48)") : fail("未在 hex 中找到 'H' 的字节");

  // 切回文本
  await page.locator("#btn-mode").click();
  await page.waitForTimeout(300);
  eq(await getEditor(), CONTENT, "从 hex 切回文本后内容保留");

  // ===== B) 宏录制与回放 =====
  await setEditor("");
  await page.evaluate(() => window.__app.view.focus());
  // 开始录制
  await page.locator('#menubar .menu-item', { hasText: "编辑" }).click();
  await page.waitForTimeout(120);
  await page.locator('.menu-item-drop', { hasText: "录制/停止宏" }).click();
  await page.waitForTimeout(150);
  // 输入（点击编辑器聚焦后键入）
  await page.locator(".cm-content").click();
  await page.keyboard.type("AB");
  await page.waitForTimeout(150);
  // 停止录制
  await page.locator('#menubar .menu-item', { hasText: "编辑" }).click();
  await page.waitForTimeout(120);
  await page.locator('.menu-item-drop', { hasText: "录制/停止宏" }).click();
  await page.waitForTimeout(150);
  // 播放宏
  await page.locator('#menubar .menu-item', { hasText: "编辑" }).click();
  await page.waitForTimeout(120);
  await page.locator('.menu-item-drop', { hasText: "播放宏" }).click();
  await page.waitForTimeout(200);
  eq(await getEditor(), "ABAB", "宏录制后回放插入 ABAB");

  // ===== C) 命令面板 =====
  await page.keyboard.press("Meta+Shift+P");
  await page.waitForTimeout(200);
  const paletteOpen = await page.evaluate(() => !!document.querySelector(".palette-mask #palette-input"));
  paletteOpen ? ok("命令面板已打开 (⌘⇧P)") : fail("命令面板未打开");
  const paletteItems = await page.evaluate(() => document.querySelectorAll(".palette-item").length);
  paletteItems > 0 ? ok(`命令面板列出 ${paletteItems} 条命令`) : fail("命令面板为空");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const paletteClosed = await page.evaluate(() => !document.querySelector(".palette-mask"));
  paletteClosed ? ok("命令面板可关闭 (Esc)") : fail("命令面板未关闭");

  // ===== D) 编码转换对话框（文件菜单） =====
  await page.locator('#menubar .menu-item', { hasText: "文件" }).click();
  await page.waitForTimeout(120);
  await page.locator('.menu-item-drop', { hasText: "编码转换…" }).click();
  await page.waitForTimeout(200);
  const encOpen = await page.evaluate(() => {
    const m = document.querySelector(".modal");
    return !!m && /编码转换|编码/.test(m.textContent || "");
  });
  encOpen ? ok("编码转换对话框已打开") : fail("编码转换对话框未打开");
  await cleanModals();

  if (errors.length) fail("运行期报错: " + errors.join(" | "));
  else ok("无运行期报错");

  await browser.close();
  console.log(failures === 0 ? "\nPASS ✅ 核心功能冒烟测试通过" : `\nFAIL ❌ ${failures} 项未通过`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("验证运行异常:", e);
  process.exit(2);
});
