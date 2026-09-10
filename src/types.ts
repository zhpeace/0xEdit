import type { EditorState } from "@codemirror/state";

export type DocMode = "text" | "hex";

export interface RemoteRef {
  proto: "ftp" | "sftp" | "ftps";
  id: string;
  path: string;
}

export interface ArchiveRef {
  kind: string; // "tar" | "tar.gz" | "tar.bz2" | "zip"
  entry: string; // 归档内条目路径
  tmpPath: string; // 已下载归档的本地路径
  archiveName: string; // 原归档文件名（FTP 回写需同名）
}

export interface Document {
  id: string;
  path: string;
  name: string;
  encoding: string;
  lineEnding: string;
  isBinary: boolean;
  mode: DocMode;
  dirty: boolean;
  savedContent?: string;
  state?: EditorState;
  hexBytes?: Uint8Array;
  hexDirty?: boolean;
  size: number;
  truncated: boolean;
  scrollTop?: number;
  wrap?: boolean;
  showWs?: boolean;
  remote?: RemoteRef;
  archive?: ArchiveRef;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified?: number;
}