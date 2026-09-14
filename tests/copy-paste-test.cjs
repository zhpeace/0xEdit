// 复制/粘贴（剪贴板式）功能验证：本地树 + 远程树右键「复制」「粘贴」
// 覆盖：菜单项存在、未复制时粘贴置灰、复制后 toast、粘贴调用 copy_to / ftp_copy、粘贴到当前目录
// 用法： node tests/copy-paste-test.cjs   （需先启动 dev server：npm run dev）
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

// mock invoke：自包含，全部数据内联
function invoke(cmd, args) {
  window.__calls = window.__calls || [];
  let result = {};
  if (cmd === "read_text_file") {
    result = { text: "", encoding: "utf-8", line_endings: "lf", is_binary: false, truncated: false, size: 0 };
  } else if (cmd === "home_dir") {
    result = "/tmp";
  } else if (cmd === "list_dir") {
    const p = (args && args.path) || "";
    result = p === "/tmp"
      ? [
          { name: "note.md", path: "/tmp/note.md", is_dir: false, size: 12 },
          { name: "docs", path: "/tmp/docs", is_dir: true, size: 0 },
        ]
      : [];
  } else if (cmd === "read_dir") {
    result = [];
  } else if (cmd === "copy_to") {
    // 模拟后端 copy_to：记录调用并返回目标路径（真实后端会加序号/拦截递归）
    window.__lastCopy = { src: args.src, destDir: args.destDir };
    const name = String(args.src).split("/").pop();
    result = args.destDir + "/" + name;
  } else if (cmd === "plugin:dialog|open") {
    result = "/tmp";
  }
  // 远程（FTP）
  else if (cmd === "ftp_connect") {
    result = "conn1";
  } else if (cmd === "ftp_list") {
    result = { pwd: "/", entries: [
      { name: "a.txt", is_dir: false, size: 10 },
      { name: "docs", is_dir: true, size: 0 },
    ]};
  } else if (cmd === "ftp_copy") {
    window.__lastFtpCopy = { src: args.src, destDir: args.destDir };
    const name = String(args.src).split("/").pop();
    result = args.destDir + "/" + name;
  } else if (cmd === "plugin:event|listen") {
    result = { id: "evt-" + (window.__evtId = (window.__evtId || 0) + 1) };
  }
  window.__calls.push({ cmd, args });
  return Promise.resolve(result);
}

let failures = 0;
const fail = (m) => { failures++; console.log("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);
const has = (v, name) => (v ? ok(name) : fail(name));
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
    window.__TAURI_INTERNALS__ = {
      invoke: (c, a) => eval("(" + inv + ")")(c, a),
      transformCallback: (cb, once) => {
        window.__cbs = window.__cbs || [];
        const id = (window.__cbs.push({ cb, once }) + 1000);
        return id;
      },
    };
  }, invoke.toString());

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.setItem("uec.lang", "zh-CN");
    // 预置 FTP 站点（带密码，防弹窗挂起）；RemoteBrowser 构造时读取
    localStorage.setItem("uec.remotes", JSON.stringify([{
      id: "site1", name: "Test FTP", proto: "ftp", host: "127.0.0.1", port: 21,
      username: "u", password: "p", savePassword: true, authMethod: "password",
      keyPath: "", passphrase: "", remoteDir: "/",
    }]));
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#menubar .menu-item");
  await page.waitForTimeout(300);

  // ---------- A) 本地文件树 ----------
  console.log("\n[A] 本地文件树 复制/粘贴");
  // 打开文件夹 → 树渲染 /tmp
  await page.locator('[data-action="open-folder"]').first().click();
  await page.waitForTimeout(500);
  const ftNode = page.locator('#filetree .ft-node[data-path="/tmp/note.md"]');
  has(await ftNode.count() > 0, "文件树已渲染 /tmp 下 note.md");

  // 右键节点 → 菜单含 复制/粘贴，粘贴置灰
  await ftNode.click({ button: "right" });
  await page.waitForTimeout(200);
  const ctx = page.locator(".ctx-menu:not(.hidden)");
  has(await ctx.count() > 0, "节点右键菜单弹出");
  const copyItem = page.locator('.ctx-menu:not(.hidden) [data-act="copy"]');
  const pasteItem = page.locator('.ctx-menu:not(.hidden) [data-act="paste"]');
  has(await copyItem.count() === 1, "菜单含「复制」");
  has(await pasteItem.count() === 1, "菜单含「粘贴」");
  has(await pasteItem.evaluate((el) => el.classList.contains("ctx-disabled")).catch(() => true), "未复制时「粘贴」置灰");
  await page.keyboard.press("Escape");

  // 点击「复制」→ toast + 剪贴板记录
  await ftNode.click({ button: "right" });
  await page.waitForTimeout(200);
  await page.locator('.ctx-menu:not(.hidden) [data-act="copy"]').click();
  await page.waitForTimeout(250);
  const copyToast = await page.evaluate(() => document.body.textContent || "");
  has(copyToast.includes("已复制 note.md"), "复制后 toast 提示来源");

  // 再次右键 → 粘贴激活（title 带来源）
  await ftNode.click({ button: "right" });
  await page.waitForTimeout(200);
  const pasteActive = await page.locator('.ctx-menu:not(.hidden) [data-act="paste"]')
    .evaluate((el) => !el.classList.contains("ctx-disabled")).catch(() => false);
  has(pasteActive, "复制后「粘贴」激活");
  await page.keyboard.press("Escape");

  // 空白处右键 → 粘贴到当前目录
  await page.locator("#filetree").click({ button: "right", position: { x: 40, y: 40 } });
  await page.waitForTimeout(200);
  const blankPaste = await page.locator('.ctx-menu:not(.hidden) [data-act="paste"]')
    .evaluate((el) => !el.classList.contains("ctx-disabled")).catch(() => false);
  has(blankPaste, "空白处右键「粘贴」可用（粘贴到当前浏览目录）");
  await page.locator('.ctx-menu:not(.hidden) [data-act="paste"]').click();
  await page.waitForTimeout(250);
  const lastCopy = await page.evaluate(() => window.__lastCopy || null);
  has(lastCopy && lastCopy.src === "/tmp/note.md", "粘贴调用 copy_to 且源正确");
  eq(lastCopy && lastCopy.destDir, "/tmp", "粘贴目标 = 当前浏览目录 /tmp");
  const pasteToast = await page.evaluate(() => document.body.textContent || "");
  has(pasteToast.includes("已粘贴到"), "粘贴后 toast 提示");

  // ---------- B) 远程文件树 ----------
  console.log("\n[B] 远程树 复制/粘贴");
  await page.locator('.sb-tab[data-sb="remote"]').click();
  await page.waitForTimeout(400);
  await page.locator('#remote-panel [data-op="connect"]').first().click();
  await page.waitForTimeout(600);
  const rNode = page.locator('#ftp-tree [data-name="a.txt"]');
  has(await rNode.count() > 0, "远程树已渲染 a.txt");

  // 右键节点 → 复制
  await rNode.click({ button: "right" });
  await page.waitForTimeout(200);
  const rCopy = page.locator('.ctx-menu:not(.hidden) [data-act="copy"]');
  has(await rCopy.count() === 1, "远程菜单含「复制」");
  await rCopy.click();
  await page.waitForTimeout(250);
  const rCopyToast = await page.evaluate(() => {
    const el = document.querySelector("#ftp-status");
    return el ? el.textContent : "";
  });
  has(rCopyToast.includes("已复制 a.txt"), "远程复制后 toast 提示来源");

  // 空白处右键 → 粘贴（调用 ftp_copy，目标=当前远程目录）
  await page.locator("#ftp-tree").click({ button: "right", position: { x: 40, y: 40 } });
  await page.waitForTimeout(200);
  const rPaste = page.locator('.ctx-menu:not(.hidden) [data-act="paste"]');
  has(await rPaste.count() === 1, "远程空白菜单含「粘贴」");
  const rPasteActive = await rPaste.evaluate((el) => !el.classList.contains("ctx-disabled")).catch(() => false);
  has(rPasteActive, "远程「粘贴」已激活");
  await rPaste.click();
  await page.waitForTimeout(300);
  const ftpCopy = await page.evaluate(() => window.__lastFtpCopy || null);
  has(ftpCopy && ftpCopy.src === "/a.txt", "远程粘贴调用 ftp_copy 且源正确");
  eq(ftpCopy && ftpCopy.destDir, "/", "远程粘贴目标 = 当前远程目录 /");

  // ---------- 运行期错误 ----------
  console.log("\n[汇总]");
  const realErrors = errors.filter((e) => !e.includes("favicon"));
  eq(realErrors.length, 0, "无运行期报错");
  if (failures === 0) console.log("PASS ✅ 复制/粘贴功能验证通过");
  else { console.log(`FAIL ❌ ${failures} 项未通过`); process.exit(1); }
  await browser.close();
})();
