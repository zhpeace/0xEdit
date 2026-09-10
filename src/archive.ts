// 归档（tar/tar.gz/tar.bz2/zip）虚拟文件夹支持：共享类型与工具函数

export interface ArchiveEntry {
  name: string;
  size: number;
  is_dir: boolean;
}

export interface ArchiveNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  children: ArchiveNode[];
}

// 大文件确认阈值（字节）：超过则提示下载/回写可能耗时
export const ARCHIVE_BIG_BYTES = 50 * 1024 * 1024;

// 可内联展开的归档扩展名（后端可解析：zip 家族 + tar 家族 + bsdtar 支持的外部格式）
const ARCHIVE_EXT_RE = /\.(tar\.gz|tar\.bz2|tar\.xz|tar\.zst|tgz|tbz2|txz|tzst|tar|zip|zipx|jar|war|ear|apk|aar|rar|7z|iso|cab|cpio|deb|rpm|zst|lz4)$/i;

export function isArchiveFile(name: string): boolean {
  return ARCHIVE_EXT_RE.test(name);
}

// 归档内条目名 → 归档格式（用于存档/展示）
export function archiveKindOf(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".zip") || n.endsWith(".zipx") || n.endsWith(".jar") || n.endsWith(".war") || n.endsWith(".ear") || n.endsWith(".apk") || n.endsWith(".aar")) return "zip";
  if (n.endsWith(".rar")) return "rar";
  if (n.endsWith(".7z")) return "7z";
  if (n.endsWith(".tar.gz") || n.endsWith(".tgz")) return "tar.gz";
  if (n.endsWith(".tar.bz2") || n.endsWith(".tbz2")) return "tar.bz2";
  if (n.endsWith(".tar.xz") || n.endsWith(".txz")) return "tar.xz";
  if (n.endsWith(".tar.zst") || n.endsWith(".tzst")) return "tar.zst";
  const ext = n.split(".").pop() || n;
  return ext === "gz" || ext === "bz2" ? "tar" : ext;
}

// 取归档树中指定目录（"" 表示根）的直接子节点
export function findArchiveChildren(nodes: ArchiveNode[], dir: string): ArchiveNode[] {
  if (!dir) return nodes;
  const parts = dir.split("/");
  let level = nodes;
  for (const p of parts) {
    const n = level.find((x) => x.name === p && x.isDir);
    if (!n) return [];
    level = n.children;
  }
  return level;
}

// 平铺归档条目 → 树结构
export function buildArchiveTree(entries: ArchiveEntry[]): ArchiveNode[] {
  const root: ArchiveNode[] = [];
  for (const e of entries) {
    const parts = e.name.split("/");
    let level = root;
    let cur = "";
    for (let i = 0; i < parts.length; i++) {
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      const isLast = i === parts.length - 1;
      let node = level.find((n) => n.path === cur);
      if (!node) {
        node = {
          name: parts[i],
          path: cur,
          isDir: !isLast || e.is_dir,
          size: isLast && !e.is_dir ? e.size : 0,
          children: [],
        };
        level.push(node);
      }
      if (!isLast) level = node.children;
    }
  }
  return root;
}
