
import { showPage, showSimpleSelectModal } from '../ui.js'; // 【修改】增加了 showSimpleSelectModal
import { AppState, db, themeState, tempState, cleanupInvalidCharacterScopedThemeApplications, isCharacterScopedThemeRule, isInvalidCharacterScopedThemeRule, themeRuleTargetsCharacter, getEffectiveThemeRuleForTarget, mergeThemeCharacterIds } from '../state.js'; // 【新增】
import { getAllCharacters } from './character.js'; // 【新增】
import { isNativeRuntime, saveBlobToNativeStorage } from '../native-bridge.js';

// 初始化函数

// 初始化函数
const CHAT_HOME_INS_STYLE_KEY = 'looky_chat_home_ins_style';
const CHAT_HOME_INS_VIEW_KEY = 'looky_chat_home_ins_view';
const CHAT_HOME_INS_GROUP_KEY = 'looky_chat_home_ins_group';
const CHAT_HOME_INS_SEGMENT_ID = 'chat-home-ins-segment';
let chatHomeInsListRefreshFrame = 0;

function notifyThemeSchemesUpdated() {
    window.dispatchEvent(new CustomEvent('looky:theme-schemes-updated'));
}

function scheduleChatHomeInsListRefresh() {
    if (chatHomeInsListRefreshFrame) cancelAnimationFrame(chatHomeInsListRefreshFrame);
    chatHomeInsListRefreshFrame = requestAnimationFrame(() => {
        chatHomeInsListRefreshFrame = 0;
        window.refreshChatHomeFriendList?.();
    });
}

function createChatHomeInsSegmentButton({ view, groupId = '', label, deco }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.insView = view;
    if (groupId) button.dataset.groupId = groupId;

    const labelSpan = document.createElement('span');
    labelSpan.className = 'chat-home-ins-segment-label';
    labelSpan.textContent = label;

    const decoSpan = document.createElement('span');
    decoSpan.className = 'chat-home-ins-segment-deco';
    decoSpan.textContent = deco;

    button.append(labelSpan, decoSpan);
    return button;
}

function renderChatHomeInsSegment(segment) {
    const currentView = document.body.dataset.chatHomeInsView || 'all';
    const currentGroupId = document.body.dataset.chatHomeInsGroupId || '';
    const views = [
        { view: 'all', label: '全部', deco: 'ALL' },
        { view: 'groups', label: '群聊', deco: 'GROUPS' },
        ...AppState.characterGroups.map(group => ({
            view: 'character-group',
            groupId: String(group.id),
            label: group.name || '未命名分组',
            deco: 'GROUP'
        }))
    ];

    segment.textContent = '';
    views.forEach(viewConfig => {
        const button = createChatHomeInsSegmentButton(viewConfig);
        const isActive = viewConfig.view === currentView && (viewConfig.view !== 'character-group' || viewConfig.groupId === currentGroupId);
        button.classList.toggle('active', isActive);
        segment.appendChild(button);
    });
}

function ensureChatHomeInsSegment() {
    const searchBar = document.querySelector('#page-chat .chat-search-bar');
    if (!searchBar) return null;

    let segment = document.getElementById(CHAT_HOME_INS_SEGMENT_ID);
    if (!segment) {
        segment = document.createElement('div');
        segment.id = CHAT_HOME_INS_SEGMENT_ID;
        segment.className = 'chat-home-ins-segment';
        searchBar.insertAdjacentElement('afterend', segment);
    }
    renderChatHomeInsSegment(segment);

    if (segment.dataset.insSegmentBound !== 'true') {
        segment.dataset.insSegmentBound = 'true';
        segment.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-ins-view]');
            if (!button) return;
            setChatHomeInsView(button.dataset.insView, button.dataset.groupId || '');
        });
    }

    return segment;
}

function refreshChatHomeInsSegment() {
    if (!document.body.classList.contains('chat-home-style-ins')) return;
    ensureChatHomeInsSegment();
}

window.refreshChatHomeInsSegment = refreshChatHomeInsSegment;

function setChatHomeInsView(view = 'all', groupId = '', options = {}) {
    const { switchToFriends = true, refreshList = false } = options;
    const nextView = view === 'groups' || view === 'character-group' ? view : 'all';
    const nextGroupId = nextView === 'character-group' ? groupId : '';
    const isSameView =
        document.body.dataset.chatHomeInsView === nextView &&
        (document.body.dataset.chatHomeInsGroupId || '') === nextGroupId;
    if (isSameView && !refreshList) {
        if (switchToFriends && tempState.currentChatHomeSection !== 'friends-content' && document.getElementById('page-chat')?.style.display !== 'none' && typeof window.setChatHomeSection === 'function') {
            window.setChatHomeSection('friends-content');
        }
        return;
    }
    document.body.dataset.chatHomeInsView = nextView;
    document.body.dataset.chatHomeInsGroupId = nextGroupId;
    if (localStorage.getItem(CHAT_HOME_INS_VIEW_KEY) !== nextView) {
        localStorage.setItem(CHAT_HOME_INS_VIEW_KEY, nextView);
    }
    if (localStorage.getItem(CHAT_HOME_INS_GROUP_KEY) !== nextGroupId) {
        localStorage.setItem(CHAT_HOME_INS_GROUP_KEY, nextGroupId);
    }
    refreshChatHomeInsSegment();
    if (switchToFriends && document.getElementById('page-chat')?.style.display !== 'none' && typeof window.setChatHomeSection === 'function') {
        window.setChatHomeSection('friends-content');
    }
    if (refreshList) {
        scheduleChatHomeInsListRefresh();
    } else {
        window.applyChatHomeInsListFilter?.();
    }
}

window.applyChatHomeInsListFilter = async function applyChatHomeInsListFilter() {
    if (!document.body.classList.contains('chat-home-style-ins')) return;
    const view = document.body.dataset.chatHomeInsView || 'all';
    const characters = await getAllCharacters();
    const searchTerm = document.getElementById('chat-search-input')?.value.toLowerCase().trim() || '';
    document.querySelectorAll('#page-chat .conversation-list .conversation-item').forEach(item => {
        const char = characters.find(profile => String(profile.id) === String(item.dataset.charId));
        const name = item.querySelector('.chat-name')?.textContent.toLowerCase() || '';
        const groupId = document.body.dataset.chatHomeInsGroupId || '';
        const viewMatches =
            view === 'groups' ? char?.isGroup === true :
            view === 'character-group' ? String(char?.groupId || '') === groupId :
            true;
        const searchMatches = !searchTerm || name.includes(searchTerm);
        item.style.display = viewMatches && searchMatches ? '' : 'none';
    });
    document.querySelectorAll('#page-chat .chat-friend-section').forEach(section => {
        const hasVisibleItem = Array.from(section.querySelectorAll('.conversation-item')).some(item => item.style.display !== 'none');
        section.style.display = hasVisibleItem ? '' : 'none';
    });
};

function applyChatHomeInsStyle(enabled) {
    const wasEnabled = document.body.classList.contains('chat-home-style-ins');
    if (wasEnabled === enabled) {
        const toggle = document.getElementById('chat-home-ins-toggle');
        if (toggle) toggle.checked = enabled;
        return;
    }
    document.body.classList.toggle('chat-home-style-ins', enabled);
    const toggle = document.getElementById('chat-home-ins-toggle');
    if (toggle) toggle.checked = enabled;
    if (enabled) {
        setChatHomeInsView(localStorage.getItem(CHAT_HOME_INS_VIEW_KEY) || 'all', localStorage.getItem(CHAT_HOME_INS_GROUP_KEY) || '', {
            switchToFriends: false,
            refreshList: false
        });
        scheduleChatHomeInsListRefresh();
    } else {
        delete document.body.dataset.chatHomeInsView;
        delete document.body.dataset.chatHomeInsGroupId;
        document.getElementById(CHAT_HOME_INS_SEGMENT_ID)?.remove();
        scheduleChatHomeInsListRefresh();
        document.getElementById('chat-search-input')?.dispatchEvent(new Event('input'));
    }
}

function bindChatHomeInsStyleToggle() {
    const toggle = document.getElementById('chat-home-ins-toggle');
    const savedEnabled = localStorage.getItem(CHAT_HOME_INS_STYLE_KEY) === 'true';
    applyChatHomeInsStyle(savedEnabled);

    if (!toggle || toggle.dataset.insStyleBound === 'true') return;
    toggle.dataset.insStyleBound = 'true';
    toggle.addEventListener('change', () => {
        const enabled = toggle.checked;
        localStorage.setItem(CHAT_HOME_INS_STYLE_KEY, enabled ? 'true' : 'false');
        applyChatHomeInsStyle(enabled);
    });
}

export function init() {
    const realTargetMapForBackup = {
        'target-nav-chat': '.theme-target-chat-main-footer .nav-item[data-page="page-chat"][data-chat-section="friends-content"]',
        'target-nav-contacts': '.theme-target-chat-main-footer .nav-item[data-chat-section="contacts-content"]',
        'target-nav-dynamics': '.theme-target-chat-main-footer .nav-item[data-page="page-dynamics"]',
        'target-nav-profile': '.theme-target-chat-main-footer .nav-item[data-page="page-profile"]',
        'chat-add': '#add-friend-btn',
        'chat-more': '#contacts-more-btn',
        'detail-back': '.chat-detail-header .back-button .back-button-icon-wrapper',
        'offline-back': '.theme-target-offline-header .back-button .back-button-icon-wrapper',
        'target-online-call': '#call-btn',
        'target-online-more': '#chat-detail-more-btn',
        'target-online-grid': '.chat-grid-btn',
        'target-online-emoji': '.chat-emoji-btn',
        'target-online-send': '#send-message-btn',
        'target-offline-more': '#offline-more-btn',
        'target-offline-stop': '#offline-stop-btn',
        'target-offline-send': '#offline-send-btn',
    };
    Object.values(realTargetMapForBackup).forEach(selector => {
        const element = document.querySelector(selector);
        if (element && !element.dataset.originalHtml) {
            element.dataset.originalHtml = element.innerHTML;
        }
    });
    const triggerButton = document.querySelector('.profile-feature-card');
     if (triggerButton) {
        triggerButton.addEventListener('click', () => {
            showPage('page-chat-beautify');
        });
    }
    bindChatHomeInsStyleToggle();
    bindPageEvents();
}

function bindPageEvents() {


    // 1. 预览区域的 Tab 切换逻辑
    const previewTabs = document.querySelectorAll('.preview-tab');
    if (previewTabs.length) {
        previewTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const targetId = tab.dataset.preview;
                document.querySelectorAll('.preview-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                document.querySelectorAll('.preview-scene').forEach(scene => {
                    scene.classList.toggle('active', scene.id === `preview-${targetId}-scene`);
                });
            });
        });
    }

    // 2. 图标和界面栏设置区域的 Tab 切换逻辑 (通用)
    document.querySelectorAll('.settings-card').forEach(card => {
        const tabs = card.querySelectorAll('.beautify-settings-tabs .settings-tab');
        const panels = card.querySelectorAll('.beautify-settings-panels-container .beautify-settings-panel');
        if (tabs.length === 0 || panels.length === 0) return;

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                const panelId = tab.dataset.settingsPanel;
                panels.forEach(p => {
                    p.classList.toggle('active', p.id === panelId);
                });
            });
        });
    });

    document.querySelectorAll('#page-chat-beautify .settings-card > .beautify-section-header').forEach(header => {
        const card = header.closest('.settings-card');
        if (!card || header.dataset.collapseBound === 'true') return;

        header.dataset.collapseBound = 'true';
        card.classList.add('is-collapsible');
        header.setAttribute('role', 'button');
        header.setAttribute('tabindex', '0');
        header.setAttribute('aria-expanded', String(!card.classList.contains('is-collapsed')));

        const toggleCard = () => {
            const isCollapsed = card.classList.toggle('is-collapsed');
            header.setAttribute('aria-expanded', String(!isCollapsed));
        };

        header.addEventListener('click', (e) => {
            if (e.target.closest('button, label, input, select, textarea, a')) return;
            toggleCard();
        });

        header.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            toggleCard();
        });
    });
    
    // ==========================================================
    // 3. 核心功能逻辑：图标、背景图、源代码
    // ==========================================================
    
    const fileInput = document.getElementById('beautify-file-input');
    let currentActiveButton = null;

    // (A) 图标上传、URL、滑块的逻辑 (保持不变)
    document.querySelectorAll('.upload-trigger, .url-trigger').forEach(btn => {
        btn.addEventListener('click', (e) => {
            currentActiveButton = btn;
            if (btn.classList.contains('upload-trigger')) {
                fileInput.click();
            } else {
                const url = prompt("请输入图标的图片地址 (URL):");
                if (url) updateIconPreview(currentActiveButton, url);
            }
        });
    });
    document.querySelectorAll('.size-slider').forEach(slider => {
        slider.addEventListener('input', (e) => {
            updateIconSize(slider.closest('.custom-icon-row'), slider.dataset.previewId, e.target.value);
        });
    });
// (B) 预定义源代码库
const sourceCodeMap = {
    'chat-main-header': 
`/* 聊天主页 - 顶栏 (提取自 _chat.scss) */
/* 对应HTML: <div class="chat-top-area theme-target-chat-main-header"> */
.theme-applied .theme-target-chat-main-header {
    /* [容器] 这是顶栏的整体样式，现在它包含状态栏区域 */
    padding-top: var(--safe-area-inset-top); /* 适配刘海屏 */
    background: var(--c-bg-system); /* 默认是系统背景色 */
}
/* [子元素] 这是里面的标题栏，让它变透明 */
.theme-applied .theme-target-chat-main-header .app-header {
    background: transparent !important;
    border-bottom: none !important;
}
/* [子元素] 这是顶栏中间的 "聊天" 标题 */
.theme-applied .theme-target-chat-main-header .app-title {
    font-size: 17px;
    font-weight: 600;
    color: var(--c-text-primary);
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
}
/* [子元素] 精确控制右边的按钮，防止误伤左边返回键 */
.theme-applied .theme-target-chat-main-header #add-friend-btn,
.theme-applied .theme-target-chat-main-header #contacts-more-btn {
    display: block;
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    padding: 8px;
    border-radius: 50%;
    transition: background-color 0.2s;
}

/* [位置] 更多按钮放在最右边 */
.theme-applied .theme-target-chat-main-header #contacts-more-btn {
    right: 8px; /* var(--space-xs) */
}

/* [位置] 加好友按钮放在更多按钮的左边，错开位置防止重叠 */
.theme-applied .theme-target-chat-main-header #add-friend-btn {
    right: 52px; /* 8px + 按钮宽度(约44px) */
}

.theme-applied .theme-target-chat-main-header #add-friend-btn:hover,
.theme-applied .theme-target-chat-main-header #contacts-more-btn:hover {
    background-color: rgba(0,0,0,0.05);
}
`,

    'chat-main-footer': 
`/* 聊天主页 - 底部导航栏 (提取自 _bottom-nav.scss) */
/* 对应HTML: <div class="chat-bottom-nav theme-target-chat-main-footer"> */
.theme-applied .theme-target-chat-main-footer {
    /* [容器] 这是整个导航栏的样式 */
    position: absolute;
    bottom: calc(16px + env(safe-area-inset-bottom));
    left: 16px;
    right: 16px;
    height: 64px;
    border-radius: 100px;
    background: white;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
    display: flex;
    justify-content: space-around;
    align-items: center;
}

/* [子元素] 单个导航项 ("聊天", "通讯录", "动态", "个人主页") */
.theme-applied .theme-target-chat-main-footer .nav-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
}

/* [子元素] 导航项的文字 */
.theme-applied .theme-target-chat-main-footer .nav-item span {
    font-size: 10px; /* var(--font-xs) */
    color: var(--c-text-secondary);
}

/* [子元素] 导航项被选中时的状态 */
.theme-applied .theme-target-chat-main-footer .nav-item.active span {
    color: #8a6dff;
}

/* [图标位置] 导航项里的图标位置和大小 */
.theme-applied .theme-target-chat-main-footer .nav-item svg {
    width: 24px;
    height: 24px;
    stroke-width: 2;
}
`,

    'online-header': 
`/* 聊天详情页 - 顶栏 (提取自 _chat-detail.scss) */
/* 对应HTML: <div class="app-header chat-detail-header theme-target-detail-header"> */
.theme-applied .theme-target-detail-header {
    /* [容器] 顶栏整体 */
    display: flex;
    align-items: center;
    padding: 44px 8px 8px;
    background-color: var(--c-bg-primary); /* 和页面背景色一致 */
    border-bottom: 1px solid var(--c-border-light);
}

/* [子元素] 左边区域 (返回按钮 + 头像昵称) */
.theme-applied .theme-target-detail-header .chat-detail-header-left {
    display: flex;
    align-items: center;
    gap: 8px;
}

/* [子元素] 头像和昵称的组合 */
.theme-applied .theme-target-detail-header .chat-title-group {
    display: flex;
    align-items: center;
    gap: 10px;
}

/* [子元素] 头像 */
.theme-applied .theme-target-detail-header .chat-detail-avatar {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    object-fit: cover;
}

/* [子元素] 昵称 */
.theme-applied .theme-target-detail-header #chat-detail-char-name {
    font-size: 17px;
    font-weight: 600;
    color: #1c1c1e;
}

/* [子元素] 右边区域 (通话 + 更多按钮) */
.theme-applied .theme-target-detail-header .chat-detail-header-right {
    display: flex;
    align-items: center;
    gap: 18px;
    margin-left: auto; /* 把自己推到最右边 */
}

/* [图标位置] 返回、通话、更多按钮的容器 */
.theme-applied .theme-target-detail-header .header-button {
    padding: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    transition: background-color 0.2s;
}
.theme-applied .theme-target-detail-header .header-button:hover {
    background-color: rgba(0,0,0,0.05);
}
`,

    'online-footer': 
`/* 聊天详情页 - 底部输入区 (提取自 _chat-input.scss) */
/* 对应HTML: <div class="chat-input-container theme-target-detail-footer"> */
.theme-applied .theme-target-detail-footer {
    /* [容器] 整个底部输入区域 */
    background-color: var(--c-bg-primary); /* 和页面背景一致 */
    padding: 8px 0;
    padding-bottom: 11px; /* 修复苹果端顶出空白的问题 */
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--c-border-light);
}

/* [子元素] 包含所有按钮和输入框的内层容器 */
.theme-applied .theme-target-detail-footer .chat-input-area {
    padding: 0 16px; /* var(--space-md) */
    display: flex;
    align-items: center;
    gap: 8px; /* var(--space-sm) */
}

/* [子元素] 中间的输入框外层包裹 */
.theme-applied .theme-target-detail-footer .text-input-wrapper {
    background-color: var(--c-bg-secondary);
    border-radius: 20px; /* var(--radius-xl) */
    padding: 0 12px;
    display: flex;
    align-items: center;
    flex-grow: 1; /* 占据尽可能多的空间 */
}

/* [子元素] 输入框本体 */
.theme-applied .theme-target-detail-footer #chat-input-field {
    width: 100%;
    border: none;
    background: transparent;
    font-size: 16px; /* var(--font-md) */
    padding: 11px 0;
    line-height: 1.5;
}

/* [图标位置] 左边的功能格按钮 */
.theme-applied .theme-target-detail-footer .chat-grid-btn {
    padding: 4px;
}

/* [图标位置] 右边的表情按钮 */
.theme-applied .theme-target-detail-footer .chat-emoji-btn {
    padding: 4px;
}

/* [图标位置] 最右边的发送按钮 */
.theme-applied .theme-target-detail-footer #send-message-btn {
    background-color: #007AFF;
    border-radius: 50%;
    width: 36px;
    height: 36px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 8px rgba(0, 122, 255, 0.3);
}
`,

    'offline-header': 
`/* 线下模式 - 顶栏 (提取自 _offline-mode.scss) */
/* 对应HTML: <div class="app-header theme-target-offline-header"> */
.theme-applied .theme-target-offline-header {
    /* [容器] 顶栏整体，它是透明的，悬浮在背景图上 */
    display: flex;
    align-items: center;
    padding: max(30px, env(safe-area-inset-top)) 16px 10px;
    background-color: transparent !important;
    border-bottom: none !important;
}

/* [子元素] 返回按钮 */
.theme-applied .theme-target-offline-header .back-button {
    /* 这里为了让箭头在深色背景下可见，可以设置颜色和阴影 */
    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5));
}
.theme-applied .theme-target-offline-header .back-button svg {
    stroke: white; /* 强行让箭头变白 */
}

/* [子元素] 中间标题 */
.theme-applied .theme-target-offline-header .app-title {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    color: #fff;
    text-shadow: 0 1px 3px rgba(0,0,0,0.6);
}

/* [子元素] 右边更多按钮 */
.theme-applied .theme-target-offline-header .more-button {
    margin-left: auto; /* 推到最右 */
    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5));
}
.theme-applied .theme-target-offline-header .more-button svg {
    stroke: white; /* 让图标变白 */
}
`,

    'offline-footer': 
`/* 线下模式 - 底部输入区 (提取自 _offline-mode.scss) */
/* 对应HTML: <div class="offline-chat-input-container theme-target-offline-footer"> */
.theme-applied .theme-target-offline-footer {
    /* [容器] 整个底部输入区，也是悬浮透明的 */
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 12px 15px calc(25px + env(safe-area-inset-bottom));
    display: flex;
    align-items: center;
    gap: 12px;
    background: transparent;
}

/* [子元素] 输入框本体，有毛玻璃效果 */
.theme-applied .theme-target-offline-footer #offline-chat-input {
    flex-grow: 1;
    height: 44px;
    background-color: rgba(255, 255, 255, 0.9);
    backdrop-filter: blur(10px);
    border-radius: 22px;
    padding: 0 18px;
    font-size: 15px; /* 0.95rem */
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
}

/* [图标位置] 停止和发送按钮，也是毛玻璃效果 */
.theme-applied .theme-target-offline-footer .send-btn {
    flex-shrink: 0;
    width: 44px;
    height: 44px;
    background-color: rgba(255, 255, 255, 0.9);
    border-radius: 50%;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
    display: flex;
    justify-content: center;
    align-items: center;
}
`,
       'online-bubble-received':
`/* (基于最新SCSS更新) 线上 - 角色(对方)的气泡与头像 */
/* [容器] 消息整体 */
.theme-applied #page-chat-detail .message-wrapper.received,
.theme-applied #preview-online-scene .message-wrapper.received {
  align-self: flex-start;
  gap: 8px; 
}
/* [头像] */
.theme-applied #page-chat-detail .message-wrapper.received .chat-avatar-small,
.theme-applied #preview-online-scene .message-wrapper.received .chat-avatar-small {
  width: 36px; height: 36px;
  border-radius: 50%; object-fit: cover; flex-shrink: 0;
}
/* [基础气泡] 文字气泡背景色在这里改 */
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble {
  background-color: var(--c-bg-primary); /* 默认白色 */
  border-radius: 18px; 
  box-shadow: var(--shadow-sm);
  color: var(--c-text-primary);
}
/* [气泡文字] */
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble p,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble p {
  padding: 8px 12px; margin: 0; font-size: 16px; line-height: 1.5;
}

/* --- [语音消息] --- */
.theme-applied #page-chat-detail .message-wrapper.received .voice-bar,
.theme-applied #preview-online-scene .message-wrapper.received .voice-bar {
  display: flex; align-items: center; gap: 12px; height: 44px; padding: 0 14px;
  background-color: var(--c-bg-primary); 
  box-shadow: var(--shadow-sm);
  border-radius: 18px; width: 180px; 
}
.theme-applied #page-chat-detail .message-wrapper.received .voice-bar .bar,
.theme-applied #preview-online-scene .message-wrapper.received .voice-bar .bar {
  background-color: var(--c-text-primary); 
}
.theme-applied #page-chat-detail .message-wrapper.received .voice-bar .voice-duration,
.theme-applied #preview-online-scene .message-wrapper.received .voice-bar .voice-duration {
  color: var(--c-text-secondary); 
}

/* --- [关键更新] 图片消息 (自适应宽高) --- */
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble.gallery-image-bubble,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble.gallery-image-bubble {
  background: transparent !important; box-shadow: none !important; padding: 0 !important; border: none !important;
  max-width: 60%; /* 限制最大宽度 */
  min-height: 50px; /* 防止加载前塌陷 */
  background-color: #efeff4; /* 加载占位色 */
}
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble.gallery-image-bubble img,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble.gallery-image-bubble img {
  border-radius: 12px; display: block; 
  width: 100%; /* 宽度撑满 */
  height: auto; /* 高度自适应 */
}

/* --- [关键更新] 转账消息 (对方发给你的) --- */
.theme-applied #page-chat-detail .message-wrapper.received .is-transfer-message,
.theme-applied #preview-online-scene .message-wrapper.received .is-transfer-message {
  background: transparent !important; box-shadow: none !important; padding: 0 !important; width: 230px;
}
.theme-applied #page-chat-detail .message-wrapper.received .transfer-card,
.theme-applied #preview-online-scene .message-wrapper.received .transfer-card {
  border-radius: 8px; overflow: hidden; width: 100%;
}
/* [新增] 转账图标大小和位置控制 */
.theme-applied #page-chat-detail .message-wrapper.received .transfer-icon,
.theme-applied #preview-online-scene .message-wrapper.received .transfer-icon {
  width: 36px; height: 36px; margin-right: 12px; flex-shrink: 0;
}
/* 待收款 (橙色) */
.theme-applied #page-chat-detail .message-wrapper.received .transfer-pending,
.theme-applied #preview-online-scene .message-wrapper.received .transfer-pending {
  background-color: #FA9D3B; 
}
/* 待收款文字 (黑色) */
.theme-applied #page-chat-detail .message-wrapper.received .transfer-pending .transfer-text-group p,
.theme-applied #preview-online-scene .message-wrapper.received .transfer-pending .transfer-text-group p {
  color: #000 !important; 
}
.theme-applied #page-chat-detail .message-wrapper.received .transfer-pending .transfer-footer,
.theme-applied #preview-online-scene .message-wrapper.received .transfer-pending .transfer-footer {
  color: #888 !important;
}
/* 已收款 (米色) */
.theme-applied #page-chat-detail .message-wrapper.received .transfer-receipt,
.theme-applied #preview-online-scene .message-wrapper.received .transfer-receipt {
  background-color: #F3E6D3 !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .transfer-receipt .transfer-text-group p,
.theme-applied #preview-online-scene .message-wrapper.received .transfer-receipt .transfer-text-group p {
  color: #444 !important;
}

/* --- [新增] 动态卡片 --- */
.theme-applied #page-chat-detail .message-wrapper.received .is-moment-card,
.theme-applied #preview-online-scene .message-wrapper.received .is-moment-card {
  padding: 0 !important; width: 240px; background: #fff; border-radius: 10px; overflow: hidden;
  border: 1px solid rgba(0,0,0,0.05);
}
.theme-applied #page-chat-detail .message-wrapper.received .is-moment-card .mc-header,
.theme-applied #preview-online-scene .message-wrapper.received .is-moment-card .mc-header {
  background: #f9f9f9; padding: 10px 12px; display: flex; align-items: center; border-bottom: 1px solid #eee;
}
.theme-applied #page-chat-detail .message-wrapper.received .is-moment-card .mc-text,
.theme-applied #preview-online-scene .message-wrapper.received .is-moment-card .mc-text {
  font-size: 13px; color: #333; margin-right: 8px;
}

/* --- [新增] 翻译气泡 --- */
.theme-applied #page-chat-detail .message-wrapper.received .message-translation,
.theme-applied #preview-online-scene .message-wrapper.received .message-translation {
  border-top: 1px solid rgba(0,0,0,0.06);
  padding: 8px 14px 10px; margin-top: 4px; color: #666; font-size: 13px; line-height: 1.6;
}

/* --- [新增] 翻译按钮 (气泡右侧隐形点击区) --- */
.theme-applied #page-chat-detail .message-wrapper.received .btn-toggle-translation,
.theme-applied #preview-online-scene .message-wrapper.received .btn-toggle-translation {
  width: 14px; height: 28px; min-width: 14px; min-height: 28px; padding: 0; border: 0; border-radius: 0;
  background: transparent; color: transparent; opacity: 0; cursor: pointer;
  position: absolute; top: 50%; right: -14px; transform: translateY(-50%); z-index: 3;
}
/* --- [新增] 语音转文字展开 --- */
.theme-applied #page-chat-detail .message-wrapper.received .voice-text-content,
.theme-applied #preview-online-scene .message-wrapper.received .voice-text-content {
  display: none; margin-top: 8px; padding: 10px 14px; background-color: var(--c-bg-primary); border-radius: 18px; box-shadow: var(--shadow-sm); font-size: 16px; line-height: 1.6; color: var(--c-text-primary); word-break: break-word; max-width: 260px;
}
.theme-applied #page-chat-detail .message-wrapper.received.voice-expanded .voice-text-content,
.theme-applied #preview-online-scene .message-wrapper.received.voice-expanded .voice-text-content {
  display: block;
}
/* --- [新增] 引用消息 --- */
.theme-applied #page-chat-detail .message-wrapper.received .message-reply-preview,
.theme-applied #preview-online-scene .message-wrapper.received .message-reply-preview {
  padding: 10px 12px; margin: 8px 12px 0; border-radius: 12px; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-left: 3px solid #dcdcdc; position: relative; background-color: var(--c-bg-secondary); color: var(--c-text-secondary);
}
.theme-applied #page-chat-detail .message-wrapper.received .message-reply-preview strong,
.theme-applied #preview-online-scene .message-wrapper.received .message-reply-preview strong {
  font-weight: 600; color: var(--c-text-primary);
}
`,
     'online-bubble-sent':
`/* (基于最新SCSS更新) 线上 - 用户(你)的气泡与头像 */
/* [容器] 消息整体 */
.theme-applied #page-chat-detail .message-wrapper.sent,
.theme-applied #preview-online-scene .message-wrapper.sent {
  align-self: flex-end;
  flex-direction: row-reverse; /* 头像在右 */
  gap: 8px;
}
/* [头像] */
.theme-applied #page-chat-detail .message-wrapper.sent .chat-avatar-small,
.theme-applied #preview-online-scene .message-wrapper.sent .chat-avatar-small {
  width: 36px; height: 36px;
  border-radius: 50%; object-fit: cover; flex-shrink: 0;
}
/* [基础气泡] 紫色背景 */
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble {
  background-color: #8a6dff; /* 默认紫色 */
  border-radius: 18px; 
  box-shadow: var(--shadow-sm);
  color: white;
}
/* [气泡文字] */
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble p,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble p {
  padding: 8px 12px; margin: 0; font-size: 16px; line-height: 1.5; color: white;
}

/* --- [语音消息] --- */
.theme-applied #page-chat-detail .message-wrapper.sent .voice-bar,
.theme-applied #preview-online-scene .message-wrapper.sent .voice-bar {
  display: flex; align-items: center; flex-direction: row-reverse; gap: 12px;
  height: 44px; padding: 0 14px; width: 180px;
  background-color: #8a6dff; /* 紫色 */
  box-shadow: var(--shadow-sm); border-radius: 18px; 
}
.theme-applied #page-chat-detail .message-wrapper.sent .voice-bar .bar,
.theme-applied #preview-online-scene .message-wrapper.sent .voice-bar .bar {
  background-color: white; 
}
.theme-applied #page-chat-detail .message-wrapper.sent .voice-bar .voice-duration,
.theme-applied #preview-online-scene .message-wrapper.sent .voice-bar .voice-duration {
  color: white; 
}

/* --- [关键更新] 图片消息 (自适应宽高) --- */
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble.gallery-image-bubble,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble.gallery-image-bubble {
  background: transparent !important; box-shadow: none !important; padding: 0 !important; border: none !important;
  max-width: 60%;
  min-height: 50px;
  background-color: #efeff4;
}
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble.gallery-image-bubble img,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble.gallery-image-bubble img {
  border-radius: 12px; display: block; 
  width: 100%; height: auto;
}

/* --- [关键更新] 转账消息 (你发出的) --- */
.theme-applied #page-chat-detail .message-wrapper.sent .is-transfer-message,
.theme-applied #preview-online-scene .message-wrapper.sent .is-transfer-message {
  background: transparent !important; box-shadow: none !important; padding: 0 !important; width: 230px;
}
.theme-applied #page-chat-detail .message-wrapper.sent .transfer-card,
.theme-applied #preview-online-scene .message-wrapper.sent .transfer-card {
  border-radius: 8px; overflow: hidden; width: 100%;
}
/* [新增] 转账图标大小和位置控制 */
.theme-applied #page-chat-detail .message-wrapper.sent .transfer-icon,
.theme-applied #preview-online-scene .message-wrapper.sent .transfer-icon {
  width: 36px; height: 36px; margin-right: 12px; flex-shrink: 0;
}
/* 待收款 (橙色) */
.theme-applied #page-chat-detail .message-wrapper.sent .transfer-pending,
.theme-applied #preview-online-scene .message-wrapper.sent .transfer-pending {
  background-color: #FA9D3B; 
}
.theme-applied #page-chat-detail .message-wrapper.sent .transfer-pending .transfer-text-group p,
.theme-applied #preview-online-scene .message-wrapper.sent .transfer-pending .transfer-text-group p {
  color: white !important;
}
/* 已收款 (米色) */
.theme-applied #page-chat-detail .message-wrapper.sent .transfer-receipt,
.theme-applied #preview-online-scene .message-wrapper.sent .transfer-receipt {
  background-color: #F3E6D3 !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent .transfer-receipt .transfer-text-group p,
.theme-applied #preview-online-scene .message-wrapper.sent .transfer-receipt .transfer-text-group p {
  color: #444 !important;
}

/* --- [新增] 动态卡片 --- */
.theme-applied #page-chat-detail .message-wrapper.sent .is-moment-card,
.theme-applied #preview-online-scene .message-wrapper.sent .is-moment-card {
  padding: 0 !important; width: 240px; background: #fff; border-radius: 10px; overflow: hidden;
  border: 1px solid rgba(0,0,0,0.05);
}
.theme-applied #page-chat-detail .message-wrapper.sent .is-moment-card .mc-header,
.theme-applied #preview-online-scene .message-wrapper.sent .is-moment-card .mc-header {
  background: #f9f9f9; padding: 10px 12px; display: flex; align-items: center; border-bottom: 1px solid #eee;
}
.theme-applied #page-chat-detail .message-wrapper.sent .is-moment-card .mc-text,
.theme-applied #preview-online-scene .message-wrapper.sent .is-moment-card .mc-text {
  font-size: 13px; color: #333; margin-right: 8px;
}

/* --- [新增] 翻译气泡 --- */
.theme-applied #page-chat-detail .message-wrapper.sent .message-translation,
.theme-applied #preview-online-scene .message-wrapper.sent .message-translation {
  border-top: 1px solid rgba(255,255,255,0.2);
  padding: 8px 12px 10px; margin-top: 4px; color: rgba(255,255,255,0.95); font-size: 13px; line-height: 1.6;
}

/* --- [新增] 翻译按钮 (气泡左侧隐形点击区) --- */
.theme-applied #page-chat-detail .message-wrapper.sent .btn-toggle-translation,
.theme-applied #preview-online-scene .message-wrapper.sent .btn-toggle-translation {
  width: 14px; height: 28px; min-width: 14px; min-height: 28px; padding: 0; border: 0; border-radius: 0;
  background: transparent; color: transparent; opacity: 0; cursor: pointer;
  position: absolute; top: 50%; left: -14px; right: auto; transform: translateY(-50%); z-index: 3;
}
/* --- [新增] 语音转文字展开 --- */
.theme-applied #page-chat-detail .message-wrapper.sent .voice-text-content,
.theme-applied #preview-online-scene .message-wrapper.sent .voice-text-content {
  display: none; margin-top: 8px; padding: 10px 14px; background-color: #8a6dff; border-radius: 18px; box-shadow: var(--shadow-sm); font-size: 16px; line-height: 1.6; color: white; word-break: break-word; max-width: 260px;
}
.theme-applied #page-chat-detail .message-wrapper.sent.voice-expanded .voice-text-content,
.theme-applied #preview-online-scene .message-wrapper.sent.voice-expanded .voice-text-content {
  display: block;
}
/* --- [新增] 引用消息 --- */
.theme-applied #page-chat-detail .message-wrapper.sent .message-reply-preview,
.theme-applied #preview-online-scene .message-wrapper.sent .message-reply-preview {
  padding: 10px 12px; margin: 8px 12px 0; border-radius: 12px; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-left: 3px solid rgba(255, 255, 255, 0.4); position: relative; background-color: rgba(0, 0, 0, 0.2); color: rgba(255, 255, 255, 0.9);
}
.theme-applied #page-chat-detail .message-wrapper.sent .message-reply-preview strong,
.theme-applied #preview-online-scene .message-wrapper.sent .message-reply-preview strong {
  font-weight: 600; color: white;
}
`,

   'offline-card-received':
`/* (真实提取) 线下 - 角色(对方)的卡片与头像 */
/* 对应 _offline-mode.scss */
/* [卡片] 角色卡片的整体样式 */
.theme-applied .offline-message-card.is-character {
  background-color: #fff;
  border-radius: 12px;
  padding: 15px;
  margin-bottom: 15px;
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.06);
  border-left-style: dashed;
  border-left-color: #D1D1D6;
}
/* [头像] 角色头像样式 */
.theme-applied .offline-message-card.is-character .sender-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  margin-right: 10px;
}
/* [发送者] 角色名的样式 */
.theme-applied .offline-message-card.is-character .sender-name {
  font-size: calc(13px * var(--looky-font-scale, 1));
  font-weight: 600;
  color: var(--c-text-primary);
}
/* [内容] 卡片正文样式 */
.theme-applied .offline-message-card.is-character .card-body {
  font-size: calc(16px * var(--looky-font-scale, 1));
  line-height: 1.7;
  color: var(--c-text-primary);
  white-space: pre-line; /* 保持换行 */
}
/* [斜体/旁白] 卡片内斜体字样式 */
.theme-applied .offline-message-card.is-character .italic {
  font-style: italic;
  color: var(--c-text-secondary);
}
`,
    'offline-card-sent':
`/* (真实提取) 线下 - 用户(你)的卡片与头像 */
/* 对应 _offline-mode.scss */
/* [卡片] 用户卡片的整体样式 */
.theme-applied .offline-message-card:not(.is-character) {
  background-color: #fff;
  border-radius: 12px;
  padding: 15px;
  margin-bottom: 15px;
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.06);
  border-left: 3px solid var(--c-accent-blue-light);
}
/* [头像] 用户头像样式 */
.theme-applied .offline-message-card:not(.is-character) .sender-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  margin-right: 10px;
}
/* [发送者] 用户名("你")的样式 */
.theme-applied .offline-message-card:not(.is-character) .sender-name {
  font-size: calc(13px * var(--looky-font-scale, 1));
  font-weight: 600;
  color: var(--c-text-primary);
}
/* [内容] 卡片正文样式 */
.theme-applied .offline-message-card:not(.is-character) .card-body {
  font-size: calc(16px * var(--looky-font-scale, 1));
  line-height: 1.7;
  color: var(--c-text-primary);
  white-space: pre-line; /* 保持换行 */
}
`
};
    // ==========================================================
    // (新增) 整体模式切换逻辑 (修复版：手动获取源码)
    // ==========================================================
    
    // 1. 切换显示/隐藏 (不自动填充)
    document.querySelectorAll('.toggle-unified-btn').forEach(unifiedBtn => {
        unifiedBtn.addEventListener('click', () => {
            // 切换按钮视觉状态
            unifiedBtn.classList.toggle('active');
            const isUnified = unifiedBtn.classList.contains('active');
            unifiedBtn.textContent = isUnified ? "分开" : "整体";

            // 找到面板和视图
            const currentCard = unifiedBtn.closest('.settings-card');
            const activePanel = currentCard.querySelector('.beautify-settings-panel.active');
            if (!activePanel) return;

            const splitView = activePanel.querySelector('.split-view');
            const unifiedView = activePanel.querySelector('.unified-view');

            // 切换视图
            if (isUnified) {
                splitView.style.display = 'none';
                unifiedView.style.display = 'block';
            } else {
                splitView.style.display = 'block';
                unifiedView.style.display = 'none';
            }
        });
    });

    // 2. 获取源码按钮逻辑 (点击才填充)
    document.querySelectorAll('.unified-source-trigger').forEach(btn => {
        btn.addEventListener('click', () => {
            const activePanel = btn.closest('.beautify-settings-panel');
            const unifiedTextarea = activePanel.querySelector('.unified-input');
            let combinedCode = "";
            let panelId = activePanel.id; 

            // 根据面板ID拼接代码
            if (panelId === 'bar-settings-chat') {
                combinedCode += (sourceCodeMap['chat-main-header'] || "") + "\n\n" + (sourceCodeMap['chat-main-footer'] || "");
            } else if (panelId === 'bar-settings-chat-detail') {
                combinedCode += (sourceCodeMap['online-header'] || "") + "\n\n" + (sourceCodeMap['online-footer'] || "");
            } else if (panelId === 'bar-settings-offline') {
                combinedCode += (sourceCodeMap['offline-header'] || "") + "\n\n" + (sourceCodeMap['offline-footer'] || "");
            } else if (panelId === 'bubble-settings-online') {
                combinedCode += (sourceCodeMap['online-bubble-received'] || "") + "\n\n" + (sourceCodeMap['online-bubble-sent'] || "");
            } else if (panelId === 'bubble-settings-offline') {
                combinedCode += (sourceCodeMap['offline-card-received'] || "") + "\n\n" + (sourceCodeMap['offline-card-sent'] || "");
            }

            // 填充代码
            if (unifiedTextarea) {
                if (unifiedTextarea.value.trim() === "") {
                    unifiedTextarea.value = combinedCode;
                    alert("源码已提取！");
                } else {
                    if (confirm("输入框不为空，是否覆盖现有代码？")) {
                        unifiedTextarea.value = combinedCode;
                    }
                }
            }
        });
    });

    // 3. Tab 切换监听 (保持视图同步)
    const settingsTabs = document.querySelectorAll('.beautify-settings-tabs .settings-tab');
    settingsTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const currentCard = tab.closest('.settings-card');
            const unifiedBtn = currentCard.querySelector('.toggle-unified-btn');
            if (!unifiedBtn) return;

            const isUnified = unifiedBtn.classList.contains('active');
            
            setTimeout(() => {
                const activePanel = currentCard.querySelector('.beautify-settings-panel.active');
                if(activePanel) {
                    const splitView = activePanel.querySelector('.split-view');
                    const unifiedView = activePanel.querySelector('.unified-view');
                    
                    if(isUnified) {
                        splitView.style.display = 'none';
                        unifiedView.style.display = 'block';
                    } else {
                        if(splitView) splitView.style.display = 'block';
                        if(unifiedView) unifiedView.style.display = 'none';
                    }
                }
            }, 10);
        });
    });

    // (C) 点击“背景图”按钮的逻辑 (修复版)
    const bgModal = document.getElementById('bg-choice-modal-overlay');
    const bgUploadBtn = document.getElementById('bg-choice-upload-btn');
    const bgUrlBtn = document.getElementById('bg-choice-url-btn');
    const bgCancelBtn = document.getElementById('bg-choice-cancel-btn');

    // 1. 绑定按钮点击事件
    const bgTriggers = document.querySelectorAll('.upload-bg-trigger');
    console.log('找到背景图按钮数量:', bgTriggers.length); // 用于调试

    bgTriggers.forEach(btn => {
        btn.addEventListener('click', (e) => {
            console.log('背景图按钮被点击'); // 用于调试
            currentActiveButton = btn; 
            
            // 强制尝试显示弹窗
            if(bgModal) {
                bgModal.style.display = 'flex'; // 强制显示
                setTimeout(() => bgModal.classList.add('visible'), 10);
            } else {
                alert("错误：找不到弹窗元素 (bg-choice-modal-overlay)，请检查 index.html 是否保存");
            }
        });
    });

    // 2. 弹窗内部按钮逻辑
    if (bgModal) {
        // 上传本地图片
        if(bgUploadBtn) {
            bgUploadBtn.onclick = () => {
                closeBgModal();
                fileInput.click();
            };
        }
        // 使用网络链接
        if(bgUrlBtn) {
            bgUrlBtn.onclick = () => {
                closeBgModal();
                const url = prompt("请输入背景图片的链接 (URL):");
                if (url && currentActiveButton) {
                    handleBgImageUpdate(currentActiveButton, url);
                }
            };
        }
        // 取消
        if(bgCancelBtn) {
            bgCancelBtn.onclick = () => {
                closeBgModal();
                currentActiveButton = null;
            };
        }
    }

    function closeBgModal() {
        if(!bgModal) return;
        bgModal.classList.remove('visible');
        setTimeout(() => {
            if(!bgModal.classList.contains('visible')) {
                bgModal.style.display = ''; // 恢复默认 CSS 控制
            }
        }, 300);
    }
    // --- 核心更新函数 ---
    function handleBgImageUpdate(btn, imgUrl) {
        const targetId = btn.dataset.target; // 例如 'preview-chat-main-header'
        
        // 1. 找到对应的缩略图容器 (优先找 Unified 模式下的，找不到再找 Split 模式下的)
        // 逻辑：如果是 unified 模式，按钮在 unified-controls 里，容器就在下面
        // 如果是 split 模式，按钮在 control-grid 里，容器也在下面
        const settingsGroup = btn.closest('.bar-settings-group');
        const thumbContainer = settingsGroup.querySelector('.bg-thumb-container');
        const textArea = settingsGroup.querySelector('.css-override-input');
        // 2. 生成 CSS 代码 (带特殊标记)
        // 标记格式： /* [BG-START:targetId] */ css... /* [BG-END] */
        const bgCssCode = `
/* [BG-START:${targetId}] */
#${targetId} {
    background: url('${imgUrl}') center / cover no-repeat !important;
    border: 0px solid transparent !important;
    border-bottom: none !important;
    border-top: none !important;
    box-shadow: none !important;
}
#${targetId}::after, #${targetId}::before,
#${targetId} .app-header, #${targetId} .chat-input-area, #${targetId} .offline-chat-input-container {
    background: transparent !important;
    border: none !important;
    box-shadow: none !important;
}
/* [BG-END] */
`;
        // 3. 存储 CSS 到 DOM 属性中 (不直接显示在 textarea)
        if (textArea) {
            // 使用 dataset 存储 base64 巨长的代码
            // 区分 Header 和 Footer，避免冲突
            if (targetId.includes('header')) {
                textArea.dataset.bgHeaderCss = bgCssCode;
                textArea.dataset.bgHeaderUrl = imgUrl; // 存 URL 用于缩略图
            } else if (targetId.includes('footer')) {
                textArea.dataset.bgFooterCss = bgCssCode;
                textArea.dataset.bgFooterUrl = imgUrl;
            }
            
            // 触发一次预览更新 (此时虽然 textarea 没有变，但我们需要手动触发 apply)
            // 手动调用应用函数，传入合并后的代码
            applyMixedCss(textArea);
        }
        // 4. 更新缩略图 UI
        if (thumbContainer) {
            updateThumbUI(thumbContainer, targetId, imgUrl, textArea);
        }
        
        alert("背景图已设置！\n代码已隐藏，您可以在上方看到缩略图。");
    }
    // --- 辅助：更新缩略图 UI ---
    function updateThumbUI(container, targetId, imgUrl, associatedTextarea) {
        // 先移除旧的同类型缩略图 (header 或 footer)
        const oldThumb = container.querySelector(`[data-bg-target="${targetId}"]`);
        if (oldThumb) oldThumb.remove();
        const label = targetId.includes('header') ? '顶栏' : '底栏';
        
        const pill = document.createElement('div');
        pill.className = 'bg-thumb-pill';
        pill.dataset.bgTarget = targetId;
        pill.innerHTML = `
            <span>${label}</span>
            <img src="${imgUrl}">
            <button class="btn-remove-bg" title="删除背景">
                <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="3" fill="none"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
        `;
        // 删除按钮逻辑
        pill.querySelector('.btn-remove-bg').addEventListener('click', () => {
            pill.remove();
            // 清除存储的数据
            if (associatedTextarea) {
                if (targetId.includes('header')) {
                    delete associatedTextarea.dataset.bgHeaderCss;
                    delete associatedTextarea.dataset.bgHeaderUrl;
                } else {
                    delete associatedTextarea.dataset.bgFooterCss;
                    delete associatedTextarea.dataset.bgFooterUrl;
                }
                // 刷新预览 (去掉背景)
                applyMixedCss(associatedTextarea);
            }
        });
        container.appendChild(pill);
    }
    // --- 辅助：混合应用 CSS (用户输入 + 隐藏背景) ---
    function applyMixedCss(textarea) {
        let finalCss = textarea.value || '';
        if (textarea.dataset.bgHeaderCss) finalCss += '\n' + textarea.dataset.bgHeaderCss;
        if (textarea.dataset.bgFooterCss) finalCss += '\n' + textarea.dataset.bgFooterCss;
        
        // 找到对应的 style 标签并更新
        // 注意：unified 模式下，textarea 的 data-target 是 '...-unified'，这会导致找不到 preview ID
        // 所以我们需要解析出真实 ID。
        // 但是 _executeApplyThemeConfig 是根据 data-target 来找 style 的。
        // 简单做法：我们不需要在这里直接更新 style 标签，而是触发 'input' 事件，
        // 但 input 事件只读取 value。
        // 所以我们手动构造一个假的 style ID 更新。
        
        // 实际上，applyCurrentThemeConfig 会处理这一切，只要 collectCurrentThemeData 对了就行。
        // 为了即时预览，我们手动注入一下 style
        const styleId = `runtime-bg-preview-${textarea.dataset.target}`;
        let styleTag = document.getElementById(styleId);
        if (!styleTag) {
            styleTag = document.createElement('style');
            styleTag.id = styleId;
            document.head.appendChild(styleTag);
        }
        document.body.classList.add('theme-applied');
        styleTag.innerHTML = window.__lookyScaleFontSizeCssText ? window.__lookyScaleFontSizeCssText(finalCss) : finalCss;
    }
    // (D) 点击“源代码”按钮的逻辑
    document.querySelectorAll('.source-code-trigger').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetKey = btn.dataset.target.replace('-bg', '').replace('preview-', '');
            const originalCode = sourceCodeMap[targetKey] || `/* 未找到 ${targetKey} 的源代码 */`;
            const textarea = btn.closest('.bar-settings-group').querySelector('.css-override-input');
            if (textarea) {
                if (textarea.value.trim() === '') {
                    textarea.value = originalCode;
                }
                alert("已提取原始CSS，您可在下方文本框中修改。\n修改会实时生效。");
            }
        });
    });

// (E) 监听文件选择变化 (通用处理器)
fileInput.addEventListener('change', (e) => {
    if (!e.target.files || !e.target.files[0] || !currentActiveButton) return;
    
    const file = e.target.files[0];
    const reader = new FileReader();

    reader.onload = (evt) => {
        const imgData = evt.target.result;
        if (!currentActiveButton) return;

        // 判断是修改图标还是修改背景图
        if (currentActiveButton.classList.contains('upload-trigger')) {
            // 这是修改图标的逻辑，保持不变
            updateIconPreview(currentActiveButton, imgData);
} else if (currentActiveButton.classList.contains('upload-bg-trigger')) {
    // 直接调用我们刚才写的新函数
    handleBgImageUpdate(currentActiveButton, imgData);
}

        currentActiveButton = null; 
    };

    reader.readAsDataURL(file);
    fileInput.value = '';
});
    document.querySelectorAll('.apply-css-trigger').forEach(btn => {
        btn.addEventListener('click', () => {
            const card = btn.closest('.settings-card');
            const textareas = card.querySelectorAll('.css-override-input');
            
            textareas.forEach(textarea => {
                // 使用新的混合应用函数
                applyMixedCss(textarea);
            });
            alert("预览已更新！");
        });
    });
    // (F) 全局美化代码提取按钮 —— 一次提取所有内置模板源码
    const extractAllCssBtn = document.getElementById('extract-all-css-btn');
    if (extractAllCssBtn) {
        extractAllCssBtn.addEventListener('click', () => {
            const globalTextarea = document.querySelector('.css-override-input[data-target="global-css"]');
            if (!globalTextarea) return;

            // 把 sourceCodeMap 里所有的模板源码按顺序全部拼起来
            const allTemplateKeys = [
                'chat-main-header',
                'chat-main-footer',
                'online-header',
                'online-footer',
                'offline-header',
                'offline-footer',
                'online-bubble-received',
                'online-bubble-sent',
                'offline-card-received',
                'offline-card-sent'
            ];

            let allCss = '';
            allTemplateKeys.forEach(key => {
                if (sourceCodeMap[key]) {
                    allCss += sourceCodeMap[key].trim() + '\n\n';
                }
            });

            if (!allCss.trim()) {
                alert('没有找到可提取的模板源码。');
                return;
            }

            if (globalTextarea.value.trim()) {
                if (!confirm('全局输入框中已有内容，确定要覆盖吗？')) return;
            }

            globalTextarea.value = allCss.trim();
            alert('已成功将全部美化模板源码（聊天主页、聊天详情、线下模式的顶栏底栏 + 气泡与头像共10套）一次性提取到全局输入框中！');
        });
    }
     // ==========================================================
    // (G) 方案保存与修改功能 (V4 - 完整数据保存与另存为)
    // ==========================================================
    
    // 1. 获取所有 DOM 元素
const saveSchemeBtn = document.getElementById('save-theme-scheme-btn');
const saveSchemeModal = document.getElementById('save-scheme-modal-overlay');
const confirmSaveBtn = document.getElementById('confirm-save-scheme-btn');
const cancelSaveBtn = document.getElementById('cancel-save-scheme-btn');
const saveAsNewBtn = document.getElementById('save-as-new-scheme-btn'); // 【新增】获取“另存为”按钮
const schemeNameInput = document.getElementById('scheme-name-input');
const typeChips = document.querySelectorAll('.type-chip');
const schemeList = document.getElementById('theme-scheme-list');
const saveBtnText = document.getElementById('save-btn-text'); // 这是悬浮按钮上的文字
const exportSchemesBtn = document.getElementById('export-theme-schemes-btn');
const schemeImportInput = document.getElementById('scheme-import-input');
    let selectedType = 'all'; 
    let currentEditingId = null;

    // 2. 重置页面函数
    function resetBeautifyPage() {
        document.querySelectorAll('.css-override-input').forEach(input => {
            input.value = '';
            delete input.dataset.bgHeaderCss;
            delete input.dataset.bgHeaderUrl;
            delete input.dataset.bgFooterCss;
            delete input.dataset.bgFooterUrl;        
        });
        document.querySelectorAll('.size-slider').forEach(slider => {
            slider.value = slider.defaultValue || '24';
            slider.dispatchEvent(new Event('input', { bubbles: true })); // 触发更新
        });
        document.querySelectorAll('.bg-thumb-container').forEach(container => {
            container.innerHTML = '';
        });
        document.querySelectorAll('style[id^="theme-style-"]').forEach(styleTag => {
            styleTag.remove();
        });
        document.querySelectorAll('[id^="preview-"]').forEach(el => {
            if (el.style.backgroundImage) el.style.backgroundImage = '';
        });
        
        // 【新增】重置图标预览区为默认 SVG
        document.querySelectorAll('.icon-preview-box, .mock-icon-wrapper').forEach(box => {
            const originalHTML = box.dataset.originalHtml;
            if (originalHTML) {
                box.innerHTML = originalHTML;
            }
        });

        document.body.classList.remove('theme-applied');
        currentEditingId = null;
        if (saveBtnText) saveBtnText.textContent = "保存新方案";
        
        document.querySelectorAll('.scheme-item.active').forEach(item => item.classList.remove('active'));
        const defaultItem = document.getElementById('reset-current-theme-btn');
        if (defaultItem) defaultItem.classList.add('active');

        console.log("页面已重置到初始状态。");
    }
    
    // 3. 核心数据操作函数 (V2 - 支持隐式背景图)
    function collectCurrentThemeData() {
        const data = { 
            cssOverrides: {}, 
            sliders: {}, 
            icons: {},
        };

        // 1. 收集 CSS (合并 用户输入 + 隐藏背景图)
        document.querySelectorAll('.css-override-input').forEach(input => {
            let combinedValue = input.value;
            // 如果有隐藏的背景图代码，拼接到后面
            if (input.dataset.bgHeaderCss) combinedValue += '\n' + input.dataset.bgHeaderCss;
            if (input.dataset.bgFooterCss) combinedValue += '\n' + input.dataset.bgFooterCss;

            if (combinedValue.trim()) {
                data.cssOverrides[input.dataset.target] = combinedValue;
            }
        });
        
        // 2. 收集滑块值
        document.querySelectorAll('.size-slider').forEach(slider => {
            const target = slider.dataset.target || slider.dataset.previewId;
            if (target) data.sliders[target] = slider.value;
        });

        // 3. 收集图标
        document.querySelectorAll('.custom-icon-row').forEach(row => {
            const slider = row.querySelector('.size-slider');
            const targetId = slider?.dataset.target || slider?.dataset.previewId;
            const smallPreviewBox = row.querySelector('.icon-preview-box');
            const img = smallPreviewBox?.querySelector('img');
            if (targetId && img && img.src) data.icons[targetId] = img.src;
        });
        
        return data;
    }

    // 【升级】现在能恢复图标和背景图
  function applyThemeData(themeData) {
        resetBeautifyPage();
        if (!themeData) return;
        // 1. 恢复 CSS (带解析)
        if (themeData.cssOverrides) {
            Object.entries(themeData.cssOverrides).forEach(([target, fullCss]) => {
                const input = document.querySelector(`.css-override-input[data-target="${target}"]`);
                if (input) {
                    // 解析器：分离 BG 代码 和 用户代码
                    // 正则匹配 /* [BG-START:targetId] */ ... /* [BG-END] */
                    const bgRegex = /\/\* \[BG-START:([^\]]+)\] \*\/([\s\S]*?)\/\* \[BG-END\] \*\//g;
                    let match;
                    let cleanCss = fullCss; // 剩下的就是用户代码
                    while ((match = bgRegex.exec(fullCss)) !== null) {
                        const bgTargetId = match[1]; // preview-chat-main-header
                        const bgBlock = match[0];    // 完整代码块
                        const innerContent = match[2]; // 内部 CSS
                        // 从代码中提取 URL 用于显示缩略图
                        const urlMatch = innerContent.match(/url\(['"]?([^'"]+)['"]?\)/);
                        const imgUrl = urlMatch ? urlMatch[1] : null;
                        // 存储到 Dataset
                        if (bgTargetId.includes('header')) {
                            input.dataset.bgHeaderCss = bgBlock;
                            input.dataset.bgHeaderUrl = imgUrl;
                        } else {
                            input.dataset.bgFooterCss = bgBlock;
                            input.dataset.bgFooterUrl = imgUrl;
                        }
                        // 恢复缩略图 UI
                        const group = input.closest('.bar-settings-group');
                        const thumbContainer = group?.querySelector('.bg-thumb-container');
                        if (thumbContainer && imgUrl) {
                            updateThumbUI(thumbContainer, bgTargetId, imgUrl, input);
                        }
                        // 从显示文本中移除这段代码
                        cleanCss = cleanCss.replace(bgBlock, '');
                    }
                    // 剩下的放入输入框
                    input.value = cleanCss.trim();
                    
                    // 触发预览 (此时 dataset 和 value 都准备好了)
                    applyMixedCss(input);
                }
            });
        }
    // 【核心修正】我们换一种更可靠的方式来恢复滑块和图标
    // 延迟执行，确保CSS和背景图先生效
    setTimeout(() => {
        // 2. 遍历美化页面上所有的图标设置行
        document.querySelectorAll('.custom-icon-row').forEach(row => {
            const slider = row.querySelector('.size-slider');
            const btn = row.querySelector('.upload-trigger');
            
            if (!slider || !btn) return;
            // 统一获取目标ID (兼容旧的 data-target 和新的 data-preview-id)
            const targetId = slider.dataset.target || slider.dataset.previewId;
            if (!targetId) return;
            // 3. 恢复滑块的值
            if (themeData.sliders && themeData.sliders[targetId]) {
                slider.value = themeData.sliders[targetId];
                // 触发 input 事件，让预览区的大小也跟着变
                slider.dispatchEvent(new Event('input', { bubbles: true }));
            }
            // 4. 恢复图标
            if (themeData.icons && themeData.icons[targetId]) {
                // 调用我们已有的 updateIconPreview 函数来更新预览，这是最安全的方式
                updateIconPreview(btn, themeData.icons[targetId]);
            }
        });
        console.log("已成功加载并应用已存方案到编辑器。");
    }, 50); // 50毫秒的延迟足够了
}

    // 4. 事件绑定
    // 打开弹窗的逻辑
    if (saveSchemeBtn) {
        saveSchemeBtn.addEventListener('click', () => {
            if (!saveSchemeModal) return;
            
            // 【逻辑修正】根据是否在编辑模式，决定按钮和文字
            if (currentEditingId) {
                if (confirmSaveBtn) confirmSaveBtn.textContent = "确认修改";
                if (saveAsNewBtn) saveAsNewBtn.style.display = 'inline-block';
            } else {
                if (confirmSaveBtn) confirmSaveBtn.textContent = "保存方案";
                if (saveAsNewBtn) saveAsNewBtn.style.display = 'none';
                schemeNameInput.value = '';
            }

            selectedType = 'all';
            updateChipUI();
            saveSchemeModal.classList.add('visible');
            setTimeout(() => schemeNameInput.focus(), 100);
        });
    }

    // 保存或修改
    if (confirmSaveBtn) {
        confirmSaveBtn.addEventListener('click', async () => await handleSave(false));
    }
    // 另存为
    if (saveAsNewBtn) {
        saveAsNewBtn.addEventListener('click', async () => await handleSave(true));
    }
    // 统一的保存处理函数
   async function handleSave(isSaveAsNew) {
// 修改处：在函数开头添加延迟执行逻辑
        const name = schemeNameInput.value.trim();
        if (!name) return alert("请输入方案名称！");
        // 核心修改：使用 setTimeout 稍微推迟重型任务，给 UI 喘息机会
        confirmSaveBtn.textContent = "正在处理...";
        confirmSaveBtn.disabled = true;
        setTimeout(async () => {
            const themeData = collectCurrentThemeData();
            const schemePayload = { name, type: selectedType, typeName: getTypeName(selectedType), date: new Date().toLocaleDateString(), data: themeData };
            try {
                if (isSaveAsNew || !currentEditingId) {
                    await db.themeSchemes.add(schemePayload);
                    alert(`新方案 "${name}" 已保存！`);
                } else {
                    await db.themeSchemes.update(currentEditingId, schemePayload);
                    alert(`方案 "${name}" 已更新！`);
                }
                closeSaveModal();
                await loadSavedSchemes();
                notifyThemeSchemesUpdated();
                resetBeautifyPage();
            } catch (error) {
                console.error("保存失败:", error);
            } finally {
                confirmSaveBtn.textContent = currentEditingId ? "确认修改" : "保存方案";
                confirmSaveBtn.disabled = false;
            }
        }, 100); // 延迟 100 毫秒执行
    }
    // 其他弹窗控制
    function closeSaveModal() { if (saveSchemeModal) saveSchemeModal.classList.remove('visible'); }
    if (cancelSaveBtn) cancelSaveBtn.addEventListener('click', closeSaveModal);
    typeChips.forEach(chip => chip.addEventListener('click', () => {
        selectedType = chip.dataset.value;
        updateChipUI();
    }));
    function updateChipUI() {
        typeChips.forEach(chip => chip.classList.toggle('active', chip.dataset.value === selectedType));
    }
/**
 * 渲染单行 (按需加载版)
 */
function renderSchemeItem(scheme) {
    const itemDiv = document.createElement('div');
    itemDiv.className = 'scheme-item';
    itemDiv.dataset.id = scheme.id;
    itemDiv.innerHTML = `
        <input type="checkbox" class="scheme-select-checkbox" data-id="${scheme.id}">
        <div>
            <span class="name">${scheme.name}</span>
            <span style="font-size:10px; color:#8e8e93; display: block; margin-top: 2px;">${scheme.typeName} · ${scheme.date}</span>
        </div>
        <div style="display:flex; gap:8px;">
             <button class="btn-mini delete-scheme-btn" style="color:#ff3b30; border-color:#ff3b30;">删除</button>
             <button class="btn-mini modify-scheme-btn">修改</button>
        </div>
    `;
    schemeList.appendChild(itemDiv);

    // 删除按钮
    itemDiv.querySelector('.delete-scheme-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`确定要删除方案 "${scheme.name}" 吗？`)) {
            await db.transaction('rw', db.themeSchemes, db.themeApplications, async () => {
                await db.themeSchemes.delete(scheme.id);
                // 同步删除引用该方案的应用规则，兼容旧数据里数字/字符串两种 schemeId。
                await db.themeApplications.where('schemeId').equals(scheme.id).delete();
                const legacySchemeId = String(scheme.id);
                if (legacySchemeId !== scheme.id) {
                    await db.themeApplications.where('schemeId').equals(legacySchemeId).delete();
                }
            });
            itemDiv.remove();
            if (currentEditingId === scheme.id) resetBeautifyPage();
            notifyThemeSchemesUpdated();
        }
    });
    
    // 【核心修改】修改按钮 - 点击时才去数据库取图片数据
    itemDiv.querySelector('.modify-scheme-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        
        // 1. 临时从数据库读取完整数据 (包含图片)
        const fullScheme = await db.themeSchemes.get(scheme.id);
        
        if (fullScheme && fullScheme.data) {
            applyThemeData(fullScheme.data); // 应用样式
            currentEditingId = scheme.id;
            schemeNameInput.value = scheme.name; 
            if (saveBtnText) saveBtnText.textContent = "保存修改";
            
            // 样式处理
            document.querySelectorAll('.scheme-item.active').forEach(item => item.classList.remove('active'));
            itemDiv.classList.add('active');
        } else {
            alert("读取方案数据失败，可能已被删除。");
        }
    });

    // 选中整行
    itemDiv.addEventListener('click', (e) => {
        if (e.target.type !== 'checkbox' && !e.target.closest('button')) {
            const checkbox = itemDiv.querySelector('.scheme-select-checkbox');
            checkbox.checked = !checkbox.checked;
        }
    });
}
/**
 * 加载列表 (性能优化版：不加载图片数据)
 */
const KKT_ONLINE_BUBBLE_RECEIVED_CSS = `
/* KKT - received bubble */
.theme-applied #page-chat-detail .message-wrapper.received,
.theme-applied #preview-online-scene .message-wrapper.received { align-self: flex-start; display: flex; align-items: flex-start; gap: 8px; margin-top: 22px; position: relative; max-width: calc(100% - 20px); }
.theme-applied #page-chat-detail .message-wrapper.received > .chat-avatar-small + div,
.theme-applied #preview-online-scene .message-wrapper.received > .chat-avatar-small + div { max-width: calc(100% - 48px); min-width: 0; }
.theme-applied #page-chat-detail .message-wrapper.is-group-chat .group-message-nameplate,
.theme-applied #preview-online-scene .message-wrapper.is-group-chat .group-message-nameplate { display: none !important; }
.theme-applied #page-chat-detail .message-wrapper.received .chat-avatar-small,
.theme-applied #preview-online-scene .message-wrapper.received .chat-avatar-small { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; flex-shrink: 0; display: block; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble,
.theme-applied #page-chat-detail .message-wrapper.received .voice-bar,
.theme-applied #preview-online-scene .message-wrapper.received .voice-bar { position: relative; z-index: 0; background-color: #ffffff; border-radius: 15px; box-shadow: none; margin-top: 17px; margin-left: 0; overflow: visible; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble::before,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble::before { content: attr(data-beautify-name); position: absolute; bottom: 100%; left: 4px; margin-bottom: 4px; max-width: 160px; font-size: 13px; font-weight: 500; color: #8c8c8c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; pointer-events: none; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble::after,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble::after { content: ''; position: absolute; top: -4px; left: -7px; width: 15px; height: 22px; background-image: url('https://i.postimg.cc/C1GvJSnR/IMG-20251223-112035.png'); background-size: 100% 100%; background-repeat: no-repeat; z-index: -1; display: block; pointer-events: none; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble:not(.is-transfer-message) p,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble:not(.is-transfer-message) p { padding: 8px 12px; margin: 0; font-size: 16px; line-height: 1.5; color: var(--c-text-primary); word-break: break-word; }
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .chat-avatar-small,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .chat-avatar-small { display: none !important; }
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble::before,
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble::after,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble::before,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble::after { display: none !important; }
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat),
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) { margin-top: 0 !important; transform: none !important; }
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble,
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .voice-bar,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .voice-bar { margin-top: 0 !important; margin-left: 48px !important; }
.theme-applied #page-chat-detail .message-wrapper.sent + .message-wrapper.received,
.theme-applied #preview-online-scene .message-wrapper.sent + .message-wrapper.received { margin-top: 0 !important; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble:has(.message-reply-preview),
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble:has(.message-reply-preview) { min-width: 220px; overflow: hidden; }
.theme-applied #page-chat-detail .message-wrapper.received .message-reply-preview,
.theme-applied #preview-online-scene .message-wrapper.received .message-reply-preview { order: 0; margin: 0; padding: 10px 13px 9px; border: 0; border-bottom: 1px solid rgba(0,0,0,0.08); border-radius: 0; background: transparent; color: rgba(40,40,40,0.76); font-size: 14px; line-height: 1.35; max-width: 100%; white-space: normal; overflow: hidden; text-overflow: ellipsis; }
.theme-applied #page-chat-detail .message-wrapper.received .message-reply-preview strong,
.theme-applied #preview-online-scene .message-wrapper.received .message-reply-preview strong { display: block; margin-bottom: 2px; color: rgba(25,25,25,0.92); font-weight: 700; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble:has(.message-reply-preview) > p,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble:has(.message-reply-preview) > p { order: 1; padding-top: 9px; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble.is-transfer-message,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble.is-transfer-message { padding: 0; background: transparent; box-shadow: none; width: min(300px, calc(100vw - 118px)); border-radius: 16px; overflow: visible; }
`;

const KKT_ONLINE_BUBBLE_SENT_CSS = `
/* KKT - sent bubble */
.theme-applied #page-chat-detail .message-wrapper.sent,
.theme-applied #preview-online-scene .message-wrapper.sent { align-self: flex-end; flex-direction: row-reverse; display: flex; align-items: flex-start; gap: 8px; margin-top: 22px; position: relative; padding-right: 15px; max-width: calc(100% - 20px); }
.theme-applied #page-chat-detail .message-wrapper.sent .chat-avatar-small,
.theme-applied #preview-online-scene .message-wrapper.sent .chat-avatar-small { display: none !important; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble,
.theme-applied #page-chat-detail .message-wrapper.sent .voice-bar,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble,
.theme-applied #preview-online-scene .message-wrapper.sent .voice-bar { position: relative; z-index: 0; background-color: #EEDC00; border-radius: 15px; box-shadow: none; margin-top: 17px; overflow: visible; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble:not(.is-transfer-message) p,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble:not(.is-transfer-message) p { padding: 8px 12px; margin: 0; font-size: 16px; line-height: 1.5; color: #2c2c2c; word-break: break-word; }
.theme-applied #page-chat-detail .message-wrapper.sent .voice-bar,
.theme-applied #preview-online-scene .message-wrapper.sent .voice-bar { display: flex; align-items: center; flex-direction: row-reverse; gap: 12px; height: 44px; padding: 0 14px; width: 150px; box-sizing: border-box; }
.theme-applied #page-chat-detail .message-wrapper.sent .voice-bar .bar,
.theme-applied #preview-online-scene .message-wrapper.sent .voice-bar .bar { background-color: #2c2c2c; }
.theme-applied #page-chat-detail .message-wrapper.sent .voice-bar .voice-duration,
.theme-applied #preview-online-scene .message-wrapper.sent .voice-bar .voice-duration { color: #2c2c2c; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble::before,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble::before { display: none !important; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble::after,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble::after { content: ''; position: absolute; top: -4px; right: -7px; width: 15px; height: 22px; background-image: url('https://i.postimg.cc/J41F6DQ2/IMG-20251223-112020.png'); background-size: 100% 100%; background-repeat: no-repeat; z-index: -1; display: block; pointer-events: none; }
.theme-applied #page-chat-detail .message-wrapper.sent + .message-wrapper.sent,
.theme-applied #preview-online-scene .message-wrapper.sent + .message-wrapper.sent { margin-top: 0 !important; transform: none !important; }
.theme-applied #page-chat-detail .message-wrapper.sent + .message-wrapper.sent .message-bubble,
.theme-applied #page-chat-detail .message-wrapper.sent + .message-wrapper.sent .voice-bar,
.theme-applied #preview-online-scene .message-wrapper.sent + .message-wrapper.sent .message-bubble,
.theme-applied #preview-online-scene .message-wrapper.sent + .message-wrapper.sent .voice-bar { margin-top: 0 !important; }
.theme-applied #page-chat-detail .message-wrapper.sent + .message-wrapper.sent .message-bubble::after,
.theme-applied #preview-online-scene .message-wrapper.sent + .message-wrapper.sent .message-bubble::after { display: none !important; }
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.sent,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.sent { margin-top: 0 !important; }
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.sent .message-bubble,
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.sent .voice-bar,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.sent .message-bubble,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.sent .voice-bar { margin-top: 0 !important; }
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.sent .message-bubble::after,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.sent .message-bubble::after { display: block !important; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble:has(.message-reply-preview),
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble:has(.message-reply-preview) { min-width: 220px; overflow: hidden; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-reply-preview,
.theme-applied #preview-online-scene .message-wrapper.sent .message-reply-preview { order: 0; margin: 0; padding: 10px 13px 9px; border: 0; border-bottom: 1px solid rgba(0,0,0,0.10); border-radius: 0; background: transparent; color: rgba(44,44,44,0.78); font-size: 14px; line-height: 1.35; max-width: 100%; white-space: normal; overflow: hidden; text-overflow: ellipsis; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-reply-preview strong,
.theme-applied #preview-online-scene .message-wrapper.sent .message-reply-preview strong { display: block; margin-bottom: 2px; color: rgba(20,20,20,0.95); font-weight: 700; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble:has(.message-reply-preview) > p,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble:has(.message-reply-preview) > p { order: 1; padding-top: 9px; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble.is-transfer-message,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble.is-transfer-message { padding: 0; background: transparent; box-shadow: none; width: min(300px, calc(100vw - 76px)); border-radius: 16px; overflow: visible; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-card,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-card { width: 100%; min-height: 332px; position: relative; overflow: hidden; border-radius: 16px; background: #fff; box-shadow: 0 10px 20px rgba(0,0,0,0.08); border: 0; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-card::before,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-card::before { content: 'kakao'; position: absolute; right: 16px; top: 16px; width: 48px; height: 48px; border-radius: 50%; background: #3d3d3d; color: #fff; z-index: 3; display: flex; align-items: center; justify-content: center; font-size: 16px; letter-spacing: 0; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-content-wrapper,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-content-wrapper { min-height: 238px; padding: 0; display: block; position: relative; background: linear-gradient(to bottom, #ffe500 0 56%, #ffffff 56% 100%); }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-content-wrapper::before,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-content-wrapper::before { content: '송금보내요'; position: absolute; left: 22px; top: 34px; z-index: 2; color: #202124; font-size: 29px; line-height: 1.15; font-weight: 800; letter-spacing: 0; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-content-wrapper::after,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-content-wrapper::after { content: ''; position: absolute; right: 18px; top: 82px; width: 118px; height: 118px; z-index: 2; background: url('./images/kkt-transfer-bear.jpg') center / contain no-repeat; pointer-events: none; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-icon,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-icon { display: none !important; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-text-group,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-text-group { position: absolute; left: 22px; right: 22px; top: 158px; z-index: 4; display: flex; flex-direction: column; gap: 6px; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-text-group p,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-text-group p { padding: 0; margin: 0; color: #1f1f1f; line-height: 1.35; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-text-group .amount,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-text-group .amount { font-size: 27px; font-weight: 500; letter-spacing: 0; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-text-group .status-text,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-text-group .status-text { max-width: 210px; color: #8b8b8b; font-size: 18px; font-weight: 400; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-card.transfer-pending .transfer-text-group::after,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-card.transfer-pending .transfer-text-group::after { content: '송금 받기'; margin-top: 16px; height: 44px; border-radius: 8px; background: #f3f3f3; color: #222; display: flex; align-items: center; justify-content: center; font-size: 19px; font-weight: 500; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-footer,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-footer { height: 48px; padding: 0 18px; display: flex; align-items: center; border-top: 1px solid #f0f0f0; background: #fff; color: transparent; font-size: 0; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-footer::before,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-footer::before { content: 'pay'; width: 22px; height: 22px; margin-right: 8px; border-radius: 7px; background: #ffe500; color: #111; display: inline-flex; align-items: center; justify-content: center; font-size: 8px; font-weight: 800; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-footer::after,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-footer::after { content: '카카오페이  ›'; color: #8a8a8a; font-size: 18px; line-height: 1; flex: 1; }
`;

const KKT_ONLINE_BUBBLE_RECEIVED_CSS_FIXED = `
/* KKT - received bubble fixed */
.theme-applied #page-chat-detail .chat-message-list,
.theme-applied #preview-online-scene .chat-message-list { gap: 8px !important; row-gap: 8px !important; }
.theme-applied #page-chat-detail .message-wrapper.received,
.theme-applied #preview-online-scene .message-wrapper.received { align-self: flex-start; display: flex; align-items: flex-start; gap: 8px; margin-top: 22px; position: relative; max-width: calc(100% - 20px); }
.theme-applied #page-chat-detail .message-wrapper.received > .chat-avatar-small + div,
.theme-applied #preview-online-scene .message-wrapper.received > .chat-avatar-small + div { max-width: calc(100% - 48px); min-width: 0; }
.theme-applied #page-chat-detail .message-wrapper.is-group-chat .group-message-nameplate,
.theme-applied #preview-online-scene .message-wrapper.is-group-chat .group-message-nameplate { display: none !important; }
.theme-applied #page-chat-detail .message-wrapper.received .chat-avatar-small,
.theme-applied #preview-online-scene .message-wrapper.received .chat-avatar-small { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; flex-shrink: 0; display: block; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble:not(.is-voice-message):not(.is-transfer-message) { position: relative; z-index: 0; background-color: #ffffff; border-radius: 15px; box-shadow: none; margin-top: 17px; margin-left: 0; overflow: visible; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble.is-voice-message,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble.is-voice-message { position: relative; z-index: 0; background-color: #ffffff !important; border-radius: 15px !important; box-shadow: none !important; margin-top: 17px; margin-left: 0; overflow: visible; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble:not(.is-voice-message):not(.is-transfer-message)::before,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble:not(.is-voice-message):not(.is-transfer-message)::before { content: attr(data-beautify-name); position: absolute; bottom: 100%; left: 4px; margin-bottom: 4px; max-width: 160px; font-size: 13px; font-weight: 500; color: #8c8c8c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; pointer-events: none; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble:not(.is-voice-message):not(.is-transfer-message)::after,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble:not(.is-voice-message):not(.is-transfer-message)::after { content: ''; position: absolute; top: -4px; left: -7px; width: 15px; height: 22px; background-image: url('https://i.postimg.cc/C1GvJSnR/IMG-20251223-112035.png'); background-size: 100% 100%; background-repeat: no-repeat; z-index: -1; display: block; pointer-events: none; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble:not(.is-transfer-message) p,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble:not(.is-transfer-message) p { padding: 8px 12px; margin: 0; font-size: 16px; line-height: 1.5; color: var(--c-text-primary); word-break: break-word; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble.is-voice-message .voice-bar,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble.is-voice-message .voice-bar { position: relative; z-index: 0; background-color: #ffffff !important; border-radius: 15px !important; box-shadow: none !important; margin-top: 0 !important; margin-left: 0; overflow: visible; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble.is-voice-message .voice-bar .voice-duration,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble.is-voice-message .voice-bar .voice-duration { color: #111111; }
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .chat-avatar-small,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .chat-avatar-small { display: none !important; }
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble:not(.is-voice-message):not(.is-transfer-message)::before,
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble:not(.is-voice-message):not(.is-transfer-message)::after,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble:not(.is-voice-message):not(.is-transfer-message)::before,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble:not(.is-voice-message):not(.is-transfer-message)::after { display: none !important; }
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat),
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) { margin-top: 0 !important; transform: none !important; }
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble.is-voice-message,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble.is-voice-message { margin-top: 0 !important; margin-left: 48px !important; }
.theme-applied #page-chat-detail .message-wrapper.sent + .message-wrapper.received,
.theme-applied #preview-online-scene .message-wrapper.sent + .message-wrapper.received { margin-top: 0 !important; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble:not(.is-voice-message):has(.message-reply-preview),
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble:not(.is-voice-message):has(.message-reply-preview) { min-width: 220px; overflow: hidden; }
.theme-applied #page-chat-detail .message-wrapper.received .message-reply-preview,
.theme-applied #preview-online-scene .message-wrapper.received .message-reply-preview { order: 0; margin: 0; padding: 10px 13px 9px; border: 0; border-bottom: 1px solid rgba(0,0,0,0.08); border-radius: 0; background: transparent; color: rgba(40,40,40,0.76); font-size: 14px; line-height: 1.35; max-width: 100%; white-space: normal; overflow: hidden; text-overflow: ellipsis; }
.theme-applied #page-chat-detail .message-wrapper.received .message-reply-preview strong,
.theme-applied #preview-online-scene .message-wrapper.received .message-reply-preview strong { display: block; margin-bottom: 2px; color: rgba(25,25,25,0.92); font-weight: 700; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble:not(.is-voice-message):has(.message-reply-preview) > p,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble:not(.is-voice-message):has(.message-reply-preview) > p { order: 1; padding-top: 9px; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble.is-transfer-message,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble.is-transfer-message { padding: 0; background: transparent; box-shadow: none; width: min(260px, calc(100vw - 118px)); border-radius: 16px; overflow: visible; margin-top: 17px; }
`;

const KKT_ONLINE_BUBBLE_SENT_CSS_FIXED = `
/* KKT - sent bubble fixed */
.theme-applied #page-chat-detail .message-wrapper.sent,
.theme-applied #preview-online-scene .message-wrapper.sent { align-self: flex-end; flex-direction: row-reverse; display: flex; align-items: flex-start; gap: 8px; margin-top: 22px; position: relative; padding-right: 15px; max-width: calc(100% - 20px); }
.theme-applied #page-chat-detail .message-wrapper.sent .chat-avatar-small,
.theme-applied #preview-online-scene .message-wrapper.sent .chat-avatar-small { display: none !important; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message) { position: relative; z-index: 0; background-color: #EEDC00; border-radius: 15px; box-shadow: none; margin-top: 17px; overflow: visible; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble:not(.is-transfer-message) p,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble:not(.is-transfer-message) p { padding: 8px 12px; margin: 0; font-size: 16px; line-height: 1.5; color: #2c2c2c; word-break: break-word; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble.is-voice-message,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble.is-voice-message { position: relative; z-index: 0; background-color: #EEDC00 !important; border-radius: 15px !important; box-shadow: none !important; margin-top: 17px; overflow: visible; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message)::before,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message)::before { display: none !important; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message)::after,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message)::after { content: ''; position: absolute; top: 1px; right: -4px; width: 12px; height: 12px; background-image: url('./images/kkt-sent-tail.png'); background-size: 100% 100%; background-repeat: no-repeat; z-index: -1; display: block; pointer-events: none; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble.is-voice-message .voice-bar,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble.is-voice-message .voice-bar { display: flex; align-items: center; flex-direction: row-reverse; gap: 12px; height: 44px; padding: 0 14px; width: 150px; box-sizing: border-box; background-color: #EEDC00 !important; border-radius: 15px !important; box-shadow: none !important; margin-top: 0 !important; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble.is-voice-message .voice-bar .bar,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble.is-voice-message .voice-bar .bar { background-color: #2c2c2c; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble.is-voice-message .voice-bar .voice-duration,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble.is-voice-message .voice-bar .voice-duration { color: #2c2c2c; }
.theme-applied #page-chat-detail .message-wrapper.sent + .message-wrapper.sent,
.theme-applied #preview-online-scene .message-wrapper.sent + .message-wrapper.sent { margin-top: 0 !important; transform: none !important; }
.theme-applied #page-chat-detail .message-wrapper.sent + .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.sent + .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #page-chat-detail .message-wrapper.sent + .message-wrapper.sent .message-bubble.is-voice-message,
.theme-applied #preview-online-scene .message-wrapper.sent + .message-wrapper.sent .message-bubble.is-voice-message { margin-top: 0 !important; }
.theme-applied #page-chat-detail .message-wrapper.sent + .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message)::after,
.theme-applied #preview-online-scene .message-wrapper.sent + .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message)::after { display: none !important; }
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.sent,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.sent { margin-top: 0 !important; }
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.sent .message-bubble.is-voice-message,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.sent .message-bubble.is-voice-message { margin-top: 0 !important; }
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message)::after,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message)::after { display: block !important; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble:not(.is-voice-message):has(.message-reply-preview),
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble:not(.is-voice-message):has(.message-reply-preview) { min-width: 220px; overflow: hidden; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-reply-preview,
.theme-applied #preview-online-scene .message-wrapper.sent .message-reply-preview { order: 0; margin: 0; padding: 10px 13px 9px; border: 0; border-bottom: 1px solid rgba(0,0,0,0.10); border-radius: 0; background: transparent; color: rgba(44,44,44,0.78); font-size: 14px; line-height: 1.35; max-width: 100%; white-space: normal; overflow: hidden; text-overflow: ellipsis; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-reply-preview strong,
.theme-applied #preview-online-scene .message-wrapper.sent .message-reply-preview strong { display: block; margin-bottom: 2px; color: rgba(20,20,20,0.95); font-weight: 700; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble:not(.is-voice-message):has(.message-reply-preview) > p,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble:not(.is-voice-message):has(.message-reply-preview) > p { order: 1; padding-top: 9px; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble.is-transfer-message,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble.is-transfer-message { padding: 0; background: transparent; box-shadow: none; width: min(260px, calc(100vw - 76px)); border-radius: 16px; overflow: visible; margin-top: 17px; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-card,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-card { width: 100%; min-height: 0; position: relative; overflow: hidden; border-radius: 16px; background: #fff !important; box-shadow: 0 8px 16px rgba(0,0,0,0.08); border: 0; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-card::after,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-card::after { display: none !important; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-card::before,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-card::before { content: 'kakao'; position: absolute; right: 12px; top: 12px; width: 42px; height: 42px; border-radius: 50%; background: #3d3d3d; color: #fff; z-index: 3; display: flex; align-items: center; justify-content: center; font-size: 14px; letter-spacing: 0; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-content-wrapper,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-content-wrapper { min-height: 248px; padding: 0; display: block; position: relative; background: linear-gradient(to bottom, #ffe500 0 52%, #ffffff 52% 100%); }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-content-wrapper::before,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-content-wrapper::before { content: '송금보내요'; position: absolute; left: 20px; top: 28px; z-index: 2; color: #202124; font-size: 25px; line-height: 1.15; font-weight: 800; letter-spacing: 0; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-content-wrapper::after,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-content-wrapper::after { content: ''; position: absolute; right: 16px; top: 76px; width: 90px; height: 90px; z-index: 2; background: url('./images/kkt-transfer-bear.png') center / contain no-repeat; pointer-events: none; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-icon,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-icon { display: none !important; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-text-group,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-text-group { position: absolute; left: 20px; right: 20px; top: 144px; z-index: 4; display: flex; flex-direction: column; gap: 4px; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-text-group p,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-text-group p { padding: 0; margin: 0; color: #1f1f1f; line-height: 1.35; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-text-group .amount,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-text-group .amount { font-size: 24px; font-weight: 500; letter-spacing: 0; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-text-group .status-text,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-text-group .status-text { max-width: 178px; color: #8b8b8b; font-size: 15px; font-weight: 400; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-card.transfer-pending .transfer-text-group::after,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-card.transfer-pending .transfer-text-group::after { content: '송금 받기'; margin-top: 10px; height: 36px; border-radius: 8px; background: #f3f3f3; color: #222; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 500; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-footer,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-footer { height: 40px; padding: 0 16px; display: flex; align-items: center; border-top: 1px solid #f0f0f0; background: #fff; color: transparent; font-size: 0; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-footer::before,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-footer::before { content: 'pay'; width: 20px; height: 20px; margin-right: 8px; border-radius: 7px; background: #ffe500; color: #111; display: inline-flex; align-items: center; justify-content: center; font-size: 8px; font-weight: 800; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-footer::after,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-footer::after { content: '카카오페이  ›'; color: #8a8a8a; font-size: 15px; line-height: 1; flex: 1; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble.is-transfer-message,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble.is-transfer-message { width: min(240px, calc(100vw - 118px)); margin-left: 12px !important; border-radius: 14px; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble.is-transfer-message,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble.is-transfer-message { width: min(240px, calc(100vw - 76px)); border-radius: 14px; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble.is-voice-message,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble.is-voice-message { margin-left: 12px !important; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-card,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-card { border-radius: 14px; box-shadow: 0 7px 14px rgba(0,0,0,0.08); }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-card::before,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-card::before { right: 11px; top: 11px; width: 38px; height: 38px; font-size: 13px; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-content-wrapper,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-content-wrapper { min-height: 220px; background: linear-gradient(to bottom, #ffe500 0 51%, #ffffff 51% 100%); }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-content-wrapper::before,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-content-wrapper::before { left: 18px; top: 25px; font-size: 23px; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-content-wrapper::after,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-content-wrapper::after { right: 15px; top: 68px; width: 78px; height: 78px; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-text-group,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-text-group { left: 18px; right: 18px; top: 126px; gap: 3px; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-text-group .amount,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-text-group .amount { font-size: 22px; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-text-group .status-text,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-text-group .status-text { max-width: 166px; font-size: 14px; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-card.transfer-pending .transfer-text-group::after,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-card.transfer-pending .transfer-text-group::after { position: absolute; left: 0; right: 0; top: 58px; margin-top: 0; height: 30px; border-radius: 7px; font-size: 14px; box-sizing: border-box; z-index: 2; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-card.transfer-pending .transfer-text-group,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-card.transfer-pending .transfer-text-group { top: 108px; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-card.transfer-pending .transfer-text-group .status-text,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-card.transfer-pending .transfer-text-group .status-text { max-width: 166px; max-height: 16px; line-height: 16px; overflow: hidden; display: block; white-space: nowrap; text-overflow: ellipsis; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-footer,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-footer { height: 36px; padding: 0 14px; }
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble.is-transfer-message,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble.is-transfer-message,
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble.is-voice-message,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble.is-voice-message { margin-left: 48px !important; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-card,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-card { height: 234px !important; min-height: 0 !important; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-content-wrapper,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-content-wrapper { height: 198px !important; min-height: 198px !important; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-content-wrapper::after,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-content-wrapper::after { top: 60px; width: 70px; height: 70px; }
.theme-applied #page-chat-detail .message-bubble.is-transfer-message .transfer-text-group,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message .transfer-text-group { top: 112px; }
.theme-applied #page-chat-detail .message-wrapper.received .chat-avatar-small,
.theme-applied #preview-online-scene .message-wrapper.received .chat-avatar-small { width: 34px !important; height: 34px !important; border-radius: 7px !important; }
.theme-applied #page-chat-detail .message-wrapper.received > .chat-avatar-small + div,
.theme-applied #preview-online-scene .message-wrapper.received > .chat-avatar-small + div { max-width: calc(100% - 42px); }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble:not(.is-transfer-message) p,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble:not(.is-transfer-message) p,
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble:not(.is-transfer-message) p,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble:not(.is-transfer-message) p { padding: 6px 10px !important; font-size: 14px !important; line-height: 1.45 !important; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message) { border-radius: 13px; }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble:not(.is-voice-message):not(.is-transfer-message)::before,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble:not(.is-voice-message):not(.is-transfer-message)::before { font-size: 12px; margin-bottom: 3px; }
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble.is-transfer-message,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble.is-transfer-message,
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble.is-voice-message,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble.is-voice-message { margin-left: 42px !important; }
.theme-applied #page-chat-detail .message-wrapper.received .message-reply-preview,
.theme-applied #preview-online-scene .message-wrapper.received .message-reply-preview,
.theme-applied #page-chat-detail .message-wrapper.sent .message-reply-preview,
.theme-applied #preview-online-scene .message-wrapper.sent .message-reply-preview { padding: 8px 10px 7px !important; font-size: 12px !important; }
.theme-applied #page-chat-detail .message-wrapper.received .chat-avatar-small,
.theme-applied #preview-online-scene .message-wrapper.received .chat-avatar-small { width: 36px !important; height: 36px !important; border-radius: 7px !important; }
.theme-applied #page-chat-detail .message-wrapper.received > .chat-avatar-small + div,
.theme-applied #preview-online-scene .message-wrapper.received > .chat-avatar-small + div { max-width: calc(100% - 44px); }
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble:not(.is-transfer-message) p,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble:not(.is-transfer-message) p,
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble:not(.is-transfer-message) p,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble:not(.is-transfer-message) p { padding: 7px 11px !important; font-size: 15px !important; line-height: 1.45 !important; }
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message) { background-color: #ffe500 !important; }
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble.is-transfer-message,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble.is-transfer-message,
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble.is-voice-message,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:not(.is-group-chat) .message-bubble.is-voice-message { margin-left: 44px !important; }
.theme-applied #page-chat-detail .message-wrapper.received .message-reply-preview,
.theme-applied #preview-online-scene .message-wrapper.received .message-reply-preview,
.theme-applied #page-chat-detail .message-wrapper.sent .message-reply-preview,
.theme-applied #preview-online-scene .message-wrapper.sent .message-reply-preview { padding: 9px 11px 8px !important; font-size: 13px !important; }
.theme-applied #page-chat-detail .message-wrapper.is-group-chat .group-message-nameplate,
.theme-applied #preview-online-scene .message-wrapper.is-group-chat .group-message-nameplate { display: flex !important; align-items: center; gap: 5px; margin: 0 0 4px 0; font-size: 11px; line-height: 1.1; color: #888; }
.theme-applied #page-chat-detail .message-wrapper.is-group-chat .group-message-nameplate .group-level,
.theme-applied #preview-online-scene .message-wrapper.is-group-chat .group-message-nameplate .group-level { display: inline-flex; align-items: center; height: 15px; padding: 1px 5px; border-radius: 5px; font-size: 9px; font-weight: 600; line-height: 1; }
.theme-applied #page-chat-detail .message-wrapper.is-group-chat .group-message-nameplate .group-level.role-member,
.theme-applied #preview-online-scene .message-wrapper.is-group-chat .group-message-nameplate .group-level.role-member { background: #f4f7fa; color: #8c9bae; }
.theme-applied #page-chat-detail .message-wrapper.is-group-chat .group-message-nameplate .group-name,
.theme-applied #preview-online-scene .message-wrapper.is-group-chat .group-message-nameplate .group-name { max-width: 138px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 500; color: #8a8a8a; }
.theme-applied #page-chat-detail .message-wrapper.is-group-chat.received .message-bubble:not(.is-voice-message):not(.is-transfer-message)::before,
.theme-applied #preview-online-scene .message-wrapper.is-group-chat.received .message-bubble:not(.is-voice-message):not(.is-transfer-message)::before { display: none !important; }
.theme-applied #page-chat-detail .message-wrapper.is-group-chat.received .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.is-group-chat.received .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #page-chat-detail .message-wrapper.is-group-chat.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.is-group-chat.sent .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #page-chat-detail .message-wrapper.is-group-chat .message-bubble.is-voice-message,
.theme-applied #preview-online-scene .message-wrapper.is-group-chat .message-bubble.is-voice-message,
.theme-applied #page-chat-detail .message-wrapper.is-group-chat .message-bubble.is-transfer-message,
.theme-applied #preview-online-scene .message-wrapper.is-group-chat .message-bubble.is-transfer-message { margin-top: 2px !important; }
.theme-applied #page-chat-detail .message-wrapper.is-group-chat.same-group-speaker-prev,
.theme-applied #preview-online-scene .message-wrapper.is-group-chat.same-group-speaker-prev { margin-top: 0 !important; transform: none !important; }
.theme-applied #page-chat-detail .message-wrapper.is-group-chat.same-group-speaker-prev .group-message-nameplate,
.theme-applied #preview-online-scene .message-wrapper.is-group-chat.same-group-speaker-prev .group-message-nameplate,
.theme-applied #page-chat-detail .message-wrapper.is-group-chat.received.same-group-speaker-prev .chat-avatar-small,
.theme-applied #preview-online-scene .message-wrapper.is-group-chat.received.same-group-speaker-prev .chat-avatar-small { display: none !important; }
.theme-applied #page-chat-detail .message-wrapper.is-group-chat.received.same-group-speaker-prev .message-bubble:not(.is-voice-message):not(.is-transfer-message)::after,
.theme-applied #preview-online-scene .message-wrapper.is-group-chat.received.same-group-speaker-prev .message-bubble:not(.is-voice-message):not(.is-transfer-message)::after { display: none !important; }
.theme-applied #page-chat-detail .message-wrapper.is-group-chat.received.same-group-speaker-prev .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.is-group-chat.received.same-group-speaker-prev .message-bubble:not(.is-voice-message):not(.is-transfer-message),
.theme-applied #page-chat-detail .message-wrapper.is-group-chat.received.same-group-speaker-prev .message-bubble.is-transfer-message,
.theme-applied #preview-online-scene .message-wrapper.is-group-chat.received.same-group-speaker-prev .message-bubble.is-transfer-message,
.theme-applied #page-chat-detail .message-wrapper.is-group-chat.received.same-group-speaker-prev .message-bubble.is-voice-message,
.theme-applied #preview-online-scene .message-wrapper.is-group-chat.received.same-group-speaker-prev .message-bubble.is-voice-message { margin-top: 0 !important; margin-left: 44px !important; }
`;

function updateBuiltInKktSchemeIfNeeded(scheme) {
    const overrides = scheme?.data?.cssOverrides;
    if (!overrides) return false;
    const receivedCss = overrides['online-bubble-received'];
    const sentCss = overrides['online-bubble-sent'];
    const needsLegacyKktUpdate = [receivedCss, sentCss].some(css =>
        typeof css === 'string' &&
        (css.includes('content: "SUGA"') ||
         css.includes('kkt-transfer-bear.png') ||
         css.includes('IMG-20251223-112020.png') ||
         (css.includes('IMG-20251223-112035.png') && !css.includes('background-color: #ffffff !important')) ||
         (css.includes('KKT - received bubble fixed') && !css.includes('background-color: #ffffff !important')) ||
         (css.includes('KKT - sent bubble fixed') && !css.includes('background-color: #EEDC00 !important')))
    );
    const needsVoicePatch = [receivedCss, sentCss].some(css =>
        typeof css === 'string' && !css.includes('.message-bubble.is-voice-message')
    );
    const needsKktSpacingRestore = [receivedCss, sentCss].some(css =>
        typeof css === 'string' && css.includes('KKT - ') && (
            css.includes('.chat-message-list { gap: 0 !important; row-gap: 0 !important; }') ||
            css.includes('margin-top: -6px !important; transform: none !important;')
        )
    );
    if (!needsLegacyKktUpdate && !needsVoicePatch && !needsKktSpacingRestore) return false;
    overrides['online-bubble-received'] = KKT_ONLINE_BUBBLE_RECEIVED_CSS_FIXED;
    overrides['online-bubble-sent'] = KKT_ONLINE_BUBBLE_SENT_CSS_FIXED;
    return true;
}
window.__lookyUpdateBuiltInKktSchemeIfNeeded = updateBuiltInKktSchemeIfNeeded;

const WECHAT_ONLINE_HEADER_CSS = `
/* 微信风格 - 顶栏 */
.theme-applied .theme-target-detail-header,
#preview-online-header {
    background-color: #ededed !important;
    border-bottom: 1px solid #d7d7d7 !important;
    padding: max(44px, env(safe-area-inset-top, 0px)) 8px 0 !important;
    min-height: calc(max(44px, env(safe-area-inset-top, 0px)) + 48px) !important;
    height: calc(max(44px, env(safe-area-inset-top, 0px)) + 48px) !important;
    box-sizing: border-box !important;
    display: flex !important;
    align-items: flex-end !important;
    position: relative !important;
}
.theme-applied .theme-target-detail-header #chat-header-normal {
    height: 48px !important;
    position: relative !important;
}
.theme-applied .theme-target-detail-header .chat-detail-header-left,
.theme-applied .theme-target-detail-header .chat-detail-header-right,
#preview-online-header .mock-header-left,
#preview-online-header .mock-header-right {
    height: 48px !important;
    display: flex !important;
    align-items: center !important;
}
.theme-applied .theme-target-detail-header .chat-detail-avatar,
#preview-online-header .mock-avatar-small {
    display: none !important;
}
.theme-applied .theme-target-detail-header .chat-title-group,
#preview-online-header .mock-title-group {
    position: absolute !important;
    left: 50% !important;
    top: 50% !important;
    transform: translate(-50%, -50%) !important;
    max-width: calc(100% - 170px) !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
}
.theme-applied .theme-target-detail-header #chat-detail-char-name,
#preview-online-title {
    position: static !important;
    transform: none !important;
    font-size: 18px !important;
    line-height: 1.2 !important;
    font-weight: 600 !important;
    color: #000000 !important;
    max-width: 100% !important;
    white-space: nowrap !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
}
.theme-applied .theme-target-detail-header .back-button,
.theme-applied .theme-target-detail-header #call-btn,
.theme-applied .theme-target-detail-header #chat-detail-more-btn,
#preview-online-header .mock-back-btn,
#target-online-call,
#target-online-more {
    width: 40px !important;
    height: 48px !important;
    padding: 0 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    background: transparent !important;
    border: none !important;
    box-shadow: none !important;
}
.theme-applied .theme-target-detail-header #call-btn svg,
#target-online-call svg {
    width: 24px !important;
    height: 24px !important;
}
.theme-applied .theme-target-detail-header .chat-detail-header-right {
    margin-left: auto !important;
    padding-right: 6px !important;
    gap: 14px !important;
}
`;

const WECHAT_ONLINE_FOOTER_CSS = `
/* 微信风格 - 底栏 */
.theme-applied .theme-target-detail-footer,
#preview-online-footer {
    background-color: #f6f6f6 !important;
    border-top: 1px solid #e0e0e0 !important;
    padding: 8px 0 max(16px, env(safe-area-inset-bottom, 0px)) !important;
    min-height: calc(48px + max(16px, env(safe-area-inset-bottom, 0px))) !important;
    box-sizing: border-box !important;
}
.theme-applied .theme-target-detail-footer .chat-input-area,
#preview-online-footer .mock-input-area {
    gap: 4px !important;
    align-items: center !important;
    padding: 0 6px !important;
}
.theme-applied .theme-target-detail-footer .chat-grid-btn,
#target-online-grid {
    width: 40px !important;
    height: 40px !important;
    flex: 0 0 40px !important;
    padding: 0 !important;
}
.theme-applied .theme-target-detail-footer .text-input-wrapper,
#preview-online-footer .mock-input-wrapper {
    background-color: #ffffff !important;
    border-radius: 6px !important;
    min-height: 44px !important;
    height: 44px !important;
    padding: 0 34px 0 10px !important;
    flex: 1 1 auto !important;
    min-width: 0 !important;
    position: relative !important;
}
.theme-applied .theme-target-detail-footer .text-input-wrapper::after,
#preview-online-footer .mock-input-wrapper::after {
    content: "" !important;
    position: absolute !important;
    right: 9px !important;
    top: 50% !important;
    width: 17px !important;
    height: 22px !important;
    transform: translateY(-50%) !important;
    background-color: #7a7a7a !important;
    pointer-events: none !important;
    -webkit-mask: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3Zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 15 6.7 12H5c0 3.42 2.72 6.25 6 6.72V22h2v-3.28c3.28-.47 6-3.3 6-6.72h-1.7Z'/%3E%3C/svg%3E") center / contain no-repeat !important;
    mask: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3Zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 15 6.7 12H5c0 3.42 2.72 6.25 6 6.72V22h2v-3.28c3.28-.47 6-3.3 6-6.72h-1.7Z'/%3E%3C/svg%3E") center / contain no-repeat !important;
}
.theme-applied .theme-target-detail-footer #chat-input-field,
#preview-online-footer input {
    padding: 10px 0 !important;
    font-size: 16px !important;
    line-height: 1.5 !important;
    height: 100% !important;
    box-sizing: border-box !important;
    color: #000 !important;
}
.theme-applied .theme-target-detail-footer .chat-emoji-btn,
.theme-applied .theme-target-detail-footer #send-message-btn,
#target-online-emoji,
#target-online-send {
    width: 40px !important;
    height: 40px !important;
    flex: 0 0 40px !important;
    padding: 0 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    background-color: transparent !important;
    box-shadow: none !important;
    border: none !important;
}
`;

const WECHAT_TRANSFER_CSS = `
/* WeChat transfer polish v7 */
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble.is-transfer-message,
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble.is-transfer-message,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble.is-transfer-message,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble.is-transfer-message {
    width: min(280px, calc(100vw - 96px)) !important;
    padding: 0 !important;
    background: transparent !important;
    box-shadow: none !important;
    overflow: visible !important;
}
.theme-applied #page-chat-detail .message-bubble.is-transfer-message::before,
.theme-applied #page-chat-detail .message-bubble.is-transfer-message::after,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message::before,
.theme-applied #preview-online-scene .message-bubble.is-transfer-message::after {
    display: none !important;
}
.theme-applied #page-chat-detail .transfer-card,
.theme-applied #preview-online-scene .transfer-card {
    border-radius: 5px !important;
    overflow: hidden !important;
    box-shadow: none !important;
}
.theme-applied #page-chat-detail .transfer-card.transfer-pending,
.theme-applied #preview-online-scene .transfer-card.transfer-pending {
    background-color: #fa9d3b !important;
}
.theme-applied #page-chat-detail .transfer-card.transfer-receipt,
.theme-applied #preview-online-scene .transfer-card.transfer-receipt {
    background-color: #f8c996 !important;
}
.theme-applied #page-chat-detail .transfer-content-wrapper,
.theme-applied #preview-online-scene .transfer-content-wrapper {
    height: 68px !important;
    min-height: 68px !important;
    padding: 9px 14px 7px !important;
    display: flex !important;
    align-items: flex-start !important;
    box-sizing: border-box !important;
}
.theme-applied #page-chat-detail .transfer-icon,
.theme-applied #preview-online-scene .transfer-icon {
    width: 46px !important;
    height: 46px !important;
    flex: 0 0 46px !important;
    margin: 0 12px 0 0 !important;
    border-radius: 0 !important;
    background-color: transparent !important;
    background-position: center !important;
    background-repeat: no-repeat !important;
    background-size: contain !important;
}
.theme-applied #page-chat-detail .transfer-icon *,
.theme-applied #preview-online-scene .transfer-icon * {
    display: none !important;
}
.theme-applied #page-chat-detail .transfer-card.transfer-pending .transfer-icon,
.theme-applied #preview-online-scene .transfer-card.transfer-pending .transfer-icon {
    background-image: url('./images/wechat-transfer-pending.png') !important;
}
.theme-applied #page-chat-detail .transfer-card.transfer-receipt .transfer-icon,
.theme-applied #preview-online-scene .transfer-card.transfer-receipt .transfer-icon {
    background-image: url('./images/wechat-transfer-receipt.png') !important;
}
.theme-applied #page-chat-detail .transfer-text-group,
.theme-applied #preview-online-scene .transfer-text-group {
    min-width: 0 !important;
    flex: 1 1 auto !important;
    padding-top: 2px !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 3px !important;
}
.theme-applied #page-chat-detail .transfer-text-group .amount,
.theme-applied #preview-online-scene .transfer-text-group .amount {
    color: #ffffff !important;
    font-size: 17px !important;
    line-height: 1.2 !important;
    font-weight: 500 !important;
    margin: 0 !important;
}
.theme-applied #page-chat-detail .transfer-text-group .status-text,
.theme-applied #preview-online-scene .transfer-text-group .status-text {
    color: #ffffff !important;
    font-size: 13px !important;
    line-height: 1.3 !important;
    margin: 0 !important;
    max-width: 184px !important;
    white-space: nowrap !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
}
.theme-applied #page-chat-detail .transfer-footer,
.theme-applied #preview-online-scene .transfer-footer {
    height: 30px !important;
    padding: 0 14px !important;
    display: flex !important;
    align-items: center !important;
    box-sizing: border-box !important;
    border-top: 1px solid rgba(0, 0, 0, 0.08) !important;
    background: rgba(0, 0, 0, 0.03) !important;
    color: #ffffff !important;
    font-size: 14px !important;
    line-height: 1 !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent .transfer-card.transfer-pending::after,
.theme-applied #preview-online-scene .message-wrapper.sent .transfer-card.transfer-pending::after {
    border-left-color: #fa9d3b !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .transfer-card.transfer-pending::after,
.theme-applied #preview-online-scene .message-wrapper.received .transfer-card.transfer-pending::after {
    border-right-color: #fa9d3b !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent .transfer-card.transfer-receipt::after,
.theme-applied #preview-online-scene .message-wrapper.sent .transfer-card.transfer-receipt::after {
    border-left-color: #f8c996 !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .transfer-card.transfer-receipt::after,
.theme-applied #preview-online-scene .message-wrapper.received .transfer-card.transfer-receipt::after {
    border-right-color: #f8c996 !important;
}
`;

const LINE_THEME_NAME = 'line';
const LINE_THEME_VERSION = 5;
const LINE_THEME_MARKER = 'LINE theme v5';
const LINE_THEME_ICON_SRC = {
    back: './images/line-back.png',
    search: './images/line-search.png',
    phone: './images/line-phone.png',
    menu: './images/line-menu.png',
    plus: './images/line-plus.png',
    camera: './images/line-camera.png',
    gallery: './images/line-gallery.png',
    emoji: './images/line-emoji.png',
    mic: './images/line-mic.png',
    receivedTail: './images/line-character-tail.png',
    sentTail: './images/line-user-tail-02.png'
};

function isLineThemeData(themeData) {
    if (!themeData) return false;
    if (themeData.builtInThemeId === LINE_THEME_NAME) return true;
    return Object.values(themeData.cssOverrides || {}).some(value =>
        typeof value === 'string' && value.includes('LINE theme')
    );
}
window.__lookyIsLineThemeData = isLineThemeData;

function createLineThemePayload() {
    return {
        builtInThemeId: LINE_THEME_NAME,
        builtInThemeVersion: LINE_THEME_VERSION,
        cssOverrides: {
            'global-css': `
/* ${LINE_THEME_MARKER} */
body.line-theme-active #page-chat-detail .chat-detail-content,
body.line-theme-active #preview-online-bg {
    background-color: #8CABD9 !important;
}
body.line-theme-active #page-chat-detail,
body.line-theme-active #preview-online-scene {
    background-color: #8CABD9 !important;
}
body.line-theme-active #page-chat-detail .chat-message-list,
body.line-theme-active #preview-online-scene .chat-message-list {
    gap: 8px !important;
    padding: 8px 8px 14px !important;
}
body.line-theme-active #page-chat-detail .chat-input-area,
body.line-theme-active #preview-online-footer .mock-input-area {
    position: relative !important;
    display: flex !important;
    align-items: center !important;
    gap: 7px !important;
    padding: 0 10px !important;
    min-width: 0 !important;
    overflow: visible !important;
}
body.line-theme-active #page-chat-detail .text-input-wrapper,
body.line-theme-active #preview-online-footer .mock-input-wrapper {
    background: #ffffff !important;
    border: 1px solid rgba(0, 0, 0, 0.06) !important;
    border-radius: 999px !important;
    min-height: 42px !important;
    height: 42px !important;
    padding: 0 42px 0 14px !important;
    flex: 1 1 auto !important;
    min-width: 0 !important;
    box-sizing: border-box !important;
    box-shadow: none !important;
}
body.line-theme-active #page-chat-detail .text-input-wrapper.expanded,
body.line-theme-active #preview-online-footer .mock-input-wrapper.expanded {
    margin-right: 0 !important;
    padding-right: 38px !important;
}
body.line-theme-active #page-chat-detail #chat-input-field,
body.line-theme-active #preview-online-footer input {
    color: #111111 !important;
    font-size: 16px !important;
    font-weight: 600 !important;
    line-height: 1.4 !important;
}
body.line-theme-active #page-chat-detail #chat-input-field::placeholder,
body.line-theme-active #preview-online-footer input::placeholder {
    color: #b9b9b9 !important;
}
body.line-theme-active .line-theme-runtime-control,
body.line-theme-active .line-theme-tool-btn,
body.line-theme-active .line-theme-extra-btn,
body.line-theme-active .line-theme-search-btn {
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    border: none !important;
    background: transparent !important;
    box-shadow: none !important;
    padding: 0 !important;
    flex-shrink: 0 !important;
}
body.line-theme-active .line-theme-runtime-control img,
body.line-theme-active .line-theme-tool-btn img,
body.line-theme-active .line-theme-extra-btn img,
body.line-theme-active .line-theme-search-btn img {
    width: 22px !important;
    height: 22px !important;
    object-fit: contain !important;
    display: block !important;
}
body.line-theme-active #page-chat-detail .chat-grid-btn,
body.line-theme-active #preview-online-footer #target-online-grid,
body.line-theme-active .line-theme-tool-btn {
    width: 28px !important;
    height: 28px !important;
}
body.line-theme-active .line-theme-extra-btn,
body.line-theme-active .line-theme-search-btn {
    width: 28px !important;
    height: 28px !important;
}
body.line-theme-active #page-chat-detail .chat-emoji-btn,
body.line-theme-active #page-chat-detail #send-message-btn,
body.line-theme-active #preview-online-footer #target-online-emoji,
body.line-theme-active #preview-online-footer #target-online-send {
    width: 28px !important;
    height: 28px !important;
    padding: 0 !important;
    border: none !important;
    background: transparent !important;
    box-shadow: none !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
}
body.line-theme-active #page-chat-detail .chat-emoji-btn,
body.line-theme-active #preview-online-footer #target-online-emoji {
    position: absolute !important;
    top: 50% !important;
    right: 54px !important;
    transform: translateY(-50%) !important;
}
body.line-theme-active #page-chat-detail #send-message-btn,
body.line-theme-active #preview-online-footer #target-online-send {
    position: relative !important;
    right: auto !important;
    top: auto !important;
    transform: none !important;
    flex: 0 0 28px !important;
    width: 28px !important;
    height: 28px !important;
    margin: 0 !important;
}
body.line-theme-active #page-chat-detail .chat-emoji-btn,
body.line-theme-active #preview-online-footer #target-online-emoji {
    z-index: 12 !important;
}
body.line-theme-active #page-chat-detail .chat-emoji-btn .beautify-custom-icon,
body.line-theme-active #page-chat-detail #send-message-btn .beautify-custom-icon,
body.line-theme-active #preview-online-footer #target-online-emoji .beautify-custom-icon,
body.line-theme-active #preview-online-footer #target-online-send .beautify-custom-icon,
body.line-theme-active #page-chat-detail #send-message-btn img,
body.line-theme-active #preview-online-footer #target-online-send img {
    width: 22px !important;
    height: 22px !important;
    object-fit: contain !important;
}
body.line-theme-active #page-chat-detail .chat-detail-header,
body.line-theme-active #preview-online-header {
    box-sizing: border-box !important;
    min-height: 102px !important;
    height: 102px !important;
    padding: 50px 10px 8px !important;
    display: flex !important;
    align-items: flex-end !important;
    background-color: #8CABD9 !important;
    border-bottom: none !important;
    box-shadow: none !important;
}
body.line-theme-active #page-chat-detail .chat-detail-header::before,
body.line-theme-active #page-chat-detail .chat-detail-header::after,
body.line-theme-active #preview-online-header::before,
body.line-theme-active #preview-online-header::after {
    display: none !important;
}
body.line-theme-active #page-chat-detail .chat-detail-header .chat-detail-header-left,
body.line-theme-active #page-chat-detail .chat-detail-header .chat-detail-header-right,
body.line-theme-active #preview-online-header .mock-header-left,
body.line-theme-active #preview-online-header .mock-header-right {
    align-items: center !important;
}
body.line-theme-active #page-chat-detail .chat-detail-header .line-theme-search-btn,
body.line-theme-active #page-chat-detail .back-button,
body.line-theme-active #page-chat-detail #call-btn,
body.line-theme-active #page-chat-detail #chat-detail-more-btn,
body.line-theme-active #preview-online-header .mock-back-btn,
body.line-theme-active #preview-online-header .line-theme-search-btn,
body.line-theme-active #preview-online-header #target-online-call,
body.line-theme-active #preview-online-header #target-online-more {
    width: 30px !important;
    height: 30px !important;
    flex: 0 0 30px !important;
}
body.line-theme-active #page-chat-detail .chat-detail-header img.beautify-custom-icon,
body.line-theme-active #page-chat-detail .chat-detail-header .line-theme-search-btn img,
body.line-theme-active #preview-online-header img.beautify-custom-icon,
body.line-theme-active #preview-online-header .line-theme-search-btn img {
    width: 22px !important;
    height: 22px !important;
    object-fit: contain !important;
}
body.line-theme-active #page-chat-detail .chat-detail-avatar,
body.line-theme-active #preview-online-header .mock-avatar-small {
    display: block !important;
    width: 26px !important;
    height: 26px !important;
    border-radius: 50% !important;
    object-fit: cover !important;
    flex-shrink: 0 !important;
}
body.line-theme-active #page-chat-detail .chat-title-group,
body.line-theme-active #preview-online-header .mock-title-group {
    position: static !important;
    transform: none !important;
    max-width: calc(100vw - 170px) !important;
    display: flex !important;
    align-items: center !important;
    gap: 6px !important;
    justify-content: flex-start !important;
}
body.line-theme-active #page-chat-detail #chat-detail-char-name,
body.line-theme-active #preview-online-title {
    color: #111111 !important;
    font-size: 16px !important;
    font-weight: 700 !important;
    line-height: 1.2 !important;
    text-align: left !important;
}
body.line-theme-active #page-chat-detail .chat-detail-header-right,
body.line-theme-active #preview-online-header .mock-header-right {
    gap: 16px !important;
}
body.line-theme-active #page-chat-detail .back-button,
body.line-theme-active #page-chat-detail #call-btn,
body.line-theme-active #page-chat-detail #chat-detail-more-btn,
body.line-theme-active #preview-online-header .mock-back-btn,
body.line-theme-active #target-online-call,
body.line-theme-active #target-online-more {
    width: 30px !important;
    height: 30px !important;
    padding: 0 !important;
    border: none !important;
    background: transparent !important;
    box-shadow: none !important;
}
body.line-theme-active #page-chat-detail.multiselect-active #chat-header-normal {
    display: none !important;
}
body.line-theme-active #page-chat-detail.multiselect-active #chat-header-multiselect {
    width: 100% !important;
    height: 42px !important;
    min-height: 42px !important;
    padding: 0 !important;
    margin: 0 !important;
    box-sizing: border-box !important;
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    gap: 6px !important;
}
body.line-theme-active #page-chat-detail.multiselect-active #chat-header-multiselect .multiselect-action-group {
    display: flex !important;
    align-items: center !important;
    justify-content: flex-end !important;
    gap: 2px !important;
    flex: 0 0 auto !important;
}
body.line-theme-active #page-chat-detail.multiselect-active #chat-header-multiselect button {
    min-width: 38px !important;
    height: 34px !important;
    margin: 0 !important;
    padding: 0 6px !important;
    border: none !important;
    border-radius: 20px !important;
    background: transparent !important;
    color: rgba(17, 17, 17, 0.92) !important;
    font-size: 16px !important;
    font-weight: 600 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
}
body.line-theme-active #page-chat-detail.multiselect-active #chat-header-multiselect button:disabled {
    color: rgba(125, 125, 125, 0.58) !important;
}
body.line-theme-active #page-chat-detail.multiselect-active #chat-header-multiselect #multiselect-counter {
    position: static !important;
    transform: none !important;
    flex: 1 1 auto !important;
    min-width: 0 !important;
    width: auto !important;
    margin: 0 !important;
    color: #111111 !important;
    font-size: 16px !important;
    font-weight: 700 !important;
    line-height: 1.25 !important;
    text-align: center !important;
    white-space: nowrap !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
}
`,
            'preview-online-header': `
/* ${LINE_THEME_MARKER} - header */
body.line-theme-active .theme-target-detail-header,
#preview-online-header {
    box-sizing: border-box !important;
    min-height: 102px !important;
    height: 102px !important;
    padding: 50px 10px 8px !important;
    border-bottom: none !important;
    background-color: #8CABD9 !important;
    box-shadow: none !important;
    display: flex !important;
    align-items: flex-end !important;
    justify-content: space-between !important;
}
body.line-theme-active .theme-target-detail-header .back-button svg,
body.line-theme-active .theme-target-detail-header #call-btn svg,
body.line-theme-active .theme-target-detail-header #chat-detail-more-btn svg,
#preview-online-header .mock-back-btn svg,
#target-online-call svg,
#target-online-more svg,
#target-online-search svg {
    width: 22px !important;
    height: 22px !important;
    stroke: #111111 !important;
}
body.line-theme-active #page-chat-detail .chat-detail-header-left,
#preview-online-header .mock-header-left {
    height: 42px !important;
    flex: 1 1 auto !important;
    min-width: 0 !important;
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
}
body.line-theme-active #page-chat-detail #chat-header-normal {
    width: 100% !important;
    height: 42px !important;
    min-height: 42px !important;
    padding: 0 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
}
body.line-theme-active #page-chat-detail .chat-detail-header-right,
#preview-online-header .mock-header-right {
    padding-right: 4px !important;
    flex: 0 0 auto !important;
    display: flex !important;
    align-items: center !important;
}
body.line-theme-active .theme-target-detail-header #chat-header-normal,
#preview-online-header .mock-header-left,
#preview-online-header .mock-header-right {
    box-sizing: border-box !important;
}
body.line-theme-active #page-chat-detail .theme-target-detail-header .back-button,
body.line-theme-active #page-chat-detail .theme-target-detail-header #call-btn,
body.line-theme-active #page-chat-detail .theme-target-detail-header #chat-detail-more-btn,
#preview-online-header .mock-back-btn,
#target-online-call,
#target-online-more,
#target-online-search {
    border-radius: 50% !important;
}
`,
            'preview-online-footer': `
/* ${LINE_THEME_MARKER} - footer */
body.line-theme-active .theme-target-detail-footer,
#preview-online-footer {
    background-color: rgba(255, 255, 255, 0.98) !important;
    border-top: 1px solid rgba(0, 0, 0, 0.05) !important;
    padding: 8px 0 max(14px, env(safe-area-inset-bottom, 0px)) !important;
    box-sizing: border-box !important;
    box-shadow: none !important;
}
body.line-theme-active .theme-target-detail-footer .chat-input-area,
#preview-online-footer .mock-input-area {
    gap: 7px !important;
    padding-left: 10px !important;
    padding-right: 10px !important;
    min-width: 0 !important;
}
body.line-theme-active .theme-target-detail-footer .text-input-wrapper,
#preview-online-footer .mock-input-wrapper {
    border-radius: 999px !important;
    background-color: #ffffff !important;
    min-height: 40px !important;
    height: 40px !important;
    min-width: 0 !important;
    box-sizing: border-box !important;
}
body.line-theme-active .theme-target-detail-footer .chat-grid-btn,
#preview-online-footer #target-online-grid {
    width: 28px !important;
    height: 28px !important;
}
body.line-theme-active .theme-target-detail-footer .chat-emoji-btn,
#preview-online-footer #target-online-emoji {
    right: 52px !important;
}
body.line-theme-active .theme-target-detail-footer #send-message-btn,
#preview-online-footer #target-online-send {
    right: 10px !important;
}
`,
            'online-bubble-received': `
/* ${LINE_THEME_MARKER} - received bubble */
body.line-theme-active #page-chat-detail .message-wrapper.received,
body.line-theme-active #preview-online-scene .message-wrapper.received {
    align-self: flex-start !important;
    gap: 9.5px !important;
    max-width: calc(100% - 20px) !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.is-group-chat .group-message-nameplate,
body.line-theme-active #preview-online-scene .message-wrapper.is-group-chat .group-message-nameplate {
    display: none !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received .chat-avatar-small,
body.line-theme-active #preview-online-scene .message-wrapper.received .chat-avatar-small {
    width: 36px !important;
    height: 36px !important;
    border-radius: 50% !important;
    object-fit: cover !important;
    flex-shrink: 0 !important;
    transform: translateY(-2px) !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received .message-bubble,
body.line-theme-active #page-chat-detail .message-wrapper.received .voice-bar,
body.line-theme-active #preview-online-scene .message-wrapper.received .message-bubble,
body.line-theme-active #preview-online-scene .message-wrapper.received .voice-bar {
    position: relative !important;
    background: #ffffff !important;
    color: #111111 !important;
    border-radius: 18px !important;
    box-shadow: none !important;
    overflow: visible !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received .message-bubble.has-direct-text-message::before,
body.line-theme-active #preview-online-scene .message-wrapper.received .message-bubble.has-direct-text-message::before {
    content: '' !important;
    position: absolute !important;
    left: -4px !important;
    top: 0 !important;
    width: 16px !important;
    height: 16px !important;
    background: url('${LINE_THEME_ICON_SRC.receivedTail}') center / contain no-repeat !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received .message-bubble:not(.is-transfer-message):not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-voice-message):not(.is-voice-call-summary):not(.is-voice-call-rejected) p,
body.line-theme-active #preview-online-scene .message-wrapper.received .message-bubble:not(.is-transfer-message):not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-voice-message):not(.is-voice-call-summary):not(.is-voice-call-rejected) p {
    padding: 9px 14px !important;
    margin: 0 !important;
    font-size: 16px !important;
    font-weight: 700 !important;
    line-height: 1.28 !important;
    color: #111111 !important;
    word-break: break-word !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received .message-bubble.is-voice-message,
body.line-theme-active #preview-online-scene .message-wrapper.received .message-bubble.is-voice-message,
body.line-theme-active #page-chat-detail .message-wrapper.sent .message-bubble.is-voice-message,
body.line-theme-active #preview-online-scene .message-wrapper.sent .message-bubble.is-voice-message {
    display: flex !important;
    flex-direction: column !important;
    gap: 6px !important;
    align-items: flex-start !important;
    padding: 0 !important;
    background: transparent !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    overflow: visible !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.sent .message-bubble.is-voice-message,
body.line-theme-active #preview-online-scene .message-wrapper.sent .message-bubble.is-voice-message {
    align-items: flex-end !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received .message-bubble.is-voice-message::before,
body.line-theme-active #page-chat-detail .message-wrapper.received .message-bubble.is-voice-message::after,
body.line-theme-active #preview-online-scene .message-wrapper.received .message-bubble.is-voice-message::before,
body.line-theme-active #preview-online-scene .message-wrapper.received .message-bubble.is-voice-message::after,
body.line-theme-active #page-chat-detail .message-wrapper.sent .message-bubble.is-voice-message::before,
body.line-theme-active #page-chat-detail .message-wrapper.sent .message-bubble.is-voice-message::after,
body.line-theme-active #preview-online-scene .message-wrapper.sent .message-bubble.is-voice-message::before,
body.line-theme-active #preview-online-scene .message-wrapper.sent .message-bubble.is-voice-message::after {
    display: none !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received .message-bubble.is-voice-message .voice-bar,
body.line-theme-active #preview-online-scene .message-wrapper.received .message-bubble.is-voice-message .voice-bar,
body.line-theme-active #page-chat-detail .message-wrapper.sent .message-bubble.is-voice-message .voice-bar,
body.line-theme-active #preview-online-scene .message-wrapper.sent .message-bubble.is-voice-message .voice-bar {
    width: 180px !important;
    height: 44px !important;
    min-height: 44px !important;
    margin: 0 !important;
    padding: 0 14px !important;
    box-sizing: border-box !important;
    border-radius: 18px !important;
    box-shadow: none !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.sent .message-bubble.is-voice-message .voice-bar,
body.line-theme-active #preview-online-scene .message-wrapper.sent .message-bubble.is-voice-message .voice-bar {
    flex-direction: row-reverse !important;
    background: #6DE67C !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received .message-bubble.is-voice-message .voice-text-content,
body.line-theme-active #preview-online-scene .message-wrapper.received .message-bubble.is-voice-message .voice-text-content,
body.line-theme-active #page-chat-detail .message-wrapper.sent .message-bubble.is-voice-message .voice-text-content,
body.line-theme-active #preview-online-scene .message-wrapper.sent .message-bubble.is-voice-message .voice-text-content {
    display: none !important;
    width: fit-content !important;
    max-width: 260px !important;
    margin: 0 !important;
    padding: 9px 12px !important;
    border-radius: 16px !important;
    box-shadow: none !important;
    font-size: 15px !important;
    line-height: 1.45 !important;
    word-break: break-word !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received.voice-expanded .message-bubble.is-voice-message .voice-text-content,
body.line-theme-active #preview-online-scene .message-wrapper.received.voice-expanded .message-bubble.is-voice-message .voice-text-content {
    display: block !important;
    background: #ffffff !important;
    color: #111111 !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.sent.voice-expanded .message-bubble.is-voice-message .voice-text-content,
body.line-theme-active #preview-online-scene .message-wrapper.sent.voice-expanded .message-bubble.is-voice-message .voice-text-content {
    display: block !important;
    background: #6DE67C !important;
    color: #111111 !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received .voice-bar .bar,
body.line-theme-active #preview-online-scene .message-wrapper.received .voice-bar .bar {
    background: rgba(17, 17, 17, 0.84) !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received .voice-bar .voice-duration,
body.line-theme-active #preview-online-scene .message-wrapper.received .voice-bar .voice-duration {
    color: rgba(17, 17, 17, 0.86) !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received .message-reply-preview,
body.line-theme-active #preview-online-scene .message-wrapper.received .message-reply-preview {
    position: relative !important;
    margin: 0 !important;
    padding: 10px 12px 10px 38px !important;
    border: none !important;
    border-bottom: none !important;
    border-radius: 0 !important;
    background: transparent !important;
    color: rgba(45, 45, 45, 0.68) !important;
    font-size: 13px !important;
    line-height: 1.25 !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 2px !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received .message-reply-preview::before,
body.line-theme-active #preview-online-scene .message-wrapper.received .message-reply-preview::before {
    content: '' !important;
    position: absolute !important;
    left: 11px !important;
    top: 50% !important;
    transform: translateY(-50%) !important;
    width: 18px !important;
    height: 18px !important;
    border-radius: 50% !important;
    background: var(--reply-avatar) center / cover no-repeat !important;
    border: 1px solid rgba(255, 255, 255, 0.78) !important;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08) !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received .message-reply-preview strong,
body.line-theme-active #preview-online-scene .message-wrapper.received .message-reply-preview strong {
    color: #111111 !important;
    font-size: 13px !important;
    font-weight: 700 !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received .gallery-image-preview,
body.line-theme-active #preview-online-scene .message-wrapper.received .gallery-image-preview {
    border-radius: 16px !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received + .message-wrapper.received .chat-avatar-small,
body.line-theme-active #preview-online-scene .message-wrapper.received + .message-wrapper.received .chat-avatar-small {
    visibility: hidden !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received.same-message-type-prev .chat-avatar-small,
body.line-theme-active #preview-online-scene .message-wrapper.received.same-message-type-prev .chat-avatar-small {
    visibility: hidden !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received.same-text-message-prev .message-bubble::before,
body.line-theme-active #preview-online-scene .message-wrapper.received.same-text-message-prev .message-bubble::before {
    display: none !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received + .message-wrapper.received,
body.line-theme-active #preview-online-scene .message-wrapper.received + .message-wrapper.received {
    margin-top: -4px !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received.same-message-type-prev,
body.line-theme-active #preview-online-scene .message-wrapper.received.same-message-type-prev {
    margin-top: -4px !important;
}
`,
            'online-bubble-sent': `
/* ${LINE_THEME_MARKER} - sent bubble */
body.line-theme-active #page-chat-detail .message-wrapper.sent,
body.line-theme-active #preview-online-scene .message-wrapper.sent {
    align-self: flex-end !important;
    flex-direction: row-reverse !important;
    gap: 8px !important;
    margin-right: 8px !important;
    max-width: calc(100% - 20px) !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.sent .chat-avatar-small,
body.line-theme-active #preview-online-scene .message-wrapper.sent .chat-avatar-small {
    display: none !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.sent .message-bubble,
body.line-theme-active #page-chat-detail .message-wrapper.sent .voice-bar,
body.line-theme-active #preview-online-scene .message-wrapper.sent .message-bubble,
body.line-theme-active #preview-online-scene .message-wrapper.sent .voice-bar {
    position: relative !important;
    background: #6DE67C !important;
    color: #111111 !important;
    border-radius: 18px !important;
    box-shadow: none !important;
    overflow: visible !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.sent .message-bubble.has-direct-text-message::after,
body.line-theme-active #preview-online-scene .message-wrapper.sent .message-bubble.has-direct-text-message::after {
    content: '' !important;
    position: absolute !important;
    right: -4px !important;
    top: -3px !important;
    width: 16px !important;
    height: 16px !important;
    background: url('${LINE_THEME_ICON_SRC.sentTail}') center / contain no-repeat !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.sent .message-bubble:not(.is-transfer-message):not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-voice-message):not(.is-voice-call-summary):not(.is-voice-call-rejected) p,
body.line-theme-active #preview-online-scene .message-wrapper.sent .message-bubble:not(.is-transfer-message):not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-voice-message):not(.is-voice-call-summary):not(.is-voice-call-rejected) p {
    padding: 9px 14px !important;
    margin: 0 !important;
    font-size: 16px !important;
    font-weight: 700 !important;
    line-height: 1.28 !important;
    color: #111111 !important;
    word-break: break-word !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.sent .voice-bar .bar,
body.line-theme-active #preview-online-scene .message-wrapper.sent .voice-bar .bar {
    background: rgba(17, 17, 17, 0.84) !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.sent .voice-bar .voice-duration,
body.line-theme-active #preview-online-scene .message-wrapper.sent .voice-bar .voice-duration {
    color: rgba(17, 17, 17, 0.86) !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.sent .message-reply-preview,
body.line-theme-active #preview-online-scene .message-wrapper.sent .message-reply-preview {
    position: relative !important;
    margin: 0 !important;
    padding: 10px 12px 10px 38px !important;
    border: none !important;
    border-bottom: none !important;
    border-radius: 0 !important;
    background: transparent !important;
    color: rgba(25, 25, 25, 0.72) !important;
    font-size: 13px !important;
    line-height: 1.25 !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 2px !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.sent .message-reply-preview::before,
body.line-theme-active #preview-online-scene .message-wrapper.sent .message-reply-preview::before {
    content: '' !important;
    position: absolute !important;
    left: 11px !important;
    top: 50% !important;
    transform: translateY(-50%) !important;
    width: 18px !important;
    height: 18px !important;
    border-radius: 50% !important;
    background: var(--reply-avatar) center / cover no-repeat !important;
    border: 1px solid rgba(255, 255, 255, 0.78) !important;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08) !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.sent .message-reply-preview strong,
body.line-theme-active #preview-online-scene .message-wrapper.sent .message-reply-preview strong {
    color: #111111 !important;
    font-size: 13px !important;
    font-weight: 700 !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.sent.same-text-message-prev .message-bubble::after,
body.line-theme-active #preview-online-scene .message-wrapper.sent.same-text-message-prev .message-bubble::after {
    display: none !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.sent + .message-wrapper.sent,
body.line-theme-active #preview-online-scene .message-wrapper.sent + .message-wrapper.sent {
    margin-top: -4px !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.sent.same-message-type-prev,
body.line-theme-active #preview-online-scene .message-wrapper.sent.same-message-type-prev {
    margin-top: -4px !important;
}
body.line-theme-active #page-chat-detail .message-wrapper.received .message-bubble.gallery-image-bubble,
body.line-theme-active #page-chat-detail .message-wrapper.sent .message-bubble.gallery-image-bubble,
body.line-theme-active #preview-online-scene .message-wrapper.received .message-bubble.gallery-image-bubble,
body.line-theme-active #preview-online-scene .message-wrapper.sent .message-bubble.gallery-image-bubble,
body.line-theme-active #page-chat-detail .message-wrapper.received .message-bubble.photo-card,
body.line-theme-active #page-chat-detail .message-wrapper.sent .message-bubble.photo-card,
body.line-theme-active #preview-online-scene .message-wrapper.received .message-bubble.photo-card,
body.line-theme-active #preview-online-scene .message-wrapper.sent .message-bubble.photo-card {
    background: #ffffff !important;
    border-radius: 18px !important;
    box-shadow: none !important;
}
`
        },
        icons: {
            'target-online-back': LINE_THEME_ICON_SRC.back,
            'target-online-call': LINE_THEME_ICON_SRC.phone,
            'target-online-more': LINE_THEME_ICON_SRC.menu,
            'target-online-grid': LINE_THEME_ICON_SRC.plus,
            'target-online-emoji': LINE_THEME_ICON_SRC.emoji,
            'target-online-send': LINE_THEME_ICON_SRC.mic
        },
        sliders: {
            'target-online-back': '22',
            'target-online-call': '22',
            'target-online-more': '22',
            'target-online-grid': '22',
            'target-online-emoji': '22',
            'target-online-send': '22'
        }
    };
}

function updateBuiltInLineSchemeIfNeeded(scheme) {
    const data = scheme?.data;
    if (!isLineThemeData(data)) return false;
    const payload = createLineThemePayload();
    scheme.name = LINE_THEME_NAME;
    scheme.type = 'detail';
    scheme.typeName = '聊天详情';
    scheme.data = payload;
    return true;
}

function createLineThemeRuntimeButton({ iconSrc, title, className, onClick, preview = false }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `line-theme-runtime-control ${className}${preview ? ' line-theme-preview-control' : ''}`;
    if (title) button.title = title;
    if (preview) {
        button.tabIndex = -1;
        button.setAttribute('aria-hidden', 'true');
        button.style.pointerEvents = 'none';
    } else if (typeof onClick === 'function') {
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            onClick(event);
        });
    }
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.src = iconSrc;
    button.appendChild(img);
    return button;
}

function resolveLineThemeMenuTrigger(baseId) {
    const char = AppState.characterProfiles.find(c => String(c.id) === String(tempState.currentChatId));
    if (char?.isGroup) {
        return document.getElementById(`group-${baseId}`) || document.getElementById(baseId);
    }
    return document.getElementById(baseId) || document.getElementById(`group-${baseId}`);
}

let lastLineThemeRuntimeState = null;
function syncLineThemeRuntime(isStyleActive, isFullRuntimeActive = isStyleActive) {
    const styleActive = Boolean(isStyleActive);
    const runtimeActive = Boolean(isFullRuntimeActive);
    const nextState = `${styleActive}:${runtimeActive}`;
    // 非 Line 主题重复刷新时无需反复扫描和删除运行时控件；Line 主题仍每次校验控件，避免页面重建后缺按钮。
    if (lastLineThemeRuntimeState === nextState && !runtimeActive) return;
    lastLineThemeRuntimeState = nextState;
    document.body.classList.toggle('line-theme-active', styleActive);
    document.querySelectorAll('.line-theme-runtime-control').forEach(node => node.remove());

    const chatInput = document.getElementById('chat-input-field');
    if (chatInput) {
        if (runtimeActive) {
            if (!chatInput.dataset.lineThemePlaceholder) {
                chatInput.dataset.lineThemePlaceholder = chatInput.getAttribute('placeholder') || '';
            }
            chatInput.setAttribute('placeholder', 'Aa');
        } else if (chatInput.dataset.lineThemePlaceholder !== undefined) {
            chatInput.setAttribute('placeholder', chatInput.dataset.lineThemePlaceholder);
            delete chatInput.dataset.lineThemePlaceholder;
        }
    }

    const previewInput = document.querySelector('#preview-online-footer input');
    if (previewInput) {
        if (runtimeActive) {
            if (!previewInput.dataset.lineThemePlaceholder) {
                previewInput.dataset.lineThemePlaceholder = previewInput.getAttribute('placeholder') || '';
            }
            previewInput.setAttribute('placeholder', 'Aa');
        } else if (previewInput.dataset.lineThemePlaceholder !== undefined) {
            previewInput.setAttribute('placeholder', previewInput.dataset.lineThemePlaceholder);
            delete previewInput.dataset.lineThemePlaceholder;
        }
    }

    if (!runtimeActive) return;

    const pageHeaderRight = document.querySelector('#page-chat-detail .chat-detail-header-right');
    const pageCallBtn = document.getElementById('call-btn');
    if (pageHeaderRight && pageCallBtn) {
        const searchBtn = createLineThemeRuntimeButton({
            iconSrc: LINE_THEME_ICON_SRC.search,
            title: '搜索',
            className: 'line-theme-search-btn'
        });
        pageHeaderRight.insertBefore(searchBtn, pageCallBtn);
    }

    const previewHeaderRight = document.querySelector('#preview-online-header .mock-header-right');
    const previewCallBtn = document.getElementById('target-online-call');
    if (previewHeaderRight && previewCallBtn) {
        const searchBtn = createLineThemeRuntimeButton({
            iconSrc: LINE_THEME_ICON_SRC.search,
            title: '搜索',
            className: 'line-theme-search-btn',
            preview: true
        });
        previewHeaderRight.insertBefore(searchBtn, previewCallBtn);
    }

    const pageInputArea = document.querySelector('#page-chat-detail .chat-input-area');
    const pageInputWrapper = document.querySelector('#page-chat-detail .text-input-wrapper');
    if (pageInputArea && pageInputWrapper) {
        const cameraBtn = createLineThemeRuntimeButton({
            iconSrc: LINE_THEME_ICON_SRC.camera,
            title: '拍摄',
            className: 'line-theme-extra-btn',
            onClick: () => resolveLineThemeMenuTrigger('shooting-btn')?.click()
        });
        const galleryBtn = createLineThemeRuntimeButton({
            iconSrc: LINE_THEME_ICON_SRC.gallery,
            title: '相册',
            className: 'line-theme-extra-btn',
            onClick: () => resolveLineThemeMenuTrigger('album-btn')?.click()
        });
        pageInputArea.insertBefore(cameraBtn, pageInputWrapper);
        pageInputArea.insertBefore(galleryBtn, pageInputWrapper);
    }

    const previewInputArea = document.querySelector('#preview-online-footer .mock-input-area');
    const previewInputWrapper = document.querySelector('#preview-online-footer .mock-input-wrapper');
    if (previewInputArea && previewInputWrapper) {
        const cameraBtn = createLineThemeRuntimeButton({
            iconSrc: LINE_THEME_ICON_SRC.camera,
            title: '拍摄',
            className: 'line-theme-extra-btn',
            preview: true
        });
        const galleryBtn = createLineThemeRuntimeButton({
            iconSrc: LINE_THEME_ICON_SRC.gallery,
            title: '相册',
            className: 'line-theme-extra-btn',
            preview: true
        });
        previewInputArea.insertBefore(cameraBtn, previewInputWrapper);
        previewInputArea.insertBefore(galleryBtn, previewInputWrapper);
    }
}
window.__lookySyncLineThemeRuntime = syncLineThemeRuntime;

function updateBuiltInWechatSchemeIfNeeded(scheme) {
    const data = scheme?.data;
    const overrides = data?.cssOverrides;
    if (!overrides) return false;

    let changed = false;
    const headerCss = overrides['preview-online-header'];
    if (typeof headerCss === 'string' && headerCss.includes('微信风格 - 顶栏') && headerCss !== WECHAT_ONLINE_HEADER_CSS) {
        overrides['preview-online-header'] = WECHAT_ONLINE_HEADER_CSS;
        changed = true;
    }

    const footerCss = overrides['preview-online-footer'];
    if (typeof footerCss === 'string' && footerCss.includes('微信风格 - 底栏') && footerCss !== WECHAT_ONLINE_FOOTER_CSS) {
        overrides['preview-online-footer'] = WECHAT_ONLINE_FOOTER_CSS;
        changed = true;
    }

    const sentCss = overrides['online-bubble-sent'];
    if (typeof sentCss === 'string' && !sentCss.includes('WeChat transfer polish v7')) {
        overrides['online-bubble-sent'] = `${sentCss.trim()}\n\n${WECHAT_TRANSFER_CSS}`;
        changed = true;
    }

    if (data.sliders) {
        if (data.sliders['target-online-back'] !== '28') {
            data.sliders['target-online-back'] = '28';
            changed = true;
        }
        if (data.sliders['target-online-grid'] !== '48') {
            data.sliders['target-online-grid'] = '48';
            changed = true;
        }
        if (data.sliders['target-online-emoji'] !== '43') {
            data.sliders['target-online-emoji'] = '43';
            changed = true;
        }
        if (data.sliders['target-online-send'] !== '35') {
            data.sliders['target-online-send'] = '35';
            changed = true;
        }
    }

    return changed;
}
window.__lookyUpdateBuiltInWechatSchemeIfNeeded = updateBuiltInWechatSchemeIfNeeded;

async function loadSavedSchemes() {
    // ▼▼▼ 新增：强制在加载列表前，将内置主题写入数据库 ▼▼▼
    try {
        // 这里只读取内置主题本身；不要为了渲染列表把所有方案（可能含大图片）一次性读入内存。
        const findSchemeByNames = async (names) => {
            for (const name of names) {
                const scheme = await db.themeSchemes.where('name').equals(name).first();
                if (scheme) return scheme;
            }
            return null;
        };
        const existingKktScheme = await findSchemeByNames(['Kkt主题', 'Kkt涓婚']);
        if (updateBuiltInKktSchemeIfNeeded(existingKktScheme)) {
            await db.themeSchemes.update(existingKktScheme.id, { data: existingKktScheme.data });
        }
        const existingWechatScheme = await findSchemeByNames(['微信主题']);
        if (updateBuiltInWechatSchemeIfNeeded(existingWechatScheme)) {
            await db.themeSchemes.update(existingWechatScheme.id, { data: existingWechatScheme.data });
        }
        const existingLineScheme = await findSchemeByNames([LINE_THEME_NAME, 'Line主题']);
        if (updateBuiltInLineSchemeIfNeeded(existingLineScheme)) {
            await db.themeSchemes.update(existingLineScheme.id, {
                name: LINE_THEME_NAME,
                type: 'detail',
                typeName: '聊天详情',
                data: existingLineScheme.data
            });
        }
        if (!existingKktScheme) {
            await db.themeSchemes.add({
                name: 'Kkt主题',
                type: 'detail',
                typeName: '聊天详情',
                date: new Date().toLocaleDateString(),
                data: {
                    cssOverrides: {
                        'preview-online-header': `
/* 顶栏基础设置 */
#preview-online-header { border: 0px solid transparent !important; border-bottom: 0px solid transparent !important; box-shadow: none !important; outline: none !important; }
#preview-online-header::after, #preview-online-header::before { display: none !important; }
#preview-online-header .app-header { background: transparent !important; border-bottom: none !important; box-shadow: none !important; }
#preview-online-header .app-header::after, #preview-online-header .app-header::before { display: none !important; }
.theme-applied .theme-target-detail-header { display: flex; align-items: center; padding: 45px 8px 8px; background-color: var(--c-bg-primary); position: relative; border-bottom: none; }
.theme-applied .theme-target-detail-header .chat-detail-header-left { display: flex; align-items: center; gap: 8px; z-index: 1; }
.theme-applied .theme-target-detail-header .chat-title-group { display: flex; align-items: center; gap: 10px; }
.theme-applied .theme-target-detail-header .chat-detail-avatar { display: none; }
.theme-applied .theme-target-detail-header #chat-detail-char-name { font-size: 17px; font-weight: 600; color: #1c1c1e; position: absolute; left: 50%; transform: translateX(-50%); top: 45px; bottom: 8px; display: flex; align-items: center; max-width: calc(100% - 160px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.theme-applied .theme-target-detail-header .chat-detail-header-right { display: flex; align-items: center; gap: 18px; margin-left: auto; z-index: 1; }
.theme-applied .theme-target-detail-header .header-button { padding: 4px; display: flex; align-items: center; justify-content: center; border-radius: 50%; transition: background-color 0.2s; }
.theme-applied .theme-target-detail-header .header-button:hover { background-color: rgba(0,0,0,0.05); }

/* ▼▼▼ 1. 顶栏-通话 单独偏移 (正数向右/下，负数向左/上) ▼▼▼ */
.theme-applied .theme-target-detail-header #call-btn .beautify-custom-icon { 
    margin-left: 0px !important; 
    margin-top: 0px !important; 
}

/* ▼▼▼ 2. 顶栏-更多 单独偏移 ▼▼▼ */
.theme-applied .theme-target-detail-header #chat-detail-more-btn .beautify-custom-icon { 
    margin-left: 0px !important; 
    margin-top: 0px !important; 
}
`,
                        
                        'preview-online-footer': `
/* 底栏基础设置 */
.theme-applied .theme-target-detail-footer { background-color: var(--c-bg-primary); padding: 6px 0; padding-bottom: 11px; display: flex; flex-direction: column; border-top: 1px solid var(--c-border-light, #E5E5EA); }
.theme-applied .theme-target-detail-footer .chat-input-area { padding: 0 16px; display: flex; align-items: center; gap: 8px; }
.theme-applied .theme-target-detail-footer .text-input-wrapper { background-color: transparent; border-radius: 20px; padding: 0 12px; display: flex; align-items: center; flex-grow: 1; position: relative; z-index: 0; }
.theme-applied .theme-target-detail-footer .text-input-wrapper::after { content: ''; position: absolute; top: 0; bottom: 0; left: 0; right: -40px; background-color: var(--c-bg-secondary); border-radius: 20px; z-index: -1; }
.theme-applied .theme-target-detail-footer #chat-input-field { width: 100%; border: none; background: transparent; font-size: 16px; padding: 6px 0; line-height: 1.5; }
.theme-applied .theme-target-detail-footer .chat-grid-btn { padding: 4px; }
.theme-applied .theme-target-detail-footer .chat-emoji-btn { padding: 4px; position: relative; z-index: 1; }
.theme-applied .theme-target-detail-footer #send-message-btn { background-color: transparent !important; color: transparent; border-radius: 50%; width: 34px; height: 34px; padding: 0; display: flex; align-items: center; justify-content: center; box-shadow: none !important; font-size: 20px; font-weight: bold; border: none !important; }

/* ▼▼▼ 3. 底栏-功能加号 单独偏移 ▼▼▼ */
.theme-applied .theme-target-detail-footer .chat-grid-btn .beautify-custom-icon { 
    margin-left: 0px !important; 
    margin-top: 0px !important; 
}

/* ▼▼▼ 4. 底栏-表情 单独偏移 ▼▼▼ */
.theme-applied .theme-target-detail-footer .chat-emoji-btn .beautify-custom-icon { 
    margin-left: -4px !important; 
    margin-top: 0px !important; 
}

/* ▼▼▼ 5. 底栏-发送 单独偏移 ▼▼▼ */
.theme-applied .theme-target-detail-footer #send-message-btn .beautify-custom-icon { 
    margin-left: 0px !important; 
    margin-top: 0px !important; 
}
`,

                        'online-bubble-received': KKT_ONLINE_BUBBLE_RECEIVED_CSS_FIXED,
                        'online-bubble-sent': KKT_ONLINE_BUBBLE_SENT_CSS_FIXED
                    },
                    icons: {
                        'target-online-call': './images/kkt-call.png',   
                        'target-online-more': './images/kkt-more.png',   
                        'target-online-emoji': './images/kkt-emoji.png', 
                        'target-online-grid': './images/kkt-grid.png',   
                        'target-online-send': './images/kkt-send.png'    
                    },
                    sliders: {
                        'target-online-call': '43',  
                        'target-online-more': '43',  
                        'target-online-emoji': '25', 
                        'target-online-grid': '27',  
                        'target-online-send': '27'   
                    }
                }
            });
        }
        if (!existingLineScheme) {
            await db.themeSchemes.add({
                name: LINE_THEME_NAME,
                type: 'detail',
                typeName: '聊天详情',
                date: new Date().toLocaleDateString(),
                data: createLineThemePayload()
            });
        }
           if (!existingWechatScheme) {
            await db.themeSchemes.add({
                name: '微信主题',
                type: 'detail',
                typeName: '聊天详情',
                date: new Date().toLocaleDateString(),
                data: {
                    cssOverrides: {
                        'preview-online-header': WECHAT_ONLINE_HEADER_CSS,
                        'preview-online-footer': WECHAT_ONLINE_FOOTER_CSS,
                        'online-bubble-received': `
/* 微信风格 - 对方气泡 */
.theme-applied #page-chat-detail .message-wrapper.received,
.theme-applied #preview-online-scene .message-wrapper.received {
    padding-left: 1px;
}
.theme-applied #page-chat-detail .message-wrapper.received .chat-avatar-small,
.theme-applied #preview-online-scene .message-wrapper.received .chat-avatar-small {
    border-radius: 6px !important; /* 微信圆角矩形头像 */
   width: 36px; height: 36px;
}
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble {
    background-color: #ffffff !important;
    color: #000000 !important;
    border-radius: 4.5px !important;
    box-shadow: none !important;
    position: relative;
    margin-left: 2px;
}
/* 气泡小三角 */
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble::before,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble::before {
    content: '';
    position: absolute;
    left: -8px;
    top: 13px;
    width: 0;
    height: 0;
    border-top: 5px solid transparent;
    border-bottom: 5px solid transparent;
    border-right: 8px solid #ffffff;
}
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble:not(.is-transfer-message) p,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble:not(.is-transfer-message) p {
    color: #000000 !important;
    padding: 8px 10px;
    font-size: 15px;
}
/* [最终修正] 微信风格 - 引用消息 (对方) */
.theme-applied #page-chat-detail .message-wrapper.received .message-reply-preview,
.theme-applied #preview-online-scene .message-wrapper.received .message-reply-preview {
    /* 核心修改：使用绝对定位 */
    position: absolute;
    margin: 0 !important;
    bottom: -30px; /* 定位到气泡下方30px的位置 */
    left: 2px;    /* 对齐到消息体的左侧（留出头像位置）*/
    width: auto;
    max-width: 100%;

    /* 外观样式 - 统一为半透明白底黑字 */
    padding: 6px 12px !important;
    background: rgba(255, 255, 255, 0.09) !important; /* 半透明白色背景 */
    backdrop-filter: blur(8px) !important;
    -webkit-backdrop-filter: blur(8px) !important;
    border: none !important;
    border-radius: 8px !important;
    font-size: 12px !important;
    color: #000 !important; /* 黑色文字 */
}
/* 引用消息里的加粗字体（如人名）*/
.theme-applied #page-chat-detail .message-wrapper.received .message-reply-preview strong,
.theme-applied #preview-online-scene .message-wrapper.received .message-reply-preview strong {
    color: #000 !important;
    font-weight: 600 !important;
}

/* 关键：只为包含“引用”的消息行增加下边距，避免影响普通消息 */
.theme-applied #page-chat-detail .message-wrapper.sent:has(.message-reply-preview),
.theme-applied #preview-online-scene .message-wrapper.sent:has(.message-reply-preview) {
    margin-bottom: 25px !important; /* 调整为一个更合适的值 */
}

`
,
                        'online-bubble-sent': `
/* 微信风格 - 己方气泡 */
.theme-applied #page-chat-detail .message-wrapper.sent,
.theme-applied #preview-online-scene .message-wrapper.sent {
    padding-right: 2px;
}
.theme-applied #page-chat-detail .message-wrapper.sent .chat-avatar-small,
.theme-applied #preview-online-scene .message-wrapper.sent .chat-avatar-small {
    border-radius: 6px !important;
    width: 36px; height: 36px;
}
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble,
.theme-applied #page-chat-detail .message-wrapper.sent .voice-bar,
.theme-applied #preview-online-scene .message-wrapper.sent .voice-bar {
    background-color: #95ec69 !important; /* 微信绿 */
    color: #000000 !important;
    border-radius: 4.5px !important;
    box-shadow: none !important;
    position: relative;
    margin-left: 2px
}
/* 气泡小三角 */
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble::after,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble::after {
    content: '';
    position: absolute;
    right: -8px;
    top: 13px;
    width: 0;
    height: 0;
    border-top: 5px solid transparent;
    border-bottom: 5px solid transparent;
    border-left: 8px solid #95ec69;
}
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble:not(.is-transfer-message) p,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble:not(.is-transfer-message) p {
    color: #000000 !important;
    padding: 8px 10px;
    font-size: 15px;
}
/* [最终修正] 微信风格 - 引用消息 (己方) */
.theme-applied #page-chat-detail .message-wrapper.sent .message-reply-preview,
.theme-applied #preview-online-scene .message-wrapper.sent .message-reply-preview {
    /* 核心修改：使用绝对定位 */
    position: absolute;
    margin: 0 !important;
    bottom: -30px; /* 定位到气泡下方30px的位置 */
    /* 关键对齐：右移44px，以抵消头像占用的空间，从而与气泡右边缘对齐 */
    right: 2px;
    width: auto;
    max-width: 100%;

    /* 外观样式 - 统一为半透明白底黑字 */
    padding: 6px 12px !important;
    background: rgba(255, 255, 255, 0.09) !important; /* 半透明白色背景 */
    backdrop-filter: blur(8px) !important;
    -webkit-backdrop-filter: blur(8px) !important;
    border: none !important;
    border-radius: 8px !important;
    font-size: 12px !important;
    color: #000 !important; /* 黑色文字 */
}
/* 引用消息里的加粗字体（如人名）*/
.theme-applied #page-chat-detail .message-wrapper.sent .message-reply-preview strong,
.theme-applied #preview-online-scene .message-wrapper.sent .message-reply-preview strong {
    color: #000 !important;
    font-weight: 600 !important;
}
/* 关键：只为包含“引用”的消息行增加下边距，避免影响普通消息 */
.theme-applied #page-chat-detail .message-wrapper.received:has(.message-reply-preview),
.theme-applied #preview-online-scene .message-wrapper.received:has(.message-reply-preview) {
    margin-bottom: 25px !important; /* 调整为一个更合适的值 */
}


${WECHAT_TRANSFER_CSS}
`

                    },
                    sliders: {
                        'target-online-back': '28',
                        'target-online-more': '24',
                        'target-online-grid': '48',  /* 语音图标 */
                        'target-online-emoji': '43', /* 表情图标 */
                        'target-online-send': '35'   /* 更多图标 */
                    },
                    icons: {
                        /* 顶栏图标 - 如果你有自己的返回和更多图标，也可以放在这里 */
                        'target-online-back': '/images/wechat-back.png', /* 留空则使用默认SVG，你可以填入 wechat-back.png 的路径 */
                        'target-online-more': '', /* 留空则使用默认SVG，你可以填入 wechat-more.png 的路径 */
                        
                        /* 底栏图标 - 请在这里填入你上传后的图标路径 */
                        'target-online-grid': '/images/wechat-voice.png',  /* 对应左侧语音按钮，请填入 wechat-voice.png 的路径 */
                        'target-online-emoji': '/images/wechat-emoji.png', /* 对应右侧表情按钮，请填入 wechat-emoji.png 的路径 */
                        'target-online-send': '/images/wechat-plus.png'   /* 对应右侧“+”按钮，请填入 wechat-plus.png 的路径 */
                    }
                }
            });
        }
        {
            const existingGlassScheme = await findSchemeByNames(['雾窗毛玻璃主题']);
            const glassPhoneIcon = `data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg' fill='none' stroke='%23666' stroke-width='1.85' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15 10.5 20.2 7a1 1 0 0 1 1.6.82v8.36a1 1 0 0 1-1.6.82L15 13.5'/%3E%3Crect x='2.5' y='6' width='12.5' height='12' rx='3'/%3E%3C/svg%3E`;
            const glassMoreIcon = `data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg' fill='none' stroke='%23666' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='1' fill='%23666'/%3E%3Ccircle cx='19' cy='12' r='1' fill='%23666'/%3E%3Ccircle cx='5' cy='12' r='1' fill='%23666'/%3E%3C/svg%3E`;
            const glassPlusIcon = `data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg' fill='none' stroke='%23666' stroke-width='1.85' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 2.8a3 3 0 0 0-3 3v6.4a3 3 0 0 0 6 0V5.8a3 3 0 0 0-3-3Z'/%3E%3Cpath d='M5.5 10.8v1.4a6.5 6.5 0 0 0 13 0v-1.4M12 18.7v2.5M8.8 21.2h6.4'/%3E%3C/svg%3E`;
            const glassMoonIcon = `data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg' fill='none' stroke='%23666' stroke-width='1.85' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='9'/%3E%3Cpath d='M8.6 14.2c.9 1 2 1.5 3.4 1.5s2.5-.5 3.4-1.5'/%3E%3Cpath d='M9.2 9.8h.01M14.8 9.8h.01'/%3E%3C/svg%3E`;
            const glassClipIcon = `data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg' fill='none' stroke='%23666' stroke-width='1.85' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5'/%3E%3C/svg%3E`;

            const glassSchemePayload = {
                name: '雾窗毛玻璃主题',
                type: 'all',
                typeName: '整套方案',
                date: new Date().toLocaleDateString(),
                data: {
                    cssOverrides: {
                        'preview-online-header': `
/* 雾窗毛玻璃 - 线上顶栏 */
#preview-online-scene {
    position: relative !important;
}
#preview-online-bg,
.theme-applied #page-chat-detail .chat-detail-content {
    background-color: transparent !important;
    background-size: cover !important;
    background-position: center !important;
    background-repeat: no-repeat !important;
    box-sizing: border-box !important;
}
.theme-applied #page-chat-detail .chat-detail-content {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    padding: 90px 0 58px !important;
}
.theme-applied #page-chat-detail .chat-message-list {
    padding: 0 12px !important;
    padding-bottom: 10px !important;
    box-sizing: border-box !important;
    gap: 8px !important;
    row-gap: 8px !important;
    scroll-padding-top: 90px !important;
    scroll-padding-bottom: 58px !important;
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%) !important;
    mask-image: linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%) !important;
}
#preview-online-bg {
    padding: 76px 12px 42px !important;
    padding-bottom: 46px !important;
    overflow-y: auto !important;
    gap: 8px !important;
    row-gap: 8px !important;
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%) !important;
    mask-image: linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%) !important;
}
.theme-applied .theme-target-detail-header,
#preview-online-header {
    position: absolute !important;
    left: 0 !important;
    right: 0 !important;
    top: 0 !important;
    z-index: 80 !important;
    width: auto !important;
    min-height: 88px !important;
    padding: 48px 12px 0 !important;
    border-radius: 0 !important;
    background: transparent !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    border: none !important;
    box-shadow: none !important;
}
.theme-applied .theme-target-detail-header .chat-detail-header-left,
.theme-applied .theme-target-detail-header .chat-detail-header-right,
#preview-online-header .mock-header-left,
#preview-online-header .mock-header-right {
    position: static !important;
    z-index: 1 !important;
}
.theme-applied .theme-target-detail-header #chat-header-normal {
    position: relative !important;
    width: 100% !important;
    height: 40px !important;
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
}
.theme-applied #page-chat-detail.multiselect-active #chat-header-normal {
    display: none !important;
}
.theme-applied #page-chat-detail #chat-header-multiselect {
    position: relative !important;
    width: 100% !important;
    height: 40px !important;
    align-items: center !important;
    justify-content: space-between !important;
    gap: 6px !important;
}
.theme-applied #page-chat-detail #chat-header-multiselect .multiselect-action-group {
    display: flex !important;
    align-items: center !important;
    justify-content: flex-end !important;
    gap: 2px !important;
    flex: 0 0 auto !important;
}
.theme-applied #page-chat-detail #chat-header-multiselect button {
    min-width: 38px !important;
    height: 34px !important;
    margin: 0 !important;
    padding: 0 5px !important;
    border: none !important;
    border-radius: 20px !important;
    background: transparent !important;
    color: rgba(55,55,55,0.82) !important;
    font-size: var(--looky-font-xs, 10px) !important;
    font-weight: 600 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
}
.theme-applied #page-chat-detail #chat-header-multiselect button:disabled {
    color: rgba(125,125,125,0.58) !important;
}
.theme-applied #page-chat-detail #chat-header-multiselect #multiselect-counter {
    position: static !important;
    transform: none !important;
    flex: 1 1 auto !important;
    min-width: 0 !important;
    width: auto !important;
    margin: 0 !important;
    color: rgba(35,35,35,0.9) !important;
    font-size: var(--looky-font-xs, 10px) !important;
    font-weight: 700 !important;
    line-height: 1.25 !important;
    text-align: center !important;
    white-space: nowrap !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
}
.theme-applied .theme-target-detail-header .chat-title-group,
#preview-online-header .mock-title-group {
    position: absolute !important;
    left: 50% !important;
    top: 50% !important;
    transform: translate(-50%, -50%) !important;
    width: calc(100% - 170px) !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    z-index: 1 !important;
}
.theme-applied .theme-target-detail-header .chat-detail-avatar,
#preview-online-header .mock-avatar-small {
    display: none !important;
}
.theme-applied .theme-target-detail-header #chat-detail-char-name,
#preview-online-title {
    position: static !important;
    transform: none !important;
    color: rgba(35,35,35,0.9) !important;
    font-size: var(--looky-font-md, 12px) !important;
    font-weight: 700 !important;
    letter-spacing: 0 !important;
    max-width: 100% !important;
    white-space: nowrap !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
}
.theme-applied .theme-target-detail-header .back-button,
.theme-applied .theme-target-detail-header #call-btn,
.theme-applied .theme-target-detail-header #chat-detail-more-btn,
#preview-online-header .mock-back-btn,
#target-online-call,
#target-online-more {
    width: 40px !important;
    height: 40px !important;
    padding: 0 !important;
    border-radius: 50% !important;
    background: linear-gradient(145deg, rgba(255,255,255,0.22), rgba(255,255,255,0.05)) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    border: 1px solid rgba(255,255,255,0.32) !important;
    box-shadow: inset 0 1px 2px rgba(255,255,255,0.42), inset 0 -1px 1px rgba(255,255,255,0.12), 0 8px 18px rgba(90,90,90,0.06) !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    position: relative !important;
    z-index: 2 !important;
}
.theme-applied .theme-target-detail-header #call-btn .beautify-custom-icon,
.theme-applied .theme-target-detail-header #chat-detail-more-btn .beautify-custom-icon,
.theme-applied .theme-target-detail-footer .chat-grid-btn .beautify-custom-icon,
.theme-applied .theme-target-detail-footer .chat-emoji-btn .beautify-custom-icon,
.theme-applied .theme-target-detail-footer #send-message-btn .beautify-custom-icon {
    opacity: 0.9 !important;
}
`,
                        'preview-online-footer': `
/* 雾窗毛玻璃 - 线上底栏 */
.theme-applied .theme-target-detail-footer,
#preview-online-footer {
    background: transparent !important;
    border-top: none !important;
    box-shadow: none !important;
    position: absolute !important;
    left: 0 !important;
    right: 0 !important;
    bottom: 0 !important;
    z-index: 80 !important;
    width: auto !important;
    padding: 0 10px max(16px, env(safe-area-inset-bottom)) !important;
}
.theme-applied .theme-target-detail-footer .chat-input-area,
#preview-online-footer .mock-input-area {
    gap: 6px !important;
    padding: 0 !important;
    align-items: center !important;
    position: relative !important;
}
.theme-applied .theme-target-detail-footer .chat-grid-btn,
#target-online-grid {
    width: 40px !important;
    height: 40px !important;
    flex: 0 0 40px !important;
    padding: 0 !important;
    border-radius: 50% !important;
    background: linear-gradient(145deg, rgba(255,255,255,0.22), rgba(255,255,255,0.05)) !important;
    border: 1px solid rgba(255,255,255,0.32) !important;
    box-shadow: inset 0 1px 2px rgba(255,255,255,0.42), inset 0 -1px 1px rgba(255,255,255,0.12), 0 8px 18px rgba(100,100,100,0.06) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    overflow: hidden !important;
}
.theme-applied .theme-target-detail-footer .text-input-wrapper,
#preview-online-footer .mock-input-wrapper {
    min-height: 40px !important;
    height: 40px !important;
    border-radius: 999px !important;
    padding: 0 98px 0 16px !important;
    margin-right: 0 !important;
    flex-grow: 1 !important;
    min-width: 0 !important;
    position: relative !important;
    z-index: 0 !important;
    background: linear-gradient(145deg, rgba(255,255,255,0.24), rgba(255,255,255,0.06)) !important;
    border: 1px solid rgba(255,255,255,0.34) !important;
    box-shadow: inset 0 1px 2px rgba(255,255,255,0.44), inset 0 -1px 1px rgba(255,255,255,0.12), 0 8px 18px rgba(120,120,120,0.06) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
}
.theme-applied .theme-target-detail-footer .chat-emoji-btn,
.theme-applied .theme-target-detail-footer #send-message-btn,
#target-online-emoji,
#target-online-send {
    width: 36px !important;
    height: 36px !important;
    flex: 0 0 36px !important;
    padding: 0 !important;
    background: transparent !important;
    border: none !important;
    box-shadow: none !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    position: absolute !important;
    z-index: 1 !important;
}
.theme-applied .theme-target-detail-footer .chat-emoji-btn,
#target-online-emoji {
    right: 56px !important;
    top: 50% !important;
    transform: translateY(-50%) !important;
}
.theme-applied .theme-target-detail-footer #send-message-btn,
#target-online-send {
    right: 10px !important;
    top: 50% !important;
    transform: translateY(-50%) !important;
}
.theme-applied .theme-target-detail-footer #chat-input-field,
#preview-online-footer input {
    color: rgba(40,40,40,0.84) !important;
    font-size: var(--looky-font-lg, 13px) !important;
    font-weight: 500 !important;
    padding: 10px 0 !important;
    height: 100% !important;
    box-sizing: border-box !important;
}
.theme-applied .theme-target-detail-footer #chat-input-field::placeholder,
#preview-online-footer input::placeholder {
    color: rgba(120,120,120,0.56) !important;
}
`,
                        'online-bubble-received': `
/* 雾窗毛玻璃 - 对方气泡 */
.theme-applied #page-chat-detail .message-wrapper.received,
.theme-applied #preview-online-scene .message-wrapper.received {
    align-self: flex-start !important;
    gap: 8px !important;
    margin-top: 0 !important;
    max-width: 88% !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .bubble-container,
.theme-applied #preview-online-scene .message-wrapper.received .bubble-container {
    position: relative !important;
    padding-top: 53px !important;
}
.theme-applied #page-chat-detail .message-wrapper .message-timestamp-outside,
.theme-applied #preview-online-scene .message-wrapper .message-timestamp-outside {
    display: none !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .bubble-container::before,
.theme-applied #preview-online-scene .message-wrapper.received .bubble-container::before {
    content: attr(data-message-time) !important;
    position: absolute !important;
    left: 2px !important;
    top: 8px !important;
    width: 72px !important;
    height: auto !important;
    background: transparent !important;
    border: none !important;
    box-shadow: none !important;
    color: rgba(72,72,72,0.66) !important;
    font-size: var(--looky-font-xs, 10px) !important;
    line-height: 1.55 !important;
    font-weight: 500 !important;
    white-space: pre !important;
    letter-spacing: 0 !important;
    text-shadow: 0 1px 1px rgba(255,255,255,0.42) !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .bubble-container::after,
.theme-applied #preview-online-scene .message-wrapper.received .bubble-container::after {
    content: '' !important;
    position: absolute !important;
    left: -48px !important;
    top: 47px !important;
    width: 124px !important;
    height: 0 !important;
    border-top: 1px dashed rgba(105,105,105,0.30) !important;
}
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received .bubble-container::before,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received .bubble-container::before {
    display: none !important;
}
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received .bubble-container::after,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received .bubble-container::after {
    display: none !important;
}
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received .bubble-container,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received .bubble-container {
    padding-top: 0 !important;
}
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received {
    margin-top: 0 !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent + .message-wrapper.received,
.theme-applied #preview-online-scene .message-wrapper.sent + .message-wrapper.received {
    margin-top: 0 !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .chat-avatar-small,
.theme-applied #preview-online-scene .message-wrapper.received .chat-avatar-small {
    width: 42px !important;
    height: 42px !important;
    border-radius: 50% !important;
    border: 1px solid rgba(255,255,255,0.75) !important;
    box-shadow: 0 4px 14px rgba(150,150,150,0.18) !important;
}
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received .chat-avatar-small,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received .chat-avatar-small {
    display: none !important;
}
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received .chat-avatar-small + div,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received .chat-avatar-small + div {
    margin-left: 50px !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message) {
    background: rgba(255,255,255,0.38) !important;
    border: 1px solid rgba(255,255,255,0.62) !important;
    border-radius: 12px 18px 18px 12px !important;
    box-shadow: inset 0 1px 1px rgba(255,255,255,0.65), 0 10px 28px rgba(110,110,110,0.14) !important;
    backdrop-filter: blur(18px) saturate(130%) !important;
    -webkit-backdrop-filter: blur(18px) saturate(130%) !important;
    color: rgba(30,30,30,0.92) !important;
    position: relative !important;
}
.theme-applied #page-chat-detail .message-wrapper.received:has(+ .message-wrapper.received) .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.received:has(+ .message-wrapper.received) .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message) {
    border-bottom-left-radius: 8px !important;
}
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message) {
    border-top-left-radius: 8px !important;
}
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.received:has(+ .message-wrapper.received) .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.received:has(+ .message-wrapper.received) .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message) {
    border-radius: 12px 18px 18px 12px !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message) p,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message) p {
    padding: 6px 12px !important;
    font-size: var(--looky-font-md, 12px) !important;
    line-height: 1.42 !important;
    letter-spacing: 0.1px !important;
    color: rgba(48,48,48,0.86) !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .voice-bar,
.theme-applied #preview-online-scene .message-wrapper.received .voice-bar {
    background: rgba(255,255,255,0.38) !important;
    border: 1px solid rgba(255,255,255,0.62) !important;
    border-radius: 12px 18px 18px 12px !important;
    box-shadow: inset 0 1px 1px rgba(255,255,255,0.65), 0 10px 28px rgba(110,110,110,0.14) !important;
    backdrop-filter: blur(18px) saturate(130%) !important;
    -webkit-backdrop-filter: blur(18px) saturate(130%) !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .voice-bar .bar,
.theme-applied #preview-online-scene .message-wrapper.received .voice-bar .bar {
    background: rgba(42,42,42,0.68) !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .voice-bar .voice-duration,
.theme-applied #preview-online-scene .message-wrapper.received .voice-bar .voice-duration {
    color: rgba(42,42,42,0.68) !important;
}
.theme-applied #page-chat-detail .message-wrapper.received:has(.message-reply-preview),
.theme-applied #preview-online-scene .message-wrapper.received:has(.message-reply-preview) {
    margin-bottom: 28px !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .message-reply-preview,
.theme-applied #preview-online-scene .message-wrapper.received .message-reply-preview {
    position: absolute !important;
    left: 6px !important;
    bottom: -25px !important;
    max-width: 180px !important;
    padding: 3px 8px !important;
    margin: 0 !important;
    border: none !important;
    border-radius: 7px !important;
    background: rgba(255,255,255,0.30) !important;
    color: rgba(60,60,60,0.62) !important;
    font-size: var(--looky-font-xs, 10px) !important;
    line-height: 1.2 !important;
    box-shadow: inset 0 1px 1px rgba(255,255,255,0.5) !important;
    overflow: visible !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .message-reply-preview::after,
.theme-applied #preview-online-scene .message-wrapper.received .message-reply-preview::after {
    display: none !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble:has(.message-reply-preview)::before,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble:has(.message-reply-preview)::before {
    display: none !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .message-reply-preview strong,
.theme-applied #preview-online-scene .message-wrapper.received .message-reply-preview strong {
    color: rgba(45,45,45,0.68) !important;
}
`,
                        'online-bubble-sent': `
/* 雾窗毛玻璃 - 自己气泡 */
.theme-applied #page-chat-detail .message-wrapper.sent,
.theme-applied #preview-online-scene .message-wrapper.sent {
    align-self: flex-end !important;
    flex-direction: row-reverse !important;
    margin-top: 0 !important;
    max-width: 80% !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent + .message-wrapper.sent,
.theme-applied #preview-online-scene .message-wrapper.sent + .message-wrapper.sent {
    margin-top: 0 !important;
}
.theme-applied #page-chat-detail .message-wrapper.received + .message-wrapper.sent,
.theme-applied #preview-online-scene .message-wrapper.received + .message-wrapper.sent {
    margin-top: 0 !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent .chat-avatar-small,
.theme-applied #preview-online-scene .message-wrapper.sent .chat-avatar-small {
    display: none !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message),
.theme-applied #page-chat-detail .message-wrapper.sent .voice-bar,
.theme-applied #preview-online-scene .message-wrapper.sent .voice-bar {
    background: rgba(145,145,145,0.28) !important;
    border: 1px solid rgba(255,255,255,0.55) !important;
    border-radius: 18px 12px 12px 18px !important;
    box-shadow: inset 0 1px 1px rgba(255,255,255,0.45), 0 10px 26px rgba(80,80,80,0.16) !important;
    backdrop-filter: blur(18px) saturate(125%) !important;
    -webkit-backdrop-filter: blur(18px) saturate(125%) !important;
    position: relative !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent:has(+ .message-wrapper.sent) .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.sent:has(+ .message-wrapper.sent) .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message),
.theme-applied #page-chat-detail .message-wrapper.sent:has(+ .message-wrapper.sent) .voice-bar,
.theme-applied #preview-online-scene .message-wrapper.sent:has(+ .message-wrapper.sent) .voice-bar {
    border-bottom-right-radius: 8px !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent + .message-wrapper.sent .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.sent + .message-wrapper.sent .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message),
.theme-applied #page-chat-detail .message-wrapper.sent + .message-wrapper.sent .voice-bar,
.theme-applied #preview-online-scene .message-wrapper.sent + .message-wrapper.sent .voice-bar {
    border-top-right-radius: 8px !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent + .message-wrapper.sent:has(+ .message-wrapper.sent) .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message),
.theme-applied #preview-online-scene .message-wrapper.sent + .message-wrapper.sent:has(+ .message-wrapper.sent) .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message),
.theme-applied #page-chat-detail .message-wrapper.sent + .message-wrapper.sent:has(+ .message-wrapper.sent) .voice-bar,
.theme-applied #preview-online-scene .message-wrapper.sent + .message-wrapper.sent:has(+ .message-wrapper.sent) .voice-bar {
    border-radius: 18px 12px 12px 18px !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message) p,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble:not(.gallery-image-bubble):not(.photo-card):not(.is-location-message):not(.is-transfer-message) p {
    padding: 6px 12px !important;
    font-size: var(--looky-font-md, 12px) !important;
    line-height: 1.42 !important;
    letter-spacing: 0.1px !important;
    color: rgba(42,42,42,0.84) !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble.sticker-bubble,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble.sticker-bubble {
    padding: 0 !important;
    background: transparent !important;
    border: none !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    max-width: 120px !important;
    overflow: visible !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble.sticker-bubble img,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble.sticker-bubble img {
    display: block !important;
    width: 100% !important;
    height: auto !important;
    border-radius: 8px !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent:has(.message-reply-preview),
.theme-applied #preview-online-scene .message-wrapper.sent:has(.message-reply-preview) {
    margin-bottom: 28px !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent .message-reply-preview,
.theme-applied #preview-online-scene .message-wrapper.sent .message-reply-preview {
    position: absolute !important;
    right: 6px !important;
    bottom: -25px !important;
    max-width: 180px !important;
    padding: 3px 8px !important;
    margin: 0 !important;
    border: none !important;
    border-radius: 7px !important;
    background: rgba(255,255,255,0.26) !important;
    color: rgba(45,45,45,0.58) !important;
    font-size: var(--looky-font-xs, 10px) !important;
    line-height: 1.2 !important;
    box-shadow: inset 0 1px 1px rgba(255,255,255,0.44) !important;
    overflow: visible !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent .message-reply-preview::after,
.theme-applied #preview-online-scene .message-wrapper.sent .message-reply-preview::after {
    display: none !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble:has(.message-reply-preview)::before,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble:has(.message-reply-preview)::before {
    display: none !important;
}
.theme-applied #page-chat-detail .message-wrapper.sent .message-reply-preview strong,
.theme-applied #preview-online-scene .message-wrapper.sent .message-reply-preview strong {
    color: rgba(35,35,35,0.64) !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble.gallery-image-bubble,
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble.gallery-image-bubble,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble.gallery-image-bubble,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble.gallery-image-bubble {
    padding: 0 !important;
    background: rgba(239,239,244,0.34) !important;
    border: none !important;
    border-radius: var(--radius-lg) !important;
    box-shadow: none !important;
    overflow: hidden !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble.gallery-image-bubble img,
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble.gallery-image-bubble img,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble.gallery-image-bubble img,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble.gallery-image-bubble img {
    border-radius: 8px !important;
    filter: none !important;
    opacity: 1 !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble.photo-card,
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble.photo-card,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble.photo-card,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble.photo-card {
    background: radial-gradient(circle at 50% 36%, rgba(255,255,255,0.58), rgba(210,210,210,0.24) 68%, rgba(255,255,255,0.08)) !important;
    border: 1px solid rgba(255,255,255,0.56) !important;
    border-radius: var(--radius-lg) !important;
    box-shadow: inset 0 1px 1px rgba(255,255,255,0.55), 0 10px 24px rgba(90,90,90,0.13) !important;
}
.theme-applied #page-chat-detail .photo-card-preview .photo-card-placeholder-icon svg,
.theme-applied #preview-online-scene .photo-card-preview .photo-card-placeholder-icon svg {
    stroke: rgba(120,120,120,0.50) !important;
}
.theme-applied #page-chat-detail .photo-card-preview .preview-text,
.theme-applied #preview-online-scene .photo-card-preview .preview-text {
    color: rgba(92,92,92,0.74) !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble.is-location-message,
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble.is-location-message,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble.is-location-message,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble.is-location-message {
    padding: 0 !important;
    background: transparent !important;
    border: none !important;
    border-radius: 12px !important;
    box-shadow: none !important;
    overflow: hidden !important;
}
.theme-applied #page-chat-detail .location-card,
.theme-applied #preview-online-scene .location-card {
    background: rgba(245,245,245,0.48) !important;
    border: 1px solid rgba(255,255,255,0.56) !important;
    border-radius: 12px !important;
    box-shadow: inset 0 1px 1px rgba(255,255,255,0.48), 0 10px 24px rgba(90,90,90,0.13) !important;
    overflow: hidden !important;
}
.theme-applied #page-chat-detail .location-card-text,
.theme-applied #preview-online-scene .location-card-text {
    background: rgba(255,255,255,0.30) !important;
    border-bottom: 1px solid rgba(255,255,255,0.42) !important;
    color: rgba(36,36,36,0.86) !important;
}
.theme-applied #page-chat-detail .location-card-map,
.theme-applied #preview-online-scene .location-card-map {
    filter: grayscale(1) saturate(0.25) brightness(1.08) contrast(0.94) !important;
    opacity: 0.94 !important;
}
.theme-applied #page-chat-detail .message-wrapper.received .message-bubble.is-transfer-message,
.theme-applied #page-chat-detail .message-wrapper.sent .message-bubble.is-transfer-message,
.theme-applied #preview-online-scene .message-wrapper.received .message-bubble.is-transfer-message,
.theme-applied #preview-online-scene .message-wrapper.sent .message-bubble.is-transfer-message {
    padding: 0 !important;
    background: transparent !important;
    border: none !important;
    border-radius: 8px !important;
    box-shadow: none !important;
    width: 220px !important;
    overflow: visible !important;
}
.theme-applied #page-chat-detail .transfer-card,
.theme-applied #preview-online-scene .transfer-card,
.theme-applied #page-chat-detail .transfer-card.transfer-pending,
.theme-applied #preview-online-scene .transfer-card.transfer-pending,
.theme-applied #page-chat-detail .transfer-card.transfer-receipt,
.theme-applied #preview-online-scene .transfer-card.transfer-receipt {
    background: linear-gradient(145deg, rgba(255,255,255,0.58), rgba(220,220,220,0.34)) !important;
    border: 1px solid rgba(255,255,255,0.52) !important;
    border-radius: 8px !important;
    box-shadow: inset 0 1px 1px rgba(255,255,255,0.54), 0 10px 24px rgba(80,80,80,0.12) !important;
    overflow: hidden !important;
}
.theme-applied #page-chat-detail .transfer-card::after,
.theme-applied #preview-online-scene .transfer-card::after {
    display: none !important;
}
.theme-applied #page-chat-detail .transfer-text-group p,
.theme-applied #preview-online-scene .transfer-text-group p,
.theme-applied #page-chat-detail .transfer-text-group .amount,
.theme-applied #preview-online-scene .transfer-text-group .amount,
.theme-applied #page-chat-detail .transfer-text-group .status-text,
.theme-applied #preview-online-scene .transfer-text-group .status-text {
    padding: 0 !important;
    color: rgba(36,36,36,0.86) !important;
}
.theme-applied #page-chat-detail .transfer-icon,
.theme-applied #preview-online-scene .transfer-icon {
    width: 34px !important;
    height: 34px !important;
    margin-right: 10px !important;
    border-radius: 50% !important;
    background: rgba(255,255,255,0.64) !important;
    filter: grayscale(1) saturate(0.2) !important;
}
.theme-applied #page-chat-detail .transfer-footer,
.theme-applied #preview-online-scene .transfer-footer {
    border-top: 1px solid rgba(255,255,255,0.42) !important;
    background: rgba(255,255,255,0.18) !important;
    color: rgba(96,96,96,0.66) !important;
}
.theme-applied #page-chat-detail .message-wrapper .message-bubble.is-voice-call-summary,
.theme-applied #page-chat-detail .message-wrapper .message-bubble.is-voice-call-rejected,
.theme-applied #preview-online-scene .message-wrapper .message-bubble.is-voice-call-summary,
.theme-applied #preview-online-scene .message-wrapper .message-bubble.is-voice-call-rejected {
    display: flex !important;
    flex-direction: row !important;
    align-items: center !important;
    gap: 8px !important;
    width: auto !important;
    max-width: fit-content !important;
    padding: 8px 12px !important;
    border-radius: 16px !important;
    background: linear-gradient(145deg, rgba(255,255,255,0.42), rgba(220,220,220,0.20)) !important;
    border: 1px solid rgba(255,255,255,0.56) !important;
    box-shadow: inset 0 1px 1px rgba(255,255,255,0.56), 0 8px 20px rgba(80,80,80,0.10) !important;
    color: rgba(42,42,42,0.82) !important;
    backdrop-filter: blur(12px) saturate(120%) !important;
    -webkit-backdrop-filter: blur(12px) saturate(120%) !important;
    overflow: hidden !important;
}
.theme-applied #page-chat-detail .message-wrapper .message-bubble.is-voice-call-summary p,
.theme-applied #page-chat-detail .message-wrapper .message-bubble.is-voice-call-rejected p,
.theme-applied #preview-online-scene .message-wrapper .message-bubble.is-voice-call-summary p,
.theme-applied #preview-online-scene .message-wrapper .message-bubble.is-voice-call-rejected p {
    padding: 0 !important;
    margin: 0 !important;
    font-size: var(--looky-font-sm, 11px) !important;
    line-height: 1.25 !important;
    white-space: nowrap !important;
    color: rgba(42,42,42,0.78) !important;
}
.theme-applied #page-chat-detail .message-wrapper .message-bubble.is-voice-call-summary svg,
.theme-applied #page-chat-detail .message-wrapper .message-bubble.is-voice-call-rejected svg,
.theme-applied #preview-online-scene .message-wrapper .message-bubble.is-voice-call-summary svg,
.theme-applied #preview-online-scene .message-wrapper .message-bubble.is-voice-call-rejected svg {
    width: 18px !important;
    height: 18px !important;
    flex-shrink: 0 !important;
    stroke: rgba(72,72,72,0.70) !important;
}
.theme-applied #page-chat-detail .message-wrapper .message-bubble.is-voice-call-rejected,
.theme-applied #preview-online-scene .message-wrapper .message-bubble.is-voice-call-rejected {
    background: linear-gradient(145deg, rgba(255,255,255,0.38), rgba(210,210,210,0.18)) !important;
}
`
                    },
                    icons: {
                        'target-online-call': glassPhoneIcon,
                        'target-online-more': glassMoreIcon,
                        'target-online-grid': glassPlusIcon,
                        'target-online-emoji': glassMoonIcon,
                        'target-online-send': glassClipIcon
                    },
                    sliders: {
                        'target-online-call': '22',
                        'target-online-more': '22',
                        'target-online-grid': '24',
                        'target-online-emoji': '26',
                        'target-online-send': '24'
                    }
                }
            };

            if (existingGlassScheme) {
                await db.themeSchemes.update(existingGlassScheme.id, glassSchemePayload);
            } else {
                await db.themeSchemes.add(glassSchemePayload);
            }
        }
 
    } catch (e) { console.warn("内置主题注入失败", e); }
    // ▲▲▲ 新增完毕 ▲▲▲

    // 1. 清空现有列表（保留重置按钮）
    const items = schemeList.querySelectorAll('.scheme-item:not(#reset-current-theme-btn)');
    items.forEach(item => item.remove());

    const resetBtn = document.getElementById('reset-current-theme-btn');
    if (resetBtn && !resetBtn.dataset.listenerAdded) {
        resetBtn.addEventListener('click', resetBeautifyPage);
        resetBtn.dataset.listenerAdded = 'true';
    }
    
    // 2. 逐条读取并渲染摘要，避免在内存中保留所有方案的 data。
    await db.themeSchemes.orderBy('id').reverse().each(scheme => {
        renderSchemeItem({
            id: scheme.id,
            name: scheme.name,
            typeName: scheme.typeName,
            date: scheme.date
        });
    });
}

    if (exportSchemesBtn) {
    exportSchemesBtn.addEventListener('click', handleExportSelectedSchemes);
}
if (schemeImportInput) {
    schemeImportInput.addEventListener('change', handleImportSchemes);
}
/**
 * 辅助函数：下载 Blob 对象为文件
 */
function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

async function exportSchemeBlob(blob, fileName) {
    if (isNativeRuntime()) {
        await saveBlobToNativeStorage(blob, fileName, {
            folder: 'LookyThemes',
            shareTitle: '导出聊天美化方案',
            shareText: 'LOOKY 聊天美化方案'
        });
        return;
    }
    downloadBlob(blob, fileName);
}
/**
 * 处理导出选中的方案
 */
async function handleExportSelectedSchemes() {
    const checkedBoxes = schemeList.querySelectorAll('.scheme-select-checkbox:checked');
    if (checkedBoxes.length === 0) {
        alert('请先勾选需要导出的方案。');
        return;
    }
    const idsToExport = Array.from(checkedBoxes).map(cb => parseInt(cb.dataset.id));
    
    try {
        const schemesToExport = await db.themeSchemes.bulkGet(idsToExport);
        
        // 清理数据，移除数据库特有的 `id` 字段，使其更具通用性
        const cleanSchemes = schemesToExport.filter(Boolean).map(({ id, ...rest }) => rest);
        if (cleanSchemes.length === 0) {
            alert('未能找到选中的方案数据。');
            return;
        }
        const blob = new Blob([JSON.stringify(cleanSchemes, null, 2)], { type: 'application/json' });
        const exportName = cleanSchemes.length === 1
            ? cleanSchemes[0].name
            : `${cleanSchemes[0].name}等${cleanSchemes.length}个方案`;
        const safeExportName = String(exportName || 'link_theme_schemes')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/[\r\n]+/g, ' ')
            .trim()
            .slice(0, 120) || 'link_theme_schemes';
        const fileName = `${safeExportName}.json`;
        
        await exportSchemeBlob(blob, fileName);
        alert(`已成功导出 ${cleanSchemes.length} 个方案！`);
    } catch (error) {
        console.error('导出方案失败:', error);
        alert('导出失败，请查看控制台获取更多信息。');
    }
}
/**
 * 导入方案 (修复版：自动清洗ID，防止冲突)
 */
function handleImportSchemes(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
        try {
            const rawData = JSON.parse(event.target.result);
            // 兼容单个对象或数组
            const importedList = Array.isArray(rawData) ? rawData : [rawData];

            if (importedList.length === 0) throw new Error('文件内容为空。');

            // 【清洗数据】只保留有用信息，扔掉旧ID，防止冲突
            const cleanSchemes = importedList.map(item => {
                if (!item.name || !item.data) return null;
                return {
                    name: item.name,
                    type: item.type || 'all',
                    typeName: item.typeName || getTypeName(item.type || 'all'),
                    date: new Date().toLocaleDateString(), // 刷新日期
                    data: item.data // 核心数据
                };
            }).filter(item => item !== null);

            if (cleanSchemes.length === 0) throw new Error('无有效数据。');

            // 批量写入
            await db.themeSchemes.bulkAdd(cleanSchemes);
            
            alert(`成功导入 ${cleanSchemes.length} 个方案！`);
            await loadSavedSchemes(); // 刷新列表
            notifyThemeSchemesUpdated();

        } catch (error) {
            console.error(error);
            alert('导入失败，可能是文件格式不对。');
        } finally {
            e.target.value = ''; // 允许重复选择同一文件
        }
    };
    reader.readAsText(file);
}


    // 6. 初始化
    loadSavedSchemes();
initThemeApplication(); 
    // 【新增】保存原始图标，以便重置
    document.querySelectorAll('.icon-preview-box, .mock-icon-wrapper').forEach(box => {
        box.dataset.originalHtml = box.innerHTML;
    });

    function getTypeName(type) {
        const map = { 'all': '整套方案', 'chat': '聊天主页', 'detail': '聊天详情', 'offline': '线下模式', 'bubble': '气泡头像' };
        return map[type] || '未知类型';
    }


}

/**
 * 【完美布局版】更新图标预览
 * 创建一个看不见的“占位锚点”锁死布局，图片绝对定位在上面，
 * 这样无论图片多大，都不会推挤旁边的元素。
 */
function updateIconPreview(btn, imgSrc) {
    const row = btn.closest('.custom-icon-row');
    
    // 1. 更新行内小预览图 (保持不变)
    const smallPreviewBox = row.querySelector('.icon-preview-box');
    if (smallPreviewBox) {
        smallPreviewBox.innerHTML = `<img src="${imgSrc}" style="width:100%; height:100%; object-fit:contain; display:block;">`;
    }

    // 2. 更新顶部大预览区
    const previewId = btn.dataset.previewId;
    if (previewId) {
        const targetEl = document.getElementById(previewId);
        if (targetEl) {
            // 获取当前尺寸，没滑块则默认24
            let currentSize = '24';
            const slider = row.querySelector('.size-slider');
            if (slider) currentSize = slider.value;

            const isCoverMode = previewId.includes('avatar') || previewId.includes('send') || previewId.includes('bg');
            const fitMode = isCoverMode ? 'cover' : 'contain'; 
            
            // --- 关键结构改造 ---
            
            // 1. 强制父容器为相对定位 & Flex居中
            targetEl.style.position = 'relative'; // 为绝对定位做参考
            targetEl.style.display = 'flex';
            targetEl.style.alignItems = 'center';
            targetEl.style.justifyContent = 'center';
            targetEl.style.width = ''; // 清除硬性宽高
            targetEl.style.height = ''; 
            
            // 2. 清空内容
            targetEl.innerHTML = '';

            // 3. 创建[占位层]：不可见，大小固定为24px，用于撑住布局不塌陷、不乱跑
            const anchorDiv = document.createElement('div');
            anchorDiv.style.width = '24px';
            anchorDiv.style.height = '24px';
            anchorDiv.style.visibility = 'hidden'; // 看不见
            anchorDiv.style.flexShrink = '0';      // 不会被挤压
            targetEl.appendChild(anchorDiv);

            // 4. 创建[视觉层]：绝对定位，悬浮在中心
            const img = document.createElement('img');
            img.src = imgSrc;
            img.className = 'beautify-custom-icon'; // 加个类名方便查找
            img.style.position = 'absolute';
            img.style.top = '50%';
            img.style.left = '50%';
            img.style.transform = 'translate(-50%, -50%)'; // 完美居中
            img.style.width = `${currentSize}px`;  // 初始大小
            img.style.height = `${currentSize}px`; // 初始大小
            img.style.objectFit = fitMode;
            img.style.display = 'block';
            img.style.pointerEvents = 'none'; // 让点击穿透到底下按钮(可选)
            targetEl.appendChild(img);
        }
    }
}


/**
 * 【完美布局版】更新图标大小
 */
function updateIconSize(row, previewId, size) {
    // 1. 更新设置面板预览
    const smallPreviewBox = row.querySelector('.icon-preview-box');
    if (smallPreviewBox) {
        const smallIcon = smallPreviewBox.querySelector('img, svg');
        if (smallIcon) {
            smallIcon.style.width = '100%';
            smallIcon.style.height = '100%';
        }
    }

    // 2. 更新顶部大预览区
    if (previewId) {
        const targetEl = document.getElementById(previewId);
        if (targetEl) {
            // 尝试找到我们创建的那个绝对定位的图片
            let icon = targetEl.querySelector('img.beautify-custom-icon');
            
            // 如果没找到（可能是还没替换图，还是原始SVG），就找普通SVG/IMG
            if (!icon) {
                icon = targetEl.querySelector('svg, img');
            }

            if (icon) {
                // 直接设置像素大小
                icon.style.width = `${size}px`;
                icon.style.height = `${size}px`;
                
                // 如果是原始SVG，我们也加上绝对定位逻辑，防止调整原始图标时撑开
                // (只有当它是SVG且没有被包装过时才加，避免重复)
                if (icon.tagName === 'svg' && icon.style.position !== 'absolute') {
                     // 注意：直接改原始SVG的position可能会导致位置轻微偏离，
                     // 但为了“不挤压”，这是必须的权衡。
                     // 更好的做法是只对“替换后的图片”做绝对定位。
                     // 所以这里我们只改宽高，对于原始SVG，保持 flex 居中通常问题不大。
                }
            }
        }
    }
}


// ==========================================================
// (H) 主题应用功能 (Unified Logic)
// ==========================================================
const themeAppManagerContainer = document.getElementById('theme-application-manager');
// 新弹窗元素
const configModal = document.getElementById('theme-config-modal-overlay');
const configTitle = document.getElementById('theme-config-title');
const schemeTrigger = document.getElementById('config-scheme-trigger');
const schemeText = document.getElementById('config-scheme-text');
const charSection = document.getElementById('config-char-section');
const charList = document.getElementById('config-char-list');
const configSaveBtn = document.getElementById('config-save-btn');
const configCancelBtn = document.getElementById('config-cancel-btn');
// 全局数据
let allSchemes = [];
let allCharacters = [];
let applications = []; 
// 当前正在编辑的状态
let currentConfigState = {
    type: null,        // 当前页面类型 (chat, detail...)
    selectedSchemeId: null, 
};
// 初始化
// 初始化
async function initThemeApplication() {
    if (!themeAppManagerContainer) return;
    
    // 1. 【性能优化】只绑定事件，不立即加载数据
    themeAppManagerContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-clean-apply');
        if (!btn) return;
        
        const row = btn.closest('.theme-application-row');
        const type = row.dataset.type;
        const typeName = row.querySelector('.row-label').textContent;
        
        // 在点击“配置”按钮时才去加载数据并打开弹窗
        openConfigModal(type, typeName);
    });

    // 2. 绑定弹窗内部事件
    bindModalEvents();

    // 3. 【性能优化】将 schemes 和 characters 的加载也推迟
    // 在页面切换动画完成后再悄悄加载，用户无感知
    setTimeout(async () => {
        try {
            allSchemes = await themeState.getAllSchemeSummaries();
            allCharacters = await getAllCharacters();
            console.log("美化页所需数据已在后台预加载。");
        } catch (error) {
            console.error("预加载美化页数据失败:", error);
        }
    }, 350); // 延迟300ms，等待页面过渡动画结束
}

async function openConfigModal(type, typeName) {
    // 1. 【UI先行】立即渲染弹窗的“空壳”，确保用户点击后瞬间看到响应。
    // 这是提升用户感知性能的关键一步，尤其在低性能设备上。
    currentConfigState.type = type;
    currentConfigState.selectedSchemeId = null;
    configTitle.textContent = `配置 ${typeName}`;
    configModal.classList.add('visible');
    
    // 显示加载中的占位符，提供即时反馈。
    schemeText.textContent = "加载中...";
    schemeText.style.color = "#999";
    if (type !== 'chat') {
        charSection.style.display = 'block';
        charList.innerHTML = '<li>正在加载角色列表...</li>';
    } else {
        charSection.style.display = 'none';
    }

    // 2. 【异步加载】使用 requestAnimationFrame 将耗时的数据加载和DOM渲染任务
    // 推迟到浏览器的下一次绘制前执行。这可以确保UI的弹出动画流畅无阻。
    requestAnimationFrame(async () => {
        try {
            // 在后台静默加载数据
            applications = await themeState.getAllApplications();
            allSchemes = await themeState.getAllSchemeSummaries(); 
            
            // 数据加载完毕后，再更新UI的实际内容
            schemeText.textContent = "请选择方案";
            if (type !== 'chat') {
                await renderCharListWithType(type);
            }
        } catch (error) {
            console.error("加载配置数据失败:", error);
            schemeText.textContent = "加载失败";
            if (type !== 'chat') charList.innerHTML = '<li>加载失败</li>';
        }
    });
}

/**
 * 【V2版】渲染带有“已应用标签”的角色列表
 * 这个函数现在会检查所有类型的主题，并显示多个标签
 */

async function renderCharListWithType(type) {
    charList.innerHTML = '';
    console.log("--- 【探针2/3】开始渲染角色列表和标签 ---"); // 第二个探针
    console.log("当前所有的应用规则(applications):", applications);
    console.log("当前所有的主题方案(allSchemes):", allSchemes);
    
    allCharacters.forEach(char => {
        const appliedTags = [];
        const detailRule = getEffectiveThemeRuleForTarget(applications, allSchemes, 'detail', char.id)?.rule;
        if (detailRule) {
            const scheme = allSchemes.find(s => String(s.id) === String(detailRule.schemeId));
            if (scheme) {
                console.log(`为角色 [${char.name}] 找到 '详情页' 标签: ${scheme.name}`);
                appliedTags.push({ type: 'detail', name: scheme.name });
            }
        }
        const bubbleRule = getEffectiveThemeRuleForTarget(applications, allSchemes, 'bubble', char.id)?.rule;
        if (bubbleRule) {
            const scheme = allSchemes.find(s => String(s.id) === String(bubbleRule.schemeId));
            if (scheme) {
                console.log(`为角色 [${char.name}] 找到 '气泡' 标签: ${scheme.name}`);
                appliedTags.push({ type: 'bubble', name: scheme.name });
            }
        }
        const offlineRule = getEffectiveThemeRuleForTarget(applications, allSchemes, 'offline', char.id)?.rule;
        if (offlineRule) {
            const scheme = allSchemes.find(s => String(s.id) === String(offlineRule.schemeId));
            if (scheme) {
                console.log(`为角色 [${char.name}] 找到 '线下' 标签: ${scheme.name}`);
                appliedTags.push({ type: 'offline', name: scheme.name });
            }
        }

        const tagsHtml = appliedTags.map(tag => `<span class="applied-tag tag-${tag.type}" title="${tag.name}">${tag.name}</span>`).join('');
        const div = document.createElement('div');
        div.className = 'char-select-item';
        div.innerHTML = `
            <input type="checkbox" value="${char.id}">
            <span class="char-name">${char.name}</span>
            <div class="applied-tags-container">${tagsHtml}</div>
        `;
        div.addEventListener('click', (e) => {
            if (e.target.tagName !== 'INPUT' && !e.target.closest('.applied-tags-container')) {
                div.querySelector('input').checked = !div.querySelector('input').checked;
            }
        });
        charList.appendChild(div);
    });
    console.log("角色列表和标签渲染完毕。");
}


/**
 * 绑定弹窗内部的交互
 */
function bindModalEvents() {
    // 1. 点击“选择方案” -> 弹出简单列表
    schemeTrigger.addEventListener('click', () => {
        const items = allSchemes.map(s => ({ id: s.id, name: s.name }));
        showSimpleSelectModal('选择主题方案', items, (id) => {
            currentConfigState.selectedSchemeId = Number(id);
            const scheme = allSchemes.find(s => s.id == id);
            if (scheme) {
                schemeText.textContent = scheme.name;
                schemeText.style.color = "#000";
            }
        });
    });

    // 2. 取消按钮
    configCancelBtn.addEventListener('click', () => {
        configModal.classList.remove('visible');
    });
    // 3. 确定/应用按钮
// 在 chatBeautify.js 文件中，替换 bindModalEvents 函数里的 configSaveBtn 监听器

configSaveBtn.addEventListener('click', async () => {
    const type = currentConfigState.type;
    const schemeId = currentConfigState.selectedSchemeId;
    if (!schemeId) {
        alert("请先选择一个方案！");
        return;
    }

    if (type === 'chat') {
        // 'chat' 类型比较特殊，它没有 characterIds，确实是唯一的
        // 所以这里的逻辑可以保持不变：先删后加
        await db.themeApplications.where({ type: 'chat' }).delete();
        await db.themeApplications.add({
            type: 'chat',
            schemeId: schemeId,
            characterIds: [] 
        });
        alert("聊天主页样式已应用！");
    } else {
        // ▼▼▼ 【这是本次修复的核心逻辑】 ▼▼▼
        const checkedBoxes = charList.querySelectorAll('input[type="checkbox"]:checked');
        const selectedCharacterIds = Array.from(checkedBoxes).map(box => box.value);

        if (selectedCharacterIds.length === 0) {
            alert("请至少选择一个要应用的角色！");
            return;
        }

        await cleanupInvalidCharacterScopedThemeApplications([type]);
        // 无论是否找到现有规则，都先把选中角色从该类型的其它方案中移除。
        const otherRulesOfSameType = await db.themeApplications.where({ type: type }).toArray();
        for (const rule of otherRulesOfSameType) {
            // 过滤掉当前选中的角色 ID (强制转为 String 比较最稳妥)
            const ruleCharacterIds = Array.isArray(rule.characterIds) ? rule.characterIds : [];
            const remainingIds = ruleCharacterIds.filter(id => !selectedCharacterIds.includes(String(id)));
            if (remainingIds.length < ruleCharacterIds.length) {
                if (remainingIds.length === 0) {
                    await db.themeApplications.delete(rule.id);
                } else {
                    await db.themeApplications.update(rule.id, { characterIds: remainingIds });
                }
            }
        }
        const sameTypeRules = await db.themeApplications.where('type').equals(type).toArray();
        // 兼容旧数据中数字/字符串两种 schemeId，只复用合法的角色/群聊规则。
        let existingRule = sameTypeRules
            .filter(rule => String(rule.schemeId) === String(schemeId))
            .filter(isCharacterScopedThemeRule)
            .sort((left, right) => (Number(right.id) || 0) - (Number(left.id) || 0))[0];
        if (existingRule) {
            // 方案已存在，更新 ID 列表
            const existingCharacterIds = Array.isArray(existingRule.characterIds) ? existingRule.characterIds : [];
            const updatedIds = mergeThemeCharacterIds(existingCharacterIds, selectedCharacterIds);
            await db.themeApplications.update(existingRule.id, { characterIds: updatedIds });
        } else {
            // 新方案应用，直接添加
            await db.themeApplications.add({ type, schemeId, characterIds: selectedCharacterIds });
        }
        alert(`成功！方案已应用到 ${selectedCharacterIds.length} 位角色。`);
    }
    
    configModal.classList.remove('visible');
    // 立即应用最新的样式
    applyCurrentThemeConfig(); 
});

}
let themeApplyFrame = 0;
let themeApplyRunning = false;
let themeApplyQueued = false;
let preparedThemePageKey = '';
let queuedThemeOptions = null;
let lastRuntimeThemeCss = null;
const runtimeThemeCssCache = new Map();
const RUNTIME_THEME_CSS_CACHE_LIMIT = 8;

function cacheRuntimeThemeCss(cssSource, compiledCss) {
    if (runtimeThemeCssCache.has(cssSource)) runtimeThemeCssCache.delete(cssSource);
    runtimeThemeCssCache.set(cssSource, compiledCss);
    if (runtimeThemeCssCache.size > RUNTIME_THEME_CSS_CACHE_LIMIT) {
        runtimeThemeCssCache.delete(runtimeThemeCssCache.keys().next().value);
    }
}

export function applyCurrentThemeConfig(options = {}) {
    themeApplyQueued = true;
    const preparedPage = ['page-chat-detail', 'page-offline-mode'].includes(options.targetPageId)
        ? document.getElementById(options.targetPageId)
        : null;
    if (preparedPage) preparedThemePageKey = '';
    const visiblePage = document.querySelector('.app-page[style*="flex"], .app-page[style*="block"], .app-page.active');
    if (!preparedPage && visiblePage?.id === 'page-chat-settings' && visiblePage.style.display !== 'none') {
        // 设置页只保存方案，不在这里重建整套 CSS，返回聊天页时统一应用一次。
        return;
    }
    const themePage = preparedPage || visiblePage;
    const themePageKey = themePage ? `${themePage.id}:${String(tempState.currentChatId ?? '')}` : '';
    if (!preparedPage && themePageKey && preparedThemePageKey === themePageKey) {
        preparedThemePageKey = '';
        themeApplyQueued = false;
        return;
    }
    if (themeApplyFrame || themeApplyRunning) {
        queuedThemeOptions = options;
        return;
    }
    // 同一帧内的多次调用只保留一次，避免进入/退出设置页时重复重建整套主题样式。
    themeApplyFrame = requestAnimationFrame(async () => {
        themeApplyFrame = 0;
        if (themeApplyRunning) return;
        themeApplyQueued = false;
        themeApplyRunning = true;
        let applied = false;
        const settingsPage = document.getElementById('page-chat-settings');
        const executionPreparedPage = preparedPage && settingsPage?.style.display !== 'none'
            ? preparedPage
            : null;
        try {
            await _executeApplyThemeConfig(executionPreparedPage);
            applied = true;
        } finally {
            const executionPage = executionPreparedPage || document.querySelector('.app-page[style*="flex"], .app-page[style*="block"], .app-page.active');
            const executionPageKey = executionPage
                ? `${executionPage.id}:${String(tempState.currentChatId ?? '')}`
                : '';
            if (applied && preparedPage && executionPageKey) preparedThemePageKey = executionPageKey;
            themeApplyRunning = false;
            const nextOptions = queuedThemeOptions;
            queuedThemeOptions = null;
            if (nextOptions) applyCurrentThemeConfig(nextOptions);
            else if (themeApplyQueued) applyCurrentThemeConfig();
        }
    });
}

// 将原本的逻辑改名为内部执行函数
async function _executeApplyThemeConfig(preparedPage = null) {
    console.log("--- 【V8 性能优化版】开始应用主题样式 ---");

    const iconRealTargetMap = {
        'chat-add': '#add-friend-btn',
        'chat-more': '#contacts-more-btn',
        'target-nav-chat': '.theme-target-chat-main-footer .nav-item[data-page="page-chat"][data-chat-section="friends-content"]',
        'target-nav-contacts': '.theme-target-chat-main-footer .nav-item[data-chat-section="contacts-content"]',
        'target-nav-dynamics': '.theme-target-chat-main-footer .nav-item[data-page="page-dynamics"]',
        'target-nav-profile': '.theme-target-chat-main-footer .nav-item[data-page="page-profile"]',
        'detail-back': '.chat-detail-header .back-button .back-button-icon-wrapper', 
        'target-online-back': '.chat-detail-header .back-button .back-button-icon-wrapper',
        'detail-call': '#call-btn', 'target-online-call': '#call-btn',
        'detail-more': '#chat-detail-more-btn', 'target-online-more': '#chat-detail-more-btn',
        'detail-grid': '.chat-grid-btn', 'target-online-grid': '.chat-grid-btn',
        'detail-emoji': '#emoji-btn', 'target-online-emoji': '#emoji-btn',
        'target-online-send': '#send-message-btn',
        'offline-back': '.theme-target-offline-header .back-button .back-button-icon-wrapper',
        'target-offline-back': '.theme-target-offline-header .back-button .back-button-icon-wrapper',
        'offline-more': '#offline-more-btn', 'target-offline-more': '#offline-more-btn',
        'offline-stop': '#offline-stop-btn', 'target-offline-stop': '#offline-stop-btn',
        'offline-send': '#offline-send-btn', 'target-offline-send': '#offline-send-btn',
    };

    const resetAndClearTheme = () => {
        // 【修改点】同时删除预览产生和正式应用的样式标签，防止多主题融合
        document.querySelectorAll('style[id^="runtime-theme-"], style[id^="runtime-bg-preview-"]').forEach(el => el.remove());
        lastRuntimeThemeCss = null;
        document.body.classList.remove('theme-applied');
        const selectorsToReset = new Set(Object.values(iconRealTargetMap));
        selectorsToReset.forEach(selector => {
            if (!selector) return;
            document.querySelectorAll(selector).forEach(element => {
                if (element && element.dataset.originalHtml) {
                    element.innerHTML = element.dataset.originalHtml;
                }
            });
        });
    };
        /**
     * [修正位置+优化] 辅助函数：根据类型从完整主题数据中提取相关设置
     */
    const extractDataForType = (themeData, type) => {
        if (!themeData) return {};
        const extracted = { cssOverrides: {}, sliders: {}, icons: {} };

        // 使用更宽松的 .includes() 来匹配，简化 filters
      const filters = {
            'chat': ['global-css', 'chat-main', 'target-nav', 'chat-add', 'chat-more'],
            'detail': ['global-css', 'preview-online-header', 'preview-online-footer', 'online-header-footer-unified', 'detail-', 'target-online-'], 
            'offline': ['global-css', 'preview-offline-header', 'preview-offline-footer', 'offline-', 'target-offline-'],
            'bubble': ['online-bubble-received', 'online-bubble-sent', 'offline-card-received', 'offline-card-sent', 'bubble', 'card-']
        };

        const targetPrefixes = filters[type] || [];
        // 如果类型不是这四种之一（例如，'all'），则不过滤，返回所有数据
        if (targetPrefixes.length === 0) return themeData;

        // 定义一个通用的匹配函数
        const isMatch = (key) => targetPrefixes.some(prefix => key.includes(prefix));

        // 遍历并筛选数据
        if (themeData.cssOverrides) {
            for (const key in themeData.cssOverrides) {
                if (isMatch(key)) {
                    extracted.cssOverrides[key] = themeData.cssOverrides[key];
                }
            }
        }
        if (themeData.sliders) {
            for (const key in themeData.sliders) {
                if (isMatch(key)) {
                    extracted.sliders[key] = themeData.sliders[key];
                }
            }
        }
        if (themeData.icons) {
            for (const key in themeData.icons) {
                if (isMatch(key)) {
                    extracted.icons[key] = themeData.icons[key];
                }
            }
        }
        
        return extracted;
    };
    const currentChatId = tempState.currentChatId;
    const activePage = preparedPage || document.querySelector('.app-page[style*="flex"]') || 
                       document.querySelector('.app-page[style*="block"]') || 
                       document.querySelector('.app-page.active');
     document.getElementById('home-screen-wrapper');
    // 【关键防御】如果找不到活动页面，就直接中止执行，避免无关的数据库读取
    if (!activePage) {
        console.warn("applyCurrentThemeConfig: No active page found. Aborting.");
        return;
    }

    const activePageId = activePage.id;
    const applicableTypes = activePageId === 'page-chat-detail'
        ? ['detail', 'bubble']
        : activePageId === 'page-offline-mode'
            ? ['offline', 'bubble']
            : ['chat'];
    const loadedApps = await db.themeApplications.where('type').anyOf(applicableTypes).toArray();
    const invalidRuleIds = loadedApps
        .filter(isInvalidCharacterScopedThemeRule)
        .map(rule => rule.id)
        .filter(id => id !== null && id !== undefined);
    if (invalidRuleIds.length > 0) {
        await db.themeApplications.bulkDelete(invalidRuleIds);
    }
    const apps = loadedApps
        .filter(rule => !isInvalidCharacterScopedThemeRule(rule))
        .filter(rule => themeRuleTargetsCharacter(rule, currentChatId));
    const neededSchemeIds = [...new Set(
        apps.map(a => a.schemeId)
            .filter(id => id != null)
            .map(Number)
            .filter(id => !Number.isNaN(id))
    )];
    const schemes = neededSchemeIds.length > 0
        ? (await db.themeSchemes.bulkGet(neededSchemeIds)).filter(Boolean)
        : [];
    // 兼容旧版本遗留数据：删除方案后可能还残留应用规则，进入页面时自动清理。
    const existingSchemeIds = new Set(schemes.map(scheme => String(scheme.id)));
    const orphanRuleIds = apps
        .filter(rule => rule.schemeId != null && !existingSchemeIds.has(String(rule.schemeId)))
        .map(rule => rule.id);
    if (orphanRuleIds.length > 0) {
        await db.themeApplications.bulkDelete(orphanRuleIds);
    }
    const updateWechatSchemeIfNeeded = window.__lookyUpdateBuiltInWechatSchemeIfNeeded;
    const updateKktSchemeIfNeeded = window.__lookyUpdateBuiltInKktSchemeIfNeeded;
    await Promise.all(schemes.map(async (scheme) => {
        if (scheme?.name === '微信主题' && typeof updateWechatSchemeIfNeeded === 'function' && updateWechatSchemeIfNeeded(scheme)) {
            await db.themeSchemes.update(scheme.id, { data: scheme.data });
        }
        if ((scheme?.name === 'Kkt主题' || scheme?.name === 'Kkt涓婚') && typeof updateKktSchemeIfNeeded === 'function' && updateKktSchemeIfNeeded(scheme)) {
            await db.themeSchemes.update(scheme.id, { data: scheme.data });
        }
    }));
    let finalSchemeData = {};
    const cssOverrideParts = new Map();
    const selectedSchemeByType = {};
    const processRule = (type) => {
        const selected = getEffectiveThemeRuleForTarget(apps, schemes, type, currentChatId);
        if (selected) {
            selectedSchemeByType[type] = selected;
            const { scheme } = selected;
            const filteredData = extractDataForType(scheme.data, type);
            finalSchemeData.cssOverrides = { ...finalSchemeData.cssOverrides };
            if (filteredData.cssOverrides) {
                Object.entries(filteredData.cssOverrides).forEach(([key, value]) => {
                    if (!value) return;
                    let parts = cssOverrideParts.get(key);
                    if (!parts) {
                        parts = new Set();
                        cssOverrideParts.set(key, parts);
                    }
                    parts.add(value);
                    finalSchemeData.cssOverrides[key] = [...parts].join('\n');
                });
            }
            finalSchemeData.icons = { ...finalSchemeData.icons, ...filteredData.icons };
            finalSchemeData.sliders = { ...finalSchemeData.sliders, ...filteredData.sliders };
        }
    };

    if (activePageId === 'page-chat' || activePageId === 'home-screen-wrapper' || activePageId === 'page-profile' || activePageId === 'page-dynamics') {
        processRule('chat');
    }
    if (activePageId === 'page-chat-detail' && currentChatId) {
        processRule('detail');
        processRule('bubble');
    } 
    if (activePageId === 'page-offline-mode' && currentChatId) {
        processRule('offline');
        processRule('bubble');
    }
    const isLineTheme = (themeData) => typeof window.__lookyIsLineThemeData === 'function'
        ? window.__lookyIsLineThemeData(themeData)
        : Boolean(
            themeData?.builtInThemeId === 'line' ||
            Object.values(themeData?.cssOverrides || {}).some(value =>
                typeof value === 'string' && value.includes('LINE theme')
            )
        );
    const shouldUseLineStyle = Object.values(selectedSchemeByType)
        .some(selected => isLineTheme(selected?.scheme?.data));
    const shouldUseLineRuntime = activePageId === 'page-chat-detail' &&
        isLineTheme(selectedSchemeByType.detail?.scheme?.data);

    // ▼▼▼ 【新增】专门处理常规聊天背景的内部函数，保证随时可调用 ▼▼▼
    const applyNormalChatBackground = (chatId) => {
        const char = AppState.characterProfiles.find(c => c.id === chatId);
        let bgStyleTag = document.getElementById('dynamic-chat-bg-style');
        if (!bgStyleTag) {
            bgStyleTag = document.createElement('style');
            bgStyleTag.id = 'dynamic-chat-bg-style';
            document.head.appendChild(bgStyleTag);
        }
        const chatContentArea = document.querySelector('#page-chat-detail .chat-detail-content');

        if (char && char.chatBackground) {
            const bgMode = char.chatBgMode || 'content';
            if (bgMode === 'content') {
                if (chatContentArea) {
                    const newBg = `url("${char.chatBackground}")`;
                    if (chatContentArea.style.backgroundImage !== newBg) {
                        chatContentArea.style.backgroundImage = newBg;
                        chatContentArea.style.backgroundSize = 'cover';
                        chatContentArea.style.backgroundPosition = 'center';
                    }
                    document.getElementById('page-chat-detail').style.background = ''; 
                }
                if (bgStyleTag.innerHTML !== '') bgStyleTag.innerHTML = '';
            } else {
                if (chatContentArea) {
                    if (shouldUseLineRuntime) {
                        const newBg = `url("${char.chatBackground}")`;
                        chatContentArea.style.setProperty('background-image', newBg, 'important');
                        chatContentArea.style.setProperty('background-size', 'cover', 'important');
                        chatContentArea.style.setProperty('background-position', 'center', 'important');
                        chatContentArea.style.setProperty('background-repeat', 'no-repeat', 'important');
                        chatContentArea.style.setProperty('background-color', 'transparent', 'important');
                    } else if (chatContentArea.style.backgroundImage !== 'none') {
                        chatContentArea.style.backgroundImage = 'none';
                    }
                }
                let css = `
                    #page-chat-detail { background: url('${char.chatBackground}') center / cover no-repeat !important; }
                    body.line-theme-active.theme-applied #page-chat-detail { background: url('${char.chatBackground}') center / cover no-repeat !important; }
                    #page-chat-detail .chat-detail-content { background: transparent !important; }
                    body.line-theme-active.theme-applied #page-chat-detail .chat-detail-content { background-color: transparent !important; background-image: url('${char.chatBackground}') !important; background-size: cover !important; background-position: center !important; background-repeat: no-repeat !important; }
                    #page-chat-detail .theme-target-detail-header, #page-chat-detail .app-header { background: transparent !important; border-bottom: none !important; box-shadow: none !important; }
                    body.line-theme-active.theme-applied #page-chat-detail .chat-detail-header,
                    body.line-theme-active.theme-applied #page-chat-detail .theme-target-detail-header,
                    body.line-theme-active.theme-applied #page-chat-detail .app-header { background: transparent !important; border-bottom: none !important; box-shadow: none !important; }
                    #page-chat-detail .theme-target-detail-header::after, #page-chat-detail .theme-target-detail-header::before, #page-chat-detail .app-header::after, #page-chat-detail .app-header::before { display: none !important; }
                    body.line-theme-active.theme-applied #page-chat-detail .chat-detail-header::after,
                    body.line-theme-active.theme-applied #page-chat-detail .chat-detail-header::before,
                    body.line-theme-active.theme-applied #page-chat-detail .theme-target-detail-header::after,
                    body.line-theme-active.theme-applied #page-chat-detail .theme-target-detail-header::before,
                    body.line-theme-active.theme-applied #page-chat-detail .app-header::after,
                    body.line-theme-active.theme-applied #page-chat-detail .app-header::before { display: none !important; }
                `;
                if (bgMode === 'top_bottom') {
                    css += `
                        #page-chat-detail .theme-target-detail-footer, #page-chat-detail .chat-input-container { background: transparent !important; border-top: none !important; box-shadow: none !important; }
                        body.line-theme-active.theme-applied #page-chat-detail .theme-target-detail-footer,
                        body.line-theme-active.theme-applied #page-chat-detail .chat-input-container { background: transparent !important; border-top: none !important; box-shadow: none !important; }
                    `;
                } else {
                    css += `#page-chat-detail .theme-target-detail-footer, #page-chat-detail .chat-input-container { background: var(--c-bg-primary, #ffffff) !important; }`;
                }
                if (bgStyleTag.innerHTML !== css) bgStyleTag.innerHTML = css;
            }
        } else {
            if (chatContentArea && chatContentArea.style.backgroundImage !== 'none') chatContentArea.style.backgroundImage = 'none';
            if (bgStyleTag.innerHTML !== '') bgStyleTag.innerHTML = '';
            document.getElementById('page-chat-detail').style.background = ''; 
        }
    };
    // ▲▲▲ 新增结束 ▲▲▲

    if (Object.keys(finalSchemeData).length === 0) {
        // 【修改二：补丁1】如果完全取消了主题，再去执行扒光恢复原状
        resetAndClearTheme();
        if (typeof window.__lookySyncLineThemeRuntime === 'function') {
            window.__lookySyncLineThemeRuntime(false, false);
        }
        // ▼▼▼ 【核心修正】即使没有应用任何美化主题，也要保证常规聊天壁纸正常渲染 ▼▼▼
        applyNormalChatBackground(currentChatId);
        return;
    }
     // 【修改二：补丁2】智能恢复在这个新主题里没被用到的旧图标，避免污染

    const selectorsToReset = new Set(Object.values(iconRealTargetMap));
    selectorsToReset.forEach(selector => {
        if (!selector) return;
        const targetId = Object.keys(iconRealTargetMap).find(key => iconRealTargetMap[key] === selector);
        if (!finalSchemeData.icons || !finalSchemeData.icons[targetId]) {
            // 【终极防闪烁】限制作用域：只在当前活跃的页面(activePage)里寻找和还原图标。
            // 绝不去碰那些隐藏在后台的页面（比如退出聊天页时，聊天页的图标绝不该被强行扒光），这是退出时闪烁的真凶！
            if (activePage) {
                activePage.querySelectorAll(selector).forEach(element => {
                    if (element && element.dataset.originalHtml && element.querySelector('.beautify-custom-icon')) {
                        element.innerHTML = element.dataset.originalHtml;
                    }
                });
            }
        }
    });
    document.body.classList.add('theme-applied');
    if (typeof window.__lookySyncLineThemeRuntime === 'function') {
        window.__lookySyncLineThemeRuntime(shouldUseLineStyle, shouldUseLineRuntime);
    }

    // 【核心修正】应用图标和尺寸的正确逻辑
    // 1. 先用滑块值调整所有默认SVG的大小
    if (finalSchemeData.sliders) {
        for (const [targetId, size] of Object.entries(finalSchemeData.sliders)) {
            const realSelector = iconRealTargetMap[targetId];
            // 【防御性修改】确保 activePage 存在
            if (activePage && realSelector) {
                activePage.querySelectorAll(realSelector).forEach(element => {
                    const icon = element.querySelector('svg');
                    if (icon) {
                        icon.style.width = `${size}px`;
                        icon.style.height = `${size}px`;
                    }
                });
            }
        }
    }

    // 2. 再用图片覆盖需要替换的图标
    if (finalSchemeData.icons) {
        for (const [targetId, src] of Object.entries(finalSchemeData.icons)) {
            const realSelector = iconRealTargetMap[targetId];
            // 【防御性修改】确保 activePage 存在
            if (activePage && realSelector && src) {
                activePage.querySelectorAll(realSelector).forEach(element => {
                    const size = finalSchemeData.sliders?.[targetId] || '24';
                    const isSendButton = (targetId === 'target-online-send' || targetId === 'target-offline-send');
                    const fitMode = isSendButton ? 'cover' : 'contain';
                    
                    if (window.getComputedStyle(element).position === 'static') {
    element.style.position = 'relative';
}
                    element.style.display = 'flex';
                    element.style.alignItems = 'center';
                    element.style.justifyContent = 'center';
                    element.style.width = '';
                    element.style.height = '';
                     // 【性能优化2】彻底杜绝 innerHTML 字符串对比带来的“误杀闪烁”！
                    // 直接获取现存的图片，比对它身上最核心的 图片地址 和 尺寸。
                    const existingImg = element.querySelector('.beautify-custom-icon');
                    
                    // 只有当“没有图片”、“图片变了”或者“尺寸变了”时，才去重新生成 HTML。否则绝对不碰页面！
                    if (!existingImg || existingImg.getAttribute('src') !== src || existingImg.style.width !== `${size}px`) {
                        element.innerHTML = `
                            <div style="width:24px; height:24px; visibility:hidden; flex-shrink:0;"></div>
                            <img class="beautify-custom-icon" src="${src}" style="
                                position: absolute;
                                top: 50%; left: 50%;
                                transform: translate(-50%, -50%);
                                width: ${size}px;
                                height: ${size}px;
                                object-fit: ${fitMode};
                                display: block;
                            ">
                        `;
                    }
                });
            }

        }
    }

    // 3. 处理仅调整大小但未换图的情况 (针对 SVG)
    if (finalSchemeData.sliders) {
        for (const [targetId, size] of Object.entries(finalSchemeData.sliders)) {
            const realSelector = iconRealTargetMap[targetId];
            // 【防御性修改】确保 activePage 存在
            if (activePage && realSelector) {
                activePage.querySelectorAll(realSelector).forEach(element => {
                   if (!element.querySelector('img.beautify-custom-icon')) {
                         const icon = element.querySelector('svg, img');
                         if (icon) {
                             icon.style.width = `${size}px`;
                             icon.style.height = `${size}px`;
                         }
                     }
                 });
             }
        }
    }


   // ... 在 applyCurrentThemeConfig 函数内部 ...

    // 4. 注入CSS (使用更安全、更严谨的重写逻辑)
    if (finalSchemeData.cssOverrides && Object.keys(finalSchemeData.cssOverrides).length > 0) {
        let rawCss = [...new Set(Object.values(finalSchemeData.cssOverrides).filter(Boolean))].join('\n');
        let scaledCssToInject = runtimeThemeCssCache.get(rawCss);
        if (scaledCssToInject === undefined) {
            // ▼▼▼ 【V2 - 安全修复版】逐行处理，避免破坏子选择器 ▼▼▼
            const lines = rawCss.split('\n');
            const newLines = [];

            for (const line of lines) {
                // 检查这是否是一条需要修复的气泡样式选择器行
                const isBubbleSelectorLine = (line.includes('.message-wrapper.received') || line.includes('.message-wrapper.sent')) && line.includes('{');
                const isAlreadyFixed = line.includes('#page-chat-detail') || line.includes('#preview-online-scene');

                if (isBubbleSelectorLine && !isAlreadyFixed) {
                    // 1. 分离出选择器部分和样式部分
                    const selectorPart = line.substring(0, line.indexOf('{')).trim();
                    const stylePart = line.substring(line.indexOf('{'));

                    // 2. 基于原始选择器，生成两个新的、精确作用域的选择器
                    const newSelector1 = selectorPart.replace('.theme-applied', '.theme-applied #page-chat-detail');
                    const newSelector2 = selectorPart.replace('.theme-applied', '.theme-applied #preview-online-scene');

                    // 3. 重新组合成一条新的、带有两个正确选择器的CSS规则
                    const fixedLine = `${newSelector1}, \n${newSelector2} ${stylePart}`;
                    newLines.push(fixedLine);
                } else {
                    // 如果不需要修复，则原样保留
                    newLines.push(line);
                }
            }

            let cssToInject = newLines.join('\n');
            // ▲▲▲ 【V2 - 安全修复版结束】 ▲▲▲

            // 最后再执行通用的界面栏ID替换
            cssToInject = cssToInject
                .replace(/#preview-chat-main-header/g, '#page-chat .theme-target-chat-main-header')
                .replace(/#preview-chat-main-footer/g, '#page-chat .theme-target-chat-main-footer')
                .replace(/#preview-online-header/g, '#page-chat-detail .theme-target-detail-header')
                .replace(/#preview-online-footer/g, '#page-chat-detail .theme-target-detail-footer')
                .replace(/#preview-offline-header/g, '#page-offline-mode .theme-target-offline-header')
                .replace(/#preview-offline-footer/g, '#page-offline-mode .theme-target-offline-footer');
            scaledCssToInject = window.__lookyScaleFontSizeCssText ? window.__lookyScaleFontSizeCssText(cssToInject) : cssToInject;
            cacheRuntimeThemeCss(rawCss, scaledCssToInject);
        }
        let styleTag = document.getElementById('runtime-theme-style');
        if (!styleTag) {
            styleTag = document.createElement('style');
            styleTag.id = 'runtime-theme-style';
            document.head.appendChild(styleTag);
            lastRuntimeThemeCss = null;
        }
        // 【性能优化3】这是解决低运行内存手机“退回主页屏幕闪白光”的核武器！
        // 如果引擎算出来的 CSS 没变（比如从聊天页退出来，依然是同一套主题），
        // 就拦截赋值动作，阻止浏览器进行极度耗时的全局样式重算 (Style Recalculation)。
         if (lastRuntimeThemeCss !== scaledCssToInject) {
            styleTag.textContent = scaledCssToInject;
            lastRuntimeThemeCss = scaledCssToInject;
        }
    } else {
        // 如果取消了主题，也需要清空主题 CSS，防止残留
        let styleTag = document.getElementById('runtime-theme-style');
        if (styleTag && lastRuntimeThemeCss !== '') styleTag.textContent = '';
        lastRuntimeThemeCss = '';
    }
    
    // ▼▼▼ 【核心修正】统一调用刚才定义的背景处理函数 ▼▼▼
    applyNormalChatBackground(currentChatId);

    console.log("主题应用完成！");
}

/**
 * 辅助函数：从完整方案数据中，只提取特定类型的 CSS
 * @param {object} themeData - 完整的方案数据
 * @param {string} type - 'chat', 'detail', 'offline', 'bubble'
 * @param {boolean} isForPreview - 【新增】是否为预览区提取CSS
 * @returns {string}
 */
function extractCssForType(themeData, type, isForPreview = true) {
    if (!themeData || !themeData.cssOverrides) return "";
    
    let css = "";
    const keys = Object.keys(themeData.cssOverrides);
    
    // 【关键修正】这里的键名必须与你保存数据时的 data-target 完全一致！
    const filters = {
        'chat': ['global-css', 'chat-main-header', 'chat-main-footer'],
        'detail': ['global-css', 'preview-online-header', 'preview-online-footer', 'online-header-footer-unified'], // 预览时用这个
        'offline': ['global-css', 'preview-offline-header', 'preview-offline-footer'], // 预览时用这个
        'bubble': ['online-bubble-received', 'online-bubble-sent', 'offline-card-received', 'offline-card-sent']
    };
    
    // 【新增逻辑】当不是为预览提取时，我们要用另一套键名
    if (!isForPreview) {
       filters.detail = ['global-css', 'online-header', 'online-footer', 'online-header-footer-unified'];
        filters.offline = ['global-css', 'offline-header', 'offline-footer'];
    }

    const targetKeys = filters[type] || [];

    keys.forEach(key => {
        // 你的textarea的data-target是 'preview-online-header'
        // 而真实页面的class是 '.theme-target-detail-header'
        // 我们需要找到 textarea 的原始 key
        const previewKey = key.replace('preview-', ''); // 例如 'online-header' -> 'online-header'
        
        let targetKeyForFilter = key;
        // 如果不是预览，我们需要匹配非preview的key
        if(!isForPreview){
             if(key.startsWith('preview-')){
                 targetKeyForFilter = key.replace('preview-','');
             }
        }

        if (targetKeys.includes(targetKeyForFilter)) {
            let finalCss = themeData.cssOverrides[key];
            
            // 【核心修正】如果不是给预览用的，就进行“钥匙替换”
            if (!isForPreview) {
                finalCss = finalCss
                    .replace(/#preview-chat-main-header/g, '.theme-target-chat-main-header')
                    .replace(/#preview-chat-main-footer/g, '.theme-target-chat-main-footer')
                    .replace(/#preview-online-header/g, '.theme-target-detail-header')
                    .replace(/#preview-online-footer/g, '.theme-target-detail-footer')
                    .replace(/#preview-offline-header/g, '.theme-target-offline-header')
                    .replace(/#preview-offline-footer/g, '.theme-target-offline-footer');
            }
            css += finalCss + "\n";
        }
    });
    
    return css;
}

// 导出给 ui.js 调用
window.applyCurrentThemeConfig = applyCurrentThemeConfig;
