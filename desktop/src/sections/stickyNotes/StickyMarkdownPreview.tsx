import type { ReactNode } from "react"

interface StickyMarkdownPreviewProps {
  content: string
}

type CodeBlock = {
  kind: "code"
  text: string
}

type TextBlock = {
  kind: "text"
  text: string
}

type Block = CodeBlock | TextBlock

export function StickyMarkdownPreview({ content }: StickyMarkdownPreviewProps) {
  const blocks = splitBlocks(content)
  if (blocks.length === 0) {
    return <div className="tk-sticky-markdown-empty">暂无预览内容</div>
  }

  return (
    <div className="tk-sticky-markdown-preview">
      {blocks.map((block, index) =>
        block.kind === "code" ? (
          <pre key={index}>
            <code>{block.text}</code>
          </pre>
        ) : (
          renderTextBlock(block.text, index)
        ),
      )}
    </div>
  )
}

function splitBlocks(content: string): Block[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const blocks: Block[] = []
  let paragraph: string[] = []
  let code: string[] | null = null

  const flushParagraph = () => {
    const text = paragraph.join("\n").trim()
    if (text) blocks.push({ kind: "text", text })
    paragraph = []
  }

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (code) {
        blocks.push({ kind: "code", text: code.join("\n") })
        code = null
      } else {
        flushParagraph()
        code = []
      }
      continue
    }
    if (code) {
      code.push(line)
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      continue
    }
    paragraph.push(line)
  }
  if (code) blocks.push({ kind: "code", text: code.join("\n") })
  flushParagraph()
  return blocks
}

function renderTextBlock(text: string, key: number): ReactNode {
  const firstLine = text.split("\n")[0]?.trim() ?? ""
  const heading = /^(#{1,4})\s+(.+)$/.exec(firstLine)
  if (heading) {
    const level = heading[1].length
    const children = renderInline(heading[2])
    if (level === 1) return <h1 key={key}>{children}</h1>
    if (level === 2) return <h2 key={key}>{children}</h2>
    if (level === 3) return <h3 key={key}>{children}</h3>
    return <h4 key={key}>{children}</h4>
  }

  const lines = text.split("\n")
  if (lines.every((line) => /^\s*[-*+]\s+/.test(line))) {
    return (
      <ul key={key}>
        {lines.map((line, index) => (
          <li key={index}>{renderInline(line.replace(/^\s*[-*+]\s+/, ""))}</li>
        ))}
      </ul>
    )
  }
  if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
    return (
      <ol key={key}>
        {lines.map((line, index) => (
          <li key={index}>{renderInline(line.replace(/^\s*\d+\.\s+/, ""))}</li>
        ))}
      </ol>
    )
  }
  if (lines.every((line) => /^\s*>\s?/.test(line))) {
    return (
      <blockquote key={key}>
        {lines.map((line, index) => (
          <p key={index}>{renderInline(line.replace(/^\s*>\s?/, ""))}</p>
        ))}
      </blockquote>
    )
  }

  return (
    <p key={key}>
      {lines.map((line, index) => (
        <span key={index}>
          {index > 0 && <br />}
          {renderInline(line)}
        </span>
      ))}
    </p>
  )
}

function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`)/g)
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>
    }
    return <span key={index}>{part}</span>
  })
}
