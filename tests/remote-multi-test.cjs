const { chromium } = require("playwright");
const fs = require("fs");
const URL = "http://localhost:1420/";
function resolveChrome() {
  let exe;
  try { exe = chromium.executablePath(); } catch (_) { exe = undefined; }
  if (exe && fs.existsSync(exe)) return exe;
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const fb = "/Users/hp/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  return fs.existsSync(fb) ? fb : undefined;
}
function invoke(cmd, args) {
  window.__calls = window.__calls || [];
  window.__calls.push({ cmd, args });
  let result = {};
  if (cmd === "ftp_connect") result = "conn1";
  else if (cmd === "ftp_list") {
    result = { pwd: "/", entries: [
      { name: "a.txt", is_dir: false, size: 10 },
      { name: "b.txt", is_dir: false, size: 20 },
      { name: "sub", is_dir: true, size: 0 },
    ]};
  } else if (cmd === "ftp_copy") result = args.destDir + "/x";
  else if (cmd === "ftp_delete") result = true;
  else if (cmd === "plugin:event|listen") result = { id: "evt" };
  else if (cmd === "plugin:dialog|open") result = "/tmp";
  return Promise.resolve(result);
}
let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const fail = (m) => { failures++; console.log("  ✗ " + m); };
const has = (v, n) => (v ? ok(n) : fail(n));
(async () => {
  const exe = resolveChrome();
  const launchOpts = { args: ["--no-sandbox"] };
  if (exe) launchOpts.executablePath = exe;
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((inv) => {
    window.__TAURI_INTERNALS__ = { invoke: (c, a) => eval("(" + inv + ")")(c, a), transformCallback: () => (window.__cbs = window.__cbs || []).length + 1000 };
  }, invoke.toString());
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.setItem("uec.lang", "zh-CN");
    localStorage.setItem("uec.remotes", JSON.stringify([{
      id: "site1", name: "Test FTP", proto: "ftp", host: "127.0.0.1", port: 21,
      username: "u", password: "p", savePassword: true, authMethod: "password",
      keyPath: "", passphrase: "", remoteDir: "/",
    }]));
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#menubar .menu-item");
  await page.waitForTimeout(300);
  await page.locator('.sb-tab[data-sb="remote"]').click();
  await page.waitForTimeout(400);
  await page.locator('#remote-panel [data-op="connect"]').first().click();
  await page.waitForTimeout(600);
  has(await page.locator('#ftp-tree [data-name="a.txt"]').count() > 0, "远程树渲染 a.txt");
  // 单击 a.txt → ⌘+单击 b.txt 加选
  await page.locator('#ftp-tree [data-name="a.txt"]').click();
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    const n = document.querySelector('#ftp-tree [data-name="b.txt"]');
    n.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
  });
  await page.waitForTimeout(120);
  const selSize = await page.evaluate(() => window.__app.remote.cur.selectedPaths.size);
  has(selSize === 2, `⌘加选 selectedPaths=2（实际 ${selSize}）`);
  const hl = await page.locator('#ftp-tree [data-name].ft-selected').count();
  has(hl === 2, "远程高亮 2 个节点");
  // Shift 范围选：点 a.txt 后再 Shift+点 sub → 3 个
  await page.locator('#ftp-tree [data-name="sub"]').click();
  await page.waitForTimeout(80);
  await page.evaluate(() => {
    const n = document.querySelector('#ftp-tree [data-name="b.txt"]');
    n.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  });
  await page.waitForTimeout(120);
  const rangeSize = await page.evaluate(() => window.__app.remote.cur.selectedPaths.size);
  has(rangeSize === 3, `Shift 范围选=3（实际 ${rangeSize}）`);
  // 右键 a.txt（多选内）→ open 置灰
  await page.evaluate(() => {
    const n = document.querySelector('#ftp-tree [data-name="a.txt"]');
    n.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 120 }));
  });
  await page.waitForTimeout(160);
  const openDisabled = await page.evaluate(() => window.__app.remote.el.querySelector('#ftp-ctx [data-act="open"]')?.classList.contains("ctx-disabled"));
  has(!!openDisabled, "多选菜单 open 置灰");
  // 复制 → srcs 2
  await page.evaluate(() => { const it = window.__app.remote.el.querySelector('#ftp-ctx [data-act="copy"]'); it && it.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await page.waitForTimeout(200);
  const cb = await page.evaluate(() => { const c = window.__app.remote.clipboard; return c ? c.srcs.length : 0; });
  has(cb === 3, `复制 srcs=3（实际 ${cb}）`);
  // 空白右键粘贴 → ftp_copy 调 2 次
  await page.evaluate(() => {
    const tree = document.querySelector('#ftp-tree');
    tree.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 30 }));
  });
  await page.waitForTimeout(160);
  await page.evaluate(() => { const it = window.__app.remote.el.querySelector('#ftp-ctx [data-act="paste"]'); it && it.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await page.waitForTimeout(300);
  const copies = await page.evaluate(() => window.__calls.filter(c => c.cmd === "ftp_copy").length);
  has(copies === 3, `粘贴 ftp_copy 调 3 次（实际 ${copies}）`);
  // 多选删除：重新 ⌘加选 sub+a → 右键 sub（多选内）→ 确认 N 项 → ftp_delete 2 次
  await page.locator('#ftp-tree [data-name="sub"]').click();
  await page.waitForTimeout(80);
  await page.evaluate(() => {
    const n = document.querySelector('#ftp-tree [data-name="a.txt"]');
    n.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
  });
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    const n = document.querySelector('#ftp-tree [data-name="sub"]');
    n.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 120 }));
  });
  await page.waitForTimeout(160);
  await page.evaluate(() => { const it = window.__app.remote.el.querySelector('#ftp-ctx [data-act="del"]'); it && it.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await page.waitForTimeout(250);
  const delMsg = await page.evaluate(() => document.querySelector(".modal-body")?.textContent || "");
  has(delMsg.includes("2"), `删除确认含 N 项（${JSON.stringify(delMsg)}）`);
  await page.evaluate(() => { const b = document.querySelector(".modal-actions button"); b && b.click(); });
  await page.waitForTimeout(400);
  const dels = await page.evaluate(() => window.__calls.filter(c => c.cmd === "ftp_delete").length);
  has(dels === 2, `ftp_delete 调 2 次（实际 ${dels}）`);
  const realErrors = errors.filter((e) => !e.includes("favicon"));
  // Ctrl+单击（macOS 左键 contextmenu）不应弹菜单
  await page.evaluate(() => {
    const n = document.querySelector('#ftp-tree [data-name="a.txt"]');
    n.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 0, detail: 1, ctrlKey: true }));
    n.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 0, detail: 0, ctrlKey: true }));
  });
  await page.waitForTimeout(120);
  const noCtx = await page.evaluate(() => window.__app.remote.el.querySelector('#ftp-ctx').classList.contains("hidden"));
  has(noCtx, "远程 Ctrl+单击不弹菜单");
  // 真右键仍弹
  await page.evaluate(() => {
    const n = document.querySelector('#ftp-tree [data-name="a.txt"]');
    n.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, detail: 1, clientX: 90, clientY: 90 }));
  });
  await page.waitForTimeout(120);
  const hasCtx = await page.evaluate(() => !window.__app.remote.el.querySelector('#ftp-ctx').classList.contains("hidden"));
  has(hasCtx, "远程真右键弹菜单");
  has(realErrors.length === 0, "无运行期报错");
  await browser.close();
  if (failures === 0) console.log("PASS ✅ 远程多选验证通过");
  else { console.log(`FAIL ❌ ${failures} 项未通过`); process.exit(1); }
})();
