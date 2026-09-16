
import { AppState, db, DEFAULT_AVATAR_SRC, DEFAULT_CHAR_INTERACTION_CARD_ENABLED, DEFAULT_DESKTOP_ICON_NAME_COLOR, normalizeDesktopIconNameColor, tempState, getFirstMessageTimestamp, loadGallerySettings, ensurePersistentStorage, normalizeCharacterRelationshipFields } from './state.js';
import { UI, customizableIcons, updateTime, updateBatteryStatus, applyIconSetting, showPage, showHomeScreen, getCurrentLookyPageId, showDynamicIsland, showSimpleSelectModal, historyModalContent } from './ui.js';
import { addTapListener, isValidAvatarSrc, escapeHTML } from './utils.js';
import { setupDynamicContent, setupImageUploader } from './core.js';
import { setupIdentitySwitcher, setupPersonaPage, setupSocialCircle } from './features/identity.js';
import { setupStickersPage } from './features/stickers.js';
import { setupApiSettings } from './features/apisettings.js';
import { setupScreenSettings } from './features/screensettings.js';
import { setupChatAndCharManagement } from './features/chat.js';
import { initChatSearchPage, initChatFavoritesPage } from './features/chat-search.js';
import { initVoiceFunctionality } from './features/voice.js';
import { setupMemoryDetailPage, renderTimeline, setupRecentMemoryPage, showRecentMemoryPage } from './features/memory.js';
import { initWorldBook } from './features/world-book.js';
import { initTimeSettings } from './features/timeSettings.js'; 
import { setupGalleryPage, initializeSimilarityPipeline, isAiEngineAvailable } from './features/gallery.js';
import { loadHybridStateFromSession } from './state.js';
import { setupGallerySettings } from './features/gallery-settings.js';
import { initOfflineModePage, deleteOfflineSessionAndMessages } from './features/offline-mode.js';
import { momentsModule } from './features/moments.js';
import { initProfilePage, renderDIYPage, loadProfileStats } from './features/profile.js';
import * as chatBeautify from './features/chatBeautify.js';
import { initSoundSettings } from './features/sound-settings.js';
import { fontSettings } from './features/font-settings.js';
import { initVideoCallModule } from './features/video-call.js';
import { Diary } from './features/diary.js'; 
import { initLifePage } from './features/life.js';
import { initFlightSystem, updateFlightCapsuleDisplay } from './features/flight.js'; 
import { initSidebarPreviews } from './features/chat-ui.js'; 
import { initCheckPhone } from './features/check-phone.js?v=20260909-18';
import { MusicPlayer } from './features/music.js';
import { CoupleSpace } from './features/couple-space.js';
import { initGroupChatSettings } from './features/group-chat.js';
import { LookyPay } from './features/looky-pay.js';
import { initCharacterLibraryPage } from './features/character-library.js';
import { initCharacterAddPage } from './features/character-add.js';
import { initImageGenApiSettings, getImageGenSettings } from './features/image-gen.js';
import { initVectorApiSettings } from './features/vector-api-settings.js';
import { getVectorApiConfig } from './features/vector-engine.js';
import { initMcpSettingsPage, setupRoleMcpSettings } from './features/mcp.js';
import { getSleepState, restoreBackgroundActivityAfterBoot } from './features/sleep-system.js';
import { isNativeRuntime, isHarmonyRuntime, getNativeNotificationPermission, requestNativeNotificationPermission, showNativeNotification } from './native-bridge.js';
import { getNativeUpdateStatus, downloadNativeWebBundle, confirmNativeBundleReady } from './live-update.js';

let forumModulePromise = null;
let forumReadyPromise = null;
let bondsModulePromise = null;
let bondsReadyPromise = null;
let smsModulePromise = null;
let smsReadyPromise = null;

function isForumPageId(pageId) {
    return typeof pageId === 'string' && pageId.startsWith('page-forum');
}

async function ensureForumLoaded() {
    if (window.Forum?.init) {
        await window.Forum.init();
        return window.Forum;
    }
    if (!forumModulePromise) {
        forumModulePromise = import('./features/forum.js?v=20260806-01')
            .then(module => {
                window.Forum = module.Forum;
                return module.Forum;
            })
            .catch(error => {
                forumModulePromise = null;
                throw error;
            });
    }
    const Forum = await forumModulePromise;
    if (!forumReadyPromise) {
        forumReadyPromise = Forum.init()
            .then(() => Forum)
            .catch(error => {
                forumReadyPromise = null;
                throw error;
            });
    }
    return forumReadyPromise;
}

function warmForumAfterFirstPaint() {
    if (isNativeRuntime()) return;
    const warm = () => ensureForumLoaded().catch(error => console.warn('[Forum] preload failed:', error));
    if ('requestIdleCallback' in window) {
        window.requestIdleCallback(warm, { timeout: 3500 });
    } else {
        setTimeout(warm, 1200);
    }
}

window.ensureForumLoaded = ensureForumLoaded;

function isBondsPageId(pageId) {
    return typeof pageId === 'string' && pageId.startsWith('page-bonds');
}

async function ensureBondsLoaded() {
    if (!bondsModulePromise) {
        bondsModulePromise = import('./features/bonds.js?v=20260913-bonds-on-demand-1')
            .then(module => {
                if (!module.Bonds?.init) throw new Error('羁绊模块缺少初始化入口');
                return module.Bonds;
            })
            .catch(error => {
                bondsModulePromise = null;
                throw error;
            });
    }

    const Bonds = await bondsModulePromise;
    if (!bondsReadyPromise) {
        bondsReadyPromise = Promise.resolve()
            .then(() => Bonds.init())
            .then(() => Bonds);
    }
    return bondsReadyPromise;
}

window.ensureBondsLoaded = ensureBondsLoaded;

function isSmsPageId(pageId) {
    return typeof pageId === 'string' && pageId.startsWith('page-sms');
}

async function ensureSmsLoaded() {
    if (!smsModulePromise) {
        smsModulePromise = import('./features/sms.js?v=20260913-sms-on-demand-1')
            .then(module => {
                if (!module.SMSModule?.init) throw new Error('短信模块缺少初始化入口');
                return module.SMSModule;
            })
            .catch(error => {
                smsModulePromise = null;
                throw error;
            });
    }

    const SMSModule = await smsModulePromise;
    if (!smsReadyPromise) {
        smsReadyPromise = Promise.resolve()
            .then(() => SMSModule.init())
            .then(() => SMSModule);
    }
    return smsReadyPromise;
}

window.ensureSmsLoaded = ensureSmsLoaded;

window.__lookyBootStage = 'main module loaded';
const isLookyNativeRuntime = isNativeRuntime();
const isLookyHarmonyRuntime = isHarmonyRuntime();
window.__lookyRuntime = isLookyNativeRuntime ? 'native' : 'web';
document.documentElement.classList.toggle('looky-native', isLookyNativeRuntime);
if (isLookyNativeRuntime) void confirmNativeBundleReady();
if (isLookyNativeRuntime || /iPad|iPhone|iPod/.test(navigator.userAgent)) {
    import('./ios-scroll-lock.js').catch(error => console.warn('[ScrollLock] 初始化失败:', error));
}
const SERVICE_WORKER_UPDATE_CHECK_KEY = 'looky_sw_last_update_check';
const SERVICE_WORKER_UPDATE_CHECK_INTERVAL = 5 * 60 * 1000;
const LOOKY_UPDATE_MANIFEST_URL = './version.json';

function getLookyBuildVersion() {
    return String(window.__LOOKY_BUILD_VERSION || document.documentElement.dataset.buildVersion || '').trim();
}

async function fetchWebUpdateManifest() {
    const response = await fetch(`${LOOKY_UPDATE_MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`更新清单请求失败: ${response.status}`);
    const manifest = await response.json();
    const remoteVersion = String(manifest.version || '').trim();
    if (!remoteVersion) throw new Error('更新清单缺少版本号');
    return manifest;
}

async function checkLookyManifestUpdate() {
    if (isNativeRuntime()) return;

    try {
        const response = await fetch(`${LOOKY_UPDATE_MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) return;
        const manifest = await response.json();
        const remoteVersion = String(manifest.version || '').trim();
        const localVersion = getLookyBuildVersion();
        if (!remoteVersion || !localVersion || remoteVersion === localVersion) return;

        window.__LOOKY_PENDING_UPDATE = manifest;
        const updateModal = document.getElementById('update-notice-modal');
        if (updateModal) {
            updateModal.style.display = 'flex';
            updateModal.classList.add('visible');
        }
    } catch (error) {
        console.warn('Looky update manifest check failed:', error);
    }
}

function shouldCheckServiceWorkerUpdate() {
    try {
        const url = new URL(window.location.href);
        if (url.searchParams.has('looky_update') || url.searchParams.has('looky_force_update')) {
            return false;
        }
        const lastCheck = Number(sessionStorage.getItem(SERVICE_WORKER_UPDATE_CHECK_KEY) || 0);
        if (Date.now() - lastCheck < SERVICE_WORKER_UPDATE_CHECK_INTERVAL) {
            return false;
        }
        sessionStorage.setItem(SERVICE_WORKER_UPDATE_CHECK_KEY, String(Date.now()));
        return true;
    } catch (error) {
        return true;
    }
}

function scheduleServiceWorkerUpdate(registration) {
    const runUpdate = () => {
        if (!shouldCheckServiceWorkerUpdate()) return;
        registration.update().catch(err => console.warn('PWA update check failed:', err));
    };

    if ('requestIdleCallback' in window) {
        window.requestIdleCallback(runUpdate, { timeout: 3000 });
    } else {
        setTimeout(runUpdate, 1500);
    }
}
if ('serviceWorker' in navigator) {
  // 1. 注册 Service Worker
  navigator.serviceWorker.register('./service-worker.js').then(registration => {
    console.log('PWA Service Worker 注册成功');
    
    // 2. 手动检查更新 (防止浏览器检查得不够勤快)
    scheduleServiceWorkerUpdate(registration);
    
    // 3. 监听更新状态
    registration.onupdatefound = () => {
      const installingWorker = registration.installing;
      if (installingWorker) {
        installingWorker.onstatechange = () => {
          // 如果新版本已安装 (installed) 且当前页面已被旧版接管 (navigator.serviceWorker.controller)
          // 说明这是一次“更新”而不是“首次加载”
          if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
            console.log('【PWA】新版本已就绪，下次刷新将生效');
          }
        };
      }
    };
  }).catch(err => console.log('PWA 注册失败:', err));
  // 4. 【核心】监听控制器变化
  // 当 service-worker.js 里的 skipWaiting() 生效时，这里会触发
  // 此时页面已经被新版 SW 接管，但 DOM 还是旧的，所以我们不用强制刷新，
  // 而是依靠用户自己的刷新操作，或者你可以解开下面的 reload 注释来强制刷新。
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    console.log('【PWA】已切换到新版本');
    // 如果你希望代码更新后，用户不用手动刷新，页面自动闪烁刷新一次，请解开下面这行注释：
    // window.location.reload(); 
  });
}

// ========================================================================== 
// == 🔊 音频系统核心 (Web Audio API 重构版) - 彻底解决手机拦截问题 ==
// ==========================================================================
// 1. 创建全局音频上下文
// 【关键修改】挂载到 window 对象，让 tts-service.js 也能借用这个已解锁的引擎
window.sharedAudioContext = new (window.AudioContext || window.webkitAudioContext)();
const audioContext = window.sharedAudioContext;
// 2. 用于存储当前正在播放的铃声源（以便后续停止它）
let currentRingtoneSource = null;
let currentRingtoneAudio = null;
let isAudioEngineUnlocked = false; // ▼▼▼ 新增：音频引擎解锁状态锁 ▼▼▼
const nativeNotificationAudios = new Set();

/**
 * 【核心解锁函数】
 * 网页端激活 AudioContext；原生运行时的提示音改走 HTML Audio 兼容路径
 */
function tryUnlockAudioContext() {
    if (isAudioEngineUnlocked) return; // ▼▼▼ 新增：如果已解锁直接阻断，防止每次触屏都疯狂消耗性能发热 ▼▼▼

    // 1. 播放一个极短的静音脉冲，告诉浏览器我们准备好了
    const buffer = audioContext.createBuffer(1, 1, 22050);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start(0);
    // 2. 恢复上下文状态
     audioContext.resume().then(() => {
        if (audioContext.state === 'running') {
            isAudioEngineUnlocked = true; // ▼▼▼ 新增：永久打上安全锁，以后随便滑屏幕都不会卡了 ▼▼▼
            // 移除监听器，节省性能
            document.removeEventListener('click', tryUnlockAudioContext);
            document.removeEventListener('touchstart', tryUnlockAudioContext);
            document.removeEventListener('keydown', tryUnlockAudioContext);
            
            console.log('✅ 音频引擎激活成功 (Web Audio API)');
            // 仅提示一次
            if (!window.audioUnlockedMsgShown) {
                showDynamicIsland('🔊 音频已就绪', 'success', 1500);
                window.audioUnlockedMsgShown = true;
            }

        }
    });
}

// 绑定解锁事件
document.addEventListener('click', tryUnlockAudioContext);
document.addEventListener('touchstart', tryUnlockAudioContext, { passive: true });
document.addEventListener('keydown', tryUnlockAudioContext);

/**
 * 【关键辅助函数】使用 Web Audio API 加载并播放音频
 * 这种方式只要引擎是 running 状态，就可以代码自动播放，不会被拦截！
 */
async function playSoundViaWebAudio(url, isLoop = false) {

    if (audioContext.state !== 'running') return null;
    
    try {
        // 1. 下载音频文件
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        
        // 2. 解码音频数据
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        
        // 3. 创建音源节点
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.loop = isLoop; // 是否循环播放
        source.connect(audioContext.destination);
        
        // 4. 开始播放
        source.start(0);
        return source; // 返回源对象，以便停止播放
    } catch (e) {
        console.error('WebAudio 播放失败:', e);
        return null;
    }
}

function playSoundViaNativeAudio(url, isLoop = false) {
    if (!isLookyNativeRuntime || (!isLookyHarmonyRuntime && audioContext.state === 'running') || typeof Audio !== 'function' || !url) return null;

    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.loop = isLoop;
    if (!isLoop) nativeNotificationAudios.add(audio);

    const cleanup = () => {
        nativeNotificationAudios.delete(audio);
        audio.removeEventListener('ended', cleanup);
        audio.removeEventListener('error', cleanup);
    };
    if (!isLoop) {
        audio.addEventListener('ended', cleanup, { once: true });
        audio.addEventListener('error', cleanup, { once: true });
    }

    const playPromise = audio.play();
    if (playPromise?.catch) {
        playPromise.catch(error => {
            cleanup();
            console.warn('[NativeAudio] 音频播放失败:', error);
        });
    }
    return audio;
}

/**
 * 播放来电铃声 (重写)
 */
window.playIncomingCallSound = async function() {
    const charId = tempState.currentChatId;
    const char = AppState.characterProfiles.find(c => c.id === charId);
    // 获取铃声路径，默认为 assets/ringtone.mp3
    const ringtoneSrc = (char && char.ringtoneSrc) ? char.ringtoneSrc : 'assets/ringtone.mp3';
    
    // 播放前先停止上一个（防止重音）
    window.stopIncomingCallSound();

    if (isLookyNativeRuntime && (isLookyHarmonyRuntime || audioContext.state !== 'running')) {
        currentRingtoneAudio = playSoundViaNativeAudio(ringtoneSrc, true);
        if (currentRingtoneAudio) return;
    }

    // 如果引擎没启动，提示用户点一下
    if (audioContext.state !== 'running') {
        showDynamicIsland('📞 来电中 (轻点屏幕接通音频)', 'warning', 3000);
        return;
    }

    // 使用新方法播放，并保存引用以便停止
    console.log('正在播放铃声:', ringtoneSrc);
    currentRingtoneSource = await playSoundViaWebAudio(ringtoneSrc, true);
}

/**
 * 停止来电铃声 (重写)
 */
window.stopIncomingCallSound = function() {
    if (currentRingtoneAudio) {
        try {
            currentRingtoneAudio.pause();
            currentRingtoneAudio.currentTime = 0;
        } catch(e) {
            // 忽略已经失效的 Audio 元素
        }
        currentRingtoneAudio = null;
    }
    if (currentRingtoneSource) {
        try {
            currentRingtoneSource.stop(); // 立即停止
        } catch(e) {
            // 忽略已经停止的错误
        }
        currentRingtoneSource = null;
    }
}

/**
 * 播放消息提示音 (重写)
 */
window.playNotificationSound = function(soundSrc) {
    if (!soundSrc) return;

    if (isLookyNativeRuntime && (isLookyHarmonyRuntime || audioContext.state !== 'running') && playSoundViaNativeAudio(soundSrc)) return;
    if (audioContext.state !== 'running') return;
    
    // 提示音直接播，不需要循环，也不需要手动停止
    playSoundViaWebAudio(soundSrc, false);
}
/* ========================================================================== */
/* == 4. 应用入口 (APPLICATION ENTRY POINT) == */
/* ========================================================================== */
document.addEventListener('DOMContentLoaded', async () => {
    window.__lookyBootStage = 'DOMContentLoaded entered';
 
    // ==========================================================================
    // == 【新增】系统日志记录功能 (完美版) ==
    // ==========================================================================
    function setupSystemLogging() {
        const logOutput = document.getElementById('system-log-output');
        const clearLogBtn = document.getElementById('clear-log-btn');
        if (!logOutput || !clearLogBtn) return;
        // 维护一个指针，指向当前日志应该插入的容器（用于实现折叠组嵌套）
        let currentContainer = logOutput;
        const originalConsole = {
            log: console.log.bind(console),
            error: console.error.bind(console),
            warn: console.warn.bind(console),
            info: console.info.bind(console),
            group: console.group ? console.group.bind(console) : console.log.bind(console),
            groupCollapsed: console.groupCollapsed ? console.groupCollapsed.bind(console) : console.log.bind(console),
            groupEnd: console.groupEnd ? console.groupEnd.bind(console) : function(){}
        };

        // ▼▼▼ 新增：全局发热性能监控与日志节流锁 ▼▼▼
        let logCountThisSecond = 0;
        let lastLogTime = Date.now();
        let isThrottled = false;
        // Android WebView 对全局 RAF 包装和常驻计时器更敏感；网页端保留原有诊断能力。
        if (!isLookyNativeRuntime) {
            let rafCount = 0;
            const originalRaf = window.requestAnimationFrame;
            window.requestAnimationFrame = function(cb) {
                rafCount++;
                return originalRaf.call(window, cb);
            };
            setInterval(() => {
                if (rafCount > 65) originalConsole.warn(`【发热侦测】全局动画帧触发频率异常: ${rafCount}次/秒`);
                rafCount = 0;
            }, 1000);
        }
         // ▲▲▲ 新增结束 ▲▲▲

        let isLogging = false; // ▼新增：防内部死循环安全锁
        let pendingLogEntries = [];
        let logFlushPending = false;

        const scrollLogToBottomSoon = () => {
            if (!window._logScrollPending) {
                window._logScrollPending = true;
                requestAnimationFrame(() => {
                    if (logOutput.scrollHeight - logOutput.scrollTop < 1000) {
                        logOutput.scrollTop = logOutput.scrollHeight;
                    }
                    window._logScrollPending = false;
                });
            }
        };

        const trimLogOutput = () => {
            const maxEntries = isLookyNativeRuntime ? 150 : 500;
            while (logOutput.children.length > maxEntries) {
                logOutput.removeChild(logOutput.firstChild);
            }
        };

        const flushPendingLogs = (forceNow = false) => {
            if (pendingLogEntries.length === 0) return;

            const doFlush = () => {
                logFlushPending = false;
                let activeContainer = null;
                let fragment = null;
                const appendFragment = () => {
                    if (activeContainer && fragment && fragment.childNodes.length > 0) {
                        activeContainer.appendChild(fragment);
                    }
                };

                const entries = pendingLogEntries.splice(0);
                entries.forEach(({ container, entry }) => {
                    if (container !== activeContainer) {
                        appendFragment();
                        activeContainer = container;
                        fragment = document.createDocumentFragment();
                    }
                    fragment.appendChild(entry);
                });
                appendFragment();
                trimLogOutput();
                scrollLogToBottomSoon();
            };

            if (forceNow) {
                doFlush();
                return;
            }
            if (logFlushPending) return;
            logFlushPending = true;
            requestAnimationFrame(doFlush);
        };

        const logToPage = (type, args) => {
            if (isLogging) return; // ▼如果日志自己在搞事情，直接无视，切断套娃！
            isLogging = true;
            try {
            // ▼▼▼ 新增：高频日志熔断保护，彻底解决疯狂刷新DOM导致的发热 ▼▼▼
            const now = Date.now();
            if (now - lastLogTime > 1000) {
                lastLogTime = now;
                logCountThisSecond = 0;
                isThrottled = false;
            }
            logCountThisSecond++;

            // ▲▲▲ 新增结束 ▲▲▲

            const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            const entry = document.createElement('div');
            entry.className = `log-entry log-${type}`;
            
            let html = `<span class="log-time">[${timestamp}]</span> `;
            
            try {
                let i = 0;
                // 解析 %c 富文本样式
                if (args.length > 0 && typeof args[0] === 'string' && args[0].includes('%c')) {
                    const formatStr = args[0];
                    const parts = formatStr.split('%c');
                    html += `<span>${escapeHTML(parts[0])}</span>`;
                    i++;
                    for (let j = 1; j < parts.length; j++) {
                        const css = args[i] || '';
                        i++;
                        const text = parts[j];
                        html += `<span style="${escapeHTML(String(css))}">${escapeHTML(text)}</span>`;
                    }
                }

                // 处理剩余对象或文本
                for (; i < args.length; i++) {
                    const arg = args[i];
                    if (typeof arg === 'object' && arg !== null) {
                        let stringified = '';
                        try {
                            if (arg instanceof Error) stringified = arg.stack || arg.message;
                            else stringified = JSON.stringify(arg, null, 2);
                        } catch(e) { stringified = String(arg); }
                        const summaryText = Array.isArray(arg) ? `Array(${arg.length})` : `Object`;
                        html += `<details class="log-details"><summary>▶ ${summaryText}</summary><pre>${escapeHTML(stringified)}</pre></details> `;
                    } else {
                        html += `<span>${escapeHTML(String(arg))}</span> `;
                    }
                }
            } catch (e) { html += '<span>【解析错误】</span>'; }

            entry.innerHTML = html;
            pendingLogEntries.push({ container: currentContainer, entry });
            flushPendingLogs();
            } finally {
                isLogging = false; // ▼新增：执行完本条渲染后，解开安全锁
            }
        };
        // 创建折叠组的核心逻辑
        function createGroup(args, isOpen) {
            flushPendingLogs(true);
            const details = document.createElement('details');
            details.className = 'log-group';
            if (isOpen) details.open = true;

            const summary = document.createElement('summary');
            summary.className = 'log-group-title log-entry';
            
            const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            let html = `<span class="log-time">[${timestamp}]</span> <strong>`;
            try {
                html += escapeHTML(args.map(a => typeof a === 'object' ? 'Object' : String(a)).join(' '));
            } catch(e) {}
            html += `</strong>`;
            summary.innerHTML = html;

            const content = document.createElement('div');
            content.className = 'log-group-content';

            details.appendChild(summary);
            details.appendChild(content);
            currentContainer.appendChild(details);
            trimLogOutput();
            scrollLogToBottomSoon();
            
            // 指针潜入，接下来的 log 会输出在这个折叠组内部
            currentContainer = content;
        }

        // Capacitor 会用折叠组输出 %cnative/%cresult 调试信息。它们仍保留在
        // Android 调试控制台中，但不再污染应用内日志页或持续创建 DOM。
        let suppressedNativeBridgeGroupDepth = 0;
        const isNativeBridgeGroup = args => isLookyNativeRuntime &&
            typeof args[0] === 'string' && /^%c(?:native|result)\b/.test(args[0]);

        // 接管所有 Console API
        console.log = function(...args) {
            originalConsole.log(...args);
            if (!suppressedNativeBridgeGroupDepth) logToPage('log', args);
        };
        console.error = function(...args) {
            originalConsole.error(...args);
            if (!suppressedNativeBridgeGroupDepth) logToPage('error', args);
        };
        console.warn = function(...args) {
            originalConsole.warn(...args);
            if (!suppressedNativeBridgeGroupDepth) logToPage('warn', args);
        };
        console.info = function(...args) {
            originalConsole.info(...args);
            if (!suppressedNativeBridgeGroupDepth) logToPage('info', args);
        };

        console.group = function(...args) {
            originalConsole.group(...args);
            if (isNativeBridgeGroup(args)) {
                suppressedNativeBridgeGroupDepth++;
                return;
            }
            if (suppressedNativeBridgeGroupDepth) return;
            createGroup(args, true);
        };
        console.groupCollapsed = function(...args) {
            originalConsole.groupCollapsed(...args);
            if (isNativeBridgeGroup(args)) {
                suppressedNativeBridgeGroupDepth++;
                return;
            }
            if (suppressedNativeBridgeGroupDepth) return;
            createGroup(args, false);
        };
        console.groupEnd = function() {
            originalConsole.groupEnd();
            if (suppressedNativeBridgeGroupDepth) {
                suppressedNativeBridgeGroupDepth--;
                return;
            }
            // 指针退出，回到上一级
            if (currentContainer !== logOutput && currentContainer.parentElement) {
                currentContainer = currentContainer.parentElement.closest('.log-group-content') || logOutput;
            }
        };

        window.addEventListener('error', (event) => {
            console.error('【系统报错】', event.message, '文件:', event.filename, '行:', event.lineno);
        });
        window.addEventListener('unhandledrejection', (event) => {
            console.error('【异步请求报错】', event.reason);
        });
        
        clearLogBtn.addEventListener('click', () => {
            pendingLogEntries = [];
            logOutput.innerHTML = '';
            currentContainer = logOutput; // 重置指针
            console.log('系统日志已清空。');
        });

        console.log("系统日志模块已初始化 (完美折叠版)。");
    }
    setupSystemLogging();
    const styleSheet = document.createElement("style");
    styleSheet.type = "text/css";
    styleSheet.innerText = `
        @keyframes highlight-flash {
          0%, 100% { background-color: transparent; }
          50% { background-color: rgba(255, 204, 0, 0.35); }
        }
        .diary-entry-card.highlight-jump {
          animation: highlight-flash 1.8s ease-out;
        }
          .diary-article .article-body mark.highlight {
          background-color: rgba(255, 240, 180, 0.7); /* 半透明奶黄色 */
          color: inherit; /* 保持文字颜色不变 */
          padding: 0.1em 0.2em;
          border-radius: 3px;
        }
        .diary-article .article-body del.deletion {
          color: #E57373; /* 柔和的红色 */
          text-decoration: line-through; /* 标准删除线 */
          text-decoration-color: #E57373; /* 删除线颜色也为红色 */
          background-color: transparent; /* 确保没有背景色 */
        }
        
        #diary-regenerate-btn.regenerating svg {
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
    `;
    document.head.appendChild(styleSheet);
    function showDataLoadRecovery(error) {
        window.__lookyMarkBootComplete?.();
        removeLookyGate();
        document.body.style.visibility = 'visible';
        document.body.classList.remove('is-booting');

        const existing = document.getElementById('looky-data-recovery-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'looky-data-recovery-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;color:#111;';
        overlay.innerHTML = `
            <div style="width:100%;max-width:360px;text-align:left;line-height:1.6;">
                <h2 style="font-size:22px;margin:0 0 12px;font-weight:700;">本地数据读取失败</h2>
                <p style="font-size:14px;color:#555;margin:0 0 12px;">系统已经停止继续进入应用，避免空白默认数据覆盖你原来的内容。</p>
                <p style="font-size:13px;color:#777;margin:0 0 20px;">先点“刷新重试”。如果仍然失败，不要新增或保存内容，优先检查浏览器存储空间，或用之前导出的备份恢复。</p>
                <button id="looky-retry-load-btn" style="width:100%;padding:14px;border:0;border-radius:12px;background:#111;color:#fff;font-size:15px;font-weight:600;margin-bottom:10px;">刷新重试</button>
                <button id="looky-back-login-btn" style="width:100%;padding:14px;border:0;border-radius:12px;background:#f2f2f5;color:#111;font-size:15px;font-weight:600;">回到密码输入页</button>
                <details style="margin-top:16px;font-size:12px;color:#888;word-break:break-word;">
                    <summary>查看错误信息</summary>
                    <pre style="white-space:pre-wrap;margin-top:8px;">${escapeHTML(error?.message || String(error || '未知错误'))}</pre>
                </details>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('#looky-retry-load-btn')?.addEventListener('click', () => window.location.reload());
        overlay.querySelector('#looky-back-login-btn')?.addEventListener('click', () => {
            localStorage.setItem('looky_force_login', 'true');
            window.LookyAuth?.clear({ broadcast: false });
            window.location.reload();
        });
    }

    async function loadDataFromDB() {
        try {
            await ensurePersistentStorage();
            // 启动只读取下面这些配置；appData 中的历史大内容继续按需读取，避免 APK 启动时一次性占满内存。
            const startupDataKeys = [
                'characterData', 'friendRequests', 'friendRequestThreads', 'userIdentities', 'currentIdentityId',
                'profileDIYData', 'apiConfigurations', 'apiCurrentSettings', 'lastUsedApiConfigName', 'iconSettings',
                'homeWallpaper', 'systemUiBackground', 'appContentBackground', 'homeScreenWidget', 'homeScreenImages',
                'idCardData', 'playerWidgetData', 'desktopSchemes', 'desktopIconNameColor', 'ttsGlobalSettings',
                'voiceRecognitionSettings'
            ];
            const startupDataRows = await db.appData.bulkGet(startupDataKeys);
            const dataMap = new Map(startupDataRows.filter(Boolean).map(item => [item.key, item.value]));

            const allProfiles = await db.characterProfiles.toArray();
            if (allProfiles.length > 0) {
                AppState.characterProfiles = allProfiles.map(char => ({
                    ...char,
                    subtitle: char.subtitle || '',
                    tag: char.tag || '',
                    avatar: isValidAvatarSrc(char.avatar) ? char.avatar : DEFAULT_AVATAR_SRC,
                    charInteractionCardEnabled: char.isGroup
                        ? char.charInteractionCardEnabled !== false && DEFAULT_CHAR_INTERACTION_CARD_ENABLED
                        : char.charInteractionCardEnabled,
                    ...normalizeCharacterRelationshipFields(char),
                    blockAppealPhase: char.blockAppealPhase ?? null,
                    groupId: char.groupId || 'default',
                    isPinned: char.isPinned || false
                }));
            } else {
                AppState.characterProfiles = [];
            }

            const characterData = dataMap.get('characterData');
            AppState.characterGroups = characterData?.groups || [{ id: 'default', name: 'AI角色' }];
            AppState.friendRequests = Array.isArray(dataMap.get('friendRequests')) ? dataMap.get('friendRequests') : [];
            const storedFriendRequestThreads = dataMap.get('friendRequestThreads');
            AppState.friendRequestThreads = storedFriendRequestThreads && typeof storedFriendRequestThreads === 'object'
                ? storedFriendRequestThreads
                : {};

            AppState.userIdentities = dataMap.get('userIdentities') || [];
            AppState.currentIdentityId = dataMap.get('currentIdentityId') || 'default';
            if (AppState.userIdentities.length === 0) {
                 AppState.userIdentities.push({
                    id: 'default', name: '晨星', location: '中国，北京',
                    avatar: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48Y2lyY2xlIGN4PSI1MCIgY3k9IjUwIiByPSI1MCIgZmlsbD0iI2FkZDNmZiIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LWZhbWlyeT0ic2Fucy1zZXJpZiIgZm9udC1zaXplPSI1MCIgZmlsbD0iI2ZmZiI+QTwvdGV4dD48L3N2Zz4=',
                    persona: '你是一位名叫"晨星"的女孩，温柔、体贴，对世界充满好奇。你喜欢摄影和阅读，并且总能发现生活中的美好。',
                    socialCircle: []
                });
            }
            const loadedProfileDIY = dataMap.get('profileDIYData');
            if (loadedProfileDIY) {
                // 将数据库存的数据合并到 AppState 中，防止默认字段丢失
                AppState.profileDIY = { ...AppState.profileDIY, ...loadedProfileDIY };
                console.log('✅ 已成功加载个人主页 DIY 数据');
            }
            AppState.apiConfigurations = dataMap.get('apiConfigurations') || [];
            AppState.apiCurrentSettings = dataMap.get('apiCurrentSettings') || { provider: 'newapi', url: '', key: '', model: '', temperature: 1.0 };
            AppState.lastUsedApiConfigName = dataMap.get('lastUsedApiConfigName') || '无';
            AppState.stickerGroups = await db.stickerGroups.toArray();
            AppState.iconSettings = dataMap.get('iconSettings') || {};
            AppState.wallpapers.home = dataMap.get('homeWallpaper');
            AppState.wallpapers.system = dataMap.get('systemUiBackground');
            AppState.wallpapers.app = dataMap.get('appContentBackground');
            AppState.homeScreenWidget = dataMap.get('homeScreenWidget') || 'ticket';
            const loadedImages = dataMap.get('homeScreenImages');
           if (loadedImages) {
                AppState.homeScreenImages = { ...AppState.homeScreenImages, ...loadedImages };
            }
            const loadedIdCardData = dataMap.get('idCardData');
            if (loadedIdCardData) AppState.idCardData = loadedIdCardData;   
             const loadedPlayerData = dataMap.get('playerWidgetData');
            if (loadedPlayerData) AppState.playerWidgetData = loadedPlayerData;
            AppState.desktopSchemes = dataMap.get('desktopSchemes') || [];
            AppState.desktopIconNameColor = normalizeDesktopIconNameColor(dataMap.get('desktopIconNameColor') || AppState.desktopIconNameColor || DEFAULT_DESKTOP_ICON_NAME_COLOR);
            document.documentElement.style.setProperty('--desktop-icon-name-color', AppState.desktopIconNameColor);
            const storedTtsSettings = dataMap.get('ttsGlobalSettings');

            if (storedTtsSettings) {
            // 用数据库的数据覆盖默认值
            AppState.ttsGlobalSettings = { ...AppState.ttsGlobalSettings, ...storedTtsSettings };
        }
            const storedVoiceRecognitionSettings = dataMap.get('voiceRecognitionSettings');
            if (storedVoiceRecognitionSettings) {
                AppState.voiceRecognitionSettings = {
                    ...AppState.voiceRecognitionSettings,
                    ...storedVoiceRecognitionSettings
                };
            }
            await loadGallerySettings(); // 注意这里是 await
            return true;
        } catch (error) {
            console.error("加载数据失败:", error);
            showDataLoadRecovery(error);
            return false;
        }
    }

    window.__lookyBootStage = 'before loadDataFromDB';
    const isDataLoaded = await loadDataFromDB();
    if (!isDataLoaded) {
        return;
    }
    window.__lookyBootStage = 'after loadDataFromDB';
    await restoreBackgroundActivityAfterBoot().catch(error => console.warn('[睡眠系统] 后台计时恢复失败:', error));
   initProfilePage(); 
    loadHybridStateFromSession();

    /* --- 4.2 初始化所有UI和功能模块 --- */
    setupDynamicContent();
    (function setupAccountSecurityEntry() {
        const settingsContent = document.querySelector('#page-settings .app-content');
        if (!settingsContent || settingsContent.querySelector('[data-page="page-account-security"]')) return;

        const firstCard = settingsContent.querySelector('.settings-card');
        const accountCard = document.createElement('div');
        accountCard.className = 'settings-card';

        const accountItem = document.createElement('div');
        accountItem.className = 'list-item';
        accountItem.dataset.page = 'page-account-security';
        accountItem.innerHTML = `
            <div class="settings-item-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M20 21a8 8 0 0 0-16 0"></path>
                    <circle cx="12" cy="7" r="4"></circle>
                    <path d="M18 8V6a6 6 0 0 0-12 0v2"></path>
                </svg>
            </div>
            <span class="settings-item-text">账号管理</span>
            <div class="settings-item-arrow">
                <svg fill="none" viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </div>
        `;
        accountCard.appendChild(accountItem);

        if (firstCard?.nextSibling) {
            settingsContent.insertBefore(accountCard, firstCard.nextSibling);
        } else {
            settingsContent.appendChild(accountCard);
        }
    })();
    (function setupAccountSecurityUi() {
        const page = document.getElementById('page-account-security');
        if (!page || page.dataset.accountSecurityReady === 'true') return;
        page.dataset.accountSecurityReady = 'true';

        const auth = window.LookyAuth;
        const changeModal = document.getElementById('account-change-password-modal');
        const resetModal = document.getElementById('account-reset-account-modal');
        const deviceNameModal = document.getElementById('account-device-name-modal');
        const modals = [changeModal, resetModal, deviceNameModal].filter(Boolean);
        const accountName = document.getElementById('account-security-name');
        const accountStatus = document.getElementById('account-security-status');
        const accountDevice = document.getElementById('account-security-device');
        const sessionCount = document.getElementById('account-security-session-count');
        const sessionsContainer = document.getElementById('account-security-sessions');
        const refreshButton = document.getElementById('account-security-refresh');
        const logoutButton = document.getElementById('account-security-logout');
        const renameDeviceButton = document.getElementById('account-security-rename-device');
        const deviceNameInput = document.getElementById('account-device-name-input');
        const saveDeviceNameButton = document.getElementById('account-device-name-save');
        const changePasswordButton = document.getElementById('account-change-password-save');
        const resetAccountButton = document.getElementById('account-reset-account-confirm');

        const formatSessionTime = value => {
            const date = new Date(value);
            return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString('zh-CN', { hour12: false });
        };
        const getSessionList = data => Array.isArray(data?.sessions)
            ? data.sessions
            : (Array.isArray(data?.items) ? data.items : []);
        const showAuthError = error => {
            if (['SESSION_REVOKED', 'ACCOUNT_RESET', 'ACCOUNT_REVOKED'].includes(error?.code)) {
                auth?.clear();
                window.location.reload();
                return;
            }
            showDynamicIsland(error?.isNetworkError ? '网络暂时不可用，请稍后重试' : (error?.message || '操作失败，请稍后重试'));
        };
        const setAccountSummary = () => {
            if (!auth) return;
            const displayAccount = auth.getDisplayAccount();
            const accountKey = auth.getAccountKey();
            if (accountName) accountName.textContent = displayAccount || accountKey || '未登录';
            if (accountStatus) accountStatus.textContent = auth.getSessionToken() ? '账号状态：已登录' : '当前登录状态已失效';
            if (accountDevice) accountDevice.textContent = auth.getSessionToken()
                ? `当前设备：${auth.getSessionName?.() || auth.getDeviceLabel()}`
                : '当前设备：未登录';
        };
        const renderSessions = sessions => {
            if (!sessionsContainer || !sessionCount || !auth) return;
            const currentDeviceId = auth.getDeviceId();
            sessionCount.textContent = `${sessions.length} / 3`;
            sessionsContainer.innerHTML = '';
            if (sessions.length === 0) {
                sessionsContainer.className = 'account-security-sessions-empty';
                sessionsContainer.textContent = '当前没有可显示的登录设备';
                return;
            }
            sessionsContainer.className = 'account-security-sessions-list';
            sessions.forEach(session => {
                const isCurrent = session.current === true || session.deviceId === currentDeviceId;
                const sessionName = isCurrent
                    ? (auth.getSessionName?.() || session.deviceLabel || session.platform || '网站设备')
                    : (session.deviceLabel || session.platform || '网站设备');
                const item = document.createElement('div');
                item.className = 'account-security-session-item';
                item.innerHTML = `
                    <div class="account-security-session-copy">
                        <strong>${escapeHTML(sessionName)}${isCurrent ? '（当前设备）' : ''}</strong>
                        <small>登录时间：${escapeHTML(formatSessionTime(session.createdAt))}</small>
                        <small>最后活跃：${escapeHTML(formatSessionTime(session.lastSeenAt))}</small>
                    </div>
                    ${isCurrent ? '' : '<button class="btn btn-secondary account-security-session-revoke" type="button">退出此设备</button>'}
                `;
                const revokeButton = item.querySelector('.account-security-session-revoke');
                revokeButton?.addEventListener('click', async () => {
                    const sessionId = session._id || session.id;
                    if (!sessionId) {
                        showDynamicIsland('服务器没有返回设备编号');
                        return;
                    }
                    if (!window.confirm(`确定退出“${sessionName}”吗？`)) return;
                    revokeButton.disabled = true;
                    try {
                        await auth.revokeSession(sessionId);
                        await loadSessions();
                    } catch (error) {
                        revokeButton.disabled = false;
                        showAuthError(error);
                    }
                });
                sessionsContainer.appendChild(item);
            });
        };
        const loadSessions = async () => {
            setAccountSummary();
            if (!auth || !auth.getSessionToken()) {
                if (sessionCount) sessionCount.textContent = '0 / 3';
                if (sessionsContainer) {
                    sessionsContainer.className = 'account-security-sessions-empty';
                    sessionsContainer.textContent = '当前登录状态已失效，请重新登录';
                }
                return;
            }
            if (sessionsContainer) {
                sessionsContainer.className = 'account-security-sessions-empty';
                sessionsContainer.textContent = '正在读取设备列表...';
            }
            try {
                const data = await auth.listSessions();
                renderSessions(getSessionList(data));
            } catch (error) {
                if (sessionsContainer) {
                    sessionsContainer.className = 'account-security-sessions-empty';
                    sessionsContainer.textContent = error?.isNetworkError ? '网络暂时不可用，请点击刷新重试' : (error?.message || '设备列表读取失败');
                }
                showAuthError(error);
            }
        };
        const closeModal = modal => {
            if (!modal) return;
            modal.classList.remove('visible');
            modal.setAttribute('aria-hidden', 'true');
            if (!modals.some(item => item.classList.contains('visible'))) {
                document.body.classList.remove('modal-open');
            }
        };
        const openModal = modal => {
            if (!modal) return;
            modals.forEach(item => { if (item !== modal) closeModal(item); });
            modal.classList.add('visible');
            modal.setAttribute('aria-hidden', 'false');
            document.body.classList.add('modal-open');
        };

        document.getElementById('account-security-change-password')?.addEventListener('click', () => {
            openModal(changeModal);
            document.getElementById('account-old-password').value = '';
            document.getElementById('account-new-password').value = '';
            document.getElementById('account-old-password')?.focus();
        });
        document.getElementById('account-security-reset-account')?.addEventListener('click', () => openModal(resetModal));
        renameDeviceButton?.addEventListener('click', () => {
            if (!auth?.getSessionToken()) {
                showDynamicIsland('当前登录状态已失效，请重新登录');
                return;
            }
            if (deviceNameInput) deviceNameInput.value = auth.getSessionName?.() || auth.getDeviceLabel();
            openModal(deviceNameModal);
            deviceNameInput?.focus();
        });
        refreshButton?.addEventListener('click', loadSessions);
        document.getElementById('account-change-password-cancel')?.addEventListener('click', () => closeModal(changeModal));
        document.getElementById('account-device-name-cancel')?.addEventListener('click', () => closeModal(deviceNameModal));
        saveDeviceNameButton?.addEventListener('click', () => {
            const sessionName = deviceNameInput?.value.trim() || '';
            if (!sessionName) {
                showDynamicIsland('请输入会话名称');
                deviceNameInput?.focus();
                return;
            }
            auth?.setSessionName?.(sessionName);
            closeModal(deviceNameModal);
            setAccountSummary();
            loadSessions();
            showDynamicIsland('会话名称已保存');
        });
        changePasswordButton?.addEventListener('click', async () => {
            const oldPassword = document.getElementById('account-old-password')?.value || '';
            const newPassword = document.getElementById('account-new-password')?.value || '';
            if (!oldPassword || !newPassword) {
                showDynamicIsland('请输入当前密码和新密码');
                return;
            }
            if (newPassword.length < 6 || newPassword.length > 128 || !newPassword.trim()) {
                showDynamicIsland('新密码长度需为 6 到 128 个字符，且不能全部为空格');
                return;
            }
            changePasswordButton.disabled = true;
            try {
                await auth.changePassword({ oldPassword, newPassword });
                closeModal(changeModal);
                showDynamicIsland('密码已修改，其他设备需要重新登录');
                await loadSessions();
            } catch (error) {
                showAuthError(error);
            } finally {
                changePasswordButton.disabled = false;
            }
        });
        document.getElementById('account-reset-account-cancel')?.addEventListener('click', () => closeModal(resetModal));
        resetAccountButton?.addEventListener('click', async () => {
            if (!window.confirm('确定重置账号吗？此操作会退出所有设备，旧密码和旧激活码会失效。')) return;
            resetAccountButton.disabled = true;
            try {
                await auth.selfResetAccount();
                closeModal(resetModal);
                auth.clear();
                showDynamicIsland('账号已重置，请重新激活');
                setTimeout(() => window.location.reload(), 700);
            } catch (error) {
                showAuthError(error);
            } finally {
                resetAccountButton.disabled = false;
            }
        });
        logoutButton?.addEventListener('click', async () => {
            if (!window.confirm('确定退出当前设备吗？聊天记录和图片不会被删除。')) return;
            logoutButton.disabled = true;
            try {
                await auth.logout();
            } catch (error) {
                showAuthError(error);
            } finally {
                window.location.reload();
            }
        });
        modals.forEach(modal => {
            modal.addEventListener('click', event => {
                if (event.target === modal) closeModal(modal);
            });
        });
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            modals.forEach(modal => {
                if (modal.classList.contains('visible')) closeModal(modal);
            });
        });
        window.addEventListener('looky:page-opened', event => {
            if (event.detail?.pageId === 'page-account-security') loadSessions();
        });
    })();
    (function setupAppUpdateSettings() {
        const settingsContent = document.querySelector('#page-settings .app-content');
        if (!settingsContent || !isNativeRuntime() || settingsContent.querySelector('#looky-app-update-card')) return;

        const updateCard = document.createElement('div');
        updateCard.id = 'looky-app-update-card';
        updateCard.className = 'settings-card';
        updateCard.innerHTML = `
            <div class="settings-item">
                <span>当前版本</span>
                <div class="settings-item-value"><span id="looky-current-version">读取中</span></div>
            </div>
            <div class="settings-item">
                <span>最新版本</span>
                <div class="settings-item-value"><span id="looky-latest-version">尚未检测</span></div>
            </div>
            <div style="display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--c-border-light, #eee);">
                <button id="looky-check-update-btn" class="btn btn-secondary" type="button" style="flex: 1; min-width: 0; padding: 10px 8px; font-size: 13px;">检测更新</button>
                <button id="looky-apply-update-btn" class="btn btn-primary" type="button" style="flex: 1; min-width: 0; padding: 10px 8px; font-size: 13px;" disabled>立即更新</button>
            </div>
            <div id="looky-update-status" style="padding: 0 16px 12px; color: var(--c-text-secondary, #8e8e93); font-size: 12px; line-height: 1.4;">进入此页面后可检测版本</div>
        `;
        settingsContent.appendChild(updateCard);

        const currentVersionEl = updateCard.querySelector('#looky-current-version');
        const latestVersionEl = updateCard.querySelector('#looky-latest-version');
        const statusEl = updateCard.querySelector('#looky-update-status');
        const checkBtn = updateCard.querySelector('#looky-check-update-btn');
        const applyBtn = updateCard.querySelector('#looky-apply-update-btn');
        const currentVersion = getLookyBuildVersion();
        let latestUpdate = null;

        currentVersionEl.textContent = currentVersion || '未知';

        const checkUpdate = async () => {
            checkBtn.disabled = true;
            applyBtn.disabled = true;
            statusEl.textContent = '正在检查最新版本...';
            latestUpdate = null;
            try {
                let result;
                if (isNativeRuntime()) {
                    result = await getNativeUpdateStatus(currentVersion);
                    if (result.error) throw result.error;
                } else {
                    const manifest = await fetchWebUpdateManifest();
                    const latestVersion = String(manifest.version || '').trim();
                    result = {
                        checked: true,
                        updateAvailable: Boolean(latestVersion && currentVersion && latestVersion !== currentVersion),
                        latestVersion,
                        manifest
                    };
                }

                latestVersionEl.textContent = result.latestVersion || '读取失败';
                latestUpdate = result.updateAvailable ? result : null;
                applyBtn.disabled = !latestUpdate;
                statusEl.textContent = latestUpdate ? '发现新版本，可以立即更新' : '当前已经是最新版本';
            } catch (error) {
                latestVersionEl.textContent = '读取失败';
                statusEl.textContent = '检查失败，请确认网络连接后重试';
                console.warn('[Looky Update] 手动检查失败:', error);
            } finally {
                checkBtn.disabled = false;
            }
        };

        checkBtn.addEventListener('click', checkUpdate);
        applyBtn.addEventListener('click', async () => {
            if (!latestUpdate) {
                await checkUpdate();
                if (!latestUpdate) return;
            }

            applyBtn.disabled = true;
            checkBtn.disabled = true;
            statusEl.textContent = '正在下载更新，请不要关闭应用...';
            try {
                if (isNativeRuntime()) {
                    const result = await downloadNativeWebBundle(latestUpdate.manifest);
                    if (!result.updated) throw result.error || new Error('更新没有完成');
                    return;
                }

                window.__LOOKY_PENDING_UPDATE = latestUpdate.manifest;
                document.getElementById('force-update-now-btn')?.click();
            } catch (error) {
                statusEl.textContent = '更新失败，当前版本没有被替换';
                checkBtn.disabled = false;
                applyBtn.disabled = false;
                console.warn('[Looky Update] 手动更新失败:', error);
            }
        });

        window.addEventListener('looky:page-opened', event => {
            if (event.detail?.pageId === 'page-settings' && isNativeRuntime()) checkUpdate();
        });
    })();
    UI.appPages = document.querySelectorAll('.app-page');
    UI.chatMessageList = document.getElementById('chat-message-list');
  
    updateTime();
    setInterval(updateTime, 1000);
     if (UI.homePagerContainer) {
        UI.homePagerContainer.addEventListener('scroll', () => {
            const scrollLeft = UI.homePagerContainer.scrollLeft;
            const width = UI.homePagerContainer.offsetWidth;
            const pageIndex = Math.round(scrollLeft / width);
            
            UI.homeDots.forEach((dot, index) => {
                dot.classList.toggle('active', index === pageIndex);
            });
        });
    }
        updateBatteryStatus();
    // ▼▼▼ 【修改】将三个拍立得组件加入自动保存列表 ▼▼▼
    [
        { input: 'large-photo-upload', img: 'large-photo-img' },
        { input: 'ticket-photo-upload', img: 'ticket-photo-img' }, 
        { input: 'account-avatar-upload', img: 'account-avatar-img' },
        { input: 'char-modal-avatar-upload', img: 'char-modal-avatar-preview' },
        // 新增的三个拍立得
        { input: 'polaroid-upload-1', img: 'polaroid-img-1' },
        { input: 'polaroid-upload-2', img: 'polaroid-img-2' },
        { input: 'polaroid-upload-3', img: 'polaroid-img-3' },
        { input: 'insta-upload-input', img: 'insta-display-img' },
        { input: 'tw-upload-1', img: 'tw-img-1' },
        { input: 'tw-upload-2', img: 'tw-img-2' },
        { input: 'tw-upload-3', img: 'tw-img-3' }
    ].forEach(item => setupImageUploader(item.input, item.img));

    setupIdentitySwitcher();
    setupPersonaPage();
    setupSocialCircle();
    setupStickersPage();
    setupApiSettings();
    initImageGenApiSettings();
    initVectorApiSettings();
    initMcpSettingsPage();
    setupRoleMcpSettings();
    setupScreenSettings();
     initSoundSettings();
    setupChatAndCharManagement();
    initChatSearchPage();
    initChatFavoritesPage();
    (function setupImageGenApiSettingsLink() {
        const settingsContent = document.querySelector('#page-settings .app-content');
        if (!settingsContent) return;

        const apiCard = settingsContent.querySelector('[data-page="page-settings-api"]')?.closest('.settings-card');
        if (settingsContent.querySelector('[data-page="page-image-gen-api-settings"]')) return;

        const item = document.createElement('div');
        item.className = 'list-item settings-list-item';
        item.dataset.page = 'page-image-gen-api-settings';
        item.innerHTML = `
            <div class="settings-item-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1c1c1e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                    <circle cx="8.5" cy="8.5" r="1.5"></circle>
                    <path d="M21 15l-5-5L5 21"></path>
                </svg>
            </div>
            <div class="settings-item-text">
                <span>生图 API 设置</span>
            </div>
            <div class="settings-item-value value">
                <span id="image-gen-api-settings-badge" style="font-size: 11px;">未配置</span>
            </div>
        `;
        if (apiCard) {
            apiCard.appendChild(item);
        } else {
            const fallbackCard = document.createElement('div');
            fallbackCard.className = 'settings-card';
            fallbackCard.appendChild(item);
            settingsContent.appendChild(fallbackCard);
        }

        const updateBadge = async () => {
            const badge = document.getElementById('image-gen-api-settings-badge');
            if (!badge) return;
            const settings = await getImageGenSettings();
            badge.textContent = settings.url && settings.apiKey ? '已配置' : '未配置';
        };
        window.addEventListener('looky:page-opened', event => {
            if (event.detail?.pageId === 'page-settings') updateBadge();
        });
        updateBadge();
    })();
    (function setupMcpSettingsLink() {
        const settingsContent = document.querySelector('#page-settings .app-content');
        if (!settingsContent || settingsContent.querySelector('[data-page="page-mcp-settings"]')) return;
        const apiItem = settingsContent.querySelector('[data-page="page-image-gen-api-settings"]');
        if (!apiItem) return;
        const item = document.createElement('div');
        item.className = 'list-item settings-list-item mcp-settings-link';
        item.dataset.page = 'page-mcp-settings';
        item.innerHTML = `
            <div class="settings-item-icon mcp-settings-entry-icon-wrap">
                <svg class="mcp-settings-entry-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="6" rx="2"></rect>
                    <rect x="3" y="14" width="18" height="6" rx="2"></rect>
                    <circle cx="7" cy="7" r="0.8" fill="currentColor" stroke="none"></circle>
                    <circle cx="7" cy="17" r="0.8" fill="currentColor" stroke="none"></circle>
                    <path d="M11 7h6M11 17h6"></path>
                </svg>
            </div>
            <div class="settings-item-text"><span>MCP 工具</span></div>
            <div class="settings-item-value value mcp-settings-entry-value">
                <span id="mcp-settings-badge" class="mcp-settings-entry-status">未配置</span>
                <span class="mcp-settings-entry-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><polyline points="9 6 15 12 9 18"></polyline></svg></span>
            </div>
        `;
        apiItem.parentElement?.insertBefore(item, apiItem.nextSibling);
        item.addEventListener('click', () => showPage('page-mcp-settings'));
        const updateBadge = async () => {
            const badge = document.getElementById('mcp-settings-badge');
            if (!badge) return;
            const { loadMcpSettings } = await import('./features/mcp.js');
            const settings = await loadMcpSettings();
            const enabledServers = settings.servers.filter(server => server.enabled).length;
            badge.textContent = !settings.enabled
                ? '已关闭'
                : (enabledServers ? `${enabledServers} 个 MCP` : '未配置');
        };
        window.addEventListener('looky:page-opened', event => {
            if (event.detail?.pageId === 'page-settings') updateBadge();
        });
        updateBadge();
    })();
    (function setupVectorApiSettingsLink() {
        const settingsContent = document.querySelector('#page-settings .app-content');
        if (!settingsContent) return;

        const apiCard = settingsContent.querySelector('[data-page="page-settings-api"]')?.closest('.settings-card');
        if (settingsContent.querySelector('[data-page="page-vector-api-settings"]')) return;

        const item = document.createElement('div');
        item.className = 'list-item settings-list-item';
        item.dataset.page = 'page-vector-api-settings';
        item.innerHTML = `
            <div class="settings-item-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1c1c1e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 6h16"></path>
                    <path d="M4 12h10"></path>
                    <path d="M4 18h16"></path>
                </svg>
            </div>
            <div class="settings-item-text">
                <span>向量检索 API 设置</span>
            </div>
            <div class="settings-item-value value">
                <span id="vector-api-settings-badge" style="font-size: 11px;">未配置</span>
            </div>
        `;
        if (apiCard) {
            apiCard.appendChild(item);
        } else {
            const fallbackCard = document.createElement('div');
            fallbackCard.className = 'settings-card';
            fallbackCard.appendChild(item);
            settingsContent.appendChild(fallbackCard);
        }

        const updateBadge = async () => {
            const badge = document.getElementById('vector-api-settings-badge');
            if (!badge) return;
            const settings = await getVectorApiConfig();
            badge.textContent = settings.enabled ? '已配置' : '未配置';
        };
        window.addEventListener('looky:page-opened', event => {
            if (event.detail?.pageId === 'page-settings') updateBadge();
        });
        updateBadge();
    })();
    (function setupUpdateLogLink() {
        const settingsContent = document.querySelector('#page-settings .app-content');
        if (!settingsContent) return;

        const logTarget = document.getElementById('settings-update-log-content');
        const logSource = document.getElementById('update-log-content-source');
        if (logTarget && logSource) {
            logTarget.innerHTML = logSource.innerHTML;
        }

        const newCard = document.createElement('div');
        newCard.className = 'settings-card';

        const updateLogItem = document.createElement('div');
        updateLogItem.className = 'settings-item';
        updateLogItem.dataset.page = 'page-update-log';
        updateLogItem.innerHTML = `
            <div style="display: flex; align-items: center;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1c1c1e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 10px;">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                    <line x1="16" y1="13" x2="8" y2="13"></line>
                    <line x1="16" y1="17" x2="8" y2="17"></line>
                </svg>
                <span>更新日志</span>
            </div>
            <div class="settings-item-value">
                <span style="font-size: 12px; color: #8e8e93; margin-right: 4px;">9.13</span>
                <div class="settings-arrow">›</div>
            </div>
        `;
        newCard.appendChild(updateLogItem);
        settingsContent.appendChild(newCard);
    })();
        // 【这是本次新增的代码】在设置页面动态添加“系统日志”入口
    (function setupSystemLogLink() {
        const settingsContent = document.querySelector('#page-settings .app-content');
        if (!settingsContent) return;

        // 查找“用户须知”卡片，确保日志入口在它之上
        const disclaimerCard = settingsContent.querySelector('.settings-item[data-page="page-settings-disclaimer"]')?.closest('.settings-card');

        // 创建新的卡片和列表项
         const newCard = document.createElement('div');
        newCard.className = 'settings-card';

        const logItem = document.createElement('div');
        logItem.className = 'settings-item';
        logItem.dataset.page = 'page-system-log'; 
        logItem.innerHTML = `
            <div style="display: flex; align-items: center;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1c1c1e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 10px;">
                   <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                   <line x1="8" y1="21" x2="16" y2="21"></line>
                   <line x1="12" y1="17" x2="12" y2="21"></line>
                </svg>
                <span>系统日志</span>
            </div>
            <div class="settings-item-value">
                <span style="font-size: 12px; color: #8e8e93; margin-right: 4px;">Console</span>
                <div class="settings-arrow">›</div>
            </div>
        `;
        newCard.appendChild(logItem);


        // 将新卡片插入到“用户须知”卡片之前，如果找不到就插在末尾
        if (disclaimerCard) {
            settingsContent.insertBefore(newCard, disclaimerCard);
        } else {
            settingsContent.appendChild(newCard);
        }
    })();

        // 【这是本次新增的代码】在设置页面动态添加入口
    (function setupDisclaimerLink() {
        const settingsContent = document.querySelector('#page-settings .app-content');
        if (!settingsContent) return;

        // 1. 创建一个新的卡片容器
        const newCard = document.createElement('div');
        newCard.className = 'settings-card';

        // 2. 创建列表项
        const disclaimerItem = document.createElement('div');
              disclaimerItem.className = 'settings-item';
        disclaimerItem.dataset.page = 'page-settings-disclaimer'; // 链接到我们新创建的页面ID
        disclaimerItem.innerHTML = `
            <div style="display: flex; align-items: center;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1c1c1e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 10px;">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
                <span>用户须知和免责声明</span>
            </div>
            <div class="settings-item-value">
                <div class="settings-arrow">›</div>
            </div>
        `;
        // 3. 把列表项放入卡片，再把卡片放入设置页面
        newCard.appendChild(disclaimerItem);
        settingsContent.appendChild(newCard);
    })();

    // ▼▼▼ 【新增】系统推送通知(后台弹窗) UI与权限逻辑 ▼▼▼
    (function setupSystemNotification() {
        const settingsContent = document.querySelector('#page-settings .app-content');
        if (!settingsContent) return;

        // 1. 创建卡片UI
        const notifCard = document.createElement('div');
        notifCard.className = 'settings-card';
        notifCard.innerHTML = `
            <div class="settings-item">
                <div style="display: flex; align-items: center;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1c1c1e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 10px;">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                        <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
                    </svg>
                    <span>系统推送通知 (后台提醒)</span>
                </div>
                <label class="switch">
                    <input type="checkbox" id="system-notification-toggle">
                    <span class="slider round"></span>
                </label>
            </div>
            <div id="system-notification-test-area" style="display: none; padding: 12px 16px; border-top: 1px solid var(--c-border-light, #eee);">
                <p style="font-size: 12px; color: var(--c-text-secondary, #8e8e93); margin-bottom: 10px; line-height: 1.4;">开启后，当应用置于后台时，AI消息将通过手机系统通知弹出。<br><b>注: 苹果iOS用户必须将本站添加到主屏幕(即PWA)才能生效。</b></p>
                <button id="test-system-notification-btn" class="btn btn-secondary full-width" style="font-size: 13px; padding: 8px;">发送测试通知</button>
            </div>
        `;
        settingsContent.appendChild(notifCard);

        // 2. 绑定逻辑
        const toggleBtn = document.getElementById('system-notification-toggle');
        const testArea = document.getElementById('system-notification-test-area');
        const testBtn = document.getElementById('test-system-notification-btn');

        const isEnabled = localStorage.getItem('system_push_enabled') === 'true';
        const getSystemNotificationPermission = async () => {
            if (isNativeRuntime()) return getNativeNotificationPermission();
            return 'Notification' in window ? Notification.permission : 'unsupported';
        };
        const syncNotificationControls = async () => {
            const permission = await getSystemNotificationPermission();
            toggleBtn.checked = isEnabled && permission === 'granted';
            testArea.style.display = toggleBtn.checked ? 'block' : 'none';
        };
        toggleBtn.checked = isEnabled;
        syncNotificationControls();

        toggleBtn.addEventListener('change', async (e) => {
            if (e.target.checked) {
                if (!isNativeRuntime() && !('Notification' in window)) {
                    alert('抱歉，您的浏览器或系统不支持通知功能。');
                    e.target.checked = false;
                    return;
                }
                // 请求系统通知权限
                const permission = isNativeRuntime()
                    ? await requestNativeNotificationPermission()
                    : await Notification.requestPermission();
                if (permission === 'granted') {
                    localStorage.setItem('system_push_enabled', 'true');
                    testArea.style.display = 'block';
                    if (typeof window.showDynamicIsland === 'function') window.showDynamicIsland('通知授权成功');
                } else {
                    alert('授权失败！请在系统设置或浏览器设置中允许本站发送通知。');
                    e.target.checked = false;
                    localStorage.setItem('system_push_enabled', 'false');
                    testArea.style.display = 'none';
                }
            } else {
                localStorage.setItem('system_push_enabled', 'false');
                testArea.style.display = 'none';
            }
        });

        // 3. 测试按钮逻辑：点击后倒数3秒，方便用户切到后台测试
        testBtn.addEventListener('click', () => {
            let time = 3;
            testBtn.innerText = `请在 ${time} 秒内将应用切回桌面...`;
            testBtn.disabled = true;
            
            const timer = setInterval(() => {
                time--;
                if (time > 0) {
                    testBtn.innerText = `请在 ${time} 秒内将应用切回桌面...`;
                } else {
                    clearInterval(timer);
                    testBtn.innerText = '发送测试通知';
                    testBtn.disabled = false;
                    
                    if (isNativeRuntime()) {
                        showNativeNotification('系统通知测试成功', '这是一条来自后台的测试通知！收到说明功能正常。', {
                            targetPage: 'page-settings'
                        }).then(shown => {
                            if (!shown) alert('通知未发送，请在手机系统设置中允许 LOOKY 通知。');
                        }).catch(error => {
                            console.warn('[Notification] Native test notification failed:', error);
                            alert('通知发送失败，请检查手机系统通知权限。');
                        });
                        return;
                    }

                    if ('Notification' in window && Notification.permission === 'granted') {
                        const notifOptions = {
                            body: '这是一条来自后台的测试通知！收到说明功能正常。',
                            icon: 'images/icon-192.png',
                            badge: 'images/icon-192.png',
                            vibrate: [200, 100, 200]
                        };
                        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                            navigator.serviceWorker.ready.then(reg => reg.showNotification('系统通知测试成功', notifOptions));
                        } else {
                            new Notification('系统通知测试成功', notifOptions);
                        }
                    }
                }
            }, 1000);
        });
    })();
    // ▲▲▲ 新增结束 ▲▲▲

    initVoiceFunctionality();
    initVideoCallModule(); 

    setupMemorySystem();
    setupMemoryDetailPage();
    setupRecentMemoryPage();
    initWorldBook();
    setupGalleryPage();
    setupGallerySettings(); 
    initOfflineModePage();
    setupHistoryRecordDetailInteraction(); // 调用我们新写的函数，让它生效
    momentsModule.init();
    initTimeSettings();
    chatBeautify.init();
    fontSettings.init();
    Diary.init();
    initCheckPhone();
    MusicPlayer.init();
    CoupleSpace.init();
    initGroupChatSettings();
    LookyPay.init();
    initCharacterLibraryPage();
    initCharacterAddPage();
    // 短信模块在用户打开短信页面或点击短信通知时按需加载，避免首页启动时抢占资源。
    // 羁绊模块在用户打开羁绊页面时按需加载，避免启动时绑定大量事件和计时器。
       import('./features/life-sync.js').then(({ LifeSync }) => {
        LifeSync.init();
    });
    try {
        const savedRides = localStorage.getItem('active_rides_state');
        if (savedRides) {
            tempState.activeRides = JSON.parse(savedRides);
            console.log('✅ 已恢复未完成的行程数据');
        }
    } catch (e) {
        console.error('恢复行程数据失败:', e);
    }
    initLifePage();
    initFlightSystem();
        // ▼▼▼ 新增：API悬浮球交互与互通逻辑 ▼▼▼
    const apiBall = document.getElementById('api-floating-ball');
    const apiBallModal = document.getElementById('api-floating-modal-overlay');
    const apiBallCloseBtn = document.getElementById('close-api-floating-btn');
    const apiBallConfigList = document.getElementById('api-floating-config-list');
    const apiBallGotoSettings = document.getElementById('api-floating-goto-settings');

    if (apiBall) {
      let isDragging = false, startX, startY, initialX, initialY;
      let rafId = null;
      const apiBallPositionKey = 'apiFloatingBallPosition';

      // The ball is a drag handle on both web and APK; keep its gesture out of
      // the page's scroll chain without changing ordinary taps.
      apiBall.style.touchAction = 'none';

      const applySavedApiBallPosition = () => {
        try {
          const savedPosition = JSON.parse(localStorage.getItem(apiBallPositionKey) || 'null');
          if (!savedPosition) return;
          const left = Math.max(-10, Math.min(window.innerWidth - 34, Number(savedPosition.left) || 0));
          const top = Math.max(0, Math.min(window.innerHeight - 44, Number(savedPosition.top) || 0));
          apiBall.style.left = left + 'px';
          apiBall.style.top = top + 'px';
          apiBall.style.right = 'auto';
          apiBall.style.bottom = 'auto';
        } catch (e) {
          localStorage.removeItem(apiBallPositionKey);
        }
      };

      const saveApiBallPosition = () => {
        try {
          localStorage.setItem(apiBallPositionKey, JSON.stringify({
            left: parseFloat(apiBall.style.left) || 0,
            top: parseFloat(apiBall.style.top) || 0
          }));
        } catch (e) {}
      };

      applySavedApiBallPosition();
      
      // 按下特效
      apiBall.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        isDragging = false;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        const rect = apiBall.getBoundingClientRect();
        initialX = rect.left;
        initialY = rect.top;
        apiBall.style.transition = 'none';
        apiBall.style.transform = 'scale(0.9)';
        // 拖拽时临时关闭毛玻璃特效，根除手机端掉帧卡顿
        apiBall.style.backdropFilter = 'none'; 
        apiBall.style.webkitBackdropFilter = 'none';
      }, { passive: true });

      // 拖动逻辑 (利用 requestAnimationFrame 硬件级同步刷新)
      const moveBall = (clientX, clientY) => {
        const dx = clientX - startX;
        const dy = clientY - startY;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) isDragging = true;
        
        if (isDragging) {
          let newX = initialX + dx;
          let newY = initialY + dy;
           // 防止拖出屏幕外 (留出10px的空间给微藏逻辑)
          newX = Math.max(-10, Math.min(window.innerWidth - 34, newX));
          newY = Math.max(0, Math.min(window.innerHeight - 44, newY));
          apiBall.style.left = newX + 'px';
          apiBall.style.top = newY + 'px';
          apiBall.style.right = 'auto';
          apiBall.style.bottom = 'auto';
        }
        rafId = null;
      };

      apiBall.addEventListener('touchmove', (e) => {
        const touch = e.touches && e.touches[0];
        if (touch) {
          const dx = touch.clientX - startX;
          const dy = touch.clientY - startY;
          if (Math.abs(dx) > 5 || Math.abs(dy) > 5) isDragging = true;
        }
        if (isDragging) {
          if (e.cancelable) e.preventDefault();
          e.stopPropagation();
        }
        if (!rafId) {
            rafId = requestAnimationFrame(() => moveBall(touch?.clientX, touch?.clientY));
        }
      }, { passive: false });
      // 抬起自动贴边 (微藏在边框里)
      apiBall.addEventListener('touchend', (e) => {
        if (isDragging) {
          if (e.cancelable) e.preventDefault();
          e.stopPropagation();
        }
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        apiBall.style.transform = 'scale(1)';
        apiBall.style.transition = 'left 0.3s cubic-bezier(0.25, 0.8, 0.25, 1), top 0.3s cubic-bezier(0.25, 0.8, 0.25, 1), transform 0.2s';
        // 彻底关闭毛玻璃特效，改用半透明纯色，拯救 GPU 发热
        apiBall.style.backdropFilter = 'none'; 
        apiBall.style.webkitBackdropFilter = 'none';
        apiBall.style.backgroundColor = 'rgba(255, 255, 255, 0.8)';

        if (isDragging) {
          const currentX = parseFloat(apiBall.style.left) || 0;
          if (currentX + 22 > window.innerWidth / 2) {
            // 靠右微藏，球宽44，留34在屏幕内，藏10
            apiBall.style.left = (window.innerWidth - 34) + 'px'; 
          } else {
            // 靠左微藏，向左缩进10
            apiBall.style.left = '-10px'; 
          }
          saveApiBallPosition();
        }
      });
      apiBall.addEventListener('touchcancel', (e) => {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        isDragging = false;
        apiBall.style.transform = 'scale(1)';
      }, { passive: false });
      // 点击打开弹窗
      apiBall.addEventListener('click', (e) => {
        if (isDragging) return;
        renderApiBallConfigList();
        apiBallModal.classList.add('visible');
      });
    }

    if (apiBallModal) {
      apiBallCloseBtn.addEventListener('click', () => apiBallModal.classList.remove('visible'));
      apiBallModal.addEventListener('click', (e) => {
        if (e.target === apiBallModal) apiBallModal.classList.remove('visible');
      });
      // 快捷跳转
      apiBallGotoSettings.addEventListener('click', () => {
        apiBallModal.classList.remove('visible');
        showPage('page-settings-api');
      });
    }

    // 动态渲染快捷配置列表
    function renderApiBallConfigList() {
      if (!apiBallConfigList) return;
      apiBallConfigList.innerHTML = '';
      if (!AppState.apiConfigurations || AppState.apiConfigurations.length === 0) {
        apiBallConfigList.innerHTML = '<div style="text-align:center; color:#999; font-size:13px; padding:20px; border-radius:12px; background:#f9f9f9;">请先前往 API 设置中【另存为配置】</div>';
        return;
      }
      
      AppState.apiConfigurations.forEach(config => {
        const isActive = config.name === AppState.lastUsedApiConfigName;
        const item = document.createElement('div');
        
        item.style.cssText = `display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-radius: 14px; background: ${isActive ? '#111' : '#f7f7f7'}; color: ${isActive ? '#fff' : '#111'}; cursor: pointer; transition: transform 0.1s; border: 1px solid ${isActive ? '#111' : '#eee'};`;
        
        item.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:4px; max-width: 80%;">
            <span style="font-weight: 700; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(config.name)}</span>
            <span style="font-size: 11px; opacity: ${isActive ? '0.8' : '0.5'};">${escapeHTML(config.model || '未选模型')}</span>
          </div>
          ${isActive ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 20px; height: 20px; color: #34c759;"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
        `;
        
        item.addEventListener('click', async () => {
          // 数据同步互通核心逻辑
          AppState.apiCurrentSettings = {
            ...config,
            summaryUrl: AppState.apiCurrentSettings?.summaryUrl || '',
            summaryKey: AppState.apiCurrentSettings?.summaryKey || '',
            summaryModel: AppState.apiCurrentSettings?.summaryModel || ''
          };
          delete AppState.apiCurrentSettings.name;
          AppState.lastUsedApiConfigName = config.name;
          
          await db.appData.bulkPut([
            { key: 'apiCurrentSettings', value: AppState.apiCurrentSettings },
            { key: 'lastUsedApiConfigName', value: AppState.lastUsedApiConfigName }
          ]);
          
          showDynamicIsland(`已切换至: ${config.name}`, 'success');
          
          // 同步 UI 上的显示 (使得你点进设置页时显示是最新的)
          const providerVal = document.getElementById('api-provider-value');
          if (providerVal) {
             const names = { newapi: 'NewAPI', deepseek: 'DeepSeek', claude: 'Claude', gemini: 'Gemini' };
             providerVal.textContent = names[config.provider] || '自定义';
             document.getElementById('api-url-value').textContent = config.url || '未设置';
             document.getElementById('api-key-value').textContent = config.key ? '••••••••' : '未设置';
             document.getElementById('api-model-value').textContent = config.model || '未选择';
             document.getElementById('current-config-value').textContent = config.name;
          }
          
          renderApiBallConfigList();
          setTimeout(() => apiBallModal.classList.remove('visible'), 200); // 延迟关闭让用户看清选中状态
        });
        
        // 点击动效
        item.addEventListener('mousedown', () => item.style.transform = 'scale(0.98)');
        item.addEventListener('mouseup', () => item.style.transform = 'scale(1)');
        item.addEventListener('mouseleave', () => item.style.transform = 'scale(1)');
        
        apiBallConfigList.appendChild(item);
      });
    }
    // ▲▲▲ 新增结束 ▲▲▲
     // === 1. Top Widget 逻辑 (支持保存) ===
    const topWidget = document.querySelector('.top-widget-card');
    const twMoreBtn = topWidget.querySelector('.tw-btn:last-child');
    const twModal = document.getElementById('modal-top-widget-config');
    // 保存 Top Widget 设置到本地
    const saveTW = () => {
        const cfg = {
            col: document.getElementById('tw-config-color').value,
            op: document.getElementById('tw-config-opacity').value,
            img: topWidget.style.getPropertyValue('--tw-bg-image')
        };
        localStorage.setItem('tw_custom_cfg', JSON.stringify(cfg));
    };
    // 加载已保存的设置
    const loadTW = () => {
        const saved = localStorage.getItem('tw_custom_cfg');
        if (saved) {
            const cfg = JSON.parse(saved);
            topWidget.style.setProperty('--tw-bg-color', cfg.col);
            topWidget.style.setProperty('--tw-bg-opacity', cfg.op / 100);
            if(cfg.img) topWidget.style.setProperty('--tw-bg-image', cfg.img);
            document.getElementById('tw-config-color').value = cfg.col;
                   if(document.getElementById('tw-config-color-hex')) document.getElementById('tw-config-color-hex').value = cfg.col.toUpperCase();
            document.getElementById('tw-config-opacity').value = cfg.op;
        }
    };
    window.loadTW = loadTW; // ▼▼▼ 新增：把函数挂载到全局，方便一键切换样式 ▼▼▼
    loadTW(); // 页面加载时执行一次

    twMoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        twModal.classList.add('visible');
    });
    const twColorPicker = document.getElementById('tw-config-color');
    const twColorHex = document.getElementById('tw-config-color-hex');

    // 色块同步到文字
    twColorPicker.addEventListener('input', (e) => {
        const color = e.target.value.toUpperCase();
        twColorHex.value = color;
        topWidget.style.setProperty('--tw-bg-color', color);
        saveTW();
    });

    // 文字同步到色块
    twColorHex.addEventListener('input', (e) => {
        const val = e.target.value;
        if (/^#[0-9A-F]{6}$/i.test(val)) {
            twColorPicker.value = val;
            topWidget.style.setProperty('--tw-bg-color', val);
            saveTW();
        }
    });

    document.getElementById('tw-config-opacity').addEventListener('input', (e) => {
        topWidget.style.setProperty('--tw-bg-opacity', e.target.value / 100);
        saveTW();
    });
    document.getElementById('tw-config-upload').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                topWidget.style.setProperty('--tw-bg-image', `url(${event.target.result})`);
                saveTW();
            };
            reader.readAsDataURL(file);
        }
    });
    // === 2. Instagram Widget 逻辑 (支持保存 & 修复长按) ===
    const instaWrapper = document.querySelector('.instagram-widget-wrapper');
    const instaCard = document.querySelector('.instagram-widget-card');
    const instaHeader = document.querySelector('.insta-header');
    const instaModal = document.getElementById('modal-insta-widget-config');
    // 保存 Instagram 设置
    const saveInsta = () => {
        const cfg = {
            op: document.getElementById('insta-config-opacity').value,
            hCol: document.getElementById('insta-config-header-color').value,
            bCol: document.getElementById('insta-config-body-color').value,
            fCol: document.getElementById('insta-config-frame-color').value // 新增外框色
        };
        localStorage.setItem('insta_custom_cfg', JSON.stringify(cfg));
    };
    const loadInsta = () => {
        const saved = localStorage.getItem('insta_custom_cfg');
        if (saved) {
            const cfg = JSON.parse(saved);
            
            // 1. 处理透明背景色 (将Hex转为RGBA)
            const alpha = cfg.op / 100;
            const r = parseInt(cfg.bCol.slice(1, 3), 16);
            const g = parseInt(cfg.bCol.slice(3, 5), 16);
            const b = parseInt(cfg.bCol.slice(5, 7), 16);
            
            // 2. 应用样式：背景用rgba，外框用新的fCol变量
            instaWrapper.style.opacity = "1"; // 确保容器本身是不透明的，这样图片才清晰
            instaCard.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${alpha})`;
            instaCard.style.boxShadow = `0 0 0 6px ${cfg.fCol}, 0 8px 25px rgba(0, 0, 0, 0.08)`;
            
            instaHeader.style.backgroundColor = cfg.hCol;
            document.querySelectorAll('.instagram-widget-card .icon-circle, .instagram-widget-card .action-pill').forEach(el => el.style.backgroundColor = cfg.hCol);
            
            // 3. 同步回弹窗界面
            document.getElementById('insta-config-opacity').value = cfg.op;
            document.getElementById('insta-config-header-color').value = cfg.hCol;
            // 同步文字编号
            document.getElementById('insta-config-header-hex').value = cfg.hCol.toUpperCase();
             document.getElementById('insta-config-body-hex').value = cfg.bCol.toUpperCase();
            document.getElementById('insta-config-frame-hex').value = cfg.fCol.toUpperCase();
          

        }
    };
    window.loadInsta = loadInsta; // ▼▼▼ 新增：把函数挂载到全局 ▼▼▼
    loadInsta();

    // --- 修复：更稳妥的长按逻辑 ---
    let pressTimer;
    const startPress = (e) => {
        if (e.type === 'click' && e.button !== 0) return; // 排除非左键
        pressTimer = setTimeout(() => {
            instaModal.classList.add('visible');
        }, 600); // 持续0.6秒视为长按
    };
    const cancelPress = () => clearTimeout(pressTimer);
    // 绑定长按事件 (兼容手机和电脑)
    instaWrapper.addEventListener('mousedown', startPress);
    instaWrapper.addEventListener('touchstart', startPress, {passive: true});
    instaWrapper.addEventListener('mouseup', cancelPress);
    instaWrapper.addEventListener('mouseleave', cancelPress);
    instaWrapper.addEventListener('touchend', cancelPress);
    instaWrapper.addEventListener('contextmenu', (e) => e.preventDefault()); // 彻底禁用右键菜单，防止冲突
    document.getElementById('insta-config-opacity').addEventListener('input', (e) => {
        saveInsta(); loadInsta(); // 实时调用保存和加载以刷新RGBA背景
    });
    document.getElementById('insta-config-header-color').addEventListener('input', (e) => {
        saveInsta(); loadInsta();
    });
    document.getElementById('insta-config-body-color').addEventListener('input', (e) => {
        saveInsta(); loadInsta();
    });
    document.getElementById('insta-config-frame-color').addEventListener('input', (e) => {
        saveInsta(); loadInsta();
    });
    // Instagram 联动逻辑函数
    const setupColorSync = (pickerId, hexId) => {
        const picker = document.getElementById(pickerId);
        const hex = document.getElementById(hexId);
        picker.addEventListener('input', () => {
            hex.value = picker.value.toUpperCase();
            saveInsta(); loadInsta();
        });
        hex.addEventListener('input', () => {
            if (/^#[0-9A-F]{6}$/i.test(hex.value)) {
                picker.value = hex.value;
                saveInsta(); loadInsta();
            }
        });
    };

    setupColorSync('insta-config-header-color', 'insta-config-header-hex');
    setupColorSync('insta-config-body-color', 'insta-config-body-hex');
    setupColorSync('insta-config-frame-color', 'insta-config-frame-hex');

    // === 3. 重置按钮逻辑 (增加清除本地存储) ===
    document.getElementById('tw-config-reset').addEventListener('click', () => {
        topWidget.style.removeProperty('--tw-bg-color');
        topWidget.style.removeProperty('--tw-bg-opacity');
        topWidget.style.removeProperty('--tw-bg-image');
        localStorage.removeItem('tw_custom_cfg'); // 清除本子
        document.getElementById('tw-config-color').value = "#F2F2F4";
        document.getElementById('tw-config-opacity').value = 100;
        showDynamicIsland('已恢复默认并清除保存');
    });
    document.getElementById('insta-config-reset').addEventListener('click', () => {
        instaWrapper.style.opacity = "";
        instaHeader.style.backgroundColor = "";
        instaCard.style.backgroundColor = "";
        document.querySelectorAll('.instagram-widget-card .icon-circle, .instagram-widget-card .action-pill').forEach(el => el.style.backgroundColor = "");
        localStorage.removeItem('insta_custom_cfg'); // 清除本子
        document.getElementById('insta-config-opacity').value = 100;
        document.getElementById('insta-config-header-color').value = "#c9c9c9";
        document.getElementById('insta-config-body-color').value = "#E8E8ED";
        showDynamicIsland('已恢复默认并清除保存');
    });
    [twModal, instaModal].forEach(modal => {
        modal.querySelector('.btn-bw-primary').addEventListener('click', () => {
            modal.classList.remove('visible');
        });
        // 点击背景也可以关闭
        modal.addEventListener('click', (e) => {
            if(e.target === modal) modal.classList.remove('visible');
        });
    });
    /* --- 4.3 应用已保存的设置 --- */
    customizableIcons.forEach(icon => applyIconSetting(icon.id));
    if (AppState.wallpapers.system) UI.phoneScreen.style.backgroundImage = `url(${AppState.wallpapers.system})`;
    if (AppState.wallpapers.home) {
        // 【修复】优先尝试设置在独立的壁纸层上，以解决 iOS 底部截断问题
        const homeWallpaperLayer = document.getElementById('home-wallpaper-layer');
        if (homeWallpaperLayer) {
            homeWallpaperLayer.style.backgroundImage = `url(${AppState.wallpapers.home})`;
        } else {
            // 兜底：如果新层不存在（旧缓存等原因），还是设在老地方
            UI.homeScreenWrapper.style.backgroundImage = `url(${AppState.wallpapers.home})`;
        }
    }

    if (AppState.wallpapers.app) {
    document.querySelectorAll('.app-content, .chat-main-area').forEach(el => {
        if (!el.closest('#page-chat > .chat-main-area > .app-content')) {
            el.style.backgroundImage = `url(${AppState.wallpapers.app})`;
        }
    });
}
    for (const imageId in AppState.homeScreenImages) {
        const imageUrl = AppState.homeScreenImages[imageId];
        if (imageUrl) {
            const imgElement = document.getElementById(imageId);
            if (imgElement) imgElement.src = imageUrl;
        }
    }

    /* --- 4.4 绑定全局导航与通用事件 --- */
    document.querySelectorAll('[data-page]:not(.nav-item)').forEach(icon => {
        addTapListener(icon, async (e) => {
            e.preventDefault();
            const pageId = icon.dataset.page;
            if (isSmsPageId(pageId)) {
                try {
                    await ensureSmsLoaded();
                } catch (error) {
                    console.error('[SMS] load failed:', error);
                    showDynamicIsland('短信加载失败，请刷新重试');
                    return;
                }
            }
            if (isBondsPageId(pageId)) {
                try {
                    await ensureBondsLoaded();
                } catch (error) {
                    console.error('[Bonds] load failed:', error);
                    showDynamicIsland('羁绊加载失败，请刷新重试');
                    return;
                }
            }
            if (isForumPageId(pageId)) {
                try {
                    await ensureForumLoaded();
                } catch (error) {
                    console.error('[Forum] load failed:', error);
                    showDynamicIsland('论坛加载失败，请刷新重试');
                    return;
                }
            }
            showPage(pageId);
        });
    });
    document.querySelectorAll('.back-button').forEach(button => {
        addTapListener(button, () => {
            const targetId = button.dataset.target;
            if (targetId === 'home') showHomeScreen();
            else showPage(targetId);
        });
    });

    if (isNativeRuntime()) {
        const getActiveAppPage = () => {
            const currentPageId = getCurrentLookyPageId();
            const currentPage = currentPageId === 'home' ? null : document.getElementById(currentPageId);
            if (currentPage) return currentPage;
            return Array.from(document.querySelectorAll('.app-page'))
            .reverse().find(page => {
                const style = window.getComputedStyle(page);
                return style.display !== 'none' && style.visibility !== 'hidden';
            });
        };

        const handleLookyBack = () => {
            const activeElement = document.activeElement;
            const keyboardIsOpen = document.body.classList.contains('android-pwa-keyboard-open') || Boolean(
                activeElement &&
                ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement.tagName) &&
                window.visualViewport &&
                window.innerHeight - window.visualViewport.height > 80
            );
            if (keyboardIsOpen && activeElement && typeof activeElement.blur === 'function') {
                activeElement.blur();
                return true;
            }

            const offlineScenarioModal = document.getElementById('offline-scenario-modal');
            if (offlineScenarioModal?.classList.contains('visible')) {
                offlineScenarioModal.classList.remove('visible');
                return true;
            }

            const activePage = getActiveAppPage();
            const backButton = Array.from(activePage?.querySelectorAll('.back-button:not([disabled])') || [])
                .find(button => {
                    const style = window.getComputedStyle(button);
                    return style.display !== 'none' && style.visibility !== 'hidden';
            });
            if (backButton) {
                const targetId = backButton.dataset.target;
                if (targetId === 'home') showHomeScreen();
                else if (targetId) showPage(targetId);
                else return false;
                return true;
            }
            return false;
        };

        // Keep one guarded handler for both Android's system back gesture and
        // Capacitor's backButton event, which can arrive as two notifications.
        let nativeBackInProgress = false;
        let nativeBackLastHandled = false;
        const handleNativeBackOnce = () => {
            if (nativeBackInProgress) return nativeBackLastHandled;
            nativeBackInProgress = true;
            nativeBackLastHandled = handleLookyBack();
            window.setTimeout(() => { nativeBackInProgress = false; }, 250);
            return nativeBackLastHandled;
        };
        window.__lookyHandleNativeBack = handleNativeBackOnce;

        import('@capacitor/app').then(({ App }) => {
            if (window.__lookyNativeBackListenerRegistered) return;
            window.__lookyNativeBackListenerRegistered = true;
            App.addListener('backButton', ({ canGoBack } = {}) => {
                if (handleNativeBackOnce()) return;
                if (canGoBack && window.history.length > 1) {
                    window.history.back();
                    return;
                }
                App.exitApp().catch(error => console.warn('[NativeBack] 退出应用失败:', error));
            });
        }).catch(error => console.warn('[NativeBack] 系统返回监听不可用:', error));

        // Do not emulate edge swipes in the page. Android's system gesture
        // dispatches through Capacitor's App backButton listener above; a page
        // touch listener here can consume the gesture before Android sees it.
    }
document.querySelectorAll('.chat-bottom-nav').forEach(nav => {
        nav.addEventListener('click', (e) => {
            const targetItem = e.target.closest('.nav-item');
            if (targetItem && targetItem.dataset.page) {
                const pageId = targetItem.dataset.page; // <-- 增加这一行，获取页面ID
                const chatSection = targetItem.dataset.chatSection;
                if (pageId === 'page-chat' && document.getElementById('page-chat')?.style.display !== 'none' && typeof window.setChatHomeSection === 'function') {
                    window.setChatHomeSection(chatSection || 'friends-content');
                    return;
                }
                document.querySelectorAll('.chat-bottom-nav .nav-item').forEach(item => {
                    const samePage = item.dataset.page === pageId;
                    const sameChatSection = pageId !== 'page-chat' || item.dataset.chatSection === (chatSection || 'friends-content');
                    item.classList.toggle('active', samePage && sameChatSection);
                });
                showPage(pageId, pageId === 'page-chat' ? { chatSection } : {}); // <-- 修改这一行，使用 pageId
                
                // ▼▼▼ 【这是本次新增的代码】 ▼▼▼
                if (pageId === 'page-profile') {
                    initProfilePage();
                }
                // ▲▲▲ 新增代码结束 ▲▲▲
            }
        });
    });
  
    document.addEventListener('click', tryUnlockAudioContext);
    document.addEventListener('touchstart', tryUnlockAudioContext);
  
    // 移除旧的输入事件监听，因为它们已被移到 chat.js 中
      window.__lookyBootStage = 'before showHomeScreen';
      showHomeScreen();
      window.__lookyBootStage = 'after showHomeScreen';
      window.__lookyHideSplash?.();
      document.body.style.visibility = 'visible';
      document.body.classList.remove('is-booting');
      if (window.__lookyRevealFallback) {
          clearTimeout(window.__lookyRevealFallback);
          window.__lookyRevealFallback = null;
      }
      if (localStorage.getItem('sessionToken')) {
          removeLookyGate();
      }
      window.__lookyMarkBootComplete?.();

    setTimeout(() => {
        // 【修正】直接检查 audioContext 的官方状态
        if (audioContext.state !== 'running') {
            showDynamicIsland('💡 轻点屏幕任意位置以激活音频', 'info', 3000);
        }
    }, 1500);


    // ▼▼▼ 【修改2/4】定义并调用AI引擎预加载函数 ▼▼▼
    /**
     * AI 引擎预热函数
     * 在应用加载完成后，利用浏览器空闲时间在后台初始化AI模型。
     */
    async function prewarmAiEngine() {
        // APK 在用户真正打开图库 AI 功能时再初始化，避免启动阶段抢占 WebView。
        if (isLookyNativeRuntime) return;
        // 1. 检查设置是否开启AI功能
        if (!AppState.gallerySettings.isAiEnabled) {
            console.log('[AI Pre-warm] AI feature is disabled in settings. Skipping.');
            return;
        }

        // 2. 检查引擎是否已经就绪
        if (isAiEngineAvailable()) {
            console.log('[AI Pre-warm] AI engine is already available. Skipping.');
            return;
        }

        // 3. 使用 requestIdleCallback 来确保在浏览器不忙的时候执行
        if ('requestIdleCallback' in window) {
            window.requestIdleCallback(async () => {
                console.log('[AI Pre-warm] Browser is idle. Starting AI engine initialization in the background.');
                try {
                    await initializeSimilarityPipeline();
                    console.log('[AI Pre-warm] AI engine pre-warmed successfully.');
                } catch (error) {
                    console.error('[AI Pre-warm] Failed to pre-warm AI engine:', error);
                }
            }, { timeout: 2000 }); // timeout: 2秒后即使浏览器不空闲也强制开始
        } else {
            // 对于不支持的旧浏览器，延迟执行
            setTimeout(async () => {
                console.log('[AI Pre-warm] Starting AI engine initialization after a delay.');
                try {
                    await initializeSimilarityPipeline();
                    console.log('[AI Pre-warm] AI engine pre-warmed successfully.');
                } catch (error) {
                    console.error('[AI Pre-warm] Failed to pre-warm AI engine:', error);
                }
            }, 3000); // 延迟3秒
        }
    }

    // 调用预热函数
    prewarmAiEngine();
     // ==========================================================
    // == 【更新】数据管理页面交互逻辑 ==
    // ==========================================================
    // 1. 从 data-manager.js 文件导入导出和导入两个函数
    const { exportAllData, importAllData, exportChunkData, importChunkFiles, importNativeBackup, initExportReminder } = await import('./features/data-manager.js');
    const { initGithubBackup } = await import('./features/github-backup.js');

    // ▼▼▼ 新增：初始化定时备份提醒功能 ▼▼▼
    if (initExportReminder) initExportReminder();
    if (initGithubBackup) initGithubBackup();
    // ▲▲▲ 新增结束 ▲▲▲

    // 2. 找到页面上所有相关的按钮和元素
    const exportDataBtn = document.getElementById('export-data-btn');
    const importDataBtn = document.getElementById('import-data-btn');
    const dataImportInput = document.getElementById('data-import-input');
    
    // ▼ 新增：低内存分块导出按钮和导入输入框
    const appleChunkExportBtn = document.getElementById('apple-chunk-export-btn');
    const appleChunkImportInput = document.getElementById('apple-chunk-import-input');

    if (appleChunkExportBtn) {
      appleChunkExportBtn.addEventListener('click', () => {
        exportChunkData();
      });
    }
    
    if (appleChunkImportInput) {
      appleChunkImportInput.addEventListener('change', (event) => {
        const files = event.target.files;
        if (files && files.length > 0) {
          importChunkFiles(files);
          appleChunkImportInput.value = ''; // 允许重复选择同文件
        }
      });
    }
    // 3. 给“导出”按钮添加点击事件 (修改为：弹出选择框，摘下隐形斗篷)
    if (exportDataBtn) {
      exportDataBtn.addEventListener('click', () => {
        const modal = document.getElementById('global-export-modal-overlay');
        if (modal) {
            modal.style.display = 'flex'; // 先显示出来
            setTimeout(() => { modal.style.opacity = '1'; }, 10); // 再摘下透明斗篷
        } else {
            exportAllData(); // 兜底：如果没找到弹窗，直接导出
        }
      });
    }

    // 处理全局导出弹窗事件
    const globalExportModal = document.getElementById('global-export-modal-overlay');
    if (globalExportModal) {
        const hideExportModal = () => {
            globalExportModal.style.opacity = '0'; // 戴上隐形斗篷
            setTimeout(() => { globalExportModal.style.display = 'none'; }, 300); // 隐藏
        };
        document.getElementById('global-export-close-btn').addEventListener('click', hideExportModal);
        globalExportModal.addEventListener('click', (e) => {
            if (e.target === globalExportModal) hideExportModal();
        });
        document.getElementById('global-export-confirm-btn').addEventListener('click', () => {
            hideExportModal();
            const options = {
                offline: document.getElementById('export-check-offline').checked,
                shop: document.getElementById('export-check-shop').checked,
                music: document.getElementById('export-check-music').checked,
                couple: document.getElementById('export-check-couple').checked
            };
            (isNativeRuntime() ? exportChunkData(options) : exportAllData(options)); // APK 分块导出，网页保持原有下载方式
        });
    }

    // 4. 给“导入”按钮添加点击事件

    if (importDataBtn) {
      importDataBtn.addEventListener('click', () => {
        console.log('用户点击了导入数据按钮，准备触发文件选择...');
        if (isNativeRuntime()) {
          showSimpleSelectModal('选择备份文件类型', [
            { id: 'web-json', name: '网页版备份（.json）' },
            { id: 'apk-zip', name: 'APK 备份（.zip）' }
          ], async (source) => {
            if (source === 'apk-zip') {
              await importNativeBackup();
              return;
            }
            dataImportInput.accept = '.json,application/json';
            dataImportInput.click();
          });
          return;
        }
        dataImportInput.accept = '.json,.zip,application/json,application/zip';
        dataImportInput.click();
      });
    }
   const hardRefreshBtn = document.getElementById('hard-refresh-btn');
    if (hardRefreshBtn) {
      hardRefreshBtn.addEventListener('click', () => {
        if (confirm('确定要强制刷新页面吗？\n这会清除临时缓存并重新加载，解决界面卡死或加载不出的问题。')) {
            // 清理浏览器的 Cache 缓存池，模拟 Ctrl+F5 的硬刷新
            if ('caches' in window) {
                caches.keys().then(names => {
                    for (let name of names) caches.delete(name);
                });
            }
            // 强制重新加载网页
            window.location.reload(true);
        }
      });
    }
    // 5. 监听文件选择器的变化（也就是用户选择了文件之后）
    if (dataImportInput) {
      dataImportInput.addEventListener('change', (event) => {
        // 获取用户选择的第一个文件
        const file = event.target.files[0];
        if (file && (/\.zip$/i.test(file.name) || /zip/i.test(file.type || ''))) {
          importChunkFiles([file]);
          dataImportInput.value = '';
          return;
        }
        if (file) {
          // 【重要】弹窗进行二次确认，防止用户误操作
          if (confirm('警告：导入数据将完全覆盖当前所有聊天记录和设置，此操作无法撤销！\n\n确定要继续吗？')) {
            console.log('用户已确认导入，开始处理文件:', file.name);
            // 调用导入逻辑
            importAllData(file);
          }
          // 清空input的值，这样用户下次还可以选择同一个文件
          dataImportInput.value = '';
        }
      });
    }

  
// === 动态页面滚动效果 ===

const momentsHeader = document.querySelector('.moments-header');
// 【修改1/3】现在 profileSection 在滚动容器内部，所以我们要在容器内部查找它
const scrollContainer = document.querySelector('#page-dynamics .moments-content'); 

// 只有在动态页，且找到了所有需要的元素时，才执行
if (momentsHeader && scrollContainer) {
    const profileSection = scrollContainer.querySelector('.moments-profile');
    if (!profileSection) return;

    const headerHeight = momentsHeader.getBoundingClientRect().height;

    // 【修改2/3】关键：监听 scrollContainer 的滚动，而不是 window！
    scrollContainer.addEventListener('scroll', () => {
        const profileBottom = profileSection.getBoundingClientRect().bottom;

        // 【修改3/3】判断逻辑保持不变
        if (profileBottom <= headerHeight) {
            momentsHeader.classList.add('is-scrolled');
        } else {
            momentsHeader.classList.remove('is-scrolled');
        }
    });
}

// js/main.js 底部

// ==========================================================================
// == 后台动态调度器 (刷新页面后重置计时) ==
// ==========================================================================

// 定义不同频率对应的时间间隔 (单位：毫秒)
// 这里是为了测试设置的比较短，你可以按需修改：
// high: 10分钟, medium: 30分钟, low: 60分钟
const POST_INTERVALS = {
    'high':   10 * 60 * 1000, 
    'medium': 30 * 60 * 1000,
    'low':    60 * 60 * 1000
};

// 【关键】这是一个内存变量，只存在于当前页面会话中。
// 每次刷新页面，它都会被清空，从而实现“从头统计”。
const localPostTimers = {}; 

setInterval(async () => {
    const now = Date.now();

    // 遍历所有角色
    for (const char of AppState.characterProfiles) {
        
        // 1. 如果没开启功能，直接跳过，并清除计时器（如果有关闭操作）
        if (!char.activePostingEnabled) {
            delete localPostTimers[char.id];
            continue;
        }

        // 2. 初始化计时器：
        // 如果这个角色还没有记录（说明是刚打开页面，或者刚开启开关），
        // 就把“上次发送时间”标记为【现在】。
        // 这样它就需要等待一个完整的间隔周期才会发第一条。
        if (!localPostTimers[char.id]) {
            localPostTimers[char.id] = now;
            console.log(`[自动动态] 角色 ${char.name} 计时开始 (频率: ${char.postFrequency || 'medium'})`);
            continue;
        }

        // 3. 检查时间是否到了
        const frequency = char.postFrequency || 'medium';
        const requiredInterval = POST_INTERVALS[frequency] || POST_INTERVALS['medium'];
        const timeElapsed = now - localPostTimers[char.id];

        if (timeElapsed >= requiredInterval) {
            console.log(`[自动动态] 时间到！角色 ${char.name} 正在发送动态...`);
            
            // 4. 触发发送
            try {
                await momentsModule.triggerAiPostMoment(char.id);
            } catch (e) {
                console.error(`[自动动态] 发送失败:`, e);
            }

            // 5. 【关键】重置计时器为现在，开始下一轮等待
            localPostTimers[char.id] = now;
        }
    }
}, 30000); // 这里的 30000 代表每 30 秒检查一次时间，不需要改太频繁


});

/* ========================================================================== */
/* == 记忆系统页面逻辑 (Memory System Logic) == */
/* ========================================================================== */

function setupMemorySystem() {
    const memoryDockIcon = document.getElementById('memory-icon');
    const switcherTrigger = document.getElementById('memory-character-switcher');
    const switcherOverlay = document.getElementById('memory-switcher-overlay');
    const switcherList = document.getElementById('memory-char-list');
    const switcherCancel = document.getElementById('memory-switcher-cancel');
    const heroAvatar = document.getElementById('memory-hero-avatar');
    const heroName = document.getElementById('memory-hero-name');
    const heroDesc = document.getElementById('memory-hero-desc');
    const statCount = document.getElementById('mem-stat-count');
    const statSize = document.getElementById('mem-stat-size');
    const statDays = document.getElementById('mem-stat-days');
    const longTermText = document.getElementById('mem-long-term-text');
    const shortTermText = document.getElementById('mem-short-term-text');
    const photoGrid = document.getElementById('memory-photo-grid');
    const photoCount = document.getElementById('mem-photo-count');
    const currentCharacterNameInTrigger = switcherTrigger.querySelector('.current-char-name');
    const btnViewLongTerm = document.getElementById('btn-view-long-term');
    const btnViewShortTerm = document.getElementById('btn-view-short-term');
    const failedSummaryBanner = document.getElementById('memory-failed-banner'); // 新增
    /**
     * 核心函数：根据指定的角色ID，刷新整个记忆主页面的UI显示
     * @param {number | string | null} charId 要显示的角色ID
     */
    async function refreshMemoryUI(charId) {
        // ▼▼▼ 【修改3/4】将 charId 强制转换为字符串或 null，解决 '==' 比较问题 ▼▼▼
        const currentIdAsString = charId !== null && charId !== undefined ? String(charId) : null;
        tempState.currentChatId = currentIdAsString;
        // ▲▲▲ 修改结束 ▲▲▲

        if (!currentIdAsString) {
            heroAvatar.src = DEFAULT_AVATAR_SRC;
            heroName.textContent = '无角色';
            heroDesc.textContent = '请先在通讯录中创建角色';
            currentCharacterNameInTrigger.textContent = '选择角色';
            [statCount, statDays, photoCount].forEach(el => el.textContent = '0');
            statSize.textContent = '0.00 MB';
            longTermText.textContent = '暂无数据';
            shortTermText.textContent = '暂无近期对话摘要。';
            photoGrid.innerHTML = '<div class="photo-item placeholder"></div><div class="photo-item placeholder"></div><div class="photo-item placeholder"></div>';
            return;
        }

        // ▼▼▼ 【修改4/4】确保从 AppState 查找时也用字符串比较 ▼▼▼
        const char = AppState.characterProfiles.find(c => String(c.id) === currentIdAsString);
        // ▲▲▲ 修改结束 ▲▲▲
        
        if (!char) {
            console.error(`无法找到ID为 ${currentIdAsString} 的角色。`);
            await refreshMemoryUI(null);
            return;
        }

        heroAvatar.src = char.avatar || DEFAULT_AVATAR_SRC;
        heroName.textContent = char.name;
        heroDesc.textContent = char.subtitle || `关于 ${char.name} 的记忆档案`;
        currentCharacterNameInTrigger.textContent = char.name;

        // 渲染长期印象
        try {
            const manualMemories = await db.importantMemories.where('charId').equals(currentIdAsString).reverse().sortBy('date');
            const aiMemories = (char.memoryProfile?.long_term_memory?.commitments || [])
                .concat(char.memoryProfile?.long_term_memory?.preferences || [])
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

            const latestManual = manualMemories[0];
            const latestAi = aiMemories[0];

            let latestMemoryContent = "这里记录着你们关系中的关键时刻。";

            if (latestManual && latestAi) {
                const manualDate = new Date(latestManual.date).getTime();
                const aiDate = latestAi.timestamp * 1000;
                latestMemoryContent = manualDate > aiDate ? `• ${latestManual.title}: ${latestManual.content}` : `• ${latestAi.content}`;
            } else if (latestManual) {
                latestMemoryContent = `• ${latestManual.title}: ${latestManual.content}`;
            } else if (latestAi) {
                latestMemoryContent = `• ${latestAi.content}`;
            }
            longTermText.textContent = latestMemoryContent;
        } catch (e) {
            console.error("渲染长期印象失败:", e);
            longTermText.textContent = "数据加载失败。";
        }

        // 渲染近期记忆
        if (char.memoryProfile && char.memoryProfile.short_term_memory && char.memoryProfile.short_term_memory.length > 0) {
            shortTermText.textContent = `• ${char.memoryProfile.short_term_memory[0].content}`;
        } else {
            shortTermText.textContent = '暂无近期对话摘要。';
        }

         // 填充统计数据
        try {
            // 【优化1】极速模式：先只查数量，不查内容，瞬间完成
            const count = await db.chatMessages.where('chatId').equals(charId).count();
            statCount.textContent = count;

            // 【优化2】兜底显示：先显示“计算中...”，防止计算卡住导致空白
            statSize.textContent = "计算中..."; 

            // 【优化3】只取第一条消息算天数，不加载中间的几千条
            const firstMessage = await db.chatMessages.where('chatId').equals(charId).limit(1).first();
            if (firstMessage) {
                const safeTimestamp = Number(firstMessage.timestamp) || Date.now();
                const days = Math.floor((Date.now() - safeTimestamp) / (1000 * 60 * 60 * 24));
                statDays.textContent = isNaN(days) ? '0' : Math.max(0, days);
            } else {
                statDays.textContent = '0';
            }

                    // 4. 【相册优化】从角色的相册(Gallery)中随机展示3张
            // 先查出该角色所有的相册图片
            const galleryImgs = await db.galleryImages.where('charId').equals(charId).toArray();
            
            // 更新界面上的“相片墙”数量统计
            photoCount.textContent = galleryImgs.length;
            
            // 随机打乱顺序，取前3张
            const randomPicks = galleryImgs.sort(() => 0.5 - Math.random()).slice(0, 3);

            photoGrid.innerHTML = '';
            if (randomPicks.length > 0) {
                randomPicks.forEach(img => {
                    const photoItem = document.createElement('div');
                    photoItem.className = 'photo-item';
                    
                    // 【关键修改】使用 img 标签而不是背景图
                    // 这样配合你的 CSS (object-fit: cover) 可以自动裁剪图片填满方框，不会变形
                    const imgEl = document.createElement('img');
                    imgEl.src = img.url;
                    // 防止图片加载失败时显示破碎图标
                    imgEl.onerror = () => { imgEl.style.display = 'none'; }; 
                    
                    photoItem.appendChild(imgEl);
                    photoGrid.appendChild(photoItem);
                });
            } else {
                // 如果没有图片，显示3个空的灰色方块占位
                photoGrid.innerHTML = '<div class="photo-item placeholder"></div><div class="photo-item placeholder"></div><div class="photo-item placeholder"></div>';
            }
            // 【核心优化5】将最耗时的“计算体积”放到后台去跑 (setTimeout)
            // 这样页面会立刻显示出来，绝不会因为数据量大而卡死。
            setTimeout(async () => {
                try {
                    let totalBytes = 0;
                    // 【核心修复】禁止使用 JSON.stringify，改为轻量级估算法，杜绝苹果端内存崩溃
                                   await db.chatMessages.where('chatId').equals(charId).each(msg => {
                                if (msg) {
                                    // 严格检查数据类型，防止遇到数组或对象时出现 undefined 导致计算出 NaN
                                    if (typeof msg.text === 'string') totalBytes += msg.text.length * 2;
                                    if (typeof msg.content === 'string') totalBytes += msg.content.length;
                                    else if (Array.isArray(msg.content)) totalBytes += JSON.stringify(msg.content).length; // 安全的小片段计算
                                    if (typeof msg.stickerUrl === 'string') totalBytes += msg.stickerUrl.length;
                                    if (typeof msg.avatarSrc === 'string') totalBytes += msg.avatarSrc.length;
                                    totalBytes += 150; // 基础字段估算开销
                                }
                            });
                            // 计算完成后，增加终极防呆，确保输出绝对是数字
                            statSize.textContent = isNaN(totalBytes) ? "0.00 MB" : `${(totalBytes / 1024 / 1024).toFixed(2)} MB`;
                          } catch (err) {
                    console.warn("后台计算体积遇到小问题（已忽略，不影响使用）:", err);
                    statSize.textContent = "未知"; 
                }
            }, 500); // 延迟 0.5 秒再开始算，优先让用户看到页面
        } catch (e) {
            console.error("刷新记忆UI统计时出错:", e);
            statSize.textContent = "Error";
        }
        // ▼▼▼ 新增：判断并显示重试悬浮窗 ▼▼▼
        if (char && char.failedSummaries && char.failedSummaries.length > 0) {
            if (failedSummaryBanner) {
                const countEl = failedSummaryBanner.querySelector('.failed-count');
                if(countEl) countEl.textContent = char.failedSummaries.length;
                failedSummaryBanner.classList.add('visible');
                
                // 绑定点击事件，一键重发所有积压的失败任务
                failedSummaryBanner.onclick = async () => {
                    if (confirm(`有 ${char.failedSummaries.length} 条记忆总结失败，是否立即重新归档？\n如果之前是因为内容被拦截，建议先点击右上角添加破限词。`)) {
                        failedSummaryBanner.classList.remove('visible');
                        
                        const tasksToRetry = [...char.failedSummaries];
                        char.failedSummaries = []; // 提取后清空
                        await db.characterProfiles.put(char);
                        
                        if (typeof window.showDynamicIsland === 'function') {
                            window.showDynamicIsland('正在尝试重新总结...', 'info');
                        }
                        
                        // 遍历重新发送 (注意最后一个参数 isRetry 传了 true)
                        for (const task of tasksToRetry) {
                            const { conversationBuffer, userName, charName, source } = task.retryData;
                            await summarizeAndArchiveMemory(charId, conversationBuffer, userName, charName, source, true);
                        }
                    }
                };
            }
        } else {
            if (failedSummaryBanner) failedSummaryBanner.classList.remove('visible');
        }
        // ▲▲▲ 新增结束 ▲▲▲
    }
    
    window.refreshMemoryUI = refreshMemoryUI;
    
    if (memoryDockIcon) {
        addTapListener(memoryDockIcon, () => {
            let initialCharId = tempState.currentChatId;
            if (!initialCharId && AppState.characterProfiles.length > 0) {
                initialCharId = AppState.characterProfiles[0].id;
            }
            refreshMemoryUI(initialCharId);
        });
    }

    addTapListener(switcherTrigger, () => {
        switcherList.innerHTML = '';
        if (AppState.characterProfiles.length === 0) {
            switcherList.innerHTML = `<li class="selection-list-item" style="justify-content: center;">通讯录中没有角色</li>`;
        } else {
            AppState.characterProfiles.forEach(char => {
                const li = document.createElement('li');
                li.className = 'selection-list-item';
                li.dataset.charId = char.id; 
                if (String(char.id) === tempState.currentChatId) {
                    li.classList.add('selected', 'active');
                }
                li.innerHTML = `
                    <img src="${char.avatar || DEFAULT_AVATAR_SRC}" style="width:32px; height:32px; border-radius:50%; margin-right:10px; object-fit:cover;">
                    <span class="item-text">${escapeHTML(char.name)}</span>
                    <svg class="checkmark-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="20 6 9 17 4 12"></polyline></svg>
                `;
                switcherList.appendChild(li);
            });
        }
        switcherOverlay.classList.add('visible');
    });
    
    addTapListener(switcherList, (e) => {
        const selectedItem = e.target.closest('.selection-list-item');
        if (selectedItem && selectedItem.dataset.charId) {
            const newCharId = selectedItem.dataset.charId;
            refreshMemoryUI(newCharId);
            switcherOverlay.classList.remove('visible');
        }
    });

    addTapListener(switcherCancel, () => switcherOverlay.classList.remove('visible'));

if (btnViewLongTerm) {
        addTapListener(btnViewLongTerm, async () => {
            if (!tempState.currentChatId) {
                showDynamicIsland('请先选择一个角色');
                return;
            }
            
            // 1. 【核心优化】立即切换页面
            showPage('page-memory-detail');
                       // 2. 立即清空旧列表 (这是秒进的关键：先让用户看到一个干净的空页面)
            const timelineList = document.getElementById('mem-timeline-list');
            if(timelineList) timelineList.innerHTML = '<div style="padding:20px; text-align:center; color:#999;">加载中...</div>';
            
            // 3. 设置占位符
            const acquaintanceDateEl = document.getElementById('acquaintance-date');
            if (acquaintanceDateEl) acquaintanceDateEl.textContent = '...';

            // 4. 【核心优化】模仿聊天页的 "Double RAF" 技巧
            // 这会强制浏览器先完成页面切换动画，然后再执行重型数据加载
            requestAnimationFrame(() => {
                requestAnimationFrame(async () => {
                    // 此时页面已经显示出来了，用户不会觉得卡
                    await renderTimeline(tempState.currentChatId); 
                    
                    const firstTimestamp = await getFirstMessageTimestamp(tempState.currentChatId);
                    if (acquaintanceDateEl) {
                        acquaintanceDateEl.textContent = firstTimestamp ? new Date(firstTimestamp).toLocaleDateString('zh-CN') : '暂无记录';
                    }
                });
            });
        });
    }
if (btnViewShortTerm) {
        addTapListener(btnViewShortTerm, () => {
            if (!tempState.currentChatId) {
                showDynamicIsland('请先选择一个角色');
                return;
            }
            // 直接调用我们在 memory.js 里优化好的函数
            showRecentMemoryPage(tempState.currentChatId);
        });
    }
}

function setupHistoryRecordDetailInteraction() {
  document.body.addEventListener('click', (e) => {
    
    const summaryElement = e.target.closest('.history-modal-content .session-summary');
    if (!summaryElement) return;

    e.preventDefault();

    const detailsElement = summaryElement.closest('details');
    if (!detailsElement) return;

    // 【关键修正】我们不再寻找单个 .history-record-item，而是寻找包裹所有内容的容器 .session-detail-content
    const contentContainer = detailsElement.querySelector('.session-detail-content');

    if (contentContainer) {
      const recordWrapper = detailsElement;
      
      // 【关键修正】使用 innerHTML 直接“移植”所有内容，保留其原始结构和换行
      UI.historyRecordDetailContent.innerHTML = contentContainer.innerHTML;

// 从卡片的 "data-session-id" 属性获取我们之前存好的“身份证号”
const sessionId = recordWrapper.dataset.sessionId;

// 【关键】把“身份证号”存到删除按钮上，这样点击删除时就知道要删谁了
if (sessionId) {
    UI.btnDeleteRecordConfirm.dataset.sessionIdToDelete = sessionId;
}

UI.historyRecordDetailOverlay.classList.add('visible');

    } else {
      // 如果找不到内容容器，打印这条日志
      console.log('在<details>内部没有找到对应的 .session-detail-content 内容容器。');
    }
  });

  // "取消" 按钮的逻辑 (保持不变)
  UI.btnCancelRecordDetail.addEventListener('click', () => {
    UI.historyRecordDetailOverlay.classList.remove('visible');
  });

  // "删除" 按钮的逻辑 (保持不变)
 UI.btnDeleteRecordConfirm.addEventListener('click', async (e) => {
  // 从按钮上拿回我们之前存好的“身份证号”
  const sessionId = e.currentTarget.dataset.sessionIdToDelete;
  if (!sessionId) return;
  
  // 弹出系统确认框
  const isConfirmed = confirm('此操作永久删除该卡片和该卡片关联的聊天记录，确定删除吗？');

  if (isConfirmed) {
    // 如果用户点击了“确定”，就调用我们从 offline-mode.js 导入的删除函数
    await deleteOfflineSessionAndMessages(sessionId);

    // 从历史记录弹窗中，通过“身份证号”找到并移除对应的卡片
    const cardToRemove = historyModalContent.querySelector(`.history-session-card[data-session-id="${sessionId}"]`);
    if (cardToRemove) {
      cardToRemove.remove();
    }

    // 关闭详情弹窗
    UI.historyRecordDetailOverlay.classList.remove('visible');
    
    // 给出成功提示
    showDynamicIsland('记录已删除');
  }
});

  
  // 点击黑色背景区域关闭弹窗的逻辑 (保持不变)
  UI.historyRecordDetailOverlay.addEventListener('click', (e) => {
      if (e.target === UI.historyRecordDetailOverlay) {
          UI.historyRecordDetailOverlay.classList.remove('visible');
      }
  });
}

    // ▼▼▼ 【新增】数据页面逻辑：进入页面时自动刷新统计 ▼▼▼
    document.body.addEventListener('click', (e) => {
        // 检查点击的是否是前往“数据管理”页面的按钮 (data-target="page-settings-data")
        const targetBtn = e.target.closest('[data-target="page-settings-data"]');
        
        if (targetBtn) {
            // 动态导入 data-manager.js 并调用刷新函数
            import('./features/data-manager.js').then(module => {
                if (module.refreshDataStats) {
                    // 稍微延迟一下，确保页面切换动画开始后再计算，避免卡顿
                    setTimeout(() => {
                        module.refreshDataStats();
                    }, 50);
                }
            }).catch(err => console.error("无法加载数据统计模块:", err));
        }
    });
// ▼▼▼ 使用下面这个【已修复】的完整代码块，替换你 main.js 文件末尾的整个 setInterval 函数 ▼▼▼

// ==========================================================================
// == 自动日记调度器 (Auto Diary Scheduler) ==
// ==========================================================================
setInterval(async () => {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const todayStr = now.toISOString().split('T')[0]; // "2023-11-05"

    for (const char of AppState.characterProfiles) {
        if (getSleepState(char).sleeping) continue;
        // 1. 检查开关是否开启
        if (!char.autoDiaryEnabled || !char.autoDiaryTime) continue;

        // 2. 检查是否今天已经写过日记了
        if (char.lastAutoDiaryDate === todayStr) continue;

        // 3. 解析设定时间 "22:30"
        const [setHour, setMinute] = char.autoDiaryTime.split(':').map(Number);

        // 4. 检查时间是否匹配 (允许在设定时间之后的 5 分钟内触发)
        const currentTimeVal = currentHour * 60 + currentMinute;
        const setTimeVal = setHour * 60 + setMinute;

        if (currentTimeVal >= setTimeVal && currentTimeVal < setTimeVal + 5) {
            console.log(`[自动日记] 时间匹配！角色 ${char.name} 准备写日记...`);
            
            const existingDiary = await db.diaries.where({ charId: char.id, date: todayStr }).first();
            
            if (!existingDiary) {
                console.log(`[自动日记] 开始生成...`);
                
                char.lastAutoDiaryDate = todayStr; 

                // ▼▼▼ 【最终核心修复】修正了动态导入的路径 ▼▼▼
                import('./features/chat-service.js').then(async (module) => {
                    try {
                        const content = await module.generateDiaryEntry(char.id);
                        if (content) {
                            await db.diaries.add({
                                charId: char.id,
                                date: todayStr,
                                weather: '自动记录',
                                location: '未知',
                                snippet: content.replace(/<[^>]+>/g, '').substring(0, 80) + '...',
                                content: content,
                                image: null,
                                thumbnail: null
                            });
                            console.log(`[自动日记] 生成并保存成功！`);
                        }
                    } catch (e) {
                        console.error(`[自动日记] 生成失败:`, e);
                    }
                }).catch(err => {
                    // 增加错误捕获，防止因为路径问题导致整个应用崩溃
                    console.error("【模块加载失败】动态加载 'chat-service.js' 模块失败，请检查文件路径和服务器配置:", err);
                });
                // ▲▲▲ 修复结束 ▲▲▲
            } else {
                char.lastAutoDiaryDate = todayStr;
            }
        }
    }
}, 63000); // 【防发热错峰】改为63秒检查一次，避开其他模块的性能挤兑

