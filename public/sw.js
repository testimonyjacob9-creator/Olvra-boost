// public/sw.js
// Minimal, safe service worker: makes the app installable as a PWA and
// gives a fast repeat-load + basic offline fallback for the app shell.
// Deliberately does NOT cache anything under /.netlify/functions/ or any
// Firebase/Firestore traffic — wallet balances, orders and auth must
// always be live, never served stale from a cache.

const CACHE_VERSION = "olvra-boost-v1";
const APP_SHELL = [
  "/",
  "/index.html",
  "/about.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function isNeverCache(url) {
  return (
    url.pathname.startsWith("/.netlify/functions/") ||
    url.hostname.includes("firestore.googleapis.com") ||
    url.hostname.includes("firebaseio.com") ||
    url.hostname.includes("identitytoolkit.googleapis.com") ||
    url.hostname.includes("securetoken.googleapis.com") ||
    url.hostname.includes("checkout.flutterwave.com")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (isNeverCache(url)) return; // let it hit the network untouched

  // Navigations (loading a page): network-first, falling back to the
  // cached shell when offline, so the app still opens with no signal.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match("/index.html")))
    );
    return;
  }

  // Same-origin static assets (css/js/png/fonts served from our own
  // domain): stale-while-revalidate — instant from cache, refreshed in
  // the background for next time.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
            return res;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
  }
});
