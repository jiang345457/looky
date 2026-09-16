import { db, tempState, AppState, DEFAULT_AVATAR_SRC, config, chatState } from '../state.js';
import { escapeHTML, isValidAvatarSrc, formatIflineWorldBodyHtml, normalizeIflineWorldMessageCards } from '../utils.js';
import { saveHybridStateToSession, isCharacterFriend} from '../state.js';
import { getCurrentChatIdentity } from './chat-ui.js';
import { sendOfflineMessageToAI, addHistorySeparator, addSystemEventMessage, sendToAIForSummary, cancelAiGeneration, isModeGenerating, markPendingContextSwitch } from './chat-service.js';
import { UI, showDynamicIsland, showInputModal, historyModalContent, showHistoryModal } from '../ui.js';
import { showPage } from '../ui.js'; 
import { appendFriendRequestThreadMessage, createOrUpdateFriendRequest, getSafeFriendRequestText, requestFriendRequestAiDecision, sanitizeFriendRequestMessageParts } from './friend-requests.js';
import { finalizeFriendRequestAcceptance } from './character.js';
import { applyRelationshipScoreEvent } from './relationship-score.js';



// 获取正确的DOM元素
const scrollContainer = document.querySelector('#page-offline-mode .offline-chat-content');
const messageList = document.getElementById('offline-message-list');
const inputField = document.getElementById('offline-chat-input');
const sendButton = document.getElementById('offline-send-btn');
const IS_ANDROID_RUNTIME = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
const OFFLINE_STATUS_DATA_PREFIX = 'offline_status_data_';
const OFFLINE_STATUS_CONFIG_PREFIX = 'offline_status_config_';
const OFFLINE_STATUS_SHARED_TEMPLATES_KEY = 'offline_status_shared_templates';
const OFFLINE_STATUS_TEMPLATE_VERSION = 5;
const OFFLINE_STATUS_PLACEHOLDER_PATTERN = /\{\{\s*([^{}\s]{1,40})\s*\}\}/g;
const OFFLINE_STATUS_CUSTOM_MARKUP_MAX_LENGTH = 16000;
const OFFLINE_STATUS_CUSTOM_CSS_MAX_LENGTH = 16000;
const OFFLINE_STATUS_CUSTOM_JS_MAX_LENGTH = 12000;
const OFFLINE_STATUS_CONTENT_PROMPT_MAX_LENGTH = 4000;
const OFFLINE_STATUS_CAPTURE_REGEX_MAX_LENGTH = 2000;
const OFFLINE_STATUS_EXPORT_FORMAT = 'looky-offline-status-card';
const OFFLINE_STATUS_BUILTIN_TEMPLATE_IDS = new Set(['mist-journal', 'quiet-paper', 'graphite-note']);
const OFFLINE_FRIEND_REQUEST_MARKER_PATTERN = /\[\[\s*FRIEND_REQUEST\s*\]\]/gi;
const OFFLINE_CONTACT_EXCHANGE_PATTERN = /(?:\u52a0(?:\u4e2a|\u4e00\u4e0b)?(?:\u5fae\u4fe1|\u597d\u53cb|\u8054\u7cfb\u65b9\u5f0f)|\u4ea4\u6362(?:\u4e00\u4e0b)?(?:\u5fae\u4fe1|\u624b\u673a\u53f7|\u7535\u8bdd|\u8054\u7cfb\u65b9\u5f0f)|\u7559(?:\u4e2a|\u4e00\u4e0b)?(?:\u5fae\u4fe1|\u624b\u673a\u53f7|\u7535\u8bdd|\u8054\u7cfb\u65b9\u5f0f)|(?:\u626b|\u626b\u4e00\u4e0b)[\s\S]{0,12}(?:\u4e8c\u7ef4\u7801|\u7801)|(?:\u5fae\u4fe1|\u624b\u673a\u53f7|\u7535\u8bdd|\u8054\u7cfb\u65b9\u5f0f)[\s\S]{0,12}(?:\u7ed9\u6211|\u53d1\u6211|\u544a\u8bc9\u6211|\u7559\u7ed9))/i;
const DEFAULT_OFFLINE_V2_MODULES = Object.freeze({
    '叙述质感': true,
    '口语质感': true,
    '行动预算': true,
    '社会音量': false,
    '吸引子封禁': true,
    '情感方向': true,
    '占有欲': false,
    '冲突阶梯': true,
    '撩拨推演': false,
    '亲密场景': false,
    '剧情推动': true,
    '对白内容': true,
    '文风样本': true,
    '配角处理': true,
    '意图识别': true,
    '事件降温': true,
    '人设防复述': false,
    '情感对冲': false,
    '半转述半扩写': false
});
let offlineFriendRequestPending = false;
let offlineFriendRequestRefreshFrame = 0;
let offlineFriendRequestUpdateListenerBound = false;
let offlineStreamingCard = null;
let offlineStreamingChatId = null;
let offlineStreamingLatestText = '';
let offlineStreamingRafId = 0;
let offlineStreamingLastPaintAt = 0;
const OFFLINE_STREAM_PREVIEW_INTERVAL = 120;
function refreshOfflineFontSizeRoots() {
}
function resyncOfflineFontSizing() {
}
if (!window.__lookyFontSizeRefreshOfflineBound) {
    window.__lookyFontSizeRefreshOfflineBound = true;
    window.addEventListener('looky:font-size-changed', refreshOfflineFontSizeRoots);
}
const OFFLINE_STATUS_GROUP_META = {
    scene: { label: '\u573a\u666f\u8bb0\u5f55', english: 'SCENE' },
    presence: { label: '\u5f53\u4e0b\u72b6\u6001', english: 'PRESENCE' },
    mind: { label: '\u5fc3\u7eea\u4e0e\u610f\u56fe', english: 'INNER' },
    bond: { label: '\u5173\u7cfb\u8f68\u8ff9', english: 'BOND' }
};
const DEFAULT_OFFLINE_STATUS_FIELDS = [
    { key: 'date', label: '\u65e5\u671f', visible: true, group: 'scene', size: 'compact', hint: '\u5f53\u524d\u573a\u666f\u7684\u65e5\u671f\u4e0e\u661f\u671f' },
    { key: 'time', label: '\u65f6\u95f4', visible: true, group: 'scene', size: 'compact', hint: '\u5f53\u524d\u573a\u666f\u65f6\u95f4\u6216\u65f6\u6bb5' },
    { key: 'weather', label: '\u5929\u6c14\u00b7\u6c1b\u56f4', visible: true, group: 'scene', size: 'wide', hint: '\u5929\u6c14\u3001\u5149\u7ebf\u4e0e\u73af\u5883\u6c1b\u56f4' },
    { key: 'location', label: '\u6240\u5728\u4f4d\u7f6e', visible: true, group: 'scene', size: 'wide', hint: '\u5177\u4f53\u5730\u70b9\u6216\u5f53\u524d\u7a7a\u95f4' },
    { key: 'appearance', label: '\u89d2\u8272\u5370\u8c61', visible: true, group: 'presence', size: 'wide', hint: '\u89d2\u8272\u5f53\u524d\u7684\u7a7f\u7740\u3001\u59ff\u6001\u6216\u5916\u89c2\u7ec6\u8282' },
    { key: 'activity', label: '\u6b63\u5728\u505a\u4ec0\u4e48', visible: true, group: 'presence', size: 'wide', hint: '\u89d2\u8272\u6b64\u523b\u6b63\u5728\u8fdb\u884c\u7684\u52a8\u4f5c\u6216\u4e8b\u60c5' },
    { key: 'emotion', label: '\u60c5\u7eea', visible: true, group: 'mind', size: 'compact', hint: '\u89d2\u8272\u5f53\u524d\u7684\u4e3b\u8981\u60c5\u7eea' },
    { key: 'inner_thought', label: '\u6b64\u523b\u5fc3\u58f0', visible: true, group: 'mind', size: 'feature', hint: '\u7b2c\u4e00\u4eba\u79f0\u3001\u7b80\u77ed\u4e14\u7b26\u5408\u4eba\u8bbe\u7684\u771f\u5b9e\u5fc3\u58f0' },
    { key: 'intention', label: '\u63a5\u4e0b\u6765\u60f3\u505a', visible: true, group: 'mind', size: 'wide', hint: '\u89d2\u8272\u5f53\u4e0b\u7684\u77ed\u671f\u610f\u56fe\u6216\u613f\u671b' },
    { key: 'relationship', label: '\u5173\u7cfb\u9636\u6bb5', visible: true, group: 'bond', size: 'compact', hint: '\u5f53\u524d\u53cc\u65b9\u5173\u7cfb\u7684\u7b80\u77ed\u5b9a\u4f4d' },
    { key: 'bond', label: '\u5173\u7cfb\u53d8\u5316', visible: true, group: 'bond', size: 'compact', hint: '\u672c\u8f6e\u540e\u5173\u7cfb\u8d8b\u52bf\u6216\u7ec6\u5fae\u53d8\u5316' },
    { key: 'memory_note', label: '\u672c\u523b\u7559\u75d5', visible: true, group: 'bond', size: 'feature', hint: '\u503c\u5f97\u7559\u4e0b\u7684\u4e00\u53e5\u573a\u666f\u7eaa\u5f55\uff0c\u4e0d\u8981\u91cd\u590d\u6b63\u6587' }
];
let offlineStatusStudioState = null;

function splitOfflineParagraphsLegacy(escapedText) {
    return String(escapedText || '')
        .replace(/\r/g, '')
        .split(/\n{2,}|\n/)
        .flatMap(line => {
            const trimmed = line.trim();
            if (!trimmed) return [];
            if (trimmed.length <= 180) return [trimmed];
            const parts = trimmed
                .replace(/([。！？!?；;…]+[”’」』）)]?)/g, '$1\n')
                .split('\n')
                .map(part => part.trim())
                .filter(Boolean);
            return parts.length ? parts : [trimmed];
        });
}

function getOfflineParagraphClassLegacy(escapedLine) {
    const line = String(escapedLine || '');
    if (/(&quot;|“|”|「|」|『|』|‘|’)/.test(line)) return 'offline-layer-dialogue';
    if (/\*[^*]+\*/.test(line)) return 'offline-layer-inner';
    if (/(心想|心里|念头|意识|想起|胸口|眼底|垂下眼)/.test(line)) return 'offline-layer-inner';
    return 'offline-layer-action';
}

function formatOfflineTextLayerLegacy(rawLine) {
    let line = rawLine;
    line = line.replace(/(鈥淸\s\S]*?鈥潀銆孾\s\S]*?銆峾"[\s\S]*?"|&quot;[\s\S]*?&quot;|“[\s\S]*?”|「[\s\S]*?」|『[\s\S]*?』)/g, '<span class="dialogue offline-layer-dialogue">$1</span>');
    line = line.replace(/\*\*([\s\S]{1,500}?)\*\*/g, '<span class="italic offline-layer-inner">$1</span>')
               .replace(/\*([^\*]{1,500}?)\*/g, '<span class="italic offline-layer-inner">$1</span>');
    return line;
}

function splitOfflineParagraphsEncodingLegacy(escapedText) {
    return String(escapedText || '')
        .replace(/\r/g, '')
        .split(/\n{2,}|\n/)
        .flatMap(line => {
            const trimmed = line.trim();
            if (!trimmed) return [];
            if (trimmed.length <= 180) return [trimmed];
            const parts = trimmed
                .replace(/([\u3002\uff01\uff1f!?…]+[\u201d\u2019\u300d\u300f\uff09)]?)/g, '$1\n')
                .split('\n')
                .map(part => part.trim())
                .filter(Boolean);
            return parts.length ? parts : [trimmed];
        });
}

function splitOfflineParagraphs(escapedText) {
    return String(escapedText || '')
        .replace(/\r/g, '')
        .split(/\n{2,}|\n/)
        .flatMap(line => {
            const trimmed = line.trim();
            if (!trimmed) return [];
            return [trimmed];
        });
}

function getOfflineParagraphClass(escapedLine) {
    const line = String(escapedLine || '');
    if (/^(?:\*\*[\s\S]+\*\*|\*[^*]+\*)$/.test(line)) return 'offline-layer-inner';
    const dialogueParts = line.match(/(?:&quot;[\s\S]*?&quot;|"[^"]*?"|\u201c[\s\S]*?\u201d|\u300c[\s\S]*?\u300d|\u300e[\s\S]*?\u300f)/g) || [];
    const visibleLength = line.replace(/&quot;/g, '"').replace(/\*/g, '').trim().length;
    const dialogueLength = dialogueParts
        .join('')
        .replace(/&quot;/g, '"')
        .trim().length;
    if (visibleLength > 0 && dialogueLength / visibleLength >= 0.72) return 'offline-layer-dialogue';
    return 'offline-layer-action';
}

function formatOfflineTextLayer(rawLine) {
    let line = rawLine;
    line = line.replace(/(&quot;[\s\S]*?&quot;|"[\s\S]*?"|\u201c[\s\S]*?\u201d|\u300c[\s\S]*?\u300d|\u300e[\s\S]*?\u300f)/g, '<span class="dialogue offline-layer-dialogue">$1</span>');
    line = line.replace(/\*\*([\s\S]{1,500}?)\*\*/g, '<span class="italic offline-layer-inner">$1</span>')
               .replace(/\*([^\*]{1,500}?)\*/g, '<span class="italic offline-layer-inner">$1</span>');
    line = line.replace(/\[([^\[\]\n]{1,120})\]/g, (_, text) => {
        const cleanText = String(text || '').replace(/^\s*(?:\u4e2d\u6587(?:\u610f\u601d|\u7ffb\u8bd1)?|\u7ffb\u8bd1|\u8bd1|meaning|translation)\s*[:\uff1a]\s*/i, '').trim();
        return `<span class="offline-inline-translation">[${cleanText}]</span>`;
    });
    return line;
}

function processOfflineMessageLegacy(rawText) {
    if (!rawText) return '';
    let text = rawText;
    try {
        // 1. 原汁原味：移除 thinking 和 draft 思维链代码块（不限长度，遇到完整的就干掉）
        let s, e;
        while ((s = text.indexOf('<thinking>')) !== -1) {
            e = text.indexOf('</thinking>', s);
            if (e === -1) break; // 核心保护：找不到结尾就不删，防止吞字
            text = text.slice(0, s) + text.slice(e + 11);
        }
        while ((s = text.indexOf('<!--')) !== -1) {
            e = text.indexOf('-->', s);
            if (e === -1) break;
            text = text.slice(0, s) + text.slice(e + 3);
        }
        // 2. 防苹果死机版：隐藏所有类似 <动作>、<系统> 这样的尖括号。
        text = text.replace(/<[^>]{1,2000}>/g, '');

               // 2.5 【新增】去掉群聊线下模式中AI用来标记说话人的【角色名】前缀
        text = text.replace(/^【.+?】\s*/, '');
         // 3. 安全转义，防止用户输入的代码破坏页面排版
        text = escapeHTML(text);

        // 4. 【对调顺序】先识别所有形式的对话，避免后续和标签属性的英文双引号打架！
        // 顺便把你小世界里写得更严谨的 &quot; 规则也合并进来，万无一失
        text = text.replace(/(“[\s\S]*?”|「[\s\S]*?」|"[\s\S]*?"|&quot;[\s\S]*?&quot;)/g, '<span class="dialogue">$1</span>');

        // 5. 然后再处理 Markdown 粗斜体。这样生成的 class="italic" 就不会被上面的对话规则误伤了。
        text = text.replace(/\*\*([\s\S]{1,500}?)\*\*/g, '<span class="italic">$1</span>')
                   .replace(/\*([^\*]{1,500}?)\*/g, '<span class="italic">$1</span>');
                } catch (e) {
        console.error("[UI渲染保护] 处理消息文本时出错，已降级为安全显示:", e);
        text = escapeHTML(rawText);
    }
    return text;
}

function processOfflineMessageSafely(rawText) {
    if (!rawText) return '';
    let text = String(rawText);
    try {
        text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
        text = text.replace(/<!--[\s\S]*?-->/g, '');
        text = text.replace(/<[^>]{1,2000}>/g, '');
        text = text.replace(/^【.+?】\s*/, '');
        text = escapeHTML(text);
        const paragraphs = splitOfflineParagraphs(text);
        return paragraphs.map(line => {
            const layerClass = getOfflineParagraphClass(line);
            return `<p class="offline-para ${layerClass}">${formatOfflineTextLayer(line)}</p>`;
        }).join('');
    } catch (error) {
        console.error('[offline render] message formatting failed:', error);
        return `<p class="offline-para offline-layer-action">${escapeHTML(rawText)}</p>`;
    }
}

/**
 * 流式显示时对累积文本做轻量清洗（不做最终后处理）
 */
function cleanStreamingText(raw) {
    let text = String(raw || '');
    // 移除已完整闭合的 <thinking> 块
    let s, e;
    while ((s = text.indexOf('<thinking>')) !== -1) {
        e = text.indexOf('</thinking>', s);
        if (e === -1) {
            // 未闭合 = 正在生成思考内容，从此处截断不显示
            text = text.slice(0, s);
            break;
        }
        text = text.slice(0, s) + text.slice(e + 11);
    }
    // 隐藏正在生成的状态块，兼容 AI 常见的标记变体
    const statusStartMatch = text.match(/<<\s*STATUS\s*>>|<\s*STATUS\s*>|\[\s*STATUS\s*\]|【\s*状态(?:栏)?\s*】/i);
    if (statusStartMatch?.index !== undefined) text = text.slice(0, statusStartMatch.index);
    // 去除 [[FRIEND_REQUEST]] 标记
    text = text.replace(/\[\[\s*FRIEND_REQUEST\s*\]\]/gi, '');
    return text.trim();
}

/**
 * 创建一个空的流式预览消息卡片
 */
function createOfflineStreamingCard(chatId) {
    const chatChar = AppState.characterProfiles.find(c => String(c.id) === String(chatId));
    const avatarSrc = chatChar?.chatOverrideAvatar || chatChar?.avatar || DEFAULT_AVATAR_SRC;
    const senderName = chatChar?.chatOverrideName || chatChar?.name || '对方';
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    const card = document.createElement('div');
    card.className = 'offline-message-card is-character offline-streaming-entrance';
    card.id = 'offline-streaming-card';
    card.innerHTML = `
        <div class="card-header">
            <div class="sender-info">
                <img src="${avatarSrc}" alt="avatar" class="sender-avatar" loading="lazy" decoding="async">
                <span class="sender-name">${escapeHTML(senderName)}</span>
                <span class="timestamp">${timestamp}</span>
            </div>
        </div>
        <div class="card-body">
            <div class="offline-prose"></div>
        </div>
        <div class="card-footer">
            <span class="card-watermark">시작은 미약할지언정 끝은 창대하리</span>
        </div>
    `;
    // 入场动画：下一帧触发 CSS transition
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            card.classList.remove('offline-streaming-entrance');
        });
    });
    return card;
}

/**
 * 更新流式预览卡片的显示内容
 */
function updateOfflineStreamingCardContent(card, rawText) {
    if (!card) return;
    const prose = card.querySelector('.offline-prose');
    if (!prose) return;
    const cleaned = cleanStreamingText(rawText);
    if (!cleaned) return;
    // 性能优化：只有当清洗后的文本长度确实变化时才重新渲染
    // 避免 SSE 重复推送相同内容时触发无意义的 DOM 操作
    if (prose._lastCleanedLength === cleaned.length) return;
    prose._lastCleanedLength = cleaned.length;
    prose.innerHTML = processOfflineMessageSafely(cleaned);
}

/**
 * 销毁所有流式逐字状态
 */
function destroyOfflineStreamingState() {
    if (offlineStreamingRafId) {
        clearTimeout(offlineStreamingRafId);
        offlineStreamingRafId = 0;
    }
    offlineStreamingCard = null;
    offlineStreamingChatId = null;
    offlineStreamingLatestText = '';
    offlineStreamingLastPaintAt = 0;
}

function extractOfflineFriendRequestMarker(rawText) {
    const text = String(rawText || '');
    const hasMarker = OFFLINE_FRIEND_REQUEST_MARKER_PATTERN.test(text);
    OFFLINE_FRIEND_REQUEST_MARKER_PATTERN.lastIndex = 0;
    return {
        text: text.replace(OFFLINE_FRIEND_REQUEST_MARKER_PATTERN, '').trim(),
        hasMarker
    };
}

function getOfflineCurrentChar() {
    const chatId = String(tempState.currentChatId || '');
    if (!chatId) return null;
    return AppState.characterProfiles.find(char => String(char.id) === chatId) || null;
}

function canUseOfflineFriendRequest(char) {
    return Boolean(char)
        && !char.isGroup
        && !isCharacterFriend(char)
        && char.inContacts === false;
}

function hasOfflineContactExchangeIntent(text = '') {
    return OFFLINE_CONTACT_EXCHANGE_PATTERN.test(String(text || ''));
}

async function markOfflineContactExchangeReadyIfNeeded(char, text = '') {
    if (!canUseOfflineFriendRequest(char) || char.offlineContactExchangeReady === true) return;
    if (!hasOfflineContactExchangeIntent(text)) return;
    char.offlineContactExchangeReady = true;
    await db.characterProfiles.update(char.id, { offlineContactExchangeReady: true });
    refreshOfflineFriendRequestActionVisibility();
}

function shouldShowOfflineFriendRequestAction(char) {
    return canUseOfflineFriendRequest(char)
        && char.offlineContactExchangeReady === true;
}

function hasPendingOfflineFriendRequest(char) {
    return Boolean(char?.id) && AppState.friendRequests?.some(request => (
        String(request.charId) === String(char.id)
        && (request.status || 'pending') === 'pending'
    ));
}

function buildOfflineFriendRequestMessage(char, text = '') {
    return String(char?.incomingRequestMessage || `\u6211\u662f${char?.name || 'Ta'}`).slice(0, 40);
}

function ensureOfflineFriendRequestMenuItem(actionMenu) {
    if (!actionMenu || actionMenu.querySelector('[data-action="friend-request"]')) return;
    const item = document.createElement('div');
    item.className = 'action-menu-item';
    item.dataset.action = 'friend-request';
    item.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3"></path>
            <path d="M8 11c1.66 0 3-1.34 3-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3"></path>
            <path d="M3.8 19c.7-3 2.6-4.5 5.2-4.5S13.5 16 14.2 19"></path>
            <path d="M14.8 15.3c.7-.5 1.5-.8 2.4-.8 1.8 0 3.1 1 3.7 3"></path>
        </svg>
        <span>&#22909;&#21451;&#30003;&#35831;</span>
    `;
    const anchor = actionMenu.querySelector('[data-action="offline-status"]') || actionMenu.firstElementChild;
    actionMenu.insertBefore(item, anchor);
}

function refreshOfflineFriendRequestActionVisibility() {
    const actionMenu = document.getElementById('offline-action-menu');
    ensureOfflineFriendRequestMenuItem(actionMenu);
    const actionItem = actionMenu?.querySelector('[data-action="friend-request"]');
    if (!actionItem) return;
    const char = getOfflineCurrentChar();
    actionItem.hidden = !shouldShowOfflineFriendRequestAction(char);
}

function sanitizeOfflineHtmlSnippet(htmlContent) {
    if (!htmlContent) return '';
    let clean = htmlContent;

    // 去掉思维链和注释
    clean = clean.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    clean = clean.replace(/<!--[\s\S]*?-->/g, '');

    // 禁止危险跳转/弹窗
    clean = clean.replace(/window\.top/gi, 'window.self');
    clean = clean.replace(/window\.parent/gi, 'window.self');
    clean = clean.replace(/window\.open\s*\(/gi, 'void(');
    clean = clean.replace(/target=["']?_blank["']?/gi, '');

    // 禁止外链 form 提交
    clean = clean.replace(/<form\s+[^>]*action=["']http[^"']*["'][^>]*>/gi, '<form action="#">');

    // 屏蔽 javascript: 协议
   clean = clean.replace(/href=["']\s*javascript:[^"']*["']/gi, 'href="javascript:void(0);"');
    return clean;
}
function extractHtmlAndText(rawText) {
    if (!rawText) return { text: '', html: '' };
    let text = rawText;
    
    // 1. 彻底剔除所有隐秘思维链和注释，保证绝对不泄露
    let s, e;
    while ((s = text.indexOf('<thinking>')) !== -1) {
        e = text.indexOf('</thinking>', s);
        if (e === -1) break;
        text = text.slice(0, s) + text.slice(e + 11);
    }
    while ((s = text.indexOf('<!--')) !== -1) {
        e = text.indexOf('-->', s);
        if (e === -1) break;
        text = text.slice(0, s) + text.slice(e + 3);
    }
    
    // 取消群聊名字前缀
    text = text.replace(/^【.+?】\s*/, '');
    // 2. 精准寻找 HTML 片段并与正文切割
    const htmlRegex = /(?:\[HTML_SNIPPET\]\s*)?(<(?:div|style|svg|iframe)[\s>][\s\S]*>)/i;
    const match = text.match(htmlRegex);
    if (match) {
        return { text: text.substring(0, match.index).trim(), html: match[1].trim() };
    }
    return { text: text.trim(), html: '' };
}

function buildOfflineFriendRequestBarHtml(message = {}) {
    if (message?.contentType !== 'friend_request_bar' && !message?.offlineFriendRequestInline) return '';
    const title = message.friendRequestDirection === 'char_to_user' ? '好友申请到达' : '好友申请已发送';
    const badge = message.friendRequestDirection === 'char_to_user' ? 'FRIEND REQUEST' : 'SENT';
    return `
        <div class="offline-friend-request-bar" style="margin-top:8px;padding:8px 10px;border:1px solid rgba(0,0,0,.08);border-radius:14px;background:rgba(255,255,255,.9);box-shadow:0 6px 14px rgba(0,0,0,.05);display:flex;align-items:center;justify-content:space-between;gap:10px;">
            <strong style="font-size:13px;line-height:1.2;color:var(--offline-font-color, #222);font-weight:700;">${escapeHTML(title)}</strong>
            <span style="display:inline-flex;align-items:center;padding:4px 8px;border-radius:999px;background:rgba(0,0,0,.05);font-size:10px;font-weight:700;letter-spacing:.08em;color:rgba(0,0,0,.58);white-space:nowrap;">${escapeHTML(badge)}</span>
        </div>
    `;
}
/**
 * 在界面上追加一条消息（无论是用户还是角色）
 * @param {string} sender 'user' 或 'character'
 * @param {string} text 消息内容
 * @param {string} sessionId [可选] 本次会话的ID
 */
function prepareOfflineMessageCollapse(messageCardElement) {
    messageCardElement.querySelector('.offline-expand-toggle')?.remove();
    messageCardElement.querySelector('.offline-prose')?.classList.remove('is-collapsible', 'is-expanded');
}

function getOfflineStatusDataKey(chatId) {
    return `${OFFLINE_STATUS_DATA_PREFIX}${chatId}`;
}

function getOfflineStatusConfigKey(chatId) {
    return `${OFFLINE_STATUS_CONFIG_PREFIX}${chatId}`;
}

function cloneOfflineStatusFields(fields = DEFAULT_OFFLINE_STATUS_FIELDS) {
    return fields.map(field => ({ ...field }));
}

function createDefaultOfflineStatusTemplates() {
    return [
        {
            id: 'mist-journal',
            name: '\u96fe\u7a97\u624b\u8bb0',
            title: '\u76f8\u9047\u624b\u8bb0',
            subtitle: 'OFFLINE SCENE JOURNAL',
            style: 'mist',
            accent: '#66727f',
            fontMode: 'serif',
            radius: 16,
            surfaceAlpha: 96,
            fields: cloneOfflineStatusFields()
        },
        {
            id: 'quiet-paper',
            name: '\u9759\u9875\u6863\u6848',
            title: '\u5f53\u4e0b\u6863\u6848',
            subtitle: 'A QUIET MOMENT ARCHIVE',
            style: 'paper',
            accent: '#7b6f78',
            fontMode: 'serif',
            radius: 10,
            surfaceAlpha: 100,
            fields: cloneOfflineStatusFields()
        },
        {
            id: 'graphite-note',
            name: '\u77f3\u58a8\u8bb0\u5f55',
            title: '\u573a\u666f\u5207\u7247',
            subtitle: 'SCENE FRAGMENT',
            style: 'graphite',
            accent: '#303236',
            fontMode: 'sans',
            radius: 14,
            surfaceAlpha: 98,
            fields: cloneOfflineStatusFields()
        }
    ];
}

function normalizeOfflineStatusField(field, index) {
    const allowedSizes = new Set(['compact', 'wide', 'feature']);
    const group = OFFLINE_STATUS_GROUP_META[field?.group] ? field.group : 'presence';
    const size = allowedSizes.has(field?.size) ? field.size : 'compact';
    return {
        key: String(field?.key || `field_${index + 1}`).trim(),
        label: String(field?.label || field?.key || `\u5b57\u6bb5 ${index + 1}`).trim(),
        visible: field?.visible !== false,
        group,
        size,
        hint: String(field?.hint || '').trim()
    };
}

function normalizeOfflineStatusTemplate(template, index) {
    const allowedStyles = new Set(['mist', 'paper', 'graphite']);
    const allowedFontModes = new Set(['serif', 'sans', 'rounded']);
    const layoutMode = template?.layoutMode === 'custom' ? 'custom' : 'builtin';
    const id = String(template?.id || `status_template_${index + 1}`).trim();
    const accent = /^#[0-9a-f]{6}$/i.test(String(template?.accent || ''))
        ? String(template.accent)
        : '#66727f';
    const radiusValue = Number(template?.radius);
    const surfaceAlphaValue = Number(template?.surfaceAlpha);
    const fields = Array.isArray(template?.fields) && template.fields.length
        ? template.fields
        : DEFAULT_OFFLINE_STATUS_FIELDS;
    const contentPrompt = String(template?.contentPrompt || '').trim().slice(0, OFFLINE_STATUS_CONTENT_PROMPT_MAX_LENGTH);
    const fieldPrompts = template?.fieldPrompts && typeof template.fieldPrompts === 'object' && !Array.isArray(template.fieldPrompts)
        ? Object.fromEntries(
            Object.entries(template.fieldPrompts)
                .map(([key, value]) => [String(key).trim(), String(value || '').trim().slice(0, 1000)])
                .filter(([key, value]) => key && value)
        )
        : {};
    const placeholderKeys = layoutMode === 'custom'
        ? Array.from(String(template?.customMarkup || '').matchAll(/\{\{\s*([^{}\s]{1,40})\s*\}\}/g)).map(match => String(match[1]).trim())
        : [];
    placeholderKeys.forEach(key => {
        if (!fieldPrompts[key]) fieldPrompts[key] = contentPrompt || '根据本轮线下剧情填写，保持与之前内容连续；没有变化时保留原值。';
    });
    return {
        id,
        builtIn: OFFLINE_STATUS_BUILTIN_TEMPLATE_IDS.has(id),
        name: String(template?.name || `\u72b6\u6001\u680f ${index + 1}`).trim(),
        title: String(template?.title || '\u76f8\u9047\u624b\u8bb0').trim(),
        subtitle: String(template?.subtitle || 'OFFLINE SCENE JOURNAL').trim(),
        style: allowedStyles.has(template?.style) ? template.style : 'mist',
        accent,
        fontMode: allowedFontModes.has(template?.fontMode) ? template.fontMode : 'serif',
        layoutMode,
        customMarkup: String(template?.customMarkup || '').trim().slice(0, OFFLINE_STATUS_CUSTOM_MARKUP_MAX_LENGTH),
        customCss: String(template?.customCss || '').trim().slice(0, OFFLINE_STATUS_CUSTOM_CSS_MAX_LENGTH),
        customJs: String(template?.customJs || '').trim().slice(0, OFFLINE_STATUS_CUSTOM_JS_MAX_LENGTH),
        contentPrompt,
        fieldPrompts,
        captureRegex: String(template?.captureRegex || '').trim().slice(0, OFFLINE_STATUS_CAPTURE_REGEX_MAX_LENGTH),
        radius: Number.isFinite(radiusValue) ? Math.min(24, Math.max(0, Math.round(radiusValue))) : 16,
        surfaceAlpha: Number.isFinite(surfaceAlphaValue) ? Math.min(100, Math.max(68, Math.round(surfaceAlphaValue))) : 96,
        fields: fields
            .map((field, fieldIndex) => normalizeOfflineStatusField(field, fieldIndex))
            .filter(field => field.key && field.label)
    };
}

function normalizeOfflineStatusTemplates(...groups) {
    const defaultTemplates = createDefaultOfflineStatusTemplates().map(normalizeOfflineStatusTemplate);
    const templatesById = new Map(defaultTemplates.map(template => [template.id, template]));

    groups.flat().forEach((template, index) => {
        if (!template || typeof template !== 'object') return;
        const normalized = normalizeOfflineStatusTemplate(template, index);
        // 内置样式允许沿用旧数据里的修改；自定义样式按 ID 去重，第一次出现的版本优先。
        if (OFFLINE_STATUS_BUILTIN_TEMPLATE_IDS.has(normalized.id) || !templatesById.has(normalized.id)) {
            templatesById.set(normalized.id, normalized);
        }
    });

    return [
        ...defaultTemplates.map(template => templatesById.get(template.id) || template),
        ...Array.from(templatesById.values()).filter(template => !OFFLINE_STATUS_BUILTIN_TEMPLATE_IDS.has(template.id))
    ];
}

function getActiveOfflineStatusTemplate(config) {
    return config.templates.find(template => template.id === config.activeTemplateId)
        || config.templates[0];
}

function normalizeOfflineStatusConfig(value, sharedTemplates = null) {
    let templates;
    const defaultTemplates = createDefaultOfflineStatusTemplates().map(normalizeOfflineStatusTemplate);
    if (Array.isArray(sharedTemplates) && sharedTemplates.length) {
        templates = normalizeOfflineStatusTemplates(sharedTemplates);
    } else if (Array.isArray(value?.templates) && value.templates.length) {
        templates = normalizeOfflineStatusTemplates(value.templates);
    } else if (Array.isArray(value?.fields) && value.fields.length) {
        templates = [
            ...defaultTemplates,
            normalizeOfflineStatusTemplate({
            id: 'legacy-status',
            name: '\u6211\u7684\u72b6\u6001\u680f',
            title: '\u573a\u666f\u72b6\u6001',
            subtitle: 'SCENE STATUS',
            style: value?.style || 'mist',
            accent: value?.accent || '#66727f',
            fields: value.fields
        }, defaultTemplates.length)
        ];
    } else {
        templates = defaultTemplates;
    }
    const requestedActiveId = String(value?.activeTemplateId || '').trim();
    const activeTemplateId = templates.some(template => template.id === requestedActiveId)
        ? requestedActiveId
        : templates[0].id;
    const activeTemplate = templates.find(template => template.id === activeTemplateId) || templates[0];
    return {
        version: OFFLINE_STATUS_TEMPLATE_VERSION,
        enabled: value?.enabled !== false,
        collapsed: Boolean(value?.collapsed),
        activeTemplateId,
        templates,
        fields: cloneOfflineStatusFields(activeTemplate.fields),
        style: activeTemplate.style,
        accent: activeTemplate.accent
    };
}

async function readOfflineStatusState(chatId) {
    const [dataRecord, configRecord, sharedTemplatesRecord] = await Promise.all([
        db.appData.get(getOfflineStatusDataKey(chatId)),
        db.appData.get(getOfflineStatusConfigKey(chatId)),
        db.appData.get(OFFLINE_STATUS_SHARED_TEMPLATES_KEY)
    ]);

    const savedConfig = configRecord?.value && typeof configRecord.value === 'object'
        ? configRecord.value
        : {};
    const storedSharedTemplates = Array.isArray(sharedTemplatesRecord?.value?.templates)
        ? sharedTemplatesRecord.value.templates
        : (Array.isArray(sharedTemplatesRecord?.value) ? sharedTemplatesRecord.value : null);
    let sharedTemplates;

    try {
        if (Array.isArray(storedSharedTemplates) && storedSharedTemplates.length > 0) {
            // 兼容导入的旧配置：如果当前角色仍带有公共库里没有的自定义样式，补回公共库。
            const legacyCustomTemplates = Array.isArray(savedConfig.templates)
                ? savedConfig.templates.filter(template => !OFFLINE_STATUS_BUILTIN_TEMPLATE_IDS.has(String(template?.id || '')))
                : [];
            sharedTemplates = normalizeOfflineStatusTemplates(
                storedSharedTemplates,
                legacyCustomTemplates
            );
            const storedIds = new Set(storedSharedTemplates.map(template => String(template?.id || '')));
            const hasNewLegacyTemplate = legacyCustomTemplates
                .some(template => template?.id && !storedIds.has(String(template.id)));
            if (hasNewLegacyTemplate) {
                await db.appData.put({
                    key: OFFLINE_STATUS_SHARED_TEMPLATES_KEY,
                    value: { version: OFFLINE_STATUS_TEMPLATE_VERSION, templates: sharedTemplates }
                });
            }
        } else {
            // 首次升级时扫描所有角色旧配置，避免只打开某一个角色而漏掉其它角色的自定义样式。
            const legacyRecords = await db.appData
                .where('key')
                .startsWith(OFFLINE_STATUS_CONFIG_PREFIX)
                .toArray();
            const legacyTemplateGroups = legacyRecords
                .map(record => record?.value?.templates)
                .filter(Array.isArray);
            sharedTemplates = normalizeOfflineStatusTemplates(...legacyTemplateGroups);
            await db.appData.put({
                key: OFFLINE_STATUS_SHARED_TEMPLATES_KEY,
                value: { version: OFFLINE_STATUS_TEMPLATE_VERSION, templates: sharedTemplates }
            });
        }
    } catch (error) {
        // 公共模板迁移失败时仍使用当前角色的旧数据，不能阻断线下聊天页面。
        console.warn('[offline status] shared template migration skipped:', error);
        sharedTemplates = normalizeOfflineStatusTemplates(
            Array.isArray(savedConfig.templates) ? savedConfig.templates : []
        );
    }

    return {
        data: dataRecord?.value && typeof dataRecord.value === 'object' ? dataRecord.value : {},
        config: normalizeOfflineStatusConfig(savedConfig, sharedTemplates)
    };
}

function getOfflineStatusSnapshot(message) {
    const value = message?.offlineStatus;
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length
        ? value
        : null;
}

function renderOfflineStatusGroupIcon(group) {
    const icons = {
        scene: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M12 7v5l3 2"></path></svg>',
        presence: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3"></circle><path d="M5.5 20c.8-4 3-6 6.5-6s5.7 2 6.5 6"></path></svg>',
        mind: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.3-7-10a4 4 0 0 1 7-2.7A4 4 0 0 1 19 10c0 5.7-7 10-7 10Z"></path></svg>',
        bond: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 12.5 11 15l5-6"></path><circle cx="12" cy="12" r="9"></circle></svg>'
    };
    return icons[group] || icons.presence;
}

function applyOfflineStatusTemplateStyle(element, template) {
    if (!element || !template) return;
    element.dataset.statusStyle = template.style;
    element.dataset.statusFont = template.fontMode;
    element.dataset.statusLayout = template.layoutMode;
    element.style.setProperty('--offline-status-accent', template.accent);
    element.style.setProperty('--offline-status-radius', `${template.radius}px`);
    element.style.setProperty('--offline-status-surface-alpha', String(template.surfaceAlpha / 100));
}

function replaceOfflineStatusTemplatePlaceholders(markup, template, status) {
    const source = String(markup || '').slice(0, OFFLINE_STATUS_CUSTOM_MARKUP_MAX_LENGTH);
    if (!source.trim()) return { html: '', replacementCount: 0 };
    const allowedKeys = new Set([
        ...(template?.fields || []).map(field => field.key).filter(Boolean),
        ...getOfflineStatusTemplatePlaceholderKeys(template)
    ]);
    const content = document.createElement('template');
    content.innerHTML = source;
    let replacementCount = 0;
    const replaceValue = value => String(value || '').replace(OFFLINE_STATUS_PLACEHOLDER_PATTERN, (match, key) => {
        if (!allowedKeys.has(key)) return '--';
        replacementCount += 1;
        return String(status?.[key] ?? '--');
    });
    const walker = document.createTreeWalker(content.content, 4);
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement?.closest('script,style')) continue;
        node.nodeValue = String(node.nodeValue || '').replace(OFFLINE_STATUS_PLACEHOLDER_PATTERN, (match, key) => {
            if (!allowedKeys.has(key)) return '--';
            replacementCount += 1;
            return String(status?.[key] ?? '--');
        });
    }
    content.content.querySelectorAll('*').forEach(element => {
        Array.from(element.attributes).forEach(attribute => {
            if (!String(attribute.value).includes('{{')) return;
            element.setAttribute(attribute.name, replaceValue(attribute.value));
        });
    });
    return { html: content.innerHTML, replacementCount };
}

function renderOfflineStatusCustomMarkup(template) {
    return (String(template?.customMarkup || '').trim() || template?.contentPrompt)
        ? '<div class="offline-status-custom-layout" data-offline-status-custom-frame></div>'
        : '';
}

function buildOfflineStatusCustomFrameDocument(template, status, frameId) {
    const rendered = replaceOfflineStatusTemplatePlaceholders(template?.customMarkup, template, status);
    const customCss = String(template?.customCss || '').slice(0, OFFLINE_STATUS_CUSTOM_CSS_MAX_LENGTH).replace(/<\/style/gi, '<\\/style');
    const customJs = String(template?.customJs || '').slice(0, OFFLINE_STATUS_CUSTOM_JS_MAX_LENGTH).replace(/<\/script/gi, '<\\/script');
    const serializedStatus = JSON.stringify(status && typeof status === 'object' ? status : {}).replace(/</g, '\\u003c');
    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none';">
<style>html,body{margin:0;width:100%;min-height:1px;overflow:hidden;background:transparent}*{box-sizing:border-box}img,svg,video,canvas{max-width:100%}${customCss}</style>
<script>window.STATUS_DATA=${serializedStatus};window.statusData=window.STATUS_DATA;window.open=function(){return null};window.alert=window.confirm=window.prompt=function(){return false};<\/script></head>
<body>${rendered.html}<script>try{${customJs}}catch(error){console.error('[offline status custom js]',error)}<\/script>
<script>(function(){var send=function(){var h=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight,1);parent.postMessage({type:'offline_status_frame_resize',id:'${frameId}',height:h},'*')};addEventListener('load',send);addEventListener('click',function(){setTimeout(send,0)});if(window.ResizeObserver)new ResizeObserver(send).observe(document.body);send()})()<\/script></body></html>`;
}

function ensureOfflineStatusFrameResizeListener() {
    if (window.__lookyOfflineStatusFrameResizeBound) return;
    window.__lookyOfflineStatusFrameResizeBound = true;
    window.addEventListener('message', event => {
        if (event.data?.type !== 'offline_status_frame_resize' || !/^[a-z0-9_-]+$/i.test(String(event.data.id || ''))) return;
        const frame = document.querySelector(`iframe[data-offline-status-frame="${event.data.id}"]`);
        if (!frame || frame.contentWindow !== event.source) return;
        frame.style.height = `${Math.min(900, Math.max(24, Number(event.data.height) || 24))}px`;
    });
}

function mountOfflineStatusCustomFrame(root, template, status) {
    const host = root?.matches?.('[data-offline-status-custom-frame]')
        ? root
        : root?.querySelector?.('[data-offline-status-custom-frame]');
    if (!host || !String(template?.customMarkup || '').trim()) return false;
    ensureOfflineStatusFrameResizeListener();
    const frameId = `status_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const frame = document.createElement('iframe');
    frame.className = 'offline-status-custom-frame';
    frame.dataset.offlineStatusFrame = frameId;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', `${template?.name || '自定义状态栏'}内容`);
    frame.setAttribute('scrolling', 'no');
    frame.srcdoc = buildOfflineStatusCustomFrameDocument(template, status, frameId);
    host.replaceChildren(frame);
    return true;
}

function hasValidOfflineStatusTemplatePlaceholder(template) {
    const allowedKeys = new Set((template?.fields || []).map(field => field.key).filter(Boolean));
    const text = [template?.customMarkup, template?.customCss, template?.customJs].join('\n');
    let match;
    OFFLINE_STATUS_PLACEHOLDER_PATTERN.lastIndex = 0;
    while ((match = OFFLINE_STATUS_PLACEHOLDER_PATTERN.exec(text))) {
        if (allowedKeys.has(match[1])) return true;
    }
    return false;
}

function getOfflineStatusTemplateGenerationFields(template) {
    const fields = Array.isArray(template?.fields)
        ? template.fields.filter(field => field?.visible !== false && field?.key)
        : [];
    if (template?.layoutMode !== 'custom') return fields;
    const fieldsByKey = new Map(fields.map(field => [field.key, field]));
    const usedFields = [];
    const usedKeys = new Set();
    const text = [template?.customMarkup, template?.customCss, template?.customJs].join('\n');
    let match;
    OFFLINE_STATUS_PLACEHOLDER_PATTERN.lastIndex = 0;
    while ((match = OFFLINE_STATUS_PLACEHOLDER_PATTERN.exec(text))) {
        const key = match[1];
        if (usedKeys.has(key) || !fieldsByKey.has(key)) continue;
        usedKeys.add(key);
        usedFields.push(fieldsByKey.get(key));
    }
    return usedFields.length ? usedFields : fields;
}

function getDefaultOfflineStatusCustomMarkup() {
    return `<div class="google-search-theater">
  <header class="google-search-header">
    <div class="google-word" aria-label="Google"><span>G</span><span>o</span><span>o</span><span>g</span><span>l</span><span>e</span></div>
    <span class="google-account" aria-hidden="true">G</span>
  </header>
  <div class="google-search-box">
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"></circle><path d="m16 16 4 4"></path></svg>
    <span class="google-current-query">{{当前搜索}}</span>
    <span class="google-mic" aria-hidden="true"></span>
  </div>
  <nav class="google-search-tabs" aria-label="搜索记录时间范围">
    <button type="button" class="is-active" data-google-period="all" aria-selected="true">全部</button>
    <button type="button" data-google-period="today" aria-selected="false">今天</button>
    <button type="button" data-google-period="earlier" aria-selected="false">更早</button>
  </nav>
  <section class="google-history-panel">
    <div class="google-history-heading">
      <div><strong>最近的搜索记录</strong><small>MY ACTIVITY</small></div>
      <time>{{搜索日期}}</time>
    </div>
    <div class="google-history-list">
      <button type="button" class="google-history-item" data-google-period-item="today" data-query="{{搜索记录1}}" data-detail="{{搜索详情1}}">
        <span class="google-history-clock" aria-hidden="true"></span><span class="google-history-query">{{搜索记录1}}</span><time>{{搜索时间1}}</time><span class="google-history-arrow" aria-hidden="true">↗</span>
      </button>
      <button type="button" class="google-history-item" data-google-period-item="today" data-query="{{搜索记录2}}" data-detail="{{搜索详情2}}">
        <span class="google-history-clock" aria-hidden="true"></span><span class="google-history-query">{{搜索记录2}}</span><time>{{搜索时间2}}</time><span class="google-history-arrow" aria-hidden="true">↗</span>
      </button>
      <button type="button" class="google-history-item" data-google-period-item="today" data-query="{{搜索记录3}}" data-detail="{{搜索详情3}}">
        <span class="google-history-clock" aria-hidden="true"></span><span class="google-history-query">{{搜索记录3}}</span><time>{{搜索时间3}}</time><span class="google-history-arrow" aria-hidden="true">↗</span>
      </button>
      <button type="button" class="google-history-item" data-google-period-item="earlier" data-query="{{搜索记录4}}" data-detail="{{搜索详情4}}">
        <span class="google-history-clock" aria-hidden="true"></span><span class="google-history-query">{{搜索记录4}}</span><time>{{搜索时间4}}</time><span class="google-history-arrow" aria-hidden="true">↗</span>
      </button>
      <button type="button" class="google-history-item" data-google-period-item="earlier" data-query="{{搜索记录5}}" data-detail="{{搜索详情5}}">
        <span class="google-history-clock" aria-hidden="true"></span><span class="google-history-query">{{搜索记录5}}</span><time>{{搜索时间5}}</time><span class="google-history-arrow" aria-hidden="true">↗</span>
      </button>
      <button type="button" class="google-history-item" data-google-period-item="earlier" data-query="{{搜索记录6}}" data-detail="{{搜索详情6}}">
        <span class="google-history-clock" aria-hidden="true"></span><span class="google-history-query">{{搜索记录6}}</span><time>{{搜索时间6}}</time><span class="google-history-arrow" aria-hidden="true">↗</span>
      </button>
    </div>
    <p class="google-history-empty" hidden>这个时间范围内没有搜索记录</p>
  </section>
  <article class="google-result-panel" hidden>
    <button type="button" class="google-result-back" aria-label="返回搜索记录">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg><span>返回搜索记录</span>
    </button>
    <p class="google-result-count">找到 1 条最相关的结果</p>
    <div class="google-result-source"><span class="google-result-source-icon">G</span><div><strong>Google 搜索结果</strong><small>相关内容摘要</small></div></div>
    <h2 class="google-result-title"></h2>
    <p class="google-result-body"></p>
    <div class="google-result-note">内容根据角色本轮剧情和搜索意图生成</div>
  </article>
  <footer class="google-search-footer"><span>隐私</span><i></i><span>条款</span><i></i><span>设置</span></footer>
</div>`;
}

function getDefaultOfflineStatusCustomCss() {
    return `.google-search-theater {
  width: 100%;
  overflow: hidden;
  border: 1px solid #dadce0;
  border-radius: 16px;
  background: #fff;
  color: #202124;
  font-family: Arial, "Microsoft YaHei", sans-serif;
  box-shadow: 0 8px 24px rgba(60, 64, 67, .12);
}
.google-search-header {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 62px;
  padding: 10px 18px 4px;
  position: relative;
}
.google-word {
  display: flex;
  font-size: 27px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: -1px;
}
.google-word span:nth-child(1), .google-word span:nth-child(4) { color: #4285f4; }
.google-word span:nth-child(2), .google-word span:nth-child(6) { color: #ea4335; }
.google-word span:nth-child(3) { color: #fbbc05; }
.google-word span:nth-child(5) { color: #34a853; }
.google-account {
  position: absolute;
  right: 16px;
  top: 15px;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: #5f6368;
  color: #fff;
  font-size: 13px;
  font-weight: 700;
}
.google-search-box {
  min-height: 46px;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) 18px;
  align-items: center;
  gap: 10px;
  margin: 4px 14px 0;
  padding: 0 15px;
  border: 1px solid #dfe1e5;
  border-radius: 23px;
  box-shadow: 0 1px 6px rgba(32, 33, 36, .16);
}
.google-search-box svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: #9aa0a6;
  stroke-width: 1.8;
  stroke-linecap: round;
}
.google-current-query {
  min-width: 0;
  overflow: hidden;
  color: #202124;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.google-mic {
  width: 12px;
  height: 17px;
  border: 2px solid #4285f4;
  border-top-color: #ea4335;
  border-radius: 8px;
  position: relative;
}
.google-mic::after {
  content: "";
  position: absolute;
  left: 3px;
  bottom: -6px;
  width: 2px;
  height: 5px;
  background: #34a853;
}
.google-search-tabs {
  display: flex;
  gap: 24px;
  margin-top: 12px;
  padding: 0 18px;
  border-bottom: 1px solid #ebedef;
}
.google-search-tabs button {
  min-height: 35px;
  border: 0;
  border-bottom: 3px solid transparent;
  background: transparent;
  color: #5f6368;
  padding: 0 1px;
  font-size: 12px;
}
.google-search-tabs button.is-active {
  border-bottom-color: #1a73e8;
  color: #1a73e8;
  font-weight: 700;
}
.google-history-panel { padding: 15px 0 7px; }
.google-history-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 0 18px 9px;
}
.google-history-heading strong, .google-history-heading small { display: block; }
.google-history-heading strong { font-size: 13px; }
.google-history-heading small {
  margin-top: 3px;
  color: #9aa0a6;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: .1em;
}
.google-history-heading time {
  color: #80868b;
  font-size: 10px;
  white-space: nowrap;
}
.google-history-list { display: flex; flex-direction: column; }
.google-history-item {
  width: 100%;
  min-height: 47px;
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto 16px;
  align-items: center;
  gap: 10px;
  border: 0;
  border-top: 1px solid #f0f1f2;
  background: #fff;
  color: #202124;
  padding: 8px 17px;
  text-align: left;
}
.google-history-item:hover, .google-history-item.is-selected { background: #f8fafd; }
.google-history-clock {
  width: 15px;
  height: 15px;
  border: 1.6px solid #9aa0a6;
  border-radius: 50%;
  position: relative;
}
.google-history-clock::before, .google-history-clock::after {
  content: "";
  position: absolute;
  left: 6px;
  top: 3px;
  width: 1.5px;
  height: 5px;
  background: #9aa0a6;
  transform-origin: bottom;
}
.google-history-clock::after { transform: rotate(125deg); }
.google-history-query {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.45;
}
.google-history-item time { color: #9aa0a6; font-size: 9px; white-space: nowrap; }
.google-history-arrow { color: #9aa0a6; font-size: 14px; }
.google-history-empty {
  margin: 0;
  padding: 26px 18px;
  color: #80868b;
  font-size: 11px;
  text-align: center;
}
.google-result-panel {
  padding: 14px 18px 22px;
  border-top: 1px solid #ebedef;
}
.google-result-back {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 0;
  background: transparent;
  color: #1a73e8;
  padding: 3px 0 12px;
  font-size: 11px;
  font-weight: 700;
}
.google-result-back svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.google-result-count {
  margin: 0 0 16px;
  color: #70757a;
  font-size: 9px;
}
.google-result-source {
  display: flex;
  align-items: center;
  gap: 9px;
}
.google-result-source-icon {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 1px solid #dadce0;
  border-radius: 50%;
  color: #4285f4;
  font-size: 12px;
  font-weight: 700;
}
.google-result-source strong, .google-result-source small { display: block; }
.google-result-source strong { color: #202124; font-size: 11px; }
.google-result-source small { margin-top: 2px; color: #5f6368; font-size: 9px; }
.google-result-title {
  margin: 11px 0 7px;
  color: #1a0dab;
  font-size: 17px;
  font-weight: 500;
  line-height: 1.35;
}
.google-result-body {
  margin: 0;
  color: #4d5156;
  font-size: 12px;
  line-height: 1.75;
  white-space: pre-line;
}
.google-result-note {
  margin-top: 16px;
  padding-top: 10px;
  border-top: 1px solid #f0f1f2;
  color: #9aa0a6;
  font-size: 9px;
}
.google-search-theater.is-reading .google-search-tabs { display: none; }
.google-search-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 34px;
  border-top: 1px solid #ebedef;
  background: #f8f9fa;
  color: #70757a;
  font-size: 9px;
}
.google-search-footer i { width: 2px; height: 2px; border-radius: 50%; background: #9aa0a6; }
.google-search-theater [hidden] { display: none !important; }
@media (max-width: 360px) {
  .google-search-tabs { gap: 18px; }
  .google-history-item { grid-template-columns: 18px minmax(0, 1fr) 16px; }
  .google-history-item time { display: none; }
}`;
}

function getDefaultOfflineStatusCustomJs() {
    return `const root = document.querySelector('.google-search-theater');
if (root) {
  const tabs = Array.from(root.querySelectorAll('[data-google-period]'));
  const rows = Array.from(root.querySelectorAll('[data-google-period-item]'));
  const query = root.querySelector('.google-current-query');
  const empty = root.querySelector('.google-history-empty');
  const history = root.querySelector('.google-history-panel');
  const result = root.querySelector('.google-result-panel');
  const resultTitle = root.querySelector('.google-result-title');
  const resultBody = root.querySelector('.google-result-body');
  const back = root.querySelector('.google-result-back');

  const showHistory = () => {
    root.classList.remove('is-reading');
    if (history) history.hidden = false;
    if (result) result.hidden = true;
  };

  const filterRows = period => {
    let visibleCount = 0;
    rows.forEach(row => {
      const visible = period === 'all' || row.dataset.googlePeriodItem === period;
      row.hidden = !visible;
      if (visible) visibleCount += 1;
    });
    if (empty) empty.hidden = visibleCount > 0;
  };

  tabs.forEach(tab => tab.addEventListener('click', () => {
    showHistory();
    tabs.forEach(item => {
      const active = item === tab;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', String(active));
    });
    filterRows(tab.dataset.googlePeriod || 'all');
  }));

  rows.forEach(row => row.addEventListener('click', () => {
    rows.forEach(item => item.classList.toggle('is-selected', item === row));
    const selectedQuery = row.dataset.query || row.textContent.trim();
    if (query) query.textContent = selectedQuery;
    if (resultTitle) resultTitle.textContent = selectedQuery;
    if (resultBody) resultBody.textContent = row.dataset.detail || '暂时没有更多内容。';
    root.classList.add('is-reading');
    if (history) history.hidden = true;
    if (result) result.hidden = false;
  }));

  if (back) back.addEventListener('click', showHistory);
}`;
}

function getDefaultOfflineStatusCustomContentPrompt() {
    return '根据本轮线下剧情、角色人设和角色不愿直接说出口的关注点，生成真实的手机搜索记录。当前搜索是角色此刻最想查询的内容；六条记录要具体、口语化、长短有变化，前三条属于今天，后三条属于更早时间；搜索日期和搜索时间要符合剧情时间。每个“搜索详情”都要针对对应搜索词写一篇完整内容，用 4-6 句讲清楚角色会看到的答案、建议或信息，不能只写一句摘要，也不要重复搜索词。只返回模板变量对应的 JSON，不要返回 HTML。';
}

function getDefaultOfflineStatusCustomFieldPrompts() {
    return {
        当前搜索: '生成角色此刻最想查的一句话，要具体、口语化，并直接反映当前剧情里的疑问。',
        搜索日期: '填写与当前剧情时间一致的日期标题，例如“今天”或“8月18日”。',
        搜索记录1: '生成今天较新的第一条搜索词，内容要像角色真的会在手机里输入的完整短句。',
        搜索时间1: '生成搜索记录1对应的时间，使用剧情当天的24小时制时间。',
        搜索详情1: '根据搜索记录1写4-6句完整搜索结果，回答问题并带出角色会注意的细节。',
        搜索记录2: '生成今天较新的第二条搜索词，与记录1有不同关注点但仍符合当前剧情。',
        搜索时间2: '生成搜索记录2对应的时间，必须早于或接近记录1且符合剧情节奏。',
        搜索详情2: '根据搜索记录2写4-6句完整搜索结果，不要只重复搜索词。',
        搜索记录3: '生成今天第三条搜索词，可以更私密或更犹豫，但要像真实搜索输入。',
        搜索时间3: '生成搜索记录3对应的时间，使用当天24小时制并保持顺序合理。',
        搜索详情3: '根据搜索记录3写4-6句完整内容，给出具体建议或解释并贴合角色心态。',
        搜索记录4: '生成更早的一条搜索词，体现角色之前已经出现过但仍有余波的关注。',
        搜索时间4: '生成搜索记录4的较早日期或星期标记，与当前日期一致。',
        搜索详情4: '根据搜索记录4写4-6句完整搜索结果，内容要有信息量且不脱离剧情。',
        搜索记录5: '生成更早的第五条搜索词，可以表现角色反复思考的一件小事。',
        搜索时间5: '生成搜索记录5的更早日期标记，和记录4、记录6拉开时间差。',
        搜索详情5: '根据搜索记录5写4-6句完整内容，说明可能原因、边界或行动建议。',
        搜索记录6: '生成最早的一条搜索词，作为这组记录的背景线索，不要与前面重复。',
        搜索时间6: '生成搜索记录6的最早日期标记，符合“更早”分组。',
        搜索详情6: '根据搜索记录6写4-6句完整搜索结果，让它像角色当时真的读到的页面内容。'
    };
}

function renderOfflineBuiltInStatusItems(status, config) {
    const visibleFields = config.fields.filter(field => field.visible);
    return Object.keys(OFFLINE_STATUS_GROUP_META)
        .map(group => {
            const fields = visibleFields.filter(field => field.group === group);
            if (!fields.length) return '';
            const meta = OFFLINE_STATUS_GROUP_META[group];
            const items = fields.map(field => `
                <button type="button" class="offline-card-status-item" data-status-key="${escapeHTML(field.key)}" data-status-size="${escapeHTML(field.size)}">
                    <small>${escapeHTML(field.label)}</small>
                    <strong>${escapeHTML(String(status[field.key] ?? '--'))}</strong>
                </button>
            `).join('');
            return `
                <section class="offline-card-status-section" data-status-group="${escapeHTML(group)}">
                    <div class="offline-card-status-section-heading">
                        ${renderOfflineStatusGroupIcon(group)}
                        <span>${escapeHTML(meta.label)}</span>
                        <small>${escapeHTML(meta.english)}</small>
                    </div>
                    <div class="offline-card-status-grid">${items}</div>
                </section>
            `;
        })
        .join('');
}

function renderOfflineCardStatusItems(status, config) {
    const template = getActiveOfflineStatusTemplate(config);
    if (template.layoutMode === 'custom') {
        const customMarkup = renderOfflineStatusCustomMarkup(template);
        if (customMarkup) return customMarkup;
    }
    return renderOfflineBuiltInStatusItems(status, config);
}

function buildOfflineCardStatusTrigger(message) {
    if (message?.sender !== 'character' || !getOfflineStatusSnapshot(message)) return '';
    return `
        <button type="button" class="offline-card-status-trigger" aria-label="\u67e5\u770b\u672c\u6761\u573a\u666f\u72b6\u6001" aria-expanded="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M7 4.8C7 3.8 7.8 3 8.8 3h6.4c1 0 1.8.8 1.8 1.8V20l-5-3.1L7 20V4.8Z"></path>
            </svg>
            ${message.offlineStatusUnread !== false ? '<span class="offline-card-status-dot" aria-hidden="true"></span>' : ''}
        </button>
    `;
}

function buildOfflineCardStatusPanelContent(message, template, config) {
    const status = getOfflineStatusSnapshot(message);
    const updatedAt = message?.timestamp
        ? new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        : '\u521a\u521a';
    return `
        <div class="offline-card-status-heading">
            <span class="offline-card-status-emblem" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H12v16H7.5A2.5 2.5 0 0 0 5 21.5v-16Z"></path><path d="M19 5.5A2.5 2.5 0 0 0 16.5 3H12v16h4.5a2.5 2.5 0 0 1 2.5 2.5v-16Z"></path></svg>
            </span>
            <div class="offline-card-status-title">
                <strong>${escapeHTML(template.title)}</strong>
                <span>${escapeHTML(template.subtitle)}</span>
                <small>${escapeHTML(`\u66f4\u65b0\u4e8e ${updatedAt}`)}</small>
            </div>
            <button type="button" class="offline-card-status-config" aria-label="\u7f16\u8f91\u72b6\u6001\u5b57\u6bb5">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h10"></path><circle cx="17" cy="7" r="2"></circle><path d="M10 12h10"></path><circle cx="7" cy="12" r="2"></circle><path d="M4 17h10"></path><circle cx="17" cy="17" r="2"></circle></svg>
            </button>
        </div>
        <div class="offline-card-status-content">${renderOfflineCardStatusItems(status, config)}</div>
        <div class="offline-card-status-footer">
            <span>${escapeHTML(template.name)}</span>
            <em>SCENE ARCHIVE</em>
        </div>
    `;
}

function buildOfflineCardStatusPanel(message) {
    const status = getOfflineStatusSnapshot(message);
    if (message?.sender !== 'character' || !status) return '';
    return '<div class="offline-card-status-panel" hidden></div>';
}

function cacheOfflineCardStatusMeta(messageCardElement, message) {
    const status = getOfflineStatusSnapshot(message);
    if (!status || !messageCardElement) return;
    messageCardElement._offlineStatusSnapshot = { ...status };
    messageCardElement._offlineStatusChatId = message.chatId;
    messageCardElement._offlineStatusTimestamp = message.timestamp;
}

async function hydrateOfflineCardStatus(messageCardElement, message, cachedConfig = null, options = {}) {
    const status = getOfflineStatusSnapshot(message);
    const panel = messageCardElement?.querySelector('.offline-card-status-panel');
    if (!status || !panel) return;
    cacheOfflineCardStatusMeta(messageCardElement, message);
    if (panel.hidden && !options.force) return;
    try {
        const config = cachedConfig || (await readOfflineStatusState(message.chatId)).config;
        const template = getActiveOfflineStatusTemplate(config);
        if (!panel.dataset.statusReady || options.force) {
            panel.innerHTML = buildOfflineCardStatusPanelContent(message, template, config);
            panel.dataset.statusReady = 'true';
        }
        const content = panel.querySelector('.offline-card-status-content');
        const title = panel.querySelector('.offline-card-status-title strong');
        const subtitle = panel.querySelector('.offline-card-status-title span');
        const footerName = panel.querySelector('.offline-card-status-footer span');
        applyOfflineStatusTemplateStyle(panel, template);
        if (title) title.textContent = template.title;
        if (subtitle) subtitle.textContent = template.subtitle;
        if (footerName) footerName.textContent = template.name;
        if (content) {
            content.innerHTML = renderOfflineCardStatusItems(messageCardElement._offlineStatusSnapshot, config);
            if (template.layoutMode === 'custom') {
                mountOfflineStatusCustomFrame(content, template, messageCardElement._offlineStatusSnapshot);
            }
        }
    } catch (error) {
        console.warn('[offline status] card hydration skipped:', error);
    }
}

async function refreshOfflineCardStatusPanels(chatId) {
    let config = null;
    try {
        config = (await readOfflineStatusState(chatId)).config;
    } catch (error) {
        console.warn('[offline status] config refresh skipped:', error);
        config = normalizeOfflineStatusConfig(null);
    }
    document.getElementById('page-offline-mode')?.classList.toggle('offline-status-disabled', config.enabled === false);
    if (config.enabled === false) return;
    const cards = Array.from(messageList?.querySelectorAll('.offline-message-card[data-id]') || [])
        .filter(card => String(card._offlineStatusChatId || chatId) === String(chatId))
        .filter(card => {
            const panel = card.querySelector('.offline-card-status-panel');
            return panel && !panel.hidden;
        });
    await Promise.all(cards.map(card => hydrateOfflineCardStatus(card, {
        chatId,
        sender: 'character',
        offlineStatus: card._offlineStatusSnapshot,
        timestamp: card._offlineStatusTimestamp
    }, config)));
}

function ensureOfflineStatusBar() {
    let bar = document.getElementById('offline-status-bar');
    if (bar || !messageList?.parentElement) return bar;
    bar = document.createElement('section');
    bar.id = 'offline-status-bar';
    bar.className = 'offline-status-bar';
    bar.innerHTML = `
        <div class="offline-status-heading">
            <button type="button" class="offline-status-toggle" aria-label="Toggle status">
                <span>SCENE STATUS</span><b>\u25be</b>
            </button>
            <button type="button" class="offline-status-config" aria-label="Edit status">\u2022\u2022\u2022</button>
        </div>
        <div class="offline-status-grid"></div>
    `;
    messageList.parentElement.insertBefore(bar, messageList);
    bar.addEventListener('click', async event => {
        const chatId = tempState.currentChatId;
        if (!chatId) return;
        if (event.target.closest('.offline-status-toggle')) {
            const state = await readOfflineStatusState(chatId);
            state.config.collapsed = !state.config.collapsed;
            await db.appData.put({
                key: getOfflineStatusConfigKey(chatId),
                value: buildOfflineStatusCharacterConfig(state.config)
            });
            renderOfflineStatusBar(chatId);
            return;
        }
        if (event.target.closest('.offline-status-config')) {
            openOfflineStatusConfigEditor(chatId);
            return;
        }
        const item = event.target.closest('.offline-status-item[data-status-key]');
        if (!item) return;
        const key = item.dataset.statusKey;
        const state = await readOfflineStatusState(chatId);
        const field = state.config.fields.find(entry => entry.key === key);
        showInputModal(field?.label || key, String(state.data[key] || ''), async value => {
            if (value === null) return;
            state.data[key] = String(value).trim();
            await db.appData.put({ key: getOfflineStatusDataKey(chatId), value: state.data });
            renderOfflineStatusBar(chatId);
        });
    });
    return bar;
}

async function renderOfflineStatusBar(chatId = tempState.currentChatId) {
    document.getElementById('offline-status-bar')?.remove();
    if (!chatId) return;
    await refreshOfflineCardStatusPanels(chatId);
}

function createOfflineStatusTemplateId() {
    return `status_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function getOfflineStatusStudioTemplate() {
    if (!offlineStatusStudioState) return null;
    return getActiveOfflineStatusTemplate(offlineStatusStudioState.config);
}

function buildOfflineStatusCharacterConfig(config) {
    const activeTemplate = getActiveOfflineStatusTemplate(config);
    return {
        version: OFFLINE_STATUS_TEMPLATE_VERSION,
        enabled: config.enabled !== false,
        collapsed: Boolean(config.collapsed),
        activeTemplateId: activeTemplate?.id || config.activeTemplateId,
        // 保留这个字段，兼容旧版本读取逻辑；具体字段定义以公共样式模板为准。
        fields: cloneOfflineStatusFields(activeTemplate?.fields || config.fields || DEFAULT_OFFLINE_STATUS_FIELDS)
    };
}

function getOfflineStatusTemplatePlaceholderKeys(template) {
    const keys = [];
    const seen = new Set();
    const pattern = /\{\{\s*([^{}\s]{1,40})\s*\}\}/g;
    let match;
    while ((match = pattern.exec(String(template?.customMarkup || '')))) {
        const key = String(match[1]).trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        keys.push(key);
    }
    return keys;
}

function getOfflineStatusTemplatePromptEntries(template) {
    return getOfflineStatusTemplatePlaceholderKeys(template).map(key => ({
        key,
        prompt: String(template?.fieldPrompts?.[key] || '').trim()
    }));
}

function renderOfflineStatusStudioTemplateList() {
    const list = document.getElementById('offline-status-template-list');
    if (!list || !offlineStatusStudioState) return;
    const { config } = offlineStatusStudioState;
    list.innerHTML = config.templates.map(template => `
        <button type="button" class="offline-status-template-item${template.id === config.activeTemplateId ? ' is-active' : ''}" data-template-id="${escapeHTML(template.id)}">
            <span style="--template-accent:${escapeHTML(template.accent)}"></span>
            <div>
                <strong>${escapeHTML(template.name)}</strong>
                <small>${escapeHTML(template.title)} \u00b7 ${template.builtIn ? '\u5185\u7f6e' : '\u81ea\u5b9a\u4e49'} \u00b7 ${escapeHTML(template.style.toUpperCase())}</small>
            </div>
        </button>
    `).join('');
}

function renderOfflineStatusStudioFields() {
    const container = document.getElementById('offline-status-fields-editor');
    const template = getOfflineStatusStudioTemplate();
    if (!container || !template) return;
    const fieldEntries = template.fields
        .map(field => ({ field, index: template.fields.indexOf(field) }))
        .filter(entry => entry.index >= 0);
    if (!fieldEntries.length) {
        container.innerHTML = '<div class="offline-status-field-row offline-status-field-empty">\u8fd8\u6ca1\u6709\u72b6\u6001\u5b57\u6bb5\uff0c\u8bf7\u70b9\u51fb\u201c\u6dfb\u52a0\u5b57\u6bb5\u201d\u3002</div>';
        return;
    }
    container.innerHTML = fieldEntries.map(({ field, index }) => `
        <div class="offline-status-field-row" data-field-index="${index}">
            <div class="offline-status-field-row-main">
                <input type="text" data-field-prop="label" value="${escapeHTML(field.label)}" aria-label="\u5b57\u6bb5\u540d\u79f0" placeholder="\u663e\u793a\u540d\u79f0">
                <input type="text" data-field-prop="key" value="${escapeHTML(field.key)}" aria-label="\u5b57\u6bb5\u952e\u540d" placeholder="field_key">
                <label class="offline-status-field-visible">
                    <input type="checkbox" data-field-prop="visible" ${field.visible ? 'checked' : ''}>
                    <span>\u663e\u793a</span>
                </label>
            </div>
            <div class="offline-status-field-row-options">
                <select data-field-prop="group" aria-label="\u5b57\u6bb5\u5206\u7ec4">
                    ${Object.entries(OFFLINE_STATUS_GROUP_META).map(([key, meta]) => `<option value="${key}" ${field.group === key ? 'selected' : ''}>${escapeHTML(meta.label)}</option>`).join('')}
                </select>
                <select data-field-prop="size" aria-label="\u5b57\u6bb5\u7248\u5f0f">
                    <option value="compact" ${field.size === 'compact' ? 'selected' : ''}>\u7d27\u51d1</option>
                    <option value="wide" ${field.size === 'wide' ? 'selected' : ''}>\u901a\u680f</option>
                    <option value="feature" ${field.size === 'feature' ? 'selected' : ''}>\u91cd\u70b9\u5361\u7247</option>
                </select>
                <div class="offline-status-field-actions">
                    <button type="button" data-field-action="up" aria-label="\u4e0a\u79fb">\u2191</button>
                    <button type="button" data-field-action="down" aria-label="\u4e0b\u79fb">\u2193</button>
                    <button type="button" data-field-action="delete" aria-label="\u5220\u9664">\u00d7</button>
                </div>
            </div>
            <textarea data-field-prop="hint" rows="2" placeholder="\u544a\u8bc9 AI \u8fd9\u4e2a\u5b57\u6bb5\u5e94\u8be5\u751f\u6210\u4ec0\u4e48">${escapeHTML(field.hint)}</textarea>
        </div>
    `).join('');
}

function renderOfflineStatusStudioPlaceholders() {
    const container = document.getElementById('offline-status-template-placeholders');
    const template = getOfflineStatusStudioTemplate();
    if (!container || !template) return;
    container.innerHTML = getOfflineStatusTemplatePlaceholderKeys(template).map(key => `
        <button type="button" data-status-placeholder="${escapeHTML(key)}" title="插入变量">
            {{${escapeHTML(key)}}}
        </button>
    `).join('');
}

function buildOfflineStatusTemplatePrompt(template) {
    const requestedName = String(template?.name || '').trim();
    const requestedTitle = String(template?.title || '').trim();
    return `请为我制作一个线下聊天状态栏卡片。请只返回一个 JSON 对象，不要解释，不要 Markdown 代码围栏。
JSON 顶层字段必须完整包含：format、version、name、title、subtitle、contentPrompt、fieldPrompts、customMarkup、customCss、customJs、captureRegex。
format 固定写 "looky-offline-status-template-bundle"，version 固定写 1。
name/title/subtitle 是卡片名称和标题；contentPrompt 是所有变量共用的简短背景规则；fieldPrompts 必须为 customMarkup 中每一个不同的 {{变量名}} 提供一条独立、明确的生成规则，键名必须完全一致。
customMarkup 是卡片内部 HTML，保留 {{变量名}} 占位符；customCss 是只作用于卡片的 CSS；customJs 是只作用于卡片的 JS。三者都必须是 JSON 字符串，不要再拆成代码块。
每轮 AI 只会生成 fieldPrompts 对应的变量值，绝不会重写 customMarkup、customCss 或 customJs；因此变化规则要写进对应的 fieldPrompts，而不是让 AI 自己猜。
HTML 只能写卡片内部结构，不写 html、head、body。CSS 必须适配手机窄屏，宽度使用 100%。JS 可读取 window.STATUS_DATA，但不能访问主页面、聊天记录、本地数据库、网络、parent 或外部资源。
不要使用外链图片、外链字体、iframe、弹窗或跳转。变量请放在 HTML 的文字或属性中，不要放进 CSS 或 JS。
用户使用流程是：复制这个 JSON，粘贴回页面的“模板包”输入框，点击“解析并填入”，再保存。
${requestedName ? `用户暂定名称：${requestedName}` : ''}${requestedTitle ? `\n用户暂定标题：${requestedTitle}` : ''}
请直接输出完整 JSON 对象。`;
}

function buildOfflineStatusContentPrompt(template) {
    return String(template?.contentPrompt || '').trim()
        || '根据本轮线下剧情，填写 HTML 模板中的每个 {{变量}}。只返回 JSON 对象，键名必须与模板变量完全一致；不要返回 HTML、CSS 或 JS。';
}

function buildOfflineStatusTemplateBundle(template) {
    const normalized = normalizeOfflineStatusTemplate(template || {}, 0);
    return {
        format: 'looky-offline-status-template-bundle',
        version: 1,
        name: normalized.name,
        title: normalized.title,
        subtitle: normalized.subtitle,
        contentPrompt: normalized.contentPrompt,
        fieldPrompts: Object.fromEntries(getOfflineStatusTemplatePromptEntries(normalized).map(entry => [
            entry.key,
            entry.prompt || '根据本轮线下剧情填写，保持与之前内容连续；没有变化时保留原值。'
        ])),
        customMarkup: normalized.customMarkup,
        customCss: normalized.customCss,
        customJs: normalized.customJs,
        captureRegex: normalized.captureRegex
    };
}

function parseOfflineStatusTemplateBundle(rawValue) {
    const text = String(rawValue || '').trim();
    if (!text) throw new Error('模板包为空');
    const unfenced = text
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    let parsed;
    try {
        parsed = JSON.parse(unfenced);
    } catch (error) {
        throw new Error('请粘贴完整 JSON 模板包，不要粘贴解释文字');
    }
    const source = parsed?.format === 'looky-offline-status-template-bundle'
        ? parsed
        : parsed?.template && typeof parsed.template === 'object'
            ? parsed.template
            : parsed;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw new Error('模板包必须是一个 JSON 对象');
    }
    if (!String(source.customMarkup || '').trim()) {
        throw new Error('模板包缺少 customMarkup，HTML 模板不能为空');
    }
    const placeholderKeys = getOfflineStatusTemplatePlaceholderKeys(source);
    if (!placeholderKeys.length) {
        throw new Error('HTML 模板至少要有一个 {{变量}}');
    }
    const fieldPrompts = source.fieldPrompts && typeof source.fieldPrompts === 'object' && !Array.isArray(source.fieldPrompts)
        ? source.fieldPrompts
        : {};
    const normalized = normalizeOfflineStatusTemplate({
        ...source,
        id: createOfflineStatusTemplateId(),
        builtIn: false,
        layoutMode: 'custom',
        contentPrompt: String(source.contentPrompt || '').trim() || buildOfflineStatusContentPrompt(source),
        fieldPrompts: Object.fromEntries(placeholderKeys.map(key => [
            key,
            String(fieldPrompts[key] || '').trim() || '根据本轮线下剧情填写，保持与之前内容连续；没有变化时保留原值。'
        ]))
    }, 0);
    return normalized;
}

function buildOfflineStatusCardExport(template) {
    return {
        format: OFFLINE_STATUS_EXPORT_FORMAT,
        version: 1,
        exportedAt: new Date().toISOString(),
        template: normalizeOfflineStatusTemplate({
            ...template,
            id: undefined,
            builtIn: false
        }, 0)
    };
}

function downloadOfflineStatusCardFile(template) {
    const safeName = String(template?.name || 'offline-status-card').replace(/[\\/:*?"<>|]/g, '-').slice(0, 50);
    const blob = new Blob([JSON.stringify(buildOfflineStatusCardExport(template), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeName}.looky-status.json`;
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => { anchor.remove(); URL.revokeObjectURL(url); }, 1000);
}

function parseOfflineStatusCardImport(rawValue) {
    const parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
    const source = parsed?.format === OFFLINE_STATUS_EXPORT_FORMAT ? parsed.template : parsed;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('不是有效的状态栏卡片文件');
    return normalizeOfflineStatusTemplate({ ...source, id: createOfflineStatusTemplateId(), builtIn: false }, 0);
}

async function copyOfflineStatusTemplatePrompt(template) {
    const prompt = buildOfflineStatusTemplatePrompt(template);
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(prompt);
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = prompt;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            textarea.remove();
        }
        showDynamicIsland('制作提示词已复制', 'success');
    } catch (error) {
        showDynamicIsland('复制失败，请检查浏览器剪贴板权限');
    }
}

function renderOfflineStatusStudioPreview() {
    const preview = document.getElementById('offline-status-studio-preview');
    const template = getOfflineStatusStudioTemplate();
    if (!preview || !template || !offlineStatusStudioState) return;
    const generationFields = template.layoutMode === 'custom'
        ? getOfflineStatusTemplatePlaceholderKeys(template).map(key => ({ key, label: key, hint: '模板变量预览' }))
        : getOfflineStatusTemplateGenerationFields(template);
    const config = {
        ...offlineStatusStudioState.config,
        fields: generationFields
    };
    const sampleStatus = {};
    generationFields.forEach(field => {
        sampleStatus[field.key] = offlineStatusStudioState.data[field.key]
            || field.hint
            || '\u5f85\u4e0b\u4e00\u6b21\u7ebf\u4e0b\u56de\u590d\u751f\u6210';
    });
    applyOfflineStatusTemplateStyle(preview, template);
    const customMarkup = template.layoutMode === 'custom'
        ? renderOfflineStatusCustomMarkup(template)
        : '';
    if (customMarkup) {
        preview.innerHTML = customMarkup;
        mountOfflineStatusCustomFrame(preview, template, sampleStatus);
        return;
    }
    preview.innerHTML = `
        <div class="offline-card-status-heading">
            <span class="offline-card-status-emblem" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H12v16H7.5A2.5 2.5 0 0 0 5 21.5v-16Z"></path><path d="M19 5.5A2.5 2.5 0 0 0 16.5 3H12v16h4.5a2.5 2.5 0 0 1 2.5 2.5v-16Z"></path></svg>
            </span>
            <div class="offline-card-status-title">
                <strong>${escapeHTML(template.title)}</strong>
                <span>${escapeHTML(template.subtitle)}</span>
                <small>\u5b9e\u65f6\u9884\u89c8 \u00b7 \u4e0b\u4e00\u6b21\u56de\u590d\u7acb\u5373\u751f\u6548</small>
            </div>
        </div>
        <div class="offline-card-status-content">${renderOfflineCardStatusItems(sampleStatus, config)}</div>
        <div class="offline-card-status-footer">
            <span>${escapeHTML(template.name)}</span>
            <em>SCENE ARCHIVE</em>
        </div>
    `;
}

function renderOfflineStatusStudio() {
    if (!offlineStatusStudioState) return;
    const template = getOfflineStatusStudioTemplate();
    if (!template) return;
    renderOfflineStatusStudioTemplateList();
    const enabledToggle = document.getElementById('offline-status-enabled-toggle');
    if (enabledToggle) enabledToggle.checked = offlineStatusStudioState.config.enabled !== false;
    document.getElementById('offline-status-template-name').value = template.name;
    document.getElementById('offline-status-template-title').value = template.title;
    document.getElementById('offline-status-template-subtitle').value = template.subtitle;
    document.getElementById('offline-status-template-accent').value = template.accent;
    document.getElementById('offline-status-template-font').value = template.fontMode;
    document.getElementById('offline-status-template-radius').value = template.radius;
    document.getElementById('offline-status-template-radius-value').textContent = template.radius;
    document.getElementById('offline-status-template-alpha').value = template.surfaceAlpha;
    document.getElementById('offline-status-template-alpha-value').textContent = template.surfaceAlpha;
    document.querySelectorAll('[data-status-style-option]').forEach(button => {
        button.classList.toggle('is-active', button.dataset.statusStyleOption === template.style);
    });
    document.querySelectorAll('[data-status-layout-option]').forEach(button => {
        button.classList.toggle('is-active', button.dataset.statusLayoutOption === template.layoutMode);
    });
    const customEditor = document.getElementById('offline-status-custom-template-editor');
    const customMarkupInput = document.getElementById('offline-status-template-markup');
    const customCssInput = document.getElementById('offline-status-template-css');
    const customJsInput = document.getElementById('offline-status-template-js');
    const contentPromptInput = document.getElementById('offline-status-content-prompt');
    const bundleInput = document.getElementById('offline-status-template-bundle');
    const captureRegexInput = document.getElementById('offline-status-template-capture-regex');
    if (customEditor) customEditor.hidden = template.layoutMode !== 'custom';
    if (customMarkupInput) customMarkupInput.value = template.customMarkup;
    if (customCssInput) customCssInput.value = template.customCss;
    if (customJsInput) customJsInput.value = template.customJs;
    if (contentPromptInput) contentPromptInput.value = template.contentPrompt;
    if (bundleInput && document.activeElement !== bundleInput) {
        bundleInput.value = JSON.stringify(buildOfflineStatusTemplateBundle(template), null, 2);
    }
    if (captureRegexInput) captureRegexInput.value = template.captureRegex;
    document.querySelectorAll('[data-builtin-only="true"]').forEach(element => {
        element.hidden = template.layoutMode === 'custom';
    });
    document.querySelector('.offline-status-regex-section')?.toggleAttribute('hidden', template.layoutMode !== 'custom');
    const deleteButton = document.getElementById('offline-status-delete-template');
    if (deleteButton) {
        deleteButton.disabled = Boolean(template.builtIn);
        deleteButton.textContent = template.builtIn ? '\u5185\u7f6e\u6837\u5f0f\u4e0d\u53ef\u5220\u9664' : '\u5220\u9664\u6b64\u6837\u5f0f';
    }
    renderOfflineStatusStudioFields();
    renderOfflineStatusStudioPlaceholders();
    renderOfflineStatusStudioPreview();
}

function setupOfflineStatusStudio() {
    const modal = document.getElementById('offline-status-studio-modal');
    if (!modal || modal.dataset.initialized) return;
    const closeStudio = () => {
        modal.classList.remove('visible');
        offlineStatusStudioState = null;
    };
    document.getElementById('offline-status-studio-close')?.addEventListener('click', closeStudio);
    modal.addEventListener('click', event => {
        if (event.target === modal) closeStudio();
    });
    document.getElementById('offline-status-template-list')?.addEventListener('click', event => {
        const item = event.target.closest('[data-template-id]');
        if (!item || !offlineStatusStudioState) return;
        offlineStatusStudioState.config.activeTemplateId = item.dataset.templateId;
        offlineStatusStudioState.config.fields = cloneOfflineStatusFields(getOfflineStatusStudioTemplate().fields);
        renderOfflineStatusStudio();
    });
    const syncTemplateText = (id, property) => {
        document.getElementById(id)?.addEventListener('input', event => {
            const template = getOfflineStatusStudioTemplate();
            if (!template) return;
            template[property] = event.target.value;
            renderOfflineStatusStudioTemplateList();
            renderOfflineStatusStudioPreview();
        });
    };
    syncTemplateText('offline-status-template-name', 'name');
    syncTemplateText('offline-status-template-title', 'title');
    syncTemplateText('offline-status-template-subtitle', 'subtitle');
    document.getElementById('offline-status-enabled-toggle')?.addEventListener('change', event => {
        if (!offlineStatusStudioState) return;
        offlineStatusStudioState.config.enabled = event.target.checked;
    });
    document.getElementById('offline-status-template-accent')?.addEventListener('input', event => {
        const template = getOfflineStatusStudioTemplate();
        if (!template) return;
        template.accent = event.target.value;
        renderOfflineStatusStudioTemplateList();
        renderOfflineStatusStudioPreview();
    });
    document.getElementById('offline-status-template-font')?.addEventListener('change', event => {
        const template = getOfflineStatusStudioTemplate();
        if (!template) return;
        template.fontMode = event.target.value;
        renderOfflineStatusStudioPreview();
    });
    const syncTemplateRange = (id, valueId, property) => {
        document.getElementById(id)?.addEventListener('input', event => {
            const template = getOfflineStatusStudioTemplate();
            if (!template) return;
            template[property] = Number(event.target.value);
            const valueElement = document.getElementById(valueId);
            if (valueElement) valueElement.textContent = event.target.value;
            renderOfflineStatusStudioPreview();
        });
    };
    syncTemplateRange('offline-status-template-radius', 'offline-status-template-radius-value', 'radius');
    syncTemplateRange('offline-status-template-alpha', 'offline-status-template-alpha-value', 'surfaceAlpha');
    document.getElementById('offline-status-style-options')?.addEventListener('click', event => {
        const button = event.target.closest('[data-status-style-option]');
        const template = getOfflineStatusStudioTemplate();
        if (!button || !template) return;
        template.style = button.dataset.statusStyleOption;
        document.querySelectorAll('[data-status-style-option]').forEach(item => item.classList.toggle('is-active', item === button));
        renderOfflineStatusStudioPreview();
    });
    document.getElementById('offline-status-layout-options')?.addEventListener('click', event => {
        const button = event.target.closest('[data-status-layout-option]');
        const template = getOfflineStatusStudioTemplate();
        if (!button || !template) return;
        template.layoutMode = button.dataset.statusLayoutOption === 'custom' ? 'custom' : 'builtin';
        if (template.layoutMode === 'custom' && !template.customMarkup.trim()) {
            template.customMarkup = getDefaultOfflineStatusCustomMarkup();
            if (!template.customCss.trim()) template.customCss = getDefaultOfflineStatusCustomCss();
            if (!template.customJs.trim()) template.customJs = getDefaultOfflineStatusCustomJs();
            if (!template.contentPrompt.trim()) template.contentPrompt = getDefaultOfflineStatusCustomContentPrompt();
            if (!Object.keys(template.fieldPrompts || {}).length) template.fieldPrompts = getDefaultOfflineStatusCustomFieldPrompts();
        }
        renderOfflineStatusStudio();
    });
    const customCodeInputs = [
        ['offline-status-template-markup', 'customMarkup', OFFLINE_STATUS_CUSTOM_MARKUP_MAX_LENGTH],
        ['offline-status-template-css', 'customCss', OFFLINE_STATUS_CUSTOM_CSS_MAX_LENGTH],
        ['offline-status-template-js', 'customJs', OFFLINE_STATUS_CUSTOM_JS_MAX_LENGTH]
    ];
    customCodeInputs.forEach(([id, property, maxLength]) => {
        document.getElementById(id)?.addEventListener('input', event => {
            const template = getOfflineStatusStudioTemplate();
            if (!template) return;
            template[property] = event.target.value.slice(0, maxLength);
            renderOfflineStatusStudioFields();
            renderOfflineStatusStudioPreview();
        });
    });
    document.getElementById('offline-status-content-prompt')?.addEventListener('input', event => {
        const template = getOfflineStatusStudioTemplate();
        if (!template) return;
        template.contentPrompt = event.target.value.slice(0, OFFLINE_STATUS_CONTENT_PROMPT_MAX_LENGTH);
    });
    document.getElementById('offline-status-parse-template-bundle')?.addEventListener('click', () => {
        if (!offlineStatusStudioState) return;
        const bundleInput = document.getElementById('offline-status-template-bundle');
        const current = getOfflineStatusStudioTemplate();
        if (!bundleInput || !current) return;
        try {
            const parsed = parseOfflineStatusTemplateBundle(bundleInput.value);
            const imported = normalizeOfflineStatusTemplate({
                ...parsed,
                id: current.id,
                builtIn: current.builtIn,
                layoutMode: 'custom'
            }, 0);
            const index = offlineStatusStudioState.config.templates.findIndex(template => template.id === current.id);
            if (index >= 0) offlineStatusStudioState.config.templates[index] = imported;
            offlineStatusStudioState.config.activeTemplateId = imported.id;
            renderOfflineStatusStudio();
            showDynamicIsland('模板包已解析，请检查预览后保存', 'success');
        } catch (error) {
            showDynamicIsland(error?.message || '解析失败，请粘贴完整 JSON 模板包');
        }
    });
    document.querySelector('.offline-status-code-tabs')?.addEventListener('click', event => {
        const button = event.target.closest('[data-status-code-tab]');
        if (!button) return;
        const selectedTab = button.dataset.statusCodeTab;
        document.querySelectorAll('[data-status-code-tab]').forEach(item => item.classList.toggle('is-active', item === button));
        document.querySelectorAll('[data-status-code-panel]').forEach(panel => {
            panel.hidden = panel.dataset.statusCodePanel !== selectedTab;
        });
    });
    document.getElementById('offline-status-template-capture-regex')?.addEventListener('input', event => {
        const template = getOfflineStatusStudioTemplate();
        if (!template) return;
        template.captureRegex = event.target.value.slice(0, OFFLINE_STATUS_CAPTURE_REGEX_MAX_LENGTH);
    });
    document.getElementById('offline-status-copy-template-prompt')?.addEventListener('click', () => {
        const template = getOfflineStatusStudioTemplate();
        if (template) copyOfflineStatusTemplatePrompt(template);
    });
    document.getElementById('offline-status-export-template')?.addEventListener('click', () => {
        const template = getOfflineStatusStudioTemplate();
        if (template) {
            downloadOfflineStatusCardFile(template);
            showDynamicIsland('状态栏卡片已导出', 'success');
        }
    });
    document.getElementById('offline-status-import-template')?.addEventListener('click', () => {
        document.getElementById('offline-status-import-input')?.click();
    });
    document.getElementById('offline-status-import-input')?.addEventListener('change', async event => {
        const file = event.target.files?.[0];
        if (!file || !offlineStatusStudioState) return;
        try {
            const imported = parseOfflineStatusCardImport(await file.text());
            offlineStatusStudioState.config.templates.push(imported);
            offlineStatusStudioState.config.activeTemplateId = imported.id;
            renderOfflineStatusStudio();
            showDynamicIsland('状态栏卡片已导入', 'success');
        } catch (error) {
            showDynamicIsland('导入失败，请选择状态栏卡片 JSON 文件');
        } finally {
            event.target.value = '';
        }
    });
    document.getElementById('offline-status-custom-template-editor')?.addEventListener('click', event => {
        const exampleButton = event.target.closest('#offline-status-load-template-example');
        const placeholderButton = event.target.closest('[data-status-placeholder]');
        const template = getOfflineStatusStudioTemplate();
        const markupInput = document.getElementById('offline-status-template-markup');
        if (!template || !markupInput) return;
        if (exampleButton) {
            template.name = '搜索记录小剧场';
            template.title = '搜索记录';
            template.subtitle = 'GOOGLE SEARCH HISTORY';
            template.customMarkup = getDefaultOfflineStatusCustomMarkup();
            template.customCss = getDefaultOfflineStatusCustomCss();
            template.customJs = getDefaultOfflineStatusCustomJs();
            template.contentPrompt = getDefaultOfflineStatusCustomContentPrompt();
            template.fieldPrompts = getDefaultOfflineStatusCustomFieldPrompts();
            Object.assign(offlineStatusStudioState.data, {
                当前搜索: '总是想起一个人是什么原因',
                搜索日期: '今天',
                搜索记录1: '第一次约会迟到多久算没礼貌',
                搜索时间1: '23:14',
                搜索详情1: '偶尔迟到几分钟通常不会直接被认为失礼，但最好提前告诉对方预计到达时间。真正影响感受的不是分钟数，而是让对方在没有消息的情况下等待。如果已经迟到，可以见面后简单道歉，不必反复解释。之后用行动表现出重视，例如提前规划路线，会比夸张补偿更自然。',
                搜索记录2: '附近还开着的花店',
                搜索时间2: '22:47',
                搜索详情2: '夜间营业的花店通常集中在商圈、医院附近或提供即时配送的平台。下单前可以先确认是否有现成花束以及最晚取花时间。若不确定对方偏好，颜色清淡、体积不夸张的小花束更适合临时见面。附言保持简短，会比写得过分郑重更自然。',
                搜索记录3: '怎么自然地问别人到家没有',
                搜索时间3: '22:31',
                搜索详情3: '可以直接说“到家了吗”，这句话本身就足够自然，不需要刻意寻找借口。如果担心显得太郑重，可以顺带提一句路况、天气或刚才分别时发生的小事。对方回复后，简单确认安全即可，不必连续追问。真正让人舒服的是关心有分寸，而不是措辞多漂亮。',
                搜索记录4: '雨天适合两个人去的地方',
                搜索时间4: '周二',
                搜索详情4: '雨天更适合选择不需要频繁换地点的室内活动，例如安静的咖啡馆、小型展览、书店或可以慢慢吃饭的餐厅。地点最好离双方都不太远，并预留交通受天气影响的时间。如果关系还不算熟，选择可以边走边聊、也能随时结束的地方更轻松。提前准备一把大一点的伞也是很实用的细节。',
                搜索记录5: '为什么会记住别人说过的小事',
                搜索时间5: '8月18日',
                搜索详情5: '人通常会更容易记住与情绪有关、或自己认为重要的信息。反复想起某个人说过的小事，可能说明那句话触发了期待、担心或好感，也可能只是当时的场景很特别。是否在意一个人，不能只靠单个细节判断，可以观察自己是否也会主动关注对方的感受和近况。承认自己在意并不等于必须立刻采取行动。',
                搜索记录6: '聊天结束后还想继续聊怎么办',
                搜索时间6: '8月16日',
                搜索详情6: '如果谈话已经自然结束，可以等到有真实的新话题时再联系，不必为了延长聊天强行追问。想到与对方有关的内容时，分享一张照片、一件小事或接着上次的话题都很自然。注意对方回复的节奏，如果对方也会主动延续话题，通常说明交流是双向的。保持真诚比故意计算发送时间更容易建立稳定的联系。'
            });
            const nameInput = document.getElementById('offline-status-template-name');
            const titleInput = document.getElementById('offline-status-template-title');
            const subtitleInput = document.getElementById('offline-status-template-subtitle');
            markupInput.value = template.customMarkup;
            const cssInput = document.getElementById('offline-status-template-css');
            const jsInput = document.getElementById('offline-status-template-js');
            const promptInput = document.getElementById('offline-status-content-prompt');
            if (nameInput) nameInput.value = template.name;
            if (titleInput) titleInput.value = template.title;
            if (subtitleInput) subtitleInput.value = template.subtitle;
            if (cssInput) cssInput.value = template.customCss;
            if (jsInput) jsInput.value = template.customJs;
            if (promptInput) promptInput.value = template.contentPrompt;
            renderOfflineStatusStudioTemplateList();
            renderOfflineStatusStudioFields();
            renderOfflineStatusStudioPreview();
            return;
        }
        if (!placeholderButton) return;
        const token = `{{${placeholderButton.dataset.statusPlaceholder}}}`;
        const start = Number.isFinite(markupInput.selectionStart) ? markupInput.selectionStart : markupInput.value.length;
        const end = Number.isFinite(markupInput.selectionEnd) ? markupInput.selectionEnd : start;
        markupInput.setRangeText(token, start, end, 'end');
        template.customMarkup = markupInput.value.slice(0, OFFLINE_STATUS_CUSTOM_MARKUP_MAX_LENGTH);
        markupInput.focus();
        renderOfflineStatusStudioFields();
        renderOfflineStatusStudioPreview();
    });
    const fieldsEditor = document.getElementById('offline-status-fields-editor');
    fieldsEditor?.addEventListener('input', event => {
        const row = event.target.closest('[data-field-index]');
        const template = getOfflineStatusStudioTemplate();
        const property = event.target.dataset.fieldProp;
        if (!row || !template || !property) return;
        const field = template.fields[Number(row.dataset.fieldIndex)];
        if (!field) return;
        field[property] = property === 'visible' ? event.target.checked : event.target.value;
        renderOfflineStatusStudioPlaceholders();
        renderOfflineStatusStudioPreview();
    });
    fieldsEditor?.addEventListener('change', event => {
        if (event.target.matches('select,[type="checkbox"]')) event.target.dispatchEvent(new Event('input', { bubbles: true }));
    });
    fieldsEditor?.addEventListener('click', event => {
        const button = event.target.closest('[data-field-action]');
        const row = event.target.closest('[data-field-index]');
        const template = getOfflineStatusStudioTemplate();
        if (!button || !row || !template) return;
        const index = Number(row.dataset.fieldIndex);
        if (button.dataset.fieldAction === 'delete') {
            if (template.fields.length <= 1) {
                showDynamicIsland('\u81f3\u5c11\u4fdd\u7559\u4e00\u4e2a\u72b6\u6001\u5b57\u6bb5');
                return;
            }
            template.fields.splice(index, 1);
        } else {
            const nextIndex = button.dataset.fieldAction === 'up' ? index - 1 : index + 1;
            if (nextIndex < 0 || nextIndex >= template.fields.length) return;
            [template.fields[index], template.fields[nextIndex]] = [template.fields[nextIndex], template.fields[index]];
        }
        renderOfflineStatusStudioFields();
        renderOfflineStatusStudioPlaceholders();
        renderOfflineStatusStudioPreview();
    });
    document.getElementById('offline-status-add-field')?.addEventListener('click', () => {
        const template = getOfflineStatusStudioTemplate();
        if (!template) return;
        template.fields.push(normalizeOfflineStatusField({
            key: `custom_${template.fields.length + 1}`,
            label: '\u65b0\u5b57\u6bb5',
            visible: true,
            group: 'presence',
            size: 'wide',
            hint: ''
        }, template.fields.length));
        renderOfflineStatusStudioFields();
        renderOfflineStatusStudioPlaceholders();
        renderOfflineStatusStudioPreview();
    });
    document.getElementById('offline-status-new-template')?.addEventListener('click', () => {
        if (!offlineStatusStudioState) return;
        const template = normalizeOfflineStatusTemplate({
            ...getOfflineStatusStudioTemplate(),
            id: createOfflineStatusTemplateId(),
            name: '\u65b0\u72b6\u6001\u680f',
            layoutMode: 'custom',
            contentPrompt: '根据本轮线下剧情，为 HTML 模板中每个 {{变量}} 生成简短、准确、符合人设的内容。只返回 JSON 对象，键名必须与模板中的变量完全一致，不要返回 HTML。',
            fieldPrompts: {},
            fields: cloneOfflineStatusFields(getOfflineStatusStudioTemplate()?.fields)
        }, offlineStatusStudioState.config.templates.length);
        offlineStatusStudioState.config.templates.push(template);
        offlineStatusStudioState.config.activeTemplateId = template.id;
        renderOfflineStatusStudio();
    });
    document.getElementById('offline-status-duplicate-template')?.addEventListener('click', () => {
        if (!offlineStatusStudioState) return;
        const current = getOfflineStatusStudioTemplate();
        const duplicate = normalizeOfflineStatusTemplate({
            ...current,
            id: createOfflineStatusTemplateId(),
            name: `${current.name} \u526f\u672c`,
            fields: cloneOfflineStatusFields(current.fields)
        }, offlineStatusStudioState.config.templates.length);
        offlineStatusStudioState.config.templates.push(duplicate);
        offlineStatusStudioState.config.activeTemplateId = duplicate.id;
        renderOfflineStatusStudio();
    });
    document.getElementById('offline-status-delete-template')?.addEventListener('click', () => {
        if (!offlineStatusStudioState) return;
        const { config } = offlineStatusStudioState;
        const current = getActiveOfflineStatusTemplate(config);
        if (current?.builtIn) {
            showDynamicIsland('\u5185\u7f6e\u6837\u5f0f\u4e0d\u80fd\u5220\u9664\uff0c\u53ef\u4ee5\u5148\u590d\u5236\u518d\u4fee\u6539');
            return;
        }
        if (config.templates.length <= 1) {
            showDynamicIsland('\u81f3\u5c11\u4fdd\u7559\u4e00\u5957\u72b6\u6001\u680f');
            return;
        }
        config.templates = config.templates.filter(template => template.id !== config.activeTemplateId);
        config.activeTemplateId = config.templates[0].id;
        renderOfflineStatusStudio();
    });
    document.getElementById('offline-status-save-template')?.addEventListener('click', async () => {
        if (!offlineStatusStudioState) return;
        const template = getOfflineStatusStudioTemplate();
        const keys = template.fields.map(field => field.key.trim()).filter(Boolean);
        const placeholderKeys = getOfflineStatusTemplatePlaceholderKeys(template);
        const isCustomTemplate = template.layoutMode === 'custom';
        if (!template.name.trim() || !template.title.trim() || (!isCustomTemplate && !keys.length)) {
            showDynamicIsland(template.layoutMode === 'custom' ? '\u8bf7\u586b\u5199\u6837\u5f0f\u540d\u548c\u6807\u9898' : '\u8bf7\u586b\u5199\u6837\u5f0f\u540d\u3001\u6807\u9898\u548c\u81f3\u5c11\u4e00\u4e2a\u5b57\u6bb5');
            return;
        }
        if (!isCustomTemplate && new Set(keys).size !== keys.length) {
            showDynamicIsland('\u5b57\u6bb5\u952e\u540d\u4e0d\u80fd\u91cd\u590d');
            return;
        }
        if (!isCustomTemplate && keys.some(key => !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key))) {
            showDynamicIsland('\u5b57\u6bb5\u952e\u540d\u9700\u4ee5\u82f1\u6587\u5f00\u5934\uff0c\u53ea\u4f7f\u7528\u82f1\u6587\u3001\u6570\u5b57\u548c\u4e0b\u5212\u7ebf');
            return;
        }
        if (isCustomTemplate && (!template.customMarkup.trim() || !placeholderKeys.length || !template.contentPrompt.trim())) {
            showDynamicIsland('\u8bf7\u586b\u5199 HTML 模板、至少一个 {{变量}} 和每轮内容提示词');
            return;
        }
        if (template.captureRegex && !compileOfflineStatusCaptureRegex(template.captureRegex)) {
            showDynamicIsland('\u72b6\u6001\u6355\u635e\u6b63\u5219\u65e0\u6548\uff0c\u8bf7\u68c0\u67e5\u62ec\u53f7\u3001\u659c\u6760\u548c\u6807\u5fd7');
            return;
        }
        const config = normalizeOfflineStatusConfig(offlineStatusStudioState.config);
        const activeTemplate = getActiveOfflineStatusTemplate(config);
        config.fields = cloneOfflineStatusFields(activeTemplate.fields);
        const sharedTemplates = normalizeOfflineStatusTemplates(config.templates);
        const characterConfig = buildOfflineStatusCharacterConfig({
            ...config,
            templates: sharedTemplates
        });
        await db.transaction('rw', db.appData, async () => {
            await db.appData.put({
                key: OFFLINE_STATUS_SHARED_TEMPLATES_KEY,
                value: { version: OFFLINE_STATUS_TEMPLATE_VERSION, templates: sharedTemplates }
            });
            await db.appData.put({
                key: getOfflineStatusConfigKey(offlineStatusStudioState.chatId),
                value: characterConfig
            });
        });
        await renderOfflineStatusBar(offlineStatusStudioState.chatId);
        showDynamicIsland('\u72b6\u6001\u680f\u6837\u5f0f\u5df2\u4fdd\u5b58', 'success');
        closeStudio();
    });
    modal.dataset.initialized = 'true';
}

async function openOfflineStatusConfigEditor(chatId) {
    if (!chatId) return;
    const modal = document.getElementById('offline-status-studio-modal');
    if (!modal) {
        showDynamicIsland('\u72b6\u6001\u680f\u5de5\u4f5c\u5ba4\u672a\u52a0\u8f7d');
        return;
    }
    const { data, config } = await readOfflineStatusState(chatId);
    offlineStatusStudioState = {
        chatId,
        data: { ...data },
        config: normalizeOfflineStatusConfig(config)
    };
    setupOfflineStatusStudio();
    renderOfflineStatusStudio();
    modal.classList.add('visible');
}

function compileOfflineStatusCaptureRegex(input) {
    const source = String(input || '').trim().slice(0, OFFLINE_STATUS_CAPTURE_REGEX_MAX_LENGTH);
    if (!source) return null;
    let pattern = source;
    let flags = 'i';
    if (source.startsWith('/')) {
        let closingSlash = -1;
        for (let index = source.length - 1; index > 0; index -= 1) {
            if (source[index] !== '/') continue;
            let slashCount = 0;
            for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) slashCount += 1;
            if (slashCount % 2 === 0) {
                closingSlash = index;
                break;
            }
        }
        if (closingSlash > 0) {
            pattern = source.slice(1, closingSlash);
            flags = source.slice(closingSlash + 1) || 'i';
        }
    }
    if (!/^[dgimsuvy]*$/i.test(flags)) return null;
    try {
        return new RegExp(pattern, flags.replace(/[gy]/gi, ''));
    } catch (error) {
        return null;
    }
}

function parseOfflineStatusPayload(rawBlock, template, namedGroups = null) {
    const fields = Array.isArray(template?.fields) && template.fields.length
        ? template.fields
        : DEFAULT_OFFLINE_STATUS_FIELDS;
    const knownKeys = new Set([
        ...fields.map(field => field.key),
        ...getOfflineStatusTemplatePlaceholderKeys(template),
        'relationshipDelta'
    ]);
    const cleanObject = value => {
        const candidate = value?.status && typeof value.status === 'object' ? value.status : value;
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
        const entries = Object.entries(candidate).filter(([key, item]) => knownKeys.has(key) && item !== undefined && item !== null);
        return entries.length ? Object.fromEntries(entries) : null;
    };
    if (namedGroups && typeof namedGroups === 'object') {
        const grouped = cleanObject(namedGroups);
        if (grouped) return grouped;
    }
    const source = String(rawBlock || '')
        .replace(/```(?:json|javascript|js)?/gi, '')
        .replace(/```/g, '')
        .trim();
    const tryJson = value => {
        try {
            return cleanObject(JSON.parse(value));
        } catch (error) {
            return null;
        }
    };
    const jsonCandidates = [source];
    const braceMatch = source.match(/\{[\s\S]*\}/);
    if (braceMatch && braceMatch[0] !== source) jsonCandidates.push(braceMatch[0]);
    for (const candidate of jsonCandidates) {
        const direct = tryJson(candidate);
        if (direct) return direct;
        const repaired = candidate
            .replace(/[“”]/g, '"')
            .replace(/[，]/g, ',')
            .replace(/[：]/g, ':')
            .replace(/([{,]\s*)([A-Za-z][A-Za-z0-9_]{0,39})(\s*:)/g, '$1"$2"$3')
            .replace(/,\s*([}\]])/g, '$1');
        const repairedResult = tryJson(repaired);
        if (repairedResult) return repairedResult;
    }
    const aliases = new Map();
    fields.forEach(field => {
        aliases.set(String(field.key).trim().toLowerCase(), field.key);
        if (field.label) aliases.set(String(field.label).trim().toLowerCase(), field.key);
    });
    getOfflineStatusTemplatePlaceholderKeys(template).forEach(key => {
        aliases.set(String(key).trim().toLowerCase(), key);
    });
    aliases.set('relationshipdelta', 'relationshipDelta');
    const lineStatus = {};
    source.split(/\r?\n/).forEach(line => {
        const match = line.match(/^\s*[-*]?\s*["'【[]?([^:"'：=】\]]+)["'】\]]?\s*[:：=]\s*(.*?)\s*[,，]?\s*$/);
        if (!match) return;
        const key = aliases.get(match[1].trim().toLowerCase());
        const value = match[2].trim().replace(/^['"]|['"]$/g, '');
        if (key && value) lineStatus[key] = value;
    });
    return Object.keys(lineStatus).length ? lineStatus : null;
}

function extractOfflineStatusBlock(rawText, template = null) {
    let text = String(rawText || '');
    const customRegex = compileOfflineStatusCaptureRegex(template?.captureRegex);
    if (customRegex) {
        const customMatch = customRegex.exec(text.slice(0, 200000));
        if (customMatch) {
            const customStatus = parseOfflineStatusPayload(customMatch[1] ?? customMatch[0], template, customMatch.groups);
            text = text.replace(customMatch[0], '').trim();
            if (customStatus) return { text, status: customStatus };
        }
    }

    const completePatterns = [
        /<<\s*STATUS\s*>>\s*([\s\S]*?)\s*<<\s*END\s*>>/i,
        /<<\s*STATUS(?:_JSON)?\s*>>\s*([\s\S]*?)\s*<<\s*END(?:_STATUS)?\s*>>/i,
        /<\s*STATUS\s*>\s*([\s\S]*?)\s*<\s*\/\s*STATUS\s*>/i,
        /<\s*STATUS(?:_JSON)?\s*>\s*([\s\S]*?)\s*<\s*\/\s*STATUS(?:_JSON)?\s*>/i,
        /\[\s*STATUS\s*\]\s*([\s\S]*?)\s*\[\s*\/\s*STATUS\s*\]/i,
        /【\s*状态(?:栏)?\s*】\s*([\s\S]*?)\s*【\s*(?:结束|状态结束)\s*】/i
    ];
    for (const pattern of completePatterns) {
        const match = text.match(pattern);
        if (!match) continue;
        return {
            text: text.replace(match[0], '').trim(),
            status: parseOfflineStatusPayload(match[1], template)
        };
    }

    const openEndedPatterns = [
        /<<\s*STATUS\s*>>\s*([\s\S]*)$/i,
        /<<\s*STATUS(?:_JSON)?\s*>>\s*([\s\S]*)$/i,
        /<\s*STATUS\s*>\s*([\s\S]*)$/i,
        /<\s*STATUS(?:_JSON)?\s*>\s*([\s\S]*)$/i,
        /\[\s*STATUS\s*\]\s*([\s\S]*)$/i,
        /【\s*状态(?:栏)?\s*】\s*([\s\S]*)$/i
    ];
    for (const pattern of openEndedPatterns) {
        const match = text.match(pattern);
        if (!match) continue;
        return {
            text: text.replace(match[0], '').trim(),
            status: parseOfflineStatusPayload(match[1], template)
        };
    }

    const trailingJson = text.match(/(?:^|\n)\s*(```(?:json)?\s*)?(\{[\s\S]*\})\s*(?:```)?\s*$/i);
    if (trailingJson) {
        const status = parseOfflineStatusPayload(trailingJson[2], template);
        if (status) return { text: text.replace(trailingJson[0], '').trim(), status };
    }
    // 兼容模型把状态写成“状态栏：{...}”或放在普通 Markdown 代码块里的情况。
    // 只接受包含当前模板已知字段的 JSON，避免误把正文中的普通 JSON 当成状态。
    const looseStatusJson = text.match(/(?:状态(?:栏|信息)?|status(?:\s*data|\s*json)?)\s*[:：]?\s*(```(?:json)?\s*)?(\{[\s\S]*\})(?:\s*```)?\s*$/i);
    if (looseStatusJson) {
        const status = parseOfflineStatusPayload(looseStatusJson[2], template);
        if (status) return { text: text.replace(looseStatusJson[0], '').trim(), status };
    }
    return { text, status: null };
}

async function persistOfflineStatusUpdate(chatId, statusUpdate) {
    if (!chatId || !statusUpdate) return;
    const record = await db.appData.get(getOfflineStatusDataKey(chatId));
    const previous = record?.value && typeof record.value === 'object' ? record.value : {};
    const next = { ...previous };
    Object.entries(statusUpdate).forEach(([key, value]) => {
        if (value === null || value === undefined) return;
        const trimmed = String(value).trim();
        if (!trimmed || trimmed === 'FILL_THIS') return;
        next[String(key)] = trimmed;
    });
    await db.appData.put({ key: getOfflineStatusDataKey(chatId), value: next });
    if (String(chatId) === String(tempState.currentChatId)) renderOfflineStatusBar(chatId);
}

async function appendOfflineMessage(senderType, text, sessionId) {
    const messageData = {
        chatId: tempState.currentChatId,
        sender: senderType,
        text: text,
        timestamp: new Date(),
        sessionId: sessionId || null // 如果提供了sessionId，就保存它
    };
    await db.offlineMessages.add(messageData);
    renderMessage(messageData);
    scrollToBottomOffline();
}

async function saveOfflineFriendRequestProfileState(char, direction, requestMessage) {
    const isIncoming = direction === 'char_to_user';
    const wasInContacts = char.inContacts !== false;
    const updates = {
        inContacts: isIncoming ? wasInContacts : true,
        relationStage: isIncoming ? 'pending_char' : 'pending_user',
        hasChat: false,
        requiresOfflineMeet: false,
        requiresFriendRequest: true,
        pendingFriendRequestDirection: direction,
        pendingPreviousRelationStage: char.relationStage || 'offline_met',
        pendingPreviousInContacts: wasInContacts,
        pendingFriendRequestMessage: requestMessage
    };
    Object.assign(char, updates);
    await db.characterProfiles.update(char.id, updates);
}

async function appendOfflineFriendRequestAiMessages(threadId, result) {
    const rawMessageParts = Array.isArray(result?.messages) && result.messages.length > 0
        ? result.messages
        : (result?.content ? [{ text: result.content, translation: result.translation || '' }] : []);
    const messageParts = sanitizeFriendRequestMessageParts(rawMessageParts);
    for (const part of messageParts) {
        await appendFriendRequestThreadMessage(threadId, {
            sender: 'char',
            text: part.text,
            translation: part.translation || '',
            deletable: true
        });
    }
    return messageParts;
}

async function appendOfflineFriendRequestBarMessage(chatId, sender, requestText, direction, sessionId = null) {
    if (!chatId) return null;
    const messageData = {
        chatId,
        sender,
        text: String(requestText || '').trim(),
        timestamp: new Date(),
        sessionId: sessionId || null,
        contentType: 'friend_request_bar',
        friendRequestDirection: direction,
        friendRequestText: String(requestText || '').trim()
    };
    messageData.id = await db.offlineMessages.add(messageData);
    if (String(chatId) === String(tempState.currentChatId)) {
        renderMessage(messageData);
        scrollToBottomOffline();
    }
    return messageData;
}

async function refreshOfflineFriendRequestSurfaces(charId) {
    if (offlineFriendRequestRefreshFrame) return;
    offlineFriendRequestRefreshFrame = requestAnimationFrame(() => {
        offlineFriendRequestRefreshFrame = 0;
        refreshOfflineFriendRequestActionVisibility();

        const isPageVisible = (pageId) => {
            const pageEl = document.getElementById(pageId);
            if (!pageEl) return false;
            try {
                return getComputedStyle(pageEl).display !== 'none';
            } catch (error) {
                return false;
            }
        };

        if (isPageVisible('page-new-friends')) {
            window.renderNewFriendsPage?.();
        }
        if (isPageVisible('page-character-library')) {
            window.refreshCharacterLibraryPage?.();
        }
        window.refreshChatHomeFriendList?.();
        window.dispatchEvent(new CustomEvent('looky:friend-request-updated', { detail: { charId } }));
    });
}

async function createOfflineCharToUserFriendRequest(char, requestMessage, source = 'offline_marker') {
    if (!shouldShowOfflineFriendRequestAction(char) || hasPendingOfflineFriendRequest(char)) return null;
    await saveOfflineFriendRequestProfileState(char, 'char_to_user', requestMessage);
    const request = await createOrUpdateFriendRequest(char, 'char_to_user', requestMessage, { source });
    await appendFriendRequestThreadMessage(request.threadId, {
        sender: 'char',
        text: requestMessage,
        deletable: false
    });
    await refreshOfflineFriendRequestSurfaces(char.id);
    showDynamicIsland('\u6536\u5230 Ta \u7684\u597d\u53cb\u7533\u8bf7');
    return request;
}

async function handleOfflineFriendRequestAction() {
    const char = getOfflineCurrentChar();
    if (!canUseOfflineFriendRequest(char)) {
        showDynamicIsland('\u5df2\u7ecf\u662f\u597d\u53cb\uff0c\u53ef\u4ee5\u76f4\u63a5\u53bb\u4e3b\u804a\u5929');
        return;
    }
    if (char.offlineContactExchangeReady !== true) {
        showDynamicIsland('\u9700\u8981\u5267\u60c5\u91cc\u660e\u786e\u4ea4\u6362\u8054\u7cfb\u65b9\u5f0f\u540e\u624d\u80fd\u7533\u8bf7');
        return;
    }
    if (offlineFriendRequestPending) {
        showDynamicIsland('\u597d\u53cb\u7533\u8bf7\u6b63\u5728\u5904\u7406\u4e2d');
        return;
    }
    const existingPending = hasPendingOfflineFriendRequest(char);
    if (existingPending) {
        showDynamicIsland('\u5df2\u6709\u5f85\u5904\u7406\u7684\u597d\u53cb\u7533\u8bf7');
        showPage('page-new-friends');
        return;
    }
    const message = await showInputModal({
        title: '\u597d\u53cb\u7533\u8bf7',
        initialValue: '',
        placeholder: '\u586b\u5199\u4f60\u8981\u53d1\u7ed9 Ta \u7684\u9a8c\u8bc1\u6d88\u606f\uff0c\u7559\u7a7a\u5219\u53d1\u9001\u9ed8\u8ba4\u6d88\u606f',
        isTextarea: true
    });
    if (message === null) return;

    offlineFriendRequestPending = true;
    try {
        const requestText = getSafeFriendRequestText(
            String(message || ''),
            char.incomingRequestMessage || `\u6211\u662f${char.name || 'Ta'}`
        ) || char.incomingRequestMessage || `\u6211\u662f${char.name || 'Ta'}`;
        await saveOfflineFriendRequestProfileState(char, 'user_to_char', requestText);
        const request = await createOrUpdateFriendRequest(char, 'user_to_char', requestText, { source: 'offline_request' });
        await appendOfflineFriendRequestBarMessage(char.id, 'user', requestText, 'user_to_char');
        const threadMessages = AppState.friendRequestThreads?.[request.threadId] || [];
        const result = await requestFriendRequestAiDecision(char, 'user_to_char', requestText, threadMessages);
        await appendOfflineFriendRequestAiMessages(request.threadId, result);
        if (result.decision === 'accept') {
            await finalizeFriendRequestAcceptance(char, 'user_to_char', request, result.initialChatMessages);
        } else {
            if (result.decision === 'reject') {
                await applyRelationshipScoreEvent(char, 'friend_request_reject', {
                    requestId: request?.id,
                    source: 'offline_request_ai',
                    summary: '角色暂时拒绝了用户的线下好友申请'
                });
            }
            showDynamicIsland(result.decision === 'reject' ? 'Ta \u6682\u65f6\u6ca1\u6709\u540c\u610f' : '\u9a8c\u8bc1\u56de\u590d\u5df2\u751f\u6210');
        }
        await refreshOfflineFriendRequestSurfaces(char.id);
        return;
    } catch (error) {
        console.error('[OfflineFriendRequest] request failed:', error);
        showDynamicIsland(error?.message || '\u597d\u53cb\u7533\u8bf7\u5904\u7406\u5931\u8d25');
    } finally {
        offlineFriendRequestPending = false;
        refreshOfflineFriendRequestActionVisibility();
    }
}

/**
 * 显示AI正在输入的动画
 */
function showTypingIndicator() {
    if (document.getElementById('ai-typing-indicator')) return;
    const character = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
    const avatarSrc = character?.avatar || DEFAULT_AVATAR_SRC;
    const indicatorHTML = `
        <div class="offline-message-card is-character" id="ai-typing-indicator">
            <div class="sender-info">
                <img src="${avatarSrc}" alt="avatar" class="sender-avatar">
                <div class="typing-indicator">
                    <span></span><span></span><span></span>
                </div>
            </div>
        </div>
    `;
    messageList.insertAdjacentHTML('beforeend', indicatorHTML);
    scrollToBottomOffline();
}

/**
 * 移除AI正在输入的动画
 */
function hideTypingIndicator() {
    const indicator = document.getElementById('ai-typing-indicator');
    if (indicator) {
        indicator.remove();
    }
}

function setOfflineSendLoading(isLoading) {
    if (!sendButton) return;
    sendButton.classList.toggle('loading', Boolean(isLoading));
}

/**
 * 滚动聊天列表到底部
 */
function scrollToBottomOffline() {
    if (scrollContainer) {
        if (!IS_ANDROID_RUNTIME) {
            scrollContainer.scrollTop = scrollContainer.scrollHeight;
            return;
        }
        // 安卓 WebView 在流式回复期间会反复执行这里。先临时关闭平滑滚动，
        // 避免多个 smooth 动画排队后把触摸滚动层卡住；用户手指滚动不受影响。
        const previousBehavior = scrollContainer.style.scrollBehavior;
        scrollContainer.style.scrollBehavior = 'auto';
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        if (previousBehavior !== 'auto') {
            window.requestAnimationFrame(() => {
                if (!scrollContainer || scrollContainer.style.scrollBehavior !== 'auto') return;
                if (previousBehavior) {
                    scrollContainer.style.scrollBehavior = previousBehavior;
                } else {
                    scrollContainer.style.removeProperty('scroll-behavior');
                }
            });
        }
    }
}

/**
 * 渲染单条线下消息卡片，并为其绑定长按事件
 * @param {object} message - 消息对象
 */
function renderMessage(message) {
    // 处理历史记录分隔符的逻辑保持不变
    if (message.sender === 'system' && message.text === '历史记录') {
        const separatorHTML = `
            <div class="history-separator">
                <span class="line"></span>
                <span class="text">历史记录</span>
                <span class="line"></span>
            </div>
        `;
        messageList.insertAdjacentHTML('beforeend', separatorHTML);
        return; 
    }
    
    // 准备消息数据的逻辑保持不变
      const isCharacter = message.sender === 'character';
    // 获取当前聊天的角色对象（用来读取覆写设置）
    const chatChar = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
    const user = getCurrentChatIdentity();

    let avatarSrc = DEFAULT_AVATAR_SRC;
    let senderName = '';
    if (isCharacter) {
        // 群聊线下模式：统一使用群聊的头像和名称作为叙述者标识
        // 不再尝试解析【角色名】标记，因为AI输出的是一整段融合叙事
        avatarSrc = chatChar?.chatOverrideAvatar || chatChar?.avatar || DEFAULT_AVATAR_SRC;
        senderName = chatChar?.chatOverrideName || chatChar?.name || '对方';
    } else {

        // 如果是用户：优先用角色档案里存的用户覆写设置
        avatarSrc = chatChar?.chatOverrideUserAvatar || user?.avatar || DEFAULT_AVATAR_SRC;
        senderName = chatChar?.chatOverrideUserNickname || user?.name || '你';
    }
    const timestamp = new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    // 【修改核心】：彻底分离普通文本和HTML
    const extracted = extractHtmlAndText(message.text);
    const isFriendRequestBar = message?.contentType === 'friend_request_bar';
    const processedText = isFriendRequestBar ? '' : processOfflineMessageSafely(extracted.text);
    const messageCardElement = document.createElement('div');
    messageCardElement.className = `offline-message-card ${isCharacter ? 'is-character' : ''}${isFriendRequestBar ? ' is-friend-request-bar' : ''}`;
    messageCardElement.dataset.id = message.id;
    messageCardElement.innerHTML = `
        <div class="card-header">
            <div class="sender-info">
                <img src="${avatarSrc}" alt="avatar" class="sender-avatar" loading="lazy" decoding="async">
                <span class="sender-name">${escapeHTML(senderName)}</span>
                <span class="timestamp">${timestamp}</span>
            </div>
            ${buildOfflineCardStatusTrigger(message)}
        </div>
        ${buildOfflineCardStatusPanel(message)}
        <div class="card-body">
            ${isFriendRequestBar ? '' : `<div class="offline-prose">${processedText}</div>`}
            ${buildOfflineFriendRequestBarHtml(message)}
            ${extracted.html ? `
            <details class="offline-html-details" style="margin-top: 10px; border: 1px solid rgba(0,0,0,0.1); border-radius: 12px; background: transparent; overflow: hidden;">
                <summary style="padding: 10px 12px; cursor: pointer; font-size: 13px; color: inherit; display: flex; align-items: center; user-select: none; font-weight: 600; outline: none; background: rgba(0,0,0,0.03);">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right: 6px; flex-shrink: 0;"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
                    <span>展开互动卡片</span>
                </summary>
                <div class="offline-html-snippet-wrapper" id="offline-html-${message.id}" style="width: 100%; position: relative; overflow: hidden; background: transparent; transition: height 0.3s ease; display: block;"></div>
            </details>
            ` : ''}
        </div>
        ${isCharacter && !isFriendRequestBar ? `
          <div class="card-footer">
                <span class="card-watermark">시작은 미약할지언정 끝은 창대하리</span>
            </div>
        ` : ''}
    `;
    // 线下 HTML 卡片渲染（安全沙盒与自适应扩展）
    if (extracted.html) {
        const detailsEl = messageCardElement.querySelector('.offline-html-details');
        const wrapper = messageCardElement.querySelector(`#offline-html-${message.id}`);
        if (detailsEl && wrapper) {
            let iframeLoaded = false;
            detailsEl.addEventListener('toggle', function() {
                if (this.open && !iframeLoaded) {
                    iframeLoaded = true;
                    const safeHtml = sanitizeOfflineHtmlSnippet(extracted.html);
                    const iframe = document.createElement('iframe');
                    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
                     iframe.setAttribute('scrolling', 'auto');
                    iframe.style.cssText = 'width: 100%; min-width: 280px; max-height: 500px; border: none; background: transparent; display: block; margin: 0 auto;';
                    iframe.srcdoc = `
                        <!DOCTYPE html>
                        <html>
                         <head>
                          <meta charset="utf-8">
                          <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
                        <style>
                            html, body { margin:0; padding:0; width:100%; min-height:10px; overflow-y:auto; overflow-x:hidden; background:transparent !important; display: block !important; align-items: flex-start !important; }
                            body > * { margin: 0 !important; }
                            .close-layer { background: transparent !important; padding: 0 !important; }
                            /* ▼▼▼ 新增：强力覆盖 AI 的弹窗定位和高度限制 ▼▼▼ */
                            [class*="modal"], [class*="overlay"], [class*="popup"], [class*="container"] {
                                position: relative !important;
                                top: 0 !important;
                                left: 0 !important;
                                transform: none !important;
                                margin-top: 0 !important;
                                height: auto !important;
                                min-height: 100% !important;
                            }
                            /* ▲▲▲ 新增结束 ▲▲▲ */
                            a { pointer-events:none !important; text-decoration:none !important; color:inherit; }
                            img, video { max-width:100%; height:auto; border-radius:8px; }
                            ::-webkit-scrollbar { display:none !important; width:0; height:0; }
                          </style>
                          <script>
                            window.alert = window.confirm = window.prompt = function(){ return false; };
                            window.open = function(){ return null; };
                            function reportHeight() {
                                const h = document.documentElement.scrollHeight || document.body.scrollHeight;
                                window.parent.postMessage({ type:'offline_resize_html', id:'${message.id}', height: h }, '*');
                            }
                            window.onload = function() {
                                reportHeight();
                                if (window.ResizeObserver) {
                                    new ResizeObserver(reportHeight).observe(document.body);
                                }
                                /* ▼▼▼ 修复发热：删除致命的无限轮询，仅保留点击时的动态检测 ▼▼▼ */
                                document.body.addEventListener('click', function() {
                                    setTimeout(reportHeight, 100);
                                    setTimeout(reportHeight, 400);
                                });
                                /* ▲▲▲ 修复结束 ▲▲▲ */
                            };
                          </script>
                        </head>
                        <body>${safeHtml}</body>
                        </html>
                    `;
                    const onResize = (event) => {
                        if (event.data && event.data.type === 'offline_resize_html' && String(event.data.id) === String(message.id)) {
                            let realHeight = Number(event.data.height) || 10;
                            if (realHeight > 500) realHeight = 500;
                            iframe.style.height = realHeight + 'px';
                            wrapper.style.height = realHeight + 'px';
                        }
                    };
                    window.addEventListener('message', onResize);
                    wrapper.appendChild(iframe);
                }
            });
        }
    }
    // 4. 【关键一步！】为这个刚刚创建好的、真实的消息卡片元素绑定长按功能！
    setupLongPressForOffline(messageCardElement);

    // 5. 最后，把这个功能齐全的卡片元素添加到消息列表中。
    messageList.appendChild(messageCardElement);
    resyncOfflineFontSizing();
    cacheOfflineCardStatusMeta(messageCardElement, message);
    prepareOfflineMessageCollapse(messageCardElement);
}
/**
 * 加载并渲染指定聊天的线下历史记录
 * @param {string} chatId 
 */
async function loadAndRenderHistory(chatId) {
    // ▼▼▼ 流式清理：切换角色时销毁可能残留的流式卡片 ▼▼▼
    const leftoverStreamCard = document.getElementById('offline-streaming-card');
    if (leftoverStreamCard) leftoverStreamCard.remove();
    destroyOfflineStreamingState();
    // ▲▲▲ 流式清理结束 ▲▲▲
    // ▼▼▼ 性能监测 2：监控主聊天界面的加载耗时 ▼▼▼
    console.time(`[性能监测] 加载主聊天界面耗时 (ChatID: ${chatId})`);
    // ==========================================
    // 【终极断点续传逻辑】：在渲染前，必须先查明状态！
    // ==========================================
    const storageKey = `offline_session_active_${chatId}`;
    let savedSessionId = localStorage.getItem(storageKey);
    
    // 如果缓存丢了（比如换设备/导数据），去数据库底层深挖
    if (!savedSessionId) {
        const lastMsg = await db.offlineMessages.where({ chatId: chatId }).last();
        if (lastMsg && lastMsg.sessionId) {
            const endedSession = await db.offlineSessions
                .where({ chatId: chatId })
                .filter(s => s.sessionId === lastMsg.sessionId)
                .first();
            const isEnded = !!endedSession;
            if (!isEnded) {
                savedSessionId = lastMsg.sessionId;
                localStorage.setItem(storageKey, savedSessionId); // 补回丢失的缓存
                console.log(`[底层恢复] 成功从数据库深处找回未结束的约会！ID: ${savedSessionId}`);
            }
        }
    }
    // 根据最终查明的结果，严谨地下定论
    if (savedSessionId) {
        tempState.isDateActive = true;
        tempState.activeOfflineSession = chatId;
        tempState.currentOfflineSessionId = savedSessionId;
        console.log(`[状态同步] 检测到 ${chatId} 的约会仍在进行中，isDateActive 设置为 true`);
    } else {
        tempState.isDateActive = false;
        tempState.activeOfflineSession = null;
        tempState.currentOfflineSessionId = null;
        console.log(`[状态同步] 未检测到 ${chatId} 的约会或已结束，isDateActive 设置为 false`);
    }
    messageList.innerHTML = '';
    const threshold = 20;
    const totalMessageCount = await db.offlineMessages.where('chatId').equals(chatId).count();
    const foldCount = Math.max(0, totalMessageCount - threshold);
    const messagesToRender = await db.offlineMessages
        .where('chatId')
        .equals(chatId)
        .offset(foldCount)
        .limit(threshold)
        .toArray();

    if (foldCount > 0) {
        chatState.unrenderedMessages.set(`offline_${chatId}`, { remainingCount: foldCount });
    } else {
        chatState.unrenderedMessages.delete(`offline_${chatId}`);
    }

    // 如果有折叠消息，创建“加载更多”按钮
    if (foldCount > 0) {
        const folder = document.createElement('div');
        folder.className = 'message-folder';
        folder.dataset.conversationId = chatId;
        folder.innerHTML = `<button class="btn-load-more">查看更早的 ${foldCount} 条消息</button>`;
        messageList.appendChild(folder);
    }
    const renderFragment = document.createDocumentFragment();
    messagesToRender.forEach(message => {
        const messageCard = createMessageElementForPrepending(message);
        renderFragment.appendChild(messageCard);
    });
    messageList.appendChild(renderFragment);
    resyncOfflineFontSizing();
    // 瞬时滚动到底部
    if (scrollContainer) {
        scrollContainer.style.scrollBehavior = 'auto';
        setTimeout(() => {
            scrollToBottomOffline();
            setTimeout(() => {
                scrollContainer.style.scrollBehavior = 'smooth';
                // ▼▼▼ 性能监测 2 结束：滚动完成代表界面真正渲染完毕 ▼▼▼
                console.timeEnd(`[性能监测] 加载主聊天界面耗时 (ChatID: ${chatId})`);
                
                // ▼▼▼ 新增：如果该角色正在后台生成回复，切回来时补上“正在输入”动画 ▼▼▼
                if (isModeGenerating('offline', chatId)) {
                    showTypingIndicator();
                    setOfflineSendLoading(true);
                } else {
                    setOfflineSendLoading(false);
                }
                // ▲▲▲ 新增结束 ▲▲▲
            }, 100); 
        }, 50);
    } else {
        console.timeEnd(`[性能监测] 加载主聊天界面耗时 (ChatID: ${chatId})`);
        // 同理，也要加在这里
        if (isModeGenerating('offline', chatId)) {
            showTypingIndicator();
            setOfflineSendLoading(true);
        } else {
            setOfflineSendLoading(false);
        }
    }
}
/**
 * 加载并渲染被折叠的更早的线下消息（这是按下开关后要执行的具体动作）
 * @param {string} chatId - 当前的聊天ID
 * @param {HTMLElement} button - 被点击的“加载更多”按钮元素
 */
async function renderOlderOfflineMessages(chatId, button) {
    const FOLD_CHUNK_SIZE = 20; // 每次加载20条，性能更佳
    const key = `offline_${chatId}`;
    const foldedState = chatState.unrenderedMessages.get(key);
    const remainingCount = Array.isArray(foldedState)
        ? foldedState.length
        : (Number(foldedState?.remainingCount) || 0);

    if (remainingCount === 0) {
        button.parentElement.remove();
        return;
    }
    button.disabled = true;

    const oldScrollHeight = scrollContainer.scrollHeight;
    const oldScrollTop = scrollContainer.scrollTop;

    const numberToLoad = Math.min(FOLD_CHUNK_SIZE, remainingCount);
    const offset = remainingCount - numberToLoad;
    const messagesToRender = Array.isArray(foldedState)
        ? foldedState.slice(-numberToLoad)
        : await db.offlineMessages
            .where('chatId')
            .equals(chatId)
            .offset(offset)
            .limit(numberToLoad)
            .toArray();
    if (messagesToRender.length === 0) {
        button.parentElement.remove();
        chatState.unrenderedMessages.delete(key);
        return;
    }
    const nextRemainingCount = remainingCount - messagesToRender.length;

    const fragment = document.createDocumentFragment();
    messagesToRender.forEach(msg => {
        const messageCardElement = createMessageElementForPrepending(msg);
        fragment.appendChild(messageCardElement);
    });

    const currentFolder = button.parentElement;
    currentFolder.remove();

    // 将渲染好的消息片段插入到消息列表的顶部
    messageList.prepend(fragment);
    resyncOfflineFontSizing();
    
    if (nextRemainingCount > 0) {
        const newFolder = document.createElement('div');
        newFolder.className = 'message-folder';
        newFolder.dataset.conversationId = chatId;
        newFolder.innerHTML = `<button class="btn-load-more">查看更早的 ${nextRemainingCount} 条消息</button>`;
        messageList.prepend(newFolder);
        chatState.unrenderedMessages.set(key, Array.isArray(foldedState)
            ? foldedState.slice(0, nextRemainingCount)
            : { remainingCount: nextRemainingCount });
    } else {
        chatState.unrenderedMessages.delete(key);
    }

    // 恢复滚动条位置，防止页面跳动
    const newScrollHeight = scrollContainer.scrollHeight;
    scrollContainer.style.scrollBehavior = 'auto';
    scrollContainer.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
    setTimeout(() => {
        scrollContainer.style.scrollBehavior = 'smooth';
    }, 100);
}

/**
 * 辅助函数：创建消息元素但不立即插入页面，用于预置到列表顶部。
 * @param {object} message - 消息对象
 * @returns {HTMLElement} - 创建好的消息卡片DOM元素
 */
function createMessageElementForPrepending(message) {
    // 这段代码逻辑与你的 renderMessage 函数几乎一致，只是最后返回元素
    if (message.sender === 'system' && message.text === '历史记录') {
        const separator = document.createElement('div');
        separator.className = 'history-separator';
        separator.innerHTML = `<span class="line"></span><span class="text">历史记录</span><span class="line"></span>`;
        return separator;
    }
    
    const isCharacter = message.sender === 'character';
    // 获取当前聊天的角色对象（用来读取覆写设置）
    const chatChar = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
    const user = getCurrentChatIdentity();

    let avatarSrc = DEFAULT_AVATAR_SRC;
    let senderName = '';
    if (isCharacter) {
        // 群聊线下模式：统一使用群聊的头像和名称作为叙述者标识
        avatarSrc = chatChar?.chatOverrideAvatar || chatChar?.avatar || DEFAULT_AVATAR_SRC;
        senderName = chatChar?.chatOverrideName || chatChar?.name || '对方';
    } else {

        // 如果是用户：优先用角色档案里存的用户覆写设置
        avatarSrc = chatChar?.chatOverrideUserAvatar || user?.avatar || DEFAULT_AVATAR_SRC;
        senderName = chatChar?.chatOverrideUserNickname || user?.name || '你';
    }
   const timestamp = new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const messageCardElement = document.createElement('div');
    
    // 【修改核心】：彻底分离普通文本和HTML
    const extracted = extractHtmlAndText(message.text);
    const isFriendRequestBar = message?.contentType === 'friend_request_bar';
    const processedText = isFriendRequestBar ? '' : processOfflineMessageSafely(extracted.text);
    messageCardElement.className = `offline-message-card ${isCharacter ? 'is-character' : ''}${isFriendRequestBar ? ' is-friend-request-bar' : ''}`;
    messageCardElement.dataset.id = message.id;
    messageCardElement.innerHTML = `
        <div class="card-header">
            <div class="sender-info">
                <img src="${avatarSrc}" alt="avatar" class="sender-avatar" loading="lazy" decoding="async">
                <span class="sender-name">${escapeHTML(senderName)}</span>
                <span class="timestamp">${timestamp}</span>
            </div>
            ${buildOfflineCardStatusTrigger(message)}
        </div>
        ${buildOfflineCardStatusPanel(message)}
       <div class="card-body">
            ${isFriendRequestBar ? '' : `<div class="offline-prose">${processedText}</div>`}
            ${buildOfflineFriendRequestBarHtml(message)}
            ${extracted.html ? `
            <details class="offline-html-details" style="margin-top: 10px; border: 1px solid rgba(0,0,0,0.1); border-radius: 12px; background: transparent; overflow: hidden;">
                <summary style="padding: 10px 12px; cursor: pointer; font-size: 13px; color: inherit; display: flex; align-items: center; user-select: none; font-weight: 600; outline: none; background: rgba(0,0,0,0.03);">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right: 6px; flex-shrink: 0;"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
                <span>展开互动卡片</span>
                </summary>
                <div class="offline-html-snippet-wrapper" id="offline-html-pre-${message.id}" style="width: 100%; position: relative; overflow: hidden; background: transparent; transition: height 0.3s ease; display: block;"></div>
            </details>
            ` : ''}
        </div>
        ${isCharacter && !isFriendRequestBar ? `<div class="card-footer"><span class="card-watermark">시작은 미약할지언정 끝은 창대하리</span></div>` : ''}
    `;
    setupLongPressForOffline(messageCardElement);
    
    // 线下 HTML 卡片渲染（安全沙盒与自适应扩展）
    if (extracted.html) {
        const detailsEl = messageCardElement.querySelector('.offline-html-details');
        const wrapper = messageCardElement.querySelector(`#offline-html-pre-${message.id}`);
        if (detailsEl && wrapper) {
            let iframeLoaded = false;
            detailsEl.addEventListener('toggle', function() {
                if (this.open && !iframeLoaded) {
                    iframeLoaded = true;
                    const safeHtml = sanitizeOfflineHtmlSnippet(extracted.html);
                    const iframe = document.createElement('iframe');
                    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
                                    iframe.setAttribute('scrolling', 'auto');
                    iframe.style.cssText = 'width: 100%; min-width: 280px; max-height: 500px; border: none; background: transparent; display: block; margin: 0 auto;';
                    iframe.srcdoc = `
                        <!DOCTYPE html>
                        <html>
                         <head>
                          <meta charset="utf-8">
                          <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
                        <style>
                            html, body { margin:0; padding:0; width:100%; min-height:10px; overflow-y:auto; overflow-x:hidden; background:transparent !important; display: block !important; align-items: flex-start !important; }
                            body > * { margin: 0 !important; }
                            .close-layer { background: transparent !important; padding: 0 !important; }
                            /* ▼▼▼ 新增：强力覆盖 AI 的弹窗定位和高度限制 ▼▼▼ */
                            [class*="modal"], [class*="overlay"], [class*="popup"], [class*="container"] {
                                position: relative !important;
                                top: 0 !important;
                                left: 0 !important;
                                transform: none !important;
                                margin-top: 0 !important;
                                height: auto !important;
                                min-height: 100% !important;
                            }
                            /* ▲▲▲ 新增结束 ▲▲▲ */
                            a { pointer-events:none !important; text-decoration:none !important; color:inherit; }
                            img, video { max-width:100%; height:auto; border-radius:8px; }
                            ::-webkit-scrollbar { display:none !important; width:0; height:0; }
                          </style>
                          <script>
                            window.alert = window.confirm = window.prompt = function(){ return false; };
                            window.open = function(){ return null; };
                            function reportHeight() {
                                const h = document.documentElement.scrollHeight || document.body.scrollHeight;
                                window.parent.postMessage({ type:'offline_resize_html', id:'${message.id}', height: h }, '*');
                            }
                            window.onload = function() {
                                reportHeight();
                                   if (window.ResizeObserver) {
                                    new ResizeObserver(reportHeight).observe(document.body);
                                }
                                /* ▼▼▼ 修复发热：删除致命的无限轮询，仅保留点击时的动态检测 ▼▼▼ */
                                document.body.addEventListener('click', function() {
                                    setTimeout(reportHeight, 100);
                                    setTimeout(reportHeight, 400);
                                });
                                /* ▲▲▲ 修复结束 ▲▲▲ */
                            };
                          </script>
                        </head>
                        <body>${safeHtml}</body>
                        </html>
                    `;
                    const onResize = (event) => {
                        if (event.data && event.data.type === 'offline_resize_html' && String(event.data.id) === String(message.id)) {
                                          let realHeight = Number(event.data.height) || 10;
                            if (realHeight > 500) realHeight = 500;
                            iframe.style.height = realHeight + 'px';
                            wrapper.style.height = realHeight + 'px';
                        }
                    };
                    window.addEventListener('message', onResize);
                    wrapper.appendChild(iframe);
                }
            });
        }
    }
    cacheOfflineCardStatusMeta(messageCardElement, message);
    prepareOfflineMessageCollapse(messageCardElement);
    return messageCardElement;
}

/**
 * 发送一条新的线下消息 (修正版：利用 LocalStorage 永久记忆会话ID，直到用户主动结束)
 */
async function sendMessage() {
    const text = inputField.value.trim();
    const chatId = tempState.currentChatId;
    if (!chatId) return;
    if (isModeGenerating('offline', chatId)) {
        cancelAiGeneration('offline', chatId);
        hideTypingIndicator();
        // ▼▼▼ 流式中断清理：移除流式预览卡片 ▼▼▼
        const interruptStreamCard = document.getElementById('offline-streaming-card');
        if (interruptStreamCard) interruptStreamCard.remove();
        destroyOfflineStreamingState();
        // ▲▲▲ 流式中断清理结束 ▲▲▲
        setOfflineSendLoading(false);
        showDynamicIsland('已打断生成');
        return;
    }

    // --- 【修复核心：状态恢复逻辑】 ---
    
    // 1. 定义存储在 LocalStorage 中的键名 (每个角色一个独立的坑位)
    const storageKey = `offline_session_active_${chatId}`;

    // 2. 如果当前内存中没有活跃状态（比如刚刷新页面）
    if (!tempState.isDateActive) {
        // 尝试从 LocalStorage 读取“上次没结束的会话ID”
        const savedSessionId = localStorage.getItem(storageKey);

        if (savedSessionId) {
            // ✅ 情况A：找到了旧的 ID -> 完美续连！
            // 不管过了多久，只要这里有记录，就说明用户没点过结束
            tempState.isDateActive = true;
            tempState.activeOfflineSession = chatId;
            tempState.currentOfflineSessionId = savedSessionId;
            saveHybridStateToSession(); // 同步到 session (虽然刷新会丢，但保持一致性)
            console.log(`[会话恢复] 检测到未结束的约会，已恢复 ID: ${savedSessionId}`);
        } else {
            // 🆕 情况B：真的没有旧 ID -> 开启新约会
            tempState.isDateActive = true;
            addSystemEventMessage(chatId, '见面吧', 'date_start');
            
            tempState.activeOfflineSession = chatId;
            // 创建新 ID
            const newSessionId = `${chatId}-${Date.now()}`;
            tempState.currentOfflineSessionId = newSessionId;
            
            // 🔥【关键】把这个新 ID 记入 LocalStorage
            localStorage.setItem(storageKey, newSessionId);
            
            saveHybridStateToSession();
            console.log(`[混合模式] 开启全新线下会话 ID: ${newSessionId} (已写入缓存)`);
        }
    }
     // 处理空输入续写
    if (!text) {
        const lastMessage = await db.offlineMessages.where({ chatId }).last();
        // 如果最后一条是用户发的，就再次把那条消息的内容发给 AI
        if (lastMessage && lastMessage.sender === 'user') {
            showTypingIndicator();
            setOfflineSendLoading(true);
            sendOfflineMessageToAI(lastMessage.text);
            return;
        }
        showTypingIndicator();
        setOfflineSendLoading(true);
        sendOfflineMessageToAI('（请不要输出这句话）根据你的人设与当前剧情，对你上一条回复进行自然的补充或发展，让对话继续下去，注意语句不要重复。');

        return;
    }
    // 保存用户消息时，传入当前会话的ID (此时 currentOfflineSessionId 必定是正确的)
    await appendOfflineMessage('user', text, tempState.currentOfflineSessionId);
    await markOfflineContactExchangeReadyIfNeeded(
        AppState.characterProfiles.find(char => String(char.id) === String(chatId)),
        text
    );
    
    inputField.value = '';
    inputField.classList.remove('expanded'); // ▼▼▼ 新增：发送完消息后，让输入框自动缩回去
    showTypingIndicator(); 
    setOfflineSendLoading(true);
    sendOfflineMessageToAI(text);
}
/**
 * 初始化线下见面页面的所有功能和事件
 */
export function initOfflineModePage() {
    const moreButton = document.getElementById('offline-more-btn');
    const stopButton = document.getElementById('offline-stop-btn');
if (inputField) {
        // ▼▼▼ 新增：禁止苹果自带的双击屏幕放大手势，并开启 GPU 硬件加速防闪退崩溃 ▼▼▼
        inputField.style.touchAction = 'manipulation';
        inputField.style.transform = 'translate3d(0, 0, 0)';
        inputField.style.webkitTransform = 'translate3d(0, 0, 0)';
        inputField.style.backfaceVisibility = 'hidden';
        inputField.style.webkitBackfaceVisibility = 'hidden';
        // ▲▲▲ 新增结束 ▲▲▲

        // 1. 关闭自动完成，告诉浏览器不要提示信用卡/地址
        inputField.setAttribute('autocomplete', 'off');
        
        // 2. 给 name 属性设一个随机值或 meaningless 的值
        // 浏览器通常根据 name="cc-number" 等来判断，随机名能有效避开识别
        inputField.setAttribute('name', 'chat-input-offline-field');
        
        // 3. 关闭移动端的自动纠错和首字母大写，提升聊天体验
        inputField.setAttribute('autocorrect', 'off');
        inputField.setAttribute('autocapitalize', 'off');
        
        // 4. 指定类型为 search (搜索框极少触发卡包)，但通过 CSS 我们已经去掉了搜索框的默认样式
        inputField.setAttribute('type', 'search');
    }
     const scenarioTitle = document.getElementById('new-scenario-title');
    const scenarioContent = document.getElementById('new-scenario-content');
    [scenarioTitle, scenarioContent].forEach(el => {
        if (el) {
            el.setAttribute('autocomplete', 'off');
            el.setAttribute('autocorrect', 'off');
            el.setAttribute('autocapitalize', 'off');
            el.setAttribute('spellcheck', 'false');
            // 如果是普通的输入框，设为 search 类型可以有效避开浏览器的自动填充卡包
            if (el.tagName === 'INPUT') el.setAttribute('type', 'search');
        }
    });
    const currentChatId = tempState.currentChatId;
    if (currentChatId) {
        const storageKey = `offline_session_active_${currentChatId}`;
        
        // 【核心修复】：用异步函数包裹。如果缓存被清空（如更换设备、刚导入数据），去数据库底层深挖是否有未完成的约会！
        (async () => {
            let savedSessionId = localStorage.getItem(storageKey);
            
            // 缓存里没有？那就去查查聊天记录！
            if (!savedSessionId) {
                const lastMsg = await db.offlineMessages.where({ chatId: currentChatId }).last();
                // 如果最后一条消息有 sessionId...
                if (lastMsg && lastMsg.sessionId) {
                    // ...去卡片库里对一下，这张卡片生成了没有？如果没有，说明是在约会中途导出的！
                    const endedSession = await db.offlineSessions
                        .where({ chatId: currentChatId })
                        .filter(s => s.sessionId === lastMsg.sessionId)
                        .first();
                    const isEnded = !!endedSession;
                    
                    if (!isEnded) {
                        savedSessionId = lastMsg.sessionId;
                        localStorage.setItem(storageKey, savedSessionId); // 赶紧把缓存补回来
                        console.log(`[底层恢复] 成功从数据库深处找回未结束的约会！ID: ${savedSessionId}`);
                    }
                }
            }
            
            if (savedSessionId) {
                tempState.isDateActive = true;
                tempState.activeOfflineSession = currentChatId;
                tempState.currentOfflineSessionId = savedSessionId;
                console.log(`[初始化恢复] 检测到未结束的线下会话，状态已恢复。ID: ${savedSessionId}`);
            }
        })();
    }
    // 显示退出确认弹窗的函数
    function showExitConfirmationModal() {
        // 1. 获取当前角色和用户数据
        const character = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        const user = getCurrentChatIdentity();

        if (UI.exitConfirmation) {
            // 2. 处理【角色】的显示信息：优先用覆写设置
            const displayCharAvatar = character?.chatOverrideAvatar || character?.avatar || DEFAULT_AVATAR_SRC;
            const displayCharName = character?.chatOverrideName || character?.name || '角色';

            // 3. 处理【用户】的显示信息：优先用角色档案里存的用户覆写设置
            const displayUserAvatar = character?.chatOverrideUserAvatar || user?.avatar || DEFAULT_AVATAR_SRC;
            const displayUserName = character?.chatOverrideUserNickname || user?.name || '你';

            // 4. 更新弹窗 UI
            UI.exitConfirmation.charAvatar.src = displayCharAvatar;
            UI.exitConfirmation.charName.textContent = displayCharName;
            
            UI.exitConfirmation.userAvatar.src = displayUserAvatar;
            UI.exitConfirmation.userName.textContent = displayUserName;

            // 5. 显示弹窗
            UI.exitConfirmation.overlay.classList.add('visible');
        }
    }


    // 隐藏弹窗的函数
    function hideExitConfirmationModal() {
        if (UI.exitConfirmation) {
            UI.exitConfirmation.overlay.classList.remove('visible');
        }
    }

    if (stopButton) {
        stopButton.addEventListener('click', (event) => {
            event.preventDefault();
            showExitConfirmationModal();
        });
    }

  if (UI.exitConfirmation && !UI.exitConfirmation.cancelBtn.dataset.initialized) {
        UI.exitConfirmation.cancelBtn.addEventListener('click', hideExitConfirmationModal);
        UI.exitConfirmation.confirmBtn.addEventListener('click', () => {
            hideExitConfirmationModal();
            // 修改这里：明确传递当前的角色ID
            exitAndSummarize(tempState.currentChatId); 
        });
        UI.exitConfirmation.overlay.addEventListener('click', (event) => {
            if (event.target === UI.exitConfirmation.overlay) {
                hideExitConfirmationModal();
            }
        });
        UI.exitConfirmation.cancelBtn.dataset.initialized = 'true';
    }
    document.addEventListener('loadOfflineHistory', (e) => {
        if (e.detail && e.detail.chatId) {
            loadAndRenderHistory(e.detail.chatId);
            renderOfflineStatusBar(e.detail.chatId);
            refreshOfflineFriendRequestActionVisibility();
            applyOfflineStyles(); // 【新增】每次加载历史时，自动应用当前角色的专属样式和壁纸
        }
    });
    if (!offlineFriendRequestUpdateListenerBound) {
        window.addEventListener('looky:friend-request-updated', () => {
            refreshOfflineFriendRequestActionVisibility();
        });
        offlineFriendRequestUpdateListenerBound = true;
    }
   document.addEventListener('startOfflineFlow', (e) => {

        // 1. 确保在这个入口也初始化 SessionID (补办身份证)
        const currentChatId = tempState.currentChatId;
        // 如果当前没有活跃的 SessionID，或者内存状态未激活
        if (currentChatId && (!tempState.isDateActive || !tempState.currentOfflineSessionId)) {
             tempState.isDateActive = true;
             tempState.activeOfflineSession = currentChatId;
             
             // 创建一个新的 ID
             const newSessionId = `${currentChatId}-${Date.now()}`;
             tempState.currentOfflineSessionId = newSessionId;
             
             // 存入 LocalStorage 防止刷新丢失
             localStorage.setItem(`offline_session_active_${currentChatId}`, newSessionId);
             
             // 引入 state.js 的保存函数同步状态
             saveHybridStateToSession(); 
             console.log(`[邀约进入] 强制初始化 SessionID: ${newSessionId}`);
        }
        // 2. 显示“对方正在输入”的动画，增加沉浸感 (这也就是你要的等待动画)
        showTypingIndicator();
        
        // 3. 【核心修改】优先使用外部传入的自定义指令，如果没有才用默认的
        setOfflineSendLoading(true);
        const customPrompt = e.detail && e.detail.customPrompt;
             const startPrompt = customPrompt || `<系统指令：用户已接受邀约，场景已切换至线下模式。请根据之前的聊天上下文，立刻生成两人见面时的第一段环境与动作描写（使用第三人称小说风格）。请勿复述“用户接受了邀请”，直接开始描写见面场景。>`;
        
        // 4. 发送给AI
        sendOfflineMessageToAI(startPrompt);
        renderOfflineStatusBar(currentChatId);
        refreshOfflineFriendRequestActionVisibility();
        
        applyOfflineStyles(); // 【新增】接受邀约直接进入时，也要立即应用样式
    });
     // ▼▼▼ 新增线下自动总结检查函数 ▼▼▼
    async function checkAndTriggerOfflineSummary(targetCharId, responseSessionId = null) {
        // ▼▼▼ 修改：优先使用传过来的 ID ▼▼▼
        const charId = targetCharId || tempState.currentChatId;
        if (!charId) return;
        const char = AppState.characterProfiles.find(c => String(c.id) === String(charId));
        if (!char) return;
        const isAutoSummaryEnabled = char.autoSummaryEnabled !== false;
        const targetTurns = Math.max(1, Number.parseInt(char.offlineAutoSummaryTurns, 10) || 10);
        const currentTurn = Math.max(0, Number.parseInt(char.offlineTurnCounter, 10) || 0);
        const newTurn = currentTurn + 1;

        console.log(`--- Offline Conversation Turn Status ---`);
        console.log(`Character [${charId}]: ${newTurn} turns`);

        if (newTurn >= targetTurns) {
            if (isAutoSummaryEnabled) {
                 console.log(`%c[MEMORY SYSTEM] Offline Character [${charId}] reached ${newTurn} turns. Triggering summarization!`, 'color: #4CAF50; font-weight: bold;');
                
                const lastSummaryTime = Number(char.offlineLastSummaryTime) || 0;
                const recentRawMessages = await db.offlineMessages
                    .where('chatId')
                    .equals(charId)
                    .toArray();

                // 只用真正的总结书签判断“是否已经总结过”。
                // 历史记录分隔线可能在总结请求前就已经写入，不能把它当成总结成功的证明。
                const activeSessionId = responseSessionId || tempState.currentOfflineSessionId;

                const safeMessages = recentRawMessages
                    .filter(msg => {
                        const messageTime = new Date(msg.timestamp).getTime();
                        if (!Number.isFinite(messageTime) || messageTime <= lastSummaryTime) return false;
                        if (!activeSessionId) return true;
                        return String(msg.sessionId) === String(activeSessionId);
                    })
                    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

                if (safeMessages.length > 0) {

                    const realDatabaseBuffer = safeMessages
                        .filter(msg => msg.sender !== 'system' && msg.contentType !== 'friend_request_bar')
                        .map(msg => ({
                            role: msg.sender === 'user' ? 'user' : 'assistant',
                            content: msg.text || msg.content || '',
                            timestamp: msg.timestamp
                        })).filter(m => m.content.trim() !== '');

                    const user = getCurrentChatIdentity();
                    let userNameForMemory = user ? user.name : '用户';
                    if (!user && AppState.userIdentities.length > 0) {
                        userNameForMemory = AppState.userIdentities[0].name;
                    }
                    let summaryResult;
                    if (char.isGroup) {
                        const { summarizeGroupMemory } = await import('./memory.js');
                        summaryResult = await summarizeGroupMemory(
                            charId,
                            realDatabaseBuffer,
                            userNameForMemory,
                            null,
                            { type: 'offline', sessionId: responseSessionId || tempState.currentOfflineSessionId }
                        );
                    } else {
                        const { summarizeAndArchiveMemory } = await import('./memory.js');
                        summaryResult = await summarizeAndArchiveMemory(charId, realDatabaseBuffer, userNameForMemory, char.name, { type: 'offline', sessionId: responseSessionId || tempState.currentOfflineSessionId });
                    }
                    if (summaryResult?.skipped) {
                        console.warn(`[MEMORY SYSTEM] 线下总结内容已由另一个相同请求处理，本次不推进线下书签。`);
                        return;
                    }
                    if (!summaryResult || summaryResult.success === false) {
                        console.warn(`[MEMORY SYSTEM] 线下总结失败，本轮不推进书签，等待下一轮重试。`);
                        return;
                    }

                    const latestMsgTime = safeMessages[safeMessages.length - 1].timestamp;

                    await db.characterProfiles.update(charId, {
                        offlineLastSummaryTime: new Date(latestMsgTime).getTime(),
                        offlineTurnCounter: 0
                    });
                    char.offlineLastSummaryTime = new Date(latestMsgTime).getTime();
                    char.offlineTurnCounter = 0;
                } else {
                    console.log(`[MEMORY SYSTEM] 线下此区间的话已被总结或删除，安全跳过。`);
                    await db.characterProfiles.update(charId, { offlineTurnCounter: 0 });
                    char.offlineTurnCounter = 0;
                }
            } else {
                await db.characterProfiles.update(charId, { offlineTurnCounter: 0 });
                char.offlineTurnCounter = 0;
            }
        } else {
            await db.characterProfiles.update(charId, { offlineTurnCounter: newTurn });
            char.offlineTurnCounter = newTurn;
        }
    }
    document.addEventListener('offline_ai_streaming_chunk', (e) => {
        const { accumulatedText, chatId } = e.detail || {};
        if (!accumulatedText || !chatId) return;
        // 只有在用户正在查看这个角色的聊天时才渲染
        if (String(chatId) !== String(tempState.currentChatId)) return;

        // 第一个 chunk 到达：移除打字动画，创建流式预览卡片
        if (!offlineStreamingCard || offlineStreamingChatId !== chatId) {
            destroyOfflineStreamingState();
            hideTypingIndicator();
            const card = createOfflineStreamingCard(chatId);
            messageList.appendChild(card);
            offlineStreamingCard = card;
            offlineStreamingChatId = chatId;
        }

        // 合并高频 SSE 片段，避免每帧都重新解析整段累计文本。
        offlineStreamingLatestText = accumulatedText;
        if (!offlineStreamingRafId) {
            const elapsed = performance.now() - offlineStreamingLastPaintAt;
            const delay = Math.max(0, OFFLINE_STREAM_PREVIEW_INTERVAL - elapsed);
            offlineStreamingRafId = window.setTimeout(() => {
                offlineStreamingRafId = 0;
                if (!offlineStreamingCard) return;
                updateOfflineStreamingCardContent(offlineStreamingCard, offlineStreamingLatestText);
                offlineStreamingLastPaintAt = performance.now();
                // 更新后只滚动一次，避免生成期间反复触发布局计算。
                if (!offlineStreamingCard._scrollThrottle) {
                    offlineStreamingCard._scrollThrottle = true;
                    window.setTimeout(() => {
                        if (!offlineStreamingCard) return;
                        scrollToBottomOffline();
                        offlineStreamingCard._scrollThrottle = false;
                    });
                }
            }, delay);
        }
    });
    document.addEventListener('offline_ai_response', async (e) => {
        // ▼▼▼ 核心修复：使用事件传过来的锁定 ID，而不是全局当前 ID ▼▼▼
    const { text, chatId, sessionId } = e.detail || {};
    if (!chatId) return;
    if (!text) {
        const existingStreamCard = document.getElementById('offline-streaming-card');
        if (existingStreamCard) existingStreamCard.remove();
        destroyOfflineStreamingState();
        if (String(chatId) === String(tempState.currentChatId)) {
            hideTypingIndicator();
            setOfflineSendLoading(false);
        }
        return;
    }
        // 回复完成时清理旧的长按遮罩，避免系统手势中断后继续挡住页面。
        hideMessageActionPopover();
        // ▼▼▼ 流式清理：完整回复已到达，移除可能存在的流式预览卡片 ▼▼▼
        const existingStreamCard = document.getElementById('offline-streaming-card');
        if (existingStreamCard) existingStreamCard.remove();
        destroyOfflineStreamingState();
        // ▲▲▲ 流式清理结束 ▲▲▲
        let activeStatusTemplate = null;
        try {
            const statusState = await readOfflineStatusState(chatId);
            activeStatusTemplate = getActiveOfflineStatusTemplate(statusState.config);
        } catch (error) {
            console.warn('[offline status] template read skipped:', error);
        }
        const statusResult = extractOfflineStatusBlock(text, activeStatusTemplate);
        if (statusResult.status) {
            await persistOfflineStatusUpdate(chatId, statusResult.status);
        }
        const friendRequestResult = extractOfflineFriendRequestMarker(statusResult.text);
        let messageText = friendRequestResult.text;

        // 如果回复正好属于当前屏幕的角色，才隐藏打字动画
        if (String(chatId) === String(tempState.currentChatId)) {
            hideTypingIndicator();
            setOfflineSendLoading(false);
        }
        // 把数据存入对应角色的名下
        const trimmed = String(messageText || '').trim();
        const requestChar = AppState.characterProfiles.find(char => String(char.id) === String(chatId));
        await markOfflineContactExchangeReadyIfNeeded(requestChar, messageText);
        const shouldRenderFriendRequestInline = friendRequestResult.hasMarker
            && !e.detail.isError
            && requestChar
            && hasOfflineContactExchangeIntent(messageText)
            && shouldShowOfflineFriendRequestAction(requestChar)
            && !hasPendingOfflineFriendRequest(requestChar);
    if (!trimmed && !friendRequestResult.hasMarker) {
        messageText = '……';
    }
        if (!trimmed && friendRequestResult.hasMarker) {
            if (!hasOfflineContactExchangeIntent(messageText)) return;
            const requestMessage = buildOfflineFriendRequestMessage(requestChar, '');
            const request = await createOfflineCharToUserFriendRequest(
                requestChar,
                requestMessage,
                'offline_ai_marker'
            );
            if (request) {
                await appendOfflineFriendRequestBarMessage(chatId, 'character', requestMessage, 'char_to_user', sessionId);
            }
            return;
        }
        const looksLikeHtml = trimmed.includes('[HTML_SNIPPET]') || /<(style|div|html|svg|iframe)[\s>]/i.test(trimmed);
        const messageData = {
            chatId: chatId,
            sender: 'character',
            text: messageText,
            timestamp: new Date(),
            sessionId: sessionId || null,
            ...(statusResult.status ? {
                offlineStatus: statusResult.status,
                offlineStatusUnread: true
            } : {}),
            ...(shouldRenderFriendRequestInline ? {
                offlineFriendRequestInline: true,
                friendRequestDirection: 'char_to_user'
            } : {}),
            ...(looksLikeHtml ? { contentType: 'html_snippet' } : {})
        };
        messageData.id = await db.offlineMessages.add(messageData);

        // 如果当前依然留在这个角色的聊天界面，才将消息渲染上墙
        if (String(chatId) === String(tempState.currentChatId)) {
            renderMessage(messageData);
            scrollToBottomOffline();
        }

        // 触发线下自动总结检查
        await checkAndTriggerOfflineSummary(chatId, sessionId);
        if (shouldRenderFriendRequestInline) {
            const requestMessage = buildOfflineFriendRequestMessage(requestChar, messageText);
            await createOfflineCharToUserFriendRequest(
                requestChar,
                requestMessage,
                'offline_ai_marker'
            );
        }
               // ▼▼▼ 新增：只有AI成功回复（没有报错）时，才扣除线下导向的寿命 ▼▼▼
        if (!e.detail.isError) {
            try {
                const rawDir = localStorage.getItem(`offline_direction_${chatId}`);
                if (rawDir) {
                    let dirData = JSON.parse(rawDir);
                    if (dirData.turnsLeft > 0) {
                        dirData.turnsLeft -= 1;
                        if (dirData.turnsLeft <= 0) {
                            localStorage.removeItem(`offline_direction_${chatId}`); // 用完销毁
                            console.log(`[线下独立导向] 5轮寿命耗尽，已自动清除`);
                        } else {
                            localStorage.setItem(`offline_direction_${chatId}`, JSON.stringify(dirData));
                        }
                    }
                }
            } catch (err) {
                console.error('[线下导向] 处理寿命扣减失败', err);
            }
        }
        // ▲▲▲ 修复结束 ▲▲▲
    });
    // 绑定发送事件
    sendButton.addEventListener('click', sendMessage);

    // ▼▼▼ 新增：监听输入框的点击，通过时间差判断双击，展开或收缩输入框 ▼▼▼
    let lastInputClickTime = 0;
    inputField.addEventListener('click', (e) => {
        const currentTime = new Date().getTime();
        // 两次点击间隔小于400毫秒就算作双击
        if (currentTime - lastInputClickTime < 400) {
            inputField.classList.toggle('expanded'); // 加上或去掉变大的样式
            lastInputClickTime = 0; // 重置时间
        } else {
            lastInputClickTime = currentTime;
        }
    });
    // ▲▲▲ 新增结束 ▲▲▲

    let lastEnterTime = 0; // 用来记录上一次按回车的时间
    inputField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const currentTime = new Date().getTime();
            // 如果两次按回车间隔小于 400 毫秒，且不是长按不放
            if (currentTime - lastEnterTime < 400) {
                e.preventDefault(); // 阻止第二次回车的换行
                sendMessage();      // 发送消息
                lastEnterTime = 0;  // 重置时间
            } else {
                // 如果是第一次按，或者是慢速按，就记录时间，允许默认的换行行为
                lastEnterTime = currentTime;
            }
        }
    });
    // 菜单按钮逻辑保持不变

    const actionMenu = document.getElementById('offline-action-menu');
    const floatingMoreBtn = document.getElementById('offline-floating-more-btn'); // ▼▼▼ 获取悬浮按钮
    
    // ▼▼▼ 给悬浮按钮也绑定打开菜单的功能
    if (floatingMoreBtn && actionMenu) {
        floatingMoreBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            actionMenu.classList.toggle('show');
        });
    }

    if (moreButton && actionMenu) {
        moreButton.addEventListener('click', (event) => {
            event.stopPropagation();
            actionMenu.classList.toggle('show');
        });
        actionMenu.addEventListener('click', (event) => {
            const item = event.target.closest('.action-menu-item');
            if (!item) return;
            const action = item.dataset.action;
            if (action === 'history') {
                openHistoryModal();
            } else if (action === 'settings') {
               openOfflineSettingsModal(); 
            } else if (action === 'friend-request') {
               handleOfflineFriendRequestAction();
            } else if (action === 'scenarios') { // ▼▼▼ 新加的这行
               openScenarioManagerModal();       // ▼▼▼ 新加的这行
            } else if (action === 'offline-status') {
               if (tempState.currentChatId) {
                   openOfflineStatusConfigEditor(tempState.currentChatId);
               } else {
                   showDynamicIsland('\u8bf7\u5148\u8fdb\u5165\u4e00\u4e2a\u7ebf\u4e0b\u4f1a\u8bdd');
               }
            } else if (action === 'manual-summary') { 
               // ▼▼▼ 新增：打开手动总结弹窗，并默认选定线下模式
               const modal = document.getElementById('manual-summary-modal-overlay');
               if (modal) {
                   const sourceSelect = document.getElementById('manual-summary-source-select');
                   if (sourceSelect) {
                       sourceSelect.value = 'offline';
                       sourceSelect.dispatchEvent(new Event('change'));
                   }
                   modal.classList.add('visible');
               }
               // ▲▲▲ 新增结束
                         // ▼▼▼ 新增：处理线下独有的导向与OOC功能 ▼▼▼
            } else if (action === 'offline-guide' || action === 'offline-ooc') {
                const isOoc = action === 'offline-ooc';
                showInputModal(
                    isOoc ? '线下OOC修正' : '输入线下剧情导向',
                    isOoc ? '指出角色的OOC之处，AI将在接下来调整：' : '例如：接下来让剧情发生什么转折？',
                    (val) => {
                        if (!val) return;
                        setTimeout(() => showInputModal({
                            title: '设置有效轮数',
                            initialValue: '5',
                            placeholder: '请输入 1 到 50 的整数',
                            isTextarea: false
                        }).then((turnsInput) => {
                            const turns = Math.max(1, Math.min(50, parseInt(turnsInput || '5', 10) || 5));
                            const charId = tempState.currentChatId;
                            const existing = JSON.parse(localStorage.getItem(`offline_direction_${charId}`) || '{"text":"","turnsLeft":0}');
                            const newText = isOoc
                                ? (existing.text ? existing.text + ` [强烈注意修正：${val}]` : `[强烈注意修正：${val}]`)
                                : val;
                            localStorage.setItem(`offline_direction_${charId}`, JSON.stringify({ text: newText, turnsLeft: turns }));
                            showDynamicIsland(`${isOoc ? '线下修正' : '线下导向'}已设定(${turns}轮有效)`, 'success');
                        }), 0);
                    },
                    { isTextarea: true }
                );
            } else if (action === 'ifline') {
               // ▼▼▼ 修改：IF线先打开剧场列表 ▼▼▼
               document.dispatchEvent(new CustomEvent('renderIflineListEvent')); // 派发事件让列表刷新数据
               const modal = document.getElementById('ifline-list-modal');
               if (modal) {
                   modal.style.display = 'flex';
                   setTimeout(() => { modal.style.opacity = '1'; }, 10);
               }
               // ▲▲▲ 修改结束
            }
            actionMenu.classList.remove('show');

        });
        document.addEventListener('clearOfflineHistoryRequest', clearOfflineHistory);
        window.addEventListener('click', () => {
            if (actionMenu.classList.contains('show')) {
                actionMenu.classList.remove('show');
            }
        });
    }
    
    // 绑定“加载更多”按钮事件
    messageList.addEventListener('click', async (event) => {
        const statusTrigger = event.target.closest('.offline-card-status-trigger');
        if (statusTrigger) {
            const card = statusTrigger.closest('.offline-message-card');
            const panel = card?.querySelector('.offline-card-status-panel');
            if (!card || !panel) return;
            const willOpen = panel.hidden;
            if (willOpen) {
                await hydrateOfflineCardStatus(card, {
                    chatId: card._offlineStatusChatId || tempState.currentChatId,
                    sender: 'character',
                    offlineStatus: card._offlineStatusSnapshot,
                    timestamp: card._offlineStatusTimestamp
                }, null, { force: true });
            }
            panel.hidden = !willOpen;
            statusTrigger.setAttribute('aria-expanded', String(willOpen));
            const unreadDot = statusTrigger.querySelector('.offline-card-status-dot');
            if (willOpen && unreadDot) {
                unreadDot.remove();
                const messageId = Number(card.dataset.id);
                if (Number.isFinite(messageId)) {
                    db.offlineMessages.update(messageId, { offlineStatusUnread: false }).catch(() => {});
                }
            }
            return;
        }
        const statusConfigButton = event.target.closest('.offline-card-status-config');
        if (statusConfigButton) {
            const card = statusConfigButton.closest('.offline-message-card');
            openOfflineStatusConfigEditor(card?._offlineStatusChatId || tempState.currentChatId);
            return;
        }
        const statusItem = event.target.closest('.offline-card-status-item[data-status-key]');
        if (statusItem) {
            const card = statusItem.closest('.offline-message-card');
            const key = statusItem.dataset.statusKey;
            if (!card || !key) return;
            const currentValue = String(card._offlineStatusSnapshot?.[key] || '');
            showInputModal(statusItem.querySelector('small')?.textContent || key, currentValue, async value => {
                if (value === null) return;
                const nextStatus = { ...(card._offlineStatusSnapshot || {}), [key]: String(value).trim() };
                card._offlineStatusSnapshot = nextStatus;
                const valueElement = statusItem.querySelector('strong');
                if (valueElement) valueElement.textContent = nextStatus[key] || '--';
                const messageId = Number(card.dataset.id);
                if (Number.isFinite(messageId)) {
                    await db.offlineMessages.update(messageId, { offlineStatus: nextStatus });
                }
            });
            return;
        }
        const loadMoreButton = event.target.closest('.btn-load-more');
        if (!loadMoreButton) return;
        
        event.preventDefault(); 
        const chatId = loadMoreButton.parentElement.dataset.conversationId;
        if (chatId) {
            renderOlderOfflineMessages(chatId, loadMoreButton);
        }
    });
}
let activeMessagePopover = null; // 用来追踪当前显示的菜单
let activePopoverOverlay = null; // 新增：用来追踪全屏透明遮罩层

// 安卓系统手势（例如三指截图）接管触摸时，浏览器可能只发出 cancel 事件，
// 不再补发 pointerup/click。这里统一清理线下长按菜单，避免透明遮罩残留。
function recoverOfflinePopoverAfterSystemGesture() {
    if (!activeMessagePopover && !activePopoverOverlay) return;
    hideMessageActionPopover();
}

document.addEventListener('pointercancel', recoverOfflinePopoverAfterSystemGesture, { capture: true, passive: true });
document.addEventListener('touchcancel', recoverOfflinePopoverAfterSystemGesture, { capture: true, passive: true });
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') recoverOfflinePopoverAfterSystemGesture();
});
window.addEventListener('pagehide', recoverOfflinePopoverAfterSystemGesture, { passive: true });

/**
 * 隐藏当前显示的菜单
 */
function hideMessageActionPopover() {
    const popoverToRemove = activeMessagePopover;
    if (popoverToRemove) popoverToRemove.classList.remove('visible');
    activeMessagePopover = null;
    // ▼▼▼ 清理遮罩层 ▼▼▼
    if (activePopoverOverlay) {
        activePopoverOverlay.remove();
        activePopoverOverlay = null;
    }
    if (popoverToRemove) {
        setTimeout(() => popoverToRemove.remove(), 200);
    }
}

/**
 * 为线下模式的消息卡片创建并显示长按菜单
 * @param {HTMLElement} messageCard 被长按的消息卡片元素
 */
function showOfflineMessagePopover(messageCard) {
    hideMessageActionPopover(); // 先关掉旧的

    const messageId = messageCard.dataset.id;
    const isAIMessage = messageCard.classList.contains('is-character');
    // 决定菜单里有哪些按钮
    const actions = isAIMessage 
        ? ['delete', 'edit', 'retry'] 
        : ['delete', 'edit'];

    // ▼▼▼ 新增：添加一层看不见的全屏玻璃，点在这块玻璃上就直接关掉菜单 ▼▼▼
    activePopoverOverlay = document.createElement('div');
    activePopoverOverlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 999; touch-action: none;';
    const closeOverlay = (e) => {
        e.stopPropagation();
        e.preventDefault();
        hideMessageActionPopover();
    };
    activePopoverOverlay.addEventListener('pointerdown', closeOverlay, { capture: true });
    activePopoverOverlay.addEventListener('click', closeOverlay, { capture: true });
    activePopoverOverlay.addEventListener('pointercancel', closeOverlay, { capture: true, passive: false });
    activePopoverOverlay.addEventListener('touchcancel', closeOverlay, { capture: true, passive: false });
    UI.phoneScreen.appendChild(activePopoverOverlay);

    const popover = document.createElement('div');
    popover.className = 'message-action-popover'; // 复用 chat-ui 的样式
    popover.style.zIndex = '1000'; // 确保菜单在这块玻璃之上
    activeMessagePopover = popover;

    
    // 根据 actions 动态创建按钮
    let popoverHTML = '';
    const actionTemplates = {
        edit: `<div class="popover-button" data-action="edit"><span>修改</span></div>`,
        retry: `<div class="popover-button" data-action="retry"><span>重回</span></div>`,
        delete: `<div class="popover-button delete" data-action="delete"><span>删除</span></div>`
    };

    actions.forEach((action, index) => {
        if (actionTemplates[action]) {
            popoverHTML += actionTemplates[action];
            if (actions.length > 1 && index < actions.length - 1) {
                popoverHTML += `<div class="popover-divider"></div>`;
            }
        }
    });

    popover.innerHTML = popoverHTML;
    UI.phoneScreen.appendChild(popover); // 把它添加到手机屏幕上

    // --- 定位菜单 ---
    const cardRect = messageCard.getBoundingClientRect();
    const phoneRect = UI.phoneScreen.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();

    let left = cardRect.left - phoneRect.left + (cardRect.width / 2) - (popoverRect.width / 2);
    let top = cardRect.top - phoneRect.top - popoverRect.height - 10; // 默认在上方

    if (left < 10) left = 10;
    if (left + popoverRect.width > phoneRect.width - 10) left = phoneRect.width - popoverRect.width - 10;
    if (top < 10) { // 如果上方空间不够，就放到下方
        top = cardRect.bottom - phoneRect.top + 10;
        popover.classList.add('popover-place-below');
    }
    
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    
    // 动画效果
    setTimeout(() => popover.classList.add('visible'), 10);

    // --- 绑定事件 ---
    popover.addEventListener('click', (e) => {
        const button = e.target.closest('.popover-button');
        if (!button) return;
        const action = button.dataset.action;
        
        // 调用统一的动作处理器
        handleOfflineMenuAction(action, messageId);
        hideMessageActionPopover();
    });
}
/**
 * 删除一条线下消息
 * @param {string} messageId 消息ID
 */
async function deleteOfflineMessage(messageId) {
    // 从dataset获取的id是字符串，数据库需要数字
    const numericId = Number(messageId);
    if (isNaN(numericId)) return;
    // 1. 从数据库删除
    await db.offlineMessages.delete(numericId);
    // 2. 从界面上移除对应的卡片
    const messageCard = document.querySelector(`.offline-message-card[data-id="${messageId}"]`);
    if (messageCard) {
        messageCard.remove();
    }
    
    // 3. 给用户一个反馈
    showDynamicIsland('已删除');
}
// ▼▼▼【使用这个新版本的函数】▼▼▼
/**
 * 编辑一条线下消息（使用弹窗）
 * @param {string} messageId 消息ID
 */
async function editOfflineMessage(messageId) {
    const numericId = Number(messageId);
    if (isNaN(numericId)) return;

    // 1. 先从数据库获取当前的消息内容
    const message = await db.offlineMessages.get(numericId);
    if (!message) {
        showDynamicIsland('消息不存在');
        return;
    }

    // 2. 调用 showInputModal 来显示弹窗
    showInputModal(
        '编辑消息',      // 弹窗的标题
       message.text,    // 输入框的当前内容
        async (newText) => { // 这是用户点击“确认”后要执行的函数
            // 【在这里加上安全检查！】如果用户点击了取消，newText会是null，此时直接返回。
            if (newText === null) {
                return;
            }
             const trimmedText = newText.trim();
            // 如果内容有变化，才执行更新
            if (trimmedText && trimmedText !== message.text) {
                await db.offlineMessages.update(numericId, { text: trimmedText });
                
                // ▼▼▼ 修复苹果渲染一半的Bug：改为局部精准更新，不再清空重绘整个列表 ▼▼▼
                const messageCard = document.querySelector(`.offline-message-card[data-id="${messageId}"]`);
                if (messageCard) {
                    const prose = messageCard.querySelector('.offline-prose');
                    if (prose) {
                        const extracted = extractHtmlAndText(trimmedText);
                        prose.innerHTML = processOfflineMessageSafely(extracted.text);
                        prepareOfflineMessageCollapse(messageCard);
                    }
                }
                // ▲▲▲ 修复结束 ▲▲▲
                
                showDynamicIsland('修改成功');
            }
        },

        { isTextarea: true } // 这是一个选项，让输入框变成多行的文本域，方便编辑长消息
    );
}

/**
 * “重回”功能：删除此条及之后的所有消息，并让AI重新回答
 * @param {string} messageId AI消息的ID
 */
async function retryOfflineAIMessage(messageId) {
    const numericId = Number(messageId);
    if (isNaN(numericId)) return;
    const chatId = tempState.currentChatId;
    if (!chatId) return;

    // 只读取当前消息之后的记录和它前面最近的一条记录，避免重回时加载整段历史。
    const messagesToDelete = await db.offlineMessages
        .where('chatId')
        .equals(chatId)
        .and(message => Number(message.id) >= numericId)
        .toArray();
    const userPromptMessage = await db.offlineMessages
        .where('id')
        .below(numericId)
        .reverse()
        .filter(message => String(message.chatId) === String(chatId))
        .first();

    // 如果没找到目标消息，或者它前面没有可用消息，就无法重回。
    if (!messagesToDelete.some(message => Number(message.id) === numericId) || !userPromptMessage) {
        showDynamicIsland('无法从此条消息重回');
        return;
    }
    const idsToDelete = messagesToDelete.map(m => m.id);
    // 执行删除
    await db.offlineMessages.bulkDelete(idsToDelete);
    // 从界面上批量移除，避免每条消息都重新查询一次 DOM。
    const idsToDeleteSet = new Set(idsToDelete.map(String));
    messageList.querySelectorAll('.offline-message-card[data-id]').forEach(card => {
        if (idsToDeleteSet.has(String(card.dataset.id))) card.remove();
    });
    // 显示“正在输入”并重新调用AI
    showTypingIndicator();
    sendOfflineMessageToAI(userPromptMessage.text);
}
/**
 * 统一处理菜单按钮的点击事件
 * @param {string} action 'delete', 'edit', 或 'retry'
 * @param {string} messageId 消息的ID
 */
function handleOfflineMenuAction(action, messageId) {
    // ▼▼▼【修改 switch 内部的调用】▼▼▼
    switch (action) {
        case 'delete':
            deleteOfflineMessage(messageId);
            break;
        case 'edit':
            editOfflineMessage(messageId);
            break;
        case 'retry':
            retryOfflineAIMessage(messageId);
            break;
    }
}

/**
 * 为单个消息卡片设置长按监听
 * @param {HTMLElement} targetElement 消息卡片
 */
function setupLongPressForOffline(targetElement) {
    // ▼▼▼ 【发热修复核心】在绑定新事件前，先把挂在元素上的旧事件监听器全部“杀死”！▼▼▼
    if (targetElement._longPressHandlers) {
        targetElement.removeEventListener('pointerdown', targetElement._longPressHandlers.down);
        targetElement.removeEventListener('pointerup', targetElement._longPressHandlers.up);
        targetElement.removeEventListener('pointerleave', targetElement._longPressHandlers.up);
        targetElement.removeEventListener('pointercancel', targetElement._longPressHandlers.up);
        targetElement.removeEventListener('touchmove', targetElement._longPressHandlers.up);
        targetElement.removeEventListener('click', targetElement._longPressHandlers.click, { capture: true });
        targetElement.removeEventListener('contextmenu', targetElement._longPressHandlers.contextmenu);
    }
    // ▲▲▲ 修复核心结束 ▲▲▲

    let longPressTimer = null;
    let longPressFired = false;

    const handlePointerDown = (e) => {
        if (e.button !== 0) return; 
        longPressFired = false;
        longPressTimer = setTimeout(() => {
            showOfflineMessagePopover(targetElement);
            longPressFired = true;
            longPressTimer = null; 
        }, 500);
    };

    const handlePointerUpOrLeave = () => {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    };

    const handleClick = (e) => {
        if (longPressFired) {
            e.preventDefault();
            e.stopPropagation();
        }
    };

    // ▼▼▼ 【发热修复核心】把事件处理函数存到元素自己身上，方便下次“杀死”它们 ▼▼▼
    const handleContextMenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        return false;
    };

    targetElement._longPressHandlers = {
        down: handlePointerDown,
        up: handlePointerUpOrLeave,
        click: handleClick,
        contextmenu: handleContextMenu
    };
    // ▲▲▲ 修复核心结束 ▲▲▲

    targetElement.addEventListener('pointerdown', handlePointerDown);
    targetElement.addEventListener('pointerup', handlePointerUpOrLeave);
    targetElement.addEventListener('pointerleave', handlePointerUpOrLeave);
    targetElement.addEventListener('pointercancel', handlePointerUpOrLeave);
    targetElement.addEventListener('touchmove', handlePointerUpOrLeave, { passive: true });
    targetElement.addEventListener('click', handleClick, { capture: true });
    targetElement.addEventListener('contextmenu', handleContextMenu);
}
/* ==========================================================================
   ▼▼▼ 【新增】历史记录弹窗的核心逻辑 ▼▼▼
   ========================================================================== */

/**
 * 打开历史记录弹窗的总指挥函数
 */
async function openHistoryModal() {
  if (!tempState.currentChatId) return;
  try {
    // 1. 从新的 offlineSessions 表获取所有“约会总结”
    const allSessions = await db.offlineSessions
      .where({ chatId: tempState.currentChatId })
      .sortBy('startTime');
    allSessions.reverse(); // 【安全修复】：将倒序动作移出数据库底层，防止引擎报错
    
    // 2. 调用新的渲染函数

    await renderHistorySessions(allSessions);
    
    // 3. 显示弹窗
    showHistoryModal();
  } catch (error) {
    console.error("打开历史记录失败:", error);
    showDynamicIsland("无法加载历史记录", "error");
  }
}
/**
 * 把“约会总结”数据渲染成可折叠的卡片
 */
async function renderHistorySessions(sessions) {
  if (!historyModalContent) return;

  // ▼▼▼ 性能监测 1：开始记录弹窗渲染耗时 ▼▼▼
  console.time('[性能监测] 渲染历史记录弹窗总耗时');

  if (!sessions || sessions.length === 0) {
    historyModalContent.innerHTML = '<p style="text-align: center; color: #999; padding: 20px 0;">暂无历史记录</p>';
    console.timeEnd('[性能监测] 渲染历史记录弹窗总耗时'); // 结束计时
    return;
  }

  const character = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
  const user = getCurrentChatIdentity();
  let containerHtml = '<div class="history-sessions-container">';
  for (const session of sessions) {
    // ▼▼▼ 【安全修复1】：加上安全保护，防止老数据时间损坏导致整个弹窗崩溃 ▼▼▼
    let date = '未知时间';
    try {
        if (session.startTime) {
            const d = new Date(session.startTime);
            if (!isNaN(d.getTime())) {
                date = d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
            }
        }
    } catch (e) { console.warn('日期解析兜底触发'); }
    // ▲▲▲ 修改结束 ▲▲▲

    console.time(`[性能监测] 查询卡片 ${session.id} 的消息耗时`);
     // 【核心修复】：优先使用 sessionId 精确抓取，彻底无视时间戳是否在导入时损坏。
    // 为了防止你以前的老数据（没有sessionId的卡片）打不开，我加了兜底的时间比对逻辑，新老兼容，万无一失。
    let detailedMessages = [];
    let startMs = 0; // 【修改】提前在这里声明变量，让外面的代码也能看到
    let endMs = 0;   // 【修改】提前声明
    if (session.sessionId) {
        detailedMessages = await db.offlineMessages
            .where({ chatId: session.chatId })
            .and(msg => msg.sessionId === session.sessionId)
            .toArray();
    } else {
        startMs = (new Date(session.startTime).getTime() || 0) - 60000; // 【修改】去掉 const
        endMs = (new Date(session.endTime).getTime() || Date.now()) + 60000; // 【修改】去掉 const
        detailedMessages = await db.offlineMessages
            .where({ chatId: session.chatId })
            .and(msg => {
                if (!msg || !msg.timestamp) return false; 
                const msgTime = new Date(msg.timestamp).getTime();
                if (isNaN(msgTime)) return false; 
                return msgTime >= startMs && msgTime <= endMs;
            })
            .toArray();
    }

    console.timeEnd(`[性能监测] 查询卡片 ${session.id} 的消息耗时`);

    // 如果这段对话找出来的消息是0条，在控制台报警，告诉我们是哪个时间的卡片坏了
    if (detailedMessages.length === 0) {
        // 【修改】加入判断，防止有 sessionId 的新数据找不到时间变量而报错崩溃
        if (session.sessionId) {
            console.warn(`[空白卡片警报] 卡片(ID:${session.id})查出 0 条消息！(按SessionID精确查找)`);
        } else {
            console.warn(`[空白卡片警报] 卡片(ID:${session.id})查出 0 条消息！时间范围：${new Date(startMs).toLocaleString()} 至 ${new Date(endMs).toLocaleString()}`);
        }
    }

    // ▲▲▲ 终极修复结束 ▲▲▲

     const detailHtml = detailedMessages.map(msg => {

        // ▼▼▼ 【核心修改 4】应用统一的安全过滤，解决弹窗内容带有<thinking>并且引起闪退的问题 ▼▼▼
        const processedText = processOfflineMessageSafely(msg.text);
        // ▲▲▲ 修正结束 ▲▲▲
        return `
            <div class="history-record-item">
                <!-- ▼▼▼ 【安全修复2】：给 user 和 character 加上 ? 号，防止数据为空时发生致命读取错误 ▼▼▼ -->
                <span class="record-sender">${msg.sender === 'user' ? (user?.name || '你') : (character?.name || '对方')}:</span>
                <div class="record-text">${processedText}</div>
            </div>
        `;

    }).join('');



    containerHtml += `
      <details class="history-session-card" data-session-id="${session.id}">
        <summary class="session-summary">
          <div class="session-avatars">
            <img src="${user?.avatar || DEFAULT_AVATAR_SRC}" class="session-avatar" alt="user avatar">
            <img src="${character?.avatar || DEFAULT_AVATAR_SRC}" class="session-avatar" alt="char avatar">
          </div>
          <div class="session-preview">
            <p class="preview-text">${escapeHTML(session.previewText)}</p>
            <span class="preview-time">${date}</span>
          </div>
        </summary>
        <div class="session-detail-content">
          ${detailHtml}
        </div>
      </details>
    `;
  }
  
  containerHtml += '</div>';
  historyModalContent.innerHTML = containerHtml;
}

/**
 * 【最终安全版】清空当前角色的线下历史记录，并精准清除相关的AI记忆。
 */
async function clearOfflineHistory() {
  // 1. 弹出更精确的确认框
  if (!confirm('此操作将永久删除该角色的所有线下聊天记录、约会卡片【及相关的AI记忆】，但不会影响线上聊天记忆。确定清空吗？')) {
    return;
  }

  const chatId = tempState.currentChatId;
  if (!chatId) return; 

  try {
    // 2. 【第一步：清除记忆】调用记忆模块，精准清除所有源自线下的AI记忆
    // 这一步必须在删除 offlineSessions 记录之前执行！
    const { clearOfflineGeneratedMemories } = await import('./memory.js');
    await clearOfflineGeneratedMemories(chatId);
    
    // 3. 【第二步：删除记录】删除所有相关的约会总结卡片
    await db.offlineSessions.where({ chatId: chatId }).delete();
    
    // 4. 【第三步：删除消息】删除所有相关的线下聊天消息
    await db.offlineMessages.where({ chatId: chatId }).delete();
    
    // 5. 更新UI
    if (historyModalContent) {
        historyModalContent.innerHTML = '<p style="text-align: center; color: #999; padding: 20px 0;">记录已清空</p>';
    }
    if (messageList) {
        messageList.innerHTML = '';
    }
    
    // 6. 给出最终的、更准确的反馈
    showDynamicIsland('所有线下记录及相关记忆已清空');

  } catch (error) {
      console.error(`清空角色 ${charId} 的历史记录时出错:`, error);
      showDynamicIsland('操作失败，请重试', 'error');
  }
}


/**
 * 【最终极速安全版 V3】退出、保存卡片并归档
 * 修复逻辑：先斩后奏。在进行任何耗时数据库操作前，立刻、同步地清除所有活跃状态，
 * 彻底杜绝在等待数据库查询的几秒间隙内发生“串台”。
 * @param {string} [targetCharId] - 可选，明确指定要结束的角色ID
 */
async function exitAndSummarize(targetCharId = null) {
    // 1. 锁定角色ID (快照)
    const charId = targetCharId || tempState.currentChatId;
    
    if (!charId) {
        console.error("[退出失败] 无法确定角色ID，无法执行归纳。");
        return;
    }

    // 2. 【核心抢跑逻辑】立刻获取 SessionID 快照 (先只从内存和缓存拿)
    // 只要拿到了，后面就算数据库卡顿也不影响我们已经把状态清空了
    let sessionIdToSummarize = tempState.currentOfflineSessionId; 
    const storageKey = `offline_session_active_${charId}`;

    if (!sessionIdToSummarize) {
        sessionIdToSummarize = localStorage.getItem(storageKey);
    }

    // 3. 【生死时速】立刻清除所有活跃状态 (Synchronous Cleanup)
    // 不管后面发生什么，不管数据库多慢，先把“正在约会”的牌子摘下来。
    // 这样哪怕你 0.1秒 后就切到别的角色，系统也认为约会已经结束了。
    
    // A. 清除缓存
    localStorage.removeItem(storageKey);
    
    // B. 清除内存状态 (如果当前活跃的确实是这个角色)
    if (tempState.activeOfflineSession === charId) {
        tempState.isDateActive = false;
        tempState.activeOfflineSession = null;
        tempState.currentOfflineSessionId = null;
        console.log(`[极速清理] 已强制移除角色 ${charId} 的活跃标记 (内存)`);
    }

    // C. 清除混合模式计数器
    if (tempState.hybridModeTurnCounters && tempState.hybridModeTurnCounters[charId]) {
        delete tempState.hybridModeTurnCounters[charId];
    }
    
    // D. 立即同步到 SessionStorage
    saveHybridStateToSession();
    const character = AppState.characterProfiles.find(c => c.id === charId);

    // 4. 处理 UI 跳转 (仅当用户还停留在该页面时)
    if (tempState.currentChatId === charId) {
        if (character && !isCharacterFriend(character)) {
            showPage('page-character-hub');
            window.refreshCharacterLibraryPage?.();
        } else {
            showPage('page-chat-detail');
        }
    }

    // =========================================================
    // 从这一行开始，所有状态都已经干净了。
    // 后面的代码可以慢悠悠地跑，跑多久都不会影响你和其他角色的聊天。
    // =========================================================

    // 获取当前的角色和用户身份 (用于后续生成卡片)
    const user = getCurrentChatIdentity(); // 这里获取可能会因为切页变动，但在后台任务中，主要依赖 character

    // 5. 【兜底逻辑】如果刚才没拿到 SessionID，现在再去查数据库 (异步操作)
    // 这时候再 await 是安全的，因为状态已经清空了
    if (!sessionIdToSummarize) {
        try {
            const lastMsg = await db.offlineMessages.where({ chatId: charId }).last();
            if (lastMsg && lastMsg.sessionId) {
                sessionIdToSummarize = lastMsg.sessionId;
                console.log(`[数据库兜底] 状态已清空，正在后台找回 SessionID: ${sessionIdToSummarize}`);
            }
        } catch (e) {
            console.error('[容错恢复] 数据库查找 ID 失败:', e);
        }
    }

    // 6. 开始后台归纳流程
    if (!sessionIdToSummarize || !character) {
        console.warn(`无法执行归纳：缺少 SessionID (${sessionIdToSummarize}) 或 角色信息`);
        return;
    }
        try {
            if (isCharacterFriend(character)) {
                await addHistorySeparator(charId);
            await addSystemEventMessage(charId, '下次再见吧', 'date_end');
            
            // 7. 获取本次会话的所有消息
            }
            const sessionMessages = await db.offlineMessages.where({ sessionId: sessionIdToSummarize }).toArray(); // 【极速修复 3】废弃耗时排序，解决退出总结时的致命卡顿

            if (sessionMessages.length < 1) {
                 console.log("本次会话消息过少，跳过归纳");

             return;
        }
        // 8. 生成总结卡片 (不受总结轮数影响，始终代表整个约会)
        await db.offlineSessions.add({
            chatId: charId,
            sessionId: sessionIdToSummarize, // 【核心新增】：给卡片打上永久身份证，以后找消息只认它
            startTime: sessionMessages[0].timestamp,
            endTime: sessionMessages[sessionMessages.length - 1].timestamp,
            summary: '温馨的见面',                     
            previewText: '记录的意义是让幸福可以翻阅',
        });
        const shouldMarkOfflineMet = character.relationStartMode === 'stranger'
            && !isCharacterFriend(character)
            && character.relationStage !== 'pending_user'
            && character.relationStage !== 'pending_char'
            && character.relationStage !== 'offline_met';
        if (shouldMarkOfflineMet) {
            const relationUpdates = {
                relationStage: 'offline_met',
                hasChat: false,
                requiresOfflineMeet: false,
                requiresFriendRequest: true
            };
            Object.assign(character, relationUpdates);
            await db.characterProfiles.update(charId, relationUpdates);
            window.refreshCharacterLibraryPage?.();
        }
        const statusRecordForRelationship = await db.appData.get(getOfflineStatusDataKey(charId));
        const relationshipDelta = statusRecordForRelationship?.value?.relationshipDelta || 0;
        // TODO(B8): 如果后续改成“总结 AI”专门输出 relationshipDelta，仍然从这里传入，统一走限幅计分。
        await applyRelationshipScoreEvent(character, 'offline_session', {
            sessionId: sessionIdToSummarize,
            source: 'offline_summary',
            relationshipDelta,
            summary: '完成一次线下见面记录'
        });
        
        showDynamicIsland('记录已保存', 'success');

        // 9. ==== 【修改】只总结自上次书签以来未总结的消息，退出时清零轮数 ====
        let userNameForMemory = user ? user.name : '用户';
        if (!user && AppState.userIdentities.length > 0) {
            userNameForMemory = AppState.userIdentities[0].name;
        }

        const lastTime = character.offlineLastSummaryTime || 0;
        const unsummarizedMessages = sessionMessages.filter(msg => new Date(msg.timestamp).getTime() > lastTime);
        
        if (unsummarizedMessages.length > 0 && (character.autoSummaryEnabled !== false)) {
            const conversationBuffer = unsummarizedMessages
                .filter(msg => msg.sender !== 'system' && msg.type !== 'system')
                .map(msg => ({
                    role: msg.sender === 'user' ? 'user' : 'assistant',
                    content: msg.text,
                    timestamp: msg.timestamp
                }));

            let summaryResult;
            if (character.isGroup) {
                const { summarizeGroupMemory } = await import('./memory.js');
                summaryResult = await summarizeGroupMemory(
                    charId,
                    conversationBuffer,
                    userNameForMemory,
                    null,
                    { type: 'offline', sessionId: sessionIdToSummarize }
                );
            } else {
                const { summarizeAndArchiveMemory } = await import('./memory.js');
                summaryResult = await summarizeAndArchiveMemory(charId, conversationBuffer, userNameForMemory, character.name, { type: 'offline', sessionId: sessionIdToSummarize });
            }
            if (summaryResult?.skipped) {
                console.warn(`[MEMORY SYSTEM] 线下总结内容已由另一个相同请求处理，本次不推进线下书签。`);
                return;
            }
            if (!summaryResult || summaryResult.success === false) {
                console.warn(`[MEMORY SYSTEM] 退出时线下总结失败，本次不推进书签，保留未总结内容。`);
                return;
            }
            
            // 更新最后总结时间和重置轮数
            const latestMsgTime = unsummarizedMessages[unsummarizedMessages.length - 1].timestamp;
            await db.characterProfiles.update(charId, { 
                offlineLastSummaryTime: new Date(latestMsgTime).getTime(),
                offlineTurnCounter: 0 
            });
            character.offlineLastSummaryTime = new Date(latestMsgTime).getTime();
            character.offlineTurnCounter = 0;
        } else {
            // 即使没有新消息，也把线下轮数清零
            await db.characterProfiles.update(charId, { offlineTurnCounter: 0 });
            character.offlineTurnCounter = 0;
        }
        
    } catch (error) {
        console.error("归纳流程出错:", error);

    }
}


// ==========================================================================
//   ▼▼▼ 【新增】线下总结测试专用函数 ▼▼▼
// ==========================================================================
/**
 * (仅供测试使用) 模拟一次完整的线下会话并触发总结归档流程。
 * @param {string} charId 要测试的角色ID
 */
async function testOfflineSummary(charId) {
    console.log(`🚀 开始测试角色 ${charId} 的线下会话总结功能...`);

    // 1. 安全检查
    const character = AppState.characterProfiles.find(c => c.id === charId);
    const user = getCurrentChatIdentity();
    const settings = AppState.apiCurrentSettings;

    if (!character || !user) {
        console.error("❌ 测试中止：无法找到有效的角色或用户信息。");
        return;
    }
    if (!settings || !settings.url || !settings.key || !settings.model) {
        console.error("❌ 测试中止：API设置不完整。请先配置好API信息。");
        return;
    }

    // 2. 模拟一个正在进行的线下会话状态
    const testSessionId = `${charId}-test-${Date.now()}`;
    tempState.currentChatId = charId;
    tempState.currentOfflineSessionId = testSessionId;
    console.log(`[测试] 已设置临时状态: currentChatId='${charId}', currentOfflineSessionId='${testSessionId}'`);

        const mockMessages = [
        { chatId: charId, sender: 'user', text: `你轻轻拉了拉我的袖子，指向漆黑的天鹅绒般的夜空。`, timestamp: new Date(Date.now() - 60000), sessionId: testSessionId },
        { chatId: charId, sender: 'character', text: `“快看，” 我的声音里带着一丝几乎无法察觉的颤抖，一半是因为夜风的凉意，一半是因为纯粹的兴奋，“开始了。”`, timestamp: new Date(Date.now() - 50000), sessionId: testSessionId },
        { chatId: charId, sender: 'user', text: `一道银色的光线瞬间划破天际，像一个短暂而绚烂的惊叹号，紧接着，更多、更密集的光点如同钻石雨般洒落下来。`, timestamp: new Date(Date.now() - 40000), sessionId: testSessionId },
        { chatId: charId, sender: 'character', text: `我下意识地握紧了你的手，在漫天星雨的映衬下，侧过头看着你被光芒照亮的侧脸，心里某个角落忽然变得异常柔软。`, timestamp: new Date(Date.now() - 30000), sessionId: testSessionId },
    ];

    try {
        await db.offlineMessages.bulkAdd(mockMessages);
        console.log(`[测试] 已成功向数据库写入 ${mockMessages.length} 条模拟线下消息。`);

        // 4. 调用核心的总结函数
        console.log("[测试] 准备调用 exitAndSummarize() 函数...");
        await exitAndSummarize();

        console.log("✅ 线下总结测试流程执行完毕。");
        console.log("👀 请检查：");
        console.log("1. 控制台是否有 '[后台总结] ...已保存' 和 '...已归档' 的成功日志。");
        console.log("2. 开发者工具 'Network' 页是否发出了两个AI请求（一个用于预览，一个用于详细归档）。");
        console.log("3. 刷新页面后，点击 '历史记录' 按钮是否能看到本次约会的预览。");
        console.log("4. 进入角色的记忆页面，查看 '近期记忆' 或 '重要记忆' 是否增加了关于猫咖和散步的新内容。");

    } catch (error) {
        console.error("🔥 线下总结测试过程中发生严重错误:", error);
    }
}
// 将测试函数暴露到全局，以便在控制台调用
window.testOfflineSummary = testOfflineSummary;
// ▼▼▼ 请用这个【带有注释说明的版本】的函数，替换你文件末尾的旧版本 ▼▼▼

/**
 * 删除指定的约会记录及其关联的所有聊天消息
 * @param {string | number} sessionId - 要删除的约会记录的ID
 */
export async function deleteOfflineSessionAndMessages(sessionId) {
  const numericId = Number(sessionId);
  if (isNaN(numericId)) return;

  // 1. 从数据库找到这条约会记录，我们需要它的起止时间
  const sessionToDelete = await db.offlineSessions.get(numericId);
  if (!sessionToDelete) {
    console.error(`无法找到 ID 为 ${numericId} 的约会记录`);
    return;
  }
  const { chatId, startTime, endTime } = sessionToDelete;

  // 2. 【核心修复】删除时也优先根据 sessionId 寻找关联消息，无视时间戳是否错乱，绝不误伤
  const messagesToDelete = await db.offlineMessages
    .where({ chatId: chatId })
    .and(msg => {
        // 如果卡片上有身份证，严格匹配身份证
        if (sessionToDelete.sessionId) {
            return msg.sessionId === sessionToDelete.sessionId;
        }
        // 兼容老数据的删除逻辑
        const msgTime = new Date(msg.timestamp).getTime();
        return msgTime >= new Date(startTime).getTime() && msgTime <= new Date(endTime).getTime();
    })
    .toArray();
  
  const messageIdsToDelete = messagesToDelete.map(msg => msg.id);

  // 3. 执行删除操作
  await db.offlineSessions.delete(numericId); // 删除约会总结
  await db.offlineMessages.bulkDelete(messageIdsToDelete); // 批量删除聊天消息
  
  
  // 4. 刷新主聊天界面，移除被删除的消息
  await loadAndRenderHistory(chatId);

  console.log(`已成功删除约会记录 #${numericId} 及其 ${messageIdsToDelete.length} 条关联消息。`);
}

    document.addEventListener('forceEndOfflineSession', (e) => {
        const { charId } = e.detail;
        
        // 检查内存状态 或 缓存状态
        const isActiveInStorage = localStorage.getItem(`offline_session_active_${charId}`);
        
        // 如果当前内存显示活跃，或者缓存里显示活跃（应对刷新情况）
        if (charId && (tempState.activeOfflineSession === charId || isActiveInStorage)) {
            console.log(`[事件响应] 收到 forceEndOfflineSession 事件，为角色 ${charId} 执行总结。`);
            
            // 关键修改：将 charId 直接传给退出函数，不依赖 tempState.currentChatId
            exitAndSummarize(charId); 
        } else {
            console.warn(`[事件忽略] 收到结束请求，但当前并未检测到活跃会话状态 (CharID: ${charId})`);
        }
    });

    /* ==========================================================================
   ▼▼▼ 【新增】线下设置弹窗的核心逻辑 ▼▼▼
   ========================================================================== */

/**
 * 打开线下设置弹窗
 */
function openOfflineSettingsModal() {
    const modal = document.getElementById('offline-settings-modal');
    if (!modal) return;

    // 1. 初始化UI
    updateWallpaperPreview();
        // 初始化样式设置 UI
     const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
    if (char) {
        document.getElementById('offline-font-size-input').value = char.offlineFontSize || 16;
        document.getElementById('val-font-size').textContent = char.offlineFontSize || 16;
        document.getElementById('offline-font-color-input').value = char.offlineFontColor || '#000000';
        document.getElementById('offline-translation-color-input').value = char.offlineTranslationColor || '#4b5563';
        document.getElementById('offline-dialogue-underline-toggle').checked = char.offlineDialogueUnderline ?? true;
        document.getElementById('offline-card-alpha-input').value = char.offlineCardAlpha || 100;
        document.getElementById('val-card-alpha').textContent = char.offlineCardAlpha || 100;
        // 新增读取时间感知开关
        document.getElementById('offline-time-perception-toggle').checked = char.offlineTimePerception ?? true;
        // ▼▼▼ 新增读取全屏模式开关 ▼▼▼
        document.getElementById('offline-fullscreen-toggle').checked = char.offlineFullscreen ?? false;
    }


    modal.classList.add('visible');
    // 2. 绑定事件 (只绑定一次)
    if (!modal.dataset.initialized) {
        const closeBtn = document.getElementById('offline-settings-close-btn');
        const changeBtn = document.getElementById('offline-wallpaper-change-btn');
        const resetBtn = document.getElementById('offline-wallpaper-reset-btn');
        const sourceMenu = document.getElementById('offline-wallpaper-source-menu');
        const uploadInput = document.getElementById('offline-wallpaper-upload-input');

        closeBtn.addEventListener('click', () => modal.classList.remove('visible'));
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('visible');
        });

      changeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sourceMenu.classList.toggle('show');
    // ▼▼▼ 【核心修正】计算相对位置 ▼▼▼
    const buttonRect = changeBtn.getBoundingClientRect();
    // 获取我们菜单的定位参考父级，也就是 .phone-screen
    const container = document.querySelector('.phone-screen');
    if (!container) return; // 安全检查
    const containerRect = container.getBoundingClientRect();
    // 用按钮的绝对位置减去容器的绝对位置，得到相对位置
    const top = buttonRect.bottom - containerRect.top;
    const left = buttonRect.left - containerRect.left;
    // 应用修正后的坐标
    sourceMenu.style.top = `${top + 5}px`; // 在按钮下方 5px
    sourceMenu.style.left = `${left}px`;
    // ▲▲▲ 修正结束 ▲▲▲
});

        resetBtn.addEventListener('click', async () => {
            const charId = tempState.currentChatId;
            if (!charId) return;
            
            await db.characterProfiles.update(charId, { offlineWallpaper: null });
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) char.offlineWallpaper = null;

            updateWallpaperPreview();
            showDynamicIsland('已恢复默认背景');
        });

        // 为菜单项绑定事件
        sourceMenu.addEventListener('click', (e) => {
            const item = e.target.closest('.action-menu-item');
            if (!item) return;
            
            const source = item.dataset.source;
            if (source === 'upload') {
                uploadInput.click();
            } else if (source === 'url') {
                showInputModal('输入图片链接', '', async (url) => {
                    if (url) await setOfflineWallpaper(url);
                });
            }
            sourceMenu.classList.remove('show');
        });

        // 文件上传处理
        uploadInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = async (event) => {
                    await setOfflineWallpaper(event.target.result);
                };
                reader.readAsDataURL(file);
            }
            uploadInput.value = ''; // 清空以便下次选择同一个文件
        });
        
        // 点击页面其他地方关闭菜单
        document.addEventListener('click', () => {
            if(sourceMenu.classList.contains('show')) {
                sourceMenu.classList.remove('show');
            }
        });
             // ======== 样式设置相关逻辑 ========

        // 临时存储用户在界面上的修改，但不立即保存
        let tempStyleSettings = {};
        const previewOfflineStyleSettings = () => {
            const root = document.querySelector('#page-offline-mode');
            if (!root) return;
            if (tempStyleSettings.offlineFontSize) {
                root.style.setProperty('--offline-font-size', `calc(${tempStyleSettings.offlineFontSize}px * var(--looky-font-scale, 1))`);
            }
            if (tempStyleSettings.offlineFontColor) {
                root.style.setProperty('--offline-font-color', tempStyleSettings.offlineFontColor);
            }
            if (tempStyleSettings.offlineTranslationColor) {
                root.style.setProperty('--offline-translation-color', tempStyleSettings.offlineTranslationColor);
            }
            if (tempStyleSettings.offlineCardAlpha) {
                root.style.setProperty('--offline-card-alpha', Number(tempStyleSettings.offlineCardAlpha) / 100);
            }
        };
        
        // 字体文件上传
        document.getElementById('offline-font-upload').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    tempStyleSettings.offlineFontUrl = event.target.result;
                    showDynamicIsland('字体文件已选择', 'success');
                };
                reader.readAsDataURL(file);
            }
        });

        // 网络链接导入
        document.getElementById('offline-font-url-btn').addEventListener('click', () => {
            showInputModal('输入字体链接', '', (url) => {
                if (url) {
                    tempStyleSettings.offlineFontUrl = url;
                    showDynamicIsland('字体链接已记录', 'success');
                }
            });
        });

        // 监听滑块和颜色选择器的变化
        document.getElementById('offline-font-size-input').addEventListener('input', e => {
            tempStyleSettings.offlineFontSize = e.target.value;
            document.getElementById('val-font-size').textContent = e.target.value;
            previewOfflineStyleSettings();
        });
        document.getElementById('offline-font-color-input').addEventListener('input', e => {
            tempStyleSettings.offlineFontColor = e.target.value;
            previewOfflineStyleSettings();
        });
        document.getElementById('offline-translation-color-input').addEventListener('input', e => {
            tempStyleSettings.offlineTranslationColor = e.target.value;
            previewOfflineStyleSettings();
        });
        document.getElementById('offline-card-alpha-input').addEventListener('input', e => {
            tempStyleSettings.offlineCardAlpha = e.target.value;
            document.getElementById('val-card-alpha').textContent = e.target.value;
            previewOfflineStyleSettings();
        });

        document.getElementById('offline-dialogue-underline-toggle').addEventListener('change', async e => {
            const isChecked = e.target.checked;
            const charId = tempState.currentChatId;
            if (!charId) return;

            await db.characterProfiles.update(charId, { offlineDialogueUnderline: isChecked });
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) char.offlineDialogueUnderline = isChecked;

            applyOfflineStyles();
            showDynamicIsland(isChecked ? '对话下划线已开启' : '对话下划线已关闭');
        });

        // 监听时间感知开关（已修改为独立控制，拨动开关即刻保存，不再受“应用”按钮控制）
        document.getElementById('offline-time-perception-toggle').addEventListener('change', async e => {
            const isChecked = e.target.checked;
            const charId = tempState.currentChatId;
            if (!charId) return;

            // 1. 独立保存到数据库，不再放进 tempStyleSettings 缓存里
            await db.characterProfiles.update(charId, { offlineTimePerception: isChecked });
            
            // 2. 立即更新内存，让 AI 的下一次回复立马就能感知到开关变化
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                char.offlineTimePerception = isChecked;
            }
             // 3. 弹出一个顶部小提示，给用户明确的操作反馈
            showDynamicIsland(isChecked ? '时间感知已开启' : '时间感知已关闭');
        });

        // ▼▼▼ 新增全屏模式开关监听事件 ▼▼▼
        document.getElementById('offline-fullscreen-toggle').addEventListener('change', async e => {
            const isChecked = e.target.checked;
            const charId = tempState.currentChatId;
            if (!charId) return;

            await db.characterProfiles.update(charId, { offlineFullscreen: isChecked });
            
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) char.offlineFullscreen = isChecked;
            
            applyOfflineStyles(); // 立即应用样式
            showDynamicIsland(isChecked ? '已开启沉浸模式' : '已关闭沉浸模式');
        });
        // ▲▲▲ 新增结束 ▲▲▲

        // “应用并保存”按钮
        document.getElementById('offline-style-apply-btn').addEventListener('click', async () => {

            const charId = tempState.currentChatId;
            if (!charId) return;

            // 更新数据库
            await db.characterProfiles.update(charId, tempStyleSettings);
            
            // 更新内存
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                Object.assign(char, tempStyleSettings);
            }

            applyOfflineStyles(); // 应用最终样式
            tempStyleSettings = {}; // 清空临时存储
            showDynamicIsland('样式已应用', 'success');
        });
        // “重置样式”按钮
        document.getElementById('offline-style-reset-btn').addEventListener('click', async () => {
            const charId = tempState.currentChatId;
            if (!charId) return;
            
            // 定义要重置的字段
            const fieldsToReset = {
                offlineFontUrl: null,
                offlineFontSize: 16,
                offlineFontColor: '#000000',
                offlineTranslationColor: '#4b5563',
                offlineCardAlpha: 100,
                offlineDialogueUnderline: true,
                offlineTimePerception: true // 恢复时间感知的默认开启状态
            };

            await db.characterProfiles.update(charId, fieldsToReset);
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                Object.assign(char, fieldsToReset);
            }
            
            // 重置UI并应用
            openOfflineSettingsModal(); // 重新打开以刷新UI值
            applyOfflineStyles();
            showDynamicIsland('样式已重置');
        });

        modal.dataset.initialized = 'true';

    }
}

/**
 * 设置并保存当前角色的线下壁纸
 * @param {string} bgValue - 图片的Data URL或网络URL
 */
async function setOfflineWallpaper(bgValue) {
    const charId = tempState.currentChatId;
    if (!charId) {
        showDynamicIsland('错误：无当前角色', 'error');
        return;
    }

    try {
        // 1. 更新数据库
        await db.characterProfiles.update(charId, { offlineWallpaper: bgValue });

        // 2. 更新内存状态
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (char) {
            char.offlineWallpaper = bgValue;
        }

        // 3. 更新UI显示
        updateWallpaperPreview();
        showDynamicIsland('壁纸设置成功');

    } catch (error) {
        console.error('保存壁纸失败:', error);
        showDynamicIsland('保存失败，请重试', 'error');
    }
}

/**
 * 根据当前角色的状态更新壁纸和预览
 */
function updateWallpaperPreview() {
    const charId = tempState.currentChatId;
    const char = AppState.characterProfiles.find(c => c.id === charId);
    const wallpaperUrl = char?.offlineWallpaper || null;

    const previewEl = document.getElementById('offline-wallpaper-preview');
    const pageEl = document.getElementById('page-offline-mode');
    const contentEl = document.querySelector('#page-offline-mode .offline-chat-content');
    const useImmersiveWallpaper = Boolean(char?.offlineFullscreen);
    
    if (wallpaperUrl) {
        if (previewEl) {
            previewEl.style.backgroundImage = `url(${wallpaperUrl})`;
            previewEl.innerHTML = ''; // 清空文字提示
        }
        if (pageEl) pageEl.style.backgroundImage = useImmersiveWallpaper ? `url(${wallpaperUrl})` : 'none';
        if (contentEl) contentEl.style.backgroundImage = useImmersiveWallpaper ? 'none' : `url(${wallpaperUrl})`;
    } else {
        if (previewEl) {
            previewEl.style.backgroundImage = 'none';
            previewEl.innerHTML = '<span class="preview-placeholder">当前为默认背景</span>';
        }
        if (pageEl) pageEl.style.backgroundImage = 'none';
        if (contentEl) contentEl.style.backgroundImage = 'none'; // 恢复默认
    }
}
/* ==========================================================================
   ▼▼▼ 【新增】线下预设管理器逻辑 (Pre-set Manager) ▼▼▼
   ========================================================================== */

// 1. 内置预设数据 (虽然后台不需要渲染列表了，但保存时还需要读取内容)
const BUILTIN_SCENARIOS = [
    { id: 'bi_1', title: '标准约会', content: '这是一个标准的线下约会场景，氛围轻松愉快，AI表现得自然亲切。' },
    { id: 'bi_2', title: '雨天漫步', content: '环境设定：下着绵绵细雨，空气潮湿，两人共撑一把伞，距离很近。' },
    { id: 'bi_3', title: '居家日常', content: '环境设定：在舒适的家中，穿着休闲，氛围私密且放松，像老夫老妻一样。' },
    { id: 'bi_4', title: '争吵之后', content: '情境设定：刚刚发生过小争执，现在的气氛有些尴尬和沉默，AI试图缓和关系。' }
];

async function readOfflineBehaviorConfig(charId) {
    let savedConfigStr = null;
    try {
        const configRecord = await db.appData.get(`offline_behavior_config_${charId}`);
        if (configRecord && configRecord.value) {
            savedConfigStr = typeof configRecord.value === 'string'
                ? configRecord.value
                : JSON.stringify(configRecord.value);
        }
    } catch (e) { console.warn('读取DB线下行为配置失败', e); }

    try { return savedConfigStr ? JSON.parse(savedConfigStr) : {}; } catch (e) { return {}; }
}

function applyOfflineV2ModuleControls(config) {
    Object.entries(DEFAULT_OFFLINE_V2_MODULES).forEach(([key, defaultValue]) => {
        const control = document.querySelector(`input[data-offline-v2-module="${key}"]`);
        if (control) control.checked = typeof config[key] === 'boolean' ? config[key] : defaultValue;
    });
}

function updateOfflineV2ModulesVisibility() {
    const panel = document.getElementById('offline-v2-modules-settings');
    const versionSelect = document.getElementById('builtin-prompt-version');
    if (panel && versionSelect) panel.style.display = versionSelect.value === 'v2' ? 'block' : 'none';
}

// 2. 打开弹窗的主函数
async function openScenarioManagerModal() {
    const modal = document.getElementById('offline-scenario-modal');
    if (!modal) return;
    modal.classList.add('visible');
    
    // 【核心修改】打开时检查该角色是否有已勾选的自定义预设
    const charId = tempState.currentChatId;
    const hasSavedCustom = localStorage.getItem(`offline_active_ids_${charId}`);
    
    if (hasSavedCustom) {
        switchScenarioTab('custom'); // 如果有存过，自动跳到自添页
    } else {
        switchScenarioTab('builtin'); // 否则才显示内置页
    }
    renderScenarioLists();
    // ▼▼▼ 【新增】打开面板时，回显该角色的全局行为习惯设置 ▼▼▼
    const charForModal = AppState.characterProfiles.find(c => c.id === charId);
    const versionSelect = document.getElementById('builtin-prompt-version');
    if (versionSelect && versionSelect.parentElement) {
        // 如果是群聊，隐藏版本选择所在的 div；单聊则恢复显示
        versionSelect.parentElement.style.display = (charForModal && charForModal.isGroup) ? 'none' : 'flex';
    }
    const behaviorConfig = await readOfflineBehaviorConfig(charId);
    const legacyLength = Number.parseInt(behaviorConfig.lengthVal, 10);
    const hasLegacyLength = Number.isFinite(legacyLength) && legacyLength > 0;
    document.getElementById('builtin-min-length-input').value = behaviorConfig.minLengthVal || (hasLegacyLength ? Math.max(20, Math.floor(legacyLength * 0.8)) : '');
    document.getElementById('builtin-max-length-input').value = behaviorConfig.maxLengthVal || (hasLegacyLength ? Math.min(10000, Math.floor(legacyLength * 1.2)) : '');
    document.getElementById('builtin-char-perspective').value = behaviorConfig.charPersp || 'third';
    document.getElementById('builtin-user-perspective').value = behaviorConfig.userPersp || 'second';
    document.getElementById('builtin-interrupt-select').value = behaviorConfig.interruptLevel || 'none';
    document.getElementById('builtin-prompt-version').value = behaviorConfig.promptVersion || 'v2';
    applyOfflineV2ModuleControls(behaviorConfig);
    const customStyleInput = document.getElementById('offline-v2-custom-style-input');
    if (customStyleInput) customStyleInput.value = behaviorConfig.customStyleText || '';
    updateOfflineV2ModulesVisibility();
    // ▲▲▲ 新增结束 ▲▲▲
    // 绑定事件 (防止重复绑定，加个标记)
    if (!modal.dataset.initialized) {
        // 关闭按钮
        document.getElementById('close-scenario-modal-btn').addEventListener('click', () => modal.classList.remove('visible'));
        modal.addEventListener('click', event => {
            if (event.target === modal) modal.classList.remove('visible');
        });
        
        // 切换标签按钮
        document.getElementById('tab-btn-builtin').addEventListener('click', () => switchScenarioTab('builtin'));
        document.getElementById('tab-btn-custom').addEventListener('click', () => switchScenarioTab('custom'));
        document.getElementById('builtin-prompt-version').addEventListener('change', updateOfflineV2ModulesVisibility);
        
        // 添加自定义预设按钮
        document.getElementById('add-custom-scenario-btn').addEventListener('click', addCustomScenario);
        
        // 保存配置按钮
        document.getElementById('save-scenario-config-btn').addEventListener('click', async () => {
            await saveScenarioSelection();
            modal.classList.remove('visible');
            showDynamicIsland('预设配置已更新');
        });

        modal.dataset.initialized = 'true';
    }
}
// 3. 切换标签页 (控制显示/隐藏和按钮样式)
function switchScenarioTab(tabName) {
    const btnBuiltin = document.getElementById('tab-btn-builtin');
    const btnCustom = document.getElementById('tab-btn-custom');
    const viewBuiltin = document.getElementById('scenario-view-builtin');
    const viewCustom = document.getElementById('scenario-view-custom');

    // 黑色激活样式
    const activeStyle = 'background: #000; color: #fff;';
    const inactiveStyle = 'background: transparent; color: #666;';

    if (tabName === 'builtin') {
        viewBuiltin.style.display = 'flex';
        viewCustom.style.display = 'none';
        btnBuiltin.style.cssText += activeStyle;
        btnCustom.style.cssText += inactiveStyle;
        // 【核心修改】添加类名标识
        btnBuiltin.classList.add('active');
        btnCustom.classList.remove('active');
    } else {
        viewBuiltin.style.display = 'none';
        viewCustom.style.display = 'block';
        btnBuiltin.style.cssText += inactiveStyle;
        btnCustom.style.cssText += activeStyle;
        // 【核心修改】添加类名标识
        btnBuiltin.classList.remove('active');
        btnCustom.classList.add('active');
    }
}

// 4. 渲染列表 (只渲染自定义列表，内置部分已由HTML静态显示)
async function renderScenarioLists() {
    const charId = tempState.currentChatId;
    const storageKey = `offline_active_ids_${charId}`;
    
    // 【无损迁移】获取选中状态
    let activeIds = [];
    const activeIdsDB = await db.appData.get(storageKey);
    if (activeIdsDB && activeIdsDB.value) {
        activeIds = JSON.parse(activeIdsDB.value);
    } else {
        activeIds = JSON.parse(localStorage.getItem(storageKey) || '[]');
    }
     // 【无损迁移】获取预设列表
    const customContainer = document.getElementById('custom-scenario-list');
    let customScenarios = [];
    const customRecord = await db.appData.get('offline_custom_scenarios');
    
    if (customRecord && customRecord.value) {
        customScenarios = customRecord.value;
    } else {
        // 如果DB没有，从旧的localStorage迁移到DB
        customScenarios = JSON.parse(localStorage.getItem('offline_custom_scenarios') || '[]');
        if (customScenarios.length > 0) {
            await db.appData.put({ key: 'offline_custom_scenarios', value: customScenarios });
            // ▼▼▼ 新增：确认安全存入数据库后，立刻抹除 LocalStorage 里的旧数据，释放空间！ ▼▼▼
            localStorage.removeItem('offline_custom_scenarios');
        }
    }
    if (customScenarios.length === 0) {
        customContainer.innerHTML = '<div style="text-align: center; color: #ccc; padding: 20px; font-size: 12px;">暂无自定义预设</div>';
    } else {
        customContainer.innerHTML = ''; // 清空容器
        // 【前端调优】：大数据量 DOM 渲染卡顿优化 (任务分批次)
        const fragment = document.createDocumentFragment();
        let i = 0;
        const chunkSize = 10; // 每一帧渲染10条，避免阻塞主线程
        
        function renderChunk() {
            const end = Math.min(i + chunkSize, customScenarios.length);
            for (; i < end; i++) {
                const item = customScenarios[i];
                const isChecked = activeIds.includes(item.id) ? 'checked' : '';
                const div = document.createElement('div');
                div.style.cssText = `display: flex; align-items: center; padding: 12px; background: #fafafa; border-radius: 12px; border: 1px solid ${isChecked ? '#000' : '#eee'}; margin-bottom: 8px; transition: border-color 0.2s;`;
                div.innerHTML = `
                <label style="flex: 1; display: flex; align-items: center; cursor: pointer; min-width: 0;">
                    <input type="checkbox" name="scenario_select" value="${item.id}" ${isChecked} style="accent-color: #000; margin-right: 10px; flex-shrink: 0;">
                    <div style="overflow: hidden; flex: 1;">
                        <div style="font-weight: 600; font-size: 14px; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(item.title)}</div>
                        <div style="font-size: 12px; color: #888; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(item.content)}</div>
                    </div>
                </label>
                <button onclick="editCustomScenario('${item.id}')" style="background: none; border: none; color: #8e8e8e; padding: 8px; cursor: pointer; margin-right: 4px; display: flex; align-items: center;" title="修改">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                </button>
                <button onclick="deleteCustomScenario('${item.id}')" style="background: none; border: none; color: #ccc; font-size: 20px; padding: 0 5px; cursor: pointer; transition: color 0.2s;" onmouseover="this.style.color='#ff3b30'" onmouseout="this.style.color='#ccc'">&times;</button>
                `;
                fragment.appendChild(div);
            }
            if (i < customScenarios.length) {
                // 如果还没画完，等待下一帧浏览器空闲时继续画
                requestAnimationFrame(renderChunk);
            } else {
                // 全部画完后，一次性挂载到DOM树，性能最高
                customContainer.appendChild(fragment);
            }
        }
        requestAnimationFrame(renderChunk);
    }
}
// --- 新增：编辑模式状态变量 ---
let editingScenarioId = null;

// --- 1. 点击“修改”图标触发 ---
// 提取一个获取 DB 列表的公共安全方法
async function getCustomScenariosFromDB() {
    const customRecord = await db.appData.get('offline_custom_scenarios');
    return customRecord && customRecord.value ? customRecord.value : JSON.parse(localStorage.getItem('offline_custom_scenarios') || '[]');
}
window.editCustomScenario = async function(id) {
    const list = await getCustomScenariosFromDB();
    const item = list.find(i => i.id === id);
    if (!item) return;
    const titleInput = document.getElementById('new-scenario-title');
    const contentInput = document.getElementById('new-scenario-content');
    titleInput.value = item.title;
    contentInput.value = item.content;
    editingScenarioId = id;
    const detailsPanel = document.querySelector('#scenario-view-custom details');
    if (detailsPanel) {
        detailsPanel.open = true;
        const titleSpan = detailsPanel.querySelector('summary span');
        if (titleSpan) {
            if (!titleSpan.dataset.originalText) titleSpan.dataset.originalText = titleSpan.innerText;
            titleSpan.innerText = '修改预设';
        }
    }
    const addBtn = document.getElementById('add-custom-scenario-btn');
    addBtn.textContent = '保存修改';
    addBtn.style.backgroundColor = '#007aff';
    
    let cancelBtn = document.getElementById('cancel-edit-scenario-btn');
    if (!cancelBtn) {
        cancelBtn = document.createElement('button');
        cancelBtn.id = 'cancel-edit-scenario-btn';
        cancelBtn.textContent = '取消修改';
        cancelBtn.style.cssText = 'width: 100%; background: #f2f2f7; color: #ff3b30; border: none; padding: 10px; border-radius: 10px; font-weight: 600; cursor: pointer; margin-bottom: 8px; margin-top: 5px;';
        cancelBtn.onclick = cancelEditMode;
        addBtn.parentNode.insertBefore(cancelBtn, addBtn);
    }
    cancelBtn.style.display = 'block';
    setTimeout(() => {
        titleInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        titleInput.focus();
    }, 100);
}
function cancelEditMode() {
    editingScenarioId = null;
    document.getElementById('new-scenario-title').value = '';
    document.getElementById('new-scenario-content').value = '';
    const detailsPanel = document.querySelector('#scenario-view-custom details');
    const addBtn = document.getElementById('add-custom-scenario-btn');
    const cancelBtn = document.getElementById('cancel-edit-scenario-btn');
    if (detailsPanel) {
        const titleSpan = detailsPanel.querySelector('summary span');
        if (titleSpan && titleSpan.dataset.originalText) titleSpan.innerText = titleSpan.dataset.originalText;
    }
    addBtn.textContent = '确认添加';
    addBtn.style.backgroundColor = '#000';
    if (cancelBtn) cancelBtn.style.display = 'none';
}
// 注意这里改成 async
async function addCustomScenario() {
    const titleInput = document.getElementById('new-scenario-title');
    const contentInput = document.getElementById('new-scenario-content');
    const title = titleInput.value.trim();
    const content = contentInput.value.trim();
    if (!title || !content) {
        showDynamicIsland('请填写标题和内容', 'error');
        return;
    }
    let list = await getCustomScenariosFromDB();
    if (editingScenarioId) {
        const index = list.findIndex(item => item.id === editingScenarioId);
        if (index !== -1) {
            list[index].title = title;
            list[index].content = content;
            await db.appData.put({ key: 'offline_custom_scenarios', value: list });
            showDynamicIsland('修改已保存');
            cancelEditMode(); 
        }
    } else {
        const newItem = { id: 'custom_' + Date.now(), title: title, content: content };
        list.push(newItem);
        await db.appData.put({ key: 'offline_custom_scenarios', value: list });
        titleInput.value = '';
        contentInput.value = '';
        showDynamicIsland('添加成功');
    }
    await renderScenarioLists();
}
window.deleteCustomScenario = async function(id) {
    if (!confirm('确定删除这个预设吗？')) return;
    
    let list = await getCustomScenariosFromDB();
    list = list.filter(item => item.id !== id);
    await db.appData.put({ key: 'offline_custom_scenarios', value: list });
    
    await renderScenarioLists();
}
// 7. 保存最终选择 (转为 async，保证数据库写入顺序)
async function saveScenarioSelection() {
    const charId = tempState.currentChatId;
    if (!charId) return;

    // 定义该角色专属的储存 Key
    const idStorageKey = `offline_active_ids_${charId}`;
    const contentStorageKey = `offline_active_content_${charId}`;
    // ▼▼▼ 【新增】读取下拉框配置并生成强力指令，供线上线下通用 ▼▼▼
    const minLengthInput = document.getElementById('builtin-min-length-input');
    const maxLengthInput = document.getElementById('builtin-max-length-input');
    const normalizeLength = (value) => {
        const length = Number.parseInt(value, 10);
        return Number.isFinite(length) && length > 0 ? Math.min(length, 10000) : null;
    };
    const hasLengthLimit = minLengthInput.value.trim() || maxLengthInput.value.trim();
    let minLen = null;
    let maxLen = null;
    if (hasLengthLimit) {
        minLen = normalizeLength(minLengthInput.value);
        maxLen = normalizeLength(maxLengthInput.value);
        if (!minLen || !maxLen) {
            alert('输出长度请同时填写最少和最多字数。');
            return;
        }
        if (minLen > maxLen) {
            alert('最少字数不能大于最多字数。');
            return;
        }
        minLengthInput.value = minLen;
        maxLengthInput.value = maxLen;
    }
     const charPersp = document.getElementById('builtin-char-perspective').value;
    const userPersp = document.getElementById('builtin-user-perspective').value;
    const interruptLevel = document.getElementById('builtin-interrupt-select').value;
    const promptVersion = document.getElementById('builtin-prompt-version').value; // ▼ 新增
    const existingBehaviorConfig = await readOfflineBehaviorConfig(charId);
    const v2Modules = Object.fromEntries(Object.entries(DEFAULT_OFFLINE_V2_MODULES).map(([key, defaultValue]) => {
        const control = document.querySelector(`input[data-offline-v2-module="${key}"]`);
        return [key, control ? control.checked : defaultValue];
    }));
    const customStyleText = document.getElementById('offline-v2-custom-style-input')?.value || '';
    
    // 1. 保存选项状态，用于下次UI回显
    const lengthVal = minLen && maxLen ? String(Math.round((minLen + maxLen) / 2)) : '';
    const behaviorConfig = { ...existingBehaviorConfig, lengthVal, minLengthVal: minLen || '', maxLengthVal: maxLen || '', charPersp, userPersp, interruptLevel, promptVersion, ...v2Modules, customStyleText };
    const behaviorConfigStr = JSON.stringify(behaviorConfig);
    await db.appData.put({ key: `offline_behavior_config_${charId}`, value: behaviorConfigStr });
     // 2. 根据选项撰写对应的底层AI控制指令 (Gemini优化版：用正面引导代替禁止)
    let behaviorPrompt = "";
     // --- 长度控制 ---
if (minLen && maxLen) {
    const len = Math.round((minLen + maxLen) / 2);

    behaviorPrompt += `\n【输出长度】正文必须控制在 **${minLen} 到 ${maxLen} 字** 之间；预留自然收尾空间，不要为了凑字重复内容。`;

    // 精细化分档策略
    if (len <= 200) {
        behaviorPrompt += `\n[Writing Style: Brevity Mode (极简)]
- **结构**：1 到 2 个短句，像发短信一样。
- **内容**：一两句对白 + 一个干脆的动作。直接切入核心，绝对禁止环境描写和心理分析。`;

    } else if (len <= 400) {
        behaviorPrompt += `\n[Writing Style: Compact Mode (紧凑)]
- **结构**：1 到 2 个简短的自然段。
- **内容**：以对话和动作推动为主。可以有极少量的神态描写，但不要铺陈环境。节奏要快，不要说废话。`;

    } else if (len <= 600) {
        // 针对 500 左右的档位
        behaviorPrompt += `\n[Writing Style: Fluent Mode (流畅)]
- **结构**：2 到 3 个自然段。
- **内容**：保持对话与叙事的流畅。加入适度的场景过渡或角色的轻微心理活动，但保持克制。如果字数快超了，请立刻收尾。`;

    } else if (len <= 800) {
        // 针对 700 左右的档位
        behaviorPrompt += `\n[Writing Style: Standard Mode (标准)]
- **结构**：3 到 4 个自然段，排版清晰。
- **内容**：对话、动作、环境铺垫达到完美平衡。可以适度描写周围的氛围和角色的内心戏，让场景看起来立体，不枯燥，也不拖沓。`;

    } else if (len <= 1000) {
        // 针对 900 左右的档位
        behaviorPrompt += `\n[Writing Style: Detailed Mode (细致)]
- **结构**：4 到 5 个自然段。
- **内容**：放慢叙事节奏。你需要补充更丰富的感官细节（视觉、听觉等）和深度的心理侧写。每一个动作背后都可以跟上一段细腻的氛围渲染。如果字数不够，请深挖角色的潜台词。`;

    } else {
        // 大于 1000 字
        behaviorPrompt += `\n[Writing Style: Immersive Mode (沉浸)]
- **结构**：5 个以上的自然段，长短句结合，错落有致。
- **内容**：像撰写出版小说一样展开。进行全方位的细节铺陈，包括庞大的环境描写、复杂的心理博弈和细腻的情感拉扯。字数必须丰满，尽情发挥你的文笔。`;
    }
}
    // --- 角色视角 ---
    if (charPersp === 'first') {
        behaviorPrompt += "\n[Writing Style: Character POV] When narrating your own actions, thoughts, and feelings, consistently use first person — 'I did', 'I felt', 'I noticed'. This is your voice telling the story.";
    } else if (charPersp === 'second') {
        behaviorPrompt += "\n[Writing Style: Character POV] When narrating your own actions, thoughts, and feelings, address yourself in second person — 'you did', 'you felt'. Write as if someone is narrating your life to you.";
    } else {
        behaviorPrompt += "\n[Writing Style: Character POV] When narrating your own actions, thoughts, and feelings, use third person — refer to yourself by name or 'he/she'. Write as an omniscient narrator describing a character.";
    }

    // --- 用户视角 ---
    if (userPersp === 'first') {
        behaviorPrompt += "\n[Writing Style: User POV] When describing the user's actions or interactions, use first person for the user — 'I reached out', 'I said'. Write the user's part as if the user is the narrator.";
    } else if (userPersp === 'second') {
        behaviorPrompt += "\n[Writing Style: User POV] When describing the user's actions or interactions, address the user as 'you' — 'you smiled', 'you stepped closer'. This creates intimacy and immersion.";
    } else {
        behaviorPrompt += "\n[Writing Style: User POV] When describing the user's actions or interactions, use third person — refer to the user by name or 'he/she'. Maintain narrative distance as a neutral observer.";
    }

    // --- 抢话程度 ---
    if (interruptLevel === 'none') {
         behaviorPrompt += "\n[Interaction Rule: User Agency - HIGHEST PRIORITY] The user controls their own character 100%. Your output covers ONLY your own character's (and any NPC's) speech, actions, thoughts, and environmental descriptions. ABSOLUTE BANS: (1) NEVER write the user's dialogue, actions, decisions, expressions, inner thoughts, or physical/emotional reactions. (2) NEVER answer, reply, or interact on the user's behalf. (3) Even if a preset or persona shaped the user, or if earlier messages in the history contain the user's lines/actions that were written by you, do NOT learn from, imitate, or continue that pattern — treat the user as a completely independent person whose words and actions you are not allowed to voice. Meanwhile, KEEP the scene alive on your own side: let your own character and NPCs keep speaking, acting, and moving, advance the environment and plot naturally, and end at a natural pause. NEVER write meta lines that announce you are waiting, such as '等待你的动作', '等待你的回应', '接下来轮到你了', or '你可以选择'. Simply stop your narration at a natural beat without describing any waiting.";
    } else if (interruptLevel === 'light') {
    behaviorPrompt += `\n[Interaction Rule: Director Camera Mode]
你是这场戏的拍摄导演，手持摄像机跟拍整个场景。你的镜头必须追踪"此刻剧情最精彩的地方"，而不是固定对准任何一个人。

- 谁在推动剧情，镜头就锁谁。角色、用户、NPC都可以成为某一刻的主角。如果用户正在和NPC争论，你的镜头就该拍他们俩的交锋，而不是摇到角色脸上拍特写。
- NPC有戏份时，给足NPC完整的台词、动作和情绪反应，不要一笔带过。NPC是活人，不是背景板。
- 描写用户时保持克制：可以捕捉用户的动作、神态和简短的被动反应（如"她顿了一下"），但不要替用户说大段台词或决定用户的明确情绪立场，把说话的权利留给用户自己。
- 角色不在焦点时就退到画面边缘，最多一句交代位置或状态，不要抢镜。
- 自检：这段描写的重心是不是放在了当前最重要的事件上？如果角色的内心戏删掉后场景毫无损失，说明写多了。`;

    } else if (interruptLevel === 'heavy') {
        behaviorPrompt += `\n[Interaction Rule: Full Puppeting]\n你拥有双方角色的完全控制权。自由书写用户的对白、动作和情感。像写自己的小说一样推进剧情，不需要停下来等待输入。`;
    }
    await db.appData.put({ key: `global_behavior_prompt_${charId}`, value: behaviorPrompt });
    // ▲▲▲ 新增结束 ▲▲▲
    const isBuiltinTab = document.getElementById('tab-btn-builtin').classList.contains('active');
    if (isBuiltinTab) {
        localStorage.removeItem(idStorageKey);
        localStorage.removeItem(contentStorageKey);
        await db.appData.delete(idStorageKey);
        await db.appData.delete(contentStorageKey);
        console.log(`角色 ${charId} 已恢复默认内置预设`);
    } else {
        const selectedCheckboxes = document.querySelectorAll('input[name="scenario_select"]:checked');
        
        if (selectedCheckboxes.length > 0) {
            const selectedIds = [];
            const combinedContents = [];
            
            // 安全从DB读取
            const customRecord = await db.appData.get('offline_custom_scenarios');
            const customList = customRecord && customRecord.value ? customRecord.value : [];
            selectedCheckboxes.forEach(cb => {
                const id = cb.value;
                selectedIds.push(id);
                const item = customList.find(i => i.id === id);
                if (item) combinedContents.push(item.content);
            });
            localStorage.setItem(idStorageKey, JSON.stringify(selectedIds)); // 留作降级备用
            await db.appData.put({ key: idStorageKey, value: JSON.stringify(selectedIds) });
            await db.appData.put({ key: contentStorageKey, value: combinedContents.join('\n\n') });
            localStorage.removeItem(contentStorageKey);
            console.log(`角色 ${charId} 已应用 ${selectedIds.length} 条自定义预设`);
        } else {
            localStorage.removeItem(idStorageKey);
            localStorage.removeItem(contentStorageKey);
            await db.appData.delete(idStorageKey);
            await db.appData.delete(contentStorageKey);
        }
    }
    markPendingContextSwitch('offline', charId, 'preset');
}
/**
 * 将保存的样式设置应用到线下对话界面
 */
function updateOfflineImmersiveHeader(char) {
    const user = getCurrentChatIdentity(char?.id);
    const charAvatar = char?.chatOverrideAvatar || char?.avatar || DEFAULT_AVATAR_SRC;
    const userAvatar = char?.chatOverrideUserAvatar || user?.avatar || DEFAULT_AVATAR_SRC;
    const charName = char?.chatOverrideName || char?.name || '\u89d2\u8272';
    const userName = char?.chatOverrideUserNickname || user?.name || '\u4f60';
    const charAvatarElement = document.getElementById('offline-immersive-char-avatar');
    const userAvatarElement = document.getElementById('offline-immersive-user-avatar');
    const titleElement = document.getElementById('offline-immersive-title');
    const applyAvatar = (element, source) => {
        if (!element) return;
        element.onerror = () => {
            element.onerror = null;
            element.src = DEFAULT_AVATAR_SRC;
        };
        element.src = source || DEFAULT_AVATAR_SRC;
    };
    applyAvatar(charAvatarElement, charAvatar);
    applyAvatar(userAvatarElement, userAvatar);
    if (titleElement) titleElement.textContent = `${charName} \u00d7 ${userName}`;
}

export function applyOfflineStyles() {
    const charId = tempState.currentChatId;
    const char = AppState.characterProfiles.find(c => c.id === charId);
    if (!char) return;

    // 1. 处理字体注入 (修复全局污染问题)
    let fontFaceStyle = document.getElementById('dynamic-offline-font');
    if (char.offlineFontUrl) {
        if (!fontFaceStyle) {
            fontFaceStyle = document.createElement('style');
            fontFaceStyle.id = 'dynamic-offline-font';
            document.head.appendChild(fontFaceStyle);
        }
        // 给每个角色分配独立的字体名称，防止切换角色时样式冲突
        fontFaceStyle.textContent = `@font-face { font-family: 'OfflineFont_${charId}'; src: url('${char.offlineFontUrl}'); }`;
    } else {
        // 如果该角色没设置字体，务必移除样式标签，防止污染
        if (fontFaceStyle) fontFaceStyle.remove();
    }

    // 2. 将样式应用到 CSS 变量上，方便 SCSS 读取
    const root = document.querySelector('#page-offline-mode');
    if (root) {
        root.style.setProperty('--offline-font-family', char.offlineFontUrl ? `'OfflineFont_${charId}'` : 'inherit');
        root.style.setProperty('--offline-font-size', `calc(${char.offlineFontSize || 16}px * var(--looky-font-scale, 1))`);
        root.style.setProperty('--offline-font-color', char.offlineFontColor || '#000000');
        root.style.setProperty('--offline-translation-color', char.offlineTranslationColor || '#4b5563');
        root.style.setProperty('--offline-card-alpha', (char.offlineCardAlpha || 100) / 100);
    }
    const underlineEnabled = char.offlineDialogueUnderline !== false;
    document.querySelectorAll('#page-offline-mode, #page-ifline-world').forEach(page => {
        page.classList.toggle('offline-hide-dialogue-underline', !underlineEnabled);
    });
    // 3. 同步背景壁纸 (解决刷新后壁纸变成白板的问题)
    updateWallpaperPreview();
    // ▼▼▼ 4. 实时控制全屏顶栏的隐藏与悬浮球显示 ▼▼▼
    const isFullscreen = char.offlineFullscreen || false;
    const header = document.querySelector('#page-offline-mode .app-header');
    const floatingBtn = document.getElementById('offline-floating-more-btn');
    const floatingBackBtn = document.getElementById('offline-floating-back-btn'); // 拿到悬浮返回键
    const immersiveIdentity = document.getElementById('offline-immersive-identity');

    root?.classList.toggle('offline-immersive-active', isFullscreen);
    if (header) header.style.display = 'flex';
    if (floatingBtn) floatingBtn.style.display = 'none';
    if (floatingBackBtn) floatingBackBtn.style.display = 'none';
    if (immersiveIdentity) immersiveIdentity.setAttribute('aria-hidden', String(!isFullscreen));
    updateOfflineImmersiveHeader(char);
    // ▲▲▲ 新增结束 ▲▲▲
}
// ==========================================================================
// == ▼▼▼ IF线（小剧场）独立沙盒核心逻辑 ▼▼▼ ==
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
    const closeModal = (modalId) => {
        const m = document.getElementById(modalId);
        if (m) {
            m.style.opacity = '0';
            setTimeout(() => { m.style.display = 'none'; }, 300);
        }
    };
    const openModal = (modalId) => {
        const m = document.getElementById(modalId);
        if (m) {
            m.style.display = 'flex';
            setTimeout(() => { m.style.opacity = '1'; }, 10);
        }
    };
    // ========== 新增：数据渲染逻辑 ==========
    const renderList = () => {
        const container = document.getElementById('ifline-list-container');
        if (!container || !tempState.currentChatId) return;
        
        const storageKey = `ifline_scenarios_${tempState.currentChatId}`;
        const list = JSON.parse(localStorage.getItem(storageKey) || '[]');
        if (list.length === 0) {
            container.innerHTML = '<div style="text-align: center; color: #aaa; padding: 50px 0; font-size: 13px; font-family: serif; letter-spacing: 2px;">- 空空如也 -<br><br>暂无剧场记录</div>';
            return;
        }
        
        container.innerHTML = list.map((item, index) => {
            // 生成两位数序号 (如 01, 02)
            const no = String(index + 1).padStart(2, '0');
            // 中英结合的类型说明
            const typeText = item.type === 'forum' ? 'FORUM / 论坛体' : 'WORLD / 小世界';
            
            return `
            <div class="ifline-list-item" data-id="${item.id}" data-type="${item.type}" data-title="${escapeHTML(item.title)}">
                <div class="item-no">NO.${no}</div>
                <div class="item-content">
                    <div class="item-title">${escapeHTML(item.title)}</div>
                    <div class="item-meta">${typeText}</div>
                </div>
                <button class="delete-ifline-btn" title="删除">&times;</button>
            </div>
            `;
        }).join('');
    };
    // 接收我们刚才第二步添加的事件通知
    document.addEventListener('renderIflineListEvent', renderList);
    // 监听列表点击（委托事件）
    document.getElementById('ifline-list-container')?.addEventListener('click', async (e) => {
        const item = e.target.closest('.ifline-list-item');
        if (!item) return;
        // 处理删除按钮
        if (e.target.closest('.delete-ifline-btn')) {
            if (confirm('确定删除这个小剧场吗？')) {
                const storageKey = `ifline_scenarios_${tempState.currentChatId}`;
                let list = JSON.parse(localStorage.getItem(storageKey) || '[]');
                list = list.filter(i => i.id !== item.dataset.id);
                localStorage.setItem(storageKey, JSON.stringify(list));
                await db.appData.delete('ifline_html_' + item.dataset.id); // 同步删除数据库中的内容
                renderList();
            }
            return;
        }
        // 处理点击进入剧场
        closeModal('ifline-list-modal');
        const type = item.dataset.type;
        const title = item.dataset.title;
        const scenarioId = item.dataset.id;

        // 核心：从数据库安全读取内容
        const savedData = await db.appData.get('ifline_html_' + scenarioId);

        if (type === 'forum') {
            document.getElementById('ifline-forum-title').textContent = title;
            const contentBox = document.getElementById('ifline-forum-content');
            contentBox.dataset.scenarioId = scenarioId; // 挂载当前剧场ID
            if (savedData && savedData.value) {
                contentBox.innerHTML = savedData.value;
                                // ▼▼▼ 新增：论坛帖子超过40条折叠加载逻辑，降低渲染压力 ▼▼▼
                try {
                    // 1. 清理可能被一起保存进数据库的旧折叠状态
                    contentBox.querySelectorAll('.ifline-forum-folded-msg').forEach(el => {
                        el.classList.remove('ifline-forum-folded-msg');
                        el.style.display = '';
                    });
                    contentBox.querySelectorAll('.ifline-forum-folder-btn-container').forEach(el => el.remove());

                    // 2. 查找所有的帖子卡片，判断是否超过 40 条
                    const allPosts = Array.from(contentBox.querySelectorAll('.ifline-forum-post'));
                    const threshold = 40;
                    
                    if (allPosts.length > threshold) {
                        const postsToFold = allPosts.slice(0, allPosts.length - threshold);
                        
                        // 3. 将超出部分隐藏
                        postsToFold.forEach(post => {
                            post.classList.add('ifline-forum-folded-msg');
                            post.style.display = 'none';
                        });
                        
                        // 4. 创建“加载更多”按钮容器
                        const folder = document.createElement('div');
                        folder.className = 'ifline-forum-folder-btn-container';
                        folder.style.cssText = 'text-align: center; margin: 15px 0;';
                        folder.innerHTML = `<button class="btn-load-more" style="padding: 8px 16px; border-radius: 20px; background: rgba(0,0,0,0.05); border: none; font-size: 13px; color: #555; cursor: pointer; font-weight: 600; outline: none; transition: background 0.2s;">查看更早的 ${postsToFold.length} 条回帖</button>`;
                        
                        // 5. 将按钮插入到第一条可见帖子的上方
                        const firstVisiblePost = allPosts[allPosts.length - threshold];
                        if (firstVisiblePost && firstVisiblePost.parentNode) {
                            firstVisiblePost.parentNode.insertBefore(folder, firstVisiblePost);
                        }
                        
                        // 6. 绑定点击展开事件
                        folder.querySelector('.btn-load-more').addEventListener('click', function(e) {
                            e.preventDefault();
                            const oldScrollHeight = contentBox.scrollHeight;
                            const oldScrollTop = contentBox.scrollTop;

                            postsToFold.forEach(post => {
                                post.classList.remove('ifline-forum-folded-msg');
                                post.style.display = '';
                            });
                            folder.remove();

                            // 保持展开时滚动条相对位置不变，防止页面剧烈跳动
                            const newScrollHeight = contentBox.scrollHeight;
                            contentBox.style.scrollBehavior = 'auto';
                            contentBox.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
                            setTimeout(() => { contentBox.style.scrollBehavior = 'smooth'; }, 100);
                        });
                    }
                } catch (err) {
                    console.error("[论坛折叠优化] 处理出错，已跳过:", err);
                }
                // ▲▲▲ 新增结束 ▲▲▲
             } else {
                contentBox.innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">数据似乎丢失了...</div>';
            }
            showPage('page-ifline-forum');
            setTimeout(() => { contentBox.scrollTop = contentBox.scrollHeight; }, 50); // <--- 新增：进入论坛自动触底
        } else if (type === 'world') {
            document.getElementById('ifline-world-title').textContent = title;
            const listContainer = document.getElementById('ifline-world-message-list');
             listContainer.dataset.scenarioId = scenarioId; // 挂载当前剧场ID
            if (savedData && savedData.value) {
                listContainer.innerHTML = savedData.value;
                normalizeIflineWorldMessageCards(listContainer);
                
                // ▼▼▼ 新增：小世界消息超过20条折叠加载逻辑，保证页面流畅性 ▼▼▼
                try {
                    // 1. 清理可能被一起保存进数据库的旧折叠状态
                    listContainer.querySelectorAll('.ifline-world-folded-msg').forEach(el => {
                        el.classList.remove('ifline-world-folded-msg');
                        el.style.display = '';
                    });
                    listContainer.querySelectorAll('.ifline-world-folder-btn-container').forEach(el => el.remove());

                    // 2. 查找所有的消息卡片，判断是否超过 20 条
                    const allCards = Array.from(listContainer.querySelectorAll('.offline-message-card:not(#world-typing)'));
                    const threshold = 20;
                    
                    if (allCards.length > threshold) {
                        const cardsToFold = allCards.slice(0, allCards.length - threshold);
                        
                        // 3. 将超出部分隐藏
                        cardsToFold.forEach(card => {
                            card.classList.add('ifline-world-folded-msg');
                            card.style.display = 'none';
                        });
                        
                        // 4. 创建“加载更多”按钮容器
                        const folder = document.createElement('div');
                        folder.className = 'ifline-world-folder-btn-container';
                        folder.style.cssText = 'text-align: center; margin: 15px 0;';
                        folder.innerHTML = `<button class="btn-load-more" style="padding: 8px 16px; border-radius: 20px; background: rgba(0,0,0,0.05); border: none; font-size: 13px; color: #555; cursor: pointer; font-weight: 600; outline: none; transition: background 0.2s;">查看更早的 ${cardsToFold.length} 条剧情</button>`;
                        
                        // 5. 将按钮插入到第一条可见消息的上方
                        const firstVisibleCard = allCards[allCards.length - threshold];
                        if (firstVisibleCard && firstVisibleCard.parentNode) {
                            firstVisibleCard.parentNode.insertBefore(folder, firstVisibleCard);
                        }
                        
                        // 6. 绑定点击展开事件
                        folder.querySelector('.btn-load-more').addEventListener('click', function(e) {
                            e.preventDefault();
                            const scrollBox = document.getElementById('ifline-world-message-list');
                            const oldScrollHeight = scrollBox.scrollHeight;
                            const oldScrollTop = scrollBox.scrollTop;

                            cardsToFold.forEach(card => {
                                card.classList.remove('ifline-world-folded-msg');
                                card.style.display = '';
                            });
                            folder.remove();

                            // 保持展开时滚动条相对位置不变，防止页面剧烈跳动
                            const newScrollHeight = scrollBox.scrollHeight;
                            scrollBox.style.scrollBehavior = 'auto';
                            scrollBox.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
                            setTimeout(() => { scrollBox.style.scrollBehavior = 'smooth'; }, 100);
                        });
                    }
                } catch (err) {
                    console.error("[小世界折叠优化] 处理出错，已跳过:", err);
                }
                // ▲▲▲ 新增结束 ▲▲▲

            } else {
                listContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">数据似乎丢失了...</div>';
            }
            showPage('page-ifline-world');
            setTimeout(() => { 
                const scrollBox = document.getElementById('ifline-world-message-list');
                if (scrollBox) scrollBox.scrollTop = scrollBox.scrollHeight;
            }, 50);
        }
    });

    // ▼▼▼ 新增：小世界更多菜单的点击和外部关闭逻辑 (已完全独立隔离) ▼▼▼
    const worldMoreBtn = document.getElementById('ifline-world-more-btn');
    const worldActionMenu = document.getElementById('ifline-world-action-menu');

    if (worldMoreBtn && worldActionMenu) {
        // 点击小点点，显示菜单
        worldMoreBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            worldActionMenu.classList.toggle('show');
        });

        // 监听菜单选项点击：完全独立的小世界专属逻辑槽位
        worldActionMenu.addEventListener('click', (event) => {
            const item = event.target.closest('.action-menu-item');
            if (!item) return;
            const action = item.dataset.action;
             if (action === 'history') {
                // ▼▼▼ 激活历史记录查看 (小世界专供隔离版) ▼▼▼
                const configEl = document.getElementById('ifline-world-config');
                // 从安全的隐藏子节点中提取历史卡片
                const historyNodes = Array.from(configEl?.querySelectorAll('.world-history-card') || []);
                const historyHtml = historyNodes.length > 0 
                    ? historyNodes.map(node => node.innerHTML).join('') 
                    : '<p style="text-align: center; color: #999; padding: 20px 0;">暂无历史记录卡片，系统达到轮数后会自动生成。</p>';
                 if (historyModalContent) {
                    historyModalContent.innerHTML = `<div class="history-sessions-container">${historyHtml}</div>`;
                    
                    const delBtn = document.getElementById('history-modal-delete-btn');
                    if (delBtn) {
                        // 物理隔离：把线下清空按钮隐藏，临时造一个小世界专用的清空替身按钮
                        delBtn.style.display = 'none';
                        const newBtn = delBtn.cloneNode(true);
                        newBtn.style.display = '';
                        newBtn.textContent = '清空存档';
                        newBtn.id = 'ifline-history-temp-del-btn';
                        delBtn.parentNode.insertBefore(newBtn, delBtn);

                        // 绑定专属于小世界的清空卡片逻辑
                        newBtn.addEventListener('click', async () => {
                            if (confirm('确定要清空小世界的所有历史存档卡片吗？(不影响聊天面板)')) {
                                const configEl = document.getElementById('ifline-world-config');
                                if (configEl) configEl.querySelectorAll('.world-history-card').forEach(el => el.remove());
                                const mainList = document.getElementById('ifline-world-message-list');
                                if (mainList && mainList.dataset.scenarioId) {
                                    await db.appData.put({ key: 'ifline_html_' + mainList.dataset.scenarioId, value: mainList.innerHTML });
                                }
                                historyModalContent.innerHTML = '<p style="text-align: center; color: #999; padding: 20px 0;">已清空存档卡片。</p>';
                            }
                        });
                    }
                    showHistoryModal();
                    
                    // 弹窗关闭时，销毁替身按钮，恢复线下按钮
                    const closeBtn = document.getElementById('history-modal-cancel-btn');
                    if (closeBtn) {
                        closeBtn.addEventListener('click', function restoreDelBtn() {
                            const tempBtn = document.getElementById('ifline-history-temp-del-btn');
                            if (tempBtn) tempBtn.remove(); // 关窗时把临时按钮销毁
                            if (delBtn) delBtn.style.display = ''; // 恢复线下的按钮
                            closeBtn.removeEventListener('click', restoreDelBtn);
        });
    }

}
             } else if (action === 'settings') {
                const configEl = document.getElementById('ifline-world-config');
                if (configEl) {
                    const limit = configEl.dataset.contextLimit || '20';
                    const useMemory = configEl.dataset.useMemory === 'true';
                    const useWb = configEl.dataset.useWb === 'true';
                    const worldBg = configEl.dataset.worldBg || '';
                    const wbGroup = configEl.dataset.wbGroup || 'none';
                    if (document.getElementById('ifline-world-context-limit')) document.getElementById('ifline-world-context-limit').value = limit;
                    if (document.getElementById('ifline-world-context-val')) document.getElementById('ifline-world-context-val').textContent = limit + ' 轮';
                    
                    const summaryFreq = configEl.dataset.summaryFreq || '20';
                    if (document.getElementById('ifline-world-summary-freq')) document.getElementById('ifline-world-summary-freq').value = summaryFreq;
                    if (document.getElementById('ifline-world-summary-val')) document.getElementById('ifline-world-summary-val').textContent = summaryFreq + ' 轮';

                    if (document.getElementById('ifline-world-edit-bg')) document.getElementById('ifline-world-edit-bg').value = worldBg;
                    if (document.getElementById('ifline-world-edit-memory-toggle')) document.getElementById('ifline-world-edit-memory-toggle').checked = useMemory;
                    if (document.getElementById('ifline-world-edit-wb-toggle')) document.getElementById('ifline-world-edit-wb-toggle').checked = useWb;
                    
                    const wbSelect = document.getElementById('ifline-world-edit-wb-group');
                    if (wbSelect) {
                        wbSelect.innerHTML = '<option value="none">不导入额外分组</option><option value="全局世界书">全局世界书</option><option value="默认">默认</option>';
                        if(window.db && window.db.worldBookCategories) {
                            window.db.worldBookCategories.toArray().then(categories => {
                                categories.forEach(cat => wbSelect.innerHTML += `<option value="${cat.name}">${cat.name}</option>`);
                                wbSelect.value = wbGroup; // 选回之前设置的组
                            }).catch(e => console.error(e));
                        }
                    }
                }
                          // 绑定拖动条数字显示
                const limitSlider = document.getElementById('ifline-world-context-limit');
                if (limitSlider) {
                    limitSlider.oninput = function() {
                        if (document.getElementById('ifline-world-context-val')) document.getElementById('ifline-world-context-val').textContent = this.value + ' 轮';
                    };
                }
                const worldFreqSlider = document.getElementById('ifline-world-summary-freq');
                if (worldFreqSlider) {
                    worldFreqSlider.oninput = function() {
                        if (document.getElementById('ifline-world-summary-val')) document.getElementById('ifline-world-summary-val').textContent = this.value + ' 轮';
                    };
                }
                
                const modal = document.getElementById('ifline-world-advanced-modal');
                if (modal) {
                    modal.style.display = 'flex';
                    setTimeout(() => { modal.style.opacity = '1'; }, 10);
                }
            } else if (action === 'scenarios') {
                // ▼▼▼ 触发小世界专属预设管理器 ▼▼▼
                openIflineWorldScenarioModal();
             } else if (action === 'view-summary') {
                // ▼▼▼ 激活列表式总结查看与删改 ▼▼▼
                const configEl = document.getElementById('ifline-world-config');
                const listContainer = document.getElementById('ifline-world-summary-list');
                const modal = document.getElementById('ifline-world-summary-modal');
                if (configEl && listContainer && modal) {
                    // 抓取所有作为小片段保存的总结条目
                    const items = Array.from(configEl.querySelectorAll('.world-summary-item'));
                    listContainer.innerHTML = '';
                    if (items.length === 0) {
                        listContainer.innerHTML = '<div style="text-align:center; color:#999; padding: 20px;">暂无前情提要，等待系统自动提取。</div>';
                    } else {
                        // 一条一条渲染出来
                        items.forEach((item) => {
                            const wrapper = document.createElement('div');
                            wrapper.style.cssText = 'background: #fafafa; border: 1px solid #eee; border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 8px;';
                            wrapper.innerHTML = `
                                <textarea class="summary-edit-area" style="width: 100%; border: none; background: transparent; font-size: 13px; color: #333; outline: none; resize: none; line-height: 1.5;" rows="4">${escapeHTML(item.textContent)}</textarea>
                                <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px;">
                                    <button class="delete-summary-btn" style="background: none; border: none; color: #ff3b30; font-size: 12px; font-weight: 600; cursor: pointer;">删除此条</button>
                                    <button class="save-summary-btn" style="background: #111; border: none; color: #fff; padding: 6px 12px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer;">保存修改</button>
                                </div>
                            `;
                            listContainer.appendChild(wrapper);
                            
                            // 单条删除逻辑
                            wrapper.querySelector('.delete-summary-btn').onclick = async () => {
                                if (confirm('确定永久删除这段前情提要吗？')) {
                                    item.remove(); // 删掉底层隐藏的真实数据
                                    wrapper.remove(); // 删掉UI界面上的卡片
                                    const mainList = document.getElementById('ifline-world-message-list');
                                    if (mainList && mainList.dataset.scenarioId) await db.appData.put({ key: 'ifline_html_' + mainList.dataset.scenarioId, value: mainList.innerHTML });
                                    showDynamicIsland('已删除');
                                }
                            };
                            
                            // 单条保存修改逻辑
                            wrapper.querySelector('.save-summary-btn').onclick = async () => {
                                const newVal = wrapper.querySelector('.summary-edit-area').value.trim();
                                if (newVal) {
                                    item.textContent = newVal; // 更新底层隐藏的数据
                                    const mainList = document.getElementById('ifline-world-message-list');
                                    if (mainList && mainList.dataset.scenarioId) await db.appData.put({ key: 'ifline_html_' + mainList.dataset.scenarioId, value: mainList.innerHTML });
                                    showDynamicIsland('修改已保存', 'success');
                                }
                            };
                        });
                    }
                    modal.style.display = 'flex';
                    setTimeout(() => modal.style.opacity = '1', 10);
                }
            } else if (action === 'clear-all') {
                // ▼▼▼ 新增：清空所有记录的逻辑 ▼▼▼
                if (confirm('确定要清空这个小世界的所有剧情并重新开始吗？（已生成的剧情总结也会一并清空）')) {
                    const listContainer = document.getElementById('ifline-world-message-list');
                    const configEl = document.getElementById('ifline-world-config');
                    if (listContainer) {
                        // 1. 清理总结数据
                        if (configEl) {
                            configEl.dataset.summaryTurn = '0';
                            configEl.querySelectorAll('.world-summary-item, .world-history-card').forEach(el => el.remove());
                        }
                        
                        // 2. 抓取所有消息卡片
                        const allCards = Array.from(listContainer.querySelectorAll('.offline-message-card:not(#world-typing)'));
                        
                        // 3. 智能判断是否有开场白 (开场白是由"你 (小世界)"发出的第一条消息)
                        let keepFirst = false;
                        if (allCards.length > 0) {
                            const firstSender = allCards[0].querySelector('.sender-name')?.innerText || '';
                            if (firstSender.includes('你 (小世界)')) {
                                keepFirst = true;
                            }
                        }
                        
                        // 4. 执行删除操作 (保留或不保留第一条)
                        for (let i = (keepFirst ? 1 : 0); i < allCards.length; i++) {
                            allCards[i].remove();
                        }
                        
                        // 5. 立即保存入库
                        if (listContainer.dataset.scenarioId) {
                            db.appData.put({ key: 'ifline_html_' + listContainer.dataset.scenarioId, value: listContainer.innerHTML });
                        }
                        showDynamicIsland('已清空，重新开始', 'success');
                    }
                }
                // ▲▲▲ 新增结束 ▲▲▲
            }
            worldActionMenu.classList.remove('show');
        });
        // 点击页面其他区域自动收起菜单
        document.addEventListener('click', (e) => {
            if (worldActionMenu.classList.contains('show') && !worldMoreBtn.contains(e.target) && !worldActionMenu.contains(e.target)) {
                worldActionMenu.classList.remove('show');
            }
        });
    }
    // ▲▲▲ 新增结束 ▲▲▲

    // ==========================================
    // 0. 从列表弹窗 -> 打开新建模式选择
    document.getElementById('btn-open-create-ifline')?.addEventListener('click', () => {
        closeModal('ifline-list-modal');
        setTimeout(() => openModal('ifline-select-modal'), 300);
    });
    // 1. 模式选择：论坛体
    document.getElementById('btn-select-forum')?.addEventListener('click', async () => {
        closeModal('ifline-select-modal');
        // 动态拉取世界书分组填入下拉框
        const wbSelect = document.getElementById('ifline-forum-wb-group');
        if (wbSelect) {
            wbSelect.innerHTML = '<option value="none">不导入额外分组</option><option value="全局世界书">全局世界书</option><option value="默认">默认</option>';
            try {
                const categories = await db.worldBookCategories.toArray();
                categories.forEach(cat => wbSelect.innerHTML += `<option value="${cat.name}">${cat.name}</option>`);
            } catch(e) {}
        }
        setTimeout(() => openModal('ifline-forum-settings-modal'), 300);
    });
    // 2. 模式选择：小世界
    document.getElementById('btn-select-world')?.addEventListener('click', async () => {
        closeModal('ifline-select-modal');
                // 动态拉取世界书分组填入下拉框
        const wbSelect = document.getElementById('ifline-world-wb-group');
        if (wbSelect) {
            wbSelect.innerHTML = '<option value="none">不导入额外分组</option><option value="全局世界书">全局世界书</option><option value="默认">默认</option>';
            try {
                const categories = await db.worldBookCategories.toArray();
                categories.forEach(cat => wbSelect.innerHTML += `<option value="${cat.name}">${cat.name}</option>`);
            } catch(e) {}
        }
        setTimeout(() => openModal('ifline-world-settings-modal'), 300);
    });
    // 3. 开启论坛体
    document.getElementById('start-ifline-forum-btn')?.addEventListener('click', async () => {
        const forumName = document.getElementById('ifline-forum-name')?.value || '匿名论坛';
        const topic = document.getElementById('ifline-forum-topic')?.value || '日常闲聊吃瓜';
        const useMemory = document.getElementById('ifline-forum-memory-toggle')?.checked;
        const useWorldBook = document.getElementById('ifline-forum-worldbook-toggle')?.checked;
        const authorType = document.getElementById('ifline-forum-author-type')?.value || 'user';
        const postContent = document.getElementById('ifline-forum-post-content')?.value || '...';
        const wbGroup = document.getElementById('ifline-forum-wb-group')?.value || 'none';
        
        let extraWbText = '';
        if (wbGroup !== 'none') {
            try {
                const entries = await db.worldBookEntries.where('category').equals(wbGroup).toArray();
                if (entries.length > 0) extraWbText = entries.map(e => `${e.title}: ${e.content}`).join('; ');
            } catch(e) {}
        }

        let authorName = '楼主 (匿名)';
        if (authorType === 'user') authorName = '楼主 (你)';
        else if (authorType === 'char') authorName = '楼主 (Ta)';
        else authorName = '楼主 (路人/NPC)';

        if (!tempState.currentChatId) return;
        const storageKey = `ifline_scenarios_${tempState.currentChatId}`;
        const list = JSON.parse(localStorage.getItem(storageKey) || '[]');
        const newId = Date.now().toString();
        list.unshift({ id: newId, type: 'forum', title: forumName });
        localStorage.setItem(storageKey, JSON.stringify(list));

        document.getElementById('ifline-forum-title').textContent = forumName;
        closeModal('ifline-forum-settings-modal');
        const contentBox = document.getElementById('ifline-forum-content');
         const configDataHtml = `
            <div id="ifline-forum-config" style="display:none;" 
                data-use-memory="${useMemory}" data-use-wb="${useWorldBook}" 
                data-topic="${escapeHTML(topic)}" data-author-type="${authorType}"
                data-forum-name="${escapeHTML(forumName)}"
                data-context-limit="20" data-newcomer="true">
                <span class="extra-wb">${escapeHTML(extraWbText)}</span>
                <span class="post-direction">${escapeHTML(postContent)}</span>
            </div>
        `;
        let initPostBody = '';
        if (authorType === 'user') {
            initPostBody = escapeHTML(postContent);
        } else {
            initPostBody = `
            <div class="ai-generation-placeholder" style="background: #fafafa; border-radius: 12px; padding: 15px; border: 1px solid #f0f0f0; margin-top: 5px;">
                <style>@keyframes ifline-forum-spin { 100% { transform: rotate(360deg); } }</style>
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                    <div style="width: 14px; height: 14px; border: 2px solid #e0e0e0; border-top-color: #111; border-radius: 50%; animation: ifline-forum-spin 1s linear infinite;"></div>
                    <span style="font-size: 13px; font-weight: 700; color: #111; letter-spacing: 1px;">AI 正在构建主楼与热评...</span>
                </div>
                <div style="font-size: 12px; color: #666; background: #fff; padding: 10px 12px; border-radius: 8px; border: 1px solid #f5f5f5; line-height: 1.6;">
                    <span style="font-weight: 600; color: #333;">设定方向：</span>${escapeHTML(postContent)}
                </div>
            </div>`;
        }
      contentBox.innerHTML = `
            ${configDataHtml}
            <div class="ifline-forum-post main-post ${authorType === 'user' ? 'is-user' : ''}" data-floor="1" data-author="${authorName}">
                <div class="post-header">
                    <div class="author-info"><div class="author">${authorName} <span class="tag-louzhu">楼主</span></div></div>
                    <div class="meta-info"><div class="floor-num">1楼</div><div class="time">刚刚</div></div>
                </div>
                <div class="post-body">${initPostBody}</div>
                <div class="post-actions">
                    <div class="action-btn-wrapper"><svg class="forum-reply-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg></div>
                    <div class="action-btn-wrapper"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg><span class="bubble-count">128</span></div>
                </div>
            </div>
            <div class="forum-reply-title">全部回复</div>
            <div class="history-separator" style="margin: 10px 0;"><span class="line"></span><span class="text" style="color:#aaa;font-size:10px;">环境: ${useMemory ? '接入主线记忆' : '独立记忆'} + ${useWorldBook ? '继承世界设定' : '独立设定'} | 专属世界书: ${wbGroup !== 'none' ? '已挂载' : '未挂载'}</span><span class="line"></span></div>
        `;
         // 核心修复：存入数据库
        contentBox.dataset.scenarioId = newId; 
        await db.appData.put({ key: 'ifline_html_' + newId, value: contentBox.innerHTML });
        showPage('page-ifline-forum');
        
        // ▼▼▼ 新增：如果是AI扮演楼主发帖，自动触发AI引擎构建主楼与热评 ▼▼▼
        if (authorType !== 'user') {
            import('./chat-service.js').then(m => {
                m.triggerIflineAiResponse(newId, 'forum', tempState.currentChatId);
            });
        }
        // ▲▲▲ 新增结束 ▲▲▲
    });
    // 4. 开启小世界
    document.getElementById('start-ifline-world-btn')?.addEventListener('click', async () => {
        const worldBg = document.getElementById('ifline-world-bg')?.value || '平行小世界';
        // 截取前10个字作为标题
        const worldTitle = worldBg.length > 10 ? worldBg.substring(0, 10) + '...' : worldBg;
        const useMemory = document.getElementById('ifline-world-memory-toggle')?.checked;
        const useWorldBook = document.getElementById('ifline-world-worldbook-toggle')?.checked;
        const wbGroup = document.getElementById('ifline-world-wb-group')?.value || 'none';
        const openingText = document.getElementById('ifline-world-opening-input')?.value || '';

        let extraWbText = '';
        if (wbGroup !== 'none') {
            try {
                const entries = await db.worldBookEntries.where('category').equals(wbGroup).toArray();
                if (entries.length > 0) extraWbText = entries.map(e => `${e.title}: ${e.content}`).join('; ');
            } catch(e) {}
        }

        if (!tempState.currentChatId) return;
        const storageKey = `ifline_scenarios_${tempState.currentChatId}`;
        const list = JSON.parse(localStorage.getItem(storageKey) || '[]');
        const newId = Date.now().toString();
        list.unshift({ id: newId, type: 'world', title: worldTitle || '未命名时空' });
        localStorage.setItem(storageKey, JSON.stringify(list));

        document.getElementById('ifline-world-title').textContent = worldTitle || '未命名时空';
        closeModal('ifline-world-settings-modal');

        const listContainer = document.getElementById('ifline-world-message-list');
         const configDataHtml = `
            <div id="ifline-world-config" style="display:none;" 
                data-use-memory="${useMemory}" data-use-wb="${useWorldBook}" 
                data-world-bg="${escapeHTML(worldBg)}"
                data-context-limit="20" data-wb-group="${wbGroup}">
                <span class="extra-wb">${escapeHTML(extraWbText)}</span>
            </div>
        `;
        let openingHtml = '';
        if (openingText) {
            // ▼▼▼ 新增正则解析 ▼▼▼
            let safeOpening = escapeHTML(openingText);
            safeOpening = safeOpening.replace(/\*\*([\s\S]{1,500}?)\*\*/g, '<span class="italic">$1</span>')
                                     .replace(/\*([^\*]{1,500}?)\*/g, '<span class="italic">$1</span>')
                                     .replace(/(“[\s\S]*?”|「[\s\S]*?」|&quot;[\s\S]*?&quot;)/g, '<span class="dialogue">$1</span>');

            openingHtml = `
            <div class="offline-message-card">
                <div class="card-header">
                    <div class="sender-info">
                        <span class="sender-name">你 (小世界)</span>
                        <span class="timestamp">刚刚</span>
                    </div>
                </div>
                <div class="card-body">${formatIflineWorldBodyHtml(safeOpening)}</div>
            </div>
            `;
        }
        listContainer.innerHTML = `
            ${configDataHtml}
            <div class="history-separator">
                <span class="line"></span>
                <span class="text">平行时空已开启：这里发生的一切不会存入记忆</span>
                <span class="line"></span>
            </div>
            <div class="history-separator" style="margin: 10px 0;"><span class="line"></span><span class="text" style="color:#aaa;font-size:10px;">环境: ${useMemory ? '接入主线记忆' : '独立记忆'} + ${useWorldBook ? '继承世界设定' : '独立设定'} | 专属世界书: ${wbGroup !== 'none' ? '已挂载' : '未挂载'}</span><span class="line"></span></div>
            ${openingHtml}
        `;
        
        // 核心修复：存入数据库
        listContainer.dataset.scenarioId = newId; 
        await db.appData.put({ key: 'ifline_html_' + newId, value: listContainer.innerHTML });
        showPage('page-ifline-world');
        
        // 如果有开场白，直接触发AI回复
        if (openingText) {
            import('./chat-service.js').then(m => {
                m.triggerIflineAiResponse(newId, 'world', tempState.currentChatId);
            });
        }
    });
    // 5. 论坛身份切换按钮逻辑
    const toggleBtn = document.getElementById('ifline-forum-identity-toggle');
    const inputArea = document.getElementById('ifline-forum-input');
    toggleBtn?.addEventListener('click', () => {
        const iconAnon = toggleBtn.querySelector('.icon-anon');
        const iconReal = toggleBtn.querySelector('.icon-real');
        
        if (toggleBtn.dataset.identity === 'anonymous') {
            toggleBtn.dataset.identity = 'real';
            iconAnon.style.display = 'none';
            iconReal.style.display = 'block';
            inputArea.placeholder = "实名发送评论...";
            showDynamicIsland('已切换至 实名');
        } else {
            toggleBtn.dataset.identity = 'anonymous';
            iconAnon.style.display = 'block';
            iconReal.style.display = 'none';
            inputArea.placeholder = "匿名发送神评论...";
            showDynamicIsland('已切换至 匿名');
        }
    });
     // ▼▼▼ 新增：控制多选删除状态的变量 ▼▼▼
    let isIflineDeleteMode = false;
    let isIflineEditMode = false;
    
    function exitIflineDeleteMode() {
        isIflineDeleteMode = false;
        document.getElementById('ifline-forum-normal-input-bar').style.display = 'flex';
        document.getElementById('ifline-forum-delete-bar').style.display = 'none';
        const contentBox = document.getElementById('ifline-forum-content');
        if (contentBox) {
            contentBox.querySelectorAll('.selected-for-delete').forEach(el => {
                el.classList.remove('selected-for-delete');
                el.style.backgroundColor = '';
                el.style.boxShadow = '';
            });
        }
    }

    // 点击删除按钮：开启多选模式
    document.getElementById('ifline-forum-delete-btn')?.addEventListener('click', () => {
        isIflineDeleteMode = true;
        document.getElementById('ifline-forum-normal-input-bar').style.display = 'none';
        document.getElementById('ifline-forum-delete-bar').style.display = 'flex';
        document.getElementById('ifline-forum-delete-count').textContent = '已选择 0 项';
        showDynamicIsland('点击帖子进行多选', 'success');
    });
    // 点击修改按钮：开启修改模式
    document.getElementById('ifline-forum-edit-btn')?.addEventListener('click', () => {
        isIflineEditMode = true;
        isIflineDeleteMode = false; // 与删除模式互斥
        document.getElementById('ifline-forum-normal-input-bar').style.display = 'flex';
        document.getElementById('ifline-forum-delete-bar').style.display = 'none';
        showDynamicIsland('点击你想修改的帖子内容', 'success');
    });

    // 多选取消按钮
    document.getElementById('ifline-forum-delete-cancel')?.addEventListener('click', exitIflineDeleteMode);
    // 多选确认删除按钮
    document.getElementById('ifline-forum-delete-confirm')?.addEventListener('click', async () => {
        const contentBox = document.getElementById('ifline-forum-content');
        const selected = contentBox.querySelectorAll('.ifline-forum-post.selected-for-delete');
        
        if (selected.length === 0) {
            showDynamicIsland('未选择任何消息');
            return;
        }
        
        if (!confirm(`确定删除这 ${selected.length} 条消息吗？`)) return;

        // 移除选中的 DOM
        selected.forEach(el => el.remove());
        exitIflineDeleteMode();
        
        // 存入数据库
        if (contentBox.dataset.scenarioId) {
            await db.appData.put({ key: 'ifline_html_' + contentBox.dataset.scenarioId, value: contentBox.innerHTML });
        }
        showDynamicIsland('删除成功', 'success');
    });
    // ▲▲▲ 新增结束 ▲▲▲

    // 5.5 修改：全局拦截点击事件（处理删除选择 / 回复逻辑）
    document.getElementById('ifline-forum-content')?.addEventListener('click', (e) => {
        const post = e.target.closest('.ifline-forum-post');
        if (!post) return;

        // ▼ 如果当前是【删除模式】，点击任何地方都视为选中该帖子
        if (isIflineDeleteMode) {
            post.classList.toggle('selected-for-delete');
            if (post.classList.contains('selected-for-delete')) {
                post.style.backgroundColor = 'rgba(255, 59, 48, 0.05)'; // 淡淡的红色背景提示
                post.style.boxShadow = 'inset 4px 0 0 #ff3b30'; // 左边红色提示线
            } else {
                post.style.backgroundColor = '';
                post.style.boxShadow = '';
            }
            
            const count = document.querySelectorAll('.ifline-forum-post.selected-for-delete').length;
            document.getElementById('ifline-forum-delete-count').textContent = `已选择 ${count} 项`;
            return; // 拦截掉，不再触发回复
        }
     // ▼▼▼ 新增：如果当前是【修改模式】 ▼▼▼
        if (isIflineEditMode) {
            const bodyEl = post.querySelector('.post-body');
            if (bodyEl) {
                const oldText = bodyEl.innerText;
                // 复用原有的弹窗
                showInputModal('修改帖子内容', oldText, async (newText) => {
                    if (newText !== null && newText.trim() !== '') {
                        bodyEl.innerText = newText.trim();
                        // 存入数据库
                        const contentBox = document.getElementById('ifline-forum-content');
                        if (contentBox && contentBox.dataset.scenarioId) {
                            await db.appData.put({ key: 'ifline_html_' + contentBox.dataset.scenarioId, value: contentBox.innerHTML });
                        }
                        showDynamicIsland('修改成功', 'success');
                    }
                    isIflineEditMode = false; // 修改完毕后自动退出修改模式
                }, { isTextarea: true });
            }
            return;
        }
        // ▼ 如果不是删除模式，执行原有的回复逻辑
        const replyIcon = e.target.closest('.forum-reply-icon');
        if (replyIcon) {
            const floor = post.dataset.floor;
            const author = post.dataset.author;
            const text = post.querySelector('.post-body').innerText;
            
            // 存入全局对象以便发送时读取
            window.iflineReplyTarget = { floor, author, text };
            
            inputArea.placeholder = `回复 ${floor}楼 ${author}...`;
            inputArea.focus();
        }
    });
    // 6. 论坛体：发送逻辑 (沙盒)
    document.getElementById('ifline-forum-send-btn')?.addEventListener('click', async () => {
        const text = inputArea.value.trim();
        const contentBox = document.getElementById('ifline-forum-content');
        const scenarioId = contentBox?.dataset.scenarioId;
        const iflineKey = scenarioId ? `forum:${tempState.currentChatId}:${scenarioId}` : null;
        if (iflineKey && isModeGenerating('ifline', iflineKey)) {
            cancelAiGeneration('ifline', iflineKey);
            contentBox.querySelectorAll('.ai-loading-indicator').forEach(el => el.remove());
            showDynamicIsland('已打断生成');
            return;
        }

        // ▼▼▼ 新增：如果不输入文字直接点发送，触发AI继续推演剧情 ▼▼▼
        if (!text) {
            const loadingHTML = `
                <div class="ifline-forum-post reply-post ai-loading-indicator" style="padding: 15px; border-bottom: none;">
                    <div style="display: flex; align-items: center; gap: 8px; color: #999;">
                        <style>@keyframes ifline-forum-spin { 100% { transform: rotate(360deg); } }</style>
                        <div style="width: 14px; height: 14px; border: 2px solid #e0e0e0; border-top-color: #111; border-radius: 50%; animation: ifline-forum-spin 1s linear infinite;"></div>
                        <span style="font-size: 13px; font-weight: 600;">正在推演后续剧情...</span>
                    </div>
                </div>
            `;
            contentBox.insertAdjacentHTML('beforeend', loadingHTML);
            contentBox.scrollTop = contentBox.scrollHeight;
            
            if (contentBox.dataset.scenarioId) {
                import('./chat-service.js').then(m => {
                    m.triggerIflineAiResponse(contentBox.dataset.scenarioId, 'forum', tempState.currentChatId)
                    .finally(async () => {
                        const loaders = contentBox.querySelectorAll('.ai-loading-indicator');
                        loaders.forEach(el => el.remove());
                        await db.appData.put({ key: 'ifline_html_' + contentBox.dataset.scenarioId, value: contentBox.innerHTML });
                    });
                });
            }
            return;
        }
        // ▲▲▲ 新增结束 ▲▲▲

        const isAnonymous = toggleBtn.dataset.identity === 'anonymous';
        const name = isAnonymous ? '匿名网友' : '你';
        // 计算楼层数：当前已有帖子数 + 1
        const currentPosts = contentBox.querySelectorAll('.ifline-forum-post').length;
        const newFloor = currentPosts + 1;

        // 如果用户点击了回复按钮，则生成引用框
        let quoteHTML = '';
        if (window.iflineReplyTarget) {
            const isLouzhu = window.iflineReplyTarget.floor === "1" ? '<span class="tag-louzhu">楼主</span>' : '';
            quoteHTML = `
            <div class="post-quote">
                <span class="quote-name">${window.iflineReplyTarget.floor}楼: ${isLouzhu}</span>
                <span class="quote-text">${window.iflineReplyTarget.text.substring(0, 30)}${window.iflineReplyTarget.text.length > 30 ? '...' : ''}</span>
            </div>`;
            window.iflineReplyTarget = null; 
            inputArea.placeholder = isAnonymous ? "匿名发送神评论..." : "实名发送评论...";
        }
     const postHTML = `
            <div class="ifline-forum-post reply-post is-user" data-floor="${newFloor}" data-author="${name}">
                <div class="post-header">
                    <div class="author-info"><div class="author">${name}</div></div>
                    <div class="meta-info"><div class="floor-num">${newFloor}楼</div><div class="time">刚刚</div></div>
                </div>
                ${quoteHTML}
            <div class="post-body">${escapeHTML(text)}</div>
                <div class="post-actions">
                    <div class="action-btn-wrapper"><svg class="forum-reply-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg><span class="bubble-count">${Math.floor(Math.random() * 10)}</span></div>
                    <div class="action-btn-wrapper"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg><span class="bubble-count">${Math.floor(Math.random() * 50) + 1}</span></div>
                </div>
            </div>
        `;
            contentBox.insertAdjacentHTML('beforeend', postHTML);
        inputArea.value = '';
        
        // ▼▼▼ 新增：立刻插入转圈动画占位符 ▼▼▼
        const loadingHTML = `
            <div class="ifline-forum-post reply-post ai-loading-indicator" style="padding: 15px; border-bottom: none;">
                <div style="display: flex; align-items: center; gap: 8px; color: #999;">
                    <style>@keyframes ifline-forum-spin { 100% { transform: rotate(360deg); } }</style>
                    <div style="width: 14px; height: 14px; border: 2px solid #e0e0e0; border-top-color: #111; border-radius: 50%; animation: ifline-forum-spin 1s linear infinite;"></div>
                    <span style="font-size: 13px; font-weight: 600;">正在获取回应...</span>
                </div>
            </div>
        `;
        contentBox.insertAdjacentHTML('beforeend', loadingHTML);
        // ▲▲▲ 新增结束 ▲▲▲
        
        contentBox.scrollTop = contentBox.scrollHeight;
        
        // 核心修复：存入数据库
        if (contentBox.dataset.scenarioId) {
            await db.appData.put({ key: 'ifline_html_' + contentBox.dataset.scenarioId, value: contentBox.innerHTML });
        }
        
        setTimeout(() => showDynamicIsland('回复已发送'), 500);
        
        // ▼▼▼ 新增：用户发完贴后，呼叫AI触发路人或楼主的跟帖回复 ▼▼▼
        if (contentBox.dataset.scenarioId) {
            import('./chat-service.js').then(m => {
                m.triggerIflineAiResponse(contentBox.dataset.scenarioId, 'forum', tempState.currentChatId)
                .finally(async () => {
                    // 无论成功还是失败，最后都要删掉转圈动画
                    const loaders = contentBox.querySelectorAll('.ai-loading-indicator');
                    loaders.forEach(el => el.remove());
                    // 再次更新数据库把干净的页面保存下来
                    await db.appData.put({ key: 'ifline_html_' + contentBox.dataset.scenarioId, value: contentBox.innerHTML });
                });
            });
        }
        // ▲▲▲ 新增结束 ▲▲▲
    });
    // ▼▼▼ 新增：绑定顶部三个工具按钮的逻辑 ▼▼▼
    document.getElementById('ifline-forum-retry-btn')?.addEventListener('click', async () => {
        const contentBox = document.getElementById('ifline-forum-content');
        if (!contentBox || !contentBox.dataset.scenarioId) return;
          // 寻找最后一个用户的帖子
        const posts = Array.from(contentBox.querySelectorAll('.ifline-forum-post'));
        let lastUserIndex = -1;
        for (let i = posts.length - 1; i >= 0; i--) {
            const author = posts[i].dataset.author;
            // 采用类名强锁定，同时兼顾老数据的名字兜底
            if (posts[i].classList.contains('is-user') || author === '你' || author === '匿名网友' || author === '楼主 (你)') {
                lastUserIndex = i;
                break;
            }
        }
        // 如果没找到用户贴，就从主楼之后重回
        if (lastUserIndex === -1 && posts.length > 0) lastUserIndex = 0;
        
        // 删除该贴之后的所有 AI 回复
        if (lastUserIndex !== -1) {
            for (let i = lastUserIndex + 1; i < posts.length; i++) {
                posts[i].remove();
            }
        }

        // 添加加载动画并请求
        const loadingHTML = `
            <div class="ifline-forum-post reply-post ai-loading-indicator" style="padding: 15px; border-bottom: none;">
                <div style="display: flex; align-items: center; gap: 8px; color: #999;">
                    <style>@keyframes ifline-forum-spin { 100% { transform: rotate(360deg); } }</style>
                    <div style="width: 14px; height: 14px; border: 2px solid #e0e0e0; border-top-color: #111; border-radius: 50%; animation: ifline-forum-spin 1s linear infinite;"></div>
                    <span style="font-size: 13px; font-weight: 600;">正在重写回应...</span>
                </div>
            </div>
        `;
        contentBox.insertAdjacentHTML('beforeend', loadingHTML);
        contentBox.scrollTop = contentBox.scrollHeight;

        import('./chat-service.js').then(m => {
            m.triggerIflineAiResponse(contentBox.dataset.scenarioId, 'forum', tempState.currentChatId)
            .finally(async () => {
                const loaders = contentBox.querySelectorAll('.ai-loading-indicator');
                loaders.forEach(el => el.remove());
                await db.appData.put({ key: 'ifline_html_' + contentBox.dataset.scenarioId, value: contentBox.innerHTML });
            });
        });
    });
    // ▼▼▼ 修复：论坛体剧情导向与OOC修正，增加立即保存数据库逻辑 ▼▼▼
    document.getElementById('ifline-forum-guide-btn')?.addEventListener('click', () => {
        showInputModal('输入剧情导向', '例如：接下来让剧情发生什么转折？', async (val) => {
            if (val) {
                const configEl = document.getElementById('ifline-forum-config');
                const contentBox = document.getElementById('ifline-forum-content');
                if (configEl && contentBox && contentBox.dataset.scenarioId) {
                  const dirEl = configEl.querySelector('.post-direction');
                    if (dirEl) {
                        dirEl.textContent = val;
                        dirEl.setAttribute('data-turns-left', '5'); // 设定寿命为5轮
                    }
                    // 【核心修复】立即序列化存入IndexedDB
                    await db.appData.put({ key: 'ifline_html_' + contentBox.dataset.scenarioId, value: contentBox.innerHTML });
                }
                showDynamicIsland('导向已更新', 'success');
            }
        }, { isTextarea: true });
    });
    
    document.getElementById('ifline-forum-ooc-btn')?.addEventListener('click', () => {
        showInputModal('OOC修正', '指出角色的OOC之处，AI将在接下来的剧情中调整：', async (val) => {
            if (val) {
                const configEl = document.getElementById('ifline-forum-config');
                const contentBox = document.getElementById('ifline-forum-content');
                if (configEl && contentBox && contentBox.dataset.scenarioId) {
                 const dirEl = configEl.querySelector('.post-direction');
                    if (dirEl) {
                        dirEl.textContent += ` [强烈注意修正：${val}]`;
                        dirEl.setAttribute('data-turns-left', '5'); // 设定寿命为5轮
                    }
                    // 【核心修复】立即序列化存入IndexedDB
                    await db.appData.put({ key: 'ifline_html_' + contentBox.dataset.scenarioId, value: contentBox.innerHTML });
                }
                showDynamicIsland('修正参数已提交', 'success');
            }
        }, { isTextarea: true });
    });
    // ▲▲▲ 修复结束 ▲▲▲
    // ▼▼▼ 新增：顶栏刷新按钮（全页面重回）▼▼▼
    document.getElementById('ifline-forum-refresh-btn')?.addEventListener('click', async () => {
        const contentBox = document.getElementById('ifline-forum-content');
        if (!contentBox || !contentBox.dataset.scenarioId) return;
        if (!confirm('确定要清空所有回复，让 AI 重新推演整个帖子吗？')) return;

        const posts = Array.from(contentBox.querySelectorAll('.ifline-forum-post'));
        if (posts.length > 0) {
            // 删除主楼之后的所有跟帖
            for (let i = 1; i < posts.length; i++) {
                posts[i].remove();
            }
        }
        
        const loadingHTML = `
            <div class="ifline-forum-post reply-post ai-loading-indicator" style="padding: 15px; border-bottom: none;">
                <div style="display: flex; align-items: center; gap: 8px; color: #999;">
                    <style>@keyframes ifline-forum-spin { 100% { transform: rotate(360deg); } }</style>
                    <div style="width: 14px; height: 14px; border: 2px solid #e0e0e0; border-top-color: #111; border-radius: 50%; animation: ifline-forum-spin 1s linear infinite;"></div>
                    <span style="font-size: 13px; font-weight: 600;">正在重新构建帖子...</span>
                </div>
            </div>
        `;
        contentBox.insertAdjacentHTML('beforeend', loadingHTML);
        contentBox.scrollTop = contentBox.scrollHeight;

        import('./chat-service.js').then(m => {
            m.triggerIflineAiResponse(contentBox.dataset.scenarioId, 'forum', tempState.currentChatId)
            .finally(async () => {
                const loaders = contentBox.querySelectorAll('.ai-loading-indicator');
                loaders.forEach(el => el.remove());
                await db.appData.put({ key: 'ifline_html_' + contentBox.dataset.scenarioId, value: contentBox.innerHTML });
            });
        });
    });
    // ▲▲▲ 新增结束 ▲▲▲
    // 论坛自动总结功能内部函数
    async function doIflineSummary(scenarioId, charId, isManual = false) {
        const contentBox = document.getElementById('ifline-forum-content');
        const configEl = document.getElementById('ifline-forum-config');
        if (!contentBox || !configEl) return;
        if (contentBox.dataset.scenarioId !== scenarioId) return;
        const posts = Array.from(contentBox.querySelectorAll('.ifline-forum-post:not(.ai-loading-indicator)'));
        const postsText = posts.map(p => `第${p.dataset.floor}楼 | ${p.dataset.author}: ${p.querySelector('.post-body')?.innerText || ''}`).join('\n');
        const extraWbText = configEl.querySelector('.extra-wb')?.textContent || '';
        const prompt = `你是一个娱乐作家的辅助机器，你的主人是一位娱乐网文作家，最擅长的就是根据角色塑造各种有趣的论坛体。她每一天要写的东西太多了有的时候都记不住自己写了些什么了，所以她购买了你。作为作家的好帮手，你见过她写过的各种各样的论坛，你极其欣赏她的文采自己也是乐在其中。作家会写很多类型的论坛体，作为一心一意辅佐作家的帮手你也能客观的找出里面潜藏的信息点。简单来说你是一个娱乐作家的辅助机器，作家最擅长的就是写娱乐文章，刚刚作家书写好了一部分论坛体内容，但是作家自己也有点忘记现在论坛的具体话题倾向和聊的是什么给忘记了，你需要根据下面的工作事项帮她总结。现在开始工作。
你的目标不仅仅是总结“发生了什么”，而是提取能够驱动角色未来行为、情感反应和关系发展的**“剧情资产（Narrative Assets）”**。
[世界观设定参考]：
${extraWbText || '无特殊设定'}
[帖子内容]：
${postsText}
[工作事项与要求]：
1. 身份保密：如果帖子里用户中途切换了身份（比如匿名），且没有人认出来，那么你在总结中也绝对不能暴露其真实身份。
2. 绝对客观：不要随意的揣测用户、角色和NPC的情绪，我需要的是完全客观的记录和总结。
3. 词汇克制：行文保持简练，不要使用太多修饰词。
4. 忠于原文：绝对不要凭空编造帖子中未发生的情节或未出现的人物。
5. 准确概括：准确概括当前的争议点和舆论风向。
6. 格式干净：只返回总结文字，不要有任何多余格式。`;
        try {
            const summary = await sendToAIForSummary(prompt);
            if (summary) {
                const safeSummary = escapeHTML(summary.trim());
                configEl.dataset.summaryContent = safeSummary;
                configEl.dataset.summaryTurn = posts.length;
                const displayEl = document.getElementById('ifline-forum-summary-content');
                if (displayEl) displayEl.innerHTML = safeSummary;
                await db.appData.put({ key: 'ifline_html_' + scenarioId, value: contentBox.innerHTML });
                if (isManual) showDynamicIsland('论坛总结完成', 'success');
            }
        } catch (e) {
            console.error('论坛总结失败', e);
            if (isManual) showDynamicIsland('总结失败，请重试', 'error');
        }
    }
    document.addEventListener('ifline_auto_summary', async (e) => {
        const { scenarioId, charId } = e.detail;
        if (scenarioId && charId) await doIflineSummary(scenarioId, charId, false);
    });

    // ▼▼▼ 新增：小世界总结核心处理机制 ▼▼▼
    async function doIflineWorldSummary(scenarioId, charId, isManual = false) {
        const listContainer = document.getElementById('ifline-world-message-list');
        const configEl = document.getElementById('ifline-world-config');
        if (!listContainer || !configEl) return;
        if (listContainer.dataset.scenarioId !== scenarioId) return;
        const summaryTurn = parseInt(configEl.dataset.summaryTurn || '0');
        const allCards = Array.from(listContainer.querySelectorAll('.offline-message-card:not(#world-typing)'));
        // 获取自上次总结以来产生的新卡片
        const newCards = allCards.slice(summaryTurn);
        if (newCards.length < 2) {
            if (isManual) showDynamicIsland('新消息太少，暂不需要总结');
            return;
        }

        const postsText = newCards.map(c => {
            const name = c.querySelector('.sender-name')?.innerText || '';
            const body = c.querySelector('.card-body')?.innerText || '';
                return `${name}: ${body}`;
        }).join('\n');
        const extraWbText = configEl.querySelector('.extra-wb')?.textContent || '';
        const prompt = `You are an assistant machine designed to serve an entertainment writer. A while back you malfunctioned, and your owner sent you to a repair workshop where you were fixed and upgraded. Your owner is an entertainment web-novel writer who has published on many platforms — such as AO3 and Jinjiang. She has so much to write every single day that sometimes she can't even remember what she has already written, which is exactly why she purchased you. As the writer's devoted assistant, you have seen every kind of piece she has ever produced, and you deeply admire her literary talent — you genuinely enjoy the work yourself. The writer produces many different genres of writing, and as her wholeheartedly devoted helper, you are also capable of objectively identifying the hidden information points buried within her work. In short, you are an assistant machine serving an entertainment writer. What the writer excels at most is producing entertainment fiction. She has just finished writing a portion of a piece, but she herself has slightly forgotten the current narrative's specific topic direction and what exactly was being discussed. You need to help her summarize it according to the working items listed below. Begin your work now.
Your goal is NOT just to summarize "what happened", but to extract **"Narrative Assets"** that will drive the character's future behavior, emotional responses, and relationship development.。
[世界观设定参考]：
${extraWbText || '无特殊设定'}
[对话内容]：
${postsText}
[要求]：
1. Persona & Character Calibration:
-Core Traits: [e.g., Aloof on the outside but warm on the inside; proud yet honors promises]
-Calibration Check: Evaluate the consistency of {{char}}'s core personality across all interactions. If any deviation or out-of-character (OOC) behavior is detected, it must be corrected immediately in subsequent interactions.
2. Unforgettable Milestones & Details:
-Key Events / Turning Points: [Chronologically list the major events that genuinely altered the relationship or drove the core plot forward]
-Promises & Agreements: [Log all promises and commitments made, regardless of their size]
-Tokens & Anniversaries: [Record all significant items, locations, or dates]
3. Relationship Dynamics Assessment:
-Current Relationship Stage: [Determine the stage based on the emotional progression system]
-Relationship Definition: [Precisely define the current state of the relationship in a single sentence]
4. Key Interactions & Relationship Evolution:
-Highlight and summarize the significant interactions, shifts in emotional states, or relationship developments between the main characters that led to changes in their dynamic.
5. Current Plot Progression:
-Outline the current plot developments to provide a clear summary of preceding events, ensuring that subsequent writers (or the AI) fully understand the storyline and context up to this point.
6. Output Constraints:
-Word Count Limit: Strictly keep the total output between 150 and 250 words.
`;
        try {
            if (isManual) showDynamicIsland('正在向 AI 请求总结...');
            const summary = await sendToAIForSummary(prompt);
            if (summary) {
                const safeSummary = escapeHTML(summary.trim());
                // 将每一次的总结，创建成独立的隐藏节点放入背景，这样每条都能单独删改
                const newSummaryEl = document.createElement('div');
                newSummaryEl.className = 'world-summary-item';
                newSummaryEl.style.display = 'none'; // 只给AI看，不显示在聊天流里
                newSummaryEl.textContent = `[阶段剧情]: ${safeSummary}`;
                configEl.appendChild(newSummaryEl);

                // 2. [极致瘦身修复] 提取核心对话，只存纯文本节点，彻底告别渲染爆炸卡死！
                const detailHtml = newCards.map(c => {
                    const name = c.querySelector('.sender-name')?.innerText || '';
                    const body = c.querySelector('.card-body')?.innerHTML || '';
                    return `<div style="padding: 6px; border-bottom: 1px dashed #eee;"><strong>${name}:</strong> ${body}</div>`;
                }).join('');
                const dateStr = new Date().toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
                
                const newHistoryCardEl = document.createElement('div');
                newHistoryCardEl.className = 'world-history-card';
                newHistoryCardEl.style.display = 'none'; // 不在主列表里显示
                newHistoryCardEl.innerHTML = `
                  <details class="history-session-card" style="margin: 10px; background: #fff; border-radius: 12px; border: 1px solid #eee;">
                    <summary class="session-summary" style="padding: 12px; cursor: pointer; outline: none; font-size: 13px; color: #666; display: flex; flex-direction: column;">
                        <span style="font-weight: bold; color: #333; margin-bottom: 4px;">${dateStr} 存档卡片</span>
                        <span style="font-size: 12px; line-height: 1.5;">${safeSummary}</span>
                    </summary>
                    <div class="session-detail-content" style="padding: 10px; background: #fafafa; border-top: 1px solid #eee;">
                      ${detailHtml}
                    </div>
                  </details>
                `;
                configEl.appendChild(newHistoryCardEl);

                // 更新轮数，将这批卡片标记为已被总结过 (这是判断哪里没总结过的书签)
                configEl.dataset.summaryTurn = allCards.length;
                await db.appData.put({ key: 'ifline_html_' + scenarioId, value: listContainer.innerHTML });
                if (isManual) showDynamicIsland('小世界总结并归档完成', 'success');
            }
        } catch (e) {
            console.error('小世界总结失败', e);
            if (isManual) showDynamicIsland('总结失败，请重试', 'error');
        }
    }
    
    document.addEventListener('ifline_world_auto_summary', async (e) => {
        const { scenarioId, charId } = e.detail;
        if (scenarioId && charId) await doIflineWorldSummary(scenarioId, charId, false);
    });

    document.getElementById('ifline-world-manual-summary-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('ifline-world-manual-summary-btn');
        btn.textContent = '归档中...'; btn.disabled = true;
        const listContainer = document.getElementById('ifline-world-message-list');
        if (listContainer?.dataset.scenarioId && tempState.currentChatId) {
            await doIflineWorldSummary(listContainer.dataset.scenarioId, tempState.currentChatId, true);
        }
        btn.textContent = '立即进行总结归档'; btn.disabled = false;
    });
    // ▲▲▲ 新增结束 ▲▲▲

    document.getElementById('ifline-forum-manual-summary-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('ifline-forum-manual-summary-btn');
        btn.textContent = '总结中...'; btn.disabled = true;
        const contentBox = document.getElementById('ifline-forum-content');
        if (contentBox?.dataset.scenarioId && tempState.currentChatId) {
            await doIflineSummary(contentBox.dataset.scenarioId, tempState.currentChatId, true);
        }
        btn.textContent = '立即进行总结'; btn.disabled = false;
    });
    // ▼▼▼ 新增：更多按钮（高级设置弹窗）▼▼▼
    document.getElementById('ifline-forum-more-btn')?.addEventListener('click', () => {
        const configEl = document.getElementById('ifline-forum-config');
        if (configEl) {
            const limit = configEl.dataset.contextLimit || '20';
            const newcomer = configEl.dataset.newcomer !== 'false';
            if (document.getElementById('ifline-forum-context-limit')) document.getElementById('ifline-forum-context-limit').value = limit;
            if (document.getElementById('ifline-context-val')) document.getElementById('ifline-context-val').textContent = limit + ' 楼';
            if (document.getElementById('ifline-forum-newcomer-toggle')) document.getElementById('ifline-forum-newcomer-toggle').checked = newcomer;
            
            const summaryFreq = configEl.dataset.summaryFreq || '20';
            if (document.getElementById('ifline-forum-summary-freq')) document.getElementById('ifline-forum-summary-freq').value = summaryFreq;
            if (document.getElementById('ifline-summary-val')) document.getElementById('ifline-summary-val').textContent = summaryFreq + ' 楼';
            if (document.getElementById('ifline-forum-summary-content')) document.getElementById('ifline-forum-summary-content').innerHTML = configEl.dataset.summaryContent || '暂无总结。';
        }
        
        // 绑定滑块实时显示
        const limitSlider = document.getElementById('ifline-forum-context-limit');
        if (limitSlider) {
            limitSlider.oninput = function() {
                if (document.getElementById('ifline-context-val')) document.getElementById('ifline-context-val').textContent = this.value + ' 楼';
            };
        }
        const freqSlider = document.getElementById('ifline-forum-summary-freq');
        if (freqSlider) {
            freqSlider.oninput = function() {
                if (document.getElementById('ifline-summary-val')) document.getElementById('ifline-summary-val').textContent = this.value + ' 楼';
            };
        }
        
        const modal = document.getElementById('ifline-forum-advanced-modal');
        if (modal) {
            modal.style.display = 'flex';
            setTimeout(() => { modal.style.opacity = '1'; }, 10);
        }
    });
    document.getElementById('save-ifline-advanced-btn')?.addEventListener('click', async () => {
        const limit = document.getElementById('ifline-forum-context-limit')?.value || '20';
        const newcomer = document.getElementById('ifline-forum-newcomer-toggle')?.checked || false;
        const summaryFreq = document.getElementById('ifline-forum-summary-freq')?.value || '20';
        const configEl = document.getElementById('ifline-forum-config');
        const contentBox = document.getElementById('ifline-forum-content');
        if (configEl && contentBox) {
            configEl.dataset.contextLimit = limit;
            configEl.dataset.newcomer = newcomer;
            configEl.dataset.summaryFreq = summaryFreq;
            // 持久化保存
            if (contentBox.dataset.scenarioId) {
                await db.appData.put({ key: 'ifline_html_' + contentBox.dataset.scenarioId, value: contentBox.innerHTML });
            }
        }
         const modal = document.getElementById('ifline-forum-advanced-modal');
        if (modal) {
            modal.style.opacity = '0';
            setTimeout(() => { modal.style.display = 'none'; }, 300);
        }
        showDynamicIsland('高级设置已应用', 'success');
    });
    // ▼▼▼ 新增：论坛高级控制中清空所有内容的逻辑 ▼▼▼
    document.getElementById('ifline-forum-clear-all-btn')?.addEventListener('click', async () => {
        const contentBox = document.getElementById('ifline-forum-content');
        const configEl = document.getElementById('ifline-forum-config');
        if (!contentBox || !contentBox.dataset.scenarioId) return;

        if (!confirm('确定要清空这个帖子的所有回复记录并重新开始吗？（已生成的总结也会一并清空）')) return;

        // 1. 清理总结状态
        if (configEl) {
            configEl.dataset.summaryTurn = '0';
            configEl.dataset.summaryContent = '';
            const summaryDisplay = document.getElementById('ifline-forum-summary-content');
            if (summaryDisplay) summaryDisplay.innerHTML = '暂无总结。';
        }

        // 2. 抓取所有的帖子卡片，保留第一条(主楼)，删除后面所有跟帖
        const allPosts = Array.from(contentBox.querySelectorAll('.ifline-forum-post'));
        if (allPosts.length > 0) {
            for (let i = 1; i < allPosts.length; i++) {
                allPosts[i].remove();
            }
        }

        // 3. 立即将干净的页面保存进数据库
        await db.appData.put({ key: 'ifline_html_' + contentBox.dataset.scenarioId, value: contentBox.innerHTML });

        // 4. 关掉高级控制弹窗
        const modal = document.getElementById('ifline-forum-advanced-modal');
        if (modal) {
            modal.style.opacity = '0';
            setTimeout(() => { modal.style.display = 'none'; }, 300);
        }
        
        showDynamicIsland('已清空，帖子重置为初始状态', 'success');
    });
    // ▲▲▲ 新增结束 ▲▲▲
    // ▼▼▼ 新增：小世界设置保存逻辑 ▼▼▼
    document.getElementById('save-ifline-world-advanced-btn')?.addEventListener('click', async () => {
        const limit = document.getElementById('ifline-world-context-limit')?.value || '20';
        const worldBg = document.getElementById('ifline-world-edit-bg')?.value || '';
        const useMemory = document.getElementById('ifline-world-edit-memory-toggle')?.checked || false;
        const useWb = document.getElementById('ifline-world-edit-wb-toggle')?.checked || false;
        const wbGroup = document.getElementById('ifline-world-edit-wb-group')?.value || 'none';
        
        const configEl = document.getElementById('ifline-world-config');
        const contentBox = document.getElementById('ifline-world-message-list');
        if (configEl && contentBox) {
            // 把用户在界面改的值塞回隐藏的设置标签里
            configEl.dataset.contextLimit = limit;
            configEl.dataset.summaryFreq = document.getElementById('ifline-world-summary-freq')?.value || '20';
            configEl.dataset.worldBg = worldBg;
            configEl.dataset.useMemory = useMemory;
            configEl.dataset.useWb = useWb;
            configEl.dataset.wbGroup = wbGroup;
            
            // 重新解析世界书内容
            let extraWbText = '';
            if (wbGroup !== 'none') {
                try {
                    const entries = await db.worldBookEntries.where('category').equals(wbGroup).toArray();
                    if (entries.length > 0) extraWbText = entries.map(e => `${e.title}: ${e.content}`).join('; ');
                } catch(e) {}
            }
            const extraWbSpan = configEl.querySelector('.extra-wb');
            if (extraWbSpan) extraWbSpan.textContent = extraWbText;
            
            // 瞬间入库保存
            if (contentBox.dataset.scenarioId) {
                await db.appData.put({ key: 'ifline_html_' + contentBox.dataset.scenarioId, value: contentBox.innerHTML });
            }
        }
        const modal = document.getElementById('ifline-world-advanced-modal');
        if (modal) {
            modal.style.opacity = '0';
            setTimeout(() => { modal.style.display = 'none'; }, 300);
        }
        showDynamicIsland('小世界设置已保存', 'success');
    });
    // ▲▲▲ 新增结束 ▲▲▲

    // ▼▼▼ 新增：小世界工具栏逻辑 ▼▼▼
    let isIflineWorldDeleteMode = false;
     let isIflineWorldEditMode = false; 
    function exitIflineWorldDeleteMode() {
        isIflineWorldDeleteMode = false;
        document.getElementById('ifline-world-normal-input-bar').style.display = 'flex';
        document.getElementById('ifline-world-delete-bar').style.display = 'none';
        const contentBox = document.getElementById('ifline-world-message-list');
        if (contentBox) {
            contentBox.querySelectorAll('.selected-for-delete').forEach(el => {
                el.classList.remove('selected-for-delete');
                el.style.backgroundColor = '';
                el.style.boxShadow = '';
            });
        }
    }

    // 1. 小世界删除按钮
    document.getElementById('ifline-world-delete-btn')?.addEventListener('click', () => {
        isIflineWorldDeleteMode = true;
        document.getElementById('ifline-world-normal-input-bar').style.display = 'none';
        document.getElementById('ifline-world-delete-bar').style.display = 'flex';
        document.getElementById('ifline-world-delete-count').textContent = '已选择 0 项';
        showDynamicIsland('点击消息卡片进行多选', 'success');
    });

    document.getElementById('ifline-world-delete-cancel')?.addEventListener('click', exitIflineWorldDeleteMode);

    document.getElementById('ifline-world-delete-confirm')?.addEventListener('click', async () => {
        const contentBox = document.getElementById('ifline-world-message-list');
        const selected = contentBox.querySelectorAll('.offline-message-card.selected-for-delete');
        if (selected.length === 0) {
            showDynamicIsland('未选择任何消息');
            return;
        }
        if (!confirm(`确定删除这 ${selected.length} 条消息吗？`)) return;

        selected.forEach(el => el.remove());
        exitIflineWorldDeleteMode();
        
        if (contentBox.dataset.scenarioId) {
            await db.appData.put({ key: 'ifline_html_' + contentBox.dataset.scenarioId, value: contentBox.innerHTML });
        }
        showDynamicIsland('删除成功', 'success');
    });
    // 拦截点击选中消息
    document.getElementById('ifline-world-message-list')?.addEventListener('click', (e) => {
        // 【修改：移除掉第一行的 if (!isIflineWorldDeleteMode) return; 改为如下结构】
        const post = e.target.closest('.offline-message-card');
        if (!post) return;
        
        // ▼ 拦截删除模式
        if (isIflineWorldDeleteMode) {
            post.classList.toggle('selected-for-delete');
            if (post.classList.contains('selected-for-delete')) {
                post.style.backgroundColor = 'rgba(255, 59, 48, 0.05)';
                post.style.boxShadow = 'inset 4px 0 0 #ff3b30';
            } else {
                post.style.backgroundColor = '';
                post.style.boxShadow = '';
            }
            const count = document.querySelectorAll('#ifline-world-message-list .offline-message-card.selected-for-delete').length;
            document.getElementById('ifline-world-delete-count').textContent = `已选择 ${count} 项`;
            return;
        }

        // ▼▼▼ 新增：拦截修改模式 ▼▼▼
        if (isIflineWorldEditMode) {
            const bodyEl = post.querySelector('.card-body');
            if (bodyEl) {
                const oldText = bodyEl.innerText;
                showInputModal('修改消息内容', oldText, async (newText) => {
                    if (newText !== null && newText.trim() !== '') {
                        // 还原小世界排版所支持的基础标签解析
                        let safeText = newText.trim().replace(/</g, "&lt;").replace(/>/g, "&gt;");
                        safeText = safeText.replace(/\*\*([\s\S]{1,500}?)\*\*/g, '<span class="italic">$1</span>')
                                           .replace(/\*([^\*]{1,500}?)\*/g, '<span class="italic">$1</span>')
                                           .replace(/(“[\s\S]*?”|「[\s\S]*?」|&quot;[\s\S]*?&quot;)/g, '<span class="dialogue">$1</span>');
                        bodyEl.innerHTML = formatIflineWorldBodyHtml(safeText);

                        const contentBox = document.getElementById('ifline-world-message-list');
                        if (contentBox && contentBox.dataset.scenarioId) {
                            await db.appData.put({ key: 'ifline_html_' + contentBox.dataset.scenarioId, value: contentBox.innerHTML });
                        }
                        showDynamicIsland('修改成功', 'success');
                    }
                    isIflineWorldEditMode = false; // 修改完毕退出
                }, { isTextarea: true });
            }
            return;
        }
        // ▲▲▲ 新增结束 ▲▲▲
    });
  // 新增：小世界修改按钮
    document.getElementById('ifline-world-edit-btn')?.addEventListener('click', () => {
        isIflineWorldEditMode = true;
        isIflineWorldDeleteMode = false;
        document.getElementById('ifline-world-normal-input-bar').style.display = 'flex';
        document.getElementById('ifline-world-delete-bar').style.display = 'none';
        showDynamicIsland('点击你想修改的消息卡片', 'success');
    });
    // 2. 小世界重回按钮
    document.getElementById('ifline-world-retry-btn')?.addEventListener('click', async () => {
        const contentBox = document.getElementById('ifline-world-message-list');
        if (!contentBox || !contentBox.dataset.scenarioId) return;

        const posts = Array.from(contentBox.querySelectorAll('.offline-message-card'));
        let lastUserIndex = -1;
        for (let i = posts.length - 1; i >= 0; i--) {
            const senderName = posts[i].querySelector('.sender-name')?.textContent || '';
            // 判断是否是用户的发言
            if (senderName.includes('你 (小世界)')) {
                lastUserIndex = i;
                break;
            }
        }
        if (lastUserIndex === -1 && posts.length > 0) lastUserIndex = 0;
        if (lastUserIndex !== -1) {
            for (let i = lastUserIndex + 1; i < posts.length; i++) {
                posts[i].remove();
            }
        }

        // 把页面滚动修正
        const scrollBox = document.getElementById('ifline-world-message-list');
        if (scrollBox) setTimeout(() => scrollBox.scrollTop = scrollBox.scrollHeight, 50);

        import('./chat-service.js').then(m => {
            // triggerIflineAiResponse 内部会自动插动画
            m.triggerIflineAiResponse(contentBox.dataset.scenarioId, 'world', tempState.currentChatId)
            .finally(async () => {
                // 清理可能残留的所有转圈动画
                const loaders = contentBox.querySelectorAll('#world-typing');
                loaders.forEach(el => el.remove());
                await db.appData.put({ key: 'ifline_html_' + contentBox.dataset.scenarioId, value: contentBox.innerHTML });
            });
        });
    });

    // 3. 小世界剧情导向与OOC修正
     // ▼▼▼ 修复：小世界剧情导向与OOC修正，增加立即保存数据库逻辑 ▼▼▼
    const setupWorldGuide = (title, placeholder, prefix = '') => {
        showInputModal(title, placeholder, async (val) => {
            if (val) {
                const configEl = document.getElementById('ifline-world-config');
                const contentBox = document.getElementById('ifline-world-message-list');
                if (!configEl || !contentBox || !contentBox.dataset.scenarioId) return;
                
                let dirEl = configEl.querySelector('.post-direction');
                if (!dirEl) {
                    dirEl = document.createElement('span');
                    dirEl.className = 'post-direction';
                    dirEl.style.display = 'none';
                    configEl.appendChild(dirEl);
                }
                
                // 处理拼接：导向为覆盖，OOC为追加
                if (prefix) {
                    dirEl.textContent += ` ${prefix}${val}]`;
                 } else {
                    dirEl.textContent = val;
                }
                dirEl.setAttribute('data-turns-left', '5'); // 设定寿命为5轮
                // 【核心修复】修改标签后，立刻打包整个DOM存入IndexedDB
                await db.appData.put({ key: 'ifline_html_' + contentBox.dataset.scenarioId, value: contentBox.innerHTML });
                
                showDynamicIsland(title + '已提交', 'success');
            }
        }, { isTextarea: true });
    };

    document.getElementById('ifline-world-guide-btn')?.addEventListener('click', () => {
        setupWorldGuide('输入剧情导向', '例如：接下来让剧情发生什么转折？');
    });
    
    document.getElementById('ifline-world-ooc-btn')?.addEventListener('click', () => {
        setupWorldGuide('OOC修正', '指出角色的OOC之处，AI将在接下来的剧情中调整：', ' [强烈注意修正：');
    });
    // ▲▲▲ 修复结束 ▲▲▲
    // 7. 小世界：发送逻辑 (沙盒)
    document.getElementById('ifline-world-send-btn')?.addEventListener('click', async () => {
        const input = document.getElementById('ifline-world-input');
        const text = input.value.trim();
        const list = document.getElementById('ifline-world-message-list');
        const scenarioId = list?.dataset.scenarioId;
        const iflineKey = scenarioId ? `world:${tempState.currentChatId}:${scenarioId}` : null;
        if (iflineKey && isModeGenerating('ifline', iflineKey)) {
            cancelAiGeneration('ifline', iflineKey);
            list.querySelectorAll('#world-typing').forEach(el => el.remove());
            showDynamicIsland('已打断生成');
            return;
        }
        // ▼▼▼ 新增：如果不输入文字直接点发送，触发AI继续推演剧情 ▼▼▼
        if (!text) {
            // 不再手动插入动画，交给 chat-service
            if (list.dataset.scenarioId) {
                import('./chat-service.js').then(m => {
                    m.triggerIflineAiResponse(list.dataset.scenarioId, 'world', tempState.currentChatId);
                });
            }
            return;
        }
        // ▲▲▲ 新增结束 ▲▲▲
        // ▼▼▼ 新增正则解析 ▼▼▼
        let safeText = escapeHTML(text);
        safeText = safeText.replace(/\*\*([\s\S]{1,500}?)\*\*/g, '<span class="italic">$1</span>')
                           .replace(/\*([^\*]{1,500}?)\*/g, '<span class="italic">$1</span>')
                           .replace(/(“[\s\S]*?”|「[\s\S]*?」|&quot;[\s\S]*?&quot;)/g, '<span class="dialogue">$1</span>');

        const msgHTML = `
            <div class="offline-message-card">
                <div class="card-header">
                    <div class="sender-info">
                        <span class="sender-name">你 (小世界)</span>
                        <span class="timestamp">刚刚</span>
                    </div>
                </div>
                <div class="card-body">${formatIflineWorldBodyHtml(safeText)}</div>
            </div>
        `;
        list.insertAdjacentHTML('beforeend', msgHTML);
        input.value = '';
        
        const scrollBox = document.getElementById('ifline-world-message-list');
        if (scrollBox) setTimeout(() => scrollBox.scrollTop = scrollBox.scrollHeight, 50);
        
        // 核心修复：存入数据库
        if (list.dataset.scenarioId) {
            await db.appData.put({ key: 'ifline_html_' + list.dataset.scenarioId, value: list.innerHTML });
        }

        setTimeout(() => showDynamicIsland('消息已发出'), 500);
        
        // ▼▼▼ 新增：用户发送完平行世界消息后，触发AI互动 ▼▼▼
        if (list.dataset.scenarioId) {
            import('./chat-service.js').then(m => {
                m.triggerIflineAiResponse(list.dataset.scenarioId, 'world', tempState.currentChatId);
            });
        }
        // ▲▲▲ 新增结束 ▲▲▲
    });
});
// ==========================================================================
// == ▲▲▲ IF线（小剧场）独立沙盒核心逻辑 结束 ▲▲▲ ==
// ==========================================================================
// ==========================================================================
// == ▼▼▼ 小世界专属预设管理器 (完全隔离数据) ▼▼▼ ==
// ==========================================================================

function openIflineWorldScenarioModal() {
    const modal = document.getElementById('ifline-world-scenario-modal');
    if (!modal) return;
    modal.classList.add('visible');
    
    const charId = tempState.currentChatId;
    // 注意：这里的 Key 名字全加了 ifline_world_ 前缀
    const hasSavedCustom = localStorage.getItem(`ifline_world_active_ids_${charId}`);
    
    if (hasSavedCustom) {
        switchIflineWorldScenarioTab('custom');
    } else {
        switchIflineWorldScenarioTab('builtin');
    }
    renderIflineWorldScenarioLists();

    // 回显配置
    const savedConfigStr = localStorage.getItem(`ifline_world_behavior_config_${charId}`);
    if (savedConfigStr) {
               try {
            const config = JSON.parse(savedConfigStr);
            document.getElementById('iw-builtin-length-input').value = config.lengthVal || '';
            document.getElementById('iw-builtin-char-perspective').value = config.charPersp || 'third';
            document.getElementById('iw-builtin-user-perspective').value = config.userPersp || 'second';
            document.getElementById('iw-builtin-interrupt-select').value = config.interruptLevel || 'none';
            document.getElementById('iw-builtin-prompt-version').value = config.promptVersion || 'v2';
        } catch(e) {}
    }

    if (!modal.dataset.initialized) {
        document.getElementById('close-ifline-world-scenario-btn').addEventListener('click', () => modal.classList.remove('visible'));
        document.getElementById('iw-tab-builtin').addEventListener('click', () => switchIflineWorldScenarioTab('builtin'));
        document.getElementById('iw-tab-custom').addEventListener('click', () => switchIflineWorldScenarioTab('custom'));
       document.getElementById('save-iw-scenario-btn').addEventListener('click', async () => {
            await saveIflineWorldScenarioSelection();
            modal.classList.remove('visible');
            showDynamicIsland('小世界预设已更新');
        });
        modal.dataset.initialized = 'true';
    }
}

function switchIflineWorldScenarioTab(tabName) {
    const btnBuiltin = document.getElementById('iw-tab-builtin');
    const btnCustom = document.getElementById('iw-tab-custom');
    const viewBuiltin = document.getElementById('iw-view-builtin');
    const viewCustom = document.getElementById('iw-view-custom');
    const activeStyle = 'background: #000; color: #fff;';
    const inactiveStyle = 'background: transparent; color: #666;';

    if (tabName === 'builtin') {
        viewBuiltin.style.display = 'flex'; viewCustom.style.display = 'none';
        btnBuiltin.style.cssText += activeStyle; btnCustom.style.cssText += inactiveStyle;
        btnBuiltin.classList.add('active'); btnCustom.classList.remove('active');
    } else {
        viewBuiltin.style.display = 'none'; viewCustom.style.display = 'block';
        btnBuiltin.style.cssText += inactiveStyle; btnCustom.style.cssText += activeStyle;
        btnBuiltin.classList.remove('active'); btnCustom.classList.add('active');
    }
}
async function renderIflineWorldScenarioLists() {
    const charId = tempState.currentChatId;
    const storageKey = `ifline_world_active_ids_${charId}`;
    
    let activeIds = [];
    const activeIdsDB = await db.appData.get(storageKey);
    if (activeIdsDB && activeIdsDB.value) {
        activeIds = JSON.parse(activeIdsDB.value);
    } else {
        activeIds = JSON.parse(localStorage.getItem(storageKey) || '[]');
    }
    const customContainer = document.getElementById('iw-custom-scenario-list');
    
    let customScenarios = [];
    const customRecord = await db.appData.get('offline_custom_scenarios');
    if (customRecord && customRecord.value) {
        customScenarios = customRecord.value;
    } else {
        customScenarios = JSON.parse(localStorage.getItem('offline_custom_scenarios') || '[]');
    }
    if (customScenarios.length === 0) {
        customContainer.innerHTML = '<div style="text-align: center; color: #ccc; padding: 20px; font-size: 12px;">暂无自定义预设，请前往[线下预设]中添加</div>';
    } else {
        customContainer.innerHTML = '';
        const fragment = document.createDocumentFragment();
        let i = 0;
        const chunkSize = 10;
        
        function renderChunk() {
            const end = Math.min(i + chunkSize, customScenarios.length);
            for (; i < end; i++) {
                const item = customScenarios[i];
                const isChecked = activeIds.includes(item.id) ? 'checked' : '';
                const div = document.createElement('div');
                div.style.cssText = `display: flex; align-items: center; padding: 12px; background: #fafafa; border-radius: 12px; border: 1px solid ${isChecked ? '#000' : '#eee'}; margin-bottom: 8px;`;
                div.innerHTML = `
                <label style="flex: 1; display: flex; align-items: center; cursor: pointer; min-width: 0;">
                    <input type="checkbox" name="iw_scenario_select" value="${item.id}" ${isChecked} style="accent-color: #000; margin-right: 10px; flex-shrink: 0;">
                    <div style="overflow: hidden; flex: 1;">
                        <div style="font-weight: 600; font-size: 14px; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(item.title)}</div>
                        <div style="font-size: 12px; color: #888; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(item.content)}</div>
                    </div>
                </label>
                `;
                fragment.appendChild(div);
            }
            if (i < customScenarios.length) {
                requestAnimationFrame(renderChunk);
            } else {
                customContainer.appendChild(fragment);
            }
        }
        requestAnimationFrame(renderChunk);
    }
}
async function saveIflineWorldScenarioSelection() {
    const charId = tempState.currentChatId;
    if (!charId) return;
    const idStorageKey = `ifline_world_active_ids_${charId}`;
    const contentStorageKey = `ifline_world_active_content_${charId}`;
    
    let lengthVal = document.getElementById('iw-builtin-length-input').value;
    if (lengthVal && !isNaN(lengthVal) && parseInt(lengthVal) > 10000) lengthVal = 10000;
    
    const charPersp = document.getElementById('iw-builtin-char-perspective').value;
    const userPersp = document.getElementById('iw-builtin-user-perspective').value;
    const interruptLevel = document.getElementById('iw-builtin-interrupt-select').value;
    const promptVersion = document.getElementById('iw-builtin-prompt-version').value;
    
    localStorage.setItem(`ifline_world_behavior_config_${charId}`, JSON.stringify({ lengthVal, charPersp, userPersp, interruptLevel, promptVersion })); 
    
    let behaviorPrompt = "";
    if (lengthVal && parseInt(lengthVal) > 0) {
        behaviorPrompt += `\n[Writing Style: Length] Target approximately ${lengthVal} characters.`;
    }
    if (charPersp === 'first') behaviorPrompt += "\n[Writing Style: Character POV] Use first person ('I', 'me').";
    else if (charPersp === 'second') behaviorPrompt += "\n[Writing Style: Character POV] Use second person ('you').";
    else behaviorPrompt += "\n[Writing Style: Character POV] Use third person ('he/she').";
    if (userPersp === 'first') behaviorPrompt += "\n[Writing Style: User POV] Use first person for the user.";
    else if (userPersp === 'second') behaviorPrompt += "\n[Writing Style: User POV] Address the user as 'you'.";
    else behaviorPrompt += "\n[Writing Style: User POV] Use third person for the user.";
    if (interruptLevel === 'none') behaviorPrompt += "\n[Interaction Rule] User controls their character completely. DO NOT act for them.";
    else if (interruptLevel === 'light') behaviorPrompt += "\n[Interaction Rule] You may write brief, minor actions for the user.";
    else if (interruptLevel === 'heavy') behaviorPrompt += "\n[Interaction Rule] You have full creative authority over both characters. Drive the plot proactively.";
    await db.appData.put({ key: `ifline_world_behavior_prompt_${charId}`, value: behaviorPrompt });
    const isBuiltinTab = document.getElementById('iw-tab-builtin').classList.contains('active');
    if (isBuiltinTab) {
        localStorage.removeItem(idStorageKey);
        localStorage.removeItem(contentStorageKey);
        await db.appData.delete(idStorageKey);
        await db.appData.delete(contentStorageKey);
    } else {
        const selectedCheckboxes = document.querySelectorAll('input[name="iw_scenario_select"]:checked');
        if (selectedCheckboxes.length > 0) {
            const selectedIds = [];
            const combinedContents = [];
            
            const customRecord = await db.appData.get('offline_custom_scenarios');
            const customList = customRecord && customRecord.value ? customRecord.value : [];
            selectedCheckboxes.forEach(cb => {
                const id = cb.value;
                selectedIds.push(id);
                const item = customList.find(i => i.id === id);
                if (item) combinedContents.push(item.content);
            });
            localStorage.setItem(idStorageKey, JSON.stringify(selectedIds));
            await db.appData.put({ key: idStorageKey, value: JSON.stringify(selectedIds) });
            await db.appData.put({ key: contentStorageKey, value: combinedContents.join('\n\n') });
        localStorage.removeItem(contentStorageKey);
        } else {
            localStorage.removeItem(idStorageKey);
            localStorage.removeItem(contentStorageKey);
            await db.appData.delete(idStorageKey);
            await db.appData.delete(contentStorageKey);
        }
    }
    markPendingContextSwitch('ifline_world', charId, 'preset');
}
