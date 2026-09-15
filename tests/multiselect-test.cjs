const { chromium } = require("playwright");
const fs = require("fs");
const URL = "http://localhost:1420/";
function resolveChrome() {
  let exe;
  try { exe = chromium.executablePath(); } catch (_) { exe = undefined; }
  if (exe && fs.existsSync(exe)) return exe;
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const fallback = "/Users/hp/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  return fs.existsSync(fallback) ? fallback : undefined;
}
function invoke(cmd, args) {
  window.__calls = window.__calls || [];
  window.__calls.push({ cmd, args });
  let result = {};
  if (cmd === "home_dir") result = "/tmp";
  else if (cmd === "list_dir" || cmd === "read_dir") {
    const p = (args && args.path) || "";
    if (p === "/tmp" || p === "") result = [
      { name: "a.txt", path: "/tmp/a.txt", is_dir: false, size: 10, modified: 1700000000 },
      { name: "b.txt", path: "/tmp/b.txt", is_dir: false, size: 20, modified: 1700000000 },
      { name: "sub", path: "/tmp/sub", is_dir: true, size: 0, modified: 1700000000 },
    ];
    else if (p === "/tmp/sub") result = [{ name: "c.txt", path: "/tmp/sub/c.txt", is_dir: false, size: 5, modified: 1700000000 }];
    else result = [];
  } else if (cmd === "path_is_dir") result = true;
  else if (cmd === "delete_local") result = true;
  else if (cmd === "copy_to") result = "/tmp/sub/a.txt";
  else if (cmd === "create_archive") result = "/tmp/test.zip";
  else if (cmd === "plugin:event|listen") result = { id: "evt1" };
  return Promise.resolve(result);
}
(async () => {
  const exe = resolveChrome();
  const launchOpts = { args: ["--no-sandbox"] };
  if (exe) launchOpts.executablePath = exe;
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await page.addInitScript((inv) => {
    window.__TAURI_INTERNALS__ = { invoke: (c, a) => eval("(" + inv + ")")(c, a), transformCallback: (cb) => (window.__cbs = window.__cbs || []).push(cb) + 1000 };
  }, invoke.toString());
  const ctx = async (sel) => { await page.evaluate((s) => { const n = document.querySelector(s); if (!n) return; n.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 140 })); }, sel); await page.waitForTimeout(160); };
  const act = async (a) => { await page.evaluate((x) => { const it = window.__app.tree.ctx.querySelector(`[data-act="${x}"]`); if (it) it.dispatchEvent(new MouseEvent("click", { bubbles: true })); }, a); await page.waitForTimeout(200); };
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("uec.lang", "zh-CN"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#menubar .menu-item");
  await page.waitForTimeout(400);
  console.log("树节点数:", await page.locator(".ft-node").count(), "✓");
  await page.locator('.ft-node[data-path="/tmp/a.txt"]').click();
  await page.waitForTimeout(120);
  await page.locator('.ft-node[data-path="/tmp/b.txt"]').click({ modifiers: ["Meta"] });
  await page.waitForTimeout(120);
  console.log("⌘加选 selectedPaths:", await page.evaluate(() => window.__app.tree.selectedPaths.size), "✓");
  console.log("高亮数:", await page.locator(".ft-node.ft-selected").count(), "✓");
  await ctx('.ft-node[data-path="/tmp/b.txt"]');
  console.log("右键后 selectedPaths:", await page.evaluate(() => [...window.__app.tree.selectedPaths]));
  console.log("菜单hidden:", await page.evaluate(() => window.__app.tree.ctx.classList.contains("hidden")), "| ctxPath:", await page.evaluate(() => window.__app.tree.ctxPath), "| 代码新:", await page.evaluate(() => window.__app.tree.constructor.prototype.onCtx.toString().includes("selectedPaths.size > 1")));
  console.log("多选菜单 open置灰:", await page.evaluate(() => window.__app.tree.ctx.querySelector('[data-act="open"]')?.classList.contains("ctx-disabled")), "| 压缩可见:", await page.evaluate(() => !window.__app.tree.ctx.querySelector('[data-act="archive-zip"]')?.classList.contains("hidden")));
  console.log("eff:", await page.evaluate(() => window.__app.tree.effectivePaths()));
  await act("copy");
  console.log("copy后 ctxPath:", await page.evaluate(() => window.__app.tree.ctxPath), "| sel:", await page.evaluate(() => window.__app.tree.selectedPaths.size));
  const cb = await page.evaluate(() => { const c = window.__app.tree.clipboard; return c ? { n: c.paths.length, name: c.name } : null; });
  console.log("复制多选:", JSON.stringify(cb), cb && cb.n === 2 ? "✓" : "✗");
  await page.locator('.ft-node[data-path="/tmp/sub"]').dblclick();
  await page.waitForTimeout(400);
  await ctx(".ft-tree");
  console.log("空白菜单hidden:", await page.evaluate(() => window.__app.tree.ctx.classList.contains("hidden")));
  await act("paste");
  console.log("粘贴 copy_to 调用数:", await page.evaluate(() => window.__calls.filter(c => c.cmd === "copy_to").length), "✓");
  await page.evaluate(() => window.__app.tree.enterDir("/tmp"));
  await page.waitForTimeout(300);
  await ctx('.ft-node[data-path="/tmp/a.txt"]');
  await act("archive-zip");
  await page.fill("#ft-name-input", "mytest");
  await page.click("#ft-name-ok");
  await page.waitForTimeout(300);
  const arc = await page.evaluate(() => window.__calls.find(c => c.cmd === "create_archive"));
  console.log("压缩ZIP调用:", JSON.stringify(arc && arc.args), arc && arc.args.format === "zip" && arc.args.name === "mytest" && arc.args.items.length === 1 ? "✓" : "✗");
  // 单选 tar.gz
  await ctx('.ft-node[data-path="/tmp/a.txt"]');
  await act("archive-targz");
  await page.fill("#ft-name-input", "mytgz");
  await page.click("#ft-name-ok");
  await page.waitForTimeout(300);
  const arc2 = await page.evaluate(() => window.__calls.find(c => c.cmd === "create_archive" && c.args.format === "tar.gz"));
  console.log("压缩TGZ调用:", JSON.stringify(arc2 && arc2.args), arc2 && arc2.args.name === "mytgz" ? "✓" : "✗");
  // Shift 范围选：单选 sub（目录排前）→ Shift+点 b.txt → 3 个
  await page.locator('.ft-node[data-path="/tmp/sub"]').click();
  await page.waitForTimeout(80);
  await page.evaluate(() => {
    const n = document.querySelector('.ft-node[data-path="/tmp/b.txt"]');
    n.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  });
  await page.waitForTimeout(120);
  const rangeSel = await page.evaluate(() => window.__app.tree.selectedPaths.size);
  console.log("本地Shift范围选:", rangeSel, rangeSel === 3 ? "✓" : "✗");
  // Ctrl+单击（macOS 左键 contextmenu）不应弹菜单
  await page.evaluate(() => {
    const n = document.querySelector('.ft-node[data-path="/tmp/a.txt"]');
    n.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 0, detail: 1, ctrlKey: true }));
    n.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 0, detail: 0, ctrlKey: true }));
  });
  await page.waitForTimeout(120);
  const noCtx = await page.evaluate(() => window.__app.tree.ctx.classList.contains("hidden"));
  console.log("Ctrl+单击不弹菜单:", noCtx ? "✓" : "✗");
  // 真右键仍弹
  await page.evaluate(() => {
    const n = document.querySelector('.ft-node[data-path="/tmp/a.txt"]');
    n.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, detail: 1, clientX: 90, clientY: 90 }));
  });
  await page.waitForTimeout(120);
  const hasCtx = await page.evaluate(() => !window.__app.tree.ctx.classList.contains("hidden"));
  console.log("真右键弹菜单:", hasCtx ? "✓" : "✗");
  await page.evaluate(() => window.__app.tree.ctx.classList.add("hidden"));
  await page.locator('.ft-node[data-path="/tmp/a.txt"]').click();
  await page.locator('.ft-node[data-path="/tmp/b.txt"]').click({ modifiers: ["Meta"] });
  await page.waitForTimeout(100);
  await ctx('.ft-node[data-path="/tmp/b.txt"]');
  await act("del");
  const delMsg = await page.evaluate(() => document.querySelector(".modal-body")?.textContent || "");
  console.log("多选删除确认:", JSON.stringify(delMsg), delMsg.includes("2") ? "✓" : "✗");
  await page.evaluate(() => { const btn = document.querySelector("#ft-name-ok") || document.querySelector(".modal-actions button"); if (btn) btn.click(); });
  await page.waitForTimeout(300);
  console.log("删除调用数:", await page.evaluate(() => window.__calls.filter(c => c.cmd === "delete_local").length), "✓");
  await browser.close();
})();
