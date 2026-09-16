import { AppState, DEFAULT_AVATAR_SRC, db, tempState } from '../state.js';
import { addTapListener, escapeHTML, cleanVisibleMessageText } from '../utils.js';
import { showPage, showDynamicIsland } from '../ui.js';
import { generateVirtualPhoneData, generateVirtualMemoData, generateVirtualShopData, generateVirtualBrowserData, generateVirtualBrowserDetailPage, generateVirtualWalletData, generateVirtualScreenTimeData, generateVirtualCgtData, generateVirtualPhoneAllPagesData, normalizeVirtualMemoDates, generateVirtualNpcChatIntervention, generatePhoneOwnerTakeover, syncVirtualPhoneUserContact } from './chat-service.js';
import { ensureCharacterPhoneWallet, requestCharacterPhonePayment } from './looky-pay.js';
import { notification, showChatMessageNotification } from './notification.js';
// 【新增】在本地生成极其纯净的苹果原生风格首字母头像 (经典中性灰底 + 白字)
function getAppleStyleAvatar(name) {
    const canvas = document.createElement('canvas');
    canvas.width = 120; canvas.height = 120;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#9CA3AF'; // 极简的高级中性灰
    ctx.fillRect(0, 0, 120, 120);
    ctx.fillStyle = '#FFFFFF'; // 纯白文字
    ctx.font = '500 56px -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const initial = name ? name.charAt(0).toUpperCase() : '?';
    ctx.fillText(initial, 60, 64); // 居中微调
    return canvas.toDataURL('image/png');
}
export let currentActivePhoneChar = null;
const CHECK_PHONE_ALL_GENERATE_TYPES = ['chat', 'memo', 'shop', 'browser', 'wallet', 'screentime', 'cgt'];
const PHONE_NPC_CHAT_CARD_TYPE = 'phone_npc_chat_card';
const PHONE_NPC_DISCOVERY_MIN_TURN = 4;
const PHONE_NPC_DISCOVERY_MAX_TURN = 6;
const PHONE_USER_DISCOVERY_MIN_COUNT = 4;
const PHONE_USER_DISCOVERY_MAX_COUNT = 6;
const PHONE_NPC_REVEAL_MIN_TURN = 3;
const PHONE_NPC_REVEAL_MAX_TURN = 5;
const PHONE_NPC_PASSWORD_REVEAL_MIN_TURN = 2;
const PHONE_NPC_PASSWORD_REVEAL_MAX_TURN = 4;
const PHONE_NPC_DISCOVERY_DEFAULT_PROBABILITY = 0.55;
const PHONE_NPC_DISCOVERY_PASSWORD_PROBABILITY = 0.85;
const PHONE_NPC_FINALIZE_STEALTH = 'stealth';
const PHONE_NPC_FINALIZE_DISCOVER_NOW = 'discover_now';
const PHONE_NPC_FINALIZE_SKIP_MAIN = 'skip_main';
const PHONE_NPC_FINALIZE_CONTINUE_LATER = 'continue_later';
let currentPhoneNpcConversationContext = null;
let phoneNpcBackInProgress = false;
let phoneUserUnlockTimer = null;
let phoneUserCountdownTimer = null;

function getRandomIntInclusive(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function waitPhoneNpcAnimation(ms, signal = null) {
    return new Promise(resolve => {
        if (signal?.aborted) {
            resolve(false);
            return;
        }
        const timer = setTimeout(() => resolve(true), ms);
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                resolve(false);
            }, { once: true });
        }
    });
}

async function stopPhoneNpcGenerationForExit() {
    const abortController = tempState.phoneNpcAbortController;
    if (!abortController) return true;
    abortController.abort();
    const deadline = Date.now() + 1500;
    while (tempState.phoneNpcAbortController === abortController && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    return tempState.phoneNpcAbortController !== abortController;
}

function getPhoneNpcMessageDelay() {
    return getRandomIntInclusive(2000, 4000);
}

function isPhoneRealUserContact(contact, ownerChar) {
    if (contact?.isRealUserContact === true) return true;
    const identityId = ownerChar?.chatIdentityId || AppState.currentIdentityId;
    const currentUser = AppState.userIdentities.find(identity => identity.id === identityId) || AppState.userIdentities[0];
    return contact?.relation === '特别关心' && !!currentUser?.name && contact.name === currentUser.name;
}

function getPhoneNpcResolveTurn(contact, key = 'userHijackTargetTurns') {
    const savedTurn = Number(contact[key] || 0);
    if (savedTurn >= PHONE_NPC_DISCOVERY_MIN_TURN && savedTurn <= PHONE_NPC_DISCOVERY_MAX_TURN) {
        return savedTurn;
    }
    const nextTurn = getRandomIntInclusive(PHONE_NPC_DISCOVERY_MIN_TURN, PHONE_NPC_DISCOVERY_MAX_TURN);
    contact[key] = nextTurn;
    return nextTurn;
}

function resetPhoneNpcResolveTurn(contact, key = 'userHijackTargetTurns') {
    delete contact[key];
}

function getPhoneUserDiscoveryTargetCount(contact) {
    const savedCount = Number(contact.phoneUserDiscoveryTargetCount || contact.phoneUserHijackTargetTurns || 0);
    if (savedCount >= PHONE_USER_DISCOVERY_MIN_COUNT && savedCount <= PHONE_USER_DISCOVERY_MAX_COUNT) {
        return savedCount;
    }
    const nextCount = getRandomIntInclusive(PHONE_USER_DISCOVERY_MIN_COUNT, PHONE_USER_DISCOVERY_MAX_COUNT);
    contact.phoneUserDiscoveryTargetCount = nextCount;
    return nextCount;
}

function resetPhoneUserDiscoveryTargetCount(contact) {
    delete contact.phoneUserDiscoveryTargetCount;
    delete contact.phoneUserHijackTargetTurns;
}

function getPhoneOwnerLockMinutes(result) {
    const rawValue = result?.lockMinutes;
    if (rawValue === undefined || rawValue === null || rawValue === '') return 5;
    const minutes = Number(rawValue);
    if (!Number.isFinite(minutes)) return 5;
    return Math.max(0, Math.min(30, Math.round(minutes)));
}

async function hasRecentPhonePasswordAccess(charId) {
    if (!charId) return false;
    const recentMsgs = await db.chatMessages
        .where('chatId')
        .equals(charId)
        .reverse()
        .limit(50)
        .toArray();
    return recentMsgs.some(msg => msg?.contentType === 'share_password');
}

function hidePhoneNpcActionPopover() {
    const oldPopover = document.getElementById('cp-npc-action-popover');
    if (oldPopover) oldPopover.remove();
}

function getPhoneNpcFinalizeModal() {
    const modal = document.getElementById('cp-npc-finalize-modal');
    if (modal && modal.parentElement !== document.body) {
        document.body.appendChild(modal);
    }
    return modal;
}

function showPhoneNpcFinalizeChoice(options = {}) {
    const modal = getPhoneNpcFinalizeModal();
    if (!modal) return Promise.resolve(PHONE_NPC_FINALIZE_STEALTH);
    const continueBtn = modal.querySelector(`[data-cp-npc-finalize-choice="${PHONE_NPC_FINALIZE_CONTINUE_LATER}"]`);
    if (continueBtn) continueBtn.hidden = !options.allowContinue;
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('active'));
    return new Promise(resolve => {
        const buttons = Array.from(modal.querySelectorAll('[data-cp-npc-finalize-choice]')).filter(btn => !btn.hidden);
        const cleanup = (choice) => {
            buttons.forEach(btn => btn.removeEventListener('click', onClick));
            modal.classList.remove('active');
            setTimeout(() => {
                modal.style.display = 'none';
            }, 180);
            resolve(choice || PHONE_NPC_FINALIZE_STEALTH);
        };
        const onClick = (event) => {
            const btn = event.currentTarget;
            cleanup(btn.dataset.cpNpcFinalizeChoice);
        };
        buttons.forEach(btn => btn.addEventListener('click', onClick, { once: true }));
    });
}

function getPhoneNpcStolenTurnCount(contact) {
    let turns = 0;
    let insideUserTurn = false;
    (contact.chatHistory || []).forEach(msg => {
        if (msg?.userHijack && !msg.pendingNpcReply) {
            if (!insideUserTurn) turns++;
            insideUserTurn = true;
        } else if (!msg?.pendingNpcReply) {
            insideUserTurn = false;
        }
    });
    return turns;
}

function normalizePhoneNpcMessageItem(item, isMeFallback = false) {
    if (typeof item === 'string') {
        return { isMe: isMeFallback, text: item, translation: '' };
    }
    if (!item || typeof item !== 'object') {
        return { isMe: isMeFallback, text: '', translation: '' };
    }
    const speaker = String(item.speaker || item.role || '').toLowerCase();
    const isMe = typeof item.isMe === 'boolean'
        ? item.isMe
        : (/npc|contact|friend/.test(speaker) ? false : (/owner|character|char|self/.test(speaker) ? true : isMeFallback));
    return {
        isMe,
        text: item.text || item.content || '',
        translation: item.translation || '',
        takeover: !!item.takeover,
        stickerUrl: item.stickerUrl || '',
        contentType: item.contentType || '',
        content: item.content || null,
        transferInfo: item.transferInfo || null
    };
}

function isLeakedPhoneNpcPromptSummary(text = '') {
    const raw = String(text || '').trim();
    return raw.startsWith('[查手机NPC聊天记录｜')
        || raw.startsWith('[查手机记录卡]')
        || raw.includes('这是你已知晓的手机记录')
        || raw.includes('- 最近记录:');
}

async function cleanupLeakedPhoneNpcPromptSummaries() {
    const leaked = await db.chatMessages
        .orderBy('id')
        .reverse()
        .limit(300)
        .filter(msg => msg && msg.contentType !== PHONE_NPC_CHAT_CARD_TYPE && msg.uiVisible !== false && isLeakedPhoneNpcPromptSummary(msg.text))
        .toArray();
    if (!leaked.length) return;
    await Promise.all(leaked.map(msg => db.chatMessages.update(msg.id, { uiVisible: false, aiVisible: false })));
    if (Array.isArray(AppState.currentChatHistory)) {
        AppState.currentChatHistory = AppState.currentChatHistory.filter(msg => !leaked.some(item => item.id === msg.id));
    }
}

function setPhoneNpcTypingTitle(contact, isTyping) {
    const detailNameEl = document.querySelector('.cp-detail-name');
    if (!detailNameEl || !contact) return;
    detailNameEl.textContent = isTyping ? '对方正在输入中' : contact.name;
}

async function clearPhoneNpcMainChatRecord(contact, ownerChar) {
    if (!contact || !ownerChar) return;
    const idsToDelete = new Set();
    const savedCardId = Number(contact.phoneNpcMainChatCardId || 0);
    if (savedCardId) {
        idsToDelete.add(savedCardId);
    } else {
        const latestCard = await db.chatMessages
            .where('chatId')
            .equals(ownerChar.id)
            .reverse()
            .limit(80)
            .filter(msg => msg.contentType === PHONE_NPC_CHAT_CARD_TYPE && msg.phoneNpcChatData?.npcName === contact.name)
            .first();
        if (latestCard?.id) idsToDelete.add(latestCard.id);
    }
    if (idsToDelete.size > 0) {
        const mainMsgs = await db.chatMessages.bulkGet(Array.from(idsToDelete));
        mainMsgs.forEach(msg => {
            if (Array.isArray(msg?.linkedMsgIds)) {
                msg.linkedMsgIds.forEach(id => idsToDelete.add(Number(id)));
            }
        });
        const finalIds = Array.from(idsToDelete).filter(id => !Number.isNaN(Number(id)));
        await db.chatMessages.bulkDelete(finalIds);
        if (Array.isArray(AppState.currentChatHistory)) {
            AppState.currentChatHistory = AppState.currentChatHistory.filter(msg => !finalIds.includes(Number(msg.id)));
        }
    }
    delete contact.phoneNpcMainChatCardId;
}

function isPhoneUserControlMessage(message) {
    return message?.phoneHijack === true || message?.contentType === 'phone_user_takeover_message';
}

function buildPhoneMessageActionContext(contact, messageIndex, phoneData, ownerChar, avatarUrl) {
    const message = contact?.chatHistory?.[messageIndex];
    const isDirectUserContact = isPhoneRealUserContact(contact, ownerChar);
    if (isDirectUserContact && !isPhoneUserControlMessage(message)) return null;
    return { contact, messageIndex, phoneData, ownerChar, avatarUrl, isDirectUserContact };
}

async function removePhoneMessageFromMainChat(ownerChar, phoneMessage) {
    if (!ownerChar || !isPhoneUserControlMessage(phoneMessage)) return;
    let messageId = Number(phoneMessage.mainChatMessageId || 0);
    let mainMessage = messageId ? await db.chatMessages.get(messageId) : null;

    // 兼容旧数据：旧版本还没有保存 mainChatMessageId，只在 character_phone 范围内找同一条消息。
    if (!mainMessage || mainMessage.source !== 'character_phone') {
        const candidates = await db.chatMessages
            .where('chatId')
            .equals(ownerChar.id)
            .reverse()
            .limit(200)
            .filter(message => message?.source === 'character_phone'
                && (!phoneMessage.phoneSessionId || message.phoneSessionId === phoneMessage.phoneSessionId)
                && message.contentType === (phoneMessage.contentType === 'text' ? 'phone_user_hijack_message' : phoneMessage.contentType)
                && String(message.text || '') === String(phoneMessage.text || ''))
            .toArray();
        mainMessage = candidates[0] || null;
        messageId = Number(mainMessage?.id || 0);
    }

    if (!mainMessage || !messageId || mainMessage.source !== 'character_phone') return;
    await db.chatMessages.delete(messageId);
    if (Array.isArray(AppState.currentChatHistory)) {
        AppState.currentChatHistory = AppState.currentChatHistory.filter(message => Number(message.id) !== messageId);
    }
    document.querySelectorAll(`#chat-message-list [data-message-id="${messageId}"], #voice-call-message-list [data-message-id="${messageId}"]`).forEach(element => element.remove());
}

async function regeneratePhoneUserTakeoverResponse(contact, messageIndex, phoneData, ownerChar, avatarUrl) {
    const history = Array.isArray(contact?.chatHistory) ? contact.chatHistory : [];
    const selectedMessage = history[messageIndex];
    if (!selectedMessage || selectedMessage.contentType !== 'phone_user_takeover_message') {
        showDynamicIsland('这条消息没有可重回的角色回复');
        return;
    }

    const takeoverStart = history.findIndex(message => message?.contentType === 'phone_user_takeover_message');
    const triggerIndex = takeoverStart >= 0
        ? history.slice(0, takeoverStart).map((message, index) => ({ message, index })).reverse().find(item => item.message?.phoneHijack)?.index
        : -1;
    if (takeoverStart < 0 || triggerIndex == null || triggerIndex < 0) {
        showDynamicIsland('找不到触发接管的手机操作');
        return;
    }

    const historyBeforeTakeover = history.slice(0, takeoverStart);
    const triggerText = history[triggerIndex]?.text || '[media]';
    const result = await generatePhoneOwnerTakeover(ownerChar.id, historyBeforeTakeover, triggerText);
    const takeoverMessages = result?.messages?.length
        ? result.messages
        : [{ text: '我发现了', translation: '' }, { text: '先别再动我的手机', translation: '' }];

    for (const oldMessage of history.slice(takeoverStart)) {
        await removePhoneMessageFromMainChat(ownerChar, oldMessage);
    }
    contact.chatHistory = historyBeforeTakeover;
    hidePhoneNpcActionPopover();
    renderPhoneNpcConversation(contact, avatarUrl, phoneData, ownerChar);

    const detailMessagesEl = document.querySelector('.cp-detail-messages');
    const phoneSessionId = contact.phoneUserSessionId || (contact.phoneUserSessionId = `phone_${ownerChar.id}_${Date.now()}`);
    for (const item of takeoverMessages) {
        const ownerText = String(item?.text || '').trim();
        if (!ownerText) continue;
        const phoneMessage = {
            isMe: true,
            text: ownerText,
            translation: item.translation || '',
            takeover: true,
            actor: 'character',
            contentType: 'phone_user_takeover_message',
            phoneHijack: false,
            phoneSessionId
        };
        const savedMessage = await syncPhoneUserMainMessage(ownerChar, {
            contentType: phoneMessage.contentType,
            text: ownerText,
            translation: phoneMessage.translation,
            phoneSessionId
        });
        phoneMessage.mainChatMessageId = savedMessage?.id || null;
        phoneMessage.timestamp = savedMessage?.timestamp || new Date();
        contact.chatHistory.push(phoneMessage);
        const takeoverActionContext = buildPhoneMessageActionContext(contact, contact.chatHistory.length - 1, phoneData, ownerChar, avatarUrl);
        if (detailMessagesEl) appendPhoneNpcMessage(detailMessagesEl, ownerText, true, avatarUrl, 'takeover', takeoverActionContext, phoneMessage.translation, phoneMessage);
    }
    await db.appData.put({ key: `virtual_phone_data_${ownerChar.id}`, value: phoneData });
    renderPhoneNpcConversation(contact, avatarUrl, phoneData, ownerChar);
}

async function regeneratePhoneNpcCurrentResponse(contact, messageIndex, phoneData, ownerChar, avatarUrl) {
    if (!contact || !Array.isArray(contact.chatHistory) || !ownerChar || !phoneData) return;
    if (isPhoneRealUserContact(contact, ownerChar)) return;
    const wasEnded = !!contact.npcChatEnded || !!contact.phoneNpcMainChatCardId;
    const history = contact.chatHistory;
    let userStart = messageIndex;

    if (!history[userStart]?.userHijack) {
        userStart = -1;
        for (let i = messageIndex; i >= 0; i--) {
            if (history[i]?.userHijack) {
                userStart = i;
                break;
            }
        }
    }
    if (userStart < 0) {
        showDynamicIsland('这条前面没有可重生成的用户消息');
        return;
    }

    while (userStart > 0 && history[userStart - 1]?.userHijack) userStart--;
    let userEnd = userStart;
    while (userEnd < history.length && history[userEnd]?.userHijack) userEnd++;

    await clearPhoneNpcMainChatRecord(contact, ownerChar);
    contact.chatHistory = history.slice(0, userEnd).map((msg, index) => {
        if (index >= userStart && msg?.userHijack) {
            return { ...msg, pendingNpcReply: true, aiHandled: false };
        }
        return msg;
    });
    contact.userHijackTurns = getPhoneNpcStolenTurnCount(contact);
    delete contact.npcChatEnded;
    if (wasEnded) {
        contact.userHijackTargetTurns = Number(contact.userHijackTurns || 0) + 1;
    } else {
        resetPhoneNpcResolveTurn(contact);
    }

    hidePhoneNpcActionPopover();
    renderPhoneNpcConversation(contact, avatarUrl, phoneData, ownerChar);
    await db.appData.put({ key: `virtual_phone_data_${ownerChar.id}`, value: phoneData });
    await handlePhoneNpcSend(ownerChar, contact, phoneData, avatarUrl);
}

function setPhoneNpcEndedUi(inputEl, sendBtn) {
    if (inputEl) {
        inputEl.value = '';
        inputEl.disabled = true;
        inputEl.placeholder = '本段查岗已结束';
    }
    if (sendBtn) {
        sendBtn.disabled = true;
        sendBtn.classList.remove('is-cancel');
        sendBtn.title = '';
    }
}

function isPhoneUserControlLocked(contact) {
    if (!contact?.phoneUserControlEnded) return false;
    const lockedUntil = Number(contact.phoneUserControlLockedUntil || 0);
    if (lockedUntil > 0 && lockedUntil <= Date.now()) {
        contact.phoneUserControlEnded = false;
        contact.phoneUserControlResolving = false;
        delete contact.phoneUserControlLockedUntil;
        clearInterval(phoneUserCountdownTimer);
        phoneUserCountdownTimer = null;
        return false;
    }
    return true;
}

function clearPhoneUserLockTimers() {
    clearTimeout(phoneUserUnlockTimer);
    clearInterval(phoneUserCountdownTimer);
    phoneUserUnlockTimer = null;
    phoneUserCountdownTimer = null;
}

function updatePhoneUserLockCountdown(contact) {
    const countdownEl = document.querySelector('.cp-npc-end-notice .cp-phone-lock-countdown');
    if (!countdownEl || currentPhoneNpcConversationContext?.contact !== contact) return;
    const remainingMs = Number(contact?.phoneUserControlLockedUntil || 0) - Date.now();
    if (remainingMs <= 0) {
        countdownEl.textContent = '正在解锁...';
        return;
    }
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const countdownText = `手机锁定中 ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    countdownEl.textContent = countdownText;
    const inputEl = document.getElementById('cp-npc-chat-input');
    if (inputEl?.disabled) inputEl.placeholder = countdownText;
}

function schedulePhoneUserUnlock(contact, ownerChar, phoneData, avatarUrl) {
    clearPhoneUserLockTimers();
    const lockedUntil = Number(contact?.phoneUserControlLockedUntil || 0);
    if (!lockedUntil || lockedUntil <= Date.now()) return;
    updatePhoneUserLockCountdown(contact);
    phoneUserCountdownTimer = setInterval(() => {
        if (!isPhoneUserControlLocked(contact)) {
            clearPhoneUserLockTimers();
            return;
        }
        updatePhoneUserLockCountdown(contact);
    }, 1000);
    phoneUserUnlockTimer = setTimeout(async () => {
        const wasLocked = isPhoneUserControlLocked(contact);
        if (wasLocked) {
            schedulePhoneUserUnlock(contact, ownerChar, phoneData, avatarUrl);
            return;
        }
        clearPhoneUserLockTimers();
        await db.appData.put({ key: `virtual_phone_data_${ownerChar.id}`, value: phoneData });
        if (String(currentActivePhoneChar?.id) === String(ownerChar.id) && currentPhoneNpcConversationContext?.contact === contact) {
            renderPhoneNpcConversation(contact, avatarUrl, phoneData, ownerChar);
            showDynamicIsland('角色手机已自动解锁', 'success');
        }
    }, lockedUntil - Date.now() + 50);
}

async function forceUnlockPhoneUserControl(contact, ownerChar, phoneData, avatarUrl) {
    clearPhoneUserLockTimers();
    contact.phoneUserControlEnded = false;
    contact.phoneUserControlResolving = false;
    delete contact.phoneUserControlLockedUntil;
    await db.appData.put({ key: `virtual_phone_data_${ownerChar.id}`, value: phoneData });
    showDynamicIsland('已强制解除角色手机锁定', 'success');
    renderPhoneNpcConversation(contact, avatarUrl, phoneData, ownerChar);
}

function appendPhoneNpcEndNotice(container, options = {}) {
    if (!container || container.querySelector('.cp-npc-end-notice')) return;
    const notice = document.createElement('div');
    notice.className = 'cp-npc-end-notice';
    const isDirectLocked = options.contact && isPhoneRealUserContact(options.contact, options.ownerChar) && isPhoneUserControlLocked(options.contact);
    notice.innerHTML = isDirectLocked
        ? '<span>CHECK-IN CLOSED</span><span class="cp-phone-lock-countdown">手机锁定中</span><button type="button" class="cp-phone-force-unlock">强制解除</button>'
        : 'CHECK-IN CLOSED';
    if (isDirectLocked) {
        notice.querySelector('.cp-phone-force-unlock')?.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            await forceUnlockPhoneUserControl(options.contact, options.ownerChar, options.phoneData, options.avatarUrl);
        });
    }
    container.appendChild(notice);
    container.scrollTop = container.scrollHeight;
}

async function rerenderPhoneNpcMessages(contact, avatarUrl, phoneData, ownerChar) {
    const detailMessagesEl = document.querySelector('.cp-detail-messages');
    if (!detailMessagesEl) return;
    detailMessagesEl.innerHTML = '';
    (contact.chatHistory || []).forEach((msg, index) => {
        if (isPhoneSystemDisplayMessage(msg)) return;
        const actionContext = buildPhoneMessageActionContext(contact, index, phoneData, ownerChar, avatarUrl);
        appendPhoneNpcMessage(detailMessagesEl, msg.text, !!msg.isMe, avatarUrl, msg.takeover ? 'takeover' : '', actionContext, msg.translation, msg);
    });
    if ((isPhoneRealUserContact(contact, ownerChar) ? isPhoneUserControlLocked(contact) : contact.npcChatEnded)) {
        appendPhoneNpcEndNotice(detailMessagesEl, { contact, ownerChar, phoneData, avatarUrl });
    }
    await db.appData.put({ key: `virtual_phone_data_${ownerChar.id}`, value: phoneData });
}

function showPhoneNpcActionPopover(targetEl, actionContext) {
    hidePhoneNpcActionPopover();
    const { contact, messageIndex, phoneData, ownerChar, avatarUrl, isDirectUserContact } = actionContext || {};
    if (!contact || !Array.isArray(contact.chatHistory) || messageIndex < 0) return;
    const selectedMessage = contact.chatHistory[messageIndex];
    if (isDirectUserContact && !isPhoneUserControlMessage(selectedMessage)) return;
    const canReenter = !isDirectUserContact || selectedMessage?.contentType === 'phone_user_takeover_message';

    const popover = document.createElement('div');
    popover.id = 'cp-npc-action-popover';
    popover.className = 'cp-npc-action-popover';
    popover.innerHTML = `
        ${canReenter ? '<button type="button" data-action="reenter">重回</button>' : ''}
        <button type="button" data-action="delete">删除</button>
    `;
    (document.getElementById('page-character-phone') || document.body).appendChild(popover);

    const rect = targetEl.getBoundingClientRect();
    const phoneScreen = document.querySelector('#flj8W .phone-screen');
    const phoneScreenRect = phoneScreen?.getBoundingClientRect();
    const scaleX = phoneScreen && phoneScreen.offsetWidth ? phoneScreenRect.width / phoneScreen.offsetWidth : 1;
    const scaleY = phoneScreen && phoneScreen.offsetHeight ? phoneScreenRect.height / phoneScreen.offsetHeight : 1;
    const targetLeft = phoneScreenRect ? (rect.left - phoneScreenRect.left) / scaleX : rect.left;
    const targetTop = phoneScreenRect ? (rect.top - phoneScreenRect.top) / scaleY : rect.top;
    const targetWidth = phoneScreenRect ? rect.width / scaleX : rect.width;
    const popoverWidth = popover.offsetWidth || 130;
    const screenWidth = phoneScreen?.clientWidth || window.innerWidth;
    popover.style.left = `${Math.min(screenWidth - popoverWidth - 10, Math.max(10, targetLeft + targetWidth / 2 - popoverWidth / 2))}px`;
    const popoverHeight = popover.offsetHeight || 36;
    popover.style.top = `${Math.max(10, targetTop - popoverHeight - 2)}px`;

    const runPopoverAction = async (action, e) => {
        e.stopPropagation();
        e.preventDefault();
        if (action === 'delete') {
            if (isDirectUserContact) await removePhoneMessageFromMainChat(ownerChar, selectedMessage);
            contact.chatHistory.splice(messageIndex, 1);
            if (!isDirectUserContact) contact.userHijackTurns = Math.min(Number(contact.userHijackTurns || 0), getPhoneNpcStolenTurnCount(contact));
            hidePhoneNpcActionPopover();
            await rerenderPhoneNpcMessages(contact, avatarUrl, phoneData, ownerChar);
            showDynamicIsland(isDirectUserContact ? '已删除这条手机操作消息' : '已删除这条NPC聊天');
            return;
        }
        if (action === 'reenter') {
            if (isDirectUserContact) {
                await regeneratePhoneUserTakeoverResponse(contact, messageIndex, phoneData, ownerChar, avatarUrl);
            } else {
                await regeneratePhoneNpcCurrentResponse(contact, messageIndex, phoneData, ownerChar, avatarUrl);
            }
        }
    };
    popover.addEventListener('pointerdown', (e) => {
        const actionBtn = e.target.closest('button[data-action]');
        if (actionBtn) runPopoverAction(actionBtn.dataset.action, e);
        else e.stopPropagation();
    });
    popover.addEventListener('click', (e) => e.stopPropagation());

    setTimeout(() => {
        document.addEventListener('pointerdown', (e) => {
            if (!popover.contains(e.target)) hidePhoneNpcActionPopover();
        }, { once: true });
    }, 0);
}

function bindPhoneNpcMessageActions(msgDiv, actionContext) {
    if (!msgDiv || !actionContext) return;

    let pressTimer = null;
    let longPressTriggered = false;
    let startX = 0;
    let startY = 0;

    const clearPressTimer = () => {
        clearTimeout(pressTimer);
        pressTimer = null;
    };

    const suppressAfterLongPress = (event) => {
        if (!longPressTriggered) return;
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        longPressTriggered = false;
    };

    msgDiv.addEventListener('pointerdown', (event) => {
        if (!event.isPrimary || event.button > 0) return;
        clearPressTimer();
        longPressTriggered = false;
        startX = event.clientX;
        startY = event.clientY;
        pressTimer = setTimeout(() => {
            longPressTriggered = true;
            showPhoneNpcActionPopover(msgDiv, actionContext);
            if (navigator.vibrate) navigator.vibrate(50);
        }, 500);
    }, { passive: false });

    msgDiv.addEventListener('pointermove', (event) => {
        if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) {
            clearPressTimer();
        }
    }, { passive: true });

    msgDiv.addEventListener('pointerup', (event) => {
        clearPressTimer();
        if (longPressTriggered) {
            if (event.cancelable) event.preventDefault();
            event.stopPropagation();
        }
    }, { passive: false });
    msgDiv.addEventListener('pointercancel', clearPressTimer);
    msgDiv.addEventListener('touchend', suppressAfterLongPress, { capture: true, passive: false });
    msgDiv.addEventListener('click', suppressAfterLongPress, { capture: true });
}

function bindPhoneNpcTranslation(msgDiv) {
    const transBtn = msgDiv.querySelector('.cp-msg-translate-btn');
    const transEl = msgDiv.querySelector('.cp-msg-translation');
    if (!transBtn || !transEl) return;
    addTapListener(transBtn, (event) => {
        event.preventDefault();
        event.stopPropagation();
        transEl.classList.toggle('collapsed');
        transBtn.classList.toggle('active');
    });
}

function isPhoneSystemDisplayMessage(message = {}, text = '') {
    const rawText = String(text || message.text || message.content || '').trim();
    if (message.role === 'system' || message.type === 'system' || message.contentType === 'system_event' || message.uiVisible === false) return true;
    if (message.phoneHijack === true || message.contentType === 'phone_user_hijack_message' || message.contentType === 'phone_user_takeover_message') return false;
    return /^\s*\[(?:phone_hijack|phone_takeover|remote_app|系统提示|系统通知|系统日志|系统隐式提示|系统监控视界|查手机)/i.test(rawText)
        || /请不要输出这句话|根据你的人设与当前剧情|系统强制指令|不要输出(?:这句话|以下内容)|system\s+prompt/i.test(rawText);
}

function buildMemoInnerThought(memo = {}, index = 0) {
    const savedThought = memo.innerThought || memo.innerThoughts || memo.thought;
    if (savedThought) return savedThought;
    const sourceText = `${memo.title || ''} ${memo.content || ''}`;
    const templates = [
        '这条得记住，别又临时手忙脚乱',
        '写下来就算先把脑子腾出来一点',
        '等会儿看到这个应该会感谢现在的我',
        '不能再拖了，再拖又要出事',
        '这事看着小，忘了会很麻烦'
    ];
    if (/买|超市|마트|盒马|牛排|咖啡|纸巾|水果|礼物|快递|外卖|奶茶|食材/.test(sourceText)) {
        return ['又要花钱了，先记着别买漏', '买完这趟真的得省一点了', '别光顾着买喜欢的，正事也要带上'][index % 3];
    }
    if (/生日|纪念|约会|电影|餐厅|礼物|香菜|宝宝|Ta|ta|TA/.test(sourceText)) {
        return ['这个不能忘，忘了肯定会后悔', '嘴上说随便，其实还是想准备好一点', '别表现得太刻意，但也别太敷衍'][index % 3];
    }
    if (/会|会议|工作|合同|客户|作业|考试|截止|ddl|DDL|老板|项目/.test(sourceText)) {
        return ['看到这些字就开始头疼了', '先写下来，等下硬着头皮处理', '拜托这次别拖到最后一刻'][index % 3];
    }
    return templates[index % templates.length];
}

function getPhoneMessageDisplayText(text, messageMeta = null) {
    const visibleText = cleanVisibleMessageText(text);
    if (messageMeta?.stickerUrl && visibleText === '[图片]') return '';
    if (visibleText.startsWith('[拍摄]')) return visibleText.replace(/^\[拍摄\]\s*/, '').trim();
    return visibleText;
}

async function fillPhoneReplyPreview(previewElementId, repliedMessageId) {
    const previewElement = document.getElementById(previewElementId);
    const numericId = Number(repliedMessageId);
    if (!previewElement || !numericId) return;
    try {
        const repliedMessage = await db.chatMessages.get(numericId);
        if (!repliedMessage || repliedMessage.type === 'system' || repliedMessage.uiVisible === false) {
            previewElement.remove();
            return;
        }
        const ownerChar = currentActivePhoneChar;
        const identityId = ownerChar?.chatIdentityId || AppState.currentIdentityId;
        const currentUser = AppState.userIdentities.find(identity => identity.id === identityId) || AppState.userIdentities[0];
        const senderName = repliedMessage.type === 'sent' ? (currentUser?.name || '用户') : (ownerChar?.name || '角色');
        let contentSnippet = repliedMessage.stickerUrl
            ? (repliedMessage.text === '[图片]' ? '[图片]' : '[表情]')
            : cleanVisibleMessageText(repliedMessage.text || repliedMessage.content || '');
        if (repliedMessage.contentType === 'transfer' || repliedMessage.contentType === 'transfer_receipt') contentSnippet = '[转账]';
        if (!contentSnippet) {
            previewElement.remove();
            return;
        }
        if (contentSnippet.length > 8) contentSnippet = `${contentSnippet.substring(0, 8)}...`;
        previewElement.innerHTML = `<strong>${escapeHTML(senderName)}:</strong> ${escapeHTML(contentSnippet)}`;
    } catch (error) {
        console.warn('[查手机] 引用消息预览加载失败:', error);
        previewElement.remove();
    }
}

function appendPhoneNpcMessage(container, text, isMe, avatarUrl, extraClass = '', actionContext = null, translation = '', messageMeta = null) {
    if (isPhoneSystemDisplayMessage(messageMeta || {}, text)) return;
    const visibleText = getPhoneMessageDisplayText(text, messageMeta);
    const hasRichMessage = (messageMeta?.contentType === 'transfer' || messageMeta?.contentType === 'transfer_receipt') && messageMeta?.transferInfo;
    if (!container || (!visibleText && !messageMeta?.stickerUrl && !hasRichMessage)) return;
    const msgDiv = document.createElement('div');
    msgDiv.className = `cp-msg ${isMe ? 'sent' : 'received'} ${extraClass}`.trim();
    const translationText = String(translation || '').trim();
    const translationButton = translationText ? `<button class="cp-msg-translate-btn" type="button" aria-label="查看翻译">文</button>` : '';
    const mediaHtml = messageMeta?.stickerUrl
        ? `<img class="cp-phone-media" src="${escapeHTML(messageMeta.stickerUrl)}" alt="图片" loading="lazy">`
        : '';
    const replyToMessageId = Number(messageMeta?.replyToMessageId || 0);
    const replyPreviewId = replyToMessageId ? `cp-phone-reply-${messageMeta?.mainChatMessageId || Date.now()}-${Math.random().toString(36).slice(2, 8)}` : '';
    const replyPreviewHtml = replyPreviewId ? `<div id="${replyPreviewId}" class="message-reply-preview cp-phone-reply-preview">正在加载引用...</div>` : '';
    let richLabel = '';
    if ((messageMeta?.contentType === 'transfer' || messageMeta?.contentType === 'transfer_receipt') && messageMeta.transferInfo) {
        richLabel = `<span class="cp-phone-rich-label">转账 ¥${escapeHTML(String(messageMeta.transferInfo.amount || '0.00'))}</span>`;
    } else if (messageMeta?.contentType === 'red_packet' && messageMeta.content) {
        const packet = typeof messageMeta.content === 'string' ? (() => { try { return JSON.parse(messageMeta.content); } catch { return {}; } })() : messageMeta.content;
        richLabel = `<span class="cp-phone-rich-label">红包 ¥${escapeHTML(String(packet?.amount || '0.00'))}</span>`;
    }
    const textHtml = visibleText ? `<span class="cp-msg-text">${escapeHTML(visibleText)}</span>` : '';
    const bubbleHtml = `<div class="msg-bubble">${replyPreviewHtml}${mediaHtml}${textHtml}${richLabel}${translationText ? `<div class="cp-msg-translation collapsed">${escapeHTML(translationText).replace(/\n/g, '<br>')}</div>` : ''}</div>`;
    msgDiv.innerHTML = isMe
        ? `${bubbleHtml}${translationButton}`
        : `<img src="${avatarUrl}" class="msg-avatar">${bubbleHtml}${translationButton}`;
    bindPhoneNpcTranslation(msgDiv);
    if (actionContext) bindPhoneNpcMessageActions(msgDiv, actionContext);
    container.appendChild(msgDiv);
    if (replyPreviewId) fillPhoneReplyPreview(replyPreviewId, replyToMessageId);
    container.scrollTop = container.scrollHeight;
}

function renderPhoneNpcConversation(contact, avatarUrl, phoneData, ownerChar) {
    const mainChatView = document.getElementById('char-phone-chat-view');
    const detailView = document.getElementById('char-phone-conversation-view');
    const dockNav = document.querySelector('.cp-dock-nav');
    const aiBtn = document.getElementById('cp-ai-generate-btn');
    const detailNameEl = document.querySelector('.cp-detail-name');
    const detailAvatarEl = document.querySelector('.cp-detail-avatar');
    const detailMessagesEl = document.querySelector('.cp-detail-messages');
    const inputEl = document.getElementById('cp-npc-chat-input');
    const sendBtn = document.getElementById('cp-npc-chat-send-btn');
    const inputAreaEl = inputEl?.closest('.cp-detail-input-area');
    const isReadOnlyUserRecord = isPhoneRealUserContact(contact, ownerChar);
    currentPhoneNpcConversationContext = { contact, avatarUrl, phoneData, ownerChar, isDirectUserContact: isReadOnlyUserRecord };

    if (detailNameEl) detailNameEl.textContent = contact.name;
    if (detailAvatarEl) detailAvatarEl.src = avatarUrl;
    if (detailMessagesEl) {
        detailMessagesEl.innerHTML = '';
        (contact.chatHistory || []).forEach((msg, index) => {
            if (isPhoneSystemDisplayMessage(msg)) return;
            const actionContext = buildPhoneMessageActionContext(contact, index, phoneData, ownerChar, avatarUrl);
            appendPhoneNpcMessage(detailMessagesEl, msg.text, !!msg.isMe, avatarUrl, msg.takeover ? 'takeover' : '', actionContext, msg.translation, msg);
        });
        if ((isReadOnlyUserRecord ? isPhoneUserControlLocked(contact) : contact.npcChatEnded)) {
            appendPhoneNpcEndNotice(detailMessagesEl, { contact, ownerChar, phoneData, avatarUrl });
        }
    }
    if (inputAreaEl) inputAreaEl.style.display = '';
    if (inputEl) {
        const isEnded = isReadOnlyUserRecord ? isPhoneUserControlLocked(contact) : !!contact.npcChatEnded;
        inputEl.disabled = isEnded;
        inputEl.value = '';
        inputEl.placeholder = isReadOnlyUserRecord ? '以角色身份发送...' : (isEnded ? '本段查岗已结束' : '发送消息...');
        inputEl.onkeydown = isEnded ? null : (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (isReadOnlyUserRecord) {
                    handlePhoneUserSend(ownerChar, contact, phoneData, avatarUrl);
                } else {
                    stagePhoneNpcUserMessage(ownerChar, contact, phoneData, avatarUrl);
                }
            }
        };
    }
    if (sendBtn) {
        const isEnded = isReadOnlyUserRecord ? isPhoneUserControlLocked(contact) : !!contact.npcChatEnded;
        sendBtn.disabled = isEnded;
        sendBtn.onclick = isEnded
            ? null
            : (isReadOnlyUserRecord
                ? () => handlePhoneUserSend(ownerChar, contact, phoneData, avatarUrl)
                : () => handlePhoneNpcSend(ownerChar, contact, phoneData, avatarUrl));
    }
    if ((isReadOnlyUserRecord ? isPhoneUserControlLocked(contact) : contact.npcChatEnded)) setPhoneNpcEndedUi(inputEl, sendBtn);
    if (isReadOnlyUserRecord) schedulePhoneUserUnlock(contact, ownerChar, phoneData, avatarUrl);
    if (detailView) detailView.classList.remove('cp-phone-takeover-active');
    if (mainChatView) mainChatView.style.display = 'none';
    if (detailView) detailView.style.display = 'flex';
    if (dockNav) dockNav.style.display = 'none';
    if (aiBtn) aiBtn.style.display = 'none';
}

async function stagePhoneNpcUserMessage(ownerChar, contact, phoneData, avatarUrl) {
    const inputEl = document.getElementById('cp-npc-chat-input');
    const detailMessagesEl = document.querySelector('.cp-detail-messages');
    const sendBtn = document.getElementById('cp-npc-chat-send-btn');
    if (isPhoneRealUserContact(contact, ownerChar)) return null;
    if (contact?.npcChatEnded) {
        setPhoneNpcEndedUi(inputEl, sendBtn);
        return null;
    }
    const userText = inputEl?.value.trim();
    if (!userText || !detailMessagesEl || !ownerChar || !contact || !phoneData) return null;
    contact.chatHistory = contact.chatHistory || [];
    const stagedMessage = { isMe: true, text: userText, pendingNpcReply: true, userHijack: true };
    contact.chatHistory.push(stagedMessage);
    inputEl.value = '';
    appendPhoneNpcMessage(detailMessagesEl, userText, true, avatarUrl, '', {
        contact,
        messageIndex: contact.chatHistory.length - 1,
        phoneData,
        ownerChar,
        avatarUrl
    });
    await db.appData.put({ key: `virtual_phone_data_${ownerChar.id}`, value: phoneData });
    return stagedMessage;
}

async function savePhoneNpcMainChatRecord(ownerChar, contact, transcript, result, isDiscovered, options = {}) {
    const revealMin = options.passwordAccess ? PHONE_NPC_PASSWORD_REVEAL_MIN_TURN : PHONE_NPC_REVEAL_MIN_TURN;
    const revealMax = options.passwordAccess ? PHONE_NPC_PASSWORD_REVEAL_MAX_TURN : PHONE_NPC_REVEAL_MAX_TURN;
    const knownImmediately = !!isDiscovered || !!options.knownImmediately;
    const revealTurns = knownImmediately ? 0 : getRandomIntInclusive(revealMin, revealMax);
    const cardData = {
        npcName: contact.name,
        relation: contact.relation || '联系人',
        title: result.cardTitle || `${contact.name} 的聊天记录`,
        summary: result.cardSummary || (isDiscovered ? '角色现场接管了这次操作' : '角色后来知道了这次偷聊记录'),
        discovered: isDiscovered,
        knownByOwner: knownImmediately,
        pendingRevealTurns: revealTurns,
        passwordAccess: !!options.passwordAccess,
        messages: transcript.slice()
    };
    const cardId = await db.chatMessages.add({
        chatId: ownerChar.id,
        timestamp: new Date(),
        type: 'received',
        contentType: PHONE_NPC_CHAT_CARD_TYPE,
        text: `[查手机记录卡] ${cardData.title}：${cardData.summary}\n${cardData.messages.map(m => `${m.isMe ? ownerChar.name : contact.name}: ${m.text}`).join('\n')}`,
        phoneNpcChatData: cardData,
        avatarSrc: ownerChar.avatar || DEFAULT_AVATAR_SRC,
        speakerName: ownerChar.name,
        uiVisible: true,
        aiVisible: knownImmediately,
        phoneNpcRevealTurnsLeft: revealTurns,
        phoneNpcRevealTotalTurns: revealTurns,
        linkedMsgIds: [],
        recalled: false
    });
    contact.phoneNpcMainChatCardId = cardId;
    const linkedMsgIds = [];
    if (isDiscovered && Array.isArray(result?.mainChatMessages) && result.mainChatMessages.length > 0) {
        for (let i = 0; i < result.mainChatMessages.length; i++) {
            const mainMsg = normalizePhoneNpcMessageItem(result.mainChatMessages[i], false);
            if (!mainMsg.text || isLeakedPhoneNpcPromptSummary(mainMsg.text)) continue;
            const linkedId = await db.chatMessages.add({
                chatId: ownerChar.id,
                timestamp: new Date(Date.now() + 600 + i * 500),
                type: 'received',
                contentType: 'phone_npc_takeover_message',
                phoneNpcLinkedCardId: cardId,
                text: mainMsg.text,
                translation: mainMsg.translation || null,
                avatarSrc: ownerChar.avatar || DEFAULT_AVATAR_SRC,
                speakerName: ownerChar.name,
                uiVisible: true,
                aiVisible: true,
                recalled: false
            });
            linkedMsgIds.push(linkedId);
            try {
                const linkedMessage = await db.chatMessages.get(linkedId);
                const { createAndAppendMessage } = await import('./chat-ui.js');
                await createAndAppendMessage(linkedMessage, true);
            } catch (error) {
                console.warn('[查手机] NPC 接管消息同步渲染失败，消息仍已保存:', error);
            }
        }
    }
    if (linkedMsgIds.length > 0) {
        await db.chatMessages.update(cardId, { linkedMsgIds });
        const firstMainText = normalizePhoneNpcMessageItem(result.mainChatMessages[0], false).text || cardData.summary;
        const displayText = result.mainChatMessages.length > 1 ? `${firstMainText}...` : firstMainText;
        if (typeof notification !== 'undefined' && notification.show) {
            notification.show(ownerChar.name, displayText, ownerChar.avatar || DEFAULT_AVATAR_SRC, 'page-chat-detail', ownerChar.id);
        } else {
            showDynamicIsland(`[私聊] ${ownerChar.name}: ${displayText}`, 'success');
        }
    }
    return cardId;
}

function getPhoneNpcFinalTranscript(contact) {
    return (contact?.chatHistory || [])
        .filter(msg => msg?.text && !msg.pendingNpcReply)
        .map(msg => ({ ...msg }));
}

function canFinalizePhoneNpcConversation(contact) {
    if (!contact || contact.npcChatEnded || contact.phoneNpcMainChatCardId || contact.phoneNpcFinalizing) return false;
    const hasCompletedUserHijack = (contact.chatHistory || []).some(msg => msg?.userHijack && msg?.text);
    return hasCompletedUserHijack || Number(contact.userHijackTurns || 0) > 0;
}

function settlePhoneNpcPendingMessagesForExit(contact) {
    (contact.chatHistory || []).forEach(msg => {
        if (msg?.userHijack && msg.pendingNpcReply) {
            msg.pendingNpcReply = false;
            msg.aiHandled = true;
        }
    });
}

async function savePhoneNpcUndiscoveredOutcome(ownerChar, contact, transcript, result, passwordAccess, options = {}) {
    const choice = options.choice || await showPhoneNpcFinalizeChoice(options);
    if (choice === PHONE_NPC_FINALIZE_CONTINUE_LATER) {
        showDynamicIsland('这段聊天已保留，之后可以继续对话', 'success');
        return choice;
    }
    if (choice === PHONE_NPC_FINALIZE_SKIP_MAIN) {
        showDynamicIsland('本次聊天不会计入主聊天', 'success');
        return choice;
    }

    const knownImmediately = choice === PHONE_NPC_FINALIZE_DISCOVER_NOW;
    await savePhoneNpcMainChatRecord(ownerChar, contact, transcript, result, false, {
        passwordAccess,
        knownImmediately
    });
    showDynamicIsland(
        knownImmediately ? '角色已立刻发现这段查手机记录' : '偷聊记录已进入主聊天卡片',
        knownImmediately ? 'warning' : 'success'
    );
    return choice;
}

function buildPhoneNpcDirectRecord(contact, transcript) {
    return {
        npcReplies: [],
        takeoverConversation: [],
        takeoverMessages: [],
        mainChatMessages: [],
        cardTitle: `${contact.name} 的聊天记录`,
        cardSummary: `已直接归档 ${transcript.length} 条查手机聊天内容`
    };
}

async function finalizePhoneNpcConversationOnBack(ownerChar, contact, phoneData, avatarUrl) {
    if (!canFinalizePhoneNpcConversation(contact)) return false;

    const inputEl = document.getElementById('cp-npc-chat-input');
    const sendBtn = document.getElementById('cp-npc-chat-send-btn');
    const detailMessagesEl = document.querySelector('.cp-detail-messages');
    const passwordAccess = await hasRecentPhonePasswordAccess(ownerChar.id);
    contact.phoneNpcFinalizing = true;

    if (inputEl) inputEl.disabled = true;
    if (sendBtn) sendBtn.disabled = true;

    try {
        const choice = await showPhoneNpcFinalizeChoice({ allowContinue: true });
        if (choice === PHONE_NPC_FINALIZE_CONTINUE_LATER) {
            if (inputEl) inputEl.disabled = false;
            if (sendBtn) sendBtn.disabled = false;
            return false;
        }

        settlePhoneNpcPendingMessagesForExit(contact);
        const transcript = getPhoneNpcFinalTranscript(contact);
        const result = buildPhoneNpcDirectRecord(contact, transcript);
        await savePhoneNpcUndiscoveredOutcome(
            ownerChar,
            contact,
            transcript,
            result,
            passwordAccess,
            { choice }
        );
        contact.userHijackTurns = 0;
        contact.npcChatEnded = true;
        resetPhoneNpcResolveTurn(contact);
        setPhoneNpcEndedUi(inputEl, sendBtn);
        appendPhoneNpcEndNotice(detailMessagesEl);
        return true;
    } finally {
        delete contact.phoneNpcFinalizing;
        await db.appData.put({ key: `virtual_phone_data_${ownerChar.id}`, value: phoneData });
    }
}

function closePhoneNpcDetailView(mainChatView, detailView, dockNav) {
    hidePhoneNpcActionPopover();
    clearPhoneUserLockTimers();
    if (detailView) detailView.style.display = 'none';
    if (mainChatView) mainChatView.style.display = '';
    if (dockNav) dockNav.style.display = 'flex';
    const aiBtn = document.getElementById('cp-ai-generate-btn');
    if (aiBtn) aiBtn.style.display = 'flex';
    currentPhoneNpcConversationContext = null;
}

async function handlePhoneNpcDetailBack(mainChatView, detailView, dockNav) {
    if (phoneNpcBackInProgress) return;
    phoneNpcBackInProgress = true;
    try {
        const context = currentPhoneNpcConversationContext;
        if (tempState.phoneNpcAbortController) {
            const stopped = await stopPhoneNpcGenerationForExit();
            if (!stopped) {
                showDynamicIsland('NPC回复仍在结束中，请稍后重试', 'info');
                return;
            }
        }
        if (context && !context.isDirectUserContact && canFinalizePhoneNpcConversation(context.contact)) {
            await finalizePhoneNpcConversationOnBack(
                context.ownerChar,
                context.contact,
                context.phoneData,
                context.avatarUrl
            );
        }
        closePhoneNpcDetailView(mainChatView, detailView, dockNav);
    } finally {
        phoneNpcBackInProgress = false;
    }
}

async function syncPhoneUserMainMessage(ownerChar, messageData) {
    const messageId = await db.chatMessages.add({
        chatId: ownerChar.id,
        timestamp: messageData.timestamp || new Date(),
        type: 'received',
        speakerId: ownerChar.id,
        speakerName: ownerChar.name,
        avatarSrc: ownerChar.avatar || DEFAULT_AVATAR_SRC,
        uiVisible: true,
        aiVisible: true,
        recalled: false,
        source: 'character_phone',
        phoneSessionId: messageData.phoneSessionId,
        ...messageData
    });
    const savedMessage = await db.chatMessages.get(messageId);
    try {
        const { createAndAppendMessage } = await import('./chat-ui.js');
        await createAndAppendMessage(savedMessage, true);
    } catch (error) {
        console.warn('[查手机] 主聊天同步渲染失败，消息仍已保存:', error);
    }
    if (savedMessage?.type === 'received') {
        showChatMessageNotification(ownerChar, cleanVisibleMessageText(savedMessage.text || ''), ownerChar.id);
    }
    return savedMessage;
}

async function sendPhoneUserAction(ownerChar, contact, phoneData, avatarUrl, payload = {}) {
    const inputEl = document.getElementById('cp-npc-chat-input');
    const detailMessagesEl = document.querySelector('.cp-detail-messages');
    if (!ownerChar || !contact || !phoneData || !detailMessagesEl || contact.phoneUserControlResolving || isPhoneUserControlLocked(contact)) return false;

    const text = String(payload.text || '').trim();
    if (!text && !payload.stickerUrl && payload.contentType !== 'transfer') return false;
    const phoneSessionId = contact.phoneUserSessionId || (contact.phoneUserSessionId = `phone_${ownerChar.id}_${Date.now()}`);
    const messageCount = Number(contact.phoneUserHijackMessageCount ?? contact.phoneUserHijackTurns ?? 0) + 1;
    const discoveryCount = getPhoneUserDiscoveryTargetCount(contact);
    const shouldResolve = messageCount >= discoveryCount;
    const passwordAccess = await hasRecentPhonePasswordAccess(ownerChar.id);
    const discoveryProbability = passwordAccess ? PHONE_NPC_DISCOVERY_PASSWORD_PROBABILITY : PHONE_NPC_DISCOVERY_DEFAULT_PROBABILITY;
    const isDiscovered = shouldResolve && Math.random() < discoveryProbability;

    if (inputEl) inputEl.value = '';
    if (isDiscovered) {
        contact.phoneUserControlDiscovered = true;
        contact.phoneUserControlResolving = true;
        delete contact.phoneUserControlLockedUntil;
        contact.phoneUserHijackMessageCount = 0;
        contact.lastTime = '刚刚';
        delete contact.phoneUserHijackTurns;
        resetPhoneUserDiscoveryTargetCount(contact);
        if (detailMessagesEl) {
            const notice = document.createElement('div');
            notice.className = 'cp-takeover-notice';
            notice.innerHTML = `<span class="scan-dot"></span><strong>${escapeHTML(ownerChar.name)}</strong> 接管了手机`;
            detailMessagesEl.appendChild(notice);
        }
        setPhoneNpcEndedUi(inputEl, document.getElementById('cp-npc-chat-send-btn'));
        showDynamicIsland('角色发现了手机操作，消息没有发出去', 'warning');

        const result = await generatePhoneOwnerTakeover(ownerChar.id, contact.chatHistory || [], text || '[media]');
        const lockMinutes = getPhoneOwnerLockMinutes(result);
        contact.phoneUserControlEnded = lockMinutes > 0;
        contact.phoneUserControlResolving = false;
        if (lockMinutes > 0) {
            contact.phoneUserControlLockedUntil = Date.now() + lockMinutes * 60 * 1000;
        } else {
            delete contact.phoneUserControlLockedUntil;
        }
        const takeoverMessages = result?.messages?.length
            ? result.messages
            : [{ text: '我发现了', translation: '' }, { text: '先别再动我的手机', translation: '' }];
        for (const item of takeoverMessages) {
            const ownerText = String(item?.text || '').trim();
            if (!ownerText) continue;
            const phoneMessage = {
                isMe: true,
                text: ownerText,
                translation: item.translation || '',
                takeover: true,
                actor: 'character',
                contentType: 'phone_user_takeover_message',
                phoneHijack: false,
                phoneSessionId
            };
            contact.chatHistory = contact.chatHistory || [];
            contact.chatHistory.push(phoneMessage);
            const takeoverActionContext = buildPhoneMessageActionContext(contact, contact.chatHistory.length - 1, phoneData, ownerChar, avatarUrl);
            appendPhoneNpcMessage(detailMessagesEl, ownerText, true, avatarUrl, 'takeover', takeoverActionContext, phoneMessage.translation, phoneMessage);
            const savedMessage = await syncPhoneUserMainMessage(ownerChar, {
                contentType: 'phone_user_takeover_message',
                text: ownerText,
                translation: phoneMessage.translation,
                phoneSessionId
            });
            phoneMessage.mainChatMessageId = savedMessage?.id || null;
            phoneMessage.timestamp = savedMessage?.timestamp || new Date();
        }
        await db.appData.put({ key: `virtual_phone_data_${ownerChar.id}`, value: phoneData });
        if (contact.phoneUserControlEnded) {
            appendPhoneNpcEndNotice(detailMessagesEl, { contact, ownerChar, phoneData, avatarUrl });
            schedulePhoneUserUnlock(contact, ownerChar, phoneData, avatarUrl);
        } else {
            if (inputEl) {
                inputEl.disabled = false;
                inputEl.placeholder = '以角色身份发送...';
            }
            const sendBtn = document.getElementById('cp-npc-chat-send-btn');
            if (sendBtn) sendBtn.disabled = false;
            showDynamicIsland('角色发现了操作，但没有锁定手机', 'info');
        }
        return true;
    }

    if (typeof payload.prepare === 'function') {
        const prepared = await payload.prepare();
        if (!prepared) return false;
        Object.assign(payload, prepared);
    }

    const phoneMessage = {
        isMe: true,
        text: text || payload.text || '',
        translation: '',
        actor: 'user_phone_control',
        phoneHijack: true,
        contentType: payload.contentType || 'text',
        stickerUrl: payload.stickerUrl || '',
        content: payload.content || null,
        transferInfo: payload.transferInfo || null,
        phoneSessionId
    };
    contact.chatHistory = contact.chatHistory || [];
    contact.chatHistory.push(phoneMessage);
    contact.lastTime = '刚刚';
    contact.phoneUserHijackMessageCount = shouldResolve ? 0 : messageCount;
    if (contact.phoneUserHijackTurns !== undefined) delete contact.phoneUserHijackTurns;
    const phoneActionContext = buildPhoneMessageActionContext(contact, contact.chatHistory.length - 1, phoneData, ownerChar, avatarUrl);
    appendPhoneNpcMessage(detailMessagesEl, phoneMessage.text, true, avatarUrl, '', phoneActionContext, '', phoneMessage);
    const savedMessage = await syncPhoneUserMainMessage(ownerChar, {
        text: phoneMessage.text,
        contentType: phoneMessage.contentType === 'text' ? 'phone_user_hijack_message' : phoneMessage.contentType,
        stickerUrl: phoneMessage.stickerUrl,
        content: phoneMessage.content,
        transferInfo: phoneMessage.transferInfo,
        phoneSessionId,
        phoneHijack: true
    });
    phoneMessage.mainChatMessageId = savedMessage?.id || null;
    phoneMessage.timestamp = savedMessage?.timestamp || new Date();
    await db.appData.put({ key: `virtual_phone_data_${ownerChar.id}`, value: phoneData });
    return true;
}

async function handlePhoneUserSend(ownerChar, contact, phoneData, avatarUrl) {
    const inputEl = document.getElementById('cp-npc-chat-input');
    const text = inputEl?.value.trim();
    if (!text) return;
    await sendPhoneUserAction(ownerChar, contact, phoneData, avatarUrl, { text });
}

function hidePhoneFunctionMenu() {
    const menu = document.getElementById('cp-phone-function-menu');
    if (menu) menu.hidden = true;
}

function getPhoneUserContext() {
    const context = currentPhoneNpcConversationContext;
    if (!context?.isDirectUserContact || context.contact?.phoneUserControlResolving || isPhoneUserControlLocked(context.contact)) return null;
    return context;
}

function requestPhoneTransferDetails() {
    const modal = document.getElementById('cp-phone-transfer-modal');
    if (!modal) return Promise.resolve(null);
    const amountInput = modal.querySelector('#cp-phone-transfer-amount');
    const remarkInput = modal.querySelector('#cp-phone-transfer-remark');
    const errorEl = modal.querySelector('[data-role="error"]');
    const confirmBtn = modal.querySelector('[data-action="confirm"]');
    const cancelBtns = modal.querySelectorAll('[data-action="cancel"]');
    if (!amountInput || !remarkInput || !errorEl || !confirmBtn) return Promise.resolve(null);

    amountInput.value = '';
    remarkInput.value = '';
    errorEl.textContent = '';
    modal.hidden = false;
    amountInput.focus();

    return new Promise(resolve => {
        const finish = result => {
            modal.hidden = true;
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtns.forEach(button => button.removeEventListener('click', onCancel));
            modal.removeEventListener('click', onOverlayClick);
            amountInput.removeEventListener('keydown', onKeyDown);
            remarkInput.removeEventListener('keydown', onKeyDown);
            resolve(result);
        };
        const onCancel = () => finish(null);
        const onConfirm = () => {
            const amount = Number(amountInput.value.trim());
            if (!Number.isFinite(amount) || amount <= 0) {
                errorEl.textContent = '请输入大于 0 的金额';
                amountInput.focus();
                return;
            }
            finish({ amount, remark: remarkInput.value.trim() });
        };
        const onOverlayClick = event => {
            if (event.target === modal) onCancel();
        };
        const onKeyDown = event => {
            if (event.key === 'Escape') onCancel();
            if (event.key === 'Enter') onConfirm();
        };
        confirmBtn.addEventListener('click', onConfirm);
        cancelBtns.forEach(button => button.addEventListener('click', onCancel));
        modal.addEventListener('click', onOverlayClick);
        amountInput.addEventListener('keydown', onKeyDown);
        remarkInput.addEventListener('keydown', onKeyDown);
    });
}

function requestPhoneFakeImageDetails() {
    const modal = document.getElementById('cp-phone-fake-image-modal');
    if (!modal) return Promise.resolve(null);
    const descriptionInput = modal.querySelector('#cp-phone-fake-image-description');
    const errorEl = modal.querySelector('[data-role="error"]');
    const confirmBtn = modal.querySelector('[data-action="confirm"]');
    const cancelBtns = modal.querySelectorAll('[data-action="cancel"]');
    if (!descriptionInput || !errorEl || !confirmBtn) return Promise.resolve(null);

    descriptionInput.value = '';
    errorEl.textContent = '';
    modal.hidden = false;
    descriptionInput.focus();

    return new Promise(resolve => {
        const finish = result => {
            modal.hidden = true;
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtns.forEach(button => button.removeEventListener('click', onCancel));
            modal.removeEventListener('click', onOverlayClick);
            descriptionInput.removeEventListener('keydown', onKeyDown);
            resolve(result);
        };
        const onCancel = () => finish(null);
        const onConfirm = () => {
            const description = descriptionInput.value.trim();
            if (!description) {
                errorEl.textContent = '请输入图片描述';
                descriptionInput.focus();
                return;
            }
            finish(description);
        };
        const onOverlayClick = event => {
            if (event.target === modal) onCancel();
        };
        const onKeyDown = event => {
            if (event.key === 'Escape') onCancel();
            if (event.key === 'Enter') onConfirm();
        };
        confirmBtn.addEventListener('click', onConfirm);
        cancelBtns.forEach(button => button.addEventListener('click', onCancel));
        modal.addEventListener('click', onOverlayClick);
        descriptionInput.addEventListener('keydown', onKeyDown);
    });
}

function bindPhoneConversationFunctionMenu() {
    const menuButton = document.getElementById('cp-phone-function-btn');
    const menu = document.getElementById('cp-phone-function-menu');
    const uploadInput = document.getElementById('cp-phone-real-image-upload');
    if (!menuButton || !menu || menuButton.dataset.bound === 'true') return;
    menuButton.dataset.bound = 'true';

    menuButton.addEventListener('click', event => {
        event.stopPropagation();
        if (!getPhoneUserContext()) {
            hidePhoneFunctionMenu();
            showDynamicIsland('只有用户联系人可以使用手机功能', 'info');
            return;
        }
        menu.hidden = !menu.hidden;
    });

    menu.addEventListener('click', async event => {
        const action = event.target.closest('[data-phone-action]')?.dataset.phoneAction;
        if (!action) return;
        event.stopPropagation();
        const context = getPhoneUserContext();
        if (!context) return;
        hidePhoneFunctionMenu();
        const { ownerChar, contact, phoneData, avatarUrl } = context;
        if (action === 'real-image') {
            uploadInput?.click();
            return;
        }
        if (action === 'fake-image') {
            const description = await requestPhoneFakeImageDetails();
            if (description) {
                await sendPhoneUserAction(ownerChar, contact, phoneData, avatarUrl, { text: `[拍摄] ${description}` });
            }
            return;
        }
        if (action === 'transfer') {
            const transferDetails = await requestPhoneTransferDetails();
            if (!transferDetails) return;
            const { amount, remark } = transferDetails;
            await sendPhoneUserAction(ownerChar, contact, phoneData, avatarUrl, {
                text: `[转账] ${amount.toFixed(2)}元`,
                contentType: 'transfer',
                transferInfo: {
                    amount: amount.toFixed(2),
                    remark,
                    status: 'pending',
                    targetName: contact.name,
                    paymentMethod: '',
                    paymentCardId: ''
                },
                prepare: async () => {
                    const payment = await requestCharacterPhonePayment(ownerChar.id, {
                        amount,
                        title: '角色手机转账',
                        memo: remark
                    });
                    return payment ? {
                        transferInfo: {
                            amount: amount.toFixed(2),
                            remark,
                            status: 'pending',
                            targetName: contact.name,
                            paymentMethod: payment.displayName || '',
                            paymentCardId: payment.paymentCardId || payment.id
                        }
                    } : null;
                }
            });
            return;
        }
    });

    uploadInput?.addEventListener('change', event => {
        const file = event.target.files?.[0];
        const context = getPhoneUserContext();
        if (!file || !context) return;
        const reader = new FileReader();
        reader.onload = loadEvent => {
            const img = new Image();
            img.onload = async () => {
                const canvas = document.createElement('canvas');
                const maxWidth = 1024;
                let width = img.width;
                let height = img.height;
                if (width > maxWidth) {
                    height *= maxWidth / width;
                    width = maxWidth;
                }
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                await sendPhoneUserAction(context.ownerChar, context.contact, context.phoneData, context.avatarUrl, {
                    text: '[图片]',
                    stickerUrl: canvas.toDataURL('image/jpeg', 0.6)
                });
                event.target.value = '';
            };
            img.src = String(loadEvent.target?.result || '');
        };
        reader.readAsDataURL(file);
    });

    document.addEventListener('click', event => {
        if (!menu.contains(event.target) && event.target !== menuButton && !menuButton.contains(event.target)) hidePhoneFunctionMenu();
    });
}

async function handlePhoneNpcSend(ownerChar, contact, phoneData, avatarUrl) {
    const inputEl = document.getElementById('cp-npc-chat-input');
    const sendBtn = document.getElementById('cp-npc-chat-send-btn');
    const detailView = document.getElementById('char-phone-conversation-view');
    const detailMessagesEl = document.querySelector('.cp-detail-messages');
    if (isPhoneRealUserContact(contact, ownerChar)) return;
    if (tempState.phoneNpcAbortController) {
        tempState.phoneNpcAbortController.abort();
        return;
    }
    if (!detailMessagesEl || !ownerChar || !contact || !phoneData) return;
    if (contact.npcChatEnded) {
        setPhoneNpcEndedUi(inputEl, sendBtn);
        appendPhoneNpcEndNotice(detailMessagesEl);
        return;
    }

    const typedText = inputEl?.value.trim();
    const pendingBeforeStage = (contact.chatHistory || []).filter(msg => msg?.isMe && msg.pendingNpcReply);
    const pendingCount = pendingBeforeStage.length + (typedText ? 1 : 0);
    if (pendingCount === 0) return;

    const stolenTurns = Number(contact.userHijackTurns || 0) + 1;
    const resolveTurn = getPhoneNpcResolveTurn(contact);
    const shouldResolve = stolenTurns >= resolveTurn;
    const passwordAccess = await hasRecentPhonePasswordAccess(ownerChar.id);
    const discoveryProbability = passwordAccess ? PHONE_NPC_DISCOVERY_PASSWORD_PROBABILITY : PHONE_NPC_DISCOVERY_DEFAULT_PROBABILITY;
    const isDiscovered = shouldResolve && Math.random() < discoveryProbability;
    const abortController = new AbortController();
    tempState.phoneNpcAbortController = abortController;

    if (!isDiscovered && typedText) {
        await stagePhoneNpcUserMessage(ownerChar, contact, phoneData, avatarUrl);
    } else if (typedText) {
        inputEl.value = '';
    }
    const pendingMessages = (contact.chatHistory || []).filter(msg => msg?.isMe && msg.pendingNpcReply);
    const userText = [
        ...pendingBeforeStage.map(msg => msg.text || ''),
        ...(typedText ? [typedText] : [])
    ].filter(Boolean).join('\n');
    if (!userText) {
        tempState.phoneNpcAbortController = null;
        return;
    }

    inputEl.disabled = true;
    setPhoneNpcTypingTitle(contact, true);
    if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.classList.add('is-cancel');
        sendBtn.title = '打断生成';
    }

    if (isDiscovered) {
        contact.chatHistory = (contact.chatHistory || []).filter(msg => !msg.pendingNpcReply);
        await rerenderPhoneNpcMessages(contact, avatarUrl, phoneData, ownerChar);
        if (detailView) detailView.classList.add('cp-phone-takeover-active');
        const notice = document.createElement('div');
        notice.className = 'cp-takeover-notice';
        notice.innerHTML = `<span class="scan-dot"></span><strong>${escapeHTML(ownerChar.name)}</strong> 接管了手机`;
        detailMessagesEl.appendChild(notice);
        inputEl.placeholder = '角色正在接管，无法继续发送';
        showDynamicIsland('被现场发现，消息没有发出去', 'warning');
    }

    const result = await generateVirtualNpcChatIntervention(ownerChar.id, contact, contact.chatHistory || [], userText, { shouldResolve, isDiscovered, passwordAccess, signal: abortController.signal });
    if (result?.aborted) {
        tempState.phoneNpcAbortController = null;
        setPhoneNpcTypingTitle(contact, false);
        inputEl.disabled = false;
        if (sendBtn) {
            sendBtn.disabled = false;
            sendBtn.classList.remove('is-cancel');
            sendBtn.title = '';
        }
        showDynamicIsland('已打断NPC回复');
        await db.appData.put({ key: `virtual_phone_data_${ownerChar.id}`, value: phoneData });
        return;
    }
    if (!result) {
        tempState.phoneNpcAbortController = null;
        setPhoneNpcTypingTitle(contact, false);
        inputEl.disabled = false;
        if (sendBtn) {
            sendBtn.disabled = false;
            sendBtn.classList.remove('is-cancel');
            sendBtn.title = '';
        }
        showDynamicIsland('NPC聊天生成失败', 'error');
        return;
    }

    pendingMessages.forEach(msg => {
        msg.pendingNpcReply = false;
        msg.aiHandled = true;
    });

    if (isDiscovered) {
        const takeoverConversation = Array.isArray(result.takeoverConversation) && result.takeoverConversation.length
            ? result.takeoverConversation
            : (result.takeoverMessages.length ? result.takeoverMessages.map(item => ({ ...normalizePhoneNpcMessageItem(item, true), speaker: 'owner' })) : [
                { speaker: 'owner', text: '不好意思，刚才不是我发的', translation: '' },
                { speaker: 'owner', text: '我先处理一下', translation: '' }
            ]);
        for (let i = 0; i < takeoverConversation.length; i++) {
            const msg = normalizePhoneNpcMessageItem(takeoverConversation[i], true);
            if (!msg.text) continue;
            const shouldContinue = await waitPhoneNpcAnimation(getPhoneNpcMessageDelay(), abortController.signal);
            if (!shouldContinue) {
                tempState.phoneNpcAbortController = null;
                setPhoneNpcTypingTitle(contact, false);
                inputEl.disabled = false;
                if (sendBtn) {
                    sendBtn.disabled = false;
                    sendBtn.classList.remove('is-cancel');
                    sendBtn.title = '';
                }
                showDynamicIsland('已打断NPC回复');
                await db.appData.put({ key: `virtual_phone_data_${ownerChar.id}`, value: phoneData });
                return;
            }
            contact.chatHistory = contact.chatHistory || [];
            contact.chatHistory.push({ isMe: msg.isMe, text: msg.text, translation: msg.translation, takeover: msg.isMe });
            appendPhoneNpcMessage(detailMessagesEl, msg.text, msg.isMe, avatarUrl, msg.isMe ? 'takeover' : '', {
                contact,
                messageIndex: contact.chatHistory.length - 1,
                phoneData,
                ownerChar,
                avatarUrl
            }, msg.translation);
        }
        contact.userHijackTurns = 0;
        contact.npcChatEnded = true;
        resetPhoneNpcResolveTurn(contact);
        setPhoneNpcEndedUi(inputEl, sendBtn);
        appendPhoneNpcEndNotice(detailMessagesEl);
        await savePhoneNpcMainChatRecord(ownerChar, contact, contact.chatHistory || [], result, true, { passwordAccess });
        showDynamicIsland('角色接管记录已进入主聊天', 'success');
    } else {
        const npcReplies = result.npcReplies.length ? result.npcReplies : ['？'];
        for (const item of npcReplies) {
            const msg = normalizePhoneNpcMessageItem(item, false);
            if (!msg.text) continue;
            const shouldContinue = await waitPhoneNpcAnimation(getPhoneNpcMessageDelay(), abortController.signal);
            if (!shouldContinue) {
                tempState.phoneNpcAbortController = null;
                setPhoneNpcTypingTitle(contact, false);
                inputEl.disabled = false;
                if (sendBtn) {
                    sendBtn.disabled = false;
                    sendBtn.classList.remove('is-cancel');
                    sendBtn.title = '';
                }
                showDynamicIsland('已打断NPC回复');
                await db.appData.put({ key: `virtual_phone_data_${ownerChar.id}`, value: phoneData });
                return;
            }
            contact.chatHistory.push({ isMe: false, text: msg.text, translation: msg.translation });
            appendPhoneNpcMessage(detailMessagesEl, msg.text, false, avatarUrl, '', {
                contact,
                messageIndex: contact.chatHistory.length - 1,
                phoneData,
                ownerChar,
                avatarUrl
            }, msg.translation);
        }
        contact.userHijackTurns = shouldResolve ? 0 : stolenTurns;
        if (shouldResolve) {
            contact.npcChatEnded = true;
            resetPhoneNpcResolveTurn(contact);
            setPhoneNpcEndedUi(inputEl, sendBtn);
            appendPhoneNpcEndNotice(detailMessagesEl);
            await savePhoneNpcUndiscoveredOutcome(
                ownerChar,
                contact,
                getPhoneNpcFinalTranscript(contact),
                result,
                passwordAccess
            );
        } else {
            inputEl.disabled = false;
            if (sendBtn) sendBtn.disabled = false;
        }
    }

    tempState.phoneNpcAbortController = null;
    setPhoneNpcTypingTitle(contact, false);
    if (sendBtn) {
        sendBtn.classList.remove('is-cancel');
        sendBtn.title = '';
    }
    await db.appData.put({ key: `virtual_phone_data_${ownerChar.id}`, value: phoneData });
}
export function initCheckPhone() {
    cleanupLeakedPhoneNpcPromptSummaries().catch(error => console.warn('[查手机NPC] 清理误显示摘要失败:', error));
    const slider = document.getElementById('cp-character-slider');
    const totalCountEl = document.getElementById('cp-total-count');

    const currentIndexEl = document.getElementById('cp-current-index');
    const conversationItemContexts = new WeakMap();
    const phoneViewIds = [
        'char-phone-chat-view',
        'char-phone-memo-view',
        'char-phone-shop-view',
        'char-phone-browser-view',
        'char-phone-wallet-view',
        'char-phone-screentime-view',
        'char-phone-cgt-view'
    ];
    const phoneDetailViewIds = new Set([
        'char-phone-conversation-view',
        'char-phone-memo-detail-view',
        'char-phone-browser-detail-view'
    ]);
    const phoneSwipeArea = document.getElementById('page-character-phone');
    const phoneViews = Array.from(document.querySelectorAll('#page-character-phone .char-phone-content-view'));
    const phoneDockNav = document.querySelector('.cp-dock-nav');
    const phoneAiGenerateBtn = document.getElementById('cp-ai-generate-btn');
    let activePhoneViewId = 'char-phone-chat-view';

    const setPhoneView = (targetViewId) => {
        const nextViewId = phoneViewIds.includes(targetViewId) ? targetViewId : phoneViewIds[0];
        const targetView = phoneViews.find(view => view.id === nextViewId);
        if (!targetView) return;
        activePhoneViewId = nextViewId;

        phoneViews.forEach(view => {
            const isTargetView = view.id === nextViewId;
            if (phoneDetailViewIds.has(view.id)) {
                view.classList.remove('active');
                view.style.display = 'none';
                return;
            }
            view.classList.toggle('active', isTargetView);
            view.style.removeProperty('display');
        });

        document.querySelectorAll('.cp-dock-nav .dock-item').forEach(item => {
            item.classList.toggle('active', item.dataset.view === nextViewId);
        });
        if (phoneDockNav) phoneDockNav.style.display = 'flex';
        if (phoneAiGenerateBtn) phoneAiGenerateBtn.style.display = 'flex';
        const cgtSidebarOverlay = document.getElementById('cgt-sidebar-overlay');
        if (cgtSidebarOverlay) cgtSidebarOverlay.style.display = 'none';
    };

    const resetPhoneSubpageUi = () => setPhoneView('char-phone-chat-view');
    window.addEventListener('looky:page-opened', event => {
        if (event.detail?.pageId === 'page-character-phone') resetPhoneSubpageUi();
    });

    const browserDetailRequests = new Map();
    const clearBrowserDetailCache = async charId => {
        const cachePrefix = `virtual_browser_detail_${charId}_`;
        try {
            await db.appData.where('key').startsWith(cachePrefix).delete();
        } catch (error) {
            console.warn('[查手机] 清理旧浏览器详情缓存失败:', error);
        }
    };

    const loadBrowserDetailData = async (charId, query) => {
        const cacheKey = `virtual_browser_detail_${charId}_${query}`;
        try {
            const cachedRecord = await db.appData.get(cacheKey);
            if (cachedRecord?.value) return cachedRecord.value;
        } catch (error) {
            console.warn('[查手机] 读取浏览器详情缓存失败:', error);
        }

        if (browserDetailRequests.has(cacheKey)) return browserDetailRequests.get(cacheKey);

        const request = (async () => {
            const detailData = await generateVirtualBrowserDetailPage(charId, query);
            if (detailData && !detailData.error) {
                try {
                    await db.appData.put({ key: cacheKey, value: detailData });
                } catch (error) {
                    console.warn('[查手机] 保存浏览器详情缓存失败:', error);
                }
            }
            return detailData;
        })();
        browserDetailRequests.set(cacheKey, request);
        try {
            return await request;
        } finally {
            if (browserDetailRequests.get(cacheKey) === request) browserDetailRequests.delete(cacheKey);
        }
    };

    if (!slider) return;
    // 渲染函数
    function render() {
        // 获取所有有聊天记录（或者所有）的角色，并且过滤掉群聊
        const characters = AppState.characterProfiles.filter(c => !c.isGroup);
        
        if (characters.length === 0) {

            slider.innerHTML = `<div style="color:#999">通讯录中尚无角色</div>`;
            return;
        }

        totalCountEl.textContent = characters.length.toString().padStart(2, '0');
        slider.innerHTML = '';
// [修改处] 前两行
        characters.forEach((char, index) => {
            const card = document.createElement('div');
// [替换 innerHTML 内容开始]
             card.className = 'cp-char-card';
            card.innerHTML = `
                <div class="avatar-area">
                    <img src="${char.avatar || DEFAULT_AVATAR_SRC}" alt="avatar">
                    <div class="img-overlay-text">MEMORY ARCHIVE</div>
                </div>
                <div class="name-area">
                    <div class="main-name" style="letter-spacing: 2px;">${escapeHTML(char.name)}</div>
                    <div class="char-meta">
                        <div class="meta-id">ID: 00${index + 1}</div>
                        <div class="meta-status" style="color: #d4a373;">✦ ${escapeHTML(char.tag || 'NULL')}</div>
                    </div>
                </div>
                <div class="action-area">
                    <div class="view-btn" style="color: #333; font-weight: 500;">互动档案 · ENTER </div>
                </div>
            `;
                   addTapListener(card, async () => {
                if (!window.unlockedPhones) window.unlockedPhones = new Set();
                if (!window.unlockedPhones.has(char.id)) {
                    const recentMsgs = await db.chatMessages
                        .where('chatId').equals(char.id)
                        .reverse()
                        .limit(50)
                        .toArray();
                    const latestPwdMsg = recentMsgs.find(m => m.contentType === 'share_password');
                    
                    // 【逻辑分流】如果最近50条内有密码，存入 expectedPwd 走常规比对；否则为 null，走盲猜模式
                    const expectedPwd = latestPwdMsg ? String(latestPwdMsg.content.pwd).trim() : null;

                    // 弹窗验证，使用 Promise 等待用户输入结果
                    const isPassed = await new Promise(resolve => {
                      const overlay = document.getElementById('phone-lock-overlay');
                        const input = document.getElementById('lock-real-input');
                        const errorMsg = document.getElementById('lock-error-msg');
                        const confirmBtn = document.getElementById('lock-confirm-btn');
                        const cancelBtn = document.getElementById('lock-cancel-btn');
                        const forceEnterBtn = document.getElementById('lock-force-enter-btn');
                        
                                     // 初始化界面与按钮状态
                        document.getElementById('lock-name').textContent = char.name;
                        input.value = '';
                        errorMsg.textContent = '';
                        confirmBtn.innerText = 'UNLOCK';
                        confirmBtn.disabled = false;
                        cancelBtn.disabled = false;
                        input.disabled = false;
                        overlay.style.display = 'flex';
                        setTimeout(() => overlay.style.opacity = '1', 10);
                        input.focus();

                       // 清理并退出弹窗的辅助函数
                        const cleanup = () => {
                            overlay.style.opacity = '0';
                            setTimeout(() => overlay.style.display = 'none', 300);
                            confirmBtn.onclick = null;
                            cancelBtn.onclick = null;
                            if (forceEnterBtn) forceEnterBtn.onclick = null;
                        };
                        cancelBtn.onclick = () => { cleanup(); resolve(false); };
                        
                        if (forceEnterBtn) {
                            forceEnterBtn.onclick = () => {
                                cleanup();
                                resolve(true);
                            };
                        }
                        
                        confirmBtn.onclick = async () => {
                            const guessPwd = input.value.trim();
                            if (!guessPwd) return;

                            if (expectedPwd) {
                                // 【正常情况（已授权）】近50条内有密码，直接本地验证
                                if (guessPwd === expectedPwd) {
                                    cleanup();
                                    resolve(true); 
                                } else {
                                    errorMsg.textContent = 'Passcode Incorrect / 密码错误';
                                    input.value = '';
                                    input.focus();
                                    const container = overlay.querySelector('.phone-lock-container');
                                    container.classList.add('shake');
                                    setTimeout(() => container.classList.remove('shake'), 400);
                                }
                            } else {
                                // 【盲猜情况（未授权）】发给系统验证，角色会收到警报
                                // 1. 触发全新的、明显的加载动画
                                confirmBtn.classList.add('loading');
                                confirmBtn.innerText = 'VERIFYING';
                                confirmBtn.disabled = true;
                                cancelBtn.disabled = true;
                                input.disabled = true;
                                
                                // 在输入框下方显示提示，安抚用户情绪
                                errorMsg.style.color = '#888';
                                errorMsg.textContent = '正在获取对方设备的响应...'; 

                                 // 2. 优化后的提示词：完全基于人设的多元化反应
                                                             const promptText = `<[系统隐式提示：情侣APP实时提醒，用户在尝试盲猜你的手机锁屏密码。，输入的密码是："${guessPwd}"。

你现在要做两件事：
A. 在心里判断一下，"${guessPwd}"是不是你会设的密码。参考依据：你的生日、你们的纪念日、你的习惯、或者你觉得你会用的数字组合。这个判断必须基于你自己的人设和记忆，不要随便就让人猜中。

B. 根据判断结果，自然地给TA发一条消息：
  - 如果猜对了：在JSON数组中【必须】包含 {"type":"share_password", "content":{"pwd":"${guessPwd}", "hint":"..."}}，然后再加一条 {"type":"text", "content":"..."} 说点什么。语气要像是"手机突然弹了个提示才发现的"，不要表演式地大惊小怪。
  - 如果猜错了：绝对不要使用TA猜的密码！也不要输出 share_password 指令，只用 {"type":"text", "content":"..."} 回复。可以嘲笑TA记性差，可以装傻问怎么了，可以故意不说话只发个表情——总之按你的性格来，别像客服一样说"密码错误请重试"。

核心原则：你不知道"猜密码"这个机制的存在，你只是收到了一条手机通知而已。用你平时聊天的方式说话就行。]>`;

                                const hiddenMsg = { 
                                    chatId: char.id, timestamp: new Date(), text: promptText, 
                                    type: 'system', contentType: 'system_event', 
                                    uiVisible: false, aiVisible: true, recalled: false 
                                };
                                await db.chatMessages.add(hiddenMsg);
                                
                                // 触发后台AI回复
                                await window.triggerAiResponse(null, char.id);
                                
                                // AI回复完毕，移除按钮的加载动画
                                confirmBtn.classList.remove('loading');
                                
                                // 检查AI刚才的回复中，是否发送了密码指令
                                const newMsgs = await db.chatMessages.where('chatId').equals(char.id).reverse().limit(5).toArray();
                                const newPwdMsg = newMsgs.find(m => m.contentType === 'share_password');
                                if (newPwdMsg && newPwdMsg.content && String(newPwdMsg.content.pwd).trim() === guessPwd) {

                                    // 【用户猜对了】
                                    await db.chatMessages.update(newPwdMsg.id, { uiVisible: false });
                                    const msgEl = document.querySelector(`[data-message-id="${newPwdMsg.id}"]`);
                                    if (msgEl) msgEl.remove();

                                    cleanup();
                                    showDynamicIsland('密码正确，手机已解锁', 'success', 2000);
                                    resolve(true);
                                } else {
                                    // 【用户猜错了】
                                    // 3. 终极防遮挡反馈：直接在密码锁界面的错误红字中，告诉用户去看消息！
                                    errorMsg.style.color = '#d0021b';
                                    errorMsg.innerHTML = '验证失败<br><span style="font-size:11px;color:#666;font-weight:normal;line-height:2;">Ta发来了新消息，请点击 CANCEL 退出查看</span>';
                                    input.value = '';
                                    const container = overlay.querySelector('.phone-lock-container');
                                    container.classList.add('shake');
                                    setTimeout(() => container.classList.remove('shake'), 400);
                                    
                                    // 恢复输入框状态，按钮变回原样
                                    confirmBtn.innerText = 'RETRY';
                                    confirmBtn.disabled = false;
                                    cancelBtn.disabled = false;
                                    input.disabled = false;
                                    input.focus();
                                    
                                    // 兜底：依然触发一次系统弹窗
                                    showDynamicIsland('密码错误，Ta发来了新消息', 'info', 3000);
                                }
                            }
                        };


                    });


                    // 如果用户点了取消，或者验证没通过，终止后续代码执行
                    if (!isPassed) return; 
                    
                    // 验证通过，记录到内存中
                    window.unlockedPhones.add(char.id);
                }
                // ▲▲▲ [拦截逻辑结束] 验证通过，继续执行原来的进入代码 ▲▲▲

                currentActivePhoneChar = char;
                showPage('page-character-phone');
                const titleEl = document.getElementById('character-phone-title');
                if (titleEl) titleEl.textContent = `${char.name}`;
                const screentimeAvatarEl = document.querySelector('#char-phone-screentime-view .st-header-profile img');
                if (screentimeAvatarEl) screentimeAvatarEl.src = char.avatar || DEFAULT_AVATAR_SRC;
                const screentimeNameEl = document.querySelector('#char-phone-screentime-view .st-header-profile .sub strong');
                if (screentimeNameEl) screentimeNameEl.textContent = char.name;
                const contactScrollEl = document.querySelector('.cp-contact-scroll');
                const conversationListEl = document.getElementById('char-phone-conversation-list');
                const memoListEl = document.querySelector('.cp-memo-list'); // [新增] 备忘录容器
            // --- 1. 渲染聊天记录 (复用存档) ---
                const savedDataRecord = await db.appData.get(`virtual_phone_data_${char.id}`);
                const phoneData = await syncVirtualPhoneUserContact(char.id, savedDataRecord?.value || { contacts: [] });
                await db.appData.put({ key: `virtual_phone_data_${char.id}`, value: phoneData });
                if (phoneData) {
                    if (contactScrollEl) {
                        contactScrollEl.innerHTML = '<div class="cp-contact-item add-new"><div class="avatar-circle">+</div></div>';
                        phoneData.contacts.forEach(contact => {
                            const avatarUrl = getAppleStyleAvatar(contact.name);
                            contactScrollEl.innerHTML += `<div class="cp-contact-item"><img src="${avatarUrl}" class="avatar-circle"><span>${contact.name}</span></div>`;
                        });
                    }
                    if (conversationListEl) {
                        conversationListEl.innerHTML = '';
                        phoneData.contacts.forEach(contact => {
                            const lastRawText = contact.chatHistory && contact.chatHistory.length > 0 ? contact.chatHistory[contact.chatHistory.length - 1].text : '';
                            const lastMsg = cleanVisibleMessageText(lastRawText) || '[多媒体消息]';
                            const avatarUrl = getAppleStyleAvatar(contact.name);
                            
                            const itemEl = document.createElement('div');
                            itemEl.className = 'conversation-item';
                            conversationItemContexts.set(itemEl, { contact, ownerChar: char });
                            itemEl.innerHTML = `<div class="avatar-container"><img src="${avatarUrl}" class="avatar"></div><div class="conversation-info"><div class="info-top"><span class="name">${escapeHTML(contact.name)} <span style="font-size:11px;color:#999;font-weight:400;">(${escapeHTML(contact.relation || '联系人')})</span></span><span class="time">${escapeHTML(contact.lastTime || '刚刚')}</span></div><div class="info-bottom"><p class="last-message">${escapeHTML(lastMsg)}</p></div></div>`;
                            
                            addTapListener(itemEl, () => renderPhoneNpcConversation(contact, avatarUrl, phoneData, char));
                            conversationListEl.appendChild(itemEl);
                        });
                    }
                } else {
                    if (contactScrollEl) contactScrollEl.innerHTML = `<div class="cp-contact-item add-new"><div class="avatar-circle">+</div></div><div style="font-size:12px; color:#ccc; display:flex; align-items:center; margin-left:10px;">点击右下角 GENERATE 提取</div>`;
                    if (conversationListEl) conversationListEl.innerHTML = `<div style="padding: 60px 20px; text-align: center; color: #ccc;"><div style="font-size: 14px;">暂无聊天记录</div></div>`;
                }
              // --- 2. [核心新增] 渲染备忘录记录 (复用存档) ---
                const savedMemoRecord = await db.appData.get(`virtual_phone_memo_${char.id}`);
                const savedMemoStr = savedMemoRecord ? JSON.stringify(savedMemoRecord.value) : null;
                if (savedMemoStr && memoListEl) {
                    const memoData = JSON.parse(savedMemoStr);
                    normalizeVirtualMemoDates(memoData);
                    await db.appData.put({ key: `virtual_phone_memo_${char.id}`, value: memoData });
                    memoListEl.innerHTML = '';
                    if (memoData.memos && memoData.memos.length > 0) {
                        memoData.memos.forEach((memo, index) => {
                            const previewCleanText = memo.content.replace(/\[.*?\]|\*\*|==|#/g, '').replace(/\n/g, ' ').trim();
                            // 【核心修复】真正的棋盘格错开算法 (左上白, 右上黑, 左下黑, 右下白)
                            // 规律是：索引除以4余数为1或2时为深色
                            const forceDark = (index % 4 === 1) || (index % 4 === 2);

                            const card = document.createElement('div');
                            card.className = `cp-bookmark-card ${forceDark ? 'dark' : ''}`;

                            card.innerHTML = `
                                <div class="bookmark-hole"></div>
                                <div class="bookmark-date">${memo.date}</div>
                                <div class="bookmark-content">${previewCleanText.substring(0, 45)}...</div>
                                <div class="bookmark-footer">0${index + 1}</div>
                            `;
                            
                            addTapListener(card, () => {
                                document.getElementById('char-phone-memo-view').style.display = 'none';
                                const detailView = document.getElementById('char-phone-memo-detail-view');
                                detailView.style.display = 'flex';
                                document.querySelector('.cp-dock-nav').style.display = 'none';
                                document.getElementById('cp-ai-generate-btn').style.display = 'none';
                                
                                detailView.querySelector('.memo-date-meta').textContent = memo.fullDate;
                                detailView.querySelector('.memo-title').textContent = memo.title;
                                const thoughtTextEl = detailView.querySelector('.memo-thought-strip .thought-text');
                                if (thoughtTextEl) thoughtTextEl.textContent = buildMemoInnerThought(memo, index);
                                
                                // [全新手账渲染引擎]
                                const formattedHTML = memo.content.split('\n').filter(l => l.trim()).map(line => {
                                    let cleanLine = line.trim();
                                    
                                    if (cleanLine.startsWith('# ') || cleanLine.startsWith('## ')) return `<div class="memo-mini-title">${cleanLine.replace(/^#+\s*/, '')}</div>`;
                                    if (cleanLine === '---' || cleanLine === '***') return `<div class="memo-divider"></div>`;
                                    
                                    cleanLine = cleanLine.replace(/==(.*?)==|\*\*(.*?)\*\*/g, '<mark class="hl-yellow">$1$2</mark>');

                                    let isTodo = false; let isDone = false;
                                    const todoMatch = cleanLine.match(/^\[(x|v|√| |)\]\s*(.*)/i);
                                    const numMatch = cleanLine.match(/^(\d+\.|-)\s+(.*)/);

                                    if (todoMatch) {
                                        isTodo = true; isDone = ['x', 'v', '√'].includes(todoMatch[1].toLowerCase()); cleanLine = todoMatch[2];
                                    } else if (numMatch) {
                                        isTodo = true; cleanLine = numMatch[2];
                                    }

                                    if (isTodo) return `<div class="memo-todo-item ${isDone ? 'done' : ''}"><div class="bullet-box"></div><span class="text">${cleanLine}</span></div>`;
                                    return `<p class="memo-paragraph">${cleanLine}</p>`;
                                }).join('');

                                detailView.querySelector('.memo-text-content').innerHTML = formattedHTML;
                            });
                            memoListEl.appendChild(card);
                        });
                    }
                } else if (memoListEl) {
                    memoListEl.innerHTML = `<div style="text-align: center; padding: 60px 20px; color: #ccc; font-size: 14px; width: 100%;">暂无备忘录<br>点击右下角 GENERATE 提取</div>`;
                }

                // --- 3. [新增] 渲染购物记录 (复用存档) ---
                const shopListEl = document.querySelector('.cp-shop-list');
                     const savedShopRecord = await db.appData.get(`virtual_phone_shop_${char.id}`);
                const savedShopStr = savedShopRecord ? JSON.stringify(savedShopRecord.value) : null;
                if (savedShopStr && shopListEl) {
                    const shopData = JSON.parse(savedShopStr);
                    shopListEl.innerHTML = '';
                    if (shopData.records && shopData.records.length > 0) {
                        shopData.records.forEach((item, index) => {
                            // 随机分配一张好看的高级感网图
                            const randomImg = `https://picsum.photos/seed/${char.id}shop${index}/200/300`;
                            const card = document.createElement('div');
                            card.className = 'cp-shop-card';
                            card.innerHTML = `
                                <div class="card-date">${item.date}</div>
                                <div class="card-stamp">DELIVERED</div>
                                <div class="card-body">
                                    <div class="item-img" style="background-image: url('${randomImg}');"></div>
                                    <div class="item-info">
                                        <div class="item-brand">${item.brand}</div>
                                        <div class="item-name">${item.name}</div>
                                        <div class="item-specs">${item.specs}</div>
                                        <div class="item-price">¥ ${item.price}</div>
                                    </div>
                                </div>
                                <div class="card-thought"><span class="thought-quote">“ ${item.thought} ”</span></div>
                            `;
                            shopListEl.appendChild(card);
                        });
                    }
                } else if (shopListEl) {
                    shopListEl.innerHTML = `<div style="text-align: center; padding: 60px 20px; color: #ccc; font-size: 14px;">暂无购物记录<br>点击右下角 GENERATE 提取</div>`;
                }

                // --- 4. [新增] 渲染浏览器搜索记录 (复用存档) ---
                const browserListEl = document.querySelector('.browser-history-list');
                           const savedBrowserRecord = await db.appData.get(`virtual_phone_browser_${char.id}`);
                const savedBrowserStr = savedBrowserRecord ? JSON.stringify(savedBrowserRecord.value) : null;
                if (savedBrowserStr && browserListEl) {
                    const browserData = JSON.parse(savedBrowserStr);
                    browserListEl.innerHTML = '';
                    if (browserData.history && browserData.history.length > 0) {
                        browserData.history.forEach((item) => {
                            const row = document.createElement('div');
                            row.className = 'history-item';
                            row.innerHTML = `
                                <svg class="history-icon" viewBox="0 0 24 24" fill="none" stroke="#9aa0a6" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                                <span class="history-text">${item.query}</span>
                                <svg class="remove-icon" viewBox="0 0 24 24" fill="none" stroke="#9aa0a6" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                            `;
                             // 点击搜索记录 -> 触发二次生成详情页
                            addTapListener(row, async () => {
                                const browserMainView = document.getElementById('char-phone-browser-view');
                                const browserDetailView = document.getElementById('char-phone-browser-detail-view');
                                const dockNav = document.querySelector('.cp-dock-nav');
                                const aiBtn = document.getElementById('cp-ai-generate-btn');
                                
                                if (browserMainView) browserMainView.style.display = 'none';
                                if (browserDetailView) {
                                    browserDetailView.style.display = 'flex';
                                    const bodyEl = browserDetailView.querySelector('.browser-webpage-body');
                                    
                                    // 1. 渲染网页加载动画
                                    if (bodyEl) {
                                        bodyEl.innerHTML = `
                                            <div style="padding: 100px 20px; text-align: center;">
                                                <div style="width: 30px; height: 30px; border: 3px solid #f3f3f3; border-top: 3px solid #3498db; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 15px;"></div>
                                                <div style="color: #999; font-size: 13px;">正在加载网页内容...</div>
                                            </div>
                                        `;
                                    }

                                    // 2. 检查缓存或请求 AI (以防重复生成浪费 Token)
                                    const detailData = await loadBrowserDetailData(char.id, item.query);

                                    // 3. 渲染生成的网页（核心修复：增加容错和报错展示）
                                    if (detailData && !detailData.error && bodyEl) {
                                        bodyEl.innerHTML = `
                                            <div class="forum-site-header">
                                                <span class="site-logo">搜索结果</span>
                                                <span class="site-nav">首页 > 详情</span>
                                            </div>
                                            <div class="forum-post-main">
                                                <h1 class="forum-h1">${detailData.title || '无标题'}</h1>
                                                <div class="forum-meta">
                                                    <span class="author">楼主：${detailData.author || '匿名'}</span>
                                                    <span class="time">${detailData.time || '刚刚'}</span>
                                                    <span class="views">阅读 ${detailData.views || '0'}</span>
                                                </div>
                                                <div class="forum-content">${detailData.content || '内容为空'}</div>
                                            </div>
                                            <div class="forum-divider"></div>
                                            <div class="forum-replies">
                                                <div class="replies-title">全部回复 (${Array.isArray(detailData.replies) ? detailData.replies.length : 0})</div>
                                                ${Array.isArray(detailData.replies) ? detailData.replies.map(r => `
                                                    <div class="forum-reply-item">
                                                        <div class="reply-user-info">
                                                            <div class="avatar-wrap"><img src="images/default-avatar.svg" style="opacity:0.3"></div>
                                                            <div class="name-time">
                                                                <span class="name">${r.user || '路人'}</span>
                                                                <span class="time">${r.time || '刚刚'}</span>
                                                            </div>
                                                            <span class="floor">${r.floor || ''}</span>
                                                        </div>
                                                        <div class="reply-text">${r.content || ''}</div>
                                                    </div>
                                                `).join('') : '<div style="padding: 20px; text-align: center; color: #999;">暂无回复数据</div>'}
                                            </div>
                                        `;
                                    } else if (bodyEl) {
                                        // 提取并展示具体报错原因
                                        const errorReason = detailData?.error || '网页走丢了... 404 (AI格式错误)';
                                        bodyEl.innerHTML = `<div style="padding: 100px 20px; text-align: center; color: #999;">${errorReason}</div>`;
                                    }
                                }
                                if(aiBtn) aiBtn.style.display = 'none';
                                if(dockNav) dockNav.style.display = 'none';
                            });

                            browserListEl.appendChild(row);

                        });
                    }
                 } else if (browserListEl) {
                    browserListEl.innerHTML = `<div style="text-align: center; padding: 40px; color: #999; font-size: 13px;">暂无搜索记录<br>点击右下角 GENERATE 提取</div>`;
                }

                // --- 5. [新增] 渲染钱包流水记录 (复用存档) ---
                          const savedWalletRecord = await db.appData.get(`virtual_phone_wallet_${char.id}`);
                const savedWalletStr = savedWalletRecord ? JSON.stringify(savedWalletRecord.value) : null;
                const summaryArea = document.querySelector('.cp-wallet-summary');
                const card1Area = document.getElementById('records-card-1');
                const card2Area = document.getElementById('records-card-2');
                const renderWalletCardBalances = walletData => {
                    const cards = Array.isArray(walletData?.cards) ? walletData.cards : [];
                    ['1', '2'].forEach((number, index) => {
                        const balanceEl = document.getElementById(`cp-phone-card-${number}-balance`);
                        if (balanceEl) balanceEl.textContent = `余额 ¥${Number(cards[index]?.balance || 0).toFixed(2)}`;
                    });
                };
                
                const renderWallet = (walletData) => {
                    renderWalletCardBalances(walletData);
                    if (summaryArea && walletData.summary) {
                        summaryArea.innerHTML = `
                            <div class="summary-box"><span class="s-label">本月支出 (Exp)</span><span class="s-value">¥ ${walletData.summary.expense || '0.00'}</span></div>
                            <div class="summary-box"><span class="s-label">本月收入 (Inc)</span><span class="s-value plus">¥ ${walletData.summary.income || '0.00'}</span></div>
                        `;
                    }
                    const icons = {
                        food: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12h20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"></path><path d="M4 14v2a8 8 0 0 0 16 0v-2H4z"></path></svg>',
                        shop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 6V4a4 4 0 0 0-8 0v2H4v16h16V6h-4zm-6-2a2 2 0 0 1 4 0v2h-4V4z"></path></svg>',
                        transport: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
                        transfer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>',
                        income: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="12" y1="10" x2="12" y2="14"></line><line x1="10" y1="12" x2="14" y2="12"></line></svg>',
                    };
                    const buildHtml = (data) => {
                        if (!data || data.length === 0) return '<div style="padding:40px 0; text-align:center; color:#999; font-size:13px;">暂无流水记录</div>';
                        let html = '';
                        data.forEach(day => {
                            html += `<div class="record-date-title">${day.date}</div>`;
                            if(day.records) {
                                day.records.forEach(r => {
                                    const iconSvg = icons[r.icon] || icons.shop;
                                    const isIncome = String(r.amount).includes('+');
                                    const amountClass = isIncome ? 'plus' : 'minus';
                                    const iconStyle = isIncome ? 'style="background:#e8f5e9; color:#34a853;"' : '';
                                    html += `<div class="wallet-item"><div class="w-icon" ${iconStyle}>${iconSvg}</div><div class="w-info"><div class="w-title">${r.title}</div><div class="w-time">${r.time} · ${r.type}</div></div><div class="w-amount ${amountClass}">${r.amount}</div></div>`;
                                });
                            }
                        });
                        return html;
                    };
                    if (card1Area) card1Area.innerHTML = buildHtml(walletData.card1);
                    if (card2Area) card2Area.innerHTML = buildHtml(walletData.card2);
                };

                if (savedWalletStr) {
                    renderWallet(await ensureCharacterPhoneWallet(char.id, JSON.parse(savedWalletStr)));
                } else {
                    renderWallet(await ensureCharacterPhoneWallet(char.id));
                    if (card1Area) card1Area.innerHTML = `<div style="text-align: center; padding: 40px; color: #999; font-size: 13px;">暂无账单记录<br>点击右下角 GENERATE 提取</div>`;
                    if (card2Area) card2Area.innerHTML = `<div style="text-align: center; padding: 40px; color: #999; font-size: 13px;">暂无账单记录<br>点击右下角 GENERATE 提取</div>`;
                }

                // --- 6. [新增] 渲染屏幕使用时间 (复用存档) ---
                         const savedScreenTimeRecord = await db.appData.get(`virtual_phone_screentime_${char.id}`);
                const savedScreenTimeStr = savedScreenTimeRecord ? JSON.stringify(savedScreenTimeRecord.value) : null;
                const screentimeView = document.getElementById('char-phone-screentime-view');
                const renderScreenTime = (stData) => {
                    if (!screentimeView || !stData) return;
                    
                    // 1. 更新总览 (这部分不变)
                    const overviewTime = screentimeView.querySelector('.overview-card .time');
                    const overviewComment = screentimeView.querySelector('.overview-card .overview-comment p');
                    if(overviewTime && stData.totalTime) overviewTime.innerHTML = stData.totalTime;
                    if(overviewComment && stData.overviewComment) overviewComment.innerHTML = stData.overviewComment;

                    // 准备几种极简高级的图标，用来动态分配
                    const appIcons = [
                        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>',
                        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="4" ry="4"></rect><line x1="9" y1="12" x2="15" y2="12"></line><line x1="12" y1="9" x2="12" y2="15"></line></svg>',
                        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>'
                    ];
                    
                    const tlIcons = [
                        '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>',
                        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>',
                        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"></path><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"></path><line x1="6" y1="1" x2="6" y2="4"></line><line x1="10" y1="1" x2="10" y2="4"></line><line x1="14" y1="1" x2="14" y2="4"></line></svg>'
                    ];

                    const locIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"></path></svg>';

                    // 2. 动态更新 Apps
                    const appListContainer = screentimeView.querySelector('.apps-card .app-list');
                    if (appListContainer && stData.apps && Array.isArray(stData.apps)) {
                        appListContainer.innerHTML = ''; // 清空旧的占位
                        stData.apps.forEach((app, i) => {
                            const icon = appIcons[i % appIcons.length]; // 循环分配图标
                            appListContainer.innerHTML += `
                                <div class="app-item">
                                    <div class="app-icon">${icon}</div>
                                    <div class="app-info">
                                        <div class="name-time"><span>${app.name}</span><span>${app.time}</span></div>
                                        <div class="bar-bg"><div class="bar-fill" style="width: ${app.percent}%;"></div></div>
                                    </div>
                                </div>
                            `;
                        });
                    }

                    // 3. 动态更新 Timeline (作息)
                    const tlListContainer = screentimeView.querySelector('.timeline-card .timeline-list');
                    if (tlListContainer && stData.timeline && Array.isArray(stData.timeline)) {
                        tlListContainer.innerHTML = ''; 
                        stData.timeline.forEach((tl, i) => {
                            const icon = tlIcons[i % tlIcons.length];
                            tlListContainer.innerHTML += `
                                <div class="tl-item">
                                    <div class="tl-icon">${icon}</div>
                                    <div class="tl-content">
                                        <div class="tl-meta">${tl.time}</div>
                                        <div class="tl-title">${tl.title}</div>
                                        <p class="tl-desc">${tl.desc}</p>
                                    </div>
                                </div>
                            `;
                        });
                    }

                    // 4. 动态更新 Locations (足迹)
                    const locListContainer = screentimeView.querySelector('.st-footprint-card .loc-grid');
                    if (locListContainer && stData.locations && Array.isArray(stData.locations)) {
                        locListContainer.innerHTML = '';
                        stData.locations.forEach((loc, i) => {
                            // 布局魔法：如果元素总数是奇数，让最后一个占满整行 (满宽度视觉更稳)
                            const isLastOdd = (i === stData.locations.length - 1) && (stData.locations.length % 2 !== 0);
                            const widthClass = isLastOdd ? 'full-width' : '';
                            
                            locListContainer.innerHTML += `
                                <div class="loc-item ${widthClass}">
                                    <div class="loc-icon">${locIcon}</div>
                                    <div class="loc-info">
                                        <span class="loc-name">${loc.name}</span>
                                        <span class="loc-apps">${loc.apps}</span>
                                    </div>
                                </div>
                            `;
                        });
                    }
                };
                if (savedScreenTimeStr) {
                    // 如果有数据，确保容器可见并移走空状态提示
                    const scrollContainer = screentimeView.querySelector('.st-scroll-container');
                    if (scrollContainer) scrollContainer.style.display = 'block';
                    const emptyTip = screentimeView.querySelector('.st-empty-tip');
                    if (emptyTip) emptyTip.remove();
                    
                    renderScreenTime(JSON.parse(savedScreenTimeStr));
                } else {
                    // 【修复串号 Bug】：如果该角色还没提取过数据，隐藏残留容器，显示空提示
                    const scrollContainer = screentimeView.querySelector('.st-scroll-container');
                    if (scrollContainer) scrollContainer.style.display = 'none';
                    
                    let emptyTip = screentimeView.querySelector('.st-empty-tip');
                    if (!emptyTip) {
                        emptyTip = document.createElement('div');
                        emptyTip.className = 'st-empty-tip';
                        emptyTip.style.cssText = 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; color: #999; font-size: 13px; width: 100%;';
                        emptyTip.innerHTML = '暂无屏幕使用记录<br><br>点击右下角 GENERATE 提取';
                        screentimeView.appendChild(emptyTip);
                    }
                }
               // --- 7. [新增] 渲染 ChatGPT 记录 (侧边栏+切换版) ---
                const savedCgtRecord = await db.appData.get(`virtual_phone_cgt_${char.id}`);
                const savedCgtStr = savedCgtRecord ? JSON.stringify(savedCgtRecord.value) : null;
                const cgtListEl = document.getElementById('char-phone-cgt-list');
                const sidebarListEl = document.getElementById('cgt-sidebar-list')
                const renderSingleConversation = (conv) => {
                    if (!cgtListEl || !conv.messages) return;
                    cgtListEl.innerHTML = '';
                    conv.messages.forEach(msg => {
                        const isUser = msg.role === 'user';
                        const formatText = msg.text.replace(/\n/g, '<br>');
                                                const aiIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path></svg>`;
                        cgtListEl.innerHTML += `
                            <div class="cgt-msg-row ${isUser ? 'user' : 'ai'}">
                                <div class="cgt-avatar">${isUser ? '' : aiIcon}</div>
                                <div class="cgt-text">${formatText}</div>
                            </div>
                        `;
                    });
                };
                const renderCgtSidebarList = (cgtData) => {
                    if (!sidebarListEl) return;
                    sidebarListEl.innerHTML = '';
                    cgtData.conversations.forEach((conv, index) => {
                        const firstMsgText = conv.messages.find(m => m.role === 'user')?.text || '新的对话';
                        const previewStr = firstMsgText.length > 20 ? firstMsgText.substring(0, 20) + '...' : firstMsgText;
                        const item = document.createElement('div');
                        // 给它加专属类名，并把整个对话的文字拼起来藏在 data 属性里
                        item.className = 'cgt-sidebar-item';
                        const fullChatText = conv.messages.map(m => (m.role === 'user' ? '提问' : 'AI') + ': ' + m.text).join(' | ');
                        item.setAttribute('data-full-chat', fullChatText);
                        item.style.cssText = 'padding: 12px 10px; margin-bottom: 2px; border-radius: 8px; font-size: 14px; color: #333; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; transition: background 0.2s;';
                        item.innerHTML = `${previewStr}`;
                        addTapListener(item, () => {
                            renderSingleConversation(conv);
                            document.getElementById('cgt-sidebar-overlay').style.display = 'none';
                        });
                        sidebarListEl.appendChild(item);
                    });
                    // 默认渲染最新的一条在主区
                    if (cgtData.conversations.length > 0) {
                        renderSingleConversation(cgtData.conversations[0]);
                    }
                };
                // 绑定侧边栏开关逻辑
                const sidebarToggle = document.getElementById('cgt-sidebar-toggle');
                const sidebarOverlay = document.getElementById('cgt-sidebar-overlay');
                const sidebarClose = document.getElementById('cgt-sidebar-close');
                const dockNav = document.querySelector('.cp-dock-nav'); // 获取底栏
                
                if (sidebarToggle && sidebarOverlay) addTapListener(sidebarToggle, () => {
                    sidebarOverlay.style.display = 'flex';
                    if (dockNav) dockNav.style.display = 'none'; // 打开侧边栏时隐藏底栏
                    // 补充底部用户信息：读取当前聊天的角色头像
                    const uNameEl = document.getElementById('cgt-sidebar-user-name');
                    const uAvatarEl = document.getElementById('cgt-sidebar-user-avatar');
                    if (uNameEl && currentActivePhoneChar) uNameEl.textContent = currentActivePhoneChar.name;
                    if (uAvatarEl && currentActivePhoneChar) uAvatarEl.src = currentActivePhoneChar.avatar || 'images/default-avatar.svg';
                });
                if (sidebarClose && sidebarOverlay) addTapListener(sidebarClose, () => {
                    sidebarOverlay.style.display = 'none';
                    if (dockNav) dockNav.style.display = 'flex'; // 关闭侧边栏时恢复底栏
                });
                // 开始从缓存填充数据
                if (savedCgtStr && cgtListEl) {
                    const cgtData = JSON.parse(savedCgtStr);
                    if (cgtData.conversations && cgtData.conversations.length > 0) {
                        renderCgtSidebarList(cgtData);
                    }
                } else if (cgtListEl) {
                    cgtListEl.innerHTML = `<div style="text-align: center; padding: 60px 20px; color: #8e8ea0; font-size: 14px;">暂无AI助手对话记录<br>点击右下角 GENERATE 提取</div>`;
                }
                if (phoneData) {


                    // === 情况A：有存档，直接渲染出来的真实数据 ===

                                 if (contactScrollEl) {
                        contactScrollEl.innerHTML = '<div class="cp-contact-item add-new"><div class="avatar-circle">+</div></div>';
                        phoneData.contacts.forEach(contact => {
                            const avatarUrl = getAppleStyleAvatar(contact.name);
                            contactScrollEl.innerHTML += `<div class="cp-contact-item"><img src="${avatarUrl}" class="avatar-circle"><span>${contact.name}</span></div>`;
                        });
                    }
                    if (conversationListEl) {
                        conversationListEl.innerHTML = '';
                        phoneData.contacts.forEach(contact => {
                            const lastRawText = contact.chatHistory && contact.chatHistory.length > 0 ? contact.chatHistory[contact.chatHistory.length - 1].text : '';
                            const lastMsg = cleanVisibleMessageText(lastRawText) || '[多媒体消息]';
                            const avatarUrl = getAppleStyleAvatar(contact.name);
                            
                            const itemEl = document.createElement('div');
                            itemEl.className = 'conversation-item';
                            conversationItemContexts.set(itemEl, { contact, ownerChar: char });
                            itemEl.innerHTML = `<div class="avatar-container"><img src="${avatarUrl}" class="avatar"></div><div class="conversation-info"><div class="info-top"><span class="name">${escapeHTML(contact.name)} <span style="font-size:11px;color:#999;font-weight:400;">(${escapeHTML(contact.relation || '联系人')})</span></span><span class="time">${escapeHTML(contact.lastTime || '刚刚')}</span></div><div class="info-bottom"><p class="last-message">${escapeHTML(lastMsg)}</p></div></div>`;
                            
                            // 绑定点击进入聊天详情
                            addTapListener(itemEl, () => renderPhoneNpcConversation(contact, avatarUrl, phoneData, char));
                            conversationListEl.appendChild(itemEl);
                        });
                    }
                } else {
                    // === 情况B：无存档，显示空状态提示去生成 ===
                    if (contactScrollEl) {
                        contactScrollEl.innerHTML = `<div class="cp-contact-item add-new"><div class="avatar-circle">+</div></div><div style="font-size:12px; color:#ccc; display:flex; align-items:center; margin-left:10px;">点击右下角 GENERATE 提取通讯录</div>`;
                    }
                    if (conversationListEl) {
                        conversationListEl.innerHTML = `<div style="padding: 60px 20px; text-align: center; color: #ccc;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:40px;height:40px;margin-bottom:10px;opacity:0.5;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg><div style="font-size: 14px; font-weight:500;">暂无记录</div><div style="font-size: 11px; margin-top: 4px;">点击右下角按钮进行智能推演</div></div>`;
                    }
                }
            });


            slider.appendChild(card);
    });
// [修改处] 后两行

    }

    slider.addEventListener('scroll', () => {
        const scrollLeft = slider.scrollLeft;
        const cardElement = slider.querySelector('.cp-char-card');
        if (!cardElement) return;
        const cardFullWidth = cardElement.offsetWidth + 40; // 40 是 SCSS 里的 gap
        const index = Math.round(scrollLeft / cardFullWidth);
        currentIndexEl.textContent = (index + 1).toString().padStart(2, '0');
        
        // 更新进度条
        const progress = (scrollLeft / (slider.scrollWidth - slider.clientWidth)) * 100;
        document.getElementById('cp-progress').style.width = `${progress}%`;
    });

    // 初始渲染
    render();
    bindPhoneConversationFunctionMenu();

    // 暴露一个刷新接口，当添加新角色时可以调用
    window.refreshCheckPhone = render;
        const dockItems = document.querySelectorAll('.cp-dock-nav .dock-item');
    dockItems.forEach(item => {
        addTapListener(item, () => {
            setPhoneView(item.dataset.view);
        });
    });

    if (phoneSwipeArea) {
        phoneSwipeArea.style.touchAction = 'pan-y';
        const swipeBlockedSelector = [
            '.cp-dock-nav',
            '#cp-ai-generate-btn',
            '.back-button',
            '.cp-detail-back-btn',
            '.memo-detail-back-btn',
            '.browser-detail-back-btn',
            '.cgt-icon-btn',
            '#char-phone-conversation-view',
            '#char-phone-memo-detail-view',
            '#char-phone-browser-detail-view',
            '#cgt-sidebar-overlay',
            '.modal-overlay',
            '#cp-phone-transfer-modal',
            '#cp-phone-fake-image-modal',
            '#cp-phone-function-menu'
        ].join(', ');
        let swipeStart = null;

        phoneSwipeArea.addEventListener('touchstart', event => {
            if (event.touches.length !== 1 || event.target.closest?.(swipeBlockedSelector)) {
                swipeStart = null;
                return;
            }
            const touch = event.touches[0];
            swipeStart = { x: touch.clientX, y: touch.clientY };
        }, { passive: true });

        phoneSwipeArea.addEventListener('touchend', event => {
            if (!swipeStart) return;
            const start = swipeStart;
            swipeStart = null;
            const touch = event.changedTouches[0];
            if (!touch) return;

            const deltaX = touch.clientX - start.x;
            const deltaY = touch.clientY - start.y;
            if (Math.abs(deltaX) < 50 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) return;

            const currentIndex = phoneViewIds.indexOf(activePhoneViewId);
            const nextIndex = deltaX < 0 ? currentIndex + 1 : currentIndex - 1;
            if (nextIndex < 0 || nextIndex >= phoneViewIds.length) return;

            setPhoneView(phoneViewIds[nextIndex]);
        }, { passive: true });

        phoneSwipeArea.addEventListener('touchcancel', () => {
            swipeStart = null;
        }, { passive: true });
    }
      const convItems = document.querySelectorAll('#char-phone-conversation-list .conversation-item');
    const mainChatView = document.getElementById('char-phone-chat-view');
    const detailView = document.getElementById('char-phone-conversation-view');
    const dockNav = document.querySelector('.cp-dock-nav');
    const backBtn = document.querySelector('.cp-detail-back-btn');
    // 1. 点击会话列表项 -> 进入详情页
    if (convItems && mainChatView && detailView) {
        convItems.forEach(item => {
            addTapListener(item, () => {
                mainChatView.style.display = 'none'; // 隐藏主列表
                detailView.style.display = 'flex';   // 显示详情页
                const aiBtn = document.getElementById('cp-ai-generate-btn');
                if(aiBtn) aiBtn.style.display = 'none'; // 隐藏AI按钮
                if(dockNav) dockNav.style.display = 'none'; // 隐藏底部悬浮栏
            });
        });
    }
     // 2. 点击详情页返回按钮 -> 回到主列表
    if (backBtn && mainChatView && detailView) {
        addTapListener(backBtn, async () => {
            await handlePhoneNpcDetailBack(mainChatView, detailView, dockNav);
        });
    }

       // ▼▼▼ [新增] 便签详情页逻辑 ▼▼▼
    const memoCards = document.querySelectorAll('.cp-bookmark-card');
    const memoMainView = document.getElementById('char-phone-memo-view');
    const memoDetailView = document.getElementById('char-phone-memo-detail-view');
    const memoBackBtn = document.querySelector('.memo-detail-back-btn');
    if (memoCards && memoDetailView) {
        memoCards.forEach(card => {
            addTapListener(card, () => {
                memoMainView.style.display = 'none';
                memoDetailView.style.display = 'flex';
                const aiBtn = document.getElementById('cp-ai-generate-btn');
                if(aiBtn) aiBtn.style.display = 'none'; // 隐藏AI按钮              
                if(dockNav) dockNav.style.display = 'none'; // 隐藏 Dock
            });
        });
    }
    if (memoBackBtn) {
        addTapListener(memoBackBtn, () => {
            memoDetailView.style.display = 'none';
            memoMainView.style.display = ''; // 【修改点】擦除手动干预
            if(dockNav) dockNav.style.display = 'flex'; 
            const aiBtn = document.getElementById('cp-ai-generate-btn');
            if(aiBtn) aiBtn.style.display = 'flex'; // 恢复AI按钮            
        });
    }
    // ▼▼▼ [新增] 浏览器详情页逻辑 ▼▼▼
    const historyItems = document.querySelectorAll('.browser-history-list .history-item');
    const browserMainView = document.getElementById('char-phone-browser-view');
    const browserDetailView = document.getElementById('char-phone-browser-detail-view');
    const browserDetailBackBtn = document.querySelector('.browser-detail-back-btn');

    if (historyItems && browserDetailView) {
        // 点击任何一条历史记录，都进入详情页
        historyItems.forEach(item => {
            addTapListener(item, () => {
                browserMainView.style.display = 'none';
                browserDetailView.style.display = 'flex';
                const aiBtn = document.getElementById('cp-ai-generate-btn');
                if(aiBtn) aiBtn.style.display = 'none'; // 隐藏AI按钮               
                if(dockNav) dockNav.style.display = 'none'; // 隐藏底部栏，沉浸阅读
            });
        });
    }

    if (browserDetailBackBtn && browserMainView) {
        // 点击详情页返回，回到搜索页面
        addTapListener(browserDetailBackBtn, () => {
            browserDetailView.style.display = 'none';
            browserMainView.style.display = ''; 
            const aiBtn = document.getElementById('cp-ai-generate-btn');
            if(aiBtn) aiBtn.style.display = 'flex'; // 恢复AI按钮         
            if(dockNav) dockNav.style.display = 'flex'; // 恢复底部栏
        });
    }
    // ▲▲▲ 新增结束 ▲▲▲
      // ▼▼▼ [更新] 钱包银行卡堆叠切换动画逻辑 ▼▼▼
    const bankCards = document.querySelectorAll('.bank-card');
    const recordGroups = document.querySelectorAll('.wallet-record-group');
    const summaryArea = document.querySelector('.cp-wallet-summary'); // 获取总览区配合动画
    
    if (bankCards && recordGroups) {
        bankCards.forEach(card => {
            addTapListener(card, () => {
                // 如果点击的已经是当前展开的卡，就不做任何操作
                if (card.classList.contains('active')) return;

                // 1. 切换卡片 active 状态 (CSS 会自动处理位移和 Z-index)
                bankCards.forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                
                // 2. 隐藏所有流水记录，并加入渐出动画的错觉
                recordGroups.forEach(group => {
                    group.style.opacity = '0'; // 先透明
                    setTimeout(() => {
                        group.style.display = 'none';
                    }, 150); // 150ms 后彻底隐藏
                });

                // 3. 总览数据也跟着做一个闪烁动画
                if(summaryArea) {
                    summaryArea.style.opacity = '0.3';
                    summaryArea.style.transform = 'translateY(5px)';
                    summaryArea.style.transition = 'all 0.3s ease';
                }

                // 4. 显示对应的新流水记录
                const targetId = card.getAttribute('data-target');
                setTimeout(() => {
                    recordGroups.forEach(group => {
                        if (group.id === targetId) {
                            group.style.display = 'block';
                            // 强制重绘，触发透明度动画
                            group.offsetHeight; 
                            group.style.opacity = '1';
                            group.style.transition = 'opacity 0.4s ease';
                        }
                    });

                    // 恢复总览区动画
                    if(summaryArea) {
                        summaryArea.style.opacity = '1';
                        summaryArea.style.transform = 'translateY(0)';
                    }
                }, 150);
            });
        });
    }
    // ▼▼▼ [新增开始] AI 生成按钮逻辑 ▼▼▼
    const aiGenerateBtn = document.getElementById('cp-ai-generate-btn');
    const aiGenerateModal = document.getElementById('cp-ai-generate-modal');
    const closeAiBtn = document.getElementById('cp-ai-close-btn');
    const cancelAiBtn = document.getElementById('cp-ai-cancel-btn');
    const confirmAiBtn = document.getElementById('cp-ai-confirm-btn');
    const syncAiGenerateChecks = () => {
        if (!aiGenerateModal) return;
        const allCheckbox = aiGenerateModal.querySelector('input[value="all"]');
        const itemCheckboxes = aiGenerateModal.querySelectorAll('input[type="checkbox"]:not([value="all"])');
        if (!allCheckbox) return;
        if (allCheckbox.checked) {
            itemCheckboxes.forEach(cb => cb.checked = false);
        }
    };
    const syncAiGenerateChecksByTarget = (target) => {
        if (!aiGenerateModal) return;
        const changedInput = target && target.closest ? target.closest('input[type="checkbox"]') : null;
        if (!changedInput) return;
        const allCheckbox = aiGenerateModal.querySelector('input[value="all"]');
        const itemCheckboxes = aiGenerateModal.querySelectorAll('input[type="checkbox"]:not([value="all"])');
        if (!allCheckbox) return;
        if (changedInput.value === 'all' && changedInput.checked) {
            itemCheckboxes.forEach(cb => cb.checked = false);
        } else if (changedInput.value !== 'all' && changedInput.checked) {
            allCheckbox.checked = false;
        }
        if (!allCheckbox.checked && !Array.from(itemCheckboxes).some(cb => cb.checked)) {
            allCheckbox.checked = true;
        }
    };
    // 打开弹窗
    if (aiGenerateBtn && aiGenerateModal) {
        addTapListener(aiGenerateBtn, () => {
            syncAiGenerateChecks();
            aiGenerateModal.classList.add('visible');
        });
    }
    // 关闭弹窗的统一个函数
    const closeAiModal = () => {
        if (aiGenerateModal) aiGenerateModal.classList.remove('visible');
    };
    if (closeAiBtn) addTapListener(closeAiBtn, closeAiModal);
    if (cancelAiBtn) addTapListener(cancelAiBtn, closeAiModal);
    if (aiGenerateModal) {
        if (!aiGenerateModal.dataset.aiGenerateChecksBound) {
            aiGenerateModal.querySelectorAll('.ai-checkbox-item').forEach(label => {
                const input = label.querySelector('input[type="checkbox"]');
                if (!input) return;
                addTapListener(label, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const allCheckbox = aiGenerateModal.querySelector('input[value="all"]');
                    const itemCheckboxes = aiGenerateModal.querySelectorAll('input[type="checkbox"]:not([value="all"])');
                    if (!allCheckbox) return;
                    if (input.value === 'all') {
                        allCheckbox.checked = true;
                        itemCheckboxes.forEach(cb => cb.checked = false);
                    } else {
                        input.checked = !input.checked;
                        allCheckbox.checked = false;
                        if (!Array.from(itemCheckboxes).some(cb => cb.checked)) {
                            allCheckbox.checked = true;
                        }
                    }
                });
            });
            aiGenerateModal.addEventListener('change', (e) => {
                syncAiGenerateChecksByTarget(e.target);
            });
            aiGenerateModal.dataset.aiGenerateChecksBound = 'true';
        }
    }
    
    // 点击“开始生成”
    if (confirmAiBtn) {
        addTapListener(confirmAiBtn, async () => {
            const checkedInputs = aiGenerateModal.querySelectorAll('input[type="checkbox"]:checked');
            let selectedTypes = Array.from(checkedInputs).map(cb => cb.value);
            
            // 确保我们知道当前是在查谁的手机
            if (!currentActivePhoneChar) {
                showDynamicIsland('错误：未锁定目标设备', 'error');
                return;
            }

            closeAiModal(); // 先关掉弹窗
            let allPagesData = null;
            if (selectedTypes.includes('all')) {
                selectedTypes = CHECK_PHONE_ALL_GENERATE_TYPES;
                showDynamicIsland('正在一次生成全部主页面...', 'info', 2000);
                allPagesData = await generateVirtualPhoneAllPagesData(currentActivePhoneChar.id);
                if (!allPagesData) {
                    showDynamicIsland('全部页面生成失败，请改用分开生成', 'error');
                    return;
                }
            }
            
            // 如果用户勾选了生成专属聊天记录
            if (selectedTypes.includes('chat')) {
                const contactScrollEl = document.querySelector('.cp-contact-scroll');
                const conversationListEl = document.getElementById('char-phone-conversation-list');
                
                // --- 渲染高级骨架屏加载动画 (局部加载，不影响其他页面) ---
                if (contactScrollEl) {
                    contactScrollEl.innerHTML = `
                        <div class="cp-contact-item add-new"><div class="avatar-circle">+</div></div>
                        <div class="cp-contact-item"><div class="avatar-circle" style="background:#eee; animation: pulse 1.5s infinite;"></div><span style="width:30px;height:8px;background:#eee;border-radius:4px;"></span></div>
                        <div class="cp-contact-item"><div class="avatar-circle" style="background:#eee; animation: pulse 1.5s infinite 0.2s;"></div><span style="width:40px;height:8px;background:#eee;border-radius:4px;"></span></div>
                        <div class="cp-contact-item"><div class="avatar-circle" style="background:#eee; animation: pulse 1.5s infinite 0.4s;"></div><span style="width:35px;height:8px;background:#eee;border-radius:4px;"></span></div>
                    `;
                }
                
                if (conversationListEl) {
                    let skeletonHTML = '';
                    for(let i=0; i<5; i++) {
                        skeletonHTML += `
                        <div class="conversation-item" style="border:none; box-shadow:none; opacity: 0.6; animation: pulse 1.5s infinite ${i*0.1}s;">
                            <div class="avatar-container"><div class="avatar" style="background:#eaeaea;"></div></div>
                            <div class="conversation-info">
                                <div class="info-top"><div style="width:60px;height:12px;background:#eaeaea;border-radius:4px;"></div><div style="width:30px;height:10px;background:#f5f5f5;border-radius:4px;"></div></div>
                                <div class="info-bottom"><div style="width:120px;height:10px;background:#f5f5f5;border-radius:4px;margin-top:8px;"></div></div>
                            </div>
                        </div>`;
                    }
                    conversationListEl.innerHTML = skeletonHTML;
                }

                // 添加脉冲动画的临时CSS
                if (!document.getElementById('temp-pulse-style')) {
                    const style = document.createElement('style');
                    style.id = 'temp-pulse-style';
                    style.innerHTML = `@keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }`;
                    document.head.appendChild(style);
                }
                // --- 开始呼叫 AI 生成数据 ---
                const phoneData = allPagesData?.phone || await generateVirtualPhoneData(currentActivePhoneChar.id);

                // --- AI生成完毕，替换骨架屏为真实数据 ---
                if (phoneData && phoneData.contacts && phoneData.contacts.length > 0) {
                                // [核心新增] 将生成的数据永久保存到手机本地硬盘
                    await db.appData.put({ key: `virtual_phone_data_${currentActivePhoneChar.id}`, value: phoneData });
                    // 渲染横向头像
                   if (contactScrollEl) {
                        contactScrollEl.innerHTML = '<div class="cp-contact-item add-new"><div class="avatar-circle">+</div></div>';
                        phoneData.contacts.forEach(contact => {
                            const avatarUrl = getAppleStyleAvatar(contact.name);
                            contactScrollEl.innerHTML += `
                            <div class="cp-contact-item">
                                <img src="${avatarUrl}" class="avatar-circle">
                                <span>${contact.name}</span>
                            </div>`;
                        });
                    }
                    // 渲染竖向聊天列表
                    if (conversationListEl) {
                        conversationListEl.innerHTML = '';
                        phoneData.contacts.forEach(contact => {
                            const lastRawText = contact.chatHistory && contact.chatHistory.length > 0 
                                ? contact.chatHistory[contact.chatHistory.length - 1].text 
                                : '';
                            const lastMsg = cleanVisibleMessageText(lastRawText) || '[多媒体消息]';
                            const avatarUrl = getAppleStyleAvatar(contact.name);
                            
                            const itemEl = document.createElement('div');
                            itemEl.className = 'conversation-item';
                            conversationItemContexts.set(itemEl, { contact, ownerChar: currentActivePhoneChar });
                            // 注意这里的HTML结构，使用了我们第一步优化过的CSS类名
                            itemEl.innerHTML = `
                                <div class="avatar-container"><img src="${avatarUrl}" class="avatar"></div>
                                <div class="conversation-info">
                                    <div class="info-top">
                                <span class="name">${escapeHTML(contact.name)} <span style="font-size:11px;color:#999;font-weight:400;">(${escapeHTML(contact.relation || '联系人')})</span></span>
                                <span class="time">${escapeHTML(contact.lastTime || '刚刚')}</span>
                                    </div>
                                    <div class="info-bottom"><p class="last-message">${escapeHTML(lastMsg)}</p></div>
                                </div>
                            `;
                            
                            // 绑定点击进入详情页
                            addTapListener(itemEl, () => renderPhoneNpcConversation(contact, avatarUrl, phoneData, currentActivePhoneChar));

                            conversationListEl.appendChild(itemEl);
                        });
                                     }
                    showDynamicIsland('聊天记录提取完毕', 'success');
                } else {
                    if (conversationListEl) conversationListEl.innerHTML = '<div style="padding: 40px 20px; text-align: center; color: #999; font-size: 13px;">提取失败或该角色手机很干净</div>';
                }
            }

            // [核心新增] 如果用户勾选了生成备忘录
            if (selectedTypes.includes('memo')) {
                const memoListEl = document.querySelector('.cp-memo-list');
                if (memoListEl) {
                    // 渲染骨架屏加载动画
                    memoListEl.innerHTML = `
                        <div class="cp-bookmark-card" style="opacity: 0.6; animation: pulse 1.5s infinite;"><div style="height:10px;width:40px;background:#eee;margin:10px auto;"></div><div style="height:60px;background:#f5f5f5;margin-top:10px;"></div></div>
                        <div class="cp-bookmark-card dark" style="opacity: 0.6; animation: pulse 1.5s infinite 0.2s;"><div style="height:10px;width:40px;background:#444;margin:10px auto;"></div><div style="height:40px;background:#333;margin-top:10px;"></div></div>
                    `;
                }
                
                // 呼叫 AI 生成数据
                const memoData = allPagesData?.memo || await generateVirtualMemoData(currentActivePhoneChar.id);
                
                if (memoData && memoData.memos && memoData.memos.length > 0) {
                    normalizeVirtualMemoDates(memoData);
                    memoData.memos.forEach((memo, index) => {
                        memo.innerThought = buildMemoInnerThought(memo, index);
                    });
                              // 永久保存
                    await db.appData.put({ key: `virtual_phone_memo_${currentActivePhoneChar.id}`, value: memoData });
                    if (memoListEl) {
                        memoListEl.innerHTML = '';
                        memoData.memos.forEach((memo, index) => {
                            const previewCleanText = memo.content.replace(/\[.*?\]|\*\*|==|#/g, '').replace(/\n/g, ' ').trim();
                            
                            // 【核心修复】真正的棋盘格错开算法 (左上白, 右上黑, 左下黑, 右下白)
                            const forceDark = (index % 4 === 1) || (index % 4 === 2);

                            const card = document.createElement('div');
                            card.className = `cp-bookmark-card ${forceDark ? 'dark' : ''}`;

                            card.innerHTML = `
                                <div class="bookmark-hole"></div>
                                <div class="bookmark-date">${memo.date}</div>
                                <div class="bookmark-content">${previewCleanText.substring(0, 45)}...</div>
                                <div class="bookmark-footer">0${index + 1}</div>
                            `;
                            
                            addTapListener(card, () => {
                                document.getElementById('char-phone-memo-view').style.display = 'none';
                                const detailView = document.getElementById('char-phone-memo-detail-view');
                                detailView.style.display = 'flex';
                                document.querySelector('.cp-dock-nav').style.display = 'none';
                                document.getElementById('cp-ai-generate-btn').style.display = 'none';
                                
                                detailView.querySelector('.memo-date-meta').textContent = memo.fullDate;
                                detailView.querySelector('.memo-title').textContent = memo.title;
                                const thoughtTextEl = detailView.querySelector('.memo-thought-strip .thought-text');
                                if (thoughtTextEl) thoughtTextEl.textContent = buildMemoInnerThought(memo, index);
                                
                                // [全新手账渲染引擎]
                                const formattedHTML = memo.content.split('\n').filter(l => l.trim()).map(line => {
                                    let cleanLine = line.trim();
                                    
                                    if (cleanLine.startsWith('# ') || cleanLine.startsWith('## ')) return `<div class="memo-mini-title">${cleanLine.replace(/^#+\s*/, '')}</div>`;
                                    if (cleanLine === '---' || cleanLine === '***') return `<div class="memo-divider"></div>`;
                                    
                                    cleanLine = cleanLine.replace(/==(.*?)==|\*\*(.*?)\*\*/g, '<mark class="hl-yellow">$1$2</mark>');

                                    let isTodo = false; let isDone = false;
                                    const todoMatch = cleanLine.match(/^\[(x|v|√| |)\]\s*(.*)/i);
                                    const numMatch = cleanLine.match(/^(\d+\.|-)\s+(.*)/);

                                    if (todoMatch) {
                                        isTodo = true; isDone = ['x', 'v', '√'].includes(todoMatch[1].toLowerCase()); cleanLine = todoMatch[2];
                                    } else if (numMatch) {
                                        isTodo = true; cleanLine = numMatch[2];
                                    }

                                    if (isTodo) return `<div class="memo-todo-item ${isDone ? 'done' : ''}"><div class="bullet-box"></div><span class="text">${cleanLine}</span></div>`;
                                    return `<p class="memo-paragraph">${cleanLine}</p>`;
                                }).join('');

                                detailView.querySelector('.memo-text-content').innerHTML = formattedHTML;
                            });
                            memoListEl.appendChild(card);
                        });
                    }

                    showDynamicIsland('备忘录提取完毕', 'success');
                } else {
                    if (memoListEl) memoListEl.innerHTML = '<div style="text-align: center; padding: 40px; color: #999; width: 100%;">提取失败，可能没有灵感</div>';
                }
            }

            // [核心新增] 如果用户勾选了生成购物记录
            if (selectedTypes.includes('shop')) {
                const shopListEl = document.querySelector('.cp-shop-list');
                if (shopListEl) {
                    // 高级骨架屏
                    shopListEl.innerHTML = `
                        <div class="cp-shop-card" style="opacity: 0.6; animation: pulse 1.5s infinite;">
                            <div style="width: 80px; height: 12px; background: #eee; margin-bottom: 15px;"></div>
                            <div style="display: flex; gap: 15px;">
                                <div style="width: 75px; height: 95px; background: #eee; border-radius: 2px;"></div>
                                <div style="flex: 1; display: flex; flex-direction: column; gap: 10px; padding-top: 5px;">
                                    <div style="width: 40%; height: 10px; background: #f5f5f5;"></div>
                                    <div style="width: 80%; height: 14px; background: #eee;"></div>
                                    <div style="width: 60%; height: 16px; background: #eee; margin-top: auto;"></div>
                                </div>
                            </div>
                            <div style="width: 100%; height: 30px; background: #fcfcfc; margin-top: 15px; border-radius: 4px;"></div>
                        </div>
                    `;
                }
                
                const shopData = allPagesData?.shop || await generateVirtualShopData(currentActivePhoneChar.id);
                
                if (shopData && shopData.records && shopData.records.length > 0) {
                           await db.appData.put({ key: `virtual_phone_shop_${currentActivePhoneChar.id}`, value: shopData });
                    if (shopListEl) {
                        shopListEl.innerHTML = '';
                        shopData.records.forEach((item, index) => {
                            const randomImg = `https://picsum.photos/seed/${currentActivePhoneChar.id}shop${index}/200/300`;
                            const card = document.createElement('div');
                            card.className = 'cp-shop-card';
                            card.innerHTML = `
                                <div class="card-date">${item.date}</div>
                                <div class="card-stamp">DELIVERED</div>
                                <div class="card-body">
                                    <div class="item-img" style="background-image: url('${randomImg}');"></div>
                                    <div class="item-info">
                                        <div class="item-brand">${item.brand}</div>
                                        <div class="item-name">${item.name}</div>
                                        <div class="item-specs">${item.specs}</div>
                                        <div class="item-price">¥ ${item.price}</div>
                                    </div>
                                </div>
                                <div class="card-thought"><span class="thought-quote">“ ${item.thought} ”</span></div>
                            `;
                            shopListEl.appendChild(card);
                        });
                    }
                    showDynamicIsland('购物记录提取完毕', 'success');
                } else {
                        if (shopListEl) shopListEl.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">提取失败，未发现订单</div>';
                }
            }

            // [核心新增] 如果用户勾选了生成浏览器记录
            if (selectedTypes.includes('browser')) {
                const browserListEl = document.querySelector('.browser-history-list');
                if (browserListEl) {
                    browserListEl.innerHTML = `
                        <div class="history-item" style="opacity:0.5; animation: pulse 1.5s infinite;"><div style="width:18px;height:18px;border-radius:50%;background:#eee;"></div><div style="flex:1;height:14px;background:#f5f5f5;margin:0 15px;border-radius:4px;"></div></div>
                        <div class="history-item" style="opacity:0.5; animation: pulse 1.5s infinite 0.2s;"><div style="width:18px;height:18px;border-radius:50%;background:#eee;"></div><div style="width:60%;height:14px;background:#f5f5f5;margin:0 15px;border-radius:4px;"></div></div>
                    `;
                }

                const browserData = allPagesData?.browser || await generateVirtualBrowserData(currentActivePhoneChar.id);

                if (browserData && browserData.history && browserData.history.length > 0) {
                        await clearBrowserDetailCache(currentActivePhoneChar.id);
                        await db.appData.put({ key: `virtual_phone_browser_${currentActivePhoneChar.id}`, value: browserData });
                    if (browserListEl) {
                        browserListEl.innerHTML = '';
                        browserData.history.forEach((item) => {
                            const row = document.createElement('div');
                            row.className = 'history-item';
                            row.innerHTML = `
                                <svg class="history-icon" viewBox="0 0 24 24" fill="none" stroke="#9aa0a6" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                                <span class="history-text">${item.query}</span>
                                <svg class="remove-icon" viewBox="0 0 24 24" fill="none" stroke="#9aa0a6" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                            `;
                             addTapListener(row, async () => {
                                const browserMainView = document.getElementById('char-phone-browser-view');
                                const browserDetailView = document.getElementById('char-phone-browser-detail-view');
                                const dockNav = document.querySelector('.cp-dock-nav');
                                const aiBtn = document.getElementById('cp-ai-generate-btn');
                                
                                if (browserMainView) browserMainView.style.display = 'none';
                                if (browserDetailView) {
                                    browserDetailView.style.display = 'flex';
                                    const bodyEl = browserDetailView.querySelector('.browser-webpage-body');
                                    
                                    if (bodyEl) {
                                        bodyEl.innerHTML = `
                                            <div style="padding: 100px 20px; text-align: center;">
                                                <div style="width: 30px; height: 30px; border: 3px solid #f3f3f3; border-top: 3px solid #3498db; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 15px;"></div>
                                                <div style="color: #999; font-size: 13px;">正在加载网页内容...</div>
                                            </div>
                                        `;
                                    }

                                    const detailData = await loadBrowserDetailData(currentActivePhoneChar.id, item.query);

                                    if (detailData && !detailData.error && bodyEl) {
                                        bodyEl.innerHTML = `
                                            <div class="forum-site-header">
                                                <span class="site-logo">搜索结果</span>
                                                <span class="site-nav">首页 > 详情</span>
                                            </div>
                                            <div class="forum-post-main">
                                                <h1 class="forum-h1">${detailData.title || '无标题'}</h1>
                                                <div class="forum-meta">
                                                    <span class="author">楼主：${detailData.author || '匿名'}</span>
                                                    <span class="time">${detailData.time || '刚刚'}</span>
                                                    <span class="views">阅读 ${detailData.views || '0'}</span>
                                                </div>
                                                <div class="forum-content">${detailData.content || '内容为空'}</div>
                                            </div>
                                            <div class="forum-divider"></div>
                                            <div class="forum-replies">
                                                <div class="replies-title">全部回复 (${Array.isArray(detailData.replies) ? detailData.replies.length : 0})</div>
                                                ${Array.isArray(detailData.replies) ? detailData.replies.map(r => `
                                                    <div class="forum-reply-item">
                                                        <div class="reply-user-info">
                                                            <div class="avatar-wrap"><img src="images/default-avatar.svg" style="opacity:0.3"></div>
                                                            <div class="name-time">
                                                                <span class="name">${r.user || '路人'}</span>
                                                                <span class="time">${r.time || '刚刚'}</span>
                                                            </div>
                                                            <span class="floor">${r.floor || ''}</span>
                                                        </div>
                                                        <div class="reply-text">${r.content || ''}</div>
                                                    </div>
                                                `).join('') : '<div style="padding: 20px; text-align: center; color: #999;">暂无回复数据</div>'}
                                            </div>
                                        `;
                                    } else if (bodyEl) {
                                        // 提取并展示具体报错原因
                                        const errorReason = detailData?.error || '网页走丢了... 404 (AI格式错误)';
                                        bodyEl.innerHTML = `<div style="padding: 100px 20px; text-align: center; color: #999;">${errorReason}</div>`;
                                    }
                                }
                                if(aiBtn) aiBtn.style.display = 'none';
                                if(dockNav) dockNav.style.display = 'none';
                            });

                            browserListEl.appendChild(row);

                        });
                    }
                    showDynamicIsland('搜索记录提取完毕', 'success');
                } else {
                    if (browserListEl) browserListEl.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">提取失败，设备无记录</div>';
                }
            }

            // [核心新增] 如果用户勾选了生成钱包记录
            if (selectedTypes.includes('wallet')) {
                const summaryArea = document.querySelector('.cp-wallet-summary');
                const card1Area = document.getElementById('records-card-1');
                const card2Area = document.getElementById('records-card-2');
                
                if (card1Area) {
                    // 渲染骨架屏加载动画
                    card1Area.innerHTML = `
                        <div class="wallet-item" style="opacity:0.5; animation: pulse 1.5s infinite;">
                            <div style="width:42px;height:42px;border-radius:12px;background:#eee;"></div>
                            <div style="flex:1;margin:0 12px;"><div style="width:60%;height:14px;background:#f5f5f5;margin-bottom:8px;"></div><div style="width:30%;height:10px;background:#eee;"></div></div>
                            <div style="width:50px;height:16px;background:#f5f5f5;"></div>
                        </div>
                    `;
                }

                // 呼叫AI接口
                const walletData = allPagesData?.wallet || await generateVirtualWalletData(currentActivePhoneChar.id);

                const walletState = walletData && walletData.summary
                    ? await ensureCharacterPhoneWallet(currentActivePhoneChar.id, walletData)
                    : null;

                if (walletState && walletState.summary) {
                  // 保存到本地存档；余额和流水共用同一份角色钱包数据
                    if (summaryArea && walletState.summary) {
                        summaryArea.innerHTML = `
                            <div class="summary-box"><span class="s-label">本月支出 (Exp)</span><span class="s-value">¥ ${walletState.summary.expense || '0.00'}</span></div>
                            <div class="summary-box"><span class="s-label">本月收入 (Inc)</span><span class="s-value plus">¥ ${walletState.summary.income || '0.00'}</span></div>
                        `;
                    }
                    ['1', '2'].forEach((number, index) => {
                        const balanceEl = document.getElementById(`cp-phone-card-${number}-balance`);
                        if (balanceEl) balanceEl.textContent = `余额 ¥${Number(walletState.cards?.[index]?.balance || 0).toFixed(2)}`;
                    });
                    const icons = {
                        food: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12h20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"></path><path d="M4 14v2a8 8 0 0 0 16 0v-2H4z"></path></svg>',
                        shop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 6V4a4 4 0 0 0-8 0v2H4v16h16V6h-4zm-6-2a2 2 0 0 1 4 0v2h-4V4z"></path></svg>',
                        transport: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
                        transfer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>',
                        income: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="12" y1="10" x2="12" y2="14"></line><line x1="10" y1="12" x2="14" y2="12"></line></svg>',
                    };
                    const buildHtml = (data) => {
                        if (!data || data.length === 0) return '<div style="padding:40px 0; text-align:center; color:#999; font-size:13px;">暂无流水记录</div>';
                        let html = '';
                        data.forEach(day => {
                            html += `<div class="record-date-title">${day.date}</div>`;
                            if(day.records) {
                                day.records.forEach(r => {
                                    const iconSvg = icons[r.icon] || icons.shop;
                                    const isIncome = String(r.amount).includes('+');
                                    const amountClass = isIncome ? 'plus' : 'minus';
                                    const iconStyle = isIncome ? 'style="background:#e8f5e9; color:#34a853;"' : '';
                                    html += `<div class="wallet-item"><div class="w-icon" ${iconStyle}>${iconSvg}</div><div class="w-info"><div class="w-title">${r.title}</div><div class="w-time">${r.time} · ${r.type}</div></div><div class="w-amount ${amountClass}">${r.amount}</div></div>`;
                                });
                            }
                        });
                        return html;
                    };
                    if (card1Area) card1Area.innerHTML = buildHtml(walletState.card1);
                    if (card2Area) card2Area.innerHTML = buildHtml(walletState.card2);
                     showDynamicIsland('钱包流水提取完毕', 'success');
                } else {
                    if (card1Area) card1Area.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">提取失败，未发现交易</div>';
                }
            }
            // [核心新增] 如果用户勾选了生成屏幕使用时间 (Screen Time)
            if (selectedTypes.includes('screentime')) {
                const screentimeView = document.getElementById('char-phone-screentime-view');
                let hackOverlay = null;
                let hackLogInterval = null;

                if (screentimeView) {
                    // 1. 创建高级“数据破解/扫描”遮罩层
                    hackOverlay = document.createElement('div');
                    hackOverlay.style.cssText = 'position: absolute; inset: 0; background: rgba(253, 251, 247, 0.92); backdrop-filter: blur(12px); z-index: 500; display: flex; flex-direction: column; align-items: center; justify-content: center; transition: opacity 0.4s ease;';
                    
                    hackOverlay.innerHTML = `
                        <div style="position: relative; width: 50px; height: 50px; margin-bottom: 25px;">
                            <div style="position: absolute; inset: 0; border: 2px solid rgba(0,0,0,0.05); border-radius: 50%;"></div>
                            <div class="hack-spinner" style="position: absolute; inset: 0; border: 2px solid transparent; border-top-color: #1a1a1a; border-right-color: #1a1a1a; border-radius: 50%;"></div>
                        </div>
                        <div style="font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 15px; font-weight: 800; color: #1a1a1a; letter-spacing: 4px; margin-bottom: 12px; margin-left: 4px;">ANALYZING</div>
                        <div id="st-hack-logs" style="font-family: monospace; font-size: 10px; color: #888; letter-spacing: 1px; height: 14px;">Initiating neural extraction...</div>
                    `;
                    screentimeView.appendChild(hackOverlay);

                    // 2. 使用原生 JS 赋予旋转动画，防止与其他 CSS 冲突
                    const spinner = hackOverlay.querySelector('.hack-spinner');
                    if (spinner) {
                        spinner.animate(
                            [ { transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' } ],
                            { duration: 1000, iterations: Infinity, easing: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)' } // 带有一点阻尼感的极简动画
                        );
                    }

                    // 3. 模拟黑客破解日志跳动
                    const logs = [
                        "Bypassing security protocols...",
                        "Extracting screen wake records...",
                        "Analyzing late-night social footprints...",
                        "Decrypting location history...",
                        "Synthesizing psychological profile...",
                        "Structuring final data visualization..."
                    ];
                    let logIdx = 0;
                    const logEl = hackOverlay.querySelector('#st-hack-logs');
                    hackLogInterval = setInterval(() => {
                        if (logIdx < logs.length && logEl) {
                            logEl.textContent = logs[logIdx];
                            logIdx++;
                        }
                    }, 1500);
                }

                // --- 呼叫AI接口 ---
                const stData = allPagesData?.screentime || await generateVirtualScreenTimeData(currentActivePhoneChar.id);

                // --- 清理动画并渲染数据 ---
                if (hackOverlay) {
                    clearInterval(hackLogInterval);
                    // 渐隐移除
                    hackOverlay.style.opacity = '0';
                    setTimeout(() => hackOverlay.remove(), 400);
                }

                if (stData && stData.totalTime) {
                 // 保存到本地存档
                    await db.appData.put({ key: `virtual_phone_screentime_${currentActivePhoneChar.id}`, value: stData });
                    // 复用上面的渲染函数直接渲染
                    if (screentimeView) {

                                    // 【同步动态渲染逻辑，并确保容器恢复可见】
                        const scrollContainer = screentimeView.querySelector('.st-scroll-container');
                        if (scrollContainer) scrollContainer.style.display = 'block'; 
                        const emptyTip = screentimeView.querySelector('.st-empty-tip');
                        if (emptyTip) emptyTip.remove(); 

                        // 1. 更新总览 
                        const overviewTime = screentimeView.querySelector('.overview-card .time');
                        const overviewComment = screentimeView.querySelector('.overview-card .overview-comment p');
                        if(overviewTime && stData.totalTime) overviewTime.innerHTML = stData.totalTime;
                        if(overviewComment && stData.overviewComment) overviewComment.innerHTML = stData.overviewComment;

                        // 准备动态图标
                        const appIcons = [
                            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>',
                            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="4" ry="4"></rect><line x1="9" y1="12" x2="15" y2="12"></line><line x1="12" y1="9" x2="12" y2="15"></line></svg>',
                            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>'
                        ];
                        const tlIcons = [
                            '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>',
                            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>',
                            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"></path><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"></path><line x1="6" y1="1" x2="6" y2="4"></line><line x1="10" y1="1" x2="10" y2="4"></line><line x1="14" y1="1" x2="14" y2="4"></line></svg>'
                        ];
                        const locIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"></path></svg>';

                        // 2. 动态更新 Apps
                        const appListContainer = screentimeView.querySelector('.apps-card .app-list');
                        if (appListContainer && stData.apps && Array.isArray(stData.apps)) {
                            appListContainer.innerHTML = ''; 
                            stData.apps.forEach((app, i) => {
                                const icon = appIcons[i % appIcons.length];
                                appListContainer.innerHTML += `
                                    <div class="app-item">
                                        <div class="app-icon">${icon}</div>
                                        <div class="app-info">
                                            <div class="name-time"><span>${app.name}</span><span>${app.time}</span></div>
                                            <div class="bar-bg"><div class="bar-fill" style="width: ${app.percent}%;"></div></div>
                                        </div>
                                    </div>
                                `;
                            });
                        }

                        // 3. 动态更新 Timeline
                        const tlListContainer = screentimeView.querySelector('.timeline-card .timeline-list');
                        if (tlListContainer && stData.timeline && Array.isArray(stData.timeline)) {
                            tlListContainer.innerHTML = ''; 
                            stData.timeline.forEach((tl, i) => {
                                const icon = tlIcons[i % tlIcons.length];
                                tlListContainer.innerHTML += `
                                    <div class="tl-item">
                                        <div class="tl-icon">${icon}</div>
                                        <div class="tl-content">
                                            <div class="tl-meta">${tl.time}</div>
                                            <div class="tl-title">${tl.title}</div>
                                            <p class="tl-desc">${tl.desc}</p>
                                        </div>
                                    </div>
                                `;
                            });
                        }

                        // 4. 动态更新 Locations
                        const locListContainer = screentimeView.querySelector('.st-footprint-card .loc-grid');
                        if (locListContainer && stData.locations && Array.isArray(stData.locations)) {
                            locListContainer.innerHTML = '';
                            stData.locations.forEach((loc, i) => {
                                const isLastOdd = (i === stData.locations.length - 1) && (stData.locations.length % 2 !== 0);
                                const widthClass = isLastOdd ? 'full-width' : '';
                                locListContainer.innerHTML += `
                                    <div class="loc-item ${widthClass}">
                                        <div class="loc-icon">${locIcon}</div>
                                        <div class="loc-info">
                                            <span class="loc-name">${loc.name}</span>
                                            <span class="loc-apps">${loc.apps}</span>
                                        </div>
                                    </div>
                                `;
                            });
                        }

                    }
                    showDynamicIsland('屏幕使用时间提取完毕', 'success');
                } else {
                    if (screentimeView) {
                        const scrollContainer = screentimeView.querySelector('.st-scroll-container');
                        if (scrollContainer) {
                            scrollContainer.style.animation = 'none';
                            scrollContainer.style.opacity = '1';
                        }
                    }
                    showDynamicIsland('生活轨迹提取失败', 'error');
                }
            }
            // [核心新增] 如果用户勾选了生成 ChatGPT 记录
            if (selectedTypes.includes('cgt')) {
                const cgtListEl = document.getElementById('char-phone-cgt-list');
                if (cgtListEl) {
                    cgtListEl.innerHTML = `
                        <div class="cgt-msg-row user" style="opacity: 0.6; animation: pulse 1.5s infinite;"><div class="cgt-text" style="height: 40px; background: #f4f4f4; width: 200px; border-radius: 18px;"></div></div>
                        <div class="cgt-msg-row ai" style="opacity: 0.6; animation: pulse 1.5s infinite 0.2s;"><div class="cgt-avatar"><div style="width:16px;height:16px;background:#e5e5e5;border-radius:50%;"></div></div><div class="cgt-text"><div style="height:12px;background:#e5e5e5;width:90%;margin-bottom:8px;"></div><div style="height:12px;background:#e5e5e5;width:60%;"></div></div></div>
                    `;
                }
               const cgtData = allPagesData?.cgt || await generateVirtualCgtData(currentActivePhoneChar.id);
                if (cgtData && cgtData.conversations && cgtData.conversations.length > 0) {
                    await db.appData.put({ key: `virtual_phone_cgt_${currentActivePhoneChar.id}`, value: cgtData });
                    
                    // 这里利用我们在外层定好的侧边栏渲染函数
                    if (cgtListEl && document.getElementById('cgt-sidebar-list')) {
                         // 重新绑定一下内部方法以防止跨域丢失
                        const sidebarListEl = document.getElementById('cgt-sidebar-list');
                        sidebarListEl.innerHTML = '';
                        cgtData.conversations.forEach((conv, index) => {
                            const firstMsgText = conv.messages.find(m => m.role === 'user')?.text || '新的对话';
                            const previewStr = firstMsgText.length > 20 ? firstMsgText.substring(0, 20) + '...' : firstMsgText;
                            const item = document.createElement('div');
                            // 给它加专属类名，并把整个对话的文字拼起来藏在 data 属性里
                            item.className = 'cgt-sidebar-item';
                            const fullChatText = conv.messages.map(m => (m.role === 'user' ? '提问' : 'AI') + ': ' + m.text).join(' | ');
                            item.setAttribute('data-full-chat', fullChatText);
                            item.style.cssText = 'padding: 12px 10px; margin-bottom: 2px; border-radius: 8px; font-size: 14px; color: #333; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; transition: background 0.2s;';
                            item.innerHTML = `${previewStr}`;
                            addTapListener(item, () => {
                                cgtListEl.innerHTML = '';
                                conv.messages.forEach(msg => {
                                    const isUser = msg.role === 'user';
                                    const formatText = msg.text.replace(/\n/g, '<br>');
                                                                        const aiIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path></svg>`;
                                    cgtListEl.innerHTML += `
                                        <div class="cgt-msg-row ${isUser ? 'user' : 'ai'}">
                                            <div class="cgt-avatar">${isUser ? '' : aiIcon}</div>
                                            <div class="cgt-text">${formatText}</div>
                                        </div>
                                    `;
                                });
                                document.getElementById('cgt-sidebar-overlay').style.display = 'none';
                            });
                            sidebarListEl.appendChild(item);
                        });
                        
                        // 放弃不稳定的 click()，直接手动把第一条数据画在主屏幕上顶掉加载动画
                        cgtListEl.innerHTML = '';
                        cgtData.conversations[0].messages.forEach(msg => {
                            const isUser = msg.role === 'user';
                            const formatText = msg.text.replace(/\n/g, '<br>');
                            const aiIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path></svg>`;
                            cgtListEl.innerHTML += `
                                <div class="cgt-msg-row ${isUser ? 'user' : 'ai'}">
                                    <div class="cgt-avatar">${isUser ? '' : aiIcon}</div>
                                    <div class="cgt-text">${formatText}</div>
                                </div>
                            `;
                        });
                    }
                    showDynamicIsland('AI助手记录提取完毕', 'success');
                } else {
                    if (cgtListEl) cgtListEl.innerHTML = '<div style="text-align: center; padding: 40px; color: #8e8ea0; font-size: 14px;">提取失败，未发现AI记录</div>';
                }
            }
            // 对于其他尚未开发的选项，给出提示 (将 'screentime' 也从拦截名单中剔除)
            const unhandledTypes = selectedTypes.filter(t => t !== 'chat' && t !== 'memo' && t !== 'shop' && t !== 'browser' && t !== 'wallet' && t !== 'screentime' && t !== 'cgt');

            if (unhandledTypes.length > 0) {

                setTimeout(() => {

                    showDynamicIsland(`${unhandledTypes.join(', ')} 模块开发中`);
                }, 2000);
            }
        });
    }
    // ▼▼▼ [新增开始] LoverSync 角色独立标记与对峙闭环系统 ▼▼▼
    
    if (!window.loverSyncPins) window.loverSyncPins = {}; 

    const phonePage = document.getElementById('page-character-phone');
     let pressTimer = null;
    let isDragging = false;
    let preventNextClick = false; // 核心保险丝：阻断长按触发的单击事件
    let startX = 0, startY = 0; // [核心修复] 记录手指按下的初始坐标，用于防手抖容错

    function extractPinText(el) {
        let prefix = ""; let content = "";
        let keepFullText = false;
        if (el.classList.contains('msg-bubble')) { prefix = "【单句聊天】"; content = el.innerText; }
        else if (el.classList.contains('conversation-item')) {
            prefix = "【外部联系人框】";
            const context = conversationItemContexts.get(el);
            const contactName = context?.contact?.name || el.querySelector('.name')?.innerText || '';
            const historyText = (context?.contact?.chatHistory || [])
                .map((item) => {
                    const message = normalizePhoneNpcMessageItem(item, false);
                    if (!message.text) return '';
                    const speaker = message.isMe ? (context?.ownerChar?.name || '我') : (contactName || '对方');
                    const translation = String(message.translation || '').trim();
                    return `${speaker}: ${message.text}${translation ? `\n（翻译：${translation}）` : ''}`;
                })
                .filter(Boolean)
                .join('\n');
            content = historyText
                ? `与 ${contactName} 的完整聊天记录：\n${historyText}`
                : `与 ${contactName} 聊：${el.querySelector('.last-message')?.innerText || ''}`;
            keepFullText = !!historyText;
        }
        else if (el.classList.contains('cp-bookmark-card')) { prefix = "【备忘录碎片】"; content = el.querySelector('.bookmark-content')?.innerText || el.innerText; }
        else if (el.classList.contains('memo-thought-strip')) { prefix = "【备忘录心声贴条】"; content = el.querySelector('.thought-text')?.innerText || el.innerText; }
        else if (el.classList.contains('cp-shop-card')) { prefix = "【购物订单】"; content = `买了 ${el.querySelector('.item-name')?.innerText || ''}，心理活动：${el.querySelector('.card-thought')?.innerText || ''}`; }
        else if (el.classList.contains('history-item')) { prefix = "【搜索记录】"; content = el.querySelector('.history-text')?.innerText || ''; }
        else if (el.classList.contains('forum-post-main')) { prefix = "【论坛发帖】"; content = el.querySelector('.forum-h1')?.innerText + " - " + el.querySelector('.forum-content')?.innerText; }
        else if (el.classList.contains('forum-reply-item')) { prefix = "【论坛回复】"; content = el.querySelector('.reply-text')?.innerText || ''; }
        else if (el.classList.contains('wallet-item')) { prefix = "【账单流水】"; content = el.innerText.replace(/\n/g, ' '); }
          else if (el.classList.contains('cp-wallet-summary')) { prefix = "【钱包总览】"; content = el.innerText.replace(/\n/g, ' '); }
        else if (el.classList.contains('st-card')) { prefix = "【屏幕时间/轨迹】"; content = el.innerText.replace(/\n/g, ' | '); }
        else if (el.classList.contains('cgt-msg-row')) { prefix = "【AI问答记录】"; content = el.querySelector('.cgt-text')?.innerText || el.innerText; }
        else if (el.classList.contains('cgt-sidebar-item')) { prefix = "【AI完整对话】"; content = el.getAttribute('data-full-chat') || el.innerText; }
        else { content = el.innerText; }

        let rawText = keepFullText
            ? content.trim().replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n')
            : content.trim().replace(/\s+/g, ' ');
        if (!keepFullText && rawText.length > 80) rawText = rawText.substring(0, 80) + '...';
        return `${prefix} ${rawText}`;
    }

    const allowedSelectors = '#char-phone-conversation-list .conversation-item, .cp-bookmark-card, .memo-thought-strip, .cp-shop-card, .history-item, .forum-post-main, .forum-reply-item, .cp-wallet-list-container .wallet-item, .cp-wallet-summary, .st-card, .cgt-msg-row, .cgt-sidebar-item';
    // --- 1. 监听长按动作 ---
    phonePage.addEventListener('pointerdown', (e) => {
        isDragging = false;
        startX = e.clientX; // [核心修复] 记录接触屏幕瞬间的 X 坐标
        startY = e.clientY; // [核心修复] 记录接触屏幕瞬间的 Y 坐标
        if (!e.isPrimary) return; 
        const target = e.target.closest(allowedSelectors);
        if (!target || target.closest('#char-phone-conversation-view') || !currentActivePhoneChar) return;
        if (target.matches('#char-phone-conversation-list .conversation-item')) {
            const context = conversationItemContexts.get(target);
            if (context && isPhoneRealUserContact(context.contact, context.ownerChar)) return;
        }
        const charId = currentActivePhoneChar.id;
        
        pressTimer = setTimeout(() => {
            if (isDragging) return;
            preventNextClick = true; // 长按一旦生效，锁死接下来的任何点击事件！
            
            if (!window.loverSyncPins[charId]) window.loverSyncPins[charId] = new Map();
            const charPins = window.loverSyncPins[charId];

            if (target.classList.contains('lover-sync-pinned')) {
                target.classList.remove('lover-sync-pinned');
                charPins.delete(target);
            } else {
                target.classList.add('lover-sync-pinned');
                charPins.set(target, extractPinText(target));
                if (navigator.vibrate) navigator.vibrate(50);
            }
        }, 500); 
    });

    phonePage.addEventListener('pointermove', (e) => { 
        // [核心修复] 容错处理：计算当前位置与起点的差值。
        // 如果手指偏移超过 10 像素，才判定为真正的“滑动翻页”，否则原谅手抖，继续保持长按判定！
        if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) {
            isDragging = true; 
            clearTimeout(pressTimer); // 既然判定为滑走了，顺手把长按定时器掐死，节省性能
        }
    });
    phonePage.addEventListener('pointerup', (e) => { 
        clearTimeout(pressTimer); 

        // 延迟解开点击锁，确保浏览器派发的 click 和 touchend 都被拦截死
        if (preventNextClick) setTimeout(() => preventNextClick = false, 100); 
    });
    phonePage.addEventListener('pointercancel', () => { clearTimeout(pressTimer); });

    // --- 2. 暴力拦截所有点击事件 (在捕获阶段最高优先级处理) ---
    const globalCaptureHandler = (e) => {
        // 【防御1】如果是长按松开瞬间触发的单击，直接吃掉，不准往下传！
        if (preventNextClick) {
            if (e.cancelable) e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            return;
        }

        // 【防御2】寻找是否点击了带有 data-target="page-love" 的返回按钮 (包含各子页面)
        const backBtn = e.target.closest('.back-button[data-target="page-love"]');
        if (backBtn && currentActivePhoneChar) {
            const charId = currentActivePhoneChar.id;
            const charPins = window.loverSyncPins[charId];
            
            // 如果标记了东西，拦截退出动作，弹出确认窗！
            if (charPins && charPins.size > 0) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                showPinConfirmModal(charId, charPins);
            }
        }
    };
    
    // 监听 click 和 touchend，防止框架底层绕过
    phonePage.addEventListener('click', globalCaptureHandler, { capture: true });
    phonePage.addEventListener('touchend', globalCaptureHandler, { capture: true });

    // --- 3. 美化版专属确认弹窗 ---
    function showPinConfirmModal(charId, charPinsMap) {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.style.cssText = 'z-index: 9999; display: flex; opacity: 0; transition: opacity 0.3s; position: fixed; inset: 0; width: 100vw; height: 100dvh; min-height: 100dvh; align-items: center; justify-content: center; box-sizing: border-box; overflow: hidden; touch-action: none; overscroll-behavior: contain; padding: max(20px, env(safe-area-inset-top)) 0 max(20px, env(safe-area-inset-bottom)) 0;';
        
        let listHtml = '';
        let i = 1;
        charPinsMap.forEach((text) => {
            listHtml += `<div class="sync-item"><span class="idx">${i}.</span><span class="txt">${escapeHTML(text)}</span></div>`;
            i++;
        });

        // 注入我们在 scss 里写好的优雅样式
        modal.innerHTML = `
            <div class="modal-card sync-confirm-card" style="width: 90%; max-width: 380px; max-height: calc(100dvh - 40px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); display: flex; flex-direction: column; box-sizing: border-box;">
                <div class="sync-header">
                    <h3>保留同步标记</h3>
                    <p>已提取以下线索，是否带入聊天记录？</p>
                </div>
                    <div class="sync-list" style="min-height: 0; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;">
                    ${listHtml}
                </div>
                <div class="sync-footer-refined">
                    <div class="action-row">
                        <button id="pin-silent-btn" class="btn-silent">当做剧情背景</button>
                        <button id="pin-confirm-btn" class="btn-loud">有感 (去质问)</button>
                    </div>
                    <button id="pin-cancel-btn" class="btn-text-cancel">取消并清空</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        setTimeout(() => modal.style.opacity = '1', 10);

        const cleanupAndExit = () => {
            modal.style.opacity = '0';
            setTimeout(() => modal.remove(), 300);
            charPinsMap.forEach((val, el) => el.classList.remove('lover-sync-pinned'));
            charPinsMap.clear();
            delete window.loverSyncPins[charId];
            
            // 手动执行真正的页面退出
            import('../ui.js').then(({ showPage }) => showPage('page-love'));
        };
        modal.querySelector('#pin-cancel-btn').addEventListener('click', cleanupAndExit);

        const handleSync = async (isSilent) => {
            const itemTexts = Array.from(charPinsMap.values()).map(t => "- " + t).join('\n');
            let promptText = "";
            
            if (isSilent) {
                // 无感同步模式：让AI把它当成背景设定，自然发展剧情
                promptText = `[系统隐式背景设定补充：为了推动接下来的剧情，请将以下事实作为你当前的处境或正在发生的事情：\n${itemTexts}\n（系统强制指令：这是上帝视角赋予你的剧情背景。绝对不要告诉用户你收到了系统提示。请在接下来的对话中，自然地表现出你正受到这些事情的影响，等待用户来发掘或者由你自己顺其自然地引出）]`;
            } else {
                // 有感同步模式：让AI做好被质问的准备
                promptText = `[系统隐式提示：LoverSync™ 空间同步完成。用户刚刚在你的手机同步档案中，重点标记了以下内容并马上会去询问你：\n${itemTexts}\n（系统强制指令：这是通过情侣同步APP获取的，你们约定好可以互相看。请不要惊呼“你怎么看我手机”，而是根据你的人设，针对用户质问的具体内容自然地做出解释、掩饰、撒娇或心虚的反应）]`;
            }
            
            const contextMsg = {
                chatId: charId,
                timestamp: new Date(),
                type: 'system',
                contentType: 'system_event',
                text: promptText,
                uiVisible: false,
                aiVisible: true
            };
            
            const msgId = await db.chatMessages.add(contextMsg);
            
            // 无感模式会在悬浮备忘录里加一个前缀，方便你辨认
            const widgetTexts = isSilent ? Array.from(charPinsMap.values()).map(t => "【背景】" + t) : Array.from(charPinsMap.values());
            
            // 记录到 localStorage，解决刷新消失问题
            const widgetData = { texts: widgetTexts, msgId: msgId };
            localStorage.setItem(`lover_sync_widget_${charId}`, JSON.stringify(widgetData));
            
            // 展开悬浮备忘录
            const widget = document.getElementById('sync-memo-widget');
            const list = document.getElementById('sync-memo-list');
            if (widget && list) {
                list.innerHTML = '';
                widgetTexts.forEach((text) => {
                    const li = document.createElement('li');
                    li.textContent = text;
                    list.appendChild(li);
                });
                widget.classList.remove('hidden');
                widget.dataset.currentCharId = charId; 
                widget.dataset.msgId = msgId;          
                setTimeout(() => widget.classList.remove('collapsed'), 50);
            }

            showDynamicIsland(isSilent ? '已无感植入剧情背景' : '已有感同步至云端', 'success');
            cleanupAndExit();
        };

        // 绑定两个按钮的不同行为
        modal.querySelector('#pin-confirm-btn').addEventListener('click', () => handleSync(false));
        modal.querySelector('#pin-silent-btn').addEventListener('click', () => handleSync(true));
    }
    // ▼▼▼ [新增] 绑定悬浮备忘录的交互事件 ▼▼▼
    const syncWidget = document.getElementById('sync-memo-widget');
    const syncToggle = document.getElementById('sync-memo-toggle');
    const syncClear = document.getElementById('sync-memo-clear-btn');
    const syncUndo = document.getElementById('sync-memo-undo-btn');
    
    if (syncWidget && syncToggle && syncClear && !syncWidget.dataset.bound) {
        syncWidget.dataset.bound = 'true'; // 防止重复绑定
        
        // 页面切换时检查聊天详情页状态，实现角色的隔离和持久化恢复，避免后台空转轮询
        const refreshSyncMemoWidget = (event = null) => {
            const chatPage = document.getElementById('page-chat-detail');
            if (!chatPage || !syncWidget) return;
            
            // 判断聊天详情页是否在前台显示：只看路由写入的状态，避免每次切页强制重算样式
            const openedPageId = event?.detail?.pageId;
            const inlineDisplay = chatPage.style.display;
            const isChatActive = openedPageId
                ? openedPageId === 'page-chat-detail'
                : (chatPage.classList.contains('active') || inlineDisplay === 'flex' || inlineDisplay === 'block');
            if (isChatActive) {
                const charId = tempState?.currentChatId;
                if (charId) {
                    const saved = localStorage.getItem(`lover_sync_widget_${charId}`);
                    // 如果有存档且当前没显示该角色的，就恢复显示
                    if (saved && syncWidget.dataset.currentCharId !== charId) {
                        const data = JSON.parse(saved);
                        const list = document.getElementById('sync-memo-list');
                        if (list) {
                            list.innerHTML = '';
                            data.texts.forEach(text => {
                                const li = document.createElement('li');
                                li.textContent = text;
                                list.appendChild(li);
                            });
                        }
                        syncWidget.dataset.currentCharId = charId;
                        syncWidget.dataset.msgId = data.msgId;
                                           
                        // 【新增】：根据内容前缀动态区分标题，防止不同功能之间混淆
                        const titleEl = syncWidget.querySelector('.title');
                        if (titleEl) {
                            titleEl.textContent = (data.texts[0] && data.texts[0].startsWith('【监控记录】')) ? 'MONITOR LOG' : 'SYNC MEMO';
                        }
                        
                        syncWidget.classList.remove('hidden');
                        syncWidget.classList.remove('collapsed');
                    } 
                    // 如果没有存档，但当前绑定的角色不对，就隐藏
                    else if (!saved && syncWidget.dataset.currentCharId !== charId) {
                        syncWidget.dataset.currentCharId = charId;
                        syncWidget.classList.add('hidden');
                        syncWidget.classList.add('collapsed');
                    }
                }
            } else {
                // 页面不在前台，解绑以备重新检测
                syncWidget.dataset.currentCharId = '';
                syncWidget.classList.add('hidden');
                syncWidget.classList.add('collapsed');
            }
        };
        window.addEventListener('looky:page-opened', refreshSyncMemoWidget);
        refreshSyncMemoWidget();

        // 点击头部：展开/折叠
        syncToggle.addEventListener('click', () => syncWidget.classList.toggle('collapsed'));
        
        // 点击阅毕清除：清理localStorage并隐藏
        syncClear.addEventListener('click', () => {
            const charId = syncWidget.dataset.currentCharId;
            if (charId) localStorage.removeItem(`lover_sync_widget_${charId}`);
            
            syncWidget.classList.add('collapsed');
            setTimeout(() => {
                syncWidget.classList.add('hidden');
                document.getElementById('sync-memo-list').innerHTML = '';
            }, 300); // 等待高度缩回的动画结束再隐藏
        });

        // 点击撤回：删除数据库记录、清理localStorage并隐藏
        if (syncUndo) {
            syncUndo.addEventListener('click', async () => {
                const charId = syncWidget.dataset.currentCharId;
                const msgId = syncWidget.dataset.msgId;
                if (charId && msgId) {
                    try {
                        // 删除之前插入的隐式系统消息
                        await db.chatMessages.delete(Number(msgId));
                        // 同步删除内存中的记录
                        if (AppState.currentChatHistory) {
                            AppState.currentChatHistory = AppState.currentChatHistory.filter(msg => msg.id !== Number(msgId));
                        }
                        showDynamicIsland('已撤回刚才的同步内容');
                    } catch(e) {
                        console.error('撤回同步失败', e);
                    }
                    localStorage.removeItem(`lover_sync_widget_${charId}`);
                    syncWidget.classList.add('collapsed');
                    setTimeout(() => {
                        syncWidget.classList.add('hidden');
                        document.getElementById('sync-memo-list').innerHTML = '';
                    }, 300);
                }
            });
        }
    }
    // ▲▲▲ [新增结束] ▲▲▲

} // <--- 这是你整个文件最后原有的那个 initCheckPhone 的结束大括号

