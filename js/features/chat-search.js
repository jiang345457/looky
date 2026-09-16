import { AppState, db, DEFAULT_AVATAR_SRC, tempState } from '../state.js';
import { showDynamicIsland, showPage } from '../ui.js';
import { escapeHTML, isValidAvatarSrc } from '../utils.js';

const PAGE_SIZE = 40;
const SCAN_BATCH_SIZE = 160;
const SEARCH_DEBOUNCE_MS = 220;

const state = {
    chatId: null,
    query: '',
    type: 'all',
    scanOffset: 0,
    results: [],
    exhausted: false,
    requestId: 0,
    loading: false,
    debounceTimer: null
};

const favoriteState = {
    type: 'all',
    renderToken: 0
};

const MESSAGE_FILTERS = [
    ['all', '全部'],
    ['text', '文字'],
    ['voice', '语音'],
    ['image', '照片'],
    ['voice_call', '语音通话'],
    ['video_call', '视频通话'],
    ['html', 'HTML'],
    ['sticker', '表情'],
    ['other', '其他']
];

const TYPE_LABELS = {
    text: '文字',
    image: '图片',
    voice: '语音',
    sticker: '表情',
    location: '位置',
    transfer: '转账',
    red_packet: '红包',
    system_event: '系统消息',
    voice_call_summary: '通话记录',
    voice_call_rejected: '通话记录',
    html_snippet: 'HTML'
};

function getMessageCategory(message = {}) {
    const contentType = String(message.contentType || '').toLowerCase();
    if (contentType === 'voice_call_summary' || contentType === 'voice_call_rejected') {
        return message.isVideo === true ? 'video_call' : 'voice_call';
    }
    if (contentType === 'voice') return 'voice';
    if (contentType === 'html_snippet') return 'html';
    if (contentType === 'image' || (message.stickerUrl && message.text === '[图片]')) return 'image';
    if (contentType === 'sticker' || message.stickerUrl) return 'sticker';
    if (!contentType || contentType === 'text') return 'text';
    return 'other';
}

function getMessageCategoryLabel(category) {
    return MESSAGE_FILTERS.find(([value]) => value === category)?.[1] || TYPE_LABELS[category] || '其他';
}

function getElements() {
    return {
        page: document.getElementById('page-chat-search'),
        input: document.getElementById('chat-history-search-input'),
        clear: document.getElementById('chat-history-search-clear'),
        filters: document.querySelectorAll('#chat-history-search-filters [data-search-type]'),
        list: document.getElementById('chat-history-search-results'),
        empty: document.getElementById('chat-history-search-empty'),
        status: document.getElementById('chat-history-search-status'),
        loadMore: document.getElementById('chat-history-search-load-more'),
        avatar: document.getElementById('chat-history-search-avatar'),
        characterName: document.getElementById('chat-history-search-character')
    };
}

function getCharacter(chatId = state.chatId) {
    return AppState.characterProfiles.find(character => String(character.id) === String(chatId));
}

function getActiveChatId() {
    const settingsPage = document.getElementById('page-chat-settings');
    const currentChatId = tempState.currentChatId;
    if (currentChatId !== null && currentChatId !== undefined && currentChatId !== '') {
        return typeof currentChatId === 'object' ? currentChatId.id ?? null : currentChatId;
    }
    const settingsChatId = settingsPage?.dataset.chatId || null;
    return typeof settingsChatId === 'object' ? settingsChatId.id ?? null : settingsChatId;
}

function isValidChatId(chatId) {
    return (typeof chatId === 'string' && chatId.trim() !== '')
        || (typeof chatId === 'number' && Number.isFinite(chatId));
}

function getMessageSearchData(message = {}) {
    const type = String(message.contentType || '').toLowerCase();
    const category = getMessageCategory(message);
    const fields = [];
    const addField = value => {
        if (typeof value === 'string' && value.trim()) fields.push(value.trim());
    };

    addField(message.text);
    addField(message.fileName);
    addField(message.fileInfo?.name);
    addField(message.content?.name);
    addField(message.content?.title);
    addField(message.content?.text);

    const label = getMessageCategoryLabel(category) || TYPE_LABELS[type];
    const searchableFields = label ? [...fields, label] : fields;
    let preview = fields[0] || '';
    if (!preview) {
        preview = label ? `[${label}]` : '[聊天消息]';
    }
    return {
        type,
        category,
        label,
        preview: preview.replace(/\s+/g, ' ').slice(0, 240),
        searchable: searchableFields.join('\n').slice(0, 1200).toLocaleLowerCase()
    };
}

function matchesMessage(message, query, typeFilter) {
    if (!message || message.recalled || message.uiVisible === false) return false;
    if (message.contentType === 'offline_invite'
        || (message.contentType === 'system_event' && ['date_start', 'date_end'].includes(message.eventType))) return false;
    const data = getMessageSearchData(message);
    if (typeFilter !== 'all' && data.category !== typeFilter) return false;
    return !query || data.searchable.includes(query);
}

function formatMessageTime(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function highlightText(text, query) {
    const safeText = escapeHTML(text);
    if (!query) return safeText;
    const safeQuery = escapeHTML(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safeText.replace(new RegExp(`(${safeQuery})`, 'ig'), '<mark>$1</mark>');
}

function createSearchContentPreview(message, data) {
    const preview = document.createElement('div');
    preview.className = `chat-search-content-preview is-${data.category}`;
    if (data.category === 'image' && message.stickerUrl) {
        const image = document.createElement('img');
        image.src = message.stickerUrl;
        image.alt = '图片消息';
        image.loading = 'lazy';
        image.decoding = 'async';
        preview.appendChild(image);
        return preview;
    }
    const text = data.preview || `[${data.label}]`;
    preview.textContent = text;
    return preview;
}

function renderResultItem(message, createMessagePreviewElement, includeQueryPreview = true, interactive = false) {
    const data = getMessageSearchData(message);
    const sender = message.type === 'sent' ? '我' : (getCharacter()?.chatOverrideName || getCharacter()?.name || '对方');
    const item = document.createElement('div');
    item.className = 'chat-history-search-result';
    item.dataset.messageId = String(message.id);
    item.dataset.messageCategory = data.category;
    item.innerHTML = `
        <div class="chat-history-search-result-meta">
                <span>${escapeHTML(sender)}</span>
                <span>${escapeHTML(formatMessageTime(message.timestamp))}</span>
                <span class="chat-history-search-result-type">${escapeHTML(data.label)}</span>
        </div>
        <div class="chat-history-search-result-message"></div>
        ${includeQueryPreview && state.query ? `<div class="chat-history-search-result-preview">匹配：${highlightText(data.preview, state.query)}</div>` : ''}
    `;
    const messageHost = item.querySelector('.chat-history-search-result-message');
    if (messageHost) {
        if (interactive) {
            const messageElement = createMessagePreviewElement(message, { interactive: true });
            if (messageElement) messageHost.appendChild(messageElement);
        } else {
            messageHost.appendChild(createSearchContentPreview(message, data));
        }
    }
    return item;
}

async function renderResults({ append = false } = {}) {
    const elements = getElements();
    if (!elements.list || !elements.empty) return;
    if (!append) elements.list.innerHTML = '';
    const renderRequestId = state.requestId;
    if (renderRequestId !== state.requestId) return;
    const fragment = document.createDocumentFragment();
    const startIndex = append ? Math.max(0, state.results.length - PAGE_SIZE) : 0;
    state.results.slice(startIndex).forEach(message => fragment.appendChild(renderResultItem(message, null)));
    elements.list.appendChild(fragment);
    const hasResults = state.results.length > 0;
    elements.empty.hidden = hasResults;
    if (!hasResults) {
        elements.empty.textContent = state.query || state.type !== 'all' ? '没有找到匹配的聊天记录' : '输入关键词，查找这段对话';
    }
    if (elements.status) {
        elements.status.textContent = hasResults ? `已显示 ${state.results.length} 条` : '';
    }
    if (elements.loadMore) {
        elements.loadMore.hidden = !hasResults || state.exhausted;
        elements.loadMore.disabled = state.loading;
        elements.loadMore.textContent = state.loading ? '正在查找…' : '加载更多';
    }
}

async function searchNextPage({ reset = false } = {}) {
    const elements = getElements();
    if (!elements.list) return;
    if (reset) {
        state.requestId += 1;
        // 让新的关键词/筛选立即接管，旧查询的数据库批次返回后会因 requestId 失效而丢弃。
        state.loading = false;
        state.scanOffset = 0;
        state.results = [];
        state.exhausted = false;
        renderResults();
    }
    if (state.loading) return;
    if (state.exhausted || !state.chatId) return;

    const requestId = state.requestId;
    const targetResultCount = state.results.length + PAGE_SIZE;
    state.loading = true;
    renderResults({ append: true });
    try {
        while (!state.exhausted && state.results.length < targetResultCount) {
            const batch = await db.chatMessages
                .where('chatId')
                .equals(state.chatId)
                .reverse()
                .offset(state.scanOffset)
                .limit(SCAN_BATCH_SIZE)
                .toArray();
            if (requestId !== state.requestId) return;
            const batchStartOffset = state.scanOffset;
            let consumedCount = 0;
            for (const message of batch) {
                consumedCount += 1;
                if (matchesMessage(message, state.query, state.type)) {
                    state.results.push(message);
                }
                if (state.results.length >= targetResultCount) break;
            }
            state.scanOffset = batchStartOffset + consumedCount;
            if (batch.length < SCAN_BATCH_SIZE && consumedCount >= batch.length) state.exhausted = true;
        }
    } catch (error) {
        console.error('[聊天记录搜索] 查询失败:', error);
        if (requestId === state.requestId && elements.empty) {
            elements.empty.hidden = false;
            elements.empty.textContent = '读取聊天记录失败，请稍后重试';
        }
    } finally {
        if (requestId === state.requestId) {
            state.loading = false;
            renderResults();
        }
    }
}

function resetSearchFromInput() {
    const elements = getElements();
    state.query = String(elements.input?.value || '').trim().toLocaleLowerCase();
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => searchNextPage({ reset: true }), SEARCH_DEBOUNCE_MS);
}

async function openMessage(messageId) {
    const message = await db.chatMessages.get(Number(messageId));
    if (!message || String(message.chatId) !== String(state.chatId)) return;
    tempState.currentChatId = state.chatId;
    showPage('page-chat-detail');
    try {
        const { loadAndRenderChatHistory, expandFoldedMessages } = await import('./chat-ui.js');
        await loadAndRenderChatHistory(state.chatId, true, { targetMessageId: Number(messageId) });
        let target = document.querySelector(`#chat-message-list [data-message-id="${Number(messageId)}"]`);
        if (!target) {
            await expandFoldedMessages(state.chatId, Number(messageId));
            target = document.querySelector(`#chat-message-list [data-message-id="${Number(messageId)}"]`);
        }
        requestAnimationFrame(() => {
            if (target) {
                const messageList = document.getElementById('chat-message-list');
                if (messageList) {
                    const centeredTop = target.offsetTop - Math.max(0, (messageList.clientHeight - target.offsetHeight) / 2);
                    messageList.scrollTop = Math.max(0, centeredTop);
                }
                target.classList.add('chat-search-result-focus');
                setTimeout(() => target.classList.remove('chat-search-result-focus'), 1600);
            } else {
                showDynamicIsland('已打开该角色聊天，可继续向上加载历史记录');
            }
        });
    } catch (error) {
        console.error('[聊天记录搜索] 打开记录失败:', error);
        showDynamicIsland('打开聊天记录失败，请稍后重试');
    }
}

function preparePage() {
    const elements = getElements();
    const chatId = getActiveChatId();
    state.chatId = chatId;
    const character = getCharacter(chatId);
    state.query = '';
    state.type = 'all';
    state.scanOffset = 0;
    state.results = [];
    state.exhausted = false;
    state.requestId += 1;
    if (elements.input) elements.input.value = '';
    elements.filters?.forEach(filter => filter.classList.toggle('active', filter.dataset.searchType === 'all'));
    if (elements.avatar) {
        const avatar = character?.chatOverrideAvatar || character?.avatar || DEFAULT_AVATAR_SRC;
        elements.avatar.src = isValidAvatarSrc(avatar) ? avatar : DEFAULT_AVATAR_SRC;
    }
    if (elements.characterName) elements.characterName.textContent = character?.chatOverrideName || character?.name || '当前对话';
    renderResults();
    setTimeout(() => elements.input?.focus(), 80);
}

export function initChatSearchPage() {
    const elements = getElements();
    const trigger = document.getElementById('chat-settings-search-records');
    if (!elements.page || !trigger || trigger.dataset.chatSearchBound === '1') return;
    trigger.dataset.chatSearchBound = '1';
    trigger.addEventListener('click', () => {
        const activeChatId = getActiveChatId();
        if (!isValidChatId(activeChatId) || !getCharacter(activeChatId)) {
            showDynamicIsland('请先进入一个角色的聊天');
            return;
        }
        preparePage();
        showPage('page-chat-search');
    });
    elements.input?.addEventListener('input', resetSearchFromInput);
    elements.clear?.addEventListener('click', () => {
        if (elements.input) elements.input.value = '';
        resetSearchFromInput();
        elements.input?.focus();
    });
    elements.filters?.forEach(filter => filter.addEventListener('click', () => {
        state.type = filter.dataset.searchType || 'all';
        elements.filters.forEach(item => item.classList.toggle('active', item === filter));
        searchNextPage({ reset: true });
    }));
    elements.loadMore?.addEventListener('click', () => searchNextPage());
    elements.list?.addEventListener('click', event => {
        const item = event.target.closest('.chat-history-search-result');
        if (item) openMessage(item.dataset.messageId);
    });
}

function getFavoriteElements() {
    return {
        page: document.getElementById('page-chat-favorites'),
        list: document.getElementById('chat-favorites-message-list'),
        empty: document.getElementById('chat-favorites-empty'),
        status: document.getElementById('chat-favorites-status'),
        avatar: document.getElementById('chat-favorites-avatar'),
        characterName: document.getElementById('chat-favorites-character'),
        filters: document.querySelectorAll('#chat-favorites-filters [data-favorite-type]')
    };
}

function renderFilterButtons(container, attributeName) {
    if (!container || container.childElementCount > 0) return;
    MESSAGE_FILTERS.forEach(([value, label]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset[attributeName] = value;
        button.textContent = label;
        if (value === 'all') button.classList.add('active');
        container.appendChild(button);
    });
}

function bindRenderedMessageInteractions(list) {
    if (!list || list.dataset.messageInteractionsBound === '1') return;
    list.dataset.messageInteractionsBound = '1';
    list.addEventListener('click', async event => {
        const voiceBubble = event.target.closest('.message-bubble.is-voice-message');
        if (voiceBubble) {
            const wrapper = voiceBubble.closest('.message-wrapper');
            if (!wrapper) return;
            event.stopPropagation();
            wrapper.classList.toggle('voice-expanded');
            if (wrapper.classList.contains('voice-expanded') && wrapper.classList.contains('received')) {
                if (wrapper.classList.contains('is-playing')) return;
                const message = await db.chatMessages.get(Number(wrapper.dataset.messageId));
                if (message?.text) {
                    wrapper.classList.add('is-playing');
                    const { TTSService } = await import('./tts-service.js');
                    TTSService.speakForCharacter(message.text, message.speakerId || tempState.currentChatId, { emotion: message.ttsEmotion })
                        .finally(() => wrapper.classList.remove('is-playing'));
                }
            }
            return;
        }
        const imageBubble = event.target.closest('.gallery-image-bubble');
        if (imageBubble && !event.target.closest('.message-reply-preview')) {
            event.stopPropagation();
            const message = await db.chatMessages.get(Number(imageBubble.closest('[data-message-id]')?.dataset.messageId));
            if (message) {
                const { showChatImageViewer } = await import('./chat-ui.js');
                showChatImageViewer(message);
            }
            return;
        }
        const photoCard = event.target.closest('.photo-card');
        if (photoCard && !event.target.closest('.message-reply-preview')) {
            photoCard.classList.toggle('expanded');
            event.stopPropagation();
        }
    });
}

async function prepareFavoritesPage() {
    const elements = getFavoriteElements();
    const chatId = getActiveChatId();
    const character = getCharacter(chatId);
    if (!elements.page || !isValidChatId(chatId) || !character) {
        showDynamicIsland('请先进入一个角色的聊天');
        return false;
    }
    state.chatId = chatId;
    if (elements.avatar) {
        const avatar = character.chatOverrideAvatar || character.avatar || DEFAULT_AVATAR_SRC;
        elements.avatar.src = isValidAvatarSrc(avatar) ? avatar : DEFAULT_AVATAR_SRC;
    }
    if (elements.characterName) elements.characterName.textContent = character.chatOverrideName || character.name || '当前对话';
    const { createMessagePreviewElement } = await import('./chat-ui.js');
    elements.list.innerHTML = '';
    const favoriteScanLimit = favoriteState.type === 'all' ? 40 : 120;
    // 不使用复合索引查询，兼容旧数据中的 true/1 收藏值，也避免非法聊天编号触发 DataError。
    const favorites = await db.chatMessages
        .where('chatId')
        .equals(chatId)
        .filter(message => message.isFavorite === true || message.isFavorite === 1)
        .reverse()
        .limit(favoriteScanLimit)
        .toArray();
    const visibleFavorites = favorites
        .filter(message => !message.recalled && message.uiVisible !== false)
        .filter(message => message.contentType !== 'offline_invite'
            && !(message.contentType === 'system_event' && ['date_start', 'date_end'].includes(message.eventType)))
        .filter(message => favoriteState.type === 'all' || getMessageCategory(message) === favoriteState.type)
        .slice(0, 40);
    const orderedFavorites = visibleFavorites.reverse();
    const renderToken = ++favoriteState.renderToken;
    const chunkSize = 10;
    const renderChunk = startIndex => {
        if (renderToken !== favoriteState.renderToken) return;
        const fragment = document.createDocumentFragment();
        orderedFavorites.slice(startIndex, startIndex + chunkSize).forEach(message => {
            const element = renderResultItem(message, createMessagePreviewElement, false, true);
            if (element) fragment.appendChild(element);
        });
        elements.list.appendChild(fragment);
        const nextIndex = startIndex + chunkSize;
        if (nextIndex < orderedFavorites.length) {
            const schedule = window.requestIdleCallback || (callback => setTimeout(callback, 32));
            schedule(() => renderChunk(nextIndex));
        }
    };
    renderChunk(0);
    bindRenderedMessageInteractions(elements.list);
    elements.empty.hidden = visibleFavorites.length > 0;
    if (elements.status) elements.status.textContent = visibleFavorites.length ? `已收藏 ${visibleFavorites.length} 条` : '';
    return true;
}

export function initChatFavoritesPage() {
    const elements = getFavoriteElements();
    const trigger = document.getElementById('chat-settings-favorites');
    if (!elements.page || !trigger || trigger.dataset.chatFavoritesBound === '1') return;
    trigger.dataset.chatFavoritesBound = '1';
    renderFilterButtons(document.getElementById('chat-favorites-filters'), 'favoriteType');
    elements.filters = document.querySelectorAll('#chat-favorites-filters [data-favorite-type]');
    elements.filters?.forEach(filter => filter.addEventListener('click', () => {
        favoriteState.type = filter.dataset.favoriteType || 'all';
        elements.filters.forEach(item => item.classList.toggle('active', item === filter));
        prepareFavoritesPage();
    }));
    trigger.addEventListener('click', async () => {
        favoriteState.type = 'all';
        elements.filters?.forEach(filter => filter.classList.toggle('active', filter.dataset.favoriteType === 'all'));
        if (await prepareFavoritesPage()) showPage('page-chat-favorites');
    });
}
