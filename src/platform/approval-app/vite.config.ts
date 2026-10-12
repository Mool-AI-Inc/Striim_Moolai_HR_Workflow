/** @lifespan PRODUCTION — Vite build/dev config for the approval SPA. */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Where the demo API listens. Override with API_TARGET if you move it. */
const API = process.env.API_TARGET ?? "http://127.0.0.1:8090";

/**
 * Proxy the API routes in dev so the SPA works with a bare `npm run ui:dev`.
 *
 * Without this the app depends on VITE_APPROVAL_API being set in the shell that starts
 * Vite. When it is missing the client falls back to a relative URL, Vite answers with its
 * own index.html for the SPA fallback, `r.json()` chokes on the HTML, and the UI reports
 * "Couldn't reach the demo API" — which points at the API, the one thing that is fine.
 * A forgettable environment variable is a bad dependency for a live demo, so dev proxies
 * these routes instead. VITE_APPROVAL_API still works for pointing at a remote API.
 */
const API_ROUTES = [
  "/approvals", "/journey", "/employees", "/run",
  "/clock", "/scans", "/reports", "/migration", "/hris", "/webhooks",
];

export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL(".", import.meta.url)),   // this folder is the SPA root (index.html lives here)
  server: {
    proxy: Object.fromEntries(
      API_ROUTES.map((route) => [route, { target: API, changeOrigin: true }]),
    ),
  },
});
