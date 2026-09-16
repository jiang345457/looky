import { AppState, DEFAULT_AVATAR_SRC, db, isCharacterFriend, saveHybridStateToSession, tempState } from '../state.js';
import { showDynamicIsland, showInputModal, showPage } from '../ui.js';
import { escapeHTML, isValidAvatarSrc } from '../utils.js';
import { deleteCharactersWithRelatedData, finalizeFriendRequestAcceptance, refreshCharacterLists } from './character.js';
import { createOrUpdateFriendRequest, requestFriendRequestAiDecision, sanitizeFriendRequestMessageParts, saveFriendRequestThreads } from './friend-requests.js';
import { applyRelationshipScoreEvent, getRelationshipStageByScore } from './relationship-score.js';

let currentDetailCharId = null;
let currentLibrarySearchTerm = '';
let detailFriendRequestPending = false;
let lastCharacterHubRenderKey = null;
let lastCharacterLibraryRenderKey = null;
let pendingCharacterPageRenderFrame = 0;
let characterLibraryRenderBatchToken = 0;
let currentOfflineEncounterFilter = 'all';
let currentOfflineEncounterCharId = null;
let lastOfflineEncounterRenderKey = null;
let offlineEncounterItemsCache = [];
let pendingOfflineEncounterActionCharId = null;
let currentOfflineEncounterZoom = 1;
let offlineEncounterPinchStartDistance = 0;
let offlineEncounterPinchStartZoom = 1;
let isOfflineEncounterSingleMode = false;

function isOfflineEncounterCandidateChar(char = {}) {
    return Boolean(char)
        && !char.isGroup
        && !isCharacterFriend(char)
        && char.inContacts === false;
}

async function hasOfflineEncounterHistory(charId) {
    if (!charId) return false;
    try {
        const [messageCount, sessionCount] = await Promise.all([
            db.offlineMessages.where({ chatId: charId }).limit(1).count(),
            db.offlineSessions.where({ chatId: charId }).limit(1).count()
        ]);
        return messageCount > 0 || sessionCount > 0;
    } catch (error) {
        console.warn('[线下相遇] 首次见面状态读取失败:', charId, error);
        return false;
    }
}

function getRelationStatus(char) {
    if (isCharacterFriend(char)) {
        return { text: '已是好友', code: '可线上聊天', tone: 'friend' };
    }
    if (char.relationStage === 'pending_user' || char.relationStage === 'pending_char') {
        return { text: '申请中', code: '等待回应', tone: 'pending' };
    }
    if (char.relationStage === 'offline_met') {
        const hasOfflineEvent = Array.isArray(char.relationshipEvents)
            && char.relationshipEvents.some(event => event?.type === 'offline_session');
        if (hasOfflineEvent) return { text: '已线下认识', code: '见过面', tone: 'met' };
        return char.inContacts !== false
            ? { text: '已有联系方式', code: '待申请', tone: 'met' }
            : { text: '待认识', code: '可从线下开始', tone: 'stranger' };
    }
    if (char.inContacts === true) {
        return { text: '已有联系方式', code: '待申请', tone: 'met' };
    }
    if (char.relationStartMode === 'stranger') {
        return { text: '待认识', code: '可从线下开始', tone: 'stranger' };
    }
    return { text: '仅存档', code: '暂不互动', tone: 'archive' };
}

function getCharacterSubtitle(char, status) {
    const account = char.characterAccount || char.id || 'looky_000000';
    const familiarity = Number.isFinite(Number(char.familiarity)) ? Number(char.familiarity) : 0;
    return `${status.code} / ${account} / 熟悉度 ${familiarity}`;
}

function getFamiliarityStage(familiarity) {
    return getRelationshipStageByScore(familiarity);
}

function getCharacterCreatedSortKey(char) {
    const idText = String(char?.id || '');
    const numericMatch = idText.match(/\d+/g);
    if (numericMatch && numericMatch.length > 0) {
        return Number(numericMatch.join('')) || 0;
    }
    return Number(char?.updatedAt || char?.createdAt || 0) || 0;
}

function getLibraryPortraitGroups(allCharacters = []) {
    const sorted = [...allCharacters].sort((a, b) => getCharacterCreatedSortKey(b) - getCharacterCreatedSortKey(a));
    const groups = [
        {
            key: 'new',
            label: '新角色',
            english: 'NEW',
            items: sorted.slice(0, 5)
        },
        {
            key: 'stranger',
            label: '待认识',
            english: 'STRANGER',
            items: allCharacters.filter(char => char.relationStartMode === 'stranger' && !isCharacterFriend(char)).slice(0, 5)
        },
        {
            key: 'met',
            label: '已见面',
            english: 'MET',
            items: allCharacters.filter(char => char.relationStage === 'offline_met').slice(0, 5)
        },
        {
            key: 'pending',
            label: '申请中',
            english: 'PENDING',
            items: allCharacters.filter(char => char.relationStage === 'pending_user' || char.relationStage === 'pending_char').slice(0, 5)
        },
        {
            key: 'friend',
            label: '好友',
            english: 'FRIEND',
            items: allCharacters.filter(isCharacterFriend).slice(0, 5)
        }
    ];
    return groups;
}

function renderLibraryStoryStrip(allCharacters = [], stripId = 'cl-story-strip') {
    const strip = document.getElementById(stripId);
    if (!strip) return;
    const groups = getLibraryPortraitGroups(allCharacters);
    strip.innerHTML = groups.map(group => {
        const firstChar = group.items[0] || null;
        const avatar = firstChar && isValidAvatarSrc(firstChar.avatar) ? firstChar.avatar : DEFAULT_AVATAR_SRC;
        const countText = group.items.length > 0 ? String(group.items.length).padStart(2, '0') : '--';
        return `
            <button type="button" class="cl-story-item" data-story-key="${escapeHTML(group.key)}">
                <span class="cl-story-ring">
                    <img src="${avatar}" alt="${escapeHTML(group.label)}">
                </span>
                <strong>${escapeHTML(group.label)}</strong>
                <small>${escapeHTML(group.english)}</small>
                <em>${countText}</em>
            </button>
        `;
    }).join('');

    strip.querySelectorAll('.cl-story-item').forEach(button => {
        button.addEventListener('click', () => {
            if (stripId === 'ch-story-strip') {
                showPage('page-character-library');
                return;
            }
            document.getElementById('cl-character-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
}

function renderLibraryTodayPick(allCharacters = [], sectionId = 'cl-today-pick', backTarget = 'page-character-library') {
    const section = document.getElementById(sectionId);
    if (!section) return;
    const pick = allCharacters.find(isOfflineEncounterCandidateChar)
        || allCharacters.find(char => char.relationStartMode === 'stranger' && !isCharacterFriend(char))
        || allCharacters[0];
    if (!pick) {
        section.hidden = true;
        section.innerHTML = '';
        return;
    }
    const avatar = isValidAvatarSrc(pick.avatar) ? pick.avatar : DEFAULT_AVATAR_SRC;
    const status = getRelationStatus(pick);
    section.hidden = false;
    section.innerHTML = `
        <div class="cl-today-pick-main">
            <span class="cl-today-pick-kicker">今日推荐 <small>TODAY'S PICK</small></span>
            <div class="cl-today-pick-body">
                <img src="${avatar}" alt="${escapeHTML(pick.name || '角色')}" class="cl-today-pick-avatar">
                <div class="cl-today-pick-copy">
                    <strong>${escapeHTML(pick.name || '未命名角色')}</strong>
                    <p>${escapeHTML(status.text)} · ${escapeHTML(status.code)}</p>
                    <small>${escapeHTML(getCharacterSubtitle(pick, status))}</small>
                </div>
            </div>
        </div>
        <button type="button" class="cl-today-pick-btn" data-char-id="${escapeHTML(String(pick.id))}">去见面 <small>MEET</small></button>
    `;
    section.querySelector('.cl-today-pick-btn')?.addEventListener('click', async () => {
        const char = AppState.characterProfiles.find(item => String(item.id) === String(pick.id));
        if (!char) return;
        await openOfflineEncounterPageForChar(char, { backTarget, autoPrompt: true });
    });
}

function renderCharacterHubPage() {
    const allCharacters = AppState.characterProfiles.filter(char => !char.isGroup);
    const renderKey = allCharacters.map(char => [
        char.id,
        char.name,
        char.avatar,
        char.relationStartMode,
        char.relationStage,
        isCharacterFriend(char),
        char.inContacts
    ].join(':')).join('|');
    if (renderKey === lastCharacterHubRenderKey) return;
    lastCharacterHubRenderKey = renderKey;

    const friends = allCharacters.filter(isCharacterFriend);
    const strangers = allCharacters.filter(char => char.relationStartMode === 'stranger' && !isCharacterFriend(char));
    const met = allCharacters.filter(char => char.relationStage === 'offline_met');

    const totalCountEl = document.getElementById('ch-total-count');
    if (totalCountEl) totalCountEl.textContent = allCharacters.length;
    const strangerCountEl = document.getElementById('ch-stranger-count');
    if (strangerCountEl) strangerCountEl.textContent = strangers.length;
    const metCountEl = document.getElementById('ch-met-count');
    if (metCountEl) metCountEl.textContent = met.length;
    const friendCountEl = document.getElementById('ch-friend-count');
    if (friendCountEl) friendCountEl.textContent = friends.length;

    renderLibraryStoryStrip(allCharacters, 'ch-story-strip');
    renderLibraryTodayPick(allCharacters, 'ch-today-pick', 'page-character-hub');
}

function getTodayOfflineDateText() {
    return new Date().getDate().toString();
}

function getCurrentTimeText() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function parseLifeSyncMapPacks() {
    try {
        return JSON.parse(localStorage.getItem('looky_map_packs') || '{}') || {};
    } catch (error) {
        console.warn('[线下相遇] 地图预设读取失败:', error);
        return {};
    }
}

function getOfflineEncounterActivity(schedule) {
    const text = String(schedule?.content || '').trim();
    if (!text) return '等待见面';
    return text.includes('——') ? text.split('——').pop().trim() : text;
}

function getOfflineEncounterPinPosition(index) {
    const positions = [
        { top: '26%', left: '24%' },
        { top: '31%', left: '70%' },
        { top: '47%', left: '42%' },
        { top: '59%', left: '78%' },
        { top: '68%', left: '27%' },
        { top: '76%', left: '61%' },
        { top: '39%', left: '17%' },
        { top: '52%', left: '60%' },
        { top: '66%', left: '86%' },
        { top: '78%', left: '39%' },
        { top: '36%', left: '86%' },
        { top: '56%', left: '22%' }
    ];
    const base = positions[index % positions.length];
    if (index < positions.length) return base;
    const round = Math.floor(index / positions.length);
    const top = Math.max(18, Math.min(82, parseFloat(base.top) + ((round % 3) - 1) * 4));
    const left = Math.max(14, Math.min(86, parseFloat(base.left) + (round % 2 === 0 ? -5 : 5)));
    return { top: `${top}%`, left: `${left}%` };
}

async function getOfflineEncounterItem(char, index) {
    const status = getRelationStatus(char);
    const boundMapName = localStorage.getItem('ls_bound_map_' + char.id) || '';
    const mapPacks = parseLifeSyncMapPacks();
    const mapLocations = boundMapName ? (mapPacks[boundMapName] || []) : [];
    let schedules = [];
    try {
        const record = await db.appData.get('ls_schedules_data_' + char.id);
        schedules = Array.isArray(record?.value) ? record.value : [];
    } catch (error) {
        console.warn('[线下相遇] 日程读取失败:', char.id, error);
    }

    const todayText = getTodayOfflineDateText();
    const currentTime = getCurrentTimeText();
    const todaySchedules = schedules
        .filter(item => String(item.date) === todayText && (item.owner === 'ta' || item.owner === 'joint' || !item.owner))
        .sort((a, b) => String(a.startTime || '').localeCompare(String(b.startTime || '')));
    const activeSchedule = todaySchedules.find(item => String(item.startTime || '00:00') <= currentTime && String(item.endTime || '23:59') >= currentTime)
        || todaySchedules.find(item => String(item.endTime || '23:59') >= currentTime)
        || todaySchedules[0]
        || null;
    const locationName = activeSchedule?.locName || '';
    const matchedLocation = locationName
        ? mapLocations.find(loc => String(loc.name || '') === String(locationName))
        : null;
    const hasMap = Boolean(boundMapName && mapLocations.length > 0);
    const hasSchedule = Boolean(activeSchedule);
    const hasHistory = await hasOfflineEncounterHistory(char.id);
    const pinPosition = getOfflineEncounterPinPosition(index);
    const dataState = hasMap && hasSchedule
        ? '地图 / 日程'
        : hasSchedule
            ? '仅日程'
            : hasMap
                ? '仅地图'
                : '直接见面';

    return {
        char,
        status,
        hasMap,
        hasSchedule,
        hasHistory,
        isFirstMeet: !hasHistory && isOfflineEncounterCandidateChar(char),
        boundMapName,
        locationName: locationName || (hasMap ? '已绑定地图' : '干净地图'),
        activity: getOfflineEncounterActivity(activeSchedule),
        timeText: activeSchedule ? `${activeSchedule.startTime || '--:--'}-${activeSchedule.endTime || '--:--'}` : '可直接见面',
        dataState,
        overviewPinTop: pinPosition.top,
        overviewPinLeft: pinPosition.left,
        pinTop: matchedLocation?.top || pinPosition.top,
        pinLeft: matchedLocation?.left || pinPosition.left
    };
}

function shouldShowOfflineEncounterItem(item) {
    return Boolean(item?.char && isOfflineEncounterCandidateChar(item.char));
}

function applyOfflineEncounterZoom() {
    const viewport = document.getElementById('oe-map-viewport');
    if (viewport) {
        viewport.style.setProperty('--oe-map-scale', String(currentOfflineEncounterZoom));
    }
    const zoomText = document.getElementById('oe-zoom-text');
    if (zoomText) {
        zoomText.textContent = `${Math.round(currentOfflineEncounterZoom * 100)}%`;
    }
}

function setOfflineEncounterZoom(nextZoom) {
    currentOfflineEncounterZoom = Math.max(0.8, Math.min(1.6, Number(nextZoom) || 1));
    applyOfflineEncounterZoom();
}

function getOfflineEncounterTouchDistance(touches) {
    if (!touches || touches.length < 2) return 0;
    const first = touches[0];
    const second = touches[1];
    return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

function renderOfflineEncounterSelectionFromCache() {
    const visibleItems = offlineEncounterItemsCache.filter(shouldShowOfflineEncounterItem);
    if (!visibleItems.length) {
        currentOfflineEncounterCharId = null;
        isOfflineEncounterSingleMode = false;
        renderOfflineEncounterSelectedCard(null);
        const pinsContainer = document.getElementById('oe-map-pins');
        if (pinsContainer) pinsContainer.innerHTML = '';
        const chips = document.getElementById('oe-target-chips');
        if (chips) chips.innerHTML = '';
        const strip = document.getElementById('oe-target-strip');
        if (strip) strip.hidden = true;
        document.getElementById('page-offline-encounter')?.classList.remove('is-single-mode');
        applyOfflineEncounterZoom();
        return;
    }

    if (!currentOfflineEncounterCharId || !visibleItems.some(item => String(item.char.id) === String(currentOfflineEncounterCharId))) {
        currentOfflineEncounterCharId = visibleItems[0].char.id;
    }

    const selectedItem = visibleItems.find(item => String(item.char.id) === String(currentOfflineEncounterCharId)) || visibleItems[0];
    const mapItems = isOfflineEncounterSingleMode && selectedItem ? [selectedItem] : visibleItems;
    const pinsContainer = document.getElementById('oe-map-pins');
    if (pinsContainer) {
        pinsContainer.innerHTML = mapItems.map(item => {
            const avatar = isValidAvatarSrc(item.char.avatar) ? item.char.avatar : DEFAULT_AVATAR_SRC;
            const isActive = String(item.char.id) === String(currentOfflineEncounterCharId);
            const pinTop = isOfflineEncounterSingleMode ? item.pinTop : (item.overviewPinTop || item.pinTop);
            const pinLeft = isOfflineEncounterSingleMode ? item.pinLeft : (item.overviewPinLeft || item.pinLeft);
            const pinText = [item.activity, item.locationName].filter(text => text && text !== '干净地图' && text !== '未定位').join(' · ');
            return `
                <button type="button" class="oe-map-pin ${isActive ? 'active' : ''}" data-char-id="${escapeHTML(String(item.char.id))}" style="top:${pinTop}; left:${pinLeft};">
                    <img src="${avatar}" alt="${escapeHTML(item.char.name || '角色')}">
                    <span>${escapeHTML(pinText || item.char.name || '角色')}</span>
                </button>
            `;
        }).join('');
    }

    const chips = document.getElementById('oe-target-chips');
    const strip = document.getElementById('oe-target-strip');
    if (chips && strip) {
        strip.hidden = visibleItems.length === 0;
        chips.innerHTML = visibleItems.map(item => {
            const avatar = isValidAvatarSrc(item.char.avatar) ? item.char.avatar : DEFAULT_AVATAR_SRC;
            const isActive = String(item.char.id) === String(currentOfflineEncounterCharId);
            return `
                <button type="button" class="oe-target-chip ${isActive ? 'active' : ''}" data-char-id="${escapeHTML(String(item.char.id))}">
                    <img src="${avatar}" alt="${escapeHTML(item.char.name || '角色')}">
                    <span>${escapeHTML(item.char.name || '角色')}</span>
                </button>
            `;
        }).join('');
    }

    renderOfflineEncounterSelectedCard(isOfflineEncounterSingleMode ? selectedItem : null);
    document.getElementById('page-offline-encounter')?.classList.toggle('is-single-mode', isOfflineEncounterSingleMode);
    applyOfflineEncounterZoom();
}

function renderOfflineEncounterSelectedCard(item) {
    const card = document.getElementById('oe-selected-card');
    if (!card) return;
    if (!item) {
        card.hidden = true;
        card.innerHTML = '';
        return;
    }
    const char = item.char;
    const avatar = isValidAvatarSrc(char.avatar) ? char.avatar : DEFAULT_AVATAR_SRC;
    card.hidden = false;
    card.innerHTML = `
        <div class="oe-selected-main">
            <img src="${avatar}" alt="${escapeHTML(char.name || '角色')}" class="oe-selected-avatar">
            <div class="oe-selected-copy">
                <div class="oe-selected-name-row">
                    <strong>${escapeHTML(char.name || '未命名角色')}</strong>
                    <span>${escapeHTML(item.status.text)}</span>
                </div>
                <p>${escapeHTML(item.dataState)} · ${escapeHTML(item.boundMapName || '干净地图')}</p>
                <small>${escapeHTML(item.timeText)} · ${escapeHTML(item.activity || '直接见面')}</small>
            </div>
        </div>
        <div class="oe-selected-actions">
            <button type="button" class="oe-primary-action" data-action="meet" data-char-id="${escapeHTML(String(char.id))}">开启线下相遇</button>
        </div>
        <div class="oe-selected-links">
            <button type="button" data-action="detail" data-char-id="${escapeHTML(String(char.id))}">看资料</button>
            <button type="button" data-action="overview">总地图</button>
            <button type="button" data-action="later">稍后</button>
        </div>
    `;
}

async function renderOfflineEncounterPage(force = false) {
    const allCharacters = AppState.characterProfiles.filter(isOfflineEncounterCandidateChar);
    const renderKey = [
        allCharacters.map(char => [
            char.id,
            char.name,
            char.avatar,
            char.relationStage,
            char.relationStartMode,
            char.autoRideEnabled,
            char.offlineTimePerception,
            localStorage.getItem('ls_bound_map_' + char.id) || '',
            char.inContacts,
            char.offlineEncounterConfigured
        ].join(':')).join('|')
    ].join('||');
    if (!force && renderKey === lastOfflineEncounterRenderKey && offlineEncounterItemsCache.length > 0) return;
    lastOfflineEncounterRenderKey = renderKey;

    const items = await Promise.all(allCharacters.map((char, index) => getOfflineEncounterItem(char, index)));
    offlineEncounterItemsCache = items;
    renderOfflineEncounterSelectionFromCache();
}

function scheduleCharacterPageRender(pageId) {
    if (pendingCharacterPageRenderFrame) {
        cancelAnimationFrame(pendingCharacterPageRenderFrame);
    }
    pendingCharacterPageRenderFrame = requestAnimationFrame(() => {
        pendingCharacterPageRenderFrame = 0;
        const pageEl = document.getElementById(pageId);
        if (!pageEl || pageEl.style.display === 'none') return;
        if (pageId === 'page-character-hub') {
            renderCharacterHubPage();
        }
        if (pageId === 'page-character-library') {
            renderCharacterLibraryPage();
        }
        if (pageId === 'page-offline-encounter') {
            renderOfflineEncounterPage();
        }
    });
}

function setOfflineBackTarget(targetPageId) {
    document.querySelectorAll('#page-offline-mode .back-button, #offline-floating-back-btn').forEach(button => {
        button.dataset.target = targetPageId;
    });
}

function setOfflineEncounterBackTarget(targetPageId) {
    const backButton = document.querySelector('#page-offline-encounter .oe-back-button');
    if (backButton) {
        backButton.dataset.target = targetPageId;
    }
}

function hideOfflineEncounterModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.hidden = true;
    modal.classList.remove('visible');
}

function showOfflineEncounterModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('visible'));
}

function openOfflineEncounterPicker(forceRefresh = false) {
    renderOfflineEncounterPickerList();
    showOfflineEncounterModal('oe-picker-modal');
    if (!forceRefresh) return;
    requestAnimationFrame(async () => {
        lastOfflineEncounterRenderKey = null;
        await renderOfflineEncounterPage(true);
        renderOfflineEncounterPickerList();
    });
}

function renderOfflineEncounterPickerList() {
    const list = document.getElementById('oe-picker-list');
    if (!list) return;
    const items = offlineEncounterItemsCache.filter(shouldShowOfflineEncounterItem);
    if (items.length === 0) {
        list.innerHTML = '<div class="oe-picker-empty">暂无可线下初见的角色</div>';
        return;
    }
    list.innerHTML = items.map(item => {
        const avatar = isValidAvatarSrc(item.char.avatar) ? item.char.avatar : DEFAULT_AVATAR_SRC;
        const isActive = String(item.char.id) === String(currentOfflineEncounterCharId);
        return `
            <button type="button" class="oe-picker-item ${isActive ? 'active' : ''}" data-char-id="${escapeHTML(String(item.char.id))}">
                <img src="${avatar}" alt="${escapeHTML(item.char.name || '角色')}">
                <span><strong>${escapeHTML(item.char.name || '未命名角色')}</strong><small>${escapeHTML(item.activity || '可直接见面')} · ${escapeHTML(item.locationName || '干净地图')}</small></span>
            </button>
        `;
    }).join('');
}

async function hasActiveOfflineSession(charId) {
    if (localStorage.getItem(`offline_session_active_${charId}`)) return true;
    const lastMsg = await db.offlineMessages.where({ chatId: charId }).last();
    if (!lastMsg?.sessionId) return false;
    const endedSession = await db.offlineSessions
        .where({ chatId: charId })
        .filter(session => session.sessionId === lastMsg.sessionId)
        .first();
    return !endedSession;
}

function buildOfflineEncounterPrompt(char, mode = 'meet', userDirection = '') {
    const name = char.chatOverrideName || char.name || '对方';
    const intro = char.offlineInitialSetting
        ? `请优先读取并落实角色资料里的【线下初始设定】：${char.offlineInitialSetting}`
        : '如果角色资料里没有线下初始设定，就根据角色人设、世界书和已有记忆自然开场。';
    const direction = userDirection
        ? `\n用户为这次见面补充的前提：${userDirection}`
        : '';
    const modeText = mode === 'manual'
        ? '用户选择不接入地图或日程，直接创建一次临时线下见面。'
        : '用户选择与角色进行线下见面。地图和日程只作为辅助，不要让剧情围绕用户打转。';
    return `<系统指令：${modeText}
当前线下页面已经绑定角色ID：${char.id}，本次见面对象是「${name}」。
${intro}${direction}
请直接描写用户和 ${name} 第一次/本次线下见面时的场景、动作和对话。不要解释系统设置，不要输出JSON，不要复述“用户点击了按钮”。>`;
}

async function enterOfflineModeForEncounter(char, options = {}) {
    if (!char?.id) return;
    const hadActiveSessionBeforeVisit = await hasActiveOfflineSession(char.id);
    tempState.currentChatId = char.id;
    tempState.currentLifeSyncCharId = char.id;

    const storageKey = `offline_session_active_${char.id}`;
    if (!tempState.isDateActive || !tempState.currentOfflineSessionId || String(tempState.activeOfflineSession || '') !== String(char.id)) {
        let sessionId = localStorage.getItem(storageKey);
        if (!sessionId) {
            sessionId = `${char.id}-${Date.now()}`;
            localStorage.setItem(storageKey, sessionId);
        }
        tempState.isDateActive = true;
        tempState.activeOfflineSession = char.id;
        tempState.currentOfflineSessionId = sessionId;
        saveHybridStateToSession();
    }

    const titleElement = document.getElementById('offline-mode-title');
    if (titleElement) {
        titleElement.textContent = char.chatOverrideName || char.name || '线下见面';
    }

    const offlineAvatar = document.getElementById('offline-chat-avatar') || document.querySelector('#page-offline-mode .app-header img.avatar');
    if (offlineAvatar) {
        offlineAvatar.src = char.chatOverrideAvatar || char.avatar || DEFAULT_AVATAR_SRC;
    }

    const offlineInput = document.getElementById('offline-chat-input');
    if (offlineInput) offlineInput.value = '';

    const offlineContentEl = document.querySelector('#page-offline-mode .offline-chat-content');
    if (offlineContentEl) {
        offlineContentEl.style.backgroundImage = char.offlineWallpaper ? `url(${char.offlineWallpaper})` : 'none';
    }

    setOfflineBackTarget('page-offline-encounter');
    showPage('page-offline-mode');
    document.dispatchEvent(new CustomEvent('loadOfflineHistory', { detail: { chatId: char.id } }));

    if (hadActiveSessionBeforeVisit) return;

    const customPrompt = options.customPrompt || buildOfflineEncounterPrompt(char, options.mode || 'meet', options.userDirection || '');
    setTimeout(() => {
        document.dispatchEvent(new CustomEvent('startOfflineFlow', { detail: { chatId: char.id, customPrompt } }));
    }, 220);
}

function openOfflineEncounterSetup(char) {
    pendingOfflineEncounterActionCharId = char.id;
    currentOfflineEncounterCharId = char.id;
    const desc = document.getElementById('oe-setup-desc');
    if (desc) desc.textContent = `第一次和「${char.name || '这个角色'}」线下见面前，可以选择是否接入 Ta 的生活轨迹和时间感知。`;
    const lifeToggle = document.getElementById('oe-life-sync-toggle');
    const timeToggle = document.getElementById('oe-time-toggle');
    if (lifeToggle) lifeToggle.checked = Boolean(char.autoRideEnabled);
    if (timeToggle) timeToggle.checked = char.offlineTimePerception !== false;
    showOfflineEncounterModal('oe-setup-modal');
}

function openOfflineEncounterProgress(char) {
    pendingOfflineEncounterActionCharId = char.id;
    currentOfflineEncounterCharId = char.id;
    const input = document.getElementById('oe-progress-input');
    if (input) input.value = '';
    showOfflineEncounterModal('oe-progress-modal');
}

async function prepareOfflineEncounterPageForChar(char, backTarget = 'page-character-hub') {
    if (!char?.id) return;
    currentOfflineEncounterCharId = char.id;
    currentOfflineEncounterFilter = 'all';
    currentOfflineEncounterZoom = 1;
    isOfflineEncounterSingleMode = true;
    setOfflineEncounterBackTarget(backTarget);
    showPage('page-offline-encounter');
    await renderOfflineEncounterPage(true);
}

async function openOfflineEncounterPageForChar(char, options = {}) {
    if (!char?.id) return;
    if (!isOfflineEncounterCandidateChar(char) || await hasOfflineEncounterHistory(char.id)) {
        await handleOfflineEncounterMeet(char, options.mode || 'meet');
        return;
    }
    await prepareOfflineEncounterPageForChar(char, options.backTarget || 'page-character-hub');

    if (options.autoPrompt === false) return;
    if (!char.offlineEncounterConfigured) {
        openOfflineEncounterSetup(char);
        return;
    }
    let hasActiveSession = false;
    if (char.offlineTimePerception === false) {
        try {
            hasActiveSession = await hasActiveOfflineSession(char.id);
        } catch (error) {
            console.warn('[线下相遇] 活动会话状态读取失败:', char.id, error);
        }
    }
    if (char.offlineTimePerception === false && !hasActiveSession) {
        openOfflineEncounterProgress(char);
    }
}

async function handleOfflineEncounterMeet(char, mode = 'meet') {
    if (!char) return;
    currentOfflineEncounterCharId = char.id;
    const hasHistory = await hasOfflineEncounterHistory(char.id);
    if (!char.offlineEncounterConfigured && !hasHistory) {
        openOfflineEncounterSetup(char);
        return;
    }
    if (char.offlineTimePerception === false && !(await hasActiveOfflineSession(char.id))) {
        await prepareOfflineEncounterPageForChar(char);
        openOfflineEncounterProgress(char);
        return;
    }
    await enterOfflineModeForEncounter(char, { mode });
}

function getPersonaSummary(char) {
    return String(char.persona || char.subtitle || char.tag || '暂无人设摘要。').trim() || '暂无人设摘要。';
}

function getCardPersonaPreview(char) {
    const rawText = String(char.persona || char.subtitle || char.tag || '').trim();
    if (!rawText) return '暂无人设摘要';

    const lines = rawText
        .replace(/\r/g, '')
        .replace(/<\/?[^>]+>/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !/^#/.test(line))
        .filter(line => !/^(entries:|dialogue_entry:|situation:|tone_emotion:|dialogue:\s*\|?)$/i.test(line))
        .filter(line => !/^内容仅供参考/.test(line));

    const preferredIndex = lines.findIndex(line => /核心身份|背景|性格|关系描述|名称/.test(line));
    const startIndex = preferredIndex >= 0 ? preferredIndex : 0;
    return lines
        .slice(startIndex, startIndex + 3)
        .join(' ')
        .replace(/\s+/g, ' ')
        .slice(0, 120)
        .trim() || '暂无人设摘要';
}

function formatEventDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
}

function renderRelationshipEvents(char) {
    const eventsContainer = document.getElementById('cl-detail-events');
    if (!eventsContainer) return;

    const events = Array.isArray(char.relationshipEvents) ? char.relationshipEvents : [];
    if (events.length === 0) {
        eventsContainer.innerHTML = '<div class="cl-detail-empty-event">暂无关键事件</div>';
        return;
    }

    eventsContainer.innerHTML = events
        .slice()
        .reverse()
        .map(event => {
            const title = event.title || event.type || '关系事件';
            const summary = event.summary || '暂无事件摘要。';
            const dateText = formatEventDate(event.createdAt);
            return `
                <article class="cl-detail-event">
                    <span>${escapeHTML(dateText || '未记录日期')}</span>
                    <strong>${escapeHTML(title)}</strong>
                    <p>${escapeHTML(summary)}</p>
                </article>
            `;
        })
        .join('');
}

function createCharacterCard(char, index) {
    const status = getRelationStatus(char);
    const avatar = isValidAvatarSrc(char.avatar) ? char.avatar : DEFAULT_AVATAR_SRC;
    const persona = getCardPersonaPreview(char);
    const hasOfflineEntry = !isCharacterFriend(char) || char.relationStartMode === 'stranger';
    const card = document.createElement('article');
    card.className = `cl-character-card is-${status.tone}${hasOfflineEntry ? ' has-offline-entry' : ''}`;
    card.dataset.charId = char.id;
    card.innerHTML = `
        <div class="cl-card-index">${String(index + 1).padStart(2, '0')}</div>
        <img class="cl-card-avatar" src="${avatar}" alt="avatar" loading="lazy" decoding="async">
        <div class="cl-card-main">
            <div class="cl-card-topline">
                <span>${escapeHTML(status.text)}</span>
                <small>${escapeHTML(status.code)}</small>
            </div>
            <h2>${escapeHTML(char.name || '未命名角色')}</h2>
            <p class="cl-card-meta">${escapeHTML(getCharacterSubtitle(char, status))}</p>
            <p class="cl-card-summary">${escapeHTML(persona)}</p>
        </div>
        <div class="cl-card-buttons">
            <button type="button" class="cl-card-delete" data-action="delete">删除</button>
            <button type="button" class="cl-card-action" data-action="view">查看</button>
        </div>
    `;
    return card;
}

export function renderCharacterLibraryPage() {
    const list = document.getElementById('cl-character-list');
    if (!list) return;

    const allCharacters = AppState.characterProfiles.filter(char => !char.isGroup);
    const searchTerm = currentLibrarySearchTerm.trim().toLowerCase();
    const renderKey = `${searchTerm}|${allCharacters.map(char => [
        char.id,
        char.name,
        char.avatar,
        char.realName,
        char.characterAccount,
        char.persona,
        char.subtitle,
        char.relationStartMode,
        char.relationStage,
        isCharacterFriend(char)
    ].join(':')).join('|')}`;
    if (renderKey === lastCharacterLibraryRenderKey) return;
    lastCharacterLibraryRenderKey = renderKey;

    const characters = allCharacters
        .slice()
        .sort((a, b) => getCharacterCreatedSortKey(b) - getCharacterCreatedSortKey(a))
        .filter(char => {
            if (!searchTerm) return true;
            return [
                char.name,
                char.realName,
                char.characterAccount,
                char.persona,
                char.subtitle
            ].some(value => String(value || '').toLowerCase().includes(searchTerm));
        });
    const friends = allCharacters.filter(isCharacterFriend);
    const strangers = allCharacters.filter(char => char.relationStartMode === 'stranger' && !isCharacterFriend(char));
    const met = allCharacters.filter(char => char.relationStage === 'offline_met');
    const renderBatchToken = ++characterLibraryRenderBatchToken;

    document.getElementById('cl-total-count').textContent = allCharacters.length;
    const strangerCountEl = document.getElementById('cl-stranger-count');
    if (strangerCountEl) strangerCountEl.textContent = strangers.length;
    const metCountEl = document.getElementById('cl-met-count');
    if (metCountEl) metCountEl.textContent = met.length;
    document.getElementById('cl-friend-count').textContent = friends.length;

    renderLibraryStoryStrip(allCharacters);
    list.innerHTML = '';
    if (characters.length === 0) {
        list.innerHTML = `
            <div class="cl-empty-state">
                <span>${searchTerm ? 'NO RESULT' : 'NO CHARACTER'}</span>
                <p>${searchTerm ? '没有找到匹配的角色。' : '还没有角色，可以先添加一个。'}</p>
            </div>
        `;
        return;
    }

    const fragment = document.createDocumentFragment();
    const batchSize = 12;
    let index = 0;
    const renderNextBatch = () => {
        if (renderBatchToken !== characterLibraryRenderBatchToken) return;
        const endIndex = Math.min(index + batchSize, characters.length);
        for (; index < endIndex; index += 1) {
            fragment.appendChild(createCharacterCard(characters[index], index));
        }
        list.appendChild(fragment);
        if (index < characters.length) {
            requestAnimationFrame(renderNextBatch);
            return;
        }
        renderLibraryTodayPick(characters.length > 0 ? characters : allCharacters);
    };
    renderNextBatch();
}

export function renderCharacterDetailPage(charId) {
    const char = AppState.characterProfiles.find(item => String(item.id) === String(charId) && !item.isGroup);
    if (!char) {
        showDynamicIsland('没有找到这个角色');
        return false;
    }

    currentDetailCharId = char.id;
    const status = getRelationStatus(char);
    const avatar = isValidAvatarSrc(char.avatar) ? char.avatar : DEFAULT_AVATAR_SRC;
    const familiarity = Math.max(0, Math.min(100, Number(char.familiarity) || 0));
    const account = char.characterAccount || char.id || 'looky_000000';

    document.getElementById('cl-detail-avatar').src = avatar;
    document.getElementById('cl-detail-status').textContent = status.text;
    document.getElementById('cl-detail-name').textContent = char.name || '未命名角色';
    document.getElementById('cl-detail-account').textContent = account;
    document.getElementById('cl-detail-familiarity').textContent = familiarity;
    document.getElementById('cl-detail-stage').textContent = getFamiliarityStage(familiarity);
    document.getElementById('cl-detail-persona').textContent = getPersonaSummary(char);
    const detailPage = document.querySelector('.character-detail-page');
    if (detailPage) detailPage.dataset.tone = status.tone;

    const chatBtn = document.getElementById('cl-detail-chat-btn');
    if (chatBtn) {
        const canChat = isCharacterFriend(char);
        chatBtn.disabled = false;
        chatBtn.setAttribute('aria-disabled', String(!canChat));
        chatBtn.classList.toggle('is-disabled', !canChat);
        const chatBtnNote = chatBtn.querySelector('small');
        if (chatBtnNote) chatBtnNote.textContent = canChat ? 'CHAT' : 'LOCKED';
    }

    const canRequestFromDetail = char.relationStartMode === 'stranger'
        && !isCharacterFriend(char)
        && char.relationStage !== 'pending_user'
        && char.relationStage !== 'pending_char';
    document.getElementById('cl-detail-request-panel')?.toggleAttribute('hidden', !canRequestFromDetail);

    renderRelationshipEvents(char);
    return true;
}

async function updateDetailFriendRequest(char, direction, message = '') {
    if (detailFriendRequestPending) {
        showDynamicIsland('正在处理上一条申请');
        return;
    }
    detailFriendRequestPending = true;
    try {
    const isIncoming = direction === 'char_to_user';
    const wasInContacts = char.inContacts !== false;
    const requestMessage = isIncoming
        ? (char.incomingRequestMessage || char.pendingFriendRequestMessage || `我是${char.name || 'Ta'}`)
        : message;
    const updates = {
        inContacts: isIncoming ? wasInContacts : true,
        relationStage: isIncoming ? 'pending_char' : 'pending_user',
        hasChat: false,
        requiresOfflineMeet: false,
        requiresFriendRequest: true,
        pendingFriendRequestDirection: direction,
        pendingPreviousRelationStage: char.relationStage || 'library',
        pendingPreviousInContacts: wasInContacts,
        pendingFriendRequestMessage: requestMessage
    };
    Object.assign(char, updates);
    const friendRequest = await createOrUpdateFriendRequest(char, direction, requestMessage, {
        source: isIncoming ? 'detail_invite_me' : 'detail_request'
    });
    await db.characterProfiles.update(char.id, updates);
    let userToCharAiHandled = false;
    if (!isIncoming) {
        try {
            const threadId = friendRequest?.threadId || `frthread_${String(char.id)}_user_to_char`;
            const threadMessages = Array.isArray(AppState.friendRequestThreads?.[threadId])
                ? AppState.friendRequestThreads[threadId]
                : [];
            const result = await requestFriendRequestAiDecision(char, 'user_to_char', requestMessage, threadMessages);
            const responseBatchId = `frbatch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const rawMessageParts = Array.isArray(result.messages) && result.messages.length > 0
                ? result.messages
                : (result.content ? [{ text: result.content, translation: result.translation || '' }] : []);
            const messageParts = sanitizeFriendRequestMessageParts(rawMessageParts);
            const aiMessages = messageParts
                .map((part, index) => ({
                    id: `frmsg_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
                    sender: 'char',
                    text: part.text,
                    translation: part.translation || '',
                    decision: result.decision,
                    responseBatchId,
                    createdAt: Date.now() + index,
                    deletable: true
                }));
            if (aiMessages.length > 0) {
                if (!AppState.friendRequestThreads || typeof AppState.friendRequestThreads !== 'object') {
                    AppState.friendRequestThreads = {};
                }
                AppState.friendRequestThreads[threadId] = [...threadMessages, ...aiMessages];
                await saveFriendRequestThreads();
            }
            if (result.decision === 'accept') {
                await finalizeFriendRequestAcceptance(char, 'user_to_char', friendRequest, result.initialChatMessages);
            } else {
                if (result.decision === 'reject') {
                    await applyRelationshipScoreEvent(char, 'friend_request_reject', {
                        requestId: friendRequest?.id,
                        source: 'detail_request_ai',
                        summary: '角色暂时拒绝了用户的好友申请'
                    });
                }
                showDynamicIsland(result.decision === 'reject' ? 'Ta 暂时没有同意' : '验证回复已生成');
            }
            userToCharAiHandled = true;
        } catch (error) {
            console.error('[CharacterLibrary] friend request AI failed:', error);
        }
    }
    if (userToCharAiHandled) {
        renderCharacterDetailPage(char.id);
        window.refreshCharacterLibraryPage?.();
        window.refreshChatHomeFriendList?.();
        window.renderNewFriendsPage?.();
        return;
    }
    renderCharacterDetailPage(char.id);
    window.refreshCharacterLibraryPage?.();
    window.refreshChatHomeFriendList?.();
    window.renderNewFriendsPage?.();
    if (isIncoming) {
        const { notification } = await import('./notification.js');
        notification?.show(char.name || '新朋友', requestMessage || '收到一条好友申请', char.avatar || DEFAULT_AVATAR_SRC, 'page-new-friends', char.id);
    } else {
        showDynamicIsland('好友申请已发出');
    }
    } finally {
        detailFriendRequestPending = false;
    }
}

export function initCharacterLibraryPage() {
    window.addEventListener('looky:page-opened', (event) => {
        if (event.detail?.pageId === 'page-character-hub') {
            scheduleCharacterPageRender('page-character-hub');
        }
        if (event.detail?.pageId === 'page-character-library') {
            scheduleCharacterPageRender('page-character-library');
        }
        if (event.detail?.pageId === 'page-offline-encounter') {
            scheduleCharacterPageRender('page-offline-encounter');
        }
        if (event.detail?.pageId === 'page-life-sync') {
            const backBtn = document.querySelector('#page-life-sync .ls-back-btn');
            if (backBtn) {
                backBtn.dataset.target = tempState.lifeSyncBackTarget || 'home';
            }
            delete tempState.lifeSyncBackTarget;
        }
        if (event.detail?.pageId === 'page-chat-detail') {
            setOfflineBackTarget('page-chat-detail');
        }
    });
    window.addEventListener('looky:friend-request-updated', (event) => {
        const charId = String(event.detail?.charId || '');
        if (charId && String(currentDetailCharId || '') === charId) {
            renderCharacterDetailPage(charId);
        }
        scheduleCharacterPageRender('page-offline-encounter');
    });

    const openCharacterAdd = () => {
        if (typeof window.openCharacterAddPage === 'function') {
            window.openCharacterAddPage();
        } else {
            showPage('page-character-add');
        }
    };

    document.getElementById('ch-add-character-btn')?.addEventListener('click', openCharacterAdd);
    document.getElementById('cl-add-character-btn')?.addEventListener('click', openCharacterAdd);

    document.getElementById('ch-entry-library-btn')?.addEventListener('click', () => {
        showPage('page-character-library');
    });

    document.getElementById('ch-entry-offline-btn')?.addEventListener('click', () => {
        isOfflineEncounterSingleMode = false;
        currentOfflineEncounterZoom = 1;
        lastOfflineEncounterRenderKey = null;
        setOfflineEncounterBackTarget('page-character-hub');
        showPage('page-offline-encounter');
        scheduleCharacterPageRender('page-offline-encounter');
    });

    document.getElementById('oe-refresh-btn')?.addEventListener('click', () => {
        currentOfflineEncounterZoom = 1;
        openOfflineEncounterPicker(true);
    });

    document.querySelectorAll('#page-offline-encounter .oe-filter-chip').forEach(button => {
        button.addEventListener('click', () => {
            currentOfflineEncounterFilter = button.dataset.filter || 'all';
            document.querySelectorAll('#page-offline-encounter .oe-filter-chip').forEach(item => {
                item.classList.toggle('active', item === button);
            });
            renderOfflineEncounterPage(true);
        });
    });

    document.getElementById('oe-map-pins')?.addEventListener('click', (event) => {
        const pin = event.target.closest('.oe-map-pin');
        if (!pin) return;
        currentOfflineEncounterCharId = pin.dataset.charId;
        currentOfflineEncounterZoom = 1;
        isOfflineEncounterSingleMode = true;
        renderOfflineEncounterSelectionFromCache();
    });

    document.getElementById('oe-target-chips')?.addEventListener('click', (event) => {
        const chip = event.target.closest('.oe-target-chip');
        if (!chip) return;
        currentOfflineEncounterCharId = chip.dataset.charId;
        currentOfflineEncounterZoom = 1;
        isOfflineEncounterSingleMode = true;
        renderOfflineEncounterSelectionFromCache();
    });

    document.getElementById('oe-picker-close')?.addEventListener('click', () => hideOfflineEncounterModal('oe-picker-modal'));
    document.getElementById('oe-picker-list')?.addEventListener('click', (event) => {
        const item = event.target.closest('.oe-picker-item');
        if (!item) return;
        currentOfflineEncounterCharId = item.dataset.charId;
        currentOfflineEncounterZoom = 1;
        isOfflineEncounterSingleMode = true;
        hideOfflineEncounterModal('oe-picker-modal');
        renderOfflineEncounterSelectionFromCache();
    });

    document.getElementById('oe-zoom-in')?.addEventListener('click', () => {
        setOfflineEncounterZoom(currentOfflineEncounterZoom + 0.1);
    });
    document.getElementById('oe-zoom-out')?.addEventListener('click', () => {
        setOfflineEncounterZoom(currentOfflineEncounterZoom - 0.1);
    });
    document.getElementById('oe-zoom-reset')?.addEventListener('click', () => {
        setOfflineEncounterZoom(1);
    });
    document.getElementById('oe-map-stage')?.addEventListener('wheel', (event) => {
        event.preventDefault();
        setOfflineEncounterZoom(currentOfflineEncounterZoom + (event.deltaY < 0 ? 0.08 : -0.08));
    }, { passive: false });
    const mapViewport = document.getElementById('oe-map-viewport');
    mapViewport?.addEventListener('touchstart', (event) => {
        if (event.touches.length !== 2) return;
        offlineEncounterPinchStartDistance = getOfflineEncounterTouchDistance(event.touches);
        offlineEncounterPinchStartZoom = currentOfflineEncounterZoom;
    }, { passive: true });
    mapViewport?.addEventListener('touchmove', (event) => {
        if (event.touches.length !== 2 || !offlineEncounterPinchStartDistance) return;
        event.preventDefault();
        const nextDistance = getOfflineEncounterTouchDistance(event.touches);
        setOfflineEncounterZoom(offlineEncounterPinchStartZoom * (nextDistance / offlineEncounterPinchStartDistance));
    }, { passive: false });
    mapViewport?.addEventListener('touchend', (event) => {
        if (event.touches.length >= 2) return;
        offlineEncounterPinchStartDistance = 0;
        offlineEncounterPinchStartZoom = currentOfflineEncounterZoom;
    }, { passive: true });
    mapViewport?.addEventListener('touchcancel', () => {
        offlineEncounterPinchStartDistance = 0;
        offlineEncounterPinchStartZoom = currentOfflineEncounterZoom;
    }, { passive: true });

    document.getElementById('oe-selected-card')?.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        if (action === 'later') return;
        if (action === 'overview') {
            isOfflineEncounterSingleMode = false;
            currentOfflineEncounterZoom = 1;
            renderOfflineEncounterSelectionFromCache();
            return;
        }
        const char = AppState.characterProfiles.find(item => String(item.id) === String(button.dataset.charId));
        if (!char) return;
        if (action === 'detail') {
            if (renderCharacterDetailPage(char.id)) {
                showPage('page-character-detail');
            }
            return;
        }
        await handleOfflineEncounterMeet(char, action === 'manual' ? 'manual' : 'meet');
    });

    document.getElementById('oe-setup-close')?.addEventListener('click', () => hideOfflineEncounterModal('oe-setup-modal'));
    document.getElementById('oe-setup-cancel')?.addEventListener('click', () => hideOfflineEncounterModal('oe-setup-modal'));
    document.getElementById('oe-setup-confirm')?.addEventListener('click', async () => {
        const char = AppState.characterProfiles.find(item => String(item.id) === String(pendingOfflineEncounterActionCharId));
        if (!char) return;
        const lifeToggle = document.getElementById('oe-life-sync-toggle');
        const timeToggle = document.getElementById('oe-time-toggle');
        const updates = {
            autoRideEnabled: Boolean(lifeToggle?.checked),
            offlineTimePerception: timeToggle?.checked !== false,
            offlineEncounterConfigured: true
        };
        await db.characterProfiles.update(char.id, updates);
        Object.assign(char, updates);
        hideOfflineEncounterModal('oe-setup-modal');
        lastOfflineEncounterRenderKey = null;
        await renderOfflineEncounterPage(true);
        await enterOfflineModeForEncounter(char, { mode: updates.autoRideEnabled ? 'meet' : 'manual' });
    });

    document.getElementById('oe-progress-close')?.addEventListener('click', () => hideOfflineEncounterModal('oe-progress-modal'));
    document.getElementById('oe-progress-cancel')?.addEventListener('click', () => hideOfflineEncounterModal('oe-progress-modal'));
    document.getElementById('oe-progress-manual')?.addEventListener('click', async () => {
        const char = AppState.characterProfiles.find(item => String(item.id) === String(pendingOfflineEncounterActionCharId));
        if (!char) return;
        hideOfflineEncounterModal('oe-progress-modal');
        await enterOfflineModeForEncounter(char, { mode: 'manual' });
    });
    document.getElementById('oe-progress-confirm')?.addEventListener('click', async () => {
        const char = AppState.characterProfiles.find(item => String(item.id) === String(pendingOfflineEncounterActionCharId));
        if (!char) return;
        const input = document.getElementById('oe-progress-input');
        const userDirection = input?.value.trim() || '请根据已有前情自然推进到下一次线下见面。';
        hideOfflineEncounterModal('oe-progress-modal');
        await enterOfflineModeForEncounter(char, { mode: 'manual', userDirection });
    });

    document.getElementById('ch-view-library-btn')?.addEventListener('click', () => {
        showPage('page-character-library');
    });

    document.getElementById('cl-search-input')?.addEventListener('input', (event) => {
        currentLibrarySearchTerm = event.target.value || '';
        renderCharacterLibraryPage();
    });

    document.getElementById('cl-view-all-btn')?.addEventListener('click', () => {
        currentLibrarySearchTerm = '';
        const searchInput = document.getElementById('cl-search-input');
        if (searchInput) searchInput.value = '';
        renderCharacterLibraryPage();
    });

    document.getElementById('cl-character-list')?.addEventListener('click', (event) => {
        const card = event.target.closest('.cl-character-card');
        if (!card) return;
        const action = event.target.closest('button')?.dataset.action || 'view';
        if (action === 'delete') {
            event.stopPropagation();
            const char = AppState.characterProfiles.find(item => String(item.id) === String(card.dataset.charId));
            if (!char) return;
            const confirmed = confirm(`确定要彻底删除「${char.name || '这个角色'}」吗？\n\n这会同步删除好友列表、通讯录、聊天记录、线下记录、记忆、相册、申请记录等相关数据。`);
            if (!confirmed) return;
            deleteCharactersWithRelatedData([char.id]).then(deletedIds => {
                AppState.characterProfiles = AppState.characterProfiles.filter(item => !deletedIds.some(id => String(id) === String(item.id)));
                refreshCharacterLists();
                renderCharacterLibraryPage();
                showDynamicIsland('角色已彻底删除');
            }).catch(error => {
                console.error('角色库删除失败:', error);
                showDynamicIsland('删除失败，请检查控制台');
            });
            return;
        }
        if (renderCharacterDetailPage(card.dataset.charId)) {
            showPage('page-character-detail');
        }
    });

    document.getElementById('cl-detail-offline-btn')?.addEventListener('click', async () => {
        const char = AppState.characterProfiles.find(item => String(item.id) === String(currentDetailCharId) && !item.isGroup);
        if (!char) return;
        await openOfflineEncounterPageForChar(char, { backTarget: 'page-character-detail', autoPrompt: true });
    });

    document.getElementById('cl-detail-chat-btn')?.addEventListener('click', async () => {
        const char = AppState.characterProfiles.find(item => String(item.id) === String(currentDetailCharId) && !item.isGroup);
        if (!char) return;
        if (!isCharacterFriend(char)) {
            showDynamicIsland('通过好友申请后才能线上聊天');
            return;
        }
        setOfflineBackTarget('page-chat-detail');
        const { handleFriendClick } = await import('./chat.js');
        handleFriendClick(char.id);
    });

    document.getElementById('cl-detail-invite-me-btn')?.addEventListener('click', async () => {
        const char = AppState.characterProfiles.find(item => String(item.id) === String(currentDetailCharId) && !item.isGroup);
        if (char) await updateDetailFriendRequest(char, 'char_to_user');
    });

    document.getElementById('cl-detail-request-btn')?.addEventListener('click', async () => {
        const char = AppState.characterProfiles.find(item => String(item.id) === String(currentDetailCharId) && !item.isGroup);
        if (!char) return;
        const message = await showInputModal({
            title: '填写验证消息',
            initialValue: char.pendingFriendRequestMessage || '',
            placeholder: '例如：你好，我是刚刚在便利店门口和你说过话的人。',
            isTextarea: true
        });
        if (message === null) return;
        await updateDetailFriendRequest(char, 'user_to_char', message);
    });

    document.getElementById('cl-detail-edit-btn')?.addEventListener('click', () => {
        if (typeof window.openCharacterEditPage === 'function') {
            window.openCharacterEditPage(currentDetailCharId);
        } else {
            showDynamicIsland('编辑页还没有准备好');
        }
    });
}

window.refreshCharacterLibraryPage = renderCharacterLibraryPage;
