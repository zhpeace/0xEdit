// 目录比较「内联合并编辑」冒烟测试：
//   在无头浏览器中走通 目录比较 → 双击差异文件 → 合并窗口 → 用右侧填充 → 保存到两侧 的完整流程。
//   依赖本地 dev server 已在运行（npm run dev，默认 http://localhost:1420）。
//
// 用法： node tests/merge-smoke.cjs            （断言模式，失败 exit 1）
//        CHROME_PATH=/path node tests/merge-smoke.cjs

const { chromium } = require("playwright");
const fs = require("fs");

const URL = process.env.MERGE_URL || "http://localhost:1420/";

function resolveChrome() {
  let exe;
  try {
    exe = chromium.executablePath();
  } catch (_) {
    exe = undefined;
  }
  if (exe && fs.existsSync(exe)) return exe;
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const fallback =
    "/Users/hp/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  return fs.existsSync(fallback) ? fallback : undefined;
}

// 注意：此函数会被序列化为字符串注入页面，不能引用外部作用域变量；状态都挂到 window 上。
function invoke(cmd, args) {
  const w = window;
  w.__dlg = w.__dlg || { n: 0 };
  if (cmd === "plugin:dialog|open") {
    w.__dlg.n++;
    return Promise.resolve(w.__dlg.n === 1 ? "/tmp/left" : "/tmp/right");
  }
  if (cmd === "compare_dirs") {
    return Promise.resolve([
      { rel: "a.txt", exists_left: true, exists_right: true, is_dir: false, size_left: 14, size_right: 13, modified_left: 0, modified_right: 0, same: false },
      { rel: "same.txt", exists_left: true, exists_right: true, is_dir: false, size_left: 1, size_right: 1, modified_left: 0, modified_right: 0, same: true },
    ]);
  }
  if (cmd === "read_text_file") {
    const isLeft = (args && args.path ? args.path : "").indexOf("left") >= 0;
    return Promise.resolve(
      isLeft
        ? { text: "LEFT CONTENT\nline2", encoding: "utf-8", line_endings: "lf", is_binary: false, truncated: false, size: 14 }
        : { text: "RIGHT CONTENT", encoding: "utf-8", line_endings: "lf", is_binary: false, truncated: false, size: 13 }
    );
  }
  if (cmd === "save_text_file") {
    w.__saves = w.__saves || [];
    w.__saves.push({ path: args.path, text: args.text });
    return Promise.resolve({});
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

  console.log("merge smoke test → " + URL);
  await page.goto(URL, { waitUntil: "networkidle" });
  // 固定英文，便于断言合并窗口本地化且无 CJK。
  await page.evaluate(() => localStorage.setItem("uec.lang", "en-US"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#menubar .menu-item");
  await page.waitForTimeout(400);
  await page.locator('.modal-mask [data-act="ignore"]').click().catch(() => {});
  await page.waitForTimeout(200);

  // 1) 打开目录比较（工具 → Compare / Sync Folders…）
  await page.locator('#menubar .menu-item', { hasText: "Tools" }).click();
  await page.locator('.dropdown-menu .menu-item-drop', { hasText: "Compare / Sync Folders" }).click();
  await page.waitForSelector(".modal.dircmp .dc-row");
  await page.waitForTimeout(200);

  const rowCount = await page.locator(".dc-row").count();
  if (rowCount >= 1) ok(`目录比较已渲染差异行（${rowCount} 行，相同文件已隐藏）`);
  else fail("目录比较未渲染差异行");

  // 2) 双击差异文件行 → 打开合并窗口
  await page.locator(".dc-row").first().dblclick();
  await page.waitForSelector("#m-left");
  await page.waitForTimeout(200);

  const leftVal = await page.inputValue("#m-left");
  const rightVal = await page.inputValue("#m-right");
  if (leftVal === "LEFT CONTENT\nline2") ok("左栏加载正确内容");
  else fail("左栏内容错误: " + JSON.stringify(leftVal));
  if (rightVal === "RIGHT CONTENT") ok("右栏加载正确内容");
  else fail("右栏内容错误: " + JSON.stringify(rightVal));

  // 3) 合并窗口本地化（英文、无 CJK）
  const modalText = await page.locator(".modal.merge-modal").innerText();
  if (/Merge:|Left \(read-only\)|Right \(read-only\)|Merged result|Save to both/.test(modalText)) ok("合并窗口英文标签已生效");
  else fail("合并窗口英文标签缺失: " + modalText.slice(0, 120));
  const cjk = modalText.match(/[一-鿿　-〿＀-￯]/);
  if (cjk) fail("合并窗口出现 CJK 字符: " + cjk[0]);
  else ok("合并窗口无 CJK 字符");

  // 4) 用右侧填充 → 合并结果应为右栏内容
  await page.locator("#m-use-right").click();
  const merged = await page.inputValue("#m-merged");
  if (merged === rightVal) ok("用右侧填充后合并结果正确");
  else fail("用右侧填充结果错误: " + JSON.stringify(merged));

  // 5) 保存到两侧 → 触发两次 save_text_file
  await page.locator("#m-save-both").click();
  await page.waitForTimeout(300);
  const saves = await page.evaluate(() => window.__saves || []);
  if (saves.length === 2) ok("保存到两侧触发 2 次写入");
  else fail("保存次数异常: " + saves.length);
  const paths = saves.map((s) => s.path).join("|");
  if (paths.indexOf("left") >= 0 && paths.indexOf("right") >= 0) ok("写入路径分别命中左/右目录");
  else fail("写入路径未覆盖两侧: " + paths);
  if (saves.every((s) => s.text === rightVal)) ok("写入内容为合并结果");
  else fail("写入内容错误: " + JSON.stringify(saves));

  const statusText = await page.locator(".modal.merge-modal #m-status").innerText();
  if (/Saved to both sides/.test(statusText)) ok("状态提示「已保存到两侧」");
  else fail("状态提示异常: " + statusText);

  if (errors.length) fail("运行期报错: " + errors.join(" | "));
  else ok("无运行期报错");

  await browser.close();
  console.log(failures === 0 ? "\nPASS ✅ 合并编辑冒烟测试通过" : `\nFAIL ❌ ${failures} 项未通过`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("测试运行异常:", e);
  process.exit(2);
});
