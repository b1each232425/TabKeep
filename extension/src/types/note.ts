// 笔记集成相关类型 —— 对应后端 /notes/* 路由的请求 / 响应

// ─────────────────────────────────────────────────────────────
// 1. NoteAdapterConfig: 笔记适配器配置
// ─────────────────────────────────────────────────────────────
export interface NoteAdapterConfig {
  provider: "local" | "siyuan" | "obsidian"
  endpoint?: string                   // SiYuan: http://127.0.0.1:6806
  token?: string                      // SiYuan API token
  vault?: string                      // Obsidian/Markdown vault 或普通文件夹路径
  defaultFolder?: string              // Obsidian/Markdown 默认保存目录
  writeMode?: "new_file" | "append"  // Obsidian/Markdown 写入模式
  defaultNotebook?: string            // 默认笔记本 id(留空让弹窗选)
  defaultTargetDoc?: string           // 默认目标 doc id(留空 = 每次新建)
}

// ─────────────────────────────────────────────────────────────
// 2. 笔记本 / 文档树
// ─────────────────────────────────────────────────────────────
export interface NotebookInfo {
  id: string
  name: string
}

export interface DocNode {
  id: string                          // 块 id(SiYuan insertBlock 用)或 Markdown 相对路径
  name: string                        // 文档名
  path: string                        // 人类可读路径
  type: string                        // "Container" 文件夹 | "Page" 文档
  children: DocNode[]                 // 递归
}

// ─────────────────────────────────────────────────────────────
// 3. /notes/save 响应
// ─────────────────────────────────────────────────────────────
export interface SaveTabResult {
  ok: boolean
  note_id?: string                    // 成功时返回新建/追加的 doc id
  error?: string                      // 失败时填原因
}
