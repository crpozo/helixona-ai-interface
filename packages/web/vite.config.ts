/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  // En modo demo (vista previa publicada) los assets se referencian de forma relativa.
  base: mode === "demo" ? "./" : "/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: mode === "demo" ? "dist-demo" : "dist",
    target: "es2022",
    sourcemap: false,
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
}));
