import type { OcrTextLayoutMode } from "../types"

export const OCR_TEXT_LAYOUT_OPTIONS: {
  value: OcrTextLayoutMode
  label: string
  description: string
}[] = [
  { value: "auto", label: "自动判断", description: "根据 OCR 文本形态自动选择重排策略" },
  { value: "preserve", label: "保留原样", description: "保留 OCR 行结构，适合菜单、表格和代码" },
  { value: "conservative", label: "保守合并", description: "只合并明显的视觉折行，适合字幕和混合内容" },
  { value: "paragraph", label: "段落优先", description: "尽量整理为自然段，适合网页、PDF 和文档" },
]

export function formatTranslationForPanel(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim()
  if (!normalized) return ""

  if (normalized.includes("\n")) {
    return normalized
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
  }

  return normalized
    .replace(/([。！？!?；;][”’"』」】）》）]*)\s*/g, "$1\n")
    .replace(/([.][”’"』」】）》）]*)\s+(?=[A-Z0-9\u4e00-\u9fff])/g, "$1\n")
    .replace(/([:：])\s+(?=(?:[-*•]|\d+[.)、]))/g, "$1\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
