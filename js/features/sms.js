import { showPage } from '../ui.js';
import { addTapListener, isValidAvatarSrc, escapeHTML } from '../utils.js';
import { AppState, tempState, DEFAULT_AVATAR_SRC, db } from '../state.js';
import { notification } from './notification.js';
export const SMSModule = {
    isMultiSelectMode: false,
    selectedSmsIds: new Set(),
    _hasInit: false,  // 新增：事件绑定锁
    isSending: false, // 新增：防连击锁
    init() {
        this.renderSmsList();
        if (this._hasInit) return; // 新增：如果已经绑定过事件，直接跳过，绝不重复绑定！
        this._hasInit = true;      // 新增：标记为已绑定
        // 绑定底部“实名发送”提示的点击事件，开启匿名整蛊
        const statusHintBtn = document.getElementById('sms-status-hint');
        const anonymousModal = document.getElementById('sms-anonymous-modal');
        const cancelAnonBtn = document.getElementById('sms-anonymous-cancel');
        const confirmAnonBtn = document.getElementById('sms-anonymous-confirm');
        const refreshNumberBtn = document.getElementById('sms-refresh-number-btn');

        // 【补回这里】刚才删多了，把这俩获取界面元素的变量补回来
        const numberDisplay = document.getElementById('sms-random-number');
        const hintSpan = statusHintBtn ? statusHintBtn.querySelector('span') : null;

        const generateRandomPhone = () => {
            const prefix = ['138', '139', '150', '151', '158', '188', '170'];
            const randomPrefix = prefix[Math.floor(Math.random() * prefix.length)];
            const suffix = Math.floor(Math.random() * 8999 + 1000);
            return `${randomPrefix}****${suffix}`;
        };

        if (statusHintBtn && anonymousModal) {
            addTapListener(statusHintBtn, () => {
                // 如果当前已经是匿名状态，点击则退出匿名
                if (tempState.isSmsAnonymous) {
                    if (confirm("确定要结束匿名状态，恢复实名发送吗？")) {
                        tempState.isSmsAnonymous = false;
                        db.appData.delete('sms_anonymous_state_' + tempState.currentSmsCharId); // 【修改】按角色隔离清除状态
                        hintSpan.textContent = "以实名主号发送中";
                        hintSpan.style.color = ""; // 恢复默认颜色
                        // 插入一条分界线消息
                        db.smsMessages.add({ chatId: tempState.currentSmsCharId, timestamp: new Date(), sender: 'system', text: '—— 匿名会话已结束，恢复实名通讯 ——' });
                        SMSModule.loadSmsHistory(tempState.currentSmsCharId);
                    }
                    return;
                }
                
                // 打开弹窗并生成一个新号码
                numberDisplay.textContent = generateRandomPhone();
                anonymousModal.style.display = 'flex';
                setTimeout(() => anonymousModal.style.opacity = '1', 10);
            });

            refreshNumberBtn.onclick = () => { numberDisplay.textContent = generateRandomPhone(); };

            cancelAnonBtn.onclick = () => {
                anonymousModal.style.opacity = '0';
                setTimeout(() => anonymousModal.style.display = 'none', 300);
            };

            confirmAnonBtn.onclick = () => {
                const tag = document.getElementById('sms-anonymous-tag').value;
                const fakeNumber = numberDisplay.textContent;
                 // 记录状态到内存中
                tempState.isSmsAnonymous = true;
                tempState.anonymousTag = tag;
                tempState.anonymousNumber = fakeNumber;
                db.appData.put({ key: 'sms_anonymous_state_' + tempState.currentSmsCharId, value: { isAnon: true, tag: tag, number: fakeNumber } }); // 【修改】按角色隔离保存状态
                
                // 改变底部 UI 提示
                hintSpan.textContent = `以伪装身份(${tag})发送中`;
                hintSpan.style.color = "#ff3b30"; // 变成红色警示
                // 关掉弹窗
                anonymousModal.style.opacity = '0';
                setTimeout(() => anonymousModal.style.display = 'none', 300);

                // 在数据库里插入一条系统分界线 (改为名片专属标记)
                const sysText = `[ANON_CARD|${fakeNumber}|${tag}]`;
                db.smsMessages.add({ chatId: tempState.currentSmsCharId, timestamp: new Date(), sender: 'system', text: sysText }).then(() => {
                    SMSModule.loadSmsHistory(tempState.currentSmsCharId);
                });
            };
        }
        // --- 新增：短信设置页的各项交互逻辑 ---
        const moreBtn = document.getElementById('sms-detail-more-btn');
        if (moreBtn) addTapListener(moreBtn, () => showPage('page-sms-settings'));

        // 壁纸上传逻辑（独立保存到当前角色）
        const bgInput = document.getElementById('sms-bg-upload-input');
        const bgBtn = document.getElementById('sms-settings-bg-btn');
         if (bgBtn && bgInput) {
            addTapListener(bgBtn, () => bgInput.click());
            bgInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                 if (!file || !tempState.currentSmsCharId) return;

                const reader = new FileReader();
                reader.onload = (event) => {
                    const img = new Image();
                    img.onload = async () => {
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');
                        // 压缩尺寸：限制最大宽度 1080，等比例缩放
                        let width = img.width;
                        let height = img.height;
                        if (width > 1080) {
                            height = Math.round((height * 1080) / width);
                            width = 1080;
                        }
                        canvas.width = width;
                        canvas.height = height;
                        ctx.drawImage(img, 0, 0, width, height);
                        
                        // 【优化1】使用 WebP 格式压缩，压缩率比 JPG 更高，画质更好，体积骤减
                         const compressedWebP = canvas.toDataURL('image/webp', 0.8);
                        
                        try {
                            // 【优化2】统一使用系统的 db.appData 存储，告别臃肿的原生写法
                            await db.appData.put({ key: 'sms_bg_' + tempState.currentSmsCharId, value: compressedWebP });
                            
                            // 实时给当前的页面换上壁纸
                            const detailPage = document.getElementById('page-sms-detail');
                            const chatContent = document.getElementById('sms-chat-content');
                            detailPage.style.setProperty('background-image', `url(${compressedWebP})`, 'important');
                            detailPage.style.setProperty('background-size', 'cover', 'important');
                            detailPage.style.setProperty('background-position', 'center', 'important');
                            if (chatContent) chatContent.style.setProperty('background', 'transparent', 'important');
                            if (detailPage.querySelector('.app-content')) detailPage.querySelector('.app-content').style.setProperty('background', 'transparent', 'important');
                            alert('专属壁纸更换成功！');
                        } catch (err) {
                            alert('保存到数据库失败，请检查浏览器存储权限。');
                            console.error(err);
                        }
                    };
                    img.src = event.target.result;
                };
                reader.readAsDataURL(file);
            });
        }
        const bgResetBtn = document.getElementById('sms-settings-bg-reset-btn');
        if (bgResetBtn) {
            addTapListener(bgResetBtn, async () => {
                if (!tempState.currentSmsCharId) return;
                try {
                    // 统一改用自带的 db.appData 删除壁纸
                    await db.appData.delete('sms_bg_' + tempState.currentSmsCharId);
                    
                    const detailPage = document.getElementById('page-sms-detail');
                    const chatContent = document.getElementById('sms-chat-content');
                    detailPage.style.removeProperty('background-image');
                    if (chatContent) chatContent.style.removeProperty('background');
                    if (detailPage.querySelector('.app-content')) detailPage.querySelector('.app-content').style.removeProperty('background');
                    alert('壁纸已重置！');
                } catch (err) {
                    console.error(err);
                }
            });
        }
        // ▼▼▼ 修改：拉黑按钮逻辑与解除拉黑 ▼▼▼
        const blockBtn = document.getElementById('sms-block-btn');
        if (blockBtn) {
           addTapListener(blockBtn, async () => {
                if (tempState.currentSmsCharId) {
                    const char = AppState.characterProfiles.find(c => c.id === tempState.currentSmsCharId);
                    if (char) {
                        // ▼▼▼ 新增：单向拉黑保护。如果AI的短信黑名单里已经有这个号码，阻止操作 ▼▼▼
                        const currentNumber = tempState.isSmsAnonymous ? tempState.anonymousNumber : '主号';
                        if (char.blockedByAiNumbers && char.blockedByAiNumbers.includes(currentNumber)) {
                            alert('对方已将该号码拉黑，您当前无法执行此操作。');
                            return;
                        }
                        // ▲▲▲ 新增结束 ▲▲▲

                        char.isSmsBlocked = true; // 改用独立短信拉黑字段
                        await db.characterProfiles.update(char.id, { isSmsBlocked: true });
                        alert('已拉黑该联系人的短信');
                        const blockedOverlay = document.getElementById('sms-blocked-overlay');
                        if (blockedOverlay) blockedOverlay.style.display = 'flex';
                    }
                }
            });
        }
        const unblockBtn = document.getElementById('sms-unblock-char-btn');
        if (unblockBtn) {
            addTapListener(unblockBtn, async () => {
                if (tempState.currentSmsCharId) {
                    const char = AppState.characterProfiles.find(c => c.id === tempState.currentSmsCharId);
                    if (char) {
                        char.isSmsBlocked = false; // 改用独立短信拉黑字段
                        await db.characterProfiles.update(char.id, { isSmsBlocked: false });
                        alert('已解除短信拉黑');
                        const blockedOverlay = document.getElementById('sms-blocked-overlay');
                        if (blockedOverlay) blockedOverlay.style.display = 'none';
                    }
                }
            });
        }
               const smsDeleteHistoryBtn = document.getElementById('sms-delete-history-btn');
        if (smsDeleteHistoryBtn) {
            addTapListener(smsDeleteHistoryBtn, async () => {
                const charId = tempState.currentSmsCharId;
                if (!charId) return;
                const char = AppState.characterProfiles.find(c => c.id === charId);
                if (!char) return;
                
                if (!confirm(`确定要清空与 "${char.name}" 的所有短信记录吗？此操作不可逆！`)) return;
                
                try {
                    // 直接干掉数据库里这个人的所有短信
                    await db.smsMessages.where({ chatId: charId }).delete();
                    
                    // 清空UI界面
                    const chatContent = document.getElementById('sms-chat-content');
                    if (chatContent) chatContent.innerHTML = '';
                    
                    alert('短信记录已清空');
                    
                    // 顺便自动退回到短信主界面
                    showPage('page-sms');
                } catch (e) {
                    console.error('清空短信失败:', e);
                    alert('清空失败，请重试');
                }
            });
        }
        // 短信编辑弹窗事件
        const smsEditModal = document.getElementById('sms-edit-modal');
        const saveSmsEditBtn = document.getElementById('save-sms-edit-btn');
        if (smsEditModal && saveSmsEditBtn) {
            saveSmsEditBtn.addEventListener('click', async () => {
                const id = Number(document.getElementById('sms-edit-message-id').value);
                const newContent = document.getElementById('sms-edit-message-content').value.trim();
                if (!id || !newContent) return;
                await db.smsMessages.update(id, { text: newContent });
                smsEditModal.classList.remove('visible');
                this.loadSmsHistory(tempState.currentSmsCharId);
            });
            document.getElementById('cancel-sms-edit-btn').addEventListener('click', () => smsEditModal.classList.remove('visible'));
            smsEditModal.addEventListener('click', (e) => { if (e.target === smsEditModal) smsEditModal.classList.remove('visible'); });
        }
        // ▲▲▲ 修改结束 ▲▲▲
        // ▼▼▼ 新增：绑定发送短信的点击和回车事件 ▼▼▼
        const smsInput = document.getElementById('sms-chat-input');
        const smsSendBtn = document.getElementById('sms-send-btn');
        const smsRetryBtn = document.getElementById('sms-retry-btn'); // 获取重回按钮
        if (smsSendBtn && smsInput) {
            addTapListener(smsSendBtn, () => this.handleSendSms());
            // 【修改】：恢复回车发送，但传入 true，告诉底层只上屏不给 AI
            smsInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault(); // 防止回车键在 input 里引发默认的表单提交行为
                    this.handleSendSms(null, true);
                }
            });
        }
        if (smsRetryBtn) {
            addTapListener(smsRetryBtn, () => this.handleRetrySms());
        }

        // ▼▼▼ 新增：绑定短信多选删除事件 ▼▼▼
        const multiSelectBtn = document.getElementById('sms-multi-select-btn');
        const deleteCancelBtn = document.getElementById('sms-delete-cancel');
        const deleteConfirmBtn = document.getElementById('sms-delete-confirm');
        
        if (multiSelectBtn) addTapListener(multiSelectBtn, () => this.toggleMultiSelectMode(true));
        if (deleteCancelBtn) addTapListener(deleteCancelBtn, () => this.toggleMultiSelectMode(false));
        if (deleteConfirmBtn) addTapListener(deleteConfirmBtn, () => this.deleteSelectedSms());
      // ▼▼▼ 新增：监听后台系统发来的短信刷新事件，秒级上屏旁白 ▼▼▼
        document.addEventListener('sms_received_system', (e) => {
            if (e.detail && String(e.detail.charId) === String(tempState.currentSmsCharId)) {
                const detailPage = document.getElementById('page-sms-detail');
                if (detailPage && window.getComputedStyle(detailPage).display !== 'none') {
                    // 【防错加固】直接调用 SMSModule 对象，防止 this 丢失导致渲染失败
                    SMSModule.loadSmsHistory(tempState.currentSmsCharId);
                }
            }
        });
        console.log("短信模块 (SMSModule) 初始化成功");
    },
    renderSmsList() {
        const container = document.getElementById('sms-list-container');
        if (!container) return;
        
        container.innerHTML = ''; // 清空旧内容
       // 【性能极致优化1】：将所有HTML拼接成一整个大字符串，最后一次性插入DOM，杜绝循环中的频繁重排！
        let allItemsHtml = '';
        AppState.characterProfiles.forEach(char => {
            if (char.isGroup || (typeof char.id === 'string' && char.id.startsWith('group_'))) return;
            const avatar = isValidAvatarSrc(char.avatar) ? char.avatar : DEFAULT_AVATAR_SRC;
            const name = escapeHTML(char.name);
            
            // 【性能极致优化2】：加入 decoding="async" 和 loading="lazy"，避免图片解码阻塞主线程
            allItemsHtml += `
                <div class="sms-list-item" data-char-id="${char.id}">
                    <img data-src="${avatar}" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" class="sms-avatar lazy-avatar" loading="lazy" decoding="async" alt="avatar">
                    <div class="sms-item-info">
                        <div class="sms-item-top">
                            <span class="name">${name}</span>
                            <span class="time">刚刚</span>
                        </div>
                        <div class="sms-item-bottom">
                            <p class="msg-preview">点击查看短信详情</p>
                        </div>
                    </div>
                </div>
            `;
        });
        container.innerHTML = allItemsHtml; // 仅此一次 DOM 插入操作
        
        // 【性能极致优化3】：使用事件委托结合项目中原有的 addTapListener，坚决不在循环中绑定事件！
        addTapListener(container, (e) => {
            const item = e.target.closest('.sms-list-item');
            if (item) {
                const charId = item.getAttribute('data-char-id');
                this.openSmsDetail(charId);
            }
        });
        // 【优化4】使用 IntersectionObserver 监听图片，仅在滑入可视区域时加载图片
        const lazyImages = container.querySelectorAll('.lazy-avatar');
        if ('IntersectionObserver' in window) {
            const imageObserver = new IntersectionObserver((entries, observer) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        img.src = img.getAttribute('data-src'); // 赋予真实图片
                        img.classList.remove('lazy-avatar');
                        observer.unobserve(img); // 加载完后取消监听
                    }
                });
            });
            lazyImages.forEach(img => imageObserver.observe(img));
        } else {
            // 兼容不支持的旧版浏览器，直接加载
            lazyImages.forEach(img => img.src = img.getAttribute('data-src'));
        }
    },

    openSmsDetail(charId) {
        // 1. 从所有角色中找到对应的那个角色数据
        const character = AppState.characterProfiles.find(c => c.id == charId);
        if (!character) return;

        // 2. 更新系统的当前聊天 ID
        tempState.currentSmsCharId = charId;

        // 3. 更换详情页顶部的头像和名字
        const avatarSrc = isValidAvatarSrc(character.avatar) ? character.avatar : DEFAULT_AVATAR_SRC;
        document.getElementById('sms-detail-avatar').src = avatarSrc;
        document.getElementById('sms-detail-name').textContent = escapeHTML(character.name);
        // 4. 清空聊天区域，准备迎接属于这个人的专属短息
        const chatContent = document.getElementById('sms-chat-content');
        if (chatContent) {
            chatContent.innerHTML = ''; 
        }
        // --- 新增：读取该角色的专属设置并应用 ---
        const detailPage = document.getElementById('page-sms-detail');
        // 异步加载壁纸（统一改用系统自带的 db.appData）
        db.appData.get('sms_bg_' + charId).then(savedBgRecord => {
            const savedBg = savedBgRecord ? savedBgRecord.value : null;
            if (savedBg) {
                // 如果这个人有壁纸，就贴上，并把内容区的白底变透明
                detailPage.style.setProperty('background-image', `url(${savedBg})`, 'important');
                detailPage.style.setProperty('background-size', 'cover', 'important');
                detailPage.style.setProperty('background-position', 'center', 'important');
                if (chatContent) chatContent.style.setProperty('background', 'transparent', 'important');
                if (detailPage.querySelector('.app-content')) detailPage.querySelector('.app-content').style.setProperty('background', 'transparent', 'important');
            } else {
                // 如果没有，就恢复原本的系统白色
                detailPage.style.removeProperty('background-image');
                if (chatContent) chatContent.style.removeProperty('background');
                if (detailPage.querySelector('.app-content')) detailPage.querySelector('.app-content').style.removeProperty('background');
            }
        });
        // ▼▼▼ 新增：判断拉黑状态显示遮板 ▼▼▼
        const blockedOverlay = document.getElementById('sms-blocked-overlay');
        if (blockedOverlay) {
          if (character && character.isSmsBlocked) { // 改为 isSmsBlocked
                blockedOverlay.style.display = 'flex';
            } else {
                blockedOverlay.style.display = 'none';
            }
        }
        // ▲▲▲ 新增结束 ▲▲▲

        // 【新增】读取并应用该角色局部的匿名身份状态
        const hintSpan = document.getElementById('sms-status-hint')?.querySelector('span');
        db.appData.get('sms_anonymous_state_' + charId).then(savedAnon => {
            if (savedAnon && savedAnon.value) {
                const anonData = savedAnon.value;
                tempState.isSmsAnonymous = anonData.isAnon;
                tempState.anonymousTag = anonData.tag;
                tempState.anonymousNumber = anonData.number;
                if (hintSpan) {
                    hintSpan.textContent = `以伪装身份(${anonData.tag})发送中`;
                    hintSpan.style.color = "#ff3b30";
                }
            } else {
                tempState.isSmsAnonymous = false;
                tempState.anonymousTag = '';
                tempState.anonymousNumber = '';
                if (hintSpan) {
                    hintSpan.textContent = "以实名主号发送中";
                    hintSpan.style.color = "";
                }
            }
        }).catch(e => console.warn(e));

        // ▼▼▼ 新增：滑入页面前，先从数据库把以前的短信读出来贴上 ▼▼▼
        this.loadSmsHistory(charId);
        // ▲▲▲ 新增结束 ▲▲▲
        // 5. 准备就绪，滑入详情页
        showPage('page-sms-detail');
    },

    // ▼▼▼ 新增：读取历史记录的函数 ▼▼▼
    // ▼▼▼ 修改：读取历史记录 (加入 30 条折叠优化) ▼▼▼
    async loadSmsHistory(charId) {
        const chatContent = document.getElementById('sms-chat-content');
        if (!chatContent) return;
        chatContent.innerHTML = ''; // 清空重新渲染

        const history = await db.smsMessages.where({ chatId: charId }).sortBy('timestamp');
        
        if (history.length > 30) {
            const hiddenHistory = history.slice(0, history.length - 30);
            const visibleHistory = history.slice(history.length - 30);
            
            // 插入折叠按钮
            chatContent.insertAdjacentHTML('beforeend', `<div id="sms-load-more-btn" style="text-align: center; color: #007aff; font-size: 13px; padding: 10px; cursor: pointer;">展开较早的 ${hiddenHistory.length} 条消息</div>`);
            
            // 隐藏的旧消息容器
            const hiddenContainer = document.createElement('div');
            hiddenContainer.id = 'sms-hidden-history';
            hiddenContainer.style.display = 'none';
            hiddenContainer.style.flexDirection = 'column';
            hiddenContainer.style.gap = '16px';
            chatContent.appendChild(hiddenContainer);
            // 【性能优化】不在一开始就渲染隐藏的旧消息 DOM，防止节点爆炸引起页面卡死。点击后再加载！
            document.getElementById('sms-load-more-btn').addEventListener('click', () => {
                const btn = document.getElementById('sms-load-more-btn');
                if (btn) btn.style.display = 'none';
                document.getElementById('sms-hidden-history').style.display = 'flex';
                // 只有在用户点击了展开按钮时，才去真实地把老短信显示出来
                const tempHidden = document.createElement('div'); // 【优化】创建离线内存容器
                hiddenHistory.forEach(msg => {
                    const renderType = msg.sender === 'system' ? 'system' : (msg.sender === 'user');
                    this.appendSmsBubble(msg.text, renderType, msg.id, tempHidden, msg.isRejected);
                });
                while (tempHidden.firstChild) hiddenContainer.appendChild(tempHidden.firstChild); // 【优化】一次性搬运上屏，消灭卡顿！
            });
            
            // 可见的新消息
            const tempVisible = document.createElement('div'); // 【优化】创建离线内存容器
            visibleHistory.forEach(msg => {
                const renderType = msg.sender === 'system' ? 'system' : (msg.sender === 'user');
                this.appendSmsBubble(msg.text, renderType, msg.id, tempVisible, msg.isRejected);
            });
            while (tempVisible.firstChild) chatContent.appendChild(tempVisible.firstChild); // 【优化】一次性搬运上屏
            
        } else {
            const tempAll = document.createElement('div'); // 【优化】创建离线内存容器
            history.forEach(msg => {
                const renderType = msg.sender === 'system' ? 'system' : (msg.sender === 'user');
                this.appendSmsBubble(msg.text, renderType, msg.id, tempAll, msg.isRejected);
            });
            while (tempAll.firstChild) chatContent.appendChild(tempAll.firstChild); // 【优化】一次性搬运上屏
        }
        // 稍微延迟确保渲染完毕再滚动到底部
        setTimeout(() => {
            chatContent.scrollTop = chatContent.scrollHeight;
            const appContent = chatContent.closest('.app-content');
            if (appContent) appContent.scrollTop = appContent.scrollHeight;
        }, 100);
    },
     // ▼▼▼ 修改：气泡绘制函数 (加入 ID 和 多选点击逻辑) ▼▼▼
    appendSmsBubble(text, isMe, msgId = null, targetContainer = null, isRejected = false) {
        const chatContent = targetContainer || document.getElementById('sms-chat-content');
        if (!chatContent) return;
      let rowClass, bubbleHtml;
        if (isMe === 'system') {
           // 系统旁白/思考的精致样式
            rowClass = 'sms-bubble-row system-hint';
            
            // 拦截并渲染名片
            if (text.startsWith('[ANON_CARD|')) {
                const parts = text.replace('[ANON_CARD|', '').replace(']', '').split('|');
                const fakeNum = escapeHTML(parts[0] || '');
                const tagStr = escapeHTML(parts[1] || '');
                bubbleHtml = `
                <div style="background: #fff; width: 90%; max-width: 320px; border: 1px solid #eaeaea; padding: 24px 20px; position: relative; overflow: hidden; text-align: left; margin: 15px auto; box-shadow: 0 4px 15px rgba(0,0,0,0.03);">
                    <svg style="position: absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; opacity:0.6;" viewBox="0 0 300 150">
                        <line x1="100" y1="0" x2="80" y2="150" stroke="#ccc" stroke-dasharray="2 2" stroke-width="1"/>
                        <line x1="0" y1="120" x2="300" y2="40" stroke="#ccc" stroke-dasharray="2 2" stroke-width="1"/>
                        <circle cx="160" cy="80" r="2" fill="#999"/>
                        <circle cx="120" cy="90" r="2" fill="#999"/>
                    </svg>
                    <div style="position: relative; z-index: 1;">
                                            <div style="display: flex; align-items: flex-end; margin-bottom: 25px; margin-left: 25%;">
                            <span style="font-size: 8px; color: #999; margin-right: 8px; margin-bottom: 3px;">JOB<br>TITLE:</span>
                            <span style="font-size: 16px; color: #111; font-family: serif; font-weight: bold; border-bottom: 1px dashed #ccc; padding-bottom: 2px;">${tagStr} / Stranger</span>
                        </div>
                        <div style="display: flex; align-items: flex-end; margin-bottom: 25px; margin-left: 35%;">
                            <span style="font-size: 8px; color: #999; margin-right: 8px; margin-bottom: 3px;">STATUS<br>INFO:</span>
                            <span style="font-size: 13px; color: #333; border-bottom: 1px dashed #ccc; padding-bottom: 2px;">虚拟身份伪装开启</span>
                        </div>
                                            <div style="display: flex; align-items: flex-end; margin-left: 15%;">
                            <span style="font-size: 8px; color: #999; margin-right: 8px; margin-bottom: 3px;">PHONE<br>NUMBER:</span>
                            <span style="font-size: 18px; color: #111; font-family: serif; letter-spacing: 1px; border-bottom: 1px dashed #ccc; padding-bottom: 2px;">${fakeNum}</span>
                        </div>
                        <div style="position: absolute; bottom: -5px; left: 0; font-family: serif;">
                            <div style="font-size: 12px; color: #3d3d3d; letter-spacing: 2px;">隐匿</div>
                            <div style="font-size: 18px; color: #666; font-weight: normal; letter-spacing: 4px;">LOOKY</div>
                        </div>
                    </div>
                </div>`;
            } else {
                let parsedText = escapeHTML(text);
                parsedText = parsedText.replace(/输入草稿：?&quot;(.*?)&quot;/g, '输入草稿：<span class="sms-draft-btn" data-draft="$1" style="color: #ff6b81; font-weight: bold; text-decoration: underline; cursor: pointer;">点击查看</span>');
                bubbleHtml = `<div style="width: 100%; text-align: center; margin: 10px 0;"><span style="font-size: 11px; color: #999; background: rgba(0,0,0,0.05); padding: 4px 12px; border-radius: 12px;">${parsedText}</span></div>`;
            }
         } else {
            // 正常的聊天气泡
            rowClass = isMe ? 'sms-bubble-row sent' : 'sms-bubble-row received';
            // ▼▼▼ 新增：拆解魔法分隔符，渲染精美翻译副标题 ▼▼▼
            let finalHtml = '';
            if (text.includes('<||>')) {
                const parts = text.split('<||>');
                const mainText = escapeHTML(parts[0]);
                const transText = escapeHTML(parts[1]);
                
                // 智能变色：自己的气泡翻译字用半透明白，对方的气泡翻译字用灰色，浑然一体
                const transColor = isMe ? 'rgba(255,255,255,0.75)' : '#888';
                const transBorder = isMe ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.08)';
                
                finalHtml = `${mainText}<div class="sms-translation" style="margin-top: 6px; padding-top: 6px; border-top: 1px solid ${transBorder}; font-size: 12px; color: ${transColor}; line-height: 1.4;">${transText}</div>`;
            } else {
                finalHtml = escapeHTML(text).replace(/\n/g, '<br>');
            }
            // ▲▲▲ 新增结束 ▲▲▲
            
            if (isRejected) {
                bubbleHtml = `
                <div class="sms-bubble-row sent sms-msg-item" ${msgId ? `data-msg-id="${msgId}"` : ''} style="margin-bottom: 8px; transition: 0.2s; cursor: pointer;">
                    <div style="display: flex; align-items: center; justify-content: flex-end; gap: 8px;">
                        <svg viewBox="0 0 24 24" style="width: 22px; height: 22px; flex-shrink: 0; cursor: pointer;" onclick="alert('对方已将该号码拉黑，消息被拒收')">
                            <circle cx="12" cy="12" r="10" fill="#ff3b30"></circle>
                            <line x1="12" y1="7" x2="12" y2="14" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"></line>
                            <circle cx="12" cy="17" r="1.25" fill="#ffffff"></circle>
                        </svg>
                        <div class="bubble" style="background: #000; color: #fff; border-bottom-right-radius: 4px; padding: 10px 14px; border-radius: 18px; max-width: 75%; font-size: 15px; opacity: 0.6;">${finalHtml}</div>
                    </div>
                    <div style="font-size: 11px; color: #ff3b30; text-align: right; margin-top: 4px;">消息已发出，但被对方拒收了</div>
                </div>`;
            } else {
                bubbleHtml = `
                <div class="${rowClass} sms-msg-item" ${msgId ? `data-msg-id="${msgId}"` : ''} style="transition: 0.2s; cursor: pointer;">
                    <div class="bubble">${finalHtml}</div>
                </div>`;
            }
        }
        chatContent.insertAdjacentHTML('beforeend', bubbleHtml);
        const newBubble = chatContent.lastElementChild;
       // 绑定草稿点击便签事件
        if (isMe === 'system') {
            const draftBtn = newBubble.querySelector('.sms-draft-btn');
            if (draftBtn) {
                addTapListener(draftBtn, (e) => {
                   e.stopPropagation();
                    const draftText = draftBtn.getAttribute('data-draft');
                    const note = document.createElement('div');
                    note.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%, -50%) scale(0.8); opacity:0; transition:all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); background: rgba(250, 250, 250, 0.85); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); padding:24px 28px; border-radius:18px; box-shadow: 0 20px 40px rgba(0,0,0,0.1), 0 1px 3px rgba(0,0,0,0.05); border: 1px solid rgba(255,255,255,0.6); z-index:10000; min-width:240px; max-width:75%; text-align:center;';
                    note.innerHTML = `<div style="font-size:11px; color:#8e8e93; text-transform:uppercase; letter-spacing:1px; margin-bottom:12px; font-family:-apple-system, sans-serif; font-weight:600;">— Draft —</div><div style="font-size:16px; line-height:1.6; color:#1c1c1e; font-family:-apple-system, BlinkMacSystemFont, sans-serif; word-wrap:break-word;">${draftText}</div>`;
                    document.body.appendChild(note);
                    
                    // 触发弹性弹出动画
                    setTimeout(() => {
                        note.style.opacity = '1';
                        note.style.transform = 'translate(-50%, -50%) scale(1)';
                    }, 10);
                    
                    const closeNote = () => { 
                        note.style.opacity = '0';
                        note.style.transform = 'translate(-50%, -50%) scale(0.8)';
                        setTimeout(() => note.remove(), 300); 
                        document.removeEventListener('click', closeNote); 
                        document.removeEventListener('touchstart', closeNote); 
                    };
                    setTimeout(() => { document.addEventListener('click', closeNote); document.addEventListener('touchstart', closeNote); }, 200);
                });
            }
        }
          // 绑定点击事件，用于多选删除模式（如果是系统旁白，则彻底屏蔽菜单和点击！）
        if (msgId && isMe !== 'system') {
            // ▼▼▼ 新增：长按触发操作菜单 ▼▼▼
            let pressTimer = null;
            let startX, startY;
            let isLongPressed = false; // 新增标记
            newBubble.addEventListener('touchstart', (e) => {
                if (this.isMultiSelectMode) return;
                isLongPressed = false; // 每次触摸重置
                startX = e.touches ? e.touches[0].clientX : e.clientX;
                startY = e.touches ? e.touches[0].clientY : e.clientY;
                pressTimer = setTimeout(() => {
                    pressTimer = null;
                    isLongPressed = true; // 标记已长按
                    this.showSmsActionPopover(newBubble, msgId, text);
                }, 500);
            }, { passive: true });
            
            newBubble.addEventListener('touchmove', (e) => {
                if (pressTimer) {
                    const cx = e.touches ? e.touches[0].clientX : e.clientX;
                    const cy = e.touches ? e.touches[0].clientY : e.clientY;
                    if (Math.abs(cx - startX) > 10 || Math.abs(cy - startY) > 10) {
                        clearTimeout(pressTimer);
                        pressTimer = null;
                    }
                }
            }, { passive: true });
            
            const clearTimer = (e) => { 
                if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } 
                // 如果已经触发长按，强行拦截抬手动作带来的默认点击
                if (isLongPressed && e && e.cancelable) { e.preventDefault(); e.stopPropagation(); }
            };
            newBubble.addEventListener('touchend', clearTimer, { passive: false });
            newBubble.addEventListener('touchcancel', clearTimer, { passive: false });
            // ▲▲▲ 新增结束 ▲▲▲
        } // <--- 将原来的右大括号提前到这里，结束对菜单长按的判断限制

        // ▼▼▼ 修改：只要有 msgId（包含系统消息），就允许绑定多选点击事件 ▼▼▼
        if (msgId) {
            // ▼▼▼ 替换为 addTapListener 彻底解决苹果手机卡顿和无法点击的问题 ▼▼▼
            addTapListener(newBubble, () => {
                if (!this.isMultiSelectMode) return;
                if (this.selectedSmsIds.has(msgId)) {
                    this.selectedSmsIds.delete(msgId);
                    newBubble.style.opacity = '1';
                    newBubble.style.transform = 'scale(1)';
                    newBubble.style.outline = 'none';
                } else {
                    this.selectedSmsIds.add(msgId);
                    newBubble.style.opacity = '0.6';
                    newBubble.style.transform = 'scale(0.95)';
                    newBubble.style.outline = '2px solid #ff3b30';
                    newBubble.style.borderRadius = '10px';
                }
                document.getElementById('sms-selected-count').textContent = `已选择 ${this.selectedSmsIds.size} 项`;
            });
        }
        
        if (!targetContainer) {
            chatContent.scrollTop = chatContent.scrollHeight;
            const appContent = chatContent.closest('.app-content');
            if (appContent) appContent.scrollTop = appContent.scrollHeight;
        }
    },
    // ▼▼▼ 新增：开关多选模式 ▼▼▼
    toggleMultiSelectMode(enable) {
        this.isMultiSelectMode = enable;
        this.selectedSmsIds.clear();
        const deleteBar = document.getElementById('sms-multi-delete-bar');
        const inputArea = document.querySelector('.sms-input-area');
        // 将系统消息的 div 也包含进来一起进行样式清理
        const allBubbles = document.querySelectorAll('.sms-msg-item, #sms-chat-content > div');
        const chatContent = document.getElementById('sms-chat-content'); // 1. 获取聊天列表容器
        if (enable) {
            deleteBar.style.display = 'flex';
            inputArea.style.display = 'none';
            document.getElementById('sms-selected-count').textContent = `已选择 0 项`;
            // 2. 性能无感优化：进入多选时垫高底部，防止绝对定位的删除条遮挡最后一条消息
            if (chatContent) chatContent.style.paddingBottom = '80px'; 
        } else {
            deleteBar.style.display = 'none';
            inputArea.style.display = 'block';
               // 3. 退出多选时，清除垫高，恢复原样
            if (chatContent) chatContent.style.paddingBottom = ''; 
            // 恢复所有气泡正常状态
            allBubbles.forEach(b => {
                b.style.opacity = '1';
                b.style.transform = 'scale(1)';
                b.style.outline = 'none';
                b.style.borderRadius = ''; // 新增：把选中时额外增加的圆角也恢复原样
            });
        }
    },
    // ▼▼▼ 新增：执行批量删除 ▼▼▼
    async deleteSelectedSms() {
        if (this.selectedSmsIds.size === 0) return;
        if (!confirm(`确定要删除选中的 ${this.selectedSmsIds.size} 条短信吗？`)) return;

        try {
            const idsToDelete = Array.from(this.selectedSmsIds).map(id => Number(id));
            await db.smsMessages.bulkDelete(idsToDelete);
            
            // 退出多选模式并重新加载页面
            this.toggleMultiSelectMode(false);
            this.loadSmsHistory(tempState.currentSmsCharId);
            
            if (typeof showDynamicIsland === 'function') {
                showDynamicIsland('删除成功', 'success');
            } else {
                alert('删除成功');
            }
        } catch (e) {
            console.error('删除短信失败:', e);
            alert('删除失败');
        }
    },
     // ▼▼▼ 新增：处理发送逻辑的函数 (带动画与拦截) ▼▼▼
    // 【修改】增加 onlyDisplay 开关，控制是否只在屏幕上显示而不发给 AI
    async handleSendSms(forceText = null, onlyDisplay = false) {
        if (this.isSending) return; // 新增：如果正在发送中，拦截一切光速连击
        this.isSending = true;      // 新增：把门锁上

        const input = document.getElementById('sms-chat-input');
        const text = forceText !== null ? forceText : (input ? input.value.trim() : '');
        const charId = tempState.currentSmsCharId;
        
        if (!charId) {
            this.isSending = false; 
            return;
        }
        // ▼▼▼ 新增：底层绝对拦截，被拉黑状态下彻底阻断短信收发 ▼▼▼
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (char && char.isSmsBlocked) {
            this.isSending = false; // 记得把发送锁解开，防止卡死
            if (typeof showDynamicIsland === 'function') {
                showDynamicIsland('已拉黑该联系人，无法收发短信', 'warning');
            } else {
                alert('已拉黑该联系人，无法收发短信');
            }
            return; // 核心！直接退出函数，绝对不执行后续的存数据库和呼叫AI逻辑！
        }
        // ▲▲▲ 新增结束 ▲▲▲
        // ▼▼▼ 新增：判断当前使用的号码是否被角色自主拉黑 ▼▼▼
        const currentNumber = tempState.isSmsAnonymous ? tempState.anonymousNumber : '主号';
        if (char && char.blockedByAiNumbers && char.blockedByAiNumbers.includes(currentNumber)) {
            this.isSending = false; // 解除发送锁
            if (input) input.value = ''; // 清空输入框
            
            if (text) {
                // 存入数据库，并加上被拒收的印记
                const rejectedMsgId = await db.smsMessages.add({ chatId: charId, timestamp: new Date(), sender: 'user', text: text, isRejected: true });
                // 调用气泡绘制函数，告诉它这是被拒收的消息
                this.appendSmsBubble(text, true, rejectedMsgId, null, true);
            }
            
            if (typeof showDynamicIsland === 'function') showDynamicIsland('消息被拒收', 'error');
            return; // 核心：彻底中断后续逻辑
        }
        // ▲▲▲ 新增结束 ▲▲▲
        // 【核心修复】：只要是自己打的字（不是重发），就清空输入框、存数据库并画出气泡
        if (forceText === null && text) {
            input.value = '';
            await db.smsMessages.add({ chatId: charId, timestamp: new Date(), sender: 'user', text: text });
            const newMsg = await db.smsMessages.where({ chatId: charId }).last();
            this.appendSmsBubble(text, true, newMsg ? newMsg.id : null);
        }

        // 如果是按回车触发的，只负责把字挂到屏幕上，立刻开门并退出，绝不打扰AI！
        if (onlyDisplay) {
            this.isSending = false;
            return;
        }

        // 1. 抓取按钮元素，进入加载状态 (无论是刚输入完点发送，还是空框点发送，还是重试，都会走这里呼叫AI)
        const sendIcon = document.getElementById('sms-send-icon');
        const loadingIcon = document.getElementById('sms-loading-icon');
        const retryBtn = document.getElementById('sms-retry-btn');
        if (sendIcon) sendIcon.style.display = 'none';
        if (loadingIcon) loadingIcon.style.display = 'block';
        if (retryBtn) { retryBtn.style.opacity = '0.5'; retryBtn.style.pointerEvents = 'none'; }
        // 2. 显示三个点跳动的“正在输入”动画气泡
        const chatContent = document.getElementById('sms-chat-content');
        const loadingId = 'sms-loading-' + Date.now();
        if (chatContent) {
            chatContent.insertAdjacentHTML('beforeend', `<div id="${loadingId}" class="sms-bubble-row received"><div class="bubble typing-indicator"><span></span><span></span><span></span></div></div>`);
            chatContent.scrollTop = chatContent.scrollHeight;
        }
        try { // ▼▼▼ 用 try 包裹核心请求区，防止网络错误导致崩溃死锁 ▼▼▼
            // 3. 呼叫大模型（现在返回的是数组了）
            const { sendSmsMessageToAI } = await import('./chat-service.js');
            const replyArray = await sendSmsMessageToAI(charId, text);
            // 4. 大模型回话了，把“正在输入”的跳动气泡删掉
            const loadingEl = document.getElementById(loadingId);
            if (loadingEl) loadingEl.remove();

            // 5. 分句画出 AI 的话
            if (replyArray && replyArray.length > 0) {
                // ▼▼▼ 新增：从数据库中捞出刚刚存入的 AI 消息，获取真实 ID ▼▼▼
                const recentMsgs = await db.smsMessages.where({ chatId: charId }).reverse().sortBy('timestamp');
                const aiMsgs = recentMsgs.slice(0, replyArray.length).reverse();
                 for (let i = 0; i < replyArray.length; i++) {
                    const realId = aiMsgs[i] ? aiMsgs[i].id : null;
                    // 把真实 ID (realId) 传进去，这样新生成的消息也能被选中了
                    this.appendSmsBubble(replyArray[i], false, realId);
                    
                    // ▼▼▼ 新增：判断如果用户没停留在短信页面，则弹出消息横幅 ▼▼▼
                    const smsPage = document.getElementById('page-sms-detail');
                    if (!smsPage || window.getComputedStyle(smsPage).display === 'none') {
                        if (typeof notification !== 'undefined' && notification.show) {
                            notification.show('短信', replyArray[i], null, 'page-sms-detail', charId);
                        }
                    }
                    // ▲▲▲ 新增结束 ▲▲▲

                    // 停顿0.8秒再发下一句，模拟真实打字感
                    if (i < replyArray.length - 1) {
                        await new Promise(r => setTimeout(r, 800));
                    }
                }
                // ▲▲▲ 修改结束 ▲▲▲
            } else {
                this.appendSmsBubble("[发送失败，请检查网络或配置]", false);
            }
        } catch (error) {
            // 如果报错了（比如断网），也要把动画删掉，给个错误提示
            const loadingEl = document.getElementById(loadingId);
            if (loadingEl) loadingEl.remove();
            this.appendSmsBubble("[网络连接异常，发送失败]", false);
            console.error("短信发送异常:", error);
        } finally { // ▼▼▼ finally：无论成功还是报错，必定会执行这里的代码，保证锁一定会被解开 ▼▼▼
            // 6. 恢复按钮状态
            if (sendIcon) sendIcon.style.display = 'block';
            if (loadingIcon) loadingIcon.style.display = 'none';
            if (retryBtn) { retryBtn.style.opacity = '1'; retryBtn.style.pointerEvents = 'auto'; }
            
            this.isSending = false; // 发送流程全部走完，重新把门打开，允许下一次发送
            
            // 刷新一次屏幕，把后端偷偷生成的任何系统胶囊（比如【拉黑了该号码】）立刻画到屏幕上
            if (charId) this.loadSmsHistory(charId);
        }
    },
    // ▼▼▼ 新增：重回逻辑 (删除上一句AI的，重新生成) ▼▼▼
    async handleRetrySms() {
        if (this.isSending) return; // 1. 检查门是不是锁着
        this.isSending = true;      // 2. 【关键修复】刚进门，立刻把门反锁！坚决不给连击留出任何时间差！

        try {
            const charId = tempState.currentSmsCharId;
            if (!charId) {
                this.isSending = false; // 空手而归时别忘了开门
                return;
            }

            // 获取当前角色的所有短信
            const history = await db.smsMessages.where({ chatId: charId }).sortBy('timestamp');
            if (history.length === 0) {
                this.isSending = false;
                return;
            }
            // 找到上一句应该重发的话
            let textToResend = "RETRY_SIGNAL"; // 【修改】不再提取用户的话，直接给个安全指令即可
            
            // 倒序检查：如果最后一条是 AI 发的，把最近一次连续发的所有 AI 消息全删了
            let i = history.length - 1;
            while (i >= 0 && history[i].sender === 'character') {
                const msgId = history[i].id;
                await db.smsMessages.delete(msgId);
                // ▼▼▼ 性能优化：直接摘除废弃的 DOM 节点，禁止整页重刷引发卡死 ▼▼▼
                const bubbleEl = document.querySelector(`.sms-msg-item[data-msg-id="${msgId}"]`);
                if (bubbleEl) bubbleEl.remove();
                // ▲▲▲ 优化结束 ▲▲▲
                i--;
            }
            
            // 【重要说明】：我们已完全删除去触碰 user 消息的代码！你的记录绝对安全，且绝不再生出复本！

            // 3. 【关键交接】因为接下来的 handleSendSms 内部第一行也会检查这把锁，
            // 所以我们在转交控制权之前，必须先把这里的锁打开。
            this.isSending = false; 
            // 延迟一点点等页面重绘完毕，触发静默发送
            setTimeout(() => {
                this.handleSendSms(textToResend);
            }, 100);

        } catch (error) {
            console.error("重发短信时出错:", error);
            this.isSending = false; // 发生任何意外，务必保证把门打开
        }
    },

    // ▼▼▼ 新增：短信气泡操作菜单 ▼▼▼
    showSmsActionPopover(targetElement, msgId, currentText) {
        let oldPopover = document.getElementById('sms-temp-popover');
        if (oldPopover) oldPopover.remove();

        const popover = document.createElement('div');
        popover.id = 'sms-temp-popover';
        popover.className = 'message-action-popover';
        popover.innerHTML = `
            <div class="popover-button" id="sms-btn-copy">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                <span>复制</span>
            </div>
            <div class="popover-divider"></div>
            <div class="popover-button" id="sms-btn-edit">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
                <span>编辑</span>
            </div>
        `;
        document.body.appendChild(popover);

        // ▼▼▼ 修改：精确获取气泡主体位置，让菜单智能贴合 ▼▼▼
        const bubbleNode = targetElement.querySelector('.bubble') || targetElement;
        const rect = bubbleNode.getBoundingClientRect();
        const popoverRect = popover.getBoundingClientRect();
        
        // 让菜单居中对齐当前气泡的横向中心点
        let left = rect.left + (rect.width / 2) - (popoverRect.width / 2); 
        // 默认显示在气泡正上方
        let top = rect.top - popoverRect.height - 10;
        
        // 屏幕边界防溢出处理
        if (left < 10) left = 10;
        if (left + popoverRect.width > window.innerWidth - 10) {
            left = window.innerWidth - 10 - popoverRect.width;
        }
        
        // 如果气泡太靠上，把菜单翻转到气泡下方
        if (top < 10) {
            top = rect.bottom + 10;
            popover.classList.add('popover-place-below');
        }
        
        popover.style.position = 'fixed'; // 强制绝对屏幕定位防抖动
        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
        popover.style.zIndex = '3000';
        // ▲▲▲ 修改计算逻辑结束 ▲▲▲

        setTimeout(() => popover.classList.add('visible'), 10);
        
        // 专门用来彻底销毁菜单的函数
        const destroyPopover = () => {
            popover.classList.remove('visible');
            setTimeout(() => popover.remove(), 200);
            document.removeEventListener('click', handleOutsideClick, { capture: true });
            document.removeEventListener('touchstart', handleOutsideClick, { capture: true });
        };

        const handleOutsideClick = (e) => {
            // 如果点到的是菜单自己内部的按钮，由按钮各自的事件去处理，全局监听不要瞎插手
            if (e && popover.contains(e.target)) return;
            
            // 【核心修复】苹果设备长按松手时，会附带产生一个点击事件，目标就是气泡本身。直接拦截无视，防止菜单刚弹出来就被秒关！
            if (e && targetElement.contains(e.target)) return;
            
            // 点了真正外部的其他地方，销毁菜单
            destroyPopover();
        };

        // 延迟 150 毫秒才开始监听点击外部关闭
        setTimeout(() => {
            document.addEventListener('click', handleOutsideClick, { capture: true });
            document.addEventListener('touchstart', handleOutsideClick, { capture: true });
        }, 150);

        // ▼▼▼ 修改：完美无感复制，彻底解决苹果手机弹键盘和卡顿 ▼▼▼
        popover.querySelector('#sms-btn-copy').addEventListener('click', async () => {
            try {
                // 首选现代极速复制方法，完全不会弹键盘
                if (navigator.clipboard && window.isSecureContext) {
                    await navigator.clipboard.writeText(currentText);
                } else {
                    // 备用方案：防止苹果系统自作多情弹键盘
                    const textarea = document.createElement('textarea');
                    textarea.value = currentText;
                    textarea.setAttribute('readonly', ''); // 关键：设为只读，绝对不弹键盘
                    textarea.style.position = 'absolute';
                    textarea.style.left = '-9999px';
                    document.body.appendChild(textarea);
                    textarea.select();
                    textarea.setSelectionRange(0, 99999); // 适配苹果专用选中命令
                    document.execCommand('copy');
                    textarea.remove();
                }
            } catch (err) {
                console.error("复制失败:", err);
            }
            
            // 复制完成后，主动收起菜单
            destroyPopover();

            if (typeof showDynamicIsland === 'function') {
                showDynamicIsland('已复制', 'success');
            } else {
                alert('已复制');
            }
        });
        // ▲▲▲ 修改结束 ▲▲▲

        popover.querySelector('#sms-btn-edit').addEventListener('click', () => {
            // 【新增】进入编辑前，主动收起菜单
            destroyPopover();
            
            const smsEditModal = document.getElementById('sms-edit-modal');
            if (smsEditModal) {
                document.getElementById('sms-edit-message-id').value = msgId;
                document.getElementById('sms-edit-message-content').value = currentText;
                smsEditModal.classList.add('visible');
            }
        });
    }
    // ▲▲▲ 新增结束 ▲▲▲
};