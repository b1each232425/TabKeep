import { useEffect, useState, type ReactNode } from "react"
import { Check, Copy } from "lucide-react"
import Markdown, { defaultUrlTransform, type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import { loadStickyNoteImage } from "../../api/stickyNotes"

interface StickyMarkdownPreviewProps {
  content: string
  noteId: string
}

const imageCache = new Map<string, Promise<string>>()

export function StickyMarkdownPreview({ content, noteId }: StickyMarkdownPreviewProps) {
  if (!content.trim()) {
    return <div className="tk-sticky-markdown-empty">暂无预览内容</div>
  }

  const components: Components = {
    pre: ({ children }) => <StickyCodeBlock>{children}</StickyCodeBlock>,
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
    img: ({ src, alt }) => <StickyMarkdownImage noteId={noteId} src={src} alt={alt} />,
    input: (props) => <input {...props} disabled />,
  }

  return (
    <div className="tk-sticky-markdown-preview">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={(url) =>
          url.startsWith("sticky-asset://") ? url : defaultUrlTransform(url)
        }>
        {content}
      </Markdown>
    </div>
  )
}

function StickyCodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const text = extractText(children).replace(/\n$/, "")

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="tk-sticky-code-block">
      <pre>{children}</pre>
      <button
        type="button"
        className="tk-sticky-code-copy"
        title="复制代码"
        aria-label="复制代码"
        onClick={() => void copy()}>
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}

function StickyMarkdownImage({
  noteId,
  src,
  alt,
}: {
  noteId: string
  src?: string
  alt?: string
}) {
  const [resolvedSrc, setResolvedSrc] = useState(() =>
    src?.startsWith("sticky-asset://") ? "" : src ?? "",
  )
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
    if (!src?.startsWith("sticky-asset://")) {
      setResolvedSrc(src ?? "")
      return
    }

    const fileName = src.slice("sticky-asset://".length)
    const cacheKey = `${noteId}:${fileName}`
    let request = imageCache.get(cacheKey)
    if (!request) {
      request = loadStickyNoteImage(noteId, fileName)
      imageCache.set(cacheKey, request)
    }
    let active = true
    void request
      .then((dataUrl) => {
        if (active) setResolvedSrc(dataUrl)
      })
      .catch(() => {
        imageCache.delete(cacheKey)
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [noteId, src])

  if (failed) {
    return <span className="tk-sticky-image-error">图片无法显示</span>
  }
  if (!resolvedSrc) {
    return <span className="tk-sticky-image-loading">正在加载图片</span>
  }
  return <img src={resolvedSrc} alt={alt ?? ""} loading="lazy" />
}

function extractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (!node || typeof node === "boolean") return ""
  if (Array.isArray(node)) return node.map(extractText).join("")
  if (typeof node === "object" && "props" in node) {
    return extractText((node as { props?: { children?: ReactNode } }).props?.children)
  }
  return ""
}
