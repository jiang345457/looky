import { AppState, db, DEFAULT_AVATAR_SRC, createDefaultMemoryProfile, normalizeCharacterRelationshipFields, isCharacterFriend, getCharacterReplyLanguage } from '../state.js';
import { showDynamicIsland, showPage } from '../ui.js';
import { compressImageDataUrl, escapeHTML, isValidAvatarSrc } from '../utils.js';
import { clearOnlineChatMessagesForCharacters, refreshCharacterLists } from './character.js';
import { renderCharacterDetailPage, renderCharacterLibraryPage } from './character-library.js';
import { openEditWorldBookModal } from './world-book.js';

let selectedRelationMode = null;
let addPageNpcs = [];
let editingNpcIndex = -1;
let editingCharacterId = null;
let addPageWorldBookIds = [];
let addPageWorldBookDrafts = [];
let addPageWorldBookCategories = [];
let editingWorldBookDraftIndex = -1;
let originalRelationStartMode = null;
let originalRelationSnapshot = null;
const DEFAULT_NPC_PROBABILITY = 70;

const getEl = (id) => document.getElementById(id);
function normalizeNpcProbability(value) {
    const rawValue = String(value ?? '').trim();
    if (!rawValue) return DEFAULT_NPC_PROBABILITY;
    const probability = Number(rawValue);
    return Number.isFinite(probability)
        ? Math.max(0, Math.min(100, Math.round(probability)))
        : DEFAULT_NPC_PROBABILITY;
}

const toWorldBookEntryId = (value) => {
    const numericValue = Number(value);
    return Number.isNaN(numericValue) ? value : numericValue;
};

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async () => resolve(await compressImageDataUrl(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result || '');
        reader.onerror = reject;
        reader.readAsText(file, 'UTF-8');
    });
}

async function ensureMammothLoaded() {
    if (window.mammoth) return window.mammoth;
    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = './js/features/mammoth.browser.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
    return window.mammoth;
}

async function readWorldBookImportFile(file) {
    if (!file) return { title: '', content: '' };
    const title = file.name.replace(/\.[^/.]+$/, '');
    if (file.name.toLowerCase().endsWith('.docx')) {
        const mammoth = await ensureMammothLoaded();
        const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
        return { title, content: result.value || '' };
    }
    return { title, content: await readFileAsText(file) };
}

function getImportanceText(value) {
    if (value === 'high') return '高';
    if (value === 'medium') return '中';
    return '低';
}

function setRelationMode(mode) {
    selectedRelationMode = mode;
    const shell = document.querySelector('#page-character-add .ca-shell');
    if (shell) shell.classList.toggle('has-selected-mode', Boolean(mode));
    document.querySelectorAll('.ca-mode-card').forEach(button => {
        const isActive = button.dataset.mode === mode;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', String(isActive));
    });

    const knownFields = getEl('ca-known-fields');
    const offlineFields = getEl('ca-offline-fields');
    if (knownFields) knownFields.hidden = mode !== 'known';
    if (offlineFields) offlineFields.hidden = mode !== 'stranger';
}

function getRelationModeForEdit(char = {}) {
    if (isCharacterFriend(char)) return 'known';
    if (char.inContacts === true) return 'known';
    if (char.relationStartMode === 'stranger') return 'stranger';
    if (char.relationStage === 'offline_met' || char.relationStage === 'pending_user' || char.relationStage === 'pending_char') {
        return 'stranger';
    }
    return 'library_only';
}

function setCharacterAddPageMode(mode = 'add') {
    const isEdit = mode === 'edit';
    const page = document.getElementById('page-character-add');
    const modeGroup = getEl('ca-relation-mode-group');
    page?.classList.toggle('is-edit-mode', isEdit);
    if (modeGroup) modeGroup.hidden = false;
    getEl('ca-page-kicker').textContent = isEdit ? '角色资料修改' : '新角色档案';
    getEl('ca-page-kicker-en').textContent = isEdit ? 'EDIT PROFILE' : 'NEW PROFILE';
    getEl('ca-page-title').textContent = isEdit ? '编辑资料' : '添加角色';
    getEl('ca-page-copy').textContent = isEdit ? '可以调整关系起点；涉及清理旧记录时会再次确认。' : '先选择关系起点，再补充 Ta 的资料。';
    getEl('ca-save-btn').textContent = isEdit ? '保存修改' : '保存角色';
}

function renderAddPageNpcs() {
    const list = getEl('ca-npc-list');
    if (!list) return;
    if (addPageNpcs.length === 0) {
        list.innerHTML = '<p>暂无关联 NPC</p>';
        return;
    }

    list.innerHTML = addPageNpcs.map((npc, index) => `
        <div class="ca-npc-item ${index === editingNpcIndex ? 'is-editing' : ''}">
            <img src="${escapeHTML(isValidAvatarSrc(npc.avatar) ? npc.avatar : 'images/default-avatar.svg')}" alt="NPC">
            <div>
                <strong>${escapeHTML(npc.name)}</strong>
                <span>${escapeHTML(npc.relation || '未填写关系')} · 评论概率 ${normalizeNpcProbability(npc.probability)}%</span>
            </div>
            <div class="ca-npc-actions">
                <button type="button" data-action="edit" data-index="${index}">修改</button>
                <button type="button" data-action="delete" data-index="${index}">删除</button>
            </div>
        </div>
    `).join('');
}

function parseCharacterNpcJsonArray(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed?.npcs)) return parsed.npcs;
    } catch (error) {}
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
        try {
            const parsed = JSON.parse(arrayMatch[0]);
            if (Array.isArray(parsed)) return parsed;
        } catch (error) {
            console.error('Character NPC AI JSON parse failed:', error);
        }
    }
    return [];
}

function getCharacterNpcAiRequestConfig() {
    const apiSettings = AppState.apiCurrentSettings || {};
    const rawUrl = String(apiSettings.url || '').trim();
    const key = String(apiSettings.key || '').trim();
    const model = String(apiSettings.model || '').trim();
    const baseUrl = rawUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
    if (!baseUrl) throw new Error('角色 NPC AI API 地址未设置');
    if (!key) throw new Error('角色 NPC AI API 密钥未设置');
    if (!model) throw new Error('角色 NPC AI 模型未选择');
    try {
        new URL(baseUrl);
    } catch (error) {
        throw new Error('角色 NPC AI API 地址格式不正确，请填写完整地址，例如 https://api.example.com');
    }
    return { endpoint: `${baseUrl}/v1/chat/completions`, key, model };
}

async function sendCharacterNpcJsonPromptToAI(prompt) {
    const { endpoint, key, model } = getCharacterNpcAiRequestConfig();
    let response;
    try {
        response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.55,
                stream: false
            })
        });
    } catch (error) {
        throw new Error(error?.message || '角色 NPC AI 请求发送失败');
    }
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
        throw new Error(`角色 NPC AI 请求失败：${errorData.error?.message || response.statusText}`);
    }
    const data = await response.json().catch(() => null);
    if (!data) throw new Error('角色 NPC AI 返回内容不是标准 JSON');
    return data.choices?.[0]?.message?.content || '';
}

async function requestCharacterNpcJsonArray(prompt, minCount = 3) {
    const first = parseCharacterNpcJsonArray(await sendCharacterNpcJsonPromptToAI(prompt));
    if (first.length >= minCount) return first;
    const retryPrompt = `${prompt}

上一次返回少于 ${minCount} 条。请立刻补正：只输出一个 JSON 数组，数组长度必须不少于 ${minCount}，不要解释。`;
    return parseCharacterNpcJsonArray(await sendCharacterNpcJsonPromptToAI(retryPrompt));
}

async function getCharacterNpcWorldBookText() {
    const selectedEntries = addPageWorldBookIds.length > 0
        ? (await db.worldBookEntries.bulkGet(addPageWorldBookIds)).filter(Boolean)
        : [];
    const categoryEntries = addPageWorldBookCategories.length > 0
        ? await db.worldBookEntries.where('category').anyOf(addPageWorldBookCategories).toArray()
        : [];
    const globalEntries = await db.worldBookEntries.where('category').equals('全局世界书').toArray();
    const entriesById = new Map();
    [...globalEntries, ...categoryEntries, ...selectedEntries].forEach(entry => {
        if (entry?.id !== undefined) entriesById.set(String(entry.id), entry);
    });
    const savedEntries = [...entriesById.values()];
    const draftEntries = addPageWorldBookDrafts.map(draft => ({
        title: draft.title || '未命名世界书草稿',
        content: draft.content || '',
        importance: draft.importance || 'medium'
    }));
    const importanceOrder = { high: 1, medium: 2, low: 3 };
    const formatEntry = entry => `[${entry.title || '未命名世界书'}] ${entry.content || ''}`;
    const formattedEntries = [...savedEntries, ...draftEntries]
        .filter(entry => String(entry.content || '').trim())
        .sort((a, b) => (importanceOrder[a.importance] || 3) - (importanceOrder[b.importance] || 3))
        .map(formatEntry);
    return formattedEntries.length > 0 ? formattedEntries.join('\n') : '未挂载世界书';
}

async function buildCharacterNpcGenerationPrompt() {
    const name = getEl('ca-name-input')?.value.trim() || '未命名角色';
    const realName = getEl('ca-real-name-input')?.value.trim();
    const persona = getEl('ca-persona-input')?.value.trim() || '未填写';
    const relationMode = selectedRelationMode || '未选择';
    const knownBackground = collectKnownBackground();
    const worldBookText = await getCharacterNpcWorldBookText();
    const existingNpcText = addPageNpcs.length
        ? addPageNpcs.map(npc => `- ${npc.name || '未命名'}：${npc.relation || '关系未填'}；${npc.persona || '设定未填'}`).join('\n')
        : '暂无';
    const userBrief = getEl('ca-npc-ai-brief')?.value.trim() || '无';
    return `请为角色资料生成不少于 3 个可编辑的关联 NPC 草稿。

主角色资料：
- 名字：${name}
${realName ? `- 本名：${realName}` : ''}
- 关系路线：${relationMode}
- 人设：${persona}
- 已认识背景：${JSON.stringify(knownBackground)}

主角色关联世界书：
${worldBookText}

已有 NPC：
${existingNpcText}

用户额外方向：${userBrief}

要求：
1. NPC 必须是围绕主角色生活、社交圈、工作/学校/家庭/过去经历出现的人。
2. 不要重复已有 NPC，不要生成主角色本人。
3. 这些 NPC 是主角色身边的人，不是论坛专属人物。
4. 禁止生成粉丝、黑粉、路人账号、论坛用户、名人、账号资料或粉丝数量等论坛字段。
5. 每个 NPC 都要能在主角色的聊天、生活和记忆中自然出现。
6. 只输出 JSON 数组，不要解释。

每个对象字段：
name, relation, persona
其中 relation 写和主角色的关系；persona 写简短设定、说话风格、可能引发的剧情作用。`;
}

async function generateCharacterNpcDraftsWithAI() {
    const btn = getEl('ca-npc-ai-generate-btn');
    const oldText = btn?.textContent;
    try {
        if (btn) {
            btn.disabled = true;
            btn.textContent = '生成中...';
        }
        const items = await requestCharacterNpcJsonArray(await buildCharacterNpcGenerationPrompt(), 3);
        const validItems = items.filter(item => item && (item.name || item.relation || item.persona)).slice(0, 8);
        if (validItems.length < 3) {
            showDynamicIsland('AI 返回的 NPC 少于 3 个，请再试一次');
            return;
        }
        const existingNames = new Set(addPageNpcs.map(npc => String(npc.name || '').trim()).filter(Boolean));
        let addedCount = 0;
        validItems.forEach((item, index) => {
            const name = String(item.name || `NPC ${index + 1}`).trim();
            if (!name || existingNames.has(name)) return;
            existingNames.add(name);
            addPageNpcs.push({
                id: `npc_${Date.now()}_${index}`,
                name,
                relation: String(item.relation || '').trim(),
                persona: String(item.persona || '').trim(),
                avatar: 'images/default-avatar.svg',
                probability: DEFAULT_NPC_PROBABILITY
            });
            addedCount += 1;
        });
        if (addedCount === 0) {
            showDynamicIsland('AI 生成的 NPC 和现有列表重复了，请换个方向再试');
            return;
        }
        editingNpcIndex = -1;
        getEl('ca-npc-add-btn').textContent = '添加 NPC';
        renderAddPageNpcs();
        showDynamicIsland(`已生成 ${addedCount} 个 NPC 草稿`);
    } catch (error) {
        console.error('Character NPC AI generation failed:', error);
        showDynamicIsland('NPC AI 生成失败，请检查 API 设置');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = oldText || 'AI 生成 NPC 草稿';
        }
    }
}

function renderKnownGroupOptions() {
    const select = getEl('ca-known-group-select');
    if (!select) return;

    const groups = AppState.characterGroups.length > 0
        ? AppState.characterGroups
        : [{ id: 'default', name: 'AI角色' }];
    select.innerHTML = groups.map(group => `
        <option value="${escapeHTML(group.id)}">${escapeHTML(group.name || '未命名分组')}</option>
    `).join('');
    select.value = groups.some(group => group.id === 'default') ? 'default' : groups[0].id;
}

function getIdentityDisplayName(identity) {
    return identity?.nickname || identity?.name || '未命名身份';
}

function getCharacterEditIdentityId(char) {
    const identities = AppState.userIdentities.length > 0
        ? AppState.userIdentities
        : [{ id: 'default', name: '默认身份' }];
    if (char?.chatIdentityId && identities.some(identity => String(identity.id) === String(char.chatIdentityId))) {
        return char.chatIdentityId;
    }
    return identities[0]?.id || 'default';
}

function renderCharacterIdentityOptions(selectedId = '', options = {}) {
    const select = getEl('ca-identity-select');
    if (!select) return;
    const { useCurrentIdentityFallback = true } = options;
    const identities = AppState.userIdentities.length > 0
        ? AppState.userIdentities
        : [{ id: 'default', name: '默认身份' }];
    select.innerHTML = identities.map(identity => `
        <option value="${escapeHTML(identity.id)}">${escapeHTML(getIdentityDisplayName(identity))}</option>
    `).join('');
    const fallbackId = selectedId || (useCurrentIdentityFallback ? AppState.currentIdentityId : '') || identities[0]?.id || 'default';
    select.value = identities.some(identity => String(identity.id) === String(fallbackId))
        ? fallbackId
        : identities[0]?.id || 'default';
}

function resetCharacterIdentityModal() {
    getEl('ca-identity-avatar-preview').src = DEFAULT_AVATAR_SRC;
    getEl('ca-identity-avatar-upload').value = '';
    getEl('ca-identity-name-input').value = '';
    getEl('ca-identity-nickname-input').value = '';
    getEl('ca-identity-persona-input').value = '';
}

function openCharacterIdentityModal() {
    resetCharacterIdentityModal();
    getEl('ca-identity-modal')?.classList.add('visible');
}

function closeCharacterIdentityModal() {
    getEl('ca-identity-modal')?.classList.remove('visible');
}

async function saveIdentityFromCharacterAddModal() {
    const name = getEl('ca-identity-name-input').value.trim();
    if (!name) {
        showDynamicIsland('请先填写身份名称');
        return;
    }
    const newIdentity = {
        id: `identity_${Date.now()}`,
        name,
        nickname: getEl('ca-identity-nickname-input')?.value.trim() || name,
        location: '',
        persona: getEl('ca-identity-persona-input').value.trim(),
        socialCircle: [],
        avatar: isValidAvatarSrc(getEl('ca-identity-avatar-preview').src)
            ? getEl('ca-identity-avatar-preview').src
            : DEFAULT_AVATAR_SRC
    };
    AppState.userIdentities.push(newIdentity);
    await db.appData.put({ key: 'userIdentities', value: AppState.userIdentities });
    renderCharacterIdentityOptions(newIdentity.id);
    closeCharacterIdentityModal();
    showDynamicIsland(`身份 "${name}" 已创建`);
}

async function renderCharacterAddWorldBookOptions() {
    const select = getEl('ca-worldbook-select');
    if (!select) return;
    const entries = await db.worldBookEntries.orderBy('createdAt').reverse().toArray();
    if (entries.length === 0) {
        select.innerHTML = '<option value="">暂无可选择的世界书</option>';
        select.disabled = true;
        return;
    }
    select.disabled = false;
    select.innerHTML = entries.map(entry => `
        <option value="${escapeHTML(String(entry.id))}">${escapeHTML(entry.category || '默认')} / ${escapeHTML(entry.title || '未命名世界书')}</option>
    `).join('');
}

async function renderCharacterAddWorldBookList() {
    const list = getEl('ca-worldbook-selected-list');
    if (!list) return;
    const selectedEntries = addPageWorldBookIds.length > 0
        ? (await db.worldBookEntries.bulkGet(addPageWorldBookIds)).filter(Boolean)
        : [];
    const categoryHtml = addPageWorldBookCategories.map(category => `
        <div class="ca-worldbook-pill is-category">
            <span>分组 · ${escapeHTML(category)}</span>
            <button type="button" data-action="remove-category" data-category="${escapeHTML(category)}">移除</button>
        </div>
    `).join('');
    const selectedHtml = selectedEntries.map(entry => `
        <div class="ca-worldbook-pill">
            <span>${escapeHTML(entry.title || '未命名世界书')} · ${escapeHTML(getImportanceText(entry.importance))}</span>
            <button type="button" data-action="edit-existing" data-id="${escapeHTML(String(entry.id))}">修改</button>
            <button type="button" data-action="remove-existing" data-id="${escapeHTML(String(entry.id))}">移除</button>
        </div>
    `).join('');
    const draftHtml = addPageWorldBookDrafts.map((draft, index) => `
        <div class="ca-worldbook-pill is-draft">
            <span>${escapeHTML(draft.title || '未命名设定')} · ${escapeHTML(getImportanceText(draft.importance))}</span>
            <button type="button" data-action="edit-draft" data-index="${index}">修改</button>
            <button type="button" data-action="remove-draft" data-index="${index}">移除</button>
        </div>
    `).join('');

    list.innerHTML = categoryHtml || selectedHtml || draftHtml
        ? `${categoryHtml}${selectedHtml}${draftHtml}`
        : '<p>还没有挂载世界书</p>';
}

async function renderCharacterWorldBookPickerList(query = '') {
    const list = getEl('ca-worldbook-picker-list');
    if (!list) return;
    const searchTerm = String(query || '').trim().toLowerCase();
    const dbCategories = await db.worldBookCategories.orderBy('id').toArray();
    const categories = [...new Set(['全局世界书', '默认', ...dbCategories.map(category => category.name).filter(Boolean)])];
    const entries = await db.worldBookEntries.orderBy('createdAt').reverse().toArray();
    const groupedEntries = new Map(categories.map(category => [category, []]));
    entries.forEach(entry => {
        const category = entry.category || '默认';
        if (!groupedEntries.has(category)) groupedEntries.set(category, []);
        groupedEntries.get(category).push(entry);
    });
    const visibleGroups = categories.filter(category => {
        if (!searchTerm) return true;
        const lowerCategory = String(category || '').toLowerCase();
        return lowerCategory.includes(searchTerm)
            || (groupedEntries.get(category) || []).some(entry => [
                    entry.title,
                    entry.content
                ].some(value => String(value || '').toLowerCase().includes(searchTerm)));
    });

    if (visibleGroups.length === 0) {
        list.innerHTML = '<p class="ca-worldbook-picker-empty">没有找到世界书。</p>';
        return;
    }

    list.innerHTML = visibleGroups.map(category => {
        const groupSelected = addPageWorldBookCategories.includes(category);
        const groupEntries = (groupedEntries.get(category) || [])
            .filter(entry => {
                if (!searchTerm) return true;
                return [
                    entry.title,
                    entry.category,
                    entry.content
                ].some(value => String(value || '').toLowerCase().includes(searchTerm));
            });
        const entriesHtml = groupEntries.length > 0
            ? groupEntries.map(entry => {
                const selected = addPageWorldBookIds.some(id => Number(id) === Number(entry.id));
                const preview = String(entry.content || '').replace(/\s+/g, ' ').slice(0, 48);
                return `
                    <article class="ca-worldbook-picker-entry ${selected ? 'is-selected' : ''}" data-id="${escapeHTML(String(entry.id))}">
                        <div>
                            <strong>${escapeHTML(entry.title || '未命名世界书')}</strong>
                            <p>${escapeHTML(preview || '暂无内容')} · ${escapeHTML(getImportanceText(entry.importance))}</p>
                        </div>
                        <div class="ca-worldbook-picker-actions">
                            <button type="button" data-action="edit" data-id="${escapeHTML(String(entry.id))}">修改</button>
                            <button type="button" data-action="select" data-id="${escapeHTML(String(entry.id))}">${selected ? '已选' : '选择'}</button>
                        </div>
                    </article>
                `;
            }).join('')
            : '<p class="ca-worldbook-picker-group-empty">这个分组暂时没有条目</p>';
        return `
            <section class="ca-worldbook-picker-group ${groupSelected ? 'is-selected' : ''}" data-category="${escapeHTML(category)}">
                <header>
                    <div>
                        <strong>${escapeHTML(category)}</strong>
                        <span>预览 ${groupEntries.length} 条 · GROUP</span>
                    </div>
                    <button type="button" data-action="select-group" data-category="${escapeHTML(category)}">${groupSelected ? '已选分组' : '选分组'}</button>
                </header>
                <div class="ca-worldbook-picker-entries">${entriesHtml}</div>
            </section>
        `;
    }).join('');
}

async function openCharacterWorldBookPicker() {
    const modal = getEl('ca-worldbook-picker-modal');
    const searchInput = getEl('ca-worldbook-picker-search-input');
    if (!modal) return;
    if (searchInput) searchInput.value = '';
    modal.classList.add('visible');
    await renderCharacterWorldBookPickerList('');
}

function closeCharacterWorldBookPicker() {
    getEl('ca-worldbook-picker-modal')?.classList.remove('visible');
}

function resetWorldBookDraftForm() {
    editingWorldBookDraftIndex = -1;
    getEl('ca-worldbook-title-input').value = '';
    getEl('ca-worldbook-content-input').value = '';
    getEl('ca-worldbook-importance-select').value = 'medium';
    if (getEl('ca-worldbook-position-select')) getEl('ca-worldbook-position-select').value = 'default';
    if (getEl('ca-worldbook-keyword-toggle')) getEl('ca-worldbook-keyword-toggle').checked = false;
    if (getEl('ca-worldbook-keywords-input')) {
        getEl('ca-worldbook-keywords-input').value = '';
        getEl('ca-worldbook-keywords-input').style.display = 'none';
    }
    getEl('ca-worldbook-import-input').value = '';
    getEl('ca-worldbook-draft-add-btn').textContent = '加入待保存世界书';
}

function loadWorldBookDraftForEdit(index) {
    const draft = addPageWorldBookDrafts[index];
    if (!draft) return;
    editingWorldBookDraftIndex = index;
    getEl('ca-worldbook-title-input').value = draft.title || '';
    getEl('ca-worldbook-content-input').value = draft.content || '';
    getEl('ca-worldbook-importance-select').value = draft.importance || 'medium';
    if (getEl('ca-worldbook-position-select')) getEl('ca-worldbook-position-select').value = draft.injectionPosition || 'default';
    const keywordTriggerEnabled = !!draft.keywordTriggerEnabled;
    if (getEl('ca-worldbook-keyword-toggle')) getEl('ca-worldbook-keyword-toggle').checked = keywordTriggerEnabled;
    const loadKwInput = getEl('ca-worldbook-keywords-input');
    if (loadKwInput) {
        const keywords = Array.isArray(draft.keywords) ? draft.keywords : [];
        loadKwInput.value = keywords.join(', ');
        loadKwInput.style.display = keywordTriggerEnabled ? 'block' : 'none';
    }
    getEl('ca-worldbook-draft-add-btn').textContent = '保存世界书修改';
}

function getCharacterWorldBookCategoryName(charId, name, existingCategory = '') {
    if (existingCategory) return existingCategory;
    const cleanName = String(name || '未命名角色').trim() || '未命名角色';
    return `${cleanName}的世界书-${String(charId).slice(-6)}`;
}

async function ensureCharacterWorldBookCategory(categoryName) {
    if (!categoryName || categoryName === '默认' || categoryName === '全局世界书') return categoryName || '默认';
    const existing = await db.worldBookCategories.where('name').equals(categoryName).first();
    if (!existing) {
        await db.worldBookCategories.add({ name: categoryName });
    }
    return categoryName;
}

async function saveCharacterWorldBookDrafts(charId, name, existingCategory = '') {
    if (addPageWorldBookDrafts.length === 0) return { ids: [], category: existingCategory };
    const category = getCharacterWorldBookCategoryName(charId, name, existingCategory);
    await ensureCharacterWorldBookCategory(category);
    const ids = [];
    for (const draft of addPageWorldBookDrafts) {
        const id = await db.worldBookEntries.add({
            title: draft.title || `${name || '角色'}设定`,
            content: draft.content || '',
            category,
            importance: draft.importance || 'medium',
            injectionPosition: draft.injectionPosition || 'default',
            keywordTriggerEnabled: draft.keywordTriggerEnabled || false,
            keywords: Array.isArray(draft.keywords) ? draft.keywords : [],
            createdAt: new Date()
        });
        ids.push(id);
    }
    return { ids, category };
}

function resetCharacterAddPage() {
    addPageNpcs = [];
    editingNpcIndex = -1;
    editingCharacterId = null;
    addPageWorldBookIds = [];
    addPageWorldBookDrafts = [];
    addPageWorldBookCategories = [];
    editingWorldBookDraftIndex = -1;
    originalRelationStartMode = null;
    originalRelationSnapshot = null;
    setCharacterAddPageMode('add');
    setRelationMode(null);
    renderKnownGroupOptions();
    renderCharacterIdentityOptions(AppState.currentIdentityId);
    renderCharacterAddWorldBookOptions().then(renderCharacterAddWorldBookList).catch(error => console.warn('[CharacterAdd] world book options failed:', error));

    getEl('ca-avatar-preview').src = DEFAULT_AVATAR_SRC;
    getEl('ca-avatar-upload').value = '';
    getEl('ca-name-input').value = '';
    getEl('ca-real-name-input').value = '';
    getEl('ca-account-input').value = '';
    getEl('ca-persona-input').value = '';
    getEl('ca-reply-language-select').value = 'auto';
    getEl('ca-known-duration').value = '';
    getEl('ca-known-relation').value = '';
    getEl('ca-known-history').value = '';
    getEl('ca-known-current').value = '';
    getEl('ca-known-nickname').value = '';
    getEl('ca-known-reconnect').value = '';
    getEl('ca-offline-setting').value = '';
    getEl('ca-online-background').value = '';
    getEl('ca-incoming-request-reason').value = '';
    getEl('ca-incoming-request-message').value = '';
    getEl('ca-npc-name').value = '';
    getEl('ca-npc-relation').value = '';
    getEl('ca-npc-persona').value = '';
    getEl('ca-npc-ai-brief').value = '';
    getEl('ca-npc-avatar-preview').src = 'images/default-avatar.svg';
    getEl('ca-npc-avatar-upload').value = '';
    getEl('ca-npc-probability-input').value = String(DEFAULT_NPC_PROBABILITY);
    getEl('ca-npc-prob-display').textContent = `${DEFAULT_NPC_PROBABILITY}%`;
    getEl('ca-worldbook-title-input').value = '';
    getEl('ca-worldbook-content-input').value = '';
    getEl('ca-worldbook-importance-select').value = 'medium';
    if (getEl('ca-worldbook-position-select')) getEl('ca-worldbook-position-select').value = 'default';
    if (getEl('ca-worldbook-keyword-toggle')) getEl('ca-worldbook-keyword-toggle').checked = false;
    if (getEl('ca-worldbook-keywords-input')) {
        getEl('ca-worldbook-keywords-input').value = '';
        getEl('ca-worldbook-keywords-input').style.display = 'none';
    }
    getEl('ca-worldbook-import-input').value = '';
    getEl('ca-worldbook-draft-add-btn').textContent = '加入待保存世界书';
    getEl('ca-voice-id').value = '';
    getEl('ca-lang-select').value = 'auto';
    getEl('ca-speed-input').value = '1.0';
    getEl('ca-speed-value').textContent = '1.0';
    renderAddPageNpcs();
}

function collectKnownBackground() {
    return {
        duration: getEl('ca-known-duration').value.trim(),
        originalRelation: getEl('ca-known-relation').value.trim(),
        sharedHistory: getEl('ca-known-history').value.trim(),
        currentRelation: getEl('ca-known-current').value.trim(),
        nicknameForUser: getEl('ca-known-nickname').value.trim(),
        openingContext: getEl('ca-known-reconnect').value.trim()
    };
}

function buildKnownBackgroundNote(background) {
    const rows = [
        ['认识多久', background.duration],
        ['原本关系', background.originalRelation],
        ['共同经历', background.sharedHistory],
        ['现在关系', background.currentRelation],
        ['Ta怎么称呼你', background.nicknameForUser],
        ['开场话题/当前前提', background.openingContext]
    ].filter(([, value]) => value);

    if (rows.length === 0) return '';
    return `\n\n【已认识背景】\n${rows.map(([label, value]) => `${label}：${value}`).join('\n')}`;
}

function buildRelationshipSeed(newCharId, account) {
    const isKnown = selectedRelationMode === 'known';
    return normalizeCharacterRelationshipFields({
        id: newCharId,
        relationStartMode: selectedRelationMode,
        relationStage: isKnown ? 'friend' : 'library',
        hasChat: isKnown,
        requiresOfflineMeet: selectedRelationMode === 'stranger',
        requiresFriendRequest: selectedRelationMode === 'stranger',
        characterAccount: account || undefined,
        familiarity: isKnown ? 60 : 0,
        inContacts: isKnown
    });
}

async function fillCharacterAddPageForEdit(char) {
    if (!char) return false;
    editingCharacterId = char.id;
    addPageNpcs = Array.isArray(char.relatedNpcs) ? char.relatedNpcs.map(npc => ({ ...npc })) : [];
    editingNpcIndex = -1;
    editingWorldBookDraftIndex = -1;
    const editRelationMode = getRelationModeForEdit(char);
    originalRelationStartMode = editRelationMode;
    originalRelationSnapshot = {
        hasChat: Boolean(char.hasChat),
        inContacts: char.inContacts !== false,
        relationStage: char.relationStage || 'library'
    };
    addPageWorldBookIds = Array.isArray(char.mountedWBIds) ? char.mountedWBIds.map(toWorldBookEntryId) : [];
    addPageWorldBookCategories = Array.isArray(char.mountedWBCategories) ? char.mountedWBCategories.filter(Boolean) : [];
    addPageWorldBookDrafts = [];
    setCharacterAddPageMode('edit');
    setRelationMode(editRelationMode);
    renderKnownGroupOptions();
    const editIdentityId = getCharacterEditIdentityId(char);
    renderCharacterIdentityOptions(editIdentityId, { useCurrentIdentityFallback: false });
    await renderCharacterAddWorldBookOptions();

    getEl('ca-avatar-preview').src = isValidAvatarSrc(char.avatar) ? char.avatar : DEFAULT_AVATAR_SRC;
    getEl('ca-avatar-upload').value = '';
    getEl('ca-name-input').value = char.name || '';
    getEl('ca-real-name-input').value = char.realName || '';
    getEl('ca-account-input').value = char.characterAccount || '';
    getEl('ca-identity-select').value = editIdentityId;
    getEl('ca-persona-input').value = char.persona || '';
    getEl('ca-reply-language-select').value = getCharacterReplyLanguage(char);
    const background = char.knownRelationshipBackground || {};
    getEl('ca-known-group-select').value = char.groupId || getEl('ca-known-group-select').value;
    getEl('ca-known-duration').value = background.duration || '';
    getEl('ca-known-relation').value = background.originalRelation || '';
    getEl('ca-known-history').value = background.sharedHistory || '';
    getEl('ca-known-current').value = background.currentRelation || '';
    getEl('ca-known-nickname').value = background.nicknameForUser || '';
    getEl('ca-known-reconnect').value = background.openingContext || '';
    getEl('ca-offline-setting').value = char.offlineInitialSetting || '';
    getEl('ca-online-background').value = char.onlineAcquaintanceBackground || '';
    getEl('ca-incoming-request-reason').value = char.incomingRequestReason || '';
    getEl('ca-incoming-request-message').value = char.incomingRequestMessage || char.pendingFriendRequestMessage || '';
    getEl('ca-npc-name').value = '';
    getEl('ca-npc-relation').value = '';
    getEl('ca-npc-persona').value = '';
    getEl('ca-npc-ai-brief').value = '';
    getEl('ca-npc-avatar-preview').src = 'images/default-avatar.svg';
    getEl('ca-npc-avatar-upload').value = '';
    getEl('ca-npc-probability-input').value = String(DEFAULT_NPC_PROBABILITY);
    getEl('ca-npc-prob-display').textContent = `${DEFAULT_NPC_PROBABILITY}%`;
    getEl('ca-worldbook-title-input').value = '';
    getEl('ca-worldbook-content-input').value = '';
    getEl('ca-worldbook-importance-select').value = 'medium';
    if (getEl('ca-worldbook-position-select')) getEl('ca-worldbook-position-select').value = 'default';
    if (getEl('ca-worldbook-keyword-toggle')) getEl('ca-worldbook-keyword-toggle').checked = false;
    if (getEl('ca-worldbook-keywords-input')) {
        getEl('ca-worldbook-keywords-input').value = '';
        getEl('ca-worldbook-keywords-input').style.display = 'none';
    }
    getEl('ca-worldbook-import-input').value = '';
    getEl('ca-worldbook-draft-add-btn').textContent = '加入待保存世界书';
    getEl('ca-voice-id').value = char.tts?.voiceId || '';
    getEl('ca-lang-select').value = char.tts?.language || 'auto';
    getEl('ca-speed-input').value = String(char.tts?.speed || 1.0);
    getEl('ca-speed-value').textContent = String(char.tts?.speed || 1.0);
    renderAddPageNpcs();
    await renderCharacterAddWorldBookList();
    return true;
}

async function saveCharacterFromAddPage() {
    const name = getEl('ca-name-input').value.trim();
    if (!selectedRelationMode) {
        showDynamicIsland('请先选择关系起点');
        return;
    }
    if (!name) {
        showDynamicIsland('请先填写角色名字');
        return;
    }
    if (editingCharacterId) {
        await saveEditedCharacterFromAddPage(name);
        return;
    }

    const newCharId = `char_${Date.now()}`;
    const knownBackground = collectKnownBackground();
    const persona = getEl('ca-persona-input').value.trim();
    const account = getEl('ca-account-input').value.trim();
    const relationshipFields = buildRelationshipSeed(newCharId, account);
    const avatarSrc = getEl('ca-avatar-preview').src;
    const offlineInitialSetting = selectedRelationMode === 'stranger'
        ? getEl('ca-offline-setting').value.trim()
        : '';
    const onlineAcquaintanceBackground = selectedRelationMode === 'stranger'
        ? getEl('ca-online-background').value.trim()
        : '';
    const incomingRequestReason = selectedRelationMode === 'stranger'
        ? getEl('ca-incoming-request-reason').value.trim()
        : '';
    const incomingRequestMessage = selectedRelationMode === 'stranger'
        ? getEl('ca-incoming-request-message').value.trim()
        : '';
    const ttsSpeed = parseFloat(getEl('ca-speed-input').value);
    const selectedIdentityId = getEl('ca-identity-select')?.value || AppState.currentIdentityId || null;
    const selectedKnownGroupId = getEl('ca-known-group-select')?.value || 'default';
    const fallbackGroupId = AppState.characterGroups[0]?.id || 'default';
    const knownGroupId = AppState.characterGroups.some(group => String(group.id) === String(selectedKnownGroupId))
        ? selectedKnownGroupId
        : fallbackGroupId;
    const shouldAddToContacts = selectedRelationMode === 'known';
    const worldBookDraftResult = await saveCharacterWorldBookDrafts(newCharId, name);
    const mountedWBIds = [...new Set([...addPageWorldBookIds.map(toWorldBookEntryId), ...worldBookDraftResult.ids])];
    const mountedWBCategories = [...new Set(addPageWorldBookCategories)];

    const newChar = {
        id: newCharId,
        groupId: shouldAddToContacts ? knownGroupId : 'default',
        inContacts: shouldAddToContacts,
        isPinned: false,
        subtitle: '',
        chatIdentityId: selectedIdentityId,
        enabledStickerPacks: [],
        stickerMatchEnabled: false,
        mountedWBIds,
        mountedWBCategories,
        characterWorldBookCategoryName: worldBookDraftResult.category || '',
        name,
        realName: getEl('ca-real-name-input').value.trim() || name,
        replyLanguage: getEl('ca-reply-language-select').value || 'auto',
        tag: '在线',
        persona: selectedRelationMode === 'known'
            ? `${persona}${buildKnownBackgroundNote(knownBackground)}`.trim()
            : persona,
        avatar: isValidAvatarSrc(avatarSrc) ? avatarSrc : DEFAULT_AVATAR_SRC,
        relatedNpcs: addPageNpcs.map(npc => ({ ...npc, probability: normalizeNpcProbability(npc.probability) })),
        tts: {
            voiceId: getEl('ca-voice-id').value.trim(),
            language: getEl('ca-lang-select').value,
            speed: Number.isFinite(ttsSpeed) ? ttsSpeed : 1.0
        },
        knownRelationshipBackground: selectedRelationMode === 'known' ? knownBackground : null,
        offlineInitialSetting,
        onlineAcquaintanceBackground,
        incomingRequestReason,
        incomingRequestMessage,
        pendingFriendRequestDirection: null,
        pendingPreviousRelationStage: null,
        pendingPreviousInContacts: null,
        blockAppealPhase: null,
        ...relationshipFields,
        memoryProfile: createDefaultMemoryProfile()
    };

    await db.characterProfiles.put(newChar);
    AppState.characterProfiles.push(newChar);
    refreshCharacterLists();
    renderCharacterLibraryPage();
    renderCharacterDetailPage(newChar.id);
    showPage('page-character-detail');
    showDynamicIsland(selectedRelationMode === 'known' ? '已添加为好友' : '角色已加入角色库');
}

function buildRelationModeUpdates(char, groupId) {
    if (selectedRelationMode === 'known') {
        const shouldKeepContactOnly = editingCharacterId
            && originalRelationStartMode === 'known'
            && originalRelationSnapshot?.inContacts
            && !originalRelationSnapshot?.hasChat
            && originalRelationSnapshot?.relationStage !== 'friend';
        if (shouldKeepContactOnly) {
            return {
                relationStartMode: 'known',
                relationStage: char.relationStage || 'library',
                hasChat: false,
                requiresOfflineMeet: false,
                requiresFriendRequest: false,
                inContacts: true,
                groupId: groupId || char.groupId || 'default',
                pendingFriendRequestDirection: null,
                pendingFriendRequestMessage: '',
                pendingPreviousRelationStage: null,
                pendingPreviousInContacts: null
            };
        }
        return {
            relationStartMode: 'known',
            relationStage: 'friend',
            hasChat: true,
            requiresOfflineMeet: false,
            requiresFriendRequest: false,
            inContacts: true,
            groupId: groupId || char.groupId || 'default',
            familiarity: Math.max(Number(char.familiarity) || 0, 60),
            pendingFriendRequestDirection: null,
            pendingFriendRequestMessage: '',
            pendingPreviousRelationStage: null,
            pendingPreviousInContacts: null
        };
    }
    if (selectedRelationMode === 'stranger') {
        return {
            relationStartMode: 'stranger',
            relationStage: 'library',
            hasChat: false,
            requiresOfflineMeet: true,
            requiresFriendRequest: true,
            inContacts: false,
            isPinned: false,
            familiarity: 0,
            relationshipEvents: [],
            pendingFriendRequestDirection: null,
            pendingFriendRequestMessage: '',
            pendingPreviousRelationStage: null,
            pendingPreviousInContacts: null
        };
    }
    return {
        relationStartMode: 'library_only',
        relationStage: 'library',
        hasChat: false,
        requiresOfflineMeet: false,
            requiresFriendRequest: false,
            inContacts: false,
            isPinned: false,
            familiarity: 0,
            relationshipEvents: [],
            pendingFriendRequestDirection: null,
        pendingFriendRequestMessage: '',
        pendingPreviousRelationStage: null,
        pendingPreviousInContacts: null
    };
}

async function confirmAndClearRelationResetData(char) {
    const oldMode = originalRelationStartMode || char.relationStartMode || 'library_only';
    if (oldMode === selectedRelationMode) return true;
    const isResetMode = selectedRelationMode === 'stranger' || selectedRelationMode === 'library_only';
    const hadInteractiveData = Boolean(originalRelationSnapshot?.hasChat)
        || Boolean(originalRelationSnapshot?.inContacts)
        || originalRelationSnapshot?.relationStage === 'friend';
    if (!isResetMode || !hadInteractiveData) return true;

    const targetText = selectedRelationMode === 'stranger' ? '从陌生关系开始' : '只放入角色库';
    const confirmed = confirm(`确定要把「${char.name || '这个角色'}」改为「${targetText}」吗？\n\n确认后会移出好友列表和通讯录，并清除该角色的线上聊天记录、线下记录和重要记忆。角色资料本身仍会保留。`);
    if (!confirmed) return false;

    await clearOnlineChatMessagesForCharacters([char.id]);
    await Promise.all([
        db.importantMemories.where('charId').equals(char.id).delete(),
        db.offlineMessages.where('chatId').equals(char.id).delete(),
        db.offlineSessions.where('chatId').equals(char.id).delete()
    ]);
    AppState.friendRequests = Array.isArray(AppState.friendRequests)
        ? AppState.friendRequests.filter(request => String(request.charId) !== String(char.id))
        : [];
    const threads = AppState.friendRequestThreads && typeof AppState.friendRequestThreads === 'object'
        ? { ...AppState.friendRequestThreads }
        : {};
    Object.keys(threads).forEach(threadId => {
        if (String(threadId).includes(String(char.id))) delete threads[threadId];
    });
    AppState.friendRequestThreads = threads;
    await db.appData.put({ key: 'friendRequests', value: AppState.friendRequests });
    await db.appData.put({ key: 'friendRequestThreads', value: AppState.friendRequestThreads });
    return true;
}

async function saveEditedCharacterFromAddPage(name) {
    const char = AppState.characterProfiles.find(item => String(item.id) === String(editingCharacterId));
    if (!char) {
        showDynamicIsland('没有找到要编辑的角色');
        return;
    }
    const knownBackground = collectKnownBackground();
    const persona = getEl('ca-persona-input').value.trim();
    const ttsSpeed = parseFloat(getEl('ca-speed-input').value);
    const selectedIdentityId = getEl('ca-identity-select')?.value || char.chatIdentityId || AppState.currentIdentityId || null;
    const selectedKnownGroupId = getEl('ca-known-group-select')?.value || char.groupId || 'default';
    const relationCanSave = await confirmAndClearRelationResetData(char);
    if (!relationCanSave) return;
    const worldBookDraftResult = await saveCharacterWorldBookDrafts(char.id, name, char.characterWorldBookCategoryName || '');
    const mountedWBIds = [...new Set([...addPageWorldBookIds.map(toWorldBookEntryId), ...worldBookDraftResult.ids])];
    const mountedWBCategories = [...new Set(addPageWorldBookCategories)];
    const updates = {
        name,
        realName: getEl('ca-real-name-input').value.trim() || name,
        characterAccount: getEl('ca-account-input').value.trim() || char.characterAccount || char.id,
        chatIdentityId: selectedIdentityId,
        persona,
        replyLanguage: getEl('ca-reply-language-select').value || 'auto',
        avatar: isValidAvatarSrc(getEl('ca-avatar-preview').src) ? getEl('ca-avatar-preview').src : DEFAULT_AVATAR_SRC,
        relatedNpcs: addPageNpcs.map(npc => ({ ...npc, probability: normalizeNpcProbability(npc.probability) })),
        mountedWBIds,
        mountedWBCategories,
        characterWorldBookCategoryName: worldBookDraftResult.category || char.characterWorldBookCategoryName || '',
        knownRelationshipBackground: selectedRelationMode === 'known' ? knownBackground : char.knownRelationshipBackground || null,
        offlineInitialSetting: selectedRelationMode === 'stranger' ? getEl('ca-offline-setting').value.trim() : char.offlineInitialSetting || '',
        onlineAcquaintanceBackground: selectedRelationMode === 'stranger' ? getEl('ca-online-background').value.trim() : char.onlineAcquaintanceBackground || '',
        incomingRequestReason: selectedRelationMode === 'stranger' ? getEl('ca-incoming-request-reason').value.trim() : char.incomingRequestReason || '',
        incomingRequestMessage: selectedRelationMode === 'stranger' ? getEl('ca-incoming-request-message').value.trim() : char.incomingRequestMessage || '',
        tts: {
            voiceId: getEl('ca-voice-id').value.trim(),
            language: getEl('ca-lang-select').value,
            speed: Number.isFinite(ttsSpeed) ? ttsSpeed : 1.0
        },
        ...buildRelationModeUpdates(char, selectedKnownGroupId)
    };
    Object.assign(char, updates);
    await db.characterProfiles.update(char.id, updates);
    refreshCharacterLists();
    renderCharacterLibraryPage();
    renderCharacterDetailPage(char.id);
    showPage('page-character-detail');
    showDynamicIsland('角色资料已保存');
}

export function openCharacterAddPage() {
    resetCharacterAddPage();
    showPage('page-character-add');
}

export async function openCharacterEditPage(charId) {
    const char = AppState.characterProfiles.find(item => String(item.id) === String(charId) && !item.isGroup);
    if (!char) {
        showDynamicIsland('没有找到要编辑的角色');
        return;
    }
    const filled = await fillCharacterAddPageForEdit(char);
    if (filled) {
        showPage('page-character-add');
    }
}

export function initCharacterAddPage() {
    getEl('ca-relation-mode-group')?.addEventListener('click', (event) => {
        const button = event.target.closest('.ca-mode-card');
        if (!button) return;
        setRelationMode(button.dataset.mode || 'stranger');
    });

    getEl('ca-avatar-upload')?.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        getEl('ca-avatar-preview').src = await readFileAsDataUrl(file);
    });

    getEl('ca-identity-add-btn')?.addEventListener('click', () => {
        openCharacterIdentityModal();
    });

    getEl('ca-identity-avatar-upload')?.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        getEl('ca-identity-avatar-preview').src = await readFileAsDataUrl(file);
    });

    getEl('ca-identity-modal-save')?.addEventListener('click', () => {
        saveIdentityFromCharacterAddModal().catch(error => {
            console.error('新增用户身份失败:', error);
            showDynamicIsland('新增身份失败');
        });
    });

    getEl('ca-identity-modal-cancel')?.addEventListener('click', closeCharacterIdentityModal);
    getEl('ca-identity-modal-close')?.addEventListener('click', closeCharacterIdentityModal);
    getEl('ca-identity-modal')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) closeCharacterIdentityModal();
    });

    getEl('ca-npc-avatar-upload')?.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        getEl('ca-npc-avatar-preview').src = await readFileAsDataUrl(file);
    });

    getEl('ca-npc-probability-input')?.addEventListener('input', (event) => {
        const display = getEl('ca-npc-prob-display');
        if (display) display.textContent = `${event.target.value}%`;
    });

    getEl('ca-speed-input')?.addEventListener('input', (event) => {
        getEl('ca-speed-value').textContent = event.target.value;
    });

    getEl('ca-worldbook-keyword-toggle')?.addEventListener('change', (event) => {
        const kwInput = getEl('ca-worldbook-keywords-input');
        if (kwInput) kwInput.style.display = event.target.checked ? 'block' : 'none';
    });

    getEl('ca-worldbook-add-existing-btn')?.addEventListener('click', () => {
        openCharacterWorldBookPicker().catch(error => {
            console.error('打开世界书选择弹窗失败:', error);
            showDynamicIsland('世界书读取失败');
        });
    });
    getEl('ca-persona-import-btn')?.addEventListener('click', () => {
        getEl('ca-persona-import-input')?.click();
    });

    getEl('ca-persona-import-input')?.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            showDynamicIsland(file.name.toLowerCase().endsWith('.docx') ? '正在解析 docx...' : '正在导入 TXT...');
            const imported = await readWorldBookImportFile(file);
            const personaEl = getEl('ca-persona-input');
            if (personaEl) {
                personaEl.value = imported.content;
            }
            showDynamicIsland('人设内容已导入');
        } catch (error) {
            console.error('角色页人设导入失败:', error);
            showDynamicIsland('导入失败，请检查文件');
        } finally {
            event.target.value = '';
        }
    });
    getEl('ca-worldbook-import-btn')?.addEventListener('click', () => {
        getEl('ca-worldbook-import-input')?.click();
    });

    getEl('ca-worldbook-import-input')?.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            showDynamicIsland(file.name.toLowerCase().endsWith('.docx') ? '正在解析 docx...' : '正在导入 TXT...');
            const imported = await readWorldBookImportFile(file);
            if (!getEl('ca-worldbook-title-input').value.trim()) {
                getEl('ca-worldbook-title-input').value = imported.title;
            }
            getEl('ca-worldbook-content-input').value = imported.content;
            showDynamicIsland('世界书内容已导入');
        } catch (error) {
            console.error('角色页世界书导入失败:', error);
            showDynamicIsland('导入失败，请检查文件');
        } finally {
            event.target.value = '';
        }
    });

    getEl('ca-worldbook-draft-add-btn')?.addEventListener('click', async () => {
        const title = getEl('ca-worldbook-title-input').value.trim();
        const content = getEl('ca-worldbook-content-input').value.trim();
        if (!title && !content) {
            showDynamicIsland('请先填写世界书标题或内容');
            return;
        }
        const caKwToggle = getEl('ca-worldbook-keyword-toggle');
        const caKwRaw = getEl('ca-worldbook-keywords-input')?.value || '';
        const caKwList = caKwRaw.split(/[,，\n]/).map(k => k.trim()).filter(k => k.length > 0);
        const draftData = {
            title: title || '角色设定',
            content,
            importance: getEl('ca-worldbook-importance-select').value || 'medium',
            injectionPosition: getEl('ca-worldbook-position-select')?.value || 'default',
            keywordTriggerEnabled: caKwToggle?.checked || false,
            keywords: caKwList
        };
        if (editingWorldBookDraftIndex > -1) {
            addPageWorldBookDrafts[editingWorldBookDraftIndex] = draftData;
        } else {
            addPageWorldBookDrafts.push(draftData);
        }
        resetWorldBookDraftForm();
        await renderCharacterAddWorldBookList();
    });

    getEl('ca-worldbook-selected-list')?.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        if (button.dataset.action === 'edit-existing') {
            await openEditWorldBookModal(toWorldBookEntryId(button.dataset.id));
            return;
        }
        if (button.dataset.action === 'remove-existing') {
            addPageWorldBookIds = addPageWorldBookIds.filter(id => String(id) !== String(button.dataset.id));
        }
        if (button.dataset.action === 'remove-category') {
            addPageWorldBookCategories = addPageWorldBookCategories.filter(category => category !== button.dataset.category);
        }
        if (button.dataset.action === 'edit-draft') {
            loadWorldBookDraftForEdit(Number(button.dataset.index));
            return;
        }
        if (button.dataset.action === 'remove-draft') {
            addPageWorldBookDrafts.splice(Number(button.dataset.index), 1);
            if (editingWorldBookDraftIndex === Number(button.dataset.index)) resetWorldBookDraftForm();
        }
        await renderCharacterAddWorldBookList();
    });

    getEl('ca-worldbook-picker-modal')?.addEventListener('click', async (event) => {
        if (event.target === event.currentTarget || event.target.closest('#ca-worldbook-picker-close')) {
            closeCharacterWorldBookPicker();
            return;
        }
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const entryId = toWorldBookEntryId(button.dataset.id);
        if (button.dataset.action === 'edit') {
            await openEditWorldBookModal(entryId);
            return;
        }
        if (button.dataset.action === 'select-group') {
            const category = button.dataset.category || '';
            if (category && !addPageWorldBookCategories.includes(category)) {
                addPageWorldBookCategories.push(category);
            }
            await renderCharacterAddWorldBookList();
            await renderCharacterWorldBookPickerList(getEl('ca-worldbook-picker-search-input')?.value || '');
            showDynamicIsland('世界书分组已挂载');
            return;
        }
        if (button.dataset.action === 'select') {
            if (!addPageWorldBookIds.some(id => Number(id) === Number(entryId))) {
                addPageWorldBookIds.push(entryId);
            }
            await renderCharacterAddWorldBookList();
            await renderCharacterWorldBookPickerList(getEl('ca-worldbook-picker-search-input')?.value || '');
            showDynamicIsland('世界书已挂载');
        }
    });

    getEl('ca-worldbook-picker-search-input')?.addEventListener('input', (event) => {
        clearTimeout(event.target._caWbSearchTimer);
        event.target._caWbSearchTimer = setTimeout(() => {
            renderCharacterWorldBookPickerList(event.target.value).catch(error => console.warn('[CharacterAdd] picker search failed:', error));
        }, 180);
    });

    getEl('ca-npc-ai-generate-btn')?.addEventListener('click', () => {
        generateCharacterNpcDraftsWithAI().catch(error => {
            console.error('Character NPC AI generation failed:', error);
            showDynamicIsland('NPC AI 生成失败，请检查 API 设置');
        });
    });

    getEl('ca-npc-add-btn')?.addEventListener('click', () => {
        const name = getEl('ca-npc-name').value.trim();
        if (!name) {
            showDynamicIsland('请先填写 NPC 名字');
            return;
        }
        const previousNpc = editingNpcIndex > -1 ? addPageNpcs[editingNpcIndex] : null;
        const npcData = {
            ...(previousNpc || {}),
            name,
            relation: getEl('ca-npc-relation').value.trim(),
            persona: getEl('ca-npc-persona').value.trim(),
            avatar: getEl('ca-npc-avatar-preview').src,
            probability: normalizeNpcProbability(getEl('ca-npc-probability-input').value)
        };
        if (editingNpcIndex > -1) {
            addPageNpcs[editingNpcIndex] = npcData;
            editingNpcIndex = -1;
            getEl('ca-npc-add-btn').textContent = '添加 NPC';
        } else {
            addPageNpcs.push(npcData);
        }
        getEl('ca-npc-name').value = '';
        getEl('ca-npc-relation').value = '';
        getEl('ca-npc-persona').value = '';
        getEl('ca-npc-avatar-preview').src = 'images/default-avatar.svg';
        getEl('ca-npc-avatar-upload').value = '';
        getEl('ca-npc-probability-input').value = String(DEFAULT_NPC_PROBABILITY);
        getEl('ca-npc-prob-display').textContent = `${DEFAULT_NPC_PROBABILITY}%`;
        renderAddPageNpcs();
    });

    getEl('ca-npc-list')?.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-index]');
        if (!button) return;
        const index = Number(button.dataset.index);
        if (button.dataset.action === 'edit') {
            const npc = addPageNpcs[index];
            if (!npc) return;
            editingNpcIndex = index;
            getEl('ca-npc-name').value = npc.name || '';
            getEl('ca-npc-relation').value = npc.relation || '';
            getEl('ca-npc-persona').value = npc.persona || '';
            getEl('ca-npc-avatar-preview').src = isValidAvatarSrc(npc.avatar) ? npc.avatar : 'images/default-avatar.svg';
            const probability = normalizeNpcProbability(npc.probability);
            getEl('ca-npc-probability-input').value = String(probability);
            getEl('ca-npc-prob-display').textContent = `${probability}%`;
            getEl('ca-npc-add-btn').textContent = '保存 NPC';
            renderAddPageNpcs();
            return;
        }
        addPageNpcs.splice(index, 1);
        if (editingNpcIndex === index) {
            editingNpcIndex = -1;
            getEl('ca-npc-add-btn').textContent = '添加 NPC';
            getEl('ca-npc-probability-input').value = String(DEFAULT_NPC_PROBABILITY);
            getEl('ca-npc-prob-display').textContent = `${DEFAULT_NPC_PROBABILITY}%`;
        } else if (editingNpcIndex > index) {
            editingNpcIndex -= 1;
        }
        renderAddPageNpcs();
    });

    getEl('ca-cancel-btn')?.addEventListener('click', () => showPage('page-character-library'));
    getEl('ca-save-btn')?.addEventListener('click', () => {
        saveCharacterFromAddPage().catch(error => {
            console.error('保存新角色失败:', error);
            showDynamicIsland('角色保存失败，请检查控制台');
        });
    });

    window.openCharacterAddPage = openCharacterAddPage;
    window.openCharacterEditPage = openCharacterEditPage;
}
