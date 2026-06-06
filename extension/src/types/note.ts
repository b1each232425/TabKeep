export interface NoteAdapterConfig {
  provider: "local" | "siyuan" | "obsidian"
  endpoint?: string
  token?: string
  vault?: string
  defaultNotebook?: string
  defaultTargetDoc?: string
}

export interface NotebookInfo {
  id: string
  name: string
}

export interface DocNode {
  id: string
  name: string
  path: string
  type: string
  children: DocNode[]
}

export interface SaveTabResult {
  ok: boolean
  note_id?: string
  error?: string
}
