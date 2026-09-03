// 功能验证：在真实运行环境里端到端驱动新功能（文本转换对话框、Markdown 导出、Word 导出、语法高亮）。
// 依赖本地 dev server（npm run dev，http://localhost:1420）。
// 用法： node tests/verify-features.cjs
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

// 富 mock：记录 save_text_file 调用，dialog save 返回临时路径。
function invoke(cmd, args) {
  window.__calls = window.__calls || [];
  let result = {};
  if (cmd === "read_text_file") {
    const p = (args && args.path) || "";
    const MD = "# Hello\n\nSome **bold** and `code`.\n\n- a\n- b\n";
    result = { text: p.indexOf("note.md") >= 0 ? MD : "", encoding: "utf-8", line_endings: "lf", is_binary: false, truncated: false, size: p.indexOf("note.md") >= 0 ? MD.length : 0 };
  } else if (cmd === "save_text_file") {
    window.__lastSave = args;
  } else if (typeof cmd === "string" && cmd.endsWith("|save")) {
    result = "/tmp/uec_verify_export_" + ((window.__saveIdx = (window.__saveIdx || 0) + 1));
  } else if (cmd === "home_dir") {
    result = "/tmp";
  } else if (cmd === "list_dir") {
    result = [];
  } else if (cmd === "read_dir") {
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

  // 打开 .md 文件（此时为原始 Markdown 内容）
  await page.evaluate(() => window.__app.openFile("/tmp/note.md"));
  await page.waitForTimeout(300);

  const setEditor = (text) => page.evaluate((t) => {
    const v = window.__app.view;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
    v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
  }, text);
  const getEditor = () => page.evaluate(() => window.__app.view.state.doc.toString());
  const cleanModals = () => page.evaluate(() => document.querySelectorAll(".modal-mask").forEach((m) => m.remove()));

  // A) 语法高亮（原始 Markdown 内容下，编辑器内存在带 class 的 token span）
  const hi = await page.evaluate(() => {
    const c = document.querySelector(".cm-content");
    return !!c && !!c.querySelector("span[class]");
  });
  hi ? ok("Markdown 语法高亮生效") : fail("未检测到 Markdown 语法高亮");

  // B) Markdown 导出（基于原始内容）
  await page.evaluate(() => window.__app.exportMarkdown());
  await page.waitForTimeout(300);
  const md = await page.evaluate(() => window.__lastSave);
  if (md && /<h1[^>]*>Hello<\/h1>/.test(md.text) && /<strong>bold<\/strong>/.test(md.text)) ok("Markdown 导出含渲染后的 HTML");
  else fail("Markdown 导出内容异常: " + (md ? md.text.slice(0, 120) : "无"));
  await cleanModals();

  // C) Word 导出（基于原始内容）
  await page.evaluate(() => window.__app.exportWord());
  await page.waitForTimeout(300);
  const wd = await page.evaluate(() => window.__lastSave);
  if (wd && /ProgId/.test(wd.text) && /Word\.Document/.test(wd.text) && /<h1[^>]*>Hello<\/h1>/.test(wd.text)) ok("Word 导出含 Word 兼容标记与渲染内容");
  else fail("Word 导出内容异常: " + (wd ? wd.text.slice(0, 120) : "无"));
  await cleanModals();

  // 打开文本转换对话框（工具 → 文本转换…）
  await page.locator('#menubar .menu-item', { hasText: "工具" }).click();
  await page.waitForTimeout(150);
  await page.locator('.menu-item-drop', { hasText: "文本转换…" }).click();
  await page.waitForSelector('.modal [data-act="cup"]');
  ok("文本转换对话框已打开");

  const clickAct = async (act) => {
    await page.locator(`.modal [data-act="${act}"]`).click();
    await page.waitForTimeout(120);
  };

  // 1) 大写
  await setEditor("hello world");
  await clickAct("cup");
  eq(await getEditor(), "HELLO WORLD", "大写");

  // 2) 去重行
  await setEditor("a\nb\na");
  await clickAct("dedup");
  eq(await getEditor(), "a\nb", "去重行");

  // 3) 全角 → 半角
  await setEditor("ＡＢＣ１２３");
  await clickAct("fw2hw");
  eq(await getEditor(), "ABC123", "全角→半角");

  // 4) Base64 编码
  await setEditor("Hello");
  await clickAct("b64e");
  eq(await getEditor(), "SGVsbG8=", "Base64 编码");

  // 5) URL 编码
  await setEditor("a b");
  await clickAct("urle");
  eq(await getEditor(), "a%20b", "URL 编码");

  await cleanModals();

  // 9) 预览状态持久化：开启后写入 uec.preview，重启自动恢复
  await page.evaluate(() => window.__app.togglePreview());
  await page.waitForTimeout(200);
  const pvOn = await page.evaluate(() => !document.getElementById("preview-panel").classList.contains("hidden") && localStorage.getItem("uec.preview") === "1");
  pvOn ? ok("预览已开启并写入 uec.preview") : fail("预览持久化写入失败");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const pvRestored = await page.evaluate(() => !document.getElementById("preview-panel").classList.contains("hidden"));
  pvRestored ? ok("重启后自动恢复预览") : fail("重启后未恢复预览");

  // 10) 自动换行持久化：开启后写入 uec.wrap，重启保留
  await page.evaluate(() => window.__app.toggleWrap());
  await page.waitForTimeout(150);
  const wrapStored = await page.evaluate(() => localStorage.getItem("uec.wrap"));
  eq(wrapStored, "1", "换行持久化写入");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const wrapRestored = await page.evaluate(() => window.__app.prefWrap === true);
  wrapRestored ? ok("重启后换行偏好保留") : fail("重启后换行偏好丢失");

  // 11) 设置对话框开关 自动换行 / 预览默认，并持久化
  await page.locator('#menubar .menu-item', { hasText: "视图" }).click();
  await page.waitForTimeout(120);
  await page.locator('.menu-item-drop', { hasText: "设置…" }).click();
  await page.waitForSelector('#set-wrap');
  await page.evaluate(() => {
    const w = document.querySelector('#set-wrap');
    w.checked = !w.checked;
    const pv = document.querySelector('#set-pv');
    pv.checked = !pv.checked;
  });
  await page.locator('.modal [data-ok]').click();
  await page.waitForTimeout(150);
  const sw = await page.evaluate(() => ({ wrap: localStorage.getItem('uec.wrap'), pv: localStorage.getItem('uec.preview') }));
  eq(sw.wrap, "0", "设置关闭换行已持久化");
  eq(sw.pv, "0", "设置关闭预览默认已持久化");

  // 12) 空状态显示最近文件，点击可重新打开
  await page.evaluate(async () => { let a; while ((a = window.__app.active)) { await window.__app.closeTab(a.id); } });
  await page.waitForTimeout(250);
  const recentVisible = await page.evaluate(() => {
    const box = document.getElementById("empty-recent");
    return !!box && !box.classList.contains("hidden") && box.querySelectorAll('[data-action="open-recent"]').length > 0;
  });
  recentVisible ? ok("空状态显示最近文件") : fail("空状态未显示最近文件");
  await page.locator('#empty-recent [data-action="open-recent"]').first().click();
  await page.waitForTimeout(250);
  const reopened = await page.evaluate(() => (window.__app.active && window.__app.active.path) || "");
  reopened ? ok("点击最近文件可重新打开: " + reopened) : fail("点击最近文件未打开");

  if (errors.length) fail("运行期报错: " + errors.join(" | "));
  else ok("无运行期报错");

  await browser.close();
  console.log(failures === 0 ? "\nPASS ✅ 功能验证通过" : `\nFAIL ❌ ${failures} 项未通过`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("验证运行异常:", e);
  process.exit(2);
});
