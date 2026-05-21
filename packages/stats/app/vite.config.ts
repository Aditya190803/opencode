import { solidStart } from "@solidjs/start/config"
import { nitro } from "nitro/vite"
import { defineConfig, type PluginOption } from "vite"

export default defineConfig({
  plugins: [solidStart() as PluginOption, nitro()],
  server: {
    allowedHosts: true,
  },
  build: {
    minify: false,
  },
})
