/* ═══════════════════════════════════════════════════════════════════════
 * Claude Flow — 서비스워커
 * 목적: 설치형 PWA + 오프라인 동작. 앱 껍데기는 캐시, API 호출은 절대 캐시하지 않음.
 * 캐시 버전을 올리면(아래 CACHE) 이전 캐시는 자동 정리된다.
 * ═══════════════════════════════════════════════════════════════════════ */
const CACHE = 'claude-flow-v6';

// 앱 껍데기(오프라인에도 떠야 하는 정적 자원)
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './config.js',
  './vendor/supabase.js',
  './sync.js'
];

// 오프라인 캐시를 허용할 외부 정적 CDN (폰트, supabase-js 라이브러리 등)
const STATIC_HOSTS = ['cdn.jsdelivr.net'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})          // 일부 자원 실패해도 설치는 진행
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 응답을 캐시에 복제 저장
function put(req, res) {
  if (res && res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // 쓰기 요청은 건드리지 않음
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // 1) 페이지 이동(navigation): 네트워크 우선, 실패 시 캐시된 index.html
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => put(req, res))
        .catch(() => caches.match(req).then((m) => m || caches.match('./index.html')))
    );
    return;
  }

  // 2) 같은 출처 정적 자원: 네트워크 우선(업데이트 반영), 실패 시 캐시
  if (sameOrigin) {
    e.respondWith(
      fetch(req).then((res) => put(req, res)).catch(() => caches.match(req))
    );
    return;
  }

  // 3) 허용된 외부 정적 CDN: stale-while-revalidate (빠르고 오프라인 가능)
  if (STATIC_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.match(req).then((cached) => {
        const net = fetch(req).then((res) => put(req, res)).catch(() => cached);
        return cached || net;
      })
    );
    return;
  }

  // 4) 그 외 외부 요청(Supabase REST/Auth, Gemini, 환율 API 등): 네트워크 전용, 캐시 금지
  //    → respondWith 하지 않고 브라우저 기본 처리에 맡긴다.
});

// ── 푸시 알림 수신 → 알림 표시 ──
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'Claude Flow';
  const options = {
    body: d.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: d.tag || 'claude-flow',
    renotify: true,
    data: { url: d.url || './' },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// ── 알림 클릭 → 앱 열기/포커스 ──
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
