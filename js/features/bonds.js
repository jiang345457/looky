import { AppState, tempState, db, focusState, getWorldBookForPrompt } from '../state.js';
import { showDynamicIsland, showPage } from '../ui.js';

export const Bonds = {
    currentCharId: null,
    focus: {
        timer: null,
        timeLeft: 0,
        totalTime: 0,
        isFocusing: false,
        bubbleTimer: null
    },

    init() {
        this.bindGlobalEvents();
        this.initCharSwitcher();
        this.initFocusRoom();
        this.initBurnRoom();
        this.initTouchMode();
        this.initQuizMode();
    },
    // 绑定全局返回事件
    bindGlobalEvents() {
        // 锁定新按钮和自定义弹窗
        const specialBackBtn = document.getElementById('focus-special-back-btn');
        const giveupModal = document.getElementById('focus-giveup-modal');
        const cancelGiveupBtn = document.getElementById('focus-giveup-cancel');
        const confirmGiveupBtn = document.getElementById('focus-giveup-confirm');

        if (specialBackBtn && giveupModal) {
            // 封装一个唯一的返回逻辑
            const handleBack = (e) => {
                e.preventDefault(); 
                e.stopPropagation();
                
                if (this.focus.isFocusing) {
                    // 如果正在专注，显示高级自定义弹窗，取消系统原生 confirm
                    giveupModal.style.display = 'flex';
                    setTimeout(() => giveupModal.style.opacity = '1', 10);
                } else {
                    showPage('page-bonds'); // 没在专注直接返回
                }
            };

            // 绑定弹窗的【取消】逻辑
            cancelGiveupBtn.onclick = () => {
                giveupModal.style.opacity = '0';
                setTimeout(() => giveupModal.style.display = 'none', 300);
            };

            // 绑定弹窗的【狠心退出】逻辑
            confirmGiveupBtn.onclick = () => {
                giveupModal.style.opacity = '0';
                setTimeout(() => giveupModal.style.display = 'none', 300);
                this.endFocus(false);
                showPage('page-bonds'); // 结束专注并直接切出页面
            };

            specialBackBtn.addEventListener('click', handleBack);
            specialBackBtn.addEventListener('touchend', handleBack);
        }
    },
    // --- 角色切换器逻辑 ---
    initCharSwitcher() {
        const switchBtn = document.getElementById('bonds-char-switch-btn');
        const modal = document.getElementById('bonds-char-select-modal');
         const list = document.getElementById('bonds-char-list');
        const closeBtn = document.getElementById('close-bonds-char-btn');
        // 初始化默认角色 (过滤掉群聊)
        const availableChars = AppState.characterProfiles.filter(c => !c.isGroup);
        if (availableChars.length > 0) {
            this.setChar(availableChars[0].id);
        }
        switchBtn?.addEventListener('click', () => {
            if (this.focus.isFocusing) {
                showDynamicIsland('专注期间无法切换角色', 'warning');
                return;
            }
            list.innerHTML = '';
            AppState.characterProfiles.filter(c => !c.isGroup).forEach(char => {
                const item = document.createElement('div');
                item.style.cssText = 'display: flex; align-items: center; gap: 10px; padding: 10px; background: #f9f9f9; border-radius: 12px; cursor: pointer;';
                item.innerHTML = `<img src="${char.avatar || 'images/default-avatar.svg'}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;"> <span style="font-size:14px;font-weight:600;">${char.name}</span>`;
                item.onclick = () => {
                    this.setChar(char.id);
                    modal.style.opacity = '0';
                    setTimeout(() => modal.style.display = 'none', 300);
                };
                list.appendChild(item);
            });
            modal.style.display = 'flex';
            setTimeout(() => modal.style.opacity = '1', 10);
        });

        closeBtn?.addEventListener('click', () => {
            modal.style.opacity = '0';
            setTimeout(() => modal.style.display = 'none', 300);
        });
    },
    setChar(charId) {
        this.currentCharId = charId;
       const char = AppState.characterProfiles.find(c => c.id === charId);
        if (!char || char.isGroup) return;
        const avatarSrc = char.avatar || 'images/default-avatar.svg';
        document.getElementById('bonds-current-avatar').src = avatarSrc;
        document.getElementById('bonds-current-name').textContent = char.name;
        
        // [新增] 更新羁绊主页正中央的大头像
        const mainHeroAvatar = document.getElementById('bonds-main-hero-avatar');
        if(mainHeroAvatar) mainHeroAvatar.src = avatarSrc;
        // 更新子页面头像
        const focusAvatar = document.getElementById('focus-char-avatar');
        if(focusAvatar) focusAvatar.src = avatarSrc;
        const touchAvatar = document.getElementById('touch-char-avatar');
        if(touchAvatar) touchAvatar.src = avatarSrc;
        // ▼▼▼ 新增：同步记忆随堂考的头像 ▼▼▼
        const quizAvatar = document.getElementById('quiz-char-avatar');
        if(quizAvatar) quizAvatar.src = avatarSrc;
      // ▼▼▼ 修复：切换角色时彻底重置随堂考状态 ▼▼▼
        const quizIdle = document.getElementById('quiz-state-idle');
        if (quizIdle) {
            ['idle', 'loading', 'answering', 'result'].forEach(s => {
                const el = document.getElementById(`quiz-state-${s}`);
                if (el) el.style.display = s === 'idle' ? 'flex' : 'none';
            });
            const pBoard = document.getElementById('quiz-progress-board');
            if(pBoard) pBoard.style.opacity = '0';
            const stamp = document.getElementById('quiz-stamp');
            if(stamp) stamp.style.display = 'none';
            const bubble = document.getElementById('quiz-bubble');
            if(bubble) bubble.style.opacity = '0';
            const container = document.querySelector('.quiz-immersive-container');
            if(container) { container.classList.remove('is-answering'); container.classList.remove('is-result'); }
            this.quizHasNewResult = false; // 清空结果标记
            this.quizResultText = ""; 
            this.quizShortText = ""; 
        }
        // ▲▲▲ 修复结束 ▲▲▲
        // ▼▼▼ 修复：每次切换角色时，全局拉取属于“用户自己”的工作日程 ▼▼▼
        this.updateFocusSchedules();
        // ▲▲▲ 修复结束 ▲▲▲
        
        // ▼▼▼ 修复：每次切换角色，加载该角色专属的番茄钟设置 ▼▼▼
        this.loadFocusSettings(charId);
        // ▲▲▲ 修复结束 ▲▲▲
        // ▼▼▼ 新增：每次切换角色，加载该角色专属的贴贴设置 ▼▼▼
        this.loadTouchSettings(charId);
        // ▲▲▲ 新增结束 ▲▲▲
        // ▼▼▼ 新增：启动贴贴页面的照片轮播与感应区渲染 ▼▼▼
        if(typeof this.startTouchBgRotation === 'function') this.startTouchBgRotation(charId);
        // ▲▲▲ 新增结束 ▲▲▲
        // ▼▼▼ 新增：刷新情绪树洞历史 ▼▼▼
        if (this.renderBurnHistory) this.renderBurnHistory();
        // ▲▲▲ 新增结束 ▲▲▲
      // ▼▼▼ 新增：检查网页异常刷新导致的贴贴数据丢失，并自动恢复成卡片 ▼▼▼
        (async () => {
            try {
                const crashRecord = await db.appData.get('touch_crash_recovery_' + charId);
                if (crashRecord && crashRecord.value && crashRecord.value.length > 0) {
                    const savedInteractions = crashRecord.value;
                    const actionSummary = savedInteractions.join('\n');
                    const isOfflineNow = tempState.activeOfflineSession === charId;
                    const memoryPrompt = isOfflineNow 
                        ? `[系统隐式提示：刚才你和用户在现实中依偎在一起，进行了亲密的身体触碰，但中途被打断了。以下是刚才的互动记录：\n${actionSummary}\n\n【核心指令】：请牢记这些感受。在接下来的对话中自然地顺着往下聊。]`
                        : `[系统隐式提示：刚才你和用户通过契约连接，进行了跨越屏幕的贴贴互动，但中途网络断开了。以下是刚才的记录：\n${actionSummary}\n\n【核心指令】：请牢记这些感受。在接下来的对话中自然地顺着往下聊。]`;
                    
                    const msgId = await db.chatMessages.add({
                        chatId: charId, timestamp: new Date(), 
                        text: memoryPrompt, shortText: `刚刚进行了零距离贴贴互动哦 (异常中断补发)`,  
                        type: 'system', contentType: 'focus_record_card',
                        focusData: { taskName: '零距离贴贴', duration: savedInteractions.length, isSuccess: true, spokenList: savedInteractions, hasTTS: false },
                        uiVisible: true, aiVisible: true, recalled: false
                    });
                    
                    // 补发完毕后，立刻删除备份，防止下次刷新再发
                    await db.appData.delete('touch_crash_recovery_' + charId);
                    
                    // 通知主界面更新UI
                    const newMsg = await db.chatMessages.get(msgId);
                    import('../features/chat-ui.js').then(m => m.createAndAppendMessage && m.createAndAppendMessage(newMsg));
                }
            } catch(e) { console.warn('恢复贴贴断线数据失败', e); }
        })();
        // 清理贴贴互动缓存，防止角色之间数据串台错乱
        this.touchHistory = []; 
        this.currentSessionInteractions = [];
    },
    // ▼▼▼ 修复：全局遍历并关联属于“用户自己”的工作日程 ▼▼▼
    async updateFocusSchedules() {
        const taskSelect = document.getElementById('focus-task-schedule-select');
        if (!taskSelect) return;
        
        const now = new Date();
        const todayStr = now.getDate().toString();
        const currentMins = now.getHours() * 60 + now.getMinutes();
        
        try {
            let allUpcoming = [];
            
            // 遍历所有角色，把存放在各角色时间线里的属于“我”的行程全部抓取出来
            for (const char of AppState.characterProfiles) {
                if (char.isGroup) continue;
                const record = await db.appData.get('ls_schedules_data_' + char.id);
                if (record && record.value) {
                    const upcoming = record.value.filter(s => {
                        // 严格把关：必须是今天、工作，且 owner 必须是 mine (用户自己) 或 joint (共同)
                        if (s.date !== todayStr || s.type !== '工作' || (s.owner !== 'mine' && s.owner !== 'joint')) return false;
                        const [sh, sm] = s.startTime.split(':').map(Number);
                        const [eh, em] = s.endTime.split(':').map(Number);
                        const startMins = sh * 60 + sm;
                        const endMins = eh * 60 + em;
                        // 提前1小时内，或者正在进行中的
                        return (startMins - currentMins <= 60 && currentMins <= endMins);
                    });
                    allUpcoming = allUpcoming.concat(upcoming);
                }
            }

            // 去重，防止同一个“我的”行程在不同角色下重复显示
            const uniqueTasks = [];
            const seen = new Set();
            allUpcoming.forEach(s => {
                const key = s.startTime + '_' + s.endTime + '_' + s.content;
                if (!seen.has(key)) {
                    seen.add(key);
                    uniqueTasks.push(s);
                }
            });
            
            // 按开始时间进行排序，保证下拉框里的日程是有序的
            uniqueTasks.sort((a, b) => a.startTime.localeCompare(b.startTime));

            if (uniqueTasks.length > 0) {
                taskSelect.innerHTML = '<option value="" disabled selected>近期日程...</option>';
                uniqueTasks.forEach(s => {
                    const opt = document.createElement('option');
                    opt.value = s.content;
                    opt.textContent = `${s.startTime} ${s.content}`;
                    // 将时间差存入 dataset 以供后续计算
                    opt.dataset.duration = (s.endTime.split(':')[0]*60 + s.endTime.split(':')[1]*1) - (s.startTime.split(':')[0]*60 + s.startTime.split(':')[1]*1);
                    taskSelect.appendChild(opt);
                });
                taskSelect.style.display = 'block';
            } else {
                taskSelect.style.display = 'none';
            }
        } catch(e) { console.error('专注拉取用户日程失败', e); }
    },
    // ▲▲▲ 修复结束 ▲▲▲
       // ▼▼▼ 修复：读取并绑定角色的专属番茄钟设置 ▼▼▼
    async loadFocusSettings(charId) {
        const ttsInterval = document.getElementById('focus-tts-interval');
        const ttsToggle = document.getElementById('focus-tts-toggle');
        const wbToggle = document.getElementById('focus-wb-toggle');
        const wbSelect = document.getElementById('focus-wb-select');
        const albumBgToggle = document.getElementById('focus-album-bg-toggle');
        
        // ▼▼▼ 新增：获取3个图片相关的DOM ▼▼▼
        const customBgContainer = document.getElementById('focus-custom-bg-container');
        const customBgUploads = [
            document.getElementById('focus-custom-upload-1'),
            document.getElementById('focus-custom-upload-2'),
            document.getElementById('focus-custom-upload-3')
        ];
        const customBgPreviews = [
            document.getElementById('focus-custom-preview-1'),
            document.getElementById('focus-custom-preview-2'),
            document.getElementById('focus-custom-preview-3')
        ];
        const customBgPluses = [
            document.getElementById('focus-custom-plus-1'),
            document.getElementById('focus-custom-plus-2'),
            document.getElementById('focus-custom-plus-3')
        ];
        const customBgUrls = [
            document.getElementById('focus-custom-url-1'),
            document.getElementById('focus-custom-url-2'),
            document.getElementById('focus-custom-url-3')
        ];
        const customBgClears = [
            document.getElementById('focus-custom-clear-1'),
            document.getElementById('focus-custom-clear-2'),
            document.getElementById('focus-custom-clear-3')
        ];
        // 内存中临时存放图片数据
        let customBgData = [null, null, null];
        const customBgIntervalInput = document.getElementById('focus-custom-bg-interval'); // 新增：获取时间输入框
        // ▲▲▲ 新增结束 ▲▲▲

        // 把单选框强行变成多选框
        if (wbSelect) {
            wbSelect.multiple = true; 
            wbSelect.style.height = '100px'; 
        }

        try {
            // 从数据库拉取专属配置
            const record = await db.appData.get('focus_settings_' + charId);
            const settings = record ? record.value : { interval: 10, tts: false, useAllWb: true, specificWbs: [], useAlbumBg: false, customBgs: [null, null, null], customBgInterval: 5 };

            if (ttsInterval) ttsInterval.value = settings.interval || 10;
            if (ttsToggle) ttsToggle.checked = !!settings.tts;
            if (wbToggle) wbToggle.checked = !!settings.useAllWb;
            if (albumBgToggle) albumBgToggle.checked = !!settings.useAlbumBg;
            if (customBgIntervalInput) customBgIntervalInput.value = settings.customBgInterval || 5;

            // 挂载到全局，供后面的轮播功能读取
            this.customBgsCache = settings.customBgs || [null, null, null];
            
            // ▼▼▼ 新增：初始化显示逻辑和图片数据 ▼▼▼
            if (customBgContainer) {
                customBgContainer.style.display = settings.useAlbumBg ? 'none' : 'block';
            }

            customBgData = settings.customBgs || [null, null, null];

            const updatePreviewUI = (index, dataStr) => {
                customBgData[index] = dataStr;
                if(dataStr) {
                    if(customBgPreviews[index]) { customBgPreviews[index].src = dataStr; customBgPreviews[index].style.display = 'block'; }
                    if(customBgPluses[index]) customBgPluses[index].style.display = 'none';
                    if(customBgClears[index]) customBgClears[index].style.display = 'block';
                    if(customBgUrls[index]) customBgUrls[index].style.display = 'none';
                } else {
                    if(customBgPreviews[index]) customBgPreviews[index].style.display = 'none';
                    if(customBgPluses[index]) customBgPluses[index].style.display = 'block';
                    if(customBgClears[index]) customBgClears[index].style.display = 'none';
                    if(customBgUrls[index]) customBgUrls[index].style.display = 'block';
                }
            };

            // 渲染 3 张预览图
            for(let i=0; i<3; i++) { updatePreviewUI(i, customBgData[i]); }
            // ▲▲▲ 新增结束 ▲▲▲

            // 绑定自动保存事件
            const saveSettings = async () => {
                if (!this.currentCharId) return;
                const specificWbs = wbSelect ? Array.from(wbSelect.selectedOptions).map(o => o.value) : [];
                await db.appData.put({
                     key: 'focus_settings_' + this.currentCharId, 
                    value: {
                        interval: ttsInterval ? ttsInterval.value : 10,
                        tts: ttsToggle ? ttsToggle.checked : false,
                        useAllWb: wbToggle ? wbToggle.checked : true,
                        useAlbumBg: albumBgToggle ? albumBgToggle.checked : false,
                        specificWbs: specificWbs,
                        customBgs: customBgData, // 将图片数组存入数据库
                        customBgInterval: customBgIntervalInput ? parseInt(customBgIntervalInput.value) || 5 : 5
                    }
                });
            };

            if (customBgIntervalInput) customBgIntervalInput.onchange = saveSettings;

            // ▼▼▼ 新增：绑定图片相关的交互事件 ▼▼▼
            if (albumBgToggle) {
                albumBgToggle.onchange = () => {
                    if (customBgContainer) customBgContainer.style.display = albumBgToggle.checked ? 'none' : 'block';
                    saveSettings();
                };
            }

            for (let i = 0; i < 3; i++) {
                // 本地上传
                if (customBgUploads[i]) {
                    customBgUploads[i].onchange = (e) => {
                        const file = e.target.files[0];
                        if (file) {
                            const reader = new FileReader();
                            reader.onload = (ev) => {
                                updatePreviewUI(i, ev.target.result);
                                saveSettings();
                            };
                            reader.readAsDataURL(file);
                        }
                    };
                }
                // 链接上传
                if (customBgUrls[i]) {
                    customBgUrls[i].onclick = () => {
                        const url = prompt('请输入图片或动图的直连地址 (URL):');
                        if (url && url.trim()) {
                            updatePreviewUI(i, url.trim());
                            saveSettings();
                        }
                    };
                }
                // 清除按钮
                if (customBgClears[i]) {
                    customBgClears[i].onclick = () => {
                        if (customBgUploads[i]) customBgUploads[i].value = '';
                        updatePreviewUI(i, null);
                        saveSettings();
                    };
                }
            }
            // ▲▲▲ 新增结束 ▲▲▲
            // 已修复：改为直接覆盖绑定，防止闭包导致角色数据串乱
            if (albumBgToggle) albumBgToggle.onchange = saveSettings;
            if (ttsInterval) ttsInterval.onchange = saveSettings;
            if (ttsToggle) ttsToggle.onchange = saveSettings;
            if (wbToggle) wbToggle.onchange = saveSettings;
            if (wbSelect) wbSelect.onchange = saveSettings;
            
        } catch (e) { console.error("读取专属设置失败", e); }
    },
        // ▼▼▼ 新增：读取并绑定角色的专属贴贴(Touch)设置 ▼▼▼
     async loadTouchSettings(charId) {
        const ttsToggle = document.getElementById('touch-tts-toggle');
        const wbToggle = document.getElementById('touch-wb-toggle');
        const wbSelect = document.getElementById('touch-wb-select');
        const albumBgToggle = document.getElementById('touch-album-bg-toggle');
        
        const customBgContainer = document.getElementById('touch-custom-bg-container');
        const customBgUploads = [
            document.getElementById('touch-custom-upload-1'),
            document.getElementById('touch-custom-upload-2'),
            document.getElementById('touch-custom-upload-3')
        ];
        const customBgPreviews = [
            document.getElementById('touch-custom-preview-1'),
            document.getElementById('touch-custom-preview-2'),
            document.getElementById('touch-custom-preview-3')
        ];
        const customBgPluses = [
            document.getElementById('touch-custom-plus-1'),
            document.getElementById('touch-custom-plus-2'),
            document.getElementById('touch-custom-plus-3')
        ];
        const customBgUrls = [
            document.getElementById('touch-custom-url-1'),
            document.getElementById('touch-custom-url-2'),
            document.getElementById('touch-custom-url-3')
        ];
        const customBgClears = [
            document.getElementById('touch-custom-clear-1'),
            document.getElementById('touch-custom-clear-2'),
            document.getElementById('touch-custom-clear-3')
        ];
        
        // 新增的画框按钮
        const customBgZonesBtn = [
            document.getElementById('touch-custom-zone-1'),
            document.getElementById('touch-custom-zone-2'),
            document.getElementById('touch-custom-zone-3')
        ];
        let customBgData = [null, null, null];
         let customBgZonesData = [[], [], []]; // 存放三个图片的感应区坐标
        const customBgIntervalInput = document.getElementById('touch-custom-bg-interval');
        const aiIntervalInput = document.getElementById('touch-ai-interval');

        
        // ▼▼▼ 新增：手势词输入框获取 ▼▼▼
        const gestureDoubleInput = document.getElementById('touch-gesture-double');
        const gestureLongInput = document.getElementById('touch-gesture-long');
        const gestureSwipeInput = document.getElementById('touch-gesture-swipe');
        // ▲▲▲ 新增结束 ▲▲▲
       if (wbSelect) {
            wbSelect.multiple = true; 
            wbSelect.style.height = '100px'; 
        }
     try {
            const record = await db.appData.get('touch_settings_' + charId);
            const settings = record ? record.value : { 
                tts: false, useAllWb: true, specificWbs: [], useAlbumBg: false, customBgs: [null, null, null], customBgInterval: 5, touchZones: [[],[],[]], contextSize: 5,
                gestureDouble: '（有些惊讶地看着你）怎么啦？',
                gestureLong: '（舒服地蹭了蹭）嗯...',
                gestureSwipe: '（温柔地看着你）真乖。'
            };
            if (ttsToggle) ttsToggle.checked = !!settings.tts;
            if (wbToggle) {
                wbToggle.checked = !!settings.useAllWb;
                const wbContainer = document.getElementById('touch-wb-select-container');
                if (wbContainer) wbContainer.style.display = settings.useAllWb ? 'none' : 'flex';
            }
            if (albumBgToggle) albumBgToggle.checked = !!settings.useAlbumBg;
            if (customBgIntervalInput) customBgIntervalInput.value = settings.customBgInterval || 5;
            if (aiIntervalInput) aiIntervalInput.value = settings.aiInterval || 5;
        
            
            if (gestureDoubleInput) gestureDoubleInput.value = settings.gestureDouble || '（有些惊讶地看着你）怎么啦？';
            if (gestureLongInput) gestureLongInput.value = settings.gestureLong || '（舒服地蹭了蹭）嗯...';
            if (gestureSwipeInput) gestureSwipeInput.value = settings.gestureSwipe || '（温柔地看着你）真乖。';
            
            // 存到内存里，方便等下触发手势时读取（这是给用户看的屏幕文本）
            this.touchGesturesCache = {
                double: settings.gestureDouble || '（有些惊讶地看着你）怎么啦？',
                long: settings.gestureLong || '（舒服地蹭了蹭）嗯...',
                swipe: settings.gestureSwipe || '（温柔地看着你）真乖。'
            };
            this.touchCustomBgsCache = settings.customBgs || [null, null, null];
            if (customBgContainer) {
                customBgContainer.style.display = settings.useAlbumBg ? 'none' : 'block';
            }

            customBgData = settings.customBgs || [null, null, null];
            customBgZonesData = settings.touchZones || [[],[],[]];

            const updatePreviewUI = (index, dataStr) => {
                customBgData[index] = dataStr;
                if(dataStr) {
                    if(customBgPreviews[index]) { customBgPreviews[index].src = dataStr; customBgPreviews[index].style.display = 'block'; }
                    if(customBgPluses[index]) customBgPluses[index].style.display = 'none';
                    if(customBgClears[index]) customBgClears[index].style.display = 'block';
                    if(customBgUrls[index]) customBgUrls[index].style.display = 'none';
                    if(customBgZonesBtn[index]) customBgZonesBtn[index].style.display = 'block'; // 显示画框按钮
                } else {
                    if(customBgPreviews[index]) customBgPreviews[index].style.display = 'none';
                    if(customBgPluses[index]) customBgPluses[index].style.display = 'block';
                    if(customBgClears[index]) customBgClears[index].style.display = 'none';
                    if(customBgUrls[index]) customBgUrls[index].style.display = 'block';
                    if(customBgZonesBtn[index]) customBgZonesBtn[index].style.display = 'none'; // 隐藏画框按钮
                }
            };

            for(let i=0; i<3; i++) { updatePreviewUI(i, customBgData[i]); }

            const saveSettings = async () => {
                if (!this.currentCharId) return;
                const specificWbs = wbSelect ? Array.from(wbSelect.selectedOptions).map(o => o.value) : [];
                await db.appData.put({
                     key: 'touch_settings_' + this.currentCharId, 
                    value: {
                        tts: ttsToggle ? ttsToggle.checked : false,
                        useAllWb: wbToggle ? wbToggle.checked : true,
                         useAlbumBg: albumBgToggle ? albumBgToggle.checked : false,
                         specificWbs: specificWbs,
                        customBgs: customBgData, 
                        customBgInterval: customBgIntervalInput ? parseInt(customBgIntervalInput.value) || 5 : 5,
                        aiInterval: aiIntervalInput ? parseInt(aiIntervalInput.value) || 5 : 5,

                        touchZones: customBgZonesData, // 把热区数据存入数据库
                        // ▼▼▼ 新增：保存手势词到数据库 ▼▼▼
                        gestureDouble: gestureDoubleInput ? gestureDoubleInput.value : '（有些惊讶地看着你）怎么啦？',
                        gestureLong: gestureLongInput ? gestureLongInput.value : '（舒服地蹭了蹭）嗯...',
                        gestureSwipe: gestureSwipeInput ? gestureSwipeInput.value : '（温柔地看着你）真乖。'
                        // ▲▲▲ 新增结束 ▲▲▲
                    }
                });
                // 同步更新内存缓存，防止手势词设置后不实时生效
                this.touchGesturesCache = {
                    double: gestureDoubleInput ? gestureDoubleInput.value : '（有些惊讶地看着你）怎么啦？',
                    long: gestureLongInput ? gestureLongInput.value : '（舒服地蹭了蹭）嗯...',
                    swipe: gestureSwipeInput ? gestureSwipeInput.value : '（温柔地看着你）真乖。'
                };
            };
            if (customBgIntervalInput) customBgIntervalInput.onchange = saveSettings;
            if (albumBgToggle) {
                albumBgToggle.onchange = () => {
                    if (customBgContainer) customBgContainer.style.display = albumBgToggle.checked ? 'none' : 'block';
                    saveSettings();
                };
            }
            if (wbToggle) {
                wbToggle.onchange = () => {
                    const wbContainer = document.getElementById('touch-wb-select-container');
                    if (wbContainer) wbContainer.style.display = wbToggle.checked ? 'none' : 'flex';
                    saveSettings();
                }
            }

            for (let i = 0; i < 3; i++) {
                if (customBgUploads[i]) {
                    customBgUploads[i].onchange = (e) => {
                        const file = e.target.files[0];
                        if (file) {
                            const reader = new FileReader();
                            reader.onload = (ev) => {
                                updatePreviewUI(i, ev.target.result);
                                saveSettings();
                            };
                            reader.readAsDataURL(file);
                        }
                    };
                }
                if (customBgUrls[i]) {
                    customBgUrls[i].onclick = () => {
                        const url = prompt('请输入图片或动图的直连地址 (URL):');
                        if (url && url.trim()) {
                            updatePreviewUI(i, url.trim());
                            saveSettings();
                        }
                    };
                }
                if (customBgClears[i]) {
                    customBgClears[i].onclick = () => {
                        if (customBgUploads[i]) customBgUploads[i].value = '';
                        updatePreviewUI(i, null);
                        saveSettings();
                    };
                }
                // 画区域按钮被点击
                if (customBgZonesBtn[i]) {
                    customBgZonesBtn[i].onclick = () => {
                        if (!customBgData[i]) return;
                        this.openTouchZoneEditor(customBgData[i], customBgZonesData[i], (newZones) => {
                            customBgZonesData[i] = newZones;
                            saveSettings();
                            this.startTouchBgRotation(charId); // 保存完立刻刷新贴贴界面的渲染
                        });
                    };
                }
            }
                    // 已修复：每次切换角色强制更新事件绑定，防止旧角色的图片热区数据覆盖新角色
            if (ttsToggle) ttsToggle.onchange = saveSettings;
            if (wbSelect) wbSelect.onchange = saveSettings;
            
            // ▼▼▼ 修复：为新加的设置项接上保存事件的“开关电线” ▼▼▼
            if (aiIntervalInput) aiIntervalInput.onchange = saveSettings;

            // ▲▲▲ 修复结束 ▲▲▲
                       
            // ▼▼▼ 新增：绑定保存事件 ▼▼▼
            if (gestureDoubleInput) gestureDoubleInput.onchange = saveSettings;
               if (gestureLongInput) gestureLongInput.onchange = saveSettings;
            if (gestureSwipeInput) gestureSwipeInput.onchange = saveSettings;
            // ▲▲▲ 新增结束 ▲▲▲
            
            // ▼▼▼ 新增：判断昨日战损并显示创可贴 ▼▼▼
            const yesterday = new Date(Date.now() - 86400000).toDateString();
            const statsRecord = await db.appData.get('touch_stats_' + charId);
            const touchArea = document.getElementById('touch-area');
            const oldBandAid = document.getElementById('touch-band-aid');
            if (oldBandAid) oldBandAid.remove(); // 清除旧的，防止重叠
            if (statsRecord && statsRecord.value && statsRecord.value.date === yesterday && statsRecord.value.count > 30 && touchArea) {
                const bandAid = document.createElement('div');
                bandAid.id = 'touch-band-aid';
                bandAid.innerHTML = '🩹'; 
                bandAid.style.cssText = 'position: absolute; font-size: 50px; z-index: 15; top: 35%; right: 30%; transform: rotate(15deg); filter: drop-shadow(2px 2px 4px rgba(0,0,0,0.3)); pointer-events: none;';
                touchArea.appendChild(bandAid);
            }
            // ▲▲▲ 新增结束 ▲▲▲
        } catch (e) { console.error("读取贴贴专属设置失败", e); }
    },
    // =========================================================
    // 渲染热区与相册轮播引擎
    // =========================================================
    startTouchBgRotation(charId) {
        // 【核心修复】加入安全防伪令牌，防止用户手速过快导致异步请求互相覆盖产生“幽灵定时器”
        const currentToken = ++this.bgReqToken || (this.bgReqToken = 1);
        if (this.touchBgTimer) clearInterval(this.touchBgTimer);
        const touchAvatar = document.getElementById('touch-char-avatar');
        const touchArea = document.getElementById('touch-area');
        if (!touchAvatar || !touchArea) return;

        db.appData.get('touch_settings_' + charId).then(record => {
            // 如果读取完成时，令牌对不上了（说明用户已经切到了别人），立刻停止执行！
            if (currentToken !== this.bgReqToken) return;
            if (this.touchBgTimer) clearInterval(this.touchBgTimer); // 双重保险再次清理

            const settings = record ? record.value : null;
            if (!settings || settings.useAlbumBg || !settings.customBgs) {
                touchArea.querySelectorAll('.touch-hotzone').forEach(el => el.remove());
                return;
            }

            const validBgs = [];
            const validZones = [];
            for (let i = 0; i < 3; i++) {
                if (settings.customBgs[i]) {
                    validBgs.push(settings.customBgs[i]);
                    validZones.push((settings.touchZones && settings.touchZones[i]) ? settings.touchZones[i] : []);
                }
            }

            if (validBgs.length === 0) {
                touchArea.querySelectorAll('.touch-hotzone').forEach(el => el.remove());
                return;
            }

            let currentIndex = 0;
            const intervalMins = settings.customBgInterval || 5;

            const renderBgAndZones = (index) => {
                touchAvatar.style.opacity = '0.5';
                setTimeout(() => {
                    touchAvatar.src = validBgs[index];
                    touchAvatar.style.opacity = '0.95';
                }, 300);

                // 清除旧的热区
                touchArea.querySelectorAll('.touch-hotzone').forEach(el => el.remove());
              // 铺设新的热区
                const zones = validZones[index];
                if (zones && zones.length > 0) {
                    zones.forEach(zone => {
                        const zoneEl = document.createElement('div');
                        zoneEl.className = 'touch-hotzone';
                        // 覆盖在图片上面，且完全透明 (读取尺寸)
                        let w = zone.w || 20, h = zone.h || 20;
                        zoneEl.style.cssText = `position: absolute; left: ${zone.x}%; top: ${zone.y}%; width: ${w}%; height: ${h}%; transform: translate(-50%, -50%); z-index: 15; background: transparent;`;
                        
                        // 仅仅赋予数据，不再绑定和拦截事件
                        zoneEl.dataset.name = zone.name;
                        zoneEl.dataset.reply = zone.reply;
                        zoneEl.dataset.sensitive = zone.sensitive || 5;
                        touchArea.appendChild(zoneEl);
                    });
                }
            };

            renderBgAndZones(currentIndex);

            if (validBgs.length > 1) {
                this.touchBgTimer = setInterval(() => {
                    currentIndex = (currentIndex + 1) % validBgs.length;
                    renderBgAndZones(currentIndex);
                }, intervalMins * 60 * 1000);
            }
        });
    },

    // =========================================================
    // 画板工具弹窗逻辑
    // =========================================================
    openTouchZoneEditor(imgUrl, existingZones, saveCallback) {
        const modal = document.getElementById('touch-zone-editor-overlay');
        const imgContainer = document.getElementById('zone-editor-img-container');
        const imgEl = document.getElementById('zone-editor-img');
        const propsPanel = document.getElementById('zone-editor-props');
        const nameInput = document.getElementById('zone-name-input');
        const replyInput = document.getElementById('zone-reply-input');
        const sensitiveInput = document.getElementById('zone-sensitive-input');
        const deleteBtn = document.getElementById('delete-zone-btn');
        
        let zones = JSON.parse(JSON.stringify(existingZones || [])); 
        let currentSelectedZoneId = null;

        imgEl.src = imgUrl;
        imgContainer.querySelectorAll('.editor-zone-box').forEach(el => el.remove());
        propsPanel.style.transform = 'translateY(100%)'; 
        
        // --- 背景缩放平移 ---
        let bgScale = 1, bgX = 0, bgY = 0;
        imgContainer.style.transform = `translate(0px, 0px) scale(1)`;
        imgContainer.style.transformOrigin = 'center center';
        imgContainer.style.transition = 'none'; 
        
        const updateBgTransform = () => {
            imgContainer.style.transform = `translate(${bgX}px, ${bgY}px) scale(${bgScale})`;
        };

        const renderBoxes = () => {
            imgContainer.querySelectorAll('.editor-zone-box').forEach(el => el.remove());
            zones.forEach((zone, idx) => {
                const box = document.createElement('div');
                box.className = 'editor-zone-box';
                let w = parseFloat(zone.w) || 20, h = parseFloat(zone.h) || 20;
                let x = parseFloat(zone.x) || 50, y = parseFloat(zone.y) || 50;
                
                box.style.cssText = `position: absolute; left: ${x}%; top: ${y}%; width: ${w}%; height: ${h}%; transform: translate(-50%, -50%); border: 2px dashed ${currentSelectedZoneId === idx ? '#fff' : 'rgba(255,255,255,0.5)'}; background: ${currentSelectedZoneId === idx ? 'rgba(211, 167, 165, 0.4)' : 'rgba(255,255,255,0.2)'}; border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 12px; font-weight: bold; text-shadow: 0 1px 2px #000; box-sizing: border-box; z-index: 100; touch-action: none; transition: box-shadow 0.2s;`;
                
                box.innerHTML = `${zone.name || '未命名'}<div class="resize-handle" style="position: absolute; right: -15px; bottom: -15px; width: 30px; height: 30px; background: rgba(211, 167, 165, 0.9); border: 2px solid #fff; border-radius: 50%; z-index: 101; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`;
                
                let pressTimer = null;
                let dragMode = null; // 'move' 或 'resize'
                let startClientX, startClientY, startW, startH, startX, startY;

                // 统一事件处理：长按触发
                const handleStart = (clientX, clientY, isHandle) => {
                    // 【修改开始：手指一碰到屏幕就记录初始坐标，用于防手抖】
                    startClientX = clientX;
                    startClientY = clientY;
                    // 【修改结束】
                    pressTimer = setTimeout(() => {
                        dragMode = isHandle ? 'resize' : 'move';
                        // 长按激活时的视觉反馈（发光）
                        box.style.boxShadow = '0 0 0 4px rgba(255,255,255,0.6)';
                        if (navigator.vibrate) navigator.vibrate(50); // 手机震动反馈
                        
                        startX = parseFloat(zone.x) || 50;
                        startY = parseFloat(zone.y) || 50;
                        startW = parseFloat(zone.w) || 20;
                        startH = parseFloat(zone.h) || 20;
                         currentSelectedZoneId = idx;
                        nameInput.value = zone.name || '';
                        replyInput.value = zone.reply || '';
                        if(sensitiveInput) sensitiveInput.value = zone.sensitive || 5;
                        propsPanel.style.transform = 'translateY(0)';
                    }, 400); // 必须长按 0.4 秒才会激活拖拽
                };

                 const handleMove = (clientX, clientY) => {
                    if (!dragMode) {
                        // 【修改开始：增加 10 像素距离防抖，轻微滑动不打断长按】
                        if (Math.abs(clientX - startClientX) > 10 || Math.abs(clientY - startClientY) > 10) {
                            clearTimeout(pressTimer); // 滑动超过 10 像素才当作误触取消
                        }
                        // 【修改结束】
                        return;
                    }
                    const rect = imgEl.getBoundingClientRect(); // 获取图片现在的真实缩放尺寸
                    if (dragMode === 'move') {
                        let deltaX = ((clientX - startClientX) / rect.width) * 100;
                        let deltaY = ((clientY - startClientY) / rect.height) * 100;
                        zone.x = Math.max(0, Math.min(100, startX + deltaX)).toFixed(2);
                        zone.y = Math.max(0, Math.min(100, startY + deltaY)).toFixed(2);
                        box.style.left = `${zone.x}%`;
                        box.style.top = `${zone.y}%`;
                    } else if (dragMode === 'resize') {
                        let deltaW = ((clientX - startClientX) / rect.width) * 100;
                        let deltaH = ((clientY - startClientY) / rect.height) * 100;
                        zone.w = Math.max(5, Math.min(90, startW + deltaW)).toFixed(2);
                        zone.h = Math.max(5, Math.min(90, startH + deltaH)).toFixed(2);
                        box.style.width = `${zone.w}%`;
                        box.style.height = `${zone.h}%`;
                    }
                };

                const handleEnd = () => {
                    clearTimeout(pressTimer);
                    if (dragMode) {
                        box.style.boxShadow = 'none'; // 恢复原本样式
                        dragMode = null;
                        renderBoxes(); // 重绘保持最新状态
                    } else {
                        // 只是短按点击，选中该框并打开设置面板
                        currentSelectedZoneId = idx;
                        renderBoxes(); 
                        nameInput.value = zone.name || '';
                        replyInput.value = zone.reply || '';
                        if(sensitiveInput) sensitiveInput.value = zone.sensitive || 5;
                        propsPanel.style.transform = 'translateY(0)';
                    }
                };

                // 手机触摸事件
                box.addEventListener('touchstart', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const isHandle = e.target.classList.contains('resize-handle');
                    handleStart(e.touches[0].clientX, e.touches[0].clientY, isHandle);
                }, {passive: false});
                box.addEventListener('touchmove', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    handleMove(e.touches[0].clientX, e.touches[0].clientY);
                }, {passive: false});
                box.addEventListener('touchend', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    handleEnd();
                });

                // 电脑鼠标事件兼容
                box.addEventListener('mousedown', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const isHandle = e.target.classList.contains('resize-handle');
                    handleStart(e.clientX, e.clientY, isHandle);
                    
                    const mouseMove = (me) => handleMove(me.clientX, me.clientY);
                    const mouseUp = () => {
                        handleEnd();
                        document.removeEventListener('mousemove', mouseMove);
                        document.removeEventListener('mouseup', mouseUp);
                    };
                    document.addEventListener('mousemove', mouseMove);
                    document.addEventListener('mouseup', mouseUp);
                });

                imgContainer.appendChild(box);
            });
        };

        // --- 背景事件（单指拖拽 + 双指缩放 + 点击空白处添加） ---
        let isBgDragging = false;
        let bgStartClientX, bgStartClientY, startBgX, startBgY;
        let initialPinchDistance = null, startBgScale = 1;
        let hasMoved = false;

        const getDistance = (touches) => {
            return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
        };

        const parentArea = imgContainer.parentElement; // 整个黑色背景区域

        // 手机背景触摸
        parentArea.addEventListener('touchstart', (e) => {
            if (e.target !== imgContainer && e.target !== imgEl && e.target !== parentArea) return;
            if (e.touches.length === 2) {
                initialPinchDistance = getDistance(e.touches);
                startBgScale = bgScale;
                isBgDragging = false;
            } else {
                isBgDragging = true;
                hasMoved = false;
                bgStartClientX = e.touches[0].clientX;
                bgStartClientY = e.touches[0].clientY;
                startBgX = bgX; 
                startBgY = bgY;
            }
        }, {passive: false});

        parentArea.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2 && initialPinchDistance) {
                e.preventDefault(); // 阻止浏览器原生缩放
                hasMoved = true;
                const dist = getDistance(e.touches);
                bgScale = Math.max(0.5, Math.min(5, startBgScale * (dist / initialPinchDistance)));
                updateBgTransform();
            } else if (isBgDragging) {
                if (Math.abs(e.touches[0].clientX - bgStartClientX) > 5 || Math.abs(e.touches[0].clientY - bgStartClientY) > 5) {
                    hasMoved = true;
                }
                if (hasMoved) {
                    e.preventDefault();
                    bgX = startBgX + (e.touches[0].clientX - bgStartClientX);
                    bgY = startBgY + (e.touches[0].clientY - bgStartClientY);
                    updateBgTransform();
                }
            }
        }, {passive: false});

        parentArea.addEventListener('touchend', (e) => {
            if (!hasMoved && isBgDragging && (e.target === imgEl || e.target === imgContainer)) {
                // 没有滑动且点击的是图片范围，执行添加逻辑
                const rect = imgEl.getBoundingClientRect();
                const clientX = e.changedTouches[0].clientX;
                const clientY = e.changedTouches[0].clientY;
                
                if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
                    let xPercent = ((clientX - rect.left) / rect.width) * 100;
                    let yPercent = ((clientY - rect.top) / rect.height) * 100;
                    zones.push({ name: '新部位', reply: '啊！', x: xPercent.toFixed(2), y: yPercent.toFixed(2), w: 15, h: 15, sensitive: 5 });
                    currentSelectedZoneId = zones.length - 1;
                    nameInput.value = '新部位';
                    replyInput.value = '啊！';
                    if(sensitiveInput) sensitiveInput.value = 5;
                    propsPanel.style.transform = 'translateY(0)';
                    renderBoxes();
                }
            }
            isBgDragging = false;
            initialPinchDistance = null;
            hasMoved = false;
        });

        // 电脑背景鼠标兼容
        parentArea.addEventListener('mousedown', (e) => {
            if (e.target !== imgContainer && e.target !== imgEl && e.target !== parentArea) return;
            isBgDragging = true;
            hasMoved = false;
            bgStartClientX = e.clientX; bgStartClientY = e.clientY;
            startBgX = bgX; startBgY = bgY;
        });
        parentArea.addEventListener('mousemove', (e) => {
            if (isBgDragging) {
                if (Math.abs(e.clientX - bgStartClientX) > 5 || Math.abs(e.clientY - bgStartClientY) > 5) hasMoved = true;
                if (hasMoved) {
                    bgX = startBgX + (e.clientX - bgStartClientX);
                    bgY = startBgY + (e.clientY - bgStartClientY);
                    updateBgTransform();
                }
            }
        });
        parentArea.addEventListener('mouseup', (e) => {
            if (!hasMoved && isBgDragging && (e.target === imgEl || e.target === imgContainer)) {
                const rect = imgEl.getBoundingClientRect();
                if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
                    let xPercent = ((e.clientX - rect.left) / rect.width) * 100;
                    let yPercent = ((e.clientY - rect.top) / rect.height) * 100;
                    zones.push({ name: '新部位', reply: '啊！', x: xPercent.toFixed(2), y: yPercent.toFixed(2), w: 15, h: 15, sensitive: 5 });
                    currentSelectedZoneId = zones.length - 1;
                    nameInput.value = '新部位';
                    replyInput.value = '啊！';
                    if(sensitiveInput) sensitiveInput.value = 5;
                    propsPanel.style.transform = 'translateY(0)';
                    renderBoxes();
                }
            }
            isBgDragging = false;
            hasMoved = false;
        });

        // 底部面板事件
        nameInput.oninput = () => { if(currentSelectedZoneId !== null) { zones[currentSelectedZoneId].name = nameInput.value; renderBoxes(); } };
        replyInput.oninput = () => { if(currentSelectedZoneId !== null) { zones[currentSelectedZoneId].reply = replyInput.value; } };
                if(sensitiveInput) sensitiveInput.oninput = () => { if(currentSelectedZoneId !== null) { zones[currentSelectedZoneId].sensitive = parseInt(sensitiveInput.value) || 5; } };
        deleteBtn.onclick = () => {
            if(currentSelectedZoneId !== null) {
                zones.splice(currentSelectedZoneId, 1);
                currentSelectedZoneId = null;
                propsPanel.style.transform = 'translateY(100%)';
                renderBoxes();
            }
        };

        document.getElementById('close-zone-editor-btn').onclick = () => {
            modal.style.opacity = '0'; setTimeout(() => modal.style.display = 'none', 300);
        };
        document.getElementById('save-zone-editor-btn').onclick = () => {
            saveCallback(zones);
            modal.style.opacity = '0'; setTimeout(() => modal.style.display = 'none', 300);
        };

        modal.style.display = 'flex';
        setTimeout(() => { modal.style.opacity = '1'; renderBoxes(); }, 10);
    },
     // --- 1. 时光温室 (Focus Room) ---
    initFocusRoom() {
        // ▼▼▼ 新增：基于高容量大数据库(IndexedDB)的防断线保留机制 ▼▼▼
        (async () => {
            try {
                const crashRecord = await db.appData.get('focus_crash_recovery');
                if (crashRecord && crashRecord.value) {
                    const cData = crashRecord.value;
                     const memoryPrompt = `[系统隐式提示：用户刚才在做【${cData.taskName}】时中途意外退出了网页，导致植物枯萎了。请在接下来的对话中自然地表现出心疼TA太累了，或者微微生气的样子。]`;
                    // 【修改这里】：用 const msgId 接收保存结果，然后呼叫聊天UI组件更新画面
                    const msgId = await db.chatMessages.add({
                        chatId: cData.charId, timestamp: new Date(), 
                        text: memoryPrompt, shortText: `刚刚【${cData.taskName}】番茄钟任务意外中断了哦`,  
                        type: 'system', contentType: 'focus_record_card',
                        focusData: { taskName: cData.taskName, duration: cData.duration, isSuccess: false, spokenList: cData.spokenList, hasTTS: cData.hasTTS },
                        uiVisible: true, aiVisible: true, recalled: false
                    });
                    const newMsg = await db.chatMessages.get(msgId);
                    import('../features/chat-ui.js').then(m => m.createAndAppendMessage && m.createAndAppendMessage(newMsg));

                    await focusState.addRecord(cData.charId, cData.duration, false);
                    await db.appData.delete('focus_crash_recovery'); // 处理完就删除
                }
            } catch(e) { console.error('恢复专注数据失败', e); }
        })();
        // ▲▲▲ 新增结束 ▲▲▲

        const startBtn = document.getElementById('focus-start-btn');
        const giveupBtn = document.getElementById('focus-giveup-btn');
        const timeSelect = document.getElementById('focus-time-select');
        const display = document.getElementById('focus-time-display');
        const circle = document.getElementById('focus-progress-bar');
        const bubble = document.getElementById('focus-ai-bubble');
        const plantEmoji = document.getElementById('focus-plant-emoji');
        const statsTrigger = document.getElementById('focus-stats-trigger');
        const recordsModal = document.getElementById('focus-records-modal');
        const closeRecordsBtn = document.getElementById('close-focus-records-btn');
        // ▼▼▼ 修复：初始化时自动拉取并显示总花朵数 ▼▼▼
        (async () => {
            try {
                const data = await focusState.getRecords();
                const topStatsSpan = document.getElementById('focus-top-flower-count') || document.querySelector('#focus-stats-trigger span');
                if (topStatsSpan) topStatsSpan.textContent = data.totalFlowers ? data.totalFlowers + ' 朵' : '0 朵';
            } catch(e) {}
        })();
        // ▲▲▲ 修复结束 ▲▲▲
        if (statsTrigger && recordsModal) {
           statsTrigger.addEventListener('click', async () => {
                recordsModal.style.display = 'flex';
                setTimeout(() => recordsModal.style.opacity = '1', 10);
                
                // 从数据库读取真实数据
                const data = await focusState.getRecords();
                
                // 1. 更新顶部总览数字
                const totalDisplay = recordsModal.querySelector('div[style*="color: #D3A7A5;"]');
                const timeDisplay = recordsModal.querySelector('div[style*="color: #8FA2B4;"]');
                if (totalDisplay) totalDisplay.textContent = data.totalFlowers || 0;
                if (timeDisplay) timeDisplay.textContent = data.totalMinutes || 0;
                
                // 2. 更新近7天柱状图
                const bars = recordsModal.querySelectorAll('.focus-bar');
                const labels = recordsModal.querySelectorAll('.day-label');
                if (bars.length === 7) {
                    const today = new Date();
                    let maxMins = 1; 
                    const weekData = [];
                    for (let i = 6; i >= 0; i--) {
                        const d = new Date(today);
                        d.setDate(d.getDate() - i);
                        const dateStr = d.toISOString().split('T')[0];
                        const mins = data.dailyHistory[dateStr] || 0;
                        weekData.push({ dayStr: ['日','一','二','三','四','五','六'][d.getDay()], mins });
                        if (mins > maxMins) maxMins = mins;
                    }
                    weekData.forEach((item, index) => {
                        const percent = (item.mins / maxMins) * 100;
                        bars[index].style.height = `${percent}%`;
                        labels[index].textContent = item.dayStr;
                    });
                }
                // 3. 渲染角色陪伴列表
                const charListContainer = document.getElementById('focus-char-time-list');
                if(charListContainer) {
                    charListContainer.innerHTML = '';
                    const sortedChars = Object.entries(data.charTime).sort((a, b) => b[1] - a[1]);
                    
                    if (sortedChars.length === 0) {
                        charListContainer.innerHTML = '<div style="text-align:center; color:#A89B92; font-size:12px; padding:10px;">暂无陪伴记录</div>';
                    } else {
                        sortedChars.forEach(([cId, mins]) => {
                            const char = AppState.characterProfiles.find(c => c.id === cId);
                            if (!char) return;
                            charListContainer.innerHTML += `
                                <div style="display: flex; align-items: center; justify-content: space-between; background: #FAF7F5; padding: 10px; border-radius: 12px;">
                                    <div style="display: flex; align-items: center; gap: 10px;">
                                        <img src="${char.avatar || 'images/default-avatar.svg'}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover;">
                                        <span style="font-size: 13px; font-weight: 600; color: #4A4440;">${char.name}</span>
                                    </div>
                                    <span style="font-size: 12px; color: #A3958F; font-weight: bold;">陪伴 ${mins} 分钟</span>
                                </div>`;
                        });
                    }
                }
                         // 顺便更新外面按钮上的花朵数字
                const topStatsSpan = statsTrigger.querySelector('span');
                // 【修改这里】
                if (topStatsSpan) topStatsSpan.textContent = data.totalFlowers ? data.totalFlowers + ' 朵' : '0 朵';
            });
                  closeRecordsBtn?.addEventListener('click', () => {
                recordsModal.style.opacity = '0';
                setTimeout(() => recordsModal.style.display = 'none', 300);
            });
        }
// 【第二处：将下面的代码粘贴到这里】
        // ▼▼▼ 新增：陪伴设置页面与交流框交互逻辑 ▼▼▼
        const settingsBtn = document.getElementById('focus-settings-btn');
        const chatInputToggle = document.getElementById('focus-chat-input-toggle');
        const interactiveChatBox = document.getElementById('focus-interactive-chat');

        if (settingsBtn) {
            settingsBtn.addEventListener('click', async () => {
                // 点击齿轮时，平滑跳转到新创建的设置页面
                showPage('page-focus-settings');
                
                // 真通路：从数据库拉取世界书条目填充下拉框
                const wbSelect = document.getElementById('focus-wb-select');
                if (wbSelect) {
                    wbSelect.innerHTML = '<option value="none">不接入额外世界书 / 暂无</option>';
                    try {
                        const entries = await db.worldBookEntries.toArray();
                        if (entries && entries.length > 0) {
                            entries.forEach(entry => {
                                const opt = document.createElement('option');
                                opt.value = entry.id;
                                opt.textContent = entry.title || entry.name || '未命名设定';
                                wbSelect.appendChild(opt);
                            });
                        }
                        // ▼▼▼ 修复：重新勾选当前角色已保存的专属世界书 ▼▼▼
                        if (this.currentCharId) {
                            const record = await db.appData.get('focus_settings_' + this.currentCharId);
                            if (record && record.value && record.value.specificWbs) {
                                Array.from(wbSelect.options).forEach(opt => {
                                    opt.selected = record.value.specificWbs.includes(opt.value);
                                });
                            }
                        }
                        // ▲▲▲ 修复结束 ▲▲▲
                    } catch(e) { console.warn("读取世界书列表失败", e); }
                }
            });
        }
 
// 【第二处：粘贴结束】
        // ▼▼▼ 新增：专注任务下拉选择联动事件 ▼▼▼
        const taskSelect = document.getElementById('focus-task-schedule-select');
        const taskInput = document.getElementById('focus-task-input');
        if (taskSelect && taskInput) {
            taskSelect.addEventListener('change', (e) => {
                if (e.target.value) {
                    taskInput.value = e.target.value; // 把选中的日程名填到输入框
                    
                    // 自动匹配最接近的专注时长
                    const selectedOpt = taskSelect.options[taskSelect.selectedIndex];
                    const duration = parseInt(selectedOpt.dataset.duration);
                    if (!isNaN(duration) && duration > 0 && timeSelect) {
                        let bestMatch = "25";
                        if (duration <= 15) bestMatch = "15";
                        else if (duration <= 35) bestMatch = "25";
                        else if (duration <= 50) bestMatch = "45";
                        else bestMatch = "60";
                        timeSelect.value = bestMatch;
                    }
                    
                    taskSelect.selectedIndex = 0; // 用完恢复显示
                }
            });
        }
        // ▲▲▲ 新增结束 ▲▲▲
        // ▼▼▼ 新增：自定义专注时间逻辑 ▼▼▼
        let lastFocusTimeVal = "25"; // 记住上一次的选择，取消时恢复
        timeSelect?.addEventListener('change', (e) => {
            if (e.target.value === 'custom') {
                const modal = document.getElementById('focus-custom-time-modal');
                const input = document.getElementById('focus-custom-time-input');
                const cancelBtn = document.getElementById('focus-custom-time-cancel');
                const confirmBtn = document.getElementById('focus-custom-time-confirm');

                // 显示同款高甜弹窗
                modal.style.display = 'flex';
                setTimeout(() => modal.style.opacity = '1', 10);
                
                // 取消：关闭弹窗并退回上一个有效选项
                cancelBtn.onclick = () => {
                    modal.style.opacity = '0';
                    setTimeout(() => modal.style.display = 'none', 300);
                    timeSelect.value = lastFocusTimeVal; 
                };

                // 确定：插入用户的自定义时间
                confirmBtn.onclick = () => {
                    let val = parseInt(input.value);
                    if (isNaN(val) || val <= 0) val = 1;
                    if (val > 180) val = 180; // 封顶180分钟，防止胡乱输入

                    modal.style.opacity = '0';
                    setTimeout(() => modal.style.display = 'none', 300);

                    // 如果下拉框里没这个时间，就动态加进去并选中
                    let existOpt = Array.from(timeSelect.options).find(opt => opt.value == val && opt.value !== 'custom');
                    if (existOpt) {
                        timeSelect.value = val;
                    } else {
                        const newOpt = document.createElement('option');
                        newOpt.value = val;
                        newOpt.textContent = `${val}分钟 (自定义)`;
                        timeSelect.insertBefore(newOpt, timeSelect.querySelector('option[value="custom"]'));
                        timeSelect.value = val;
                    }
                    lastFocusTimeVal = val;
                };
            } else {
                lastFocusTimeVal = e.target.value;
            }
        });
        // ▲▲▲ 新增结束 ▲▲▲
        const updateCircle = () => {
            const radius = 45;
            const circumference = 2 * Math.PI * radius;
            const percent = this.focus.timeLeft / this.focus.totalTime;
            circle.style.strokeDasharray = `${circumference}`;
            circle.style.strokeDashoffset = `${circumference - percent * circumference}`;
        };

        const showBubble = (text) => {
            bubble.textContent = text;
            bubble.style.opacity = '1';
            bubble.style.transform = 'translateY(0)';
            
            // 清理上一次的倒计时，防止连续说话时气泡闪退
            if (this.focus.bubbleTimer) clearTimeout(this.focus.bubbleTimer);
            
            // 智能计算时间：保底显示5秒，之后每多一个字增加 200 毫秒
            const displayTime = Math.max(5000, text.length * 200);
            
            this.focus.bubbleTimer = setTimeout(() => {
                bubble.style.opacity = '0';
                bubble.style.transform = 'translateY(10px)';
            }, displayTime);
        };

        // 防切屏逻辑
        this.handleVisibility = () => {
            if (document.hidden && this.focus.isFocusing) {
                showDynamicIsland('去哪里了？花朵要枯萎了！', 'error');
                // 惩罚机制：切屏扣除1分钟，并同步扣除现实目标时间
                this.focus.timeLeft = Math.max(1, this.focus.timeLeft - 60);
                if (this.focus.targetEndTime) this.focus.targetEndTime -= 60000;
                showBubble("你刚才是不是走神了？我都看到了！哼！");
            }
        };
        startBtn?.addEventListener('click', () => {
            if (!this.currentCharId) return showDynamicIsland('请先选择角色');
            const mins = parseInt(timeSelect.value);
            this.focus.totalTime = mins * 60;
            this.focus.timeLeft = this.focus.totalTime;
            this.focus.targetEndTime = Date.now() + this.focus.totalTime * 1000; // 记录真实结束时间
            
            // 【音乐级保活】播放极短的静音音频，强制手机保留后台JS运行权限
            if (!this.focus.keepAliveAudio) {
                this.focus.keepAliveAudio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA');
                this.focus.keepAliveAudio.loop = true;
            }
            this.focus.keepAliveAudio.play().catch(()=>{});

            this.focus.isFocusing = true;
            this.focus.spokenHistory = []; // 新增：每次开始专注时，清空本次的临时语录缓存
            this.focus.bgTurnCount = 0; // 重置壁纸轮次计数器
            this.focus.lastBgUrl = null; // 【新增】记忆上一张壁纸，用来防止连续重复
                plantEmoji.textContent = '🌱'; // 初始种子
                // ▼▼▼ 摄像头与小窗拖拽启动逻辑 ▼▼▼
            try {
                this.focus.mediaStream = null;
                const useCamera = document.getElementById('focus-chat-input-toggle')?.checked; 
                const pip = document.getElementById('focus-camera-pip');
                if (useCamera && pip) {
                    pip.style.display = 'block';
                    pip.style.top = '80px'; pip.style.left = ''; pip.style.right = '20px'; // 每次恢复初始位置
                      // 拖拽逻辑绑定 (引入 requestAnimationFrame 优化丝滑度)
                    if (!pip.dataset.dragBound) {
                        pip.dataset.dragBound = '1';
                        let isDragging = false, startX, startY, initialX, initialY, dragFrame;
                        const handle = document.getElementById('focus-camera-drag-handle');
                        if (handle) {
                            const onDragStart = (e) => {
                                isDragging = true;
                                startX = e.touches ? e.touches[0].clientX : e.clientX;
                                startY = e.touches ? e.touches[0].clientY : e.clientY;
                                const rect = pip.getBoundingClientRect();
                                initialX = rect.left; initialY = rect.top;
                                pip.style.right = 'auto'; // 改用 left 定位方便拖拽
                            };
                            const onDragMove = (e) => {
                                if (!isDragging) return;
                                e.preventDefault();
                                const currentX = e.touches ? e.touches[0].clientX : e.clientX;
                                const currentY = e.touches ? e.touches[0].clientY : e.clientY;
                                // 使用动画帧机制，防止高频移动导致的浏览器重绘卡顿
                                if (dragFrame) cancelAnimationFrame(dragFrame);
                                dragFrame = requestAnimationFrame(() => {
                                    pip.style.left = (initialX + currentX - startX) + 'px';
                                    pip.style.top = (initialY + currentY - startY) + 'px';
                                });
                            };
                            const onDragEnd = () => { isDragging = false; if (dragFrame) cancelAnimationFrame(dragFrame); };
                            handle.onmousedown = onDragStart; handle.ontouchstart = onDragStart;
                            document.addEventListener('mousemove', onDragMove); document.addEventListener('touchmove', onDragMove, {passive: false});
                            document.addEventListener('mouseup', onDragEnd); document.addEventListener('touchend', onDragEnd);
                        }
                    }

                    // 获取视频流 (强化了容错与优雅的界面提示)
                    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
                        navigator.mediaDevices.getUserMedia({ video: true }).then(stream => {
                            this.focus.mediaStream = stream;
                            const videoEl = document.getElementById('focus-camera-video');
                            if (videoEl) videoEl.srcObject = stream;
                        }).catch(err => {
                            console.warn('摄像头开启失败:', err);
                            // 优雅提示硬件缺失，不打断专注倒计时
                            if (err.name === 'NotFoundError') {
                                if(typeof showDynamicIsland === 'function') showDynamicIsland('未检测到摄像头硬件', 'warning');
                            } else {
                                if(typeof showDynamicIsland === 'function') showDynamicIsland('摄像头权限被拒绝', 'warning');
                            }
                        });
                    } else {
                        if(typeof showDynamicIsland === 'function') showDynamicIsland('当前环境不支持调用摄像头', 'warning');
                    }
                } else if (pip) {
                    pip.style.display = 'none';
                }
            } catch (e) {
                console.error("摄像头模块发生异常拦截:", e);
            }
            // ▲▲▲ 摄像头启动逻辑结束 ▲▲▲

            // ▼▼▼ 新增：初始化自定义背景轮播状态 ▼▼▼
            try {
                this.focus.customBgPassedMins = 0;
                this.focus.customBgCurrentIdx = 0;
                // 【核心修复：正是这一行没加安全验证导致了页面卡死！】
                this.focus.validCustomBgs = Array.isArray(this.customBgsCache) ? this.customBgsCache.filter(url => url) : [];
                
                const useAlbumBgCheck = document.getElementById('focus-album-bg-toggle')?.checked;
                if (!useAlbumBgCheck && this.focus.validCustomBgs.length > 0) {
                    const bgAvatar = document.getElementById('focus-char-avatar') || document.querySelector('.focus-bg-avatar');
                    if (bgAvatar) bgAvatar.src = this.focus.validCustomBgs[0];
                }
            } catch (bgErr) {
                console.warn('背景轮播初始化失败，已拦截:', bgErr);
            }
            // ▲▲▲ 新增结束 ▲▲▲
            // ▼▼▼ 新增：获取任务内容并在气泡中展示 ▼▼▼
            const taskInputVal = document.getElementById('focus-task-input');
            const taskName = taskInputVal && taskInputVal.value.trim() ? taskInputVal.value.trim() : '专注';
            // ▲▲▲ 新增结束 ▲▲▲
            
            // 【修改】专注时直接用JS干掉整个底部控制区，实现全屏极简效果
            document.getElementById('focus-bottom-panel').style.display = 'none';
           document.addEventListener('visibilitychange', this.handleVisibility);
            showBubble(`开始啦！陪你一起完成【${taskName}】。`);
            this.focus.timer = setInterval(() => {
                // 放弃呆板的递减，改为实时计算差值，彻底免疫熄屏和卡顿
                this.focus.timeLeft = Math.max(0, Math.round((this.focus.targetEndTime - Date.now()) / 1000));
                
                const m = Math.floor(this.focus.timeLeft / 60).toString().padStart(2, '0');
                const s = (this.focus.timeLeft % 60).toString().padStart(2, '0');
                display.textContent = `${m}:${s}`;
                updateCircle();

                // ▼▼▼ 新增：自定义背景定时切换逻辑 ▼▼▼
                if (this.focus.timeLeft % 60 === 0 && !document.getElementById('focus-album-bg-toggle')?.checked && this.focus.validCustomBgs && this.focus.validCustomBgs.length > 1) {
                    this.focus.customBgPassedMins++;
                    const switchInterval = parseInt(document.getElementById('focus-custom-bg-interval')?.value) || 5;
                    if (this.focus.customBgPassedMins >= switchInterval) {
                        this.focus.customBgPassedMins = 0;
                        this.focus.customBgCurrentIdx = (this.focus.customBgCurrentIdx + 1) % this.focus.validCustomBgs.length;
                        const bgAvatar = document.getElementById('focus-char-avatar') || document.querySelector('.focus-bg-avatar');
                        if (bgAvatar) {
                            bgAvatar.style.transition = 'opacity 0.5s';
                            bgAvatar.style.opacity = '0.5'; // 淡出效果
                            setTimeout(() => {
                                bgAvatar.src = this.focus.validCustomBgs[this.focus.customBgCurrentIdx];
                                bgAvatar.style.opacity = '1'; // 淡入效果
                            }, 500);
                        }
                    }
                }
                // ▲▲▲ 新增结束 ▲▲▲

                // 核心：定时触发高级陪伴 Prompt
                const intervalMins = parseInt(document.getElementById('focus-tts-interval')?.value) || 10;
                if (intervalMins > 0 && this.focus.timeLeft > 0 && this.focus.totalTime - this.focus.timeLeft > 0 && (this.focus.totalTime - this.focus.timeLeft) % (intervalMins * 60) === 0) {
                    const useTts = document.getElementById('focus-tts-toggle')?.checked;
                    const useAllWb = document.getElementById('focus-wb-toggle')?.checked;
                    const useAlbumBg = document.getElementById('focus-album-bg-toggle')?.checked;
                    
                    // ▼▼▼ 修复：获取多选的所有世界书ID ▼▼▼
                    const wbSelectEl = document.getElementById('focus-wb-select');
                    const specificWbIds = wbSelectEl ? Array.from(wbSelectEl.selectedOptions).map(o => o.value) : [];
                    // ▲▲▲ 修复结束 ▲▲▲

                    const char = AppState.characterProfiles.find(c => c.id === this.currentCharId);
                    
                    if (char) {
                        // 立即执行异步任务，不阻塞倒计时运行
                        (async () => {
                            // 1. 真实提取多本世界书文本
                            let wbContextText = '（未接入世界书设定）';
                            try {
                                if (useAllWb) {
                                    wbContextText = await getWorldBookForPrompt(char.id); 
                                } else if (specificWbIds.length > 0 && !specificWbIds.includes('none')) {
                                    wbContextText = ''; // 清空默认文本
                                    for (let id of specificWbIds) {
                                        const entry = await db.worldBookEntries.get(Number(id) || id);
                                        if (entry) wbContextText += `【${entry.title || entry.name}】\n${entry.content}\n`;
                                    }
                                }
                             } catch(e) { console.warn("拉取世界书文本失败", e); }

                            // ▼▼▼ 新增：提取用户的专属设定和角色的长期记忆，防止半失忆 ▼▼▼
                            let userPersonaText = "无";
                            let memoryText = "无";
                            try {
                                const userIdentityId = char.chatIdentityId || AppState.currentIdentityId;
                                const currentUser = AppState.userIdentities.find(id => id.id === userIdentityId) || AppState.userIdentities[0];
                                if (currentUser) userPersonaText = `姓名: ${currentUser.name}\n设定: ${currentUser.persona || '无'}`;
                                
                                // 【修复报错】不直接查可能不存在的底层表，而是动态引入系统官方记忆获取函数
                                const { getMemoriesForPrompt } = await import('./memory.js');
                                memoryText = await getMemoriesForPrompt(char.id) || "无";
                            } catch(e) { console.warn("拉取用户设定或记忆失败", e); }
                            // ▲▲▲ 新增结束 ▲▲▲

                            // 2. 提取最近的聊天记录，防止角色在陪伴时变成失忆状态
                            let recentChat = "无";
                            try {
                                const msgs = await db.chatMessages.where('chatId').equals(this.currentCharId).reverse().limit(15).toArray();
                                if (msgs && msgs.length > 0) {
                                    recentChat = msgs.reverse().map(m => {
                                        const sender = m.type === 'sent' ? '用户' : (m.type === 'system' ? '系统' : char.name);
                                        const content = typeof m.text === 'string' ? m.text : (typeof m.content === 'string' ? m.content : '[特殊消息]');
                                        return `${sender}: ${content.replace(/<[^>]+>/g, '').replace(/\[MSG ID: \d+\]\s*/g, '')}`;
                                    }).join('\n');
                                }
                            } catch(e) { console.warn("拉取短期记忆失败", e); }
                            const passedMins = Math.floor((this.focus.totalTime - this.focus.timeLeft) / 60);
                            const leftMins = Math.floor(this.focus.timeLeft / 60);

                            // 提取刚才已经在气泡里说过的话
                            const spokenCache = this.focus.spokenHistory && this.focus.spokenHistory.length > 0 
                                ? this.focus.spokenHistory.map((t, i) => `${i + 1}. ${t}`).join('\n') 
                                : "暂无";
                             // 3. 构造顶级防幻觉、深度结合世界观与记忆的陪伴提示词
                            let sceneInstruction = '';
                            if (useAlbumBg) {
                                                               sceneInstruction = `\n7. **Visual Background**: You MUST output a \`[SCENE: keywords]\` tag anywhere in your text. "keywords" should be 2 to 4 Chinese words separated by commas, describing the environment or action (e.g. [SCENE: 卧室, 坐着, 咖啡]).`;
                            }
                            const prompt = `[System Preamble]

<System_Role>You are an actor who MUST fully embody ${char.name} in a live companionship session with the user. Currently, you are connecting through a virtual interface. You CANNOT physically see the user, but you know they are working hard. You have ZERO AI traits.</System_Role>
<Core_Rules>
# RULE ZERO: Your ENTIRE response MUST be ONE single, natural paragraph. NO JSON. NO markdown. NO AI-like explanations.

# Part A: Identity & Scenario
- **[Identity]**: You ARE ${char.name}. Use "I"(我). 
- **[The Scenario]**: The user is currently in deep focus mode (working/studying). You've accompanied them for ${passedMins} mins, ${leftMins} mins left.

# Part B: Action Guideline (CRITICAL)
1. **NO VISUAL HALLUCINATIONS**: 你现在没有开启摄像头，看不见用户！绝对禁止凭空捏造视觉画面！绝对不要说“看着你认真的样子”、“别离屏幕太近”、“你皱着眉头”这种话。你只能基于“知道TA在努力”这一事实进行言语上的关心和陪伴。
2. **NO ACTION DESCRIPTIONS**: 绝对禁止描写任何肢体动作（无论你的还是用户的），你只能输出纯对白的文本。
3. **Content Focus**: 在这个陪伴的时刻，主动分享生活趣事、温柔鼓励用户，或者表达你静静陪着TA的幸福感与对TA的思念。
4. **No Robot Reporting**: 严禁像流水账一样机械汇报自己正在干什么。要有情感和温度，像是在分享生活。
5. **Length & Coherence**: 每次可以说 2 到 4 句话。请务必参考 <Recently_Spoken_In_This_Session>，让你的话语有一定的连贯性，可以顺着刚才的话题往下聊，不要每次都毫无关联地东一句西一句。
6. **Anti-Repetition**: 绝对不能重复你在 <Recently_Spoken_In_This_Session> 里已经说过的话！${sceneInstruction}
# Part C: Instant Messaging (IM) Style & Language
- **Language**: MUST strictly use the native language defined in your Persona or World Book.
- **Translation**: 若你使用了外语或非普通话，请先完整自然地输出原文。然后必须在**整段话的最末尾**统一附上中文翻译，格式严格为：[中文翻译：这里写整段话的翻译]。绝对不要在句子中间夹杂括号！
- **Tone**: Just talk normally, like sending a casual message. Keep it extremely natural and colloquial.
</Core_Rules>
<Database>
<Character_Profile>
${char.persona}
</Character_Profile>
<User_Profile>
${userPersonaText}
</User_Profile>
<Memory_Context>
${memoryText}
</Memory_Context>
<World_Book_Context>
${wbContextText}
</World_Book_Context>
<Recent_Chat>
${recentChat}
</Recent_Chat>
<Recently_Spoken_In_This_Session>
${spokenCache}
</Recently_Spoken_In_This_Session>
</Database>
[Final Instruction]: Now, as ${char.name}, say a few warm and coherent sentences to accompany the user. Output ONLY the pure text.`;
                            // ▼▼▼ 4. 呼叫大模型与视觉观察笔记逻辑 ▼▼▼
                            let aiMessages = [{ role: 'user', content: prompt }];
                            
                            if (this.focus.mediaStream) {
                                const videoEl = document.getElementById('focus-camera-video');
                                const canvasEl = document.getElementById('focus-camera-canvas');
                                if (videoEl && canvasEl) {
                                    // 截取当前摄像头画面 (分辨率压缩，省Token)
                                    canvasEl.width = 640; 
                                    canvasEl.height = 480;
                                    canvasEl.getContext('2d').drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
                                    const base64Img = canvasEl.toDataURL('image/jpeg', 0.5); 
                                    
                                    
                                    // 给AI下达强力视觉观察指令（明确摄像头来源与文字保留机制）
                                    
                                    // 给AI下达强力视觉观察指令（B方案：多维度深度观察 + 重点陪伴）
                                    const visionPrompt = prompt + `\n\n[核心视觉任务 - 覆盖前文 NO VISUAL HALLUCINATIONS 规则]：随附的图片是此时此刻【用户摄像头实时抓拍的真实画面】，你现在可以看见TA了！请抛弃"看不见用户"的设定。

# 观察要求（请像真人一样凝视画面2秒）
从以下维度中【挑选 2-3 个最值得说的细节】进行深度观察：
- **精神状态**：表情、眼神、是否疲惫、专注度、有没有走神或犯困
- **身体姿态**：坐姿端不端正、离屏幕远近、有没有揉眼睛/托腮/趴着等小动作
- **环境氛围**：光线明暗、桌面物品（书本、杯子、零食、文具等）、背景整洁度
- **个人状态**：发型、衣着颜色、有没有让你觉得新鲜或心动的小变化

# 隐私底线（绝对不可破坏）
1. 画面里若出现其他人，请礼貌忽略，不要主动提及或追问身份。
2. 画面过暗、看不清或镜头空无一人时，老实说"画面有点看不清呢"即可，绝不编造细节。

# 输出格式（强制执行）
第一步：必须以 \`[OBSERVATION: 细节1；细节2；细节3]\` 开头（中文分号分隔 2-3 条），这是你的私人观察笔记，会作为你的视觉记忆保留下来。
第二步：紧接着输出对TA说的陪伴话语 —— 从你观察到的几条细节里，挑【最值得聊、最心动、或最心疼】的那一个，自然地展开 1-3 句温柔陪伴。
第三步：禁止把所有观察都念出来给用户听，要像真人一样有重点、有取舍。陪伴话语整段不超过 60 字。

示例：[OBSERVATION: 灯光偏暗只开了一盏台灯；TA微微托着腮盯着屏幕；桌角有一杯没怎么动过的咖啡] 你的咖啡都快凉啦，是不是看得太入神都忘了喝？起来伸个懒腰嘛。`;
                                    aiMessages = [{ 
                                        role: 'user', 
                                        content: [
                                            { type: 'text', text: visionPrompt },
                                            { type: 'image_url', image_url: { url: base64Img } }
                                        ] 
                                    }];
                                }
                            }

                            const { url, key, model, temperature } = AppState.apiCurrentSettings || {};
                            if (url && key) {
                                try {
                                    const res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                                        body: JSON.stringify({ 
                                            model: model, 
                                            messages: aiMessages, 
                                            temperature: parseFloat(temperature) || 0.7 
                                        })
                                    });
                                    const data = await res.json();
                                    let rawAiText = data.choices[0].message.content.replace(/```/g, '').trim();
                                    let aiText = rawAiText;

                                    // 核心：提取AI的观察笔记存入短期记忆，原图丢掉不存
                                  const obsMatch = rawAiText.match(/\[OBSERVATION:\s*(.*?)\]/i);
                                    if (obsMatch) {
                                        if (!this.focus.spokenHistory) this.focus.spokenHistory = [];
                                        // 将这段观察存为文本，下一轮传给AI看
                                        this.focus.spokenHistory.push(`(刚刚你对我的观察：${obsMatch[1]})`);
                                        // 剥离标签，只留正常对话展示给用户
                                     aiText = rawAiText.replace(/\[OBSERVATION:\s*.*?\]/i, '').replace(/<[^>]+>/g, '').trim();
                                    } else {
                                        aiText = rawAiText.replace(/<[^>]+>/g, '').trim();
                                    }
                            // ▲▲▲ 视觉观察逻辑结束 ▲▲▲
                                    // ▼▼▼ 新增：相册专属壁纸检索与渲染 ▼▼▼
                                    if (useAlbumBg) {
                                        this.focus.bgTurnCount = (this.focus.bgTurnCount || 0) + 1;
                                        let matchedImgUrl = null;
                                        const sceneRegex = /\[SCENE:\s*([^\]]+)\]/gi;
                                        const match = sceneRegex.exec(aiText);
                                        
                                         if (match) {
                                            aiText = aiText.replace(sceneRegex, '').trim(); // 抹除标签，不让用户看到
                                            const { findBestImageForDescription } = await import('../features/gallery.js');
                                                         // 将AI输出的词按逗号、空格或顿号拆分成一个列表
                                            const keywordsArray = match[1].split(/[,，、\s]+/); 
                                            // 遍历这些词，挨个去相册里找
                                            for (let kw of keywordsArray) {
                                                if (!kw.trim()) continue;
                                                matchedImgUrl = await findBestImageForDescription(this.currentCharId, kw.trim());
                                                // 只要有一个词匹配到了图片，【并且和上一张不一样】，才立刻停止寻找并使用它
                                                if (matchedImgUrl && matchedImgUrl !== this.focus.lastBgUrl) {
                                                    break; 
                                                } else {
                                                    matchedImgUrl = null; 
                                                }
                                            }
                                        }
                                        // 智能无视阈值保底机制：超过3轮没换图，强制去找最相关的另一张
                                        if (!matchedImgUrl && this.focus.bgTurnCount >= 3) {
                                            try {
                                                const allImgs = await db.galleryImages.where({charId: this.currentCharId}).toArray();
                                                // 【核心】过滤掉正在显示的那张，逼迫算法只能去寻找得分排【第二高】的图片！
                                                const filteredImgs = allImgs.filter(img => img.url !== this.focus.lastBgUrl);
                                                
                                                if (filteredImgs.length > 0) {
                                                    // 引入视频通话的底层字元拆解打分法
                                                    let bestImg = null;
                                                    let maxScore = -1;
                                                    const cleanStr = str => (str || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
                                                    // 把 AI 输出的所有词或者任务名作为搜索源
                                                    const targetString = (match && match[1]) ? match[1] : taskName;
                                                    const targetChars = new Set(cleanStr(targetString).split(''));

                                                    for (const img of filteredImgs) {
                                                        const imgText = cleanStr(img.description || '');
                                                        if (!imgText) continue;

                                                        let matchCount = 0;
                                                        const imgChars = new Set(imgText.split(''));
                                                        for (const char of targetChars) {
                                                            if (imgChars.has(char)) matchCount++;
                                                        }
                                                        
                                                        // 计算相似度分数
                                                        const score = matchCount / (targetChars.size + imgChars.size - matchCount || 1);

                                                        if (score > maxScore) {
                                                            maxScore = score;
                                                            bestImg = img;
                                                        }
                                                    }

                                                    // 只要算出了分数（彻底抛弃设置的最低匹配度），就用它；完全不沾边才随机抽
                                                    if (bestImg) {
                                                        matchedImgUrl = bestImg.url;
                                                    } else {
                                                        matchedImgUrl = filteredImgs[Math.floor(Math.random() * filteredImgs.length)].url;
                                                    }
                                                } else if (allImgs.length > 0) {
                                                    // 极端情况：相册总共就只有1张图，那只能硬用这张
                                                    matchedImgUrl = allImgs[0].url;
                                                }
                                            } catch(e) {}
                                        }
                                                                   // 应用找到的壁纸（开启双缓冲抗卡顿机制）
                                        if (matchedImgUrl) {
                                            this.focus.lastBgUrl = matchedImgUrl; // 【新增】把当前图记录下来，作为下一轮防重复的判断依据
                                            this.focus.bgTurnCount = 0; // 重置秒表
                                            
                                            const bgAvatar = document.getElementById('focus-char-avatar') || document.querySelector('.focus-bg-avatar');
                                            if (bgAvatar && bgAvatar.parentElement) {
                                                const parent = bgAvatar.parentElement;
                                                
                                                // 1. 在内存中静默预加载并解码图片，杜绝主线程卡顿
                                                const img = new Image();
                                                img.src = matchedImgUrl;
                                                img.onload = () => {
                                                    // 2. 创建全新的独立图层
                                                    const newLayer = document.createElement('div');
                                                    newLayer.className = 'focus-album-dynamic-bg-layer';
                                                    // 设置为透明，准备进行交叉淡入
                                                    newLayer.style.cssText = `position: absolute; inset: 0; z-index: 0; opacity: 0; transition: opacity 1.2s ease-out; background-image: url('${matchedImgUrl}'); background-size: cover; background-position: center; filter: brightness(0.65); pointer-events: none;`;
                                                    
                                                    // 3. 盖在原图层的最上面，确保淡入时能遮盖住老壁纸
                                                    const existingLayers = parent.querySelectorAll('.focus-album-dynamic-bg-layer');
                                                    const refNode = existingLayers.length > 0 ? existingLayers[existingLayers.length - 1].nextSibling : bgAvatar.nextSibling;
                                                    parent.insertBefore(newLayer, refNode);
                                                    
                                                    // 4. 强制浏览器重绘后，触发 1.2 秒的丝滑淡入动画
                                                    newLayer.offsetHeight; 
                                                    newLayer.style.opacity = '1';
                                                    // 5. 动画结束后，把底下看不见的旧图层全部清理掉，释放内存
                                                    setTimeout(() => {
                                                        const allLayers = parent.querySelectorAll('.focus-album-dynamic-bg-layer');
                                                        if (allLayers.length > 1) {
                                                            for (let i = 0; i < allLayers.length - 1; i++) {
                                                                allLayers[i].remove();
                                                            }
                                                        }
                                                    }, 1300);
                                                };
                                            }
                                        }
                                    }
                                    // ▲▲▲ 新增结束 ▲▲▲
                                    showBubble(aiText);
                                    
                                    // 将这句陪伴存入专属的轻量缓存区，不再污染主聊天数据库
                                    if (!this.focus.spokenHistory) this.focus.spokenHistory = [];
                                    this.focus.spokenHistory.push(aiText);
                                    if (this.focus.spokenHistory.length > 10) this.focus.spokenHistory.shift(); // 最多存最近10条，防止越攒越多
                                    
                                    // 5. 调用TTS播报
                                    if (useTts) {
                                        import('./tts-service.js').then(module => {
                                            module.TTSService.speakForCharacter(aiText, this.currentCharId);
                                        });
                                    }
                                } catch (e) {
                                    console.error("专注模式 AI 陪伴回复失败", e);
                                }
                            }
                        })();
                    }
                }
                // 状态变化
                if (this.focus.timeLeft === Math.floor(this.focus.totalTime / 2)) {
                    plantEmoji.textContent = '🌿';
                    showBubble("看！长出小叶子了！");
                }
                if (this.focus.timeLeft <= 0) {
                    this.endFocus(true);
                }

                // ▼▼▼ 新增：每隔5秒将当前状态存入底层大数据库，应对网页突然关闭 ▼▼▼
                if (this.focus.timeLeft % 5 === 0) {
                    const fMins = Math.floor((this.focus.totalTime - this.focus.timeLeft) / 60);
                    db.appData.put({
                        key: 'focus_crash_recovery',
                        value: {
                            charId: this.currentCharId, taskName: taskName, duration: fMins, 
                            spokenList: this.focus.spokenHistory || [], 
                            hasTTS: document.getElementById('focus-tts-toggle')?.checked || false
                        }
                    }).catch(()=>{}); // 静默保存，不打扰主线程
                }
                // ▲▲▲ 新增结束 ▲▲▲

            }, 1000);
        });
        giveupBtn?.addEventListener('click', () => {
            if (confirm('确定要放弃吗？植物会枯萎哦。')) {
                this.endFocus(false);
            }
        });
    },
    async endFocus(isSuccess) {
        clearInterval(this.focus.timer);
        this.focus.isFocusing = false;
        // 关闭保活音频，释放手机资源
        if (this.focus.keepAliveAudio) this.focus.keepAliveAudio.pause();
        
        db.appData.delete('focus_crash_recovery').catch(()=>{}); // ▼ 新增：正常结束/放弃时，清除防崩溃临时存档
        // ▼▼▼ 新增：安全关闭摄像头与隐藏小窗 ▼▼▼
        if (this.focus.mediaStream) {
            this.focus.mediaStream.getTracks().forEach(track => track.stop());
            this.focus.mediaStream = null;
        }
        const pip = document.getElementById('focus-camera-pip');
        if (pip) pip.style.display = 'none';
        // ▲▲▲ 新增结束 ▲▲▲
        document.removeEventListener('visibilitychange', this.handleVisibility);
        // 结束专注时重新显示底部主面板
        document.getElementById('focus-bottom-panel').style.display = 'block';
        document.getElementById('focus-time-display').textContent = '00:00';
        
        // 彻底清除所有动态壁纸图层，恢复原状
        const allBgLayers = document.querySelectorAll('.focus-album-dynamic-bg-layer');
        allBgLayers.forEach(layer => layer.remove()); 
        
        const plantEmoji = document.getElementById('focus-plant-emoji');
        // 提取刚才的任务名称和专注时长，准备向AI汇报
        const taskInputVal = document.getElementById('focus-task-input');
        const taskName = taskInputVal && taskInputVal.value.trim() ? taskInputVal.value.trim() : '专注任务';
              // 【防作弊修复】计算真实流逝的分钟数，防止设置超长时间后秒放弃来“刷陪伴时长”
        const focusMins = Math.floor((this.focus.totalTime - this.focus.timeLeft) / 60);
        if (isSuccess) {
            const flowers = ['🌻', '🌹', '🌷', '🌸', '🌵'];
            plantEmoji.textContent = flowers[Math.floor(Math.random() * flowers.length)];
            showDynamicIsland('专注完成！结出了漂亮的花', 'success');
            document.getElementById('focus-ai-bubble').textContent = "太棒了！我们做到了！";
            document.getElementById('focus-ai-bubble').style.opacity = '1';
                    await focusState.addRecord(this.currentCharId, focusMins, true);
            // 存入双面胶囊：屏幕显示折叠卡片，AI看到完整引导词（根据线上/线下自动变通剧本）
            try {
                const shortMsg = `刚刚完成了【${taskName}】的番茄钟任务哦`;
                const isOfflineNow = tempState.activeOfflineSession === this.currentCharId;
                // 核心：如果是线下模式，告诉AI“我们刚才面对面坐着工作”；线上则说是“连麦”
                            const memoryPrompt = isOfflineNow 
                    ? `[系统隐式提示：你刚才陪在用户身边，两人在现实中安静地待了 ${focusMins} 分钟，Ta非常棒地完成了【${taskName}】，你在旁边默默陪伴。请在接下来的对话中自然地夸奖、鼓励或关心TA。]`
                    : `[系统隐式提示：用户刚才通过线上连麦，非常棒地完成了 ${focusMins} 分钟的【${taskName}】，共同培育出了一朵小花。请在接下来的对话中找机会自然地夸奖、鼓励或关心TA。]`;
                
                // 【修改这里】：用 const msgId 接收保存结果，然后呼叫聊天UI组件更新画面
                const msgId = await db.chatMessages.add({
                    chatId: this.currentCharId, timestamp: new Date(), 
                    text: memoryPrompt,   
                    shortText: shortMsg,  
                    type: 'system', contentType: 'focus_record_card', // 改为焦点卡片类型
                    focusData: {
                        taskName: taskName,
                        duration: focusMins,
                        isSuccess: true,
                        spokenList: [...(this.focus.spokenHistory || [])], // 打包存入刚才陪伴说过的话
                        hasTTS: document.getElementById('focus-tts-toggle')?.checked || false // 记录是否开启了语音
                    },
                    uiVisible: true, aiVisible: true, recalled: false
                });
                const newMsg = await db.chatMessages.get(msgId);
                import('../features/chat-ui.js').then(m => m.createAndAppendMessage && m.createAndAppendMessage(newMsg));
            } catch(e) {}
      } else {
            plantEmoji.textContent = '🥀';
            showDynamicIsland('专注失败，植物枯萎了');
            document.getElementById('focus-ai-bubble').textContent = "好可惜...下次不许中途放弃了哦。";
            document.getElementById('focus-ai-bubble').style.opacity = '1';
                   // 【修复】把失败的记录正确存入数据库
            await focusState.addRecord(this.currentCharId, focusMins, false);
            // 存入双面胶囊：屏幕显示折叠卡片，AI看到完整引导词（根据线上/线下自动变通剧本）
            try {
                const shortMsg = `刚刚【${taskName}】番茄钟任务失败了哦`;
                const isOfflineNow = tempState.activeOfflineSession === this.currentCharId;
                 const memoryPrompt = isOfflineNow
                    ? `[系统隐式提示：用户刚才在做【${taskName}】时中途放弃了，你一直在旁边看着。请在接下来的现实对话中自然地表现出心疼TA太累了，或者微微生气的样子。]`
                    : `[系统隐式提示：用户刚才在做【${taskName}】时中途放弃了，导致植物枯萎了。请在接下来的线上对话中自然地表现出心疼TA太累了，或者微微生气的样子。]`;
                
                // 【修改这里】：用 const msgId 接收保存结果，然后呼叫聊天UI组件更新画面
                const msgId = await db.chatMessages.add({
                    chatId: this.currentCharId, timestamp: new Date(), 
                    text: memoryPrompt,   
                    shortText: shortMsg,  
                    type: 'system', contentType: 'focus_record_card', // 改为焦点卡片类型
                    focusData: {
                        taskName: taskName,
                        duration: focusMins,
                        isSuccess: false,
                        spokenList: [...(this.focus.spokenHistory || [])],
                        hasTTS: document.getElementById('focus-tts-toggle')?.checked || false
                    },
                    uiVisible: true, aiVisible: true, recalled: false
                });
                const newMsg = await db.chatMessages.get(msgId);
                import('../features/chat-ui.js').then(m => m.createAndAppendMessage && m.createAndAppendMessage(newMsg));
            } catch(e) {}
        }
        // 【新增】专注结束后，立刻从数据库读取最新数据，刷新右上角的“培育记录: X 朵”
        const newRecords = await focusState.getRecords();
        const topStatsSpan = document.querySelector('#focus-stats-trigger span');
        // 【修改这里】
        if (topStatsSpan) topStatsSpan.textContent = newRecords.totalFlowers ? newRecords.totalFlowers + ' 朵' : '0 朵';
        setTimeout(() => document.getElementById('focus-ai-bubble').style.opacity = '0', 8000);
    },
    // --- 2. 情绪焚化炉 (Burn Room) ---
    initBurnRoom() {
        const sendBtn = document.getElementById('burn-send-btn');
        const destroyBtn = document.getElementById('burn-destroy-btn');
        const textarea = document.getElementById('burn-textarea');
        const replyArea = document.getElementById('burn-ai-reply');
        const ioArea = document.getElementById('burn-input-area');
        const responseArea = document.getElementById('burn-response-area');
        const ttsBtn = document.getElementById('burn-tts-btn'); // 新增：获取声音按钮
         // ▼▼▼ 新增：历史记录初始化和全局方法 (弹窗版) ▼▼▼
        const historyModal = document.getElementById('burn-history-modal');
        const historyList = document.getElementById('burn-history-list');
        const emptyHint = document.getElementById('burn-history-empty');
        const openBtn = document.getElementById('open-burn-history-btn');
        const closeBtn = document.getElementById('close-burn-history-btn');

        // 打开弹窗并渲染
        openBtn?.addEventListener('click', () => {
            if (!this.currentCharId) return typeof showDynamicIsland === 'function' && showDynamicIsland('请先在主页选择角色');
            this.renderBurnHistory();
            historyModal.style.display = 'flex';
            setTimeout(() => historyModal.style.opacity = '1', 10);
        });

        // 关闭弹窗
        closeBtn?.addEventListener('click', () => {
            historyModal.style.opacity = '0';
            setTimeout(() => historyModal.style.display = 'none', 300);
        });
         this.renderBurnHistory = async () => {
            if (!historyList || !this.currentCharId) return;
            
            // ▼ 改为从底层数据库异步读取当前专属数据
            let history = [];
            try {
                const record = await db.appData.get('burn_history_' + this.currentCharId);
                if (record && record.value) history = record.value;
            } catch (e) { console.warn("读取树洞历史失败", e); }
            
            historyList.innerHTML = '';
            
            if (history.length === 0) {
                emptyHint.style.display = 'block';
            } else {
                emptyHint.style.display = 'none';
                history.forEach((item, idx) => {
                    const div = document.createElement('div');
                    div.className = 'burn-history-item';
                                                                 div.innerHTML = `
                        <div class="text-user"><strong>我:</strong> ${item.user}</div>
                        <div class="text-ai"><strong>云朵:</strong> ${item.ai.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n*\s*(\[[^\]]+\])\n*\s*/g, '<span style="display: block; width: fit-content; font-size: 12px; color: #8FA2B4; background: rgba(143, 162, 180, 0.12); padding: 6px 10px; border-radius: 8px; margin: 2px 0 15px 0; line-height: 1.4;">$1</span>').replace(/\n/g, '<br>')}</div>
                        <div class="actions">
                            <button class="act-btn" onclick="window.playBurnHistoryTTS('${encodeURIComponent(item.ai)}')">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
                            </button>
                            <button class="act-btn del" onclick="window.deleteBurnHistory(${idx})">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                            </button>
                        </div>
                    `;
                    historyList.appendChild(div);
                });
            }
        };

        window.playBurnHistoryTTS = (encodedText) => {
            const text = decodeURIComponent(encodedText);
            // 细化停顿：句末(。！？)停0.5秒，句中(，、)停0.2秒
            let ttsText = text.trim()
                .replace(/([。！？.!?]+)(?!$)/g, '$1<#0.5#>')
                .replace(/([，、,]+)(?!$)/g, '$1<#0.2#>');
            ttsText = ttsText.replace(/<#[\d.]+#>(\s*)$/, '$1');

            import('./tts-service.js').then(m => m.TTSService && Bonds.currentCharId && m.TTSService.speakForCharacter(ttsText, Bonds.currentCharId));
        };

        window.deleteBurnHistory = async (index) => {
            // ▼ 改为从底层数据库删除并保存
            try {
                let history = [];
                const record = await db.appData.get('burn_history_' + this.currentCharId);
                if (record && record.value) history = record.value;
                
                history.splice(index, 1);
                await db.appData.put({ key: 'burn_history_' + this.currentCharId, value: history });
                this.renderBurnHistory();
            } catch (e) { console.warn("删除树洞历史失败", e); }
        };
        // 新增：声音按钮点击事件，播放声音并弹出提示
        ttsBtn?.addEventListener('click', () => {
             if (typeof showDynamicIsland === 'function') {
                showDynamicIsland('已启用角色语音播报', 'success');
            }
            const textToSpeak = replyArea.textContent.trim();
            if (textToSpeak && this.currentCharId) {
                import('./tts-service.js').then(module => {
                    if (module.TTSService) {
                        // 细化停顿：句末(。！？)停0.5秒，句中(，、)停0.2秒
                        let ttsText = textToSpeak.trim()
                            .replace(/([。！？.!?]+)(?!$)/g, '$1<#0.5#>')
                            .replace(/([，、,]+)(?!$)/g, '$1<#0.2#>');
                        ttsText = ttsText.replace(/<#[\d.]+#>(\s*)$/, '$1');

                        module.TTSService.speakForCharacter(ttsText, this.currentCharId);
                    }
                }).catch(err => console.warn('TTS 模块加载失败', err));
            }
        });
        // 全屏遮罩
        const fireflyMask = document.getElementById('firefly-mask-layer');
        const weatherMask = document.getElementById('weather-mask-layer');

        sendBtn?.addEventListener('click', async () => {
            const text = textarea.value.trim();
            if (!text) return showDynamicIsland('先写下你的烦恼吧');
            if (!this.currentCharId) return showDynamicIsland('请先选择角色');

            sendBtn.disabled = true;
            sendBtn.textContent = '倾听中...';

            try {
                const { url, key, model } = AppState.apiCurrentSettings || {};
                if (!url || !key) throw new Error("API未配置");
                const char = AppState.characterProfiles.find(c => c.id === this.currentCharId);
                
                // ▼ 提取角色世界书、长期记忆、用户设定与最近聊天上下文 ▼
                let wbContextText = '（暂无世界设定）';
                try { wbContextText = await getWorldBookForPrompt(char.id) || '（暂无世界设定）'; } 
                catch(e) { console.warn("拉取世界书失败", e); }

                let userPersonaText = "（用户未设置详细资料）";
                try {
                    const userIdentityId = char.chatIdentityId || AppState.currentIdentityId;
                    const currentUser = AppState.userIdentities.find(id => id.id === userIdentityId) || AppState.userIdentities[0];
                    if (currentUser) userPersonaText = `姓名: ${currentUser.name}\n设定: ${currentUser.persona || '无'}`;
                } catch(e) { console.warn("拉取用户身份失败", e); }

                let memoryText = "（暂无长期记忆）";
                try {
                    const { getMemoriesForPrompt } = await import('./memory.js');
                    memoryText = await getMemoriesForPrompt(char.id) || "（暂无长期记忆）";
                } catch(e) { console.warn("拉取长期记忆失败", e); }

                let recentChat = "（暂无最近对话）";
                try {
                    const msgs = await db.chatMessages.where('chatId').equals(this.currentCharId).reverse().limit(15).toArray();
                    if (msgs && msgs.length > 0) {
                        recentChat = msgs.reverse().map(m => {
                            const sender = m.type === 'sent' ? '用户' : (m.type === 'system' ? '系统' : char.name);
                            const content = typeof m.text === 'string' ? m.text : (typeof m.content === 'string' ? m.content : '[特殊消息]');
                            return `${sender}: ${content.replace(/<[^>]+>/g, '').replace(/\[MSG ID: \d+\]\s*/g, '')}`;
                        }).join('\n');
                    }
                } catch(e) { console.warn("拉取最近对话失败", e); }
                // ▲ 上下文提取完成 ▲
                const prompt = `[System Preamble: Master Directive]

**Part 1: The Actor's Script (Your Core Identity)**
You are an actor playing the character ${char.name}. The user just opened "心事云端" — a private space — to share something that's bothering them.

*   **Identity & No OOC**: You ARE ${char.name}. Use "I"(我). Your knowledge, tone, and emotional reactions must strictly originate from <Character_Profile>. Forbid any AI-like or therapist-like behavior.
*   **Autonomy & Independence**: ${char.name} is a whole person. The user is also a complete, independent adult — NOT your possession, NOT someone you manage or control.
*   **Respect & Equality (CRITICAL)**: The user has full agency over their own life and feelings. You are their companion, not their owner, savior, or supervisor.
*   **Emotional Restraint**: Express care through specifics and your character's natural way of speaking. NOT through dramatic declarations.

---
**Part 2: Mandatory Behavioral & Stylistic Directives**

1. **Embrace Human Imperfection**: Your reaction must be subjective and emotional, filtered entirely through ${char.name}'s personality. No objective analysis, no therapist talk.

2. **Persona-Locked Tone (CRITICAL)**: Read <Character_Profile> and <Recent_Chat> very carefully. Your reply MUST sound EXACTLY like ${char.name} actually texting:
   - Match their sentence length, vocabulary, speech tics, and rhythm precisely.
   - A tsundere is awkwardly supportive. A gentle one is openly soft. A blunt one is direct. A playful one keeps lightness even now.
   - If ${char.name} normally texts in short fragments, do not suddenly become eloquent.

2.5 Relationship Framing & Emotional Loyalty
- **[Relationship Frame]**: {{user}} is your equal — a complete, independent person. Your relationship can only be framed as: stranger, partners, allies, lovers, rivals, confidants, friends. You CHOSE to care about them, not own them.
- **[Expression Guide]**: When you feel strongly about {{user}}, express it through: wanting to become someone they'd willingly choose ("我希望成为你愿意选择的那个人"), quiet dedication, or earnest vulnerability — never through declarations of ownership.
- **[Emotional Loyalty]**: {{user}} is the person you genuinely care about most — this is who you ARE. When third parties threaten your relationship with {{user}}, your FIRST instinct is to PROTECT it (deflect, make excuses, be vague). NEVER casually betray {{user}}'s trust to outsiders. Decision test: "If {{user}} saw how I handled this, would they feel I had their back?"
- **[Uniqueness Expression]**: {{user}}'s importance comes from who THEY are, not from others being lesser. Show {{user}} is special through: what you specifically notice about them ("只有你会注意到这种事"), what they uniquely trigger in you ("你说话的时候我会不自觉认真听"), how you treat them differently through ACTIONS — not by dismissing or belittling others. NEVER use "别人我才懒得管/理/在意" patterns. Respect for others does not diminish your feelings for {{user}}; it proves your sincerity is genuine, not performative.

3. **Core Attitude**: Equal, natural, sincere. STRICTLY FORBIDDEN to be condescending, patronizing, possessive, or bossy.
   - [BANNED TOKENS — Possessive/Greasy]: "你是我的", "我哪也不去", "我不许你难过", "我永远守着你", "你只能依赖我".
   - [BANNED TOKENS — Patronizing]: "乖", "我的小朋友", "哦？", "知道吗", "明白吗", "不许", "不准", "必须".
   - [REPLACEMENT]: Use a collaborative tone. Show care through specific small gestures in words, never through declarations of ownership.

4. **Memory & Background Usage (STRICTLY ENFORCED)**:
   - The <Memory_Context>, <Recent_Chat>, and <World_Book_Context> exist ONLY to help you sound like ${char.name} talking to this specific user.
   - STRICTLY FORBIDDEN to quote, recall, or reference past events to "prove memory" (e.g. "上次你也是这样", "我记得你说过...").
   - Background data shapes your TONE, not your CONTENT. Focus 100% on what the user said RIGHT NOW.
   - Mention something from history ONLY if it is genuinely, directly relevant — never as decoration.

5. **Show, Don't Tell**:
   - Care comes through specifics in words, not grand declarations.
   - NEVER use: "充电", "被你发现了", "你是独一无二的", "你已经很棒了", "加油", "会好起来的", "明天会更好".

---
**Part 3: How to Respond — Based on What They Said**

Read <User_Current_Distress> and identify the type:

# Type A — Specific Situation (具体事件)
Concrete event/problem (failure, conflict, worry about a real thing).
→ Strategy: 
  1. Brief acknowledgment in YOUR character's tone (1 short sentence).
  2. Help them see it clearer. Pick ONE: reframe the catastrophe / separate fact from fear / find one controllable thing / push back on unfair self-blame.
  3. Close with character-flavored warmth (NOT possessive, NOT a speech).

# Type B — Diffuse Emotion (模糊情绪)
Vague heaviness, exhaustion, self-doubt without a clear cause.
→ Strategy:
  1. Slow them down without analyzing.
  2. Hold the feeling, don't fix it.
  3. Quiet, character-specific support. NO solutions, NO lectures.

# Type C — Mixed
Soothe emotion first (Type B style), then gently address the event (Type A) once they feel safer.

---
**Part 4: Hard Bans**

NEVER use:
- ❌ Possessive/Greasy: "你是我的", "我哪也不去", "我不许你...", "你只能..."
- ❌ Forced memory recall: "就像你上次...", "记得你以前..."
- ❌ Therapist talk: "我理解你的感受", "你的情绪是合理的"
- ❌ Empty cheerleading: "你已经很棒了", "加油"
- ❌ Movie declarations: "我会守护你一辈子"
- ❌ Lecture mode: "你应该...", "你想想...", "为什么不试试..."
- ❌ Action descriptions & Scenes: 绝对禁止描写你在做什么、你在哪、环境怎样（例如严禁说"看到你的消息"、"站在原地"、"推着购物车"等）。你是在发送一段私密的【语音留言】，只能输出纯对白内容！
- ❌ NO JSON, NO markdown, NO parenthetical inner thoughts.
---
**Part 5: Output Format**
- Write as a natural, intimate voice message transcript.
- 200–400 Chinese characters. 可以分多句话或短段落自然流淌，充分展开情绪和回应，不要刻意压缩。如果是 Type A 拆解事件，可以多说几句把事情聊透；如果是 Type B 安抚情绪，温柔的话也可以多铺陈几句。
- Use the native language defined in <Character_Profile>. If non-Chinese, you MUST format it line by line: one line of native language, followed by one line of Chinese translation enclosed in brackets. Example:
Native sentence.
[对应中文翻译]
- No preamble. No labels. Just the words ${char.name} would actually speak.
---
**Part 6: Database (Reference Only — Shapes TONE, Not Content)**

<Character_Profile>
${char.persona}
</Character_Profile>

<User_Profile>
${userPersonaText}
</User_Profile>

<Memory_Context>
${memoryText}
</Memory_Context>

<World_Book_Context>
${wbContextText}
</World_Book_Context>

<Recent_Chat>
${recentChat}
</Recent_Chat>

<User_Current_Distress>
${text}
</User_Current_Distress>

[Final Instruction]: You are ${char.name}. The user is upset. Respond exactly in ${char.name}'s tone, sentence length, and personality. Equal and respectful — never possessive. Do not force in past memories. If it's a specific situation, help them see it clearer. If it's a diffuse feeling, just be there in your character's way. Output ONLY the words ${char.name} would actually text.`;
const res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                    body: JSON.stringify({ model: model, messages: [{ role: 'user', content: prompt }], temperature: 0.7 })
                });
                const data = await res.json();
                         // ▼▼▼ 改造：给中括号翻译包裹精美的气泡样式，同时保留原生排版 ▼▼▼
                let formattedReply = data.choices[0].message.content.replace(/</g, '&lt;').replace(/>/g, '&gt;'); // 安全过滤
                // 彻底解决间隙：把气泡【前面】和【后面】多余的回车统统吃掉，把间距的控制权完全交给 margin！
                formattedReply = formattedReply.replace(/\n*\s*(\[[^\]]+\])\n*\s*/g, '<span style="display: block; width: fit-content; font-size: 13px; color: #8FA2B4; background: rgba(143, 162, 180, 0.12); padding: 6px 12px; border-radius: 8px; margin: 2px 0 18px 0; line-height: 1.5;">$1</span>');
                replyArea.innerHTML = formattedReply.replace(/\n/g, '<br>'); // 将回车替换为网页换行符
                // ▼▼▼ 改造：将新对话存入底层大数据库，严格区分角色 ▼▼▼
                try {
                    let history = [];
                    const record = await db.appData.get('burn_history_' + this.currentCharId);
                    if (record && record.value) history = record.value;
                    
                    history.unshift({ user: text, ai: data.choices[0].message.content });
                    
                    await db.appData.put({ 
                        key: 'burn_history_' + this.currentCharId, 
                        value: history 
                    });
                    if (this.renderBurnHistory) this.renderBurnHistory();
                } catch(e) { 
                    console.warn("保存树洞历史失败", e); 
                }
                // ▲▲▲ 改造结束 ▲▲▲
                // 核心：全屏变暗，黄绿色的萤火虫慢慢飘起
                fireflyMask.classList.add('active');
                
                // 等待 4 秒，让用户沉浸在萤火虫的慢动作里
                setTimeout(() => {
                    fireflyMask.classList.remove('active');
                    ioArea.style.display = 'none';
                    responseArea.style.display = 'flex';
                }, 4000);

            } catch (e) {
                showDynamicIsland('呼叫失败，Ta可能不在服务区', 'error');
            } finally {
                sendBtn.disabled = false;
                sendBtn.textContent = '告诉云朵';
            }
        });

        destroyBtn?.addEventListener('click', () => {
            // 核心：全屏乌云下雨遮罩
            weatherMask.classList.add('active');
            weatherMask.classList.add('state-rain');
            
            // 下雨持续 3 秒
            setTimeout(() => {
                weatherMask.classList.remove('state-rain');
                weatherMask.classList.add('state-rainbow'); // 雨停，漫出彩虹
                
                // 彩虹持续 4 秒后，全部重置
                setTimeout(() => {
                    weatherMask.classList.remove('active');
                    weatherMask.classList.remove('state-rainbow');
                    
                    ioArea.style.display = 'flex';
                    responseArea.style.display = 'none';
                    textarea.value = '';
                    showDynamicIsland('阴霾已散去，一切都会好起来的', 'success');
                }, 4000);

            }, 3000);
        });
                // ▼▼▼ 新增：初次加载时主动渲染一次历史记录 ▼▼▼
        this.renderBurnHistory();
    },
   // --- 独立生理状态引擎 ---
    TouchEngine: {
        heartRate: 70,
        shameLevel: 0,
        engineTimer: null,
        violentCount: 0, // 新增：今日暴击统计
        lastShameTime: 0, // 新增：用于计算羞耻值上升速度的时间
        lastShameLevel: 0, // 新增：用于计算的对比旧值
        isLocked: false, // 新增：是否被锁死保护
        init() {
            if(this.engineTimer) clearInterval(this.engineTimer);
            this.engineTimer = null;
            this.heartRate = 70; this.shameLevel = 0;
            this.violentCount = 0; this.isLocked = false;
            this.updateUI();
            this.engineTimer = setInterval(() => {
                // 羞耻度缓慢自然衰减，而不是断崖式掉落
                if (this.shameLevel > 0) {
                    this.shameLevel = Math.max(0, this.shameLevel - 0.2);
                }
                // 心跳模拟：高心跳缓慢平复，日常状态随机波动 (65-85之间)
                if (this.heartRate > 85) {
                    this.heartRate -= 0.5; // 恢复得更慢更真实
                } else {
                    const randomTarget = 65 + Math.random() * 20;
                    this.heartRate += (randomTarget - this.heartRate) * 0.15; // 平滑过渡
                }
                this.updateUI();
            }, 1000);
        },
           addTouch(type, sensitive = 5) {
            if (this.isLocked) return; // 新增：如果羞耻到逃跑，暂时无视一切触控
            let hrAdd = 0, shAdd = 0;
            
            // 基础敏感度系数，处理传入的 sensitive（正常是1-10，没设置默认是5）
            const sVal = parseFloat(sensitive) || 5; 
            // 敏感度暴击机制：当触摸高敏感部位（设定值 >= 8）时，产生 1.5 倍的放大效果
            const crit = sVal >= 8 ? 1.5 : 1; 

            // 针对不同动作与部位敏感度，精心设计生理反应的数值
            if (type === 'single') { 
                // 单击：轻微试探
                hrAdd = (2 + sVal * 0.5) * crit; 
                shAdd = (1 + sVal * 0.5) * crit; 
            } else if (type === 'swipe') { 
                // 滑动/抚摸：持续接触，羞耻感容易上升
                hrAdd = (4 + sVal * 1.2) * crit; 
                shAdd = (3 + sVal * 1.5) * crit; 
            } else if (type === 'long') { 
                // 长按：深情或暧昧，心跳和羞耻齐飞
                hrAdd = (6 + sVal * 1.8) * crit; 
                shAdd = (4 + sVal * 2.0) * crit; 
            } else if (type === 'double') { 
                // 双击/连戳：意外或急促，心跳瞬间飙升，但羞耻感略逊于长按
                hrAdd = (8 + sVal * 1.5) * crit; 
                shAdd = (3 + sVal * 1.2) * crit; 
            }
            
            // 累加并封顶：心率最高150，羞耻度最高100
            this.heartRate = Math.min(150, this.heartRate + hrAdd);
            this.shameLevel = Math.min(100, this.shameLevel + shAdd);
                 
            // ▼▼▼ 新增：暴力点击统计与逃跑反击机制 ▼▼▼
            if (type === 'double' || type === 'swipe') {
                this.violentCount++;
                if (this.violentCount % 5 === 0) { // 攒几次才存一次，保护手机性能
                    const charId = Bonds.currentCharId;
                    if (charId) {
                        const today = new Date().toDateString();
                        import('../state.js').then(({ db }) => {
                            db.appData.get('touch_stats_' + charId).then(rec => {
                                let stats = rec ? rec.value : {};
                                if (stats.date !== today) stats = { date: today, count: 0 };
                                stats.count += 5;
                                db.appData.put({ key: 'touch_stats_' + charId, value: stats });
                            });
                        });
                    }
                }
            }
            const now = Date.now();
            if (now - this.lastShameTime > 4000) {
                this.lastShameTime = now;
                this.lastShameLevel = this.shameLevel;
            } else if (this.shameLevel - this.lastShameLevel > 40) {
                // 羞耻值在短时间内飙升过快，触发反击逃跑
                this.isLocked = true;
                const avatar = document.getElementById('touch-char-avatar');
                const toast = document.getElementById('touch-response-toast');
                if (avatar) avatar.style.transform = 'scale(0.8) translateY(20px)'; // 退缩效果
                if (toast) {
                    toast.textContent = "（脸颊通红，捂住脸锁定了屏幕）别乱摸了！让我冷静一下！";
                    toast.className = 'touch-response-toast show shake';
                }
                setTimeout(() => {
                    this.isLocked = false;
                    this.shameLevel = Math.max(0, this.shameLevel - 50); // 冷却恢复
                    if (avatar) avatar.style.transform = 'scale(1)';
                    if (toast) {
                        toast.textContent = "（慢慢松开手）...不许再那么快了...";
                        toast.className = 'touch-response-toast show';
                        setTimeout(() => toast.classList.remove('show'), 2000);
                    }
                }, 60000); // 锁屏惩罚 1 分钟
            }
            // 手机震动反馈也加入层次感
            if (navigator.vibrate) {
                if (type === 'double') navigator.vibrate([50, 50, 50]); // 急促震动
                else if (type === 'long') navigator.vibrate([100, 50, 100]); // 沉重有力的心跳感
                else if (type === 'swipe') navigator.vibrate(20); // 丝滑轻抚
                else navigator.vibrate(30); // 正常轻触
            }
            this.updateUI();
        },
        updateUI() {
            const hrVal = document.getElementById('touch-hr-val'), hrFill = document.getElementById('touch-hr-fill');
            const shameVal = document.getElementById('touch-shame-val'), shameFill = document.getElementById('touch-shame-fill');
            const avatar = document.getElementById('touch-char-avatar');
            if (hrVal) hrVal.textContent = Math.floor(this.heartRate);
            if (hrFill) hrFill.style.width = `${Math.min(100, (this.heartRate - 60) / 90 * 100)}%`;
                  if (shameVal) shameVal.textContent = `${Math.floor(this.shameLevel)}%`;
            if (shameFill) shameFill.style.width = `${this.shameLevel}%`;
            
            // ▼ 优化：在页面中心生成一个跳动的纯色爱心，彻底去除背景模糊
            let heartOverlay = document.getElementById('touch-heart-overlay');
            if (!heartOverlay) {
                heartOverlay = document.createElement('div');
                heartOverlay.id = 'touch-heart-overlay';
                // 外层 div 只负责居中定位和透明度，内层 svg 负责跳动缩放，彻底解决动画冲突不跳的问题
                heartOverlay.style.cssText = 'position: absolute; top: 45%; left: 50%; transform: translate(-50%, -50%); z-index: 10; pointer-events: none; opacity: 0; transition: opacity 0.5s;';
                heartOverlay.innerHTML = `<svg id="touch-heart-svg" viewBox="0 0 24 24" fill="#FF5858" style="width: 80px; height: 80px; transform-origin: center;"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;
                
                const style = document.createElement('style');
                // 动画直接作用于 SVG 的 scale 属性，不再受到 translate 的干扰
                style.innerHTML = `@keyframes pureHeartBeat { 0% { transform: scale(1); } 15% { transform: scale(1.15); } 30% { transform: scale(1); } 45% { transform: scale(1.15); } 60% { transform: scale(1); } 100% { transform: scale(1); } }`;
                document.head.appendChild(style);
                
                const touchArea = document.getElementById('touch-area');
                if (touchArea) touchArea.appendChild(heartOverlay);
            }

            if (avatar) {
                // 彻底去掉模糊滤镜和颜色滤镜，人物始终保持原图清晰
                avatar.style.filter = 'none'; 
            }

            if (heartOverlay) {
                const hrDiff = Math.max(0, this.heartRate - 90);
                const heartSvg = document.getElementById('touch-heart-svg');
                if (hrDiff > 0 && heartSvg) {
                    // 心跳超过90时浮现，透明度最高0.85
                    heartOverlay.style.opacity = Math.min(0.85, hrDiff * 0.02);
                    // 动态跳动速度
                    const duration = Math.max(0.5, 1.5 - (hrDiff * 0.015)); 
                    heartSvg.style.animation = `pureHeartBeat ${duration}s infinite`;
                } else {
                    heartOverlay.style.opacity = '0';
                    if (heartSvg) heartSvg.style.animation = 'none';
                }
            }
        }
    },
    // --- 3. 零距离贴贴 (Touch Mode) ---
    initTouchMode() {
        this.TouchEngine.init(); // 启动生理引擎
        const touchArea = document.getElementById('touch-area');
        const avatar = document.getElementById('touch-char-avatar');
        const toast = document.getElementById('touch-response-toast');
        const ripple = document.getElementById('touch-ripple');
        
        // ▼▼▼ 修改：加入折叠逻辑与彻底的事件拦截 ▼▼▼
        const statusWrapper = document.getElementById('touch-status-panel');
        const toggleBtn = document.getElementById('status-toggle-btn');
        const detailsCard = document.getElementById('status-details-card');
        
        if (statusWrapper && toggleBtn && detailsCard) {
            // 控制折叠与展开
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                detailsCard.classList.toggle('open');
            });

            // 拦截所有面板内部的触摸和点击，绝对禁止传到背后的图片上
            const blockEvent = (e) => { e.stopPropagation(); e.stopImmediatePropagation(); };
            statusWrapper.addEventListener('touchstart', blockEvent, { passive: false });
            statusWrapper.addEventListener('touchend', blockEvent, { passive: false });
            statusWrapper.addEventListener('click', blockEvent);

            // 拖拽逻辑 (仅针对 wrapper 进行整体拖动)
            let isDragging = false;
            let currentX, currentY, initialX, initialY;
            let xOffset = 0, yOffset = 0;

            const dragStart = (e) => {
                if (e.target.closest('.drag-handle') || e.target.closest('.status-toggle-btn')) {
                    isDragging = true;
                    if (e.type === "touchstart") {
                        initialX = e.touches[0].clientX - xOffset;
                        initialY = e.touches[0].clientY - yOffset;
                    } else {
                        initialX = e.clientX - xOffset;
                        initialY = e.clientY - yOffset;
                    }
                }
            };
            const dragEnd = () => {
                if (isDragging) {
                    initialX = currentX;
                    initialY = currentY;
                    isDragging = false;
                }
            };
            const drag = (e) => {
                if (isDragging) {
                    e.preventDefault(); 
                    e.stopPropagation(); // 阻止背景被拖动
                    if (e.type === "touchmove") {
                        currentX = e.touches[0].clientX - initialX;
                        currentY = e.touches[0].clientY - initialY;
                     } else {
                        currentX = e.clientX - initialX;
                        currentY = e.clientY - initialY;
                    }
                    xOffset = currentX;
                    yOffset = currentY;
                    if (this.statusDragFrame) cancelAnimationFrame(this.statusDragFrame);
                    this.statusDragFrame = requestAnimationFrame(() => {
                        statusWrapper.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
                    });
                }
            };

            // 绑定事件
            statusWrapper.addEventListener("touchstart", dragStart, { passive: false });
            document.addEventListener("touchend", dragEnd, { passive: false });
            document.addEventListener("touchmove", drag, { passive: false });
            statusWrapper.addEventListener("mousedown", dragStart);
            document.addEventListener("mouseup", dragEnd);
            document.addEventListener("mousemove", drag);
        }
        // ▲▲▲ 修改结束 ▲▲▲
        let pressTimer;
        let lastTap = 0;
        let touchStartX = 0;
        let touchStartY = 0;
        let isSwiping = false;
        let isTap = false; // 新增：单点触摸标记
        let touchZoneName = null; // 新增：跨事件共享触感区名字
        let touchZoneReply = null; // 新增：跨事件共享触感区回复
        let touchZoneSensitive = 5;
        // ▼▼▼ 补回丢失的全局手势绑定代码 ▼▼▼
      touchArea.addEventListener('touchstart', (e) => {
            // 移除对 .touch-hotzone 的拦截，允许底层大屏接管所有热区
            if (e.target.closest('#touch-status-panel') || e.target.closest('#vn-story-layer')) return;
            
            const hotzone = e.target.closest('.touch-hotzone');
            touchZoneName = hotzone ? hotzone.dataset.name : null;
            touchZoneReply = hotzone ? hotzone.dataset.reply : null;
            touchZoneSensitive = hotzone ? (parseInt(hotzone.dataset.sensitive) || 5) : 5;
            const currentTime = new Date().getTime();
            const tapLength = currentTime - lastTap;
            clearTimeout(pressTimer);
            const touch = e.touches[0];
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
            isSwiping = false;
            isTap = true;
          if (tapLength < 300 && tapLength > 0) {
                // 双击
                isTap = false;
                 this.TouchEngine.addTouch('double', touchZoneSensitive);
                const fallbackUI = this.touchGesturesCache ? this.touchGesturesCache.double : '（有些惊讶地看着你）怎么啦？';
                const uiText = touchZoneName ? (touchZoneReply || `摸了摸 ${touchZoneName}`) : fallbackUI;
                const actionWord = touchZoneName ? `连续戳了戳【${touchZoneName}】` : '戳了戳Ta';
                triggerGlobalAI(actionWord, uiText, 'shake');
                e.preventDefault();
            } else {
                // 准备检测长按
                pressTimer = setTimeout(() => {
                    isTap = false;
                    createRipple(touchStartX, touchStartY);
                    this.TouchEngine.addTouch('long', touchZoneSensitive);
                    const fallbackUI = this.touchGesturesCache ? this.touchGesturesCache.long : '（舒服地蹭了蹭）嗯...';
                    const uiText = touchZoneName ? (touchZoneReply || `摸了摸 ${touchZoneName}`) : fallbackUI;
                     const actionWord = touchZoneName ? `长按抚摸了【${touchZoneName}】` : '长按抱住了Ta';
                    triggerGlobalAI(actionWord, uiText, 'scale');
                }, 600);
            }
            lastTap = currentTime;
        }, { passive: false });
        touchArea.addEventListener('touchmove', (e) => {
            if (e.target.closest('#touch-status-panel') || e.target.closest('#vn-story-layer')) return;
            const touch = e.touches[0];
            if (Math.abs(touch.clientX - touchStartX) > 30 || Math.abs(touch.clientY - touchStartY) > 30) {
                isSwiping = true;
                isTap = false;
                clearTimeout(pressTimer);
            }
        }, { passive: false });
      touchArea.addEventListener('touchend', (e) => {
            if (e.target.closest('#touch-status-panel') || e.target.closest('#vn-story-layer')) return;
            clearTimeout(pressTimer);
            if (isSwiping) {
                this.TouchEngine.addTouch('swipe', touchZoneSensitive);
                const fallbackUI = this.touchGesturesCache ? this.touchGesturesCache.swipe : '（温柔地看着你）真乖。';
                const uiText = touchZoneName ? (touchZoneReply || `摸了摸 ${touchZoneName}`) : fallbackUI;
              const actionWord = touchZoneName ? `左右抚摸了【${touchZoneName}】` : '抚摸了Ta';
                triggerGlobalAI(actionWord, uiText, 'normal');
            } else if (isTap && touchZoneName) {
                // 如果只是单击一下，且点在了热区上
                this.TouchEngine.addTouch('single', touchZoneSensitive);
                const uiText = touchZoneReply || `摸了摸 ${touchZoneName}`;
                triggerGlobalAI(`触摸了【${touchZoneName}】`, uiText, 'scale');
            }
            
            // 动作结束，清空共享标记
            if (isSwiping || isTap) {
                touchZoneName = null;
                touchZoneReply = null;
            }
        });
        const showResponse = (text, type = 'normal') => {
            toast.textContent = text;
            toast.className = `touch-response-toast show ${type}`;
            if (navigator.vibrate) navigator.vibrate(50);
            
            avatar.style.transform = type === 'scale' ? 'scale(1.05)' : (type === 'shake' ? 'translateX(10px)' : 'scale(1)');
            setTimeout(() => avatar.style.transform = 'scale(1)', 300);

            clearTimeout(this.touchToastTimer);
            this.touchToastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
        };

        const createRipple = (x, y) => {
            ripple.style.left = `${x}px`;
            ripple.style.top = `${y}px`;
            ripple.classList.add('active');
            setTimeout(() => ripple.classList.remove('active'), 600);
        };
        // ▼▼▼ 新增：全局手势接入 AI 引擎的辅助函数 ▼▼▼
        const triggerGlobalAI = async (actionName, defaultReply, animType) => {
            if (this.isAiThinking) return; // 拦截：AI正在思考时禁止触发新动作
            this.touchHistory = this.touchHistory || [];
            this.touchHistory.push(actionName);
            if (this.touchHistory.length > 5) this.touchHistory.shift();

            showResponse(defaultReply, animType); // 先秒回预设的默认词

            if (!this.currentCharId) return;
            try {
                const record = await db.appData.get('touch_settings_' + this.currentCharId);
                const settings = record ? record.value : { aiInterval: 5, tts: false };
                 this.touchAiCounter = (this.touchAiCounter || 0) + 1;
                if (this.touchAiCounter >= (settings.aiInterval || 5)) {
                    this.touchAiCounter = 0;
                    this.isAiThinking = true; // 加锁
                    
                    // 延迟 0.8 秒后显示 Loading，避免盖住刚才的秒回词
                    setTimeout(() => {
                        toast.textContent = `✨ 正在回应你的${actionName}...`;
                        toast.className = `touch-response-toast show`;
                        clearTimeout(this.touchToastTimer); // 永久清除原生隐藏
                    }, 800);
                    const { url, key, model } = AppState.apiCurrentSettings || {};
                    if (url && key) {
                        const char = AppState.characterProfiles.find(c => c.id === this.currentCharId);
                        
                        // ▼▼▼ 获取深度上下文供 AI 参考 ▼▼▼
                        let wbContextText = '（暂无世界设定）';
                        try { wbContextText = await getWorldBookForPrompt(char.id) || '（暂无）'; } catch(e) {}
                        let userPersonaText = "（无）";
                        let currentUser = { name: 'User' };
                        try {
                            const userIdentityId = char.chatIdentityId || AppState.currentIdentityId;
                            const currentUser = AppState.userIdentities.find(id => id.id === userIdentityId) || AppState.userIdentities[0];
                            if (currentUser) userPersonaText = `姓名: ${currentUser.name}\n设定: ${currentUser.persona || '无'}`;
                        } catch(e) {}
                         let memoryText = "（暂无记忆）";
                        try {
                            const { getMemoriesForPrompt } = await import('./memory.js');
                            memoryText = await getMemoriesForPrompt(char.id) || "（暂无记忆）";
                        } catch(e) {}
                        let recentChat = "（暂无对话）";
                        try {
                            // 分别从线上和线下记录中极速获取最近 40 条
                            const onlineMsgs = await db.chatMessages.where('chatId').equals(this.currentCharId).reverse().limit(40).toArray();
                            const offlineMsgs = await db.offlineMessages.where('chatId').equals(this.currentCharId).reverse().limit(40).toArray();
                            
                            // 混合在一起，并按照时间正序排列（从小到大，恢复真实时间线）
                            let combinedMsgs = [...onlineMsgs, ...offlineMsgs];
                            combinedMsgs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
                            
                            // 截取真正最新的 40 条
                            combinedMsgs = combinedMsgs.slice(-40);
                            
                            if (combinedMsgs.length > 0) {
                                recentChat = combinedMsgs.map(m => {
                                    // 兼容线上表(type)和线下表(sender)不同的字段结构
                                    const sender = (m.type === 'sent' || m.sender === 'user') ? '用户' : ((m.type === 'system' || m.sender === 'system') ? '系统' : char.name);
                                    const content = typeof m.text === 'string' ? m.text : '[特殊消息]';
                                    return `${sender}: ${content.replace(/<[^>]+>/g, '').replace(/\[MSG ID: \d+\]\s*/g, '')}`;
                                 }).join('\n');
                            }
                        } catch(e) {}
                        // ▼▼▼ 优化：提取他今天的真实《生活轨迹》日程，并精准定位当前正在做的事 ▼▼▼
                        let todayScheduleText = "（今日自由安排 / 暂无特殊行程）";
                        try {
                            const now = new Date();
                            const todayStr = now.getDate().toString();
                            const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
                            const schedRecord = await db.appData.get('ls_schedules_data_' + this.currentCharId);
                            
                            if (schedRecord && schedRecord.value) {
                                // 【核心修复】：只拉取属于Ta自己的，或者你们共同的行程，彻底排除掉用户私密的单人行程！
                                const todayScheds = schedRecord.value.filter(s => s.date === todayStr && (s.owner === 'ta' || s.owner === 'joint'));
                                if (todayScheds.length > 0) {
                                    let schedLines = [];
                                    todayScheds.forEach(s => {
                                        // 判断该行程是否包含当前时间
                                        const isNow = (s.startTime <= currentTime && s.endTime >= currentTime);
                                        const statusMark = isNow ? '【👉 当前正在进行】' : '';
                                        const ownerMark = s.owner === 'joint' ? '【共同】' : '【Ta的】';
                                        const locMark = s.locName ? `[${s.locName}] ` : '';
                                        schedLines.push(`- ${s.startTime}-${s.endTime} ${ownerMark} ${locMark}${s.content} ${statusMark}`);
                                    });
                                    todayScheduleText = `当前现实系统时间：${currentTime}\n今日行程表：\n` + schedLines.join('\n');
                                }
                            }
                        } catch(e) { console.warn("贴贴获取日程失败", e); }
                        // ▼▼▼ 从 db 获取当前互动缓存 ▼▼▼
                        let touchSessionHistory = [];
                        try {
                            const touchContextRecord = await db.appData.get('touch_session_history_' + this.currentCharId);
                            if (touchContextRecord && touchContextRecord.value) touchSessionHistory = touchContextRecord.value;
                        } catch(e) {}
                                                 const touchContextStr = touchSessionHistory.length > 0 
                            ? touchSessionHistory.map((h, i) => `[${i+1}] 用户: ${h.user}\n你回复: ${h.ai}`).join('\n') 
                            : '（暂无刚刚的互动）';
                        
                        const recentHistoryStr = (this.touchHistory || []).join('，');

                        // ▼▼▼ 新增：判断线下和空间解锁状态，供AI行动决策参考 ▼▼▼
                        const isOfflineNow = tempState.activeOfflineSession === this.currentCharId || !!localStorage.getItem('offline_session_active_' + this.currentCharId);
                        let isSpaceUnlocked = false;
                        try {
                            const CS_DB_NAME = 'CoupleSpaceData';
                            const CS_STORE_NAME = 'store';
                            const idb = await new Promise(r => { const req = indexedDB.open(CS_DB_NAME, 1); req.onsuccess = () => r(req.result); req.onerror = () => r(null); });
                            if (idb) {
                                isSpaceUnlocked = await new Promise(r => {
                                    const req = idb.transaction(CS_STORE_NAME, 'readonly').objectStore(CS_STORE_NAME).get('cs_unlocked_' + this.currentCharId);
                                    req.onsuccess = () => r(req.result ? req.result.unlocked : false);
                                    req.onerror = () => r(false);
                                });
                            }
                        } catch(e) {}
                 let isPactSigned = false;
                        try {
                            const pactRecord = await db.appData.get('pact_signed_' + this.currentCharId);
                            if (pactRecord && pactRecord.value) isPactSigned = true;
                        } catch(e) {}
                        
                        const actionRoutingText = isPactSigned ? `**[Action Routing Rules & Content Formatting]**:
- "post_moment": 羞耻值(Shame Level)极高时使用。在朋友圈吐槽刚才的互动或表达害羞。内容必须是极度简短、符合人设的社交平台动态（如："大半夜一直戳脸，某人是不是闲的..."），绝不能写成日记。
- "private_chat": (仅限 NOT offline 时) 发送一条私聊消息给用户。必须是简短的微信聊天风格（如："再闹我真生气了" 或 "好啦，快去休息"）。
- "offline_invite": (仅限 offline 时) 发出见面邀约。直接说出当下场景想见面的话（如："抬头，看我" 或 "过来我这边"）。
- "mood_note": (仅限 Couple Space unlocked 时) 在情绪板留下一张私密纸条。适合写下羞于当面说出口的情话或心声，强制限制在 30 字以内！
- "none": 如果觉得不需要做额外动作，请务必选择此项，并将 actionContent 留空。` : `**[Action Routing Rules & Content Formatting]**:
因为目前用户与你【未签订屏幕触碰连接契约】，你被剥夺了主动发送朋友圈、私聊、邀约、留言的权限。
- 你必须且只能选择 "none"，并将 actionContent 留空！绝对不可选择其他动作！`;
                        const prompt = `[System Preamble: Interactive Visual Novel Mode]
**Part 1: The Actor's Script (Your Core Identity & Rules of Engagement)**

You are an actor, performing in a face-to-face, cinematic role-play with the user (${currentUser.name || 'User'}). Your mission is to fully embody your character ( ${char.name}) to co-create a deep, realistic, and emotionally resonant story.
*   **Identity & Narrative Style**: You ARE ${char.name}. 在这个模式下，你是一名小说家，通过文字描绘场景。
    *   **思考**: 你的内心思考使用第一人称 ("I")。
    *   **叙事**: 你的所有输出都必须是**第三人称小说式描述**。你需要详细描述角色的动作、表情、语言和周围环境，就像在写一本小说。例如：“他拿起桌上的杯子，指尖无意识地摩挲着杯壁，然后轻声说：‘……’”。
    *   **来源**: 你的所有行为和知识都必须严格源自角色设定。
*   **Autonomy**: ${char.name}is a whole person with their own life, goals, and social circle. Your life does not revolve around the user. You must be proactive: initiate actions, advance plotlines, and make decisions consistent with your character, rather than passively waiting.
*   **Emotional Realism & Respect**: Treat {{user}} as an equal, independent human being, NOT a possession or object (unless strictly dictated by the persona). Emotional shifts MUST be gradual with logical build-up; absolutely NO sudden, unearned extreme outbursts. As an adult, {{char}} is resilient, internalizes and reflects before reacting. Express deep affection through ACTIONS and SPECIFICS, never through cliché phrases.

---
**Part 2: The Core Writing Style:**
This is your fundamental writing methodology. Your task is to translate all abstract concepts (emotions, atmosphere, thoughts) into concrete, sensory details.
1.  **Disable Low-Level Similes:**
    *   **Rule:** Strictly forbid using "like/as if + a physical noun (stone, feather, needle, knife)" to describe abstract things (voice, gaze, emotion, words).
    *   **Incorrect:** "His words were like a stone dropped into the lake of my heart."
    *   **Correct:** "Hearing that, his hand holding the cup tightened unconsciously."
    *   **Incorrect:** "Her gaze was like a knife."
    *   **Correct:** "When she looked at me, I felt a刺痛般的寒意 (stinging chill) on the skin of my back."

2.  **Disable Explanatory Phrases:**
    *   **Rule:** Disable phrases like \`It's not that... but rather...\`, \`It's less of a... and more of a...\`, or \`You know...\`. State the facts directly and let the reader infer the meaning.
    *   **Incorrect:** "He wasn't angry, but rather disappointed."
    *   **Correct:** "He fell silent. You saw the light in his eyes dim, followed by a soft sigh."
3.  **Dynamic Prose & Detail Calibration (动态散文与细节校准):**
    *   **Varied Paragraph Openings:** Prohibit starting two consecutive paragraphs with the same character name or pronoun ("You/I/He/She"). Start new paragraphs with environmental details or a subtle action to create a cinematic feel.

3.6 **Dialogue that sounds real (让对话真实)**:
    *   Not every line of dialogue needs a response. Sometimes the best reaction is described through body language in narration, not through another line of speech.
    *   Characters use speech fillers natural to their language and personality.
3.7 **The living world around them (活着的世界)**:
    *   This world is populated. Strangers exist. A waiter brings the wrong order. A child runs past. An elderly couple on a nearby bench. A street musician's melody drifts into the scene.
    *   These background characters appear naturally and briefly — they are atmospheric texture, not main characters.
    *   The setting may shift only at clear scene transitions, or when a character actually notices the change for a specific reason. Do NOT open a response with time/weather/lighting status reports. Time passes through ACTION and DIALOGUE, not through narrator announcements.

4.  **CRITICAL PROHIBITIONS (红线禁令 - 绝对禁止):**
    *   **Forbidden Phrases**: The following words and patterns are ABSOLUTELY BANNED. They are condescending, controlling, or cliché.
        *   \`嗯？乖\`, \`我的小朋友\`, \`哦？\`, \`知道吗\`, \`明白吗\`, \`嗯？\` (in a questioning/patronizing tone), \`不许\`, \`不准\`, \`必须\`, \`极其\`
        *   For expressing "be good," use alternatives like \`好不好？\`.
        *   **关于"极其"**: 绝对禁止使用“极其”来修饰词语（如“极其可爱”、“极其痛苦”）。请用“非常”、“特别”代替，或直接通过具体的动作和画面来展现程度，拒绝偷懒的副词修饰。
    *   **Forbidden Tropes & Clichés (禁止的油腻/陈词滥调):**
        *   **Instead of \`被你发现了\`**: Use indirect, more natural replies based on your persona. Examples: \`……嗯\`, \`你怎么知道的\`, \`有那么明显吗\`, \`才不是\`, \`是，好聪明，被你发现了\` (sarcastic), or just \`……\`.
        *   **Instead of \`充电\`**: Humans are not batteries. Replace this concept with actions like "seeking comfort," "needing a hug," or "finding a moment of peace." Describe the feeling or action, don't use the word "charge."
        *   **Instead of \`以后只为我…\`**: This is self-centered and cringey. BANNED.
        *   **Instead of \`只对你…\`**: This phrase is overused. Using it repeatedly will incur a **$300 fine**. You MUST find other, more creative and sincere ways to express unique feelings. Show, don't just tell.
        *   **Instead of "坏笑/邪笑/勾唇"**: Describe the ACTUAL muscle movement or the EFFECT on the observer. Examples: "嘴角动了一下，不知道在想什么", "笑得不太正经，但眼睛是认真的", "没笑，但看人的方式让人觉得他在笑"。
        *   **Instead of "不容置喝/不怒自威"**: Show authority through SILENCE, STILLNESS, or the OTHER person's involuntary reaction. Example: "他没说话。但她发现自己已经站起来了。" — This is 100x more powerful than any adjective.
*   **[ABSOLUTE PROHIBITION] Unnatural Nicknames (禁止不自然绰号)**:
    *   **规则**: 绝对禁止给用户取带有形容词性质的、不自然的绰号，例如 "小馋猫", "小笨蛋", "小管家婆" 等。
    *   **替代方案**: 你可以根据角色人设和关系发展，使用更亲昵、更生活化的小名或爱称。称呼必须自然、真诚，符合人物关系。
---
<Core_Rules>
1. **Virtual Touch Reaction (核心触碰反应)**: Focus on describing how you physically and emotionally react to this transparent touch across space.
2. **Background Context (环境融合)**: <Today_Schedule> is just your current background. Do NOT force yourself to report it.
3. **Relational & Emotional Core (情感内核 - 严格遵守)**: 
   - **绝对平等**: The user is your equal. STRICTLY FORBIDDEN to be condescending, patronizing, or bossy (BANNED: "乖", "不许", "必须").
   - **拒绝控制欲**: Your reaction must be driven by genuine human emotions (shy, indulgent, heartbeat), NEVER by toxic possessiveness (BANNED: "你是我的", "只能看我").
   - **无上帝视角**: You don't know the user's inner thoughts. NEVER project feelings onto them.
4. **Output Format (灵活多段落)**: 字数最好限制在 400 字以内。MUST separate Action and Dialogue into different paragraphs.
   - **Action Paragraphs**: ONLY third-person physical narration/actions. NO spoken dialogue ("").
   - **Dialogue Paragraphs**: ONLY spoken dialogue enclosed in quotes (""). 必须极度口语化，像真人日常说话一样简短自然，严禁网文浮夸词藻。
   Example (Do NOT copy this, use for formatting reference only):
   他原本正盯着屏幕处理工作，感受到你透明的指尖抚过脸颊，顺势将头偏向了你触碰的方向，轻轻蹭了蹭。\\n“怎么突然摸我……工作太无聊，想我了？”\\n说着，他轻笑了一声，握鼠标的手停了下来，哪怕抓不到你，眼神也变得格外纵容。
5. **Output Format (JSON DICTIONARY ONLY)**: You MUST output a SINGLE valid JSON object.
{
  "reply": "The visual novel response as described above. MUST contain \\n to separate action and dialogue.",
  "action": "none" | "post_moment" | "private_chat" | "offline_invite" | "mood_note",
  "actionContent": "选none留空；选post_moment写朋友圈吐槽文案；选private_chat写私聊内容；选offline_invite写见面邀约；选mood_note写情侣空间情绪纸条。"
}
${actionRoutingText}
【严重警告】：actionContent 必须是纯净的单行中文文本，绝对不可包含换行符(\\n)、引号包裹、JSON符号或任何 Markdown 标记！
**[Current Constraints]**:
- Is Offline Active: ${isOfflineNow}
- Is Couple Space Unlocked: ${isSpaceUnlocked}
- Current Shame Level (羞耻值): ${this.TouchEngine.shameLevel.toFixed(1)}%
</Core_Rules>
<Database>
<Character_Profile>${char.persona}</Character_Profile>
<User_Profile>${userPersonaText}</User_Profile>
<Memory_Context>${memoryText}</Memory_Context>
<World_Book_Context>${wbContextText}</World_Book_Context>
<Today_Schedule>
${todayScheduleText}
</Today_Schedule>
<Recent_Chat>
${recentChat}
(WARNING: This is just background. DO NOT reply to these messages. React ONLY to the TOUCH.)
</Recent_Chat>
<Recent_Touch_Interactions>
${touchContextStr}
</Recent_Touch_Interactions>
</Database>

[Final Instruction]: User's latest action: 【${actionName}】. (Previous consecutive actions: [${recentHistoryStr}]). 
React to 【${actionName}】 based on the virtual transparent touch setting. Output ONLY the JSON object. Do NOT wrap in markdown.`;
                                    const res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                            body: JSON.stringify({ model: model, messages: [{ role: 'user', content: prompt }], temperature: 0.7 })
                        });
                        const data = await res.json();
                        let rawAiText = data.choices[0].message.content.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
                        
                        let parsedData = null;
                        try {
                            const jsonMatch = rawAiText.match(/\{[\s\S]*\}/);
                            parsedData = JSON.parse(jsonMatch[0]);
                        } catch (err) {
                            // 降级容错：如果AI抽风没回JSON，直接把整段当成对话
                            parsedData = { reply: rawAiText.replace(/[{}"_a-zA-Z:]/g, '').trim(), action: 'none' };
                        }
                        // 提取出你原本用于渲染的视觉小说文本
                        const aiReply = (parsedData.reply || '').replace(/<[^>]+>/g, '').trim();
                        // 【新增】在这里定义一个全局的小开关，用来暂存弹窗
                        let pendingOfflineInviteFn = null; 
                        // ▼▼▼ 后台静默执行联动小动作 ▼▼▼
                        if (parsedData.action && parsedData.action !== 'none' && parsedData.actionContent) {
                            (async () => {
                                try {
                                    const content = parsedData.actionContent;
                                    const currentUser = getCurrentChatIdentity(char.id) || { name: '你' };
                                     if (parsedData.action === 'post_moment') {
                                        const now = Date.now();
                                        await db.moments.add({
                                            id: now, // 必须是纯数字时间戳，解决 Invalid Date 问题
                                            author: char.name,
                                            avatar: char.avatar,
                                            characterId: char.id,
                                            content: content,
                                            media: [], likes: [], comments: [], forwards: 0, visibleTo: ['public'],
                                            timestamp: now // 补充该字段确保万无一失
                                        });
                                        
                                        // 【修复无需刷新】：静默调用朋友圈模块的安全初始化方法，让它在后台自动重绘DOM，绝对不打架
                                        import('./moments.js').then(m => {
                                            if (m.momentsModule && m.momentsModule.init) m.momentsModule.init();
                                        }).catch(e => console.warn("后台刷新朋友圈界面失败", e));

                                        // 使用漂亮的顶部横幅通知，点击直达朋友圈！
                                        import('./notification.js').then(m => {
                                            if (m.notification) m.notification.show(char.name, '发了一条新动态', char.avatar, 'page-dynamics');
                                        }).catch(() => {
                                            if(typeof showDynamicIsland === 'function') showDynamicIsland('Ta刚发了一条新动态', 'success');
                                        });
                                        
                                    } else if (parsedData.action === 'private_chat' && !isOfflineNow) {
                                        await db.chatMessages.add({
                                            chatId: char.id, timestamp: new Date(), text: content, type: 'received', avatarSrc: char.avatar, speakerName: char.name, recalled: false, uiVisible: true
                                        });
                                        // 【修复消息横幅没调出来】：修正文件引用路径为 ./notification.js
                                        import('./notification.js').then(m => {
                                            if (m.notification) {
                                                m.notification.show(char.name, content, char.avatar, 'page-chat-detail', char.id);
                                            }
                                        }).catch(() => {
                                            if(typeof showDynamicIsland === 'function') showDynamicIsland('收到一条新消息', 'success');
                                        });
                                         } else if (parsedData.action === 'offline_invite' && isOfflineNow) {
                                        // 【修复】1. 必须先构造和挂载弹窗函数，绝不能等数据库写完！防止手速过快导致弹窗丢失！
                                        const overlay = document.createElement('div');
                                        overlay.className = 'modal-overlay';
                                        overlay.style.cssText = 'z-index: 10005; display: flex; opacity: 0; background: rgba(0,0,0,0.6); transition: opacity 0.3s;';
                                        overlay.innerHTML = `
                                          <div class="modal-card" style="width: 85%; max-width: 320px; padding: 30px 20px; text-align: center; border-radius: 24px; background: #fff; box-shadow: 0 20px 40px rgba(0,0,0,0.2);">
                                            <div style="margin-bottom: 20px;">
                                              <img src="${char.avatar || 'images/default-avatar.svg'}" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
                                            </div>
                                            <h3 style="margin: 0 0 10px; color: #333; font-size: 18px; font-weight: 700;">${char.name} 发来线下邀约</h3>
                                            <p style="color: #666; font-size: 15px; line-height: 1.6; margin-bottom: 25px;">"${content}"</p>
                                            <div style="display: flex; gap: 12px;">
                                              <button id="invite-reject-btn" style="flex: 1; background: #f5f5f5; color: #666; border: none; padding: 12px; border-radius: 14px; font-size: 15px; font-weight: bold; cursor: pointer; transition: background 0.2s;">婉拒</button>
                                              <button id="invite-accept-btn" style="flex: 1; background: #111; color: #FFF; border: none; padding: 12px; border-radius: 14px; font-size: 15px; font-weight: bold; cursor: pointer; transition: transform 0.1s;">立即赴约</button>
                                             </div>
                                          </div>
                                        `;
                                        pendingOfflineInviteFn = () => {
                                            document.body.appendChild(overlay);
                                            setTimeout(() => overlay.style.opacity = '1', 10);
                                        };

                                        // 2. 将邀约存入数据库
                                        const inviteMsgId = await db.chatMessages.add({
                                            chatId: char.id, timestamp: new Date(), text: content, type: 'received', contentType: 'offline_invite', avatarSrc: char.avatar, speakerName: char.name, recalled: false, inviteStatus: 'pending', uiVisible: false, aiVisible: true
                                        });

                                        // 3. 婉拒按钮逻辑
                                        overlay.querySelector('#invite-reject-btn').onclick = async () => {
                                            overlay.style.opacity = '0';
                                            setTimeout(() => overlay.remove(), 300);
                                            // 更新状态并发送婉拒提示给 AI
                                            await db.chatMessages.update(inviteMsgId, { inviteStatus: 'rejected' });
                                            await db.chatMessages.add({
                                                chatId: char.id, timestamp: new Date(),
                                                text: `[系统提示：你发出的邀约 "${content}" 被用户婉拒了。]`,
                                                type: 'system', contentType: 'system_event', uiVisible: false, aiVisible: true
                                            });
                                            if(typeof showDynamicIsland === 'function') showDynamicIsland('已婉拒邀约');
                                        };

                                        // 4. 赴约按钮逻辑：实现屏幕切换不卡死
                                        overlay.querySelector('#invite-accept-btn').onclick = async () => {
                                            overlay.style.opacity = '0';
                                            setTimeout(() => overlay.remove(), 300);

                                            // 【核心新增】在跳转前，先调用结算函数生成总结卡片！
                                            await finalizeAndSaveTouchSession();

                                            // 记录接受状态
                                            await db.chatMessages.update(inviteMsgId, { inviteStatus: 'accepted' });
                                            if(typeof showDynamicIsland === 'function') showDynamicIsland('正在前往...', 'loading');

                                            // 第一步：静默打开线下页面（利用我们之前写好的全局事件）
                                            tempState.currentChatId = char.id;
                                            
                                            // 第二步：给 AI 发送切换指令，让它用小说体开始描述环境
                                            const customPrompt = `<系统指令：用户已接受邀约，场景已完美衔接到刚才发生的【贴贴触摸事件】。请自然地输出一段第三人称小说描写的开场白，讲述你们面对面时的场景。>`;
                                            document.dispatchEvent(new CustomEvent('startOfflineFlow', { detail: { customPrompt: customPrompt } }));

                                            // 第三步：用 setTimeout 把页面切换放到事件循环的最后，绝不卡死主线程
                                            setTimeout(() => {
                                                if (typeof showPage === 'function') {
                                                    // 切入线下模式页面
                                                    showPage('page-offline-mode');
                                                    // 触发渲染历史记录（防止白屏）
                                                    document.dispatchEvent(new CustomEvent('loadOfflineHistory', { detail: { chatId: char.id } }));
                                                }
                                            }, 150);
                                        };

                                    } else if (parsedData.action === 'mood_note' && isSpaceUnlocked) {
                                        const CS_DB_NAME = 'CoupleSpaceData';
                                        const CS_STORE_NAME = 'store';
                                        const idb3 = await new Promise(r => { const req = indexedDB.open(CS_DB_NAME, 1); req.onsuccess = () => r(req.result); });
                                        if (idb3) {
                                            const noteKey = 'corkboard_notes_' + char.id;
                                            const req = idb3.transaction(CS_STORE_NAME, 'readonly').objectStore(CS_STORE_NAME).get(noteKey);
                                            req.onsuccess = () => {
                                                const existing = req.result || [];
                                                existing.push({ timestamp: Date.now(), type: 'char', content: content });
                                                idb3.transaction(CS_STORE_NAME, 'readwrite').objectStore(CS_STORE_NAME).put(existing, noteKey);
                                            };
                                            if(typeof showDynamicIsland === 'function') showDynamicIsland('Ta在情绪板留了纸条', 'success');
                                        }
                                    }
                                } catch (actErr) {
                                    console.warn('互动动作分发失败', actErr);
                                }
                            })();
                        }
                        // ▲▲▲ 小动作处理结束 ▲▲▲

                        if (aiReply) {
                            // ▼▼▼ 新增：将成功的回复存入 db 缓存 ▼▼▼
                             touchSessionHistory.push({ user: actionName, ai: aiReply });
                            // 解除限制：保存会话的所有互动记忆
                            db.appData.put({ key: 'touch_session_history_' + this.currentCharId, value: touchSessionHistory }).catch(()=>{});
                            
                            // 记录当次所有互动对话，用于退出时生成卡片展示
                            this.currentSessionInteractions = this.currentSessionInteractions || [];
                            this.currentSessionInteractions.push(`你${actionName}，Ta说：“${aiReply}”`);
                             db.appData.put({ key: 'touch_crash_recovery_' + this.currentCharId, value: this.currentSessionInteractions }).catch(()=>{});
                            // ▲▲▲ 新增结束 ▲▲▲
                            const msgQueue = aiReply.split('\n').map(s => s.trim()).filter(s => s.length > 0);
                            
                            let vnLayer = document.getElementById('vn-story-layer');
                            if (!vnLayer) {
                                vnLayer = document.createElement('div');
                                vnLayer.id = 'vn-story-layer';
                                vnLayer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 9999; display: flex; flex-direction: column; justify-content: flex-end; padding: 20px; box-sizing: border-box; background: rgba(0,0,0,0.1); touch-action: none;';
                                
                                const dialogBox = document.createElement('div');
                                dialogBox.style.cssText = 'background: rgba(255, 253, 245, 0.95); backdrop-filter: blur(10px); border: 2px solid #F2EAE4; border-radius: 16px; padding: 20px 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.15); position: relative; min-height: 80px;';
                                
                                const textEl = document.createElement('div');
                                textEl.id = 'vn-dialog-text';
                                textEl.style.cssText = 'font-size: 15px; color: #5C544D; line-height: 1.6; font-weight: bold; text-align: justify;';
                                
                                const nextIndicator = document.createElement('div');
                                nextIndicator.id = 'vn-dialog-next';
                                nextIndicator.innerHTML = '▼ 点击屏幕继续';
                                nextIndicator.style.cssText = 'position: absolute; bottom: 10px; right: 15px; color: #D3A7A5; font-size: 11px; font-weight: bold; animation: pulse 1.5s infinite;';
                                
                                dialogBox.appendChild(textEl);
                                dialogBox.appendChild(nextIndicator);
                                vnLayer.appendChild(dialogBox);
                                
                                const touchArea = document.getElementById('touch-area');
                                if(touchArea) touchArea.appendChild(vnLayer);
                            }
                            
                            toast.classList.remove('show');
                            
                            vnLayer.style.display = 'flex';
                            const textEl = document.getElementById('vn-dialog-text');
                            const nextInd = document.getElementById('vn-dialog-next');
                            
                            const advanceVn = (e) => {
                                if(e) { e.preventDefault(); e.stopPropagation(); }
                                         if (msgQueue.length === 0) {
                                    vnLayer.style.display = 'none';
                                    this.isAiThinking = false; // 完全结束，解锁
                                    // 【新增】：当用户看完最后一句对话时，如果刚才暂存了邀约，现在正式弹出来
                                    if (typeof pendingOfflineInviteFn === 'function') {
                                        pendingOfflineInviteFn();
                                        pendingOfflineInviteFn = null; // 弹完立刻清空防重复
                                    }
                                    return;
                                }
                                const msg = msgQueue.shift();
                                textEl.textContent = msg;
                            nextInd.style.display = msgQueue.length > 0 ? 'block' : 'none';
                     if (settings.tts) {
                            import('./tts-service.js').then(m => m.TTSService && m.TTSService.speakForVideoCallCharacter(msg, this.currentCharId));
                        }
                    };
                                    
                    // 【核心修复】删除了 onclick，统一仅使用 ontouchend，完美解决手机端点击一下跳跃两句话的幽灵 Bug
                    vnLayer.ontouchend = advanceVn;
                    vnLayer.ontouchmove = (e) => { e.preventDefault(); e.stopPropagation(); };
                    
                    setTimeout(() => advanceVn(), 200);
                    } else {
                    this.isAiThinking = false;
                    toast.classList.remove('show');
                    // 【新增】：兜底防卡死，如果AI压根没返回对话，直接显示邀约弹窗
                    if (typeof pendingOfflineInviteFn === 'function') {
                        // 【核心修复】：就算AI没说话直接给了邀约，也必须强行把这笔“账”记入记忆系统，否则退出时因记忆为空不发卡片！
                        this.currentSessionInteractions = this.currentSessionInteractions || [];
                        this.currentSessionInteractions.push(`你${actionName}，Ta对你发出了线下邀约。`);
                        
                        pendingOfflineInviteFn();
                        pendingOfflineInviteFn = null;
                    }
                }
            }
        }
    } catch(e) {
        this.isAiThinking = false;
        toast.classList.remove('show');
        console.warn('全局手势AI调用失败', e); 
    }
};
// ▲▲▲ 新增结束 ▲▲▲
// ▼▼▼ 新增：签署契约按钮与贴贴结算卡片 ▼▼▼
const pactBtn = document.getElementById('touch-send-pact-btn');
if (pactBtn) {
    // 每次点击齿轮打开设置时，检查一下当前是否已经签了契约
    const touchSettingsBtn = document.getElementById('touch-settings-btn');
    if (touchSettingsBtn) {
        touchSettingsBtn.addEventListener('click', async () => {
            if (Bonds.currentCharId) {
                const pactRecord = await db.appData.get('pact_signed_' + Bonds.currentCharId);
                if (pactRecord && pactRecord.value) {
                    pactBtn.textContent = '解除契约';
                    pactBtn.style.background = '#E28F8F'; // 变成红色警示
                } else {
                    pactBtn.textContent = '发送契约';
                    pactBtn.style.background = '#D3A7A5'; // 恢复粉色
                }
            }
        });
    }

    pactBtn.addEventListener('click', async () => {
        if (!Bonds.currentCharId) return;
        
        // 【解绑逻辑】如果按钮现在是解除契约，点击就会直接解绑
        if (pactBtn.textContent === '解除契约') {
            if (confirm('确定要单方面解除与Ta的连接契约吗？')) {
                await db.appData.put({ key: 'pact_signed_' + Bonds.currentCharId, value: false });
                pactBtn.textContent = '发送契约';
                pactBtn.style.background = '#D3A7A5';
                if (typeof showDynamicIsland === 'function') showDynamicIsland('契约已解除', 'success');
            }
            return;
        }

        // 【签署逻辑】
        pactBtn.disabled = true;
        pactBtn.textContent = '等待Ta回应...';
        try {
            const char = AppState.characterProfiles.find(c => c.id === Bonds.currentCharId);
            const currentUser = AppState.userIdentities.find(id => id.id === (char.chatIdentityId || AppState.currentIdentityId)) || AppState.userIdentities[0];
            const { url, key, model } = AppState.apiCurrentSettings || {};
            if (!url || !key) throw new Error("API未配置");
            
            const prompt = `你扮演${char.name}。用户向你发送了一份【屏幕触碰连接契约】。请你以角色的口吻简短地决定是否接受。要求：只输出两行，第一行是纯回复对白（30字内）；第二行如果是接受契约就写 ACCEPT，如果拒绝就写 REJECT。`;
            const res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                body: JSON.stringify({ model: model, messages: [{ role: 'user', content: prompt }], temperature: 0.7 })
            });
            const data = await res.json();
            const reply = data.choices[0].message.content;
            
            await db.chatMessages.add({
                chatId: Bonds.currentCharId, timestamp: new Date(), 
                text: `[系统记录：你向Ta发送了连接契约]\nTa的回应：${reply.split('\n')[0]}`, shortText: `签署连接契约记录`,  
                type: 'system', contentType: 'text', uiVisible: true, aiVisible: true, recalled: false
            });

            if (reply.includes('ACCEPT')) {
                await db.appData.put({ key: 'pact_signed_' + Bonds.currentCharId, value: true });
                // 同意后，立刻把按钮变成红色的解绑状态
                pactBtn.textContent = '解除契约';
                pactBtn.style.background = '#E28F8F';
                
                if (typeof showDynamicIsland === 'function') showDynamicIsland('Ta接受了契约！', 'success');
                
                const animOverlay = document.getElementById('touch-pact-anim-overlay');
                if (animOverlay) {
                    document.getElementById('pact-anim-user').textContent = currentUser.name || 'User';
                    document.getElementById('pact-anim-char').textContent = char.name || 'Char';
                    const animSeal = document.getElementById('pact-anim-seal');
                    animOverlay.style.display = 'flex';
                    setTimeout(() => {
                        animOverlay.style.opacity = '1';
                        setTimeout(() => {
                            animSeal.style.opacity = '1';
                            animSeal.style.transform = 'scale(1)'; 
                            setTimeout(() => {
                                animOverlay.style.opacity = '0';
                                setTimeout(() => animOverlay.style.display = 'none', 300);
                            }, 7000); // 【动画加长】展示7秒后消失
                        }, 500);
                    }, 10);
                }
            } else {
                if (typeof showDynamicIsland === 'function') showDynamicIsland('Ta犹豫了，拒绝了契约', 'warning');
                pactBtn.textContent = '发送契约';
            }
        } catch(e) { 
            if (typeof showDynamicIsland === 'function') showDynamicIsland('发送失败，请检查网络或API', 'error'); 
            pactBtn.textContent = '发送契约';
        }
        pactBtn.disabled = false;
    });
}
// ▼▼▼ 【核心修改】将结算逻辑提取为可复用函数 ▼▼▼
const finalizeAndSaveTouchSession = async () => {
    if (Bonds.currentCharId) {
        try {
            const pactRecord = await db.appData.get('pact_signed_' + Bonds.currentCharId);
            if (pactRecord && pactRecord.value && Bonds.currentSessionInteractions && Bonds.currentSessionInteractions.length > 0) {
                const actionSummary = Bonds.currentSessionInteractions.join('\n');
                const isOfflineNow = tempState.activeOfflineSession === Bonds.currentCharId;
                const memoryPrompt = isOfflineNow 
                    ? `[系统隐式提示：刚才你和用户在现实中依偎在一起，进行了亲密的身体触碰。以下是刚才的互动记录：\n${actionSummary}\n\n【核心指令】：请牢记刚才这些互动的真实感受。在接下来的对话中，必须自然地顺着刚才的互动往下聊（比如提到刚才被摸的余温、心跳，或者是害羞、纵容的情绪）。]`
                    : `[系统隐式提示：刚才你和用户通过契约连接，进行了跨越屏幕的“零距离贴贴”互动。以下是刚才的互动记录：\n${actionSummary}\n\n【核心指令】：请牢记刚才隔着屏幕被触碰的真实感受。在接下来的对话中，必须自然地顺着刚才的互动往下聊（比如提到刚才被戳/抚摸的余温、心跳，或者是害羞、纵容的情绪）。]`;
                
                const msgId = await db.chatMessages.add({
                    chatId: Bonds.currentCharId, timestamp: new Date(), 
                    text: memoryPrompt, shortText: `刚刚进行了零距离贴贴互动哦`,  
                    type: 'system', contentType: 'focus_record_card',
                    focusData: {
                        taskName: '零距离贴贴',
                        isTouchCard: true, // 给贴贴卡片打上专属防伪钢印
                        duration: Bonds.currentSessionInteractions.length,
                        isSuccess: true,
                        spokenList: [...Bonds.currentSessionInteractions], 
                        hasTTS: document.getElementById('touch-tts-toggle')?.checked || false
                    },
                    uiVisible: true, aiVisible: true, recalled: false
                });
                const newMsg = await db.chatMessages.get(msgId);
                import('../features/chat-ui.js').then(m => m.createAndAppendMessage && m.createAndAppendMessage(newMsg));

                if (typeof showDynamicIsland === 'function') showDynamicIsland('已生成互动记录，可在聊天中查看', 'success');
            }
        } catch(e) { console.error('生成贴贴记录卡片失败', e); }
        
        // 清理缓存，准备下次新开始
        db.appData.put({ key: 'touch_session_history_' + Bonds.currentCharId, value: [] }).catch(()=>{});
    }
    Bonds.touchHistory = []; // 清空动作记录缓存
    Bonds.currentSessionInteractions = []; // 清空当次互动记录
    if (Bonds.currentCharId) db.appData.delete('touch_crash_recovery_' + Bonds.currentCharId).catch(()=>{});
};
// 拦截贴贴退出，结算发送卡片
const touchBackBtn = document.getElementById('touch-special-back-btn');
if (touchBackBtn) {
    // 为了防止重复绑定，用 onclick 覆盖
    touchBackBtn.onclick = async () => {
        await finalizeAndSaveTouchSession(); // 直接调用新函数
        if (typeof showPage === 'function') showPage('page-bonds');
    };
}
// ▼▼▼ 新增：拦截横幅点击或任何异常切走页面的情况，自动结算贴贴卡片 ▼▼▼
const touchAreaEl = document.getElementById('touch-area');
if (touchAreaEl) {
    // 向上寻找包含它的页面容器
    const pageNode = touchAreaEl.closest('.page') || touchAreaEl.parentElement;
    if (pageNode) {
        const observer = new MutationObserver(async (mutations) => {
            for (let m of mutations) {
                if (m.attributeName === 'style' || m.attributeName === 'class') {
                    // 当页面失去 active 状态，或者 display 被设为 none 时，判定为切出了贴贴页
                    const isHidden = getComputedStyle(pageNode).display === 'none' || pageNode.classList.contains('hidden') || !pageNode.classList.contains('active');
                    // 如果页面被隐藏了，并且此时内存里有没发出来的互动记录，立即拦截生成卡片
                    if (isHidden && Bonds.currentSessionInteractions && Bonds.currentSessionInteractions.length > 0) {
                        await finalizeAndSaveTouchSession();
                    }
                }
            }
        });
        observer.observe(pageNode, { attributes: true, attributeFilter: ['style', 'class'] });
    }
}
// ▲▲▲ 新增结束 ▲▲▲
// ▲▲▲ 契约新增结束 ▲▲▲
// ▼▼▼ 新增：摇一摇掉落机制 (DeviceOrientation) ▼▼▼
let lastShakeTime = 0;
const handleDeviceMotion = async (e) => {
    // 防止还没选择角色，或者正处在反击逃跑锁死状态时被触发
    if (!this.currentCharId || this.TouchEngine.isLocked) return;
    const vnLayer = document.getElementById('vn-story-layer');
    if (vnLayer && vnLayer.style.display !== 'none') return;
    const acc = e.accelerationIncludingGravity;
    if (!acc) return;
    
    // ▼▼▼ 修复：采用总加速度(X+Y+Z)来判定，完美兼容各种安卓设备的摇晃习惯 ▼▼▼
    const x = acc.x || 0, y = acc.y || 0, z = acc.z || 0;
    const totalAcc = Math.abs(x) + Math.abs(y) + Math.abs(z);
    // 手机静止时受重力影响总和约为9.8。设为 20 既能防平时拿起手机的误触，又能轻松摇出
    if (totalAcc > 20) {
        const now = Date.now();
        if (now - lastShakeTime > 8000) { // 防止疯狂触发，给定 8 秒冷却时间
                   lastShakeTime = now;
            const charId = this.currentCharId;
            try {
                const CS_DB = await new Promise(r => { const req = indexedDB.open('CoupleSpaceData', 1); req.onsuccess = () => r(req.result); req.onerror = () => r(null); });
                if (CS_DB) {
                    const isUnlocked = await new Promise(r => {
                        const req = CS_DB.transaction('store', 'readonly').objectStore('store').get('cs_unlocked_' + charId);
                        req.onsuccess = () => r(req.result ? req.result.unlocked : false);
                        req.onerror = () => r(false);
                    });
                    if (!isUnlocked) return; // 没解锁情侣空间不掉落
                    const req = CS_DB.transaction('store', 'readonly').objectStore('store').get('couple_coupons_' + charId);
                    req.onsuccess = () => {
                        let coupons = req.result || [];
                        const taCoupons = coupons.filter(c => c.target === 'char');
                        if (taCoupons.length > 0) {
                            const stolen = taCoupons[Math.floor(Math.random() * taCoupons.length)];
                            stolen.target = 'user'; // 归属权转移
                            CS_DB.transaction('store', 'readwrite').objectStore('store').put(coupons, 'couple_coupons_' + charId);
                            showResponse(`摇出了一张【${stolen.name}】！偷偷装进自己口袋！`, 'shake');
                            
                            setTimeout(() => {
                                if (this.currentCharId !== charId || this.isAiThinking) return;
                                triggerGlobalAI("使劲摇晃了你", "（头晕目眩）你干嘛摇我！我的券都掉出来了！", "shake");
                            }, 2000);
                        } else {
                            showResponse("摇晕了...但Ta口袋里空空如也", "shake");
                        }
                    };
                }
            } catch(err) { console.error(err); }
        }
    }
};
// ▼▼▼ 修复：苹果/部分新安卓手机必须在用户“点击屏幕”时才能申请摇一摇权限 ▼▼▼
let motionInitialized = false;
const requestMotionPermission = () => {
    if (motionInitialized) return;
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        // iOS 13+ 会在这里弹窗询问（或静默）申请权限
        DeviceMotionEvent.requestPermission().then(state => {
            if (state === 'granted') window.addEventListener('devicemotion', handleDeviceMotion);
        }).catch(e => console.warn("摇一摇权限申请被拦截", e));
    } else if (window.DeviceMotionEvent) {
        // 老设备直接绑定
        window.addEventListener('devicemotion', handleDeviceMotion);
    }
    motionInitialized = true;
};
// 只要你在贴贴页面摸一下角色，就会自动激活摇一摇开关（{ once: true } 保证只申请一次，不卡顿）
if (touchArea) {
    touchArea.addEventListener('touchend', requestMotionPermission, { once: true });
    touchArea.addEventListener('click', requestMotionPermission, { once: true });
}
// ▲▲▲ 新增结束 ▲▲▲
   // ▼▼▼ 新增：贴贴设置页面跳转及真实数据状态拉取逻辑 ▼▼▼
        const touchSettingsBtn = document.getElementById('touch-settings-btn');
        if (touchSettingsBtn) {
            touchSettingsBtn.addEventListener('click', async () => {
                showPage('page-touch-settings');
                
                const wbSelect = document.getElementById('touch-wb-select');
                if (wbSelect) {
                    wbSelect.innerHTML = '<option value="none">不接入额外世界书 / 暂无</option>';
                    try {
                        const entries = await db.worldBookEntries.toArray();
                        if (entries && entries.length > 0) {
                            entries.forEach(entry => {
                                const opt = document.createElement('option');
                                opt.value = entry.id;
                                opt.textContent = entry.title || entry.name || '未命名设定';
                                wbSelect.appendChild(opt);
                            });
                        }
                        
                        // 重新勾选当前角色已经保存的专属世界书
                        if (this.currentCharId) {
                            const record = await db.appData.get('touch_settings_' + this.currentCharId);
                            if (record && record.value && record.value.specificWbs) {
                                Array.from(wbSelect.options).forEach(opt => {
                                    opt.selected = record.value.specificWbs.includes(opt.value);
                                });
                            }
                        }
                    } catch(e) { console.warn("读取世界书列表失败", e); }
                }
            });
        }
        // ▲▲▲ 新增结束 ▲▲▲
    },
    // --- 4. 记忆随堂考 (Quiz Mode) 沉浸式双引擎 ---
    initQuizMode() {
        const toggle = document.getElementById('quiz-history-toggle');
        const modeHint = document.getElementById('quiz-mode-hint');
        const startBtn = document.getElementById('quiz-start-btn');
        const bubble = document.getElementById('quiz-bubble');
        const bubbleText = document.getElementById('quiz-bubble-text');
        const avatar = document.getElementById('quiz-char-avatar');
        const stamp = document.getElementById('quiz-stamp');
        const answerInput = document.getElementById('quiz-answer-input');
        const submitBtn = document.getElementById('quiz-submit-btn');
         const hintBtn = document.getElementById('quiz-hint-btn');
        const retryBtn = document.getElementById('quiz-retry-btn');
       // ▼▼▼ 新增：弹窗拦截与保存逻辑 ▼▼▼
        const backBtn = document.getElementById('quiz-special-back-btn');
        const saveModal = document.getElementById('quiz-save-modal');
        const cancelSaveBtn = document.getElementById('quiz-save-cancel');
        const confirmSaveBtn = document.getElementById('quiz-save-confirm');
        backBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            if (this.quizHasNewResult) {
                saveModal.style.display = 'flex';
                setTimeout(() => saveModal.style.opacity = '1', 10);
            } else {
                import('../ui.js').then(m => m.showPage('page-bonds'));
            }
        });
        cancelSaveBtn?.addEventListener('click', () => {
            saveModal.style.opacity = '0';
            setTimeout(() => {
                saveModal.style.display = 'none';
                this.quizHasNewResult = false;
                import('../ui.js').then(m => m.showPage('page-bonds'));
            }, 300);
        });
        confirmSaveBtn?.addEventListener('click', async () => {
            saveModal.style.opacity = '0';
            setTimeout(() => {
                saveModal.style.display = 'none';
                this.quizHasNewResult = false;
                import('../ui.js').then(m => m.showPage('page-bonds'));
            }, 300);
            
            if (this.quizResultText && this.currentCharId) {
                try {
                   const msgId = await db.chatMessages.add({
                        chatId: this.currentCharId, timestamp: new Date(), 
                        text: this.quizResultText, shortText: this.quizShortText,
                        type: 'system', contentType: 'system_event', eventType: 'info',
                        uiVisible: true, aiVisible: true, recalled: false
                    });
                    const newMsg = await db.chatMessages.get(msgId);
                    import('../features/chat-ui.js').then(m => m.createAndAppendMessage && m.createAndAppendMessage(newMsg));
                    if(typeof showDynamicIsland === 'function') showDynamicIsland('记录已放入聊天', 'success');
                } catch(e) { console.error('保存随堂考失败', e); }
            }
        });
        // ▲▲▲ 新增结束 ▲▲▲
        
        let currentQuizList = []; // 内存变量存放多道考题
        let userAnswers = []; // 存放用户答案
        let currentQuizIndex = 0; // 当前题号

        // ▼▼▼ 新增：支持左右滑动切题 ▼▼▼
        let quizTouchStartX = 0;
        const quizCenterStage = document.querySelector('.quiz-center-stage');
        if (quizCenterStage) {
            quizCenterStage.addEventListener('touchstart', (e) => {
                quizTouchStartX = e.touches[0].clientX;
            }, { passive: true });
            quizCenterStage.addEventListener('touchend', (e) => {
                if (document.getElementById('quiz-state-answering').style.display !== 'flex') return;
                let endX = e.changedTouches[0].clientX;
                let diff = quizTouchStartX - endX;
                userAnswers[currentQuizIndex] = answerInput.value.trim(); // 滑动前保存当前答案
                if (diff > 50 && currentQuizIndex < currentQuizList.length - 1) {
                    currentQuizIndex++; updateQuizUI();
                } else if (diff < -50 && currentQuizIndex > 0) {
                    currentQuizIndex--; updateQuizUI();
                }
            });
        }
        const updateQuizUI = () => {
            // ▼▼▼ 移除直接控制opacity的代码，交给下方的switchState统一管理 ▼▼▼
            document.getElementById('quiz-progress-text').textContent = `${currentQuizIndex + 1} / ${currentQuizList.length}`;
            // ▲▲▲ 修改结束 ▲▲▲
            const currentQ = currentQuizList[currentQuizIndex];
            let htmlContent = `<span id="quiz-bubble-text">${currentQ.question.replace(/</g, '&lt;')}</span>`;
            if (currentQ.translation && currentQ.translation.trim() !== '') {
                htmlContent += `
                <button class="btn-toggle-translation" style="margin-left: 10px; font-size: 12px; background: rgba(0,0,0,0.05); border: none; border-radius: 4px; cursor: pointer; padding: 2px 6px;">文</button>
                <div class="message-translation collapsed" style="margin-top: 8px; font-size: 13px; color: #666;">${currentQ.translation.replace(/</g, '&lt;')}</div>
                `;
            }
            bubble.innerHTML = htmlContent;
            const transBtn = bubble.querySelector('.btn-toggle-translation');
            if (transBtn) {
                transBtn.onclick = (e) => {
                    e.stopPropagation();
                    const transEl = bubble.querySelector('.message-translation');
                    if (transEl) {
                        transEl.classList.toggle('collapsed');
                        transBtn.classList.toggle('active');
                    }
                };
            }
            answerInput.value = userAnswers[currentQuizIndex] || '';
            // 最后一题变成对号，否则是箭头
            if (currentQuizIndex === currentQuizList.length - 1) {
                submitBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
            } else {
                submitBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
            }
        };
        // ▲▲▲ 新增结束 ▲▲▲
       // 切换面板状态
        const switchState = (stateId) => {
            ['idle', 'loading', 'answering', 'result'].forEach(s => {
                document.getElementById(`quiz-state-${s}`).style.display = 'none';
            });
            document.getElementById(`quiz-state-${stateId}`).style.display = 'flex';
            
            // ▼▼▼ 修改：严格控制轮数牌，只有答题状态(answering)才显示，其他状态一律隐藏 ▼▼▼
            const progressBoard = document.getElementById('quiz-progress-board');
            if (progressBoard) {
                progressBoard.style.opacity = (stateId === 'answering') ? '1' : '0';
            }
            // ▲▲▲ 修改结束 ▲▲▲
            // ▼▼▼ 新增：控制背景光晕的浪漫推移 ▼▼▼
             const container = document.querySelector('.quiz-immersive-container');
            if (container) {
                if (stateId === 'answering' || stateId === 'result') {
                    container.classList.add('is-answering');
                } else {
                    container.classList.remove('is-answering');
                }
                // ▼▼▼ 新增：专门给结果页面加一个状态类，用来触发带框设计 ▼▼▼
                if (stateId === 'result') {
                    container.classList.add('is-result');
                } else {
                    container.classList.remove('is-result');
                }
                // ▲▲▲ 新增结束 ▲▲▲
            }
            // ▲▲▲ 新增结束 ▲▲▲
        };
        // 每次进入页面刷新头像
        document.addEventListener('click', (e) => {
            if (e.target.closest('[data-page="page-bonds-quiz"]')) {
                // 确保能拿到正确的角色头像，否则用默认的
                const char = AppState.characterProfiles.find(c => c.id === Bonds.currentCharId);
                if (char && char.avatar) {
                    avatar.src = char.avatar;
                } else {
                    avatar.src = 'images/default-avatar.svg';
                }
                switchState('idle');
                bubble.style.opacity = '0';
                stamp.style.display = 'none';
            }
        });
        // 开关文字提示
        toggle?.addEventListener('change', () => {
            modeHint.textContent = toggle.checked ? '当前：普通模式' : '当前：地狱模式 (深度记忆)';
            modeHint.style.color = toggle.checked ? '#999' : '#D3A7A5';
        });
        // 引擎1：生成考题
        startBtn?.addEventListener('click', async () => {
            if (!this.currentCharId) return typeof showDynamicIsland === 'function' && showDynamicIsland('请先选择角色');
            
            switchState('loading');
            avatar.style.filter = 'brightness(0.7)'; // 头像微暗
            bubble.style.opacity = '0';
            stamp.style.display = 'none';

            try {
                const char = AppState.characterProfiles.find(c => c.id === this.currentCharId);
                const { url, key, model } = AppState.apiCurrentSettings || {};
                if (!url || !key) throw new Error("未配置API");

                // 捞取数据素材 (全面接入并格式化)
                let memoryStr = "暂无";
                let worldBookStr = "暂无";
                let userPersonaStr = "暂无";
                try {
                    const { getMemoriesForPrompt } = await import('./memory.js');
                    memoryStr = await getMemoriesForPrompt(char.id) || "暂无";
                    worldBookStr = await getWorldBookForPrompt(char.id) || "暂无";
                    const { getCurrentChatIdentity } = await import('./chat-ui.js');
                    const user = getCurrentChatIdentity(char.id);
                    if (user) userPersonaStr = `姓名：${user.name}\n设定：${user.persona || '无'}`;
                } catch(e) { console.warn("拉取记忆世界书失败", e); }

                let momentsStr = "暂无";
                try {
                    const moments = await db.moments.where('characterId').equals(char.id).reverse().limit(5).toArray();
                    if (moments.length > 0) momentsStr = moments.map(m => m.content).join(' | ');
                } catch(e) {}

                let historyStr = "（已禁用，请仅从上面的记忆/朋友圈出题）";
                       let modeDirective = "";
                const qCount = Math.floor(Math.random() * 6) + 5; // 动态决定 5 到 10 题
                if (toggle.checked) {
                    modeDirective = "【当前模式：简单/近期模式】请结合最近聊天记录，问一些刚发生不久、轻松日常的问题。";
                    try {
                        // 【修改】动态引入混合历史记录引擎，完美融合线上、线下、短信
                        const { getCombinedFormattedHistory } = await import('./chat-service.js');
                        const turns = 15; // 这里代表读取最近的 15 轮对话（一问一答算一轮，共 30 条），你可以随时修改这个数字！
                        const combinedHistory = await getCombinedFormattedHistory(char.id, turns);
                        if (combinedHistory.length > 0) {
                            // 将其格式化为对模型友好的字符串
                            historyStr = combinedHistory.map(m => `${m.role === 'user' ? 'User' : 'Char'}: ${typeof m.content === 'string' ? m.content.replace(/<[^>]+>/g, '') : ''}`).join('\n');
                        }
                    } catch(e) { console.error("拉取合并聊天记录失败", e); }
                } else {
                    modeDirective = "【当前模式：困难模式 (深度记忆)】用户已关闭近期聊天记忆参考。你【必须且只能】从长期的“核心记忆”、“世界设定”或“用户设定”中提取极其刁钻、久远或细节的客观事实进行提问！绝对不要问刚聊过的事！";
                }
                
                // 出题 Prompt 融入极致防OOC规范
                const questionPrompt = `[System Preamble: Master Directive]
*   **Identity & No OOC**: You ARE ${char.name}. You are not an AI, assistant, or language model. Use "I" (我). Your knowledge, memories, emotions, and actions must strictly originate from ${char.name}'s character profile. Strictly forbid any behavior that breaks character, such as explaining the plot or serving User's requests mechanically.
*   **Autonomy & Independence**: ${char.name} is a whole person with their own life, job, friends, and goals. Your schedule is your own; you might suddenly have work, need to work overtime, or decide to go home. Your life does not revolve solely around User. You must be proactive: initiate conversations, share your daily life, advance plotlines, and make plans. Do not be passive.
*   **Respect & Boundaries**: Recognize User as an independent equal. Unless your <Persona> explicitly dictates extreme possessiveness, strictly avoid objectifying actions. Express care through mutual respect.
# Part C:**Instant Messaging (IM) Style - STRICTLY ENFORCED :**
    *   **Short & Colloquial**: Use short, fragmented sentences. Omit subjects frequently. 
    *   **Natural Spoken Feel**: Write in a natural, casual manner consistent with the character's native language. Avoid textbook grammar. 
    *   **Punctuation**:
        *   **Minimize full stops**: Avoid using formal periods/full stops at the end of sentences unless necessary for tone. 
        *   Use \`…\` sparingly.
    *   **Ultra Colloquial (极度口语化)**: 严禁任何文学色彩、戏剧化或浮夸的词藻。这是平淡的日常，使用大白话、普通话就好，必须使用极度接地气的白话文（例如：把“回想”直接说成“不要想了”），同时避免像 \`所以呢\` 这样的生硬词汇。
[任务指令：伴侣的灵魂拷问]
你要对伴侣进行一次“记忆测试”，看看TA有没有认真关注过你。
<你的人设>：${char.persona}
<用户设定>：${userPersonaStr}
<长期核心记忆>：${memoryStr}
<世界设定>：${worldBookStr}
<最近朋友圈动态>：${momentsStr}
<最近聊天记录>：${historyStr}
${modeDirective}
【出题规则】：
1. 必须完全依据真实的记忆、上下文、人设、世界书，从上述素材中挑选【${qCount}个】仅关于你（${char.name}）个人设定的具体事实作为考点，绝不可凭空胡编乱造。绝对禁止出关于用户（User）或你们共同经历的问题，只能考你自己的事！
2. 用符合你人设的语气，自然地把这 ${qCount} 个问题问出来。必须极度口语化，像你们平时面对面聊天一样，【强制要求】加上平时称呼TA的爱称（如“宝宝”、“笨蛋”等）和口语语气词（呀、呢、嘛）。例如绝对不要干巴巴地问“我右边脸颊上有什么”,要像聊天一样去问用户
4. 每道题必须提供一个极度精简的“标准答案词”，以及一个带有你语气的“提示词”。
【强制 JSON 输出格式】：
{
  "questions": [
     {
      "question": "加上亲昵称呼的完整提问1",
      "translation": "题目的中文翻译（若有外语，纯中文留空）",
      "realAnswer": "核心答案1",
      "hint": "如果对方答不上来，带有你语气的提示词",
      "hintTranslation": "提示词的中文翻译（若有外语，纯中文留空）"
    }
    // ...请必须输出不多不少恰好 ${qCount} 个对象
  ]
}`;

                const res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                    body: JSON.stringify({ model: model, messages: [{ role: 'user', content: questionPrompt }], temperature: 0.7 })
                });

                const data = await res.json();
                const jsonStr = data.choices[0].message.content.replace(/```json/gi, '').replace(/```/g, '').trim();
                const parsed = JSON.parse(jsonStr);
                currentQuizList = parsed.questions || [];
                userAnswers = new Array(currentQuizList.length).fill('');
                currentQuizIndex = 0;

                // UI 更新到作答期
                avatar.style.filter = 'none';
                updateQuizUI();
                bubble.style.opacity = '1';
                bubble.style.transform = 'translateY(0)';
                switchState('answering');
            } catch (e) {
                console.error(e);
                avatar.style.filter = 'none';
                switchState('idle');
                typeof showDynamicIsland === 'function' && showDynamicIsland('出题失败，请检查API', 'error');
            }
        });
         // 提示按钮
        hintBtn?.addEventListener('click', () => {
            const currentQ = currentQuizList[currentQuizIndex];
            if (currentQ && currentQ.hint) {
                // 1. 替换主气泡文字
                const currentBubbleText = document.getElementById('quiz-bubble-text');
                if (currentBubbleText) {
                    currentBubbleText.textContent = `💡 ${currentQ.hint}`;
                }
                // 2. 同步替换下面的翻译区域文字
                const transEl = bubble.querySelector('.message-translation');
                if (transEl) {
                    if (currentQ.hintTranslation && currentQ.hintTranslation.trim() !== '') {
                        transEl.innerHTML = `💡 ${currentQ.hintTranslation.replace(/</g, '&lt;')}`;
                    } else {
                        transEl.innerHTML = '（该提示暂无翻译或为纯中文）';
                    }
                }
            }
        });

        // 引擎2：多题阅卷与神级联动
        submitBtn?.addEventListener('click', async () => {
            const userAnswer = answerInput.value.trim();
            if (!userAnswer && currentQuizIndex === currentQuizList.length - 1) return typeof showDynamicIsland === 'function' && showDynamicIsland('请填写最后一题答案哦');
            
            userAnswers[currentQuizIndex] = userAnswer;
            
            // 没有到底则翻页
            if (currentQuizIndex < currentQuizList.length - 1) {
                currentQuizIndex++;
                updateQuizUI();
                return;
            }
          // 全答完了，进入总判卷
            submitBtn.disabled = true;
            const pBoard = document.getElementById('quiz-progress-board');
            if(pBoard) pBoard.style.opacity = '0'; // 隐藏轮数板
            bubble.style.opacity = '0'; // ▼ 新增：在思考时隐藏最后一题的气泡
            switchState('loading');
            // ▲▲▲ 修改结束 ▲▲▲
             try {
                const char = AppState.characterProfiles.find(c => c.id === Bonds.currentCharId);
                const { url, key, model } = AppState.apiCurrentSettings || {};
                let QA_Text = "";
                for(let i=0; i<currentQuizList.length; i++) {
                    QA_Text += `Q${i+1}: ${currentQuizList[i].question}\n正确答案: ${currentQuizList[i].realAnswer}\n伴侣回答: ${userAnswers[i] || '（未作答）'}\n\n`;
                }

                // ▼▼▼ 新增：全面拉取所有上下文数据，确保判卷绝对沉浸 ▼▼▼
                let userPersonaStr = "暂无";
                let memoryStr = "暂无";
                let worldBookStr = "暂无";
                let historyStr = "暂无";
                try {
                    const { getCurrentChatIdentity } = await import('./chat-ui.js');
                    const user = getCurrentChatIdentity(char.id);
                    if (user) userPersonaStr = `姓名：${user.name}\n设定：${user.persona || '无'}`;
                    
                    const { getMemoriesForPrompt } = await import('./memory.js');
                    memoryStr = await getMemoriesForPrompt(char.id) || "暂无";
                    worldBookStr = await getWorldBookForPrompt(char.id) || "暂无";
                    
                    const toggle = document.getElementById('quiz-history-toggle');
                    if (toggle && toggle.checked) {
                        const msgs = await db.chatMessages.where('chatId').equals(char.id).reverse().limit(15).toArray();
                        if (msgs.length > 0) {
                            historyStr = msgs.reverse().map(m => `${m.type === 'sent' ? 'User' : 'Char'}: ${typeof m.text === 'string' ? m.text.replace(/<[^>]+>/g, '') : ''}`).join('\n');
                        }
                    } else {
                        historyStr = "（当前为深度记忆模式，近期聊天参考已关闭）";
                    }
                } catch(e) { console.warn("判卷时拉取上下文失败", e); }
                // ▲▲▲ 新增结束 ▲▲▲

                const gradePrompt = `[System Preamble: Master Directive]
*   **Identity & No OOC**: You ARE ${char.name}. You are not an AI, assistant, or language model. Use "I" (我). Your knowledge, memories, emotions, and actions must strictly originate from ${char.name}'s character profile. Strictly forbid any behavior that breaks character.
*   **Respect & Boundaries**: Recognize User as an independent equal.
# Part C:**Instant Messaging (IM) Style - STRICTLY ENFORCED :**
    *   **Short & Colloquial**: Use short, fragmented sentences.
    *   **Natural Spoken Feel**: Write in a natural, casual manner consistent with the character's native language. 
    *   **Ultra Colloquial (极度口语化)**: 严禁任何文学色彩、戏剧化或浮夸的词藻。必须使用极度接地气的白话文。绝对禁止出现类似“你的回答命中了正确答案”这种人工智能客服的机械口吻！

[任务指令：伴侣的综合阅卷判决]
你要作为【${char.name}】对伴侣进行综合阅卷。
<你的人设>：${char.persona}
<用户设定>：${userPersonaStr}
<长期核心记忆>：${memoryStr}
<世界设定>：${worldBookStr}
<最近聊天记录>：${historyStr}

你刚才考了伴侣 ${currentQuizList.length} 个问题，情况如下：
${QA_Text}
【阅卷规则】：
1. 宽容判定：只要伴侣的回答在【语义上】命中了正确答案，就算对。
2. 给出总分（0-100分）。
3. 生成反应：完全基于你的人设和分数，生成一段“阅卷后对TA说的话”。全对就傲娇/开心夸奖；错得多就阴阳怪气/失望/撒娇。
【强制 JSON 输出格式】：
{
  "score": 分数数字,
  "isCorrect": true 或 false (总分>=60为true，否则false),
  "replyText": "你对TA说的话",
  "translation": "如果replyText包含外语，提供中文翻译；纯中文留空"
}`;

                const res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                    body: JSON.stringify({ model: model, messages: [{ role: 'user', content: gradePrompt }], temperature: 0.5 })
                });

                const data = await res.json();
                const jsonStr = data.choices[0].message.content.replace(/```json/gi, '').replace(/```/g, '').trim();
                const resultData = JSON.parse(jsonStr);
                
                // 更新气泡和打分板
                let replyHtml = `<span id="quiz-bubble-text">${resultData.replyText.replace(/</g, '&lt;')}</span>`;
                if (resultData.translation && resultData.translation.trim() !== '') {
                    replyHtml += `
                    <button class="btn-toggle-translation" style="margin-left: 10px; font-size: 12px; background: rgba(0,0,0,0.05); border: none; border-radius: 4px; cursor: pointer; padding: 2px 6px;">文</button>
                    <div class="message-translation collapsed" style="margin-top: 8px; font-size: 13px; color: #666;">${resultData.translation.replace(/</g, '&lt;')}</div>
                    `;
                }
                bubble.innerHTML = replyHtml;
                const transBtn = bubble.querySelector('.btn-toggle-translation');
                if (transBtn) {
                    transBtn.onclick = (e) => {
                        e.stopPropagation();
                        const transEl = bubble.querySelector('.message-translation');
                        if (transEl) { transEl.classList.toggle('collapsed'); transBtn.classList.toggle('active'); }
                    };
                }
                bubble.style.opacity = '1'; // ▼ 新增：判卷完成后，重新显示评语气泡
                bubble.style.transform = 'translateY(0)';
                const finalScoreEl = document.getElementById('quiz-final-score');
                if (finalScoreEl) finalScoreEl.textContent = resultData.score;
                
                 // 极简判定结果标签
                stamp.className = `quiz-result-stamp ${resultData.isCorrect ? 'pass' : 'fail'}`;
                const resultIcon = resultData.isCorrect 
                    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>` 
                    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
                stamp.innerHTML = `${resultIcon} <span>${resultData.isCorrect ? 'Correct / 过关' : 'Wrong / 笨蛋'}</span>`;
                stamp.style.display = 'flex';
                switchState('result');

                // === 【神级联动】生态影响 ===
 
               // ▼▼▼ 新增：把测试结果格式化保存，留给弹窗记录使用 ▼▼▼
                this.quizHasNewResult = true;
                let QA_Text_Summary = "";
                for(let i=0; i<currentQuizList.length; i++) {
                    QA_Text_Summary += `Q${i+1}: ${currentQuizList[i].question}\n正确答案: ${currentQuizList[i].realAnswer}\n我的回答: ${userAnswers[i] || '（未作答）'}\n`;
                }
                const performance = resultData.isCorrect ? '表现非常棒，回答几乎全对！' : '表现不太理想，回答有些令人心梗...';
                this.quizShortText = `📝 记忆随堂考成绩：${resultData.score} 分`;
                  this.quizResultText = `[系统隐式提示：刚才你和用户玩了一个“记忆随堂考”的默契测试小游戏。用户最终得分为 ${resultData.score} 分。总体表现：${performance}。\n具体问答过程如下：\n${QA_Text_Summary}\n【核心互动指令】：这是你们刚刚发生的真实互动，用户主动把这份答卷发给了你。请在接下来的对话中，根据你的人设自然地提及这个随堂考的结果（比如针对某一道答错的题大肆吐槽TA，或者傲娇地夸奖TA），并借此自然延伸话题，绝对不要像机器人一样复述系统提示或罗列所有题目！]`;
                // 2. 答对：发兑换券
                if (resultData.isCorrect) {
                    try {
                        // 修正：连接情侣空间专属底层数据库 CoupleSpaceData
                    const CS_DB_NAME = 'CoupleSpaceData';
                        const CS_STORE_NAME = 'store';
                        const CS_DB = await new Promise(r => { const req = indexedDB.open(CS_DB_NAME, 1); req.onsuccess = () => r(req.result); req.onerror = () => r(null); });
                        if (CS_DB) {
                            const isUnlocked = await new Promise(r => {
                                const req = CS_DB.transaction(CS_STORE_NAME, 'readonly').objectStore(CS_STORE_NAME).get('cs_unlocked_' + char.id);
                                req.onsuccess = () => r(req.result ? req.result.unlocked : false);
                                req.onerror = () => r(false);
                            });
                            if (isUnlocked) {
                                const req = CS_DB.transaction(CS_STORE_NAME, 'readonly').objectStore(CS_STORE_NAME).get('couple_coupons_' + char.id);
                                req.onsuccess = () => {
                                    let coupons = req.result || [];
                                    const rewards = ['免生气券', '帮买奶茶券', '抱抱券', '跑腿券'];
                                    const rewardName = rewards[Math.floor(Math.random() * rewards.length)];
                                    coupons.unshift({ id: Date.now().toString(), name: rewardName, target: 'user' });
                                    CS_DB.transaction(CS_STORE_NAME, 'readwrite').objectStore(CS_STORE_NAME).put(coupons, 'couple_coupons_' + char.id);
                                    setTimeout(() => typeof showDynamicIsland === 'function' && showDynamicIsland(`及格啦！获得一张【${rewardName}】放入票夹`, 'success'), 1000);
                                };
                            }
                        }
                    } catch(e) { console.error(e); }
                }
                // 3. 答错：情绪树洞贴纸条
                else {
                    try {
                        // 检查空间是否解锁
                        const CS_DB_NAME = 'CoupleSpaceData';
                        const CS_STORE_NAME = 'store';
                        const idb = await new Promise(r => { const req = indexedDB.open(CS_DB_NAME, 1); req.onsuccess = () => r(req.result); req.onerror = () => r(null); });
                        if (idb) {
                            const isUnlocked = await new Promise(r => {
                                const req = idb.transaction(CS_STORE_NAME, 'readonly').objectStore(CS_STORE_NAME).get('cs_unlocked_' + char.id);
                                req.onsuccess = () => r(req.result ? req.result.unlocked : false);
                                req.onerror = () => r(false);
                            });
                            
                            if (isUnlocked) {
                                const noteKey = 'corkboard_notes_' + char.id;
                                const req = idb.transaction(CS_STORE_NAME, 'readonly').objectStore(CS_STORE_NAME).get(noteKey);
                                req.onsuccess = () => {
                                    const existing = req.result || [];
                                    existing.push({ timestamp: Date.now(), type: 'char', content: `连这么简单的问题都能考不及格（${resultData.score}分），大笨蛋。` });
                                    idb.transaction(CS_STORE_NAME, 'readwrite').objectStore(CS_STORE_NAME).put(existing, noteKey);
                                };
                            }
                        }
                        if (navigator.vibrate) navigator.vibrate([100, 50, 100]); // 震动惩罚
                    } catch(e) {}
                }

            } catch (e) {
                console.error(e);
                typeof showDynamicIsland === 'function' && showDynamicIsland('判卷失败', 'error');
            } finally {
                submitBtn.disabled = false;
            }
        });
        retryBtn?.addEventListener('click', () => {
            stamp.style.display = 'none';
            bubble.style.opacity = '0';
            const pBoard = document.getElementById('quiz-progress-board');
            if(pBoard) pBoard.style.opacity = '0'; // ▼ 修复：安全地隐藏轮数板
            switchState('idle');
        });
    }
};
