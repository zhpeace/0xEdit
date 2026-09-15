const { chromium } = require("playwright");
const fs = require("fs");
const URL = "http://localhost:1420/";
function resolveChrome() {
  let exe;
  try { exe = chromium.executablePath(); } catch (_) { exe = undefined; }
  const fb = "/Users/hp/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  return fs.existsSync(fb) ? fb : undefined;
}
function invoke(cmd, args) {
  if (cmd === "list_dir") return Promise.resolve({ pwd: args.path, entries: [] });
  if (cmd === "list_drives") return Promise.resolve(["C:\\", "D:\\", "E:\\"]);
  if (cmd === "home_dir") return Promise.resolve("C:\\Users\\test");
  return Promise.resolve({});
}
(async () => {
  const exe = resolveChrome();
  const browser = await chromium.launch({ args: ["--no-sandbox"], ...(exe ? { executablePath: exe } : {}) });
  const context = await browser.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" });
  const page = await context.newPage();
  await page.addInitScript((inv) => {
    window.__TAURI_INTERNALS__ = { invoke: (c, a) => eval("(" + inv + ")")(c, a), transformCallback: () => 1 };
  }, invoke.toString());
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector("#menubar .menu-item");
  await page.evaluate(() => {
    const tab = document.querySelector('.sb-tab[data-sb="local"]');
    if (tab) tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const driveBtn = await page.evaluate(() => !!document.querySelector("#sb-drive-local"));
  console.log("drive button visible:", driveBtn);
  const cur = await page.evaluate(() => document.querySelector("#ft-path")?.textContent || "");
  console.log("pathbar:", cur.slice(0, 60));
  // 点击盘符按钮 → 浮层
  await page.evaluate(() => {
    document.querySelector("#sb-drive-local").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const items = await page.evaluate(() => {
    const pop = document.querySelector("#sb-drive-pop");
    return pop ? [...pop.querySelectorAll(".ctx-item")].map((x) => ({ d: x.dataset.drive, on: x.classList.contains("on") })) : "NO_POP";
  });
  console.log("pop items:", JSON.stringify(items));
  // 点 D:\ 切换
  await page.evaluate(() => {
    const item = [...document.querySelectorAll("#sb-drive-pop .ctx-item")].find((x) => x.dataset.drive === "D:\\");
    item && item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => {
    const pop = document.querySelector("#sb-drive-pop");
    const p = document.querySelector("#ft-path");
    return { popGone: !pop, pathbar: p ? p.textContent.slice(0, 30) : "" };
  });
  console.log("after switch:", JSON.stringify(after));
  await browser.close();
})();
