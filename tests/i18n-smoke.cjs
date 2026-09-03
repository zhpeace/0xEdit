// 三语 i18n 冒烟测试：在无头浏览器中加载应用，验证：
//   1) 英文界面不含任何中文字符（除白名单符号外）；
//   2) 英文 / 日文界面下，不出现任何「仅中文」标记串（说明漏翻回退到中文）；
//   3) 语言切换真正生效（英文出现 File，日文出现 ファイル / 編集）。
//
// 运行前需先启动 dev server：npm run dev （默认 http://localhost:1420）
// 用法： node tests/i18n-smoke.cjs            （断言模式，失败 exit 1）
//        CHROME_PATH=/path node tests/i18n-smoke.cjs
//
// 注意：本测试依赖本地 dev server 已在运行，不负责启动它。

const { chromium } = require("playwright");
const fs = require("fs");

const URL = process.env.I18N_URL || "http://localhost:1420/";

// 解析 Chromium 路径：优先 playwright 默认，否则用环境变量或本机缓存路径。
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

// 全角符号（非语言文字，允许出现在任意语言界面）
const ALLOWED = new Set(["＋", "→", "✕", "▦", "▤", "◐", "🔍", "🔁", "💾", "🗀", "🗁", "‹", "▲", "▼", "¶", "·"]);
const CJK = /[一-鿿　-〿＀-￯]/;

// 仅中文才会出现的标记串；若英文/日文界面出现即说明漏翻回退。
const ZH_MARKERS = [
  "无标题", "纯文本", "字符", "文件", "编辑", "查找", "替换", "编码",
  "本地", "大纲", "远程", "撤销", "保存", "新建", "列模式", "语言",
  "关闭", "取消", "生成", "打印", "行号", "跳转", "字节", "单词",
  "拖拽", "折叠", "打开", "选择", "连接", "下载", "上传", "删除",
  "重命名", "读取", "已连接", "失败", "请先", "另存为", "管理账户",
];

const invoke = (cmd) => Promise.resolve({});

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log("  ✗ " + msg);
};
const ok = (msg) => console.log("  ✓ " + msg);

// 通过 localStorage 设定语言后重载——这正好走真实的 detect() 初始化路径，且比点击菜单稳定。
async function switchTo(p, lang) {
  await p.evaluate((l) => localStorage.setItem("uec.lang", l), lang);
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForSelector("#menubar .menu-item");
  await p.waitForTimeout(400);
  await p.locator('.modal-mask [data-act="ignore"]').click().catch(() => {});
  await p.waitForTimeout(200);
}

async function bodyText(p) {
  return (await p.evaluate(() => document.body.innerText || "")) || "";
}

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

  console.log("i18n smoke test → " + URL);
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector("#menubar .menu-item");
  await page.waitForTimeout(400);
  // 关闭首次恢复的弹窗（如存在）
  await page.locator('.modal-mask [data-act="ignore"]').click().catch(() => {});
  await page.waitForTimeout(200);

  // ---- 英文 ----
  await switchTo(page, "en-US");
  const en = await bodyText(page);
  // 1) 严格：英文界面不应有 CJK（白名单除外）
  const enCjk = [];
  en.split("\n").forEach((line) => {
    for (const ch of line) {
      if (CJK.test(ch) && !ALLOWED.has(ch) && !enCjk.includes(ch)) enCjk.push(ch);
    }
  });
  if (enCjk.length) fail("英文界面残留 CJK 字符: " + enCjk.join(" "));
  else ok("英文界面无 CJK 字符");
  // 2) 标记串不应出现
  const enMarkers = ZH_MARKERS.filter((m) => en.includes(m));
  if (enMarkers.length) fail("英文界面出现中文标记: " + enMarkers.join(", "));
  else ok("英文界面无中文回退");
  // 3) 切换生效
  if (/File|Edit|View|Search|Help/i.test(en)) ok("英文菜单已生效 (File/Edit/…)");
  else fail("英文菜单未生效");

  // ---- 日文 ----
  await switchTo(page, "ja-JP");
  const ja = await bodyText(page);
  const jaMarkers = ZH_MARKERS.filter((m) => ja.includes(m));
  if (jaMarkers.length) fail("日文界面出现中文标记（漏翻）: " + jaMarkers.join(", "));
  else ok("日文界面无中文回退");
  if (/ファイル|編集|表示|言語/.test(ja)) ok("日文菜单已生效 (ファイル/編集/…)");
  else fail("日文菜单未生效");

  // ---- 运行期错误 ----
  if (errors.length) fail("运行期报错: " + errors.join(" | "));
  else ok("无运行期报错");

  await browser.close();

  console.log(failures === 0 ? "\nPASS ✅ 三语 i18n 冒烟测试通过" : `\nFAIL ❌ ${failures} 项未通过`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("测试运行异常:", e);
  process.exit(2);
});
