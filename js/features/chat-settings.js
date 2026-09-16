
import { AppState, db, tempState, chatState, DEFAULT_AVATAR_SRC, DEFAULT_NOTIFICATION_SRC, DEFAULT_SEND_SOUND_SRC, getAllWorldBooksGrouped, cleanupInvalidCharacterScopedThemeApplications, isCharacterScopedThemeRule, themeRuleTargetsCharacter, getEffectiveThemeRuleForTarget, mergeThemeCharacterIds } from '../state.js'; // ◀◀◀ 在这里添加 getAllWorldBooksGrouped
import { purifyShortTermContext, triggerActiveMessage, clearFollowUpPlan, markPendingContextSwitch } from './chat-service.js';
import { getCharacterReplyLanguage } from '../state.js';
import { showDynamicIsland, showPage, showInputModal, showSimpleSelectModal } from '../ui.js'; // ▼ 修改：增加了 showSimpleSelectModal
import { isValidAvatarSrc, escapeHTML } from '../utils.js';
import { optimizedSaveAndRender } from './character.js';
import { getCurrentChatIdentity, loadAndRenderChatHistory } from './chat-ui.js';
import { clearFriendRequestDataForCharacters } from './friend-requests.js';
import { momentsModule } from './moments.js';
import { themeState } from '../state.js'; // ▼ 新增引入 themeState
import { getLookyReceiveTargets } from './looky-pay.js';
import { clearMemoryRuntimeCaches } from './memory.js';
import { DEFAULT_CALL_SETTINGS, getCallSettings, normalizeCallSettings, setCallAmbientVolume, startCallAmbient } from './call-audio.js';
import { setCallTtsVolume } from './tts-service.js';
import { disableSleepSchedule, getLocalDateKey, getSleepRecordBySleepDate, getSleepSettings } from './sleep-system.js';
let activeTransferMessageId = null;
// 模块级变量，用于音频预览
let previewAudio = null;
let callPreviewAudio = null;
let chatSettingsRenderFrame = 0;
let chatSettingsRenderToken = 0;
let quickBeautifySchemesCache = null;

window.addEventListener('looky:theme-schemes-updated', () => {
    quickBeautifySchemesCache = null;
    updateQuickBeautifyText().catch(error => {
        console.warn('[ChatSettings] 刷新快捷美化方案名称失败:', error);
    });
});

/**
 * 设置页只初始化一次滚动行为，避免桌面拖动时把设置文字当成选区。
 * 输入框和文本域仍保留文本选择，方便正常编辑内容。
 */
function setupChatSettingsScrollBehavior() {
    const page = document.getElementById('page-chat-settings');
    const content = page?.querySelector('.app-content.settings-style-content');
    if (!content || content.dataset.scrollOptimized === '1') return;

    content.dataset.scrollOptimized = '1';
    content.style.touchAction = 'pan-y';
    content.style.overscrollBehavior = 'contain';
    content.style.webkitOverflowScrolling = 'touch';
    content.style.userSelect = 'none';
    content.style.webkitUserSelect = 'none';

    content.querySelectorAll('input, select, textarea, [contenteditable="true"]').forEach(element => {
        element.style.userSelect = 'text';
        element.style.webkitUserSelect = 'text';
    });
}

function scheduleChatSettingsRender() {
    const renderToken = ++chatSettingsRenderToken;
    if (chatSettingsRenderFrame) cancelAnimationFrame(chatSettingsRenderFrame);

    chatSettingsRenderFrame = requestAnimationFrame(() => {
        chatSettingsRenderFrame = requestAnimationFrame(() => {
            chatSettingsRenderFrame = 0;
            const page = document.getElementById('page-chat-settings');
            if (renderToken !== chatSettingsRenderToken || !page || page.style.display === 'none') return;
            renderChatSettingsPage();
        });
    });
}

function showSleepEditConfirmModal(previous, next, onChoice, { hasTodaySchedule = true } = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'sleep-edit-confirm-overlay';
    const wakeChanged = Number(previous.wakeAfterMessages) !== Number(next.wakeAfterMessages);
    overlay.innerHTML = `
        <div class="sleep-edit-confirm-card" role="dialog" aria-modal="true" aria-labelledby="sleep-edit-confirm-title">
            <h3 id="sleep-edit-confirm-title">确认修改睡眠计划</h3>
            <div class="sleep-edit-confirm-section"><span>旧设置</span><strong>${escapeHTML(previous.sleepTime)} → ${escapeHTML(previous.wakeTime)}</strong></div>
            <div class="sleep-edit-confirm-section"><span>新设置</span><strong>${escapeHTML(next.sleepTime)} → ${escapeHTML(next.wakeTime)}</strong></div>
            ${wakeChanged ? `<div class="sleep-edit-confirm-threshold">唤醒阈值：${Number(previous.wakeAfterMessages)} → ${Number(next.wakeAfterMessages)} 条消息</div>` : ''}
            <div class="sleep-edit-confirm-actions">
                ${hasTodaySchedule
                    ? '<button type="button" data-sleep-choice="sync">保存并重新推演后续行程</button><button type="button" data-sleep-choice="only">仅保存睡眠设置</button>'
                    : '<button type="button" data-sleep-choice="only">保存修改</button>'}
                <button type="button" data-sleep-choice="cancel">取消</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    const close = async choice => {
        overlay.remove();
        await onChoice(choice);
    };
    overlay.addEventListener('click', event => {
        const button = event.target.closest('[data-sleep-choice]');
        if (button) close(button.dataset.sleepChoice).catch(error => showDynamicIsland(error.message || '睡眠设置保存失败'));
        else if (event.target === overlay) close('cancel').catch(() => {});
    });
}

async function ensureForumForChatSettings() {
    if (window.Forum) return window.Forum;
    if (typeof window.ensureForumLoaded === 'function') {
        try {
            return await window.ensureForumLoaded();
        } catch (error) {
            console.warn('[ChatSettings] Forum preload unavailable:', error);
        }
    }
    return window.Forum || null;
}


/**
 * 渲染聊天设置页面的内容
 */
function renderChatSettingsPage() {
    const charId = tempState.currentChatId;
    if (!charId) return;
    const char = AppState.characterProfiles.find(c => c.id === charId);
    if (!char) return;
    const settingsPage = document.getElementById('page-chat-settings');
    if (settingsPage) settingsPage.dataset.chatId = String(charId);
    const currentUser = getCurrentChatIdentity();
    if (currentUser) {
        document.getElementById('chat-settings-user-avatar').src = isValidAvatarSrc(currentUser.avatar) ? currentUser.avatar : DEFAULT_AVATAR_SRC;
        document.getElementById('chat-settings-user-name').textContent = escapeHTML(currentUser.name);
    }
     document.getElementById('chat-settings-pin-toggle').checked = char.isPinned || false;
    const stickerMatchToggle = document.getElementById('chat-settings-sticker-match-toggle');
    if (stickerMatchToggle) {
        stickerMatchToggle.checked = char.stickerMatchEnabled ?? false;
    }
    // 新增：初始化动态表情包开关状态
    const momentStickerToggle = document.getElementById('chat-settings-moment-sticker-toggle');
    if (momentStickerToggle) {
        momentStickerToggle.checked = char.momentsStickersEnabled ?? false;
    }
    const momentMusicToggle = document.getElementById('chat-settings-moment-music-toggle');
    if (momentMusicToggle) {
        momentMusicToggle.checked = char.momentsMusicEnabled ?? false;
    }
    const chatPlaylistToggle = document.getElementById('chat-settings-chat-playlist-toggle');
    if (chatPlaylistToggle) {
        chatPlaylistToggle.checked = char.chatPlaylistShareEnabled ?? false;
    }
    // ▼▼▼ 新增：初始化识图提示词开关状态 ▼▼▼
    const visionTextOnlyToggle = document.getElementById('chat-settings-vision-text-only-toggle');
    if (visionTextOnlyToggle) {
        visionTextOnlyToggle.checked = char.visionTextOnlyEnabled ?? false;
    }
    const npcForwardToggle = document.getElementById('chat-settings-npc-forward-toggle');
    if (npcForwardToggle) {
        npcForwardToggle.checked = char.npcChatForwardEnabled === true;
    }
    // ▲▲▲ 新增结束 ▲▲▲
    const ringtoneDisplayName = document.getElementById('current-ringtone-display-name');
    if (ringtoneDisplayName) {
        ringtoneDisplayName.textContent = (char.ringtoneSrc && char.ringtoneSrc !== 'assets/ringtone.mp3') ? '自定义' : '默认';
    }
    const contextTurnsDisplay = document.getElementById('current-context-turns-display');
    if (contextTurnsDisplay) {
        contextTurnsDisplay.textContent = char.contextTurns || 25;
    }
    // ▼▼▼ 新增：初始化天气与季节感知开关状态 ▼▼▼
    const translationExpandedToggleControl = document.getElementById('chat-settings-translation-expanded-toggle');
    if (translationExpandedToggleControl && !translationExpandedToggleControl.dataset.translationBound) {
        translationExpandedToggleControl.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                char.translationDefaultExpanded = translationExpandedToggleControl.checked;
                await optimizedSaveAndRender();
                showDynamicIsland(char.translationDefaultExpanded ? '翻译默认已展开' : '翻译默认已关闭');
            }
        });
        translationExpandedToggleControl.dataset.translationBound = '1';
    }
    const weatherPerceptionToggle = document.getElementById('chat-settings-weather-perception-toggle');
    if (weatherPerceptionToggle) {
        weatherPerceptionToggle.checked = char.weatherPerceptionEnabled !== false; // 默认开启
    }
   // [新增] 初始化自动行程开关状态
    const autoRideToggle = document.getElementById('chat-settings-auto-ride-toggle');
    const sleepToggle = document.getElementById('sleep-schedule-toggle');
    const sleepTimes = document.getElementById('sleep-schedule-times');
    const sleepTimeInput = document.getElementById('sleep-time-input');
    const wakeTimeInput = document.getElementById('wake-time-input');
    const sleepWakeCountInput = document.getElementById('sleep-wake-count-input');
    const sleepDetail = document.getElementById('sleep-settings-detail');
    const sleepCurrent = document.getElementById('sleep-settings-current');
    const sleepUndoBtn = document.getElementById('sleep-settings-undo-btn');
    const sleepApplyBtn = document.getElementById('sleep-settings-apply-btn');
    const focusModePanel = document.getElementById('focus-mode-settings-panel');
    const focusProbSlider = document.getElementById('focus-reply-prob-slider');
    const focusProbVal = document.getElementById('focus-reply-prob-val');
    const focusAutoReply = document.getElementById('focus-auto-reply-input');
 const focusWorkMins = document.getElementById('focus-work-mins-input');
    const focusRestMins = document.getElementById('focus-rest-mins-input');
    if (autoRideToggle) {
        autoRideToggle.checked = char.autoRideEnabled || false;
        if (focusModePanel) focusModePanel.style.display = autoRideToggle.checked ? 'block' : 'none';
    }
    const sleepSettings = getSleepSettings(char);
    if (char.sleepScheduleEnabled === true && !sleepSettings.timePerceptionEnabled) {
        disableSleepSchedule(char).catch(error => console.warn('[睡眠计划] 时间感知关闭，停用睡眠计划失败:', error));
    }
    if (sleepToggle) sleepToggle.checked = sleepSettings.enabled;
    if (sleepDetail) sleepDetail.hidden = !sleepSettings.enabled;
    if (sleepTimes) sleepTimes.style.display = sleepToggle?.checked ? 'grid' : 'none';
    if (sleepTimeInput) sleepTimeInput.value = char.sleepTime || '23:00';
    if (wakeTimeInput) wakeTimeInput.value = char.wakeTime || '07:30';
    if (sleepWakeCountInput) sleepWakeCountInput.value = char.sleepWakeAfterMessages || 6;
    if (sleepCurrent) {
        sleepCurrent.textContent = '等待今日日程推演';
    }
    getSleepRecordBySleepDate(char.id, getLocalDateKey()).then(record => {
        if (!sleepCurrent) return;
        if (!sleepSettings.enabled) return;
        sleepCurrent.textContent = record
            ? `今晚预计 ${record.actualSleepTime} 入睡 · 明早 ${record.actualWakeTime} 起床`
            : '等待今日日程推演';
    }).catch(() => {});
    db.appData.get('sleep_settings_undo_' + char.id).then(record => {
        const currentChar = AppState.characterProfiles.find(item => item.id === char.id);
        const enabled = currentChar ? getSleepSettings(currentChar).enabled : false;
        if (sleepDetail) sleepDetail.hidden = !enabled;
        if (sleepApplyBtn) sleepApplyBtn.disabled = true;
        if (sleepUndoBtn) sleepUndoBtn.hidden = !(enabled && record?.value);
    }).catch(() => {});
    if (focusProbSlider && focusProbVal) {
        const prob = char.focusReplyProbability ?? 20;
        focusProbSlider.value = prob;
        focusProbVal.textContent = prob + '%';
    }
    if (focusAutoReply) {
        focusAutoReply.value = char.focusAutoReplyText || '';
    }
    if (focusWorkMins) focusWorkMins.value = char.focusWorkMins ?? 45;
    if (focusRestMins) focusRestMins.value = char.focusRestMins ?? 10;
         // ▼▼▼ 修复：每次进入设置页时，正确显示后台保活的文字状态 ▼▼▼
    const bgActivityStatusText = document.getElementById('bg-activity-status-text');
    if (bgActivityStatusText) {
        const activeCount = (char.activePostingEnabled ? 1 : 0) + (char.autoDiaryEnabled ? 1 : 0) + (char.activeMessageEnabled ? 1 : 0) + (char.autoScheduleEnabled ? 1 : 0) + (char.followUpEnabled ? 1 : 0);
        bgActivityStatusText.textContent = activeCount > 0 ? `已开启 ${activeCount} 项` : '未配置';
    }
    // ▲▲▲ 修复结束 ▲▲▲
    // ▼▼▼ 新增：初始化与群聊同步记忆开关 ▼▼▼
    const syncGroupToggle = document.getElementById('chat-settings-sync-group-toggle');
    if (syncGroupToggle) {
        syncGroupToggle.checked = char.syncGroupMemoryEnabled ?? false;
    }
    // ▲▲▲ 新增结束 ▲▲▲

    // ▼▼▼ 新增：初始化自动总结开关和折叠轮数 ▼▼▼
    const autoSummaryToggle = document.getElementById('chat-settings-auto-summary-toggle');
    const autoSummarySlider = document.getElementById('auto-summary-turns-slider');
    const autoSummaryValue = document.getElementById('auto-summary-turns-value');
    const offlineAutoSummarySlider = document.getElementById('offline-auto-summary-turns-slider');
    const offlineAutoSummaryValue = document.getElementById('offline-auto-summary-turns-value');
    const autoSummaryDetails = document.getElementById('auto-summary-details');

    if (autoSummaryToggle && autoSummarySlider && autoSummaryValue && autoSummaryDetails) {
        // 1. 设置开关状态
        const isEnabled = char.autoSummaryEnabled !== false;
        autoSummaryToggle.checked = isEnabled; 
        
        // 2. 根据开关状态，决定是否展开面板 (开启则默认展开，关闭则折叠)
        if (isEnabled) {
            autoSummaryDetails.setAttribute('open', '');
        } else {
            autoSummaryDetails.removeAttribute('open');
        }

        // 3. 设置滑块数值
        const currentTurns = char.autoSummaryTurns || 20;
        autoSummarySlider.value = currentTurns;
         autoSummaryValue.textContent = currentTurns;
        // 设置线下滑块数值
        if (offlineAutoSummarySlider && offlineAutoSummaryValue) {
            const currentOfflineTurns = char.offlineAutoSummaryTurns || 10;
            offlineAutoSummarySlider.value = currentOfflineTurns;

            offlineAutoSummaryValue.textContent = currentOfflineTurns;
        }
    }
        // 群聊同理
    const gcOfflineAutoSummarySlider = document.getElementById('gc-offline-auto-summary-slider');
    const gcOfflineAutoSummaryValue = document.getElementById('gc-offline-auto-summary-val');
    if (char.isGroup && gcOfflineAutoSummarySlider && gcOfflineAutoSummaryValue) {
        const currentOfflineTurns = char.offlineAutoSummaryTurns || 10;
        gcOfflineAutoSummarySlider.value = currentOfflineTurns;
        gcOfflineAutoSummaryValue.textContent = currentOfflineTurns;
    }
    // ▲▲▲ 新增结束 ▲▲▲

     const lightPromptToggle = document.getElementById('chat-settings-light-prompt-toggle');
    if (lightPromptToggle) {
        lightPromptToggle.value = (char.useLightPrompt ?? false).toString();
    }
    const minMsgEl = document.getElementById('chat-settings-min-messages');
    const maxMsgEl = document.getElementById('chat-settings-max-messages');
    if (minMsgEl) minMsgEl.value = char.minMessages ?? '';
    if (maxMsgEl) maxMsgEl.value = char.maxMessages ?? '';
    const replyLanguageSelect = document.getElementById('chat-settings-reply-language-select');
    if (replyLanguageSelect) {
        replyLanguageSelect.value = getCharacterReplyLanguage(char);
    }
    const autoTranslateToggle = document.getElementById('chat-settings-auto-translate-toggle');
    if (autoTranslateToggle) {
        autoTranslateToggle.checked = char.autoTranslateEnabled !== false; // 默认开启
    }
        // ▼▼▼ 新增：初始化强效动作引导开关 ▼▼▼
    const translationExpandedToggleState = document.getElementById('chat-settings-translation-expanded-toggle');
    if (translationExpandedToggleState) {
        translationExpandedToggleState.checked = char.translationDefaultExpanded !== false;
    }
    const actionReminderToggle = document.getElementById('chat-settings-action-reminder-toggle');
    if (actionReminderToggle) {
        actionReminderToggle.checked = char.actionReminderEnabled ?? false;
    }
    const formatAnchorToggle = document.getElementById('chat-settings-format-anchor-toggle');
    if (formatAnchorToggle) {
        formatAnchorToggle.checked = char.formatAnchorEnabled === true; // 默认关闭
    }
    // 自动触发回复开关
    const autoSendToggle = document.getElementById('chat-settings-auto-send-toggle');
    const autoSendDelayContainer = document.getElementById('auto-send-delay-container');
    const autoSendDelaySlider = document.getElementById('auto-send-delay-slider');
    const autoSendDelayValue = document.getElementById('auto-send-delay-value');
    if (autoSendToggle) {
        autoSendToggle.checked = char.autoSendEnabled || false;
        if (autoSendDelayContainer) autoSendDelayContainer.style.display = autoSendToggle.checked ? 'block' : 'none';
    }
    if (autoSendDelaySlider && autoSendDelayValue) {
        const delay = char.autoSendDelay || 5;
        autoSendDelaySlider.value = delay;
        autoSendDelayValue.textContent = `${delay} 秒`;
    }
    const followUpToggle = document.getElementById('chat-settings-follow-up-toggle');
    if (followUpToggle) {
        followUpToggle.checked = char.followUpEnabled === true;
        if (!followUpToggle.dataset.followUpBound) {
            followUpToggle.addEventListener('change', async () => {
                const charId = tempState.currentChatId;
                const currentChar = AppState.characterProfiles.find(c => c.id === charId);
                if (!currentChar) return;
                currentChar.followUpEnabled = followUpToggle.checked;
                if (!followUpToggle.checked) {
                    currentChar.followUpPlan = null;
                }
                await db.characterProfiles.update(charId, {
                    followUpEnabled: currentChar.followUpEnabled,
                    followUpPlan: currentChar.followUpPlan || null
                });
                if (typeof showDynamicIsland === 'function') {
                    showDynamicIsland(currentChar.followUpEnabled ? '已开启 AI 自主追发' : '已关闭 AI 自主追发');
                }
            });
            followUpToggle.dataset.followUpBound = '1';
        }
    }
    const inviteToggle = document.getElementById('allow-offline-invite-toggle');
    if (inviteToggle) {

        // 默认为 true (开启)，或者读取用户的设置
        inviteToggle.checked = char.allowOfflineInvite ?? true;
    }
     const momentsContextDisplay = document.getElementById('current-moments-context-display');
    if (momentsContextDisplay) {
        // 读取 char.momentsContextLimit，如果没有就默认为 0
        const limit = char.momentsContextLimit || 0;
        if (limit === 0) {
            momentsContextDisplay.textContent = '已关闭';
            momentsContextDisplay.style.color = 'var(--c-text-tertiary)'; // 灰色
        } else {
            momentsContextDisplay.textContent = `${limit} 条`;
            momentsContextDisplay.style.color = 'var(--c-text-primary)'; // 黑色
        }
    }
    const forumLinkDisplay = document.getElementById('current-forum-link-context-display');
    if (forumLinkDisplay) {
        forumLinkDisplay.textContent = '检测中';
        forumLinkDisplay.style.color = 'var(--c-text-tertiary)';
        updateForumLinkDisplay(char).catch(() => {
            forumLinkDisplay.textContent = '不可用';
        });
    }
    const mountWbStatus = document.getElementById('mount-wb-status');
    if (mountWbStatus) {
        // ▼▼▼ 从这里开始修改：异步校验真实存在的世界书并统计 ▼▼▼
        getAllWorldBooksGrouped().then(groupedData => {
            let validCount = 0;
            if (char.mountedWBIds && char.mountedWBIds.length > 0) {
                const validIds = new Set();
                for (const groupName in groupedData) {
                    groupedData[groupName].forEach(entry => validIds.add(entry.id));
                }
                // 过滤出数据库中真正还存在的世界书数量
                validCount = char.mountedWBIds.filter(id => validIds.has(id)).length;
            }
            if (validCount > 0) {
                mountWbStatus.textContent = `已挂载 ${validCount} 条`;
                mountWbStatus.classList.remove('subtle-text');
            } else {
                mountWbStatus.textContent = '未配置';
                mountWbStatus.classList.add('subtle-text');
            }
        }).catch(err => console.error("统计世界书出错:", err));
        updateQuickBeautifyText();
    }
    // ▼▼▼ 新增：初始化拉黑按钮文字 ▼▼▼
    const blockText = document.getElementById('chat-settings-block-text');
    if (blockText) {
        blockText.textContent = char.isBlocked ? '取消拉黑' : '拉黑此联系人';
    }
        const blockReactionTimeInput = document.getElementById('block-reaction-time-input');
    if (blockReactionTimeInput) {
        blockReactionTimeInput.value = char.blockReactionTime || '';
    }
    // ▲▲▲ 新增结束 ▲▲▲
}

/**
 * 切换身份时，更新该聊天中所有用户发送消息的头像

 * @param {string} chatId - 聊天ID
 * @param {string} newAvatarSrc - 新的头像URL
 */
async function updateUserChatAvatars(chatId, newAvatarSrc) {
    try {
        const messagesToUpdate = await db.chatMessages.where('chatId').equals(chatId).filter(msg => msg.type === 'sent').toArray();
        if (messagesToUpdate.length === 0) return;
        const updatedMessages = messagesToUpdate.map(msg => {
            msg.avatarSrc = newAvatarSrc;
            return msg;
        });
        await db.chatMessages.bulkPut(updatedMessages);
        await loadAndRenderChatHistory(chatId);
    } catch (error) {
        console.error("更新用户历史头像失败:", error);
    }
}

/**
 * 【优化版V2】设置聊天身份切换的弹窗逻辑
 * 特性：精致UI适配，解决卡顿，数据实时刷新
 */
function setupChatIdentitySwitcher() {
    const modalOverlay = document.getElementById('chat-identity-switcher-overlay');
    const container = document.getElementById('chat-identity-list'); 
    const triggerBtn = document.getElementById('chat-settings-user-identity');
    const confirmBtn = document.getElementById('identity-switcher-confirm-btn');
    const cancelBtn = document.getElementById('identity-switcher-cancel-btn');
 if (cancelBtn) cancelBtn.style.display = 'none';
    if (!modalOverlay || !container || !triggerBtn) return;

    let selectedIdentityId = null; 

    // 这个函数每次点击弹窗按钮时都会运行，保证数据是最新的
    const populateModal = () => {
        container.innerHTML = '';
        
        // 1. 获取当前聊天真正在用的身份ID (确保添加新身份后，这里默认选中的还是旧的，逻辑正确)
        const currentActive = getCurrentChatIdentity();
        
        // 如果之前没有临时选择，就默认选中当前生效的
        selectedIdentityId = currentActive.id; 

        const fragment = document.createDocumentFragment();
        
        // 2. 遍历最新的全局身份列表 (AppState.userIdentities 是实时更新的)
        AppState.userIdentities.forEach(identity => {
            const card = document.createElement('div');
            // 判断选中状态
            const isSelected = identity.id === selectedIdentityId;
            card.className = isSelected ? 'identity-card-item selected' : 'identity-card-item';
            card.dataset.id = identity.id;

             card.innerHTML = `
                <div class="id-header">
                    <img class="id-avatar" src="${isValidAvatarSrc(identity.avatar) ? identity.avatar : DEFAULT_AVATAR_SRC}">
                </div>
                <div class="id-details">
                    <div class="id-title-group">
                        <div class="id-label"><svg viewBox="0 0 1024 1024"><path d="M448 448V128h128v320h320v128H576v320H448V576H128V448h320z" fill="currentColor"></path></svg>IDENTITY</div>
                        <div class="id-name">${escapeHTML(identity.name)}</div>
                    </div>
                    <div class="id-subtitle">Start a new life right here.</div>
                    <div class="id-barcode">
                        <span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span>
                    </div>
                </div>
            `;

            // 点击切换选中态 (纯视觉操作，不写库)
            card.addEventListener('click', () => {
                const allCards = container.querySelectorAll('.identity-card-item');
                allCards.forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                selectedIdentityId = identity.id;
            });

            fragment.appendChild(card);
        });
        
        // 3. 如果没有任何身份(极少见)，显示空提示
        if (AppState.userIdentities.length === 0) {
            container.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: #999; padding: 20px;">暂无身份，请去“设置-用户设置”添加</div>`;
        } else {
            container.appendChild(fragment);
        }
    };

    const showModal = () => { 
       document.querySelector('#chat-identity-switcher-overlay h3').textContent = 'SELECT YOUR ID';
        populateModal(); // 每次打开都重新生成，确保“新添加的身份”能显示出来
        modalOverlay.classList.add('visible'); 
    };
    const hideModal = () => { modalOverlay.classList.remove('visible'); };

    // 绑定事件
    triggerBtn.addEventListener('click', showModal);
    
    // 取消操作
    cancelBtn?.addEventListener('click', hideModal);
    modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) hideModal(); });

    // 确定操作 (核心优化：先关弹窗，后处理数据)
    confirmBtn?.addEventListener('click', async () => {
        if (!selectedIdentityId) { hideModal(); return; }

        const currentActive = getCurrentChatIdentity();
        // 如果没改动，直接关闭
        if (selectedIdentityId === currentActive.id) {
            hideModal();
            return;
        }

        const newIdentity = AppState.userIdentities.find(id => id.id === selectedIdentityId);
        if (!newIdentity) return;

        // 1. UI 立即反馈：关闭弹窗
        hideModal();
        
        // 2. 顶部提示用户
        showDynamicIsland(`正在切换为 ${newIdentity.name}...`, 'loading');

        try {
            const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            if (char) {
                // 3. 写入配置
                char.chatIdentityId = selectedIdentityId;
                await optimizedSaveAndRender(); 
                
                // 4. 后台更新历史消息头像 (这是最耗时的步骤)
                await updateUserChatAvatars(tempState.currentChatId, newIdentity.avatar);
                
                // 5. 刷新界面
                renderChatSettingsPage();
                showDynamicIsland(`身份已切换为 ${newIdentity.name}`, 'success');
             await purifyShortTermContext(tempState.currentChatId, `用户身份已从 '${currentActive.name}' 切换为 '${newIdentity.name}'`);
                
            }
        } catch (e) {
            console.error(e);
            showDynamicIsland('切换失败', {
                variant: 'error',
                detail: e?.message || '切换过程中发生错误',
                copyText: e?.stack || e?.message || '切换失败'
            });
        }
    });
}

/**
 * 设置聊天专属表情包选择的弹窗逻辑
 */
// ▼▼▼ 替换/修改这部分代码 (性能极致优化版) ▼▼▼
function setupChatStickerSelector() {
    const modalOverlay = document.getElementById('chat-sticker-selector-overlay');
    const modalList = document.getElementById('chat-sticker-list');
    const stickerSettingsBtn = document.getElementById('chat-settings-sticker-packs');
    const gcStickerSettingsBtn = document.getElementById('gc-sticker-packs');
    if (!modalOverlay || !modalList || (!stickerSettingsBtn && !gcStickerSettingsBtn)) return;

    let currentTarget = 'user'; 
    let cachedStickerPacks = null; // 【优化1】缓存数据库数据，切Tab时拒绝重复查库

    const populateModal = async () => {
        modalList.innerHTML = '';
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (!char) return;
        // 【性能极致优化】如果在主线程里死等数据库拉取几百张图片数据，会让整个屏幕假死！
        // 我们改为：先在屏幕上画出“加载中”，再切到后台去慢慢拉数据。
        if (!cachedStickerPacks) {
            modalList.innerHTML = `<li style="text-align: center; color: #999; padding: 20px; list-style: none;">正在读取表情包数据...</li>`;
            
            // 推迟去执行查库和渲染，这样浏览器就有空闲时间去处理弹窗动画
            setTimeout(async () => {
                cachedStickerPacks = await db.stickerGroups.toArray();
                AppState.stickerGroups = cachedStickerPacks;
                
                // 数据拿到了，重新调用自己，此时有了缓存，就会瞬间渲染列表了
                populateModal(); 
            }, 50);
            return; // 第一次调用在这里提前结束
        }

        if (!cachedStickerPacks || cachedStickerPacks.length === 0) {
            modalList.innerHTML = `<li style="text-align: center; color: var(--c-text-secondary); padding: 20px; list-style: none;">暂无可用表情包，请先在“设置”中添加。</li>`;
            return;
        }
        
        let enabledPacks = [];
        if (currentTarget === 'user') {
            enabledPacks = char.enabledStickerPacks || [];
        } else {
            enabledPacks = char.aiEnabledStickerPacks || char.enabledStickerPacks || [];
        }

        const fragment = document.createDocumentFragment();
        cachedStickerPacks.forEach(pack => {
            const isChecked = enabledPacks.includes(pack.id);
            const previewSrc = (pack.stickers && pack.stickers.length > 0) ? pack.stickers[0].url : DEFAULT_AVATAR_SRC;
            const li = document.createElement('li');
            li.className = 'sticker-selection-item';
            // 【优化2】加入 loading="lazy" 和 decoding="async"，让图片在屏幕外不加载，且解码不阻塞主线程
            li.innerHTML = `<img src="${previewSrc}" loading="lazy" decoding="async" class="sticker-pack-preview" alt="preview"><span class="item-text">${escapeHTML(pack.name)}</span><input type="checkbox" data-id="${pack.id}" ${isChecked ? 'checked' : ''}>`;
            fragment.appendChild(li);
        });
        modalList.appendChild(fragment);
    };
    
    const tabs = modalOverlay.querySelectorAll('.target-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', async (e) => {
            tabs.forEach(t => {
                t.classList.remove('active');
                t.style.background = 'transparent';
                t.style.color = '#888';
                t.style.boxShadow = 'none';
            });
            e.target.classList.add('active');
            e.target.style.background = '#fff';
            e.target.style.color = '#000';
            e.target.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
            currentTarget = e.target.dataset.target;
            await populateModal();
        });
    });

    const showModal = async () => { 
        currentTarget = 'user'; 
        cachedStickerPacks = null; // 每次打开弹窗时清空缓存，保证获取最新添加的表情包
        tabs.forEach(t => {
            t.classList.remove('active');
            t.style.background = 'transparent';
            t.style.color = '#888';
            t.style.boxShadow = 'none';
        });
        const userTab = modalOverlay.querySelector('[data-target="user"]');
        if (userTab) {
            userTab.classList.add('active');
            userTab.style.background = '#fff';
            userTab.style.color = '#000';
            userTab.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
        }
        await populateModal(); 
        modalOverlay.classList.add('visible'); 
    };

    const hideModal = () => {
        modalOverlay.classList.remove('visible');
        cachedStickerPacks = null; // 关弹窗释放内存
    };

    if (stickerSettingsBtn) stickerSettingsBtn.addEventListener('click', showModal);
    if (gcStickerSettingsBtn) gcStickerSettingsBtn.addEventListener('click', showModal);
    modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) hideModal(); });
    
    modalList.addEventListener('change', async (e) => {
        if (e.target.tagName === 'INPUT' && e.target.type === 'checkbox') {
            const packId = e.target.dataset.id;
            const isChecked = e.target.checked;
            const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            if (!char) return;
            
            if (currentTarget === 'user') {
                if (!Array.isArray(char.enabledStickerPacks)) char.enabledStickerPacks = [];
                if (isChecked) {
                    if (!char.enabledStickerPacks.includes(packId)) char.enabledStickerPacks.push(packId);
                } else {
                    char.enabledStickerPacks = char.enabledStickerPacks.filter(id => id !== packId);
                }
            } else {
                if (!Array.isArray(char.aiEnabledStickerPacks)) char.aiEnabledStickerPacks = char.enabledStickerPacks ? [...char.enabledStickerPacks] : [];
                if (isChecked) {
                    if (!char.aiEnabledStickerPacks.includes(packId)) char.aiEnabledStickerPacks.push(packId);
                } else {
                    char.aiEnabledStickerPacks = char.aiEnabledStickerPacks.filter(id => id !== packId);
                }
            }
            
            // 【优化3】静默更新数据库！绝对不调用 optimizedSaveAndRender() 引发全局页面重绘，消除勾选卡顿！
             await db.characterProfiles.update(char.id, {
                 enabledStickerPacks: char.enabledStickerPacks,
                 aiEnabledStickerPacks: char.aiEnabledStickerPacks
             });
             window.__invalidateChatStickerMatchCache?.();
         }
     });
}

function setupRingtoneSettings() {
    const triggerBtn = document.getElementById('chat-settings-ringtone-btn');
    const overlay = document.getElementById('ringtone-settings-overlay');
    if (!triggerBtn || !overlay) return;

    const defaultOption = document.getElementById('default-ringtone-option');
    const customOption = document.getElementById('custom-ringtone-option');
    const fileInput = document.getElementById('ringtone-file-input');
    if (fileInput) {
        fileInput.accept = "audio/*, audio/mpeg, .mp3, .wav, .m4a, .flac";
    }
    const previewBtn = document.getElementById('ringtone-preview-btn');
    const currentRingtoneNameEl = document.getElementById('current-ringtone-name');
    const urlOption = document.getElementById('url-ringtone-option');
    const urlOverlay = document.getElementById('ringtone-url-modal-overlay');
    const urlInput = document.getElementById('ringtone-url-input');
    const confirmUrlBtn = document.getElementById('confirm-ringtone-url-btn');
    const cancelUrlBtn = document.getElementById('cancel-ringtone-url-btn');

    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = () => resolve(reader.result);
            reader.onerror = error => reject(error);
        });
    }

    const updateModalUI = (char) => {
        const src = char.ringtoneSrc || 'assets/ringtone.mp3';
        const isDefault = src === 'assets/ringtone.mp3';
        const isFile = src.startsWith('blob:') || src.startsWith('data:audio/');
        const isUrl = !isDefault && !isFile;

        defaultOption.classList.toggle('selected', isDefault);
        customOption.classList.toggle('selected', isFile);
        urlOption.classList.toggle('selected', isUrl);

        currentRingtoneNameEl.textContent = isDefault ? '默认铃声' : '自定义铃声';
    };

    const playPreview = (src) => {
        if (previewAudio) {
            previewAudio.pause();
        }
        previewAudio = new Audio(src);
        previewAudio.play().catch(e => console.error("音频播放失败:", e));
    };

    const saveRingtone = async (src) => {
        const charId = tempState.currentChatId;
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (!char) return;

        if (char.ringtoneSrc && char.ringtoneSrc.startsWith('blob:')) {
            URL.revokeObjectURL(char.ringtoneSrc);
        }

        char.ringtoneSrc = src;
        await db.characterProfiles.put(char);
        
        updateModalUI(char);
        const ringtoneDisplayName = document.getElementById('current-ringtone-display-name');
        if (ringtoneDisplayName) {
            ringtoneDisplayName.textContent = src !== 'assets/ringtone.mp3' ? '自定义' : '默认';
        }
        playPreview(src);
    };

    const showModal = () => {
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (char) {
            updateModalUI(char);
            overlay.classList.add('visible');
        }
    };

    const hideModal = () => {
        overlay.classList.remove('visible');
        if (previewAudio) {
            previewAudio.pause();
            previewAudio = null;
        }
        fileInput.value = '';
    };

    const showUrlModal = () => urlOverlay.classList.add('visible');
    const hideUrlModal = () => {
        urlInput.value = '';
        urlOverlay.classList.remove('visible');
    };

    triggerBtn.addEventListener('click', showModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) hideModal();
    });

    defaultOption.addEventListener('click', () => {
        saveRingtone('assets/ringtone.mp3');
    });

    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file && file.type.startsWith('audio/')) {
            try {
                const base64String = await fileToBase64(file);
                saveRingtone(base64String);
            } catch (error) {
                console.error('文件转 Base64 失败:', error);
                showDynamicIsland('读取音频文件失败', {
                    variant: 'error',
                    detail: error?.message || '音频文件读取失败',
                    copyText: error?.stack || error?.message || '读取音频文件失败'
                });
            }
        } else if (file) {
            showDynamicIsland('请选择有效的音频文件');
        }
    });
    
    urlOption.addEventListener('click', showUrlModal);
    cancelUrlBtn.addEventListener('click', hideUrlModal);
    urlOverlay.addEventListener('click', (e) => {
      if (e.target === urlOverlay) hideUrlModal();
    });
    confirmUrlBtn.addEventListener('click', () => {
        const url = urlInput.value.trim();
        if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
            saveRingtone(url);
            hideUrlModal();
        } else {
            showDynamicIsland('请输入有效的URL链接');
        }
    });

    previewBtn.addEventListener('click', () => {
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (char) {
            playPreview(char.ringtoneSrc || 'assets/ringtone.mp3');
        }
    });
}

// ▼▼▼ 【新增功能】 消息通知设置 ▼▼▼
function setupNotificationSettings() {
    const triggerBtn = document.getElementById('chat-settings-notification-btn');
    const overlay = document.getElementById('notification-settings-overlay');
    if (!triggerBtn || !overlay) return;
    const closeBtn = document.getElementById('notification-settings-close-btn');

    if (!document.getElementById('notification-modal-scroll-style')) {
        const style = document.createElement('style');
        style.id = 'notification-modal-scroll-style';
        style.textContent = `
#notification-modal-card {
  height: calc(100dvh - 80px) !important;
  max-height: 760px !important;
  overflow: hidden !important;
}
#notification-modal-card .notification-modal-scroll {
  flex: 1 1 auto !important;
  min-height: 0 !important;
  max-height: calc(100dvh - 156px) !important;
  overflow-y: auto !important;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
  padding-right: 2px;
}
#notification-modal-card .notification-mode-options {
  display: flex !important;
  flex-direction: column !important;
  gap: 0 !important;
}
#notification-modal-card .notification-settings-section {
  overflow: visible !important;
}
#notification-modal-card #notification-sound-section {
  max-height: none !important;
}
#notification-modal-card #notification-sound-section.disabled {
  max-height: 0 !important;
  overflow: hidden !important;
}
`;
        document.head.appendChild(style);
    }

    const toggle = document.getElementById('notification-toggle');
    const soundSection = document.getElementById('notification-sound-section');
    const defaultOption = document.getElementById('default-notification-option');
    const customOption = document.getElementById('custom-notification-option');
    const urlOption = document.getElementById('url-notification-option');
    const fileInput = document.getElementById('notification-file-input');
    const previewBtn = document.getElementById('notification-preview-btn');
    const currentSoundNameEl = document.getElementById('current-notification-sound-name');
    const soundModeEveryOption = document.getElementById('notification-mode-every');
    const soundModeBatchOption = document.getElementById('notification-mode-batch');

    const sendSoundToggle = document.getElementById('send-sound-toggle');
    const sendSoundSection = document.getElementById('send-sound-section');
    const defaultSendSoundOption = document.getElementById('default-send-sound-option');
    const customSendSoundOption = document.getElementById('custom-send-sound-option');
    const urlSendSoundOption = document.getElementById('url-send-sound-option');
    const sendSoundFileInput = document.getElementById('send-sound-file-input');
    const sendSoundPreviewBtn = document.getElementById('send-sound-preview-btn');
    const currentSendSoundNameEl = document.getElementById('current-send-sound-name');

    const urlOverlay = document.getElementById('notification-url-modal-overlay');
    const urlInput = document.getElementById('notification-url-input');
    const confirmUrlBtn = document.getElementById('confirm-notification-url-btn');
    const cancelUrlBtn = document.getElementById('cancel-notification-url-btn');
    const sendSoundUrlOverlay = document.getElementById('send-sound-url-modal-overlay');
    const sendSoundUrlInput = document.getElementById('send-sound-url-input');
    const confirmSendSoundUrlBtn = document.getElementById('confirm-send-sound-url-btn');
    const cancelSendSoundUrlBtn = document.getElementById('cancel-send-sound-url-btn');

    if (fileInput) fileInput.accept = 'audio/*, audio/mpeg, .mp3, .wav, .m4a, .flac';
    if (sendSoundFileInput) sendSoundFileInput.accept = 'audio/*, audio/mpeg, .mp3, .wav, .m4a, .flac';

    let previewAudio = null;

    const fileToBase64 = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
    });

    const playPreview = (src) => {
        if (!src) return;
        if (previewAudio) previewAudio.pause();
        previewAudio = new Audio(src);
        previewAudio.play().catch(error => console.error('audio play failed:', error));
    };

    const getSoundName = (src, defaultSrc) => {
        if (src === defaultSrc) return '默认';
        if (src?.startsWith('data:audio/')) return '本地文件';
        return '网络链接';
    };

    const updateModalUI = (char) => {
        const notificationsEnabled = char.notificationsEnabled !== false;
        if (toggle) toggle.checked = notificationsEnabled;
        soundSection?.classList.toggle('disabled', !notificationsEnabled);

        const notificationSrc = char.notificationSoundSrc || DEFAULT_NOTIFICATION_SRC;
        const notificationIsDefault = notificationSrc === DEFAULT_NOTIFICATION_SRC;
        const notificationIsFile = notificationSrc.startsWith('data:audio/');
        const notificationIsUrl = !notificationIsDefault && !notificationIsFile && !notificationSrc.startsWith('blob:');
        defaultOption?.classList.toggle('selected', notificationIsDefault);
        customOption?.classList.toggle('selected', notificationIsFile);
        urlOption?.classList.toggle('selected', notificationIsUrl);
        if (currentSoundNameEl) currentSoundNameEl.textContent = getSoundName(notificationSrc, DEFAULT_NOTIFICATION_SRC);

        const mode = char.notificationSoundMode === 'batch' ? 'batch' : 'every';
        soundModeEveryOption?.classList.toggle('selected', mode === 'every');
        soundModeBatchOption?.classList.toggle('selected', mode === 'batch');

        const sendEnabled = char.sendSoundEnabled !== false;
        if (sendSoundToggle) sendSoundToggle.checked = sendEnabled;
        sendSoundSection?.classList.toggle('disabled', !sendEnabled);

        const sendSrc = char.sendSoundSrc || DEFAULT_SEND_SOUND_SRC;
        const sendIsDefault = sendSrc === DEFAULT_SEND_SOUND_SRC;
        const sendIsFile = sendSrc.startsWith('data:audio/');
        const sendIsUrl = !sendIsDefault && !sendIsFile && !sendSrc.startsWith('blob:');
        defaultSendSoundOption?.classList.toggle('selected', sendIsDefault);
        customSendSoundOption?.classList.toggle('selected', sendIsFile);
        urlSendSoundOption?.classList.toggle('selected', sendIsUrl);
        if (currentSendSoundNameEl) currentSendSoundNameEl.textContent = getSoundName(sendSrc, DEFAULT_SEND_SOUND_SRC);
    };

    const saveSettings = async (settings) => {
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (!char) return;
        Object.assign(char, settings);
        await db.characterProfiles.put(char);
        updateModalUI(char);
    };

    const showModal = () => {
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (!char) return;
        updateModalUI(char);
        overlay.classList.add('visible');
    };

    const hideModal = () => {
        overlay.classList.remove('visible');
        if (previewAudio) {
            previewAudio.pause();
            previewAudio = null;
        }
        if (fileInput) fileInput.value = '';
        if (sendSoundFileInput) sendSoundFileInput.value = '';
    };

    const showUrlModal = () => urlOverlay?.classList.add('visible');
    const hideUrlModal = () => {
        if (urlInput) urlInput.value = '';
        urlOverlay?.classList.remove('visible');
    };
    const showSendSoundUrlModal = () => sendSoundUrlOverlay?.classList.add('visible');
    const hideSendSoundUrlModal = () => {
        if (sendSoundUrlInput) sendSoundUrlInput.value = '';
        sendSoundUrlOverlay?.classList.remove('visible');
    };

    triggerBtn.addEventListener('click', showModal);
    closeBtn?.addEventListener('click', hideModal);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) hideModal();
    });

    toggle?.addEventListener('change', () => saveSettings({ notificationsEnabled: toggle.checked }));
    soundModeEveryOption?.addEventListener('click', () => saveSettings({ notificationSoundMode: 'every' }));
    soundModeBatchOption?.addEventListener('click', () => saveSettings({ notificationSoundMode: 'batch' }));

    defaultOption?.addEventListener('click', () => {
        saveSettings({ notificationSoundSrc: DEFAULT_NOTIFICATION_SRC });
        playPreview(DEFAULT_NOTIFICATION_SRC);
    });
    fileInput?.addEventListener('change', async event => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!file.type.startsWith('audio/')) {
            showDynamicIsland('??????????');
            return;
        }
        try {
            const src = await fileToBase64(file);
            await saveSettings({ notificationSoundSrc: src });
            playPreview(src);
        } catch (error) {
            console.error('?????????:', error);
            showDynamicIsland('????????');
        }
    });

    urlOption?.addEventListener('click', showUrlModal);
    cancelUrlBtn?.addEventListener('click', hideUrlModal);
    urlOverlay?.addEventListener('click', event => {
        if (event.target === urlOverlay) hideUrlModal();
    });
    confirmUrlBtn?.addEventListener('click', () => {
        const url = urlInput?.value.trim() || '';
        if (!/^https?:\/\//i.test(url)) {
            showDynamicIsland('??????URL??');
            return;
        }
        saveSettings({ notificationSoundSrc: url });
        playPreview(url);
        hideUrlModal();
    });

    previewBtn?.addEventListener('click', () => {
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (char) playPreview(char.notificationSoundSrc || DEFAULT_NOTIFICATION_SRC);
    });

    sendSoundToggle?.addEventListener('change', () => saveSettings({ sendSoundEnabled: sendSoundToggle.checked }));
    defaultSendSoundOption?.addEventListener('click', () => {
        saveSettings({ sendSoundSrc: DEFAULT_SEND_SOUND_SRC });
        playPreview(DEFAULT_SEND_SOUND_SRC);
    });
    sendSoundFileInput?.addEventListener('change', async event => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!file.type.startsWith('audio/')) {
            showDynamicIsland('??????????');
            return;
        }
        try {
            const src = await fileToBase64(file);
            await saveSettings({ sendSoundSrc: src });
            playPreview(src);
        } catch (error) {
            console.error('?????????:', error);
            showDynamicIsland('????????');
        }
    });

    urlSendSoundOption?.addEventListener('click', showSendSoundUrlModal);
    cancelSendSoundUrlBtn?.addEventListener('click', hideSendSoundUrlModal);
    sendSoundUrlOverlay?.addEventListener('click', event => {
        if (event.target === sendSoundUrlOverlay) hideSendSoundUrlModal();
    });
    confirmSendSoundUrlBtn?.addEventListener('click', () => {
        const url = sendSoundUrlInput?.value.trim() || '';
        if (!/^https?:\/\//i.test(url)) {
            showDynamicIsland('??????URL??');
            return;
        }
        saveSettings({ sendSoundSrc: url });
        playPreview(url);
        hideSendSoundUrlModal();
    });
    sendSoundPreviewBtn?.addEventListener('click', () => {
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (char) playPreview(char.sendSoundSrc || DEFAULT_SEND_SOUND_SRC);
    });
}
// ▲▲▲ 【新增功能】 结束 ▲▲▲

/**
 * 显示转账详情页
 * @param {number} messageId - 转账消息的ID
 */
async function showTransferDetailPage(messageId) {
    const message = await db.chatMessages.get(messageId);
    if (!message || !message.transferInfo || message.transferInfo.status !== 'pending') return;
    activeTransferMessageId = messageId;
    
    document.getElementById('transfer-detail-icon-container').innerHTML = `<svg viewBox="0 0 1024 1024" class="transfer-status-icon pending"><path d="M512 85.333333a426.666667 426.666667 0 1 0 426.666667 426.666667A426.666667 426.666667 0 0 0 512 85.333333z m0 768a341.333333 341.333333 0 1 1 341.333333-341.333333A341.333333 341.333333 0 0 1 512 853.333333z" fill="#3D82F8"></path><path d="M533.333333 512V298.666667a21.333333 21.333333 0 0 0-42.666666 0V533.333333a21.333333 21.333333 0 0 0 21.333333 21.333334h192a21.333333 21.333333 0 0 0 0-42.666667H533.333333z" fill="#3D82F8"></path></svg>`;
    document.getElementById('transfer-detail-status').textContent = '待你收款';
    document.getElementById('transfer-detail-amount').textContent = `¥${message.transferInfo.amount}`;
    
    const date = new Date(message.timestamp);
    document.getElementById('transfer-detail-time').textContent = `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, '0')}月${String(date.getDate()).padStart(2, '0')}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    const targetList = document.getElementById('transfer-detail-target-list');
    if (targetList) {
        const targets = await getLookyReceiveTargets(message.chatId);
        targetList.innerHTML = targets.map((target, index) => `
            <button type="button" class="transfer-target-option ${index === 0 ? 'active' : ''}" data-value="${escapeHTML(target.value)}">
                <span class="transfer-target-icon">${escapeHTML(target.icon)}</span>
                <span class="transfer-target-text">
                    <strong>${escapeHTML(target.title)}</strong>
                    <small>${escapeHTML(target.desc)}</small>
                </span>
                <span class="transfer-target-check">✓</span>
            </button>
        `).join('');
        targetList.querySelectorAll('.transfer-target-option').forEach(btn => {
            btn.addEventListener('click', () => {
                targetList.querySelectorAll('.transfer-target-option').forEach(item => item.classList.remove('active'));
                btn.classList.add('active');
            });
        });
    }
    
    showPage('page-transfer-detail');
}

/**
 * 响应AI发来的转账（接收或退回）
 * @param {string} action - 'accepted' 或 'rejected'
 */
async function respondToAiTransfer(action) {
    if (!activeTransferMessageId) return;
    await db.chatMessages.update(activeTransferMessageId, { 'transferInfo.status': action });
    showPage('page-chat-detail');
    await loadAndRenderChatHistory(tempState.currentChatId);
    activeTransferMessageId = null;
}

// ▼▼▼ 用下面这个【最终、最准确的】函数，替换掉你原来的 setupMountWorld-Book 函数 ▼▼▼

/**
 * 设置挂载世界书弹窗的逻辑 (最终颜色精准修正版)
 */
async function setupMountWorldBook() {
    // 1. 获取所有需要的元素
    const triggerBtn = document.getElementById('mount-world-book-trigger');
    const overlay = document.getElementById('mount-wb-modal-overlay');
    const listContainer = document.getElementById('mount-wb-list-container');
    const saveBtn = document.getElementById('save-mount-wb-btn');
    const cancelBtn = document.getElementById('cancel-mount-wb-btn');
    const purifyBtn = document.getElementById('purify-context-in-modal-btn');
    const searchInput = document.getElementById('mount-wb-search-input');

    if (!triggerBtn || !overlay || !listContainer || !saveBtn || !cancelBtn || !purifyBtn) return;
    
    // 【核心修正1】删除所有修改 "保存" 按钮样式的代码！让它保持你自己的黑白风格。
    // (这里不再有任何 saveBtn.classList.add/remove 的代码)

    // 【核心修正2】保留对 "刷新" 按钮的强制红色样式，这能无视任何CSS冲突。
    purifyBtn.style.backgroundColor = 'var(--c-accent-red)';
    purifyBtn.style.color = 'white';

    let tempSelectedIds = new Set();
    let tempSelectedCategories = new Set();
    let mountWbSearchTerm = '';

    const populateModal = async (showLoading = true, resetSelection = false) => {
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (!char) return;
        if (resetSelection) {
            tempSelectedIds = new Set(char.mountedWBIds || []);
            tempSelectedCategories = new Set(Array.isArray(char.mountedWBCategories) ? char.mountedWBCategories : []);
        }
        
        // 【性能优化】先给个骨架提示，释放主线程
        if (showLoading) {
            listContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">正在读取世界书档案...</div>';
        }
        
        setTimeout(async () => {
            const groupedData = await getAllWorldBooksGrouped();
            listContainer.innerHTML = '';
            const fragment = document.createDocumentFragment();
            const importanceOrder = { high: 1, medium: 2, low: 3 };
            const importanceText = { high: '高', medium: '中', low: '低' };
            for (const groupName in groupedData) {
                const lowerGroupName = String(groupName || '').toLowerCase();
                const groupEntries = [...groupedData[groupName]]
                    .filter(entry => {
                        if (!mountWbSearchTerm) return true;
                        return lowerGroupName.includes(mountWbSearchTerm)
                            || [entry.title, entry.category, entry.content].some(value => String(value || '').toLowerCase().includes(mountWbSearchTerm));
                    })
                    .sort((a, b) => {
                        return (importanceOrder[a.importance] || 3) - (importanceOrder[b.importance] || 3);
                    });
                if (groupEntries.length === 0) continue;
                const groupSelected = tempSelectedCategories.has(groupName);
                const section = document.createElement('section');
                section.className = `ca-worldbook-picker-group ${groupSelected ? 'is-selected' : ''}`;
                section.dataset.category = groupName;
                const header = document.createElement('header');
                const groupButton = groupName === '全局世界书'
                    ? ''
                    : `<button type="button" class="mount-wb-group-toggle" data-category="${escapeHTML(groupName)}">${groupSelected ? '已关联整组' : '关联整组'}</button>`;
                header.innerHTML = `<div><strong>${escapeHTML(groupName)}</strong><span>${groupEntries.length} 条 · GROUP</span></div>${groupButton}`;
                const itemsContainer = document.createElement('div');
                itemsContainer.className = 'ca-worldbook-picker-entries';
                
                if (groupName === '全局世界书') {
                    const hint = document.createElement('p');
                    hint.className = 'ca-worldbook-picker-group-empty';
                    hint.textContent = '全局世界书默认已经悬挂上。';
                    itemsContainer.appendChild(hint);
                }

                groupEntries.forEach(entry => {
                    const isChecked = groupSelected || tempSelectedIds.has(entry.id);
                    const article = document.createElement('article');
                    article.className = `ca-worldbook-picker-entry ${isChecked ? 'is-selected' : ''}`;
                    
                    if (groupName === '全局世界书') {
                        article.innerHTML = `<div><strong>${escapeHTML(entry.title)}</strong><p>${escapeHTML(importanceText[entry.importance] || '低')}</p></div>`;
                    } else {
                        article.innerHTML = `
                            <label style="display:flex; align-items:center; gap:8px; min-width:0; width:100%; cursor:pointer;">
                                <input type="checkbox" data-id="${entry.id}" ${isChecked ? 'checked' : ''} ${groupSelected ? 'disabled' : ''}>
                                <span style="min-width:0;">
                                    <strong>${escapeHTML(entry.title)}</strong>
                                    <p>${escapeHTML(importanceText[entry.importance] || '低')}</p>
                                </span>
                            </label>
                        `;
                        if (groupSelected) article.style.opacity = '0.72';
                    }
                    itemsContainer.appendChild(article);
                });
                section.appendChild(header);
                section.appendChild(itemsContainer);
                fragment.appendChild(section);
            }
            if (!fragment.childNodes.length) {
                listContainer.innerHTML = '<p class="ca-worldbook-picker-empty">没有找到世界书。</p>';
                return;
            }
            listContainer.appendChild(fragment);
        }, 50); // 错开 50ms 执行，彻底根除卡顿
    };

    const syncGroupMountStateInPlace = (category) => {
        const section = Array.from(listContainer.querySelectorAll('.ca-worldbook-picker-group'))
            .find(item => item.dataset.category === category);
        if (!section) return false;
        const groupSelected = tempSelectedCategories.has(category);
        section.classList.toggle('is-selected', groupSelected);
        const groupBtn = section.querySelector('.mount-wb-group-toggle');
        if (groupBtn) groupBtn.textContent = groupSelected ? '已关联整组' : '关联整组';
        section.querySelectorAll('input[type="checkbox"][data-id]').forEach(input => {
            const entryId = parseInt(input.dataset.id, 10);
            const checked = groupSelected || tempSelectedIds.has(entryId);
            input.checked = checked;
            input.disabled = groupSelected;
            const entryEl = input.closest('.ca-worldbook-picker-entry');
            if (entryEl) {
                entryEl.classList.toggle('is-selected', checked);
                entryEl.style.opacity = groupSelected ? '0.72' : '';
            }
        });
        return true;
    };

    // 显示弹窗的函数
    const showModal = async () => {
        purifyBtn.style.display = 'none';
        mountWbSearchTerm = '';
        if (searchInput) searchInput.value = '';
        await populateModal(true, true);
        overlay.classList.add('visible');
    };

    // 关闭弹窗的函数
    const hideModal = () => {
        overlay.classList.remove('visible');
        purifyBtn.style.display = 'none';
    };

    // --- 事件绑定 (保持不变) ---
    triggerBtn.addEventListener('click', showModal);
    cancelBtn.addEventListener('click', hideModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) hideModal();
    });

    searchInput?.addEventListener('input', (event) => {
        clearTimeout(event.target._mountWbSearchTimer);
        event.target._mountWbSearchTimer = setTimeout(() => {
            mountWbSearchTerm = String(event.target.value || '').trim().toLowerCase();
            populateModal(false).catch(error => console.warn('[ChatSettings] mount world book search failed:', error));
        }, 180);
    });

    listContainer.addEventListener('change', (e) => {
        if (e.target.tagName === 'INPUT' && e.target.type === 'checkbox') {
            if (e.target.disabled) return;
            const entryId = parseInt(e.target.dataset.id, 10);
            if (e.target.checked) {
                tempSelectedIds.add(entryId);
            } else {
                tempSelectedIds.delete(entryId);
            }
            const entryEl = e.target.closest('.ca-worldbook-picker-entry');
            if (entryEl) entryEl.classList.toggle('is-selected', e.target.checked);
        }
    });

    listContainer.addEventListener('click', async (e) => {
        const groupBtn = e.target.closest('.mount-wb-group-toggle');
        if (!groupBtn) return;
        e.preventDefault();
        e.stopPropagation();
        const category = groupBtn.dataset.category || '';
        if (!category) return;
        if (tempSelectedCategories.has(category)) {
            tempSelectedCategories.delete(category);
        } else {
            tempSelectedCategories.add(category);
        }
        if (!syncGroupMountStateInPlace(category)) {
            await populateModal(false);
        }
    });

    // 当点击"保存"按钮时
    saveBtn.addEventListener('click', async () => {
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (!char) return;
        char.mountedWBIds = Array.from(tempSelectedIds);
        char.mountedWBCategories = Array.from(tempSelectedCategories);
        await optimizedSaveAndRender();
        renderChatSettingsPage();
        showDynamicIsland('世界书配置已保存');
        
        purifyBtn.style.display = 'block'; 
    });

    // 当点击“刷新上下文”按钮时
    purifyBtn.addEventListener('click', async () => {
        const charId = tempState.currentChatId;
        if (charId) {
            purifyBtn.disabled = true;
            purifyBtn.textContent = '刷新中...';
            // 【UI优化】禁用时颜色变浅，反馈更清晰
            purifyBtn.style.backgroundColor = 'lightcoral'; 

            await purifyShortTermContext(charId, '用户在设置中更新了世界书设定');
            
            purifyBtn.disabled = false;
            purifyBtn.textContent = '刷新上下文';
            // 恢复为醒目的红色
            purifyBtn.style.backgroundColor = 'var(--c-accent-red)'; 
            hideModal();
        }
    });
}
/**
 * 【新增】设置删除聊天记录弹窗的逻辑
 */
function setupDeleteHistoryModal() {
    // --- 1. 获取所有元素 ---
    const triggerBtn = document.getElementById('chat-settings-delete-history-btn');
    const modalOverlay = document.getElementById('delete-history-modal-overlay');
    if (!triggerBtn || !modalOverlay) return;

    const optionItems = modalOverlay.querySelectorAll('.delete-option-item');
    const cancelBtn = document.getElementById('delete-history-cancel-btn');
    const cancelBtnX = document.getElementById('delete-history-cancel-btn-x');

    // --- 2. 弹窗控制 ---
    const showModal = () => modalOverlay.classList.add('visible');
    const hideModal = () => modalOverlay.classList.remove('visible');

    // --- 3. 核心删除逻辑 ---
    const handleDelete = async (action) => {
        const charId = tempState.currentChatId;
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (!char) return;
        // 预先准备二次确认的文本
        const confirmationMessages = {
            all: `确定要删除与 "${escapeHTML(char.name)}" 的【所有相关数据】吗？\n包括对话、记忆和动态，此操作不可逆！`,
            dialogue: `确定要【仅删除】与 "${escapeHTML(char.name)}" 的所有对话记录吗？`,
            memory: `确定要【仅删除】与 "${escapeHTML(char.name)}" 的所有核心记忆吗？`,
            moments: `确定要【仅删除】由 "${escapeHTML(char.name)}" 发布的所有动态吗？`,
            // ▼▼▼ 在这行下面加上短信的文案，别忘了上面一行末尾要有逗号 ▼▼▼
            sms: `确定要【仅删除】与 "${escapeHTML(char.name)}" 的所有短信记录吗？`
        };

        if (!confirm(confirmationMessages[action])) {
            return; // 用户取消
        }
        hideModal(); // 先关闭弹窗再执行耗时操作
        showDynamicIsland('正在删除...', 'loading');

        try {
             // 删除对话 (线上+线下)
            if (action === 'all' || action === 'dialogue') {
                await db.chatMessages.where('chatId').equals(charId).delete();
                await db.offlineMessages.where('chatId').equals(charId).delete();
                await db.offlineSessions.where({ chatId: charId }).delete(); // ◀◀◀ 加上这行，彻底根除幽灵卡片
                await clearFriendRequestDataForCharacters(charId);
            }
            // 删除记忆 (数据库+角色档案)
            if (action === 'all' || action === 'memory') {
                clearMemoryRuntimeCaches(charId);
                await db.importantMemories.where({ charId }).delete();
                if (char.memoryProfile) {
                    char.memoryProfile = null; // 或者重置为默认值
                    await optimizedSaveAndRender();
                }
            }
             // 删除动态
            if (action === 'all' || action === 'moments') {
                const momentsToDelete = await db.moments.where('characterId').equals(charId).toArray();
                if (momentsToDelete.length > 0) {
                    const idsToDelete = momentsToDelete.map(m => m.id);
                    await db.moments.bulkDelete(idsToDelete);
                    // 如果在动态页，需要触发刷新
                    if (document.getElementById('page-dynamics').classList.contains('visible')) {
                         momentsModule.renderMoments();
                   }
                }
            }

            // ▼▼▼ 在这里新增：删除短信 (数据库+UI清空) ▼▼▼
            if (action === 'all' || action === 'sms') {
                await db.smsMessages.where({ chatId: charId }).delete();
                // 如果恰好正在查看短信，顺手把屏幕清空
                const smsContent = document.getElementById('sms-chat-content');
                if (smsContent && tempState.currentSmsCharId === charId) {
                    smsContent.innerHTML = '';
                }
            }
            // ▲▲▲ 新增结束 ▲▲▲

            // --- 💡 核心：彻底清空当前角色的所有状态（包含线下模式） ---
            if (action === 'all') {
                // 1. 重置该角色的记忆总结轮数
                char.turnCounter = 0; 
                await optimizedSaveAndRender();

                // 2. 精确删除该角色在内存中的混合/统计计数
                if (tempState.hybridModeTurnCounters) delete tempState.hybridModeTurnCounters[charId];
                if (tempState.activeRides) delete tempState.activeRides[charId];
                if (tempState.activeFlights) delete tempState.activeFlights[charId];
                if (tempState.activeTrains) delete tempState.activeTrains[charId];
                if (tempState.activeGifts) delete tempState.activeGifts[charId];

                // 3. 【新增】清空线下模式 (offline-mode.js) 的运行状态
                // 如果当前正好是这个角色在约会，立刻结束它
                if (tempState.activeOfflineSession === charId) {
                    tempState.isDateActive = false;
                    tempState.activeOfflineSession = null;
                    tempState.currentOfflineSessionId = null;
                }

                // 4. 【新增】从硬盘中永久抹除线下会话和场景预设
                localStorage.removeItem(`offline_session_active_${charId}`); // 抹除未结束的会话ID
                localStorage.removeItem(`offline_active_ids_${charId}`);     // 抹除选中的自定义预设ID
                localStorage.removeItem(`offline_active_content_${charId}`); // 抹除生成的场景内容

                // 5. 同步所有行程统计到手机硬盘
                localStorage.setItem('active_rides_state', JSON.stringify(tempState.activeRides || {}));
                localStorage.setItem('active_flights_state', JSON.stringify(tempState.activeFlights || {}));
                localStorage.setItem('active_trains_state', JSON.stringify(tempState.activeTrains || {}));
                localStorage.setItem('active_gifts_state', JSON.stringify(tempState.activeGifts || {}));
                
            }

            // 当前正打开这个角色时，同步清空内存缓存并立即重绘，避免退出再进入才更新。
            const isCurrentChat = String(tempState.currentChatId) === String(charId);
            if ((action === 'all' || action === 'dialogue') && isCurrentChat) {
                // Map 的键有可能来自数据库数字 ID，也可能来自消息对象字符串 ID，统一按字符串比对清理。
                [chatState.pendingMessageQueue, chatState.unrenderedMessages].forEach(cache => {
                    Array.from(cache.keys()).forEach(cacheChatId => {
                        if (String(cacheChatId) === String(charId)) cache.delete(cacheChatId);
                    });
                });
                AppState.currentChatHistory = [];
                const chatMessageList = document.getElementById('chat-message-list');
                if (chatMessageList) chatMessageList.innerHTML = '';
                await loadAndRenderChatHistory(charId, true);
            }

            showDynamicIsland('数据已成功删除', 'success');
        } catch (error) {
            console.error(`删除操作 [${action}] 失败:`, error);
            showDynamicIsland('删除失败，请稍后重试', {
                variant: 'error',
                detail: error?.message || '删除过程中发生错误',
                copyText: error?.stack || error?.message || '删除失败'
            });
        }
    };

    // --- 4. 绑定事件 ---
    triggerBtn.addEventListener('click', showModal);
    
    // 关闭按钮
    cancelBtn.addEventListener('click', hideModal);
    cancelBtnX.addEventListener('click', hideModal);
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) hideModal();
    });

    // 选项按钮
    optionItems.forEach(item => {
        item.addEventListener('click', () => {
            const action = item.dataset.action;
            if (action) {
                handleDelete(action);
            }
        });
    });
}


function setupCallSettings() {
    const triggerBtn = document.getElementById('chat-settings-call-btn');
    const overlay = document.getElementById('call-settings-overlay');
    const quickOverlay = document.getElementById('call-quick-settings-overlay');
    if (!triggerBtn || !overlay || !quickOverlay) return;

    const closeBtn = document.getElementById('call-settings-close-btn');
    const quickCloseBtn = document.getElementById('call-quick-settings-close-btn');
    const ambientToggle = document.getElementById('call-ambient-enabled-toggle');
    const ambientNoneOption = document.getElementById('call-ambient-none-option');
    const ambientCityOption = document.getElementById('call-ambient-city-option');
    const ambientRainOption = document.getElementById('call-ambient-rain-option');
    const ambientFileOption = document.getElementById('call-ambient-file-option');
    const ambientUrlOption = document.getElementById('call-ambient-url-option');
    const ambientFileInput = document.getElementById('call-ambient-file-input');
    const ambientUrlInput = document.getElementById('call-ambient-url-input');
    const ambientUrlSaveBtn = document.getElementById('call-ambient-url-save-btn');
    const ambientName = document.getElementById('call-ambient-current-name');
    const ambientPreviewBtn = document.getElementById('call-ambient-preview-btn');
    const ambientSlider = document.getElementById('call-ambient-volume-slider');
    const ambientValue = document.getElementById('call-ambient-volume-value');
    const voiceSlider = document.getElementById('call-voice-volume-slider');
    const voiceValue = document.getElementById('call-voice-volume-value');
    const aiStartToggle = document.getElementById('call-ai-start-toggle');
    const userStartToggle = document.getElementById('call-user-start-toggle');
    const quickAiStartToggle = document.getElementById('call-quick-ai-start-toggle');
    const quickUserStartToggle = document.getElementById('call-quick-user-start-toggle');
    const quickVoiceSlider = document.getElementById('call-quick-voice-volume-slider');
    const quickVoiceValue = document.getElementById('call-quick-voice-volume-value');
    const voiceDescriptionToggle = document.getElementById('call-voice-description-toggle');
    const voiceOnlySettings = document.querySelectorAll('.voice-call-only-setting');
    const videoOnlySettings = document.querySelectorAll('.video-call-only-setting');
    const quickCameraToggle = document.getElementById('call-quick-camera-toggle');
    const quickAmbientToggle = document.getElementById('call-quick-ambient-enabled-toggle');
    const quickAmbientSlider = document.getElementById('call-quick-ambient-volume-slider');
    const quickAmbientValue = document.getElementById('call-quick-ambient-volume-value');
    let quickChatId = null;

    const getCharacter = (chatId = tempState.currentChatId) =>
        AppState.characterProfiles.find(char => String(char.id) === String(chatId));
    const formatPercent = (value) => `${Math.round(Number(value) * 100)}%`;
    const fileToBase64 = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });

    const updateSourceUI = (settings) => {
        const hasSource = Boolean(settings.ambientSrc);
        ambientNoneOption?.classList.toggle('selected', !hasSource);
        ambientCityOption?.classList.toggle('selected', settings.ambientSrc === ambientCityOption?.dataset.audioSrc);
        ambientRainOption?.classList.toggle('selected', settings.ambientSrc === ambientRainOption?.dataset.audioSrc);
        ambientFileOption?.classList.toggle('selected', hasSource && settings.ambientSrc.startsWith('data:audio/'));
        ambientUrlOption?.classList.toggle('selected', hasSource && !settings.ambientSrc.startsWith('data:audio/'));
        if (ambientName) ambientName.textContent = settings.ambientName || (hasSource ? '已添加环境音' : '未选择');
    };

    const updateModalUI = (char) => {
        const settings = normalizeCallSettings(char?.callSettings || DEFAULT_CALL_SETTINGS);
        if (ambientToggle) ambientToggle.checked = settings.ambientEnabled;
        if (ambientSlider) ambientSlider.value = String(Math.round(settings.ambientVolume * 100));
        if (ambientValue) ambientValue.textContent = formatPercent(settings.ambientVolume);
        if (voiceSlider) voiceSlider.value = String(Math.round(settings.voiceVolume * 100));
        if (voiceValue) voiceValue.textContent = formatPercent(settings.voiceVolume);
        if (aiStartToggle) aiStartToggle.checked = settings.aiStarts;
        if (userStartToggle) userStartToggle.checked = settings.userStarts;
        updateSourceUI(settings);
    };

    const updateQuickUI = (chatId, mode = 'voice') => {
        const settings = getCallSettings(chatId);
        const isVoiceCall = mode === 'voice';
        voiceOnlySettings.forEach(element => { element.hidden = !isVoiceCall; });
        videoOnlySettings.forEach(element => { element.hidden = isVoiceCall; });
        if (quickAiStartToggle) quickAiStartToggle.checked = settings.aiStarts;
        if (quickUserStartToggle) quickUserStartToggle.checked = settings.userStarts;
        if (quickVoiceSlider) quickVoiceSlider.value = String(Math.round(settings.voiceVolume * 100));
        if (quickVoiceValue) quickVoiceValue.textContent = formatPercent(settings.voiceVolume);
        if (voiceDescriptionToggle) voiceDescriptionToggle.checked = settings.voiceDescriptionEnabled;
        if (quickAmbientToggle) quickAmbientToggle.checked = settings.ambientEnabled;
        if (quickAmbientSlider) quickAmbientSlider.value = String(Math.round(settings.ambientVolume * 100));
        if (quickAmbientValue) quickAmbientValue.textContent = formatPercent(settings.ambientVolume);
        if (quickCameraToggle && isVoiceCall) quickCameraToggle.checked = false;
        if (!isVoiceCall) {
            document.dispatchEvent(new CustomEvent('video-call-camera-state-request', {
                detail: { chatId }
            }));
        }
    };

    const saveSettings = async (updates, chatId = tempState.currentChatId) => {
        const char = getCharacter(chatId);
        if (!char) return null;
        const nextSettings = normalizeCallSettings({ ...(char.callSettings || {}), ...updates });
        char.callSettings = nextSettings;
        await db.characterProfiles.put(char);
        if (String(chatId) === String(tempState.activeCallChatId)) {
            setCallAmbientVolume(nextSettings.ambientVolume);
            setCallTtsVolume(nextSettings.voiceVolume);
            if (updates.ambientEnabled !== undefined || updates.ambientSrc !== undefined) {
                await startCallAmbient(chatId);
            }
        }
        updateModalUI(char);
        updateQuickUI(chatId, quickMode);
        return nextSettings;
    };

    const saveStartMode = (key, chatId) => saveSettings({
        [key]: true,
        [key === 'aiStarts' ? 'userStarts' : 'aiStarts']: false
    }, chatId);

    const showModal = () => {
        const char = getCharacter();
        if (!char) return;
        updateModalUI(char);
        overlay.classList.add('visible');
    };
    const hideModal = () => {
        overlay.classList.remove('visible');
        if (callPreviewAudio) {
            callPreviewAudio.pause();
            callPreviewAudio = null;
        }
        if (ambientFileInput) ambientFileInput.value = '';
    };
    let quickMode = 'voice';
    const showQuickModal = (chatId = tempState.activeCallChatId || tempState.currentChatId, mode = 'voice') => {
        if (!getCharacter(chatId)) return;
        quickChatId = chatId;
        quickMode = mode === 'video' ? 'video' : 'voice';
        updateQuickUI(chatId, quickMode);
        quickOverlay.classList.add('visible');
    };
    const hideQuickModal = () => quickOverlay.classList.remove('visible');

    triggerBtn.addEventListener('click', showModal);
    closeBtn?.addEventListener('click', hideModal);
    overlay.addEventListener('click', event => { if (event.target === overlay) hideModal(); });
    quickCloseBtn?.addEventListener('click', hideQuickModal);
    quickOverlay.addEventListener('click', event => { if (event.target === quickOverlay) hideQuickModal(); });
    document.addEventListener('open-call-quick-settings', event => showQuickModal(event.detail?.chatId, event.detail?.mode));
    document.addEventListener('video-call-camera-state', event => {
        const detail = event.detail || {};
        if (quickMode === 'video' && String(detail.chatId) === String(quickChatId) && quickCameraToggle) {
            quickCameraToggle.checked = Boolean(detail.enabled);
        }
    });

    ambientToggle?.addEventListener('change', () => saveSettings({ ambientEnabled: ambientToggle.checked }));
    ambientNoneOption?.addEventListener('click', () => saveSettings({ ambientEnabled: false, ambientSrc: '', ambientName: '' }));
    [ambientCityOption, ambientRainOption].forEach(option => {
        option?.addEventListener('click', () => saveSettings({
            ambientEnabled: true,
            ambientSrc: option.dataset.audioSrc,
            ambientName: option.dataset.audioName
        }));
    });
    ambientFileInput?.addEventListener('change', async event => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!file.type.startsWith('audio/')) {
            showDynamicIsland('请选择有效的音频文件');
            return;
        }
        try {
            await saveSettings({ ambientEnabled: true, ambientSrc: await fileToBase64(file), ambientName: file.name });
        } catch (error) {
            console.error('[Call Settings] 环境音读取失败:', error);
            showDynamicIsland('读取环境音失败', {
                variant: 'error',
                detail: error?.message || '环境音文件读取失败',
                copyText: error?.stack || error?.message || '读取环境音失败'
            });
        }
    });
    ambientUrlOption?.addEventListener('click', () => ambientUrlInput?.focus());
    ambientUrlSaveBtn?.addEventListener('click', async () => {
        const url = ambientUrlInput?.value.trim() || '';
        if (!/^https?:\/\//i.test(url)) {
            showDynamicIsland('请输入有效的音频链接');
            return;
        }
        await saveSettings({ ambientEnabled: true, ambientSrc: url, ambientName: '网络音频' });
        if (ambientUrlInput) ambientUrlInput.value = '';
    });
    ambientPreviewBtn?.addEventListener('click', () => {
        const settings = getCallSettings(tempState.currentChatId);
        if (!settings.ambientSrc) return;
        if (callPreviewAudio) callPreviewAudio.pause();
        callPreviewAudio = new Audio(settings.ambientSrc);
        callPreviewAudio.loop = true;
        callPreviewAudio.volume = settings.ambientVolume;
        callPreviewAudio.play().catch(error => console.warn('[Call Settings] 环境音试听失败:', error));
    });
    ambientSlider?.addEventListener('input', () => {
        const value = Number(ambientSlider.value) / 100;
        if (ambientValue) ambientValue.textContent = formatPercent(value);
        setCallAmbientVolume(value);
    });
    ambientSlider?.addEventListener('change', () => saveSettings({ ambientVolume: Number(ambientSlider.value) / 100 }));
    voiceSlider?.addEventListener('input', () => {
        const value = Number(voiceSlider.value) / 100;
        if (voiceValue) voiceValue.textContent = `${voiceSlider.value}%`;
        setCallTtsVolume(value);
    });
    voiceSlider?.addEventListener('change', () => saveSettings({ voiceVolume: Number(voiceSlider.value) / 100 }));
    aiStartToggle?.addEventListener('change', () => saveStartMode('aiStarts', tempState.currentChatId));
    userStartToggle?.addEventListener('change', () => saveStartMode('userStarts', tempState.currentChatId));

    quickAiStartToggle?.addEventListener('change', () => saveStartMode('aiStarts', quickChatId));
    quickUserStartToggle?.addEventListener('change', () => saveStartMode('userStarts', quickChatId));
    quickVoiceSlider?.addEventListener('input', () => {
        const value = Number(quickVoiceSlider.value) / 100;
        if (quickVoiceValue) quickVoiceValue.textContent = formatPercent(value);
        setCallTtsVolume(value);
    });
    quickVoiceSlider?.addEventListener('change', () => saveSettings({ voiceVolume: Number(quickVoiceSlider.value) / 100 }, quickChatId));
    voiceDescriptionToggle?.addEventListener('change', () => saveSettings({ voiceDescriptionEnabled: voiceDescriptionToggle.checked }, quickChatId));
    quickCameraToggle?.addEventListener('change', () => {
        if (quickMode !== 'video') return;
        document.dispatchEvent(new CustomEvent('video-call-camera-toggle', {
            detail: { enabled: quickCameraToggle.checked, chatId: quickChatId }
        }));
    });
    quickAmbientToggle?.addEventListener('change', () => saveSettings({ ambientEnabled: quickAmbientToggle.checked }, quickChatId));
    quickAmbientSlider?.addEventListener('input', () => {
        const value = Number(quickAmbientSlider.value) / 100;
        if (quickAmbientValue) quickAmbientValue.textContent = formatPercent(value);
        setCallAmbientVolume(value);
    });
    quickAmbientSlider?.addEventListener('change', () => saveSettings({ ambientVolume: Number(quickAmbientSlider.value) / 100 }, quickChatId));
}

/**
 * 初始化聊天设置页面的所有交互
 */
export function initChatSettings() {
    setupChatSettingsScrollBehavior();
    setupCallSettings();
    const chatDetailMoreBtn = document.getElementById('chat-detail-more-btn');
    const chatSettingsPinToggle = document.getElementById('chat-settings-pin-toggle');
     const chatSettingsDeleteHistory = document.getElementById('chat-settings-delete-history-btn');
    if (chatDetailMoreBtn) {
        chatDetailMoreBtn.addEventListener('click', () => {
            if (!tempState.currentChatId) return;
            const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            
            if (char && char.isGroup) {
                // 如果是群聊，展示群聊设置页 
                showPage('page-group-chat-settings');
            } else {
                // 【性能优化】单聊：先显示页面，等浏览器完成两帧绘制后再刷新内容
                showPage('page-chat-settings');
                scheduleChatSettingsRender();
            }
        });
    }

    if (chatSettingsPinToggle) {
        chatSettingsPinToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            if (!charId) return;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                char.isPinned = chatSettingsPinToggle.checked;
                await optimizedSaveAndRender();
                showDynamicIsland(char.isPinned ? '已置顶' : '已取消置顶');
            }
        });
    }
// 这是【替换后】的新代码
if (chatSettingsDeleteHistory) {
    setupDeleteHistoryModal();
}
setupManualSummaryModal(); // ▼▼▼ 新增：初始化手动记忆总结功能 ▼▼▼
    // ▼▼▼ 新增：监听自动总结开关和滑块联动 ▼▼▼
     const autoSummaryToggle = document.getElementById('chat-settings-auto-summary-toggle');
    const autoSummarySlider = document.getElementById('auto-summary-turns-slider');
    const autoSummaryValue = document.getElementById('auto-summary-turns-value');
    const offlineAutoSummarySlider = document.getElementById('offline-auto-summary-turns-slider');
    const offlineAutoSummaryValue = document.getElementById('offline-auto-summary-turns-value');

    const autoSummaryDetails = document.getElementById('auto-summary-details');

    if (autoSummaryToggle) {
        autoSummaryToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                const isEnabled = autoSummaryToggle.checked;
                char.autoSummaryEnabled = isEnabled;
                await optimizedSaveAndRender();
                showDynamicIsland(isEnabled ? '已开启自动总结' : '已关闭自动总结');
                
                // 自动展开/折叠面板
                if (isEnabled) {
                    autoSummaryDetails.setAttribute('open', '');
                } else {
                    autoSummaryDetails.removeAttribute('open');
                }
            }
        });
    }

    if (autoSummarySlider && autoSummaryValue) {
        // 滑动时只更新数字显示
        autoSummarySlider.addEventListener('input', () => {
            autoSummaryValue.textContent = autoSummarySlider.value;
        });

        // 停止滑动（松开手）时才保存数据库
        autoSummarySlider.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                const newValue = parseInt(autoSummarySlider.value, 10);
                char.autoSummaryTurns = newValue;
                await optimizedSaveAndRender();
                showDynamicIsland(`自动总结已设为每 ${newValue} 轮一次`);
            }
        });
    }
      
    // 单聊线下总结
    if (offlineAutoSummarySlider && offlineAutoSummaryValue) {
        offlineAutoSummarySlider.addEventListener('input', () => {
            offlineAutoSummaryValue.textContent = offlineAutoSummarySlider.value;
        });
        offlineAutoSummarySlider.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                const newValue = parseInt(offlineAutoSummarySlider.value, 10);
                char.offlineAutoSummaryTurns = newValue;
                await optimizedSaveAndRender();
                showDynamicIsland(`线下总结已设为每 ${newValue} 轮一次`);
            }
        });
    }
    // 群聊线下总结
    const gcOfflineAutoSummarySlider = document.getElementById('gc-offline-auto-summary-slider');
    const gcOfflineAutoSummaryValue = document.getElementById('gc-offline-auto-summary-val');
    
    if (gcOfflineAutoSummarySlider && gcOfflineAutoSummaryValue) {
        gcOfflineAutoSummarySlider.addEventListener('input', () => {
            gcOfflineAutoSummaryValue.textContent = gcOfflineAutoSummarySlider.value;
        });
        gcOfflineAutoSummarySlider.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                const newValue = parseInt(gcOfflineAutoSummarySlider.value, 10);
                char.offlineAutoSummaryTurns = newValue;
                await optimizedSaveAndRender();
                showDynamicIsland(`线下总结已设为每 ${newValue} 轮一次`);
            }
        });
    }

    document.addEventListener('showTransferDetail', (e) => showTransferDetailPage(e.detail.messageId));
  const inviteToggle = document.getElementById('allow-offline-invite-toggle');
    if (inviteToggle) {
         inviteToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            if (!charId) return;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                char.allowOfflineInvite = inviteToggle.checked;
                await optimizedSaveAndRender();
                showDynamicIsland(inviteToggle.checked ? '邀约功能已开启' : '邀约功能已关闭');
            }
        });
    }
    // [新增] 监听自动行程开关变化，并与时间感知强制联动
     const autoRideToggle = document.getElementById('chat-settings-auto-ride-toggle');
    const perceptionToggle = document.getElementById('time-perception-switch');
    const focusModePanel = document.getElementById('focus-mode-settings-panel');
    if (autoRideToggle) {
        autoRideToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                char.autoRideEnabled = autoRideToggle.checked;
                if (focusModePanel) focusModePanel.style.display = autoRideToggle.checked ? 'block' : 'none';
                // 如果开启自动行程，强制开启并保存时间感知
                if (autoRideToggle.checked) {
                    if (!char.timeSettings) char.timeSettings = {};
                    char.timeSettings.perceptionEnabled = true;
                    if (perceptionToggle) perceptionToggle.checked = true; // 同步更新UI
                }
                await optimizedSaveAndRender();
                showDynamicIsland(autoRideToggle.checked ? '行程注入开启(时间感知已同步启用)' : '自动行程已关闭');
            }
        });
    }
    const sleepToggle = document.getElementById('sleep-schedule-toggle');
    const sleepTimes = document.getElementById('sleep-schedule-times');
    const sleepTimeInput = document.getElementById('sleep-time-input');
    const wakeTimeInput = document.getElementById('wake-time-input');
    const sleepWakeCountInput = document.getElementById('sleep-wake-count-input');
    const sleepDetail = document.getElementById('sleep-settings-detail');
    const sleepUndoBtn = document.getElementById('sleep-settings-undo-btn');
    const sleepApplyBtn = document.getElementById('sleep-settings-apply-btn');
    const sleepCurrent = document.getElementById('sleep-settings-current');
    const readSleepDraft = () => ({
        sleepTime: sleepTimeInput?.value || '23:00',
        wakeTime: wakeTimeInput?.value || '07:30',
        wakeAfterMessages: Math.max(1, Math.min(20, Number(sleepWakeCountInput?.value) || 6))
    });
    const sameSleepDraft = (left, right) => Boolean(left && right && left.sleepTime === right.sleepTime && left.wakeTime === right.wakeTime && Number(left.wakeAfterMessages) === Number(right.wakeAfterMessages));
    const updateSleepApplyState = () => {
        const currentChar = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        const baseline = currentChar ? { sleepTime: currentChar.sleepTime || '23:00', wakeTime: currentChar.wakeTime || '07:30', wakeAfterMessages: currentChar.sleepWakeAfterMessages || 6 } : null;
        if (sleepApplyBtn) sleepApplyBtn.disabled = sameSleepDraft(baseline, readSleepDraft());
    };
    const renderSleepCurrent = async (char) => {
        const settings = getSleepSettings(char);
        if (sleepDetail) sleepDetail.hidden = !settings.enabled;
        if (sleepTimes) sleepTimes.style.display = settings.enabled ? 'grid' : 'none';
        if (sleepCurrent) {
            sleepCurrent.textContent = '等待今日日程推演';
        }
        if (!settings.enabled || !sleepCurrent) return;
        const record = await getSleepRecordBySleepDate(char.id, getLocalDateKey());
        if (getSleepSettings(char).enabled) sleepCurrent.textContent = record ? `今晚预计 ${record.actualSleepTime} 入睡 · 明早 ${record.actualWakeTime} 起床` : '等待今日日程推演';
    };
    const persistSleepSettings = async (next, shouldRegenerate = false, createUndo = false) => {
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (!char) return false;
        const previous = {
            sleepScheduleEnabled: char.sleepScheduleEnabled === true,
            sleepTime: char.sleepTime || '23:00', wakeTime: char.wakeTime || '07:30',
            sleepWakeAfterMessages: char.sleepWakeAfterMessages || 6,
            sleepProjection: char.sleepProjection || null
        };
        char.sleepScheduleEnabled = next.enabled;
        char.sleepTime = next.sleepTime;
        char.wakeTime = next.wakeTime;
        char.sleepWakeAfterMessages = next.wakeAfterMessages;
        await db.characterProfiles.update(char.id, {
            sleepScheduleEnabled: char.sleepScheduleEnabled, sleepTime: char.sleepTime, wakeTime: char.wakeTime,
            sleepWakeAfterMessages: char.sleepWakeAfterMessages
        });
        if (createUndo) await db.appData.put({ key: 'sleep_settings_undo_' + char.id, value: previous });
        else await db.appData.delete('sleep_settings_undo_' + char.id);
        if (!next.enabled) await disableSleepSchedule(char);
        if (sleepUndoBtn) sleepUndoBtn.hidden = !createUndo;
        if (shouldRegenerate && getSleepSettings(char).enabled) await window.triggerAutoScheduleTask?.(char.id, true, 'today');
        return true;
    };
    if (sleepToggle && !sleepToggle.dataset.sleepBound) {
        sleepToggle.addEventListener('change', async () => {
            const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            if (!char) return;
            const timePerceptionEnabled = (char.timeSettings?.perceptionEnabled ?? true) === true;
            if (sleepToggle.checked && !timePerceptionEnabled) {
                sleepToggle.checked = false;
                await renderSleepCurrent(char);
                showDynamicIsland('请先开启时间感知');
                return;
            }
            if (!sleepToggle.checked) {
                await persistSleepSettings({ enabled: false, sleepTime: char.sleepTime || '23:00', wakeTime: char.wakeTime || '07:30', wakeAfterMessages: char.sleepWakeAfterMessages || 6 });
            } else {
                await persistSleepSettings({ enabled: true, sleepTime: sleepTimeInput?.value || '23:00', wakeTime: wakeTimeInput?.value || '07:30', wakeAfterMessages: Number(sleepWakeCountInput?.value) || 6 });
            }
            await renderSleepCurrent(char);
            updateSleepApplyState();
            showDynamicIsland(sleepToggle.checked ? '睡眠计划已开启' : '睡眠计划已关闭');
        });
        [sleepTimeInput, wakeTimeInput, sleepWakeCountInput].forEach(input => input?.addEventListener('input', () => {
            updateSleepApplyState();
        }));
        sleepApplyBtn?.addEventListener('click', async () => {
            const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            if (!char || !sleepToggle.checked) return;
            const baseline = { sleepTime: char.sleepTime || '23:00', wakeTime: char.wakeTime || '07:30', wakeAfterMessages: char.sleepWakeAfterMessages || 6 };
            if (sameSleepDraft(baseline, readSleepDraft())) return;
            const todayKey = getLocalDateKey();
            const scheduleRecord = await db.appData.get('ls_schedules_data_' + char.id);
            const hasTodaySchedule = (scheduleRecord?.value || []).some(item => item?.dateISO === todayKey && item.owner === 'ta');
            showSleepEditConfirmModal(baseline, readSleepDraft(), async choice => {
                if (choice === 'cancel') {
                    sleepTimeInput.value = char.sleepTime || '23:00';
                    wakeTimeInput.value = char.wakeTime || '07:30';
                    sleepWakeCountInput.value = char.sleepWakeAfterMessages || 6;
                    updateSleepApplyState();
                    return;
                }
                const next = readSleepDraft();
                await persistSleepSettings({ enabled: true, ...next }, choice === 'sync', true);
                updateSleepApplyState();
                await renderSleepCurrent(char);
                showDynamicIsland(choice === 'sync' ? '已保存，正在重新推演后续日程' : '已保存睡眠设置，当前日程未修改');
            }, { hasTodaySchedule });
        });
        sleepUndoBtn?.addEventListener('click', async () => {
            const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            const undo = char ? await db.appData.get('sleep_settings_undo_' + char.id) : null;
            if (!char || !undo?.value) return;
            const previous = undo.value;
            char.sleepScheduleEnabled = previous.sleepScheduleEnabled === true && (char.timeSettings?.perceptionEnabled ?? true) === true;
            char.sleepTime = previous.sleepTime || '23:00';
            char.wakeTime = previous.wakeTime || '07:30';
            char.sleepWakeAfterMessages = previous.sleepWakeAfterMessages || 6;
            char.sleepProjection = previous.sleepProjection || null;
            await db.characterProfiles.update(char.id, { sleepScheduleEnabled: char.sleepScheduleEnabled, sleepTime: char.sleepTime, wakeTime: char.wakeTime, sleepWakeAfterMessages: char.sleepWakeAfterMessages, sleepProjection: char.sleepProjection });
            if (!getSleepSettings(char).enabled) await disableSleepSchedule(char);
            await db.appData.delete('sleep_settings_undo_' + char.id);
            sleepToggle.checked = getSleepSettings(char).enabled;
            sleepTimeInput.value = char.sleepTime;
            wakeTimeInput.value = char.wakeTime;
            sleepWakeCountInput.value = char.sleepWakeAfterMessages;
            if (sleepTimes) sleepTimes.style.display = sleepToggle.checked ? 'grid' : 'none';
            await renderSleepCurrent(char);
            updateSleepApplyState();
            sleepUndoBtn.hidden = true;
            showDynamicIsland('已撤回上次睡眠设置修改');
        });
        sleepToggle.dataset.sleepBound = '1';
    }
    // ▼▼▼ 新增：专注回复概率和文本的事件绑定 ▼▼▼
    const focusProbSlider = document.getElementById('focus-reply-prob-slider');
    const focusProbVal = document.getElementById('focus-reply-prob-val');
    const focusAutoReply = document.getElementById('focus-auto-reply-input');
    if (focusProbSlider && focusProbVal) {
        focusProbSlider.addEventListener('input', () => focusProbVal.textContent = focusProbSlider.value + '%');
        focusProbSlider.addEventListener('change', async () => {
            const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            if (char) {
                char.focusReplyProbability = parseInt(focusProbSlider.value, 10);
                await optimizedSaveAndRender();
            }
        });
    }
    if (focusAutoReply) {
        focusAutoReply.addEventListener('change', async () => {
            const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            if (char) {
                char.focusAutoReplyText = focusAutoReply.value.trim();
                await optimizedSaveAndRender();
            }
        });
    }
     // ▼▼▼ 修复：在这里声明并获取这两个输入框的元素 ▼▼▼
    const focusWorkMins = document.getElementById('focus-work-mins-input');
    const focusRestMins = document.getElementById('focus-rest-mins-input');
    if (focusWorkMins) {
        focusWorkMins.addEventListener('change', async () => {
            const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            if (char) {
                char.focusWorkMins = parseInt(focusWorkMins.value, 10) || 45;
                await optimizedSaveAndRender();
            }
        });
    }

    if (focusRestMins) {
        focusRestMins.addEventListener('change', async () => {
            const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            if (char) {
                char.focusRestMins = parseInt(focusRestMins.value, 10) || 10;
                await optimizedSaveAndRender();
            }
        });
    }
    // ▲▲▲ 新增结束 ▲▲▲
    setupChatIdentitySwitcher();
    setupChatStickerSelector();
    setupRingtoneSettings();
    setupNotificationSettings();
   setupContextTurnsSettings();
   setupMountWorldBook();
   initTimeSettingsModal();
   initBackgroundActivityModal();
   setupMomentsContextSettings();
   setupForumLinkContextSettings();
    setupChatBackgroundSettings();
    setupChatDataManagement();
    setupQuickBeautify();
    setupAvatarRefineSettings();
    setupVideoWallpaperSettings();
    setupPartialDeleteLogic();
       // ▼▼▼ 新增：监听强效动作引导开关变化 ▼▼▼
    const actionReminderToggle = document.getElementById('chat-settings-action-reminder-toggle');
    if (actionReminderToggle) {
        actionReminderToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                char.actionReminderEnabled = actionReminderToggle.checked;
                await optimizedSaveAndRender();
                if (typeof showDynamicIsland === 'function') {
                    showDynamicIsland(char.actionReminderEnabled ? '已开启强效动作引导' : '已关闭强效动作引导');
                }
            }
        });
    }
    const autoTranslateToggle2 = document.getElementById('chat-settings-auto-translate-toggle');
    if (autoTranslateToggle2) {
        autoTranslateToggle2.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => String(c.id) === String(charId));
            if (char) {
                char.autoTranslateEnabled = autoTranslateToggle2.checked;
                await optimizedSaveAndRender();
                showDynamicIsland(char.autoTranslateEnabled ? '已开启自动翻译' : '已关闭自动翻译');
            }
        });
    }
    const stickerMatchToggleInit = document.getElementById('chat-settings-sticker-match-toggle');
    if (stickerMatchToggleInit) {
        stickerMatchToggleInit.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                char.stickerMatchEnabled = stickerMatchToggleInit.checked;
                await optimizedSaveAndRender();
                window.__refreshChatStickerMatches?.();
                showDynamicIsland(char.stickerMatchEnabled ? '已开启输入时匹配表情包' : '已关闭输入时匹配表情包');
            }
        });
    }
    const formatAnchorToggle = document.getElementById('chat-settings-format-anchor-toggle');
    if (formatAnchorToggle) {
        formatAnchorToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                char.formatAnchorEnabled = formatAnchorToggle.checked;
                await optimizedSaveAndRender();
                showDynamicIsland(char.formatAnchorEnabled ? '已开启输出格式锁' : '已关闭输出格式锁');
            }
        });
    }
    // 自动触发回复开关事件
    const autoSendToggleInit = document.getElementById('chat-settings-auto-send-toggle');
    if (autoSendToggleInit) {
        autoSendToggleInit.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                char.autoSendEnabled = autoSendToggleInit.checked;
                await optimizedSaveAndRender();
                const container = document.getElementById('auto-send-delay-container');
                if (container) container.style.display = autoSendToggleInit.checked ? 'block' : 'none';
                showDynamicIsland(autoSendToggleInit.checked ? '已开启自动触发回复' : '已关闭自动触发回复');
            }
        });
    }
    // 自动触发延迟滑块事件
    const autoSendDelaySliderInit = document.getElementById('auto-send-delay-slider');
    const autoSendDelayValueInit = document.getElementById('auto-send-delay-value');
    if (autoSendDelaySliderInit && autoSendDelayValueInit) {
        autoSendDelaySliderInit.addEventListener('input', () => {
            autoSendDelayValueInit.textContent = `${autoSendDelaySliderInit.value} 秒`;
        });
        autoSendDelaySliderInit.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                char.autoSendDelay = parseInt(autoSendDelaySliderInit.value, 10);
                await optimizedSaveAndRender();
            }
        });
    }
    const lightPromptToggle = document.getElementById('chat-settings-light-prompt-toggle');
    if (lightPromptToggle) {
        lightPromptToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                let val = lightPromptToggle.value;
                if (val === 'true') val = true;
                if (val === 'false') val = false;
                
                char.useLightPrompt = val;
                markPendingContextSwitch('online', charId, 'preset');
                await optimizedSaveAndRender();
                
                let msg = '已切换为常规预设';
                if (val === true) msg = '已切换为适配3.1pro版预设';
                if (val === 'minimal') msg = '已切换为拟真轻量版预设';
                if (val === 'ivory') msg = '已切换为让char不再是淡人预设';
                showDynamicIsland(msg);
            }
        });
    }
    ['chat-settings-min-messages', 'chat-settings-max-messages'].forEach(elId => {
        const el = document.getElementById(elId);
        if (el) {
            el.addEventListener('change', async () => {
                const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
                if (!char) return;
                const raw = el.value.trim();
                const field = elId.includes('min') ? 'minMessages' : 'maxMessages';
                if (raw === '') {
                    delete char[field];
                } else {
                    char[field] = Math.max(1, Math.min(15, parseInt(raw, 10) || 1));
                    el.value = char[field];
                }
                await optimizedSaveAndRender();
            });
        }
    });
    const replyLanguageSelect = document.getElementById('chat-settings-reply-language-select');
    if (replyLanguageSelect) {
        replyLanguageSelect.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                const value = replyLanguageSelect.value || 'auto';
                char.replyLanguage = value;
                markPendingContextSwitch('online', charId, 'reply-language');
                await db.characterProfiles.update(char.id, { replyLanguage: value });
                showDynamicIsland('回复语言已更新');
            }
        });
    }
        // ▼▼▼ 新增：监听天气与季节感知开关变化 ▼▼▼
    const weatherPerceptionToggle = document.getElementById('chat-settings-weather-perception-toggle');
    if (weatherPerceptionToggle) {
        weatherPerceptionToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                char.weatherPerceptionEnabled = weatherPerceptionToggle.checked;
                await optimizedSaveAndRender();
                if (typeof showDynamicIsland === 'function') {
                    showDynamicIsland(char.weatherPerceptionEnabled ? '已开启天气与季节感知' : '已关闭天气与季节感知');
                }
            }
        });
    }
    // ▼▼▼ 新增：监听与群聊同步记忆开关变化 ▼▼▼
    const syncGroupToggle = document.getElementById('chat-settings-sync-group-toggle');
    if (syncGroupToggle) {
        syncGroupToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                char.syncGroupMemoryEnabled = syncGroupToggle.checked;
                await optimizedSaveAndRender();
                showDynamicIsland(char.syncGroupMemoryEnabled ? '已开启与群聊同步记忆' : '已关闭与群聊同步记忆');
            }
        });
    }
    // ▲▲▲ 新增结束 ▲▲▲
   // 新增：监听动态表情包开关变化
    const momentStickerToggle = document.getElementById('chat-settings-moment-sticker-toggle');
    if (momentStickerToggle) {
        momentStickerToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                char.momentsStickersEnabled = momentStickerToggle.checked;
                await optimizedSaveAndRender();
                showDynamicIsland(char.momentsStickersEnabled ? '已允许角色在动态中使用表情包' : '已禁止在动态中使用表情包');
            }
        });
    }
    const momentMusicToggle = document.getElementById('chat-settings-moment-music-toggle');
    if (momentMusicToggle) {
        momentMusicToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                char.momentsMusicEnabled = momentMusicToggle.checked;
                await optimizedSaveAndRender();
                showDynamicIsland(char.momentsMusicEnabled ? '已允许角色在动态中使用音乐' : '已禁止在动态中使用音乐');
            }
        });
    }
    const chatPlaylistToggle = document.getElementById('chat-settings-chat-playlist-toggle');
    if (chatPlaylistToggle) {
        chatPlaylistToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                char.chatPlaylistShareEnabled = chatPlaylistToggle.checked;
                await optimizedSaveAndRender();
                showDynamicIsland(char.chatPlaylistShareEnabled ? '已允许角色在聊天中分享歌单' : '已禁止角色在聊天中分享歌单');
            }
        });
    }
    // ▼▼▼ 新增：监听识图提示词开关变化 ▼▼▼
    const visionTextOnlyToggle = document.getElementById('chat-settings-vision-text-only-toggle');
    if (visionTextOnlyToggle) {
        visionTextOnlyToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                char.visionTextOnlyEnabled = visionTextOnlyToggle.checked;
                await optimizedSaveAndRender();
                if (typeof showDynamicIsland === 'function') {
                    showDynamicIsland(char.visionTextOnlyEnabled ? '开启识图保留文本(省Token)' : '关闭识图保留文本');
                }
            }
        });
    }
    const npcForwardToggle = document.getElementById('chat-settings-npc-forward-toggle');
    if (npcForwardToggle) {
        npcForwardToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                char.npcChatForwardEnabled = npcForwardToggle.checked;
                await db.characterProfiles.update(char.id, {
                    npcChatForwardEnabled: npcForwardToggle.checked
                });
                showDynamicIsland(char.npcChatForwardEnabled ? '已允许角色转发聊天记录' : '已禁止角色转发聊天记录');
            }
        });
    }
    // ▲▲▲ 新增结束 ▲▲▲
    // ▼▼▼ 新增：拉黑按钮点击事件 ▼▼▼
    const blockBtn = document.getElementById('chat-settings-block-btn');
    const blockText = document.getElementById('chat-settings-block-text');
    if (blockBtn && blockText) {
        blockBtn.addEventListener('click', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                // ▼▼▼ 新增：单向拉黑保护。如果AI已经拉黑了你，阻止你反向拉黑导致锁死 ▼▼▼
                if (char.isBlockedByAi) {
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('对方已将您拉黑，无法更改状态', 'warning');
                    else alert('对方已将您拉黑，无法更改状态');
                    return;
                }
                // ▲▲▲ 新增结束 ▲▲▲

                const isCurrentlyBlocked = char.isBlocked ?? false;
                // 如果是去拉黑别人，弹个窗确认一下防误触
                if (!isCurrentlyBlocked) {
                    if (!confirm(`确定要拉黑 "${char.name}" 吗？`)) return;
                }
                // 切换状态并保存
                char.isBlocked = !isCurrentlyBlocked;
                
                // 记录拉黑当下的时间戳
                if (char.isBlocked) {
                    char.blockTimestamp = Date.now();
                    char.blockAppealPhase = 'friend_request';
                    char.hasReactedToBlock = false;
                    char.lastBlockSmsTime = 0;
                    char.lastMainChatUnblockedAt = null;
                } else {
                    char.blockTimestamp = null;
                    char.hasReactedToBlock = false; // 解除时重置
                    char.lastBlockSmsTime = 0;
                    char.blockAppealPhase = null;
                    char.lastMainChatUnblockedAt = Date.now();
                }

                // 【性能核弹修复】千万不要在这里调用 optimizedSaveAndRender()！
                // 它会引发全局好友列表重新渲染，造成至少半秒的假死卡顿！
                // 改用底层静默更新数据库，UI我们用 JS 手动去改：
                await db.characterProfiles.update(char.id, {
                    isBlocked: char.isBlocked,
                    blockTimestamp: char.blockTimestamp,
                    hasReactedToBlock: char.hasReactedToBlock,
                    lastBlockSmsTime: char.lastBlockSmsTime,
                    blockAppealPhase: char.blockAppealPhase,
                    lastMainChatUnblockedAt: char.lastMainChatUnblockedAt
                });
                
                // 更新文字和提示
                blockText.textContent = char.isBlocked ? '取消拉黑' : '拉黑此联系人';
                showDynamicIsland(char.isBlocked ? '已拉黑该联系人' : '已取消拉黑');
                const blockedOverlay = document.getElementById('chat-blocked-overlay');
                if (blockedOverlay) {
                    blockedOverlay.style.display = char.isBlocked ? 'flex' : 'none';
                }
            }
        });
    }
    
    // 新增：监听拉黑互动时间输入框
    const blockReactionTimeInput = document.getElementById('block-reaction-time-input');
    if (blockReactionTimeInput) {
        const saveBlockReactionTime = async (shouldRender = false) => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char) {
                const val = parseInt(blockReactionTimeInput.value, 10);
                char.blockReactionTime = isNaN(val) ? 0 : val;
                if (shouldRender) {
                    await optimizedSaveAndRender();
                } else {
                    await db.characterProfiles.update(char.id, { blockReactionTime: char.blockReactionTime });
                }
            }
        };
        blockReactionTimeInput.addEventListener('input', () => saveBlockReactionTime(false));
        blockReactionTimeInput.addEventListener('change', () => saveBlockReactionTime(true));
    }
    // ▲▲▲ 新增结束 ▲▲▲
}

/**
 * 设置上下文轮数弹窗的逻辑
 */
function setupContextTurnsSettings() {
    const triggerBtn = document.getElementById('context-settings-trigger');
    const overlay = document.getElementById('context-turns-modal-overlay');
    const slider = document.getElementById('context-turns-slider');
    const valueDisplay = document.getElementById('context-turns-value');
    const doneBtn = document.getElementById('context-turns-modal-done');
    const settingsPageDisplay = document.getElementById('current-context-turns-display');

    if (!triggerBtn || !overlay || !slider || !valueDisplay || !doneBtn || !settingsPageDisplay) return;

    const showModal = () => {
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (!char) return;
        
        const currentValue = char.contextTurns || 25; 
        slider.value = currentValue;
        valueDisplay.textContent = currentValue;
        
        overlay.classList.add('visible');
    };

    const hideModalAndSave = async () => {
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (!char) return;

        const newValue = parseInt(slider.value, 10);
        char.contextTurns = newValue;
        
        // 使用已有的函数保存角色数据
        await optimizedSaveAndRender(); 
        
        // 更新设置页面的显示
        settingsPageDisplay.textContent = newValue;
        
        overlay.classList.remove('visible');
        showDynamicIsland(`上下文已设为 ${newValue} 轮`);
    };

    triggerBtn.addEventListener('click', showModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            hideModalAndSave();
        }
    });
    doneBtn.addEventListener('click', hideModalAndSave);

    slider.addEventListener('input', () => {
        valueDisplay.textContent = slider.value;
    });
}

/* 
 * ==========================================================================
 *   ▼▼▼ 【修改后】的“时间设置”弹窗逻辑 ▼▼▼
 * ==========================================================================
 */
function initTimeSettingsModal() {
    // 1. 找到所有需要的零件
    const trigger = document.getElementById('time-settings-trigger');
    const modal = document.getElementById('time-settings-modal');
    const closeBtn = document.getElementById('close-time-settings-btn');
    
    // 👇 这是我们新增的，找到那个“时间感知”的开关
    const perceptionToggle = document.getElementById('time-perception-switch');
    if (!trigger || !modal || !closeBtn || !perceptionToggle) {
        console.warn('时间设置弹窗的必要元素没有找到，功能将无法使用。');
        return;
    }

    // 2. 打开弹窗时，读取并显示当前设置
    const showModal = () => {
        const charId = tempState.currentChatId;
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (!char) return;

        // 读取角色的时间设置。如果还没设置过(char.timeSettings为undefined)，就默认它是开启的 (?? true)
        const isPerceptionEnabled = char.timeSettings?.perceptionEnabled ?? true;
        
        // 把开关的状态设置为我们读到的值
        perceptionToggle.checked = isPerceptionEnabled;

        modal.classList.add('visible');
    };

    // 3. 关闭弹窗的函数
    const hideModal = () => {
        modal.classList.remove('visible');
    };

    // 4. 当开关状态改变时，保存设置
    const handleToggleChange = async () => {
        const charId = tempState.currentChatId;
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (!char) return;

        // 如果角色还没有timeSettings对象，就创建一个
        if (!char.timeSettings) {
            char.timeSettings = {};
        }
        
        // 把开关的最新状态保存到角色的档案里
        char.timeSettings.perceptionEnabled = perceptionToggle.checked;

        if (!perceptionToggle.checked && char.sleepScheduleEnabled === true) {
            await disableSleepSchedule(char);
            showDynamicIsland('时间感知已关闭，睡眠计划已停用');
        }

        // 调用你项目里已有的保存函数，把更新后的角色档案存进数据库
        await optimizedSaveAndRender(); 
        
        // 给用户一个提示
        if (perceptionToggle.checked) showDynamicIsland('时间感知已开启');
        renderChatSettingsPage();
    };

    // 5. 把所有操作绑定到对应的按钮上
    trigger.addEventListener('click', showModal);
    closeBtn.addEventListener('click', hideModal);
    modal.addEventListener('click', (event) => {
        if (event.target === modal) {
            hideModal();
        }
    });

    // 👇 给开关绑定“改变”事件
    perceptionToggle.addEventListener('change', handleToggleChange);
}

// 文件: chat-settings.js

function initBackgroundActivityModal() {
    const triggerBtn = document.getElementById('chat-settings-bg-activity-btn');
    const modal = document.getElementById('bg-activity-modal-overlay');
    const closeBtn = document.getElementById('close-bg-activity-btn');
    const saveBtn = document.getElementById('save-bg-activity-btn');
     // 模块 DOM
    const moduleMoments = document.getElementById('module-moments');
    const moduleDiary = document.getElementById('module-diary');
    const moduleActiveMsg = document.getElementById('module-active-message'); // 新增
    const moduleAutoSchedule = document.getElementById('module-auto-schedule');

    // 开关 DOM
    const momentsToggle = document.getElementById('active-posting-toggle');
    const diaryToggle = document.getElementById('auto-diary-toggle');
    const activeMsgToggle = document.getElementById('active-message-toggle'); // 新增
    const autoScheduleToggle = document.getElementById('auto-schedule-toggle');

    // 内部元素
    const manualTestBtn = document.getElementById('manual-post-test-btn');
    const manualMsgTestBtn = document.getElementById('manual-message-test-btn'); // 新增
    const manualScheduleTestBtn = document.getElementById('manual-schedule-test-btn');
    const timeDisplay = document.getElementById('diary-time-display');
    const activeMsgIntervalInput = document.getElementById('active-msg-interval-input'); // 新增输入框DOM
    const autoScheduleTimeInput = document.getElementById('auto-schedule-time-input');
    const rulerContainer = document.getElementById('diary-time-ruler');
    const rulerTrack = document.getElementById('diary-ruler-track');

    if (!triggerBtn || !modal) return;
    let currentSettings = {
        momentsEnabled: false,
        postFrequency: 'medium',
        diaryEnabled: false,
        diaryTime: '22:00',
        activeMsgEnabled: false,    // 新增
        activeMsgInterval: '6',     // 新增
        autoScheduleEnabled: false,
        autoScheduleTarget: 'today',
        autoScheduleTime: '08:00'
    };

    const syncModuleState = () => {
        if (autoScheduleToggle.checked) moduleAutoSchedule.classList.add('active');
        else moduleAutoSchedule.classList.remove('active');
        if (momentsToggle.checked) moduleMoments.classList.add('active');
        else moduleMoments.classList.remove('active');

        if (diaryToggle.checked) moduleDiary.classList.add('active');
        else moduleDiary.classList.remove('active');

        if (activeMsgToggle.checked) moduleActiveMsg.classList.add('active'); // 新增
        else moduleActiveMsg.classList.remove('active'); // 新增
    };

    const PIXELS_PER_MINUTE = 1; 
    
    function initTimeRuler() {
        if (rulerTrack.children.length > 0) return;
        for (let i = 0; i <= 24 * 6; i++) { 
            const tick = document.createElement('div');
            tick.classList.add('tick');
            if (i % 6 === 0) {
                tick.classList.add('hour');
                tick.setAttribute('data-hour', i / 6);
            } else if (i % 3 === 0) {
                tick.classList.add('half');
            }
            rulerTrack.appendChild(tick);
        }
    }

    function setupRulerInteraction() {
        const [h, m] = currentSettings.diaryTime.split(':').map(Number);
        const totalMinutes = h * 60 + m;
        rulerContainer.scrollLeft = totalMinutes * PIXELS_PER_MINUTE;

        rulerContainer.addEventListener('scroll', () => {
            let scrollLeft = rulerContainer.scrollLeft;
            if (scrollLeft < 0) scrollLeft = 0;
            let minutes = Math.round(scrollLeft / PIXELS_PER_MINUTE);

            // ▼▼▼ 【最终核心修复】将上限从 1430 (23:50) 改为 1440 (24:00) ▼▼▼
            if (minutes > 1440) minutes = 1440; 
            // ▲▲▲ 修复结束 ▲▲▲

            minutes = Math.round(minutes / 10) * 10;

            const hour = Math.floor(minutes / 60);
            const min = minutes % 60;
            const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
            
            timeDisplay.textContent = timeStr;
            currentSettings.diaryTime = timeStr;
        });
    }
    const showModal = async () => {
        const charId = tempState.currentChatId;
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (!char) return;

        currentSettings.momentsEnabled = char.activePostingEnabled || false;
        currentSettings.postFrequency = char.postFrequency || 'medium';
        currentSettings.diaryEnabled = char.autoDiaryEnabled || false;
        currentSettings.diaryTime = char.autoDiaryTime || '22:00';
        
        // 【关键修复】：正确从数据库读取用户设置的主动发消息数据
        currentSettings.activeMsgEnabled = char.activeMessageEnabled || false;
        currentSettings.activeMsgInterval = char.activeMessageInterval || '60';
        momentsToggle.checked = currentSettings.momentsEnabled;
        const freqRadio = document.querySelector(`#settings-moments input[value="${currentSettings.postFrequency}"]`);
        if (freqRadio) freqRadio.checked = true;

        diaryToggle.checked = currentSettings.diaryEnabled;
        timeDisplay.textContent = currentSettings.diaryTime;
        // 新增：加载主动发消息设置
        activeMsgToggle.checked = currentSettings.activeMsgEnabled;
        if (activeMsgIntervalInput) activeMsgIntervalInput.value = currentSettings.activeMsgInterval || '60';

        currentSettings.autoScheduleEnabled = char.autoScheduleEnabled || false;
        currentSettings.autoScheduleTarget = char.autoScheduleTarget || 'today';
        currentSettings.autoScheduleTime = char.autoScheduleTime || '08:00';
        autoScheduleToggle.checked = currentSettings.autoScheduleEnabled;
        const schedTargetRadio = document.querySelector(`#settings-auto-schedule input[value="${currentSettings.autoScheduleTarget}"]`);
        if (schedTargetRadio) schedTargetRadio.checked = true;
        if (autoScheduleTimeInput) autoScheduleTimeInput.value = currentSettings.autoScheduleTime;

        syncModuleState();
        initTimeRuler();
        
        modal.classList.add('visible');

        setTimeout(() => setupRulerInteraction(), 100);
    };

    const saveSettings = async () => {
        const charId = tempState.currentChatId;
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (!char) return;
         const frequencyInput = document.querySelector('#settings-moments input:checked');
        const frequency = frequencyInput ? frequencyInput.value : 'medium';
         // 新增：读取间隔设置(改为读取分钟数)
        const msgInterval = activeMsgIntervalInput ? activeMsgIntervalInput.value : '60';
        const followUpToggle = document.getElementById('chat-settings-follow-up-toggle');
        const followUpEnabled = followUpToggle ? followUpToggle.checked : char.followUpEnabled === true;
        
        const schedTargetInput = document.querySelector('#settings-auto-schedule input[name="auto-schedule-target"]:checked');
        const schedTarget = schedTargetInput ? schedTargetInput.value : 'today';
        const schedTime = autoScheduleTimeInput ? autoScheduleTimeInput.value : '08:00';
        
        // ▼▼▼ 极度严谨：只在从【关】切换到【开】的那一刻才重置零点，防止修改其他设置误伤计时 ▼▼▼
        let newStartTime = char.activeMessageStartTime || null; 
        if (!currentSettings.activeMsgEnabled && activeMsgToggle.checked) {
            newStartTime = Date.now(); // 只有真正从关变开，才记录全新起跑线
        } else if (!activeMsgToggle.checked) {
            newStartTime = null; // 开关关闭时，清空起跑线
        }
        if (!followUpEnabled) {
            await clearFollowUpPlan(charId);
        }
        if (!currentSettings.autoScheduleEnabled && autoScheduleToggle.checked) {
            const targetDate = new Date();
            if (schedTarget === 'tomorrow') targetDate.setDate(targetDate.getDate() + 1);
            const targetDay = targetDate.getDate().toString();
            const targetDateKey = getLocalDateKey(targetDate);
            const scheduleRecord = await db.appData.get('ls_schedules_data_' + charId);
            const todayKey = getLocalDateKey();
            const alreadyHasTarget = (scheduleRecord?.value || []).some(item => item.dateISO
                ? item.dateISO === targetDateKey
                : targetDateKey.slice(0, 7) === todayKey.slice(0, 7)
                    && targetDateKey <= todayKey
                    && String(item.date || '') === targetDay);
            if (alreadyHasTarget) localStorage.setItem(`last_auto_schedule_time_${charId}`, todayKey);
            else localStorage.removeItem(`last_auto_schedule_time_${charId}`);
            localStorage.removeItem(`auto_schedule_retry_${charId}_${todayKey}`);
        }
        await db.characterProfiles.update(charId, {
            activePostingEnabled: momentsToggle.checked,
            postFrequency: frequency,
            autoDiaryEnabled: diaryToggle.checked,
            autoDiaryTime: currentSettings.diaryTime,
            activeMessageEnabled: activeMsgToggle.checked, 
            activeMessageInterval: msgInterval,            
            activeMessageStartTime: newStartTime, // 记录开启时间
            followUpEnabled,
            followUpPlan: followUpEnabled ? (char.followUpPlan || null) : null,
            autoScheduleEnabled: autoScheduleToggle.checked,
            autoScheduleTarget: schedTarget,
            autoScheduleTime: schedTime
        });

        Object.assign(char, {
            activePostingEnabled: momentsToggle.checked,
            postFrequency: frequency,
            autoDiaryEnabled: diaryToggle.checked,
            autoDiaryTime: currentSettings.diaryTime,
            activeMessageEnabled: activeMsgToggle.checked, 
            activeMessageInterval: msgInterval,             
            activeMessageStartTime: newStartTime, // 记录开启时间
            followUpEnabled,
            followUpPlan: followUpEnabled ? (char.followUpPlan || null) : null,
            autoScheduleEnabled: autoScheduleToggle.checked,
            autoScheduleTarget: schedTarget,
            autoScheduleTime: schedTime
        });
        // ▲▲▲ 修改结束 ▲▲▲


        const statusText = document.getElementById('bg-activity-status-text');
        if (statusText) {
            const activeCount = (momentsToggle.checked ? 1 : 0) + (diaryToggle.checked ? 1 : 0) + (activeMsgToggle.checked ? 1 : 0) + (autoScheduleToggle.checked ? 1 : 0) + (followUpEnabled ? 1 : 0);
            statusText.textContent = activeCount > 0 ? `已开启 ${activeCount} 项` : '未配置';
        }

        showDynamicIsland('配置已保存');
        modal.classList.remove('visible');
    };

    triggerBtn.addEventListener('click', showModal);
    closeBtn.addEventListener('click', () => modal.classList.remove('visible'));
    saveBtn.addEventListener('click', saveSettings);
    momentsToggle.addEventListener('change', syncModuleState);
    diaryToggle.addEventListener('change', syncModuleState);
    activeMsgToggle.addEventListener('change', syncModuleState); // 新增监听
    autoScheduleToggle.addEventListener('change', syncModuleState);

    if (manualScheduleTestBtn) {
        manualScheduleTestBtn.addEventListener('click', async () => {
            modal.classList.remove('visible');
            const charId = tempState.currentChatId;
            if (charId && typeof window.triggerAutoScheduleTask === 'function') {
                showDynamicIsland('正在触发自动更新日程...', 'loading');
                window.triggerAutoScheduleTask(charId, true);
            } else {
                showDynamicIsland('功能尚未就绪', 'error');
            }
        });
    }

    if (manualTestBtn) {

        manualTestBtn.addEventListener('click', async () => {
            modal.classList.remove('visible');
                   const charId = tempState.currentChatId;
            if (charId) {
                import('./moments.js').then(m => {
                    // ✅ 修复：传入 false，明确告诉系统这是“手动强制执行”，无视冷却时间
                    m.momentsModule.triggerAiPostMoment(charId, false);
                }).catch(err => {
                    console.error("【模块加载失败】动态加载 'moments.js' 模块失败，请检查文件路径和服务器配置:", err);
                    showDynamicIsland('功能异常，请检查控制台');
                });
            }
        });
    }
    // 新增：测试发送主动消息按钮
    if (manualMsgTestBtn) {
        manualMsgTestBtn.addEventListener('click', async () => {
            modal.classList.remove('visible');
            const charId = tempState.currentChatId;
            if (charId) {
                showDynamicIsland('正在触发主动发消息...', 'loading');
                await triggerActiveMessage(charId);
            }
        });
    }

}


export { initBackgroundActivityModal };

/**
 * 【新增】设置动态上下文条数的弹窗逻辑
 */
function setupMomentsContextSettings() {
    const triggerBtn = document.getElementById('moments-context-trigger');
    const overlay = document.getElementById('moments-context-modal-overlay');
    const slider = document.getElementById('moments-context-slider');
    const valueDisplay = document.getElementById('moments-context-value');
    const doneBtn = document.getElementById('moments-context-modal-done');
    
    // 安全检查，防止报错
    if (!triggerBtn || !overlay || !slider || !valueDisplay || !doneBtn) return;

    // 打开弹窗
    const showModal = () => {
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (!char) return;
        
        // 读取当前值，默认为 0
        const currentValue = char.momentsContextLimit || 0;
        slider.value = currentValue;
        valueDisplay.textContent = currentValue === 0 ? '关闭' : currentValue;
        
        overlay.classList.add('visible');
    };

    // 保存并关闭
    const hideModalAndSave = async () => {
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (!char) return;

        const newValue = parseInt(slider.value, 10);
        // 保存到角色数据中，字段名叫 momentsContextLimit
        char.momentsContextLimit = newValue;
        
        // 保存数据库
        await optimizedSaveAndRender(); 
        
        // 刷新设置页面的显示文字
        renderChatSettingsPage();
        
        overlay.classList.remove('visible');
        
        const msg = newValue === 0 ? '动态上下文已关闭' : `将读取最近 ${newValue} 条动态`;
        showDynamicIsland(msg);
    };

    // 绑定事件
    triggerBtn.addEventListener('click', showModal);
    
    // 点击遮罩层关闭
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            hideModalAndSave();
        }
    });
    
    // 点击完成按钮
    doneBtn.addEventListener('click', hideModalAndSave);

    // 滑动滑块时实时更新数字
    slider.addEventListener('input', () => {
        const val = parseInt(slider.value, 10);
        valueDisplay.textContent = val === 0 ? '关闭' : val;
    });
}

function getForumLinkSettingsForChar(char = {}) {
    const settings = char.forumLinkSettings || {};
    const include = settings.include || {};
    return {
        enabled: settings.enabled !== false,
        publicExpireTurns: Math.max(1, Math.min(60, Number(settings.publicExpireTurns) || 12)),
        userPostLimit: Math.max(1, Math.min(20, Number(settings.userPostLimit) || 8)),
        selectedSpaceIds: Array.isArray(settings.selectedSpaceIds) ? settings.selectedSpaceIds.map(id => String(id)) : null,
        include: {
            dm: include.dm !== false,
            ownPosts: include.ownPosts !== false,
            userPosts: include.userPosts !== false,
            interactions: include.interactions !== false,
            trends: include.trends !== false,
            activeEvent: include.activeEvent !== false,
            eventHistory: include.eventHistory !== false
        }
    };
}

function estimateForumLinkTokens(value) {
    return Math.ceil(String(value || '').length / 1.6);
}

async function getForumLinkSpaceStates(char, settings = getForumLinkSettingsForChar(char)) {
    const Forum = await ensureForumForChatSettings();
    const spaces = Forum?.getChatLinkSpaces?.(char.id, { selectedSpaceIds: settings.selectedSpaceIds }) || [];
    return Promise.all(spaces.map(async space => {
        const seenAt = Number(Forum?.getContextSeenAt?.(space.id) || 0);
        if (!seenAt) return { ...space, remaining: null };
        const messagesAfterSeen = await db.chatMessages
            .where({ chatId: char.id })
            .filter(msg => {
                const time = msg.timestamp instanceof Date ? msg.timestamp.getTime() : new Date(msg.timestamp).getTime();
                return Number.isFinite(time) && time > seenAt;
            })
            .count();
        return { ...space, remaining: Math.max(0, settings.publicExpireTurns - Math.floor(messagesAfterSeen / 2)) };
    }));
}

async function getForumLinkRemainingTurns(char, settings = getForumLinkSettingsForChar(char)) {
    const states = await getForumLinkSpaceStates(char, settings);
    const opened = states.filter(space => space.remaining !== null);
    if (!opened.length) return null;
    return opened.reduce((max, space) => Math.max(max, space.remaining || 0), 0);
}

async function updateForumLinkDisplay(char) {
    const display = document.getElementById('current-forum-link-context-display');
    if (!display || !char) return;
    const settings = getForumLinkSettingsForChar(char);
    if (!settings.enabled) {
        display.textContent = '已关闭';
        display.style.color = 'var(--c-text-tertiary)';
        return;
    }
    const Forum = await ensureForumForChatSettings();
    const linkedSpaces = Forum?.getLinkedSpacesForCharacter?.(char.id) || [];
    if (!linkedSpaces.length) {
        display.textContent = '无关联论坛';
        display.style.color = 'var(--c-text-tertiary)';
        return;
    }
    if (Array.isArray(settings.selectedSpaceIds) && !settings.selectedSpaceIds.length) {
        display.textContent = '未选择论坛';
        display.style.color = 'var(--c-text-tertiary)';
        return;
    }
    const remaining = await getForumLinkRemainingTurns(char, settings);
    if (remaining === null) {
        display.textContent = '未打开论坛';
        display.style.color = 'var(--c-text-tertiary)';
        return;
    }
    display.textContent = remaining > 0 ? `剩 ${remaining} 轮` : '公开内容已过期';
    display.style.color = remaining > 0 ? 'var(--c-text-primary)' : 'var(--c-text-tertiary)';
}

function setupForumLinkContextSettings() {
    const triggerBtn = document.getElementById('forum-link-context-trigger');
    const overlay = document.getElementById('forum-link-context-modal-overlay');
    const closeBtn = document.getElementById('forum-link-context-close');
    const doneBtn = document.getElementById('forum-link-context-done');
    const enabledToggle = document.getElementById('forum-link-enabled-toggle');
    const expireSlider = document.getElementById('forum-link-expire-slider');
    const expireStatus = document.getElementById('forum-link-expire-status');
    const spaceList = document.getElementById('forum-link-space-list');
    const spaceSummary = document.getElementById('forum-link-space-summary');
    const totalToken = document.getElementById('forum-link-total-token');
    const partInputs = Array.from(document.querySelectorAll('[data-forum-link-part]'));
    if (!triggerBtn || !overlay || !closeBtn || !doneBtn || !enabledToggle || !expireSlider || !expireStatus || !spaceList || !spaceSummary || !totalToken || !partInputs.length) return;

    const getCurrentChar = () => AppState.characterProfiles.find(c => c.id === tempState.currentChatId);

    const getSelectedSpaceIds = () => Array.from(spaceList.querySelectorAll('[data-forum-link-space]:checked')).map(input => String(input.value));
    const escapeSelectorValue = value => window.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const renderSpaceOptions = async (char, settings) => {
        const Forum = await ensureForumForChatSettings();
        const linkedSpaces = Forum?.getLinkedSpacesForCharacter?.(char.id) || [];
        if (!linkedSpaces.length) {
            spaceList.innerHTML = '<div class="forum-link-empty-space">NO LINKED FORUM</div>';
            spaceSummary.textContent = '没有关联论坛';
            return;
        }
        const fallbackSpaces = Forum?.getChatLinkSpaces?.(char.id, { selectedSpaceIds: null }) || [];
        const defaultIds = Array.isArray(settings.selectedSpaceIds)
            ? settings.selectedSpaceIds.map(id => String(id))
            : fallbackSpaces.map(space => String(space.id));
        const selectedSet = new Set(defaultIds);
        spaceList.innerHTML = linkedSpaces.map(space => `
            <label class="forum-link-space-option">
                <input type="checkbox" data-forum-link-space value="${escapeHTML(String(space.id))}" ${selectedSet.has(String(space.id)) ? 'checked' : ''}>
                <span>
                    <b>${escapeHTML(space.name || '未命名论坛')}</b>
                    <small>${space.postCount || 0} posts · ${space.dmCount || 0} dm</small>
                </span>
                <em data-forum-space-status="${escapeHTML(String(space.id))}">WAIT</em>
            </label>
        `).join('');
        spaceList.querySelectorAll('[data-forum-link-space]').forEach(input => input.addEventListener('change', refreshPreview));
    };

    const refreshPreview = async () => {
        const char = getCurrentChar();
        if (!char) return;
        const include = {};
        partInputs.forEach(input => {
            include[input.dataset.forumLinkPart] = input.checked;
        });
        const settings = {
            ...getForumLinkSettingsForChar(char),
            enabled: enabledToggle.checked,
            publicExpireTurns: Number(expireSlider.value) || 12,
            selectedSpaceIds: getSelectedSpaceIds(),
            include
        };
        const Forum = await ensureForumForChatSettings();
        const spaceStates = await getForumLinkSpaceStates(char, settings);
        const activeSpaceIds = spaceStates.filter(space => (space.remaining || 0) > 0).map(space => space.id);
        const remaining = spaceStates.some(space => space.remaining !== null)
            ? spaceStates.reduce((max, space) => Math.max(max, space.remaining || 0), 0)
            : null;
        spaceStates.forEach(space => {
            const statusEl = spaceList.querySelector(`[data-forum-space-status="${escapeSelectorValue(space.id)}"]`);
            if (!statusEl) return;
            statusEl.textContent = space.remaining === null ? '未打开' : (space.remaining > 0 ? `剩 ${space.remaining} 轮` : '已过期');
            statusEl.classList.toggle('expired', space.remaining === 0);
        });
        const linkedSpaces = Forum?.getLinkedSpacesForCharacter?.(char.id) || [];
        spaceSummary.textContent = !linkedSpaces.length
            ? '没有关联论坛'
            : settings.selectedSpaceIds.length
            ? `${settings.selectedSpaceIds.length} 个已选择 · ${activeSpaceIds.length} 个生效中`
            : '未选择论坛';
        expireStatus.textContent = remaining === null
            ? `未打开论坛 · 悬挂 ${settings.publicExpireTurns} 轮`
            : (remaining > 0 ? `公开内容剩 ${remaining} 轮` : '公开内容已过期');

        const tokenMap = {};
        let total = 0;
        const sections = settings.enabled && activeSpaceIds.length
            ? await Forum?.getChatLinkSections?.(char.id, { userPostLimit: settings.userPostLimit, include: settings.include, selectedSpaceIds: activeSpaceIds }) || []
            : [];
        sections.forEach(section => {
            tokenMap[section.id] = (tokenMap[section.id] || 0) + estimateForumLinkTokens(section.text);
        });
        const dmItems = settings.enabled && settings.include.dm
            ? Forum?.getDmTimelineItems?.(char.id, { limit: Math.max(20, (char.contextTurns || 25) * 2), selectedSpaceIds: settings.selectedSpaceIds }) || []
            : [];
        tokenMap.dm = estimateForumLinkTokens(dmItems.map(item => item.raw?.text || item.raw?.sticker?.explanation || item.raw?.emoji || '').join('\n'));

        partInputs.forEach(input => {
            const key = input.dataset.forumLinkPart;
            const value = input.checked ? (tokenMap[key] || 0) : 0;
            total += value;
            const tokenEl = document.getElementById(`forum-link-token-${key}`);
            if (tokenEl) tokenEl.textContent = `~${value} tk`;
        });
        totalToken.textContent = `~${total} tk`;
    };

    const showModal = async () => {
        const char = getCurrentChar();
        if (!char) return;
        const settings = getForumLinkSettingsForChar(char);
        enabledToggle.checked = settings.enabled;
        expireSlider.value = settings.publicExpireTurns;
        partInputs.forEach(input => {
            input.checked = settings.include[input.dataset.forumLinkPart] !== false;
        });
        await renderSpaceOptions(char, settings);
        overlay.classList.add('visible');
        await refreshPreview();
    };

    let isForumLinkSaving = false;
    const saveAndClose = async () => {
        const char = getCurrentChar();
        if (!char) return;
        if (isForumLinkSaving) {
            overlay.classList.remove('visible');
            return;
        }
        isForumLinkSaving = true;
        const include = {};
        partInputs.forEach(input => {
            include[input.dataset.forumLinkPart] = input.checked;
        });
        char.forumLinkSettings = {
            enabled: enabledToggle.checked,
            publicExpireTurns: Number(expireSlider.value) || 12,
            userPostLimit: getForumLinkSettingsForChar(char).userPostLimit,
            selectedSpaceIds: getSelectedSpaceIds(),
            include
        };
        overlay.classList.remove('visible');
        try {
            await optimizedSaveAndRender();
            renderChatSettingsPage();
            showDynamicIsland(char.forumLinkSettings.enabled ? '论坛串联已更新' : '论坛串联已关闭');
        } catch (error) {
            console.error('Forum link settings save failed:', error);
            showDynamicIsland('论坛串联保存失败', {
                variant: 'error',
                detail: error?.message || '论坛串联设置保存失败',
                copyText: error?.stack || error?.message || '论坛串联保存失败'
            });
        } finally {
            isForumLinkSaving = false;
        }
    };

    triggerBtn.addEventListener('click', showModal);
    closeBtn.addEventListener('click', saveAndClose);
    doneBtn.addEventListener('click', saveAndClose);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) saveAndClose();
    });
    enabledToggle.addEventListener('change', refreshPreview);
    expireSlider.addEventListener('input', refreshPreview);
    partInputs.forEach(input => input.addEventListener('change', refreshPreview));
}
/**
 * 【修改】设置聊天背景相关功能的逻辑
 * 修复了因为 HTML 中缺少重置按钮导致整个功能报错不运行的问题
 */
function setupChatBackgroundSettings() {
    // 1. 获取所有元素
    const triggerBtn = document.getElementById('set-chat-background-btn');
    const choiceModal = document.getElementById('bg-choice-modal-overlay');
    const uploadBtn = document.getElementById('bg-choice-upload-btn');
    const urlBtn = document.getElementById('bg-choice-url-btn');
    // HTML里可能没有这个重置按钮，获取不到是正常的
    const resetBtn = document.getElementById('bg-choice-reset-btn'); 
    const cancelBtn = document.getElementById('bg-choice-cancel-btn');
    const fileInput = document.getElementById('chat-background-upload');
    const chatContentArea = document.querySelector('#page-chat-detail .chat-detail-content');
 const modeSelect = document.getElementById('bg-choice-mode-select');
    // ▼▼▼ 【修改点 1】: 在这里去掉了 !resetBtn 的检查，允许它不存在 ▼▼▼
    if (!triggerBtn || !choiceModal || !uploadBtn || !urlBtn || !cancelBtn || !fileInput || !chatContentArea) {
        console.error('聊天背景设置功能的部分元素未找到，功能可能无法正常使用。');
        return;
    }

    // 2. 一个通用的函数，用来保存背景并更新界面
    const applyAndSaveChanges = async (backgroundValue) => {
        const charId = tempState.currentChatId;
        if (!charId) return;
        try {
            const bgMode = modeSelect ? modeSelect.value : 'content';
            // 更新数据库
            await db.characterProfiles.update(charId, { chatBackground: backgroundValue, chatBgMode: bgMode  });
            // 更新内存中的状态
            const charInState = AppState.characterProfiles.find(c => c.id === charId);
            if (charInState) {
                charInState.chatBackground = backgroundValue;
                charInState.chatBgMode = bgMode; // 新增更新内存
            }
            // ▼▼▼ 新增：立刻应用到当前聊天界面 ▼▼▼
            let bgStyleTag = document.getElementById('dynamic-chat-bg-style');
            if (!bgStyleTag) {
                bgStyleTag = document.createElement('style');
                bgStyleTag.id = 'dynamic-chat-bg-style';
                document.head.appendChild(bgStyleTag);
            }
            
            if (backgroundValue) {
                if (bgMode === 'content') {
                    chatContentArea.style.backgroundImage = `url('${backgroundValue}')`;
                    chatContentArea.style.backgroundSize = 'cover';
                    chatContentArea.style.backgroundPosition = 'center';
                    bgStyleTag.innerHTML = '';
                } else {
                    chatContentArea.style.backgroundImage = 'none';
                    // 去掉 !important 才能让美化主题的背景覆盖它
                    let css = `
                        #page-chat-detail { background: url('${backgroundValue}') center / cover no-repeat; }
                        #page-chat-detail .chat-detail-content { background: transparent; }
                        #page-chat-detail .chat-detail-header { background: transparent; border: none; box-shadow: none; }
                        #page-chat-detail .chat-detail-header::after, #page-chat-detail .chat-detail-header::before { display: none; }
                    `;
                    if (bgMode === 'top_bottom') {
                        css += `#page-chat-detail .chat-input-container { background: transparent; border-top: none; box-shadow: none; }`;
                    } else {
                        css += `#page-chat-detail .chat-input-container { background: var(--c-bg-primary, #ffffff); }`;
                    }
                    bgStyleTag.innerHTML = css;

                }
            } else {
                chatContentArea.style.backgroundImage = 'none';
                bgStyleTag.innerHTML = '';
                document.getElementById('page-chat-detail').style.background = '';
            }
            // ▲▲▲ 新增结束 ▲▲▲
            
            showDynamicIsland(backgroundValue ? '聊天背景已更新' : '已恢复默认背景');

            choiceModal.classList.remove('visible'); 
        } catch (error) {
            console.error('保存聊天背景失败:', error);
            showDynamicIsland('设置失败，请重试', {
                variant: 'error',
                detail: error?.message || '聊天背景保存失败',
                copyText: error?.stack || error?.message || '设置失败，请重试'
            });
        }
    };
    
    // 3. 给各个按钮绑定点击事件
    triggerBtn.addEventListener('click', () => {
        const charId = tempState.currentChatId;
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (char && modeSelect) {
            modeSelect.value = char.chatBgMode || 'content';
        }
        choiceModal.classList.add('visible');
    });

    // 监听模式修改，实时保存并应用（无需关闭弹窗重新上传）
    if (modeSelect) {
        modeSelect.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char && char.chatBackground) {
                const bgMode = modeSelect.value;
                await db.characterProfiles.update(charId, { chatBgMode: bgMode });
                char.chatBgMode = bgMode;
                
                let bgStyleTag = document.getElementById('dynamic-chat-bg-style');
                if (!bgStyleTag) {
                    bgStyleTag = document.createElement('style');
                    bgStyleTag.id = 'dynamic-chat-bg-style';
                    document.head.appendChild(bgStyleTag);
                }
                
                if (bgMode === 'content') {
                    chatContentArea.style.backgroundImage = `url('${char.chatBackground}')`;
                    chatContentArea.style.backgroundSize = 'cover';
                    chatContentArea.style.backgroundPosition = 'center';
                    bgStyleTag.innerHTML = '';
                } else {
                    chatContentArea.style.backgroundImage = 'none';
                    let css = `
                        #page-chat-detail { background: url('${char.chatBackground}') center / cover no-repeat; }
                        #page-chat-detail .chat-detail-content { background: transparent; }
                        #page-chat-detail .chat-detail-header { background: transparent; border: none; box-shadow: none; }
                        #page-chat-detail .chat-detail-header::after, #page-chat-detail .chat-detail-header::before { display: none; }
                    `;
                    if (bgMode === 'top_bottom') {
                        css += `#page-chat-detail .chat-input-container { background: transparent; border-top: none; box-shadow: none; }`;
                    } else {
                        css += `#page-chat-detail .chat-input-container { background: var(--c-bg-primary, #ffffff); }`;
                    }
                    bgStyleTag.innerHTML = css;

                }
            }
        });
    }

    cancelBtn.addEventListener('click', () => {
        choiceModal.classList.remove('visible');
    });
    
    choiceModal.addEventListener('click', (e) => {
        if (e.target === choiceModal) {
            choiceModal.classList.remove('visible');
        }
    });

    uploadBtn.addEventListener('click', () => {
        fileInput.click(); 
    });

    urlBtn.addEventListener('click', () => {
        choiceModal.classList.remove('visible'); 
        showInputModal('输入图片链接 (URL)', '', async (url) => {
            if (url) {
                await applyAndSaveChanges(url);
            }
        });
    });

    // ▼▼▼ 【修改点 2】: 只有当 resetBtn 存在时才绑定事件，防止报错 ▼▼▼
    if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
            await applyAndSaveChanges(null); 
        });
    }
    
    // 4. 当用户选择了本地文件后
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (event) => {
            await applyAndSaveChanges(event.target.result);
        };
        reader.onerror = () => {
            showDynamicIsland('读取文件失败');
        };
        reader.readAsDataURL(file);
        fileInput.value = '';
    });
}

/**
 * 【新增】设置单个聊天数据导入/导出的功能
 */
function setupChatDataManagement() {
    // --- 1. 获取所有需要的元素 ---
    const triggerBtn = document.getElementById('chat-settings-import-export');
    const modalOverlay = document.getElementById('chat-data-modal-overlay');
    if (!triggerBtn || !modalOverlay) return;
    
    const closeBtn = document.getElementById('chat-data-modal-close-btn');
    const charNameDisplay = document.getElementById('chat-data-char-name');
    const exportBtn = document.getElementById('chat-data-export-btn');
    const importBtn = document.getElementById('chat-data-import-btn');
    const fileInput = document.getElementById('single-chat-import-input');
    const checkboxes = document.querySelectorAll('input[name="chat-data-type"]');

    // --- 2. 弹窗控制函数 ---
    const showModal = () => {
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (char) {
            charNameDisplay.textContent = char.name;
            modalOverlay.classList.add('visible');
        } else {
            showDynamicIsland('无法加载角色信息', 'error');
        }
    };
    const hideModal = () => modalOverlay.classList.remove('visible');
    // --- 3. 导出逻辑 (优化版：分段打包防止闪退) ---
    const handleExport = async (format = 'json') => {
        const charId = tempState.currentChatId;
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (!char) return;

        const selectedTypes = Array.from(checkboxes)
                                   .filter(cb => cb.checked)
                                   .map(cb => cb.value);

        if (selectedTypes.length === 0) {
            showDynamicIsland('请至少选择一项导出内容', 'error');
            return;
        }
        // ▼▼▼ 新增 TXT 格式小说风导出逻辑 ▼▼▼
        if (format === 'txt') {
            try {
                showDynamicIsland('正在整合时间线...', 'loading');
                
                const currentUser = getCurrentChatIdentity();
                // 优先使用当前会话专门设置的昵称/备注
                const charName = char.chatOverrideName || char.name;
                const myName = char.chatOverrideUserNickname || (currentUser ? currentUser.name : '我');

                const timeline = [];

                // 1. 获取线上对话
                if (selectedTypes.includes('messages')) {
                    await db.chatMessages.where({ chatId: charId }).each(msg => {
                        let content = msg.text || '';
                        if (msg.contentType === 'image') content = '[发送了一张图片]';
                        else if (msg.contentType === 'voice') content = '[发送了一段语音]';
                        else if (msg.contentType === 'file') content = '[发送了一个文件]';
                        else if (msg.contentType === 'transfer') content = `[发起了一笔转账: ¥${msg.transferInfo?.amount || '0.00'}]`;
                        else if (msg.callId && msg.contentType === 'voice_call_summary') content = `[通话记录摘要]\n${content}`;
                        else if (msg.callId) content = ''; // 隐藏通话中产生的碎片消息
                        
                        // 【核心修复】线上消息用 type 判断，兼容 sender
                        const isUser = msg.type === 'sent' || msg.sender === 'user';
                        const isSystem = msg.type === 'system' || msg.sender === 'system' || msg.type === 'date';
                        
                        // 过滤掉空的系统消息
                        if (!content.trim() && isSystem) return;

                        timeline.push({
                            time: msg.timestamp || 0,
                            dateStr: msg.timestamp ? new Date(msg.timestamp).toLocaleString('zh-CN', { hour12: false }) : '未知时间',
                            // 【适配群聊】: 优先读取具体发话人的名字 (msg.speakerName)，如果没有再用群名兜底
                            sender: isUser ? myName : (isSystem ? '系统提示' : (msg.speakerName || charName)),

                            type: '线上',
                            content: content
                        });
                    });
                }

                // 2. 获取线下陪伴
                if (selectedTypes.includes('offline')) {
                    await db.offlineMessages.where({ chatId: charId }).each(msg => {
                        // 线下消息用 sender 判断，兼容 type
                        const isUser = msg.sender === 'user' || msg.type === 'sent';
                        
                        timeline.push({
                            time: msg.timestamp || 0,
                            dateStr: msg.timestamp ? new Date(msg.timestamp).toLocaleString('zh-CN', { hour12: false }) : '未知时间',
                            sender: isUser ? myName : charName,
                            type: '线下',
                            content: msg.content || msg.text || ''
                        });
                    });
                }

                // 3. 获取核心记忆
                if (selectedTypes.includes('memory')) {
                    await db.importantMemories.where({ charId: charId }).each(item => {
                        let t = new Date(item.date).getTime();
                        if (isNaN(t)) t = 0;
                        timeline.push({
                            time: t,
                            dateStr: item.date || '未知时间',
                            sender: '记忆档案',
                            type: '核心',
                            content: `【${item.title}】\n${item.content}`
                        });
                    });

                    const pushMemoryProfileItem = (item, type, fallbackTime = 0) => {
                        const content = typeof item === 'string'
                            ? item
                            : (item?.content || item?.value || item?.summary || '');
                        if (!String(content).trim()) return;
                        const rawTime = item?.timestamp || item?.time || item?.date || fallbackTime;
                        let t = rawTime ? new Date(rawTime).getTime() : 0;
                        if (isNaN(t)) t = 0;
                        timeline.push({
                            time: t,
                            dateStr: t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '角色记忆档案',
                            sender: 'AI记忆档案',
                            type,
                            content
                        });
                    };

                    const memoryProfile = char.memoryProfile || {};
                    const longTerm = memoryProfile.long_term_memory || {};
                    if (longTerm.core_info && String(longTerm.core_info).trim()) {
                        timeline.push({
                            time: 0,
                            dateStr: '角色记忆档案',
                            sender: 'AI记忆档案',
                            type: '长期记忆',
                            content: String(longTerm.core_info).trim()
                        });
                    }
                    (longTerm.preferences || []).forEach(item => pushMemoryProfileItem(item, '偏好记忆'));
                    (longTerm.commitments || []).forEach(item => pushMemoryProfileItem(item, '约定记忆'));
                    (memoryProfile.short_term_memory || []).forEach(item => pushMemoryProfileItem(item, '近期记忆'));
                }

                // 4. 获取朋友圈动态
                if (selectedTypes.includes('moments')) {
                    await db.moments.filter(m => m.characterId === charId).each(item => {
                        timeline.push({
                            time: item.timestamp ? new Date(item.timestamp).getTime() : 0,
                            dateStr: item.timestamp ? new Date(item.timestamp).toLocaleString('zh-CN', { hour12: false }) : '未知时间',
                            sender: charName,
                            type: '动态',
                            content: item.content || '[分享了图片]'
                        });
                    });
                }

                // 5. 按时间戳从早到晚严格排序
                timeline.sort((a, b) => a.time - b.time);

                // 6. 渲染成文本流
                const lines = [];
                lines.push(`=============== 【与 ${charName} 的羁绊记录】 ===============\n`);
                lines.push(`导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}\n\n`);

                let lastDate = '';

                timeline.forEach(item => {
                    if (!item.content.trim()) return; 

                    // 提取日期部分用于分割天数
                    const currentDate = item.dateStr.split(' ')[0];
                    if (currentDate !== lastDate) {
                        lines.push(`\n--- 📅 ${currentDate} ---\n`);
                        lastDate = currentDate;
                    }

                    // 提取时间部分
                    const timeOnly = item.dateStr.includes(' ') ? item.dateStr.split(' ')[1] : item.dateStr;

                    // 根据不同类型给予不同的小说排版体验
                    if (item.sender === '系统提示') {
                        lines.push(`[${timeOnly}] 💡 ${item.content}\n`);
                    } else if (item.type === '核心' || item.type === '动态') {
                        lines.push(`[${timeOnly}] 📌 <${item.sender} - ${item.type}>\n${item.content}\n`);
                    } else {
                        // 聊天格式：[14:30] 线上 | 我：你好
                        lines.push(`[${timeOnly}] ${item.type} | ${item.sender}：\n${item.content}\n`);
                    }
                });

                // 7. 生成文件并触发下载
                const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
                const fileName = `${charName}_回忆录_${new Date().toISOString().slice(0, 10)}.txt`;
                
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                
                setTimeout(() => {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    showDynamicIsland('导出小说风 TXT 成功！', 'success');
                    hideModal();
                }, 1000);
            } catch (error) {
                console.error("导出 TXT 失败:", error);
                showDynamicIsland('导出失败', {
                    variant: 'error',
                    detail: error?.message || 'TXT 导出过程中发生错误',
                    copyText: error?.stack || error?.message || '导出失败'
                });
            }
            return; 
        }
        // ▲▲▲ 新增 TXT 逻辑结束 ▲▲▲

        showDynamicIsland('正在准备数据(优化模式)...', 'loading');
        
        const blobParts = [];
        const assetPool = {}; // 资源池：用于存放去重后的图片
        
        // 内部工具：将对象中的大图片提取到资源池
        const compressItem = (obj) => {
            if (!obj || typeof obj !== 'object') return obj;
            if (obj instanceof Date) return obj.toISOString(); // ◀◀◀ 仅仅插入这一行保护时间对象
            const newObj = Array.isArray(obj) ? [] : {};
            for (let key in obj) {

                let val = obj[key];
                if (typeof val === 'string' && val.startsWith('data:image/')) {
                    const hash = 'img_' + val.length + val.substring(val.length - 10); // 简单的唯一标识
                    assetPool[hash] = val;
                    newObj[key] = `ref:${hash}`; // 只存引用，不存本体
                } else if (typeof val === 'object') {
                    newObj[key] = compressItem(val);
                } else {
                    newObj[key] = val;
                }
            }
            return newObj;
        };

        try {

            // 1. 写入文件头信息
            const header = {
                dataType: 'Link-SingleChatBackup',
                version: '1.0',
                characterName: char.name,
                exportDate: new Date().toISOString()
            };
            blobParts.push(JSON.stringify(header).slice(0, -1) + ',"data":{');

            let isFirstField = true;

            // --- 修复后的导出拼接逻辑 ---
            const processBatchData = async (key, collection) => {
                if (!isFirstField) blobParts.push(','); 
                blobParts.push(`"${key}":[`); 
                
                let isFirstInArray = true;
                // 使用 Dexie 的 each 迭代器，逐条处理，不再手动切割字符串
                await collection.each(item => {
                    if (!isFirstInArray) {
                        blobParts.push(',');
                    }
                    // 修改这里：先压缩再转字符串
                    blobParts.push(JSON.stringify(compressItem(item)));
                    isFirstInArray = false;

                });
                
                blobParts.push(']'); 
                isFirstField = false;
            };
            // --- 修复结束 ---

            // 2. 分块处理各个数据表 (使用 collection 对象)
            if (selectedTypes.includes('messages')) {
                showDynamicIsland('正在打包聊天记录...', 'loading');
                // 这里不再直接 toArray()，而是传查询对象进去
                await processBatchData('messages', db.chatMessages.where({ chatId: charId }));
            }
            if (selectedTypes.includes('offline')) {
                showDynamicIsland('正在打包线下消息...', 'loading');
                await processBatchData('offline', db.offlineMessages.where({ chatId: charId }));
                await processBatchData('sessions', db.offlineSessions.where({ chatId: charId }));
            }
            if (selectedTypes.includes('memory')) {
                showDynamicIsland('正在打包记忆...', 'loading');
                await processBatchData('memory', db.importantMemories.where({ charId: charId }));
                // ▼ 新增：将角色的 AI 专属记忆档案一同打包装进文件
                if (!isFirstField) blobParts.push(',');
                blobParts.push(`"memoryProfile":${JSON.stringify(compressItem(char.memoryProfile || null))}`);
                isFirstField = false;
            }
            if (selectedTypes.includes('moments')) {
                showDynamicIsland('正在打包动态...', 'loading');
                // 使用 filter 获取 collection，避免一次性加载所有动态
                await processBatchData('moments', db.moments.filter(m => m.characterId === charId));
            }
                       // 3. 闭合 data 对象 }，然后写入 assets，最后闭合 root }
            blobParts.push(`},"assets":${JSON.stringify(assetPool)}}`);

            // 4. 生成文件并下载
            showDynamicIsland('正在生成文件...', 'loading');
            const blob = new Blob(blobParts, { type: 'application/json' });
            const fileName = `Link_${char.name}_backup_${new Date().toISOString().slice(0, 10)}.json`;
            
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none'; // 【新增】参考 manager，隐藏下载元素防止页面破坏
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            
            // 清理工作
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                showDynamicIsland('导出成功！', 'success');
                hideModal();
            }, 3000); // 【修改】参考 manager，把1000改成3000，给手机系统留出足够的响应时间启动下载！

        } catch (error) {
            console.error("导出失败:", error);
            showDynamicIsland('导出失败', {
                variant: 'error',
                detail: error?.message || '聊天备份导出过程中发生错误',
                copyText: error?.stack || error?.message || '导出失败'
            });
        }

    };


    // --- 4. 导入逻辑 ---
    const handleImport = async (file) => {
        if (!file) return;
        
        const charId = tempState.currentChatId;
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (!char) return;

        showDynamicIsland('正在解析文件...', 'loading');

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const importData = JSON.parse(e.target.result);

                // 验证文件类型
                if (importData.dataType !== 'Link-SingleChatBackup') {
                    throw new Error('文件类型不匹配，请选择正确的聊天备份文件。');
                }

                if (!confirm(`即将为角色 "${char.name}" 导入数据。这将覆盖此角色现有的同类型数据（例如，对话、记忆等）。\n\n数据来源: ${importData.characterName}\n\n确定要继续吗？`)) {
                    showDynamicIsland('导入已取消');
                    return;
                }

           showDynamicIsland('正在写入数据...', 'loading');
    const data = importData.data || {};
                  // --- 新的稳定导入逻辑开始 ---
            const processAndInsert = async (tableName, items, ownerId, idField = 'chatId') => {
                if (!items) return; // 允许空数组通过，以便执行下面的清空操作
                const table = db.table(tableName);
                 // 2. 分批写入 (参考 data-manager 优化：每批提升到 200 条，减少事务开启次数)
            const BATCH_SIZE = 200;
            for (let i = 0; i < items.length; i += BATCH_SIZE) {
                const chunk = items.slice(i, i + BATCH_SIZE);
                const readyBatch = chunk.map((item, index) => {
                    const { id, ...rest } = item; // 去掉旧ID，让数据库生成新ID
                    rest[idField] = ownerId;      // 确保绑定到当前角色
                     // 统一修复所有时间格式
                    ['timestamp', 'date', 'startTime', 'endTime'].forEach(field => {
                        if (rest[field]) {
                            const t = new Date(rest[field]);
                            if (!isNaN(t.getTime())) {
                                // ▼▼▼ 修改：如果是 date 字段保留原样，其他的转为纯数字时间戳
                                rest[field] = field === 'date' ? rest[field] : t.getTime(); 
                            } else {
                                // 兜底：遇到乱码时间，加上秒数偏移量错开它们，防碰撞
                                rest[field] = field === 'date' ? new Date().toISOString().split('T')[0] : Date.now() + index * 1000; 
                            }
                        } else if (field === 'timestamp' || field === 'startTime' || field === 'endTime') {
                            // 兜底：完全没写时间，同样加偏移量
                            rest[field] = Date.now() + index * 1000; // ▼▼▼ 修改：直接用纯数字
                        }
                    });

                    // 核心防错：防止老数据带有空的 sessionId 触发唯一索引冲突报错
                    if (rest.sessionId === "" || rest.sessionId === null) {
                        delete rest.sessionId;
                    }

                    return rest;
                });
                // 【极度关键】：从 bulkAdd 改为 bulkPut，遇到任何冲突直接智能覆盖，不再闪退报错！
                await table.bulkPut(readyBatch);
                
                // 【新增核心魔法】：参考 data-manager 加入停顿，让手机CPU喘口气，彻底防止写入时页面卡死或报错
                await new Promise(resolve => setTimeout(resolve, 0)); 
            }
        };

                      // --- 新增：资源还原逻辑 ---
            const assets = importData.assets || {};
            const decompressItem = (obj) => {
                if (!obj || typeof obj !== 'object') return obj;
                for (let key in obj) {
                    if (typeof obj[key] === 'string' && obj[key].startsWith('ref:')) {
                        const hash = obj[key].substring(4);
                        obj[key] = assets[hash] || obj[key];
                    } else if (typeof obj[key] === 'object') {
                        decompressItem(obj[key]);
                    }
                }
                return obj;
            };

            // 还原所有数据中的图片
            ['messages', 'offline', 'memory', 'moments', 'sessions'].forEach(key => {
                if (data[key]) data[key].forEach(item => decompressItem(item));
            });
            if (data.messages) {
                showDynamicIsland('恢复对话记录...', 'loading');
                await db.chatMessages.where({ chatId: charId }).delete(); // ◀◀◀ 新增清空
                await processAndInsert('chatMessages', data.messages, charId, 'chatId');
            }
            // 别忘了加上 sessions 表的写入触发
            if (data.sessions) {
                showDynamicIsland('恢复总结卡片...', 'loading');
                await db.offlineSessions.where({ chatId: charId }).delete(); // ◀◀◀ 新增清空
                await processAndInsert('offlineSessions', data.sessions, charId, 'chatId');
            }
            if (data.offline) {
                showDynamicIsland('恢复线下记录...', 'loading');
                await db.offlineMessages.where({ chatId: charId }).delete(); // ◀◀◀ 新增清空
                await processAndInsert('offlineMessages', data.offline, charId, 'chatId');
            }
            if (data.memory) {
                showDynamicIsland('恢复记忆档案...', 'loading');
                clearMemoryRuntimeCaches(charId);
                await db.importantMemories.where({ charId: charId }).delete(); // ◀◀◀ 新增清空
                await processAndInsert('importantMemories', data.memory, charId, 'charId');

                // ▼▼▼ 补充修复：必须同时清空角色档案上残留的文字记忆和轮数，否则AI大脑没被真正重置 ▼▼▼
                if (data.memoryProfile) decompressItem(data.memoryProfile); // ▼ 新增：解压资源池
                char.memoryProfile = data.memoryProfile || null; // ▼ 修改：将导出的AI记忆恢复给角色
                char.turnCounter = 0;
                await optimizedSaveAndRender();
                // ▲▲▲ 补充修复结束 ▲▲▲
            }
             // --- 新的稳定导入逻辑结束 ---
                // 【核心修复】：必须先清空该角色的旧动态，做到真正的“完全覆盖”！
                if (data.moments) {
                    showDynamicIsland('覆盖角色动态...', 'loading');
                    // 1. 彻底删除当前角色在手机里的所有旧动态，解决“旧数据还在”的问题
                    await db.moments.where('characterId').equals(charId).delete();
                    
                    if (data.moments.length > 0) {
                        // 2. 准备新的动态数据
                        const readyMoments = data.moments.map((m, index) => {

                        const { id, ...rest } = m; // 剥离旧ID，避免合并报错
                        rest.characterId = charId; // 强制绑定到当前角色
                         // 顺手兜底可能损坏的时间
                        if (rest.timestamp) {
                            const t = new Date(rest.timestamp);
                            if (!isNaN(t.getTime())) {
                                rest.timestamp = t.getTime(); // ▼▼▼ 修改：提取纯数字
                            } else {
                                rest.timestamp = Date.now() + index * 1000; // ▼▼▼ 修改：纯数字
                            }
                        } else {
                            rest.timestamp = Date.now() + index * 1000; // ▼▼▼ 修改：纯数字
                        }
                        return rest;

                    });
                                     // 3. 使用 bulkPut 安全写入
                        await db.moments.bulkPut(readyMoments);
                    }
                }

                showDynamicIsland('导入成功！正在刷新...', 'success');

                // 刷新当前聊天界面
                await loadAndRenderChatHistory(charId, true);
                hideModal();

            } catch (error) {
                console.error("导入失败:", error);
                showDynamicIsland('导入失败', {
                    variant: 'error',
                    detail: error?.message || '导入文件可能已损坏',
                    copyText: error?.stack || error?.message || '导入失败'
                });
            } finally {
                fileInput.value = ''; // 清空选择，以便下次还能选同一个文件
            }
        };
        reader.readAsText(file);
    };
    // --- 5. 绑定事件 ---
    triggerBtn.addEventListener('click', showModal);
    closeBtn.addEventListener('click', hideModal);
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) hideModal();
    });

    // ▼▼▼ 新增：格式选择弹窗的事件控制 ▼▼▼
    const formatModalOverlay = document.getElementById('export-format-modal-overlay');
    const formatCloseBtn = document.getElementById('export-format-close-btn');
    const formatOptions = formatModalOverlay ? formatModalOverlay.querySelectorAll('.delete-option-item') : [];

    // 点击主面板的"导出"时，先检查是否勾选，然后弹格式选择
    exportBtn.addEventListener('click', () => {
        const selectedTypes = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.value);
        if (selectedTypes.length === 0) {
            showDynamicIsland('请至少选择一项导出内容', 'error');
            return;
        }
        if (formatModalOverlay) formatModalOverlay.classList.add('visible');
    });

    if (formatCloseBtn) {
        formatCloseBtn.addEventListener('click', () => formatModalOverlay.classList.remove('visible'));
    }
    
    if (formatModalOverlay) {
        formatModalOverlay.addEventListener('click', (e) => {
            if (e.target === formatModalOverlay) formatModalOverlay.classList.remove('visible');
        });
        
        // 点击具体格式时，执行真实的导出
        formatOptions.forEach(opt => {
            opt.addEventListener('click', () => {
                const format = opt.dataset.format;
                formatModalOverlay.classList.remove('visible');
                handleExport(format);
            });
        });
    }
    // ▲▲▲ 修改结束 ▲▲▲

    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => handleImport(e.target.files[0]));
}

/* 
 * ==========================================================================
 *   ▼▼▼ 【更新】会话形象与备注设置逻辑 (含重置与用户昵称) ▼▼▼
 * ==========================================================================
 */
function setupAvatarRefineSettings() {
    const trigger = document.getElementById('chat-settings-avatar-settings');
    const modal = document.getElementById('modal-avatar-settings');
    if (!trigger || !modal) return;

    const cancelBtn = document.getElementById('btn-cancel-avatar-settings');
    const saveBtn = document.getElementById('btn-save-avatar-settings');
    const resetBtn = document.getElementById('btn-reset-avatar-settings'); // 新增重置按钮
    
    const previewChar = document.getElementById('preview-char-avatar');
    const inputCharFile = document.getElementById('input-char-avatar');
    const inputRemark = document.getElementById('input-char-remark');
    
    const previewUser = document.getElementById('preview-user-avatar');
    const inputUserFile = document.getElementById('input-user-avatar');
    const inputUserNickname = document.getElementById('input-user-nickname'); // 新增用户昵称输入

    // 临时数据
    let tempData = {
        charAvatar: null,
        userAvatar: null,
        charName: '',
        userNickname: ''
    };

    // 1. 打开弹窗：读取数据
    const openModal = () => {
        const charId = tempState.currentChatId;
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (!char) return;

        // 获取当前全局用户身份
        const currentIdentityId = char.chatIdentityId || AppState.currentIdentityId;
        const currentUser = AppState.userIdentities.find(id => id.id === currentIdentityId) || AppState.userIdentities[0];

        // --- 逻辑：优先读 chatOverride，没有则读原始数据 ---
        
        // 角色数据
        tempData.charAvatar = char.chatOverrideAvatar || char.avatar || DEFAULT_AVATAR_SRC;
        tempData.charName = char.chatOverrideName || ''; // 备注默认为空(显示placeholder) 或 之前设置的

        // 用户数据
        tempData.userAvatar = char.chatOverrideUserAvatar || currentUser.avatar || DEFAULT_AVATAR_SRC;
        tempData.userNickname = char.chatOverrideUserNickname || ''; // 用户昵称默认为空

        // --- 更新 UI ---
        previewChar.src = tempData.charAvatar;
        inputRemark.value = tempData.charName;
        
        previewUser.src = tempData.userAvatar;
        inputUserNickname.value = tempData.userNickname; // 填充用户昵称

        modal.classList.add('visible');
    };

    // 2. 关闭弹窗
    const closeModal = () => {
        modal.classList.remove('visible');
        inputCharFile.value = '';
        inputUserFile.value = '';
    };

    // 3. 应用修改 (保存)
    const saveSettings = async () => {
        const charId = tempState.currentChatId;
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (!char) return;

        // 写入数据到角色对象
        char.chatOverrideAvatar = tempData.charAvatar;
        char.chatOverrideName = tempData.charName;
        char.chatOverrideUserAvatar = tempData.userAvatar;
        char.chatOverrideUserNickname = tempData.userNickname; // 保存用户昵称
        tempState.pendingAvatarVision = true; // 【新增】开启头像识别触发器
        // 写入数据库
        await optimizedSaveAndRender(); 
        
        // 强制刷新：重新加载聊天界面，确保头像和名字立刻变化
        import('./chat-ui.js').then(module => {
             // 这里的 true 参数代表强制重新渲染，不使用缓存
             module.loadAndRenderChatHistory(charId, true);
        });
        
        // 刷新设置页面的头像显示
        renderChatSettingsPage();

        closeModal();
        showDynamicIsland('设置已应用');
    };

    // 4. 恢复默认 (重置)
    const resetSettings = async () => {
        if(!confirm('确定要恢复为默认头像和昵称吗？')) return;

        const charId = tempState.currentChatId;
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (!char) return;

        // 删除 override 字段
        delete char.chatOverrideAvatar;
        delete char.chatOverrideName;
        delete char.chatOverrideUserAvatar;
        delete char.chatOverrideUserNickname;
        tempState.pendingAvatarVision = true;
        await optimizedSaveAndRender();

        // 刷新聊天界面
        import('./chat-ui.js').then(module => {
             module.loadAndRenderChatHistory(charId, true);
        });
        renderChatSettingsPage();

        closeModal();
        showDynamicIsland('已恢复默认');
    };

    // 5. 文件处理
    const handleFileSelect = (fileInput, previewImg, key) => {
        const file = fileInput.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                const res = e.target.result;
                previewImg.src = res;
                tempData[key] = res;
            };
            reader.readAsDataURL(file);
        }
    };

    // --- 绑定事件 ---
    trigger.addEventListener('click', openModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if(e.target === modal) closeModal(); });
    
    // 保存和重置
    saveBtn.addEventListener('click', saveSettings);
    resetBtn.addEventListener('click', resetSettings);

    // 点击头像触发上传
    document.getElementById('char-avatar-wrapper').addEventListener('click', () => inputCharFile.click());
    document.getElementById('user-avatar-wrapper').addEventListener('click', () => inputUserFile.click());

    // 监听输入变化
    inputCharFile.addEventListener('change', () => handleFileSelect(inputCharFile, previewChar, 'charAvatar'));
    inputUserFile.addEventListener('change', () => handleFileSelect(inputUserFile, previewUser, 'userAvatar'));
    inputRemark.addEventListener('input', (e) => tempData.charName = e.target.value.trim());
    inputUserNickname.addEventListener('input', (e) => tempData.userNickname = e.target.value.trim());
}

/**
 * 【新增】视频通话壁纸设置逻辑
 */
function setupVideoWallpaperSettings() {
    // 1. 获取元素
    const triggerBtn = document.getElementById('chat-settings-video-bg-btn');
    const modalOverlay = document.getElementById('video-wallpaper-modal-overlay');
    const closeBtn = document.getElementById('close-video-wallpaper-btn');
    const saveBtn = document.getElementById('save-video-wallpaper-btn');
const dynamicToggle = document.getElementById('video-dynamic-bg-toggle');
    // 预览图元素
    const imgUser = document.getElementById('video-wp-img-user');
    const imgChar = document.getElementById('video-wp-img-char');

    // 按钮元素 (上传/重置/URL)
    const btnUploadUser = document.getElementById('btn-upload-user-wp');
    const btnUploadChar = document.getElementById('btn-upload-char-wp');
    const btnResetUser = document.getElementById('btn-reset-user-wp');
    const btnResetChar = document.getElementById('btn-reset-char-wp');
    const btnUrlUser = document.getElementById('btn-url-user-wp');
    const btnUrlChar = document.getElementById('btn-url-char-wp');

    // 隐藏 Input
    const fileInputUser = document.getElementById('file-input-video-wp-user');
    const fileInputChar = document.getElementById('file-input-video-wp-char');

    if (!triggerBtn || !modalOverlay) return;

    // 临时状态，用于存储未保存的修改
    let tempWallpapers = { user: null, char: null };

    // --- 辅助：获取默认头像 ---
    const getDefaults = () => {
        const charId = tempState.currentChatId;
        const char = AppState.characterProfiles.find(c => c.id === charId);
        const currentIdentity = getCurrentChatIdentity(); // 获取当前用户身份
        
        return {
            // 用户默认：优先使用在此聊天中设置的用户头像 -> 当前身份头像 -> 默认头像
            user: (char && char.chatOverrideUserAvatar) ? char.chatOverrideUserAvatar : (currentIdentity ? currentIdentity.avatar : DEFAULT_AVATAR_SRC),
            // 角色默认：优先使用在此聊天中设置的角色头像 -> 角色本身头像 -> 默认头像
            char: (char && char.chatOverrideAvatar) ? char.chatOverrideAvatar : (char ? char.avatar : DEFAULT_AVATAR_SRC)
        };
    };
    // --- 2. 打开弹窗逻辑 ---
    const openModal = () => {
        const charId = tempState.currentChatId;
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (!char) return;

        // ▼▼▼ 新增：先读取该角色现有的所有壁纸配置，防止覆盖未修改的人 ▼▼▼
        if (char.videoWallpapers) {
            Object.assign(tempWallpapers, char.videoWallpapers);
        }
        // ▲▲▲ 新增结束 ▲▲▲

        const defaults = getDefaults();
              // 渲染预览图：如果有设置就用设置的，没有就用默认的
        imgUser.src = tempWallpapers.user || defaults.user;
        
        // ▼▼▼ 新增：为群聊注入左右滑动的成员独立设置视图 ▼▼▼
        const charColumn = imgChar.closest('.wallpaper-column');
        
        // 【核心修复】防止 Flexbox 子元素因为内部滑动容器过宽而被无限撑大，解决盒子尺寸失控变巨大的问题
        if (charColumn) charColumn.style.minWidth = '0'; 
        
        let sliderContainer = document.getElementById('video-wp-group-slider');
        
        if (char.isGroup) {
            // 1. 隐藏单聊用的默认单一操作区，并修改标题
            document.getElementById('preview-box-char').style.display = 'none';
            document.getElementById('btn-reset-char-wp').parentElement.style.display = 'none';
            if (charColumn.querySelector('.column-title')) {
                charColumn.querySelector('.column-title').textContent = '群成员 (左右滑动)';
            }
            
            // 2. 创建或重置滑动容器
            if (!sliderContainer) {
                sliderContainer = document.createElement('div');
                sliderContainer.id = 'video-wp-group-slider';
                // 开启横向滚动与卡片捕捉，保证丝滑手感
                sliderContainer.style.cssText = 'display: flex; overflow-x: auto; gap: 15px; padding-bottom: 10px; width: 100%; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; scrollbar-width: none;';
                
                // 隐藏原生滚动条
                const style = document.createElement('style');
                style.textContent = '#video-wp-group-slider::-webkit-scrollbar { display: none; }';
                document.head.appendChild(style);

                charColumn.appendChild(sliderContainer);
            }
            sliderContainer.style.display = 'flex';
            sliderContainer.innerHTML = '';
            
            // 3. 取出所有成员并逐一生成配置卡片
            const members = (char.memberIds || []).map(id => AppState.characterProfiles.find(c => String(c.id) === String(id))).filter(Boolean);
            members.forEach(m => {
                const memberBox = document.createElement('div');
                memberBox.style.cssText = 'flex: 0 0 100%; scroll-snap-align: center; display: flex; flex-direction: column; align-items: center; position: relative;';
                
                // 成员名字浮签
                const memberTitle = document.createElement('div');
                memberTitle.style.cssText = 'font-size: 13px; font-weight: 600; margin-bottom: 8px; color: #555; background: rgba(255,255,255,0.85); backdrop-filter: blur(5px); padding: 4px 12px; border-radius: 12px; position: absolute; top: 10px; z-index: 10; box-shadow: 0 2px 8px rgba(0,0,0,0.1); pointer-events: none;';
                memberTitle.textContent = m.name;
                
                // 预览框 (明确赋予类名，并加上强制的行内样式确保尺寸绝对稳定不变形)
                const previewBox = document.createElement('div');
                previewBox.className = 'wallpaper-preview-box';
                previewBox.style.cssText = 'width: 100%; aspect-ratio: 9/16; background: #eee; border-radius: 12px; overflow: hidden; position: relative; border: 1px solid #e0e0e0;';
                
                const mImg = document.createElement('img');
                mImg.src = tempWallpapers[m.id] || m.avatar || DEFAULT_AVATAR_SRC;
                mImg.style.cssText = 'width: 100%; height: 100%; object-fit: cover; display: block;';
                
                // 悬浮上传按钮层
                const overlay = document.createElement('div');
                overlay.className = 'overlay-controls';
                // 使用行内样式强制兜底，确保遮罩层完美贴合
                overlay.style.cssText = 'position: absolute; inset: 0; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s; cursor: pointer;';
                
                // 鼠标交互显示/隐藏遮罩
                previewBox.onmouseenter = () => overlay.style.opacity = '1';
                previewBox.onmouseleave = () => overlay.style.opacity = '0';

                const upBtn = document.createElement('button');
                upBtn.className = 'btn-icon-upload';
                upBtn.style.cssText = 'width: 40px; height: 40px; border-radius: 50%; background: rgba(255,255,255,0.9); border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; color: #333;';
                upBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>';
                
                // 绑定上传逻辑
                overlay.onclick = (e) => {
                    e.stopPropagation();
                    const tempInput = document.createElement('input');
                    tempInput.type = 'file';
                    tempInput.accept = 'image/*';
                    tempInput.onchange = (event) => {
                        const file = event.target.files[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = (resEvt) => {
                            const res = resEvt.target.result;
                            tempWallpapers[m.id] = res; // 独立绑定到对应成员ID
                            mImg.src = res;
                        };
                        reader.readAsDataURL(file);
                    };
                    tempInput.click();
                };
                
                overlay.appendChild(upBtn);
                previewBox.appendChild(mImg);
                previewBox.appendChild(overlay);
                
                // 底部两枚辅助按钮
                const actionsDiv = document.createElement('div');
                actionsDiv.className = 'column-actions';
                actionsDiv.style.cssText = 'display: flex; gap: 10px; margin-top: 10px;';
                
                const resetBtn = document.createElement('button');
                resetBtn.className = 'btn-text-action';
                resetBtn.textContent = '恢复默认';
                resetBtn.style.cssText = 'background: none; border: none; font-size: 11px; color: #3a3a3a; cursor: pointer; padding: 4px;';
                resetBtn.onclick = () => {
                    tempWallpapers[m.id] = null;
                    mImg.src = m.avatar || DEFAULT_AVATAR_SRC;
                };
                
                const urlBtn = document.createElement('button');
                urlBtn.className = 'btn-text-action';
                urlBtn.textContent = '网络链接';
                urlBtn.style.cssText = 'background: none; border: none; font-size: 11px; color: #3a3a3a; cursor: pointer; padding: 4px;';
                urlBtn.onclick = () => {
                    if (typeof showInputModal === 'function') {
                        showInputModal('输入图片链接', 'https://...', (url) => {
                            if (url) {
                                tempWallpapers[m.id] = url;
                                mImg.src = url;
                            }
                        });
                    } else {
                        const url = prompt("请输入图片链接：", "https://...");
                        if (url) {
                            tempWallpapers[m.id] = url;
                            mImg.src = url;
                        }
                    }
                };
                
                actionsDiv.appendChild(resetBtn);
                actionsDiv.appendChild(urlBtn);
                
                // 组装并插入
                memberBox.appendChild(memberTitle);
                memberBox.appendChild(previewBox);
                memberBox.appendChild(actionsDiv);
                
                sliderContainer.appendChild(memberBox);
            });
        } else {
            // 恢复单聊情况
            if (sliderContainer) sliderContainer.style.display = 'none';
            document.getElementById('preview-box-char').style.display = '';
            document.getElementById('btn-reset-char-wp').parentElement.style.display = 'flex';
            if (charColumn && charColumn.querySelector('.column-title')) {
                charColumn.querySelector('.column-title').textContent = '对方 (角色)';
            }
            imgChar.src = tempWallpapers.char || defaults.char;
        }
        // ▲▲▲ 新增结束 ▲▲▲

if (dynamicToggle) {

            // 默认为 false (关闭)，防止乱变背景
            dynamicToggle.checked = char.dynamicVideoBg || false;
        }
        modalOverlay.classList.add('visible');
    };

    const closeModal = () => modalOverlay.classList.remove('visible');

    // --- 3. 核心操作逻辑 ---
    
    // 助手函数：判断当前在操作哪个角色的壁纸
    const getTargetType = () => {
        const charId = tempState.currentChatId;
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (char && char.isGroup) {
            const memberSelect = document.getElementById('video-wp-member-select');
            return memberSelect ? memberSelect.value : 'char';
        }
        return 'char';
    };

    // 处理文件选择
    const handleFile = (file, type) => {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            const res = e.target.result;
            const actualType = type === 'user' ? 'user' : getTargetType();
            tempWallpapers[actualType] = res; // 精确存入对应角色的ID或'char'
            if (type === 'user') imgUser.src = res;
            else imgChar.src = res;
        };
        reader.readAsDataURL(file);
    };

    // 处理恢复默认
    const handleReset = (type) => {
        const actualType = type === 'user' ? 'user' : getTargetType();
        tempWallpapers[actualType] = null;
        if (type === 'user') {
            imgUser.src = getDefaults().user;
        } else {
            const charId = tempState.currentChatId;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (char && char.isGroup && actualType !== 'char') {
                const member = AppState.characterProfiles.find(c => c.id === actualType);
                imgChar.src = member ? member.avatar : DEFAULT_AVATAR_SRC;
            } else {
                imgChar.src = getDefaults().char;
            }
        }
    };

    // 处理URL输入
    const handleUrl = (type) => {
        showInputModal('输入图片链接', 'https://...', (url) => {
            if (url) {
                const actualType = type === 'user' ? 'user' : getTargetType();
                tempWallpapers[actualType] = url;
                if (type === 'user') imgUser.src = url;
                else imgChar.src = url;
            }
        });
    };

    // --- 4. 绑定事件 ---

    triggerBtn.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => { if(e.target === modalOverlay) closeModal(); });

    // 用户侧操作
    btnUploadUser.addEventListener('click', () => fileInputUser.click());
    fileInputUser.addEventListener('change', (e) => handleFile(e.target.files[0], 'user'));
    btnResetUser.addEventListener('click', () => handleReset('user'));
    btnUrlUser.addEventListener('click', () => handleUrl('user'));

    // 角色侧操作
    btnUploadChar.addEventListener('click', () => fileInputChar.click());
    fileInputChar.addEventListener('change', (e) => handleFile(e.target.files[0], 'char'));
    btnResetChar.addEventListener('click', () => handleReset('char'));
    btnUrlChar.addEventListener('click', () => handleUrl('char'));
    // --- 5. 保存 ---
    saveBtn.addEventListener('click', async () => {
        const charId = tempState.currentChatId;
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (!char) return;

        // ▼▼▼ 修改：兼容合并群聊与单聊所有角色的壁纸设置 ▼▼▼
        if (!char.videoWallpapers) char.videoWallpapers = {};
        
        // 1. 保存自己(user)和单聊对象(char)
        if (tempWallpapers.user !== undefined) char.videoWallpapers.user = tempWallpapers.user;
        if (tempWallpapers.char !== undefined) char.videoWallpapers.char = tempWallpapers.char;
        
        // 2. 遍历并保存群聊里每个被修改过的独立角色ID的壁纸
        for (let key in tempWallpapers) {
            if (key !== 'user' && key !== 'char' && tempWallpapers[key] !== undefined) {
                if (tempWallpapers[key] === null) {
                    delete char.videoWallpapers[key]; // 如果点击了恢复默认，则删除该键值
                } else {
                    char.videoWallpapers[key] = tempWallpapers[key];
                }
            }
        }
        // ▲▲▲ 修改结束 ▲▲▲

if (dynamicToggle) {

            char.dynamicVideoBg = dynamicToggle.checked;
        }
        // 保存数据库
        await optimizedSaveAndRender();
        
        showDynamicIsland('通话壁纸已更新');
        closeModal();
    });
}
/**
 * 自定义精简聊天记录逻辑
 */
function setupPartialDeleteLogic() {
    const triggerBtn = document.getElementById('chat-settings-partial-delete-btn');
    const overlay = document.getElementById('partial-delete-modal-overlay');
    const confirmBtn = document.getElementById('partial-delete-confirm-btn');
    const cancelBtn = document.getElementById('partial-delete-cancel-btn');
    const closeX = document.getElementById('partial-delete-close-x');
    const input = document.getElementById('partial-delete-input');
    const countDisplay = document.getElementById('partial-delete-total-count');

    if (!triggerBtn || !overlay) return;
    // 打开弹窗并计算当前聊天总数
    triggerBtn.addEventListener('click', () => { // 【改动1】去掉了这里的 async
        const charId = tempState.currentChatId;
        if (!charId) return;
        
        // 【核心优化】先让UI瞬间反应：清空输入框，显示提示文字，立刻把弹窗弹出来
        countDisplay.textContent = '计算中...';
        input.value = ''; 
        overlay.classList.add('visible');

        // 【异步分离】利用 setTimeout 把耗时的数据库筛选推迟 50 毫秒执行，完美避开弹窗动画的卡顿期
        setTimeout(async () => {
            try {
                const total = await db.chatMessages
                    .where({ chatId: charId })
                    .filter(msg => !msg.callId || msg.contentType === 'voice_call_summary')
                    .count();
                // 算完后再悄悄把数字更新上去
                countDisplay.textContent = total;
            } catch (err) {
                console.error("统计条数失败:", err);
                countDisplay.textContent = '获取失败';
            }
        }, 50);
    });

    const hideModal = () => overlay.classList.remove('visible');
    [cancelBtn, closeX].forEach(btn => btn?.addEventListener('click', hideModal));

    // 执行删除逻辑
    confirmBtn.addEventListener('click', async () => {
        const charId = tempState.currentChatId;
        const deleteCount = parseInt(input.value);
        if (isNaN(deleteCount) || deleteCount <= 0) {
            showDynamicIsland('请输入有效的删除数量', 'error');
            return;
        }

        // 【优化1】直接使用弹窗上算好的"可见总条数"作为标准，拒绝包含隐藏碎片的偏差
        const visibleTotalStr = countDisplay.textContent;
        const visibleTotal = parseInt(visibleTotalStr);
        if (isNaN(visibleTotal)) {
            showDynamicIsland('请等待总条数计算完成', 'error');
            return;
        }

        if (deleteCount > visibleTotal) {
            showDynamicIsland('删除数量不能超过当前可见总消息数', 'error');
            return;
        }

        if (deleteCount === visibleTotal) {
            if (!confirm(`您输入的数量等于所有可见记录，此操作将完全清空聊天历史，确定继续吗？`)) return;
        } else {
            if (!confirm(`确定要永久删除最早的 ${deleteCount} 条记录吗？`)) return;
        }

        showDynamicIsland('正在精简数据库...', 'loading');
        try {
            const idsToDelete = new Set();
            const callIdsToDelete = new Set();
            let count = 0;
            const pendingCallFragments = new Map(); // 用于暂存扫描到的隐藏通话碎片
            const BreakException = {}; // 新增：专用于秒切断数据库遍历的异常信号

            try {
                // 【彻底干掉导致 Safari 卡死的“全表二次扫描”，在一次遍历中处理碎片】
                await db.chatMessages
                    .where('chatId').equals(charId)
                    // 【优化2】弃用不稳定的 until，在内部严格判断并瞬间掐断循环
                    .each(msg => {
                        if (count >= deleteCount) {
                            throw BreakException; 
                        }
                    if (msg.callId) {

                        if (msg.contentType === 'voice_call_summary') {
                            // 这是一个可见的通话总结卡片
                            if (count < deleteCount) {
                                idsToDelete.add(msg.id);
                                callIdsToDelete.add(msg.callId);
                                count++;
                                // 顺便把之前暂存的该通话碎片全部塞进删除列表
                                const fragments = pendingCallFragments.get(msg.callId);
                                if (fragments) {
                                    fragments.forEach(id => idsToDelete.add(id));
                                    pendingCallFragments.delete(msg.callId); // 释放内存
                                }
                            }
                        } else {
                            // 这是一个不可见的通话碎片
                            if (callIdsToDelete.has(msg.callId)) {
                                idsToDelete.add(msg.id); // 如果总结卡片已经确认删了，直接加进去
                            } else {
                                // 总结卡片还没扫到，先暂存到“记事本”里
                                if (!pendingCallFragments.has(msg.callId)) {
                                    pendingCallFragments.set(msg.callId, []);
                                }
                                pendingCallFragments.get(msg.callId).push(msg.id);
                            }
                        }
                    } else {
                        // 正常的可见消息
                        if (count < deleteCount) {
                            idsToDelete.add(msg.id);
                            count++;
                        }
                    }
                });
            } catch (e) {
                // 新增：如果是我们主动抛出的中断信号就平安忽略，如果真是别的系统错误就抛给外层
                if (e !== BreakException) throw e;
            }

            // 【修改点2】苹果内存深度优化：把庞大的删除任务切块，每次只删500条，中途休息30毫秒防闪退
            const idArray = Array.from(idsToDelete);

            const BATCH_SIZE = 500;
            for (let i = 0; i < idArray.length; i += BATCH_SIZE) {
                const batch = idArray.slice(i, i + BATCH_SIZE);
                await db.chatMessages.bulkDelete(batch);
                // 停顿30毫秒，给苹果系统留出时间去清理内存垃圾
                await new Promise(resolve => setTimeout(resolve, 30));
            }
            if (deleteCount === visibleTotal) {
                await clearFriendRequestDataForCharacters(charId);
            }

            showDynamicIsland('精简完成', 'success');
            hideModal();

            // 3. 如果当前正在聊天页，刷新页面显示
            import('./chat-ui.js').then(m => m.loadAndRenderChatHistory(charId, true));
            
        } catch (error) {
            console.error("精简记录失败:", error);
            showDynamicIsland('操作失败', {
                variant: 'error',
                detail: error?.message || '精简记录时发生错误',
                copyText: error?.stack || error?.message || '操作失败'
            });
        }
    });
}
/* ==========================================================================
   ▼▼▼ 【新增】手动记忆总结功能核心逻辑 ▼▼▼
   ========================================================================== */
function setupManualSummaryModal() {
    const triggerBtn = document.getElementById('chat-settings-manual-summary-btn');
    const overlay = document.getElementById('manual-summary-modal-overlay');
    if (!overlay) return;

    const closeBtn = document.getElementById('manual-summary-close-btn');
    const cancelBtn = document.getElementById('manual-summary-cancel-btn');
    const confirmBtn = document.getElementById('manual-summary-confirm-btn');
    const sourceSelect = document.getElementById('manual-summary-source-select');
    const countInput = document.getElementById('manual-summary-count-input');

    const hideModal = () => overlay.classList.remove('visible');

    // ▼▼▼ 新增：获取和计算对应数据表的总条数逻辑 ▼▼▼
    const countDisplay = document.getElementById('manual-summary-total-count');

    const updateTotalCount = () => {
        const charId = tempState.currentChatId;
        if (!charId || !countDisplay) return;
        countDisplay.textContent = '计算中...';
        setTimeout(async () => {
            try {
                let total = 0;
                if (sourceSelect.value === 'online') {
                    // 线上：排除隐藏的通话碎片
                    total = await db.chatMessages
                        .where({ chatId: charId })
                        .filter(msg => !msg.callId || msg.contentType === 'voice_call_summary')
                        .count();
                } else {
                    // 线下
                    total = await db.offlineMessages
                        .where({ chatId: charId })
                        .count();
                }
                countDisplay.textContent = total;
            } catch (err) {
                console.error("统计条数失败:", err);
                countDisplay.textContent = '获取失败';
            }
        }, 50);
    };
    // ▲▲▲ 新增结束 ▲▲▲

    // 1. 线上设置页的按钮点击：默认选中线上模式
    if (triggerBtn) {
        triggerBtn.addEventListener('click', () => {
            sourceSelect.value = 'online'; 
            countInput.value = '30'; // 默认建议30条
            overlay.classList.add('visible');
            updateTotalCount(); // ▼ 新增：打开时立刻计算
        });
    }

    // ▼ 新增：切换数据来源时重新计算条数
    if (sourceSelect) {
        sourceSelect.addEventListener('change', updateTotalCount);
    }

    // 2. 关闭事件

    [closeBtn, cancelBtn].forEach(btn => btn?.addEventListener('click', hideModal));
    overlay.addEventListener('click', e => { if (e.target === overlay) hideModal(); });

    // 3. 核心：点击确认执行总结
    confirmBtn.addEventListener('click', async () => {
        const charId = tempState.currentChatId;
        if (!charId) return;
        
        const count = parseInt(countInput.value, 10);
        if (isNaN(count) || count <= 0) {
            showDynamicIsland('请输入有效条数', 'error');
            return;
        }

        hideModal(); // 先关掉弹窗
        showDynamicIsland('正在拉取历史记录...', 'loading');
        try {
            const char = AppState.characterProfiles.find(c => c.id === charId);
            // 修复手动总结：明确传入 charId 参数
            const user = getCurrentChatIdentity(charId);
            const realUserName = user ? user.name : '你';

            let rawMessages = [];
            let sourceMeta = null;
            // 根据下拉框的选择去不同的表里捞数据 (【性能修复】避免一万条记录全拉进内存去排序)
            if (sourceSelect.value === 'online') {
                rawMessages = await db.chatMessages.where({ chatId: charId }).reverse().limit(count).toArray();
                sourceMeta = { type: 'online', isManual: true }; // 新增：标记为手动总结
            } else {
                rawMessages = await db.offlineMessages.where({ chatId: charId }).reverse().limit(count).toArray();
                sourceMeta = { type: 'offline', isManual: true }; // 新增：标记为手动总结
            }


            if (rawMessages.length === 0) {

                showDynamicIsland('未找到符合的聊天记录', 'error');
                return;
            }

            // 截取最新的 count 条
            const targetMessages = rawMessages.slice(-count);
            // 转化为 API 认识的格式
            const conversationBuffer = targetMessages
                .filter(msg => msg.type !== 'system' && msg.sender !== 'system' && msg.type !== 'date')
                .map(msg => {
                    let finalContent = msg.text || msg.content || '';
                    // 屏蔽前端代码和复杂对象，防止 Token 爆炸和乱码
                    if (msg.contentType === 'html_snippet') finalContent = '[互动卡片]';
                    else if (msg.contentType === 'transfer') finalContent = '[转账消息]';
                    
                    return {
                        role: (msg.type === 'sent' || msg.sender === 'user') ? 'user' : 'assistant',
                        content: finalContent,
                        timestamp: msg.timestamp
                    };
                }).filter(m => m.content.trim() !== '');

            if (conversationBuffer.length === 0) {
                showDynamicIsland('提取到的记录均为空', 'error');
                return;
            }

            showDynamicIsland('开始请求AI大脑重构记忆...', 'loading');

            // 动态导入 memory.js 避免文件间循环依赖
            const { summarizeAndArchiveMemory, summarizeGroupMemory } = await import('./memory.js');
            
            // 抛给AI处理！ (最后一个参数 isRetry 传 true，避免它在失败时反复弹出失败确认框)
            if (char?.isGroup) {
                await summarizeGroupMemory(charId, conversationBuffer, realUserName, null, sourceMeta);
            } else {
                await summarizeAndArchiveMemory(charId, conversationBuffer, realUserName, char.name, sourceMeta, true);
            }
            
            showDynamicIsland('请求已发送，请稍后去记忆页检查', 'success');
        } catch (error) {
            console.error('手动记忆总结出错:', error);
            showDynamicIsland('手动总结失败，请检查网络或API', {
                variant: 'error',
                detail: error?.message || '手动记忆总结过程中发生错误',
                copyText: error?.stack || error?.message || '手动总结失败，请检查网络或API'
            });
        }
    });
}

/**
 * 【新增】更新快捷聊天美化显示的当前方案名称
 */
async function updateQuickBeautifyText() {
    const charId = tempState.currentChatId;
    if (!charId) return;
    const allSchemes = quickBeautifySchemesCache || await themeState.getAllSchemeSummaries();
    quickBeautifySchemesCache = allSchemes;
    const apps = await themeState.getAllApplications();

    // 更新：聊天详情页方案
    const detailRule = getEffectiveThemeRuleForTarget(apps, allSchemes, 'detail', charId)?.rule;
    if (detailRule) {
        const s = allSchemes.find(sc => String(sc.id) === String(detailRule.schemeId));
        if (s && document.getElementById('quick-beautify-detail-text')) document.getElementById('quick-beautify-detail-text').textContent = s.name;
    } else {
        if (document.getElementById('quick-beautify-detail-text')) document.getElementById('quick-beautify-detail-text').textContent = '默认';
    }
    // 更新：线下页面方案
    const offlineRule = getEffectiveThemeRuleForTarget(apps, allSchemes, 'offline', charId)?.rule;
    if (offlineRule) {
        const s = allSchemes.find(sc => String(sc.id) === String(offlineRule.schemeId));
        if (s && document.getElementById('quick-beautify-offline-text')) document.getElementById('quick-beautify-offline-text').textContent = s.name;
    } else {
        if (document.getElementById('quick-beautify-offline-text')) document.getElementById('quick-beautify-offline-text').textContent = '默认';
    }
    
    // 更新：气泡与头像方案
    const bubbleRule = getEffectiveThemeRuleForTarget(apps, allSchemes, 'bubble', charId)?.rule;
    if (bubbleRule) {
        const s = allSchemes.find(sc => String(sc.id) === String(bubbleRule.schemeId));
        if (s && document.getElementById('quick-beautify-bubble-text')) document.getElementById('quick-beautify-bubble-text').textContent = s.name;
    } else {
        if (document.getElementById('quick-beautify-bubble-text')) document.getElementById('quick-beautify-bubble-text').textContent = '默认';
    }
}

function updateQuickBeautifyTypeText(type, name = '默认') {
    const idMap = {
        detail: 'quick-beautify-detail-text',
        offline: 'quick-beautify-offline-text',
        bubble: 'quick-beautify-bubble-text'
    };
    const target = document.getElementById(idMap[type]);
    if (target) target.textContent = name || '默认';
}

function notifyQuickBeautifyUpdated(type, name = '默认') {
    window.dispatchEvent(new CustomEvent('looky:quick-beautify-updated', {
        detail: { type, name: name || '默认' }
    }));
}
/**
 * 【重构】快捷聊天美化弹窗与写入逻辑 (支持标签显示与恢复默认)
 */
function setupQuickBeautify() {
    const detailBtn = document.getElementById('quick-beautify-detail-btn');
    const offlineBtn = document.getElementById('quick-beautify-offline-btn');
    const bubbleBtn = document.getElementById('quick-beautify-bubble-btn');
    if (detailBtn?.dataset.quickBeautifyBound === '1') return;
    if (detailBtn) detailBtn.dataset.quickBeautifyBound = '1';
    
    // 获取我们新建的专属弹窗元素
    const modalOverlay = document.getElementById('quick-theme-selector-overlay');
    const modalList = document.getElementById('quick-theme-selector-list');
    const cancelBtn = document.getElementById('quick-theme-selector-cancel');
    const titleEl = document.getElementById('quick-theme-selector-title');
    // 绑定关闭事件
    const hideModal = () => {
        if (modalOverlay) modalOverlay.classList.remove('visible');
    };
    if (cancelBtn) cancelBtn.addEventListener('click', hideModal);
    if (modalOverlay) modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) hideModal();
    });
    
    async function applyQuickScheme(type, scheme) {
        if (!scheme) return;
        hideModal();
        const schemeId = scheme.id;
        const currentChatId = String(tempState.currentChatId);
        await cleanupInvalidCharacterScopedThemeApplications([type]);
        await db.transaction('rw', db.themeApplications, async () => {
            const allRules = await db.themeApplications.where('type').equals(type).toArray();
            const getCharacterIds = rule => Array.isArray(rule.characterIds) ? rule.characterIds : [];
            const rules = allRules.filter(rule =>
                themeRuleTargetsCharacter(rule, currentChatId)
            );
            const sameSchemeRules = allRules
                .filter(rule => String(rule.schemeId) === String(schemeId));
            // 非 chat 只能复用明确绑定角色/群聊的规则。
            const targetRule = sameSchemeRules
                .filter(isCharacterScopedThemeRule)
                .sort((left, right) => (Number(right.id) || 0) - (Number(left.id) || 0))[0];
            const deleteIds = [];
            const updatedRules = [];
            rules.forEach(rule => {
                if (rule === targetRule) return;
                const characterIds = getCharacterIds(rule);
                const remainingIds = characterIds.filter(cid => String(cid) !== currentChatId);
                if (remainingIds.length === characterIds.length) return;
                if (remainingIds.length === 0) deleteIds.push(rule.id);
                else updatedRules.push({ ...rule, characterIds: remainingIds });
            });
            if (deleteIds.length) await db.themeApplications.bulkDelete(deleteIds);
            if (targetRule) {
                updatedRules.push({
                    ...targetRule,
                    characterIds: mergeThemeCharacterIds(targetRule.characterIds, [currentChatId])
                });
                await db.themeApplications.bulkPut(updatedRules);
            } else {
                if (updatedRules.length) await db.themeApplications.bulkPut(updatedRules);
                await db.themeApplications.add({ type, schemeId, characterIds: [currentChatId] });
            }
        });
        updateQuickBeautifyTypeText(type, scheme.name);
        notifyQuickBeautifyUpdated(type, scheme.name);
        showDynamicIsland('美化方案已应用', 'success');
        scheduleQuickThemePreparation(type);
    }

    function scheduleQuickThemePreparation(type) {
        const targetPageId = type === 'offline' ? 'page-offline-mode' : 'page-chat-detail';
        const settingsPage = document.getElementById('page-chat-settings');
        if (settingsPage?.style.display !== 'none') {
            window.applyCurrentThemeConfig?.({ targetPageId });
        } else {
            window.applyCurrentThemeConfig?.();
        }
    }

    async function handleQuickApply(type) {
        if (!modalOverlay || !modalList) {
            console.error("找不到快捷美化弹窗元素");
            return;
        }
        // 动态设置弹窗标题
        const titleMap = {
            'detail': '选择聊天详情页方案',
            'offline': '选择线下页面方案',
            'bubble': '选择气泡与头像方案'
        };
        if (titleEl) titleEl.textContent = titleMap[type] || '选择主题方案';
        modalList.dataset.quickBeautifyType = type;
        modalList.innerHTML = '<li class="selection-list-item"><span class="item-text">正在加载方案...</span></li>';
        modalOverlay.classList.add('visible');
        await new Promise(resolve => requestAnimationFrame(resolve));
        const allSchemes = quickBeautifySchemesCache || await themeState.getAllSchemeSummaries();
        quickBeautifySchemesCache = allSchemes;
        // 清空并重新渲染列表
        modalList.innerHTML = '';
        const fragment = document.createDocumentFragment();
        // 1. 添加“恢复默认”选项
        const defaultLi = document.createElement('li');
        defaultLi.className = 'selection-list-item';
        defaultLi.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                <span class="item-text" style="color: #ff3b30; font-weight: 600;">恢复默认样式</span>
                <span style="font-size: 10px; color: #8e8e93; background: #f2f2f7; padding: 4px 8px; border-radius: 12px;">清除配置</span>
            </div>
        `;
        defaultLi.addEventListener('click', async () => {
            hideModal();
            const currentChatId = String(tempState.currentChatId);
            await cleanupInvalidCharacterScopedThemeApplications([type]);
            await db.transaction('rw', db.themeApplications, async () => {
                const rules = await db.themeApplications.where('type').equals(type)
                    .filter(rule => themeRuleTargetsCharacter(rule, currentChatId))
                    .toArray();
                const deleteIds = [];
                const updatedRules = [];
                rules.forEach(rule => {
                    const characterIds = Array.isArray(rule.characterIds) ? rule.characterIds : [];
                    const remainingIds = characterIds.filter(cid => String(cid) !== currentChatId);
                    if (remainingIds.length === characterIds.length) return;
                    if (remainingIds.length === 0) deleteIds.push(rule.id);
                    else updatedRules.push({ ...rule, characterIds: remainingIds });
                });
                if (deleteIds.length) await db.themeApplications.bulkDelete(deleteIds);
                if (updatedRules.length) await db.themeApplications.bulkPut(updatedRules);
            });
            updateQuickBeautifyTypeText(type);
            notifyQuickBeautifyUpdated(type);
            showDynamicIsland('已恢复默认样式');
            scheduleQuickThemePreparation(type);
        });
        fragment.appendChild(defaultLi);
        // 2. 遍历并渲染所有方案列表
        allSchemes.forEach(scheme => {
            const li = document.createElement('li');
            li.className = 'selection-list-item';
            
            // 精美的排版：左侧名字和日期，右侧紫色的类型标签
            li.innerHTML = `
                <div style="display: flex; flex-direction: column; flex: 1;">
                    <span class="item-text">${escapeHTML(scheme.name)}</span>
                    <span style="font-size: 10px; color: #8e8e93; margin-top: 4px;">${escapeHTML(scheme.date || '')}</span>
                </div>
                <span style="font-size: 11px; font-weight: 600; color: #8a6dff; background: rgba(138, 109, 255, 0.1); padding: 4px 10px; border-radius: 12px; white-space: nowrap;">
                    ${escapeHTML(scheme.typeName || '未知')}
                </span>
            `;
            
            li.dataset.schemeId = String(scheme.id);
            fragment.appendChild(li);
        });
        modalList.appendChild(fragment);
        modalList.dataset.quickBeautifyType = type;
    }
    if (modalList && modalList.dataset.quickBeautifyBound !== '1') {
        modalList.dataset.quickBeautifyBound = '1';
        modalList.addEventListener('click', event => {
            const item = event.target.closest('.selection-list-item[data-scheme-id]');
            if (!item) return;
            const scheme = (quickBeautifySchemesCache || []).find(candidate => String(candidate.id) === item.dataset.schemeId);
            applyQuickScheme(modalList.dataset.quickBeautifyType || 'detail', scheme);
        });
    }
    // 绑定三个按钮的点击事件
    if (detailBtn) detailBtn.addEventListener('click', () => handleQuickApply('detail'));
    if (offlineBtn) offlineBtn.addEventListener('click', () => handleQuickApply('offline'));
    if (bubbleBtn) bubbleBtn.addEventListener('click', () => handleQuickApply('bubble'));
}
