import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4317,
    strictPort: false,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.OMNISCI_GATEWAY_PORT ?? "4318"}`,
        headers: process.env.OMNISCI_WEB_TOKEN
          ? { "x-omnisci-token": process.env.OMNISCI_WEB_TOKEN }
          : undefined,
      },
    },
  },
});
