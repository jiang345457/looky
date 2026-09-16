// js/features/voice.js (最终修复版)

import { AppState, tempState, db } from '../state.js';
import { showDynamicIsland } from '../ui.js';
import { createAndAppendMessage, getCurrentChatIdentity } from './chat-ui.js';

let isVoiceInitialized = false;

/**
 * 初始化语音功能
 */
export function initVoiceFunctionality() {
    if (isVoiceInitialized) {
        return;
    }

    const voiceBtn = document.getElementById('voice-btn');
    const voiceModal = document.getElementById('voice-input-modal-overlay');
    const cancelBtn = document.getElementById('cancel-voice-btn');
    const sendBtn = document.getElementById('send-voice-btn');
    const textarea = document.getElementById('voice-input-textarea');
    const functionPanel = document.getElementById('chat-function-panel');

    if (!voiceBtn || !voiceModal) return;

    // 点击功能面板的语音按钮
    voiceBtn.addEventListener('click', (event) => {
        // 【核心修正】阻止事件冒泡，防止与其他点击事件冲突
        event.stopPropagation(); 
        
        textarea.value = '';
        voiceModal.classList.add('visible');
        window.__pauseAutoTriggerCountdown?.();
        textarea.focus();
        if(functionPanel) functionPanel.classList.add('hidden');
    });

    // 关闭弹窗
    const hideModal = () => {
        voiceModal.classList.remove('visible');
        window.__resumeAutoTriggerCountdown?.();
    };

    cancelBtn.addEventListener('click', hideModal);
    voiceModal.addEventListener('click', (e) => {
        if (e.target === voiceModal) hideModal();
    });

    // 点击发送按钮
    sendBtn.addEventListener('click', async () => {
        const textContent = textarea.value.trim();
        if (!textContent) {
            showDynamicIsland('语音内容不能为空');
            return;
        }

        const currentUser = getCurrentChatIdentity();
        if (!currentUser) {
            console.error("无法获取当前用户身份");
            return;
        }

        const voiceMessage = {
            chatId: tempState.currentChatId,
            timestamp: new Date(),
            text: textContent,
            type: 'sent',
            contentType: 'voice',
            avatarSrc: currentUser.avatar,
        };

        const messageId = await db.chatMessages.add(voiceMessage);
        await createAndAppendMessage({ ...voiceMessage, messageId: messageId });

        hideModal();
        window.__autoTriggerCountdown?.();
    });

    isVoiceInitialized = true;
    console.log('Voice functionality initialized.');
}
