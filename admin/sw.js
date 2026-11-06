/* ÉCHÉANCE — service worker (SPEC §5 et §8)
 * - précache de tous les fichiers de web/ (liste régénérée par `npm run build`)
 * - stale-while-revalidate pour les GET de même origine, repli navigation -> index.html
 * - SKIP_WAITING (bannière « Mise à jour disponible »)
 * - Periodic Background Sync « echeance-reminders » : notifications du jour depuis IndexedDB
 *   (base `echeance-reminders`, store `kv`, clés `index` et `delivered`)
 * Aucun accès à localStorage (interdit dans un service worker).
 */

/* BUILD:START */
const BUILD = '4065f33ad0';
const PRECACHE = [
  './apple-touch-icon.png',
  './conditions.html',
  './confidentialite.html',
  './css/extra.css',
  './css/legal.css',
  './css/motion.css',
  './css/polish.css',
  './css/style.css',
  './css/theme.css',
  './favicon-16.png',
  './favicon-32.png',
  './favicon.ico',
  './favicon.svg',
  './icons/badge-96.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './index.html',
  './js/account.js',
  './js/app.js',
  './js/calc.js',
  './js/catalog.js',
  './js/cloud.js',
  './js/cloudbackup.js',
  './js/config.js',
  './js/csv.js',
  './js/dates.js',
  './js/license.js',
  './js/logic.js',
  './js/money.js',
  './js/motion.js',
  './js/native.js',
  './js/nlp.js',
  './js/notify.js',
  './js/pin.js',
  './js/plans.js',
  './js/report.js',
  './js/schema.js',
  './js/storage.js',
  './js/sync.js',
  './js/ui.js',
  './js/vault.js',
  './js/version.js',
  './js/views.js',
  './manifest.webmanifest',
  './remboursement.html'
];
/* BUILD:END */

const CACHE_PREFIX = 'echeance-';
const CACHE_NAME = CACHE_PREFIX + BUILD;
const SYNC_TAG = 'echeance-reminders';
const DB_NAME = 'echeance-reminders';
const DB_STORE = 'kv';

const scopeUrl = (rel) => new URL(rel, self.registration.scope).href;

// ------------------------------------------------------------------ cycle de vie
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // `reload` : on contourne le cache HTTP pour ne pas précacher des fichiers périmés.
    await Promise.all(PRECACHE.map(async (rel) => {
      const res = await fetch(new Request(scopeUrl(rel), { cache: 'reload' }));
      if (!res.ok) throw new Error('Précache impossible : ' + rel + ' (' + res.status + ')');
      await cache.put(scopeUrl(rel), res);
    }));
    // Pas de skipWaiting automatique : l'app propose la mise à jour (message SKIP_WAITING).
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names
        .filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME)
        .map((n) => caches.delete(n)));
    } catch (e) { /* nettoyage best-effort */ }
    try { await self.clients.claim(); } catch (e) { /* ignore */ }
  })());
});

self.addEventListener('message', (event) => {
  const d = event.data;
  const type = d && typeof d === 'object' ? d.type : d;
  if (type === 'SKIP_WAITING') self.skipWaiting();
});

// ------------------------------------------------------------------ réseau
function isCacheable(res) {
  return res && res.ok && res.status === 200 && (res.type === 'basic' || res.type === 'default');
}

async function staleWhileRevalidate(event, request, isNavigation) {
  const cache = await caches.open(CACHE_NAME);
  // Toute navigation de l'app (/, ?source=pwa, ?action=add…) est servie par index.html (SPA).
  const cached = isNavigation ? await cache.match(scopeUrl('./index.html')) : await cache.match(request);

  const update = (async () => {
    try {
      const res = await fetch(request);
      if (isCacheable(res)) {
        // Les navigations sont stockées sous index.html (l'URL contient ?source=pwa, ?action=add…).
        const key = isNavigation ? scopeUrl('./index.html') : request;
        await cache.put(key, res.clone());
      }
      return res;
    } catch (e) {
      return null;
    }
  })();

  if (cached) {
    event.waitUntil(update);
    return cached;
  }
  const fresh = await update;
  if (fresh) return fresh;
  if (isNavigation) {
    const shell = await cache.match(scopeUrl('./index.html'));
    if (shell) return shell;
  }
  return new Response('Hors ligne', {
    status: 503, statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.has('range')) return;
  if (url.href === self.location.href) return; // sw.js : toujours via le réseau / mise à jour du navigateur
  const isNavigation = req.mode === 'navigate';
  event.respondWith(staleWhileRevalidate(event, req, isNavigation));
});

// ------------------------------------------------------------------ IndexedDB (kv)
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) { db.close(); reject(new Error('store kv absent')); return; }
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB bloquée'));
  });
}
function kvGet(db, key) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function kvPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ------------------------------------------------------------------ rappels (periodicsync)
function localDateString(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

async function deliverDueReminders() {
  if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') return 0;
  let db;
  try { db = await openDb(); } catch (e) { return 0; }
  let shown = 0;
  try {
    const payload = await kvGet(db, 'index');
    if (!payload || typeof payload !== 'object' || payload.enabled !== true || !Array.isArray(payload.reminders)) return 0;

    const now = new Date();
    const today = localDateString(now);
    const hour = Number.isInteger(payload.hour) ? payload.hour : 8;
    const minute = Number.isInteger(payload.minute) ? payload.minute : 0;
    if (now.getHours() * 60 + now.getMinutes() < hour * 60 + minute) return 0; // pas avant l'heure choisie

    let delivered = await kvGet(db, 'delivered');
    if (!delivered || delivered.date !== today || !Array.isArray(delivered.keys)) {
      delivered = { date: today, keys: [] };
    }
    const done = new Set(delivered.keys);
    const icon = scopeUrl('./icons/icon-192.png');
    const badge = scopeUrl('./icons/badge-96.png');

    for (const r of payload.reminders) {
      if (!r || typeof r.key !== 'string' || r.date !== today || done.has(r.key)) continue;
      try {
        await self.registration.showNotification(String(r.title || 'ÉCHÉANCE'), {
          body: String(r.body || ''),
          tag: r.key,
          icon,
          badge,
          data: { url: './' },
        });
        done.add(r.key);
        shown++;
        delivered.keys = Array.from(done);
        await kvPut(db, 'delivered', delivered); // persisté au fur et à mesure
      } catch (e) { /* une notification en échec ne bloque pas les autres */ }
    }
  } catch (e) {
    /* best-effort */
  } finally {
    try { db.close(); } catch (e) { /* ignore */ }
  }
  return shown;
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === SYNC_TAG) event.waitUntil(deliverDueReminders().catch(() => 0));
});

// ------------------------------------------------------------------ clic sur notification
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const target = scopeUrl(data && typeof data.url === 'string' ? data.url : './');
  event.waitUntil((async () => {
    try {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of list) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          return await client.focus();
        }
      }
      if (self.clients.openWindow) return await self.clients.openWindow(target);
    } catch (e) { /* ignore */ }
  })());
});
