// 文件路径: /js/features/gallery.js

import { AppState, DEFAULT_AVATAR_SRC, db } from '../state.js';
import { showPage, showDynamicIsland, showInputModal } from '../ui.js'; // <-- 修改此行
import { addTapListener, escapeHTML } from '../utils.js';
import { isAppleMobile, isNativeRuntime, openImageForAppleSave, saveImageToNativeGallery, shareBlobToApple } from '../native-bridge.js';
import { dataUrlToBlob, openCharacterImageGenSettingsModal } from './image-gen.js';
import { getVectorApiConfig, getApiEmbedding, apiCosineSimilarity } from './vector-engine.js';
let currentOpenGroupId = null; 

function getGalleryVectorSignature(config = {}) {
    return [
        String(config.provider || ''),
        String(config.url || ''),
        String(config.model || ''),
        String(config.embeddingPath || '')
    ].join('|');
}

function getCompatibleCharacterIds(charId) {
    if (charId === null || charId === undefined || String(charId) === '') return [];
    const ids = [charId, String(charId)];
    if (/^-?\d+$/.test(String(charId))) {
        const numericId = Number(charId);
        if (Number.isSafeInteger(numericId)) ids.push(numericId);
    }
    return [...new Set(ids)];
}

function queryByCompatibleCharacterId(table, charId) {
    return table.where('charId').anyOf(getCompatibleCharacterIds(charId));
}

export async function getGalleryImagesForCharacter(charId) {
    if (getCompatibleCharacterIds(charId).length === 0) return [];
    return await queryByCompatibleCharacterId(db.galleryImages, charId).toArray();
}
// --- 图片占位符生成函数 ---
// 我将为你生成一些简约的黑白几何图案作为占位符
function generatePlaceholderSvg(seed) {
    const size = 100;
    const bgColor = '#f0f0f0';
    const fgColor = '#888';
    // 使用 seed 生成伪随机但固定的图案
    const patternType = seed % 4;
    let pattern = '';

    switch (patternType) {
        case 0: // 斜线
            pattern = `<line x1="0" y1="100" x2="100" y2="0" stroke="${fgColor}" stroke-width="10"/>
                       <line x1="0" y1="50" x2="50" y2="0" stroke="${fgColor}" stroke-width="10"/>
                       <line x1="50" y1="100" x2="100" y2="50" stroke="${fgColor}" stroke-width="10"/>`;
            break;
        case 1: // 圆点
            pattern = `<circle cx="25" cy="25" r="10" fill="${fgColor}"/>
                       <circle cx="75" cy="75" r="10" fill="${fgColor}"/>
                       <circle cx="25" cy="75" r="10" fill="${fgColor}"/>
                       <circle cx="75" cy="25" r="10" fill="${fgColor}"/>`;
            break;
        case 2: // 十字
            pattern = `<rect x="45" y="10" width="10" height="80" fill="${fgColor}"/>
                       <rect x="10" y="45" width="80" height="10" fill="${fgColor}"/>`;
            break;
        case 3: // 方块
            pattern = `<rect x="15" y="15" width="30" height="30" fill="${fgColor}"/>
                       <rect x="55" y="55" width="30" height="30" fill="${fgColor}"/>`;
            break;
    }

    const svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
                   <rect width="${size}" height="${size}" fill="${bgColor}"/>
                   ${pattern}
                 </svg>`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function getGalleryImageCardHtml(img) {
    return `
        <div class="image-placeholder" style="background-image: url('${escapeHTML(img.url)}')"></div>
        <div class="image-overlay">
            <div class="image-actions" style="flex-wrap: wrap; justify-content: flex-end; max-width: 70px;">
                <button class="image-action-btn view-btn" title="打开保存">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                </button>
                <button class="image-action-btn move-group-btn" title="更换角色/分组">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h5l2 3h11v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path><path d="M3 7V5a2 2 0 0 1 2-2h4l2 4"></path></svg>
                </button>
                <button class="image-action-btn edit-btn" title="编辑描述">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                </button>
                <button class="image-action-btn delete-btn" title="删除">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            </div>
            <p class="image-description-overlay">${escapeHTML(img.description || '未命名')}</p>
        </div>
    `;
}

function getGalleryPreviewModal() {
    let modal = document.getElementById('gallery-image-preview-modal-overlay');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'gallery-image-preview-modal-overlay';
    modal.className = 'modal-overlay';
    modal.style.cssText = 'position: fixed; inset: 0; width: 100%; height: 100%; z-index: 5000; padding: 18px; box-sizing: border-box; background: rgba(0,0,0,0.82);';
    modal.innerHTML = `
        <div class="modal-card" style="width: 100%; max-width: 360px; padding: 12px; background: #111; color: #fff; border-radius: 16px; box-sizing: border-box;">
            <div style="display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 10px;">
                <a class="gallery-preview-save-btn btn btn-primary" download="gallery-image.jpg" style="background: #fff; color: #111; border: 0; border-radius: 10px; padding: 8px 12px; text-decoration: none; font-size: 13px; font-weight: 600;">保存图片</a>
                <button type="button" class="gallery-preview-close-btn" style="background: rgba(255,255,255,0.14); color: #fff; border: 0; border-radius: 10px; padding: 8px 12px; font-size: 13px;">关闭</button>
            </div>
            <img class="gallery-preview-img" src="" alt="相册图片" style="display: block; width: 100%; max-height: 70vh; object-fit: contain; border-radius: 10px; background: #222;">
        </div>
    `;

    const closeModal = () => modal.classList.remove('visible');
    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('.gallery-preview-close-btn')) {
            closeModal();
        }
    });
    document.body.appendChild(modal);
    return modal;
}

function openGalleryImagePreview(image) {
    if (!image?.url) return;
    const modal = getGalleryPreviewModal();
    const previewImg = modal.querySelector('.gallery-preview-img');
    const saveBtn = modal.querySelector('.gallery-preview-save-btn');
    const fileName = `gallery-image-${image.id || Date.now()}.jpg`;
    previewImg.src = image.url;
    previewImg.alt = image.description || '相册图片';
    saveBtn.onclick = async () => {
        try {
            if (isNativeRuntime()) {
                const saved = await saveImageToNativeGallery(image.url, fileName);
                showDynamicIsland(saved ? '图片已保存到系统相册' : '已取消保存');
                return;
            }
            let blob = image.url.startsWith('data:') ? dataUrlToBlob(image.url) : null;
            if (!blob) {
                const response = await fetch(image.url);
                if (!response.ok) throw new Error(`图片读取失败: ${response.status}`);
                blob = await response.blob();
            }
            const appleShareResult = await shareBlobToApple(blob, fileName);
            if (appleShareResult === 'shared' || appleShareResult === 'cancelled') return;
            if (isAppleMobile() && (appleShareResult === 'unavailable' || appleShareResult === 'failed')) {
                openImageForAppleSave(image.url);
                showDynamicIsland('请在打开的图片页面长按保存');
                return;
            }
            const blobUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            setTimeout(() => {
                link.remove();
                URL.revokeObjectURL(blobUrl);
            }, 3000);
        } catch (error) {
            console.warn('图片保存失败，改为直接打开预览链接。', error);
            if (isAppleMobile()) {
                openImageForAppleSave(image.url);
                showDynamicIsland('请在打开的图片页面长按保存');
                return;
            }
            window.open(image.url, '_blank', 'noopener,noreferrer');
        }
    };
    modal.classList.add('visible');
}

async function openMoveImageGroupModal(imageId, onSaved) {
    const image = await db.galleryImages.get(imageId);
    if (!image) return;
    const characters = AppState.characterProfiles.filter(char => !char.isGroup);
    const modal = document.createElement('div');
    modal.className = 'modal-overlay visible';
    modal.style.cssText = 'position: fixed; inset: 0; width: 100%; height: 100%; z-index: 5000;';
    modal.innerHTML = `
        <div class="modal-card">
            <h3>更换角色 / 分组</h3>
            <div class="form-group" style="margin-top: 15px;">
                <label for="gallery-move-char-select" style="display: block; margin-bottom: 5px; font-weight: 500;">所属角色:</label>
                <select id="gallery-move-char-select" class="styled-select">
                    ${characters.map(char => `<option value="${char.id}">${escapeHTML(char.name)}</option>`).join('')}
                </select>
            </div>
            <div class="form-group" style="margin-top: 15px;">
                <label for="gallery-move-group-select" style="display: block; margin-bottom: 5px; font-weight: 500;">所属分组:</label>
                <select id="gallery-move-group-select" class="styled-select">
                    <option value="">不指定分组</option>
                </select>
            </div>
            <div class="modal-buttons" style="margin-top: 20px;">
                <button type="button" class="btn btn-secondary gallery-move-cancel-btn">取消</button>
                <button type="button" class="btn btn-primary gallery-move-save-btn">保存</button>
            </div>
        </div>
    `;

    const closeModal = () => modal.remove();
    const charSelect = modal.querySelector('#gallery-move-char-select');
    const groupSelect = modal.querySelector('#gallery-move-group-select');

    const populateGroups = async (charId, preferredGroupId = '') => {
        const groups = await queryByCompatibleCharacterId(db.galleryGroups, charId).toArray();
        groupSelect.innerHTML = '<option value="">不指定分组</option>' + groups.map(group => `<option value="${group.id}">${escapeHTML(group.name)}</option>`).join('');
        const preferredValue = preferredGroupId ? String(preferredGroupId) : '';
        groupSelect.value = groups.some(group => String(group.id) === preferredValue) ? preferredValue : '';
    };

    charSelect.value = String(image.charId ?? characters[0]?.id ?? '');
    await populateGroups(charSelect.value, image.groupId || '');

    charSelect.addEventListener('change', async () => {
        await populateGroups(charSelect.value, '');
    });

    modal.addEventListener('click', async (event) => {
        if (event.target === modal || event.target.closest('.gallery-move-cancel-btn')) {
            closeModal();
            return;
        }
        if (event.target.closest('.gallery-move-save-btn')) {
            const nextCharId = charSelect.value;
            const nextGroupId = groupSelect.value ? parseInt(groupSelect.value, 10) : null;
            await db.galleryImages.update(imageId, { charId: nextCharId, groupId: nextGroupId });
            showDynamicIsland('图片角色和分组已更新');
            closeModal();
            if (typeof onSaved === 'function') await onSaved();
        }
    });
    document.body.appendChild(modal);
}


/**
 * 【全新替换】根据角色ID渲染整个相册内容（包括分组和图片）
 * @param {string} charId - 角色ID
 */
async function renderImageGrid(charId) {
    const container = document.querySelector('#page-gallery .image-groups-list');
    if (!container) return;
    container.innerHTML = ''; // 清空所有内容
    // 1. 从数据库并行获取所需数据
    const [groups, allImages] = await Promise.all([
        queryByCompatibleCharacterId(db.galleryGroups, charId).toArray(),
        queryByCompatibleCharacterId(db.galleryImages, charId).reverse().sortBy('timestamp')
    ]);
    // 2. 如果没有任何图片，显示空状态提示
    if (allImages.length === 0) {
        container.innerHTML = '<p class="empty-gallery-text">这个相册还是空的，点击右上角添加第一张图片吧！</p>';
        return;
    }
    // 3. 将图片分类到“已分组”和“未分组”
    const groupedImages = new Map();
    const ungroupedImages = [];
    for (const img of allImages) {
        if (img.groupId && img.groupId !== "null") { // 确保 groupId 有效
            if (!groupedImages.has(img.groupId)) {
                groupedImages.set(img.groupId, []);
            }
            groupedImages.get(img.groupId).push(img);
        } else {
            ungroupedImages.push(img);
        }
    }
    const fragment = document.createDocumentFragment();
    // 4. 渲染所有分组及其下的图片
groups.forEach(group => {
    const imagesInGroup = groupedImages.get(group.id) || []; // 如果没有图片，则为空数组
    // 创建分组卡片
    const groupCard = document.createElement('div');
    groupCard.className = 'image-group-card';
    groupCard.dataset.groupId = group.id; // 添加 data-id 以便后续操作
    // 如果分组内有图片，用第一张做封面；否则使用占位符
    const coverImage = imagesInGroup.length > 0 
        ? imagesInGroup[0].url 
        : generatePlaceholderSvg(group.id); // 使用占位符函数
    groupCard.innerHTML = `
        <div class="group-cover-image" style="background-image: url('${escapeHTML(coverImage)}');"></div>
        <div class="group-info">
            <div class="info-main">
                <h3 class="group-title">${escapeHTML(group.name)}</h3>
                <div class="group-status">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                    <span>${imagesInGroup.length} 张图片</span>
                </div>
            </div>
          <div class="info-action">
                <button class="group-action-btn group-edit-btn" title="编辑分组名">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                </button>
                <button class="group-action-btn group-delete-btn" title="删除分组">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            </div>
        </div>
    `;
    fragment.appendChild(groupCard);
});
    // 5. 渲染所有未分组的图片
    if (ungroupedImages.length > 0) {
        // 添加日期分隔符或标题
        const separator = document.createElement('div');
        separator.className = 'date-separator';
        separator.textContent = '未分组照片';
        fragment.appendChild(separator);
        // 创建图片网格
        const grid = document.createElement('div');
        grid.className = 'image-grid';
        
        ungroupedImages.forEach(img => {
            const card = document.createElement('div');
            card.className = 'image-card';
            card.dataset.imageId = img.id;
            card.innerHTML = getGalleryImageCardHtml(img);

            grid.appendChild(card);
        });
        fragment.appendChild(grid);
    }
    // 6. 将所有生成的内容一次性添加到页面
    container.appendChild(fragment);
}

function renderGalleryCharacterImageSettings(charId) {
    const container = document.getElementById('gallery-character-image-settings');
    if (!container) return;
    const char = AppState.characterProfiles.find(item => String(item.id) === String(charId));
    if (!char || char.isGroup) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = `
        <button type="button" class="gallery-character-settings-card is-collapsed" id="gallery-char-image-settings-open">
            <div class="gallery-character-settings-title">
                <strong>${escapeHTML(char.name)} 的生图设置</strong>
                <span>点击调整</span>
            </div>
            <div class="gallery-character-settings-summary">
                <span>${char.imageGenEnabled === false ? '已关自动生图' : '已开自动生图'}</span>
                <span>${char.imageGenMatchMode === 'gen_only' ? '纯生图' : char.imageGenMatchMode === 'match_only' ? '纯匹配相册' : '匹配不到再生图'}</span>
                <span>${char.imageGenFaceEnabled ? '已开锁脸' : '未开锁脸'}</span>
                <span>${char.imageGenDefaultStyle ? '有正面词' : '无正面词'}</span>
                <span>${char.imageGenNegative ? '有负面词' : '无负面词'}</span>
            </div>
        </button>
    `;

    document.getElementById('gallery-char-image-settings-open')?.addEventListener('click', () => {
        openCharacterImageGenSettingsModal({
            charId: char.id,
            onSaved: async () => {
                renderGalleryCharacterImageSettings(char.id);
                await renderImageGrid(char.id);
            }
        });
    });
}



/**
 * 渲染角色选择器 (适配 iOS 样式)
 */
function renderCharacterSelector() {
    const wrapper = document.querySelector('#page-gallery .character-wrapper');
    if (!wrapper) return;
    wrapper.innerHTML = ''; // 清空
    const fragment = document.createDocumentFragment();
    const galleryCharacters = AppState.characterProfiles.filter(char => !char.isGroup);
    galleryCharacters.forEach((char, index) => {
        const avatar = document.createElement('div');
        avatar.className = 'character-avatar';
        // 默认选中第一个角色
        if (index === 0) {
            avatar.classList.add('active');
        }
        avatar.dataset.charId = char.id;
        
        // ▼▼▼ 注意这里的结构变化：增加了 .img-wrapper ▼▼▼
        avatar.innerHTML = `
            <div class="img-wrapper">
                <img src="${char.avatar || DEFAULT_AVATAR_SRC}" alt="${escapeHTML(char.name)}">
            </div>
            <span>${escapeHTML(char.name)}</span>
        `;
        fragment.appendChild(avatar);
    });
    // 添加 "新角色" 按钮
    const addNew = document.createElement('div');
    addNew.className = 'character-avatar add-new-character';
    addNew.innerHTML = `
        <div class="img-wrapper">
            <div class="add-icon">+</div>
        </div>
        <span>新建</span>
    `;
    fragment.appendChild(addNew);
    wrapper.appendChild(fragment);
    // 初始加载第一个角色的图片
    if (galleryCharacters.length > 0) {
        renderGalleryCharacterImageSettings(galleryCharacters[0].id);
        renderImageGrid(galleryCharacters[0].id);
    } else {
        renderGalleryCharacterImageSettings(null);
    }
}

// ==========================================================
// == 【新增】添加图片弹窗的核心逻辑
// ==========================================================
function setupImageUploadModal() {
    // --- 获取DOM元素 ---
    const modalOverlay = document.getElementById('gallery-add-image-modal-overlay');
    const dropZone = document.getElementById('gallery-upload-dropzone');
    const listContainer = document.getElementById('gallery-upload-list');
    const fileInput = document.getElementById('gallery-image-input');
    const closeBtn = document.getElementById('gallery-upload-close-btn');
    const cancelBtn = document.getElementById('gallery-upload-cancel-btn');
    const confirmBtn = document.getElementById('gallery-upload-confirm-btn');
    const addUrlBtn = document.getElementById('gallery-add-url-btn');
   const charSelect = document.getElementById('gallery-char-select');
    const unifiedGroupContainer = document.getElementById('unified-group-selector-group');
    const unifiedGroupSelect = document.getElementById('gallery-unified-group-select');
    const createGroupBtn = document.getElementById('gallery-create-new-group-btn');
    let newImagesToUpload = [];// 存储待上传图片对象 {id, previewUrl, description, groupId}
    // --- 辅助函数 ---
    const closeModal = () => {
        newImagesToUpload = [];
        modalOverlay.classList.remove('visible');
    };
    const updateSaveButtonState = () => {
        const allFilled = newImagesToUpload.every(item => item.description.trim() !== '');
        confirmBtn.disabled = newImagesToUpload.length === 0 || !allFilled;
    };
     const populateCharacterSelect = () => {
        charSelect.innerHTML = '';
        AppState.characterProfiles.filter(char => !char.isGroup).forEach(char => {
            const option = document.createElement('option');
            option.value = char.id;
            option.textContent = char.name;
            charSelect.appendChild(option);
        });
    };
    /** 【新增】根据角色ID获取并填充分组下拉菜单 */
 const populateGroupSelect = async (selectElement, charId) => {
        selectElement.innerHTML = '<option value="">不指定分组</option>';
        if (!charId) return;
        const groups = await queryByCompatibleCharacterId(db.galleryGroups, charId).toArray();
        groups.forEach(group => {
            const option = document.createElement('option');
            option.value = group.id;
            option.textContent = group.name;
            selectElement.appendChild(option);
        });
    };
    
    
    /** 【新增】创建新分组的逻辑 */
     const createNewGroup = async () => {
        const selectedCharId = charSelect.value; // 从弹窗内的选择器获取
        if (!selectedCharId) return;
        showInputModal('输入新分组名称', '', async (name) => {
            if (name && name.trim()) {
                try {
                    const newGroupId = await db.galleryGroups.add({ charId: selectedCharId, name: name.trim() });
                    showDynamicIsland(`分组“${name.trim()}”已创建`);
                    // 重新填充当前打开的所有选择器并选中新创建的
                    await populateGroupSelect(unifiedGroupSelect, selectedCharId);
                    unifiedGroupSelect.value = newGroupId;
                    
                    const allIndividualSelects = listContainer.querySelectorAll('.group-select');
                    for (const sel of allIndividualSelects) {
                        await populateGroupSelect(sel, selectedCharId);
                        sel.value = newGroupId;
                    }
                } catch (error) {
                    console.error('创建分组失败:', error);
                    alert('创建分组失败！');
                }
            }
        });
    };
    /** 【大幅修改】渲染整个上传UI */
    const renderUploadUI = async () => {
        const selectedCharId = charSelect.value;
        // 1. 根据图片数量决定显示哪个分组选择器
        const showUnifiedGroupSelector = newImagesToUpload.length >= 5;
        unifiedGroupContainer.style.display = showUnifiedGroupSelector ? 'flex' : 'none';
        if (showUnifiedGroupSelector) {
            await populateGroupSelect(unifiedGroupSelect, selectedCharId);
        }
        // 2. 渲染图片列表 (内部逻辑与之前版本类似，但populateGroupSelect依赖selectedCharId)
        if (newImagesToUpload.length === 0) { 
            listContainer.innerHTML = '';
            dropZone.style.display = 'flex';
        } else {
            dropZone.style.display = 'none';
            listContainer.innerHTML = '';
          const fragment = document.createDocumentFragment();
            for (const item of newImagesToUpload) {
                const card = document.createElement('div');
                card.className = 'upload-item';
                card.dataset.id = item.id;
                const showIndividualSelector = !showUnifiedGroupSelector;
                card.innerHTML = `
                    <img src="${item.previewUrl}" class="preview-img" alt="Preview">
                    <div class="upload-details">
                        <input type="text" class="image-description-input" placeholder="图片描述 (必填)" value="${escapeHTML(item.description)}">
                        ${showIndividualSelector ? `
                        <div class="upload-selectors">
                            <select class="group-select"></select>
                        </div>
                        ` : ''}
                    </div>
                    <button class="remove-upload-btn">&times;</button>
                `;
                fragment.appendChild(card);
                if (showIndividualSelector) {
                    const select = card.querySelector('.group-select');
                    await populateGroupSelect(select, selectedCharId);
                    select.value = item.groupId || '';
                }
            }
            listContainer.appendChild(fragment);
        }
        updateSaveButtonState();
    };
 const handleFiles = async (files) => {
        const imageFiles = Array.from(files).filter(file => file.type.startsWith('image/'));
        if (imageFiles.length === 0) return;
        // 创建一个“承诺”列表，每个“承诺”代表一个文件读取+压缩任务
        const readPromises = imageFiles.map(file => {
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    // --- 开始压缩逻辑 ---
                    const img = new Image();
                    img.onload = () => {
                        const canvas = document.createElement('canvas');
                        // 设定最大边长为 1280px (这个尺寸在手机上看非常清晰，但体积很小)
                        const MAX_SIZE = 1280; 
                        let width = img.width;
                        let height = img.height;
                        // 计算等比例缩放
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
                        // 核心：压缩为 JPEG 格式，质量 0.8 (体积减少 90% 以上)
                        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.8);
                        resolve({
                            id: `temp_${Date.now()}_${Math.random()}`,
                            description: '',
                            previewUrl: compressedDataUrl, // 这里存的是压缩后的图片
                            groupId: null
                        });
                    };
                    img.src = e.target.result;
                    // --- 结束压缩逻辑 ---
                };
                reader.readAsDataURL(file);
            });
        });
        // 等待所有的文件都压缩完成
        const newImages = await Promise.all(readPromises);
        // 一次性把所有新图片都添加到待上传列表
        newImagesToUpload.push(...newImages);
        // 最后，渲染界面
        renderUploadUI();
    };
    // --- 事件监听 ---
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
    createGroupBtn.addEventListener('click', createNewGroup);
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); handleFiles(e.dataTransfer.files); });
    
    listContainer.addEventListener('input', (e) => {
        if (e.target.classList.contains('image-description-input')) {
            const tempId = e.target.closest('.upload-item').dataset.id;
            const item = newImagesToUpload.find(i => i.id === tempId);
            if (item) item.description = e.target.value;
            updateSaveButtonState();
        }
    });
     listContainer.addEventListener('change', e => {
        if (e.target.classList.contains('group-select')) {
            const tempId = e.target.closest('.upload-item').dataset.id;
            const item = newImagesToUpload.find(i => i.id === tempId);
            if (item) {
                item.groupId = e.target.value ? parseInt(e.target.value, 10) : null;
            }
        }
    });
    listContainer.addEventListener('click', (e) => {
        if (e.target.classList.contains('remove-upload-btn')) {
            const tempId = e.target.closest('.upload-item').dataset.id;
            newImagesToUpload = newImagesToUpload.filter(i => i.id !== tempId);
            renderUploadUI();
        }
    });
    
    addUrlBtn.addEventListener('click', () => {
        showInputModal('输入图片URL (格式: 描述:URL)', '', (value) => {
            if (!value) return;
            const lines = value.split('\n').map(l => l.trim()).filter(Boolean);
            lines.forEach(line => {
                let description = '';
                let url = '';
                const urlIndex = line.search(/https?:\/\//);
                if (urlIndex === -1) url = line;
                else {
                    description = line.substring(0, urlIndex).replace(/[:：\s]+$/, '').trim();
                    url = line.substring(urlIndex).trim();
                }
                if (url) {
                    newImagesToUpload.push({
                        id: `temp_${Date.now()}_${Math.random()}`,
                        description: description,
                        previewUrl: url,
                    });
                }
            });
            renderUploadUI();
        }, { isTextarea: true, position: 'top' });
    });
    
   charSelect.addEventListener('change', async () => {
        const selectedCharId = charSelect.value;
        await populateGroupSelect(unifiedGroupSelect, selectedCharId);
        const allIndividualSelects = listContainer.querySelectorAll('.group-select');
        for (const sel of allIndividualSelects) {
            await populateGroupSelect(sel, selectedCharId);
        }
        // 清空所有已选图片的分组选择
        newImagesToUpload.forEach(item => item.groupId = null);
    });
    /** 【大幅修改】保存按钮的点击事件 */
    confirmBtn.addEventListener('click', async () => {
        const selectedCharId = charSelect.value; // 【核心修正】从弹窗的选择器获取角色ID
        if (!selectedCharId) {
            alert('请选择一个角色！');
            return;
        }
       
          const isUnifiedMode = newImagesToUpload.length >= 5;
        const unifiedGroupId = unifiedGroupSelect.value ? parseInt(unifiedGroupSelect.value, 10) : null;
        const imagesToSave = newImagesToUpload.map(item => ({
            charId: selectedCharId,
            url: item.previewUrl,
            description: item.description.trim(),
            timestamp: new Date(),
            groupId: isUnifiedMode ? unifiedGroupId : (item.groupId || null)
        }));
        try {
            await db.galleryImages.bulkAdd(imagesToSave);
            showDynamicIsland(`${imagesToSave.length}张图片已保存`);
            closeModal();
            // 如果保存的角色就是当前页面正在看的角色，则刷新列表
            const activeCharOnPage = document.querySelector('#page-gallery .character-avatar.active')?.dataset.charId;
            if (selectedCharId === activeCharOnPage) {
                await renderImageGrid(selectedCharId);
            }
        } catch (error) {
            console.error("Failed to save images:", error);
            alert("保存图片失败，请检查控制台。");
        }
    });
    // 返回一个函数，用于从外部打开此弹窗
    return () => {
        const activeCharOnPage = document.querySelector('#page-gallery .character-avatar.active');
        if (!activeCharOnPage) {
            alert('请先选择一个角色才能添加图片。');
            return;
        }
        
        newImagesToUpload = [];
        populateCharacterSelect(); // 先填充角色列表
        charSelect.value = activeCharOnPage.dataset.charId; // 默认选中当前角色
        
        // 手动触发一次change事件来加载初始的分组信息
        charSelect.dispatchEvent(new Event('change'));
        renderUploadUI();
        modalOverlay.classList.add('visible');
    };
}

// ▼▼▼ 使用下面这个【最终版】函数，完整替换掉你文件中现有的 setupGalleryPage 函数 ▼▼▼

export function setupGalleryPage() {
    const galleryIcon = document.getElementById('gallery-icon');
    const pageGallery = document.getElementById('page-gallery');

    // 【新增】获取搜索框和状态UI元素
    const searchInput = document.getElementById('gallery-ai-search-input');
    const loadingSpinner = document.getElementById('gallery-ai-loading-spinner');
    const statusText = document.getElementById('gallery-ai-status-text');

    if (!galleryIcon || !pageGallery) {
        console.warn('Gallery page elements not found. Skipping setup.');
        return;
    }

    const openImageUploadModal = setupImageUploadModal();
    const openAddGroupModal = setupAddGroupModal(); 

    // 【核心修改】处理打开相册页的逻辑
    addTapListener(galleryIcon, async () => {
        renderCharacterSelector();
        showPage('page-gallery');
        
        // 每次进入相册页都检查AI引擎状态
        await checkAndInitializeAiEngine();
    });

    // 【新增】异步加载AI引擎并更新UI的函数
    async function checkAndInitializeAiEngine() {
        // 如果AI功能未开启，则禁用搜索框并提示
        if (!AppState.gallerySettings.isAiEnabled) {
            searchInput.disabled = true;
            loadingSpinner.style.display = 'none';
            statusText.textContent = '智能搜索已关闭，请在设置中开启。';
            searchInput.placeholder = 'AI搜索已禁用';
            return;
        }

        // 如果AI已可用，则启用搜索框
        if (isAiEngineAvailable()) {
            searchInput.disabled = false;
            loadingSpinner.style.display = 'none';
            statusText.textContent = 'AI引擎已就绪。';
            searchInput.placeholder = '通过AI描述搜索图片...';
            return;
        }

        // 如果AI已开启但未加载，则开始异步加载
        searchInput.disabled = true;
        loadingSpinner.style.display = 'block';
        statusText.textContent = '正在初始化AI引擎，请稍候...';
        searchInput.placeholder = 'AI加载中...';

        try {
            await initializeSimilarityPipeline();
            // 成功后更新UI
            searchInput.disabled = false;
            loadingSpinner.style.display = 'none';
            statusText.textContent = 'AI引擎已就绪。';
            searchInput.placeholder = '通过AI描述搜索图片...';
            showDynamicIsland('✅ AI引擎加载成功', 'success');
        } catch (error) {
            // 失败后更新UI
            searchInput.disabled = true;
            loadingSpinner.style.display = 'none';
            statusText.textContent = 'AI引擎加载失败，将使用关键词匹配。';
            searchInput.placeholder = 'AI加载失败';
            showDynamicIsland('AI引擎加载失败', 'error');
        }
    }

    // --- 以下的事件监听器保持不变 ---

    const characterSelector = pageGallery.querySelector('.character-selector');
    if (characterSelector) {
        addTapListener(characterSelector, (e) => {
            const targetAvatar = e.target.closest('.character-avatar');
            if (!targetAvatar) return;

            if (targetAvatar.classList.contains('add-new-character')) {
                alert('跳转到通讯录添加新角色（功能待实现）');
                return;
            }
            
            if (targetAvatar.classList.contains('active')) return;

            const allAvatars = characterSelector.querySelectorAll('.character-avatar');
            allAvatars.forEach(avatar => avatar.classList.remove('active'));
            targetAvatar.classList.add('active');

            const charId = targetAvatar.dataset.charId;
            if (charId) {
                renderGalleryCharacterImageSettings(charId);
                renderImageGrid(charId);
            }
        });
    }

    const imageGroupsList = pageGallery.querySelector('.image-groups-list');
    if (imageGroupsList) {
        addTapListener(imageGroupsList, async (e) => {
            // ... (这部分事件处理逻辑完全不变) ...
            const groupCard = e.target.closest('.image-group-card');
            const imageCard = e.target.closest('.image-card');
            const imageDeleteBtn = e.target.closest('.image-card .delete-btn');
            const imageEditBtn = e.target.closest('.image-card .edit-btn');
            const imageMoveGroupBtn = e.target.closest('.image-card .move-group-btn');
            const imageViewBtn = e.target.closest('.image-card .view-btn');
            const groupDeleteBtn = e.target.closest('.group-delete-btn');
            const groupEditBtn = e.target.closest('.group-edit-btn');
            const activeCharId = document.querySelector('#page-gallery .character-avatar.active')?.dataset.charId;
            if (!activeCharId) return;
            if (groupEditBtn) {
                e.stopPropagation();
                const groupId = parseInt(groupEditBtn.closest('.image-group-card').dataset.groupId, 10);
                const group = await db.galleryGroups.get(groupId);
                if (group) {
                    showInputModal('编辑分组名称', group.name, async (newName) => {
                        if (newName && newName.trim() !== group.name) {
                            await db.galleryGroups.update(groupId, { name: newName.trim() });
                            showDynamicIsland('分组名已更新');
                            await renderImageGrid(activeCharId);
                        }
                    });
                }
                return;
            }
            if (groupDeleteBtn) {
                e.stopPropagation();
                const groupId = parseInt(groupDeleteBtn.closest('.image-group-card').dataset.groupId, 10);
                if (confirm('确定要删除这个分组吗？\n（分组内的图片不会被删除，将变为“未分组”）')) {
                    const imagesToUpdate = await db.galleryImages.where({ groupId }).toArray();
                    const imageIdsToUpdate = imagesToUpdate.map(img => img.id);
                    if (imageIdsToUpdate.length > 0) {
                        await db.galleryImages.where('id').anyOf(imageIdsToUpdate).modify({ groupId: null });
                    }
                    await db.galleryGroups.delete(groupId);
                    showDynamicIsland('分组已删除');
                    await renderImageGrid(activeCharId);
                }
                return;
            }
            if (groupCard && !imageCard) {
                const groupId = parseInt(groupCard.dataset.groupId, 10);
                showGroupDetail(groupId);
                return;
            }
            if (imageDeleteBtn) {
                e.stopPropagation();
                const cardToDelete = imageDeleteBtn.closest('.image-card');
                const imageId = parseInt(cardToDelete.dataset.imageId, 10);
                if (confirm('确定要删除这张图片吗？')) {
                    await db.galleryImages.delete(imageId);
                    showDynamicIsland('图片已删除');
                    await renderImageGrid(activeCharId);
                }
                return;
            }
            if (imageMoveGroupBtn) {
                e.stopPropagation();
                const cardToMove = imageMoveGroupBtn.closest('.image-card');
                const imageId = parseInt(cardToMove.dataset.imageId, 10);
                await openMoveImageGroupModal(imageId, async () => {
                    const currentActiveCharId = document.querySelector('#page-gallery .character-avatar.active')?.dataset.charId;
                    if (currentActiveCharId) {
                        renderGalleryCharacterImageSettings(currentActiveCharId);
                        await renderImageGrid(currentActiveCharId);
                    }
                });
                return;
            }
            if (imageViewBtn) {
                e.stopPropagation();
                const cardToView = imageViewBtn.closest('.image-card');
                const imageId = parseInt(cardToView.dataset.imageId, 10);
                const image = await db.galleryImages.get(imageId);
                openGalleryImagePreview(image);
                return;
            }
            if (imageEditBtn) {
                e.stopPropagation();
                const cardToEdit = imageEditBtn.closest('.image-card');
                const imageId = parseInt(cardToEdit.dataset.imageId, 10);
                const image = await db.galleryImages.get(imageId);
                if (image) {
                    showInputModal('编辑图片描述', image.description, async (newDesc) => {
                        if (newDesc !== null && newDesc.trim() !== image.description) {
                            await db.galleryImages.update(imageId, { description: newDesc.trim(), api_vector: null, api_vector_signature: '' });
                            showDynamicIsland('描述已更新');
                            await renderImageGrid(activeCharId);
                        }
                    });
                }
                return;
            }
            if (imageCard) {
                imageGroupsList.querySelectorAll('.image-card.active').forEach(card => {
                    if (card !== imageCard) card.classList.remove('active');
                });
                imageCard.classList.toggle('active');
            }
        });
    }

  // ▼▼▼ 补全代码 1/3 ▼▼▼
const groupDetailGrid = document.getElementById('gallery-group-image-grid');
if (groupDetailGrid) {
    addTapListener(groupDetailGrid, async (e) => {
        const imageCard = e.target.closest('.image-card');
        const deleteBtn = e.target.closest('.delete-btn');
        const editBtn = e.target.closest('.edit-btn');
        const moveGroupBtn = e.target.closest('.move-group-btn');
        const viewBtn = e.target.closest('.view-btn');
        
        // 点击删除按钮
        if (deleteBtn) {
            e.stopPropagation();
            const cardToDelete = deleteBtn.closest('.image-card');
            const imageId = parseInt(cardToDelete.dataset.imageId, 10);
            if (confirm('确定要删除这张图片吗？')) {
                await db.galleryImages.delete(imageId);
                showDynamicIsland('图片已删除');
                // 刷新当前的分组详情页
                if (currentOpenGroupId) await showGroupDetail(currentOpenGroupId);
            }
            return;
        }
        
        // 点击编辑按钮
        if (editBtn) {
            e.stopPropagation();
            const cardToEdit = editBtn.closest('.image-card');
            const imageId = parseInt(cardToEdit.dataset.imageId, 10);
            const image = await db.galleryImages.get(imageId);
            if (image) {
                showInputModal('编辑图片描述', image.description, async (newDesc) => {
                    if (newDesc !== null && newDesc.trim() !== image.description) {
                        await db.galleryImages.update(imageId, { description: newDesc.trim(), api_vector: null, api_vector_signature: '' });
                        showDynamicIsland('描述已更新');
                        // 刷新当前的分组详情页
                        if (currentOpenGroupId) await showGroupDetail(currentOpenGroupId);
                    }
                });
            }
            return;
        }

        if (moveGroupBtn) {
            e.stopPropagation();
            const cardToMove = moveGroupBtn.closest('.image-card');
            const imageId = parseInt(cardToMove.dataset.imageId, 10);
            await openMoveImageGroupModal(imageId, async () => {
                if (currentOpenGroupId) await showGroupDetail(currentOpenGroupId, true);
            });
            return;
        }

        if (viewBtn) {
            e.stopPropagation();
            const cardToView = viewBtn.closest('.image-card');
            const imageId = parseInt(cardToView.dataset.imageId, 10);
            const image = await db.galleryImages.get(imageId);
            openGalleryImagePreview(image);
            return;
        }
        
        // 点击图片卡片本身 (切换浮层)
        if (imageCard) {
            // 移除详情页中其他所有卡片的 active 状态
            groupDetailGrid.querySelectorAll('.image-card.active').forEach(card => {
                if (card !== imageCard) card.classList.remove('active');
            });
            // 切换当前卡片的 active 状态
            imageCard.classList.toggle('active');
        }
    });
}


// ▼▼▼ 补全代码 2/3 ▼▼▼
window.addEventListener('click', (e) => {
    // 检查是否在相册主页点击了非卡片区域，如果是，则关闭主页的浮层
    const activeCardInGallery = document.querySelector('#page-gallery .image-card.active');
    if (activeCardInGallery && !activeCardInGallery.contains(e.target)) {
        activeCardInGallery.classList.remove('active');
    }

    // 检查是否在分组详情页点击了非卡片区域，如果是，则关闭详情页的浮层
    const activeCardInDetail = document.querySelector('#page-gallery-group-detail .image-card.active');
    if (activeCardInDetail && !activeCardInDetail.contains(e.target)) {
        activeCardInDetail.classList.remove('active');
    }
    
    // 同时检查并关闭右上角的功能菜单（如果它处于打开状态且点击的不是触发按钮本身）
    const actionMenu = document.getElementById('gallery-action-menu');
    const moreBtn = document.getElementById('gallery-more-btn');
    if (actionMenu && actionMenu.classList.contains('show') && !moreBtn.contains(e.target) && !actionMenu.contains(e.target)) {
         actionMenu.classList.remove('show');
    }
});


  // ▼▼▼ 补全代码 3/3 ▼▼▼
const moreBtn = document.getElementById('gallery-more-btn');
const actionMenu = document.getElementById('gallery-action-menu');
if (moreBtn && actionMenu) {
    addTapListener(moreBtn, (e) => {
        e.stopPropagation(); // 阻止事件冒泡到 window，防止刚打开就立刻被关闭
        actionMenu.classList.toggle('show');
    });
    
    addTapListener(actionMenu, (e) => {
        const item = e.target.closest('.action-menu-item');
        if (!item) return;

        const action = item.dataset.action;

        if (action === 'add-group') {
            openAddGroupModal();
        } else if (action === 'add-image') {
            openImageUploadModal();
        } else if (action === 'settings') {
            // 触发一个全局事件，让 gallery-settings.js 中的监听器去处理
            document.dispatchEvent(new CustomEvent('open-gallery-settings'));
        }
        
        // 点击任何选项后都关闭菜单
        actionMenu.classList.remove('show');
    });
    
} else {
    console.error('错误：未能找到 #gallery-more-btn 或 #gallery-action-menu 元素！');
}

}
// ▲▲▲ 替换结束 ▲▲▲


function setupAddGroupModal() {
    const modal = document.getElementById('gallery-add-group-modal-overlay');
    const charSelect = document.getElementById('gallery-group-char-select');
    const nameInput = document.getElementById('gallery-group-name-input');
    const cancelBtn = document.getElementById('gallery-group-cancel-btn');
    const saveBtn = document.getElementById('gallery-group-save-btn');
    const closeModal = () => {
        nameInput.value = '';
        modal.classList.remove('visible');
    };
saveBtn.addEventListener('click', async () => {
    const charId = charSelect.value;
    const name = nameInput.value.trim();
    if (!charId || !name) {
        alert('请选择角色并输入分组名称！');
        return;
    }
    try {
        await db.galleryGroups.add({ charId, name });
        showDynamicIsland(`分组“${name}”已创建`);
        closeModal();
        // 【核心修复】无论当前显示的是谁，都切换到新分组所属的角色页面并刷新
        const currentActiveAvatar = document.querySelector('#page-gallery .character-avatar.active');
        const newTargetAvatar = document.querySelector(`#page-gallery .character-avatar[data-char-id="${charId}"]`);
        // 如果目标角色和当前角色不一致，则切换
        if (currentActiveAvatar && newTargetAvatar && currentActiveAvatar !== newTargetAvatar) {
            currentActiveAvatar.classList.remove('active');
            newTargetAvatar.classList.add('active');
        }
        
        // 刷新目标角色的视图
        await renderImageGrid(charId);
        
    } catch (error) {
        console.error('创建分组失败:', error);
        alert('创建分组失败！');
    }
});
    cancelBtn.addEventListener('click', closeModal);
    // 返回一个用于打开弹窗的函数
    return () => {
        // 填充角色选择器
        charSelect.innerHTML = '';
        AppState.characterProfiles.filter(char => !char.isGroup).forEach(char => {
            const option = document.createElement('option');
            option.value = char.id;
            option.textContent = char.name;
            charSelect.appendChild(option);
        });
        // 默认选中当前页面上的角色
        const activeCharId = document.querySelector('#page-gallery .character-avatar.active')?.dataset.charId;
        if (activeCharId) {
            charSelect.value = activeCharId;
        }
        
        modal.classList.add('visible');
        nameInput.focus();
    };
}
async function showGroupDetail(groupId, skipPageSwitch = false) {
    currentOpenGroupId = groupId; // 【新增】记录当前打开的分组ID
    // 1. 获取详情页的DOM元素
    const groupTitleEl = document.getElementById('gallery-group-title');
    const imageGridEl = document.getElementById('gallery-group-image-grid');

    // 清空旧内容并显示加载状态
    groupTitleEl.textContent = '加载中...';
    imageGridEl.innerHTML = '';

    try {
        // 2. 并行从数据库获取分组信息和图片列表
        const [group, images] = await Promise.all([
            db.galleryGroups.get(groupId),
            db.galleryImages.where({ groupId }).reverse().sortBy('timestamp')
        ]);

        if (!group) {
            console.error(`未找到ID为 ${groupId} 的分组`);
            groupTitleEl.textContent = '分组不存在';
            return;
        }

        // 3. 更新页面标题
        groupTitleEl.textContent = group.name;

        // 4. 动态生成图片网格
        if (images.length === 0) {
            imageGridEl.innerHTML = '<p class="empty-gallery-text">这个分组里还没有图片。</p>';
        } else {
            const fragment = document.createDocumentFragment();
            images.forEach(img => {
                // ▼▼▼【核心修改】使用和主页完全一致的 HTML 结构 ▼▼▼
                const item = document.createElement('div');
                item.className = 'image-card'; // 使用新的类名
                item.dataset.imageId = img.id;
                item.innerHTML = getGalleryImageCardHtml(img);
                fragment.appendChild(item);
            });
            imageGridEl.appendChild(fragment);
        }

        // 5. 只在正常打开分组详情时切换页面；保存后刷新时保持原地不跳转
        if (!skipPageSwitch) {
            showPage('page-gallery-group-detail');
        }

    } catch (error) {
        console.error('加载分组详情失败:', error);
        groupTitleEl.textContent = '加载失败';
    }
}
// ==========================================================
// == 核心图片搜索逻辑 (V6 AI 引擎 + V5 备用方案)
// ==========================================================

let similarityPipeline = null;
export function isAiEngineAvailable() {
    return similarityPipeline !== null;
}

export function resetSimilarityPipeline() {
    similarityPipeline = null;
}

export async function initializeSimilarityPipeline() {
    if (similarityPipeline) {
        console.log("[AI Search Engine] Already initialized.");
        return;
    }
       try {
        console.log("[AI Search Engine] Initializing...");
        const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1');
        env.allowLocalModels = false; 
        similarityPipeline = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5');
        console.info("[AI Search Engine] Initialized successfully.");
    } catch (error) {
        console.warn("[AI Search Engine] Failed to initialize.", error);
        similarityPipeline = null;
        throw error;
    }
}
/**
 * 【V6 主函数】根据描述为角色查找最佳图片。
 * 它会自动判断AI引擎是否可用，并选择最佳的搜索策略。
 * @export
 * @param {string} charId - 角色ID
 * @param {string} targetDescription - AI想要发送的图片的描述
 * @returns {Promise<string|null>} - 最佳匹配图片的URL或null
 */
export async function findBestImageForDescription(charId, targetDescription) {
    const apiMatch = await findBestImageWithApiEngine(charId, targetDescription);
    if (apiMatch !== undefined) return apiMatch;
    if (AppState.gallerySettings.isAiEnabled && isAiEngineAvailable()) {
        return await findBestImageWithAI(charId, targetDescription);
    } else {
        return await findBestImageWithInternalFallback(charId, targetDescription);
    }
}

async function findBestImageWithApiEngine(charId, targetDescription) {
    const config = await getVectorApiConfig();
    if (!config.enabled || !(config.applyTo === 'image' || config.applyTo === 'both')) return undefined;
    const targetText = String(targetDescription || '').trim();
    if (!targetText) {
        console.log('[Vector Gallery] API vector search result:', {
            charId,
            target: '',
            matched: false,
            score: 0,
            threshold: Number(config.imageThreshold) || 0.5,
            reason: 'empty target'
        });
        return null;
    }

    try {
        const queryVector = await getApiEmbedding(targetText, config);
        if (!Array.isArray(queryVector) || queryVector.length === 0) {
            console.log('[Vector Gallery] API vector search result:', {
                charId,
                target: targetText,
                matched: false,
                score: 0,
                threshold: Number(config.imageThreshold) || 0.5,
                reason: 'query embedding failed'
            });
            return null;
        }

        const allImages = await getGalleryImagesForCharacter(charId);
        if (allImages.length === 0) {
            console.log('[Vector Gallery] API vector search result:', {
                charId,
                target: targetText,
                matched: false,
                score: 0,
                threshold: Number(config.imageThreshold) || 0.5,
                totalImages: 0,
                reason: 'empty gallery'
            });
            return null;
        }
        const imageThreshold = Number.isFinite(Number(config.imageThreshold)) ? Number(config.imageThreshold) : 0.5;
        const vectorSignature = getGalleryVectorSignature(config);

        let bestMatch = null;
        let highestScore = 0;
        let comparedCount = 0;

        for (const image of allImages) {
            if (!image || !image.description) continue;

            let apiVector = image.api_vector_signature === vectorSignature && Array.isArray(image.api_vector)
                ? image.api_vector
                : null;
            if (!apiVector) {
                apiVector = await getApiEmbedding(image.description, config);
                if (Array.isArray(apiVector) && apiVector.length > 0) {
                    image.api_vector = apiVector;
                    image.api_vector_signature = vectorSignature;
                    db.galleryImages.update(image.id, {
                        api_vector: apiVector,
                        api_vector_signature: vectorSignature
                    }).catch(() => {});
                }
            }

            if (!Array.isArray(apiVector) || apiVector.length === 0) continue;

            const score = apiCosineSimilarity(queryVector, apiVector);
            comparedCount++;
            if (score > highestScore) {
                highestScore = score;
                bestMatch = image;
            }
        }

        const matched = highestScore >= imageThreshold && !!bestMatch?.url;
        console.log('[Vector Gallery] API vector search result:', {
            charId,
            target: targetText,
            matched,
            score: Number(highestScore.toFixed(3)),
            threshold: imageThreshold,
            comparedCount,
            totalImages: allImages.length,
            matchedDescription: bestMatch?.description || '',
            url: matched ? bestMatch.url : ''
        });
        if (matched) {
            return bestMatch.url;
        }
    } catch (error) {
        console.warn('[Vector Gallery] API search failed.', error);
    }

    return null;
}

async function findBestImageWithAI(charId, targetDescription) {
    const COSINE_SIMILARITY_THRESHOLD = AppState.gallerySettings.aiThreshold;

    try {
        const allImages = await getGalleryImagesForCharacter(charId);
        if (allImages.length === 0) return null;

        const descriptions = allImages.map(img => img.description || "");
        if (descriptions.every(d => d === "")) return null;

        // 1. 使用AI模型将所有描述文本转换为向量
        const targetVector = await similarityPipeline(targetDescription, { pooling: 'mean', normalize: true });
        const imageVectors = await similarityPipeline(descriptions, { pooling: 'mean', normalize: true });
        let bestMatch = null;
        let highestScore = -1;
        const vectorDim = targetVector.data.length;

        // 2. 计算目标向量与每个图片向量的余弦相似度
        for (let i = 0; i < allImages.length; i++) {
            const score = cosineSimilarity(targetVector.data, imageVectors.data.slice(i * vectorDim, (i + 1) * vectorDim));
            if (score > highestScore) {
                highestScore = score;
                bestMatch = allImages[i];
            }
        }

        console.log(`[AI Search] AI wants: "${targetDescription}". Best match: "${bestMatch.description}" with score ${highestScore.toFixed(3)}.`);

        if (highestScore >= COSINE_SIMILARITY_THRESHOLD) {
            return bestMatch.url;
        }
        return null;

    } catch (error) {
        console.error("Error during AI image search:", error);
        // 如果AI搜索过程中出错，可以再次降级到备用方案
        return await findBestImageWithInternalFallback(charId, targetDescription);
    }
}

// AI搜索需要一个辅助函数来计算余弦相似度
function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}


// --- 策略二：使用内置分词和Jaccard相似度 (备用方案) ---
async function findBestImageWithInternalFallback(charId, targetDescription) {
    console.log("[Fallback Search] Using internal keyword search.");
    const SIMILARITY_THRESHOLD = AppState.gallerySettings.fallbackThreshold;
    const allImages = await getGalleryImagesForCharacter(charId);
    if (allImages.length === 0) return null;
    
    const targetTokens = tokenizeChinese(targetDescription);
    let bestMatch = null;
    let highestScore = 0;

    for (const img of allImages) {
        if (!img.description) continue;
        const imageTokens = tokenizeChinese(img.description);
        const currentScore = calculateJaccardSimilarity(targetTokens, imageTokens);
        if (currentScore > highestScore) {
            highestScore = currentScore;
            bestMatch = img;
        }
    }
    
    console.log(`[Fallback Search] AI wants: "${targetDescription}". Best match: "${bestMatch ? bestMatch.description : 'None'}" with score ${highestScore.toFixed(2)}.`);

    if (highestScore >= SIMILARITY_THRESHOLD && bestMatch) {
        return bestMatch.url;
    }
    return null;
}

function tokenizeChinese(text) {
    const DICTIONARY = new Set(["的", "我", "你", "是", "了", "在", "也", "有", "很", "照片", "图片", "张", "个", "城市", "高楼", "建筑", "日落", "夕阳", "黄昏", "傍晚", "落日", "晚霞", "太阳", "天空", "猫", "猫咪", "小猫", "可爱", "睡觉", "花", "雨天", "下雨", "窗外", "风景", "景色", "美丽"]);
    const MAX_WORD_LENGTH = 5;
    let result = [], index = 0;
    const textClean = text.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"").toLowerCase();
    while (index < textClean.length) {
        let found = false;
        for (let len = Math.min(MAX_WORD_LENGTH, textClean.length - index); len > 1; len--) {
            const word = textClean.substring(index, index + len);
            if (DICTIONARY.has(word)) { result.push(word); index += len; found = true; break; }
        }
        if (!found) { result.push(textClean[index]); index++; }
    }
    return result;
}

function calculateJaccardSimilarity(setA, setB) {
    const set1 = new Set(setA), set2 = new Set(setB);
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    if (union.size === 0) return 0;
    return intersection.size / union.size;
}

/**
 * 【新增】根据多个描述，批量查找匹配的图片
 * 注意：这里复用了 findBestImageForDescription，所以会自动遵守用户的匹配度设置！
 * @param {string} charId - 角色ID
 * @param {string[]} promptsArray - 图片描述数组
 */
export async function findMultipleImagesForPrompts(charId, promptsArray) {
    if (!promptsArray || !Array.isArray(promptsArray) || promptsArray.length === 0) {
        return [];
    }

    // 并行搜索所有图片，速度更快
    const searchPromises = promptsArray.map(prompt => 
        findBestImageForDescription(charId, prompt)
    );

    const results = await Promise.all(searchPromises);

    // 过滤掉那些没找到图的 (null)，只返回找到的图片URL
    return results.filter(url => url !== null);
}

export async function getRandomGalleryImage(charId) {
    if (!charId) return null;
    try {
        // 从数据库获取该角色的所有图片
        const allImages = await getGalleryImagesForCharacter(charId);
        if (allImages.length === 0) return null;
        
        // 随机取一张
        const randomImg = allImages[Math.floor(Math.random() * allImages.length)];
        return randomImg.url;
    } catch (e) {
        console.error("获取随机相册图片失败:", e);
        return null;
    }
}


