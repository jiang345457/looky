import { AppState, db, DEFAULT_DESKTOP_ICON_NAME_COLOR, normalizeDesktopIconNameColor } from '../state.js';
import { UI, showDynamicIsland, customizableIcons, applyIconSetting } from '../ui.js'; 
import { compressImageDataUrl } from '../utils.js';

export   /* --- 3.8 屏幕设置 (壁纸 & 图标) --- */
  // 负责“屏幕设置”页面的逻辑，包括壁纸的上传/重置和应用图标的自定义
  function setupScreenSettings() {
    // 1. 获取元素
    const statusBar = document.querySelector('.status-bar');
    const toggle = document.getElementById('toggle-hide-status-bar');
    const appTopOffsetSlider = document.getElementById('app-top-offset-slider');
    const appTopOffsetVal = document.getElementById('app-top-offset-val');
    const appBottomOffsetSlider = document.getElementById('app-bottom-offset-slider');
    const appBottomOffsetVal = document.getElementById('app-bottom-offset-val');
    const desktopIconNameColorPicker = document.getElementById('desktop-icon-name-color-picker');
    const desktopIconNameColorVal = document.getElementById('desktop-icon-name-color-val');
    const desktopIconNameColorReset = document.getElementById('desktop-icon-name-color-reset');
    const toggleAppNames = document.getElementById('toggle-hide-app-names'); // 新增：获取隐藏应用名称开关
    const toggleFullscreen = document.getElementById('toggle-force-fullscreen'); // 新增：全屏开关
    const displayScaleSlider = document.getElementById('display-scale-slider');
    const displayScaleVal = document.getElementById('display-scale-val');
    const displayScaleDecrease = document.getElementById('display-scale-decrease');
    const displayScaleReset = document.getElementById('display-scale-reset');
    const displayScaleIncrease = document.getElementById('display-scale-increase');
    // 新增：自动插入一段安全隐藏文字的代码，防止你的桌面图标排版崩坏
    if (!document.getElementById('hide-app-names-style')) {
      const style = document.createElement('style');
      style.id = 'hide-app-names-style';
      style.textContent = '.hide-app-names .app-name { opacity: 0 !important; visibility: hidden !important; }';
      document.head.appendChild(style);
    }

    // 2. 初始化：读取保存的设置
    if (localStorage.getItem('isStatusBarHidden') === 'true') {
      statusBar.classList.add('hidden');
      if (toggle) toggle.checked = true;
    }
    const clampAppBarOffset = (value) => {
      const parsed = parseInt(value, 10);
      return Number.isNaN(parsed) ? 0 : Math.min(60, Math.max(-60, parsed));
    };
    let currentAppTopOffset = null;
    let currentAppBottomOffset = null;
    const applyAppBarOffsets = (topValue, bottomValue, persist = false) => {
      const topOffset = clampAppBarOffset(topValue);
      const bottomOffset = clampAppBarOffset(bottomValue);
      if (currentAppTopOffset !== topOffset) {
        currentAppTopOffset = topOffset;
        document.documentElement.style.setProperty('--app-top-offset', `${topOffset}px`);
      }
      if (currentAppBottomOffset !== bottomOffset) {
        currentAppBottomOffset = bottomOffset;
        document.documentElement.style.setProperty('--app-bottom-offset', `${bottomOffset}px`);
      }
      // 停用旧的整页偏移变量，避免旧样式再次把背景整体带走。
      document.documentElement.style.setProperty('--app-page-offset', '0px');
      document.documentElement.style.setProperty('--app-page-offset-pull-up', '0px');
      if (appTopOffsetSlider) appTopOffsetSlider.value = topOffset;
      if (appTopOffsetVal) appTopOffsetVal.textContent = `${topOffset}px`;
      if (appBottomOffsetSlider) appBottomOffsetSlider.value = bottomOffset;
      if (appBottomOffsetVal) appBottomOffsetVal.textContent = `${bottomOffset}px`;
      if (persist) {
        localStorage.setItem('appTopOffset', String(topOffset));
        localStorage.setItem('appBottomOffset', String(bottomOffset));
      }
    };
    let appBarOffsetFrame = 0;
    let pendingAppBarOffsets = null;
    const flushAppBarOffsetPreview = () => {
      appBarOffsetFrame = 0;
      if (pendingAppBarOffsets) applyAppBarOffsets(...pendingAppBarOffsets);
    };
    const scheduleAppBarOffsets = (topValue, bottomValue) => {
      const topOffset = clampAppBarOffset(topValue);
      const bottomOffset = clampAppBarOffset(bottomValue);
      pendingAppBarOffsets = [topOffset, bottomOffset];
      if (appTopOffsetSlider) appTopOffsetSlider.value = topOffset;
      if (appTopOffsetVal) appTopOffsetVal.textContent = `${topOffset}px`;
      if (appBottomOffsetSlider) appBottomOffsetSlider.value = bottomOffset;
      if (appBottomOffsetVal) appBottomOffsetVal.textContent = `${bottomOffset}px`;
      if (appBarOffsetFrame) return;
      appBarOffsetFrame = requestAnimationFrame(flushAppBarOffsetPreview);
    };
    const DISPLAY_SCALE_KEY = 'lookyDisplayScale';
    const DISPLAY_SCALE_MIN = 62.5;
    const DISPLAY_SCALE_MAX = 150;
    const DISPLAY_SCALE_STEP = 2.5;
    // 保持功能页面满高，分别调整顶栏、内容区和底栏，避免背景跟着移动。
    const appPageOffsetStyleId = 'app-page-offset-transform-style';
    if (!document.getElementById(appPageOffsetStyleId)) {
      const appPageOffsetStyle = document.createElement('style');
      appPageOffsetStyle.id = appPageOffsetStyleId;
      appPageOffsetStyle.textContent = `
        /* 页面外框和背景固定不动，只分别调整顶栏、内容区和底栏。 */
        html .app-page {
          top: 0 !important;
          height: 100% !important;
          transform: none !important;
        }
        /* 顶栏：普通功能页、聊天页和几个特殊页面的顶部导航。 */
        html .app-page > .app-header,
        html .app-page .chat-top-area,
        html .app-page .cl-app-header,
        html .app-page .oe-header,
        html .app-page .bonds-magazine-header,
        html .app-page .focus-top-nav,
        html .app-page > .float-back,
        html .app-page > .float-settings,
        html .app-page > .cp-back-btn,
        html .app-page > .floating-back-btn,
        html .app-page .quiz-header-switch,
        html .app-page .music-top-bar,
        html .app-page .npc-fw-header,
        html .app-page .video-call-top-info,
        html .app-page .nf-header,
        html .app-page .moments-header,
        html .app-page .ifline-header,
        html .app-page .gallery-header,
        html .app-page .gallery-settings-header,
        html .app-page .ls-header,
        html .app-page .cp-phone-header,
        html .app-page .cp-detail-header,
        html .app-page .cp-memo-header,
        html .app-page .cp-memo-detail-header,
        html .app-page .cp-shop-header,
        html .app-page .browser-detail-header,
        html .app-page .st-art-header,
        html .app-page .cgt-header,
        html .app-page .cs-invite-header,
        html .app-page .cs-floating-header,
        html .app-page .rm-floating-header,
        html .app-page .voice-call-header,
        html .app-page .page-header,
        html .app-page .forum-app-header,
        html .app-page .rc-floating-header,
        html .app-page .anniv-header-bar,
        html .app-page #life-top-bar,
        html .app-page .food-header,
        html .app-page .ride-header,
        html .app-page .shop-header,
        html .app-page .shop-detail-header,
        html .app-page .memory-detail-header,
        html .app-page .cl-hero,
        html .app-page .cl-detail-hero,
        html .app-page .ca-hero {
          translate: 0 var(--app-top-offset, 0px);
        }
        /* 世界书不是 app-page，而是独立的 .screen 容器。 */
        html #world-book-screen > .page-header,
        html #world-book-editor-screen > .page-header {
          translate: 0 var(--app-top-offset, 0px);
        }
        /* 世界书的正文紧跟顶栏，顶栏移动后同步补回正文占用的空间。 */
        html #world-book-screen > .wb-body-wrapper,
        html #world-book-editor-screen > .page-content {
          margin-top: var(--app-top-offset, 0px);
        }
        /* 论坛各页面的正文区域同步顶栏偏移，避免顶栏移动后留下空白。 */
        html #page-forum:not([data-forum-view="profile"]):not([data-forum-view="circles"]):not([data-forum-view="circleDetail"]) > .forum-main,
        html #page-forum-user-profile > .forum-main,
        html #page-forum-compose > .forum-main {
          margin-top: var(--app-top-offset, 0px);
        }
        /* 这些顶栏在滚动内容内部，使用布局间距移动，后面的内容会自然跟随。 */
        html #page-forum-login .forum-login-topline,
        html #page-forum-create .forum-create-header,
        html #page-forum-ordinary-npc-avatars .forum-create-header,
        html #page-forum-messages .forum-messages-hero,
        html #page-forum-messages .forum-messages-thread-header,
        html #page-forum[data-forum-view="profile"] .profile-top-switcher,
        html #page-forum[data-forum-view="circleDetail"] .forum-circle-detail-hero {
          margin-top: var(--app-top-offset, 0px);
        }
        html #page-forum .forum-discover-header,
        html #page-forum-post-detail .post-detail-header {
          /* 使用 transform 兼容安卓 WebView，sticky 顶栏也能稳定响应偏移。 */
          transform: translateY(var(--app-top-offset, 0px)) !important;
          -webkit-transform: translateY(var(--app-top-offset, 0px)) !important;
        }
        html #page-forum[data-forum-view="circles"] .forum-discover-body,
        html #page-forum-post-detail .post-detail-body {
          margin-top: var(--app-top-offset, 0px);
        }
        /* 下列页面的顶栏和正文不是同一种 HTML 结构，需要分别补齐正文位置。 */
        html #page-settings-screen > .app-content,
        html #page-gallery > .gallery-search-container,
        html #page-gallery-group-detail > .image-grid-container,
        html #page-character-hub .cl-content,
        html #page-character-library .cl-content,
        html #page-character-detail .cl-detail-content,
        html #page-character-add .ca-content {
          margin-top: var(--app-top-offset, 0px) !important;
        }
        /* 角色库和音乐页的顶栏包含 sticky/floating 元素，使用 transform 兼容安卓 WebView。 */
        html #page-character-hub .cl-app-header,
        html #page-character-library .cl-hero,
        html #page-character-library .cl-page-shell > .cl-back-button,
        html #page-character-detail .cl-detail-hero,
        html #page-character-add .ca-hero,
        html #page-character-add .ca-shell > .cl-back-button,
        html #page-memo .music-floating-actions,
        html #music-group-detail-view .music-floating-actions,
        html #music-fullscreen-layer .music-top-bar {
          translate: none !important;
          transform: translateY(var(--app-top-offset, 0px)) !important;
          -webkit-transform: translateY(var(--app-top-offset, 0px)) !important;
        }
        /* 音乐页的内容紧跟悬浮顶栏，顶栏上移时首段内容同步延展。 */
        html #page-memo > #music-layout-container > .premium-lib-header,
        html #music-group-detail-view > .music-group-hero {
          margin-top: var(--app-top-offset, 0px) !important;
        }
        html #page-forum[data-forum-view="circleDetail"] .forum-circle-detail-topbar {
          translate: 0 var(--app-top-offset, 0px);
        }
        html #page-forum-login .forum-login-hero {
          margin-top: 62px;
        }
         html .app-page > .app-content,
         html .app-page > .chat-main-area > .app-content,
         html .app-page > .lp-content-wrapper {
           margin-top: var(--app-top-offset, 0px);
           margin-bottom: var(--app-bottom-offset, 0px);
         }
        /* 底栏：只移动底部栏本身，内容区背景不会被带动。 */
        html .app-page .chat-bottom-nav,
         html .app-page .lp-floating-nav,
         html .app-page .shop-bottom-nav,
         html .app-page .sms-input-area,
        html .app-page .cp-detail-input-area,
        html .app-page .npc-fw-input-area,
        html .app-page .offline-chat-input-container,
        html .app-page .music-bottom-panel,
        html .app-page .focus-bottom-panel,
        html .app-page .quiz-bottom-controls,
        html .app-page .ifline-footer,
        html .app-page .cgt-footer-input,
        html .app-page .flight-actions-footer,
        html .app-page .train-actions-footer,
        html .app-page .ca-footer,
        html .app-page .cp-magazine-footer,
        html .app-page .cp-dock-nav,
        html .app-page .voice-call-footer,
        html .app-page .video-call-bottom-controls,
        html .app-page .forum-bottom-nav,
        html .app-page .forum-messages-bottom-nav,
        html .app-page .food-detail-footer,
        html .app-page .add-food-footer,
        html .app-page .cart-footer,
        html .app-page .specs-footer,
        html .app-page .shop-detail-footer,
        html .app-page .shop-specs-footer,
        html .app-page .transfer-actions-footer,
        html .app-page .cs-qa-footer,
        html .app-page .rm-bottom-actions,
        html .app-page .rm-settings-footer,
        html .app-page .clean-footer,
        html .app-page .config-footer,
        html .app-page .buy-footer {
           translate: 0 calc(var(--app-bottom-offset, 0px) - var(--looky-native-navigation-bar-height, 0px));
         }
         /* 聊天输入栏自身由 SCSS 负责原生导航栏占位，只保留手动底栏偏移。 */
         html .app-page .chat-input-container {
           translate: 0 var(--app-bottom-offset, 0px);
         }
         /* 论坛详情输入栏由论坛 SCSS 用 bottom 处理系统导航栏，这里只保留手动偏移。 */
         html .app-page .forum-detail-comment-bar {
           translate: 0 var(--app-bottom-offset, 0px);
         }
         /* 聊天详情的输入栏已占用导航栏空间，消息区不再重复增加底部间距。 */
         html.looky-native body.android-viewport-sync #page-chat-detail > .chat-detail-content {
           margin-bottom: var(--app-bottom-offset, 0px);
         }
         /* 主屏幕不属于 .app-page，也要让 Dock 和页码指示器避开三键导航栏。 */
         html.looky-native body.android-viewport-sync #home-screen-wrapper .app-dock {
           bottom: calc(25px + var(--looky-native-navigation-bar-height, 0px));
         }
         html.looky-native body.android-viewport-sync #home-screen-wrapper .home-page-indicator {
           bottom: calc(116px + var(--looky-native-navigation-bar-height, 0px));
         }
        /* 钱包页面不参与顶栏的上下移动，保留它自己的安全区处理。 */
        html .app-page > .lp-header {
          translate: none !important;
        }
        html .app-page .cp-wallet-topbar {
          translate: none !important;
        }
        html .app-page > .lp-content-wrapper {
          margin-top: 0 !important;
        }
      `;
      document.head.appendChild(appPageOffsetStyle);
    }
    const legacyAppPageOffset = localStorage.getItem('appPageOffset');
    const savedAppTopOffset = localStorage.getItem('appTopOffset') ?? legacyAppPageOffset;
    const savedAppBottomOffset = localStorage.getItem('appBottomOffset') ?? legacyAppPageOffset;
    applyAppBarOffsets(savedAppTopOffset, savedAppBottomOffset);
    const clampDisplayScale = (value) => {
      const parsed = parseFloat(value);
      if (Number.isNaN(parsed)) return 100;
      return Math.min(DISPLAY_SCALE_MAX, Math.max(DISPLAY_SCALE_MIN, parsed));
    };
    const formatDisplayScale = (value) => {
      const rounded = Math.round(value * 10) / 10;
      return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
    };
    const applyDisplayScale = (value, persist = false) => {
      const percent = clampDisplayScale(value);
      const scale = percent / 100;
      const inverseSize = `${100 / scale}%`;
      const contentWidth = `${Math.min(100, percent)}%`;

      window.__lookyDisplayScale = scale;
      document.documentElement.style.setProperty('--looky-display-scale', String(scale));
      document.documentElement.style.setProperty('--looky-display-width', inverseSize);
      document.documentElement.style.setProperty('--looky-display-height', inverseSize);
      document.documentElement.style.setProperty('--looky-display-content-width', contentWidth);

      if (displayScaleSlider) displayScaleSlider.value = String(percent);
      if (displayScaleVal) displayScaleVal.textContent = formatDisplayScale(percent);
      if (persist) localStorage.setItem(DISPLAY_SCALE_KEY, String(percent));
    };
    const nudgeDisplayScale = (delta) => {
      const current = clampDisplayScale(displayScaleSlider?.value || localStorage.getItem(DISPLAY_SCALE_KEY));
      applyDisplayScale(current + delta, true);
    };
    applyDisplayScale(localStorage.getItem(DISPLAY_SCALE_KEY));
    const applyDesktopIconNameColor = (value, persist = false) => {
      const color = normalizeDesktopIconNameColor(value);
      AppState.desktopIconNameColor = color;
      document.documentElement.style.setProperty('--desktop-icon-name-color', color);
      if (desktopIconNameColorPicker) desktopIconNameColorPicker.value = color;
      if (desktopIconNameColorVal) desktopIconNameColorVal.textContent = color.toUpperCase();
      if (persist) {
        db.appData.put({ key: 'desktopIconNameColor', value: color }).catch(() => {});
      }
    };
    applyDesktopIconNameColor(AppState.desktopIconNameColor || DEFAULT_DESKTOP_ICON_NAME_COLOR);
    // 新增：读取隐藏应用名称的记录
    if (localStorage.getItem('isAppNamesHidden') === 'true') {
      document.body.classList.add('hide-app-names');
      if (toggleAppNames) toggleAppNames.checked = true;
    }
    // 新增：读取全屏模式的记录
    if (localStorage.getItem('isForceFullscreen') === 'true') {
      document.body.classList.add('force-fullscreen');
      if (toggleFullscreen) toggleFullscreen.checked = true;
    }
    // 3. 监听开关点击

    if (toggle) {
      toggle.addEventListener('change', (e) => {
        if (e.target.checked) {
          statusBar.classList.add('hidden');
          localStorage.setItem('isStatusBarHidden', 'true');
        } else {
          statusBar.classList.remove('hidden');
          localStorage.setItem('isStatusBarHidden', 'false');
        }
      });
    }

    const bindAppBarOffsetSlider = (slider) => {
      if (!slider) return;
      slider.addEventListener('input', () => scheduleAppBarOffsets(
        appTopOffsetSlider?.value,
        appBottomOffsetSlider?.value
      ));
      slider.addEventListener('change', () => {
        pendingAppBarOffsets = null;
        if (appBarOffsetFrame) cancelAnimationFrame(appBarOffsetFrame);
        appBarOffsetFrame = 0;
        applyAppBarOffsets(
          appTopOffsetSlider?.value,
          appBottomOffsetSlider?.value,
          true
        );
      });
    };
    bindAppBarOffsetSlider(appTopOffsetSlider);
    bindAppBarOffsetSlider(appBottomOffsetSlider);

    if (displayScaleSlider) {
      displayScaleSlider.addEventListener('input', (e) => applyDisplayScale(e.target.value));
      displayScaleSlider.addEventListener('change', (e) => {
        applyDisplayScale(e.target.value, true);
        showDynamicIsland('整体缩放已保存');
      });
    }

    if (displayScaleDecrease) {
      displayScaleDecrease.addEventListener('click', () => {
        nudgeDisplayScale(-DISPLAY_SCALE_STEP);
        showDynamicIsland('整体缩放已保存');
      });
    }

    if (displayScaleReset) {
      displayScaleReset.addEventListener('click', () => {
        applyDisplayScale(100, true);
        showDynamicIsland('整体缩放已恢复默认');
      });
    }

    if (displayScaleIncrease) {
      displayScaleIncrease.addEventListener('click', () => {
        nudgeDisplayScale(DISPLAY_SCALE_STEP);
        showDynamicIsland('整体缩放已保存');
      });
    }

    if (desktopIconNameColorPicker) {
      desktopIconNameColorPicker.addEventListener('input', (e) => applyDesktopIconNameColor(e.target.value));
      desktopIconNameColorPicker.addEventListener('change', (e) => applyDesktopIconNameColor(e.target.value, true));
    }

    if (desktopIconNameColorReset) {
      desktopIconNameColorReset.addEventListener('click', () => {
        applyDesktopIconNameColor(DEFAULT_DESKTOP_ICON_NAME_COLOR, true);
        showDynamicIsland('桌面图标名称颜色已重置');
      });
    }

    // 新增：监听“隐藏应用名称”开关的点击动作
    if (toggleAppNames) {
      toggleAppNames.addEventListener('change', (e) => {
        if (e.target.checked) {
          document.body.classList.add('hide-app-names'); // 给整个页面加上隐藏指令
          localStorage.setItem('isAppNamesHidden', 'true'); // 存入本地记忆
        } else {
          document.body.classList.remove('hide-app-names'); // 撤销隐藏指令
          localStorage.setItem('isAppNamesHidden', 'false');
        }
      });
    }
    // 新增：监听“全屏模式”开关
    if (toggleFullscreen) {
      toggleFullscreen.addEventListener('change', (e) => {
        if (e.target.checked) {
          document.body.classList.add('force-fullscreen');
          localStorage.setItem('isForceFullscreen', 'true');
        } else {
          document.body.classList.remove('force-fullscreen');
          localStorage.setItem('isForceFullscreen', 'false');
        }
      });
    }
        // ▼▼▼ 新增：API切换悬浮球开关逻辑 ▼▼▼
    const toggleApiBall = document.getElementById('toggle-api-floating-ball');
    const apiBallStyleItem = document.getElementById('api-floating-ball-style-item');
    const apiFloatingBall = document.getElementById('api-floating-ball');
    const apiBallUpload = document.getElementById('api-ball-upload');
    const apiBallReset = document.getElementById('api-ball-reset');
    const apiBallDefaultIcon = document.getElementById('api-ball-default-icon');

    // 初始化显示状态
    if (localStorage.getItem('isApiBallEnabled') === 'true') {
      if (toggleApiBall) toggleApiBall.checked = true;
      if (apiBallStyleItem) apiBallStyleItem.style.display = 'flex';
      if (apiFloatingBall) apiFloatingBall.style.display = 'flex';
    } else {
      if (apiFloatingBall) apiFloatingBall.style.display = 'none';
    }
    
    // 初始化背景图
    db.appData.get('apiBallBackground').then(async record => {
      let savedBallBg = record?.value;
      if (!savedBallBg) {
        try {
          savedBallBg = localStorage.getItem('apiBallBackground') || '';
          if (savedBallBg) {
            await db.appData.put({ key: 'apiBallBackground', value: savedBallBg });
            localStorage.removeItem('apiBallBackground');
          }
        } catch (error) {
          console.warn('迁移旧悬浮球图片失败:', error);
        }
      }
      if (savedBallBg && apiFloatingBall) {
        apiFloatingBall.style.backgroundImage = `url(${savedBallBg})`;
        apiFloatingBall.style.border = 'none';
        if (apiBallDefaultIcon) apiBallDefaultIcon.style.display = 'none';
      }
    }).catch(error => console.warn('读取悬浮球图片失败:', error));

    if (toggleApiBall) {
      toggleApiBall.addEventListener('change', (e) => {
        if (e.target.checked) {
          localStorage.setItem('isApiBallEnabled', 'true');
          if (apiBallStyleItem) apiBallStyleItem.style.display = 'flex';
          if (apiFloatingBall) apiFloatingBall.style.display = 'flex';
        } else {
          localStorage.setItem('isApiBallEnabled', 'false');
          if (apiBallStyleItem) apiBallStyleItem.style.display = 'none';
          
          // ▼▼▼ 修改开始：关闭开关时重置悬浮球位置 ▼▼▼
          if (apiFloatingBall) {
            apiFloatingBall.style.display = 'none';
            // 清除内联定位样式，让它回到CSS默认位置
            apiFloatingBall.style.left = '';
            apiFloatingBall.style.top = '';
            apiFloatingBall.style.right = '';
            apiFloatingBall.style.bottom = '';
            apiFloatingBall.style.transform = '';
          }
          // 清除本地缓存中记住的拖拽坐标
          localStorage.removeItem('apiFloatingBallPosition');
          // ▲▲▲ 修改结束 ▲▲▲
        }
      });
    }

    if (apiBallUpload) {
      apiBallUpload.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = async (event) => {
            const res = event.target.result;
            await db.appData.put({ key: 'apiBallBackground', value: res });
            if (apiFloatingBall) {
              apiFloatingBall.style.backgroundImage = `url(${res})`;
              apiFloatingBall.style.border = 'none';
              if (apiBallDefaultIcon) apiBallDefaultIcon.style.display = 'none';
            }
            showDynamicIsland('悬浮球样式已更新');
          };
          reader.readAsDataURL(file);
        }
        e.target.value = '';
      });
    }

    if (apiBallReset) {
      apiBallReset.addEventListener('click', async () => {
        await db.appData.delete('apiBallBackground');
        if (apiFloatingBall) {
          apiFloatingBall.style.backgroundImage = 'none';
          apiFloatingBall.style.border = '1px solid rgba(0,0,0,0.05)';
          if (apiBallDefaultIcon) apiBallDefaultIcon.style.display = 'block';
        }
        showDynamicIsland('悬浮球已恢复默认');
      });
    }
     // ▼▼▼ 新增：桌面排版微调逻辑 (高性能 CSS 变量版) ▼▼▼
    const homeScaleSlider = document.getElementById('home-scale-slider');
    const homeScaleVal = document.getElementById('home-scale-val');
    const homeOffsetSlider = document.getElementById('home-offset-slider');
    const homeOffsetVal = document.getElementById('home-offset-val');
    const homeGapSlider = document.getElementById('home-gap-slider');
    const homeGapVal = document.getElementById('home-gap-val');

    const syncPage2Toggle = document.getElementById('sync-page2-toggle');
    const page2Controls = document.getElementById('page2-layout-controls');
    const page2ScaleSlider = document.getElementById('page2-scale-slider');
    const page2ScaleVal = document.getElementById('page2-scale-val');
    const page2OffsetSlider = document.getElementById('page2-offset-slider');
    const page2OffsetVal = document.getElementById('page2-offset-val');
    const page2GapSlider = document.getElementById('page2-gap-slider');
    const page2GapVal = document.getElementById('page2-gap-val');

    // 性能优化 1：静态样式只注入一次，绑定到 CSS 变量
    let styleEl = document.getElementById('home-layout-adjust-style');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'home-layout-adjust-style';
        document.head.appendChild(styleEl);
    }
    styleEl.textContent = `
            /* 终极优化：在整页容器开启3D空间并强制提前光栅化，拒绝滑动时才计算缩放导致的慢一拍 */
            #home-screen-wrapper .home-page {
                transform: translateZ(0) !important;
                transform-style: preserve-3d !important;
                will-change: transform !important;
                backface-visibility: hidden !important;
            }
            
            /* 第一页的控制 */
            #home-screen-wrapper .page-1 > .main-content-area {
                width: var(--looky-display-content-width, 100%) !important;
                max-width: 100% !important;
                margin-left: auto !important;
                margin-right: auto !important;
                transform: translateY(var(--p1-offset, 0px)) !important;
                transform-origin: top center !important;
                backface-visibility: hidden !important;
            }
            #home-screen-wrapper .page-1 > .top-decorative-wrapper {
                transform: translateY(var(--p1-offset, 0px)) !important;
                transform-origin: top center !important;
                backface-visibility: hidden !important;
            }
            #home-screen-wrapper .page-1 .top-section .large-photo-widget,
            #home-screen-wrapper .page-1 .top-section .main-apps-grid .app-icon,
            #home-screen-wrapper .page-1 .middle-section .secondary-apps-grid .app-icon,
            #home-screen-wrapper .page-1 .middle-section .ticket-widget-wrapper {
                transform: scale(var(--p1-scale, 1)) !important;
                transform-origin: center center !important;
                backface-visibility: hidden !important;
            }
            #home-screen-wrapper .middle-section {
                margin-top: var(--p1-gap, 55px) !important;
            }

            /* 第二页的独立控制 */
            #home-page-2 .app-icon,
            #home-page-2 .top-widget-card,
            #home-page-2 .colorful-widget-wrapper,
            #home-page-2 .instagram-widget-wrapper {
                transform: scale(var(--p2-scale, 1)) !important;
                transform-origin: center center !important;
                backface-visibility: hidden !important;
            }
            #home-page-2 > * {
                transform: translateY(var(--p2-offset, 0px)) !important;
            }
            #home-page-2 > .main-content-area + div {
                margin-top: var(--p2-gap, 10px) !important;
            }
        `;

    // 性能优化 2：拖动滑块时，仅修改外层容器的自定义变量，彻底避免页面重排卡顿
    const updateHomeLayoutStyles = (scale, offset, gap, sync, p2Scale, p2Offset, p2Gap) => {
        let actualP2Scale = sync ? scale : p2Scale;
        let actualP2Offset = sync ? offset : p2Offset;

        const wrapper = document.getElementById('home-screen-wrapper');
        if (wrapper) {
            wrapper.style.setProperty('--p1-scale', scale / 100);
            wrapper.style.setProperty('--p1-offset', offset + 'px');
            wrapper.style.setProperty('--p1-gap', gap + 'px');
            wrapper.style.setProperty('--p2-scale', actualP2Scale / 100);
            wrapper.style.setProperty('--p2-offset', actualP2Offset + 'px');
            wrapper.style.setProperty('--p2-gap', p2Gap + 'px');
        }

        if (homeScaleVal) homeScaleVal.textContent = scale + '%';
        if (homeOffsetVal) homeOffsetVal.textContent = offset + 'px';
        if (homeGapVal) homeGapVal.textContent = gap + 'px';
        if (page2ScaleVal) page2ScaleVal.textContent = p2Scale + '%';
        if (page2OffsetVal) page2OffsetVal.textContent = p2Offset + 'px';
        if (page2GapVal) page2GapVal.textContent = p2Gap + 'px';
        
        if (page2Controls) {
            page2Controls.style.display = sync ? 'none' : 'flex';
        }
    };
    let homeLayoutFrame = 0;
    let pendingHomeLayoutArgs = null;
    const scheduleHomeLayoutStyles = (...args) => {
        pendingHomeLayoutArgs = args;
        if (homeLayoutFrame) return;
        homeLayoutFrame = requestAnimationFrame(() => {
            homeLayoutFrame = 0;
            if (pendingHomeLayoutArgs) {
                updateHomeLayoutStyles(...pendingHomeLayoutArgs);
            }
        });
    };
    // 初始化读取数据 (增加去数据库读取的步骤，防止刷新重置)
    const initHomeLayout = async () => {
        const dbData = await db.appData.get('homeLayout');
        if (dbData && dbData.value) AppState.homeLayout = dbData.value;
        const savedHomeLayout = AppState.homeLayout || { scale: 100, offset: 0, gap: 55, syncPage2: true, page2Scale: 100, page2Offset: 0, page2Gap: 10 };
        const initialGap = savedHomeLayout.gap !== undefined ? savedHomeLayout.gap : 55;
        const isSync = savedHomeLayout.syncPage2 !== undefined ? savedHomeLayout.syncPage2 : true;
        const initialP2Scale = savedHomeLayout.page2Scale !== undefined ? savedHomeLayout.page2Scale : 100;
        const initialP2Offset = savedHomeLayout.page2Offset !== undefined ? savedHomeLayout.page2Offset : 0;
        const initialP2Gap = savedHomeLayout.page2Gap !== undefined ? savedHomeLayout.page2Gap : 10;
        
        if (homeScaleSlider) homeScaleSlider.value = savedHomeLayout.scale;
        if (homeOffsetSlider) homeOffsetSlider.value = savedHomeLayout.offset;
        if (homeGapSlider) homeGapSlider.value = initialGap;
        if (syncPage2Toggle) syncPage2Toggle.checked = isSync;
        if (page2ScaleSlider) page2ScaleSlider.value = initialP2Scale;
        if (page2OffsetSlider) page2OffsetSlider.value = initialP2Offset;
        if (page2GapSlider) page2GapSlider.value = initialP2Gap;
        
        updateHomeLayoutStyles(savedHomeLayout.scale, savedHomeLayout.offset, initialGap, isSync, initialP2Scale, initialP2Offset, initialP2Gap);
    };
    initHomeLayout();
    // 保存设置的函数
    const saveHomeLayout = async () => {
        const scale = parseInt(homeScaleSlider.value, 10);
        const offset = parseInt(homeOffsetSlider.value, 10);
        const gap = parseInt(homeGapSlider.value, 10);
        const syncPage2 = syncPage2Toggle.checked;
        const page2Scale = parseInt(page2ScaleSlider.value, 10);
        const page2Offset = parseInt(page2OffsetSlider.value, 10);
        const page2Gap = parseInt(page2GapSlider.value, 10);

        AppState.homeLayout = { scale, offset, gap, syncPage2, page2Scale, page2Offset, page2Gap };
        await db.appData.put({ key: 'homeLayout', value: AppState.homeLayout });
        updateHomeLayoutStyles(scale, offset, gap, syncPage2, page2Scale, page2Offset, page2Gap);
    };

    // 事件绑定封装
    const bindSliderEvent = (element) => {
        if (element) {
            if (element.type === 'checkbox') {
                element.addEventListener('change', saveHomeLayout);
            } else {
                element.addEventListener('input', () => scheduleHomeLayoutStyles(
                    homeScaleSlider.value, homeOffsetSlider.value, homeGapSlider.value,
                    syncPage2Toggle.checked, page2ScaleSlider.value, page2OffsetSlider.value, page2GapSlider.value
                ));
                element.addEventListener('change', saveHomeLayout);
            }
        }
    };
    
    bindSliderEvent(homeScaleSlider);
    bindSliderEvent(homeOffsetSlider);
    bindSliderEvent(homeGapSlider);
    bindSliderEvent(syncPage2Toggle);
    bindSliderEvent(page2ScaleSlider);
    bindSliderEvent(page2OffsetSlider);
    bindSliderEvent(page2GapSlider);
    // ▲▲▲ 新增结束 ▲▲▲
    const handleWallpaperUpload = async (event, targetKey) => {
      const file = event.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = async (e) => {
          const imageUrl = await compressImageDataUrl(e.target.result);
          AppState.wallpapers[targetKey] = imageUrl;
          const dbKey = (targetKey === 'home') ? 'homeWallpaper' : (targetKey === 'system') ? 'systemUiBackground' : 'appContentBackground';
          await db.appData.put({
            key: dbKey,
            value: imageUrl
          });

    if (targetKey === 'home') {
    const layer = document.getElementById('home-wallpaper-layer');
    // 如果找到了新层就设在新层上，没找到(比如HTML缓存)就兜底设在老地方
    if (layer) layer.style.backgroundImage = `url(${imageUrl})`;
    else UI.homeScreenWrapper.style.backgroundImage = `url(${imageUrl})`;
    document.dispatchEvent(new CustomEvent('wallpaperChanged', { detail: { target: 'home' } }));
  }
      else if (targetKey === 'system') UI.phoneScreen.style.backgroundImage = `url(${imageUrl})`;
      else if (targetKey === 'app') {
        // 同时选择所有页面的 .app-content 和我们新加的 .chat-main-area
        document.querySelectorAll('.app-content, .chat-main-area').forEach(el => {
          // 如果这个元素不是聊天页里的内容区，就给它设置背景
          // 这样就完美避开了聊天页的 .app-content，让它保持透明
          if (!el.closest('#page-chat > .chat-main-area > .app-content')) {
            el.style.backgroundImage = `url(${imageUrl})`;
          }
        });
      }


          showDynamicIsland('壁纸已更换');
        };
        reader.readAsDataURL(file);
      }
    };
    UI.homeWallpaperUpload.addEventListener('change', (e) => handleWallpaperUpload(e, 'home'));
    UI.systemUiBgUpload.addEventListener('change', (e) => handleWallpaperUpload(e, 'system'));
    UI.appContentBgUpload.addEventListener('change', (e) => handleWallpaperUpload(e, 'app'));
    // --- 【重构】字体设置逻辑 (高效稳定版) ---
    if (UI.fontFileUpload && UI.fontUrlInput && UI.saveFontButton) {
        window.__screenFontSettingsHandled = true;
        const FONT_STYLE_ID = 'custom-global-font'; // 给我们的字体样式一个唯一的“身份证号”
        const FONT_SIZE_KEY = 'customImportedFontSize';
        const builtinFontSelect = document.getElementById('builtin-font-select');
        const clearFontButton = document.getElementById('clear-font-button');
        const importedFontSizeSlider = document.getElementById('imported-font-size-slider');
        const importedFontSizeVal = document.getElementById('imported-font-size-val');

        const clampPercent = (value, fallback, min, max) => {
            const num = parseInt(value, 10);
            if (Number.isNaN(num)) return fallback;
            return Math.min(max, Math.max(min, num));
        };
        const getImportedFontPercent = () => clampPercent(importedFontSizeSlider?.value || localStorage.getItem(FONT_SIZE_KEY), 100, 80, 130);
        const syncImportedFontSizeUI = (percent, persist = false) => {
            if (importedFontSizeSlider) importedFontSizeSlider.value = percent;
            if (importedFontSizeVal) importedFontSizeVal.textContent = `${percent}%`;
            if (persist) localStorage.setItem(FONT_SIZE_KEY, String(percent));
            const nativeScale = document.documentElement.classList.contains('looky-native') ? 0.9 : 1;
            const scale = (percent / 100) * nativeScale;
            const root = document.documentElement;
            root.style.setProperty('--looky-font-scale', String(scale));
            root.style.setProperty('--looky-text-size-adjust', `${percent}%`);
            [
                ['--font-xs', 12],
                ['--font-sm', 14],
                ['--font-md', 16],
                ['--font-lg', 18],
                ['--font-xl', 22]
            ].forEach(([name, base]) => {
                root.style.setProperty(name, `${Math.round(base * scale * 100) / 100}px`);
            });
            [
                ['--looky-font-xxs', 9],
                ['--looky-font-xs', 10],
                ['--looky-font-sm', 11],
                ['--looky-font-md', 12],
                ['--looky-font-lg', 13],
                ['--looky-font-xl', 14]
            ].forEach(([name, base]) => {
                root.style.setProperty(name, `${Math.round(base * scale * 100) / 100}px`);
            });
        };
        const currentFontState = {
            sourceUrl: '',
            resolvedUrl: '',
        };
        let fontSizeApplyTimer = null;
        const DEFAULT_FONT_STYLE_ID = 'default-global-font-size-adjust';
        const DEFAULT_FONT_FAMILY = 'LookyDefaultAdjustedFont';
        let currentDefaultFontPercent = 100;
        const ANDROID_FONT_SIZE_STYLE_ID = 'android-font-size-adjust-fallback';
        const androidFontSizeOriginalStyles = new Map();
        let androidFontSizeFrame = null;
        let androidFontSizeRetryTimer = null;
        let androidFontSizePercent = 100;
        let androidFontSizeAppliedRoot = null;
        let androidFontSizeAppliedPercent = 100;
        const androidFontSizeRootIds = new WeakMap();
        let nextAndroidFontSizeRootId = 1;
        const shouldUseAndroidFontSizeFallback = () => false;
        const fontSizePxValueRe = /^\s*(\d*\.?\d+)px\s*$/i;
        const toLookyScaledFontSize = function (value) {
            if (!value) return value;
            if (value.indexOf('var(--looky-font-scale') !== -1 || value.indexOf('calc(') !== -1) return value;
            const match = value.match(fontSizePxValueRe);
            if (!match) return value;
            return 'calc(' + match[1] + 'px * var(--looky-font-scale, 1))';
        };
        const scaleCssFontSizeText = function (cssText) {
            if (typeof cssText !== 'string' || cssText.indexOf('font-size') === -1) return cssText || '';
            return cssText.replace(
                /font-size\s*:\s*(\d*\.?\d+)px(\s*!important)?/gi,
                function (_full, size, important) {
                    return 'font-size: calc(' + size + 'px * var(--looky-font-scale, 1))' + (important || '');
                }
            );
        };
        window.__lookyScaleFontSizeCssText = scaleCssFontSizeText;
        const scaleFontSizeDeclaration = function (style) {
            if (!style || typeof style.getPropertyValue !== 'function') return;
            const value = style.getPropertyValue('font-size');
            const scaledValue = toLookyScaledFontSize(value);
            if (scaledValue && scaledValue !== value) {
                style.setProperty('font-size', scaledValue, style.getPropertyPriority('font-size'));
            }
        };
        const scaleFontSizeRules = function (rules) {
            if (!rules) return;
            Array.from(rules).forEach(rule => {
                scaleFontSizeDeclaration(rule.style);
                if (rule.cssRules) {
                    try {
                        scaleFontSizeRules(rule.cssRules);
                    } catch (error) {}
                }
            });
        };
        const scaleDocumentFontSizeRules = function () {
            Array.from(document.styleSheets).forEach(sheet => {
                try {
                    scaleFontSizeRules(sheet.cssRules);
                } catch (error) {}
            });
        };
        const scaleInlineFontSizeElement = function (el) {
            if (!(el instanceof HTMLElement)) return;
            scaleFontSizeDeclaration(el.style);
        };
        const scaleInlineFontSizesIn = function (root) {
            if (!(root instanceof Element)) return;
            scaleInlineFontSizeElement(root);
            if (root.querySelectorAll) {
                Array.from(root.querySelectorAll('[style*="font-size"]')).forEach(scaleInlineFontSizeElement);
            }
        };
        const installGlobalFontSizeScaling = function () {
            if (window.__lookyGlobalFontSizeScalingInstalled) return;
            window.__lookyGlobalFontSizeScalingInstalled = true;
            let cssFrame = 0;
            let inlineFrame = 0;
            const inlineRoots = new Set();
            const scheduleCssScale = function () {
                if (cssFrame) return;
                cssFrame = requestAnimationFrame(() => {
                    cssFrame = 0;
                    scaleDocumentFontSizeRules();
                });
            };
            const scheduleInlineScale = function (root) {
                if (root instanceof Element) inlineRoots.add(root);
                if (inlineFrame) return;
                inlineFrame = requestAnimationFrame(() => {
                    inlineFrame = 0;
                    inlineRoots.forEach(scaleInlineFontSizesIn);
                    inlineRoots.clear();
                });
            };
            scaleDocumentFontSizeRules();
            scaleInlineFontSizesIn(document.documentElement);
            new MutationObserver(function (mutations) {
                mutations.forEach(mutation => {
                    if (mutation.type === 'attributes') {
                        const styleAttr = mutation.target && mutation.target.getAttribute ? mutation.target.getAttribute('style') : '';
                        if (styleAttr && styleAttr.indexOf('font-size') !== -1) {
                            scheduleInlineScale(mutation.target);
                        }
                        return;
                    }
                    if (mutation.target instanceof HTMLStyleElement) scheduleCssScale();
                    mutation.addedNodes.forEach(node => {
                        if (!(node instanceof Element)) return;
                        if (node.matches('style, link[rel="stylesheet"]') || node.querySelector('style, link[rel="stylesheet"]')) {
                            scheduleCssScale();
                        }
                        if (node.matches('[style*="font-size"]') || (node.querySelector && node.querySelector('[style*="font-size"]'))) {
                            scheduleInlineScale(node);
                        }
                    });
                });
            }).observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style']
            });
        };
        const getVisibleFontSizeRoots = () => {
            const roots = [];
            const homeScreen = document.getElementById('home-screen-wrapper');
            const activePage = Array.from(document.querySelectorAll('.app-page')).find(page => {
                if (page.style.display === 'none') return false;
                return getComputedStyle(page).display !== 'none';
            });
            if (homeScreen && getComputedStyle(homeScreen).display !== 'none') {
                roots.push(homeScreen);
            }
            if (activePage) roots.push(activePage);
            document.querySelectorAll('.modal-overlay, .image-gen-overlay, .image-gen-viewer, .action-popover, .message-action-popover, .action-menu-popover, .privacy-sheet-overlay, .music-bottom-sheet-overlay, .forum-sheet-overlay').forEach(el => {
                if (!roots.includes(el)) roots.push(el);
            });
            if (roots.length === 0) {
                roots.push(document.getElementById('flj8W') || document.body);
            }
            return roots.filter(Boolean);
        };
        const getAndroidFontSizeRootKey = (roots) => {
            return roots.map(root => {
                if (!androidFontSizeRootIds.has(root)) {
                    androidFontSizeRootIds.set(root, nextAndroidFontSizeRootId++);
                }
                return androidFontSizeRootIds.get(root);
            }).join('|');
        };
        const hasAdjustableText = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH'].includes(el.tagName)) return false;
            if (el.matches('input, textarea, select')) return true;
            return Array.from(el.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
        };
        const restoreAndroidFontSizeFallback = () => {
            androidFontSizeOriginalStyles.forEach((originalFontSize, el) => {
                if (!el.isConnected) return;
                el.removeAttribute('data-android-font-size-adjusted');
                el.style.removeProperty('--android-adjusted-font-size');
                if (originalFontSize) el.style.fontSize = originalFontSize;
                else el.style.removeProperty('font-size');
            });
            androidFontSizeOriginalStyles.clear();
        };
        const resetAndroidFontSizeFallback = () => {
            if (androidFontSizeFrame) cancelAnimationFrame(androidFontSizeFrame);
            androidFontSizeFrame = null;
            if (androidFontSizeRetryTimer) clearTimeout(androidFontSizeRetryTimer);
            androidFontSizeRetryTimer = null;
            androidFontSizePercent = 100;
            androidFontSizeAppliedRoot = null;
            androidFontSizeAppliedPercent = 100;
            restoreAndroidFontSizeFallback();
            const style = document.getElementById(ANDROID_FONT_SIZE_STYLE_ID);
            if (style) style.remove();
        };
        const runAndroidFontSizeFallback = () => {
            androidFontSizeFrame = null;
            const roots = getVisibleFontSizeRoots();
            const rootKey = getAndroidFontSizeRootKey(roots);
            if (roots.length === 0) return;
            const needsFullRefresh = rootKey !== androidFontSizeAppliedRoot
                || androidFontSizePercent !== androidFontSizeAppliedPercent;
            if (needsFullRefresh) restoreAndroidFontSizeFallback();
            const scale = androidFontSizePercent / 100;
            let style = document.getElementById(ANDROID_FONT_SIZE_STYLE_ID);
            if (!style) {
                style = document.createElement('style');
                style.id = ANDROID_FONT_SIZE_STYLE_ID;
                document.head.appendChild(style);
            }
            style.textContent = '';
            const targets = roots.flatMap(root => Array.from(root.querySelectorAll('*')))
                .filter(hasAdjustableText)
                .filter(el => needsFullRefresh || !el.hasAttribute('data-android-font-size-adjusted'));
            const measuredTargets = targets.map(el => {
                const baseSize = parseFloat(getComputedStyle(el).fontSize);
                return { el, baseSize, originalFontSize: el.style.fontSize || '' };
            });
            style.textContent = `
                [data-android-font-size-adjusted="true"] {
                    font-size: var(--android-adjusted-font-size) !important;
                }
            `;
            measuredTargets.forEach(({ el, originalFontSize }) => {
                androidFontSizeOriginalStyles.set(el, originalFontSize);
            });
            measuredTargets.forEach(({ el, baseSize }) => {
                if (!Number.isFinite(baseSize)) return;
                el.setAttribute('data-android-font-size-adjusted', 'true');
                el.style.setProperty('--android-adjusted-font-size', `${Math.round(baseSize * scale * 100) / 100}px`);
            });
            androidFontSizeAppliedRoot = rootKey;
            androidFontSizeAppliedPercent = androidFontSizePercent;
        };
        const applyAndroidFontSizeFallback = (percent) => {
            if (!shouldUseAndroidFontSizeFallback()) return;
            if (percent === 100) {
                resetAndroidFontSizeFallback();
                return;
            }
            androidFontSizePercent = percent;
            if (androidFontSizeRetryTimer) clearTimeout(androidFontSizeRetryTimer);
            androidFontSizeRetryTimer = null;
            if (androidFontSizeFrame) cancelAnimationFrame(androidFontSizeFrame);
            androidFontSizeFrame = requestAnimationFrame(runAndroidFontSizeFallback);
        };

        const flushVisibleFontSizeRoots = () => {};
        window.__lookyRefreshVisibleFontSizing = () => {};

        if (!window.__androidFontSizeFallbackPageListenerBound && shouldUseAndroidFontSizeFallback()) {
            window.__androidFontSizeFallbackPageListenerBound = true;
            window.addEventListener('looky:page-opened', () => {
                if (!shouldUseAndroidFontSizeFallback() || androidFontSizePercent === 100) return;
                if (androidFontSizeFrame) cancelAnimationFrame(androidFontSizeFrame);
                androidFontSizeFrame = requestAnimationFrame(runAndroidFontSizeFallback);
                if (androidFontSizeRetryTimer) clearTimeout(androidFontSizeRetryTimer);
                androidFontSizeRetryTimer = setTimeout(() => {
                    androidFontSizeRetryTimer = null;
                    if (androidFontSizeFrame) cancelAnimationFrame(androidFontSizeFrame);
                    androidFontSizeFrame = requestAnimationFrame(runAndroidFontSizeFallback);
                }, 160);
            });
            const scheduleAndroidFontSizeRescan = () => {
                if (!shouldUseAndroidFontSizeFallback() || androidFontSizePercent === 100) return;
                if (androidFontSizeFrame) cancelAnimationFrame(androidFontSizeFrame);
                androidFontSizeFrame = requestAnimationFrame(runAndroidFontSizeFallback);
                if (androidFontSizeRetryTimer) clearTimeout(androidFontSizeRetryTimer);
                androidFontSizeRetryTimer = setTimeout(() => {
                    androidFontSizeRetryTimer = null;
                    if (androidFontSizeFrame) cancelAnimationFrame(androidFontSizeFrame);
                    androidFontSizeFrame = requestAnimationFrame(runAndroidFontSizeFallback);
                }, 80);
            };
            const modalSelector = '.modal-overlay, .image-gen-overlay, .image-gen-viewer, .action-popover, .message-action-popover, .action-menu-popover, .privacy-sheet-overlay, .music-bottom-sheet-overlay, .forum-sheet-overlay';
            const modalObserver = new MutationObserver((mutations) => {
                const shouldRescan = mutations.some(m => {
                    const el = m.target;
                    const targetIsModal = el instanceof HTMLElement && (
                        el.matches(modalSelector) || el.closest(modalSelector)
                    );
                    const addedModal = Array.from(m.addedNodes || []).some(node => (
                        node instanceof HTMLElement && (
                            node.matches(modalSelector) || node.querySelector(modalSelector)
                        )
                    ));
                    return targetIsModal || addedModal;
                });
                if (shouldRescan) scheduleAndroidFontSizeRescan();
            });
            modalObserver.observe(document.body, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ['class', 'style', 'hidden']
            });
        }

        const applyDefaultFontSize = (percent) => {
            syncImportedFontSizeUI(percent, false);
            currentDefaultFontPercent = percent;
            const defaultStyle = document.getElementById(DEFAULT_FONT_STYLE_ID);
            if (defaultStyle) defaultStyle.remove();
            document.documentElement.style.removeProperty('--custom-font-family');
            resetAndroidFontSizeFallback();
        };

        const resetDefaultFontSize = () => {
            currentDefaultFontPercent = 100;
            const defaultStyle = document.getElementById(DEFAULT_FONT_STYLE_ID);
            if (defaultStyle) defaultStyle.remove();
            document.documentElement.style.removeProperty('--custom-font-family');
            resetAndroidFontSizeFallback();
        };

        // ▼▼▼ 新增：Blob 转换工具和缓存变量，防止页面卡顿 ▼▼▼
        let currentScreenFontBlobUrl = null;
        const base64ToBlob = (base64Data, contentType) => {
            const byteCharacters = atob(base64Data);
            const byteArrays = [];
            for (let offset = 0; offset < byteCharacters.length; offset += 512) {
                const slice = byteCharacters.slice(offset, offset + 512);
                const byteNumbers = new Array(slice.length);
                for (let i = 0; i < slice.length; i++) {
                    byteNumbers[i] = slice.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);
                byteArrays.push(byteArray);
            }
            return new Blob(byteArrays, { type: contentType });
        };
        // ▲▲▲ 新增结束 ▲▲▲

        const resolveFontSourceUrl = (fontUrl) => {
            if (!fontUrl) return '';
            if (currentFontState.sourceUrl === fontUrl && currentFontState.resolvedUrl) {
                return currentFontState.resolvedUrl;
            }
            if (currentScreenFontBlobUrl) {
                URL.revokeObjectURL(currentScreenFontBlobUrl);
                currentScreenFontBlobUrl = null;
            }

            let finalUrl = fontUrl;
            if (fontUrl.startsWith('data:')) {
                try {
                    const parts = fontUrl.split(',');
                    const contentType = parts[0].split(':')[1].split(';')[0];
                    const blob = base64ToBlob(parts[1], contentType);
                    currentScreenFontBlobUrl = URL.createObjectURL(blob);
                    finalUrl = currentScreenFontBlobUrl;
                } catch (e) {
                    console.error('字体转换Blob失败:', e);
                }
            }

            currentFontState.sourceUrl = fontUrl;
            currentFontState.resolvedUrl = finalUrl;
            return finalUrl;
        };

        const writeFontStyle = (resolvedUrl, importedPercent) => {
            syncImportedFontSizeUI(importedPercent, false);
            let style = document.getElementById(FONT_STYLE_ID);
            if (!style) {
                style = document.createElement('style');
                style.id = FONT_STYLE_ID;
                document.head.appendChild(style);
            }
            style.textContent = `
                @font-face {
                    font-family: 'MyCustomFont';
                    src: url('${resolvedUrl}');
                    font-display: swap;
                }
                body, .phone-screen {
                    font-family: 'MyCustomFont', -apple-system, sans-serif !important;
                }
            `;
            document.documentElement.style.setProperty('--custom-font-family', 'MyCustomFont');
        };

        const refreshCurrentFontSize = (persist = false) => {
            const importedPercent = getImportedFontPercent();
            syncImportedFontSizeUI(importedPercent, persist);
        };
        // 核心函数：应用字体
        const applyFont = (fontUrl, silent = false) => {
            const importedPercent = getImportedFontPercent();
            syncImportedFontSizeUI(importedPercent, true);
            if (!fontUrl) {
                clearFont(); // 如果没有URL，就执行清除操作
                return;
            }
            const finalUrl = resolveFontSourceUrl(fontUrl);
            if (!finalUrl) return;
            resetDefaultFontSize();
            writeFontStyle(finalUrl, importedPercent);
            // 只存进数据库(db)，不再塞进 localStorage，避免撑爆导致报错
            db.appData.put({ key: 'customFontUrl', value: fontUrl }).catch(() => {});
            // silent=true 是启动时自动加载，不弹提示，只在后台悄悄检测
            if (silent) {
                document.fonts.load(`1em 'MyCustomFont'`).catch(() => {});
                return;
            }
            // 用户手动点击时：先弹"加载中"，等浏览器真正确认后再报成功或失败
            showDynamicIsland('字体加载中...');
            document.fonts.load(`1em 'MyCustomFont'`).then((fonts) => {
                showDynamicIsland(fonts.length > 0 ? '字体已应用' : '字体加载失败，请检查链接或文件');
            }).catch(() => {
                showDynamicIsland('字体加载失败，请检查网络');
            });
        };
        // 核心函数：清除字体
        const clearFont = () => {
            const styleElement = document.getElementById(FONT_STYLE_ID);
            if (styleElement) {
                styleElement.remove(); // 直接删掉<style>标签，一切恢复原样
            }
            if (fontSizeApplyTimer) {
                clearTimeout(fontSizeApplyTimer);
                fontSizeApplyTimer = null;
            }
            if (currentScreenFontBlobUrl) {
                URL.revokeObjectURL(currentScreenFontBlobUrl);
                currentScreenFontBlobUrl = null;
            }
            document.documentElement.style.removeProperty('--custom-font-family');
            db.appData.delete('customFontUrl').catch(() => {});
            currentFontState.sourceUrl = '';
            currentFontState.resolvedUrl = '';
            applyDefaultFontSize(getImportedFontPercent());
            UI.fontUrlInput.value = ''; // 清空输入框
            if (builtinFontSelect) builtinFontSelect.value = ''; // 重置下拉菜单
            showDynamicIsland('字体已清除');
        };
        // ▼▼▼ 新增：内存替身变量，彻底解决输入框塞入500万字导致的卡死 ▼▼▼
        let tempScreenFontData = ""; 
        const savedImportedFontSize = clampPercent(localStorage.getItem(FONT_SIZE_KEY), 100, 80, 130);
        if (importedFontSizeSlider) importedFontSizeSlider.value = savedImportedFontSize;
        syncImportedFontSizeUI(savedImportedFontSize);
         // 页面加载时，自动应用已保存的字体
        installGlobalFontSizeScaling();
        const initSavedFont = async () => {
            let savedFontUrl = (await db.appData.get('customFontUrl'))?.value || '';
            // 兼容老数据：如果数据库里没有，但 localStorage 里有旧字体，迁移进数据库
            const legacyFontUrl = localStorage.getItem('customFontUrl');
            if (!savedFontUrl && legacyFontUrl) {
                savedFontUrl = legacyFontUrl;
                await db.appData.put({ key: 'customFontUrl', value: savedFontUrl }).catch(() => {});
            }
            // 清掉 localStorage 里的旧字体，释放被撑满的空间
            if (legacyFontUrl) localStorage.removeItem('customFontUrl');
            if (savedFontUrl) {
                applyFont(savedFontUrl, true); // 启动时静默加载，不弹提示
                // 尝试回填UI状态
                const isBuiltin = Array.from(builtinFontSelect.options).some(opt => opt.value === savedFontUrl);
                if (isBuiltin) {
                    builtinFontSelect.value = savedFontUrl;
                } else {
                    tempScreenFontData = savedFontUrl;
                    if (savedFontUrl.startsWith('data:')) {
                        UI.fontUrlInput.value = '【当前已应用本地/自定义字体】';
                    } else {
                        UI.fontUrlInput.value = savedFontUrl; 
                    }
                }
            }
            else {
                applyDefaultFontSize(savedImportedFontSize);
            }
        };
        initSavedFont();

        // 监听“应用字体”按钮
        UI.saveFontButton.addEventListener('click', () => {
            // 优先使用内存变量
            let urlToApply = tempScreenFontData;
            
            // 如果用户手动修改了输入框，且不是提示语，说明填了网络链接
            const currentInputValue = UI.fontUrlInput.value.trim();
            if (currentInputValue && !currentInputValue.startsWith('【')) {
                urlToApply = currentInputValue;
            }

            // 如果都没有，看下拉菜单
            if (!urlToApply && builtinFontSelect) {
                urlToApply = builtinFontSelect.value;
            }
            
            if (urlToApply) {
                applyFont(urlToApply);
            } else {
                showDynamicIsland('请先选择或输入一个字体', 'warning');
            }
        });

        // 监听“清除字体”按钮
        if (clearFontButton) {
            clearFontButton.addEventListener('click', () => {
                tempScreenFontData = "";
                clearFont();
            });
        }

        // 监听“本地上传”
        UI.fontFileUpload.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                UI.fontUrlInput.value = '【正在处理文件，请稍候...】';
                const reader = new FileReader();
                reader.onload = (event) => {
                    tempScreenFontData = event.target.result; // 大数据存入后台内存
                    UI.fontUrlInput.value = '【本地字体已就绪，正在应用】'; // 前台只显示短文字防卡
                    UI.saveFontButton.click(); 
                };
                reader.readAsDataURL(file);
            }
            e.target.value = '';
        });

        // 监听“内置字体”下拉菜单
        if (builtinFontSelect) {
            builtinFontSelect.addEventListener('change', (e) => {
                const selectedValue = e.target.value;
                if (selectedValue) {
                    UI.fontUrlInput.value = ''; // 选择内置字体时，清空输入框
                    tempScreenFontData = "";
                    applyFont(selectedValue); // 直接应用
                }
            });
        }
        
        // 监听手动输入网络链接
        UI.fontUrlInput.addEventListener('input', (e) => {
            const val = e.target.value;
            if (!val.startsWith('【')) {
                tempScreenFontData = val;
            }
        });
        if (importedFontSizeSlider) {
            importedFontSizeSlider.addEventListener('input', () => {
                const percent = getImportedFontPercent();
                syncImportedFontSizeUI(percent);
                return;
                if (!currentFontState.sourceUrl) {
                    if (fontSizeApplyTimer) clearTimeout(fontSizeApplyTimer);
                    fontSizeApplyTimer = setTimeout(() => {
                        applyDefaultFontSize(percent);
                        fontSizeApplyTimer = null;
                    }, 120);
                    return;
                }
                if (fontSizeApplyTimer) clearTimeout(fontSizeApplyTimer);
                fontSizeApplyTimer = setTimeout(() => {
                    refreshCurrentFontSize(true);
                    fontSizeApplyTimer = null;
                }, 120);
            });
            importedFontSizeSlider.addEventListener('change', () => {
                const percent = getImportedFontPercent();
                syncImportedFontSizeUI(percent, true);
                if (fontSizeApplyTimer) {
                    clearTimeout(fontSizeApplyTimer);
                    fontSizeApplyTimer = null;
                }
                showDynamicIsland('字号已保存');
                return;
                if (!currentFontState.sourceUrl) {
                    const percent = getImportedFontPercent();
                    syncImportedFontSizeUI(percent, true);
                    if (fontSizeApplyTimer) {
                        clearTimeout(fontSizeApplyTimer);
                        fontSizeApplyTimer = null;
                    }
                    applyDefaultFontSize(percent);
                    showDynamicIsland('字体大小已保存');
                    return;
                }
                refreshCurrentFontSize(true);
                showDynamicIsland('导入字体大小已保存');
            });
        }
        // ▲▲▲ 防卡顿版本替换结束 ▲▲▲
    }
    document.getElementById('page-settings-screen').addEventListener('click', async (event) => {
      const resetButton = event.target.closest('.wallpaper-reset-btn');

      if (!resetButton) return;
      const target = resetButton.dataset.resetTarget;
      if (!target) return;

      const dbKey = (target === 'home') ? 'homeWallpaper' : (target === 'system') ? 'systemUiBackground' : 'appContentBackground';
      await db.appData.delete(dbKey);
      AppState.wallpapers[target] = null;
let element = null;
if (target === 'system') {
    element = UI.phoneScreen;
} else if (target === 'home') {
    // 优先重置新层
    element = document.getElementById('home-wallpaper-layer') || UI.homeScreenWrapper;
    document.dispatchEvent(new CustomEvent('wallpaperChanged', { detail: { target: 'home' } }));
}
if (element) element.style.backgroundImage = '';
  if (target === 'app') {
    // 重置时，把所有 .app-content 和 .chat-main-area 的背景都清空
    document.querySelectorAll('.app-content, .chat-main-area').forEach(el => {
      el.style.backgroundImage = '';
    });
  }


      showDynamicIsland('壁纸已重置');
    });

    const saveIconSettings = async () => {
      await db.appData.put({
        key: 'iconSettings',
        value: AppState.iconSettings
      });
    };

    const updatePreview = (iconId, setting) => {
      const previewElement = UI.iconCustomizationList.querySelector(`.icon-preview[data-icon-id="${iconId}"]`);
      if (!previewElement) return;

      if (setting.type === 'image') {
        previewElement.innerHTML = `<img src="${setting.value}" alt="Preview">`;
        previewElement.style.backgroundColor = 'transparent';
        previewElement.dataset.tempValue = setting.value;
        previewElement.dataset.tempType = 'image';
      } else {
        const iconDefault = customizableIcons.find(i => i.id === iconId);
        previewElement.innerHTML = iconDefault.svgHTML;
        previewElement.style.backgroundColor = iconDefault.defaultColor;
        delete previewElement.dataset.tempValue;
        delete previewElement.dataset.tempType;
      }
    };

   const populateIconCustomizationList = () => {
      const list = UI.iconCustomizationList;
      list.innerHTML = '';
      const fragment = document.createDocumentFragment();
      customizableIcons.forEach(icon => {
        const setting = AppState.iconSettings[icon.id];
        const isImage = setting && setting.type === 'image';
        const item = document.createElement('div');
        item.className = 'list-item icon-custom-item';
        item.dataset.iconId = icon.id;
        item.innerHTML = `
            <span class="label">${icon.name}</span>
            <div class="icon-preview" data-icon-id="${icon.id}" style="background-color: ${isImage ? 'transparent' : icon.defaultColor};">
               ${isImage ? `<img src="${setting.value}" alt="Preview">` : icon.svgHTML}
            </div>
            <div class="icon-actions">
                <label class="btn btn-small btn-secondary">
                    本地上传
                    <input type="file" class="hidden-upload icon-file-upload" accept="image/*" data-icon-id="${icon.id}">
                </label>
                <button class="btn btn-small btn-secondary btn-url" data-icon-id="${icon.id}">URL链接</button>
                <button class="btn btn-small btn-save" data-icon-id="${icon.id}">保存</button>
                <button class="btn btn-small btn-reset" data-icon-id="${icon.id}">重置</button>
            </div>`;
        fragment.appendChild(item);
      });
      list.appendChild(fragment);
    };

    UI.iconCustomizationList.addEventListener('click', async (e) => {
      const target = e.target;
      const iconId = target.dataset.iconId;
      if (!iconId) return;

      if (target.classList.contains('btn-save')) {
        const previewElement = UI.iconCustomizationList.querySelector(`.icon-preview[data-icon-id="${iconId}"]`);
        const tempType = previewElement.dataset.tempType;
        const tempValue = previewElement.dataset.tempValue;

        if (tempType && tempValue) {
          AppState.iconSettings[iconId] = {
            type: tempType,
            value: tempValue
          };
          await saveIconSettings();
          applyIconSetting(iconId);
          delete previewElement.dataset.tempType;
          delete previewElement.dataset.tempValue;
          showDynamicIsland('图标已保存');
        }
      } else if (target.classList.contains('btn-reset')) {
        delete AppState.iconSettings[iconId];
        await saveIconSettings();
        applyIconSetting(iconId);
        updatePreview(iconId, {
          type: 'default'
        });
        showDynamicIsland('图标已重置');
      } else if (target.classList.contains('btn-url')) {
        const url = prompt('请输入图标的图片URL地址：');
        if (url && url.trim() !== '') {
          updatePreview(iconId, {
            type: 'image',
            value: url.trim()
          });
        }
      }
    });

    UI.iconCustomizationList.addEventListener('change', (e) => {

      const target = e.target;
      if (target.classList.contains('icon-file-upload')) {
        const iconId = target.dataset.iconId;
        const file = target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = async (event) => {
            const imageValue = await compressImageDataUrl(event.target.result);
            updatePreview(iconId, {
              type: 'image',
              value: imageValue
            });
          };
          reader.readAsDataURL(file);
        }
        target.value = '';
      }
    });

    populateIconCustomizationList();
    // --- 小组件样式切换逻辑 ---
    const widgetPreviewArea = document.getElementById('widget-preview-area');
    const widgetStyleSelector = document.getElementById('widget-style-selector');
    const homeWidgetWrapper = document.querySelector('#home-screen-wrapper .ticket-widget-wrapper');
    // 1. 克隆主屏幕的小组件到预览区
    if (homeWidgetWrapper && widgetPreviewArea) {
        const previewWrapper = homeWidgetWrapper.cloneNode(true);
        previewWrapper.removeAttribute('id'); // 移除ID防止冲突
        widgetPreviewArea.appendChild(previewWrapper);
    }
    // 2. 应用小组件样式的函数
    const applyWidgetStyle = (style) => {
        const wrappers = [homeWidgetWrapper, widgetPreviewArea.querySelector('.ticket-widget-wrapper')];
        
        wrappers.forEach(wrapper => {
            if (!wrapper) return;
            // 隐藏所有样式
            wrapper.querySelectorAll('.widget-style-ticket, .widget-style-id-card, .widget-style-player').forEach(el => {
                el.style.display = 'none';
                el.classList.remove('active');
            });
            // 显示选中的样式
            const activeWidget = wrapper.querySelector(`.widget-style-${style}`);
            if (activeWidget) {
                activeWidget.style.display = 'block';
                activeWidget.classList.add('active');
            }
        });
    };
    
    // 3. 初始化：页面加载时，根据保存的设置应用样式
    const savedWidgetStyle = AppState.homeScreenWidget || 'ticket';
    // 更新设置界面的单选按钮状态
    const radioToCheck = widgetStyleSelector.querySelector(`input[value="${savedWidgetStyle}"]`);
    if (radioToCheck) {
        radioToCheck.checked = true;
    }
     // ▼▼▼ 修改开始：顶部装饰组件切换逻辑 (带预览框版) ▼▼▼
    const topDecoPreviewArea = document.getElementById('top-deco-preview-area');
    const topDecoStyleSelector = document.getElementById('top-deco-style-selector');
    const topDecoWrapper = document.getElementById('top-decorative-wrapper');

    // 1. 克隆主屏幕的顶部装饰到预览区
    if (topDecoWrapper && topDecoPreviewArea) {
        const previewTopWrapper = topDecoWrapper.cloneNode(true);
        previewTopWrapper.removeAttribute('id'); // 移除ID防止冲突
        // 去除原本自带的上边距，让它在预览框里居中好看
        previewTopWrapper.style.marginTop = '0'; 
        topDecoPreviewArea.appendChild(previewTopWrapper);
    }

    // 2. 应用样式的函数 (同时作用于主屏幕和预览区)
    const applyTopDecoStyle = (styleName) => {
        const wrappers = [topDecoWrapper, topDecoPreviewArea ? topDecoPreviewArea.querySelector('.top-decorative-wrapper') : null];
        
        wrappers.forEach(wrapper => {
            if (!wrapper) return;
            // 先隐藏所有样式
            wrapper.querySelectorAll('.top-style-item').forEach(el => {
                el.style.display = 'none';
                el.classList.remove('active');
            });
            // 显示选中的那个样式
            const targetEl = wrapper.querySelector(`.top-style-item[data-style="${styleName}"]`);
            if (targetEl) {
                targetEl.style.display = 'block';
                targetEl.classList.add('active');
            }
        });
    };
    // 3. 页面加载时从数据库读取已保存的设置防重置
    const initTopDecoStyle = async () => {
        const dbData = await db.appData.get('topDecoStyle');
        if (dbData && dbData.value) AppState.topDecoStyle = dbData.value;
        const savedTopDecoStyle = AppState.topDecoStyle || 'time';
        // 更新单选按钮的选中状态
        if (topDecoStyleSelector) {
            const radioToCheck = topDecoStyleSelector.querySelector(`input[value="${savedTopDecoStyle}"]`);
            if (radioToCheck) radioToCheck.checked = true;
        }
        applyTopDecoStyle(savedTopDecoStyle);
    };
    initTopDecoStyle();
    // 4. 监听设置页面的单选按钮点击事件
    if (topDecoStyleSelector) {
        topDecoStyleSelector.addEventListener('change', async (e) => {
            if (e.target.name === 'top-deco-style') {
                const newStyle = e.target.value;
                AppState.topDecoStyle = newStyle;
                await db.appData.put({ key: 'topDecoStyle', value: newStyle }); // 存入数据库
                applyTopDecoStyle(newStyle); // 实时更新画面
                showDynamicIsland('顶部样式已切换');
            }
        });
    }
    // ▲▲▲ 修改结束 ▲▲▲
    // 应用样式到主屏幕和预览区
    applyWidgetStyle(savedWidgetStyle);
    // 4. 监听设置页面的点击事件
    widgetStyleSelector.addEventListener('change', async (e) => {
        if (e.target.name === 'widget-style') {
            const newStyle = e.target.value;
            
       
            AppState.homeScreenWidget = newStyle;
            await db.appData.put({ key: 'homeScreenWidget', value: newStyle });
  
            // b. 实时应用样式到主屏幕和预览区
            applyWidgetStyle(newStyle);
            showDynamicIsland('小组件样式已切换');
        }
    });
// ▼▼▼ 【绝对最终版】 ID Card 交互逻辑 (结构分离 + 独立监听) ▼▼▼

// 1. 获取所有相关元素
const idCardWidget = document.querySelector('.widget-style-id-card'); // 获取最外层容器
const idCardBody = document.getElementById('id-card-body-interactive');
const idCardBgInput = document.getElementById('id-card-bg-input');
const idCardPhotoWrapper = document.querySelector('.id-card-photo-wrapper');
const idCardPhotoImgElement = document.getElementById('id-card-photo-img');
const idCardPhotoInput = document.getElementById('id-card-photo-input');
const textFields = [
    document.getElementById('id-card-text-1'),
    document.getElementById('id-card-text-2'),
    document.getElementById('id-card-text-3')
];

// 2. 数据加载函数 (不变)
const loadIdCardData = () => {
    const data = AppState.idCardData || {};
    if (idCardBody && data.bg) {
        idCardBody.style.backgroundImage = `url(${data.bg})`;
        idCardBody.style.backgroundSize = 'cover';
    }
    if (idCardPhotoImgElement && data.photo) {
        idCardPhotoImgElement.src = data.photo;
    }
    textFields.forEach((el, index) => {
        if (el && data[`text${index + 1}`]) el.innerText = data[`text${index + 1}`];
    });
};

// 3. 数据保存函数 (不变)
const saveIdCardData = async () => {
    await db.appData.put({ key: 'idCardData', value: AppState.idCardData });
};

// 4. 页面加载时，加载一次数据
loadIdCardData();

// 5. 绑定文字编辑事件 (不变)
textFields.forEach((el, index) => {
    if(!el) return;
    el.addEventListener('input', () => {
        if (!AppState.idCardData) AppState.idCardData = {};
        AppState.idCardData[`text${index + 1}`] = el.innerText;
        saveIdCardData();
    });
});

// 6. 【核心】为照片和背景分别绑定独立的、互不干扰的监听器
if (idCardWidget && idCardBody && idCardPhotoWrapper) {
    
    // 监听照片区域的点击
    idCardPhotoWrapper.addEventListener('click', (e) => {
        // 关键！阻止事件继续冒泡给父元素（虽然现在结构分离了，但这是良好习惯）
        e.stopPropagation(); 
        console.log("📸 点击照片，触发照片上传 [独立事件]");
        idCardPhotoInput.click();
    });

    // 监听背景区域的点击
    idCardBody.addEventListener('click', (e) => {
        // 如果点击的是文字，什么也不做
        if (e.target.closest('.editable-text')) {
             console.log("✍️ 点击文字，允许编辑");
            return;
        }
        console.log("🖼️ 点击背景，触发背景上传 [独立事件]");
        idCardBgInput.click();
    });

    // 7. 绑定照片上传后的处理 (不变)
    idCardPhotoInput.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = async (event) => {
                const res = await compressImageDataUrl(event.target.result);
                if(idCardPhotoImgElement) idCardPhotoImgElement.src = res;
                if (!AppState.idCardData) AppState.idCardData = {};
                AppState.idCardData.photo = res;
                saveIdCardData();
                showDynamicIsland('证件照已更新');
            };
            reader.readAsDataURL(file);
        }
        e.target.value = '';
    };

    // 8. 绑定背景上传后的处理 (不变)
    idCardBgInput.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = async (event) => {
                const res = await compressImageDataUrl(event.target.result);
                idCardBody.style.backgroundImage = `url(${res})`;
                idCardBody.style.backgroundSize = 'cover';
                if (!AppState.idCardData) AppState.idCardData = {};
                AppState.idCardData.bg = res;
                saveIdCardData();
                showDynamicIsland('卡片背景已更新');
            };
            reader.readAsDataURL(file);
        }
        e.target.value = '';
    };
}
// ▼▼▼ 【新增】音乐播放器 (Player) 交互逻辑 ▼▼▼

// 1. 获取元素
const playerAvatarTrigger = document.getElementById('player-avatar-trigger');
const playerAvatarImg = document.getElementById('player-avatar-img');
const playerAvatarInput = document.getElementById('player-avatar-input');

const playerBodyBg = document.getElementById('player-body-bg');
const playerBgInput = document.getElementById('player-bg-input');

// 获取4个可编辑的文字区域
const playerFields = {
    emoji: document.getElementById('player-text-emoji'),
    date: document.getElementById('player-text-date'),
    title: document.getElementById('player-text-title'),
    footer: document.getElementById('player-text-footer')
};

// 2. 数据加载函数：从数据库读取并显示
const loadPlayerData = () => {
    const data = AppState.playerWidgetData || {};
    
    // 恢复头像
    if (playerAvatarImg && data.avatar) {
        playerAvatarImg.src = data.avatar;
    }
    // 恢复背景图
    if (playerBodyBg && data.bg) {
        playerBodyBg.style.backgroundImage = `url(${data.bg})`;
        playerBodyBg.style.backgroundSize = 'cover';
        playerBodyBg.style.backgroundPosition = 'center';
    }
    // 恢复文字
    if (data.texts) {
        if (playerFields.emoji) playerFields.emoji.innerText = data.texts.emoji || '(๑•̀ㅂ•́)و✧';
        if (playerFields.date) playerFields.date.innerText = data.texts.date || '2025-01-18 周六';
        if (playerFields.title) playerFields.title.innerText = data.texts.title || '请你听首歌.•♬';
        if (playerFields.footer) playerFields.footer.innerText = data.texts.footer || '🕗 birthday 2000/08/01';
    }
};

// 3. 数据保存函数
const savePlayerData = async () => {
    await db.appData.put({ key: 'playerWidgetData', value: AppState.playerWidgetData });
};

// 4. 初始化加载
loadPlayerData();

// 5. 交互逻辑：头像上传
if (playerAvatarTrigger && playerAvatarInput) {
    playerAvatarTrigger.addEventListener('click', (e) => {
        e.stopPropagation(); // 防止冒泡
        playerAvatarInput.click();
    });

    playerAvatarInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = async (evt) => {
                const res = await compressImageDataUrl(evt.target.result);
                if(playerAvatarImg) playerAvatarImg.src = res;
                
                // 保存数据
                if (!AppState.playerWidgetData) AppState.playerWidgetData = {};
                AppState.playerWidgetData.avatar = res;
                savePlayerData();
                showDynamicIsland('头像已更新');
            };
            reader.readAsDataURL(file);
        }
        e.target.value = ''; // 清空，允许重复上传同一张
    });
}

// 6. 交互逻辑：背景上传
if (playerBodyBg && playerBgInput) {
    playerBodyBg.addEventListener('click', (e) => {
        // 关键：如果点击的是正在编辑的文字，不要触发背景上传
        if (e.target.isContentEditable) {
            return;
        }
        // 防止点到底部按钮触发背景上传 (如果按钮有svg)
        if (e.target.closest('.player-controls')) {
            return;
        }
        
        playerBgInput.click();
    });

    playerBgInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = async (evt) => {
                const res = await compressImageDataUrl(evt.target.result);
                playerBodyBg.style.backgroundImage = `url(${res})`;
                playerBodyBg.style.backgroundSize = 'cover';
                playerBodyBg.style.backgroundPosition = 'center';

                // 保存数据
                if (!AppState.playerWidgetData) AppState.playerWidgetData = {};
                AppState.playerWidgetData.bg = res;
                savePlayerData();
                showDynamicIsland('播放器背景已更新');
            };
            reader.readAsDataURL(file);
        }
        e.target.value = '';
    });
}

// 7. 交互逻辑：文字编辑监听
Object.keys(playerFields).forEach(key => {
    const el = playerFields[key];
    if (el) {
        el.addEventListener('input', () => {
            if (!AppState.playerWidgetData) AppState.playerWidgetData = {};
            if (!AppState.playerWidgetData.texts) AppState.playerWidgetData.texts = {};
            
            // 实时保存文字
            AppState.playerWidgetData.texts[key] = el.innerText;
            savePlayerData();
        });
    }
});
// ▲▲▲ 【新增】音乐播放器逻辑结束 ▲▲▲
// ▼▼▼ 【新增】萌物盒 (Cute Pill) 交互保存逻辑 ▼▼▼
const cutePillAvatarImg = document.getElementById('cute-pill-avatar-img');
const cutePillAvatarUpload = document.getElementById('cute-pill-avatar-upload');
const cutePillText1 = document.getElementById('cute-pill-text-1');
const cutePillText2 = document.getElementById('cute-pill-text-2');
const cutePillBtnText = document.getElementById('cute-pill-btn-text'); // 新增按钮文字
const loadCutePillData = async () => {
    const dbData = await db.appData.get('cutePillData');
    if (dbData && dbData.value) {
        AppState.cutePillData = dbData.value;
    }
    const data = AppState.cutePillData || {};
    if (cutePillAvatarImg && data.avatar) cutePillAvatarImg.src = data.avatar;
    if (cutePillText1 && data.text1) cutePillText1.innerText = data.text1;
    if (cutePillText2 && data.text2) cutePillText2.innerText = data.text2;
    if (cutePillBtnText && data.btnText) cutePillBtnText.innerText = data.btnText;
};
const saveCutePillData = async () => {
    await db.appData.put({ key: 'cutePillData', value: AppState.cutePillData });
};

loadCutePillData();

if (cutePillAvatarUpload) {
    cutePillAvatarUpload.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (evt) => {
                const res = evt.target.result;
                if(cutePillAvatarImg) cutePillAvatarImg.src = res;
                if (!AppState.cutePillData) AppState.cutePillData = {};
                AppState.cutePillData.avatar = res;
                saveCutePillData();
                showDynamicIsland('组件头像已更新');
            };
            reader.readAsDataURL(file);
        }
        e.target.value = '';
    });
}

[cutePillText1, cutePillText2].forEach((el, index) => {
    if (el) {
        el.addEventListener('input', () => {
            if (!AppState.cutePillData) AppState.cutePillData = {};
            AppState.cutePillData[`text${index + 1}`] = el.innerText;
            saveCutePillData();
        });
    }
});

// 新增监听按钮文字的修改
if (cutePillBtnText) {
    cutePillBtnText.addEventListener('input', () => {
        if (!AppState.cutePillData) AppState.cutePillData = {};
        AppState.cutePillData.btnText = cutePillBtnText.innerText;
        saveCutePillData();
    });
}
// ▲▲▲ 【新增】萌物盒逻辑结束 ▲▲▲
// ▼▼▼ 【新增】透明星卡 (Glass Star) 交互保存逻辑 ▼▼▼
const glassStarBg = document.getElementById('glass-star-bg');
const glassStarBgUpload = document.getElementById('glass-star-bg-upload');
const glassStarAvatarImg = document.getElementById('glass-star-avatar-img');
const glassStarAvatarUpload = document.getElementById('glass-star-avatar-upload');
const glassStarTitle = document.getElementById('glass-star-title');
const glassStarFloor = document.getElementById('glass-star-floor');
const glassStarSearch = document.getElementById('glass-star-search');

const loadGlassStarData = async () => {
    const dbData = await db.appData.get('glassStarData');
    if (dbData && dbData.value) {
        AppState.glassStarData = dbData.value;
    }
    const data = AppState.glassStarData || {};
    if (glassStarBg && data.bg) {
        glassStarBg.style.backgroundImage = `url(${data.bg})`;
        glassStarBg.style.backgroundColor = 'transparent'; 
    }
    if (glassStarAvatarImg && data.avatar) glassStarAvatarImg.src = data.avatar;
    if (glassStarTitle && data.title) glassStarTitle.innerText = data.title;
    if (glassStarFloor && data.floor) glassStarFloor.innerText = data.floor;
    if (glassStarSearch && data.search) glassStarSearch.innerText = data.search;
};

const saveGlassStarData = async () => {
    await db.appData.put({ key: 'glassStarData', value: AppState.glassStarData });
};

loadGlassStarData();

if (glassStarBgUpload && glassStarBg) {
     // 修复层级遮挡：将点击事件绑定到最外层父元素
    const wrapper = glassStarBg.closest('.style-glass-star');
    if (wrapper) {
        wrapper.style.cursor = 'pointer';
        wrapper.addEventListener('click', (e) => {
            // 如果点击的是文字编辑区或头像上传区，就不触发换背景
            if (e.target.isContentEditable || e.target.closest('label')) {
                return;
            }
            glassStarBgUpload.click();
        });
    }
    glassStarBgUpload.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (evt) => {
                const res = evt.target.result;
                glassStarBg.style.backgroundImage = `url(${res})`;
                glassStarBg.style.backgroundColor = 'transparent';
                if (!AppState.glassStarData) AppState.glassStarData = {};
                AppState.glassStarData.bg = res;
                saveGlassStarData();
                showDynamicIsland('透明卡背景已更新');
            };
            reader.readAsDataURL(file);
        }
        e.target.value = '';
    });
}

if (glassStarAvatarUpload && glassStarAvatarImg) {
    glassStarAvatarUpload.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (evt) => {
                const res = evt.target.result;
                glassStarAvatarImg.src = res;
                if (!AppState.glassStarData) AppState.glassStarData = {};
                AppState.glassStarData.avatar = res;
                saveGlassStarData();
                showDynamicIsland('透明卡头像已更新');
            };
            reader.readAsDataURL(file);
        }
        e.target.value = '';
    });
}

[
    { el: glassStarTitle, key: 'title' },
    { el: glassStarFloor, key: 'floor' },
    { el: glassStarSearch, key: 'search' }
].forEach(item => {
    if (item.el) {
        item.el.addEventListener('input', () => {
            if (!AppState.glassStarData) AppState.glassStarData = {};
            AppState.glassStarData[item.key] = item.el.innerText;
            saveGlassStarData();
        });
    }
});
// ▲▲▲ 【新增】透明星卡逻辑结束 ▲▲▲
// ▼▼▼ 【新增】复古档案卡 (Retro File) 交互保存逻辑 ▼▼▼
const retroFileAvatarImg = document.getElementById('retro-file-avatar-img');
const retroFileAvatarUpload = document.getElementById('retro-file-avatar-upload');
const retroFileTitle = document.getElementById('retro-file-title');
const retroFileMsg = document.getElementById('retro-file-msg');
const retroFileFooter = document.getElementById('retro-file-footer');

const loadRetroFileData = async () => {
    const dbData = await db.appData.get('retroFileData');
    if (dbData && dbData.value) {
        AppState.retroFileData = dbData.value;
    }
    const data = AppState.retroFileData || {};
    if (retroFileAvatarImg && data.avatar) retroFileAvatarImg.src = data.avatar;
    if (retroFileTitle && data.title) retroFileTitle.innerText = data.title;
    if (retroFileMsg && data.msg) retroFileMsg.innerText = data.msg;
    if (retroFileFooter && data.footer) retroFileFooter.innerText = data.footer;
};

const saveRetroFileData = async () => {
    await db.appData.put({ key: 'retroFileData', value: AppState.retroFileData });
};

loadRetroFileData();

if (retroFileAvatarUpload && retroFileAvatarImg) {
    retroFileAvatarUpload.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (evt) => {
                const res = evt.target.result;
                retroFileAvatarImg.src = res;
                if (!AppState.retroFileData) AppState.retroFileData = {};
                AppState.retroFileData.avatar = res;
                saveRetroFileData();
                showDynamicIsland('档案卡图片已更新');
            };
            reader.readAsDataURL(file);
        }
        e.target.value = '';
    });
}

[
    { el: retroFileTitle, key: 'title' },
    { el: retroFileMsg, key: 'msg' },
    { el: retroFileFooter, key: 'footer' }
].forEach(item => {
    if (item.el) {
        item.el.addEventListener('input', () => {
            if (!AppState.retroFileData) AppState.retroFileData = {};
            AppState.retroFileData[item.key] = item.el.innerText;
            saveRetroFileData();
        });
    }
});
// ▲▲▲ 【新增】复古档案卡逻辑结束 ▲▲▲
// ▼▼▼ 【新增】单词高亮卡片 (Word List) 交互保存逻辑 ▼▼▼
const wordListImg = document.getElementById('word-list-img');
const wordListImgUpload = document.getElementById('word-list-img-upload');

const loadWordListData = async () => {
    const dbData = await db.appData.get('wordListData');
    if (dbData && dbData.value) {
        AppState.wordListData = dbData.value;
    }
    const data = AppState.wordListData || {};
    if (wordListImg && data.img) wordListImg.src = data.img;
};

const saveWordListData = async () => {
    await db.appData.put({ key: 'wordListData', value: AppState.wordListData });
};

loadWordListData();

if (wordListImgUpload && wordListImg) {
    wordListImgUpload.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (evt) => {
                const res = evt.target.result;
                wordListImg.src = res;
                if (!AppState.wordListData) AppState.wordListData = {};
                AppState.wordListData.img = res;
                saveWordListData();
                showDynamicIsland('单词卡图片已更新');
            };
            reader.readAsDataURL(file);
        }
        e.target.value = '';
    });
}
// ▲▲▲ 【新增】单词卡片逻辑结束 ▲▲▲
// ▼▼▼ 【新增】消息框 (Korean Msg) 交互保存逻辑 ▼▼▼
const kmAvatarImg = document.getElementById('km-avatar-img');
const kmAvatarUpload = document.getElementById('km-avatar-upload');

const kmElements = [
    { el: document.getElementById('km-time-1'), key: 'time1', type: 'text' },
    { el: document.getElementById('km-time-2'), key: 'time2', type: 'text' },
    { el: document.getElementById('km-time-3'), key: 'time3', type: 'text' },
    { el: document.getElementById('km-name'), key: 'name', type: 'text' },
    { el: document.getElementById('km-bubble-1'), key: 'msg1', type: 'text' },
    { el: document.getElementById('km-bubble-2'), key: 'msg2', type: 'text' },
    { el: document.getElementById('km-bubble-3'), key: 'msg3', type: 'text' },
    { input: document.getElementById('km-color-1'), target: document.getElementById('km-bubble-1'), key: 'color1', type: 'color' },
    { input: document.getElementById('km-color-2'), target: document.getElementById('km-bubble-2'), key: 'color2', type: 'color' },
    { input: document.getElementById('km-color-3'), target: document.getElementById('km-bubble-3'), key: 'color3', type: 'color' }
];

const loadKoreanMsgData = async () => {
    const dbData = await db.appData.get('koreanMsgData');
    if (dbData && dbData.value) {
        AppState.koreanMsgData = dbData.value;
    }
    const data = AppState.koreanMsgData || {};
    if (kmAvatarImg && data.avatar) kmAvatarImg.src = data.avatar;

    kmElements.forEach(item => {
        if (item.type === 'text' && item.el && data[item.key]) {
            item.el.innerText = data[item.key];
        } else if (item.type === 'color' && item.input && item.target && data[item.key]) {
            item.input.value = data[item.key];
            item.target.style.background = data[item.key];
        }
    });
};

const saveKoreanMsgData = async () => {
    await db.appData.put({ key: 'koreanMsgData', value: AppState.koreanMsgData });
};

loadKoreanMsgData();

if (kmAvatarUpload && kmAvatarImg) {
    kmAvatarUpload.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (evt) => {
                const res = evt.target.result;
                kmAvatarImg.src = res;
                if (!AppState.koreanMsgData) AppState.koreanMsgData = {};
                AppState.koreanMsgData.avatar = res;
                saveKoreanMsgData();
                showDynamicIsland('对话头像已更新');
            };
            reader.readAsDataURL(file);
        }
        e.target.value = '';
    });
}

kmElements.forEach(item => {
    if (item.type === 'text' && item.el) {
        item.el.addEventListener('input', () => {
            if (!AppState.koreanMsgData) AppState.koreanMsgData = {};
            AppState.koreanMsgData[item.key] = item.el.innerText;
            saveKoreanMsgData();
        });
    } else if (item.type === 'color' && item.input && item.target) {
        item.input.addEventListener('input', (e) => {
            const colorVal = e.target.value;
            item.target.style.background = colorVal;
            if (!AppState.koreanMsgData) AppState.koreanMsgData = {};
            AppState.koreanMsgData[item.key] = colorVal;
            saveKoreanMsgData();
        });
    }
});
// ▲▲▲ 【新增】消息框逻辑结束 ▲▲▲
    // ▼▼▼ 【新增】桌面样式方案保留功能逻辑 ▼▼▼
    const schemeListContainer = document.getElementById('desktop-scheme-list');
    const saveSchemeBtn = document.getElementById('save-desktop-scheme-btn');

    const renderDesktopSchemes = () => {
      if (!schemeListContainer) return;
      schemeListContainer.innerHTML = '';
      if (AppState.desktopSchemes.length === 0) {
         schemeListContainer.innerHTML = '<div class="list-item" style="justify-content: center; color: #999; font-size: 14px;">暂无保存的方案</div>';
         return;
      }

      AppState.desktopSchemes.forEach(scheme => {
        const item = document.createElement('div');
        item.className = 'list-item settings-list-item';
        item.innerHTML = `
          <span class="label" style="font-weight: 500;">${scheme.name}</span>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-small btn-primary apply-scheme-btn" data-id="${scheme.id}" style="background-color: #000;">应用</button>
            <button class="btn btn-small btn-secondary delete-scheme-btn" data-id="${scheme.id}" style="background-color: #ff3b30; color: white; border: none;">删除</button>
          </div>
        `;
        schemeListContainer.appendChild(item);
      });
    };

    // 保存方案按钮
    if (saveSchemeBtn) {
      saveSchemeBtn.addEventListener('click', async () => {
        const name = prompt('给当前的桌面方案起个名字吧：', `桌面方案 ${AppState.desktopSchemes.length + 1}`);
        if (!name) return;

        const newScheme = {
          id: Date.now().toString(),
          name: name,
          wallpapers: JSON.parse(JSON.stringify(AppState.wallpapers)),
          iconSettings: JSON.parse(JSON.stringify(AppState.iconSettings)),
          homeScreenWidget: AppState.homeScreenWidget,
          idCardData: JSON.parse(JSON.stringify(AppState.idCardData || {})),
          playerWidgetData: JSON.parse(JSON.stringify(AppState.playerWidgetData || {})),
          homeScreenImages: JSON.parse(JSON.stringify(AppState.homeScreenImages || {})),
          cutePillData: JSON.parse(JSON.stringify(AppState.cutePillData || {})),
          glassStarData: JSON.parse(JSON.stringify(AppState.glassStarData || {})),
          retroFileData: JSON.parse(JSON.stringify(AppState.retroFileData || {})),
          wordListData: JSON.parse(JSON.stringify(AppState.wordListData || {})),  
          koreanMsgData: JSON.parse(JSON.stringify(AppState.koreanMsgData || {})),        
          twConfig: localStorage.getItem('tw_custom_cfg'),
          instaConfig: localStorage.getItem('insta_custom_cfg'), 
          homeLayout: JSON.parse(JSON.stringify(AppState.homeLayout || { scale: 100, offset: 0, gap: 55, syncPage2: true, page2Scale: 100, page2Offset: 0, page2Gap: 10 })),
          topDecoStyle: AppState.topDecoStyle || 'time',
          desktopIconNameColor: AppState.desktopIconNameColor || DEFAULT_DESKTOP_ICON_NAME_COLOR
        };

        AppState.desktopSchemes.push(newScheme);
        await db.appData.put({ key: 'desktopSchemes', value: AppState.desktopSchemes });
        renderDesktopSchemes();
        showDynamicIsland('方案保存成功');
      });
    }

    // 列表的点击事件：删除或应用
    if (schemeListContainer) {
      schemeListContainer.addEventListener('click', async (e) => {
        const target = e.target;
        const schemeId = target.dataset.id;
        if (!schemeId) return;

        // --- 删除方案 ---
        if (target.classList.contains('delete-scheme-btn')) {
          if (confirm('确定要删除这个方案吗？')) {
            AppState.desktopSchemes = AppState.desktopSchemes.filter(s => s.id !== schemeId);
            await db.appData.put({ key: 'desktopSchemes', value: AppState.desktopSchemes });
            renderDesktopSchemes();
            showDynamicIsland('方案已删除');
          }
        } 
        // --- 应用方案 ---
        else if (target.classList.contains('apply-scheme-btn')) {
          const scheme = AppState.desktopSchemes.find(s => s.id === schemeId);
          if (!scheme) return;

          // 1. 恢复壁纸
          AppState.wallpapers = JSON.parse(JSON.stringify(scheme.wallpapers));
          await db.appData.put({ key: 'homeWallpaper', value: AppState.wallpapers.home });
          await db.appData.put({ key: 'systemUiBackground', value: AppState.wallpapers.system });
          await db.appData.put({ key: 'appContentBackground', value: AppState.wallpapers.app });
          
          const layer = document.getElementById('home-wallpaper-layer');
          if (layer) layer.style.backgroundImage = AppState.wallpapers.home ? `url(${AppState.wallpapers.home})` : '';
          else UI.homeScreenWrapper.style.backgroundImage = AppState.wallpapers.home ? `url(${AppState.wallpapers.home})` : '';
          UI.phoneScreen.style.backgroundImage = AppState.wallpapers.system ? `url(${AppState.wallpapers.system})` : '';
          document.querySelectorAll('.app-content, .chat-main-area').forEach(el => {
            if (!el.closest('#page-chat > .chat-main-area > .app-content')) {
              el.style.backgroundImage = AppState.wallpapers.app ? `url(${AppState.wallpapers.app})` : '';
            }
          });

          // 2. 恢复应用图标
          AppState.iconSettings = JSON.parse(JSON.stringify(scheme.iconSettings));
          await saveIconSettings();
          populateIconCustomizationList();
          customizableIcons.forEach(icon => applyIconSetting(icon.id));

          // 3. 恢复原生小组件类型 (票券/音乐/卡片)
          AppState.homeScreenWidget = scheme.homeScreenWidget || 'ticket';
          await db.appData.put({ key: 'homeScreenWidget', value: AppState.homeScreenWidget });
          const radioToCheck = widgetStyleSelector.querySelector(`input[value="${AppState.homeScreenWidget}"]`);
          if (radioToCheck) radioToCheck.checked = true;
          applyWidgetStyle(AppState.homeScreenWidget);

          // 4. 恢复原生小组件的具体内容
          AppState.idCardData = JSON.parse(JSON.stringify(scheme.idCardData || {}));
          await db.appData.put({ key: 'idCardData', value: AppState.idCardData });
          loadIdCardData();

          AppState.playerWidgetData = JSON.parse(JSON.stringify(scheme.playerWidgetData || {}));
          await db.appData.put({ key: 'playerWidgetData', value: AppState.playerWidgetData });
          loadPlayerData();

          AppState.cutePillData = JSON.parse(JSON.stringify(scheme.cutePillData || {}));
          await db.appData.put({ key: 'cutePillData', value: AppState.cutePillData });
          loadCutePillData();
          AppState.glassStarData = JSON.parse(JSON.stringify(scheme.glassStarData || {}));
          await db.appData.put({ key: 'glassStarData', value: AppState.glassStarData });
          loadGlassStarData();
          AppState.retroFileData = JSON.parse(JSON.stringify(scheme.retroFileData || {}));
          await db.appData.put({ key: 'retroFileData', value: AppState.retroFileData });
          loadRetroFileData();
          AppState.wordListData = JSON.parse(JSON.stringify(scheme.wordListData || {}));
          await db.appData.put({ key: 'wordListData', value: AppState.wordListData });
          loadWordListData();
          AppState.koreanMsgData = JSON.parse(JSON.stringify(scheme.koreanMsgData || {}));
          await db.appData.put({ key: 'koreanMsgData', value: AppState.koreanMsgData });
          loadKoreanMsgData();          
          // 5. 恢复相片和自定义小组件的图片
          AppState.homeScreenImages = JSON.parse(JSON.stringify(scheme.homeScreenImages || {}));
          await db.appData.put({ key: 'homeScreenImages', value: AppState.homeScreenImages });
          for (const imageId in AppState.homeScreenImages) {
            const imageUrl = AppState.homeScreenImages[imageId];
            const imgElement = document.getElementById(imageId);
            if (imgElement) imgElement.src = imageUrl || 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
          }

          // 6. 恢复外部小组件 (Top Widget & Insta Widget)
          if (scheme.twConfig) localStorage.setItem('tw_custom_cfg', scheme.twConfig);
          else localStorage.removeItem('tw_custom_cfg');
          
          if (scheme.instaConfig) localStorage.setItem('insta_custom_cfg', scheme.instaConfig);
          else localStorage.removeItem('insta_custom_cfg');
          // 7. 恢复图标缩放和排版微调
          if (scheme.homeLayout) {
              AppState.homeLayout = JSON.parse(JSON.stringify(scheme.homeLayout));
              await db.appData.put({ key: 'homeLayout', value: AppState.homeLayout });
              if (homeScaleSlider) homeScaleSlider.value = AppState.homeLayout.scale;
              if (homeOffsetSlider) homeOffsetSlider.value = AppState.homeLayout.offset;
              if (homeGapSlider) homeGapSlider.value = AppState.homeLayout.gap;
              if (syncPage2Toggle) syncPage2Toggle.checked = AppState.homeLayout.syncPage2;
              if (page2ScaleSlider) page2ScaleSlider.value = AppState.homeLayout.page2Scale;
              if (page2OffsetSlider) page2OffsetSlider.value = AppState.homeLayout.page2Offset;
              const restoredPage2Gap = AppState.homeLayout.page2Gap !== undefined ? AppState.homeLayout.page2Gap : 10;
              if (page2GapSlider) page2GapSlider.value = restoredPage2Gap;
              updateHomeLayoutStyles(AppState.homeLayout.scale, AppState.homeLayout.offset, AppState.homeLayout.gap, AppState.homeLayout.syncPage2, AppState.homeLayout.page2Scale, AppState.homeLayout.page2Offset, restoredPage2Gap);
          }
          // 8. 恢复顶部装饰
          if (scheme.topDecoStyle) {
              AppState.topDecoStyle = scheme.topDecoStyle;
              await db.appData.put({ key: 'topDecoStyle', value: AppState.topDecoStyle });
              if (topDecoStyleSelector) {
                  const radioToCheck = topDecoStyleSelector.querySelector(`input[value="${AppState.topDecoStyle}"]`);
                  if (radioToCheck) radioToCheck.checked = true;
              }
              applyTopDecoStyle(AppState.topDecoStyle);
          }
          if (Object.prototype.hasOwnProperty.call(scheme, 'desktopIconNameColor')) {
              applyDesktopIconNameColor(scheme.desktopIconNameColor, true);
          }
          // 调用 main.js 里暴露的全局函数刷新画面
          if (window.loadTW) window.loadTW();
          if (window.loadInsta) window.loadInsta();

          showDynamicIsland('方案应用成功，主页已刷新', 'success');
        }
      });
    }
    
    renderDesktopSchemes(); // 初始化渲染列表
    // ▼▼▼ 新增：屏幕设置页滑轨防误触 ▼▼▼
    const _antiMistouch_screenPage = document.getElementById('page-settings-screen');
    if (_antiMistouch_screenPage) {
      if (!document.getElementById('anti-mistouch-slider-style')) {
        const _amStyle = document.createElement('style');
        _amStyle.id = 'anti-mistouch-slider-style';
        _amStyle.textContent = `
          .slider-touch-locked { pointer-events: none !important; opacity: 0.45 !important; }
          .slider-touch-unlocked { opacity: 1 !important; }
          .slider-tap-hint { font-size: 11px; color: #aaa; letter-spacing: 0.5px; }
          .slider-tap-hint.hidden { visibility: hidden; }
        `;
        document.head.appendChild(_amStyle);
      }

      const _amAllSliders = _antiMistouch_screenPage.querySelectorAll('input[type="range"]');
      _amAllSliders.forEach(slider => {
        slider.classList.add('slider-touch-locked');

        let _amHint = document.createElement('span');
        _amHint.className = 'slider-tap-hint';
        _amHint.textContent = '轻触解锁滑轨';

        const _amEndpoints = slider.parentNode.querySelector('.slider-endpoints');
        if (_amEndpoints && _amEndpoints.children.length >= 2) {
          _amEndpoints.insertBefore(_amHint, _amEndpoints.children[1]);
        } else {
          _amHint.style.display = 'block';
          _amHint.style.textAlign = 'center';
          _amHint.style.marginTop = '4px';
          slider.parentNode.insertBefore(_amHint, slider.nextSibling);
        }

        let _amTimer = null;

        const _amLock = () => {
          slider.classList.add('slider-touch-locked');
          slider.classList.remove('slider-touch-unlocked');
          _amHint.classList.remove('hidden');
        };

        const _amUnlock = () => {
          slider.classList.remove('slider-touch-locked');
          slider.classList.add('slider-touch-unlocked');
          _amHint.classList.add('hidden');
          clearTimeout(_amTimer);
          _amTimer = setTimeout(_amLock, 5000);
        };

        const _amClickZone = slider.closest('.list-item') || slider.closest('.layout-control') || slider.closest('.display-scale-item') || slider.parentElement;
        if (_amClickZone) {
          _amClickZone.addEventListener('click', (e) => {
            if (slider.classList.contains('slider-touch-locked')) {
              _amUnlock();
            }
          });
        }

        slider.addEventListener('input', () => {
          clearTimeout(_amTimer);
          _amTimer = setTimeout(_amLock, 5000);
        });

        slider.addEventListener('change', () => {
          clearTimeout(_amTimer);
          _amTimer = setTimeout(_amLock, 3000);
        });
      });
    }
    // ▲▲▲ 新增结束 ▲▲▲
  }


  
