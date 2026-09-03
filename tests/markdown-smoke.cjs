// Markdown 实时预览冒烟测试：打开 .md 文件 → 开启预览 → 渲染正确 → 编辑实时刷新 → 关闭。
// 依赖本地 dev server（npm run dev，默认 http://localhost:1420）。
// 用法： node tests/markdown-smoke.cjs
const { chromium } = require("playwright");
const fs = require("fs");

const URL = process.env.MD_URL || "http://localhost:1420/";

function resolveChrome() {
  let exe;
  try {
    exe = chromium.executablePath();
  } catch (_) {
    exe = undefined;
  }
  if (exe && fs.existsSync(exe)) return exe;
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const fallback =
    "/Users/hp/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  return fs.existsSync(fallback) ? fallback : undefined;
}

function invoke(cmd, args) {
  const MD = "# Hello\n\nSome **bold** text and `code`.\n\n- a\n- b\n";
  if (cmd === "read_text_file") {
    const p = (args && args.path) || "";
    if (p.indexOf("note.md") >= 0) {
      return Promise.resolve({ text: MD, encoding: "utf-8", line_endings: "lf", is_binary: false, truncated: false, size: MD.length });
    }
    return Promise.resolve({ text: "", encoding: "utf-8", line_endings: "lf", is_binary: false, truncated: false, size: 0 });
  }
  return Promise.resolve({});
}

let failures = 0;
const fail = (m) => { failures++; console.log("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);

(async () => {
  const exe = resolveChrome();
  const launchOpts = { args: ["--no-sandbox"] };
  if (exe) launchOpts.executablePath = exe;
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.addInitScript(
    (inv) => {
      window.__TAURI_INTERNALS__ = { invoke: (c, a) => eval("(" + inv + ")")(c, a) };
    },
    invoke.toString()
  );

  console.log("markdown preview smoke test → " + URL);
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("uec.lang", "en-US"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#menubar .menu-item");
  await page.waitForTimeout(400);
  await page.locator('.modal-mask [data-act="ignore"]').click().catch(() => {});
  await page.waitForTimeout(200);

  // 1) 打开一个 .md 文件
  const diag = await page.evaluate(async () => {
    try {
      await window.__app.openFile("/tmp/note.md");
      const a = window.__app.active;
      return {
        ok: true,
        path: a ? a.path : null,
        docs: window.__app.docs ? window.__app.docs.size : -1,
        modal: !!document.querySelector(".modal-mask"),
        modalText: document.querySelector(".modal-mask") ? document.querySelector(".modal-mask").innerText.slice(0, 80) : "",
      };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  });
  if (!diag.ok) console.log("  openFile 诊断: " + JSON.stringify(diag));
  else console.log("  openFile 诊断: " + JSON.stringify(diag));
  await page.waitForSelector("#main-panel .cm-editor");
  await page.waitForTimeout(300);
  const path = await page.evaluate(() => (window.__app.active ? window.__app.active.path : null));
  if (path === "/tmp/note.md") ok("已打开 .md 文件");
  else fail("打开 .md 失败: " + path);

  // 清掉任何可能遮挡的弹窗
  await page.evaluate(() => document.querySelectorAll(".modal-mask").forEach((m) => m.remove()));
  await page.waitForTimeout(100);

  // 2) 开启 Markdown 预览（直接驱动应用方法，避免菜单点击的脆弱性）
  const menuInfo = await page.evaluate(() => {
    const labels = [...document.querySelectorAll("#menubar .menu-item")].map((e) => e.textContent);
    return labels;
  });
  console.log("  menubar: " + menuInfo.join(" | "));
  await page.evaluate(() => window.__app.togglePreview());
  await page.waitForSelector("#preview-panel:not(.hidden) #pv-body");
  await page.waitForSelector("#preview-panel:not(.hidden) #pv-body");
  await page.waitForTimeout(200);

  const body = await page.locator("#pv-body").innerHTML();
  if (/<h1[^>]*>Hello<\/h1>/.test(body)) ok("预览渲染了标题");
  else fail("预览未渲染标题: " + body.slice(0, 120));
  if (/<strong>bold<\/strong>/.test(body)) ok("预览渲染了加粗");
  else fail("预览未渲染加粗");
  if (/<li>a<\/li>/.test(body)) ok("预览渲染了列表");
  else fail("预览未渲染列表");

  // 3) 预览面板本地化（英文、无 CJK）
  const pvText = await page.locator("#preview-panel").innerText();
  const cjk = pvText.match(/[一-鿿　-〿＀-￯]/);
  if (cjk) fail("预览面板出现 CJK: " + cjk[0]);
  else ok("预览面板无 CJK 字符");

  // 4) 编辑后实时刷新
  await page.evaluate(() => {
    const v = window.__app.view;
    v.dispatch({ changes: { from: 0, insert: "# Added Heading\n\n" } });
  });
  await page.waitForTimeout(400);
  const body2 = await page.locator("#pv-body").innerHTML();
  if (/Added Heading/.test(body2)) ok("编辑后预览实时刷新");
  else fail("编辑后预览未刷新: " + body2.slice(0, 160));

  // 5) 关闭预览（再次切换）
  await page.evaluate(() => window.__app.togglePreview());
  await page.waitForTimeout(200);
  const hidden = await page.locator("#preview-panel").evaluate((el) => el.classList.contains("hidden"));
  if (hidden) ok("可关闭预览");
  else fail("预览未关闭");

  // 6) 文件菜单含 Markdown / Word 导出项
  const items = await page.evaluate(() => window.__app.menuData["文件"]().map((x) => (Array.isArray(x) ? x[0] : "")));
  const hasMd = items.includes("导出 Markdown（HTML/PDF）");
  const hasWord = items.includes("导出为 Word（.doc）");
  if (hasMd) ok("文件菜单含 Markdown 导出项");
  else fail("文件菜单缺少 Markdown 导出项");
  if (hasWord) ok("文件菜单含 Word 导出项");
  else fail("文件菜单缺少 Word 导出项");

  // 7) Markdown 语法高亮生效（编辑器内出现带 class 的 token span）
  const hasHi = await page.evaluate(() => {
    const c = document.querySelector(".cm-content");
    if (!c) return false;
    return !!c.querySelector("span[class]");
  });
  if (hasHi) ok("Markdown 语法高亮生效");
  else fail("未检测到 Markdown 语法高亮");

  if (errors.length) fail("运行期报错: " + errors.join(" | "));
  else ok("无运行期报错");

  await browser.close();
  console.log(failures === 0 ? "\nPASS ✅ Markdown 预览冒烟测试通过" : `\nFAIL ❌ ${failures} 项未通过`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("测试运行异常:", e);
  process.exit(2);
});
