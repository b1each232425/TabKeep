import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const desktopDir = fileURLToPath(new URL(".", import.meta.url))
const readerDir = resolve(desktopDir, "news-reader")
const newsBackendUrl = process.env.TABKEEP_NEWS_BACKEND_URL ?? "http://127.0.0.1:38471"

export default defineConfig(({ command }) => ({
  root: readerDir,
  // The desktop and news reader share a package.json, so Vite would otherwise
  // reuse the desktop app's dependency optimizer cache for this second dev server.
  cacheDir: resolve(desktopDir, "node_modules/.vite-news-reader"),
  base: command === "serve" ? "/" : "/reader/",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5176,
    strictPort: true,
    proxy: {
      "/news": {
        target: newsBackendUrl,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(desktopDir, "../backend/web_static"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(readerDir, "index.html"),
    },
  },
}))
