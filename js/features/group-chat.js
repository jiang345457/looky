import { AppState, db, tempState, DEFAULT_AVATAR_SRC, isCharacterFriend, getEffectiveThemeRuleForTarget } from '../state.js';
import { escapeHTML, isValidAvatarSrc } from '../utils.js';
import { showDynamicIsland, showPage } from '../ui.js';
import { optimizedSaveAndRender } from './character.js';
import { markPendingContextSwitch } from './chat-service.js';

const isSameCharacterId = (left, right) => left != null && right != null && String(left) === String(right);
const findCharacterById = (id) => AppState.characterProfiles.find(char => isSameCharacterId(char.id, id));
const hasCharacterId = (ids, id) => (ids || []).some(item => isSameCharacterId(item, id));
let groupQuickBeautifyListenerBound = false;

function getGroupNpcMembers(group) {
    const memberIds = group?.memberIds || [];
    const usedIds = new Set();
    return (Array.isArray(group?.groupNpcMembers) ? group.groupNpcMembers : [])
        .map((npc, index) => {
            const ownerId = npc?.ownerId;
            const name = String(npc?.name || '').trim();
            const id = String(npc?.id || `group-npc:${ownerId}:${index}`);
            if (!ownerId || !hasCharacterId(memberIds, ownerId) || !name || usedIds.has(id)) return null;
            usedIds.add(id);
            return { ...npc, id, name, isGroupNpc: true };
        })
        .filter(Boolean);
}

function getGroupParticipants(group) {
    return [
        ...(group?.memberIds || []).map(findCharacterById).filter(Boolean),
        ...getGroupNpcMembers(group)
    ];
}

function findGroupParticipantById(group, id) {
    return getGroupParticipants(group).find(member => isSameCharacterId(member.id, id));
}

function removeGroupParticipant(group, participant) {
    const removedIds = [participant.id];
    if (participant.isGroupNpc) {
        group.groupNpcMembers = getGroupNpcMembers(group)
            .filter(npc => !isSameCharacterId(npc.id, participant.id));
    } else {
        const removedNpcs = getGroupNpcMembers(group)
            .filter(npc => isSameCharacterId(npc.ownerId, participant.id));
        removedIds.push(...removedNpcs.map(npc => npc.id));
        group.memberIds = (group.memberIds || []).filter(id => !isSameCharacterId(id, participant.id));
        group.groupNpcMembers = getGroupNpcMembers(group)
            .filter(npc => !isSameCharacterId(npc.ownerId, participant.id));
    }
    group.adminIds = (group.adminIds || []).filter(id => !hasCharacterId(removedIds, id));
    for (const field of ['mutedMembers', 'specialTitles', 'memberMountedWBIds']) {
        if (!group[field] || typeof group[field] !== 'object') continue;
        removedIds.forEach(id => delete group[field][id]);
    }
}

export function initGroupChatSettings() {
    if (!groupQuickBeautifyListenerBound) {
        window.addEventListener('looky:quick-beautify-updated', (event) => {
            const groupChar = findCharacterById(tempState.currentChatId);
            if (!groupChar?.isGroup) return;
            const idMap = {
                detail: 'gc-quick-detail-val',
                bubble: 'gc-quick-bubble-val',
                offline: 'gc-quick-offline-val'
            };
            const targetId = idMap[event.detail?.type];
            if (!targetId) return;
            const target = document.getElementById(targetId);
            if (target) target.textContent = event.detail?.name || '默认';
        });
        groupQuickBeautifyListenerBound = true;
    }

    // ▼▼▼ 新增：全局拦截通讯录中群聊的点击，阻止弹出详情卡，直接进入聊天 ▼▼▼
    document.addEventListener('click', (e) => {
        // 尝试获取被点击的通讯录/好友列表项 (兼容常见的类名或带属性的元素)
        const listItem = e.target.closest('[data-id]') || e.target.closest('[data-char-id]');
        if (listItem) {
            if (listItem.closest('#add-friend-from-contacts-modal')) return;
            const charId = listItem.dataset.id || listItem.dataset.charId;
            const char = AppState.characterProfiles.find(c => String(c.id) === String(charId));
            // 如果点的是群聊，且点在了可能触发弹窗的地方
            if (char && char.isGroup) {
                // 强制阻止事件继续传递（防止触发原有弹窗代码）
                e.stopPropagation(); 
                // 直接调起进入聊天的逻辑
                import('./chat.js').then(({ handleFriendClick }) => {
                    handleFriendClick(char.id);
                });
            }
        }
    }, true); // 注意这里的 true，代表在“捕获阶段”最高优先级拦截
    // ▲▲▲ 新增结束 ▲▲▲

    const moreBtn = document.getElementById('chat-detail-more-btn');
    if (!moreBtn) return;

    // 监听聊天页右上角“更多”按钮的点击事件，独立渲染群聊设置
    moreBtn.addEventListener('click', () => {
        if (!tempState.currentChatId) return;
        const char = findCharacterById(tempState.currentChatId);
        // 只有当确认为群聊时，才接管渲染任务
        if (char && char.isGroup) {
            // 【性能优化】群聊：先让页面瞬间滑过去，再延迟渲染群聊网格头像等庞大DOM
            setTimeout(() => {
                renderGroupChatSettings(char);
            }, 300); // 修改：将50改为300，等抽屉/页面完全滑出动画结束后再渲染，彻底消灭掉帧卡顿
        }
    });

    // 绑定基础操作事件（只绑定一次）
    bindGroupSettingsEvents();
    bindAdvancedGroupSettingsEvents();
}

function renderGroupChatSettings(groupChar) {
    // 1. 渲染群聊基本信息
    const avatarEl = document.getElementById('group-settings-avatar');
    const nameEl = document.getElementById('group-settings-name');
    
    if (avatarEl) {
        avatarEl.src = isValidAvatarSrc(groupChar.avatar) ? groupChar.avatar : DEFAULT_AVATAR_SRC;
        
        // ▼▼▼ 新增：点击更换群聊头像并刷新列表 ▼▼▼
        avatarEl.style.cursor = 'pointer';
        avatarEl.onclick = () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                
                const reader = new FileReader();
                reader.onload = async (event) => {
                    const newAvatarBase64 = event.target.result;
                    // 1. 更新当前面板头像
                    avatarEl.src = newAvatarBase64;
                    // 2. 更新内存与数据库
                    groupChar.avatar = newAvatarBase64;
                    await db.characterProfiles.put(groupChar);
                    
                    // 3. 顺便更新一下聊天页面顶部的头像
                    const topAvatar = document.getElementById('chat-detail-char-avatar');
                    if (topAvatar) topAvatar.src = newAvatarBase64;

                    // 4. 只刷新列表，不重新初始化好友模块，避免重复绑定事件
                    const { refreshCharacterLists } = await import('./character.js');
                    refreshCharacterLists();
                    showDynamicIsland('群头像更换成功', 'success');
                };
                   reader.readAsDataURL(file); // 将图片转为 Base64 并保存
            };
            input.click();
        };
        // ▲▲▲ 新增结束 ▲▲▲
    }
     if (nameEl) nameEl.textContent = escapeHTML(groupChar.name);

    // ▼▼▼ 新增/修改：精确绑定名字与介绍的修改功能 ▼▼▼
    
    // 1. 【群名】修改逻辑
    const handleRenameGroup = async () => {
        const newName = prompt('请输入新的群聊名称：', groupChar.name);
        if (newName !== null && newName.trim() !== '' && newName.trim() !== groupChar.name) {
            const finalName = newName.trim();
            groupChar.name = finalName;
            await db.characterProfiles.put(groupChar);
            
            // 同步三处UI
            if (nameEl) nameEl.textContent = escapeHTML(finalName);
            const topName = document.getElementById('chat-detail-char-name');
            if (topName) topName.textContent = escapeHTML(finalName);
            if (listItemNameSpan) listItemNameSpan.textContent = escapeHTML(finalName);
            
            // 刷新外层列表，不重新绑定好友模块事件
            const { refreshCharacterLists } = await import('./character.js');
            refreshCharacterLists();
            showDynamicIsland('群名称已更新', 'success');
                     // 让大模型感知到群名变化 (作为系统隐式记忆)
            const { addSystemEventMessage } = await import('./chat-service.js');
            await addSystemEventMessage(groupChar.id, `[系统隐式提示：用户刚刚将群聊名称修改为了"${finalName}"]`, 'info', true);
        }
    };
    // ▼▼▼ 以下替换为分离、独立的群介绍与群公告逻辑 ▼▼▼

    // 2. 【群介绍】(顶部卡片) 独立修改逻辑
    const descEl = document.getElementById('group-settings-desc');
    if (descEl) descEl.textContent = groupChar.description || '点击查看或修改群介绍...';

    const handleEditDesc = async () => {
        const newDesc = prompt('请输入新的群介绍：', groupChar.description || '');
        if (newDesc !== null && newDesc.trim() !== (groupChar.description || '')) {
            const finalDesc = newDesc.trim();
            groupChar.description = finalDesc; // 存入 description 字段
            await db.characterProfiles.put(groupChar);
            if (descEl) descEl.textContent = finalDesc || '点击查看或修改群介绍...';
            showDynamicIsland('群介绍已更新', 'success');
                       // 让大模型感知到群介绍变化
            const { addSystemEventMessage } = await import('./chat-service.js');
            await addSystemEventMessage(groupChar.id, `[系统隐式提示：用户刚刚将群介绍修改为了"${finalDesc}"]`, 'info', true);
        }
    };
     // 3. 【新版群公告】渲染列表与增删改逻辑
    const annListContainer = document.getElementById('group-announcement-list');
    const annPreviewSpan = document.getElementById('group-announcement-preview');
    const addAnnBtn = document.getElementById('add-group-announcement-btn');

    const renderAnnouncements = () => {
        if (!annListContainer || !annPreviewSpan) return;
        
        let announcements = groupChar.announcements || [];
        if (announcements.length > 3) announcements = announcements.slice(0, 3); // 限制最多3条
        
        annListContainer.innerHTML = '';
        
        // 更新下拉栏外的预览摘要（优先显示置顶的，没有则显示最新的）
        const pinnedAnn = announcements.find(a => a.isPinned);
        const previewAnn = pinnedAnn || announcements[0];
        // 兼容旧的单一公告字段，如果新数组为空，尝试读取旧字段
        if (!previewAnn && groupChar.announcement) {
            annPreviewSpan.textContent = escapeHTML(groupChar.announcement).substring(0, 10) + '...';
        } else {
            annPreviewSpan.textContent = previewAnn ? escapeHTML(previewAnn.text).substring(0, 10) + '...' : '未设置';
        }

        if (announcements.length === 0) {
            annListContainer.innerHTML = '<div style="text-align: center; color: #999; font-size: 12px; padding: 10px;">暂无公告</div>';
        } else {
            // 排序：置顶的排最上面，其余按时间倒序
            const sortedAnns = [...announcements].sort((a, b) => {
                if (a.isPinned && !b.isPinned) return -1;
                if (!a.isPinned && b.isPinned) return 1;
                return b.timestamp - a.timestamp;
            });

            sortedAnns.forEach(ann => {
                const dateStr = new Date(ann.timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
                
                const card = document.createElement('div');
                card.style.cssText = 'background: #fff; padding: 16px; border-radius: 16px; border: 1px solid #eaeaea; position: relative; box-shadow: 0 4px 12px rgba(0,0,0,0.02); display: flex; flex-direction: column; gap: 10px;';
                
                const header = document.createElement('div');
                header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; border-bottom: 1px dashed #f0f0f0; padding-bottom: 8px;';
                
                let tagsHtml = '';
                if (ann.isPinned) {
                    tagsHtml += '<span style="font-size: 10px; color: #ff3b30; background: rgba(255,59,48,0.08); padding: 3px 8px; border-radius: 12px; font-weight: 800; margin-right: 6px;">PINNED</span>';
                }
                
                header.innerHTML = `
                    <div style="display: flex; align-items: center;">
                        ${tagsHtml}
                        <span style="font-size: 11px; color: #aaa; font-family: monospace;">${dateStr}</span>
                    </div>
                    <div style="display: flex; gap: 12px;">
                        <span class="edit-ann-btn" style="font-size: 12px; color: #666; cursor: pointer; display: flex; align-items: center; gap: 4px; font-weight: 500;"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>编辑</span>
                        <span class="del-ann-btn" style="font-size: 12px; color: #ff3b30; cursor: pointer; display: flex; align-items: center; gap: 4px; font-weight: 500;"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>删除</span>
                    </div>
                `;
                
                const content = document.createElement('div');
                content.style.cssText = 'font-size: 14px; color: #222; line-height: 1.6; white-space: pre-wrap; word-break: break-all;';
                content.textContent = ann.text;

                card.appendChild(header);
                card.appendChild(content);

                // 绑定单个卡片的修改和删除事件
                card.querySelector('.edit-ann-btn').onclick = (e) => {
                    e.stopPropagation();
                    openAnnouncementModal(groupChar, ann, renderAnnouncements);
                };
                card.querySelector('.del-ann-btn').onclick = async (e) => {
                    e.stopPropagation();
                    if (confirm('确定删除这条公告吗？')) {
                        groupChar.announcements = groupChar.announcements.filter(a => a.id !== ann.id);
                        // 兼容旧字段
                        const p = groupChar.announcements.find(a => a.isPinned) || groupChar.announcements[0];
                        groupChar.announcement = p ? p.text : '';
                        await db.characterProfiles.put(groupChar);
                        renderAnnouncements();
                        showDynamicIsland('已删除公告', 'success');
                    }
                };

                annListContainer.appendChild(card);
            });
        }
    };

    renderAnnouncements(); // 首次进入渲染一遍

    if (addAnnBtn) {
        addAnnBtn.onclick = (e) => {
            e.stopPropagation();
            let anns = groupChar.announcements || [];
            if (anns.length >= 3) {
                showDynamicIsland('最多只能设置3条群公告', 'warning');
                return;
            }
            openAnnouncementModal(groupChar, null, renderAnnouncements);
        };
    }

    // 4. 【绑定顶部点击事件】

    if (nameEl) {
        nameEl.style.cursor = 'pointer';
        nameEl.onclick = (e) => { e.stopPropagation(); handleRenameGroup(); };
    }
    if (descEl) {
        descEl.style.cursor = 'pointer';
        descEl.onclick = (e) => { e.stopPropagation(); handleEditDesc(); };
    }

    // 5. 【扫描下方列表】分别绑定群聊名称和群公告
    let listItemNameSpan = null;
    const settingsItems = document.querySelectorAll('#page-group-chat-settings .settings-item');
    settingsItems.forEach(item => {
        const firstSpan = item.querySelector('span');
        if (firstSpan) {
            const text = firstSpan.textContent.trim();
            const valSpan = item.querySelector('.settings-item-value span');
            if (text === '群聊名称' && valSpan) {
                listItemNameSpan = valSpan;
                valSpan.textContent = escapeHTML(groupChar.name); 
                item.style.cursor = 'pointer';
                item.onclick = handleRenameGroup; 
            }
            // ▼▼▼ 新增：绑定“群号和二维码”点击事件 ▼▼▼

            else if (text === '群号和二维码') {
                 // 兼容以前建的老群聊：如果发现这个群没有群号，就立刻现场补发一个并存入数据库
                if (!groupChar.groupNumber) {
                    groupChar.groupNumber = Math.floor(10000000 + Math.random() * 90000000).toString();
                    db.characterProfiles.put(groupChar); 
                }

                // ▼▼▼ 新增：把群号写进 index.html 里刚刚加的那个 span 中 ▼▼▼
                if (valSpan) valSpan.textContent = groupChar.groupNumber;

                item.style.cursor = 'pointer';
                item.onclick = () => {

                    // 弹出一个原生提示框显示群名和群号
                    alert(`【${groupChar.name}】\n群聊号码：${groupChar.groupNumber}\n\n(扫码功能开发中)`);
                };
            }
            // ▲▲▲ 新增结束 ▲▲▲

            // ▼▼▼ 新增：绑定“我的本群昵称”点击与修改事件 ▼▼▼
            else if (text === '我的本群昵称' && valSpan) {
                valSpan.textContent = escapeHTML(groupChar.chatOverrideUserNickname || '未设置');
                item.style.cursor = 'pointer';
                item.onclick = (e) => {
                    // 如果已经在编辑状态（出现了输入框），就不再重复触发
                    if (valSpan.querySelector('input')) return;
                    
                    // 获取当前昵称
                    const currentName = groupChar.chatOverrideUserNickname || '';
                    
                    // 在原处生成一个无边框的输入框
                    valSpan.innerHTML = `<input type="text" style="width: 100px; text-align: right; border: none; outline: none; background: transparent; font-size: 14px; color: #333;" value="${escapeHTML(currentName)}" placeholder="输入昵称">`;
                    
                    const inputEl = valSpan.querySelector('input');
                    inputEl.focus(); // 自动聚焦光标
                    
                    // 定义保存逻辑
                    const saveNickname = async () => {
                        const finalNickname = inputEl.value.trim();
                        groupChar.chatOverrideUserNickname = finalNickname; 
                        await db.characterProfiles.put(groupChar); 
                        
                        // 恢复成普通文字展示
                        valSpan.textContent = escapeHTML(finalNickname || '未设置'); 
                        showDynamicIsland('本群昵称已更新', 'success');
                        
                        // 【最核心】将这个改名动作化作“系统旁白”偷偷告诉群里的AI，让所有群员立刻知道
                        const { addSystemEventMessage } = await import('./chat-service.js');
                        await addSystemEventMessage(groupChar.id, `[系统隐式提示：用户刚刚将自己在群里的昵称修改为了"${finalNickname}"]`, 'info', true);
                    };

                    // 当用户点击别处失去焦点时保存
                    inputEl.onblur = saveNickname;
                    // 当用户按下回车键时保存
                    inputEl.onkeydown = (e) => {
                        if (e.key === 'Enter') {
                            inputEl.blur(); // 手动触发失去焦点来保存
                        }
                    };
                };
            }
            // ▼▼▼ 新增：为群成员设置专属头衔 (下拉栏展开模式 - 黑白灰重构版) ▼▼▼
            else if (text === '为群成员设置专属头衔') {
                const arrow = item.querySelector('.settings-arrow');
                if (arrow) arrow.style.transition = 'transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)';
                
                item.style.borderBottom = 'none'; 
                item.style.cursor = 'pointer';
                let dropdownBox = item.parentElement.querySelector('#special-title-dropdown-box');
                if (!dropdownBox) {
                    dropdownBox = document.createElement('div');
                    dropdownBox.id = 'special-title-dropdown-box';
                    // 极简浅灰背景，隐去多余线条
                    dropdownBox.style.cssText = 'display: none; flex-direction: column; background: #fafafa; border-top: 1px solid #f2f2f2; padding: 4px 16px 12px; border-bottom: 1px solid #f2f2f2; margin-bottom: 10px;';
                    item.insertAdjacentElement('afterend', dropdownBox);
                } else {
                    // 新增：如果存在旧的盒子，切群时强制将其复位折叠，防止错位
                    dropdownBox.style.display = 'none';
                    if (arrow) arrow.style.transform = 'rotate(0deg)';
                }

                const renderDropdownList = () => {

                    dropdownBox.innerHTML = '';
                    const userIdentityId = groupChar.chatIdentityId || AppState.currentIdentityId;
                    const currentUser = AppState.userIdentities.find(id => id.id === userIdentityId) || AppState.userIdentities[0];
                    
                    // 获取当前操作人的最高权限
                    const currentOwnerId = groupChar.ownerId || currentUser.id;
                    const isUserOwner = isSameCharacterId(currentOwnerId, currentUser.id);
                    const isUserAdmin = hasCharacterId(groupChar.adminIds, currentUser.id);
                    const hasPermission = isUserOwner || isUserAdmin;

                    // 把用户自己加入成员列表
                    const rawMembers = getGroupParticipants(groupChar);
                    const members = [currentUser, ...rawMembers]; 

                    if (!groupChar.specialTitles) groupChar.specialTitles = {};

                    if (members.length === 0) {
                        dropdownBox.innerHTML = '<div style="padding: 15px; text-align: center; color: #999; font-size: 13px;">群内暂无成员</div>';
                        return;
                    }

                    members.forEach(m => {
                        const currentTitle = groupChar.specialTitles[m.id] || '';
                        const row = document.createElement('div');
                        row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid #f0f0f0;';
                        
                        const titleBadge = currentTitle 
                            ? `<span style="font-size: 11px; color: #111; background: #eee; padding: 2px 8px; border-radius: 4px; font-weight: bold; margin-top: 5px; display: inline-block;">${escapeHTML(currentTitle)}</span>` 
                            : `<span style="font-size: 11px; color: #bbb; margin-top: 5px; font-weight: normal;">暂无专属头衔</span>`;

                        row.innerHTML = `
                            <div style="display: flex; align-items: center; gap: 12px; overflow: hidden; flex: 1;">
                                <img src="${isValidAvatarSrc(m.avatar) ? m.avatar : DEFAULT_AVATAR_SRC}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 1px solid #e5e5e5; flex-shrink: 0;">
                                <div style="display: flex; flex-direction: column; overflow: hidden; align-items: flex-start;">
                                    <span style="font-size: 15px; font-weight: 600; color: #111; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;">${escapeHTML(m.name)}${m.id === currentUser.id ? ' (我)' : ''}</span>
                                    ${titleBadge}
                                </div>
                            </div>
                            <div style="display: flex; gap: 8px; flex-shrink: 0;">
                                ${!hasPermission ? '' : `
                                    ${currentTitle ? `<button class="btn-reset-title" style="background: #f5f5f5; color: #666; border: 1px solid #e0e0e0; padding: 6px 14px; border-radius: 16px; font-size: 12px; cursor: pointer; font-weight: 600;">重置</button>` : ''}
                                    <button class="btn-set-title" style="background: #111; color: #fff; border: none; padding: 7px 15px; border-radius: 16px; font-size: 12px; cursor: pointer; font-weight: 600; box-shadow: 0 2px 6px rgba(0,0,0,0.15);">设置</button>
                                `}
                            </div>
                        `;

                        const setBtn = row.querySelector('.btn-set-title');
                        if (setBtn) {
                            setBtn.onclick = async (e) => {
                                e.stopPropagation();
                                const newTitle = prompt(`为【${m.name}】赋予专属头衔：\n(输入头衔名称，限10字内)`, currentTitle);
                                if (newTitle !== null && newTitle.trim() !== currentTitle) {
                                    const finalTitle = newTitle.trim().substring(0, 10);
                                    if (finalTitle === '') delete groupChar.specialTitles[m.id];
                                    else groupChar.specialTitles[m.id] = finalTitle;
                                    
                                    await db.characterProfiles.put(groupChar);
                                    renderDropdownList(); 
                                    if (finalTitle !== '') {
                                        const { addSystemEventMessage } = await import('./chat-service.js');
                                        await addSystemEventMessage(groupChar.id, `群主赋予了 ${m.name} 全新的专属头衔「${finalTitle}」`, 'info', false);
                                        if(typeof showDynamicIsland === 'function') showDynamicIsland('专属头衔已生效', 'success');
                                    }
                                }
                            };
                        }

                        const resetBtn = row.querySelector('.btn-reset-title');
                        if (resetBtn) {
                            resetBtn.onclick = async (e) => {
                                e.stopPropagation();
                                if (confirm(`确定要收回【${m.name}】的专属头衔吗？`)) {
                                    delete groupChar.specialTitles[m.id];
                                    await db.characterProfiles.put(groupChar);
                                    renderDropdownList(); 
                                    const { addSystemEventMessage } = await import('./chat-service.js');
                                    await addSystemEventMessage(groupChar.id, `群主收回了 ${m.name} 的专属头衔`, 'info', false);
                                    if(typeof showDynamicIsland === 'function') showDynamicIsland('头衔已重置', 'success');
                                }
                            };
                        }
                        dropdownBox.appendChild(row);
                    });
                };

                item.onclick = (e) => {
                    e.stopPropagation();
                    if (dropdownBox.style.display === 'none') {
                        renderDropdownList(); 
                        dropdownBox.style.display = 'flex';
                        if (arrow) arrow.style.transform = 'rotate(90deg)';
                    } else {
                        dropdownBox.style.display = 'none';
                        if (arrow) arrow.style.transform = 'rotate(0deg)';
                    }
                };
            }
            // ▼▼▼ 新增：群内禁言功能 (UI交互) ▼▼▼
            else if (text === '群内禁言') {
                const arrow = item.querySelector('.settings-arrow');
                if (arrow) arrow.style.transition = 'transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)';
                
                item.style.borderBottom = 'none'; 
                item.style.cursor = 'pointer';
                let dropdownBox = item.parentElement.querySelector('#mute-dropdown-box');
                if (!dropdownBox) {
                    dropdownBox = document.createElement('div');
                    dropdownBox.id = 'mute-dropdown-box';
                    dropdownBox.style.cssText = 'display: none; flex-direction: column; background: #fafafa; border-top: 1px solid #f2f2f2; padding: 4px 16px 12px; border-bottom: 1px solid #f2f2f2; margin-bottom: 10px;';
                    item.insertAdjacentElement('afterend', dropdownBox);
                } else {
                    // 新增：如果存在旧的盒子，切群时强制将其复位折叠，防止错位
                    dropdownBox.style.display = 'none';
                    if (arrow) arrow.style.transform = 'rotate(0deg)';
                }

                // ▼▼▼ 新增：监听AI管理员的禁言操作，保持数据同步并实时刷新UI ▼▼▼

                if (item._muteUpdateListener) {
                    document.removeEventListener('group_mute_updated', item._muteUpdateListener);
                }
                item._muteUpdateListener = async (e) => {
                    if (e.detail.chatId === groupChar.id) {
                        // AI 刚刚修改了数据库，我们需要读取最新状态更新到当前内存
                        const updatedChar = await db.characterProfiles.get(groupChar.id);
                        if (updatedChar) {
                            groupChar.mutedMembers = updatedChar.mutedMembers;
                            groupChar.isMuteAll = updatedChar.isMuteAll;
                            // 如果面板当前处于展开状态，立刻重绘，实现无缝实时刷新
                            if (dropdownBox.style.display !== 'none') {
                                renderMuteList();
                            }
                        }
                    }
                };
                document.addEventListener('group_mute_updated', item._muteUpdateListener);
                // ▲▲▲ 新增结束 ▲▲▲

                const renderMuteList = () => {
                    dropdownBox.innerHTML = '';
                    const userIdentityId = groupChar.chatIdentityId || AppState.currentIdentityId;
                    const currentUser = AppState.userIdentities.find(id => id.id === userIdentityId) || AppState.userIdentities[0];
                    const currentOwnerId = groupChar.ownerId || currentUser.id;
                    const isUserOwner = isSameCharacterId(currentOwnerId, currentUser.id);
                    const isUserAdmin = hasCharacterId(groupChar.adminIds, currentUser.id);
                    const hasPermission = isUserOwner || isUserAdmin;

                    const members = getGroupParticipants(groupChar);

                    if (!groupChar.mutedMembers) groupChar.mutedMembers = {};

                    // 全体禁言开关
                    const muteAllRow = document.createElement('div');
                    muteAllRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 12px 0 14px; border-bottom: 1px dashed #ddd; margin-bottom: 5px;';
                    const isMuteAll = groupChar.isMuteAll || false;
                    muteAllRow.innerHTML = `
                        <span style="font-size: 14px; font-weight: 600; color: ${isMuteAll ? '#ff3b30' : '#111'};">全体禁言 (群主/管理除外)</span>
                        ${!hasPermission ? '<span style="font-size: 12px; color: #999;">无权限</span>' : `
                        <button class="btn-mute-all" style="background: ${isMuteAll ? '#ffeeed' : '#111'}; color: ${isMuteAll ? '#ff3b30' : '#fff'}; border: ${isMuteAll ? '1px solid #ff3b30' : 'none'}; padding: 6px 14px; border-radius: 16px; font-size: 12px; cursor: pointer; font-weight: 600;">
                            ${isMuteAll ? '解除全体禁言' : '开启全体禁言'}
                        </button>
                        `}
                    `;
                    const muteAllBtn = muteAllRow.querySelector('.btn-mute-all');
                    if (muteAllBtn) {
                        muteAllBtn.onclick = async (e) => {
                            e.stopPropagation();
                            groupChar.isMuteAll = !isMuteAll;
                            await db.characterProfiles.put(groupChar);
                            renderMuteList(); 
                            const { addSystemEventMessage } = await import('./chat-service.js');
                            await addSystemEventMessage(groupChar.id, groupChar.isMuteAll ? `${isUserOwner?'群主':'管理员'}开启了全体禁言` : `${isUserOwner?'群主':'管理员'}解除了全体禁言`, 'info', false);
                        };
                    }
                    dropdownBox.appendChild(muteAllRow);

                    if (members.length === 0) {
                        dropdownBox.insertAdjacentHTML('beforeend', '<div style="padding: 15px; text-align: center; color: #999; font-size: 13px;">群内暂无其他成员</div>');
                        return;
                    }
                    const now = Date.now();
                    members.forEach(m => {
                        const isAdmin = hasCharacterId(groupChar.adminIds, m.id);
                        const isTargetOwner = isSameCharacterId(groupChar.ownerId, m.id);
                        const muteExpire = groupChar.mutedMembers[m.id] || 0;
                        const isMuted = muteExpire === -1 || muteExpire > now;

                        // 核心：判定权限！群主无敌；管理员不能禁言群主和其它管理员
                        let canMuteThisMember = false;
                        if (isUserOwner) {
                            canMuteThisMember = true; 
                        } else if (isUserAdmin) {
                            canMuteThisMember = !isAdmin && !isTargetOwner;
                        }
                        
                                                let adminBadge = isTargetOwner ? '<span style="background:#111; color:#fff; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:600; margin-left:6px;">群主</span>' : (isAdmin ? '<span style="background:#f5f5f5; color:#333; padding:1px 6px; border-radius:4px; font-size:10px; font-weight:600; margin-left:6px; border:1px solid #e0e0e0;">管理员</span>' : '');

                        let muteStatusHtml = '';
                        
                        if (isMuted) {
                            if (muteExpire === -1) muteStatusHtml = '<span style="color:#888; font-weight:bold; font-size:11px;">已禁言 (永久)</span>';
                            else muteStatusHtml = `<span style="color:#888; font-weight:bold; font-size:11px;">已禁言 (${Math.ceil((muteExpire-now)/60000)}分钟)</span>`;
                        } else {
                            muteStatusHtml = '<span style="color:#bbb; font-size:11px;">正常发言</span>';
                        }

                        const row = document.createElement('div');
                        row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #f0f0f0;';
                        row.innerHTML = `
                            <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
                                <img src="${isValidAvatarSrc(m.avatar) ? m.avatar : DEFAULT_AVATAR_SRC}" style="width: 36px; height: 36px; border-radius: 50%; object-fit: cover; border: 1px solid #e5e5e5;">
                                <div style="display: flex; flex-direction: column;">
                                    <div style="display: flex; align-items: center;">
                                        <span style="font-size: 14px; font-weight: 600; color: #111;">${escapeHTML(m.name)}</span>
                                        ${adminBadge}
                                    </div>
                                    <div style="margin-top: 2px;">
                                        ${muteStatusHtml}
                                    </div>
                                </div>
                            </div>
                            <div style="display: flex; gap: 8px;">
                                ${!canMuteThisMember ? '' : `
                                    ${isMuted 
                                        ? `<button class="btn-unmute" style="background: #f5f5f5; color: #666; border: 1px solid #e0e0e0; padding: 6px 14px; border-radius: 16px; font-size: 12px; cursor: pointer; font-weight: 600;">解除</button>` 
                                        : `<button class="btn-mute" style="background: #111; color: #fff; border: none; padding: 6px 14px; border-radius: 16px; font-size: 12px; cursor: pointer; font-weight: 600;">禁言</button>`}
                                `}
                            </div>
                        `;

                        const unmuteBtn = row.querySelector('.btn-unmute');
                        if (unmuteBtn) {
                            unmuteBtn.onclick = async (e) => {
                                e.stopPropagation();
                                delete groupChar.mutedMembers[m.id];
                                await db.characterProfiles.put(groupChar);
                                renderMuteList();
                                const { addSystemEventMessage } = await import('./chat-service.js');
                                await addSystemEventMessage(groupChar.id, `${isUserOwner?'群主':'管理员'}解除了 ${m.name} 的禁言`, 'info', false);
                            };
                        } 
                        
                        const muteBtn = row.querySelector('.btn-mute');
                        if (muteBtn) {
                            muteBtn.onclick = async (e) => {
                                e.stopPropagation();
                                const mins = prompt(`要将【${m.name}】禁言多少分钟？\n(输入 0 为永久禁言，留空则取消)`, "10");
                                if (mins !== null && mins.trim() !== '') {
                                    const parsed = Number(mins.trim());
                                    if (Number.isInteger(parsed) && parsed >= 0) {
                                        groupChar.mutedMembers[m.id] = parsed === 0 ? -1 : Date.now() + parsed * 60000;
                                        await db.characterProfiles.put(groupChar);
                                        renderMuteList();
                                        const { addSystemEventMessage } = await import('./chat-service.js');
                                        await addSystemEventMessage(groupChar.id, `${isUserOwner?'群主':'管理员'}将 ${m.name} 禁言了 ${parsed === 0 ? '永久' : parsed + ' 分钟'}`, 'info', false);
                                    } else {
                                        showDynamicIsland('请输入 0 或正整数分钟', 'warning');
                                    }
                                }
                            };
                        }
                        dropdownBox.appendChild(row);
                    });
                };

                item.onclick = (e) => {
                    e.stopPropagation();
                    if (dropdownBox.style.display === 'none') {
                        renderMuteList(); 
                        dropdownBox.style.display = 'flex';
                        if (arrow) arrow.style.transform = 'rotate(90deg)';
                        
                        // ▼▼▼ 新增：打开面板时启动实时检查，时间一到立刻解除并刷新 ▼▼▼
                        if (item._muteTimer) clearInterval(item._muteTimer);
                        item._muteTimer = setInterval(async () => {
                            let hasExpired = false;
                            const currentTime = Date.now();
                            // 每秒钟偷偷遍历一遍，看看有没有人刚好到期
                            for (const mId in groupChar.mutedMembers) {
                                const exp = groupChar.mutedMembers[mId];
                                if (exp !== -1 && exp > 0 && exp <= currentTime) {
                                    delete groupChar.mutedMembers[mId];
                                    hasExpired = true;
                                }
                            }
                            // 如果发现有人到期了，立刻更新数据库并瞬间重绘UI
                            if (hasExpired) {
                                await db.characterProfiles.put(groupChar);
                                renderMuteList(); 
                            }
                        }, 1000); // 1000毫秒 = 1秒检查一次
                        // ▲▲▲ 新增结束 ▲▲▲
                        
                    } else {
                        dropdownBox.style.display = 'none';
                        if (arrow) arrow.style.transform = 'rotate(0deg)';
                         // ▼▼▼ 新增：关掉面板时立刻停止检查，省电防卡顿 ▼▼▼
                        if (item._muteTimer) clearInterval(item._muteTimer);
                        // ▲▲▲ 新增结束 ▲▲▲
                    }
                };
            }
            // ▼▼▼ 新增：转让群功能 (UI交互) ▼▼▼
            else if (text === '转让群') {
                const arrow = item.querySelector('.settings-arrow');
                if (arrow) arrow.style.transition = 'transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)';
                
                item.style.borderBottom = 'none'; 
                item.style.cursor = 'pointer';
                let dropdownBox = item.parentElement.querySelector('#transfer-dropdown-box');
                if (!dropdownBox) {
                    dropdownBox = document.createElement('div');
                    dropdownBox.id = 'transfer-dropdown-box';
                    dropdownBox.style.cssText = 'display: none; flex-direction: column; background: #fafafa; border-top: 1px solid #f2f2f2; padding: 4px 16px 12px; border-bottom: 1px solid #f2f2f2; margin-bottom: 10px;';
                    item.insertAdjacentElement('afterend', dropdownBox);
                } else {
                    // 新增：如果存在旧的盒子，切群时强制将其复位折叠，防止错位
                    dropdownBox.style.display = 'none';
                    if (arrow) arrow.style.transform = 'rotate(0deg)';
                }

                // 监听AI主动转让群主的事件并刷新UI

                if (item._ownerUpdateListener) {
                    document.removeEventListener('group_owner_updated', item._ownerUpdateListener);
                }
                 item._ownerUpdateListener = async (e) => {
                    if (e.detail.chatId === groupChar.id) {
                        const updatedChar = await db.characterProfiles.get(groupChar.id);
                        if (updatedChar) {
                            groupChar.ownerId = updatedChar.ownerId;
                            renderGroupChatSettings(groupChar); // 强制刷新面板外层头像和文字
                            if (dropdownBox.style.display !== 'none') {
                                renderTransferList();
                            }
                        }
                    }
                };

                document.addEventListener('group_owner_updated', item._ownerUpdateListener);

                const renderTransferList = () => {
                    dropdownBox.innerHTML = '';
                    const members = getGroupParticipants(groupChar);
                    
                    // 获取当前用户身份作为对比
                    const userIdentityId = groupChar.chatIdentityId || AppState.currentIdentityId;
                    const currentUser = AppState.userIdentities.find(id => id.id === userIdentityId) || AppState.userIdentities[0];
                    const currentOwnerId = groupChar.ownerId || currentUser.id;

                    const isUserOwner = isSameCharacterId(currentOwnerId, currentUser.id);
                     // 顶部状态提示与强制收回按钮
                    const topRow = document.createElement('div');
                    topRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 12px 0 14px; border-bottom: 1px dashed #ddd; margin-bottom: 5px;';

                    if (isUserOwner) {
                        topRow.innerHTML = `<span style="font-size: 14px; font-weight: 600; color: #111; display: flex; align-items: center;"><svg viewBox="0 0 24 24" width="16" height="16" fill="#111" stroke="none" style="margin-right: 6px;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>你目前是本群群主</span>`;
                    } else {

                        const ownerChar = members.find(m => isSameCharacterId(m.id, currentOwnerId));
                        const ownerName = ownerChar ? escapeHTML(ownerChar.name) : '未知成员';
                        topRow.innerHTML = `
                            <span style="font-size: 14px; font-weight: 600; color: #555; display: flex; align-items: center;"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#888" stroke-width="2" style="margin-right: 6px;"><circle cx="12" cy="8" r="5"></circle><path d="M20 21a8 8 0 1 0-16 0"></path></svg>群主: <span style="color:#111; margin-left:4px;">${ownerName}</span></span>
                            <button class="btn-force-reclaim" style="background: #fff; color: #ff3b30; border: 1px solid #ff3b30; padding: 5px 12px; border-radius: 16px; font-size: 12px; cursor: pointer; font-weight: 600; box-shadow: 0 2px 4px rgba(255,59,48,0.1);">强制收回</button>
                        `;
                                       topRow.querySelector('.btn-force-reclaim').onclick = async (e) => {
                            e.stopPropagation();
                            if (confirm('强制收回群主身份可能会引发AI不满，确定要收回吗？')) {
                                groupChar.ownerId = currentUser.id;
                                
                                // ▼▼▼ 新增：夺回群主后，自动解除自己身上的专属禁言 ▼▼▼
                                if (groupChar.mutedMembers && groupChar.mutedMembers[currentUser.id]) {
                                    delete groupChar.mutedMembers[currentUser.id];
                                }
                                // ▲▲▲ 新增结束 ▲▲▲

                                await db.characterProfiles.put(groupChar);
                                renderTransferList();
                                const { addSystemEventMessage } = await import('./chat-service.js');

                                await addSystemEventMessage(groupChar.id, `用户强制收回了群主身份`, 'info', false);
                                renderGroupChatSettings(groupChar); // 刷新面板
                                document.dispatchEvent(new CustomEvent('group_owner_updated', { detail: { chatId: groupChar.id } })); // 通知气泡变色
                            }
                        };

                    }
                    dropdownBox.appendChild(topRow);

                    if (members.length === 0) {
                        dropdownBox.insertAdjacentHTML('beforeend', '<div style="padding: 15px; text-align: center; color: #999; font-size: 13px;">群内暂无其他成员</div>');
                        return;
                    }

                    members.forEach(m => {
                        const isThisOwner = isSameCharacterId(currentOwnerId, m.id);

                        const row = document.createElement('div');
                        row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #f0f0f0;';
                        row.innerHTML = `
                            <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
                                <img src="${isValidAvatarSrc(m.avatar) ? m.avatar : DEFAULT_AVATAR_SRC}" style="width: 36px; height: 36px; border-radius: 50%; object-fit: cover; border: 1px solid #e5e5e5;">
                                <div style="display: flex; flex-direction: column;">
                                    <div style="display: flex; align-items: center;">
                                        <span style="font-size: 14px; font-weight: 600; color: #111;">${escapeHTML(m.name)}</span>
                                                                              ${isThisOwner ? '<span style="background:#111; color:#fff; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:600; margin-left:6px;">群主</span>' : ''}

                                        </div>
                                </div>
                            </div>
                            <div style="display: flex; gap: 8px;">
                                ${isThisOwner 
                                    ? `` 
                                    : `<button class="btn-transfer" style="background: ${isUserOwner ? '#111' : '#f5f5f5'}; color: ${isUserOwner ? '#fff' : '#bbb'}; border: none; padding: 6px 14px; border-radius: 16px; font-size: 12px; cursor: ${isUserOwner ? 'pointer' : 'not-allowed'}; font-weight: 600;">转交</button>`}
                            </div>
                        `;

                        if (!isThisOwner && isUserOwner) {
                            row.querySelector('.btn-transfer').onclick = async (e) => {
                                e.stopPropagation();
                                if (confirm(`确定要将群主转让给【${m.name}】吗？\n转让后TA将拥有群聊的最高权限，除非你强制收回。`)) {
                                    groupChar.ownerId = m.id;
                                    await db.characterProfiles.put(groupChar);
                                    renderTransferList();
                                    const { addSystemEventMessage } = await import('./chat-service.js');
                                    await addSystemEventMessage(groupChar.id, `用户将群主身份转交给了 ${m.name}`, 'info', false);
                                          renderGroupChatSettings(groupChar); // 刷新面板
                            document.dispatchEvent(new CustomEvent('group_owner_updated', { detail: { chatId: groupChar.id } })); // 通知气泡变色
                        }
                    };
                }
                dropdownBox.appendChild(row);
            });
        };
        item.onclick = (e) => {
            e.stopPropagation();
            if (dropdownBox.style.display === 'none') {
                renderTransferList(); 
                dropdownBox.style.display = 'flex';
                if (arrow) arrow.style.transform = 'rotate(90deg)';
            } else {
                dropdownBox.style.display = 'none';
                if (arrow) arrow.style.transform = 'rotate(0deg)';
            }
        };
    }
    // ▼▼▼ 新增：为群成员单独配置世界书下拉面板 ▼▼▼
    else if (text === '为群成员单独配置世界书') {
        const arrow = item.querySelector('.settings-arrow');
        if (arrow) arrow.style.transition = 'transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)';
        
        item.style.borderBottom = 'none'; 
        item.style.cursor = 'pointer';
        let dropdownBox = item.parentElement.querySelector('#member-wb-dropdown-box');
        if (!dropdownBox) {
            dropdownBox = document.createElement('div');
            dropdownBox.id = 'member-wb-dropdown-box';
            dropdownBox.style.cssText = 'display: none; flex-direction: column; background: #fafafa; border-top: 1px solid #f2f2f2; padding: 4px 16px 12px; border-bottom: 1px solid #f2f2f2; margin-bottom: 10px;';
            item.insertAdjacentElement('afterend', dropdownBox);
        } else {
            dropdownBox.style.display = 'none';
            if (arrow) arrow.style.transform = 'rotate(0deg)';
        }
        const renderWbDropdownList = () => {
            dropdownBox.innerHTML = '';
            
            // 【修正】：只获取群里的 AI 角色成员，彻底剔除用户自己
            const members = (groupChar.memberIds || []).map(findCharacterById).filter(Boolean);

            if (!groupChar.memberMountedWBIds) groupChar.memberMountedWBIds = {};

            if (members.length === 0) {
                dropdownBox.innerHTML = '<div style="padding: 15px; text-align: center; color: #999; font-size: 13px;">群内暂无成员</div>';
                return;
            }
            members.forEach(m => {
                const currentWbCount = (groupChar.memberMountedWBIds[m.id] || []).length;
                const row = document.createElement('div');
                row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid #f0f0f0;';
                
                const wbBadge = currentWbCount > 0
                    ? `<span style="font-size: 11px; color: #111; background: #eee; padding: 2px 8px; border-radius: 4px; font-weight: bold; margin-top: 5px; display: inline-block;">已配置 ${currentWbCount} 条</span>` 
                    : `<span style="font-size: 11px; color: #bbb; margin-top: 5px; font-weight: normal;">未配置</span>`;
                row.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 12px; overflow: hidden; flex: 1;">
                        <img src="${isValidAvatarSrc(m.avatar) ? m.avatar : DEFAULT_AVATAR_SRC}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 1px solid #e5e5e5; flex-shrink: 0;">
                        <div style="display: flex; flex-direction: column; overflow: hidden; align-items: flex-start;">
                           <!-- 修改后 -->
<span style="font-size: 15px; font-weight: 600; color: #111; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;">${escapeHTML(m.name)}</span>

                            ${wbBadge}
                        </div>
                    </div>
                    <div style="display: flex; gap: 8px; flex-shrink: 0;">
                        ${currentWbCount > 0 ? `<button class="btn-clear-wb" style="background: #f5f5f5; color: #666; border: 1px solid #e0e0e0; padding: 6px 14px; border-radius: 16px; font-size: 12px; cursor: pointer; font-weight: 600;">清除</button>` : ''}
                        <button class="btn-set-wb" style="background: #111; color: #fff; border: none; padding: 7px 15px; border-radius: 16px; font-size: 12px; cursor: pointer; font-weight: 600; box-shadow: 0 2px 6px rgba(0,0,0,0.15);">设置</button>
                    </div>
                `;
                const setBtn = row.querySelector('.btn-set-wb');
                if (setBtn) {
                    setBtn.onclick = (e) => {
                        e.stopPropagation();
                        openMemberWbSelector(groupChar, m, renderWbDropdownList);
                    };
                }
                const clearBtn = row.querySelector('.btn-clear-wb');
                if (clearBtn) {
                    clearBtn.onclick = async (e) => {
                        e.stopPropagation();
                        if (confirm(`确定要清空【${m.name}】的群内专属世界书吗？`)) {
                            delete groupChar.memberMountedWBIds[m.id];
                            await db.characterProfiles.put(groupChar);
                            renderWbDropdownList(); 
                            if(typeof showDynamicIsland === 'function') showDynamicIsland('已清空专属世界书', 'success');
                        }
                    };
                }
                dropdownBox.appendChild(row);
            });
        };
        item.onclick = (e) => {
            e.stopPropagation();
            if (dropdownBox.style.display === 'none') {
                renderWbDropdownList(); 
                dropdownBox.style.display = 'flex';
                if (arrow) arrow.style.transform = 'rotate(90deg)';
            } else {
                dropdownBox.style.display = 'none';
                if (arrow) arrow.style.transform = 'rotate(0deg)';
            }
        };
    }
    // ▲▲▲ 新增结束 ▲▲▲
        }
    });



    // 取消之前不精确的整个卡片点击，防止冲突

    const infoBtnEl = document.getElementById('group-settings-info-btn');
    if (infoBtnEl) {
        infoBtnEl.onclick = null;
        infoBtnEl.style.cursor = 'default';
    }
    // ▲▲▲ 独立逻辑替换结束 ▲▲▲
    // 2. 渲染当前用户在群里的身份
    const userIdentityId = groupChar.chatIdentityId || AppState.currentIdentityId;
    const currentUser = AppState.userIdentities.find(id => id.id === userIdentityId) || AppState.userIdentities[0];
    
    const userAvatarEl = document.getElementById('group-settings-user-avatar');
    const userNameEl = document.getElementById('group-settings-user-name');
    
    if (currentUser) {
        if (userAvatarEl) userAvatarEl.src = isValidAvatarSrc(currentUser.avatar) ? currentUser.avatar : DEFAULT_AVATAR_SRC;
        if (userNameEl) userNameEl.textContent = escapeHTML(currentUser.name);
    }

    // ▼▼▼ 新增：绑定群聊身份切换弹窗 ▼▼▼
    // 获取群聊专属的那个外层点击卡片
    const identityCardEl = document.getElementById('group-settings-user-identity'); 
    if (identityCardEl) {
        identityCardEl.style.cursor = 'pointer';
        identityCardEl.onclick = () => {
            // 直接复用在 chat-settings.js 里写好的弹窗显示逻辑
            const modalOverlay = document.getElementById('chat-identity-switcher-overlay');
            const confirmBtn = document.getElementById('identity-switcher-confirm-btn');
            
            if (modalOverlay) {
                // 因为 chat-settings.js 里写的是一个内部闭包，我们可以用一种“取巧”的兼容方式
                // 模拟点击单聊的那个隐藏按钮，从而完美调起原生弹窗，零侵入！
                const fakeTriggerBtn = document.getElementById('chat-settings-user-identity');
                if (fakeTriggerBtn) {
                    fakeTriggerBtn.click(); // 调起弹窗
                    
                    // 覆盖确认按钮的行为，让它不仅更新身份，还能刷新群聊界面
                    const oldOnClick = confirmBtn.onclick;
                    confirmBtn.onclick = async (e) => {
                        // 等待原来的保存逻辑走完
                        if (oldOnClick) await oldOnClick(e);
                        // 强制重新渲染群聊界面，更新这边的头像
                        setTimeout(() => {
                            const updatedChar = findCharacterById(groupChar.id);
                            if (updatedChar) renderGroupChatSettings(updatedChar);
                        }, 100);
                    };
                }
            }
        };
    }
    // ▲▲▲ 新增结束 ▲▲▲

    // 3. 开关状态
    const pinToggle = document.getElementById('group-settings-pin-toggle');
    if (pinToggle) pinToggle.checked = groupChar.isPinned || false;
    // 4. 动态生成网格头像区
    renderGroupMembersGrid(groupChar, currentUser);
        // ▼▼▼ 新增：设置管理员渲染与点击逻辑 ▼▼▼
    const adminsBtn = document.getElementById('group-settings-admins-btn');
    const adminsValue = document.getElementById('group-settings-admins-value');
    if (adminsBtn && adminsValue) {
        const adminIds = groupChar.adminIds || [];
        const adminChars = adminIds.map(id => findGroupParticipantById(groupChar, id)).filter(Boolean);
        
        const arrow = adminsValue.querySelector('.settings-arrow');
        adminsValue.innerHTML = '';
         const avatarContainer = document.createElement('div');
        // gap: 6px 让大一点的头像之间不那么拥挤
        avatarContainer.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-right: 8px;';
        
        adminChars.forEach(admin => {
            const img = document.createElement('img');
            img.src = isValidAvatarSrc(admin.avatar) ? admin.avatar : DEFAULT_AVATAR_SRC;
            // 将宽高从 24px 放大到了 28px
            img.style.cssText = 'width: 28px; height: 28px; border-radius: 50%; object-fit: cover; border: 1px solid #eee;';
            avatarContainer.appendChild(img);
        });

        // 新增：右侧的圆形加号按钮
        const addIcon = document.createElement('div');
        addIcon.style.cssText = 'width: 28px; height: 28px; border-radius: 50%; border: 1px dashed #ccc; display: flex; align-items: center; justify-content: center; color: #999; flex-shrink: 0;';
        addIcon.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
        avatarContainer.appendChild(addIcon);
        adminsValue.appendChild(avatarContainer);
        if (arrow) adminsValue.appendChild(arrow);
        adminsBtn.style.cursor = 'pointer';
        adminsBtn.onclick = (e) => {
            e.stopPropagation();
            const currentOwnerId = groupChar.ownerId || currentUser.id;
            if (!isSameCharacterId(currentOwnerId, currentUser.id)) {
                if(typeof showDynamicIsland === 'function') showDynamicIsland('只有群主才能设置管理员', 'warning');
                return;
            }
            showGroupAdminManager(groupChar, currentUser);
        };
    }

       // ▼▼▼ 新增：设置等级头衔点击逻辑 ▼▼▼
    const levelsBtn = document.getElementById('group-settings-levels-btn');
    const levelsValue = document.getElementById('group-settings-levels-value');
    if (levelsBtn && levelsValue) {
        const span = levelsValue.querySelector('span');
        if (span) {
            // 检查数据库里是否存了头衔数据，如果有说明“已设置”
            const hasSet = groupChar.levelTitles && Object.keys(groupChar.levelTitles).length > 0;
            span.textContent = hasSet ? '已设置' : '未设置';
            span.style.color = hasSet ? '#111' : '#999';
            span.style.marginRight = '4px';
        }
        levelsBtn.style.cursor = 'pointer';
        levelsBtn.onclick = (e) => {
            e.stopPropagation();
            showGroupLevelTitlesManager(groupChar);
        };
    }
    // ▲▲▲ 新增结束 ▲▲▲


    updateAdvancedGroupSettingsUI(groupChar); // ◀◀◀ 新增：刷新进阶设置面板里的文字和开关
}


function renderGroupMembersGrid(groupChar, currentUser) {
    const membersArea = document.getElementById('group-settings-members-area');
    const countEl = document.getElementById('group-member-count');
    if (!membersArea) return;

    membersArea.innerHTML = '';
    const fragment = document.createDocumentFragment();

    // 取出群内所有成员对象 (包括我自己)
    const members = getGroupParticipants(groupChar);
    
    if (countEl) countEl.textContent = (members.length + 1) + '人 >'; // +1 是包含用户

    // -- 卡片构造模板 --
    const createMemberIcon = (src, name, isUser = false) => {
        const item = document.createElement('div');
        item.style.cssText = 'display: flex; flex-direction: column; align-items: center; text-align: center; overflow: hidden;';
        
        // 增加一点点细边框和底色，更显质感
        item.innerHTML = `
            <img src="${src}" style="width: 48px; height: 48px; border-radius: 12px; object-fit: cover; margin-bottom: 4px; border: 1px solid #f0f0f0;">
            <span style="font-size: 11px; color: ${isUser ? '#000' : '#888'}; font-weight: ${isUser ? '600' : 'normal'}; width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(name)}</span>
        `;
        return item;
    };

    // 1. 添加自己
    fragment.appendChild(createMemberIcon(
        isValidAvatarSrc(currentUser.avatar) ? currentUser.avatar : DEFAULT_AVATAR_SRC, 
        currentUser.name, 
        true
    ));

    // 2. 添加所有成员
    members.forEach(m => {
        fragment.appendChild(createMemberIcon(
            isValidAvatarSrc(m.avatar) ? m.avatar : DEFAULT_AVATAR_SRC, 
            m.name
        ));
    });
    // 3. 添加 "+" 邀请按钮 (空心虚线框风格)
    const addBtn = document.createElement('div');
    addBtn.style.cssText = 'display: flex; flex-direction: column; align-items: center; text-align: center; cursor: pointer;';
    addBtn.innerHTML = `
        <div style="width: 48px; height: 48px; border-radius: 12px; border: 1px dashed #ccc; display: flex; align-items: center; justify-content: center; margin-bottom: 4px;">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#999" stroke-width="1.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        </div>
        <span style="font-size: 11px; color: #999;">邀请</span>
    `;
    // ▼ 替换为新的弹窗逻辑
    addBtn.onclick = () => showGroupMemberManager('invite', groupChar, currentUser);
    fragment.appendChild(addBtn);

    // 4. 添加 "-" 踢人按钮
    const removeBtn = document.createElement('div');
    removeBtn.style.cssText = 'display: flex; flex-direction: column; align-items: center; text-align: center; cursor: pointer;';
    removeBtn.innerHTML = `
        <div style="width: 48px; height: 48px; border-radius: 12px; border: 1px dashed #ccc; display: flex; align-items: center; justify-content: center; margin-bottom: 4px;">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#999" stroke-width="1.5"><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        </div>
        <span style="font-size: 11px; color: #999;">移除</span>
    `;
    // ▼ 替换为新的弹窗逻辑
    removeBtn.onclick = () => showGroupMemberManager('remove', groupChar, currentUser);
    fragment.appendChild(removeBtn);

    membersArea.appendChild(fragment);
}

// ▼▼▼ 新增：群成员管理（拉人/踢人）独立弹窗引擎 ▼▼▼
function showGroupMemberManager(action, groupChar, currentUser) {
    const isInvite = action === 'invite';
    
    let candidates = [];
    if (isInvite) {
        // 邀请：查找所有不在当前群里、且本身不是群聊的单人角色
        candidates = AppState.characterProfiles.filter(c => !c.isGroup && c.inContacts !== false && isCharacterFriend(c) && !hasCharacterId(groupChar.memberIds, c.id));
    } else {
        // 踢人：只显示当前已经在群里的成员
        candidates = getGroupParticipants(groupChar);
    }

    if (candidates.length === 0) {
        showDynamicIsland(isInvite ? '通讯录已无角色可邀请' : '群内没有可移除的成员', 'warning');
        return;
    }

    // 1. 动态创建黑色半透明背景遮罩
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.4); z-index:9999; display:flex; align-items:flex-end; opacity:0; transition:opacity 0.25s;';
    
    // 2. 创建底部白色滑动面板
    const panel = document.createElement('div');
    panel.style.cssText = 'width:100%; background:#fff; border-radius:20px 20px 0 0; padding:20px; padding-bottom:max(20px, env(safe-area-inset-bottom)); max-height:70vh; overflow-y:auto; transform:translateY(100%); transition:transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1); box-sizing:border-box;';
    
    // 3. 绘制标题栏
    const header = document.createElement('div');
    header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; font-weight:bold; font-size:16px;';
    header.innerHTML = `<span>${isInvite ? '邀请角色进群' : '移除群成员'}</span><span style="color:#999; cursor:pointer; font-weight:normal;" id="close-mgr-btn">取消</span>`;
    panel.appendChild(header);

    // 4. 渲染可操作的列表
    const list = document.createElement('div');
    candidates.forEach(c => {
        const item = document.createElement('div');
        item.style.cssText = 'display:flex; align-items:center; padding:12px 0; border-bottom:1px solid #f9f9f9; cursor:pointer;';
        item.innerHTML = `
            <img src="${isValidAvatarSrc(c.avatar) ? c.avatar : DEFAULT_AVATAR_SRC}" style="width:40px; height:40px; border-radius:50%; object-fit:cover; margin-right:12px; border:1px solid #eee;">
            <span style="flex:1; font-size:15px; color:#111; font-weight:500;">${escapeHTML(c.name)}</span>
            <button style="padding:6px 14px; border:none; border-radius:16px; font-size:12px; color:#fff; background:${isInvite ? '#111' : '#ff3b30'}; font-weight:bold; cursor:pointer;">${isInvite ? '邀请' : '移除'}</button>
        `;
        
        // 点击列表触发核心操作
        item.onclick = async () => {
            // 更新内存数据
            if (isInvite) {
                if (!groupChar.memberIds) groupChar.memberIds = [];
                if (!hasCharacterId(groupChar.memberIds, c.id)) groupChar.memberIds.push(c.id);
            } else {
                removeGroupParticipant(groupChar, c);
            }
            
            // 写入数据库
            await db.characterProfiles.put(groupChar);
            showDynamicIsland(isInvite ? `已邀请 ${c.name}` : `已移除 ${c.name}`, 'success');
            
            // 静默更新侧边栏和通讯录，确保群成员数据同步，但不重复初始化好友模块
            const { refreshCharacterLists } = await import('./character.js');
            refreshCharacterLists();

            // 丝滑退场：先关闭弹窗，然后再刷新群聊的网格区
            overlay.style.opacity = '0';
            panel.style.transform = 'translateY(100%)';
            setTimeout(() => {
                overlay.remove();
                renderGroupMembersGrid(groupChar, currentUser);
            }, 250);
        };
        list.appendChild(item);
    });
    
    // 装载并插入页面
    panel.appendChild(list);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // 5. 触发进入动画
    setTimeout(() => {
        overlay.style.opacity = '1';
        panel.style.transform = 'translateY(0)';
    }, 10);

    // 6. 点击灰色空白处关闭弹窗
    const closePanel = () => {
        overlay.style.opacity = '0';
        panel.style.transform = 'translateY(100%)';
        setTimeout(() => overlay.remove(), 250);
    };
    header.querySelector('#close-mgr-btn').onclick = closePanel;
    overlay.onclick = (e) => { if (e.target === overlay) closePanel(); };
}
// ▲▲▲ 新增结束 ▲▲▲
// ▼▼▼ 新增：管理员管理弹窗引擎 ▼▼▼
function showGroupAdminManager(groupChar, currentUser) {
    const overlay = document.getElementById('group-admin-modal-overlay');
    const listContainer = document.getElementById('group-admin-list');
    const countSpan = document.getElementById('group-admin-count');
    const closeBtn = document.getElementById('close-group-admin-btn');
    const saveBtn = document.getElementById('save-group-admin-btn');
    
    if (!overlay || !listContainer) return;

    // 获取当前群内的所有成员
    const members = getGroupParticipants(groupChar);
    
    if (members.length === 0) {
        showDynamicIsland('群内没有其他成员可设置为管理员', 'warning');
        return;
    }

    // 复制一份当前的管理员数据用于暂时操作
    let selectedAdmins = [...(groupChar.adminIds || [])];

    const renderList = () => {
        listContainer.innerHTML = '';
        members.forEach(m => {
            const isSelected = hasCharacterId(selectedAdmins, m.id);
            const item = document.createElement('div');
            item.style.cssText = 'display:flex; align-items:center; padding:10px; border-radius:12px; border:1px solid ' + (isSelected ? '#111' : '#eee') + '; background:' + (isSelected ? '#fafafa' : '#fff') + '; cursor:pointer; transition:all 0.2s;';
            
            // 手写一个精简的复选框
            const checkbox = document.createElement('div');
            checkbox.style.cssText = 'width:18px; height:18px; border-radius:50%; border:2px solid ' + (isSelected ? '#111' : '#ccc') + '; margin-right:12px; display:flex; align-items:center; justify-content:center; background:' + (isSelected ? '#111' : 'transparent') + ';';
            if (isSelected) {
                checkbox.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
            }

            item.innerHTML = `
                <img src="${isValidAvatarSrc(m.avatar) ? m.avatar : DEFAULT_AVATAR_SRC}" style="width:36px; height:36px; border-radius:50%; object-fit:cover; margin-right:10px; border:1px solid #eee;">
                <span style="flex:1; font-size:14px; color:#111; font-weight:500;">${escapeHTML(m.name)}</span>
            `;
            item.insertBefore(checkbox, item.firstChild);

            item.onclick = () => {
                if (isSelected) {
                    selectedAdmins = selectedAdmins.filter(id => !isSameCharacterId(id, m.id));
                } else {
                    if (selectedAdmins.length >= 3) {
                        showDynamicIsland('最多只能设置 3 个管理员', 'warning');
                        return;
                    }
                    selectedAdmins.push(m.id);
                }
                renderList();
            };
            listContainer.appendChild(item);
        });
        countSpan.textContent = selectedAdmins.length;
    };

    renderList();

    // 显示弹窗
    overlay.style.display = 'flex';
    setTimeout(() => overlay.style.opacity = '1', 10);

    const closeModal = () => {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.style.display = 'none', 300);
    };

    closeBtn.onclick = closeModal;
    overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
    // 保存按钮
    saveBtn.onclick = async () => {
        // ▼▼▼ 【新增】获取这次操作前后的管理员名单，用来判断到底是谁被上任/撤职了 ▼▼▼
        const oldAdminIds = groupChar.adminIds || [];
        const newAdminIds = selectedAdmins;
        
        const addedIds = newAdminIds.filter(id => !hasCharacterId(oldAdminIds, id));
        const removedIds = oldAdminIds.filter(id => !hasCharacterId(newAdminIds, id));
        
        const addedNames = addedIds.map(id => findGroupParticipantById(groupChar, id)?.name).filter(Boolean);
        const removedNames = removedIds.map(id => findGroupParticipantById(groupChar, id)?.name).filter(Boolean);
        
        let systemPromptMsg = "";
        if (addedNames.length > 0) systemPromptMsg += `用户刚刚将【${addedNames.join('、')}】设置为了本群管理员。`;
        if (removedNames.length > 0) systemPromptMsg += `用户刚刚取消了【${removedNames.join('、')}】的本群管理员身份。`;
        // ▲▲▲ 新增结束 ▲▲▲

        groupChar.adminIds = selectedAdmins;
        await db.characterProfiles.put(groupChar);
        showDynamicIsland('管理员设置已保存', 'success');
        closeModal();
        renderGroupChatSettings(groupChar); // 直接局部刷新当前页面

        // ▼▼▼ 【新增】偷偷告诉群里的AI发生了人事变动 ▼▼▼
        if (systemPromptMsg) {
            const { addSystemEventMessage } = await import('./chat-service.js');
            await addSystemEventMessage(groupChar.id, `[系统隐式提示：${systemPromptMsg}]`, 'info', true);
        }
        // ▲▲▲ 新增结束 ▲▲▲
    };
}
// ▼▼▼ 新增：等级头衔管理弹窗引擎 ▼▼▼

function showGroupLevelTitlesManager(groupChar) {
    const overlay = document.getElementById('group-levels-modal-overlay');
    const closeBtn = document.getElementById('close-group-levels-btn');
    const saveBtn = document.getElementById('save-group-levels-btn');
    
    if (!overlay) return;

    // 回显已有的头衔设置（读取数据库中的配置，如果没有就为空）
    const titles = groupChar.levelTitles || {};
    document.getElementById('level-title-1').value = titles['1-10'] || '(๑•ᴗ•๑)';
    document.getElementById('level-title-2').value = titles['11-20'] || '( ੭ ˙ᗜ˙ )੭';
    document.getElementById('level-title-3').value = titles['21-40'] || '(๑•̀ㅂ•́)و✧';
    document.getElementById('level-title-4').value = titles['41-60'] || '(˶‾᷄ ⁻̫ ‾᷅˵)';
    document.getElementById('level-title-5').value = titles['61-80'] || '(๑✧◡✧๑)';
    document.getElementById('level-title-6').value = titles['81-100'] || '(👑´>∀<)ﾉ';

    // 显示弹窗
    overlay.style.display = 'flex';
    setTimeout(() => overlay.style.opacity = '1', 10);

    const closeModal = () => {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.style.display = 'none', 300);
    };

    closeBtn.onclick = closeModal;
    overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };

    // 保存设置，存入 groupChar 的 levelTitles 对象中
    saveBtn.onclick = async () => {
        groupChar.levelTitles = {
            '1-10': document.getElementById('level-title-1').value.trim(),
            '11-20': document.getElementById('level-title-2').value.trim(),
            '21-40': document.getElementById('level-title-3').value.trim(),
            '41-60': document.getElementById('level-title-4').value.trim(),
            '61-80': document.getElementById('level-title-5').value.trim(),
            '81-100': document.getElementById('level-title-6').value.trim()
        };
        // 删除空值以防填了又删产生冗余数据
        Object.keys(groupChar.levelTitles).forEach(k => {
            if (!groupChar.levelTitles[k]) delete groupChar.levelTitles[k];
        });

        await db.characterProfiles.put(groupChar);
        await db.characterProfiles.put(groupChar);
        showDynamicIsland('等级头衔配置已保存', 'success');
        closeModal();
        renderGroupChatSettings(groupChar); // 重新渲染页面，使文字变成“已设置”
    };
}
// ▲▲▲ 新增结束 ▲▲▲


function bindGroupSettingsEvents() {
    const pinToggle = document.getElementById('group-settings-pin-toggle');
    const quitBtn = document.getElementById('group-settings-quit-btn');

    // 置顶开关
    if (pinToggle) {
        pinToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            if (!charId) return;
            const char = findCharacterById(charId);
            if (char) {
                char.isPinned = pinToggle.checked;
                await optimizedSaveAndRender();
                showDynamicIsland(char.isPinned ? '群聊已置顶' : '已取消置顶');
            }
        });
    }
    // 清空聊天记录 (复用单聊的清理弹窗)
    if (quitBtn) {
        quitBtn.addEventListener('click', () => {
            // 直接触发单聊已经写好的“清空记录分类弹窗”，完美复用且安全！
            const targetBtn = document.getElementById('chat-settings-delete-history-btn');
            if (targetBtn) targetBtn.click();
        });
    }

}
/* ==============================================================
   以下为群聊专属新增代理逻辑，用以无缝对接单聊所有的丰富设置项
   ============================================================== */

function updateAdvancedGroupSettingsUI(groupChar) {
    const groupPromptSelect = document.getElementById('gc-light-prompt');
    if (groupPromptSelect) {
        const promptVersion = groupChar.useLightPrompt === 'ivory' ? 'ivory' : (groupChar.useLightPrompt === 'minimal' ? 'minimal' : 'false');
        groupPromptSelect.value = promptVersion;
    }
    if (document.getElementById('gc-sticker-match-toggle')) {
        document.getElementById('gc-sticker-match-toggle').checked = groupChar.stickerMatchEnabled ?? false;
    }
    if (document.getElementById('gc-offline-invite')) document.getElementById('gc-offline-invite').checked = groupChar.allowOfflineInvite ?? true;
    if (document.getElementById('gc-allow-private-chat')) {
        document.getElementById('gc-allow-private-chat').checked = groupChar.allowGroupPrivateChat ?? true;
    }
    if (document.getElementById('gc-char-interaction-toggle')) {
        document.getElementById('gc-char-interaction-toggle').checked = groupChar.charInteractionCardEnabled !== false;
    }
    // ▼▼▼ 新增：读取群聊自动行程开关状态 ▼▼▼
    if (document.getElementById('gc-auto-ride-toggle')) {
        document.getElementById('gc-auto-ride-toggle').checked = groupChar.autoRideEnabled ?? false;
    }
    // ▲▲▲ 新增结束 ▲▲▲
       if (document.getElementById('gc-inherit-member-wb-toggle')) {
        document.getElementById('gc-inherit-member-wb-toggle').checked = groupChar.inheritMemberWorldBook ?? false;
    }
    const isAutoSummary = groupChar.autoSummaryEnabled !== false;

    if (document.getElementById('gc-auto-summary-toggle')) document.getElementById('gc-auto-summary-toggle').checked = isAutoSummary;
    if (document.getElementById('gc-auto-summary-details')) {
        if (isAutoSummary) document.getElementById('gc-auto-summary-details').setAttribute('open', '');
        else document.getElementById('gc-auto-summary-details').removeAttribute('open');
    }
    
    const autoTurns = groupChar.autoSummaryTurns || 20;
    if (document.getElementById('gc-auto-summary-slider')) document.getElementById('gc-auto-summary-slider').value = autoTurns;
    if (document.getElementById('gc-auto-summary-val')) document.getElementById('gc-auto-summary-val').textContent = autoTurns;
    
    if (document.getElementById('gc-context-turns-val')) document.getElementById('gc-context-turns-val').textContent = groupChar.contextTurns || 25;
    if (document.getElementById('gc-auto-translate-toggle')) {
        document.getElementById('gc-auto-translate-toggle').checked = groupChar.autoTranslateEnabled !== false;
    }
    if (document.getElementById('gc-translation-expanded-toggle')) {
        document.getElementById('gc-translation-expanded-toggle').checked = groupChar.translationDefaultExpanded !== false;
    }
    
    const momentsLimit = groupChar.momentsContextLimit || 0;
    const mCtxVal = document.getElementById('gc-moments-context-val');
    if (mCtxVal) {
        mCtxVal.textContent = momentsLimit === 0 ? '已关闭' : `${momentsLimit} 条`;
        mCtxVal.style.color = momentsLimit === 0 ? 'var(--c-text-tertiary)' : 'var(--c-text-primary)';
    }

    const wbStatus = document.getElementById('gc-mount-wb-val');
    if (wbStatus) {
        import('../state.js').then(({ getAllWorldBooksGrouped }) => {
            getAllWorldBooksGrouped().then(groupedData => {
                let validCount = 0;
                if (groupChar.mountedWBIds && groupChar.mountedWBIds.length > 0) {
                    const validIds = new Set();
                    for (const g in groupedData) {
                        groupedData[g].forEach(entry => validIds.add(entry.id));
                    }
                    validCount = groupChar.mountedWBIds.filter(id => validIds.has(id)).length;
                }
                wbStatus.textContent = validCount > 0 ? `已挂载 ${validCount} 条` : '未配置';
                wbStatus.className = validCount > 0 ? '' : 'subtle-text';
            });
        });
    }

    import('../state.js').then(({ themeState }) => {
        themeState.getAllSchemeSummaries().then(async allSchemes => {
            const apps = await themeState.getAllApplications();
            const getSchemeName = (type) => {
                const rule = getEffectiveThemeRuleForTarget(apps, allSchemes, type, groupChar.id)?.rule;
                if (rule) {
                    const s = allSchemes.find(sc => String(sc.id) === String(rule.schemeId));
                    if (s) return s.name;
                }
                return '默认';
            };
            const detailTxt = document.getElementById('gc-quick-detail-val');
            const bubbleTxt = document.getElementById('gc-quick-bubble-val');
            const offlineTxt = document.getElementById('gc-quick-offline-val');
            if (detailTxt) detailTxt.textContent = getSchemeName('detail');
            if (bubbleTxt) bubbleTxt.textContent = getSchemeName('bubble');
            if (offlineTxt) offlineTxt.textContent = getSchemeName('offline');
        });
    });
}

function bindAdvancedGroupSettingsEvents() {
    // 代理所有普通点击事件
    const clickMappings = {
        'gc-set-background-btn': 'set-chat-background-btn',
        'gc-video-bg-btn': 'chat-settings-video-bg-btn', 
        'gc-quick-detail': 'quick-beautify-detail-btn',
        'gc-quick-bubble': 'quick-beautify-bubble-btn',
        'gc-quick-offline': 'quick-beautify-offline-btn',
        'gc-sticker-packs': 'chat-settings-sticker-packs',
        'gc-mount-wb': 'mount-world-book-trigger',
        'gc-context-turns': 'context-settings-trigger',
        'gc-moments-context': 'moments-context-trigger',
        'gc-notification': 'chat-settings-notification-btn',
        'gc-time-settings': 'time-settings-trigger',
        'gc-import-export': 'chat-settings-import-export',
        'gc-partial-delete': 'chat-settings-partial-delete-btn',
        'gc-delete-history': 'chat-settings-delete-history-btn'
    };

    for (const [gcId, targetId] of Object.entries(clickMappings)) {
        const gcEl = document.getElementById(gcId);
        const targetEl = document.getElementById(targetId);
        if (gcEl && targetEl) {
             gcEl.addEventListener('click', (e) => {
                e.preventDefault();
                targetEl.click();
            });
        }
    }

    // ▼▼▼ 新增：群聊专属的手动总结与失败重试弹窗 ▼▼▼
    const gcManualBtn = document.getElementById('gc-manual-summary');
    if (gcManualBtn) {
        gcManualBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            const charId = tempState.currentChatId;
            if (!charId) return;
            const groupChar = findCharacterById(charId);
            if (!groupChar || !groupChar.isGroup) return;

            // 1. 拦截检查：是否有失败的总结记录？有的话弹出小窗口询问是否重试
            if (groupChar.failedSummaries && groupChar.failedSummaries.length > 0) {
                if (confirm('发现该群聊之前有后台总结失败的记录。是否立即重试？')) {
                    const failedRecord = groupChar.failedSummaries.pop(); // 取出并移除失败记录
                    await db.characterProfiles.put(groupChar);
                    showDynamicIsland('正在重试群聊总结...', 'loading');
                    // 调用你之前写好的群聊总结引擎
                    if (window.summarizeGroupMemory) window.summarizeGroupMemory(charId, failedRecord.retryData.conversationBuffer, failedRecord.retryData.userName);
                    return; // 重试完成直接退出，不执行普通的手动总结
                }
            }

            // 2. 正常的手动总结逻辑：复用单聊的手动总结弹窗，避免群聊另起一套没有来源/条数选择的流程
            const targetBtn = document.getElementById('chat-settings-manual-summary-btn');
            if (targetBtn) {
                targetBtn.click();
            } else {
                showDynamicIsland('找不到手动总结弹窗入口', 'error');
            }
        });
    }
    // ▲▲▲ 新增结束 ▲▲▲

    const groupPromptSelect = document.getElementById('gc-light-prompt');
    if (groupPromptSelect) {
        groupPromptSelect.addEventListener('change', async () => {
            const char = findCharacterById(tempState.currentChatId);
            if (!char || !char.isGroup) return;
            const promptVersion = groupPromptSelect.value === 'ivory' ? 'ivory' : (groupPromptSelect.value === 'minimal' ? 'minimal' : false);
            char.useLightPrompt = promptVersion;
            markPendingContextSwitch('online', char.id, 'preset');
            await optimizedSaveAndRender();
            let msg = '已切换为常规群聊预设';
            if (promptVersion === 'minimal') msg = '已切换为 mini 群聊预设（轻量）';
            if (promptVersion === 'ivory') msg = '已切换为让 char 不再淡人群聊预设';
            showDynamicIsland(msg);
        });
    }

    const gcStickerMatchToggle = document.getElementById('gc-sticker-match-toggle');
    if (gcStickerMatchToggle) {
        gcStickerMatchToggle.addEventListener('change', async () => {
            const char = findCharacterById(tempState.currentChatId);
            if (!char || !char.isGroup) return;
            char.stickerMatchEnabled = gcStickerMatchToggle.checked;
            await db.characterProfiles.put(char);
            window.__refreshChatStickerMatches?.();
            showDynamicIsland(char.stickerMatchEnabled ? '已开启输入时匹配表情包' : '已关闭输入时匹配表情包');
        });
    }

    // 代理同步所有的开关和滑块事件
    const syncMappings = [

        { gcId: 'gc-offline-invite', targetId: 'allow-offline-invite-toggle', evt: 'change' },
        { gcId: 'gc-auto-summary-toggle', targetId: 'chat-settings-auto-summary-toggle', evt: 'change' },
        { gcId: 'gc-auto-summary-slider', targetId: 'auto-summary-turns-slider', evt: 'change' }
    ];

    syncMappings.forEach(({gcId, targetId, evt}) => {
        const gcEl = document.getElementById(gcId);
        const targetEl = document.getElementById(targetId);
        if (gcEl && targetEl) {
            gcEl.addEventListener(evt, () => {
                if (gcEl.type === 'checkbox') {
                    targetEl.checked = gcEl.checked;
                } else {
                    targetEl.value = gcEl.value;
                }
                targetEl.dispatchEvent(new Event(evt));
            });
            // 处理滑动条拖拽时的实时数字反馈
            if (gcEl.type === 'range') {
                gcEl.addEventListener('input', () => {
                    targetEl.value = gcEl.value;
                    targetEl.dispatchEvent(new Event('input'));
                    document.getElementById('gc-auto-summary-val').textContent = gcEl.value;
                });
            }
        }
    });

    const gcAutoTranslateToggle = document.getElementById('gc-auto-translate-toggle');
    if (gcAutoTranslateToggle) {
        gcAutoTranslateToggle.addEventListener('change', async () => {
            const char = findCharacterById(tempState.currentChatId);
            if (char && char.isGroup) {
                char.autoTranslateEnabled = gcAutoTranslateToggle.checked;
                await db.characterProfiles.put(char);
                showDynamicIsland(char.autoTranslateEnabled ? '已开启自动翻译' : '已关闭自动翻译');
            }
        });
    }

    const gcTranslationExpandedToggle = document.getElementById('gc-translation-expanded-toggle');
    if (gcTranslationExpandedToggle) {
        gcTranslationExpandedToggle.addEventListener('change', async () => {
            const char = findCharacterById(tempState.currentChatId);
            if (char && char.isGroup) {
                char.translationDefaultExpanded = gcTranslationExpandedToggle.checked;
                await db.characterProfiles.put(char);
                showDynamicIsland(char.translationDefaultExpanded ? '翻译默认已展开' : '翻译默认已关闭');
            }
        });
    }

    // ▼▼▼ 新增：允许发起私聊开关事件绑定 ▼▼▼
    const privateChatToggle = document.getElementById('gc-allow-private-chat');
    if (privateChatToggle) {
        privateChatToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = findCharacterById(charId);
            if (char) {
                char.allowGroupPrivateChat = privateChatToggle.checked;
                await db.characterProfiles.put(char);
                if (typeof showDynamicIsland === 'function') {
                    showDynamicIsland(char.allowGroupPrivateChat ? '已允许角色发起私聊' : '已禁止角色发起私聊');
                }
            }
        });
    }

    const charInteractionToggle = document.getElementById('gc-char-interaction-toggle');
    if (charInteractionToggle) {
        charInteractionToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = findCharacterById(charId);
            if (char && char.isGroup) {
                char.charInteractionCardEnabled = charInteractionToggle.checked;
                await db.characterProfiles.put(char);
                if (typeof showDynamicIsland === 'function') {
                    showDynamicIsland(char.charInteractionCardEnabled ? '已启用角色互动卡片' : '已关闭角色互动卡片');
                }
            }
        });
    }

    // ▼▼▼ 新增：监听群聊自动行程开关变化 ▼▼▼
    const gcAutoRideToggle = document.getElementById('gc-auto-ride-toggle');
    if (gcAutoRideToggle) {
        gcAutoRideToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = findCharacterById(charId);
            if (char) {
                char.autoRideEnabled = gcAutoRideToggle.checked;
                // 强制同步开启时间感知
                if (gcAutoRideToggle.checked) {
                    if (!char.timeSettings) char.timeSettings = {};
                    char.timeSettings.perceptionEnabled = true;
                }
                await db.characterProfiles.put(char); // 保存到数据库
                if (typeof showDynamicIsland === 'function') {
                    showDynamicIsland(char.autoRideEnabled ? '已启用角色行程 (时间感知已同步)' : '已关闭角色行程');
                }
            }
        });
    }
    // ▲▲▲ 新增结束 ▲▲▲

       // ▼▼▼ 新增：监听继承单聊世界书开关变化 ▼▼▼
    const inheritWbToggle = document.getElementById('gc-inherit-member-wb-toggle');
    if (inheritWbToggle) {
        inheritWbToggle.addEventListener('change', async () => {
            const charId = tempState.currentChatId;
            const char = findCharacterById(charId);
            if (char) {
                char.inheritMemberWorldBook = inheritWbToggle.checked;
                await db.characterProfiles.put(char);
                if (typeof showDynamicIsland === 'function') {
                    showDynamicIsland(char.inheritMemberWorldBook ? '已同步成员单聊世界书' : '已关闭成员单聊世界书');
                }
            }
        });
    }
    // 监控任何保存动作或关闭弹窗后，自动刷新群聊列表上显示的值
    document.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.classList.contains('modal-overlay')) {
            const char = findCharacterById(tempState.currentChatId);
            if (char && char.isGroup && document.getElementById('page-group-chat-settings').style.display === 'block') {
                setTimeout(() => updateAdvancedGroupSettingsUI(char), 250);
            }
        }
    });
}
// ▼▼▼ 新增：群公告编辑弹窗引擎 ▼▼▼
function openAnnouncementModal(groupChar, editingAnn, refreshCallback) {
    const overlay = document.getElementById('group-announcement-modal-overlay');
    const inputEl = document.getElementById('group-announcement-input');
    const pinToggle = document.getElementById('group-announcement-pin-toggle');
    const saveBtn = document.getElementById('save-announcement-btn');
    const closeBtn = document.getElementById('close-announcement-modal-btn');

    if (!overlay || !inputEl || !saveBtn || !closeBtn) return;

    // 回显数据
    inputEl.value = editingAnn ? editingAnn.text : '';
    pinToggle.checked = editingAnn ? editingAnn.isPinned : false;

    // 显示动画
    overlay.style.display = 'flex';
    setTimeout(() => overlay.style.opacity = '1', 10);

    const closeModal = () => {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.style.display = 'none', 300);
    };

    closeBtn.onclick = closeModal;
    overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };

    // 保存逻辑
    saveBtn.onclick = async () => {
        const text = inputEl.value.trim();
        if (!text) {
            showDynamicIsland('公告内容不能为空', 'warning');
            return;
        }

        let anns = groupChar.announcements || [];
        
        // 只要当前勾选了置顶，就取消掉原本库里所有的置顶，确保永远只有1个
        if (pinToggle.checked) {
            anns.forEach(a => a.isPinned = false);
        }

        if (editingAnn) {
            // 修改模式
            const idx = anns.findIndex(a => a.id === editingAnn.id);
            if (idx !== -1) {
                anns[idx].text = text;
                anns[idx].isPinned = pinToggle.checked;
            }
        } else {
            // 新增模式
            anns.unshift({
                id: Date.now(),
                text: text,
                isPinned: pinToggle.checked,
                timestamp: Date.now()
            });
        }

        groupChar.announcements = anns;
        
        // 兼容原有的单个文本段，方便其他地方读取
        const pinnedAnn = anns.find(a => a.isPinned) || anns[0];
        groupChar.announcement = pinnedAnn ? pinnedAnn.text : '';

        // 存入数据库
        await db.characterProfiles.put(groupChar);
        closeModal();
        
        // 调用回调刷新当前页面列表
        if (typeof refreshCallback === 'function') refreshCallback();
        
        showDynamicIsland('群公告已保存', 'success');

        // 发送给大模型当系统提示
        const { addSystemEventMessage } = await import('./chat-service.js');
        await addSystemEventMessage(groupChar.id, `[系统提示：@所有人 刚刚更新了群公告]\n${text}`, 'info', true);
    };
}
// ▲▲▲ 新增结束 ▲▲▲
// ▼▼▼ 新增：为群成员单独配置世界书的选择弹窗 ▼▼▼
async function openMemberWbSelector(groupChar, member, renderCallback) {
    const { getAllWorldBooksGrouped } = await import('../state.js');
    const groupedData = await getAllWorldBooksGrouped();
    
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'z-index: 10020; display: flex; opacity: 0; transition: opacity 0.3s ease; position: fixed; inset: 0; width: 100vw; height: 100dvh; min-height: 100dvh; align-items: center; justify-content: center; box-sizing: border-box; overflow: hidden; touch-action: none; overscroll-behavior: contain; padding: max(20px, env(safe-area-inset-top)) 0 max(20px, env(safe-area-inset-bottom)) 0;';
    
    let currentMounted = groupChar.memberMountedWBIds ? (groupChar.memberMountedWBIds[member.id] || []) : [];
    
    let listHtml = '';
    for (const groupName in groupedData) {
        listHtml += `
        <details class="mount-wb-group" open style="margin-bottom: 10px;">
            <summary class="mount-wb-group-title" style="padding: 10px; background: #f0f0f0; border-radius: 8px; cursor: pointer; font-weight: bold; outline: none;">
                <span>${escapeHTML(groupName)}</span>
            </summary>
            <div class="mount-wb-items" style="padding: 10px;">
        `;
        groupedData[groupName].forEach(wb => {
            const isChecked = currentMounted.includes(wb.id) ? 'checked' : '';
            listHtml += `
                <label style="display: flex; align-items: center; padding: 8px 0; cursor: pointer;">
                    <input type="checkbox" value="${wb.id}" class="member-wb-checkbox" ${isChecked} style="margin-right: 10px; width: 16px; height: 16px;">
                    <span style="font-size: 14px; color: #333;">${escapeHTML(wb.title)}</span>
                </label>
            `;
        });
        listHtml += `</div></details>`;
    }
    
    if (Object.keys(groupedData).length === 0) {
        listHtml = '<div style="text-align: center; color: #999; padding: 20px;">暂无世界书，请先在世界书页面添加。</div>';
    }
    overlay.innerHTML = `
        <div class="modal-card" style="background: #fff; width: 92%; max-width: 380px; border-radius: 20px; padding: 20px; display: flex; flex-direction: column; max-height: calc(100dvh - 40px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); box-sizing: border-box; overflow: hidden;">
            <h3 style="margin: 0 0 15px; font-size: 16px; text-align: center;">配置 ${escapeHTML(member.name)} 的专属世界书</h3>
            <div style="flex: 1; min-height: 0; overflow-y: auto; margin-bottom: 15px; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;">
                ${listHtml}
            </div>
            <div style="display: flex; gap: 10px;">
                <button id="member-wb-cancel" style="flex: 1; padding: 10px; background: #f5f5f5; color: #333; border: none; border-radius: 12px; cursor: pointer; font-weight: 600;">取消</button>
                <button id="member-wb-save" style="flex: 1; padding: 10px; background: #111; color: #fff; border: none; border-radius: 12px; cursor: pointer; font-weight: 600;">保存</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(overlay);
    
    // 强制回流以触发动画
    overlay.offsetHeight;
    overlay.style.opacity = '1';
    
    const closeOverlay = () => {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 300);
    };
    
    overlay.querySelector('#member-wb-cancel').onclick = closeOverlay;
    
    overlay.querySelector('#member-wb-save').onclick = async () => {
        const checkboxes = overlay.querySelectorAll('.member-wb-checkbox:checked');
        const selectedIds = Array.from(checkboxes).map(cb => Number(cb.value)); 
        
        if (!groupChar.memberMountedWBIds) groupChar.memberMountedWBIds = {};
        groupChar.memberMountedWBIds[member.id] = selectedIds;
        
        await db.characterProfiles.put(groupChar);
        if (typeof showDynamicIsland === 'function') showDynamicIsland('专属世界书已保存', 'success');
        
        closeOverlay();
        if (renderCallback) renderCallback();
    };
}
