// Content Script —— 注入到所有页面,响应 background 发的 EXTRACT_CONTENT 消息。
//
// 工作流程:
//   1. Defuddle 抽取页面正文 HTML(它做了去噪 / 选主区域 / 提元数据)
//   2. Turndown + gfm 插件把 HTML 转 markdown
//   3. 把 {title, html, contentMarkdown, author, site, description, wordCount, image} 传回 background
//
// 注意:
//   - 不引用 defuddle/full(那是个被上游 terser bug 污染的 bundle)
//   - 不在 content script 里跑 LLM / 调后端,只做"提取",LLM 留给 background + 后端

import Defuddle from "defuddle"
import TurndownService from "turndown"
import { gfm } from "@joplin/turndown-plugin-gfm"

console.log("[TabKeep] content script extract 加载", location.href)

// ─────────────────────────────────────────────────────────────
// 全局 Turndown 实例(每个 content script 注入只创建一次)
//   - headingStyle:atx → 用 # 而非 ===/--- 表示标题
//   - codeBlockStyle:fenced → 用 ``` 围栏
//   - bulletListMarker:- → 列表项用 - 而非 *
//   - .use(gfm) → 启用 GitHub Flavored Markdown(表格 / 删除线 / 任务列表)
// ─────────────────────────────────────────────────────────────
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" })
turndown.use(gfm)


// ─────────────────────────────────────────────────────────────
// 消息监听:只处理 EXTRACT_CONTENT
// return true 保持 sendResponse 通道异步(因为下面 handleExtract 里用了 setTimeout/console.log 后才 sendResponse)
// ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "EXTRACT_CONTENT") {
    const start = Date.now()
    console.log("[TabKeep] extract 开始 url=", location.href, "title=", document.title)
    try {
      // Defuddle 既可能是函数(ESM)也可能是 {default: fn}(CJS) — 容错取函数
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


// ─────────────────────────────────────────────────────────────
// 真正的提取流程(走 Defuddle 拿 HTML,再 Turndown 转 markdown)
// ─────────────────────────────────────────────────────────────
function handleExtract(
  DefuddleCtor: any,
  sendResponse: (r: any) => void,
  start: number
) {
  try {
    // Defuddle 第二参数 {markdown: false}:我们只要 HTML,自己用 turndown 转
    // (若用 markdown: true,defuddle 0.18.1 那个 bug bundle 会被加载 → 整页语法错)
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
