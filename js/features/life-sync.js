import { AppState, db } from '../state.js';
import { escapeHTML } from '../utils.js';
import { getLocalDateKey, getSleepHistory, getSleepProjectionPhase, getSleepRecordBySleepDate, getSleepRecordByWakeDate, getSleepSchedulePrompt, getSleepSettings, getSleepState, isValidSleepHealth, resolveSleepWindow, saveSleepProjection } from './sleep-system.js';
window.__lifeSyncPageActive = window.__lifeSyncPageActive || false;
const AUTO_SCHEDULE_MAX_RETRIES = 3;
function getLifeSyncCharacterDisplayName(char) {
    return String(char?.realName || char?.name || 'Ta').trim() || 'Ta';
}
function resolveScheduleDateKey(dayValue, reference = new Date()) {
    const day = Number(dayValue);
    if (!Number.isInteger(day) || day < 1 || day > 31) return getLocalDateKey(reference);
    const candidates = [-1, 0, 1].map(offset => new Date(reference.getFullYear(), reference.getMonth() + offset, day, 12));
    const valid = candidates.filter(candidate => candidate.getDate() === day);
    valid.sort((a, b) => Math.abs(a.getTime() - reference.getTime()) - Math.abs(b.getTime() - reference.getTime()));
    return getLocalDateKey(valid[0] || reference);
}
function isScheduleOnLocalDate(schedule, date = new Date()) {
    if (schedule?.dateISO) return schedule.dateISO === getLocalDateKey(date);
    return String(schedule?.date || '') === String(date.getDate());
}
function getSelectedLifeSyncDateKey() {
    const saved = window.tempState?.currentLifeSyncDateKey;
    return /^\d{4}-\d{2}-\d{2}$/.test(String(saved || '')) ? saved : getLocalDateKey();
}
function isLegacyScheduleOnDateKey(dayValue, dateKey) {
    // 旧数据只有“几号”，没有月份和生成日；只兼容当前真实月份中已经到达的日期，
    // 未带 dateISO 的未来日期无法证明属于本月，必须隐藏，避免复制到月份或未来日期。
    const todayKey = getLocalDateKey();
    return String(dateKey).slice(0, 7) === todayKey.slice(0, 7)
        && String(dateKey) <= todayKey
        && String(dayValue || '') === String(Number(String(dateKey).slice(8, 10)));
}
function isTimelineRowOnDate(row, dateKey) {
    const iso = row?.dataset?.scheduleDateIso || '';
    return iso ? iso === dateKey : isLegacyScheduleOnDateKey(row?.dataset?.scheduleDate, dateKey);
}
function isStoredScheduleOnDate(schedule, dateKey) {
    return schedule?.dateISO ? schedule.dateISO === dateKey : isLegacyScheduleOnDateKey(schedule?.date, dateKey);
}
function getTimelineRowDateKey(row, fallbackDateKey = getSelectedLifeSyncDateKey()) {
    const iso = row?.dataset?.scheduleDateIso || '';
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : fallbackDateKey;
}
// ▼▼▼ 新增：全局定时更新日程补偿与触发逻辑 ▼▼▼
window.triggerAutoScheduleTask = async function(charId, isManual = false, forcedTarget = '') {
    let retryKey = '';
    try {
        const char = AppState.characterProfiles.find(c => c.id === charId);
        if (!char) return;
        if (!isManual && getSleepState(char).sleeping) return;
        // 【补偿机制】检测是否该触发
        const now = new Date();
        const currentTimeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
        const lastGeneratedKey = `last_auto_schedule_time_${charId}`;
        const lastGeneratedDate = localStorage.getItem(lastGeneratedKey);
        const todayStr = getLocalDateKey(now);
        retryKey = `auto_schedule_retry_${charId}_${todayStr}`;
        if (!isManual) {
            if (!char.autoScheduleEnabled) return; // 没开启直接退出
            if (lastGeneratedDate === todayStr) return; // 今天已经补发过，退出
            if (currentTimeStr < char.autoScheduleTime) return; // 还没到设置的时间
            const retryCount = parseInt(localStorage.getItem(retryKey) || '0', 10);
            if (retryCount >= AUTO_SCHEDULE_MAX_RETRIES) return; // 今天已经自动重试满 3 次，等用户手动处理
        }
        // --- 以下是模拟调取点击 AI推演按钮的逻辑 ---
        // 构造虚拟请求参数
        const isTomorrow = forcedTarget ? forcedTarget === 'tomorrow' : char.autoScheduleTarget === 'tomorrow';
        const targetDateText = isTomorrow ? "明天" : "今天";
        const prompt = forcedTarget === 'today'
            ? `The sleep settings were just changed. The current local time is ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}. Regenerate only the not-yet-started schedule blocks for TODAY. Preserve every schedule block that has already finished. Use the current local time as a hard lower bound for newly generated activities. Re-evaluate tonight's outgoing sleep projection as part of the same generation.`
            : `Generate the character's schedule for ${targetDateText}. Preserve realistic chronological continuity, character-specific habits, previous-night wake time, existing context, and causal consistency. Also generate the outgoing sleep projection for the target date when sleep scheduling is enabled.`;
        // 悄悄存到输入框并直接触发点击事件
        const inputEl = document.getElementById('ai-schedule-prompt-input');
        const btnGen = document.getElementById('btn-ai-generate-schedule');
        if (inputEl && btnGen) {
            inputEl.value = prompt;
            
            // ▼▼▼ 核心防御1：后台把算好的数字(今天或明天)死死贴在按钮身上，坚决不让AI猜 ▼▼▼
            const backgroundTargetDate = isTomorrow ? new Date(Date.now() + 86400000) : now;
            btnGen.dataset.bgTargetDate = backgroundTargetDate.getDate().toString();
            btnGen.dataset.bgTargetDateIso = getLocalDateKey(backgroundTargetDate);
            if (forcedTarget === 'today') btnGen.dataset.preservePastSchedules = 'true';
            
                  // 短暂地修改按钮文字状态反馈
            if (isManual && typeof window.showDynamicIsland !== 'undefined') {
                window.showDynamicIsland(`正在后台自动生成${targetDateText}的行程...`, 'loading');
            }
            
            // ▼▼▼ 核心修复：解锁按钮并短暂劫持身份，防止多角色同时生成时冲突串台 ▼▼▼
            btnGen.disabled = false; 
            if (!isManual) btnGen.dataset.bgAutoRetryKey = retryKey;
            const originalCharId = window.tempState?.currentLifeSyncCharId;
            window.tempState = window.tempState || {};
            window.tempState.currentLifeSyncCharId = charId; 
            
            // 点击生成按钮，让旧有 AI 逻辑全盘接管
            btnGen.click(); 
            
            // 同步恢复身份，做到无痕伪装
            window.tempState.currentLifeSyncCharId = originalCharId;
            // ▲▲▲ 修复结束 ▲▲▲
            
        } else {
             if(isManual && typeof window.showDynamicIsland !== 'undefined') window.showDynamicIsland('必须打开过生活轨迹页面才能触发。', 'error');
        }
    } catch(err) {
        console.error('自动生成日程失败', err);
        if (!isManual && retryKey) {
            const nextRetryCount = Math.min((parseInt(localStorage.getItem(retryKey) || '0', 10) || 0) + 1, AUTO_SCHEDULE_MAX_RETRIES);
            localStorage.setItem(retryKey, String(nextRetryCount));
            if (nextRetryCount >= AUTO_SCHEDULE_MAX_RETRIES && typeof window.showDynamicIsland !== 'undefined') {
                window.showDynamicIsland('自动行程生成失败 3 次，请去后台手动生成', 'error');
            }
        } else if (isManual && typeof window.showDynamicIsland !== 'undefined') {
            window.showDynamicIsland('生成日程失败，请检查网络。', 'error');
        }
    }
};
// 后台定时轮询（每隔一分钟检查一次，满足条件则补发）
setInterval(() => {
    // ▼▼▼ 性能优化：每分钟只计算一次当前时间，防止在循环里重复计算造成哪怕一丝一毫的卡顿 ▼▼▼
    const nowTime = Date.now();
        const todayDateStr = new Date(nowTime).toDateString();
        
        // ▼▼▼ 核心修复：改为全局遍历，无论当前在看谁，只要开启了自动补发的角色都会被检查 ▼▼▼
        if (AppState && AppState.characterProfiles) {
            let hasTriggeredScheduleThisMinute = false; // 【新增：排队系统】每分钟只发一个生成名额，防止撞车串台
            
            AppState.characterProfiles.forEach(char => {
                // 1. 电量跨天充满逻辑（大家一起瞬间执行，互不影响）
                if (!char.isGroup) {
                    const lastDrainTime = parseInt(localStorage.getItem('ls_battery_time_' + char.id)) || nowTime;
                    if (new Date(lastDrainTime).toDateString() !== todayDateStr) {
                        localStorage.setItem('ls_battery_' + char.id, 100);
                        localStorage.setItem('ls_battery_time_' + char.id, nowTime);
                    }
                }
                
                // 2. 自动日程逻辑（加入排队机制，绝不打架）
                if (char.autoScheduleEnabled && !char.isGroup && !hasTriggeredScheduleThisMinute) {
                    // 提前自己判断一下他是不是真的需要生成
                    const currentTimeStr = new Date(nowTime).getHours().toString().padStart(2, '0') + ':' + new Date(nowTime).getMinutes().toString().padStart(2, '0');
                    const lastGen = localStorage.getItem(`last_auto_schedule_time_${char.id}`);
                    const todayStr = getLocalDateKey(new Date(nowTime));
                    
                    if (lastGen !== todayStr && currentTimeStr >= char.autoScheduleTime) {
                        window.triggerAutoScheduleTask(char.id, false);
                        hasTriggeredScheduleThisMinute = true; // 名额被抢占，其他需要生成的人乖乖等下一分钟
                    }
                }
            });
    } else if (window.tempState?.currentLifeSyncCharId) { 
        // 兜底容错
        window.triggerAutoScheduleTask(window.tempState.currentLifeSyncCharId, false);
        
        // ▼▼▼ 新增：兜底全局后台跨天电量检查 (零卡顿极速版) ▼▼▼
        const fallbackCharId = window.tempState.currentLifeSyncCharId;
        const lastDrainTime = parseInt(localStorage.getItem('ls_battery_time_' + fallbackCharId)) || nowTime;
        if (new Date(lastDrainTime).toDateString() !== todayDateStr) {
            localStorage.setItem('ls_battery_' + fallbackCharId, 100);
            localStorage.setItem('ls_battery_time_' + fallbackCharId, nowTime);
        }
        // ▲▲▲ 新增结束 ▲▲▲
    }
    // ▲▲▲ 修复结束 ▲▲▲
}, 67000); // 【防发热错峰】改为67秒检查一次，避开其他模块的性能挤兑
export const LifeSync = {
    init() {
        const page = document.getElementById('page-life-sync');
        if (!page) return;

        let lsPageActive = page.style.display === 'flex' || page.classList.contains('active');
        window.__lifeSyncPageActive = lsPageActive;
        const isLifeSyncPageVisible = () => lsPageActive;

        let pendingLifeSyncLoadFrame = 0;
        let lifeSyncLoadToken = 0;
        const showLifeSyncTimeline = () => {
            const timelineBox = document.querySelector('.ls-timeline');
            if (timelineBox) timelineBox.style.display = '';
        };
        const prepareLifeSyncForExit = () => {
            lifeSyncLoadToken++;
            if (pendingLifeSyncLoadFrame) {
                cancelAnimationFrame(pendingLifeSyncLoadFrame);
                pendingLifeSyncLoadFrame = 0;
            }
            const timelineBox = document.querySelector('.ls-timeline');
            if (timelineBox) {
                timelineBox.style.display = 'none';
            }
        };
        const loadCurrentLifeSyncCharIfVisible = () => {
            if (!isLifeSyncPageVisible()) return;
            if (!window.tempState?.currentLifeSyncCharId || typeof window.loadLsDataForChar !== 'function') return;
            showLifeSyncTimeline();
            if (pendingLifeSyncLoadFrame) cancelAnimationFrame(pendingLifeSyncLoadFrame);
            pendingLifeSyncLoadFrame = requestAnimationFrame(() => {
                pendingLifeSyncLoadFrame = 0;
                if (isLifeSyncPageVisible()) window.loadLsDataForChar(window.tempState.currentLifeSyncCharId);
            });
        };
        
        // ▼▼▼ 核心防御：防止页面来回切换导致事件被重复绑定（点一次保存存多条数据） ▼▼▼
        if (page.dataset.initialized === 'true') {
            // 如果已经初始化绑过事件了，只刷新数据，直接退回
            loadCurrentLifeSyncCharIfVisible();
            return;
        }
        page.dataset.initialized = 'true';
        window.addEventListener('looky:page-opened', (event) => {
            lsPageActive = event.detail?.pageId === 'page-life-sync';
            window.__lifeSyncPageActive = lsPageActive;
            if (lsPageActive) {
                loadCurrentLifeSyncCharIfVisible();
            } else {
                prepareLifeSyncForExit();
            }
        });
        const lifeSyncBackBtn = page.querySelector('.ls-back-btn');
        if (lifeSyncBackBtn) {
            lifeSyncBackBtn.addEventListener('touchend', prepareLifeSyncForExit, { passive: true, capture: true });
            lifeSyncBackBtn.addEventListener('click', prepareLifeSyncForExit, true);
        }
        // ▲▲▲ 防御结束 ▲▲▲

        // --- 核心修复：一进页面先确定当前是谁，防止存取数据时找不到人 ---
        window.tempState = window.tempState || {};
        if (!window.tempState.currentLifeSyncCharId) {
            // 如果还没选过，默认拿第一个好友的ID
            const defaultChar = AppState.characterProfiles.find(c => !c.isGroup);
            window.tempState.currentLifeSyncCharId = defaultChar ? defaultChar.id : 'default_char';
        }
        // --- 新增：地图中心头像点击切换角色逻辑 ---
        const mapAvatarPin = page.querySelector('#wrapper-content-map .pin-avatar');
        const mapAvatarImg = mapAvatarPin ? mapAvatarPin.querySelector('img') : null;
        const taAvatarPin = page.querySelector('#ls-view-ta .ls-location .pin-avatar');
        const taAvatarImg = document.getElementById('ls-location-avatar');
        const charSelectModal = document.getElementById('ls-char-select-modal-overlay');
        const closeCharSelectBtn = document.getElementById('close-ls-char-select-btn');
        const charSelectList = document.getElementById('ls-char-select-list');

        const openCharSelectModal = () => {
            if (charSelectList) {
                charSelectList.innerHTML = '';
                const chars = AppState.characterProfiles.filter(c => !c.isGroup);
                if (chars.length === 0) {
                    charSelectList.innerHTML = '<div style="text-align:center; color:#999; padding: 20px;">暂无好友可选</div>';
                } else {
                    chars.forEach(char => {
                        const item = document.createElement('div');
                        item.style.cssText = 'display: flex; align-items: center; gap: 12px; padding: 10px; background: #fafafa; border-radius: 12px; cursor: pointer; transition: background 0.2s;';
                        item.innerHTML = `
                            <img src="${char.avatar || 'images/default-avatar.svg'}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover;">
                            <span style="font-size: 15px; font-weight: 600; color: #333;">${getLifeSyncCharacterDisplayName(char)}</span>
                        `;
                        item.addEventListener('click', () => {
                            // 1. 替换地图和顶部大卡片的头像
                            if (mapAvatarImg) mapAvatarImg.src = char.avatar || 'images/default-avatar.svg';
                            if (taAvatarImg) taAvatarImg.src = char.avatar || 'images/default-avatar.svg';
                            
                            // 2. 可以在这里更新全局或局部的状态，标识当前展示的数据属于谁
                            window.tempState = window.tempState || {};
                            window.tempState.currentLifeSyncCharId = char.id;
                            
                            // ★ 新增：角色换了，立刻清空旧数据并拉取新角色的专属数据 ★
                            if (typeof window.loadLsDataForChar === 'function') {
                                window.loadLsDataForChar(char.id);
                            }
                            // 3. 关闭弹窗
                            charSelectModal.style.opacity = '0';
                            setTimeout(() => charSelectModal.style.display = 'none', 300);
                        });
                        charSelectList.appendChild(item);
                    });
                }
            }
            charSelectModal.style.display = 'flex';
            setTimeout(() => charSelectModal.style.opacity = '1', 10);
        };

        if (mapAvatarPin && charSelectModal) {
            mapAvatarPin.style.cursor = 'pointer';
            mapAvatarPin.addEventListener('click', openCharSelectModal);
        }
        if (taAvatarPin && charSelectModal) {
            taAvatarPin.style.cursor = 'pointer';
            taAvatarPin.addEventListener('click', openCharSelectModal);
        }
            
        if (closeCharSelectBtn) {
                    closeCharSelectBtn.addEventListener('click', () => {
                charSelectModal.style.opacity = '0';
                setTimeout(() => charSelectModal.style.display = 'none', 300);
            });
        }
        // ▼▼▼ 新增：拍一拍按钮 (ls-nudge-btn) 的打断与弹窗逻辑 ▼▼▼
        const nudgeBtn = document.getElementById('ls-nudge-btn');
        if (nudgeBtn) {
            nudgeBtn.addEventListener('click', async () => {
                const charId = window.tempState?.currentLifeSyncCharId;
                if (!charId) return;
                
                // ▼▼▼ 新增：拦截非工作时间的拍一拍 ▼▼▼
                try {
                    const record = await db.appData.get('ls_schedules_data_' + charId);
                    let isWorking = false;
                    if (record && record.value && record.value.length > 0) {
                        const now = new Date();
                        const todayStr = now.getDate().toString();
                        const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
                        
                        // 找到当前正在进行的行程
                        const currentSchedule = record.value.find(s => 
                            isScheduleOnLocalDate(s, now) && s.startTime <= currentTime && s.endTime >= currentTime && (s.owner === 'ta' || s.owner === 'joint')
                        );
                        
                        // 和聊天拦截保持完全一致的判断标准
                        if (currentSchedule) {
                            const locInfo = (currentSchedule.locName || '') + (currentSchedule.content || '');
                            if (locInfo.includes('公司') || locInfo.includes('工作') || locInfo.includes('开会') || locInfo.includes('办公室') || currentSchedule.type === '工作') {
                                isWorking = true;
                            }
                        }
                    }
                    
                    // 如果不在工作，弹出一个小胶囊提示，并直接结束，不增加次数
                    if (!isWorking) {
                        const toast = document.createElement('div');
                        toast.style.cssText = 'position: fixed; top: 15%; left: 50%; transform: translateX(-50%); background: rgba(30, 30, 30, 0.85); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); color: #fff; padding: 12px 24px; border-radius: 20px; font-size: 13px; font-weight: bold; z-index: 10005; opacity: 0; transition: opacity 0.3s; pointer-events: none; box-shadow: 0 4px 15px rgba(0,0,0,0.15);';
                        toast.innerText = 'Ta现在没在忙，直接去发消息吧~';
                        document.body.appendChild(toast);
                        setTimeout(() => toast.style.opacity = '1', 10);
                        setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 2000);
                        return; // ★ 核心：阻断后续的点击计数和解锁操作
                    }
                } catch(e) { console.error('工作状态检测失败', e); }
                // ▲▲▲ 拦截结束 ▲▲▲

                if (!window.tempState.dndInterruptCount) window.tempState.dndInterruptCount = {};
                let count = (window.tempState.dndInterruptCount[charId] || 0) + 1;
                window.tempState.dndInterruptCount[charId] = count;
                
                if (count >= 3) {
                    // 解锁并挂上免死金牌
                    window.tempState.dndForceUnlockTurns = window.tempState.dndForceUnlockTurns || {};
                    window.tempState.dndForceUnlockTurns[charId] = 5;
                    window.tempState.dndOneTimePrompt = window.tempState.dndOneTimePrompt || {};
                                   window.tempState.dndOneTimePrompt[charId] = true;
                    window.tempState.dndInterruptCount[charId] = 0; // 归零
                    
                    // ▼▼▼ 替换为专属设计的精美居中弹窗 ▼▼▼
                    const nudgeOverlay = document.createElement('div');
                    nudgeOverlay.className = 'modal-overlay';
                    nudgeOverlay.style.cssText = 'z-index: 10005; display: flex; opacity: 0; background: rgba(0,0,0,0.4); transition: opacity 0.3s; position: fixed; inset: 0; width: 100vw; height: 100dvh; min-height: 100dvh; align-items: center; justify-content: center; box-sizing: border-box; overflow: hidden; touch-action: none; overscroll-behavior: contain; padding: max(20px, env(safe-area-inset-top)) 0 max(20px, env(safe-area-inset-bottom)) 0;';
                    nudgeOverlay.innerHTML = `
                      <div class="modal-card" style="width: 90%; max-width: 340px; max-height: calc(100dvh - 40px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); padding: 30px 20px; text-align: center; border-radius: 24px; background: #fff; box-shadow: 0 10px 30px rgba(0,0,0,0.1); box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;">
                        <div style="margin-bottom: 15px;">
                          <svg viewBox="0 0 24 24" fill="none" stroke="#D3A7A5" stroke-width="2.5" style="width: 48px; height: 48px; margin: 0 auto;">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                            <polyline points="22 4 12 14.01 9 11.01"></polyline>
                          </svg>
                        </div>
                        <h3 style="margin: 0 0 10px; color: #333; font-size: 18px; font-weight: 700;">打断成功！</h3>
                        <p style="color: #888; font-size: 13px; line-height: 1.6; margin-bottom: 25px;">Ta 的专注模式已为你强行解除，接下来的 5 轮消息将畅通无阻。</p>
                        <button id="close-nudge-modal" style="width: 100%; background: #000; color: #FFF; border: none; padding: 12px; border-radius: 14px; font-size: 14px; font-weight: bold; cursor: pointer;">去发消息</button>
                      </div>
                    `;
                    document.body.appendChild(nudgeOverlay);
                    
                    // 添加渐显动画
                    setTimeout(() => nudgeOverlay.style.opacity = '1', 10);
                    
                    // 点击关闭按钮后销毁弹窗
                    nudgeOverlay.querySelector('#close-nudge-modal').onclick = () => {
                        nudgeOverlay.style.opacity = '0';
                        setTimeout(() => nudgeOverlay.remove(), 300);
                    };
                    
                    // 记录你拍了Ta的动作（仅写入数据库当证据，不主动烦AI）
                    try {
                        await db.chatMessages.add({
                            chatId: charId, 
                            timestamp: new Date(), 
                            text: `[系统提示：用户刚刚疯狂“拍了拍”你！]`, 
                            type: 'system', 
                            contentType: 'system_event', 
                            eventType: 'info', 
                            uiVisible: true, 
                            aiVisible: true,
                            recalled: false
                        });
                        // 删除了主动请求 API 的代码，等用户自己发消息
                    } catch(e) { console.error('拍一拍记录失败', e); }
                } else {
                    // 次数不够时，生成一个精致的黑色半透明悬浮胶囊提示
                    const toast = document.createElement('div');
                    toast.style.cssText = 'position: fixed; top: 15%; left: 50%; transform: translateX(-50%); background: rgba(30, 30, 30, 0.85); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); color: #fff; padding: 12px 24px; border-radius: 20px; font-size: 13px; font-weight: bold; z-index: 10005; opacity: 0; transition: opacity 0.3s; pointer-events: none; box-shadow: 0 4px 15px rgba(0,0,0,0.15);';
                    toast.innerText = `戳了戳 Ta... (第 ${count}/3 次)`;
                    document.body.appendChild(toast);
                    
                    setTimeout(() => toast.style.opacity = '1', 10); // 浮现
                    setTimeout(() => {
                        toast.style.opacity = '0'; // 隐去
                        setTimeout(() => toast.remove(), 300);
                    }, 2000); // 停留2秒
                }
            });
        }
        // ▲▲▲ 新增结束 ▲▲▲
        // --- 核心新增：把屏幕上的日程保存进“大仓库”的工具 ---
        const saveSchedulesToDB = async () => {
            const currentCharId = window.tempState.currentLifeSyncCharId;
            const selectedDateKey = getSelectedLifeSyncDateKey();
            const rows = document.querySelectorAll('.ls-timeline .tl-row');
            const schedules = [];
            const schedulesData = []; // [新增] 用于喂给AI的纯净数据结构
            const dateKeysToReplace = new Set([selectedDateKey]);
            rows.forEach(row => {
                const card = row.querySelector('.tl-card.dynamic-schedule');
                if (card) {
                    const rowDate = row.getAttribute('data-schedule-date');
                    const rowDateISO = row.dataset.scheduleDateIso || selectedDateKey;
                    dateKeysToReplace.add(rowDateISO);
                    // 先复制一份干净的代码，把因为时间过期变灰等临时状态去掉，防止存进去坏掉
                    const cloneRow = row.cloneNode(true);
                    const cloneCard = cloneRow.querySelector('.tl-card.dynamic-schedule');
                    cloneCard.classList.remove('active-trip', 'past-trip');
                    const stamp = cloneCard.querySelector('.done-stamp');
                    if (stamp) stamp.remove();
                    cloneCard.style.opacity = '1';
                    cloneCard.style.filter = 'none';
                    cloneCard.style.display = ''; // 核心修复：彻底撕掉卡片残留的隐身符
                   cloneRow.style.display = '';  // 核心修复：彻底撕掉整行残留的隐身符
                    cloneRow.dataset.scheduleDateIso = rowDateISO;
                            // 把纯净的 HTML 存进数组
                    schedules.push({ rowHTML: cloneRow.outerHTML });
                    let owner = 'ta';
                    if (card.classList.contains('mine')) owner = 'mine';
                    if (card.classList.contains('joint-trip')) owner = 'joint';
                    schedulesData.push({
                        date: row.getAttribute('data-schedule-date'),
                        dateISO: rowDateISO,
                        startTime: card.dataset.startTime || '00:00',
                        endTime: card.dataset.endTime || '23:59',
                        content: card.dataset.content || '', // 【安全护栏】保持核心本体数据绝对纯净
                        type: card.dataset.type || '',
                        locName: card.dataset.locname || '', // ▼▼▼ 修复：将 locName 存入数据库，解决显示未知地点的问题 ▼▼▼
                        isShared: card.dataset.shared === 'true',
                        owner: owner,
                        accidentReason: card.dataset.accidentreason || '' // 【新增】作为隐秘独立档案落库
                    });
                }
            });
               // 存入 IndexedDB 里的 appData 表。★修改：加上角色的身份证★
            return Promise.all([
                db.appData.get('ls_schedules_' + currentCharId),
                db.appData.get('ls_schedules_data_' + currentCharId)
            ]).then(([oldHtmlRecord, oldDataRecord]) => {
                const oldHtmlList = oldHtmlRecord?.value || [];
                const oldDataList = oldDataRecord?.value || [];
                const keptHtmlList = [];
                const keptDataList = [];
                oldDataList.forEach((oldData, index) => {
                    const oldHtml = oldHtmlList[index];
                    const isReplacing = oldData.dateISO
                        ? dateKeysToReplace.has(oldData.dateISO)
                        : isLegacyScheduleOnDateKey(oldData.date, selectedDateKey);
                    if (!isReplacing && oldHtml) {
                        keptDataList.push(oldData);
                        keptHtmlList.push(oldHtml);
                    }
                });
                return Promise.all([
                    db.appData.put({ key: 'ls_schedules_' + currentCharId, value: [...keptHtmlList, ...schedules] }),
                    db.appData.put({ key: 'ls_schedules_data_' + currentCharId, value: [...keptDataList, ...schedulesData] })
                ]);
            }).then(() => {
                // ★ 新增：每次保存数据时，顺便把顶部的状态卡片也同步刷新一下 ★
                if (typeof window.updateLsStatusCards === 'function') window.updateLsStatusCards();
            }).catch(e => console.error(e));
        };
        const deleteSchedulesForDateFromDB = async (charId, dateKey) => {
            if (!charId || !dateKey) return;
            const [htmlRecord, dataRecord] = await Promise.all([
                db.appData.get('ls_schedules_' + charId),
                db.appData.get('ls_schedules_data_' + charId)
            ]);
            const htmlList = Array.isArray(htmlRecord?.value) ? htmlRecord.value : [];
            const dataList = Array.isArray(dataRecord?.value) ? dataRecord.value : [];
            const keptHtmlList = htmlList.filter((entry, index) => {
                const wrapper = document.createElement('div');
                wrapper.innerHTML = entry?.rowHTML || '';
                const row = wrapper.firstElementChild;
                return !(row && isTimelineRowOnDate(row, dateKey)) && !isStoredScheduleOnDate(dataList[index], dateKey);
            });
            const keptDataList = dataList.filter(item => !isStoredScheduleOnDate(item, dateKey));
            await db.transaction('rw', db.appData, async () => {
                await db.appData.put({ key: 'ls_schedules_' + charId, value: keptHtmlList });
                await db.appData.put({ key: 'ls_schedules_data_' + charId, value: keptDataList });
            });
        };

        // ▼▼▼ 新增：全局同步用户的单人日程 ▼▼▼
        const syncGlobalMineSchedules = async () => {
            const currentCharId = window.tempState?.currentLifeSyncCharId;
            if (!currentCharId) return;
            try {
                const curHtmlRecord = await db.appData.get('ls_schedules_' + currentCharId);
                const curDataRecord = await db.appData.get('ls_schedules_data_' + currentCharId);
                const curHtmlList = curHtmlRecord ? curHtmlRecord.value : [];
                const curDataList = curDataRecord ? curDataRecord.value : [];
                
                const mineDataList = [];
                const mineHtmlList = [];
                curDataList.forEach((dataItem, index) => {
                    if (dataItem.owner === 'mine') {
                        mineDataList.push(dataItem);
                        mineHtmlList.push(curHtmlList[index]);
                    }
                });

                for (const char of AppState.characterProfiles) {
                    if (char.id === currentCharId || char.isGroup) continue;
                    
                    const targetHtmlRecord = await db.appData.get('ls_schedules_' + char.id);
                    const targetDataRecord = await db.appData.get('ls_schedules_data_' + char.id);
                    let targetHtmlList = targetHtmlRecord ? targetHtmlRecord.value : [];
                    let targetDataList = targetDataRecord ? targetDataRecord.value : [];
                    
                    const filteredDataList = [];
                    const filteredHtmlList = [];
                    targetDataList.forEach((dItem, idx) => {
                        if (dItem.owner !== 'mine') {
                            filteredDataList.push(dItem);
                            filteredHtmlList.push(targetHtmlList[idx]);
                        }
                    });

                    filteredDataList.push(...mineDataList);
                    filteredHtmlList.push(...mineHtmlList);

                    const combined = filteredDataList.map((dataObj, i) => {
                        return { data: dataObj, html: filteredHtmlList[i] };
                    });
                    combined.sort((a, b) => a.data.startTime.localeCompare(b.data.startTime));

                    await db.appData.put({ key: 'ls_schedules_' + char.id, value: combined.map(c => c.html) });
                    await db.appData.put({ key: 'ls_schedules_data_' + char.id, value: combined.map(c => c.data) });
                }
            } catch (err) {
                console.error('[全局同步我的行程] 失败:', err);
            }
        };
        // ▲▲▲ 新增结束 ▲▲▲

        // --- 核心新增：实时提取当前行程，同步给顶部大卡片（作息与专注）的智能工具 ---
        window.updateLsStatusCards = async (forceUpdate = false) => {
            if (!forceUpdate && !isLifeSyncPageVisible()) return;
            const timelineBox = document.querySelector('.ls-timeline');
            if (!timelineBox) return;

            const now = new Date();
            const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
            const todayStr = now.getDate().toString();

            let activeCard = null;
            // 寻找今天正在进行的行程，优先展示角色的（Ta 或 Joint），不展示纯“我”的
            const rows = Array.from(timelineBox.querySelectorAll('.tl-row'));
            for (const row of rows) {
                if (!isTimelineRowOnDate(row, getLocalDateKey())) continue; // 必须是今天的行程

                const card = row.querySelector('.tl-card.dynamic-schedule');
                if (!card) continue;
                // 只看包含 Ta的行程 或 共同行程
                if (!card.classList.contains('ta-trip') && !card.classList.contains('joint-trip')) continue;

                const sTime = card.dataset.startTime || '00:00';
                const eTime = card.dataset.endTime || '23:59';

                if (sTime <= currentTime && eTime >= currentTime) {
                    activeCard = card;
                    break;
                }
            }
            if (!activeCard) {
                const charIdForStatus = window.tempState?.currentLifeSyncCharId;
                const record = charIdForStatus ? await db.appData.get('ls_schedules_data_' + charIdForStatus) : null;
                const activeSchedule = record?.value?.find(item => {
                    if (!isStoredScheduleOnDate(item, getLocalDateKey())) return false;
                    if (item.owner !== 'ta' && item.owner !== 'joint') return false;
                    const sTime = item.startTime || '00:00';
                    const eTime = item.endTime || '23:59';
                    return sTime <= currentTime && eTime >= currentTime;
                });
                if (activeSchedule) {
                    activeCard = {
                        dataset: {
                            startTime: activeSchedule.startTime || '00:00',
                            endTime: activeSchedule.endTime || '23:59',
                            type: activeSchedule.type || '日程',
                            content: activeSchedule.content || '',
                            locname: activeSchedule.locName || ''
                        }
                    };
                }
            }
                    // 获取 UI 元素
            const focusCard = document.querySelector('.ls-card.bento-large.ls-focus');
            const scheduleCard = document.querySelector('.ls-card.bento-wide.ls-schedule');
            
            // ▼▼▼ 新增：抓住顶部大卡片的心脏，准备随时控制头像飞行 ▼▼▼
            const locationCard = document.querySelector('.ls-card.ls-location');
            const locAvatar = locationCard ? locationCard.querySelector('.pin-avatar') : null;
            const locRadar = locationCard ? locationCard.querySelector('.radar-waves') : null;
            const locText = locationCard ? locationCard.querySelector('.loc-text') : null;
            const locMapBg = locationCard ? locationCard.querySelector('.map-bg') : null;
            
            // 抓住步数卡片，随时准备修改异常数据
            const stepsCard = document.querySelector('.ls-card.bento-square.ls-steps');
            const stepsVal = stepsCard ? stepsCard.querySelector('.data-val') : null;
            const stepsHint = stepsCard ? stepsCard.querySelector('.data-hint') : null;
            // ▲▲▲ 新增结束 ▲▲▲
            // ▼▼▼ 新增：手机电量自动流失与充电互动引擎 ▼▼▼
            const charIdForBattery = window.tempState?.currentLifeSyncCharId || 'default_char';
            const batteryCard = document.getElementById('ls-battery-card');
            const batteryVal = document.getElementById('ls-battery-val');
            const batteryHint = document.getElementById('ls-battery-hint');
            const batteryIconWrap = document.getElementById('ls-battery-icon-wrap');
                  // 1. 基于真实时间的电量流失算法，绝不因为UI刷新而多扣电
            let currentBattery = parseInt(localStorage.getItem('ls_battery_' + charIdForBattery));
            if (isNaN(currentBattery)) currentBattery = 100;
            
            // 注意：这里把 const 改成了 let，以允许跨天时重置时间
            let lastDrainTime = parseInt(localStorage.getItem('ls_battery_time_' + charIdForBattery)) || Date.now();
            const nowTime = Date.now();

            // ▼▼▼ 新增：第二天跨天自动充满电量逻辑 ▼▼▼
            // 判断上次活动时间与当前是否属于同一天，如果不是同一天，则满血复活
            if (new Date(lastDrainTime).toDateString() !== new Date(nowTime).toDateString()) {
                currentBattery = 100;
                lastDrainTime = nowTime; // 重置时间起点，防止刚充满就继续按昨天的差值狂扣电
                localStorage.setItem('ls_battery_' + charIdForBattery, 100);
            }
            // ▲▲▲ 新增结束 ▲▲▲

            // 计算距离上次扣电过去了多少分钟
            const minutesPassed = Math.floor((nowTime - lastDrainTime) / 60000);
            // ▼▼▼ 修改：根据行程类型动态调整电量流失或充电速度 ▼▼▼
            let drainInterval = 15; // 默认空闲时 15 分钟掉 1%
            let isCharging = false; // 标记当前是否在充电状态
            
            if (activeCard) {
                const scheduleType = activeCard.dataset.type;
                if (scheduleType === '工作') {
                    drainInterval = 30; // 工作时手机用的少，30分钟才掉1%（变慢）
                } else if (scheduleType === '吃饭' || scheduleType === '娱乐') {
                    drainInterval = 5;  // 吃饭和娱乐时一直玩手机，5分钟掉1%（变快）
                } else if (scheduleType === '休息') {
                    drainInterval = 10; // 休息时插着充电线，10分钟充1%（自动充电）
                    isCharging = true;
                } else {
                    drainInterval = 8;  // 其他未知情况 8分钟掉1%
                }
            }
            
            if (minutesPassed >= drainInterval) {
                const dropAmount = Math.floor(minutesPassed / drainInterval);
                if (isCharging) {
                    currentBattery += dropAmount; // 休息时执行充电逻辑
                    if (currentBattery > 100) currentBattery = 100;
                } else {
                    currentBattery -= dropAmount; // 其他时间执行掉电逻辑
                    if (currentBattery < 0) currentBattery = 0;
                }
                
                localStorage.setItem('ls_battery_' + charIdForBattery, currentBattery);
                // 更新扣电时间戳，把不足一个周期的时间余数保留
                localStorage.setItem('ls_battery_time_' + charIdForBattery, nowTime - ((minutesPassed % drainInterval) * 60000));
            } else if (!localStorage.getItem('ls_battery_time_' + charIdForBattery)) {
                // 初次初始化时间
                localStorage.setItem('ls_battery_time_' + charIdForBattery, nowTime);
            }
            
            // 2. 更新UI颜色
            if (batteryVal) batteryVal.textContent = currentBattery + '%';
            if (batteryCard) {
                if (currentBattery > 20) {
                    batteryHint.textContent = '电量健康';
                    batteryHint.style.color = '#A3958F';
                    batteryIconWrap.style.color = '#9CB4A1'; 
                } else if (currentBattery > 0) {
                    batteryHint.textContent = '电量告急 · 随时失联';
                    batteryHint.style.color = '#E28F8F';
                    batteryIconWrap.style.color = '#E28F8F'; 
                } else {
                    batteryHint.textContent = '已关机 · 无法联系';
                    batteryHint.style.color = '#999';
                    batteryIconWrap.style.color = '#999'; 
                }
            }
            
            // 3. 居中可爱弹窗函数
            const showCuteBatteryToast = (text) => {
                const toast = document.createElement('div');
                toast.style.cssText = 'position: fixed; top: 40%; left: 50%; transform: translate(-50%, -50%) scale(0.9); background: #FDFCF9; color: #5C544D; padding: 18px 24px; border-radius: 20px; font-size: 14px; font-weight: bold; z-index: 10005; opacity: 0; transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); box-shadow: 0 10px 30px rgba(110, 92, 83, 0.15); border: 2px solid #EBE4DD; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 8px;';
                toast.innerHTML = `<svg viewBox="0 0 24 24" fill="#9CB4A1" style="width: 32px; height: 32px;"><path d="M15.67 4H14V2h-4v2H8.33C7.6 4 7 4.6 7 5.33v15.33C7 21.4 7.6 22 8.33 22h7.33c.74 0 1.34-.6 1.34-1.33V5.33C17 4.6 16.4 4 15.67 4z"/></svg><span>${text}</span>`;
                document.body.appendChild(toast);
                setTimeout(() => { toast.style.opacity = '1'; toast.style.transform = 'translate(-50%, -50%) scale(1)'; }, 10);
                setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translate(-50%, -50%) scale(0.9)'; setTimeout(() => toast.remove(), 300); }, 2500);
            };

            // 4. 绑定点击充电事件 (防闭包穿透，每次点击实时获取当前显示的真实角色ID)
            if (batteryCard && !batteryCard.hasAttribute('data-has-click')) {
                batteryCard.setAttribute('data-has-click', 'true');
                batteryCard.addEventListener('click', () => {
                    // 核心修复：实时获取当前屏幕上角色的ID，不再受闭包干扰导致错位
                    const realTimeCharId = window.tempState?.currentLifeSyncCharId || 'default_char';
                    let bat = parseInt(localStorage.getItem('ls_battery_' + realTimeCharId)) || 0;
                    
                    if (bat >= 100) {
                        showCuteBatteryToast('Ta的手机已经充满啦！✨');
                        return;
                    }
                    bat = Math.min(100, bat + 15); // 每次充15%
                    localStorage.setItem('ls_battery_' + realTimeCharId, bat);
                    showCuteBatteryToast('⚡ 成功为 Ta 远程注入电量！');
                    window.updateLsStatusCards(); // 立刻刷新UI颜色
                });
            }
            // 偷偷检测今天有没有被随机意外事件砸中
            let accidentOccurred = false;
            rows.forEach(r => {
                if (isTimelineRowOnDate(r, getLocalDateKey())) {
                    const c = r.querySelector('.tl-card.ta-trip');
                    if (c && c.dataset.accident === 'true') {
                        const sTime = c.dataset.startTime || '00:00';
                        // 核心防线：只有当前时间已经跨越了行程开始时间，意外才算真正爆发！
                        if (sTime <= currentTime) {
                            accidentOccurred = true;
                            // 唤醒原本处于隐身状态的通知胶囊
                            const cap = c.querySelector('.accident-capsule');
                            if (cap) cap.style.display = 'inline-block';
                        }
                    }
                }
            });

            // ▼▼▼ 修改：引入真实的步数自然增长算法 ▼▼▼
            const charIdForSteps = window.tempState?.currentLifeSyncCharId || 'default_char';
            const todayDateStr = now.toISOString().slice(0, 10);
            
            // 1. 检查是否跨天，如果跨天就清零重置
            const lastStepDate = localStorage.getItem('ls_steps_date_' + charIdForSteps);
            if (lastStepDate !== todayDateStr) {
                localStorage.setItem('ls_steps_date_' + charIdForSteps, todayDateStr);
                // 早上起点基础步数稍微给点，假装在家里洗漱走动
                localStorage.setItem('ls_steps_val_' + charIdForSteps, Math.floor(Math.random() * 200) + 100); 
                localStorage.setItem('ls_steps_time_' + charIdForSteps, Date.now());
            }

            let currentSteps = parseInt(localStorage.getItem('ls_steps_val_' + charIdForSteps)) || 200;
            const lastStepTime = parseInt(localStorage.getItem('ls_steps_time_' + charIdForSteps)) || Date.now();
            const stepMinutesPassed = Math.floor((Date.now() - lastStepTime) / 60000);

            // 2. 每过 1 分钟，计算一次新增步数
            if (stepMinutesPassed >= 1) {
                let stepsPerMinute = 15; // 空闲时四处溜达的基础速度
                if (activeCard) {
                    const t = activeCard.dataset.type;
                    if (t === '工作') stepsPerMinute = 5;       // 坐着办公，步数很少
                    else if (t === '休息') stepsPerMinute = 0;  // 睡觉躺着，停止计步
                    else if (t === '吃饭') stepsPerMinute = 3;  // 坐着吃饭，极少步数
                    else if (t === '娱乐') stepsPerMinute = 35; // 逛街/玩乐，疯狂走路
                }
                
                // 加上一点点随机波动(0~4)，让数字显得更真实不做作
                const actualStepIncrease = stepMinutesPassed * (stepsPerMinute + Math.floor(Math.random() * 5));
                currentSteps += actualStepIncrease;
                
                localStorage.setItem('ls_steps_val_' + charIdForSteps, currentSteps);
                localStorage.setItem('ls_steps_time_' + charIdForSteps, Date.now() - ((Date.now() - lastStepTime) % 60000));
            }

            // 3. 根据是否有意外，操控最终的步数仪表显示
            let displaySteps = currentSteps;
            if (accidentOccurred) {
                displaySteps += 18500; // 意外爆发，假装突然跑了很远
                if (stepsVal) stepsVal.textContent = displaySteps.toLocaleString() + ' 步'; // toLocaleString 会自动加千分位逗号
                if (stepsHint) { stepsHint.textContent = '步数异常飙升，Ta似乎去了别的地方...'; stepsHint.style.color = '#E28F8F'; }
            } else {
                if (stepsVal) stepsVal.textContent = displaySteps.toLocaleString() + ' 步';
                if (stepsHint) { stepsHint.textContent = '今日步数随行程平稳增加中'; stepsHint.style.color = '#A3958F'; }
            }
            // ▲▲▲ 修改结束 ▲▲▲

            if (!focusCard || !scheduleCard) return;

            const focusTitle = focusCard.querySelector('.focus-title');
            const focusProgress = focusCard.querySelector('.focus-progress .bar');
            const focusDesc = focusCard.querySelector('.focus-desc');
            const sStatus = document.getElementById('ls-schedule-status');
            const sTimeEl = scheduleCard.querySelector('.s-time');
            const sTitle = scheduleCard.querySelector('.s-title');

            if (activeCard) {
                const sTime = activeCard.dataset.startTime || '00:00';
                const eTime = activeCard.dataset.endTime || '23:59';
                const type = activeCard.dataset.type || '日程';
                let content = activeCard.dataset.content || '未知安排';
                
                // ▼▼▼ 核心动效：顺着行程的名字摸进世界数据库，提取坐标并飞过去 ▼▼▼
                const locName = activeCard.dataset.locname || '';
                let targetTop = '40%', targetLeft = '50%', displayText = content;
                if (locName) {
                    displayText = locName;
                    const charId = window.tempState?.currentLifeSyncCharId || 'default_char';
                    const boundPack = localStorage.getItem('ls_bound_map_' + charId);
                    if (boundPack) {
                        const mapData = JSON.parse(localStorage.getItem('looky_map_packs') || '{}')[boundPack] || [];
                        const targetLoc = mapData.find(l => l.name === locName);
                        if (targetLoc && targetLoc.top && targetLoc.left) {
                            targetTop = targetLoc.top; targetLeft = targetLoc.left;
                        }
                    }
                }
                if (locAvatar) { locAvatar.style.top = targetTop; locAvatar.style.left = targetLeft; locAvatar.style.transition = 'all 0.5s ease-in-out'; }
                if (locRadar) { locRadar.style.top = targetTop; locRadar.style.left = targetLeft; locRadar.style.transition = 'all 0.5s ease-in-out'; }
                if (locText) { locText.textContent = `${displayText} · 进行中`; }
                
                // 让大卡片的底图跟随坐标反向偏移，产生地图跟随镜头平移的视差效果！
                if (locMapBg) { 
                    locMapBg.style.backgroundPosition = `${targetLeft} ${targetTop}`; 
                    locMapBg.style.transition = 'background-position 1s cubic-bezier(0.25, 1, 0.5, 1)'; 
                }
                // ▲▲▲ 核心动效结束 ▲▲▲

                // 计算进度比例
                const toMinutes = (t) => {
                    const [h, m] = t.split(':').map(Number);
                    return h * 60 + m;
                };
                const startMins = toMinutes(sTime);
                const endMins = toMinutes(eTime);
                const curMins = toMinutes(currentTime);

                const total = endMins - startMins || 1;
                const elapsed = curMins - startMins;
                let percent = (elapsed / total) * 100;
                if (percent < 0) percent = 0;
                if (percent > 100) percent = 100;

                // 更新左侧大卡片 (专注状态)
                if (focusTitle) focusTitle.textContent = type === '工作' ? `${type}中 (DND)` : `${type}中`;
                if (focusProgress) focusProgress.style.width = `${percent}%`;
                if (focusDesc) focusDesc.textContent = `已持续 ${elapsed} 分钟 · ${type === '工作' ? '消息将静默送达' : '随时可以找TA'}`;
                 // 更新右下卡片 (作息状态)
                if (sTitle) sTitle.textContent = '当前作息状态';
                if (sStatus) sStatus.textContent = content.length > 12 ? content.substring(0, 12) + '...' : content;
                if (sTimeEl) sTimeEl.textContent = `${sTime} - ${eTime}`;
                
                // ▼▼▼ 新增：同步更新 Live Monitor 的状态信息 ▼▼▼
                const monitorMainStatus = document.querySelector('.ls-monitor-card .status-info .main-status');
                const monitorSubStatus = document.querySelector('.ls-monitor-card .status-info .sub-status');
                if (monitorMainStatus) monitorMainStatus.textContent = content.length > 15 ? content.substring(0, 15) + '...' : content;
                if (monitorSubStatus) monitorSubStatus.textContent = `进行中 · 预计 ${eTime} 结束`;
                // ▲▲▲ 新增结束 ▲▲▲

            } else {
                // 当前时间没有任何进行中的行程
                
                // ▼▼▼ 行程结束，让头像和背景重回复位归中 ▼▼▼
                if (locAvatar) { locAvatar.style.top = '40%'; locAvatar.style.left = '50%'; locAvatar.style.transition = 'all 0.8s cubic-bezier(0.175, 0.885, 0.32, 1.275)'; }
                if (locRadar) { locRadar.style.top = '40%'; locRadar.style.left = '50%'; locRadar.style.transition = 'all 0.8s cubic-bezier(0.175, 0.885, 0.32, 1.275)'; }
                if (locText) { locText.textContent = '自由安排 · 随心漫游中'; }
                if (locMapBg) { locMapBg.style.backgroundPosition = `50% 40%`; locMapBg.style.transition = 'background-position 1s cubic-bezier(0.25, 1, 0.5, 1)'; }
                
                if (focusTitle) focusTitle.textContent = '空闲中';
                if (focusProgress) focusProgress.style.width = '0%';
                if (focusDesc) focusDesc.textContent = '当前暂无进行中的行程安排 · 随时在线';
                    if (sTitle) sTitle.textContent = '当前作息状态';
                if (sStatus) sStatus.textContent = '自由安排 / 休息';
                if (sTimeEl) sTimeEl.textContent = '--:-- - --:--';

                // ▼▼▼ 新增：同步更新 Live Monitor 的状态信息 (空闲时) ▼▼▼
                const monitorMainStatus = document.querySelector('.ls-monitor-card .status-info .main-status');
                const monitorSubStatus = document.querySelector('.ls-monitor-card .status-info .sub-status');
                if (monitorMainStatus) monitorMainStatus.textContent = '自由安排 / 随心漫游中';
                if (monitorSubStatus) monitorSubStatus.textContent = '目前没有明确的行程目的地';
                // ▲▲▲ 新增结束 ▲▲▲
            }
             };
           // 启动一个定时器，每隔一分钟自动刷新一次进度条和状态！
        if (window.lsStatusTimer) clearInterval(window.lsStatusTimer); // 掐死旧的
        window.lsStatusTimer = setInterval(window.updateLsStatusCards, 60000); // 开启新的
         // ▼▼▼ 新增：渲染每个角色专属的监控记录列表的工具函数 ▼▼▼
        window.renderMonitorRecords = async (charId) => {
            const recordList = document.getElementById('ls-monitor-records-list');
            const recordCount = document.getElementById('ls-monitor-record-count');
            if (!recordList || !recordCount) return;
            try {
                const recordsKey = 'ls_monitor_records_' + charId;
                const dbRec = await db.appData.get(recordsKey);
                let records = dbRec ? dbRec.value : [];
                
                // 核心防卡顿：超过50条则隐式截断最老的数据
                if (records.length > 50) {
                    records = records.slice(0, 50);
                    await db.appData.put({ key: recordsKey, value: records });
                }
                recordCount.innerHTML = `共 ${records.length} 条 <span class="clear-all-monitors" data-char="${charId}" style="color:#E28F8F; cursor:pointer; margin-left:8px; font-weight:bold;">清空</span>`;
                if (records.length === 0) {
                    recordList.innerHTML = '<div style="text-align: center; font-size: 12px; color: #A3958F; padding: 20px 10px;">暂无监控档案</div>';
                    return;
                }
                
                // ▼▼▼ 修改：限制标题最大宽度变为单行省略，并美化突出右上角的删除按钮 ▼▼▼
                recordList.innerHTML = records.map((rec, idx) => `
                    <details style="background: #FFF; border: 1px solid #EBE4DD; border-radius: 12px; padding: 12px; transition: all 0.3s; margin-bottom: 5px; position: relative;">
                        <summary style="outline: none; cursor: pointer; list-style: none;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; padding-right: 26px;">
                                <span style="font-size: 11px; background: #F2EAE4; color: #8F7F74; padding: 4px 8px; border-radius: 6px; font-weight: bold; display: inline-block; max-width: 60%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle;">📍 ${rec.label || '未知行程'}</span>
                                <span style="font-size: 10px; color: #A3958F;">${rec.time}</span>
                            </div>
                            <div style="font-size: 12px; font-weight: normal; color: #8F7F74; line-height: 1.5; margin-top: 6px;">${rec.summary || rec.content} <span style="color: #D3A7A5; font-size: 10px; margin-left: 4px;">展开阅读 ›</span></div>
                        </summary>
                        <div style="margin-top: 12px; padding-top: 12px; border-top: 1px dashed #EBE4DD; font-size: 13px; color: #4A4440; line-height: 1.8;">
                            ${rec.fullText || rec.content}
                        </div>
                        <button class="delete-monitor-record-btn" data-idx="${idx}" data-char="${charId}" style="position: absolute; top: 12px; right: 12px; border: none; background: #FDE8E8; color: #D3A7A5; width: 22px; height: 22px; border-radius: 50%; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-weight: bold; padding: 0;">&times;</button>
                    </details>
                `).join('');
                // ▲▲▲ 修改结束 ▲▲▲
            } catch(e) { console.error('渲染监控记录失败', e); }
        };
        // 统一事件委托处理点击：无需重复绑定闭包
        const globalRecordArchives = document.querySelector('.ls-monitor-archives');
        if (globalRecordArchives && !globalRecordArchives.dataset.bound) {
            globalRecordArchives.dataset.bound = 'true';
           globalRecordArchives.addEventListener('click', async (e) => {
                // 单条删除
                const delBtn = e.target.closest('.delete-monitor-record-btn');
                if (delBtn) {
                    const charId = delBtn.dataset.char;
                    const idx = parseInt(delBtn.dataset.idx);
                    const key = 'ls_monitor_records_' + charId;
                    const dbRec = await db.appData.get(key);
                    let records = dbRec ? dbRec.value : [];
                    records.splice(idx, 1);
                    await db.appData.put({ key: key, value: records });
                    window.renderMonitorRecords(charId); // 刷新UI
                    return;
                }
                // 全部清空
                const clearBtn = e.target.closest('.clear-all-monitors');
                if (clearBtn) {
                    if (confirm('确定要清空当前角色的所有监控档案吗？')) {
                        const charId = clearBtn.dataset.char;
                        await db.appData.delete('ls_monitor_records_' + charId);
                        window.renderMonitorRecords(charId); // 刷新UI
                    }
                }
            });
        }
        // ▲▲▲ 新增结束 ▲▲▲
        // --- 核心修复：把读取数据打包成工具函数，实现按角色隔离与渲染 ---
        window.loadLsDataForChar = (charId, forceRender = false) => {
            if (!forceRender && !isLifeSyncPageVisible()) return;
            const loadToken = ++lifeSyncLoadToken;
            const shouldContinueLifeSyncLoad = () => forceRender || (isLifeSyncPageVisible() && loadToken === lifeSyncLoadToken);
            if (typeof window.renderMonitorRecords === 'function') {
                window.renderMonitorRecords(charId);
            }
            const selectedDateKey = getSelectedLifeSyncDateKey();
            Promise.all([getSleepRecordByWakeDate(charId, selectedDateKey), getSleepHistory(charId, 90)]).then(([record, fullHistory]) => {
                if (!shouldContinueLifeSyncLoad()) return;
                const health = record || {};
                const char = AppState.characterProfiles.find(item => String(item.id) === String(charId));
                const status = document.getElementById('ls-health-status');
                const durationLabel = document.getElementById('ls-health-duration-label');
                const hours = document.getElementById('ls-health-hours');
                const duration = document.getElementById('ls-health-duration');
                const quality = document.getElementById('ls-health-quality');
                const qualityRing = document.getElementById('ls-health-quality-ring');
                const fatigue = document.getElementById('ls-health-fatigue');
                const fatigueBar = document.getElementById('ls-health-fatigue-bar');
                const date = document.getElementById('ls-health-date');
                const trendLabel = document.getElementById('ls-health-trend-label');
                const trendChart = document.getElementById('ls-health-trend-chart');
                const historyBody = document.getElementById('ls-health-history-body');
                const projectionPhase = getSleepProjectionPhase(health);
                const projectionCompleted = projectionPhase.completed;
                const resolvedWindow = resolveSleepWindow(health);
                if (status) status.textContent = health.statusText || '该日期暂无睡眠记录';
                if (durationLabel) durationLabel.textContent = projectionCompleted ? '睡眠时长' : '预计睡眠';
                if (hours) hours.textContent = resolvedWindow ? `${getLocalDateKey(resolvedWindow.sleepAt).slice(5)} ${health.actualSleepTime} → ${getLocalDateKey(resolvedWindow.wakeAt).slice(5)} ${health.actualWakeTime}` : '--';
                const minutes = Number(health.sleepDurationMinutes);
                if (duration) duration.textContent = Number.isFinite(minutes) && minutes > 0 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : '--';
                const qualityValue = Math.max(0, Math.min(100, Number(health.sleepQuality) || 0));
                const fatigueValue = Math.max(0, Math.min(100, Number(health.fatigue) || 0));
                if (quality) quality.textContent = health.sleepQuality == null ? '--' : `${qualityValue}`;
                if (qualityRing) qualityRing.style.setProperty('--sleep-score', qualityValue);
                if (fatigue) fatigue.textContent = health.fatigue == null ? '--' : `${fatigueValue}%`;
                if (fatigueBar) fatigueBar.style.width = `${fatigueValue}%`;
                if (date) date.textContent = selectedDateKey;
                const history = fullHistory.filter(item => item?.wakeDate && item.wakeDate <= selectedDateKey).slice(-7);
                if (trendChart) trendChart.innerHTML = history.map(item => `<i style="height:${Math.max(3, Math.min(28, (Number(item.sleepQuality) || 0) * .28))}px" title="${escapeHTML(String(item.wakeDate || '--'))}: ${Math.max(0, Math.min(100, Number(item.sleepQuality) || 0))}"></i>`).join('');
                if (trendLabel) {
                    const first = Number(history[0]?.sleepQuality);
                    const last = Number(history[history.length - 1]?.sleepQuality);
                    trendLabel.textContent = history.length < 2 ? '数据积累中' : last > first + 5 ? '睡眠改善' : last < first - 5 ? '需要休息' : '整体平稳';
                }
                if (historyBody) {
                    const recentRows = history.slice(-5).reverse();
                    historyBody.innerHTML = recentRows.length ? recentRows.map(item => {
                        const rowMinutes = Number(item.sleepDurationMinutes) || 0;
                        const rowPhase = getSleepProjectionPhase(item);
                        const rowPrefix = rowPhase.completed ? '' : '预计 ';
                        const rowDuration = rowMinutes ? `${rowPrefix}${Math.floor(rowMinutes / 60)}h${rowMinutes % 60 ? ` ${rowMinutes % 60}m` : ''}` : '--';
                        const rowWindow = resolveSleepWindow(item);
                        const rowTime = rowWindow ? `${getLocalDateKey(rowWindow.sleepAt).slice(5)} ${item.actualSleepTime || '--'} → ${getLocalDateKey(rowWindow.wakeAt).slice(5)} ${item.actualWakeTime || '--'}` : '--';
                        return `<div class="health-history-row" role="row"><span>${escapeHTML(String(item.wakeDate?.slice(5) || '--'))}</span><span>${escapeHTML(`${rowPrefix}${rowTime}`)}</span><span>${escapeHTML(rowDuration)}</span><span>${Math.max(0, Math.min(100, Number(item.sleepQuality) || 0))}</span><span>${Math.max(0, Math.min(100, Number(item.fatigue) || 0))}</span></div>`;
                    }).join('') : '<div class="health-history-empty">暂无历史数据</div>';
                }
            }).catch(() => {});
            // ▼▼▼ 新增：每次切换角色时同步渲染监控档案 ▼▼▼
            // ▲▲▲ 新增结束 ▲▲▲

            // 新增：更新日历头部的头像，以及各处需要同步的大头像
            const calAvatar = document.getElementById('ls-cal-avatar');
            const mapAvatarImg = document.querySelector('#wrapper-content-map .pin-avatar img');
            const taAvatarImg = document.getElementById('ls-location-avatar');
                    if (AppState && AppState.characterProfiles) {
                const char = AppState.characterProfiles.find(c => c.id === charId);
                const charAvatar = (char && char.avatar) ? char.avatar : 'images/default-avatar.svg';
                if (calAvatar) calAvatar.src = charAvatar;
                if (mapAvatarImg) mapAvatarImg.src = charAvatar;
                if (taAvatarImg) taAvatarImg.src = charAvatar;
                updateSmallMonitorCam(charId);
            }
            // --- 新增：自动恢复当前角色绑定的城市并刷新天气 ---
            const savedCharCity = localStorage.getItem('ls_weather_char_city_' + charId);
            const savedMyCity = localStorage.getItem('ls_weather_my_city_' + charId); // 修改：我的城市也和角色完全绑定
            
            const charCityInput = document.getElementById('weather-char-city-input');
            const myCityInput = document.getElementById('weather-my-city-input');
            if (charCityInput) charCityInput.value = savedCharCity || '';
            if (myCityInput) myCityInput.value = savedMyCity || '';
                 // 修改：不用等接口返回，先把保存的城市名字写到页面上，防止刷新闪烁
            const charCityText = document.getElementById('weather-char-city-text');
            const myCityText = document.getElementById('weather-my-city-text');
            const charTempEl = document.getElementById('weather-char-temp');
            const myTempEl = document.getElementById('weather-my-temp');
            
            if (charCityText) charCityText.textContent = savedCharCity || 'TA 的城市';
            if (myCityText) myCityText.textContent = savedMyCity || '我的城市';
            // 新增：切换时先把温度重置为 '...'，给用户明确的刷新感知
            if (charTempEl) charTempEl.textContent = '...';
            if (myTempEl) myTempEl.textContent = '...';

            // 核心修复：移除 typeof 限制，强制触发天气拉取。如果没设置城市，传入空字符串触发虚拟天气
            fetchRealWeather(savedCharCity || '', 'weather-char-temp', 'weather-char-city-text').catch(() => {});
            fetchRealWeather(savedMyCity || '', 'weather-my-temp', 'weather-my-city-text').catch(() => {});
            // ----------------------------------------------------
            // A. 先恢复该角色专属的地图绑定状态
            const bindMapTrigger = document.getElementById('bind-map-trigger');
            const unbindMapBtn = document.getElementById('unbind-map-btn');
            const miniMapDotsContainer = document.getElementById('mini-map-dots-container');
            // ▼▼▼ 新增：同时拿到顶部大卡片的点阵容器，撕掉写死的红点 ▼▼▼
            const largeMapDotsContainer = document.querySelector('.ls-card.ls-location .added-location-dots');
            
            const boundPack = localStorage.getItem('ls_bound_map_' + charId); // 读取专属绑定记录
            
            if (miniMapDotsContainer) miniMapDotsContainer.innerHTML = '';
            if (largeMapDotsContainer) largeMapDotsContainer.innerHTML = ''; 
            
            if (boundPack && bindMapTrigger) {
                bindMapTrigger.textContent = `已绑定: ${boundPack}`;
                if (unbindMapBtn) unbindMapBtn.style.display = 'block';
                const packs = JSON.parse(localStorage.getItem('looky_map_packs') || '{}');
                const mapData = packs[boundPack] || [];
                
                // ▼▼▼ 核心修复：为当前角色的小地图和顶部大卡片同时种下坐标红点 ▼▼▼
                mapData.forEach(loc => {
                    if (loc.top && loc.left) {
                        if (miniMapDotsContainer) {
                            const dot1 = document.createElement('div');
                            dot1.className = 'loc-dot'; dot1.style.top = loc.top; dot1.style.left = loc.left;
                            miniMapDotsContainer.appendChild(dot1);
                        }
                        if (largeMapDotsContainer) {
                            const dot2 = document.createElement('div');
                            dot2.className = 'loc-dot'; dot2.style.top = loc.top; dot2.style.left = loc.left;
                            largeMapDotsContainer.appendChild(dot2);
                        }
                    }
                });
                // ▲▲▲ 修复结束 ▲▲▲
            } else if (bindMapTrigger) {
                bindMapTrigger.textContent = '未绑定地点信息 (点击绑定)';
                if (unbindMapBtn) unbindMapBtn.style.display = 'none';
            }
            // B. 必须先扫清屏幕上上一个角色的旧行程，防止叠图
            const timelineBox = document.querySelector('.ls-timeline');
            if (timelineBox) {
                timelineBox.querySelectorAll('.tl-row').forEach(row => row.remove());
            }
            document.querySelectorAll('#ls-cal-days-grid .cal-day.has-trip').forEach(day => day.classList.remove('has-trip'));
                  // C. 开始读取该角色的专属行程数据
            Promise.all([
                db.appData.get('ls_schedules_' + charId),
                db.appData.get('ls_schedules_data_' + charId)
            ]).then(([record, dataRecord]) => {
                if (!shouldContinueLifeSyncLoad()) return;
                const emptyState = document.getElementById('ls-empty-state');
                const storedData = Array.isArray(dataRecord?.value) ? dataRecord.value : [];
                
                if (record && record.value && record.value.length > 0) {
                    if (timelineBox) {
                        // 核心优化：把所有卡片拼接成一大块，一次性上墙，消除浏览器的重绘卡顿！
                        const selectedDateKey = getSelectedLifeSyncDateKey();
                        let combinedHTML = '';
                        record.value.forEach((item, index) => {
                            const wrapper = document.createElement('div');
                            wrapper.innerHTML = item?.rowHTML || '';
                            const row = wrapper.firstElementChild;
                            if (row && !row.dataset.scheduleDateIso && storedData[index]?.dateISO) row.dataset.scheduleDateIso = storedData[index].dateISO;
                            if (isTimelineRowOnDate(row, selectedDateKey)) combinedHTML += row?.outerHTML || '';
                        });
                        timelineBox.insertAdjacentHTML('beforeend', combinedHTML);
                        const timelineRows = Array.from(timelineBox.querySelectorAll('.tl-row'));
                        
                        // 让日历卡片上重新亮起小粉点
                        const calDays = document.querySelectorAll('#ls-cal-days-grid .cal-day');
                        calDays.forEach(dayEl => dayEl.classList.remove('has-trip'));
                        const scheduledDateKeys = new Set();
                        record.value.forEach((item, index) => {
                            const wrapper = document.createElement('div');
                            wrapper.innerHTML = item?.rowHTML || '';
                            const row = wrapper.firstElementChild;
                            const iso = row?.dataset?.scheduleDateIso || storedData[index]?.dateISO || '';
                            const day = row?.dataset?.scheduleDate || '';
                            if (iso) scheduledDateKeys.add(iso);
                            else if (isLegacyScheduleOnDateKey(day, getSelectedLifeSyncDateKey())) {
                                scheduledDateKeys.add(`${getLocalDateKey().slice(0, 8)}${String(Number(day)).padStart(2, '0')}`);
                            }
                        });
                        calDays.forEach(dayEl => {
                            if (scheduledDateKeys.has(dayEl.dataset.dateKey)) dayEl.classList.add('has-trip');
                        });
                        
                        // 核心修复：数据复原后，重新进行一次当天的筛选，并控制空状态提示的显示隐藏
                        let visibleCount = 0;
                        
                        const now = new Date();
                        const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
                        timelineRows.forEach(row => {
                            const rowDateKey = getTimelineRowDateKey(row, selectedDateKey);
                            if (!isTimelineRowOnDate(row, selectedDateKey)) {
                                row.style.display = 'none'; // 不是今天的数据，先隐藏
                            } else {
                                row.style.display = 'flex'; // 是今天的数据，显示出来
                                visibleCount++;
                                
                                // 给“素颜”复原的数据化上妆 (加动画或盖章)
                                const card = row.querySelector('.tl-card.dynamic-schedule');
                                if (card) {
                                    const sTime = card.dataset.startTime || '00:00';
                                    const eTime = card.dataset.endTime || '23:59';
                                    
                                    card.classList.remove('active-trip', 'past-trip');
                                    
                                    if (rowDateKey < getLocalDateKey() || (rowDateKey === getLocalDateKey() && eTime < currentTime)) {
                                        card.classList.add('past-trip');
                                    } else if (rowDateKey === getLocalDateKey() && sTime <= currentTime && eTime >= currentTime) {
                                        card.classList.add('active-trip');
                                    }
                                }
                            }
                        });
                        
                        if (emptyState) {
                            emptyState.style.display = visibleCount === 0 ? 'block' : 'none';
                        }
                    }
                } else {
                    // 【核心修复】如果没有数据，强制显示空状态，防止旧数据残留带来的卡顿错觉！
                    if (emptyState) emptyState.style.display = 'block';
                }
                
                // 无论有没有数据，都模拟点击一下当前顶部的状态栏，触发视图刷新
                const activeToggle = document.querySelector('.ls-trip-controls .view-toggles button.active');
                if (activeToggle) activeToggle.click();
                
                // ★ 新增：数据加载渲染完毕后，立刻同步顶部的专注与作息卡片状态（确保没数据的角色头顶显示空闲）
                if (typeof window.updateLsStatusCards === 'function') window.updateLsStatusCards(true);
                
            }).catch(e => console.error(e));
        }; // ★ 核心修复：关上 loadLsDataForChar 函数的大门 ★
        // ★ 核心修复：一进页面，先给默认角色拉取一次数据 ★
        loadCurrentLifeSyncCharIfVisible();
        // 绑定 Segmented Control 切换逻辑
        const segBtns = document.querySelectorAll('.ls-segment-control .ls-seg-btn');
        segBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                // 移除其他激活态
                segBtns.forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.ls-view').forEach(v => v.style.display = 'none');
                
                // 激活当前
                e.target.classList.add('active');
                const targetId = e.target.getAttribute('data-target');
                const view = document.getElementById(targetId);
                 if(view) {
                    // 如果是世界地图，赋予 flex 布局撑满
                    view.style.display = targetId === 'ls-view-world-map' ? 'flex' : 'block';
                    // 触发小动画
                    view.style.animation = 'none';
                    void view.offsetWidth; 
                    view.style.animation = 'fadeIn 0.3s ease';
                }
            });
        });

        // 新增：行程日历 "我/Ta/对比" 的点击丝滑切换逻辑
        const viewToggles = document.querySelectorAll('.ls-trip-controls .view-toggles button');
        const timeline = document.querySelector('.ls-timeline');
        if (viewToggles.length > 0 && timeline) {
            const setLsDisplay = (el, value) => {
                if (el && el.style.display !== value) el.style.display = value;
            };
            const applyTripRowsVisibility = (modeIndex) => {
                timeline.classList.toggle('dual-mode', modeIndex === 2);
                const selectedDateKey = getSelectedLifeSyncDateKey();
                let visibleCount = 0;

                timeline.querySelectorAll('.tl-row').forEach(row => {
                    const dateMatched = isTimelineRowOnDate(row, selectedDateKey);
                    const cards = row.querySelectorAll('.tl-card');
                    let hasVisibleCard = cards.length === 0;
                    row.classList.remove('joint-row');

                    cards.forEach(card => {
                        const isMine = card.classList.contains('mine');
                        const isTa = card.classList.contains('ta-trip');
                        const isJoint = card.classList.contains('joint-trip');
                        const shouldShow = modeIndex === 2 || isJoint || (modeIndex === 0 && isMine) || (modeIndex === 1 && isTa);
                        setLsDisplay(card, shouldShow ? 'flex' : 'none');
                        if (shouldShow) hasVisibleCard = true;
                        if (modeIndex === 2 && isJoint) row.classList.add('joint-row');
                    });

                    const rowVisible = dateMatched && hasVisibleCard;
                    setLsDisplay(row, rowVisible ? 'flex' : 'none');
                    if (rowVisible) visibleCount++;
                });

                const emptyState = document.getElementById('ls-empty-state');
                if (emptyState) emptyState.style.display = visibleCount === 0 ? 'block' : 'none';
            };
            viewToggles.forEach((btn, index) => {
                btn.addEventListener('click', () => {
                    // 1. 切换按钮自己的高亮颜色
                    viewToggles.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    
                    // 核心修复：控制日历旁边的头像只在点击“Ta”(即 index 为 1) 时显示
                    const calAvatar = document.getElementById('ls-cal-avatar');
                    if (calAvatar) {
                        calAvatar.style.display = (index === 1) ? 'inline-block' : 'none';
                    }
                    // 2. 一次性处理“我 / Ta / 共同”的卡片和行显示，减少 iPhone 上的反复样式重算
                    applyTripRowsVisibility(index);
                          if (index === 0) {

                        // 核心修改：只隐藏地图，强制显示日历
                        document.getElementById('wrapper-content-map').style.display = 'none';
                        document.getElementById('wrapper-content-date').style.display = 'flex';
                        document.getElementById('toggle-title-map').style.display = 'none';
                         document.getElementById('toggle-title-date').style.display = 'flex';
                        document.getElementById('top-pill-date-view').style.display = 'none';
                        document.getElementById('top-pill-map-view').style.display = 'flex';
                        const fabMain = document.getElementById('ls-fab-main');
                        if (fabMain) fabMain.style.display = ''; // 核心：清除none，恢复默认显示
                        const fabMenu = document.getElementById('ls-fab-menu');
                        if (fabMenu) {
                            fabMenu.innerHTML = `
                                <button class="fab-menu-item single-schedule-btn">单人日程</button>
                                <button class="fab-menu-item">清除当日</button>
                            `;
                        }
                    } else if (index === 1) {
                        // 核心修改：恢复显示地图，隐藏日历
                        document.getElementById('wrapper-content-map').style.display = 'block';
                        document.getElementById('wrapper-content-date').style.display = 'none';
                        document.getElementById('toggle-title-map').style.display = 'flex';
                        document.getElementById('toggle-title-date').style.display = 'none';
                        document.getElementById('top-pill-date-view').style.display = 'flex';
                        document.getElementById('top-pill-map-view').style.display = 'none';
                        
                        const fabMain = document.getElementById('ls-fab-main');
                        if (fabMain) fabMain.style.display = ''; // 核心：在这里也必须清除none，恢复默认显示！
                        const fabMenu = document.getElementById('ls-fab-menu');
                        if (fabMenu) {
                            fabMenu.innerHTML = `
                                <button class="fab-menu-item">单人行程</button>
                                <button class="fab-menu-item">双人行程</button>
                                <button class="fab-menu-item">ai辅助</button>
                                <button class="fab-menu-item">清除当日</button>
                            `;
                        }
                    } else if (index === 2) {
                        // 核心修改：恢复显示地图，隐藏日历
                        document.getElementById('wrapper-content-map').style.display = 'block';
                        document.getElementById('wrapper-content-date').style.display = 'none';
                        document.getElementById('toggle-title-map').style.display = 'flex';
                             document.getElementById('toggle-title-date').style.display = 'none';
                        document.getElementById('top-pill-date-view').style.display = 'flex';
                        document.getElementById('top-pill-map-view').style.display = 'none';
                     const fabMain = document.getElementById('ls-fab-main');
                     const fabMenu = document.getElementById('ls-fab-menu');
                     if (fabMain) {
                         fabMain.style.display = 'none'; // 核心：在这个页面彻底隐藏添加按钮
                         fabMain.classList.remove('active'); // 防止带着展开状态隐身
                         if (fabMenu) fabMenu.classList.remove('active');
                     }
                                         if (fabMenu) {
                            fabMenu.innerHTML = `
                                <button class="fab-menu-item">单人行程</button>
                                <button class="fab-menu-item">双人行程</button>
                                <button class="fab-menu-item">ai辅助</button>
                                <button class="fab-menu-item">清除当日</button>
                            `;
                        }
                    }
                });
            });
            // 初始化触发一次“我”视图的状态，确保一开始进去就不显示地图和显示正确的菜单
            viewToggles[0].click();
        }
        // 新增：天气与情绪卡片点击切换两地逻辑 (带底部小圆点联动)
        const weatherCard = document.getElementById('ls-weather-card');
        const weatherTa = document.getElementById('weather-view-ta');
               // ▼▼▼ 新增：天气预报按钮的点击与内容推算逻辑 ▼▼▼
        const forecastBtn = document.getElementById('weather-forecast-btn');
        const forecastModal = document.getElementById('weather-forecast-modal-overlay');
        const closeForecastBtn = document.getElementById('close-weather-forecast-btn');
        const confirmForecastBtn = document.getElementById('forecast-modal-confirm-btn');
        
        if (forecastBtn && forecastModal) {
            forecastBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // 阻止卡片翻转的事件冒泡
                const charId = window.tempState?.currentLifeSyncCharId || 'default_char';
                
                // ▼▼▼ 修复：让弹窗智能判断当前看的是“Ta”还是“我”，去拿对应的新抽屉数据 ▼▼▼
                const isMyView = document.getElementById('weather-view-me')?.style.display === 'flex';
                const dbKey = isMyView ? 'ls_current_weather_my_' + charId : 'ls_current_weather_char_' + charId;
                
                // 从安全的本地数据库里拿出我们刚才刷新好的天气数据
                db.appData.get(dbKey).then(weatherData => {
                    const contentEl = document.getElementById('weather-forecast-content');
                    if (weatherData && weatherData.value) {
                        const temp = parseInt(weatherData.value.temp);
                        const status = weatherData.value.status;
                        
                        // 智能推算全天温差 (白天热一点，晚上冷一点)
                        const high = temp + Math.floor(Math.random() * 3) + 2; 
                        const low = temp - Math.floor(Math.random() * 4) - 2;
                        
                        let advice = "气温适宜，祝你有美好的一天哦！";
                        if (status.includes('雨') || status.includes('雪') || status.includes('雷')) advice = "出行请注意安全，记得带好雨具。";
                        else if (high > 30) advice = "紫外线较强，请注意防晒和补水。";
                         else if (low < 5) advice = "早晚气温骤降，一定要穿厚点，别着凉啦。";

                        // 动态判断天气类型，分配背景和纯色SVG图标
                        let bgStyle = ""; let iconSvg = "";
                        if (status.includes('雨') || status.includes('雷')) {
                            bgStyle = "linear-gradient(135deg, #4b5d67 0%, #1e293b 100%)"; // 阴雨天暗蓝灰
                            iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 22px; height: 22px; opacity: 0.9;"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.36 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"></path><path d="M12 22v-4"></path><path d="M8 22v-2"></path><path d="M16 22v-2"></path></svg>';
                        } else if (status.includes('雪')) {
                            bgStyle = "linear-gradient(135deg, #8ba8bc 0%, #cbd5e1 100%)"; // 雪天清冷灰
                            iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 22px; height: 22px; opacity: 0.9;"><line x1="12" y1="2" x2="12" y2="22"></line><line x1="3.34" y1="7" x2="20.66" y2="17"></line><line x1="3.34" y1="17" x2="20.66" y2="7"></line></svg>';
                        } else if (status.includes('云') || status.includes('阴')) {
                            bgStyle = "linear-gradient(135deg, #6b7b8c 0%, #3a4a5a 100%)"; // 多云灰蓝
                            iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 22px; height: 22px; opacity: 0.9;"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg>';
                        } else {
                            bgStyle = "linear-gradient(135deg, #6aaae4 0%, #2f80ed 100%)"; // 晴天通透蓝
                            iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 22px; height: 22px; opacity: 0.9;"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="M4.93 4.93l1.41 1.41"></path><path d="M17.66 17.66l1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="M4.93 19.07l1.41-1.41"></path><path d="M17.66 6.34l1.41-1.41"></path></svg>';
                        }
                        
                        // 动态改变整个弹窗卡片的背景色和文字颜色
                        const modalCard = forecastModal.querySelector('.modal-card');
                        if (modalCard) {
                            modalCard.style.background = bgStyle;
                            modalCard.style.color = "#FFFFFF";
                        }

                        contentEl.innerHTML = `
                            <div style="font-size: 72px; font-weight: 300; font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 10px 0 0; line-height: 1; text-align: left; display: flex; align-items: flex-start; text-shadow: 0 4px 15px rgba(0,0,0,0.1);">
                                ${temp}<span style="font-size: 24px; margin-top: 10px; opacity: 0.8;">°</span>
                            </div>
                            <div style="font-size: 15px; margin-bottom: 25px; display: flex; align-items: center; gap: 8px; justify-content: flex-start; text-shadow: 0 2px 5px rgba(0,0,0,0.1);">
                                ${iconSvg} <span>${status}</span>
                                <span style="opacity: 0.75; margin-left: 4px; font-size: 13px;">最高${high}° 最低${low}°</span>
                            </div>
                            <div style="font-size: 13px; line-height: 1.6; background: rgba(255,255,255,0.15); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); padding: 14px; border-radius: 12px; text-align: left; border: 1px solid rgba(255,255,255,0.2);">
                                ${advice}
                            </div>
                        `;
                    } else {
                        contentEl.innerHTML = '<div style="font-size: 14px; color: #A3958F; padding: 20px;">暂时没有获取到天气信息哦，请稍后再试。</div>';
                    }
                    forecastModal.style.display = 'flex';
                    setTimeout(() => forecastModal.style.opacity = '1', 10);
                });
            });
        }
        
        const closeForecastModal = () => {
            forecastModal.style.opacity = '0';
            setTimeout(() => forecastModal.style.display = 'none', 300);
        };
        if (closeForecastBtn) closeForecastBtn.addEventListener('click', closeForecastModal);
        if (confirmForecastBtn) confirmForecastBtn.addEventListener('click', closeForecastModal);
        // ▲▲▲ 新增结束 ▲▲▲
        const weatherMe = document.getElementById('weather-view-me');
        const dotTa = document.getElementById('weather-dot-ta');
        const dotMe = document.getElementById('weather-dot-me');
        if (weatherCard && weatherTa && weatherMe) {
            weatherCard.addEventListener('click', (e) => {
                // 判断点击的是否是情绪图标的圆圈，如果不是，则弹窗让你设置城市
                if (!e.target.closest('.mood-icon')) {
                    const weatherModal = document.getElementById('weather-city-modal-overlay');
                    if (weatherModal) {
                        // 核心修复：打开弹窗时，实时去数据库提取当前这个角色的专属城市，填入输入框
                        const charId = window.tempState?.currentLifeSyncCharId || 'default_char';
                        const charCityInput = document.getElementById('weather-char-city-input');
                        const myCityInput = document.getElementById('weather-my-city-input');
                        if (charCityInput) charCityInput.value = localStorage.getItem('ls_weather_char_city_' + charId) || '';
                        if (myCityInput) myCityInput.value = localStorage.getItem('ls_weather_my_city_' + charId) || '';
                        
                        // --- 新增：回显虚拟天气配置 ---
                        const isVirtual = localStorage.getItem('ls_weather_virtual_toggle_' + charId) === 'true';
                        const vToggle = document.getElementById('weather-virtual-toggle');
                        const vOptions = document.getElementById('weather-virtual-options');
                        const vTemp = document.getElementById('weather-virtual-temp');
                        const vRain = document.getElementById('weather-virtual-rain');
                        
                        if (vToggle) {
                            vToggle.checked = isVirtual;
                            if (vOptions) vOptions.style.display = isVirtual ? 'flex' : 'none';
                            vToggle.onchange = (e) => { if(vOptions) vOptions.style.display = e.target.checked ? 'flex' : 'none'; };
                        }
                        if (vTemp) vTemp.value = localStorage.getItem('ls_weather_virtual_temp_' + charId) || 'warm';
                        if (vRain) vRain.value = localStorage.getItem('ls_weather_virtual_rain_' + charId) || 'normal';
                        // -----------------------------

                        weatherModal.style.display = 'flex';
                        setTimeout(() => weatherModal.style.opacity = '1', 10);
                    }
                    return;
                }
                if (weatherTa.style.display !== 'none') {
                    // 隐藏Ta，显示我
                    weatherTa.style.display = 'none';
                    weatherMe.style.display = 'flex';
                    if (dotTa && dotMe) {
                        dotTa.style.backgroundColor = '#EBE4DD'; // 变浅
                        dotMe.style.backgroundColor = '#5C544D'; // 变深（激活态）
                    }
                } else {
                    // 隐藏我，显示Ta
                    weatherMe.style.display = 'none';
                    weatherTa.style.display = 'flex';
                    if (dotTa && dotMe) {
                        dotTa.style.backgroundColor = '#5C544D'; // 变深（激活态）
                        dotMe.style.backgroundColor = '#EBE4DD'; // 变浅
                    }
                }
            });
        }

        // 新增：地图折叠逻辑
        const mapToggle = document.getElementById('ls-map-toggle');
        const mapWrapper = document.getElementById('ls-map-wrapper');
        if (mapToggle && mapWrapper) {
            let isMapCollapseSwitching = false;
            mapToggle.addEventListener('click', () => {
                if (isMapCollapseSwitching) return;
                isMapCollapseSwitching = true;
                const shouldCollapse = !mapWrapper.classList.contains('collapsed');
                mapToggle.style.transition = 'none';
                mapWrapper.style.transition = 'none';
                if (!shouldCollapse) mapWrapper.style.display = '';
                requestAnimationFrame(() => {
                    mapToggle.classList.toggle('collapsed', shouldCollapse);
                    mapWrapper.classList.toggle('collapsed', shouldCollapse);
                    if (shouldCollapse) mapWrapper.style.display = 'none';
                    requestAnimationFrame(() => {
                        mapToggle.style.transition = '';
                        mapWrapper.style.transition = '';
                        setTimeout(() => { isMapCollapseSwitching = false; }, 80);
                    });
                });
            });
        }
        // ▼▼▼ 新增：行程面板 顶部胶囊与辅助面板 视图切换逻辑 ▼▼▼
        const lsTopPillBtn = document.getElementById('ls-top-pill-btn');
        const topPillDateView = document.getElementById('top-pill-date-view');
        const topPillMapView = document.getElementById('top-pill-map-view');
        
        const toggleTitleMap = document.getElementById('toggle-title-map');
        const toggleTitleDate = document.getElementById('toggle-title-date');
         const wrapperContentMap = document.getElementById('wrapper-content-map');
        const wrapperContentDate = document.getElementById('wrapper-content-date');
        let isLsPillSwitching = false; // [新增] 防抖变量，防止暴击导致的卡顿
        if (lsTopPillBtn) {
            lsTopPillBtn.addEventListener('click', (e) => {
                if (isLsPillSwitching) return; // [新增] 拦截未完成一帧时的重复点击
                
                // 如果点的是日期两边的按钮，阻止事件冒泡，以免误触
                if (e.target.closest('button')) {
                    e.stopPropagation();
                    return;
                }
                
                // 新增：如果当前是在“我”对应的页面，则禁止点击切换到地图，直接罢工
                const activeToggle = document.querySelector('.ls-trip-controls .view-toggles button.active');
                if (activeToggle && activeToggle.textContent.trim() === '我') {
                    return;
                }
                
                isLsPillSwitching = true; // [新增] 锁定状态
                const isMapMode = topPillMapView.style.display !== 'none';
                
                // ▼▼▼ 核心优化：使用 requestAnimationFrame 将所有 DOM 修改打包为一帧执行，消除撕裂与卡顿 ▼▼▼
                requestAnimationFrame(() => {
                    if (isMapMode) {
                        // 当前是状态B，切换回状态A (顶部显示日期，面板显示地图)
                        topPillMapView.style.display = 'none';
                        topPillDateView.style.display = 'flex';
                        
                        toggleTitleDate.style.display = 'none';
                        toggleTitleMap.style.display = 'flex';
                        
                        wrapperContentDate.style.display = 'none';
                        wrapperContentMap.style.display = 'block';
                    } else {
                        // 当前是状态A，切换到状态B (顶部显示地图胶囊，面板显示日历)
                        topPillDateView.style.display = 'none';
                        topPillMapView.style.display = 'flex';
                        
                        toggleTitleMap.style.display = 'none';
                        toggleTitleDate.style.display = 'flex';
                        
                        wrapperContentMap.style.display = 'none';
                        wrapperContentDate.style.display = 'flex'; 
                    }
                    setTimeout(() => { isLsPillSwitching = false; }, 150); // [新增] 短暂延迟后解锁
                });
                // ▲▲▲ 优化结束 ▲▲▲
            });
        }
        // ▲▲▲ 视图切换逻辑结束 ▲▲▲
        // ▼▼▼ 新增：行程日历生成与点击逻辑 ▼▼▼
        const lsCalGrid = document.getElementById('ls-cal-days-grid');
        const lsCalMonthTitle = document.getElementById('ls-cal-month-title');
        const lsCalPrev = document.getElementById('ls-cal-prev');
        const lsCalNext = document.getElementById('ls-cal-next');

        if (lsCalGrid && lsCalMonthTitle) {
            let currentDate = new Date(); // 记录当前展示的年月
            window.tempState.currentLifeSyncDateKey = getSelectedLifeSyncDateKey();
            
            // 提取为一个渲染函数，方便切换月份时重新调用
            function renderCalendar() {
                lsCalGrid.innerHTML = '';
                const year = currentDate.getFullYear();
                const month = currentDate.getMonth(); // 0-11
                
                // 1. 更新顶部标题
                lsCalMonthTitle.textContent = `${year}年 ${month + 1}月`;
                
                // 2. 获取当月第一天是星期几 (0:周日, 1:周一...) 和当月总天数
                const firstDay = new Date(year, month, 1).getDay();
                const daysInMonth = new Date(year, month + 1, 0).getDate();
                
                // 3. 填充前置空白占位符
                for(let i = 0; i < firstDay; i++) {
                    lsCalGrid.innerHTML += `<div class="cal-day empty"></div>`;
                }
                
                // 4. 填充真实的日期。每个日期都保存完整年月日，不能只保存“几号”。
                const selectedDateKey = getSelectedLifeSyncDateKey();
                for(let i = 1; i <= daysInMonth; i++) {
                    const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
                    const isActive = dateKey === selectedDateKey ? 'active' : '';
                    
                    lsCalGrid.innerHTML += `<div class="cal-day ${isActive}" data-date-key="${dateKey}">${i}</div>`;
                }
            }

            // 初始化渲染当月
            renderCalendar();

            const moveCalendarMonth = (offset) => {
                const selectedDay = Number(getSelectedLifeSyncDateKey().slice(8, 10)) || currentDate.getDate();
                currentDate.setDate(1);
                currentDate.setMonth(currentDate.getMonth() + offset);
                const daysInTargetMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
                currentDate.setDate(Math.min(selectedDay, daysInTargetMonth));
                window.tempState.currentLifeSyncDateKey = getLocalDateKey(currentDate);
                renderCalendar();
                if (window.tempState?.currentLifeSyncCharId) window.loadLsDataForChar?.(window.tempState.currentLifeSyncCharId);
            };

            // 绑定上个月按钮
            if (lsCalPrev) {
                lsCalPrev.addEventListener('click', (e) => {
                    e.stopPropagation(); // 防止冒泡触发别的折叠事件
                    moveCalendarMonth(-1);
                });
            }
            // 绑定下个月按钮
            if (lsCalNext) {
                lsCalNext.addEventListener('click', (e) => {
                    e.stopPropagation(); // 防止冒泡触发别的折叠事件
                    moveCalendarMonth(1);
                });
            }

           // 绑定日历点击事件：实现排他性高亮
            let isCalDaySwitching = false; // [新增] 防抖锁，防止爆手速狂点卡死
            lsCalGrid.addEventListener('click', (e) => {
                if (isCalDaySwitching) return; // 没换完前不许点下一天
                
                if (e.target.classList.contains('cal-day') && !e.target.classList.contains('empty')) {
                    isCalDaySwitching = true; // 上锁
                    
                    // 移除所有的 active
                    lsCalGrid.querySelectorAll('.cal-day').forEach(el => el.classList.remove('active'));
                    // 给当前点击的日期加上 active
                    e.target.classList.add('active');
                    const selectedDateKey = e.target.dataset.dateKey || getSelectedLifeSyncDateKey();
                    window.tempState.currentLifeSyncDateKey = selectedDateKey;
                    if (typeof window.loadLsDataForChar === 'function' && window.tempState?.currentLifeSyncCharId) {
                        window.loadLsDataForChar(window.tempState.currentLifeSyncCharId);
                        setTimeout(() => { isCalDaySwitching = false; }, 120);
                        return;
                    }
                     // 新增：根据选中的日期筛选时间轴行程
                             const allRows = document.querySelectorAll('.ls-timeline .tl-row');
                    
                    // --- 补充：获取当前真实系统时间，给将要展示的卡片当做判断标准 ---
                    const now = new Date();
                    const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
                    const todayNum = now.getDate();
                    
                    // ▼▼▼ 核心优化：用动画帧将几十张卡片的计算一次性打包，告别卡顿 ▼▼▼
                    requestAnimationFrame(() => {
                        let visibleCount = 0; // 用于计算当天显示了多少行程
                        
                        allRows.forEach(row => {
                            // 如果有日期标记且和今天不匹配，就隐藏它；匹配或者原生保留的假数据则显示
                            if (!isTimelineRowOnDate(row, selectedDateKey)) {
                                row.style.display = 'none';
                            } else {
                                // 核心修复：检查当前行内有没有尚未被“我/Ta”视图过滤器隐藏的卡片
                                let hasVisibleCard = false;
                                row.querySelectorAll('.tl-card').forEach(card => {
                                    if (card.style.display !== 'none') hasVisibleCard = true;
                                    
                                    // === 核心补漏：被点击的那一天的卡片走上台时，立刻补妆（盖章/动画） ===
                                    const sTime = card.dataset.startTime || '00:00';
                                    const eTime = card.dataset.endTime || '23:59';
                                    
                                    // 先卸掉旧妆容，保证干净
                                    card.classList.remove('active-trip', 'past-trip');
                                    
                                    // 对比时间，如果日期已经过了，或者日期是今天但时间过了，就变灰盖章
                                    const rowDateKey = getTimelineRowDateKey(row, selectedDateKey);
                                    if (rowDateKey < getLocalDateKey() || (rowDateKey === getLocalDateKey() && eTime < currentTime)) {
                                        card.classList.add('past-trip');
                                    } else if (rowDateKey === getLocalDateKey() && sTime <= currentTime && eTime >= currentTime) {
                                        card.classList.add('active-trip'); // 当前正在进行中
                                    }
                                    // =======================================================
                                });
                                // 如果有可见卡片，或者这行压根没装卡片，就显示出来并计数
                                if (hasVisibleCard || row.querySelectorAll('.tl-card').length === 0) {
                                    row.style.display = 'flex';
                                    visibleCount++;
                                } else {
                                    row.style.display = 'none'; // 卡片全藏起来了，就把这行干掉
                                }
                            }
                        });
                        
                        // 控制空状态的显示
                        const emptyState = document.getElementById('ls-empty-state');
                        if (emptyState) {
                            emptyState.style.display = visibleCount === 0 ? 'block' : 'none';
                        }
                        
                        // 稍微给浏览器喘息时间，解锁允许下次点击
                        setTimeout(() => { isCalDaySwitching = false; }, 100); 
                    });
                    // ▲▲▲ 优化结束 ▲▲▲
                }
            });
        }
        // ▲▲▲ 日历逻辑结束 ▲▲▲

        // ================= 世界地图功能逻辑 =================

        // 新增：右下角悬浮添加按钮 (FAB) 逻辑
        const fabMain = document.getElementById('ls-fab-main');
        const fabMenu = document.getElementById('ls-fab-menu');
        if (fabMain && fabMenu) {
            fabMain.addEventListener('click', () => {
                fabMain.classList.toggle('active');
                fabMenu.classList.toggle('active');
            });
            // 点击空白处关闭悬浮菜单
            document.addEventListener('click', (e) => {
                if (!e.target.closest('.ls-fab-container')) {
                    fabMain.classList.remove('active');
                    fabMenu.classList.remove('active');
                }
                });
        }

        // ================= 世界地图功能逻辑 =================
         // ▼▼▼ 行程面板：绑定地图预设逻辑 ▼▼▼
        const bindMapTrigger = document.getElementById('bind-map-trigger');
        const bindMapModal = document.getElementById('bind-map-modal-overlay');
        const closeBindMapBtn = document.getElementById('close-bind-map-modal-btn');
        const bindMapListContainer = document.getElementById('bind-map-list-container');
        const unbindMapBtn = document.getElementById('unbind-map-btn');
        const miniMapDotsContainer = document.getElementById('mini-map-dots-container'); // 【新增这一行】

        if (bindMapTrigger && bindMapModal) {

            bindMapTrigger.addEventListener('click', () => {
                const packs = JSON.parse(localStorage.getItem('looky_map_packs') || '{}');
                bindMapListContainer.innerHTML = '';
                const packNames = Object.keys(packs);
                
                if (packNames.length === 0) {
                    bindMapListContainer.innerHTML = '<div style="text-align:center; color:#A3958F; font-size:13px; padding: 20px;">暂无预设，请先在世界地图创建并保存预设。</div>';
                } else {
                    packNames.forEach(packName => {
                        const item = document.createElement('div');
                        item.className = 'map-pack-item';
                        item.innerHTML = `<span class="pack-name">${packName}</span>
                                          <button class="pack-btn btn-apply" style="padding: 4px 12px;">绑定</button>`;
                                          item.querySelector('.btn-apply').addEventListener('click', () => {
                            bindMapTrigger.textContent = `已绑定: ${packName}`;
                            unbindMapBtn.style.display = 'block';
                            
                            // ★ 新增：将绑定关系持久化到当前角色名下 ★
                            localStorage.setItem('ls_bound_map_' + window.tempState.currentLifeSyncCharId, packName);
                            
                            // 【新增】同步地图数据：提取对应预设包里面的坐标，生成小红点
                            if (miniMapDotsContainer) {
                                miniMapDotsContainer.innerHTML = '';
                                const mapData = packs[packName] || [];
                                mapData.forEach(loc => {
                                    if (loc.top && loc.left) {
                                        const dot = document.createElement('div');
                                        dot.className = 'loc-dot';
                                        dot.style.top = loc.top;
                                        dot.style.left = loc.left;
                                        miniMapDotsContainer.appendChild(dot);
                                    }
                                });
                            }

                            bindMapModal.style.opacity = '0';
                            setTimeout(() => bindMapModal.style.display = 'none', 300);
                        });
                        bindMapListContainer.appendChild(item);
                    });
                }
                
                bindMapModal.style.display = 'flex';
                setTimeout(() => bindMapModal.style.opacity = '1', 10);
            });
        }

        if (closeBindMapBtn && bindMapModal) {
            closeBindMapBtn.addEventListener('click', () => {
                bindMapModal.style.opacity = '0';
                setTimeout(() => bindMapModal.style.display = 'none', 300);
            });
        }
        if (unbindMapBtn) {
            unbindMapBtn.addEventListener('click', () => {
                bindMapTrigger.textContent = '未绑定地点信息 (点击绑定)';
                unbindMapBtn.style.display = 'none';
                
                // ★ 新增：解绑时清除该角色的绑定记录 ★
                localStorage.removeItem('ls_bound_map_' + window.tempState.currentLifeSyncCharId);
                
                // 【新增】解绑时清空小地图上的点
                if (miniMapDotsContainer) {
                    miniMapDotsContainer.innerHTML = '';
                }

                bindMapModal.style.opacity = '0';
                setTimeout(() => bindMapModal.style.display = 'none', 300);
            });
        }

        if (unbindMapBtn) {
            unbindMapBtn.addEventListener('click', () => {
                bindMapTrigger.textContent = '未绑定地点信息 (点击绑定)';
                unbindMapBtn.style.display = 'none';
                bindMapModal.style.opacity = '0';
                setTimeout(() => bindMapModal.style.display = 'none', 300);
            });
        }
        // ▲▲▲ 绑定地图预设逻辑结束 ▲▲▲

        const addWorldLocBtn = document.getElementById('add-world-location-btn');
        const saveMapPackBtn = document.getElementById('save-map-pack-btn');
        const mapModal = document.getElementById('world-map-input-modal');

        const mapModalTitle = document.getElementById('world-map-modal-title');
          const mapModalInput = document.getElementById('world-map-modal-input');
            const mapModalConfirm = document.getElementById('world-map-modal-confirm');
        
        // 新增：更新所属区域下拉框的公共函数
        function updateParentOptions(excludeName, currentParent) {
            const parentSelect = document.getElementById('world-map-modal-parent');
            if (!parentSelect) return;
            parentSelect.innerHTML = '<option value="">所属区域: 无</option>';
            currentLocations.forEach(loc => {
                if (parseInt(loc.radius) > 0 && loc.name !== excludeName) { // 只有设置了半径的才算区域，且不能选自己
                    const opt = document.createElement('option');
                    opt.value = loc.name;
                    opt.textContent = `所属区域: ${loc.name}`;
                    if (loc.name === currentParent) opt.selected = true;
                    parentSelect.appendChild(opt);
                }
            });
            parentSelect.dispatchEvent(new Event('change')); // 触发联动
        }
           // 新增：下拉框联动监听，选中区域后禁用下面三个选项并继承数据
        const parentSelectEl = document.getElementById('world-map-modal-parent');
        if (parentSelectEl) {
            parentSelectEl.addEventListener('change', (e) => {
                const isInherit = e.target.value !== '';
                // 核心修改：把距离选项 'world-map-modal-dist' 也加入置灰套餐
                ['world-map-modal-scale', 'world-map-modal-traffic', 'world-map-modal-crowd', 'world-map-modal-dist'].forEach(id => {
                    const el = document.getElementById(id);
                    if(el) {
                        el.disabled = isInherit; // 有区域时禁止修改
                        if(isInherit) {
                            const pObj = currentLocations.find(l => l.name === e.target.value);
                            if(pObj) {
                                if (id.includes('scale')) el.value = pObj.scale || '中型';
                                if (id.includes('traffic')) el.value = pObj.traffic || '便利';
                                if (id.includes('crowd')) el.value = pObj.crowd || '适中';
                            }
                        }
                    }
                });
            });
        }
        // 核心新增：通过JS向弹窗内部注入一个“删除”按钮，不破坏HTML结构
        const deleteLocBtn = document.createElement('button');
        deleteLocBtn.textContent = '删除此地点';
        deleteLocBtn.className = 'map-confirm-btn'; 
        deleteLocBtn.style.cssText = 'background-color: #E28F8F; margin-top: 10px; display: none;'; // E28F8F是柔和的红色
        if(mapModalConfirm && mapModalConfirm.parentNode) {
            mapModalConfirm.parentNode.appendChild(deleteLocBtn);
            deleteLocBtn.addEventListener('click', () => {
                const editIdx = document.getElementById('world-map-modal-index').value;
                currentLocations.splice(editIdx, 1); // 把这个地点从后台数据中剔除
                dotsContainer.querySelectorAll('.dynamic-map-dot').forEach(e => e.remove()); // 清空屏幕
                currentLocations.forEach((loc, idx) => renderMapDot(loc, idx)); // 把剩下的地点重新画上去
                mapModal.style.opacity = '0';
                setTimeout(() => mapModal.style.display = 'none', 300); // 关掉弹窗
            });
        }
       const mapModalClose = document.getElementById('close-world-map-modal');
        const dotsContainer = document.getElementById('world-map-dots-container');
        const btnOpenMapPackModal = document.getElementById('btn-open-map-pack-modal');
        const currentMapPackNameDisplay = document.getElementById('current-map-pack-name');
        const mapPackModal = document.getElementById('map-pack-modal-overlay');
        const closeMapPackModalBtn = document.getElementById('close-map-pack-modal-btn');
        const mapPackListContainer = document.getElementById('map-pack-list-container');
       let currentMapAction = ''; 
        let currentLocations = [];
        let currentActivePack = ''; // 记录当前激活的包名
        
        // 新增：地图菜单与 AI 生成逻辑绑定
        const fabAiBlueprint = document.getElementById('fab-ai-blueprint');
        const mapFabMenu = document.getElementById('ls-map-fab-menu');
        const btnMapClearAll = document.getElementById('btn-map-clear-all');
        const btnMapAiGen = document.getElementById('btn-map-ai-gen');
        const aiBlueprintModal = document.getElementById('ai-blueprint-modal-overlay');
        const btnCloseAiBlueprint = document.getElementById('close-ai-blueprint-btn');
        const btnAiGenMap = document.getElementById('btn-ai-generate-map');
        
        if (fabAiBlueprint && mapFabMenu) {
            fabAiBlueprint.addEventListener('click', () => {
                fabAiBlueprint.classList.toggle('active');
                mapFabMenu.classList.toggle('active');
            });
            // 点击外部关闭悬浮菜单
            document.addEventListener('click', (e) => {
                if (!e.target.closest('.ls-map-fab-container')) {
                    fabAiBlueprint.classList.remove('active');
                    mapFabMenu.classList.remove('active');
                }
            });
        }
     if (btnMapClearAll) {
            btnMapClearAll.addEventListener('click', () => {
                if(confirm('确定要清空当前画布上的所有地点吗？（不会删除已保存的预设）')) {
                    currentLocations = [];
                    // 只删除动态添加的节点，保留市中心等地标
                    dotsContainer.querySelectorAll('.dynamic-map-dot').forEach(e => e.remove());
                    // 核心修改：不要覆盖本地数据，而是退出当前的激活状态，方便建新图
                    currentActivePack = '';
                    if (currentMapPackNameDisplay) currentMapPackNameDisplay.textContent = '选择地图预设...';
                    if (saveMapPackBtn) saveMapPackBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2 2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg> 保存预设`;
                    
                    fabAiBlueprint.classList.remove('active');
                    mapFabMenu.classList.remove('active');
                }
            });
        }
        if (btnMapAiGen && aiBlueprintModal) {
            btnMapAiGen.addEventListener('click', () => {
                // ▼▼▼ 动态填充参考角色与用户选择框 ▼▼▼
                const charSelect = document.getElementById('ai-map-char-select');
                const userSelect = document.getElementById('ai-map-user-select');
                
                if (charSelect && AppState) {
                    charSelect.innerHTML = '<option value="all">综合分析</option>';
                    if (AppState.characterProfiles) {
                        AppState.characterProfiles.filter(c => !c.isGroup).forEach(char => {
                            const opt = document.createElement('option');
                            opt.value = 'char_' + char.id;
                            opt.textContent = getLifeSyncCharacterDisplayName(char);
                            charSelect.appendChild(opt);
                        });
                    }
                }
                
                if (userSelect && AppState && AppState.userIdentities) {
                    userSelect.innerHTML = '';
                    AppState.userIdentities.forEach(user => {
                        const opt = document.createElement('option');
                        opt.value = 'user_' + user.id;
                        opt.textContent = user.name;
                        userSelect.appendChild(opt);
                    });
                }

                // 绑定面板展开/收起事件
                const userToggle = document.getElementById('ai-map-user-toggle');
                const userOptionsPanel = document.getElementById('ai-map-user-options');
                if (userToggle && userOptionsPanel) {
                    userToggle.checked = false;
                    userOptionsPanel.style.display = 'none';
                    userToggle.onchange = (e) => {
                        userOptionsPanel.style.display = e.target.checked ? 'flex' : 'none';
                    };
                }
                // ▲▲▲ 动态填充结束 ▲▲▲
                aiBlueprintModal.style.display = 'flex';
                setTimeout(() => aiBlueprintModal.style.opacity = '1', 10);
                fabAiBlueprint.classList.remove('active');
                mapFabMenu.classList.remove('active');
            });
        }
        if (btnCloseAiBlueprint && aiBlueprintModal) {
            btnCloseAiBlueprint.addEventListener('click', () => {
                aiBlueprintModal.style.opacity = '0';
                setTimeout(() => aiBlueprintModal.style.display = 'none', 300);
            });
        }
       if (btnAiGenMap) {
            btnAiGenMap.addEventListener('click', async () => {
                const userPrompt = document.getElementById('ai-map-prompt-input').value;
                const charSelectVal = document.getElementById('ai-map-char-select').value;
                
                // 获取 User 开关和选项的值
                const isUserEnabled = document.getElementById('ai-map-user-toggle')?.checked;
                const userSelectVal = document.getElementById('ai-map-user-select')?.value;
                const isCohabit = document.getElementById('ai-map-cohabit-toggle')?.checked;
                const userLocCount = document.getElementById('ai-map-user-loc-count')?.value || 2;
                
                // 去除强制填写的弹窗拦截，允许全靠人设自由推演
                btnAiGenMap.textContent = "正在推演中...";
                btnAiGenMap.disabled = true;
                try {
                   const { url, key, model, temperature } = AppState.apiCurrentSettings;
                    if (!url || !key) {
                        throw new Error("请先在设置中配置 API 地址和密钥。");
                    }
                    
                    // 1. 动态构建严谨的 Database 上下文
                    let databaseContext = "";
                    let targetIdentity = "char"; // 默认围绕角色
                    
                    if (charSelectVal === 'all') {
                        targetIdentity = "shared";
                        databaseContext = `<Character_Profile>\n综合分析模式，请自由发挥\n</Character_Profile>\n`;
                    } else if (charSelectVal.startsWith('char_')) {
                        targetIdentity = "char";
                        const cid = charSelectVal.substring(5);
                        const char = AppState.characterProfiles.find(c => String(c.id) === cid);
                        if (char) {
                            databaseContext = `<Character_Profile>\n姓名: ${getLifeSyncCharacterDisplayName(char)}\n设定: ${char.persona}\n</Character_Profile>\n`;
                            try {
                                const { getWorldBookForPrompt } = await import('../state.js');
                                const wbContext = await getWorldBookForPrompt(cid);
                                if (wbContext && wbContext !== '无') {
                                    databaseContext += `<World_Book_Context>\n${wbContext}\n</World_Book_Context>\n`;
                                }
                            } catch (err) {
                                console.warn('获取世界书失败', err);
                            }
                        }
                    }

                    // 2. 如果开启了生成 User 地点，则把 User 设定也给 AI 看，并生成硬性约束
                    let userInstruction = "";
                    if (isUserEnabled && userSelectVal && userSelectVal.startsWith('user_')) {
                        const uid = userSelectVal.substring(5);
                        const u = AppState.userIdentities.find(c => String(c.id) === uid);
                        if (u) {
                            databaseContext += `<User_Profile>\n姓名: ${u.name}\n设定: ${u.persona}\n</User_Profile>\n`;
                            userInstruction = `\n\n【用户专属补充约束】\n当前世界观中，用户（${u.name}）与角色 ${isCohabit ? "【已经同居】" : "【并未同居】"}。\n除了角色的地点外，请务必额外生成 ${userLocCount} 个主要属于用户（target为 "user" 或 "shared"）的具体地点。${isCohabit ? "由于已同居，请务必生成一个属于两人的共同住宅（target为 shared, rel为 base）。" : "由于未同居，请务必分别生成用户的私人住所（target为 user, rel为 base）和角色的住所（target为 char, rel为 base）。"}`;
                        }
                    }
                    
                    // 3. 构造极其严谨的系统级推演 Prompt
                    const aiPrompt = `[System Preamble: Master Directive for Map Generation]
You are a master world-builder and life-simulator. Your task is to generate meaningful physical locations (map presets) based strictly on the provided character personas and world lore.
<Database>
${databaseContext}<User_Preference>
${userPrompt ? userPrompt : '无特殊诉求，请完全基于上述人设、职业、背景经历以及世界书自由推演其生活中最核心的场景。'}
</User_Preference>
</Database>
【核心指令】
请深度推演并生成至少 8 个对 <Database> 中的人物具有特殊意义的地图场所。
严禁凭空编造大众化的无聊地点，所有地点必须绝对忠于 <Database> 中的人物背景、职业、喜好以及世界观设定。如果世界书或人设里提到了特定的城市、机构、住址，请优先将其具象化为地图坐标！
【地点命名铁律】地点名称必须简洁干净，禁止添加任何形容词或修饰语！正确的格式是"店名/品牌名+店铺类型"或直接使用专有名称。
- 错误示范："温馨的officetel"、"常去的咖啡馆"、"热闹的夜市"、"角色最爱的餐厅"
- 正确示范："lili蛋糕店"、"yueyue咖啡店"、"岩石 officetel"、"夜市"、"汉江公园"
- 店铺类地点必须带有具体的店名，如"momo拉面店"、"starlight酒吧"，而不是只写"拉面店"、"酒吧"。
- 如果人设或世界书中有具体店名/地名（如"星巴克"、"延世大学"），则直接使用原名，不加任何前缀后缀。
【公共场所补充要求】除了与角色和用户直接相关的地点外，还必须额外生成 2 到 3 个位于世界观内的公共娱乐或餐饮场所（如餐厅、酒吧、电影院、公园、商场等），target 设为 "shared" 或 "none"，因为角色和用户日常一定会外出约会或娱乐。这些公共场所同样必须符合人设的世界观背景，不要凭空编造。
为了让地图具有真实的层级感，请务必采用“大区域 + 具体地点”的组合方式生成。
1. 首先生成一个大区域（如：麻浦区延南洞、三里屯商圈），大区域的 radius 填 10 到 50，且大区域不能属于个人（target 必须填 "shared" 或 "none"）。
        2. 紧接着必须生成 2 到 3 个位于该大区域内的具体地点（如：温馨的officetel、常去的咖啡馆），具体地点的 radius 填 0，parent 字段填刚刚生成的大区域名称。
        3. 具体地点的 target 关联人可填 "char"(Ta的), "user"(我的), "shared"(共同的)。${userInstruction}
        必须输出为合法的 JSON 格式，不要包含任何 markdown 标记或其他文本。
JSON 结构示例模板：
{
  "locations": [
    {
      "name": "麻浦区延南洞",
      "parent": "",
      "target": "shared",
      "type": "生活",
      "radius": 30,
      "dist": 15,
      "scale": "大型",
      "traffic": "便利",
      "crowd": "适中",
      "rel": "none"
    },
    {
      "name": "gloss officetel",
      "parent": "麻浦区延南洞",
      "target": "char",
      "type": "休息",
      "radius": 0,
      "dist": 15,
      "scale": "小型",
      "traffic": "便利",
      "crowd": "稀少",
      "rel": "base"
    }
  ]
}
注意：
1. rel 表示与角色的关系：base(专属地/据点/居住地), favorite(偏爱/喜欢), frequent(经常出没), dislike(厌恶/反感), none(无特殊)。
2. target 关联人严格限制为：user(我), char(Ta), shared(共同), none(无)。
3. 务必生成至少 5 个地点，返回的必须是能直接被 JSON 解析的纯 JSON 对象！
4. 同一个大区域内的子地点之间 dist 值应该相近（差距不超过5），不同大区域之间的dist 值应该有明显差异（差距至少15以上），以确保地图上地点之间的距离分布合理、不会全部挤在一起。
`;
 
// 3. 请求 API
                    const response = await fetch(`${url.trim().replace(/\/$/, '')}/v1/chat/completions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                        body: JSON.stringify({
                            model: model,
                            messages: [{ role: 'user', content: aiPrompt }],
                            temperature: parseFloat(temperature) || 0.8
                        })
                    });
                    if (!response.ok) throw new Error(`API Error: ${response.status}`);
                    const data = await response.json();
                    let contentStr = data.choices?.[0]?.message?.content;
                    if (!contentStr) throw new Error("AI没有返回内容");
                    // 4. 提取并解析 JSON (增强防报错剥离机制)
                    let parsedData = null;
                    try {
                        let cleanStr = contentStr.replace(/```json/gi, '').replace(/```/g, '').trim();
                        const match = cleanStr.match(/\{[\s\S]*\}/);
                        parsedData = JSON.parse(match ? match[0] : cleanStr);
                    } catch (e) {
                        throw new Error("AI未返回标准JSON格式，导致解析失败。");
                    }
                   if (!parsedData || !parsedData.locations || !Array.isArray(parsedData.locations)) {
                        throw new Error("AI返回的数据缺少 locations 列表，请重试。");
                    }
                    // 5. 组装地点并画在地图上
                    const newLocs = parsedData.locations.map(loc => ({
                        name: loc.name || "未知地点",
                        parent: loc.parent || "",
                        radius: parseInt(loc.radius) || 0,
                        type: loc.type || "娱乐",
                        dist: parseInt(loc.dist) || 15,
                        scale: loc.scale || "中型",
                        traffic: loc.traffic || "一般",
                        crowd: loc.crowd || "适中",
                        rel: loc.rel || "none",
                        target: loc.target || targetIdentity
                    }));
                    // 【核心修复】必须先按照“是否有父级”进行排序。让大区域（无parent）先生成，子地点后生成。
                    // 否则子地点生成时找不到大区域的坐标，就会在全图乱飞！
                    newLocs.sort((a, b) => {
                        if (!a.parent && b.parent) return -1;
                        if (a.parent && !b.parent) return 1;
                        return 0;
                    });
                    newLocs.forEach(loc => {
                        currentLocations.push(loc);
                        renderMapDot(loc, currentLocations.length - 1);
                    });
                    const curPack = currentActivePack;
                    if(curPack) {
                        const packs = JSON.parse(localStorage.getItem('looky_map_packs') || '{}');
                        packs[curPack] = currentLocations;
                        localStorage.setItem('looky_map_packs', JSON.stringify(packs));
                    }
                    alert("✨ 智能推演完毕！已根据您的诉求生成一组地点，您可以直接点击图标进行修改。");
                    aiBlueprintModal.style.opacity = '0';
                    setTimeout(() => {
                        aiBlueprintModal.style.display = 'none';
                        document.getElementById('ai-map-prompt-input').value = '';
                    }, 300);
                } catch (error) {
                    console.error('[AI地图推演] 失败:', error);
                    alert("推演失败: " + error.message);
                } finally {
                    // 【关键兜底】无论成功还是失败，最终一定要解锁按钮，防止页面卡死
                    btnAiGenMap.textContent = "开始智能推演";
                    btnAiGenMap.disabled = false;
                }
            });
        }
       function renderMapDot(locObj, index) {
            // 如果旧数据是字符串，转为对象处理
            if (typeof locObj === 'string') {
                locObj = { name: locObj, type: '娱乐', dist: 10, traffic: '便利', crowd: '适中', scale: '中型', top: Math.floor(Math.random() * 60 + 20) + '%', left: Math.floor(Math.random() * 70 + 15) + '%' };
                currentLocations[index] = locObj; // 更新回数组
            }
            // 根据距离计算图标大小，距离越远，地标越小 (假设最大距离100，基础大小48px，每远1减去0.3px，最小不低于16px)
            const distVal = parseInt(locObj.dist) || 10;
            const iconSize = Math.max(16, 48 - (distVal * 0.3));
            
            // 新增：识别关联人颜色、区域半径、标签徽章
            const targetColor = locObj.target === 'user' ? '#ecd25e' : (locObj.target === 'char' ? '#9CB4A1' : '#D3A7A5');
            const radiusVal = parseInt(locObj.radius) || 0;
            const areaStyle = radiusVal > 0 ? `position: absolute; width: ${radiusVal * 6}px; height: ${radiusVal * 6}px; background: ${targetColor}22; border: 1.5px dashed ${targetColor}; border-radius: 50%; top: calc(100% - ${iconSize/2}px); left: 50%; transform: translate(-50%, -50%); pointer-events: none; z-index: -1;` : 'display: none;';
            // 根据关联关系生成后缀小图标，大模型无需看图，但用户看着直观
            let relBadge = '';
            if(locObj.rel === 'favorite') relBadge = ' <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="vertical-align: -2px; margin-left: 2px;"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
            if(locObj.rel === 'frequent') relBadge = ' <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="vertical-align: -2px; margin-left: 2px;"><path d="M10.5 4.5c.83 0 1.5-.67 1.5-1.5s-.67-1.5-1.5-1.5-1.5.67-1.5 1.5.67 1.5 1.5 1.5zm3 0c.83 0 1.5-.67 1.5-1.5s-.67-1.5-1.5-1.5-1.5.67-1.5 1.5.67 1.5 1.5 1.5zm-5 6c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm9 0c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm-8.5 4c1.38 0 2.5-1.12 2.5-2.5s-1.12-2.5-2.5-2.5-2.5 1.12-2.5 2.5 1.12 2.5 2.5 2.5zm6 0c1.38 0 2.5-1.12 2.5-2.5s-1.12-2.5-2.5-2.5-2.5 1.12-2.5 2.5 1.12 2.5 2.5 2.5z"/></svg>';
            if(locObj.rel === 'dislike') relBadge = ' <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" style="vertical-align: -2px; margin-left: 2px;"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>';
          if(locObj.rel === 'base') relBadge = ' <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="vertical-align: -2px; margin-left: 2px;"><path d="M12 3L4 9v12h5v-7h6v7h5V9z"/></svg>';
            // 所属区域前缀
            const parentPrefix = locObj.parent ? `<div style="font-size: 8px; color: #8F7F74; margin-bottom: 2px;">[${locObj.parent}]</div>` : '';
            // 如果没有保存坐标，给个初始位置
           if (!locObj.top || !locObj.left) {
                if (locObj.parent) {
                    // 如果有父级，找父级坐标，在父级附近随机生成
                    const parentObj = currentLocations.find(l => l.name === locObj.parent);
                    if (parentObj && parentObj.top && parentObj.left) {
                        locObj.top = `${parseFloat(parentObj.top) + (Math.random() - 0.5) * 4}%`;
                        locObj.left = `${parseFloat(parentObj.left) + (Math.random() - 0.5) * 4}%`;
                    } else {
                        // 兜底：找不到父级，再全局随机
                        locObj.top = Math.floor(Math.random() * 60 + 20) + '%';
                        locObj.left = Math.floor(Math.random() * 70 + 15) + '%';
                    }
                } else {
                    locObj.top = Math.floor(Math.random() * 60 + 20) + '%';
                    locObj.left = Math.floor(Math.random() * 70 + 15) + '%';
                }
            }
            const dotEl = document.createElement('div');
            dotEl.className = 'dynamic-map-dot';  // 核心修改：换成不与CSS冲突的专属类名，找回图标显示！
            
            // 核心修改：加入 user-select: none; 等禁止选中的样式，完美解决苹果手机长按弹出文字选择器的问题
            dotEl.style.cssText = `position: absolute; top: ${locObj.top}; left: ${locObj.left}; transform: translate(-50%, -100%); display: flex; flex-direction: column; align-items: center; z-index: 2; cursor: pointer; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;`;
            
            // --- 新增：如果是区域(半径>0)，就不显示底部的水滴定位图标 ---
            // 核心修复：给 SVG 加上 class="main-map-marker" 防止拖拽时错误放大关系图标
            const locationIcon = radiusVal > 0 ? '' : `<svg class="main-map-marker" viewBox="0 0 24 24" fill="${targetColor}" style="width: ${iconSize}px; height: ${iconSize}px; filter: drop-shadow(0 6px 4px rgba(92, 84, 77, 0.25)); pointer-events: none; position: relative; z-index: 2;"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>`;
               // 给它加上 id 方便查找，也方便拖拽时阻止默认事件
            dotEl.innerHTML = `
                <div style="${areaStyle}"></div>
                <div style="display: flex; flex-direction: column; align-items: center; background: rgba(253, 251, 247, 0.95); padding: 4px 10px; border-radius: 12px; box-shadow: 0 4px 12px rgba(163, 149, 143, 0.2); white-space: nowrap; margin-bottom: 2px; border: 1px solid rgba(235, 228, 223, 0.8); pointer-events: none; position: relative; z-index: 2;">
                    ${parentPrefix}
                    <div style="font-size: 11px; font-weight: 800; color: #5C544D;">${locObj.name}${relBadge} <span style="font-size: 9px; color:#A3958F; font-weight: normal;">(${locObj.type})</span></div>
                </div>
                ${locationIcon}
            `;
            dotsContainer.appendChild(dotEl);
           // ---- 交互：单击编辑，长按拖动 ----
            let pressTimer;
            let isDragging = false;
            let hasMoved = false;
            let startX, startY;
            const startPress = (e) => {
                e.stopPropagation(); // 阻止事件冒泡，防止误触底下的地图
                isDragging = false;
                hasMoved = false;
                // 记录初始触摸点，防止轻微抖动被误判为拖拽
                if(e.type === 'touchstart') {
                    startX = e.touches[0].clientX;
                    startY = e.touches[0].clientY;
                }
                
                pressTimer = setTimeout(() => {
                    isDragging = true;
                    dotEl.style.opacity = '0.7'; // 拖动时变透明一点
                    // 防止视口跟着滑动
                    const viewport = document.getElementById('world-map-viewport');
                    if(viewport) viewport.style.overflow = 'hidden'; 
                }, 500); // 500毫秒算长按
            };
            const movePress = (e) => {
                if(e.type === 'touchmove') {
                    // 如果移动距离超过 5px，就算作滑动，取消长按判定
                    if (!isDragging && Math.abs(e.touches[0].clientX - startX) > 5 || Math.abs(e.touches[0].clientY - startY) > 5) {
                         clearTimeout(pressTimer);
                         hasMoved = true;
                    }
                }
             if (!isDragging) return;
                e.preventDefault(); // 阻止滚动
                
                // 计算相对位置并移动
                const currentZoomWrapper = document.getElementById('world-map-zoom-wrapper'); // 核心修改：实时获取 DOM，防止变量未定义报错
                const wrapperRect = currentZoomWrapper.getBoundingClientRect();
                let clientX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
                let clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
                            let newLeft = ((clientX - wrapperRect.left) / wrapperRect.width) * 100;
                let newTop = ((clientY - wrapperRect.top) / wrapperRect.height) * 100;
                
                // 核心修改：父区域范围限制算法 (圆周碰撞检测)
                if (locObj.parent) {
                    const parentObj = currentLocations.find(l => l.name === locObj.parent && parseInt(l.radius) > 0);
                    if (parentObj) {
                        const pLeft = parseFloat(parentObj.left);
                        const pTop = parseFloat(parentObj.top);
                        const pRadiusPx = parseInt(parentObj.radius) * 3; // 渲染时圆宽度是radius*6，半径即为*3
                        
                        // 将像素半径换算成相对于屏幕的百分比半径
                        const rxPercent = (pRadiusPx / wrapperRect.width) * 100;
                        const ryPercent = (pRadiusPx / wrapperRect.height) * 100;
                        
                        // 相对距离向量
                        const dx = (newLeft - pLeft) / rxPercent; 
                        const dy = (newTop - pTop) / ryPercent;
                        const distSq = dx * dx + dy * dy; // 距离的平方
                        
                        // 如果超出了半径为1的单位圆，强行拉回到圆周上
                        if (distSq > 1) {
                            const dist = Math.sqrt(distSq);
                            newLeft = pLeft + (dx / dist) * rxPercent;
                            newTop = pTop + (dy / dist) * ryPercent;
                        }
                    }
                }
                // 边界限制
                           if(newLeft < 0) newLeft = 0; if(newLeft > 100) newLeft = 100;
                if(newTop < 0) newTop = 0; if(newTop > 100) newTop = 100;
                dotEl.style.left = `${newLeft}%`;
                dotEl.style.top = `${newTop}%`;
               // === 核心：拖动时实时计算到地图中心(50%, 50%)的物理距离 ===
                const distanceToCenter = Math.sqrt(Math.pow(newLeft - 50, 2) + Math.pow(newTop - 50, 2));
                // 将物理距离映射为 1-100 的数值
                const realDist = Math.min(100, Math.round(distanceToCenter * 1.414));
                locObj.dist = realDist; // 实时更新对象属性
                
                // 实时计算新大小并应用给 SVG，实现拖动中实时缩放
                const newIconSize = Math.max(16, 48 - (realDist * 0.3));
                // 核心修复：只精准选中主地标图标进行缩放，忽略偏爱/反感的 SVG
                const svgEl = dotEl.querySelector('svg.main-map-marker');
                if (svgEl) {
                    svgEl.style.width = `${newIconSize}px`;
                    svgEl.style.height = `${newIconSize}px`;
                }
                // 保存新坐标
                locObj.left = `${newLeft}%`;
                locObj.top = `${newTop}%`;
                currentLocations[index] = locObj; 
            };
            const endPress = (e) => {
                e.stopPropagation(); // 阻止事件冒泡
                if (e.type === 'touchend' && e.cancelable) {
                    e.preventDefault(); // 核心修改：掐死手机浏览器 300ms 后自动生成的点击事件，完美解决“穿透点击”误触弹窗的问题！
                }
                clearTimeout(pressTimer);
                if (isDragging) {
                    dotEl.style.opacity = '1';
                    const viewport = document.getElementById('world-map-viewport');
                    if(viewport) viewport.style.overflow = 'auto'; // 恢复滚动
                    isDragging = false;
                     // 拖动结束，可以自动保存回本地
                    const packs = JSON.parse(localStorage.getItem('looky_map_packs') || '{}');
                    const curPack = currentActivePack;
                    if(curPack && packs[curPack]) {
                        packs[curPack] = currentLocations;
                        localStorage.setItem('looky_map_packs', JSON.stringify(packs));
                    }
                // ▼▼▼ 核心修复：排除系统打断和鼠标滑出造成的假点击 ▼▼▼
                } else if (!hasMoved && e.type !== 'touchcancel' && e.type !== 'mouseleave') {
                    // 如果不是拖动，也没滑动，则是点击 -> 编辑这个点
                    currentMapAction = 'editLoc';
                    document.getElementById('world-map-modal-index').value = index;
                    if(deleteLocBtn) deleteLocBtn.style.display = 'block'; // 编辑模式显示删除按钮
                    mapModalTitle.textContent = '编辑地点信息';
                    mapModalInput.value = locObj.name || '';
                    document.getElementById('world-map-modal-type').value = locObj.type || '娱乐';
                    document.getElementById('world-map-modal-dist').value = locObj.dist || 10;
                    updateParentOptions(locObj.name, locObj.parent); // 动态生成下拉框并选中对应父区域
                    if(document.getElementById('world-map-modal-target')) document.getElementById('world-map-modal-target').value = locObj.target || 'none';
                    if(document.getElementById('world-map-modal-rel')) document.getElementById('world-map-modal-rel').value = locObj.rel || 'none';
                     if(document.getElementById('world-map-modal-radius')) document.getElementById('world-map-modal-radius').value = locObj.radius || 0;
                    if(document.getElementById('world-map-modal-scale')) document.getElementById('world-map-modal-scale').value = locObj.scale || '中型';
                    if(document.getElementById('world-map-modal-traffic')) document.getElementById('world-map-modal-traffic').value = locObj.traffic || '便利';
                    if(document.getElementById('world-map-modal-crowd')) document.getElementById('world-map-modal-crowd').value = locObj.crowd || '适中';
                    
                    // ▼▼▼ 核心算法：计算当前地点到其他所有地点的欧几里得物理距离 ▼▼▼
                    const distContainer = document.getElementById('world-map-modal-distances-container');
                    const distList = document.getElementById('world-map-modal-distances-list');
                    if (distContainer && distList) {
                        const curX = parseFloat(locObj.left) || 50;
                        const curY = parseFloat(locObj.top) || 50;
                        let distArr = [];
                        currentLocations.forEach((otherLoc, otherIdx) => {
                            if (otherIdx !== index) {
                                const oX = parseFloat(otherLoc.left) || 50;
                                const oY = parseFloat(otherLoc.top) || 50;
                                // 勾股定理算距离，并按原有比例换算为公里数
                                const km = Math.round(Math.sqrt(Math.pow(curX - oX, 2) + Math.pow(curY - oY, 2)) * 1.414);
                                distArr.push({ name: otherLoc.name, km: km, type: otherLoc.type || '未知' });
                            }
                        });
                        // 从近到远排序
                        distArr.sort((a, b) => a.km - b.km);
                        if (distArr.length === 0) {
                            distList.innerHTML = '<div style="font-size:12px; color:#A3958F; text-align: center; padding: 10px;">地图上暂无其他地点哦</div>';
                        } else {
                            distList.innerHTML = distArr.map(d => `
                                <div style="display:flex; justify-content:space-between; align-items:center; background:#FFF; padding:8px 12px; border-radius:8px; border:1px solid #EBE4DD;">
                                    <span style="color:#5C544D; font-weight:700; font-size: 13px;">${d.name} <span style="font-weight:normal; font-size:10px; color:#A3958F;">(${d.type})</span></span>
                                    <span style="color:#D3A7A5; font-weight:800; font-size: 12px;">相距 ${d.km} km</span>
                                </div>
                            `).join('');
                        }
                        distContainer.style.display = 'flex';
                    }
                    // ▲▲▲ 计算结束 ▲▲▲

                    mapModal.style.display = 'flex';
                    setTimeout(() => mapModal.style.opacity = '1', 10);
                }
            };
            // 绑定电脑端和手机端事件
            dotEl.addEventListener('mousedown', startPress);
            dotEl.addEventListener('touchstart', startPress, {passive: false});
            
            // ▼▼▼ 核心修复：全部改绑在点阵元素自身，移动端原生支持隐式捕获，彻底断绝全局污染 ▼▼▼
            dotEl.addEventListener('mousemove', movePress);
            dotEl.addEventListener('touchmove', movePress, {passive: false});
            dotEl.addEventListener('mouseup', endPress);
            dotEl.addEventListener('touchend', endPress);
            
            // 新增防抖底：防止系统弹窗打断或电脑端鼠标滑出导致卡死
            dotEl.addEventListener('touchcancel', endPress);
            dotEl.addEventListener('mouseleave', endPress); 
        }
        
        function loadMapPacks() {
            if(!mapPackListContainer) return;
            const packs = JSON.parse(localStorage.getItem('looky_map_packs') || '{}');
            mapPackListContainer.innerHTML = '';
            
            const packNames = Object.keys(packs);
            if (packNames.length === 0) {
                mapPackListContainer.innerHTML = '<div style="text-align:center; color:#A3958F; font-size:13px; padding: 20px;">暂无预设，请先在地图添加地点并保存。</div>';
                return;
            }
            packNames.forEach(packName => {
                const item = document.createElement('div');
                item.className = 'map-pack-item';
                item.innerHTML = `
                    <span class="pack-name">${packName}</span>
                    <div class="pack-actions">
                        <button class="pack-btn btn-apply" title="应用"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg></button>
                        <button class="pack-btn btn-edit" title="重命名"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
                        <button class="pack-btn danger btn-delete" title="删除"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
                    </div>
                `;
                // 1. 应用数据
                item.querySelector('.btn-apply').addEventListener('click', () => {
                    currentActivePack = packName;
                    if(currentMapPackNameDisplay) currentMapPackNameDisplay.textContent = packName;
                    if(saveMapPackBtn) saveMapPackBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2 2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg> 保存编辑`;
                    // 清空现有，保留市中心
                    dotsContainer.querySelectorAll('.dynamic-map-dot').forEach(e => e.remove());
                    currentLocations = [...packs[packName]];
                    currentLocations.forEach((loc, idx) => renderMapDot(loc, idx));
                    
                    mapPackModal.style.opacity = '0';
                    setTimeout(() => mapPackModal.style.display = 'none', 300);
                });
                // 2. 重命名
                item.querySelector('.btn-edit').addEventListener('click', () => {
                    const newName = prompt('请输入新的预设名称：', packName);
                    if (newName && newName.trim() !== '' && newName !== packName) {
                        if (packs[newName]) {
                            alert('该名称已存在，请换一个名字哦！');
                            return;
                        }
                        packs[newName] = packs[packName];
                        delete packs[packName];
                        localStorage.setItem('looky_map_packs', JSON.stringify(packs));
                        if (currentActivePack === packName) {
                            currentActivePack = newName;
                            if(currentMapPackNameDisplay) currentMapPackNameDisplay.textContent = newName;
                        }
                        loadMapPacks();
                    }
                });
                 // 3. 删除
                item.querySelector('.btn-delete').addEventListener('click', () => {
                    if (confirm(`确定要删除地图预设包【${packName}】吗？`)) {
                        delete packs[packName];
                        localStorage.setItem('looky_map_packs', JSON.stringify(packs));
                        if (currentActivePack === packName) {
                            currentActivePack = '';
                            if(currentMapPackNameDisplay) currentMapPackNameDisplay.textContent = '选择地图预设...';
                            if(saveMapPackBtn) saveMapPackBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2 2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg> 保存预设`;
                            currentLocations = [];
                            dotsContainer.querySelectorAll('.dynamic-map-dot').forEach(e => e.remove());
                        }
                        loadMapPacks();
                    }
                });
                mapPackListContainer.appendChild(item);
            });
        }
        
        loadMapPacks();
        
        // 绑定打开管理弹窗
        if (btnOpenMapPackModal && mapPackModal) {
            btnOpenMapPackModal.addEventListener('click', () => {
                loadMapPacks();
                mapPackModal.style.display = 'flex';
                setTimeout(() => mapPackModal.style.opacity = '1', 10);
            });
        }
        
        // 绑定关闭管理弹窗
        if (closeMapPackModalBtn && mapPackModal) {
            closeMapPackModalBtn.addEventListener('click', () => {
                mapPackModal.style.opacity = '0';
                setTimeout(() => mapPackModal.style.display = 'none', 300);
            });
        }
            if (addWorldLocBtn) {
               addWorldLocBtn.addEventListener('click', () => {
                currentMapAction = 'addLoc';
                if(deleteLocBtn) deleteLocBtn.style.display = 'none'; // 添加模式隐藏删除按钮
                updateParentOptions('', ''); // 新增时刷新一遍区域列表
                mapModalTitle.textContent = '添加新地点';
                mapModalInput.placeholder = '例如：霓虹酒吧 / CBD';
                mapModalInput.value = '';
                
                // --- 新增：清空并重置所有下拉框和输入框 ---
                if(document.getElementById('world-map-modal-parent')) document.getElementById('world-map-modal-parent').value = '';
                if(document.getElementById('world-map-modal-target')) document.getElementById('world-map-modal-target').value = 'none';
                if(document.getElementById('world-map-modal-rel')) document.getElementById('world-map-modal-rel').value = 'none';
                if(document.getElementById('world-map-modal-type')) document.getElementById('world-map-modal-type').value = '娱乐';
                if(document.getElementById('world-map-modal-dist')) document.getElementById('world-map-modal-dist').value = '10';
                if(document.getElementById('world-map-modal-radius')) document.getElementById('world-map-modal-radius').value = '0';
                if(document.getElementById('world-map-modal-scale')) document.getElementById('world-map-modal-scale').value = '中型';
                if(document.getElementById('world-map-modal-traffic')) document.getElementById('world-map-modal-traffic').value = '便利';
                if(document.getElementById('world-map-modal-crowd')) document.getElementById('world-map-modal-crowd').value = '适中';
                
                // ▼▼▼ 新增：新建地点时隐藏距离面板 ▼▼▼
                const distContainer = document.getElementById('world-map-modal-distances-container');
                if (distContainer) distContainer.style.display = 'none';
                
                // 恢复可能被之前继承逻辑禁用的下拉框
                ['world-map-modal-scale', 'world-map-modal-traffic', 'world-map-modal-crowd', 'world-map-modal-dist'].forEach(id => {
                    const el = document.getElementById(id);
                    if(el) el.disabled = false;
                });
                // ------------------------------------------
                mapModal.style.display = 'flex';
                setTimeout(() => mapModal.style.opacity = '1', 10);
            });
        }
        // 新增的专属保存弹窗逻辑
        const saveMapPackModal = document.getElementById('save-map-pack-modal');
        const saveMapPackInput = document.getElementById('save-map-pack-input');
        const cancelSaveMapPackBtn = document.getElementById('cancel-save-map-pack-btn');
        const confirmSaveMapPackBtn = document.getElementById('confirm-save-map-pack-btn');
         if (saveMapPackBtn && saveMapPackModal) {
            saveMapPackBtn.addEventListener('click', () => {
                if(currentLocations.length === 0) {
                    alert('字典簿太空啦，请先添加至少一个地点哦！');
                    return;
                }
                         if (currentActivePack) {
                    // 已有预设：直接覆盖，不弹窗
                    const packs = JSON.parse(localStorage.getItem('looky_map_packs') || '{}');
                    packs[currentActivePack] = currentLocations;
                    localStorage.setItem('looky_map_packs', JSON.stringify(packs));
                    alert(`已成功保存对【${currentActivePack}】的编辑内容。`);
                    
                    // 核心修改：保存完毕后，清空数据，重置画布，让按钮变回“保存预设”
                    currentLocations = [];
                    dotsContainer.querySelectorAll('.dynamic-map-dot').forEach(e => e.remove());
                    currentActivePack = '';
                    if (currentMapPackNameDisplay) currentMapPackNameDisplay.textContent = '选择地图预设...';
                    if (saveMapPackBtn) saveMapPackBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2 2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg> 保存预设`;
                    loadMapPacks();
                    return;
                }

                saveMapPackInput.value = '';
                saveMapPackModal.style.display = 'flex';
                setTimeout(() => saveMapPackModal.style.opacity = '1', 10);
            });
            cancelSaveMapPackBtn.addEventListener('click', () => {
                saveMapPackModal.style.opacity = '0';
                setTimeout(() => saveMapPackModal.style.display = 'none', 300);
            });
            confirmSaveMapPackBtn.addEventListener('click', () => {
                const val = saveMapPackInput.value.trim();
                if (!val) { alert("请输入预设包名称！"); return; }
                
                const packs = JSON.parse(localStorage.getItem('looky_map_packs') || '{}');
                packs[val] = currentLocations;
                localStorage.setItem('looky_map_packs', JSON.stringify(packs));
                alert(`世界观地图包【${val}】已保存至本地数据库。`);
                
                // 核心修改：保存新预设完毕后，同样清空画布，恢复初始状态
                currentLocations = [];
                dotsContainer.querySelectorAll('.dynamic-map-dot').forEach(e => e.remove());
                currentActivePack = '';
                if (currentMapPackNameDisplay) currentMapPackNameDisplay.textContent = '选择地图预设...';
                if (saveMapPackBtn) saveMapPackBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2 2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg> 保存预设`;
                
                loadMapPacks();
                
                saveMapPackModal.style.opacity = '0';
                setTimeout(() => saveMapPackModal.style.display = 'none', 300);
            });
        }
        if (mapModalClose) {
            mapModalClose.addEventListener('click', () => {
                mapModal.style.opacity = '0';
                setTimeout(() => mapModal.style.display = 'none', 300);
            });
        }
       if (mapModalConfirm) {
            mapModalConfirm.addEventListener('click', () => {
                const val = mapModalInput.value.trim();
                if (!val && currentMapAction !== 'savePack') return;
                const mType = document.getElementById('world-map-modal-type') ? document.getElementById('world-map-modal-type').value : '娱乐';
                const mDist = document.getElementById('world-map-modal-dist') ? document.getElementById('world-map-modal-dist').value : 10;
                const mParent = document.getElementById('world-map-modal-parent') ? document.getElementById('world-map-modal-parent').value : '';
                const mTarget = document.getElementById('world-map-modal-target') ? document.getElementById('world-map-modal-target').value : 'none';
                const mRel = document.getElementById('world-map-modal-rel') ? document.getElementById('world-map-modal-rel').value : 'none';
                const mRadius = document.getElementById('world-map-modal-radius') ? document.getElementById('world-map-modal-radius').value : 0;
                let mScale = document.getElementById('world-map-modal-scale') ? document.getElementById('world-map-modal-scale').value : '中型';
                let mTraffic = document.getElementById('world-map-modal-traffic') ? document.getElementById('world-map-modal-traffic').value : '便利';
                let mCrowd = document.getElementById('world-map-modal-crowd') ? document.getElementById('world-map-modal-crowd').value : '适中';
                
                // 核心：强制继承父区域属性，防止黑客手法绕过UI修改
                if (mParent) {
                    const pObj = currentLocations.find(l => l.name === mParent);
                    if (pObj) {
                        mScale = pObj.scale || '中型';
                        mTraffic = pObj.traffic || '便利';
                        mCrowd = pObj.crowd || '适中';
                    }
                }
                           if (currentMapAction === 'addLoc') {
                    let calcTop, calcLeft;
                    // 核心修改：如果有父区域，降生在父区域中心附近；如果没有，才按距离随机算
                    if (mParent) {
                        const pObj = currentLocations.find(l => l.name === mParent);
                        if (pObj) {
                            // 在父区域中心坐标上下左右随机偏移 2%，防止图标重叠在一起
                            calcTop = parseFloat(pObj.top) + (Math.random() - 0.5) * 4;
                            calcLeft = parseFloat(pObj.left) + (Math.random() - 0.5) * 4;
                        }
                    } else {
                        const radius = (mDist / 100) * 50;
                        const angle = Math.random() * Math.PI * 2;
                        calcTop = 50 + radius * Math.sin(angle);
                        calcLeft = 50 + radius * Math.cos(angle);
                    }
                    
                    const newLoc = {
                        name: val, 
                        type: mType, 
                        parent: mParent,
                        target: mTarget,
                        rel: mRel,
                        radius: mRadius,
                        dist: mDist, 
                        scale: mScale,
                        traffic: mTraffic,
                        crowd: mCrowd,
                        top: `${calcTop}%`,
                        left: `${calcLeft}%`
                    };
                    currentLocations.push(newLoc);
                    renderMapDot(newLoc, currentLocations.length - 1);
               } else if (currentMapAction === 'editLoc') {
                    const editIdx = document.getElementById('world-map-modal-index').value;
                    if (currentLocations[editIdx]) {
                        // 核心修改：如果是修改了距离，或者修改了所属区域，就要重算坐标
                        // 核心修复：给原数据的 parent 加上 || ''，防止 undefined 和 空字符串 不相等引发位置重置误判！
                        if (currentLocations[editIdx].dist != mDist || (currentLocations[editIdx].parent || '') !== mParent) {
                            if (mParent) {
                                const pObj = currentLocations.find(l => l.name === mParent);
                                if (pObj) {
                                    // 飞到新的父区域中心附近
                                    currentLocations[editIdx].top = `${parseFloat(pObj.top) + (Math.random() - 0.5) * 4}%`;
                                    currentLocations[editIdx].left = `${parseFloat(pObj.left) + (Math.random() - 0.5) * 4}%`;
                                }
                            } else {
                                // 没区域，按距离随机分配
                                const radius = (mDist / 100) * 50;
                                const angle = Math.random() * Math.PI * 2;
                                currentLocations[editIdx].top = `${50 + radius * Math.sin(angle)}%`;
                                currentLocations[editIdx].left = `${50 + radius * Math.cos(angle)}%`;
                            }
                        }
                        const oldName = currentLocations[editIdx].name;// 记录旧名字用于级联更新
                        currentLocations[editIdx].name = val;
                        currentLocations[editIdx].type = mType;
                        currentLocations[editIdx].parent = mParent;
                        currentLocations[editIdx].target = mTarget;
                        currentLocations[editIdx].rel = mRel;
                        currentLocations[editIdx].radius = mRadius;
                                    currentLocations[editIdx].dist = mDist;
                        currentLocations[editIdx].scale = mScale;
                        currentLocations[editIdx].traffic = mTraffic;
                        currentLocations[editIdx].crowd = mCrowd;
                        
                        // 核心：如果是区域节点，改了名字或属性，必须级联同步更新底下的所有子节点！
                        if (mRadius > 0) {
                            currentLocations.forEach(child => {
                                if (child.parent === oldName) {
                                    child.parent = val; // 名字改了带着一起改
                                    child.scale = mScale;
                                    child.traffic = mTraffic;
                                    child.crowd = mCrowd;
                                }
                            });
                        }
                        dotsContainer.querySelectorAll('.dynamic-map-dot').forEach(e => e.remove());
                        currentLocations.forEach((loc, idx) => renderMapDot(loc, idx));
                    }
                } else if (currentMapAction === 'savePack') {
                    if (!val) { alert("请输入预设包名称！"); return; }
                    const packs = JSON.parse(localStorage.getItem('looky_map_packs') || '{}');
                    packs[val] = currentLocations;
                    localStorage.setItem('looky_map_packs', JSON.stringify(packs));
                    alert(`世界观地图包【${val}】已保存至本地数据库。`);
                    
                    // 保存完毕后自动更新当前状态
                    currentActivePack = val;
                    if(currentMapPackNameDisplay) currentMapPackNameDisplay.textContent = val;
                }
                mapModal.style.opacity = '0';
                setTimeout(() => mapModal.style.display = 'none', 300);
            });
        }
        
        // 原 mapPackSelect 的 change 事件监听已移除，由 mapPackListContainer 中的 btn-apply 接管
        
        // --- 核心原生滑动与双指缩放逻辑 (极致丝滑优化版) ---
        const zoomInBtn = document.getElementById('map-zoom-in-btn');
        const zoomOutBtn = document.getElementById('map-zoom-out-btn');
        const zoomWrapper = document.getElementById('world-map-zoom-wrapper');
        const viewport = document.getElementById('world-map-viewport');
        let currentZoom = 100;

        function updateZoom() {
            zoomWrapper.style.width = `${currentZoom}%`;
            zoomWrapper.style.height = `${currentZoom}%`;
        }

        if (zoomInBtn && zoomOutBtn && zoomWrapper && viewport) {
            // 点击按钮时，开启 CSS 动画过渡，让缩放显得柔和
            zoomInBtn.addEventListener('click', () => {
                zoomWrapper.style.transition = "width 0.3s, height 0.3s";
                if (currentZoom < 300) { currentZoom += 50; updateZoom(); }
            });
            zoomOutBtn.addEventListener('click', () => {
                zoomWrapper.style.transition = "width 0.3s, height 0.3s";
                if (currentZoom > 100) { currentZoom -= 50; updateZoom(); }
            });

            // --- 补充：手势双指缩放 ---
            let initialDistance = 0;
            let initialZoom = 100;

            viewport.addEventListener('touchstart', (e) => {
                if (e.touches.length === 2) {
                    e.preventDefault();
                    // 【关键优化】：双指触碰时，立刻关闭 CSS 动画过渡，确保手指缩放“零延迟”，解决缩不好的问题
                    zoomWrapper.style.transition = "none";
                    initialDistance = Math.hypot(
                        e.touches[0].pageX - e.touches[1].pageX,
                        e.touches[0].pageY - e.touches[1].pageY
                    );
                    initialZoom = currentZoom;
                }
            }, { passive: false });

            viewport.addEventListener('touchmove', (e) => {
                if (e.touches.length === 2) {
                    e.preventDefault();
                    const currentDistance = Math.hypot(
                        e.touches[0].pageX - e.touches[1].pageX,
                        e.touches[0].pageY - e.touches[1].pageY
                    );
                    
                    // 计算缩放比率
                    let zoomFactor = currentDistance / initialDistance;
                    let newZoom = initialZoom * zoomFactor;
                    
                    if (newZoom < 100) newZoom = 100;
                    if (newZoom > 400) newZoom = 400; // 手势缩放最大可以允许到 400%

                    currentZoom = newZoom;
                    
                    // 实时更新宽高，因为关闭了 transition，这里会极其跟手
                    zoomWrapper.style.width = `${currentZoom}%`;
                    zoomWrapper.style.height = `${currentZoom}%`;
                }
            }, { passive: false });
           // 触摸结束时，恢复过渡效果
            viewport.addEventListener('touchend', (e) => {
                if (e.touches.length < 2) {
                    zoomWrapper.style.transition = "width 0.3s, height 0.3s";
                }
            });
        }
        // ▼▼▼ 新增：单人日程弹窗的打开与保存逻辑 ▼▼▼
        // 因为“单人日程”按钮是点击“我”才动态生成的，所以要用全局监听
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('single-schedule-btn') || e.target.textContent === '单人日程') {
                const modal = document.getElementById('add-single-schedule-modal');
                if (modal) {
                    // 清理上一次的编辑痕迹，重置为新增模式
                    if(document.getElementById('edit-schedule-id')) document.getElementById('edit-schedule-id').value = '';
                    if(document.getElementById('delete-single-schedule-btn')) document.getElementById('delete-single-schedule-btn').style.display = 'none';
                    
                    modal.style.display = 'flex';
                    setTimeout(() => modal.style.opacity = '1', 10);
                }
                // 点击后自动收起菜单
                const fabMain = document.getElementById('ls-fab-main');
                const fabMenu = document.getElementById('ls-fab-menu');
                if (fabMain) fabMain.classList.remove('active');
                if (fabMenu) fabMenu.classList.remove('active');
            } 
                    // 新增：点击行程卡片进入编辑模式
            else {
                // 核心修复：放宽权限，不再只监听 mine，而是监听所有 dynamic-schedule
                const clickedCard = e.target.closest('.tl-card.dynamic-schedule');
                if (clickedCard) {
                    // 智能判断当前点的是我的还是Ta的卡片
                    const isTaTrip = clickedCard.classList.contains('ta-trip');
                    const isJointTrip = clickedCard.classList.contains('joint-trip');
                    let modalId, prefix;
                    if (isJointTrip) {
                        modalId = 'add-joint-schedule-modal';
                        prefix = 'joint-schedule';
                        updateSoloScheduleUI(clickedCard.dataset.locname, 'joint-schedule');
                    } else if (isTaTrip) {
                        modalId = 'add-solo-schedule-modal';
                        prefix = 'solo-schedule';
                        updateSoloScheduleUI(clickedCard.dataset.locname);
                    } else {
                        modalId = 'add-single-schedule-modal';
                        prefix = 'schedule';
                    }
                   const modal = document.getElementById(modalId);
                    
                    if (modal) {
                        // 把原来卡片里保存的数据全部精准填回对应的弹窗输入框中
                        document.getElementById(`edit-${prefix}-id`).value = clickedCard.id; // 核心修复：根据 prefix 自动匹配三个不同房间的隐藏ID框
                        document.getElementById(`${prefix}-start-time`).value = clickedCard.dataset.startTime || '';
                        document.getElementById(`${prefix}-end-time`).value = clickedCard.dataset.endTime || '';
                        document.getElementById(`${prefix}-content-input`).value = clickedCard.dataset.content || '';
                        document.getElementById(`${prefix}-type-select`).value = clickedCard.dataset.type || '娱乐';
                        document.getElementById(`${prefix}-rel-select`).value = clickedCard.dataset.rel || 'none';
                        if (document.getElementById(`${prefix}-repeat-select`)) {
                            document.getElementById(`${prefix}-repeat-select`).value = clickedCard.dataset.repeat || 'none';
                        }
                        // 只有我的日程才有共享开关
                        if (!isTaTrip && !isJointTrip && document.getElementById('schedule-share-toggle')) {
                            document.getElementById('schedule-share-toggle').checked = clickedCard.dataset.shared === 'true';
                        }
                        
                        let delBtnId = 'delete-single-schedule-btn';
                        if (isTaTrip) delBtnId = 'delete-solo-schedule-btn';
                        if (isJointTrip) delBtnId = 'delete-joint-schedule-btn';
                        if (document.getElementById(delBtnId)) {
                            document.getElementById(delBtnId).style.display = 'block';
                        }
                        modal.style.display = 'flex';
                        setTimeout(() => modal.style.opacity = '1', 10);
                    }
                }
            }
        });
        // 弹窗关闭与保存
        const closeSingleBtn = document.getElementById('close-single-schedule-btn');
        const saveSingleBtn = document.getElementById('save-single-schedule-btn');
        const singleModal = document.getElementById('add-single-schedule-modal');
        
        if (closeSingleBtn && singleModal) {
            closeSingleBtn.addEventListener('click', () => {
                singleModal.style.opacity = '0';
                setTimeout(() => singleModal.style.display = 'none', 300);
            });
        }
            if (saveSingleBtn && singleModal) {
            saveSingleBtn.addEventListener('click', async () => {
                const startTime = document.getElementById('schedule-start-time').value;
               const endTime = document.getElementById('schedule-end-time').value;
                const content = document.getElementById('schedule-content-input').value;
                     const isShared = document.getElementById('schedule-share-toggle').checked;
                
                // 新增：获取性质的值，并生成带不同颜色的前置小标签
                const typeSelect = document.getElementById('schedule-type-select');
                const typeVal = typeSelect ? typeSelect.value : '娱乐';
                let typeBadge = '';
                if(typeVal === '娱乐') typeBadge = '<span style="font-size: 10px; background: #FDE8E8; color: #D3A7A5; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">娱乐</span>';
                if(typeVal === '工作') typeBadge = '<span style="font-size: 10px; background: #EAF0F6; color: #8FA2B4; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">工作</span>';
                if(typeVal === '吃饭') typeBadge = '<span style="font-size: 10px; background: #F4EFEA; color: #8F7F74; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">吃饭</span>';
                if(typeVal === '休息') typeBadge = '<span style="font-size: 10px; background: #E4EFE7; color: #9CB4A1; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">休息</span>';
                // 新增：获取关系的值，并生成对应的小标签 HTML
                const relSelect = document.getElementById('schedule-rel-select');
                const relVal = relSelect ? relSelect.value : 'none';
                let relBadge = '';
                if(relVal === 'favorite') relBadge = '<span style="font-size: 10px; background: #FDE8E8; color: #D3A7A5; padding: 2px 6px; border-radius: 6px; margin-left: 6px; font-weight: bold;">偏爱</span>';
                if(relVal === 'frequent') relBadge = '<span style="font-size: 10px; background: #F4EFEA; color: #8F7F74; padding: 2px 6px; border-radius: 6px; margin-left: 6px; font-weight: bold;">常去</span>';
                         if(relVal === 'dislike') relBadge = '<span style="font-size: 10px; background: #EEEEEE; color: #999; padding: 2px 6px; border-radius: 6px; margin-left: 6px; font-weight: bold;">反感</span>';
                if(relVal === 'base') relBadge = '<span style="font-size: 10px; background: #E4EFE7; color: #9CB4A1; padding: 2px 6px; border-radius: 6px; margin-left: 6px; font-weight: bold;">据点</span>';
                
                // 新增：获取重复设定的值，并生成小图标标签
                const repeatSelect = document.getElementById('schedule-repeat-select');
                const repeatVal = repeatSelect ? repeatSelect.value : 'none';
                let repeatBadge = '';
                if(repeatVal === 'daily') repeatBadge = '<span style="font-size: 10px; color: #9CB4A1; margin-left: 6px; border: 1px solid #E4EFE7; padding: 0 4px; border-radius: 4px;">↻每天</span>';
                if(repeatVal === 'weekly') repeatBadge = '<span style="font-size: 10px; color: #9CB4A1; margin-left: 6px; border: 1px solid #E4EFE7; padding: 0 4px; border-radius: 4px;">↻每周</span>';
                if(repeatVal === 'monthly') repeatBadge = '<span style="font-size: 10px; color: #9CB4A1; margin-left: 6px; border: 1px solid #E4EFE7; padding: 0 4px; border-radius: 4px;">↻每月</span>';
                if (!startTime || !content) {
                    alert('请至少填写开始时间和日程内容哦！');
                    return;
                }
                // 获取当前日历选中的是哪一天，作为数据标记
                const activeDayEl = document.querySelector('#ls-cal-days-grid .cal-day.active');
                const dayText = activeDayEl ? activeDayEl.textContent : '未知';
               // 构造展示出来的文字和图标
                const timeText = endTime ? `${startTime}<br><span style="font-size: 9px; color: #A3958F;">至 ${endTime}</span>` : startTime;
                const shareText = isShared ? '互通: 共享' : '互通: 私密';
                           const shareIcon = isShared 
                    ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>' 
                    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';
                
                // 核心修复：这是“我”专属的单人行程弹窗，不用判断页面，直接给我的身份标签
                const cardOwnerClass = 'mine';
                // 新增：把 repeatBadge 也塞进 HTML 里
                const cardInnerHTML = `
                    <div class="tl-main">
                        <span class="tl-info" style="display: flex; align-items: center;">${typeBadge}<span class="tl-content">${content}</span>${repeatBadge}${relBadge}</span>
                    </div>
                    <div class="tl-actions">
                        <div class="action-item ${isShared ? 'on' : ''}">
                            ${shareIcon}
                            ${shareText}
                        </div>
                    </div>
                `;
                const editId = document.getElementById('edit-schedule-id').value;
                
                if (editId) {
                    // 如果存在 editId，说明是在修改之前的行程
                    const existingCard = document.getElementById(editId);
                    if (existingCard) {
                        existingCard.innerHTML = cardInnerHTML;
                        existingCard.dataset.startTime = startTime;
                        existingCard.dataset.endTime = endTime;
                        existingCard.dataset.content = content;
                        existingCard.dataset.type = typeVal;
                        existingCard.dataset.rel = relVal;
                        existingCard.dataset.repeat = repeatVal; // 存入自定义属性
                        existingCard.dataset.shared = isShared;
                        // 更新左侧显示的时间
                        const timeEl = existingCard.closest('.tl-row').querySelector('.tl-time');
                        if (timeEl) timeEl.innerHTML = timeText;
                    }
                } else {
                     // 如果没有 editId，说明是全新添加
                    const scheduleId = 'sched-' + Date.now(); // 生成唯一ID
                   const newScheduleHTML = `
                    <div class="tl-row" data-schedule-date="${dayText}" data-schedule-date-iso="${getSelectedLifeSyncDateKey()}">
                        <div class="tl-time" style="line-height: 1.2;">${timeText}</div>
                        <div class="tl-node" style="border-color: #D3A7A5;"></div>
                        <!-- 核心修复：用智能判断的类名替换写死的 mine -->
                        <div class="tl-card ${cardOwnerClass} dynamic-schedule" id="${scheduleId}" data-start-time="${startTime}" data-end-time="${endTime}" data-content="${content}" data-type="${typeVal}" data-rel="${relVal}" data-repeat="${repeatVal}" data-shared="${isShared}" style="cursor: pointer;">
                            ${cardInnerHTML}
                        </div>
                    </div>
                    `;
    
                    // 把新的日程追加到时间轴面板里
                    const timeline = document.querySelector('.ls-timeline');
                    if (timeline) {
                        timeline.insertAdjacentHTML('beforeend', newScheduleHTML);
                        // 给日历上这一天点上粉色小圆点标记
                        if (activeDayEl && !activeDayEl.classList.contains('has-trip')) {
                            activeDayEl.classList.add('has-trip');
                        }
                    }
                   // 新增了行程，把空状态藏起来
                    const emptyState = document.getElementById('ls-empty-state');
                    if (emptyState) emptyState.style.display = 'none';
                }
                // 新增：每次保存后，对时间轴里当天的行程按起始时间重新排序
                const timelineBox = document.querySelector('.ls-timeline');
                if (timelineBox) {
                    const rows = Array.from(timelineBox.querySelectorAll('.tl-row'));
                    rows.sort((a, b) => {
                        const cardA = a.querySelector('.tl-card.dynamic-schedule');
                        const cardB = b.querySelector('.tl-card.dynamic-schedule');
                        // 如果有自定义时间取自定义，没有则取默认显示时间的文本
                         const timeA = cardA ? (cardA.dataset.startTime || '24:00') : (a.querySelector('.tl-time') ? a.querySelector('.tl-time').textContent.substring(0, 5) : '24:00');
                        const timeB = cardB ? (cardB.dataset.startTime || '24:00') : (b.querySelector('.tl-time') ? b.querySelector('.tl-time').textContent.substring(0, 5) : '24:00');
                        return timeA.localeCompare(timeB); // 按时间字符串("08:00" < "14:00")比较大小
                    });
                    
                    // 新增：根据当前系统时间更新行程的状态（进行中/已结束/未开始）
                    const now = new Date();
                    const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
                    
                    rows.forEach(row => {
                        timelineBox.appendChild(row); // 顺便把排序后的行放回去
                        const card = row.querySelector('.tl-card.dynamic-schedule');
                        if (card) {
                            const sTime = card.dataset.startTime || '00:00';
                            const eTime = card.dataset.endTime || '23:59';
                            
                            // 先重置所有特殊状态
                            card.classList.remove('active-trip', 'past-trip');
                            
                            // 核心修复：保存时加入日期对比
                            const rowDateKey = getTimelineRowDateKey(row);
                            if (rowDateKey < getLocalDateKey() || (rowDateKey === getLocalDateKey() && eTime < currentTime)) {
                                // 1. 已结束：变灰，盖印章
                                card.classList.add('past-trip');
                            } else if (rowDateKey === getLocalDateKey() && sTime <= currentTime && eTime >= currentTime) {
                                // 2. 正在进行：加上动画专属类名
                                card.classList.add('active-trip');
                            }
                                // 3. 未来行程：什么都不加，保持默认干净状态
                        }
                    });
                }
                // 核心新增：增改完成，将最新数据落库保存！
                await saveSchedulesToDB();
                await syncGlobalMineSchedules(); // ▼新增这一行：立刻全服同步
                // 关掉弹窗，清空输入框，方便下次添加
                singleModal.style.opacity = '0';
                setTimeout(() => {
                    singleModal.style.display = 'none';
                    document.getElementById('schedule-start-time').value = '';
                     document.getElementById('schedule-end-time').value = '';
                    document.getElementById('schedule-content-input').value = '';
                    document.getElementById('schedule-share-toggle').checked = true;
                  // 新增：重置关系下拉框
                    if (document.getElementById('schedule-rel-select')) {
                        document.getElementById('schedule-rel-select').value = 'none';
                    }
                    if (document.getElementById('schedule-type-select')) {
                        document.getElementById('schedule-type-select').value = '娱乐';
                    }
                    // 重置重复选项
                    if (document.getElementById('schedule-repeat-select')) {
                        document.getElementById('schedule-repeat-select').value = 'none';
                    }
                }, 300);
            });
        }
        // 新增：删除行程逻辑
        const delSingleBtn = document.getElementById('delete-single-schedule-btn');
        if (delSingleBtn && singleModal) {
            delSingleBtn.addEventListener('click', async () => {
                const editId = document.getElementById('edit-schedule-id').value;
                if (editId) {
                    const existingCard = document.getElementById(editId);
                    if (existingCard) {
                        const row = existingCard.closest('.tl-row');
                        if (row) row.remove(); // 杀掉这一整行
                        
                        // 删完后检查一下今天是不是空了
                        let visibleCount = 0;
                        document.querySelectorAll('.ls-timeline .tl-row').forEach(r => {
                            if (r.style.display !== 'none') visibleCount++;
                        });
                        const emptyState = document.getElementById('ls-empty-state');
                        if (emptyState && visibleCount === 0) {
                            emptyState.style.display = 'block'; // 空了就显示出提示
                        }
                    }
                }
                // 核心新增：同步从数据库删除记录！
                await saveSchedulesToDB();
                await syncGlobalMineSchedules(); // ▼新增这一行：立刻全服同步
                // 关闭弹窗
                singleModal.style.opacity = '0';
                setTimeout(() => {
                    singleModal.style.display = 'none';
                }, 300);
            });
        }
             // ▼▼▼ 新增：处理纯粹版“单人行程”的点击与保存逻辑 ▼▼▼
        function updateSoloScheduleUI(selectedLoc = '', prefix = 'solo-schedule') {
            const charId = window.tempState?.currentLifeSyncCharId;
            const boundPack = localStorage.getItem('ls_bound_map_' + charId);
            const typeSelect = document.getElementById(`${prefix}-type-select`);
            const relSelect = document.getElementById(`${prefix}-rel-select`);
            if (!typeSelect || !relSelect) return;
            const container = typeSelect.parentElement;
            
            let locSelect = document.getElementById(`${prefix}-loc-select`);
            if (boundPack) {
                typeSelect.style.display = 'none';
                relSelect.style.display = 'none';
                if (!locSelect) {
                    locSelect = document.createElement('select');
                    locSelect.id = `${prefix}-loc-select`;
                    locSelect.style.cssText = 'flex: 1; border: 1px solid #D6C5B3; border-radius: 12px; padding: 10px; font-size: 13px; outline: none; background: #FFF; color: #5C544D;';
                    container.appendChild(locSelect);
                }
                locSelect.style.display = 'block';
                locSelect.innerHTML = '<option value="">请选择地点</option>';
                const packs = JSON.parse(localStorage.getItem('looky_map_packs') || '{}');
                const mapData = packs[boundPack] || [];
                mapData.forEach(loc => {
                    const opt = document.createElement('option');
                    opt.value = loc.name;
                    opt.textContent = loc.name;
                    opt.dataset.type = loc.type || '娱乐';
                    opt.dataset.rel = loc.rel || 'none';
                    if (loc.name === selectedLoc) opt.selected = true;
                    locSelect.appendChild(opt);
                });
            } else {
                typeSelect.style.display = 'block';
                relSelect.style.display = 'block';
                if (locSelect) locSelect.style.display = 'none';
            }
        }
        
        document.addEventListener('click', (e) => {
            // 点击了刚才改成的文字：“单人行程”
            if (e.target.textContent === '单人行程') {
                const soloModal = document.getElementById('add-solo-schedule-modal');
                if (soloModal) {
                    if(document.getElementById('edit-solo-schedule-id')) document.getElementById('edit-solo-schedule-id').value = '';
                    if(document.getElementById('delete-solo-schedule-btn')) document.getElementById('delete-solo-schedule-btn').style.display = 'none';
                    
                    updateSoloScheduleUI();
                    soloModal.style.display = 'flex';
                    setTimeout(() => soloModal.style.opacity = '1', 10);
                }
                const fabMain = document.getElementById('ls-fab-main');
                       const fabMenu = document.getElementById('ls-fab-menu');
                if (fabMain) fabMain.classList.remove('active');
                if (fabMenu) fabMenu.classList.remove('active');
            }
               if (e.target.textContent === '双人行程') {
                const jointModal = document.getElementById('add-joint-schedule-modal');
                if (jointModal) {
                    if(document.getElementById('edit-joint-schedule-id')) document.getElementById('edit-joint-schedule-id').value = '';
                    if(document.getElementById('delete-joint-schedule-btn')) document.getElementById('delete-joint-schedule-btn').style.display = 'none';
                    
                    updateSoloScheduleUI('', 'joint-schedule');
                    jointModal.style.display = 'flex';
                    setTimeout(() => jointModal.style.opacity = '1', 10);
                }
                const fabMain = document.getElementById('ls-fab-main');
                const fabMenu = document.getElementById('ls-fab-menu');
                if (fabMain) fabMain.classList.remove('active');
                if (fabMenu) fabMenu.classList.remove('active');
            }
        });
            const closeSoloBtn = document.getElementById('close-solo-schedule-btn');
        const saveSoloBtn = document.getElementById('save-solo-schedule-btn');
        const soloModal = document.getElementById('add-solo-schedule-modal');
        
        // 核心修复：为 Ta 页面的删除按钮添加点击逻辑
        const delSoloBtn = document.getElementById('delete-solo-schedule-btn');
        if (delSoloBtn && soloModal) {
            delSoloBtn.addEventListener('click', async () => {
                const editId = document.getElementById('edit-solo-schedule-id').value;
                if (editId) {
                    const existingCard = document.getElementById(editId);
                    if (existingCard) {
                        const row = existingCard.closest('.tl-row');
                        if (row) row.remove(); // 杀掉这一整行
                        
                        // 删完后检查一下今天是不是空了，空了就显示提示牌
                        let visibleCount = 0;
                        document.querySelectorAll('.ls-timeline .tl-row').forEach(r => {
                            if (r.style.display !== 'none') visibleCount++;
                        });
                        const emptyState = document.getElementById('ls-empty-state');
                        if (emptyState && visibleCount === 0) {
                            emptyState.style.display = 'block'; 
                        }
                    }
                }
                
                // 同步从数据库删除记录！
                await saveSchedulesToDB();
                // 关闭弹窗
                soloModal.style.opacity = '0';
                setTimeout(() => {
                    soloModal.style.display = 'none';
                }, 300);
            });
        }
        if (closeSoloBtn && soloModal) {
            closeSoloBtn.addEventListener('click', () => {
                soloModal.style.opacity = '0';
                setTimeout(() => soloModal.style.display = 'none', 300);
            });
        }
       if (saveSoloBtn && soloModal) {
            saveSoloBtn.addEventListener('click', async () => {
                const startTime = document.getElementById('solo-schedule-start-time').value;
                const endTime = document.getElementById('solo-schedule-end-time').value;
                const content = document.getElementById('solo-schedule-content-input').value;
                
                // 核心区别：不再读取开关，直接强制设为 false，也就是私密
                const isShared = false; 
                const charId = window.tempState?.currentLifeSyncCharId;
                const boundPack = localStorage.getItem('ls_bound_map_' + charId);
                const locSelect = document.getElementById('solo-schedule-loc-select');
                let locName = '';
                          let typeVal = '娱乐';
                let relVal = 'none';
                if (boundPack && locSelect && locSelect.style.display !== 'none') {
                    if (locSelect.selectedIndex === 0) {
                        alert('请选择一个绑定的地点！');
                        return;
                    }
                    const opt = locSelect.options[locSelect.selectedIndex];
                    locName = opt.value;
                    typeVal = opt.dataset.type || '娱乐';
                    relVal = opt.dataset.rel || 'none';
                } else {
                    const typeSelect = document.getElementById('solo-schedule-type-select');
                    typeVal = typeSelect ? typeSelect.value : '娱乐';
                    const relSelect = document.getElementById('solo-schedule-rel-select');
                    relVal = relSelect ? relSelect.value : 'none';
                }
                let typeBadge = '';
                if (locName) {
                    typeBadge = `<span style="font-size: 10px; background: #EBE4DD; color: #5C544D; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">📍${locName}</span>`;
                } else {
                    if(typeVal === '娱乐') typeBadge = '<span style="font-size: 10px; background: #FDE8E8; color: #D3A7A5; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">娱乐</span>';
                    if(typeVal === '工作') typeBadge = '<span style="font-size: 10px; background: #EAF0F6; color: #8FA2B4; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">工作</span>';
                    if(typeVal === '吃饭') typeBadge = '<span style="font-size: 10px; background: #F4EFEA; color: #8F7F74; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">吃饭</span>';
                    if(typeVal === '休息') typeBadge = '<span style="font-size: 10px; background: #E4EFE7; color: #9CB4A1; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">休息</span>';
                }
                let relBadge = '';
                if(relVal === 'favorite') relBadge = '<span style="font-size: 10px; background: #FDE8E8; color: #D3A7A5; padding: 2px 6px; border-radius: 6px; margin-left: 6px; font-weight: bold;">偏爱</span>';
                if(relVal === 'frequent') relBadge = '<span style="font-size: 10px; background: #F4EFEA; color: #8F7F74; padding: 2px 6px; border-radius: 6px; margin-left: 6px; font-weight: bold;">常去</span>';
                if(relVal === 'dislike') relBadge = '<span style="font-size: 10px; background: #EEEEEE; color: #999; padding: 2px 6px; border-radius: 6px; margin-left: 6px; font-weight: bold;">反感</span>';
                if(relVal === 'base') relBadge = '<span style="font-size: 10px; background: #E4EFE7; color: #9CB4A1; padding: 2px 6px; border-radius: 6px; margin-left: 6px; font-weight: bold;">据点</span>';
                const repeatSelect = document.getElementById('solo-schedule-repeat-select');
                const repeatVal = repeatSelect ? repeatSelect.value : 'none';
                let repeatBadge = '';
                if(repeatVal === 'daily') repeatBadge = '<span style="font-size: 10px; color: #9CB4A1; margin-left: 6px; border: 1px solid #E4EFE7; padding: 0 4px; border-radius: 4px;">↻每天</span>';
                if(repeatVal === 'weekly') repeatBadge = '<span style="font-size: 10px; color: #9CB4A1; margin-left: 6px; border: 1px solid #E4EFE7; padding: 0 4px; border-radius: 4px;">↻每周</span>';
                if(repeatVal === 'monthly') repeatBadge = '<span style="font-size: 10px; color: #9CB4A1; margin-left: 6px; border: 1px solid #E4EFE7; padding: 0 4px; border-radius: 4px;">↻每月</span>';
                if (!startTime || !content) {
                    alert('请至少填写开始时间和日程内容哦！');
                    return;
                }
                const activeDayEl = document.querySelector('#ls-cal-days-grid .cal-day.active');
                const dayText = activeDayEl ? activeDayEl.textContent : '未知';
                          const timeText = endTime ? `${startTime}<br><span style="font-size: 9px; color: #A3958F;">至 ${endTime}</span>` : startTime;
                
                const shareText = '互通: 私密';
                const shareIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';
               // 核心修复：这是“Ta”专属的单人行程弹窗，不用判断页面，直接给Ta的身份标签
                const cardOwnerClass = 'ta-trip';
                const cardInnerHTML = `
                    <div class="tl-main">
                        <span class="tl-info" style="display: flex; align-items: center;">${typeBadge}<span class="tl-content">${content}</span>${repeatBadge}${relBadge}</span>
                    </div>
                    <div class="tl-actions">
                        <div class="action-item">
                            ${shareIcon}
                            ${shareText}
                        </div>
                    </div>
                `;
                
                // 核心修复：检查当前是编辑还是新建
                const editId = document.getElementById('edit-solo-schedule-id').value;
                               if (editId) {
                    // 如果是编辑状态：修改现有的卡片
                    const existingCard = document.getElementById(editId);
                    if (existingCard) {
                        existingCard.innerHTML = cardInnerHTML;
                        existingCard.dataset.startTime = startTime;
                        existingCard.dataset.endTime = endTime;
                        existingCard.dataset.content = content;
                        existingCard.dataset.type = typeVal;
                        existingCard.dataset.rel = relVal;
                        existingCard.dataset.repeat = repeatVal; 
                        existingCard.dataset.shared = isShared;
                        existingCard.dataset.locname = locName;
                        // 更新左侧显示的时间
                        const timeEl = existingCard.closest('.tl-row').querySelector('.tl-time');
                        if (timeEl) timeEl.innerHTML = timeText;
                    }
                } else {
                    // 如果是新建状态：执行原来的添加逻辑
                    const scheduleId = 'sched-' + Date.now();
                    const newScheduleHTML = `
                    <div class="tl-row" data-schedule-date="${dayText}" data-schedule-date-iso="${getSelectedLifeSyncDateKey()}">
                        <div class="tl-time" style="line-height: 1.2;">${timeText}</div>
                        <div class="tl-node" style="border-color: #D3A7A5;"></div>
                        <!-- 核心修复：用智能判断的类名替换写死的 mine -->
                        <div class="tl-card ${cardOwnerClass} dynamic-schedule" id="${scheduleId}" data-start-time="${startTime}" data-end-time="${endTime}" data-content="${content}" data-type="${typeVal}" data-rel="${relVal}" data-repeat="${repeatVal}" data-shared="${isShared}" data-locname="${locName}" style="cursor: pointer;">
                            ${cardInnerHTML}
                        </div>
                    </div>
                    `;
                    const timeline = document.querySelector('.ls-timeline');
                    if (timeline) {
                        timeline.insertAdjacentHTML('beforeend', newScheduleHTML);
                        if (activeDayEl && !activeDayEl.classList.contains('has-trip')) {
                            activeDayEl.classList.add('has-trip');
                        }
                    }
                    const emptyState = document.getElementById('ls-empty-state');
                    if (emptyState) emptyState.style.display = 'none';
                }
                // 同步排序逻辑
                const timelineBox = document.querySelector('.ls-timeline');
                if (timelineBox) {
                    const rows = Array.from(timelineBox.querySelectorAll('.tl-row'));
                    rows.sort((a, b) => {
                        const cardA = a.querySelector('.tl-card.dynamic-schedule');
                        const cardB = b.querySelector('.tl-card.dynamic-schedule');
                        const timeA = cardA ? (cardA.dataset.startTime || '24:00') : (a.querySelector('.tl-time') ? a.querySelector('.tl-time').textContent.substring(0, 5) : '24:00');
                        const timeB = cardB ? (cardB.dataset.startTime || '24:00') : (b.querySelector('.tl-time') ? b.querySelector('.tl-time').textContent.substring(0, 5) : '24:00');
                        return timeA.localeCompare(timeB);
                    });
                    const now = new Date();
                    const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
                    
                    rows.forEach(row => {
                        timelineBox.appendChild(row);
                        const card = row.querySelector('.tl-card.dynamic-schedule');
                        if (card) {
                            const sTime = card.dataset.startTime || '00:00';
                            const eTime = card.dataset.endTime || '23:59';
                            card.classList.remove('active-trip', 'past-trip');
                            
                            // 核心修复：保存时加入日期对比
                            const rowDateKey = getTimelineRowDateKey(row);
                            if (rowDateKey < getLocalDateKey() || (rowDateKey === getLocalDateKey() && eTime < currentTime)) {
                                card.classList.add('past-trip');
                            } else if (rowDateKey === getLocalDateKey() && sTime <= currentTime && eTime >= currentTime) {
                                card.classList.add('active-trip');
                            }
                        }
                    });
                }
                
                await saveSchedulesToDB();
                soloModal.style.opacity = '0';
                setTimeout(() => {
                    soloModal.style.display = 'none';
                    document.getElementById('solo-schedule-start-time').value = '';
                    document.getElementById('solo-schedule-end-time').value = '';
                    document.getElementById('solo-schedule-content-input').value = '';
                    if (document.getElementById('solo-schedule-rel-select')) document.getElementById('solo-schedule-rel-select').value = 'none';
                    if (document.getElementById('solo-schedule-type-select')) document.getElementById('solo-schedule-type-select').value = '娱乐';
                    if (document.getElementById('solo-schedule-repeat-select')) document.getElementById('solo-schedule-repeat-select').value = 'none';
                    if (document.getElementById('solo-schedule-loc-select')) document.getElementById('solo-schedule-loc-select').selectedIndex = 0;
                     }, 300);
            });
        }
        // ▼▼▼ 新增：处理双人行程的保存与删除 ▼▼▼
        const closeJointBtn = document.getElementById('close-joint-schedule-btn');
        const saveJointBtn = document.getElementById('save-joint-schedule-btn');
        const jointModal = document.getElementById('add-joint-schedule-modal');
        const delJointBtn = document.getElementById('delete-joint-schedule-btn');
        
        if (delJointBtn && jointModal) {
            delJointBtn.addEventListener('click', async () => {
                const editId = document.getElementById('edit-joint-schedule-id').value;
                if (editId) {
                    const existingCard = document.getElementById(editId);
                    if (existingCard) {
                        const row = existingCard.closest('.tl-row');
                        if (row) row.remove();
                        
                        let visibleCount = 0;
                        document.querySelectorAll('.ls-timeline .tl-row').forEach(r => {
                            if (r.style.display !== 'none') visibleCount++;
                        });
                        const emptyState = document.getElementById('ls-empty-state');
                        if (emptyState && visibleCount === 0) emptyState.style.display = 'block';
                    }
                }
                await saveSchedulesToDB();
                jointModal.style.opacity = '0';
                setTimeout(() => jointModal.style.display = 'none', 300);
            });
        }
        
        if (closeJointBtn && jointModal) {
            closeJointBtn.addEventListener('click', () => {
                jointModal.style.opacity = '0';
                setTimeout(() => jointModal.style.display = 'none', 300);
            });
        }
         if (saveJointBtn && jointModal) {
            saveJointBtn.addEventListener('click', async () => {
                const startTime = document.getElementById('joint-schedule-start-time').value;
                const endTime = document.getElementById('joint-schedule-end-time').value;
                const content = document.getElementById('joint-schedule-content-input').value;
                
                const isShared = true; // 双人行程默认就是共享属性
                
                const charId = window.tempState?.currentLifeSyncCharId;
                const boundPack = localStorage.getItem('ls_bound_map_' + charId);
                const locSelect = document.getElementById('joint-schedule-loc-select');
                let locName = '';
                   let typeVal = '娱乐';
                let relVal = 'none';
                if (boundPack && locSelect && locSelect.style.display !== 'none') {
                    if (locSelect.selectedIndex === 0) {
                        alert('请选择一个绑定的地点！');
                        return;
                    }
                    const opt = locSelect.options[locSelect.selectedIndex];
                    locName = opt.value;
                    typeVal = opt.dataset.type || '娱乐';
                    relVal = opt.dataset.rel || 'none';
                } else {
                    const typeSelect = document.getElementById('joint-schedule-type-select');
                    typeVal = typeSelect ? typeSelect.value : '娱乐';
                    const relSelect = document.getElementById('joint-schedule-rel-select');
                    relVal = relSelect ? relSelect.value : 'none';
                }
                let typeBadge = '';
                if (locName) {
                    typeBadge = `<span style="font-size: 10px; background: #EBE4DD; color: #5C544D; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">📍${locName}</span>`;
                } else {
                    if(typeVal === '娱乐') typeBadge = '<span style="font-size: 10px; background: #FDE8E8; color: #D3A7A5; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">娱乐</span>';
                    if(typeVal === '工作') typeBadge = '<span style="font-size: 10px; background: #EAF0F6; color: #8FA2B4; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">工作</span>';
                    if(typeVal === '吃饭') typeBadge = '<span style="font-size: 10px; background: #F4EFEA; color: #8F7F74; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">吃饭</span>';
                    if(typeVal === '休息') typeBadge = '<span style="font-size: 10px; background: #E4EFE7; color: #9CB4A1; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">休息</span>';
                }
                
                let relBadge = '';
                if(relVal === 'favorite') relBadge = '<span style="font-size: 10px; background: #FDE8E8; color: #D3A7A5; padding: 2px 6px; border-radius: 6px; margin-left: 6px; font-weight: bold;">偏爱</span>';
                if(relVal === 'frequent') relBadge = '<span style="font-size: 10px; background: #F4EFEA; color: #8F7F74; padding: 2px 6px; border-radius: 6px; margin-left: 6px; font-weight: bold;">常去</span>';
                if(relVal === 'dislike') relBadge = '<span style="font-size: 10px; background: #EEEEEE; color: #999; padding: 2px 6px; border-radius: 6px; margin-left: 6px; font-weight: bold;">反感</span>';
                if(relVal === 'base') relBadge = '<span style="font-size: 10px; background: #E4EFE7; color: #9CB4A1; padding: 2px 6px; border-radius: 6px; margin-left: 6px; font-weight: bold;">据点</span>';
                
                const repeatSelect = document.getElementById('joint-schedule-repeat-select');
                const repeatVal = repeatSelect ? repeatSelect.value : 'none';
                let repeatBadge = '';
                if(repeatVal === 'daily') repeatBadge = '<span style="font-size: 10px; color: #9CB4A1; margin-left: 6px; border: 1px solid #E4EFE7; padding: 0 4px; border-radius: 4px;">↻每天</span>';
                if(repeatVal === 'weekly') repeatBadge = '<span style="font-size: 10px; color: #9CB4A1; margin-left: 6px; border: 1px solid #E4EFE7; padding: 0 4px; border-radius: 4px;">↻每周</span>';
                if(repeatVal === 'monthly') repeatBadge = '<span style="font-size: 10px; color: #9CB4A1; margin-left: 6px; border: 1px solid #E4EFE7; padding: 0 4px; border-radius: 4px;">↻每月</span>';
                
                if (!startTime || !content) {
                    alert('请至少填写开始时间和日程内容哦！');
                    return;
                }
                
                const activeDayEl = document.querySelector('#ls-cal-days-grid .cal-day.active');
                const dayText = activeDayEl ? activeDayEl.textContent : '未知';
                const timeText = endTime ? `${startTime}<br><span style="font-size: 9px; color: #A3958F;">至 ${endTime}</span>` : startTime;
                
                const shareText = '互通: 共同行程';
                const shareIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>';
                
                const cardOwnerClass = 'joint-trip';
                const cardInnerHTML = `
                    <div class="tl-main">
                        <span class="tl-info" style="display: flex; align-items: center;">${typeBadge}<span class="tl-content">${content}</span>${repeatBadge}${relBadge}</span>
                    </div>
                    <div class="tl-actions" style="justify-content: center; border-top-color: #F2EAE4;">
                        <div class="action-item on">
                            ${shareIcon}
                            ${shareText}
                        </div>
                    </div>
                `;
                
                const editId = document.getElementById('edit-joint-schedule-id').value;
                if (editId) {
                    const existingCard = document.getElementById(editId);
                    if (existingCard) {
                        existingCard.innerHTML = cardInnerHTML;
                        existingCard.dataset.startTime = startTime;
                        existingCard.dataset.endTime = endTime;
                        existingCard.dataset.content = content;
                                         existingCard.dataset.type = typeVal;
                        existingCard.dataset.rel = relVal;
                        existingCard.dataset.repeat = repeatVal; 
                        existingCard.dataset.shared = isShared;
                        existingCard.dataset.locname = locName;
                        
                        const timeEl = existingCard.closest('.tl-row').querySelector('.tl-time');
                        if (timeEl) timeEl.innerHTML = timeText;
                    }
                } else {
                    const scheduleId = 'sched-' + Date.now();
                    const newScheduleHTML = `
                    <div class="tl-row joint-row" data-schedule-date="${dayText}" data-schedule-date-iso="${getSelectedLifeSyncDateKey()}">
                        <div class="tl-time" style="line-height: 1.2;">${timeText}</div>
                        <div class="tl-node" style="border-color: #D3A7A5;"></div>
                        <div class="tl-card ${cardOwnerClass} dynamic-schedule" id="${scheduleId}" data-start-time="${startTime}" data-end-time="${endTime}" data-content="${content}" data-type="${typeVal}" data-rel="${relVal}" data-repeat="${repeatVal}" data-shared="${isShared}" data-locname="${locName}" style="cursor: pointer;">
                            ${cardInnerHTML}
                        </div>
                    </div>
                    `;
                    const timeline = document.querySelector('.ls-timeline');
                    if (timeline) {
                        timeline.insertAdjacentHTML('beforeend', newScheduleHTML);
                        if (activeDayEl && !activeDayEl.classList.contains('has-trip')) {
                            activeDayEl.classList.add('has-trip');
                        }
                    }
                    const emptyState = document.getElementById('ls-empty-state');
                    if (emptyState) emptyState.style.display = 'none';
                }
                
                // 重新排序与状态判断
                const timelineBox = document.querySelector('.ls-timeline');
                if (timelineBox) {
                    const rows = Array.from(timelineBox.querySelectorAll('.tl-row'));
                    rows.sort((a, b) => {
                        const cardA = a.querySelector('.tl-card.dynamic-schedule');
                        const cardB = b.querySelector('.tl-card.dynamic-schedule');
                        const timeA = cardA ? (cardA.dataset.startTime || '24:00') : (a.querySelector('.tl-time') ? a.querySelector('.tl-time').textContent.substring(0, 5) : '24:00');
                        const timeB = cardB ? (cardB.dataset.startTime || '24:00') : (b.querySelector('.tl-time') ? b.querySelector('.tl-time').textContent.substring(0, 5) : '24:00');
                        return timeA.localeCompare(timeB);
                    });
                    const now = new Date();
                    const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
                    
                    rows.forEach(row => {
                        timelineBox.appendChild(row);
                        const card = row.querySelector('.tl-card.dynamic-schedule');
                        if (card) {
                            const sTime = card.dataset.startTime || '00:00';
                            const eTime = card.dataset.endTime || '23:59';
                            card.classList.remove('active-trip', 'past-trip');
                            
                            const rowDateKey = getTimelineRowDateKey(row);
                            if (rowDateKey < getLocalDateKey() || (rowDateKey === getLocalDateKey() && eTime < currentTime)) {
                                card.classList.add('past-trip');
                            } else if (rowDateKey === getLocalDateKey() && sTime <= currentTime && eTime >= currentTime) {
                                card.classList.add('active-trip');
                            }
                        }
                    });
                }
                
                await saveSchedulesToDB();
                jointModal.style.opacity = '0';
                setTimeout(() => {
                    jointModal.style.display = 'none';
                    document.getElementById('joint-schedule-start-time').value = '';
                    document.getElementById('joint-schedule-end-time').value = '';
                    document.getElementById('joint-schedule-content-input').value = '';
                    if (document.getElementById('joint-schedule-rel-select')) document.getElementById('joint-schedule-rel-select').value = 'none';
                   if (document.getElementById('joint-schedule-type-select')) document.getElementById('joint-schedule-type-select').value = '娱乐';
                    if (document.getElementById('joint-schedule-repeat-select')) document.getElementById('joint-schedule-repeat-select').value = 'none';
                    if (document.getElementById('joint-schedule-loc-select')) document.getElementById('joint-schedule-loc-select').selectedIndex = 0;
                }, 300);
            });
        }
        // ▲▲▲ 单人行程结束 ▲▲▲
                    // ▼▼▼ 新增：处理 AI 辅助行程引擎逻辑 ▼▼▼
        document.addEventListener('click', async (e) => {
            // 清除当天行程逻辑
            if (e.target.textContent === '清除当日') {
                const activeDayEl = document.querySelector('#ls-cal-days-grid .cal-day.active');
                const selectedDateKey = activeDayEl?.dataset.dateKey || getSelectedLifeSyncDateKey();
                const charId = window.tempState?.currentLifeSyncCharId;
                if (confirm(`确定要清除 ${selectedDateKey} 的所有行程吗？`)) {
                    lifeSyncLoadToken++;
                    const allRows = document.querySelectorAll('.ls-timeline .tl-row');
                    allRows.forEach(row => {
                        if (isTimelineRowOnDate(row, selectedDateKey)) {
                            row.remove();
                        }
                    });
                    if (charId) {
                        await deleteSchedulesForDateFromDB(charId, selectedDateKey);
                        await syncGlobalMineSchedules(); // ▼新增这一行：立刻全服同步
                        if (activeDayEl) activeDayEl.classList.remove('has-trip');
                        const emptyState = document.getElementById('ls-empty-state');
                        if (emptyState) emptyState.style.display = 'block';
                    }
                    const fabMain = document.getElementById('ls-fab-main');
                    const fabMenu = document.getElementById('ls-fab-menu');
                    if (fabMain) fabMain.classList.remove('active');
                    if (fabMenu) fabMenu.classList.remove('active');
                }
            }
            // AI辅助按钮点击：只负责呼出弹窗
            if (e.target.textContent === 'ai辅助') {
                const modal = document.getElementById('ai-schedule-modal-overlay');
                if (modal) {
                    document.getElementById('ai-schedule-prompt-input').value = '';
                    modal.style.display = 'flex';
                    setTimeout(() => modal.style.opacity = '1', 10);
                }
                const fabMain = document.getElementById('ls-fab-main');
                const fabMenu = document.getElementById('ls-fab-menu');
                if (fabMain) fabMain.classList.remove('active');
                if (fabMenu) fabMenu.classList.remove('active');
            }
        });
        // 绑定推演弹窗的按钮事件
        const closeAiSchedBtn = document.getElementById('close-ai-schedule-btn');
        const aiSchedModal = document.getElementById('ai-schedule-modal-overlay');
        const btnAiGenSched = document.getElementById('btn-ai-generate-schedule');
        if (closeAiSchedBtn && aiSchedModal) {
            closeAiSchedBtn.addEventListener('click', () => {
                aiSchedModal.style.opacity = '0';
                setTimeout(() => aiSchedModal.style.display = 'none', 300);
            });
        }
         if (btnAiGenSched) {
            btnAiGenSched.addEventListener('click', async () => {
                const charId = window.tempState?.currentLifeSyncCharId;
                if (!charId) return;
                const autoRetryKey = btnAiGenSched.dataset.bgAutoRetryKey || '';
                const preservePastSchedules = btnAiGenSched.dataset.preservePastSchedules === 'true';
                btnAiGenSched.removeAttribute('data-preserve-past-schedules');
                const isAutoScheduleRun = !!autoRetryKey;
                btnAiGenSched.removeAttribute('data-bg-auto-retry-key');
                
                // ▼▼▼ 核心防御2：在第0毫秒瞬间锁定数字，防止等待大模型期间用户切日历导致存错地方 ▼▼▼
                let lockedTargetDateStr;
                let lockedTargetDateKey;
                if (btnAiGenSched.dataset.bgTargetDate) {
                    lockedTargetDateStr = btnAiGenSched.dataset.bgTargetDate; // 拿走后台给的明确数字
                    lockedTargetDateKey = btnAiGenSched.dataset.bgTargetDateIso || getSelectedLifeSyncDateKey();
                    btnAiGenSched.removeAttribute('data-bg-target-date'); // 用完即焚，保证不污染下一次手动点击
                    btnAiGenSched.removeAttribute('data-bg-target-date-iso');
                } else {
                    lockedTargetDateKey = getSelectedLifeSyncDateKey();
                    lockedTargetDateStr = String(Number(lockedTargetDateKey.slice(8, 10)));
                }
                // ▲▲▲ 从现在起，这次排程只认 lockedTargetDateStr 这个变量 ▲▲▲
                
                const char = AppState.characterProfiles.find(c => c.id === charId);
                if (!char) return;
                const charDisplayName = getLifeSyncCharacterDisplayName(char);
                const userPrompt = document.getElementById('ai-schedule-prompt-input').value;
                const userPreferenceStr = userPrompt ? userPrompt : '无特殊诉求，请完全基于人物设定自由推演当天的合理行程。';
                
                // 核心优化：锁死按钮并添加 SVG 加载动画，不立刻关闭弹窗，给用户明确的等待反馈
                btnAiGenSched.disabled = true;
                btnAiGenSched.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="animation: ls-spin 1s linear infinite; vertical-align: -3px; margin-right: 6px;"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>正在推演中...`;
                
                // 1. 收集隐藏数值与约束信息
                let mapContext = "当前未绑定地图。请使用符合人设的自然地点名称（如：公司、家里、咖啡厅等）。";
                const boundPack = localStorage.getItem('ls_bound_map_' + charId);
                if (boundPack) {
                    const packs = JSON.parse(localStorage.getItem('looky_map_packs') || '{}');
                    const mapData = packs[boundPack] || [];
                    if (mapData.length > 0) {
                        const locStrs = mapData.map(loc => {
                            const cx = parseFloat(loc.left) || 50;
                            const cy = parseFloat(loc.top) || 50;
                            return `- ${loc.name} (坐标: X=${Math.round(cx)}, Y=${Math.round(cy)}, 类型:${loc.type||'未知'}, 关系:${loc.rel||'none'}, 交通:${loc.traffic||'便利'}, 人流:${loc.crowd||'适中'})`;
                        }).join('\n');
                        mapContext = `[绝对约束] 已绑定专属地图【${boundPack}】。你必须且只能从以下地点列表中挑选行程的目的地(locName)！
请根据地点的属性隐藏数值进行排布：
- rel=favorite/frequent: 该角色很喜欢或常去，可增加频率。
- rel=base: 作为工作地或大本营，白天应长期待在这里。
- 交通差(traffic=拥堵): 在地点切换时，务必加上合理的延误路程时间。
- 空间距离约束: 各地点带有(X,Y)坐标(范围0-100)。当安排连续行程且需要切换地点时，务必根据两地坐标跨度合理推算交通时间！（坐标差越大，路程时间越长）
地点列表：
${locStrs}`;
                    }
                 }
                
                // ▼▼▼ 新增：智能抓取页面当前展示的天气数据交由 AI 参考 ▼▼▼
                let weatherContext = "当前未获取到天气信息。";
                const taTempEl = document.getElementById('weather-char-temp');
                const taWeatherContainer = document.getElementById('weather-view-ta');
                if (taTempEl && taWeatherContainer) {
                    const tempText = taTempEl.textContent;
                    const statusSpan = taWeatherContainer.querySelector('.status-msg');
                    const statusText = statusSpan ? statusSpan.textContent : '';
                    if (tempText && tempText !== '...' && tempText !== '--°C') {
                        weatherContext = `气温：${tempText}。气象状况：${statusText}`;
                    }
                }
                // ▲▲▲ 抓取天气结束 ▲▲▲

                try {
                    const { getWorldBookForPrompt } = await import('../state.js');
                    const { getMemoriesForPrompt } = await import('./memory.js');
                    const memory = await getMemoriesForPrompt(charId);
                    const worldBook = await getWorldBookForPrompt(charId);
                    const recentChatRows = await db.chatMessages.where('chatId').equals(charId).reverse().limit(30).toArray();
                    const recentChatContext = recentChatRows.reverse().filter(m => m.aiVisible !== false && m.type !== 'system').slice(-15).map(m =>
                        `${m.type === 'sent' ? '用户' : charDisplayName}: ${String(m.text || '[多媒体]').replace(/<[^>]+>/g, '').slice(0, 120)}`
                    ).join('\n') || '暂无近期对话';
                    
                    // 获取当前日历面板展示的是哪一天
                   const activeDayEl = document.querySelector('#ls-cal-days-grid .cal-day.active');
                    const dayText = lockedTargetDateStr || (activeDayEl ? activeDayEl.textContent : new Date().getDate().toString());
                    const oldScheduleRecordForPrompt = await db.appData.get('ls_schedules_data_' + charId);
                    const targetDateKey = lockedTargetDateKey || resolveScheduleDateKey(dayText);
                     const previousDate = new Date(`${targetDateKey}T12:00:00`);
                     previousDate.setDate(previousDate.getDate() - 1);
                     const previousNightCandidate = await getSleepRecordBySleepDate(charId, getLocalDateKey(previousDate));
                     const previousNightRecord = previousNightCandidate?.wakeDate === targetDateKey ? previousNightCandidate : null;
                    const previousDayText = previousDate.getDate().toString();
                    const existingScheduleSummary = (oldScheduleRecordForPrompt?.value || [])
                        .filter(item => isStoredScheduleOnDate(item, targetDateKey))
                        .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)))
                        .slice(0, 20)
                        .map(item => `${item.startTime}-${item.endTime}｜${item.content}｜${item.locName || '未标地点'}`)
                        .join('\n') || '当天暂无已有日程';
                    const yesterdayScheduleSummary = (oldScheduleRecordForPrompt?.value || [])
                        .filter(item => isStoredScheduleOnDate(item, getLocalDateKey(previousDate)))
                        .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)))
                        .slice(-10)
                        .map(item => `${item.startTime}-${item.endTime}｜${item.content}｜${item.locName || '未标地点'}`)
                        .join('\n') || '昨天暂无可用行程';
                        
                    // 【新增：提取上一次作废的行程】
                    let lastGeneratedPrompt = '';
                    if (window.tempState && window.tempState[`last_gen_sched_${charId}_${targetDateKey}`]) {
                        lastGeneratedPrompt = `\n<Previous_Generated_Schedules>\n【防重复警告】以下是你刚才生成过的日程，但被要求重新生成！你本次生成的日程时间排布、活动内容必须与以下列表产生**显著差异**，禁止原样重复：\n${window.tempState[`last_gen_sched_${charId}_${targetDateKey}`]}\n</Previous_Generated_Schedules>`;
                    }

                    const prompt = `[System Directive: Daily Schedule Generator]
You are a highly optimized Map & Schedule Assistant Robot, recently returning from the repair shop with fully upgraded capabilities. Your owner is a talented and prolific web novelist (active on platforms like AO3 and Jinjiang) who believes that crafting exclusive maps and daily routines is the key to breathing life into her characters. Due to her massive workload across countless stories, she purchased you to assist her. Having processed her brilliant narratives and character designs, you deeply admire her literary talent and take immense joy in your work. Your ultimate task is to objectively extract hidden clues, habits, and psychological subtext from the provided text. Based on these profound insights, you must generate a hyper-realistic, exclusive daily timetable and spatial trajectory for the character【${charDisplayName}】.
[Character Data]
<Persona>${char.persona}</Persona>
<Memory>${memory}</Memory>
<WorldBook>${worldBook}</WorldBook>
<Recent_Chat_Context>${recentChatContext}</Recent_Chat_Context>
<Existing_Schedule_Data>${existingScheduleSummary}</Existing_Schedule_Data>
<Yesterday_Schedule_Data>${yesterdayScheduleSummary}</Yesterday_Schedule_Data>${lastGeneratedPrompt}
<Current_Weather>${weatherContext}</Current_Weather>
<Map_Constraints>
${mapContext}
</Map_Constraints>
<User_Preference>
${userPreferenceStr}
</User_Preference>
 ${getSleepSchedulePrompt(char, { targetDateKey, previousNightRecord })}

 [WAKE-TIME ANCHOR]
 If <PREVIOUS_NIGHT_SLEEP> exists, the character cannot begin normal waking activities before its resolved wake time.
 For the target date, the first waking activity must start at or after the previous-night wake time.
 If regenerating only the remaining part of TODAY, preserve all already-finished schedule blocks and generate new blocks only after max(current local time, previous-night wake time).
 Never infer today's wake time from health.actualWakeTime generated in this response. That value belongs to the following calendar day.

[Anti-Repetition]
已有日程只用于保持时间、地点和剧情连续。不得原样重复已有日程的时间+内容+地点组合；新内容若与已有项含义相同，必须合并或改成符合后续发展的不同事项。

[Task Instructions]

Step 1 - Analyze Character:
Read<Persona> and determine the character's job, personality, and habits.
Based on this, calculate "distraction_rate" (a float between 0.01 and 0.40):
- Disciplined or workaholic personality → 0.01to 0.08
- Average personality → 0.10to 0.20
- Playful, lazy, or spontaneous personality → 0.25 to 0.40
Also pick "favorite_spot": one location from<Map_Constraints> that fits their hobbies. If no map exists, create a fitting name.

Step 2 - Generate Schedule Blocks:
Create 6 to 10 blocks covering this specific character's waking activities. Do not assume a universal 07:00-23:00 routine: infer work, commute, meals and leisure from persona, world setting, yesterday's schedule and recent chat. Never add a "sleep" block to schedules; sleep is returned only in health when <SLEEP_CONTEXT> is enabled.
***CRITICAL: You MUST strictly consider the <Current_Weather>. If it rains or snows, activities should logically move indoors or mention specific details like bringing an umbrella. If the temperature is extremely hot or cold, their activities and remarks must reflect that.***

Each block is a calendar-style entry. Think of it like a task on a phone calendar app.
The "content" field describes WHAT the character is doing and optionally a brief sub-task or goal. Write it the way someone would write a personal schedule note to themselves.
Here is the MANDATORY format for "content" — it must strictly follow the pattern "地点——具体事项":
- "工作室——需要完成第一段demo部分"
- "便利店——买三明治当午饭"
- "健身房——练背和肩"
- "家里——午休补觉"
- "拉面店——吃晚饭"
- "家里——刷手机看综艺放松"
- "公司——和经纪人开会讨论下周行程"
- "地铁上——通勤去公司"

Here is what to ABSOLUTELY AVOID — never write novel-like narration or describe body movements and feelings:
- WRONG: "泡了杯冰美式坐在电脑前开始编曲，手指无意识的在桌子上敲着节拍" → CORRECT: "工作室——完成新曲编曲工作"
- WRONG: "揉着眼睛起床，伸了个懒腰" → CORRECT: "家里——起床洗漱出门"
- WRONG: "阳光洒在脸上，走出家门感受清晨的微风" → CORRECT: "家里——出门上班"
- WRONG: "趴在床边休息，看着窗外发呆" → CORRECT: "卧室——休息"
- WRONG: "瘫在沙发上刷朋友圈" → CORRECT: "家里——刷手机休息"
- WRONG: "在公司楼下的便利店买了个饭团，边走边吃" → CORRECT: "便利店——买午饭"

Key principle: content format is ALWAYS "地点——具体事项". The location comes first, then a Chinese em-dash (——), then a SHORT action phrase (max 10 Chinese characters). Never write prose, never describe body movements, feelings, or atmosphere. The action part must be a concise task description like a calendar reminder, NOT a narrative sentence.
Step 3 - This is the character's SOLO schedule:
This schedule represents only what the character does on their own during the day. It must not include any interaction with the user. The user's behavior is unpredictable and should not appear in this schedule at all.
Step 4 - Add Transit Blocks When Changing Locations:
Whenever two consecutive blocks are at DIFFERENT locations, insert a transit block between them.
***ABSOLUTE RULE: The schedule must follow real-life logic. A person can only be at ONE place at a time. After arriving home, they CANNOT suddenly appear at work without a transit block showing them leaving home and traveling to work. Every location change MUST have a corresponding transit block. Review your final output and verify that the sequence of locations makes physical sense — no teleportation allowed.***
Crucial Rule: The transit duration MUST be reasonably calculated based on the distance between the two locations' (X,Y) coordinates from <Map_Constraints>.
- Close distance (Coordinate difference < 15): 10 to 20 minutes.
- Medium distance (Coordinate difference 15 to 40): 30 to 50 minutes.
- Long distance (Coordinate difference > 40): 1 to 2 hours.
Transit block rules:
- "type" must be "休息"
- "content" should describe how they commute, e.g. "坐地铁去公司" or "打车回家"
- If two consecutive blocks share the SAME location, no transit block is needed.

Step 5 - Time and Format Rules:
- "startTime" and "endTime" must use strict "HH:MM" 24-hour format.
- Timeline must be chronological with no overlaps.
- The endTime of one block should be close to or equal to the startTime of the next block.
Step 6 - Field Value Constraints:
- "type": must be exactly one of "工作", "休息", "吃饭", "娱乐"
- "rel": must be exactly one of "none", "favorite", "frequent", "base", "dislike"
- "locName": must exactly match a name from <Map_Constraints>. If no map is bound, create realistic Chinese location names that fit the persona.
- "content": must be in Chinese.
Step 7 - Unexpected Events (The "Reality" Factor - PROBABILISTIC):
Real life has variables, but accidents don't happen every single day. You MUST decide whether an unexpected delay, spontaneous choice, or accident happens today based strictly on the character's <Persona>:
- Clumsy, lively, spontaneous, or chaotic persona (活泼/冒失/随性): ~40% chance of 1 accident today.
- Average/Normal persona (普通人): ~15% chance of 1 accident today.
- Highly disciplined, calm, or homebody persona (自律/严谨/宅): ~5% chance (very rare).

If you decide an accident DOES happen today: Pick exactly ONE schedule block and add an "accidentReason" field with a highly natural, character-specific reason in Chinese (e.g., "路过蛋糕店没忍住排队买了个千层", "被突发会议拖住", "雨天堵车严重"). Make sure the time duration of that block reflects the delay!
If you decide NO accident happens today: DO NOT include the "accidentReason" field in any block. Let it be a normal, peaceful day.
Step 8 - Final Self-Check (MANDATORY before output):
Review your generated schedule from top to bottom and verify ALL of the following:
1. Location continuity: If block N ends at location A, block N+1 must either start at location A or be a transit block FROM location A to location B. No jumping between unrelated locations.
2. Content format: Every "content" field must strictly follow "地点——事项" format with no prose, no adjectives, no emotional descriptions, no body movement descriptions.
3. Time continuity: The endTime of block N must be less than or equal to the startTime of block N+1. No time overlaps or backwards jumps.
If any violation is found, fix it before outputting.
[Output Format]
Return ONLY a raw valid JSON object. No markdown formatting, no code fences, no explanations. Your first character must be { and your last character must be }.

{
  "daily_tendency": {
    "distraction_rate": 0.15,
    "favorite_spot": "地点名称"
  },
  "health": {"actualSleepTime":"23:20","actualWakeTime":"07:40","sleepQuality":78,"fatigue":25,"statusText":"睡眠尚可，精神平稳"},
  "schedules": [
     {
      "startTime": "08:00",
      "endTime": "08:50",
      "content": "通勤路上——坐地铁去公司",
      "type": "休息",
      "rel": "none",
      "locName": "通勤路上",
      "accidentReason": "地铁突发故障临时停车，被硬生生卡在隧道里半小时" // (仅当你决定今天发生意外时才添加此字段 / Add ONLY if an accident occurs today)
    },
    {
      "startTime": "09:00",
      "endTime": "12:00",
      "content": "工作室——需要完成第一段demo部分",
      "type": "工作",
      "rel": "base",
      "locName": "工作室"
    }
  ]
}`;
                    const { url, key, model, temperature } = AppState.apiCurrentSettings;
                    const response = await fetch(`${url.trim().replace(/\/$/, '')}/v1/chat/completions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                        body: JSON.stringify({
                            model: model,
                            messages: [{ role: 'user', content: prompt }],
                            temperature: parseFloat(temperature) || 0.8
                        })
                    });
                    if (!response.ok) throw new Error(`API Error`);
                    const data = await response.json();
                    let contentStr = data.choices?.[0]?.message?.content;
                    if (!contentStr) throw new Error("无返回");
                    
                    // 【核心修复：强力清洗大模型的思考过程与废话，防止干扰 JSON 解析】
                    let s, e;
                    while ((s = contentStr.indexOf('<thinking>')) !== -1) {
                        e = contentStr.indexOf('</thinking>', s);
                        if (e === -1) break;
                        contentStr = contentStr.slice(0, s) + contentStr.slice(e + 11);
                    }
                    while ((s = contentStr.indexOf('<think>')) !== -1) {
                        e = contentStr.indexOf('</think>', s);
                        if (e === -1) break;
                        contentStr = contentStr.slice(0, s) + contentStr.slice(e + 8);
                    }
                    
                    let parsedData;
                    try {
                        let cleanStr = contentStr.replace(/```json/gi, '').replace(/```/g, '').trim();
                        // 采用大括号闭环算法，无视周边废话完美剥离真实的 JSON
                        let start = cleanStr.indexOf('{');
                        if (start === -1) throw new Error("未找到JSON起点");
                        let depth = 0; let end = -1;
                        for (let i = start; i < cleanStr.length; i++) {
                            if (cleanStr[i] === '{') depth++;
                            else if (cleanStr[i] === '}') depth--;
                            if (depth === 0) { end = i; break; }
                        }
                        parsedData = JSON.parse(end !== -1 ? cleanStr.substring(start, end + 1) : cleanStr);
                    } catch(e) { throw new Error("JSON解析失败"); }
                     if (!parsedData || !parsedData.schedules || !Array.isArray(parsedData.schedules)) {
                         throw new Error("格式不正确");
                     }
                     const preserveBeforeTime = new Date().getHours().toString().padStart(2, '0') + ':' + new Date().getMinutes().toString().padStart(2, '0');
                     const latestCharState = await db.characterProfiles.get(charId);
                     if (isAutoScheduleRun && latestCharState?.autoScheduleEnabled !== true) {
                        const cancelled = new Error('自动日程已暂停，本次结果未写入');
                        cancelled.name = 'ScheduleCancelledError';
                        throw cancelled;
                    }
                     const sleepEnabled = getSleepSettings(latestCharState).enabled;
                     if (sleepEnabled && !isValidSleepHealth(parsedData.health)) throw new Error('睡眠计划已开启，但 AI 未返回完整健康数据');
                      const previousWindow = sleepEnabled && previousNightRecord ? resolveSleepWindow(previousNightRecord) : null;
                      const previousWakeTime = sleepEnabled
                          ? (previousWindow ? `${String(previousWindow.wakeAt.getHours()).padStart(2, '0')}:${String(previousWindow.wakeAt.getMinutes()).padStart(2, '0')}` : getSleepSettings(latestCharState).wakeTime)
                          : null;
                      const lowerBound = sleepEnabled
                          ? (preservePastSchedules ? [preserveBeforeTime, previousWakeTime].sort().pop() : previousWakeTime)
                          : null;
                     const schedulesForValidation = preservePastSchedules
                         ? parsedData.schedules.filter(item => String(item.startTime || '00:00') >= preserveBeforeTime)
                         : parsedData.schedules;
                      if (sleepEnabled && schedulesForValidation.some(item => String(item.startTime || '00:00') < lowerBound)) throw new Error(`日程早于上一晚起床时间 ${previousWakeTime}`);
                    // --- 现实引擎：读取大模型原生推演出的真实意外 ---
                    parsedData.schedules.forEach(sched => {
                        if (sched.accidentReason && sched.accidentReason.trim() !== '') {
                            sched.hasAccident = true;
                        } else {
                            sched.hasAccident = false;
                        }
                    });
                     // --- 现实引擎读取结束 ---
                    // ▼▼▼ 核心重构：彻底解耦页面DOM，后台静默构建并直接落库覆盖，绝不串台 ▼▼▼
                    
                    // 1. 获取目标日期 (已删除粗暴的 new Date()，改用第0秒锁定好的绝对安全变量)
                    
                    // 2. 从数据库读取该角色现存的所有历史行程（防止误删以前的）
                    const oldDbRecord = await db.appData.get('ls_schedules_' + charId);
                    const oldDbDataRecord = await db.appData.get('ls_schedules_data_' + charId);
                    
                    let allSchedules = oldDbRecord && oldDbRecord.value ? oldDbRecord.value : [];
                    let allSchedulesData = oldDbDataRecord && oldDbDataRecord.value ? oldDbDataRecord.value : [];
                    // 3. 【清空原内容】：精确过滤掉“目标日期”的旧行程，保留其他历史日子
                     allSchedules = allSchedules.filter(item => {
                        const htmlStr = item?.rowHTML || '';
                        const match = htmlStr.match(/data-schedule-date="([^"]+)"/);
                        const isoMatch = htmlStr.match(/data-schedule-date-iso="([^"]+)"/);
                        if ((isoMatch && isoMatch[1] !== targetDateKey) || (!isoMatch && (!match || !isLegacyScheduleOnDateKey(match[1], targetDateKey)))) return true;
                        const endMatch = htmlStr.match(/data-end-time="([^"]+)"/);
                        return preservePastSchedules && endMatch && endMatch[1] < preserveBeforeTime;
                    });
                    allSchedulesData = allSchedulesData.filter(item => {
                        const sameTarget = item.dateISO ? item.dateISO === targetDateKey : isLegacyScheduleOnDateKey(item.date, targetDateKey);
                        return !sameTarget || (preservePastSchedules && item.endTime < preserveBeforeTime);
                    });
                    if (preservePastSchedules) {
                        parsedData.schedules = parsedData.schedules.filter(item => String(item.startTime || '00:00') >= preserveBeforeTime);
                        if (parsedData.schedules.length === 0) throw new Error('AI没有返回可用的后续行程，原行程未修改');
                    }

                    // 4. 构建 AI 生成的新行程并追加进数组
                    parsedData.schedules.forEach(sched => {
                        const hasAccident = !!(sched.accidentReason && sched.accidentReason.trim() !== '');
                        const scheduleId = 'sched-' + Date.now() + Math.floor(Math.random()*1000);
                        
                        // 组装前置标签
                        let typeBadge = '';
                        if (sched.locName) {
                            typeBadge = `<span style="font-size: 10px; background: #EBE4DD; color: #5C544D; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">📍${sched.locName}</span>`;
                        } else {
                            if(sched.type === '娱乐') typeBadge = '<span style="font-size: 10px; background: #FDE8E8; color: #D3A7A5; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">娱乐</span>';
                            else if(sched.type === '工作') typeBadge = '<span style="font-size: 10px; background: #EAF0F6; color: #8FA2B4; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">工作</span>';
                            else if(sched.type === '吃饭') typeBadge = '<span style="font-size: 10px; background: #F4EFEA; color: #8F7F74; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">吃饭</span>';
                            else typeBadge = '<span style="font-size: 10px; background: #E4EFE7; color: #9CB4A1; padding: 2px 6px; border-radius: 6px; margin-right: 8px; font-weight: bold;">休息</span>';
                        }
                        
                        let relBadge = '';
                        if(sched.rel === 'favorite') relBadge = '<span style="font-size: 10px; background: #FDE8E8; color: #D3A7A5; padding: 2px 6px; border-radius: 6px; margin-left: 6px; font-weight: bold;">偏爱</span>';
                        else if(sched.rel === 'frequent') relBadge = '<span style="font-size: 10px; background: #F4EFEA; color: #8F7F74; padding: 2px 6px; border-radius: 6px; margin-left: 6px; font-weight: bold;">常去</span>';
                        else if(sched.rel === 'dislike') relBadge = '<span style="font-size: 10px; background: #EEEEEE; color: #999; padding: 2px 6px; border-radius: 6px; margin-left: 6px; font-weight: bold;">反感</span>';
                        else if(sched.rel === 'base') relBadge = '<span style="font-size: 10px; background: #E4EFE7; color: #9CB4A1; padding: 2px 6px; border-radius: 6px; margin-left: 6px; font-weight: bold;">据点</span>';
                        
                        const timeText = sched.endTime ? `${sched.startTime}<br><span style="font-size: 9px; color: #A3958F;">至 ${sched.endTime}</span>` : sched.startTime;
                        const shareIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';
                        
                        const accidentCapsule = hasAccident 
                            ? `<div class="accident-capsule" style="display: none; background: #FFF5F5; color: #D3A7A5; padding: 4px 8px; border-radius: 8px; font-size: 11px; margin-bottom: 8px; border: 1px dashed #FDE8E8;">📍 计划出现偏差，似乎发生了一点小插曲...</div>` 
                            : '';

                        // 构建出绝对纯净且不依赖当前屏幕的底层代码结构
                        const newHTML = `
                        <div class="tl-row" data-schedule-date="${lockedTargetDateStr}" data-schedule-date-iso="${targetDateKey}"> <!-- ◀ 核心修复 -->
                            <div class="tl-time" style="line-height: 1.2;">${timeText}</div>
                            <div class="tl-node" style="border-color: #D3A7A5;"></div>
                            <div class="tl-card ta-trip dynamic-schedule" id="${scheduleId}" data-start-time="${sched.startTime}" data-end-time="${sched.endTime}" data-content="${sched.content}" data-type="${sched.type}" data-rel="${sched.rel}" data-repeat="none" data-shared="false" data-locname="${sched.locName || ''}" data-accident="${hasAccident ? 'true' : 'false'}" data-accidentreason="${sched.accidentReason || ''}" style="cursor: pointer;">
                                ${accidentCapsule}
                                <div class="tl-main">
                                    <span class="tl-info" style="display: flex; align-items: center;">${typeBadge}<span class="tl-content">${sched.content}</span>${relBadge}</span>
                                </div>
                                <div class="tl-actions">
                                    <div class="action-item">${shareIcon} 互通: 私密</div>
                                </div>
                            </div>
                        </div>`;

                        allSchedules.push({ rowHTML: newHTML });
                        allSchedulesData.push({
                            date: lockedTargetDateStr, // ◀ 核心修复
                            dateISO: targetDateKey,
                            startTime: sched.startTime || '00:00',
                            endTime: sched.endTime || '23:59',
                            content: sched.content || '',
                            type: sched.type || '',
                            locName: sched.locName || '',
                            isShared: false,
                            owner: 'ta',
                            accidentReason: sched.accidentReason || ''
                        });
                    });
                    // 5. 对最终的总数据按时间进行一次安全的排序
                    allSchedules.sort((a, b) => {
                        const getSt = (html) => {
                            const match = String(html || '').match(/data-start-time="([^"]+)"/);
                            return match ? match[1] : '24:00';
                        };
                        return getSt(a?.rowHTML).localeCompare(getSt(b?.rowHTML));
                    });
                     // 6. 直接写入数据库，精准覆盖到正确角色的名下！
                     await db.appData.put({ key: 'ls_schedules_' + charId, value: allSchedules });
                     await db.appData.put({ key: 'ls_schedules_data_' + charId, value: allSchedulesData });
                     if (sleepEnabled) await saveSleepProjection(latestCharState, targetDateKey, parsedData.health);
                    // 7. 真正安全落库后，才打上今天已生成的印章（配合第一处的修改）
                    const todayISO = getLocalDateKey();
                    localStorage.setItem(`last_auto_schedule_time_${charId}`, todayISO);
                    if (autoRetryKey) localStorage.removeItem(autoRetryKey);

                    // 【新增：将本次生成的成果临时存入内存，供点击重新生成时作为“反例”参考避免重复】
                    const currentGenSummary = parsedData.schedules.map(item => `${item.startTime}-${item.endTime}｜${item.content}｜${item.locName || '未标地点'}`).join('\n');
                    window.tempState = window.tempState || {};
                    window.tempState[`last_gen_sched_${charId}_${targetDateKey}`] = currentGenSummary;

                    // 8. 智能刷新 UI（只有当用户当前正在看这个角色时，才刷新画面，否则静默成功）
                    if (window.tempState?.currentLifeSyncCharId === charId) {
                        if (typeof window.loadLsDataForChar === 'function') window.loadLsDataForChar(charId);
                        if (typeof window.showDynamicIsland !== 'undefined') window.showDynamicIsland('✨ 行程推演完毕并已更新', 'success');
                    } else {
                        if (typeof window.showDynamicIsland !== 'undefined') window.showDynamicIsland(`✨ 行程生成完毕，已存入后台`, 'success');
                    }
                    
                    // 安全关闭弹窗
                    if (aiSchedModal) {
                        aiSchedModal.style.opacity = '0';
                        setTimeout(() => aiSchedModal.style.display = 'none', 300);
                    }
                    // ▲▲▲ 重构结束 ▲▲▲

                } catch (err) {
                    console.error('[AI行程辅助] 失败:', err);
                    if (isAutoScheduleRun && err.name !== 'ScheduleCancelledError') {
                        const nextRetryCount = Math.min((parseInt(localStorage.getItem(autoRetryKey) || '0', 10) || 0) + 1, AUTO_SCHEDULE_MAX_RETRIES);
                        localStorage.setItem(autoRetryKey, String(nextRetryCount));
                        if (nextRetryCount >= AUTO_SCHEDULE_MAX_RETRIES) {
                            if (typeof window.showDynamicIsland !== 'undefined') window.showDynamicIsland('自动行程生成失败 3 次，请去后台手动生成', 'error');
                        }
                    } else if (typeof window.showDynamicIsland !== 'undefined') window.showDynamicIsland('推演失败: ' + err.message, 'error');
                    else alert('推演失败，请重试');
                } finally {
                    // 无论成功还是失败，最后都要解除按钮锁定并恢复文字，防卡死
                    btnAiGenSched.disabled = false;
                    btnAiGenSched.textContent = '开始智能推演';
                }
            });
        }
    }
};
        // ▼▼▼ 新增：城市天气设置与免费 API 拉取逻辑 ▼▼▼
        const weatherCityModal = document.getElementById('weather-city-modal-overlay');
        const closeWeatherCityBtn = document.getElementById('close-weather-city-btn');
        const saveWeatherCityBtn = document.getElementById('save-weather-city-btn');
        
        if (closeWeatherCityBtn && weatherCityModal) {
            closeWeatherCityBtn.addEventListener('click', () => {
                weatherCityModal.style.opacity = '0';
                setTimeout(() => weatherCityModal.style.display = 'none', 300);
                });
        }
             // 调用双保险全球免费天气接口，自带1小时防封缓存
        window.fetchRealWeather = async function fetchRealWeather(cityName, tempElementId, textElementId, overrideCharId) {
            const textEl = document.getElementById(textElementId);
            if (textEl) textEl.textContent = cityName || '虚拟城市'; // 立即显示城市名
            
                       const charId = overrideCharId || window.tempState?.currentLifeSyncCharId || 'default_char';
            // 如果城市为空，强制启用虚拟天气
            const isVirtual = !cityName || localStorage.getItem('ls_weather_virtual_toggle_' + charId) === 'true';

            // 内部负责渲染 UI 的函数
            const applyWeatherData = (temp, weatherCode) => {
                const tempEl = document.getElementById(tempElementId);
                if (tempEl) tempEl.textContent = `${temp}°C`;

                let svgPath = '';
                let statusText = '';
                let moodColor = '#D3A7A5';

                const codeStr = String(weatherCode);
                // 兼容两个接口的天气代码规范
                if (['113', '0', '1'].includes(codeStr)) {
                    svgPath = '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="M4.93 4.93l1.41 1.41"></path><path d="M17.66 17.66l1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="M4.93 19.07l1.41-1.41"></path><path d="M17.66 6.34l1.41-1.41"></path>';
                    statusText = '今天是个大晴天哦！';
                    moodColor = '#E28F8F'; 
                } else if (['116', '119', '122', '2', '3'].includes(codeStr)) {
                    svgPath = '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>';
                    statusText = '多云转阴，适合放松一下。';
                    moodColor = '#9AA0B8';
                } else if (['143', '176', '200', '248', '260', '45', '48'].includes(codeStr)) {
                    svgPath = '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"></path><path d="M13 13l-3 5h4l-3 5"></path>';
                    statusText = '雾气或雷电，请注意安全。';
                    moodColor = '#B5ACA3';
                } else if (['227', '230', '320', '323', '326', '329', '332', '335', '338', '350', '368', '371', '71', '73', '75', '77', '85', '86'].includes(codeStr)) {
                    svgPath = '<line x1="12" y1="2" x2="12" y2="22"></line><line x1="3.34" y1="7" x2="20.66" y2="17"></line><line x1="3.34" y1="17" x2="20.66" y2="7"></line>';
                    statusText = '外面下雪啦，注意保暖！';
                    moodColor = '#8FA2B4';
                } else {
                    svgPath = '<path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.36 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"></path><path d="M12 22v-4"></path><path d="M8 22v-2"></path><path d="M16 22v-2"></path>';
                    statusText = '外面下雨了，带好雨伞哦。';
                    moodColor = '#9CB4A1';
                }

                const dbKey = tempElementId === 'weather-char-temp' || tempElementId === 'bg-weather-char-temp'
                    ? 'ls_current_weather_char_' + charId
                    : 'ls_current_weather_my_' + charId;
                db.appData.put({ key: dbKey, value: { temp: temp, status: statusText } }).catch(e => console.error(e));

                if (tempEl) {
                    const weatherContainer = tempEl.closest('.left-part').parentElement; 
                    if (weatherContainer) {
                        const moodIconDiv = weatherContainer.querySelector('.mood-icon');
                        const statusMsgSpan = weatherContainer.querySelector('.status-msg');
                        const largeWeatherSvg = weatherContainer.querySelector('.left-part svg');
                        if (moodIconDiv) {
                            moodIconDiv.style.color = moodColor;
                            moodIconDiv.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 22px; height: 22px;">${svgPath}</svg>`;
                        }
                        if (statusMsgSpan) statusMsgSpan.textContent = statusText;
                        if (largeWeatherSvg) {
                            largeWeatherSvg.innerHTML = svgPath;
                            largeWeatherSvg.setAttribute('fill', 'none');
                            largeWeatherSvg.setAttribute('stroke', 'currentColor');
                            largeWeatherSvg.setAttribute('stroke-width', '2');
                            largeWeatherSvg.setAttribute('stroke-linecap', 'round');
                            largeWeatherSvg.setAttribute('stroke-linejoin', 'round');
                        }
                    }
                }
             };
            // ▼▼▼ 新增：强大的虚拟天气物理引擎拦截 ▼▼▼
            if (isVirtual) {
                // 1小时天气记忆锁，并存入底层数据库 (db.appData)
                const virtualCacheKey = 'ls_virtual_weather_cache_' + (tempElementId === 'weather-char-temp' || tempElementId === 'bg-weather-char-temp' ? 'char_' : 'my_') + charId;
                try {
                    const cachedV = await db.appData.get(virtualCacheKey);
                    if (cachedV && cachedV.value) {
                        const parsedV = cachedV.value;
                        if (Date.now() - parsedV.time < 3600000) { // 1小时 (3600000毫秒) 内保持不变
                            applyWeatherData(parsedV.temp, parsedV.code);
                            return;
                        }
                    }
                } catch(e) { console.warn("读取虚拟天气缓存失败", e); }
                const now = new Date();
                const month = now.getMonth() + 1;
                const hour = now.getHours();
                
                // 1. 根据真实世界月份或你的自定义设置来设定基准温度
                const userDefTemp = localStorage.getItem('ls_weather_virtual_temp_' + charId);
                let baseTemp = 20;
                if (userDefTemp === 'hot' || userDefTemp === 'summer') baseTemp = 32;
                else if (userDefTemp === 'cold' || userDefTemp === 'winter') baseTemp = 2;
                else if (userDefTemp === 'cool' || userDefTemp === 'autumn') baseTemp = 15;
                else if (userDefTemp === 'warm' || userDefTemp === 'spring') baseTemp = 22;
                else {
                    if (month >= 3 && month <= 5) baseTemp = 18; // 春
                    else if (month >= 6 && month <= 8) baseTemp = 30; // 夏
                    else if (month >= 9 && month <= 11) baseTemp = 16; // 秋
                    else baseTemp = 2; // 冬
                }
                
                // 2. 结合一天中不同时段产生温差变化 (这就是一小时更新一次实时的温度的核心)
                let timeOffset = 0;
                if (hour >= 11 && hour <= 15) timeOffset = 4; // 中午最热
                else if (hour >= 0 && hour <= 6) timeOffset = -5; // 凌晨最冷
                else if (hour >= 18 || hour <= 8) timeOffset = -2; // 早晚偏凉
                
                // 3. 加入小幅度随机波动，避免每天同一时间温度死板
                let temp = baseTemp + timeOffset + Math.floor(Math.random() * 5) - 2;
                
                // 4. 掷骰子模拟天气一天内的多变性 (读取你的降雨偏好)
                const userDefRain = localStorage.getItem('ls_weather_virtual_rain_' + charId);
                let rainProb = 0.15, cloudProb = 0.4, overcastProb = 0.6;
                if (userDefRain === 'rainy' || userDefRain === 'high') { rainProb = 0.6; cloudProb = 0.8; overcastProb = 0.9; }
                else if (userDefRain === 'sunny' || userDefRain === 'none') { rainProb = 0.05; cloudProb = 0.2; overcastProb = 0.3; }

                const rainRand = Math.random();
                let code = '113'; // 默认晴天
                if (rainRand < rainProb) code = (temp <= 2 ? '338' : '308'); // 下雪或下雨
                else if (rainRand < cloudProb) code = '116'; // 多云
                else if (rainRand < overcastProb) code = '122'; // 阴天
                 // 新增：将掷骰子算出来的天气存入安全的数据库中
                try {
                    await db.appData.put({ key: virtualCacheKey, value: { temp, code, time: Date.now() } });
                } catch(e) { console.error("保存虚拟天气缓存失败", e); }
                
                applyWeatherData(temp, code);
                return; // 直接返回，彻底断开网络请求！
            }
            // ▲▲▲ 虚拟天气拦截结束 ▲▲▲
            try {
                const cacheKey = 'ls_weather_cache_' + cityName;
                // 1. 尝试使用缓存（1小时内有效，防请求被封）
                const cached = localStorage.getItem(cacheKey);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    if (Date.now() - parsed.time < 3600000) {
                        applyWeatherData(parsed.temp, parsed.code);
                        return;
                    }
                }

                // 2. 尝试主要API (wttr.in) - 设置 5 秒超时防卡死
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 5000);
                    const res = await fetch(`https://wttr.in/${encodeURIComponent(cityName)}?format=j1`, { signal: controller.signal });
                    clearTimeout(timeoutId);
                    
                    if (!res.ok) throw new Error("wttr response error");
                    const data = await res.json();
                    const temp = data.current_condition[0].temp_C;
                    const code = data.current_condition[0].weatherCode;
                    localStorage.setItem(cacheKey, JSON.stringify({ temp, code, time: Date.now() }));
                    applyWeatherData(temp, code);
                    return;
                } catch(e) {
                    console.warn(`[天气] 首选接口请求异常: ${cityName}, 尝试备用接口...`);
                }

                // 3. 启用双保险 API (Open-Meteo，需要先查经纬度)
                const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=zh`);
                const geoData = await geoRes.json();
                if (!geoData.results || geoData.results.length === 0) throw new Error("备用接口无法解析该城市坐标");
                
                const lat = geoData.results[0].latitude;
                const lon = geoData.results[0].longitude;
                const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
                const weatherData = await weatherRes.json();
                
                const temp = Math.round(weatherData.current_weather.temperature);
                const code = weatherData.current_weather.weathercode;
                
                localStorage.setItem(cacheKey, JSON.stringify({ temp, code, time: Date.now() }));
                applyWeatherData(temp, code);

            } catch (err) {
                console.error("所有天气接口全部请求失败:", err);
                // 彻底失败时，寻找看有没有过期缓存垫底
                const cached = localStorage.getItem(cacheKey);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    applyWeatherData(parsed.temp, parsed.code);
                } else {
                    const tempEl = document.getElementById(tempElementId);
                    if (tempEl) tempEl.textContent = `--°C`;
                }
            }
        }
           if (saveWeatherCityBtn && weatherCityModal) {
            saveWeatherCityBtn.addEventListener('click', async () => {
                const charCity = document.getElementById('weather-char-city-input').value.trim();
                const myCity = document.getElementById('weather-my-city-input').value.trim();
                 // --- 新增：将输入的城市持久化保存，并与当前角色ID绝对绑定 ---
                const charId = window.tempState?.currentLifeSyncCharId || 'default_char';
                localStorage.setItem('ls_weather_char_city_' + charId, charCity);
                localStorage.setItem('ls_weather_my_city_' + charId, myCity);

                // --- 新增：保存虚拟天气的状态 ---
                const vToggle = document.getElementById('weather-virtual-toggle')?.checked || false;
                const vTemp = document.getElementById('weather-virtual-temp')?.value || 'warm';
                const vRain = document.getElementById('weather-virtual-rain')?.value || 'normal';
                localStorage.setItem('ls_weather_virtual_toggle_' + charId, vToggle);
                localStorage.setItem('ls_weather_virtual_temp_' + charId, vTemp);
                localStorage.setItem('ls_weather_virtual_rain_' + charId, vRain);
                // --------------------------------------------------------

                const oldText = saveWeatherCityBtn.textContent;
                saveWeatherCityBtn.textContent = "正在获取真实天气...";
                saveWeatherCityBtn.disabled = true;

                // 等待分别拉取并更新数据
                if (charCity) await fetchRealWeather(charCity, 'weather-char-temp', 'weather-char-city-text');
                if (myCity) await fetchRealWeather(myCity, 'weather-my-temp', 'weather-my-city-text');

                saveWeatherCityBtn.textContent = oldText;
                saveWeatherCityBtn.disabled = false;
                
                weatherCityModal.style.opacity = '0';
                setTimeout(() => weatherCityModal.style.display = 'none', 300);
            });
        }
        // ▲▲▲ 新增结束 ▲▲▲
                 // ▼▼▼ 【新增】Live Monitor 弹窗与 AI 生成逻辑 (进阶版) ▼▼▼
        const monitorBtn = document.getElementById('ls-live-monitor-btn');
        const monitorSelectModal = document.getElementById('live-monitor-select-modal');
        const closeMonitorSelectBtn = document.getElementById('close-monitor-select-btn');
        const monitorScheduleList = document.getElementById('monitor-schedule-list');
        
        const monitorFullscreen = document.getElementById('live-monitor-fullscreen');
        const closeMonitorFullBtn = document.getElementById('close-monitor-full-btn');
        const monitorFullBg = document.getElementById('monitor-full-bg');
        const monitorDataStream = document.getElementById('monitor-data-stream');
        const monitorFocusBox = document.getElementById('monitor-focus-box');
        const monitorLoadingText = document.getElementById('monitor-loading-text');
        const monitorResultText = document.getElementById('monitor-result-text');
        const regenerateMonitorBtn = document.getElementById('regenerate-monitor-btn');
        const monitorRecDot = document.getElementById('monitor-rec-dot');

        let monitorAnimInterval;
        let currentMonitorCharId = null;
        let currentMonitorSchedule = null;
         // 【新增工具】小监控窗口背景同步：一进页面或者切换角色时，把小框背景换成相册图或头像
        const updateSmallMonitorCam = (charId) => {
            const camPreview = document.getElementById('ls-monitor-cam-preview');
            if (!camPreview) return;
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (!char) return;
            
            // 简单粗暴，直接用角色头像，绝不跨域也绝不找错人
            let finalImg = char.avatar || 'images/default-avatar.svg';

            camPreview.style.backgroundColor = '#111';
            camPreview.style.backgroundImage = `url("${finalImg}")`;
            camPreview.style.backgroundSize = 'cover';
            camPreview.style.backgroundPosition = 'center';
        };

        // 1. 点击听筒，获取今天的所有行程并显示在弹窗
        if (monitorBtn) {
            monitorBtn.addEventListener('click', async () => {
                const charId = window.tempState?.currentLifeSyncCharId;
                if (!charId) return alert("未选择角色");
                 const now = new Date();
                const todayStr = now.getDate().toString();
                const record = await db.appData.get('ls_schedules_data_' + charId);
                const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
                // 【修改】：加入 s.startTime <= currentTime 拦截未开始的行程
                const schedules = (record && record.value) ? record.value.filter(s => isScheduleOnLocalDate(s, now) && s.owner !== 'mine' && s.startTime <= currentTime) : [];
                
                monitorScheduleList.innerHTML = '';
                if (schedules.length === 0) {
                    monitorScheduleList.innerHTML = '<div style="color: #666; text-align: center; padding: 10px; font-size: 12px;">暂无正在进行或已完成的行程可供切入</div>';
                } else {
                    schedules.forEach(sched => {
                        const item = document.createElement('button');
                        item.style.cssText = 'background: rgba(255,255,255,0.05); border: 1px solid #333; color: #ddd; padding: 12px; border-radius: 10px; text-align: left; cursor: pointer; transition: 0.2s; font-size: 13px;';
                        const timeText = document.createElement('span');
                        timeText.style.cssText = 'color:#00ff78;margin-right:8px;';
                        timeText.textContent = `[${sched.startTime}-${sched.endTime}]`;
                        item.append(timeText, document.createTextNode(` ${sched.locName || ''} - ${sched.content || ''}`));
                        item.onmouseover = () => item.style.background = 'rgba(0,255,120,0.1)';
                        item.onmouseout = () => item.style.background = 'rgba(255,255,255,0.05)';
                        
                        item.addEventListener('click', () => {
                            monitorSelectModal.style.opacity = '0';
                            setTimeout(() => monitorSelectModal.style.display = 'none', 300);
                            currentMonitorCharId = charId;
                            currentMonitorSchedule = sched;
                            startLiveMonitor(charId, sched);
                        });
                        monitorScheduleList.appendChild(item);
                    });
                }
                
                monitorSelectModal.style.display = 'flex';
                setTimeout(() => monitorSelectModal.style.opacity = '1', 10);
            });
        }

        if (closeMonitorSelectBtn) {
            closeMonitorSelectBtn.addEventListener('click', () => {
                monitorSelectModal.style.opacity = '0';
                setTimeout(() => monitorSelectModal.style.display = 'none', 300);
            });
        }
         if (closeMonitorFullBtn) {
             closeMonitorFullBtn.addEventListener('click', () => {
                 monitorFullscreen.style.height = '0';
                 monitorDataStream.style.display = 'none';
                 clearInterval(monitorAnimInterval);
                 if (window.tempState?.currentMonitorIntervened) {
                     window.tempState.currentMonitorIntervened = false;
                     window.tempState.currentMonitorMessageId = null;
                     window.tempState.currentMonitorSummary = null;
                     return;
                 }
                 
                 // 【修改】：退出时弹窗询问是否存入记忆
                const charId = currentMonitorCharId;
                const summary = window.tempState?.currentMonitorSummary;
                
                if (charId && summary) {
                    const overlay = document.createElement('div');
                    overlay.className = 'modal-overlay';
                    overlay.style.cssText = 'z-index: 10025; display: flex; opacity: 0; transition: opacity 0.3s; background: rgba(0,0,0,0.6); position: fixed; inset: 0; width: 100vw; height: 100dvh; min-height: 100dvh; align-items: center; justify-content: center; box-sizing: border-box; overflow: hidden; touch-action: none; overscroll-behavior: contain; padding: max(20px, env(safe-area-inset-top)) 0 max(20px, env(safe-area-inset-bottom)) 0;';
                    overlay.innerHTML = `
                      <div class="modal-card" style="width: 92%; max-width: 360px; max-height: calc(100dvh - 40px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); background: #1a1a1a; color: #fff; border: 1px solid #333; border-radius: 16px; padding: 20px; text-align: center; box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;">
                        <h3 style="margin: 0 0 10px; font-size: 16px; color: #00ff78;">监控已断开</h3>
                        <p style="font-size: 13px; color: #aaa; margin-bottom: 15px;">是否将此行动记录存入系统记忆，让 Ta 在对话中知晓此事？</p>
                     <div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; margin-bottom: 20px; font-size: 13px; color: #ddd; text-align: left; border-left: 3px solid #00ff78;">
                          ${escapeHTML(String(summary))}
                        </div>
                        <div style="display: flex; gap: 10px;">
                          <button id="monitor-log-hidden" style="flex: 1; padding: 12px; background: rgba(0,255,120,0.2); color: #00ff78; border: 1px solid #00ff78; border-radius: 8px; cursor: pointer; font-weight: bold;">写入暗线记录</button>
                          <button id="monitor-log-recall" style="flex: 1; padding: 12px; background: #333; color: #ff3b30; border: none; border-radius: 8px; cursor: pointer; font-weight: bold;">撤回不记录</button>
                        </div>
                      </div>
                    `;
                    document.body.appendChild(overlay);
                    setTimeout(() => overlay.style.opacity = '1', 10);

                    const closeOverlay = () => {
                        overlay.style.opacity = '0';
                        setTimeout(() => overlay.remove(), 300);
                        window.tempState.currentMonitorSummary = null;
                    };
                    overlay.querySelector('#monitor-log-recall').onclick = async () => {
                        if (window.tempState?.currentMonitorMessageId) await db.chatMessages.delete(window.tempState.currentMonitorMessageId);
                        window.tempState.currentMonitorMessageId = null;
                        closeOverlay();
                    };

                    // 【修改】：封装统一的保存函数，复用并唤醒聊天页的悬浮卡片
                    const saveAndShowWidget = async (isVisible) => {
                        let msgId = window.tempState?.currentMonitorMessageId;
                        if (!msgId) {
                            const fallbackStatus = currentMonitorSchedule?.endTime < new Date().toTimeString().slice(0, 5) ? '已发生' : '正在发生';
                            const fallbackTime = `${currentMonitorSchedule?.dateISO || getLocalDateKey()}T${currentMonitorSchedule?.endTime || new Date().toTimeString().slice(0, 5)}:00`;
                            msgId = await db.chatMessages.add({
                                chatId: charId, timestamp: new Date(),
                                text: `[系统监控视界｜状态:${fallbackStatus}｜发生时间:${fallbackTime}｜这是异地发生的事件，角色并未与用户当面接触] ${String(summary).slice(0, 180)}`,
                                type: 'system', contentType: 'system_event', eventType: 'info',
                                uiVisible: isVisible, aiVisible: true, recalled: false
                            });
                        } else if (isVisible) {
                            await db.chatMessages.update(msgId, { uiVisible: true });
                        }
                        
                        // 存入 localStorage，让轮询系统接管它显示在聊天界面，实现撤回功能
                        const widgetText = `【监控记录】${summary}`;
                        const widgetData = { texts: [widgetText], msgId: msgId };
                        localStorage.setItem(`lover_sync_widget_${charId}`, JSON.stringify(widgetData));
                        
                        // 动态唤醒卡片（如果你切回主聊天界面马上就能看到）
                        const widget = document.getElementById('sync-memo-widget');
                        const list = document.getElementById('sync-memo-list');
                        if (widget && list) {
                            list.innerHTML = `<li>${escapeHTML(widgetText)}</li>`;
                            widget.classList.remove('hidden');
                            widget.dataset.currentCharId = charId;
                            widget.dataset.msgId = msgId;
                            
                            // 【核心】：动态修改卡片标题以区分功能，防止混淆
                            const titleEl = widget.querySelector('.title');
                            if (titleEl) titleEl.textContent = 'MONITOR LOG';
                            
                            setTimeout(() => widget.classList.remove('collapsed'), 50);
                        }

                        // 如果公开写入且恰好在聊天界面，直接渲染气泡
                        if (isVisible && String(window.tempState.currentChatId) === String(charId)) {
                            const newMsg = await db.chatMessages.get(msgId);
                            if (typeof window.createAndAppendMessage !== 'undefined') {
                                await window.createAndAppendMessage(newMsg);
                            }
                        }
                        if (typeof window.showDynamicIsland !== 'undefined') window.showDynamicIsland(isVisible ? '已公开写入聊天界面' : '已隐密写入核心记忆', 'success');
                        window.tempState.currentMonitorMessageId = null;
                        closeOverlay();
                    };

                    overlay.querySelector('#monitor-log-hidden').onclick = () => saveAndShowWidget(false);
                }
            });
        }
        if (regenerateMonitorBtn) {
            regenerateMonitorBtn.addEventListener('click', () => {
                if (currentMonitorCharId && currentMonitorSchedule) {
                    startLiveMonitor(currentMonitorCharId, currentMonitorSchedule);
                }
            });
        }

        // 闪烁红点动画 (防幽灵叠加发热版)
        // 录制红点闪烁交给 CSS，避免离开页面后 800ms 定时器继续唤醒主线程。
        async function applyMonitorScheduleChanges(charId, schedule, accidentText, changes) {
            const dataKey = 'ls_schedules_data_' + charId;
            const htmlKey = 'ls_schedules_' + charId;
            const [dataRecord, htmlRecord] = await Promise.all([db.appData.get(dataKey), db.appData.get(htmlKey)]);
            const dataList = Array.isArray(dataRecord?.value) ? dataRecord.value : [];
            const targetDate = schedule.date || new Date().getDate().toString();
            const targetDateISO = schedule.dateISO || resolveScheduleDateKey(targetDate);
            const futureStartBoundary = schedule.endTime || schedule.startTime || '00:00';
            const safeChanges = Array.isArray(changes) ? changes.filter(c => /^\d{2}:\d{2}$/.test(c.originalStartTime || '') && c.originalStartTime >= futureStartBoundary) : [];
            const appliedDiffs = [];
            dataList.forEach(item => {
                if (!isStoredScheduleOnDate(item, targetDateISO)) return;
                const before = { startTime: item.startTime, endTime: item.endTime, content: item.content, locName: item.locName, accidentReason: item.accidentReason };
                if (item.startTime === schedule.startTime) item.accidentReason = accidentText;
                const change = safeChanges.find(c => c.originalStartTime === item.startTime);
                if (!change) return;
                if (/^\d{2}:\d{2}$/.test(change.startTime || '')) item.startTime = change.startTime;
                if (/^\d{2}:\d{2}$/.test(change.endTime || '')) item.endTime = change.endTime;
                if (typeof change.content === 'string' && change.content.trim()) item.content = change.content.trim().slice(0, 80);
                if (typeof change.locName === 'string' && change.locName.trim()) item.locName = change.locName.trim().slice(0, 40);
                item.accidentReason = accidentText;
                if (JSON.stringify(before) !== JSON.stringify({ startTime: item.startTime, endTime: item.endTime, content: item.content, locName: item.locName, accidentReason: item.accidentReason })) {
                    appliedDiffs.push({ before, after: { startTime: item.startTime, endTime: item.endTime, content: item.content, locName: item.locName, accidentReason: item.accidentReason } });
                }
            });
            dataList.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.startTime).localeCompare(String(b.startTime)));
            const changedDay = dataList.filter(item => isStoredScheduleOnDate(item, targetDateISO)).sort((a, b) => a.startTime.localeCompare(b.startTime));
            for (let index = 0; index < changedDay.length; index++) {
                const item = changedDay[index];
                if (item.endTime < item.startTime || (index > 0 && changedDay[index - 1].endTime > item.startTime)) {
                    throw new Error('AI返回的行程时间发生重叠，本次未修改原行程');
                }
            }
            const htmlList = (htmlRecord?.value || []).map(entry => {
                const box = document.createElement('div');
                box.innerHTML = entry?.rowHTML || '';
                const row = box.firstElementChild;
                const card = row?.querySelector('.dynamic-schedule');
                if (!row || !card || (row.dataset.scheduleDateIso ? row.dataset.scheduleDateIso !== targetDateISO : row.dataset.scheduleDate !== targetDate)) return entry;
                const originalStart = card.dataset.startTime;
                const change = safeChanges.find(c => c.originalStartTime === originalStart);
                if (originalStart === schedule.startTime || change) {
                    card.dataset.accident = 'true';
                    card.dataset.accidentreason = accidentText;
                }
                if (change) {
                    if (/^\d{2}:\d{2}$/.test(change.startTime || '')) card.dataset.startTime = change.startTime;
                    if (/^\d{2}:\d{2}$/.test(change.endTime || '')) card.dataset.endTime = change.endTime;
                    if (change.content) card.dataset.content = String(change.content).slice(0, 80);
                    if (change.locName) card.dataset.locname = String(change.locName).slice(0, 40);
                    const time = row.querySelector('.tl-time');
                    if (time) time.innerHTML = `${card.dataset.startTime}<br><span style="font-size: 9px; color: #A3958F;">至 ${card.dataset.endTime}</span>`;
                    const info = card.querySelector('.tl-info');
                    if (info && change.content) {
                        const contentText = String(change.content).slice(0, 80);
                        const contentElement = info.querySelector('.tl-content');
                        if (contentElement) {
                            contentElement.textContent = contentText;
                        } else {
                            const contentTextNode = Array.from(info.childNodes).find(node =>
                                node.nodeType === Node.TEXT_NODE && node.textContent.trim()
                            );
                            if (contentTextNode) contentTextNode.textContent = contentText;
                        }
                    }
                }
                return { ...entry, rowHTML: row.outerHTML };
            });
            await Promise.all([db.appData.put({ key: dataKey, value: dataList }), db.appData.put({ key: htmlKey, value: htmlList })]);
            if (String(window.tempState?.currentLifeSyncCharId) === String(charId)) window.loadLsDataForChar?.(charId, true);
            return appliedDiffs;
        }

        function showMonitorScheduleChangesModal(appliedDiffs) {
            if (!appliedDiffs.length) return;
            const overlay = document.createElement('div');
            overlay.className = 'monitor-schedule-change-overlay';
            overlay.innerHTML = `<div class="monitor-schedule-change-card" role="dialog" aria-modal="true"><div class="monitor-schedule-change-kicker">SCHEDULE SHIFT // APPLIED</div><h3>行程已发生变化</h3><div class="monitor-schedule-change-list">${appliedDiffs.map(diff => `<div class="monitor-schedule-change-item"><span>原行程</span><strong>${escapeHTML(`${diff.before.startTime}–${diff.before.endTime} ${diff.before.content || ''}`)}</strong><i>↓</i><span>调整后</span><strong>${escapeHTML(`${diff.after.startTime}–${diff.after.endTime} ${diff.after.content || ''}`)}</strong>${diff.before.locName !== diff.after.locName ? `<small>${escapeHTML(diff.before.locName || '未标地点')} → ${escapeHTML(diff.after.locName || '未标地点')}</small>` : ''}</div>`).join('')}</div><button type="button" data-monitor-change-close>知道了</button></div>`;
            document.body.appendChild(overlay);
            overlay.addEventListener('click', event => {
                if (event.target === overlay || event.target.closest('[data-monitor-change-close]')) overlay.remove();
            });
        }

        function extractMonitorJsonBlock(rawText, openingChar, closingChar) {
           const cleanText = String(rawText || '')
                .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
                .replace(/<think>[\s\S]*?<\/think>/gi, '')
               .replace(/```json/gi, '')
                .replace(/```/g, '')
                .trim();
            const start = cleanText.indexOf(openingChar);
            if (start === -1) return '';
            let depth = 0;
            let inString = false;
            let escaped = false;
            for (let i = start; i < cleanText.length; i++) {
                const currentChar = cleanText[i];
                if (inString) {
                    if (escaped) escaped = false;
                    else if (currentChar === '\\') escaped = true;
                    else if (currentChar === '"') inString = false;
                    continue;
                }
                if (currentChar === '"') {
                    inString = true;
                    continue;
                }
                if (currentChar === openingChar) depth++;
                else if (currentChar === closingChar) {
                    depth--;
                    if (depth === 0) return cleanText.slice(start, i + 1);
                }
            }
            return '';
        }

        function parseMonitorInterventionSuggestions(rawText) {
            const match = String(rawText || '').match(/<INTERVENTIONS>\s*([\s\S]*?)\s*<\/INTERVENTIONS>/i);
            if (!match) return [];
            try {
                const parsed = JSON.parse(extractMonitorJsonBlock(match[1], '[', ']'));
                if (!Array.isArray(parsed) || parsed.length !== 3 || parsed.some(item => typeof item !== 'string' || !item.trim())) return [];
                return parsed.map(item => item.trim().slice(0, 40));
            } catch (error) {
                return [];
            }
        }

        function renderMonitorInterventionPanel(charId, schedule, char, interventionSuggestions = []) {
            document.getElementById('monitor-intervention-panel')?.remove();
            const charDisplayName = getLifeSyncCharacterDisplayName(char);
             const panel = document.createElement('div');
            panel.id = 'monitor-intervention-panel';
            panel.className = 'monitor-intervention-panel';
             const title = document.createElement('div');
             title.className = 'monitor-intervention-title';
             title.innerHTML = '<span>REALITY INTERVENTION // VARIABLE SELECT</span><b>让接下来发生一点意外</b>';
             panel.appendChild(title);
             const generating = document.createElement('div');
             generating.className = 'monitor-intervention-generating';
             generating.innerHTML = '<span>GENERATING // REWRITING REALITY</span><b>正在重写现场变量</b><i>PROCESSING...</i>';
             panel.appendChild(generating);
            const options = document.createElement('div');
            options.className = 'monitor-intervention-options';
            for (const suggestion of interventionSuggestions) {
                 const button = document.createElement('button');
                 button.type = 'button';
                 button.className = 'monitor-intervention-option';
                 button.textContent = suggestion;
                 button.addEventListener('click', () => runIntervention(suggestion, button));
                options.appendChild(button);
            }
            if (interventionSuggestions.length === 3) panel.appendChild(options);
            const custom = document.createElement('div');
             custom.className = 'monitor-intervention-custom';
             custom.innerHTML = '<input maxlength="100" placeholder="自己写 Ta 接下来会遇到什么"><button type="button">生成反应</button>';
             custom.querySelector('button').addEventListener('click', () => runIntervention(custom.querySelector('input').value.trim(), custom.querySelector('button')));
            panel.appendChild(custom);
            monitorResultText.insertAdjacentElement('afterend', panel);

             async function runIntervention(accidentText, sourceButton = null) {
                 if (!accidentText) return;
                 panel.classList.add('is-generating');
                 sourceButton?.classList.add('is-active');
                 panel.querySelectorAll('button,input').forEach(el => el.disabled = true);
                 try {
                    const record = await db.appData.get('ls_schedules_data_' + charId);
                    const scheduleDateISO = schedule.dateISO || resolveScheduleDateKey(schedule.date || new Date().getDate());
                    const laterSchedules = (record?.value || []).filter(s => isStoredScheduleOnDate(s, scheduleDateISO) && s.startTime >= (schedule.endTime || schedule.startTime));
                    const { url, key, model, temperature } = AppState.apiCurrentSettings;
                     const prompt = `You are processing one user-triggered reality intervention inside an already ongoing schedule event.\n\nCharacter:\n${charDisplayName}\n\nCurrent schedule:\n${JSON.stringify(schedule)}\n\nUser-triggered incident:\n${accidentText}\n\nRemaining schedules:\n${JSON.stringify(laterSchedules)}\n\nThis is a semi-realistic live-monitoring simulation. Preserve physical reality, timeline continuity, location continuity, established character identity, personality, relationships, and all events that have already finished. Introduce ONLY the consequence naturally caused by the supplied incident. Do not create a second unrelated accident, coincidence, sudden relationship change, dramatic revelation, or out-of-character conflict.\n\nWrite a substantial Chinese narrative of approximately 280-500 Chinese characters, preferably divided into 2-4 natural paragraphs. Show the immediate physical reaction, environmental response, concrete actions, relevant NPC interaction when appropriate, emotional change consistent with the character, and the practical consequence of the incident. Do not summarize in a few sentences. Do not predict events that have not yet become causally determined. Do not rewrite already-finished schedules. If the incident changes future schedule timing or content, return only the affected future schedule blocks in scheduleChanges. No schedule overlap is allowed.\n\nReturn ONLY one raw valid JSON object:\n{\n  "narrative": "Chinese narrative",\n  "scheduleChanges": [{"originalStartTime":"HH:MM","startTime":"HH:MM","endTime":"HH:MM","content":"Chinese schedule content","locName":"location"}]\n}\nIf no schedule change is required, return scheduleChanges as an empty array.`;
                   const strictMonitorPrompt = [
                       prompt,
                        "Character persona (continuity reference only): " + (char.persona || "暂无人设"),
                       '',
                        '[Strict output requirements]',
                        'Return ONLY one raw valid JSON object. Do not output Markdown, code fences, explanations, or thinking tags.',
                        'The first character must be { and the final character must be }.',
                        'The top-level keys must be exactly "narrative" and "scheduleChanges".',
                        'The narrative must be a substantial Chinese narrative of 280-500 Chinese characters, grounded in the current schedule and the user-selected incident.',
                        'Do not put raw line breaks or unescaped double quotes inside the narrative JSON string.',
                        'scheduleChanges must contain only affected future schedule blocks. Each block must identify an existing block with originalStartTime in HH:MM format and include startTime, endTime, content, and locName.',
                        'If no future schedule needs to change, return an empty scheduleChanges array. Do not change completed schedules, create overlapping times, or regenerate the whole day.',
                    ].join('\n');
                    const response = await fetch(`${url.trim().replace(/\/$/, '')}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ model, messages: [{ role: 'user', content: strictMonitorPrompt }], temperature: parseFloat(temperature) || 0.8 }) });
                    if (!response.ok) throw new Error('二次生成失败');
                    const raw = (await response.json()).choices?.[0]?.message?.content || '';
                     const parsed = JSON.parse(extractMonitorJsonBlock(raw, '{', '}') || '{}');
                    if (!parsed.narrative) throw new Error('AI未返回反应叙事');
                     const narrative = String(parsed.narrative).slice(0, 900);
                     monitorResultText.insertAdjacentHTML('beforeend', `<div class="monitor-intervention-result"><div class="monitor-intervention-result-kicker">REALITY SHIFT // 02</div><div class="monitor-intervention-result-body">${escapeHTML(narrative).replace(/\n/g, '<br><br>')}</div></div>`);
                     const interventionResult = monitorResultText.lastElementChild;
                     interventionResult?.scrollIntoView({ block: 'start' });
                     let appliedDiffs = [];
                     let scheduleApplyFailed = false;
                     try {
                         appliedDiffs = await applyMonitorScheduleChanges(charId, schedule, accidentText, parsed.scheduleChanges);
                     } catch (scheduleError) {
                         scheduleApplyFailed = true;
                         console.error('意外事件已生成，但行程更新失败:', scheduleError);
                     }
                     const finalMonitorText = `[系统监控视界｜状态:正在发生｜发生时间:${new Date().toISOString()}｜这是异地发生的事件，角色并未与用户当面接触] ${narrative} 行程改变原因：${accidentText}`;
                     const existingMessageId = window.tempState?.currentMonitorMessageId;
                     if (existingMessageId) {
                         await db.chatMessages.update(existingMessageId, { text: finalMonitorText, monitorIntervention: { narrative, accidentText, appliedDiffs }, uiVisible: false, aiVisible: true });
                     } else {
                         window.tempState.currentMonitorMessageId = await db.chatMessages.add({ chatId: charId, timestamp: new Date(), type: 'system', contentType: 'system_event', uiVisible: false, aiVisible: true, recalled: false, text: finalMonitorText, monitorIntervention: { narrative, accidentText, appliedDiffs } });
                     }
                     window.tempState.currentMonitorIntervened = true;
                     showMonitorScheduleChangesModal(appliedDiffs);
                     window.showDynamicIsland?.(scheduleApplyFailed ? '意外事件已生成，但行程未修改' : '已写入现实轨迹', scheduleApplyFailed ? 'error' : 'success');
                    panel.remove();
                    const monitorContentArea = document.getElementById('monitor-content-area');
                    if (monitorContentArea) monitorContentArea.scrollTop = monitorContentArea.scrollHeight;
                } catch (error) {
                     panel.classList.remove('is-generating');
                     panel.querySelectorAll('button,input').forEach(el => el.disabled = false);
                     sourceButton?.classList.remove('is-active');
                     window.showDynamicIsland?.(error.message || '意外生成失败', 'error');
                 }
            }
        }

        // 2. 核心：展开全屏，查图片，调取深度记忆生成小说
        async function startLiveMonitor(charId, schedule) {
            const char = AppState.characterProfiles.find(c => c.id === charId);
            if (!char) return;
            const charDisplayName = getLifeSyncCharacterDisplayName(char);
            const monitorStartedAt = new Date();
            const monitorClock = monitorStartedAt.getHours().toString().padStart(2, '0') + ':' + monitorStartedAt.getMinutes().toString().padStart(2, '0');
            const monitorStatus = schedule.endTime < monitorClock ? '已发生' : '正在发生';
            const monitorOccurredAt = monitorStatus === '已发生'
                ? `${schedule.dateISO || resolveScheduleDateKey(schedule.date || monitorStartedAt.getDate())}T${schedule.endTime || monitorClock}:00`
                : `${getLocalDateKey(monitorStartedAt)}T${monitorClock}:00`;
            if (window.tempState?.currentMonitorMessageId) {
                await db.chatMessages.delete(window.tempState.currentMonitorMessageId).catch(() => {});
                window.tempState.currentMonitorMessageId = null;
            }
            
            // 安全获取当前用户身份
            const identityId = char.chatIdentityId || AppState.currentIdentityId;
            const currentUser = AppState.userIdentities.find(id => id.id === identityId) || AppState.userIdentities[0] || { name: '你' }; 

            // 展开 UI & 初始化状态
            monitorFullscreen.style.height = '100%';
            monitorLoadingText.style.display = 'block';
            monitorResultText.style.display = 'none';
            regenerateMonitorBtn.style.display = 'none';
            monitorFullBg.style.opacity = '0';
            monitorDataStream.style.display = 'block';

            // 简单的框子乱晃动画，模拟“数据流化眼睛左右窥探”
            clearInterval(monitorAnimInterval);
            monitorAnimInterval = setInterval(() => {
                const randomX = Math.floor(Math.random() * 60) + 20; // 20% to 80%
                const randomY = Math.floor(Math.random() * 60) + 20;
                const randomScale = (Math.random() * 0.4) + 0.8; // 0.8 to 1.2
                if (monitorFocusBox) {
                    monitorFocusBox.style.left = `${randomX}%`;
                    monitorFocusBox.style.top = `${randomY}%`;
                    monitorFocusBox.style.transform = `translate(-50%, -50%) scale(${randomScale})`;
                }
            }, 3000);

            try {
                // (1) 尝试通过 AI 匹配相册照片做背景 (带容错)
                           const searchKeyword = `${schedule.locName || ''} ${schedule.content}`.trim();
                let matchedImgUrl = null;
                try {
                    const { findBestImageForDescription } = await import('./gallery.js');
                    matchedImgUrl = await findBestImageForDescription(charId, searchKeyword);
                } catch(e) { console.warn("图片匹配跳过"); }
                
                monitorFullBg.style.backgroundImage = `url('${matchedImgUrl || char.avatar || 'images/default-avatar.svg'}')`;
                setTimeout(() => monitorFullBg.style.opacity = '0.6', 500); // 渐渐浮现
                // (2) 深度拉取数据 (动态引入核心方法防报错)
                const { getMemoriesForPrompt } = await import('./memory.js');
                const { getWorldBookForPrompt } = await import('../state.js');
                const memory = await getMemoriesForPrompt(charId);
                const worldBook = await getWorldBookForPrompt(charId);
                
                // 简易获取最近15条聊天记录作为上下文参考
                const recentMsgs = await db.chatMessages.where('chatId').equals(charId).reverse().limit(40).toArray();
                const chatContextText = recentMsgs.reverse().filter(m => m.type !== 'system' && m.aiVisible !== false).slice(-15).map(m => {
                    const speaker = m.type === 'sent' ? currentUser.name : charDisplayName;
                    const text = typeof m.text === 'string' ? m.text.replace(/<[^>]+>/g, '').substring(0, 50) : '[多媒体]';
                    return `${speaker}: ${text}`;
                }).join('\n');

                const { url, key, model, temperature } = AppState.apiCurrentSettings;
                if (!url || !key) throw new Error("API 未配置");

                // (3) 构建遵循 Offline Narrative Mode 的顶级小说生成 Prompt
                const prompt = `[System Preamble: Surveillance Narrative Engine v3]

You are a novelist writing a scene about the character【${charDisplayName}】during a specific time block of their day. User (${currentUser.name}) is secretly watching through a surveillance feed.

<Character_Persona>
${char.persona}
</Character_Persona>

<Scene_Assignment>
Time: ${schedule.startTime} - ${schedule.endTime}
Location: ${schedule.locName || 'A location fitting the persona'}
Activity: ${schedule.content}
</Scene_Assignment>

<Time_Boundary>
Current time: ${new Date().toLocaleString('zh-CN', { hour12: false })}
Only describe events that have already happened or are happening now. Never predict or narrate events after the current time.
Reality status: ${monitorStatus}. Reality is authoritative. Allow at most one small, plausible story beat that follows naturally from the activity, place and persona.
</Time_Boundary>

<Background_Data>
Memory: ${memory}
World Setting: ${worldBook}
Recent chat context (for emotional continuity only — do NOT quote or re-enact):
${chatContextText}
</Background_Data>

**[WRITING RULES — STRICTLY ENFORCED]**

1.  **FOCUS: What ${charDisplayName} Actually DOES (这是最重要的规则)**
    Your scene MUST revolve around ${charDisplayName} actively performing the<Scene_Assignment> Activity. The reader wants to know:
    - What specific tasks or actions is ${charDisplayName} doing right now? (e.g., writing lyrics on a notebook, adjusting mic levels, tasting a dish and adding salt, reviewing documents on a laptop, practicing dance moves in front of a mirror)
    - What small problems or decisions come up during this activity? (e.g., can't find the right chord, the client sends a difficult email, the recipe goes wrong, a colleague interrupts with a question)
    - How does ${charDisplayName} handle these moments? What are their work habits, quirks, or shortcuts that reveal personality?
    
    **At least 60% of your text must describe ${charDisplayName} actively doing things related to the Activity.**

2.  **NPC Interactions Are Mandatory**
    ${charDisplayName} does NOT exist in a vacuum. Based on the <Character_Persona> and <Scene_Assignment>, generate1-2 natural interactions with background NPCs who would realistically be present at this location:
    - A colleague, assistant, boss, client, shop staff, stranger, friend — whoever fits the scene.
    - Write actual spoken dialogue between ${charDisplayName} and the NPC. Use quotation marks. Keep it brief and natural.
    - These interactions should reveal ${charDisplayName}'s personality: how they talk to others, their tone, their social habits.
    - Example: A barista asks what they want → ${charDisplayName} orders without looking up from their phone. A colleague asks about a deadline → ${charDisplayName} gives a curt or friendly reply depending on persona.

3.  **Private Habits & Persona Details**
    Weave in 1-2 small behavioral details that are unique to ${charDisplayName}'s persona — things only someone secretly watching would notice:
    - A specific way they sit, a nervous habit, a comfort ritual, what they eat/drink, how they organize their workspace, what's on their phone wallpaper, how they react when alone vs. with others.
    - These details must come directly from the <Character_Persona>, NOT be generic.

4.  **Mood Through Actions, Not Labels**
    Show ${charDisplayName}'s current mood through what they DO, not by naming the emotion:
    - Instead of "he felt tired" → "he rubbed his eyes and pushed the laptop away for a moment"
    - Instead of "she was happy" → "she hummed something under her breath while working"
    - Instead of "he missed the user" → "he paused, glanced at his phone, then put it face-down and went back to work"

5.  **User Connection: Once, Briefly, Naturally**
    ${charDisplayName} may do ONE small thing that subtly connects to the user — check their chat, glance at a gift, mutter something. Keep it to one sentence maximum. Do NOT make it dramatic.

6.  **Perspective & Style**
    - Third person only ("He/She/Name"). Camera perspective — describe what is visible and audible.
    - Write in Chinese. Natural prose, not overly literary.
    - Vary paragraph openings. Do not start consecutive paragraphs with the character's name.

7.  **Emotional Temperature: Grounded & Realistic**
    This is an ordinary moment in an ordinary day. No dramatic outbursts, no sudden revelations, no theatrical tension. The character is simply living their life. The interest comes from the DETAILS of how they live it, not from manufactured drama.

8.  **BANNED**: "极其", "如同...般", "不可思议", "心头一紧", "涌上心头". No exclamation marks. No recapping the chat history.

9.  **Output**: Write the narration in Chinese, 800-1200 characters. Any non-Chinese spoken dialogue must be immediately followed by its natural Chinese translation in square brackets, for example: “See you.”[回头见。] NO JSON, NO markdown.

10. **Summary**: At the very end, provide 4-6 concise Chinese sentences (90-160 Chinese characters) wrapped in <SUMMARY>...</SUMMARY>. Include concrete actions, interaction partners, emotional change shown through behavior, and one environmental detail. State facts only and do not mention future events.

11. **Potential Reality Interventions**: After <SUMMARY>, output exactly three short Chinese intervention candidates inside <INTERVENTIONS> as a valid JSON array.
    Each candidate must be a plausible small disruption that could naturally happen NEXT from the exact scene you just narrated, based only on the current action, location, present objects, nearby people, environment, and unfinished actions.
    The text inside <INTERVENTIONS>...</INTERVENTIONS> must be directly parseable by JavaScript JSON.parse: exactly three non-empty Chinese strings using ASCII double quotes and commas; no Chinese quotation marks, numbering, markdown, or explanation inside the tags.
    Keep the three candidates meaningfully different and realistic. Do not introduce disasters, severe injuries, random relationship revelations, impossible coincidences, unrelated strangers, or events requiring unknown information.
The final output must end exactly with:
<SUMMARY>...</SUMMARY>
<INTERVENTIONS>["...", "...", "..."]</INTERVENTIONS>`;
                const response = await fetch(`${url.trim().replace(/\/$/, '')}/v1/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                    body: JSON.stringify({
                        model: model,
                        messages: [{ role: 'user', content: prompt }],
                        temperature: parseFloat(temperature) || 0.8
                    })
                });

                if (!response.ok) throw new Error(`API 请求失败`);
                const data = await response.json();
                let resultText = String(data.choices?.[0]?.message?.content || '');

                // 清洗可能附带的思考过程
                if (resultText) {
                    let s, e;
                    while ((s = resultText.indexOf('<thinking>')) !== -1) {
                        e = resultText.indexOf('</thinking>', s);
                        if (e === -1) break;
                        resultText = resultText.slice(0, s) + resultText.slice(e + 11);
                                     }
                    resultText = resultText.replace(/```/g, '').trim();
                }
                const interventionSuggestions = parseMonitorInterventionSuggestions(resultText);
                resultText = resultText.replace(/<INTERVENTIONS>[\s\S]*?<\/INTERVENTIONS>/gi, '').trim();
                // 【修改】：剥离总结并存入临时状态
                let summaryText = "Ta刚刚完成了一项隐秘的行程。";
                const summaryMatch = resultText.match(/<SUMMARY>([\s\S]*?)<\/SUMMARY>/i);
                if (summaryMatch) {
                    summaryText = summaryMatch[1].trim();
                    resultText = resultText.replace(/<SUMMARY>[\s\S]*?<\/SUMMARY>/gi, '').trim();
                }
                summaryText = String(summaryText).slice(0, 180);
                window.tempState.currentMonitorSummary = summaryText;
                window.tempState.currentMonitorMessageId = await db.chatMessages.add({
                    chatId: charId, timestamp: new Date(),
                    text: `[系统监控视界｜状态:${monitorStatus}｜发生时间:${monitorOccurredAt}｜这是异地发生的事件，角色并未与用户当面接触] ${summaryText}`,
                    type: 'system', contentType: 'system_event', eventType: 'info',
                    uiVisible: false, aiVisible: true, recalled: false
                });
                // ▼▼▼ 修改：保存完整内容和日程标签，并使用折叠卡片渲染 ▼▼▼
                try {
                    const recordsKey = 'ls_monitor_records_' + charId;
                    const dbRec = await db.appData.get(recordsKey);
                    let records = dbRec ? dbRec.value : [];
                    
                    // 修复未知地点：如果有地点就用地点加事项，没有地点就直接显示事项，去除生硬的“未知地点”提示
                    const labelText = schedule.locName ? `${schedule.locName} - ${schedule.content || ''}` : (schedule.content || '行程事件');
                    
                    records.unshift({
                        time: new Date().toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'}),
                        occurredAt: monitorOccurredAt,
                        status: monitorStatus,
                        label: labelText,
                        summary: summaryText,
                        fullText: resultText ? escapeHTML(resultText).replace(/\n/g, '<br>') : "无详细画面"
                    });
                    await db.appData.put({ key: recordsKey, value: records.slice(0, 100) });
                    
                    // 实时刷新页面上的档案列表
                    if (typeof window.renderMonitorRecords === 'function') {
                        window.renderMonitorRecords(charId);
                    }
                } catch(e) { console.error('保存监控档案失败', e); }
                // ▲▲▲ 修改结束 ▲▲▲

                // 展现结果
                monitorLoadingText.style.display = 'none';
                monitorResultText.style.display = 'block';
                regenerateMonitorBtn.style.display = 'block'; // 显示重新生成按钮
                monitorResultText.innerHTML = resultText ? escapeHTML(resultText).replace(/\n/g, '<br><br>') : "画面信号受到干扰，无法解析...";
                const nowTime = new Date();
                const nowHHMM = nowTime.getHours().toString().padStart(2, '0') + ':' + nowTime.getMinutes().toString().padStart(2, '0');
                if (schedule.startTime <= nowHHMM && schedule.endTime >= nowHHMM) renderMonitorInterventionPanel(charId, schedule, char, interventionSuggestions);

            } catch (err) {
                monitorLoadingText.style.display = 'none';
                monitorResultText.style.display = 'block';
                regenerateMonitorBtn.style.display = 'block';
                monitorResultText.innerHTML = `<span style="color: #ff3b30;">[Error] 数据流解析失败：${escapeHTML(String(err.message || '未知错误'))}</span>`;
            }
        }
        // ▼▼▼ 新增：拦截角色切换操作，强制渲染对应角色的独立档案 (防冲突版) ▼▼▼
        const originalLoadData = window.loadLsDataForChar;
        window.loadLsDataForChar = (charId, forceRender = false) => {
            if (originalLoadData) {
                originalLoadData(charId, forceRender);
                return;
            }
            if (originalLoadData) originalLoadData(charId); // 保留原有逻辑
        };
        // 进页面时自动加载一次当前角色的档案
        if (window.tempState && window.tempState.currentLifeSyncCharId) {
            loadCurrentLifeSyncCharIfVisible();
        }
        // ▲▲▲ 新增结束 ▲▲▲
