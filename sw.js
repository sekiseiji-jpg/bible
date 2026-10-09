/* 聖書 Bible — Service Worker
 *
 * 外枠（HTML/CSS/JS）… キャッシュを返しつつ裏で更新し、次回の起動に反映する
 * 本文データ         … 中身が変わらないのでキャッシュ優先。読んだ巻だけ貯まる
 *
 * 新しい版は勝手に差し替えず、ページから skip-waiting を受け取ってから入れ替える。
 */
var SHELL = 'bible-shell-v12';
var TEXT = 'bible-text-v2';

var PRECACHE = [
  './',
  'index.html',
  'style.css?v=30',
  'app.js?v=29',
  'data/meta.js?v=12',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png'
];

var IS_TEXT = /\/data\/(ja|njb|kjv)\/\d+\.js$/;

self.addEventListener('install', function (e) {
  // ここでは skipWaiting しない。利用者が「更新」を押したときに入れ替える。
  // 1 件ずつ入れる。addAll だと 1 つ失敗しただけで導入そのものが失敗するため。
  e.waitUntil(
    caches.open(SHELL).then(function (c) {
      return Promise.all(PRECACHE.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () { /* 先へ */ });
      }));
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return (k === SHELL || k === TEXT) ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (e) {
  var msg = e.data || {};
  if (msg.type === 'skip-waiting') {
    self.skipWaiting();
    return;
  }
  if (msg.type === 'drop-text') {
    e.waitUntil(caches.delete(TEXT).then(function () {
      if (e.source) e.source.postMessage({ type: 'text-dropped' });
    }));
  }
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (IS_TEXT.test(url.pathname)) {
    // 本文: あればそのまま、なければ取得して貯める
    e.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(TEXT).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
    return;
  }

  // 外枠: キャッシュを即返しつつ、裏で最新を取り込む
  e.respondWith(
    caches.open(SHELL).then(function (cache) {
      return cache.match(req).then(function (hit) {
        var fresh = fetch(req).then(function (res) {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(function () { return hit || cache.match('index.html'); });
        return hit || fresh;
      });
    })
  );
});
