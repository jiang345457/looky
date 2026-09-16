// 1. 更新缓存版本号
const CACHE_NAME = 'LOOKY-app-v85'; // 版本号+1，确保更新
// 2. 将缓存文件分为“关键”和“可选”
// 关键资源：应用的骨架，必须全部缓存成功，否则安装失败
const CRITICAL_URLS = [
  // --- 核心框架 ---
  '.',
  'index.html',
  'style/main.css',
  'js/main.js',
  'js/state.js',
  'js/ui.js',
  'js/utils.js',
  'js/core.js',
  'js/lib/dexie.mjs',
  'js/lib/jszip.min.js',
  // --- 核心功能模块 (所有JS) ---
  'js/features/chat.js',
  'js/features/identity.js',
  'js/features/apisettings.js',
  'js/features/stickers.js',
  'js/features/screensettings.js',
  'js/features/voice.js',
  'js/features/speech-service.js',
  'js/features/memory.js',
  'js/features/world-book.js',
  'js/features/timeSettings.js',
  'js/features/gallery.js',
  'js/features/gallery-settings.js',
  'js/features/offline-mode.js',
  'js/features/moments.js',
  'js/features/profile.js',
  'js/features/chatBeautify.js',
  'js/features/sound-settings.js',
  'js/features/font-settings.js',
  'js/features/video-call.js',
  'js/features/data-manager.js',
  'js/features/github-backup.js',
  // --- PWA清单文件 ---
  'manifest.json',
];
// 可选资源：如果缓存失败，只会警告，不影响应用安装
const OPTIONAL_URLS = [
  'images/icon-192.png',
  'images/icon-512.png',
  'images/default-avatar.svg',
  // 'images/default-bg.jpg', // 路径有问题，暂时注释。修复后可放开
  'images/sms.png',
  'images/memory.png',
  'images/gallery.png',
  'images/shop.png',
  'assets/ringtone.mp3'
];
const UPDATE_QUERY_KEYS = ['looky_update', 'looky_force_update'];
const NETWORK_FIRST_DESTINATIONS = new Set(['document', 'script', 'style', 'worker']);
const CACHE_FIRST_DESTINATIONS = new Set(['manifest', 'font']);
const NETWORK_FIRST_CACHE_FALLBACK_MS = 4000;

function shouldForceNetwork(requestUrl) {
  return UPDATE_QUERY_KEYS.some(key => requestUrl.searchParams.has(key));
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cachedResponse = await cache.match(request);
  const controller = cachedResponse && typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), NETWORK_FIRST_CACHE_FALLBACK_MS) : null;
  try {
    const response = await fetch(request, {
      cache: 'no-cache',
      ...(controller ? { signal: controller.signal } : {})
    });
    if (response && response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    if (cachedResponse) return cachedResponse;
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cachedResponse = await cache.match(request);
  if (cachedResponse) return cachedResponse;

  const response = await fetch(request, { cache: 'no-cache' });
  if (response && response.ok) {
    await cache.put(request, response.clone());
  }
  return response;
}
// 安装 Service Worker
self.addEventListener('install', event => {
  console.log('Service Worker: 新版本已下载，等待用户确认后接管...');
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 【后面的代码保持不变】
// 激活 Service Worker 并清理旧缓存
self.addEventListener('activate', event => {
  console.log('Service Worker: 已激活。');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            console.log('Service Worker: 正在清理旧缓存:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => {
      // 确保新的 Service Worker 控制所有页面
      return self.clients.claim();
    })
  );
});
/* ========================================================================== */
/* == 3. 拦截网络请求 (Network First + 超时回退) == */
/* ========================================================================== */
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (shouldForceNetwork(requestUrl)) {
    event.respondWith(fetch(event.request, { cache: 'reload' }));
    return;
  }

  if (NETWORK_FIRST_DESTINATIONS.has(event.request.destination)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  if (CACHE_FIRST_DESTINATIONS.has(event.request.destination)) {
    event.respondWith(cacheFirst(event.request));
  }
});


// ▼▼▼ 【新增】点击系统通知时，自动打开或切回你的应用界面 ▼▼▼
self.addEventListener('notificationclick', event => {
  event.notification.close(); // 用户点击后，立刻把通知关掉
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // 遍历寻找当前是否已经有打开的网页窗口，如果有，直接把它唤醒到前台
      for (let i = 0; i < windowClients.length; i++) {
        let client = windowClients[i];
        if (client.url.indexOf('/') >= 0 && 'focus' in client) {
          return client.focus();
        }
      }
      // 如果完全被杀后台了，就重新打开应用
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});
// ▲▲▲ 新增结束 ▲▲▲
