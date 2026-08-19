import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  /* Relative asset paths. On the web this changes nothing, but inside the
     Android and iOS WebView the page is not served from a site root, so
     "/assets/index.js" resolves to nothing and the app opens as a white
     screen with no error to see. */
  base: "./",
  plugins: [
    react(),
    /* Vite marks its module script crossorigin. The WebView then treats
       loading the app's own code as a cross-origin request, and blocks it.
       Nothing on the page is cross-origin, so the attribute only does harm. */
    {
      name: "doorstep-no-crossorigin",
      transformIndexHtml: (html) => html.replace(/ crossorigin(="[^"]*")?/g, ""),
    },
  ],
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
