import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: resolve(root, "public"),
  plugins: [wasm()],
  build: {
    outDir: resolve(root, "node_modules/.cache/x-chat-web"),
    emptyOutDir: true,
    target: "esnext",
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
});
