// LLM 配置 —— 对应后端 /config/sync 里的 modelConfig 字段
// 存在 chrome.storage.local["modelConfig"] 里
export interface ModelConfig {
  model: string                       // 模型名,如 "gpt-4" / "MiniMax-M3"
  baseURL: string                     // OpenAI 兼容 API base URL
  apiKey: string                      // 鉴权 key
}
