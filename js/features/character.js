
import { AppState, db, tempState, DEFAULT_AVATAR_SRC, getFirstMessageTimestamp, isCharacterFriend, createFriendRelationshipUpdates, createDefaultMemoryProfile, isInvalidCharacterScopedThemeRule } from '../state.js';
import { UI, showDynamicIsland, showInputModal, showPage } from '../ui.js';
import { addTapListener, compressImageDataUrl, isValidAvatarSrc, escapeHTML } from '../utils.js';
import { BLOCK_APPEAL_SOURCE, BLOCK_APPEAL_USER_SOURCE, appendBlockAppealThreadMessage, createFriendRequestChatCardMessage, createOrUpdateFriendRequest, getBlockAppealLastMessageTime, getPendingBlockAppealRequest, getSafeFriendRequestText, isBlockAppealRequest, isFriendRequestMetaReplyText, looksLikeFriendRequestJsonFragment, requestBlockAppealMessage, requestFriendRequestAiDecision, requestFriendRequestRetryDecision } from './friend-requests.js';
import { applyRelationshipScoreEvent } from './relationship-score.js';

// 标记是否处于好友列表长按后的操作模式
let isFriendSelectionMode = false;
// 缓存当前激活的弹出菜单
let activePopover = null;
let tempNpcList = [];
let selectedGroupForModify = null; // 临时记录用户选了哪个组
let editingNpcIndex = -1;
let addFriendRenderToken = 0;
let friendListRenderToken = 0;
let contactListRenderToken = 0;
let isCharacterManagementInitialized = false;
let chatHomeCompanionWidgetToken = 0;
let chatFriendListNeedsRender = true;
let contactListNeedsRender = true;
let selectedFriendRequestMessageIds = new Set();
let friendRequestGenerationControllers = {};
const CHAT_HOME_LAST_CHAT_KEY = 'looky_chat_home_last_chat_id';
const FRIEND_REQUEST_TERMINAL_NOTE = '已成为好友，请前往主聊天';
export let finalizeFriendRequestAcceptance = async () => {
    throw new Error('好友申请通过收尾逻辑尚未初始化');
};
// 图片转 Base64 辅助函数
const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = async () => resolve(await compressImageDataUrl(reader.result));
    reader.onerror = error => reject(error);
});

function createChatFriendItem(char) {
    const item = document.createElement('div');
    item.className = `conversation-item ${char.isPinned ? 'is-pinned' : ''}`;
    item.dataset.charId = char.id;

    const displayAvatar = char.chatOverrideAvatar || char.avatar || DEFAULT_AVATAR_SRC;
    const displayName = char.chatOverrideName || char.name;
    const insMetaHTML = document.body.classList.contains('chat-home-style-ins')
        ? '<span class="chat-time"></span>'
        : '';

    item.innerHTML = `
        <div class="chat-avatar-wrapper">
            <img src="${isValidAvatarSrc(displayAvatar) ? displayAvatar : DEFAULT_AVATAR_SRC}" class="chat-avatar" alt="avatar" loading="lazy" decoding="async">
            ${char.tag && char.tag.toLowerCase().includes('在线') ? '<div class="online-indicator"></div>' : ''}
        </div>
        <div class="chat-details">
            <div class="chat-name-row">
                <span class="chat-name">${escapeHTML(displayName)}</span>
                <span class="chat-tag tag-purple">${escapeHTML(char.subtitle)}</span>
            </div>
            <div class="chat-preview">写点什么</div>
        </div>
        ${insMetaHTML}`;
    return item;
}

function formatChatHomeCompanionDate(timestamp) {
    if (!timestamp) return 'NO RECORD';
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return 'NO RECORD';
    return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
}

function getChatHomeCompanionDays(timestamp) {
    if (!timestamp) return 0;
    const diffTime = Date.now() - new Date(timestamp).getTime();
    if (!Number.isFinite(diffTime) || diffTime < 0) return 0;
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function getChatHomeLastCompanionChar(friends = []) {
    const lastChatId = tempState.currentChatId || localStorage.getItem(CHAT_HOME_LAST_CHAT_KEY);
    if (lastChatId) {
        const lastChar = friends.find(char => String(char.id) === String(lastChatId))
            || AppState.characterProfiles.find(char => String(char.id) === String(lastChatId) && isCharacterFriend(char));
        if (lastChar) return lastChar;
    }
    return friends[0] || null;
}

function createChatHomeCompanionWidget(friends = []) {
    const char = getChatHomeLastCompanionChar(friends);
    if (!char) return null;

    const token = ++chatHomeCompanionWidgetToken;
    const displayAvatar = char.chatOverrideAvatar || char.avatar || DEFAULT_AVATAR_SRC;
    const displayName = char.chatOverrideName || char.name;
    const widget = document.createElement('div');
    widget.className = 'chat-home-ins-companion-widget';
    widget.dataset.charId = char.id;
    widget.innerHTML = `
        <img class="chat-home-ins-companion-avatar" src="${isValidAvatarSrc(displayAvatar) ? displayAvatar : DEFAULT_AVATAR_SRC}" alt="avatar" loading="lazy" decoding="async">
        <div class="chat-home-ins-companion-main">
            <div class="chat-home-ins-companion-line">
                <span class="chat-home-ins-companion-name">${escapeHTML(displayName)}</span>
                <span class="chat-home-ins-companion-deco">WITH YOU</span>
            </div>
            <div class="chat-home-ins-companion-rule"></div>
            <div class="chat-home-ins-companion-meta">
                <span class="chat-home-ins-companion-days">--</span>
                <span class="chat-home-ins-companion-time">正在读取陪伴天数</span>
            </div>
        </div>
        <span class="chat-home-ins-companion-mark">DAY</span>
    `;

    const updateWidget = (nextChar) => {
        if (token !== chatHomeCompanionWidgetToken || !widget.isConnected) return;
        const nextAvatar = nextChar.chatOverrideAvatar || nextChar.avatar || DEFAULT_AVATAR_SRC;
        const nextName = nextChar.chatOverrideName || nextChar.name;
        widget.dataset.charId = nextChar.id;
        widget.querySelector('.chat-home-ins-companion-avatar').src = isValidAvatarSrc(nextAvatar) ? nextAvatar : DEFAULT_AVATAR_SRC;
        widget.querySelector('.chat-home-ins-companion-name').textContent = nextName;
        getFirstMessageTimestamp(nextChar.id).then(firstTimestamp => {
            if (token !== chatHomeCompanionWidgetToken || !widget.isConnected) return;
            if (String(widget.dataset.charId) !== String(nextChar.id)) return;
            const days = getChatHomeCompanionDays(firstTimestamp);
            widget.querySelector('.chat-home-ins-companion-days').textContent = days;
            widget.querySelector('.chat-home-ins-companion-time').textContent = days > 0
                ? `陪伴天数 · SINCE ${formatChatHomeCompanionDate(firstTimestamp)}`
                : '暂无聊天陪伴记录';
        }).catch(() => {
            if (token !== chatHomeCompanionWidgetToken || !widget.isConnected) return;
            if (String(widget.dataset.charId) !== String(nextChar.id)) return;
            widget.querySelector('.chat-home-ins-companion-time').textContent = '陪伴天数读取失败';
        });
    };

    updateWidget(char);
    db.chatMessages.orderBy('timestamp').last().then(lastMessage => {
        if (token !== chatHomeCompanionWidgetToken || !widget.isConnected) return;
        const latestChar = friends.find(item => String(item.id) === String(lastMessage?.chatId));
        if (latestChar) updateWidget(latestChar);
    }).catch(() => {});

    return widget;
}

function appendChatFriendItem(char) {
    const container = UI.friendsContent.querySelector('.conversation-list');
    if (!container || container.querySelector(`.conversation-item[data-char-id="${char.id}"]`)) return;

    if (document.body.classList.contains('chat-home-style-ins')) {
        refreshChatHomeFriendListWhenVisible();
        return;
    }

    const emptyText = container.querySelector('p');
    if (emptyText) emptyText.remove();

    const item = createChatFriendItem(char);
    const searchTerm = document.getElementById('chat-search-input')?.value.toLowerCase().trim() || '';
    if (searchTerm) {
        const name = item.querySelector('.chat-name')?.textContent.toLowerCase() || '';
        item.style.display = name.includes(searchTerm) ? '' : 'none';
    }
    container.appendChild(item);
}

function removeChatFriendItem(charId) {
    const container = UI.friendsContent.querySelector('.conversation-list');
    const item = container?.querySelector(`.conversation-item[data-char-id="${charId}"]`);
    if (document.body.classList.contains('chat-home-style-ins')) {
        if (item) refreshChatHomeFriendListWhenVisible();
        return;
    }
    if (item) item.remove();
    if (container && !container.querySelector('.conversation-item')) {
        container.innerHTML = `<p style="text-align:center; color: var(--c-text-secondary);">暂无好友，从通讯录添加吧</p>`;
    }
}

function removeCharacterContactItems(charIds) {
    const ids = Array.isArray(charIds) ? charIds : [charIds];
    ids.forEach(charId => {
        UI.characterContactsListContainer
            ?.querySelector(`.contacts-list-item[data-char-id="${charId}"]`)
            ?.remove();
    });

    UI.characterContactsListContainer?.querySelectorAll('.contacts-section').forEach(section => {
        if (!section.querySelector('.contacts-list-item[data-char-id]')) {
            section.innerHTML = '<div class="contacts-list-item" style="justify-content: center; color: var(--c-text-secondary);">此分组为空</div>';
        }
    });
}

function resolveCharacterIds(charIds) {
    const rawIds = Array.isArray(charIds) ? charIds : [charIds];
    return [...new Set(rawIds.filter(Boolean).map(id => {
        const char = AppState.characterProfiles.find(profile => String(profile.id) === String(id));
        return char ? char.id : id;
    }))];
}

export async function deleteCharactersWithRelatedData(charIds) {
    const ids = resolveCharacterIds(charIds);
    if (ids.length === 0) return [];
    const idSet = new Set(ids.map(id => String(id)));
    const deletedChars = AppState.characterProfiles.filter(char => idSet.has(String(char.id)));
    const ownedWorldBookCategories = [...new Set(deletedChars
        .map(char => char.characterWorldBookCategoryName)
        .filter(Boolean))];
    const changedGroups = AppState.characterProfiles
        .filter(char => char?.isGroup && Array.isArray(char.memberIds) && char.memberIds.some(memberId => idSet.has(String(memberId))))
        .map(group => ({
            ...group,
            memberIds: group.memberIds.filter(memberId => !idSet.has(String(memberId))),
            memberMountedWBIds: Object.fromEntries(Object.entries(group.memberMountedWBIds || {}).filter(([memberId]) => !idSet.has(String(memberId))))
        }));

    await db.transaction(
        'rw',
        db.appData,
        db.characterProfiles,
        db.chatMessages,
        db.importantMemories,
        db.offlineMessages,
        db.offlineSessions,
        db.galleryImages,
        db.galleryGroups,
        db.ttsCache,
        db.moments,
        db.diaries,
        db.diarySettings,
        db.smsMessages,
        db.lookyVaults,
        db.lookyVaultLogs,
        db.lookyLedger,
        db.themeApplications,
        db.worldBookEntries,
        db.worldBookCategories,
        async () => {
        await db.characterProfiles.bulkDelete(ids);
        await Promise.all(ids.map(charId => Promise.all([
            db.chatMessages.where('chatId').equals(charId).delete(),
            db.importantMemories.where('charId').equals(charId).delete(),
            db.offlineMessages.where('chatId').equals(charId).delete(),
            db.offlineSessions.where('chatId').equals(charId).delete(),
            db.galleryImages.where('charId').equals(charId).delete(),
            db.galleryGroups.where('charId').equals(charId).delete(),
            db.ttsCache.where('charId').equals(charId).delete(),
            db.moments.where('characterId').equals(charId).delete(),
            db.moments.where('author').equals(charId).delete(),
            db.diaries.where('charId').equals(charId).delete(),
            db.diarySettings.where('charId').equals(charId).delete(),
            db.smsMessages.where('chatId').equals(charId).delete(),
            db.lookyVaults.delete(charId),
            db.lookyVaultLogs.where('charId').equals(charId).delete(),
            db.lookyLedger.where('char').equals(charId).delete()
        ])));
        if (changedGroups.length > 0) await db.characterProfiles.bulkPut(changedGroups);
        const applications = await db.themeApplications.toArray();
        const applicationIdsToDelete = [];
        const applicationsToUpdate = [];
        applications.forEach(item => {
            const originalIds = Array.isArray(item.characterIds) ? item.characterIds : null;
            if (isInvalidCharacterScopedThemeRule(item)) {
                applicationIdsToDelete.push(item.id);
                return;
            }
            if (!originalIds) return;

            const filteredIds = originalIds.filter(charId => !idSet.has(String(charId)));
            if (filteredIds.length === originalIds.length) return;
            // chat + [] 是合法的全局规则；非 chat 失去最后一个目标时整条删除。
            if (item.type !== 'chat' && filteredIds.length === 0) {
                applicationIdsToDelete.push(item.id);
            } else {
                applicationsToUpdate.push({ ...item, characterIds: filteredIds });
            }
        });
        if (applicationIdsToDelete.length > 0) {
            await db.themeApplications.bulkDelete(applicationIdsToDelete);
        }
        if (applicationsToUpdate.length > 0) {
            await db.themeApplications.bulkPut(applicationsToUpdate);
        }
        if (ownedWorldBookCategories.length > 0) {
            await db.worldBookEntries.where('category').anyOf(ownedWorldBookCategories).delete();
            await db.worldBookCategories.where('name').anyOf(ownedWorldBookCategories).delete();
        }
        const storedRequests = Array.isArray(AppState.friendRequests) ? AppState.friendRequests : [];
        const removedThreadIds = new Set(storedRequests
            .filter(request => idSet.has(String(request.charId)))
            .map(request => request.threadId)
            .filter(Boolean));
        AppState.friendRequests = storedRequests.filter(request => !idSet.has(String(request.charId)));
        const threads = AppState.friendRequestThreads && typeof AppState.friendRequestThreads === 'object'
            ? { ...AppState.friendRequestThreads }
            : {};
        Object.keys(threads).forEach(threadId => {
            const belongsToDeletedChar = ids.some(charId => String(threadId).includes(String(charId)));
            if (removedThreadIds.has(threadId) || belongsToDeletedChar) delete threads[threadId];
        });
        AppState.friendRequestThreads = threads;
        await db.appData.put({ key: 'friendRequests', value: AppState.friendRequests });
        await db.appData.put({ key: 'friendRequestThreads', value: AppState.friendRequestThreads });
    });

    if (ids.some(id => String(id) === String(tempState.currentChatId))) {
        tempState.currentChatId = null;
        AppState.currentChatHistory = [];
    }
    changedGroups.forEach(group => {
        const stateGroup = AppState.characterProfiles.find(char => String(char.id) === String(group.id));
        if (stateGroup) {
            stateGroup.memberIds = group.memberIds;
            stateGroup.memberMountedWBIds = group.memberMountedWBIds;
        }
    });
    return ids;
}

export async function clearOnlineChatMessagesForCharacters(charIds) {
    const ids = resolveCharacterIds(charIds);
    if (ids.length === 0) return [];

    await db.transaction('rw', db.chatMessages, async () => {
        await Promise.all(ids.map(charId => db.chatMessages.where('chatId').equals(charId).delete()));
    });

    if (ids.some(id => String(id) === String(tempState.currentChatId))) {
        AppState.currentChatHistory = [];
    }
    return ids;
}

async function clearFriendRequestDataForCharacters(charIds) {
    const ids = resolveCharacterIds(charIds);
    if (ids.length === 0) return;
    const idSet = new Set(ids.map(String));
    const storedRequests = Array.isArray(AppState.friendRequests) ? AppState.friendRequests : [];
    const removedThreadIds = new Set(storedRequests
        .filter(request => idSet.has(String(request.charId)))
        .map(request => request.threadId)
        .filter(Boolean));
    AppState.friendRequests = storedRequests.filter(request => !idSet.has(String(request.charId)));
    const threads = AppState.friendRequestThreads && typeof AppState.friendRequestThreads === 'object'
        ? { ...AppState.friendRequestThreads }
        : {};
    Object.keys(threads).forEach(threadId => {
        const belongsToChar = ids.some(charId => String(threadId).includes(`_${charId}_`));
        if (removedThreadIds.has(threadId) || belongsToChar) delete threads[threadId];
    });
    AppState.friendRequestThreads = threads;
    await db.appData.put({ key: 'friendRequests', value: AppState.friendRequests });
    await db.appData.put({ key: 'friendRequestThreads', value: AppState.friendRequestThreads });
}

function clearFirstVisitConfigForCharacter(char) {
    if (!char) return;
    if (char.chatIdentityId) char.lastChatIdentityId = char.chatIdentityId;
    if (char.useLightPrompt !== undefined) char.lastUseLightPrompt = char.useLightPrompt;
    delete char.isFirstVisit;
}

function showContactDeleteChoiceModal(count) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay visible';
        overlay.style.cssText = 'position: fixed; inset: 0; width: 100vw; height: 100dvh; min-height: 100dvh; align-items: center; justify-content: center; box-sizing: border-box; overflow: hidden; touch-action: none; overscroll-behavior: contain; padding: max(20px, env(safe-area-inset-top)) 0 max(20px, env(safe-area-inset-bottom)) 0;';
        overlay.innerHTML = `
            <div class="modal-card" style="width: 92%; max-width: 380px; max-height: calc(100dvh - 40px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;">
                <h3 class="modal-title">删除通讯录角色</h3>
                <p style="font-size: 14px; line-height: 1.7; color: var(--c-text-secondary); margin: 12px 0 18px;">
                    将清空选中角色的线上聊天记录。你可以只把角色移出通讯录并保留在角色库，也可以直接删除角色。
                </p>
                <div style="display: grid; gap: 10px;">
                    <button class="btn btn-secondary" data-choice="library">保留在角色库</button>
                    <button class="btn btn-secondary" data-choice="stranger">从陌生关系开始</button>
                    <button class="btn btn-danger" data-choice="delete">直接删除该角色</button>
                    <button class="btn btn-secondary" data-choice="cancel">取消</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = (choice) => {
            overlay.remove();
            resolve(choice);
        };

        overlay.addEventListener('click', event => {
            const button = event.target.closest('button[data-choice]');
            if (button) {
                close(button.dataset.choice);
                return;
            }
            if (event.target === overlay) close('cancel');
        });
    });
}

function showContactStrangerShortcutModal(count) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay visible';
        overlay.style.cssText = 'position: fixed; inset: 0; width: 100vw; height: 100dvh; min-height: 100dvh; align-items: center; justify-content: center; box-sizing: border-box; overflow: hidden; touch-action: none; overscroll-behavior: contain; padding: max(20px, env(safe-area-inset-top)) 0 max(20px, env(safe-area-inset-bottom)) 0;';
        overlay.innerHTML = `
            <div class="modal-card" style="width: 92%; max-width: 380px; max-height: calc(100dvh - 40px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;">
                <h3 class="modal-title">从陌生关系开始</h3>
                <p style="font-size: 14px; line-height: 1.7; color: var(--c-text-secondary); margin: 12px 0 18px;">
                    已选择 ${count} 个角色。接下来可以只回到陌生状态，也可以直接生成一条好友申请。
                </p>
                <div style="display: grid; gap: 10px;">
                    <button class="btn btn-secondary" data-choice="offline">从线下开始</button>
                    <button class="btn btn-secondary" data-choice="incoming">Ta 加你</button>
                    <button class="btn btn-secondary" data-choice="outgoing">你加 Ta</button>
                    <button class="btn btn-secondary" data-choice="cancel">取消</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = (choice) => {
            overlay.remove();
            resolve(choice);
        };

        overlay.addEventListener('click', event => {
            const button = event.target.closest('button[data-choice]');
            if (button) {
                close(button.dataset.choice);
                return;
            }
            if (event.target === overlay) close('cancel');
        });
    });
}

function createAddFriendItem(char) {
    const item = document.createElement('div');
    item.className = 'add-friend-item';
    item.dataset.charId = char.id;
    item.innerHTML = `<img src="${isValidAvatarSrc(char.avatar) ? char.avatar : DEFAULT_AVATAR_SRC}" alt="avatar" loading="lazy" decoding="async"><span>${escapeHTML(char.name)}</span>`;
    return item;
}

function applyCurrentFriendSearchToItem(item) {
    if (document.body.classList.contains('chat-home-style-ins')) return;
    const searchTerm = document.getElementById('chat-search-input')?.value.toLowerCase().trim() || '';
    if (!searchTerm) return;
    const name = item.querySelector('.chat-name')?.textContent.toLowerCase() || '';
    item.style.display = name.includes(searchTerm) ? '' : 'none';
}

function isChatHomePageVisible() {
    const page = document.getElementById('page-chat');
    return page && getComputedStyle(page).display !== 'none';
}

function isChatHomeSectionVisible(contentId) {
    const section = document.getElementById(contentId);
    return isChatHomePageVisible() && section && getComputedStyle(section).display !== 'none';
}

function appendFriendItemsInBatches(list, friends, token, onComplete) {
    const batchSize = 24;
    let index = 0;

    const renderBatch = () => {
        if (token !== friendListRenderToken) return;
        const fragment = document.createDocumentFragment();
        const end = Math.min(index + batchSize, friends.length);
        for (; index < end; index++) {
            const item = createChatFriendItem(friends[index]);
            applyCurrentFriendSearchToItem(item);
            fragment.appendChild(item);
        }
        list.appendChild(fragment);

        if (index < friends.length) {
            requestAnimationFrame(renderBatch);
        } else {
            onComplete?.();
        }
    };

    requestAnimationFrame(renderBatch);
}

function createContactItem(char) {
    const item = document.createElement('div');
    item.className = 'contacts-list-item';
    item.dataset.charId = char.id;
    item.innerHTML = `
        <input type="checkbox" data-char-id="${char.id}">
        <img class="contact-item-avatar" src="${isValidAvatarSrc(char.avatar) ? char.avatar : DEFAULT_AVATAR_SRC}" alt="avatar" loading="lazy" decoding="async">
        <span class="item-text">${escapeHTML(char.name)}</span>
    `;
    return item;
}

function appendContactItemsInBatches(list, members, token, onComplete) {
    const batchSize = 30;
    let index = 0;

    const renderBatch = () => {
        if (token !== contactListRenderToken) return;
        const fragment = document.createDocumentFragment();
        const end = Math.min(index + batchSize, members.length);
        for (; index < end; index++) {
            fragment.appendChild(createContactItem(members[index]));
        }
        list.appendChild(fragment);

        if (index < members.length) {
            requestAnimationFrame(renderBatch);
        } else {
            onComplete?.();
        }
    };

    requestAnimationFrame(renderBatch);
}

function appendContactGroupsInBatches(pendingGroups, token) {
    let groupIndex = 0;
    const renderNextGroup = () => {
        if (token !== contactListRenderToken) return;
        const group = pendingGroups[groupIndex];
        if (!group) return;
        groupIndex += 1;
        appendContactItemsInBatches(group.section, group.members, token, renderNextGroup);
    };
    renderNextGroup();
}

function renderAddFriendListInBatches(container, potentialFriends) {
    const token = ++addFriendRenderToken;
    const batchSize = 20;
    let index = 0;

    container.innerHTML = '<p style="text-align:center; padding: 20px; color: var(--c-text-secondary);">正在加载角色...</p>';

    const renderBatch = () => {
        if (token !== addFriendRenderToken) return;
        if (index === 0) container.innerHTML = '';

        const fragment = document.createDocumentFragment();
        const end = Math.min(index + batchSize, potentialFriends.length);
        for (; index < end; index++) {
            fragment.appendChild(createAddFriendItem(potentialFriends[index]));
        }
        container.appendChild(fragment);

        if (index < potentialFriends.length) {
            requestAnimationFrame(renderBatch);
        }
    };

    requestAnimationFrame(renderBatch);
}

/**
 * 渲染好友列表 (聊天主页的第一个Tab)
 */
function renderChatFriendsList() {
    const container = UI.friendsContent.querySelector('.conversation-list');
    const token = ++friendListRenderToken;
    chatFriendListNeedsRender = false;
    container.innerHTML = '';
    let friends = AppState.characterProfiles.filter(isCharacterFriend);
    friends.sort((a, b) => (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0));

    if (friends.length === 0) {
        container.innerHTML = `<p style="text-align:center; color: var(--c-text-secondary);">暂无好友，从通讯录添加吧</p>`;
        return;
    }

    const fragment = document.createDocumentFragment();
    const isInsStyle = document.body.classList.contains('chat-home-style-ins');
    const refreshPreviews = () => {
        if (token !== friendListRenderToken) return;
        import('./chat-ui.js').then(({ initSidebarPreviews }) => initSidebarPreviews()).catch(() => {});
        window.applyChatHomeInsListFilter?.();
    };

    if (isInsStyle) {
        const pendingSections = [];
        const appendInsSection = (title, deco, sectionFriends, type = '') => {
            if (!sectionFriends.length) return;
            const section = document.createElement('section');
            section.className = `chat-friend-section ${type}`.trim();
            section.innerHTML = `
                <div class="chat-friend-section-list"></div>
            `;
            const list = section.querySelector('.chat-friend-section-list');
            pendingSections.push({ list, friends: sectionFriends });
            fragment.appendChild(section);
        };

        const currentInsView = document.body.dataset.chatHomeInsView || 'all';
        const currentInsGroupId = document.body.dataset.chatHomeInsGroupId || '';
        const currentGroup = AppState.characterGroups.find(group => String(group.id) === currentInsGroupId);
        const regularTitle = currentInsView === 'groups' ? '群聊' : currentInsView === 'character-group' ? (currentGroup?.name || '分组') : '全部聊天';
        const regularDeco = currentInsView === 'groups' ? 'GROUPS' : currentInsView === 'character-group' ? 'GROUP' : 'ALL CHATS';
        const companionWidget = createChatHomeCompanionWidget(friends);

        if (companionWidget) fragment.appendChild(companionWidget);
        appendInsSection('置顶', 'PINNED', friends.filter(char => char.isPinned), 'chat-friend-section--pinned');
        appendInsSection(regularTitle, regularDeco, friends.filter(char => !char.isPinned), 'chat-friend-section--regular');
        container.appendChild(fragment);
        if (pendingSections.length === 0) {
            refreshPreviews();
            return;
        }
        let completedSections = 0;
        pendingSections.forEach(section => {
            appendFriendItemsInBatches(section.list, section.friends, token, () => {
                completedSections += 1;
                if (completedSections === pendingSections.length) refreshPreviews();
            });
        });
        return;
    }

    container.appendChild(fragment);
    appendFriendItemsInBatches(container, friends, token, refreshPreviews);
};

function refreshChatHomeFriendListWhenVisible() {
    if (!isChatHomeSectionVisible('friends-content')) {
        chatFriendListNeedsRender = true;
        return;
    }
    renderChatFriendsList();
}
window.refreshChatHomeFriendList = refreshChatHomeFriendListWhenVisible;

/**
 * 渲染通讯录列表 (聊天主页的第二个Tab)
 */
function renderCharacterContactsList() {
    const container = UI.characterContactsListContainer;
    const token = ++contactListRenderToken;
    contactListNeedsRender = false;
    container.innerHTML = '';
    const fragment = document.createDocumentFragment();
    const groups = AppState.characterGroups.length > 0
        ? AppState.characterGroups
        : [{ id: 'default', name: 'AI角色' }];
    const fallbackGroup = groups.find(group => String(group.id) === 'default') || groups[0];
    const membersByGroup = new Map(groups.map(group => [String(group.id), []]));
    const knownGroupIds = new Set(groups.map(group => String(group.id)));
    const pendingGroups = [];

    AppState.characterProfiles
        .filter(char => char.inContacts !== false)
        .forEach(char => {
            const groupId = knownGroupIds.has(String(char.groupId)) ? String(char.groupId) : String(fallbackGroup.id);
            if (!membersByGroup.has(groupId)) membersByGroup.set(groupId, []);
            membersByGroup.get(groupId).push(char);
        });

    groups.forEach(group => {
        const members = membersByGroup.get(String(group.id)) || [];
        const details = document.createElement('details');
        details.className = 'contacts-group';
        details.open = true;
        details.innerHTML = `<summary>${escapeHTML(group.name)}</summary><div class="contacts-section"></div>`;
        const section = details.querySelector('.contacts-section');
        if (members.length > 0) {
            pendingGroups.push({ section, members });
        } else {
            section.innerHTML = '<div class="contacts-list-item" style="justify-content: center; color: var(--c-text-secondary);">此分组为空</div>';
        }
        fragment.appendChild(details);
    });
    container.appendChild(fragment);
    appendContactGroupsInBatches(pendingGroups, token);
    
    // 如果当前在选择模式，保持选择模式的样式
    if (container.classList.contains('selection-mode')) {
        // No need to re-add, just ensure it's correct
    }
};

function refreshCharacterContactsListWhenVisible() {
    if (!isChatHomeSectionVisible('contacts-content')) {
        contactListNeedsRender = true;
        return;
    }
    renderCharacterContactsList();
}

/**
 * 优化保存和渲染流程 (已修复)
 */
export async function optimizedSaveAndRender() {
    try {
        // ▼▼▼【核心修正】▼▼▼
        // 1. 将内存中所有的角色 profiles 完整地批量写回 characterProfiles 表
        await db.characterProfiles.bulkPut(AppState.characterProfiles);

        // 2. 像以前一样，单独保存分组信息到 appData 表
        const currentGroupData = { groups: AppState.characterGroups };
        await db.appData.put({ key: 'characterData', value: currentGroupData });
        // ▲▲▲ 修正结束 ▲▲▲

        // 3. 异步更新UI
        requestAnimationFrame(() => {
            window.refreshChatHomeInsSegment?.();
            refreshCharacterContactsListWhenVisible();
            refreshChatHomeFriendListWhenVisible();
        });
    } catch (error) {
        console.error("保存角色数据失败:", error);
        showDynamicIsland("数据保存失败，请检查控制台");
    }
}

async function saveCharacterFieldsAndRender(charIds, updates, options = {}) {
    const ids = (Array.isArray(charIds) ? charIds : [charIds]).filter(Boolean);
    const { refreshContacts = false, refreshFriends = true } = options;
    if (ids.length === 0) return;

    try {
        await db.transaction('rw', db.characterProfiles, async () => {
            await Promise.all(ids.map(id => db.characterProfiles.update(id, updates)));
        });
        requestAnimationFrame(() => {
            if (refreshContacts) refreshCharacterContactsListWhenVisible();
            if (refreshFriends) refreshChatHomeFriendListWhenVisible();
        });
    } catch (error) {
        console.error("更新角色好友状态失败:", error);
        showDynamicIsland("数据保存失败，请检查控制台");
    }
}

export function refreshCharacterLists(options = {}) {
    const { refreshContacts = true, refreshFriends = true } = options;
    requestAnimationFrame(() => {
        if (refreshContacts) refreshCharacterContactsListWhenVisible();
        if (refreshFriends) refreshChatHomeFriendListWhenVisible();
    });
}

/**
 * 渲染NPC列表到弹窗
 */
function renderNpcList() {
    UI.npcListContainer.innerHTML = '';
    
    // 如果正在编辑模式，修改按钮文字
    const addBtn = document.getElementById('npc-add-btn');
    if (addBtn) {
        if (editingNpcIndex > -1) {
            addBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg> 保存修改`;
            addBtn.style.background = "#333"; // 深色表示保存
        } else {
            addBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> 添加至列表`;
            addBtn.style.background = "#000"; // 纯黑表示添加
        }
    }

    if (tempNpcList.length === 0) {
        UI.npcListContainer.innerHTML = `<div style="padding:20px; text-align:center; color:#86868b; font-size:13px;">列表为空<br>请在下方添加</div>`;
        return;
    }
    
    const fragment = document.createDocumentFragment();
    tempNpcList.forEach((npc, index) => {
        const div = document.createElement('div');
        // 如果当前项是被选中的，添加 editing 样式
        div.className = `npc-item ${index === editingNpcIndex ? 'editing' : ''}`;
        
        const avatarSrc = npc.avatar || 'images/default-avatar.svg';
        const prob = npc.probability || 70;

        div.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px; flex-grow:1; cursor:pointer;" class="npc-click-area">
                <img src="${avatarSrc}" style="width:36px; height:36px; border-radius:10px; object-fit:cover; border:1px solid #f0f0f0;">
                <div class="npc-info">
                    <span>${escapeHTML(npc.name)} <span style="font-size:10px; color:#999; font-weight:normal; border:1px solid #eee; padding:1px 4px; border-radius:4px;">${prob}% 活跃</span></span>
                    <small>${escapeHTML(npc.relation)} ${npc.persona ? '• 已设人设' : ''}</small>
                </div>
            </div>
            <button class="npc-delete-btn" data-index="${index}">×</button>
        `;
        
        // 【新增】点击整个条目（除了删除按钮）触发编辑
        div.querySelector('.npc-click-area').addEventListener('click', () => {
            startEditingNpc(index);
        });

        fragment.appendChild(div);
    });
    UI.npcListContainer.appendChild(fragment);
}
/**
 * 开始编辑某个 NPC
 */
function startEditingNpc(index) {
    const npc = tempNpcList[index];
    if (!npc) return;

    editingNpcIndex = index; // 标记当前正在编辑第几个

    // 回填数据到输入框
    UI.npcNameInput.value = npc.name;
    UI.npcRelationInput.value = npc.relation;
    UI.npcPersonaInput.value = npc.persona || '';
    
    // 回填头像
    const preview = document.getElementById('npc-avatar-preview');
    if (preview) preview.src = npc.avatar || 'images/default-avatar.svg';

    // 回填概率
    const slider = document.getElementById('npc-probability-input');
    const display = document.getElementById('npc-prob-display');
    if (slider && display) {
        const prob = npc.probability || 70;
        slider.value = prob;
        display.textContent = `${prob}%`;
    }

    // 重新渲染列表（为了更新选中样式和按钮文字）
    renderNpcList();
}



/**
 * 初始化角色和通讯录管理功能
 * @param {function} onFriendClick - 当好友项被点击时触发的回调函数
 */
export function initCharacterManagement(onFriendClick) {
    if (isCharacterManagementInitialized) {
        refreshCharacterLists();
        return;
    }
    isCharacterManagementInitialized = true;

    let isSelectionMode = false;
    let longPressTimer;
    let friendLongPressTimer;

    const enterSelectionMode = (targetItem) => {
        isSelectionMode = true;
        UI.characterContactsListContainer.classList.add('selection-mode');
        UI.contactsMoreBtn.style.display = 'block';
        UI.contactsMenu.style.display = 'block';
        if (targetItem) {
            const checkbox = targetItem.querySelector('input[type="checkbox"]');
            if (checkbox) checkbox.checked = true;
            targetItem.classList.add('item-selected');
            if (!tempState.selectedCharIds.includes(targetItem.dataset.charId)) {
                tempState.selectedCharIds.push(targetItem.dataset.charId);
            }
        }
    };

    const exitSelectionMode = () => {
        if (!isSelectionMode) return;
        isSelectionMode = false;
        UI.characterContactsListContainer.classList.remove('selection-mode');
        UI.characterContactsListContainer.querySelectorAll('.contacts-list-item').forEach(item => {
            item.classList.remove('item-selected');
            const checkbox = item.querySelector('input[type="checkbox"]');
            if (checkbox) checkbox.checked = false;
        });
        tempState.selectedCharIds.length = 0;
        UI.contactsMenu.style.display = 'none';
    };

    const hideFriendActionPopover = () => {
        if (activePopover) {
            activePopover.classList.remove('visible');
            setTimeout(() => { if (activePopover) activePopover.remove(); activePopover = null; }, 200);
        }
        isFriendSelectionMode = false;
    };

    const renderAddFriendModalList = () => {
        const container = document.getElementById('add-friend-list-container');
        if (!container) return;
        const potentialFriends = AppState.characterProfiles
            .filter(char => char.inContacts !== false && !isCharacterFriend(char));
        addFriendRenderToken++;
        if (potentialFriends.length === 0) {
            container.innerHTML = `<p style="text-align:center; padding: 20px; color: var(--c-text-secondary);">通讯录里的角色都已经是好友了</p>`;
            return;
        }
        renderAddFriendListInBatches(container, potentialFriends);
    };

    const FRIEND_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
    const FRIEND_REQUEST_RETRY_MIN_MS = 5 * 1000;
    const FRIEND_REQUEST_RETRY_MAX_MS = 10 * 1000;

    const saveFriendRequestRecords = async () => {
        if (!Array.isArray(AppState.friendRequests)) AppState.friendRequests = [];
        await db.appData.put({ key: 'friendRequests', value: AppState.friendRequests });
    };

    const saveFriendRequestThreads = async () => {
        if (!AppState.friendRequestThreads || typeof AppState.friendRequestThreads !== 'object') {
            AppState.friendRequestThreads = {};
        }
        await db.appData.put({ key: 'friendRequestThreads', value: AppState.friendRequestThreads });
    };

    const getFriendRequestDirectionFromMode = (mode = 'received') => {
        return mode === 'sent' ? 'user_to_char' : 'char_to_user';
    };

    const getFriendRequestThreadId = (char, mode = 'received', request = null) => {
        const direction = request?.direction || getFriendRequestDirectionFromMode(mode);
        return request?.threadId || `frthread_${String(char?.id || 'unknown')}_${direction}`;
    };

    const getFriendRequestThreadMessages = (threadId) => {
        const threads = AppState.friendRequestThreads && typeof AppState.friendRequestThreads === 'object'
            ? AppState.friendRequestThreads
            : {};
        return Array.isArray(threads[threadId]) ? threads[threadId] : [];
    };

    const getBlockAppealIntervalMs = (char) => Math.max(0, Number(char?.blockReactionTime || 0)) * 60 * 1000;

    const saveBlockAppealProfileState = async (char, message = '') => {
        if (!char) return;
        const previousStage = char.pendingPreviousRelationStage
            || (char.relationStage && char.relationStage !== 'pending_char' ? char.relationStage : 'friend');
        const previousInContacts = char.pendingPreviousInContacts === null || char.pendingPreviousInContacts === undefined
            ? char.inContacts !== false
            : char.pendingPreviousInContacts === true;
        const preservedHasChat = previousStage === 'friend' || char.hasChat === true;
        const updates = {
            inContacts: previousInContacts,
            relationStage: previousStage,
            hasChat: preservedHasChat,
            requiresFriendRequest: previousStage === 'friend' ? false : char.requiresFriendRequest,
            requiresOfflineMeet: previousStage === 'friend' ? false : char.requiresOfflineMeet,
            pendingFriendRequestDirection: 'char_to_user',
            pendingFriendRequestMessage: message || char.pendingFriendRequestMessage || '',
            pendingPreviousRelationStage: previousStage,
            pendingPreviousInContacts: previousInContacts,
            blockAppealPhase: 'friend_request'
        };
        Object.assign(char, updates);
        await db.characterProfiles.update(char.id, updates);
        window.dispatchEvent(new CustomEvent('looky:friend-request-updated', { detail: { charId: char.id } }));
    };

    const transitionBlockAppealToSms = async (char) => {
        if (!char || char.blockAppealPhase !== 'friend_request') return false;
        const now = Date.now();
        const updates = {
            blockAppealPhase: 'sms',
            hasReactedToBlock: true,
            lastBlockSmsTime: now,
            blockedByAiNumbers: []
        };
        Object.assign(char, updates);
        await db.characterProfiles.update(char.id, updates);
        return true;
    };

    const markBlockAppealRejected = async (char, request) => {
        if (!char || !isBlockAppealRequest(request) || (request.status || 'pending') !== 'pending') return null;
        request.retryCount = Math.min(3, Number(request.retryCount || 0) + 1);
        request.status = 'pending';
        request.resolvedAt = null;
        request.retryAt = null;
        request.blockAppealRejected = true;
        request.blockAppealRejectedAt = Date.now();
        await saveFriendRequestRecords();
        if (request.retryCount >= 3) await transitionBlockAppealToSms(char);
        window.dispatchEvent(new CustomEvent('looky:friend-request-updated', { detail: { charId: char.id } }));
        return request;
    };

    const buildBlockAppealRestoreUpdates = (char) => {
        const restoredStage = char.pendingPreviousRelationStage || (char.relationStage === 'pending_char' ? 'friend' : (char.relationStage || 'friend'));
        const restoredInContacts = char.pendingPreviousInContacts === null || char.pendingPreviousInContacts === undefined
            ? char.inContacts !== false
            : char.pendingPreviousInContacts === true;
        const restoredHasChat = restoredStage === 'friend' || char.hasChat === true;
        return {
            isBlocked: false,
            isSmsBlocked: false,
            blockedByAiNumbers: [],
            blockTimestamp: null,
            lastMainChatUnblockedAt: Date.now(),
            hasReactedToBlock: false,
            lastBlockSmsTime: 0,
            blockAppealPhase: null,
            relationStage: restoredStage,
            inContacts: restoredInContacts,
            hasChat: restoredHasChat,
            requiresFriendRequest: restoredStage === 'friend' ? false : char.requiresFriendRequest,
            requiresOfflineMeet: restoredStage === 'friend' ? false : char.requiresOfflineMeet,
            pendingFriendRequestDirection: null,
            pendingFriendRequestMessage: '',
            pendingPreviousRelationStage: null,
            pendingPreviousInContacts: null
        };
    };
    const isBlockedByAiAppealRequest = (request = {}) => {
        return request?.source === BLOCK_APPEAL_USER_SOURCE && request.direction === 'user_to_char';
    };
    const renderFriendRequestTranslation = (translation = '') => {
        if (!translation) return '';
        return `
            <button type="button" class="nf-request-translate-btn active" aria-label="查看翻译">文</button>
            <div class="nf-request-translation">${escapeHTML(translation).replace(/\n/g, '<br>')}</div>
        `;
    };
    const splitFriendRequestReplyText = (rawText = '') => {
               let parts = String(rawText || '').split(/\r?\n+/);
        parts = parts.map(part => part.trim()).filter(Boolean);
        return parts.length > 0 ? parts : ['...'];
    };
    const extractInlineBracketTranslation = (text = '') => {
        const raw = String(text || '').trim();
        const match = raw.match(/^([\s\S]*?)\s*[\[【]([^\[\]【】]+)[\]】]\s*$/);
        if (match && /[\u4e00-\u9fa5]/.test(match[2]) && /[a-zA-Z\u3040-\u30ff\uac00-\ud7a3\u0400-\u04ff]/.test(match[1])) {
            return { text: match[1].trim(), translation: match[2].trim() };
        }
        return { text: raw, translation: '' };
    };
    const normalizeFriendRequestReplyParts = (messageParts = [], fallbackTranslation = '', options = {}) => {
        const sourceParts = Array.isArray(messageParts) ? messageParts : [];
        const shouldFilterMetaText = options.filterMetaText !== false;
        const normalized = [];
        sourceParts.forEach((part, partIndex) => {
            const text = typeof part === 'string' ? part : part?.text;
            const translation = typeof part === 'string' ? '' : part?.translation;
            if (shouldFilterMetaText && looksLikeFriendRequestJsonFragment(text)) return;
        splitFriendRequestReplyText(text).forEach((bubbleText, bubbleIndex) => {
            if (shouldFilterMetaText && (isFriendRequestMetaReplyText(bubbleText) || looksLikeFriendRequestJsonFragment(bubbleText))) return;
            const inline = extractInlineBracketTranslation(bubbleText);
            const baseTranslation = bubbleIndex === 0
                ? (translation || (partIndex === 0 ? fallbackTranslation : '') || '')
                : '';
            normalized.push({
                text: inline.text,
                translation: baseTranslation || inline.translation || ''
            });
        });
        });
        return normalized;
    };

    const waitFriendRequestTypingDelay = (signal, delay = 760) => new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
    });

    const showFriendRequestTypingIndicator = (thread) => {
        if (!thread || thread.querySelector('.nf-request-typing-row')) return;
        const row = document.createElement('div');
        row.className = 'nf-request-message-row nf-request-typing-row is-entering';
        row.innerHTML = `
            <div class="nf-request-bubble nf-request-typing-bubble" aria-label="正在输入">
                <span></span><span></span><span></span>
            </div>
        `;
        thread.appendChild(row);
        thread.scrollTop = thread.scrollHeight;
    };

    const hideFriendRequestTypingIndicator = (thread) => {
        thread?.querySelector('.nf-request-typing-row')?.remove();
    };

    const getFriendRequestModalBaseMessage = (modal, char) => {
        return modal?.dataset.baseMessage !== undefined
            ? modal.dataset.baseMessage
            : (char?.pendingFriendRequestMessage || '暂时没有验证消息。');
    };

    const ensureRetryRequestMessageInThread = async (threadId, request = null) => {
        if (!threadId || (request?.source !== 'retry' && request?.source !== BLOCK_APPEAL_SOURCE) || !request?.id || !request?.message) return;
        const markerId = `frreq_${String(request.id)}`;
        const messages = getFriendRequestThreadMessages(threadId);
        if (messages.some(message => String(message.id) === markerId || String(message.requestId || '') === String(request.id))) return;
        const direction = request.direction || getFriendRequestDirectionFromMode('received');
        const requestParts = normalizeFriendRequestReplyParts([{
            text: request.message,
            translation: request.translation || ''
        }], request.translation || '');
        if (requestParts.length === 0) return;
        const baseCreatedAt = request.createdAt || Date.now();
        const nextMessages = requestParts.map((part, index) => ({
            id: index === 0 ? markerId : `${markerId}_${index}`,
            sender: direction === 'user_to_char' ? 'user' : 'char',
            text: part.text,
            translation: part.translation || '',
            requestId: request.id,
            requestBubble: true,
            createdAt: baseCreatedAt + index,
            deletable: request.source === BLOCK_APPEAL_SOURCE
        }));
        AppState.friendRequestThreads[threadId] = [...messages, ...nextMessages]
            .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
        await saveFriendRequestThreads();
    };

    const appendRetryRequestMessagesToThread = async (threadId, request = null, messageParts = []) => {
        if (!threadId || !request?.id) return;
        const markerId = `frreq_${String(request.id)}`;
        const messages = getFriendRequestThreadMessages(threadId);
        if (messages.some(message => String(message.id) === markerId || String(message.requestId || '') === String(request.id))) return;
        const normalized = normalizeFriendRequestReplyParts(messageParts, '', { filterMetaText: true });
        if (normalized.length === 0) return;
        const baseCreatedAt = request.createdAt || Date.now();
        const nextMessages = normalized.map((part, index) => ({
            id: index === 0 ? markerId : `${markerId}_${index}`,
            sender: request.direction === 'user_to_char' ? 'user' : 'char',
            text: part.text,
            translation: part.translation || '',
            requestId: request.id,
            requestBubble: true,
            createdAt: baseCreatedAt + index,
            deletable: false
        }));
        AppState.friendRequestThreads[threadId] = [...messages, ...nextMessages]
            .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
        await saveFriendRequestThreads();
    };

    const renderFriendRequestThreadMessages = (thread, baseMessage, mode, threadMessages = [], baseTranslation = '', animateMessageIds = new Set()) => {
        if (!thread) return;
        const visibleBaseMessage = String(baseMessage || '').trim();
        const baseBubbles = visibleBaseMessage
            ? normalizeFriendRequestReplyParts([{ text: visibleBaseMessage, translation: baseTranslation }], '', {
                filterMetaText: mode !== 'sent'
            })
            .map(part => `
            <div class="nf-request-message-row ${mode === 'sent' ? 'is-user' : ''}">
                <div class="nf-request-bubble ${mode === 'sent' ? 'is-user' : ''}">
                    ${escapeHTML(part.text || '')}
                    ${renderFriendRequestTranslation(part.translation || '')}
                </div>
            </div>
        `).join('')
            : '';
        const orderedThreadMessages = [...threadMessages]
            .filter(message => message.sender === 'user' || (!isFriendRequestMetaReplyText(message.text) && !looksLikeFriendRequestJsonFragment(message.text)))
            .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
        const savedBubbles = orderedThreadMessages.map(message => `
            <div class="nf-request-message-row ${message.sender === 'user' ? 'is-user' : ''} ${animateMessageIds.has(String(message.id)) ? 'is-entering' : ''}"
                data-message-id="${escapeHTML(String(message.id))}"
                data-deletable-message="${message.deletable ? 'true' : 'false'}">
                <div class="nf-request-bubble ${message.sender === 'user' ? 'is-user' : ''} ${selectedFriendRequestMessageIds.has(String(message.id)) ? 'is-selected' : ''}">
                    ${escapeHTML(message.text || '')}
                    ${renderFriendRequestTranslation(message.translation || '')}
                </div>
            </div>
        `).join('');
        thread.innerHTML = `${baseBubbles}${savedBubbles}`;
        thread.scrollTop = thread.scrollHeight;
    };

    const pruneExpiredFriendRequestRecords = () => {
        if (!Array.isArray(AppState.friendRequests)) {
            AppState.friendRequests = [];
            return;
        }
        const now = Date.now();
        const nextRequests = AppState.friendRequests.filter(request => {
            const status = request.status || 'pending';
            if (status === 'pending') return true;
            const resolvedAt = Number(request.resolvedAt || 0);
            return resolvedAt && now - resolvedAt <= FRIEND_REQUEST_RETENTION_MS;
        });
        if (nextRequests.length !== AppState.friendRequests.length) {
            AppState.friendRequests = nextRequests;
            saveFriendRequestRecords().catch(error => console.warn('[NewFriends] prune request records failed:', error));
        }
    };

    const recordFriendRequestResult = async (char, status, directionFallback) => {
        if (!char) return null;
        if (!Array.isArray(AppState.friendRequests)) AppState.friendRequests = [];
        const now = Date.now();
        const direction = char.pendingFriendRequestDirection || directionFallback;
        const existingIndex = AppState.friendRequests.findIndex(request => (
            String(request.charId) === String(char.id)
            && request.direction === direction
            && (request.status || 'pending') === 'pending'
        ));
        const existing = existingIndex >= 0 ? AppState.friendRequests[existingIndex] : null;
        const shouldRetry = status === 'rejected' && direction === 'char_to_user';
        const recordMessage = getSafeFriendRequestText(
            existing?.message || '',
            char.pendingFriendRequestMessage || char.incomingRequestMessage || ''
        ) || `我是${char.name || 'Ta'}`;
        const requestRecord = {
            id: existing?.id || `fr_${String(char.id)}_${direction}_${now}`,
            charId: char.id,
            direction,
            threadId: existing?.threadId || getFriendRequestThreadId(char, direction === 'user_to_char' ? 'sent' : 'received', existing),
            status,
            message: recordMessage,
            createdAt: existing?.createdAt || now,
            resolvedAt: now,
            retryAt: shouldRetry
                ? now + FRIEND_REQUEST_RETRY_MIN_MS + Math.floor(Math.random() * (FRIEND_REQUEST_RETRY_MAX_MS - FRIEND_REQUEST_RETRY_MIN_MS))
                : null,
            retryCount: shouldRetry ? Number(existing?.retryCount || 0) + 1 : Number(existing?.retryCount || 0),
            source: existing?.source || 'manual'
        };
        if (existingIndex >= 0) {
            AppState.friendRequests.splice(existingIndex, 1, requestRecord);
        } else {
            AppState.friendRequests.unshift(requestRecord);
        }
        if (status === 'accepted' || status === 'rejected') {
            await applyRelationshipScoreEvent(char, status === 'accepted' ? 'friend_request_accept' : 'friend_request_reject', {
                requestId: requestRecord.id,
                source: requestRecord.source,
                summary: status === 'accepted' ? '好友申请被接受' : '好友申请被拒绝'
            });
        }
        pruneExpiredFriendRequestRecords();
        await saveFriendRequestRecords();
        return requestRecord;
    };

    const processDueFriendRequestRetries = async () => {
        if (!Array.isArray(AppState.friendRequests)) return;
        const now = Date.now();
        const dueRequests = AppState.friendRequests.filter(request => (
            request.status === 'rejected'
            && request.direction === 'char_to_user'
            && request.source !== BLOCK_APPEAL_SOURCE
            && request.retryAt
            && Number(request.retryAt) <= now
        ));
        if (dueRequests.length === 0) return;

        for (const request of dueRequests) {
            const char = AppState.characterProfiles.find(item => String(item.id) === String(request.charId));
            if (!char || isCharacterFriend(char)) continue;
            const retryThreadId = request.threadId || getFriendRequestThreadId(char, 'received', request);
            const retryResult = await requestFriendRequestRetryDecision(char, request, getFriendRequestThreadMessages(retryThreadId));
            const retryParts = normalizeFriendRequestReplyParts(
                Array.isArray(retryResult.messages) && retryResult.messages.length > 0
                    ? retryResult.messages
                    : [{ text: retryResult.content || '' }],
                retryResult.translation || ''
            );
            const retryMessage = getSafeFriendRequestText(
                retryParts.map(part => part.text).join('\n'),
                char.incomingRequestMessage || request.message || `我是${char.name || 'Ta'}`
            );
            if (!retryMessage || retryParts.length === 0) {
                request.retryAt = null;
                continue;
            }
            const retryRequest = {
                id: `fr_${String(char.id)}_char_to_user_${now}_${Math.random().toString(36).slice(2, 7)}`,
                charId: char.id,
                direction: 'char_to_user',
                threadId: getFriendRequestThreadId(char, 'received'),
                status: 'pending',
                message: retryMessage,
                createdAt: Date.now(),
                resolvedAt: null,
                retryAt: null,
                retryCount: Number(request.retryCount || 0),
                source: 'retry'
            };
            request.retryAt = null;
            AppState.friendRequests.unshift(retryRequest);
            Object.assign(char, {
                relationStage: 'pending_char',
                hasChat: false,
                requiresFriendRequest: true,
                requiresOfflineMeet: false,
                pendingFriendRequestDirection: 'char_to_user',
                pendingFriendRequestMessage: retryMessage,
                pendingPreviousRelationStage: char.relationStage || 'library',
                pendingPreviousInContacts: char.inContacts === true
            });
            await db.characterProfiles.update(char.id, {
                relationStage: char.relationStage,
                hasChat: false,
                requiresFriendRequest: true,
                requiresOfflineMeet: false,
                pendingFriendRequestDirection: 'char_to_user',
                pendingFriendRequestMessage: retryMessage,
                pendingPreviousRelationStage: char.pendingPreviousRelationStage,
                pendingPreviousInContacts: char.pendingPreviousInContacts
            });
            await appendRetryRequestMessagesToThread(retryRequest.threadId, retryRequest, retryParts);
        }
        await saveFriendRequestRecords();
    };

    const getFriendRequestItems = (direction, statuses = ['pending']) => {
        pruneExpiredFriendRequestRecords();
        const requests = Array.isArray(AppState.friendRequests) ? AppState.friendRequests : [];
        return requests.filter(request => {
            const status = request.status || 'pending';
            return request.direction === direction && statuses.includes(status);
        });
    };

    const findCharacterByRequest = (request) => {
        return AppState.characterProfiles.find(char => String(char.id) === String(request.charId));
    };

    const getAppealRequestPreviewText = (request = {}) => {
        const isAppealRequest = request?.source === BLOCK_APPEAL_SOURCE || request?.source === BLOCK_APPEAL_USER_SOURCE;
        if (!isAppealRequest || !request.threadId) return '';
        const latestMessage = [...getFriendRequestThreadMessages(request.threadId)]
            .filter(message => message?.text && !isFriendRequestMetaReplyText(message.text) && !looksLikeFriendRequestJsonFragment(message.text))
            .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
            .at(-1);
        return getSafeFriendRequestText(latestMessage?.text || '', '');
    };

    const getAccountText = (char) => char.characterAccount || char.id || 'looky_000000';

    const hasOfflineRelationshipEvent = (char) => {
        return Array.isArray(char.relationshipEvents)
            && char.relationshipEvents.some(event => event?.type === 'offline_session');
    };

    const getNewFriendStatusText = (char) => {
        if (isCharacterFriend(char)) return '已是好友';
        if (char.relationStage === 'pending_user') return '等待 Ta 回应';
        if (char.relationStage === 'pending_char') return 'Ta 想加你';
        if (char.relationStage === 'offline_met') {
            return hasOfflineRelationshipEvent(char) ? '已线下认识' : '待认识';
        }
        if (char.inContacts !== false) return '已有联系方式';
        if (char.relationStartMode === 'stranger') return '待线下认识';
        return '仅存档';
    };

    const getFriendRequestStatusText = (status = 'pending') => {
        const statusMap = {
            pending: '待处理',
            accepted: '已同意',
            rejected: '已拒绝',
            withdrawn: '已撤回'
        };
        return statusMap[status] || '已处理';
    };

    const getStageAfterRequestClose = (char) => {
        return char.pendingPreviousRelationStage || 'library';
    };

    const getContactsAfterRequestClose = (char) => {
        return char.pendingPreviousInContacts === true;
    };

    const deleteFriendRequestRecord = async (char, threadId = '', directionFallback = 'char_to_user') => {
        if (!char) return false;
        if (!Array.isArray(AppState.friendRequests)) AppState.friendRequests = [];
        const normalizedThreadId = String(threadId || '');
        const existing = AppState.friendRequests.find(request => (
            (normalizedThreadId && String(request.threadId || '') === normalizedThreadId)
            || (
                String(request.charId) === String(char.id)
                && (request.direction || directionFallback) === directionFallback
                && (request.status || 'pending') === 'pending'
            )
        ));
        const requestThreadId = normalizedThreadId || existing?.threadId || getFriendRequestThreadId(char, directionFallback === 'user_to_char' ? 'sent' : 'received', existing);
        AppState.friendRequests = AppState.friendRequests.filter(request => {
            if (requestThreadId && String(request.threadId || '') === String(requestThreadId)) return false;
            return !(String(request.charId) === String(char.id)
                && (request.direction || directionFallback) === directionFallback
                && (request.status || 'pending') === 'pending');
        });
        if (AppState.friendRequestThreads && typeof AppState.friendRequestThreads === 'object' && requestThreadId) {
            delete AppState.friendRequestThreads[requestThreadId];
        }
        let restoredStage = getStageAfterRequestClose(char);
        if (char.relationStartMode === 'stranger' && restoredStage === 'library' && hasOfflineRelationshipEvent(char)) {
            restoredStage = 'offline_met';
        }
        const restoredInContacts = char.pendingPreviousInContacts === null || char.pendingPreviousInContacts === undefined
            ? char.inContacts === true
            : char.pendingPreviousInContacts === true;
        await saveFriendRequestRecords();
        await saveFriendRequestThreads();
        await updateNewFriendCharacter(char, {
            relationStage: restoredStage,
            inContacts: restoredInContacts,
            hasChat: false,
            requiresFriendRequest: char.relationStartMode === 'stranger',
            requiresOfflineMeet: false,
            pendingFriendRequestDirection: null,
            pendingFriendRequestMessage: '',
            pendingPreviousRelationStage: null,
            pendingPreviousInContacts: null
        }, '\u5df2\u5220\u9664\u597d\u53cb\u7533\u8bf7\u8bb0\u5f55');
        return true;
    };

    const createNewFriendItem = (char, mode = 'search', request = null) => {
        const item = document.createElement('article');
        item.className = 'nf-item';
        item.dataset.charId = char.id;
        if (mode === 'received' || mode === 'sent') item.dataset.requestMode = mode;
        if (request?.id) item.dataset.requestId = request.id;
        const avatar = isValidAvatarSrc(char.avatar) ? char.avatar : DEFAULT_AVATAR_SRC;
        const latestAppealMessage = getAppealRequestPreviewText(request);
        const requestMessage = getSafeFriendRequestText(
            latestAppealMessage || request?.message || '',
            char.pendingFriendRequestMessage || char.incomingRequestMessage || ''
        );
        const meta = requestMessage || '暂无验证消息';
        const actions = [];
        const requestStatus = request?.status || 'pending';
        const isRejectedBlockAppeal = request?.source === BLOCK_APPEAL_SOURCE
            && requestStatus === 'pending'
            && request.blockAppealRejected === true;
        const receivedDeleteButton = mode === 'received' && requestStatus === 'pending'
            ? `<button type="button" class="nf-item-delete-btn" data-action="dismiss-received" data-char-id="${escapeHTML(String(char.id))}" aria-label="\u5220\u9664\u8fd9\u6761\u7533\u8bf7">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path></svg>
            </button>`
            : '';

        if (mode === 'received') {
            if (requestStatus === 'pending') {
                if (isRejectedBlockAppeal) {
                    actions.push({ action: 'none', text: '已拒绝', disabled: true });
                } else {
                    actions.push({ action: 'accept', text: '接受', primary: true });
                    actions.push({ action: 'reject', text: '拒绝', danger: true });
                }
            } else {
                actions.push({ action: 'none', text: getFriendRequestStatusText(requestStatus), disabled: true });
            }
        } else if (mode === 'sent') {
            if (requestStatus === 'pending') {
                actions.push({ action: 'withdraw', text: '撤回', danger: true });
            } else {
                actions.push({ action: 'none', text: getFriendRequestStatusText(requestStatus), disabled: true });
            }
        } else if (mode === 'possible') {
            actions.push({ action: 'view', text: '查看资料' });
        } else {
            actions.push({ action: 'view', text: '查看资料' });
            if (isCharacterFriend(char)) {
                actions.push({ action: 'none', text: '已是好友', disabled: true });
            } else if (char.relationStage === 'pending_user') {
                actions.push({ action: 'none', text: '申请中', disabled: true });
            } else if (char.relationStage === 'pending_char') {
                actions.push({ action: 'none', text: '待处理', disabled: true });
            } else if (char.inContacts !== false) {
                actions.push({ action: 'none', text: '已在通讯录', disabled: true });
            } else {
                actions.push({ action: 'add-contact', text: '添加联系方式', primary: true });
            }
        }

        item.innerHTML = `
            <img class="nf-avatar" src="${avatar}" alt="avatar" loading="lazy" decoding="async">
            <div class="nf-main">
                <div class="nf-name-row">
                    <strong>${escapeHTML(char.name || '未命名角色')}</strong>
                    <span>${escapeHTML(mode === 'search' ? 'SEARCH' : mode.toUpperCase())}</span>
                    ${receivedDeleteButton}
                </div>
                <p class="nf-meta">${escapeHTML(meta)}</p>
                <div class="nf-actions">
                    ${actions.map(action => `
                        <button type="button"
                            class="${action.primary ? 'primary' : ''}${action.danger ? ' danger' : ''}"
                            data-action="${action.action}"
                            data-char-id="${escapeHTML(String(char.id))}"
                            ${action.disabled ? 'disabled' : ''}>${escapeHTML(action.text)}</button>
                    `).join('')}
                </div>
            </div>
        `;
        return item;
    };

    const renderNewFriendList = (container, items, emptyText, mode) => {
        if (!container) return;
        container.innerHTML = '';
        if (items.length === 0) {
            container.innerHTML = `<div class="nf-empty">${escapeHTML(emptyText)}</div>`;
            return;
        }
        const fragment = document.createDocumentFragment();
        items.forEach(item => {
            const char = item.char || item;
            if (char) fragment.appendChild(createNewFriendItem(char, mode, item.request));
        });
        container.appendChild(fragment);
    };

    const updateNewFriendEntryBadge = () => {
        const card = document.getElementById('add-new-friend-card');
        if (!card) return;
        let badge = card.querySelector('.nf-entry-red-dot');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'nf-entry-red-dot';
            badge.setAttribute('aria-hidden', 'true');
            badge.style.cssText = 'position:absolute;right:14px;top:50%;width:8px;height:8px;border-radius:50%;background:#ff3b30;box-shadow:0 0 0 2px #fff;transform:translateY(-50%);';
            card.appendChild(badge);
        }
        card.style.position = card.style.position || 'relative';
        const hasPendingIncoming = Array.isArray(AppState.friendRequests)
            && AppState.friendRequests.some(request => request.direction === 'char_to_user' && (request.status || 'pending') === 'pending');
        badge.hidden = !hasPendingIncoming;
    };

    const renderNewFriendSearchResults = () => {
        const input = document.getElementById('new-friend-search-input');
        const container = document.getElementById('new-friend-search-results');
        const section = document.getElementById('new-friend-search-section');
        if (!container) return;
        const keyword = String(input?.value || '').trim().toLowerCase();
        if (section) section.hidden = !keyword;
        if (!keyword) {
            container.innerHTML = '';
            return;
        }
        const results = AppState.characterProfiles
            .filter(char => !char.isGroup)
            .filter(char => {
                const name = String(char.name || '').toLowerCase();
                const realName = String(char.realName || '').toLowerCase();
                const account = String(getAccountText(char)).toLowerCase();
                return name.includes(keyword) || realName.includes(keyword) || account.includes(keyword);
        });
        renderNewFriendList(container, results, '没有找到匹配的角色。', 'search');
    };

    const isNewFriendsPageVisible = () => {
        const page = document.getElementById('page-new-friends');
        return page && window.getComputedStyle(page).display !== 'none';
    };
    let newFriendsRenderFrame = 0;
    let newFriendsSearchFrame = 0;

    const scheduleNewFriendsPageRender = () => {
        if (!isNewFriendsPageVisible()) return;
        if (newFriendsRenderFrame) cancelAnimationFrame(newFriendsRenderFrame);
        newFriendsRenderFrame = requestAnimationFrame(() => {
            newFriendsRenderFrame = 0;
            renderNewFriendsPage();
        });
    };

    const scheduleNewFriendSearchResults = () => {
        if (!isNewFriendsPageVisible()) return;
        if (newFriendsSearchFrame) cancelAnimationFrame(newFriendsSearchFrame);
        newFriendsSearchFrame = requestAnimationFrame(() => {
            newFriendsSearchFrame = 0;
            renderNewFriendSearchResults();
        });
    };

    const renderNewFriendsPage = async () => {
        await processDueFriendRequestRetries();
        renderNewFriendSearchResults();

        const visibleRequestStatuses = ['pending', 'accepted', 'rejected', 'withdrawn'];
        const receivedFromRequests = getFriendRequestItems('char_to_user', visibleRequestStatuses)
            .map(request => ({ request, char: findCharacterByRequest(request) }))
            .filter(item => item.char);
        const receivedFromStage = AppState.characterProfiles
            .filter(char => !char.isGroup && char.relationStage === 'pending_char')
            .map(char => ({ char, request: null }));
        const receivedIds = new Set();
        const received = [...receivedFromRequests, ...receivedFromStage].filter(item => {
            const id = String(item.char.id);
            if (receivedIds.has(id)) return false;
            receivedIds.add(id);
            return true;
        });

        const sentFromRequests = getFriendRequestItems('user_to_char', visibleRequestStatuses)
            .map(request => ({ request, char: findCharacterByRequest(request) }))
            .filter(item => item.char);
        const sentFromStage = AppState.characterProfiles
            .filter(char => !char.isGroup && char.relationStage === 'pending_user')
            .map(char => ({ char, request: null }));
        const sentIds = new Set();
        const sent = [...sentFromRequests, ...sentFromStage].filter(item => {
            const id = String(item.char.id);
            if (sentIds.has(id)) return false;
            sentIds.add(id);
            return true;
        });

        const possible = AppState.characterProfiles
            .filter(char => !char.isGroup && !isCharacterFriend(char))
            .filter(char => char.relationStage === 'offline_met' || (char.inContacts !== false && char.relationStage === 'library'));

        renderNewFriendList(document.getElementById('new-friend-received-list'), received, '还没有收到新的好友申请。', 'received');
        renderNewFriendList(document.getElementById('new-friend-sent-list'), sent, '还没有发出的好友申请。', 'sent');
        renderNewFriendList(document.getElementById('new-friend-possible-list'), possible, '还没有线下见过、但未成为好友的角色。', 'possible');
        updateNewFriendEntryBadge();
    };
    window.renderNewFriendsPage = scheduleNewFriendsPageRender;

    const updateNewFriendCharacter = async (char, updates, message) => {
        Object.assign(char, updates);
        await saveCharacterFieldsAndRender(char.id, updates, { refreshContacts: true, refreshFriends: true });
        scheduleNewFriendsPageRender();
        updateNewFriendEntryBadge();
        window.refreshCharacterLibraryPage?.();
        window.dispatchEvent(new CustomEvent('looky:friend-request-updated', { detail: { charId: char.id } }));
        showDynamicIsland(message);
    };

    const createFriendRequestInitialMessages = async (char, messages = []) => {
        if (!char?.id || !Array.isArray(messages) || messages.length === 0) return;
        const now = Date.now();
        const records = messages
            .filter(message => message?.text)
            .map((message, index) => ({
                chatId: char.id,
                type: 'received',
                text: message.text,
                translation: message.translation || '',
                friendRequestInitial: true,
                timestamp: new Date(now + index).toISOString(),
                aiVisible: true,
                uiVisible: true
            }));
        if (records.length > 0) {
            await db.chatMessages.bulkAdd(records);

            import('./notification.js')
                .then(module => {
                    records
                        .filter(message => message.text)
                        .forEach((message, index) => {
                            setTimeout(() => {
                                module.showChatMessageNotification?.(char, message.text, char.id);
                            }, index * 3500);
                        });
                })
                .catch(error => console.warn('[NewFriends] friend request notification failed:', error));
     }
    };

    finalizeFriendRequestAcceptance = async (char, direction, request, initialChatMessages) => {
        const acceptedRequest = await recordFriendRequestResult(char, 'accepted', direction);
        const finalRequest = acceptedRequest || request;
        await createFriendRequestChatCardMessage(char, finalRequest, 'accepted');
        await createFriendRequestInitialMessages(char, initialChatMessages);
        if (isBlockAppealRequest(finalRequest) && direction === 'char_to_user' && char.isBlocked) {
            await updateNewFriendCharacter(char, buildBlockAppealRestoreUpdates(char), `${char.name || 'Ta'} 已解除拉黑`);
            return;
        }
        if (isBlockedByAiAppealRequest(finalRequest) && direction === 'user_to_char' && char.isBlockedByAi) {
            await updateNewFriendCharacter(char, { isBlockedByAi: false, lastMainChatAiUnblockedAt: Date.now() }, `${char.name || 'Ta'} 已解除好友验证`);
            return;
        }
        await updateNewFriendCharacter(char, createFriendRelationshipUpdates(char, true), `${char.name || 'Ta'} 已同意好友申请`);
    };

    const runFriendRequestAiReply = async (modal, char, options = {}) => {
        const threadId = String(modal?.dataset.threadId || '');
        const card = modal?.querySelector('.nf-request-card');
        if (!modal || !char || !threadId || card?.dataset.threadId !== threadId) return;
        const activeRequest = Array.isArray(AppState.friendRequests)
            ? AppState.friendRequests.find(item => String(item.threadId) === threadId)
            : null;
        const isBlockAppealModal = isBlockAppealRequest(activeRequest);
        const isBlockedByAiAppealModal = isBlockedByAiAppealRequest(activeRequest);
        if (card?.classList.contains('is-terminal') || (isCharacterFriend(char) && !isBlockAppealModal && !isBlockedByAiAppealModal)) {
            setFriendRequestTerminalState(modal, true);
            showDynamicIsland(FRIEND_REQUEST_TERMINAL_NOTE);
            return;
        }
        if (friendRequestGenerationControllers[threadId]) {
            showDynamicIsland('这条验证消息正在生成中');
            return;
        }
        const direction = getFriendRequestDirectionFromMode(modal.dataset.mode);
        if (options.regenerate) {
            const removed = await removeLastFriendRequestAiBatch(threadId);
            if (!removed) {
                showDynamicIsland('还没有可重回的回复');
                return;
            }
            renderFriendRequestThreadMessages(
                document.getElementById('nf-request-thread'),
                getFriendRequestModalBaseMessage(modal, char),
                modal.dataset.mode,
                getFriendRequestThreadMessages(threadId),
                modal.dataset.baseTranslation || ''
            );
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
        const controller = new AbortController();
        friendRequestGenerationControllers[threadId] = controller;
        setFriendRequestGenerating(modal, true);
        const thread = document.getElementById('nf-request-thread');
        showFriendRequestTypingIndicator(thread);
        showDynamicIsland('正在生成验证回复...', 'loading');
        try {
            const messages = getFriendRequestThreadMessages(threadId);
            const latestUserMessage = [...messages].reverse().find(message => message.sender === 'user');
            const requestMessage = modal.dataset.mode === 'sent'
                ? (modal.dataset.baseMessage || char.pendingFriendRequestMessage || latestUserMessage?.text || '')
                : (latestUserMessage?.text || modal.dataset.baseMessage || char.pendingFriendRequestMessage || '');
            const isCurrentModalRequest = () => String(modal.dataset.charId || '') === String(char.id)
                && String(modal.dataset.threadId || '') === threadId;
            const result = await requestFriendRequestAiDecision(char, direction, requestMessage, messages, {
                signal: controller.signal,
                promptOptions: isBlockAppealModal && char.isBlocked
                    ? { friendRequestScenario: 'block_appeal' }
                    : (isBlockedByAiAppealModal && char.isBlockedByAi ? { friendRequestScenario: 'block_appeal_user' } : {})
            });
            const responseBatchId = `frbatch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const rawMessageParts = Array.isArray(result.messages) && result.messages.length > 0
                ? result.messages
                : (result.content ? splitFriendRequestReplyText(result.content) : []).map((text, index) => ({
                    text,
                    translation: index === 0 ? result.translation || '' : ''
                }));
            const messageParts = normalizeFriendRequestReplyParts(rawMessageParts, result.translation || '');
            if (messageParts.length === 0) {
                showDynamicIsland('AI 返回内容异常，已拦截，请重试');
                return;
            }
            const aiMessages = messageParts.map((part, index) => ({
                id: `frmsg_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
                sender: 'char',
                text: part.text,
                translation: part.translation || '',
                decision: result.decision,
                responseBatchId,
                createdAt: Date.now() + index,
                deletable: true
            }));
            for (let index = 0; index < aiMessages.length; index++) {
                const message = aiMessages[index];
                if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
                const activeThread = isCurrentModalRequest() ? document.getElementById('nf-request-thread') : null;
                if (activeThread) hideFriendRequestTypingIndicator(activeThread);
                AppState.friendRequestThreads[threadId] = [...getFriendRequestThreadMessages(threadId), message];
                await saveFriendRequestThreads();
                if (activeThread) {
                    renderFriendRequestThreadMessages(
                        activeThread,
                        getFriendRequestModalBaseMessage(modal, char),
                        modal.dataset.mode,
                        getFriendRequestThreadMessages(threadId),
                        modal.dataset.baseTranslation || '',
                        new Set([String(message.id)])
                    );
                }
                if (index < aiMessages.length - 1) {
                    const nextActiveThread = isCurrentModalRequest() ? document.getElementById('nf-request-thread') : null;
                    if (nextActiveThread) showFriendRequestTypingIndicator(nextActiveThread);
                    await waitFriendRequestTypingDelay(controller.signal, 650 + Math.random() * 450);
                }
            }
            if (result.decision === 'accept') {
                const request = Array.isArray(AppState.friendRequests)
                    ? AppState.friendRequests.find(item => String(item.threadId) === threadId)
                    : null;
                await finalizeFriendRequestAcceptance(char, direction, request, result.initialChatMessages);
                if (isCurrentModalRequest()) setFriendRequestTerminalState(modal, true);
            } else {
                if (result.decision === 'reject') {
                    const rejectedRequest = Array.isArray(AppState.friendRequests)
                        ? AppState.friendRequests.find(item => String(item.threadId) === threadId)
                        : null;
                    await applyRelationshipScoreEvent(char, 'friend_request_reject', {
                        requestId: rejectedRequest?.id,
                        source: 'friend_request_ai',
                        summary: '角色暂时拒绝了用户的好友申请'
                    });
                }
                if (isCurrentModalRequest()) {
                    showDynamicIsland(result.decision === 'reject' ? 'Ta 暂时没有同意' : '验证回复已生成');
                }
            }
        } catch (error) {
            const isCurrentRequest = String(modal.dataset.charId || '') === String(char.id) && String(modal.dataset.threadId || '') === threadId;
            if (isCurrentRequest) {
                hideFriendRequestTypingIndicator(thread);
            }
            if (error?.name === 'AbortError') {
                if (isCurrentRequest) showDynamicIsland('已停止生成');
            } else {
                console.error('[NewFriends] friend request AI failed:', error);
                if (isCurrentRequest) showDynamicIsland(error?.message || '验证回复生成失败');
            }
        } finally {
            if (friendRequestGenerationControllers[threadId] === controller) {
                delete friendRequestGenerationControllers[threadId];
            }
            if (String(modal.dataset.charId || '') === String(char.id) && String(modal.dataset.threadId || '') === threadId) {
                hideFriendRequestTypingIndicator(thread);
                setFriendRequestGenerating(modal, false);
            }
        }
    };

    const closeNewFriendRequestModal = () => {
        const modal = document.getElementById('new-friend-request-modal');
        setFriendRequestDeleteMode(modal, false);
        setFriendRequestGenerating(modal, false);
        setFriendRequestTerminalState(modal, false);
        modal?.querySelectorAll('.nf-request-bubble.is-selected').forEach(item => item.classList.remove('is-selected'));
        modal?.classList.remove('visible');
    };

    const setFriendRequestDeleteMode = (modal, enabled) => {
        const card = modal?.querySelector('.nf-request-card');
        const selectActions = modal?.querySelector('.nf-request-select-actions');
        if (!card || !selectActions) return;
        if (!enabled) {
            selectedFriendRequestMessageIds.clear();
            modal?.querySelectorAll('.nf-request-bubble.is-selected').forEach(item => item.classList.remove('is-selected'));
        }
        card.classList.toggle('is-delete-selecting', enabled);
        selectActions.setAttribute('aria-hidden', enabled ? 'false' : 'true');
        if (enabled) {
            selectActions.removeAttribute('inert');
            return;
        }
        if (selectActions.contains(document.activeElement)) {
            document.activeElement?.blur();
        }
        selectActions.setAttribute('inert', '');
    };

    const toggleFriendRequestMessageSelection = (messageRow) => {
        const messageId = String(messageRow?.dataset.messageId || '');
        if (!messageId) return 0;
        const bubble = messageRow.querySelector('.nf-request-bubble');
        if (selectedFriendRequestMessageIds.has(messageId)) {
            selectedFriendRequestMessageIds.delete(messageId);
            bubble?.classList.remove('is-selected');
        } else {
            selectedFriendRequestMessageIds.add(messageId);
            bubble?.classList.add('is-selected');
        }
        return selectedFriendRequestMessageIds.size;
    };

    const setFriendRequestGenerating = (modal, isGenerating) => {
        const card = modal?.querySelector('.nf-request-card');
        const sendBtn = document.getElementById('nf-request-send-btn');
        const isTerminal = card?.classList.contains('is-terminal');
        card?.classList.toggle('is-generating', isGenerating && !isTerminal);
        if (sendBtn) {
            sendBtn.classList.toggle('is-generating', isGenerating && !isTerminal);
            if (isTerminal) return;
            sendBtn.setAttribute('aria-label', isGenerating ? '停止生成' : '发送');
            sendBtn.title = isGenerating ? '停止生成' : '发送';
        }
    };

    const setFriendRequestTerminalState = (modal, isTerminal) => {
        const card = modal?.querySelector('.nf-request-card');
        const input = document.getElementById('nf-request-reply-input');
        const sendBtn = document.getElementById('nf-request-send-btn');
        const retryBtn = document.getElementById('nf-request-retry-btn');
        if (!card) return;
        card.classList.toggle('is-terminal', isTerminal);
        card.dataset.friendRequestTerminal = isTerminal ? 'true' : 'false';

        if (input) {
            if (!input.dataset.defaultPlaceholder) {
                input.dataset.defaultPlaceholder = input.getAttribute('placeholder') || '';
            }
            input.disabled = isTerminal;
            input.readOnly = isTerminal;
            input.placeholder = isTerminal
                ? FRIEND_REQUEST_TERMINAL_NOTE
                : (input.dataset.defaultPlaceholder || '发送验证消息');
        }

        [sendBtn, retryBtn].forEach(btn => {
            if (!btn) return;
            if (!btn.dataset.defaultTitle) btn.dataset.defaultTitle = btn.getAttribute('title') || '';
            if (!btn.dataset.defaultAriaLabel) btn.dataset.defaultAriaLabel = btn.getAttribute('aria-label') || '';
            btn.disabled = isTerminal;
            btn.setAttribute('aria-disabled', String(isTerminal));
            if (isTerminal) {
                btn.title = FRIEND_REQUEST_TERMINAL_NOTE;
                btn.setAttribute('aria-label', FRIEND_REQUEST_TERMINAL_NOTE);
            } else {
                btn.title = btn.dataset.defaultTitle || '';
                btn.setAttribute('aria-label', btn.dataset.defaultAriaLabel || btn.dataset.defaultTitle || '');
            }
        });
    };

    const appendFriendRequestUserMessage = async (modal, char, threadId) => {
        const input = document.getElementById('nf-request-reply-input');
        const thread = document.getElementById('nf-request-thread');
        if (modal?.querySelector('.nf-request-card')?.classList.contains('is-terminal')) {
            showDynamicIsland(FRIEND_REQUEST_TERMINAL_NOTE);
            return null;
        }
        const text = String(input?.value || '').trim();
        if (!text) return null;
        const nextMessage = {
            id: `frmsg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            sender: 'user',
            text,
            translation: '',
            createdAt: Date.now(),
            deletable: true
        };
        if (!AppState.friendRequestThreads || typeof AppState.friendRequestThreads !== 'object') {
            AppState.friendRequestThreads = {};
        }
        AppState.friendRequestThreads[threadId] = [...getFriendRequestThreadMessages(threadId), nextMessage];
        await saveFriendRequestThreads();
        renderFriendRequestThreadMessages(
            thread,
            getFriendRequestModalBaseMessage(modal, char),
            modal.dataset.mode,
            getFriendRequestThreadMessages(threadId),
            modal.dataset.baseTranslation || '',
            new Set([String(nextMessage.id)])
        );
        if (input) input.value = '';
        return nextMessage;
    };

    const removeLastFriendRequestAiBatch = async (threadId) => {
        const messages = getFriendRequestThreadMessages(threadId);
        const lastAiIndex = [...messages].map((message, index) => ({ message, index })).reverse()
            .find(item => item.message.sender === 'char')?.index;
        if (lastAiIndex === undefined) return false;
        const batchId = messages[lastAiIndex]?.responseBatchId;
        if (batchId) {
            AppState.friendRequestThreads[threadId] = messages.filter(message => message.responseBatchId !== batchId);
        } else {
            let startIndex = lastAiIndex;
            while (startIndex > 0 && messages[startIndex - 1]?.sender === 'char') startIndex--;
            let endIndex = lastAiIndex;
            while (endIndex + 1 < messages.length && messages[endIndex + 1]?.sender === 'char') endIndex++;
            AppState.friendRequestThreads[threadId] = messages.filter((message, index) => index < startIndex || index > endIndex);
        }
        await saveFriendRequestThreads();
        return true;
    };

    const openNewFriendRequestModal = async (char, mode = 'received', request = null) => {
        const modal = document.getElementById('new-friend-request-modal');
        if (!modal || !char) return;
        modal.dataset.charId = char.id;
        modal.dataset.mode = mode;
        const threadId = getFriendRequestThreadId(char, mode, request);
        modal.dataset.threadId = threadId;
        const isTerminal = request?.status === 'accepted'
            || (isCharacterFriend(char) && !isBlockAppealRequest(request) && !isBlockedByAiAppealRequest(request));
        const card = modal.querySelector('.nf-request-card');
        if (card) {
            card.dataset.charId = String(char.id);
            setFriendRequestDeleteMode(modal, false);
            setFriendRequestTerminalState(modal, false);
            setFriendRequestGenerating(modal, Boolean(friendRequestGenerationControllers[threadId]));
            card.dataset.threadId = threadId;
        }
        const avatar = document.getElementById('nf-request-avatar');
        const name = document.getElementById('nf-request-name');
        const status = document.getElementById('nf-request-status');
        const thread = document.getElementById('nf-request-thread');
        const input = document.getElementById('nf-request-reply-input');

        if (avatar) avatar.src = isValidAvatarSrc(char.avatar) ? char.avatar : DEFAULT_AVATAR_SRC;
        if (name) name.textContent = char.name || '未命名角色';
        if (status) {
            const statusText = request?.status && request.status !== 'pending'
                ? getFriendRequestStatusText(request.status)
                : (mode === 'sent' ? '发出的申请' : '收到的申请');
            status.textContent = isTerminal ? '已成为好友' : statusText;
        }
        const message = getSafeFriendRequestText(
            request?.message || '',
            char.pendingFriendRequestMessage || char.incomingRequestMessage || '暂时没有验证消息。'
        ) || '暂时没有验证消息。';
        const baseTranslation = request?.translation || char.pendingFriendRequestTranslation || '';
        const shouldInlineRequestMessage = request?.source === 'retry' || request?.source === BLOCK_APPEAL_SOURCE;
        if (shouldInlineRequestMessage) await ensureRetryRequestMessageInThread(threadId, request);
        if (request?.source === BLOCK_APPEAL_SOURCE) {
            const currentThreadMessages = getFriendRequestThreadMessages(threadId);
            const changed = currentThreadMessages.reduce((updated, message) => {
                if (message.requestBubble && message.deletable === false) {
                    message.deletable = true;
                    return true;
                }
                return updated;
            }, false);
            if (changed) await saveFriendRequestThreads();
        }
        modal.dataset.baseMessage = shouldInlineRequestMessage ? '' : message;
        modal.dataset.baseTranslation = shouldInlineRequestMessage ? '' : baseTranslation;
        renderFriendRequestThreadMessages(thread, modal.dataset.baseMessage, mode, getFriendRequestThreadMessages(threadId), modal.dataset.baseTranslation);
        if (input) input.value = '';
        setFriendRequestTerminalState(modal, isTerminal);
        modal.classList.add('visible');
    };
    window.openNewFriendRequestModal = openNewFriendRequestModal;

    const showFriendActionPopover = (targetItem) => {
        hideFriendActionPopover();
        isFriendSelectionMode = true;
        const charId = targetItem.dataset.charId;
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (!char) return;
        const popover = document.createElement('div');
        popover.className = 'action-popover';
        activePopover = popover;
        const isPinned = char.isPinned;
        const pinButtonText = isPinned ? '取消置顶' : '置顶';
        const pinButtonIcon = `<svg viewBox="0 0 24 24" fill="${isPinned ? 'var(--c-text-primary)' : 'none'}"><path d="M16 3a1 1 0 0 1 1 1v5.268l2.919 2.919a1 1 0 0 1 .274.693l-.333 3.993a1 1 0 0 1-.973.927H8.113a1 1 0 0 1-.973-.927l-.333-3.993a1 1 0 0 1 .274-.693L9 9.268V4a1 1 0 0 1 1-1h6z"></path></svg>`;
        popover.innerHTML = `
            <div class="popover-button" id="popover-pin-btn">${pinButtonIcon}<span>${pinButtonText}</span></div>
            <div class="popover-divider"></div>
            <div class="popover-button delete" id="popover-delete-btn"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg><span>删除</span></div>`;
        UI.phoneScreen.appendChild(popover);
        const itemRect = targetItem.getBoundingClientRect(), popoverRect = popover.getBoundingClientRect(), phoneRect = UI.phoneScreen.getBoundingClientRect();
        let left = itemRect.left - phoneRect.left + (itemRect.width / 2) - (popoverRect.width / 2), top = itemRect.top - phoneRect.top - popoverRect.height - 10;
        if (left < 10) left = 10;
        if (left + popoverRect.width > phoneRect.width - 10) left = phoneRect.width - 10 - popoverRect.width;
        if (top < 10) top = itemRect.bottom - phoneRect.top + 10;
        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
        setTimeout(() => popover.classList.add('visible'), 10);
        popover.querySelector('#popover-pin-btn').addEventListener('click', () => { 
            hideFriendActionPopover(); // 1. 先触发菜单消失动画
            char.isPinned = !char.isPinned; // 2. 更改置顶状态
                    setTimeout(() => { saveCharacterFieldsAndRender(char.id, { isPinned: char.isPinned }); }, 250); // 3. 延迟250毫秒，等菜单动画平滑结束后，再重新渲染列表
        });
        popover.querySelector('#popover-delete-btn').addEventListener('click', () => {
            hideFriendActionPopover();

            setTimeout(async () => {
                if (confirm(`确定要将 "${char.name}" 移出好友列表吗？(这不会删除角色本身)`)) {
                    const relationshipUpdates = createFriendRelationshipUpdates(char, false);
                    Object.assign(char, relationshipUpdates, { isPinned: false, inContacts: true });
                    await saveCharacterFieldsAndRender(char.id, { ...relationshipUpdates, isPinned: false, inContacts: true }, { refreshContacts: false, refreshFriends: false });
                    refreshChatHomeFriendListWhenVisible();
                    renderAddFriendModalList();
                    showDynamicIsland('好友已移除');
                }
            }, 100);
        });
    };

    const resetAndHideCharModal = () => {
        tempState.editingCharId = null;
        tempNpcList = [];
        UI.addCharModalOverlay.classList.remove('visible');
        UI.charModalAvatarPreview.src = '';
        UI.charModalAvatarPlaceholder.style.display = 'block';
        UI.charModalName.value = '';
        UI.charModalTag.value = '在线';
        UI.charModalPersona.value = '';
         document.getElementById('char-modal-voice-id').value = '';
    document.getElementById('char-modal-speed').value = '1.0';
    document.getElementById('char-modal-speed-val').textContent = '1.0';
    document.getElementById('char-modal-lang').value = 'auto';
        // 修改了类名，这里要同步修改
const details = document.querySelector('#add-char-modal-overlay .line-details');
if (details) details.open = false;

    };

    const populateCharModalForEdit = (charId) => {
       const char = AppState.characterProfiles.find(c => c.id == charId);
        if (!char) return;
        tempState.editingCharId = char.id; 
        UI.charModalName.value = char.name;
        UI.charModalTag.value = char.tag;
        UI.charModalPersona.value = char.persona;
  const ttsData = char.tts || {};
    document.getElementById('char-modal-voice-id').value = ttsData.voiceId || '';
    document.getElementById('char-modal-lang').value = ttsData.language || 'auto'; // ◀◀◀ [新增] 回显语言，默认'auto'
    const speed = ttsData.speed || 1.0;
    document.getElementById('char-modal-speed').value = speed;
    document.getElementById('char-modal-speed-val').textContent = speed;
        tempNpcList = char.relatedNpcs ? [...char.relatedNpcs] : []; 
        if (isValidAvatarSrc(char.avatar)) { UI.charModalAvatarPreview.src = char.avatar; UI.charModalAvatarPlaceholder.style.display = 'none'; } else { UI.charModalAvatarPreview.src = ''; UI.charModalAvatarPlaceholder.style.display = 'block'; }
        // 修改了类名，这里要同步修改
const details = document.querySelector('#add-char-modal-overlay .line-details');
if (details) details.open = !!char.persona;

        UI.addCharModalOverlay.classList.add('visible');
    };

    // 事件绑定
    const setChatHomeSection = (contentId = 'friends-content') => {
        exitSelectionMode();
        hideFriendActionPopover();
        const isContacts = contentId === 'contacts-content';
        tempState.currentChatHomeSection = contentId;
        document.body.classList.toggle('chat-home-contacts-active', isContacts);
        UI.chatTabs.querySelectorAll('.tab-item').forEach(tab => tab.classList.remove('active'));
        UI.chatTabs.querySelector(`.tab-item[data-content="${contentId}"]`)?.classList.add('active');
        UI.friendsContent.style.display = isContacts ? 'none' : 'block';
        UI.contactsContent.style.display = isContacts ? 'block' : 'none';
        UI.contactsMoreBtn.style.display = isContacts ? 'block' : 'none';
        UI.addFriendBtn.style.display = isContacts ? 'none' : 'block';
        UI.contactsMenu.style.display = 'none';
        if (isContacts && contactListNeedsRender) renderCharacterContactsList();
        if (!isContacts && chatFriendListNeedsRender) renderChatFriendsList();
        document.querySelectorAll('.chat-bottom-nav .nav-item').forEach(item => {
            const isChatItem = item.dataset.page === 'page-chat';
            item.classList.toggle('active', isChatItem && item.dataset.chatSection === contentId);
        });
    };
    window.setChatHomeSection = setChatHomeSection;

    UI.chatTabs.addEventListener('click', (e) => {
        const targetTab = e.target.closest('.tab-item');
        if (!targetTab) return;
        setChatHomeSection(targetTab.dataset.content);
    });

    UI.addFriendBtn.addEventListener('click', () => {
        renderAddFriendModalList();
        document.getElementById('add-friend-from-contacts-modal').classList.add('visible');
    });

    window.addEventListener('looky:page-opened', (event) => {
        if (event.detail?.pageId === 'page-new-friends') {
            renderNewFriendsPage();
        }
    });
    window.addEventListener('looky:friend-request-updated', updateNewFriendEntryBadge);

    document.getElementById('new-friend-search-input')?.addEventListener('input', scheduleNewFriendSearchResults);

    document.getElementById('page-new-friends')?.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-action][data-char-id]');
        if (!button) {
            const requestItem = event.target.closest('.nf-item[data-request-mode]');
            if (!requestItem) return;
            const requestChar = AppState.characterProfiles.find(item => String(item.id) === String(requestItem.dataset.charId));
            const requestRecord = Array.isArray(AppState.friendRequests)
                ? AppState.friendRequests.find(item => String(item.id) === String(requestItem.dataset.requestId))
                : null;
            if (requestChar) openNewFriendRequestModal(requestChar, requestItem.dataset.requestMode, requestRecord);
            return;
        }
        if (button.disabled) return;
        const char = AppState.characterProfiles.find(item => String(item.id) === String(button.dataset.charId));
        if (!char) return;

        switch (button.dataset.action) {
            case 'view': {
                const { renderCharacterDetailPage } = await import('./character-library.js');
                if (renderCharacterDetailPage(char.id)) showPage('page-character-detail');
                break;
            }
            case 'request':
            case 'resend':
                await updateNewFriendCharacter(char, {
                    inContacts: true,
                    relationStage: 'pending_user',
                    hasChat: false,
                    requiresFriendRequest: true,
                    requiresOfflineMeet: false
                }, '好友申请已发出');
                break;
            case 'invite-me':
                await updateNewFriendCharacter(char, {
                    inContacts: true,
                    relationStage: 'pending_char',
                    hasChat: false,
                    requiresFriendRequest: true,
                    requiresOfflineMeet: false
                }, 'Ta 的好友申请已进入新朋友');
                break;
            case 'add-contact':
                await updateNewFriendCharacter(char, {
                    inContacts: true,
                    relationStage: char.relationStage === 'offline_met' ? 'offline_met' : 'library',
                    hasChat: false,
                    requiresFriendRequest: true,
                    requiresOfflineMeet: false
                }, '已添加到通讯录');
                break;
            case 'withdraw':
                await recordFriendRequestResult(char, 'withdrawn', 'user_to_char');
                await updateNewFriendCharacter(char, {
                    relationStage: getStageAfterRequestClose(char),
                    inContacts: getContactsAfterRequestClose(char),
                    hasChat: false,
                    requiresFriendRequest: char.relationStartMode === 'stranger',
                    requiresOfflineMeet: false,
                    pendingFriendRequestDirection: null,
                    pendingFriendRequestMessage: '',
                    pendingPreviousRelationStage: null,
                    pendingPreviousInContacts: null
                }, '好友申请已撤回');
                break;
            case 'dismiss-received':
                {
                    const blockAppealRequest = getPendingBlockAppealRequest(char);
                    if (blockAppealRequest) {
                        await markBlockAppealRejected(char, blockAppealRequest);
                        scheduleNewFriendsPageRender();
                        showDynamicIsland('已暂时拒绝请求');
                        break;
                    }
                }
                await deleteFriendRequestRecord(char, '', 'char_to_user');
                break;
            case 'accept': {
                const blockAppealRequest = getPendingBlockAppealRequest(char);
                if (blockAppealRequest && char.isBlocked) {
                    await finalizeFriendRequestAcceptance(char, 'char_to_user', blockAppealRequest, []);
                    break;
                }
                const acceptedRequest = await recordFriendRequestResult(char, 'accepted', 'char_to_user');
                await createFriendRequestChatCardMessage(char, acceptedRequest, 'accepted');
                const updates = createFriendRelationshipUpdates(char, true);
                await updateNewFriendCharacter(char, updates, `已添加 ${char.name || '角色'} 为好友`);
                break;
            }
            case 'reject':
                {
                    const blockAppealRequest = getPendingBlockAppealRequest(char);
                    if (blockAppealRequest) {
                        await markBlockAppealRejected(char, blockAppealRequest);
                        scheduleNewFriendsPageRender();
                        showDynamicIsland('已暂时拒绝请求');
                        break;
                    }
                }
                const rejectedRequest = await recordFriendRequestResult(char, 'rejected', 'char_to_user');
                await updateNewFriendCharacter(char, {
                    relationStage: getStageAfterRequestClose(char),
                    inContacts: getContactsAfterRequestClose(char),
                    hasChat: false,
                    requiresFriendRequest: char.relationStartMode === 'stranger',
                    requiresOfflineMeet: false,
                    pendingFriendRequestDirection: null,
                    pendingFriendRequestMessage: '',
                    pendingPreviousRelationStage: null,
                    pendingPreviousInContacts: null
                }, '已拒绝好友申请');
                if (rejectedRequest?.retryAt) {
                    setTimeout(() => {
                        processDueFriendRequestRetries()
                            .then(scheduleNewFriendsPageRender)
                            .catch(error => console.warn('[NewFriends] retry request failed:', error));
                    }, Math.max(0, Number(rejectedRequest.retryAt) - Date.now()));
                }
                break;
            case 'add-friend': {
                const updates = createFriendRelationshipUpdates(char, true);
                await updateNewFriendCharacter(char, updates, `已重新添加 ${char.name || '角色'} 为好友`);
                break;
            }
            default:
                break;
        }
    });

    document.getElementById('new-friend-request-modal')?.addEventListener('click', async (event) => {
        const modal = event.currentTarget;
        const actionButton = event.target.closest('button');
        if (event.target === modal) {
            closeNewFriendRequestModal();
            return;
        }

        const card = modal.querySelector('.nf-request-card');
        const modalCharId = String(modal.dataset.charId || '');
        const cardCharId = String(card?.dataset.charId || '');
        const threadId = String(modal.dataset.threadId || '');
        const cardThreadId = String(card?.dataset.threadId || '');
        if (!modalCharId || modalCharId !== cardCharId || !threadId || threadId !== cardThreadId) {
            closeNewFriendRequestModal();
            showDynamicIsland('申请窗口已失效，请重新打开');
            return;
        }
        const char = AppState.characterProfiles.find(item => String(item.id) === modalCharId);
        if (!char) return;
        if (card.classList.contains('is-terminal') && (actionButton?.id === 'nf-request-send-btn' || actionButton?.id === 'nf-request-retry-btn')) {
            showDynamicIsland(FRIEND_REQUEST_TERMINAL_NOTE);
            return;
        }
        if (actionButton?.classList.contains('nf-request-translate-btn')) {
            const translation = actionButton.nextElementSibling;
            translation?.classList.toggle('collapsed');
            actionButton.classList.toggle('active');
            return;
        }
        if (actionButton?.id === 'nf-request-retry-btn') {
            await runFriendRequestAiReply(modal, char, { regenerate: true });
            return;
        }
        if (actionButton?.id === 'nf-request-delete-btn') {
            const deletableRows = [...modal.querySelectorAll('.nf-request-message-row[data-deletable-message="true"]')];
            if (deletableRows.length === 0) {
                const activeRequest = Array.isArray(AppState.friendRequests)
                    ? AppState.friendRequests.find(item => String(item.threadId) === threadId)
                    : null;
                if (isBlockAppealRequest(activeRequest)) {
                    showDynamicIsland('没有可删除的验证消息');
                    return;
                }
                if (confirm('\u786e\u5b9a\u5220\u9664\u8fd9\u6761\u597d\u53cb\u7533\u8bf7\u8bb0\u5f55\u5417\uff1f')) {
                    await deleteFriendRequestRecord(char, threadId, getFriendRequestDirectionFromMode(modal.dataset.mode));
                    closeNewFriendRequestModal();
                }
                return;
            }
            setFriendRequestDeleteMode(modal, true);
            showDynamicIsland('请选择要删除的消息');
            return;
        }
        if (actionButton?.id === 'nf-request-cancel-select-btn') {
            setFriendRequestDeleteMode(modal, false);
            modal.querySelectorAll('.nf-request-bubble.is-selected').forEach(item => item.classList.remove('is-selected'));
            showDynamicIsland('已取消删除选择');
            return;
        }
        if (actionButton?.id === 'nf-request-confirm-delete-btn') {
            if (selectedFriendRequestMessageIds.size === 0) {
                showDynamicIsland('请先选择要删除的消息');
                return;
            }
            const selectedIds = new Set(selectedFriendRequestMessageIds);
            const currentMessages = getFriendRequestThreadMessages(threadId);
            AppState.friendRequestThreads[threadId] = currentMessages.filter(message => !selectedIds.has(String(message.id)));
            await saveFriendRequestThreads();
            renderFriendRequestThreadMessages(
                document.getElementById('nf-request-thread'),
                getFriendRequestModalBaseMessage(modal, char),
                modal.dataset.mode,
                getFriendRequestThreadMessages(threadId),
                modal.dataset.baseTranslation || ''
            );
            setFriendRequestDeleteMode(modal, false);
            showDynamicIsland(`已删除 ${selectedIds.size} 条消息`);
            return;
        }
        const selectableRow = event.target.closest('.nf-request-message-row[data-deletable-message="true"]');
        if (selectableRow && card.classList.contains('is-delete-selecting')) {
            const count = toggleFriendRequestMessageSelection(selectableRow);
            showDynamicIsland(count > 0 ? `已选择 ${count} 条消息` : '请选择要删除的消息');
            return;
        }
        if (actionButton?.id === 'nf-request-send-btn') {
            const controller = friendRequestGenerationControllers[threadId];
            if (controller) {
                controller.abort();
                return;
            }
            const currentMessages = getFriendRequestThreadMessages(threadId);
            const inputText = String(document.getElementById('nf-request-reply-input')?.value || '').trim();
            if (inputText) await appendFriendRequestUserMessage(modal, char, threadId);
            const nextMessages = getFriendRequestThreadMessages(threadId);
            const hasUserMessage = nextMessages.some(message => message.sender === 'user');
            if (!inputText && !hasUserMessage && modal.dataset.mode !== 'sent') {
                showDynamicIsland('请先输入验证消息');
                return;
            }
            if (currentMessages.length !== nextMessages.length && inputText) {
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
            await runFriendRequestAiReply(modal, char);
            return;
        }
    });

    document.getElementById('new-friend-request-modal')?.addEventListener('keydown', async (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        const input = event.target.closest('#nf-request-reply-input');
        if (!input) return;
        event.preventDefault();
        const modal = event.currentTarget;
        const threadId = String(modal.dataset.threadId || '');
        const char = AppState.characterProfiles.find(item => String(item.id) === String(modal.dataset.charId || ''));
        if (!char || !threadId) return;
        if (modal.querySelector('.nf-request-card')?.classList.contains('is-terminal')) {
            showDynamicIsland(FRIEND_REQUEST_TERMINAL_NOTE);
            return;
        }
        await appendFriendRequestUserMessage(modal, char, threadId);
    });

    document.getElementById('add-friend-from-contacts-modal').addEventListener('click', (e) => { 
        if (e.target.id === 'add-friend-from-contacts-modal') {
            addFriendRenderToken++;
            e.currentTarget.classList.remove('visible');
        }
    });

    document.getElementById('add-friend-list-container').addEventListener('click', async (e) => {
        const targetItem = e.target.closest('.add-friend-item');
        if (!targetItem) return;
        const charId = targetItem.dataset.charId;
        const char = AppState.characterProfiles.find(c => String(c.id) === String(charId));
        if (char) {
            const relationshipUpdates = createFriendRelationshipUpdates(char, true);
            Object.assign(char, relationshipUpdates);
            await saveCharacterFieldsAndRender(char.id, relationshipUpdates, { refreshContacts: false, refreshFriends: false });
            refreshChatHomeFriendListWhenVisible();
            addFriendRenderToken++;
            document.getElementById('add-friend-from-contacts-modal').classList.remove('visible');
            showDynamicIsland(`已添加 ${char.name} 为好友`);
        }
    });
    let fStartX = 0, fStartY = 0;
    UI.friendsContent.addEventListener('pointerdown', (e) => {
        const targetItem = e.target.closest('.conversation-item'); if (!targetItem) return;
        clearTimeout(friendLongPressTimer);
        fStartX = e.clientX; fStartY = e.clientY; // 记录按下瞬间的坐标
        friendLongPressTimer = setTimeout(() => { 
            e.preventDefault(); // 【新增】阻止默认行为，防止菜单弹出时页面抖动
            showFriendActionPopover(targetItem); 
            friendLongPressTimer = null; 
        }, 500); // 【优化】时间改回500ms，手感更灵敏
    }, { passive: true });

    UI.friendsContent.addEventListener('pointermove', (e) => {
        // 如果手指滑动距离超过10个像素，说明是在滑动列表，立刻取消长按判定
        if (friendLongPressTimer && (Math.abs(e.clientX - fStartX) > 10 || Math.abs(e.clientY - fStartY) > 10)) clearTimeout(friendLongPressTimer);
    }, { passive: true });
    UI.friendsContent.addEventListener('pointerup', () => clearTimeout(friendLongPressTimer), { passive: true });
    UI.friendsContent.addEventListener('pointerleave', () => clearTimeout(friendLongPressTimer), { passive: true });
    UI.friendsContent.addEventListener('pointercancel', () => clearTimeout(friendLongPressTimer), { passive: true });

    UI.friendsContent.addEventListener('click', (e) => {
        if (friendLongPressTimer === null) { e.preventDefault(); e.stopPropagation(); friendLongPressTimer = undefined; return; }
        clearTimeout(friendLongPressTimer);
        if (isFriendSelectionMode) { return; }
        const targetItem = e.target.closest('.conversation-item');
        if (targetItem) {
            onFriendClick(targetItem.dataset.charId);
        }
    });
    // 1. 打开 NPC 管理弹窗
    UI.charNpcManageBtn.addEventListener('click', () => {
        editingNpcIndex = -1; // 【新增】重置编辑状态
        renderNpcList();
        // ... (其他清空输入框的代码保持不变)
        UI.npcNameInput.value = '';
        UI.npcRelationInput.value = '';
        UI.npcPersonaInput.value = '';
        document.getElementById('npc-avatar-preview').src = 'images/default-avatar.svg';
        document.getElementById('npc-probability-input').value = 70;
        document.getElementById('npc-prob-display').textContent = '70%';
        UI.npcModalOverlay.classList.add('visible');
    });

    // 1.5 处理 NPC 头像上传预览
    const npcFileInput = document.getElementById('npc-avatar-file');
    const npcAvatarPreview = document.getElementById('npc-avatar-preview');
    if (npcFileInput) {
        npcFileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                try {
                    const base64 = await fileToBase64(file);
                    npcAvatarPreview.src = base64;
                } catch (err) {
                    console.error('NPC头像读取失败', err);
                }
            }
        });
    }

    // 1.6 处理 NPC 概率滑块显示
    const npcProbSlider = document.getElementById('npc-probability-input');
    const npcProbDisplay = document.getElementById('npc-prob-display');
    if (npcProbSlider) {
        npcProbSlider.addEventListener('input', (e) => {
            npcProbDisplay.textContent = `${e.target.value}%`;
        });
    }

    // 2. 添加/保存 NPC
    UI.npcAddBtn.addEventListener('click', () => {
        const name = UI.npcNameInput.value.trim();
        const relation = UI.npcRelationInput.value.trim();
        const persona = UI.npcPersonaInput.value.trim();
        const avatar = document.getElementById('npc-avatar-preview').src;
        const probability = parseInt(document.getElementById('npc-probability-input').value, 10);

        if (!name) {
            showDynamicIsland('请输入NPC名字');
            return;
        }

        const npcData = { 
            name, 
            relation: relation || '关联人物', 
            persona: persona || '',
            avatar: avatar,
            probability: probability
        };
        
        if (editingNpcIndex > -1) {
            // 【修改模式】更新现有数据
            tempNpcList[editingNpcIndex] = npcData;
            showDynamicIsland('NPC信息已更新');
            editingNpcIndex = -1; // 退出编辑模式
        } else {
            // 【添加模式】推入新数据
            tempNpcList.push(npcData);
        }

        // 清空输入框，恢复默认状态
        UI.npcNameInput.value = '';
        UI.npcRelationInput.value = '';
        UI.npcPersonaInput.value = '';
        document.getElementById('npc-avatar-preview').src = 'images/default-avatar.svg';
        document.getElementById('npc-probability-input').value = 70;
        document.getElementById('npc-prob-display').textContent = '70%';
        
        UI.npcNameInput.focus();
        
        // 重新渲染列表
        renderNpcList();
    });

    // 3. 删除 NPC
    UI.npcListContainer.addEventListener('click', (e) => {
        if (e.target.classList.contains('npc-delete-btn')) {
            // 防止删除按钮触发编辑事件
            e.stopPropagation(); 
            const index = parseInt(e.target.dataset.index, 10);
            
            // 如果删除的是当前正在编辑的，退出编辑模式
            if (index === editingNpcIndex) {
                editingNpcIndex = -1;
                // 清空输入框
                UI.npcNameInput.value = '';
                UI.npcRelationInput.value = '';
                UI.npcPersonaInput.value = '';
                document.getElementById('npc-avatar-preview').src = 'images/default-avatar.svg';
            } else if (index < editingNpcIndex) {
                // 如果删除了上面的项，当前编辑的索引要减1
                editingNpcIndex--;
            }

            tempNpcList.splice(index, 1);
            renderNpcList();
        }
    });


    // 4. 关闭 NPC 弹窗
    UI.npcModalConfirm.addEventListener('click', () => {
        UI.npcModalOverlay.classList.remove('visible');
    });


    UI.addNewFriendCard.addEventListener('click', () => {
        renderNewFriendsPage();
        showPage('page-new-friends');
    });

    document.querySelector('#add-char-modal-overlay .char-modal-avatar-container').addEventListener('click', () => {
        UI.charModalAvatarUpload.click();
    });

    addTapListener(UI.charModalSave, async () => {
   const voiceIdInput = document.getElementById('char-modal-voice-id').value.trim();
    const langInput = document.getElementById('char-modal-lang').value; // ◀◀◀ [新增] 获取语言
    const speedInput = parseFloat(document.getElementById('char-modal-speed').value);
    
    const ttsSettings = {
        voiceId: voiceIdInput,
        language: langInput, // ◀◀◀ [新增] 保存语言
        speed: speedInput
    };
         const charData = {
        name: UI.charModalName.value.trim(),
        tag: UI.charModalTag.value.trim(),
        persona: UI.charModalPersona.value.trim(),
        avatar: UI.charModalAvatarPreview.src, 
        relatedNpcs: tempNpcList,
        tts: ttsSettings
    };
        let savedCharProfile = null;
        if (!tempState.editingCharId) {
            showDynamicIsland('请从通讯录选择已有角色进行修改');
            return;
        }
        const charIndex = AppState.characterProfiles.findIndex(c => c.id == tempState.editingCharId);
        if (charIndex > -1) {
            const originalSubtitle = AppState.characterProfiles[charIndex].subtitle;
            AppState.characterProfiles[charIndex] = { ...AppState.characterProfiles[charIndex], ...charData, subtitle: originalSubtitle };
            savedCharProfile = AppState.characterProfiles[charIndex];
        }
        if (savedCharProfile) await db.characterProfiles.put(savedCharProfile);
        refreshCharacterLists();
        resetAndHideCharModal();
        showDynamicIsland('角色资料已更新');
    });

    UI.charModalCancel.addEventListener('click', resetAndHideCharModal);
    UI.addCharModalOverlay.addEventListener('click', (e) => { if (e.target === UI.addCharModalOverlay) resetAndHideCharModal(); });
     let cStartX = 0, cStartY = 0;
    UI.characterContactsListContainer.addEventListener('pointerdown', (e) => {
        if (isSelectionMode) return;
        const targetItem = e.target.closest('.contacts-list-item[data-char-id]'); if (!targetItem) return;
        clearTimeout(longPressTimer);
        cStartX = e.clientX; cStartY = e.clientY;
        longPressTimer = setTimeout(() => { 
            e.preventDefault(); // 【新增】阻止默认行为，让长按触发更稳定
            enterSelectionMode(targetItem); 
            longPressTimer = null; 
        }, 500); // 【优化】时间改回500ms，手感更灵敏
    }, { passive: true });

    UI.characterContactsListContainer.addEventListener('pointermove', (e) => {
        if (longPressTimer && (Math.abs(e.clientX - cStartX) > 10 || Math.abs(e.clientY - cStartY) > 10)) clearTimeout(longPressTimer);
    }, { passive: true });
    UI.characterContactsListContainer.addEventListener('pointerup', () => clearTimeout(longPressTimer), { passive: true });
    UI.characterContactsListContainer.addEventListener('pointerleave', () => clearTimeout(longPressTimer), { passive: true });
    UI.characterContactsListContainer.addEventListener('pointercancel', () => clearTimeout(longPressTimer), { passive: true });

    UI.characterContactsListContainer.addEventListener('click', e => {
        if (longPressTimer === null) { e.preventDefault(); e.stopPropagation(); longPressTimer = undefined; return; }
        clearTimeout(longPressTimer);
        if (!isSelectionMode) {
            const targetItem = e.target.closest('.contacts-list-item[data-char-id]');
            if (targetItem) { populateCharModalForEdit(targetItem.dataset.charId); }
            return;
        }
        const isCheckboxClick = e.target.tagName === 'INPUT' && e.target.type === 'checkbox';
        if (isCheckboxClick) {
            const checkbox = e.target;
            const targetItem = checkbox.closest('.contacts-list-item');
            const charId = checkbox.dataset.charId;
            targetItem.classList.toggle('item-selected', checkbox.checked);
            if (checkbox.checked) {
                if (!tempState.selectedCharIds.includes(charId)) tempState.selectedCharIds.push(charId);
            } else {
                tempState.selectedCharIds = tempState.selectedCharIds.filter(id => id !== charId);
            }
            if (tempState.selectedCharIds.length === 0) { exitSelectionMode(); }
        } else {
            exitSelectionMode();
        }
    });

    UI.contactsMoreBtn.addEventListener('click', (e) => { e.stopPropagation(); UI.contactsMenu.style.display = UI.contactsMenu.style.display === 'block' ? 'none' : 'block'; });
    
    UI.contactsMenu.addEventListener('click', async (e) => {
        const action = e.target.dataset.action;
        if (!action) return;
        UI.contactsMenu.style.display = 'none';
        if (tempState.selectedCharIds.length === 0 && !['add-group', 'delete-group'].includes(action)) {
            showDynamicIsland('请先选择角色');
            exitSelectionMode();
            return;
        }
        switch (action) {
            case 'add-to-friends':
                tempState.selectedCharIds.forEach(id => {
                    const char = AppState.characterProfiles.find(c => c.id === id);
                    if (char) Object.assign(char, createFriendRelationshipUpdates(char, true));
                });
                await db.characterProfiles.bulkPut(AppState.characterProfiles.filter(char => tempState.selectedCharIds.some(id => String(id) === String(char.id))));
                refreshCharacterLists({ refreshContacts: false, refreshFriends: true });
                showDynamicIsland(`${tempState.selectedCharIds.length}个角色已添加为好友`);
                break;
            case 'modify-group':
                openGroupSelectorModal();
                UI.contactsMenu.style.display = 'none'; 
                return; 
            case 'add-group':

                showInputModal('输入新分组名称', '', async (name) => {
                    if (name && !AppState.characterGroups.some(g => g.name === name)) {
                        AppState.characterGroups.push({ id: `group_${Date.now()}`, name });
                        await optimizedSaveAndRender();
                        showDynamicIsland(`分组 "${name}" 已创建`);
                    } else if (name) { showDynamicIsland('分组名称已存在'); }
                });
                break;
            case 'delete-group':
                const groupNameToDelete = prompt('输入要删除的分组名称 (此操作不会删除角色):');
                if (groupNameToDelete) {
                    const groupToDelete = AppState.characterGroups.find(g => g.name === groupNameToDelete);
                    if (groupToDelete && groupToDelete.id !== 'default') {
                        AppState.characterProfiles.forEach(char => { if (char.groupId === groupToDelete.id) { char.groupId = 'default'; } });
                        AppState.characterGroups = AppState.characterGroups.filter(g => g.id !== groupToDelete.id);
                        await optimizedSaveAndRender();
                        showDynamicIsland(`分组 "${groupNameToDelete}" 已删除`);
                    } else if (groupToDelete) { showDynamicIsland('不能删除默认分组'); } else { showDynamicIsland('未找到该分组'); }
                }
                break;
            
            case 'delete-char':
                try {
                    const selectedIds = [...tempState.selectedCharIds];
                    const choice = await showContactDeleteChoiceModal(selectedIds.length);
                    if (choice === 'library') {
                        await clearOnlineChatMessagesForCharacters(selectedIds);
                        await clearFriendRequestDataForCharacters(selectedIds);
                        selectedIds.forEach(id => {
                            const char = AppState.characterProfiles.find(c => String(c.id) === String(id));
                            if (char) {
                                Object.assign(char, createFriendRelationshipUpdates(char, false), {
                                    isPinned: false,
                                    inContacts: false,
                                    pendingFriendRequestDirection: null,
                                    pendingFriendRequestMessage: ''
                                });
                                clearFirstVisitConfigForCharacter(char);
                            }
                        });
                        await db.characterProfiles.bulkPut(AppState.characterProfiles.filter(char => selectedIds.some(id => String(id) === String(char.id))));
                        refreshCharacterLists();
                        showDynamicIsland('已清空聊天，并保留在角色库');
                    } else if (choice === 'stranger') {
                        const shortcut = await showContactStrangerShortcutModal(selectedIds.length);
                        if (shortcut === 'cancel') break;
                        let outgoingRequestForAi = null;
                        let outgoingCharForAi = null;
                        let outgoingRequestMessage = '';
                        if (shortcut === 'outgoing') {
                            const firstOutgoingChar = AppState.characterProfiles.find(c => selectedIds.some(id => String(id) === String(c.id)));
                            outgoingRequestMessage = await showInputModal({
                                title: '填写验证消息',
                                initialValue: firstOutgoingChar?.pendingFriendRequestMessage || '',
                                placeholder: '例如：你好，我是刚刚在便利店门口和你说过话的人。',
                                isTextarea: true
                            });
                            if (outgoingRequestMessage === null) break;
                        }
                        await clearOnlineChatMessagesForCharacters(selectedIds);
                        await clearFriendRequestDataForCharacters(selectedIds);
                        await Promise.all(selectedIds.map(id => Promise.all([
                            db.importantMemories.where('charId').equals(id).delete(),
                            db.offlineMessages.where('chatId').equals(id).delete(),
                            db.offlineSessions.where('chatId').equals(id).delete()
                        ])));
                        const changedChars = [];
                        for (const id of selectedIds) {
                            const char = AppState.characterProfiles.find(c => String(c.id) === String(id));
                            if (!char) continue;
                            const baseUpdates = {
                                relationStartMode: 'stranger',
                                relationStage: 'library',
                                hasChat: false,
                                requiresOfflineMeet: true,
                                requiresFriendRequest: true,
                                inContacts: false,
                                isPinned: false,
                                pendingFriendRequestDirection: null,
                                pendingFriendRequestMessage: '',
                                pendingPreviousRelationStage: null,
                                pendingPreviousInContacts: null,
                                memoryProfile: createDefaultMemoryProfile(),
                                relationshipEvents: [],
                                familiarity: 0
                            };
                            if (shortcut === 'incoming') {
                                const message = char.incomingRequestMessage || `我是${char.name || 'Ta'}`;
                                Object.assign(baseUpdates, {
                                    relationStage: 'pending_char',
                                    pendingFriendRequestDirection: 'char_to_user',
                                    pendingFriendRequestMessage: message,
                                    pendingPreviousRelationStage: 'library',
                                    pendingPreviousInContacts: false
                                });
                            } else if (shortcut === 'outgoing') {
                                Object.assign(baseUpdates, {
                                    relationStage: 'pending_user',
                                    pendingFriendRequestDirection: 'user_to_char',
                                    pendingFriendRequestMessage: '你好，我想加你。',
                                    pendingPreviousRelationStage: 'library',
                                    pendingPreviousInContacts: false
                                });
                            }
                            if (shortcut === 'outgoing') {
                                baseUpdates.pendingFriendRequestMessage = outgoingRequestMessage;
                            }
                            Object.assign(char, baseUpdates);
                            clearFirstVisitConfigForCharacter(char);
                            changedChars.push(char);
                            if (shortcut === 'incoming') {
                                await createOrUpdateFriendRequest(char, 'char_to_user', char.pendingFriendRequestMessage, { source: 'contact_delete_reset' });
                            } else if (shortcut === 'outgoing') {
                                const friendRequest = await createOrUpdateFriendRequest(char, 'user_to_char', char.pendingFriendRequestMessage, { source: 'contact_delete_reset' });
                                if (selectedIds.length === 1) {
                                    outgoingRequestForAi = friendRequest;
                                    outgoingCharForAi = char;
                                }
                            }
                        }
                        if (changedChars.length > 0) await db.characterProfiles.bulkPut(changedChars);
                        refreshCharacterLists();
                        window.renderNewFriendsPage?.();
                        if (shortcut === 'outgoing' && outgoingCharForAi && outgoingRequestForAi) {
                            const threadId = outgoingRequestForAi.threadId || `frthread_${String(outgoingCharForAi.id)}_user_to_char`;
                            const threadMessages = getFriendRequestThreadMessages(threadId);
                            const result = await requestFriendRequestAiDecision(outgoingCharForAi, 'user_to_char', outgoingCharForAi.pendingFriendRequestMessage || '', threadMessages);
                            const responseBatchId = `frbatch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                            const rawMessageParts = Array.isArray(result.messages) && result.messages.length > 0
                                ? result.messages
                                : (result.content ? splitFriendRequestReplyText(result.content) : []).map((text, index) => ({
                                    text,
                                    translation: index === 0 ? result.translation || '' : ''
                                }));
                            const messageParts = normalizeFriendRequestReplyParts(rawMessageParts, result.translation || '');
                            if (messageParts.length > 0) {
                                const aiMessages = messageParts.map((part, index) => ({
                                    id: `frmsg_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
                                    sender: 'char',
                                    text: part.text,
                                    translation: part.translation || '',
                                    decision: result.decision,
                                    responseBatchId,
                                    createdAt: Date.now() + index,
                                    deletable: true
                                }));
                                if (!AppState.friendRequestThreads || typeof AppState.friendRequestThreads !== 'object') {
                                    AppState.friendRequestThreads = {};
                                }
                                AppState.friendRequestThreads[threadId] = [...threadMessages, ...aiMessages];
                                await saveFriendRequestThreads();
                            }
                            if (result.decision === 'accept') {
                                await finalizeFriendRequestAcceptance(outgoingCharForAi, 'user_to_char', outgoingRequestForAi, result.initialChatMessages);
                            } else {
                                if (result.decision === 'reject') {
                                    await applyRelationshipScoreEvent(outgoingCharForAi, 'friend_request_reject', {
                                        requestId: outgoingRequestForAi?.id,
                                        source: 'contact_delete_reset_ai',
                                        summary: '角色暂时拒绝了用户的好友申请'
                                    });
                                }
                                showDynamicIsland(result.decision === 'reject' ? 'Ta 暂时没有同意' : '好友申请已发出');
                            }
                        } else {
                        showDynamicIsland(shortcut === 'offline' ? '已改为从线下认识' : '已生成好友申请');
                        }
                    } else if (choice === 'delete') {
                        const deletedIds = await deleteCharactersWithRelatedData(selectedIds);
                        AppState.characterProfiles = AppState.characterProfiles.filter(char => !deletedIds.includes(char.id));
                        deletedIds.forEach(id => removeChatFriendItem(id));
                        removeCharacterContactItems(deletedIds);
                        refreshChatHomeFriendListWhenVisible();
                        refreshCharacterContactsListWhenVisible();
                        showDynamicIsland('角色已彻底删除');
                    }
                } catch (error) {
                    console.error("删除通讯录角色失败:", error);
                    showDynamicIsland('删除失败，请检查控制台');
                }
                break;
        }
        exitSelectionMode();
    });

    UI.phoneScreen.addEventListener('click', (e) => {
        if (isFriendSelectionMode && !e.target.closest('.action-popover')) {
            hideFriendActionPopover();
        }
        if (UI.contactsMenu.style.display === 'block' && !e.target.closest('#contacts-more-btn') && !e.target.closest('#character-contacts-list-container')) {
            exitSelectionMode();
        }
    });
 const searchInput = document.getElementById('chat-search-input');
    const friendsListContainer = UI.friendsContent.querySelector('.conversation-list');
    if (searchInput && friendsListContainer) {
        searchInput.addEventListener('input', () => {
            const searchTerm = searchInput.value.toLowerCase().trim();
            if (document.body.classList.contains('chat-home-style-ins')) {
                window.applyChatHomeInsListFilter?.();
                return;
            }
            const friendItems = friendsListContainer.querySelectorAll('.conversation-item');
            friendItems.forEach(item => {
                const nameElement = item.querySelector('.chat-name');
                if (nameElement) {
                    const name = nameElement.textContent.toLowerCase();
                    // 如果好友名字包含搜索词，就显示；否则就隐藏
                    if (name.includes(searchTerm)) {
                        item.style.display = ''; // 恢复CSS文件里定义的默认显示方式 (通常是 flex)
                    } else {
                        item.style.display = 'none'; // 隐藏
                    }
                }
            });
        });
    }
    // 初始渲染
    refreshChatHomeFriendListWhenVisible();
    refreshCharacterContactsListWhenVisible();
    updateNewFriendEntryBadge();
    // ===============================================

}
// [新增] 语速滑块数值监听
const speedSlider = document.getElementById('char-modal-speed');
const speedDisplay = document.getElementById('char-modal-speed-val');
if (speedSlider && speedDisplay) {
    speedSlider.addEventListener('input', (e) => {
        speedDisplay.textContent = e.target.value;
    });
}
// ===============================================
// ▼▼▼ 【修正版】分组修改弹窗逻辑 (放在文件最末尾) ▼▼▼
// ===============================================

// 打开分组选择弹窗
function openGroupSelectorModal() {
    const modal = document.getElementById('group-selector-modal-overlay');
    const listContainer = document.getElementById('group-selector-list');
    
    // 【调试关键】如果找不到 HTML，直接弹窗报错，别让它静默失败
    if (!modal || !listContainer) {
        alert("错误：找不到弹窗代码！\n请检查 index.html 文件底部是否粘贴了【第一步】的 HTML 代码。");
        return;
    }
if (!tempState.selectedCharIds || tempState.selectedCharIds.length === 0) {
        alert("请先在通讯录中长按选择至少一个角色！");
        return; // 终止函数执行
    }
    // 1. 清空旧列表
    listContainer.innerHTML = '';
    selectedGroupForModify = null;

    // 2. 获取当前第一个选中角色的分组，用于默认高亮
    // 注意：这里需要确保 tempState 和 AppState 能被访问到
    if (!tempState.selectedCharIds || tempState.selectedCharIds.length === 0) {
        alert("请先选择至少一个角色！");
        return;
    }

    const firstCharId = tempState.selectedCharIds[0];
    const firstChar = AppState.characterProfiles.find(c => c.id === firstCharId);
    const currentGroupId = firstChar ? firstChar.groupId : null;

    // 3. 渲染分组列表
    AppState.characterGroups.forEach(group => {
        const div = document.createElement('div');
        div.className = 'group-option-item';
        div.textContent = group.name;
        div.dataset.groupId = group.id;

        // 如果是当前分组，默认显示选中样式
        if (group.id === currentGroupId) {
            div.classList.add('selected');
            selectedGroupForModify = group.id;
        }

        // 点击事件
        div.addEventListener('click', () => {
            // 移除其他项的选中状态
            listContainer.querySelectorAll('.group-option-item').forEach(el => el.classList.remove('selected'));
            // 选中当前项
            div.classList.add('selected');
            selectedGroupForModify = group.id;
        });

        listContainer.appendChild(div);
    });

    // 4. 显示弹窗
    modal.classList.add('visible');

    // 5. 绑定按钮事件（克隆节点以去除旧事件，防止重复绑定）
    const confirmBtn = document.getElementById('group-selector-confirm-btn');
    const cancelBtn = document.getElementById('group-selector-cancel-btn');
    
    if (confirmBtn && cancelBtn) {
        const newConfirm = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);
        
        const newCancel = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);

        // 绑定确认逻辑
        newConfirm.addEventListener('click', async () => {
            if (selectedGroupForModify) {
                // 遍历所有选中的角色ID，修改它们的 groupId
                tempState.selectedCharIds.forEach(id => {
                    const char = AppState.characterProfiles.find(c => c.id === id);
                    if (char) char.groupId = selectedGroupForModify;
                });
                
                // 保存并刷新 (调用该文件内导出的函数)
                await optimizedSaveAndRender();
                
                // 获取分组名称用于提示
                const groupName = AppState.characterGroups.find(g => g.id === selectedGroupForModify)?.name;
                showDynamicIsland(`已移动到分组 "${groupName}"`);
            }
            modal.classList.remove('visible');
            
            // 退出选择模式 (可选，看你体验需求)
            // const exitBtn = document.getElementById('cancel-multiselect-btn'); // 如果有退出按钮可以触发它
        });

        // 绑定取消逻辑
        newCancel.addEventListener('click', () => {
            modal.classList.remove('visible');
        });
    }
}
/**
 * [新增] 获取所有角色列表的函数
 */
export async function getAllCharacters() {
    // AppState.characterProfiles 存储了当前内存中最新的角色列表
    return AppState.characterProfiles;
}
