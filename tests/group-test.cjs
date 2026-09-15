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
  else if (cmd === "ftp_list") result = { pwd: "/", entries: [{ name: "a.txt", is_dir: false, size: 10 }] };
  else if (cmd === "plugin:event|listen") result = { id: "evt" };
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
    localStorage.setItem("uec.remote.groups.collapsed", "[]");
    localStorage.setItem("uec.remotes", JSON.stringify([
      { id: "s1", name: "生产库", proto: "sftp", host: "prod.example.com", port: 22, username: "u1", password: "", savePassword: false, authMethod: "auto", keyPath: "", passphrase: "", remoteDir: "/", localDir: "", passive: true, xfer: "auto", timeout: 30, retry: 3, group: "生产/华东" },
      { id: "s2", name: "测试库", proto: "ftp", host: "test.example.com", port: 21, username: "u2", password: "", savePassword: false, authMethod: "auto", keyPath: "", passphrase: "", remoteDir: "/", localDir: "", passive: true, xfer: "auto", timeout: 30, retry: 3, group: "测试" },
      { id: "s3", name: "老机器", proto: "ftp", host: "old.example.com", port: 21, username: "u3", password: "", savePassword: false, authMethod: "auto", keyPath: "", passphrase: "", remoteDir: "/", localDir: "", passive: true, xfer: "auto", timeout: 30, retry: 3, group: "生产" },
      { id: "s4", name: "临时", proto: "ftp", host: "tmp.example.com", port: 21, username: "u4", password: "", savePassword: false, authMethod: "auto", keyPath: "", passphrase: "", remoteDir: "/", localDir: "", passive: true, xfer: "auto", timeout: 30, retry: 3, group: "" },
      { id: "s5", name: "华东库", proto: "ftp", host: "east.example.com", port: 21, username: "u5", password: "", savePassword: false, authMethod: "auto", keyPath: "", passphrase: "", remoteDir: "/", localDir: "", passive: true, xfer: "auto", timeout: 30, retry: 3, group: "生产/华东" },
    ]));
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#menubar .menu-item");
  await page.waitForTimeout(300);
  await page.locator('.sb-tab[data-sb="remote"]').click();
  await page.waitForTimeout(400);
  // 分组标题
  const groupNames = await page.locator("#rs-items .rs-group-name").allTextContents();
  has(groupNames.length === 4 && groupNames[0] === "测试" && groupNames[1] === "生产" && groupNames[2] === "华东" && groupNames[3] === "未分组",
     `嵌套分组标题: ${JSON.stringify(groupNames)}`);
  const counts = await page.locator("#rs-items .rs-group-count").allTextContents();
  has(JSON.stringify(counts) === JSON.stringify(["1", "3", "2", "1"]), `嵌套分组计数: ${JSON.stringify(counts)}`);
  // 子组缩进
  const subPad = await page.evaluate(() => document.querySelector('#rs-items .rs-group[data-group="生产/华东"]').style.paddingLeft);
  const parentPad = await page.evaluate(() => document.querySelector('#rs-items .rs-group[data-group="生产"]').style.paddingLeft);
  has(parseInt(subPad) > parseInt(parentPad), `子组缩进: ${subPad} > ${parentPad}`);
  // 折叠"生产"
  await page.locator('#rs-items .rs-group[data-group="生产"]').click();
  await page.waitForTimeout(150);
  const prodVisible = await page.locator('#rs-items .rs-item[data-id="s1"]').count();
  const subVisible = await page.locator('#rs-items .rs-group[data-group="生产/华东"]').count();
  has(prodVisible === 0 && subVisible === 0, "折叠后组内服务器与子组隐藏");
  const stored = await page.evaluate(() => localStorage.getItem("uec.remote.groups.collapsed"));
  has(stored && stored.includes("生产"), "折叠状态已记忆");
  // 展开
  await page.locator('#rs-items .rs-group[data-group="生产"]').click();
  await page.waitForTimeout(150);
  has(await page.locator('#rs-items .rs-item[data-id="s1"]').count() === 1, "再次点击展开");
  // 搜索："生产" → 只显示生产组 + 服务器，其他组隐藏
  await page.fill("#rs-filter", "生产");
  await page.waitForTimeout(200);
  const visGroups = await page.locator("#rs-items .rs-group-name").allTextContents();
  const visItems = await page.locator("#rs-items .rs-item").count();
  has(JSON.stringify(visGroups) === JSON.stringify(["生产", "华东"]) && visItems === 3, `搜索过滤: ${JSON.stringify(visGroups)} items=${visItems}`);
  await page.fill("#rs-filter", "");
  await page.waitForTimeout(200);
  // 编辑弹窗分组字段
  await page.locator('#rs-items .rs-item[data-id="s1"] [data-op="edit"]').click();
  await page.waitForTimeout(400);
  const grpVal = await page.inputValue("#acct-group");
  has(grpVal === "生产/华东", `编辑弹窗回填嵌套分组: ${grpVal}`);
  await page.fill("#acct-group", "新分组");
  await page.evaluate(() => document.querySelector("#acct-ok") && document.querySelector("#acct-ok").click());
  await page.waitForTimeout(300);
  const groupAfter = await page.evaluate(() => JSON.parse(localStorage.getItem("uec.remotes")).find(s => s.id === "s1").group);
  has(groupAfter === "新分组", `分组保存: ${groupAfter}`);
  // ---- 组右键：重命名分组 ----
  await page.evaluate(() => {
    const h = document.querySelector('#rs-items .rs-group[data-group="生产"]');
    h.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, detail: 1, clientX: 120, clientY: 130 }));
  });
  await page.waitForTimeout(180);
  const gctxVisible = await page.evaluate(() => !window.__app.remote.el.querySelector('#rs-group-ctx').classList.contains("hidden"));
  has(gctxVisible, "组右键菜单弹出");
  await page.evaluate(() => {
    const it = window.__app.remote.el.querySelector('#rs-group-ctx [data-act="rename-group"]');
    it && it.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(250);
  await page.fill("#pt-input", "运维");
  await page.evaluate(() => document.querySelector("#pt-ok") && document.querySelector("#pt-ok").click());
  await page.waitForTimeout(250);
  const renamed = await page.evaluate(() => JSON.parse(localStorage.getItem("uec.remotes")).filter(x => ["s3","s5"].includes(x.id)).map(x => x.group));
  has(JSON.stringify(renamed) === JSON.stringify(["运维", "运维/华东"]), `重命名分组级联: ${JSON.stringify(renamed)}`);
  // ---- 组右键：删除分组（测试 → 移到未分组） ----
  await page.evaluate(() => {
    const h = document.querySelector('#rs-items .rs-group[data-group="测试"]');
    h.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, detail: 1, clientX: 120, clientY: 130 }));
  });
  await page.waitForTimeout(180);
  await page.evaluate(() => {
    const it = window.__app.remote.el.querySelector('#rs-group-ctx [data-act="del-group"]');
    it && it.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(250);
  await page.evaluate(() => document.querySelector("#cf-ok") && document.querySelector("#cf-ok").click());
  await page.waitForTimeout(250);
  const delGroup = await page.evaluate(() => JSON.parse(localStorage.getItem("uec.remotes")).find(x => x.id === "s2").group);
  has(delGroup === "", `删除分组后组内服务器移到未分组: ${JSON.stringify(delGroup)}`);
  // ---- 拖拽：临时(s4) → 运维组 ----
  await page.evaluate(() => {
    const src = document.querySelector('#rs-items .rs-item[data-id="s4"]');
    const dst = document.querySelector('#rs-items .rs-group[data-group="运维"]');
    if (!src || !dst) return;
    const r = src.getBoundingClientRect();
    src.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: r.x + 30, clientY: r.y + 10 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.x + 33, clientY: r.y + 11 })); // 慢速第一步 3px
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.x + 60, clientY: r.y + 30 }));
    const d = dst.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: d.x + 40, clientY: d.y + 8 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: d.x + 40, clientY: d.y + 8 }));
  });
  await page.waitForTimeout(300);
  const moved = await page.evaluate(() => JSON.parse(localStorage.getItem("uec.remotes")).find(x => x.id === "s4").group);
  has(moved === "运维", `拖拽到分组: ${JSON.stringify(moved)}`);
  // 拖到未分组区 → 移出分组
  await page.evaluate(() => {
    const src = document.querySelector('#rs-items .rs-item[data-id="s4"]');
    const dst = document.querySelector('#rs-items .rs-group-ungrouped');
    if (!src || !dst) return;
    const r = src.getBoundingClientRect();
    src.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: r.x + 30, clientY: r.y + 10 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.x + 33, clientY: r.y + 11 })); // 慢速第一步 3px
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.x + 60, clientY: r.y + 30 }));
    const d = dst.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: d.x + 40, clientY: d.y + 8 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: d.x + 40, clientY: d.y + 8 }));
  });
  await page.waitForTimeout(300);
  const unmoved = await page.evaluate(() => JSON.parse(localStorage.getItem("uec.remotes")).find(x => x.id === "s4").group);
  has(unmoved === "", `拖到未分组移出: ${JSON.stringify(unmoved)}`);
  // 防重复渲染：未分组服务器不得出现两次（行数 = 服务器总数）
  const totalRows = await page.locator('#rs-items .rs-item').count();
  const totalSites = await page.evaluate(() => JSON.parse(localStorage.getItem("uec.remotes")).length);
  has(totalRows === totalSites, `服务器行数 = 配置数(${totalSites}): 实际 ${totalRows}`);
  // ---- 空分组预建：列表空白右键 → 新建分组 ----
  await page.evaluate(() => {
    const lv = document.querySelector('#rs-list-view');
    lv.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, detail: 1, clientX: 40, clientY: 40 }));
  });
  await page.waitForTimeout(180);
  const lctxVisible = await page.evaluate(() => !window.__app.remote.el.querySelector('#rs-list-ctx').classList.contains("hidden"));
  has(lctxVisible, "列表空白右键菜单弹出");
  await page.evaluate(() => {
    const it = window.__app.remote.el.querySelector('#rs-list-ctx [data-act="new-group"]');
    it && it.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(250);
  await page.fill("#pt-input", "研发/算法");
  await page.evaluate(() => document.querySelector("#pt-ok") && document.querySelector("#pt-ok").click());
  await page.waitForTimeout(250);
  const emptyGroup = await page.locator('#rs-items .rs-group[data-group="研发"]').count();
  const emptySub = await page.locator('#rs-items .rs-group[data-group="研发/算法"]').count();
  const emptyCount = await page.evaluate(() => document.querySelector('#rs-items .rs-group[data-group="研发"] .rs-group-count')?.textContent);
  has(emptyGroup === 1 && emptySub === 1 && emptyCount === "0", `空分组渲染(计数0): ${emptyGroup}/${emptySub}/${emptyCount}`);
  // 重命名空组：研发 → 创新（清单级联）
  await page.evaluate(() => {
    const h = document.querySelector('#rs-items .rs-group[data-group="研发"]');
    h.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, detail: 1, clientX: 120, clientY: 130 }));
  });
  await page.waitForTimeout(180);
  await page.evaluate(() => {
    const it = window.__app.remote.el.querySelector('#rs-group-ctx [data-act="rename-group"]');
    it && it.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(250);
  await page.fill("#pt-input", "创新");
  await page.evaluate(() => document.querySelector("#pt-ok") && document.querySelector("#pt-ok").click());
  await page.waitForTimeout(250);
  const glist = await page.evaluate(() => JSON.parse(localStorage.getItem("uec.remote.groups.list") || "[]"));
  has(JSON.stringify(glist) === JSON.stringify(["创新/算法"]), `空组重命名清单级联: ${JSON.stringify(glist)}`);
  // 拖 s4 进空组"创新"
  await page.evaluate(() => {
    const src = document.querySelector('#rs-items .rs-item[data-id="s4"]');
    const dst = document.querySelector('#rs-items .rs-group[data-group="创新"]');
    if (!src || !dst) return;
    const r = src.getBoundingClientRect();
    src.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: r.x + 30, clientY: r.y + 10 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.x + 33, clientY: r.y + 11 })); // 慢速第一步 3px
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.x + 60, clientY: r.y + 30 }));
    const d = dst.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: d.x + 40, clientY: d.y + 8 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: d.x + 40, clientY: d.y + 8 }));
  });
  await page.waitForTimeout(300);
  const moved2 = await page.evaluate(() => JSON.parse(localStorage.getItem("uec.remotes")).find(x => x.id === "s4").group);
  has(moved2 === "创新", `拖进预建空组: ${JSON.stringify(moved2)}`);
  // 删除空组"创新/算法" → 清单移除
  await page.evaluate(() => {
    const h = document.querySelector('#rs-items .rs-group[data-group="创新/算法"]');
    h.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, detail: 1, clientX: 120, clientY: 130 }));
  });
  await page.waitForTimeout(180);
  await page.evaluate(() => {
    const it = window.__app.remote.el.querySelector('#rs-group-ctx [data-act="del-group"]');
    it && it.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(250);
  await page.evaluate(() => document.querySelector("#cf-ok") && document.querySelector("#cf-ok").click());
  await page.waitForTimeout(250);
  const glist2 = await page.evaluate(() => JSON.parse(localStorage.getItem("uec.remote.groups.list") || "[]"));
  has(JSON.stringify(glist2) === "[]", `删除空组清单移除: ${JSON.stringify(glist2)}`);
  // 组右键 → 新建子分组（在"创新"下建"华东"）
  await page.evaluate(() => {
    const h = document.querySelector('#rs-items .rs-group[data-group="创新"]');
    h.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, detail: 1, clientX: 120, clientY: 130 }));
  });
  await page.waitForTimeout(180);
  await page.evaluate(() => {
    const it = window.__app.remote.el.querySelector('#rs-group-ctx [data-act="new-subgroup"]');
    it && it.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(250);
  await page.fill("#pt-input", "华东");
  await page.evaluate(() => document.querySelector("#pt-ok") && document.querySelector("#pt-ok").click());
  await page.waitForTimeout(250);
  const subCnt = await page.locator('#rs-items .rs-group[data-group="创新/华东"]').count();
  const glist3 = await page.evaluate(() => JSON.parse(localStorage.getItem("uec.remote.groups.list") || "[]"));
  has(subCnt === 1 && JSON.stringify(glist3) === JSON.stringify(["创新/华东"]), `新建子分组: 渲染${subCnt} 清单${JSON.stringify(glist3)}`);
  const realErrors = errors.filter((e) => !e.includes("favicon"));
  has(realErrors.length === 0, "无运行期报错");
  await browser.close();
  if (failures === 0) console.log("PASS ✅ 服务器分组验证通过");
  else { console.log(`FAIL ❌ ${failures} 项未通过`); process.exit(1); }
})();
