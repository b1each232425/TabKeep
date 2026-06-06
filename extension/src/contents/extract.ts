import Defuddle from "defuddle"
import TurndownService from "turndown"
import { gfm } from "@joplin/turndown-plugin-gfm"

console.log("[TabKeep] content script extract 加载", location.href)

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" })
turndown.use(gfm)

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "EXTRACT_CONTENT") {
    const start = Date.now()
    console.log("[TabKeep] extract 开始 url=", location.href, "title=", document.title)
    try {
      const DefuddleCtor: any =
        typeof Defuddle === "function" ? Defuddle : (Defuddle as any).default
      handleExtract(DefuddleCtor, sendResponse, start)
    } catch (e) {
      console.error("[TabKeep] extract 异常:", e)
      sendResponse({ ok: false, error: String(e) })
    }
    return true
  }
})

function handleExtract(
  DefuddleCtor: any,
  sendResponse: (r: any) => void,
  start: number
) {
  try {
    const result = new DefuddleCtor(document, { markdown: false }).parse()
    const html: string = result.content ?? ""
    const contentMarkdown = html ? turndown.turndown(html) : ""
    const elapsed = Date.now() - start
    console.log(
      `[TabKeep] extract ok url=${location.href} elapsed=${elapsed}ms ` +
        `title=${result.title} md_len=${contentMarkdown.length} ` +
        `html_len=${html.length} wordCount=${result.wordCount}`
    )
    sendResponse({
      ok: true,
      data: {
        title: result.title ?? document.title ?? "",
        content: html,
        contentMarkdown,
        author: result.author ?? "",
        site: result.site ?? "",
        description: result.description ?? "",
        wordCount: result.wordCount ?? 0,
        image: result.image ?? ""
      }
    })
  } catch (e) {
    console.error("[TabKeep] Defuddle parse 失败:", e)
    sendResponse({ ok: false, error: `Defuddle parse 失败: ${e}` })
  }
}
