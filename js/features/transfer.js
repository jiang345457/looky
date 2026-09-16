// js/features/transfer.js (最终优化版 - 修复屏闪)

import { UI, showDynamicIsland, showPage } from '../ui.js'; 
import { AppState, tempState, db, DEFAULT_AVATAR_SRC } from '../state.js';
import { escapeHTML, isValidAvatarSrc } from '../utils.js';
import { getCurrentChatIdentity } from './chat-ui.js';
import { getLookyReceiveTargets, receiveLookyTransferFunds, requestLookyPayment } from './looky-pay.js';

let createAndAppendMessageCallback;
let triggerAiResponseCallback;
let currentTransferMessageId = null;
let transferDomRefs = null;

function updateTransferMessageInDOM(messageId, status) {
    const messageWrapper = document.querySelector(`#chat-message-list [data-message-id="${messageId}"]`);
    if (!messageWrapper) return;

    const transferCard = messageWrapper.querySelector('.transfer-card');
    if (!transferCard) return;

    transferCard.removeEventListener('click', () => {});
    transferCard.style.cursor = 'default';

    const acceptedIcon = `<svg class="transfer-icon" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="white"/><path d="M30 52 L45 67 L70 42" stroke="#FA9D3B" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const rejectedIcon = `<svg class="transfer-icon" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="white"/><path d="M65,35 L65,65 M35,50 L65,50 M35,50 L45,40 M35,50 L45,60" stroke="#FA9D3B" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    
    let newStatusText = '';
    let newIconSVG = '';

    if (status === 'accepted') {
        newStatusText = '已被接收';
        newIconSVG = acceptedIcon;
    } else {
        newStatusText = '已被退回';
        newIconSVG = rejectedIcon;
    }

    const iconElement = transferCard.querySelector('.transfer-icon');
    const statusTextElement = transferCard.querySelector('.status-text');

    if (iconElement) iconElement.outerHTML = newIconSVG;
    if (statusTextElement) statusTextElement.textContent = newStatusText;
    
    transferCard.classList.remove('transfer-pending');
    transferCard.classList.add('transfer-receipt');
}

async function handleTransferAccept(messageId, options = {}) {
    if (!messageId) return;
    try {
        const originalMessage = await db.chatMessages.get(messageId);
        if (!originalMessage) return;

        const payerName = originalMessage.speakerName
            || originalMessage.transferInfo.senderName
            || originalMessage.transferInfo.targetName
            || '对方';
        const receiveTarget = options.receiveTarget || 'balance';
        const receiveResult = await receiveLookyTransferFunds({
            amount: originalMessage.transferInfo.amount,
            targetValue: receiveTarget,
            sourceId: messageId,
            payerName,
            chatId: originalMessage.chatId,
            remark: originalMessage.transferInfo.remark || ''
        });

        await db.chatMessages.update(messageId, { 'transferInfo.status': 'accepted' });
        updateTransferMessageInDOM(messageId, 'accepted');
        const currentUser = getCurrentChatIdentity();
        const receiptMessage = {
            chatId: tempState.currentChatId,
            timestamp: new Date(),
            text: `[转账] 已收款 ${originalMessage.transferInfo.amount}元`,
            type: 'sent',
            contentType: 'transfer_receipt',
            transferInfo: {
                amount: originalMessage.transferInfo.amount,
                status: 'accepted',
            },
            avatarSrc: currentUser.avatar,
        };

        if (createAndAppendMessageCallback) {
            const newMsgId = await db.chatMessages.add(receiptMessage);
            const newMessage = await db.chatMessages.get(newMsgId);
            await createAndAppendMessageCallback(newMessage, true); 
        }
        
        showDynamicIsland(receiveResult.type === 'vault' ? '已存入金库' : '收款成功');

    } catch (error) {
        console.error("处理转账接收失败:", error);
        showDynamicIsland('处理转账失败');
    }
}

async function handleTransferReject(messageId) {
    if (!messageId) return;
    try {
        await db.chatMessages.update(messageId, { 'transferInfo.status': 'rejected' });
        const originalMessage = await db.chatMessages.get(messageId);
        if (!originalMessage) return;

        updateTransferMessageInDOM(messageId, 'rejected');

        const currentUser = getCurrentChatIdentity();
        const receiptMessage = {
            chatId: tempState.currentChatId,
            timestamp: new Date(),
            text: `[转账] 已退还 ${originalMessage.transferInfo.amount}元`,
            type: 'sent',
            contentType: 'transfer_receipt',
            transferInfo: {
                amount: originalMessage.transferInfo.amount,
                status: 'rejected',
            },
            avatarSrc: currentUser.avatar,
        };

        if (createAndAppendMessageCallback) {
            const newMsgId = await db.chatMessages.add(receiptMessage);
            const newMessage = await db.chatMessages.get(newMsgId);
            await createAndAppendMessageCallback(newMessage, true);
        }
        
        showDynamicIsland('转账已退回');

    } catch (error) {
        console.error("处理转账退还失败:", error);
        showDynamicIsland('退还失败');
    }
}
export function initTransferFunctionality(createMessageCallback, triggerAiCallback) {
    createAndAppendMessageCallback = createMessageCallback;
    triggerAiResponseCallback = triggerAiCallback;
    transferDomRefs = {
        transferBtn: document.getElementById('transfer-btn'),
        groupTransferBtn: document.getElementById('group-transfer-btn'),
        transferModal: document.getElementById('transfer-modal-overlay'),
        cancelBtn: document.getElementById('cancel-transfer-btn'),
        confirmBtn: document.getElementById('send-transfer-btn'),
        amountInput: document.getElementById('transfer-amount-input'),
        remarkInput: document.getElementById('transfer-remark-input'),
        recipientNameEl: document.getElementById('transfer-recipient-name'),
        recipientAvatarEl: document.getElementById('transfer-recipient-avatar'),
        functionPanel: document.getElementById('chat-function-panel'),
        groupFunctionPanel: document.getElementById('group-chat-function-panel')
    };
    // 用全局标志位防止重复绑定，安全可靠
    if (window._transferEventsBound) return;
    window._transferEventsBound = true;
    document.addEventListener('showTransferDetail', (event) => {
        currentTransferMessageId = event.detail.messageId;
        setTimeout(async () => {
            const msg = await db.chatMessages.get(currentTransferMessageId);
            if (!msg || msg.type !== 'received' || msg.contentType !== 'transfer' || msg.transferInfo?.status !== 'pending') return;
            await renderTransferReceiveTargets(msg.chatId);
        }, 30);
    });
    const acceptButton = document.getElementById('transfer-detail-confirm-btn');
    const rejectLink = document.getElementById('transfer-detail-reject-link');
    
    if (acceptButton) {
        acceptButton.addEventListener('click', async () => {
            const selectedTarget = document.querySelector('#transfer-detail-target-list .transfer-target-option.active')?.dataset.value || 'balance';
            await handleTransferAccept(currentTransferMessageId, { receiveTarget: selectedTarget });
            showPage('page-chat-detail');
        });
    }
    if (rejectLink) {
        rejectLink.addEventListener('click', async (e) => {
            e.preventDefault(); 
            await handleTransferReject(currentTransferMessageId);
            showPage('page-chat-detail');
        });
    }
    const { transferBtn, groupTransferBtn, transferModal, cancelBtn, confirmBtn, amountInput } = transferDomRefs;
    if (transferBtn) transferBtn.addEventListener('click', () => showTransferModal());
    if (groupTransferBtn) groupTransferBtn.addEventListener('click', () => showTransferModal());
    
    if (transferModal) {
        transferModal.addEventListener('click', (e) => { if (e.target === transferModal) hideTransferModal(); });
    }
    
    if (cancelBtn) cancelBtn.addEventListener('click', hideTransferModal);
    if (confirmBtn) confirmBtn.addEventListener('click', handleConfirmTransfer);
    
    if (amountInput) {
        amountInput.addEventListener('input', () => {
            let value = amountInput.value.replace(/[^\d.]/g, "").replace(/\.{2,}/g, ".").replace(".", "$#$").replace(/\./g, "").replace("$#$", ".").replace(/^(-)*(\d+)\.(\d\d).*$/, '$1$2.$3');
            amountInput.value = value;
        });
    }
}
function showTransferModal(targetId = null) {
    const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
    if (!char) return;
    if (char.isGroup && !targetId) {
        showGroupTransferSelector(char);
        return;
    }
    const targetChar = targetId ? AppState.characterProfiles.find(c => c.id === targetId) : char;
    if (!targetChar) return;
    tempState.currentTransferTargetId = targetChar.id;
    const refs = transferDomRefs || {};
    const recipientNameEl = refs.recipientNameEl || document.getElementById('transfer-recipient-name');
    const recipientAvatarEl = refs.recipientAvatarEl || document.getElementById('transfer-recipient-avatar');
    const amountInput = refs.amountInput || document.getElementById('transfer-amount-input');
    const remarkInput = refs.remarkInput || document.getElementById('transfer-remark-input');
    const transferModal = refs.transferModal || document.getElementById('transfer-modal-overlay');
    const functionPanel = refs.functionPanel || document.getElementById('chat-function-panel');
    const groupFunctionPanel = refs.groupFunctionPanel || document.getElementById('group-chat-function-panel');
    if (!recipientNameEl || !recipientAvatarEl || !amountInput || !remarkInput || !transferModal) return;
    recipientNameEl.textContent = `向 ${escapeHTML(targetChar.name)} 转账`;
    recipientAvatarEl.src = isValidAvatarSrc(targetChar.avatar) ? targetChar.avatar : DEFAULT_AVATAR_SRC;
    amountInput.value = '';
    remarkInput.value = '';
    functionPanel?.classList.add('hidden');
    groupFunctionPanel?.classList.add('hidden');
    transferModal.classList.add('visible');
    window.__pauseAutoTriggerCountdown?.();
}
function showGroupTransferSelector(groupChar) {
    const modal = document.getElementById('group-transfer-selector-overlay');
    if (!modal) return;
    const listContainer = document.getElementById('group-transfer-selector-list');
    
    let membersHtml = '';
    const members = (groupChar.memberIds || []).map(id => AppState.characterProfiles.find(c => String(c.id) === String(id))).filter(Boolean);
    
    members.forEach(m => {
        membersHtml += `
            <div class="pay-char-item" data-id="${m.id}" style="display:flex; align-items:center; padding:12px; border-bottom:1px solid #f0f0f0; cursor:pointer; transition: background 0.2s;">
                <img src="${isValidAvatarSrc(m.avatar)?m.avatar:DEFAULT_AVATAR_SRC}" style="width:40px;height:40px;border-radius:50%;margin-right:12px; object-fit: cover;">
                <span style="font-size:15px; color:#333;">${escapeHTML(m.name)}</span>
            </div>
        `;
    });
    
    listContainer.innerHTML = membersHtml;
    modal.classList.add('visible');
    window.__pauseAutoTriggerCountdown?.();
    const closeBtn = document.getElementById('close-group-transfer-selector-btn');
    const closeSelector = () => {
        modal.classList.remove('visible');
        window.__resumeAutoTriggerCountdown?.();
    };
    closeBtn.onclick = closeSelector;
    modal.onclick = (e) => { if (e.target === modal) closeSelector(); };
    listContainer.querySelectorAll('.pay-char-item').forEach(item => {
        item.onclick = () => {
            modal.classList.remove('visible'); 
            showTransferModal(item.dataset.id); 
        };
    });
}
function hideTransferModal() {
    const modal = document.getElementById('transfer-modal-overlay');
    if (modal) modal.classList.remove('visible');
    window.__resumeAutoTriggerCountdown?.();
}
async function handleConfirmTransfer() {
    const amountInput = document.getElementById('transfer-amount-input');
    const remarkInput = document.getElementById('transfer-remark-input');
    const amount = parseFloat(amountInput.value);
    const remark = remarkInput.value.trim();
    if (isNaN(amount) || amount <= 0) {
        showDynamicIsland('请输入有效的转账金额');
        return;
    }
    const payment = await requestLookyPayment({
        amount,
        title: '转账付款',
        scene: 'transfer',
        charge: false
    });
    if (!payment) return;
    const currentUser = getCurrentChatIdentity();
    const targetId = tempState.currentTransferTargetId || tempState.currentChatId;
    const targetChar = AppState.characterProfiles.find(c => c.id === targetId);
    const transferMessage = {
        chatId: tempState.currentChatId,
        timestamp: new Date(),
        text: `[转账] ${amount.toFixed(2)}元`,
        type: 'sent',
        contentType: 'transfer',
        transferInfo: {
            amount: amount.toFixed(2),
            remark: remark,
            status: 'pending',
            targetId: targetId,
            targetName: targetChar ? targetChar.name : '',
            paymentMethod: payment.displayName || '',
            paymentCardId: payment.paymentCardId || (payment.type === 'card' ? payment.id : 'balance')
        },
        avatarSrc: currentUser.avatar,
    };
    if (createAndAppendMessageCallback) {
        const messageId = await db.chatMessages.add(transferMessage);
        const newMessage = await db.chatMessages.get(messageId);
        await createAndAppendMessageCallback(newMessage);
    }
    hideTransferModal();
    window.__autoTriggerCountdown?.();
}

async function renderTransferReceiveTargets(preferredCharId = '') {
    const list = document.getElementById('transfer-detail-target-list');
    if (!list) return;
    const targets = await getLookyReceiveTargets(preferredCharId);
    list.innerHTML = targets.map((target, index) => `
        <button type="button" class="transfer-target-option ${index === 0 ? 'active' : ''}" data-value="${escapeHTML(target.value)}">
            <span class="transfer-target-icon">${escapeHTML(target.icon)}</span>
            <span class="transfer-target-text">
                <strong>${escapeHTML(target.title)}</strong>
                <small>${escapeHTML(target.desc)}</small>
            </span>
            <span class="transfer-target-check">✓</span>
        </button>
    `).join('');
    list.querySelectorAll('.transfer-target-option').forEach(btn => {
        btn.addEventListener('click', () => {
            list.querySelectorAll('.transfer-target-option').forEach(item => item.classList.remove('active'));
            btn.classList.add('active');
        });
    });
}
