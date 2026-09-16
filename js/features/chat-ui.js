import { AppState, db, tempState, DEFAULT_AVATAR_SRC, DEFAULT_NOTIFICATION_SRC, DEFAULT_SEND_SOUND_SRC, config, chatState } from '../state.js';
import { isCharacterFriend, isChatInActiveCall } from '../state.js';
import { Diary } from './diary.js';
import { UI, showDynamicIsland, showPage, scrollToBottom } from '../ui.js';
import { addTapListener, isValidAvatarSrc, escapeHTML, formatTime, cleanVisibleMessageText } from '../utils.js';
import { triggerAiResponse, deleteMultipleMessages, cancelAiGeneration, isModeGenerating, retryAiImageGeneration, stopAiImageGeneration, generateFakeChatRecordWithAI, resolveChatForwardSpeakerAvatar, OOC_STABILIZE_INSTRUCTION, setOocNudgeInstruction, clearFollowUpPlan } from './chat-service.js';
import { initCallFunctionality, showCallHistoryModal } from './call.js';
import { TTSService } from './tts-service.js';
import { getRandomGalleryImage } from './gallery.js'; 
import { dataUrlToBlob, openCharacterImageGenSettingsModal, saveGeneratedImageToGallery } from './image-gen.js';
import { openLookyVault, recordLookyLedger, requestLookyPayment } from './looky-pay.js';
import { BLOCK_APPEAL_SOURCE, BLOCK_APPEAL_USER_SOURCE, createFriendRequestChatCardMessage, createOrUpdateFriendRequest, processBlockedByAiAppealUserRequest } from './friend-requests.js';
import { isAppleMobile, isNativeRuntime, openImageForAppleSave, saveImageToNativeGallery, shareBlobToApple } from '../native-bridge.js';
const isSameCharacterId = (left, right) => left != null && right != null && String(left) === String(right);
const hasCharacterId = (ids, id) => (ids || []).some(item => isSameCharacterId(item, id));
const findCharacterById = (id) => AppState.characterProfiles.find(char => isSameCharacterId(char.id, id));

function getGroupParticipants(group) {
    const members = (group?.memberIds || []).map(findCharacterById).filter(Boolean);
    const memberNames = new Set(members.map(member => member.name));
    const npcs = (Array.isArray(group?.groupNpcMembers) ? group.groupNpcMembers : [])
        .map((npc, index) => ({ ...npc, id: String(npc?.id || `group-npc:${npc?.ownerId}:${index}`), isGroupNpc: true }))
        .filter(npc => npc.ownerId && hasCharacterId(group.memberIds, npc.ownerId) && npc.name && !memberNames.has(npc.name));
    return [...members, ...npcs];
}

function findGroupParticipant(group, speakerId, speakerName) {
    const participants = getGroupParticipants(group);
    if (speakerId !== null && speakerId !== undefined && String(speakerId) !== String(group?.id)) {
        const participantById = participants.find(participant => isSameCharacterId(participant.id, speakerId));
        if (participantById) return participantById;
    }
    const normalizedName = String(speakerName || '').trim();
    return normalizedName
        ? participants.find(participant => participant.name === normalizedName) || null
        : null;
}
let chatMessageScrollThrottleTimer = 0;
let chatStickerMatchCache = null;

function invalidateChatStickerMatchCache() {
    chatStickerMatchCache = null;
}

function hideChatStickerMatchPanel() {
    const panel = document.getElementById('chat-sticker-match-panel');
    if (!panel) return;
    panel.hidden = true;
    panel.replaceChildren();
    panel.__matchItems = [];
}

function getChatStickerMatchEntries() {
    const groups = Array.isArray(AppState.stickerGroups) ? AppState.stickerGroups : [];
    if (chatStickerMatchCache?.source === groups) return chatStickerMatchCache.entries;
    const entries = [];
    groups.forEach(pack => {
        if (!pack?.id || !Array.isArray(pack.stickers)) return;
        pack.stickers.forEach((sticker, index) => {
            const explanation = String(sticker?.explanation || '').trim();
            if (!explanation || !sticker?.url) return;
            entries.push({ packId: pack.id, index, sticker, searchText: explanation.toLocaleLowerCase() });
        });
    });
    chatStickerMatchCache = { source: groups, entries };
    return entries;
}

function setupChatStickerMatch(chatInputField) {
    const panel = document.getElementById('chat-sticker-match-panel');
    if (!panel || !chatInputField || panel.dataset.bound === '1') return;
    panel.dataset.bound = '1';
    const isNativeLayout = document.documentElement.classList.contains('looky-native');
    if (isNativeLayout && panel.parentElement !== document.body) document.body.appendChild(panel);
    const inputArea = chatInputField.closest('.chat-input-area') ||
        chatInputField.closest('.chat-input-container') || chatInputField;
    let timer = null;
    let requestId = 0;

    const positionNativePanel = () => {
        if (!isNativeLayout || panel.hidden) return;
        const inputRect = inputArea.getBoundingClientRect();
        const panelHeight = Math.min(panel.offsetHeight || 180, Math.max(80, inputRect.top - 8));
        panel.style.left = '50%';
        panel.style.right = 'auto';
        panel.style.width = `${Math.max(0, Math.min(inputRect.width, window.innerWidth - 16))}px`;
        panel.style.top = `${Math.max(8, inputRect.top - panelHeight - 4)}px`;
        panel.style.bottom = 'auto';
        panel.style.transform = 'translateX(-50%)';
    };

    const scheduleNativePanelPosition = () => requestAnimationFrame(positionNativePanel);
    if (isNativeLayout && typeof ResizeObserver === 'function') {
        const nativePanelResizeObserver = new ResizeObserver(scheduleNativePanelPosition);
        nativePanelResizeObserver.observe(inputArea);
        nativePanelResizeObserver.observe(panel);
    }
    if (isNativeLayout && typeof MutationObserver === 'function') {
        const nativeInputMutationObserver = new MutationObserver(scheduleNativePanelPosition);
        nativeInputMutationObserver.observe(inputArea, { attributes: true, attributeFilter: ['class', 'style'] });
    }

    const hide = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        requestId += 1;
        hideChatStickerMatchPanel();
    };

    const refresh = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        const query = chatInputField.value.trim();
        const char = AppState.characterProfiles.find(item => isSameCharacterId(item.id, tempState.currentChatId));
        const mentionPanel = document.getElementById('chat-mention-panel');
        if (!query || !char?.stickerMatchEnabled || query.endsWith('@') || mentionPanel?.style.display !== 'none') {
            hide();
            return;
        }
        const currentRequestId = ++requestId;
        const chatId = String(tempState.currentChatId || '');
        timer = setTimeout(() => {
            timer = null;
            const enabledIds = new Set(Array.isArray(char.enabledStickerPacks) ? char.enabledStickerPacks : []);
            const terms = query.toLocaleLowerCase().split(/[\s,，。！？!?；;、\n]+/).filter(Boolean).slice(-3);
            if (terms.length === 0) return;
            const matches = getChatStickerMatchEntries()
                .filter(entry => enabledIds.has(entry.packId))
                .map(entry => {
                    const score = terms.reduce((total, term) => {
                        if (entry.searchText.includes(term)) return total + term.length * 2;
                        if (term.includes(entry.searchText)) return total + entry.searchText.length;
                        return total;
                    }, 0);
                    return { entry, score };
                })
                .filter(item => item.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, 6)
                .map(item => item.entry);
            if (currentRequestId !== requestId || chatId !== String(tempState.currentChatId || '')) return;
            panel.replaceChildren();
            panel.__matchItems = matches;
            matches.forEach((entry, index) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'chat-sticker-match-item';
                button.dataset.matchIndex = String(index);
                button.innerHTML = `<img src="${escapeHTML(entry.sticker.url)}" loading="lazy" decoding="async" alt=""><span>${escapeHTML(entry.sticker.explanation)}</span>`;
                panel.appendChild(button);
            });
            panel.hidden = matches.length === 0;
            scheduleNativePanelPosition();
        }, 120);
    };

    panel.addEventListener('pointerdown', event => event.preventDefault());
    panel.addEventListener('click', async event => {
        const button = event.target.closest('.chat-sticker-match-item');
        const entry = button && panel.__matchItems?.[Number(button.dataset.matchIndex)];
        if (!entry) return;
        hide();
        chatInputField.value = '';
        chatInputField.dispatchEvent(new Event('input', { bubbles: true }));
        await window.__sendChatStickerSuggestion?.(entry.sticker, entry.packId, entry.index);
        chatInputField.focus();
    });
    chatInputField.addEventListener('input', refresh);
    chatInputField.addEventListener('blur', () => setTimeout(hide, 120));
    window.addEventListener('looky:page-opened', event => {
        if (event?.detail?.pageId === 'page-chat-detail') invalidateChatStickerMatchCache();
    });
    if (isNativeLayout) {
        const rescheduleNativePanelPosition = () => {
            scheduleNativePanelPosition();
            [80, 220, 420].forEach(delay => window.setTimeout(scheduleNativePanelPosition, delay));
        };
        window.addEventListener('looky:native-viewport-changed', rescheduleNativePanelPosition, { passive: true });
        window.visualViewport?.addEventListener('resize', rescheduleNativePanelPosition, { passive: true });
        window.visualViewport?.addEventListener('scroll', rescheduleNativePanelPosition, { passive: true });
        window.addEventListener('resize', rescheduleNativePanelPosition, { passive: true });
    }
    window.__refreshChatStickerMatches = refresh;
    window.__invalidateChatStickerMatchCache = invalidateChatStickerMatchCache;
}

function scheduleChatMessageScrollToBottom() {
    if (chatMessageScrollThrottleTimer) return;
    chatMessageScrollThrottleTimer = window.setTimeout(() => {
        chatMessageScrollThrottleTimer = 0;
        scrollToBottom();
    }, 100);
}

const notificationSoundBatchState = new Map();
let activeNpcForwardViewerRun = 0;
let activeGroupMemberConversationChatId = null;
let fakeChatRecordState = {
    sourceType: 'single',
    sourceName: '',
    recordStartTime: '',
    selectedParticipantKey: '',
    selectedParticipant: null,
    groupMembers: [],
    messages: []
};
const fakeChatParticipantOptions = new Map();
const FAKE_CHAT_SPEAKER_TYPE_LABELS = {
    user: '用户',
    char: '角色',
    member: '群友'
};

function normalizeFakeChatSpeakerType(value) {
    const normalized = String(value || '').toLowerCase();
    return ['user', 'char', 'member'].includes(normalized) ? normalized : 'member';
}

function formatFakeChatRecordDateTimeValue(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function closeFakeChatSpeakerTypeMenus(exceptPicker = null) {
    document.querySelectorAll('.fake-chat-speaker-type-picker').forEach(picker => {
        if (exceptPicker && picker === exceptPicker) return;
        picker.classList.remove('is-open');
        const trigger = picker.querySelector('[data-fake-speaker-type-trigger]');
        const menu = picker.querySelector('.fake-chat-speaker-type-menu');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
        if (menu) menu.hidden = true;
    });
}

function shouldPlayIncomingNotificationSound(char, chatId) {
    if (!char || char.notificationsEnabled === false) return false;
    if (char.notificationSoundMode !== 'batch') return true;
    const key = String(chatId || char.id || '');
    const now = Date.now();
    const lastPlayedAt = notificationSoundBatchState.get(key) || 0;
    if (now - lastPlayedAt < 4500) return false;
    notificationSoundBatchState.set(key, now);
    return true;
}

function playUserSendSound(char) {
    if (!char || char.sendSoundEnabled === false || typeof window.playNotificationSound !== 'function') return;
    window.playNotificationSound(char.sendSoundSrc || DEFAULT_SEND_SOUND_SRC);
}
async function resolvePendingBlockAppealRequests(charId) {
    if (!charId || !Array.isArray(AppState.friendRequests)) return [];
    const resolvedRequests = AppState.friendRequests.filter(request => String(request.charId) === String(charId)
        && request.source === BLOCK_APPEAL_SOURCE
        && (request.status || 'pending') === 'pending');
    if (resolvedRequests.length === 0) return [];
    const resolvedAt = Date.now();
    resolvedRequests.forEach(request => {
        request.status = 'accepted';
        request.resolvedAt = resolvedAt;
        request.retryAt = null;
        request.blockAppealRejected = false;
        request.blockAppealRejectedAt = null;
    });
    await db.appData.put({ key: 'friendRequests', value: AppState.friendRequests });
    window.dispatchEvent(new CustomEvent('looky:friend-request-updated', { detail: { charId } }));
    return resolvedRequests;
}

async function createBlockAppealChatCardIfNeeded(char, requests = []) {
    if (!char?.id || !Array.isArray(requests) || requests.length === 0) return;
    const request = requests[0];
    const threadId = request.threadId;
    if (threadId) {
        const existing = await db.chatMessages
            .where({ chatId: char.id })
            .filter(message => message.contentType === 'friend_request_card'
                && String(message.content?.threadId || '') === String(threadId))
            .first();
        if (existing) return;
    }
    const cardMessage = await createFriendRequestChatCardMessage(char, request, 'accepted');
    if (cardMessage && String(tempState.currentChatId) === String(char.id)) {
        await createAndAppendMessage(cardMessage);
    }
}

function buildManualBlockAppealRestoreUpdates(char) {
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
}

function syncOpenBlockAppealRequestModalAfterUnblock(char, requests = []) {
    const request = requests[0] || AppState.friendRequests?.find(item => String(item.charId) === String(char?.id)
        && item.source === BLOCK_APPEAL_SOURCE
        && item.status === 'accepted');
    if (!char?.id || !request) return;
    const modal = document.getElementById('new-friend-request-modal');
    if (!modal?.classList.contains('visible')) return;
    const card = modal.querySelector('.nf-request-card');
    if (!card || !isSameCharacterId(card.dataset.charId, char.id)) return;
    const modalThreadId = String(modal.dataset.threadId || card.dataset.threadId || '');
    if (request.threadId && modalThreadId && String(request.threadId) !== modalThreadId) return;

    const status = document.getElementById('nf-request-status');
    const input = document.getElementById('nf-request-reply-input');
    const sendBtn = document.getElementById('nf-request-send-btn');
    const retryBtn = document.getElementById('nf-request-retry-btn');
    if (status) status.textContent = '已同意';
    card.classList.add('is-terminal');
    card.dataset.friendRequestTerminal = 'true';
    if (input) {
        input.disabled = true;
        input.readOnly = true;
        input.placeholder = '验证已结束';
    }
    [sendBtn, retryBtn].forEach(btn => {
        if (!btn) return;
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
        btn.title = '验证已结束';
        btn.setAttribute('aria-label', '验证已结束');
    });
}
// ========================================================================
// 以下是你的 chat-ui.js 文件的完整内容，我只在需要的地方做了微调和注释
// 主要工作是确保所有从 DOM 获取的 messageId 在传递给数据库操作前
// 都被转换成了数字类型。
// ========================================================================
async function processPendingPhoneNpcReveal(chatId) {
    if (!chatId) return;
    const cards = await db.chatMessages
        .where('chatId')
        .equals(chatId)
        .filter(msg => msg.contentType === 'phone_npc_chat_card' && msg.aiVisible === false && Number(msg.phoneNpcRevealTurnsLeft || 0) > 0)
        .toArray();
    for (const card of cards) {
        const nextTurns = Number(card.phoneNpcRevealTurnsLeft || 0) - 1;
        const data = card.phoneNpcChatData || {};
        if (nextTurns <= 0) {
            await db.chatMessages.update(card.id, {
                aiVisible: true,
                phoneNpcRevealTurnsLeft: 0,
                phoneNpcChatData: { ...data, knownByOwner: true, pendingRevealTurns: 0 }
            });
            const historyCard = AppState.currentChatHistory?.find(msg => msg.id === card.id);
            if (historyCard) {
                historyCard.aiVisible = true;
                historyCard.phoneNpcRevealTurnsLeft = 0;
                historyCard.phoneNpcChatData = { ...(historyCard.phoneNpcChatData || {}), knownByOwner: true, pendingRevealTurns: 0 };
            }
            updatePhoneNpcCardRevealStatus(card.id, 'DISCOVERED');
            showDynamicIsland('角色发现了一段查手机记录', 'warning');
        } else {
            await db.chatMessages.update(card.id, {
                phoneNpcRevealTurnsLeft: nextTurns,
                phoneNpcChatData: { ...data, pendingRevealTurns: nextTurns }
            });
            const historyCard = AppState.currentChatHistory?.find(msg => msg.id === card.id);
            if (historyCard) {
                historyCard.phoneNpcRevealTurnsLeft = nextTurns;
                historyCard.phoneNpcChatData = { ...(historyCard.phoneNpcChatData || {}), pendingRevealTurns: nextTurns };
            }
            updatePhoneNpcCardRevealStatus(card.id, `${nextTurns || '?'} TURNS`);
        }
    }
}

function updatePhoneNpcCardRevealStatus(messageId, statusText) {
    const cardEl = document.querySelector(`[data-message-id="${messageId}"] .phone-npc-chat-card .card-status`);
    if (cardEl) cardEl.textContent = statusText;
}

function shouldExpandTranslationByDefault(messageData = {}) {
    const chatId = messageData.chatId || tempState.currentChatId;
    const char = AppState.characterProfiles.find(c => String(c.id) === String(chatId));
    return char?.translationDefaultExpanded !== false;
}

function getTranslationClassName(messageData = {}) {
    return shouldExpandTranslationByDefault(messageData) ? 'message-translation' : 'message-translation collapsed';
}

function appendTranslationToggle(bubble, messageData = {}) {
    if (!bubble || messageData.type !== 'received' || !messageData.translation) return;
    const translation = bubble.querySelector('.message-translation');
    if (!translation || bubble.querySelector('.btn-toggle-translation')) return;

    const anchor = bubble.querySelector('.voice-bar') || bubble.querySelector(':scope > p');
    if (!anchor) return;

    bubble.classList.add('has-translation-toggle');
    anchor.classList.add('has-translation-toggle-anchor');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-toggle-translation';
    button.innerHTML = '<span class="translation-toggle-glyph" aria-hidden="true">译</span>';

    const syncState = () => {
        const expanded = !translation.classList.contains('collapsed');
        button.classList.toggle('active', expanded);
        button.setAttribute('aria-expanded', String(expanded));
        button.setAttribute('aria-label', expanded ? '收起翻译' : '展开翻译');
        button.title = expanded ? '收起翻译' : '展开翻译';
    };

    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        translation.classList.toggle('collapsed');
        syncState();
    });
    anchor.appendChild(button);
    syncState();
}

function toggleTranslationFromMessageMenu(messageWrapper) {
    const bubble = messageWrapper?.querySelector('.message-bubble') || messageWrapper;
    const translation = bubble?.querySelector('.message-translation');
    if (!translation) return false;
    const expanded = translation.classList.toggle('collapsed') === false;
    const toggleButton = bubble.querySelector('.btn-toggle-translation');
    if (toggleButton) {
        toggleButton.classList.toggle('active', expanded);
        toggleButton.setAttribute('aria-expanded', String(expanded));
        toggleButton.setAttribute('aria-label', expanded ? '收起翻译' : '展开翻译');
        toggleButton.title = expanded ? '收起翻译' : '展开翻译';
    }
    return expanded;
}

function resolveGalleryCharacterIdForMessage(messageData = {}) {
    const chatCharacter = AppState.characterProfiles.find(char => String(char.id) === String(messageData.chatId));
    if (!chatCharacter?.isGroup) return messageData.chatId;

    const memberIds = new Set((chatCharacter.memberIds || []).map(id => String(id)));
    const candidateIds = [messageData.imageGenerationPayload?.charId, messageData.speakerId];
    for (const candidateId of candidateIds) {
        if (candidateId === null || candidateId === undefined || !memberIds.has(String(candidateId))) continue;
        return AppState.characterProfiles.find(char => String(char.id) === String(candidateId))?.id || candidateId;
    }

    const speakerMatches = AppState.characterProfiles.filter(char =>
        memberIds.has(String(char.id)) && char.name === messageData.speakerName
    );
    return speakerMatches.length === 1 ? speakerMatches[0].id : null;
}

const regenerateLastResponse = async (targetMessageId = null, callContext = null) => {
    hideMessageActionPopover();
    const hasExplicitCallContext = Boolean(callContext?.callId);
    const numericTargetMessageId = targetMessageId !== null && targetMessageId !== undefined
        ? Number(targetMessageId)
        : null;
    const targetMessageRecord = Number.isFinite(numericTargetMessageId)
        ? await db.chatMessages.get(numericTargetMessageId)
        : null;
    const activeCallMatchesCurrentChat = Boolean(
        tempState.currentCallId
        && tempState.activeCallMode === 'voice'
        && tempState.activeCallChatId
        && String(tempState.currentChatId) === String(tempState.activeCallChatId)
    );
    const targetBelongsToActiveCall = Boolean(
        activeCallMatchesCurrentChat
        && targetMessageRecord?.callId
        && String(targetMessageRecord.callId) === String(tempState.currentCallId)
        && String(targetMessageRecord.chatId) === String(tempState.activeCallChatId)
    );
    if (targetMessageId !== null && targetMessageId !== undefined && !targetMessageRecord) {
        showDynamicIsland('消息不存在，无法重回');
        return;
    }
    if (targetMessageRecord?.callId && !hasExplicitCallContext && !targetBelongsToActiveCall) {
        showDynamicIsland('历史通话消息不能在当前页面重回');
        return;
    }
    const scopedCallId = hasExplicitCallContext
        ? callContext.callId
        : (targetBelongsToActiveCall || (!targetMessageRecord && activeCallMatchesCurrentChat)
            ? tempState.currentCallId
            : null);
    const scopedChatId = callContext?.chatId || tempState.currentChatId;
    const callIsStillActive = scopedCallId
        && tempState.activeCallMode === 'voice'
        && String(tempState.currentCallId) === String(scopedCallId)
        && String(tempState.activeCallChatId) === String(scopedChatId);
    if (hasExplicitCallContext && !callIsStillActive) {
        showDynamicIsland('通话已结束，不能重新生成通话回复');
        return;
    }
    const char = AppState.characterProfiles.find(c => String(c.id) === String(scopedChatId));
    if (char && (char.isBlocked || char.isBlockedByAi)) {
        if (typeof showDynamicIsland === 'function') showDynamicIsland('拉黑状态下无法重回', 'warning');
        return;
    }
    if (scopedCallId) {
        const callMessages = await db.chatMessages
            .where('callId').equals(scopedCallId)
            .toArray();
        callMessages.sort((a, b) => (a.id || 0) - (b.id || 0));

        const targetId = targetMessageId ? Number(targetMessageId) : null;
        const targetMessage = targetId ? callMessages.find(m => Number(m.id) === targetId) : callMessages.slice().reverse().find(m => m.type === 'received' || m.type === 'system');
        const responseGroupId = targetMessage?.responseGroupId || null;
        let messagesToDelete = [];
        let lastUserMsg = null;

        if (responseGroupId) {
            messagesToDelete = callMessages.filter(m => m.responseGroupId === responseGroupId);
            const firstReplyId = Math.min(...messagesToDelete.map(m => Number(m.id)).filter(Boolean));
            lastUserMsg = [...callMessages].reverse().find(m => m.type === 'sent' && Number(m.id) < firstReplyId);
        } else if (targetMessage) {
            const targetIndex = callMessages.findIndex(m => Number(m.id) === Number(targetMessage.id));
            const prevSentItem = targetIndex >= 0
                ? callMessages.slice(0, targetIndex).map((m, index) => ({ m, index })).reverse().find(item => item.m.type === 'sent')
                : null;
            const nextSentOffset = targetIndex >= 0
                ? callMessages.slice(targetIndex + 1).findIndex(m => m.type === 'sent')
                : -1;
            const startIndex = prevSentItem ? prevSentItem.index + 1 : targetIndex;
            const endIndex = nextSentOffset >= 0 ? targetIndex + 1 + nextSentOffset : callMessages.length;
            messagesToDelete = targetIndex >= 0
                ? callMessages.slice(startIndex, endIndex).filter(m => m.type === 'received' || m.type === 'system')
                : [];
            lastUserMsg = prevSentItem?.m || null;
        }

        const idsToDelete = messagesToDelete.map(m => Number(m.id)).filter(Boolean);
        if (idsToDelete.length === 0 || !lastUserMsg) {
            showDynamicIsland('没有可重新生成的通话回复');
            return;
        }

        const idsToDeleteSet = new Set(idsToDelete.map(String));
        requestAnimationFrame(() => {
            const elementsToRemove = document.querySelectorAll('#chat-message-list [data-message-id], #voice-call-message-list [data-message-id]');
            elementsToRemove.forEach(el => {
                if (idsToDeleteSet.has(String(el.dataset.messageId))) el.remove();
            });
            showTypingIndicator();
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        await db.chatMessages.bulkDelete(idsToDelete);
        if (AppState.currentChatHistory) {
            AppState.currentChatHistory = AppState.currentChatHistory.filter(msg => !idsToDelete.includes(msg.id));
        }
        await new Promise(resolve => setTimeout(resolve, 400));
        if (!callIsStillActive
            || String(tempState.currentCallId) !== String(scopedCallId)
            || String(tempState.activeCallChatId) !== String(scopedChatId)) {
            hideTypingIndicator();
            showDynamicIsland('通话已结束，已停止重回');
            return;
        }
        await triggerAiResponse(lastUserMsg.text, scopedChatId);
        return;
    }
    // 【核心修复】防止全表排序撑爆苹果内存，改用 limit 仅拉取最新的 20 条
    const recentMessages = await db.chatMessages.where({ chatId: tempState.currentChatId }).reverse().limit(40).toArray();
    const latestMemberConversationMessages = [];
    for (const message of recentMessages) {
        if (message.generatedByGroupMemberConversation === true && message.type === 'received') {
            latestMemberConversationMessages.push(message);
        } else {
            break;
        }
    }
    if (latestMemberConversationMessages.length > 0) {
        const memberConversationIds = latestMemberConversationMessages.map(message => Number(message.id)).filter(Boolean);
        const memberConversationIdSet = new Set(memberConversationIds.map(String));
        requestAnimationFrame(() => {
            document.querySelectorAll('#chat-message-list [data-message-id]').forEach(element => {
                if (memberConversationIdSet.has(String(element.dataset.messageId))) element.remove();
            });
        });
        await db.chatMessages.bulkDelete(memberConversationIds);
        if (AppState.currentChatHistory) {
            AppState.currentChatHistory = AppState.currentChatHistory.filter(message => !memberConversationIdSet.has(String(message.id)));
        }
        await new Promise(resolve => setTimeout(resolve, 300));
        await generateGroupMemberConversation();
        return;
    }
    const messagesToDelete = [];
    for (const msg of recentMessages) {
        // 【安全兜底】只要是AI发的消息，或者附带了跨频联动ID的隐藏系统记忆，重生成时全部一网打尽
        if (msg.type === 'received' || (msg.type === 'system' && msg.linkedMsgIds)) {
            messagesToDelete.push(msg);
        } else {
            break;
        }
    }
    const idsToDelete = messagesToDelete.map(m => m.id);
    // 【安全兜底】把跨频产生的真实私聊/群聊消息ID也收集起来
    const linkedIds = messagesToDelete.flatMap(m => m.linkedMsgIds || []);

     if (idsToDelete.length > 0) {
        const idsToDeleteSet = new Set(idsToDelete.map(id => String(id)));
        // 【优化】使用 requestAnimationFrame 分批移除DOM，防止瞬间操作导致卡死
        requestAnimationFrame(() => {

            const messageList = document.getElementById('chat-message-list');
            const elementsToRemove = messageList ? messageList.querySelectorAll('[data-message-id]') : document.querySelectorAll('[data-message-id]');
            elementsToRemove.forEach(el => {
                if (idsToDeleteSet.has(String(el.dataset.messageId))) el.remove();
            });
            showTypingIndicator();
        });
   await new Promise(resolve => setTimeout(resolve, 50));
              await db.chatMessages.bulkDelete(idsToDelete);
              // 【安全兜底】精准销毁大模型跨频发送的幽灵数据，防止切出去后记忆错乱
              if (linkedIds.length > 0) await db.chatMessages.bulkDelete(linkedIds);
         if (AppState.currentChatHistory) {

            AppState.currentChatHistory = AppState.currentChatHistory.filter(
                msg => !idsToDelete.includes(msg.id)
            );
        }
        await new Promise(resolve => setTimeout(resolve, 400));
        await triggerAiResponse();
    } else {
        showDynamicIsland('没有可重新生成的消息');
    }
};

const deleteLastCallResponse = async (callContext = null) => {
    const scopedCallId = callContext?.callId || tempState.currentCallId;
    if (!scopedCallId) {
        showDynamicIsland('当前没有可删除的通话回复');
        return false;
    }
    const callMessages = await db.chatMessages
        .where('callId').equals(scopedCallId)
        .toArray();
    callMessages.sort((a, b) => (a.id || 0) - (b.id || 0));
    let messagesToDelete = [];
    const lastSentIndex = callMessages.map(message => message.type).lastIndexOf('sent');
    if (lastSentIndex >= 0) {
        // 删除最近一轮：包含用户最后一句，以及这句话之后的角色回复和通话内部记录。
        messagesToDelete = callMessages.slice(lastSentIndex).filter(message =>
            message.type === 'sent' || message.type === 'received' || message.type === 'system'
        );
    } else {
        const lastReceivedMessage = callMessages.slice().reverse().find(message => message.type === 'received');
        if (lastReceivedMessage) {
            messagesToDelete = [lastReceivedMessage];
        }
    }
    const idsToDelete = new Set(messagesToDelete.map(message => Number(message.id)).filter(Boolean));
    if (idsToDelete.size === 0) {
        showDynamicIsland('当前没有可删除的通话消息');
        return false;
    }
    if (!confirm('确定删除当前通话的最近一轮消息吗？')) return false;

    await deleteMultipleMessages(idsToDelete);
    const idsToDeleteSet = new Set(Array.from(idsToDelete).map(String));
    requestAnimationFrame(() => {
        document.querySelectorAll('#chat-message-list [data-message-id], #voice-call-message-list [data-message-id]')
            .forEach(element => {
                if (idsToDeleteSet.has(String(element.dataset.messageId))) element.remove();
            });
    });
    if (AppState.currentChatHistory) {
        AppState.currentChatHistory = AppState.currentChatHistory.filter(message => !idsToDelete.has(message.id));
    }
    showDynamicIsland('已删除最近一轮通话消息');
    return true;
};

const LOCATION_MAP_IMAGES = [
    'images/map1.jpeg',
    'images/map2.jpeg'
];
const DREAM_CARD_IMAGE_SRC = 'images/dream-card.png';

let activeMessagePopover = null;
let handleClickOutside;
const chatMessageList = document.getElementById('chat-message-list');
function refreshChatFontSizeRoots() {
}
function resyncChatFontSizing() {
}
function getGroupMessageSpeakerKey(messageData, char, currentChatUser) {
    if (!char?.isGroup || !['sent', 'received'].includes(messageData?.type)) return '';
    if (messageData.type === 'sent') return `user:${currentChatUser?.id || 'self'}`;

    let speakerId = messageData.speakerId;
    if ((!speakerId || String(speakerId) === String(char.id)) && messageData.speakerName) {
        const member = findGroupParticipant(char, null, messageData.speakerName);
        if (member) speakerId = member.id;
    }
    if (speakerId) return `member:${speakerId}`;
    return messageData.speakerName ? `name:${messageData.speakerName}` : '';
}
function refreshGroupSpeakerContinuity(container = chatMessageList) {
    const list = container || document.getElementById('chat-message-list');
    if (!list) return;

    const isPlainTextBubble = bubble => {
        if (!bubble || bubble.classList.contains('is-voice-message')
            || bubble.classList.contains('is-voice-call-summary')
            || bubble.classList.contains('is-voice-call-rejected')
            || bubble.classList.contains('is-transfer-message')) {
            return false;
        }
        const hasDirectParagraph = Array.from(bubble.children).some(element => element.tagName === 'P');
        bubble.classList.toggle('has-direct-text-message', hasDirectParagraph);
        return hasDirectParagraph;
    };

    let previousGroupSpeakerKey = '';
    let previousWasGroupMessage = false;
    let previousMessageType = '';
    let previousWasPlainTextMessage = false;
    Array.from(list.children).forEach(child => {
        if (!child.classList?.contains('message-wrapper')) {
            previousGroupSpeakerKey = '';
            previousWasGroupMessage = false;
            previousMessageType = '';
            previousWasPlainTextMessage = false;
            return;
        }
        child.classList.remove('same-group-speaker-prev');
        child.classList.remove('same-message-type-prev');
        child.classList.remove('same-text-message-prev');
        const currentMessageType = child.classList.contains('sent')
            ? 'sent'
            : (child.classList.contains('received') ? 'received' : '');
        if (currentMessageType && currentMessageType === previousMessageType) {
            child.classList.add('same-message-type-prev');
        }
        const currentIsPlainTextMessage = Array.from(child.querySelectorAll('.message-bubble')).some(isPlainTextBubble);
        if (
            currentIsPlainTextMessage &&
            previousWasPlainTextMessage &&
            currentMessageType &&
            currentMessageType === previousMessageType
        ) {
            child.classList.add('same-text-message-prev');
        }
        const isGroupMessage = child.classList.contains('is-group-chat')
            && (child.classList.contains('sent') || child.classList.contains('received'));
        const currentGroupSpeakerKey = child.dataset.groupSpeakerKey || '';

        if (isGroupMessage && previousWasGroupMessage && currentGroupSpeakerKey && currentGroupSpeakerKey === previousGroupSpeakerKey) {
            child.classList.add('same-group-speaker-prev');
        }
        previousWasGroupMessage = isGroupMessage;
        previousGroupSpeakerKey = isGroupMessage ? currentGroupSpeakerKey : '';
        previousMessageType = currentMessageType;
        previousWasPlainTextMessage = currentIsPlainTextMessage;
    });
}
if (!window.__lookyFontSizeRefreshChatBound) {
    window.__lookyFontSizeRefreshChatBound = true;
    window.addEventListener('looky:font-size-changed', refreshChatFontSizeRoots);
}
function shouldUseLightChatRenderMode() {
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const lowMemoryDevice = Number(navigator.deviceMemory || 0) > 0 && Number(navigator.deviceMemory) <= 4;
    const lacksLazyRenderSupport = !('IntersectionObserver' in window);
    return isNativeRuntime() || isIOS || lowMemoryDevice || lacksLazyRenderSupport;
}

function showTypingIndicator() {
    const voiceCallPage = document.getElementById('page-voice-call');
    // ▼▼▼ 终极安全防烫：物理尺寸判定法，宽度为0说明页面被隐藏了 ▼▼▼
    if (!voiceCallPage || voiceCallPage.offsetWidth === 0) return;
    hideTypingIndicator();
    const messageList = document.getElementById('voice-call-message-list');
    if (!messageList) return;
    const indicatorHTML = `
        <div id="typing-indicator" class="message-wrapper received">
            <div class="message-bubble typing-indicator voice-call-typing">
                <span></span>
                <span></span>
                <span></span>
            </div>
        </div>
    `;
    messageList.insertAdjacentHTML('beforeend', indicatorHTML);
    messageList.scrollTop = messageList.scrollHeight;
}

function hideTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) {
        indicator.remove();
    }
}
export function getCurrentChatIdentity(specificChatId = null) {
    // 如果传了具体ID就用具体的，没传就看当前屏幕
    const targetChatId = specificChatId || tempState.currentChatId;
    const char = AppState.characterProfiles.find(c => c.id === targetChatId);
    const identityIdToUse = char?.chatIdentityId || AppState.currentIdentityId;
    return AppState.userIdentities.find(id => id.id === identityIdToUse) || AppState.userIdentities[0];
}

/**
 * 创建一个“加载更早消息”的按钮元素
 * @param {number} count - 被折叠的消息数量
 * @param {string} conversationId - 当前对话ID
 * @returns {HTMLElement}
 */
function createFolderElement(count, conversationId) {
    const folder = document.createElement('div');
    folder.className = 'message-folder'; // 这个class用来设置样式
    folder.dataset.conversationId = conversationId;
    folder.innerHTML = `<button class="btn-load-more">查看更早的 ${count} 条消息</button>`;
    return folder;
}

/**
 * 展开被折叠的消息（分批加载版）
 * @param {string} conversationId
 */
export async function expandFoldedMessages(conversationId, targetMessageId = null) {
    const foldedState = chatState.unrenderedMessages.get(conversationId);
    const remainingCount = Array.isArray(foldedState)
        ? foldedState.length
        : (Number(foldedState?.remainingCount) || 0);
    if (remainingCount === 0) return;
    const chunkSize = config.onlineMessageLoadChunkSize;
    
    // 计算这次要加载多少条，以及在数据库中的起始位置
    const numberToLoad = Math.min(chunkSize, remainingCount);
    let offset = remainingCount - numberToLoad;
    let targetRevealMode = targetMessageId !== null && targetMessageId !== undefined;
    if (targetRevealMode) {
        const olderCount = await db.chatMessages
            .where('chatId').equals(conversationId)
            .and(message => Number(message.id) < Number(targetMessageId))
            .count();
        if (olderCount >= remainingCount) return;
        offset = Math.max(0, Math.min(remainingCount - numberToLoad, olderCount - Math.floor(numberToLoad / 2)));
    }
    // 【核心修改】从数据库分片加载
    const messagesToRenderNow = await db.chatMessages
        .where('chatId').equals(conversationId)
        .offset(offset) // 跳过 (总剩余 - 这次要加载的) 条，也就是从需要的位置开始取
        .limit(numberToLoad) // 只取这一批
        .toArray();
    if (messagesToRenderNow.length === 0) {
        const folderElementOnError = chatMessageList.querySelector(`.message-folder[data-conversation-id="${conversationId}"]`);
        if(folderElementOnError) folderElementOnError.remove();
        chatState.unrenderedMessages.delete(conversationId);
        return;
    }
    
    // 从这里开始，渲染和滚动恢复的逻辑与你原有的完全一致，我们保持不变
    const folderElement = chatMessageList.querySelector(`.message-folder[data-conversation-id="${conversationId}"]`);
    if (!folderElement) return;
    const oldScrollHeight = chatMessageList.scrollHeight;
    const oldScrollTop = chatMessageList.scrollTop;
    const messageElements = await Promise.all(messagesToRenderNow.map(msg => createMessageElement(msg)));
    const fragment = document.createDocumentFragment();
    messageElements.forEach((element, index) => {
        if (element) {
            bindMessageEvents(element, messagesToRenderNow[index]);
            fragment.appendChild(element);
        }
    });
    folderElement.after(fragment);
    refreshGroupSpeakerContinuity();
    resyncChatFontSizing();
    chatMessageList.scrollTop = oldScrollTop + (chatMessageList.scrollHeight - oldScrollHeight);
   
    // 更新内存中的历史记录，把新加载的加到最前面
    AppState.currentChatHistory.unshift(...messagesToRenderNow);
    // 更新“虚拟”的未渲染消息数组
    const newRemainingCount = targetRevealMode ? offset : remainingCount - messagesToRenderNow.length;
    if (newRemainingCount > 0) {
        chatState.unrenderedMessages.set(conversationId, Array.isArray(foldedState)
            ? foldedState.slice(0, newRemainingCount)
            : { remainingCount: newRemainingCount });
        folderElement.querySelector('.btn-load-more').textContent = `查看更早的 ${newRemainingCount} 条消息`;
    } else {
        folderElement.remove();
        chatState.unrenderedMessages.delete(conversationId);
    }
}

let messageObserver = null;

function initMessageObserver(rootMargin = '800px 0px') {
    if (messageObserver) messageObserver.disconnect();
    if (!chatMessageList || !('IntersectionObserver' in window)) {
        messageObserver = null;
        return;
    }
    
    // 默认保留网页端较大的预加载缓冲区；原生 WebView 会在调用处传入更小的值。
    messageObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const placeholder = entry.target;
                const messageId = Number(placeholder.dataset.messageId);
                const showOutsideTime = placeholder.dataset.showOutsideTime === 'true';
                
                // 停止监视这个占位符
                observer.unobserve(placeholder);
                
                // 异步获取数据并替换
                db.chatMessages.get(messageId).then(messageData => {
                    if (messageData) {
                        // 使用你现有的函数创建真实元素
                        const realElement = createMessageElement(messageData, showOutsideTime);
                        if (realElement) {
                            bindMessageEvents(realElement, messageData);
                            if (tempState.isMultiSelectMode
                                && tempState.selectedMessageIds.has(messageId)) {
                                realElement.classList.add('selected');
                            }
                            // 只有当父节点还在时才替换，防止报错
                            if (placeholder.parentNode) {
                                // 使用 requestAnimationFrame 确保替换操作在下一帧渲染前执行，减少掉帧
                                requestAnimationFrame(() => {
                                    if (placeholder.parentNode) {
                                        placeholder.parentNode.replaceChild(realElement, placeholder);
                                        refreshGroupSpeakerContinuity();
                                        resyncChatFontSizing();
                                    }
                                });
                            }
                        } else {
                            placeholder.remove(); 
                        }
                    }
                });
            }
        });
    }, { root: chatMessageList, rootMargin });
}

/**
 * 停止正在运行的“对话中”时间戳定时器 (关闹钟)
 */
function stopInConversationTimestampTimer() {
    if (chatState.inConversationTimestampTimer) {
        clearInterval(chatState.inConversationTimestampTimer);
        chatState.inConversationTimestampTimer = null;
        console.log('[Timestamp] 对话定时器已停止。');
    }
}

/**
 * 启动“对话中”时间戳定时器 (开闹钟)
 * @param {string} chatId - 当前聊天ID
 */
function startInConversationTimestampTimer(chatId) {
    // 启动前，先确保旧的定时器已停止，防止重复
    stopInConversationTimestampTimer();

    const character = AppState.characterProfiles.find(c => c.id === chatId);
    const timeSettings = character?.timeSettings;

    // 如果没有设置，或者设置为不显示，则不启动定时器
    if (!timeSettings || timeSettings.position !== 'center') {
        return;
    }

    const intervalMinutes = timeSettings.centerInterval || 5;
    
    if (intervalMinutes <= 0) {
        return;
    }

    const intervalMs = intervalMinutes * 60 * 1000;

    console.log(`[Timestamp] 对话定时器已启动，每 ${intervalMinutes} 分钟插入一次时间戳。`);

    chatState.inConversationTimestampTimer = setInterval(() => {
        const now = new Date();
        const timestampElement = createTimestampElement(now.getTime());

        if (timestampElement) {
            chatMessageList.appendChild(timestampElement);
            scrollToBottom();
        }
    }, intervalMs);
}
/**
 * 【新增】一个超快速的函数，只负责清空聊天界面，不加载任何数据。
 * @param {string} chatId - 当前聊天ID
 */
export function prepareEmptyChatInterface(chatId) {
    // 【苹果专供优化1/2】瞬间隐身，且关闭任何动画过渡
    chatMessageList.style.transition = 'none';
    chatMessageList.style.opacity = '0';
    
    // ▼▼▼ 新增：瞬间清理聊天壁纸，防止切出页面时发生旧壁纸闪烁 ▼▼▼
    const chatContentArea = document.querySelector('#page-chat-detail .chat-detail-content');
    if (chatContentArea) chatContentArea.style.backgroundImage = 'none';
    const pageChatDetail = document.getElementById('page-chat-detail');
    if (pageChatDetail) pageChatDetail.style.background = 'none';
    const bgStyleTag = document.getElementById('dynamic-chat-bg-style');
    if (bgStyleTag) bgStyleTag.innerHTML = '';
    // ▲▲▲ 清理壁纸结束 ▲▲▲

    // 1. 清空聊天列表，让它变成一片空白
    chatMessageList.innerHTML = '';

    tempState.isRenderingHistory = false;
    const capsule = document.getElementById('ride-status-capsule');
    const arrivalCard = document.getElementById('arrival-invite-card');
    if (capsule) capsule.style.display = 'none';
    if (arrivalCard) arrivalCard.style.display = 'none';
    // 2. 停止任何可能正在运行的旧聊天的时间戳计时器
    stopInConversationTimestampTimer();
    
    // 3. 清空 AppState 中的旧聊天记录缓存
    AppState.currentChatHistory = [];
    
    // 4. 清除“未渲染消息”的缓存
    chatState.unrenderedMessages.delete(chatId);
    
    console.log(`[性能优化] 已为角色 ${chatId} 准备好一个空的聊天界面。`);
}

export async function loadAndRenderChatHistory(chatId, isOnlineMode, options = {}) {
     const isTargetJump = options?.targetMessageId !== null && options?.targetMessageId !== undefined;
     const renderToken = (tempState.chatHistoryRenderToken || 0) + 1;
     tempState.chatHistoryRenderToken = renderToken;
     const isCurrentRender = () => tempState.chatHistoryRenderToken === renderToken
         && String(tempState.currentChatId) === String(chatId);
     tempState.isRenderingHistory = true; 
    console.log('[渲染锁] 已上锁，历史记录渲染中...');
   try {
    // --- 数据准备阶段 ---
    stopInConversationTimestampTimer();
    AppState.currentChatHistory = [];
    chatState.unrenderedMessages.delete(chatId);
    
    // 1. 设置头像和背景
    const characterForBg = AppState.characterProfiles.find(c => c.id === chatId);
       // ▼▼▼ 新增：判断拉黑状态，显示/隐藏遮板 ▼▼▼
    const blockedOverlay = document.getElementById('chat-blocked-overlay');
    if (blockedOverlay) {
        if (characterForBg && characterForBg.isBlocked) {
            blockedOverlay.style.display = 'flex';
        } else {
            blockedOverlay.style.display = 'none';
        }
    }
    // ▲▲▲ 新增结束 ▲▲▲
    if (characterForBg) {
        const topAvatar = document.getElementById('chat-detail-char-avatar');
        const topName = document.getElementById('chat-detail-char-name');
        
        if (topAvatar) {
            const displayAvatar = characterForBg.chatOverrideAvatar || characterForBg.avatar || DEFAULT_AVATAR_SRC;
            topAvatar.src = isValidAvatarSrc(displayAvatar) ? displayAvatar : DEFAULT_AVATAR_SRC;
        }
         if (topName) {
            const displayName = characterForBg.chatOverrideName || characterForBg.name;
            // ▼▼▼ 动态判断并恢复：如果当前角色正在思考，则显示“正在输入中” ▼▼▼
            if (isModeGenerating('online', chatId)) {
                topName.textContent = '对方正在输入中';
            } else {
                topName.textContent = escapeHTML(displayName);
            }
        }
    }
     // ▼▼▼ 动态判断并恢复发送按钮的加载圈 ▼▼▼
    const sendBtn = document.getElementById('send-message-btn');
    if (sendBtn) {
        if (isModeGenerating('online', chatId)) {
            sendBtn.classList.add('loading');
        } else {
            sendBtn.classList.remove('loading');
        }
    }
    // ▲▲▲ 新增结束 ▲▲▲

    // 【核心修复】这里删除了强制给内容区设 backgroundImage 的代码。
    // 防止覆盖 chatBeautify.js 中更高级的背景延伸模式，
    // 同时也极大地减少了加载大 Base64 图片造成的界面严重卡顿。

    // 【V3 性能优化核心】
    const totalMessageCount = await db.chatMessages.where('chatId').equals(chatId).count();
    const useLightRenderMode = shouldUseLightChatRenderMode();
    const messageObserverRootMargin = isNativeRuntime()
        ? '200px 0px'
        : (useLightRenderMode ? '400px 0px' : '800px 0px');
    // 原生 WebView 首屏只需要观察靠近当前视口的旧消息，避免进入聊天时提前生成大量历史气泡。
    initMessageObserver(messageObserverRootMargin);
    const threshold = useLightRenderMode ? 30 : 50;
    let messagesToRenderInitially = [];
    let foldedMessagesForUI = []; 
    if (totalMessageCount > threshold) {
        const foldCount = totalMessageCount - threshold;
        foldedMessagesForUI = { remainingCount: foldCount }; 
        messagesToRenderInitially = await db.chatMessages
            .where('chatId').equals(chatId)
            .reverse() 
            .limit(threshold)
            .toArray();
        messagesToRenderInitially.reverse();
    } else {

        messagesToRenderInitially = await db.chatMessages.where('chatId').equals(chatId).sortBy('timestamp');
    }
    
    if (!isCurrentRender()) return;
    AppState.currentChatHistory = messagesToRenderInitially;
    
    // 合并暂存消息
    const pendingMessages = chatState.pendingMessageQueue.get(chatId);
    if (pendingMessages && pendingMessages.length > 0) {
        console.log(`[渲染合并] 发现 ${pendingMessages.length} 条暂存消息，正在进行去重合并...`);
        const existingIds = new Set(AppState.currentChatHistory.map(m => m.id));
        for (const msg of pendingMessages) {
            if (!existingIds.has(msg.id)) {
                AppState.currentChatHistory.push(msg);
                existingIds.add(msg.id); 
            }
        }
        chatState.pendingMessageQueue.delete(chatId);
    }
    // 筛选可见消息
    const relevantMessages = AppState.currentChatHistory.filter(msg => {
        if (msg.contentType === 'voice_call_summary') return true;
        if (msg.callId) return false;
        // 【核心放行】：在这里加上 || msg.contentType === 'focus_record_card'，让陪伴卡片进入渲染队列
        return ['sent', 'received'].includes(msg.type) || msg.contentType === 'system_event' || msg.contentType === 'focus_record_card' || msg.contentType === 'phone_npc_chat_card' || msg.contentType === 'phone_user_hijack_message' || msg.contentType === 'phone_user_takeover_message' || msg.contentType === 'friend_request_card' || msg.contentType === 'char_interaction_card' || msg.contentType === 'npc_chat_forward' || msg.contentType === 'chat_forward' || msg.contentType === 'mcp_tool_card';
    });
    
    AppState.currentChatHistory = relevantMessages;
    messagesToRenderInitially = relevantMessages;

    // 处理折叠按钮
    let messagesToFold = foldedMessagesForUI;
    const foldedCount = Array.isArray(messagesToFold)
        ? messagesToFold.length
        : (Number(messagesToFold?.remainingCount) || 0);
    if (foldedCount > 0) {
        chatState.unrenderedMessages.set(chatId, messagesToFold);
    }

    // --- 渲染阶段 ---
    if (!isCurrentRender()) return;
    chatMessageList.innerHTML = ''; 
    if (foldedCount > 0) {
        chatMessageList.appendChild(createFolderElement(foldedCount, chatId));
    }
    
    const character = AppState.characterProfiles.find(c => c.id === chatId);
    const timeSettings = character?.timeSettings || {};
    const centerIntervalMs = (timeSettings.centerInterval || 5) * 60 * 1000;
    // 获取最后一条折叠消息的时间戳
    let lastMessageTimestamp = 0;
    if (foldedCount > 0) {
        // 【核心性能修复：从倒序直接定位，避免从头数几万条数据导致苹果手机卡死4秒】
        const lastFoldedMessage = await db.chatMessages
            .where('chatId').equals(chatId)
            .reverse() 
            .offset(threshold) 
            .first(); 
        
        if (lastFoldedMessage) {
            lastMessageTimestamp = lastFoldedMessage.timestamp;
        }
    }

    // ▼▼▼▼▼▼▼ 【步骤三：带保险丝的渲染循环】 ▼▼▼▼▼▼▼

    const mainFragment = document.createDocumentFragment();
    
    // 【安全检查】检测浏览器是否支持 IntersectionObserver
    const supportIntersectionObserver = 'IntersectionObserver' in window;
    // 原生/低内存设备减少首屏查询量；复杂消息仍通过占位符按需生成，避免首屏卡顿。
    // 这样保留原有 15 条直接渲染上限，避免图片/卡片消息造成主线程长时间占用。
    const DIRECT_RENDER_COUNT = supportIntersectionObserver
        ? (isNativeRuntime() ? 15 : (useLightRenderMode ? threshold : 15))
        : threshold; 
    
    const startIndexForDirectRender = Math.max(0, messagesToRenderInitially.length - DIRECT_RENDER_COUNT);

    messagesToRenderInitially.forEach((currentMessage, index) => {
        let shouldShowOutsideTimestamp = false;
        
        if (timeSettings.position === 'outside') {
            if (timeSettings.outsideMode === 'always') {
                shouldShowOutsideTimestamp = true;
            } else if (timeSettings.outsideMode === 'last') {
                const nextMsg = messagesToRenderInitially[index + 1];
                if (!nextMsg || nextMsg.type !== currentMessage.type) {
                    shouldShowOutsideTimestamp = true;
                }
            }
        }
        
        if (timeSettings.position === 'center' && lastMessageTimestamp > 0 && currentMessage.timestamp - lastMessageTimestamp > centerIntervalMs) {
            const timestampElement = createTimestampElement(currentMessage.timestamp);
            if (timestampElement) mainFragment.appendChild(timestampElement);
        }

        // 分支逻辑：新消息直接画，老消息且支持懒加载则画占位符
        if (index >= startIndexForDirectRender) {
            const messageElement = createMessageElement(currentMessage, shouldShowOutsideTimestamp);
            if (messageElement) {
                bindMessageEvents(messageElement, currentMessage);
                mainFragment.appendChild(messageElement);
            }
        } else {
            // 渲染轻量级占位符
            const placeholder = document.createElement('div');
            placeholder.className = 'message-placeholder';
            placeholder.style.height = '80px'; 
            placeholder.dataset.messageId = currentMessage.id;
            placeholder.dataset.showOutsideTime = shouldShowOutsideTimestamp;
            
            messageObserver.observe(placeholder);
            mainFragment.appendChild(placeholder);
        }
        
        lastMessageTimestamp = currentMessage.timestamp;
    });
     // ▲▲▲▲▲▲▲ 修改结束 ▲▲▲▲▲▲▲

    chatMessageList.appendChild(mainFragment);
    refreshGroupSpeakerContinuity();
    resyncChatFontSizing();
    
    // 普通进入聊天页仍然保持原来的滚到底部；搜索跳转时交给调用方定位目标消息。
    if (!isTargetJump) scrollToBottom();

    // ▼▼▼ 【苹果专供优化2/2：高频压底与双帧同步】 ▼▼▼
    
    // 给显形加上 0.2 秒的柔和淡入，能完美掩盖 iOS 底层的重绘闪烁
    chatMessageList.style.transition = 'opacity 0.2s ease-out';

    // 逼迫 iOS 渲染引擎把当前的 HTML 排版做完（双重 RAF 是解决 iOS 渲染延迟的终极方案）
    if (isTargetJump) {
        chatMessageList.style.opacity = '1';
    } else requestAnimationFrame(() => {
        if (!isCurrentRender()) return;
        requestAnimationFrame(() => {
            if (!isCurrentRender()) return;
            scrollToBottom(); // 再次压底
            
            // 降低压底频率，避免老 iPhone 在刚进聊天页时被连续滚动占满主线程
            let pinCount = 0;
            const maxPinCount = useLightRenderMode ? 2 : 4;
            const pinDelay = useLightRenderMode ? 48 : 32;
             const pinToBottom = () => {
                 if (!isCurrentRender()) return;
                 scrollToBottom();
                pinCount++;
                if (pinCount >= maxPinCount) {
                    chatMessageList.style.opacity = '1';
                    return;
                }
                setTimeout(pinToBottom, pinDelay);
            };
            setTimeout(pinToBottom, pinDelay);
        });
    });
    startInConversationTimestampTimer(chatId);

    } catch (error) {
        console.error('[渲染历史记录时发生异常]', error);
        // 【保险1】如果走到这里，说明上面代码报错崩溃了，立刻强行显示！
        if (isCurrentRender()) chatMessageList.style.opacity = '1';
    } finally {
        // 【保险2】无论成败，这里都立刻清理动画限制，恢复正常状态
        if (isCurrentRender()) chatMessageList.style.transition = 'none';
        
        // 【保险3：核弹级兜底】设置一个终极倒计时。
        // 使用 setTimeout 哪怕主线程卡死了，只要它喘过气来，第一件事就是执行这句强制显示！
        setTimeout(() => {
            // 强制重置透明度和任何可能隐藏页面的属性
            if (isCurrentRender() && chatMessageList.style.opacity !== '1') {
                console.warn('[兜底触发] 检测到可能发生卡死，强行脱下隐身斗篷！');
                chatMessageList.style.opacity = '1';
                chatMessageList.style.visibility = 'visible';
                scrollToBottom(); // 强行拉到底
            }
        }, 800); // 800毫秒（0.8秒）不出来，就强行扯掉斗篷
        
        if (isCurrentRender()) tempState.isRenderingHistory = false;
        console.log('[渲染锁] 已解锁，允许新消息渲染。');
    }
}


/**
 * 这是一个辅助函数，创建时间戳的HTML结构
 * 【已修正为“外套+衬衫”结构】
 */
function createTimestampElement(timestamp) {
    const character = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
    if (!character) return null;

    const timeSettings = character.timeSettings || {};
    const position = timeSettings.position || 'none';
    
    if (position !== 'center') return null;
    
    const timestampStyle = timeSettings.centerStyle || 'pill-center';
    
    // 1. 创建“外套”（一个看不见的、占满整行的 flex 容器）
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-timestamp'; // 它只负责居中

    // 2. 创建“衬衫”（漂亮的、自适应宽度的胶囊或文字）
    const content = document.createElement('span'); // 用 span 元素，它默认宽度自适应
    content.className = `chat-timestamp-content chat-timestamp--${timestampStyle}`; // 给它一个新的基础类名和样式类名
    content.innerHTML = formatTimestampForDisplay(timestamp, timestampStyle);

    // 3. 把“衬衫”穿在“外套”里
    wrapper.appendChild(content);

    // 4. 返回整套衣服
    return wrapper;
}
function bindMessageEvents(element, messageData) {
    element.addEventListener('click', (event) => smartClickHandler(element, messageData, event));
    
    let actions;
    if (messageData.type === 'sent') {
        actions = ['copy', 'favorite', 'edit', 'quote', 'recall', 'multiselect', 'delete']; // <--- 修改：在最前面加了 'copy'
    } else { 
        actions = ['copy', 'favorite', 'edit', 'quote', 'reEnter', 'multiselect', 'delete']; // <--- 修改：在最前面加了 'copy'
    }
    if (messageData.type === 'received' && messageData.translation) actions.unshift('translation');
    
    setupLongPress(element, messageData.id, actions);
    setupSwipeToQuote(element, messageData.id);
}

function bindPreviewLongPress(element, messageData) {
    const actions = messageData.type === 'sent'
        ? ['copy', 'favorite', 'edit', 'quote', 'recall', 'multiselect', 'delete']
        : ['copy', 'favorite', 'edit', 'quote', 'reEnter', 'multiselect', 'delete'];
    if (messageData.type === 'received' && messageData.translation) actions.unshift('translation');
    setupLongPress(element, messageData.id, actions);
}

function bindFavoritePreviewInteractions(element, messageData) {
    element.addEventListener('click', () => smartClickHandler(element, messageData));
    bindPreviewLongPress(element, messageData);
}
function bindVoiceCallMessageEvents(element, messageData) {
    let actions;
    if (messageData.type === 'sent') {
        actions = ['delete'];
    } else {
        actions = ['reEnter', 'delete'];
    }
    setupLongPress(element, messageData.id, actions);
}

/**
 * 简单的 HTML 内容净化器
 * 用于在渲染前过滤掉明显的恶意模式
 */
function sanitizeHtmlSnippet(htmlContent) {
    if (!htmlContent) return '';

    let clean = htmlContent;

    clean = clean.replace(/window\.top/gi, 'window.self');
    clean = clean.replace(/window\.parent/gi, 'window.self');
    clean = clean.replace(/<form\s+[^>]*action=["']http[^"']*["'][^>]*>/gi, '<form action="#">');
    clean = clean.replace(/autoplay/gi, '');

    // ▼▼▼ 新增：拦截恶意链接与外跳 ▼▼▼
    clean = clean.replace(/<a\s+[^>]*href=["']?(http[^"'>\s]*)["']?/gi, '<a href="javascript:void(0);" data-blocked="$1"');
    clean = clean.replace(/target=["']?_blank["']?/gi, '');
    // ▲▲▲ 新增结束 ▲▲▲

    return clean;
}
export function createMessageElement(messageData, shouldShowOutsideTimestamp = false) {
    if (messageData.uiVisible === false) { return null; }
        // 【新增防错】：强力拦截通话内部的过程对话，防止它们裸露在聊天主界面
    if (messageData.callId && messageData.contentType !== 'voice_call_summary') { return null; }
    // 【核心拦截】：如果是专注记录卡片，且当前正在处于【线下模式】，强行隐身，坚决不污染线下极简界面！
    if (messageData.contentType === 'focus_record_card' && tempState.activeOfflineSession === String(tempState.currentChatId)) { return null; }
    if (messageData.contentType === 'dream') {
        const centerWrapper = document.createElement('div');
        centerWrapper.dataset.messageId = String(messageData.id);
        centerWrapper.className = 'dream-card-center-wrapper';
        centerWrapper.style.cssText = 'display: flex; justify-content: center; width: 100%; margin: 15px 0; clear: both;';
        const dreamCard = document.createElement('div');
        dreamCard.dataset.messageId = String(messageData.id);
        dreamCard.className = 'message-dream-card';
        dreamCard.setAttribute('role', 'button');
        dreamCard.setAttribute('tabindex', '0');
        dreamCard.setAttribute('aria-expanded', 'false');
        const dreamText = String(messageData.text || '').trim();
        const dreamPreview = dreamText.replace(/\s+/g, ' ').slice(0, 72);
        const previewText = dreamPreview.length < dreamText.length ? `${dreamPreview}…` : dreamPreview;
        dreamCard.innerHTML = `
            <div class="dream-card-summary">
                <div class="dream-card-copy">
                    <div class="dream-card-kicker"><span>DREAM</span><i></i><span>01</span></div>
                    <div class="dream-card-title">Just a dream.</div>
                    <div class="dream-card-preview">${escapeHTML(previewText)}</div>
                    <button type="button" class="dream-card-toggle" aria-expanded="false">展开更多</button>
                </div>
                <div class="dream-card-image" aria-hidden="true"><img src="${escapeHTML(DREAM_CARD_IMAGE_SRC)}" alt="" draggable="false"></div>
            </div>
            <div class="dream-card-expanded" aria-hidden="true">
                <div class="dream-card-expanded-text">${escapeHTML(dreamText).replace(/\n/g, '<br>')}</div>
                <div class="dream-card-note">Just a dream.<br>仅为梦中碎片 · 不影响现实轨迹</div>
                <button type="button" class="dream-card-toggle dream-card-collapse-toggle" aria-expanded="false">收起</button>
            </div>
        `;
        centerWrapper.appendChild(dreamCard);
        return centerWrapper;
    }
    if (messageData.contentType === 'narration') {
        const narrationBubble = document.createElement('div');
        narrationBubble.dataset.messageId = String(messageData.id);
        narrationBubble.className = 'message-narration';
        narrationBubble.innerHTML = `
            <div class="message-narration-label">旁白</div>
            <div class="message-narration-text">${escapeHTML(messageData.text || '').replace(/\n/g, '<br>')}</div>
        `;
        return narrationBubble;
    }
     if (messageData.contentType === 'system_event') {
        const eventBubble = document.createElement('div');
        eventBubble.dataset.messageId = String(messageData.id);
        const displayText = messageData.shortText || messageData.text;
        
        // ▼▼▼ 新增：好友验证卡片特殊渲染 (文艺日杂风) ▼▼▼
        if (displayText.includes('开启了好友验证')) {
            eventBubble.className = 'friend-verification-wrapper';
            eventBubble.style.cssText = 'width: 100%; display: flex; justify-content: center; margin: 25px 0; clear: both;';
            
            const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            const avatarSrc = char ? (char.chatOverrideAvatar || char.avatar || DEFAULT_AVATAR_SRC) : DEFAULT_AVATAR_SRC;
            const charName = char ? (char.chatOverrideName || char.name) : 'Ta';
             eventBubble.innerHTML = `
                <div style="background: rgba(255, 255, 255, 0.9); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border-radius: 16px; padding: 16px; width: 240px; box-shadow: 0 8px 30px rgba(0,0,0,0.06); border: 1px solid rgba(230,230,230,0.8); text-align: center; position: relative; overflow: hidden; font-family: 'Helvetica Neue', sans-serif;">
                    <!-- 极简背景点缀 -->
                    <div style="position: absolute; top: -30px; left: -30px; width: 80px; height: 80px; background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%); border-radius: 50%; opacity: 0.3;"></div>
                    <div style="position: absolute; bottom: -20px; right: -20px; width: 60px; height: 60px; background: linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%); border-radius: 50%; opacity: 0.2;"></div>
                    
                    <img src="${avatarSrc}" style="width: 50px; height: 50px; border-radius: 50%; object-fit: cover; border: 2px solid #fff; box-shadow: 0 4px 10px rgba(0,0,0,0.08); margin-bottom: 8px; position: relative; z-index: 1;">
                    <div style="font-size: 15px; font-weight: 800; color: #2c2c2c; margin-bottom: 4px; position: relative; z-index: 1; letter-spacing: 0.5px;">${escapeHTML(charName)}</div>
                    <div style="font-size: 11px; color: #888; margin-bottom: 12px; line-height: 1.4; position: relative; z-index: 1;">已开启好友验证<br>你还不是他（她）的好友</div>
                    
                    <div class="verify-action-area" style="position: relative; z-index: 1;">
                        <button class="verify-apply-btn" style="background: #111; color: #fff; border: none; padding: 8px 24px; border-radius: 20px; font-size: 12px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.15); transition: transform 0.2s;">发送好友请求</button>
                        <div class="verify-input-area" style="display: none; flex-direction: column; gap: 8px;">
                            <input type="text" class="verify-input" placeholder="输入验证信息..." style="width: 100%; border: 1px solid #ddd; border-radius: 8px; padding: 8px; font-size: 12px; outline: none; box-sizing: border-box; font-family: inherit;">
                            <button class="verify-send-btn" style="background: #111; color: #fff; border: none; padding: 8px; border-radius: 8px; font-size: 12px; font-weight: bold; cursor: pointer;">发送</button>
                        </div>
                    </div>
                </div>
            `;
            
            const btn = eventBubble.querySelector('.verify-apply-btn');
            const inputArea = eventBubble.querySelector('.verify-input-area');
            const inputField = eventBubble.querySelector('.verify-input');
            const sendBtn = eventBubble.querySelector('.verify-send-btn');
            
            // 1. 点击按钮显示输入框
            btn.onclick = () => {
                btn.style.display = 'none';
                inputArea.style.display = 'flex';
                inputField.focus();
            };

            // 2. 填写完发送
            sendBtn.onclick = async () => {
                const val = inputField.value.trim();
                if (!val) {
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('请输入验证信息', 'warning');
                    return;
                }
                if (char) {
                    sendBtn.disabled = true;
                    try {
                        const request = await createOrUpdateFriendRequest(char, 'user_to_char', val, { source: BLOCK_APPEAL_USER_SOURCE });
                        inputArea.innerHTML = '<span style="font-size: 12px; color: #888; font-weight: bold;">已发送验证请求</span>';
                        window.renderNewFriendsPage?.();
                        window.dispatchEvent(new CustomEvent('looky:friend-request-updated', { detail: { charId: char.id } }));
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('好友申请已发出，等待 Ta 回复', 'success');
                        processBlockedByAiAppealUserRequest(char, request)
                            .then(() => {
                                window.renderNewFriendsPage?.();
                                window.dispatchEvent(new CustomEvent('looky:friend-request-updated', { detail: { charId: char.id } }));
                            })
                            .catch(error => console.warn('[FriendVerification] blocked appeal reply failed:', error));
                    } catch (error) {
                        console.error('[FriendVerification] create friend request failed:', error);
                        sendBtn.disabled = false;
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('好友申请发送失败，请重试', 'error');
                    }
                }
            };
            return eventBubble;
        }
        // ▲▲▲ 新增结束 ▲▲▲

        eventBubble.className = `message-system-event is-${messageData.eventType.replace('_', '-')}`;
        const displayText2 = messageData.shortText || messageData.text;
        eventBubble.innerHTML = `<span>${escapeHTML(displayText2)}</span>`;
        return eventBubble;
    }
    // 【核心修复】：为焦点陪伴卡片开白名单放行！让它能穿过系统防火墙显示在屏幕上，同时保留其 system 身份不污染大模型记忆
    if (messageData.type === 'system' && messageData.contentType !== 'focus_record_card') { return null; }
    if (!messageData.text && !messageData.stickerUrl && !messageData.recalled) { return null; }

    const messageWrapper = document.createElement('div');
    messageWrapper.dataset.messageId = String(messageData.id);
    if (messageData.recalled) {
        messageWrapper.className = 'message-wrapper recalled';
        const recallText = messageData.recallText || (messageData.type === 'sent' ? '你撤回了一条消息' : 'TA撤回了一条消息');
            messageWrapper.innerHTML = `<p class="recalled-text">${recallText}</p>`;
        messageWrapper.style.cursor = 'pointer';
        return messageWrapper;
    }

    // 【视觉伪装】：给焦点卡片套上 received (接收) 的外衣，这样它就会出现在屏幕左侧，并带上角色的真实头像
    let renderType = messageData.type;
    if (messageData.contentType === 'focus_record_card') renderType = 'received';
    messageWrapper.className = `message-wrapper ${renderType}`;
    
    let finalAvatarSrc = DEFAULT_AVATAR_SRC;
    const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
    const currentChatUser = getCurrentChatIdentity();
    let beautifyDisplayName = '';
    if (messageData.type === 'sent') {
        beautifyDisplayName = char?.chatOverrideUserNickname || currentChatUser?.name || '你';
    } else if (char && char.isGroup && messageData.speakerName) {
        beautifyDisplayName = messageData.speakerName;
    } else {
        beautifyDisplayName = char?.chatOverrideName || char?.name || '对方';
    }
    if (beautifyDisplayName) {
        messageWrapper.dataset.beautifyName = beautifyDisplayName;
    }
    const groupSpeakerKey = getGroupMessageSpeakerKey(messageData, char, currentChatUser);
    if (groupSpeakerKey) {
        messageWrapper.dataset.groupSpeakerKey = groupSpeakerKey;
    }
    if (messageData.type === 'sent') {
        if (char && char.chatOverrideUserAvatar) {
            finalAvatarSrc = char.chatOverrideUserAvatar;
        } else {
            finalAvatarSrc = currentChatUser?.avatar || DEFAULT_AVATAR_SRC;
        }
    } else { 
        // ▼▼▼ 修复：如果是群聊，且消息里带有群员头像，则优先使用群员自己的头像 ▼▼▼
        if (char && char.isGroup && (messageData.speakerId || messageData.speakerName)) {
            const member = findGroupParticipant(char, messageData.speakerId, messageData.speakerName);
            if (isValidAvatarSrc(messageData.avatarSrc)) {
                finalAvatarSrc = messageData.avatarSrc;
            } else if (member && isValidAvatarSrc(member.avatar)) {
                finalAvatarSrc = member.avatar;
            } else {
                finalAvatarSrc = char?.avatar || DEFAULT_AVATAR_SRC;
            }
        } else if (char && char.chatOverrideAvatar) {
            finalAvatarSrc = char.chatOverrideAvatar;

        } else {

            finalAvatarSrc = char?.avatar || DEFAULT_AVATAR_SRC;
        }
        // ▲▲▲ 修复结束 ▲▲▲
    }

    const avatar = document.createElement('img');
    avatar.className = 'chat-avatar-small';
    avatar.decoding = 'async'; 
    avatar.src = isValidAvatarSrc(finalAvatarSrc) ? finalAvatarSrc : DEFAULT_AVATAR_SRC;
    
    if (messageData.innerThoughts && messageData.type === 'received') {
        avatar.style.cursor = 'help';
        avatar.addEventListener('click', (e) => {
            e.stopPropagation();
            showInnerThoughts(messageData.innerThoughts);
        });
    }
     const bubble = createMessageBubble(messageData);
    if (!bubble) { return null; }
    if (beautifyDisplayName) {
        bubble.dataset.beautifyName = beautifyDisplayName;
    }

    // ▼▼▼ 拦截焦点卡片：丢弃头像和外框，强制全屏居中显示 ▼▼▼
    if (messageData.contentType === 'focus_record_card') {
        const centerWrapper = document.createElement('div');
        centerWrapper.dataset.messageId = String(messageData.id);
        centerWrapper.style.cssText = 'display: flex; justify-content: center; width: 100%; margin: 15px 0; clear: both;';
        centerWrapper.appendChild(bubble);
        return centerWrapper;
    }
    if (messageData.contentType === 'phone_npc_chat_card') {
        const centerWrapper = document.createElement('div');
        centerWrapper.dataset.messageId = String(messageData.id);
        centerWrapper.className = 'phone-npc-card-center-wrapper';
        centerWrapper.appendChild(bubble);
        return centerWrapper;
    }
    if (messageData.contentType === 'friend_request_card') {
        const centerWrapper = document.createElement('div');
        centerWrapper.dataset.messageId = String(messageData.id);
        centerWrapper.className = 'friend-request-card-center-wrapper';
        centerWrapper.appendChild(bubble);
        return centerWrapper;
    }
    if (messageData.contentType === 'char_interaction_card') {
        const centerWrapper = document.createElement('div');
        centerWrapper.dataset.messageId = String(messageData.id);
        centerWrapper.className = 'char-interaction-card-center-wrapper';
        centerWrapper.appendChild(bubble);
        return centerWrapper;
    }
    if (messageData.contentType === 'mcp_tool_card') {
        const centerWrapper = document.createElement('div');
        centerWrapper.dataset.messageId = String(messageData.id);
        centerWrapper.className = 'mcp-tool-card-center-wrapper';
        centerWrapper.appendChild(bubble);
        return centerWrapper;
    }
    if (messageData.contentType === 'forwarded_message') {
        const centerWrapper = document.createElement('div');
        centerWrapper.dataset.messageId = String(messageData.id);
        centerWrapper.className = 'forwarded-card-center-wrapper';
        centerWrapper.appendChild(bubble);
        return centerWrapper;
    }
    if (messageData.contentType === 'npc_chat_forward') {
        const centerWrapper = document.createElement('div');
        centerWrapper.dataset.messageId = String(messageData.id);
        centerWrapper.className = 'npc-chat-forward-center-wrapper';
        centerWrapper.appendChild(bubble);
        return centerWrapper;
    }
    if (messageData.contentType === 'chat_forward') {
        const centerWrapper = document.createElement('div');
        centerWrapper.dataset.messageId = String(messageData.id);
        centerWrapper.className = 'chat-forward-center-wrapper';
        centerWrapper.appendChild(bubble);
        return centerWrapper;
    }
    // ▲▲▲ 拦截结束 ▲▲▲

    // ▼▼▼ 修复：将名字、气泡放入列容器，并将群聊气泡打上特殊标记 ▼▼▼
    if (char && char.isGroup) {
        messageWrapper.classList.add('is-group-chat'); // 给外层打标签，方便SCSS上色
    }

    const contentCol = document.createElement('div');
    contentCol.style.display = 'flex';
    contentCol.style.flexDirection = 'column';
    contentCol.style.maxWidth = '100%';
    contentCol.style.alignItems = messageData.type === 'sent' ? 'flex-end' : 'flex-start';
    if (char && char.isGroup) {
        const namePlate = document.createElement('div');
        // 将样式交给 SCSS 管理，区分发送方和接收方
        namePlate.className = `group-message-nameplate ${messageData.type}`;
        const isUser = messageData.type === 'sent';
        const user = getCurrentChatIdentity();
        
        // 核心：动态判断该发信人的真实身份
        const currentOwnerId = char.ownerId || user?.id;
        let speakerId = isUser ? user?.id : messageData.speakerId;
        
        // 【关键容错】如果 speakerId 缺失、或是群聊本体ID，尝试根据名字匹配真正的群员ID
        if (!isUser && (!speakerId || String(speakerId) === String(char.id)) && messageData.speakerName) {
            const member = findGroupParticipant(char, null, messageData.speakerName);
            if (member) speakerId = member.id;
        }
        
        let roleStr = '群员';
        if (speakerId && String(speakerId) === String(currentOwnerId)) {
            roleStr = '群主';
        } else if (speakerId && (char.adminIds || []).map(String).includes(String(speakerId))) {
            roleStr = '管理员';
        }

        const nameStr = isUser ? (char.chatOverrideUserNickname || user?.name || '你') : (messageData.speakerName || '未知');

        // ▼▼▼ 修复：组合等级前缀和自定义称号 ▼▼▼
        const expKey = isUser ? 'user_self' : (messageData.speakerName || 'unknown');
        const currentExp = (char.membersExp && char.membersExp[expKey]) ? char.membersExp[expKey] : 0;
         // 等级换算公式优化：引入除数5，大幅减缓升级速度，拉开群员差距
        const calculatedLevel = Math.floor(Math.sqrt(currentExp / 5)) + 1;
        let levelNum = `LV${calculatedLevel}`;

        let levelText = '潜水';
        
        // 优先读取该角色是否被赐予了【专属头衔】
        const specialTitle = (char.specialTitles && speakerId && char.specialTitles[speakerId]) ? char.specialTitles[speakerId] : '';

        if (specialTitle) {
            levelText = specialTitle; // 如果有专属头衔，文字部分替换为专属头衔
        } else if (char.levelTitles) {
            const titlesArr = Object.values(char.levelTitles);
            if (titlesArr.length > 0) {
                // 根据身份拿不同的称号
                if (roleStr === '群主') {
                    levelText = titlesArr[titlesArr.length - 1] || '传说';
                } else if (roleStr === '管理员') {
                    levelText = titlesArr[Math.floor(titlesArr.length / 2)] || '管理';
                } else {
                    levelText = titlesArr[0] || '潜水';
                }
            }
        } else {
            if (roleStr === '群主') levelText = '群主';
            else if (roleStr === '管理员') levelText = '管理';
        }
        
        // 【修复 1】拼接等级与头衔，确保 LV 等级标识不会被吃掉
        const levelTitle = `${levelNum} ${levelText}`;

        // 【修复 2】去除多余的内联样式颜色，完全回归原本的类名控制，由原先的CSS接管颜色
        let roleClass = 'role-member';
        if (roleStr === '群主') roleClass = 'role-owner';
        else if (roleStr === '管理员') roleClass = 'role-admin';

        // 仅保留等级头衔块和名字 (用户发送时等级在右，别人发送时等级在左)
        if (isUser) {
            namePlate.innerHTML = `
                <span class="group-name">${escapeHTML(nameStr)}</span>
                <span class="group-level ${roleClass}">${escapeHTML(levelTitle)}</span>
            `;
        } else {
            namePlate.innerHTML = `
                <span class="group-level ${roleClass}">${escapeHTML(levelTitle)}</span>
                <span class="group-name">${escapeHTML(nameStr)}</span>
            `;
        }
        contentCol.appendChild(namePlate);

    }
    const bubbleContainer = document.createElement('div');
    bubbleContainer.className = 'bubble-container';
    if (messageData.timestamp) {
        const messageTimeDate = new Date(messageData.timestamp);
        if (!Number.isNaN(messageTimeDate.getTime())) {
            const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            const month = monthNames[messageTimeDate.getMonth()];
            const day = messageTimeDate.getDate();
            const hours = String(messageTimeDate.getHours()).padStart(2, '0');
            const minutes = String(messageTimeDate.getMinutes()).padStart(2, '0');
            bubbleContainer.dataset.messageTime = `${month} ${day}\n${hours}:${minutes}`;
        }
    }
    bubbleContainer.appendChild(bubble);

    // 【核心修复1】加一道安全锁！拦截实时发送时系统硬塞的错误时间戳显示指令
    const timeSettings = char?.timeSettings || {};
    if (shouldShowOutsideTimestamp && timeSettings.position === 'outside') {
        const timestampElement = document.createElement('span');
        timestampElement.className = 'message-timestamp-outside';
        const date = new Date(messageData.timestamp);
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        timestampElement.textContent = `${hours}:${minutes}`;
        bubbleContainer.appendChild(timestampElement);
    }
    // ▼▼▼ 新增：添加拒收感叹号 (纯净追加法，绝对不破坏原生排版) ▼▼▼
    if (messageData.isRejected) {
        const errorIcon = document.createElement('div');
        errorIcon.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#ff4d4f"></circle><line x1="12" y1="8" x2="12" y2="12" stroke="white" stroke-width="2" stroke-linecap="round"></line><circle cx="12" cy="16" r="1.5" fill="white"></circle></svg>`;
        // 增加 align-self: center 强制垂直中轴对齐，放大宽高到24
        errorIcon.style.cssText = 'display: flex; align-items: center; justify-content: center; margin-right: 8px; flex-shrink: 0; align-self: center;';
        bubbleContainer.appendChild(errorIcon);
    }
    // ▲▲▲ 新增结束 ▲▲▲
    contentCol.appendChild(bubbleContainer);
    messageWrapper.appendChild(avatar);
    messageWrapper.appendChild(contentCol);

    return messageWrapper;
    // ▲▲▲ 修复结束 ▲▲▲

}

export function createInteractiveMessageElement(messageData) {
    const element = createMessageElement(messageData);
    if (element) bindMessageEvents(element, messageData);
    return element;
}

export function createMessagePreviewElement(messageData, { interactive = false } = {}) {
    if (['system_event', 'narration', 'dream'].includes(messageData.contentType)) {
        const element = createMessageElement(messageData);
        if (element && interactive) bindFavoritePreviewInteractions(element, messageData);
        return element;
    }
    const bubble = createMessageBubble(messageData);
    if (!bubble) return null;
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper search-message-preview${interactive ? ' favorite-message-preview' : ''} ${messageData.type === 'sent' ? 'sent' : 'received'}`;
    wrapper.dataset.messageId = String(messageData.id);
    const bubbleContainer = document.createElement('div');
    bubbleContainer.className = 'bubble-container';
    bubbleContainer.appendChild(bubble);
    wrapper.appendChild(bubbleContainer);
    if (interactive) bindFavoritePreviewInteractions(wrapper, messageData);
    return wrapper;
}

export function createFavoriteMessageElement(messageData) {
    return createMessagePreviewElement(messageData, { interactive: true });
}

export async function replaceRenderedMessage(messageData) {
    const messageId = Number(messageData?.id || messageData?.messageId);
    if (!messageId) return;
    const oldElement = document.querySelector(`#chat-message-list [data-message-id="${messageId}"]`);
    if (!oldElement) return;
    const shouldShowOutsideTimestamp = Boolean(oldElement.querySelector('.message-timestamp-outside'));
    const nextElement = await Promise.resolve(createMessageElement(messageData, shouldShowOutsideTimestamp));
    if (!nextElement) {
        oldElement.remove();
        refreshGroupSpeakerContinuity();
        return;
    }
    bindMessageEvents(nextElement, messageData);
    oldElement.replaceWith(nextElement);
    refreshGroupSpeakerContinuity();
}

async function downloadChatImage(imageUrl, filename = 'ai-image.jpg') {
    if (!imageUrl) return;
    if (isNativeRuntime()) {
        try {
            const saved = await saveImageToNativeGallery(imageUrl, filename);
            showDynamicIsland(saved ? '图片已保存到系统相册' : '已取消保存');
        } catch (error) {
            console.warn('[ChatImage] 原生图片保存失败:', error);
            showDynamicIsland('图片保存失败，请检查手机剩余空间');
        }
        return;
    }
    const link = document.createElement('a');
    link.download = filename;
    let objectUrl = '';
    try {
        if (imageUrl.startsWith('data:')) {
            const blob = dataUrlToBlob(imageUrl);
            const appleShareResult = await shareBlobToApple(blob, filename);
            if (appleShareResult === 'shared' || appleShareResult === 'cancelled') return;
            if (isAppleMobile() && (appleShareResult === 'unavailable' || appleShareResult === 'failed')) {
                openImageForAppleSave(imageUrl);
                showDynamicIsland('请在打开的图片页面长按保存');
                return;
            }
            link.href = imageUrl;
        } else {
            const response = await fetch(imageUrl);
            if (!response.ok) throw new Error(`图片读取失败: ${response.status}`);
            const blob = await response.blob();
            const appleShareResult = await shareBlobToApple(blob, filename);
            if (appleShareResult === 'shared' || appleShareResult === 'cancelled') return;
            if (isAppleMobile() && (appleShareResult === 'unavailable' || appleShareResult === 'failed')) {
                openImageForAppleSave(imageUrl);
                showDynamicIsland('请在打开的图片页面长按保存');
                return;
            }
            objectUrl = URL.createObjectURL(blob);
            link.href = objectUrl;
        }
        document.body.appendChild(link);
        link.click();
        setTimeout(() => {
            link.remove();
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        }, 3000);
    } catch (error) {
        link.remove();
        if (isAppleMobile()) {
            openImageForAppleSave(imageUrl);
            showDynamicIsland('请在打开的图片页面长按保存');
            return;
        }
        window.open(imageUrl, '_blank');
    }
}

export function showChatImageViewer(messageData, options = {}) {
    if (!messageData?.stickerUrl) return;
    const overlay = document.createElement('div');
    overlay.className = 'chat-image-viewer';
    const description = messageData.imageAiDescription || 'Generated image';
    const galleryKeywords = String(messageData.generationKeywords || '').trim();
    const galleryContent = galleryKeywords || messageData.imageAiDescription || '';
    const galleryCharId = resolveGalleryCharacterIdForMessage(messageData);
    const canSave = options.allowSave !== false
        && Boolean(messageData.isAiGenerated && !messageData.savedToGallery)
        && galleryCharId !== null
        && galleryCharId !== undefined;
    const canRegenerate = Boolean(messageData.id && messageData.isAiGenerated && messageData.imageGenerationPayload);
    overlay.innerHTML = `
        <div class="chat-image-viewer-panel">
            <div class="chat-image-viewer-top">
                <div class="chat-image-viewer-heading">
                    <strong>图片预览</strong>
                    <span>IMAGE VIEW</span>
                </div>
                <button type="button" data-action="close" aria-label="关闭图片预览">关闭</button>
            </div>
            <div class="chat-image-viewer-frame">
                <img src="${messageData.stickerUrl}" alt="chat image">
            </div>
            <div class="chat-image-viewer-meta">
                <div class="chat-image-viewer-meta-title">
                    <strong>图片描述</strong>
                    <span>DESCRIPTION</span>
                </div>
                <div class="chat-image-viewer-description">
                    <p>${escapeHTML(description)}</p>
                </div>
            </div>
            <div class="chat-image-viewer-actions">
                ${canRegenerate ? '<button type="button" data-action="regenerate">重新生成</button>' : ''}
                <button type="button" data-action="download">下载图片</button>
                ${canSave ? '<button type="button" data-action="save">保存到相册</button>' : ''}
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', async event => {
        const action = event.target?.dataset?.action;
        if (event.target === overlay || action === 'close') {
            overlay.remove();
        } else if (action === 'download') {
            await downloadChatImage(messageData.stickerUrl, `chat-image-${messageData.id || Date.now()}.jpg`);
        } else if (action === 'regenerate') {
            overlay.remove();
            await retryAiImageGeneration(Number(messageData.id));
        } else if (action === 'save') {
            await saveGeneratedImageToGallery({
                imageUrl: messageData.stickerUrl,
                charId: galleryCharId,
                content: galleryContent,
                keywords: galleryKeywords
            });
            await db.chatMessages.update(Number(messageData.id), { savedToGallery: true });
            messageData.savedToGallery = true;
            const historyItem = AppState.currentChatHistory?.find(item => Number(item.id) === Number(messageData.id));
            if (historyItem) historyItem.savedToGallery = true;
            event.target.textContent = '已保存';
            event.target.disabled = true;
            showDynamicIsland('已存入相册');
        }
    });
}

function createSimplifiedMessageElementForCall(messageData) {
    if (messageData.uiVisible === false || messageData.type === 'system' || messageData.recalled) {
        return null;
    }

    const messageWrapper = document.createElement('div');
    messageWrapper.dataset.messageId = String(messageData.id);
    const voiceDescription = typeof messageData.voiceDescription === 'string'
        ? messageData.voiceDescription.replace(/[\r\n]+/g, ' ').trim().slice(0, 240)
        : '';
    messageWrapper.className = `message-wrapper in-call-history ${messageData.type}${voiceDescription ? ' has-voice-description' : ''}`;

    let finalAvatarSrc = DEFAULT_AVATAR_SRC;
    const character = AppState.characterProfiles.find(c => String(c.id) === String(messageData.chatId || tempState.currentChatId));

    if (messageData.type === 'sent') {
        const user = AppState.userIdentities.find(identity => String(identity.id) === String(messageData.callIdentityId))
            || getCurrentChatIdentity(messageData.chatId);
        finalAvatarSrc = character?.chatOverrideUserAvatar || user?.avatar || DEFAULT_AVATAR_SRC;
    } else {
        // ▼▼▼ 【修复：精准提取群聊成员头像】 ▼▼▼
        if (character && character.isGroup) {
            const groupSpeakerProfile = findGroupParticipant(character, messageData.speakerId, messageData.speakerName);
            finalAvatarSrc = isValidAvatarSrc(messageData.avatarSrc)
                ? messageData.avatarSrc
                : groupSpeakerProfile?.avatar || character?.avatar || DEFAULT_AVATAR_SRC;
        } else {
            const speakerProfile = messageData.speakerId ? findCharacterById(messageData.speakerId) : null;
            finalAvatarSrc = speakerProfile?.chatOverrideAvatar || speakerProfile?.avatar || character?.chatOverrideAvatar || character?.avatar || DEFAULT_AVATAR_SRC;
        }
        // ▲▲▲ 修复结束 ▲▲▲
    }

    const avatar = document.createElement('img');
    avatar.className = 'chat-avatar-small';
    avatar.src = isValidAvatarSrc(finalAvatarSrc) ? finalAvatarSrc : DEFAULT_AVATAR_SRC;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    const bubbleText = document.createElement('p');
    const cleanText = cleanVisibleMessageText(messageData.text);
    bubbleText.innerHTML = escapeHTML(cleanText).replace(/\n/g, '<br>');
    bubble.appendChild(bubbleText);
    if (messageData.translation) {
        const transDiv = document.createElement('div');
        transDiv.className = getTranslationClassName(messageData);
        transDiv.innerHTML = escapeHTML(messageData.translation).replace(/\n/g, '<br>');
        bubble.appendChild(transDiv);
    }

    // ▼▼▼ 【严谨版】仅在群聊中，且为对方发的消息时，把头像缩小并挂在气泡右下角 ▼▼▼
    if (messageData.type === 'received' && character && character.isGroup) {
        avatar.style.display = 'block'; 
        avatar.style.position = 'absolute';
        avatar.style.bottom = '-8px';
        avatar.style.right = '-8px';
        avatar.style.width = '24px';
        avatar.style.height = '24px';
        avatar.style.borderRadius = '50%';
        avatar.style.border = '2px solid rgba(255, 255, 255, 0.2)';
        avatar.style.boxShadow = '0 2px 5px rgba(0,0,0,0.3)';
        avatar.style.objectFit = 'cover'; 
        avatar.style.zIndex = '999';      // 【关键修复】设为最高层级，绝对盖在气泡右下角上方

        bubble.style.position = 'relative';
        bubble.style.overflow = 'visible'; // 破除结界！防止气泡把悬挂在外面的头像切掉
        bubble.appendChild(avatar); 
        messageWrapper.appendChild(bubble);
    } else {
        // 单聊，或者用户自己发的消息，走正常的渲染逻辑
        messageWrapper.appendChild(avatar);
        messageWrapper.appendChild(bubble);
    }
    if (voiceDescription) {
        const descriptionBox = document.createElement('div');
        descriptionBox.className = 'voice-call-description';
        descriptionBox.textContent = voiceDescription;
        messageWrapper.appendChild(descriptionBox);
    }
    // ▲▲▲ 修改结束 ▲▲▲

    return messageWrapper;
}

const TEN_MINUTES_IN_MS = 10 * 60 * 1000; // 10分钟对应的毫秒数
/**
 * [已修正] 格式化时间戳的函数
 * @param {number} timestamp - 时间戳
 * @param {string} style - 想要的样式 ('pill-center' 或 'simple-center')
 * @returns {string} - 格式化好的HTML字符串或纯文本
 */
function formatTimestampForDisplay(timestamp, style) {
    const date = new Date(timestamp);
    
    if (style === 'pill-center') {
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const day = date.getDate();
        const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const weekday = weekdays[date.getDay()];
        const calendarIcon = `<svg class="timestamp-icon" viewBox="0 0 1024 1024"><path d="M797.9 129.7h-95.8V64h-128v65.7H449.9V64h-128v65.7H226.1c-35.2 0-63.8 28.6-63.8 63.8v699.2c0 35.2 28.6 63.8 63.8 63.8h571.8c35.2 0 63.8-28.6 63.8-63.8V193.5c0-35.2-28.6-63.8-63.8-63.8z m0 763H226.1V321.4h571.8v571.3z" fill="currentColor"></path></svg>`;
        return `${calendarIcon} ${year}年 ${month}月${day}日 ${weekday}`;
    }
    
    if (style === 'simple-center') {
        const hours = date.getHours();
        const minutes = String(date.getMinutes()).padStart(2, '0');
        let period;
        // 根据小时数判断是凌晨、上午、下午还是晚上
        if (hours >= 0 && hours < 6) {
            period = '凌晨';
        } else if (hours >= 6 && hours < 12) {
            period = '上午';
        } else if (hours >= 12 && hours < 18) {
            period = '下午';
        } else {
            period = '晚上';
        }
        // 12小时制显示
        const displayHours = hours % 12 === 0 ? 12 : hours % 12;
        return `${period} ${displayHours}:${minutes}`;
    }
    // 如果样式未知，返回一个空字符串
    return '';
}

export async function createAndAppendMessage(messageData, shouldScroll = true) {
    // -----------------------------------------------------------------------
    // 第一步：获取双方身份ID
    // -----------------------------------------------------------------------
    const incomingChatId = messageData.chatId;
    const currentScreenChatId = tempState.currentChatId;
    if (messageData.type === 'sent' && messageData.uiVisible !== false && !messageData.recalled) {
        const senderChat = AppState.characterProfiles.find(c => String(c.id) === String(incomingChatId));
        if (senderChat) {
            await clearFollowUpPlan(senderChat.id);
        }
    }

    // -----------------------------------------------------------------------
    // 第二步：打印调试日志 (请在控制台查看)
    // -----------------------------------------------------------------------
    // 如果你发现控制台打印了 "【拦截成功】"，但页面还是有消息，说明有另一个函数在画消息。
    // 如果你发现打印了 "【放行】"，但明明是别人的消息，说明 messageData.chatId 数据本身错了。
    // -----------------------------------------------------------------------
    /* 
    console.log(`[消息分流检查]`, {
        '消息所属角色ID': incomingChatId,
        '当前屏幕角色ID': currentScreenChatId,
        '是否匹配': String(incomingChatId) === String(currentScreenChatId),
        '消息内容': messageData.text
    });
    */
    // 第三步：通话消息特殊拦截 (保持原样，优先级最高)
    // -----------------------------------------------------------------------
    if (messageData.callId && messageData.contentType !== 'voice_call_summary') {
        const isCurrentVoiceCall =
            tempState.activeCallMode === 'voice' &&
            tempState.currentCallId &&
            String(messageData.callId) === String(tempState.currentCallId) &&
            (!tempState.activeCallChatId || String(messageData.chatId) === String(tempState.activeCallChatId));

        // 只有“当前正在进行的语音通话”才继续渲染到通话小窗；
        // 其他历史通话消息仍然不进普通聊天区，避免格式乱掉。
        if (isCurrentVoiceCall) {
            hideTypingIndicator();
            const simplifiedElement = createSimplifiedMessageElementForCall(messageData);
            if (simplifiedElement) {
                const voiceCallList = document.getElementById('voice-call-message-list');
                if (voiceCallList) {
                    bindVoiceCallMessageEvents(simplifiedElement, messageData);
                    voiceCallList.appendChild(simplifiedElement);
                    voiceCallList.scrollTop = voiceCallList.scrollHeight;
                }
            }
        }
        return; // 通话消息处理完直接结束，不往下走
    }

    // -----------------------------------------------------------------------
    // 第四步：播放提示音 (这是全局功能，不管在不在当前页面都要响)
    // -----------------------------------------------------------------------
    const character = AppState.characterProfiles.find(c => String(c.id) === String(incomingChatId));
    if (messageData.type === 'received' && !messageData.recalled && messageData.contentType !== 'mcp_tool_card') {
        if (shouldPlayIncomingNotificationSound(character, incomingChatId)) {
            const soundSrc = character.notificationSoundSrc || DEFAULT_NOTIFICATION_SRC;
            window.playNotificationSound(soundSrc); 
        }
    }
  if (!currentScreenChatId || String(incomingChatId) !== String(currentScreenChatId)) {
        // 如果消息不是给当前屏幕的角色的...
        // 1. 检查这个角色的“暂存柜”是否存在，不存在就创建一个
        if (!chatState.pendingMessageQueue.has(incomingChatId)) {
            chatState.pendingMessageQueue.set(incomingChatId, []);
        }
        
        // 2. 把这条消息放进它的专属“暂存柜”里
        chatState.pendingMessageQueue.get(incomingChatId).push(messageData);
        
        // 3. 在控制台打印日志，方便我们调试
        console.log(`[消息暂存] 消息 (ID: ${messageData.id}) 已为角色 ${incomingChatId} 暂存。队列长度: ${chatState.pendingMessageQueue.get(incomingChatId).length}`);
        
        // ▼▼▼ 【核心修复2】即使在后台暂存，也要更新外面的侧边栏！ ▼▼▼
        updateSidebarPreview(incomingChatId, messageData);
        
        // 4. 任务完成，返回。不再继续执行后面的渲染逻辑。
        return; 
    }
// ▼▼▼【新增的第六步：渲染锁检查】▼▼▼
    if (tempState.isRenderingHistory) {
        // 如果门卫正在忙（历史记录正在渲染），就把这条消息也丢进暂存柜
        if (!chatState.pendingMessageQueue.has(incomingChatId)) {
            chatState.pendingMessageQueue.set(incomingChatId, []);
        }
        chatState.pendingMessageQueue.get(incomingChatId).push(messageData);
        console.log(`[渲染锁] 历史记录渲染繁忙，消息 (ID: ${messageData.id}) 已暂存。`);
        
        // ▼▼▼ 【核心修复3】渲染锁拦截时也要更新侧边栏！ ▼▼▼
        updateSidebarPreview(incomingChatId, messageData);
        
        return; // 立刻返回，不进行渲染
    }
    // ▼▼▼ 新增：群聊经验值无感累加引擎 (0.1微量加分版) ▼▼▼
    if (character && character.isGroup && messageData.contentType !== 'narration' && (messageData.type === 'sent' || messageData.type === 'received') && !messageData.recalled) {
        if (!character.membersExp) character.membersExp = {};
        // 区分用户和AI的唯一键名
        const expKey = messageData.type === 'sent' ? 'user_self' : (messageData.speakerName || 'unknown');
        
        let addExp = 0.1; // 基础分 0.1
        if (messageData.text) {
            // 字数加成：每10个字加0.05，封顶加0.3
            addExp += Math.min(0.3, Math.floor(messageData.text.length / 10) * 0.05); 
        }
        // 媒体和互动加成 0.1
        if (['photo', 'sticker', 'transfer', 'voice', 'html_snippet'].includes(messageData.contentType)) addExp += 0.1; 
        // 10%概率触发小暴击 (得分 x 1.5)，制造群员间的自然差异
        if (Math.random() < 0.1) addExp *= 1.5; 
        
        // 累加并存入角色档案
        character.membersExp[expKey] = (character.membersExp[expKey] || 0) + addExp;
        db.characterProfiles.update(character.id, { membersExp: character.membersExp }); // 异步静默保存，绝不卡顿UI
    }
   

    const timeSettings = character?.timeSettings || {};

    // 1. 处理上一条消息的时间戳 (outside模式)
    if (timeSettings.position === 'outside' && timeSettings.outsideMode === 'last') {
         // ▼▼▼ 无损性能优化：直接从列表最末尾往前找，不再全局扫描，O(1) 极速匹配 ▼▼▼
        let lastMessageWrapper = chatMessageList.lastElementChild;
        while (lastMessageWrapper) {
            if (lastMessageWrapper.classList.contains('message-wrapper') && 
                !lastMessageWrapper.classList.contains('recalled') && 
                !lastMessageWrapper.classList.contains('message-system-event')) {
                break;
            }
            lastMessageWrapper = lastMessageWrapper.previousElementSibling;
        }
        // ▲▲▲ 优化结束 ▲▲▲
        if (lastMessageWrapper) {
            const lastMessageType = lastMessageWrapper.classList.contains('sent') ? 'sent' : 'received';
            if (lastMessageType === messageData.type) {
                const oldTimestamp = lastMessageWrapper.querySelector('.message-timestamp-outside');
                if (oldTimestamp) {
                    oldTimestamp.remove();
                }
            }
        }
    }

    // 2. 计算并插入新的时间戳
    const lastMessageInHistory = [...AppState.currentChatHistory]
        .reverse()
        .find(msg => msg.type === 'sent' || msg.type === 'received' || msg.contentType === 'voice_call_summary');
    
    let shouldShowEventTimestamp = false;
    let shouldStartTimer = false;
    
    if (!lastMessageInHistory) {
        shouldShowEventTimestamp = true;
        shouldStartTimer = true;
    } else if (timeSettings) {
        const newConversationThresholdMinutes = timeSettings.newConversationThreshold || 10;
        const newConversationThresholdMs = newConversationThresholdMinutes * 60 * 1000;
        const newMessageTimestamp = new Date(messageData.timestamp).getTime();
        const lastMessageTimestamp = new Date(lastMessageInHistory.timestamp).getTime();
        const timeDiff = newMessageTimestamp - lastMessageTimestamp;
        if (timeDiff >= newConversationThresholdMs) {
            shouldShowEventTimestamp = true;
            shouldStartTimer = true;
        }
    }
    
    if (shouldShowEventTimestamp && timeSettings.position === 'center') {
        const timestampElement = createTimestampElement(messageData.timestamp);
        if (timestampElement) chatMessageList.appendChild(timestampElement);
    }
    
    if (shouldStartTimer) {
       startInConversationTimestampTimer(incomingChatId);
    }
    
    let shouldShowOutsideTimestampForNewMessage = false;
    if (timeSettings.position === 'outside') {
        shouldShowOutsideTimestampForNewMessage = true; 
    }
    
    // 3. 更新内存中的历史记录
    if (!AppState.currentChatHistory.find(m => m.id === messageData.id)) {
        AppState.currentChatHistory.push(messageData);
    }
     // 4. 创建并显示消息气泡 (DOM操作)
   // 这是【新的】调用方式
    const fullMessageElement = await Promise.resolve(createMessageElement(messageData, shouldShowOutsideTimestampForNewMessage));

    if (fullMessageElement) {
        bindMessageEvents(fullMessageElement, messageData);
        fullMessageElement.classList.add('message-entry-animate');
         // 【修复闪退】将渲染过程包裹在 Promise 中...
        await new Promise((resolve) => {
            
            // 1. 我们先把要把消息“贴上墙”的任务打包成一个函数
            const executeRender = () => {
                // 🛡️【核心修复】二次安检：如果发现你已经切到别的房间了，这封信就立刻销毁
                if (String(tempState.currentChatId) !== String(incomingChatId)) {
                    console.log(`[UI防御] 拦截了一次渲染串台：信件属于 ${incomingChatId}，但当前屏幕是 ${tempState.currentChatId}`);
                    resolve(); 
                    return;    
                }

                // 通过二次安检，安全上墙
                chatMessageList.appendChild(fullMessageElement);
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        fullMessageElement.classList.remove('message-entry-animate');
                    });
                });
                refreshGroupSpeakerContinuity();
                resyncChatFontSizing();
                
                // 将滚动操作推迟
                setTimeout(() => {
                    if (shouldScroll && String(tempState.currentChatId) === String(incomingChatId)) {
                        scheduleChatMessageScrollToBottom();
                    }
                    // 【关键修复2】侧边栏更新在后台也不能用动画帧，统一改用 setTimeout
                    setTimeout(() => updateSidebarPreview(incomingChatId, messageData), 10);
                    
                    resolve(); // 这里放行了，后面的弹窗雷达代码才能继续执行！
                }, 32);
            };

            // ▼▼▼ 【核心破局点】：判断手机是否在后台 ▼▼▼
            if (document.visibilityState === 'hidden') {
                // 情况A：如果手机切到了后台，绝对不能用 requestAnimationFrame（会被冻结卡死）
                // 直接使用 setTimeout 强行无视动画机制，光速推进主线任务，去触发下一步的系统弹窗！
                setTimeout(executeRender, 10);
                console.log("[后台急救] 检测到应用在后台，跳过动画缓冲，强行执行渲染以保证弹窗不被卡死！");
            } else {
                // 情况B：如果在前台，为了苹果手机防闪退，继续使用双重动画帧排队
                requestAnimationFrame(() => {
                    requestAnimationFrame(executeRender);
                });
            }
            // ▲▲▲ 核心修改结束 ▲▲▲
        });

    }

    // 5. TTS 自动朗读

    if (messageData.type === 'received' && AppState.ttsGlobalSettings.autoPlay && !messageData.recalled && !isChatInActiveCall(messageData.chatId)) {
        const isReadableText = (
            !messageData.contentType || 
            messageData.contentType === 'text' || 
            messageData.contentType === 'voice' 
        );
        if (isReadableText && messageData.text) {
             // console.log(`[TTS Trigger] 自动播放消息: "${messageData.text}"`);
            const targetSpeakerId = messageData.speakerId || tempState.currentChatId; // 直接读取身份，极速且精准
             await TTSService.speakForCharacter(messageData.text, targetSpeakerId, { emotion: messageData.ttsEmotion });
        }
    }
}

function parseMcpEmbeddedJsonText(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    if (!/^[\[{]/.test(trimmed)) return value;
    try { return JSON.parse(trimmed); } catch (error) { return value; }
}

function compactMcpCardValue(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return parseMcpEmbeddedJsonText(value);
    if (Array.isArray(value)) return value.map(item => compactMcpCardValue(item));
    if (typeof value !== 'object') return value;
    const output = {};
    Object.entries(value).forEach(([key, item]) => {
        output[key] = /(authorization|api[-_]?key|token|secret|password|cookie)/i.test(key)
            ? '[已隐藏]'
            : compactMcpCardValue(item);
    });
    return output;
}

function stringifyMcpCardValue(value) {
    const preview = compactMcpCardValue(value);
    if (typeof preview === 'string') return preview;
    try { return JSON.stringify(preview ?? '', null, 2); } catch (error) { return '[内容无法显示]'; }
}

let mcpToolCardDialogEventsBound = false;

function closeMcpToolDialog(overlay) {
    if (!overlay) return;
    overlay.classList.remove('visible');
    setTimeout(() => overlay.remove(), 180);
}

function ensureMcpToolCardDialogEvents() {
    if (mcpToolCardDialogEventsBound) return;
    mcpToolCardDialogEventsBound = true;
    document.addEventListener('click', event => {
        const opener = event.target.closest('[data-mcp-card-open]');
        if (opener) {
            const card = opener.closest('.mcp-tool-card-standalone');
            const source = card?.querySelector('.mcp-tool-chat-dialog-source');
            if (!source) return;
            document.querySelector('.mcp-tool-dialog-overlay')?.remove();
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay mcp-tool-dialog-overlay';
            overlay.innerHTML = `
                <section class="mcp-tool-dialog" role="dialog" aria-modal="true" aria-label="MCP 调用详情">
                    <header><div><span>MCP ACTIVITY</span><h3>${escapeHTML(opener.dataset.mcpDialogTitle || 'MCP 调用详情')}</h3></div><button type="button" data-mcp-dialog-close aria-label="关闭">×</button></header>
                    <div class="mcp-tool-chat-body">${source.innerHTML}</div>
                </section>
            `;
            document.body.appendChild(overlay);
            requestAnimationFrame(() => {
                overlay.classList.add('visible');
                overlay.querySelector('[data-mcp-dialog-close]')?.focus();
            });
            return;
        }
        const overlay = event.target.closest('.mcp-tool-dialog-overlay');
        if (overlay && (event.target === overlay || event.target.closest('[data-mcp-dialog-close]'))) closeMcpToolDialog(overlay);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeMcpToolDialog(document.querySelector('.mcp-tool-dialog-overlay'));
    });
}

function renderMcpToolCard(messageData) {
    ensureMcpToolCardDialogEvents();
    const records = Array.isArray(messageData.mcpToolRecords) ? messageData.mcpToolRecords : [];
    const first = records[0] || {};
    const statusLabels = { loading: '执行中', success: '成功', failed: '失败', rejected: '已拒绝' };
    const summaryText = records.length
        ? `使用了 ${first.sourceName || 'MCP 工具'} · ${first.action || first.toolName || '调用工具'}${records.length > 1 ? ` · 另 ${records.length - 1} 项` : ''}`
        : 'MCP 工具调用';
    const recordHtml = records.map((record, index) => {
        const status = ['loading', 'success', 'failed', 'rejected'].includes(record.status) ? record.status : 'failed';
        const argsText = stringifyMcpCardValue(record.args || {});
        const resultText = stringifyMcpCardValue(record.result ?? record.summary ?? '');
        return `
            <article class="mcp-tool-record is-${status}">
                <div class="mcp-tool-record-head">
                    <span>${String(index + 1).padStart(2, '0')}</span>
                    <div><strong>${escapeHTML(record.toolName || '未知工具')}</strong><small>${escapeHTML(record.sourceName || '未知来源')}</small></div>
                    <em>${statusLabels[status]}</em>
                </div>
                <div class="mcp-tool-record-block"><span>PARAMETERS</span><pre>${escapeHTML(argsText)}</pre></div>
                <div class="mcp-tool-record-block"><span>RESULT</span><pre>${escapeHTML(resultText)}</pre></div>
                <div class="mcp-tool-record-time">${status === 'loading' ? '正在等待工具返回' : `耗时 ${Number(record.durationMs) || 0} ms`}</div>
            </article>
        `;
    }).join('');
    return `
        <button type="button" class="mcp-tool-chat-card" data-mcp-card-open data-mcp-dialog-title="${escapeHTML(summaryText)}" aria-haspopup="dialog">
            <span class="mcp-tool-chat-icon" aria-hidden="true">M</span>
            <span class="mcp-tool-chat-summary"><strong>${escapeHTML(summaryText)}</strong><small>点击查看调用详情</small></span>
            <span class="mcp-tool-chat-chevron" aria-hidden="true">›</span>
        </button>
        <div class="mcp-tool-chat-dialog-source" hidden>${recordHtml || '<p>暂无调用记录</p>'}</div>
    `;
}

 function createMessageBubble(messageData) {
    const bubble = document.createElement('div');
    const hasStickerUrl = !!messageData.stickerUrl;
    const isGalleryImage = hasStickerUrl && messageData.text === '[图片]';
    const isSticker = hasStickerUrl && !isGalleryImage;
    const isPhotoDescription = !hasStickerUrl
        && typeof messageData.text === 'string'
        && messageData.text.startsWith('[拍摄]');
    const isLocation = messageData.contentType === 'location';
    const isTransfer = messageData.contentType === 'transfer' || messageData.contentType === 'transfer_receipt';
    const isVoice = messageData.contentType === 'voice';
    const isVoiceCallSummary = messageData.contentType === 'voice_call_summary';
    const isVoiceCallRejected = messageData.contentType === 'voice_call_rejected';
    const isMomentCard = messageData.contentType === 'moment_card';
    const isHtmlSnippet = messageData.contentType === 'html_snippet';
    const isOfflineInvite = messageData.contentType === 'offline_invite';
    const isReceipt = messageData.contentType === 'receipt';
    const isBoardingPass = messageData.contentType === 'boarding_pass';
    const isPayRequest = messageData.contentType === 'pay_request'; 
    const isProductShare = messageData.contentType === 'product_share';
    const isProductCommand = messageData.contentType === 'product_share_command';
    const isLogistics = messageData.contentType === 'logistics_card';
    const isPasswordCard = messageData.contentType === 'share_password';
    const isMusicShare = messageData.contentType === 'music_share';
    const isPlaylistShare = messageData.contentType === 'playlist_share';
    const isPlaylistInvite = messageData.contentType === 'playlist_invite';
    const isForumPostCard = messageData.contentType === 'forum_post_card';
    const isMusicInvite = messageData.contentType === 'music_invite'; // <--- 新增
    const isSpaceInvite = messageData.contentType === 'space_invite' || (messageData.text && messageData.text.includes('我想和你开启专属空间')); 
    const isJointFundInvite = messageData.contentType === 'joint_fund_invite';
    const isVaultTransferCard = messageData.contentType === 'vault_transfer_card' || (messageData.contentType === 'transfer' && messageData.transferInfo?.sourceFund === 'vault');
    const isVaultRequestCard = messageData.contentType === 'vault_request_card';
    const isRedPacket = messageData.contentType === 'red_packet';
    const isFocusCard = messageData.contentType === 'focus_record_card'; // <--- 新增焦点卡片判断
    const isPhoneNpcChatCard = messageData.contentType === 'phone_npc_chat_card';
    const isFriendRequestCard = messageData.contentType === 'friend_request_card';
    const isImageGenerating = messageData.contentType === 'image_generating';
    const isForwardedMessage = messageData.contentType === 'forwarded_message';
    const isNpcChatForward = messageData.contentType === 'npc_chat_forward';
    const isChatForward = messageData.contentType === 'chat_forward';
    const isCharInteractionCard = messageData.contentType === 'char_interaction_card';
    const isMcpToolCard = messageData.contentType === 'mcp_tool_card';
    if (isMcpToolCard) {
        bubble.className = 'mcp-tool-card-standalone';
        bubble.innerHTML = renderMcpToolCard(messageData);
        return bubble;
    }
    if (isImageGenerating) {
        const status = messageData.imageGenerationStatus || 'loading';
        const isLoading = status === 'loading';
        const isError = status === 'error';
        const title = isLoading ? '生成中...' : (status === 'stopped' ? '已停止' : '生成失败');
        const detail = isError
            ? (messageData.imageGenerationError || '图片生成失败，请重试')
            : (messageData.imageGenerationPayload?.description || messageData.text || '');
        bubble.className = `message-bubble image-generating-card is-${status}`;
        bubble.innerHTML = `
            <div class="image-gen-card-inline">
                <div class="image-gen-card-head">
                    <div class="image-gen-card-spinner" aria-hidden="true"></div>
                    <div class="image-gen-card-title">
                        <strong>${escapeHTML(title)}</strong>
                        <span>AI IMAGE</span>
                    </div>
                </div>
                <div class="image-gen-card-prompt">
                    <span>画面描述</span>
                    <p>${escapeHTML(detail)}</p>
                </div>
                <div class="image-gen-card-actions">
                    <button type="button" data-image-gen-action="retry">重试</button>
                    ${isLoading ? '<button type="button" data-image-gen-action="stop">停止</button>' : ''}
                </div>
            </div>
        `;
        return bubble;
    }
    if (isForwardedMessage) {
        const fd = messageData.forwardedData || {};
        const forwardedItems = getForwardedRecordItems(fd);
        const previewLines = forwardedItems.slice(0, 3).map(item => {
            const label = getForwardedMessageLabel({
                text: item.originalText,
                contentType: item.originalContentType,
                stickerUrl: item.originalStickerUrl
            });
            return `${item.originalSenderName || '未知'}: ${truncateForwardedPreview(label, 24)}`;
        });
        bubble.className = 'forwarded-card-standalone';
        bubble.innerHTML = `
            <h4>
                <span class="forwarded-card-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M5 12h13"></path>
                        <path d="m13 6 6 6-6 6"></path>
                    </svg>
                </span>
                <span>${escapeHTML(fd.recordTitle || '聊天记录')}</span>
            </h4>
            <div class="forwarded-card-lines">
                ${previewLines.map(line => `<div class="forwarded-card-line">${escapeHTML(line)}</div>`).join('')}
            </div>
            <div class="forwarded-card-footer">聊天记录</div>
        `;
        return bubble;
    }
    if (isChatForward) {
        const fd = messageData.chatForwardData || {};
        const messages = Array.isArray(fd.messages) ? fd.messages : [];
        const previewLines = messages.slice(0, 3).map(item => {
            const label = getForwardedMessageLabel({
                text: item.text,
                contentType: item.contentType,
                stickerUrl: item.stickerUrl
            });
            return `<div class="npc-fw-card-line"><strong>${escapeHTML(item.speakerName || '未知')}</strong><span>${escapeHTML(truncateForwardedPreview(label, 24))}</span></div>`;
        }).join('');
        const sourceTypeLabel = fd.sourceType === 'group' ? '群聊' : '单聊';
        bubble.className = 'chat-forward-card';
        bubble.innerHTML = `
            <div class="npc-fw-card-heading">
                <span class="npc-fw-card-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M5 12h13"></path>
                        <path d="m13 6 6 6-6 6"></path>
                    </svg>
                </span>
                <span>聊天记录</span>
            </div>
            <div class="npc-fw-card-body">${previewLines}</div>
            <div class="npc-fw-card-footer">
                <span>${escapeHTML(fd.sourceName || '聊天记录')} · ${sourceTypeLabel}</span>
                <span>${messages.length}条记录</span>
            </div>
        `;
        return bubble;
    }
    if (isNpcChatForward) {
        const fd = messageData.npcChatForwardData || {};
        const messages = Array.isArray(fd.messages) ? fd.messages : [];
        const previewLines = messages.slice(0, 3).map(item => {
            const speaker = item.isChar ? (fd.charName || '角色') : (fd.npcName || 'NPC');
            const label = getForwardedMessageLabel({
                text: item.text,
                contentType: item.contentType,
                stickerUrl: item.stickerUrl
            });
            return `<div class="npc-fw-card-line"><strong>${escapeHTML(speaker)}</strong><span>${escapeHTML(truncateForwardedPreview(label, 24))}</span></div>`;
        }).join('');
        bubble.className = 'npc-chat-forward-card';
        bubble.innerHTML = `
            <div class="npc-fw-card-heading">
                <span class="npc-fw-card-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M5 12h13"></path>
                        <path d="m13 6 6 6-6 6"></path>
                    </svg>
                </span>
                <span>NPC聊天记录</span>
            </div>
            <div class="npc-fw-card-body">${previewLines}</div>
            <div class="npc-fw-card-footer">
                <span>${escapeHTML(fd.npcName || 'NPC')} · ${escapeHTML(fd.npcRelation || '关联人物')}</span>
                <span>${messages.length}条记录</span>
            </div>
        `;
        return bubble;
    }
    else if (isSticker) bubble.className = 'message-bubble sticker-bubble';
    else if (isFriendRequestCard) {
        const data = messageData.content || {};
        const transcript = Array.isArray(data.transcript) ? data.transcript.slice(-8) : [];
        const statusText = data.status === 'accepted' ? '已成为好友' : '验证记录';
        bubble.className = 'message-bubble is-friend-request-card';
        bubble.innerHTML = `
            <details class="friend-request-chat-card">
                <summary>
                    <div class="friend-request-card-icon">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11.5h10"></path><path d="M7 15h6"></path><path d="M5.5 4.5h13A2.5 2.5 0 0 1 21 7v9a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3v-3A2.5 2.5 0 0 1 3 16V7a2.5 2.5 0 0 1 2.5-2.5Z"></path></svg>
                    </div>
                    <div class="friend-request-card-top">
                        <span class="card-kicker">FRIEND REQUEST</span>
                        <span class="card-status">${escapeHTML(statusText)}</span>
                    </div>
                    <strong>${escapeHTML(data.title || '好友验证记录')}</strong>
                    <small>${escapeHTML(data.summary || data.message || '点击展开查看验证窗口记录')}</small>
                    <span class="card-open-hint">OPEN LOG</span>
                </summary>
                <div class="friend-request-card-lines">
                    ${transcript.map(item => `
                        <div class="friend-request-card-line ${item.sender === 'user' ? 'owner' : 'char'}">
                            <span>${escapeHTML(item.senderName || (item.sender === 'char' ? 'Ta' : '你'))}</span>
                            <p>${escapeHTML(item.text || '')}</p>
                        </div>
                    `).join('')}
                </div>
            </details>
        `;
        return bubble;
    }
    else if (isCharInteractionCard) {
        const data = messageData.charInteractionData || {};
        const speaker1 = data.speaker1 || {};
        const speaker2 = data.speaker2 || {};
        const messages = Array.isArray(data.messages) ? data.messages.slice(0, 6) : [];
        const contextText = data.context || '角色之间的私下交流';
        const avatar1Src = isValidAvatarSrc(speaker1.avatar) ? speaker1.avatar : DEFAULT_AVATAR_SRC;
        const avatar2Src = isValidAvatarSrc(speaker2.avatar) ? speaker2.avatar : DEFAULT_AVATAR_SRC;
        const previewText = messages[0]?.text || contextText;
        const messagesHtml = messages.map(message => {
            const isSpeaker1 = message.sender === speaker1.name;
            const sideClass = isSpeaker1 ? 'speaker1' : 'speaker2';
            const speaker = isSpeaker1 ? speaker1 : speaker2;
            const messageAvatarSrc = isValidAvatarSrc(speaker.avatar) ? speaker.avatar : DEFAULT_AVATAR_SRC;
            const senderName = message.sender || speaker.name || '未知';
            const translationHtml = message.translation ? `<div class="ci-ins-trans">${escapeHTML(message.translation)}</div>` : '';
            return `
                <div class="ci-ins-msg ${sideClass}">
                    <img class="ci-ins-avatar" src="${escapeHTML(messageAvatarSrc)}" alt="">
                    <div class="ci-ins-content">
                        <span class="ci-ins-name">${escapeHTML(senderName)}</span>
                        <div class="ci-ins-bubble">
                            <p class="ci-ins-text">${escapeHTML(message.text || '')}</p>
                            ${translationHtml}
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        bubble.className = 'message-bubble is-char-interaction-card';
        bubble.innerHTML = `
            <details class="ci-ins-card">
                <summary class="ci-ins-summary">
                    <div class="ci-ins-summary-left">
                        <div class="ci-ins-avatars">
                            <img class="ava-1" src="${escapeHTML(avatar1Src)}">
                            <img class="ava-2" src="${escapeHTML(avatar2Src)}">
                        </div>
                        <div class="ci-ins-meta">
                            <div class="ci-ins-title">${escapeHTML(speaker1.name)} & ${escapeHTML(speaker2.name)}</div>
                            <div class="ci-ins-sub">Private Chat · ${messages.length} msgs</div>
                        </div>
                    </div>
                    <div class="ci-ins-arrow">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                    </div>
                </summary>
                <div class="ci-ins-body">
                    <div class="ci-ins-thread">
                        ${messagesHtml}
                    </div>
                </div>
            </details>
        `;
        return bubble;
    }
     else if (isPhoneNpcChatCard) {
        const data = messageData.phoneNpcChatData || {};
        const messages = Array.isArray(data.messages) ? data.messages : [];
        const pendingTurns = Number(messageData.phoneNpcRevealTurnsLeft ?? data.pendingRevealTurns ?? 0);
        const statusText = data.discovered ? 'TAKEOVER' : (data.knownByOwner ? 'DISCOVERED' : `${pendingTurns || '?'} TURNS`);
        bubble.className = 'message-bubble is-phone-npc-chat-card';
        bubble.innerHTML = `
            <details class="phone-npc-chat-card">
                <summary>
                    <div class="phone-npc-card-icon">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h11a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1.5-1.5Z"></path><path d="M9 7h6M9 11h6M9 15h3"></path></svg>
                    </div>
                    <div class="phone-npc-card-top">
                        <span class="card-kicker">PRIVATE TRACE</span>
                        <span class="card-status">${escapeHTML(statusText)}</span>
                    </div>
                    <strong>${escapeHTML(data.title || '查手机聊天记录')}</strong>
                    <small>${escapeHTML(data.summary || '点击展开查看记录')}</small>
                    <span class="card-open-hint">OPEN LOG</span>
                </summary>
                <div class="phone-npc-chat-lines">
                    ${messages.map(msg => `
                        <div class="phone-npc-line ${msg.isMe ? 'owner' : 'npc'}">
                            <span>${escapeHTML(msg.isMe ? 'OWNER' : (data.npcName || 'NPC'))}</span>
                            <p>${escapeHTML(msg.text || '')}</p>
                        </div>
                    `).join('')}
                </div>
            </details>
        `;
        return bubble;
    }
     else if (isBoardingPass) {
        bubble.className = 'message-bubble is-boarding-pass';
        const info = messageData.boardingPassInfo || {};
        bubble.innerHTML = `
            <div class="boarding-pass-content">
                <div class="bp-header">
                    <svg class="bp-plane-icon" viewBox="0 0 24 24"><path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"></path></svg>
                    <div class="bp-title-group">
                        <span class="main-title">BOARDING PASS</span>
                        <span class="sub-title">First Class</span>
                    </div>
                </div>
                <div class="bp-body">
                    <div class="bp-route">
                        <span class="bp-city">${info.from || 'N/A'}</span>
                        <span class="bp-plane-divider">✈</span>
                        <span class="bp-city">${info.to || 'N/A'}</span>
                    </div>
                    <div class="bp-info-grid">
                        <div class="bp-info-item">
                            <label>FLIGHT</label>
                            <strong>${info.flight || 'CA1234'}</strong>
                        </div>
                        <div class="bp-info-item">
                            <label>DATE</label>
                            <strong>${info.date || 'OCT 24'}</strong>
                        </div>
                        <div class="bp-info-item">
                            <label>TIME</label>
                            <strong>${info.time || '14:30'}</strong>
                        </div>
                    </div>
                </div>
                <div class="bp-footer">
                    <div class="bp-info-item">
                        <label>PASSENGER</label>
                        <strong>${info.passenger || 'User'}</strong>
                    </div>
                    <div class="bp-barcode-stub"></div>
                </div>
            </div>
        `;
    }
    else if (isHtmlSnippet) bubble.className = 'message-bubble html-snippet-bubble';
    else if (isGalleryImage) bubble.className = 'message-bubble gallery-image-bubble';
    else if (isGalleryImage) bubble.className = 'message-bubble gallery-image-bubble';
    else if (isPhotoDescription) bubble.className = 'message-bubble photo-card';
    else if (isVaultTransferCard || isVaultRequestCard) bubble.className = 'message-bubble is-vault-bank-card';
    else if (isTransfer) bubble.className = 'message-bubble is-transfer-message';
    else if (isLocation) bubble.className = 'message-bubble is-location-message';
    else if (isVoice) bubble.className = 'message-bubble is-voice-message';
    else if (isVoiceCallSummary) bubble.className = 'message-bubble is-voice-call-summary';
    else if (isVoiceCallRejected) bubble.className = 'message-bubble is-voice-call-rejected';
    else if (isMomentCard) bubble.className = 'message-bubble is-moment-card';
    else if (isOfflineInvite) bubble.className = 'message-bubble is-offline-invite';
    else if (isReceipt) bubble.className = 'message-bubble is-receipt-message';
    else if (isProductShare) bubble.className = 'message-bubble is-product-share';
    else if (isLogistics) bubble.className = 'message-bubble is-logistics-card';
    else if (isPasswordCard) bubble.className = 'message-bubble is-password-card';
    else if (isMusicShare) bubble.className = 'message-bubble is-music-share';
    else if (isPlaylistShare) bubble.className = 'message-bubble is-playlist-share';
    else if (isPlaylistInvite) bubble.className = 'message-bubble is-music-invite is-playlist-invite';
    else if (isForumPostCard) bubble.className = 'message-bubble is-forum-post-card';
    else if (isMusicInvite) bubble.className = 'message-bubble is-music-invite'; // <--- 新增
    else if (isJointFundInvite) bubble.className = 'message-bubble is-offline-invite is-joint-fund-invite';
     else if (isSpaceInvite) bubble.className = 'message-bubble is-offline-invite is-space-invite';
     else if (isFocusCard) {
        const focusData = messageData.focusData || {};
        // 增加 focusData.isTouchCard 专属标识防伪判断，杜绝用户自建同名任务导致错乱
        const isTouchCard = focusData.taskName === '零距离贴贴' || focusData.isTouchCard === true;
        const unitText = isTouchCard ? '次互动' : '分钟';
        const successText = isTouchCard ? '贴贴完成 ✨' : (focusData.isSuccess ? '专注成功 🌻' : '专注中断 🥀');
         // 将成功颜色换成洛可可柔和色系：贴贴用粉棕色，番茄钟用灰蓝色，失败用浅灰色
        const statusColor = focusData.isSuccess ? (isTouchCard ? '#D3A7A5' : '#8FA2B4') : '#BDB4A8';
        
        let spokenHtml = '';
        if (focusData.spokenList && focusData.spokenList.length > 0) {
            spokenHtml = focusData.spokenList.map(text => {
                let innerContent = '';
                if (isTouchCard) {
                    // 使用正则精准拆分："你[动作]，Ta说：“[回复内容]”"
                    const match = text.match(/^你(.*?)，Ta说：“([\s\S]*?)”$/);
                    if (match) {
                        const userAction = match[1];
                        const aiReply = match[2];
                        innerContent += `<div style="font-size:11px; color:#D3A7A5; margin-bottom:8px; font-weight:bold;">[你${escapeHTML(userAction)}]</div>`;
                        
                        // 按行分割AI回复，动作和语言独立渲染
                        const lines = aiReply.split('\n').map(l => l.trim()).filter(l => l);
                        lines.forEach(line => {
                            if (line.startsWith('“') || line.startsWith('"')) {
                                // 语言部分：带小喇叭，较深颜色字体
                                const cleanForTTS = line.replace(/^["“]|["”]$/g, '');
                                const playBtn = focusData.hasTTS 
                                    ? `<span class="focus-tts-btn" data-text="${escapeHTML(cleanForTTS)}" style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; background:rgba(0,0,0,0.05); border-radius:50%; margin-right:8px; color:#888; transition:0.2s; cursor:pointer; flex-shrink: 0;"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg></span>` 
                                    : `<span style="color:#D3A7A5; margin-right:6px; font-weight:bold;">“</span>`;
                                innerContent += `<div style="display:flex; align-items:flex-start; margin-bottom:6px;">${playBtn}<span style="flex:1; color:#555;">${escapeHTML(line)}</span></div>`;
                            } else {
                                // 动作部分：灰色较小字体，无喇叭
                                innerContent += `<div style="color:#999; font-size:12px; margin-bottom:6px;">${escapeHTML(line)}</div>`;
                            }
                        });
                    } else {
                        innerContent = `<div style="color:#555;">${escapeHTML(text)}</div>`;
                    }
                } else {
                    // 普通番茄钟专注逻辑不变
                    const playBtn = focusData.hasTTS 
                        ? `<span class="focus-tts-btn" data-text="${escapeHTML(text)}" style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; background:rgba(0,0,0,0.05); border-radius:50%; margin-right:8px; color:#888; transition:0.2s; cursor:pointer; flex-shrink: 0;"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg></span>` 
                        : `<span style="color:#D3A7A5; margin-right:6px; font-weight:bold;">“</span>`;
                    innerContent = `<div style="display:flex; align-items:flex-start;">${playBtn}<span style="flex:1; color:#555;">${escapeHTML(text)}</span></div>`;
                }
                
                // 给每一条记录增加微小白卡底色，实现分块放置
                return `<div style="font-size:13px; line-height:1.6; padding:10px 12px; background:#FFFDF9; border-radius:8px; border:1px solid #F0EBE1; margin-bottom:8px; box-shadow:0 2px 4px rgba(0,0,0,0.02);">${innerContent}</div>`;
            }).join('');
        } else {
            spokenHtml = `<div style="text-align:center; color:#ccc; font-size:12px; padding:10px 0;">( 这次专注中Ta安静地陪伴着你 )</div>`;
        }
        
        // 【核心修改】去除了沉重的白色背景，改为极简高级的半透明卡片风格，并稍微加宽
        bubble.className = 'message-bubble is-focus-card';
        bubble.style.cssText = "padding: 0 !important; background: transparent !important; box-shadow: none !important; width: 280px;";
        
        bubble.innerHTML = `
            <div class="focus-record-card" style="position: relative; background: #FFFDF9; border-radius: 8px; padding: 20px 16px; text-align: center; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,0.06); border: 1px solid #F0EBE1; font-family: 'Georgia', serif;">
                <!-- ▼▼▼ 右上角独立删除按钮 ▼▼▼ -->
                <div class="focus-delete-btn" style="position: absolute; top: 12px; right: 12px; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; color: #D3C5B8; font-size: 18px; line-height: 1; border-radius: 50%; transition: 0.2s; z-index: 10;">×</div>
                
                <!-- 明信片印章/顶部装饰 -->
                <div style="font-size: 10px; color: #C4B5A5; letter-spacing: 2px; font-weight: bold; margin-bottom: 12px; text-transform: uppercase; border-bottom: 1px solid #F0EBE1; padding-bottom: 8px;">FOCUS RECORD</div>
                
                <!-- 核心数据区 -->
                 <div style="font-size: 16px; font-weight: bold; color: ${statusColor}; margin-bottom: 6px; font-family: -apple-system, sans-serif;">${focusData.duration} ${unitText} · ${successText}</div>
                                <div style="font-size: 11px; color: #A89F91; font-family: -apple-system, sans-serif;">${isTouchCard ? '' : '任务：'}${escapeHTML(focusData.taskName || '专注')}</div>
                <!-- 展开折叠区：内部增加最大高度和滚动条 -->
                <div class="fc-body" style="max-height: 0px; opacity: 0; overflow: hidden; transition: all 0.3s ease; text-align: left; font-family: -apple-system, sans-serif;">
                    <div style="margin-top: 16px; padding-top: 14px; border-top: 1px dashed #E6DFD5; max-height: 220px; overflow-y: auto; padding-right: 4px;">
                        <div style="font-size: 10px; color: #BDB4A8; text-align: center; margin-bottom: 10px; letter-spacing: 1px;">- ${isTouchCard ? '互动记录' : '陪伴语录'} -</div>
                        ${spokenHtml}
                    </div>
                </div>
                
                <!-- 底部提示 -->
                <div class="fc-footer" style="text-align: center; margin-top: 16px; font-size: 10px; color: #C4B5A5; letter-spacing: 1px;">
                    <span>▽ 展开${isTouchCard ? '互动记录' : '陪伴语录'}</span>
                </div>
            </div>
        `;
        // 绑定交互事件
        const card = bubble.querySelector('.focus-record-card');
        if (card) {
            // ▼▼▼ 核心：给右上角的 X 绑定删除功能 ▼▼▼
            const deleteBtn = card.querySelector('.focus-delete-btn');
            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation(); // 关键防冲撞：阻止点击事件冒泡，防止触发下面的“展开卡片”动作
                    deleteMessage(messageData.id); // 呼叫系统自带的完美删除函数
                });
            }
            // ▲▲▲ 新增结束 ▲▲▲

            // 点击卡片本体展开折叠
            card.addEventListener('click', (e) => {
                // 核心防误触：如果点的是语音或删除按钮，绝对不要触发展开！
                if (e.target.closest('.focus-tts-btn') || e.target.closest('.focus-delete-btn')) return;
                
                e.stopPropagation();
                const body = card.querySelector('.fc-body');
                const footerSpan = card.querySelector('.fc-footer span');
                if (body.style.maxHeight === '0px') {
                    body.style.maxHeight = '300px'; // 留足高度让内部 220px 的滚动条展示
                    body.style.opacity = '1';
                    footerSpan.textContent = '△ 收起记录';
                } else {
                    body.style.maxHeight = '0px'; // 缩回
                    body.style.opacity = '0';
                    footerSpan.textContent = `▽ 展开${isTouchCard ? '互动记录' : '陪伴语录'}`;
                }
            });
            // 点击小喇叭播放声音
            const ttsBtns = card.querySelectorAll('.focus-tts-btn');
            ttsBtns.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const textToPlay = btn.dataset.text;
                    const charId = messageData.chatId; 
                    
                    // 按钮点击变色反馈，1秒后恢复
                    btn.style.color = '#D4AF37';
                    btn.style.background = '#fff8e1';
                    setTimeout(() => {
                        btn.style.color = '#888';
                        btn.style.background = 'rgba(0,0,0,0.05)';
                    }, 1000);
                    
                    import('./tts-service.js').then(module => {
                        module.TTSService.speakForCharacter(textToPlay, charId, { emotion: messageData.ttsEmotion });
                    });
                });
            });
        }
    }
    else bubble.className = 'message-bubble';
if (messageData.replyToMessageId && !isTransfer) {

    const previewId = `reply-preview-${messageData.id}`;
  bubble.insertAdjacentHTML('beforeend', 
        `<div id="${previewId}" class="message-reply-preview">
            正在加载引用...
        </div>`
    );
    setTimeout(() => loadReplyPreview(previewId, messageData.replyToMessageId), 100);
}

if (isSticker) {
    bubble.insertAdjacentHTML('beforeend', `<img src="${messageData.stickerUrl}" alt="${escapeHTML(messageData.text)}" decoding="async" loading="lazy">`);
} else if (isGalleryImage) {
        // 【极速模式】直接创建图片标签，不等待下载
        const img = document.createElement('img');
        img.src = messageData.stickerUrl; 
        img.alt = messageData.type === 'received' ? 'AI Image' : 'User Image';
        img.className = 'gallery-image-preview';
        img.loading = 'lazy'; 
        
        // 优化：添加异步解码，防止图片加载瞬间卡死主线程
        img.decoding = 'async'; 
        // 【关键】给一个最小高度和背景色，模仿微信的“占位符”
        // 这样图片还没出来时，气泡不会是扁的，防止页面乱跳
        img.style.borderRadius = '8px';
        bubble.appendChild(img);
        if (messageData.type === 'received') {
            const textDetails = `<div class="gallery-image-details"><p>${escapeHTML(messageData.imageAiDescription || 'AI正在思考...')}</p></div>`;
            bubble.insertAdjacentHTML('beforeend', textDetails);
        }
} else if (isPhotoDescription) { 

        const descriptionText = messageData.text.replace(/^\[拍摄\]\s*/, '');
        const placeholderIcon = `<svg viewBox="0 0 24 24" fill="none"><path d="M21.25 12.755C21.25 17.52 17.52 21.25 12.75 21.25C8.25 21.25 4.5 17.52 4.5 12.75C4.5 8.25 8.25 4.5 12.75 4.5C14.155 4.5 15.46 4.875 16.58 5.515L17.255 4.84C15.895 3.86 14.38 3.25 12.75 3.25C7.575 3.25 3.25 7.575 3.25 12.75C3.25 17.925 7.575 22.25 12.75 22.25C17.925 22.25 22.25 17.925 22.25 12.755C22.25 11.23 21.895 9.8 21.01 8.585L20.345 9.25C20.94 10.295 21.25 11.49 21.25 12.755Z" fill="#d1d1d6"></path><path d="M16.5 6.5L18.5 8.5L22.5 4.5" stroke="#d1d1d6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M18.825 15.755L16.22 13.15C15.63 12.56 14.675 12.56 14.085 13.15L8.59 18.65" stroke="#d1d1d6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M11.75 10.75C12.8546 10.75 13.75 9.85457 13.75 8.75C13.75 7.64543 12.8546 6.75 11.75 6.75C10.6454 6.75 9.75 7.64543 9.75 8.75C9.75 9.85457 10.6454 10.75 11.75 10.75Z" stroke="#d1d1d6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
        bubble.insertAdjacentHTML('beforeend', `<div class="photo-card-preview"><div class="photo-card-placeholder-icon">${placeholderIcon}</div><span class="preview-text">点击查看照片</span></div><div class="photo-card-details">${escapeHTML(descriptionText)}</div>`);
 } else if (isLocation) {
        bubble.innerHTML = `<div class="location-card"><div class="location-card-text">${escapeHTML(messageData.locationName)}</div><img src="${messageData.mapImageUrl}" class="location-card-map" alt="Map"></div>`;
    } else if (isVoice) {
        const textLength = messageData.text.length;
        const duration = Math.max(1, Math.ceil(textLength / 4));
        let barsHtml = '';
        const barCount = 18; 
        for (let i = 0; i < barCount; i++) {
            barsHtml += '<div class="bar"></div>';
        }
        
        // 1. 构建语音条和隐藏的原文
        bubble.innerHTML = `
            <div class="voice-bar">
                <div class="voice-waveform">${barsHtml}</div>
                <span class="voice-duration">${duration}"</span>
            </div>
            <div class="voice-text-content">${escapeHTML(messageData.text)}</div>
        `;

        // ▼▼▼ 【核心修改】如果存在翻译，插入翻译块 ▼▼▼
        if (messageData.translation) {
            const transDiv = document.createElement('div');
            // 翻译块沿用聊天设置，点击同一气泡内的“译”按钮切换展开状态
            transDiv.className = getTranslationClassName(messageData);
            transDiv.innerHTML = escapeHTML(messageData.translation).replace(/\n/g, '<br>');
            bubble.appendChild(transDiv);
        }
        // ▲▲▲ 修改结束 ▲▲▲

    } else if (isVoiceCallSummary) {
    // 【修复】根据 isVideo 属性选择不同的图标
    const videoIconSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.6 11.6L22 7v10l-6.4-4.6"></path><rect x="2" y="7" width="13.6" height="10" rx="2" ry="2"></rect></svg>`;
    const phoneIconSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>`;
    
    const iconToUse = messageData.isVideo ? videoIconSVG : phoneIconSVG;
    
    // 【修复】文本也根据 isVideo 变化
    const textToUse = messageData.isVideo ? `视频通话时长 ${formatTime(messageData.duration)}` : `通话时长 ${formatTime(messageData.duration)}`;
    
    bubble.innerHTML = `${iconToUse}<p>${escapeHTML(textToUse)}</p>`;
      } else if (isVoiceCallRejected) {
        const videoIconSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.6 11.6L22 7v10l-6.4-4.6"></path><rect x="2" y="7" width="13.6" height="10" rx="2" ry="2"></rect></svg>`;
        const phoneIconSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 1 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>`;
        const iconToUse = messageData.isVideo ? videoIconSVG : phoneIconSVG;
        const textToUse = messageData.text || (messageData.isVideo ? '已拒绝视频通话' : '已拒绝语音通话');
        bubble.innerHTML = `${iconToUse}<p>${escapeHTML(textToUse)}</p>`;
      } else if (isReceipt) {
        const info = messageData.receiptInfo || {};
        // 关键分流：如果有收货地址，说明是购物卡片；如果没有，说明是外卖小票
        if (info.deliveryInfo && info.deliveryInfo.address) {
            const items = info.items || [];
            const total = info.total || 0;
            const delivery = info.deliveryInfo || {};
            const listHtml = items.map(item => `
                <div class="list-item">
                    <div class="item-info">
                        <span class="name">${escapeHTML(item.name)}</span>
                        <span class="specs">${escapeHTML(item.specs || '默认规格')}</span>
                    </div>
                    <div class="item-cost"><div class="price">¥${item.price}</div><div class="count">x${item.count}</div></div>
                </div>`).join('');
            const dynamicHeight = Math.max(220, 120 + items.length * 40);
            
            // ▼▼▼ 【核心修复】重新渲染时去本地存储提取最新轮数 ▼▼▼
            let timeText = delivery.time || '即刻生效';
            let stampColor = messageData.isAiGift ? '#d93025' : '#e0e0e0';
            let stampText = messageData.isAiGift ? 'CHAR. PAID' : 'PAID';
            
            const savedGiftsRaw = localStorage.getItem('active_gifts_state');
            if (savedGiftsRaw) {
                try {
                    const savedGifts = JSON.parse(savedGiftsRaw);
                    // 遍历所有角色里的礼物寻找这个订单的监听
                    for (const charId in savedGifts) {
                        const gifts = savedGifts[charId];
                        const myGift = gifts.find(g => String(g.msgId) === String(messageData.id));
                        if (myGift) {
                            if (myGift.status === 'delivered') {
                                timeText = "已送达";
                                stampColor = "#34c759";
                                stampText = "DELIVERED";
                            } else {
                                timeText = `${myGift.remaining} 轮对话后`;
                            }
                            break; // 找到了就不往下找了
                        }
                    }
                } catch(e) { console.error(e); }
            }
            // ▲▲▲ 修改结束 ▲▲▲

            bubble.innerHTML = `
                <div class="receipt-card-3d" style="height: ${dynamicHeight}px;">
                    <div class="card-face face-front">
                        <div class="front-header"><span class="brand">LOOKY RECEIPT</span><span class="title">Shopping List</span></div>
                        <div class="front-list-area">${listHtml}</div>
                        <div class="front-footer"><div class="hint"><span>配送信息</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></div><span class="total-price">Total: ¥${total.toFixed(2)}</span></div>
                    </div>
                    <div class="card-face face-back">
                        <div class="back-content">
                            <div class="info-group"><div class="label">Address</div><div class="value">${escapeHTML(delivery.address)}</div></div>
                            <div class="info-group"><div class="label">Time</div><div class="value large" style="color: ${stampColor === '#34c759' ? '#34c759' : 'inherit'};">${escapeHTML(timeText)}</div></div>
                        </div>
                        <div class="back-stamp" style="color:${stampColor}; border-color:${stampColor};">${stampText}</div>
                    </div>
                </div>`;
            const card = bubble.querySelector('.receipt-card-3d');
            if (card) card.addEventListener('click', (e) => { e.stopPropagation(); card.classList.toggle('flipped'); });
          } else if (info.items && info.items.length > 0) { // 【精准分流】有清单才是外卖小票

            // --- 【恢复外卖逻辑】传统的纸质长小票 + 折叠效果 ---
            bubble.innerHTML = `<div class="receipt-card collapsed ${messageData.isAiGift ? 'is-ai-gift' : ''}">${generateReceiptHtml(info)}</div>`;
            const card = bubble.querySelector('.receipt-card');
            card.addEventListener('click', (e) => {
                e.stopPropagation();
                card.classList.toggle('collapsed');
            });
       } else {
            // 【核心修复】如果没有清单（比如打车车票），直接把存好的车票 HTML 显示出来
            bubble.innerHTML = messageData.text;
        }

     } else if (isForumPostCard) {
        let data = {};
        try {
            data = typeof messageData.content === 'string' ? JSON.parse(messageData.content) : (messageData.content || {});
        } catch (e) {
            console.error('论坛帖子卡片数据解析失败', e);
        }

        const likeCount = Number(data.likes || 0);
        const commentCount = Number(data.comments || 0);
        const forwardCount = Number(data.forwards || 0);
        const avatarSrc = isValidAvatarSrc(data.avatar) ? data.avatar : 'images/default-avatar.svg';
        const previewMediaHtml = renderForumPostSharePreviewMedia(data);

        bubble.innerHTML = `
            <div class="forum-post-share-card">
                <div class="forum-post-share-head">
                    <img src="${escapeHTML(avatarSrc)}" alt="">
                    <div class="forum-post-share-meta">
                        <b>${escapeHTML(data.author || '论坛用户')}</b>
                        <span>${escapeHTML(data.circle || 'Forum')}</span>
                    </div>
                    <span class="forum-post-share-badge">帖子</span>
                </div>
                <div class="forum-post-share-preview">
                    <div class="forum-post-share-copy">
                        <div class="forum-post-share-title">${escapeHTML(data.title || data.text || '论坛帖子')}</div>
                        <div class="forum-post-share-subtitle">转发给 ${escapeHTML(data.targetName || '当前角色')}</div>
                    </div>
                    ${previewMediaHtml}
                </div>
                <div class="forum-post-share-footer">
                    <span>${likeCount} 赞</span>
                    <span>${commentCount} 评论</span>
                    <span>${forwardCount} 转发</span>
                    <b>查看</b>
                </div>
            </div>
        `;

        const card = bubble.querySelector('.forum-post-share-card');
        card?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target.closest('a,button')) return;
            showForumPostShareDetailModal(data);
        });
     } else if (isMomentCard) {
        // 解析存入数据库的 JSON 数据
        let cardData = {};
        try {
            cardData = typeof messageData.content === 'string' ? JSON.parse(messageData.content) : messageData.content;
        } catch(e) { console.error('动态卡片数据解析失败', e); }

        const thumbHtml = cardData.thumb ? `<img src="${cardData.thumb}" class="mc-thumb">` : '';
        
        // ▼▼▼ 【修改点】使用了SVG图标替换Emoji ▼▼▼
        const likeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
        const commentIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>`;

        bubble.innerHTML = `
            <div class="moment-card-inner">
                <div class="mc-header">
                    <img src="${cardData.avatar || 'images/default-avatar.svg'}">
                    <span>${escapeHTML(cardData.author)}</span>
                    <span class="mc-tag">动态</span>
                </div>
                <div class="mc-body">
                    <div class="mc-text">${escapeHTML(cardData.text || '分享了一条动态')}</div>
                    ${thumbHtml}
                </div>
                <div class="mc-footer">
                   <div class="mc-stat">${likeIcon} <span>${cardData.likes || 0}</span></div>
                   <div class="mc-stat">${commentIcon} <span>${cardData.comments || 0}</span></div>
                               </div>
            </div>
        `;
  } else if (isOfflineInvite) {
        // 判断卡片状态
        const isProcessed = messageData.inviteStatus === 'accepted' || messageData.inviteStatus === 'rejected';
        const cardClass = isProcessed ? 'invite-card processed' : 'invite-card';
        
        let buttonTextAccept = "接受邀约";
        let buttonTextReject = "稍后再说";
        
        if (messageData.inviteStatus === 'accepted') {
            buttonTextAccept = "已赴约"; 
            buttonTextReject = "";
        } else if (messageData.inviteStatus === 'rejected') {
            buttonTextAccept = "";
            buttonTextReject = "已婉拒";
        }
           // 默认 HTML 结构 (无图版)
        bubble.innerHTML = `
            <div class="${cardClass}" data-message-id="${messageData.id}">
                <div class="invite-cover-container" id="invite-cover-${messageData.id}">
                    <!-- 图片将通过JS异步加载 -->
                    <div class="invite-cover-placeholder">INVITATION</div>
                </div>
                <!-- ▼▼▼ 新增：装饰图标 (火漆印风格) ▼▼▼ -->
                <div class="invite-icon-wrapper">
                    <!-- 房子图标 -->
                    <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                        <polyline points="9 22 9 12 15 12 15 22"></polyline>
                    </svg>
                </div>
                <!-- ▲▲▲ 新增结束 ▲▲▲ -->
                <div class="invite-content-body">
                    <div class="invite-decorative-line"></div>
                    <div class="invite-title">Sincerely Yours</div>
                    <div class="invite-text">${escapeHTML(messageData.text || '想见你，现在。')}</div>
                    <div class="invite-decorative-line"></div>
                </div>
                <div class="invite-actions">
                    ${messageData.inviteStatus !== 'accepted' ? `<button class="btn-reject">${buttonTextReject}</button>` : ''}
                    ${messageData.inviteStatus !== 'rejected' ? `<button class="btn-accept">${buttonTextAccept}</button>` : ''}
                </div>
            </div>
        `;
        // 【异步加载图片】尝试从相册获取图片
        getRandomGalleryImage(messageData.chatId).then(imgUrl => {
            if (imgUrl) {
                const coverContainer = bubble.querySelector(`#invite-cover-${messageData.id}`);
                if (coverContainer) {
                    coverContainer.innerHTML = `<img src="${imgUrl}" class="invite-real-image" alt="cover">`;
                }
            }
        });
        // 绑定点击事件 (只有未处理时才绑定)
        if (!isProcessed) {
            const btnAccept = bubble.querySelector('.btn-accept');
            const btnReject = bubble.querySelector('.btn-reject');
            if (btnAccept) {
                btnAccept.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await handleInviteAction(messageData.id, 'accepted', messageData.chatId);
                });
            }
            if (btnReject) {
                btnReject.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await handleInviteAction(messageData.id, 'rejected', messageData.chatId);
                });
            }
        }
  } else if (isJointFundInvite) {
        const isProcessed = messageData.inviteStatus === 'accepted' || messageData.inviteStatus === 'rejected';
        const cardClass = isProcessed ? 'invite-card processed' : 'invite-card';
        const isSentByUser = messageData.type === 'sent';
        let actionsHtml = '';
        if (messageData.inviteStatus === 'accepted') {
            actionsHtml = '<div class="status-text" style="color:#A5D2C1;">已同意绑定</div>';
        } else if (messageData.inviteStatus === 'rejected') {
            actionsHtml = '<div class="status-text" style="color:#888;">已婉拒</div>';
        } else if (isSentByUser) {
            actionsHtml = '<div class="status-text" style="color:#D4AF37;">等待 Ta 回应</div>';
        } else {
            actionsHtml = '<button class="btn-reject" style="background:#333; color:#aaa;">暂不开启</button><button class="btn-accept" style="background:#fff; color:#000;">同意绑定</button>';
        }
        // 极简高级黑卡风格
        bubble.innerHTML = `
            <div class="${cardClass}" data-message-id="${messageData.id}" style="background: linear-gradient(135deg, #2c2c2c, #0a0a0a); border-radius: 14px; padding: 16px; color: #fff; width: 218px; box-shadow: 0 6px 18px rgba(0,0,0,0.14); font-family: 'Helvetica Neue', sans-serif;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
                    <span style="font-size: 12px; letter-spacing: 2px; color: #888; font-weight: bold;">LOOKY BANK</span>
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#D4AF37" stroke-width="2" stroke-linecap="round"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                </div>
                <div style="font-size: 15px; font-weight: 500; margin-bottom: 6px; letter-spacing: 1px;">LOVE FUND</div>
                <div style="font-size: 11px; color: #aaa; line-height: 1.45; margin-bottom: 18px; min-height: 30px;">${escapeHTML(messageData.text || '要不要和我一起开启共同小金库？')}</div>
                <div style="display: flex; gap: 8px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 12px;" class="invite-actions">
                    ${actionsHtml}
                </div>
            </div>
        `;
        if (!isProcessed && !isSentByUser) {
            const acceptBtn = bubble.querySelector('.btn-accept');
            const rejectBtn = bubble.querySelector('.btn-reject');
            acceptBtn?.addEventListener('click', async (e) => {
                e.stopPropagation();
                await openLookyVault(messageData.chatId, 'ai_to_user_accept');
                await db.chatMessages.update(messageData.id, { inviteStatus: 'accepted' });
                const msgInMem = AppState.currentChatHistory.find(m => m.id === messageData.id);
                if (msgInMem) msgInMem.inviteStatus = 'accepted';
                bubble.querySelector('.invite-card')?.classList.add('processed');
                bubble.querySelector('.invite-actions').innerHTML = '<div class="status-text">共同小金库已开启</div>';
                showDynamicIsland('共同小金库已开启', 'success');
            });
            rejectBtn?.addEventListener('click', async (e) => {
                e.stopPropagation();
                await db.chatMessages.update(messageData.id, { inviteStatus: 'rejected' });
                const msgInMem = AppState.currentChatHistory.find(m => m.id === messageData.id);
                if (msgInMem) msgInMem.inviteStatus = 'rejected';
                bubble.querySelector('.invite-card')?.classList.add('processed');
                bubble.querySelector('.invite-actions').innerHTML = '<div class="status-text">已婉拒</div>';
            });
        }
     } else if (isVaultTransferCard || isVaultRequestCard) {
        const info = isVaultTransferCard ? (messageData.transferInfo || messageData.vaultCardInfo || {}) : (messageData.vaultCardInfo || {});
        const isSettledTransfer = isVaultTransferCard && info.status && info.status !== 'pending';
        const amountText = info.amount ? `¥${escapeHTML(String(info.amount))}` : '待填写';
        const titleText = isVaultTransferCard ? (isSettledTransfer ? (info.status === 'accepted' ? '金库转账已接收' : '金库转账已退回') : '共同金库转账') : '共同金库收款';
        const badgeText = isVaultTransferCard ? (isSettledTransfer ? 'VAULT DONE' : 'VAULT PAY') : 'VAULT REQUEST';
        const descText = isVaultTransferCard
            ? `从共同小金库转给 ${escapeHTML(info.targetName || 'Ta')}`
            : `请 ${escapeHTML(info.targetName || 'Ta')} 转入共同小金库`;
        const className = isVaultTransferCard ? 'vault-bank-card vault-bank-card-send' : 'vault-bank-card vault-bank-card-request';
        const iconPath = isVaultTransferCard
            ? '<path d="M12 5v14M7 10l5-5 5 5M5 19h14"></path>'
            : '<path d="M12 19V5M7 14l5 5 5-5M5 5h14"></path>';
        bubble.innerHTML = `
            <div class="${className}" data-message-id="${messageData.id}">
                <div class="vbc-top">
                    <span>LOOKY BANK</span>
                    <em>${badgeText}</em>
                </div>
                <div class="vbc-main">
                    <div class="vbc-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${iconPath}</svg></div>
                    <div>
                        <div class="vbc-title">${titleText}</div>
                        <div class="vbc-desc">${descText}</div>
                    </div>
                </div>
                <div class="vbc-bottom">
                    <strong>${amountText}</strong>
                    <span>LOVE FUND</span>
                </div>
            </div>
        `;
        if (isVaultTransferCard && info.status === 'pending' && messageData.type !== 'sent') {
            bubble.querySelector('.vault-bank-card')?.addEventListener('click', () => {
                document.dispatchEvent(new CustomEvent('showTransferDetail', { detail: { messageId: messageData.id } }));
            });
        }
     } else if (isSpaceInvite) {
        // ▼▼▼ 【新增】情侣空间邀请卡片渲染与交互 ▼▼▼
        const isProcessed = messageData.inviteStatus === 'accepted' || messageData.inviteStatus === 'rejected';
        const cardClass = isProcessed ? 'space-invite-card processed' : 'space-invite-card';
        const isAiInvite = messageData.type === 'received';
        
        let footerHtml = '';
        if (messageData.inviteStatus === 'pending' || !messageData.inviteStatus) {
            footerHtml = isAiInvite
                ? `<button class="btn-reject">婉拒</button><button class="btn-accept">接受邀请</button>`
                : `<button class="btn-accept">代 Ta 开启</button>`;
        } else if (messageData.inviteStatus === 'accepted') {
            footerHtml = `<div class="status-text">情侣空间已开启</div>`;
        } else {
            footerHtml = `<div class="status-text">已婉拒</div>`;
        }
        bubble.innerHTML = `
            <div class="${cardClass}" data-message-id="${messageData.id}">
                <div class="si-cover">COUPLE SPACE</div>
                <div class="si-icon-wrapper">
                    <svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                </div>
                <div class="si-body">
                    <div class="si-title">Secret Garden</div>
                    <div class="si-text">${escapeHTML(messageData.text || '我想和你开启专属空间')}</div>
                </div>
                <div class="si-actions">
                    ${footerHtml}
                </div>
            </div>
        `;
        // 绑定空间邀请按钮事件
        if (!isProcessed) {
            const btnAccept = bubble.querySelector('.btn-accept');
            const btnReject = bubble.querySelector('.btn-reject');
            const updateCoupleSpaceStatus = async (statusObj) => {
                const CS_DB_NAME = 'CoupleSpaceData';
                const CS_STORE_NAME = 'store';
                const idb = await new Promise((resolve) => {
                    const req = indexedDB.open(CS_DB_NAME, 1);
                    req.onupgradeneeded = e => {
                        if (!e.target.result.objectStoreNames.contains(CS_STORE_NAME)) e.target.result.createObjectStore(CS_STORE_NAME);
                    };
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => resolve(null);
                });
                if (idb) {
                    const tx = idb.transaction(CS_STORE_NAME, 'readwrite');
                    tx.objectStore(CS_STORE_NAME).put(statusObj, 'cs_unlocked_' + messageData.chatId);
                }
            };
            if (btnAccept) {
                btnAccept.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    // 1. 改变当前消息状态
                    await db.chatMessages.update(messageData.id, { inviteStatus: 'accepted' });
                    const msgInMem = AppState.currentChatHistory.find(m => m.id === messageData.id);
                    if (msgInMem) msgInMem.inviteStatus = 'accepted';
                    
                    // 2. 刷新气泡 UI
                    bubble.querySelector('.space-invite-card').classList.add('processed');
                    bubble.querySelector('.si-actions').innerHTML = `<div class="status-text">情侣空间已开启</div>`;
                    // 3. 核心：跨库更新情侣空间解锁状态
                    await updateCoupleSpaceStatus({ unlocked: true, pending: false, unlockTime: Date.now() });
                    
                    // 4. 发送一条系统提示
                    import('./chat-service.js').then(({ addSystemEventMessage }) => {
                        addSystemEventMessage(messageData.chatId, isAiInvite ? '你接受了邀请，情侣空间已成功开启' : '情侣空间已成功开启', 'info');
                    });
                });
            }
            if (btnReject) {
                btnReject.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await db.chatMessages.update(messageData.id, { inviteStatus: 'rejected' });
                    const msgInMem = AppState.currentChatHistory.find(m => m.id === messageData.id);
                    if (msgInMem) msgInMem.inviteStatus = 'rejected';

                    bubble.querySelector('.space-invite-card').classList.add('processed');
                    bubble.querySelector('.si-actions').innerHTML = `<div class="status-text">已婉拒</div>`;
                    await updateCoupleSpaceStatus({ unlocked: false, pending: false });

                    import('./chat-service.js').then(({ addSystemEventMessage }) => {
                        addSystemEventMessage(messageData.chatId, '你婉拒了情侣空间邀请', 'info');
                    });
                });
            }
        }
     } else if (isRedPacket) {
        const rpData = typeof messageData.content === 'string' ? JSON.parse(messageData.content) : (messageData.content || {});
        // ▼▼▼ 核心修复 1：判断“我”是否领过，而不是单纯判断红包是否抢空 ▼▼▼
        const currentUser = getCurrentChatIdentity();
        const myName = currentUser ? currentUser.name : '你';
        const hasReceived = rpData.receiveList && rpData.receiveList.some(r => r.name === myName);
        const isOpened = rpData.status === 'opened' || hasReceived;
        // ▲▲▲ 修复结束 ▲▲▲
        const coverClass = rpData.cover === 'grey' ? 'cover-grey' : '';

        bubble.className = 'message-bubble is-red-packet';
        bubble.innerHTML = `
            <div class="red-packet-bubble-card ${isOpened ? 'opened' : ''} ${coverClass}" data-id="${messageData.id}">
                <div class="rp-top">
                    <div class="rp-icon">
                        <svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="14" rx="2"></rect><path d="M4 10l8 5 8-5"></path></svg>
                    </div>
                    <div class="rp-info">
                        <div class="rp-greeting">${escapeHTML(rpData.greeting || '恭喜发财，大吉大利')}</div>
                        <div class="rp-status">${isOpened ? '已被领取' : '领取红包'}</div>
                    </div>
                </div>
                <div class="rp-bottom">Looky 红包</div>
            </div>
        `;

        const card = bubble.querySelector('.red-packet-bubble-card');
        if (card) {
            card.addEventListener('click', async (e) => {
                e.stopPropagation();
                // 1. 获取最新数据，防止页面还没刷新时被重复点
                const currentMsg = await db.chatMessages.get(messageData.id);
                        let currentRpData = typeof currentMsg.content === 'string' ? JSON.parse(currentMsg.content) : (currentMsg.content || {});
                
                // ▼▼▼ 核心修复 2：如果已经抢空了，或者我自己已经领过了，直接看详情 ▼▼▼
                const currentUser = getCurrentChatIdentity();
                const myName = currentUser ? currentUser.name : '你';
                const hasReceived = currentRpData.receiveList && currentRpData.receiveList.some(r => r.name === myName);
                
                if (currentRpData.status === 'opened' || hasReceived) {
                    showRedPacketDetail(currentMsg, currentRpData);
                } else {
                    // 3. 如果没领取过，展示拆红包动画弹窗
                    showRedPacketOpen(currentMsg, currentRpData, card);
                }

            });
        }

        // --- 附属的局部函数，用于处理动画和展示 ---
        async function showRedPacketOpen(msg, rpData, cardElement) {
                    const modal = document.getElementById('red-packet-open-modal');
            if (!modal) return;
            
            // ▼▼▼ 智能提取发送者身份与头像 ▼▼▼
            const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            let senderName = 'Ta';
            let senderAvatar = 'images/default-avatar.svg';
            if (msg.type === 'sent') {
                const user = getCurrentChatIdentity();
                senderName = char?.chatOverrideUserNickname || user?.name || '你';
                senderAvatar = char?.chatOverrideUserAvatar || user?.avatar || 'images/default-avatar.svg';
            } else {
                if (char && char.isGroup && (msg.speakerId || msg.speakerName)) {
                    const member = findGroupParticipant(char, msg.speakerId, msg.speakerName);
                    senderName = msg.speakerName;
                    senderAvatar = member?.avatar || char?.avatar || 'images/default-avatar.svg';
                } else {
                    senderName = char?.chatOverrideName || char?.name || 'Ta';
                    senderAvatar = char?.chatOverrideAvatar || char?.avatar || 'images/default-avatar.svg';
                }
            }

            // 填充基础信息
            document.getElementById('rp-open-avatar').src = isValidAvatarSrc(msg.avatarSrc) ? msg.avatarSrc : senderAvatar;
            document.getElementById('rp-open-name').textContent = senderName;
            // ▲▲▲ 修改结束 ▲▲▲
            document.getElementById('rp-open-greeting').textContent = rpData.greeting || '恭喜发财，大吉大利';
            
            const actionBtn = document.getElementById('rp-open-action-btn');

            actionBtn.style.transform = 'rotateY(0deg)'; // 重置动画
            
            // 【修复】脱下隐形斗篷：先flex占位，再给opacity加上延迟触发过渡动画
            modal.style.display = 'flex';
            setTimeout(() => modal.style.opacity = '1', 10);
            
            // 点击关闭 (平滑隐身并隐藏)
            document.getElementById('close-rp-open-btn').onclick = () => { 
                modal.style.opacity = '0';
                setTimeout(() => modal.style.display = 'none', 300); 
            };
            // 点击“開”
            actionBtn.onclick = async () => {
                actionBtn.style.transform = 'rotateY(720deg)'; // 让按钮转两圈
                setTimeout(async () => {
                    // 动画结束后平滑隐身
                    modal.style.opacity = '0';
                    setTimeout(() => modal.style.display = 'none', 300); 

                    // ▼▼▼ 核心修复 3：删除了这里错误的强制标记，防止红包状态被提前污染 ▼▼▼
                      // 真实分配金额的逻辑 (拼手气和普通红包兼容AI抢过的情况)
                    if (!rpData.receiveList) rpData.receiveList = [];

                    const totalAmt = parseFloat(rpData.amount);
                    const count = parseInt(rpData.count) || 1;
                    const currentUser = getCurrentChatIdentity();
                    const myName = currentUser.name || '你';
                    
                    let grabAmt = 0; // 【核心修复】将变量提取到外层，防止下方记账调用时报错中止
                    // 检查我是否还没抢过
                    if (!rpData.receiveList.find(r => r.name === myName)) {
                        if (rpData.type === 'random') {
                            // 拼手气
                            const remainCount = count - rpData.receiveList.length;
                            const remainAmt = totalAmt - rpData.receiveList.reduce((sum, r) => sum + parseFloat(r.amount), 0);
                            
                            if (remainCount === 1) {
                                grabAmt = remainAmt; // 最后一个拿走全部剩下的
                            } else if (remainCount > 1) {
                                const max = (remainAmt / remainCount) * 2;
                                grabAmt = Math.max(0.01, Math.random() * max);
                            }
                        } else {
                            // 普通红包
                            grabAmt = rpData.singleAmount || (totalAmt / count);
                        }
                        
                        // 抢到的钱加入列表
                        if (grabAmt > 0) {
                            rpData.receiveList.push({ 
                                name: myName, 
                                amount: grabAmt.toFixed(2), 
                                time: new Date().toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit'}), 
                                isMe: true 
                            });
                        }
                    }

                    // 检查是否已经抢满人数，满人则改状态
                    if (rpData.receiveList.length >= count) {
                        rpData.status = 'opened';
                    }

                    await recordLookyLedger({
                        source: 'red_packet_receive',
                        sourceId: `${msg.id}_${currentUser.name || 'me'}`,
                        type: 'income',
                        amount: grabAmt,
                        category: '转账',
                        title: '收红包',
                        memo: rpData.greeting || '',
                        char: msg.chatId,
                        timestamp: Date.now(),
                        isAuto: true
                    });

                    // 保存到数据库
                    await db.chatMessages.update(msg.id, { content: rpData });
                    
                    // UI 即时更新气泡状态
                    cardElement.classList.add('opened');
                    const statusEl = cardElement.querySelector('.rp-status');
                    if (statusEl) statusEl.textContent = '已被领取';
                    
                    // 系统事件提示
                    import('./chat-service.js').then(({ addSystemEventMessage }) => {
                        const currentUser = getCurrentChatIdentity();
                        addSystemEventMessage(msg.chatId, `${currentUser.name || '你'}领取了红包`, 'info');
                    });
                    
                    // 拆完直接跳出详情列表
                    showRedPacketDetail(msg, rpData);
                }, 600); // 配合动画时长
            };
        }
        function showRedPacketDetail(msg, rpData) {
            const modal = document.getElementById('red-packet-detail-modal');
            if (!modal) return;
            
            // ▼▼▼ 智能提取发送者身份与头像 ▼▼▼
            const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            let senderName = 'Ta';
            let senderAvatar = 'images/default-avatar.svg';
            if (msg.type === 'sent') {
                const user = getCurrentChatIdentity();
                senderName = char?.chatOverrideUserNickname || user?.name || '你';
                senderAvatar = char?.chatOverrideUserAvatar || user?.avatar || 'images/default-avatar.svg';
            } else {
                if (char && char.isGroup && (msg.speakerId || msg.speakerName)) {
                    const member = findGroupParticipant(char, msg.speakerId, msg.speakerName);
                    senderName = msg.speakerName;
                    senderAvatar = member?.avatar || char?.avatar || 'images/default-avatar.svg';
                } else {
                    senderName = char?.chatOverrideName || char?.name || 'Ta';
                    senderAvatar = char?.chatOverrideAvatar || char?.avatar || 'images/default-avatar.svg';
                }
            }

            document.getElementById('rp-detail-avatar').src = isValidAvatarSrc(msg.avatarSrc) ? msg.avatarSrc : senderAvatar;
            document.getElementById('rp-detail-name').textContent = senderName;
            // ▲▲▲ 修改结束 ▲▲▲
            document.getElementById('rp-detail-greeting').textContent = rpData.greeting || '恭喜发财，大吉大利';
            
            const count = parseInt(rpData.count) || 1;

            const totalAmt = parseFloat(rpData.amount).toFixed(2);
            document.getElementById('rp-detail-status-text').textContent = `已领取 ${rpData.receiveList ? rpData.receiveList.length : count}/${count} 个，共 ${totalAmt} 元`;
            
            // 是否展示居中大金额（如果当前用户领到了）
            const myRecord = rpData.receiveList ? rpData.receiveList.find(r => r.isMe) : null;
            const amountBox = document.getElementById('rp-detail-amount-box');
            if (myRecord) {
                amountBox.style.display = 'block';
                document.getElementById('rp-detail-my-amount').textContent = myRecord.amount;
            } else {
                amountBox.style.display = 'none';
            }

            // 生成列表
            const listEl = document.getElementById('rp-detail-list');
            listEl.innerHTML = '';
            if (rpData.receiveList) {
                // 根据金额高低排序一下 (如果是拼手气的话)
                const sortedList = [...rpData.receiveList].sort((a,b) => parseFloat(b.amount) - parseFloat(a.amount));
                sortedList.forEach((r, index) => {
                    const isBest = (rpData.type === 'random' && index === 0 && count > 1) ? '<span style="font-size:10px; color:#e0ca9e; border:1px solid #e0ca9e; padding:1px 4px; border-radius:4px; margin-left:6px;">手气最佳</span>' : '';
                    
                    // ▼▼▼ 获取真实头像逻辑 ▼▼▼
                    let memberAvatar = 'images/default-avatar.svg';
                    if (r.isMe) {
                        const currentUser = getCurrentChatIdentity();
                        memberAvatar = currentUser?.avatar || 'images/default-avatar.svg';
                    } else if (r.avatar) {
                        memberAvatar = r.avatar;
                    } else {
                        // 尝试从群成员中匹配真实头像
                        const member = AppState.characterProfiles.find(c => c.name === r.name);
                        if (member && member.avatar) memberAvatar = member.avatar;
                    }

                    listEl.innerHTML += `
                        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #f0f0f0; padding-bottom: 12px;">
                            <div style="display: flex; align-items: center; gap: 12px;">
                                <img src="${memberAvatar}" alt="avatar">
                                <div style="display: flex; flex-direction: column;">

                                    <span style="font-size: 14px; color: #333; font-weight: 500;">${escapeHTML(r.name)} ${isBest}</span>
                                    <span style="font-size: 11px; color: #999; margin-top:2px;">${r.time}</span>
                                </div>
                            </div>
                            <div style="font-size: 15px; font-weight: 600; color: #111;">${r.amount} 元</div>
                        </div>
                    `;
                });
            }

            // 【修复】脱下隐形斗篷
            modal.style.display = 'flex';
            setTimeout(() => modal.style.opacity = '1', 10);
            
            // 点击返回关闭详情页
            document.getElementById('close-rp-detail-btn').onclick = () => { 
                modal.style.opacity = '0';
                setTimeout(() => modal.style.display = 'none', 300);
            };
        }

    }     else if (isHtmlSnippet) {

        const rawHtml = messageData.text || '';
        const safeHtml = sanitizeHtmlSnippet(rawHtml);
        
        // 彻底清空气泡自己的底色、边框、阴影
        bubble.className = 'message-bubble html-snippet-bubble';
        bubble.style.cssText = "background: transparent !important; box-shadow: none !important; padding: 0 !important; overflow: visible !important; border: none !important;";

        // ▼▼▼ 【核心修改】包裹层实现“画布等比缩小” ▼▼▼
        const wrapper = document.createElement('div');
        wrapper.className = 'html-snippet-wrapper';
        // 外壳：限制最终出现在屏幕上的大小为 240px 宽（防止撑满屏幕）
        wrapper.style.cssText = "width: 240px; height: 240px; position: relative; border-radius: 12px; overflow: hidden; transform-origin: top left; transition: height 0.3s ease;";

        const iframe = document.createElement('iframe');
        // 沙盒：只允许脚本运行，全面禁止跳出、弹窗
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        iframe.setAttribute('scrolling', 'no'); 
        
        // 画布：给内部一个 320px 的空间，然后利用 transform: scale(0.75) 把它等比缩小塞进 240px 的外壳里
        iframe.style.cssText = "width: 320px; height: 320px; border: none; background: transparent; transform: scale(0.75); transform-origin: top left; display: block;";
        
        iframe.srcdoc = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
                <style>
                    ::-webkit-scrollbar { display: none !important; width: 0; height: 0; }
                    html, body {
                        margin: 0; padding: 0; width: 320px; min-height: 320px;
                        background: transparent !important; overflow: hidden !important;
                        display: flex; flex-direction: column; justify-content: center; align-items: center;
                        font-family: -apple-system, sans-serif;
                    }
                    /* 严防内部元素撑爆画布 */
                    body > * { max-width: 100%; box-sizing: border-box; }
                    img, video { max-width: 100%; height: auto; border-radius: 8px; }
                    /* 物理禁用所有的超链接点击，彻底杜绝外跳 */
                    a { pointer-events: none !important; text-decoration: none !important; color: inherit; }
                </style>
                <script>
                    // 核弹级拦截：重写所有弹窗和跳转API
                    window.alert = window.confirm = window.prompt = function(){ return false; };
                    window.open = function(){ return null; };
                    
                    // 魔法：页面加载完后，把自己的实际高度告诉外面的气泡，让外框跟着自适应拉长
                    window.onload = function() {
                        setTimeout(() => {
                            const contentHeight = document.body.scrollHeight;
                            if (contentHeight > 0) {
                                window.parent.postMessage({ type: 'resize_html', height: contentHeight, id: '${messageData.id}' }, '*');
                            }
                        }, 150);
                    };
                </script>
            </head>
            <body>
                ${safeHtml}
            </body>
            </html>`;
            
        wrapper.appendChild(iframe);
              const overlay = document.createElement('div');
            // 这层玻璃覆盖在网页上方，用来捕获长按事件
            overlay.style.cssText = "position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 10; cursor: pointer; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.02); transition: opacity 0.2s;";
            
            // 玻璃中间的小提示字
            const hint = document.createElement('div');
            hint.textContent = '点击激活组件';
            hint.style.cssText = "background: rgba(255, 255, 255, 0.9); padding: 4px 12px; border-radius: 12px; font-size: 10px; color: #555; box-shadow: 0 2px 8px rgba(0,0,0,0.1); pointer-events: none;";
            overlay.appendChild(hint);
            // 1. 当用户【轻点】时，玻璃隐形并取消物理碰撞，让手指能碰到里面的网页
            overlay.addEventListener('click', (e) => {
                e.stopPropagation(); 
                overlay.style.opacity = '0';
                overlay.style.pointerEvents = 'none'; // 关键：让鼠标穿透玻璃
            });
            // 2. 当用户点击屏幕【其他地方】时，玻璃重新盖上，保证随时可以重新长按
            document.addEventListener('click', (e) => {
                if (!wrapper.contains(e.target)) {
                    overlay.style.opacity = '1';
                    overlay.style.pointerEvents = 'auto'; // 恢复玻璃的碰撞体积
                }
            });
            wrapper.appendChild(overlay);
        bubble.appendChild(wrapper);

        // 监听内部传出来的高度，自动计算等比缩小后的外壳高度
        const messageHandler = (event) => {
            if (event.data && event.data.type === 'resize_html' && event.data.id === String(messageData.id)) {
                const realHeight = event.data.height;
                // 按0.75比例算出实际显示的高度
                const scaledHeight = realHeight * 0.75;
                iframe.style.height = realHeight + 'px';
                wrapper.style.height = scaledHeight + 'px';
                // 收到消息后关闭监听，省点内存
                window.removeEventListener('message', messageHandler);
            }
        };
        window.addEventListener('message', messageHandler);

        iframe.onerror = function() {
            wrapper.innerHTML = '<div style="padding:10px; color:#999; font-size:12px; text-align:center;">[交互组件加载异常]</div>';
        };
    }    else if (isReceipt) {

        // 获取数据
        const info = messageData.receiptInfo || {};
        const items = info.items || [];
        const total = info.total || 0;
        const delivery = info.deliveryInfo || {}; // 获取配送信息
        
        // 1. 生成正面 (清单列表)
        const listHtml = items.map(item => `
            <div class="list-item">
                <div class="item-info">
                    <span class="name">${escapeHTML(item.name)}</span>
                    <span class="specs">${escapeHTML(item.specs || '默认规格')}</span>
                </div>
                <div class="item-cost">
                    <div class="price">¥${item.price}</div>
                    <div class="count">x${item.count}</div>
                </div>
            </div>
        `).join('');

        // 2. 生成背面 (地址信息)
        // 注意：如果是“自提”或者没地址，要做个兼容显示
        const addressText = delivery.address || '自提 / 无需配送';
        const phoneText = delivery.phone || '--';
        const timeText = delivery.time || '即刻生效';

        // 3. 组装 HTML
        // 注意：我们在最外层容器根据列表长度动态计算一下高度，防止太矮
        // 基础高度 120px + 每行约 40px，最少 220px
        const dynamicHeight = Math.max(220, 120 + items.length * 40);

        bubble.innerHTML = `
            <div class="receipt-card-3d" style="height: ${dynamicHeight}px;">
                
                <!-- 正面：购物清单 -->
                <div class="card-face face-front">
                    <div class="front-header">
                        <span class="brand">LOOKY RECEIPT</span>
                        <span class="title">Shopping List</span>
                    </div>
                    <div class="front-list-area">
                        ${listHtml}
                    </div>
                    <div class="front-footer">
                        <div class="hint">
                            <span>配送信息</span>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                        </div>
                        <span class="total-price">Total: ¥${total.toFixed(2)}</span>
                    </div>
                </div>

                <!-- 背面：配送信息 -->
                <div class="card-face face-back">
                    <div class="back-content">
                        <div class="info-group">
                            <div class="label">Delivery Address</div>
                            <div class="value">${escapeHTML(addressText)}</div>
                        </div>
                        <div class="info-group">
                            <div class="label">Contact Phone</div>
                            <div class="value" style="font-family:monospace;">${escapeHTML(phoneText)}</div>
                        </div>
                        <div class="info-group">
                            <div class="label">Estimated Time</div>
                            <div class="value large">${escapeHTML(timeText)}</div>
                        </div>
                    </div>
                     <div class="back-stamp" style="${messageData.isAiGift ? 'color:#d93025; border-color:#d93025;' : 'color:#e0e0e0; border-color:#e0e0e0;'}">
                        ${messageData.isAiGift ? 'CHAR. PAID' : 'PAID'}
                    </div>
                </div>
            </div>
        `;

        // 4. 绑定翻转事件
        const card = bubble.querySelector('.receipt-card-3d');
        if (card) {
            card.addEventListener('click', (e) => {
                e.stopPropagation();
                card.classList.toggle('flipped');
            });
        }
    }else if (isProductShare) {
        // 获取数据 (兼容字符串和对象格式)
        const data = typeof messageData.content === 'string' ? JSON.parse(messageData.content) : messageData.content;
        
        // 构造极简设计卡片 HTML
        // 注意：我们把 data 对象转回 JSON 字符串存到 dataset 里，方便点击时读取
        const dataStr = JSON.stringify(data).replace(/"/g, '&quot;');
        
        bubble.innerHTML = `
            <div class="product-share-card" data-product='${dataStr}'>
                <!-- 顶部封面 -->
                <div class="share-cover" style="background-image: url('${data.imgUrl}');"></div>
                
                <!-- 中部信息 -->
                <div class="share-info">
                    <div class="share-title">${escapeHTML(data.title)}</div>
                    <div class="share-meta">
                        <span class="currency">¥</span>
                        <span class="price">${data.price}</span>
                    </div>
                </div>
                <!-- 底部 Footer (纯色图标) -->
                <div class="share-footer">
                    <span class="brand">Looky Selection</span>
             <div class="icon-wrap">
    <!-- 实心购物袋图标 -->
    <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M16 6V4a4 4 0 0 0-8 0v2H4v16h16V6h-4zm-6-2a2 2 0 0 1 4 0v2h-4V4z"></path>
    </svg>
</div>

                </div>
            </div>
        `;

        // 绑定点击事件：跳转到商品详情页
        const card = bubble.querySelector('.product-share-card');
        card.addEventListener('click', async (e) => {
            e.stopPropagation(); 
            
            // 1. 从 dataset 拿回数据
            const productData = JSON.parse(card.getAttribute('data-product'));
            
            // 2. 动态导入 UI 模块进行跳转
            const { showPage } = await import('../ui.js');
            const detailPage = document.getElementById('page-life-product-detail');
            
            if (detailPage) {
                // 3. 填充详情页数据
                detailPage.querySelector('#shop-detail-img').style.backgroundImage = `url('${productData.imgUrl}')`;
                detailPage.querySelector('#shop-detail-title').textContent = productData.title;
                detailPage.querySelector('#shop-detail-price').textContent = productData.price;
                
                const salesEl = detailPage.querySelector('.sales');
                if(salesEl) salesEl.textContent = productData.sales ? `月销 ${productData.sales}` : '热销中';
                
                // 填充隐藏数据，方便下单
                detailPage.dataset.currentSpecs = productData.specs || '';
                
                // 设置返回按钮：让它返回到聊天界面，而不是购物主页
                const backBtn = detailPage.querySelector('.back-button');
                if(backBtn) backBtn.setAttribute('data-target', 'page-chat-detail');
                
                // 4. 执行跳转
                showPage('page-life-product-detail');
            }
        });

    }     else if (isProductCommand) {
        const data = typeof messageData.content === 'string' ? JSON.parse(messageData.content) : messageData.content;
        bubble.className = 'message-bubble product-command-bubble';
        
        // 视觉设计：纯白背景、黑色细边框、全灰色调、无图标
        bubble.style.cssText = "background: #fff; border: 1px solid #000; padding: 14px; border-radius: 4px; color: #000; cursor: pointer; max-width: 220px; font-family: 'Helvetica', sans-serif;";
        
        bubble.innerHTML = `
            <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 2px; color: #888; margin-bottom: 10px; border-bottom: 1px solid #eee; padding-bottom: 4px;">Item Command</div>
            <div style="font-weight: bold; font-size: 15px; margin-bottom: 12px; line-height: 1.2;">${escapeHTML(data.title)}</div>
            <div style="background: #f5f5f5; padding: 10px; text-align: center; margin-bottom: 12px; border-radius: 2px;">
                <div style="font-family: monospace; font-size: 18px; letter-spacing: 2px;">${data.token}</div>
            </div>
            <div style="font-size: 10px; color: #000; display: flex; justify-content: space-between; align-items: center; font-weight: bold;">
                <span>ACCESS DETAILS</span>
                <span>→</span>
            </div>
        `;
        bubble.addEventListener('click', (e) => {
            e.stopPropagation();
            if (window.openProductDetail) {
                window.openProductDetail({ title: data.title, price: data.price, imgUrl: data.imgUrl, sales: data.sales, specs: data.specs }, 'page-chat-detail');
            }
        });
    }
    else if (isLogistics) {
        const info = messageData.content || {};
        
        // ▼▼▼ 【新增】读取本地存储的状态，判断是否已送达 ▼▼▼
        let statusTextFront = "正在发货";
        let statusColorFront = "#000"; // 默认黑色背景
        let valueTextBack = info.deliveryTime; // 默认显示 "5 轮对话后"
        let valueColorBack = "#000"; // 默认黑色文字

        // 尝试从 localStorage 读取该角色的礼物状态
        const savedGiftsRaw = localStorage.getItem('active_gifts_state');
        if (savedGiftsRaw) {
            try {
                const savedGifts = JSON.parse(savedGiftsRaw);
                // 遍历所有角色的礼物列表，找到当前这条消息对应的礼物
                // savedGifts 是 { charId: [gift1, gift2...] } 的结构
                for (const charId in savedGifts) {
                    const gifts = savedGifts[charId];
                    // 找到 msgId 匹配的那个礼物记录
                    const myGift = gifts.find(g => String(g.msgId) === String(messageData.id));
                    
                    if (myGift) {
                        // 如果找到了记录
                        if (myGift.status === 'delivered') {
                            // 如果状态是已送达
                            statusTextFront = "已签收";
                            statusColorFront = "#34c759"; // 绿色
                            valueTextBack = "已送达";
                            valueColorBack = "#34c759"; // 绿色
                        } else {
                            // 如果还在路上，显示剩余轮数
                            valueTextBack = `${myGift.remaining} 轮对话后`;
                        }
                        break; // 找到了就不用再找了
                    }
                }
            } catch(e) { console.error(e); }
        }
        // ▲▲▲ 新增结束 ▲▲▲
        
        bubble.innerHTML = `
            <div class="logistics-card">
                <!-- 正面 -->
                <div class="card-face face-front">
                    <div class="front-header">
                        <span class="brand">LOOKY EXPRESS</span>
                        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>
                    </div>
                    <div class="front-body">
                        <div class="thumb" style="background-image: url('${info.img || ''}');"></div>
                        <div class="info">
                            <span class="title">${escapeHTML(info.title)}</span>
                            <span class="specs">${escapeHTML(info.specs || '标准规格')}</span>
                            <!-- 使用动态变量 -->
                            <span class="status" style="background-color: ${statusColorFront};">${statusTextFront}</span>
                        </div>
                    </div>
                    <div class="front-footer">
                        <span>点击查看配送详情</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
                    </div>
                </div>

                <!-- 背面 -->
                <div class="card-face face-back">
                    <div style="position: absolute; right: 10px; top: 10px; border: 2px solid #e0e0e0; color: #e0e0e0; font-size: 12px; font-weight: 900; padding: 4px; border-radius: 4px; transform: rotate(-15deg); letter-spacing: 1px;">PAID</div>
                    <div class="back-row">
                        <span class="label">配送至</span>
                        <span class="value">${escapeHTML(info.address || '未填写地址')}</span>
                    </div>

                    <div class="back-row">
                        <span class="label">联系电话</span>
                        <span class="value" style="font-family:monospace;">${escapeHTML(info.phone || '--')}</span>
                    </div>
                    <div class="back-row">
                        <span class="label">预计送达</span>
                        <!-- 使用动态变量 -->
                        <span class="value highlight" style="color: ${valueColorBack};">${escapeHTML(valueTextBack)}</span>
                    </div>
                    <div class="back-barcode"></div>
                </div>
            </div>
        `;
        // 绑定翻转事件
        const card = bubble.querySelector('.logistics-card');
        if (card) {
            card.addEventListener('click', (e) => {
                e.stopPropagation();
                card.classList.toggle('flipped');
            });
        }

    } else if (isPasswordCard) {
        // 解析密码数据
        const data = typeof messageData.content === 'string' ? JSON.parse(messageData.content) : messageData.content;
        
        // 日杂文艺风卡片 HTML
        bubble.innerHTML = `
            <div class="password-card" title="点击复制密码">
                <div class="pwd-header">ACCESS KEY / 端末パスワード</div>
                <div class="pwd-body">
                    <div class="pwd-number">${escapeHTML(data.pwd)}</div>
                    <div class="pwd-hint">${escapeHTML(data.hint || '解锁我的世界')}</div>
                </div>
                <div class="pwd-footer">
                    <div class="pwd-barcode">||||||||||||||||||</div>
                    <span>TAP TO COPY</span>
                </div>
            </div>
        `;

        // 绑定点击复制密码事件
        const card = bubble.querySelector('.password-card');
        if (card) {
            card.addEventListener('click', (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(data.pwd).then(() => {
                    // 调用你已有的灵动岛组件提示
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('密码已复制', 'success');
                });
            });
        }
    } else if (isMusicShare) {
        const musicData = typeof messageData.content === 'string' ? JSON.parse(messageData.content) : messageData.content;
        
        // 生成纯净版歌词，去掉时间轴 [00:00.00] 这种东西
        const rawLyric = musicData.lyric || '暂无歌词';
        const cleanLyricLines = rawLyric
            .split('\n')
            .map(line => line.replace(/\[\d{2}:\d{2}(?:\.\d{2,3})?\]/g, '').trim())
            .filter(line => line !== '');
        // 截取前6行歌词作为预览
        const displayLyrics = cleanLyricLines.length > 0 
            ? cleanLyricLines.slice(0, 6).join('<br>') + (cleanLyricLines.length > 6 ? '<br>...' : '')
            : '纯音乐，请欣赏';

        bubble.innerHTML = `
            <div class="music-share-card">
                <!-- ▼ 新增：顶部日杂风装饰文字与线条 ▼ -->
                <div class="music-top-deco">
                    <span class="deco-text">♫ DAILY SOUNDTRACK</span>
                    <span class="deco-line"></span>
                </div>
                
                <!-- 唱片与封面区 -->
                <div class="music-card-header">
                    <div class="music-cover-wrap">
                        <img src="${musicData.cover || 'images/default-avatar.svg'}" class="music-cover">
                        <!-- ▼ 新增：封面上的毛玻璃播放图标 ▼ -->
                        <div class="play-icon-overlay">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                        </div>
                        <!-- 高级质感黑胶唱片 -->
                        <div class="vinyl-record-deco"></div>
                    </div>
                    <div class="music-info-wrap">
                        <div class="music-title">${escapeHTML(musicData.title)}</div>
                        <div class="music-artist">${escapeHTML(musicData.artist)}</div>
                    </div>
                </div>
                
                <!-- 下拉歌词区 -->
                <div class="music-lyrics-collapse">
                    <div class="lyrics-content">
                        ${displayLyrics}
                    </div>
                </div>

                <!-- 底部操作提示 -->
                <div class="music-card-footer">
                    <span>▽ 展开歌词</span>
                </div>
            </div>
        `;

        // 绑定点击事件：卡片播放音乐，底部按钮展开/收起歌词
        const card = bubble.querySelector('.music-share-card');

        if (card) {
            card.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!window.MusicPlayer) return;
                const targetIdx = window.MusicPlayer.globalPlaylist.findIndex(s => s.title === musicData.title && s.artist === musicData.artist);
                if (targetIdx !== -1) {
                    window.MusicPlayer.playlist = [...window.MusicPlayer.globalPlaylist];
                } else {
                    window.MusicPlayer.playlist = [musicData];
                }
                const playIndex = targetIdx !== -1 ? targetIdx : 0;
                window.MusicPlayer.updatePlaylistDrawer();
                window.MusicPlayer.playSongAtIndex(playIndex);
                if (typeof showDynamicIsland === 'function') showDynamicIsland(`正在播放: ${musicData.title}`, 'success');
            });
            const footer = card.querySelector('.music-card-footer');
            if (footer) footer.addEventListener('click', (e) => {
                e.stopPropagation();
                card.classList.toggle('expanded');
                const footerSpan = card.querySelector('.music-card-footer span');
                if (card.classList.contains('expanded')) {
                    footerSpan.textContent = '△ 收起';
                } else {
                    footerSpan.textContent = '▽ 展开歌词';
                }
            });
        }
    }    else if (isPlaylistShare || isPlaylistInvite) {
        const playlistData = typeof messageData.content === 'string' ? JSON.parse(messageData.content) : messageData.content;
        const playlistSongs = Array.isArray(playlistData.songs) ? playlistData.songs.filter(song => song && song.title) : [];
        const isProcessed = messageData.inviteStatus === 'accepted' || messageData.inviteStatus === 'rejected';
        const playSharedPlaylist = async (startTogether = false) => {
            if (!window.MusicPlayer || playlistSongs.length === 0) return;
            window.MusicPlayer.playlist = playlistSongs.map(song => ({
                title: song.title,
                artist: song.artist || '未知歌手',
                cover: song.cover || playlistData.cover || 'images/default-avatar.svg',
                src: song.src || '',
                lyric: song.lyric || '',
                neteaseId: song.neteaseId || null
            }));
            window.MusicPlayer.updatePlaylistDrawer();
            await window.MusicPlayer.playSongAtIndex(0);
            if (startTogether) {
                const char = AppState.characterProfiles.find(c => c.id === messageData.chatId);
                window.MusicPlayer.currentListeningChar = char;
                window.MusicPlayer.startListeningSession(char);
            }
        };
        const saveSharedPlaylist = async () => {
            if (!window.MusicPlayer || playlistSongs.length === 0) return;
            const exists = window.MusicPlayer.groups.some(group =>
                group.name === playlistData.title &&
                Array.isArray(group.songs) &&
                group.songs.length === playlistSongs.length
            );
            if (exists) {
                if (typeof showDynamicIsland === 'function') showDynamicIsland('这个歌单已经收藏过了', 'info');
                return;
            }
            window.MusicPlayer.groups.push({
                id: `shared_playlist_${messageData.id || Date.now()}`,
                name: playlistData.title || '分享歌单',
                desc: playlistData.desc || '来自聊天分享',
                cover: playlistData.cover || 'images/default-avatar.svg',
                songs: playlistSongs.map(song => ({
                    title: song.title,
                    artist: song.artist || '未知歌手',
                    cover: song.cover || playlistData.cover || 'images/default-avatar.svg',
                    src: song.src || '',
                    lyric: song.lyric || '',
                    neteaseId: song.neteaseId || null
                }))
            });
            await window.MusicPlayer.saveGroupsToLocal();
            window.MusicPlayer.renderGroupsToDOM();
            if (typeof showDynamicIsland === 'function') showDynamicIsland('歌单已收藏', 'success');
        };
        if (isPlaylistInvite) {
            let btnHtml = '';
            if (messageData.inviteStatus === 'pending' || !messageData.inviteStatus) {
                btnHtml = `
                    <button class="btn-reject-music btn-reject-playlist">婉拒</button>
                    <button class="btn-accept-music btn-accept-playlist">一起听</button>
                `;
            } else if (messageData.inviteStatus === 'accepted') {
                btnHtml = `<span class="status-text">已接受，正在沉浸陪伴</span>`;
            } else {
                btnHtml = `<span class="status-text">已婉拒</span>`;
            }

            bubble.innerHTML = `
                <div class="music-invite-card ${isProcessed ? 'processed' : ''}" data-message-id="${messageData.id}">
                    <div class="mi-header">
                        <span class="mi-tag">PLAYLIST INVITE</span>
                    </div>
                    <div class="mi-body">
                        <img src="${playlistData.cover || 'images/default-avatar.svg'}" class="mi-cover">
                        <div class="mi-info">
                            <div class="mi-title">${escapeHTML(playlistData.title || '一起听歌单')}</div>
                            <div class="mi-artist">${escapeHTML(playlistData.desc || playlistData.count || `${playlistSongs.length} 首歌曲`)}</div>
                        </div>
                    </div>
                    <div class="mi-footer">
                        ${btnHtml}
                    </div>
                </div>
            `;

            if (!isProcessed) {
                const btnAccept = bubble.querySelector('.btn-accept-playlist');
                const btnReject = bubble.querySelector('.btn-reject-playlist');
                if (btnAccept) btnAccept.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await db.chatMessages.update(messageData.id, { inviteStatus: 'accepted' });
                    const msgInMem = AppState.currentChatHistory.find(m => m.id === messageData.id);
                    if (msgInMem) msgInMem.inviteStatus = 'accepted';
                    bubble.querySelector('.mi-footer').innerHTML = `<span class="status-text">已接受，正在沉浸陪伴</span>`;
                    bubble.querySelector('.music-invite-card').classList.add('processed');
                    await playSharedPlaylist(true);
                    const { addSystemEventMessage } = await import('./chat-service.js');
                    await addSystemEventMessage(messageData.chatId, `你接受了邀请，正在一起听歌单《${playlistData.title}》`, 'info');
                });
                if (btnReject) btnReject.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await db.chatMessages.update(messageData.id, { inviteStatus: 'rejected' });
                    const msgInMem = AppState.currentChatHistory.find(m => m.id === messageData.id);
                    if (msgInMem) msgInMem.inviteStatus = 'rejected';
                    bubble.querySelector('.mi-footer').innerHTML = `<span class="status-text">已婉拒</span>`;
                    bubble.querySelector('.music-invite-card').classList.add('processed');
                    const { addSystemEventMessage } = await import('./chat-service.js');
                    await addSystemEventMessage(messageData.chatId, `你婉拒了一起听歌单邀请`, 'info');
                });
            }
        } else {
            // 生成歌曲列表 HTML
            const songsHtml = playlistSongs.map((song, idx) => `
                <div class="playlist-song-row">
                    <span class="idx">${idx + 1}</span>
                    <div class="song-info">
                        <span class="title">${escapeHTML(song.title)}</span>
                        <span class="artist">${escapeHTML(song.artist || '未知歌手')}</span>
                    </div>
                </div>
            `).join('');
            bubble.innerHTML = `
                <div class="playlist-share-card">
                    <!-- 顶部海报区 -->
                    <div class="playlist-card-hero" style="background-image: url('${playlistData.cover || 'images/default-avatar.svg'}');">
                        <div class="hero-overlay">
                            <div class="hero-tag">PLAYLIST</div>
                            <div class="hero-title">${escapeHTML(playlistData.title || '分享歌单')}</div>
                            <div class="hero-desc">${escapeHTML(playlistData.desc || playlistData.count || '精选歌单')}</div>
                        </div>
                    </div>
                    
                    <!-- 隐藏的歌曲列表区 -->
                    <div class="playlist-songs-collapse">
                        <div class="songs-list-container">
                            ${songsHtml}
                            ${playlistSongs.length === 0 ? '<div class="more-hint">暂无曲目</div>' : ''}
                        </div>
                    </div>
                    <div class="playlist-card-actions">
                        <button class="playlist-play-btn">播放全部</button>
                        <button class="playlist-save-btn">收藏歌单</button>
                    </div>
                    <!-- 底部操作提示 -->
                    <div class="playlist-card-footer">
                        <span>▽ 查看曲目</span>
                    </div>
                </div>
            `;
        // 绑定点击事件，实现折叠/展开效果
        const card = bubble.querySelector('.playlist-share-card');
        if (card) {
            card.addEventListener('click', (e) => {
                e.stopPropagation();
                card.classList.toggle('expanded');
                const footerSpan = card.querySelector('.playlist-card-footer span');
                if (card.classList.contains('expanded')) {
                    footerSpan.textContent = '△ 收起';
                } else {
                    footerSpan.textContent = '▽ 查看曲目';
                }
            });
            const playBtn = card.querySelector('.playlist-play-btn');
            if (playBtn) playBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await playSharedPlaylist(false);
            });
            const saveBtn = card.querySelector('.playlist-save-btn');
            if (saveBtn) saveBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await saveSharedPlaylist();
            });
            }
        }
    } else if (isMusicInvite) {
        // ▼▼▼ 新增：渲染AI发出的听歌邀请卡片 ▼▼▼
        const songData = typeof messageData.content === 'string' ? JSON.parse(messageData.content) : messageData.content;
        const isProcessed = messageData.inviteStatus === 'accepted' || messageData.inviteStatus === 'rejected';
        
        let btnHtml = '';
        if (messageData.inviteStatus === 'pending' || !messageData.inviteStatus) {
            btnHtml = `
                <button class="btn-reject-music">婉拒</button>
                <button class="btn-accept-music">一起听</button>
            `;
        } else if (messageData.inviteStatus === 'accepted') {
            btnHtml = `<span class="status-text">已接受，正在沉浸陪伴</span>`;
        } else {
            btnHtml = `<span class="status-text">已婉拒</span>`;
        }

        bubble.innerHTML = `
            <div class="music-invite-card ${isProcessed ? 'processed' : ''}" data-message-id="${messageData.id}">
                <div class="mi-header">
                    <span class="mi-tag">MUSIC INVITE</span>
                </div>
                <div class="mi-body">
                    <img src="${songData.cover || 'images/default-avatar.svg'}" class="mi-cover">
                    <div class="mi-info">
                        <div class="mi-title">${escapeHTML(songData.title)}</div>
                        <div class="mi-artist">${escapeHTML(songData.artist)}</div>
                    </div>
                </div>
                <div class="mi-footer">
                    ${btnHtml}
                </div>
            </div>
        `;

        // 绑定两个按钮的交互事件
        if (!isProcessed) {
            const btnAccept = bubble.querySelector('.btn-accept-music');
            const btnReject = bubble.querySelector('.btn-reject-music');
            
            // 点击接受
            if (btnAccept) {
                btnAccept.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    // 1. 改变数据库状态
                    await db.chatMessages.update(messageData.id, { inviteStatus: 'accepted' });
                    const msgInMem = AppState.currentChatHistory.find(m => m.id === messageData.id);
                    if (msgInMem) msgInMem.inviteStatus = 'accepted';
                    
                    // 2. 界面变灰
                    bubble.querySelector('.mi-footer').innerHTML = `<span class="status-text">已接受，正在沉浸陪伴</span>`;
                    bubble.querySelector('.music-invite-card').classList.add('processed');
                     // 3. 核心：启动底层的音乐播放器！
                    if (window.MusicPlayer) {
                        const targetIdx = window.MusicPlayer.globalPlaylist.findIndex(s => s.title === songData.title && s.artist === songData.artist);
                        if (targetIdx !== -1) {
                            window.MusicPlayer.playlist = [...window.MusicPlayer.globalPlaylist];
                        } else {
                            window.MusicPlayer.playlist = [songData];
                        }
                        const playIndex = targetIdx !== -1 ? targetIdx : 0;
                        window.MusicPlayer.updatePlaylistDrawer();
                        window.MusicPlayer.playSongAtIndex(playIndex); // 开始播放
                        
                        const char = AppState.characterProfiles.find(c => c.id === messageData.chatId);
                        window.MusicPlayer.currentListeningChar = char;
                        window.MusicPlayer.startListeningSession(char); // 激活小组件的“一起听”UI
                        
                        // ▼▼▼ 新增：完美修复悬浮窗头像空白的Bug ▼▼▼
                        try {
                            const user = getCurrentChatIdentity();
                            // 优先取专属聊天头像，没有则取全局头像
                            const finalUserAvatar = (char && char.chatOverrideUserAvatar) ? char.chatOverrideUserAvatar : (user ? user.avatar : 'images/default-avatar.svg');
                            const finalCharAvatar = (char && char.chatOverrideAvatar) ? char.chatOverrideAvatar : (char ? char.avatar : 'images/default-avatar.svg');
                            
                            const userAvatarEl = document.getElementById('listening-user-avatar');
                            const charAvatarEl = document.getElementById('listening-char-avatar');
                            if(userAvatarEl) userAvatarEl.src = finalUserAvatar;
                            if(charAvatarEl) charAvatarEl.src = finalCharAvatar;
                        } catch(err) { console.error('设置一起听头像失败', err); }
                        // ▲▲▲ 新增结束 ▲▲▲
                        
                        const { addSystemEventMessage } = await import('./chat-service.js');
                        await addSystemEventMessage(messageData.chatId, `你接受了邀请，正在一起听《${songData.title}》`, 'info');
                    }

                });
            }
            // 点击婉拒
            if (btnReject) {
                btnReject.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await db.chatMessages.update(messageData.id, { inviteStatus: 'rejected' });
                    const msgInMem = AppState.currentChatHistory.find(m => m.id === messageData.id);
                    if (msgInMem) msgInMem.inviteStatus = 'rejected';
                    
                    bubble.querySelector('.mi-footer').innerHTML = `<span class="status-text">已婉拒</span>`;
                    bubble.querySelector('.music-invite-card').classList.add('processed');
                    
                    const { addSystemEventMessage } = await import('./chat-service.js');
                    await addSystemEventMessage(messageData.chatId, `你婉拒了听歌邀请`, 'info');
                });
            }
        }
        // ▲▲▲ 新增结束 ▲▲▲

    }
   else if (isPayRequest && messageData.payRequestInfo) {

        const info = messageData.payRequestInfo;
        const status = info.status || 'pending';
        // 判断是否是行程单 (根据名字中是否包含 '行程' 二字)
        const isRide = info.name && info.name.includes('行程');
        const isFlight = info.name && info.name.includes('机票');
         const isTrain = info.name && info.name.includes('高铁');
        // 判断这条消息是不是我发的
        const isMine = messageData.type === 'sent'; 
        let statusClass = '';
        let footerHtml = '';
        const bindAction = (action) => {
            return `onclick="document.dispatchEvent(new CustomEvent('payRequestAction', { detail: { id: ${messageData.id}, action: '${action}' } }))"`;
        };

        // --- 底部按钮逻辑 ---
        if (status === 'pending') {
            if (isMine) {
                footerHtml = `<div class="status-text">等待对方支付...</div>`;
            } else {
                footerHtml = `
                    <button class="btn-reject" ${bindAction('rejected')}>拒绝</button>
                    <button class="btn-pay" ${bindAction('completed')}>${isRide ? '帮TA支付' : '去支付'}</button>
                `;
            }
        } else {
            if (status === 'completed') statusClass = 'status-completed';
            else if (status === 'rejected') statusClass = 'status-rejected';
            else if (status === 'expired') statusClass = 'status-expired';
            const statusMap = { 'completed': '已完成支付', 'rejected': '已婉拒', 'expired': '已失效' };
            footerHtml = `<div class="status-text">${statusMap[status]}</div>`;
        }
        // --- 核心修改：黄金比例文艺车票 (Standard Classic Ticket) ---
        if (isRide) {
            // 提取目的地名称，去掉"行程: "前缀
            const destName = escapeHTML(info.name.replace('行程: ', '').replace('行程：', ''));
            // 提取首字母作为装饰水印 (例如 "机" -> "J" 或直接取字)
            const firstLetter = destName.charAt(0); 
            
            bubble.innerHTML = `
                <div class="pay-request-card style-ride-classic ${statusClass}" id="pay-req-${messageData.id}">
                    
                    <!-- 1. 背景纹理图 (请确保images目录下有 back.png，没有的话会透出白底也不丑) -->
                    <img src="images/back.png" class="card-bg-texture" alt="" onerror="this.style.display='none'">
                    
                    <!-- 2. 装饰：巨大的背景水印 -->
                    <div class="card-watermark">${firstLetter}</div>

                    <!-- 3. 核心：内缩的票据虚线框 -->
                    <div class="card-inner-border">
                        
                        <!-- 头部：日期与类型 -->
                        <div class="card-header-row">
                            <span class="header-tag">TAXI TICKET</span>
                            <span class="header-date">${new Date().toLocaleDateString().replace(/\//g, '.')}</span>
                        </div>

                        <!-- 中部：目的地与详情 -->
                        <div class="card-main-content">
                            <div class="label-small">DESTINATION</div>
                            <div class="dest-text">${destName}</div>
                            
                            <div class="specs-divider">
                                <span class="line"></span>
                                <span class="dot"></span>
                                <span class="line"></span>
                            </div>

                            <div class="info-row">
                                <span class="car-specs">${info.specs ? escapeHTML(info.specs) : '专车服务'}</span>
                                <span class="price-val">¥${info.price}</span>
                            </div>
                        </div>

                        <!-- 底部：按钮区 -->
                        <div class="card-action-area">
                            ${footerHtml}
                        </div>
                    </div>
                </div>
            `;
                   } else if (isFlight) {
            // 提取航线名称 "CityA - CityB"
            const routeName = escapeHTML(info.name.replace('机票: ', '').replace('机票：', ''));
            // 水印图标改为 "✈"
            
            bubble.innerHTML = `
                <div class="pay-request-card style-ride-classic ${statusClass}" id="pay-req-${messageData.id}">
                    <img src="images/back.png" class="card-bg-texture" alt="" onerror="this.style.display='none'">
                    
                    <!-- 飞机专属水印 -->
                    <div class="card-watermark" style="font-size: 80px; opacity: 0.08;">✈</div>
                    <div class="card-inner-border">
                        <div class="card-header-row">
                            <span class="header-tag">FLIGHT TICKET</span>
                            <span class="header-date">${new Date().toLocaleDateString().replace(/\//g, '.')}</span>
                        </div>
                        <div class="card-main-content">
                            <div class="label-small">ROUTE</div>
                            <div class="dest-text" style="font-size: 20px;">${routeName}</div>
                            
                            <div class="specs-divider">
                                <span class="line"></span>
                                <span class="dot"></span>
                                <span class="line"></span>
                            </div>
                            <div class="info-row">
                                <span class="car-specs">${info.specs ? escapeHTML(info.specs) : '经济舱'}</span>
                                <span class="price-val">¥${info.price}</span>
                            </div>
                        </div>
                        <div class="card-action-area">
                            ${footerHtml}
                        </div>
                    </div>
                </div>
            `;
             } else if (isTrain) {
            const routeName = escapeHTML(info.name.replace('高铁票: ', '').replace('高铁票：', ''));
            bubble.innerHTML = `
                <div class="pay-request-card style-ride-classic ${statusClass}" id="pay-req-${messageData.id}">
                    <img src="images/back.png" class="card-bg-texture" alt="" onerror="this.style.display='none'">
                    <div class="card-watermark" style="font-size: 80px; opacity: 0.08;">🚄</div>
                    <div class="card-inner-border">
                        <div class="card-header-row">
                            <span class="header-tag">TRAIN TICKET</span>
                            <span class="header-date">${new Date().toLocaleDateString().replace(/\//g, '.')}</span>
                        </div>
                        <div class="card-main-content">
                            <div class="label-small">ROUTE</div>
                            <div class="dest-text" style="font-size: 20px;">${routeName}</div>
                            <div class="specs-divider"><span class="line"></span><span class="dot"></span><span class="line"></span></div>
                            <div class="info-row">
                                <span class="car-specs">${info.specs ? escapeHTML(info.specs) : '二等座'}</span>
                                <span class="price-val">¥${info.price}</span>
                            </div>
                        </div>
                        <div class="card-action-area">
                            ${footerHtml}
                        </div>
                    </div>
                </div>
            `;
            } else if (info.type === 'shop_pay') {
            // 如果包含 items 数组，说明是新版购物车代付，渲染清单样式
            if (info.items && info.items.length > 0) {
                const itemsHtml = info.items.map(i => `
                    <div class="shop-list-item">
                        <div class="item-thumb" style="background-image: url('${i.img}');"></div>
                        <div class="item-details">
                            <div class="item-title">${escapeHTML(i.title)}</div>
                            <div class="item-meta">
                                <span>${escapeHTML(i.specs || '')}</span>
                                <span class="item-price">¥${i.price}</span>
                            </div>
                        </div>
                    </div>
                `).join('');

                const moreText = info.totalCount > info.items.length 
                    ? `<div class="shop-list-more">... 以及其他 ${info.totalCount - info.items.length} 件商品</div>` 
                    : '';

                bubble.innerHTML = `
                    <div class="pay-request-card style-shop-list ${statusClass}" id="pay-req-${messageData.id}">
                        <div class="list-card-header">
                            <span class="title">代付请求</span>
                            <span class="total-badge">¥${info.price}</span>
                        </div>
                        <div class="list-card-body">
                            ${itemsHtml}
                            ${moreText}
                        </div>
                        <div class="list-card-footer">
                            ${footerHtml}
                        </div>
                    </div>
                `;
            } else {
                // 旧版单商品样式 (保持不变)
                bubble.innerHTML = `
                    <div class="pay-request-card style-shop-minimal ${statusClass}" id="pay-req-${messageData.id}">
                        <div class="shop-card-header">
                            <span class="brand-tag">LOOKY SHOP</span>
                            <span class="req-tag">代付请求</span>
                        </div>
                        <div class="shop-card-body">
                            <div class="shop-img" style="background-image: url('${info.imageUrl || 'images/default-avatar.svg'}');"></div>
                            <div class="shop-info">
                                <div class="shop-title">${escapeHTML(info.name)}</div>
                                <div class="shop-specs">规格: ${escapeHTML(info.specs || '标准')}</div>
                                <div class="shop-price-row">
                                    <span class="currency">¥</span>
                                    <span class="amount">${info.price}</span>
                                </div>
                            </div>
                        </div>
                        <div class="shop-divider">
                            <div class="half-circle left"></div>
                            <div class="dashed-line"></div>
                            <div class="half-circle right"></div>
                        </div>
                        <div class="shop-card-footer">
                            ${footerHtml}
                        </div>
                    </div>
                `;
            }
        }         else {
            // --- 外卖/通用代付样式 (修复消失的关键：给外卖一个默认位置) ---
            bubble.innerHTML = `
                <div class="pay-request-card style-shop-minimal ${statusClass}" id="pay-req-${messageData.id}">
                    <div class="shop-card-header">
                        <span class="brand-tag">TAKEAWAY</span>
                        <span class="req-tag">代付请求</span>
                    </div>
                    <div class="shop-card-body">
                        <div class="shop-img" style="background-image: url('${info.imageUrl || 'images/default-food.jpg'}');"></div>
                        <div class="shop-info">
                            <div class="shop-title">${escapeHTML(info.name)}</div>
                            <div class="shop-specs">规格: ${escapeHTML(info.specs || '标准')}</div>
                            <div class="shop-price-row">
                                <span class="currency">¥</span>
                                <span class="amount">${info.price}</span>
                            </div>
                        </div>
                    </div>
                    <div class="shop-card-footer">${footerHtml}</div>
                </div>`;
        }

    }
else if (isTransfer && messageData.transferInfo) {
        const info = messageData.transferInfo;
        const status = info.status;
        const isSentByUser = messageData.type === 'sent';
        let statusText, cardClass, footerText, iconSVG;
        const transferIcon = `<svg class="transfer-icon" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="white"/><path d="M66,38 L50,22 M50,22 L34,38" stroke="#FA9D3B" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M50,24 L50,78" stroke="#FA9D3B" stroke-width="6" fill="none" stroke-linecap="round"/><path d="M34,62 L50,78 M50,78 L66,62" stroke="#FA9D3B" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        const acceptedIcon = `<svg class="transfer-icon" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="white"/><path d="M30 52 L45 67 L70 42" stroke="#FA9D3B" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        const rejectedIcon = `<svg class="transfer-icon" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="white"/><path d="M65,35 L65,65 M35,50 L65,50 M35,50 L45,40 M35,50 L45,60" stroke="#FA9D3B" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        footerText = 'Transfer';
        
        if (messageData.contentType === 'transfer') {
            if (status === 'pending') {
                cardClass = 'transfer-pending';
                 iconSVG = transferIcon;
                const remark = info.remark ? info.remark.trim() : '';
                if (isSentByUser) {
                    const toName = info.targetName ? `向 ${info.targetName} ` : '';
                    statusText = remark || `你${toName}发起了一笔转账`;
                } else {
                    statusText = remark || '请查收转账';
                }
            } else {
                cardClass = 'transfer-receipt';
                if (status === 'accepted') {
                    iconSVG = acceptedIcon;
                    statusText = '已被接收';
                } else {
                    iconSVG = rejectedIcon;
                    statusText = '已被退回';
                }
            }
        } else {
            cardClass = 'transfer-receipt';
            
            if (status === 'rejected') {
                iconSVG = rejectedIcon;
                statusText = '已退还';
            } else {
                iconSVG = acceptedIcon;
                statusText = '已收款';
            }
        }

        bubble.innerHTML = `<div class="transfer-card ${cardClass}" data-message-id="${messageData.id}"><div class="transfer-content-wrapper">${iconSVG}<div class="transfer-text-group"><p class="amount">¥${info.amount}</p><p class="status-text">${escapeHTML(statusText)}</p></div></div><div class="transfer-footer">${footerText}</div></div>`;
        if (status === 'pending' && !isSentByUser) {
            bubble.querySelector('.transfer-card').addEventListener('click', () => {
                document.dispatchEvent(new CustomEvent('showTransferDetail', { detail: { messageId: messageData.id } }));
            });
        }
    } else if (isFocusCard) {
        // 【核心拦截】：焦点卡片的内容在上方已构建完毕，这里直接拦截，防止系统把底层的长段提示词当作聊天文本追加到气泡里！
    } else {
        const bubbleText = document.createElement('p');
           // 【精准修改】级联过滤：1.思考块 2.隐藏注释 3.系统指令包裹符 4.消息ID前缀
         const cleanText = cleanVisibleMessageText(messageData.text);
            
        // ▼▼▼ 修改：将带有 @ 的文字高亮为金色 ▼▼▼
        let finalHtml = escapeHTML(cleanText).replace(/\n/g, '<br>');
        
        // 【核心新增】拦截 [自动回复]：将其上色为淡黄色，并强制抹除它后面的换行符和空格，实现单行显示
        finalHtml = finalHtml.replace(/\[自动回复\](?:<br>|\s)*/g, '<span style="color: #FFD54F; font-weight: bold; margin-right: 6px;">[自动回复]</span>');
        
        finalHtml = finalHtml.replace(/@([^\s]+)/g, '<span style="color: #D4AF37; font-weight: bold;">@$1</span>');
        bubbleText.innerHTML = finalHtml;
        // ▲▲▲ 修改结束 ▲▲▲
        bubble.appendChild(bubbleText);

        // ▼▼▼ 【新增】如果消息有翻译，在气泡内部加一个隐藏的翻译块 ▼▼▼
        if (messageData.translation) {
            const transDiv = document.createElement('div');
            transDiv.className = getTranslationClassName(messageData); // 默认跟随设置
            transDiv.innerHTML = escapeHTML(messageData.translation).replace(/\n/g, '<br>');
            bubble.appendChild(transDiv);
        }
        // ▲▲▲ 新增结束 ▲▲▲
    }
    appendTranslationToggle(bubble, messageData);
    return bubble;

}
/**
 * 【新增】处理邀约点击事件
 */
async function handleInviteAction(messageId, action, chatId) {
    const numericId = Number(messageId);
    if (isNaN(numericId)) return;

    // 1. 更新数据库中的消息状态
    await db.chatMessages.update(numericId, { inviteStatus: action });
    
    // 2. 更新内存状态 (防止渲染旧状态)
    const msgInMem = AppState.currentChatHistory.find(m => m.id === numericId);
    if (msgInMem) msgInMem.inviteStatus = action;

    // 3. 刷新当前卡片 UI (直接重绘整个列表最稳妥)
    const messageWrapper = document.querySelector(`.message-wrapper[data-message-id="${numericId}"]`);
    if (messageWrapper) {
        const bubble = messageWrapper.querySelector('.invite-card');
        if (bubble) {
            bubble.classList.add('processed');
            // 简单更新文字，或者可以直接调用 loadAndRenderChatHistory 刷新
            if (action === 'accepted') {
                bubble.querySelector('.btn-reject').style.display = 'none';
                bubble.querySelector('.btn-accept').textContent = '已赴约';
            } else {
                bubble.querySelector('.btn-accept').style.display = 'none';
                bubble.querySelector('.btn-reject').textContent = '已婉拒';
            }
        }
    }
    // 4. 执行后续逻辑
    if (action === 'accepted') {
        // ▼▼▼ 【修改】添加低性能手机适用的过场动画 ▼▼▼
        
        // 1. 创建全屏遮罩
        const transitionOverlay = document.createElement('div');
        transitionOverlay.className = 'scene-transition-overlay';
        document.body.appendChild(transitionOverlay);

        // 2. 强制浏览器重绘后开始变黑
        requestAnimationFrame(() => {
            transitionOverlay.classList.add('active');
        });

        // 3. 等待变黑动画完成 (500ms) 后切换页面
        setTimeout(() => {
            const titleElement = document.getElementById('offline-mode-title');
            if (titleElement) {
                const char = AppState.characterProfiles.find(c => c.id === chatId);
                titleElement.textContent = char?.chatOverrideName || char?.name || '线下见面';
            } 
            showPage('page-offline-mode');
            document.dispatchEvent(new CustomEvent('loadOfflineHistory', { detail: { chatId: chatId } }));
          // 2. 延迟 300毫秒 再触发开始流程。
            setTimeout(() => {
                    document.dispatchEvent(new CustomEvent('startOfflineFlow', { detail: { chatId: chatId } }));
                    
                    // 3. 流程开始后，再把遮罩层淡出
                    transitionOverlay.classList.remove('active');
                    // 移除 DOM
                    setTimeout(() => transitionOverlay.remove(), 500);
                }, 300);
        }, 500);       
    } else {
       
        // 1. 插入一条系统事件，作为“记忆锚点”。
        // 这样等用户下次说话时，AI读取历史记录就能看到“[系统提示：用户婉拒了邀约]”，从而自然接话。
        const { addSystemEventMessage } = await import('./chat-service.js');
        await addSystemEventMessage(chatId, '你婉拒了对方的邀约', 'info');
    }
}


/**
 * 【新增】异步加载并填充引用回复的预览内容
 * @param {string} previewElementId - 预览占位符的 DOM ID
 * @param {number} repliedMessageId - 被引用的消息的 ID
 */
/* 
 * ==========================================================================
 *   ▼▼▼ 【修改】loadReplyPreview 函数 (支持会话专属昵称) ▼▼▼
 * ==========================================================================
 */
// ▼▼▼ 使用这个【完整的新函数】替换旧的 loadReplyPreview 函数 ▼▼▼
async function loadReplyPreview(previewElementId, repliedMessageId) {
    try {
        const repliedMessage = await db.chatMessages.get(repliedMessageId);
        const previewElement = document.getElementById(previewElementId);

        if (!repliedMessage || !previewElement) {
            if (previewElement) previewElement.remove();
            return;
        }

        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        const user = getCurrentChatIdentity();
        
        let senderName = '未知';
        
        // 【核心修改】名字获取逻辑与聊天气泡完全对齐
        if (repliedMessage.type === 'sent') {
            // 如果是用户发的消息
            if (char && char.chatOverrideUserNickname) {
                senderName = char.chatOverrideUserNickname; // 优先用会话专属昵称
            } else {
                senderName = user?.name || '你'; // 否则用全局身份名
            }
        } else {
            // 如果是角色发的消息
            // ▼▼▼ 修改：群聊优先显示群成员自己的名字 ▼▼▼
            if (char && char.isGroup && repliedMessage.speakerName) {
                senderName = repliedMessage.speakerName;
            } else if (char && char.chatOverrideName) {
            // ▲▲▲ 修改结束 ▲▲▲
                senderName = char.chatOverrideName; // 优先用会话专属备注
            } else {

                senderName = char?.name || '对方'; // 否则用角色原名
            }
        }

        let contentSnippet;
        if (repliedMessage.stickerUrl) {
            // 精准区分：text 是 '[图片]' 的才是真图片，其余（如 '[表情: 探头]'）才是表情
            contentSnippet = repliedMessage.text === '[图片]' ? '[图片]' : '[表情]';
        } else {
            contentSnippet = escapeHTML(repliedMessage.text.replace(/<[^>]+>/g, ''));
        }
        if (contentSnippet.length > 8) contentSnippet = contentSnippet.substring(0, 8) + '...';

        let replyAvatarSrc = DEFAULT_AVATAR_SRC;
        if (repliedMessage.type === 'sent') {
            replyAvatarSrc = char?.chatOverrideUserAvatar || user?.avatar || DEFAULT_AVATAR_SRC;
        } else if (char && char.isGroup && (repliedMessage.speakerId || repliedMessage.speakerName)) {
            const member = findGroupParticipant(char, repliedMessage.speakerId, repliedMessage.speakerName);
            if (member && isValidAvatarSrc(member.avatar)) {
                replyAvatarSrc = member.avatar;
            } else {
                replyAvatarSrc = char?.avatar || DEFAULT_AVATAR_SRC;
            }
        } else if (char && char.chatOverrideAvatar) {
            replyAvatarSrc = char.chatOverrideAvatar;
        } else {
            replyAvatarSrc = char?.avatar || DEFAULT_AVATAR_SRC;
        }
        previewElement.style.setProperty('--reply-avatar', `url("${replyAvatarSrc}")`);
        previewElement.innerHTML = `<strong>${escapeHTML(senderName)}:</strong> ${contentSnippet}`;

    } catch (error) {
        console.error(`加载引用消息[${repliedMessageId}]失败:`, error);
        // 如果加载失败，静默移除预览条，避免显示“加载中...”
        const previewElement = document.getElementById(previewElementId);
        if(previewElement) previewElement.remove();
    }
}
// ▲▲▲ 替换结束 ▲▲▲

const recallMessage = async (messageId, isAiRecall = false) => {
    // 【健壮性】确保所有数据库操作前都转换ID
    const numericMessageId = Number(messageId);
    if (isNaN(numericMessageId)) return;

    try {
        const message = await db.chatMessages.get(numericMessageId);
        if (!message) return;

        if (message.recalled) {
            await deleteMessage(numericMessageId, true);
            return;
        }
       // 将能看见具体内容的概率提升至 65%
       const shouldAISee = isAiRecall ? true : Math.random() < 0.65;
        await db.chatMessages.update(numericMessageId, { recalled: true, recalledAt: new Date(), aiVisible: shouldAISee });

        if (AppState.currentChatHistory) {
    const messageInHistory = AppState.currentChatHistory.find(m => m.id === numericMessageId);
    if (messageInHistory) {
        messageInHistory.recalled = true;
        messageInHistory.aiVisible = shouldAISee;
    }
}
        const messageWrappersInMain = document.querySelectorAll(`#chat-message-list [data-message-id="${numericMessageId}"]`);
        const messageWrappersInCall = document.querySelectorAll(`#voice-call-message-list [data-message-id="${numericMessageId}"]`);
        messageWrappersInMain.forEach(async (wrapper) => {
            const recallText = message.recallText || (message.type === 'sent' ? '你撤回了一条消息' : 'TA撤回了一条消息');
            wrapper.className = 'message-wrapper recalled';
            wrapper.innerHTML = `<p class="recalled-text">${recallText}</p>`;
            wrapper.style.cursor = 'pointer';

            const newMessageData = await db.chatMessages.get(numericMessageId);
            const newWrapper = wrapper.cloneNode(true);
            wrapper.parentNode.replaceChild(newWrapper, wrapper);
            // 重新绑定事件，确保撤回后的消息也能被点击查看
            if (newMessageData) {
                bindMessageEvents(newWrapper, newMessageData);
            }
        });
        
        messageWrappersInCall.forEach(wrapper => wrapper.remove());

        if (!isAiRecall) showDynamicIsland('消息已撤回');
    } catch (error) {
        console.error('Failed to recall message:', error);
        showDynamicIsland('撤回失败');
    }
};



const deleteMessage = async (messageId, skipConfirm = false) => {
    const numericMessageId = Number(messageId);
    if (isNaN(numericMessageId)) {
        console.error("Invalid messageId provided to deleteMessage:", messageId);
        showDynamicIsland('删除失败：无效的消息ID');
        return;
    }
    const message = await db.chatMessages.get(numericMessageId);
    if (!message) {
        document.querySelectorAll(`[data-message-id="${numericMessageId}"]`).forEach(el => el.remove());
        if (!skipConfirm) showDynamicIsland('消息不存在或已被删除');
        return;
    }
    // 【修改】加上 receipt 类型，让购物车生成的 3D 小票被删除时也能剥离轮数监听
    if (message.contentType === 'logistics_card' || message.contentType === 'receipt') {
        // 1. 检查是否存在该角色的礼物数据
        if (tempState.activeGifts && tempState.activeGifts[message.chatId]) {

            const originalLength = tempState.activeGifts[message.chatId].length;
            
            // 2. 过滤掉这条消息对应的物流记录
            tempState.activeGifts[message.chatId] = tempState.activeGifts[message.chatId].filter(
                gift => String(gift.msgId) !== String(numericMessageId)
            );
            // 3. 如果确实有数据被移除，同步保存到本地存储
            if (tempState.activeGifts[message.chatId].length !== originalLength) {
                localStorage.setItem('active_gifts_state', JSON.stringify(tempState.activeGifts));
                console.log(`[系统清理] 已移除消息 ID ${numericMessageId} 的物流轮数监听`);
            }
        }
    }
    const isCallSummary = message.contentType === 'voice_call_summary' && message.callId;
    const confirmText = isCallSummary
        ? '确定要删除这条通话记录吗？相关的通话对话也会一并删除。'
        : '确定要删除这条消息吗？此操作无法撤销。';

    if (!skipConfirm && !confirm(confirmText)) return;

    try {
        const idsToDelete = new Set();
        if (isCallSummary) {
            const relatedMessages = await db.chatMessages.where('callId').equals(message.callId).toArray();
            relatedMessages.forEach(msg => idsToDelete.add(msg.id));
        } else {
            idsToDelete.add(numericMessageId);
        }
        // 【第1步】从数据库删除
        await deleteMultipleMessages(idsToDelete); 
        if (message.contentType === 'dream') {
            const remainingDreamRecords = await db.chatMessages.bulkGet(Array.from(idsToDelete));
            if (remainingDreamRecords.some(Boolean)) throw new Error('梦境消息仍存在于数据库');
        }
        
        // 【第2步】从UI界面删除（【优化】使用 RAF 批量移除，防止瞬间卡死）
        requestAnimationFrame(() => {
            idsToDelete.forEach(id => {
                const messageWrappers = document.querySelectorAll(`[data-message-id="${id}"]`);
                messageWrappers.forEach(wrapper => wrapper.remove());
            });
        });

        if (AppState.currentChatHistory) {

            AppState.currentChatHistory = AppState.currentChatHistory.filter(msg => !idsToDelete.has(msg.id));
        }

        // 【优化】删除后重新获取该会话最新一条有效消息，刷新侧边栏预览，防止显示已删除内容
        const latest = await db.chatMessages.where('chatId').equals(message.chatId).reverse().limit(10).toArray();
        const validMsg = latest.find(m => m.type !== 'system' && m.contentType !== 'html_snippet' && m.uiVisible !== false && m.contentType !== 'offline_invite');
        if (validMsg) updateSidebarPreview(message.chatId, validMsg);

        if (!skipConfirm) showDynamicIsland('已删除');
        
    } catch (error) {

        console.error('Failed to delete message(s):', error);
        if (!skipConfirm) showDynamicIsland('删除失败');
    }
};


const hideMessageActionPopover = () => {
    if (activeMessagePopover) {
        activeMessagePopover.classList.remove('visible');
        if (handleClickOutside) {
            document.removeEventListener('click', handleClickOutside, { capture: true });
        }
        setTimeout(() => {
            if (activeMessagePopover) activeMessagePopover.remove();
            activeMessagePopover = null;
        }, 200);
    }
};

function getForumPostShareMediaItems(data = {}) {
    const media = Array.isArray(data.media) ? data.media.filter(Boolean) : [];
    if (media.length) return media;
    return data.thumb ? [{ type: 'real-image', url: data.thumb }] : [];
}

function renderForumPostSharePreviewMedia(data = {}) {
    const media = getForumPostShareMediaItems(data);
    const item = media.find(entry => entry.type === 'real-image' && entry.url)
        || media.find(entry => entry.type === 'fake-image' && entry.text)
        || media.find(entry => entry.type === 'music')
        || media[0];
    if (!item) return '';
    if (item.type === 'real-image' && item.url) {
        return `<div class="forum-post-share-media"><img src="${escapeHTML(item.url)}" alt=""></div>`;
    }
    if (item.type === 'fake-image') {
        return `<div class="forum-post-share-media is-generated"><span>${escapeHTML(item.text || '生成图片')}</span></div>`;
    }
    if (item.type === 'music') {
        const song = item.song || {};
        return `<div class="forum-post-share-media is-music"><img src="${escapeHTML(song.cover || 'images/default-avatar.svg')}" alt=""><span>${escapeHTML(song.title || '音乐')}</span></div>`;
    }
    if (item.type === 'slides-video') {
        return `<div class="forum-post-share-media is-generated"><span>短视频 · ${Array.isArray(item.slides) ? item.slides.length : 1}P</span></div>`;
    }
    if (item.type === 'video' && item.url) {
        return `<div class="forum-post-share-media"><video src="${escapeHTML(item.url)}" muted playsinline></video></div>`;
    }
    return '';
}

function renderForumPostShareDetailMedia(data = {}) {
    const media = getForumPostShareMediaItems(data);
    if (!media.length) return '';
    const mediaHtml = media.map(item => {
        if (item.type === 'real-image' && item.url) {
            return `<div class="forum-post-detail-media-item"><img src="${escapeHTML(item.url)}" alt=""></div>`;
        }
        if (item.type === 'fake-image') {
            return `<div class="forum-post-detail-media-item is-generated"><span>${escapeHTML(item.text || '生成图片')}</span></div>`;
        }
        if (item.type === 'slides-video') {
            const slides = Array.isArray(item.slides) && item.slides.length ? item.slides : ['短视频内容'];
            return `<div class="forum-post-detail-media-item is-generated">${slides.map(slide => `<span>${escapeHTML(String(slide).replace(/^\s*第[一二三四五六七八九十\d]+页[：:\s]*/, ''))}</span>`).join('')}</div>`;
        }
        if (item.type === 'music') {
            const song = item.song || {};
            return `<div class="forum-post-detail-media-item is-music"><img src="${escapeHTML(song.cover || 'images/default-avatar.svg')}" alt=""><b>${escapeHTML(song.title || '音乐')}</b><small>${escapeHTML(song.artist || '未知歌手')}</small></div>`;
        }
        if (item.type === 'video' && item.url) {
            return `<div class="forum-post-detail-media-item"><video src="${escapeHTML(item.url)}" controls playsinline></video></div>`;
        }
        return '';
    }).filter(Boolean).join('');
    return `<div class="forum-post-detail-media-grid ${media.length > 1 ? 'multi' : 'single'}">${mediaHtml}</div>`;
}

function formatForumPostShareDate(timestamp) {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatForumPostShareText(text) {
    return escapeHTML(String(text || '')).replace(/@([^\s@]+)/g, '<span class="forum-post-detail-mention">@$1</span>');
}

function renderForumPostShareDetailReplies(comment = {}) {
    const replies = Array.isArray(comment.replies) ? comment.replies : [];
    if (!replies.length) return '';
    return `
        <div class="forum-post-detail-replies">
            ${replies.map(reply => `
                <div class="forum-post-detail-reply">
                    <img src="${escapeHTML(reply.avatar || 'images/default-avatar.svg')}" alt="">
                    <div>
                        <div class="forum-post-detail-reply-head">
                            <b>${escapeHTML(reply.user || '匿名用户')}</b>
                            ${reply.isOwner ? '<em>楼主</em>' : ''}
                            <span>${formatForumPostShareDate(reply.createdAt)}</span>
                        </div>
                        <p>${formatForumPostShareText(reply.text)}</p>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function renderForumPostShareDetailComments(data = {}) {
    const comments = Array.isArray(data.commentItems) && data.commentItems.length
        ? data.commentItems
        : String(data.commentsDetail || '').split('\n').filter(Boolean).map(text => ({ user: '评论', text }));
    if (!comments.length) return '<div class="forum-post-detail-empty">还没有评论</div>';
    return comments.map(comment => `
        <div class="forum-post-detail-comment">
            <img src="${escapeHTML(comment.avatar || 'images/default-avatar.svg')}" alt="">
            <div>
                <div class="forum-post-detail-comment-head">
                    <b>${escapeHTML(comment.user || '匿名')}</b>
                    ${comment.isOwner ? '<em>楼主</em>' : ''}
                    <span>${formatForumPostShareDate(comment.createdAt)}</span>
                </div>
                <p>${formatForumPostShareText(comment.text)}</p>
                ${Number(comment.likes || 0) > 0 ? `<small>${Number(comment.likes || 0)} 赞</small>` : ''}
                ${renderForumPostShareDetailReplies(comment)}
            </div>
        </div>
    `).join('');
}

function showForumPostShareDetailModal(data = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'forum-post-detail-modal-overlay';

    const likeCount = Number(data.likes || 0);
    const commentCount = Number(data.comments || 0);
    const forwardCount = Number(data.forwards || 0);
    const avatarSrc = isValidAvatarSrc(data.avatar) ? data.avatar : 'images/default-avatar.svg';
    const postText = escapeHTML(data.text || data.title || '论坛帖子').replace(/\n/g, '<br>');
    const mediaHtml = renderForumPostShareDetailMedia(data);
    const commentsHtml = renderForumPostShareDetailComments(data);

    overlay.innerHTML = `
        <div class="forum-post-detail-modal-card">
            <button type="button" class="forum-post-detail-close" aria-label="关闭">×</button>
            <article class="forum-post-detail-mini-post">
                <header class="forum-post-detail-author">
                    <img src="${escapeHTML(avatarSrc)}" alt="">
                    <div>
                        <b>${escapeHTML(data.author || '论坛用户')}</b>
                        <span>${escapeHTML(data.circle || 'Forum')} · ${formatForumPostShareDate(data.createdAt)}</span>
                    </div>
                </header>
                ${mediaHtml}
                <div class="forum-post-detail-body">${postText}</div>
                <div class="forum-post-detail-stats">
                    <span>${likeCount} 赞</span>
                    <span>${commentCount} 评论</span>
                    <span>${forwardCount} 转发</span>
                </div>
                <section class="forum-post-detail-comments">
                    <div class="forum-post-detail-section-title">评论</div>
                    ${commentsHtml}
                </section>
            </article>
        </div>
    `;

    const closeModal = () => {
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 180);
    };

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('.forum-post-detail-close')) {
            closeModal();
        }
    });

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));
}

function formatVectorMatchTime(value) {
    const date = new Date(value || Date.now());
    return date.toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function showVectorMatchHistoryModal() {
    const chatId = tempState.currentChatId;
    const history = (tempState.vectorMatchHistory && tempState.vectorMatchHistory[String(chatId)]) || [];
    const overlay = document.createElement('div');
    overlay.className = 'vector-match-modal-overlay';

    const historyHtml = history.length > 0 ? history.map((snapshot, snapshotIndex) => {
        const itemsHtml = (snapshot.items || []).map((item, index) => `
            <div class="vector-match-result-item">
                <div class="vector-match-result-meta">
                    <span>${index + 1}. ${escapeHTML(item.category || '记忆')}${item.title ? ` · ${escapeHTML(item.title)}` : ''}</span>
                    <span>${Number(item.score || 0).toFixed(1)}分</span>
                </div>
                <div class="vector-match-result-text">${escapeHTML(item.content || '')}</div>
            </div>
        `).join('');
        const hiddenCount = Math.max(0, Number(snapshot.total || 0) - (snapshot.items || []).length);
        return `
            <section class="vector-match-snapshot">
                <div class="vector-match-snapshot-meta">
                    <span>${snapshotIndex === 0 ? '最近一次' : `第 ${snapshotIndex + 1} 次`}</span>
                    <span>${escapeHTML(snapshot.mode || '关键词')}</span>
                    <span>${formatVectorMatchTime(snapshot.at)}</span>
                </div>
                ${itemsHtml || '<div class="vector-match-empty">这次没有可展示的命中内容</div>'}
                ${hiddenCount > 0 ? `<div class="vector-match-more">还有 ${hiddenCount} 条低位命中没有展开</div>` : ''}
            </section>
        `;
    }).join('') : '<div class="vector-match-empty">当前聊天还没有记忆命中记录。发送一轮消息后，再点这里查看。</div>';

    overlay.innerHTML = `
        <div class="vector-match-modal-card">
            <button type="button" class="vector-match-close" aria-label="关闭">×</button>
            <div class="vector-match-modal-header">
                <h3>记忆命中</h3>
                <p>这里只展示已经算好的结果，不会重新检索。</p>
            </div>
            <div class="vector-match-modal-body">${historyHtml}</div>
        </div>
    `;

    const closeModal = () => {
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 180);
    };
    overlay.addEventListener('click', event => {
        if (event.target === overlay || event.target.closest('.vector-match-close')) closeModal();
    });

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));
}

function enterMultiSelectMode(initialMessageId) {
    hideMessageActionPopover();
    tempState.isMultiSelectMode = true;
    tempState.selectedMessageIds.clear();
    
    document.getElementById('page-chat-detail').classList.add('multiselect-active');
    document.getElementById('chat-header-normal').style.display = 'none';
    document.getElementById('chat-header-multiselect').style.display = 'flex';
    
    // 【健壮性】确保初始选择的消息ID也是数字
    const numericInitialId = Number(initialMessageId);
    if (!isNaN(numericInitialId)) {
        const initialMessageWrapper = chatMessageList.querySelector(`[data-message-id="${numericInitialId}"]`);
        if (initialMessageWrapper) {
            smartClickHandler(initialMessageWrapper, { id: numericInitialId });
        }
    }
    
    updateMultiSelectHeader();
}

function exitMultiSelectMode() {
    tempState.isMultiSelectMode = false;
    tempState.selectedMessageIds.clear();

    document.getElementById('page-chat-detail').classList.remove('multiselect-active');
    document.getElementById('chat-header-normal').style.display = 'flex';
    document.getElementById('chat-header-multiselect').style.display = 'none';

    chatMessageList.querySelectorAll('[data-message-id].selected').forEach(el => {
        el.classList.remove('selected');
    });
}

function updateMultiSelectHeader() {
    const count = tempState.selectedMessageIds.size;
    const counter = document.getElementById('multiselect-counter');
    const forwardBtn = document.getElementById('forward-selected-btn');
    const deleteBtn = document.getElementById('delete-selected-btn');
    
    if (count === 0) {
        counter.textContent = '请选择消息';
        if (forwardBtn) forwardBtn.disabled = true;
        deleteBtn.disabled = true;
    } else {
        counter.textContent = `已选择 ${count} 条消息`;
        if (forwardBtn) forwardBtn.disabled = false;
        deleteBtn.disabled = false;
    }
}
function smartClickHandler(messageWrapper, messageData, event = null) {
    // ▼▼▼ 新增：拉黑状态下拦截所有卡片点击 ▼▼▼
    const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
    if (char && char.isBlocked) return;
    // ▲▲▲ 新增结束 ▲▲▲
    const messageId = messageData.id;
    if (messageData.contentType === 'dream') {
        const dreamCard = messageWrapper.matches?.('.message-dream-card')
            ? messageWrapper
            : messageWrapper.querySelector?.('.message-dream-card');
        if (!dreamCard || dreamCard.classList.contains('is-message-swiping')) return;
        const expanded = dreamCard.classList.toggle('is-expanded');
        dreamCard.setAttribute('aria-expanded', String(expanded));
        dreamCard.querySelector('.dream-card-expanded')?.setAttribute('aria-hidden', String(!expanded));
        dreamCard.querySelectorAll('.dream-card-toggle').forEach(toggle => {
            toggle.setAttribute('aria-expanded', String(expanded));
            toggle.textContent = expanded ? '收起' : '展开更多';
        });
        event?.preventDefault();
        event?.stopPropagation();
        return;
    }
    if (tempState.isMultiSelectMode) {
        // 普通消息、卡片和懒加载占位块都以自身的 data-message-id 作为选择根节点。
        const wrapper = messageWrapper.matches?.('[data-message-id]')
            ? messageWrapper
            : messageWrapper.closest('[data-message-id]');
        if (!wrapper) return;

        // 使用数字ID进行存储，保持一致性
        const numericMessageId = Number(messageId);
        if (isNaN(numericMessageId)) return;

        if (tempState.selectedMessageIds.has(numericMessageId)) {
            tempState.selectedMessageIds.delete(numericMessageId);
            wrapper.classList.remove('selected');
        } else {
            tempState.selectedMessageIds.add(numericMessageId);
            wrapper.classList.add('selected');
        }
        updateMultiSelectHeader();
    } else if (messageData.contentType === 'forwarded_message') {
        showForwardedMessageDetail(messageData);
        return;
    } else if (messageData.contentType === 'chat_forward') {
        if (messageData.type === 'sent' && messageData.chatForwardData?.createdBy === 'user') {
            showUserCreatedChatForwardDetail(messageData);
        } else {
            showChatForwardViewer(messageData);
        }
        return;
    } else if (messageData.contentType === 'npc_chat_forward') {
        showNpcChatForwardViewer(messageData);
        return;
    } else if (messageData.recalled) {
        showRecalledContent(messageWrapper);
     } else if (messageData.contentType === 'voice_call_summary') {
        // 【核心修复】引入 video-call.js 的弹窗函数并判断
        import('../features/call.js').then(({ showCallHistoryModal, showVideoHistoryModal }) => {
            if (messageData.isVideo) {
                showVideoHistoryModal(messageData.callId);
            } else {
                showCallHistoryModal(messageData.callId);
            }
        });
    }else if (messageData.contentType === 'moment_card') {
    // 1. 解析出动态ID
    let cardData = {};
    try {
        cardData = typeof messageData.content === 'string' ? JSON.parse(messageData.content) : messageData.content;
    } catch (e) {
        return; // 解析失败就不处理
    }
    
    // 2. 如果有ID，就调用我们新的弹窗函数
    if (cardData.momentId) {
        showMomentDetailModal(cardData.momentId);
    }
}

}

async function handleForwardSelectedMessages() {
    if (tempState.selectedMessageIds.size === 0) return;
    await openForwardModal([...tempState.selectedMessageIds]);
}

async function handleDeleteSelectedMessages() {
    if (tempState.selectedMessageIds.size === 0) return;

    const idsToDelete = new Set(tempState.selectedMessageIds);
    let containsCallSummary = false;

    // 确保遍历的是数字ID
    for (const messageId of tempState.selectedMessageIds) {
        const message = await db.chatMessages.get(messageId);
        if (message && message.contentType === 'voice_call_summary' && message.callId) {
            containsCallSummary = true;
            const relatedMessages = await db.chatMessages.where('callId').equals(message.callId).toArray();
            relatedMessages.forEach(msg => idsToDelete.add(msg.id));
        }
    }
    
    const confirmText = containsCallSummary
        ? `确定要删除这 ${tempState.selectedMessageIds.size} 项及相关的通话记录吗？`
        : `确定要删除这 ${tempState.selectedMessageIds.size} 条消息吗？`;

    if (!confirm(confirmText)) return;

    try {
        await deleteMultipleMessages(idsToDelete); 
        const messageLists = [
            chatMessageList,
            document.getElementById('voice-call-message-list'),
        ].filter(Boolean);
        idsToDelete.forEach(id => {
            messageLists.forEach(list => {
                list.querySelectorAll(`[data-message-id="${id}"]`).forEach(element => element.remove());
            });
        });
    } catch (error) {
        console.error('Failed to delete selected messages:', error);
        showDynamicIsland('删除失败');
    }
    
    exitMultiSelectMode();
}

const showMessageActionPopover = (messageWrapper, messageId, actions = []) => {
    hideMessageActionPopover();
    const popover = document.createElement('div');
    popover.className = 'message-action-popover';
    activeMessagePopover = popover;
    let popoverHTML = '';
    const actionTemplates = {
        copy: `<div class="popover-button" data-action="copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>复制</span></div>`,
        favorite: `<div class="popover-button" data-action="favorite"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3z"></path></svg><span>收藏</span></div>`,
        edit: `<div class="popover-button" data-action="edit"><svg viewBox="0 0 24 24"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg><span>修改</span></div>`,
        quote: `<div class="popover-button" data-action="quote"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg><span>引用</span></div>`,
        translation: `<div class="popover-button" data-action="translation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 5h8M8 3v2m-3 0c.8 4 2.8 6.5 6 8M5 13c1.4-1.1 2.6-2.5 3.5-4"></path><path d="M14 14h6m-3-2v2m-3 0 3 7 3-7"></path></svg><span>翻译</span></div>`,
        recall: `<div class="popover-button" data-action="recall"><svg viewBox="0 0 24 24" fill="none"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path><path d="M12 7v5l4 2"></path></svg><span>撤回</span></div>`,
        reEnter: `<div class="popover-button" data-action="reEnter"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M23 4v6h-6"></path><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg><span>重回</span></div>`,
        multiselect: `<div class="popover-button" data-action="multiselect"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg><span>多选</span></div>`,
        delete: `<div class="popover-button delete" data-action="delete"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg><span>删除</span></div>`
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
    UI.phoneScreen.appendChild(popover);
    const wrapperRect = messageWrapper.getBoundingClientRect(), phoneRect = UI.phoneScreen.getBoundingClientRect(), popoverRect = popover.getBoundingClientRect();
    let left = wrapperRect.left - phoneRect.left + (wrapperRect.width / 2) - (popoverRect.width / 2), top = wrapperRect.top - phoneRect.top - popoverRect.height - 10;
    if (left < 10) left = 10;
    if (left + popoverRect.width > phoneRect.width - 10) left = phoneRect.width - 10 - popoverRect.width;
    if (top < 10) {
        top = wrapperRect.bottom - phoneRect.top + 10;
        popover.classList.add('popover-place-below');
    }
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    setTimeout(() => popover.classList.add('visible'), 10);
    handleClickOutside = (e) => {
        if (activeMessagePopover && !activeMessagePopover.contains(e.target) && !messageWrapper.contains(e.target)) {
            hideMessageActionPopover();
        }
    };
    setTimeout(() => { document.addEventListener('click', handleClickOutside, { capture: true }); }, 0);
    if (actions.includes('copy')) { 
        popover.querySelector('[data-action="copy"]').addEventListener('click', () => {
            // 【修复】苹果系统剪贴板安全限制，避开 await 异步操作，并增加兜底方案
            const doCopy = (text) => {
                const textToCopy = cleanVisibleMessageText(text);
                if (navigator.clipboard && window.isSecureContext) {
                    navigator.clipboard.writeText(textToCopy).then(() => showDynamicIsland('已复制')).catch(() => fallbackCopy(textToCopy));
                } else {
                    fallbackCopy(textToCopy);
                }
            };
            const fallbackCopy = (text) => {
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed'; // 防止页面乱跳
                document.body.appendChild(textarea);
                textarea.select();
                try { document.execCommand('copy'); showDynamicIsland('已复制'); } catch (e) { showDynamicIsland('复制失败'); }
                textarea.remove();
            };
            
            // 优先从内存极速拿数据，不让苹果系统有时间拦截
            const msgInMem = AppState.currentChatHistory.find(m => m.id === Number(messageId));
            if (msgInMem && msgInMem.text) {
                doCopy(msgInMem.text);
            } else {
                db.chatMessages.get(Number(messageId)).then(dbMsg => { if (dbMsg && dbMsg.text) doCopy(dbMsg.text); });
            }
            hideMessageActionPopover();
        });
    } 
    if (actions.includes('favorite')) {
        popover.querySelector('[data-action="favorite"]').addEventListener('click', async () => {
            const numericMessageId = Number(messageId);
            const message = await db.chatMessages.get(numericMessageId);
            if (!message) return;
            const nextFavoriteState = message.isFavorite === 1 ? 0 : 1;
            await db.chatMessages.update(numericMessageId, { isFavorite: nextFavoriteState });
            const memoryMessage = AppState.currentChatHistory?.find(item => Number(item.id) === numericMessageId);
            if (memoryMessage) memoryMessage.isFavorite = nextFavoriteState;
            showDynamicIsland(nextFavoriteState === 1 ? '已收藏' : '已取消收藏');
            hideMessageActionPopover();
        });
    }
    if (actions.includes('edit')) { popover.querySelector('[data-action="edit"]').addEventListener('click', () => { startEditMode(messageId); hideMessageActionPopover(); }); }
    if (actions.includes('quote')) { popover.querySelector('[data-action="quote"]').addEventListener('click', () => { startReplyMode(messageId); hideMessageActionPopover(); }); }
    if (actions.includes('translation')) {
        popover.querySelector('[data-action="translation"]').addEventListener('click', () => {
            const expanded = toggleTranslationFromMessageMenu(messageWrapper);
            showDynamicIsland(expanded ? '翻译已展开' : '翻译已收起');
            hideMessageActionPopover();
        });
    }
    if (actions.includes('recall')) { popover.querySelector('[data-action="recall"]').addEventListener('click', () => { recallMessage(messageId); hideMessageActionPopover(); }); }
    if (actions.includes('reEnter')) { popover.querySelector('[data-action="reEnter"]').addEventListener('click', () => { regenerateLastResponse(messageId); hideMessageActionPopover(); }); }
    if (actions.includes('multiselect')) { popover.querySelector('[data-action="multiselect"]').addEventListener('click', () => { enterMultiSelectMode(messageId); hideMessageActionPopover(); }); }
    if (actions.includes('delete')) { 
        popover.querySelector('[data-action="delete"]').addEventListener('click', () => { 
            deleteMessage(messageId); 
            hideMessageActionPopover(); 
        }); 
    }
};

const setupLongPress = (targetElement, messageId, actions) => {
    let longPressTimer = null;
    let longPressFired = false;
    let startX = 0, startY = 0; // 【新增】记录手指按下的初始位置
    const handlePointerDown = (e) => {
        // ▼▼▼ 新增：拉黑状态下拦截长按操作 ▼▼▼
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (char && char.isBlocked) return;
        // ▲▲▲ 新增结束 ▲▲▲
        if (tempState.isMultiSelectMode) return;
        longPressFired = false;
        startX = e.clientX; // 记录按下时的 X 坐标
        startY = e.clientY; // 记录按下时的 Y 坐标
        
        longPressTimer = setTimeout(() => {
            showMessageActionPopover(targetElement, messageId, actions);
            longPressFired = true;
            longPressTimer = null;
        }, 500);
    };

    // 【新增】防抖函数：允许手指轻微抖动，只有滑动距离超过 10 像素才算作取消长按
    const handlePointerMove = (e) => {
        if (longPressTimer) {
            const dx = Math.abs(e.clientX - startX);
            const dy = Math.abs(e.clientY - startY);
            if (dx > 10 || dy > 10) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        }
    };

    const handlePointerUpOrLeave = () => { 
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } 
    };
    
    const handleClick = (e) => { 
        if (longPressFired) { e.preventDefault(); e.stopPropagation(); } 
    };

    // 优化事件绑定
    targetElement.addEventListener('pointerdown', handlePointerDown, { passive: true });
    targetElement.addEventListener('pointermove', handlePointerMove, { passive: true }); // 使用新版防抖函数
    targetElement.addEventListener('pointerup', handlePointerUpOrLeave);
    targetElement.addEventListener('pointerleave', handlePointerUpOrLeave);
    targetElement.addEventListener('pointercancel', handlePointerUpOrLeave); // 【新增】防止苹果手机自带的手势机制强行打断长按
    targetElement.addEventListener('click', handleClick, { capture: true });
};

const setupSwipeToQuote = (targetElement, messageId) => {
    if (!targetElement || targetElement.dataset.swipeQuoteBound === 'true') return;
    targetElement.dataset.swipeQuoteBound = 'true';
    targetElement.classList.add('swipe-quote-target');

    const maxSwipeDistance = 88;
    const quoteTriggerDistance = 72;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let isTracking = false;
    let isHorizontalSwipe = false;
    let suppressClick = false;
    let settleTimer = null;

    const cancelSettling = () => {
        if (settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = null;
        }
        targetElement.classList.remove('is-message-swiping');
        targetElement.style.removeProperty('transform');
        targetElement.style.removeProperty('transition');
    };

    const settlePosition = () => {
        if (!targetElement.classList.contains('is-message-swiping')) return;
        targetElement.style.setProperty('transform', 'translate3d(0, 0, 0)', 'important');
        targetElement.style.transition = 'transform 0.18s ease-out';
        settleTimer = setTimeout(() => {
            targetElement.classList.remove('is-message-swiping');
            targetElement.style.removeProperty('transform');
            targetElement.style.removeProperty('transition');
            settleTimer = null;
        }, 190);
    };

    const handlePointerDown = (event) => {
        if (!event.isPrimary || (event.button !== undefined && event.button !== 0)) return;
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (char && char.isBlocked) return;
        if (tempState.isMultiSelectMode) return;

        cancelSettling();
        pointerId = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        lastX = startX;
        isTracking = true;
        isHorizontalSwipe = false;
        suppressClick = false;
    };

    const handlePointerMove = (event) => {
        if (!isTracking || event.pointerId !== pointerId) return;

        lastX = event.clientX;
        const dx = lastX - startX;
        const dy = event.clientY - startY;
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
            isTracking = false;
            settlePosition();
            return;
        }
        if (dx >= -10 || Math.abs(dx) <= Math.abs(dy)) return;

        isHorizontalSwipe = true;
        suppressClick = true;
        targetElement.classList.add('is-message-swiping');
        const swipeOffset = Math.max(-maxSwipeDistance, dx * 0.7);
        targetElement.style.setProperty('transform', `translate3d(${swipeOffset}px, 0, 0)`, 'important');
        if (targetElement.setPointerCapture && !targetElement.hasPointerCapture?.(event.pointerId)) {
            targetElement.setPointerCapture(event.pointerId);
        }
        if (event.cancelable) event.preventDefault();
    };

    const handlePointerUpOrCancel = (event) => {
        if (!isTracking || (event.pointerId !== undefined && event.pointerId !== pointerId)) return;

        const shouldQuote = event.type === 'pointerup'
            && isHorizontalSwipe
            && Math.abs(lastX - startX) >= quoteTriggerDistance;
        isTracking = false;
        if (targetElement.releasePointerCapture && pointerId !== null && targetElement.hasPointerCapture?.(pointerId)) {
            targetElement.releasePointerCapture(pointerId);
        }
        pointerId = null;
        if (shouldQuote) void startReplyMode(messageId);
        settlePosition();
    };

    const handleClick = (event) => {
        if (!suppressClick) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressClick = false;
    };

    targetElement.addEventListener('pointerdown', handlePointerDown, { passive: true });
    targetElement.addEventListener('pointermove', handlePointerMove, { passive: false });
    targetElement.addEventListener('pointerup', handlePointerUpOrCancel);
    targetElement.addEventListener('pointercancel', handlePointerUpOrCancel);
    targetElement.addEventListener('click', handleClick, { capture: true });
};

const cancelReplyMode = () => {
    tempState.replyingToId = null;
    document.getElementById('chat-reply-preview').classList.add('hidden');
};

const startReplyMode = async (messageId) => {
    // 【健壮性】确保ID为数字
    const numericMessageId = Number(messageId);
    if (isNaN(numericMessageId)) return;

    const message = await db.chatMessages.get(numericMessageId);
    if (!message) return;

    tempState.replyingToId = numericMessageId; // 存储数字ID
    
    const replyPreview = document.getElementById('chat-reply-preview');
    const replyPreviewName = document.getElementById('reply-preview-name');
    const replyPreviewText = document.getElementById('reply-preview-text');
    
    const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
    const user = getCurrentChatIdentity();
    const senderName = message.type === 'sent' ? (user?.name || '你') : (char?.name || '对方');
    
    replyPreviewName.textContent = `引用 ${senderName}`;
    let previewText = message.stickerUrl 
        ? '[表情]' 
        : cleanVisibleMessageText(message.text || '');
    if (previewText.length > 8) { previewText = previewText.substring(0, 8) + '...'; }
    replyPreviewText.textContent = previewText;
    
    replyPreview.classList.remove('hidden');
    document.getElementById('chat-input-field').focus();
    hideMessageActionPopover();
};

const showRecalledContent = async (recalledWrapper) => {
    // 【健壮性】确保ID为数字
    const messageId = Number(recalledWrapper.dataset.messageId);
    if (isNaN(messageId)) return;

    try {
        const originalMessage = await db.chatMessages.get(messageId);
        if (!originalMessage) { showDynamicIsland('消息不存在'); return; }
        
        const modal = document.createElement('div');
        modal.className = 'recalled-content-modal';
        modal.innerHTML = `<div class="recalled-content-overlay"></div><div class="recalled-content-card"><div class="recalled-content-header"><h3>撤回的消息</h3><button class="recalled-close-btn">×</button></div><div class="recalled-content-body">${originalMessage.stickerUrl ? `<img src="${originalMessage.stickerUrl}" class="recalled-sticker-preview" alt="表情"><p class="recalled-sticker-text">${escapeHTML(originalMessage.text)}</p>`: `<p class="recalled-message-text">${escapeHTML(originalMessage.text)}</p>`}</div><div class="recalled-content-footer"><span class="recalled-time">${new Date(originalMessage.recalledAt || originalMessage.timestamp).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span></div></div>`;
        
        document.body.appendChild(modal);
        setTimeout(() => modal.classList.add('visible'), 10);
        
        const closeModal = () => { modal.classList.remove('visible'); setTimeout(() => modal.remove(), 200); };
        modal.querySelector('.recalled-close-btn').addEventListener('click', closeModal);
        modal.querySelector('.recalled-content-overlay').addEventListener('click', closeModal);
    } catch (error) {
        console.error('Failed to load recalled content:', error);
        showDynamicIsland('加载失败');
    }
};

async function startEditMode(messageId) {
    hideMessageActionPopover();
    // 【健壮性】你已经正确添加了这里的检查
    const numericMessageId = Number(messageId);
    if (isNaN(numericMessageId)) return;
    
    const message = await db.chatMessages.get(numericMessageId);
    if (!message) { showDynamicIsland('找不到消息'); return; }
    
    document.getElementById('edit-message-id').value = message.id;
    document.getElementById('edit-message-content').value = message.text || '';
    document.getElementById('edit-modal').classList.add('visible');
}

function formatForwardedMessageTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function getForwardedMessageLabel(message = {}) {
    const text = typeof message.text === 'string' ? message.text : '';
    if (message.contentType === 'voice') return '[语音消息]';
    if (message.contentType === 'transfer' || message.contentType === 'transfer_receipt') return '[转账]';
    if (message.contentType === 'location') return '[位置]';
    if (message.stickerUrl && text === '[图片]') return '[图片]';
    if (message.stickerUrl && text.startsWith('[表情:')) return '[动画表情]';
    if (message.stickerUrl) return text || '[表情]';
    if (message.contentType === 'html_snippet') return '[互动卡片]';
    if (message.contentType && !['text', 'forwarded_message'].includes(message.contentType) && !text) return '[特殊消息]';
    return text || '[消息]';
}

function truncateForwardedPreview(text, maxLength = 50) {
    const clean = cleanVisibleMessageText(text);
    return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean;
}

function getForwardSourceCharacter(message = {}) {
    return AppState.characterProfiles.find(c => isSameCharacterId(c.id, message.chatId));
}

function getOriginalSenderInfo(originalMessage, currentUser) {
    const sourceChar = getForwardSourceCharacter(originalMessage);
    if (originalMessage.type === 'sent') {
        return {
            name: currentUser?.name || '你',
            avatar: currentUser?.avatar || DEFAULT_AVATAR_SRC
        };
    }

    if (sourceChar?.isGroup && (originalMessage.speakerId || originalMessage.speakerName)) {
        const member = findGroupParticipant(sourceChar, originalMessage.speakerId, originalMessage.speakerName);
        return {
            name: originalMessage.speakerName,
            avatar: member?.avatar || originalMessage.avatarSrc || sourceChar.avatar || DEFAULT_AVATAR_SRC
        };
    }

    return {
        name: originalMessage.speakerName || sourceChar?.chatOverrideName || sourceChar?.name || 'Ta',
        avatar: originalMessage.avatarSrc || sourceChar?.chatOverrideAvatar || sourceChar?.avatar || DEFAULT_AVATAR_SRC
    };
}

function getForwardedRecordItems(fd = {}) {
    if (Array.isArray(fd.messages) && fd.messages.length > 0) return fd.messages;
    return [{
        originalSenderName: fd.originalSenderName,
        originalSenderAvatar: fd.originalSenderAvatar,
        originalText: fd.originalText,
        originalTimestamp: fd.originalTimestamp,
        originalType: fd.originalType,
        originalContentType: fd.originalContentType,
        originalStickerUrl: fd.originalStickerUrl || null
    }];
}

function buildForwardRecordTitle(messages, sourceUser) {
    const sourceChar = getForwardSourceCharacter(messages[0]);
    const sourceName = sourceChar?.chatOverrideName || sourceChar?.name || '聊天';
    if (sourceChar?.isGroup) return `${sourceName}的聊天记录`;
    return `${sourceName}与${sourceUser?.name || '我'}的聊天记录`;
}

function createForwardedRecordItem(originalMessage, sourceUser) {
    const originalSender = getOriginalSenderInfo(originalMessage, sourceUser);
    return {
        originalSenderName: originalSender.name,
        originalSenderAvatar: originalSender.avatar,
        originalText: originalMessage.text,
        originalTimestamp: originalMessage.timestamp,
        originalType: originalMessage.type,
        originalContentType: originalMessage.contentType,
        originalStickerUrl: originalMessage.stickerUrl || null,
        originalTranslation: originalMessage.translation || ''
    };
}

function renderForwardedDetailContent(item) {
    const label = getForwardedMessageLabel({
        text: item.originalText,
        contentType: item.originalContentType,
        stickerUrl: item.originalStickerUrl
    });
    const isImage = item.originalStickerUrl && label === '[图片]';
    const isSticker = item.originalStickerUrl && !isImage;
    const mediaHtml = item.originalStickerUrl
        ? `<img class="${isSticker ? 'forwarded-record-sticker' : 'forwarded-record-image'}" src="${escapeHTML(item.originalStickerUrl)}" alt="${escapeHTML(label)}">`
        : '';
    const textHtml = !isImage && !isSticker
        ? `<div class="forwarded-record-text">${escapeHTML(label).replace(/\n/g, '<br>')}</div>`
        : `<div class="forwarded-record-text">${escapeHTML(label)}</div>`;
    const translationText = String(item.originalTranslation || '').trim();
    const translationHtml = translationText
        ? `<div class="forwarded-record-translation">${escapeHTML(translationText).replace(/\n/g, '<br>')}</div>`
        : '';
    return `${mediaHtml}${textHtml}${translationHtml}`;
}

function showUserCreatedChatForwardDetail(messageData) {
    const fd = messageData.chatForwardData || {};
    const sourceUser = getCurrentChatIdentity(messageData.chatId) || getCurrentChatIdentity();
    const normalizedMessage = {
        ...messageData,
        forwardedData: {
            recordTitle: fd.sourceName || '聊天记录',
            sourceChatId: messageData.chatId,
            sourceChatType: fd.sourceType === 'group' ? 'group' : 'single',
            sourceChatName: fd.sourceName || '聊天记录',
            forwarderName: sourceUser?.name || '用户',
            messages: Array.isArray(fd.messages)
                ? fd.messages.map(item => ({
                    originalSenderName: item.speakerName || '未知',
                    originalSenderAvatar: item.avatarSrc || DEFAULT_AVATAR_SRC,
                    originalText: item.text || '',
                    originalTimestamp: item.timestamp || messageData.timestamp,
                    originalType: item.speakerType === 'user' ? 'sent' : 'received',
                    originalContentType: item.contentType || 'text',
                    originalStickerUrl: item.stickerUrl || null,
                    originalTranslation: item.translation || ''
                }))
                : []
        }
    };
    showForwardedMessageDetail(normalizedMessage);
}

function getFakeChatRecordElements() {
    return {
        overlay: document.getElementById('fake-chat-record-modal-overlay'),
        sourceName: document.getElementById('fake-chat-source-name'),
        startTime: document.getElementById('fake-chat-start-time'),
        participantTrigger: document.getElementById('fake-chat-participant-trigger'),
        participantSelected: document.getElementById('fake-chat-participant-selected'),
        participantMenu: document.getElementById('fake-chat-participant-menu'),
        groupSettings: document.getElementById('fake-chat-group-settings'),
        groupMemberList: document.getElementById('fake-chat-group-member-list'),
        addGroupMemberBtn: document.getElementById('fake-chat-add-group-member-btn'),
        prompt: document.getElementById('fake-chat-ai-prompt'),
        list: document.getElementById('fake-chat-record-list'),
        addBtn: document.getElementById('fake-chat-add-message-btn'),
        aiBtn: document.getElementById('fake-chat-ai-generate-btn'),
        saveBtn: document.getElementById('fake-chat-save-btn'),
        closeBtn: document.getElementById('fake-chat-close-btn')
    };
}

function updateFakeChatParticipantTrigger() {
    const { participantSelected, participantTrigger } = getFakeChatRecordElements();
    const selectedParticipant = fakeChatRecordState.selectedParticipant;
    if (participantSelected) {
        participantSelected.textContent = selectedParticipant
            ? `${selectedParticipant.name} · ${selectedParticipant.relation || '已选择人物'}`
            : '不选择，手动输入新人物';
    }
    participantTrigger?.setAttribute('aria-expanded', 'false');
}

function createFakeChatParticipantButton(participant, isChild = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `fake-chat-participant-item${isChild ? ' is-child' : ''}`;
    button.dataset.participantKey = participant.key;
    const name = document.createElement('span');
    name.className = 'fake-chat-participant-item-name';
    name.textContent = participant.name;
    const meta = document.createElement('span');
    meta.className = 'fake-chat-participant-item-meta';
    meta.textContent = participant.relation || (isChild ? 'NPC' : '角色');
    button.append(name, meta);
    button.addEventListener('click', () => selectFakeChatParticipant(participant.key));
    return button;
}

function selectFakeChatParticipant(participantKey) {
    const participant = fakeChatParticipantOptions.get(participantKey);
    if (!participant) return;
    const isGroupChat = fakeChatRecordState.sourceType === 'group';
    if (!isGroupChat && participant.sourceType !== fakeChatRecordState.sourceType) {
        setFakeChatRecordSourceType(participant.sourceType);
    }
    fakeChatRecordState.selectedParticipantKey = participant.key;
    fakeChatRecordState.selectedParticipant = participant;
    const { sourceName, participantMenu } = getFakeChatRecordElements();
    if (isGroupChat) {
        syncFakeChatGroupMembers();
        if (!fakeChatRecordState.groupMembers.includes(participant.name)) {
            fakeChatRecordState.groupMembers.push(participant.name);
        }
        renderFakeChatGroupMembers();
    } else {
        fakeChatRecordState.sourceName = participant.name;
        if (sourceName) sourceName.value = participant.name;
    }
    if (participantMenu) participantMenu.hidden = true;
    updateFakeChatParticipantTrigger();
    renderFakeChatRecordEditor();
}

function populateFakeChatParticipantOptions() {
    const { participantMenu } = getFakeChatRecordElements();
    if (!participantMenu) return;

    fakeChatParticipantOptions.clear();
    participantMenu.innerHTML = '';
    const currentChar = AppState.characterProfiles.find(char => isSameCharacterId(char.id, tempState.currentChatId));
    const currentUser = getCurrentChatIdentity();

    const addParticipant = (participant) => {
        if (!participant?.name || fakeChatParticipantOptions.has(participant.key)) return;
        fakeChatParticipantOptions.set(participant.key, participant);
    };
    const appendSectionTitle = (text) => {
        const title = document.createElement('div');
        title.className = 'fake-chat-participant-section-title';
        title.textContent = text;
        participantMenu.appendChild(title);
    };
    const appendRoleTree = (char, isCurrent) => {
        if (!char || char.isGroup) return;
        const displayName = char.chatOverrideName || char.name;
        const roleParticipant = {
            key: `character:${char.id}`,
            kind: 'character',
            sourceType: 'single',
            id: char.id,
            name: displayName,
            persona: char.persona || '',
            avatar: char.chatOverrideAvatar || char.avatar || '',
            relation: isCurrent ? '当前角色' : '其它角色'
        };
        addParticipant(roleParticipant);
        const roleTree = document.createElement('div');
        roleTree.className = 'fake-chat-participant-tree';
        roleTree.appendChild(createFakeChatParticipantButton(roleParticipant));

        const npcList = Array.isArray(char.relatedNpcs) ? char.relatedNpcs : [];
        npcList.forEach((npc, index) => {
            const npcName = String(npc?.name || '').trim();
            if (!npcName) return;
            const npcParticipant = {
                key: `character-npc:${char.id}:${npc.id || npcName || index}`,
                kind: 'character-npc',
                sourceType: 'single',
                name: npcName,
                persona: npc.persona || '',
                avatar: npc.avatar || '',
                relation: npc.relation || '角色关联 NPC',
                ownerId: char.id,
                ownerName: displayName,
                ownerPersona: char.persona || ''
            };
            addParticipant(npcParticipant);
            roleTree.appendChild(createFakeChatParticipantButton(npcParticipant, true));
        });
        participantMenu.appendChild(roleTree);
    };

    appendSectionTitle('角色');
    AppState.characterProfiles
        .filter(char => isSameCharacterId(char.id, currentChar?.id))
        .forEach(char => appendRoleTree(char, true));
    AppState.characterProfiles
        .filter(char => !isSameCharacterId(char.id, currentChar?.id))
        .forEach(char => appendRoleTree(char, false));

    const userNpcs = Array.isArray(currentUser?.socialCircle) ? currentUser.socialCircle : [];
    if (userNpcs.length > 0) {
        appendSectionTitle('用户 NPC');
        const userNpcTree = document.createElement('div');
        userNpcTree.className = 'fake-chat-participant-tree';
        userNpcs.forEach((npc, index) => {
            const npcName = String(npc?.name || '').trim();
            if (!npcName) return;
            const participant = {
                key: `user-npc:${currentUser.id}:${npc.id || npcName || index}`,
                kind: 'user-npc',
                sourceType: 'single',
                name: npcName,
                persona: npc.persona || '',
                avatar: npc.avatar || '',
                relation: npc.relation || '用户 NPC',
                ownerId: currentUser.id,
                ownerName: currentUser.name || '用户'
            };
            addParticipant(participant);
            userNpcTree.appendChild(createFakeChatParticipantButton(participant, true));
        });
        participantMenu.appendChild(userNpcTree);
    }

    if (fakeChatParticipantOptions.size === 0) {
        const empty = document.createElement('div');
        empty.className = 'fake-chat-participant-empty';
        empty.textContent = '暂无已有人物，可以直接手动输入新人物';
        participantMenu.appendChild(empty);
    }
    updateFakeChatParticipantTrigger();
}

function readFakeChatGroupMembers() {
    const { groupMemberList } = getFakeChatRecordElements();
    return Array.from(groupMemberList?.querySelectorAll('.fake-chat-group-member-name') || [])
        .map(input => input.value.trim())
        .filter(Boolean);
}

function syncFakeChatGroupMembers() {
    fakeChatRecordState.groupMembers = readFakeChatGroupMembers();
}

function renderFakeChatGroupSpeakerOptions() {
    const speakerOptions = document.getElementById('fake-chat-group-speaker-options');
    if (!speakerOptions) return;
    speakerOptions.innerHTML = fakeChatRecordState.groupMembers
        .filter(Boolean)
        .map(name => `<option value="${escapeHTML(name)}"></option>`)
        .join('');
}

function renderFakeChatSpeakerTypeTrigger(row, speakerType) {
    const normalized = normalizeFakeChatSpeakerType(speakerType);
    const trigger = row.querySelector('[data-fake-speaker-type-trigger]');
    const label = trigger?.querySelector('.fake-chat-speaker-type-label');
    const menu = row.querySelector('.fake-chat-speaker-type-menu');
    row.dataset.speakerType = normalized;
    if (label) label.textContent = FAKE_CHAT_SPEAKER_TYPE_LABELS[normalized] || '群友';
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (menu) menu.hidden = true;
}

function renderFakeChatGroupMembers() {
    const { groupSettings, groupMemberList } = getFakeChatRecordElements();
    if (!groupSettings || !groupMemberList) return;
    const isGroupChat = fakeChatRecordState.sourceType === 'group';
    groupSettings.hidden = !isGroupChat;
    if (!isGroupChat) {
        renderFakeChatGroupSpeakerOptions();
        return;
    }

    groupMemberList.innerHTML = '';
    const members = fakeChatRecordState.groupMembers.length > 0
        ? fakeChatRecordState.groupMembers
        : [''];
    members.forEach((memberName, index) => {
        const row = document.createElement('div');
        row.className = 'fake-chat-group-member-row';
        const input = document.createElement('input');
        input.className = 'fake-chat-group-member-name';
        input.type = 'text';
        input.maxLength = 30;
        input.placeholder = index === 0 ? '例如：我' : '填写群成员名字';
        input.value = memberName;
        input.setAttribute('list', 'fake-chat-group-speaker-options');
        input.addEventListener('input', () => {
            syncFakeChatGroupMembers();
            renderFakeChatGroupSpeakerOptions();
        });
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'fake-chat-group-member-remove';
        removeBtn.setAttribute('aria-label', '删除群成员');
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
            syncFakeChatGroupMembers();
            fakeChatRecordState.groupMembers.splice(index, 1);
            renderFakeChatGroupMembers();
        });
        row.append(input, removeBtn);
        groupMemberList.appendChild(row);
    });
    renderFakeChatGroupSpeakerOptions();
}

function moveFakeChatMessage(index, offset) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= fakeChatRecordState.messages.length) return;
    const messages = fakeChatRecordState.messages;
    [messages[index], messages[targetIndex]] = [messages[targetIndex], messages[index]];
    renderFakeChatRecordEditor();
    document.querySelector(`#fake-chat-record-list .fake-chat-record-row[data-index="${targetIndex}"]`)
        ?.scrollIntoView({ block: 'nearest' });
}

function renderFakeChatRecordEditor() {
    const { list, sourceName, startTime } = getFakeChatRecordElements();
    if (!list) return;
    if (sourceName) sourceName.value = fakeChatRecordState.sourceName || '';
    if (startTime) startTime.value = fakeChatRecordState.recordStartTime || '';
    if (sourceName) {
        sourceName.placeholder = fakeChatRecordState.sourceType === 'group'
            ? '填写群聊名称，例如：周末计划群'
            : '单聊填写对方名字，例如：林澈';
    }
    updateFakeChatParticipantTrigger();
    renderFakeChatGroupMembers();
    list.innerHTML = '';
    const isSingleChat = fakeChatRecordState.sourceType === 'single';
    const currentUser = getCurrentChatIdentity();
    const currentUserName = currentUser?.name || '用户';

    fakeChatRecordState.messages.forEach((message, index) => {
        const row = document.createElement('div');
        row.className = 'fake-chat-record-row';
        row.dataset.index = String(index);
        if (isSingleChat) {
            const speakerRole = message.speakerType === 'user' ? 'user' : 'char';
            row.dataset.speakerRole = speakerRole;
            row.innerHTML = `
                <div class="fake-chat-record-row-head">
                    <div class="fake-chat-speaker-role-switch" role="group" aria-label="选择发言人">
                        <button type="button" class="fake-chat-speaker-role${speakerRole === 'user' ? ' active' : ''}" data-fake-speaker-role="user">我</button>
                        <button type="button" class="fake-chat-speaker-role${speakerRole === 'char' ? ' active' : ''}" data-fake-speaker-role="char">对方</button>
                    </div>
                    <span class="fake-chat-speaker-caption">${escapeHTML(speakerRole === 'user' ? currentUserName : (fakeChatRecordState.sourceName || '聊天对象'))}</span>
                    <div class="fake-chat-row-actions">
                        <button class="fake-chat-move-message" type="button" data-fake-move="up" aria-label="上移">上移</button>
                        <button class="fake-chat-move-message" type="button" data-fake-move="down" aria-label="下移">下移</button>
                        <button class="fake-chat-remove-message" type="button" aria-label="删除这条消息">×</button>
                    </div>
                </div>
                <textarea class="fake-chat-message-text" maxlength="500" rows="2" placeholder="${speakerRole === 'user' ? '输入你想说的话' : '输入对方会说的话'}"></textarea>
            `;
        } else {
            row.innerHTML = `
                <div class="fake-chat-record-row-head">
                    <input class="fake-chat-speaker-name" type="text" maxlength="30" list="fake-chat-group-speaker-options" placeholder="发言人名字">
                    <div class="fake-chat-speaker-type-picker">
                        <button type="button" class="fake-chat-speaker-type" data-fake-speaker-type-trigger aria-expanded="false">
                            <span class="fake-chat-speaker-type-label"></span>
                            <span class="fake-chat-speaker-type-chevron" aria-hidden="true">⌄</span>
                        </button>
                        <div class="fake-chat-speaker-type-menu" hidden>
                            <button type="button" data-fake-speaker-type="user">用户</button>
                            <button type="button" data-fake-speaker-type="char">角色</button>
                            <button type="button" data-fake-speaker-type="member">群友</button>
                        </div>
                    </div>
                    <div class="fake-chat-row-actions">
                        <button class="fake-chat-move-message" type="button" data-fake-move="up" aria-label="上移">上移</button>
                        <button class="fake-chat-move-message" type="button" data-fake-move="down" aria-label="下移">下移</button>
                        <button class="fake-chat-remove-message" type="button" aria-label="删除这条消息">×</button>
                    </div>
                </div>
                <textarea class="fake-chat-message-text" maxlength="500" rows="2" placeholder="输入这条聊天内容"></textarea>
            `;
            row.querySelector('.fake-chat-speaker-name').value = message.speakerName || '';
            renderFakeChatSpeakerTypeTrigger(row, message.speakerType);
            const speakerTypePicker = row.querySelector('.fake-chat-speaker-type-picker');
            const speakerTypeTrigger = row.querySelector('[data-fake-speaker-type-trigger]');
            const speakerTypeMenu = row.querySelector('.fake-chat-speaker-type-menu');
            speakerTypeTrigger?.addEventListener('click', event => {
                event.stopPropagation();
                if (!speakerTypePicker || !speakerTypeMenu) return;
                const willOpen = speakerTypeMenu.hidden;
                closeFakeChatSpeakerTypeMenus(speakerTypePicker);
                speakerTypeMenu.hidden = !willOpen ? true : false;
                speakerTypeTrigger.setAttribute('aria-expanded', String(willOpen));
                speakerTypePicker.classList.toggle('is-open', willOpen);
            });
            speakerTypeMenu?.querySelectorAll('[data-fake-speaker-type]').forEach(button => {
                button.addEventListener('click', event => {
                    event.stopPropagation();
                    renderFakeChatSpeakerTypeTrigger(row, button.dataset.fakeSpeakerType);
                    closeFakeChatSpeakerTypeMenus();
                });
            });
        }
        row.querySelector('.fake-chat-message-text').value = message.text || '';
        row.querySelectorAll('[data-fake-speaker-role]').forEach(button => {
            button.addEventListener('click', () => {
                row.dataset.speakerRole = button.dataset.fakeSpeakerRole;
                row.querySelectorAll('[data-fake-speaker-role]').forEach(item => {
                    item.classList.toggle('active', item === button);
                });
                const text = row.querySelector('.fake-chat-message-text');
                if (text) {
                    text.placeholder = button.dataset.fakeSpeakerRole === 'user'
                        ? '输入你想说的话'
                        : '输入对方会说的话';
                }
            });
        });
        row.querySelectorAll('[data-fake-move]').forEach(button => {
            button.addEventListener('click', () => {
                syncFakeChatRecordEditorState();
                moveFakeChatMessage(index, button.dataset.fakeMove === 'up' ? -1 : 1);
            });
        });
        row.querySelector('.fake-chat-remove-message').addEventListener('click', () => {
            syncFakeChatRecordEditorState();
            fakeChatRecordState.messages.splice(index, 1);
            renderFakeChatRecordEditor();
        });
        list.appendChild(row);
    });
}

function readFakeChatRecordMessages() {
    const { sourceName, list } = getFakeChatRecordElements();
    const isSingleChat = fakeChatRecordState.sourceType === 'single';
    const currentUser = getCurrentChatIdentity();
    const currentUserName = currentUser?.name || '用户';
    const otherName = sourceName?.value.trim() || '对方';
    return Array.from(list?.querySelectorAll('.fake-chat-record-row') || []).map(row => {
        const speakerType = isSingleChat
            ? (row.dataset.speakerRole === 'char' ? 'char' : 'user')
            : normalizeFakeChatSpeakerType(row.dataset.speakerType);
        return {
            speakerName: isSingleChat
                ? (speakerType === 'user' ? currentUserName : otherName)
                : (row.querySelector('.fake-chat-speaker-name')?.value.trim() || ''),
            speakerType,
            text: row.querySelector('.fake-chat-message-text')?.value.trim() || '',
            translation: ''
        };
    });
}

function syncFakeChatRecordEditorState() {
    const { sourceName, startTime } = getFakeChatRecordElements();
    fakeChatRecordState.sourceName = sourceName?.value.trim() || '';
    fakeChatRecordState.recordStartTime = startTime?.value || fakeChatRecordState.recordStartTime || '';
    syncFakeChatGroupMembers();
    fakeChatRecordState.messages = readFakeChatRecordMessages();
}

function setFakeChatRecordSourceType(sourceType) {
    if (sourceType !== fakeChatRecordState.sourceType) {
        syncFakeChatRecordEditorState();
    }
    fakeChatRecordState.sourceType = sourceType === 'group' ? 'group' : 'single';
    if (fakeChatRecordState.sourceType === 'group') {
        const currentUserName = getCurrentChatIdentity()?.name || '用户';
        const messageSpeakerNames = fakeChatRecordState.messages
            .map(message => String(message.speakerName || '').trim())
            .filter(Boolean);
        fakeChatRecordState.groupMembers = [...new Set([
            currentUserName,
            ...fakeChatRecordState.groupMembers,
            ...messageSpeakerNames
        ])];
    }
    document.querySelectorAll('[data-fake-chat-source-type]').forEach(button => {
        button.classList.toggle('active', button.dataset.fakeChatSourceType === fakeChatRecordState.sourceType);
    });
    renderFakeChatRecordEditor();
}

function collectFakeChatRecordDraft() {
    const isSingleChat = fakeChatRecordState.sourceType === 'single';
    const { sourceName, startTime } = getFakeChatRecordElements();
    syncFakeChatGroupMembers();
    const messages = readFakeChatRecordMessages()
        .filter(message => message.speakerName && message.text);
    return {
        sourceType: fakeChatRecordState.sourceType,
        sourceName: sourceName?.value.trim() || (isSingleChat ? '对方' : '剧情聊天记录'),
        recordStartTime: startTime?.value || fakeChatRecordState.recordStartTime || '',
        groupMembers: [...fakeChatRecordState.groupMembers],
        messages
    };
}

function closeFakeChatRecordModal() {
    const { overlay } = getFakeChatRecordElements();
    if (!overlay) return;
    const activeElement = document.activeElement;
    if (activeElement && overlay.contains(activeElement) && typeof activeElement.blur === 'function') {
        activeElement.blur();
    }
    overlay.classList.remove('visible');
    overlay.setAttribute('aria-hidden', 'true');
}

function bindFakeChatRecordModalEvents() {
    const {
        overlay,
        sourceName,
        startTime,
        participantTrigger,
        participantMenu,
        prompt,
        list,
        addBtn,
        addGroupMemberBtn,
        aiBtn,
        saveBtn,
        closeBtn
    } = getFakeChatRecordElements();
    if (!overlay || overlay.dataset.bound === 'true') return;
    overlay.dataset.bound = 'true';

    sourceName?.addEventListener('input', () => {
        fakeChatRecordState.sourceName = sourceName.value.trim();
        if (fakeChatRecordState.sourceType !== 'group'
            && fakeChatRecordState.selectedParticipant
            && fakeChatRecordState.selectedParticipant.name !== fakeChatRecordState.sourceName) {
            fakeChatRecordState.selectedParticipantKey = '';
            fakeChatRecordState.selectedParticipant = null;
            updateFakeChatParticipantTrigger();
        }
    });
    startTime?.addEventListener('input', () => {
        fakeChatRecordState.recordStartTime = startTime.value;
    });
    participantTrigger?.addEventListener('click', () => {
        if (!participantMenu) return;
        participantMenu.hidden = !participantMenu.hidden;
        participantTrigger.setAttribute('aria-expanded', String(!participantMenu.hidden));
    });
    addGroupMemberBtn?.addEventListener('click', () => {
        syncFakeChatGroupMembers();
        fakeChatRecordState.groupMembers.push('');
        renderFakeChatGroupMembers();
        document.querySelector('#fake-chat-group-member-list .fake-chat-group-member-row:last-child input')?.focus();
    });
    document.querySelectorAll('[data-fake-chat-source-type]').forEach(button => {
        button.addEventListener('click', () => setFakeChatRecordSourceType(button.dataset.fakeChatSourceType));
    });
    list?.addEventListener('click', event => {
        if (!event.target.closest('.fake-chat-speaker-type-picker')) {
            closeFakeChatSpeakerTypeMenus();
        }
    });
    addBtn?.addEventListener('click', () => {
        syncFakeChatRecordEditorState();
        const isSingleChat = fakeChatRecordState.sourceType === 'single';
        const lastMessage = fakeChatRecordState.messages[fakeChatRecordState.messages.length - 1];
        fakeChatRecordState.messages.push({
            speakerName: '',
            speakerType: isSingleChat
                ? (lastMessage?.speakerType === 'user' ? 'char' : 'user')
                : 'member',
            text: '',
            translation: ''
        });
        renderFakeChatRecordEditor();
        list?.lastElementChild?.querySelector('.fake-chat-message-text')?.focus();
    });
    aiBtn?.addEventListener('click', async () => {
        const charId = tempState.currentChatId;
        const promptText = prompt?.value.trim() || '';
        const draft = collectFakeChatRecordDraft();
        const currentNames = draft.messages.map(message => message.speakerName).filter(Boolean);
        if (!charId) return;
        aiBtn.disabled = true;
        aiBtn.classList.add('is-loading');
        const originalText = aiBtn.textContent;
        aiBtn.textContent = '生成中...';
        try {
            const result = await generateFakeChatRecordWithAI({
                chatId: charId,
                instruction: promptText,
                sourceType: fakeChatRecordState.sourceType,
                sourceName: draft.sourceName,
                participantNames: [...new Set([...currentNames, ...draft.groupMembers])],
                groupMembers: draft.groupMembers,
                participantContext: fakeChatRecordState.selectedParticipant,
                recordStartTime: draft.recordStartTime
            });
            fakeChatRecordState.sourceType = result.sourceType;
            fakeChatRecordState.sourceName = fakeChatRecordState.selectedParticipant?.name || result.sourceName;
            fakeChatRecordState.messages = result.messages;
            setFakeChatRecordSourceType(result.sourceType);
            renderFakeChatRecordEditor();
            showDynamicIsland('AI 已生成聊天草稿');
        } catch (error) {
            console.error('[伪造聊天记录] AI 生成失败:', error);
            showDynamicIsland(error.message || 'AI 生成失败', 'error');
        } finally {
            aiBtn.disabled = false;
            aiBtn.classList.remove('is-loading');
            aiBtn.textContent = originalText;
        }
    });
    saveBtn?.addEventListener('click', async () => {
        const charId = tempState.currentChatId;
        const currentChar = AppState.characterProfiles.find(char => isSameCharacterId(char.id, charId));
        const currentUser = getCurrentChatIdentity(charId);
        const draft = collectFakeChatRecordDraft();
        if (!currentChar || !currentUser) {
            showDynamicIsland('当前聊天身份加载失败，请重新打开弹窗', 'error');
            return;
        }
        if (currentChar.isGroup) {
            const isOwner = isSameCharacterId(currentChar.ownerId, currentUser.id)
                || (!currentChar.ownerId && isSameCharacterId(currentUser.id, AppState.userIdentities[0].id));
            const isAdmin = hasCharacterId(currentChar.adminIds, currentUser.id);
            const muteExpire = currentChar.mutedMembers?.[currentUser.id];
            if (currentChar.isMuteAll && !isOwner && !isAdmin) {
                showDynamicIsland('全体禁言中，仅群主和管理员可发言', 'warning');
                return;
            }
            if (muteExpire && (muteExpire === -1 || muteExpire > Date.now())) {
                showDynamicIsland('您已被禁言，请向群管理员求饶解除', 'warning');
                return;
            }
        }
        if (draft.messages.length < 2) {
            showDynamicIsland('至少填写两条完整聊天消息');
            return;
        }
        if (draft.sourceType === 'group' && draft.groupMembers.length < 2) {
            showDynamicIsland('群聊至少需要填写用户和一名群成员');
            return;
        }
        const invalidGroupSpeaker = draft.sourceType === 'group'
            ? draft.messages.find(message => !draft.groupMembers.includes(message.speakerName))
            : null;
        if (invalidGroupSpeaker) {
            showDynamicIsland(`发言人“${invalidGroupSpeaker.speakerName}”不在群成员名单中`);
            return;
        }
        saveBtn.disabled = true;
        try {
            const messages = draft.messages.map(message => ({
                ...message,
                avatarSrc: draft.sourceType === 'single'
                    && message.speakerType !== 'user'
                    && fakeChatRecordState.selectedParticipant?.avatar
                    ? fakeChatRecordState.selectedParticipant.avatar
                    : resolveChatForwardSpeakerAvatar(
                        currentChar,
                        currentUser,
                        draft.sourceName,
                        message.speakerName,
                        message.speakerType
                    )
            }));
            const fakeMessage = {
                chatId: charId,
                timestamp: new Date(),
                text: '[聊天记录]',
                type: 'sent',
                contentType: 'chat_forward',
                chatForwardData: {
                    sourceType: draft.sourceType,
                    sourceName: draft.sourceName,
                    recordStartTime: draft.recordStartTime,
                    groupMembers: draft.groupMembers,
                    messages,
                    showSpeakers: true,
                    hasPlayed: false,
                    createdBy: 'user'
                },
                avatarSrc: currentUser.avatar,
                recalled: false,
                replyToMessageId: null
            };
            const messageId = await db.chatMessages.add(fakeMessage);
            const newMessage = await db.chatMessages.get(messageId);
            await createAndAppendMessage(newMessage);
            updateSidebarPreview(charId, newMessage);
            playUserSendSound(currentChar);
    fakeChatRecordState = {
        sourceType: draft.sourceType,
        sourceName: draft.sourceName,
        recordStartTime: draft.recordStartTime || formatFakeChatRecordDateTimeValue(new Date()),
        selectedParticipantKey: '',
        selectedParticipant: null,
        groupMembers: [],
        messages: []
    };
            closeFakeChatRecordModal();
            showDynamicIsland('已写入剧情聊天记录');
        } catch (error) {
            console.error('[伪造聊天记录] 保存失败:', error);
            showDynamicIsland('写入失败，请稍后重试', 'error');
        } finally {
            saveBtn.disabled = false;
        }
    });
    closeBtn?.addEventListener('click', closeFakeChatRecordModal);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) closeFakeChatRecordModal();
    });
}

function openFakeChatRecordModal() {
    const char = AppState.characterProfiles.find(item => isSameCharacterId(item.id, tempState.currentChatId));
    const user = getCurrentChatIdentity();
    if (!char || !user) return;
    const sourceType = char.isGroup ? 'group' : 'single';
    const groupMember = char.isGroup
        ? AppState.characterProfiles.find(member => hasCharacterId(char.memberIds, member.id))
        : char;
    const groupMembers = char.isGroup
        ? [
            user.name,
            ...(char.memberIds || [])
                .map(memberId => AppState.characterProfiles.find(member => isSameCharacterId(member.id, memberId))?.name)
        ].filter(Boolean).filter((name, index, list) => list.indexOf(name) === index)
        : [];
    fakeChatRecordState = {
        sourceType,
        sourceName: char.isGroup ? (char.chatOverrideName || char.name || '') : '',
        recordStartTime: formatFakeChatRecordDateTimeValue(new Date()),
        selectedParticipantKey: '',
        selectedParticipant: null,
        groupMembers,
        messages: [
            { speakerName: user.name || '用户', speakerType: 'user', text: '', translation: '' },
            { speakerName: char.isGroup ? (groupMember?.name || '') : '', speakerType: char.isGroup ? 'member' : 'char', text: '', translation: '' }
        ]
    };
    const { overlay, prompt } = getFakeChatRecordElements();
    if (!overlay) return;
    bindFakeChatRecordModalEvents();
    populateFakeChatParticipantOptions();
    if (prompt) prompt.value = '';
    setFakeChatRecordSourceType(sourceType);
    renderFakeChatRecordEditor();
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');
}

function getAvailableGroupConversationMembers(group, currentUser) {
    const now = Date.now();
    const ownerId = group.ownerId || currentUser?.id;
    return getGroupParticipants(group).filter(member => {
        const isOwner = isSameCharacterId(member.id, ownerId);
        const isAdmin = hasCharacterId(group.adminIds, member.id);
        const muteExpiresAt = group.mutedMembers?.[member.id];
        const isMuted = muteExpiresAt === -1 || Number(muteExpiresAt) > now;
        return !isMuted && !(group.isMuteAll && !isOwner && !isAdmin);
    });
}

function getGroupConversationRole(group, member, currentUser) {
    if (isSameCharacterId(member.id, group.ownerId || currentUser?.id)) return '群主';
    return hasCharacterId(group.adminIds, member.id) ? '管理员' : '群员';
}

function setGroupMemberConversationLoading(isLoading) {
    const item = document.getElementById('group-member-chat-btn');
    const icon = item?.querySelector('.icon-bg');
    const label = item?.querySelector('.function-label');
    if (!item || !icon || !label) return;

    if (!item.dataset.defaultIcon) item.dataset.defaultIcon = icon.innerHTML;
    item.classList.toggle('is-generating', isLoading);
    item.setAttribute('aria-busy', String(isLoading));
    label.textContent = isLoading ? '生成中' : '他们在聊';
    icon.innerHTML = isLoading
        ? '<span class="group-member-chat-spinner" aria-hidden="true"></span>'
        : item.dataset.defaultIcon;
}

async function generateGroupMemberConversation() {
    const chatId = tempState.currentChatId;
    const group = AppState.characterProfiles.find(char => isSameCharacterId(char.id, chatId));
    const currentUser = getCurrentChatIdentity(chatId);
    if (!group?.isGroup || !currentUser) return;
    if (activeGroupMemberConversationChatId) {
        showDynamicIsland('群成员正在聊天，请等这一轮结束');
        return;
    }

    const participants = getAvailableGroupConversationMembers(group, currentUser);
    if (participants.length < 2) {
        showDynamicIsland('至少需要两名未被禁言的群成员才能开始聊天', 'warning');
        return;
    }

    activeGroupMemberConversationChatId = String(group.id);
    setGroupMemberConversationLoading(true);
    showDynamicIsland('群成员正在聊天…', { persist: true, loading: true });
    try {
        const result = await generateFakeChatRecordWithAI({
            chatId: group.id,
            sourceType: 'group',
            sourceName: group.chatOverrideName || group.name,
            groupMembers: participants.map(member => member.name),
            participantNames: participants.map(member => member.name),
            includeCurrentUser: false,
            generationMode: 'group_member_conversation',
            minMessages: 12,
            maxMessages: 20,
            instruction: '用户正在查看群成员自己聊天。请按照当前群聊使用的成员人格差异、语言习惯、情绪流动和知识隔离规则，只让这些群成员围绕最近群聊和群公开资料自然聊天，生成 12 至 20 条短消息，至少两人发言。禁止让用户发言，禁止旁白、系统提示、红包、转账、私聊或新增人物。'
        });

        const participantByName = new Map(participants.map(member => [member.name, member]));
        const messages = result.messages
            .map(message => ({ ...message, participant: participantByName.get(message.speakerName) }))
            .filter(message => message.participant)
            .slice(0, 20);
        if (messages.length < 12) throw new Error('AI 没有生成足够的群成员消息');

        const baseTimestamp = Date.now();
        for (let index = 0; index < messages.length; index += 1) {
            const { participant, text, translation } = messages[index];
            const messageId = await db.chatMessages.add({
                chatId: group.id,
                timestamp: new Date(baseTimestamp + index * 1200),
                text,
                translation: translation || undefined,
                type: 'received',
                speakerName: participant.name,
                speakerId: participant.id,
                groupRole: getGroupConversationRole(group, participant, currentUser),
                generatedByGroupMemberConversation: true,
                recalled: false,
                replyToMessageId: null
            });
            const savedMessage = await db.chatMessages.get(messageId);
            if (savedMessage) await createAndAppendMessage(savedMessage);
            if (index < messages.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1200));
            }
        }
        showDynamicIsland('本轮群成员聊天已生成', { force: true });
    } catch (error) {
        console.error('[群成员聊天] 生成失败:', error);
        showDynamicIsland(error.message || '群成员聊天生成失败', { force: true });
    } finally {
        setGroupMemberConversationLoading(false);
        activeGroupMemberConversationChatId = null;
    }
}

function closeForwardModal() {
    const overlay = document.getElementById('forward-message-modal-overlay');
    if (overlay) overlay.classList.remove('visible');
}

async function openForwardModal(messageIdOrIds) {
    hideMessageActionPopover();
    const messageIds = (Array.isArray(messageIdOrIds) ? messageIdOrIds : [messageIdOrIds])
        .map(id => Number(id))
        .filter(id => !isNaN(id));
    if (messageIds.length === 0) return;

    const originalMessages = (await db.chatMessages.bulkGet(messageIds))
        .filter(Boolean)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    if (originalMessages.length === 0) {
        showDynamicIsland('消息不存在');
        return;
    }
    const sourceUser = getCurrentChatIdentity(originalMessages[0].chatId) || getCurrentChatIdentity();
    const sourceChar = getForwardSourceCharacter(originalMessages[0]);
    const sourceChatType = sourceChar?.isGroup ? 'group' : 'single';
    const sourceChatName = sourceChar?.chatOverrideName || sourceChar?.name || '聊天';
    const isBatchForward = messageIds.length > 1;

    const overlay = document.getElementById('forward-message-modal-overlay');
    const list = document.getElementById('forward-char-list');
    const cancelBtn = document.getElementById('forward-cancel-btn');
    if (!overlay || !list || !cancelBtn) return;

    const friends = AppState.characterProfiles.filter(char =>
        !char.isGroup &&
        char.inContacts !== false &&
        isCharacterFriend(char) &&
        !isSameCharacterId(char.id, tempState.currentChatId)
    );

    list.innerHTML = '';
    if (friends.length === 0) {
        list.innerHTML = '<div class="forward-message-empty">暂无可转发的好友</div>';
    } else {
        const fragment = document.createDocumentFragment();
        friends.forEach(char => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'forward-message-char-item';
            item.dataset.charId = char.id;
            const displayAvatar = char.chatOverrideAvatar || char.avatar;
            const avatarSrc = isValidAvatarSrc(displayAvatar) ? displayAvatar : DEFAULT_AVATAR_SRC;
            item.innerHTML = `
                <img src="${escapeHTML(avatarSrc)}" alt="">
                <span>${escapeHTML(char.chatOverrideName || char.name || '好友')}</span>
            `;
            item.addEventListener('click', async () => {
                const targetCharId = char.id;
                const currentUser = getCurrentChatIdentity(targetCharId) || getCurrentChatIdentity();
                const forwardedItems = originalMessages.map(message => createForwardedRecordItem(message, sourceUser));
                const firstItem = forwardedItems[0];
                const recordTitle = buildForwardRecordTitle(originalMessages, sourceUser);
                const forwardMessage = {
                    chatId: targetCharId,
                    timestamp: new Date(),
                    text: '[转发消息]',
                    type: 'sent',
                    contentType: 'forwarded_message',
                    forwardedData: {
                        recordTitle,
                        messages: forwardedItems,
                        originalSenderName: firstItem.originalSenderName,
                        originalSenderAvatar: firstItem.originalSenderAvatar,
                        originalText: firstItem.originalText,
                        originalTimestamp: firstItem.originalTimestamp,
                        originalType: firstItem.originalType,
                        originalContentType: firstItem.originalContentType,
                        originalStickerUrl: firstItem.originalStickerUrl || null,
                        forwarderName: currentUser?.name || '你',
                        sourceChatId: originalMessages[0].chatId,
                        sourceChatType,
                        sourceChatName
                    },
                    recalled: false,
                    replyToMessageId: null
                };

                const newMessageId = await db.chatMessages.add(forwardMessage);
                const newMessage = await db.chatMessages.get(newMessageId);
                if (String(targetCharId) === String(tempState.currentChatId)) {
                    await createAndAppendMessage(newMessage);
                }
                updateSidebarPreview(targetCharId, newMessage);
                closeForwardModal();
                if (isBatchForward) exitMultiSelectMode();
                showDynamicIsland('已转发');
            });
            fragment.appendChild(item);
        });
        list.appendChild(fragment);
    }

    cancelBtn.onclick = closeForwardModal;
    overlay.onclick = (event) => {
        if (event.target === overlay) closeForwardModal();
    };
    overlay.classList.add('visible');
}

function showForwardedMessageDetail(messageData) {
    const fd = messageData.forwardedData || {};
    const forwardedItems = getForwardedRecordItems(fd);
    const modal = document.createElement('div');
    modal.className = 'forwarded-message-detail-overlay';
    const title = fd.recordTitle || '聊天记录';
    const detailDate = fd.originalTimestamp
        ? new Date(fd.originalTimestamp).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
        : '';
    modal.innerHTML = `
        <div class="forwarded-message-detail-card">
            <div class="forwarded-detail-header">
                <button type="button" class="forwarded-detail-close" aria-label="返回">‹</button>
                <div class="forwarded-detail-title">
                    <strong>${escapeHTML(title)}</strong>
                    <span>${escapeHTML(detailDate)}</span>
                </div>
            </div>
            <div class="forwarded-detail-body">
                ${forwardedItems.map(item => {
                    const avatarSrc = isValidAvatarSrc(item.originalSenderAvatar) ? item.originalSenderAvatar : DEFAULT_AVATAR_SRC;
                    return `
                        <div class="forwarded-record-row">
                            <img class="forwarded-record-avatar" src="${escapeHTML(avatarSrc)}" alt="">
                            <div class="forwarded-record-main">
                                <div class="forwarded-record-meta">
                                    <span>${escapeHTML(item.originalSenderName || '未知发送者')}</span>
                                    <time>${escapeHTML(formatForwardedMessageTime(item.originalTimestamp).split(' ').pop() || '')}</time>
                                </div>
                                ${renderForwardedDetailContent(item)}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('visible'), 10);

    const close = () => {
        modal.classList.remove('visible');
        setTimeout(() => modal.remove(), 200);
    };
    modal.querySelector('.forwarded-detail-close')?.addEventListener('click', close);
    modal.addEventListener('click', (event) => {
        if (event.target === modal) close();
    });
}

async function showChatForwardViewer(messageData) {
    const isGenericForward = messageData.contentType === 'chat_forward';
    const dataKey = isGenericForward ? 'chatForwardData' : 'npcChatForwardData';
    const fd = messageData[dataKey] || {};
    const viewer = document.getElementById('npc-chat-forward-viewer');
    const backBtn = document.getElementById('npc-fw-back-btn');
    const avatarEl = document.getElementById('npc-fw-avatar');
    const nameEl = document.getElementById('npc-fw-name');
    const messagesContainer = document.getElementById('npc-fw-messages');
    if (!viewer || !backBtn || !avatarEl || !nameEl || !messagesContainer) return;

    const runId = ++activeNpcForwardViewerRun;
    const closeViewer = () => {
        if (runId !== activeNpcForwardViewerRun) return;
        activeNpcForwardViewerRun++;
        viewer.classList.remove('visible');
        messagesContainer.innerHTML = '';
    };
    backBtn.onclick = closeViewer;
    viewer.onclick = event => {
        if (event.target === viewer) closeViewer();
    };

    const sourceChar = AppState.characterProfiles.find(char => isSameCharacterId(char.id, messageData.chatId));
    const npc = (sourceChar?.relatedNpcs || []).find(item => item.name === fd.npcName);
    const rawMessages = Array.isArray(fd.messages) ? fd.messages.filter(item => item && item.text) : [];
    const messages = isGenericForward
        ? rawMessages.map(item => ({
            isChar: item.speakerType === 'char',
            speakerType: item.speakerType || 'member',
            speakerName: item.speakerName || '未知',
            avatarSrc: item.avatarSrc || '',
            text: item.text || '',
            translation: item.translation || ''
        }))
        : rawMessages.map(item => ({
            isChar: !!item.isChar,
            speakerType: item.isChar ? 'char' : 'npc',
            speakerName: item.isChar ? (fd.charName || '角色') : (fd.npcName || 'NPC'),
            avatarSrc: item.isChar ? messageData.avatarSrc : npc?.avatar,
            text: item.text || '',
            translation: item.translation || ''
        }));
    if (messages.length === 0) return;

    const showGroupAvatars = isGenericForward && (fd.sourceType === 'group' || fd.showSpeakers === true);
    const headerAvatar = isGenericForward
        ? messages.find(item => item.avatarSrc && item.speakerType !== 'user')?.avatarSrc || messageData.avatarSrc
        : npc?.avatar;
    avatarEl.src = isValidAvatarSrc(headerAvatar) ? headerAvatar : DEFAULT_AVATAR_SRC;
    nameEl.textContent = isGenericForward
        ? (fd.sourceName || '聊天记录')
        : (fd.npcName || 'NPC聊天记录');
    messagesContainer.innerHTML = '';
    viewer.classList.add('visible');

    const appendMessage = (item, visible = false) => {
        const msgEl = document.createElement('div');
        const sideClass = item.isChar ? 'is-char' : 'is-npc';
        msgEl.className = `npc-fw-msg ${sideClass}${showGroupAvatars ? ' has-avatar' : ''}${visible ? ' visible' : ''}`;
        const bubbleText = escapeHTML(item.text || '').replace(/\n/g, '<br>');
        const translationText = String(item.translation || '').trim();
        const translation = translationText
            ? `<div class="npc-fw-msg-translation" data-translation-expanded="true">${escapeHTML(translationText).replace(/\n/g, '<br>')}</div>`
            : '';
        const avatarHtml = showGroupAvatars
            ? (isValidAvatarSrc(item.avatarSrc) && item.avatarSrc !== DEFAULT_AVATAR_SRC
                ? `<img class="npc-fw-message-avatar" src="${escapeHTML(item.avatarSrc)}" alt="">`
                : `<span class="npc-fw-message-avatar npc-fw-message-avatar-fallback" aria-hidden="true">${escapeHTML((item.speakerName || '?').slice(0, 1))}</span>`)
            : '';
        const speakerHtml = showGroupAvatars
            ? `<div class="npc-fw-msg-speaker">${escapeHTML(item.speakerName || '未知')}</div>`
            : '';
        msgEl.innerHTML = `${avatarHtml}<div class="npc-fw-msg-content">${speakerHtml}<div class="fw-msg-bubble">${bubbleText}${translation}</div></div>`;
        messagesContainer.appendChild(msgEl);
        return msgEl;
    };
    const wait = delay => new Promise(resolve => setTimeout(resolve, delay));

    if (!fd.hasPlayed) {
        for (const item of messages) {
            if (runId !== activeNpcForwardViewerRun || !viewer.classList.contains('visible')) return;
            const typing = document.createElement('div');
            typing.className = 'npc-fw-typing-indicator';
            typing.innerHTML = '<span></span><span></span><span></span>';
            typing.style.alignSelf = item.isChar ? 'flex-end' : 'flex-start';
            messagesContainer.appendChild(typing);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
            await wait(600 + Math.random() * 300);
            if (runId !== activeNpcForwardViewerRun || !viewer.classList.contains('visible')) return;
            typing.remove();
            const msgEl = appendMessage(item);
            requestAnimationFrame(() => msgEl.classList.add('visible'));
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
            await wait(220);
        }
        if (runId !== activeNpcForwardViewerRun || !viewer.classList.contains('visible')) return;
        const playedData = { ...fd, hasPlayed: true };
        await db.chatMessages.update(messageData.id, { [dataKey]: playedData });
        if (runId !== activeNpcForwardViewerRun || !viewer.classList.contains('visible')) return;
        const historyItem = AppState.currentChatHistory?.find(item => item.id === messageData.id);
        if (historyItem) historyItem[dataKey] = playedData;
    } else {
        messages.forEach(item => appendMessage(item, true));
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
}

async function showNpcChatForwardViewer(messageData) {
    return showChatForwardViewer(messageData);
}

// ... 此处省略 sticker picker 和 initChatInterface 的代码 ...
// ... 因为它们与当前 bug 无关，保持你原有的即可 ...
// ... 一直到文件末尾 ...

// ... (粘贴你文件中从 setupStickerPicker() 开始到文件末尾的所有代码) ...
// (由于代码过长，此处省略，你只需复制粘贴此代码块之前的部分，并保留你自己的 setupStickerPicker 和 initChatInterface 函数即可)

// 确保你文件中 setupStickerPicker 和 initChatInterface 函数及其之后的所有代码都保留
function setupStickerPicker() {
  const emojiBtn = document.getElementById('emoji-btn');
  const stickerPickerPanel = document.getElementById('sticker-picker-panel');
  const stickerPickerContent = document.getElementById('sticker-picker-content');
  const stickerPickerTabs = document.getElementById('sticker-picker-tabs');
  const forumComposeStickerBtn = document.getElementById('forum-compose-sticker-btn');
  const forumDetailStickerBtn = document.getElementById('detail-comment-sticker-btn');
  if (!emojiBtn || !stickerPickerPanel) return;
  if (stickerPickerPanel.parentElement !== document.body) document.body.appendChild(stickerPickerPanel);
  
  let currentPackId = null;
  let enabledPacks = [];
  let currentPickerContext = 'chat';
  let currentAnchorEl = emojiBtn;

  const renderPackTabs = () => {
    stickerPickerTabs.innerHTML = '';
    if (enabledPacks.length === 0) return;
    const fragment = document.createDocumentFragment();
    enabledPacks.forEach((pack, index) => {
      const tab = document.createElement('div');
      tab.className = 'sticker-pack-tab';
      tab.dataset.packId = pack.id;
      tab.textContent = pack.name;
      if (index === 0 && !currentPackId) {
        tab.classList.add('active');
        currentPackId = pack.id;
      } else if (pack.id === currentPackId) {
        tab.classList.add('active');
      }
      fragment.appendChild(tab);
    });
    stickerPickerTabs.appendChild(fragment);
  };
const promoteStickerPackTab = (packId) => {
    if (!packId) return; // 如果没有ID，就啥也不干
    const tabToMove = stickerPickerTabs.querySelector(`.sticker-pack-tab[data-pack-id="${packId}"]`);
    // 如果找到了这个标签，并且它不是第一个
    if (tabToMove && stickerPickerTabs.firstElementChild !== tabToMove) {
        // 就把它移动到最前面
        stickerPickerTabs.prepend(tabToMove);
    }
};
  const sortStickerPacksForPicker = packs => {
    return packs
      .map((pack, index) => ({ pack, index }))
      .sort((a, b) => (Number(b.pack.lastUsedAt) || 0) - (Number(a.pack.lastUsedAt) || 0) || a.index - b.index)
      .map(item => item.pack);
  };

  const updateStickerPackLastUsed = async packId => {
    const pack = enabledPacks.find(p => p.id === packId);
    if (!pack) return;
    pack.lastUsedAt = Date.now();
    try {
      await db.stickerGroups.put(pack);
      const statePack = AppState.stickerGroups?.find(p => p.id === packId);
      if (statePack) statePack.lastUsedAt = pack.lastUsedAt;
    } catch (error) {
      console.error('Failed to update sticker pack order:', error);
    }
  };
  const renderStickersForPack = (packId) => {
    const pack = enabledPacks.find(p => p.id === packId);
    if (!pack || !pack.stickers || pack.stickers.length === 0) {
      stickerPickerContent.innerHTML = `<div class="sticker-picker-empty">此分组暂无表情</div>`;
      return;
    }
    const fragment = document.createDocumentFragment();
    pack.stickers.forEach((sticker, index) => {
      const item = document.createElement('div');
      item.className = 'sticker-picker-item';
      item.dataset.packId = packId;
      item.dataset.stickerIndex = index;
      item.innerHTML = `<div class="sticker-image-wrapper"><img src="${sticker.url}" alt="${escapeHTML(sticker.explanation)}" title="${escapeHTML(sticker.explanation)}"></div><p class="sticker-label">${escapeHTML(sticker.explanation)}</p>`;
      fragment.appendChild(item);
    });
    stickerPickerContent.innerHTML = '';
    stickerPickerContent.appendChild(fragment);
  };

  const positionStickerPicker = () => {
    const viewport = window.visualViewport;
    const isNativeLayout = document.documentElement.classList.contains('looky-native');
    const keyboardOpen = isNativeLayout && (document.body.classList.contains('android-pwa-keyboard-open') || Boolean(
      viewport && window.innerHeight - viewport.height > 80
    ));
    if (!currentAnchorEl || (currentPickerContext === 'chat' && !keyboardOpen)) {
      stickerPickerPanel.style.position = '';
      stickerPickerPanel.style.left = '';
      stickerPickerPanel.style.top = '';
      stickerPickerPanel.style.removeProperty('bottom');
      stickerPickerPanel.style.removeProperty('max-height');
      stickerPickerContent.style.removeProperty('max-height');
      stickerPickerPanel.style.transform = '';
      return;
    }
    const rect = currentAnchorEl.getBoundingClientRect();
    const viewportTop = Math.max(0, viewport?.offsetTop || 0);
    const viewportWidth = viewport?.width || window.innerWidth;
    const viewportHeight = viewport?.height || window.innerHeight;
    const viewportBottom = viewportTop + viewportHeight;
    const panelWidth = Math.min(350, Math.floor(viewportWidth * 0.88));
    const panelHeight = Math.min(stickerPickerPanel.offsetHeight || 300, Math.max(0, viewportHeight - 24));
    const left = Math.max(12, Math.min(viewportWidth - panelWidth - 12, rect.left + rect.width / 2 - panelWidth / 2));
    const top = Math.max(viewportTop + 12, Math.min(viewportBottom - panelHeight - 12, rect.top - panelHeight - 12));
    stickerPickerPanel.style.position = 'fixed';
    stickerPickerPanel.style.left = `${left}px`;
    stickerPickerPanel.style.top = `${top}px`;
    stickerPickerPanel.style.setProperty('bottom', 'auto', 'important');
    stickerPickerPanel.style.transform = 'none';
  };

  let stickerPickerPositionFrame = 0;
  const scheduleStickerPickerPosition = () => {
    if (stickerPickerPanel.classList.contains('hidden') || stickerPickerPositionFrame) return;
    stickerPickerPositionFrame = window.requestAnimationFrame(() => {
      stickerPickerPositionFrame = 0;
      if (!stickerPickerPanel.classList.contains('hidden')) positionStickerPicker();
    });
  };

  const rescheduleStickerPickerPosition = () => {
    scheduleStickerPickerPosition();
  };

  window.addEventListener('looky:native-viewport-changed', rescheduleStickerPickerPosition, { passive: true });
  window.visualViewport?.addEventListener('resize', rescheduleStickerPickerPosition, { passive: true });
  window.visualViewport?.addEventListener('scroll', rescheduleStickerPickerPosition, { passive: true });
  window.addEventListener('resize', rescheduleStickerPickerPosition, { passive: true });

  const showStickerPicker = async (context = 'chat', anchorEl = emojiBtn) => {
    currentPickerContext = context;
    currentAnchorEl = anchorEl || emojiBtn;
    if (context === 'chat') window.__pauseAutoTriggerCountdown?.();
    const allPacks = await db.stickerGroups.toArray();
    if (context !== 'chat') {
      const forumPackIds = window.Forum?.getCurrentStickerPackIds?.() || [];
      if (forumPackIds.length === 0) {
        stickerPickerContent.innerHTML = `<div class="sticker-picker-empty">请先在论坛设置里配置可用表情包</div>`;
        stickerPickerTabs.innerHTML = '';
        positionStickerPicker();
        stickerPickerPanel.classList.remove('hidden');
        return;
      }
      enabledPacks = sortStickerPacksForPicker(allPacks.filter(pack =>
        forumPackIds.includes(pack.id) && Array.isArray(pack.stickers) && pack.stickers.length > 0));
      if (enabledPacks.length === 0) {
        stickerPickerContent.innerHTML = `<div class="sticker-picker-empty">已授权的表情包不存在</div>`;
        stickerPickerTabs.innerHTML = '';
        positionStickerPicker();
        stickerPickerPanel.classList.remove('hidden');
        return;
      }
      currentPackId = enabledPacks.some(pack => pack.id === currentPackId) ? currentPackId : enabledPacks[0].id;
      renderPackTabs();
      renderStickersForPack(currentPackId);
      positionStickerPicker();
      stickerPickerPanel.classList.remove('hidden');
      return;
    }
    const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
    if (!char) return;
    const enabledPackIds = char.enabledStickerPacks || [];
    if (enabledPackIds.length === 0) {
      stickerPickerContent.innerHTML = `<div class="sticker-picker-empty"><p>此对话未启用任何表情包</p><p style="font-size: 12px; margin-top: 8px;">请在聊天设置中配置</p></div>`;
      stickerPickerTabs.innerHTML = '';
      positionStickerPicker();
      stickerPickerPanel.classList.remove('hidden');
      return;
    }
    enabledPacks = sortStickerPacksForPicker(allPacks.filter(pack => enabledPackIds.includes(pack.id)));
    if (enabledPacks.length === 0) {
      stickerPickerContent.innerHTML = `<div class="sticker-picker-empty">已启用的表情包不存在</div>`;
      stickerPickerTabs.innerHTML = '';
    } else {
      currentPackId = enabledPacks.some(pack => pack.id === currentPackId) ? currentPackId : enabledPacks[0].id;
      renderPackTabs();
      renderStickersForPack(currentPackId);
    }
    positionStickerPicker();
    stickerPickerPanel.classList.remove('hidden');
  };
  
  const hideStickerPicker = () => {
    if (stickerPickerPositionFrame) {
      window.cancelAnimationFrame(stickerPickerPositionFrame);
      stickerPickerPositionFrame = 0;
    }
    stickerPickerPanel.classList.add('hidden');
    if (currentPickerContext === 'chat') window.__resumeAutoTriggerCountdown?.();
  };
  window.addEventListener('looky:page-opened', hideStickerPicker, { passive: true });
  const sendSticker = async (stickerData, packId, index) => {
    if (currentPickerContext !== 'chat') {
      document.dispatchEvent(new CustomEvent('forum:sticker-selected', {
        detail: {
          context: currentPickerContext,
          sticker: {
            id: stickerData.id || `${packId}_${index}`,
            type: 'sticker',
            url: stickerData.url,
            explanation: stickerData.explanation || ''
          }
        }
      }));
      hideStickerPicker();
      return;
    }
    if (!tempState.currentChatId) return;

    // ▼▼▼ 新增：群聊禁言拦截系统 (表情版) ▼▼▼
    const chatChar = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
    if (chatChar && chatChar.isGroup) {
        const checkUser = getCurrentChatIdentity();
        const groupOwnerId = chatChar.ownerId || checkUser.id;
        const isOwner = isSameCharacterId(groupOwnerId, checkUser.id);
        const isAdmin = hasCharacterId(chatChar.adminIds, checkUser.id);
        
        if (chatChar.isMuteAll && !isOwner && !isAdmin) {
            if (typeof showDynamicIsland === 'function') showDynamicIsland('全体禁言中，无法发送表情', 'warning');
            return; // 截断发送
        }
        if (chatChar.mutedMembers && chatChar.mutedMembers[checkUser.id]) {
            const exp = chatChar.mutedMembers[checkUser.id];
            if (exp === -1 || exp > Date.now()) {
                if (typeof showDynamicIsland === 'function') showDynamicIsland('您已被禁言，无法发送表情', 'warning');
                return; // 截断发送
            }
        }
    }
    // ▲▲▲ 拦截系统结束 ▲▲▲
    const currentUser = getCurrentChatIdentity();
    const messageToSave = {
      chatId: tempState.currentChatId,
      timestamp: new Date(),
      text: `[表情: ${stickerData.explanation}]`,
      type: 'sent',
      avatarSrc: currentUser.avatar,
      stickerUrl: stickerData.url,
      recalled: false,
      replyToMessageId: tempState.replyingToId || null,
      isRejected: chatChar && chatChar.isBlockedByAi ? true : false, // 新增：如果被AI拉黑，打上拒收标记
    };
    if (isChatInActiveCall(tempState.currentChatId)) {
        messageToSave.callId = tempState.currentCallId;
    }

    const messageId = await db.chatMessages.add(messageToSave);
    const newMessage = await db.chatMessages.get(messageId);
    await createAndAppendMessage(newMessage);
    playUserSendSound(chatChar);

    cancelReplyMode();
    if (window.__autoTriggerCountdown) window.__autoTriggerCountdown();
    hideStickerPicker();
  };
  window.__sendChatStickerSuggestion = (stickerData, packId, index) => {
    currentPickerContext = 'chat';
    return sendSticker(stickerData, packId, index);
  };
 stickerPickerTabs.addEventListener('click', async (e) => {
  const tab = e.target.closest('.sticker-pack-tab');
  if (!tab) return;
  const packId = tab.dataset.packId;

  // 【核心修改】在这里调用移动函数，实现立即置顶！
  promoteStickerPackTab(packId); 
  await updateStickerPackLastUsed(packId);

  if (packId === currentPackId) return;
  stickerPickerTabs.querySelectorAll('.sticker-pack-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  currentPackId = packId;
  renderStickersForPack(packId);
});


  addTapListener(emojiBtn, (e) => {
    e.stopPropagation();
    if (stickerPickerPanel.classList.contains('hidden')) {
      showStickerPicker('chat', emojiBtn);
    } else {
      hideStickerPicker();
    }
  });

  const bindForumStickerButton = (button, context) => {
    if (!button) return;
    addTapListener(button, (e) => {
      e.stopPropagation();
      if (stickerPickerPanel.classList.contains('hidden') || currentPickerContext !== context) {
        showStickerPicker(context, button);
      } else {
        hideStickerPicker();
      }
    });
  };
  bindForumStickerButton(forumComposeStickerBtn, 'forum-compose');
  bindForumStickerButton(forumDetailStickerBtn, 'forum-detail-comment');

  stickerPickerContent.addEventListener('click', async (e) => {
    const item = e.target.closest('.sticker-picker-item');
    if (!item) return;
    const packId = item.dataset.packId;
    const index = parseInt(item.dataset.stickerIndex, 10);
    if (isNaN(index)) return;
    const pack = enabledPacks.find(p => p.id === packId);
    if (!pack || !pack.stickers || !pack.stickers[index]) return;
    await sendSticker(pack.stickers[index], packId, index);
   
  });

  document.addEventListener('click', (e) => {
    const clickedAnchor = [emojiBtn, forumComposeStickerBtn, forumDetailStickerBtn].some(btn => btn && btn.contains(e.target));
    const clickedStickerInput = ['chat-input-field', 'detail-comment-input', 'forum-compose-full-text']
      .some(id => document.getElementById(id)?.contains(e.target));
    if (!stickerPickerPanel.classList.contains('hidden') && !stickerPickerPanel.contains(e.target) && !clickedAnchor && !clickedStickerInput) {
      hideStickerPicker();
    }
  });
}
async function continueConversation() {
    if (window.__autoTriggerTimer) {
        clearTimeout(window.__autoTriggerTimer);
        window.__autoTriggerTimer = null;
    }
    window.__autoTriggerArmed = false;
    window.__autoTriggerArmedChatId = null;
    if (!tempState.currentChatId) return;
    if (isChatInActiveCall(tempState.currentChatId)) {
        showDynamicIsland('通话中的角色不能继续在线聊天', 'warning');
        return;
    }
    const lockedChatId = tempState.currentChatId;
    if (isModeGenerating('online', tempState.currentChatId)) {
        cancelAiGeneration('online', tempState.currentChatId);
        const sendBtn = document.getElementById('send-message-btn');
        if (sendBtn) sendBtn.classList.remove('loading');
        const chatCharForCancel = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (UI.chatDetailName && chatCharForCancel) UI.chatDetailName.textContent = chatCharForCancel.chatOverrideName || chatCharForCancel.name;
        showDynamicIsland('已打断生成');
        return;
    }
    // 新增：如果被角色主动拉黑，不再触发AI回复，并显示拒收提示
    const chatChar = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
    if (chatChar && chatChar.isBlockedByAi) {
        import('./chat-service.js').then(({ addSystemEventMessage }) => {
            addSystemEventMessage(tempState.currentChatId, '消息已发出，但被对方拒收了。', 'info');
        });
        return;
    }
    // 确保输入框确实是空的
    const chatInputField = document.getElementById('chat-input-field');
    if (chatInputField.value.trim().length > 0) {
        return; 
    }
    try {
        // 获取当前聊天的最后一条消息
        const lastMessage = await db.chatMessages
            .where('chatId')
            .equals(tempState.currentChatId)
            .last();
        // 【核心判断】只有在聊天为空，或者最后一条消息是AI发的 ('received') 情况下，才需要注入“续写”指令
        if (!lastMessage || lastMessage.type === 'received') {
            const currentUser = getCurrentChatIdentity();
            // 构造一条用户看不见，但AI能看见的特殊消息
            const invisiblePromptMessage = {
                chatId: tempState.currentChatId,
                timestamp: new Date(),
                text: '（请不要输出这句话）根据你的人设与当前剧情，对你上一条回复进行自然的补充或发展，让对话继续下去，注意内容不要重复。',
                type: 'sent', // 模拟用户发送
                avatarSrc: currentUser.avatar,
                uiVisible: false, // 关键：UI渲染时会跳过这条消息
                aiVisible: true,  // 关键：确保AI能看到这条消息
                recalled: false,
                replyToMessageId: null,
            };
            // 存入数据库，但不在界面上显示
            await db.chatMessages.add(invisiblePromptMessage);
        }
        
        // 无论是否注入了新指令，都触发AI回应
        await triggerAiResponse();
        await processPendingPhoneNpcReveal(lockedChatId);
    } catch (error) {
        console.error("Failed to continue conversation:", error);
        showDynamicIsland('续写失败，请稍后再试');
    }
}

function showInnerThoughts(text) {
    const modal = document.getElementById('inner-thoughts-modal-overlay');
    const content = document.getElementById('inner-thoughts-text');
    text = typeof text === 'string' ? text : String(text || '');    
    const closeBtn = document.getElementById('close-thoughts-btn');
    if (!modal || !content) return;
    const user = getCurrentChatIdentity();
    const isMale = user && ((user.persona && user.persona.includes('男')) || (user.name && user.name.match(/先生|哥|男/)));
    const pronoun = isMale ? '他' : '她';
    text = text.replace(/这丫头|这小孩|这小丫头|小丫头|那丫头/g, pronoun);
    // 1. 简单的 Markdown 解析：将 **文字** 转换为 <strong>文字</strong>
    // 这样样式里的“朱砂红”效果就会生效了
    const formattedText = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // 2. 使用 innerHTML 填充，而不是 textContent，这样标签才会生效
    content.innerHTML = formattedText;
    
    // 显示弹窗
    modal.classList.add('visible');

    // 关闭逻辑
    const closeModal = () => {
        modal.classList.remove('visible');
    };

    closeBtn.onclick = closeModal;
    modal.onclick = (e) => {
        if (e.target === modal) closeModal();
    };
}

function getCurrentAssistantActionContext() {
    const chatId = tempState.currentChatId;
    const char = AppState.characterProfiles.find(c => isSameCharacterId(c.id, chatId));
    const user = getCurrentChatIdentity(chatId);
    return { chatId, char, user };
}

function isAssistantActionBlocked(char, blockedText = '当前状态下无法操作') {
    if (!char) {
        showDynamicIsland('请先进入一个聊天');
        return true;
    }
    if (char.isBlocked || char.isBlockedByAi) {
        showDynamicIsland(blockedText, 'warning');
        return true;
    }
    return false;
}

function closePlotPushModal() {
    const modal = document.getElementById('plot-push-modal-overlay');
    const textarea = document.getElementById('plot-push-textarea');
    if (modal) modal.classList.remove('visible');
    if (textarea) textarea.value = '';
}

function openPlotPushModal() {
    const { char } = getCurrentAssistantActionContext();
    if (isAssistantActionBlocked(char, '异常状态下无法推动剧情')) return;
    const modal = document.getElementById('plot-push-modal-overlay');
    const textarea = document.getElementById('plot-push-textarea');
    if (!modal || !textarea) return;
    modal.classList.add('visible');
    requestAnimationFrame(() => textarea.focus());
}

async function submitPlotPush() {
    const textarea = document.getElementById('plot-push-textarea');
    const plotText = textarea?.value.trim();
    if (!plotText) {
        showDynamicIsland('请先写旁白内容');
        return;
    }

    const { chatId, char, user } = getCurrentAssistantActionContext();
    if (!chatId || isAssistantActionBlocked(char, '异常状态下无法推动剧情')) return;

    const charName = char.chatOverrideName || char.name || '角色';
    const userName = user?.name || '用户';
    const baseTime = Date.now();
    const hiddenInstruction = `<SYSTEM_NARRATION_OVERRIDE>
[剧情推动｜最高优先级场景/前提设定]
用户 "${userName}" 刚刚插入了一段旁白/前提，用来改变当前聊天情境或推动剧情。你必须立即把它当成当前场景的真实前提，并据此调整 "${charName}" 的反应、语气、行动和关注点。

【旁白内容】
${plotText}

【执行要求】
1. 立刻承接这段旁白所设定的情境，不要忽略，不要拖到下一轮。
2. 不要复述这条系统提示，不要说“收到指令”，不要解释你看到了旁白。
3. 继续保持角色设定、记忆、世界书和当前聊天输出格式。
</SYSTEM_NARRATION_OVERRIDE>`;

    await db.chatMessages.add({
        chatId,
        timestamp: new Date(baseTime),
        text: hiddenInstruction,
        type: 'sent',
        avatarSrc: user?.avatar,
        uiVisible: false,
        aiVisible: true,
        recalled: false,
        replyToMessageId: null
    });

    const visibleId = await db.chatMessages.add({
        chatId,
        timestamp: new Date(baseTime + 5),
        text: plotText,
        type: 'sent',
        contentType: 'narration',
        avatarSrc: user?.avatar,
        uiVisible: true,
        aiVisible: false,
        recalled: false,
        replyToMessageId: null
    });
    const visibleMessage = await db.chatMessages.get(visibleId);
    if (visibleMessage) await createAndAppendMessage(visibleMessage);

    closePlotPushModal();
    showDynamicIsland('剧情已推动');
    triggerAiResponse(null, chatId).catch(error => {
        console.error('[PlotPush] trigger AI failed:', error);
        showDynamicIsland('剧情已插入，但AI响应失败');
    });
}

function closeOocNudgeModal() {
    const modal = document.getElementById('ooc-nudge-modal-overlay');
    const customArea = document.getElementById('ooc-custom-area');
    const textarea = document.getElementById('ooc-custom-textarea');
    if (modal) modal.classList.remove('visible');
    if (customArea) customArea.hidden = true;
    if (textarea) textarea.value = '';
}

function openOocNudgeModal() {
    const { char } = getCurrentAssistantActionContext();
    if (isAssistantActionBlocked(char, '异常状态下无法发送肘击')) return;
    const modal = document.getElementById('ooc-nudge-modal-overlay');
    const customArea = document.getElementById('ooc-custom-area');
    if (!modal) return;
    if (customArea) customArea.hidden = true;
    modal.classList.add('visible');
}

async function hasRegenerableOnlineResponse(chatId) {
    if (!chatId) return false;
    const recentMessages = await db.chatMessages.where({ chatId }).reverse().limit(40).toArray();
    for (const msg of recentMessages) {
        if (msg.type === 'received' || (msg.type === 'system' && msg.linkedMsgIds)) return true;
        break;
    }
    return false;
}

async function applyOocNudge(text, successText) {
    const { chatId, char } = getCurrentAssistantActionContext();
    if (!chatId || isAssistantActionBlocked(char, '异常状态下无法发送肘击')) return;
    if (isChatInActiveCall(chatId)) {
        showDynamicIsland('通话中的角色不能继续在线操作', 'warning');
        return;
    }
    const saved = setOocNudgeInstruction(chatId, text, 4);
    if (!saved) {
        showDynamicIsland('肘击内容不能为空');
        return;
    }
    const canRegenerate = await hasRegenerableOnlineResponse(chatId);
    if (canRegenerate) {
        regenerateLastResponse();
    }
    showDynamicIsland(successText);
}

export function initChatInterface() {
   
    // ▼▼▼ 架构级修复：接管你预留的事件，完美解决返回白屏与遮罩丢失 ▼▼▼
    // 1. 监听系统在其他地方(如病毒弹窗)派发的刷新请求，并在内存中打上待刷新标记
    document.addEventListener('chat_history_need_refresh', (e) => {
        if (e.detail && e.detail.chatId) {
            tempState.pendingChatRefreshId = e.detail.chatId;
        }
    });

    // 2. 核心：使用 MutationObserver 监听聊天页面的物理显示状态
    // 确保只有在页面真正显示出来（拥有物理高度）时才渲染，否则拉黑遮罩和滚动条都会计算失效！
    const chatPageEl = document.getElementById('page-chat-detail');
    if (chatPageEl) {
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                const isVisible = window.getComputedStyle(chatPageEl).display !== 'none';
                // 如果页面从隐藏变为可见了，且身上有待刷新的标记
                if (isVisible && tempState.pendingChatRefreshId) {
                    const targetId = tempState.pendingChatRefreshId;
                    tempState.pendingChatRefreshId = null; // 消费掉该标记
                    
                    console.log(`[状态机修复] 页面显示就绪，正在重绘角色 ${targetId} 的聊天记录与拉黑遮罩...`);
                    // 调用你写好的完美渲染函数
                    loadAndRenderChatHistory(targetId, true);
                }
            });
        });
        observer.observe(chatPageEl, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    // ▲▲▲ 修复结束 ▲▲▲

    const chatInputField = document.getElementById('chat-input-field');
    const textInputWrapper = document.querySelector('#page-chat-detail .text-input-wrapper');
    const emojiBtn = document.querySelector('.chat-emoji-btn');
    const sendMessageBtn = document.getElementById('send-message-btn');
    const sendToScreenBtn = document.getElementById('send-to-screen-btn');
    setupChatStickerMatch(chatInputField);
    // ▼▼▼ 新增：拦截顶部通话按钮 (利用捕获阶段强行截断) ▼▼▼
    const callBtnTop = document.getElementById('call-btn');
    if (callBtnTop) {
        callBtnTop.addEventListener('click', (e) => {
            const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            if (char && (char.isBlocked || char.isBlockedByAi)) {
                e.stopPropagation(); // 阻止事件传递到通话代码，强行拦截
                if (typeof showDynamicIsland === 'function') showDynamicIsland(char.isBlockedByAi ? '对方开启了好友验证，无法发起通话' : '已拉黑，无法发起通话', 'warning');
            }
        }, true); // 注意这里的 true 非常重要，它是霸道抢占事件的关键
    }
    // ▲▲▲ 新增结束 ▲▲▲
    // 我们之前删除了 deleteRequest listener，这里也不再需要它了
    // document.addEventListener('deleteRequest', (e) => deleteMessage(e.detail.messageId));
    document.addEventListener('recallRequest', (e) => recallMessage(e.detail.messageId, e.detail.isAiRecall || false));
    
    // 监听群主、管理员、头衔变动，实时重绘气泡颜色
    const reRenderChatIfMatch = async (e) => {
        if (String(e.detail.chatId) === String(tempState.currentChatId)) {
            await loadAndRenderChatHistory(tempState.currentChatId);
        }
    };
    document.addEventListener('group_owner_updated', reRenderChatIfMatch);
    document.addEventListener('group_member_info_updated', reRenderChatIfMatch);

    document.getElementById('cancel-multiselect-btn').addEventListener('click', exitMultiSelectMode);
    document.getElementById('forward-selected-btn')?.addEventListener('click', handleForwardSelectedMessages);
    document.getElementById('delete-selected-btn').addEventListener('click', handleDeleteSelectedMessages);

    if (chatInputField && textInputWrapper && emojiBtn && sendMessageBtn) {
        let inputRafId = null;
        let mentionPanelRenderedKey = '';
        let autoTriggerTimer = null;
        let isSendingMessageToScreen = false;
        window.__autoTriggerArmed = false;
        window.__autoTriggerArmedChatId = null;
        window.__autoTriggerPaused = false;
        chatInputField.addEventListener('input', () => {
            if (inputRafId) cancelAnimationFrame(inputRafId);
            
            inputRafId = requestAnimationFrame(() => {
                const hasText = chatInputField.value.trim().length > 0;
                            if (textInputWrapper.classList.contains('expanded') !== hasText) {
                    textInputWrapper.classList.toggle('expanded', hasText);
                    textInputWrapper.classList.toggle('has-text', hasText);
                    emojiBtn.classList.toggle('fade-out', hasText);
                    sendMessageBtn.classList.toggle('fade-out', hasText);
                }
                if (hasText && window.__autoTriggerTimer) {
                    clearTimeout(window.__autoTriggerTimer);
                    window.__autoTriggerTimer = null;
                    autoTriggerTimer = null;
                }
                if (
                    !hasText &&
                    window.__autoTriggerArmed &&
                    !window.__autoTriggerTimer &&
                    String(window.__autoTriggerArmedChatId || '') === String(tempState.currentChatId || '')
                ) {
                    startAutoTriggerCountdown();
                }
                 // ▼▼▼ 新增：处理 @ 选人面板逻辑 (QQ精致仿版) ▼▼▼
                const val = chatInputField.value;
                const mentionPanel = document.getElementById('chat-mention-panel');
                const mentionList = document.getElementById('mention-list');
                const mentionPanelVisible = mentionPanel && mentionPanel.style.display !== 'none';
                if (!val.endsWith('@') && !mentionPanelVisible) return;
                if (!val.endsWith('@')) {
                    mentionPanelRenderedKey = '';
                    if (mentionPanel && mentionPanel.style.display !== 'none') mentionPanel.style.display = 'none';
                    return;
                }
                const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
                
                if (char && char.isGroup && val.endsWith('@')) {
                    const identityId = char.chatIdentityId || AppState.currentIdentityId;
                    const currentUser = AppState.userIdentities.find(identity => isSameCharacterId(identity.id, identityId)) || getCurrentChatIdentity();
                    const groupOwnerId = char.ownerId || currentUser.id;
                    const isUserOwner = isSameCharacterId(groupOwnerId, currentUser.id);
                    const isUserAdmin = hasCharacterId(char.adminIds, currentUser.id);
                    const mentionKey = [
                        char.id,
                        (char.memberIds || []).join(','),
                        (char.groupNpcMembers || []).map(npc => npc?.id || npc?.name || '').join(','),
                        groupOwnerId,
                        (char.adminIds || []).join(','),
                        currentUser?.id || ''
                    ].join('|');
                    if (mentionPanelVisible && mentionPanelRenderedKey === mentionKey) return;
                    mentionPanelRenderedKey = mentionKey;
                    
                    if (mentionList) mentionList.innerHTML = '';
                    
                    // 创建精美列表项的函数
                    const createMentionItem = (name, avatar, roleTag) => {
                        const li = document.createElement('li');
                        li.style.cssText = 'display: flex; align-items: center; padding: 10px 16px; cursor: pointer; transition: background 0.2s; border-bottom: 1px solid #fdfdfd;';
                        
                        // 悬停交互变色
                        li.onmouseover = () => li.style.background = '#f5f5f5';
                        li.onmouseout = () => li.style.background = 'transparent';
                    
                        // 头像渲染 (针对全体成员使用橘色@图标)
                        let avatarHtml = '';
                        if (avatar === 'ALL') {
                            avatarHtml = `<div style="width: 36px; height: 36px; border-radius: 50%; background: #FFF3E0; display: flex; align-items: center; justify-content: center; margin-right: 12px; color: #FF9800; font-weight: 800; font-size: 18px; border: 1px solid #FFE0B2;">@</div>`;
                        } else {
                            avatarHtml = `<img src="${avatar || 'images/default-avatar.svg'}" loading="lazy" decoding="async" style="width: 36px; height: 36px; border-radius: 50%; object-fit: cover; margin-right: 12px; border: 1px solid #eee;">`;
                        }
                    
                        // 身份标签渲染
                        let tagHtml = '';
                        if (roleTag === '群主') {
                            tagHtml = `<span style="background: #FFF8D6; color: #D4A017; font-size: 10px; padding: 2px 6px; border-radius: 4px; margin-left: 8px; font-weight: 600;">群主</span>`;
                        } else if (roleTag === '管理员') {
                            tagHtml = `<span style="background: #E8F8F0; color: #5C9E7D; font-size: 10px; padding: 2px 6px; border-radius: 4px; margin-left: 8px; font-weight: 600;">管理员</span>`;
                        }
                    
                        li.innerHTML = `
                            ${avatarHtml}
                            <span style="font-size: 15px; color: #111; font-weight: 500;">${name}</span>
                            ${tagHtml}
                        `;
                    
                        // 【核心优化】阻止点击时的默认行为，防止苹果手机输入框失去焦点导致键盘收起
                        li.onpointerdown = (e) => {
                            e.preventDefault();
                        };

                        li.onclick = (e) => {
                            e.preventDefault(); // 阻断默认事件
                            chatInputField.value = val + name + ' '; // 补上名字和一个空格
                            if (mentionPanel) mentionPanel.style.display = 'none';
                            chatInputField.focus();
                        };
                        return li;
                    };

                    // 1. 如果有权限，最上面显示 @全体成员
                    if (isUserOwner || isUserAdmin) {
                        mentionList.appendChild(createMentionItem('全体成员', 'ALL', ''));
                    }

                    // 2. 遍历群内所有角色成员
                    const members = getGroupParticipants(char);
                    
                    // 对成员按身份排序：群主 -> 管理员 -> 普通群员
                    members.sort((a, b) => {
                        const scoreA = isSameCharacterId(a.id, groupOwnerId) ? 2 : (hasCharacterId(char.adminIds, a.id) ? 1 : 0);
                        const scoreB = isSameCharacterId(b.id, groupOwnerId) ? 2 : (hasCharacterId(char.adminIds, b.id) ? 1 : 0);
                        return scoreB - scoreA;
                    });

                    members.forEach(m => {
                        let roleTag = '';
                        if (isSameCharacterId(m.id, groupOwnerId)) roleTag = '群主';
                        else if (hasCharacterId(char.adminIds, m.id)) roleTag = '管理员';
                        
                        mentionList.appendChild(createMentionItem(m.name, m.avatar, roleTag));
                    });
                    if (mentionPanel) mentionPanel.style.display = 'block';
                } else {
                    mentionPanelRenderedKey = '';
                    // ▼▼▼ 修改开始：如果它本来就隐藏着，就别再强行给它设隐藏了，解决打字疯狂耗电 ▼▼▼
                if (mentionPanel && mentionPanel.style.display !== 'none') mentionPanel.style.display = 'none';
                }
                // ▲▲▲ 修改结束 ▲▲▲
            });
        });
        const startAutoTriggerCountdown = () => {
            if (autoTriggerTimer) {
                clearTimeout(autoTriggerTimer);
                autoTriggerTimer = null;
            }
            window.__autoTriggerTimer = null;
            window.__autoTriggerPaused = false;
            window.__autoTriggerArmed = false;
            window.__autoTriggerArmedChatId = null;
            const charForAutoTrigger = AppState.characterProfiles.find(
                c => c.id === tempState.currentChatId
            );
            if (!charForAutoTrigger || !charForAutoTrigger.autoSendEnabled) return;
            const scheduledChatId = tempState.currentChatId;
            const delayMs = (charForAutoTrigger.autoSendDelay || 5) * 1000;
            const chatPage = document.getElementById('page-chat-detail');
            if (chatPage && chatPage.style.display === 'none') {
                window.__autoTriggerPaused = true;
                window.__autoTriggerArmed = true;
                window.__autoTriggerArmedChatId = scheduledChatId;
                return;
            }
            autoTriggerTimer = setTimeout(() => {
                autoTriggerTimer = null;
                window.__autoTriggerTimer = null;
                if (!tempState.currentChatId) {
                    window.__autoTriggerArmed = false;
                    window.__autoTriggerArmedChatId = null;
                    return;
                }
                if (String(tempState.currentChatId) !== String(scheduledChatId)) {
                    window.__autoTriggerArmed = false;
                    window.__autoTriggerArmedChatId = null;
                    return;
                }
                if (isModeGenerating('online', tempState.currentChatId)) {
                    window.__autoTriggerArmed = false;
                    window.__autoTriggerArmedChatId = null;
                    return;
                }
                if (tempState.isMultiSelectMode) {
                    window.__autoTriggerArmed = false;
                    window.__autoTriggerArmedChatId = null;
                    return;
                }
                if (isChatInActiveCall(tempState.currentChatId)) {
                    window.__autoTriggerArmed = false;
                    window.__autoTriggerArmedChatId = null;
                    return;
                }
                const inputField = document.getElementById('chat-input-field');
                if (inputField && inputField.value.trim().length > 0) return;
                const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
                if (char && (char.isBlocked || char.isBlockedByAi)) {
                    window.__autoTriggerArmed = false;
                    window.__autoTriggerArmedChatId = null;
                    return;
                }
                window.__autoTriggerArmed = false;
                window.__autoTriggerArmedChatId = null;
                console.log('[自动触发] 用户停止发送消息已超时，自动触发 AI 回复');
                continueConversation();
            }, delayMs);
            window.__autoTriggerTimer = autoTriggerTimer;
            window.__autoTriggerArmed = true;
            window.__autoTriggerArmedChatId = scheduledChatId;
        };
        window.__autoTriggerCountdown = startAutoTriggerCountdown;
        window.__pauseAutoTriggerCountdown = () => {
            const hasPendingAutoTrigger = !!(window.__autoTriggerTimer || window.__autoTriggerArmed);
            window.__autoTriggerPaused = window.__autoTriggerPaused || hasPendingAutoTrigger;
            if (window.__autoTriggerTimer) {
                clearTimeout(window.__autoTriggerTimer);
                window.__autoTriggerTimer = null;
                autoTriggerTimer = null;
            }
        };
        window.__resumeAutoTriggerCountdown = () => {
            if (!window.__autoTriggerPaused) return;
            const chatPage = document.getElementById('page-chat-detail');
            if (chatPage && chatPage.style.display === 'none') return;
            window.__autoTriggerPaused = false;
            startAutoTriggerCountdown();
        };
        if (!window.__autoTriggerPageListenerBound) {
            window.__autoTriggerPausedByLifePage = false;
            window.addEventListener('looky:page-opened', (event) => {
                const pageId = event?.detail?.pageId;
                if (pageId === 'page-life') {
                    window.__autoTriggerPausedByLifePage = !!(window.__autoTriggerTimer || window.__autoTriggerArmed || window.__autoTriggerPaused);
                    if (window.__autoTriggerPausedByLifePage) window.__pauseAutoTriggerCountdown?.();
                    return;
                }
                if (pageId === 'page-chat-detail' && (window.__autoTriggerPausedByLifePage || window.__autoTriggerPaused)) {
                    window.__autoTriggerPausedByLifePage = false;
                    window.__resumeAutoTriggerCountdown?.();
                }
            });
            window.__autoTriggerPageListenerBound = true;
        }
        const sendMessageToScreen = async () => {

           if (isSendingMessageToScreen) return;
           if (tempState.isRenderingHistory) {
                console.warn('[系统恢复] 检测到渲染锁异常残留，正在强制重置以允许发送消息。');
                tempState.isRenderingHistory = false;
            }
            const messageText = chatInputField.value.trim();
            if (!messageText || !tempState.currentChatId) return;
            if (isChatInActiveCall(tempState.currentChatId)) {
                showDynamicIsland('通话中的角色不能继续在线聊天', 'warning');
                return;
            }

            // ▼▼▼ 新增：群聊禁言拦截系统 (文本版) ▼▼▼
            const chatChar = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            if (chatChar && chatChar.isGroup) {
                const checkUser = getCurrentChatIdentity();
                const groupOwnerId = chatChar.ownerId || checkUser.id;
                const isOwner = isSameCharacterId(groupOwnerId, checkUser.id);
                const isAdmin = hasCharacterId(chatChar.adminIds, checkUser.id);
                
                if (chatChar.isMuteAll && !isOwner && !isAdmin) {
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('全体禁言中，仅群主和管理员可发言', 'warning');
                    return; // 截断发送
                }
                if (chatChar.mutedMembers && chatChar.mutedMembers[checkUser.id]) {
                    const exp = chatChar.mutedMembers[checkUser.id];
                    if (exp === -1 || exp > Date.now()) {
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('您已被禁言，请向群管理员求饶解除', 'warning');
                        return; // 截断发送
                    }
                }
            }
            // ▲▲▲ 拦截系统结束 ▲▲▲
            isSendingMessageToScreen = true;
            const inputValueBeforeSend = chatInputField.value;
            chatInputField.value = '';
            chatInputField.dispatchEvent(new Event('input', { bubbles: true }));

            let messagePersisted = false;
            try {
            const currentUser = getCurrentChatIdentity();
            if (tempState.currentChatId) {
                const chatCharForFollowUp = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
                if (chatCharForFollowUp?.followUpPlan) {
                    await clearFollowUpPlan(chatCharForFollowUp.id);
                }
            }
            const messageToSave = {
                chatId: tempState.currentChatId,
                timestamp: new Date(),
                text: messageText,
                type: 'sent',
                avatarSrc: currentUser.avatar,
                recalled: false,
                replyToMessageId: tempState.replyingToId || null,
                isRejected: chatChar && chatChar.isBlockedByAi ? true : false, // 新增：如果被AI拉黑，打上拒收标记
            };
        if (isChatInActiveCall(tempState.currentChatId)) {
            messageToSave.callId = tempState.currentCallId;
        }

        const messageId = await db.chatMessages.add(messageToSave);
        messagePersisted = true;
        const newMessage = await db.chatMessages.get(messageId);
        await createAndAppendMessage(newMessage);
        playUserSendSound(chatChar);

        cancelReplyMode();
        startAutoTriggerCountdown();
            } catch (error) {
                if (!messagePersisted && !chatInputField.value) {
                    chatInputField.value = inputValueBeforeSend;
                    chatInputField.dispatchEvent(new Event('input', { bubbles: true }));
                }
                console.error('[消息发送到屏幕失败]', error);
                showDynamicIsland(
                    messagePersisted ? '消息已发送，但页面显示稍慢' : '消息发送失败，请重试',
                    'warning'
                );
            } finally {
                isSendingMessageToScreen = false;
            }
    };
        if (sendToScreenBtn) addTapListener(sendToScreenBtn, sendMessageToScreen);
             // 替换为加强版：
        chatInputField.addEventListener('keydown', (event) => {
            // 兼容部分安卓输入法按 Enter 的情况
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault(); // 阻止搜索框默认的提交行为
                if (chatInputField.value.trim().length > 0) {
                    sendMessageToScreen();
                    // 发送后强制让输入框失去焦点再获得焦点，防止键盘卡死（针对Via的优化）
                    // chatInputField.blur(); 
                    // setTimeout(() => chatInputField.focus(), 10);
                }
            }
        });
        
        // 【新增】监听 search 事件（针对 type="search" 的原生键盘发送键）
        chatInputField.addEventListener('search', (event) => {
             event.preventDefault();
             if (chatInputField.value.trim().length > 0) sendMessageToScreen();
        });

        chatInputField.addEventListener('blur', () => {
            if (inputRafId) {
                cancelAnimationFrame(inputRafId);
                inputRafId = null;
            }
            requestAnimationFrame(() => {
                const mentionPanel = document.getElementById('chat-mention-panel');
                if (mentionPanel && mentionPanel.style.display !== 'none') mentionPanel.style.display = 'none';
                mentionPanelRenderedKey = '';
            });
        });

        if (sendMessageBtn) addTapListener(sendMessageBtn, continueConversation);

    }
// js/features/chat-ui.js -> initChatInterface()
    // ▼▼▼ 用这个新的、整合了播放功能的 click 监听器，替换掉你原来的那一个 ▼▼▼
    chatMessageList.addEventListener('click', async (e) => {
        // ▼▼▼ 新增：拉黑状态下拦截语音播放与图片点击 ▼▼▼
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (char && char.isBlocked) {
            if (typeof showDynamicIsland === 'function') showDynamicIsland('已拉黑该联系人', 'warning');
            return;
        }
        // ▲▲▲ 新增结束 ▲▲▲
        if (tempState.isMultiSelectMode) {
            // 懒加载消息尚未替换成真实气泡时，点击占位块也要能加入多选。
            const placeholder = e.target.closest('.message-placeholder[data-message-id]');
            if (placeholder && chatMessageList.contains(placeholder)) {
                smartClickHandler(placeholder, { id: Number(placeholder.dataset.messageId) });
            }
            return;
        }
        const imageGenButton = e.target.closest('[data-image-gen-action]');
        if (imageGenButton) {
            const messageWrapper = imageGenButton.closest('[data-message-id]');
            const messageId = Number(messageWrapper?.dataset.messageId);
            if (!messageId) return;
            e.stopPropagation();
            if (imageGenButton.dataset.imageGenAction === 'retry') {
                await retryAiImageGeneration(messageId);
            } else if (imageGenButton.dataset.imageGenAction === 'stop') {
                await stopAiImageGeneration(messageId);
            }
            return;
        }
        const voiceBubble = e.target.closest('.message-bubble.is-voice-message');
        
        if (voiceBubble) {
            const messageWrapper = voiceBubble.closest('.message-wrapper');
            if (!messageWrapper) return;

            // 1. 实现点击展开/收起文字（这是你原有的核心功能，必须保留）
            messageWrapper.classList.toggle('voice-expanded');
            
            // 2. [新增] 如果是展开文字，并且是AI发来的消息，就触发播放
            if (messageWrapper.classList.contains('voice-expanded') && messageWrapper.classList.contains('received')) {
                // 检查是否正在播放，防止重复点击
                if (messageWrapper.classList.contains('is-playing')) {
                    console.log('TTS is already playing for this message.');
                    return;
                }

                // 获取消息数据
                const messageId = Number(messageWrapper.dataset.messageId);
                const messageData = AppState.currentChatHistory.find(m => m.id === messageId);
                
                if (messageData && messageData.text) {
                    console.log(`[TTS] User clicked to play voice message: "${messageData.text}"`);
                    
                    // 添加播放状态的视觉效果
                    messageWrapper.classList.add('is-playing');
                     const targetSpeakerId = messageData.speakerId || tempState.currentChatId; // 直接读取身份，极速且精准
                    
                    // 调用 TTS 服务，并等待播放完成
                    TTSService.speakForCharacter(messageData.text, targetSpeakerId, { emotion: messageData.ttsEmotion })
                        .finally(() => {
                            // 无论播放成功或失败，最后都移除播放状态
                            messageWrapper.classList.remove('is-playing');
                        });
                }
            }
            
            // 语音气泡的逻辑到此结束，阻止事件冒泡以防触发其他逻辑
            e.stopPropagation();
            return;
        }
        
        const imageBubble = e.target.closest('.gallery-image-bubble');
        if (imageBubble && !e.target.closest('.message-reply-preview')) {
            const messageWrapper = imageBubble.closest('[data-message-id]');
            const messageId = Number(messageWrapper?.dataset.messageId);
            const messageData = AppState.currentChatHistory.find(m => Number(m.id) === messageId) || await db.chatMessages.get(messageId);
            if (messageData) showChatImageViewer(messageData);
            e.stopPropagation();
            return;
        }

        // 其他卡片的点击逻辑（保持不变）
        const clickableCard = e.target.closest('.photo-card');
        if (clickableCard && !e.target.closest('.message-reply-preview')) {
            clickableCard.classList.toggle('expanded');
        }
    });
    // ▲▲▲ 替换结束 ▲▲▲


    document.getElementById('cancel-reply-btn')?.addEventListener('click', cancelReplyMode);

    chatMessageList.addEventListener('contextmenu', (e) => {
        if (e.target.tagName === 'IMG' && e.target.closest('.message-bubble')) {
            e.preventDefault();
        }
    });
    const chatGridBtn = document.querySelector('.chat-grid-btn');
    const functionPanel = document.getElementById('chat-function-panel');
    const groupFunctionPanel = document.getElementById('group-chat-function-panel'); // 新增群聊面板
    const stickerPickerPanelForFunctionMenu = document.getElementById('sticker-picker-panel');
    const groupThoughtsBtn = document.getElementById('group-thoughts-history-btn');
    const albumImageUpload = document.getElementById('album-image-upload');
    const shootingModal = document.getElementById('shooting-modal-overlay');

    if (chatGridBtn && functionPanel && groupFunctionPanel) {
        let functionPanelClickSuppressedUntil = 0;
        const showFunctionPanelPage = (panel, activeIndex = 0) => {
            const pages = Array.from(panel.querySelectorAll('.function-grid.is-paged .function-page'));
            const dots = Array.from(panel.querySelectorAll('.function-page-dot'));
            if (pages.length === 0) return;
            const safeIndex = Math.max(0, Math.min(pages.length - 1, activeIndex));
            panel.dataset.functionPageIndex = String(safeIndex);
            pages.forEach((page, index) => page.classList.toggle('active', index === safeIndex));
            dots.forEach((dot, index) => dot.classList.toggle('active', index === safeIndex));
        };
        const syncFunctionPanelPageHeight = (panel) => {
            const grid = panel.querySelector('.function-grid.is-paged');
            const activePage = panel.querySelector('.function-grid.is-paged .function-page.active');
            if (!grid || !activePage) return;
            const height = Math.ceil(activePage.getBoundingClientRect().height);
            if (height > 0) {
                grid.style.setProperty('--function-panel-page-height', `${height}px`);
            }
        };
        const bindFunctionPanelDots = (panel) => {
            const grid = panel.querySelector('.function-grid.is-paged');
            const pages = Array.from(panel.querySelectorAll('.function-grid.is-paged .function-page'));
            const dots = Array.from(panel.querySelectorAll('.function-page-dot'));
            if (!grid || pages.length === 0 || dots.length === 0) return;
            showFunctionPanelPage(panel, 0);
            syncFunctionPanelPageHeight(panel);
            dots.forEach((dot, index) => {
                dot.addEventListener('click', () => {
                    showFunctionPanelPage(panel, index);
                    requestAnimationFrame(() => syncFunctionPanelPageHeight(panel));
                });
            });
            let startX = 0;
            let startY = 0;
            grid.addEventListener('touchstart', (event) => {
                const touch = event.changedTouches[0];
                if (!touch) return;
                startX = touch.clientX;
                startY = touch.clientY;
            }, { passive: true });
            grid.addEventListener('touchend', (event) => {
                const touch = event.changedTouches[0];
                if (!touch) return;
                const endX = touch.clientX;
                const endY = touch.clientY;
                const diffX = endX - startX;
                const diffY = endY - startY;
                if (Math.abs(diffX) < 45 || Math.abs(diffX) < Math.abs(diffY) * 1.2) return;
                const currentIndex = Number(panel.dataset.functionPageIndex || 0);
                const nextIndex = currentIndex + (diffX < 0 ? 1 : -1);
                showFunctionPanelPage(panel, nextIndex);
                requestAnimationFrame(() => syncFunctionPanelPageHeight(panel));
                functionPanelClickSuppressedUntil = Date.now() + 180;
            }, { passive: true });
        };
        bindFunctionPanelDots(functionPanel);
        bindFunctionPanelDots(groupFunctionPanel);
        const resetFunctionPanelPage = (panel) => {
            showFunctionPanelPage(panel, 0);
        };
        const setPanelHidden = (panel, shouldHide) => {
            if (panel.classList.contains('hidden') !== shouldHide) {
                panel.classList.toggle('hidden', shouldHide);
            }
        };
        const hideFunctionPanel = () => {
            setPanelHidden(functionPanel, true);
            setPanelHidden(groupFunctionPanel, true);
        };
        addTapListener(chatGridBtn, (e) => {
            e.stopPropagation();
            if (stickerPickerPanelForFunctionMenu && !stickerPickerPanelForFunctionMenu.classList.contains('hidden')) {
                stickerPickerPanelForFunctionMenu.classList.add('hidden');
            }
            // 判断当前对话是否为群聊，弹出不同的面板
            const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            const isGroupChat = Boolean(char && char.isGroup);
            const targetPanel = isGroupChat ? groupFunctionPanel : functionPanel;
            const shouldShowTargetPanel = targetPanel.classList.contains('hidden');

            setPanelHidden(functionPanel, true);
            setPanelHidden(groupFunctionPanel, true);
            if (shouldShowTargetPanel) {
                resetFunctionPanelPage(targetPanel);
                setPanelHidden(targetPanel, false);
                requestAnimationFrame(() => {
                    resetFunctionPanelPage(targetPanel);
                    syncFunctionPanelPageHeight(targetPanel);
                });
            }

            if (isGroupChat && groupThoughtsBtn && groupThoughtsBtn.style.display !== 'none') {
                groupThoughtsBtn.style.display = 'none';
            }

        });
        
        // 共用的面板内功能点击逻辑
        const handleFunctionItemClick = async (e) => {
            if (Date.now() < functionPanelClickSuppressedUntil) return;
            const item = e.target.closest('.function-item');
            if (!item) return;
            // 过滤掉 'group-' 前缀，让群聊面板和单聊面板共享同一套逻辑功能
            const actionId = item.id.replace('group-', ''); 
            
            if (actionId === 'album-btn') {
                window.__pauseAutoTriggerCountdown?.();
                window.addEventListener('focus', () => window.__resumeAutoTriggerCountdown?.(), { once: true });
                albumImageUpload.click();
            }
            else if (actionId === 'shooting-btn') {
                shootingModal.classList.add('visible');
                window.__pauseAutoTriggerCountdown?.();
            }
            else if (actionId === 'regenerate-response-btn') {
                regenerateLastResponse();
            }
            else if (actionId === 'vector-match-btn') {
                showVectorMatchHistoryModal();
            }
            else if (actionId === 'image-gen-settings-btn') {
                const currentChar = AppState.characterProfiles.find(c => String(c.id) === String(tempState.currentChatId));
                if (!currentChar || currentChar.isGroup) {
                    showDynamicIsland('群聊不保存单人锁脸，请到相册选择具体角色设置');
                    hideFunctionPanel();
                    return;
                }
                await openCharacterImageGenSettingsModal({ charId: tempState.currentChatId });
            }
         else if (actionId === 'diary-btn') {
                Diary.show(); 
            }
              else if (actionId === 'life-btn') {
                showPage('page-life');
            }
            else if (item.id === 'thoughts-history-btn') {
                showThoughtsHistoryModal();
            }
            // ▼▼▼ 新增：拦截日程按钮点击 ▼▼▼
            else if (actionId === 'schedule-btn') {
                showChatScheduleModal();
            }
            // ▲▲▲ 新增结束 ▲▲▲
            else if (actionId === 'fake-chat-btn') {
                openFakeChatRecordModal();
            }
            else if (actionId === 'member-chat-btn') {
                await generateGroupMemberConversation();
            }
            else if (actionId === 'plot-push-btn') {
                openPlotPushModal();
            }
            else if (actionId === 'ooc-nudge-btn') {
                openOocNudgeModal();
            }
            else if (actionId === 'transfer-btn') {
                // 转账按钮已经在 transfer.js 绑定，这里不再兜底重复点击
            }
            else if (actionId === 'red-packet-btn') {
                // 打开红包弹窗
                const rpModal = document.getElementById('red-packet-modal-overlay');
                if (rpModal) {
                    document.getElementById('rp-amount').value = '';
                    document.getElementById('rp-count').value = '';
                    document.getElementById('rp-total-amount-display').textContent = '0.00';
                    
                    // 获取当前群聊人数
                    const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
                          if (char && char.isGroup) {
                        const memberCount = (char.memberIds || []).length + 1; // 加上自己
                        document.getElementById('rp-group-member-count').textContent = memberCount;
                    }
                    rpModal.classList.add('visible'); // 修改这里：统一下发 visible 类名
                }
            }

                else if (item.id === 'offline-mode-btn') {
                const charId = tempState.currentChatId;
                if (!charId) return;
if (tempState.hybridModeTurnCounters && tempState.hybridModeTurnCounters[charId]) {
                    delete tempState.hybridModeTurnCounters[charId];
                    // 并且，立即保存这个清零后的状态
                    const { saveHybridStateToSession } = await import('../state.js');
                    saveHybridStateToSession();
                    console.log(`[混合模式] 用户返回线下，轮次计数器已为角色 ${charId} 清零。`);
                }
                const titleElement = document.getElementById('offline-mode-title');
                               // 【核心】更新页面标题
                if (titleElement) {
                    const character = AppState.characterProfiles.find(c => c.id === charId);
                    if (character) {
                        // 【修正】优先显示备注名(chatOverrideName)，没有才显示真名
                        titleElement.textContent = character.chatOverrideName || character.name;
                    } else {
                        titleElement.textContent = '线下见面'; // Fallback
                    }
                }
                showPage('page-offline-mode');
                // 可以在这里触发加载历史记录的事件
                document.dispatchEvent(new CustomEvent('loadOfflineHistory', { detail: { chatId: tempState.currentChatId } }));
            }
            // ▼▼▼ 修复群聊位置和语音等按钮点击没反应的问题 ▼▼▼
            else {
                // 找不到特定处理时，尝试直接点击原版的单聊按钮
                const originalBtn = document.getElementById(actionId);
                if (originalBtn && originalBtn !== item) {
                    originalBtn.click();
                }
            }
            // ▲▲▲ 修复结束 ▲▲▲
            hideFunctionPanel();
        };
        
        // 分别给单聊和群聊的面板绑定同样的事件逻辑

        functionPanel.addEventListener('click', handleFunctionItemClick);
        groupFunctionPanel.addEventListener('click', handleFunctionItemClick);
        
        document.addEventListener('click', (e) => {
            if (!functionPanel.classList.contains('hidden') && !functionPanel.contains(e.target) && !chatGridBtn.contains(e.target)) {
                hideFunctionPanel();
            }
            if (!groupFunctionPanel.classList.contains('hidden') && !groupFunctionPanel.contains(e.target) && !chatGridBtn.contains(e.target)) {
                hideFunctionPanel();
            }
        });
    }


    const plotPushModal = document.getElementById('plot-push-modal-overlay');
    document.getElementById('send-plot-push-btn')?.addEventListener('click', submitPlotPush);
    document.getElementById('cancel-plot-push-btn')?.addEventListener('click', closePlotPushModal);
    plotPushModal?.addEventListener('click', (e) => { if (e.target === plotPushModal) closePlotPushModal(); });

    const oocNudgeModal = document.getElementById('ooc-nudge-modal-overlay');
    document.getElementById('ooc-built-in-btn')?.addEventListener('click', async () => {
        closeOocNudgeModal();
        await applyOocNudge(OOC_STABILIZE_INSTRUCTION, '已完成感化');
    });
    document.getElementById('ooc-custom-open-btn')?.addEventListener('click', () => {
        const customArea = document.getElementById('ooc-custom-area');
        const textarea = document.getElementById('ooc-custom-textarea');
        if (customArea) customArea.hidden = false;
        requestAnimationFrame(() => textarea?.focus());
    });
    document.getElementById('send-ooc-custom-btn')?.addEventListener('click', async () => {
        const textarea = document.getElementById('ooc-custom-textarea');
        const text = textarea?.value.trim();
        if (!text) {
            showDynamicIsland('请先填写肘击内容');
            return;
        }
        closeOocNudgeModal();
        await applyOocNudge(text, '肘击已发送');
    });
    document.getElementById('cancel-ooc-nudge-btn')?.addEventListener('click', closeOocNudgeModal);
    oocNudgeModal?.addEventListener('click', (e) => { if (e.target === oocNudgeModal) closeOocNudgeModal(); });

    const shootingTextarea = document.getElementById('shooting-description-textarea');
    const hideShootingModal = () => {
        shootingModal.classList.remove('visible');
        shootingTextarea.value = '';
        window.__resumeAutoTriggerCountdown?.();
    };
    document.getElementById('send-shooting-btn').addEventListener('click', async () => {
        const description = shootingTextarea.value.trim();
        if (!description) { showDynamicIsland('请先描述照片内容'); return; }
        if (isChatInActiveCall(tempState.currentChatId)) {
            showDynamicIsland('通话中的角色不能继续在线操作', 'warning');
            return;
        }
        const chatChar = AppState.characterProfiles.find(c => c.id === tempState.currentChatId); // ← 加这一行
        const shootingMessage = {
            chatId: tempState.currentChatId,
            timestamp: new Date(),
            text: `[拍摄] ${description}`,
            type: 'sent',
            avatarSrc: getCurrentChatIdentity().avatar,
            recalled: false,
            replyToMessageId: tempState.replyingToId || null,
            isRejected: chatChar && chatChar.isBlockedByAi ? true : false, // ← 加这一行
        };
         if (isChatInActiveCall(tempState.currentChatId)) {
            shootingMessage.callId = tempState.currentCallId;
        }

        const messageId = await db.chatMessages.add(shootingMessage);
        const newMessage = await db.chatMessages.get(messageId);
        await createAndAppendMessage(newMessage);
        playUserSendSound(chatChar);
        
        hideShootingModal();
        cancelReplyMode();
        if (window.__autoTriggerCountdown) window.__autoTriggerCountdown();
    });
    document.getElementById('cancel-shooting-btn').addEventListener('click', hideShootingModal);
    shootingModal.addEventListener('click', (e) => { if (e.target === shootingModal) hideShootingModal(); });
    albumImageUpload.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (isChatInActiveCall(tempState.currentChatId)) {
            showDynamicIsland('通话中的角色不能继续在线操作', 'warning');
            e.target.value = '';
            return;
        }

        // ▼▼▼ 新增：群聊禁言拦截系统 (相册版) ▼▼▼
        const chatChar = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (chatChar && chatChar.isGroup) {
            const checkUser = getCurrentChatIdentity();
            const groupOwnerId = chatChar.ownerId || checkUser.id;
            const isOwner = isSameCharacterId(groupOwnerId, checkUser.id);
            const isAdmin = hasCharacterId(chatChar.adminIds, checkUser.id);
            
            if (chatChar.isMuteAll && !isOwner && !isAdmin) {
                if (typeof showDynamicIsland === 'function') showDynamicIsland('全体禁言中，无法发送图片', 'warning');
                e.target.value = ''; // 清空选择的文件
                return; // 截断发送
            }
            if (chatChar.mutedMembers && chatChar.mutedMembers[checkUser.id]) {
                const exp = chatChar.mutedMembers[checkUser.id];
                if (exp === -1 || exp > Date.now()) {
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('您已被禁言，无法发送图片', 'warning');
                    e.target.value = ''; // 清空选择的文件
                    return; // 截断发送
                }
            }
        }
        // ▲▲▲ 拦截系统结束 ▲▲▲

        const reader = new FileReader();

        reader.onload = (event) => {
            // 【优化】发送图片前进行压缩
            const img = new Image();
            img.onload = async () => {
                const canvas = document.createElement('canvas');
                const MAX_WIDTH = 1024; // 聊天图片可以稍微大一点
                let width = img.width;
                let height = img.height;
                if (width > MAX_WIDTH) {
                    height *= MAX_WIDTH / width;
                    width = MAX_WIDTH;
                }
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.6); // 压缩
                const imageMessage = {
                    chatId: tempState.currentChatId,
                    timestamp: new Date(),
                    text: '[图片]',
                    type: 'sent',
                    avatarSrc: getCurrentChatIdentity().avatar,
                    stickerUrl: compressedDataUrl, // 这里使用压缩后的数据
                    recalled: false,
                    replyToMessageId: tempState.replyingToId || null,
                    isRejected: chatChar && chatChar.isBlockedByAi ? true : false, // 新增：如果被AI拉黑，打上拒收标记
                };
                if (isChatInActiveCall(tempState.currentChatId)) {
                    imageMessage.callId = tempState.currentCallId;
                }
                const messageId = await db.chatMessages.add(imageMessage);
                const newMessage = await db.chatMessages.get(messageId);
                await createAndAppendMessage(newMessage);
                playUserSendSound(chatChar);
                cancelReplyMode();
                if (window.__autoTriggerCountdown) window.__autoTriggerCountdown();
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    });

    const locationModal = document.getElementById('location-modal-overlay');
    const locationNameInput = document.getElementById('location-name-input');
    let currentMapUrlForSending = '';
   // ▼▼▼ 【高级重制版】发红包弹窗逻辑绑定 ▼▼▼
    const rpModal = document.getElementById('red-packet-modal-overlay');
    if (rpModal) {
        const closeRpBtn = document.getElementById('close-red-packet-btn');
        const sendRpBtn = document.getElementById('send-red-packet-btn');
        const amtInput = document.getElementById('rp-amount');
        const countInput = document.getElementById('rp-count');
        const totalDisplay = document.getElementById('rp-total-amount-display');
            const amountLabel = document.getElementById('rp-amount-label');
        const typeBtns = document.querySelectorAll('.rp-type-btn'); // 改为获取按钮
        const closeRpModal = () => {
            rpModal.classList.remove('visible'); // 修改这里：统一移除 visible 类名
        };
        closeRpBtn.addEventListener('click', closeRpModal);
        rpModal.addEventListener('click', (e) => { if (e.target === rpModal) closeRpModal(); });

        // 获取当前选中的红包类型 (random/normal)
        const getSelectedType = () => {
            const activeBtn = document.querySelector('.rp-type-btn.active');
            return activeBtn ? activeBtn.dataset.type : 'random';
        };
        // 计算总金额的核心函数
        const updateTotalAmount = () => {
            const val = parseFloat(amtInput.value) || 0;
            const count = parseInt(countInput.value) || 0;
            const type = getSelectedType();
            
            let total = 0;
            if (type === 'random') {
                total = val; // 拼手气，输入的就是总金额
            } else {
                total = val * count; // 普通红包，输入的是单个金额
            }
            totalDisplay.textContent = total.toFixed(2);
        };
        // 监听输入
        amtInput.addEventListener('input', updateTotalAmount);
        countInput.addEventListener('input', updateTotalAmount);
        // 监听胶囊按钮的切换
        typeBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                // 如果点的是已经激活的，就不管
                if (btn.classList.contains('active')) return;
                // 移除其他按钮的 active
                typeBtns.forEach(b => b.classList.remove('active'));
                // 激活当前点击的
                btn.classList.add('active');
                const newType = btn.dataset.type;
                
                // 每次切换时清空一下输入，防止混淆
                amtInput.value = '';
                
                if (newType === 'random') {
                    amountLabel.textContent = '总金额';
                } else {
                    amountLabel.textContent = '单个金额';
                }
                updateTotalAmount();
            });
        });
        // 确认发送红包
        sendRpBtn.addEventListener('click', async () => {
            const amountInputVal = parseFloat(amtInput.value);
            const count = parseInt(countInput.value);
            const greeting = document.getElementById('rp-greeting').value || '恭喜发财，大吉大利';
            const type = getSelectedType();
            const cover = document.getElementById('rp-cover').value;
            if (!amountInputVal || amountInputVal <= 0) { showDynamicIsland('请输入有效金额', 'warning'); return; }
            if (!count || count <= 0) { showDynamicIsland('请输入有效个数', 'warning'); return; }
            // 计算要扣除/显示的真实总金额
            const finalTotalAmount = type === 'random' ? amountInputVal : (amountInputVal * count);
            const payment = await requestLookyPayment({
                amount: finalTotalAmount,
                title: '发红包',
                scene: 'transfer'
            });
            if (!payment) return;
            const chatChar = AppState.characterProfiles.find(c => c.id === tempState.currentChatId); // ← 加这一行
            const rpMessage = {
                chatId: tempState.currentChatId,
                timestamp: new Date(),
                text: '[群红包]',
                type: 'sent',
                contentType: 'red_packet',
                content: {
                    amount: finalTotalAmount, // 保存计算后的总金额
                    singleAmount: type === 'normal' ? amountInputVal : null, // 如果是普通红包，存一下单价
                    count, 
                    greeting, 
                    type, 
                    cover, 
                    status: 'pending'
                },
                avatarSrc: getCurrentChatIdentity().avatar,
                recalled: false,
                replyToMessageId: tempState.replyingToId || null,
                isRejected: chatChar && chatChar.isBlockedByAi ? true : false, // ← 加这一行
            };
            const messageId = await db.chatMessages.add(rpMessage);
            const newMessage = await db.chatMessages.get(messageId);
            await createAndAppendMessage(newMessage);
            playUserSendSound(chatChar);
            await recordLookyLedger({
                source: 'red_packet_send',
                sourceId: messageId,
                type: 'expense',
                amount: finalTotalAmount,
                category: '转账',
                title: '发红包',
                memo: greeting,
                char: tempState.currentChatId,
                paymentMethod: payment.displayName || '',
                paymentCardId: payment.paymentCardId || (payment.type === 'card' ? payment.id : 'balance'),
                timestamp: Date.now(),
                isAuto: true
            });
            
            closeRpModal();
            cancelReplyMode();
        });
    }
    // ▼▼▼ 修改：绑定地图预设后的位置弹窗联动逻辑 ▼▼▼
    const locBtnNode = document.getElementById('location-btn-panel');
    if (locBtnNode) locBtnNode.onclick = () => {
        currentMapUrlForSending = LOCATION_MAP_IMAGES[Math.floor(Math.random() * LOCATION_MAP_IMAGES.length)];
        document.getElementById('location-map-image').src = currentMapUrlForSending;
        locationNameInput.value = '';
        
        // 新增：提取该角色的绑定的地图预设
        const charId = tempState.currentChatId;
        const boundPack = localStorage.getItem('ls_bound_map_' + charId);
        const locSelect = document.getElementById('location-bound-select');
        const extraFields = document.getElementById('location-extra-fields');
        
        if (extraFields) extraFields.style.display = 'none'; // 重置隐藏
        
        if (boundPack && locSelect) {
            const packs = JSON.parse(localStorage.getItem('looky_map_packs') || '{}');
            const mapData = packs[boundPack] || [];
            locSelect.innerHTML = '<option value="">-- 从绑定的地图中选择 --</option>';
            
            // 动态抓取当前地图的所有大区域
            const parentSelect = document.getElementById('loc-extra-parent');
            if (parentSelect) parentSelect.innerHTML = '<option value="">所属区域: 无</option>';

            mapData.forEach(loc => {
                const opt = document.createElement('option');
                opt.value = loc.name;
                opt.textContent = `${loc.name} (${loc.type})`;
                locSelect.appendChild(opt);

                // 只有设置了半径的地点才算区域，填入所属区域下拉框
                if (parentSelect && parseInt(loc.radius || 0) > 0) {
                    const pOpt = document.createElement('option');
                    pOpt.value = loc.name;
                    pOpt.textContent = `所属区域: ${loc.name}`;
                    parentSelect.appendChild(pOpt);
                }
            });
            locSelect.style.display = 'block';
            
            // 监听下拉框改变，自动填入输入框
            locSelect.onchange = (e) => {
                if (e.target.value) {
                    locationNameInput.value = e.target.value;
                    if (extraFields) extraFields.style.display = 'none'; // 如果选了已有的，就隐藏补充表单
                }
            };

            // 联动：选中区域后，自动继承该区域的人流交通等环境信息
            if (parentSelect) {
                parentSelect.onchange = (e) => {
                    const isInherit = e.target.value !== '';
                    ['loc-extra-scale', 'loc-extra-traffic', 'loc-extra-crowd', 'loc-extra-dist'].forEach(id => {
                        const el = document.getElementById(id);
                        if(el) {
                            el.disabled = isInherit;
                            if(isInherit) {
                                const pObj = mapData.find(l => l.name === e.target.value);
                                if(pObj) {
                                    if (id.includes('scale')) el.value = pObj.scale || '中型';
                                    if (id.includes('traffic')) el.value = pObj.traffic || '便利';
                                    if (id.includes('crowd')) el.value = pObj.crowd || '适中';
                                }
                            }
                        }
                    });
                };
            }

        } else if (locSelect) {
            locSelect.style.display = 'none';
        }
        locationModal.classList.add('visible');
        window.__pauseAutoTriggerCountdown?.();
        locationNameInput.focus();
    }

    // 【性能修复核心】改用 .onclick，强制覆盖旧的监听器，彻底解决多次打开聊天框累积事件导致的致命卡顿！
    document.getElementById('send-location-btn').onclick = async () => {
        const locationName = locationNameInput.value.trim();
        if (!locationName) { showDynamicIsland('请输入地点名称', 'warning'); return; }
        if (isChatInActiveCall(tempState.currentChatId)) {
            showDynamicIsland('通话中的角色不能继续在线操作', 'warning');
            return;
        }
        const charId = tempState.currentChatId;
        const boundPack = localStorage.getItem('ls_bound_map_' + charId);
        
        // 新增：如果是自定义地点且绑定了地图，执行补充信息入库逻辑
        if (boundPack) {
            const packs = JSON.parse(localStorage.getItem('looky_map_packs') || '{}');
            const mapData = packs[boundPack] || [];
            const exists = mapData.find(l => l.name === locationName);
            const extraFields = document.getElementById('location-extra-fields');
            
            if (!exists) {
                // 如果地点不存在，且表单没显示，拦截发送并弹出表单
                if (extraFields && extraFields.style.display === 'none') {
                    extraFields.style.display = 'block';
                    showDynamicIsland('发现新地点，请补充信息同步至地图', 'warning');
                    return; 
                }
                // 表单已经显示，收集信息入库
                if (extraFields && extraFields.style.display === 'block') {
                    const newLoc = {
                        name: locationName,
                        type: document.getElementById('loc-extra-type').value || '娱乐',
                        target: document.getElementById('loc-extra-target').value || 'none',
                        rel: document.getElementById('loc-extra-rel').value || 'none',
                        dist: parseInt(document.getElementById('loc-extra-dist').value) || 15,
                        // ▼▼▼ 修改：抓取新增的环境与区域字段 ▼▼▼
                        parent: document.getElementById('loc-extra-parent')?.value || "", 
                        radius: 0, 
                        scale: document.getElementById('loc-extra-scale')?.value || "中型", 
                        traffic: document.getElementById('loc-extra-traffic')?.value || "便利", 
                        crowd: document.getElementById('loc-extra-crowd')?.value || "适中",
                        // ▲▲▲ 修改结束 ▲▲▲
                        top: Math.floor(Math.random() * 60 + 20) + '%', 
                        left: Math.floor(Math.random() * 70 + 15) + '%'
                    };
                    mapData.push(newLoc);
                    packs[boundPack] = mapData;
                    localStorage.setItem('looky_map_packs', JSON.stringify(packs));
                    showDynamicIsland('地点已自动同步至世界地图', 'success');
                }
            }
        }
        const chatChar = AppState.characterProfiles.find(c => c.id === tempState.currentChatId); // ← 加这一行
        const locationMessage = {
            chatId: tempState.currentChatId,
            timestamp: new Date(),
            text: `[位置] ${locationName}`,
            type: 'sent',
            contentType: 'location',
            locationName: locationName,
            mapImageUrl: currentMapUrlForSending,
            avatarSrc: getCurrentChatIdentity().avatar,
            recalled: false,
            replyToMessageId: tempState.replyingToId || null,
            isRejected: chatChar && chatChar.isBlockedByAi ? true : false, // ← 加这一行
        };
        if (isChatInActiveCall(tempState.currentChatId)) {
            locationMessage.callId = tempState.currentCallId;
        }
        const messageId = await db.chatMessages.add(locationMessage);
        const newMessage = await db.chatMessages.get(messageId);
        await createAndAppendMessage(newMessage);
        playUserSendSound(chatChar);
        locationModal.classList.remove('visible');
        cancelReplyMode();
        if (window.__autoTriggerCountdown) window.__autoTriggerCountdown();
    }
    // ▲▲▲ 联动逻辑修改结束 ▲▲▲
    document.getElementById('cancel-location-btn').onclick = () => {
        locationModal.classList.remove('visible');
        window.__resumeAutoTriggerCountdown?.();
    };
    locationModal.onclick = (e) => {
        if (e.target === locationModal) {
            locationModal.classList.remove('visible');
            window.__resumeAutoTriggerCountdown?.();
        }
    };

    const editModal = document.getElementById('edit-modal');
    const closeEditModal = () => editModal.classList.remove('visible');
    document.getElementById('save-edit-btn').addEventListener('click', async () => {
        const id = Number(document.getElementById('edit-message-id').value);
        const newContent = document.getElementById('edit-message-content').value.trim();
        if (!id || !newContent) return;
        await db.chatMessages.update(id, { text: newContent });
        closeEditModal();
        await loadAndRenderChatHistory(tempState.currentChatId);
        showDynamicIsland('修改成功');
    });
    document.getElementById('cancel-edit-btn').addEventListener('click', closeEditModal);
    editModal.addEventListener('click', (e) => { if (e.target === editModal) closeEditModal(); });
    
    setupStickerPicker();

    initCallFunctionality({
        createAndAppendMessage,
        loadAndRenderChatHistory,
        hideTypingIndicator,
        getCurrentChatIdentity,
        showTypingIndicator,
        triggerAiResponse,
        cancelAiGeneration,
        isModeGenerating,
        regenerateLastResponse,
        deleteLastCallResponse
    });
    // ▼▼▼ 新增：解除拉黑按钮的点击事件 ▼▼▼
    const unblockBtn = document.getElementById('unblock-char-btn');
    if (unblockBtn) {
        unblockBtn.addEventListener('click', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                const restoreUpdates = buildManualBlockAppealRestoreUpdates(char);
                Object.assign(char, restoreUpdates);
                // 静默修改数据库，无需整体刷新页面，体验更顺滑
                await db.characterProfiles.update(char.id, restoreUpdates);
                const blockAppealRequests = await resolvePendingBlockAppealRequests(char.id);
                await createBlockAppealChatCardIfNeeded(char, blockAppealRequests);
                syncOpenBlockAppealRequestModalAfterUnblock(char, blockAppealRequests);
                window.renderNewFriendsPage?.();
                window.refreshChatHomeFriendList?.();
                if (typeof showDynamicIsland === 'function') showDynamicIsland('已解除拉黑', 'success');
                const blockedOverlay = document.getElementById('chat-blocked-overlay');
                if (blockedOverlay) blockedOverlay.style.display = 'none';
            }
        });
    }
    // ▲▲▲ 新增结束 ▲▲▲
    chatMessageList.addEventListener('click', (e) => {
        // 检查被点击的是不是“加载更多”按钮
        const loadMoreButton = e.target.closest('.btn-load-more');
        if (loadMoreButton) {
            const folderElement = loadMoreButton.closest('.message-folder');
            const conversationId = folderElement.dataset.conversationId;
            if (conversationId) {
                expandFoldedMessages(conversationId);
            }
        }
    });
        // ==========================================
    // === 新增：群聊创建核心交互逻辑 ===
    // ==========================================
    const createGroupBtn = document.getElementById('create-group-chat-btn');
    const identityModal = document.getElementById('group-identity-modal-overlay');
    const charModal = document.getElementById('group-char-modal-overlay');
    const identityList = document.getElementById('group-identity-list');
    const charList = document.getElementById('group-char-list');
    const groupCharCount = document.getElementById('group-char-count');
    const groupOwnerSelect = document.getElementById('group-owner-select');
    const groupEstablishedAtInput = document.getElementById('group-established-at-input');
    const groupCreationReasonInput = document.getElementById('group-creation-reason-input');
    let selectedGroupIdentityId = null;
    let selectedGroupCharIds = new Set();
    let selectedGroupNpcs = new Map();
    let selectedGroupOwnerId = null;
    const GROUP_PARTICIPANT_LIMIT = 10;

    const setGroupSelectionCheck = (checkCircle, isSelected) => {
        checkCircle.style.background = isSelected ? '#111' : 'transparent';
        checkCircle.style.borderColor = isSelected ? '#111' : '#ccc';
        checkCircle.innerHTML = isSelected
            ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>'
            : '';
    };

    const getSelectedGroupParticipantCount = () => selectedGroupCharIds.size + selectedGroupNpcs.size;
    const refreshGroupSelectionCount = () => {
        if (groupCharCount) groupCharCount.textContent = getSelectedGroupParticipantCount();
    };

    const formatGroupDateTimeInput = (timestamp) => {
        const date = new Date(timestamp);
        const pad = (value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };

    const getSelectedGroupIdentity = () => AppState.userIdentities.find(identity =>
        isSameCharacterId(identity.id, selectedGroupIdentityId)
    ) || AppState.userIdentities[0];

    const syncGroupOwnerOptions = () => {
        if (!groupOwnerSelect) return;
        const currentUser = getSelectedGroupIdentity();
        const selectedChars = Array.from(selectedGroupCharIds).map(findCharacterById).filter(Boolean);
        const candidates = [
            ...(currentUser ? [{ id: currentUser.id, name: `我（${currentUser.name || '当前身份'}）` }] : []),
            ...selectedChars.map(char => ({ id: char.id, name: char.name || '未命名角色' })),
            ...Array.from(selectedGroupNpcs.values()).map(npc => ({ id: npc.id, name: `${npc.name || '未命名 NPC'}（NPC）` }))
        ];
        if (!candidates.some(candidate => isSameCharacterId(candidate.id, selectedGroupOwnerId))) {
            selectedGroupOwnerId = currentUser?.id || null;
        }

        groupOwnerSelect.innerHTML = '';
        candidates.forEach(candidate => {
            const option = document.createElement('option');
            option.value = String(candidate.id);
            option.textContent = candidate.name;
            groupOwnerSelect.appendChild(option);
        });
        if (selectedGroupOwnerId != null) groupOwnerSelect.value = String(selectedGroupOwnerId);
    };

    const createGroupCollageAvatar = async (groupId, avatarUrls) => {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 120;
            canvas.height = 120;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.fillStyle = '#e0e0e0';
            ctx.fillRect(0, 0, 120, 120);

            const loadedImages = await Promise.all(avatarUrls.map(url => new Promise((resolve) => {
                const img = new Image();
                img.crossOrigin = 'Anonymous';
                const timer = setTimeout(() => resolve(null), 3000);
                img.onload = () => { clearTimeout(timer); resolve(img); };
                img.onerror = () => { clearTimeout(timer); resolve(null); };
                img.src = url;
            })));

            const count = loadedImages.length;
            const cols = count <= 4 ? 2 : 3;
            const size = 120 / cols;
            const rows = Math.ceil(count / cols);
            const startY = (120 - rows * size) / 2;
            loadedImages.forEach((img, index) => {
                if (!img) return;
                const currentRow = Math.floor(index / cols);
                const itemsInThisRow = currentRow === rows - 1 ? count - currentRow * cols : cols;
                const startX = (120 - itemsInThisRow * size) / 2;
                const colIndexInRow = index % cols;
                ctx.drawImage(img, startX + colIndexInRow * size, startY + currentRow * size, size, size);
                ctx.strokeStyle = '#e0e0e0';
                ctx.lineWidth = 2;
                ctx.strokeRect(startX + colIndexInRow * size, startY + currentRow * size, size, size);
            });

            const collageAvatarBase64 = canvas.toDataURL('image/jpeg', 0.85);
            const latestGroup = await db.characterProfiles.get(groupId);
            if (!latestGroup || latestGroup.avatar !== DEFAULT_AVATAR_SRC) return;

            await db.characterProfiles.update(groupId, { avatar: collageAvatarBase64 });
            const localGroup = findCharacterById(groupId);
            if (localGroup?.avatar === DEFAULT_AVATAR_SRC) localGroup.avatar = collageAvatarBase64;

            const { refreshCharacterLists } = await import('./character.js');
            refreshCharacterLists();
        } catch (err) {
            console.warn('生成群聊拼图头像失败，保留默认头像', err);
        }
    };
    // 1. 点击【群聊】按钮 -> 弹出【身份选择弹窗】
    if (createGroupBtn) {
        createGroupBtn.addEventListener('click', () => {
            identityList.innerHTML = ''; // 清空旧列表
            
            // 遍历并生成身份列表 (黑白灰极简风)
            AppState.userIdentities.forEach(identity => {
                const item = document.createElement('div');
                item.style.cssText = 'display: flex; align-items: center; padding: 12px 15px; border-radius: 16px; background: #fafafa; cursor: pointer; transition: background 0.2s; border: 1px solid transparent;';
                item.innerHTML = `
                    <img src="${isValidAvatarSrc(identity.avatar) ? identity.avatar : DEFAULT_AVATAR_SRC}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; margin-right: 12px; border: 1px solid #eee;">
                    <div style="flex: 1;">
                        <div style="font-size: 15px; font-weight: 600; color: #111;">${escapeHTML(identity.name)}</div>
                         <div style="font-size: 12px; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px;">${escapeHTML(identity.persona || '默认身份')}</div>
                    </div>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#ccc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                `;
                
                // 悬停变色效果
                item.onmouseover = () => item.style.background = '#f0f0f0';
                item.onmouseout = () => item.style.background = '#fafafa';
                
                // 点击选择身份 -> 关闭当前弹窗 -> 打开角色选择弹窗
                item.onclick = () => {
                    selectedGroupIdentityId = identity.id;
                    identityModal.style.opacity = '0';
                    setTimeout(() => {
                        identityModal.style.display = 'none';
                        openCharSelectionModal(); // 调起第二步
                    }, 300);
                };
                identityList.appendChild(item);
            });
            
            // 显示弹窗
            identityModal.style.display = 'flex';
            setTimeout(() => identityModal.style.opacity = '1', 10);
        });
    }
    // 通用的关闭弹窗函数
    const closeGroupModals = () => {
        if(identityModal) identityModal.style.opacity = '0';
        if(charModal) charModal.style.opacity = '0';
        setTimeout(() => {
            if(identityModal) identityModal.style.display = 'none';
            if(charModal) charModal.style.display = 'none';
        }, 300);
    };
    document.getElementById('close-group-identity-btn')?.addEventListener('click', closeGroupModals);
    document.getElementById('close-group-char-btn')?.addEventListener('click', closeGroupModals);
    groupOwnerSelect?.addEventListener('change', () => {
        selectedGroupOwnerId = groupOwnerSelect.value || selectedGroupIdentityId;
    });
    // 2. 第二步：打开【角色选择弹窗】
    const openCharSelectionModal = () => {
        selectedGroupCharIds.clear();
        selectedGroupNpcs.clear();
        selectedGroupOwnerId = selectedGroupIdentityId;
        if (groupEstablishedAtInput) groupEstablishedAtInput.value = formatGroupDateTimeInput(Date.now());
        if (groupCreationReasonInput) groupCreationReasonInput.value = '';
        refreshGroupSelectionCount();
        
        // 过滤掉群聊本身，以及尚未添加到通讯录/好友列表的角色
        const availableChars = AppState.characterProfiles.filter(c => !c.isGroup && c.inContacts !== false && isCharacterFriend(c));

        const hasDuplicateParticipantName = (names, ignoredNpcKey = null) => {
            const normalizedNames = names.map(name => String(name || '').trim());
            if (new Set(normalizedNames).size !== normalizedNames.length) return true;
            const selectedNames = new Set(
                Array.from(selectedGroupCharIds)
                    .map(findCharacterById)
                    .filter(Boolean)
                    .map(char => String(char.name || '').trim())
            );
            selectedGroupNpcs.forEach((npc, key) => {
                if (key !== ignoredNpcKey) selectedNames.add(npc.name);
            });
            return normalizedNames.some(name => selectedNames.has(name));
        };

        const renderGroupParticipantList = () => {
            charList.innerHTML = '';
            syncGroupOwnerOptions();
            if (availableChars.length === 0) {
                charList.innerHTML = '<div style="text-align:center; color:#999; padding:20px; font-size:13px;">暂无可用角色</div>';
                return;
            }

            const fragment = document.createDocumentFragment();
            availableChars.forEach(char => {
                const item = document.createElement('div');
                item.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 12px 15px; border-radius: 16px; background: #fafafa; cursor: pointer; transition: 0.2s;';
                const leftDiv = document.createElement('div');
                leftDiv.style.cssText = 'display: flex; align-items: center; min-width: 0;';
                leftDiv.innerHTML = `
                    <img src="${isValidAvatarSrc(char.avatar) ? char.avatar : DEFAULT_AVATAR_SRC}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; margin-right: 12px; border: 1px solid #eee;">
                    <span style="font-size: 15px; font-weight: 600; color: #111; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHTML(char.name)}</span>
                `;
                const checkCircle = document.createElement('div');
                checkCircle.style.cssText = 'width: 20px; height: 20px; flex: 0 0 20px; border-radius: 50%; border: 2px solid #ccc; display: flex; align-items: center; justify-content: center; transition: all 0.2s; background: transparent;';
                setGroupSelectionCheck(checkCircle, selectedGroupCharIds.has(char.id));
                item.append(leftDiv, checkCircle);
                item.onclick = () => {
                    if (selectedGroupCharIds.has(char.id)) {
                        selectedGroupCharIds.delete(char.id);
                        Array.from(selectedGroupNpcs.entries()).forEach(([key, npc]) => {
                            if (isSameCharacterId(npc.ownerId, char.id)) selectedGroupNpcs.delete(key);
                        });
                    } else {
                        if (getSelectedGroupParticipantCount() >= GROUP_PARTICIPANT_LIMIT) {
                            if (typeof showDynamicIsland === 'function') showDynamicIsland('最多只能选择10名角色或 NPC', 'warning');
                            return;
                        }
                        if (hasDuplicateParticipantName([char.name])) {
                            if (typeof showDynamicIsland === 'function') showDynamicIsland('群聊中不能选择同名角色或 NPC', 'warning');
                            return;
                        }
                        selectedGroupCharIds.add(char.id);
                    }
                    refreshGroupSelectionCount();
                    renderGroupParticipantList();
                };
                fragment.appendChild(item);

                const npcList = Array.isArray(char.relatedNpcs) ? char.relatedNpcs : [];
                npcList.forEach((npc, index) => {
                    const npcName = String(npc?.name || '').trim();
                    if (!npcName) return;
                    const npcId = `group-npc:${char.id}:${npc.id || index}`;
                    const npcMember = {
                        id: npcId,
                        ownerId: char.id,
                        name: npcName,
                        avatar: npc.avatar || '',
                        relation: npc.relation || '角色关联 NPC',
                        persona: npc.persona || '',
                        canReferenceOwnerUserHistory: true
                    };
                    const npcItem = document.createElement('div');
                    npcItem.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-left: 20px; padding: 9px 15px; border-radius: 14px; background: #f5f5f5; cursor: pointer; transition: 0.2s;';
                    const npcLeft = document.createElement('div');
                    npcLeft.style.cssText = 'display: flex; align-items: center; min-width: 0;';
                    npcLeft.innerHTML = `
                        <img src="${isValidAvatarSrc(npcMember.avatar) ? npcMember.avatar : DEFAULT_AVATAR_SRC}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; margin-right: 10px; border: 1px solid #e5e5e5;">
                        <div style="min-width: 0;"><div style="font-size: 13px; font-weight: 600; color: #333; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHTML(npcName)}</div><div style="font-size: 11px; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">NPC · ${escapeHTML(npcMember.relation)}</div></div>
                    `;
                    const npcCheckCircle = document.createElement('div');
                    npcCheckCircle.style.cssText = 'width: 18px; height: 18px; flex: 0 0 18px; border-radius: 50%; border: 2px solid #ccc; display: flex; align-items: center; justify-content: center; transition: all 0.2s; background: transparent;';
                    setGroupSelectionCheck(npcCheckCircle, selectedGroupNpcs.has(npcId));
                    npcItem.append(npcLeft, npcCheckCircle);
                    npcItem.onclick = () => {
                        if (selectedGroupNpcs.has(npcId)) {
                            selectedGroupNpcs.delete(npcId);
                        } else {
                            const ownerNeedsAdding = !selectedGroupCharIds.has(char.id);
                            const neededSlots = ownerNeedsAdding ? 2 : 1;
                            if (getSelectedGroupParticipantCount() + neededSlots > GROUP_PARTICIPANT_LIMIT) {
                                if (typeof showDynamicIsland === 'function') showDynamicIsland('最多只能选择10名角色或 NPC', 'warning');
                                return;
                            }
                            const namesToCheck = ownerNeedsAdding ? [char.name, npcName] : [npcName];
                            if (hasDuplicateParticipantName(namesToCheck, npcId)) {
                                if (typeof showDynamicIsland === 'function') showDynamicIsland('群聊中不能选择同名角色或 NPC', 'warning');
                                return;
                            }
                            if (ownerNeedsAdding) selectedGroupCharIds.add(char.id);
                            selectedGroupNpcs.set(npcId, npcMember);
                        }
                        refreshGroupSelectionCount();
                        renderGroupParticipantList();
                    };
                    fragment.appendChild(npcItem);
                });
            });
            charList.appendChild(fragment);
        };

        renderGroupParticipantList();
        
        charModal.style.display = 'flex';
        setTimeout(() => charModal.style.opacity = '1', 10);
    };
        // 3. 点击【创建群聊】按钮保存数据
    document.getElementById('create-group-confirm-btn')?.addEventListener('click', async () => {
        if (selectedGroupCharIds.size === 0) {
            if(typeof showDynamicIsland === 'function') showDynamicIsland('请至少选择1个角色', 'warning');
            return;
        }
        try {
           // 【核心修改1】智能检查并创建“群聊”专属分组
            let groupCat = AppState.characterGroups.find(g => g.name === '群聊');
            if (!groupCat) {
                groupCat = { id: 'group_chat_' + Date.now(), name: '群聊' };
                AppState.characterGroups.push(groupCat);
                const oldCharData = await db.appData.get('characterData') || { value: {} };
                await db.appData.put({ key: 'characterData', value: { ...oldCharData.value, groups: AppState.characterGroups } });
            }
            
            const currentUser = getSelectedGroupIdentity();
            const selectedChars = Array.from(selectedGroupCharIds).map(findCharacterById).filter(Boolean);
            const selectedNpcs = Array.from(selectedGroupNpcs.values());
            const requestedOwnerId = selectedGroupOwnerId || selectedGroupIdentityId;
            const ownerIsValid = isSameCharacterId(requestedOwnerId, selectedGroupIdentityId)
                || selectedChars.some(char => isSameCharacterId(char.id, requestedOwnerId))
                || selectedNpcs.some(npc => isSameCharacterId(npc.id, requestedOwnerId));
            const groupOwnerId = ownerIsValid ? requestedOwnerId : selectedGroupIdentityId;
            const parsedEstablishedAt = Date.parse(groupEstablishedAtInput?.value || '');
            const groupEstablishedAt = Number.isFinite(parsedEstablishedAt) ? parsedEstablishedAt : Date.now();
            const groupCreationReason = String(groupCreationReasonInput?.value || '').trim().slice(0, 300);
            const avatarUrls = [
                currentUser?.avatar || DEFAULT_AVATAR_SRC,
                ...selectedChars.map(char => char.avatar || DEFAULT_AVATAR_SRC),
                ...selectedNpcs.map(npc => npc.avatar || DEFAULT_AVATAR_SRC)
            ].slice(0, 9);
            const groupId = String(Date.now());
            // 【核心修改2】先保存可用的群聊，拼图头像随后在后台生成，避免阻塞创建按钮
            const newGroupChat = {
                id: groupId,
                groupNumber: Math.floor(10000000 + Math.random() * 90000000).toString(), // ▼▼▼ 新增：生成一个固定的8位随机群号
                name: '群聊 (' + (getSelectedGroupParticipantCount() + 1) + '人)', // 加上用户自己
                avatar: DEFAULT_AVATAR_SRC,
                isGroup: true, 
                memberIds: Array.from(selectedGroupCharIds), 
                groupNpcMembers: selectedNpcs,
                ownerId: groupOwnerId,
                chatIdentityId: selectedGroupIdentityId, 
                groupEstablishedAt,
                groupCreationReason,
                charInteractionCardEnabled: true,
                timestamp: Date.now(),
                isFriend: true,      // 直接确认为好友
                hasChat: true,       // 直接出现在聊天主页的列表中
                groupId: groupCat.id // 强制归入“群聊”分组
            };
            // 保存到 IndexDB 数据库和内存中
            await db.characterProfiles.add(newGroupChat); 
            AppState.characterProfiles.push(newGroupChat); 
            
            closeGroupModals();
            if(typeof showDynamicIsland === 'function') showDynamicIsland('群聊创建成功', 'success');
            
            // 【核心修改3】只刷新列表，不重新初始化整套好友模块，避免重复绑定事件导致越用越卡
            const { refreshCharacterLists } = await import('./character.js');
            refreshCharacterLists();
            
            // 自动模拟点击“好友”Tab，让用户立刻看到新鲜出炉的群聊卡片
            const friendsTab = document.querySelector('.tab-item[data-content="friends-content"]');
            if(friendsTab) friendsTab.click();

            void createGroupCollageAvatar(groupId, avatarUrls);
        } catch (err) {
            console.error('创建群聊失败:', err);
            if(typeof showDynamicIsland === 'function') showDynamicIsland('创建失败', 'error');
        }
    });
}
// =========================================================================
// == 从 moments.js 复制过来的辅助函数，用于生成完整的动态卡片 ==
// =========================================================================

// ▼▼▼ 把下面这个新函数，粘贴到 createMomentElementForModal 的前面 ▼▼▼

/**
 * 【新增】专门用于格式化动态时间戳的函数
 */
function formatMomentTimestamp(timestamp) {
    const now = new Date();
    const past = new Date(timestamp);
    const diffSeconds = Math.floor((now - past) / 1000);

    const minute = 60;
    const hour = minute * 60;
    const day = hour * 24;

    if (diffSeconds < minute) {
        return '刚刚';
    } else if (diffSeconds < hour) {
        return `${Math.floor(diffSeconds / minute)}分钟前`;
    } else if (diffSeconds < day) {
        return `${Math.floor(diffSeconds / hour)}小时前`;
    } else {
        const month = past.getMonth() + 1;
        const dayOfMonth = past.getDate();
        return `${month}月${dayOfMonth}日`;
    }
}

/**
 * 创建动态卡片的 HTML 结构 (从 moments.js 复制，用于弹窗显示)
 */
function createMomentElementForModal(data) {
    // 这个函数的内容和 moments.js 里的 createMomentElement 基本一样
    // 我们只是把它复制过来，让 chat-ui.js 也能用
    const article = document.createElement('article');
    article.className = 'moment-card'; // 使用和动态页完全一样的class
    article.dataset.id = data.id;
    const media = data.media || [];
    const likes = data.likes || [];
    const comments = data.comments || [];
    
    const commentsHtml = comments.map((c, index) => {
        if (c.replyToUser) {
            return `<div class="comment-item" data-user="${c.user}" data-index="${index}"><span class="comment-user">${c.user}</span> <span class="reply-indicator">回复</span> <span class="comment-user">${c.replyToUser}:</span><span class="comment-content"> ${c.content}</span></div>`;
        } else {
            return `<div class="comment-item" data-user="${c.user}" data-index="${index}"><span class="comment-user">${c.user}:</span><span class="comment-content"> ${c.content}</span></div>`;
        }
    }).join('');

    const count = media.length;
    let gridClass = 'grid-' + count;
    if (count > 9) gridClass = 'grid-9';
    const mediaHtml = media.map(item => {
        if (item.type === 'image') {
            return `<div class="media-item"><img src="${item.src}" loading="lazy"></div>`;
        } else {
            return `<div class="media-item"><div class="simulated-image-container"><div class="simulated-content">${item.content}</div></div></div>`;
        }
    }).join('');
    
    const locationHtml = data.location ? `<span class="separator">·</span><span class="location">${data.location}</span>` : '';
    
    // ▼▼▼ 【修改】应用专属头像/昵称 ▼▼▼
    const char = AppState.characterProfiles.find(c => c.name === data.author);
    const displayAvatar = char ? (char.chatOverrideAvatar || char.avatar) : data.avatar;
    const displayName = char ? (char.chatOverrideName || char.name) : data.author;
    // ▲▲▲ 修改结束 ▲▲▲

    // 我们不需要点赞、评论按钮，所以把 footer 部分简化了
    article.innerHTML = `
        <header class="moment-card__header">
            <div class="avatar-wrapper"><img src="${displayAvatar}" class="avatar-img author-avatar" alt="avatar"></div>
            <div class="meta-wrapper">
                <div class="author-name">${displayName}</div>
                <div class="meta-info"><span class="time">${formatMomentTimestamp(data.id)}</span>${locationHtml}</div>

            </div>

        </header>
        <div class="moment-card__body">
            ${data.content ? `<p class="content-text">${data.content}</p>` : ''}
            ${count > 0 ? `<div class="media-grid ${gridClass}">${mediaHtml}</div>` : ''}
        </div>
        <div class="moment-card__comments" style="display: block;">
            <div class="comments-box">
                <div class="likes-list" style="${likes.length > 0 ? '' : 'display: none;'}">
                    <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:#576b95;margin-right:4px;"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
                    <span> ${likes.join(', ')}</span>
                </div>
                <div class="comment-list">
                    ${commentsHtml}
                </div>
            </div>
        </div>
    `;
    return article;
}
/**
 * 【全新】显示动态详情弹窗
 */
async function showMomentDetailModal(momentId) {
    // 1. 根据ID从数据库里拿出完整的动态数据
    const momentData = await db.moments.get(momentId);

    if (!momentData) {
        showDynamicIsland('该动态可能已被删除');
        return;
    }

    // 2. 创建弹窗的 HTML 结构
    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'moment-detail-modal-overlay'; // 这个class用来设置样式

    const modalContent = document.createElement('div');
    modalContent.className = 'moment-detail-modal-content';

    // 3. 用我们刚复制的“图纸”函数来画出卡片
    const momentCardElement = createMomentElementForModal(momentData);
    
    // 把画好的卡片放进弹窗里
    modalContent.appendChild(momentCardElement);
    modalOverlay.appendChild(modalContent);
    
    // 4. 把弹窗添加到页面上并显示出来
    document.body.appendChild(modalOverlay);
    
    // 加个小动画，让它“淡入”
    setTimeout(() => modalOverlay.classList.add('visible'), 10);

    // 5. 点击弹窗外面（灰色区域）就关掉弹窗
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) {
            modalOverlay.classList.remove('visible');
            // 动画结束后再移除DOM，更流畅
            setTimeout(() => modalOverlay.remove(), 300);
        }
    });
}
// ...（前面代码）
window.createAndAppendMessage = createAndAppendMessage;
window.getCurrentChatIdentity = getCurrentChatIdentity;
/**
 * 【核心抽离】小票 HTML 模板生成器
 */
function generateReceiptHtml(receiptData) {
    const itemsHtml = receiptData.items.map(item => `
        <div class="table-row">
            <span class="item-name">${escapeHTML(item.name)} ${item.specs ? `(${escapeHTML(item.specs)})` : ''}</span>
            <span class="item-qty">×${item.count}</span>
            <span class="item-price">¥${item.price.toFixed(2)}</span>
        </div>
    `).join('');
    const discountsHtml = (receiptData.discounts || []).map(d => `
        <div class="receipt-info-row">
            <span class="key">${escapeHTML(d.name)}</span>
            <span class="value">-¥${Math.abs(d.amount).toFixed(2)}</span>
        </div>
    `).join('');
    const now = new Date();
    const orderId = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
    const transactionTime = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    const transactionId = `${orderId.replace('-', '')}${(Math.random() * 1e12).toString().padStart(12, '0')}`;
    let barcodeSvg = '<svg class="barcode-svg" xmlns="http://www.w3.org/2000/svg" width="100%" height="50" viewBox="0 0 240 50" preserveAspectRatio="none">';
    for (let i = 0; i < 60; i++) {
        const width = Math.random() * 2 + 0.5;
        const x = i * 4;
        barcodeSvg += `<rect x="${x}" y="0" width="${width}" height="50" fill="black" />`;
    }
    barcodeSvg += '</svg>';
    return `
        <div class="receipt-card">
            <div class="receipt-header">
                <div class="title-cn">Looky</div>
                <div class="title-en">JANEKE</div>
                <div class="subtitle">数字生活馆 × 概念商店</div>
                <div class="address">赛博空间 像素大道666号</div>
            </div>
            <div class="receipt-divider"></div>
            <div class="receipt-info-row">
                <span class="key">收银员</span>
                <span class="value">WK008</span>
            </div>
            <div class="receipt-info-row">
                <span class="key">订单号</span>
                <span class="value">${orderId}</span>
            </div>
            <div class="receipt-info-row">
                <span class="key">交易时间</span>
                <span class="value">${transactionTime}</span>
            </div>
            <div class="receipt-divider"></div>
            <div class="receipt-slogan">欢迎光临looky小店</div>
            <div class="receipt-divider"></div>
            <div class="receipt-items-table">
                <div class="table-header"><span class="col-name">商品名称</span><span class="col-qty">数量</span><span class="col-price">单价</span></div>
                <div class="table-body">${itemsHtml}</div>
            </div>
            ${discountsHtml ? `<div class="receipt-divider"></div>${discountsHtml}` : ''}
            <div class="receipt-divider"></div>
            <div class="receipt-info-row receipt-total-row">
                <span class="key">实付金额</span>
                <span class="value">¥${receiptData.total.toFixed(2)}</span>
            </div>
            <div class="receipt-info-row">
                <span class="key">支付方式</span>
                <span class="value">${receiptData.payMethod || '支付宝'}</span>
            </div>
            <div class="receipt-divider"></div>
            <div class="receipt-barcode-section">
                <div class="barcode-number">${transactionId}</div>
                ${barcodeSvg}
            </div>
            <div class="receipt-footer"><span>Have a wonderful day!</span></div>
        </div>
    `;
}
/**
 * 【新增】创建并发送外卖小票消息
 * @param {string} chatId - 要发送到的聊天ID
 * @param {object} receiptData - 包含小票所需信息的对象
 *   - items: [{name: string, price: number, count: number, specs: string}]
 *   - total: number
 *   - subtotal: number
 *   - discounts: [{name: string, amount: number}]
 *   - payMethod: string
 */
export async function sendReceiptMessage(chatId, receiptData) {
    // ▼▼▼ 群聊投递器：把送给个人的单子丢进群里，并在名字加@提醒AI ▼▼▼
    const currChat = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
    if (currChat && currChat.isGroup && String(chatId) !== String(tempState.currentChatId)) {
        const targetChar = AppState.characterProfiles.find(c => c.id === chatId);
        if (targetChar && receiptData.items && receiptData.items.length > 0) {
            receiptData.items[0].name = receiptData.items[0].name + ` (@${targetChar.name})`;
        }
        chatId = tempState.currentChatId; // 强制截获并投入当前群聊
    }
    // ▲▲▲ 投递器结束 ▲▲▲
    // 1. 生成小票的完整HTML
    // 【修复】商品名称现在会带上规格

    const itemsHtml = receiptData.items.map(item => `
        <div class="table-row">
            <span class="item-name">${escapeHTML(item.name)} ${item.specs ? `(${escapeHTML(item.specs)})` : ''}</span>
            <span class="item-qty">×${item.count}</span>
            <span class="item-price">¥${item.price.toFixed(2)}</span>
        </div>
    `).join('');

    const discountsHtml = (receiptData.discounts || []).map(d => `
        <div class="receipt-info-row">
            <span class="key">${escapeHTML(d.name)}</span>
            <span class="value">-¥${Math.abs(d.amount).toFixed(2)}</span>
        </div>
    `).join('');

    // 伪造一些小票信息
    const now = new Date();
    const orderId = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
    const transactionTime = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    const transactionId = `${orderId.replace('-', '')}${(Math.random() * 1e12).toString().padStart(12, '0')}`;

    // 模拟条形码SVG
    let barcodeSvg = '<svg class="barcode-svg" xmlns="http://www.w3.org/2000/svg" width="100%" height="50" viewBox="0 0 240 50" preserveAspectRatio="none">';
    for (let i = 0; i < 60; i++) {
        const width = Math.random() * 2 + 0.5;
        const x = i * 4;
        barcodeSvg += `<rect x="${x}" y="0" width="${width}" height="50" fill="black" />`;
    }
    barcodeSvg += '</svg>';

    // 【修复】更新小票上的固定文案
    const receiptHtml = `
        <div class="receipt-card">
            <div class="receipt-header">
                <div class="title-cn">Looky</div>
                <div class="title-en">JANEKE</div>
                <div class="subtitle">数字生活馆 × 概念商店</div>
                <div class="address">赛博空间 像素大道666号</div>
            </div>
            <div class="receipt-divider"></div>
            <div class="receipt-info-row">
                <span class="key">收银员</span>
                <span class="value">WK008</span>
            </div>
            <div class="receipt-info-row">
                <span class="key">订单号</span>
                <span class="value">${orderId}</span>
            </div>
            <div class="receipt-info-row">
                <span class="key">交易时间</span>
                <span class="value">${transactionTime}</span>
            </div>
            <div class="receipt-divider"></div>
            <div class="receipt-slogan">欢迎光临looky小店</div>
            <div class="receipt-divider"></div>
            <div class="receipt-items-table">
                <div class="table-header">
                    <span class="col-name">商品名称</span>
                    <span class="col-qty">数量</span>
                    <span class="col-price">单价</span>
                </div>
                <div class="table-body">
                    ${itemsHtml}
                </div>
            </div>
            ${discountsHtml ? `<div class="receipt-divider"></div>${discountsHtml}` : ''}
            <div class="receipt-divider"></div>
            <div class="receipt-info-row receipt-total-row">
                <span class="key">实付金额</span>
                <span class="value">¥${receiptData.total.toFixed(2)}</span>
            </div>
            <div class="receipt-info-row">
                <span class="key">支付方式</span>
                <span class="value">${receiptData.payMethod || '支付宝'}</span>
            </div>
            <div class="receipt-divider"></div>
            <div class="receipt-barcode-section">
                <div class="barcode-number">${transactionId}</div>
                ${barcodeSvg}
            </div>
            <div class="receipt-footer">
                <span>Have a wonderful day!</span>
            </div>
        </div>
    `;

    // 2. 构造消息对象
    const messageToSave = {
        chatId: chatId,
        timestamp: new Date(),
        text: receiptHtml,
        type: 'sent',
        contentType: 'receipt',
        receiptInfo: receiptData,
        recalled: false,
    };

    // 3. 保存并渲染消息
    try {
        const messageId = await db.chatMessages.add(messageToSave);
        const newMessage = await db.chatMessages.get(messageId);
        await recordLookyLedger({
            source: 'receipt_send',
            sourceId: messageId,
            type: 'expense',
            amount: receiptData.total,
            category: receiptData.deliveryInfo ? '购物' : '餐饮',
            title: receiptData.items?.[0]?.name || '消费订单',
            memo: receiptData.payMethod || '',
            char: chatId,
            timestamp: Date.now(),
            isAuto: true
        });
        
        // 【修复Bug #2 的关键】
        // 无论如何，都先在侧边栏更新预览，这样用户就知道有新消息了
        updateSidebarPreview(chatId, newMessage);
        
        // 只有当小票是发给当前聊天窗口时，才立刻显示出来
        if (String(chatId) === String(tempState.currentChatId)) {
            await createAndAppendMessage(newMessage, false); // 发送小票时不自动滚动到底部
        }
        playUserSendSound(findCharacterById(chatId));
        window.__autoTriggerCountdown?.();
 return messageId;
    } catch (error) {
        console.error('发送小票消息失败:', error);
        showDynamicIsland('发送小票失败', 'error');
    }
}
export async function sendPayRequestMessage(chatId, requestData) {
    // ▼▼▼ 群聊投递器：把找人代付的请求甩在群里，并高呼@谁付钱 ▼▼▼
    const currChat = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
    if (currChat && currChat.isGroup && String(chatId) !== String(tempState.currentChatId)) {
        const targetChar = AppState.characterProfiles.find(c => c.id === chatId);
        if (targetChar) requestData.name = requestData.name + ` (@${targetChar.name})`;
        chatId = tempState.currentChatId; // 强制截获并投入当前群聊
    }
    // ▲▲▲ 投递器结束 ▲▲▲
    const textPreview = `[代付请求] ${requestData.name} ¥${requestData.price}`;
    const targetChatChar = AppState.characterProfiles.find(c => c.id === chatId); // ← 加这一行
    
    const messageToSave = {

        chatId: chatId,
        timestamp: new Date(),
        text: textPreview, // 用于侧边栏预览
        type: 'sent',      // 标记为我发出的
        contentType: 'pay_request',
        payRequestInfo: {
            ...requestData,
            status: 'pending',
            expiryTime: Date.now() + 15 * 60 * 1000 // 15分钟后过期
        },
        recalled: false,
        isRejected: targetChatChar && targetChatChar.isBlockedByAi ? true : false, // ← 加这一行
    };
    try {
        const messageId = await db.chatMessages.add(messageToSave);
        const newMessage = await db.chatMessages.get(messageId);
        updateSidebarPreview(chatId, newMessage);
        
        if (String(chatId) === String(tempState.currentChatId)) {
            await createAndAppendMessage(newMessage);
        }
        playUserSendSound(findCharacterById(chatId));
        window.__autoTriggerCountdown?.();
        return true;
    } catch (error) {
        console.error('发送代付请求失败:', error);
        return false;
    }
}
document.addEventListener('payRequestAction', async (e) => {
    const { id, action } = e.detail;
    if (!id || !action) return;
    
    // ▼▼▼ 修改开始：获取原始消息判断身份 ▼▼▼
    const msg = await db.chatMessages.get(Number(id));
    if (!msg) return;
      if (action === 'completed' && msg.type === 'received') {
        // 如果是“收到”的消息（AI发起的请求），用户点击了支付
        const info = msg.payRequestInfo;
        const payment = await requestLookyPayment({
            amount: info.price,
            title: info.name || '替 Ta 支付',
            scene: info.type === 'shop_pay' ? 'shop' : 'food'
        });
        if (!payment) return;
        await recordLookyLedger({
            source: 'pay_request_paid_by_user',
            sourceId: id,
            type: 'expense',
            amount: info.price,
            category: info.type === 'shop_pay' ? '购物' : '餐饮',
            title: info.name || '替 Ta 支付',
            memo: info.specs || '',
            char: msg.chatId,
            paymentMethod: payment.displayName || '',
            paymentCardId: payment.paymentCardId || (payment.type === 'card' ? payment.id : 'balance'),
            timestamp: Date.now(),
            isAuto: true
        });
        
        // 智能区分外卖和购物（通过餐饮词库匹配）
        const isFood = /饭|面|粉|茶|咖啡|汉堡|披萨|炸鸡|水|汤|菜|肉|外卖|烧烤|火锅|寿司|日料|麻辣烫|串|饮|杯|果汁/.test(info.name || '');

        if (isFood) {
            // 是吃的喝的，生成经典外卖纸质小票
            const receiptData = {
                items: [{ name: info.name, price: parseFloat(info.price), count: 1, specs: info.specs }],
                total: parseFloat(info.price),
                discounts: [],
                payMethod: '由用户支付'
            };
            const receiptHtml = generateReceiptHtml(receiptData);
            await db.chatMessages.update(id, {
                contentType: 'receipt',
                text: receiptHtml,
                receiptInfo: receiptData,
                payRequestInfo: null
            });
        } else {
            // 是实物商品，生成高颜值的物流追踪卡片
            const logisticsContent = {
                title: info.name,
                img: info.imageUrl || 'images/default-avatar.svg',
                specs: info.specs || '默认规格',
                address: '角色默认收货地址',
                phone: '138****8888',
                deliveryTime: '3 轮对话后' // 模拟包裹派送中
            };
            
            await db.chatMessages.update(id, {
                contentType: 'logistics_card',
                text: '[物流订单]',
                content: logisticsContent,
                payRequestInfo: null,
                isAiGift: false // 标记为用户付钱买给角色的礼物
            });
            
            // 注册包裹监听倒计时（3轮后触发“包裹已送达”签收动画）
            if (!tempState.activeGifts) tempState.activeGifts = {};
            if (!tempState.activeGifts[msg.chatId]) tempState.activeGifts[msg.chatId] = [];
            tempState.activeGifts[msg.chatId].push({
                msgId: id,
                remaining: 3,
                status: 'delivering',
                title: info.name,
                img: info.imageUrl || 'images/default-avatar.svg',
                isFromAiPay: false // 用户给AI买的不播放开箱动画
            });
            localStorage.setItem('active_gifts_state', JSON.stringify(tempState.activeGifts));
        }

        showDynamicIsland('已帮Ta支付成功', 'success');
        if (String(msg.chatId) === String(tempState.currentChatId)) await loadAndRenderChatHistory(msg.chatId);
        return; 
    }

    // 1. 更新数据库
    await db.chatMessages.update(id, { 'payRequestInfo.status': action });
    // 2. 更新 DOM 样式 (无需刷新)
    const card = document.getElementById(`pay-req-${id}`);
    if (card) {
        card.classList.remove('status-completed', 'status-rejected', 'status-expired');
        card.classList.add(`status-${action}`);
    }
    
    // 3. 可选：如果是支付成功，给个反馈
    if (action === 'completed') {
        showDynamicIsland('已帮Ta支付成功', 'success');
    }
});
/**
 * 更新单个角色的侧边栏预览文本和时间
 */
function formatSidebarPreviewTime(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfMessageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const dayDiff = Math.floor((startOfToday - startOfMessageDay) / 86400000);

    if (dayDiff === 0) {
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${hours}:${minutes}`;
    }
    if (dayDiff === 1) return '昨天';
    if (dayDiff > 1 && dayDiff < 7) {
        return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
    }
    return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function updateSidebarPreview(chatId, messageData) {
    // 1. 找不到元素直接退出，不消耗性能
    const item = document.querySelector(`.conversation-item[data-char-id="${chatId}"]`);
    if (!item) return;
    const incomingPreviewTime = new Date(messageData.timestamp || 0).getTime();
    const currentPreviewTime = Number(item.dataset.previewTimestamp || 0);
    if (incomingPreviewTime && currentPreviewTime > incomingPreviewTime) return;

    // 2. 过滤不需要显示的类型
    if (messageData.type === 'system' || 
        messageData.contentType === 'offline_invite' || 
        messageData.contentType === 'html_snippet' ||   
        messageData.contentType === 'system_event' || 
        messageData.uiVisible === false) {
        return;
    }

    const previewEl = item.querySelector('.chat-preview');
    const timeEl = item.querySelector('.chat-time');

    if (previewEl) {
        let text = '';
        if (messageData.recalled) {
            text = '撤回了一条消息';
        } else if (messageData.contentType === 'voice') {
            text = '[语音]';
        } else if (messageData.contentType === 'location') {
            text = '[位置]';
        } else if (messageData.contentType === 'transfer') {
            text = '[转账]';
        } else if (messageData.contentType === 'joint_fund_invite') {
            text = '[共同小金库邀请]';
        } else if (messageData.contentType === 'vault_transfer_card') {
            text = '[共同金库转账]';
        } else if (messageData.contentType === 'vault_request_card') {
            text = '[共同金库收款]';
        } else if (messageData.contentType === 'moment_card') {
            text = '[分享了动态]';
        } else if (messageData.contentType === 'focus_record_card') {
            text = '[陪伴记录]';
        } else if (messageData.contentType === 'phone_npc_chat_card') {
            text = '[查手机聊天记录]';
        } else if (messageData.contentType === 'friend_request_card') {
            text = '[好友验证前情]';
        } else if (messageData.contentType === 'char_interaction_card') {
            text = '[角色私下互动]';
        } else if (messageData.stickerUrl) {
            text = (messageData.text && messageData.text.startsWith('[表情')) ? '[表情]' : '[图片]';
        } else if (messageData.text) {
            // 【性能优化核心】
            // 先截取前300个字符参与处理，防止消息太长导致正则卡顿
            // 预览栏通常只能显示不到20个字，处理300字绰绰有余
            let rawText = messageData.text;
            if (rawText.length > 300) {
                rawText = rawText.slice(0, 300); 
            }

            text = cleanVisibleMessageText(rawText)
                .replace(/^\[线下场景\]\s*/, '')              // 去场景标签
                .trim();
        }
        
        if (text) {
            previewEl.textContent = text;
        }
    }
    // 更新时间
    if (timeEl && messageData.timestamp) {
        timeEl.textContent = formatSidebarPreviewTime(messageData.timestamp);
        item.dataset.previewTimestamp = String(new Date(messageData.timestamp).getTime());
    }

    // ▼▼▼ 【新增：未读消息黄点提醒逻辑】 ▼▼▼
    if (messageData.type === 'received' && messageData.timestamp) {
        // 【防错机制】检查这条消息是不是“刚发出的” (时间差小于 5 秒)
        // 这样可以完美防止你刚打开网页、系统拉取历史记录时，把所有人都标成未读
        const isBrandNew = (Date.now() - new Date(messageData.timestamp).getTime()) < 5000;
        
        if (isBrandNew) {
            // 检查用户现在是不是正盯着这个人的聊天界面看
            const chatPage = document.getElementById('page-chat-detail');
            // 用实际布局状态判断页面是否真的显示，避免主页面切换后内联样式误导判断。
            const isPageVisible = Boolean(chatPage
                && chatPage.offsetParent !== null
                && window.getComputedStyle(chatPage).display !== 'none');
            const isLookingAtThisChar = isPageVisible && String(tempState.currentChatId) === String(chatId);
            // 如果没在看，就把外面的灯变成醒目的黄/橙色，并加上一点发光效果
            if (!isLookingAtThisChar) {
                const indicator = item.querySelector('.online-indicator');
                if (indicator) {
                    indicator.style.backgroundColor = '#FFB800'; // 醒目的微信提示黄
                    indicator.style.boxShadow = '0 0 6px rgba(255, 184, 0, 0.8)';
                }
            }
        }
    }
}

/**
 * 初始化所有会话的预览
 * 分批查询，避免多角色用户一次性打爆 IndexedDB 导致老手机卡顿
 */
export async function initSidebarPreviews() {
    const items = Array.from(document.querySelectorAll('.conversation-item'));
    
    // ▼▼▼ 【核心修复1】：自动监听列表重绘，防止退出页面后预览全部变白 ▼▼▼
    if (!initSidebarPreviews.hasObserver && items.length > 0) {
        initSidebarPreviews.hasObserver = true;
        const listContainer = items[0].closest('.conversation-list') || items[0].parentElement;
        if (listContainer) {
            const observer = new MutationObserver((mutations) => {
                let shouldUpdate = false;
                for (let m of mutations) {
                    // 如果发现有新的节点被添加进来了（说明列表被重画了）
                    if (m.addedNodes.length > 0) {
                        shouldUpdate = true;
                        break;
                    }
                }
                if (shouldUpdate) {
                    // 防抖处理，等系统全画完再统一去拉数据，避免卡死
                    clearTimeout(listContainer._previewTimer);
                    listContainer._previewTimer = setTimeout(() => {
                        initSidebarPreviews();
                    }, 200);
                }
            });
            observer.observe(listContainer, { childList: true });
        }
    }

    if (items.length === 0) return;
    const runId = (initSidebarPreviews.runId || 0) + 1;
    initSidebarPreviews.runId = runId;
    const batchSize = shouldUseLightChatRenderMode() ? 8 : 20;

    for (let i = 0; i < items.length; i += batchSize) {
        if (initSidebarPreviews.runId !== runId) return;
        const batch = items.slice(i, i + batchSize);
        await Promise.all(batch.map(async (item) => {
            const chatId = item.dataset.charId;
            if (!chatId) return;
            try {
                // 【修复】构建安全的查询列表，防止 "char_xxx" 转数字变成 NaN 导致报错
                const keysToQuery = [chatId]; 
                const numericId = Number(chatId);
                // 只有当它真的能变成有效数字时，才加入数字查询条件
                if (!isNaN(numericId)) {
                    keysToQuery.push(numericId);
                }
                // 只取最近的 3 条，极速查询
                const recentMessages = await db.chatMessages
                    .where('chatId').anyOf(keysToQuery) // 使用我们准备好的安全列表
                    .reverse()
                    .limit(3) 
                    .toArray();
                // 找到第一条能用的
                const validMsg = recentMessages.find(msg => 
                    msg.type !== 'system' &&
                    msg.contentType !== 'offline_invite' &&
                    msg.contentType !== 'html_snippet' &&
                    msg.contentType !== 'system_event' &&
                    msg.uiVisible !== false
                );

                if (validMsg) {
                    updateSidebarPreview(chatId, validMsg);
                }
            } catch (e) {
                // 忽略错误，防止个别数据问题卡死整个流程
            }
        }));
        await new Promise(resolve => setTimeout(resolve, 16));
    }
}

/**
 * 【核心完善】处理 AI 对代付请求的决定：将其转化为带印章的小票/车票
 */
export async function handleAiPayDecision(messageId, status) {
    const msg = await db.chatMessages.get(Number(messageId));
    if (!msg || msg.contentType !== 'pay_request') return;

    if (status === 'completed') {
        const info = msg.payRequestInfo;
        let finalHtml = '';
        let receiptData = null;

        // ▼▼▼ 判断是否是打车行程 ▼▼▼
        if (info.name && info.name.includes('行程')) {
            // --- A. 如果是打车：生成带红章的车票 ---
            const destName = (info.name.replace('行程: ', '').replace('行程：', '')).trim();
            const firstLetter = destName.charAt(0);
            
            // 构造“已支付”红章样式的车票
            finalHtml = `
                <div class="pay-request-card style-ride-classic status-completed" style="pointer-events: none;">
                    <img src="images/back.png" class="card-bg-texture" alt="" onerror="this.style.display='none'">
                    <div class="card-watermark">${firstLetter}</div>
                    <div class="card-inner-border">
                        <div class="card-header-row">
                            <span class="header-tag">TAXI TICKET</span>
                            <span class="header-date">${new Date().toLocaleDateString().replace(/\//g, '.')}</span>
                        </div>
                        <div class="card-main-content">
                            <div class="label-small">DESTINATION</div>
                            <div class="dest-text">${destName}</div>
                            <div class="specs-divider"><span class="line"></span><span class="dot"></span><span class="line"></span></div>
                            <div class="info-row">
                                <span class="car-specs">${info.specs || '专车'}</span>
                                <span class="price-val">¥${info.price}</span>
                            </div>
                        </div>
                       <div style="position: absolute; right: 12px; bottom: 12px; z-index: 10; opacity: 0.6; transform: rotate(-20deg); mix-blend-mode: multiply; pointer-events: none;">
                            <svg width="56" height="56" viewBox="0 0 100 100" fill="none">
                                <!-- 外圈：深灰实线 -->
                                <circle cx="50" cy="50" r="46" stroke="#2c2c2c" stroke-width="2"/>
                                <!-- 内圈：深灰虚线 -->
                                <circle cx="50" cy="50" r="38" stroke="#2c2c2c" stroke-width="1" stroke-dasharray="3 3"/>
                                <!-- 中间：复古检票对勾 -->
                                <path d="M28 52 L42 66 L72 34" stroke="#2c2c2c" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </div>
                    </div>
                </div>
            `;
            
            // ★★★ 关键：通知 life.js 启动行程 (如果是见面的话) ★★★
            // 只有当当前聊天窗口就是这个角色时才触发，防止后台触发
            if (String(msg.chatId) === String(tempState.currentChatId)) {
                document.dispatchEvent(new CustomEvent('ride_payment_success'));
            }

         } 
        // --- 【修改开始】增加机票支付成功逻辑 ---
        else if (info.name && info.name.includes('机票')) {
             // 提取航线
            const routeName = (info.name.replace('机票: ', '').replace('机票：', '')).trim();
            
            // 构造“已支付”红章样式的机票 (复用 style-ride-classic)
            finalHtml = `
                <div class="pay-request-card style-ride-classic status-completed" style="pointer-events: none;">
                    <img src="images/back.png" class="card-bg-texture" alt="" onerror="this.style.display='none'">
                    <div class="card-watermark" style="font-size: 80px; opacity: 0.08;">✈</div>
                    <div class="card-inner-border">
                        <div class="card-header-row">
                            <span class="header-tag">FLIGHT TICKET</span>
                            <span class="header-date">${new Date().toLocaleDateString().replace(/\//g, '.')}</span>
                        </div>
                        <div class="card-main-content">
                            <div class="label-small">ROUTE</div>
                            <div class="dest-text" style="font-size: 20px;">${routeName}</div>
                            <div class="specs-divider"><span class="line"></span><span class="dot"></span><span class="line"></span></div>
                            <div class="info-row">
                                <span class="car-specs">${info.specs || 'Econ'}</span>
                                <span class="price-val">¥${info.price}</span>
                            </div>
                        </div>
                         <!-- 盖章效果 -->
                       <div style="position: absolute; right: 12px; bottom: 12px; z-index: 10; opacity: 0.6; transform: rotate(-20deg); mix-blend-mode: multiply; pointer-events: none;">
                            <svg width="56" height="56" viewBox="0 0 100 100" fill="none">
                                <circle cx="50" cy="50" r="46" stroke="#c00" stroke-width="2"/>
                                <circle cx="50" cy="50" r="38" stroke="#c00" stroke-width="1" stroke-dasharray="3 3"/>
                                <text x="50" y="55" text-anchor="middle" dominant-baseline="middle" fill="#c00" font-size="14" font-weight="bold" transform="rotate(-15, 50, 50)">PAID</text>
                            </svg>
                        </div>
                    </div>
                </div>
            `;
            
            // 触发 flight_payment_success 事件，通知 life.js 显示胶囊
            if (String(msg.chatId) === String(tempState.currentChatId)) {
                document.dispatchEvent(new CustomEvent('flight_payment_success'));
            }
     } else if (info.name && info.name.includes('高铁')) {
            const routeName = (info.name.replace('高铁票: ', '').replace('高铁票：', '')).trim();
            finalHtml = `
                <div class="pay-request-card style-ride-classic status-completed" style="pointer-events: none;">
                    <img src="images/back.png" class="card-bg-texture" alt="" onerror="this.style.display='none'">
                    <div class="card-watermark" style="font-size: 80px; opacity: 0.08;">🚄</div>
                    <div class="card-inner-border">
                        <div class="card-header-row">
                            <span class="header-tag">TRAIN TICKET</span>
                            <span class="header-date">${new Date().toLocaleDateString().replace(/\//g, '.')}</span>
                        </div>
                        <div class="card-main-content">
                            <div class="label-small">ROUTE</div>
                            <div class="dest-text" style="font-size: 20px;">${routeName}</div>
                            <div class="specs-divider"><span class="line"></span><span class="dot"></span><span class="line"></span></div>
                            <div class="info-row">
                                <span class="car-specs">${info.specs || '二等座'}</span>
                                <span class="price-val">¥${info.price}</span>
                            </div>
                        </div>
                        <div style="position: absolute; right: 12px; bottom: 12px; z-index: 10; opacity: 0.6; transform: rotate(-20deg); mix-blend-mode: multiply; pointer-events: none;">
                            <svg width="56" height="56" viewBox="0 0 100 100" fill="none">
                                <circle cx="50" cy="50" r="46" stroke="#007aff" stroke-width="2"/>
                                <circle cx="50" cy="50" r="38" stroke="#007aff" stroke-width="1" stroke-dasharray="3 3"/>
                                <text x="50" y="55" text-anchor="middle" dominant-baseline="middle" fill="#007aff" font-size="14" font-weight="bold" transform="rotate(-15, 50, 50)">PAID</text>
                            </svg>
                        </div>
                    </div>
                </div>
            `;
            if (String(msg.chatId) === String(tempState.currentChatId)) {
                document.dispatchEvent(new CustomEvent('train_payment_success'));
            }
        }
         else if (info.type === 'shop_pay') {
            // ▼▼▼ 【核心修复】区分单品(物流卡)和多件(小票) ▼▼▼
            
            const deliveryTime = info.deliveryTime || '尽快送达';
            
            // 判断依据：如果有 items 数组且长度大于0，说明来自购物车 -> 生成小票
            // 否则说明来自详情页单品 -> 生成物流卡
            if (info.items && info.items.length > 0) {
                
                // === 情况 A：购物车结算 -> 生成 3D 小票 (Receipt) ===
                const receiptData = {
                    items: info.items,
                    total: parseFloat(info.price),
                    discounts: [],
                    payMethod: '好友代付 (已完成)',
                    deliveryInfo: {
                        address: info.address || '默认地址',
                        phone: info.phone || '--',
                        time: deliveryTime // 正确传入轮数
                    }
                };
                await db.chatMessages.update(messageId, {
                    contentType: 'receipt',      // 购物车用小票样式
                    text: '[购物小票]',
                    receiptInfo: receiptData,
                    payRequestInfo: null,
                    isAiGift: true
                });
                // 注册监听 (取第一个商品做代表)
                if (deliveryTime.includes('轮')) {
                    const turns = parseInt(deliveryTime);
                    if (!isNaN(turns)) {
                        if (!tempState.activeGifts) tempState.activeGifts = {};
                        if (!tempState.activeGifts[msg.chatId]) tempState.activeGifts[msg.chatId] = [];
                        tempState.activeGifts[msg.chatId].push({
                            msgId: messageId,
                            remaining: turns,
                            status: 'delivering',
                            title: info.items[0].name || '购物车商品',
                            img: info.items[0].img || '',
                            isFromAiPay: true
                        });
                        localStorage.setItem('active_gifts_state', JSON.stringify(tempState.activeGifts));
                    }
                }
            } else {
                
                // === 情况 B：详情页单品 -> 生成 物流卡 (Logistics Card) ===
                // 详情页请求的数据字段是: name, imageUrl, specs
                const logisticsContent = {
                    title: info.name,           // 单品名称
                    img: info.imageUrl,         // 单品图片
                    specs: info.specs || '标准规格',
                    address: info.address || '默认地址',
                    phone: info.phone || '--',
                    deliveryTime: deliveryTime  // 正确传入轮数
                };
                await db.chatMessages.update(messageId, {
                    contentType: 'logistics_card', // 单品用物流卡样式
                    text: '[物流订单]',
                    content: logisticsContent,     // 物流卡读 content
                    receiptInfo: null,
                    payRequestInfo: null,
                    isAiGift: true
                });
                // 注册监听
                if (deliveryTime.includes('轮')) {
                    const turns = parseInt(deliveryTime);
                    if (!isNaN(turns)) {
                        if (!tempState.activeGifts) tempState.activeGifts = {};
                        if (!tempState.activeGifts[msg.chatId]) tempState.activeGifts[msg.chatId] = [];
                        tempState.activeGifts[msg.chatId].push({
                            msgId: messageId,
                            remaining: turns,
                            status: 'delivering',
                            title: info.name,       // 使用单品名称
                            img: info.imageUrl,     // 使用单品图片
                            isFromAiPay: true
                        });
                        localStorage.setItem('active_gifts_state', JSON.stringify(tempState.activeGifts));
                    }
                }
            }
            // 公共后续：提示与刷新
            showDynamicIsland(`支付成功，${deliveryTime.includes('轮') ? deliveryTime + '送达' : '正在安排发货'}`, 'success');
            
            if (String(msg.chatId) === String(tempState.currentChatId)) {
                await loadAndRenderChatHistory(msg.chatId);
            }
            return;
        }

        else {
            // --- B. 如果是外卖：生成原来的小票 ---
            receiptData = {
                items: [{ name: info.name, price: parseFloat(info.price), count: 1, specs: info.specs }],
                total: parseFloat(info.price),
                discounts: [],
                payMethod: '由对方代付'
            };
            finalHtml = generateReceiptHtml(receiptData);
        }

        // 原地更新数据库中的消息
        await db.chatMessages.update(messageId, {
            contentType: 'receipt',
            text: finalHtml,
            isAiGift: true,
            receiptInfo: receiptData, // 打车可以为null，外卖有数据
            payRequestInfo: null, 
        });

        console.log(`[代付成功] 消息 ${messageId} 已转化。`);
    } else {
        // AI 决定拒绝
        await db.chatMessages.update(messageId, { 'payRequestInfo.status': 'rejected' });
    }

    // 立即重绘界面
    if (String(msg.chatId) === String(tempState.currentChatId)) {
        await loadAndRenderChatHistory(msg.chatId);
    }
}


/**
 * 【核心新增】角色主动下单并发送小票
 */
export async function createCharacterReceipt(chatId, foodInfo, speakerName, avatarSrc, groupRole) {
    const currentChar = AppState.characterProfiles.find(c => c.id === chatId);
    
    let payMethodStr = foodInfo.isGift ? '由对方支付' : '角色私房钱';
    const totalAmount = parseFloat(foodInfo.price);
    
    if (foodInfo.use_vault) {
         try {
            const { spendLookyVault } = await import('./looky-pay.js');
            // ▼▼▼ 在这里把 foodInfo.name 作为 memo 传进去 ▼▼▼
            await spendLookyVault(chatId, totalAmount, { source: 'vault_order_ai', reason: '点外卖', memo: foodInfo.name, insertChatContext: false });
            payMethodStr = '共同小金库';
        } catch (e) { console.warn('金库余额不足，降级私房钱'); }
    }
    // 构造小票数据
    const receiptData = {
        items: [{ 
            name: foodInfo.name, 
            price: totalAmount, 
            count: 1, 
            specs: foodInfo.specs || "" 
        }],
        total: totalAmount,
        discounts: [],
        payMethod: payMethodStr
    };
    const receiptHtml = generateReceiptHtml(receiptData);

    const messageToSave = {
        chatId: chatId,
        timestamp: new Date(),
        text: receiptHtml,
        type: 'received', // 标记为对方发出的
        contentType: 'receipt',
        receiptInfo: receiptData, 
        isAiGift: foodInfo.isGift === true, // 如果买给用户，打上红印章
        avatarSrc: avatarSrc || currentChar?.avatar || DEFAULT_AVATAR_SRC,
        speakerName: speakerName,
        groupRole: groupRole,
        recalled: false,
    };

    try {
        const messageId = await db.chatMessages.add(messageToSave);
        const newMessage = await db.chatMessages.get(messageId);
        // 更新侧边栏预览
        updateSidebarPreview(chatId, { ...newMessage, text: `[外卖小票] ${foodInfo.name}` });
        
        // 如果当前正在和该角色聊天，直接渲染
        if (String(chatId) === String(tempState.currentChatId)) {
            await createAndAppendMessage(newMessage);
        }
    } catch (error) {
        console.error('角色下单失败:', error);
    }
}

/**
 * 【核心新增】创建由 AI 发起的代付请求消息
 */
export async function createAiPayRequestMessage(chatId, requestData, speakerName, avatarSrc, groupRole) {
    const currentChar = AppState.characterProfiles.find(c => c.id === chatId);
    const messageToSave = {
        chatId: chatId,
        timestamp: new Date(),
        text: `[代付请求] ${requestData.name}`, 
        type: 'received', // 标记为对方发出的
        contentType: 'pay_request',
        payRequestInfo: {
            ...requestData,
            status: 'pending'
        },
        avatarSrc: avatarSrc || currentChar?.avatar || DEFAULT_AVATAR_SRC,
        speakerName: speakerName,
        groupRole: groupRole,
        recalled: false,
    };

    try {
        const messageId = await db.chatMessages.add(messageToSave);
        const newMessage = await db.chatMessages.get(messageId);
        updateSidebarPreview(chatId, newMessage);
        if (String(chatId) === String(tempState.currentChatId)) {
            await createAndAppendMessage(newMessage);
        }
    } catch (error) { console.error('创建代付请求失败:', error); }
}
// [chat-ui.js] 文件末尾新增

/**
 * 【新增】显示开箱动画弹窗
 * @param {object} giftData - 礼物数据 { title, img }
 */
export function showGiftUnboxing(giftData) {
    const overlay = document.getElementById('gift-unboxing-overlay');
    const boxContainer = document.getElementById('gift-box-trigger');
    const imgEl = document.getElementById('gift-reveal-img');
    const titleEl = document.getElementById('gift-reveal-title');
    const acceptBtn = document.getElementById('gift-accept-btn');

    if (!overlay || !boxContainer) return;

    // 1. 填充数据
    if (imgEl) imgEl.src = giftData.img || 'images/default-food.jpg';
    if (titleEl) titleEl.textContent = giftData.title || '神秘礼物';

    // 2. 重置状态 (防止上次动画残留)
    overlay.classList.remove('revealed');
    boxContainer.classList.remove('open');
    
    // 3. 显示遮罩
    overlay.classList.add('visible');

    // 4. 绑定开箱点击事件 (一次性)
    // 技巧：使用 { once: true } 确保只能点一次
    const openHandler = () => {
        // 播放开箱动画
        boxContainer.classList.add('open');
        
        // 播放音效 (可选)
        // const audio = new Audio('sounds/open-box.mp3'); audio.play();

        // 延迟显示结果卡片 (配合CSS动画时间)
        setTimeout(() => {
            overlay.classList.add('revealed');
        }, 600);
    };
    
    // 先移除旧监听器再添加新监听器，防止重复绑定
    boxContainer.removeEventListener('click', boxContainer._openHandler);
    boxContainer._openHandler = openHandler; // 挂载到元素上以便移除
    boxContainer.addEventListener('click', openHandler);

    // 5. 绑定“收下礼物”按钮
    acceptBtn.onclick = () => {
        // 关闭弹窗
        overlay.classList.remove('visible');
        overlay.classList.remove('revealed');
        boxContainer.classList.remove('open'); // 恢复盒子状态
        
        // 可以在这里触发一些庆祝特效，或者仅仅是关闭
        if (typeof showDynamicIsland === 'function') {
            showDynamicIsland('已收入囊中', 'success');
        }
    };
}

/**
 * 【核心修复】角色售卖/赠送逻辑：精准区分外卖与购物
 */
export async function createAiPackageMessage(chatId, data, speakerName, avatarSrc, groupRole) {
    const turnsText = `${data.turns} 轮对话后`;
    const finalTotal = data.items.reduce((sum, i) => sum + i.price, 0);
    let payMethodStr = '角色已支付';
    if (data.use_vault) {
        try {
            const { spendLookyVault } = await import('./looky-pay.js');
             // ▼▼▼ 在这里把商品名称列表作为 memo 传进去 ▼▼▼
            const itemNames = data.items.map(item => item.name).join(', ');
            await spendLookyVault(chatId, finalTotal, { source: 'vault_shop_ai', reason: '购买商品', memo: itemNames, insertChatContext: false });
            payMethodStr = '共同小金库';
        } catch (e) { console.warn('金库余额不足，降级私房钱'); }
    }
    const baseMsg = { 
        chatId, 
        timestamp: new Date(), 
        type: 'received', 
        recalled: false, 
        isAiGift: true,
        speakerName: speakerName, 
        groupRole: groupRole, 
        avatarSrc: avatarSrc 
    };
    if (data.mode === 'food') {
        // --- 1. 外卖模式：强制使用纸质长小票 ---
        Object.assign(baseMsg, {
            contentType: 'receipt',
            text: '[外卖订单]',
            receiptInfo: { items: data.items, total: finalTotal, payMethod: payMethodStr, discounts: [] }
            // 注意：不传 deliveryInfo.address，这样 bubble 渲染逻辑会自动判定为纸质小票
        });
    } else {
        // --- 2. 购物模式：根据数量分流 ---
        if (data.items.length === 1) {
            // 单件商品 -> 物流卡 (logistics-card)
            Object.assign(baseMsg, {
                contentType: 'logistics_card',
                text: '[物流订单]',
                content: { title: data.items[0].name, img: data.imgUrl, specs: data.items[0].specs, deliveryTime: turnsText, address: '默认地址', phone: '138****8888' }
            });
        } else {
            // 多件商品 -> 3D 购物小票 (receipt-card-3d)
            Object.assign(baseMsg, {
                contentType: 'receipt',
                text: '[购物清单]',
                receiptInfo: { items: data.items, total: finalTotal, payMethod: payMethodStr, discounts: [], deliveryInfo: { address: '你的默认地址', time: turnsText, phone: '138****8888' } }
            });
        }
    }
    const messageId = await db.chatMessages.add(baseMsg);
    // 注册配送监听（保持原有动画逻辑）
    if (!tempState.activeGifts) tempState.activeGifts = {};
    if (!tempState.activeGifts[chatId]) tempState.activeGifts[chatId] = [];
    tempState.activeGifts[chatId].push({
        msgId: messageId, remaining: data.turns, status: 'delivering',
        title: data.items.length > 1 ? (data.mode === 'food' ? '一份美味' : '惊喜包裹') : data.items[0].name,
        img: data.imgUrl, isFromAiPay: true
    });
    localStorage.setItem('active_gifts_state', JSON.stringify(tempState.activeGifts));

    if (String(chatId) === String(tempState.currentChatId)) {
        await createAndAppendMessage(await db.chatMessages.get(messageId));
    }
}
// ▼▼▼ 【高性能版】查询并渲染历史心声的专属函数 ▼▼▼
async function showThoughtsHistoryModal() {
    const modal = document.getElementById('thoughts-history-modal-overlay');
    const listContainer = document.getElementById('thoughts-history-list');
    const closeBtn = document.getElementById('close-thoughts-history-btn');
    
    if (!modal || !listContainer) return;

    // 展现加载状态
    listContainer.innerHTML = '<div style="text-align:center; color:#999; padding:20px;">正在翻阅记忆...</div>';
    modal.classList.add('visible');

    try {
        const thoughtsSet = new Set();
        const thoughtsList = [];
        // 【性能锁】最多只提取最近的50条独立心声，避免DOM过载导致滑动卡顿
        const MAX_THOUGHTS = 50; 
        
        // 提取性别，用于过滤油腻词
        const user = getCurrentChatIdentity();
        const isMale = user && ((user.persona && user.persona.includes('男')) || (user.name && user.name.match(/先生|哥|男/)));
        const pronoun = isMale ? '他' : '她';

        // 【核心优化1】使用流式遍历(each)与中断(until)，绝不使用 toArray() 加载全表
        // 它会从最新消息开始往上翻，只要凑够50条心声就立刻停止数据库读取，哪怕你有十万条数据也瞬间完成。
        await db.chatMessages
            .where({ chatId: tempState.currentChatId })
            .reverse()
            .until(() => thoughtsList.length >= MAX_THOUGHTS) 
            .each(msg => {
                // 只提取收到的消息且有心声的内容，过滤掉相同心声
                if (msg.type === 'received' && msg.innerThoughts && !thoughtsSet.has(msg.innerThoughts)) {
                    thoughtsSet.add(msg.innerThoughts);
                    
                    let cleanThought = msg.innerThoughts.replace(/这丫头|这小孩|这小丫头|小丫头|那丫头/g, pronoun);
                    cleanThought = cleanThought.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                    
                    thoughtsList.push({
                        text: cleanThought,
                        time: new Date(msg.timestamp).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute:'2-digit' })
                    });
                }
            });

        // 【核心优化2】使用 DocumentFragment 虚拟节点一次性渲染
        // 避免在循环中不断操作真实DOM导致手机掉帧卡顿
        const fragment = document.createDocumentFragment();
        
        if (thoughtsList.length === 0) {
            const emptyDiv = document.createElement('div');
            emptyDiv.style.cssText = 'text-align:center; color:#999; padding:40px 20px;';
            emptyDiv.textContent = '你们还没有触发过心声哦~';
            fragment.appendChild(emptyDiv);
        } else {
            thoughtsList.forEach(t => {
                const card = document.createElement('div');
                // 加入 flex-shrink: 0 配合之前 css 中的 min-height 保证不被压缩
                card.style.cssText = 'background: #fff; padding: 15px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.04); border: 1px solid #f2f2f2; flex-shrink: 0;';
                card.innerHTML = `
                    <div style="font-size: 11px; color: #ccc; margin-bottom: 6px;">${t.time}</div>
                    <div style="font-size: 14px; color: #2c2c2c; line-height: 1.7; font-family: 'Songti SC', 'Noto Serif SC', serif;">
                        ${t.text}
                    </div>
                `;
                fragment.appendChild(card);
            });
            
            // 触及性能锁时给用户一个温柔的提示
            if (thoughtsList.length >= MAX_THOUGHTS) {
                const hintDiv = document.createElement('div');
                hintDiv.style.cssText = 'text-align:center; color:#ccc; font-size:12px; padding:10px 0; flex-shrink: 0;';
                hintDiv.textContent = '— 仅展示最近的50条心声以节省性能 —';
                fragment.appendChild(hintDiv);
            }
        }

        // 清空占位符并一次性挂载所有卡片
        listContainer.innerHTML = '';
        listContainer.appendChild(fragment);

    } catch (e) {
        console.error("加载心声失败：", e);
        listContainer.innerHTML = '<div style="text-align:center; color:#ff3b30; padding:20px;">加载失败，请重试</div>';
    }

    const closeModal = () => modal.classList.remove('visible');
    closeBtn.onclick = closeModal;
    modal.onclick = (e) => { if(e.target === modal) closeModal(); };
}
// ▲▲▲ 新增结束 ▲▲▲
// ▼▼▼ 【新增】获取并渲染今日日程的高性能函数 ▼▼▼
async function loadAndRenderChatSchedule(charId) {
    const container = document.getElementById('chat-schedule-list-container');
    if (!container) return;
    container.innerHTML = '<div style="text-align: center; color: #999; font-size: 13px; padding: 20px;">正在获取日程...</div>';
    
    try {
        // 从底层拉取我们在 life-sync 里存好的那份干干净净的数据表
        const record = await db.appData.get('ls_schedules_data_' + charId);
        const todayStr = new Date().getDate().toString();
        
        let schedules = [];
        if (record && record.value) {
            // 只留下是今天的、并且是Ta自己或者双人的行程 (过滤掉纯我自己的单人行程)
            schedules = record.value.filter(s => s.date === todayStr && s.owner !== 'mine');
        }
        
        if (schedules.length === 0) {
            container.innerHTML = '<div style="text-align: center; color: #A3958F; font-size: 13px; padding: 40px 20px;">Ta 今天没有安排日程哦~</div>';
            return;
        }
        
        // 按照时间从早到晚进行排序
        schedules.sort((a, b) => a.startTime.localeCompare(b.startTime));
        
        const now = new Date();
        const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
        
        let html = '';
        schedules.forEach(sched => {
            // 根据系统真实时间，智能判断这行程是不是过期了
            let statusBg = '#FFF';
            let opacity = '1';
            let activeDot = '';
            
            if (sched.endTime < currentTime) {
                opacity = '0.6'; // 已经过去的行程变灰
            } else if (sched.startTime <= currentTime && sched.endTime >= currentTime) {
                statusBg = '#F2EAE4'; // 正在进行的行程卡片变暖色
                activeDot = '<span style="display:inline-block; width:6px; height:6px; background:#D3A7A5; border-radius:50%; margin-left:6px; animation: ls-pulse 2s infinite;"></span>';
            }
            
            // 组装精美的卡片
            const locText = sched.locName ? `<span style="font-size: 10px; background: #EBE4DD; color: #5C544D; padding: 2px 6px; border-radius: 4px; font-weight: bold; margin-right: 6px;">📍${sched.locName}</span>` : '';
            const typeText = `<span style="font-size: 10px; background: #E4EFE7; color: #9CB4A1; padding: 2px 6px; border-radius: 4px; font-weight: bold; margin-right: 6px;">${sched.type || '日程'}</span>`;

            html += `
                <div style="display: flex; gap: 12px; opacity: ${opacity}; background: ${statusBg}; padding: 15px; border-radius: 16px; border: 1px solid #EBE4DD; box-shadow: 0 2px 8px rgba(163, 149, 143, 0.05); transition: 0.2s;">
                    <div style="display: flex; flex-direction: column; align-items: center; width: 45px; flex-shrink: 0; padding-top: 2px;">
                        <span style="font-size: 15px; font-weight: 800; color: #6E5C53; font-family: monospace;">${sched.startTime}</span>
                        <span style="font-size: 10px; color: #A3958F; margin-top: 2px;">至 ${sched.endTime}</span>
                    </div>
                    <div style="width: 2px; background: #EBE4DD; border-radius: 2px; position: relative;"></div>
                    <div style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
                        <div style="display: flex; align-items: center; margin-bottom: 6px;">
                            ${typeText}${locText}
                        </div>
                        <div style="font-size: 14px; color: #5C544D; line-height: 1.5; font-weight: 500;">
                            ${sched.content}${activeDot}
                        </div>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
    } catch (err) {
        console.error("提取日程失败", err);
        container.innerHTML = '<div style="text-align: center; color: #E28F8F; font-size: 13px; padding: 20px;">数据读取失败</div>';
    }
}
// ▼▼▼ 【优化版】调度拉起弹窗 (解决卡顿问题) ▼▼▼
async function showChatScheduleModal() {
    const modal = document.getElementById('chat-schedule-modal-overlay');
    if (!modal) return;
    
    const charId = tempState.currentChatId;
    const char = AppState.characterProfiles.find(c => c.id === charId);
    if (!char) return;

    // 【优化 1】先让界面立刻呈现加载状态，不要等数据
    const container = document.getElementById('chat-schedule-list-container');
    if (container) container.innerHTML = '<div style="text-align: center; color: #999; font-size: 13px; padding: 40px 20px;">正在查阅日程...</div>';
    
    // 【优化 2】立刻执行弹窗的淡入动画，保证点击瞬间极度丝滑
    modal.style.display = 'flex';
    requestAnimationFrame(() => {
        modal.style.opacity = '1';
    });
    
    // 【优化 3】把费性能的数据库查询和 DOM 渲染，推迟到动画跑完之后 (150毫秒后) 执行
    setTimeout(() => {
        const selectContainer = document.getElementById('chat-schedule-char-select-container');
        const selectEl = document.getElementById('chat-schedule-char-select');
        
        if (char.isGroup) {
            // 群聊模式：显示角色切换下拉框
            selectContainer.style.display = 'block';
            selectEl.innerHTML = '';
            
            const members = (char.memberIds || []).map(findCharacterById).filter(Boolean);
            members.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = m.name;
                selectEl.appendChild(opt);
            });
            
            // 绑定下拉框切换事件 (切换时为了顺滑，也可以加个小延迟，但直接拉取也很快)
            selectEl.onchange = () => { loadAndRenderChatSchedule(selectEl.value); };
            
            if (members.length > 0) {
                loadAndRenderChatSchedule(members[0].id);
            } else {
                if(container) container.innerHTML = '<div style="text-align: center; color: #A3958F; padding: 20px;">群里没有成员</div>';
            }
        } else {
            // 单聊模式：直接加载，隐藏下拉框
            selectContainer.style.display = 'none';
            loadAndRenderChatSchedule(charId);
        }
    }, 150); // <--- 就是这个神奇的 150ms 错峰执行，解决了卡顿
    
    // 绑定关闭事件
    const closeBtn = document.getElementById('close-chat-schedule-btn');
    closeBtn.onclick = () => {
        modal.style.opacity = '0';
        setTimeout(() => modal.style.display = 'none', 300);
    };
    modal.onclick = (e) => {
        if(e.target === modal) closeBtn.onclick();
    }
}
