/* --- 新建文件：js/features/profile.js --- */

import { AppState, db } from '../state.js';
import { addTapListener, compressImageDataUrl } from '../utils.js';
import { setupImageUploader } from '../core.js';
import { UI } from '../ui.js';
const PROFILE_REFRESH_MIN_INTERVAL_MS = 1500;
let profileRefreshPromise = null;
let lastProfileRefreshAt = 0;
// js/features/profile.js

// ▼▼▼ 用下面的代码替换你现有的 initProfilePage 函数 ▼▼▼
// js/features/profile.js

export async function initProfilePage() {
    if (initProfilePage.initialized && Date.now() - lastProfileRefreshAt < PROFILE_REFRESH_MIN_INTERVAL_MS) return;
    if (profileRefreshPromise) return profileRefreshPromise;
    profileRefreshPromise = (async () => {
        await loadDIYData();
        renderDIYPage();
        await loadProfileStats();
        lastProfileRefreshAt = Date.now();
    })();
    try {
        await profileRefreshPromise;
    } finally {
        profileRefreshPromise = null;
    }
    console.log("正在初始化或刷新 DIY 个人主页...");

    if (!initProfilePage.initialized) {
        console.log("首次绑定个人主页事件...");

        // ▼▼▼ 【第 2 步：在这里使用我们刚刚创建的新函数】 ▼▼▼
        
        // --- 处理背景图上传 ---
        setupProfileImageUploader(
            'profile-bg-upload',        // input 的 ID
            'profile-bg-img',           // 预览 img 的 ID
            async (base64) => {         // 当图片选好后要执行的操作
                AppState.profileDIY.background = base64;
                await saveDIYData();    // 等待保存完成
            }
        );

        // --- 处理头像上传 ---
        setupProfileImageUploader(
            'profile-diy-avatar-upload', // input 的 ID
            'profile-diy-avatar-img',    // 预览 img 的 ID
            async (base64) => {          // 当图片选好后要执行的操作
                AppState.profileDIY.avatar = base64;
                await saveDIYData();     // 等待保存完成
            }
        );

        // ▲▲▲ 使用新函数结束 ▲▲▲

        const bgTrigger = document.getElementById('profile-bg-trigger');
        const bgInput = document.getElementById('profile-bg-upload');
        if (bgTrigger && bgInput) addTapListener(bgTrigger, () => bgInput.click());

        const avatarTrigger = document.getElementById('profile-diy-avatar-trigger');
        const avatarInput = document.getElementById('profile-diy-avatar-upload');
        if (avatarTrigger && avatarInput) addTapListener(avatarTrigger, () => avatarInput.click());

        setupTextEditing(); // 文本编辑逻辑保持不变，它是好的

        initProfilePage.initialized = true;
    }
}
export function renderDIYPage() {
    const data = AppState.profileDIY;
    if (!data) return;
    const bgImg = document.getElementById('profile-bg-img');
    const avImg = document.getElementById('profile-diy-avatar-img');
    const nickEl = document.getElementById('profile-diy-nickname');
    const signEl = document.getElementById('profile-diy-signature');
    const tagsEl = document.querySelector('.info-cluster .profile-tags'); 

    // 修复背景图
    if (bgImg) {
        if (data.background && data.background.startsWith('data:image')) {
            bgImg.src = data.background;
        } else {
            bgImg.src = 'images/default-bg.jpg';
        }
    }
    // 修复头像
    if (avImg) {
        if (data.avatar && data.avatar.startsWith('data:image')) {
            avImg.src = data.avatar;
        } else {
            avImg.src = 'default-avatar.svg';
        }
    }
    if (nickEl) nickEl.innerText = data.nickname || '点击修改昵称';
    if (signEl) signEl.innerText = data.signature || '点击修改签名...';
    
    // 【终极修复】安全渲染标签，完美兼容普通 div 和 input 框
    if (tagsEl) {
        const isInput = tagsEl.tagName === 'INPUT' || tagsEl.tagName === 'TEXTAREA';
        if (data.tags !== undefined && data.tags !== null) {
            if (isInput) tagsEl.value = data.tags;
            else tagsEl.innerHTML = data.tags;
        } else {
            // 如果数据库没存，给一个默认提示
            if (isInput) {
                if (!tagsEl.value) tagsEl.value = '';
            } else {
                if (!tagsEl.innerText.trim()) tagsEl.innerText = '点击添加标签...';
            }
        }
    }
}

// 核心：处理文字编辑 (点击改名、改签名、改标签)
function setupTextEditing() {
    const nickEl = document.getElementById('profile-diy-nickname');
    const signEl = document.getElementById('profile-diy-signature');
    const tagsEl = document.querySelector('.info-cluster .profile-tags'); 

    // 【新增】防抖计时器，防止连续变动时频繁写入数据库卡顿
    let saveTimeout;

    // 【优化】统一的高级保存逻辑
    const handleSave = (element, field, useHTML = false) => {
        if (!element) return;
        
        // 清除上一次的计时，重新开始 0.5 秒倒计时
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(async () => {
            const isInput = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA';
            // 如果是输入框强制取 value，如果是 div 取 innerHTML 或 innerText
            const valueToSave = isInput ? element.value : (useHTML ? element.innerHTML : element.innerText);
            
            // 只有当内容【真正改变】了才写数据库，极其节省性能
            if (AppState.profileDIY[field] !== valueToSave) {
                AppState.profileDIY[field] = valueToSave;
                await saveDIYData(); 
                console.log(`✅ 自动保存成功 [${field}]:`, valueToSave);
            }
        }, 500); 
    };

    const bindEvents = (element, field, useHTML = false) => {
        if (!element) return;
        const isInput = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA';

        // 1. 保留基本的失焦保存 (防御性编程)
        element.addEventListener('blur', () => handleSave(element, field, useHTML));
        if (isInput) element.addEventListener('change', () => handleSave(element, field, useHTML));

        // 2. 【核心大招】启用 MutationObserver 监控 DOM 变化
        // 专门对付“通过外部代码/弹窗修改导致无法触发事件”的场景！
        if (!isInput) {
            const observer = new MutationObserver(() => handleSave(element, field, useHTML));
            // 监视：子节点的增减、文本的变动、整个子树的改动
            observer.observe(element, { childList: true, subtree: true, characterData: true });
        }
    };

    // 绑定普通文本
    bindEvents(nickEl, 'nickname');
    bindEvents(signEl, 'signature');
    // 绑定标签（开启 useHTML，原汁原味保留你的标签样式）
    bindEvents(tagsEl, 'tags', true); 
}

// 数据库：加载
async function loadDIYData() {
    try {
        const saved = await db.appData.get('profileDIYData');
        if (saved && saved.value) {
            // 合并数据，确保任何新添加的默认字段不会丢失
            AppState.profileDIY = { ...AppState.profileDIY, ...saved.value };
        }
    } catch (e) {
        console.warn("读取DIY主页数据失败，使用默认值", e);
    }
}

// 数据库：保存
async function saveDIYData() {
    try {
        // 存入 'profileDIYData'，完全不影响 userIdentities
        await db.appData.put({ key: 'profileDIYData', value: AppState.profileDIY });
    } catch (e) {
        console.error("保存DIY主页数据失败", e);
    }
}
// js/features/profile.js

/**
 * 获取好友数量 (已修正)
 * @returns {Promise<number>}
 */
async function getFriendsCount() {
    // 修正：直接统计 characterProfiles 表里有多少个角色，这代表了好友的总数
    return await db.characterProfiles.count();
}

/**
 * 获取身份数量 (已修正)
 * @returns {number}
 */
function getIdentitiesCount() {
    // 修正：直接从 AppState 中读取用户身份的数量，因为它在应用加载时就已经从 appData 表读出来了
    return AppState.userIdentities.length;
}

/**
 * 计算总聊天天数 (逻辑不变)
 * @returns {Promise<number>}
 */
async function getChatDays() {
    // 找到数据库中时间戳最早的一条消息
    const firstMessage = await db.chatMessages.orderBy('timestamp').first();
    
    // 如果一条消息都没有，直接返回0
    if (!firstMessage) {
        return 0;
    }
    
    // 计算最早消息的时间到现在的天数差
    const diffTime = Date.now() - firstMessage.timestamp;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    return diffDays;
}

/**
 * 加载并渲染个人主页的统计数据 (已修正)
 */
export async function loadProfileStats() {
    // 开始加载时，先显示"..."
    if (UI.profileStats.friendsCount) UI.profileStats.friendsCount.textContent = '...';
    if (UI.profileStats.identitiesCount) UI.profileStats.identitiesCount.textContent = '...';
    if (UI.profileStats.chatDays) UI.profileStats.chatDays.textContent = '...';
    
    try {
        // Promise.all 可以并行处理，速度更快
        const [friendsCount, chatDays] = await Promise.all([
            getFriendsCount(),
            // getIdentitiesCount() 不是异步的，所以我们单独获取
            getChatDays()
        ]);
        
        // 单独获取身份数量
        const identitiesCount = getIdentitiesCount();

        // 数据都查回来后，更新到页面上
        if (UI.profileStats.friendsCount) UI.profileStats.friendsCount.textContent = friendsCount;
        if (UI.profileStats.identitiesCount) UI.profileStats.identitiesCount.textContent = identitiesCount;
        if (UI.profileStats.chatDays) UI.profileStats.chatDays.textContent = chatDays;
    } catch (error) {
        console.error("加载个人主页统计数据失败:", error);
        // 如果出错了，就显示 'N/A'
        if (UI.profileStats.friendsCount) UI.profileStats.friendsCount.textContent = 'N/A';
        if (UI.profileStats.identitiesCount) UI.profileStats.identitiesCount.textContent = 'N/A';
        if (UI.profileStats.chatDays) UI.profileStats.chatDays.textContent = 'N/A';
    }
}
// js/features/profile.js 的最底部

// =======================================================
// == 【全新重写】可靠的图片上传与保存逻辑
// =======================================================

/**
 * 专用于个人主页的图片上传处理器
 * @param {string} inputId - 文件输入框的ID
 * @param {string} previewImgId - 预览图片的ID
 * @param {function(string): Promise<void>} onImageLoadedAndSaved - 图片加载并保存后的回调
 */
function setupProfileImageUploader(inputId, previewImgId, onImageLoadedAndSaved) {
    const inputElement = document.getElementById(inputId);
    const previewImgElement = document.getElementById(previewImgId);

    if (!inputElement || !previewImgElement) {
        console.error(`无法找到元素: ${inputId} 或 ${previewImgId}`);
        return;
    }

    inputElement.addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;

        try {
            // 1. 将文件转为 Base64
            const base64String = await fileToBase64(file);
            
            // 2. 立即更新界面预览
            previewImgElement.src = base64String;

            // 3. 【核心】调用传入的回调函数，并用 await 等待它执行完毕
            //    这个回调函数内部会执行 AppState 更新和数据库保存
            await onImageLoadedAndSaved(base64String);

            console.log(`✅ 图片 ${inputId} 已成功处理并保存。`);

        } catch (error) {
            console.error(`处理图片 ${inputId} 时出错:`, error);
        }
    });
}


/**
 * 文件转 Base64 的辅助函数 (从 moments.js 借鉴)
 * @param {File} file 
 * @returns {Promise<string>}
 */
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = async () => resolve(await compressImageDataUrl(reader.result));
        reader.onerror = error => reject(error);
    });
}
