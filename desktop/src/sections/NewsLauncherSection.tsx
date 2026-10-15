import { ArrowUpRight, LoaderCircle, Newspaper } from "lucide-react"

import { Button, Notice } from "../components/primitives"

export function NewsLauncherSection({
  opening,
  message,
  error,
  onOpen,
}: {
  opening: boolean
  message: string
  error: string
  onOpen: () => void
}) {
  return (
    <section className="flex min-h-full items-center justify-center px-6 py-12">
      <div className="w-full max-w-lg rounded-xl border border-sky-100 bg-white/90 p-8 text-center shadow-sm">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-sky-50 text-sky-700">
          <Newspaper aria-hidden="true" className="h-6 w-6" />
        </span>
        <h1 className="mt-4 text-lg font-semibold text-slate-900">TabKeep 资讯</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-600">
          在独立阅读页管理订阅源、浏览本地采集的帖子和文章。资讯内容保存在这台电脑上。
        </p>
        {error && <div className="mt-5 text-left"><Notice tone="warning">{error}</Notice></div>}
        {message && !error && <div className="mt-5 text-left"><Notice tone="success">{message}</Notice></div>}
        <Button className="mt-6" type="button" disabled={opening} onClick={onOpen}>
          {opening ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <ArrowUpRight aria-hidden="true" className="h-4 w-4" />}
          {opening ? "正在打开…" : "在浏览器中打开资讯"}
        </Button>
      </div>
    </section>
  )
}
