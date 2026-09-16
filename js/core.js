import { AppState, db } from './state.js'; 
import { UI, showDynamicIsland } from './ui.js';
import { compressImageDataUrl } from './utils.js';

 /* --- 3.1 动态页面与菜单生成 --- */
  // 用于创建那些结构简单、内容固定的页面（如备忘录、恋爱日常）和设置菜单
export  function setupDynamicContent() {
    const phoneScreenContainer = document.querySelector('.phone-screen');
    const simplePagesData = [{ id: 'page-phone', title: '电话', backTarget: 'home', content: '这里是电话页面的内容。' }, { id: 'page-settings-sound', title: '声音设置', backTarget: 'page-settings', content: '这里是声音设置的页面内容。' }, { id: 'page-settings-data', title: '数据设置', backTarget: 'page-settings', content: '这里是数据设置的页面内容。' }];

   simplePagesData.forEach(data => {
      const page = document.createElement('div');
      page.id = data.id;
      page.className = 'app-page';
      page.innerHTML = `
              <div class="app-header">
                  <button class="back-button header-button" data-target="${data.backTarget}">
                      <div class="back-button-icon-wrapper"><svg fill="none" viewBox="0 0 24 24"><polyline points="15 6 9 12 15 18"></polyline></svg></div>
                  </button>
                  <h1 class="app-title">${data.title}</h1>
              </div>
              <div class="app-content">${data.content}</div>`;
      phoneScreenContainer.appendChild(page);
    });

    const settingsPage = document.getElementById('page-settings');
    if (settingsPage) {
      const settingsCards = settingsPage.querySelectorAll('.settings-card');
      const settingsData = [
        [{ page: 'page-settings-account', icon: '<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>', text: '用户设置' }],
        [{ page: 'page-settings-api', icon: '<svg viewBox="0 0 24 24"><path d="M7 8l-4 4 4 4M17 8l4 4-4 4M14 4l-4 16"></path></svg>', text: 'API设置' }, { page: 'page-settings-screen', icon: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="16" x2="12" y2="21"></line></svg>', text: '屏幕设置' }, { page: 'page-settings-sound', icon: '<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>', text: '声音设置' }, { page: 'page-settings-data', icon: '<svg viewBox="0 0 24 24"><path d="M22 19V5M17 19v-7M12 19v-4M7 19v-2"></path></svg>', text: '数据设置' }]
      ];
      if (settingsCards.length === settingsData.length) {
        settingsCards.forEach((card, index) => {
          const fragment = document.createDocumentFragment();
          settingsData[index].forEach(item => {
            const div = document.createElement('div');
            div.className = 'list-item';
            div.dataset.page = item.page;
            div.innerHTML = `<div class="settings-item-icon">${item.icon}</div><span class="settings-item-text">${item.text}</span><div class="settings-item-arrow"><svg fill="none" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg></div>`;
            fragment.appendChild(div);
          });
          card.innerHTML = '';
          card.appendChild(fragment);
        });
      }
    }

    const accountSettingsPage = document.getElementById('page-settings-account');
    if (accountSettingsPage) {
      const card = accountSettingsPage.querySelector('.settings-card');
      const accountSettingsData = [{ page: 'page-settings-persona', icon: '<svg viewBox="0 0 24 24"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>', text: '人设' }, { page: 'page-settings-social', icon: '<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>', text: '交际圈' }, { page: 'page-settings-stickers', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>', text: '表情包' }];
      const fragment = document.createDocumentFragment();
      accountSettingsData.forEach(item => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.dataset.page = item.page;
        div.innerHTML = `<div class="settings-item-icon">${item.icon}</div><span class="settings-item-text">${item.text}</span><div class="settings-item-arrow"><svg fill="none" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg></div>`;
        fragment.appendChild(div);
      });
      card.innerHTML = '';
      card.appendChild(fragment);
    }

    const chatNavTemplate = document.querySelector('#page-chat .chat-bottom-nav');
    if (chatNavTemplate) {
      const syncChatBottomNav = (pageId, activePageId) => {
        const page = document.getElementById(pageId);
        if (!page) return;
        const existingNav = page.querySelector('.chat-bottom-nav');
        const hasContactsItem = existingNav?.querySelector('[data-chat-section="contacts-content"]');
        const nav = hasContactsItem ? existingNav : chatNavTemplate.cloneNode(true);
        nav.querySelectorAll('.nav-item.active').forEach(item => item.classList.remove('active'));
        nav.querySelector(`[data-page="${activePageId}"]`)?.classList.add('active');
        if (existingNav && nav !== existingNav) existingNav.replaceWith(nav);
        else if (!existingNav) page.appendChild(nav);
      };
      syncChatBottomNav('page-dynamics', 'page-dynamics');
      syncChatBottomNav('page-profile', 'page-profile');
    }
  }

   /* --- 3.2 统一图片上传处理 --- */
  // 为所有图片上传功能（如头像、壁纸、主屏幕照片）提供统一的处理逻辑
export  function setupImageUploader(inputId, imageId) {
    const inputElement = document.getElementById(inputId);
    if (!inputElement) return;

    inputElement.addEventListener('change', async (event) => {
      const file = event.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = async (e) => {
          const imageUrl = await compressImageDataUrl(e.target.result);
          const imgElement = document.getElementById(imageId);
          if (imgElement) {
            imgElement.src = imageUrl;
          }

          if (imageId in AppState.homeScreenImages) {
            AppState.homeScreenImages[imageId] = imageUrl;
            await db.appData.put({
              key: 'homeScreenImages',
              value: AppState.homeScreenImages
            });
          }

          if (imageId === 'char-modal-avatar-preview') {
            UI.charModalAvatarPlaceholder.style.display = 'none';
          }
        };
        reader.readAsDataURL(file);
      }
    });
  }
