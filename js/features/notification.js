// js/features/notification.js

import { UI, showPage } from '../ui.js';
import { tempState, AppState } from '../state.js'; 
import { handleFriendClick } from './chat.js';
import { isNativeRuntime, showNativeNotification } from '../native-bridge.js';
// 1. 定义样式：微信风格顶部横幅
const style = document.createElement('style');
style.innerHTML = `
#notification-container {
    position: fixed;
    top: 50px; /* 顶部距离，避开状态栏 */
    left: 0;
    right: 0;
    width: 96%; /* 左右留一点边距 */
    width: auto;
    padding: 0 16px;
    box-sizing: border-box;
    z-index: 10000;
    pointer-events: none; /* 容器本身不阻挡点击 */
    display: flex;
    justify-content: center;
}

.notify-toast {
    background: rgba(255, 255, 255, 0.98);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-radius: 12px; /* 微信风格圆角 */
    padding: 12px 16px;
    box-shadow: 0 5px 15px rgba(0,0,0,0.1);
    display: flex;
    align-items: center;
    gap: 12px;
    pointer-events: auto; /* 卡片可点击 */
    cursor: pointer;
    width: 100%;
    max-width: 500px;
    
    /* 进场动画 */
    animation: notifySlideDown 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
    transition: transform 0.2s ease, opacity 0.2s ease;
    border: 1px solid rgba(0,0,0,0.05);
}

/* 点击时的缩放效果 */
.notify-toast:active {
    transform: scale(0.98);
}

.notify-toast.hiding {
    opacity: 0;
    transform: translateY(-100%);
}

.notify-avatar {
    width: 40px;
    height: 40px;
    border-radius: 6px; /* 微信风格方形圆角头像 */
    object-fit: cover;
    flex-shrink: 0;
}

.notify-content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: center;
}

.notify-title {
    font-size: 14px;
    font-weight: 600;
    color: #111;
    margin-bottom: 3px;
    line-height: 1.2;
}

.notify-text {
    font-size: 13px;
    color: #666;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.2;
}

@keyframes notifySlideDown {
    from { transform: translateY(-150%); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
}
`;
document.head.appendChild(style);

// 2. 模块级变量，用于记录当前正在显示的“唯一”通知
let activeToast = null;
let activeTimer = null;

function compactNotificationText(text, maxLength = 120) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export const notification = {
     /**
     * 显示通知 (微信覆盖模式)
     */
    show(title, message, avatar, targetPage, targetId = null) {
        // 【修复Bug开始】如果当前正在语音(page-voice-call)或视频(video-call-container)通话中，直接不显示通知
        const voicePage = document.getElementById('page-voice-call');
        const videoPage = document.getElementById('video-call-container');
        if ((voicePage && getComputedStyle(voicePage).display !== 'none') || 
            (videoPage && getComputedStyle(videoPage).display !== 'none')) {
            return; 
        }
        // 语音通话缩成小窗后，通话对象的回复不再弹顶部横幅，由小窗右下角红点提示。
        const activeVoiceCallChatId = tempState.activeCallMode === 'voice' && tempState.currentCallId
            ? tempState.activeCallChatId
            : null;
        if (activeVoiceCallChatId && targetId && String(activeVoiceCallChatId) === String(targetId)) {
            return;
        }

        const isAppInBackground = document.visibilityState === 'hidden' || !document.hasFocus();
        const isPushEnabled = localStorage.getItem('system_push_enabled') === 'true';
        if (isAppInBackground && isPushEnabled && isNativeRuntime()) {
            showNativeNotification(title, compactNotificationText(message), {
                targetPage,
                targetId,
                avatar
            }).catch(error => console.warn('[Notification] Native notification failed:', error));
            return;
        }
        // 【修复Bug结束】
        const container = document.getElementById('notification-container');
        if (!container) return;

        // ▼▼▼ 【核心修改】优先使用角色的备注名和专属头像 ▼▼▼
        let displayTitle = title;
        let displayAvatar = avatar;

        if (targetPage === 'page-sms-detail') {
            // 【修复】完美的苹果系统短信图标，绝对居中不会变形
            displayAvatar = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCI+PHJlY3Qgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMDAiIGZpbGw9IiMzNEM3NTkiIHJ4PSIyMiIgcnk9IjIyIiAvPjxwYXRoIGQ9Ik01MCwyMiBDMzAuNjcsMjIgMTUsMzUuNDMgMTUsNTIgQzE1LDYxLjk0IDIwLjY1LDcwLjc2IDI5LjM1LDc2IEMyOC4xLDgxIDI0LDg1IDI0LDg1IEMyNCw4NSAzNCw4NCA0MC41LDc5IEM0My41LDgwLjMgNDYuNjgsODEgNTAsODEgQzY5LjMzLDgxIDg1LDY3LjU3IDg1LDUyIEM4NSwzNS40MyA2OS4zMywyMiA1MCwyMiBaIiBmaWxsPSIjRkZGRkZGIiAvPjwvc3ZnPg==';
            if (targetId) {
                const character = AppState.characterProfiles.find(c => String(c.id) === String(targetId));
                if (character) displayTitle = character.chatOverrideName || character.name;
            }
        } else if (targetId) {
            // 尝试在全局状态中找到这个角色
            const character = AppState.characterProfiles.find(c => String(c.id) === String(targetId));
            if (character) {
                // 如果有备注名，就用备注名；否则用真名
                displayTitle = character.chatOverrideName || character.name;
                // 如果有专属头像，就用专属头像；否则用原头像
                displayAvatar = character.chatOverrideAvatar || character.avatar || avatar;
            }
        }
        // ▲▲▲ 修改结束 ▲▲▲

        // 【核心逻辑】如果当前已经有通知显示在屏幕上
        if (activeToast) {
            // A. 只是更新内容 (覆盖)
            const titleEl = activeToast.querySelector('.notify-title');
            const textEl = activeToast.querySelector('.notify-text');
            const imgEl = activeToast.querySelector('.notify-avatar');

            // 这里使用处理过的新变量 displayTitle 和 displayAvatar
            if (titleEl) titleEl.textContent = displayTitle;
            if (textEl) textEl.textContent = message;
            if (imgEl && imgEl.src !== displayAvatar) imgEl.src = displayAvatar;

            // B. 重置“消失”倒计时
            if (activeTimer) clearTimeout(activeTimer);
            activeTimer = setTimeout(() => {
                this.remove(activeToast);
            }, 3500);

            // C. 更新点击事件
            activeToast.onclick = () => this._handleClick(targetPage, targetId);
            
            return; // 更新完毕，退出
        }

        // --- 如果没有通知，才创建新的 ---

        // 1. 创建 DOM (使用 displayAvatar 和 displayTitle)
        const toast = document.createElement('div');
        toast.className = 'notify-toast';
        toast.innerHTML = `
            <img src="${displayAvatar}" class="notify-avatar" onerror="this.src='images/default-avatar.svg'">
            <div class="notify-content">
                <div class="notify-title">${displayTitle}</div>
                <div class="notify-text">${message}</div>
            </div>
        `;

        // 2. 绑定点击事件
        toast.onclick = () => this._handleClick(targetPage, targetId);

        // 3. 添加到容器
        container.appendChild(toast);
        
        // 4. 记录为当前活跃通知
        activeToast = toast;

        // 5. 设置倒计时
        activeTimer = setTimeout(() => {
            this.remove(toast);
        }, 3500);
    },
    /**
     * 内部点击处理函数
     */
  async _handleClick(targetPage, targetId) {
    if (targetPage === 'page-forum-dm' && targetId) {
        let Forum = window.Forum;
        if (!Forum && typeof window.ensureForumLoaded === 'function') {
            try {
                Forum = await window.ensureForumLoaded();
            } catch (error) {
                console.warn('[Notification] Forum load unavailable:', error);
            }
        }
        if (Forum && typeof Forum.openDmFromNotification === 'function') {
            Forum.openDmFromNotification(targetId);
        }
        this.clear();
        return;
    }
    // 1. 如果目标是聊天详情页，并且有角色ID
    if (targetPage === 'page-chat-detail' && targetId) {
        // 【核心修复】不要自己干活！直接呼叫我们的“总指挥” handleFriendClick。
        // 所有性能优化、页面准备工作都在那里统一处理了。
        handleFriendClick(String(targetId));
    } else if (targetPage === 'page-sms-detail' && targetId) {
        // ▼▼▼ 新增：如果是短信通知，点击直接跳转到该联系人的短信界面 ▼▼▼
        try {
            if (typeof window.ensureSmsLoaded === 'function') {
                const SMSModule = await window.ensureSmsLoaded();
                SMSModule.openSmsDetail(targetId);
            } else {
                const { SMSModule } = await import('./sms.js');
                SMSModule.init();
                SMSModule.openSmsDetail(targetId);
            }
        } catch (error) {
            console.warn('[Notification] SMS load unavailable:', error);
        }
    } else if (targetPage) {
        // 对于其他非聊天页面，保持原有逻辑
        showPage(targetPage);
    }
    
    // 2. 点击后，清除通知横幅 (这个行为保持不变)
    this.clear();
},

    /**
     * 移除单个通知元素
     */
    remove(element) {
        if (!element) return;
        
        // 如果移除的是当前活跃的，清理引用
        if (element === activeToast) {
            activeToast = null;
            if (activeTimer) clearTimeout(activeTimer);
        }

        element.classList.add('hiding');
        element.addEventListener('transitionend', () => {
            if (element.parentElement) element.remove();
        });
    },

    /**
     * 强力清屏 (打断机制)
     */
    clear() {
        const container = document.getElementById('notification-container');
        if (activeToast) {
            // 立即移除当前活跃通知，不等待动画
            activeToast.remove(); 
            activeToast = null;
        }
        if (activeTimer) {
            clearTimeout(activeTimer);
            activeTimer = null;
        }
        if (container) {
            container.innerHTML = '';
        }
        console.log('[Notification] 通知已中断');
    }
};

// 全局监听：只要用户点击了聊天详情页，就清空通知
document.addEventListener('click', (e) => {
    const chatPage = document.getElementById('page-chat-detail');
    // 如果点击发生在聊天页面内，且该页面是显示状态
    if (chatPage && chatPage.contains(e.target) && window.getComputedStyle(chatPage).display !== 'none') {
        notification.clear();
    }
}, { passive: true });

export function showChatMessageNotification(char, message, targetId = null) {
    if (!char) return false;

    const title = char.chatOverrideName || char.name || '未知角色';
    const body = compactNotificationText(message, 120);
    if (!body) return false;

    const chatDetailPage = document.getElementById('page-chat-detail');
    const isPageVisible = chatDetailPage && chatDetailPage.offsetParent !== null && window.getComputedStyle(chatDetailPage).display !== 'none';
    const isSameChat = String(tempState.currentChatId || '').trim() === String(targetId || char.id || '').trim();
    const isAppInBackground = document.visibilityState === 'hidden' || !document.hasFocus();
    const isPushEnabled = localStorage.getItem('system_push_enabled') === 'true';

    if (!isAppInBackground && (!isPageVisible || !isSameChat)) {
        notification.show(title, body, char.avatar || null, 'page-chat-detail', char.id);
        return true;
    }

    if (isAppInBackground && isPushEnabled) {
        if (isNativeRuntime()) {
            showNativeNotification(title, body, {
                targetPage: 'page-chat-detail',
                targetId: char.id,
                avatar: char.avatar || ''
            }).catch(error => console.warn('[Notification] Native notification failed:', error));
            return true;
        }

        if (!(window.Notification && Notification.permission === 'granted')) return false;

        let safeIcon = 'images/icon-192.png';
        if (char.avatar && !char.avatar.startsWith('data:image') && !char.avatar.startsWith('blob:')) {
            safeIcon = char.avatar;
        }
        const notifOptions = {
            body,
            icon: safeIcon,
            badge: 'images/icon-192.png',
            tag: `msg-${Date.now()}`,
            vibrate: [200, 100, 200]
        };
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistration().then(reg => {
                if (reg && reg.showNotification) {
                    reg.showNotification(title, notifOptions).catch(() => {
                        new Notification(title, notifOptions);
                    });
                } else {
                    new Notification(title, notifOptions);
                }
            }).catch(() => {
                new Notification(title, notifOptions);
            });
        } else {
            new Notification(title, notifOptions);
        }
        return true;
    }

    return false;
}
