const https = require("https");
const http = require("http");

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM = new URL("https://axscripts.up.railway.app");
const APP_ORIGIN = process.env.RAILWAY_PUBLIC_DOMAIN
  ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN
  : "";

const headInjection = [
  '<link rel="manifest" href="/app.webmanifest">',
  '<meta name="theme-color" content="#09090b">',
  '<meta name="application-name" content="AXScripts">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<meta name="apple-mobile-web-app-title" content="AXScripts">',
  '<link rel="icon" href="/app-icon.svg" type="image/svg+xml">',
  '<link rel="apple-touch-icon" href="/app-icon.svg">',
  '<script src="/install.js" defer></script>'
].join("");

function sendLocal(res, status, type, body) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/app.webmanifest") return sendLocal(res, 200, "application/manifest+json; charset=utf-8", "{\n  \"name\": \"AXScripts\",\n  \"short_name\": \"AXScripts\",\n  \"description\": \"Your AXScripts website, ready to install.\",\n  \"start_url\": \"/\",\n  \"scope\": \"/\",\n  \"display\": \"standalone\",\n  \"display_override\": [\n    \"standalone\",\n    \"minimal-ui\"\n  ],\n  \"background_color\": \"#09090b\",\n  \"theme_color\": \"#09090b\",\n  \"icons\": [\n    {\n      \"src\": \"/app-icon.svg\",\n      \"sizes\": \"any\",\n      \"type\": \"image/svg+xml\",\n      \"purpose\": \"any maskable\"\n    }\n  ]\n}");
  if (pathname === "/app-icon.svg") return sendLocal(res, 200, "image/svg+xml; charset=utf-8", "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><rect width=\"512\" height=\"512\" rx=\"112\" fill=\"#09090b\"/><path d=\"M112 365 222 116h68l110 249h-75l-20-50H205l-20 50zm117-108h53l-26-69z\" fill=\"#fff\"/><path d=\"m325 128 71 72-38 38-71-72z\" fill=\"#9ca3af\"/></svg>");
  if (pathname === "/sw.js") return sendLocal(res, 200, "application/javascript; charset=utf-8", "self.addEventListener('install', event => { self.skipWaiting(); });\nself.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });\nself.addEventListener('fetch', event => {\n  if (event.request.method !== 'GET') return;\n  event.respondWith(fetch(event.request));\n});");
  if (pathname === "/install.js") return sendLocal(res, 200, "application/javascript; charset=utf-8", "(() => {\n  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));\n  let deferredPrompt;\n  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;\n  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;\n  if (standalone) return;\n  const button = document.createElement('button');\n  button.textContent = 'Install AXScripts';\n  button.setAttribute('aria-label', 'Install AXScripts app');\n  button.style.cssText = 'position:fixed;z-index:2147483000;right:16px;bottom:16px;padding:12px 17px;border:1px solid rgba(255,255,255,.2);border-radius:999px;background:#111;color:#fff;font:600 13px system-ui;box-shadow:0 8px 28px #0008;cursor:pointer';\n  const add = () => document.body.appendChild(button);\n  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);\n  else add();\n  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredPrompt = event; });\n  button.addEventListener('click', async () => {\n    if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; button.remove(); }\n    else if (isIOS) alert('To install AXScripts: tap Share, then “Add to Home Screen”.');\n    else alert('Open your browser menu and choose “Install app” or “Add to Home screen”.');\n  });\n})();");

  const headers = { ...req.headers, host: UPSTREAM.host, "accept-encoding": "identity" };
  delete headers["content-length"];
  headers["x-forwarded-host"] = req.headers.host || "";
  headers["x-forwarded-proto"] = "https";

  const proxyReq = https.request({
    protocol: UPSTREAM.protocol,
    hostname: UPSTREAM.hostname,
    port: UPSTREAM.port || 443,
    method: req.method,
    path: req.url,
    headers
  }, proxyRes => {
    const responseHeaders = { ...proxyRes.headers };
    const appOrigin = APP_ORIGIN || ("https://" + (req.headers.host || ""));
    if (responseHeaders.location) responseHeaders.location = responseHeaders.location.split(UPSTREAM.origin).join(appOrigin);
    if (responseHeaders["set-cookie"]) {
      responseHeaders["set-cookie"] = responseHeaders["set-cookie"].map(cookie => cookie.replace(/; Domain=[^;]+/i, ""));
    }

    const isHtml = String(responseHeaders["content-type"] || "").includes("text/html") && req.method !== "HEAD";
    if (isHtml && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
      const chunks = [];
      proxyRes.on("data", chunk => chunks.push(chunk));
      proxyRes.on("end", () => {
        let html = Buffer.concat(chunks).toString("utf8");
        html = html.split(UPSTREAM.origin).join(appOrigin);
        const lower = html.toLowerCase();
        const headStart = lower.indexOf("<head");
        if (headStart !== -1) {
          const headEnd = html.indexOf(">", headStart);
          if (headEnd !== -1) html = html.slice(0, headEnd + 1) + headInjection + html.slice(headEnd + 1);
        }
        const bodyEnd = html.toLowerCase().lastIndexOf("</body>");
        if (bodyEnd !== -1) html = html.slice(0, bodyEnd) + html.slice(bodyEnd);
        delete responseHeaders["content-length"];
        delete responseHeaders.etag;
        delete responseHeaders["content-encoding"];
        res.writeHead(proxyRes.statusCode, responseHeaders);
        res.end(html);
      });
    } else {
      res.writeHead(proxyRes.statusCode, responseHeaders);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on("error", error => {
    console.error("Upstream proxy error:", error.message);
    if (!res.headersSent) sendLocal(res, 502, "text/plain; charset=utf-8", "AXScripts is temporarily unavailable. Please try again.");
    else res.end();
  });
  req.pipe(proxyReq);
});

server.listen(PORT, "0.0.0.0", () => console.log("AXScripts PWA proxy listening on " + PORT));
