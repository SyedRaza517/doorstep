import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
        /* The alerts stream holds a long-lived connection. Without this
           handler, restarting the API drops that socket and the unhandled
           proxy error takes the whole dev server down with it. */
        configure: (proxy) => {
          proxy.on("error", (err, _req, res) => {
            if (res && !res.headersSent && res.writeHead) {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Can't reach the server - is it running?" }));
            }
          });
        },
      },
    },
  },
});
