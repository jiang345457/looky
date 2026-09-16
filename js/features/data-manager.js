// 文件路径: js/features/data-manager.js

import { AppState, db } from '../state.js';
import { showDynamicIsland } from '../ui.js';
import { compressImageDataUrl } from '../utils.js';
import { isNativeRuntime, saveBlobToNativeStorage, isNativeBackupSupported, beginNativeBackupExport, appendNativeBackupPart, finishNativeBackupExport, abortNativeBackupExport, openNativeBackupImport, readNativeBackupPart, closeNativeBackupImport } from '../native-bridge.js';

// ===================================================================
// == 1. 工具函数优化 ==
// ===================================================================

// 优化：使用 startsWith 比正则快得多
const isBase64Image = (str) => typeof str === 'string' && str.startsWith('data:image/');
const IMPORT_IMAGE_THRESHOLD = 680000;
const IMPORT_IMAGE_DATA_KEYS = new Set([
    'homeWallpaper',
    'systemUiBackground',
    'appContentBackground',
    'homeScreenImages',
    'iconSettings',
    'profileDIYData',
    'idCardData',
    'playerWidgetData',
    'desktopSchemes'
]);

async function compressLargeImportedImage(value) {
    if (!isBase64Image(value) || value.length <= IMPORT_IMAGE_THRESHOLD) return value;
    return compressImage(value);
}

async function compressImagesInObject(value) {
    if (isBase64Image(value)) return compressLargeImportedImage(value);
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
            value[index] = await compressImagesInObject(value[index]);
        }
        return value;
    }
    if (!value || typeof value !== 'object') return value;
    for (const key of Object.keys(value)) {
        value[key] = await compressImagesInObject(value[key]);
    }
    return value;
}

async function normalizeImportedImageData(tableName, item) {
    if (!item || typeof item !== 'object') return item;

    if (tableName === 'appData' && IMPORT_IMAGE_DATA_KEYS.has(item.key)) {
        item.value = await compressImagesInObject(item.value);
    } else if (tableName === 'characterProfiles') {
        if (item.avatar) item.avatar = await compressLargeImportedImage(item.avatar);
        if (item.chatBackground) item.chatBackground = await compressLargeImportedImage(item.chatBackground);
    }

    return item;
}

const DEFAULT_EXPORT_OPTIONS = {
    offline: true,
    shop: true,
    music: true,
    couple: true,
    download: true
};

// 认证状态属于当前设备，不随备份迁移到另一台设备。
const LOOKY_AUTH_STORAGE_KEYS = new Set([
    'sessionToken',
    'accountKey',
    'displayAccount',
    'looky_device_id',
    'looky_access_granted',
    'looky_access_granted_backup',
    'looky_session_name',
    'looky_force_login',
    'looky_auth_event',
    'github_backup_config'
]);

let activeExportMode = null;
let activeImportMode = null;

function getDataTaskConflictMessage() {
    if (activeExportMode) return '已有导出任务正在进行，请结束后再导入';
    return '已有导入任务正在进行，请稍候';
}

function normalizeExportOptions(options = {}) {
    return { ...DEFAULT_EXPORT_OPTIONS, ...options };
}

function isAppleMobile() {
    if (typeof navigator === 'undefined') return false;
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function shouldExportLocalStorageKey(key, options) {
    if (!key || LOOKY_AUTH_STORAGE_KEYS.has(key) || key === 'link_hybrid_state') return false;
    if (!options.offline && (key.includes('offline') || key.includes('scenario') || key.includes('ifline'))) return false;
    if (!options.shop && (key.includes('shop') || key.includes('cart') || key.includes('food') || key.includes('ride') || key.includes('wallet'))) return false;
    if (!options.music && (key.includes('music') || key.includes('lyric') || key.includes('player'))) return false;
    if (!options.couple && (key.includes('couple') || key.includes('anniversary') || key.includes('period') || key.includes('coupon') || key.includes('mood') || key.includes('rules') || key.includes('corkboard') || key.includes('mailbox') || key.includes('cs_'))) return false;
    return true;
}

function shouldExportTable(tableName, options) {
    if (!options.shop && tableName === 'shopCustomData') return false;
    if (!options.offline && (tableName === 'offlineMessages' || tableName === 'offlineSessions')) return false;
    return true;
}

function shouldSkipAppDataRow(tableName, row, options) {
    return !options.offline
        && tableName === 'appData'
        && row
        && typeof row.key === 'string'
        && row.key.includes('ifline_html');
}

async function countExportChunks(table, tableName, options, chunkSize) {
    if (options.offline || tableName !== 'appData') {
        const count = await table.count();
        return count > 0 ? Math.ceil(count / chunkSize) : 0;
    }

    let sourceRowsInChunk = 0;
    let hasExportableRow = false;
    let chunkCount = 0;
    await table.each(row => {
        sourceRowsInChunk++;
        if (!shouldSkipAppDataRow(tableName, row, options)) hasExportableRow = true;
        if (sourceRowsInChunk === chunkSize) {
            if (hasExportableRow) chunkCount++;
            sourceRowsInChunk = 0;
            hasExportableRow = false;
        }
    });
    if (sourceRowsInChunk > 0 && hasExportableRow) chunkCount++;
    return chunkCount;
}

function clearImportLocalStorage() {
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (!LOOKY_AUTH_STORAGE_KEYS.has(key) && key !== 'link_hybrid_state') localStorage.removeItem(key);
    }
}

// 优化：采样哈希函数 (Fast Hash)
// 原本的哈希函数会遍历几十万个字符，手机CPU会烫。
// 这个版本只采头、尾和中间的样，速度快 100 倍，且能保持唯一性。
function fastHash(str) {
    // 短字符串直接算
    if (str.length < 500) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return 'h' + Math.abs(hash).toString(36);
    }
    // 长字符串（图片）采样算
    let hash = str.length;
    // 每隔 100 个字符采一个样
    const step = Math.max(1, Math.floor(str.length / 100)); 
    for (let i = 0; i < str.length; i += step) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    // 加上末尾几个字符防冲突
     hash += str.charCodeAt(str.length - 1);
    return 'f' + Math.abs(hash).toString(36) + '_' + str.length.toString(36);
}

function getCSDBData() {
    return new Promise((resolve) => {
        const req = indexedDB.open('CoupleSpaceData', 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore('store');
        req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('store')) { db.close(); resolve({}); return; }
            const tx = db.transaction('store', 'readonly');
            const store = tx.objectStore('store');
            const res = {};
            const cursorReq = store.openCursor();
            cursorReq.onsuccess = event => {
                const cursor = event.target.result;
                if (!cursor) {
                    db.close();
                    resolve(res);
                    return;
                }
                res[cursor.key] = cursor.value;
                cursor.continue();
            };
            tx.onerror = () => { db.close(); resolve({}); };
        };
        req.onerror = () => resolve({});
    });
}

function putCSDBData(dataObj, options = {}) {
    return new Promise((resolve) => {
        const req = indexedDB.open('CoupleSpaceData', 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore('store');
        req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('store', 'readwrite');
            const store = tx.objectStore('store');
            if (options.clearExisting !== false) store.clear();
            for (const key in dataObj) store.put(dataObj[key], key);
            tx.oncomplete = () => { db.close(); resolve(); };
        };
        req.onerror = () => resolve();
    });
}

// 辅助函数
const sleep = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const UTF8_ENCODER = typeof TextEncoder === 'function' ? new TextEncoder() : null;

function getUtf8ByteLength(value) {
    const text = String(value ?? '');
    if (UTF8_ENCODER) return UTF8_ENCODER.encode(text).length;
    return unescape(encodeURIComponent(text)).length;
}

function getExportAssetByteLength(assetKey, assetValue) {
    return assetKey.length + getUtf8ByteLength(JSON.stringify(assetValue)) + 4;
}

function formatExportBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} B`;
}

function reportExportDiagnostic(options, detail) {
    const runtimeDetail = typeof window !== 'undefined'
        ? {
            runtime: window.__lookyRuntime || 'unknown',
            buildVersion: window.__LOOKY_BUILD_VERSION
                || (typeof document !== 'undefined' ? document.documentElement?.dataset?.buildVersion : '')
                || 'unknown'
        }
        : {};
    const diagnostic = { ...detail, ...runtimeDetail };
    console.warn('[LOOKY 导出体积诊断]', diagnostic);
    if (typeof options?.onDiagnostic === 'function') {
        try { options.onDiagnostic(diagnostic); } catch (error) { console.warn('导出诊断回调失败:', error); }
    }
}

const LARGE_EXPORT_ITEM_BYTES = 512 * 1024;

// 单条记录超过普通分块上限时，不再把整条记录塞进一个巨大 JSON。
// 溢出资源使用独立的小 JSON 文件保存，导入时按 resourceId 还原。
const OVERFLOW_RESOURCE_VERSION = '1.6-resource';
const OVERFLOW_RESOURCE_REF_KEY = '__lookyOverflowRef';
const OVERFLOW_RESOURCE_JSON_REF_KEY = '__lookyOverflowJsonRef';
const OVERFLOW_RESOURCE_TARGET_BYTES = 8 * 1024 * 1024;
const OVERFLOW_RESOURCE_NATIVE_TARGET_BYTES = 3 * 1024 * 1024;

const SAFE_IMPORT_BATCH_SIZE = isNativeRuntime() ? 25 : 100;

function createOverflowResourceId(prefix, sequence) {
    return `overflow_${prefix}_${sequence}_${Date.now().toString(36)}`;
}

function isOverflowResourceRef(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) {
        return false;
    }
    const resourceId = value[OVERFLOW_RESOURCE_REF_KEY] || value[OVERFLOW_RESOURCE_JSON_REF_KEY];
    return typeof resourceId === 'string' && /^overflow_[A-Za-z0-9_-]{1,160}$/.test(resourceId);
}

function collectOverflowResourceRefs(value, refs) {
    if (isOverflowResourceRef(value)) {
        const resourceId = value[OVERFLOW_RESOURCE_REF_KEY] || value[OVERFLOW_RESOURCE_JSON_REF_KEY];
        refs.add(resourceId);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectOverflowResourceRefs(item, refs);
        return;
    }
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) collectOverflowResourceRefs(value[key], refs);
}

function getResourceSliceEnd(text, start, maxBytes) {
    if (start >= text.length) return start;
    const endsWithHighSurrogate = index => {
        const code = text.charCodeAt(index - 1);
        return code >= 0xD800 && code <= 0xDBFF;
    };
    let span = Math.min(text.length - start, Math.max(1, maxBytes));
    let end = start + span;
    if (end < text.length && endsWithHighSurrogate(end)) end--;

    let bytes = getUtf8ByteLength(text.slice(start, end));
    if (bytes > maxBytes) {
        span = Math.max(1, Math.floor(span * maxBytes / bytes));
        end = Math.min(text.length, start + span);
        if (end < text.length && endsWithHighSurrogate(end)) end--;
        bytes = getUtf8ByteLength(text.slice(start, end));
        while (bytes > maxBytes && end > start + 1) {
            end--;
            if (end < text.length && endsWithHighSurrogate(end)) end--;
            bytes = getUtf8ByteLength(text.slice(start, end));
        }
    }

    while (end < text.length) {
        const nextEnd = end + (endsWithHighSurrogate(end + 1) ? 2 : 1);
        const nextBytes = getUtf8ByteLength(text.slice(start, nextEnd));
        if (nextBytes > maxBytes) break;
        end = nextEnd;
    }
    return Math.max(start + 1, end);
}

function normalizeImportedRow(item) {
    if (!item || typeof item !== 'object') return item;

    if (item.timestamp) {
        const timeObj = new Date(item.timestamp);
        if (!isNaN(timeObj.getTime())) item.timestamp = timeObj;
    }
    if (!item.timestamp && item.time) {
        const timeObj = new Date(item.time);
        if (!isNaN(timeObj.getTime())) item.timestamp = timeObj;
    }
    if (item.startTime) {
        const sTime = new Date(item.startTime);
        if (!isNaN(sTime.getTime())) item.startTime = sTime;
    }
    if (item.endTime) {
        const eTime = new Date(item.endTime);
        if (!isNaN(eTime.getTime())) item.endTime = eTime;
    }
    return item;
}

async function writeImportedRowsSafely(tableName, rows, assetPool, isCompressed) {
    const table = db.table(tableName);
    let lastYieldTime = performance.now();

    for (let i = 0; i < rows.length; i += SAFE_IMPORT_BATCH_SIZE) {
        const batch = [];
        for (const row of rows.slice(i, i + SAFE_IMPORT_BATCH_SIZE)) {
            const item = isCompressed ? decompressObject(row, assetPool) : row;
            await normalizeImportedImageData(tableName, item);
            batch.push(normalizeImportedRow(item));
        }

        try {
            await table.bulkPut(batch);
        } catch (bulkError) {
            console.warn(`批量写入失败，降级为逐条写入: ${tableName}`, bulkError);
            for (const item of batch) {
                await table.put(item);
            }
        }

        if (performance.now() - lastYieldTime > 30) {
            await sleep(0);
            lastYieldTime = performance.now();
        }
    }
}

async function getJSZip() {
    const module = await import('../lib/jszip.min.js');
    return module.default;
}

// 只扫描 JSON 对象的顶层字段，不把整个备份一次性解析成一个巨大对象。
// 这样导入大备份时只会暂时保留“原始文本 + 当前正在处理的字段/数据表”。
function skipJsonWhitespace(text, index, end = text.length) {
    while (index < end && /\s/.test(text[index])) index++;
    return index;
}

function scanJsonStringEnd(text, start, end = text.length) {
    if (text[start] !== '"') throw new Error('备份文件 JSON 字符串格式错误');
    let escaped = false;
    for (let index = start + 1; index < end; index++) {
        const char = text[index];
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') return index + 1;
    }
    throw new Error('备份文件 JSON 字符串未闭合');
}

function scanJsonValueEnd(text, start, end = text.length) {
    const firstChar = text[start];
    if (firstChar === '"') return scanJsonStringEnd(text, start, end);

    if (firstChar === '{' || firstChar === '[') {
        const stack = [firstChar === '{' ? '}' : ']'];
        let index = start + 1;
        while (index < end) {
            const char = text[index];
            if (char === '"') {
                index = scanJsonStringEnd(text, index, end);
                continue;
            }
            if (char === '{') stack.push('}');
            else if (char === '[') stack.push(']');
            else if (char === '}' || char === ']') {
                if (stack[stack.length - 1] !== char) throw new Error('备份文件 JSON 括号不匹配');
                stack.pop();
                if (stack.length === 0) return index + 1;
            }
            index++;
        }
        throw new Error('备份文件 JSON 对象或数组未闭合');
    }

    let index = start;
    while (index < end && text[index] !== ',' && text[index] !== '}' && text[index] !== ']') index++;
    return index;
}

function scanTopLevelObjectEntries(text, rangeStart = 0, rangeEnd = text.length) {
    let index = skipJsonWhitespace(text, rangeStart, rangeEnd);
    if (text[index] !== '{') throw new Error('备份文件 JSON 对象格式错误');
    index = skipJsonWhitespace(text, index + 1, rangeEnd);
    const entries = [];

    while (index < rangeEnd && text[index] !== '}') {
        const keyStart = index;
        const keyEnd = scanJsonStringEnd(text, keyStart, rangeEnd);
        const key = JSON.parse(text.slice(keyStart, keyEnd));
        index = skipJsonWhitespace(text, keyEnd, rangeEnd);
        if (text[index] !== ':') throw new Error('备份文件 JSON 字段缺少冒号');
        const valueStart = skipJsonWhitespace(text, index + 1, rangeEnd);
        const valueEnd = scanJsonValueEnd(text, valueStart, rangeEnd);
        entries.push({ key, start: valueStart, end: valueEnd });
        index = skipJsonWhitespace(text, valueEnd, rangeEnd);
        if (text[index] === ',') {
            index = skipJsonWhitespace(text, index + 1, rangeEnd);
            if (text[index] === '}') throw new Error('备份文件 JSON 不允许末尾多余逗号');
            continue;
        }
        if (text[index] !== '}') throw new Error('备份文件 JSON 字段分隔符错误');
    }

    if (text[index] !== '}') throw new Error('备份文件 JSON 对象未闭合');
    return entries;
}

function parseJsonRange(text, range) {
    return range ? JSON.parse(text.slice(range.start, range.end)) : undefined;
}

function validateOverflowResourceIndex(resourceIndex) {
    for (const [resourceId, entry] of resourceIndex.entries()) {
        const segments = [...entry.segments.values()].sort((left, right) => left.segmentIndex - right.segmentIndex);
        if (segments.length === 0 || segments[0].segmentIndex !== 0) {
            throw new Error(`备份资源缺少起始片段：${resourceId}`);
        }
        let lastIndex = -1;
        let lastCount = 0;
        let lastSeen = false;
        for (const segment of segments) {
            if (segment.segmentIndex !== lastIndex + 1) throw new Error(`备份资源片段不连续：${resourceId}`);
            if (segment.expectedChars !== entry.expectedChars || segment.mode !== entry.mode) {
                throw new Error(`备份资源元数据不一致：${resourceId}`);
            }
            if (segment.isLast) {
                if (lastSeen || segment.segmentIndex !== segments.length - 1) {
                    throw new Error(`备份资源结束片段不正确：${resourceId}`);
                }
                lastSeen = true;
                lastCount = segments.length;
            }
            lastIndex = segment.segmentIndex;
        }
        if (!lastSeen || lastCount !== segments.length) throw new Error(`备份资源缺少结束片段：${resourceId}`);
    }
}

async function resolveOverflowReferences(value, loadResource, cache = new Map()) {
    if (isOverflowResourceRef(value)) {
        const resourceId = value[OVERFLOW_RESOURCE_REF_KEY] || value[OVERFLOW_RESOURCE_JSON_REF_KEY];
        if (!cache.has(resourceId)) cache.set(resourceId, loadResource(resourceId));
        const resolved = await cache.get(resourceId);
        if (value[OVERFLOW_RESOURCE_JSON_REF_KEY]) {
            return resolveOverflowReferences(resolved, loadResource, cache);
        }
        return resolved;
    }
    if (Array.isArray(value)) {
        const result = [];
        for (const item of value) result.push(await resolveOverflowReferences(item, loadResource, cache));
        return result;
    }
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const key of Object.keys(value)) {
        result[key] = await resolveOverflowReferences(value[key], loadResource, cache);
    }
    return result;
}


// ===================================================================
// == 2. 压缩/解压逻辑 (优化了匹配速度) ==
// ===================================================================

const KEY_MAP = {
    id: 'i', name: 'n', timestamp: 't', content: 'c', type: 'y', url: 'u',
    chats: 'C', history: 'h', settings: 's', isGroup: 'g', role: 'r',
    senderName: 'N', isHidden: 'H', aiPersona: 'ap', myPersona: 'mp',
    aiAvatar: 'aa', myAvatar: 'ma', members: 'm', persona: 'p', avatar: 'a',
    userStickers: 'S', worldBooks: 'W', apiConfig: 'A', globalSettings: 'G',
    linkedWorldBookIds: 'wb',
     diaries: 'dy',              // 日记表
    diarySettings: 'dys',       // 日记设置表
    charId: 'cid',              // 角色ID (很多表都通用)
    date: 'd',                  // 日期
    fontUrl: 'fu',              // 字体链接
    listWallpaperUrl: 'lwu',    // 列表壁纸
    detailWallpaperUrl: 'dwu'   // 详情页壁纸
};

const REVERSE_KEY_MAP = Object.fromEntries(
    Object.entries(KEY_MAP).map(([key, value]) => [value, key])
);

function compressObject(obj, assetPool) {
    if (obj === null || typeof obj !== 'object') {
        if (typeof obj === 'string') {
            // 优化：先判断长度，再判断前缀，避免对短文本做正则/哈希
            if (obj.length > 50 && isBase64Image(obj)) {
                const hash = fastHash(obj);
                let assetKey = hash;
                let collisionIndex = 1;
                while (assetPool[assetKey] && assetPool[assetKey] !== obj) {
                    assetKey = `${hash}_${collisionIndex++}`;
                }
                if (!assetPool[assetKey]) {
                    assetPool[assetKey] = obj;
                }
                return `asset_ref:${assetKey}`;
            }
        }
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(item => compressObject(item, assetPool));
    }
     // 专门处理 Date 对象，防止它被错误地转换成空对象 {}
    if (obj instanceof Date) {
        // 直接把日期对象转换成标准的、通用的时间字符串
        return obj.toISOString(); 
    }
    const newObj = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const newKey = KEY_MAP[key] || key;
            newObj[newKey] = compressObject(obj[key], assetPool);
        }
    }
    return newObj;
}
function decompressObject(obj, assetPool) {
    if (obj === null || typeof obj !== 'object') {
        if (typeof obj === 'string') {
            if (obj.startsWith('asset_ref:')) {
                const hash = obj.substring(10);
                return assetPool[hash] || '';
            }
        }
        return obj;
    }
   if (Array.isArray(obj)) {
        // 优化：不要用 Promise.all，它会同时创建所有Promise，内存飙升
        // 改用普通循环串行解压
        const res = [];
        for (const item of obj) {
            res.push(decompressObject(item, assetPool));
        }
        return res;
    }
    const newObj = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const originalKey = REVERSE_KEY_MAP[key] || key;
            newObj[originalKey] = decompressObject(obj[key], assetPool);
        }
    }
    return newObj;
}

function validateAssetReferences(obj, assetPool, fileName) {
    if (obj === null || typeof obj !== 'object') {
        if (typeof obj === 'string' && obj.startsWith('asset_ref:')) {
            const hash = obj.substring(10);
            if (!Object.prototype.hasOwnProperty.call(assetPool, hash)
                || typeof assetPool[hash] !== 'string'
                || assetPool[hash].length === 0) {
                throw new Error(`备份文件资源缺失：${fileName} (${hash})`);
            }
        }
        return;
    }
    if (Array.isArray(obj)) {
        for (const item of obj) validateAssetReferences(item, assetPool, fileName);
        return;
    }
    for (const key of Object.keys(obj)) {
        validateAssetReferences(obj[key], assetPool, fileName);
    }
}
// ===================================================================
// == 3. 导出逻辑 (加入手动GC) ==
// ===================================================================
function buildChunkBlob({ type, backupId, partNumber, totalParts, tables = {}, localStorageData, coupleSpaceData, assetPool = {} }) {
    const parts = [
        `{"timestamp":"${new Date().toISOString()}","version":"1.5-chunk","type":"${type}"`
    ];

    // Size-based streaming chunks cannot know totalParts before they are written.
    // Omit the optional progress metadata; the importer validates the part number
    // from the filename and infers completeness from the selected files.
    if (Number.isInteger(totalParts) && totalParts > 0) {
        parts[0] += `,"backupId":"${backupId}","partNumber":${partNumber},"totalParts":${totalParts}`;
    }

    if (localStorageData !== undefined) {
        parts.push(`,"localStorageData":${JSON.stringify(localStorageData)}`);
        for (const key of Object.keys(localStorageData)) delete localStorageData[key];
    }
    if (coupleSpaceData !== undefined) {
        parts.push(`,"coupleSpaceData":${JSON.stringify(coupleSpaceData)}`);
        for (const key of Object.keys(coupleSpaceData)) delete coupleSpaceData[key];
    }

    parts.push(',"tables":{');
    const tableEntries = Object.entries(tables);
    tableEntries.forEach(([tableName, rows], tableIndex) => {
        if (tableIndex > 0) parts.push(',');
        parts.push(`"${tableName}":[`);
        rows.forEach((row, rowIndex) => {
            if (rowIndex > 0) parts.push(',');
            parts.push(JSON.stringify(row));
        });
        parts.push(']');
        rows.length = 0;
    });
    parts.push('},"assets":{');

    const assetKeys = Object.keys(assetPool);
    assetKeys.forEach((key, index) => {
        if (index > 0) parts.push(',');
        parts.push(`"${key}":${JSON.stringify(assetPool[key])}`);
        assetPool[key] = null;
    });
    parts.push('}}');

    return new Blob(parts, { type: 'application/json' });
}

function buildOverflowResourceBlob({ backupId, resourceId, mode, segmentIndex, isLast, expectedChars, data }) {
    return new Blob([
        JSON.stringify({
            timestamp: new Date().toISOString(),
            version: OVERFLOW_RESOURCE_VERSION,
            type: 'resource',
            backupId,
            resourceId,
            mode,
            segmentIndex,
            isLast,
            expectedChars,
            data
        })
    ], { type: 'application/json' });
}

function prepareOverflowValue(value, candidateAssets, createResourceId, resources, maxInlineBytes, maxValueBytes) {
    const assetRefs = new Map();
    for (const assetKey of Object.keys(candidateAssets || {})) {
        const resourceId = createResourceId('asset');
        assetRefs.set(`asset_ref:${assetKey}`, resourceId);
        resources.push({
            resourceId,
            mode: 'string',
            value: candidateAssets[assetKey],
            expectedChars: String(candidateAssets[assetKey] ?? '').length
        });
    }

    const addStringResource = stringValue => {
        const resourceId = createResourceId('value');
        resources.push({
            resourceId,
            mode: 'string',
            value: stringValue,
            expectedChars: stringValue.length
        });
        return { [OVERFLOW_RESOURCE_REF_KEY]: resourceId };
    };

    const visit = current => {
        if (typeof current === 'string') {
            const assetResourceId = assetRefs.get(current);
            if (assetResourceId) return { [OVERFLOW_RESOURCE_REF_KEY]: assetResourceId };
            // 只按字符数做保守判断，避免为了估算一个超大字符串再次编码整串数据。
            if (current.length >= maxInlineBytes) return addStringResource(current);
            return current;
        }
        if (Array.isArray(current)) return current.map(visit);
        if (!current || typeof current !== 'object') return current;
        const next = {};
        for (const key of Object.keys(current)) next[key] = visit(current[key]);
        return next;
    };

    const normalizedValue = visit(value);
    let serialized = '';
    try { serialized = JSON.stringify(normalizedValue); } catch { serialized = ''; }
    if (serialized && getUtf8ByteLength(serialized) > maxValueBytes) {
        const resourceId = createResourceId('json');
        resources.push({
            resourceId,
            mode: 'json',
            value: serialized,
            expectedChars: serialized.length
        });
        return { [OVERFLOW_RESOURCE_JSON_REF_KEY]: resourceId };
    }
    return normalizedValue;
}

async function shareOrDownloadBlob(blob, fileName, options = {}) {
    const nativeSaved = await saveBlobToNativeStorage(blob, fileName, options);
    if (nativeSaved) return true;

    const appleMobile = isAppleMobile();
    const file = appleMobile && typeof File === 'function'
        ? new File([blob], fileName, { type: blob.type || 'application/octet-stream' })
        : null;

    const canUseLargeFileShare = blob.size <= 16 * 1024 * 1024;
    if (appleMobile && canUseLargeFileShare && file && navigator.share && navigator.canShare?.({ files: [file] })) {
        try {
            await navigator.share({
                files: [file],
                title: fileName
            });
            return true;
        } catch (error) {
            if (error?.name === 'AbortError') return false;
            console.warn('系统分享不可用，改用浏览器下载:', error);
        }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    // The click has synchronously handed the URL to the browser download
    // manager. Revoke it promptly so successive chunks do not retain a chain
    // of large Blob objects in WKWebView memory.
    const revokeDelay = Number.isFinite(options.revokeDelay) ? options.revokeDelay : 5000;
    setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
    }, revokeDelay);
    return true;
}

export async function exportAllData(options = DEFAULT_EXPORT_OPTIONS) {
  const normalizedOptions = normalizeExportOptions(options);
  const onBlob = typeof options?.onBlob === 'function' ? options.onBlob : null;

  if (isNativeRuntime()) {
      return exportChunkData(normalizedOptions);
  }

  if (activeExportMode || activeImportMode) {
      showDynamicIsland(getDataTaskConflictMessage(), 'warning');
      return;
  }

  let blobParts = [];
  let assetPool = {};
  activeExportMode = 'full';

  try {
    showDynamicIsland('正在准备优化导出...', 'loading');
    await sleep(50);

    const header = { timestamp: new Date().toISOString(), version: '1.5-opt' };
    let compressedStorage = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!shouldExportLocalStorageKey(key, normalizedOptions)) continue;
        compressedStorage[key] = compressObject(localStorage.getItem(key), assetPool);
    }

    let compressedCSData = {};
    if (normalizedOptions.couple) {
        const csData = await getCSDBData();
        for (const key in csData) compressedCSData[key] = compressObject(csData[key], assetPool);
    }

    blobParts.push(`{"timestamp":"${header.timestamp}","version":"${header.version}","localStorageData":${JSON.stringify(compressedStorage)},"coupleSpaceData":${JSON.stringify(compressedCSData)},"tables":{`);
    compressedStorage = null;
    compressedCSData = null;

    const tableNames = db.tables
        .map(table => table.name)
        .filter(tableName => shouldExportTable(tableName, normalizedOptions));

    let isFirstTable = true;
    for (let i = 0; i < tableNames.length; i++) {
        const tableName = tableNames[i];
        const compressedTableName = KEY_MAP[tableName] || tableName;
        showDynamicIsland(`正在打包: ${tableName} (${i + 1}/${tableNames.length})`, 'loading');

        if (!isFirstTable) { blobParts.push(','); } else { isFirstTable = false; }
        blobParts.push(`"${compressedTableName}":[`);

        const table = db.table(tableName);
        const primKey = table.schema.primKey.name;
        let lastCursor = null;
        const chunkSize = 100;
        let isFirstItemInTable = true;
        while (true) {
            const collection = lastCursor === null
                ? table.orderBy(primKey).limit(chunkSize)
                : table.where(primKey).above(lastCursor).limit(chunkSize);
            let rows = await collection.toArray();
            if (rows.length === 0) break;
            for (const row of rows) {
                if (shouldSkipAppDataRow(tableName, row, normalizedOptions)) continue;
                const compressedRow = compressObject(row, assetPool);
                if (!isFirstItemInTable) blobParts.push(',');
                else isFirstItemInTable = false;
                blobParts.push(JSON.stringify(compressedRow));
            }
            lastCursor = rows[rows.length - 1][primKey];
            rows = null;
            await sleep(0);
        }
        blobParts.push(']');
    }

    showDynamicIsland('正在打包资源...', 'loading');
    await sleep(50);
    blobParts.push('},"assets":{');

    const assetKeys = Object.keys(assetPool);
    for (let i = 0; i < assetKeys.length; i++) {
        const key = assetKeys[i];
        if (i > 0) blobParts.push(',');
        blobParts.push(`"${key}":${JSON.stringify(assetPool[key])}`);
        assetPool[key] = null;
        if (i % 10 === 0) await sleep(10);
    }
    blobParts.push('}}');

    showDynamicIsland('正在生成文件...', 'success');
    await sleep(100);

    const blob = new Blob(blobParts, { type: 'application/json' });
    const fileName = `looky_backup_${new Date().toISOString().slice(0, 10)}.json`;
    blobParts = null;
    assetPool = null;

    if (onBlob) await onBlob(blob, fileName);
    if (normalizedOptions.download !== false) await shareOrDownloadBlob(blob, fileName);
    showDynamicIsland('导出完成', 'success');
    return { blob, fileName };
  } catch (error) {
    console.error('导出错误:', error);
    showDynamicIsland('导出失败', {
      variant: 'error',
      detail: error?.message || '导出过程中发生错误',
      copyText: error?.stack || error?.message || '导出失败'
    });
    alert('导出失败。如果数据量过大，请尝试删除部分图片或在电脑端操作。');
  } finally {
    blobParts = null;
    assetPool = null;
    activeExportMode = null;
  }
}

// ===================================================================
// == 4. 导入逻辑 (最终修复版：解决 PrematureCommitError) ==
// ===================================================================

export async function importAllData(file) {
  if (activeExportMode || activeImportMode) {
      showDynamicIsland(getDataTaskConflictMessage(), 'warning');
      return false;
  }
  if (!file) return false;

  if (file.size > 100 * 1024 * 1024) {
      if(!confirm("文件较大 (>100MB)。手机内存可能不足导致闪退。\n建议使用电脑端导入。\n是否仍要继续？")) return false;
  }

  activeImportMode = 'full';
  return new Promise(resolve => {
  showDynamicIsland('正在读取备份文件...', { loading: true });
  const reader = new FileReader();
  
  reader.onerror = () => {
    showDynamicIsland('读取失败', {
      variant: 'error',
      detail: '备份文件读取失败，请检查文件是否损坏或权限是否正常',
      copyText: '读取失败：备份文件读取失败，请检查文件是否损坏或权限是否正常'
    });
    activeImportMode = null;
    resolve(false);
  };

  reader.onload = async (e) => {
    let importData = null; 
    let jsonContent = null; 

    try {
      showDynamicIsland('正在解析文件...', { loading: true });
      await sleep(0);

      jsonContent = e.target.result;
      const rootEntries = scanTopLevelObjectEntries(jsonContent);
      const rootRanges = new Map(rootEntries.map(entry => [entry.key, entry]));
      const tablesRange = rootRanges.get('tables');
      if (!tablesRange) {
          throw new Error('不是有效的 LOOKY 完整备份文件');
      }
      const version = parseJsonRange(jsonContent, rootRanges.get('version'));
      const isCompressed = typeof version === 'string'
          && (version.includes('compressed') || version.includes('optimized') || version.includes('opt'));
      const assetPool = isCompressed
          ? (parseJsonRange(jsonContent, rootRanges.get('assets')) || {})
          : {};
      const localStorageData = parseJsonRange(jsonContent, rootRanges.get('localStorageData'));
      const coupleSpaceData = parseJsonRange(jsonContent, rootRanges.get('coupleSpaceData'));
      const tableEntries = scanTopLevelObjectEntries(jsonContent, tablesRange.start, tablesRange.end);
      rootEntries.length = 0;
      rootRanges.clear();

      showDynamicIsland('正在恢复系统配置...', { loading: true });
      await sleep(0);
      // 【核心修复】恢复被遗漏的 localStorage 数据（音乐、外卖、情侣空间等）
      if (localStorageData) {
          // 极度安全措施1：先清理旧垃圾腾出5MB空间，避免旧数据+新数据导致瞬间爆满
          clearImportLocalStorage();
          // 极度安全措施2：逐个恢复并加上防崩溃保护伞
          for (const key in localStorageData) {
              if (LOOKY_AUTH_STORAGE_KEYS.has(key)) continue;
              const valToStore = localStorageData[key];
              const decompressedVal = isCompressed ? decompressObject(valToStore, assetPool) : valToStore;
              try {
                  localStorage.setItem(key, decompressedVal);
              } catch (err) {
                  console.warn(`跳过过大的配置项: ${key}`);
              }
          }
      }

      if (coupleSpaceData) {

          const csDataToStore = {};
          for (const key in coupleSpaceData) {
              csDataToStore[key] = isCompressed ? decompressObject(coupleSpaceData[key], assetPool) : coupleSpaceData[key];
          }
          await putCSDBData(csDataToStore);
      }

      showDynamicIsland('正在写入数据库...', { loading: true });
      await sleep(0);

      // 【修复核心】：移除外层 db.transaction
      // 我们改用逐个表、逐批次直接写入，避免事务因解压耗时而自动关闭
      for (const { key: compressedTableName, start, end } of tableEntries) {
          const tableName = REVERSE_KEY_MAP[compressedTableName] || compressedTableName;
          
          // 确保是有效的表
          if (db[tableName]) {
              const rows = JSON.parse(jsonContent.slice(start, end));
              
              // 1. 清空旧数据 (这是一个独立的事务操作)
              await db.table(tableName).clear();
              
               if (rows && rows.length > 0) {
                  showDynamicIsland(`恢复中: ${tableName}`, 'loading');
                  await writeImportedRowsSafely(tableName, rows, assetPool, isCompressed);

              }

          }
      }

      importData = null;
      jsonContent = null;

      showDynamicIsland('导入成功，即将刷新', 'success');
      resolve(true);
      await sleep(1500);
      window.location.reload();

    } catch (error) {
      console.error('导入错误:', error);
      importData = null;
      jsonContent = null;

      if (error.name === 'PrematureCommitError') {
          showDynamicIsland('写入数据库超时', {
              variant: 'error',
              detail: '请重启浏览器后重试，或使用较小的备份文件',
              copyText: error?.stack || error?.message || 'PrematureCommitError'
          });
          alert('写入数据库超时。请尝试重启浏览器后重试，或使用较小的备份文件。');
      } else if (error.toString().includes('SyntaxError') || error.toString().includes('JSON')) {
          showDynamicIsland('导入失败', {
              variant: 'error',
              detail: '文件可能已损坏，或者浏览器内存不足，建议在电脑端再试一次',
              copyText: error?.stack || error?.message || String(error)
          });
          alert('导入失败：内存不足。\n无法解析此文件，请使用电脑端操作。');
      } else {
          showDynamicIsland('导入失败', {
              variant: 'error',
              detail: error?.message || '导入过程中发生错误',
              copyText: error?.stack || error?.message || '导入失败'
          });
      }
      resolve(false);
    } finally {
      activeImportMode = null;
    }
  };
  
  reader.readAsText(file);
  });
}
// js/features/data-manager.js

// ... (上面是 importAllData 函数的结束) ...

// ===================================================================
// == 5. 数据存储统计视图逻辑 (修正版：计算真实导出体积) ==
// ===================================================================

/**
 * 格式化字节大小
 */
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * 核心函数：刷新数据统计并更新 UI
 * 【V2.0 修复版】计算真实的、经过资源去重后的导出体积
 */
export async function refreshDataStats() {
    const totalDisplay = document.getElementById('storage-total-display');
    const segChat = document.getElementById('bar-seg-chat');
    const segMedia = document.getElementById('bar-seg-media');
    const segWorld = document.getElementById('bar-seg-world');
    const segOther = document.getElementById('bar-seg-other');
    const btn = document.getElementById('refresh-storage-btn');
    
    if (!totalDisplay) return;

    // --- UI 状态 ---
    totalDisplay.style.opacity = '0.5';
    totalDisplay.textContent = 'Calculating...'; // 重置显示
    if(btn) btn.classList.add('rotating'); 

    // 初始化大小和资源池
    let sizes = { chat: 0, media: 0, world: 0, other: 0 };
    const seenAssetHashes = new Set(); // [核心] 用于模拟资源池，存储已见过的图片哈希

    try {
        const tables = db.tables;
        for (const table of tables) {
            const tableName = table.name;
            let tableItemsSize = 0; // 存储表中所有 "非图片" 部分的大小
            // 改用 each 游标流式读取，避免一次性加载全表导致苹果浏览器崩溃
            await table.each(item => {
                // 【核心修复】苹果设备禁用 JSON.stringify 遍历全表对象，改为手动轻量级估算
                let itemTextSize = 0;
                let itemMediaSize = 0;

                // 简单的浅层遍历估算，防止爆内存
                for (const key in item) {
                    const value = item[key];
                    if (typeof value === 'string') {
                        if (value.length > 50 && value.startsWith('data:image/')) {
                            const hash = fastHash(value);
                            if (!seenAssetHashes.has(hash)) {
                                seenAssetHashes.add(hash);
                                itemMediaSize += value.length;
                            }
                            itemTextSize += 30; // 'asset_ref:...' 的长度估算
                        } else {
                            itemTextSize += value.length * 2; // 中文双字节
                        }
                    } else if (typeof value === 'number') {
                        itemTextSize += 8;
                    }
                }
                
                tableItemsSize += itemTextSize;
                sizes.media += itemMediaSize;

            }); // 结束 each 遍历


            // 根据表名分类累加
            if (tableItemsSize === 0) continue; // 模拟空表跳过
            if (['chatMessages', 'chats', 'history', 'messages', 'chat_messages'].some(k => tableName.includes(k))) {

                sizes.chat += tableItemsSize;
            } else if (['worldBooks', 'entries', 'world_books', 'worldBookEntries'].some(k => tableName.includes(k))) {
                sizes.world += tableItemsSize;
            } else if (['userStickers', 'galleryImages'].some(k => tableName.includes(k))) {
                // 表情包和相册本身也属于媒体资源的一部分
                sizes.media += tableItemsSize;
            }
            else {
                sizes.other += tableItemsSize;
            }
        }

        // 汇总总大小
        const totalSize = sizes.chat + sizes.media + sizes.world + sizes.other;
        const safeTotal = totalSize || 1; 

        // --- 更新 UI ---
        setTimeout(() => {
            totalDisplay.textContent = formatBytes(totalSize);
            totalDisplay.style.opacity = '1';

            // 更新进度条
            if(segChat) segChat.style.width = `${(sizes.chat / safeTotal) * 100}%`;
            if(segMedia) segMedia.style.width = `${(sizes.media / safeTotal) * 100}%`;
            if(segWorld) segWorld.style.width = `${(sizes.world / safeTotal) * 100}%`;
            if(segOther) segOther.style.width = `${(sizes.other / safeTotal) * 100}%`;

            // 更新图例数值
            const elSizeChat = document.getElementById('legend-size-chat');
            const elSizeMedia = document.getElementById('legend-size-media');
            const elSizeWorld = document.getElementById('legend-size-world');
            const elSizeOther = document.getElementById('legend-size-other');

            if(elSizeChat) elSizeChat.textContent = formatBytes(sizes.chat);
            if(elSizeMedia) elSizeMedia.textContent = formatBytes(sizes.media);
            if(elSizeWorld) elSizeWorld.textContent = formatBytes(sizes.world);
            if(elSizeOther) elSizeOther.textContent = formatBytes(sizes.other);

            if(btn) btn.classList.remove('rotating');
        }, 300);

    } catch (e) {
        console.error("Storage calculation failed:", e);
        totalDisplay.textContent = "Error";
        if(btn) btn.classList.remove('rotating');
    }
}


// 绑定按钮事件
document.addEventListener('click', (e) => {
    const btn = e.target.closest('#refresh-storage-btn');
    if (btn) {
        // 让图标转一圈
        const svg = btn.querySelector('svg');
        if(svg) {
            svg.style.transition = 'transform 0.6s ease';
            svg.style.transform = 'rotate(360deg)';
            setTimeout(() => svg.style.transform = 'none', 600);
        }
        refreshDataStats();
    }
});

// ===================================================================
// == 6. 空间优化功能 (Space Optimizer) ==
// ===================================================================

/**
 * 功能1：清理孤儿数据 (Orphaned Data)
 * 逻辑：chatMessages 中的 chat_id 在 chats 表中不存在，即为残留。
 */
export async function cleanOrphanedData() {
    const btn = document.getElementById('btn-clean-orphans');
    if(btn) {
        btn.textContent = '扫描中...';
        btn.classList.add('processing');
    }
    try {
        showDynamicIsland('正在扫描残留数据...', 'loading');
        await sleep(200);
        // 【修复】1. 使用正确的表名 'characterProfiles'，并用更安全的方式访问
        const chatsTable = db.table('characterProfiles');
        const messagesTable = db.table('chatMessages');
        const allChats = await chatsTable.toArray();
         const validChatIds = new Set(allChats.map(c => c.id));
         // 2. 扫描消息表，使用游标遍历代替一次性读取全表，防止闪退
        const orphanIds = [];
        await messagesTable.each(msg => {
            // 如果某条消息的 chatId 存在，但不在有效角色ID列表中
            if (msg.chatId && !validChatIds.has(msg.chatId)) {
                orphanIds.push(msg.id);
            }
        });


        if (orphanIds.length === 0) {
            showDynamicIsland('未发现残留数据', 'success');
            if(btn) btn.textContent = '已清理';
        } else {
            // 提示确认
            if(confirm(`发现 ${orphanIds.length} 条无效残留记录。\n这些是已删除角色的遗留对话。\n是否立即清除？`)) {
                showDynamicIsland(`正在清理 ${orphanIds.length} 条记录...`, 'loading');
                await messagesTable.bulkDelete(orphanIds);
                
                // 刷新统计
                await refreshDataStats();
                showDynamicIsland('清理完成', 'success');
                if(btn) btn.textContent = '完成';
            } else {
                showDynamicIsland('已取消', 'success');
                if(btn) btn.textContent = '扫描';
            }
        }
    } catch (e) {
        console.error('Cleaning failed:', e);
        showDynamicIsland('清理出错', {
            variant: 'error',
            detail: e?.message || '数据清理过程中发生错误',
            copyText: e?.stack || e?.message || '清理出错'
        });
        if(btn) btn.textContent = '重试';
    } finally {
        if(btn) btn.classList.remove('processing');
    }
}

/**
 * 辅助：压缩 Base64 图片
 * 目标格式：WebP, 质量 0.8, 最大边长 1280px
 */
function compressImage(base64Str) {
    return compressImageDataUrl(base64Str, { maxDimension: 1280, quality: 0.8 });
}

function compressStickerImage(base64Str) {
    return new Promise((resolve) => {
        const img = new Image();
        img.src = base64Str;
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;
            const maxDim = 420;

            if (width > maxDim || height > maxDim) {
                if (width > height) {
                    height = Math.round(height * maxDim / width);
                    width = maxDim;
                } else {
                    width = Math.round(width * maxDim / height);
                    height = maxDim;
                }
            }

            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            const newBase64 = canvas.toDataURL('image/webp', 0.78);
            canvas.width = 0;
            canvas.height = 0;
            img.src = '';

            resolve(newBase64.length < base64Str.length ? newBase64 : base64Str);
        };
        img.onerror = () => resolve(base64Str);
    });
}

/**
 * 功能2：相册瘦身 (Album Slimming) - 【手机端防崩溃加强版】
 * 逻辑：分批次扫描数据库，精准压缩 stickerUrl 和 avatarSrc 字段
 */
export async function compressOldImages() {
    const btn = document.getElementById('btn-compress-images');
    if(btn) {
        btn.textContent = '准备中...';
        btn.classList.add('processing');
    }

    try {
        // 1. 获取总数（用于显示进度）
        const totalCount = await db.chatMessages.count();
        if (totalCount === 0) {
            showDynamicIsland('没有消息需要处理', 'success');
            if(btn) { btn.textContent = '完成'; btn.classList.remove('processing'); }
            return;
        }

        const confirmMsg = `扫描到数据库共有 ${totalCount} 条消息。\n\n即将在手机端执行“深度瘦身”：\n1. 压缩所有巨大的表情包 (stickerUrl)\n2. 压缩巨大的头像 (avatarSrc)\n\n过程可能需要几分钟，请保持页面开启。`;
        
        if(!confirm(confirmMsg)) {
            if(btn) { btn.textContent = '优化'; btn.classList.remove('processing'); }
            return;
        }
        showDynamicIsland('开始深度瘦身...', 'loading');
        
        // 2. 分批处理配置
        const BATCH_SIZE = 20; // 【苹果防爆优化】改为20条，进一步降低瞬间内存压力，防止锁死
        let processedCount = 0;

        let optimizedCount = 0;
        let savedSpace = 0;
        let offset = 0;

        // 3. 循环批次处理
        let lastCursor = null; // 新增：用于记录上次的最后一条主键
        while (true) {
            // 改用主键范围读取，解决苹果浏览器中 offset 深分页导致的底层崩溃
            let collection = lastCursor === null 
                ? db.chatMessages.orderBy('id').limit(BATCH_SIZE)
                : db.chatMessages.where('id').above(lastCursor).limit(BATCH_SIZE);
            const messages = await collection.toArray();
            
            if (messages.length === 0) break; // 处理完了

            // 遍历这一批消息

            for (const msg of messages) {
                let needsUpdate = false;
                let originalSize = 0;
                let newSize = 0;

                // [检查点 A] 检查 stickerUrl (这是你数据库膨胀的元凶)
                if (msg.stickerUrl && typeof msg.stickerUrl === 'string' && msg.stickerUrl.length > 100000) { // >100KB
                    originalSize += msg.stickerUrl.length;
                    const compressed = await compressImage(msg.stickerUrl);
                    if (compressed.length < msg.stickerUrl.length) {
                        msg.stickerUrl = compressed;
                        newSize += compressed.length;
                        needsUpdate = true;
                    } else {
                        newSize += msg.stickerUrl.length;
                    }
                  }

                // [检查点 B] 强力清剿历史冗余头像 (无需耗时压缩，直接斩草除根释放空间)
                if (msg.avatarSrc) {
                    originalSize += (typeof msg.avatarSrc === 'string' ? msg.avatarSrc.length : 0);
                    delete msg.avatarSrc; // 彻底剥离历史消息中的无效头像赘肉
                    newSize += 0;
                    needsUpdate = true;
                }

                // [检查点 C] 检查 content (针对旧的 [拍摄] 功能)

                if (msg.content && typeof msg.content === 'string' && msg.content.startsWith('data:image/') && msg.content.length > 500000) {
                     originalSize += msg.content.length;
                     const compressed = await compressImage(msg.content);
                     if (compressed.length < msg.content.length) {
                         msg.content = compressed;
                         newSize += compressed.length;
                         needsUpdate = true;
                     } else {
                         newSize += msg.content.length;
                     }
                }

                // 如果有优化，立即写入数据库
                if (needsUpdate) {
                    // ★★★ 关键修复 ★★★
                    // 使用 db.chatMessages.update 开启一个全新的短事务
                    // 这样就不会因为 await compressImage 时间太长导致“事务已关闭”的错误
                    await db.chatMessages.update(msg.id, msg);
                    savedSpace += (originalSize - newSize);
                    optimizedCount++;
                              }
            }

            processedCount += messages.length;
            lastCursor = messages[messages.length - 1].id; // 记录最后一条主键，代替危险的 offset

            // 更新按钮上的进度
            if(btn) btn.textContent = `进度 ${(processedCount / totalCount * 100).toFixed(0)}%`;

            // 每处理 200 条给个轻微的延迟，让手机UI喘口气，防止卡死
            if (processedCount % 200 === 0) await new Promise(r => setTimeout(r, 50));
        }

        // 4. 结束
        const savedMB = (savedSpace / (1024 * 1024)).toFixed(2);
        const resultMsg = `优化完成！\n\n共处理巨型图片: ${optimizedCount} 张\n腾出空间: ${savedMB} MB\n\n请刷新页面以释放内存。`;
        
        showDynamicIsland(`瘦身成功: -${savedMB} MB`, 'success');
        alert(resultMsg);
        
        await refreshDataStats(); // 刷新统计视图
        
        if(btn) btn.textContent = '完成';

    } catch (e) {
        console.error('Compression failed:', e);
        showDynamicIsland('优化中断', {
            variant: 'error',
            detail: e?.message || '数据优化过程中发生错误',
            copyText: e?.stack || e?.message || '优化中断'
        });
        alert('出错: ' + e.message);
        if(btn) btn.textContent = '重试';
    } finally {
        if(btn) btn.classList.remove('processing');
    }
}

/**
 * 【新增】功能3：压缩核心资源（头像、壁纸）
 * 逻辑：扫描所有用户身份、角色、联系人的头像，以及全局壁纸，对大体积图片进行压缩。
 */
export async function compressAssetImages() {
    const btn = document.getElementById('btn-compress-assets');
    if(!btn) return;

    btn.textContent = '分析中...';
    btn.classList.add('processing');
    
    try {
        showDynamicIsland('正在分析资源文件...', 'loading');
        await sleep(100);

        const targets = [];
        const LARGE_IMAGE_THRESHOLD = 680000; // ~500KB

        // 1. 扫描用户身份和联系人头像
        for (const identity of AppState.userIdentities) {
            if (isBase64Image(identity.avatar) && identity.avatar.length > LARGE_IMAGE_THRESHOLD) {
                targets.push({ type: 'identity', id: identity.id, originalLength: identity.avatar.length });
            }
            if (identity.socialCircle) {
                for (const contact of identity.socialCircle) {
                    if (isBase64Image(contact.avatar) && contact.avatar.length > LARGE_IMAGE_THRESHOLD) {
                        targets.push({ type: 'contact', identityId: identity.id, contactId: contact.id, originalLength: contact.avatar.length });
                    }
                }
            }
        }
        // 2. 扫描角色头像和聊天背景
        // 改用 each 流式读取，防止角色过多引起手机内存崩溃
        await db.characterProfiles.each(char => {
            if (isBase64Image(char.avatar) && char.avatar.length > LARGE_IMAGE_THRESHOLD) {
                targets.push({ type: 'character', id: char.id, field: 'avatar', originalLength: char.avatar.length });
            }
            if (isBase64Image(char.chatBackground) && char.chatBackground.length > LARGE_IMAGE_THRESHOLD) {
                targets.push({ type: 'character', id: char.id, field: 'chatBackground', originalLength: char.chatBackground.length });
            }
        });

        // 3. 扫描全局壁纸

        const wallpaperKeys = ['homeWallpaper', 'systemUiBackground', 'appContentBackground'];
        for (const key of wallpaperKeys) {
            const item = await db.appData.get(key);
            if (item && item.value && isBase64Image(item.value) && item.value.length > LARGE_IMAGE_THRESHOLD) {
                targets.push({ type: 'wallpaper', key: key, originalLength: item.value.length });
            }
        }

        if (targets.length === 0) {
            showDynamicIsland('未发现可优化的资源', 'success');
            alert('所有头像和壁纸都已是最佳状态，无需优化。');
            btn.textContent = '已优化';
            return;
        }

        if (!confirm(`分析完成：\n发现 ${targets.length} 张大体积图片资源可以被压缩。\n\n这会优化所有用户身份、角色、联系人的头像以及各类壁纸，过程不可逆。\n\n是否开始优化？`)) {
            btn.textContent = '优化';
            btn.classList.remove('processing');
            return;
        }

        showDynamicIsland('开始优化...', 'loading');
        btn.textContent = '处理中...';

        let savedSpace = 0;
        let identitiesChanged = false;

        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            showDynamicIsland(`优化中: ${i + 1}/${targets.length}`, 'loading');

            let originalBase64 = '';
            // 获取原始数据
            switch(target.type) {
                case 'identity':
                    originalBase64 = AppState.userIdentities.find(id => id.id === target.id)?.avatar;
                    break;
                case 'contact':
                    originalBase64 = AppState.userIdentities.find(id => id.id === target.identityId)?.socialCircle.find(c => c.id === target.contactId)?.avatar;
                    break;
                case 'character':
                    const char = await db.characterProfiles.get(target.id);
                    originalBase64 = char ? char[target.field] : '';
                    break;
                case 'wallpaper':
                    const item = await db.appData.get(target.key);
                    originalBase64 = item ? item.value : '';
                    break;
            }

            if (!originalBase64) continue;

            const newBase64 = await compressImage(originalBase64);

            if (newBase64.length < originalBase64.length) {
                savedSpace += (originalBase64.length - newBase64.length);
                // 更新数据
                switch(target.type) {
                    case 'identity':
                        AppState.userIdentities.find(id => id.id === target.id).avatar = newBase64;
                        identitiesChanged = true;
                        break;
                    case 'contact':
                        AppState.userIdentities.find(id => id.id === target.identityId).socialCircle.find(c => c.id === target.contactId).avatar = newBase64;
                        identitiesChanged = true;
                        break;
                    case 'character':
                        await db.characterProfiles.update(target.id, { [target.field]: newBase64 });
                        // 同步更新内存中的 AppState
                        const charInState = AppState.characterProfiles.find(c => c.id === target.id);
                        if(charInState) charInState[target.field] = newBase64;
                        break;
                    case 'wallpaper':
                        await db.appData.put({ key: target.key, value: newBase64 });
                        break;
                }
            }
        }
        
        if (identitiesChanged) {
            await db.appData.put({ key: 'userIdentities', value: AppState.userIdentities });
        }

        const savedMB = (savedSpace / (1024 * 1024)).toFixed(1);
        showDynamicIsland(`优化完成，释放了 ${savedMB} MB`, 'success');
        await refreshDataStats();
        btn.textContent = '完成';

    } catch (e) {
        console.error('资源压缩失败:', e);
        showDynamicIsland('优化中断', {
            variant: 'error',
            detail: e?.message || '资源压缩过程中发生错误',
            copyText: e?.stack || e?.message || '优化中断'
        });
        btn.textContent = '重试';
    } finally {
        btn.classList.remove('processing');
    }
}

export async function clearBrowserRuntimeCache() {
    const btn = document.getElementById('btn-clear-runtime-cache');
    if (btn) {
        btn.textContent = '扫描...';
        btn.classList.add('processing');
    }

    try {
        if (!('caches' in window)) {
            showDynamicIsland('当前浏览器不支持缓存清理', {
                variant: 'error',
                detail: '这个浏览器没有提供缓存清理接口',
                copyText: '当前浏览器不支持缓存清理'
            });
            if (btn) btn.textContent = '不支持';
            return;
        }

        const cacheNames = await caches.keys();
        if (cacheNames.length === 0) {
            showDynamicIsland('没有可清理的浏览器缓存', 'success');
            if (btn) btn.textContent = '已清理';
            return;
        }

        const confirmMsg = `发现 ${cacheNames.length} 组浏览器缓存。\n\n这只会清理网页运行缓存，不会删除聊天、角色、图片和设置。\n清理后下次打开可能会重新下载页面文件。\n\n是否现在清理？`;
        if (!confirm(confirmMsg)) {
            if (btn) btn.textContent = '清理';
            return;
        }

        showDynamicIsland('正在清理浏览器缓存...', 'loading');
        await Promise.all(cacheNames.map(name => caches.delete(name)));
        showDynamicIsland('浏览器缓存已清理', 'success');
        if (btn) btn.textContent = '完成';

        if (confirm('浏览器缓存已清理。\n\n要现在刷新一次页面，让 Safari 尽快重新计算占用吗？')) {
            window.location.reload();
        }
    } catch (e) {
        console.error('Runtime cache cleanup failed:', e);
        showDynamicIsland('缓存清理失败', {
            variant: 'error',
            detail: e?.message || '缓存清理过程中发生错误',
            copyText: e?.stack || e?.message || '缓存清理失败'
        });
        if (btn) btn.textContent = '重试';
    } finally {
        if (btn) btn.classList.remove('processing');
    }
}

export async function clearTtsAudioCache() {
    const btn = document.getElementById('btn-clear-tts-cache');
    if (btn) {
        btn.textContent = '扫描...';
        btn.classList.add('processing');
    }

    try {
        const count = await db.ttsCache.count();
        if (count === 0) {
            showDynamicIsland('没有可清理的语音缓存', 'success');
            if (btn) btn.textContent = '已清理';
            return;
        }

        const confirmMsg = `发现 ${count} 条语音缓存。\n\n这只会删除已生成的朗读音频，不会删除聊天文字、角色、图片和设置。\n以后需要朗读同一句话时，会重新生成语音。\n\n是否现在清理？`;
        if (!confirm(confirmMsg)) {
            if (btn) btn.textContent = '清理';
            return;
        }

        showDynamicIsland('正在清理语音缓存...', 'loading');
        await db.ttsCache.clear();
        await refreshDataStats();
        showDynamicIsland('语音缓存已清理', 'success');
        if (btn) btn.textContent = '完成';
    } catch (e) {
        console.error('TTS cache cleanup failed:', e);
        showDynamicIsland('语音缓存清理失败', {
            variant: 'error',
            detail: e?.message || '语音缓存清理过程中发生错误',
            copyText: e?.stack || e?.message || '语音缓存清理失败'
        });
        if (btn) btn.textContent = '重试';
    } finally {
        if (btn) btn.classList.remove('processing');
    }
}

export async function compressStickerLibrary() {
    const btn = document.getElementById('btn-compress-sticker-library');
    if (btn) {
        btn.textContent = '分析中...';
        btn.classList.add('processing');
    }

    try {
        const groups = await db.stickerGroups.toArray();
        const targets = [];
        const LARGE_STICKER_THRESHOLD = 180000;

        groups.forEach(group => {
            (group.stickers || []).forEach((sticker, index) => {
                if (isBase64Image(sticker?.url) && sticker.url.length > LARGE_STICKER_THRESHOLD) {
                    targets.push({ groupId: group.id, index, originalLength: sticker.url.length });
                }
            });
        });

        if (targets.length === 0) {
            showDynamicIsland('没有发现过大的本地表情', 'success');
            if (btn) btn.textContent = '已优化';
            return;
        }

        const confirmMsg = `发现 ${targets.length} 张本地表情可以瘦身。\n\n只会压缩表情图片本身，不会删除表情、分组和说明文字。\n外链 URL 表情不会处理。\n\n是否开始？`;
        if (!confirm(confirmMsg)) {
            if (btn) btn.textContent = '优化';
            return;
        }

        let processedCount = 0;
        let optimizedCount = 0;
        let savedSpace = 0;
        const changedGroupIds = new Set();

        for (const target of targets) {
            const group = groups.find(item => item.id === target.groupId);
            const sticker = group?.stickers?.[target.index];
            if (!sticker?.url) continue;

            const compressed = await compressStickerImage(sticker.url);
            processedCount++;

            if (compressed.length < sticker.url.length) {
                savedSpace += sticker.url.length - compressed.length;
                sticker.url = compressed;
                optimizedCount++;
                changedGroupIds.add(group.id);
            }

            if (btn) btn.textContent = `进度 ${(processedCount / targets.length * 100).toFixed(0)}%`;
            if (processedCount % 10 === 0) await sleep(50);
        }

        const changedGroups = groups.filter(group => changedGroupIds.has(group.id));
        if (changedGroups.length > 0) {
            await db.stickerGroups.bulkPut(changedGroups);
            AppState.stickerGroups = groups;
        }

        const savedMB = (savedSpace / (1024 * 1024)).toFixed(2);
        await refreshDataStats();
        showDynamicIsland(`表情包瘦身完成: -${savedMB} MB`, 'success');
        alert(`优化完成！\n\n共处理表情: ${optimizedCount} 张\n腾出空间: ${savedMB} MB`);
        if (btn) btn.textContent = '完成';
    } catch (e) {
        console.error('Sticker library compression failed:', e);
        showDynamicIsland('表情包优化失败', {
            variant: 'error',
            detail: e?.message || '表情包压缩过程中发生错误',
            copyText: e?.stack || e?.message || '表情包优化失败'
        });
        if (btn) btn.textContent = '重试';
    } finally {
        if (btn) btn.classList.remove('processing');
    }
}
// ===================================================================
// == 7. 【新增】清空所有数据功能 ==
// ===================================================================
export async function clearAllData() {
    // 第一次确认
    if (!confirm("【极度危险】\n此操作将彻底删除此设备上的所有数据，包括所有聊天、身份、设置和图片。\n\n这是一个不可逆的操作，请确保您已有备份。\n\n确定要清空所有数据吗？")) {
        showDynamicIsland('操作已取消', 'success');
        return;
    }
    // 第二次确认，加强防护
    if (!confirm("最后一次确认：真的要删除所有数据吗？此操作无法撤销！")) {
        showDynamicIsland('操作已取消', 'success');
        return;
    }

    try {
        showDynamicIsland('正在清空所有数据...', 'loading');
        // 等待1.5秒，给用户一个反应时间
        await sleep(1500);
        // 核心：删除整个数据库
        await db.delete();
        indexedDB.deleteDatabase('CoupleSpaceData');
        indexedDB.deleteDatabase('LookyMusicDB');
        
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const key = localStorage.key(i);
            if (!LOOKY_AUTH_STORAGE_KEYS.has(key)) {
                localStorage.removeItem(key);
            }
        }

        showDynamicIsland('数据已清空，应用即将刷新', 'success');
        await sleep(1500);
        // 重新加载页面，回到最初始状态
        window.location.reload();

    } catch (error) {
        console.error('清空数据失败:', error);
        showDynamicIsland('清空失败', {
            variant: 'error',
            detail: error?.message || '清空数据过程中发生错误',
            copyText: error?.stack || error?.message || '清空失败'
        });
        alert('清空数据时发生错误，请尝试手动清理浏览器站点数据后重试。');
    }
}

// 绑定事件监听
document.addEventListener('click', (e) => {
    // 绑定清理残留按钮
    if (e.target.closest('#btn-clean-orphans')) {
        cleanOrphanedData();
    }
    // 绑定图片压缩按钮
    if (e.target.closest('#btn-compress-images')) {
        compressOldImages();
    }
    // 【新增】绑定资源压缩按钮
    if (e.target.closest('#btn-compress-assets')) {
        compressAssetImages();
    }
    if (e.target.closest('#btn-clear-runtime-cache')) {
        clearBrowserRuntimeCache();
    }
    if (e.target.closest('#btn-clear-tts-cache')) {
        clearTtsAudioCache();
    }
    if (e.target.closest('#btn-compress-sticker-library')) {
        compressStickerLibrary();
    }
     if (e.target.closest('#clear-all-data-btn')) {
        clearAllData();
    }
});
// ===================================================================
// == 8. 【新增】低内存分块导出/导入 (防过载错峰版) ==
// ===================================================================

/**
 * 核心优化：异步安全弹窗 + 强制错峰休息。
 * 在用户点击保存后，强制留出充足时间让 Safari 写入文件并回收内存，避免并发导致数据库断连。
 */
function promptAndDownload(blob, fileName, title, desc) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(5px);';
        
        const card = document.createElement('div');
        card.style.cssText = 'background:#fff;border-radius:24px;padding:24px;width:80%;max-width:300px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.2);';
        
        card.innerHTML = `
            <div style="width:48px;height:48px;border-radius:50%;background:#f0f2f5;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#333" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            </div>
            <h3 style="margin:0 0 10px;font-size:18px;color:#111;font-weight:700;">${title}</h3>
            <p style="font-size:13px;color:#888;margin:0 0 20px;line-height:1.5;">${desc}</p>
            <button id="chunk-dl-btn" style="background:#000;color:#fff;border:none;padding:14px;width:100%;border-radius:14px;font-size:15px;font-weight:600;cursor:pointer;">允许下载并继续</button>
        `;
        
        overlay.appendChild(card);
        document.body.appendChild(overlay);

        const btn = card.querySelector('#chunk-dl-btn');
        
        btn.onclick = async () => {
            // 防止用户连续点击导致多重任务
            btn.disabled = true;
            btn.style.opacity = '0.5';
            btn.innerText = '正在存入手机...';

            let saved = false;
            try {
                saved = await shareOrDownloadBlob(blob, fileName, { revokeDelay: 1000 });
            } finally {
                btn.innerText = '系统恢复中...';
                overlay.remove();
                // 给 Safari 留出时间完成文件写入，再开始下一轮数据库读取。
                setTimeout(() => resolve(saved), 1200);
            }
        };
    });
}

export async function exportChunkData(options = DEFAULT_EXPORT_OPTIONS) {
    if (activeExportMode || activeImportMode) {
        showDynamicIsland(getDataTaskConflictMessage(), 'warning');
        return;
    }

    const normalizedOptions = normalizeExportOptions(options);
    const onChunk = typeof options?.onChunk === 'function' ? options.onChunk : null;
    const skipConfirm = options?.skipConfirm === true;
    activeExportMode = 'chunk';
    let nativeArchiveSupported = false;
    let nativeExportSessionId = null;

    try {
        nativeArchiveSupported = !onChunk && isNativeRuntime() && await isNativeBackupSupported();
        // APK 原生插件会把每个 JSON 分块拆成小片传输；这里保留 4MB 分块，
        // 减少 ZIP 条目数量，同时避免在前端累积过大的单个分块。
        const TARGET_CHUNK_BYTES = Number.isFinite(options?.targetChunkBytes)
            ? options.targetChunkBytes
            : (isNativeRuntime()
            ? 4 * 1024 * 1024
            : 24 * 1024 * 1024);
        const tableNames = db.tables
            .map(table => table.name)
            .filter(tableName => shouldExportTable(tableName, normalizedOptions));

        const exportPrompt = nativeArchiveSupported
            ? 'APK 将在内部低内存分块处理，最后只生成一个 ZIP 备份文件。是否开始导出？'
            : `导出将按${isNativeRuntime() ? '约 4MB' : '约 24MB'}自动分成多个 JSON 文件。每个文件保存后请在系统弹窗中确认，整个过程不会生成 ZIP。`;
        if (!skipConfirm && !confirm(exportPrompt)) {
            showDynamicIsland('已取消导出', 'success');
            return;
        }

        const timestampId = new Date().getTime().toString();
        const dateStr = new Date().toISOString().slice(0, 10);
        if (nativeArchiveSupported) {
            const nativeSession = await beginNativeBackupExport(`LOOKY_backup_${dateStr}_${timestampId}.zip`);
            nativeExportSessionId = nativeSession?.sessionId || null;
            if (!nativeExportSessionId) throw new Error('无法创建 Android 备份会话');
        }
        let partIndex = 1;
        const CHUNK_SIZE_SAFETY_MARGIN = 256 * 1024;
        const MAX_ESTIMATED_CHUNK_BYTES = Math.max(1, TARGET_CHUNK_BYTES - CHUNK_SIZE_SAFETY_MARGIN);
        const OVERFLOW_RESOURCE_BYTES = Number.isFinite(options?.overflowResourceBytes)
            ? Math.max(512 * 1024, options.overflowResourceBytes)
            : (isNativeRuntime() ? OVERFLOW_RESOURCE_NATIVE_TARGET_BYTES : OVERFLOW_RESOURCE_TARGET_BYTES);
        const pendingOverflowResources = [];
        let overflowResourceSequence = 0;
        const createResourceId = prefix => createOverflowResourceId(prefix, overflowResourceSequence++);
        const createChunkState = (type = 'table') => ({
            type,
            tables: {},
            localStorageData: type === 'base' ? {} : undefined,
            coupleSpaceData: type === 'base' ? {} : undefined,
            assetPool: {},
            assetKeys: new Set(),
            estimatedBytes: 0,
            assetBytes: 0,
            hasData: type === 'base',
            lastSource: type === 'base' ? { type: 'base' } : null
        });
        let chunkState = createChunkState('base');

        const writeExportBlob = async (exportBlob, fileName, currentPart, kind, estimatedBytes, lastSource, promptTitle) => {
            reportExportDiagnostic(options, {
                kind,
                partNumber: currentPart,
                fileName,
                estimatedBytes,
                actualBytes: exportBlob.size,
                estimatedSize: formatExportBytes(estimatedBytes),
                actualSize: formatExportBytes(exportBlob.size),
                lastSource
            });

            let saved = false;
            if (onChunk) {
                await onChunk(exportBlob, fileName, currentPart);
                saved = true;
            } else if (nativeArchiveSupported) {
                showDynamicIsland(`正在写入备份 ${currentPart} ...`, 'loading');
                await appendNativeBackupPart(nativeExportSessionId, fileName, exportBlob);
                saved = true;
            } else {
                saved = await promptAndDownload(
                    exportBlob,
                    fileName,
                    promptTitle || `第 ${currentPart} 个文件`,
                    '文件已生成，请点击“允许下载并继续”。'
                );
            }
            if (!saved) throw new Error(`第 ${currentPart} 个分块未保存，导出已停止`);
            partIndex++;
            await sleep(onChunk || nativeArchiveSupported ? 50 : 1200);
        };

        const flushPendingOverflowResources = async () => {
            const resources = pendingOverflowResources.splice(0);
            for (const resource of resources) {
                const resourceValue = String(resource.value ?? '');
                let offset = 0;
                let segmentIndex = 0;
                while (offset < resourceValue.length) {
                    const end = getResourceSliceEnd(resourceValue, offset, OVERFLOW_RESOURCE_BYTES);
                    const data = resourceValue.slice(offset, end);
                    const isLast = end >= resourceValue.length;
                    const currentPart = partIndex;
                    const fileName = `[${timestampId}]_[part${currentPart}]_looky_backup_${dateStr}_resource.json`;
                    const resourceBlob = buildOverflowResourceBlob({
                        backupId: timestampId,
                        resourceId: resource.resourceId,
                        mode: resource.mode,
                        segmentIndex,
                        isLast,
                        expectedChars: resource.expectedChars,
                        data
                    });
                    await writeExportBlob(
                        resourceBlob,
                        fileName,
                        currentPart,
                        'resource',
                        resourceBlob.size,
                        { type: 'resource', resourceId: resource.resourceId, segmentIndex },
                        `资源片段 ${currentPart}`
                    );
                    offset = end;
                    segmentIndex++;
                }
            }
        };

        const flushChunk = async () => {
            if (!chunkState || !chunkState.hasData) return;

            const currentPart = partIndex;
            const chunkType = chunkState.type;
            const chunkFileName = `[${timestampId}]_[part${currentPart}]_looky_backup_${dateStr}_${chunkType}.json`;
            showDynamicIsland(`正在生成第 ${currentPart} 个文件...`, 'loading');
            const estimatedBytes = chunkState.estimatedBytes;
            const lastSource = chunkState.lastSource;

            // Keep the Blob only for the duration of the explicit save prompt.
            // Clearing the state before waiting prevents the next DB read from
            // retaining the previous chunk's rows/assets.
            let chunkBlob = buildChunkBlob({
                type: chunkType,
                backupId: timestampId,
                partNumber: currentPart,
                totalParts: undefined,
                tables: chunkState.tables,
                localStorageData: chunkState.localStorageData,
                coupleSpaceData: chunkState.coupleSpaceData,
                assetPool: chunkState.assetPool
            });
            chunkState = null;
            await writeExportBlob(chunkBlob, chunkFileName, currentPart, 'chunk', estimatedBytes, lastSource);
            chunkBlob = null;
            await flushPendingOverflowResources();
        };

        const addRowToChunk = (compressedTableName, compressedRow, sourceInfo = null, estimatedRowBytes = null) => {
            if (!chunkState.tables[compressedTableName]) chunkState.tables[compressedTableName] = [];
            chunkState.tables[compressedTableName].push(compressedRow);
            // JSON.stringify is used only for a bounded row-size estimate; the
            // final serialization happens once, inside buildChunkBlob.
            chunkState.estimatedBytes += Number.isFinite(estimatedRowBytes)
                ? estimatedRowBytes
                : getUtf8ByteLength(JSON.stringify(compressedRow)) + 1;
            chunkState.hasData = true;
            chunkState.lastSource = sourceInfo;
        };

        const addConfigEntryToChunk = async (fieldName, key, value) => {
            const candidateAssets = {};
            let compressedValue = compressObject(value, candidateAssets);
            let valueBytes = key.length + getUtf8ByteLength(JSON.stringify(compressedValue)) + 4;
            let newAssetBytes = 0;
            for (const assetKey of Object.keys(candidateAssets)) {
                if (!chunkState.assetKeys.has(assetKey)) {
                    newAssetBytes += getExportAssetByteLength(assetKey, candidateAssets[assetKey]);
                }
            }

            if (chunkState.estimatedBytes > 0
                && chunkState.estimatedBytes + valueBytes + newAssetBytes > MAX_ESTIMATED_CHUNK_BYTES) {
                await flushChunk();
                chunkState = createChunkState('table');
                newAssetBytes = Object.keys(candidateAssets)
                    .reduce((total, assetKey) => total + getExportAssetByteLength(assetKey, candidateAssets[assetKey]), 0);
            }

            const originalEstimatedBytes = valueBytes + newAssetBytes;
            if (originalEstimatedBytes > MAX_ESTIMATED_CHUNK_BYTES) {
                reportExportDiagnostic(options, {
                    kind: 'oversized-config-entry',
                    field: fieldName,
                    key,
                    estimatedBytes: originalEstimatedBytes,
                    estimatedSize: formatExportBytes(originalEstimatedBytes),
                    targetSize: formatExportBytes(MAX_ESTIMATED_CHUNK_BYTES)
                });
                const overflowResources = [];
                compressedValue = prepareOverflowValue(
                    compressedValue,
                    candidateAssets,
                    createResourceId,
                    overflowResources,
                    Math.max(64 * 1024, Math.floor(OVERFLOW_RESOURCE_BYTES / 4)),
                    MAX_ESTIMATED_CHUNK_BYTES
                );
                pendingOverflowResources.push(...overflowResources);
                for (const assetKey of Object.keys(candidateAssets)) delete candidateAssets[assetKey];
                valueBytes = key.length + getUtf8ByteLength(JSON.stringify(compressedValue)) + 4;
                newAssetBytes = 0;
            } else if (valueBytes + newAssetBytes >= LARGE_EXPORT_ITEM_BYTES) {
                reportExportDiagnostic(options, {
                    kind: 'large-config-entry',
                    field: fieldName,
                    key,
                    estimatedBytes: valueBytes + newAssetBytes,
                    estimatedSize: formatExportBytes(valueBytes + newAssetBytes)
                });
            }

            if (!chunkState[fieldName]) chunkState[fieldName] = {};
            chunkState[fieldName][key] = compressedValue;
            for (const [assetKey, assetValue] of Object.entries(candidateAssets)) {
                if (!chunkState.assetKeys.has(assetKey)) {
                    chunkState.assetKeys.add(assetKey);
                    chunkState.assetPool[assetKey] = assetValue;
                }
            }
            chunkState.assetBytes += newAssetBytes;
            chunkState.estimatedBytes += valueBytes + newAssetBytes;
            chunkState.hasData = true;
            chunkState.lastSource = { type: fieldName, key };

            if (chunkState.estimatedBytes >= MAX_ESTIMATED_CHUNK_BYTES) {
                await flushChunk();
                chunkState = createChunkState('table');
            }
        };

        // Configuration data can contain full-size uploaded images. Add each
        // entry through the same rolling boundary as table rows so one large
        // setting cannot silently pull every other setting into part 1.
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!shouldExportLocalStorageKey(key, normalizedOptions)) continue;
            await addConfigEntryToChunk('localStorageData', key, localStorage.getItem(key));
        }

        if (normalizedOptions.couple) {
            const csData = await getCSDBData();
            for (const key in csData) {
                await addConfigEntryToChunk('coupleSpaceData', key, csData[key]);
            }
        }

        // Stream every table in primary-key order. A row that crosses the
        // threshold finishes the current chunk, so no second full backup is
        // ever accumulated in memory.
        for (const tableName of tableNames) {
            const table = db.table(tableName);
            const primKey = table.schema.primKey.name;
            const compressedTableName = KEY_MAP[tableName] || tableName;
            let lastCursor = null;

            while (true) {
                await sleep(0);
                const collection = lastCursor === null
                    ? table.orderBy(primKey).limit(10)
                    : table.where(primKey).above(lastCursor).limit(10);
                let rows = await collection.toArray();
                if (rows.length === 0) break;
                const pageLastCursor = rows[rows.length - 1][primKey];

                while (rows.length > 0) {
                    const row = rows.shift();
                    if (shouldSkipAppDataRow(tableName, row, normalizedOptions)) continue;
                    const candidateAssets = {};
                    let compressedRow = compressObject(row, candidateAssets);
                    let rowBytes = getUtf8ByteLength(JSON.stringify(compressedRow)) + 1;
                    let newAssetBytes = 0;
                    for (const assetKey of Object.keys(candidateAssets)) {
                        if (!chunkState.assetKeys.has(assetKey)) {
                            newAssetBytes += getExportAssetByteLength(assetKey, candidateAssets[assetKey]);
                        }
                    }

                    if (chunkState.hasData
                        && chunkState.estimatedBytes + rowBytes + newAssetBytes > MAX_ESTIMATED_CHUNK_BYTES) {
                        await flushChunk();
                        chunkState = createChunkState('table');
                        newAssetBytes = Object.keys(candidateAssets)
                            .reduce((total, assetKey) => total + getExportAssetByteLength(assetKey, candidateAssets[assetKey]), 0);
                    }

                    const originalEstimatedRowBytes = rowBytes + newAssetBytes;
                    if (originalEstimatedRowBytes > MAX_ESTIMATED_CHUNK_BYTES) {
                        reportExportDiagnostic(options, {
                            kind: 'oversized-row',
                            table: tableName,
                            primaryKey: row[primKey],
                            rowBytes,
                            assetBytes: newAssetBytes,
                            estimatedBytes: originalEstimatedRowBytes,
                            estimatedSize: formatExportBytes(originalEstimatedRowBytes),
                            targetSize: formatExportBytes(MAX_ESTIMATED_CHUNK_BYTES)
                        });
                        const overflowResources = [];
                        compressedRow = prepareOverflowValue(
                            compressedRow,
                            candidateAssets,
                            createResourceId,
                            overflowResources,
                            Math.max(64 * 1024, Math.floor(OVERFLOW_RESOURCE_BYTES / 4)),
                            MAX_ESTIMATED_CHUNK_BYTES
                        );
                        pendingOverflowResources.push(...overflowResources);
                        for (const assetKey of Object.keys(candidateAssets)) delete candidateAssets[assetKey];
                        rowBytes = getUtf8ByteLength(JSON.stringify(compressedRow)) + 1;
                        newAssetBytes = 0;
                    } else if (rowBytes + newAssetBytes >= LARGE_EXPORT_ITEM_BYTES) {
                        reportExportDiagnostic(options, {
                            kind: 'large-row',
                            table: tableName,
                            primaryKey: row[primKey],
                            rowBytes,
                            assetBytes: newAssetBytes,
                            estimatedBytes: rowBytes + newAssetBytes,
                            estimatedSize: formatExportBytes(rowBytes + newAssetBytes)
                        });
                    }

                    for (const [assetKey, assetValue] of Object.entries(candidateAssets)) {
                        if (!chunkState.assetKeys.has(assetKey)) {
                            chunkState.assetKeys.add(assetKey);
                            chunkState.assetPool[assetKey] = assetValue;
                        }
                    }
                    chunkState.assetBytes += newAssetBytes;
                    addRowToChunk(compressedTableName, compressedRow, { table: tableName, primaryKey: row[primKey] }, rowBytes);
                    chunkState.estimatedBytes += newAssetBytes;
                    if (chunkState.estimatedBytes >= MAX_ESTIMATED_CHUNK_BYTES) await flushChunk();
                    if (!chunkState) {
                        chunkState = createChunkState('table');
                    }
                }
                lastCursor = pageLastCursor;
                rows = null;
            }
        }

        // Flush the final partial chunk. Web exports still avoid JSZip; the APK
        // streams each part into Android's ZIP writer instead of retaining it.
        if (chunkState && (chunkState.hasData || partIndex === 1)) await flushChunk();

        if (nativeArchiveSupported) {
            showDynamicIsland('请选择备份文件保存位置', 'loading');
            const result = await finishNativeBackupExport(nativeExportSessionId);
            nativeExportSessionId = null;
            if (!result?.saved) {
                showDynamicIsland('已取消保存备份', 'success');
                return;
            }
            showDynamicIsland('备份文件已保存', 'success');
            alert(`备份已保存为一个 ZIP 文件。\n\n文件名：${result.fileName}\n下次导入时只需要选择这一个文件。`);
        } else if (!onChunk) {
            showDynamicIsland('全部导出完毕！', 'success');
            alert(`全部文件已保存。\n\n请检查文件管理，确认带 [${timestampId}] 编号的文件数量完整。\n下次导入时，多选这 ${partIndex - 1} 个 JSON 文件即可恢复。`);
        }
        return { backupId: timestampId, partCount: partIndex - 1 };
    } catch (error) {
        await abortNativeBackupExport(nativeExportSessionId);
        nativeExportSessionId = null;
        console.error('分块导出出错:', error);
        showDynamicIsland('分块导出出错', {
            variant: 'error',
            detail: error?.message || '分块导出过程中发生错误',
            copyText: error?.stack || error?.message || '分块导出出错'
        });
        if (onChunk) throw error;
    } finally {
        activeExportMode = null;
    }
}

async function readChunkFile(file) {
    if (typeof file?.readText === 'function') return file.readText();
    if (file.nativeSessionId) return readNativeBackupPart(file.nativeSessionId, file.name);
    if (file.zipEntry) return file.zipEntry.async('string');

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

export async function importNativeBackup() {
    if (!isNativeRuntime()) return false;
    showDynamicIsland('正在打开备份文件...', { loading: true });
    if (!(await isNativeBackupSupported())) return false;

    let sessionId = null;
    try {
        showDynamicIsland('正在读取并校验备份文件...', { loading: true });
        const archive = await openNativeBackupImport();
        if (archive?.canceled) return true;
        sessionId = archive?.sessionId || null;
        const entryNames = Array.isArray(archive?.entries) ? archive.entries : [];
        if (!sessionId || entryNames.length === 0) throw new Error('备份文件中没有可恢复的数据');

        const files = entryNames.map(name => ({ name, nativeSessionId: sessionId }));
        await importChunkFiles(files);
        return true;
    } catch (error) {
        console.error('原生备份导入失败:', error);
        showDynamicIsland('打开备份失败', {
            variant: 'error',
            detail: error?.message || '打开备份文件时发生错误',
            copyText: error?.stack || error?.message || '打开备份失败'
        });
        return true;
    } finally {
        await closeNativeBackupImport(sessionId);
    }
}

export async function importChunkFiles(fileList, options = {}) {
    if (activeExportMode || activeImportMode) {
        showDynamicIsland(getDataTaskConflictMessage(), 'warning');
        return false;
    }
    const selectedFiles = Array.from(fileList);
    if (selectedFiles.length === 0) return false;
    activeImportMode = 'chunk';

    try {
        let files = selectedFiles;
        const zipFiles = selectedFiles.filter(file => /\.zip$/i.test(file.name) || /zip/i.test(file.type || ''));

        if (zipFiles.length > 0) {
            if (selectedFiles.length !== 1) {
                alert('ZIP 分块备份请单独选择，不要和其他 JSON 文件一起选择。');
                return false;
            }

            const JSZip = await getJSZip();
            const zip = await JSZip.loadAsync(zipFiles[0]);
            files = Object.values(zip.files)
                .filter(entry => !entry.dir && /\.json$/i.test(entry.name))
                .map(entry => ({ name: entry.name, zipEntry: entry }));

            if (files.length === 0) {
                throw new Error('ZIP 文件中没有找到分块 JSON 文件');
            }

            // APK 原生 ZIP 带有清单；校验清单只用于确认文件没有缺块，
            // 没有清单的普通 JSON 压缩包仍按原有分块逻辑导入。
            const manifestEntry = zip.file('looky-backup.manifest');
            if (manifestEntry) {
                const manifest = JSON.parse(await manifestEntry.async('string'));
                const manifestNames = Array.isArray(manifest.entries)
                    ? manifest.entries.map(entry => String(entry?.name || '')).filter(Boolean)
                    : [];
                const fileNames = files.map(file => file.name);
                if (manifest.format !== 'looky-native-backup-v1'
                    || manifest.partCount !== files.length
                    || manifestNames.length !== files.length
                    || manifestNames.some(name => !fileNames.includes(name))) {
                    throw new Error('APK 备份清单与 ZIP 内容不一致');
                }
            }
        }

        files.sort((a, b) => {
            const matchA = a.name.match(/part(\d+)/i);
            const matchB = b.name.match(/part(\d+)/i);
            const partA = matchA ? parseInt(matchA[1], 10) : 999;
            const partB = matchB ? parseInt(matchB[1], 10) : 999;
            return partA - partB;
        });

        // 先完整读取并检查所有分块，确认无缺失、重复、损坏后才清空数据库。
        const seenParts = new Set();
        let backupId = null;
        let baseCount = 0;
        let expectedTotalParts = null;
        let metadataCount = 0;
        const overflowResourceIndex = new Map();
        const referencedOverflowResources = new Set();
        for (const file of files) {
            const nameMatch = file.name.match(/^\[([^\]]+)\]_\[part(\d+)\]_.*\.json$/i);
            if (!nameMatch) throw new Error(`分块文件名格式不正确：${file.name}`);

            const currentBackupId = nameMatch[1];
            const partNumber = Number(nameMatch[2]);
            if (backupId === null) backupId = currentBackupId;
            if (backupId !== currentBackupId) throw new Error('选择的分块文件不是同一次导出');
            if (seenParts.has(partNumber)) throw new Error(`发现重复的第 ${partNumber} 个分块`);
            seenParts.add(partNumber);

            const importData = JSON.parse(await readChunkFile(file));
            if (importData?.version === OVERFLOW_RESOURCE_VERSION && importData?.type === 'resource') {
                if (String(importData.backupId || '') !== currentBackupId) {
                    throw new Error(`资源分块与文件名不属于同一次导出：${file.name}`);
                }
                const resourceId = String(importData.resourceId || '');
                const mode = String(importData.mode || '');
                const segmentIndex = Number(importData.segmentIndex);
                const expectedChars = Number(importData.expectedChars);
                if (!/^[A-Za-z0-9_-]{1,160}$/.test(resourceId)
                    || !['string', 'json'].includes(mode)
                    || !Number.isInteger(segmentIndex)
                    || segmentIndex < 0
                    || !Number.isInteger(expectedChars)
                    || expectedChars < 0
                    || typeof importData.data !== 'string'
                    || importData.data.length > expectedChars
                    || typeof importData.isLast !== 'boolean') {
                    throw new Error(`备份资源分块格式不正确：${file.name}`);
                }
                let resourceEntry = overflowResourceIndex.get(resourceId);
                if (!resourceEntry) {
                    resourceEntry = { mode, expectedChars, segments: new Map() };
                    overflowResourceIndex.set(resourceId, resourceEntry);
                }
                if (resourceEntry.mode !== mode || resourceEntry.expectedChars !== expectedChars || resourceEntry.segments.has(segmentIndex)) {
                    throw new Error(`备份资源分块重复或元数据不一致：${file.name}`);
                }
                resourceEntry.segments.set(segmentIndex, {
                    file,
                    segmentIndex,
                    isLast: importData.isLast,
                    mode,
                    expectedChars
                });
                await sleep(0);
                continue;
            }
            if (!importData || importData.version !== '1.5-chunk') {
                throw new Error(`不是有效的分块备份文件：${file.name}`);
            }
            if (importData.backupId !== undefined || importData.partNumber !== undefined || importData.totalParts !== undefined) {
                metadataCount++;
                if (String(importData.backupId) !== currentBackupId || Number(importData.partNumber) !== partNumber) {
                    throw new Error(`分块编号与文件名不一致：${file.name}`);
                }
                const currentTotalParts = Number(importData.totalParts);
                if (!Number.isInteger(currentTotalParts) || currentTotalParts < 1) {
                    throw new Error(`分块总数不正确：${file.name}`);
                }
                if (expectedTotalParts === null) expectedTotalParts = currentTotalParts;
                if (expectedTotalParts !== currentTotalParts) throw new Error('分块文件记录的总数不一致');
            }
            if (!['base', 'table', 'messages'].includes(importData.type)) {
                throw new Error(`分块类型不正确：${file.name}`);
            }
            if (importData.type === 'base' && partNumber !== 1) {
                throw new Error('配置分块必须是第 1 个分块');
            }
            if (importData.type !== 'base' && partNumber === 1) {
                throw new Error('第 1 个分块必须是配置分块');
            }
            if (!importData.tables || typeof importData.tables !== 'object' || Array.isArray(importData.tables)) {
                throw new Error(`分块数据库内容缺失：${file.name}`);
            }
            const assetPool = importData.assets && typeof importData.assets === 'object' && !Array.isArray(importData.assets)
                ? importData.assets
                : {};
            validateAssetReferences(importData.localStorageData, assetPool, file.name);
            validateAssetReferences(importData.coupleSpaceData, assetPool, file.name);
            validateAssetReferences(importData.tables, assetPool, file.name);
            collectOverflowResourceRefs(importData.localStorageData, referencedOverflowResources);
            collectOverflowResourceRefs(importData.coupleSpaceData, referencedOverflowResources);
            collectOverflowResourceRefs(importData.tables, referencedOverflowResources);
            if (importData.type === 'base') baseCount++;
            await sleep(0);
        }

        validateOverflowResourceIndex(overflowResourceIndex);
        for (const resourceId of referencedOverflowResources) {
            if (!overflowResourceIndex.has(resourceId)) throw new Error(`备份资源缺失：${resourceId}`);
        }

        if (metadataCount > 0 && metadataCount !== files.length) {
            throw new Error('新旧两种分块文件不能混合导入');
        }
        if (expectedTotalParts !== null && files.length !== expectedTotalParts) {
            throw new Error(`分块数量不完整：应有 ${expectedTotalParts} 个，实际选择 ${files.length} 个`);
        }

        for (let partNumber = 1; partNumber <= (expectedTotalParts || files.length); partNumber++) {
            if (!seenParts.has(partNumber)) throw new Error(`缺少第 ${partNumber} 个分块`);
        }
        if (baseCount !== 1 || !seenParts.has(1)) {
            throw new Error('分块备份缺少唯一的配置文件');
        }

        const isNativeArchive = files.some(file => Boolean(file.nativeSessionId));
        const confirmText = isNativeArchive
            ? '即将导入这个 LOOKY 备份文件。\n⚠️ 导入前将清空现有所有数据！\n确定要继续吗？'
            : `即将导入选中的 ${files.length} 个分块文件。\n⚠️ 导入前将清空现有所有数据！\n请确保这些文件属于同一次导出。`;
        if (!options.skipConfirm && !confirm(confirmText)) return false;

        options.onProgress?.('正在清空旧数据...');
        showDynamicIsland('正在清空旧数据...', 'loading');
        clearImportLocalStorage();
        for (const table of db.tables) {
            await table.clear();
        }
        
        let lastYieldTime = performance.now();
        let coupleSpaceDataCleared = false;
        for (let idx = 0; idx < files.length; idx++) {
            const file = files[idx];
            options.onProgress?.(`正在恢复第 ${idx + 1}/${files.length} 个分块...`);
            showDynamicIsland(`导入文件 ${idx + 1}/${files.length} ...`, 'loading');
            
             const jsonContent = await readChunkFile(file);
             const importData = JSON.parse(jsonContent);
            if (importData?.version === OVERFLOW_RESOURCE_VERSION && importData?.type === 'resource') {
                continue;
            }
            const assetPool = importData.assets || {};
            const resourceCache = new Map();
            const loadOverflowResource = async resourceId => {
                if (resourceCache.has(resourceId)) return resourceCache.get(resourceId);
                const entry = overflowResourceIndex.get(resourceId);
                if (!entry) throw new Error(`备份资源缺失：${resourceId}`);
                const segments = [...entry.segments.values()].sort((left, right) => left.segmentIndex - right.segmentIndex);
                const pieces = [];
                for (const segment of segments) {
                    const segmentData = JSON.parse(await readChunkFile(segment.file));
                    if (segmentData.resourceId !== resourceId
                        || segmentData.segmentIndex !== segment.segmentIndex
                        || segmentData.mode !== entry.mode
                        || segmentData.expectedChars !== entry.expectedChars
                        || typeof segmentData.data !== 'string') {
                        throw new Error(`备份资源片段校验失败：${resourceId}`);
                    }
                    pieces.push(segmentData.data);
                }
                const rawValue = pieces.join('');
                if (rawValue.length !== entry.expectedChars) {
                    throw new Error(`备份资源长度校验失败：${resourceId}`);
                }
                const resolved = entry.mode === 'json' ? JSON.parse(rawValue) : rawValue;
                resourceCache.set(resourceId, resolved);
                return resolved;
            };
            const localStorageData = await resolveOverflowReferences(importData.localStorageData, loadOverflowResource, resourceCache);
            const coupleSpaceData = await resolveOverflowReferences(importData.coupleSpaceData, loadOverflowResource, resourceCache);
            const tablesData = await resolveOverflowReferences(importData.tables, loadOverflowResource, resourceCache);
            // 【核心修复】分块导入时恢复 localStorage
            if (localStorageData) {
                for (const key in localStorageData) {
                    if (LOOKY_AUTH_STORAGE_KEYS.has(key)) continue;
                    try {
                        localStorage.setItem(key, decompressObject(localStorageData[key], assetPool));
                    } catch (err) {
                        console.warn(`分块导入防崩溃跳过: ${key}`);
                    }
                }
            }

            if (coupleSpaceData) {

                const csDataToStore = {};
                for (const key in coupleSpaceData) {
                    csDataToStore[key] = decompressObject(coupleSpaceData[key], assetPool);
                }
                await putCSDBData(csDataToStore, { clearExisting: !coupleSpaceDataCleared });
                coupleSpaceDataCleared = true;
            }
            
            for (const compressedTableName of Object.keys(tablesData || {})) {

            const tableName = REVERSE_KEY_MAP[compressedTableName] || compressedTableName;
                if (db[tableName]) {
                    const rows = tablesData[compressedTableName];
                    if (rows && rows.length > 0) {
                        await writeImportedRowsSafely(tableName, rows, assetPool, true);
                    }
                }
            }
        }
        
        showDynamicIsland('分块导入成功，即将刷新', 'success');
        await sleep(1000);
        window.location.reload();
        return true;
    } catch(e) {
        console.error(e);
        showDynamicIsland('分块导入失败', {
            variant: 'error',
            detail: e?.message || '分块导入过程中发生错误',
            copyText: e?.stack || e?.message || '分块导入失败'
        });
        return false;
    } finally {
        activeImportMode = null;
    }
}
// ===================================================================
// == 9. 【新增】定时导出提醒功能 ==
// ===================================================================
export function initExportReminder() {
    const toggle = document.getElementById('export-reminder-toggle');
    const daysInput = document.getElementById('export-reminder-days');
    const timeInput = document.getElementById('export-reminder-time');
    const saveBtn = document.getElementById('save-export-reminder-btn');
    
    // 初始化时加载配置
    if (toggle && daysInput && timeInput && saveBtn) {
        const config = JSON.parse(localStorage.getItem('export_reminder_config')) || { enabled: true, days: 2, time: '22:00' };
        toggle.checked = config.enabled;
        daysInput.value = config.days;
        timeInput.value = config.time;
        
        saveBtn.addEventListener('click', () => {
            localStorage.setItem('export_reminder_config', JSON.stringify({
                enabled: toggle.checked,
                days: parseInt(daysInput.value) || 2,
                time: timeInput.value || '22:00'
            }));
            if (typeof showDynamicIsland !== 'undefined') showDynamicIsland('提醒设置已保存', 'success');
            else alert('提醒设置已保存');
        });
    }

    const modal = document.getElementById('export-reminder-modal');
    const laterBtn = document.getElementById('export-reminder-later-btn');
    const nowBtn = document.getElementById('export-reminder-now-btn');
    
    if (modal && laterBtn && nowBtn) {
        // 点击稍后再说
        laterBtn.addEventListener('click', () => {
            modal.style.opacity = '0';
            setTimeout(() => { modal.style.display = 'none'; }, 300);
            localStorage.setItem('last_export_reminder_date', new Date().toISOString());
        });
        
        // 点击立即导出
        nowBtn.addEventListener('click', () => {
            modal.style.opacity = '0';
            setTimeout(() => { modal.style.display = 'none'; }, 300);
            localStorage.setItem('last_export_reminder_date', new Date().toISOString());
            
            // 呼出系统的全局导出弹窗
            const exportModal = document.getElementById('global-export-modal-overlay');
            if (exportModal) {
                exportModal.style.display = 'flex';
                setTimeout(() => { exportModal.style.opacity = '1'; }, 10);
            } else {
                exportAllData(); // 兜底：直接导出
            }
        });
    }

    // 后台定时检查 (每分钟检查一次)
    setInterval(() => {
        const config = JSON.parse(localStorage.getItem('export_reminder_config')) || { enabled: true, days: 2, time: '22:00' };
        if (!config.enabled) return;
        
        const now = new Date();
        const [setHour, setMinute] = config.time.split(':').map(Number);
        
        const currentTimeVal = now.getHours() * 60 + now.getMinutes();
        const setTimeVal = setHour * 60 + setMinute;
        
        // 只有到了指定时间的5分钟范围内才会触发判断
        if (currentTimeVal >= setTimeVal && currentTimeVal < setTimeVal + 5) {
            const lastReminderDateStr = localStorage.getItem('last_export_reminder_date');
            let shouldRemind = true;
            
            if (lastReminderDateStr) {
                const lastDate = new Date(lastReminderDateStr);
                const diffDays = Math.ceil(Math.abs(now - lastDate) / (1000 * 60 * 60 * 24)); 
                if (diffDays < config.days) shouldRemind = false; // 还没到设定的间隔天数
            }
            
            // 确保一天只提示一次
            const todayStr = now.toISOString().split('T')[0];
            const alreadyRemindedToday = localStorage.getItem('export_reminded_today') === todayStr;
            
            if (shouldRemind && !alreadyRemindedToday) {
                localStorage.setItem('export_reminded_today', todayStr);
                if (modal) {
                    modal.style.display = 'flex';
                    setTimeout(() => { modal.style.opacity = '1'; }, 10);
                }
            }
        }
    }, 60000); 
}
