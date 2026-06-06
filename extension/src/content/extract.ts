import Defuddle from "defuddle"

export default defineUnlistedScript({
  matches: ["<all_urls>"],

  main() {
    console.log("[TabKeep] content script extract 加载", location.href)

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === "EXTRACT_CONTENT") {
        const start = Date.now()
        console.log("[TabKeep] extract 开始 url=", location.href, "title=", document.title)
        try {
          if (typeof Defuddle !== "function" && typeof (Defuddle as any)?.default === "function") {
            const DefuddleCtor = (Defuddle as any).default
            handleExtract(DefuddleCtor, sendResponse, start)
          } else {
            handleExtract(Defuddle as any, sendResponse, start)
          }
        } catch (e) {
          console.error("[TabKeep] extract 异常:", e)
          sendResponse({ ok: false, error: String(e) })
        }
        return true
      }
    })
  }
})

function handleExtract(DefuddleCtor: any, sendResponse: (r: any) => void, start: number) {
  try {
    const result = new DefuddleCtor(document, { markdown: true }).parse()
    const elapsed = Date.now() - start
    console.log(
      `[TabKeep] extract ok url=${location.href} elapsed=${elapsed}ms ` +
        `title=${result.title} md_len=${(result.contentMarkdown ?? "").length} ` +
        `html_len=${(result.content ?? "").length} wordCount=${result.wordCount}`
    )
    sendResponse({
      ok: true,
      data: {
        title: result.title ?? document.title ?? "",
        content: result.content ?? "",
        contentMarkdown: result.contentMarkdown ?? "",
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
