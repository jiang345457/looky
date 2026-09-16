import { db } from '../state.js';
import { showDynamicIsland, showInputModal } from '../ui.js';
import { escapeHTML } from '../utils.js';
import { getVectorApiConfig, guessVectorProviderFromUrl } from './vector-engine.js';

const VECTOR_API_CONFIG_KEY = 'vector_api_config';
const VECTOR_API_CONFIG_LIST_KEY = 'vectorApiConfigurations';
const VECTOR_API_PROVIDERS = {
    openai: {
        name: 'OpenAI',
        url: 'https://api.openai.com',
        model: 'text-embedding-3-small',
        recommendation: '推荐：text-embedding-3-small；想要更强可换 text-embedding-3-large。'
    },
    siliconflow: {
        name: '硅基流动',
        url: 'https://api.siliconflow.cn',
        model: 'BAAI/bge-m3',
        recommendation: '推荐：BAAI/bge-m3；如果你更想试大一点的，可以换 Qwen/Qwen3-Embedding-8B。'
    },
    aliyun: {
        name: '阿里云百炼',
        url: 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        model: 'text-embedding-v4',
        recommendation: '推荐：text-embedding-v4；如果是旧项目迁移，也可以先试 text-embedding-v3。'
    },
    zhipu: {
        name: '智谱AI',
        url: 'https://open.bigmodel.cn/api/paas/v4',
        model: '',
        recommendation: '请填你控制台里可用的 embedding 模型名。'
    },
    custom_openai_compatible: {
        name: '自定义 OpenAI 兼容',
        url: '',
        model: 'text-embedding-3-small',
        recommendation: '适合中转、代理或私有化服务，地址和模型按你自己的服务端填写。'
    }
};

function normalizeProviderKey(value = '') {
    return ['openai', 'siliconflow', 'aliyun', 'zhipu', 'custom_openai_compatible'].includes(value)
        ? value
        : 'custom_openai_compatible';
}

function normalizeFormValue(value = {}) {
    const toNumber = (input, fallback) => {
        const num = Number(input);
        return Number.isFinite(num) ? num : fallback;
    };

    const provider = normalizeProviderKey(value.provider || guessVectorProviderFromUrl(value.url));
    const providerPreset = VECTOR_API_PROVIDERS[provider] || VECTOR_API_PROVIDERS.custom_openai_compatible;

    return {
        enabled: value.enabled === true,
        provider,
        applyTo: ['memory', 'image', 'both'].includes(value.applyTo) ? value.applyTo : 'memory',
        url: String(value.url || providerPreset.url || '').trim(),
        key: String(value.key || '').trim(),
        model: String(value.model || providerPreset.model || 'text-embedding-3-small').trim() || 'text-embedding-3-small',
        embeddingPath: String(value.embeddingPath || '').trim(),
        memoryThreshold: Math.min(1, Math.max(0, toNumber(value.memoryThreshold, 0.25))),
        memoryBoostWeight: Math.max(0, toNumber(value.memoryBoostWeight, 15)),
        imageThreshold: Math.min(1, Math.max(0, toNumber(value.imageThreshold, 0.5)))
    };
}

async function getVectorApiConfigurations() {
    const record = await db.appData.get(VECTOR_API_CONFIG_LIST_KEY);
    return Array.isArray(record?.value) ? record.value : [];
}

async function saveVectorApiConfigurations(configs) {
    const value = Array.isArray(configs) ? configs : [];
    await db.appData.put({ key: VECTOR_API_CONFIG_LIST_KEY, value });
    return value;
}

function isSameVectorConfig(left = {}, right = {}) {
    const a = normalizeFormValue(left);
    const b = normalizeFormValue(right);
    return a.enabled === b.enabled
        && a.provider === b.provider
        && a.applyTo === b.applyTo
        && a.url === b.url
        && a.key === b.key
        && a.model === b.model
        && a.embeddingPath === b.embeddingPath
        && a.memoryThreshold === b.memoryThreshold
        && a.memoryBoostWeight === b.memoryBoostWeight
        && a.imageThreshold === b.imageThreshold;
}

function openVectorChoiceModal(title, options, currentValue, onSelect) {
    const overlay = document.createElement('div');
    overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:10000',
        'display:flex',
        'align-items:flex-end',
        'justify-content:center',
        'background:rgba(0,0,0,0.35)',
        'padding:16px',
        'box-sizing:border-box'
    ].join(';');
    overlay.innerHTML = `
        <div style="width:min(420px, 100%); background:#fff; border-radius:28px; overflow:hidden; box-shadow:0 20px 40px rgba(0,0,0,0.18);">
            <div style="padding:18px 20px 12px; font-size:18px; font-weight:700; color:#111;">${title}</div>
            <div style="max-height:60vh; overflow-y:auto;">
                ${options.map(item => `
                    <button type="button" class="vector-choice-item" data-value="${escapeHTML(item.value)}" style="width:100%; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:16px 20px; border:0; border-top:1px solid #f0f0f0; background:${item.value === currentValue ? '#f7f7f7' : '#fff'}; font-size:16px; text-align:left;">
                        <span style="font-weight:${item.value === currentValue ? '700' : '500'}; color:#111;">${escapeHTML(item.label)}</span>
                        <span style="width:20px; height:20px; border-radius:50%; border:2px solid ${item.value === currentValue ? '#3b82f6' : '#c7c7cc'}; display:inline-flex; align-items:center; justify-content:center; box-sizing:border-box;">
                            ${item.value === currentValue ? '<span style="width:10px; height:10px; border-radius:50%; background:#3b82f6; display:block;"></span>' : ''}
                        </span>
                    </button>
                `).join('')}
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            overlay.remove();
            return;
        }
        const button = event.target.closest('.vector-choice-item');
        if (!button) return;
        onSelect(button.dataset.value);
        overlay.remove();
    });
}

async function fetchVectorModels(config = {}) {
    const normalized = normalizeFormValue(config);
    if (!normalized.url || !normalized.key) throw new Error('请先填写 API 地址和 Key');

    const provider = normalizeProviderKey(normalized.provider || guessVectorProviderFromUrl(normalized.url));
    let baseUrl = normalized.url.trim().replace(/\/+$/, '');
    const endpoint = provider === 'zhipu'
        ? `${baseUrl}/models`
        : `${baseUrl.replace(/\/v1$/i, '')}/v1/models`;

    const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${normalized.key}`,
            'api-key': normalized.key,
            'x-api-key': normalized.key
        },
        cache: 'no-store'
    });
    const bodyText = await response.text().catch(() => '');
    let data = {};
    try {
        data = bodyText ? JSON.parse(bodyText) : {};
    } catch (_error) {
        data = {};
    }
    if (!response.ok) {
        const serverMessage = data.error?.message || data.message || bodyText.replace(/\s+/g, ' ').trim().slice(0, 160);
        throw new Error(`拉取模型失败 ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${serverMessage ? `：${serverMessage}` : ''}`);
    }

    const rawModels = data?.data?.map(item => item?.id || item?.name)
        || data?.models?.map(item => item?.id || item?.name)
        || [];
    const models = [...new Set(rawModels
        .map(model => String(model || '').replace(/^models\//, '').trim())
        .filter(Boolean)
    )].sort();
    const embeddingModels = models.filter(model => /embed|embedding|bge|gte|e5|m3|jina|qwen/i.test(model));
    return embeddingModels.length > 0 ? embeddingModels : models;
}

export function initVectorApiSettings() {
    const page = document.getElementById('page-vector-api-settings');
    if (!page || page.dataset.vectorBound === '1') return;
    page.dataset.vectorBound = '1';

    const providerItem = document.getElementById('vector-api-provider-item');
    const providerValue = document.getElementById('vector-api-provider-value');
    const providerHint = document.getElementById('vector-api-provider-hint');
    const enabledToggle = document.getElementById('vector-api-enabled-toggle');
    const applySelect = document.getElementById('vector-api-apply-select');
    const urlInput = document.getElementById('vector-api-url-input');
    const keyInput = document.getElementById('vector-api-key-input');
    const modelInput = document.getElementById('vector-api-model-input');
    const modelRefreshBtn = document.getElementById('vector-api-model-refresh-btn');
    const modelHint = document.getElementById('vector-api-model-hint');
    const memoryThresholdInput = document.getElementById('vector-api-memory-threshold-input');
    const memoryBoostWeightInput = document.getElementById('vector-api-memory-boost-weight-input');
    const imageThresholdInput = document.getElementById('vector-api-image-threshold-input');
    const configItem = document.getElementById('vector-api-config-item');
    const configValue = document.getElementById('vector-api-config-value');
    const saveConfigBtn = document.getElementById('vector-api-save-config-btn');
    const saveBtn = document.getElementById('vector-api-save-btn');
    const configModalOverlay = document.getElementById('vector-api-config-modal-overlay');
    const configList = document.getElementById('vector-api-config-list');
    const configModalCancelBtn = document.getElementById('vector-api-config-modal-cancel');

    if (!providerItem || !providerValue || !enabledToggle || !applySelect || !urlInput || !keyInput || !modelInput || !modelRefreshBtn || !modelHint || !memoryThresholdInput || !memoryBoostWeightInput || !imageThresholdInput || !configItem || !configValue || !saveConfigBtn || !saveBtn || !configModalOverlay || !configList || !configModalCancelBtn) return;

    const getProviderPreset = (providerKey) => VECTOR_API_PROVIDERS[normalizeProviderKey(providerKey)] || VECTOR_API_PROVIDERS.custom_openai_compatible;
    let selectedConfigName = '';
    let editingConfigName = '';
    let availableModels = [];

    const updateConfigDisplay = () => {
        configValue.textContent = selectedConfigName || '未选择方案';
        saveConfigBtn.textContent = editingConfigName ? '保存更改' : '保存为方案';
    };

    const applyConfigToUI = (config) => {
        const normalized = normalizeFormValue(config);
        enabledToggle.checked = normalized.enabled;
        providerValue.dataset.provider = normalizeProviderKey(normalized.provider);
        providerValue.textContent = getProviderPreset(normalized.provider).name;
        applySelect.value = normalized.applyTo;
        urlInput.value = normalized.url;
        keyInput.value = normalized.key;
        modelInput.value = normalized.model;
        memoryThresholdInput.value = String(normalized.memoryThreshold);
        memoryBoostWeightInput.value = String(normalized.memoryBoostWeight);
        imageThresholdInput.value = String(normalized.imageThreshold);
        if (providerHint) providerHint.textContent = '切换预设会自动填地址和推荐模型，密钥不会被覆盖。';
        if (modelHint) modelHint.textContent = getProviderPreset(normalized.provider).recommendation;
        updateConfigDisplay();
    };

    const readCurrentConfig = () => normalizeFormValue({
        enabled: enabledToggle.checked,
        provider: providerValue.dataset.provider || 'custom_openai_compatible',
        applyTo: applySelect.value,
        url: urlInput.value,
        key: keyInput.value,
        model: modelInput.value,
        memoryThreshold: memoryThresholdInput.value,
        memoryBoostWeight: memoryBoostWeightInput.value,
        imageThreshold: imageThresholdInput.value
    });

    const renderConfigOptions = async () => {
        const configs = await getVectorApiConfigurations();
        const matched = configs.find(item => isSameVectorConfig(item, readCurrentConfig()));
        if (matched && !editingConfigName) selectedConfigName = matched.name;
        if (selectedConfigName && !configs.some(item => item.name === selectedConfigName)) selectedConfigName = '';
        if (editingConfigName && !configs.some(item => item.name === editingConfigName)) editingConfigName = '';
        updateConfigDisplay();
        return configs;
    };

    const markConfigChanged = () => {
        selectedConfigName = editingConfigName || '';
        updateConfigDisplay();
    };

    const syncProviderPreset = (providerKey) => {
        const preset = getProviderPreset(providerKey);
        providerValue.dataset.provider = normalizeProviderKey(providerKey);
        providerValue.textContent = preset.name;
        urlInput.value = preset.url;
        modelInput.value = preset.model;
        if (providerHint) providerHint.textContent = '切换预设会自动填地址和推荐模型，密钥不会被覆盖。';
        if (modelHint) modelHint.textContent = preset.recommendation;
        markConfigChanged();
    };

    const saveConfig = async () => {
        try {
            const value = readCurrentConfig();
            await db.appData.put({ key: VECTOR_API_CONFIG_KEY, value });
            await renderConfigOptions();
            showDynamicIsland('向量检索设置已保存');
        } catch (error) {
            console.warn('[Vector API] Failed to save config.', error);
        }
    };

    const saveCurrentConfigAs = async (name) => {
        const configName = String(name || '').trim();
        if (!configName) return false;
        const configs = await getVectorApiConfigurations();
        const nextConfig = { name: configName, ...readCurrentConfig() };
        const index = configs.findIndex(item => item.name === configName);
        if (index >= 0) configs[index] = nextConfig;
        else configs.push(nextConfig);
        await saveVectorApiConfigurations(configs);
        selectedConfigName = configName;
        editingConfigName = '';
        await renderConfigOptions();
        return true;
    };

    const saveCurrentConfigChanges = async () => {
        if (!editingConfigName) return false;
        const configs = await getVectorApiConfigurations();
        const index = configs.findIndex(item => item.name === editingConfigName);
        if (index < 0) {
            editingConfigName = '';
            selectedConfigName = '';
            await renderConfigOptions();
            showDynamicIsland('原方案不存在，请重新保存');
            return false;
        }
        configs[index] = { name: editingConfigName, ...readCurrentConfig() };
        await saveVectorApiConfigurations(configs);
        selectedConfigName = editingConfigName;
        editingConfigName = '';
        await renderConfigOptions();
        showDynamicIsland('向量 API 方案已更新');
        return true;
    };

    const populateConfigManager = async () => {
        const configs = await getVectorApiConfigurations();
        configList.innerHTML = '';
        if (configs.length > 0) {
            const fragment = document.createDocumentFragment();
            configs.forEach(item => {
                const li = document.createElement('li');
                li.className = `selection-list-item config-list-item ${item.name === selectedConfigName ? 'active' : ''}`;
                li.dataset.name = item.name;
                li.innerHTML = `
                    <svg class="checkmark-icon" fill="none" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    <span class="config-name-text">${escapeHTML(item.name)}</span>
                    <button type="button" data-vector-config-edit="${escapeHTML(item.name)}" style="border:0; background:#f2f2f7; color:#111; border-radius:10px; padding:6px 10px; font-size:12px;">修改</button>
                    <svg class="delete-icon" data-vector-config-delete="${escapeHTML(item.name)}" fill="none" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                `;
                fragment.appendChild(li);
            });
            configList.appendChild(fragment);
        } else {
            configList.innerHTML = '<li class="selection-list-item" style="justify-content:center;">还没有保存的向量方案</li>';
        }
        configModalOverlay.classList.add('visible');
    };

    const handleConfigFieldChange = () => {
        markConfigChanged();
    };

    enabledToggle.addEventListener('change', handleConfigFieldChange);
    applySelect.addEventListener('change', handleConfigFieldChange);
    urlInput.addEventListener('change', handleConfigFieldChange);
    keyInput.addEventListener('change', handleConfigFieldChange);
    modelInput.addEventListener('change', handleConfigFieldChange);
    memoryThresholdInput.addEventListener('change', handleConfigFieldChange);
    memoryBoostWeightInput.addEventListener('change', handleConfigFieldChange);
    imageThresholdInput.addEventListener('change', handleConfigFieldChange);
    providerItem.addEventListener('click', () => {
        openVectorChoiceModal(
            '选择接口预设',
            Object.entries(VECTOR_API_PROVIDERS).map(([value, preset]) => ({
                value,
                label: preset.name
            })),
            providerValue.dataset.provider || 'custom_openai_compatible',
            value => syncProviderPreset(value)
        );
    });

    modelRefreshBtn.addEventListener('click', async event => {
        event.stopPropagation();
        try {
            modelRefreshBtn.disabled = true;
            modelRefreshBtn.textContent = '拉取中';
            showDynamicIsland('正在拉取向量模型...');
            availableModels = await fetchVectorModels(readCurrentConfig());
            if (availableModels.length > 0 && !modelInput.value.trim()) {
                modelInput.value = availableModels[0];
                markConfigChanged();
            }
            showDynamicIsland(availableModels.length > 0 ? '向量模型已拉取' : '没有找到可用模型');
            if (availableModels.length > 0) {
                openVectorChoiceModal(
                    '选择向量模型',
                    availableModels.map(model => ({ value: model, label: model })),
                    modelInput.value,
                    value => {
                        modelInput.value = value;
                        markConfigChanged();
                    }
                );
            }
        } catch (error) {
            console.warn('[Vector API] Failed to fetch models.', error);
            showDynamicIsland('拉取模型失败', {
                variant: 'error',
                detail: error?.message || '向量模型列表请求失败',
                copyText: error?.stack || error?.message || '拉取模型失败'
            });
            availableModels = [];
        } finally {
            modelRefreshBtn.disabled = false;
            modelRefreshBtn.textContent = '拉取';
        }
    });

    configItem.addEventListener('click', populateConfigManager);

    saveConfigBtn.addEventListener('click', async () => {
        if (editingConfigName) {
            await saveCurrentConfigChanges();
            return;
        }
        showInputModal('向量 API 方案名称', selectedConfigName || '', async name => {
            if (await saveCurrentConfigAs(name)) showDynamicIsland('向量 API 方案已保存');
        });
    });

    saveBtn.addEventListener('click', saveConfig);

    configModalCancelBtn.addEventListener('click', () => configModalOverlay.classList.remove('visible'));
    configModalOverlay.addEventListener('click', event => {
        if (event.target === configModalOverlay) configModalOverlay.classList.remove('visible');
    });

    configList.addEventListener('click', async event => {
        const editButton = event.target.closest('[data-vector-config-edit]');
        const deleteButton = event.target.closest('[data-vector-config-delete]');
        const item = event.target.closest('.selection-list-item');

        if (deleteButton) {
            event.stopPropagation();
            const deleteName = deleteButton.dataset.vectorConfigDelete;
            if (!window.confirm(`确定删除向量 API 方案 "${deleteName}" 吗？`)) return;
            const nextConfigs = (await getVectorApiConfigurations()).filter(config => config.name !== deleteName);
            await saveVectorApiConfigurations(nextConfigs);
            if (selectedConfigName === deleteName) selectedConfigName = '';
            if (editingConfigName === deleteName) editingConfigName = '';
            await renderConfigOptions();
            await populateConfigManager();
            showDynamicIsland('向量 API 方案已删除');
            return;
        }

        if (editButton) {
            event.stopPropagation();
            const editName = editButton.dataset.vectorConfigEdit;
            const selected = (await getVectorApiConfigurations()).find(config => config.name === editName);
            if (!selected) return;
            selectedConfigName = selected.name;
            editingConfigName = selected.name;
            applyConfigToUI(selected);
            configModalOverlay.classList.remove('visible');
            showDynamicIsland('修改后点“保存更改”');
            return;
        }

        if (item?.dataset.name) {
            const selected = (await getVectorApiConfigurations()).find(config => config.name === item.dataset.name);
            if (!selected) return;
            selectedConfigName = selected.name;
            editingConfigName = '';
            applyConfigToUI(selected);
            await renderConfigOptions();
            configModalOverlay.classList.remove('visible');
            showDynamicIsland('已切换方案，点“应用设置”后生效');
        }
    });

    const render = async () => {
        const config = await getVectorApiConfig();
        providerValue.dataset.provider = normalizeProviderKey(config.provider);
        applyConfigToUI(config);
        await renderConfigOptions();
    };

    window.addEventListener('looky:page-opened', event => {
        if (event.detail?.pageId === 'page-vector-api-settings') {
            render();
        }
    });

    render();
}
