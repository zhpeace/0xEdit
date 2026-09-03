import type { EditorState } from "@codemirror/state";

export type DocMode = "text" | "hex";

export interface RemoteRef {
  proto: "ftp" | "sftp" | "ftps";
  id: string;
  path: string;
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
  state?: EditorState;
  hexBytes?: Uint8Array;
  hexDirty?: boolean;
  size: number;
  truncated: boolean;
  scrollTop?: number;
  wrap?: boolean;
  showWs?: boolean;
  remote?: RemoteRef;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}