import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["pwa-icon-192.png", "pwa-icon-512.png"],
      manifest: {
        name: "InvestAlpha 投顧報告",
        short_name: "InvestAlpha",
        description: "投顧報告 · 籌碼面 · 技術面評分",
        theme_color: "#0B1E3D",
        background_color: "#0B1E3D",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        lang: "zh-TW",
        icons: [
          {
            src: "pwa-icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "pwa-icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        // 只快取靜態資源，API 走 network-only
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8000",
      },
    },
  },
});
