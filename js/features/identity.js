import { AppState, db, tempState, DEFAULT_AVATAR_SRC } from '../state.js';
import { UI, showDynamicIsland, showInputModal, showPage } from '../ui.js';
import { addTapListener, compressImageDataUrl } from '../utils.js';

// ==========================================================================
// == 1. 核心共享函数 (Core Shared Functions)
// ==========================================================================

/**
 * 【重构核心】将此函数移到顶层，使其在文件内全局可访问。
 * 负责根据当前的 AppState.currentIdentityId 重新渲染交际圈列表。
 */
function renderSocialCircleList() {
    const container = UI.socialCircleListContainer;
    if (!container) return;

    const currentIdentity = AppState.userIdentities.find(id => id.id === AppState.currentIdentityId) || { socialCircle: [] };
    const contacts = currentIdentity.socialCircle || [];
    
    container.innerHTML = ''; // 清空旧内容

    const card = document.createElement('div');
    card.className = 'settings-card';

    if (contacts.length === 0) {
        card.innerHTML = `<div class="list-item" style="justify-content: center; color: var(--c-text-secondary);">交际圈是空的，添加一个吧！</div>`;
    } else {
        const fragment = document.createDocumentFragment();
        contacts.forEach(contact => {
            const item = document.createElement('div');
            item.className = 'list-item';
            item.dataset.contactId = contact.id;
            item.innerHTML = `
                <div class="settings-item-icon">
                    <img class="contact-avatar" src="${contact.avatar}" alt="avatar">
                </div>
                <div class="settings-item-text contact-info">
                    <span class="contact-name">${contact.name || '未命名'}</span>
                    <span class="contact-relation">${contact.relation || '未知关系'}</span>
                </div>
                <div class="settings-item-arrow">
                    <svg fill="none" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg>
                </div>`;
            fragment.appendChild(item);
        });
        card.appendChild(fragment);
    }
    container.appendChild(card);
}

/**
 * 更新主界面的用户信息UI，并在更新后刷新交际圈列表。
 */
async function updateProfileUI() {
    let identity = AppState.userIdentities.find(id => id.id === AppState.currentIdentityId);
    if (!identity && AppState.userIdentities.length > 0) {
        identity = AppState.userIdentities[0];
        AppState.currentIdentityId = identity.id;
        await db.appData.put({ key: 'currentIdentityId', value: AppState.currentIdentityId });
    }
    if (identity) {
        UI.avatarImg.src = identity.avatar;
        UI.nameDisplay.textContent = identity.name;
        UI.locationDisplay.textContent = identity.location;
        UI.personaTextarea.value = identity.persona || ''; // 修复了可能为undefined的问题
    }
    // 现在这个调用是有效的，因为 renderSocialCircleList 是全局可访问的
    renderSocialCircleList(); 
}

// ==========================================================================
// == 2. 功能模块初始化 (Feature Setup Functions)
// ==========================================================================

/* --- 2.1 用户身份管理 (User Identity) --- */
export function setupIdentitySwitcher() {
    async function saveAllIdentitiesData() {
        await db.appData.put({ key: 'userIdentities', value: AppState.userIdentities });
    }

    function populateModal() {
        const list = UI.identityList;
        list.innerHTML = '';
        const fragment = document.createDocumentFragment();
        AppState.userIdentities.forEach(identity => {
            const li = document.createElement('li');
            li.className = `selection-list-item ${identity.id === AppState.currentIdentityId ? 'active' : ''}`;
            li.dataset.id = identity.id;
            li.innerHTML = `
                <svg class="checkmark-icon" fill="none" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
                <span class="item-text">${identity.name}</span>
                ${identity.id !== 'default' ? `<svg class="delete-icon identity-delete-icon" data-id="${identity.id}" fill="none" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>` : ''}
            `;
            fragment.appendChild(li);
        });
        list.appendChild(fragment);
    }

    function showModal() {
        populateModal();
        UI.identityOverlay.classList.add('visible');
    }

    function hideModal() {
        UI.identityOverlay.classList.remove('visible');
    }

    UI.nameDisplay.addEventListener('click', () => showInputModal('修改角色网名', UI.nameDisplay.textContent, newName => {
        if (newName) UI.nameDisplay.textContent = newName;
    }));
    UI.locationDisplay.parentElement.addEventListener('click', e => {
        if (!e.target.closest('svg')) showInputModal('修改地点', UI.locationDisplay.textContent, newLocation => {
            if (newLocation !== null) UI.locationDisplay.textContent = newLocation;
        });
    });
    UI.accountMoreBtn.addEventListener('click', showModal);
    UI.identityCancelBtn.addEventListener('click', hideModal);
    UI.identityOverlay.addEventListener('click', e => {
        if (e.target === UI.identityOverlay) hideModal();
    });

    UI.identityList.addEventListener('click', async e => {
        const deleteIcon = e.target.closest('.identity-delete-icon');
        const targetItem = e.target.closest('.selection-list-item');

        if (deleteIcon) {
            e.stopPropagation();
            const idToDelete = deleteIcon.dataset.id;
            const identity = AppState.userIdentities.find(id => id.id === idToDelete);
            if (identity && confirm(`确定要删除身份 "${identity.name}" 吗？`)) {
                AppState.userIdentities = AppState.userIdentities.filter(id => id.id !== idToDelete);
                await saveAllIdentitiesData();
                if (AppState.currentIdentityId === idToDelete) await updateProfileUI();
                populateModal();
                showDynamicIsland('身份已删除');
            }
        } else if (targetItem) {
            const newId = targetItem.dataset.id;
            if (AppState.currentIdentityId === newId) {
                hideModal();
                return;
            }
            AppState.currentIdentityId = newId;

            // 【修复延迟问题】立即更新UI的选中状态
            UI.identityList.querySelectorAll('.selection-list-item').forEach(item => {
                item.classList.toggle('active', item.dataset.id === newId);
            });

            // 然后再执行异步任务
            await db.appData.put({ key: 'currentIdentityId', value: AppState.currentIdentityId });
            await updateProfileUI();
            hideModal();
        }
    });

    UI.addIdentityBtn.addEventListener('click', () => {
        showInputModal('为新身份命名', '新身份', async name => {
            if (!name) return;
            const newIdentity = {
                id: `identity_${Date.now()}`, name, location: '地点待定', persona: '',
                socialCircle: [], avatar: DEFAULT_AVATAR_SRC
            };
            AppState.userIdentities.push(newIdentity);
            await saveAllIdentitiesData();
            showDynamicIsland(`身份 "${name}" 已创建`);
            populateModal();
        }, { position: 'top' });
    });

    addTapListener(UI.saveIdentityBtn, async () => {
        const identityIndex = AppState.userIdentities.findIndex(id => id.id === AppState.currentIdentityId);
        if (identityIndex > -1) {
            AppState.userIdentities[identityIndex] = {
                ...AppState.userIdentities[identityIndex],
                name: UI.nameDisplay.textContent,
                location: UI.locationDisplay.textContent,
                avatar: UI.avatarImg.src
            };
            await saveAllIdentitiesData();
            showDynamicIsland(`身份 '${AppState.userIdentities[identityIndex].name}' 已保存`);
        }
    });

    updateProfileUI();
}

/* --- 2.2 用户人设页面 --- */
export function setupPersonaPage() {
    addTapListener(UI.savePersonaBtn, async () => {
        const identityIndex = AppState.userIdentities.findIndex(id => id.id === AppState.currentIdentityId);
        if (identityIndex > -1) {
            AppState.userIdentities[identityIndex].persona = UI.personaTextarea.value;
            await db.appData.put({ key: 'userIdentities', value: AppState.userIdentities });
            showDynamicIsland('人设已保存');
        } else {
            showDynamicIsland('保存失败：未找到当前用户');
        }
    });
}

/* --- 2.3 交际圈 (NPCs) 管理 --- */
export function setupSocialCircle() {
    async function saveCurrentIdentityData() {
        await db.appData.put({ key: 'userIdentities', value: AppState.userIdentities });
    }

    function populateContactEditPage(contactId) {
        const currentIdentity = AppState.userIdentities.find(id => id.id === AppState.currentIdentityId);
        if (!currentIdentity) return;
        const contact = (currentIdentity.socialCircle || []).find(c => c.id === contactId);

        if (contact) {
            tempState.editingContactId = contact.id;
            UI.contactEditAvatarImg.src = contact.avatar || DEFAULT_AVATAR_SRC;
            if (contactEditAvatarInput) contactEditAvatarInput.value = '';
            UI.contactEditNameInput.value = contact.name;
            UI.contactEditRelationInput.value = contact.relation;
            UI.contactPersonaTextarea.value = contact.persona;
        }
    }

    const contactEditAvatarInput = document.getElementById('contact-edit-avatar-input');
    contactEditAvatarInput?.addEventListener('change', event => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            event.target.value = '';
            showDynamicIsland('请选择图片文件');
            return;
        }

        const reader = new FileReader();
        reader.onload = async () => {
            if (typeof reader.result === 'string') {
                UI.contactEditAvatarImg.src = await compressImageDataUrl(reader.result);
            }
        };
        reader.onerror = () => showDynamicIsland('联系人头像读取失败');
        reader.readAsDataURL(file);
    });

    UI.socialCircleListContainer.addEventListener('click', (e) => {
        const targetItem = e.target.closest('.list-item[data-contact-id]');
        if (targetItem) {
            const contactId = targetItem.dataset.contactId;
            populateContactEditPage(contactId);
            showPage('page-contact-edit');
        }
    });

    UI.addContactBtn.addEventListener('click', () => {
        tempState.editingContactId = null; 
        UI.contactEditAvatarImg.src = DEFAULT_AVATAR_SRC;
        if (contactEditAvatarInput) contactEditAvatarInput.value = '';
        UI.contactEditNameInput.value = '';
        UI.contactEditRelationInput.value = '';
        UI.contactPersonaTextarea.value = '';
        showPage('page-contact-edit');
    });

    addTapListener(UI.saveContactBtn, async () => {
        const currentIdentity = AppState.userIdentities.find(id => id.id === AppState.currentIdentityId);
        if (!currentIdentity) return;
        if (!currentIdentity.socialCircle) currentIdentity.socialCircle = [];

        const contactData = {
            name: UI.contactEditNameInput.value || '未命名',
            relation: UI.contactEditRelationInput.value || '未知关系',
            persona: UI.contactPersonaTextarea.value,
            avatar: UI.contactEditAvatarImg.src
        };

        if (tempState.editingContactId) {
            const contactIndex = currentIdentity.socialCircle.findIndex(c => c.id === tempState.editingContactId);
            if (contactIndex > -1) {
                currentIdentity.socialCircle[contactIndex] = { ...currentIdentity.socialCircle[contactIndex], ...contactData };
                showDynamicIsland('联系人已更新');
            }
        } else {
            const newContact = { id: `contact_${Date.now()}`, ...contactData };
            currentIdentity.socialCircle.push(newContact);
            showDynamicIsland('联系人已添加');
        }

        await saveCurrentIdentityData();
        showPage('page-settings-social');
        renderSocialCircleList();
        tempState.editingContactId = null;
    });

    addTapListener(UI.deleteContactBtn, async () => {
        if (!tempState.editingContactId) return;
        const currentIdentity = AppState.userIdentities.find(id => id.id === AppState.currentIdentityId);
        if (!currentIdentity || !currentIdentity.socialCircle) return;

        const contact = currentIdentity.socialCircle.find(c => c.id === tempState.editingContactId);
        if (contact && confirm(`确定要删除联系人 "${contact.name}" 吗？`)) {
            currentIdentity.socialCircle = currentIdentity.socialCircle.filter(c => c.id !== tempState.editingContactId);
            await saveCurrentIdentityData();
            tempState.editingContactId = null;
            showDynamicIsland('联系人已删除');
            showPage('page-settings-social');
            renderSocialCircleList();
        }
    });
    
    // 初始加载时调用一次
    renderSocialCircleList();
}
