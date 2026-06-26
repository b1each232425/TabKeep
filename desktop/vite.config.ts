import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        eval: resolve(__dirname, "eval.html"),
      },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
})
