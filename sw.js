/* ═══════════════════════════════════════════════════════════════════════
 * Claude Flow Pro — 서비스워커
 * 목적: 설치형 PWA + 오프라인 동작. 앱 껍데기는 캐시, API 호출은 절대 캐시하지 않음.
 * 캐시 버전을 올리면(아래 CACHE) 이전 캐시는 자동 정리된다.
 * ═══════════════════════════════════════════════════════════════════════ */
const CACHE = 'claude-flow-v38';

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

/* 네트워크 우선 — 단, 기다리는 데 한도를 둔다.
 * '실패하면 캐시' 만으로는 모자랐다. 신호가 약한 곳(지하철·엘리베이터)에서는 요청이
 * 실패하지도 끝나지도 않은 채 수십 초를 끄는데, 그동안 앱은 흰 화면이다 — 캐시에
 * 멀쩡한 앱이 있는데도. 3.5초 안에 대답이 없으면 캐시로 먼저 띄우고, 늦게 온 응답은
 * 캐시에 넣어 다음에 열 때 반영한다. 캐시에 없으면 끝까지 네트워크를 기다린다. */
const NET_WAIT = 3500;
function netFirst(req, fallbackUrl) {
  const fromCache = () => caches.match(req).then((m) => m || (fallbackUrl ? caches.match(fallbackUrl) : undefined));
  return new Promise((resolve) => {
    let done = false;
    const finish = (res) => { if (!done && res) { done = true; resolve(res); } };
    const timer = setTimeout(() => { fromCache().then(finish); }, NET_WAIT);
    fetch(req).then((res) => { clearTimeout(timer); finish(put(req, res)); })
      .catch(() => {
        clearTimeout(timer);
        fromCache().then((m) => { if (!done) { done = true; resolve(m || Response.error()); } });
      });
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // 쓰기 요청은 건드리지 않음
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // 1) 페이지 이동(navigation): 네트워크 우선, 실패하거나 너무 느리면 캐시된 index.html
  if (req.mode === 'navigate') {
    e.respondWith(netFirst(req, './index.html'));
    return;
  }

  // 2) 같은 출처 정적 자원: 네트워크 우선(업데이트 반영), 실패하거나 너무 느리면 캐시
  if (sameOrigin) {
    e.respondWith(netFirst(req));
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
  const title = d.title || 'Claude Flow Pro';
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
