export interface MarkdownEditResult {
  value: string
  selectionStart: number
  selectionEnd: number
}

export function wrapMarkdownSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  prefix: string,
  suffix = prefix,
  placeholder = "文本",
): MarkdownEditResult {
  const selected = value.slice(selectionStart, selectionEnd) || placeholder
  const inserted = `${prefix}${selected}${suffix}`
  return replaceSelection(value, selectionStart, selectionEnd, inserted, prefix.length, selected.length)
}

export function prefixMarkdownLines(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  prefix: string,
): MarkdownEditResult {
  const lineStart = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1
  const nextLine = value.indexOf("\n", selectionEnd)
  const lineEnd = nextLine === -1 ? value.length : nextLine
  const selected = value.slice(lineStart, lineEnd)
  const inserted = selected
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n")
  return {
    value: `${value.slice(0, lineStart)}${inserted}${value.slice(lineEnd)}`,
    selectionStart: lineStart,
    selectionEnd: lineStart + inserted.length,
  }
}

export function indentMarkdownSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  outdent: boolean,
): MarkdownEditResult {
  const lineStart = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1
  const nextLine = value.indexOf("\n", selectionEnd)
  const lineEnd = nextLine === -1 ? value.length : nextLine
  const lines = value.slice(lineStart, lineEnd).split("\n")
  const inserted = lines
    .map((line) => (outdent ? line.replace(/^ {1,2}/, "") : `  ${line}`))
    .join("\n")
  return {
    value: `${value.slice(0, lineStart)}${inserted}${value.slice(lineEnd)}`,
    selectionStart: lineStart,
    selectionEnd: lineStart + inserted.length,
  }
}

export function insertMarkdownAtSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  text: string,
): MarkdownEditResult {
  const needsLeadingBreak = selectionStart > 0 && value[selectionStart - 1] !== "\n"
  const needsTrailingBreak = selectionEnd < value.length && value[selectionEnd] !== "\n"
  const inserted = `${needsLeadingBreak ? "\n" : ""}${text}${needsTrailingBreak ? "\n" : ""}`
  return replaceSelection(value, selectionStart, selectionEnd, inserted, inserted.length, 0)
}

function replaceSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  inserted: string,
  selectionOffset: number,
  selectedLength: number,
): MarkdownEditResult {
  const nextStart = selectionStart + selectionOffset
  return {
    value: `${value.slice(0, selectionStart)}${inserted}${value.slice(selectionEnd)}`,
    selectionStart: nextStart,
    selectionEnd: nextStart + selectedLength,
  }
}
