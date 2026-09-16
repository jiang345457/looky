import { UI } from '../ui.js';
import { db } from '../state.js';
import { showDynamicIsland } from '../ui.js'; // 确保 showDynamicIsland 被正确导入
const FONT_SETTING_KEY = 'customFontUrl';
const FONT_STYLE_ELEMENT_ID = 'custom-font-style';
const CUSTOM_FONT_FAMILY_NAME = 'CustomAppFont';
/**
 * 将字体URL应用到页面上，并返回一个Promise来追踪加载状态
 * @param {string} fontUrl 字体文件的URL
 * @returns {Promise<void>}
 */
const applyFont = (fontUrl) => {
    return new Promise((resolve, reject) => {
        const oldStyleElement = document.getElementById(FONT_STYLE_ELEMENT_ID);
        if (oldStyleElement) {
            oldStyleElement.remove();
        }

        if (!fontUrl || fontUrl.trim() === '') {
            document.documentElement.style.removeProperty('--custom-font-family');
            console.log('自定义字体已清除。');
            resolve(); // 清除字体视为成功
            return;
        }

        try {
            new URL(fontUrl);
        } catch (_) {
            console.error('提供的字体URL无效:', fontUrl);
            reject(new Error('字体链接格式不正确'));
            return;
        }

        const styleElement = document.createElement('style');
        styleElement.id = FONT_STYLE_ELEMENT_ID;

        styleElement.textContent = `
            @font-face {
                font-family: '${CUSTOM_FONT_FAMILY_NAME}';
                src: url('${fontUrl}');
                font-display: swap;
            }
        `;

        document.head.appendChild(styleElement);

        // 使用 document.fonts API 检查字体是否加载成功
        document.fonts.load(`1em ${CUSTOM_FONT_FAMILY_NAME}`)
            .then((fonts) => {
                if (fonts.length > 0) {
                    document.documentElement.style.setProperty('--custom-font-family', CUSTOM_FONT_FAMILY_NAME);
                    console.log(`自定义字体 '${CUSTOM_FONT_FAMILY_NAME}' 已应用。`);
                    resolve();
                } else {
                    // 虽然load成功，但没有找到匹配的字体，这通常意味着URL是错的(404/403)
                    console.error('字体加载失败：URL可能无效或资源不可访问。');
                    reject(new Error('加载失败, 链接无效'));
                }
            })
            .catch((error) => {
                console.error('字体加载时发生网络或解析错误:', error);
                reject(new Error('加载失败, 检查网络'));
            });
    });
};

/**
 * 保存字体设置并应用，带有加载状态提示
 */
const saveAndApplyFont = async () => {
    const fontUrl = UI.fontUrlInput.value.trim();
    const saveButton = UI.saveFontButton;

    // 1. 即时反馈：禁用按钮并显示加载中
    saveButton.disabled = true;
    saveButton.textContent = '应用中...';
    showDynamicIsland('字体加载中...');

    try {
        // 2. 应用字体并等待结果
        await applyFont(fontUrl);

        // 3. 成功后，保存设置并显示成功提示
        await db.appData.put({ key: FONT_SETTING_KEY, value: fontUrl });
        showDynamicIsland(fontUrl ? '字体设置已保存！' : '字体已清除！');

    } catch (error) {
        // 4. 失败后，显示错误提示
        // 从 Error 对象中获取更具体的消息
        showDynamicIsland(error.message || '保存失败，请重试');

        // 如果失败，最好把无效的样式也清除掉
        const oldStyleElement = document.getElementById(FONT_STYLE_ELEMENT_ID);
        if (oldStyleElement) oldStyleElement.remove();
        document.documentElement.style.removeProperty('--custom-font-family');

    } finally {
        // 5. 状态恢复：无论成功失败，恢复按钮状态
        saveButton.disabled = false;
        saveButton.textContent = '应用';
    }
};


/**
 * 初始化字体设置模块
 */
const init = async () => {
    if (window.__screenFontSettingsHandled) {
        console.log('字体设置已由屏幕设置模块接管，跳过旧模块绑定。');
        return;
    }
    console.log('字体设置模块初始化...');
    UI.saveFontButton.addEventListener('click', saveAndApplyFont);
    // 【新增】启动时加载并应用已保存的字体设置
    try {
        const setting = await db.appData.get(FONT_SETTING_KEY);
        // 检查 setting 是否存在，并且它的 value 是一个非空字符串
        if (setting && setting.value) {
            console.log('发现已保存的字体设置，正在应用:', setting.value);
            // 将保存的URL填回输入框，方便用户查看和修改
            UI.fontUrlInput.value = setting.value;
            
            // "静默"应用字体，不显示灵动岛提示。如果失败，只在控制台报错。
            await applyFont(setting.value);
            console.log('已保存的字体应用成功。');
        }
    } catch (error) {
        // 如果在启动时加载失败（比如数据库读取错误或字体URL失效），
        // 就在控制台记录一个错误，但不要打扰用户。
        console.error('启动时自动加载自定义字体失败:', error);
    }
};
export const fontSettings = {
    init,
};
