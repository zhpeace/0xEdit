import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import { t, onLangChange } from "./i18n";

interface FtpEntry {
  name: string;
  is_dir: boolean;
  size: number;
}

interface FtpListResult {
  pwd: string;
  entries: FtpEntry[];
}

export interface RemoteSite {
  id: string;
  name: string;
  proto: "ftp" | "sftp" | "ftps";
  host: string;
  port: number;
  username: string;
  password: string;
  savePassword: boolean;
  authMethod: "auto" | "password" | "keyboard" | "publickey";
  keyPath: string;
  passphrase: string;
  remoteDir: string;
  localDir: string;
  passive: boolean;
  xfer: "auto" | "ascii" | "binary";
  timeout: number;
  retry: number;
}

const REMOTE_STORE_KEY = "uec.remotes";

function genId(): string {
  return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function newAccount(): RemoteSite {
  return {
    id: genId(),
    name: t("新账户"),
    proto: "sftp",
    host: "",
    port: 22,
    username: "",
    password: "",
    savePassword: true,
    authMethod: "auto",
    keyPath: "",
    passphrase: "",
    remoteDir: "/",
    localDir: "",
    passive: true,
    xfer: "auto",
    timeout: 30,
    retry: 3,
  };
}

function normalizeSite(s: any): RemoteSite {
  const d = newAccount();
  return {
    id: s.id || genId(),
    name: s.name || d.name,
    proto: s.proto || d.proto,
    host: s.host || "",
    port: s.port || (s.proto === "sftp" ? 22 : 21),
    username: s.username || "",
    password: s.password || "",
    savePassword: s.savePassword !== false,
    authMethod: s.authMethod || "auto",
    keyPath: s.keyPath || "",
    passphrase: s.passphrase || "",
    remoteDir: s.remoteDir || "/",
    localDir: s.localDir || "",
    passive: s.passive !== false,
    xfer: s.xfer || "auto",
    timeout: s.timeout || 30,
    retry: s.retry || 3,
  };
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function join(p: string, name: string): string {
  if (p === "/") return "/" + name;
  return p.replace(/\/+$/, "") + "/" + name;
}

function baseName(p: string): string {
  const t = p.replace(/\/+$/, "");
  return t.slice(t.lastIndexOf("/") + 1);
}

function defaultPort(proto: string): number {
  return proto === "sftp" ? 22 : 21;
}

export class RemoteBrowser {
  private el: HTMLElement;
  private id = "";
  private proto: "ftp" | "sftp" | "ftps" = "ftp";
  private path = "/";
  private expanded = new Set<string>();
  private loading = new Set<string>();
  private selectedPath: string | null = null;
  private sites: RemoteSite[] = [];
  private curSiteId: string | null = null;
  private connectedSiteId: string | null = null;
  private onOpenRemote: (tmp: string, proto: "ftp" | "sftp" | "ftps", id: string, remotePath: string) => void;
  private getActivePath: () => string;

  constructor(
    el: HTMLElement,
    onOpenRemote: (tmp: string, proto: "ftp" | "sftp" | "ftps", id: string, remotePath: string) => void,
    getActivePath: () => string,
  ) {
    this.el = el;
    this.onOpenRemote = onOpenRemote;
    this.getActivePath = getActivePath;
    el.innerHTML = `
      <div class="sftp-form">
        <div class="fs-row" style="margin-bottom:6px;">
          <select id="rs-site" class="fs-input" style="flex:1;">
            <option value="">${t("— 选择账户 —")}</option>
          </select>
          <button class="search-btn" id="rs-manage" title="${t("管理账户…")}">${t("管理账户…")}</button>
        </div>
        <div class="fs-options" style="margin-bottom:6px;">
          <button class="search-btn" id="ftp-connect">${t("连接")}</button>
          <button class="search-btn hidden" id="ftp-disconnect">${t("断开")}</button>
          <button class="search-btn hidden" id="ftp-refresh">${t("刷新")}</button>
          <button class="search-btn hidden" id="ftp-up">${t("上级..")}</button>
          <button class="search-btn hidden" id="ftp-mkdir">${t("新建目录")}</button>
          <button class="search-btn hidden" id="ftp-upload">${t("上传当前文件")}</button>
          <button class="search-btn hidden" id="ftp-upload-file">${t("上传文件…")}</button>
          <button class="search-btn hidden" id="ftp-rename">${t("重命名")}</button>
          <button class="search-btn hidden" id="ftp-del">${t("删除")}</button>
        </div>
        <div class="fs-row hidden" id="ftp-tools">
          <input class="fs-input" id="ftp-newdir" placeholder="${t("目录名 (回车创建)")}" spellcheck="false" style="flex:1"/>
        </div>
      </div>
      <div class="ft-status" id="ftp-status"></div>
      <div class="ft-path" id="ftp-path"></div>
      <div id="ftp-tree" class="ft-dir"></div>
      <div id="ftp-ctx" class="ctx-menu hidden">
        <div class="ctx-item" data-act="open">${t("打开")}</div>
        <div class="ctx-item" data-act="saveas">${t("下载到本地…")}</div>
        <div class="ctx-item" data-act="rename">${t("重命名")}</div>
        <div class="ctx-item ctx-danger" data-act="del">${t("删除")}</div>
      </div>`;

    el.querySelector("#rs-manage")!.addEventListener("click", () => this.openAccountManager());
    el.querySelector("#ftp-connect")!.addEventListener("click", () => this.connectSelected());
    el.querySelector("#ftp-disconnect")!.addEventListener("click", () => this.disconnect());
    el.querySelector("#ftp-refresh")!.addEventListener("click", () => this.refresh());
    el.querySelector("#ftp-up")!.addEventListener("click", () => this.cmdUp());
    el.querySelector("#ftp-upload")!.addEventListener("click", () => this.upload());
    el.querySelector("#ftp-upload-file")!.addEventListener("click", () => this.uploadFiles());
    el.querySelector("#ftp-mkdir")!.addEventListener("click", () => this.mkdir());
    el.querySelector("#ftp-rename")!.addEventListener("click", () => this.doRename());
    el.querySelector("#ftp-del")!.addEventListener("click", () => this.delSelected());
    el.querySelector<HTMLInputElement>("#ftp-newdir")!.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.mkdir();
    });
    el.querySelector("#rs-site")!.addEventListener("change", () => this.onSitePicked());
    this.loadSites();
    this.renderSites();
    const ctx = this.el.querySelector<HTMLElement>("#ftp-ctx")!;
    (this.el.querySelector("#ftp-tree") as HTMLElement)!.addEventListener("contextmenu", (e: MouseEvent) => {
      const node = (e.target as HTMLElement).closest<HTMLElement>("[data-name]");
      if (!node) return;
      e.preventDefault();
      this.selectedPath = node.dataset.path || node.dataset.name!;
      const isDir = node.dataset.dir === "1";
      (ctx.querySelector('[data-act="saveas"]') as HTMLElement).style.display = isDir ? "none" : "";
      (ctx.querySelector('[data-act="open"]') as HTMLElement).style.display = isDir ? "none" : "";
      ctx.style.left = `${e.clientX}px`;
      ctx.style.top = `${e.clientY}px`;
      ctx.classList.remove("hidden");
    });
    ctx.querySelectorAll<HTMLElement>(".ctx-item").forEach((item) => {
      item.addEventListener("click", () => {
        ctx.classList.add("hidden");
        const act = item.dataset.act!;
        if (!this.selectedPath) return;
        if (act === "open") this.download(this.selectedPath);
        else if (act === "saveas") this.saveAs(this.selectedPath);
        else if (act === "rename") this.doRename();
        else if (act === "del") this.delPath(this.selectedPath);
      });
    });
    document.addEventListener("click", (e) => {
      if (!ctx.contains(e.target as Node)) ctx.classList.add("hidden");
    });
    this.el.querySelector("#ftp-tree")!.addEventListener("click", (e) => {
      const node = (e.target as HTMLElement).closest<HTMLElement>("[data-name]");
      if (!node) return;
      const name = node.dataset.name!;
      if (node.dataset.actions === "up") {
        this.cmdUp();
        return;
      }
      const isDir = node.dataset.dir === "1";
      if (isDir) {
        if (this.isSftp()) this.toggleExpand(node);
        else this.cmdInto(name);
      } else {
        this.download(node.dataset.path || node.dataset.name!);
      }
    });
    onLangChange(() => this.localizePanel());
  }

  private localizePanel() {
    const setTxt = (sel: string, key: string) => {
      const e = this.el.querySelector<HTMLElement>(sel);
      if (e) e.textContent = t(key);
    };
    const setAttr = (sel: string, attr: string, key: string) => {
      const e = this.el.querySelector<HTMLElement>(sel);
      if (e) e.setAttribute(attr, t(key));
    };
    setTxt("#rs-manage", "管理账户…");
    setAttr("#rs-manage", "title", "管理账户…");
    setTxt("#ftp-connect", "连接");
    setTxt("#ftp-disconnect", "断开");
    setTxt("#ftp-refresh", "刷新");
    setTxt("#ftp-up", "上级..");
    setTxt("#ftp-mkdir", "新建目录");
    setTxt("#ftp-upload", "上传当前文件");
    setTxt("#ftp-upload-file", "上传文件…");
    setTxt("#ftp-rename", "重命名");
    setTxt("#ftp-del", "删除");
    const nd = this.el.querySelector<HTMLInputElement>("#ftp-newdir");
    if (nd) nd.placeholder = t("目录名 (回车创建)");
    const opt = this.el.querySelector<HTMLOptionElement>('#rs-site option[value=""]');
    if (opt) opt.textContent = t("— 选择账户 —");
    const ctxOpen = this.el.querySelector('#ftp-ctx [data-act="open"]');
    if (ctxOpen) ctxOpen.textContent = t("打开");
    const ctxSave = this.el.querySelector('#ftp-ctx [data-act="saveas"]');
    if (ctxSave) ctxSave.textContent = t("下载到本地…");
    const ctxRen = this.el.querySelector('#ftp-ctx [data-act="rename"]');
    if (ctxRen) ctxRen.textContent = t("重命名");
    const ctxDel = this.el.querySelector('#ftp-ctx [data-act="del"]');
    if (ctxDel) ctxDel.textContent = t("删除");
  }

  private status(msg: string) {
    const el = this.el.querySelector<HTMLElement>("#ftp-status")!;
    el.textContent = msg;
  }

  private isSftp() {
    return this.proto === "sftp";
  }

  private loadSites() {
    try {
      const raw = localStorage.getItem(REMOTE_STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      this.sites = Array.isArray(arr) ? arr.map((s: any) => normalizeSite(s)) : [];
    } catch {
      this.sites = [];
    }
  }

  private saveSites() {
    try {
      localStorage.setItem(REMOTE_STORE_KEY, JSON.stringify(this.sites));
    } catch {
      /* ignore */
    }
  }

  private renderSites() {
    const sel = this.el.querySelector<HTMLSelectElement>("#rs-site")!;
    const prev = sel.value;
    sel.innerHTML = `<option value="">${t("— 选择账户 —")}</option>`;
    for (const s of this.sites) {
      const opt = document.createElement("option");
      opt.value = s.id;
      const tag = s.id === this.connectedSiteId ? " ●" : "";
      opt.textContent = `${s.name} (${s.proto.toUpperCase()} ${s.host})${tag}`;
      sel.appendChild(opt);
    }
    sel.value = prev && this.sites.some((s) => s.id === prev) ? prev : "";
  }

  private onSitePicked() {
    const sel = this.el.querySelector<HTMLSelectElement>("#rs-site")!;
    this.curSiteId = sel.value || null;
  }

  private connectSelected() {
    const id = (this.el.querySelector("#rs-site") as HTMLSelectElement).value;
    const s = this.sites.find((x) => x.id === id);
    if (!s) {
      this.status(t("请先选择一个账户，或点「管理账户…」新建"));
      return;
    }
    void this.connectSite(s);
  }

  private async connectSite(s: RemoteSite, passOverride?: string, onSuccess?: () => void): Promise<void> {
    const doConn = async (pw: string) => {
      this.proto = s.proto;
      this.curSiteId = s.id;
      this.status(t("连接中…"));
      try {
        const o = {
          host: s.host,
          port: s.port,
          username: s.username,
          password: pw,
          keyPath: s.keyPath || null,
          passphrase: s.passphrase || null,
          authMethod: s.authMethod,
        };
        this.id = this.proto === "sftp"
          ? await invoke<string>("sftp_connect", o)
          : await invoke<string>("ftp_connect", o);
        this.path = s.remoteDir || "/";
        this.connectedSiteId = s.id;
        this.setConnected(true);
        this.renderSites();
        this.status(t("[{name}] 已连接", { name: s.name }) + (s.keyPath ? t("（密钥认证）") : ""));
        await this.refresh();
        onSuccess?.();
      } catch (e) {
        this.id = "";
        this.setConnected(false);
        const msg = String(e);
        let hint = "";
        if (/Authentication failed|Permission denied|denied/i.test(msg) && /^root$/i.test(s.username || "")) {
          hint = "\n\n" + t("提示：OpenSSH 常禁用 root 的密码登录（PermitRootLogin prohibit-password）。请改用普通用户登录，或在服务器开启 PermitRootLogin yes / PasswordAuthentication yes，或改用「公钥」认证。");
        }
        this.status(t("失败: {msg}", { msg }));
        this.showError(t("连接失败"), msg + hint);
      }
    };
    if (passOverride !== undefined) return doConn(passOverride);
    if (s.password) return doConn(s.password);
    const pw = await this.promptPassword(s);
    if (pw === null) {
      this.status(t("已取消"));
      return;
    }
    return doConn(pw);
  }

  private promptPassword(s: RemoteSite): Promise<string | null> {
    return new Promise((resolve) => {
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.innerHTML = `<div class="modal" style="min-width:300px;">
        <div class="modal-title">输入密码 · ${escapeHtml(s.name)}</div>
        <div class="modal-body">
          <label class="acct-f">账户 <b>${escapeHtml(s.username || "(无用户名)")}</b> @ ${escapeHtml(s.host)} 的密码
            <input id="pw-input" type="password" class="fs-input" autofocus/>
          </label>
        </div>
        <div class="modal-actions">
          <button class="search-btn" id="pw-ok">确定</button>
          <button class="search-btn" id="pw-cancel">取消</button>
        </div>
      </div>`;
      document.body.appendChild(mask);
      const input = mask.querySelector("#pw-input") as HTMLInputElement;
      const close = (v: string | null) => {
        mask.remove();
        resolve(v);
      };
      mask.querySelector("#pw-ok")!.addEventListener("click", () => close(input.value));
      mask.querySelector("#pw-cancel")!.addEventListener("click", () => close(null));
      mask.addEventListener("click", (e) => {
        if (e.target === mask) close(null);
      });
      input.focus();
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") close(input.value);
      });
    });
  }

  private showError(title: string, msg: string) {
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML = `<div class="modal" style="max-width:540px;">
      <div class="modal-title">${escapeHtml(title)}</div>
      <div class="modal-body" style="white-space:pre-wrap;font-family:var(--mono);font-size:12px;word-break:break-word;">${escapeHtml(msg)}</div>
      <div class="modal-actions">
        <button class="search-btn" id="err-ok">确定</button>
      </div>
    </div>`;
    document.body.appendChild(mask);
    const done = () => mask.remove();
    mask.querySelector("#err-ok")!.addEventListener("click", done);
    mask.addEventListener("click", (e) => {
      if (e.target === mask) done();
    });
  }

  /* ---------------- FTP 账户管理器对话框 ---------------- */

  private openAccountManager() {
    const draft: RemoteSite[] = this.sites.map((s) => ({ ...s }));
    let selId: string | null = this.curSiteId ?? (draft[0] ? draft[0].id : null);
    if (!selId || !draft.find((s) => s.id === selId)) {
      if (draft.length === 0) {
        const a = newAccount();
        draft.push(a);
      }
      selId = draft[0] ? draft[0].id : null;
    }

    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML = `
      <div class="modal acct-modal">
        <div class="acct-title">${t("FTP 账户管理器")}</div>
        <div class="acct-body">
          <div class="acct-list">
            <div class="acct-list-actions">
              <button id="acct-new" class="search-btn">${t("+ 新建")}</button>
              <button id="acct-dup" class="search-btn">${t("复制")}</button>
              <button id="acct-del" class="search-btn">${t("删除")}</button>
            </div>
            <ul id="acct-items" class="acct-items"></ul>
          </div>
          <div class="acct-props">
            <div class="acct-tabs">
              <button data-tab="general" class="acct-tab-btn active">${t("常规")}</button>
              <button data-tab="advanced" class="acct-tab-btn">${t("高级")}</button>
              <button data-tab="ssh" class="acct-tab-btn">${t("SFTP/SSH")}</button>
            </div>
            <div class="acct-tabpanel" data-tab="general">
              <label class="acct-f">${t("账户名称")}<input id="acct-name" class="fs-input"/></label>
              <div class="acct-f-row">
                <label class="acct-f" style="flex:1">${t("协议")}
                  <select id="acct-proto" class="fs-input">
                    <option value="ftp">FTP</option>
                    <option value="sftp">SFTP</option>
                    <option value="ftps">FTPS</option>
                  </select>
                </label>
                <label class="acct-f" style="flex:1">${t("端口")}<input id="acct-port" class="fs-input"/></label>
              </div>
              <label class="acct-f">${t("服务器")}<input id="acct-host" class="fs-input" placeholder="${t("例如 ftp.example.com")}"/></label>
              <div class="acct-f-row">
                <label class="acct-f" style="flex:1">${t("用户名")}<input id="acct-user" class="fs-input"/></label>
                <label class="acct-f" style="flex:1">${t("密码")}<input id="acct-pass" type="password" class="fs-input"/></label>
              </div>
              <label class="acct-check"><input id="acct-savepass" type="checkbox"/> ${t("记住密码")}</label>
              <label class="acct-f" id="acct-auth-row">${t("认证方式")}
                <select id="acct-auth" class="fs-input">
                  <option value="auto">${t("自动")}</option>
                  <option value="password">${t("仅密码")}</option>
                  <option value="keyboard">${t("键盘交互")}</option>
                  <option value="publickey">${t("仅公钥")}</option>
                </select>
              </label>
              <label class="acct-f">${t("起始远程目录")}<input id="acct-rdir" class="fs-input" placeholder="${t("/ （留空用根目录）")}"/></label>
              <label class="acct-f">${t("起始本地目录")}<input id="acct-ldir" class="fs-input" placeholder="${t("留空用当前目录")}"/></label>
            </div>
            <div class="acct-tabpanel hidden" data-tab="advanced">
              <label class="acct-f">${t("连接超时（秒）")}<input id="acct-timeout" type="number" class="fs-input"/></label>
              <label class="acct-f">${t("失败后重试次数")}<input id="acct-retry" type="number" class="fs-input"/></label>
              <label class="acct-f">${t("传输模式")}
                <select id="acct-xfer" class="fs-input">
                  <option value="auto">${t("自动")}</option>
                  <option value="ascii">ASCII</option>
                  <option value="binary">${t("二进制")}</option>
                </select>
              </label>
              <label class="acct-check"><input id="acct-pasv" type="checkbox"/> ${t("被动模式 (PASV)（FTP/FTPS）")}</label>
            </div>
            <div class="acct-tabpanel hidden" data-tab="ssh">
              <label class="acct-f">${t("私钥文件")}
                <span class="acct-keyrow"><input id="acct-key" class="fs-input" placeholder="${t("私钥路径（可选）")}"/><button id="acct-keybrowse" class="search-btn">…</button></span>
              </label>
              <div class="acct-keygen">
                <button class="search-btn" id="acct-genkey" type="button">${t("生成 SSH 密钥对…")}</button>
                <textarea id="acct-pubkey" class="fs-input acct-pubkey" readonly placeholder="${t("生成后此处显示公钥，请将其添加到服务器的 ~/.ssh/authorized_keys")}"></textarea>
                <button class="search-btn" id="acct-copypub" type="button">${t("复制公钥")}</button>
                <div class="acct-hint">${t("未勾「记住密码」时，连接会提示输入私钥口令。")}</div>
              </div>
              <label class="acct-f">${t("私钥口令")}<input id="acct-keypass" type="password" class="fs-input"/></label>
            </div>
          </div>
        </div>
        <div class="acct-foot">
          <button id="acct-connect" class="search-btn">${t("连接")}</button>
          <span class="acct-spacer"></span>
          <button id="acct-ok" class="search-btn primary">${t("保存")}</button>
          <button id="acct-cancel" class="search-btn">${t("取消")}</button>
        </div>
      </div>`;
    document.body.appendChild(mask);

    const q = <T extends HTMLElement = HTMLElement>(s: string) => mask.querySelector<T>(s)!;
    const qSel = (s: string) => mask.querySelector<HTMLSelectElement>(s)!;
    const qInp = (s: string) => mask.querySelector<HTMLInputElement>(s)!;

    const renderList = () => {
      const ul = q("#acct-items");
      ul.innerHTML = "";
      if (draft.length === 0) {
        const empty = document.createElement("li");
        empty.className = "acct-empty";
        empty.textContent = t("（没有账户，点「+ 新建」）");
        ul.appendChild(empty);
        return;
      }
      for (const s of draft) {
        const li = document.createElement("li");
        li.className = "acct-item" + (s.id === selId ? " active" : "");
        li.dataset.id = s.id;
        li.innerHTML = `<span class="acct-item-name">${escapeHtml(s.name)}</span><span class="acct-item-sub">${s.proto.toUpperCase()} · ${escapeHtml(s.host || "—")}</span>`;
        li.addEventListener("click", () => {
          commit();
          selId = s.id;
          renderList();
          loadSel();
        });
        ul.appendChild(li);
      }
    };

    const loadSel = () => {
      const s = draft.find((x) => x.id === selId);
      const disabled = !s;
      (q("#acct-name") as HTMLInputElement).disabled = disabled;
      qSel("#acct-proto").disabled = disabled;
      qInp("#acct-port").disabled = disabled;
      qInp("#acct-host").disabled = disabled;
      qInp("#acct-user").disabled = disabled;
      qInp("#acct-pass").disabled = disabled;
      qInp("#acct-savepass").disabled = disabled;
      qInp("#acct-rdir").disabled = disabled;
      qInp("#acct-ldir").disabled = disabled;
      qInp("#acct-timeout").disabled = disabled;
      qInp("#acct-retry").disabled = disabled;
      qSel("#acct-xfer").disabled = disabled;
      qInp("#acct-pasv").disabled = disabled;
      qSel("#acct-auth").disabled = disabled;
      qInp("#acct-key").disabled = disabled;
      qInp("#acct-keypass").disabled = disabled;
      if (!s) return;
      qInp("#acct-name").value = s.name;
      qSel("#acct-proto").value = s.proto;
      qInp("#acct-port").value = String(s.port);
      qInp("#acct-host").value = s.host;
      qInp("#acct-user").value = s.username;
      qInp("#acct-pass").value = s.password;
      qInp("#acct-savepass").checked = s.savePassword;
      qInp("#acct-rdir").value = s.remoteDir;
      qInp("#acct-ldir").value = s.localDir;
      qInp("#acct-timeout").value = String(s.timeout);
      qInp("#acct-retry").value = String(s.retry);
      qSel("#acct-xfer").value = s.xfer;
      qInp("#acct-pasv").checked = s.passive;
      qSel("#acct-auth").value = s.authMethod;
      qInp("#acct-key").value = s.keyPath;
      qInp("#acct-keypass").value = s.passphrase;
      q("#acct-auth-row").style.display = s.proto === "ftp" ? "none" : "";
    };

    const commit = () => {
      const s = draft.find((x) => x.id === selId);
      if (!s) return;
      s.name = qInp("#acct-name").value.trim() || "未命名账户";
      s.proto = qSel("#acct-proto").value as RemoteSite["proto"];
      const portRaw = qInp("#acct-port").value.trim();
      s.port = parseInt(portRaw || String(defaultPort(s.proto)), 10) || defaultPort(s.proto);
      s.host = qInp("#acct-host").value.trim();
      s.username = qInp("#acct-user").value;
      s.password = qInp("#acct-pass").value;
      s.savePassword = qInp("#acct-savepass").checked;
      s.remoteDir = qInp("#acct-rdir").value.trim() || "/";
      s.localDir = qInp("#acct-ldir").value.trim();
      s.timeout = parseInt(qInp("#acct-timeout").value || "30", 10) || 30;
      s.retry = parseInt(qInp("#acct-retry").value || "3", 10) || 3;
      s.xfer = qSel("#acct-xfer").value as RemoteSite["xfer"];
      s.passive = qInp("#acct-pasv").checked;
      s.authMethod = qSel("#acct-auth").value as RemoteSite["authMethod"];
      s.keyPath = qInp("#acct-key").value.trim();
      s.passphrase = qInp("#acct-keypass").value;
    };

    const finalize = () => {
      for (const s of draft) if (!s.savePassword) s.password = "";
      this.sites = draft;
      this.saveSites();
    };

    const close = () => mask.remove();

    // tabs
    mask.querySelectorAll<HTMLElement>(".acct-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        mask.querySelectorAll(".acct-tab-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const tab = btn.dataset.tab!;
        mask.querySelectorAll<HTMLElement>(".acct-tabpanel").forEach((p) => {
          p.classList.toggle("hidden", p.dataset.tab !== tab);
        });
      });
    });

    // proto auto-port
    qSel("#acct-proto").addEventListener("change", () => {
      const cur = qInp("#acct-port").value.trim();
      if (cur === "" || cur === "21" || cur === "22") {
        qInp("#acct-port").value = String(defaultPort(qSel("#acct-proto").value));
      }
      q("#acct-auth-row").style.display = qSel("#acct-proto").value === "ftp" ? "none" : "";
    });

    // key browse
    q("#acct-keybrowse").addEventListener("click", async () => {
      const picked = await dialogOpen({ multiple: false, title: t("选择私钥") });
      if (picked) qInp("#acct-key").value = picked as string;
    });
    q("#acct-genkey").addEventListener("click", async () => {
      const path = await dialogSave({ defaultPath: "uec_id_ed25519", title: t("保存私钥到") });
      if (!path) return;
      const pass = qInp("#acct-keypass").value;
      try {
        const res = await invoke<{ private_path: string; public_key: string }>("ssh_generate_key", {
          path,
          passphrase: pass || null,
        });
        qInp("#acct-key").value = res.private_path;
        qSel("#acct-auth").value = "publickey";
        (q("#acct-pubkey") as HTMLTextAreaElement).value = res.public_key;
        this.status(t("已生成密钥：{path}", { path: res.private_path }));
      } catch (e) {
        this.status(t("生成失败: {e}", { e: String(e) }));
      }
    });
    q("#acct-copypub").addEventListener("click", () => {
      const v = (q("#acct-pubkey") as HTMLTextAreaElement).value;
      if (!v) return;
      navigator.clipboard?.writeText(v).then(
        () => this.status(t("已复制公钥")),
        () => this.status(t("复制失败")),
      );
    });

    // list actions
    q("#acct-new").addEventListener("click", () => {
      commit();
      const a = newAccount();
      draft.push(a);
      selId = a.id;
      renderList();
      loadSel();
      qInp("#acct-name").focus();
      qInp("#acct-name").select();
    });
    q("#acct-dup").addEventListener("click", () => {
      commit();
      const src = draft.find((x) => x.id === selId);
      if (!src) return;
      const c: RemoteSite = { ...src, id: genId(), name: src.name + " 副本" };
      draft.push(c);
      selId = c.id;
      renderList();
      loadSel();
    });
    q("#acct-del").addEventListener("click", () => {
      if (!selId) return;
      const idx = draft.findIndex((x) => x.id === selId);
      if (idx < 0) return;
      draft.splice(idx, 1);
      selId = draft[0] ? draft[0].id : null;
      renderList();
      loadSel();
    });

    // footer
    q("#acct-cancel").addEventListener("click", () => close());
    q("#acct-ok").addEventListener("click", () => {
      commit();
      finalize();
      this.renderSites();
      close();
    });
    q("#acct-connect").addEventListener("click", () => {
      commit();
      finalize();
      this.renderSites();
      const s = draft.find((x) => x.id === selId);
      if (!s) return;
      // 连接成功才关闭对话框；失败则保留以便修改重试
      void this.connectSite(s, undefined, () => close());
    });

    mask.addEventListener("click", (e) => {
      if (e.target === mask) close();
    });

    renderList();
    loadSel();
  }

  /* ---------------- 连接后的浏览/操作 ---------------- */

  async disconnect() {
    if (this.id) {
      await invoke(this.proto === "sftp" ? "sftp_disconnect" : "ftp_disconnect", { id: this.id }).catch(() => {});
    }
    this.id = "";
    this.connectedSiteId = null;
    this.setConnected(false);
    this.renderSites();
    this.status(t("已断开"));
    this.el.querySelector<HTMLElement>("#ftp-path")!.textContent = "";
    this.el.querySelector<HTMLElement>("#ftp-tree")!.innerHTML = "";
  }

  private setConnected(on: boolean) {
    ["ftp-refresh", "ftp-up", "ftp-mkdir", "ftp-upload", "ftp-upload-file", "ftp-rename", "ftp-del", "ftp-tools"].forEach((s) => {
      this.el.querySelector<HTMLElement>(`#${s}`)!.classList.toggle("hidden", !on);
    });
    this.el.querySelector("#ftp-connect")!.classList.toggle("hidden", on);
    this.el.querySelector("#ftp-disconnect")!.classList.toggle("hidden", !on);
  }

  async refresh() {
    if (!this.id) return;
    this.status(t("读取目录…"));
    try {
      const res = this.isSftp()
        ? await invoke<FtpListResult>("sftp_list", { id: this.id, path: this.path })
        : await invoke<FtpListResult>("ftp_list", { id: this.id });
      const pwd = this.isSftp() ? this.path : res.pwd;
      if (!this.isSftp()) this.path = pwd;
      this.el.querySelector<HTMLElement>("#ftp-path")!.textContent = pwd;
      const tree = this.el.querySelector<HTMLElement>("#ftp-tree")!;
      tree.innerHTML = "";
      const frag = document.createDocumentFragment();
      if (!this.isSftp() && pwd !== "/") frag.appendChild(this.node("..", true, 0, "", true));
      for (const e of res.entries) {
        const full = this.isSftp() ? join(this.path, e.name) : e.name;
        frag.appendChild(this.node(e.name, e.is_dir, e.size, full));
      }
      tree.appendChild(frag);
      this.status(t("已连接 · {n} 项", { n: res.entries.length }));
    } catch (e) {
      this.status(t("读取失败: {e}", { e: String(e) }));
    }
  }

  private node(name: string, isDir: boolean, size = 0, fullPath = "", isUp = false): HTMLElement {
    const div = document.createElement("div");
    div.className = "ft-node ft-remote-item " + (isDir ? "ft-dir" : "ft-file");
    div.dataset.name = name;
    div.dataset.dir = isDir ? "1" : "0";
    if (fullPath) div.dataset.path = fullPath;
    div.dataset.actions = isUp ? "up" : "";
    const arrow = isDir ? "▸" : "";
    div.innerHTML = `<span class="ft-arrow">${arrow}</span><span class="ft-ico ${isDir ? "ft-dir-ico" : "ft-file"}"></span><span class="ft-name">${escapeHtml(name)}</span><span class="ft-size">${isUp ? "" : fmtSize(size)}</span>`;
    return div;
  }

  private async toggleExpand(elm: HTMLElement) {
    if (!this.id) return;
    const path = elm.dataset.path!;
    const arrow = elm.querySelector<HTMLElement>(".ft-arrow")!;
    const existing = elm.nextElementSibling;
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      elm.classList.remove("expanded");
      arrow.textContent = "▸";
      if (existing && existing.classList.contains("ft-children")) existing.remove();
      return;
    }
    this.expanded.add(path);
    elm.classList.add("expanded");
    arrow.textContent = "▾";
    const box = document.createElement("div");
    box.className = "ft-children";
    box.innerHTML = `<div class="ft-loading">${t("读取中…")}</div>`;
    elm.after(box);
    if (this.loading.has(path)) return;
    this.loading.add(path);
    try {
      const res = await invoke<FtpListResult>("sftp_list", { id: this.id, path });
      box.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (const e of res.entries) {
        frag.appendChild(this.node(e.name, e.is_dir, e.size, join(path, e.name)));
      }
      box.appendChild(frag);
    } catch (e) {
      box.innerHTML = `<div class="ft-loading">${t("失败: {e}", { e: String(e) })}</div>`;
    } finally {
      this.loading.delete(path);
    }
  }

  private cmdInto(name: string) {
    if (!this.id || this.isSftp()) return;
    this.status("…");
    invoke<string>("ftp_cwd", { id: this.id, path: name })
      .then(() => this.refresh())
      .catch((e) => this.status(t("失败: {e}", { e: String(e) })));
  }

  private cmdUp() {
    if (!this.id) return;
    if (this.isSftp()) {
      this.expanded.clear();
      void this.refresh();
      return;
    }
    invoke<string>("ftp_cwd", { id: this.id, path: ".." })
      .then(() => this.refresh())
      .catch((e) => this.status(t("失败: {e}", { e: String(e) })));
  }

  private async download(full: string) {
    if (!this.id) return;
    const name = full.split("/").pop() || full;
    this.status(t("下载 {name}…", { name }));
    try {
      const tmp = this.isSftp()
        ? await invoke<string>("sftp_download", { id: this.id, remotePath: full })
        : await invoke<string>("ftp_download", { id: this.id, remoteName: full });
      this.status(t("已下载到临时文件"));
      this.onOpenRemote(tmp, this.proto, this.id, full);
    } catch (e) {
      this.status(t("下载失败: {e}", { e: String(e) }));
    }
  }

  private async saveAs(full: string) {
    if (!this.id) return;
    const name = full.split("/").pop() || full;
    const target = await dialogSave({ defaultPath: name, title: "下载到本地" });
    if (!target) return;
    this.status(t("下载 {name} → 本地…", { name }));
    try {
      if (this.isSftp()) {
        await invoke("sftp_save_as", { id: this.id, remotePath: full, localPath: target });
      } else {
        await invoke("ftp_save_as", { id: this.id, remoteName: full, localPath: target });
      }
      this.status(t("已保存到 {target}", { target }));
    } catch (e) {
      this.status(t("下载失败: {e}", { e: String(e) }));
    }
  }

  private async doRename() {
    if (!this.id || !this.selectedPath) {
      this.status(t("请先选择一个文件或目录"));
      return;
    }
    const oldPath = this.selectedPath;
    const base = oldPath.split("/").pop() || oldPath;
    const newName = await this.promptText("重命名", "新名称", base);
    if (!newName) return;
    if (newName === base) return;
    this.status(t("重命名 {base} → {newName}…", { base, newName }));
    try {
      if (this.isSftp()) {
        await invoke("sftp_rename", { id: this.id, oldPath, newName });
      } else {
        await invoke("ftp_rename", { id: this.id, oldName: base, newName });
      }
      this.status(t("重命名完成"));
      this.expanded.clear();
      await this.refresh();
    } catch (e) {
      this.status(t("重命名失败: {e}", { e: String(e) }));
    }
  }

  private async delPath(full: string) {
    if (!this.id) return;
    const name = full.split("/").pop() || full;
    if (!await this.confirm(`确定删除 ${name} 吗？`)) return;
    this.status(t("删除 {name}…", { name }));
    try {
      if (this.isSftp()) {
        const isDir = this.expanded.has(full) || full.endsWith("/");
        await invoke("sftp_delete", { id: this.id, path: full, isDir });
      } else {
        await invoke("ftp_delete", { id: this.id, name, isDir: false });
      }
      this.expanded.delete(full);
      this.status(t("已删除"));
      await this.refresh();
    } catch (e) {
      this.status(t("删除失败: {e}", { e: String(e) }));
    }
  }

  private async uploadFiles() {
    if (!this.id) return;
    const picked = await dialogOpen({ multiple: true, title: t("选择要上传的文件") });
    if (!picked) return;
    const files = Array.isArray(picked) ? picked : [picked];
    this.status(t("上传 {n} 个文件…", { n: files.length }));
    try {
      if (this.isSftp()) {
        for (const f of files) {
          await invoke("sftp_upload", { id: this.id, localPath: f, remotePath: join(this.path, baseName(f)) });
        }
      } else {
        for (const f of files) {
          await invoke("ftp_upload", { id: this.id, localPath: f });
        }
      }
      this.status(t("上传完成"));
      this.expanded.clear();
      await this.refresh();
    } catch (e) {
      this.status(t("上传失败: {e}", { e: String(e) }));
    }
  }

  private promptText(title: string, label: string, value = ""): Promise<string | null> {
    return new Promise((resolve) => {
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.innerHTML = `<div class="modal" style="min-width:320px;">
        <div class="modal-title">${escapeHtml(title)}</div>
        <div class="modal-body">
          <label class="acct-f">${escapeHtml(label)}<input id="pt-input" class="fs-input" value="${escapeHtml(value)}" autofocus/></label>
        </div>
        <div class="modal-actions">
          <button class="search-btn" id="pt-ok">确定</button>
          <button class="search-btn" id="pt-cancel">取消</button>
        </div>
      </div>`;
      document.body.appendChild(mask);
      const input = mask.querySelector<HTMLInputElement>("#pt-input")!;
      const done = (v: string | null) => {
        mask.remove();
        resolve(v);
      };
      mask.querySelector("#pt-ok")!.addEventListener("click", () => done(input.value.trim() || null));
      mask.querySelector("#pt-cancel")!.addEventListener("click", () => done(null));
      mask.addEventListener("click", (e) => {
        if (e.target === mask) done(null);
      });
      input.focus();
      input.select();
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") done(input.value.trim() || null);
      });
    });
  }

  private confirm(msg: string): Promise<boolean> {
    return new Promise((resolve) => {
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.innerHTML = `<div class="modal" style="min-width:300px;">
        <div class="modal-title">确认</div>
        <div class="modal-body">${escapeHtml(msg)}</div>
        <div class="modal-actions">
          <button class="search-btn" id="cf-ok">确定</button>
          <button class="search-btn" id="cf-cancel">取消</button>
        </div>
      </div>`;
      document.body.appendChild(mask);
      const done = (v: boolean) => {
        mask.remove();
        resolve(v);
      };
      mask.querySelector("#cf-ok")!.addEventListener("click", () => done(true));
      mask.querySelector("#cf-cancel")!.addEventListener("click", () => done(false));
      mask.addEventListener("click", (e) => {
        if (e.target === mask) done(false);
      });
    });
  }

  private async upload() {
    const local = this.getActivePath();
    if (!local) {
      this.status(t("请先打开一个本地文件再上传"));
      return;
    }
    if (!this.id) return;
    try {
      this.status(t("上传中…"));
      if (this.isSftp()) {
        await invoke("sftp_upload", { id: this.id, localPath: local, remotePath: join(this.path, baseName(local)) });
      } else {
        await invoke("ftp_upload", { id: this.id, localPath: local });
      }
      this.status(t("上传完成"));
      await this.refresh();
    } catch (e) {
      this.status(t("上传失败: {e}", { e: String(e) }));
    }
  }

  private async mkdir() {
    const name = (this.el.querySelector("#ftp-newdir") as HTMLInputElement).value.trim();
    if (!name || !this.id) return;
    try {
      if (this.isSftp()) {
        await invoke("sftp_mkdir", { id: this.id, path: join(this.path, name) });
      } else {
        await invoke("ftp_mkdir", { id: this.id, name });
      }
      (this.el.querySelector("#ftp-newdir") as HTMLInputElement).value = "";
      await this.refresh();
    } catch (e) {
      this.status(t("失败: {e}", { e: String(e) }));
    }
  }

  private async delSelected() {
    if (!this.id) return;
    if (!this.selectedPath) {
      this.status(t("请先选择一个文件或目录"));
      return;
    }
    await this.delPath(this.selectedPath);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
