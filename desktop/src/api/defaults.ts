import type {
  KnowledgeConfig,
  ModelConfig,
  NoteAdapterConfig,
  OcrConfig,
  RegionBoxConfig,
  SelectionTranslateConfig,
  TranslateProviderConfig,
} from "../types"

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  model: "",
  baseURL: "",
  apiKey: "",
}

export const DEFAULT_NOTE_ADAPTER: NoteAdapterConfig = {
  provider: "local",
}

export const DEFAULT_OCR_CONFIG: OcrConfig = {
  provider: "paddleocr_json",
  paddleExePath: "",
  paddleModelsPath: "",
  paddleConfigPath: "",
  paddleMinScore: 0.45,
  preprocessEnabled: true,
  preprocessScale: 2,
  preprocessGrayscale: true,
  preprocessContrast: 18,
  preprocessSharpen: true,
  preprocessThreshold: false,
  textPostprocessEnabled: true,
  textMergeLines: false,
  textLayoutMode: "auto",
}

export const DEFAULT_REGION_BOX_CONFIG: RegionBoxConfig = {
  x: 160,
  y: 160,
  width: 640,
  height: 180,
  passThrough: false,
  sourceLang: "auto",
  targetLang: "简体中文",
  panelX: null,
  panelY: null,
  panelWidth: 420,
  panelHeight: 150,
}

export const DEFAULT_TRANSLATE_PROVIDER_CONFIG: TranslateProviderConfig = {
  provider: "openai_compatible",
  baiduAppId: "",
  baiduSecret: "",
  volcengineAccessKey: "",
  volcengineSecretKey: "",
  volcengineRegion: "cn-north-1",
}

export const DEFAULT_SELECTION_TRANSLATE_CONFIG: SelectionTranslateConfig = {
  enabled: true,
  hotkey: "Ctrl+Alt+T",
  sourceLang: "auto",
  targetLang: "简体中文",
  hotkeyError: null,
}

export const DEFAULT_EMBEDDING_BASE_URL = "https://api.siliconflow.cn/v1"
export const DEFAULT_EMBEDDING_MODEL = "BAAI/bge-m3"

export const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeConfig = {
  enabled: true,
  markdownPaths: [],
  maxFileBytes: 1_000_000,
  embedding: {
    enabled: false,
    baseURL: DEFAULT_EMBEDDING_BASE_URL,
    apiKey: "",
    model: DEFAULT_EMBEDDING_MODEL,
  },
}
