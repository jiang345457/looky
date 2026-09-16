
import { AppState, tempState } from './state.js'
import {addTapListener, escapeHTML } from './utils.js';


/* --- 1.4 UI元素缓存 --- */
  // 将所有需要频繁操作的DOM元素缓存在一个对象中，提高性能，方便管理
export  const UI = {
    phoneScreen: document.querySelector('.phone-screen'),
    homeScreenWrapper: document.getElementById('home-screen-wrapper'),
    homePagerContainer: document.querySelector('.home-pager-container'),
    homeDots: document.querySelectorAll('.home-page-indicator .dot'),
    appDock: document.querySelector('.app-dock'),
    islandContainer: document.getElementById('dynamic-island-container'),
    islandIcon: document.getElementById('dynamic-island-icon'),
    islandText: document.getElementById('dynamic-island-text'),
    islandHint: document.getElementById('dynamic-island-hint'),
    islandCopyBtn: document.getElementById('dynamic-island-copy-btn'),
    timeDisplay: document.getElementById('time-display'),
    statusBarTime: document.querySelector('.status-bar .status-time'),
    dayPeriodDisplay: document.getElementById('day-period-display'),
    dateDisplay: document.getElementById('date-display'),
    batteryLevelIndicator: document.getElementById('battery-level-indicator'),
    batteryPercentageText: document.getElementById('battery-percentage-text'),
    chatTabs: document.querySelector('#page-chat .chat-tabs'),
    friendsContent: document.getElementById('friends-content'),
    contactsContent: document.getElementById('contacts-content'),
    characterContactsListContainer: document.getElementById('character-contacts-list-container'),
    addNewFriendCard: document.getElementById('add-new-friend-card'),
    contactsMoreBtn: document.getElementById('contacts-more-btn'),
    contactsMenu: document.getElementById('contacts-menu'),
    addFriendBtn: document.getElementById('add-friend-btn'),
    addCharModalOverlay: document.getElementById('add-char-modal-overlay'),
    charModalAvatarUpload: document.getElementById('char-modal-avatar-upload'),
    charModalAvatarPreview: document.getElementById('char-modal-avatar-preview'),
    charModalAvatarPlaceholder: document.getElementById('char-modal-avatar-placeholder'),
    charModalName: document.getElementById('char-modal-name'),
    charModalSubtitle: document.getElementById('char-modal-subtitle'),
    charModalTag: document.getElementById('char-modal-tag'),
    charModalPersona: document.getElementById('char-modal-persona'),
    charModalCancel: document.getElementById('char-modal-cancel'),
    charModalSave: document.getElementById('char-modal-save'),
    charNpcManageBtn: document.getElementById('char-npc-manage-btn'), 
    npcModalOverlay: document.getElementById('char-npc-modal-overlay'), 
    npcListContainer: document.getElementById('npc-list-container'),  
    npcNameInput: document.getElementById('npc-name-input'),           
    npcRelationInput: document.getElementById('npc-relation-input'),   
     npcPersonaInput: document.getElementById('npc-persona-input'),  
    npcAddBtn: document.getElementById('npc-add-btn'),                  
    npcModalConfirm: document.getElementById('npc-modal-confirm'),  
    inputModalOverlay: document.getElementById('api-input-modal-overlay'),
    modalTitle: document.getElementById('api-modal-title'),
    modalInput: document.getElementById('api-modal-input'),
    modalConfirmBtn: document.getElementById('api-modal-confirm'),
    modalCancelBtn: document.getElementById('api-modal-cancel'),
    accountMoreBtn: document.getElementById('account-more-btn'),
    saveIdentityBtn: document.getElementById('save-identity-btn'),
    identityOverlay: document.getElementById('identity-switcher-overlay'),
    identityList: document.getElementById('identity-list'),
    identityCancelBtn: document.getElementById('identity-modal-cancel'),
    addIdentityBtn: document.getElementById('add-identity-btn'),
    avatarImg: document.getElementById('account-avatar-img'),
    nameDisplay: document.getElementById('account-name-display'),
    locationDisplay: document.getElementById('account-location-display'),
    personaTextarea: document.getElementById('persona-textarea'),
    savePersonaBtn: document.getElementById('save-persona-btn'),
    socialCircleListContainer: document.getElementById('social-circle-list-container'),
    addContactBtn: document.getElementById('add-contact-btn'),
    contactEditAvatarImg: document.getElementById('contact-edit-avatar-preview'),
    contactEditNameInput: document.getElementById('contact-edit-name-input'),
    contactEditRelationInput: document.getElementById('contact-edit-relation-input'),
    contactPersonaTextarea: document.getElementById('contact-persona-textarea'),
    saveContactBtn: document.getElementById('save-contact-btn'),
    deleteContactBtn: document.getElementById('delete-contact-btn'),
    apiProviderItem: document.getElementById('api-provider-item'),
    apiUrlItem: document.getElementById('api-url-item'),
    apiKeyItem: document.getElementById('api-key-item'),
    apiModelItem: document.getElementById('api-model-item'),
    apiApplyBtn: document.getElementById('api-apply-btn'),
    apiSaveConfigBtn: document.getElementById('api-save-config-btn'),
    apiProviderValue: document.getElementById('api-provider-value'),
    apiUrlValue: document.getElementById('api-url-value'),
    apiKeyValue: document.getElementById('api-key-value'),
    apiModelValue: document.getElementById('api-model-value'),
    temperatureSlider: document.getElementById('temperature-slider'),
    temperatureValue: document.getElementById('temperature-value'),
    manageConfigsItem: document.getElementById('manage-configs-item'),
    currentConfigValue: document.getElementById('current-config-value'),
    configModalOverlay: document.getElementById('api-config-modal-overlay'),
    configList: document.getElementById('api-config-list'),
    configModalCancelBtn: document.getElementById('api-config-modal-cancel'),
    modelModalOverlay: document.getElementById('api-model-modal-overlay'),
    modelList: document.getElementById('api-model-list'),
    modelModalCancelBtn: document.getElementById('api-model-modal-cancel'),
    homeWallpaperUpload: document.getElementById('home-wallpaper-upload'),
    systemUiBgUpload: document.getElementById('system-ui-bg-upload'),
    appContentBgUpload: document.getElementById('app-content-bg-upload'),
    iconCustomizationList: document.getElementById('icon-customization-list'),
    // ✨ UPDATED: 表情包相关UI元素
    stickerGroupContainer: document.getElementById('sticker-group-container'),
    stickerFabContainer: document.getElementById('sticker-fab-container'),
    stickerFabMain: document.getElementById('sticker-fab-main'),
    fabActionAddGroup: document.getElementById('fab-action-add-group'),
    fabActionAddSticker: document.getElementById('fab-action-add-sticker'),
    stickerAddModalOverlay: document.getElementById('sticker-add-modal-overlay'),
    stickerAddModalCard: document.getElementById('sticker-add-modal-card'),
    stickerUploadList: document.getElementById('sticker-upload-list'),
    stickerUploadDropZone: document.getElementById('sticker-upload-dropzone'),
    stickerAddUrlBtn: document.getElementById('sticker-add-url-btn'),
    stickerUploadCancelBtn: document.getElementById('sticker-upload-cancel-btn'),
    stickerUploadConfirmBtn: document.getElementById('sticker-upload-confirm-btn'),
    stickerFileInput: document.getElementById('sticker-file-input'),
   chatDetailHeader: document.querySelector('#page-chat-detail .app-header'),
  chatDetailAvatar: document.getElementById('chat-detail-char-avatar'),
  chatDetailName: document.getElementById('chat-detail-char-name'),
  scrollTobottomBtn: document.getElementById('scroll-to-bottom-btn'),
  chatInputField: document.getElementById('chat-input-field'),
  emojiBtn: document.getElementById('emoji-btn'),
  stickerPickerPanel: document.getElementById('sticker-picker-panel'),
  stickerPickerContent: document.getElementById('sticker-picker-content'),
  stickerPickerCloseBtn: document.querySelector('.sticker-picker-close-btn'),
  transferBtn: document.getElementById('transfer-btn'),
  transferModalOverlay: document.getElementById('transfer-modal-overlay'),
  cancelTransferBtn: document.getElementById('cancel-transfer-btn'),
  sendTransferBtn: document.getElementById('send-transfer-btn'),
  transferAmountInput: document.getElementById('transfer-amount-input'),
  transferRecipientName: document.getElementById('transfer-recipient-name'),
  transferRecipientAvatar: document.getElementById('transfer-recipient-avatar'),
 worldBook: {
        icon: document.getElementById('shop-icon'), // 主屏幕上的图标
        screen: document.getElementById('world-book-screen'),
        backButton: document.getElementById('wb-screen-back-btn'),
        addButton: document.getElementById('add-world-book-btn'),
        categoryTabs: document.getElementById('world-book-category-tabs'),
        list: document.getElementById('world-book-list'),
    },
    worldBookEditor: {
        screen: document.getElementById('world-book-editor-screen'),
        backButton: document.getElementById('wb-editor-back-btn'),
        saveButton: document.getElementById('save-world-book-btn'),
        idInput: document.getElementById('world-book-id-input'),
        titleInput: document.getElementById('world-book-title-input'),
        categoryInput: document.getElementById('world-book-category-input'),
        contentInput: document.getElementById('world-book-content-input'),
    },exitConfirmation: {
    overlay: document.getElementById('exit-confirmation-overlay'),
    modal: document.querySelector('.exit-confirmation-modal'),
    charAvatar: document.getElementById('modal-char-avatar'),
    charName: document.getElementById('modal-char-name'),
    userAvatar: document.getElementById('modal-user-avatar'),
    userName: document.getElementById('modal-user-name'),
    cancelBtn: document.getElementById('exit-modal-cancel'),
    confirmBtn: document.getElementById('exit-modal-confirm'),
},
historyRecordDetailOverlay: document.getElementById('history-record-detail-overlay'),
historyRecordDetailCard: document.getElementById('history-record-detail-card'),
historyRecordDetailContent: document.getElementById('history-record-detail-content'),
btnDeleteRecordConfirm: document.getElementById('btn-delete-record-confirm'),
btnCancelRecordDetail: document.getElementById('btn-cancel-record-detail'),
    moments: {
        coverImage: document.getElementById('moments-cover-image'),
        coverImageInput: document.getElementById('cover-image-input'),
        userAvatar: document.getElementById('moments-user-avatar'),
        userAvatarInput: document.getElementById('user-avatar-input'),
        userName: document.getElementById('moments-user-name'),
    },
profileStats: {
    friendsCount: document.getElementById('stat-friends-count'),
    identitiesCount: document.getElementById('stat-identities-count'),
    chatDays: document.getElementById('stat-chat-days'),
},
 fontUrlInput: document.getElementById('font-url-input'),
 fontFileUpload: document.getElementById('font-file-upload'),
 saveFontButton: document.getElementById('save-font-button'),
 videoCallContainer: document.getElementById('video-call-container'),

    remoteVideoAvatar: document.getElementById('remote-video-avatar'), // 这是背景大图
    localVideoAvatar: document.getElementById('local-video-avatar'),   // 这是自己的小窗
    remoteVideoUsername: document.getElementById('remote-video-username'),
    videoCallStatus: document.getElementById('video-call-status'),
    videoCallTimer: document.getElementById('video-call-timer'),     // 【新增】
    videoCallInput: document.getElementById('video-call-input'),     // 【新增】
    videoCallSendBtn: document.getElementById('video-call-send-btn'), // 【新增】
    videoHangUpBtn: document.getElementById('video-hang-up-btn'),
    appPages: document.querySelectorAll('.app-page'),
    foodSearchInput: document.querySelector('#page-life-food .food-search-bar input'),
    addFoodNameInput: document.getElementById('add-food-name-input'),
    addFoodPriceInput: document.getElementById('add-food-price-input'),
    addFoodRatingInput: document.getElementById('add-food-rating-input'),
  addFoodSalesInput: document.getElementById('add-food-sales-input'),
  addFoodTimeInput: document.getElementById('add-food-time-input'),
  addFoodDescTextarea: document.getElementById('add-food-desc-textarea'),
  };

let islandCopyRestoreTimeout = null;
let currentIslandCopyText = '';
let currentIslandCopyHint = '';
const ISLAND_COPY_DEFAULT_LABEL = UI.islandCopyBtn?.textContent?.trim() || '复制';
const ISLAND_COPY_DEFAULT_HINT = '可复制给开发者，或发给豆包 / DeepSeek 自查';
const ISLAND_ICON_SVGS = {
  info: `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.1"></circle>
      <path d="M12 10.2v5.2" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"></path>
      <circle cx="12" cy="7.8" r="1" fill="currentColor"></circle>
    </svg>
  `,
  success: `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.1"></circle>
      <polyline points="7.4 12.6 10.4 15.6 16.9 8.8" stroke-linecap="round" stroke-linejoin="round"></polyline>
    </svg>
  `,
  warning: `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 4.5 20.5 19H3.5L12 4.5Z" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"></path>
      <path d="M12 9v4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"></path>
      <circle cx="12" cy="16.8" r="1" fill="currentColor"></circle>
    </svg>
  `,
  error: `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.1"></circle>
      <path d="M12 7.8v5.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"></path>
      <circle cx="12" cy="16.8" r="1" fill="currentColor"></circle>
    </svg>
  `
};

function getIslandVariant(message, options = {}) {
  const explicit = String(options.variant || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (options.loading === true) return 'loading';
  const text = String(message ?? '');
  if (!text) return 'info';
  if (/成功|已保存|已应用|已切换|已删除|已恢复|已复制|完成|已拉取|已导入|已导出|已更新/.test(text)) return 'success';
  if (/失败|错误|出错|异常|无法|未能|拒绝|未找到|不存在|损坏|超时|无效|API|网络|导入失败|导出失败|读取失败|拉取失败|测试失败|保存失败|连接失败|请求失败|加载失败/.test(text)) return 'error';
  if (/警告|注意|稍后|等待|请先|请至少/.test(text)) return 'warning';
  return 'info';
}

function splitIslandMessage(message, variant, options = {}) {
  const raw = String(message ?? '').trim();
  const titleOverride = String(options.title ?? '').trim();
  const detailOverride = String(options.detail ?? '').trim();
  let title = titleOverride || raw;
  let detail = detailOverride;
  if (!detail) {
    const lines = raw.split(/\n+/).map(item => item.trim()).filter(Boolean);
    if (lines.length > 1) {
      const [firstLine, ...restLines] = lines;
      title = firstLine;
      detail = restLines.join(' ');
    } else if (variant === 'error' || variant === 'warning') {
      const colonIndex = raw.search(/[：:]/);
      if (colonIndex > 0) {
        title = raw.slice(0, colonIndex).trim();
        detail = raw.slice(colonIndex + 1).trim();
      } else if (raw.length > 28) {
        title = raw.slice(0, 28).trim();
        detail = raw.slice(28).trim();
      }
    }
  }
  return {
    title: title || raw,
    detail: detail || ''
  };
}

async function copyTextToClipboard(text) {
  const value = String(text ?? '');
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_error) {
    // 继续走兼容方案
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand('copy');
    textarea.remove();
    return Boolean(copied);
  } catch (_error) {
    return false;
  }
}

function resetIslandCopyState() {
  clearTimeout(islandCopyRestoreTimeout);
  islandCopyRestoreTimeout = null;
  currentIslandCopyText = '';
  currentIslandCopyHint = '';
  if (UI.islandCopyBtn) {
    UI.islandCopyBtn.hidden = true;
    UI.islandCopyBtn.disabled = false;
    UI.islandCopyBtn.textContent = ISLAND_COPY_DEFAULT_LABEL;
  }
  if (UI.islandHint) {
    UI.islandHint.hidden = true;
    UI.islandHint.textContent = '';
  }
}

function renderIslandIcon(variant) {
  if (!UI.islandIcon) return;
  if (variant === 'loading') {
    UI.islandIcon.innerHTML = '';
    return;
  }
  UI.islandIcon.innerHTML = ISLAND_ICON_SVGS[variant] || ISLAND_ICON_SVGS.info;
}

if (UI.islandCopyBtn) {
  addTapListener(UI.islandCopyBtn, async event => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!currentIslandCopyText) return;
    const copied = await copyTextToClipboard(currentIslandCopyText);
    if (!UI.islandCopyBtn) return;
    clearTimeout(islandCopyRestoreTimeout);
    UI.islandCopyBtn.disabled = false;
    UI.islandCopyBtn.textContent = copied ? '已复制' : '复制失败';
    if (UI.islandHint) {
      UI.islandHint.textContent = copied ? '已复制到剪贴板' : currentIslandCopyHint;
      UI.islandHint.hidden = !UI.islandHint.textContent;
    }
    islandCopyRestoreTimeout = setTimeout(() => {
      if (!UI.islandCopyBtn) return;
      UI.islandCopyBtn.textContent = ISLAND_COPY_DEFAULT_LABEL;
      if (UI.islandHint) {
        UI.islandHint.textContent = currentIslandCopyHint;
        UI.islandHint.hidden = !currentIslandCopyHint;
      }
    }, 1200);
  });
}



  /* --- 1.5 静态配置数据 --- */
  // (您提到的 customizableIcons 数组在这里被完整保留)
  // 储存不会改变的配置信息，比如哪些图标是可以被自定义的
const homeIconSvgDefaults = {
  'chat-icon': `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="17.5" cy="7" r="5" fill="#EAF2FF"/>
    <path d="M5 6.5h9.5a4 4 0 0 1 4 4v2a4 4 0 0 1-4 4H9l-3.5 3v-3H5a4 4 0 0 1-4-4v-2a4 4 0 0 1 4-4Z" transform="translate(2 0)" stroke="#111" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M8 11h6M8 13.5h3.5" stroke="#111" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`,
  'settings-icon': `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="2.2" fill="#fff" stroke="#111" stroke-width="1.2"/>
    <path d="M12 4.6v2M12 17.4v2M4.6 12h2M17.4 12h2M6.8 6.8l1.4 1.4M15.8 15.8l1.4 1.4M17.2 6.8l-1.4 1.4M8.2 15.8l-1.4 1.4" stroke="#111" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`,
  'gallery-icon': `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="18.2" cy="5.5" r="4" fill="#E2F2E7"/>
    <circle cx="5.5" cy="18.2" r="3.2" fill="#E6EEFF"/>
    <rect x="6.5" y="4" width="12.5" height="10.5" rx="2.4" fill="#fff" stroke="#111" stroke-width="1.45"/>
    <rect x="4" y="6.8" width="13.5" height="12" rx="2.4" fill="#fff" stroke="#111" stroke-width="1.55"/>
    <circle cx="12.8" cy="10.5" r="1.05" fill="#111"/>
    <path d="m5.7 16.1 3.1-3.2 2.3 2.1 2.1-2.3 3.1 3.4" stroke="#111" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  'shop-icon': `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="18.2" cy="18" r="4.1" fill="#F4EBDD"/>
    <path d="M4.5 5.5h5.2c1.25 0 2.3 1 2.3 2.25V19c-.8-.78-1.8-1.2-3-1.2H4.5Z" fill="#fff" stroke="#111" stroke-width="1.45" stroke-linejoin="round"/>
    <path d="M19.5 5.5h-5.2c-1.25 0-2.3 1-2.3 2.25V19c.8-.78 1.8-1.2 3-1.2h4.5Z" fill="#fff" stroke="#111" stroke-width="1.45" stroke-linejoin="round"/>
    <path d="M7 9h3M7 12h3M14 9h3M14 12h3" stroke="#111" stroke-width="1.15" stroke-linecap="round"/>
  </svg>`,
  'idle-icon-2': `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="7" cy="6" r="4.8" fill="#E8F0FF"/>
    <path d="M12 20.5s-5-4.4-5-9a5 5 0 1 1 10 0c0 4.6-5 9-5 9Z" stroke="#111" stroke-width="1.45" stroke-linejoin="round"/>
    <circle cx="12" cy="11.5" r="1.7" stroke="#111" stroke-width="1.35"/>
    <path d="M3.5 19.5h3.4l2.1-2.3" stroke="#111" stroke-width="1.25" stroke-linecap="round" stroke-dasharray="1.8 2.2"/>
  </svg>`,
  'sms-icon': `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="17.5" cy="6.5" r="4.8" fill="#EAF2FF"/>
    <rect x="3.5" y="6.5" width="17" height="11.5" rx="2.4" fill="#fff" stroke="#111" stroke-width="1.45"/>
    <path d="m4.8 8.2 7.2 5.3 7.2-5.3" stroke="#111" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M7 15.3h4" stroke="#111" stroke-width="1.25" stroke-linecap="round"/>
  </svg>`,
  'memory-icon': `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="5" y="4.7" width="14" height="14.8" rx="2.6" fill="#fff" stroke="#111" stroke-width="1.35"/>
    <path d="M8.2 8.5h6.7M8.2 11.4h4.8M8.2 14.3h6.1" stroke="#111" stroke-width="1.15" stroke-linecap="round"/>
    <path d="M16.3 6.5l.5 1 .9.5-.9.5-.5 1-.5-1-.9-.5.9-.5z" fill="#F9E8EC" stroke="#111" stroke-width="0.85" stroke-linejoin="round"/>
  </svg>`,
  'love-icon': `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="4.8" y="6.2" width="14.4" height="11.6" rx="2.3" fill="#fff" stroke="#111" stroke-width="1.35"/>
    <path d="m10.7 9.4 4.1 2.6-4.1 2.6Z" fill="#F4ECE8" stroke="#111" stroke-width="1.05" stroke-linejoin="round"/>
    <path d="M7.2 8.4h1.4M7.2 15.6h1.4M17.2 8.4h-.9M17.2 15.6h-.9" stroke="#111" stroke-width="1.05" stroke-linecap="round"/>
  </svg>`,
  'memo-icon': `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="17.5" cy="6" r="4.8" fill="#F6E5EA"/>
    <path d="M9 16V6l9-2v10" stroke="#111" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="6.5" cy="17" r="2.5" fill="#fff" stroke="#111" stroke-width="1.8"/>
    <circle cx="15.5" cy="15" r="2.5" fill="#fff" stroke="#111" stroke-width="1.8"/>
  </svg>`
};

export  const customizableIcons = [{
    id: 'chat-icon',
    name: '聊天',
    defaultColor: '#ffffff',
    svgHTML: homeIconSvgDefaults['chat-icon']
  }, {
    id: 'memo-icon',
    name: '音乐',
    defaultColor: '#ffffff',
    svgHTML: homeIconSvgDefaults['memo-icon']
  }, {
    id: 'settings-icon',
    name: '设置',
    defaultColor: '#ffffff',
    svgHTML: homeIconSvgDefaults['settings-icon']
  }, {
    id: 'love-icon',
    name: '查手机',
    defaultColor: '#ffffff',
    svgHTML: homeIconSvgDefaults['love-icon']
  },  {
    id: 'gallery-icon',
    name: '相册',
    defaultColor: '#ffffff',
    svgHTML: homeIconSvgDefaults['gallery-icon']
  }, {
    id: 'shop-icon',
    name: '世界书',
    defaultColor: '#ffffff',
    svgHTML: homeIconSvgDefaults['shop-icon']
  }, {
    id: 'couple-space-icon',
    name: '情侣空间',
    defaultColor: 'rgb(255, 255, 255)',
    svgHTML: document.querySelector('#couple-space-icon .icon-bg').innerHTML
  }, {
  id: 'sms-icon',
  name: '短信',
  defaultColor: '#ffffff',
  svgHTML: homeIconSvgDefaults['sms-icon']
}, {
  id: 'memory-icon',
  name: '记忆',
  defaultColor: '#ffffff',
  svgHTML: homeIconSvgDefaults['memory-icon']
}, {

    id: 'back-button',
    name: '返回键',
    defaultColor: 'transparent',
    svgHTML: document.querySelector('.back-button svg').outerHTML
  },    {
    id: 'idle-icon-2',
    name: '生活轨迹',
    defaultColor: '#ffffff',
    svgHTML: homeIconSvgDefaults['idle-icon-2']
  }, {
    id: 'idle-icon-3',
    name: '专属羁绊',
    defaultColor: '#ffffff',
    svgHTML: document.querySelector('#idle-icon-3 .icon-bg').innerHTML
  }, {
    id: 'looky-pay-icon',
    name: '钱包',
    defaultColor: '#ffffff',
    svgHTML: document.querySelector('#looky-pay-icon .icon-bg').innerHTML
  }, {
    id: 'idle-icon-5',
    name: '论坛',
    defaultColor: '#ffffff',
    svgHTML: document.querySelector('#idle-icon-5 .icon-bg').innerHTML
  }, {
    id: 'idle-icon-6',
    name: '角色库',
    defaultColor: '#111111',
    svgHTML: document.querySelector('#idle-icon-6 .icon-bg')?.innerHTML || '<span>CL</span>'
  }

 ];

   /* --- 2.2 核心UI更新 (Core UI Updates) --- */

   // 显示灵动岛通知
export  function showDynamicIsland(message, options = null, legacyDuration = null) {
    const islandOptions = typeof options === 'string'
        ? { variant: options, loading: options === 'loading', duration: typeof legacyDuration === 'number' ? legacyDuration : null }
        : (options && typeof options === 'object' ? { ...options } : {});
    if (typeof options === 'number' && islandOptions.duration == null) islandOptions.duration = options;
    if (typeof legacyDuration === 'number' && islandOptions.duration == null) islandOptions.duration = legacyDuration;
    const isLocked = UI.islandContainer?.dataset.loadingLock === 'true';
    if (isLocked && islandOptions.force !== true) return;
    clearTimeout(tempState.islandTimeout);
    resetIslandCopyState();
    const rawMessage = String(message ?? '');
    const variant = getIslandVariant(rawMessage, islandOptions);
    const { title, detail } = splitIslandMessage(rawMessage, variant, islandOptions);
  const copyText = islandOptions.copyText == null ? (variant === 'error' ? rawMessage : '') : String(islandOptions.copyText || '');
  const hintText = detail || (copyText ? String(islandOptions.hint || ISLAND_COPY_DEFAULT_HINT) : '');
  const duration = typeof islandOptions.duration === 'number' ? islandOptions.duration : ((variant === 'error' || copyText) ? 6000 : 2200);
  const isExpanded = Boolean(detail || copyText || islandOptions.expanded === true || rawMessage.length > 32);
  UI.islandText.textContent = title;
  if (UI.islandHint) {
        UI.islandHint.textContent = hintText;
        UI.islandHint.hidden = !hintText;
  }
    if (UI.islandCopyBtn) {
        UI.islandCopyBtn.hidden = !copyText;
        UI.islandCopyBtn.disabled = false;
        UI.islandCopyBtn.textContent = ISLAND_COPY_DEFAULT_LABEL;
    }
    currentIslandCopyText = copyText;
    currentIslandCopyHint = hintText;
    renderIslandIcon(variant);
    UI.islandContainer.classList.add('show');
    UI.islandContainer.classList.toggle('loading', islandOptions.loading === true || variant === 'loading');
    UI.islandContainer.classList.toggle('is-error', variant === 'error');
    UI.islandContainer.classList.toggle('is-success', variant === 'success');
    UI.islandContainer.classList.toggle('is-warning', variant === 'warning');
    UI.islandContainer.classList.toggle('is-info', variant === 'info');
    UI.islandContainer.classList.toggle('is-expanded', isExpanded);
    UI.islandContainer.dataset.loadingLock = islandOptions.persist === true ? 'true' : 'false';
    UI.islandContainer.dataset.variant = variant;
    if (islandOptions.persist === true) return;
    tempState.islandTimeout = setTimeout(() => hideDynamicIsland(), duration);
  }

export function hideDynamicIsland() {
    clearTimeout(tempState.islandTimeout);
    tempState.islandTimeout = null;
    resetIslandCopyState();
    UI.islandContainer.classList.remove('show', 'loading');
    UI.islandContainer.classList.remove('is-error');
    UI.islandContainer.classList.remove('is-success', 'is-warning', 'is-info');
    UI.islandContainer.classList.remove('is-expanded');
    UI.islandContainer.dataset.loadingLock = 'false';
    UI.islandContainer.dataset.variant = '';
  }

  // 更新主屏幕和状态栏的时间
export  function updateTime() {
    const now = new Date();
    const hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const timeString = `${hours}:${minutes}`;
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    // ▼▼▼ 修改开始：加上判断，如果文字没变就不执行，解决每秒原地重绘导致的发热 ▼▼▼
    if (UI.timeDisplay.textContent !== timeString) UI.timeDisplay.textContent = timeString;
    if (UI.statusBarTime && UI.statusBarTime.textContent !== timeString) UI.statusBarTime.textContent = timeString;

    let period = (hours >= 5 && hours < 12) ? '早上' : (hours >= 12 && hours < 18) ? '下午' : '晚上';
    const newPeriodStr = `${weekdays[now.getDay()]}${period}`;
    if (UI.dayPeriodDisplay.textContent !== newPeriodStr) UI.dayPeriodDisplay.textContent = newPeriodStr;
    
    const newDateStr = `${now.getMonth() + 1}/${String(now.getDate()).padStart(2, '0')}`;
    if (UI.dateDisplay.textContent !== newDateStr) UI.dateDisplay.textContent = newDateStr;
    // ▲▲▲ 修改结束 ▲▲▲
  }

  // 更新电池状态显示
export  function updateBatteryStatus() {
    if (!('getBattery' in navigator)) return;
    navigator.getBattery().then(battery => {
      const maxBatteryWidth = 18;
      const update = () => {
        const percentage = Math.floor(battery.level * 100);
        UI.batteryLevelIndicator.setAttribute('width', battery.level * maxBatteryWidth);
        UI.batteryPercentageText.textContent = `${percentage}%`;
      };
      update();
      battery.addEventListener('levelchange', update);
    });
  }

  // 应用自定义图标设置
export  const applyIconSetting = (iconId) => {
    const setting = AppState.iconSettings[iconId];

    if (iconId === 'back-button') {
      const wrappers = document.querySelectorAll('.back-button-icon-wrapper');
      wrappers.forEach(wrapper => {
        if (setting && setting.type === 'image') {
          wrapper.innerHTML = `<img src="${setting.value}" style="width:100%; height:100%; object-fit:contain;">`;
        } else {
          const defaultIcon = customizableIcons.find(i => i.id === 'back-button');
          wrapper.innerHTML = defaultIcon.svgHTML;
        }
      });
      return;
    }

    const iconElement = document.querySelector(`#${iconId} .icon-bg`);
    if (!iconElement) return;

    if (setting && setting.type === 'image') {
      iconElement.classList.add('has-image');
      iconElement.style.backgroundColor = 'transparent';
      iconElement.style.backgroundImage = 'none';
      iconElement.innerHTML = `<img src="${setting.value}" alt="Icon">`;
    } else {
      const iconDefault = customizableIcons.find(i => i.id === iconId);
      iconElement.classList.remove('has-image');
      iconElement.style.backgroundImage = 'none';
      iconElement.style.backgroundColor = iconDefault.defaultColor;
      iconElement.innerHTML = iconDefault.svgHTML;
    }
  };
let currentLookyPageId = 'home';
let lastThemeUpdateKey = '';
let pendingThemeUpdateFrame = 0;
const THEME_RELEVANT_PAGE_IDS = new Set(['page-chat', 'page-profile', 'page-dynamics', 'page-chat-detail', 'page-offline-mode']);
const CHAT_SHELL_PAGE_IDS = new Set(['page-chat', 'page-profile', 'page-dynamics']);

export function getCurrentLookyPageId() {
  return currentLookyPageId;
}

function scheduleThemeUpdateForPage(pageId, previousPageId) {
  if (!window.applyCurrentThemeConfig) return;
  // 进入设置页不需要重建主题；离开设置页必须在聊天页重新应用最新方案。
  if (pageId === 'page-chat-settings') {
    // 清掉上一次同路径的去重标记，保证本次设置后的返回一定会刷新主题。
    lastThemeUpdateKey = '';
    return;
  }

  const isThemeRelevant = THEME_RELEVANT_PAGE_IDS.has(pageId);
  const wasThemeRelevant = THEME_RELEVANT_PAGE_IDS.has(previousPageId);
  if (!isThemeRelevant && !wasThemeRelevant) return;
  if (CHAT_SHELL_PAGE_IDS.has(pageId) && CHAT_SHELL_PAGE_IDS.has(previousPageId)) return;

  const chatThemeContext = ['page-chat-detail', 'page-offline-mode'].includes(pageId)
    ? String(tempState.currentChatId || '')
    : '';
  const updateKey = `${previousPageId || 'none'}>${pageId || 'none'}:${chatThemeContext}`;
  if (lastThemeUpdateKey === updateKey) return;
  lastThemeUpdateKey = updateKey;

  if (pendingThemeUpdateFrame) cancelAnimationFrame(pendingThemeUpdateFrame);
  pendingThemeUpdateFrame = requestAnimationFrame(() => {
      pendingThemeUpdateFrame = 0;
      try { window.applyCurrentThemeConfig(); } catch (e) { console.warn("Theme update failed:", e); }
  });
}

export function showPage(pageId, extraData = {}) {
  const previousPageId = currentLookyPageId;
  const targetPage = document.getElementById(pageId);
  const apiBall = document.getElementById('api-floating-ball');
  if (apiBall) {
      if (pageId === 'page-chat-search') {
          if (apiBall.dataset.hiddenByChatSearch !== '1') {
              apiBall.dataset.chatSearchPreviousDisplay = apiBall.style.display || 'flex';
          }
          apiBall.dataset.hiddenByChatSearch = '1';
          apiBall.style.display = 'none';
      } else if (apiBall.dataset.hiddenByChatSearch === '1') {
          apiBall.dataset.hiddenByChatSearch = '0';
          apiBall.style.display = apiBall.dataset.chatSearchPreviousDisplay || 'flex';
      }
  }
  if (pageId === previousPageId && targetPage && targetPage.style.display !== 'none') {
      if (pageId === 'page-chat' && typeof window.setChatHomeSection === 'function') {
        window.setChatHomeSection(extraData.chatSection || tempState.currentChatHomeSection || 'friends-content');
      }
      scheduleThemeUpdateForPage(pageId, previousPageId);
      return;
  }
  // ▼▼▼ 新增：全局拦截，只要切换页面，立刻强制销毁所有长按弹出的菜单 ▼▼▼
  // 【性能修复】只查找处于打开状态 (.visible) 的菜单，避免遍历上千条历史消息导致卡死！
  document.querySelectorAll('.action-popover.visible, .message-action-popover.visible').forEach(el => {
      el.classList.remove('visible');
      el.style.display = ''; 
  });

  // 1. 先安全地隐藏所有不需要的页面 (避免布局挤压)
  const canFastSwitchChatShell =
      targetPage &&
      CHAT_SHELL_PAGE_IDS.has(pageId) &&
      CHAT_SHELL_PAGE_IDS.has(previousPageId);
  if (canFastSwitchChatShell) {
      const previousPage = document.getElementById(previousPageId);
      if (previousPage && previousPage !== targetPage) previousPage.style.display = 'none';
      targetPage.style.display = 'flex';
      currentLookyPageId = pageId;
      window.dispatchEvent(new CustomEvent('looky:page-opened', { detail: { pageId } }));
      if (pageId === 'page-chat' && typeof window.setChatHomeSection === 'function') {
        window.setChatHomeSection(extraData.chatSection || tempState.currentChatHomeSection || 'friends-content');
      }
      scheduleThemeUpdateForPage(pageId, previousPageId);
      return;
  }

  const pages = (UI.appPages && UI.appPages.length > 0) ? UI.appPages : document.querySelectorAll('.app-page');

  for (let i = 0; i < pages.length; i++) {
      if (pages[i].id !== pageId && pages[i].style.display !== 'none') {
          pages[i].style.display = 'none';
      }
  }
  
  if (UI.homeScreenWrapper && UI.homeScreenWrapper.style.display !== 'none') {
      UI.homeScreenWrapper.style.display = 'none';
  }

  // 2. 再显示目标页面 (此时浏览器还未渲染，不会有白屏)
  if (targetPage) {
      targetPage.style.display = 'flex';
      currentLookyPageId = pageId;
      window.dispatchEvent(new CustomEvent('looky:page-opened', { detail: { pageId } }));
      if (pageId === 'page-chat' && typeof window.setChatHomeSection === 'function') {
        window.setChatHomeSection(extraData.chatSection || tempState.currentChatHomeSection || 'friends-content');
      }
  }
  // 3. 【终极防卡死】双重 RAF 技术，强制等页面彻底画到屏幕上之后，再算沉重的主题！
  scheduleThemeUpdateForPage(pageId, previousPageId);
}
export function showHomeScreen() {
  const previousPageId = currentLookyPageId;
  // ▼▼▼ 新增：返回桌面时同样强制清理所有悬浮菜单 ▼▼▼
   // 【性能修复】退回桌面时，也只查找打开状态的菜单，杜绝全局扫描！
  document.querySelectorAll('.action-popover.visible, .message-action-popover.visible').forEach(el => {
      el.classList.remove('visible');
      el.style.display = ''; 
  });
  // 1. 先安全地隐藏所有APP页面
  const pages = (UI.appPages && UI.appPages.length > 0) ? UI.appPages : document.querySelectorAll('.app-page');

  for (let i = 0; i < pages.length; i++) {
      if (pages[i].style.display !== 'none') {
          pages[i].style.display = 'none';
      }
  }

  // 2. 再显示主屏幕
  if (UI.homeScreenWrapper) {
      UI.homeScreenWrapper.style.display = 'flex';
      currentLookyPageId = 'home';
      window.dispatchEvent(new CustomEvent('looky:page-opened', { detail: { pageId: 'home' } }));
  }
  // 3. 【终极防卡死】退回桌面时，同样用双重 RAF，保证退出的绝对丝滑
  scheduleThemeUpdateForPage('home', previousPageId);
}
  /* --- 2.4 通用模态框(弹窗)逻辑 (Modal Logic) --- */

  // 用于保存确认按钮回调的变量
  let onInputConfirm = null;

  // 显示一个通用的输入弹窗（可以是输入框或文本域）
  export function showInputModal(...args) {
    // 核心：判断是新式调用还是旧式调用
    // 新式: showInputModal({ title: '...', ... }) -> args[0] 是一个对象
    // 旧式: showInputModal('标题', '值', callback) -> args[0] 是一个字符串
    const isPromiseStyle = typeof args[0] === 'object' && args[0] !== null;
  
    // --- 1. 参数规范化 ---
    let title, initialValue, placeholder, isTextarea, position, callback;
  
    if (isPromiseStyle) {
      // 新式调用，解构参数
      ({
        title = '输入',
        initialValue = '',
        placeholder = '请在此处输入...',
        isTextarea = false,
        position = 'center'
      } = args[0]);
    } else {
      // 旧式调用，按顺序获取参数
      [title, initialValue, callback] = args;
      const options = args[3] || {};
      isTextarea = options.isTextarea || false;
      position = options.position || 'center';
      // 为旧式调用重建 placeholder 逻辑
      placeholder = isTextarea ? '说明-https://...\nhttps://...' : '请在此处输入...';
    }
  
    // --- 2. 统一的 UI 更新逻辑 ---
    UI.modalTitle.textContent = title;
  
    const card = document.getElementById('api-input-modal-card');
    let inputElement = card.querySelector('input, textarea');
    const newElementType = isTextarea ? 'textarea' : 'input';
  
    if (!inputElement || inputElement.tagName.toLowerCase() !== newElementType) {
      const newElement = document.createElement(newElementType);
      newElement.id = 'api-modal-input';
      if (inputElement) inputElement.replaceWith(newElement);
      else card.insertBefore(newElement, card.querySelector('.modal-buttons'));
      UI.modalInput = newElement;
    }
    
    UI.modalInput.placeholder = placeholder;
    if (isTextarea) {
        UI.modalInput.style.cssText = 'height: 15vh; resize: vertical;';
    } else {
        UI.modalInput.type = 'text';
    }
  
    UI.inputModalOverlay.classList.remove('position-top');
    if (position === 'top') UI.inputModalOverlay.classList.add('position-top');
  
    UI.modalInput.value = initialValue || '';
    UI.inputModalOverlay.classList.add('visible');
    UI.modalInput.focus();
  
    // --- 3. 根据调用方式决定返回值和回调 ---
    if (isPromiseStyle) {
      // 新式调用：返回一个 Promise，并将 resolve 函数赋给 onInputConfirm
      return new Promise(resolve => {
        onInputConfirm = resolve;
      });
    } else {
      // 旧式调用：将传入的 callback 赋给 onInputConfirm，不返回值
      onInputConfirm = callback;
    }
  }


  // 隐藏通用输入弹窗
export  function hideInputModal() {
    if (UI.modalInput && document.activeElement === UI.modalInput) {
        UI.modalInput.blur();
    }
    UI.inputModalOverlay.classList.remove('visible');
    setTimeout(() => UI.inputModalOverlay.classList.remove('position-top'), 300);
  }

  // 为通用输入弹窗的按钮绑定事件
    addTapListener(UI.modalConfirmBtn, () => {
      // onInputConfirm 此时可能是 resolve 函数或旧的回调
      if (onInputConfirm) onInputConfirm(UI.modalInput.value.trim());
      hideInputModal();
    });
    
    const cancelAction = () => {
        // 取消时，传递 null 给 resolve 或回调
        if (onInputConfirm) onInputConfirm(null);
        hideInputModal();
    };
    
    UI.modalCancelBtn.addEventListener('click', cancelAction);
    UI.inputModalOverlay.addEventListener('click', e => {
      if (e.target === UI.inputModalOverlay) {
        cancelAction();
      }
    });

    

/**
 * 滚动聊天列表到底部
 */
export function scrollToBottom() {
  const messageList = document.getElementById('chat-message-list');
  if (messageList) {
    // 将 scrollTop 设置为 scrollHeight 可以立即滚动到最底部
    messageList.scrollTop = messageList.scrollHeight;
  }
}
// 头部“更多”按钮 (记忆详情页)
export const headerMoreBtn = document.querySelector('#page-memory-detail .header-more-btn');

// 更多操作菜单
export const headerMoreMenu = document.getElementById('header-more-menu');
export const addMemoryBtn = document.getElementById('add-memory-btn');

// 添加记忆模态框相关元素
export const addMemoryModal = document.getElementById('add-memory-modal');
export const memoryDateInput = document.getElementById('memory-date-input');
export const memoryContentInput = document.getElementById('memory-content-input');
export const cancelMemoryBtn = document.getElementById('cancel-memory-btn');
export const saveMemoryBtn = document.getElementById('save-memory-btn');
/**
 * 动态创建并显示一个上下文菜单
 * @param {object} options
 * @param {object} options.position - 菜单显示的位置 { x, y }
 * @param {Array<object>} options.items - 菜单项数组，例如 [{ label: '删除', action: 'delete' }]
 * @returns {HTMLElement} 返回创建的菜单元素
 */
export function showContextMenu({ position, items }) {
  // 先移除已存在的菜单，防止重复
  document.querySelector('.context-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  
  items.forEach(item => {
    const menuItem = document.createElement('div');
    menuItem.className = 'menu-item';
    
    if (item.type === 'separator') {
      menuItem.classList.add('is-separator');
    } else {
      menuItem.textContent = item.label;
      // 使用 data-* 属性来存储点击后需要执行的动作
      menuItem.dataset.action = item.action;
    }
    menu.appendChild(menuItem);
  });
  document.body.appendChild(menu);
  // 计算位置，防止菜单超出屏幕
  const menuWidth = menu.offsetWidth;
  const menuHeight = menu.offsetHeight;
  let left = position.x;
  let top = position.y;
  if (left + menuWidth > window.innerWidth) {
    left = window.innerWidth - menuWidth - 10;
  }
  if (top + menuHeight > window.innerHeight) {
    top = window.innerHeight - menuHeight - 10;
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  // 延迟一帧添加 .is-visible 类以触发 CSS 过渡动画
  requestAnimationFrame(() => {
    menu.classList.add('is-visible');
  });
  // 添加点击外部关闭菜单的逻辑
  const closeMenu = () => {
    menu.remove();
    document.removeEventListener('click', closeMenu);
    document.removeEventListener('contextmenu', closeMenu);
  };
  // 延迟添加，否则会立即触发关闭
  setTimeout(() => {
    document.addEventListener('click', closeMenu, { once: true });
    document.addEventListener('contextmenu', closeMenu, { once: true });
  }, 0);
  return menu;
}
/* ==========================================================================
   ▼▼▼ 【新增】历史记录弹窗的控制函数 ▼▼▼
   ========================================================================== */

// 1. 先找到弹窗相关的零件
export const historyModalOverlay = document.getElementById('history-modal-overlay');
export const historyModalContent = document.getElementById('history-modal-content');
const historyModalDeleteBtn = document.getElementById('history-modal-delete-btn');
const historyModalCancelBtn = document.getElementById('history-modal-cancel-btn');

function keepHistoryModalsInsidePhoneScreen() {
  const phoneScreen = document.querySelector('#flj8W .phone-screen');
  if (!phoneScreen) return;

  [historyModalOverlay, UI.historyRecordDetailOverlay].forEach((modal) => {
    if (modal && modal.parentElement !== phoneScreen) {
      phoneScreen.appendChild(modal);
    }
  });
}

// 2. “显示”弹窗的函数
export function showHistoryModal() {
  if (historyModalOverlay) {
    keepHistoryModalsInsidePhoneScreen();
    historyModalOverlay.style.position = 'absolute';
    historyModalOverlay.style.inset = '0';
    historyModalOverlay.style.width = '100%';
    historyModalOverlay.style.height = '100%';
    historyModalOverlay.style.minHeight = '100%';
    historyModalOverlay.style.overflow = 'hidden';
    historyModalOverlay.style.touchAction = 'none';
    historyModalOverlay.style.overscrollBehavior = 'contain';
    historyModalOverlay.style.zIndex = '1000';
    const historyModalCard = historyModalOverlay.querySelector('.history-modal-card');
    if (historyModalCard) {
      historyModalCard.style.removeProperty('width');
      historyModalCard.style.removeProperty('max-width');
      historyModalCard.style.padding = '0';
      historyModalCard.style.maxHeight = '85%';
      historyModalCard.style.boxSizing = 'border-box';
    }
    if (historyModalContent) {
      historyModalContent.style.padding = '8px 10px 16px';
    }
    historyModalOverlay.classList.add('visible');
  }
}

// 3. “隐藏”弹窗的函数
export function hideHistoryModal() {
  if (historyModalOverlay) {
    historyModalOverlay.classList.remove('visible');
  }
}

// 4. 给关闭按钮、清空按钮、黑色背景绑定点击事件
function initHistoryModalListeners() {
  // 点击“关闭”按钮
  if (historyModalCancelBtn) {
    historyModalCancelBtn.addEventListener('click', hideHistoryModal);
  }
  
  // 点击黑色背景区域
  if (historyModalOverlay) {
    historyModalOverlay.addEventListener('click', (e) => {
      // 只有当点的是黑色背景本身，而不是点在白色卡片上时，才关闭
      if (e.target === historyModalOverlay) {
        hideHistoryModal();
      }
    });
  }

  // 点击“清空记录”按钮 (这里我们先用 alert 提示，具体功能在 offline-mode.js 中实现)
  if (historyModalDeleteBtn) {
    historyModalDeleteBtn.addEventListener('click', () => {
      // 触发一个自定义事件，让 offline-mode.js 去处理删除逻辑
      document.dispatchEvent(new CustomEvent('clearOfflineHistoryRequest'));
    });
  }
}

// 5. 让这些监听器在页面加载时就准备好
initHistoryModalListeners();
/**
 * [新增] 显示一个简单的列表选择弹窗
 * @param {string} title - 弹窗标题
 * @param {Array<object>} items - 选项数组, e.g., [{id: 1, name: '选项一'}]
 * @param {function} onSelect - 用户选择后的回调函数，会传入选中的 id
 */
export function showSimpleSelectModal(title, items, onSelect) {
    // 1. 创建弹窗的 HTML 结构
    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'modal-overlay';
    
    const modalContent = `
        <div class="modal-card selection-modal-card">
            <h3>${escapeHTML(title)}</h3>
            <ul class="selection-list">
                ${items.map(item => `
                    <li class="selection-list-item" data-id="${item.id}">
                        <span class="item-text">${escapeHTML(item.name)}</span>
                    </li>
                `).join('')}
            </ul>
        </div>
    `;
    modalOverlay.innerHTML = modalContent;
    
    // 2. 定义关闭函数
    const closeModal = () => {
        modalOverlay.classList.remove('visible');
        setTimeout(() => modalOverlay.remove(), 300); // 动画结束后再移除
    };
    // 3. 绑定事件
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) { // 点击背景关闭
            closeModal();
        }
        const selectedItem = e.target.closest('.selection-list-item');
        if (selectedItem) {
            const selectedId = selectedItem.dataset.id;
            onSelect(selectedId); // 执行回调
            closeModal();
        }
    });
    // 4. 显示弹窗
    document.body.appendChild(modalOverlay);
    setTimeout(() => modalOverlay.classList.add('visible'), 10);
}

/**
 * 显示通用确认弹窗，并以 Promise 返回用户选择。
 */
export function showConfirmModal(options = {}) {
    const {
        title = '请确认',
        message = '',
        summary = '',
        confirmText = '确认',
        cancelText = '取消',
        danger = false
    } = options && typeof options === 'object' ? options : {};

    return new Promise(resolve => {
        const modalOverlay = document.createElement('div');
        modalOverlay.className = 'modal-overlay mcp-confirm-overlay';
        modalOverlay.innerHTML = `
            <div class="modal-card mcp-confirm-card ${danger ? 'is-danger' : ''}" role="dialog" aria-modal="true" aria-labelledby="mcp-confirm-title">
                <div class="mcp-confirm-heading">
                    ${danger ? '<span class="mcp-confirm-danger-icon" aria-hidden="true">!</span>' : ''}
                    <h3 id="mcp-confirm-title">${escapeHTML(title)}</h3>
                </div>
                ${message ? `<p class="mcp-confirm-message">${escapeHTML(message)}</p>` : ''}
                ${summary ? `
                    <div class="mcp-confirm-summary" tabindex="0">
                        <span>参数摘要</span>
                        <pre>${escapeHTML(typeof summary === 'string' ? summary : JSON.stringify(summary, null, 2))}</pre>
                    </div>
                ` : ''}
                <div class="modal-buttons mcp-confirm-actions">
                    <button type="button" class="btn btn-secondary" data-confirm-action="cancel">${escapeHTML(cancelText)}</button>
                    <button type="button" class="btn btn-primary" data-confirm-action="confirm">${escapeHTML(confirmText)}</button>
                </div>
            </div>
        `;

        let settled = false;
        const closeModal = value => {
            if (settled) return;
            settled = true;
            modalOverlay.classList.remove('visible');
            setTimeout(() => modalOverlay.remove(), 180);
            resolve(value);
        };

        modalOverlay.addEventListener('click', event => {
            if (event.target === modalOverlay || event.target.closest('[data-confirm-action="cancel"]')) {
                closeModal(false);
                return;
            }
            if (event.target.closest('[data-confirm-action="confirm"]')) closeModal(true);
        });

        document.body.appendChild(modalOverlay);
        requestAnimationFrame(() => modalOverlay.classList.add('visible'));
    });
}
/* ==========================================================================
   ▼▼▼ 移动端键盘兼容性修复 (防乱飞优化版) ▼▼▼
   ========================================================================== */
function initMobileKeyboardFix() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isAndroid = /Android/.test(navigator.userAgent); // 新增安卓判断

    // 1. 全局监听输入框获得焦点
    document.addEventListener('focusin', (e) => {
        // 针对所有移动端（包含iOS和安卓）
        if ((isIOS || isAndroid) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {

            // 【核心优化】如果是弹窗（modal）里的输入框，不要用 scrollIntoView 强行推页面。
            // 否则会把整个弹窗的固定定位顶乱，造成页面上移卡死。
            const isInModal = e.target.closest('.modal-overlay');
            if (!isInModal) {
                // 设置一个延时，等键盘完全弹出来
                setTimeout(() => {
                    e.target.scrollIntoView({ 
                        block: 'nearest', 
                          behavior: 'auto' 
                    });
                }, 300);
            }
        }
    });

    // 2. 针对移动端键盘收起后的页面回弹修复 (保持页面位置)
    document.addEventListener('focusout', (e) => {
        if ((isIOS || isAndroid) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
            setTimeout(() => {

                // 【核心修复】由于整个App是单页固定架构，外层body不应有滚动。
                // 当键盘收起时，强制把被系统顶上去的页面一把拉回原位 (0, 0)
                window.scrollTo(0, 0);
                                    // ▼▼▼ 【新增】专门针对日记页面和日记设置弹窗的键盘回弹修复 ▼▼▼
                    // 强制消除因键盘顶起而在底部产生的巨大黑边
                    const diaryWrapper = document.getElementById('diary-page-wrapper');
                    if (diaryWrapper) {
                        diaryWrapper.scrollTop = 0;
                    }
                    const diarySettingsModal = document.getElementById('diary-settings-modal');
                    if (diarySettingsModal && diarySettingsModal.classList.contains('visible')) {
                        diarySettingsModal.scrollTop = 0;
                    }
            }, 10); // 极速触发原地重绘，彻底解决所有弹窗上移下不来的问题
        }
    });

}

// 启动修复
function initMobileKeyboardFixOptimized() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isAndroid = /Android/.test(navigator.userAgent);
    const shouldHandle = () => isIOS || isAndroid;
    const isTextControl = target => target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    const isAndroidStandalone = () => {
        const capacitor = typeof window !== 'undefined' ? window.Capacitor : null;
        const isCapacitorNative = Boolean(
            typeof capacitor?.isNativePlatform === 'function' && capacitor.isNativePlatform()
        );
        const isInstalledPwa = Boolean(
            window.matchMedia &&
            (
                document.documentElement.classList.contains('looky-native') ||
                window.matchMedia('(display-mode: fullscreen)').matches ||
                window.matchMedia('(display-mode: standalone)').matches ||
                window.matchMedia('(display-mode: window-controls-overlay)').matches
            )
        );
        return Boolean(isAndroid && (isCapacitorNative || isInstalledPwa));
    };
    const isForumHeavyKeyboardTarget = target => {
        const id = target && target.id;
        return id === 'detail-comment-input' || id === 'forum-compose-full-text';
    };
    const isFixedVideoCallInput = target => target && target.id === 'video-call-input';
    let androidViewportTimer = null;
    let lastAndroidAppHeight = 0;
    let lastAndroidKeyboardOpen = false;
    let baselineAndroidViewportHeight = 0;

    const getAndroidLayoutViewportHeight = () => Math.round(
        window.innerHeight || document.documentElement.clientHeight || 0
    );

    const getAndroidVisualViewportHeight = () => Math.round(
        window.visualViewport?.height || getAndroidLayoutViewportHeight()
    );

    const getAndroidVisualViewportBottom = () => {
        const viewport = window.visualViewport;
        if (!viewport) return getAndroidLayoutViewportHeight();
        return Math.round(viewport.height + Math.max(0, viewport.offsetTop || 0));
    };

    const syncScaledNativeAppHeight = height => {
        if (!height) return;
        const scale = Number(window.__lookyDisplayScale) || 1;
        document.documentElement.style.setProperty('--looky-native-app-height', `${Math.round(height / scale)}px`);
    };

    const updateAndroidViewportHeight = () => {
        if (!isAndroid) return;

        const layoutViewportHeight = getAndroidLayoutViewportHeight();
        const visualViewportHeight = getAndroidVisualViewportHeight();
        const visualViewportBottom = Math.min(layoutViewportHeight, getAndroidVisualViewportBottom());
        if (!layoutViewportHeight || !visualViewportHeight || !visualViewportBottom) return;

        const activeElement = document.activeElement;
        const isFocusedTextControl = isTextControl(activeElement);
        const capacitor = typeof window !== 'undefined' ? window.Capacitor : null;
        const isCapacitorNative = Boolean(
            typeof capacitor?.isNativePlatform === 'function' && capacitor.isNativePlatform()
        );
        const nativeViewport = window.__lookyNativeViewportInsets;
        if (isCapacitorNative && Number(nativeViewport?.appHeight) > 0) {
            const keyboardOpen = nativeViewport.keyboardOpen === true;
            const stableHeight = Math.round(Number(nativeViewport.appHeight));
            document.body.classList.add('android-viewport-sync');
            document.body.classList.toggle('android-pwa-keyboard-open', keyboardOpen);
            if (Math.abs(stableHeight - lastAndroidAppHeight) > 2) {
                document.documentElement.style.setProperty('--looky-app-height', `${stableHeight}px`);
                syncScaledNativeAppHeight(stableHeight);
                lastAndroidAppHeight = stableHeight;
            }
            lastAndroidKeyboardOpen = keyboardOpen;
            return;
        }
        if (!baselineAndroidViewportHeight && !isFocusedTextControl) {
            baselineAndroidViewportHeight = layoutViewportHeight;
        }
        // Edge-to-edge Android reports a non-zero visualViewport.offsetTop for
        // the transparent status bar. Use the visible bottom edge, otherwise
        // the app becomes one status-bar height too short above the keyboard.
        const layoutViewportResized = Boolean(
            baselineAndroidViewportHeight > 0 &&
            layoutViewportHeight < baselineAndroidViewportHeight - 80
        );
        const keyboardDelta = Math.max(0, layoutViewportHeight - visualViewportBottom);
        // 输入框刚失焦时，Android 键盘仍在收起动画中；此时先保持键盘打开状态，
        // 避免把过渡中的半屏高度写入 CSS，下一帧又恢复全屏造成闪烁。
        const keyboardClosing = Boolean(
            !isFocusedTextControl &&
            lastAndroidKeyboardOpen &&
            (keyboardDelta > 80 || layoutViewportResized)
        );
        const keyboardOpen = Boolean(
            keyboardClosing ||
            (isFocusedTextControl && (keyboardDelta > 80 || layoutViewportResized))
        );
        if (!keyboardOpen && !keyboardClosing) baselineAndroidViewportHeight = layoutViewportHeight;

        const shouldSyncHeight = isAndroidStandalone();
        document.body.classList.toggle('android-viewport-sync', shouldSyncHeight);
        document.body.classList.toggle('android-pwa-keyboard-open', shouldSyncHeight && keyboardOpen);
        lastAndroidKeyboardOpen = keyboardOpen;
        if (!shouldSyncHeight) {
            document.documentElement.style.removeProperty('--looky-app-height');
            lastAndroidAppHeight = 0;
            return;
        }

        if (keyboardClosing) return;

        // Native Android uses adjustNothing so the system cannot pan the whole
        // WebView. PWA keeps the resize-compatible fallback used by browsers.
        const stableHeight = Math.round(
            isCapacitorNative
                ? (keyboardOpen ? visualViewportBottom : layoutViewportHeight)
                : (keyboardOpen && !layoutViewportResized ? visualViewportHeight : layoutViewportHeight)
        );
        if (Math.abs(stableHeight - lastAndroidAppHeight) > 2) {
            document.documentElement.style.setProperty('--looky-app-height', `${stableHeight}px`);
            syncScaledNativeAppHeight(stableHeight);
            lastAndroidAppHeight = stableHeight;
        }
    };

    const scheduleAndroidViewportHeight = (delay = 0) => {
        if (!isAndroid) return;
        window.clearTimeout(androidViewportTimer);
        androidViewportTimer = window.setTimeout(() => {
            requestAnimationFrame(updateAndroidViewportHeight);
        }, delay);
    };

    if (isAndroid) {
        scheduleAndroidViewportHeight();
        window.addEventListener('resize', () => scheduleAndroidViewportHeight(40), { passive: true });
        window.addEventListener('orientationchange', () => {
            baselineAndroidViewportHeight = 0;
            lastAndroidAppHeight = 0;
            scheduleAndroidViewportHeight(120);
        }, { passive: true });
        window.visualViewport?.addEventListener('resize', () => scheduleAndroidViewportHeight(40), { passive: true });
        const isNativeAndroidRuntime = document.documentElement.classList.contains('looky-native') ||
            window.__lookyRuntime === 'native' ||
            Boolean(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
        if (!isNativeAndroidRuntime) {
            window.visualViewport?.addEventListener('scroll', () => scheduleAndroidViewportHeight(40), { passive: true });
        }
        window.addEventListener('looky:native-viewport-changed', () => scheduleAndroidViewportHeight(), { passive: true });
    }

    document.addEventListener('focusin', (e) => {
        if (!shouldHandle() || !isTextControl(e.target)) return;
        scheduleAndroidViewportHeight(60);
        if (e.target.closest('.modal-overlay')) return;
        if (isForumHeavyKeyboardTarget(e.target) || isFixedVideoCallInput(e.target)) return;

        setTimeout(() => {
            requestAnimationFrame(() => {
                if (document.activeElement !== e.target) return;
                if (isAndroid) updateAndroidViewportHeight();
                if (e.target.id === 'chat-input-field' && document.documentElement.classList.contains('looky-native')) {
                    return;
                }
                const scrollTarget = e.target.id === 'chat-input-field'
                    ? e.target.closest('.chat-input-container') || e.target
                    : e.target;
                const rect = scrollTarget.getBoundingClientRect();
                const viewportHeight = window.visualViewport?.height || window.innerHeight;
                const safeBottom = viewportHeight - 12;
                if (rect.bottom > safeBottom || rect.top < 0) {
                    scrollTarget.scrollIntoView({
                        block: e.target.id === 'chat-input-field' ? 'end' : 'nearest',
                        behavior: 'auto'
                    });
                }
            });
        }, 220);
    });

    document.addEventListener('focusout', (e) => {
        if (!shouldHandle() || !isTextControl(e.target)) return;
        if (isForumHeavyKeyboardTarget(e.target)) return;
        scheduleAndroidViewportHeight(120);
        setTimeout(() => {
            // 原生 Android/PWA 的页面由固定视口管理，不再额外滚动整页，
            // 避免键盘收起时消息列表被浏览器短暂重定位；iOS 回拉保持原逻辑。
            const shouldResetDocumentScroll = isIOS || !isAndroidStandalone();
            if (shouldResetDocumentScroll && (window.scrollY !== 0 || document.documentElement.scrollTop !== 0 || document.body.scrollTop !== 0)) {
                window.scrollTo(0, 0);
            }

            const diaryWrapper = document.getElementById('diary-page-wrapper');
            if (diaryWrapper && diaryWrapper.scrollTop !== 0) {
                diaryWrapper.scrollTop = 0;
            }

            const diarySettingsModal = document.getElementById('diary-settings-modal');
            if (diarySettingsModal && diarySettingsModal.classList.contains('visible') && diarySettingsModal.scrollTop !== 0) {
                diarySettingsModal.scrollTop = 0;
            }
            scheduleAndroidViewportHeight();
        }, 80);
    });
}

initMobileKeyboardFixOptimized();



