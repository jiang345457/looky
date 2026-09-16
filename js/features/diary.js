import { AppState, tempState, db } from '../state.js';
import { UI, showInputModal } from '../ui.js';
import { generateDiaryEntry } from './chat-service.js';

const Diary = (() => {

  let isActive = false;
  let hasInitialized = false;
  let diaryPageContainer = null;
  let isDialSetup = false;
  
  // --- 样式管理 ---
  const STYLE_IDS = {
    FONT: 'diary-custom-font-style',
    THEME: 'diary-custom-theme-colors',
    BASE: 'diary-base-styles' // 【新增】用于防止背景透明的基础样式
  };

  /**
   * 动态更新或创建<style>标签来应用自定义样式
   */
  const updateDynamicStyle = (styleId, cssContent) => {
    let styleEl = document.getElementById(styleId);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    styleEl.innerHTML = cssContent;
  };

  /**
   * 移除动态创建的<style>标签
   */
  const removeDynamicStyle = (styleId) => {
    document.getElementById(styleId)?.remove();
  };

  /**
   * 【修复】注入基础背景样式
   * 确保即使没有壁纸，页面也有默认颜色，而不是透明
   */
  const injectBaseStyles = () => {
    const css = `
      /* 默认背景色，防止变成透明 */
      .diary-list-page, .diary-detail-page {
        background-color: #f7f7f7; /* 默认浅灰背景 */
        background-image: var(--diary-list-wallpaper, none);
        background-size: cover;
        background-position: center;
        background-attachment: fixed;
      }
      .diary-detail-page {
        background-image: var(--diary-detail-wallpaper, none);
      }
    `;
    updateDynamicStyle(STYLE_IDS.BASE, css);
  };

  // ▼▼▼ 性能优化：保存当前正在使用的 Blob URL，以便更新时释放内存 ▼▼▼
  let currentFontBlobUrl = null;

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

  /**
   * 应用字体样式 (高性能 Blob 版)
   */
  const applyFont = (fontUrl) => {
    const styleId = STYLE_IDS.FONT;
    
    // 释放旧的内存指针，防止内存泄漏
    if (currentFontBlobUrl) {
      URL.revokeObjectURL(currentFontBlobUrl);
      currentFontBlobUrl = null;
    }

    if (fontUrl) {
      let finalUrl = fontUrl;

      // 如果是超长的 Base64 数据，转为几十个字符的 Blob URL 防卡顿
      if (fontUrl.startsWith('data:')) {
        try {
          const parts = fontUrl.split(',');
          const contentType = parts[0].split(':')[1].split(';')[0];
          const base64Data = parts[1];
          const blob = base64ToBlob(base64Data, contentType);
          currentFontBlobUrl = URL.createObjectURL(blob);
          finalUrl = currentFontBlobUrl;
          console.log('【V8 性能优化版】长文本已转为短效指针:', finalUrl);
        } catch (e) {
          console.error('【性能优化报错】转换失败，回退使用长文本:', e);
        }
      }

      const css = `
        @font-face {
          font-family: 'DiaryCustomFont';
          src: url('${finalUrl}');
          font-display: swap;
        }
        .diary-list-page,
        .diary-list-page *,
        .diary-detail-page,
        .diary-detail-page * {
          font-family: 'DiaryCustomFont', -apple-system, sans-serif !important;
        }
      `;

      updateDynamicStyle(styleId, css);
    } else {
      removeDynamicStyle(styleId);
    }
  };
  // ▲▲▲ 替换结束 ▲▲▲

  /**
   * 【新增】应用重点色和删除线颜色
   */
  const applyThemeColors = (highlightColor, deletionColor) => {
    const styleId = STYLE_IDS.THEME;
    // 设置默认值
    const hColor = highlightColor || '#fff2afff'; // 默认橙色
    const dColor = deletionColor || '#999999'; // 默认灰色

   const css = `
      /* 重点标记 (mark) - 荧光笔效果 */
      .diary-detail-page .article-body mark.highlight {
        background-color: ${hColor} !important; /* 背景变成重点色 */
        color: inherit !important;              /* 文字保持原有颜色 */
        text-decoration: none !important;       /* 去掉下划线 */
        padding: 0 4px;                         /* 左右加一点间距 */
        border-radius: 4px;                     /* 加一点圆角 */
        box-shadow: 0 0 4px ${hColor};          /* 加一点晕染光晕 */
      }
      
      /* 删除线样式 (对应 AI 输出的 <del>) */
      .diary-detail-page .article-body del.deletion {
        color: ${dColor} !important;
        text-decoration: line-through;
        text-decoration-color: ${dColor};
        opacity: 0.8;
      }
    `;
    updateDynamicStyle(styleId, css);

    // 同时更新设置弹窗里的预览圆点颜色
    const hPreview = document.getElementById('preview-highlight-color');
    const dPreview = document.getElementById('preview-delete-color');
    if (hPreview) hPreview.style.backgroundColor = hColor;
    if (dPreview) dPreview.style.backgroundColor = dColor;
  };

  /**
   * 应用列表页壁纸 (使用 CSS 变量)
   */
  const applyListWallpaper = (wallpaperUrl) => {
    const root = document.documentElement;
    if (wallpaperUrl) {
      root.style.setProperty('--diary-list-wallpaper', `url('${wallpaperUrl}')`);
    } else {
      // 显式设置为 none
      root.style.setProperty('--diary-list-wallpaper', 'none');
    }
  };

  /**
   * 应用详情页壁纸 (使用 CSS 变量)
   */
  const applyDetailWallpaper = (wallpaperUrl) => {
    const root = document.documentElement;
    if (wallpaperUrl) {
      root.style.setProperty('--diary-detail-wallpaper', `url('${wallpaperUrl}')`);
    } else {
      root.style.setProperty('--diary-detail-wallpaper', 'none');
    }
  };

  /**
   * 从数据库加载并应用所有日记设置
   */
  const loadAndApplySettings = async () => {
    try {
      const settings = await db.diarySettings.where({ charId: tempState.currentChatId }).first();
      if (settings) {
        applyFont(settings.fontUrl);
        applyListWallpaper(settings.listWallpaperUrl);
        applyDetailWallpaper(settings.detailWallpaperUrl);
        applyThemeColors(settings.highlightColor, settings.deletionColor);
      } else {
        applyFont(null);
        applyListWallpaper(null);
        applyDetailWallpaper(null);
        applyThemeColors(null, null);
      }
    } catch (e) {
      console.error('Error loading diary settings:', e);
    }
  };

  /**
   * 注入日记功能所需的 HTML 模态框
   */
  const injectDiaryModals = () => {
    if (document.getElementById('diary-settings-modal')) return;

    // 【修复】input type="color" 使用 visibility: hidden
    const modalsHTML = `
      <!-- 日记设置弹窗 -->
      <div id="diary-settings-modal" class="modal-overlay">
        <div class="modal-card diary-settings-card">
          <header class="diary-settings-header">
            <h3 class="settings-title">日记本设置</h3>
            <button id="diary-settings-close-btn" class="settings-close-btn">&times;</button>
          </header>
          <main class="diary-settings-content">
            <div class="settings-group">
              <div class="setting-item" id="diary-setting-font">
                <span class="label">阅读字体</span>
                <div class="value-wrapper">
                  <span class="current-value">默认字体</span>
                  <span class="arrow">›</span>
                </div>
              </div>
              <div class="setting-item" id="diary-setting-list-wallpaper">
                <span class="label">列表页壁纸</span>
                <div class="value-wrapper">
                  <span class="current-value">默认</span>
                  <span class="arrow">›</span>
                </div>
              </div>
              <div class="setting-item" id="diary-setting-detail-wallpaper">
                <span class="label">详情页壁纸</span>
                <div class="value-wrapper">
                  <span class="current-value">默认</span>
                  <span class="arrow">›</span>
                </div>
              </div>
            </div>
            
            <!-- 【新增】颜色设置组 -->
            <div class="settings-group">
               <div class="setting-item" id="diary-setting-highlight-color">
                <span class="label">重点标记颜色</span>
                <div class="value-wrapper">
                  <div class="color-preview-dot" id="preview-highlight-color" style="width: 20px; height: 20px; border-radius: 50%; background: #ff5e00; border: 1px solid #eee;"></div>
                  <span class="arrow">›</span>
                </div>
              </div>
              <div class="setting-item" id="diary-setting-delete-color">
                <span class="label">删除线颜色</span>
                <div class="value-wrapper">
                  <div class="color-preview-dot" id="preview-delete-color" style="width: 20px; height: 20px; border-radius: 50%; background: #999; border: 1px solid #eee;"></div>
                  <span class="arrow">›</span>
                </div>
              </div>
            </div>

            <div class="settings-group">
              <div class="setting-item danger" id="diary-enter-delete-mode-btn">
                <span class="label">批量删除</span>
                <span class="arrow">›</span>
              </div>
            </div>
          </main>
        </div>
      </div>
      <!-- ▼▼▼字体输入弹窗代码 ▼▼▼ -->
  <div id="diary-font-modal" class="modal-overlay" style="position: fixed; inset: 0; width: 100vw; height: 100dvh; min-height: 100dvh; align-items: center; justify-content: center; box-sizing: border-box; overflow: hidden; touch-action: none; overscroll-behavior: contain; padding: max(20px, env(safe-area-inset-top)) 0 max(20px, env(safe-area-inset-bottom)) 0;">
    <div class="modal-card diary-font-input-card" style="max-height: calc(100dvh - 40px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;">
      <h3>设置日记字体</h3>
      
      <!-- 内置字体下拉选择 (已移除旧的内联事件，完全由下方的JS内存变量接管) -->
      <select id="diary-builtin-font-select" style="width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #d1d1d6; font-size: 14px; outline: none; margin-bottom: 5px;">
        <option value="">-- 选择内置字体 --</option>
        <option value="./font1.ttf">记忆故障</option>
        <option value="./font2.ttf">无人共鸣</option>
        <option value="./font3.ttf">小猫系统</option>
      </select>

      <!-- 本地上传按钮 -->
      <button class="btn btn-secondary" onclick="document.getElementById('diary-font-file-upload').click()" style="width: 100%; margin-bottom: 5px;">从电脑/手机选择字体文件</button>
      <input type="file" id="diary-font-file-upload" accept=".ttf,.otf,.woff,.woff2" style="display: none;">

      <!-- 输入框：现在只负责显示提示语或接收手动的网络链接，绝不接触几百万字的大文件 -->
      <input type="text" id="fake-diary-font-input" class="styled-input" placeholder="直接粘贴网络链接，或使用上方功能">
      
      <div class="modal-buttons">
        <button id="diary-font-cancel-btn" class="btn btn-secondary">取消</button>
        <button id="diary-font-confirm-btn" class="btn btn-primary">确认应用</button>
      </div>
    </div>
  </div>
 
  <!-- 日记专用壁纸来源选择弹窗 -->

      <div id="diary-wallpaper-source-modal" class="modal-overlay" style="position: fixed; inset: 0; width: 100vw; height: 100dvh; min-height: 100dvh; align-items: flex-end; justify-content: center; box-sizing: border-box; overflow: hidden; touch-action: none; overscroll-behavior: contain; padding: 0 0 max(8px, env(safe-area-inset-bottom)) 0;">
        <div class="modal-card wallpaper-source-card" style="padding: 20px; background: #fff; border-radius: 20px; width: 80%; max-width: 320px; max-height: calc(100dvh - 20px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;">
          <h3 style="text-align: center; margin-bottom: 20px; font-size: 16px;">选择壁纸来源</h3>
          <div style="display: flex; flex-direction: column; gap: 12px;">
            <button id="diary-wallpaper-source-upload" class="btn btn-primary" style="width: 100%;">从本地相册上传</button>
            <button id="diary-wallpaper-source-url" class="btn btn-secondary" style="width: 100%;">使用网络链接</button>
            <button id="diary-wallpaper-source-reset" class="btn btn-secondary" style="width: 100%; color: #d9534f;">恢复默认壁纸</button>
            <button id="diary-wallpaper-source-cancel" class="btn" style="width: 100%; margin-top: 10px; color: #999; background: transparent;">取消</button>
          </div>
        </div>
      </div>
      <input type="file" id="diary-wallpaper-upload-input" class="hidden-upload" accept="image/*" style="display: none;">
      <input type="color" id="diary-color-picker-highlight" style="opacity: 0; position: absolute; z-index: -1; width: 1px; height: 1px; padding: 0; margin: 0; border: none;">
      <input type="color" id="diary-color-picker-delete" style="opacity: 0; position: absolute; z-index: -1; width: 1px; height: 1px; padding: 0; margin: 0; border: none;">
         <div id="diary-edit-modal" class="modal-overlay" style="position: fixed; inset: 0; width: 100vw; height: 100dvh; min-height: 100dvh; align-items: center; justify-content: center; box-sizing: border-box; overflow: hidden; touch-action: none; overscroll-behavior: contain; padding: max(20px, env(safe-area-inset-top)) 0 max(20px, env(safe-area-inset-bottom)) 0;">
        <div class="modal-card diary-edit-input-card" style="width: 90%; max-width: 400px; max-height: calc(100dvh - 40px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); padding: 20px; display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden;">
          <h3 style="text-align: center; margin-bottom: 15px;">编辑日记</h3>
          <textarea id="diary-edit-input-field" class="styled-input" placeholder="修改日记内容..." style="width: 100%; height: 250px; padding: 10px; resize: none; border-radius: 8px; font-family: inherit; font-size: 14px; box-sizing: border-box; line-height: 1.5;"></textarea>
          <div class="modal-buttons" style="margin-top: 15px; display: flex; gap: 10px; justify-content: space-between;">
            <button id="diary-edit-cancel-btn" class="btn btn-secondary" style="flex: 1;">取消</button>
            <button id="diary-edit-confirm-btn" class="btn btn-primary" style="flex: 1;">保存</button>
          </div>
        </div>
      </div>
      `;


    document.body.insertAdjacentHTML('beforeend', modalsHTML);
  };

  /**
   * 渲染日记列表 HTML
   */
  const renderDiaryList = async () => {
    const character = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
    const characterName = character ? character.name : '角色';
    
    let diaryEntries = [];
    try {
        diaryEntries = await db.diaries.where('charId').equals(tempState.currentChatId).reverse().sortBy('date');
    } catch (e) {
        console.error("Failed to load diaries:", e);
    }

    const timelineHTML = diaryEntries.map(entry => {
      const entryDate = new Date(entry.date);
      const day = entryDate.getDate();
      const month = entryDate.toLocaleString('en-US', { month: 'short' }).toUpperCase();
      
      return `
        <div class="diary-entry-card" data-id="${entry.id}">
          <!-- 【新增】多选框的 HTML -->
          <div class="multiselect-checkbox-container">
            <input type="checkbox" id="diary-check-${entry.id}" class="multiselect-checkbox">
            <label for="diary-check-${entry.id}" class="checkbox-label">
              <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
            </label>
          </div>
          
          <div class="entry-date-stamp">
            <span class="day">${day}</span>
            <span class="month">${month}</span>
          </div>
          <div class="entry-content">
            <p class="entry-snippet">${entry.snippet}</p>
            
            <div class="entry-meta">
              ${entry.thumbnail ? `<img src="${entry.thumbnail}" alt="缩略图" class="entry-thumbnail">` : ''}
            </div>

            <div class="entry-actions">
                <button class="action-btn edit-btn" title="编辑">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                </button>
                <button class="action-btn delete-btn" title="删除">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            </div>

          </div>
        </div>
      `;
    }).join('');


   const pageHTML = `
      <div class="diary-list-page page">
        <header class="diary-header">
          <button class="back-btn diary-back-btn">&lt;</button>
          <h1>${characterName}的日记</h1>
          <div class="header-actions-right">
            <button class="header-action-btn" id="diary-write-btn">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9"></path>
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
              </svg>
            </button>
            <button class="header-action-btn" id="diary-more-btn">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="1"></circle>
                <circle cx="19" cy="12" r="1"></circle>
                <circle cx="5" cy="12" r="1"></circle>
              </svg>
            </button>
          </div>
          <span class="decoration-line"></span>
        </header>
        <main class="app-content">
            <div class="diary-timeline-container">
              ${diaryEntries.length > 0 ? timelineHTML : '<p class="empty-diary-prompt">日记本还是空的，点击右上角的笔，让AI写下第一篇日记吧。</p>'}
            </div>
        </main>
        
        <div class="floating-dial-btn" id="diary-dial-trigger">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
        </div>
        
        <div class="dial-overlay" id="diary-dial-overlay">
            <div class="dial-year-control">
                <button class="year-btn" id="dial-year-prev">&lt;</button>
                <span class="year-text" id="dial-year-display">2024</span>
                <button class="year-btn" id="dial-year-next">&gt;</button>
            </div>
            <div class="rotary-dial-container" id="rotary-dial-container">
                <div class="dial-ring ring-outer" id="dial-ring-day"></div>
                <div class="dial-ring ring-inner" id="dial-ring-month"></div>
                <div class="dial-center" id="dial-center">
                    <div class="dial-center-label">前往</div>
                    <div class="dial-center-value" id="dial-center-display">7月28日</div>
                </div>
            </div>
            <button class="dial-confirm-btn" id="dial-confirm-btn">确认跳转</button>
            <button class="close-dial-btn" id="close-dial-btn">Close</button>
        </div>

       <div id="diary-multiselect-footer">
          <button class="multiselect-action-btn cancel-btn" id="diary-multiselect-cancel">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
          <button class="multiselect-action-btn delete-btn" id="diary-multiselect-delete">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
        </div>
      </div>
    `;
    return pageHTML;
  };

  /**
   * 渲染日记详情 HTML
   */
  const renderDiaryDetail = async (diaryId) => {
    const entry = await db.diaries.get(diaryId);
    if (!entry) return `<div class="diary-detail-page page"><div style="padding:20px;text-align:center;">此日记不存在或已被删除</div></div>`;

    const processContent = (content) => {
      // 【核心修复1】如果内容是空的，直接返回占位文字，防止 replace 报错引发连环崩溃
      if (!content) return '<p>（此日记内容为空或已损坏）</p>';
      return String(content) // 强转字符串，更加安全
        .replace(/<u>([\s\S]*?)<\/u>/g, '<mark class="highlight">$1</mark>')
        .replace(/<del>([\s\S]*?)<\/del>/g, '<del class="deletion">$1</del>')
        .split('\n')
        .map(p => `<p>${p}</p>`)
        .join('');
    };

    const processedContent = processContent(entry.content);

    return `
      <div class="diary-detail-page page" data-diary-id="${diaryId}">
        <header class="diary-header">
          <button class="back-btn diary-back-btn">&lt;</button>
          <div class="header-actions-right">
            <button class="header-action-btn" id="diary-regenerate-btn">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                <path d="M23 4v6h-6"></path>
              </svg>
            </button>
          </div>
        </header>
        <main class="app-content">
            <article class="diary-article">
                <div class="article-meta">
                    <h2 class="article-date">${new Date(entry.date).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}</h2>
                    <span class="article-weather">${entry.weather || '未知'}</span>
                </div>
                <div class="separator-line"></div>
                <div class="article-body">
                    ${processedContent}
                </div>
            </article>
        </main>
      </div>
    `;
  };

  /**
   * 时间拨盘交互逻辑 (完整版)
   */
  const setupDialInteraction = () => {
    const dialOverlay = document.getElementById('diary-dial-overlay');
    const dialContainer = document.getElementById('rotary-dial-container');
    const centerDisplay = document.getElementById('dial-center-display');
    const confirmBtn = document.getElementById('dial-confirm-btn');
    
    const yearDisplay = document.getElementById('dial-year-display');
    const yearPrevBtn = document.getElementById('dial-year-prev');
    const yearNextBtn = document.getElementById('dial-year-next');

    const rings = {
        day: document.getElementById('dial-ring-day'),
        month: document.getElementById('dial-ring-month')
    };

    if (!dialContainer || !rings.day) return;

    let state = {
        mode: 'day',
        selected: { 
            year: new Date().getFullYear(), 
            month: new Date().getMonth() + 1, 
            day: new Date().getDate() 
        },
        angles: { day: 0, month: 0 }, 
        isDragging: false,
        startDragAngle: 0,
        startRingAngle: 0,
    };

    const populateRing = (ringEl, items, suffix, radiusOffset = 0) => {
        ringEl.innerHTML = '';
        const radius = (ringEl.offsetWidth / 2) - 15 - radiusOffset; 
        const angleStep = 360 / items.length;

        items.forEach((item, i) => {
            const itemEl = document.createElement('div');
            itemEl.className = 'dial-item';
            itemEl.textContent = item + suffix;
            itemEl.dataset.value = item;
            
            const angleRad = (i * angleStep - 90) * (Math.PI / 180);
            const x = radius * Math.cos(angleRad);
            const y = radius * Math.sin(angleRad);
            
            itemEl.dataset.bx = x; 
            itemEl.dataset.by = y;
            itemEl.style.transform = `translate(${x}px, ${y}px)`;
            
            ringEl.appendChild(itemEl);
        });
    };

    const updateRingVisuals = (key, isInstant = false) => {
        const ringEl = rings[key];
        const currentAngle = state.angles[key];
        
        ringEl.style.transition = isInstant ? 'none' : 'transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)';
        ringEl.style.transform = `translate(-50%, -50%) rotate(${currentAngle}deg)`;

        const items = ringEl.querySelectorAll('.dial-item');
        items.forEach(item => {
            const bx = parseFloat(item.dataset.bx);
            const by = parseFloat(item.dataset.by);
            item.style.transform = `translate(${bx}px, ${by}px) rotate(${-currentAngle}deg)`;
            item.style.transition = isInstant ? 'none' : 'transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)';
        });
        
        updateActiveItem(key, items, currentAngle);
    };

    const updateActiveItem = (key, items, angle) => {
        if (!items.length) return;
        const step = 360 / items.length;
        let normAngle = -angle % 360; 
        if (normAngle < 0) normAngle += 360;
        
        let activeIndex = Math.round(normAngle / step) % items.length;
        
        items.forEach((item, i) => {
            if (i === activeIndex) {
                item.classList.add('active');
                state.selected[key] = parseInt(item.dataset.value);
            } else {
                item.classList.remove('active');
            }
        });
        updateInfoDisplay();
    };

    const updateInfoDisplay = () => {
        yearDisplay.textContent = state.selected.year;
        centerDisplay.textContent = `${state.selected.month}月 ${state.selected.day}日`;
        rings.day.classList.toggle('active', state.mode === 'day');
        rings.month.classList.toggle('active', state.mode === 'month');
    };

    const setYear = (delta) => {
        state.selected.year += delta;
        updateInfoDisplay();
        refreshDayRing(false); 
    };

    const refreshDayRing = (resetAngle = true) => {
        const daysInMonth = new Date(state.selected.year, state.selected.month, 0).getDate();
        const currentCount = rings.day.children.length;

        if (currentCount !== daysInMonth) {
            const days = Array.from({length: daysInMonth}, (_, i) => i + 1);
            populateRing(rings.day, days, ''); 
            
            if (state.selected.day > daysInMonth) {
              state.selected.day = daysInMonth;
            }
            
            if (resetAngle) {
                const step = 360 / daysInMonth;
                const targetDayIndex = state.selected.day - 1; 
                state.angles.day = -(targetDayIndex * step);
            } else {
                const step = 360 / daysInMonth;
                state.angles.day = Math.round(state.angles.day / step) * step;
            }
            updateRingVisuals('day', true);
        }
    };

    const init = () => {
        const months = Array.from({length: 12}, (_, i) => i + 1);
        populateRing(rings.month, months, '月');
        
        const monthStep = 360 / 12;
        state.angles.month = -((state.selected.month - 1) * monthStep);
        updateRingVisuals('month', true);

        refreshDayRing(true);
        updateInfoDisplay();
    };

    yearPrevBtn.addEventListener('click', () => setYear(-1));
    yearNextBtn.addEventListener('click', () => setYear(1));

    document.getElementById('dial-center').addEventListener('click', () => {
        state.mode = state.mode === 'day' ? 'month' : 'day';
        updateInfoDisplay();
    });

    const getAngle = (clientX, clientY) => {
        const rect = dialContainer.getBoundingClientRect();
        return Math.atan2(clientY - (rect.top + rect.height/2), clientX - (rect.left + rect.width/2)) * (180 / Math.PI);
    };

    const startDrag = (e) => {
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const rect = dialContainer.getBoundingClientRect();
        const dist = Math.sqrt(Math.pow(clientX - (rect.left+rect.width/2), 2) + Math.pow(clientY - (rect.top+rect.height/2), 2));
        const radius = rect.width / 2;
        
        state.mode = (dist < radius * 0.55) ? 'month' : 'day';
        updateInfoDisplay();

        state.isDragging = true;
        state.startDragAngle = getAngle(clientX, clientY);
        state.startRingAngle = state.angles[state.mode];
        dialContainer.style.cursor = 'grabbing';
    };

    const onDrag = (e) => {
        if (!state.isDragging) return;
        e.preventDefault();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const currentAngle = getAngle(clientX, clientY);
        const delta = currentAngle - state.startDragAngle;
        state.angles[state.mode] = state.startRingAngle + delta;
        updateRingVisuals(state.mode, true);
    };

    const endDrag = () => {
        if (!state.isDragging) return;
        state.isDragging = false;
        dialContainer.style.cursor = 'default';
        const ringEl = rings[state.mode];
        const step = 360 / ringEl.children.length;
        state.angles[state.mode] = Math.round(state.angles[state.mode] / step) * step;
        updateRingVisuals(state.mode, false);
        if (state.mode === 'month') {
            setTimeout(() => refreshDayRing(false), 300);
        }
    };

    dialContainer.addEventListener('mousedown', startDrag);
    dialContainer.addEventListener('touchstart', startDrag, { passive: false });
    window.addEventListener('mousemove', onDrag);
    window.addEventListener('touchmove', onDrag, { passive: false });
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('touchend', endDrag);

    confirmBtn.addEventListener('click', async () => {
        const targetDate = new Date(state.selected.year, state.selected.month - 1, state.selected.day);
        targetDate.setHours(0, 0, 0, 0);

        const allEntries = await db.diaries.where('charId').equals(tempState.currentChatId).reverse().sortBy('date');
        let targetEntry = allEntries.find(entry => {
            const entryDate = new Date(entry.date);
            entryDate.setHours(0, 0, 0, 0);
            return entryDate.getTime() <= targetDate.getTime();
        });

        if (targetEntry) {
            const targetCard = document.querySelector(`.diary-entry-card[data-id="${targetEntry.id}"]`);
            if (targetCard) {
                targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                targetCard.classList.add('highlight-jump');
                setTimeout(() => targetCard.classList.remove('highlight-jump'), 2000);
            }
        } else {
            alert('该日期或之前没有日记');
        }
        dialOverlay.classList.remove('visible');
    });

    init();
  };

  /**
   * 绑定所有事件
   * 包含：返回、弹窗控制、设置项逻辑(壁纸/字体/颜色)、日记交互(写/详情/删除/编辑)
   */
  const bindEvents = () => {
    document.body.addEventListener('click', async (event) => {
      // 如果日记功能本身未激活，则不响应任何相关事件
      if (!isActive) return;

      const targetElement = event.target.nodeType === Node.TEXT_NODE
        ? event.target.parentElement
        : event.target;

      // --- 1. 返回按钮逻辑 (高优先级) ---
      const backBtn = targetElement.closest('.diary-back-btn');
      if (backBtn) {
        const isDetailPage = document.querySelector('.diary-detail-page.active');
        if (isDetailPage) {
          await showDiaryList();
        } else {
          hide();
        }
        return;
      }

      // --- 2. 弹窗相关事件处理 ---
      const settingsModal = document.getElementById('diary-settings-modal');
      
      const moreBtn = targetElement.closest('#diary-more-btn');
      if (moreBtn) {
        settingsModal?.classList.add('visible');
        return;
      }
      
      const closeSettingsBtn = targetElement.closest('#diary-settings-close-btn');
      if (closeSettingsBtn || targetElement.id === 'diary-settings-modal') {
        settingsModal?.classList.remove('visible');
        return;
      }

      // --- 3. 设置项点击事件 ---
      const settingItem = targetElement.closest('.setting-item');
      if (settingItem) {
          const charId = tempState.currentChatId;
          let currentSettings = await db.diarySettings.where({ charId }).first();
          // 【初始化】如果不存在设置，添加并初始化所有字段（包括颜色）
          if (!currentSettings) {
              const newId = await db.diarySettings.add({ charId, fontUrl: '', listWallpaperUrl: '', detailWallpaperUrl: '', highlightColor: '', deletionColor: '' });
              currentSettings = await db.diarySettings.get(newId);
          }

          const getWallpaperSource = () => {
            return new Promise(resolve => {
              const modal = document.getElementById('diary-wallpaper-source-modal');
          const uploadBtn = document.getElementById('diary-wallpaper-source-upload');
              const urlBtn = document.getElementById('diary-wallpaper-source-url');
              // 【新增】获取重置按钮
              const resetBtn = document.getElementById('diary-wallpaper-source-reset');
              const cancelBtn = document.getElementById('diary-wallpaper-source-cancel');
              if (!modal || !uploadBtn || !urlBtn || !cancelBtn) {
                console.error('Diary wallpaper source modal elements not found!');
                return resolve(null);
              }
              
              const onUploadClick = () => { cleanup(); resolve({ type: 'upload' }); };
              const onUrlClick = async () => {
                cleanup(); 
                const url = await showInputModal({ title: '输入图片链接', placeholder: 'https://...' });
                resolve(url ? { type: 'url', value: url } : null); 
              };
              // 【新增】重置点击事件
              const onResetClick = () => { cleanup(); resolve({ type: 'reset' }); };
              const onCancelClick = () => { cleanup(); resolve(null); };
              const onOverlayClick = (e) => { if (e.target === modal) onCancelClick(); };
              const cleanup = () => {
                modal.classList.remove('visible');
                uploadBtn.removeEventListener('click', onUploadClick);
                urlBtn.removeEventListener('click', onUrlClick);
                // 【新增】移除监听
                if(resetBtn) resetBtn.removeEventListener('click', onResetClick);
                cancelBtn.removeEventListener('click', onCancelClick);
                modal.removeEventListener('click', onOverlayClick);
              };
              cleanup(); 
              uploadBtn.addEventListener('click', onUploadClick);
              urlBtn.addEventListener('click', onUrlClick);
              // 【新增】添加监听
              if(resetBtn) resetBtn.addEventListener('click', onResetClick);
              cancelBtn.addEventListener('click', onCancelClick);
              modal.addEventListener('click', onOverlayClick);

              modal.classList.add('visible');
            });
          };
          
          switch(settingItem.id) {
            case 'diary-setting-font': {
              console.log('【字体监测】1. 用户点击了日记字体设置');
              const fontModal = document.getElementById('diary-font-modal');
                        const fontUrlInput = document.getElementById('fake-diary-font-input'); // 给用户看的假框
              // ▼▼▼ 新增内存变量，取代会被苹果截断的真框
              let tempFontData = ""; 
              const builtinFontSelect = document.getElementById('diary-builtin-font-select');
              const confirmBtn = document.getElementById('diary-font-confirm-btn');
              const cancelBtn = document.getElementById('diary-font-cancel-btn');
              const fontFileUploadInput = document.getElementById('diary-font-file-upload');
              
              // 安全添加清除按钮（防止重复添加）
              let clearBtn = document.getElementById('diary-font-clear-btn');
              if (!clearBtn) {
                clearBtn = document.createElement('button');
                clearBtn.id = 'diary-font-clear-btn';
                clearBtn.textContent = '清除字体';
                clearBtn.className = 'btn btn-secondary';
                confirmBtn.parentElement.insertBefore(clearBtn, confirmBtn);
              }

              const getNewUrl = () => new Promise(resolve => {
                            const handleConfirm = () => {
                  console.log('【字体监测】=> 点击确认');
                  // 强制从内存变量取值，绕过手机浏览器 512KB 容量上限
                  let urlToApply = tempFontData.trim();
                  
                  if (!urlToApply && builtinFontSelect.value) {
                    urlToApply = builtinFontSelect.value;
                    console.log('【字体监测】读取到内置路径:', urlToApply);
                  } else if (urlToApply) {
                    console.log('【字体监测】读取到隐藏框数据，长度:', urlToApply.length);
                  } else {
                    console.log('【字体监测】未读取到任何字体数据');
                  }
                  
                  cleanup();
                  resolve({ action: 'apply', value: urlToApply });
                };
                
                const handleCancel = () => {
                  console.log('【字体监测】=> 点击取消');
                  cleanup();
                  resolve(null);
                };
                
                const handleClear = () => {
                  console.log('【字体监测】=> 点击清除');
                  cleanup();
                  resolve({ action: 'clear' });
                };
                
                const handleOverlayClick = (e) => {
                  if (e.target === fontModal) {
                      console.log('【字体监测】=> 点击背景遮罩取消');
                      handleCancel();
                  }
                };
                
                const cleanup = () => {
                  fontModal.classList.remove('visible');
                  confirmBtn.removeEventListener('click', handleConfirm);
                  cancelBtn.removeEventListener('click', handleCancel);
                  clearBtn.removeEventListener('click', handleClear);
                  fontModal.removeEventListener('click', handleOverlayClick);
                };
                
                confirmBtn.addEventListener('click', handleConfirm);
                cancelBtn.addEventListener('click', handleCancel);
                clearBtn.addEventListener('click', handleClear);
                fontModal.addEventListener('click', handleOverlayClick);
                // 初始化回填
                const savedFontUrl = currentSettings.fontUrl || '';
                console.log('【字体监测】初始化回填数据长度:', savedFontUrl.length);
                tempFontData = savedFontUrl;
                if (savedFontUrl.startsWith('data:')) {
                    fontUrlInput.value = '【当前已应用本地/内置字体】';
                } else {
                    fontUrlInput.value = savedFontUrl;
                }
                
                // 回填下拉框状态
                if (savedFontUrl && Array.from(builtinFontSelect.options).some(o => o.value === savedFontUrl)) {
                    builtinFontSelect.value = savedFontUrl;
                } else {
                    builtinFontSelect.value = '';
                }
                
                fontModal.classList.add('visible');
              });

              // 重新接管上传逻辑，放入后台读取防卡死
              fontFileUploadInput.onchange = (e) => {
                  console.log('【字体监测】触发本地文件上传');
                  const file = e.target.files[0];
                  if (file) {
                      console.log('【字体监测】读取到文件:', file.name, '大小:', file.size);
                      fontUrlInput.value = '【正在处理文件，请稍候...】';
                      const reader = new FileReader();
                      reader.onload = (event) => {
                          console.log('【字体监测】文件转Base64成功，装入内存变量');
                          tempFontData = event.target.result;
                          fontUrlInput.value = '【本地字体已就绪，请点击确认】';
                      };
                      reader.onerror = (err) => {
                          console.error('【字体监测】文件读取失败:', err);
                          fontUrlInput.value = '【读取失败】';
                      };
                      reader.readAsDataURL(file);
                  }
                  e.target.value = '';
              };

              // 重新接管内置选择逻辑，加入 Fetch 和监测
              builtinFontSelect.onchange = (e) => {
                  console.log('【字体监测】触发内置下拉框切换');
                  const val = e.target.value;
                  if (val) {
                      console.log('【字体监测】开始拉取内置字体:', val);
                      fontUrlInput.value = '【加载内置字体中...】';
                      fetch(val)
                        .then(r => r.blob())
                        .then(b => {
                          console.log('【字体监测】内置字体拉取成功，大小:', b.size);
                              let reader = new FileReader();
                          reader.onload = evt => {
                            tempFontData = evt.target.result;
                            fontUrlInput.value = '【内置字体已就绪，请点击确认】';
                            console.log('【字体监测】内置字体转Base64并装载完成');
                          };
                          reader.readAsDataURL(b);
                        })
                        .catch(err => {
                          console.error('【字体监测】内置字体拉取失败:', err);
                          fontUrlInput.value = '【加载失败，请检查网络】';
                          tempFontData = '';
                        });
                  } else {
                      fontUrlInput.value = '';
                      tempFontData = '';
                  }
              };
              // 拦截假输入框的手动输入，同步到内存变量
              fontUrlInput.oninput = (e) => {
                  const val = e.target.value;
                  if (!val.startsWith('【')) { // 排除提示语
                      tempFontData = val;
                      console.log('【字体监测】用户手动输入URL链接');
                  }
              };
              const result = await getNewUrl(); 
              console.log('【字体监测】4. 弹窗关闭，结果为:', result ? result.action : '未操作');
              
              if (result) {
                if (result.action === 'apply' && result.value) {
                    console.log('【字体监测】执行保存，更新数据库并应用');
                    await db.diarySettings.update(currentSettings.id, { fontUrl: result.value });
                    applyFont(result.value);
                } else if (result.action === 'clear') {
                    console.log('【字体监测】执行清除，抹除数据');
                    await db.diarySettings.update(currentSettings.id, { fontUrl: '' });
                    applyFont(null); 
                }
              }
              break;
            }
            case 'diary-setting-list-wallpaper':
            case 'diary-setting-detail-wallpaper': {
              const source = await getWallpaperSource();
              if (!source) break; 

              const isListWallpaper = settingItem.id === 'diary-setting-list-wallpaper';
              const dbKey = isListWallpaper ? 'listWallpaperUrl' : 'detailWallpaperUrl';
              const applyFunction = isListWallpaper ? applyListWallpaper : applyDetailWallpaper;

              if (source.type === 'upload') {
                const hiddenInput = document.getElementById('diary-wallpaper-upload-input');
                hiddenInput.onchange = null;
                hiddenInput.onchange = (e) => {
                  const file = e.target.files[0];
                  if (file) {
                    const reader = new FileReader();
                    reader.onload = async (event) => {
                      const dataUrl = event.target.result;
                      await db.diarySettings.update(currentSettings.id, { [dbKey]: dataUrl });
                      applyFunction(dataUrl);
                    };
                    reader.readAsDataURL(file);
                  }
                  hiddenInput.value = ''; 
                };
                hiddenInput.click();
     } else if (source.type === 'url') {
                await db.diarySettings.update(currentSettings.id, { [dbKey]: source.value });
                applyFunction(source.value);
              } 
              // 【新增】处理恢复默认
              else if (source.type === 'reset') {
                await db.diarySettings.update(currentSettings.id, { [dbKey]: '' }); // 清空数据库字段
                applyFunction(null); // 应用空样式
              }
              break;
            }
            
            // 【新增】处理颜色设置的点击
            case 'diary-setting-highlight-color': {
                const picker = document.getElementById('diary-color-picker-highlight');
                if (picker) {
                    // 设置当前值
                    picker.value = currentSettings.highlightColor || '#ff5e00';
                    // 实时预览
                    picker.oninput = (e) => {
                        const color = e.target.value;
                        document.getElementById('preview-highlight-color').style.backgroundColor = color;
                    };
                    // 确认更改
                    picker.onchange = async (e) => {
                        const color = e.target.value;
                        await db.diarySettings.update(currentSettings.id, { highlightColor: color });
                        applyThemeColors(color, currentSettings.deletionColor);
                    };
                    picker.click(); // 触发点击
                }
                break;
            }
            case 'diary-setting-delete-color': {
                const picker = document.getElementById('diary-color-picker-delete');
                if (picker) {
                    picker.value = currentSettings.deletionColor || '#999999';
                    picker.oninput = (e) => {
                        const color = e.target.value;
                        document.getElementById('preview-delete-color').style.backgroundColor = color;
                    };
                    picker.onchange = async (e) => {
                        const color = e.target.value;
                        await db.diarySettings.update(currentSettings.id, { deletionColor: color });
                        applyThemeColors(currentSettings.highlightColor, color);
                    };
                    picker.click();
                }
                break;
            }

            case 'diary-enter-delete-mode-btn':
              const diaryListPage = document.querySelector('.diary-list-page');
              if (diaryListPage) {
                diaryListPage.classList.add('multiselect-active');
                settingsModal?.classList.remove('visible');
              }
              break;
          }
          return;
      }
      
      // --- 4. 其他页面交互事件 ---
      
      // 时间拨盘 - 打开/关闭
      const dialTrigger = targetElement.closest('#diary-dial-trigger');
      if (dialTrigger) {
        const overlay = document.getElementById('diary-dial-overlay');
        if (overlay) {
            overlay.classList.add('visible');
            if (!isDialSetup) {
                setTimeout(() => {
                    setupDialInteraction();
                    isDialSetup = true;
                }, 50);
            }
        }
        return;
      }
      const closeDialBtn = targetElement.closest('#close-dial-btn');
      if (closeDialBtn || (targetElement.id === 'diary-dial-overlay' && !targetElement.closest('.rotary-dial-container'))) {
         const ov = document.getElementById('diary-dial-overlay');
         if(ov) ov.classList.remove('visible');
         return;
      }
      
      // 写日记
      const writeBtn = targetElement.closest('#diary-write-btn');
      if (writeBtn && !writeBtn.classList.contains('writing')) {
        writeBtn.classList.add('writing');
        writeBtn.disabled = true;
        try {
          const diaryContent = await generateDiaryEntry(tempState.currentChatId);
          if (diaryContent) {
            const now = new Date();
            const localDateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            await db.diaries.add({
              charId: tempState.currentChatId,
              date: localDateStr,
              weather: '未知',
              location: null,
              snippet: diaryContent.replace(/<[^>]+>/g, '').substring(0, 80) + '...',
              content: diaryContent,
              image: null,
              thumbnail: null,
            });
            await showDiaryList();
          } else {
            alert('AI未能生成日记内容，请稍后再试。');
          }
        } catch (e) {
            console.error(e);
            alert('生成日记时发生错误：' + e.message);
        } finally {
            const finalBtn = document.getElementById('diary-write-btn');
            if(finalBtn) {
                finalBtn.classList.remove('writing');
                finalBtn.disabled = false;
            }
        }
        return;
      }

      // 单个日记删除
      const deleteSingleBtn = targetElement.closest('.action-btn.delete-btn');
      if (deleteSingleBtn) {
          const card = deleteSingleBtn.closest('.diary-entry-card');
          const diaryId = parseInt(card.dataset.id, 10);
          if (confirm('确定要永久删除这篇日记吗？')) {
              await db.diaries.delete(diaryId);
              await showDiaryList(); 
          }
          return; 
      }
      // 单个日记编辑
      const editSingleBtn = targetElement.closest('.action-btn.edit-btn');
      if (editSingleBtn) {
          const card = editSingleBtn.closest('.diary-entry-card');
          const diaryId = parseInt(card.dataset.id, 10);
          const entry = await db.diaries.get(diaryId);
          
          if (entry) {
              // ▼▼▼ 替换掉原本吃换行的 showInputModal，改用我们自己的多行文本弹窗 ▼▼▼
              const getNewContent = () => new Promise(resolve => {
                  const modal = document.getElementById('diary-edit-modal');
                  const inputField = document.getElementById('diary-edit-input-field');
                  const confirmBtn = document.getElementById('diary-edit-confirm-btn');
                  const cancelBtn = document.getElementById('diary-edit-cancel-btn');
                  
                  const cleanup = () => {
                      modal.classList.remove('visible');
                      confirmBtn.removeEventListener('click', onConfirm);
                      cancelBtn.removeEventListener('click', onCancel);
                      modal.removeEventListener('click', onOverlay);
                  };
                  
                  const onConfirm = () => { cleanup(); resolve(inputField.value); };
                  const onCancel = () => { cleanup(); resolve(null); };
                  const onOverlay = (e) => { if (e.target === modal) onCancel(); };

                  confirmBtn.addEventListener('click', onConfirm);
                  cancelBtn.addEventListener('click', onCancel);
                  modal.addEventListener('click', onOverlay);

                  inputField.value = entry.content || ''; // 赋值时保留原有换行
                  modal.classList.add('visible');
              });

              const newContent = await getNewContent();
              // ▲▲▲ 替换结束 ▲▲▲

              if (newContent !== null && newContent !== entry.content) {

                  await db.diaries.update(diaryId, {
                      content: newContent,
                      snippet: newContent.replace(/<[^>]+>/g, '').substring(0, 80) + '...'
                  });
                  await showDiaryList(); 
              }
          }
          return; 
      }

      // 查看日记详情
      const card = targetElement.closest('.diary-entry-card');
      const isActionButton = targetElement.closest('.action-btn'); 
      if (card && !isActionButton && !document.querySelector('.diary-list-page.multiselect-active')) {
        const diaryId = parseInt(card.dataset.id, 10);
        await showDiaryDetail(diaryId);
        return;
      }

      // 重新生成日记内容
      const regenerateBtn = targetElement.closest('#diary-regenerate-btn');
      if (regenerateBtn && !regenerateBtn.classList.contains('regenerating')) {
        const detailPage = targetElement.closest('.diary-detail-page');
        const diaryId = detailPage ? parseInt(detailPage.dataset.diaryId, 10) : null;
        
        if (diaryId) {
          regenerateBtn.classList.add('regenerating');
          regenerateBtn.disabled = true;
          try {
            const oldEntry = await db.diaries.get(diaryId);
            const newContent = await generateDiaryEntry(tempState.currentChatId, oldEntry.content);
            
            if (newContent) {
              await db.diaries.update(diaryId, {
                content: newContent,
                snippet: newContent.replace(/<[^>]+>/g, '').substring(0, 80) + '...',
              });
              await showDiaryDetail(diaryId); 
            } else {
              alert('AI未能生成新的日记内容，请稍后再试。');
            }
          } catch (e) {
            console.error('重新生成日记时出错:', e);
            alert('重新生成日记时发生错误：' + e.message);
          } finally {
            const finalBtn = document.getElementById('diary-regenerate-btn');
            if(finalBtn) {
              finalBtn.classList.remove('regenerating');
              finalBtn.disabled = false;
            }
          }
        }
        return;
      }

      // 多选删除 - 取消/执行/选择
// diary.js -> bindEvents 函数内部

      // 多选删除 - 取消/执行/选择
      const multiSelectCancelBtn = targetElement.closest('#diary-multiselect-cancel');
      if (multiSelectCancelBtn) {
        document.querySelector('.diary-list-page')?.classList.remove('multiselect-active');
        document.querySelectorAll('.diary-entry-card.selected-for-delete').forEach(card => {
          card.classList.remove('selected-for-delete');
          const checkbox = card.querySelector('.multiselect-checkbox');
          if (checkbox) checkbox.checked = false;
        });
        return;
      }
      const multiSelectDeleteBtn = targetElement.closest('#diary-multiselect-delete');
      if (multiSelectDeleteBtn) {
        const checkedBoxes = document.querySelectorAll('.multiselect-checkbox:checked');
        if (checkedBoxes.length === 0) {
          alert('请先勾选要删除的日记。');
          return;
        }
        if (confirm(`确定要删除选中的 ${checkedBoxes.length} 篇日记吗？此操作不可恢复。`)) {
          const idsToDelete = Array.from(checkedBoxes).map(box => parseInt(box.closest('.diary-entry-card').dataset.id, 10));
          await db.diaries.bulkDelete(idsToDelete);
          await showDiaryList();
        }
        return;
      }
      
      // 在多选模式下，点击卡片即为勾选
      if (document.querySelector('.diary-list-page.multiselect-active')) {
        const entryCard = targetElement.closest('.diary-entry-card');
        if (entryCard) {
            const checkbox = entryCard.querySelector('.multiselect-checkbox');
            if (checkbox) {
                // 如果点击的不是label或input本身，则手动切换状态
                if (!targetElement.closest('.checkbox-label') && targetElement.type !== 'checkbox') {
                    checkbox.checked = !checkbox.checked;
                }
                // 同步卡片的视觉状态
                entryCard.classList.toggle('selected-for-delete', checkbox.checked);
            }
        }
      }

    });
  };


  /**
   * 创建页面容器
   */
  const createContainer = () => {
    if (document.getElementById('diary-page-wrapper')) return;
    diaryPageContainer = document.createElement('div');
    diaryPageContainer.id = 'diary-page-wrapper';
    diaryPageContainer.style.display = 'none';
    document.querySelector('.phone-screen').appendChild(diaryPageContainer);
  };

  /**
   * 显示日记列表页
   */
  const showDiaryList = async () => {
    isDialSetup = false;
    const html = await renderDiaryList();
    if(diaryPageContainer) diaryPageContainer.innerHTML = html;
    setTimeout(() => {
      diaryPageContainer.querySelector('.diary-list-page')?.classList.add('active');
    }, 10);
  };
  
  /**
   * 显示日记详情页
   */
  const showDiaryDetail = async (diaryId) => {
    try {
        const html = await renderDiaryDetail(diaryId);
        const oldPage = diaryPageContainer.querySelector('.page.active');
        if (oldPage) oldPage.classList.remove('active');
        
        setTimeout(() => {
            if (diaryPageContainer) {
                diaryPageContainer.innerHTML = html;
                setTimeout(() => {
                    diaryPageContainer.querySelector('.diary-detail-page')?.classList.add('active');
                }, 10);
            }
        }, 300);
    } catch (error) {
        // 【核心修复2】即使发生致命错误，也能被捕捉，绝不卡死系统
        console.error("加载日记详情时发生错误:", error);
        alert("哎呀，加载这篇日记时出错了，数据可能不完整。");
    }
  };


  /**
   * 初始化模块
   */
  const init = () => {
    if (hasInitialized) return;
    createContainer();
    injectDiaryModals(); // 注入缺失的 HTML
    bindEvents();
    hasInitialized = true;
    console.log('Diary module initialized.');
  };
  /**
   * 显示日记模块
   */
  const show = async () => {
    // 【核心修复3】如果状态卡死了，但其实页面被隐藏了，就要强制解除拦截重启它！
    if (isActive && diaryPageContainer && diaryPageContainer.style.display !== 'none') return;
    isActive = true;
    if (diaryPageContainer) diaryPageContainer.style.display = 'block';
    
    // 【关键】注入基础样式
    injectBaseStyles(); 

    await loadAndApplySettings();
    await showDiaryList();
  };

  /**
   * 隐藏并清理日记模块
   */
  const hide = () => {
    if (!isActive) return;

    // 清理 CSS 变量
    const root = document.documentElement;
    root.style.removeProperty('--diary-list-wallpaper');
    root.style.removeProperty('--diary-detail-wallpaper');
    
    // 清理字体样式标签
    removeDynamicStyle(STYLE_IDS.FONT);
    removeDynamicStyle(STYLE_IDS.THEME); // 清理主题色
    // 注意：STYLE_IDS.BASE 通常保留也没关系，但为了干净也可以清理
    // removeDynamicStyle(STYLE_IDS.BASE); 

    const page = diaryPageContainer.querySelector('.page.active');
    if (page) {
      page.classList.remove('active');
      setTimeout(() => {
        diaryPageContainer.style.display = 'none';
        diaryPageContainer.innerHTML = '';
        isActive = false;
      }, 400);
    } else {
      diaryPageContainer.style.display = 'none';
      isActive = false;
    }
  };

  return {
    init,
    show,
    hide,
  };
})();

export { Diary };
