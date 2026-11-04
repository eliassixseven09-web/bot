(() => {
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  let deferredPrompt;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (standalone) return;
  const button = document.createElement('button');
  button.textContent = 'Install AXScripts';
  button.setAttribute('aria-label', 'Install AXScripts app');
  button.style.cssText = 'position:fixed;z-index:2147483000;right:16px;bottom:16px;padding:12px 17px;border:1px solid rgba(255,255,255,.2);border-radius:999px;background:#111;color:#fff;font:600 13px system-ui;box-shadow:0 8px 28px #0008;cursor:pointer';
  const add = () => document.body.appendChild(button);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);
  else add();
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredPrompt = event; });
  button.addEventListener('click', async () => {
    if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; button.remove(); }
    else if (isIOS) alert('To install AXScripts: tap Share, then “Add to Home Screen”.');
    else alert('Open your browser menu and choose “Install app” or “Add to Home screen”.');
  });
})();