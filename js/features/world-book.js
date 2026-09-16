
import { UI, showDynamicIsland } from '../ui.js';
import { db } from '../state.js';
const LAST_WORLD_BOOK_CATEGORY_KEY = 'lastWorldBookCategory';

async function getLastWorldBookCategory() {
    const record = await db.appData.get(LAST_WORLD_BOOK_CATEGORY_KEY);
    return record?.value || '默认';
}

async function setLastWorldBookCategory(category) {
    await db.appData.put({ key: LAST_WORLD_BOOK_CATEGORY_KEY, value: category || '默认' });
}
/**
 * 【最终版】处理全局搜索，优先匹配分组，再匹配条目
 * @param {string} query - 搜索关键词
 */
async function handleGlobalSearch(query) {
    const listContainer = document.getElementById('world-book-list');
    const tabsContainer = document.getElementById('world-book-category-tabs');
    if (!listContainer || !tabsContainer) return;
    const searchTerm = query.toLowerCase().trim();
    // 如果搜索词为空，则恢复到上一次查看的分类
    if (!searchTerm) {
        const lastCategory = await getLastWorldBookCategory();
        await renderCategoryTabs(lastCategory);
        await renderWorldBookList(lastCategory);
        return;
    }
    // --- 策略1: 优先搜索完全匹配的分组名 ---
    const allDbCategories = await db.worldBookCategories.toArray();
    // ▼▼▼ 修改这行：搜索范围包含全局世界书 ▼▼▼
    const allCategories = [{ name: '全局世界书' }, { name: '默认' }, ...allDbCategories]; 
    // ▲▲▲ 修改结束 ▲▲▲
    const matchedCategory = allCategories.find(cat => cat.name.toLowerCase() === searchTerm);
    if (matchedCategory) {
        // 找到了匹配的分组，直接跳转到该分组页面
        await setLastWorldBookCategory(matchedCategory.name);
        await renderCategoryTabs(matchedCategory.name);
        await renderWorldBookList(matchedCategory.name);
        return; // 结束搜索
    }
    // --- 策略2: 如果没有匹配的分组，则搜索世界书条目标题 ---
    tabsContainer.querySelectorAll('.tab-item').forEach(tab => tab.classList.remove('active'));
    const results = await db.worldBookEntries.filter(item => 
        item.title.toLowerCase().includes(searchTerm)
    ).toArray();
    listContainer.innerHTML = ''; // 清空当前列表
    if (results.length === 1) {
        // 只找到一个结果，跳转到其所在分类并高亮
        const item = results[0];
        const category = item.category;
        await setLastWorldBookCategory(category);
        await renderCategoryTabs(category);
        await renderWorldBookList(category);
        setTimeout(() => {
            const itemElement = listContainer.querySelector(`[data-id="${item.id}"]`);
            if (itemElement) {
                itemElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                itemElement.classList.add('highlight');
                setTimeout(() => itemElement.classList.remove('highlight'), 2000);
            }
        }, 100);
    } else if (results.length > 1) {
        // 找到多个结果，展示扁平列表
        results.forEach(item => {
            const itemElement = document.createElement('div');
            itemElement.className = 'world-book-item';
            itemElement.dataset.id = item.id;
            itemElement.dataset.importance = item.importance || 'low';
            const contentPreview = item.content ? (item.content.length > 80 ? item.content.substring(0, 80) + '...' : item.content) : '暂无内容';
            
            itemElement.innerHTML = `
                <div class="item-header">
                    <h3 class="item-title">${item.title}</h3>
                    <span class="item-importance-badge">${item.importance === 'high' ? '高' : (item.importance === 'medium' ? '中' : '低')}</span>
                </div>
                <p class="item-content-preview">${contentPreview}</p>
                <p class="item-meta">分类: ${item.category}</p> 
            `;
            listContainer.appendChild(itemElement);
        });
    } else {
        // 未找到任何结果
        const emptyPlaceholder = document.createElement('p');
        emptyPlaceholder.className = 'empty-list-placeholder';
        emptyPlaceholder.textContent = `没有找到与 "${query}" 相关的分组或设定。`;
        listContainer.appendChild(emptyPlaceholder);
    }
}
/**
 * 【最终版】设置搜索功能的事件监听器
 */
function setupSearchEventListeners() {
    const header = document.querySelector('#world-book-screen .page-header');
    const searchIcon = document.querySelector('#world-book-screen .search-icon-fixed');
    const searchInput = document.getElementById('wb-search-input');
    const cancelBtn = document.getElementById('wb-search-cancel-btn');
    if (!header || !searchIcon || !searchInput || !cancelBtn) return;
    searchIcon.addEventListener('click', () => {
        header.classList.add('search-mode-active');
        searchInput.focus();
    });
    cancelBtn.addEventListener('click', () => {
        header.classList.remove('search-mode-active');
        searchInput.value = '';
        handleGlobalSearch(''); // 清空搜索，恢复视图
    });
    let searchTimeout;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            handleGlobalSearch(searchInput.value);
        }, 300); // 延迟300毫秒执行搜索，避免频繁查询
    });
}
/**
 * 【全新重构】根据指定的分类渲染世界书列表
 * @param {string} category - 要筛选的分类名, "默认" 或其他分组名
 */
async function renderWorldBookList(category = '默认') {
    const listContainer = document.getElementById('world-book-list');
    if (!listContainer) {
        console.error('World book list container not found!');
        return;
    }

    listContainer.innerHTML = ''; // 1. 清空现有列表

    // 2. 创建并添加分组标题
    const groupHeader = document.createElement('h2');
    groupHeader.className = 'wb-list-group-header';
    groupHeader.textContent = category;
    listContainer.appendChild(groupHeader);

    // 3. 从数据库查询属于特定分类的条目
    const items = await db.worldBookEntries
        .where('category')
        .equals(category)
        .reverse() // (可选) 让最新的条目显示在最上面
        .sortBy('createdAt');

    // 4. 如果分组为空，显示提示信息
    if (items.length === 0) {
        const emptyPlaceholder = document.createElement('p');
        emptyPlaceholder.className = 'empty-list-placeholder';
        emptyPlaceholder.innerHTML = `此分组下还没有任何设定，<br>点击右上角“+”添加吧！`;
        listContainer.appendChild(emptyPlaceholder);
        return;
    }

    // 5. 遍历条目，创建新的单卡片HTML结构
    items.forEach(item => {
        const itemElement = document.createElement('div');
        // 使用 data-importance 属性，方便CSS根据重要性设置样式
        itemElement.className = 'world-book-item';
        itemElement.dataset.id = item.id;
        itemElement.dataset.importance = item.importance || 'low';

        // 生成内容预览 (截取前80个字符)
        const contentPreview = item.content ?
            (item.content.length > 80 ? item.content.substring(0, 80) + '...' : item.content) :
            '暂无内容';

        itemElement.innerHTML = `
            <div class="item-header">
                <h3 class="item-title">${item.title}</h3>
                <span class="item-importance-badge">${item.importance === 'high' ? '高' : (item.importance === 'medium' ? '中' : '低')}</span>
            </div>
            <p class="item-content-preview">${contentPreview}</p>
        `;
        listContainer.appendChild(itemElement);
    });
}

/**
 * 从数据库加载并渲染分类标签
 * @param {string} [activeCategory='默认'] - 指定哪个分类标签应该被激活
 */
async function renderCategoryTabs(activeCategory = '默认') { // 接收参数
    const tabsContainer = document.getElementById('world-book-category-tabs');
    if (!tabsContainer) return;
    const categories = await db.worldBookCategories.orderBy('id').toArray();
    
    tabsContainer.innerHTML = '';
    
    // ▼▼▼ 新增：先创建全局世界书的Tab，让它排在最前面 ▼▼▼
    const globalTab = document.createElement('button');
    globalTab.className = 'tab-item';
    globalTab.dataset.category = '全局世界书';
    globalTab.textContent = '全局世界书';
    tabsContainer.appendChild(globalTab);
    // ▲▲▲ 新增结束 ▲▲▲

    const defaultTab = document.createElement('button');
    defaultTab.className = 'tab-item';
    defaultTab.dataset.category = '默认';
    defaultTab.textContent = '默认';
    tabsContainer.appendChild(defaultTab);

    categories.forEach(cat => {
        const tab = document.createElement('button');
        tab.className = 'tab-item';
        tab.dataset.category = cat.name;
        tab.textContent = cat.name;
        tabsContainer.appendChild(tab);
    });

    // ▼▼▼ 【修改】根据传入的参数来设置激活状态 ▼▼▼
    const tabToActivate = tabsContainer.querySelector(`[data-category="${activeCategory}"]`);
    if (tabToActivate) {
        tabToActivate.classList.add('active');
    } else {
        // 如果找不到（可能分类被删了），则激活第一个
        tabsContainer.firstElementChild.classList.add('active');
    }
}


/**
 * 平滑地将一个标签滚动到其容器的中央
 * @param {HTMLElement} tabEl 要滚动的目标标签元素
 */
function smoothScrollTabIntoView(tabEl) {
    const container = tabEl.parentElement;
    const containerWidth = container.clientWidth;
    const tabWidth = tabEl.offsetWidth;
    const tabLeft = tabEl.offsetLeft;
    
    // 计算目标滚动位置，使标签的中心对齐容器的中心
    const targetScrollLeft = tabLeft - (containerWidth / 2) + (tabWidth / 2);
    
    container.scrollTo({
        left: targetScrollLeft,
        behavior: 'smooth'
    });
}

function syncWorldBookPositionRadios(value = 'default') {
    const normalized = value || 'default';
    const posSelect = document.getElementById('wb-entry-position-select');
    if (posSelect) posSelect.value = normalized;
    document.querySelectorAll('input[name="wb-entry-position-option"]').forEach(radio => {
        radio.checked = radio.value === normalized;
        const card = radio.closest('.wb-position-card');
        if (card) {
            const title = card.querySelector('strong');
            const hint = card.querySelector('small');
            card.style.background = radio.checked ? '#111' : '#fff';
            card.style.borderColor = radio.checked ? '#111' : '#eee';
            radio.style.accentColor = '#111';
            if (title) title.style.color = radio.checked ? '#fff' : '#111';
            if (hint) hint.style.color = radio.checked ? 'rgba(255,255,255,.72)' : '#999';
        }
    });
}

function getWorldBookPositionValue() {
    return document.querySelector('input[name="wb-entry-position-option"]:checked')?.value
        || document.getElementById('wb-entry-position-select')?.value
        || 'default';
}
/**
 * 【新函数】打开“编辑世界书”弹窗并填充数据
 * @param {number} itemId - 要编辑的条目ID
 */
export async function openEditWorldBookModal(itemId) {
    const item = await db.worldBookEntries.get(itemId);
    if (!item) {
        console.error(`Item with ID ${itemId} not found.`);
        return;
    }
    // 获取弹窗和所有表单元素
    const modal = document.getElementById('add-wb-entry-modal-overlay');
    const modalTitle = document.getElementById('wb-entry-modal-title');
    const idInput = document.getElementById('wb-entry-id-input');
    const nameInput = document.getElementById('wb-entry-name-input');
    const contentTextarea = document.getElementById('wb-entry-content-textarea');
    const groupSelect = document.getElementById('wb-entry-group-select');
    const deleteBtn = document.getElementById('delete-wb-entry-btn');
    if (!modal) return;
    // 1. 设置为“编辑”模式
    modalTitle.textContent = '编辑设定';
    deleteBtn.style.display = 'block'; // 显示删除按钮
    // 2. 填充表单数据
    idInput.value = item.id;
    nameInput.value = item.title;
    contentTextarea.value = item.content;
    // ▼▼▼ 修改这行：填充并选中正确的分类，增加全局世界书选项 ▼▼▼
    groupSelect.innerHTML = '<option value="全局世界书">全局世界书</option><option value="默认">默认</option>';
    // ▲▲▲ 修改结束 ▲▲▲
    const categories = await db.worldBookCategories.toArray();
    categories.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat.name;
        option.textContent = cat.name;
        groupSelect.appendChild(option);
    });
    groupSelect.value = item.category;
    // 4. 选中正确的重要程度
    const importanceRadio = document.querySelector(`input[name="importance"][value="${item.importance || 'low'}"]`);
    if (importanceRadio) {
        importanceRadio.checked = true;
    }
    const posSelect = document.getElementById('wb-entry-position-select');
    if (posSelect) syncWorldBookPositionRadios(item.injectionPosition || 'default');
    const kwToggle = document.getElementById('wb-entry-keyword-toggle');
    const keywordTriggerEnabled = !!item.keywordTriggerEnabled;
    if (kwToggle) kwToggle.checked = keywordTriggerEnabled;
    const kwInput = document.getElementById('wb-entry-keywords-input');
    const keywords = Array.isArray(item.keywords) ? item.keywords : [];
    if (kwInput) kwInput.value = keywords.join(', ');
    const kwFields = document.getElementById('wb-entry-keyword-fields');
    if (kwFields) kwFields.style.display = keywordTriggerEnabled ? 'block' : 'none';
    const kwHint = document.getElementById('wb-entry-keyword-hint');
    if (kwHint) kwHint.style.display = keywordTriggerEnabled ? 'none' : 'block';
    
    // 5. 显示弹窗
    modal.classList.add('visible');
    nameInput.focus();
}
/**
 * 【重构】打开极简黑白风格的“删除分组”弹窗（支持多选）
 */
async function openDeleteGroupModal() {
    const modal = document.getElementById('delete-group-modal-overlay');
    const listContainer = document.getElementById('delete-group-list');
    if (!modal || !listContainer) return;
    const categories = await db.worldBookCategories.toArray();
    listContainer.innerHTML = ''; // 清空列表
    if (categories.length === 0) {
        listContainer.innerHTML = '<div style="color: #8e8e93; text-align: center; padding: 10px 0;">没有可删除的分组</div>';
    } else {
        categories.forEach((cat, index) => {
            const uniqueId = `group-checkbox-${index}`;
            const listItem = document.createElement('div');
            listItem.innerHTML = `
                <label for="${uniqueId}">
                    <input type="checkbox" id="${uniqueId}" name="group-to-delete" value="${cat.name}">
                    <span class="checkbox-custom">
                        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                    </span>
                    <span>${cat.name}</span>
                </label>
            `;
            listContainer.appendChild(listItem);
        });
    }
    modal.classList.add('visible');
}
/**
 * 【已修复】打开“添加世界书”弹窗并填充分组
 */
export async function openAddWorldBookModal() {
    const modal = document.getElementById('add-wb-entry-modal-overlay');
    const modalTitle = document.getElementById('wb-entry-modal-title');
    const idInput = document.getElementById('wb-entry-id-input');
    const deleteBtn = document.getElementById('delete-wb-entry-btn');
    
    // --- 【核心修正】恢复这些被遗漏的元素获取 ---
    const nameInput = document.getElementById('wb-entry-name-input');
    const contentTextarea = document.getElementById('wb-entry-content-textarea');
    const groupSelect = document.getElementById('wb-entry-group-select');
    const importanceLow = document.getElementById('importance-low');
    // --- 修正结束 ---
    if (!modal || !groupSelect) return;
    // 重置为“添加”模式
    modalTitle.textContent = '添加世界书';
    idInput.value = ''; // 清空ID
    deleteBtn.style.display = 'none'; // 隐藏删除按钮
    // 1. 清空表单
    nameInput.value = '';
    contentTextarea.value = '';
    importanceLow.checked = true;
    const posSelect = document.getElementById('wb-entry-position-select');
    if (posSelect) syncWorldBookPositionRadios('default');
    const kwToggle = document.getElementById('wb-entry-keyword-toggle');
    if (kwToggle) kwToggle.checked = false;
    const kwInput = document.getElementById('wb-entry-keywords-input');
    if (kwInput) kwInput.value = '';
    const kwFields = document.getElementById('wb-entry-keyword-fields');
    if (kwFields) kwFields.style.display = 'none';
    const kwHint = document.getElementById('wb-entry-keyword-hint');
    if (kwHint) kwHint.style.display = 'block';
    // ▼▼▼ 修改这行：动态填充分组下拉列表，增加全局世界书选项 ▼▼▼
    groupSelect.innerHTML = '<option value="全局世界书">全局世界书</option><option value="默认">默认</option>'; 
    // ▲▲▲ 修改结束 ▲▲▲
    const categories = await db.worldBookCategories.toArray();
    categories.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat.name;
        option.textContent = cat.name;
        groupSelect.appendChild(option);
    });
    // 3. 显示弹窗
    modal.classList.add('visible');
    nameInput.focus();
}

/**
 * 初始化世界书功能的所有事件监听器
 */
export function initWorldBook() {
    // 获取所有UI元素
    const worldBookIcon = document.getElementById('shop-icon');
    const worldBookScreen = document.getElementById('world-book-screen');
    const backButton = document.getElementById('wb-screen-back-btn');
    const homeScreenWrapper = document.getElementById('home-screen-wrapper');
    const listContainer = document.getElementById('world-book-list');
    const addBtn = document.getElementById('add-world-book-btn');
    const addMenu = document.getElementById('world-book-add-menu');
    const tabsContainer = document.getElementById('world-book-category-tabs');
    
    // 获取“添加分组”弹窗元素
    const addGroupModal = document.getElementById('add-group-modal-overlay');
    const addGroupInput = document.getElementById('add-group-input');
    const cancelAddGroupBtn = document.getElementById('cancel-add-group-btn');
    const saveAddGroupBtn = document.getElementById('save-add-group-btn');

    // ▼▼▼ 【新增】获取“添加世界书”弹窗元素 ▼▼▼
    const addEntryModal = document.getElementById('add-wb-entry-modal-overlay');
    const cancelAddEntryBtn = document.getElementById('cancel-add-wb-entry-btn');
    const saveAddEntryBtn = document.getElementById('save-add-wb-entry-btn');
    const deleteGroupModal = document.getElementById('delete-group-modal-overlay');
    const cancelDeleteGroupBtn = document.getElementById('cancel-delete-group-btn');
    const confirmDeleteGroupBtn = document.getElementById('confirm-delete-group-btn');
    setupSearchEventListeners(); // 启用搜索功能

    const wbKeywordToggle = document.getElementById('wb-entry-keyword-toggle');
    if (wbKeywordToggle) {
        wbKeywordToggle.addEventListener('change', () => {
            const fields = document.getElementById('wb-entry-keyword-fields');
            const hint = document.getElementById('wb-entry-keyword-hint');
            if (fields) fields.style.display = wbKeywordToggle.checked ? 'block' : 'none';
            if (hint) hint.style.display = wbKeywordToggle.checked ? 'none' : 'block';
        });
    }
    document.getElementById('wb-entry-position-options')?.addEventListener('change', (event) => {
        if (event.target.matches('input[name="wb-entry-position-option"]')) {
            syncWorldBookPositionRadios(event.target.value);
        }
    });

    if (!worldBookIcon || !worldBookScreen) return;
    
    if(tabsContainer) {
       
    }

    // 1. 点击主屏幕的“世界书”图标 (恢复逻辑)
    worldBookIcon.addEventListener('click', async () => {
       const lastCategory = await getLastWorldBookCategory();
         
        showWorldBookScreen();
       await renderCategoryTabs(lastCategory); 
        const activeCategory = tabsContainer.querySelector('.tab-item.active')?.dataset.category || '默认';
        await renderWorldBookList(lastCategory);
    });
    // 2. 点击世界书页面的“返回”按钮 (恢复逻辑)
    backButton.addEventListener('click', () => {
        hideWorldBookScreen();
    });
    // 2.5 点击“+”按钮，显示或隐藏菜单 (恢复逻辑)
    if (addBtn && addMenu) {
        addBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            addMenu.classList.toggle('visible');
        });
        
        addMenu.addEventListener('click', (event) => {
            const menuItem = event.target.closest('.action-menu-item');
            if (menuItem) {
                const action = menuItem.dataset.action;
                if (action === 'add-group') {
                    addGroupModal.classList.add('visible');
                    addGroupInput.value = '';
                    addGroupInput.focus();
                } else if (action === 'add-entry') {
                    openAddWorldBookModal();
                } else if (action === 'delete-group') { // 新增的 else if
                    openDeleteGroupModal();
                }
                addMenu.classList.remove('visible');
            }
        });
    }
    
    // 点击页面其他地方隐藏“+”菜单 (恢复逻辑)
    document.addEventListener('click', (event) => {
        if (addMenu && addMenu.classList.contains('visible')) {
            if (!addMenu.contains(event.target) && !addBtn.contains(event.target)) {
                addMenu.classList.remove('visible');
            }
        }
    });
    
    // "添加分组"弹窗的事件处理 (恢复逻辑)
    if (addGroupModal) {
        cancelAddGroupBtn.addEventListener('click', () => {
            addGroupModal.classList.remove('visible');
        });
        saveAddGroupBtn.addEventListener('click', async () => {
            const groupName = addGroupInput.value.trim();
            if (groupName) {
                try {
                    await db.worldBookCategories.add({ name: groupName });
                    addGroupModal.classList.remove('visible');
                    await renderCategoryTabs();
                } catch (error) {
                    console.error('Failed to add category:', error);
                    alert(`添加失败：分组 "${groupName}" 可能已存在。`);
                }
            } else {
                alert('分组名称不能为空！');
            }
        });
        addGroupModal.addEventListener('click', (event) => {
            if (event.target === addGroupModal) {
                addGroupModal.classList.remove('visible');
            }
        });
    }
  // ▼▼▼ 【用下面的新代码 替换 旧的“删除分组”弹窗事件处理】 ▼▼▼
    if (deleteGroupModal) {
        // 取消按钮
        cancelDeleteGroupBtn.addEventListener('click', () => {
            deleteGroupModal.classList.remove('visible');
        });
        // 点击遮罩层关闭
        deleteGroupModal.addEventListener('click', (e) => {
            if (e.target === deleteGroupModal) {
                deleteGroupModal.classList.remove('visible');
            }
        });
        // **核心修改：确认删除按钮的逻辑（适配多选）**
        confirmDeleteGroupBtn.addEventListener('click', async () => {
            // 1. 获取所有被选中的复选框
            const selectedCheckboxes = deleteGroupModal.querySelectorAll('input[name="group-to-delete"]:checked');
            
            if (selectedCheckboxes.length === 0) {
                alert('请至少选择一个要删除的分组！');
                return;
            }
            // 2. 从复选框中提取分组名
            const groupNamesToDelete = Array.from(selectedCheckboxes).map(cb => cb.value);
            
            // 3. 生成更清晰的确认信息
            const confirmationMessage = `确定要删除以下 ${groupNamesToDelete.length} 个分组吗？\n\n- ${groupNamesToDelete.join('\n- ')}\n\n它们包含的所有设定将被移动到“默认”分组。`;
            if (!confirm(confirmationMessage)) {
                return;
            }
            try {
                // 4. **执行批量数据库操作**
                await db.transaction('rw', db.worldBookEntries, db.worldBookCategories, async () => {
                    // 批量移动条目
                    await db.worldBookEntries
                        .where('category').anyOf(groupNamesToDelete)
                        .modify({ category: '默认' });
                    
                    // 批量删除分组
                    await db.worldBookCategories
                        .where('name').anyOf(groupNamesToDelete)
                        .delete();
                });
                
                deleteGroupModal.classList.remove('visible');
                showDynamicIsland(`已删除 ${groupNamesToDelete.length} 个分组`);
                await setLastWorldBookCategory('默认');
                await renderCategoryTabs('默认');
                await renderWorldBookList('默认');
            } catch (error) {
                console.error('Failed to delete groups:', error);
                alert('批量删除分组失败，请查看控制台信息。');
            }
        });
    }
    // ▼▼▼ 【新增】“添加世界书”弹窗的事件处理 ▼▼▼
    if (addEntryModal) {
        // 点击“取消”
        cancelAddEntryBtn.addEventListener('click', () => {
            addEntryModal.classList.remove('visible');
        });

        // 点击遮罩层关闭
        addEntryModal.addEventListener('click', (e) => {
            if (e.target === addEntryModal) {
                addEntryModal.classList.remove('visible');
            }
        });

             // 点击“保存”
            saveAddEntryBtn.addEventListener('click', async () => {
            const idInput = document.getElementById('wb-entry-id-input');
            const entryId = idInput.value ? parseInt(idInput.value, 10) : null;
            const name = document.getElementById('wb-entry-name-input').value.trim();
            const content = document.getElementById('wb-entry-content-textarea').value.trim();
            const category = document.getElementById('wb-entry-group-select').value;
            const importance = document.querySelector('input[name="importance"]:checked').value;
            if (!name) {
                alert('名称不能为空！');
                return;
            }
            const injectionPosition = getWorldBookPositionValue();
            const keywordTriggerEnabled = document.getElementById('wb-entry-keyword-toggle')?.checked || false;
            const keywordsRaw = document.getElementById('wb-entry-keywords-input')?.value || '';
            const parsedKeywords = keywordsRaw.split(/[,，\n]/).map(k => k.trim()).filter(k => k.length > 0);
            const entryData = {
                title: name,
                content: content,
                category: category,
                importance: importance,
                injectionPosition: injectionPosition,
                keywordTriggerEnabled: keywordTriggerEnabled,
                keywords: parsedKeywords,
                createdAt: new Date()
            };
            try {
                if (entryId) {
                    // 编辑模式：更新数据库
                    await db.worldBookEntries.update(entryId, entryData);
                    showDynamicIsland('保存成功');
                } else {
                    // 添加模式：新增到数据库
                    await db.worldBookEntries.add(entryData);
                    showDynamicIsland('添加成功');
                }
                document.getElementById('add-wb-entry-modal-overlay').classList.remove('visible');
                
                // 刷新当前分类的视图
                await setLastWorldBookCategory(category);
                await renderCategoryTabs(category);
                await renderWorldBookList(category);
            } catch (error) {
                console.error('Failed to save world book entry:', error);
                alert('保存失败，请检查控制台。');
            }
        });
        
        // 【新增】为删除按钮添加事件监听器
        const deleteBtn = document.getElementById('delete-wb-entry-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async () => {
                const idInput = document.getElementById('wb-entry-id-input');
                const entryId = idInput.value ? parseInt(idInput.value, 10) : null;
                if (!entryId || !confirm('确定要删除这个设定吗？此操作无法撤销。')) {
                    return;
                }
                try {
                    await db.worldBookEntries.delete(entryId);
                    showDynamicIsland('删除成功');
                    document.getElementById('add-wb-entry-modal-overlay').classList.remove('visible');
                    
                    // 刷新当前视图
                    const currentCategory = await getLastWorldBookCategory();
                    await renderWorldBookList(currentCategory);
                } catch (error) {
                    console.error('Failed to delete world book entry:', error);
                    alert('删除失败，请检查控制台。');
                }
            });
        }
        
        // ▼▼▼ 新增开始：TXT导入功能逻辑 ▼▼▼
        const importTxtBtn = document.getElementById('wb-import-txt-btn');
        const importTxtInput = document.getElementById('wb-import-txt-input');
        if (importTxtBtn && importTxtInput) {
            importTxtBtn.addEventListener('click', () => importTxtInput.click()); // 点击按钮触发隐藏的文件选择器
            importTxtInput.addEventListener('change', async (e) => {
                const file = e.target.files[0];
                if (!file) return;

                const contentTextarea = document.getElementById('wb-entry-content-textarea');
                const nameInput = document.getElementById('wb-entry-name-input');
                const fileNameNoExt = file.name.replace(/\.[^/.]+$/, ""); // 去掉后缀的文件名

                // 判断是不是 Word 文档 (.docx)
                if (file.name.toLowerCase().endsWith('.docx')) {
                    try {
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('正在解析Word文档...');
                        // 动态加载 mammoth.js 解析工具 (只在第一次用时加载)
                        if (!window.mammoth) {
                            await new Promise((resolve, reject) => {
                                const script = document.createElement('script');
                               script.src = './js/features/mammoth.browser.min.js';
                                script.onload = resolve;
                                script.onerror = reject;
                                document.head.appendChild(script);
                            });
                        }
                        // 读取并解析出纯文字
                        const arrayBuffer = await file.arrayBuffer();
                        const result = await window.mammoth.extractRawText({ arrayBuffer });
                        if (contentTextarea) {
                            contentTextarea.value = result.value;
                            if (typeof showDynamicIsland === 'function') showDynamicIsland('Word文档导入成功');
                        }
                        if (nameInput && !nameInput.value) nameInput.value = fileNameNoExt;
                    } catch (err) {
                        console.error('解析docx失败:', err);
                        alert('Word文档解析失败，请检查网络连接后重试。');
                    }
                } else {
                    // 普通 TXT 文本，用 UTF-8 编码读取防止乱码
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        const text = event.target.result;
                        if (contentTextarea) {
                            contentTextarea.value = text;
                            if (typeof showDynamicIsland === 'function') showDynamicIsland('TXT内容导入成功');
                        }
                        if (nameInput && !nameInput.value) nameInput.value = fileNameNoExt;
                    };
                    reader.readAsText(file, 'UTF-8');
                }
                e.target.value = ''; // 清空，允许下次选择相同文件
            });
        }
    }




    // 3. 为分类标签容器添加点击事件
    if (tabsContainer) {
        tabsContainer.addEventListener('click', async (event) => {
            const clickedTab = event.target.closest('.tab-item');
            
            if (clickedTab && !clickedTab.classList.contains('active')) {
                tabsContainer.querySelectorAll('.tab-item').forEach(tab => tab.classList.remove('active'));
                clickedTab.classList.add('active');
                
                const category = clickedTab.dataset.category;
                
                // 将当前点击的分类存入 IndexedDB，避免继续依赖 localStorage。
                await setLastWorldBookCategory(category);

                // (后面的逻辑保持不变)
                
                await renderWorldBookList(category);
            }
        });
    }


    // 4. [新增] 为列表容器添加事件委托，处理卡片点击
    if (listContainer) {
        listContainer.addEventListener('click', (event) => {
            const clickedItem = event.target.closest('.world-book-item');
            if (clickedItem) {
                const itemId = parseInt(clickedItem.dataset.id, 10);
                // ▼▼▼ 【修改这一行】 ▼▼▼
                openEditWorldBookModal(itemId);
                // ▲▲▲ 【修改结束】 ▲▲▲
            }
        });
    }
}

/**
 * 显示世界书列表页面
 */
function showWorldBookScreen() {
    const worldBookScreen = document.getElementById('world-book-screen');
    const homeScreenWrapper = document.getElementById('home-screen-wrapper');
    if (worldBookScreen && homeScreenWrapper) {
        homeScreenWrapper.style.display = 'none';
        worldBookScreen.style.display = 'flex';
    }
}

/**
 * 隐藏世界书列表页面 (返回主屏幕)
 */
function hideWorldBookScreen() {
    const worldBookScreen = document.getElementById('world-book-screen');
    const homeScreenWrapper = document.getElementById('home-screen-wrapper');
    if (worldBookScreen && homeScreenWrapper) {
        worldBookScreen.style.display = 'none';
        homeScreenWrapper.style.display = 'flex';
    }
}

