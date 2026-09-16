import { AppState, tempState, db, DEFAULT_AVATAR_SRC } from '../state.js';
import { UI, showDynamicIsland, showPage } from '../ui.js';
import { isCharacterFriend } from '../state.js';
import { isValidAvatarSrc, escapeHTML } from '../utils.js';
import { initCharacterManagement } from './character.js';
import {initChatInterface, loadAndRenderChatHistory, initSidebarPreviews, prepareEmptyChatInterface } from './chat-ui.js';
import { initChatSettings } from './chat-settings.js?v=20260809-notification-sound-7';
import { triggerAiResponse } from './chat-service.js';
import { initTransferFunctionality } from './transfer.js'; 
import { initVoiceFunctionality } from './voice.js'; 

const CHAT_HOME_LAST_CHAT_KEY = 'looky_chat_home_last_chat_id';

function isRealChatMessageForFirstVisit(msg = {}) {
    if (!msg || msg.recalled || msg.uiVisible === false) return false;
    if (msg.contentType === 'friend_request_card') return false;
    if (msg.friendRequestInitial === true) return false;
    return true;
}

function normalizeFirstVisitPromptVersion(value) {
    if (value === true || value === 'true') return 'true';
    if (value === false || value === 'false') return 'false';
    if (value === 'ivory') return 'ivory';
    if (value === 'minimal') return 'minimal';
    return 'minimal';
}

/**
 * 渲染聊天详情页的头部信息
 * @param {object} char - 角色对象
 */
function renderChatDetailHeader(char) {
    if (!char) return;
    const avatarSrc = isValidAvatarSrc(char.avatar) ? char.avatar : DEFAULT_AVATAR_SRC;
    UI.chatDetailAvatar.src = avatarSrc;
    UI.chatDetailName.textContent = escapeHTML(char.name);
}

/**
 * 当用户从好友列表点击一个好友时执行的逻辑
 * @param {string} charId - 被点击的角色ID (现在是字符串)
 */
export async function handleFriendClick(charId) {
    const character = AppState.characterProfiles.find(c => String(c.id) === String(charId));
    if (!character) {
        console.error(`错误：找不到ID为 "${charId}" 的角色`);
        return;
    }
    charId = character.id;
    if (!character.isGroup && !isCharacterFriend(character)) {
        showDynamicIsland('\u901a\u8fc7\u597d\u53cb\u7533\u8bf7\u540e\u624d\u80fd\u7ebf\u4e0a\u804a\u5929');
        return;
    }
    // 只有仍处于“首次访问”状态的单聊才需要查询数据库。
    // 已经访问过的聊天不再为这次点击额外等待 IndexedDB。
    let firstRealMessage = null;
    if (character.isFirstVisit !== false && !character.isGroup) {
        firstRealMessage = await db.chatMessages
            .where({ chatId: charId })
            .filter(isRealChatMessageForFirstVisit)
            .first();
    }

    // ▼▼▼ 性能优化版：首次进入弹窗拦截 (只有标记为初次 且 没有任何聊天记录时才弹窗) ▼▼▼
    if (character.isFirstVisit !== false && !firstRealMessage && !character.isGroup) {
        try {
            const config = await showFirstVisitConfigModal(
                character.chatIdentityId || character.lastChatIdentityId,
                character.useLightPrompt ?? character.lastUseLightPrompt
            );
            // 应用用户选好的配置
            character.chatIdentityId = config.identityId;
            character.lastChatIdentityId = config.identityId;
            const promptVersion = normalizeFirstVisitPromptVersion(config.promptVersion);
            character.useLightPrompt = promptVersion === 'true' ? true : (promptVersion === 'false' ? false : promptVersion);
            character.lastUseLightPrompt = character.useLightPrompt;
            character.isFirstVisit = false; 
            
            // 异步静默保存，不堵塞主线程
            import('./character.js').then(mod => mod.optimizedSaveAndRender());
         } catch (e) {
            // 如果用户中途退出或出错，拦截进入
            console.log("未完成初始配置，终止进入聊天");
            return; 
        }
    } else if (character.isFirstVisit !== false) {
        // 如果因为有历史记录而绕过了弹窗，必须在这里打上“已访问”标记并保存
        // 这样就算用户进去后把聊天记录清空了，下次进来也不会再触发弹窗！
        character.isFirstVisit = false;
        import('./character.js').then(mod => mod.optimizedSaveAndRender());
    }
    
    // 配置完成后，继续原本顺滑的入场逻辑
    _continueHandleFriendClick(charId, character);
}

// 封装的弹窗核心逻辑 (Promise)
function showFirstVisitConfigModal(preferredIdentityId = null, preferredPromptVersion = 'minimal') {
    return new Promise((resolve, reject) => {
        const modal = document.getElementById('first-visit-config-modal');
        const identityList = document.getElementById('fv-identity-list');
        const promptItems = document.querySelectorAll('.fv-prompt-item');
        const confirmBtn = document.getElementById('fv-confirm-btn');
        if (!modal || !identityList || !confirmBtn) { resolve({ identityId: AppState.userIdentities[0]?.id, promptVersion: 'minimal' }); return; }

        const preferredExists = AppState.userIdentities.some(identity => String(identity.id) === String(preferredIdentityId));
        const fallbackIdentity = AppState.userIdentities.find(identity => String(identity.id) === String(AppState.currentIdentityId))
            || AppState.userIdentities[0];
        let selectedIdentityId = preferredExists ? preferredIdentityId : fallbackIdentity?.id;
        let selectedPrompt = normalizeFirstVisitPromptVersion(preferredPromptVersion);

        // 1. 渲染超好看的头像列表
        identityList.innerHTML = AppState.userIdentities.map(id => {
            const avatar = isValidAvatarSrc(id.avatar) ? id.avatar : DEFAULT_AVATAR_SRC;
            const displayName = id.nickname || id.name || '未命名身份';
            const isSelected = String(id.id) === String(selectedIdentityId);
            return `
            <div class="fv-identity-item" data-id="${id.id}" style="flex-shrink: 0; width: 68px; display: flex; flex-direction: column; align-items: center; gap: 8px; cursor: pointer;">
                <div class="fv-avatar-ring" style="width: 58px; height: 58px; border-radius: 50%; padding: 3px; border: 2px solid ${isSelected ? '#111' : 'transparent'}; transition: all 0.2s ease;">
                    <img src="${avatar}" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover; background: #eee;">
                </div>
                <span class="fv-name-text" style="font-size: 12px; font-weight: ${isSelected ? '700' : '500'}; color: ${isSelected ? '#111' : '#888'}; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%;">${escapeHTML(displayName)}</span>
            </div>`;
        }).join('');

        // 2. 绑定头像点击高亮逻辑
        const identityNodes = identityList.querySelectorAll('.fv-identity-item');
        identityNodes.forEach(node => {
            node.onclick = () => {
                selectedIdentityId = node.dataset.id;
                identityNodes.forEach(n => {
                    n.querySelector('.fv-avatar-ring').style.border = '2px solid transparent';
                    n.querySelector('.fv-name-text').style.fontWeight = '500';
                    n.querySelector('.fv-name-text').style.color = '#888';
                });
                node.querySelector('.fv-avatar-ring').style.border = '2px solid #111';
                node.querySelector('.fv-name-text').style.fontWeight = '700';
                node.querySelector('.fv-name-text').style.color = '#111';
            };
        });

        // 3. 绑定预设点击高亮逻辑
        const updatePromptSelection = (targetValue) => {
            selectedPrompt = normalizeFirstVisitPromptVersion(targetValue);
            promptItems.forEach(i => {
                const isSelected = i.dataset.value === selectedPrompt;
                i.style.border = isSelected ? '2px solid #111' : '2px solid transparent';
                i.style.background = isSelected ? '#fff' : '#f9f9f9';
                i.style.boxShadow = isSelected ? '0 4px 12px rgba(0,0,0,0.05)' : 'none';
                i.querySelector('.fv-radio-circle').style.border = isSelected ? '6px solid #111' : '2px solid #ddd';
            });
        };
        updatePromptSelection(selectedPrompt);
        promptItems.forEach(item => {
            item.onclick = () => {
                updatePromptSelection(item.dataset.value);
            };
        });

        // 4. 显示弹窗
        modal.style.display = 'flex';
        // 利用 setTimeout 制造微小的渲染间隙，触发 CSS 渐变动画，告别瞬间弹出的生硬感
        setTimeout(() => modal.style.opacity = '1', 10);

        // 5. 点击确认，干净利落地处理并回收内存
        confirmBtn.onclick = () => {
            modal.style.opacity = '0';
            setTimeout(() => {
                modal.style.display = 'none';
                resolve({ identityId: selectedIdentityId, promptVersion: selectedPrompt });
            }, 300); // 300ms 对应 CSS 的 transition 时间
        };
    });
}

// 分离出来的原有点击逻辑，保障逻辑无损
async function _continueHandleFriendClick(charId, character) {
    // ▲▲▲ 新增结束 ▲▲▲
    const listItem = document.querySelector(`.conversation-item[data-char-id="${charId}"]`);
    if (listItem) {
        const indicator = listItem.querySelector('.online-indicator');
        if (indicator) {
            // 将内联样式清空，它会自动恢复成 CSS 里原本规定的颜色（比如在线的绿色或离线的灰色）
            indicator.style.backgroundColor = ''; 
            indicator.style.boxShadow = '';       
        }
    }
    // --- 第1步：闪电般地准备好“空房间” ---

    
    // 1.1 更新全局状态，这是内存操作，很快
    tempState.currentChatId = charId;
    try {
        localStorage.setItem(CHAT_HOME_LAST_CHAT_KEY, String(charId));
    } catch (e) {}
    
    // 1.2 渲染聊天页头部，这是轻量级DOM操作，很快
    renderChatDetailHeader(character);
    // ▼▼▼ 新增：点进聊天时后台静默刷新该角色天气，没配城市自动走虚拟天气 ▼▼▼
    if (!character.isGroup && typeof window.fetchRealWeather === 'function') {
        try {
            const wCharCity = localStorage.getItem('ls_weather_char_city_' + charId) || '';
            const wMyCity = localStorage.getItem('ls_weather_my_city_' + charId) || '';
            window.fetchRealWeather(wCharCity, 'bg-weather-char-temp', 'bg-weather-char-city-text', charId).catch(() => {});
            if (wMyCity) window.fetchRealWeather(wMyCity, 'bg-weather-my-temp', 'bg-weather-my-city-text', charId).catch(() => {});
        } catch(e) {}
    }
    // ▲▲▲ 新增结束 ▲▲▲
    // 1.3 【重要】调用我们之前写的 prepareEmptyChatInterface，瞬间清空旧内容
    // 这个函数只操作DOM，不涉及数据库，是同步的，也非常快
    prepareEmptyChatInterface(charId);

    // 1.4 应用壁纸；主题由 showPage 在详情页显示后统一处理
    const offlineContentEl = document.querySelector('#page-offline-mode .offline-chat-content');
    if (offlineContentEl && character) {
        if (character.offlineWallpaper) {
            offlineContentEl.style.backgroundImage = `url(${character.offlineWallpaper})`;
        } else {
            offlineContentEl.style.backgroundImage = 'none';
        }
    }
    // --- 第2步：平滑地“打开门” ---
    
    // 2.1 执行页面切换。此时浏览器会开始播放切换动画。
    showPage('page-chat-detail');

    // --- 第3步：等门开了，再“搬家具” ---

    // 3.1 【性能优化的核心】使用一个微小的延时 (setTimeout)
    // 这会将重量级的 loadAndRenderChatHistory 推迟到下一个事件循环。
    // 此时，页面切换动画已经有了充足的时间去完成，不会再卡顿。
    setTimeout(async () => {
        try {
            // 现在，在这个“宁静”的时刻，安心加载所有数据并渲染
            await loadAndRenderChatHistory(charId, true);
        } catch (error) {
            console.error(`后台为角色 ${charId} 加载聊天记录时出错:`, error);
        }
    }, 10); 
}

/**
 * 统一的初始化函数，由 main.js 调用
 */
export function setupChatAndCharManagement() {
    initCharacterManagement(handleFriendClick);
    initChatInterface();
    setTimeout(() => initSidebarPreviews(), 500); 
    initChatSettings();
    initTransferFunctionality(
        (msgData, scroll) => import('./chat-ui.js').then(ui => ui.createAndAppendMessage(msgData, scroll)),
        triggerAiResponse
    );
    initVoiceFunctionality();
}
