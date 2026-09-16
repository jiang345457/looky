// 文件路径: /js/features/gallery-settings.js (这是新文件)

import { AppState, saveGallerySettings } from '../state.js';
import { showDynamicIsland, showPage } from '../ui.js';
import { escapeHTML } from '../utils.js';
import { initializeSimilarityPipeline, isAiEngineAvailable, resetSimilarityPipeline } from './gallery.js';
import { getImageGenSettings, saveImageGenSettings } from './image-gen.js';

// --- DOM 元素引用 ---
const page = document.getElementById('gallery-settings-page');
const closeBtn = document.getElementById('gallery-settings-close-btn');
const toggle = document.getElementById('ai-search-toggle');
const sliderContainer = document.getElementById('ai-threshold-container');
const slider = document.getElementById('ai-threshold-slider');
const sliderValue = document.getElementById('ai-threshold-value');
const sliderHint = document.getElementById('ai-threshold-hint');
const imageGenMatchModeSelect = document.getElementById('image-gen-match-mode-select');
const imageGenMatchModeTrigger = document.getElementById('image-gen-match-mode-trigger');
const imageGenMatchModeValue = document.getElementById('image-gen-match-mode-value');
const imageGenQualitySuffixInput = document.getElementById('image-gen-quality-suffix-input');
const imageGenNegativePromptInput = document.getElementById('image-gen-negative-prompt-input');
const imageGenGeneralSaveBtn = document.getElementById('image-gen-general-save-btn');
const imageGenStylePresetSelect = document.getElementById('image-gen-style-preset-select');
const imageGenStylePresetTrigger = document.getElementById('image-gen-style-preset-trigger');
const imageGenStylePresetValue = document.getElementById('image-gen-style-preset-value');
const imageGenStylePresetNameInput = document.getElementById('image-gen-style-preset-name-input');
const imageGenStylePresetSaveBtn = document.getElementById('image-gen-style-preset-save-btn');
const imageGenStylePresetDeleteBtn = document.getElementById('image-gen-style-preset-delete-btn');
const imageGenChatScopeToggle = document.getElementById('image-gen-chat-scope-toggle');
const imageGenMomentsScopeToggle = document.getElementById('image-gen-moments-scope-toggle');
const imageGenScopePanel = imageGenChatScopeToggle?.closest('.settings-row')?.parentElement;

const IMAGE_GEN_MATCH_MODE_LABELS = {
    match_only: '纯匹配相册',
    gen_only: '纯生图',
    match_then_gen: '匹配不到再生图'
};

function readImageGenAuthorizedScenesFromUi(fallback = {}) {
    return {
        chat: imageGenChatScopeToggle ? Boolean(imageGenChatScopeToggle.checked) : fallback.chat !== false,
        moments: imageGenMomentsScopeToggle ? Boolean(imageGenMomentsScopeToggle.checked) : fallback.moments === true
    };
}

function syncImageGenAuthorizedScenes(settings = {}) {
    const scenes = settings.authorizedScenes || {};
    if (imageGenChatScopeToggle) imageGenChatScopeToggle.checked = scenes.chat !== false;
    if (imageGenMomentsScopeToggle) imageGenMomentsScopeToggle.checked = scenes.moments === true;
}

async function saveImageGenAuthorizedScenesFromUi() {
    const settings = await getImageGenSettings();
    await saveImageGenSettings({
        ...settings,
        authorizedScenes: readImageGenAuthorizedScenesFromUi(settings.authorizedScenes || {})
    });
}

function openGalleryChoiceModal(title, options, currentValue, onSelect) {
    const overlay = document.createElement('div');
    overlay.className = 'gallery-choice-overlay';
    overlay.innerHTML = `
        <div class="gallery-choice-card">
            <div class="gallery-choice-header">
                <h3>${escapeHTML(title)}</h3>
                <button type="button" data-close="1">关闭</button>
            </div>
            <div class="gallery-choice-list">
                ${options.map(item => `
                    <button type="button" class="gallery-choice-option ${item.value === currentValue ? 'selected' : ''}" data-value="${escapeHTML(item.value)}">
                        <span>${escapeHTML(item.label)}</span>
                        ${item.value === currentValue ? '<b>✓</b>' : ''}
                    </button>
                `).join('')}
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', event => {
        if (event.target === overlay || event.target.dataset.close) {
            overlay.remove();
            return;
        }
        const button = event.target.closest('.gallery-choice-option');
        if (!button) return;
        onSelect(button.dataset.value);
        overlay.remove();
    });
}

function renderImageGenStylePresetOptions(settings) {
    if (!imageGenStylePresetSelect) return;
    imageGenStylePresetSelect.innerHTML = (settings.stylePresets || [])
        .map(item => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.name)}</option>`)
        .join('');
    imageGenStylePresetSelect.value = settings.activeStylePresetId || settings.stylePresets?.[0]?.id || 'default';
    syncSelectedImageGenStylePreset(settings);
    updateImageGenChoiceDisplays(settings);
}

function syncSelectedImageGenStylePreset(settings, { applyPrompt = false } = {}) {
    if (!imageGenStylePresetSelect || !imageGenStylePresetNameInput) return;
    const selected = (settings.stylePresets || []).find(item => item.id === imageGenStylePresetSelect.value);
    imageGenStylePresetNameInput.value = selected?.name || '';
    if (applyPrompt) {
        if (imageGenQualitySuffixInput) imageGenQualitySuffixInput.value = selected?.prompt || '';
        if (imageGenNegativePromptInput) imageGenNegativePromptInput.value = selected?.negativePrompt || '';
    }
}

function updateImageGenChoiceDisplays(settings = AppState.imageGenSettings || {}) {
    if (imageGenMatchModeValue && imageGenMatchModeSelect) {
        imageGenMatchModeValue.textContent = IMAGE_GEN_MATCH_MODE_LABELS[imageGenMatchModeSelect.value] || '匹配不到再生图';
    }
    if (imageGenStylePresetValue && imageGenStylePresetSelect) {
        const selected = (settings.stylePresets || []).find(item => item.id === imageGenStylePresetSelect.value);
        imageGenStylePresetValue.textContent = selected?.name || '默认';
    }
}

async function syncUiToState() {
    const settings = AppState.gallerySettings;
    toggle.checked = settings.isAiEnabled;
    const imageGenSettings = await getImageGenSettings();
    syncImageGenAuthorizedScenes(imageGenSettings);
    if (imageGenMatchModeSelect) imageGenMatchModeSelect.value = imageGenSettings.matchMode || 'match_then_gen';
    if (imageGenQualitySuffixInput) imageGenQualitySuffixInput.value = imageGenSettings.qualitySuffix || '';
    if (imageGenNegativePromptInput) imageGenNegativePromptInput.value = imageGenSettings.negativePrompt || '';
    renderImageGenStylePresetOptions(imageGenSettings);
    updateImageGenChoiceDisplays(imageGenSettings);
    updateSliderUI();
}

function updateSliderUI() {
    const settings = AppState.gallerySettings;
    const isAI = settings.isAiEnabled && isAiEngineAvailable();
    
    const threshold = isAI ? settings.aiThreshold : settings.fallbackThreshold;
    const hintText = isAI 
        ? "当前为AI智能匹配。数值越高越精准。" 
        : "当前为内置关键词匹配。建议值较低。";

    slider.value = Math.round(threshold * 100);
    sliderValue.textContent = threshold.toFixed(2);
    sliderHint.textContent = hintText;
}

async function handleToggleChange() {
    const isEnabled = toggle.checked;
    AppState.gallerySettings.isAiEnabled = isEnabled;
    
    if (isEnabled && !isAiEngineAvailable()) {
        showDynamicIsland('正在下载AI模型, 请稍候...', 'loading', 3000);
        try {
            await initializeSimilarityPipeline();
            showDynamicIsland('AI模型加载成功！', 'success');
        } catch (error) {
            showDynamicIsland('AI模型加载失败，将使用备用方案', 'error');
            toggle.checked = false;
            AppState.gallerySettings.isAiEnabled = false;
        }
    }

    updateSliderUI();
    saveGallerySettings();
}

function handleSliderChange() {
    const value = parseInt(slider.value, 10) / 100;
    const isAI = AppState.gallerySettings.isAiEnabled && isAiEngineAvailable();

    if (isAI) {
        AppState.gallerySettings.aiThreshold = value;
    } else {
        AppState.gallerySettings.fallbackThreshold = value;
    }
    
    sliderValue.textContent = value.toFixed(2);
    saveGallerySettings();
}

function openModal(event) {
    syncUiToState();
    showPage('gallery-settings-page');
    if (event?.detail?.focusImageGen && imageGenScopePanel) {
        setTimeout(() => {
            imageGenScopePanel.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }, 50);
    }
}

function closeModal() {
    showPage('page-gallery');
}

// 文件: /js/features/gallery-settings.js

// ▼▼▼ 使用下面这个【最终版】函数，完整替换掉你文件中现有的 setupGallerySettings 函数 ▼▼▼

export function setupGallerySettings() {
    if (!page || !closeBtn || !toggle || !slider) return;
    const settingsRow = toggle.closest('.settings-row');
    const uninstallBtn = document.getElementById('uninstall-ai-engine-btn'); // <-- 新增: 获取按钮

    document.addEventListener('open-gallery-settings', openModal);
    closeBtn.addEventListener('click', closeModal);
    toggle.addEventListener('change', handleToggleChange);

    if (settingsRow) {
        settingsRow.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'LABEL') {
                toggle.checked = !toggle.checked;
                toggle.dispatchEvent(new Event('change'));
            }
        });
    }
    
    slider.addEventListener('input', () => {
         sliderValue.textContent = (parseInt(slider.value, 10) / 100).toFixed(2);
    });
    slider.addEventListener('change', handleSliderChange);

    imageGenChatScopeToggle?.addEventListener('change', saveImageGenAuthorizedScenesFromUi);
    imageGenMomentsScopeToggle?.addEventListener('change', saveImageGenAuthorizedScenesFromUi);

    if (imageGenGeneralSaveBtn) {
        imageGenGeneralSaveBtn.addEventListener('click', async () => {
            const settings = await getImageGenSettings();
            await saveImageGenSettings({
                ...settings,
                authorizedScenes: readImageGenAuthorizedScenesFromUi(settings.authorizedScenes || {}),
                matchMode: imageGenMatchModeSelect?.value || 'match_then_gen',
                qualitySuffix: imageGenQualitySuffixInput?.value.trim() || '',
                negativePrompt: imageGenNegativePromptInput?.value.trim() || '',
                activeStylePresetId: imageGenStylePresetSelect?.value || settings.activeStylePresetId
            });
            showDynamicIsland('生图总设置已保存');
        });
    }

    imageGenMatchModeTrigger?.addEventListener('click', () => {
        const options = Object.entries(IMAGE_GEN_MATCH_MODE_LABELS).map(([value, label]) => ({ value, label }));
        openGalleryChoiceModal('选择聊天图片模式', options, imageGenMatchModeSelect?.value || 'match_then_gen', value => {
            if (!imageGenMatchModeSelect) return;
            imageGenMatchModeSelect.value = value;
            updateImageGenChoiceDisplays();
        });
    });

    imageGenStylePresetTrigger?.addEventListener('click', async () => {
        const settings = await getImageGenSettings();
        const options = (settings.stylePresets || []).map(item => ({ value: item.id, label: item.name }));
        openGalleryChoiceModal('选择生图提示词方案', options, imageGenStylePresetSelect?.value || settings.activeStylePresetId, value => {
            if (!imageGenStylePresetSelect) return;
            imageGenStylePresetSelect.value = value;
            imageGenStylePresetSelect.dispatchEvent(new Event('change'));
        });
    });

    imageGenStylePresetSelect?.addEventListener('change', async () => {
        const settings = await getImageGenSettings();
        syncSelectedImageGenStylePreset(settings, { applyPrompt: true });
        await saveImageGenSettings({
            ...settings,
            activeStylePresetId: imageGenStylePresetSelect.value,
            qualitySuffix: imageGenQualitySuffixInput?.value.trim() || '',
            negativePrompt: imageGenNegativePromptInput?.value.trim() || ''
        });
        updateImageGenChoiceDisplays(settings);
    });

    imageGenStylePresetSaveBtn?.addEventListener('click', async () => {
        const settings = await getImageGenSettings();
        const name = imageGenStylePresetNameInput?.value.trim();
        const prompt = imageGenQualitySuffixInput?.value.trim() || '';
        const negativePrompt = imageGenNegativePromptInput?.value.trim() || '';
        if (!name) {
            showDynamicIsland('请先填写方案名称');
            return;
        }
        const presets = [...(settings.stylePresets || [])];
        const existingIndex = presets.findIndex(item => item.name === name);
        let targetId;
        if (existingIndex >= 0) {
            targetId = presets[existingIndex].id;
            presets[existingIndex] = { id: targetId, name, prompt, negativePrompt };
        } else {
            targetId = `preset_${Date.now()}`;
            presets.push({ id: targetId, name, prompt, negativePrompt });
        }
        const nextSettings = await saveImageGenSettings({
            ...settings,
            stylePresets: presets,
            activeStylePresetId: targetId,
            qualitySuffix: prompt,
            negativePrompt
        });
        renderImageGenStylePresetOptions(nextSettings);
        updateImageGenChoiceDisplays(nextSettings);
        showDynamicIsland(existingIndex >= 0 ? '方案已更新' : '已保存为新方案');
    });

    imageGenStylePresetDeleteBtn?.addEventListener('click', async () => {
        const settings = await getImageGenSettings();
        const selectedId = imageGenStylePresetSelect?.value;
        const presets = (settings.stylePresets || []).filter(item => item.id !== selectedId);
        if (!selectedId || presets.length === 0) {
            showDynamicIsland('至少保留一个生图提示词方案');
            return;
        }
        const nextSettings = await saveImageGenSettings({ ...settings, stylePresets: presets, activeStylePresetId: presets[0].id });
        renderImageGenStylePresetOptions(nextSettings);
        updateImageGenChoiceDisplays(nextSettings);
        showDynamicIsland('生图提示词方案已删除');
    });

    // ▼▼▼ 【核心新增】卸载功能的事件监听器 ▼▼▼
    if (uninstallBtn) {
        uninstallBtn.addEventListener('click', async () => {
            // 1. 友好提示，防止误操作
            const confirmed = confirm("您确定要卸载AI搜索引擎吗？\n这将删除本地缓存的AI模型文件，下次使用需要重新下载。");
            if (!confirmed) {
                return;
            }

            showDynamicIsland('正在卸载AI引擎...', 'loading');

            try {
                // 2. 【关键】自动关闭开关并触发更新
                if (toggle.checked) {
                    toggle.checked = false;
                    // 手动触发change事件来更新UI和保存设置状态
                    toggle.dispatchEvent(new Event('change')); 
                }
                
                // 3. 清除浏览器缓存中的模型文件
                // transformers.js 默认使用的缓存名称是 'transformers-cache'
                const cacheExists = await caches.has('transformers-cache');
                if (cacheExists) {
                    await caches.delete('transformers-cache');
                }

                // 4. 重置AI引擎状态（如果它已加载到内存中）
                // 这是一个好的实践，虽然刷新页面也能解决
                resetSimilarityPipeline();

                showDynamicIsland('✅ AI引擎已成功卸载', 'success', 2000);
                
                // 5. 卸载完成后自动关闭设置弹窗
                closeModal();

            } catch (error) {
                console.error("卸载AI引擎失败:", error);
                showDynamicIsland('卸载失败，请重试', 'error', 3000);
            }
        });
    }
    // ▲▲▲ 新增结束 ▲▲▲
}

// ▲▲▲ 替换结束 ▲▲▲

