// 平台感知的本地路径工具
// macOS/Linux 用 `/` 分隔；Windows 用 `\` 分隔且带盘符（C:\）或 UNC 前缀（\\server\share）。
// Rust 侧 list_dir 等在 Windows 上返回的是 `C:\...` 反斜杠路径，前端显示与取文件名必须兼容两者。

/** 取路径最后一段（文件名/目录名），兼容 `/` 与 `\`；根路径返回自身（/ 或 C:） */
export function pathBase(p: string): string {
  if (p === "/") return "/";
  if (/^[A-Za-z]:[\\/]?$/.test(p)) return p.replace(/[\\/]$/, "");
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/** 拆本地路径为面包屑层级（含根节点），返回 {label, path} 累积列表 */
export function localCrumbs(p: string): Array<{ label: string; path: string }> {
  // Windows 盘符路径：C:\Users\hp\Docs
  if (/^[A-Za-z]:[\\/]/.test(p)) {
    const norm = p.replace(/\//g, "\\");
    const parts = norm.split("\\").filter(Boolean);
    const out: Array<{ label: string; path: string }> = [];
    let acc = "";
    for (const part of parts) {
      if (/^[A-Za-z]:$/.test(part)) acc = part + "\\";
      else acc += part + "\\";
      out.push({ label: part, path: acc });
    }
    return out;
  }
  // Windows UNC 路径：\\server\share\dir
  if (p.startsWith("\\\\")) {
    const m = p.match(/^\\\\[^\\]+/);
    const root = m ? m[0] : p;
    const rest = p.slice(root.length).replace(/^\\+/, "");
    const out: Array<{ label: string; path: string }> = [];
    let acc = root + "\\";
    out.push({ label: root, path: acc });
    for (const part of rest.split("\\").filter(Boolean)) {
      acc += part + "\\";
      out.push({ label: part, path: acc });
    }
    return out;
  }
  // POSIX（macOS / Linux）
  const parts = p.split("/").filter(Boolean);
  const out: Array<{ label: string; path: string }> = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc += "/" + part;
    out.push({ label: part, path: acc });
  }
  return out;
}
