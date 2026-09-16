import { exportChunkData, importChunkFiles } from './data-manager.js';
import { showDynamicIsland } from '../ui.js';
import { isNativeRuntime } from '../native-bridge.js';

const CONFIG_KEY = 'github_backup_config';
const API_ROOT = 'https://api.github.com';
const DEFAULT_REPO = 'looky-private-backups';
const DEFAULT_MANIFEST = 'looky-backup-manifest.json';
let autoBackupRunning = false;
let cloudBackupRunning = false;
// GitHub receives the JSON file as Base64 inside the request body. Keep a
// generous margin below GitHub's 100 MB contents limit after that expansion.
// The Contents API requires Base64 JSON payloads, which temporarily adds
// another large string during upload. Keep the safer target for APK/low-memory
// runtimes, while preserving the faster 16MB target for ordinary web browsers.
const GITHUB_STANDARD_CHUNK_BYTES = 16 * 1024 * 1024;
const GITHUB_LOW_MEMORY_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_GITHUB_CHUNK_BYTES = 64 * 1024 * 1024;

function getGithubTargetChunkBytes() {
    const deviceMemory = Number(typeof navigator !== 'undefined' ? navigator.deviceMemory : 0);
    return isNativeRuntime() || (Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory <= 2)
        ? GITHUB_LOW_MEMORY_CHUNK_BYTES
        : GITHUB_STANDARD_CHUNK_BYTES;
}

function readConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}') || {}; } catch { return {}; }
}

function writeConfig(config) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({
        token: String(config.token || '').trim(), owner: String(config.owner || '').trim(), repo: String(config.repo || DEFAULT_REPO).trim() || DEFAULT_REPO,
        manifestPath: String(config.manifestPath || DEFAULT_MANIFEST).trim() || DEFAULT_MANIFEST,
        autoEnabled: Boolean(config.autoEnabled), autoMode: config.autoMode === 'time' ? 'time' : 'daily', autoDays: Math.max(1, Math.min(365, Number(config.autoDays) || 1)),
        autoTime: /^\d{2}:\d{2}$/.test(config.autoTime || '') ? config.autoTime : '22:00', lastAutoBackup: config.lastAutoBackup || ''
    }));
}

async function githubRequest(path, options = {}, token = readConfig().token) {
    if (!token) throw new Error('请先完成 GitHub 登录');
    const response = await fetch(`${API_ROOT}${path}`, { ...options, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(options.headers || {}) } });
    if (!response.ok) {
        let message = `GitHub 请求失败（${response.status}）`;
        try { const body = await response.json(); if (body?.message) message += `：${body.message}`; } catch { /* 状态码已足够 */ }
        const error = new Error(message); error.status = response.status; throw error;
    }
    return response.status === 204 ? null : response.json();
}

function encodeBase64(value) {
    const bytes = typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
            ? value
            : new Uint8Array(value || []);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}
function decodeBase64(value) { const binary = atob(String(value || '').replace(/\s/g, '')); return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0))); }
function pathUrl(path) { return String(path).split('/').filter(Boolean).map(encodeURIComponent).join('/'); }
function requireConfig() { const config = readConfig(); if (!config.token || !config.owner) throw new Error('请先完成 GitHub 登录'); if (!config.repo) config.repo = DEFAULT_REPO; return config; }
async function getFile(path) { const config = requireConfig(); return githubRequest(`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${pathUrl(path)}`); }
async function putFile(path, content, message, sha) { const config = requireConfig(); return githubRequest(`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${pathUrl(path)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, content: encodeBase64(content), ...(sha ? { sha } : {}) }) }); }
async function getExistingManifestSha(manifestPath) {
    if (String(manifestPath).includes('/')) {
        try { return (await getFile(manifestPath))?.sha; } catch (error) { if (error.status !== 404) throw error; return undefined; }
    }
    const rootFiles = await getFile('');
    return Array.isArray(rootFiles) ? rootFiles.find(file => file.name === manifestPath)?.sha : undefined;
}
async function readGithubFileText(file, path) {
    if (file?.content) return decodeBase64(file.content);
    if (!path) throw new Error('GitHub 备份文件内容为空');
    const config = requireConfig();
    const response = await fetch(`${API_ROOT}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${pathUrl(path)}`, {
        headers: { Accept: 'application/vnd.github.raw+json', Authorization: `Bearer ${config.token}`, 'X-GitHub-Api-Version': '2022-11-28' }
    });
    if (!response.ok) throw new Error(`GitHub 备份分块下载失败（${response.status}）`);
    return response.text();
}

export function getGithubBackupConfig() { return readConfig(); }

export async function startGithubLogin() {
    // GitHub supports pre-filling permissions, but deliberately requires the user to confirm repository access themselves.
    const tokenTemplate = new URLSearchParams({ name: 'LOOKY 云端备份', description: '用于创建和读写 LOOKY 私人备份仓库', expires_in: '90', contents: 'write', administration: 'write' });
    const loginUrl = `https://github.com/settings/personal-access-tokens/new?${tokenTemplate}`;
    const nativeBrowser = window.Capacitor?.Plugins?.Browser;
    let opened = false;
    if (isNativeRuntime() && typeof nativeBrowser?.open === 'function') {
        try {
            await nativeBrowser.open({ url: loginUrl });
            opened = true;
        } catch (error) {
            console.warn('无法使用 APK 浏览器插件，将使用系统默认跳转方式。', error);
        }
    }
    if (!opened) {
        opened = Boolean(window.open(loginUrl, '_blank', 'noopener,noreferrer'));
    }
    if (!opened) {
        const link = document.createElement('a');
        link.href = loginUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
        document.body.appendChild(link); link.click(); link.remove();
    }
    showDynamicIsland('GitHub 已预填所需权限；请选择 All repositories 后生成 Token');
}

export async function verifyGithubToken(token) {
    const user = await githubRequest('/user', {}, String(token || '').trim());
    writeConfig({ ...readConfig(), token: String(token || '').trim(), owner: user.login });
    return user;
}

export async function createPrivateRepository() {
    const config = requireConfig(); const repoName = config.repo || DEFAULT_REPO; let repo;
    try { repo = await githubRequest('/user/repos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: repoName, private: true, description: 'LOOKY 私人备份仓库', auto_init: true }) }); }
    catch (error) {
        if (error.status !== 422) throw error;
        repo = await githubRequest(`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(repoName)}`);
        if (!repo?.private) throw new Error('同名仓库已存在，但它不是私人仓库');
    }
    writeConfig({ ...config, repo: repo.name }); showDynamicIsland('私人仓库已准备好', 'success'); return repo;
}

function showGithubTaskProgress(message) {
    showDynamicIsland(message, { loading: true, persist: true, force: true });
}

function setGithubBackupBusy(isBusy) {
    const card = document.getElementById('github-backup-card');
    if (!card) return;
    card.classList.toggle('is-busy', isBusy);
    card.setAttribute('aria-busy', String(isBusy));
    card.querySelectorAll('button, input, select').forEach(control => {
        if (isBusy) {
            control.dataset.githubBackupWasDisabled = control.disabled ? 'true' : 'false';
            control.disabled = true;
        } else {
            control.disabled = control.dataset.githubBackupWasDisabled === 'true';
            delete control.dataset.githubBackupWasDisabled;
        }
    });
}

async function runGithubBackupTask(task) {
    if (cloudBackupRunning) {
        showDynamicIsland('云端备份正在进行，请稍候', 'warning');
        return false;
    }
    cloudBackupRunning = true;
    setGithubBackupBusy(true);
    try {
        await task();
        return true;
    } finally {
        cloudBackupRunning = false;
        setGithubBackupBusy(false);
    }
}

export async function uploadGithubBackup() {
    const config = requireConfig();
    const entries = [];
    showGithubTaskProgress('正在准备 GitHub 云端备份...');
    const exportResult = await exportChunkData({ skipConfirm: true, targetChunkBytes: getGithubTargetChunkBytes(), onChunk: async (blob, fileName, partNumber) => {
        if (blob.size > MAX_GITHUB_CHUNK_BYTES) {
            throw new Error(`第 ${partNumber} 个分块超过 64MB，GitHub 的 Base64 上传请求可能超过接口限制；请先压缩图片后再备份`);
        }
        showGithubTaskProgress(`正在上传第 ${partNumber} 个分块...`);
        let chunkBytes = null;
        try {
            // Avoid Blob -> UTF-16 text -> TextEncoder copies. GitHub still
            // receives the same JSON bytes, but the upload path keeps one
            // binary representation until Base64 encoding begins.
            chunkBytes = typeof blob.arrayBuffer === 'function'
                ? new Uint8Array(await blob.arrayBuffer())
                : await blob.text();
            await putFile(`backups/${fileName}`, chunkBytes, `上传备份分块 ${partNumber}`);
        } finally {
            chunkBytes = null;
        }
        entries.push(fileName);
        showGithubTaskProgress(`已上传第 ${partNumber} 个分块，正在准备下一份...`);
    }});
    if (!exportResult || exportResult.partCount !== entries.length || entries.length === 0) {
        throw new Error('本地导出任务正在进行或没有生成备份，请结束后再上传云端备份');
    }
    showGithubTaskProgress('正在更新云端备份清单...');
    const manifestPath = config.manifestPath || DEFAULT_MANIFEST;
    const manifestSha = await getExistingManifestSha(manifestPath);
    await putFile(manifestPath, JSON.stringify({ format: 'looky-github-chunks-v1', createdAt: new Date().toISOString(), backupId: exportResult.backupId, partCount: exportResult.partCount, entries }, null, 2), '更新备份清单', manifestSha);
    writeConfig({ ...config, lastAutoBackup: new Date().toISOString() });
    showDynamicIsland('GitHub 云端备份完成', { variant: 'success', force: true });
}

export async function downloadGithubBackup() {
    const config = requireConfig();
    showGithubTaskProgress('正在读取 GitHub 备份清单...');
    const manifestPath = config.manifestPath || DEFAULT_MANIFEST;
    const manifestFile = await getFile(manifestPath); const manifest = JSON.parse(await readGithubFileText(manifestFile, manifestPath));
    if (manifest.format !== 'looky-github-chunks-v1' || !Array.isArray(manifest.entries) || !manifest.entries.length) throw new Error('GitHub 备份清单无效');
    const entries = manifest.entries.map(name => String(name));
    if (!entries.every(name => /^\[[^/\\[\]]+\]_\[part\d+\]_(?:looky|link)_backup_\d{4}-\d{2}-\d{2}_(base|table|messages|resource)\.json$/i.test(name))) throw new Error('GitHub 备份清单包含不安全的文件名');
    if (manifest.partCount != null && Number(manifest.partCount) !== entries.length) throw new Error('GitHub 备份清单的分块数量不一致');
    if (manifest.backupId != null && !entries.every(name => name.startsWith(`[${manifest.backupId}]_`))) throw new Error('GitHub 备份清单包含了不同批次的文件');
    // Validation and restore read each chunk twice. Caching is useful for small
    // backups, but retaining every large chunk would recreate the memory peak
    // this export path is designed to avoid.
    const fileTextCache = entries.length <= 8 ? new Map() : null;
    const files = entries.map(name => ({ name, readText: async () => {
        if (!fileTextCache) {
            showGithubTaskProgress(`正在拉取备份文件...`);
            return readGithubFileText(await getFile(`backups/${name}`), `backups/${name}`);
        }
        if (!fileTextCache.has(name)) {
            showGithubTaskProgress(`正在拉取备份文件 ${fileTextCache.size + 1}/${entries.length}...`);
            const backupPath = `backups/${name}`;
            fileTextCache.set(name, readGithubFileText(await getFile(backupPath), backupPath));
        }
        return fileTextCache.get(name);
    }}));
    const imported = await importChunkFiles(files, { skipConfirm: true, onProgress: showGithubTaskProgress });
    if (!imported) throw new Error('拉取备份未完成，本地数据没有被替换');
    showDynamicIsland('GitHub 云端备份已拉取', { variant: 'success', force: true });
}

function shouldAutoBackup(config) {
    if (!config.autoEnabled) return false;
    const now = new Date(); const today = now.toISOString().slice(0, 10);
    if (config.autoMode === 'daily') {
        const last = config.lastAutoBackup ? new Date(config.lastAutoBackup) : null;
        const elapsedDays = last && !Number.isNaN(last.getTime()) ? (now.getTime() - last.getTime()) / 86400000 : Infinity;
        return elapsedDays >= Number(config.autoDays || 1);
    }
    return now.getHours() === Number(String(config.autoTime || '22:00').slice(0, 2)) && now.getMinutes() === Number(String(config.autoTime || '22:00').slice(3, 5)) && config.lastAutoBackup?.slice(0, 16) !== `${today}T${config.autoTime}`;
}

export async function initGithubBackup() {
    const token = document.getElementById('github-token-input'); const repo = document.getElementById('github-repo-input'); const ownerDisplay = document.getElementById('github-owner-display'); const accountRow = document.querySelector('.github-account-row'); const status = document.getElementById('github-backup-status');
    const autoToggle = document.getElementById('github-auto-toggle'); const autoMode = document.getElementById('github-auto-mode'); const autoDays = document.getElementById('github-auto-days'); const autoTime = document.getElementById('github-auto-time');
    const autoControls = document.getElementById('github-auto-controls'); const autoDaysField = document.getElementById('github-auto-days-field'); const autoTimeField = document.getElementById('github-auto-time-field'); const autoSummary = document.getElementById('github-auto-summary');
    if (!token || !repo || !status) return; const config = readConfig(); token.value = config.token || ''; repo.value = config.repo || DEFAULT_REPO; if (ownerDisplay) ownerDisplay.textContent = config.owner || '未验证'; accountRow?.classList.toggle('is-connected', Boolean(config.owner)); if (config.token && config.owner) { status.textContent = `已登录：${config.owner}`; status.className = 'github-backup-status status-connected'; }
    if (autoToggle) autoToggle.checked = Boolean(config.autoEnabled); if (autoMode) autoMode.value = config.autoMode || 'daily'; if (autoDays) autoDays.value = config.autoDays || 1; if (autoTime) autoTime.value = config.autoTime || '22:00';
    const refreshAutoFields = () => { const daily = autoMode?.value !== 'time'; if (autoDaysField) autoDaysField.hidden = !daily; if (autoTimeField) autoTimeField.hidden = daily; autoControls?.classList.toggle('is-disabled', !autoToggle?.checked); if (autoSummary) autoSummary.textContent = autoToggle?.checked ? `${daily ? `每隔 ${autoDays?.value || 1} 天自动备份` : `每天 ${autoTime?.value || '22:00'} 自动备份`}（应用保持打开时）` : '当前已关闭'; };
    refreshAutoFields();
    const save = () => writeConfig({ ...readConfig(), repo: repo.value, autoEnabled: autoToggle?.checked, autoMode: autoMode?.value, autoDays: autoDays?.value, autoTime: autoTime?.value });
    document.getElementById('github-login-btn')?.addEventListener('click', startGithubLogin);
    document.getElementById('github-save-token-btn')?.addEventListener('click', async () => { try { const user = await verifyGithubToken(token.value); if (ownerDisplay) ownerDisplay.textContent = user.login; accountRow?.classList.add('is-connected'); status.textContent = `已登录：${user.login}`; status.className = 'github-backup-status status-connected'; } catch (e) { status.textContent = e.message; status.className = 'github-backup-status status-error'; showDynamicIsland(e.message, 'error'); } });
    document.getElementById('github-create-repo-btn')?.addEventListener('click', async () => { try { save(); await createPrivateRepository(); status.textContent = `私人仓库 ${repo.value} 已准备好`; status.className = 'github-backup-status status-connected'; } catch (e) { status.textContent = e.message; status.className = 'github-backup-status status-error'; showDynamicIsland(e.message, 'error'); } });
    document.getElementById('github-upload-btn')?.addEventListener('click', async () => { try { save(); if (!await runGithubBackupTask(uploadGithubBackup)) return; status.textContent = '备份已上传'; status.className = 'github-backup-status status-connected'; } catch (e) { status.textContent = e.message; status.className = 'github-backup-status status-error'; showDynamicIsland('云端备份失败', { variant: 'error', detail: e.message, force: true, copyText: e.stack || e.message }); } });
    document.getElementById('github-download-btn')?.addEventListener('click', async () => { if (!confirm('拉取 GitHub 备份会覆盖当前本地数据，确定继续吗？')) return; try { save(); if (!await runGithubBackupTask(downloadGithubBackup)) return; status.textContent = '备份已拉取'; status.className = 'github-backup-status status-connected'; } catch (e) { status.textContent = e.message; status.className = 'github-backup-status status-error'; showDynamicIsland('拉取备份失败', { variant: 'error', detail: e.message, force: true, copyText: e.stack || e.message }); } });
    [repo, autoToggle, autoMode, autoDays, autoTime].filter(Boolean).forEach(input => input.addEventListener('change', () => { save(); refreshAutoFields(); }));
    setInterval(() => {
        const latest = readConfig();
        if (!autoBackupRunning && !cloudBackupRunning && shouldAutoBackup(latest)) {
            autoBackupRunning = true;
            runGithubBackupTask(uploadGithubBackup).catch(error => showDynamicIsland('自动备份失败', { variant: 'error', detail: error.message, force: true, copyText: error.stack || error.message })).finally(() => { autoBackupRunning = false; });
        }
    }, 60000);
}
