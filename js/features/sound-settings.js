// /js/features/sound-settings.js

import { AppState, db } from '../state.js';
import { showDynamicIsland } from '../ui.js';
import { TTSService } from './tts-service.js';
import { fetchVoiceRecognitionModels } from './speech-service.js';

// 获取页面上的所有UI元素
const elements = {
    providerSelect: null,
    minimaxSettingsCard: null,
    minimaxModelCard: null,
    elevenLabsSettingsCard: null,
    endpointSelect: null,
    groupIdInput: null,
    apiKeyInput: null,
    modelInput: null, 
    elevenLabsApiKeyInput: null,
    elevenLabsModelInput: null,
    elevenLabsOutputFormatInput: null,
    voiceRecognitionProviderSelect: null,
    voiceRecognitionEndpointInput: null,
    voiceRecognitionApiKeyInput: null,
    voiceRecognitionModelInput: null,
    voiceRecognitionModelSelectBtn: null,
    voiceRecognitionModelRefreshBtn: null,
    voiceRecognitionModelOptions: null,
    voiceRecognitionModelModalOverlay: null,
    voiceRecognitionModelList: null,
    voiceRecognitionModelModalCancelBtn: null,
    voiceRecognitionLanguageSelect: null,
    voiceRecognitionApiCard: null,
    autoplayToggle: null,
    saveBtn: null,
};

let voiceRecognitionModels = [];

function ensureTtsSettingsShape() {
    AppState.ttsGlobalSettings = AppState.ttsGlobalSettings || {};
    AppState.ttsGlobalSettings.provider = AppState.ttsGlobalSettings.provider || 'minimax';
    AppState.ttsGlobalSettings.minimax = AppState.ttsGlobalSettings.minimax || {};
    AppState.ttsGlobalSettings.elevenlabs = {
        apiKey: '',
        model: 'eleven_multilingual_v2',
        outputFormat: 'mp3_44100_128',
        ...(AppState.ttsGlobalSettings.elevenlabs || {})
    };
}

function ensureVoiceRecognitionSettingsShape() {
    AppState.voiceRecognitionSettings = {
        provider: 'browser',
        endpoint: '',
        apiKey: '',
        model: '',
        language: 'zh',
        ...(AppState.voiceRecognitionSettings || {})
    };
}

function normalizeVoiceRecognitionEndpoint(value) {
    let endpoint = String(value || '').trim().replace(/\/+$/, '');
    if (!endpoint) return '';
    endpoint = endpoint.replace(/\/audio\/transcriptions$/i, '');
    return /\/v1$/i.test(endpoint) ? endpoint : `${endpoint}/v1`;
}

function normalizeVoiceRecognitionEndpointInput() {
    const endpoint = normalizeVoiceRecognitionEndpoint(elements.voiceRecognitionEndpointInput?.value);
    if (endpoint && elements.voiceRecognitionEndpointInput) {
        elements.voiceRecognitionEndpointInput.value = endpoint;
    }
    return endpoint;
}

function toggleVoiceRecognitionSettings() {
    const isApi = elements.voiceRecognitionProviderSelect?.value === 'api';
    if (elements.voiceRecognitionApiCard) elements.voiceRecognitionApiCard.style.display = isApi ? '' : 'none';
}

function renderVoiceRecognitionModelOptions(models = []) {
    voiceRecognitionModels = [...new Set(models.map(model => String(model || '').trim()).filter(Boolean))];
    if (!elements.voiceRecognitionModelOptions) return;
    elements.voiceRecognitionModelOptions.innerHTML = '';
    voiceRecognitionModels.forEach(model => {
        const option = document.createElement('option');
        option.value = model;
        elements.voiceRecognitionModelOptions.appendChild(option);
    });
}

function populateVoiceRecognitionModelModal() {
    const list = elements.voiceRecognitionModelList;
    const overlay = elements.voiceRecognitionModelModalOverlay;
    if (!list || !overlay) return;

    list.innerHTML = '';
    if (voiceRecognitionModels.length > 0) {
        const fragment = document.createDocumentFragment();
        voiceRecognitionModels.forEach(model => {
            const item = document.createElement('li');
            item.className = `selection-list-item ${model === elements.voiceRecognitionModelInput.value ? 'selected' : ''}`;
            item.dataset.model = model;
            item.textContent = model;
            fragment.appendChild(item);
        });
        list.appendChild(fragment);
    } else {
        list.innerHTML = '<li class="selection-list-item" style="justify-content:center; color:#8e8e93;">请先拉取模型</li>';
    }
    overlay.classList.add('visible');
}

function toggleProviderSettings() {
    const provider = elements.providerSelect?.value || 'minimax';
    const isElevenLabs = provider === 'elevenlabs';
    if (elements.minimaxSettingsCard) elements.minimaxSettingsCard.style.display = isElevenLabs ? 'none' : '';
    if (elements.minimaxModelCard) elements.minimaxModelCard.style.display = isElevenLabs ? 'none' : '';
    if (elements.elevenLabsSettingsCard) elements.elevenLabsSettingsCard.style.display = isElevenLabs ? '' : 'none';
}

/**
 * 从 AppState 读取设置并填充到UI上
 */
function loadSettingsToUI() {
    ensureTtsSettingsShape();
    ensureVoiceRecognitionSettingsShape();
    const config = AppState.ttsGlobalSettings.minimax;
    const elevenLabsConfig = AppState.ttsGlobalSettings.elevenlabs;
    
    elements.providerSelect.value = AppState.ttsGlobalSettings.provider || 'minimax';
    elements.endpointSelect.value = config.endpoint;
    elements.groupIdInput.value = config.groupId;
    elements.apiKeyInput.value = config.apiKey;
    elements.elevenLabsApiKeyInput.value = elevenLabsConfig.apiKey || '';
    elements.elevenLabsModelInput.value = elevenLabsConfig.model || 'eleven_multilingual_v2';
    elements.elevenLabsOutputFormatInput.value = elevenLabsConfig.outputFormat || 'mp3_44100_128';
    
    // --- 新逻辑：处理 modelInput (现在是 select) ---
    const savedModel = config.model;
    const select = elements.modelInput;
    // 移除之前可能存在的动态添加的自定义选项
    const existingCustomOption = select.querySelector('option[data-custom-option]');
    if (existingCustomOption) {
        existingCustomOption.remove();
    }
    // 检查 savedModel 是否在预设选项中
    let isPreset = false;
    for (const option of select.options) {
        if (option.value === savedModel) {
            isPreset = true;
            break;
        }
    }
    // 如果 savedModel 不在预设中，说明是自定义的，需要动态添加并选中它
    if (savedModel && !isPreset) {
        const customOption = document.createElement('option');
        customOption.value = savedModel;
        customOption.textContent = savedModel;
        customOption.dataset.customOption = 'true'; // 添加标记，方便下次移除
        // 插入到"自定义..."选项之前
        select.insertBefore(customOption, select.querySelector('option[value="custom"]'));
    }
    
    // 最后，设置 select 的值为保存的值
    select.value = savedModel;
    elements.autoplayToggle.checked = AppState.ttsGlobalSettings.autoPlay;
    if (elements.voiceRecognitionProviderSelect) {
        elements.voiceRecognitionProviderSelect.value = AppState.voiceRecognitionSettings.provider;
        elements.voiceRecognitionEndpointInput.value = normalizeVoiceRecognitionEndpoint(AppState.voiceRecognitionSettings.endpoint);
        elements.voiceRecognitionApiKeyInput.value = AppState.voiceRecognitionSettings.apiKey;
        elements.voiceRecognitionModelInput.value = AppState.voiceRecognitionSettings.model;
        elements.voiceRecognitionLanguageSelect.value = AppState.voiceRecognitionSettings.language || 'zh';
    }
    toggleProviderSettings();
    toggleVoiceRecognitionSettings();
}
/**
 * 从UI读取设置并保存到 AppState 和数据库
 */
async function saveSettingsFromUI() {
    ensureTtsSettingsShape();
    ensureVoiceRecognitionSettingsShape();
    // 更新 AppState
    AppState.ttsGlobalSettings.provider = elements.providerSelect.value;
    AppState.ttsGlobalSettings.minimax.endpoint = elements.endpointSelect.value;
    AppState.ttsGlobalSettings.minimax.groupId = elements.groupIdInput.value.trim();
    AppState.ttsGlobalSettings.minimax.apiKey = elements.apiKeyInput.value.trim();
    AppState.ttsGlobalSettings.minimax.model = elements.modelInput.value.trim();
    AppState.ttsGlobalSettings.elevenlabs.apiKey = elements.elevenLabsApiKeyInput.value.trim();
    AppState.ttsGlobalSettings.elevenlabs.model = elements.elevenLabsModelInput.value.trim() || 'eleven_multilingual_v2';
    AppState.ttsGlobalSettings.elevenlabs.outputFormat = elements.elevenLabsOutputFormatInput.value.trim() || 'mp3_44100_128';
    AppState.ttsGlobalSettings.autoPlay = elements.autoplayToggle.checked;
    if (elements.voiceRecognitionProviderSelect) {
        AppState.voiceRecognitionSettings.provider = elements.voiceRecognitionProviderSelect.value;
        AppState.voiceRecognitionSettings.endpoint = normalizeVoiceRecognitionEndpointInput();
        AppState.voiceRecognitionSettings.apiKey = elements.voiceRecognitionApiKeyInput.value.trim();
        AppState.voiceRecognitionSettings.model = elements.voiceRecognitionModelInput.value.trim();
        AppState.voiceRecognitionSettings.language = elements.voiceRecognitionLanguageSelect.value;
    }

    // 持久化保存到数据库
    try {
        const records = [{ key: 'ttsGlobalSettings', value: AppState.ttsGlobalSettings }];
        if (elements.voiceRecognitionProviderSelect) {
            records.push({ key: 'voiceRecognitionSettings', value: AppState.voiceRecognitionSettings });
        }
        await db.appData.bulkPut(records);
        showDynamicIsland("🔊 语音设置已保存", "success");
    } catch (error) {
        console.error("保存语音设置失败:", error);
        showDynamicIsland("保存失败", "error");
    }
}

/**
 * 绑定所有事件监听器
 */
function bindEvents() {
    elements.saveBtn.addEventListener('click', saveSettingsFromUI);
    elements.providerSelect.addEventListener('change', toggleProviderSettings);
    elements.voiceRecognitionProviderSelect?.addEventListener('change', toggleVoiceRecognitionSettings);
    elements.voiceRecognitionModelRefreshBtn?.addEventListener('click', async () => {
        const button = elements.voiceRecognitionModelRefreshBtn;
        ensureVoiceRecognitionSettingsShape();
        AppState.voiceRecognitionSettings.endpoint = normalizeVoiceRecognitionEndpointInput();
        AppState.voiceRecognitionSettings.apiKey = elements.voiceRecognitionApiKeyInput?.value.trim() || '';
        const originalText = button.textContent;
        try {
            button.disabled = true;
            button.textContent = '拉取中';
            showDynamicIsland('正在拉取语音模型...');
            const models = await fetchVoiceRecognitionModels();
            renderVoiceRecognitionModelOptions(models);
            if (models.length > 0) populateVoiceRecognitionModelModal();
            showDynamicIsland(models.length > 0 ? `已拉取 ${models.length} 个模型` : '没有找到可用模型');
        } catch (error) {
            renderVoiceRecognitionModelOptions([]);
            showDynamicIsland('拉取模型失败', {
                variant: 'error',
                detail: error?.message || '语音模型列表请求失败',
                copyText: error?.stack || error?.message || '拉取模型失败'
            });
        } finally {
            button.disabled = false;
            button.textContent = originalText;
        }
    });
    elements.voiceRecognitionModelSelectBtn?.addEventListener('click', populateVoiceRecognitionModelModal);
    elements.voiceRecognitionModelModalCancelBtn?.addEventListener('click', () => {
        elements.voiceRecognitionModelModalOverlay?.classList.remove('visible');
    });
    elements.voiceRecognitionModelModalOverlay?.addEventListener('click', event => {
        if (event.target === elements.voiceRecognitionModelModalOverlay) {
            elements.voiceRecognitionModelModalOverlay.classList.remove('visible');
        }
    });
    elements.voiceRecognitionModelList?.addEventListener('click', event => {
        const item = event.target.closest('.selection-list-item[data-model]');
        if (!item) return;
        elements.voiceRecognitionModelInput.value = item.dataset.model;
        elements.voiceRecognitionModelModalOverlay?.classList.remove('visible');
    });
    // --- 新逻辑：监听 select 元素的 change 事件 ---
    let previousModelValue = elements.modelInput.value; // 用于取消时恢复
    elements.modelInput.addEventListener('focus', () => {
        // 当用户点击下拉菜单时，记录当前值
        previousModelValue = elements.modelInput.value;
    });
    elements.modelInput.addEventListener('change', () => {
        const select = elements.modelInput;
        if (select.value === 'custom') {
            const customModel = prompt('请输入自定义 TTS 模型 ID:', previousModelValue !== 'custom' ? previousModelValue : '');
            
            if (customModel && customModel.trim() !== '') {
                // 移除旧的自定义选项（如果存在）
                const oldCustom = select.querySelector('option[data-custom-option]');
                if (oldCustom) {
                    oldCustom.remove();
                }
                // 创建并插入新的自定义选项
                const newOption = document.createElement('option');
                newOption.value = customModel.trim();
                newOption.textContent = customModel.trim();
                newOption.dataset.customOption = 'true'; // 做个标记
                select.insertBefore(newOption, select.querySelector('option[value="custom"]'));
                
                // 选中新创建的选项
                select.value = customModel.trim();
                previousModelValue = select.value; // 更新“前一个值”
            } else {
                // 如果用户取消或输入为空，恢复到之前的选项
                select.value = previousModelValue;
                showDynamicIsland("已取消自定义", "info");
            }
        } else {
            // 如果选择的是普通选项，也更新“前一个值”
            previousModelValue = select.value;
        }
    });
    
   
}

/**
 * 初始化声音设置页面模块
 */
export function initSoundSettings() {
    // 绑定元素引用
    elements.providerSelect = document.getElementById('tts-provider-select');
    elements.minimaxSettingsCard = document.getElementById('tts-minimax-settings');
    elements.minimaxModelCard = document.getElementById('tts-minimax-model-settings');
    elements.elevenLabsSettingsCard = document.getElementById('tts-elevenlabs-settings');
    elements.endpointSelect = document.getElementById('tts-endpoint-select');
    elements.groupIdInput = document.getElementById('tts-group-id-input');
    elements.apiKeyInput = document.getElementById('tts-api-key-input');
    elements.modelInput = document.getElementById('tts-model-input'); // 现在这是 select
    elements.elevenLabsApiKeyInput = document.getElementById('tts-elevenlabs-api-key-input');
    elements.elevenLabsModelInput = document.getElementById('tts-elevenlabs-model-input');
    elements.elevenLabsOutputFormatInput = document.getElementById('tts-elevenlabs-output-format-input');
    elements.voiceRecognitionProviderSelect = document.getElementById('voice-recognition-provider-select');
    elements.voiceRecognitionEndpointInput = document.getElementById('voice-recognition-endpoint-input');
    elements.voiceRecognitionApiKeyInput = document.getElementById('voice-recognition-api-key-input');
    elements.voiceRecognitionModelInput = document.getElementById('voice-recognition-model-input');
    elements.voiceRecognitionModelSelectBtn = document.getElementById('voice-recognition-model-select-btn');
    elements.voiceRecognitionModelRefreshBtn = document.getElementById('voice-recognition-model-refresh-btn');
    elements.voiceRecognitionModelOptions = document.getElementById('voice-recognition-model-options');
    elements.voiceRecognitionModelModalOverlay = document.getElementById('voice-recognition-model-modal-overlay');
    elements.voiceRecognitionModelList = document.getElementById('voice-recognition-model-list');
    elements.voiceRecognitionModelModalCancelBtn = document.getElementById('voice-recognition-model-modal-cancel');
    elements.voiceRecognitionLanguageSelect = document.getElementById('voice-recognition-language-select');
    elements.voiceRecognitionApiCard = document.getElementById('voice-recognition-api-card');
    elements.autoplayToggle = document.getElementById('tts-autoplay-toggle');
    elements.saveBtn = document.getElementById('tts-save-settings-btn');
    
    // 确保所有元素都存在
    if (!elements.saveBtn) return;

    elements.voiceRecognitionEndpointInput?.addEventListener('blur', normalizeVoiceRecognitionEndpointInput);
    
    // 【新增】：动态注入最新的 MiniMax 语音模型选项
    if (elements.modelInput && elements.modelInput.tagName.toLowerCase() === 'select') {
        const newModels = [
            'speech-2.8-hd', 'speech-2.8-turbo', 
            'speech-2.6-hd', 'speech-2.6-turbo', 
            'speech-02-hd', 'speech-02-turbo', 
            'speech-01-hd', 'speech-01-turbo'
        ];
        newModels.forEach(modelName => {
            if (!elements.modelInput.querySelector(`option[value="${modelName}"]`)) {
                const opt = document.createElement('option');
                opt.value = modelName;
                opt.textContent = modelName;
                const customOpt = elements.modelInput.querySelector('option[value="custom"]');
                if (customOpt) elements.modelInput.insertBefore(opt, customOpt);
                else elements.modelInput.appendChild(opt);
            }
        });
    }

    loadSettingsToUI();

    bindEvents();
    
    console.log("声音设置页面已初始化 (已升级为下拉菜单)。");
}
