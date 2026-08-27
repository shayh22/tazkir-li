/* תזכיר לי - Service Worker
   אחראי על: עבודה במצב לא מקוון, והצגת תזכורות ברקע (כולל כשהאפליקציה סגורה,
   בדפדפנים שתומכים ב-Periodic Background Sync או ב-Notification Triggers). */

const CACHE = 'tazkir-li-v2';
const SHELL = [
    './',
    './index.html',
    './tailwind.css',
    './manifest.webmanifest',
    './bell.jpg',
    './birkat-hanasi.png',
    './icon-192.png',
    './icon-512.png'
];

/* --- אחסון תוכנית התזכורות --- */
const SW_DB = 'TazkirLiSW';
const SW_STORE = 'schedule';

function swDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(SW_DB, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(SW_STORE)) db.createObjectStore(SW_STORE, { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function putPlan(plan) {
    const db = await swDB();
    await new Promise((resolve) => {
        const tx = db.transaction(SW_STORE, 'readwrite');
        const store = tx.objectStore(SW_STORE);
        store.clear();
        (plan || []).forEach(item => store.put(item));
        tx.oncomplete = resolve;
        tx.onerror = resolve;
    });
}

async function getPlan() {
    try {
        const db = await swDB();
        return await new Promise((resolve) => {
            const req = db.transaction(SW_STORE, 'readonly').objectStore(SW_STORE).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
    } catch (e) { return []; }
}

async function markShown(keys) {
    if (!keys.length) return;
    const db = await swDB();
    await new Promise((resolve) => {
        const tx = db.transaction(SW_STORE, 'readwrite');
        const store = tx.objectStore(SW_STORE);
        keys.forEach(k => store.delete(k));
        tx.oncomplete = resolve;
        tx.onerror = resolve;
    });
}

/* בודק אילו תזכורות הגיע זמנן ומציג אותן */
async function flushDueReminders() {
    const plan = await getPlan();
    const now = Date.now();
    // מציגים רק תזכורות שזמנן הגיע בשעה האחרונה - ישנות מכך כבר לא רלוונטיות
    const due = plan.filter(p => p.ts <= now && p.ts > now - 3600 * 1000);
    for (const r of due) {
        await self.registration.showNotification('🔔 ' + r.title, {
            body: r.body || 'הגיע הזמן לבצע את המשימה',
            icon: './icon-192.png',
            badge: './icon-192.png',
            tag: 'tz-bg-' + r.key,
            requireInteraction: true,
            vibrate: [400, 200, 400],
            data: { taskId: r.taskId, key: r.key }
        });
    }
    // מנקה גם תזכורות ישנות שפג תוקפן
    await markShown(plan.filter(p => p.ts <= now).map(p => p.key));
}

/* --- מחזור חיים --- */
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then(cache => Promise.allSettled(SHELL.map(url => cache.add(url))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

/* --- בקשות רשת: מטמון עם רענון ברקע --- */
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

    // ניווט: קודם רשת, ואם אין - הגרסה השמורה
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req).then(res => {
                const clone = res.clone();
                caches.open(CACHE).then(c => c.put('./index.html', clone)).catch(() => {});
                return res;
            }).catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
        );
        return;
    }

    event.respondWith(
        caches.match(req).then(cached => {
            const network = fetch(req).then(res => {
                // שומרים גם תשובות אטומות (CDN) כדי שהאפליקציה תעבוד גם ללא רשת
                if (res && (res.status === 200 || res.type === 'opaque')) {
                    const clone = res.clone();
                    caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
                }
                return res;
            }).catch(() => cached);
            return cached || network;
        })
    );
});

/* --- הודעות מהאפליקציה --- */
self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'SCHEDULE') event.waitUntil(putPlan(data.plan));
    if (data.type === 'CHECK') event.waitUntil(flushDueReminders());
    if (data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* --- סנכרון רקע תקופתי (אנדרואיד/כרום) --- */
self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'tz-reminders') event.waitUntil(flushDueReminders());
});
self.addEventListener('sync', (event) => {
    if (event.tag === 'tz-reminders') event.waitUntil(flushDueReminders());
});

/* --- לחיצה על התראה: פתיחת האפליקציה על המשימה --- */
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const taskId = (event.notification.data || {}).taskId;
    event.waitUntil((async () => {
        const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clientList) {
            if ('focus' in client) {
                await client.focus();
                client.postMessage({ type: 'OPEN_TASK', taskId });
                return;
            }
        }
        if (self.clients.openWindow) await self.clients.openWindow('./index.html');
    })());
});
