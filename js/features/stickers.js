// 文件路径: /link/js/features/stickers.js

import { AppState, db } from '../state.js';
import { UI, showDynamicIsland, showInputModal, showPage } from '../ui.js';
import { escapeHTML } from '../utils.js';

function parseStickerUrlInput(value) {
  const parsedItems = [];
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');

  lines.forEach(line => {
    const trimmedLine = line.trim();
    if (!trimmedLine) return;

    // 不要求 URL 必须独占一行：兼容 Tab、逗号、分号等批量粘贴分隔方式。
    const protocolMatches = [...trimmedLine.matchAll(/https?:\/\//gi)];
    if (protocolMatches.length === 0) {
      // 保留原来的兼容行为：没有协议的单条地址也允许进入待上传列表。
      parsedItems.push({ src: trimmedLine, explanation: '' });
      return;
    }

    protocolMatches.forEach((match, index) => {
      const start = match.index || 0;
      const end = protocolMatches[index + 1]?.index ?? trimmedLine.length;
      const candidate = trimmedLine.slice(start, end).match(/^https?:\/\/[^\s<>"'`]+/i)?.[0] || '';
      const src = candidate.replace(/[),\]}>'，。；;！？]+$/g, '');
      if (!src) return;

      const explanation = index === 0
        ? trimmedLine.slice(0, start).replace(/[:：\s]+$/, '').trim()
        : '';
      parsedItems.push({ src, explanation });
    });
  });

  return parsedItems;
}

export function setupStickersPage() {
  
  const stickerPage = document.getElementById('page-settings-stickers');
  const groupContainer = document.getElementById('sticker-group-container');
  
  if (!stickerPage || !groupContainer) {
    console.warn("Sticker page elements not found, skipping setup.");
    return;
  }

  const fabContainer = document.getElementById('sticker-fab-container');
  const fabMain = document.getElementById('sticker-fab-main');
  const fabAddGroup = document.getElementById('fab-action-add-group');
  const fabAddSticker = document.getElementById('fab-action-add-sticker');
  const addModalOverlay = document.getElementById('sticker-add-modal-overlay');
  const uploadList = document.getElementById('sticker-upload-list');
  const dropZone = document.getElementById('sticker-upload-dropzone');
  const fileInput = document.getElementById('sticker-file-input');
  const uploadCancelBtn = document.getElementById('sticker-upload-cancel-btn');
  const uploadConfirmBtn = document.getElementById('sticker-upload-confirm-btn');
  const addUrlBtn = document.getElementById('sticker-add-url-btn'); 
  
  // 【新增】获取统一分组的UI元素
  const unifiedGroupingContainer = document.getElementById('sticker-upload-unified-grouping');
  const unifiedGroupSelector = document.getElementById('unified-group-selector');
  const detailPageGrid = document.getElementById('sticker-group-detail-grid');
  const detailHeroTitle = document.getElementById('sticker-group-hero-title');
  const detailHeroCount = document.getElementById('sticker-group-hero-count');
  const detailHeroCover = document.getElementById('sticker-group-cover-img');
  const detailMoreBtn = document.getElementById('sticker-group-detail-more-btn');
// 修改处前两行
  const detailMenu = document.getElementById('sticker-group-context-menu');
  // ▼▼▼ 替换开始 (带自检逻辑) ▼▼▼
  const stickerActionMenu = document.getElementById('sticker-detail-actions-menu');
  if (!stickerActionMenu) console.error("【错误】找不到 id 为 sticker-detail-actions-menu 的菜单元素！");
  let isEditMode = false;
  let isDeleteMode = false; 
  let isMoveMode = false;
  let selectedStickerIndices = []; 
  let currentOpenGroupId = null;

  let newStickersToUpload = [];
let currentUploadPage = 1; // 当前页码
  const ITEMS_PER_PAGE = 50; // 每页显示数量 (50张手机完全不卡)
  // --- 数据处理核心函数 ---

  const loadAndRender = async () => {
    try {
      const groups = await db.stickerGroups.toArray();
      if (!groups || groups.length === 0) {
        const defaultGroup = { id: 'default', name: '默认分组', stickers: [] };
        await db.stickerGroups.put(defaultGroup);
        AppState.stickerGroups = [defaultGroup];
      } else {
        AppState.stickerGroups = groups;
      }
      renderStickerGroups();
    } catch (error) {
      console.error("Failed to load/render sticker groups:", error);
    }
  };
  // ▼▼▼ [修改] 渲染逻辑：变成网格相册卡片 (带按钮版) ▼▼▼
  const renderStickerGroups = () => {
    groupContainer.innerHTML = '';
    
    // 1. 创建网格容器
    const grid = document.createElement('div');
    grid.className = 'sticker-albums-grid'; 

    AppState.stickerGroups.forEach(group => {
      const count = group.stickers?.length || 0;
      
      // 2. 创建单个卡片
      const card = document.createElement('div');
      card.className = 'sticker-album-card';
      
      // 3. 决定封面图
      let coverHtml = '';
      if (count > 0 && group.stickers[0].url) {
          coverHtml = `<img src="${group.stickers[0].url}" loading="lazy" alt="cover">`;
      } else {
          coverHtml = `<svg class="album-placeholder-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"></path></svg>`;
      }

      // 4. 组装 HTML (加入了 album-action-bar)
      card.innerHTML = `
        <div class="album-cover-area">
            ${coverHtml}
        </div>
        <div class="album-info-area">
            <span class="album-name">${escapeHTML(group.name)}</span>
            <span class="album-count">${count} 项</span>
        </div>
        <div class="album-action-bar">
            ${group.id === 'default' ? '' : `
            <button class="album-action-btn rename-btn" title="重命名">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
            `}
            <button class="album-action-btn delete-btn" title="删除">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
        </div>
      `;
      
      // 5. 绑定点击卡片进入详情页
      card.addEventListener('click', (e) => {
          // 如果点击的是下面的按钮，不要进入详情页
          if (e.target.closest('.album-action-btn')) return;
          openGroupDetail(group);
      });

      // 6. 绑定重命名按钮事件 (只针对当前卡片，防止BUG)
      const renameBtn = card.querySelector('.rename-btn');
      if (renameBtn) {
          renameBtn.addEventListener('click', (e) => {
              e.stopPropagation(); // 阻止冒泡，防止进入详情页
              showInputModal('重命名分组', group.name, async (newName) => {
                  if (newName && newName !== group.name) {
                      group.name = newName;
                      await db.stickerGroups.put(group);
                      await loadAndRender(); // 重新渲染列表
                      showDynamicIsland('分组已重命名');
                  }
              });
          });
      }

      // 7. 绑定删除按钮事件
      const deleteBtn = card.querySelector('.delete-btn');
      if (deleteBtn) {
          deleteBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              if (confirm(`确定要删除分组 "${group.name}" 吗？分组内的表情也会被删除。`)) {
                  await db.stickerGroups.delete(group.id);
                  AppState.stickerGroups = AppState.stickerGroups.filter(g => g.id !== group.id);
                  // 如果删的是默认分组，立即补一个新的空默认分组
                  if (group.id === 'default') {
                      const freshDefault = { id: 'default', name: '默认分组', stickers: [] };
                      await db.stickerGroups.put(freshDefault);
                      AppState.stickerGroups.unshift(freshDefault);
                  }
                  await loadAndRender();
                  showDynamicIsland('分组已删除');
              }
          });
      }
      grid.appendChild(card);
    });

    groupContainer.appendChild(grid);
  };

  const openGroupDetail = (group) => {
    currentOpenGroupId = group.id;
     isEditMode = false; 
    // 1. 填充 Hero 头部信息
    detailHeroTitle.textContent = group.name;
    const count = group.stickers ? group.stickers.length : 0;
    detailHeroCount.textContent = `${count} 张表情 · 本地存储`;

    // 2. 设置封面图 (取第一张表情，如果没有则用默认图)
    if (count > 0 && group.stickers[0].url) {
        detailHeroCover.src = group.stickers[0].url;
    } else {
        // 使用一个漂亮的文件夹图标 SVG 作为默认封面
        detailHeroCover.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='1.5'%3E%3Cpath d='M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'/%3E%3C/svg%3E";
    }

    // 3. 清空并渲染网格
    detailPageGrid.innerHTML = ''; 
    
    if (count > 0) {
      group.stickers.forEach((sticker, index) => {
        const item = document.createElement('div');
        item.className = 'sticker-item';
        item.dataset.stickerIndex = index;
        // 这里的 img loading="lazy" 很重要，防止大量图片卡顿
      item.innerHTML = `
              <img src="${sticker.url}" class="sticker-image" style="width:100%; height:100%; object-fit:contain; pointer-events:none;" loading="lazy">
              <p class="sticker-explanation">${escapeHTML(sticker.explanation)}</p>
              <button class="sticker-delete-btn" title="删除" style="transform:scale(0.8); top:2px; right:2px;">&times;</button>
            `;
            detailPageGrid.appendChild(item);
      });
    } else {
      // 美化的空状态
      detailPageGrid.innerHTML = `
        <div class="sticker-empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
            <span>这里空空如也<br>点击右下角 "+" 添加表情吧</span>
        </div>
      `;
    }


    // 跳转页面
    showPage('page-sticker-group-detail');
  };

  // --- 事件监听器 ---

  fabMain.addEventListener('click', () => fabContainer.classList.toggle('active'));
  
  fabAddGroup.addEventListener('click', () => {
    fabContainer.classList.remove('active');
    showInputModal('新建分组', '我的收藏', async (name) => {
      if (name && !AppState.stickerGroups.some(g => g.name === name)) {
        const newGroup = { id: `sg_${Date.now()}`, name: name, stickers: [] };
        await db.stickerGroups.put(newGroup);
        await loadAndRender();
        showDynamicIsland(`分组 "${name}" 已创建`);
      } else if(name) {
        showDynamicIsland('分组名已存在');
      }
    });
  });

  fabAddSticker.addEventListener('click', () => {
    fabContainer.classList.remove('active');
    newStickersToUpload = [];
    renderUploadUI();
    addModalOverlay.classList.add('visible');
  });

  groupContainer.addEventListener('click', async (e) => {
    // ... (这部分代码保持不变)
    const groupId = e.target.closest('.sticker-drawer')?.dataset.groupId;
    if (!groupId) return;
    const group = AppState.stickerGroups.find(g => g.id === groupId);
    if (!group) return;

    if (e.target.closest('.rename-group-btn')) {
      e.preventDefault();
      showInputModal('重命名分组', group.name, async (newName) => {
        if (newName && newName !== group.name) {
          group.name = newName;
          await db.stickerGroups.put(group);
          await loadAndRender();
          showDynamicIsland('分组已重命名');
        }
      });
    } else if (e.target.closest('.delete-group-btn')) {
      e.preventDefault();
      if(confirm(`确定要删除分组 "${group.name}" 吗？分组内的表情也会被删除。`)) {
        await db.stickerGroups.delete(group.id);
        await loadAndRender();
        showDynamicIsland('分组已删除');
      }
    } else if (e.target.closest('.sticker-delete-btn')) {
      const stickerIndex = parseInt(e.target.closest('.sticker-item').dataset.stickerIndex, 10);
      if (!isNaN(stickerIndex)) {
        group.stickers.splice(stickerIndex, 1);
        await db.stickerGroups.put(group);
        await loadAndRender();
      }
    }
  });

  // --- 上传弹窗逻辑 ---
  const closeAddModal = () => {
    addModalOverlay.classList.remove('visible');
    newStickersToUpload = [];
  };

  const updateSaveButtonState = () => {
    // 只在没有待保存内容时禁用，说明为空的情况交给保存按钮给出明确提示。
    uploadConfirmBtn.disabled = newStickersToUpload.length === 0;
  };

  // 【修改后的渲染函数：支持分页，防止卡死】
  const renderUploadUI = () => {
    const totalItems = newStickersToUpload.length;

    // 1. 控制统一分组框的显示/隐藏
    if (totalItems > 5) {
      const groupOptions = AppState.stickerGroups.map(g => `<option value="${g.id}">${escapeHTML(g.name)}</option>`).join('');
      unifiedGroupSelector.innerHTML = groupOptions;
      if (newStickersToUpload.length > 0) {
        // 尝试保持当前选择，如果没有则默认
        const firstId = newStickersToUpload[0].groupId;
        if(firstId) unifiedGroupSelector.value = firstId;
      }
      unifiedGroupingContainer.style.display = 'flex';
    } else {
      unifiedGroupingContainer.style.display = 'none';
    }

    // 2. 准备渲染列表
    uploadList.innerHTML = ''; // 清空列表
    
    if (totalItems === 0) {
      uploadList.appendChild(dropZone);
    } else {
      // --- 分页计算逻辑 ---
      const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
      if (currentUploadPage > totalPages) currentUploadPage = totalPages;
      if (currentUploadPage < 1) currentUploadPage = 1;

      const startIndex = (currentUploadPage - 1) * ITEMS_PER_PAGE;
      const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, totalItems);
      
      // 只获取当前页的数据进行渲染
      const itemsToShow = newStickersToUpload.slice(startIndex, endIndex);
      
      const fragment = document.createDocumentFragment();
      
      // 渲染当前页的卡片
      itemsToShow.forEach(item => {
        const card = document.createElement('div');
        card.className = 'sticker-upload-item';
        card.dataset.id = item.id;
        
        // 只有当总数很少时，才在每个卡片里显示分组选择，否则太卡
        let groupSelectorHtml = '';
        // 这里的逻辑稍微优化了一下，如果总数大于50，单个卡片就不显示分组下拉了，强迫用统一分组，性能更好
        // 如果你非要每个都能选，把下面这个判断去掉即可
        const groupOptions = AppState.stickerGroups.map(g => `<option value="${g.id}" ${g.id === item.groupId ? 'selected' : ''}>${escapeHTML(g.name)}</option>`).join('');
        
        // 如果使用了统一分组栏，单个卡片里为了性能可以不渲染select，或者保留（取决于你需求，这里保留但建议少用）
        const selectHTML = `<select class="sticker-group-selector">${groupOptions}</select>`;

        card.innerHTML = `
          <img src="${item.previewUrl}" class="preview-img" alt="Preview" loading="lazy">
          <div class="upload-details">
            <input type="text" class="sticker-explanation-input" placeholder="图片解释 (必填)" value="${escapeHTML(item.explanation)}">
            ${selectHTML} 
          </div>
          <button class="remove-upload-btn" title="移除"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>`;
        fragment.appendChild(card);
      });

      // --- 插入分页控制条 ---
      if (totalPages > 1) {
        const paginationDiv = document.createElement('div');
        paginationDiv.className = 'upload-pagination-bar';
        paginationDiv.innerHTML = `
          <button type="button" class="page-nav-btn" id="prev-page-btn" ${currentUploadPage === 1 ? 'disabled' : ''}>上一页</button>
          <span class="page-info-text">第 ${currentUploadPage} / ${totalPages} 页 (共 ${totalItems} 张)</span>
          <button type="button" class="page-nav-btn" id="next-page-btn" ${currentUploadPage === totalPages ? 'disabled' : ''}>下一页</button>
        `;
        fragment.appendChild(paginationDiv);
      }

      uploadList.appendChild(fragment);

      // --- 绑定分页按钮事件 ---
      const prevBtn = document.getElementById('prev-page-btn');
      const nextBtn = document.getElementById('next-page-btn');

      if (prevBtn) {
        prevBtn.onclick = (e) => {
          e.preventDefault(); // 防止触发表单提交
          if (currentUploadPage > 1) {
            currentUploadPage--;
            renderUploadUI();
            // 翻页后自动滚回到列表顶部
            uploadList.scrollTop = 0;
          }
        };
      }
      if (nextBtn) {
        nextBtn.onclick = (e) => {
          e.preventDefault();
          if (currentUploadPage < totalPages) {
            currentUploadPage++;
            renderUploadUI();
            uploadList.scrollTop = 0;
          }
        };
      }
    }
    updateSaveButtonState();
  };
 
  const handleFiles = async (files) => {
    // 1. 过滤出所有的图片文件
    const validFiles = Array.from(files).filter(file => file.type.startsWith('image/'));
    if (validFiles.length === 0) return;

    // 2. 使用 for...of 循环配合 await，实现“处理完一张，再处理下一张”的流水线模式
    for (const file of validFiles) {
      await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            const MAX_SIZE = 300; 
            let width = img.width;
            let height = img.height;

            if (width > height) {
              if (width > MAX_SIZE) {
                height *= MAX_SIZE / width;
                width = MAX_SIZE;
              }
            } else {
              if (height > MAX_SIZE) {
                width *= MAX_SIZE / height;
                height = MAX_SIZE;
              }
            }

            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.7);

            newStickersToUpload.push({
              id: `temp_${Date.now()}_${Math.random()}`,
              groupId: 'default',
              explanation: '',
              previewUrl: compressedDataUrl 
            });

            // 【核心护城河：强制清空内存】
            // 苹果 Safari 浏览器很笨，需要手动告诉它把刚用完的画板和图片扔掉
            img.src = ''; 
            canvas.width = 0; 
            canvas.height = 0;

            // 这张图彻底搞定，通知系统可以放行下一张了
            resolve();
          };
          
          // 如果单张图片加载失败，也不要卡死，直接放行下一张
          img.onerror = () => resolve();
          img.src = e.target.result;
        };
        
        // 如果文件读取失败，也直接放行下一张
        reader.onerror = () => resolve();
        reader.readAsDataURL(file);
      });
    }

    // 3. 所有图片都在后台悄悄“排队”压缩完毕后，最后只呼叫一次界面刷新
    renderUploadUI();
  };

  fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); handleFiles(e.dataTransfer.files); });
  uploadCancelBtn.addEventListener('click', closeAddModal);

  addUrlBtn.addEventListener('click', () => {
    showInputModal('输入图片URL (格式: 说明:URL)', '', (value) => {
        if (!value) return;
      const parsedItems = parseStickerUrlInput(value);
      if (parsedItems.length > 0) showDynamicIsland(`${parsedItems.length}个URL已添加至列表`);
      parsedItems.forEach(({ src, explanation }) => {
        if (src) {
          newStickersToUpload.push({
            id: `temp_${Date.now()}_${Math.random()}`,
            groupId: 'default',
            explanation: explanation,
            previewUrl: src
          });
        }
      });
       currentUploadPage = 1; 
      renderUploadUI(); // 添加完所有URL后，统一渲染UI，触发数量检查
    }, { isTextarea: true, position: 'top' });
  });
  
  uploadList.addEventListener('input', (e) => {
    if (e.target.classList.contains('sticker-explanation-input')) {
      const tempId = e.target.closest('.sticker-upload-item').dataset.id;
      const item = newStickersToUpload.find(i => i.id === tempId);
      if (item) item.explanation = e.target.value;
      updateSaveButtonState();
    }
  });

  uploadList.addEventListener('change', (e) => {
    if (e.target.classList.contains('sticker-group-selector')) {
      const tempId = e.target.closest('.sticker-upload-item').dataset.id;
      const item = newStickersToUpload.find(i => i.id === tempId);
      if (item) item.groupId = e.target.value;
    }
  });

uploadList.addEventListener('click', (e) => {
  // 检查被点击的是不是那个“移除”按钮
  if (e.target.closest('.remove-upload-btn')) {
    // 找到这个按钮所在的整个卡片
    const itemCard = e.target.closest('.sticker-upload-item');
    if (!itemCard) return;

    // 获取这个卡片的唯一ID
    const tempId = itemCard.dataset.id;

    // 从“待上传”的表情列表中找到这一项，并把它删掉
    const indexToRemove = newStickersToUpload.findIndex(i => i.id === tempId);
    if (indexToRemove > -1) {
      newStickersToUpload.splice(indexToRemove, 1);
    }

    // 最后，重新渲染上传列表的界面，那个被删除的卡片就会消失了
    renderUploadUI();
  }
});

  // 【新增】为统一分组选择器添加事件监听
  unifiedGroupSelector.addEventListener('change', (e) => {
    const newGroupId = e.target.value;
    // 更新数据模型中所有待上传表情的分组ID
    newStickersToUpload.forEach(item => {
      item.groupId = newGroupId;
    });
    // 重新渲染UI，让每个表情下方的分组选择框也同步更新
    renderUploadUI();
  });


  uploadConfirmBtn.addEventListener('click', async () => {
    // 1. 检查数据
    if (newStickersToUpload.length === 0) return;
    const pendingStickers = [...newStickersToUpload];
    const missingExplanationCount = pendingStickers.filter(item => !String(item.explanation || '').trim()).length;
    if (missingExplanationCount > 0) {
      showDynamicIsland(`还有 ${missingExplanationCount} 个表情没有填写说明`, 'warning');
      return;
    }

    // 2. 【新增】界面立即反馈，防止用户以为卡死了
    const originalText = uploadConfirmBtn.textContent;
    uploadConfirmBtn.textContent = "保存中...";
    uploadConfirmBtn.disabled = true;

    // 3. 【新增】强制给浏览器 50ms 喘息时间来渲染文字变化
    await new Promise(r => setTimeout(r, 50));

    try {
        const updates = new Map();
        for (const item of pendingStickers) {
          // 分组 ID 可能来自 select，统一转成字符串，避免数字/字符串类型不一致。
          const requestedGroupId = String(item.groupId || 'default');
          const targetGroup = AppState.stickerGroups.find(group => String(group.id) === requestedGroupId)
            || AppState.stickerGroups.find(group => String(group.id) === 'default');
          if (!targetGroup) throw new Error('没有找到可保存的表情分组');

          const actualGroupId = String(targetGroup.id);
          if (!updates.has(actualGroupId)) updates.set(actualGroupId, []);
          updates.get(actualGroupId).push({ url: item.previewUrl, explanation: String(item.explanation).trim() });
        }

        const groupsToUpdate = [];
        let savedCount = 0;
        for (const [groupId, stickersToAdd] of updates) {
          const group = AppState.stickerGroups.find(item => String(item.id) === groupId);
          if (!group) throw new Error('保存时找不到对应的表情分组');
          groupsToUpdate.push({
            ...group,
            stickers: [...(Array.isArray(group.stickers) ? group.stickers : []), ...stickersToAdd]
          });
          savedCount += stickersToAdd.length;
        }

        await db.stickerGroups.bulkPut(groupsToUpdate);
        
        await loadAndRender();
        closeAddModal();
        showDynamicIsland(`${savedCount}个表情已保存`, 'success');

    } catch (err) {
        console.error(err);
        alert("保存出错: " + err.message);
    } finally {
        // 恢复按钮状态
        uploadConfirmBtn.textContent = originalText;
        updateSaveButtonState();
    }
  });
  
// 修改处前两行
  // 1. 详情页里的删除单个表情
  if (detailPageGrid) {
// --- 修改开始 ---
      detailPageGrid.addEventListener('click', async (e) => {
        const item = e.target.closest('.sticker-item');
        if (!item) return;
        const index = parseInt(item.dataset.stickerIndex, 10);
        const group = AppState.stickerGroups.find(g => g.id === currentOpenGroupId);
        if (!group || !group.stickers[index]) return;

        // 如果是编辑模式
        if (isEditMode) {
            showInputModal('编辑提示词', group.stickers[index].explanation, async (newText) => {
                if (newText !== null) {
                    group.stickers[index].explanation = newText;
                    await db.stickerGroups.put(group);
                    openGroupDetail(group); 
                    showDynamicIsland('提示词已更新');
                    isEditMode = false; // 编辑完退出
                }
            });
            return;
        }

        // 如果是删除模式
        if (isDeleteMode) {
             const isSelected = item.classList.toggle('selected');
            if (isSelected) {
                selectedStickerIndices.push(index);
            } else {
                selectedStickerIndices = selectedStickerIndices.filter(i => i !== index);
            }
            // 更新操作条文字
            document.getElementById('sticker-selected-count').textContent = `已选择 ${selectedStickerIndices.length} 项`;
            return;
         }
        // 如果是换组模式
        if (isMoveMode) {
            const isSelected = item.classList.toggle('selected');
            if (isSelected) {
                selectedStickerIndices.push(index);
            } else {
                selectedStickerIndices = selectedStickerIndices.filter(i => i !== index);
            }
            document.getElementById('sticker-move-selected-count').textContent = `已选择 ${selectedStickerIndices.length} 项`;
            return;
        }
        if (e.target.closest('.sticker-delete-btn')) {
            group.stickers.splice(index, 1);
            await db.stickerGroups.put(group);
            openGroupDetail(group); 
            renderStickerGroups(); 
        }
      });
// --- 修改结束 ---
// 修改处后两行
  }
// 修改处前两行
  // 2. 详情页右上角菜单 (现在改为绑定新菜单)
  if (detailMoreBtn && stickerActionMenu) {
// --- 替换开始 ---
      detailMoreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          // 只负责切换显示状态，不干涉样式
          stickerActionMenu.classList.toggle('active');
      });

      stickerActionMenu.addEventListener('click', (e) => {
          const actionItem = e.target.closest('.action-menu-item');
          if (!actionItem) return;
          const action = actionItem.dataset.action;
          
          stickerActionMenu.classList.remove('active');

          if (action === 'edit-mode') {
              isEditMode = true;
              isDeleteMode = false; // 开启编辑时关闭删除
              showDynamicIsland('编辑模式：点击表情修改文字');
           } else if (action === 'delete-mode') {
              isDeleteMode = true;
              isEditMode = false;
              selectedStickerIndices = []; // 重置选中
              document.getElementById('sticker-multi-delete-bar').style.display = 'flex';
              document.getElementById('sticker-selected-count').textContent = '已选择 0 项';
              showDynamicIsland('已进入批量删除模式');
          } else if (action === 'move-mode') {
              isMoveMode = true;
              isDeleteMode = false;
              isEditMode = false;
              selectedStickerIndices = [];
              document.getElementById('sticker-multi-move-bar').style.display = 'flex';
              document.getElementById('sticker-move-selected-count').textContent = '已选择 0 项';
              showDynamicIsland('请选择要移动的表情');
          }
      });
      document.addEventListener('click', (e) => {

          if (!detailMoreBtn.contains(e.target) && !stickerActionMenu.contains(e.target)) {
              stickerActionMenu.classList.remove('active');
          }
      });
  }
document.getElementById('sticker-multi-delete-cancel').addEventListener('click', () => {
      isDeleteMode = false;
      document.getElementById('sticker-multi-delete-bar').style.display = 'none';
      // 移除所有图片的选中样式
      detailPageGrid.querySelectorAll('.sticker-item').forEach(el => el.classList.remove('selected'));
  });
  // 批量删除：确认按钮
  document.getElementById('sticker-multi-delete-confirm').addEventListener('click', async () => {
      if (selectedStickerIndices.length === 0) return;
      if (confirm(`确定要删除选中的 ${selectedStickerIndices.length} 张表情吗？`)) {
          const group = AppState.stickerGroups.find(g => g.id === currentOpenGroupId);
          // 核心：过滤掉选中的序号
          group.stickers = group.stickers.filter((_, i) => !selectedStickerIndices.includes(i));
          
          await db.stickerGroups.put(group);
          document.getElementById('sticker-multi-delete-bar').style.display = 'none';
          isDeleteMode = false;
          openGroupDetail(group); // 重新刷新详情页
          showDynamicIsland('批量删除成功');
      }
  });
   // 换组：取消按钮
  document.getElementById('sticker-multi-move-cancel').addEventListener('click', () => {
      isMoveMode = false;
      document.getElementById('sticker-multi-move-bar').style.display = 'none';
      detailPageGrid.querySelectorAll('.sticker-item').forEach(el => el.classList.remove('selected'));
  });
  // 换组：点击“选择目标分组”按钮
  document.getElementById('sticker-multi-move-next').addEventListener('click', () => {
      if (selectedStickerIndices.length === 0) return;
      const listContainer = document.getElementById('sticker-move-group-list');
      listContainer.innerHTML = '';
      
      // 生成除了当前分组以外的其他分组列表
      AppState.stickerGroups.forEach(group => {
          if (group.id === currentOpenGroupId) return;
          const li = document.createElement('li');
          li.className = 'selection-list-item';
          li.innerHTML = `<span class="item-text">${escapeHTML(group.name)}</span>`;
          li.onclick = () => performMove(group.id);
          listContainer.appendChild(li);
      });
      document.getElementById('sticker-move-modal-overlay').classList.add('visible');
  });
  // 核心：执行移动逻辑
  async function performMove(targetGroupId) {
      const sourceGroup = AppState.stickerGroups.find(g => g.id === currentOpenGroupId);
      const targetGroup = AppState.stickerGroups.find(g => g.id === targetGroupId);
      
      // 1. 获取选中的表情数据
      const stickersToMove = selectedStickerIndices.map(i => sourceGroup.stickers[i]);
      // 2. 从原组删除 (注意要从后往前删，或者用 filter)
      sourceGroup.stickers = sourceGroup.stickers.filter((_, i) => !selectedStickerIndices.includes(i));
      // 3. 添加到新组
      targetGroup.stickers.push(...stickersToMove);
      
      // 4. 保存到数据库
      await db.stickerGroups.bulkPut([sourceGroup, targetGroup]);
      
      // 5. UI 重置
      document.getElementById('sticker-move-modal-overlay').classList.remove('visible');
      document.getElementById('sticker-multi-move-bar').style.display = 'none';
      isMoveMode = false;
      openGroupDetail(sourceGroup); // 刷新当前页
      showDynamicIsland(`已移动 ${stickersToMove.length} 张表情`);
  }
  document.getElementById('sticker-move-modal-cancel').onclick = () => {
      document.getElementById('sticker-move-modal-overlay').classList.remove('visible');
  };
  // --- 初始化 ---
  loadAndRender();
}
