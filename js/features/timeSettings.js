// ▼▼▼ 用下面的所有代码，完整替换掉 timeSettings.js 文件的全部内容 ▼▼▼

/**
 * timeSettings.js
 * -----------------------
 * 负责管理“时间设置”弹窗的所有交互逻辑。
 * 【已修正为支持分角色独立设置】
 */

// 引入全局状态和数据库模块
import { AppState, db, tempState } from '../state.js';

// --- 1. 获取所有需要的DOM元素 ---
const timePerceptionSwitch = document.getElementById('time-perception-switch');
const timestampCenterIntervalInput = document.getElementById('timestamp-center-interval-input');
const outsideModeSelect = document.getElementById('timestamp-outside-mode'); 
const centerOptionContainer = document.getElementById('timestamp-center-option-container');
const centerOptionTrigger = document.getElementById('timestamp-center-option-trigger');
const stylePickerDropdown = document.getElementById('timestamp-style-picker');


// --- 2. 核心功能函数 ---

/**
 * 从指定角色的档案中加载并应用时间设置到UI上
 * @param {object} settings - 从角色档案中读取的 timeSettings 对象
 */
function loadTimeSettings(settings) {
    // 如果角色没有设置，就使用一套默认值来显示
    const effectiveSettings = settings || {
        perceptionEnabled: true,
        position: 'none',
        centerInterval: 30,
        outsideMode: 'always',
        centerStyle: 'pill-center',
    };

    timePerceptionSwitch.checked = effectiveSettings.perceptionEnabled;

    const positionRadio = document.querySelector(`input[name="timestamp-position"][value="${effectiveSettings.position}"]`);
    if (positionRadio) {
        positionRadio.checked = true;
    }

    timestampCenterIntervalInput.value = effectiveSettings.centerInterval;
    outsideModeSelect.value = effectiveSettings.outsideMode;

    if (stylePickerDropdown) {
        const currentStyle = effectiveSettings.centerStyle;
        const options = stylePickerDropdown.querySelectorAll('.style-option');
        options.forEach(opt => {
            opt.classList.toggle('selected', opt.dataset.style === currentStyle);
        });
    }
}

/**
 * 【已修正】从UI收集当前所有设置，并保存到当前角色的数据库档案中
 */
async function saveTimeSettings() {
    // 首先，必须知道我们正在为哪个角色设置
    const charId = tempState.currentChatId;
    if (!charId) {
        console.error("无法保存时间设置，因为没有当前聊天角色ID。");
        // 安全起见，直接关闭弹窗
        const timeSettingsModal = document.getElementById('time-settings-modal');
        if (timeSettingsModal) timeSettingsModal.classList.remove('visible');
        return;
    }

    // 从UI界面收集所有选项的值
    const perceptionEnabled = timePerceptionSwitch.checked;
    const position = document.querySelector('input[name="timestamp-position"]:checked').value;
    const centerInterval = parseInt(timestampCenterIntervalInput.value, 10);
    const outsideMode = outsideModeSelect.value;
    const selectedStyleOption = stylePickerDropdown.querySelector('.style-option.selected');
    const centerStyle = selectedStyleOption ? selectedStyleOption.dataset.style : 'pill-center';

    // 组装成一个新的设置对象
    const newSettings = {
        perceptionEnabled,
        position,
        centerInterval: isNaN(centerInterval) ? 30 : centerInterval,
        outsideMode,
        centerStyle,
    };

    try {
        // --- 【核心修正：保存到角色档案】 ---
        // 1. 更新数据库中对应角色的 timeSettings 字段
        await db.characterProfiles.update(charId, { timeSettings: newSettings });

        // 2. 同步更新内存中的 AppState，让更改立刻生效
        const charInState = AppState.characterProfiles.find(c => c.id === charId);
        if (charInState) {
            charInState.timeSettings = newSettings;
            console.log(`角色 ${charInState.name} 的时间戳设置已更新并保存。`);
        }
    } catch (error) {
        console.error(`保存角色 ${charId} 的时间戳设置失败:`, error);
    }

    // 1. 找到聊天界面里所有已经存在的时间戳元素
    const existingTimestamps = document.querySelectorAll('.chat-timestamp');
    
    // 2. 遍历每一个时间戳元素
    existingTimestamps.forEach(tsEl => {
        // 移除旧的样式类 (pill-center 或 simple-center)
        tsEl.classList.remove('chat-timestamp--pill-center', 'chat-timestamp--simple-center');
        
        // 如果新设置是不显示 (none)，就直接隐藏它
        if (newSettings.position !== 'center') {
            tsEl.style.display = 'none';
        } else {
            // 否则，让它显示出来，并添加上新的样式类
            tsEl.style.display = ''; // 恢复默认显示
            tsEl.classList.add(`chat-timestamp--${newSettings.centerStyle}`);
        }
    });
    const { loadAndRenderChatHistory } = await import('./chat-ui.js');
await loadAndRenderChatHistory(tempState.currentChatId, true); // 假设在线模式

    // 关闭弹窗
    const timeSettingsModal = document.getElementById('time-settings-modal');
    if (timeSettingsModal) {
        timeSettingsModal.classList.remove('visible');
    }
}

/**
 * 初始化样式选择下拉菜单的交互
 */
function initStylePicker() {
    if (!centerOptionContainer || !centerOptionTrigger || !stylePickerDropdown) return;

    const arrow = centerOptionTrigger.querySelector('.dropdown-arrow');
    const options = stylePickerDropdown.querySelectorAll('.style-option');

    function closeDropdown() {
        stylePickerDropdown.classList.remove('active');
        arrow.classList.remove('active');
        centerOptionContainer.classList.remove('dropdown-open');
    }

    centerOptionTrigger.addEventListener('click', (event) => {
        event.stopPropagation();
        const isActive = stylePickerDropdown.classList.toggle('active');
        arrow.classList.toggle('active', isActive);
        centerOptionContainer.classList.toggle('dropdown-open', isActive);
    });

    options.forEach(option => {
        option.addEventListener('click', (event) => {
            event.stopPropagation();
            options.forEach(opt => opt.classList.remove('selected'));
            option.classList.add('selected');
            closeDropdown();
            // 注意：这里不再自动保存，由关闭按钮统一保存
        });
    });

    document.addEventListener('click', (event) => {
        if (stylePickerDropdown.classList.contains('active') && !centerOptionContainer.contains(event.target)) {
            closeDropdown();
        }
    });
}

// --- 3. 总初始化函数 ---

export function initTimeSettings() {
    const closeButton = document.getElementById('close-time-settings-btn');
    const triggerButton = document.getElementById('time-settings-trigger');
    const timeSettingsModal = document.getElementById('time-settings-modal');

    if (!triggerButton || !timeSettingsModal || !closeButton) {
        console.error('时间设置模块的关键UI元素缺失！');
        return;
    }

    // 当用户点击“时间设置”按钮时...
    triggerButton.addEventListener('click', () => {
        // 找到当前正在聊天的角色
        const charId = tempState.currentChatId;
        const character = AppState.characterProfiles.find(c => c.id === charId);
        
        if (!character) {
            alert('请先进入一个聊天窗口再进行设置。');
            return;
        }

        // 从这个角色的档案中加载他专属的时间戳设置
        loadTimeSettings(character.timeSettings);
        timeSettingsModal.classList.add('visible');
    });

    // 当用户点击“关闭”或弹窗外部时，保存设置
    closeButton.addEventListener('click', saveTimeSettings);
    timeSettingsModal.addEventListener('click', (event) => {
        if (event.target === timeSettingsModal) {
            saveTimeSettings();
        }
    });
    
    initStylePicker();

    console.log('分角色时间设置模块初始化完毕。');
}
