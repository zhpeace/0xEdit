// 演示截图脚本：在无头浏览器中截取核心功能界面，保存到 docs/screenshots/
// 依赖本地 dev server（npm run dev，http://localhost:1420）
// 用法： node tests/take-screenshots.cjs
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const URL = process.env.MD_URL || "http://localhost:1420/";
const OUT = path.join(__dirname, "..", "docs", "screenshots");
fs.mkdirSync(OUT, { recursive: true });

function resolveChrome() {
  let exe;
  try { exe = chromium.executablePath(); } catch (_) { exe = undefined; }
  if (exe && fs.existsSync(exe)) return exe;
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const fallback = "/Users/hp/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  return fs.existsSync(fallback) ? fallback : undefined;
}

const SAMPLE_CODE = `// 0xEdit — 跨平台文本与十六进制编辑器
// 技术栈：Tauri 2 + CodeMirror 6 + Vanilla TS

function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

const sequence = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const result = sequence.map(fibonacci);

console.log("Fibonacci sequence:", result);
// Hex: 48 65 6C 6C 6F 20 57 6F 72 6C 64
`;

function mockInvoke(cmd, args) {
  // 自包含 mock，经 addInitScript 注入页面；必须直接接受 (cmd, args)，不能是工厂函数
  window.__calls = window.__calls || [];
  window.__calls.push({ cmd, args });
  var code = "// 0xEdit — 跨平台文本与十六进制编辑器\n// 技术栈：Tauri 2 + CodeMirror 6 + Vanilla TS\n\nfunction fibonacci(n) {\n  if (n <= 1) return n;\n  return fibonacci(n - 1) + fibonacci(n - 2);\n}\n\nconst sequence = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];\nconst result = sequence.map(fibonacci);\n\nconsole.log(\"Fibonacci sequence:\", result);\n// Hex: 48 65 6C 6C 6F 20 57 6F 72 6C 64\n";
  var bytes = new TextEncoder().encode(code);
  var result;
  if (cmd === "read_text_file") { result = { text: code, encoding: "utf-8", line_endings: "lf", is_binary: false, truncated: false, size: bytes.length }; }
  else if (cmd === "save_text_file") { result = undefined; }
  else if (cmd === "file_size") { result = bytes.length; }
  else if (cmd === "read_hex_range") {
    var off = (args && args.offset) || 0;
    var len = (args && args.length) || 0;
    result = Array.from(bytes.slice(off, off + len));
  }
  else if (cmd === "home_dir") { result = "/tmp"; }
  else if (cmd === "list_dir" || cmd === "read_dir") { result = []; }
  else if (cmd === "path_separator") { result = "/"; }
  else { result = undefined; }
  return Promise.resolve(result);
}

(async () => {
  const exe = resolveChrome();
  const launchOpts = { args: ["--no-sandbox"] };
  if (exe) launchOpts.executablePath = exe;
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);

  await page.addInitScript((inv) => {
    window.__TAURI_INTERNALS__ = { invoke: (c, a) => eval("(" + inv + ")")(c, a) };
  }, mockInvoke.toString());

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("uec.lang", "zh-CN"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#menubar .menu-item");
  await page.waitForTimeout(500);
  await page.locator('.modal-mask [data-act="ignore"]').click().catch(() => {});
  await page.waitForTimeout(200);

  // 打开 .js 文件（mock 返回示例代码，触发语法高亮，且文档已保存状态）
  await page.evaluate(() => window.__app.openFile("/tmp/demo.js"));
  await page.waitForTimeout(600);
  // 清掉可能的恢复会话/编码检测弹窗
  await page.evaluate(() => document.querySelectorAll(".modal-mask").forEach((m) => m.remove()));
  await page.waitForTimeout(200);

  // 1. 主界面（代码编辑，语法高亮）
  await page.screenshot({ path: path.join(OUT, "main-editor.png") });
  console.log("✓ main-editor.png");

  // 2. 十六进制编辑器
  await page.locator("#btn-mode").click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "hex-editor.png") });
  console.log("✓ hex-editor.png");
  await page.locator("#btn-mode").click();
  await page.waitForTimeout(300);

  // 3. 设置面板（8 套主题选择器）
  await page.evaluate(() => document.querySelectorAll(".modal-mask").forEach((m) => m.remove()));
  await page.evaluate(() => window.__app.settingsDialog());
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "settings-themes.png") });
  console.log("✓ settings-themes.png");
  await page.locator('.modal-mask [data-cancel]').click().catch(() => {});
  await page.waitForTimeout(200);

  // 4. 命令面板
  await page.evaluate(() => document.querySelectorAll(".modal-mask").forEach((m) => m.remove()));
  await page.evaluate(() => window.__app.openPalette());
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "command-palette.png") });
  console.log("✓ command-palette.png");

  await browser.close();
  console.log("\n全部截图完成 →", OUT);
})().catch((e) => {
  console.error("截图失败:", e.message);
  process.exit(1);
});
