import { AppState, db } from '../state.js';
import { UI, showDynamicIsland, showInputModal } from '../ui.js';
import { addTapListener } from '../utils.js';

  /* --- 3.7 API 设置 --- */
  // 负责“API设置”页面的所有复杂逻辑，包括服务商切换、模型拉取、配置管理等
export  function setupApiSettings() {
    const apiEndpoints = {
      newapi: {
        name: 'NewAPI',
        url: ''
      },
      deepseek: {
        name: 'DeepSeek',
        url: 'https://api.deepseek.com'
      },
      claude: {
        name: 'Claude',
        url: 'https://api.anthropic.com'
      },
      gemini: {
        name: 'Gemini',
        url: 'https://generativelanguage.googleapis.com'
      }
    };
    const providerKeys = Object.keys(apiEndpoints);
    let availableModels = [];
    let isSelectingSummaryModel = false; // 新增：用于区分当前拉取/选择的是否是副API模型
    let lastFetchMode = null; // 【修复新增】：用于记录上次拉取的是哪个通道的模型，防止缓存污染

    const getMemoryApiFields = () => ({
      summaryUrl: AppState.apiCurrentSettings?.summaryUrl || '',
      summaryKey: AppState.apiCurrentSettings?.summaryKey || '',
      summaryModel: AppState.apiCurrentSettings?.summaryModel || ''
    });

    const fetchModelList = async ({ url, key, provider }) => {
      const apiUrl = url.trim().replace(/\/$/, '').replace(/\/v1$/, '');
      const isGemini = provider === 'gemini' || apiUrl.includes('generativelanguage');
      const endpoint = isGemini ? `${apiUrl}/v1beta/models?key=${key}` : `${apiUrl}/v1/models`;
      const headers = isGemini ? {} : { 'Authorization': `Bearer ${key}` };
      const response = await fetch(endpoint, { headers, cache: 'no-store' });
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
      return (data.data?.map(m => m.id) || data.models?.map(m => m.name.replace('models/', '')) || []).sort();
    };

    const testChatApi = async ({ url, key, model }, label = 'API') => {
      if (!url) throw new Error(`${label}地址未设置`);
      if (!key) throw new Error(`${label}密钥未设置`);
      if (!model) throw new Error(`${label}模型未选择`);

      const apiUrl = url.trim().replace(/\/$/, '');
      const response = await fetch(`${apiUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          temperature: 0,
          max_tokens: 8
        })
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`${label}测试失败 ${response.status}: ${errorData.error?.message || errorData.message || '请检查地址、密钥或模型'}`);
      }
      return response.json().catch(() => ({}));
    };

    const updateUI = () => {

      UI.apiProviderValue.textContent = apiEndpoints[AppState.apiCurrentSettings.provider]?.name || '自定义';
      UI.apiUrlValue.textContent = AppState.apiCurrentSettings.url || '未设置';
      UI.apiKeyValue.textContent = AppState.apiCurrentSettings.key ? '••••••••' : '未设置';
      UI.apiModelValue.textContent = AppState.apiCurrentSettings.model || '未选择';
      
      // ▼▼▼ 新增：更新副API的UI显示 ▼▼▼
      const summaryUrlValue = document.getElementById('summary-api-url-value');
      if (summaryUrlValue) summaryUrlValue.textContent = AppState.apiCurrentSettings.summaryUrl || '未设置 (默认同主API)';
      const summaryKeyValue = document.getElementById('summary-api-key-value');
      if (summaryKeyValue) summaryKeyValue.textContent = AppState.apiCurrentSettings.summaryKey ? '••••••••' : '未设置';
      const summaryModelValue = document.getElementById('summary-api-model-value');
      if (summaryModelValue) summaryModelValue.textContent = AppState.apiCurrentSettings.summaryModel || '未选择';
      // ▲▲▲ 新增结束 ▲▲▲
      UI.temperatureSlider.value = AppState.apiCurrentSettings.temperature;
      UI.temperatureValue.textContent = parseFloat(AppState.apiCurrentSettings.temperature).toFixed(2);
      UI.currentConfigValue.textContent = AppState.lastUsedApiConfigName;
      
      // ▼▼▼ 新增：读取并显示 MaxTokens 和 Reasoning ▼▼▼
      const maxTokensInput = document.getElementById('api-max-tokens-input');
      if (maxTokensInput) maxTokensInput.value = AppState.apiCurrentSettings.maxTokens || '';
      
      const reasoningSelect = document.getElementById('api-reasoning-effort-select');
      if (reasoningSelect) reasoningSelect.value = AppState.apiCurrentSettings.reasoningEffort || 'default';
      const streamSelect = document.getElementById('api-stream-select');
      if (streamSelect) streamSelect.value = AppState.apiCurrentSettings.streamEnabled === true ? 'true' : 'false';
      // ▲▲▲ 新增结束 ▲▲▲
    };

    const toggleModal = (modal, show) => modal.classList.toggle('visible', show);

    const populateModelModal = () => {
      const list = UI.modelList;
      list.innerHTML = '';
      if (availableModels.length > 0) {
        const fragment = document.createDocumentFragment();
        availableModels.forEach(id => {
          const li = document.createElement('li');
          // ▼▼▼ 修改：根据标记判断是对比主API模型还是副API模型 ▼▼▼
          const currentModel = isSelectingSummaryModel ? AppState.apiCurrentSettings.summaryModel : AppState.apiCurrentSettings.model;
          li.className = `selection-list-item ${id === currentModel ? 'selected' : ''}`;
          // ▲▲▲ 修改结束 ▲▲▲
          li.dataset.model = id;
          li.textContent = id;
          fragment.appendChild(li);
        });
        list.appendChild(fragment);
      } else {
        list.innerHTML = '<li class="selection-list-item" style="text-align:center; color:#8e8e93;">没有可用的模型</li>';
      }
      toggleModal(UI.modelModalOverlay, true);
    };

    const populateConfigManager = () => {
      const list = UI.configList;
      list.innerHTML = '';
      if (AppState.apiConfigurations.length > 0) {
        const fragment = document.createDocumentFragment();
        AppState.apiConfigurations.forEach(c => {
          const li = document.createElement('li');
          li.className = `selection-list-item config-list-item ${c.name === AppState.lastUsedApiConfigName ? 'active' : ''}`;
          li.dataset.name = c.name;
          li.innerHTML = `
            <svg class="checkmark-icon" fill="none" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
            <span class="config-name-text">${c.name}</span>
            <svg class="delete-icon" data-name="${c.name}" fill="none" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
          fragment.appendChild(li);
        });
        list.appendChild(fragment);
      } else {
        list.innerHTML = '<li class="selection-list-item" style="justify-content:center;">没有已保存的配置</li>';
      }
      toggleModal(UI.configModalOverlay, true);
    };

    const persistApiSettings = async ({ includeConfigurations = false } = {}) => {
      const records = [
        { key: 'apiCurrentSettings', value: AppState.apiCurrentSettings },
        { key: 'lastUsedApiConfigName', value: AppState.lastUsedApiConfigName }
      ];
      if (includeConfigurations) {
        records.push({ key: 'apiConfigurations', value: AppState.apiConfigurations });
      }
      await db.appData.bulkPut(records);
    };

    const applySettings = async (showNotification = true) => {
      await persistApiSettings();
      if (showNotification) showDynamicIsland('设置已应用');
      updateUI();
    };

    const saveConfigAs = async (name) => {
      if (!name) return;
      const newConfig = {
        name,
        ...AppState.apiCurrentSettings
      };
      const existingIndex = AppState.apiConfigurations.findIndex(c => c.name === name);
      if (existingIndex > -1) AppState.apiConfigurations[existingIndex] = newConfig;
      else AppState.apiConfigurations.push(newConfig);
      AppState.lastUsedApiConfigName = name;
      await persistApiSettings({ includeConfigurations: true });
      updateUI();
      showDynamicIsland(`配置 "${name}" 已保存`);
    };

    const markSettingsAsUnsaved = (renderUI = true) => {
      AppState.lastUsedApiConfigName = '未保存的更改';
      if (renderUI) updateUI();
      else UI.currentConfigValue.textContent = AppState.lastUsedApiConfigName;
    };
    UI.modelList.addEventListener('click', e => {
      const target = e.target.closest('.selection-list-item');
      if (target?.dataset.model) {
        // ▼▼▼ 修改：根据标记分别赋值给主/副API模型 ▼▼▼
        if (isSelectingSummaryModel) {
            AppState.apiCurrentSettings.summaryModel = target.dataset.model;
        } else {
            AppState.apiCurrentSettings.model = target.dataset.model;
        }
        // ▲▲▲ 修改结束 ▲▲▲
        markSettingsAsUnsaved();
        toggleModal(UI.modelModalOverlay, false);
      }
    });

    UI.configList.addEventListener('click', async e => {
      const deleteBtn = e.target.closest('.delete-icon');
      const item = e.target.closest('.selection-list-item');
      if (deleteBtn) {
        e.stopPropagation();
        const name = deleteBtn.dataset.name;
        if (window.confirm(`确定要删除配置 "${name}" 吗?`)) {
          AppState.apiConfigurations = AppState.apiConfigurations.filter(c => c.name !== name);
          if (AppState.lastUsedApiConfigName === name) AppState.lastUsedApiConfigName = '无';
          await persistApiSettings({ includeConfigurations: true });
          updateUI();
          showDynamicIsland(`配置 "${name}" 已删除`);
          populateConfigManager();
        }
      } else if (item?.dataset.name) {
        const config = AppState.apiConfigurations.find(c => c.name === item.dataset.name);
        if (config) {
          const memoryApiFields = getMemoryApiFields();
          AppState.apiCurrentSettings = { ...config, ...memoryApiFields
          };
          delete AppState.apiCurrentSettings.name;
          AppState.lastUsedApiConfigName = config.name;
          availableModels = [];
          await applySettings(false);
          showDynamicIsland(`配置 "${config.name}" 已加载`);
          toggleModal(UI.configModalOverlay, false);
        }
      }
    });

    const createChangeHandler = key => value => {
      AppState.apiCurrentSettings[key] = value;
      markSettingsAsUnsaved();
    };
    UI.apiUrlItem.addEventListener('click', () => showInputModal('请输入API地址', AppState.apiCurrentSettings.url, createChangeHandler('url')));
    UI.apiKeyItem.addEventListener('click', () => showInputModal('请输入密钥(Key)', AppState.apiCurrentSettings.key, createChangeHandler('key')));

    UI.apiProviderItem.addEventListener('click', () => {
      const nextProviderKey = providerKeys[(providerKeys.indexOf(AppState.apiCurrentSettings.provider) + 1) % providerKeys.length];
      AppState.apiCurrentSettings.provider = nextProviderKey;
      AppState.apiCurrentSettings.url = apiEndpoints[nextProviderKey].url;
      AppState.apiCurrentSettings.model = '';
      availableModels = [];
      markSettingsAsUnsaved();
    });
     UI.temperatureSlider.addEventListener('input', () => {
      AppState.apiCurrentSettings.temperature = UI.temperatureSlider.value;
      UI.temperatureValue.textContent = parseFloat(UI.temperatureSlider.value).toFixed(2);
      markSettingsAsUnsaved(false);
    });

    // ▼▼▼ 新增：监听 MaxTokens 和 Reasoning 的更改并保存 ▼▼▼
    document.getElementById('api-max-tokens-input')?.addEventListener('input', (e) => {
      AppState.apiCurrentSettings.maxTokens = e.target.value;
      markSettingsAsUnsaved(false);
    });
    
    document.getElementById('api-reasoning-effort-select')?.addEventListener('change', (e) => {
      AppState.apiCurrentSettings.reasoningEffort = e.target.value;
      markSettingsAsUnsaved(false);
    });
    document.getElementById('api-stream-select')?.addEventListener('change', (e) => {
      AppState.apiCurrentSettings.streamEnabled = e.target.value === 'true';
      markSettingsAsUnsaved(false);
    });
    // ▲▲▲ 新增结束 ▲▲▲

    // ▼▼▼ 新增：副API的输入项点击事件 ▼▼▼

    document.getElementById('summary-api-url-item')?.addEventListener('click', () => showInputModal('请输入副API地址(留空同主API)', AppState.apiCurrentSettings.summaryUrl || '', createChangeHandler('summaryUrl')));
    document.getElementById('summary-api-key-item')?.addEventListener('click', () => showInputModal('请输入副API密钥(Key)', AppState.apiCurrentSettings.summaryKey || '', createChangeHandler('summaryKey')));

    document.getElementById('summary-api-model-refresh-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        availableModels = []; 
        document.getElementById('summary-api-model-item')?.click(); 
    });
    document.getElementById('summary-api-model-item')?.addEventListener('click', async () => {
      isSelectingSummaryModel = true; // 标记当前操作为副API
      
      // ▼▼▼ 修复 1：防止主/副 API 模型缓存串台 ▼▼▼
      if (lastFetchMode !== 'summary') {
          availableModels = [];
          lastFetchMode = 'summary';
      }
      if (availableModels.length > 0) return populateModelModal();
      
      const fetchUrl = AppState.apiCurrentSettings.summaryUrl || AppState.apiCurrentSettings.url;
      const fetchKey = AppState.apiCurrentSettings.summaryKey || AppState.apiCurrentSettings.key;
      
      if (!fetchUrl || !fetchKey) return showDynamicIsland('请先设置API地址和密钥');

      showDynamicIsland('拉取模型中...');
      const summaryModelValue = document.getElementById('summary-api-model-value');
      if(summaryModelValue) summaryModelValue.textContent = '拉取中...';
      const apiUrl = fetchUrl.trim().replace(/\/$/, '').replace(/\/v1$/, '');

      try {
        availableModels = await fetchModelList({
          url: fetchUrl,
          key: fetchKey,
          provider: !AppState.apiCurrentSettings.summaryUrl ? AppState.apiCurrentSettings.provider : ''
        });
        showDynamicIsland(availableModels.length > 0 ? '拉取成功' : '未找到模型');
      } catch (error) {
        showDynamicIsland('拉取失败', {
          variant: 'error',
          detail: error?.message || '模型列表拉取失败',
          copyText: error?.stack || error?.message || '拉取失败'
        });
        availableModels = [];
      } finally {
        updateUI();
        populateModelModal();
      }
    });


 document.getElementById('api-model-refresh-btn')?.addEventListener('click', (e) => {
        e.stopPropagation(); // 防止触发父元素的点击事件
        availableModels = []; // 强制清空已有的模型缓存
        UI.apiModelItem.click(); // 自动触发下面那个点击事件，重新去拉取
    });
     UI.apiModelItem.addEventListener('click', async () => {
      isSelectingSummaryModel = false; // 标记当前操作为主API
      
      // ▼▼▼ 修复：防止主/副 API 模型缓存串台 ▼▼▼
      if (lastFetchMode !== 'main') {
          availableModels = [];
          lastFetchMode = 'main';
      }
      if (availableModels.length > 0) return populateModelModal();
      
      if (!AppState.apiCurrentSettings.url || !AppState.apiCurrentSettings.key) return showDynamicIsland('请先设置地址和密钥');

      showDynamicIsland('拉取模型中...');
      UI.apiModelValue.textContent = '拉取中...';

      try {
        availableModels = await fetchModelList({
          url: AppState.apiCurrentSettings.url,
          key: AppState.apiCurrentSettings.key,
          provider: AppState.apiCurrentSettings.provider
        });
        showDynamicIsland(availableModels.length > 0 ? '拉取成功' : '未找到模型');
      } catch (error) {
        showDynamicIsland('拉取失败', {
          variant: 'error',
          detail: error?.message || '模型列表拉取失败',
          copyText: error?.stack || error?.message || '拉取失败'
        });
        availableModels = [];
      } finally {
        updateUI();
        populateModelModal();
      }
    });

    document.getElementById('api-test-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const originalText = btn.textContent;
      try {
        btn.disabled = true;
        btn.textContent = '测试中';
        showDynamicIsland('正在测试API...', { variant: 'loading', loading: true });

        const settings = AppState.apiCurrentSettings || {};
        await testChatApi(settings, '主API');

        const hasMemoryOverride = Boolean(settings.summaryUrl || settings.summaryKey || settings.summaryModel);
        if (hasMemoryOverride) {
          await testChatApi({
            url: settings.summaryUrl || settings.url,
            key: settings.summaryKey || settings.key,
            model: settings.summaryModel || settings.model
          }, '记忆API');
        }

        showDynamicIsland(hasMemoryOverride ? '主API和记忆API测试成功' : 'API测试成功');
      } catch (error) {
        showDynamicIsland('API测试失败', {
          variant: 'error',
          detail: error?.message || 'API测试过程中出错',
          copyText: error?.stack || error?.message || 'API测试失败'
        });
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });

    addTapListener(UI.apiApplyBtn, async () => await applySettings());
    addTapListener(UI.apiSaveConfigBtn, async () => {
      const initialName = (AppState.lastUsedApiConfigName && !AppState.lastUsedApiConfigName.includes('未保存')) ? AppState.lastUsedApiConfigName : '';
      showInputModal('为配置命名', initialName, async name => {
        if (name && (name === initialName || !AppState.apiConfigurations.some(c => c.name === name) || window.confirm(`配置 "${name}" 已存在。要覆盖吗？`))) await saveConfigAs(name);
      });
    });

    [UI.modelModalCancelBtn, UI.configModalCancelBtn].forEach(btn => btn.addEventListener('click', () => toggleModal(btn.closest('.modal-overlay'), false)));
    [UI.modelModalOverlay, UI.configModalOverlay].forEach(o => o.addEventListener('click', e => {
      if (e.target === o) toggleModal(o, false);
    }));
    UI.manageConfigsItem.addEventListener('click', populateConfigManager);
    updateUI();
  }
