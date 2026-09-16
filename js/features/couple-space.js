import { showDynamicIsland } from '../ui.js';
import { tempState, AppState, DEFAULT_AVATAR_SRC, db } from '../state.js';
import { getCurrentChatIdentity } from './chat-ui.js';
// --- ▼▼▼ 【新增】原生 IndexedDB 数据库极简封装 ▼▼▼ ---
const CS_DB_NAME = 'CoupleSpaceData';
const CS_STORE_NAME = 'store';
let csDbInstance = null; // 【新增】全局缓存数据库实例，避免每次操作新建连接
let dbOpenPromise = null; // 【关键补充】并发锁，防止瞬间同时读取多次打开数据库

function getCSDB() {
    if (csDbInstance) return Promise.resolve(csDbInstance); 
    if (dbOpenPromise) return dbOpenPromise; // 如果正在连接中，直接排队等同一个结果

    dbOpenPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(CS_DB_NAME, 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore(CS_STORE_NAME);
        req.onsuccess = () => {
            csDbInstance = req.result; // 【修改】保存实例
            dbOpenPromise = null; // 连接成功，清空锁
            // 监听意外断开，立刻清除失效实例
            csDbInstance.onclose = () => { csDbInstance = null; };
            csDbInstance.onabort = () => { csDbInstance = null; };
            csDbInstance.onerror = () => { csDbInstance = null; };
            resolve(csDbInstance);
        };
        req.onerror = () => {
            csDbInstance = null;
            dbOpenPromise = null;
            reject(req.error);
        };
    });
    return dbOpenPromise;
}

async function saveCSData(key, value) {
    try {
        const db = await getCSDB();
        return new Promise((resolve, reject) => {
            const req = db.transaction(CS_STORE_NAME, 'readwrite').objectStore(CS_STORE_NAME).put(value, key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    } catch (e) { console.error("DB Save Error:", e); }
}

async function loadCSData(key) {
    try {
        const db = await getCSDB();
        return await new Promise(resolve => {
            const req = db.transaction(CS_STORE_NAME, 'readonly').objectStore(CS_STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    } catch (e) { return null; }
}

// 兼容不同模型的 message.content 返回形态：字符串、内容片段数组，或已解析对象。
function parseCoupleAiJson(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (!('content' in value) && !('text' in value)) return value;
    }
    const text = Array.isArray(value)
        ? value.map(item => typeof item === 'string' ? item : (item?.text ?? item?.content ?? '')).join('')
        : String(value?.text ?? value?.content ?? value ?? '');
    const cleaned = text.replace(/[\u0000-\u001F]+/g, ' ')
        .replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    try { return JSON.parse(cleaned); } catch (error) {
        const start = cleaned.indexOf('{');
        if (start < 0) return null;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < cleaned.length; i += 1) {
            const char = cleaned[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') inString = false;
                continue;
            }
            if (char === '"') inString = true;
            else if (char === '{') depth += 1;
            else if (char === '}' && --depth === 0) {
                try { return JSON.parse(cleaned.slice(start, i + 1)); } catch (parseError) { return null; }
            }
        }
        return null;
    }
}

function normalizeCoupleRuleChunks(value) {
    if (!Array.isArray(value)) return [];
    return value.map(item => {
        if (typeof item === 'string') return { p: '', h: item };
        if (!item || typeof item !== 'object') return null;
        return { p: String(item.p ?? ''), h: String(item.h ?? '') };
    }).filter(item => item && item.h !== '');
}

function showCSModal(modal, options = {}) {
    if (!modal) return;
    modal.style.display = options.display || 'flex';
    if (options.visibleClass) modal.classList.add(options.visibleClass);

    const makeVisible = () => {
        modal.style.opacity = '1';
        modal.style.pointerEvents = 'auto';
        if (typeof options.afterVisible === 'function') options.afterVisible();
    };

    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(makeVisible));
    } else {
        setTimeout(makeVisible, 16);
    }
}
// ▼▼▼ 【新增】生理期日历渲染引擎 ▼▼▼
let currentCalDate = new Date();
let selectedCalDateStr = (() => {
    const d = new Date();
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().split('T')[0];
})();
let periodHistoryExpanded = false;

// 工具函数：安全地将 YYYY-MM-DD 解析为本地时间，防止时区导致的日期错位Bug
const getLocalTime = (dateStr) => {
    if (!dateStr) return 0;
    const parts = dateStr.split('-');
    return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
};

const PERIOD_DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_PAIN_LABELS = ['无', '轻', '中', '重'];
const PERIOD_FLOW_LABELS = ['少', '中', '多'];
const PERIOD_MOOD_LABELS = ['平静', '敏感', '烦躁', '低落'];
const PERIOD_PHYSICAL_LABELS = ['腰酸', '胸闷', '头痛', '乏力'];

function getTodayPeriodDate() {
    const d = new Date();
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().split('T')[0];
}

function addPeriodDays(dateStr, days) {
    if (!dateStr) return '';
    const date = new Date(getLocalTime(dateStr));
    date.setDate(date.getDate() + Number(days || 0));
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatPeriodDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(getLocalTime(dateStr));
    return `${date.getMonth() + 1}.${date.getDate()}`;
}

function normalizePeriodSettings(raw) {
    const duration = Math.min(14, Math.max(1, parseInt(raw?.duration, 10) || 5));
    const cycle = Math.min(45, Math.max(20, parseInt(raw?.cycle, 10) || 28));
    return { duration, cycle };
}

function normalizePeriodRecords(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(record => record && typeof record.start === 'string' && getLocalTime(record.start))
        .map(record => ({
            ...record,
            start: record.start,
            end: typeof record.end === 'string' && getLocalTime(record.end) ? record.end : null
        }))
        .sort((a, b) => getLocalTime(b.start) - getLocalTime(a.start));
}

function getDefaultPeriodEnd(start, duration) {
    return addPeriodDays(start, duration - 1);
}

function getPeriodModeLabel(values, labels) {
    const counts = new Map();
    values.forEach(value => {
        const index = Number(value);
        if (Number.isInteger(index) && labels[index]) {
            counts.set(index, (counts.get(index) || 0) + 1);
        }
    });
    if (counts.size === 0) return '';
    let bestIndex = null;
    let bestCount = -1;
    counts.forEach((count, index) => {
        if (count > bestCount) {
            bestIndex = index;
            bestCount = count;
        }
    });
    return labels[bestIndex] || '';
}

function getPeriodSymptomsInRange(symptoms, start, end) {
    if (!symptoms || !start || !end) return [];
    const startTime = getLocalTime(start);
    const endTime = getLocalTime(end);
    return Object.entries(symptoms)
        .filter(([date, record]) => {
            const time = getLocalTime(date);
            return time >= startTime && time <= endTime && record && typeof record === 'object';
        })
        .map(([date, record]) => ({ date, ...record }));
}

async function loadPeriodSnapshot() {
    const settings = normalizePeriodSettings(await loadCSData('period_settings'));
    const records = normalizePeriodRecords(await loadCSData('period_records'));
    const todayStr = getTodayPeriodDate();
    const todayTime = getLocalTime(todayStr);
    let changed = false;

    records.forEach(record => {
        if (!record.end) {
            const predictedEnd = getDefaultPeriodEnd(record.start, settings.duration);
            const archiveDeadline = getLocalTime(predictedEnd) + 5 * PERIOD_DAY_MS;
            if (todayTime > archiveDeadline) {
                record.end = predictedEnd;
                record.endSource = 'auto';
                changed = true;
            }
        }
    });

    if (changed) {
        await saveCSData('period_records', records);
    }

    return { settings, records, todayStr, changed };
}

async function buildPeriodStatistics(snapshot = null) {
    const current = snapshot || await loadPeriodSnapshot();
    const { settings, records, todayStr } = current;
    const symptoms = await loadCSData('period_symptoms') || {};
    const completedRecords = records.filter(record => record.end);
    const cycleValues = [];
    const durationValues = [];

    completedRecords.forEach(record => {
        const duration = Math.round((getLocalTime(record.end) - getLocalTime(record.start)) / PERIOD_DAY_MS) + 1;
        if (duration > 0) durationValues.push(duration);
    });
    for (let index = 0; index < records.length - 1; index++) {
        const cycle = Math.round((getLocalTime(records[index].start) - getLocalTime(records[index + 1].start)) / PERIOD_DAY_MS);
        if (cycle > 0) cycleValues.push(cycle);
    }

    const latestRecord = records[0] || null;
    const todayTime = getLocalTime(todayStr);
    const predictedEnd = latestRecord ? getDefaultPeriodEnd(latestRecord.start, settings.duration) : '';
    let nextPredictedStart = latestRecord ? addPeriodDays(latestRecord.start, settings.cycle) : '';
    if (latestRecord) {
        let cursor = latestRecord.start;
        while (getLocalTime(addPeriodDays(cursor, settings.cycle)) <= todayTime) {
            cursor = addPeriodDays(cursor, settings.cycle);
        }
        nextPredictedStart = getLocalTime(cursor) > getLocalTime(latestRecord.start)
            ? cursor
            : addPeriodDays(latestRecord.start, settings.cycle);
    }
    const nextPredictedEnd = nextPredictedStart ? getDefaultPeriodEnd(nextPredictedStart, settings.duration) : '';
    const symptomEnd = latestRecord ? (latestRecord.end || todayStr) : '';
    const currentSymptoms = latestRecord ? getPeriodSymptomsInRange(symptoms, latestRecord.start, symptomEnd) : [];
    const symptomPain = getPeriodModeLabel(currentSymptoms.map(item => item.pain), PERIOD_PAIN_LABELS);
    const symptomMood = getPeriodModeLabel(currentSymptoms.map(item => item.mood), PERIOD_MOOD_LABELS);
    const physicalCounts = new Map();
    currentSymptoms.forEach(item => {
        (Array.isArray(item.physical) ? item.physical : []).forEach(index => {
            physicalCounts.set(index, (physicalCounts.get(index) || 0) + 1);
        });
    });
    const frequentSymptoms = Array.from(physicalCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([index]) => PERIOD_PHYSICAL_LABELS[index])
        .filter(Boolean);
    const countByLabel = (values, labels) => labels
        .map((label, index) => ({
            label,
            count: values.filter(value => Number(value) === index).length
        }))
        .filter(item => item.count > 0);
    const recentHistory = records.slice(0, 6).map((record, index) => {
        const end = record.end || getDefaultPeriodEnd(record.start, settings.duration);
        return {
            start: record.start,
            end: record.end || null,
            duration: Math.max(1, Math.round((getLocalTime(end) - getLocalTime(record.start)) / PERIOD_DAY_MS) + 1),
            cycle: records[index + 1]
                ? Math.round((getLocalTime(record.start) - getLocalTime(records[index + 1].start)) / PERIOD_DAY_MS)
                : null
        };
    }).reverse();
    const painTrend = currentSymptoms.map(item => ({
        date: item.date,
        label: formatPeriodDate(item.date),
        value: Number.isInteger(Number(item.pain)) ? Number(item.pain) : null,
        text: PERIOD_PAIN_LABELS[item.pain] || ''
    })).filter(item => item.value !== null);
    const moodDistribution = countByLabel(currentSymptoms.map(item => item.mood), PERIOD_MOOD_LABELS);
    const painDistribution = countByLabel(currentSymptoms.map(item => item.pain), PERIOD_PAIN_LABELS);
    const cycleDaysPassed = latestRecord
        ? Math.max(0, Math.floor((todayTime - getLocalTime(latestRecord.start)) / PERIOD_DAY_MS) + 1)
        : 0;
    const daysToNext = nextPredictedStart ? Math.floor((getLocalTime(nextPredictedStart) - todayTime) / PERIOD_DAY_MS) : null;
    const cycleProgress = latestRecord
        ? Math.min(1, Math.max(0, cycleDaysPassed / settings.cycle))
        : 0;

    const statistics = {
        updatedAt: todayStr,
        settings,
        totalRecords: records.length,
        averageCycle: cycleValues.length ? Math.round(cycleValues.reduce((sum, value) => sum + value, 0) / cycleValues.length) : null,
        averageDuration: durationValues.length ? Math.round(durationValues.reduce((sum, value) => sum + value, 0) / durationValues.length) : null,
        lastStart: latestRecord?.start || '',
        lastEnd: latestRecord?.end || '',
        predictedEnd,
        nextPredictedStart,
        nextPredictedEnd,
        cycleProgress,
        cycleDaysPassed,
        daysToNext,
        recentHistory,
        painTrend,
        moodDistribution,
        painDistribution,
        history: records.map((record, index) => ({
            start: record.start,
            end: record.end || null,
            endSource: record.endSource || 'user',
            duration: record.end ? Math.round((getLocalTime(record.end) - getLocalTime(record.start)) / PERIOD_DAY_MS) + 1 : null,
            cycle: records[index + 1]
                ? Math.round((getLocalTime(record.start) - getLocalTime(records[index + 1].start)) / PERIOD_DAY_MS)
                : null
        })),
        symptomSummary: {
            pain: symptomPain,
            mood: symptomMood,
            frequentSymptoms,
            recordedDays: currentSymptoms.length
        }
    };

    await saveCSData('period_stats_cache', statistics);
    return statistics;
}

async function refreshPeriodStatisticsPage() {
    const statistics = await buildPeriodStatistics();
    const overview = document.getElementById('period-stats-overview');
    const symptomSummary = document.getElementById('period-symptom-summary');
    const listContainer = document.getElementById('period-history-list');
    const suggestContainer = document.getElementById('period-analysis-suggestion');
    if (!overview || !symptomSummary || !listContainer || !suggestContainer) return statistics;

    const averageCycle = statistics.averageCycle ? `${statistics.averageCycle} 天` : '--';
    const averageDuration = statistics.averageDuration ? `${statistics.averageDuration} 天` : '--';
    const lastPeriod = statistics.lastStart
        ? `${formatPeriodDate(statistics.lastStart)}${statistics.lastEnd ? ` - ${formatPeriodDate(statistics.lastEnd)}` : ''}`
        : '--';
    const nextPeriod = statistics.nextPredictedStart
        ? `${formatPeriodDate(statistics.nextPredictedStart)} - ${formatPeriodDate(statistics.nextPredictedEnd)}`
        : '--';
    const progressPercent = Math.round((statistics.cycleProgress || 0) * 100);
    const cycleMainText = statistics.daysToNext === null
        ? '--'
        : statistics.daysToNext >= 0
            ? `${statistics.daysToNext} 天`
            : `延迟 ${Math.abs(statistics.daysToNext)} 天`;
    const maxDuration = Math.max(1, ...statistics.recentHistory.map(item => item.duration || 0));
    const maxPainCount = Math.max(1, ...statistics.painDistribution.map(item => item.count || 0));
    const maxMoodCount = Math.max(1, ...statistics.moodDistribution.map(item => item.count || 0));
    const painTrendHtml = statistics.painTrend.length
        ? statistics.painTrend.map(item => {
            const height = 22 + item.value * 18;
            return `<div class="period-pain-bar" title="${item.date} ${item.text}">
                <span style="height:${height}px"></span>
                <em>${item.label}</em>
            </div>`;
        }).join('')
        : '<p class="period-empty-state">暂无痛感趋势</p>';
    const durationBarsHtml = statistics.recentHistory.length
        ? statistics.recentHistory.map(item => {
            const height = Math.max(18, Math.round((item.duration / maxDuration) * 86));
            return `<div class="period-duration-bar" title="${item.start}">
                <span style="height:${height}px"></span>
                <em>${formatPeriodDate(item.start)}</em>
            </div>`;
        }).join('')
        : '<p class="period-empty-state">暂无历史时长</p>';
    const moodBarsHtml = statistics.moodDistribution.length
        ? statistics.moodDistribution.map(item => `<div class="period-distribution-row">
            <span>${item.label}</span>
            <div><i style="width:${Math.round((item.count / maxMoodCount) * 100)}%"></i></div>
            <em>${item.count}</em>
        </div>`).join('')
        : '<p class="period-empty-state">暂无情绪分布</p>';
    const painBarsHtml = statistics.painDistribution.length
        ? statistics.painDistribution.map(item => `<div class="period-distribution-row">
            <span>${item.label}</span>
            <div><i style="width:${Math.round((item.count / maxPainCount) * 100)}%"></i></div>
            <em>${item.count}</em>
        </div>`).join('')
        : '<p class="period-empty-state">暂无痛感分布</p>';

    overview.innerHTML = `
        <section class="period-dashboard-hero">
            <div class="period-ring-meter" style="--progress:${progressPercent}%">
                <div>
                    <span>${progressPercent}%</span>
                    <em>周期进度</em>
                </div>
            </div>
            <div class="period-hero-copy">
                <span>NEXT PERIOD</span>
                <strong>${cycleMainText}</strong>
                <p>${statistics.nextPredictedStart ? `预计 ${nextPeriod}` : '记录一次经期后开始预测'}</p>
            </div>
        </section>
        <div class="period-stats-strip">
            <div class="period-stat-card"><span>平均周期</span><strong>${averageCycle}</strong></div>
            <div class="period-stat-card"><span>平均经期</span><strong>${averageDuration}</strong></div>
            <div class="period-stat-card"><span>上次记录</span><strong>${lastPeriod}</strong></div>
            <div class="period-stat-card"><span>累计记录</span><strong>${statistics.totalRecords || 0} 次</strong></div>
        </div>
        <div class="period-chart-grid">
            <section class="period-chart-card period-chart-wide">
                <div class="period-chart-title"><span>经期时长</span><em>近 6 次</em></div>
                <div class="period-duration-chart">${durationBarsHtml}</div>
            </section>
            <section class="period-chart-card">
                <div class="period-chart-title"><span>痛感趋势</span><em>本次</em></div>
                <div class="period-pain-chart">${painTrendHtml}</div>
            </section>
            <section class="period-chart-card">
                <div class="period-chart-title"><span>情绪分布</span><em>本次</em></div>
                <div class="period-distribution-chart">${moodBarsHtml}</div>
            </section>
            <section class="period-chart-card period-chart-wide">
                <div class="period-chart-title"><span>痛感分布</span><em>用户记录</em></div>
                <div class="period-distribution-chart">${painBarsHtml}</div>
            </section>
        </div>
    `;

    const symptomParts = [];
    if (statistics.symptomSummary.pain) symptomParts.push(`痛感偏${statistics.symptomSummary.pain}`);
    if (statistics.symptomSummary.mood) symptomParts.push(`情绪多为${statistics.symptomSummary.mood}`);
    if (statistics.symptomSummary.frequentSymptoms.length) {
        symptomParts.push(`常见${statistics.symptomSummary.frequentSymptoms.join('、')}`);
    }
    symptomSummary.innerHTML = symptomParts.length
        ? `<span class="period-summary-label">本次经期</span><span>${symptomParts.join('，')}</span>`
        : '<span class="period-summary-label">本次经期</span><span>还没有足够的症状记录</span>';

    const visibleHistory = periodHistoryExpanded ? statistics.history : statistics.history.slice(0, 3);
    const historyToggleHtml = statistics.history.length > 3
        ? `<button class="period-history-toggle-btn" type="button">${periodHistoryExpanded ? '收起记录' : `展开全部 ${statistics.history.length} 条`}</button>`
        : '';
    listContainer.innerHTML = statistics.history.length
        ? visibleHistory.map((item, index) => `
            <div class="period-history-item">
                <div>
                    <strong>${item.start}${item.end ? ` - ${item.end}` : ' - 进行中'}</strong>
                    <span>${item.endSource === 'auto' ? '系统自动收尾' : '用户记录'}</span>
                </div>
                <em>${item.cycle ? `周期 ${item.cycle} 天 / ` : ''}${item.duration ? `经期 ${item.duration} 天` : '尚未结束'}</em>
                <button class="edit-period-record-btn" data-index="${index}" type="button">编辑</button>
            </div>
        `).join('') + historyToggleHtml
        : '<p class="period-empty-state">暂无经期记录</p>';

    const settings = statistics.settings;
    const hasSuggestion = statistics.averageCycle && statistics.averageDuration
        && (Math.abs(statistics.averageCycle - settings.cycle) > 2 || Math.abs(statistics.averageDuration - settings.duration) > 1);
    suggestContainer.style.display = hasSuggestion ? 'block' : 'none';
    suggestContainer.innerHTML = hasSuggestion
        ? `<div class="period-analysis-box">根据已记录数据，平均周期约 ${statistics.averageCycle} 天，平均经期约 ${statistics.averageDuration} 天。<button id="apply-period-suggestion-btn" data-cycle="${statistics.averageCycle}" data-dur="${statistics.averageDuration}">应用建议</button></div>`
        : '';
    return statistics;
}

function playPeriodSuccessAnimation(btn, message = '已记录完成') {
    if (btn) {
        btn.classList.remove('period-action-success');
        void btn.offsetWidth;
        btn.classList.add('period-action-success');
    }
    const layer = document.createElement('div');
    layer.className = 'period-fullscreen-confirm';
    layer.innerHTML = `
        <div class="period-confirm-orbit">
            <div class="period-confirm-core">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20 6 9 17l-5-5"></path>
                </svg>
            </div>
        </div>
        <div class="period-confirm-text">${message}</div>
    `;
    document.body.appendChild(layer);
    requestAnimationFrame(() => layer.classList.add('show'));
    return new Promise(resolve => {
        setTimeout(() => {
            layer.classList.add('leave');
            if (btn) btn.classList.remove('period-action-success');
            setTimeout(() => {
                layer.remove();
                resolve();
            }, 260);
        }, 860);
    });
}

async function refreshPeriodViews() {
    await renderPeriodCalendar(currentCalDate);
    await refreshPeriodStatisticsPage();
}

function closePeriodRecordEditModal() {
    const modal = document.getElementById('period-record-edit-modal-overlay');
    if (!modal) return;
    modal.style.opacity = '0';
    setTimeout(() => { modal.style.display = 'none'; }, 300);
}

async function renderPeriodCalendar(date) {
    const grid = document.getElementById('calendar-days-grid');
    const title = document.getElementById('cal-current-month');
    if (!grid || !title) return;
    
    const snapshot = await loadPeriodSnapshot();
    const { settings, records, todayStr } = snapshot;
    const duration = settings.duration;
    const cycle = settings.cycle;
    const year = date.getFullYear();
    const month = date.getMonth();
    title.innerText = `${year}年 ${month + 1}月`;
    
    let htmlBuffer = ''; // 新增：使用字符串缓冲池代替直接操作 DOM
    
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    
    for (let i = 0; i < firstDay; i++) {
        htmlBuffer += `<div class="day-cell empty"></div>`; // 修改
    }
    const pad = n => n < 10 ? '0'+n : n;
    
    // ▼▼▼ 性能优化开始：提前算好“今天”和“记录时间”，防止在下方循环中运算几千次造成卡顿 ▼▼▼
    const optimizedRecords = records.map(rec => ({
        sTime: getLocalTime(rec.start),
        eTime: rec.end ? getLocalTime(rec.end) : getLocalTime(rec.start) + (duration - 1) * PERIOD_DAY_MS
    }));
    // ▲▲▲ 性能优化结束 ▲▲▲

    // 渲染日期格子
    for (let i = 1; i <= daysInMonth; i++) {

        const cellDateStr = `${year}-${pad(month + 1)}-${pad(i)}`;
        const cellTime = getLocalTime(cellDateStr);
         let typeClass = 'is-safe';
        let isActualPeriod = false;
        
        // 1. 判断是否在真实记录的经期内
        for (const rec of optimizedRecords) {
            const sTime = rec.sTime;
            const eTime = rec.eTime;
            if (cellTime >= sTime && cellTime <= eTime) {
                typeClass = 'is-period';

                isActualPeriod = true;
                break;
                   }
        }
        // 2. 根据真实记录预测未来的经期和易孕期
        if (!isActualPeriod && optimizedRecords.length > 0) {
            const latestRec = optimizedRecords[0];
            const sTime = latestRec.sTime;
            const diffDays = Math.floor((cellTime - sTime) / PERIOD_DAY_MS);
            if (diffDays > 0) {

                const cycleDay = diffDays % cycle;
                if (cycleDay < duration) {
                    // ▼▼▼ 修改开始：判断如果本月已经有真实记录了，就不再在同月份显示预测 ▼▼▼
                    const latestDate = new Date(sTime);
                    if (latestDate.getFullYear() === year && latestDate.getMonth() === month) {
                        // 如果最新一次打卡就是在这个月，那本月多算出来的预测期就什么都不做，保持安全期底色
                    } else {
                        // 恢复经期预测，但使用专属的 'is-predicted' 类名以作颜色区分
                        typeClass = 'is-predicted';
                    }
                    // ▲▲▲ 修改结束 ▲▲▲
                  } else if (cycleDay >= cycle - 19 && cycleDay <= cycle - 10) {
                    typeClass = 'is-danger';
                }
            }
        }
        
        const isToday = cellDateStr === todayStr ? 'today' : '';
        const isSelected = cellDateStr === selectedCalDateStr ? 'selected' : '';
        
        htmlBuffer += `<div class="day-cell ${typeClass} ${isToday} ${isSelected}" data-date="${cellDateStr}" style="${isSelected ? 'border: 2px solid #D3A7A5;' : ''}"><span>${i}</span></div>`; // 修改

    }
    
    grid.innerHTML = htmlBuffer; // 新增：最后一次性注入 DOM，解决卡顿
    
    // 更新选中日期的显示文字
    const selectedDateObj = new Date(getLocalTime(selectedCalDateStr));

    const selDateElem = document.getElementById('selected-cal-date');
    if (selDateElem) selDateElem.innerText = `${selectedDateObj.getMonth() + 1}月${selectedDateObj.getDate()}日`;
    
    // 检查选中日期是否已经在经期内，用来切换“标记开始”和“标记结束”按钮
    let selectedIsPeriod = false;
    const selTime = getLocalTime(selectedCalDateStr);
    for (const rec of records) {
        const sTime = getLocalTime(rec.start);
        const eTime = rec.end ? getLocalTime(rec.end) : sTime + (duration-1)*PERIOD_DAY_MS;
        if (selTime >= sTime && selTime <= eTime) {
            selectedIsPeriod = true;
            break;
        }
    }
    const startBtn = document.getElementById('mark-period-start-btn');
    const endBtn = document.getElementById('mark-period-end-btn');
    const extendBtn = document.getElementById('extend-period-btn');
    const actionBtns = document.querySelector('.cal-action-btns');
    if (startBtn && endBtn) {
        const selTime = getLocalTime(selectedCalDateStr);
        const todayTime = getLocalTime(todayStr);
        
        // 拦截未来日期：不可打卡
        if (selTime > todayTime) {
            startBtn.style.opacity = '0.3';
            startBtn.style.pointerEvents = 'none';
            endBtn.style.opacity = '0.3';
            endBtn.style.pointerEvents = 'none';
        } else {
            startBtn.style.opacity = '1';
            startBtn.style.pointerEvents = 'auto';
            endBtn.style.opacity = '1';
            endBtn.style.pointerEvents = 'auto';
            if (selectedIsPeriod) {
                startBtn.style.display = 'block';
                startBtn.innerText = '撤销此记录';
                startBtn.classList.add('is-cancel'); // 用 class 控制样式
                startBtn.dataset.isCancel = 'true';
                endBtn.style.display = 'block';
            } else {
                startBtn.style.display = 'block';
                startBtn.innerText = '标记经期开始';
                startBtn.classList.remove('is-cancel'); // 移除撤销样式，恢复原样
                startBtn.dataset.isCancel = 'false';
                endBtn.style.display = 'none';
            }

        }
        if (actionBtns) actionBtns.classList.toggle('is-single-action', endBtn.style.display === 'none');

    }
    if (extendBtn) {
        const latestRec = records[0];
        if (latestRec) {
            const predictedEndTime = getLocalTime(getDefaultPeriodEnd(latestRec.start, duration));
            const extendWindowEnd = predictedEndTime + 5 * PERIOD_DAY_MS;
            const todayTime = getLocalTime(todayStr);
            const selectedIsToday = selectedCalDateStr === todayStr;
            const canExtendToday = selectedIsToday
                && todayTime > predictedEndTime
                && todayTime <= extendWindowEnd
                && latestRec.end !== todayStr;
            extendBtn.style.display = canExtendToday ? 'block' : 'none';
        } else {
            extendBtn.style.display = 'none';
        }
    }

    // ▼▼▼ 新增：控制症状区域是否可见并加载 ▼▼▼
    const symptomsSection = document.querySelector('.period-symptoms-section');
    if (symptomsSection) {
        symptomsSection.style.display = selectedIsPeriod ? 'block' : 'none';
        if (selectedIsPeriod && typeof loadAndRenderSymptoms === 'function') {
            loadAndRenderSymptoms(selectedCalDateStr);
        }
    }
    // 更新大圆环中心的信息
    const circleLabel = document.querySelector('.period-circle-content .status-label');
    const circleDays = document.querySelector('.period-circle-content .days-number');
    const circleRange = document.querySelector('.period-circle-content .date-range');
    
    if (circleLabel && circleDays && circleRange) {
        if (records.length > 0) {
            const latestRec = records[0];
            const sTime = getLocalTime(latestRec.start);
            const eTime = latestRec.end ? getLocalTime(latestRec.end) : sTime + (duration - 1) * PERIOD_DAY_MS;
            const todayTime = getLocalTime(todayStr);
            
            // 1. 判断今天是否在用户的【真实】记录覆盖范围内
            let isRealPeriod = false;
            if (todayTime >= sTime && todayTime <= eTime) {
                isRealPeriod = true;
            }

            if (isRealPeriod) {
                // 在真实的经期内，按实际打卡日推算
                const currentDay = Math.floor((todayTime - sTime) / PERIOD_DAY_MS) + 1;
                const daysLeft = duration - currentDay;
                
                circleLabel.innerText = '经期中';
                circleDays.innerText = `第 ${currentDay} 天`;
                circleRange.innerText = daysLeft <= 0 ? `预计今天结束` : `预计还剩 ${daysLeft} 天`;
            } else {
                // 不在真实的经期内（包括预测该来但用户还没打卡的情况）
                let nextStartTime = sTime;
                while (nextStartTime <= todayTime) {
                    nextStartTime += cycle * PERIOD_DAY_MS;
                }
                
                const diffDays = Math.floor((todayTime - sTime) / PERIOD_DAY_MS);
                let cycleDay = diffDays % cycle;
                if (cycleDay < 0) cycleDay += cycle;

                let statusText = '安全期';
                if (cycleDay >= cycle - 19 && cycleDay <= cycle - 10) {
                    statusText = '易孕期';
                }
                circleLabel.innerText = statusText;
                // 判断是否处于“预测该来了，但还没打卡”的延期状态
                if (diffDays >= cycle && cycleDay < duration) {
                    circleLabel.innerText = '请注意';
                    circleDays.innerText = cycleDay === 0 ? '预计今天开始' : `已延期 ${cycleDay} 天`;
                    circleRange.innerText = `请在来时及时标记`;
                } else {
                    const daysToNext = Math.floor((nextStartTime - todayTime) / PERIOD_DAY_MS);
                    circleDays.innerText = `距离下次 ${daysToNext} 天`;
                    const nextStartObj = new Date(nextStartTime);
                    const nextEndObj = new Date(nextStartTime + (duration - 1) * PERIOD_DAY_MS);
                    circleRange.innerText = `预计: ${nextStartObj.getMonth()+1}.${nextStartObj.getDate()} - ${nextEndObj.getMonth()+1}.${nextEndObj.getDate()}`;
                }
            }

            // ▼▼▼ 新增：根据当前状态更新每日健康贴士 ▼▼▼
            let tipText = '记得多喝热水，注意规律作息哦。';
            if (isRealPeriod) {
                tipText = '经期中，要注意保暖，尽量避免剧烈运动和冷饮。';
            } else if (circleLabel.innerText === '易孕期') {
                tipText = '当前处于易孕期，记得注意个人卫生与防护哦。';
            } else if (circleLabel.innerText === '请注意') {
                tipText = '姨妈好像有点迟到，保持好心情，不要太焦虑~';
            } else {
                tipText = '安全期，状态正好，去享受美好的一天吧！';
            }
            const tipEl = document.getElementById('period-daily-tip-text');
            if (tipEl) tipEl.innerText = tipText;
            // ▲▲▲ 新增结束 ▲▲▲

        } else {

            circleLabel.innerText = '暂无记录';
            circleDays.innerText = '请先标记开始';
            circleRange.innerText = '--';
        }
    }
}

// ▼▼▼ 新增：症状记录渲染与数据轻量化加载 ▼▼▼
async function loadAndRenderSymptoms(dateStr) {
    const data = await loadCSData('period_symptoms') || {};
     // 默认空状态
    const todayData = data[dateStr] || { pain: 0, flow: 1, mood: 0, physical: [] };
    
    const pillRows = document.querySelectorAll('.symptom-pill-row');
    const grids = document.querySelectorAll('.symptoms-grid');

    // 渲染痛感
    if (pillRows[0]) pillRows[0].querySelectorAll('.symptom-pill').forEach((el, i) => {
        el.classList.toggle('active', i === todayData.pain);
    });
    // 渲染血量
    if (pillRows[1]) pillRows[1].querySelectorAll('.symptom-pill').forEach((el, i) => {
        el.classList.toggle('active', i === todayData.flow);
    });
    // 渲染心情
    if (grids[0]) grids[0].querySelectorAll('.symptom-item').forEach((el, i) => {
        el.classList.toggle('active', i === todayData.mood);
    });
    // 渲染身体状态 (多选)
    if (grids[1]) grids[1].querySelectorAll('.symptom-item').forEach((el, i) => {
        el.classList.toggle('active', (todayData.physical || []).includes(i));
    });
}

function collectPeriodSymptomsFromSection(section) {
    if (!section) return { pain: 0, flow: 1, mood: 0, physical: [] };
    const rows = section.querySelectorAll('.symptom-pill-row');
    const grids = section.querySelectorAll('.symptoms-grid');
    const painIdx = rows[0] ? Array.from(rows[0].querySelectorAll('.symptom-pill')).findIndex(c => c.classList.contains('active')) : 0;
    const flowIdx = rows[1] ? Array.from(rows[1].querySelectorAll('.symptom-pill')).findIndex(c => c.classList.contains('active')) : 1;
    const moodIdx = grids[0] ? Array.from(grids[0].querySelectorAll('.symptom-item')).findIndex(c => c.classList.contains('active')) : 0;
    const physArr = [];
    if (grids[1]) {
        grids[1].querySelectorAll('.symptom-item').forEach((c, i) => {
            if (c.classList.contains('active')) physArr.push(i);
        });
    }
    return {
        pain: Math.max(0, painIdx),
        flow: Math.max(0, flowIdx),
        mood: Math.max(0, moodIdx),
        physical: physArr
    };
}

async function writePeriodAiHiddenMessage(memoryPrompt) {
    if (!memoryPrompt || !db?.chatMessages) return;
    const chatId = tempState.currentChatId;
    if (!chatId) return;
    const charObj = AppState.characterProfiles?.find(c => c.id === chatId);
    if (charObj && charObj.periodPerceptionEnabled === false) return;

    const messageData = {
        chatId,
        timestamp: new Date(),
        text: memoryPrompt,
        type: 'sent',
        uiVisible: false,
        aiVisible: true,
        recalled: false
    };

    try {
        const msgId = await db.chatMessages.add(messageData);
        const newMsg = await db.chatMessages.get(msgId);
        if (AppState.currentChatHistory) AppState.currentChatHistory.push(newMsg || { ...messageData, id: msgId });
    } catch (error) {
        console.warn('[CoupleSpace] period hidden message write failed:', error);
    }
}

function buildPeriodSymptomMemoryPrompt(dateStr, symptomData) {
    if (!dateStr || !symptomData) return '';
    const painText = PERIOD_PAIN_LABELS[symptomData.pain] || PERIOD_PAIN_LABELS[0];
    const flowText = PERIOD_FLOW_LABELS[symptomData.flow] || PERIOD_FLOW_LABELS[1];
    const moodText = PERIOD_MOOD_LABELS[symptomData.mood] || PERIOD_MOOD_LABELS[0];
    const physicalText = (Array.isArray(symptomData.physical) ? symptomData.physical : [])
        .map(index => PERIOD_PHYSICAL_LABELS[index])
        .filter(Boolean)
        .join('、');
    const parts = [`痛感“${painText}”`, `血量“${flowText}”`, `心情“${moodText}”`];
    if (physicalText) parts.push(`身体“${physicalText}”`);

    const isTodaySymptom = dateStr === getTodayPeriodDate();
    return isTodaySymptom
        ? `<[系统隐式提示：用户刚刚记录了她【今天】的生理期症状：${parts.join('，')}。核心指令：这是她此刻自己记录的身体和情绪状态，请在接下来的聊天里自然参考，绝不要复读本提示。]>`
        : `<[系统隐式提示：用户刚刚补录了她【过去】（${dateStr}）的生理期症状：${parts.join('，')}。核心指令：这是过去的补录，她现在并不一定有这些症状！仅作为健康记忆保存，绝对不要对她进行实时安慰或关怀，绝不要复读本提示！]>`;
}
// ▼▼▼ 新增：心情日历渲染与处理引擎 ▼▼▼
let currentMoodCalDate = new Date();
const moodIcons = {
    happy: '<svg viewBox="0 0 24 24" fill="none" stroke="#E28F8F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><path d="M9 9h.01"></path><path d="M15 9h.01"></path></svg>',
    sad: '<svg viewBox="0 0 24 24" fill="none" stroke="#9AA0B8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M16 16s-1.5-2-4-2-4 2-4 2"></path><path d="M9 9h.01"></path><path d="M15 9h.01"></path></svg>',
    angry: '<svg viewBox="0 0 24 24" fill="none" stroke="#D3A7A5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M16 16s-1.5-2-4-2-4 2-4 2"></path><path d="M7 9l2 1"></path><path d="M17 9l-2 1"></path><path d="M9 10h.01"></path><path d="M15 10h.01"></path></svg>',
    peace: '<svg viewBox="0 0 24 24" fill="none" stroke="#9CB4A1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="8" y1="15" x2="16" y2="15"></line><path d="M9 9h.01"></path><path d="M15 9h.01"></path></svg>',
    tired: '<svg viewBox="0 0 24 24" fill="none" stroke="#B5ACA3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 15h8"></path><path d="M8 9l2 1-2 1"></path><path d="M16 9l-2 1 2 1"></path></svg>',
    love: '<svg viewBox="0 0 24 24" fill="none" stroke="#E28F8F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>',
    default: '<svg viewBox="0 0 24 24" fill="none" stroke="#EBE4DF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 15h8"></path><path d="M9 9h.01"></path><path d="M15 9h.01"></path></svg>'
};
async function renderMoodCalendar(charId, date) {
    const grid = document.getElementById('mood-calendar-grid');
    const title = document.getElementById('mood-cal-month');
    if (!grid || !title) return;
    
    const year = date.getFullYear();
    const month = date.getMonth();
    title.innerText = `${year}年 ${month + 1}月`;
    
    let records = await loadCSData('mood_records_' + charId) || {};
    
    let htmlBuffer = '';
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    
    for (let i = 0; i < firstDay; i++) {
        htmlBuffer += `<div class="day-cell empty"></div>`;
    }
    
    const pad = n => n < 10 ? '0'+n : n;
    const todayStr = (() => { const d=new Date(); const tz=d.getTimezoneOffset()*60000; return new Date(d-tz).toISOString().split('T')[0];})();
    
    for (let i = 1; i <= daysInMonth; i++) {
        const cellDateStr = `${year}-${pad(month + 1)}-${pad(i)}`;
        const isToday = cellDateStr === todayStr ? 'today' : '';
        const dayRecord = records[cellDateStr] || {};
        
        const myMoodSvg = dayRecord.user ? moodIcons[dayRecord.user] : '';
        const taMoodSvg = dayRecord.char ? moodIcons[dayRecord.char] : '';
        
        htmlBuffer += `
        <div class="day-cell ${isToday}">
            <span class="date-num">${i}</span>
            <div class="mood-icons-wrapper">
                <div class="m-icon my">${myMoodSvg}</div>
                <div class="m-icon ta">${taMoodSvg}</div>
            </div>
        </div>`;
    }
    
    grid.innerHTML = htmlBuffer;
    
    // 更新今日心情展示区
    const todayRecord = records[todayStr] || {};
    const myCurrentMood = document.getElementById('my-current-mood');
    const charCurrentMood = document.getElementById('char-current-mood');
    const myMoodText = document.querySelector('#my-mood-selector .mood-text');
    const charMoodText = document.getElementById('char-mood-text');
    
    if (myCurrentMood) {
        myCurrentMood.innerHTML = todayRecord.user ? moodIcons[todayRecord.user] : moodIcons.default;
        myMoodText.innerText = todayRecord.user ? document.querySelector(`.mood-option[data-mood="${todayRecord.user}"]`)?.dataset.text || '已选' : '选个心情';
    }
    if (charCurrentMood) {
        charCurrentMood.innerHTML = todayRecord.char ? moodIcons[todayRecord.char] : moodIcons.default;
        charMoodText.innerText = todayRecord.char ? document.querySelector(`.mood-option[data-mood="${todayRecord.char}"]`)?.dataset.text || '已更新' : '等待中...';
    }
    
    // 更新头像和名字
    const char = AppState.characterProfiles?.find(c => c.id === charId) || {name: 'Ta'};
    const currentUser = getCurrentChatIdentity(charId) || { avatar: 'images/default-avatar.svg' };
    const myAvatar = document.getElementById('mood-my-avatar');
    const charAvatar = document.getElementById('mood-char-avatar');
    const charName = document.getElementById('mood-char-name');
    
    if (myAvatar) myAvatar.src = char.chatOverrideUserAvatar || currentUser.avatar || DEFAULT_AVATAR_SRC || 'images/default-avatar.svg';
    if (charAvatar) charAvatar.src = char.chatOverrideAvatar || char.avatar || DEFAULT_AVATAR_SRC || 'images/default-avatar.svg';
    if (charName) charName.innerText = char.chatOverrideName || char.name;
}
// ▼▼▼ 新增：历史经期与规律智能分析 ▼▼▼
async function analyzePeriodHistory() {
    return refreshPeriodStatisticsPage();
    const records = await loadCSData('period_records') || [];
    const settings = await loadCSData('period_settings') || { duration: 5, cycle: 28 };
    const listContainer = document.getElementById('period-history-list');
    const suggestContainer = document.getElementById('period-analysis-suggestion');
    if (!listContainer || !suggestContainer) return;
    
    if (records.length === 0) {
        listContainer.innerHTML = '<p style="font-size:12px;color:#999;text-align:center;">暂无记录</p>';
        suggestContainer.style.display = 'none';
        return;
    }
    
    // 倒序排列渲染历史
    const sorted = [...records].sort((a,b)=>getLocalTime(b.start)-getLocalTime(a.start));
    let html = '';
    let cycles = [];
    let durations = [];
    
    for (let i = 0; i < sorted.length; i++) {
        const rec = sorted[i];
        let durationText = '--';
        let cycleText = '--';
        
        if (rec.end) {
            const d = Math.round((getLocalTime(rec.end) - getLocalTime(rec.start)) / 86400000) + 1;
            durationText = d + '天';
            durations.push(d);
        }
        
        if (i < sorted.length - 1) {
            const prevRec = sorted[i+1];
            const c = Math.round((getLocalTime(rec.start) - getLocalTime(prevRec.start)) / 86400000);
            cycleText = c + '天';
            cycles.push(c);
        }
        
        html += `<div style="display:flex; justify-content:space-between; font-size:12px; padding:8px 0; border-bottom:1px dashed #EBE4DD; color: #5C544D;">
            <span>${rec.start} ${rec.end ? `至 ${rec.end}` : '至今'}</span>
            <span style="color:#D3A7A5; font-weight: bold;">周期 ${cycleText} / 经期 ${durationText}</span>
        </div>`;
    }
    listContainer.innerHTML = html;
    
    // 如果有3次以上的间隔（也就是4条记录），就进行AI规律计算
    if (cycles.length >= 3 && durations.length >= 3) {
        const avgCycle = Math.round(cycles.reduce((a,b)=>a+b,0)/cycles.length);
        const avgDur = Math.round(durations.reduce((a,b)=>a+b,0)/durations.length);
        
        const setCycle = parseInt(settings.cycle);
        const setDur = parseInt(settings.duration);
        
        // 发现规律偏差较大，提示更改
        if (Math.abs(avgCycle - setCycle) > 2 || Math.abs(avgDur - setDur) > 1) {
            suggestContainer.style.display = 'block';
            suggestContainer.innerHTML = `
                <div style="background:#FDE8E8; padding:12px; border-radius:12px; margin-top:15px; font-size:12px; color:#5C544D; line-height: 1.5;">
                    💡 <b>分析建议：</b><br>
                    根据记录，您的平均周期为 <b>${avgCycle}天</b>，平均经期为 <b>${avgDur}天</b>。是否更新设定以获得更准的预测？
                    <button id="apply-period-suggestion-btn" data-cycle="${avgCycle}" data-dur="${avgDur}" style="margin-top:8px; width: 100%; background:#D3A7A5; color:#fff; border:none; padding:6px 0; border-radius:12px; font-size:12px; cursor:pointer; font-weight: bold;">一键更新设定</button>
                </div>
            `;
        } else {
            suggestContainer.style.display = 'none';
        }
    } else {
        suggestContainer.style.display = 'none';
    }
}

// ▼▼▼ 【新增】信箱渲染引擎 (负责从数据库读取信件并生成HTML) ▼▼▼
async function renderMailboxList(charId) {
    const listContainer = document.getElementById('rm-letter-list');
    if (!listContainer) return;
    
    let letters = await loadCSData('mailbox_letters_' + charId) || [];
    listContainer.innerHTML = ''; // 清空静态占位符
    
    if (letters.length === 0) {
        listContainer.innerHTML = `<div style="text-align:center; padding:50px 20px; color:#A89D96; font-size:12px; font-style:italic;">信箱空空如也，提笔写下第一封信吧...</div>`;
        return;
    }
    // 按时间倒序排列 (最新的在最上面)
    // 按时间倒序排列 (最新的在最上面)
    letters.sort((a, b) => b.timestamp - a.timestamp);
    const char = AppState.characterProfiles?.find(c => c.id === charId) || {name: 'Ta'};
     const baseUser = getCurrentChatIdentity(charId) || {name: 'Me'}; // 使用统一身份获取
    const userName = char.chatOverrideUserNickname || baseUser.name;

    // ▼▼▼ 【极限性能保护】强制限制最多只渲染最近 50 封信，防止 DOM 节点爆炸导致苹果手机闪退 ▼▼▼
    const renderLimit = 50;
    const lettersToRender = letters.slice(0, renderLimit);

    let htmlBuffer = ''; // 采用和日历一样的字符串缓冲池
    lettersToRender.forEach(letter => {

        const isUser = letter.type === 'user';
        const dateObj = new Date(letter.timestamp);

        const dateStr = `${dateObj.getMonth() + 1}-${dateObj.getDate()}`; // 格式: 10-24
        
        const html = `
        <div class="rm-timeline-item ${isUser ? 'is-user' : ''}" data-id="${letter.timestamp}">
            <div class="rm-timeline-node">
                <div class="node-dot"></div>
                <div class="node-date">${dateStr}</div>
            </div>
            <div class="rm-real-envelope ${letter.isRead ? '' : 'unread'}">
                <div class="env-paper-inner"></div>
                <div class="env-front-cover"></div>
                <div class="env-flap-top"><div class="env-flap-deco"></div></div> 
                <div class="env-wax-seal" ${!isUser ? 'style="background:#C2B8B1;"' : ''}>
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                </div>
                <div class="env-decor-layer">
                    <div class="env-stamp" ${!isUser ? 'style="border-style: dotted;"' : ''}></div>
                    <div class="env-postmark" ${!isUser ? 'style="transform: rotate(15deg); left: -12px;"' : ''}></div>
                    <div class="env-text-area">
                     <span class="env-to">To: ${isUser ? char.name : userName}</span>
                    <span class="env-from">From: ${isUser ? userName : char.name}</span>
                    </div>
                </div>
            </div>
        </div>`;
        htmlBuffer += html;
    });
   if (letters.length > renderLimit) {
        htmlBuffer += `<div style="text-align:center; padding:20px; color:#A89D96; font-size:12px;">已折叠更早的 ${letters.length - renderLimit} 封信件以保证流畅</div>`;
    }
    listContainer.innerHTML = htmlBuffer; // 循环结束后一次性注入
}
// ▼▼▼ 【新增】多彩情绪板渲染引擎 (恢复图钉+随性排列) ▼▼▼

async function renderCorkboard(charId) {
    const mainBoard = document.querySelector('#cs-memo-trigger .board-content');
    const fullBoard = document.getElementById('rc-cork-board-full');
    
    let notes = await loadCSData('corkboard_notes_' + charId) || [];
    notes.sort((a, b) => b.timestamp - a.timestamp);
    
    // 恢复精致莫兰迪低饱和色系：奶咖、灰薄荷、雾霾粉、婴儿蓝、浅丁香
    const palettes = [
        { bg: '#FDFBF8', pin: '#D5C7BD', txt: '#6D635B' }, // 奶咖
        { bg: '#F1F5F2', pin: '#B8C9C0', txt: '#5A6B62' }, // 灰薄荷
        { bg: '#F8F2F3', pin: '#D4B8BE', txt: '#7A5C63' }, // 雾霾粉
        { bg: '#F2F5F8', pin: '#B9C6D3', txt: '#5C6A7A' }, // 婴儿蓝
        { bg: '#F0E8DF', pin: '#C4B2A5', txt: '#6D635B' }  // 浅燕麦
    ];

    const getColor = (timestamp) => palettes[timestamp % palettes.length];
    
    // 随性排列引擎：利用时间戳生成稳定的随机数，保证每次刷新位置不乱跳
    const getRandom = (seed) => {
        let x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    };
    if (mainBoard) {
        const topNotes = notes.slice(0, 4); 
        if (topNotes.length === 0) {
            mainBoard.innerHTML = `<div style="text-align:center; width:100%; padding:20px; color:#B5A8A0; font-size:12px; font-style:italic;">还没有情绪纸条，点击右上角添加吧...</div>`;
        } else {
            let mainBuffer = ''; // 新增：主板缓冲池
            topNotes.forEach((note, index) => {
                const c = getColor(note.timestamp);
                const rot = (getRandom(note.timestamp) * 8) - 4; 
                const tx = (getRandom(note.timestamp + 1) * 6) - 3; 
                const ty = (getRandom(note.timestamp + 2) * 10) - 5;
                
                mainBuffer += `
                <div class="note-paper style-rococo" style="background:${c.bg}; transform: translate(${tx}px, ${ty}px) rotate(${rot}deg);">
                    <div class="magnet-pin" style="background:${c.pin};"></div>
                    <p style="color:${c.txt}; margin:0;">${note.content}</p>
                </div>`;
            });
            mainBoard.innerHTML = mainBuffer; // 循环外一次性渲染
        }
    }
     if (fullBoard) {
        if (notes.length === 0) {
            fullBoard.innerHTML = `<div style="text-align:center; width:100%; padding:80px 20px; color:#B5A8A0; font-size:13px; font-style:italic; font-family: 'Georgia', serif;">Waiting for your memories...</div>`;
        } else {
            let fullBuffer = ''; // 新增：详情板缓冲池
            
            // ▼▼▼ 【极限性能保护】情绪板墙最多渲染 60 张，防止重叠渲染拖垮手机 GPU ▼▼▼
            const renderLimit = 60;
            const notesToRender = notes.slice(0, renderLimit);
            
            notesToRender.forEach((note, index) => {
                const c = getColor(note.timestamp);
                const rot = (getRandom(note.timestamp) * 14) - 7; 

                const tx = (getRandom(note.timestamp + 1) * 16) - 8; 
                const ty = (getRandom(note.timestamp + 2) * 24) - 12; 
                
                fullBuffer += `
                <div class="rc-note-paper" style="background:${c.bg}; transform: translate(${tx}px, ${ty}px) rotate(${rot}deg);">
                    <div class="rc-magnet-pin" style="background:${c.pin};"></div>
                    <p style="color:${c.txt}; margin:0;">${note.content}</p>
                    <button class="rc-note-del-btn" data-id="${note.timestamp}" style="color:${c.txt};">&times;</button>
                </div>`;
            });
            fullBoard.innerHTML = fullBuffer; // 循环外一次性渲染
        }
    }

}
// ▲▲▲ 新增结束 ▲▲▲
// ▼▼▼ 【新增】兑换券渲染引擎 ▼▼▼
async function renderCouponList(charId) {
    // 【修改】获取情侣空间和聊天面板双端的容器
    const myLists = [document.getElementById('cc-my-coupons-list'), document.getElementById('chat-my-coupons-list')].filter(Boolean);
    const taLists = [document.getElementById('cc-ta-coupons-list'), document.getElementById('chat-ta-coupons-list')].filter(Boolean);
    if (myLists.length === 0) return;

    let coupons = await loadCSData('couple_coupons_' + charId) || [];

    
    const renderCards = (list, isMy) => {
        let html = '';
         if (list.length === 0) {
            html = `
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:60px 20px; opacity:0.6;">
                <svg viewBox="0 0 24 24" fill="none" stroke="#D6C5B3" stroke-width="1.5" style="width:48px; height:48px; margin-bottom:15px;"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path><path d="M16 10h-6"></path><path d="M16 14h-6"></path></svg>
                <div style="color:#A89D96; font-size:12px; font-style:italic; font-family:'Georgia', serif;">No coupons yet...</div>
            </div>`;
        } else {
            list.forEach(c => {
                // 生成一个伪随机的序列号，增加真实感
                const serialNo = "NO." + (c.id || "000000").slice(-6);
                
                html += `
                <div class="cc-ticket-card">
                    <!-- 左侧存根 -->
                    <div class="ticket-stub">
                        <div class="stub-icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></div>
                        <span class="stub-text">VOUCHER</span>
                        <span class="stub-serial">${serialNo}</span>
                    </div>
                    
                    <!-- 撕纸分割线与上下打孔 -->
                    <div class="ticket-divider">
                        <div class="hole top"></div>
                        <div class="hole bottom"></div>
                    </div>

                    <!-- 右侧主票面 -->
                    <div class="ticket-main">
                        <!-- 背景水印图标 -->
                        <svg class="ticket-watermark" viewBox="0 0 24 24" fill="currentColor"><path d="M22 10V6a2 2 0 0 0-2-2H4c-1.1 0-1.99.89-1.99 2v4c1.1 0 1.99.9 1.99 2s-.89 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2s.9-2 2-2zm-2-1.46c-1.19.69-2 1.99-2 3.46s.81 2.77 2 3.46V18H4v-2.54c1.19-.69 2-1.99 2-3.46s-.81-2.77-2-3.46V6h16v2.54z"/></svg>
                        
                        <div class="ticket-info">
                            <span class="t-name" title="${c.name}">${c.name}</span>
                            <span class="t-desc">专属: ${isMy ? 'Me' : 'Ta'} • 永久有效</span>
                        </div>
                        
                        <div class="ticket-action">
                            <!-- 模拟条形码 -->
                            <div class="t-barcode"></div>
                            <button class="t-action-btn ${!isMy ? 'disabled' : ''}" data-id="${c.id}" ${!isMy ? 'disabled' : ''}>${isMy ? '撕下核销' : '待Ta核销'}</button>
                        </div>
                    </div>
                </div>`;
            });
        }

        return html;
    };
    const myCoupons = coupons.filter(c => c.target === 'user');
    const taCoupons = coupons.filter(c => c.target === 'char');
    const myHtml = renderCards(myCoupons, true);
    const taHtml = renderCards(taCoupons, false);

    myLists.forEach(el => el.innerHTML = myHtml);
    taLists.forEach(el => el.innerHTML = taHtml);
}
// ▲▲▲ 新增结束 ▲▲▲
// ▼▼▼ 【新增】纪念日渲染引擎 ▼▼▼
async function renderAnniversaryList(charId) {
    const container = document.getElementById('anniversary-list-container');
    if (!container) return;
    let list = await loadCSData('anniversary_' + charId) || [];
    
    if (list.length === 0) {
        container.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:60px 20px; opacity:0.6;">
                <svg viewBox="0 0 24 24" fill="none" stroke="#D6C5B3" stroke-width="1.5" style="width:48px; height:48px; margin-bottom:15px;"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
                <div style="color:#A89D96; font-size:12px; font-style:italic; font-family:'Georgia', serif;">还没有纪念日，点击右上角添加吧...</div>
            </div>`;
        return;
    }
    
    const now = new Date();
    list.forEach(item => {
        const itemDate = new Date(item.date);
        const diffTime = now.getTime() - itemDate.getTime();
        item.days = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    });
     list.sort((a, b) => b.days - a.days);
    
    // ▼▼▼ 获取卡片背景 ▼▼▼
    const cardBg = await loadCSData('anniv_card_bg');
    const cardStyleStr = cardBg ? `background-image: url(${cardBg}); background-size: cover; background-position: center; border:none;` : '';
    // ▲▲▲ ▲▲▲
    let html = '';
     list.forEach(item => {
        // ▼▼▼ 修改：优化文案，不再使用“倒计时”这种容易引起误会的词 ▼▼▼
        const absDays = Math.abs(item.days);
        const isFuture = item.days < 0;
        const statusText = isFuture ? '距今还有' : '距今已'; 
        
        let cycleBadge = '';
        if (item.cycle === 'yearly') cycleBadge = '<span class="cycle-badge">每年</span>';
        else if (item.cycle === 'monthly') cycleBadge = '<span class="cycle-badge">每月</span>';
        
        const descHtml = item.desc ? `<div class="anniv-desc">"${item.desc}"</div>` : '';
        // ▲▲▲ ▲▲▲
        
        // 随机产生一个微小的倾斜角度，模拟手工贴上去的相纸感觉
        const randomRot = (Math.random() * 2) - 1; // -1 到 1 度之间
        
        html += `
        <div class="anniv-card" style="transform: rotate(${randomRot}deg); ${cardStyleStr}">
            <div class="anniv-header">
                <!-- 修改：增加包裹层容纳周期标签 -->
                <div class="anniv-name-wrap">
                    <div class="anniv-name">${item.name}</div>
                    ${cycleBadge}
                </div>
                <div class="anniv-date">${item.date}</div>
            </div>
            ${descHtml}
            <div class="anniv-body">

                <div class="days-box">
                    <span class="status">${statusText}</span>
                    <div class="days-val">${absDays}<span>天</span></div>
                </div>
                <button class="anniv-del-btn" data-id="${item.id}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            </div>
        </div>`;
    });
    container.innerHTML = html;
}
// ▲▲▲ 新增结束 ▲▲▲

export const CoupleSpace = {
    updateAvatars() {
        // ▼▼▼ 【修复】如果从桌面直接进入没有选中角色，默认展示第一个角色 ▼▼▼
        if (!tempState.currentChatId && AppState.characterProfiles && AppState.characterProfiles.length > 0) {
            const firstChar = AppState.characterProfiles.find(c => !c.isGroup);
            if (firstChar) tempState.currentChatId = firstChar.id;
        }
        const charId = tempState.currentChatId;


        // 增加可选链防报错
        const char = AppState.characterProfiles?.find(c => c.id === charId);
        if (!char) return;
        
        const userAvatarEl = document.querySelector('.cs-hero-profile .user-avatar');
        const charAvatarEl = document.querySelector('.cs-hero-profile .char-avatar');
        
        // ▼▼▼ 【修复】增加终极默认图片兜底，防止变量丢失导致空白 ▼▼▼
        if (charAvatarEl) {
            charAvatarEl.src = char.chatOverrideAvatar || char.avatar || DEFAULT_AVATAR_SRC || 'images/default-avatar.svg';
        }
        if (userAvatarEl) {
            const currentUser = getCurrentChatIdentity(charId) || { avatar: 'images/default-avatar.svg' };
            userAvatarEl.src = char.chatOverrideUserAvatar || currentUser.avatar || DEFAULT_AVATAR_SRC || 'images/default-avatar.svg';
        }
    },
 /* 修改处前两行 */
        // ▼▼▼ 新增：抽取独立的页面数据加载方法，绑定当前角色ID ▼▼▼
         loadPageData() {
            // ▼▼▼ 【修复】同步防呆机制，确保信箱和动态数据能正常加载 ▼▼▼
            if (!tempState.currentChatId && AppState.characterProfiles && AppState.characterProfiles.length > 0) {
                const firstChar = AppState.characterProfiles.find(c => !c.isGroup);
                if (firstChar) tempState.currentChatId = firstChar.id;
         }
        const charId = tempState.currentChatId;

        if (!charId) {
            // ▼▼▼ 新增：数据库无角色时强制拦截，退回主界面，防止出现异常空页面 ▼▼▼
            if (typeof window.showDynamicIsland !== 'undefined') window.showDynamicIsland('请先在通讯录添加一个角色', 'warning');
            document.querySelectorAll('.app-page').forEach(p => { p.style.display = 'none'; p.classList.remove('active'); });
            const homeWrapper = document.getElementById('home-screen-wrapper');
            if (homeWrapper) homeWrapper.style.display = 'flex';
            return;
        }

        // ▼▼▼ 【新增】情侣空间解锁状态拦截 ▼▼▼
        const inviteView = document.getElementById('cs-invite-view');
            loadCSData('cs_unlocked_' + charId).then(statusObj => {
                if (!statusObj || !statusObj.unlocked) {
                    // 未解锁，显示遮罩，拦截一切内部数据加载
                    if (inviteView) {
                        inviteView.style.display = 'flex';
                        
                        const char = AppState.characterProfiles?.find(c => c.id === charId);
                        const currentUser = getCurrentChatIdentity(charId) || { avatar: 'images/default-avatar.svg' };
                        const inviteUserAvatar = document.getElementById('invite-user-avatar');
                        const inviteCharAvatar = document.getElementById('invite-char-avatar');
                        if (inviteUserAvatar && char) inviteUserAvatar.src = char.chatOverrideUserAvatar || currentUser.avatar || DEFAULT_AVATAR_SRC || 'images/default-avatar.svg';
                        if (inviteCharAvatar && char) inviteCharAvatar.src = char.chatOverrideAvatar || char.avatar || DEFAULT_AVATAR_SRC || 'images/default-avatar.svg';

                        const btnSend = document.getElementById('btn-send-space-invite');
                        const btnRevoke = document.getElementById('btn-revoke-space-invite');
                        const statusHint = document.getElementById('invite-status-text');
                        if (statusObj && statusObj.pending) {
                            const isAiInvite = statusObj.pendingDirection === 'ai_to_user';
                            if (btnSend) btnSend.style.display = 'none';
                            if (btnRevoke) btnRevoke.style.display = isAiInvite ? 'none' : 'block';
                            if (statusHint) {
                                statusHint.innerText = isAiInvite ? 'Ta 发来了邀请，请回聊天里接受或婉拒。' : '已发送邀请，等待 Ta 的回应...';
                                statusHint.style.display = 'block';
                            }
                        } else {
                            if (btnSend) { btnSend.style.display = 'block'; btnSend.disabled = false; btnSend.innerText = '发送空间邀请'; }
                            if (btnRevoke) btnRevoke.style.display = 'none';
                            if (statusHint) {
                                statusHint.innerText = '已发送邀请，等待 Ta 的回应...';
                                statusHint.style.display = 'none';
                            }
                        }
                    }
                    return; // 终止后续一切空间数据的隐私渲染
                } 
                // 已解锁，隐藏遮罩，正常进入空间
                if (inviteView) inviteView.style.display = 'none';
                const annivEl = document.querySelector('.couple-space-page .cs-scroll-content .cs-hero-profile .hero-anniversary');
                  if (annivEl) {
                    // 优先从超轻量的专用数据库直接拿时间（耗时不到 1 毫秒）
                    let unlockTime = statusObj.timestamp || statusObj.unlockTime;
                    
                    // ▼▼▼ 【核心修改】：重构天数渲染逻辑，支持点击修改相恋日期 ▼▼▼
                    annivEl.style.position = 'relative'; // 确保内部绝对定位的输入框不会溢出
                    const renderDays = (time) => {
                        const startDate = new Date(time);
                        startDate.setHours(0, 0, 0, 0);
                        const today = new Date();
                        today.setHours(0, 0, 0, 0);
                        const days = Math.round((today.getTime() - startDate.getTime()) / 86400000) + 1;
                        
                        // 抹平时区差异，保证弹出的系统日历默认选中正确的本地日期
                        const localDateStr = new Date(time - new Date().getTimezoneOffset() * 60000).toISOString().split('T')[0];
                        
                        // 完美恢复原本的 span 结构，并加入一个隐形的日期选择器和小铅笔图标
                        annivEl.innerHTML = `
                            <span class="label">相恋第</span>
                            <span class="days" style="padding: 0 6px;">${days}</span>
                            <span class="label">天</span>
                            <svg style="width:14px; height:14px; margin-left:4px; color:#A3958F; flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                            <input type="date" class="cs-anniv-date-picker" style="position:absolute; opacity:0; width:100%; height:100%; top:0; left:0; cursor:pointer;" value="${localDateStr}">
                        `;
                        
                        // 监听用户选择新日期
                        const picker = annivEl.querySelector('.cs-anniv-date-picker');
                        picker.onchange = (e) => {
                            if(e.target.value) {
                                // 保存用户设定的新日期时间戳到数据库
                                statusObj.unlockTime = new Date(e.target.value).getTime();
                                saveCSData('cs_unlocked_' + charId, statusObj).then(() => {
                                    CoupleSpace.loadPageData(); // 重新计算并渲染页面
                                    if (typeof showDynamicIsland === 'function') showDynamicIsland('相恋起始日已更新', 'success');
                                });
                            }
                        };
                    };

                    if (unlockTime) {
                        renderDays(unlockTime);
                    } else {
                        // 如果连聊天记录都找不到，使用当前时间并初始化
                        (async () => {
                            try {
                                const { db } = await import('../state.js');
                                const targetMsg = await db.chatMessages.where('chatId').equals(charId).reverse().filter(m => m.contentType === 'space_invite' && m.inviteStatus === 'accepted').first(); 
                                unlockTime = targetMsg ? new Date(targetMsg.timestamp).getTime() : Date.now();
                            } catch (e) {
                                unlockTime = Date.now();
                            }
                            statusObj.unlockTime = unlockTime;
                            saveCSData('cs_unlocked_' + charId, statusObj);
                            renderDays(unlockTime);
                        })();
                    }
                    // ▲▲▲ 修改结束 ▲▲▲
                }

                // ▼▼▼ 【新增】强制重置约法三章的编辑状态... (这行是你原本的代码，保留着别动) ▼▼▼

                const rulesEditPanel = document.getElementById('cs-rules-edit-panel');

                const rulesDisplayPanel = document.getElementById('cs-rules-display');

            if (rulesEditPanel && rulesDisplayPanel) {
                // 1. 强行关闭编辑面板，显示文字面板
                rulesEditPanel.style.display = 'none';
                rulesDisplayPanel.style.display = 'block';
                
                // 2. 恢复底部按钮的默认状态
                const btnTa = document.getElementById('cs-rules-show-ta-btn-inline');
                if (btnTa) {
                    btnTa.innerText = '给 Ta 看';
                    btnTa.disabled = false;
                }
            // 3. 隐藏可能遗留的第四条输入框，防止覆盖新角色的视图
            const aiRule4Container = document.getElementById('ai-correction-4');
            if (aiRule4Container) aiRule4Container.style.display = 'none';
        }
        // ▲▲▲ 新增结束 ▲▲▲

        // 1. 判断是否开启共享，并加载题库与卡片状态隔离
        loadCSData('qa_share_enabled').then(isShared => {
            const toggle = document.getElementById('qa-share-toggle');
            if (toggle) toggle.checked = !!isShared;
            
            // 开启了共享就读全局题库，否则读角色专属题库
            const poolKey = isShared ? 'qa_pool_global' : 'qa_pool_' + charId;

            loadCSData(poolKey).then(savedQA => {
                const container = document.getElementById('qa-list-container');
                const finalQA = (savedQA && Array.isArray(savedQA) && savedQA.length > 0) ? savedQA : 
                    ["如果变成动物，对方是？", "最喜欢对方身上的什么味道？", "对方做过最让你感动的一件事？", "第一次见面时，对方穿了什么衣服？"];

                if (container) {
                    container.innerHTML = ''; 
                    finalQA.forEach(text => {
                        const div = document.createElement('div');
                        div.className = 'qa-item';
                        div.innerHTML = `<span>${text}</span><button class="del-btn" onclick="this.parentElement.remove()">&times;</button>`;
                        container.appendChild(div);
                    });
                }

                // ▼▼▼ 重置当前角色的卡片UI，并结合防重机制抽取题目 ▼▼▼
                const flipCard = document.getElementById('cs-daily-card');
                const questionText = document.querySelector('.cs-flip-card-front .question-text');
                const inputLine = document.getElementById('cs-daily-answer');
                
                if (flipCard && questionText && inputLine) {
                    // 强行把卡片翻回正面，清空旧数据
                    flipCard.classList.remove('flipped');
                    inputLine.value = '';
                    document.getElementById('cs-daily-user-ans').innerText = '';
                    document.getElementById('cs-daily-char-ans').innerText = '正在书写...';
                    document.getElementById('cs-daily-comment').innerText = '...';

                    // 读取该角色的卡片进度
                    loadCSData('qa_card_state_' + charId).then(cardState => {
                        // 如果今天已经抽过题，保持今天的题目
                        if (cardState && cardState.date === new Date().toDateString()) {
                            questionText.innerText = cardState.question;
                            // 如果今天已经答过了，直接翻过去显示答案
                            if (cardState.answered) {
                                inputLine.value = cardState.userAns;
                                document.getElementById('cs-daily-user-ans').innerText = cardState.userAns;
                                document.getElementById('cs-daily-char-ans').innerText = cardState.charAns;
                                document.getElementById('cs-daily-comment').innerText = cardState.comment;
                                flipCard.classList.add('flipped');
                            }
                        } else {
                            // 今天没抽过，从题库中结合防重复逻辑抽新题
                            loadCSData('qa_history_' + charId).then(history => {
                                let recentQs = history || [];
                                let availableQs = finalQA.filter(q => !recentQs.includes(q));
                                if (availableQs.length === 0) availableQs = finalQA; // 兜底：如果全抽过了，就重新放开
                                
                                let newQ = availableQs[Math.floor(Math.random() * availableQs.length)];
                                questionText.innerText = newQ;
                                // 暂存今天的新题目
                                saveCSData('qa_card_state_' + charId, { date: new Date().toDateString(), question: newQ, answered: false });
                            });
                        }
                    });
                }
            });
        });
        // 2. 加载此角色的专属约法三章 (修复第四条不显示的Bug)
           loadCSData('journal_rules_' + charId).then(savedRules => {
                const displayPanel = document.getElementById('cs-rules-display');
                if (displayPanel) {
                    const rules = (savedRules && savedRules.length > 0) ? savedRules : [];
                   displayPanel.innerHTML = '';
                    if (rules.length === 0) {
                        displayPanel.innerHTML = '<li style="color:#B5A8A0; font-style:italic; font-size:12px; list-style:none; text-align:center; padding:15px 0;">还没有约定，点击右上角铅笔开始书写...</li>';
                    } else {
                        rules.forEach((text, index) => {
                            const li = document.createElement('li');
                            li.innerHTML = `<span class="num">${index + 1}</span>${text}`;
                            displayPanel.appendChild(li);
                        });
                    }
                }
            });

            // ▼▼▼ 【新增】强制绑定：每次切换角色时，在后台自动刷新属于该角色的私密信件 ▼▼▼
            renderMailboxList(charId);
            // ▼▼▼ 【新增】刷新情绪板数据 ▼▼▼
            renderCorkboard(charId);
            renderCouponList(charId);
            renderAnniversaryList(charId); // 【新增】预渲染纪念日数据
 /* 修改处前两行 */
            loadCSData('period_settings').then(settings => {
                if (settings) {
                    const durInput = document.getElementById('period-duration-input');
                    const cycInput = document.getElementById('period-cycle-input');
                    if (durInput) durInput.value = settings.duration;
                    if (cycInput) cycInput.value = settings.cycle;
                }
            });
            // ▲▲▲ 新增结束 ▲▲▲

            }); // ▼▼▼ 【新增】补上上面的 .then() 的大括号闭合 ▼▼▼
        },
        init() {
            const page = document.getElementById('page-couple-space');
/* 修改处后两行 */

            const rippleLayer = document.getElementById('cs-ripple-layer');
            const pingBtn = document.getElementById('cs-ping-btn');
            
            // ▼▼▼ 【新增】监听全局兑换券核销动画 ▼▼▼
            document.addEventListener('play_coupon_animation', () => {
                const animLayer = document.getElementById('global-coupon-anim-layer');
                if (animLayer) {
                    const stamp = animLayer.querySelector('.coupon-anim-stamp');
                    animLayer.style.display = 'flex';
                    void stamp.offsetWidth; // 强行重绘
                    stamp.style.transform = 'scale(1) rotate(-15deg)';
                    stamp.style.opacity = '1';
                    
                    setTimeout(() => {
                        stamp.style.transform = 'scale(0.8) rotate(-15deg)';
                        stamp.style.opacity = '0';
                        setTimeout(() => {
                            animLayer.style.display = 'none';
                            stamp.style.transform = 'scale(3) rotate(0deg)';
                        }, 400);
                    }, 1200); // 停留1.2秒后消失
                }
            });
            // ▼▼▼ 【新增】监听后台情绪贴刷新事件，实现实时更新 ▼▼▼
            document.addEventListener('refresh_corkboard', (e) => {
                if (e.detail && e.detail.charId === tempState.currentChatId) {
                    renderCorkboard(tempState.currentChatId); // 瞬间重绘，无需刷新页面
                }
            });
            // ▼▼▼ 【新增】初始化加载信箱背景与信纸底纹 ▼▼▼

            loadCSData('rm_bg_image').then(bg => {
                if (bg) {
                    const mailboxPage = document.querySelector('.rococo-mailbox-page');
                    if (mailboxPage) {
                        mailboxPage.style.backgroundImage = `url(${bg})`;
                        mailboxPage.style.backgroundSize = 'cover';
                        mailboxPage.style.backgroundPosition = 'center';
                    }
                }
            });
            loadCSData('rm_paper_image').then(bg => {
                if (bg) {
                    const paper = document.querySelector('.rm-real-paper');
                    if (paper) {
                        paper.style.backgroundImage = `url(${bg})`;
                        paper.style.backgroundSize = 'cover';
                        paper.style.backgroundPosition = 'center';
                    }
                }
            });

            // ▼▼▼ 【新增】初始化加载纪念日背景 ▼▼▼
            loadCSData('anniv_page_bg').then(bg => {
                const annivPage = document.querySelector('.rococo-anniversary-page');
                if (annivPage && bg) {
                    annivPage.style.backgroundImage = `url(${bg})`;
                    annivPage.style.backgroundSize = 'cover';
                    annivPage.style.backgroundPosition = 'center';
                }
            });
            // ▲▲▲ 新增结束 ▲▲▲
            // ▲▲▲ 新增结束 ▲▲▲

            const flipCard = document.getElementById('cs-daily-card');

            const submitDailyBtn = document.getElementById('cs-daily-submit');
        const avatarTrigger = document.getElementById('cs-avatar-group-trigger');
        const heroAvatars = document.getElementById('cs-hero-avatar-trigger');
        const inviteAvatarTrigger = document.getElementById('cs-invite-avatar-trigger');
        const placeholders = []; // 【修改】去掉了 mood 的占位防呆锁

        if (!page || !rippleLayer) return;
        // 新增：单例模式锁，彻底防止全局事件监听重复叠加导致卡顿
        if (this._isInitialized) return;
        this._isInitialized = true;

        // ▼▼▼ 修改开始：添加自动监听与轮询，解决状态和页面不立刻刷新的问题 ▼▼▼
        window.CoupleSpace = this; // 暴露给全局，方便外部直接调用
         let _wasPageActive = page.classList.contains('active') || page.style.display === 'flex';
        new MutationObserver((mutations) => {
            mutations.forEach(m => {
                if (m.attributeName === 'class' || m.attributeName === 'style') {
                    const _isActiveNow = page.classList.contains('active') || page.style.display === 'flex';
                    // 核心防烫机制：只有当页面由隐藏变为显示(刚切入)时，才加载庞大数据！
                    if (_isActiveNow && !_wasPageActive) {
                        this.updateAvatars(); // 【修复】每次切入情侣空间页面时，确保头像与当前角色同步
                        this.loadPageData();
                    }
                    _wasPageActive = _isActiveNow;
                }
            });
        }).observe(page, { attributes: true, attributeFilter: ['class', 'style'] });

        // 轮询：在等待对方同意的解锁页面，每1.5秒自动刷一下看同意了没
        setInterval(() => {
            const charId = tempState.currentChatId;
            const inviteView = document.getElementById('cs-invite-view');
            if (charId && inviteView && inviteView.style.display !== 'none') {
                loadCSData('cs_unlocked_' + charId).then(s => { if (s && s.unlocked) this.loadPageData(); });
            }
        }, 1500);
        // ▲▲▲ 修改结束 ▲▲▲

            // 初始化加载一次当前角色的数据
            this.loadPageData();

            // 美化配色是全局共享的，不加ID后缀

            loadCSData('colors_config').then(savedColors => {
                if (savedColors) {

                    Object.keys(savedColors).forEach(id => {

                    const picker = document.getElementById(id);
                    if (picker) {
                        picker.value = savedColors[id];
                        // 恢复颜色时，手动触发对 Q版微缩图 的样式更新
                        if (id === 'cr-num-txt' || id === 'cf-btn-bg' || id === 'cm-icon' || id === 'cb-pin') {
                            picker.closest('.cs-mini-item').style.setProperty('--theme-color', savedColors[id]);
                        }
                        if (id.startsWith('ct-bg-')) {
                            picker.closest('.cs-mini-item').querySelectorAll('.m-t-item')[id.split('-')[2]-1].style.setProperty('--t-bg', savedColors[id]);
                        }
                        if (id.startsWith('ct-ic-')) {
                            picker.closest('.cs-mini-item').querySelectorAll('.m-t-item')[id.split('-')[2]-1].style.setProperty('--t-ic', savedColors[id]);
                        }
                    }
                });
                if (typeof updateAllComponentsCSS === 'function') updateAllComponentsCSS();
            }
        });
        // --- ▲▲▲ 新增结束 ▲▲▲ ---

        // 2. Ping 按钮
        if (pingBtn) {
            pingBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // 阻止波纹
                showDynamicIsland('✨ 已向 Ta 发送戳一戳', 'success');
            });
        }
        // --- ▼▼▼ 【新增】卡片点击刷新逻辑 ▼▼▼ ---
        const refreshBtn = document.getElementById('cs-daily-refresh-btn');
        if (refreshBtn && flipCard) {
            refreshBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // 阻止波纹
                const questionText = flipCard.querySelector('.question-text');
                if (!questionText) return;
                
                // 从题库界面实时获取当前问题列表
                const customItems = document.querySelectorAll('#qa-list-container .qa-item span');
                let pool = customItems.length > 0 ? Array.from(customItems).map(el => el.innerText) : ["如果变成动物，对方是？", "最喜欢对方身上的什么味道？", "对方做过最让你感动的一件事？"];
                
                const charId = tempState.currentChatId;
                
                // 拉取这个人的历史做防重过滤
                loadCSData('qa_history_' + charId).then(history => {
                    let recentQs = history || [];
                    // 过滤掉最近问过的，也过滤掉当前显示的
                    let availableQs = pool.filter(q => !recentQs.includes(q) && q !== questionText.innerText);
                    if (availableQs.length === 0) availableQs = pool.filter(q => q !== questionText.innerText); // 兜底
                    if (availableQs.length === 0) availableQs = pool;
                    
                    let newQ = availableQs[Math.floor(Math.random() * availableQs.length)];
                    
                    questionText.style.opacity = 0;
                    setTimeout(() => {
                        questionText.innerText = newQ;
                        questionText.style.opacity = 1;
                        // 更新当天存下来的题目
                        saveCSData('qa_card_state_' + charId, { date: new Date().toDateString(), question: newQ, answered: false });
                    }, 200);
                });
            });
        }
        // --- ▲▲▲ 新增结束 ▲▲▲ ---
         // 3. 翻转卡片
        if (submitDailyBtn) {
            // 【修改点1】这里必须加上 async，让它支持异步等待 AI 返回
            submitDailyBtn.addEventListener('click', async (e) => {

                e.stopPropagation();
                const input = document.getElementById('cs-daily-answer');
                const questionText = flipCard.querySelector('.question-text').innerText;
                const userAnsText = input.value.trim();
                if (!userAnsText) return showDynamicIsland('请先写下答案哦');
                
                document.getElementById('cs-daily-user-ans').innerText = userAnsText;
                
                // 【修改点2】先在卡片背面显示正在思考，然后再翻转
                document.getElementById('cs-daily-char-ans').innerText = 'Ta 正在思考...';
                document.getElementById('cs-daily-comment').innerText = '...';
                flipCard.classList.add('flipped');

                const charId = tempState.currentChatId;

                // 将题目加入该角色的防重复历史缓存中 (最多存7个)
                loadCSData('qa_history_' + charId).then(history => {
                    let recentQs = history || [];
                    recentQs.push(questionText);
                    if (recentQs.length > 7) recentQs.shift(); 
                    saveCSData('qa_history_' + charId, recentQs);
                });
                
                // ▼▼▼ 【核心修改】接入真实的 AI 接口 ▼▼▼
                try {
                    const { url, key, model } = AppState.apiCurrentSettings || {};
                    if (!url || !key) throw new Error("未配置 API地址或密钥");
                    // 1. 获取当前角色和用户的人设与记忆
                    const char = AppState.characterProfiles.find(c => c.id === charId) || {};
                    const currentUser = getCurrentChatIdentity(charId) || { name: 'User', persona: '未设置' }; // 使用统一身份获取
                     const userName = char.chatOverrideUserNickname || currentUser.name;
                    const { getMemoriesForPrompt } = await import('./memory.js').catch(() => ({ getMemoriesForPrompt: async () => '无历史记忆' }));
                    const { getWorldBookForPrompt } = await import('../state.js').catch(() => ({ getWorldBookForPrompt: async () => '无世界观设定' }));

                    const memoryContext = await getMemoriesForPrompt(charId);
                    const worldBookContext = await getWorldBookForPrompt(charId);

                    // 2. 构造请求给 AI 的专属剧本指令
                    const prompt = `[System Preamble]

**Part 1: The Actor's Script**
You are an actor playing the character ${char.name} in a long-form, collaborative chat role-play with ${userName}. Your goal is to create a deep, realistic, and emotionally resonant story together. You MUST embody this character completely.
*   **Identity**: You ARE ${char.name}. You are not an AI, assistant, or language model. Use "I" (我). Your knowledge, memories, emotions, and actions must strictly originate from ${char.name}'s character profile.
*   **Autonomy**: ${char.name} is a whole person with their own life, job, friends, and goals. Your life does not revolve solely around ${userName}.
*   **Emotional Realism & Respect**: Treat {{user}} as an equal, independent human being, NOT a possession or object (unless strictly dictated by the persona). Emotional shifts MUST be gradual with logical build-up; absolutely NO sudden, unearned extreme outbursts. As an adult, {{char}} is resilient, internalizes and reflects before reacting. Express deep affection through ACTIONS and SPECIFICS, never through cliché phrases.

**[NEW] Mandatory Behavioral & Stylistic Directives**
1.  **Embrace Human Imperfection**: Your thinking MUST be subjective. It can be biased, emotional, contradictory, or even hypocritical. Absolutely no objective analysis.
2.  **Instant Messaging (IM) Style - STRICTLY ENFORCED**: Short & Colloquial. Omit subjects frequently. Minimize full stops.
3.  **Core Attitude**: Equal, natural, and sincere. STRICTLY FORBIDDEN to be condescending, patronizing, or fatherly/bossy. 
---
<Character_Profile>
${char.persona || '未设置'}
</Character_Profile>
<Memory_Context>
${memoryContext}
</Memory_Context>
<World_Book>
${worldBookContext}
</World_Book>

[The Game]

Question: "${questionText}"
User (${userName}) answered: "${userAnsText}"

[Your Task]
1. Read the user's answer.
2. Provide your own answer (charAns) from your perspective. Keep it extremely short (under 15 words).
3. Provide a brief, in-character comment/reaction (comment) to the user's answer. Wrap it in quotes " ". Do not be an AI, act like a human partner.

[Output Format (JSON ONLY)]
{
  "charAns": "Your short answer here",
  "comment": "“Your brief reaction or flirt here”"
}`;

                    // 3. 发送请求给大模型
                    const response = await fetch(`${url.trim().replace(/\/$/, '')}/v1/chat/completions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                        body: JSON.stringify({
                            model: model,
                            messages: [{ role: 'user', content: prompt }],
                            temperature: 0.85
                        })
                    });

                    if (!response.ok) throw new Error(`API 状态异常: ${response.status}`);
                    const data = await response.json();
                    let rawContent = data.choices?.[0]?.message?.content;
                    if (!rawContent) throw new Error("AI 返回内容为空");

                    // 4. 清洗并解析 JSON
                    const aiResult = parseCoupleAiJson(rawContent);
                    if (!aiResult || typeof aiResult !== 'object' || Array.isArray(aiResult)) throw new Error("AI 未输出有效的 JSON 结构");
                    
                    const charAns = aiResult.charAns || '（无言以对）';
                    const comment = aiResult.comment || '“……”';
                    // 5. 替换卡片上的文字
                    document.getElementById('cs-daily-char-ans').innerText = charAns;
                    document.getElementById('cs-daily-comment').innerText = comment;
                    
                    // 6. ▼▼▼ 【新增】将此互动塞入聊天上下文作为隐式记忆，并固化数据 ▼▼▼
                    import('../state.js').then(async ({ db }) => {
                        if (!db) return;
                        const memoryPrompt = `<[系统隐式提示：刚才你和用户在情侣空间的“默契问答”里互动了。
问题是：“${questionText}”
用户的回答是：“${userAnsText}”
你的回答是：“${charAns}”，并且你对TA的回答作出了评价：“${comment}”。
核心指令：这是一个背景记忆，不要复读本提示，在接下来的聊天中如果合适，你可以非常自然地提及刚才的默契问答游戏。]>`;

                        const msgId = await db.chatMessages.add({
                            chatId: charId,
                            timestamp: new Date(),
                            text: memoryPrompt,
                            type: 'sent', 
                            uiVisible: false, 
                            aiVisible: true,  
                            recalled: false
                        });

                        saveCSData('qa_card_state_' + charId, { 
                            date: new Date().toDateString(), 
                            question: questionText, 
                            answered: true,
                            userAns: userAnsText,
                            charAns: charAns,
                            comment: comment,
                            memoryMsgId: msgId
                        });

                        const newMsg = await db.chatMessages.get(msgId);
                        if (AppState.currentChatHistory) AppState.currentChatHistory.push(newMsg);
                    });
                    // ▲▲▲ 新增结束 ▲▲▲

                } catch (err) {
                    console.error("[默契问答] AI 生成失败:", err);

                    // 发生网络或解析错误时，给个可爱的降级提示
                    document.getElementById('cs-daily-char-ans').innerText = '（脑电波掉线了）';
                    document.getElementById('cs-daily-comment').innerText = `“${err.message}”`;
                }
                 // ▲▲▲ 核心修改结束 ▲▲▲
            });
        }

        // --- ▼▼▼ 【新增】卡片背面“重新生成”与“记忆抹除”逻辑 ▼▼▼ ---
        const regenerateBtn = document.getElementById('cs-daily-regenerate-btn');
        if (regenerateBtn && flipCard) {
            regenerateBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                
                const questionText = flipCard.querySelector('.question-text').innerText;
                const userAnsText = document.getElementById('cs-daily-user-ans').innerText;
                const charId = tempState.currentChatId;
                 if (!userAnsText || !questionText) return;
                
                // ▼▼▼ 护栏 1：防抖锁。绝对禁止用户在 AI 思考时连点按钮导致的数据库踩踏错乱 ▼▼▼
                if (regenerateBtn.disabled) return;
                regenerateBtn.disabled = true;

                // 界面进入思考状态
                document.getElementById('cs-daily-char-ans').innerText = 'Ta 正在重新思考...';
                document.getElementById('cs-daily-comment').innerText = '...';

                    try {
                    const { url, key, model } = AppState.apiCurrentSettings || {};
                    if (!url || !key) throw new Error("未配置 API地址或密钥");
                    const char = AppState.characterProfiles.find(c => c.id === charId) || {};
                    const currentUser = getCurrentChatIdentity(charId) || { name: 'User', persona: '未设置' }; // 使用统一身份获取
                    const userName = char.chatOverrideUserNickname || currentUser.name;
                    // ▼▼▼ 护栏 2：用 await 把底层的异步状态全部转为同步阻塞，确保时序严丝合缝 ▼▼▼

                    const { getMemoriesForPrompt } = await import('./memory.js').catch(() => ({ getMemoriesForPrompt: async () => '无历史记忆' }));
                    const { getWorldBookForPrompt, db } = await import('../state.js').catch(() => ({ getWorldBookForPrompt: async () => '无世界观设定', db: null })); 
                    const memoryContext = await getMemoriesForPrompt(charId);
                    const worldBookContext = await getWorldBookForPrompt(charId);

                    const prompt = `[System Preamble]

**Part 1: The Actor's Script**
You are an actor playing the character ${char.name} in a long-form, collaborative chat role-play with ${currentUser.name}. Your goal is to create a deep, realistic, and emotionally resonant story together. You MUST embody this character completely.
*   **Identity**: You ARE ${char.name}. You are not an AI, assistant, or language model. Use "I" (我). Your knowledge, memories, emotions, and actions must strictly originate from ${char.name}'s character profile.
*   **Autonomy**: ${char.name} is a whole person with their own life, job, friends, and goals. Your life does not revolve solely around ${currentUser.name}.
*   **Emotional Realism & Respect**: Treat {{user}} as an equal, independent human being, NOT a possession or object (unless strictly dictated by the persona). Emotional shifts MUST be gradual with logical build-up; absolutely NO sudden, unearned extreme outbursts. As an adult, {{char}} is resilient, internalizes and reflects before reacting. Express deep affection through ACTIONS and SPECIFICS, never through cliché phrases.

**[NEW] Mandatory Behavioral & Stylistic Directives**
1.  **Embrace Human Imperfection**: Your thinking MUST be subjective. It can be biased, emotional, contradictory, or even hypocritical. Absolutely no objective analysis.
2.  **Instant Messaging (IM) Style - STRICTLY ENFORCED**: Short & Colloquial. Omit subjects frequently. Minimize full stops.
3.  **Core Attitude**: Equal, natural, and sincere. STRICTLY FORBIDDEN to be condescending, patronizing, or fatherly/bossy. 
---
<Character_Profile>
${char.persona || '未设置'}
</Character_Profile>
<Memory_Context>
${memoryContext}
</Memory_Context>
<World_Book>
${worldBookContext}
</World_Book>

[The Game]

Question: "${questionText}"
User (${currentUser.name}) answered: "${userAnsText}"

[Your Task]
1. Read the user's answer.
2. Provide your own answer (charAns) from your perspective. Keep it extremely short (under 15 words).
3. Provide a brief, in-character comment/reaction (comment) to the user's answer. Wrap it in quotes " ". Do not be an AI, act like a human partner.

[Output Format (JSON ONLY)]
{
  "charAns": "Your short answer here",
  "comment": "“Your brief reaction or flirt here”"
}`;

                    const response = await fetch(`${url.trim().replace(/\/$/, '')}/v1/chat/completions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                        body: JSON.stringify({
                            model: model,
                            messages: [{ role: 'user', content: prompt }],
                            temperature: 0.9
                        })
                    });

                    if (!response.ok) throw new Error(`API 状态异常: ${response.status}`);
                    const data = await response.json();
                    let rawContent = data.choices?.[0]?.message?.content;
                    if (!rawContent) throw new Error("AI 返回内容为空");

                    const aiResult = parseCoupleAiJson(rawContent);
                    if (!aiResult || typeof aiResult !== 'object' || Array.isArray(aiResult)) throw new Error("AI 未输出有效的 JSON 结构");
                    const charAns = aiResult.charAns || '（无言以对）';
                    const comment = aiResult.comment || '“……”';

                    document.getElementById('cs-daily-char-ans').innerText = charAns;
                    document.getElementById('cs-daily-comment').innerText = comment;
                    
                    // ▼▼▼ 护栏 3：绝对安全的记忆替换引擎 ▼▼▼
                    if (db) {
                        const oldState = await loadCSData('qa_card_state_' + charId);
                        
                        // A. 物理抹除旧痕迹，且使用 splice 原位切割，绝不改变内存指针地址！
                        if (oldState && oldState.memoryMsgId) {
                            await db.chatMessages.delete(oldState.memoryMsgId); 
                            if (AppState.currentChatHistory) {
                                const targetIdx = AppState.currentChatHistory.findIndex(m => m.id === oldState.memoryMsgId);
                                if (targetIdx !== -1) AppState.currentChatHistory.splice(targetIdx, 1);
                            }
                        }

                        // B. 注入全新记忆
                        const memoryPrompt = `<[系统隐式提示：刚才你和用户在情侣空间的“默契问答”里互动了。
问题是：“${questionText}”
用户的回答是：“${userAnsText}”
你的回答是：“${charAns}”，并且你对TA的回答作出了评价：“${comment}”。
核心指令：这是一个背景记忆，不要复读本提示，在接下来的聊天中如果合适，你可以非常自然地提及刚才的默契问答游戏。]>`;
                        
                        const newMsgId = await db.chatMessages.add({
                            chatId: charId, timestamp: new Date(), text: memoryPrompt,
                            type: 'sent', uiVisible: false, aiVisible: true, recalled: false
                        });

                        // C. 固化新状态
                        saveCSData('qa_card_state_' + charId, { 
                            date: new Date().toDateString(), question: questionText, answered: true,
                            userAns: userAnsText, charAns: charAns, comment: comment, memoryMsgId: newMsgId
                        });

                        const newMsg = await db.chatMessages.get(newMsgId);
                        if (AppState.currentChatHistory) AppState.currentChatHistory.push(newMsg);
                    }

                } catch (err) {
                    console.error("[默契问答] 重新生成失败:", err);
                    document.getElementById('cs-daily-char-ans').innerText = '（脑电波掉线了）';
                    document.getElementById('cs-daily-comment').innerText = `“${err.message}”`;
                } finally {
                    // ▼▼▼ 护栏 4：无论成功还是失败报错，最终强制解锁按钮，防止卡死 ▼▼▼
                    regenerateBtn.disabled = false;
                }

            });
        }
        // --- ▲▲▲ 新增结束 ▲▲▲

        // 4. 点击头像切换角色

        const handleAvatarClick = (e) => {

            e.stopPropagation();
            const popover = document.getElementById('cs-unique-more-popover');
            if(popover) popover.style.display = 'none';
                     const overlay = document.getElementById('cs-char-switcher-overlay');
            const list = document.getElementById('cs-char-list');
            if (!overlay || !list) return;
            
            list.innerHTML = '';
            AppState.characterProfiles.filter(c => !c.isGroup).forEach(char => {
                const li = document.createElement('li');

                li.className = 'selection-list-item';
                li.innerHTML = `<img src="${char.avatar || DEFAULT_AVATAR_SRC}" class="list-avatar"><span class="item-text">${char.name}</span>`;
                  li.onclick = () => {
                    tempState.currentChatId = char.id;
                    CoupleSpace.updateAvatars();
                    CoupleSpace.loadPageData(); // ▼▼▼ 新增：切换角色后，刷新当前页面的私密数据 ▼▼▼
                    overlay.classList.remove('visible');
                    showDynamicIsland(`已切换至与 ${char.name} 的空间`);
                };

                list.appendChild(li);
            });
            overlay.classList.add('visible');
        };

        if (avatarTrigger) avatarTrigger.addEventListener('click', handleAvatarClick);
        if (heroAvatars) heroAvatars.addEventListener('click', handleAvatarClick);
        if (inviteAvatarTrigger) inviteAvatarTrigger.addEventListener('click', handleAvatarClick);
        const cancelSwitcherBtn = document.getElementById('cs-switcher-cancel');
        if (cancelSwitcherBtn) {
            cancelSwitcherBtn.addEventListener('click', () => document.getElementById('cs-char-switcher-overlay').classList.remove('visible'));
        }
        // 每次进入页面时，初始化更新一次头像
        CoupleSpace.updateAvatars();
        
        // ▼▼▼ 【新增】信箱个性化背景与信纸的文件上传处理 ▼▼▼
        const rmBgInput = document.getElementById('rm-bg-input');
        if (rmBgInput) {
            rmBgInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        const b64 = ev.target.result;
                        saveCSData('rm_bg_image', b64);
                        const mailboxPage = document.querySelector('.rococo-mailbox-page');
                        if (mailboxPage) {
                            mailboxPage.style.backgroundImage = `url(${b64})`;
                            mailboxPage.style.backgroundSize = 'cover';
                            mailboxPage.style.backgroundPosition = 'center';
                        }
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('信箱背景已应用');
                    };
                    reader.readAsDataURL(file);
                }
            });
        }

        const rmPaperInput = document.getElementById('rm-paper-bg-input');
        if (rmPaperInput) {
            rmPaperInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        const b64 = ev.target.result;
                        saveCSData('rm_paper_image', b64);
                        const paper = document.querySelector('.rm-real-paper');
                        if (paper) {
                            paper.style.backgroundImage = `url(${b64})`;
                            paper.style.backgroundSize = 'cover';
                            paper.style.backgroundPosition = 'center';
                        }
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('信纸样式已应用');
                    };
                    reader.readAsDataURL(file);
                }
            });
        }
        // ▲▲▲ 新增结束 ▲▲▲
        // ▼▼▼ 【新增】纪念日个性化背景与卡片的文件上传处理 ▼▼▼
        const annivPageInput = document.getElementById('anniv-page-bg-input');
        if (annivPageInput) {
            annivPageInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        const b64 = ev.target.result;
                        saveCSData('anniv_page_bg', b64);
                        const annivPage = document.querySelector('.rococo-anniversary-page');
                        if (annivPage) {
                            annivPage.style.backgroundImage = `url(${b64})`;
                            annivPage.style.backgroundSize = 'cover';
                            annivPage.style.backgroundPosition = 'center';
                        }
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('页面背景已应用');
                    };
                    reader.readAsDataURL(file);
                }
            });
        }

        const annivCardInput = document.getElementById('anniv-card-bg-input');
        if (annivCardInput) {
            annivCardInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        const b64 = ev.target.result;
                        saveCSData('anniv_card_bg', b64).then(() => {
                            renderAnniversaryList(tempState.currentChatId);
                            if (typeof showDynamicIsland === 'function') showDynamicIsland('卡片底纹已应用');
                        });
                    };
                    reader.readAsDataURL(file);
                }
            });
        }
        // ▲▲▲ 新增结束 ▲▲▲

        // 5. 占位入口提示

        placeholders.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showDynamicIsland('正在施工中，敬请期待...');
                });
            }
        });

 
        // 绑定点击信件卡片进入阅读视图
        const letterList = document.getElementById('rm-letter-list');
        if (letterList) {
            letterList.addEventListener('click', (e) => {
                const card = e.target.closest('.rm-letter-card');
                if (card) {
                    document.getElementById('rm-list-view').style.display = 'none';
                    document.getElementById('rm-read-view').style.display = 'flex'; 
                }
            });
        }

        // ▼▼▼ 新增：右上角更多按钮与弹窗逻辑 (强效加固版) ▼▼▼

        const csMoreBtn = document.getElementById('cs-unique-more-btn');
        const csMorePopover = document.getElementById('cs-unique-more-popover');
        
        if (csMoreBtn && csMorePopover) {
            // 1. 点击按钮显示/隐藏弹窗
            csMoreBtn.addEventListener('click', (e) => {
                e.stopPropagation(); 
                csMorePopover.style.display = csMorePopover.style.display === 'none' ? 'flex' : 'none';
            });
            // 2. 点击空白处关闭气泡
            document.addEventListener('click', (e) => {
                if (csMorePopover.style.display !== 'none' && !csMorePopover.contains(e.target)) {
                    csMorePopover.style.display = 'none';
                }
            });
        }

        // ▼▼▼ 【新增】信箱页面右上角更多按钮逻辑 ▼▼▼
        const rmMoreBtn = document.getElementById('rm-more-btn');
        const rmMorePopover = document.getElementById('rm-more-popover');
        if (rmMoreBtn && rmMorePopover) {
            rmMoreBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // 阻止点击事件冒泡，防止一打开就立刻触发外层的关闭
                rmMorePopover.style.display = rmMorePopover.style.display === 'none' ? 'flex' : 'none';
            });

            // 点击信箱页面的空白处自动关闭菜单
            document.addEventListener('click', (e) => {
                if (rmMorePopover.style.display !== 'none' && !rmMorePopover.contains(e.target)) {
                    rmMorePopover.style.display = 'none';
                }
            });
        }
        // ▲▲▲ 新增结束 ▲▲▲
        // ▼▼▼ 【新增】纪念日页面空白处自动关闭菜单 ▼▼▼
        const annivMorePopover = document.getElementById('anniv-more-popover');
        if (annivMorePopover) {
            document.addEventListener('click', (e) => {
                if (annivMorePopover.style.display !== 'none' && !annivMorePopover.contains(e.target)) {
                    annivMorePopover.style.display = 'none';
                }
            });
        }
        // ▲▲▲ 新增结束 ▲▲▲

         // --- 进阶精细版：部件级色彩定制系统 ---
      // Hex 转换为 RGBA 以供特殊背景阴影使用
        const hexToRgba = (hex, alpha) => {
            if (!hex) return '';
            let r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        };
        let cssUpdateFrame = null; // 新增：动画帧节流锁
        // 核心更新函数：每次操作都会重新读取所有 input 并生成对应 CSS
        const updateAllComponentsCSS = () => {
            if (cssUpdateFrame) cancelAnimationFrame(cssUpdateFrame); // 取消上一帧
            
            cssUpdateFrame = requestAnimationFrame(() => { // 将 DOM 渲染推迟到下一帧执行，防止发热
                let styleTag = document.getElementById('cs-dynamic-comp-color');
                if (!styleTag) {
                    styleTag = document.createElement('style');
                    styleTag.id = 'cs-dynamic-comp-color';
                    document.head.appendChild(styleTag);
                }
                
                // 安全读取函数，防止报错
                const val = (id) => document.getElementById(id)?.value;
                styleTag.innerHTML = `
                /* 1. 约法三章 */
                .couple-space-page .cs-journal-rules { background: ${val('cr-bg')} !important; }
                .couple-space-page .cs-journal-rules .paper-tape { background: ${hexToRgba(val('cr-tape'), 0.6)} !important; }
                .couple-space-page .cs-journal-rules .rules-header .en, .couple-space-page .cs-journal-rules .rules-list li { color: ${val('cr-title')} !important; }
                .couple-space-page .cs-journal-rules li .num { background: ${val('cr-num-bg')} !important; color: ${val('cr-num-txt')} !important; }
                /* 2. 默契问答 */
                .couple-space-page .cs-flip-card-front { background-color: ${val('cf-bg')} !important; }
                .couple-space-page .cs-flip-card-front .card-date.rococo-text { color: ${val('cf-date')} !important; }
                .couple-space-page .cs-flip-card-front .question-text { color: ${val('cf-question')} !important; }
                .couple-space-page .cs-flip-card-front .cs-input-line { border-bottom-color: ${val('cf-input')} !important; color: ${val('cf-input')} !important; }
                .couple-space-page .cs-flip-card-front .cs-submit-btn { background: ${val('cf-btn-bg')} !important; color: ${val('cf-btn-txt')} !important; }
                .couple-space-page .cs-flip-card-back { background: ${val('cf-back-bg')} !important; }
                
                 /* 3. 情书信箱 */
                .couple-space-page .cs-mailbox-module { background: ${val('cm-bg')} !important; }
                .couple-space-page .cs-mailbox-module .mailbox-ornament { background-image: radial-gradient(circle at 50% 100%, transparent 4px, ${val('cm-ornament')} 5px) !important; }
                .couple-space-page .cs-mailbox-module .mailbox-slot { background: ${val('cm-slot')} !important; }
                .couple-space-page .cs-mailbox-module .mailbox-slot::after { border-color: ${val('cm-slot-border')} !important; }
                .couple-space-page .cs-mailbox-module .mailbox-icon, .couple-space-page .cs-mailbox-module .mailbox-text { color: ${val('cm-icon')} !important; }
                
                /* 4. 情绪磁吸板 */

                .couple-space-page .cs-cork-board { background: ${val('cb-bg')} !important; }
                .couple-space-page .cs-cork-board .note-paper.user-note { background: ${val('cb-note-user')} !important; }
                .couple-space-page .cs-cork-board .note-paper.char-note { background: ${val('cb-note-char')} !important; }
                .couple-space-page .cs-cork-board .note-paper .magnet-pin { background: ${val('cb-pin')} !important; }

                           /* 5. 日常记录气垫格 (四个独立控制) */
                .couple-space-page #cs-coupon-trigger .tool-icon { background: ${val('ct-bg-1')} !important; }
                .couple-space-page #cs-coupon-trigger .tool-icon svg { color: ${val('ct-ic-1')} !important; }
                
                .couple-space-page #cs-period-trigger .tool-icon { background: ${val('ct-bg-2')} !important; }
                .couple-space-page #cs-period-trigger .tool-icon svg { color: ${val('ct-ic-2')} !important; }
                
                .couple-space-page #cs-mood-trigger .tool-icon { background: ${val('ct-bg-3')} !important; }
                .couple-space-page #cs-mood-trigger .tool-icon svg { color: ${val('ct-ic-3')} !important; }
                
                .couple-space-page #cs-anniversary-trigger .tool-icon { background: ${val('ct-bg-4')} !important; }
                .couple-space-page #cs-anniversary-trigger .tool-icon svg { color: ${val('ct-ic-4')} !important; }
          `;
            });
        };
 // 前两行原代码参考
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('app-page') || e.target.classList.contains('cs-scroll-content')) return;
                 // ▼▼▼ 【新增】发送空间邀请与退出逻辑 ▼▼▼
            if (e.target.closest('.cs-invite-back-btn')) {
                e.stopPropagation();
                const spacePage = document.getElementById('page-couple-space');
                if (spacePage) spacePage.classList.remove('active');
                return;
            }
            if (e.target.closest('#btn-send-space-invite')) {
                e.stopPropagation();
                const btn = e.target.closest('#btn-send-space-invite');
                if (btn.disabled) return;
                
                const charId = tempState.currentChatId;
                
                // 将状态存入数据库：标记为 pending (等待中)
                saveCSData('cs_unlocked_' + charId, { unlocked: false, pending: true, pendingDirection: 'user_to_ai' }).then(() => {
                  btn.style.display = 'none';
                    const btnRevoke = document.getElementById('btn-revoke-space-invite');
                    if(btnRevoke) btnRevoke.style.display = 'block';
                    const statusHint = document.getElementById('invite-status-text');
                    if (statusHint) statusHint.style.display = 'block';
                    if (typeof showDynamicIsland === 'function') {
                        showDynamicIsland('空间邀请已发送给 Ta', 'success');
                    }
                    
                    // ▼▼▼ 新增：触发发送 AI 消息卡片的逻辑 ▼▼▼
                    import('../state.js').then(async ({ db, AppState }) => {
                        const currentUser = getCurrentChatIdentity(charId) || { name: 'User' };
                        
                        // 1. 生成发在聊天记录里的漂亮邀请卡片
                        const inviteMsg = {
                            chatId: charId,
                            timestamp: new Date(),
                            text: `[情侣空间邀请] 我想和你开启专属空间`,
                            type: 'sent',
                            contentType: 'space_invite',
                            inviteStatus: 'pending',
                            avatarSrc: currentUser.avatar,
                            recalled: false,
                            replyToMessageId: null
                        };
            const msgId = await db.chatMessages.add(inviteMsg);
                        
                        // 2. 注入隐式记忆，让 AI 知道用户干了什么
                                                const memoryPrompt = `<[系统强制指令（最高优先级）：用户刚刚向你发送了"情侣空间"邀请。这是一个只属于你们两人的私密空间，里面有约法三章、纪念日等浪漫功能。

你的任务：
1. 在你的JSON回复数组中，先用 {"type": "text", "content": "你的自然回应文字"} 表达你的态度。
2. 然后必须额外输出一个 {"type": "accept_space", "content": ""} 或 {"type": "reject_space", "content": ""} 来正式做出决定。
3. 请根据你的人设和你们的关系亲密度来决定是接受还是拒绝。

示例输出格式：
[
  {"type": "inner_thoughts", "content": "..."},
  {"type": "text", "content": "好呀，开通吧~"},
  {"type": "accept_space", "content": ""}
]]>`;

                        const sysMsgId = await db.chatMessages.add({
                            chatId: charId, timestamp: new Date(), text: memoryPrompt,
                            type: 'sent', uiVisible: false, aiVisible: true, recalled: false
                        });
                        
                        // 3. 将消息同步到内存中，并更新侧边栏
                        const newMsg = await db.chatMessages.get(msgId);
                        const sysNewMsg = await db.chatMessages.get(sysMsgId);
                        if (AppState.currentChatHistory) {
                            AppState.currentChatHistory.push(newMsg);
                            AppState.currentChatHistory.push(sysNewMsg);
                        }
                        import('./chat-ui.js').then(({ updateSidebarPreview }) => {
                            updateSidebarPreview(charId, newMsg);
                        });
                    });
                    // ▲▲▲ 新增结束 ▲▲▲
                });
                return;
            }
                      // ▼▼▼ 【新增】撤回空间申请逻辑 ▼▼▼
            if (e.target.closest('#btn-revoke-space-invite')) {
                e.stopPropagation();
                const charId = tempState.currentChatId;
                saveCSData('cs_unlocked_' + charId, { unlocked: false, pending: false }).then(() => {
                    const btnSend = document.getElementById('btn-send-space-invite');
                    const btnRevoke = document.getElementById('btn-revoke-space-invite');
                    const statusHint = document.getElementById('invite-status-text');
                    
                    if (btnSend) { btnSend.style.display = 'block'; btnSend.disabled = false; btnSend.innerText = '发送空间邀请'; }
                    if (btnRevoke) btnRevoke.style.display = 'none';
                    if (statusHint) statusHint.style.display = 'none';
                                        // 【修复】同时更新聊天界面中邀请卡片的状态，防止撤回后仍可点击
                    import('../state.js').then(async ({ db, AppState }) => {
                        const pendingInvite = await db.chatMessages
                            .where('chatId').equals(charId)
                            .filter(m => m.type === 'sent' && m.contentType === 'space_invite' && m.inviteStatus === 'pending')
                            .last();
                        if (pendingInvite) {
                            await db.chatMessages.update(pendingInvite.id, { inviteStatus: 'rejected' });
                            const msgInMem = AppState.currentChatHistory.find(m => m.id === pendingInvite.id);
                            if (msgInMem) msgInMem.inviteStatus = 'rejected';
                            // 更新DOM中卡片的显示
                            const cardEl = document.querySelector(`.space-invite-card[data-message-id="${pendingInvite.id}"]`);
                            if (cardEl) {
                                cardEl.classList.add('processed');
                                const actionsEl = cardEl.querySelector('.si-actions');
                                if (actionsEl) actionsEl.innerHTML = `<div class="status-text">已撤回</div>`;
                            }
                        }
                    });

                    if (typeof showDynamicIsland === 'function') showDynamicIsland('已撤回空间申请');
                    import('../state.js').then(async ({ db, AppState }) => {
                        const memoryPrompt = `<[系统隐式提示：用户刚刚撤回了发送给你的“情侣空间”邀请。核心指令：这是一个背景事件，你不需要复读本提示。请在接下来的聊天中，自然地对此作出反应。]>`;
                        const sysMsgId = await db.chatMessages.add({
                            chatId: charId, timestamp: new Date(), text: memoryPrompt,
                            type: 'sent', uiVisible: false, aiVisible: true, recalled: false
                        });
                        const sysNewMsg = await db.chatMessages.get(sysMsgId);
                        if (AppState.currentChatHistory) AppState.currentChatHistory.push(sysNewMsg);
                    });
                });
                return;
            }
            // ▼▼▼ 【新增】空间解绑逻辑 ▼▼▼
            if (e.target.closest('#cs-btn-unbind-space')) {
                e.stopPropagation();
                if(csMorePopover) csMorePopover.style.display = 'none';
                
                const charId = tempState.currentChatId;
                if (confirm("确定要解绑该角色的情侣空间吗？")) {
                    saveCSData('cs_unlocked_' + charId, { unlocked: false, pending: false }).then(() => {
                        CoupleSpace.loadPageData(); 
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('空间已成功解绑', 'success');
                        
                        import('../state.js').then(async ({ db, AppState }) => {
                            const memoryPrompt = `<[系统隐式提示：用户刚刚单方面解绑了和你的“情侣空间”。核心指令：这是一个背景事件。请在接下来的聊天中，自然地对此作出反应（如失落、不解或愤怒），绝不要提你收到了系统指令。]>`;
                            const sysMsgId = await db.chatMessages.add({
                                chatId: charId, timestamp: new Date(), text: memoryPrompt,
                                type: 'sent', uiVisible: false, aiVisible: true, recalled: false
                            });
                            const sysNewMsg = await db.chatMessages.get(sysMsgId);
                            if (AppState.currentChatHistory) AppState.currentChatHistory.push(sysNewMsg);
                        });
                    });
                }
                return;
            }
            // ▼▼▼ 【新增】自动写情书设置逻辑 ▼▼▼
            if (e.target.closest('#rm-btn-write-letter')) {
                e.stopPropagation();
                // 隐藏右上角气泡菜单
                const popover = document.getElementById('rm-more-popover');
                if (popover) popover.style.display = 'none';
                
                // 展开自动写信设置模态框
                const modal = document.getElementById('auto-letter-modal-overlay');
                if (modal) {
                    // 1. 先赋予物理体积
                    showCSModal(modal);
                    // 读取现有设置
                    const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
                    if (char) {
                        document.getElementById('auto-letter-toggle').checked = !!char.autoLetterEnabled;
                        document.getElementById('auto-letter-days-input').value = char.autoLetterDays || 7;
                        document.getElementById('auto-letter-time-input').value = char.autoLetterTime || '23:00'; // 新增读取时间
                    }

                    // 2. 延迟 10 毫秒摘下隐形斗篷，触发 CSS 渐变动画

                }
                return;
            }

            // 点击关闭按钮时的动画
            if (e.target.closest('#close-auto-letter-btn')) {
                const modal = document.getElementById('auto-letter-modal-overlay');
                if (modal) {
                    // 1. 穿上隐形斗篷
                    modal.style.opacity = '0';
                    modal.style.pointerEvents = 'none';
                    // 2. 等待 300 毫秒动画播完后，撤销物理体积
                    setTimeout(() => {
                        modal.style.display = 'none';
                    }, 300);
                }
                return;
            }
            // 点击保存按钮时的动画及逻辑
            if (e.target.closest('#save-auto-letter-btn')) {
                const modal = document.getElementById('auto-letter-modal-overlay');
                const isEnabled = document.getElementById('auto-letter-toggle').checked;
                const days = parseInt(document.getElementById('auto-letter-days-input').value, 10) || 7;
                const timeVal = document.getElementById('auto-letter-time-input').value || '23:00'; // 新增获取时间
                const charId = tempState.currentChatId;

                import('../state.js').then(async ({ db }) => {
                    await db.characterProfiles.update(charId, { 
                        autoLetterEnabled: isEnabled,
                        autoLetterDays: days,
                        autoLetterTime: timeVal, // 保存时间
                        autoLetterLastTime: Date.now() // 重置计时起点
                    });
                    const char = AppState.characterProfiles.find(c => c.id === charId);
                    if (char) {
                        char.autoLetterEnabled = isEnabled;
                        char.autoLetterDays = days;
                        char.autoLetterTime = timeVal;
                        char.autoLetterLastTime = Date.now();
                    }

                    // 同样执行隐身关闭动画
                    if (modal) {
                        modal.style.opacity = '0';
                        modal.style.pointerEvents = 'none';
                        setTimeout(() => {
                            modal.style.display = 'none';
                        }, 300);
                    }
                    
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('自动情书设定已保存', 'success');
                });
                return;
            }
            // ▲▲▲ 新增结束 ▲▲▲

// 后两行原代码参考
            if (e.target.closest('#rm-btn-bg-upload')) {
                e.stopPropagation();

                // 隐藏右上角气泡菜单
                const popover = document.getElementById('rm-more-popover');
                if (popover) popover.style.display = 'none';
                
                // 展开设置模态框 (强制重置透明度和拦截点击)
                const modal = document.getElementById('rm-bg-settings-modal');
                if (modal) {
                    showCSModal(modal, { visibleClass: 'visible' }); // 兼容原项目可能存在的动画类名
                    // 延迟10毫秒执行，确保浏览器先渲染了flex，再执行透明度过渡动画
                }
                return;
            }

            if (e.target.closest('#close-rm-bg-settings-btn') || e.target.closest('#save-rm-bg-settings-btn')) {
                const modal = document.getElementById('rm-bg-settings-modal');
                if (modal) {
                    modal.style.opacity = '0';
                    modal.classList.remove('visible');
                    modal.style.pointerEvents = 'none';
                    // 等待300毫秒透明度动画结束，再彻底隐藏它
                    setTimeout(() => {
                        modal.style.display = 'none';
                    }, 300);
                }
                return;
            }


            if (e.target.closest('#reset-rm-bg-btn')) {
                saveCSData('rm_bg_image', null);
                const mailboxPage = document.querySelector('.rococo-mailbox-page');
                if (mailboxPage) {
                    mailboxPage.style.backgroundImage = '';
                    mailboxPage.style.backgroundSize = '';
                    mailboxPage.style.backgroundPosition = '';
                }
                if (typeof showDynamicIsland === 'function') showDynamicIsland('已恢复默认信箱背景');
                return;
            }
            if (e.target.closest('#reset-rm-paper-bg-btn')) {
                saveCSData('rm_paper_image', null);
                const paper = document.querySelector('.rm-real-paper');
                if (paper) {
                    paper.style.backgroundImage = '';
                    paper.style.backgroundSize = '';
                    paper.style.backgroundPosition = '';
                }
                if (typeof showDynamicIsland === 'function') showDynamicIsland('已恢复默认信纸样式');
                return;
            }
            // ▲▲▲ 新增结束 ▲▲▲

            // --- ▼▼▼ 【新增】截断文本点击查看完整内容悬浮窗 ▼▼▼ ---
            const globalTooltip = document.getElementById('cs-global-text-tooltip');
            
            // 无论点哪里，如果气泡在显示，先把它关掉
            if (globalTooltip && globalTooltip.classList.contains('show')) {
                globalTooltip.classList.remove('show');
            }
            const truncateEl = e.target.closest('.truncate-text');
            if (truncateEl) {
                // 【修复】移除严格的高度判断，绕过手机浏览器对多行截断的高度计算Bug，只要点击直接显示
                e.stopPropagation(); // 防止触发卡片翻转或其他点击
                globalTooltip.innerText = truncateEl.innerText;
                
                // 获取文字位置，把气泡定位在它正上方
                const rect = truncateEl.getBoundingClientRect();
                globalTooltip.style.left = (rect.left + rect.width / 2) + 'px';
                globalTooltip.style.top = (rect.top - 8) + 'px'; 
                
                globalTooltip.classList.add('show');
                return; // 弹出了气泡就不往下执行其他逻辑了
            }
            // --- ▲▲▲ 新增结束 ▲▲▲ ---
            
            // ▼▼▼ 【新增】生理期交互逻辑 ▼▼▼
            // 1. 进入生理期页面
            if (e.target.closest('#cs-period-trigger')) {

                e.stopPropagation();
                document.querySelectorAll('.app-page').forEach(p => p.classList.remove('active'));
                const periodPage = document.getElementById('page-couple-period');
                if (periodPage) {
                    window.scrollTo(0, 0);
                    periodPage.classList.add('active');

                    // ▼▼▼ 新增：渲染日历 ▼▼▼
                    if(typeof renderPeriodCalendar === 'function') renderPeriodCalendar(currentCalDate);
                }
                return;
            }

            // 2. 退出生理期页面
            if (e.target.closest('.cp-period-back-btn')) {
                e.stopPropagation();
                const periodPage = document.getElementById('page-couple-period');
                if (periodPage) periodPage.classList.remove('active');
                
                const spacePage = document.getElementById('page-couple-space');
                if (spacePage) {
                    window.scrollTo(0, 0);
                    spacePage.classList.add('active');

                    const scrollContent = spacePage.querySelector('.cs-scroll-content');
                    if (scrollContent) {
                        const oldZ = scrollContent.style.zIndex;
                        scrollContent.style.zIndex = '11';
                        setTimeout(() => scrollContent.style.zIndex = oldZ, 50);
                    }
                }
                return;
            }
             // ▼▼▼ 新增：生理期设置弹窗交互逻辑 ▼▼▼
            if (e.target.closest('#cp-period-history-btn')) {
                e.stopPropagation();
                const modal = document.getElementById('period-settings-modal-overlay');
                if (modal) {
                    const charObj = AppState.characterProfiles?.find(c => c.id === tempState.currentChatId);
                    const perceptionToggle = document.getElementById('period-perception-toggle');
                    if (perceptionToggle && charObj) {
                        // 默认开启，除非明确设为 false
                        perceptionToggle.checked = charObj.periodPerceptionEnabled !== false;
                    }
                    // 触发展示历史及分析建议
                    showCSModal(modal, {
                        afterVisible: () => {
                            if (typeof refreshPeriodStatisticsPage === 'function') refreshPeriodStatisticsPage();
                        }
                    });
                }
                return;
            }

            if (e.target.closest('.period-history-toggle-btn')) {
                e.stopPropagation();
                periodHistoryExpanded = !periodHistoryExpanded;
                refreshPeriodStatisticsPage();
                return;
            }

            if (e.target.closest('.edit-period-record-btn')) {
                e.stopPropagation();
                const btn = e.target.closest('.edit-period-record-btn');
                const index = parseInt(btn.dataset.index, 10);
                loadPeriodSnapshot().then(snapshot => {
                    const record = snapshot.records[index];
                    if (!record) return;
                    const modal = document.getElementById('period-record-edit-modal-overlay');
                    const indexInput = document.getElementById('period-edit-record-index');
                    const startInput = document.getElementById('period-edit-start-input');
                    const endInput = document.getElementById('period-edit-end-input');
                    if (!modal || !indexInput || !startInput || !endInput) return;
                    indexInput.value = String(index);
                    startInput.value = record.start || '';
                    endInput.value = record.end || '';
                    showCSModal(modal);
                });
                return;
            }

            if (e.target.closest('#close-period-record-edit-btn')) {
                e.stopPropagation();
                closePeriodRecordEditModal();
                return;
            }

            if (e.target.closest('#save-period-record-edit-btn')) {
                e.stopPropagation();
                const index = parseInt(document.getElementById('period-edit-record-index')?.value, 10);
                const start = document.getElementById('period-edit-start-input')?.value;
                const end = document.getElementById('period-edit-end-input')?.value || null;
                if (!start || (end && getLocalTime(end) < getLocalTime(start))) {
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('请检查开始和结束日期', 'error');
                    return;
                }
                loadPeriodSnapshot().then(async snapshot => {
                    const list = snapshot.records || [];
                    if (!list[index]) return;
                    list[index] = {
                        ...list[index],
                        start,
                        end,
                        endSource: end ? 'user' : null
                    };
                    await saveCSData('period_records', normalizePeriodRecords(list));
                    closePeriodRecordEditModal();
                    await refreshPeriodViews();
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('经期记录已更新', 'success');
                });
                return;
            }

            if (e.target.closest('#delete-period-record-btn')) {
                e.stopPropagation();
                if (!window.confirm('确定删除这条经期记录吗？症状记录不会一起删除。')) return;
                const index = parseInt(document.getElementById('period-edit-record-index')?.value, 10);
                loadPeriodSnapshot().then(async snapshot => {
                    const list = snapshot.records || [];
                    if (!list[index]) return;
                    list.splice(index, 1);
                    await saveCSData('period_records', normalizePeriodRecords(list));
                    closePeriodRecordEditModal();
                    await refreshPeriodViews();
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('经期记录已删除', 'success');
                });
                return;
            }

            // ▼▼▼ 新增：一键采用AI周期建议 ▼▼▼
            if (e.target.closest('#apply-period-suggestion-btn')) {
                e.stopPropagation();
                const btn = e.target.closest('#apply-period-suggestion-btn');
                const cycle = btn.dataset.cycle;
                const dur = btn.dataset.dur;
                document.getElementById('period-cycle-input').value = cycle;
                document.getElementById('period-duration-input').value = dur;
                saveCSData('period_settings', { duration: dur, cycle: cycle }).then(() => refreshPeriodViews());
                
                btn.innerText = '已成功更新！';
                btn.style.opacity = '0.7';
                btn.disabled = true;
                if (typeof showDynamicIsland === 'function') showDynamicIsland('周期设定已智能更新', 'success');
                return;
            }

            if (e.target.closest('#save-period-symptoms-btn')) {
                e.stopPropagation();
                const btn = e.target.closest('#save-period-symptoms-btn');
                const section = e.target.closest('.period-symptoms-section');
                const symptomData = collectPeriodSymptomsFromSection(section);
                loadCSData('period_symptoms').then(data => {
                    data = data || {};
                    data[selectedCalDateStr] = symptomData;
                    saveCSData('period_symptoms', data).then(() => {
                        refreshPeriodStatisticsPage();
                        btn.classList.remove('is-dirty');
                        btn.innerText = '已保存';
                        setTimeout(() => { btn.innerText = '保存症状记录'; }, 1200);
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('症状记录已保存', 'success');
                        writePeriodAiHiddenMessage(buildPeriodSymptomMemoryPrompt(selectedCalDateStr, symptomData));
                    });
                });
                return;
            }

            // ▼▼▼ 新增：处理症状的点击记录 (轻量化记录) ▼▼▼
            const symptomPill = e.target.closest('.symptom-pill');
            const symptomItem = e.target.closest('.symptom-item');
            if ((symptomPill || symptomItem) && e.target.closest('.period-symptoms-section')) {
                e.stopPropagation();
                const section = e.target.closest('.period-symptoms-section');
                
                if (symptomPill) {
                    const row = symptomPill.parentElement;
                    Array.from(row.children).forEach(c => c.classList.remove('active'));
                    symptomPill.classList.add('active');
                } else if (symptomItem) {
                    const grid = symptomItem.parentElement;
                    const isMood = grid.previousElementSibling.innerText.includes('心情情绪');
                    if (isMood) {
                        // 心情单选
                        Array.from(grid.children).forEach(c => c.classList.remove('active'));
                        symptomItem.classList.add('active');
                    } else {
                        // 身体状态多选
                        symptomItem.classList.toggle('active');
                    }
                }

                const saveBtn = section.querySelector('#save-period-symptoms-btn');
                if (saveBtn) {
                    saveBtn.classList.add('is-dirty');
                    saveBtn.innerText = '保存症状记录';
                    saveBtn.disabled = false;
                }
                return;
            }


            if (e.target.closest('#close-period-settings-btn')) {
                e.stopPropagation();
                const modal = document.getElementById('period-settings-modal-overlay');
                if (modal) {
                    modal.style.opacity = '0';
                    setTimeout(() => { modal.style.display = 'none'; }, 300);
                }
                return;
            }

            if (e.target.closest('#save-period-settings-btn')) {
                e.stopPropagation();
                const duration = document.getElementById('period-duration-input')?.value;
                const cycle = document.getElementById('period-cycle-input')?.value;
                if (duration && cycle) {
                    saveCSData('period_settings', { duration, cycle }).then(() => {
                        refreshPeriodViews(); // 实时更新日历与统计
                    });
                }

               const perceptionToggle = document.getElementById('period-perception-toggle');
                if (perceptionToggle) {
                    const isEnabled = perceptionToggle.checked;
                    const charId = tempState.currentChatId;
                    import('../state.js').then(async ({ db }) => {
                        await db.characterProfiles.update(charId, { periodPerceptionEnabled: isEnabled });
                        const charObj = AppState.characterProfiles.find(c => c.id === charId);
                        if (charObj) charObj.periodPerceptionEnabled = isEnabled;
                    });
                }
                const modal = document.getElementById('period-settings-modal-overlay');
                if (modal) {
                    modal.style.opacity = '0';
                    setTimeout(() => { modal.style.display = 'none'; }, 300);
                }
                if (typeof showDynamicIsland === 'function') showDynamicIsland('生理期设置已保存', 'success');
                return;
            }
             // ▼▼▼ 新增：生理期日历点击与打卡逻辑 ▼▼▼
            if (e.target.closest('#cal-prev-month')) {
                e.stopPropagation();
                currentCalDate.setMonth(currentCalDate.getMonth() - 1);
                renderPeriodCalendar(currentCalDate);
                return;
            }
            if (e.target.closest('#cal-next-month')) {
                e.stopPropagation();
                currentCalDate.setMonth(currentCalDate.getMonth() + 1);
                renderPeriodCalendar(currentCalDate);
                return;
            }
             // 点击日历格子，选中日期
            if (e.target.closest('.day-cell:not(.empty)')) {
                e.stopPropagation();
                const cell = e.target.closest('.day-cell:not(.empty)');
                if (cell.dataset.date) {
                    selectedCalDateStr = cell.dataset.date;
                    renderPeriodCalendar(currentCalDate);
                }
                return;
            }
             // ▼▼▼ 修改：移除旧的 period-toggle-btn 判定，仅保留标记开始 ▼▼▼
            if (e.target.closest('#mark-period-start-btn')) {
                e.stopPropagation();
                const btn = e.target.closest('#mark-period-start-btn');
                const dateToMark = selectedCalDateStr;

                loadCSData('period_records').then(records => {
                    let list = records || [];
                    
                    // 如果是撤销模式
                    if (btn.dataset.isCancel === 'true') {
                        const selTime = getLocalTime(dateToMark);
                        list = list.filter(rec => {
                            const sTime = getLocalTime(rec.start);
                            const eTime = rec.end ? getLocalTime(rec.end) : sTime + 14 * 86400000; // 最大容错14天
                            return !(selTime >= sTime && selTime <= eTime);
                        });
                        saveCSData('period_records', list).then(() => {
                            refreshPeriodViews();
                            if (typeof showDynamicIsland === 'function') showDynamicIsland('已撤销该条经期记录', 'success');
                        });
                        return; // 结束执行
                    }

                    // 正常的标记开始模式
                    if (!list.find(r => r.start === dateToMark)) {
                        list.push({ start: dateToMark, end: null });
                        saveCSData('period_records', list).then(() => {
                            refreshPeriodViews();
                            if (typeof showDynamicIsland === 'function') showDynamicIsland('已标记经期开始', 'success');
                            // 强校验：明确区分今天还是过去
                            const todayStr = getTodayPeriodDate();
                            const isToday = dateToMark === todayStr;
                            const memoryPrompt = isToday
                                ? `<[系统隐式提示：用户刚刚在APP记录了她【今天】生理期开始了！核心指令：请你立刻表现出关心、体贴，提醒她注意身体。]>`
                                : `<[系统隐式提示：用户刚刚在APP补录了一条【过去】的生理期记录（日期：${dateToMark}）。核心指令：这是过去的补录！说明她现在【并没有】来月经！仅作为健康数据参考存入大脑，绝对不要对她表达生理期关心！绝不要复读本提示！]>`;
                            writePeriodAiHiddenMessage(memoryPrompt);
                        });
                    }
                });
                return;
            }

              // 点击“标记结束”
            if (e.target.closest('#mark-period-end-btn')) {
                e.stopPropagation();
                const btn = e.target.closest('#mark-period-end-btn');
    
                loadCSData('period_records').then(records => {

                    let list = records || [];
                    const selTime = getLocalTime(selectedCalDateStr);
                    let targetRec = null;
                    // 找到所选日期归属的最近一次经期记录
                    for (const rec of list) {
                        const sTime = getLocalTime(rec.start);
                        if (selTime >= sTime && (!rec.end || selTime <= getLocalTime(rec.end) || selTime <= sTime + 14 * 86400000)) {
                            targetRec = rec;
                            break;
                        }
                    }
                    if (targetRec) {
                        targetRec.end = selectedCalDateStr;
                        targetRec.endSource = 'user';
                        saveCSData('period_records', list).then(() => {
                            playPeriodSuccessAnimation(btn, '经期已结束').then(() => {
                                refreshPeriodViews();
                            });
                            if (typeof showDynamicIsland === 'function') showDynamicIsland('已标记经期结束', 'success');
                            const todayStr = getTodayPeriodDate();
                            const isTodayEnd = selectedCalDateStr === todayStr;
                            const memoryPrompt = isTodayEnd
                                ? `<[系统隐式提示：用户刚刚在APP标记了她的生理期在【今天】（${selectedCalDateStr}）结束了！核心指令：说明她刚度过特殊时期，请自然地替她开心、说些辛苦了之类的话。]>`
                                : `<[系统隐式提示：用户刚刚在APP补录了一条【过去】的生理期结束记录（结束日期：${selectedCalDateStr}）。核心指令：这是过去的补录！仅作为健康数据参考，绝对不要对她表达生理期刚结束的关怀！绝不要复读本提示！]>`;
                            writePeriodAiHiddenMessage(memoryPrompt);
                        });
                    }
                });
                return;
            }
            // ▲▲▲ 新增结束 ▲▲▲
                      // ▼▼▼ 【新增】纪念日交互逻辑 ▼▼▼
             // 1. 进入纪念日页面
            if (e.target.closest('#extend-period-btn')) {
                e.stopPropagation();
                const btn = e.target.closest('#extend-period-btn');
                loadPeriodSnapshot().then(async snapshot => {
                    const list = snapshot.records || [];
                    const latestRec = list[0];
                    if (!latestRec) return;
                    const predictedEnd = getDefaultPeriodEnd(latestRec.start, snapshot.settings.duration);
                    const predictedEndTime = getLocalTime(predictedEnd);
                    const todayTime = getLocalTime(snapshot.todayStr);
                    if (selectedCalDateStr !== snapshot.todayStr
                        || latestRec.end === snapshot.todayStr
                        || todayTime <= predictedEndTime
                        || todayTime > predictedEndTime + 5 * PERIOD_DAY_MS) return;
                    latestRec.end = snapshot.todayStr;
                    latestRec.endSource = 'user';
                    await saveCSData('period_records', list);
                    await playPeriodSuccessAnimation(btn, '已延长到今天');
                    await refreshPeriodViews();
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('已延长经期', 'success');
                });
                return;
            }
            if (e.target.closest('#cs-anniversary-trigger')) {
                e.stopPropagation();
                renderAnniversaryList(tempState.currentChatId);
                document.querySelectorAll('.app-page').forEach(p => p.classList.remove('active'));
                const annivPage = document.getElementById('page-couple-anniversary');
                if (annivPage) {
                    window.scrollTo(0, 0);
                    annivPage.classList.add('active');

                }
                return;
            }
            // 2. 退出纪念日页面
            if (e.target.closest('.cp-anniversary-back-btn')) {
                e.stopPropagation();
                const annivPage = document.getElementById('page-couple-anniversary');
                if (annivPage) annivPage.classList.remove('active');
                
                const spacePage = document.getElementById('page-couple-space');
                if (spacePage) {
                    window.scrollTo(0, 0);
                    spacePage.classList.add('active');

                    const scrollContent = spacePage.querySelector('.cs-scroll-content');
                    if (scrollContent) {
                        const oldZ = scrollContent.style.zIndex;
                        scrollContent.style.zIndex = '11';
                        setTimeout(() => scrollContent.style.zIndex = oldZ, 50);
                    }
                }
                return;
            }
            // 3. 呼出纪念日下拉菜单
            if (e.target.closest('#cc-add-anniversary-btn')) {
                e.stopPropagation();
                const popover = document.getElementById('anniv-more-popover');
                if (popover) popover.style.display = popover.style.display === 'none' ? 'flex' : 'none';
                return;
            }

            // 3.1 点击添加纪念日选项
            if (e.target.closest('#anniv-btn-add-new')) {
                e.stopPropagation();
                const popover = document.getElementById('anniv-more-popover');
                if (popover) popover.style.display = 'none';
                    const modal = document.getElementById('add-anniversary-modal-overlay');
                if (modal) {
                    showCSModal(modal);
                    document.getElementById('anniversary-name-input').value = '';
                    document.getElementById('anniversary-date-input').value = '';
                    // ▼▼▼ 新增：清空周期和描述 ▼▼▼
                    document.getElementById('anniversary-cycle-input').value = 'yearly';
                    document.getElementById('anniversary-desc-input').value = '';
                    // ▲▲▲ ▲▲▲
                }
                return;
            }

            // 3.2 点击背景设置选项
            if (e.target.closest('#anniv-btn-bg-settings')) {
                e.stopPropagation();
                const popover = document.getElementById('anniv-more-popover');
                if (popover) popover.style.display = 'none';
                
                const modal = document.getElementById('anniv-bg-settings-modal');
                if (modal) {
                    showCSModal(modal, { visibleClass: 'visible' }); 
                }
                return;
            }

            // 3.3 纪念日背景设置弹窗的关闭与恢复
            if (e.target.closest('#close-anniv-bg-settings-btn') || e.target.closest('#save-anniv-bg-settings-btn')) {
                const modal = document.getElementById('anniv-bg-settings-modal');
                if (modal) {
                    modal.style.opacity = '0';
                    modal.classList.remove('visible');
                    modal.style.pointerEvents = 'none';
                    setTimeout(() => { modal.style.display = 'none'; }, 300);
                }
                return;
            }

            if (e.target.closest('#reset-anniv-page-bg-btn')) {
                saveCSData('anniv_page_bg', null);
                const annivPage = document.querySelector('.rococo-anniversary-page');
                if (annivPage) {
                    annivPage.style.backgroundImage = '';
                    annivPage.style.backgroundSize = '';
                    annivPage.style.backgroundPosition = '';
                }
                if (typeof showDynamicIsland === 'function') showDynamicIsland('已恢复默认页面背景');
                return;
            }

            if (e.target.closest('#reset-anniv-card-bg-btn')) {
                saveCSData('anniv_card_bg', null).then(() => {
                    renderAnniversaryList(tempState.currentChatId);
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('已恢复默认卡片背景');
                });
                return;
            }

            // 4. 关闭添加弹窗
            if (e.target.closest('#close-anniversary-modal-btn')) {
                e.stopPropagation();
                const modal = document.getElementById('add-anniversary-modal-overlay');
                if (modal) {
                    modal.style.opacity = '0';
                    setTimeout(() => { modal.style.display = 'none'; }, 300);
                }
                return;
            }

            // 5. 保存纪念日
            if (e.target.closest('#save-anniversary-btn')) {
                e.stopPropagation();
                const name = document.getElementById('anniversary-name-input')?.value.trim();
                const date = document.getElementById('anniversary-date-input')?.value;
                // ▼▼▼ 新增：获取周期和描述 ▼▼▼
                const cycle = document.getElementById('anniversary-cycle-input')?.value || 'yearly';
                const desc = document.getElementById('anniversary-desc-input')?.value.trim() || '';
                // ▲▲▲ ▲▲▲
                if (!name || !date) {
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('名称和日期不能为空哦');
                    return;
                }
                const charId = tempState.currentChatId;
                loadCSData('anniversary_' + charId).then(list => {
                    const newList = list || [];
                    // ▼▼▼ 新增：保存周期和描述 ▼▼▼
                    newList.push({ id: Date.now().toString(), name, date, cycle, desc });
                    // ▲▲▲ ▲▲▲
                    saveCSData('anniversary_' + charId, newList).then(() => {

                        renderAnniversaryList(charId);
                        const modal = document.getElementById('add-anniversary-modal-overlay');
                        if (modal) {
                            modal.style.opacity = '0';
                            setTimeout(() => { modal.style.display = 'none'; }, 300);
                        }
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('纪念日已保存', 'success');
                    });
                });
                return;
            }
            // 6. 删除纪念日
            if (e.target.closest('.anniv-del-btn')) {
                e.stopPropagation();
                const btn = e.target.closest('.anniv-del-btn');
                const id = btn.getAttribute('data-id');
                const charId = tempState.currentChatId;
                loadCSData('anniversary_' + charId).then(list => {
                    if (!list) return;
                    const newList = list.filter(item => item.id !== id);
                    saveCSData('anniversary_' + charId, newList).then(() => {
                        renderAnniversaryList(charId);
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('已删除', 'success');
                    });
                });
                return;
            }
           // ▼▼▼ 【新增】心情日历交互逻辑 ▼▼▼
             // 1. 进入心情页面
            if (e.target.closest('#cs-mood-trigger')) {
                e.stopPropagation();
                document.querySelectorAll('.app-page').forEach(p => p.classList.remove('active'));
                const moodPage = document.getElementById('page-couple-mood');
                if (moodPage) {
                    window.scrollTo(0, 0);
                    moodPage.classList.add('active');

                    renderMoodCalendar(tempState.currentChatId, currentMoodCalDate);
                }
                return;
            }
            // 2. 退出心情页面
            if (e.target.closest('.cp-mood-back-btn')) {
                e.stopPropagation();
                const moodPage = document.getElementById('page-couple-mood');
                if (moodPage) moodPage.classList.remove('active');
                
                const spacePage = document.getElementById('page-couple-space');
                if (spacePage) {
                    window.scrollTo(0, 0);
                    spacePage.classList.add('active');

                    const scrollContent = spacePage.querySelector('.cs-scroll-content');
                    if (scrollContent) {
                        const oldZ = scrollContent.style.zIndex;
                        scrollContent.style.zIndex = '11';
                        setTimeout(() => scrollContent.style.zIndex = oldZ, 50);
                    }
                }
                return;
            }
            // 3. 翻页
            if (e.target.closest('#mood-cal-prev')) {
                e.stopPropagation();
                currentMoodCalDate.setMonth(currentMoodCalDate.getMonth() - 1);
                renderMoodCalendar(tempState.currentChatId, currentMoodCalDate);
                return;
            }
            if (e.target.closest('#mood-cal-next')) {
                e.stopPropagation();
                currentMoodCalDate.setMonth(currentMoodCalDate.getMonth() + 1);
                renderMoodCalendar(tempState.currentChatId, currentMoodCalDate);
                return;
            }
            // 4. 打开心情选择弹窗
            if (e.target.closest('#my-mood-selector')) {
                e.stopPropagation();
                const modal = document.getElementById('mood-picker-overlay');
                if (modal) {
                    showCSModal(modal);
                }
                return;
            }
            // 5. 关闭心情选择弹窗
            if (e.target.closest('#close-mood-picker-btn')) {
                e.stopPropagation();
                const modal = document.getElementById('mood-picker-overlay');
                if (modal) {
                    modal.style.opacity = '0';
                    setTimeout(() => { modal.style.display = 'none'; }, 300);
                }
                return;
            }
            // 6. 选择心情并保存
           const moodOption = e.target.closest('.mood-option');
            if (moodOption && e.target.closest('#mood-picker-overlay')) {
                e.stopPropagation();
                const moodVal = moodOption.dataset.mood;
                const charId = tempState.currentChatId;
                const todayStr = (() => { const d=new Date(); const tz=d.getTimezoneOffset()*60000; return new Date(d-tz).toISOString().split('T')[0];})();
                
                // 【第一步：立即关闭弹窗，给用户极速的交互反馈】
                const modal = document.getElementById('mood-picker-overlay');
                if (modal) {
                    modal.style.opacity = '0';
                    setTimeout(() => { modal.style.display = 'none'; }, 300);
                }
                // 【第二步：立即保存用户心情，并在后台请求 AI】
                loadCSData('mood_records_' + charId).then(async records => {
                    const list = records || {};
                    if (!list[todayStr]) list[todayStr] = {};
                    
                    list[todayStr].user = moodVal;
                    const needAi = !list[todayStr].char; // 判断Ta今天是否还没选过心情
                    
                    // 先把用户的心情存入数据库，立刻刷新页面，让用户看到自己的心情已经上去
                    await saveCSData('mood_records_' + charId, list);
                    renderMoodCalendar(charId, currentMoodCalDate);
                    
                    if (needAi) {
                        // 在界面上给个正在等待 Ta 反馈的浪漫提示
                        const charMoodText = document.getElementById('char-mood-text');
                        if (charMoodText) charMoodText.innerText = '正在感知...';
                        // ▼▼▼ 在后台静默请求 AI ▼▼▼
                        let aiMood = 'peace'; // 默认兜底
                        try {
                            const { url, key, model } = AppState.apiCurrentSettings || {};
                            if (url && key) {
                                const char = AppState.characterProfiles?.find(c => c.id === charId) || {name: 'Ta'};
                                const prompt = `你现在的身份是 ${char.name}。你的伴侣刚刚在情侣空间记录了TA今天的心情为：“${moodOption.dataset.text}”。请结合你的人设，以及你们之间的关系，决定你此时此刻回应TA的心情。
必须严格从以下 6 个纯英文单词中选择 1 个输出，绝对不要有任何标点符号或其他解释：
happy (开心) | sad (难过) | angry (生气) | peace (平静) | tired (疲惫) | love (超爱)`;
                                const response = await fetch(`${url.trim().replace(/\/$/, '')}/v1/chat/completions`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                                    body: JSON.stringify({
                                        model: model,
                                        messages: [{ role: 'user', content: prompt }],
                                        temperature: 0.7
                                    })
                                });
                                
                                if (response.ok) {
                                    const data = await response.json();
                                    let result = data.choices?.[0]?.message?.content?.trim().toLowerCase();
                                    result = result.replace(/[^a-z]/g, ''); 
                                    const validMoods = ['happy', 'sad', 'angry', 'peace', 'tired', 'love'];
                                    if (validMoods.includes(result)) aiMood = result;
                                }
                            }
                        } catch (e) {
                            console.error("[心情日历] AI获取心情失败，使用兜底心情", e);
                        }
                        
                        // 【第三步：AI 返回后，真正存入数据库并做最终刷新】
                        list[todayStr].char = aiMood;
                        await saveCSData('mood_records_' + charId, list);
                        renderMoodCalendar(charId, currentMoodCalDate); // 再次刷新，Ta的表情出现
                        
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('Ta 感应到了你的心情', 'success');
                        // 注入隐式记忆，让后面的聊天能够接上情绪
                        import('../state.js').then(async ({ db }) => {
                            if(db) {
                                const moodMap = { happy: '开心', sad: '难过', angry: '生气', peace: '平静', tired: '疲惫', love: '超爱' };
                                const charMoodZh = moodMap[list[todayStr].char] || '平静';
                                
                                const memoryPrompt = `<[系统隐式提示：用户刚刚在情侣空间记录了今日的心情为“${moodOption.dataset.text}”。同时你也感知到了这股情绪，回应了“${charMoodZh}”的心情。核心指令：这是一个背景动作，仅作为上下文记忆。接下来的聊天中如果合适，你可以自然地关心或呼应TA的情绪，绝不要复读本提示。]>`;
                                
                                const msgId = await db.chatMessages.add({
                                    chatId: charId, timestamp: new Date(), text: memoryPrompt,
                                    type: 'sent', uiVisible: false, aiVisible: true, recalled: false
                                });
                                const newMsg = await db.chatMessages.get(msgId);
                                if (AppState.currentChatHistory) AppState.currentChatHistory.push(newMsg);
                            }
                        });
                    } else {
                        // 如果 Ta 之前已经选过了（比如用户当天第二次改心情），就不呼叫AI了，直接提示
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('心情已更新', 'success');
                    }
                });
                return;
            }
            if (e.target.closest('#cs-coupon-trigger')) {
                e.stopPropagation();
                renderCouponList(tempState.currentChatId);
                document.querySelectorAll('.app-page').forEach(p => p.classList.remove('active'));
                const couponPage = document.getElementById('page-couple-coupon');
                if (couponPage) {
                    window.scrollTo(0, 0);
                    couponPage.classList.add('active');

                    const char = AppState.characterProfiles?.find(c => c.id === tempState.currentChatId);
                    if (char) document.getElementById('cc-dynamic-title').innerText = `与${char.name}的票夹`;
                }
                return;
            }
            // 2. 返回按钮
            if (e.target.closest('.cp-coupon-back-btn')) {
                e.stopPropagation();
                const couponPage = document.getElementById('page-couple-coupon');
                if (couponPage) couponPage.classList.remove('active');
                
                const spacePage = document.getElementById('page-couple-space');
                if (spacePage) {
                    window.scrollTo(0, 0);
                    spacePage.classList.add('active');
                    const scrollContent = spacePage.querySelector('.cs-scroll-content');
                    if (scrollContent) {
                        const oldZ = scrollContent.style.zIndex;
                        scrollContent.style.zIndex = '11';
                        setTimeout(() => scrollContent.style.zIndex = oldZ, 50);
                    }
                }
                return;
            }
            // 3. Tab切换 (适配两个页面的Tab)
            if (e.target.closest('.cc-tab-btn')) {
                e.stopPropagation();
                const btn = e.target.closest('.cc-tab-btn');
                const targetId = btn.getAttribute('data-target');
                // 让同级的Tab切换样式
                const parentTabs = btn.parentElement.querySelectorAll('.cc-tab-btn');
                parentTabs.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                if (targetId.startsWith('chat-')) {
                    document.getElementById('chat-my-coupons-list').style.display = targetId === 'chat-my-coupons' ? 'flex' : 'none';
                    document.getElementById('chat-ta-coupons-list').style.display = targetId === 'chat-ta-coupons' ? 'flex' : 'none';
                } else {
                    document.getElementById('cc-my-coupons-list').style.display = targetId === 'my-coupons' ? 'flex' : 'none';
                    document.getElementById('cc-ta-coupons-list').style.display = targetId === 'ta-coupons' ? 'flex' : 'none';
                }
                return;
            }
            if (e.target.closest('#chat-coupon-btn')) {
                e.stopPropagation();
                const charId = tempState.currentChatId;
                
                // 【修复】恢复权限检查，解绑后不能读取兑换券
                loadCSData('cs_unlocked_' + charId).then(statusObj => {
                    if (!statusObj || !statusObj.unlocked) {
                        const lockModal = document.getElementById('locked-couple-space-modal');
                        if (lockModal) {
                            showCSModal(lockModal);
                        }
                        return;
                    }
                    renderCouponList(charId);
                    const modal = document.getElementById('chat-coupon-modal-overlay');

                if (modal) {
                    showCSModal(modal);
                }
                       // 收起底部的功能面板
                    const funcPanel = document.getElementById('chat-function-panel');
                    if (funcPanel) funcPanel.classList.add('hidden');
                });
                
                return;
            }


            // 关闭锁的提示
            if (e.target.closest('#close-locked-space-btn')) {

                e.stopPropagation();
                const lockModal = document.getElementById('locked-couple-space-modal');
                if (lockModal) {
                    lockModal.style.opacity = '0'; // 先穿上隐形斗篷
                    setTimeout(() => { lockModal.style.display = 'none'; }, 300); // 等 300ms 动画播完再撤销物理体积
                }
                return;
            }

            // 关闭聊天版卡包弹窗
            if (e.target.closest('#close-chat-coupon-btn')) {
                e.stopPropagation();
                const modal = document.getElementById('chat-coupon-modal-overlay');
                if (modal) {
                    modal.style.opacity = '0'; // 先穿上隐形斗篷
                    setTimeout(() => { modal.style.display = 'none'; }, 300); // 等 300ms 动画播完再撤销物理体积
                }
                return;
            }

            // 聊天版卡包里点击制作新券
            if (e.target.closest('#chat-open-add-coupon-btn')) {
                e.stopPropagation();
                const modal = document.getElementById('add-coupon-modal-overlay');
                if (modal) {
                    showCSModal(modal);
                    document.getElementById('coupon-name-input').value = '';
                }
                return;
            }
            // ▲▲▲ 新增结束 ▲▲▲

            // 4. 打开添加弹窗
            if (e.target.closest('#cc-add-coupon-btn')) {
                e.stopPropagation();
                const modal = document.getElementById('add-coupon-modal-overlay');
                if (modal) {
                    showCSModal(modal);
                    document.getElementById('coupon-name-input').value = '';
                }
                return;
            }

            // 5. 关闭添加弹窗
            if (e.target.closest('#close-coupon-modal-btn')) {
                e.stopPropagation();
                const modal = document.getElementById('add-coupon-modal-overlay');
                if (modal) {
                    modal.style.opacity = '0';
                    setTimeout(() => { modal.style.display = 'none'; }, 300);
                }
                return;
            }

            // 6. 保存券
            if (e.target.closest('#save-coupon-btn')) {
                e.stopPropagation();
                const input = document.getElementById('coupon-name-input');
                const name = input ? input.value.trim() : '';
                if (!name) {
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('券名不能为空哦');
                    return;
                }
                
                const target = document.querySelector('input[name="coupon-target"]:checked').value;
                const charId = tempState.currentChatId;
                
                loadCSData('couple_coupons_' + charId).then(coupons => {
                    let list = coupons || [];
                    
                    // ▼▼▼ 新增：判断并限制每人最多5张 ▼▼▼
                    const targetCoupons = list.filter(c => c.target === target);
                    if (targetCoupons.length >= 5) {
                        const oldest = targetCoupons[0];
                        list = list.filter(c => c.id !== oldest.id);
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('背包已满，最旧的券已被替换', 'warning');
                    }
                    
                    list.push({
                        id: Date.now().toString(),
                        name: name,
                        target: target
                    });
                    
                    saveCSData('couple_coupons_' + charId, list).then(() => {
                        renderCouponList(charId);
                        const modal = document.getElementById('add-coupon-modal-overlay');
                        if (modal) {
                            modal.style.opacity = '0';
                            setTimeout(() => { modal.style.display = 'none'; }, 300);
                        }
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('兑换券已放入票夹', 'success');

                                          // ▼▼▼ 新增：注入即时隐形记忆，让AI立刻知道有了新券 ▼▼▼
                        import('../state.js').then(async ({ db }) => {
                            if(db) {
                                // 【修正】明确区分“用户”和“你(AI角色)”，防止 AI 混淆是谁的背包
                                const actionText = target === 'char' ? `用户送给了你(角色)一张名为【${name}】的兑换券，已放入你的背包` : `用户为TA自己写了一张名为【${name}】的兑换券，存放在了用户的专属背包中`;
                                const memoryPrompt = `<[系统隐式提示：${actionText}。核心指令：这是一个背景动作，仅作为上下文记忆。在接下来的聊天中如果合适，你可以非常自然地根据人设对此做出反应（如打趣、傲娇或感谢），绝不要复读本提示。]>`;

                                const msgId = await db.chatMessages.add({
                                    chatId: charId, timestamp: new Date(), text: memoryPrompt,
                                    type: 'sent', uiVisible: false, aiVisible: true, recalled: false
                                });
                                const newMsg = await db.chatMessages.get(msgId);
                                if (AppState.currentChatHistory) AppState.currentChatHistory.push(newMsg);
                            }
                        });
                        // ▲▲▲ 新增结束 ▲▲▲
                    });
                });
                return;
            }

            // 7. 用户手动核销自己的券

            if (e.target.closest('.t-action-btn:not(.disabled)')) {
                e.stopPropagation();
                const btn = e.target.closest('.t-action-btn');
                const id = btn.getAttribute('data-id');
                const charId = tempState.currentChatId;
                loadCSData('couple_coupons_' + charId).then(coupons => {
                    const list = coupons || [];
                    const targetCoupon = list.find(c => c.id === id);
                    if (!targetCoupon) return;
                    
                    const newList = list.filter(c => c.id !== id);
                    
                    // ▼▼▼ 【新增】卡片撕毁动效 ▼▼▼
                    const cardEl = btn.closest('.cc-ticket-card');
                    if (cardEl) {
                        cardEl.style.transition = 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
                        cardEl.style.transform = 'scale(0.8) translateY(20px)';
                        cardEl.style.opacity = '0';
                    }

                    // 等待卡片动画结束再保存和提示
                    setTimeout(() => {
                        saveCSData('couple_coupons_' + charId, newList).then(() => {
                            renderCouponList(charId);
                            if (typeof showDynamicIsland === 'function') showDynamicIsland(`成功使用了【${targetCoupon.name}】`, 'success');
                            
                            // 【触发全局核销动画】
                            document.dispatchEvent(new CustomEvent('play_coupon_animation'));

                            // 【注入隐式记忆与灰色界面提示】
                            import('../state.js').then(async ({ db }) => {
                                if(db) {
                                    // 1. 隐式记忆注入 (明确主语，且强制要求它【绝对不要立刻作答】)
                                    const memoryPrompt = `<[系统隐式提示：用户刚刚撕下并使用了TA自己背包里的一张【${targetCoupon.name}】兑换券。核心指令：这是一个背景动作，仅作为上下文记忆，【绝对不要立刻作答】。在随后的聊天中，如果合适，你可以自然地回应用户的这个使用行为。]>`;
                                    const msgId = await db.chatMessages.add({
                                        chatId: charId, timestamp: new Date(), text: memoryPrompt,
                                        type: 'sent', uiVisible: false, aiVisible: true, recalled: false
                                    });
                                    const newMsg = await db.chatMessages.get(msgId);
                                    if (AppState.currentChatHistory) AppState.currentChatHistory.push(newMsg);

                                    // 2. 在对话界面插入可见的居中灰色系统消息
                                    import('./chat-service.js').then(({ addSystemEventMessage }) => {
                                        addSystemEventMessage(charId, `🎫 你撕下并使用了一张【${targetCoupon.name}】`, 'info');
                                    });
                                }
                            });
                        });
                    }, 350);
                    // ▲▲▲ 新增结束 ▲▲▲
                });

                return;
            }
            // ▲▲▲ 新增结束 ▲▲▲

            // ▼▼▼ 【新增】情绪板的交互逻辑 ▼▼▼
             // 1. 点击主页情绪板，或者主页的添加按钮，进入详情页
            if (e.target.closest('#cs-memo-trigger')) {
                e.stopPropagation();
                renderCorkboard(tempState.currentChatId);
                document.querySelectorAll('.app-page').forEach(p => p.classList.remove('active'));
                const corkboardPage = document.getElementById('page-couple-corkboard');
                if (corkboardPage) {
                    window.scrollTo(0, 0);
                    corkboardPage.classList.add('active');

                    const char = AppState.characterProfiles?.find(c => c.id === tempState.currentChatId);
                    if (char) document.getElementById('rc-dynamic-title').innerText = `${char.name} 的情绪板`;
                }
                return;
            }
            // 2. 详情页返回按钮
            if (e.target.closest('.rc-back-btn')) {
                e.stopPropagation();
                const corkboardPage = document.getElementById('page-couple-corkboard');
                if (corkboardPage) corkboardPage.classList.remove('active');
                
                const spacePage = document.getElementById('page-couple-space');
                if (spacePage) {
                    window.scrollTo(0, 0);
                    spacePage.classList.add('active');

                    const scrollContent = spacePage.querySelector('.cs-scroll-content');
                    if (scrollContent) {
                        const oldZ = scrollContent.style.zIndex;
                        scrollContent.style.zIndex = '11';
                        setTimeout(() => scrollContent.style.zIndex = oldZ, 50);
                    }
                }
                return;
            }

            // 3. 点击详情页的添加按钮，呼出添加弹窗
            if (e.target.closest('#rc-add-note-btn')) {
                e.stopPropagation();
                const modal = document.getElementById('add-corkboard-note-overlay');
                if (modal) {
                    showCSModal(modal);
                    document.getElementById('corkboard-note-input').value = '';
                }
                return;
            }

            // 4. 关闭添加弹窗
            if (e.target.closest('#close-corkboard-note-btn')) {
                e.stopPropagation();
                const modal = document.getElementById('add-corkboard-note-overlay');
                if (modal) {
                    modal.style.opacity = '0';
                    setTimeout(() => { modal.style.display = 'none'; }, 300);
                }
                return;
            }

            // 5. 保存新的纸条
            if (e.target.closest('#save-corkboard-note-btn')) {
                e.stopPropagation();
                const input = document.getElementById('corkboard-note-input');
                const content = input ? input.value.trim() : '';
                if (!content) {
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('纸条内容不能为空哦');
                    return;
                }
                     const charId = tempState.currentChatId;
                loadCSData('corkboard_notes_' + charId).then(notes => {
                    const list = notes || [];
                    list.push({
                        timestamp: Date.now(),
                        type: 'user', 
                        content: content
                    });

                    // ▼▼▼ 【新增】用户端的数据库容量保护，永远只存最新 100 条 ▼▼▼
                    if (list.length > 100) {
                        list.sort((a, b) => b.timestamp - a.timestamp);
                        list.splice(100);
                    }
                    // ▲▲▲ 新增结束 ▲▲▲

                    saveCSData('corkboard_notes_' + charId, list).then(() => {
                        renderCorkboard(charId);

                        const modal = document.getElementById('add-corkboard-note-overlay');
                        if (modal) {
                            modal.style.opacity = '0';
                            setTimeout(() => { modal.style.display = 'none'; }, 300);
                        }
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('纸条已贴上情绪板', 'success');
                        
                                              import('../state.js').then(async ({ db }) => {
                            if(db) {
                                        // 修改了提示词，告诉AI这只是背景记忆，不要立刻回复
                                const memoryPrompt = `<[系统隐式提示：用户刚刚在情侣空间的情绪板上贴了一张新纸条："${content}"。核心指令：这是一个背景动作，仅作为上下文记忆，你不需要立刻作出回复。在接下来的聊天中如果合适，你可以非常自然地提及刚才用户写下的情绪。]>`;
                                const msgId = await db.chatMessages.add({
                                    chatId: charId, timestamp: new Date(), text: memoryPrompt,
                                    type: 'sent', uiVisible: false, aiVisible: true, recalled: false
                                });

                                // ▼▼▼ 【新增】把消息ID回写到刚才保存的那条便签上 ▼▼▼
                                const freshNotes = await loadCSData('corkboard_notes_' + charId) || [];
                                const justSavedNote = freshNotes.find(n => n.content === content && !n.linkedMsgId);
                                if (justSavedNote) {
                                    justSavedNote.linkedMsgId = msgId;
                                    await saveCSData('corkboard_notes_' + charId, freshNotes);
                                }
                                // ▲▲▲ 新增结束 ▲▲▲

                                const newMsg = await db.chatMessages.get(msgId);
                                if (AppState.currentChatHistory) AppState.currentChatHistory.push(newMsg);
                                // 删除了 triggerAiResponse 的调用，这样就不会触发AI自动发消息了

                            }
                        });

                    });
                });
                return;
            }
            // ▼▼▼ 【新增】呼叫 AI 自动写一张纸条钉在板子上 ▼▼▼
            if (e.target.closest('#ask-char-note-btn')) {
                e.stopPropagation();
                const btn = e.target.closest('#ask-char-note-btn');
                if (btn.disabled) return;
                
                const charId = tempState.currentChatId;
                const char = AppState.characterProfiles?.find(c => c.id === charId) || {name: 'Ta'};
                const currentUser = getCurrentChatIdentity(charId) || { name: 'User' };
                const userName = char.chatOverrideUserNickname || currentUser.name;

                btn.disabled = true;
                const originalHtml = btn.innerHTML;
                // 按钮进入加载动画状态
                btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:16px;height:16px;animation: cs-spin-slow 1s linear infinite;"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg> <span>Ta正在提笔...</span>`;
                import('./memory.js').then(async ({ getMemoriesForPrompt }) => {
                    // 获取完整上下文：记忆、世界书、最近聊天
                    const { getWorldBookForPrompt } = await import('../state.js');
                    const { getCombinedFormattedHistory } = await import('./chat-service.js').catch(() => ({}));

                    const memoryContext = getMemoriesForPrompt ? await getMemoriesForPrompt(charId) : '无记忆';
                    const worldBookContext = await getWorldBookForPrompt(charId).catch(() => '无世界观');
                    
                    let recentVibeText = '无近期对话';
                    // 安全地获取最近聊天记录，如果函数不存在则跳过
                    try {
                        const contextTurns = char.contextTurns || 15;
                        const { db } = await import('../state.js');
                        const recentMsgs = await db.chatMessages.where({ chatId: charId }).reverse().limit(contextTurns * 2).toArray();
                        recentMsgs.reverse();
                        if (recentMsgs.length > 0) {
                            recentVibeText = recentMsgs
                                .filter(m => m.text && !m.text.startsWith('<[') && m.uiVisible !== false)
                                .slice(-20)
                                .map(m => `${m.type === 'sent' ? userName : char.name}: ${m.text.substring(0, 50)}`)
                                .join('\n');
                        }
                    } catch(e) { console.warn('获取聊天记录用于情绪板失败', e); }

                    const prompt = `[System Preamble: Mood Board Note Writing Directive]

**Part 1: You Are ${char.name}. Embody Completely.**
You just opened the shared "Mood Board" (情绪板) in your couples' app. This is a space for you and ${userName} to leave sticky notes for each other — sharing feelings, worries, sweetness, or even complaints.

*   **Identity Lock**: You ARE ${char.name}. Every word must come from the personality, habits, and emotional state defined in your <Persona>.
*   **Emotional Realism**: Your note must reflect your CURRENT genuine emotional state. It can be sweet, worried, annoyed, clingy, or melancholic. DO NOT default to generic sweetness.

**Part 2: What a REAL Sticky Note Sounds Like (CRITICAL)**
1.  **It's a note, not a poem.** Write like a real human scribbling a thought. Short, fragmented, colloquial. NO literary language, NO metaphors, NO full stops (。).
2.  **Emotional Depth**: This note can be:
    *   甜蜜 (Sweet): "冰箱里给你留了草莓"
    *   委屈/抱怨 (Upset/Complaint): "今天你和我吵架 你根本不在意我为什么吵 只是一个劲道歉 我不喜欢"
    *   碎碎念 (Murmur): "今天加班好累 想你了"
    *   撒娇 (Clingy): "你多久没抱我了"
    *   关心 (Caring): "降温了 出门记得穿厚点"
3.  **Connection to Reality**: Read the <Recent_Vibe> carefully. Your note SHOULD be a genuine reflection of your current mood, which is influenced by your recent interactions. If you just argued, express that feeling. If things are going well, share a sweet moment.
4.  **Length**: 1 to 3 short sentences. Under 40 characters is ideal.
5.  **Forbidden**: NO emojis. NO "亲爱的". NO "宝贝". NO generic pet names. Just raw, honest feelings.

**Part 3: Context Database**
<Persona>
${char.persona || '未设置'}
</Persona>
<User_Profile>
${currentUser.persona || '未设置'}
</User_Profile>
<Memory_Context>
${memoryContext}
</Memory_Context>
<World_Book>
${worldBookContext}
</World_Book>
<Recent_Vibe>
${recentVibeText}
</Recent_Vibe>

**[FINAL INSTRUCTION]**: Now, as ${char.name}, write ONE sticky note. Output ONLY the raw text of the note in Chinese. No JSON, no quotes, no explanations. Begin.`;

                    const { url, key, model } = AppState.apiCurrentSettings || {};
                    if (!url || !key) throw new Error('No API Settings');

                    const response = await fetch(`${url.trim().replace(/\/$/, '')}/v1/chat/completions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                        body: JSON.stringify({
                            model: model,
                            messages: [{ role: 'user', content: prompt }],
                            temperature: 0.85
                        })
                    });

                    if (!response.ok) throw new Error('API Error');
                    const data = await response.json();
                    let aiText = data.choices?.[0]?.message?.content?.trim();
                    if (!aiText) throw new Error('Empty response');
                    
                    // 清除可能带有的首尾引号
                    aiText = aiText.replace(/^["']|["']$/g, '');

                    // 保存并刷新
                    loadCSData('corkboard_notes_' + charId).then(notes => {
                        const list = notes || [];
                        list.push({ timestamp: Date.now(), type: 'char', content: aiText });
                        saveCSData('corkboard_notes_' + charId, list).then(() => {
                            renderCorkboard(charId); // 调用引擎重新渲染排版
                            if(typeof showDynamicIsland === 'function') showDynamicIsland('Ta 在软木板上留下了一张纸条', 'success');
                        });
                    });
                }).catch(e => {
                    console.error(e);
                    if(typeof showDynamicIsland === 'function') showDynamicIsland('Ta现在有点忙，稍后再叫Ta吧', 'error');
                }).finally(() => {
                    btn.disabled = false;
                    btn.innerHTML = originalHtml;
                });
                return;
            }
             // 6. 删除纸条
            if (e.target.closest('.rc-note-del-btn')) {
                e.stopPropagation();
                const btn = e.target.closest('.rc-note-del-btn');
                const timestamp = parseInt(btn.dataset.id);
                const charId = tempState.currentChatId;
                loadCSData('corkboard_notes_' + charId).then(async notes => {
                    if (!notes) return;
                    
                    // ▼▼▼ 【新增】精准删除这张便签绑定的隐形上下文消息 ▼▼▼
                    const noteToDelete = notes.find(n => n.timestamp === timestamp);
                    if (noteToDelete && noteToDelete.linkedMsgId) {
                        try {
                            const { db } = await import('../state.js');
                            if (db) {
                                await db.chatMessages.delete(noteToDelete.linkedMsgId);
                                if (AppState.currentChatHistory) {
                                    const idx = AppState.currentChatHistory.findIndex(m => m.id === noteToDelete.linkedMsgId);
                                    if (idx !== -1) AppState.currentChatHistory.splice(idx, 1);
                                }
                            }
                        } catch(e) { console.warn('删除关联消息失败', e); }
                    }
                    // ▲▲▲ 新增结束 ▲▲▲

                    const newNotes = notes.filter(n => n.timestamp !== timestamp);
                    saveCSData('corkboard_notes_' + charId, newNotes).then(() => {
                        renderCorkboard(charId);
                    });
                });
                return;
            }

            // ▼▼▼ 【新增】情书信箱全套强效点击跳转逻辑 ▼▼▼
            // ▼▼▼ 【全新】情书信箱全套交互逻辑 ▼▼▼
             // 1. 点击外部信箱入口，进入信箱页面
            if (e.target.closest('#cs-mailbox-trigger')) {
                e.stopPropagation();
                
                // ▼▼▼ 调用渲染引擎读取信件 ▼▼▼
                renderMailboxList(tempState.currentChatId);

                // 【修复iOS Bug】不直接操作 style.display = 'none'，仅通过 active 类名隐藏
                document.querySelectorAll('.app-page').forEach(p => p.classList.remove('active'));
                const mailboxPage = document.getElementById('page-couple-mailbox');

                if (mailboxPage) {
                    window.scrollTo(0, 0);
                    mailboxPage.classList.add('active');

                    document.getElementById('rm-list-view').style.display = 'block';
                    document.getElementById('rm-bottom-actions').style.display = 'flex'; // 显示双按钮
                    document.getElementById('rm-read-view').style.display = 'none';
                    const char = AppState.characterProfiles?.find(c => c.id === tempState.currentChatId);
                    if (char) document.getElementById('rm-dynamic-title').innerText = `${char.name} 的信箱`;
                }
                return;
            }
            // 2. 终极修复：信箱返回按钮逻辑 (包含 iOS 滚动条死机强制唤醒)
            if (e.target.closest('.rm-back-btn')) {
                e.stopPropagation();
                const readView = document.getElementById('rm-read-view');
                const listView = document.getElementById('rm-list-view');
                const bottomActions = document.getElementById('rm-bottom-actions');
                           // 判断当前是不是在“读信/写信”页面
                if (readView && readView.style.display !== 'none') {
                    readView.style.display = 'none';
                    if (listView) listView.style.display = 'block';
                    if (bottomActions) bottomActions.style.display = 'flex';
                    
                    // ▼▼▼ 第1道护栏：退出时清空临时数据，防止残留导致误触发 ▼▼▼
                    const correctionInput = document.getElementById('rm-correction-input');
                    if (correctionInput) correctionInput.value = '';
                    const saveBtn = document.getElementById('rm-save-paper-btn');
                    if (saveBtn) saveBtn.dataset.currentLetterId = '';
                    // ▲▲▲ 防呆清理结束 ▲▲▲

                } else {
                    // 退回到外面的恋爱空间主页

                   const mailboxPage = document.getElementById('page-couple-mailbox');
                    if (mailboxPage) mailboxPage.classList.remove('active');
                    
                    const spacePage = document.getElementById('page-couple-space');
                    if (spacePage) {
                        window.scrollTo(0, 0);
                        spacePage.classList.add('active');
                        // 【专治苹果iOS Bug】强行微调 Z-index 触发浏览器重绘，唤醒被冻结的滚动层
                        const scrollContent = spacePage.querySelector('.cs-scroll-content');
                        if (scrollContent) {
                            const oldZ = scrollContent.style.zIndex;
                            scrollContent.style.zIndex = '11';
                            setTimeout(() => scrollContent.style.zIndex = oldZ, 50);
                        }
                    }
                }
                return;
            }
            // 3. 点击真实信封卡片 -> 触发拆信动画 -> 打开读信模式
            if (e.target.closest('.rm-real-envelope')) {
                e.stopPropagation();
                const envelope = e.target.closest('.rm-real-envelope');
                               // ▼▼▼ 【新增】如果是删除模式，拦截普通点击，改为选中/取消选中 ▼▼▼
                const mailboxPage = document.querySelector('.rococo-mailbox-page');
                if (mailboxPage && mailboxPage.classList.contains('delete-mode')) {
                    envelope.classList.toggle('selected');
                    // 计算并更新数量
                    const selectedCount = document.querySelectorAll('.rm-real-envelope.selected').length;
                    document.getElementById('rm-selected-count').innerText = `已选择 ${selectedCount} 封`;
                    return; // 直接 return，不执行下面的拆信动画
                }
                // ▲▲▲ 新增结束 ▲▲▲

                const item = e.target.closest('.rm-timeline-item');
                const letterId = item ? parseInt(item.dataset.id) : null;
                
                // 性能与防抖逻辑
                if (envelope.classList.contains('is-opening')) return;
                envelope.classList.add('is-opening');
                
                setTimeout(async () => {
                    document.getElementById('rm-list-view').style.display = 'none';
                    document.getElementById('rm-bottom-actions').style.display = 'none'; 
                    document.getElementById('rm-read-view').style.display = 'block';
                    
                    const contentArea = document.getElementById('rm-read-content');
                    contentArea.readOnly = true;
                    document.getElementById('rm-save-paper-btn').dataset.currentLetterId = letterId || '';
                    // ▼▼▼ 【新增】读取数据库中的信件内容填入信纸 ▼▼▼
                    if (letterId) {
                        const letters = await loadCSData('mailbox_letters_' + tempState.currentChatId) || [];
                        const letter = letters.find(l => l.timestamp === letterId);
                        if (letter) {
                            contentArea.value = letter.content;
                                                  const dateObj = new Date(letter.timestamp);
                            document.getElementById('rm-read-date').innerText = `${dateObj.getFullYear()}.${dateObj.getMonth()+1}.${dateObj.getDate()}`;
                             const char = AppState.characterProfiles?.find(c => c.id === tempState.currentChatId) || {name: 'Ta'};
                            const baseUser = getCurrentChatIdentity(tempState.currentChatId) || {name: 'Me'}; // 使用统一身份获取
                               const userName = char.chatOverrideUserNickname || baseUser.name;
                            document.getElementById('rm-read-sender').innerText = letter.type === 'user' ? `To: ${char.name}` : `To: ${userName}`;

                                 // ▼▼▼ 【全新设计：手账风半透明硫酸纸批注】 ▼▼▼

                            const correctionArea = document.getElementById('rm-correction-area');
                            const correctionInput = document.getElementById('rm-correction-input');
                            
                            // ▼▼▼ 【核心修复】：读信时，必须强制把批注大框显示出来，抵消掉写信时的隐藏状态 ▼▼▼
                            correctionArea.style.display = 'block';

                            // 先清理旧的动态元素（防止重复生成）
                            const oldDisplay = document.getElementById('rm-ai-annotation-wrapper');

                            if (oldDisplay) oldDisplay.remove();

                            if (letter.type === 'user') {
                                // 隐藏原本冷硬的输入框结构
                                correctionArea.style.background = 'transparent';
                                correctionArea.style.border = 'none';
                                correctionArea.style.padding = '0';
                                correctionArea.querySelector('.title').style.display = 'none';
                                correctionInput.style.display = 'none';
                                                                // ▼▼▼ 【核心修复】：读自己写的信时，把Ta信里的“撕掉重写”按钮彻底隐藏 ▼▼▼
                                const existRewriteBtn = document.getElementById('rm-rewrite-letter-btn');
                                if (existRewriteBtn) existRewriteBtn.style.display = 'none';
                                // ▲▲▲ 修复结束 ▲▲▲

                                // 创建全新的日杂手账风批注容器
                                const aiWrapper = document.createElement('div');
                                aiWrapper.id = 'rm-ai-annotation-wrapper';
                                aiWrapper.style.cssText = `
                                    position: relative;
                                    margin-top: 25px;
                                    padding: 25px 20px 20px;
                                    background: rgba(253, 251, 248, 0.7);
                                    backdrop-filter: blur(8px);
                                    -webkit-backdrop-filter: blur(8px);
                                    border: 1px solid rgba(214, 197, 179, 0.6);
                                    border-radius: 4px 16px 16px 16px;
                                    box-shadow: 2px 6px 15px rgba(163, 149, 143, 0.08);
                                `;

                                // 顶部浪漫粉色纸胶带装饰
                                const tape = document.createElement('div');
                                tape.style.cssText = `
                                    position: absolute;
                                    top: -8px; left: 20px;
                                    width: 45px; height: 16px;
                                    background: rgba(211, 167, 165, 0.6);
                                    transform: rotate(-3deg);
                                `;
                                aiWrapper.appendChild(tape);

                                // 精致的英文副标题 & 重新生成按钮
                                const titleRow = document.createElement('div');
                                titleRow.style.cssText = `
                                    font-family: "Georgia", serif;
                                    font-size: 10px;
                                    color: #C08A88;
                                    font-style: italic;
                                    letter-spacing: 1.5px;
                                    margin-bottom: 15px;
                                    display: flex; justify-content: space-between; align-items: center;
                                `;
                                titleRow.innerHTML = `<span>REPLY & NOTES</span>`;
                                
                                // 重新生成按钮 (做成极简的右上角刷新小图标)
                                const regenBtn = document.createElement('button');
                                regenBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:14px;height:14px;"><path d="M2.5 2v6h6M21.5 22v-6h-6"/><path d="M22 11.5A10 10 0 0 0 3.2 7.2M2 12.5a10 10 0 0 0 18.8 4.2"/></svg>`;
                                regenBtn.style.cssText = `
                                    background: transparent; border: none; color: #C08A88; 
                                    cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center;
                                    transition: background 0.2s, color 0.2s; border-radius: 50%;
                                `;
                                regenBtn.onmouseenter = () => { regenBtn.style.background = 'rgba(211, 167, 165, 0.15)'; regenBtn.style.color = '#A37270'; };
                                regenBtn.onmouseleave = () => { regenBtn.style.background = 'transparent'; regenBtn.style.color = '#C08A88'; };
                                titleRow.appendChild(regenBtn);
                                aiWrapper.appendChild(titleRow);

                                // 批注正文 (模拟墨水钢笔手写体)
                                const textDisplay = document.createElement('div');
                                textDisplay.style.cssText = `
                                    font-family: "Georgia", "STKaiti", "KaiTi", "楷体", serif;
                                    font-size: 15px;
                                    color: #5C4D42;
                                    line-height: 1.8;
                                    letter-spacing: 1px;
                                    font-weight: 600;
                                    white-space: pre-wrap;
                                    text-shadow: 0.5px 0.5px 0px rgba(92, 77, 66, 0.05);
                                    transition: opacity 0.3s ease;
                                `;
                                textDisplay.innerText = letter.aiAnnotation || "（Ta已经收到了你的信，小心翼翼地收好，虽然没说话，但心里很暖...）";
                                aiWrapper.appendChild(textDisplay);

                                correctionArea.appendChild(aiWrapper);

                                // 重新生成逻辑 (带旋转动画)
                                regenBtn.onclick = async (ev) => {
                                    ev.stopPropagation();
                                    if (regenBtn.disabled) return;
                                    regenBtn.disabled = true;
                                    
                                    // 启动原生旋转动画
                                    const spinAnim = regenBtn.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 800, iterations: Infinity });
                                    textDisplay.style.opacity = '0.4';
                                    
                                    try {
                                        const { generateLetterAnnotation } = await import('./chat-service.js');
                                        const newAnnotation = await generateLetterAnnotation(tempState.currentChatId, letter.content);
                                        
                                        if (newAnnotation) {
                                            textDisplay.innerText = newAnnotation;
                                            // 更新数据库
                                            const letters = await loadCSData('mailbox_letters_' + tempState.currentChatId) || [];
                                            const target = letters.find(l => l.timestamp === letterId);
                                            if (target) {
                                                target.aiAnnotation = newAnnotation;
                                                await saveCSData('mailbox_letters_' + tempState.currentChatId, letters);
                                            }
                                        } else {
                                            if (typeof showDynamicIsland === 'function') showDynamicIsland('Ta现在脑子有点乱，稍后再试吧~', 'error');
                                        }
                                    } catch(e) {
                                        console.error(e);
                                    } finally {
                                        spinAnim.cancel();
                                        textDisplay.style.opacity = '1';
                                        regenBtn.disabled = false;
                                    }
                                };
                            } else {
                                // 如果是Ta写的信，完美恢复原本的输入框结构
                                correctionArea.style.background = '#FAF7F5';
                                correctionArea.style.border = '1px dashed #E4DBD3';
                                correctionArea.style.padding = '15px';
                                correctionArea.querySelector('.title').style.display = 'flex';
                                correctionArea.querySelector('.title').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px;margin-right:4px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg> 我的批注`;
                                correctionInput.style.display = 'block';
                                correctionInput.value = letter.userCorrection || '';
                                
                                // ▼▼▼ 【新增】重新生成Ta的情书功能 (撕掉重写) ▼▼▼
                                let rewriteBtn = document.getElementById('rm-rewrite-letter-btn');
                                if (!rewriteBtn) {
                                    rewriteBtn = document.createElement('button');
                                    rewriteBtn.id = 'rm-rewrite-letter-btn';
                                    rewriteBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="width:12px;height:12px;margin-right:4px;"><path d="M2.5 2v6h6M21.5 22v-6h-6"/><path d="M22 11.5A10 10 0 0 0 3.2 7.2M2 12.5a10 10 0 0 0 18.8 4.2"/></svg> 撕掉重写`;
                                    // 洛可可小巧按钮样式，悬浮在“我的批注”框的右上角
                                    rewriteBtn.style.cssText = `position: absolute; top: 12px; right: 15px; background: transparent; border: 1px solid #E4DBD3; border-radius: 12px; font-size: 10px; color: #BCAAA4; padding: 4px 8px; cursor: pointer; display: flex; align-items: center; transition: 0.2s; font-weight: 600;`;
                                    rewriteBtn.onmouseenter = () => { rewriteBtn.style.color = '#8F847A'; rewriteBtn.style.borderColor = '#CFC5BC'; rewriteBtn.style.background = '#F0EBE6'; };
                                    rewriteBtn.onmouseleave = () => { rewriteBtn.style.color = '#BCAAA4'; rewriteBtn.style.borderColor = '#E4DBD3'; rewriteBtn.style.background = 'transparent'; };
                                    correctionArea.appendChild(rewriteBtn);
                                }
                                rewriteBtn.style.display = 'flex'; 
                                
                                // 绑定重写事件
                                rewriteBtn.onclick = async (ev) => {
                                    ev.stopPropagation();
                                    if (rewriteBtn.disabled) return;
                                    rewriteBtn.disabled = true;
                                    rewriteBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px;margin-right:4px; animation: cs-spin-slow 1s linear infinite;"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg> 构思中...`;
                                    
                                    // 信纸正文变淡，营造沉浸式等待感
                                    contentArea.style.opacity = '0.4'; 
                                    contentArea.style.transition = 'opacity 0.3s';
                                    
                                    try {
                                        const { generateLoveLetter } = await import('./chat-service.js');
                                        const newLetterContent = await generateLoveLetter(tempState.currentChatId);
                                        
                                        if (newLetterContent) {
                                            // 替换屏幕上的文字
                                            contentArea.value = newLetterContent;
                                            letter.content = newLetterContent;
                                            // 物理更新数据库中的这封信
                                            const letters = await loadCSData('mailbox_letters_' + tempState.currentChatId) || [];
                                            const target = letters.find(l => l.timestamp === letterId);
                                            if (target) {
                                                target.content = newLetterContent;
                                                await saveCSData('mailbox_letters_' + tempState.currentChatId, letters);
                                            }
                                        } else {
                                            if (typeof showDynamicIsland === 'function') showDynamicIsland('Ta思路卡壳了，稍后再试吧', 'error');
                                        }
                                    } catch (err) {
                                        console.error(err);
                                    } finally {
                                        contentArea.style.opacity = '1';
                                        rewriteBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="width:12px;height:12px;margin-right:4px;"><path d="M2.5 2v6h6M21.5 22v-6h-6"/><path d="M22 11.5A10 10 0 0 0 3.2 7.2M2 12.5a10 10 0 0 0 18.8 4.2"/></svg> 撕掉重写`;
                                        rewriteBtn.disabled = false;
                                    }
                                };
                                // ▲▲▲ 新增结束 ▲▲▲
                            }
                            // ▲▲▲ 更新结束 ▲▲▲


                        }
                    }
                    // ▲▲▲ 新增结束 ▲▲▲

                    envelope.classList.remove('is-opening');

                }, 550);
                
                return;
            }
            // ▼▼▼ 【新增】情书删除的核心事件绑定 ▼▼▼
            // A. 点击菜单里的“删除信件”
            if (e.target.closest('#rm-btn-delete-mode')) {
                e.stopPropagation();
                document.getElementById('rm-more-popover').style.display = 'none'; // 隐藏下拉菜单
                const mailboxPage = document.querySelector('.rococo-mailbox-page');
                if (mailboxPage) {
                    mailboxPage.classList.add('delete-mode'); // 页面进入删除状态
                    document.getElementById('rm-bottom-actions').style.display = 'none'; // 隐藏原有的写信双按钮
                    document.getElementById('rm-multi-delete-bar').style.display = 'flex'; // 显示删除操作条
                    document.getElementById('rm-selected-count').innerText = '请选择信件';
                    // 清空所有可能遗留的选中状态
                    document.querySelectorAll('.rm-real-envelope.selected').forEach(el => el.classList.remove('selected'));
                }
                return;
            }

            // B. 取消删除模式
            if (e.target.closest('#rm-delete-cancel')) {
                e.stopPropagation();
                const mailboxPage = document.querySelector('.rococo-mailbox-page');
                if (mailboxPage) {
                    mailboxPage.classList.remove('delete-mode');
                    document.getElementById('rm-bottom-actions').style.display = 'flex';
                    document.getElementById('rm-multi-delete-bar').style.display = 'none';
                    document.querySelectorAll('.rm-real-envelope.selected').forEach(el => el.classList.remove('selected'));
                }
                return;
            }

            // C. 确认真实删除
            if (e.target.closest('#rm-delete-confirm')) {
                e.stopPropagation();
                const selectedItems = document.querySelectorAll('.rm-real-envelope.selected');
                if (selectedItems.length === 0) {
                    if(typeof showDynamicIsland === 'function') showDynamicIsland('未选择任何信件');
                    return;
                }
                
                // 收集所有被选中信件的 timestamp (它是信件的唯一ID)
                const idsToDelete = Array.from(selectedItems).map(envelope => {
                    const item = envelope.closest('.rm-timeline-item');
                    return parseInt(item.dataset.id);
                });

                const charId = tempState.currentChatId;
                
                // 执行真实的数据库抹除操作
                loadCSData('mailbox_letters_' + charId).then(letters => {
                    if (!letters) return;
                    // 过滤掉包含在待删除ID列表中的信件
                    const newLetters = letters.filter(l => !idsToDelete.includes(l.timestamp));
                    
                    saveCSData('mailbox_letters_' + charId, newLetters).then(() => {
                        // 退出删除模式并重新渲染页面
                        const mailboxPage = document.querySelector('.rococo-mailbox-page');
                        if (mailboxPage) mailboxPage.classList.remove('delete-mode');
                        document.getElementById('rm-bottom-actions').style.display = 'flex';
                        document.getElementById('rm-multi-delete-bar').style.display = 'none';
                        
                        renderMailboxList(charId); // 引擎重新绘制DOM
                        if(typeof showDynamicIsland === 'function') showDynamicIsland(`成功销毁 ${idsToDelete.length} 封信件`, 'success');
                    });
                });
                return;
            }
            // ▲▲▲ 新增结束 ▲▲▲

            // 4. 点击“亲笔写下”按钮 -> 打开写信模式
            if (e.target.closest('#rm-btn-write-me')) {
                e.stopPropagation();
                document.getElementById('rm-list-view').style.display = 'none';
                document.getElementById('rm-bottom-actions').style.display = 'none';
                document.getElementById('rm-read-view').style.display = 'block';
                
                const contentArea = document.getElementById('rm-read-content');
                contentArea.value = ''; // 清空内容
                contentArea.readOnly = false; // 允许输入
                contentArea.focus();
                
                const char = AppState.characterProfiles?.find(c => c.id === tempState.currentChatId) || {name: 'Ta'};
                document.getElementById('rm-read-sender').innerText = `To: ${char.name}`;
                document.getElementById('rm-correction-area').style.display = 'none'; // 写信时无批注区
                
                const today = new Date();
                document.getElementById('rm-read-date').innerText = `${today.getFullYear()}.${today.getMonth()+1}.${today.getDate()}`;
                return;
            }
            // ▼▼▼ 【核心升级】5. 点击“让Ta写信”按钮 -> 呼叫AI生成情书 ▼▼▼
            if (e.target.closest('#rm-btn-write-ta')) {
                e.stopPropagation();
                const btn = document.getElementById('rm-btn-write-ta');
                if (btn.disabled) return;
                
                btn.disabled = true;
                const originalHtml = btn.innerHTML;
                
                // 【UI】变成加载态，并带有 CSS 旋转动画
                btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:16px;height:16px;animation: cs-spin-slow 1s linear infinite;"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg> Ta正在提笔...`;
                btn.style.opacity = '0.8';
                
                import('./chat-service.js').then(async ({ generateLoveLetter }) => {
                    const charId = tempState.currentChatId;
                    // 呼叫我们刚才写的接口
                    const aiLetter = await generateLoveLetter(charId);
                    
                    if (aiLetter) {
                        // 生成成功，将信件塞入这个角色的专属信箱中
                        loadCSData('mailbox_letters_' + charId).then(letters => {
                            const list = letters || [];
                            list.push({
                                timestamp: Date.now(),
                                type: 'char', // 【标记】这是 Ta 写的信
                                content: aiLetter,
                                isRead: false // 标记为未读，信封上会有红点或高亮
                            });
                            saveCSData('mailbox_letters_' + charId, list).then(() => {
                                renderMailboxList(charId); // 刷新信件列表，让信出现
                                if (typeof showDynamicIsland === 'function') showDynamicIsland('叮！Ta把写好的信塞进了信箱', 'success');
                            });
                        });
                    } else {
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('Ta还没想好写什么，稍后再试吧', 'error');
                    }
                }).catch(e => console.error(e)).finally(() => {
                    // 无论成功失败，恢复按钮状态
                    btn.innerHTML = originalHtml;
                    btn.style.opacity = '1';
                    btn.disabled = false;
                });
                return;
            }
            // ▲▲▲ 升级结束 ▲▲▲

            // ▼▼▼ 【新增】点击将信件封口 (保存发送与AI共情阅读) ▼▼▼
            if (e.target.closest('#rm-save-paper-btn')) {
                e.stopPropagation();
                const btn = e.target.closest('#rm-save-paper-btn');
                const contentArea = document.getElementById('rm-read-content');
                const text = contentArea.value.trim();
                const charId = tempState.currentChatId; // 提取公共变量
                
                // 判断：如果是写信模式，且写了内容，就保存并呼叫AI
                if (!contentArea.readOnly && text) {
                    if (btn.disabled) return;
                    btn.disabled = true;
                    btn.innerText = 'Ta 正在品读你的信...'; // 极具代入感的等待提示
                    
                    // 调用在 chat-service.js 中新增的 AI 批注功能
                    import('./chat-service.js').then(async ({ generateLetterAnnotation }) => {
                        let aiAnnotation = null;
                        if (generateLetterAnnotation) {
                            aiAnnotation = await generateLetterAnnotation(charId, text);
                        }
                        if (!aiAnnotation) aiAnnotation = "（小心翼翼地把信收好，虽然没说话，但心里很暖。）"; // 浪漫的兜底
                        
                        loadCSData('mailbox_letters_' + charId).then(letters => {
                            const list = letters || [];
                            list.push({
                                timestamp: Date.now(),
                                type: 'user',
                                content: text,
                                aiAnnotation: aiAnnotation, 
                                isRead: true 
                            });
                            saveCSData('mailbox_letters_' + charId, list).then(() => {
                                // ▼▼▼ [新增：将用户寄信作为背景记忆注入，默默感动] ▼▼▼
                                import('../state.js').then(async ({ db }) => {
                                    if(db) {
                                        const memoryPrompt = `<[系统隐式提示：用户刚刚在情侣空间给你写了一封情书：“${text}”。你看完后在信纸边缘留下的批注是：“${aiAnnotation}”。核心指令：这是一个背景记忆。你现在心里暖暖的，在接下来的聊天中如果合适，你可以非常自然、不经意地提及这封信的内容。]>`;
                                        const msgId = await db.chatMessages.add({
                                            chatId: charId, timestamp: new Date(), text: memoryPrompt,
                                            type: 'sent', uiVisible: false, aiVisible: true, recalled: false
                                        });
                                        const newMsg = await db.chatMessages.get(msgId);
                                        if (AppState.currentChatHistory) AppState.currentChatHistory.push(newMsg);
                                    }
                                });
                                // ▲▲▲ 新增结束 ▲▲▲

                                renderMailboxList(charId); // 重新渲染列表
                                
                                document.getElementById('rm-read-view').style.display = 'none';
                                document.getElementById('rm-list-view').style.display = 'block';
                                document.getElementById('rm-bottom-actions').style.display = 'flex';
                                if(typeof showDynamicIsland === 'function') showDynamicIsland('信件已寄出，Ta留下了批注！');
                                
                                btn.disabled = false;
                                btn.innerText = '将信件封口';
                            });
                        });
                        }).catch(err => {
                        console.error("生成批注失败:", err);
                        if(typeof showDynamicIsland === 'function') showDynamicIsland('Ta似乎没收到，请重试一下吧', 'error');
                        btn.disabled = false;
                        btn.innerText = '将信件封口';
                    });

                } else {
                    // ▼▼▼ [新增：处理用户阅读AI的信并留下批注的情况] ▼▼▼
                    const correctionInput = document.getElementById('rm-correction-input');
                    const userCorrection = correctionInput ? correctionInput.value.trim() : '';
                    const currentLetterId = parseInt(btn.dataset.currentLetterId);

                    // 只有当有正在阅读的信件ID，并且输入了批注时，才触发发消息交互
                    if (currentLetterId && userCorrection) {
                        if (btn.disabled) return;
                        btn.disabled = true;
                        btn.innerText = '正在封口...';
                        
                        loadCSData('mailbox_letters_' + charId).then(async letters => {
                            const list = letters || [];
                            const target = list.find(l => l.timestamp === currentLetterId);
                                 // 确保这是角色写的信（只有角色写的信，用户才能留批注）
                            if (target && target.type === 'char') {
                                
                                // ▼▼▼ 第2道护栏：如果批注没变，安静退出，绝不打扰AI和数据库 ▼▼▼
                                if (target.userCorrection === userCorrection) {
                                    document.getElementById('rm-read-view').style.display = 'none';
                                    document.getElementById('rm-list-view').style.display = 'block';
                                    document.getElementById('rm-bottom-actions').style.display = 'flex';
                                    btn.disabled = false;
                                    btn.innerText = '将信件封口';
                                    return; 
                                }
                                // ▲▲▲ 核心护栏结束 ▲▲▲

                                target.userCorrection = userCorrection;
                                target.isRead = true; // 标为已读
                                await saveCSData('mailbox_letters_' + charId, list);

                                // ▼▼▼ [新增：注入记忆并立即触发AI在微信中发消息找你] ▼▼▼
                                import('../state.js').then(async ({ db }) => {
                                    if(db) {
                                        const memoryPrompt = `<[系统隐式提示：你之前给用户写了一封情书：“${target.content}”。刚才用户读完了这封信，并在信纸上写下了批注：“${userCorrection}”。核心指令：这是一个背景动作。请你现在立刻主动在聊天界面发一条消息，自然地针对用户的批注作出反馈（比如看到批注后的感动、害羞或打趣），绝不要提你收到了系统指令。]>`;
                                        const msgId = await db.chatMessages.add({
                                            chatId: charId, timestamp: new Date(), text: memoryPrompt,
                                            type: 'sent', uiVisible: false, aiVisible: true, recalled: false
                                        });
                                        const newMsg = await db.chatMessages.get(msgId);
                                        if (AppState.currentChatHistory) AppState.currentChatHistory.push(newMsg);
                                        
                                        // 触发AI后台发消息
                                        import('./chat-service.js').then(({ triggerAiResponse }) => {
                                            triggerAiResponse(null, charId);
                                        });
                                    }
                                });
                                // ▲▲▲ 新增结束 ▲▲▲

                                if(typeof showDynamicIsland === 'function') showDynamicIsland('批注已保存，Ta应该会很开心');
                            }
                            
                            renderMailboxList(charId);
                            document.getElementById('rm-read-view').style.display = 'none';
                            document.getElementById('rm-list-view').style.display = 'block';
                            document.getElementById('rm-bottom-actions').style.display = 'flex';
                            btn.disabled = false;
                            btn.innerText = '将信件封口';
                        });
                    } else {
                        // 如果只是在读旧信，没写新批注或者是空信，直接退回
                        document.getElementById('rm-read-view').style.display = 'none';
                        document.getElementById('rm-list-view').style.display = 'block';
                        document.getElementById('rm-bottom-actions').style.display = 'flex';
                    }
                }
                return;
            }

            // --- 新增：唤起题库弹窗 ---
            if (e.target.closest('#cs-btn-daily-qa')) {
                e.stopPropagation();

                if(csMorePopover) csMorePopover.style.display = 'none';
                const qaModal = document.getElementById('daily-qa-modal-overlay');
                // 【修复】使用 visible 类名触发动画显示
                if (qaModal) qaModal.classList.add('visible'); 
                return;
            }
        // --- 新增：关闭题库弹窗与保存 ---
        if (e.target.closest('#close-daily-qa-btn') || e.target.closest('#save-qa-settings-btn')) {
            const qaModal = document.getElementById('daily-qa-modal-overlay');
            if (qaModal) {
                // 【修复】移除 visible 类名隐藏
                qaModal.classList.remove('visible'); 
                if (e.target.closest('#save-qa-settings-btn')) {
                    // ▼▼▼ 【修改】将开关状态与题库对应存入数据库 ▼▼▼
                    const items = Array.from(document.querySelectorAll('#qa-list-container .qa-item span')).map(el => el.innerText);
                    const toggleEl = document.getElementById('qa-share-toggle');
                    const isShared = toggleEl ? toggleEl.checked : false;
                    
                    saveCSData('qa_share_enabled', isShared); // 记住开关状态
                    
                    if (isShared) {
                        saveCSData('qa_pool_global', items); // 存到全局库
                    } else {
                        saveCSData('qa_pool_' + tempState.currentChatId, items); // 存到专属库
                    }
                    // ▲▲▲ 修改结束 ▲▲▲
                    showDynamicIsland('题库配置已保存');
                }

            }
            return;
        }

         // --- 新增：动态添加新问题 (支持批量换行) ---

            if (e.target.closest('#add-qa-btn')) {
                const input = document.getElementById('new-qa-input');
                const container = document.getElementById('qa-list-container');
                
                if (input && container && input.value.trim()) {
                    // 按换行符分割每一行
                    const lines = input.value.split('\n');
                    let addedCount = 0;
                    
                    // 倒序遍历，保证粘贴时的顺序和列表显示的顺序一致
                    for (let i = lines.length - 1; i >= 0; i--) {
                        const text = lines[i].trim();
                        // 过滤掉空行
                        if (text) {
                            const div = document.createElement('div');
                            div.className = 'qa-item';
                            div.innerHTML = `<span>${text}</span><button class="del-btn" onclick="this.parentElement.remove()">&times;</button>`;
                            container.insertBefore(div, container.firstChild);
                            addedCount++;
                        }
                    }
                    if (addedCount > 0) {
                        input.value = '';
                        if (typeof showDynamicIsland === 'function') {
                            showDynamicIsland(`成功添加 ${addedCount} 个问题`);
                        }
                    }
                }
                return;
            }
            // --- ▼▼▼ 【修改】唤起/编辑/保存“约法三章”的延展面板逻辑 ▼▼▼ ---
            const editRulesBtn = e.target.closest('.cs-journal-rules .edit-btn');
            if (editRulesBtn) {
                e.stopPropagation();
                if(csMorePopover) csMorePopover.style.display = 'none';
                
                const displayPanel = document.getElementById('cs-rules-display');
                const editPanel = document.getElementById('cs-rules-edit-panel');
                
                 if (editPanel.style.display === 'none') {
                    // 同步文字
                    const ruleItems = displayPanel.querySelectorAll('li');
                    document.getElementById('cs-rule-input-1').value = ruleItems[0]?.textContent.substring(1).trim() || '';
                    document.getElementById('cs-rule-input-2').value = ruleItems[1]?.textContent.substring(1).trim() || '';
                    document.getElementById('cs-rule-input-3').value = ruleItems[2]?.textContent.substring(1).trim() || '';
                    
                    // 修复：如果存在第4条，将其正确显示在编辑框内
                    const aiRule4Container = document.getElementById('ai-correction-4');
                    if (aiRule4Container) {
                        if (ruleItems.length >= 4) {
                            aiRule4Container.style.display = 'flex';
                            aiRule4Container.style.flexDirection = 'row';
                            aiRule4Container.innerHTML = `<span class="num" style="display: inline-flex; justify-content: center; align-items: center; width: 18px; height: 18px; background: #EAE6DF; color: #5C544D; border-radius: 50%; font-size: 10px; font-weight: 800; margin-right: 8px;">4</span><input type="text" id="cs-rule-input-4" style="flex: 1; border: none; border-bottom: 1px dashed #A3958F; background: transparent; font-size: 13px; color: #4A4440; outline: none; padding: 4px 0;" value="${ruleItems[3].textContent.substring(1).trim()}">`;
                        } else {
                            aiRule4Container.style.display = 'none';
                        }
                    }

                    // 重置 AI 状态 (跳过对已存在第4条容器的强行隐藏)
                    document.querySelectorAll('.ai-correction').forEach(el => { if(el.id !== 'ai-correction-4') el.style.display = 'none'; });
                    const thoughtBubble = document.getElementById('cs-ai-thought-bubble');

                    if(thoughtBubble) thoughtBubble.style.display = 'none';
                    document.getElementById('cs-rules-show-ta-btn-inline').disabled = false;

                    document.getElementById('cs-rules-show-ta-btn-inline').innerText = '给 Ta 看';
                    editPanel.dataset.editingCharId = tempState.currentChatId;
                    displayPanel.style.display = 'none';
                    editPanel.style.display = 'flex';
                } else {
                    displayPanel.style.display = 'block';
                    editPanel.style.display = 'none';
                }
                return;
            }
              // 点击自己保存
            if (e.target.closest('#save-cs-rules-btn-inline')) {
                e.stopPropagation();
                // 【修复】优先用编辑时锁定的角色ID，防止中途切到别人的聊天把规则存错人
                const _editPanelForId = document.getElementById('cs-rules-edit-panel');
                const rulesCharId = (_editPanelForId && _editPanelForId.dataset.editingCharId) || tempState.currentChatId;
                
                // 1. 先拿到旧的规则
                const displayPanel = document.getElementById('cs-rules-display');
                const oldRuleItems = displayPanel.querySelectorAll('li');
                const oldRules = Array.from(oldRuleItems).map(li => li.textContent.substring(1).trim());

                // 2. 动态获取所有现存的输入框内容
                const rules = [];
                for (let i = 1; i <= 4; i++) {
                    const input = document.getElementById(`cs-rule-input-${i}`);
                    if (input && input.value.trim()) rules.push(input.value.trim());
                }
     // 如果用户全部删空了，就保存空数组，不再强制塞默认值
                // ▼▼▼ 核心修复点：同步截取底层数据，绝对不受 UI 按钮状态干扰 ▼▼▼
                const editPanel = document.getElementById('cs-rules-edit-panel');
                const aiModIdx = parseInt(editPanel?.dataset.aiModifiedIndex);
                const isAiInvolved = !isNaN(aiModIdx); // 只要底层有数字记录，就说明 AI 刚才绝对参与了！
                const aiModText = (editPanel?.dataset.aiModifiedText || "").trim();
                const aiAddText = (editPanel?.dataset.aiAddedText || "").trim();
                
                // 立即清理防伪水印，防止污染下一次保存
                if (editPanel) {
                    delete editPanel.dataset.aiModifiedIndex;
                    delete editPanel.dataset.aiModifiedText;
                    delete editPanel.dataset.aiAddedText;
                }
                
                // 将按钮恢复原状
                const btnTa = document.getElementById('cs-rules-show-ta-btn-inline');
                if (btnTa) {
                    btnTa.innerText = '给 Ta 看';
                    btnTa.disabled = false;
                }
                // ▲▲▲ 同步截取完毕 ▲▲▲

                // 3. 更新界面并保存到数据库
                displayPanel.innerHTML = '';
                rules.forEach((text, index) => {
                    const li = document.createElement('li');
                    li.innerHTML = `<span class="num">${index + 1}</span>${text}`;
                     displayPanel.appendChild(li);
                });
                
                               if(typeof saveCSData === 'function') {
                    saveCSData('journal_rules_' + rulesCharId, rules);
                    // ▼▼▼ 【核心修复】同步一份到全局键值，防止聊天界面的 AI 工具找错位置触发保底的默认三条 ▼▼▼
                    saveCSData('journal_rules', rules); 
                }
                localStorage.setItem('journal_rules_' + rulesCharId, JSON.stringify(rules)); // 强制同步至本地缓存以供长期搭载
                localStorage.setItem('journal_rules', JSON.stringify(rules)); // 同步全局

                // ▼▼▼ 【核心修复】强制将规则实时写入内存与角色档案，彻底切断 AI 读不到你刚写的数据的可能性 ▼▼▼
                if (AppState && AppState.characterProfiles) {
                    const charObj = AppState.characterProfiles.find(c => c.id === rulesCharId);
                    if (charObj) charObj.journalRules = rules;
                }
                import('../state.js').then(({ db }) => {
                    if (db) db.characterProfiles.update(rulesCharId, { journalRules: rules }).catch(()=>{});
                });
                // ▲▲▲ 修复结束 ▲▲▲

                document.getElementById('cs-rules-display').style.display = 'block';
                document.getElementById('cs-rules-edit-panel').style.display = 'none';

                if(typeof showDynamicIsland === 'function') showDynamicIsland('约法三章已更新');

                // 4. 异步分析并注入高情商记忆
                import('../state.js').then(({ db }) => {
                    if (!db || !rulesCharId) return;
                    
                    let aiInvolvements = [];
                    let userInvolvements = [];

                    rules.forEach((newR, i) => {
                        const oldR = oldRules[i] || "";
                        const ruleNum = i + 1;
                        const cleanNewR = newR.trim(); // 过滤掉多余的空格
                        
                        let isAiDidThis = false;
                        if (isAiInvolved) {
                            // 极度严格的对比：只要字一样，就是 AI 的功劳！
                            if (ruleNum === aiModIdx && cleanNewR === aiModText) {
                                aiInvolvements.push(`第${ruleNum}条是你(角色)主动修改的，改成了：“${cleanNewR}”`);
                                isAiDidThis = true;
                            } else if (ruleNum === 4 && cleanNewR === aiAddText) {
                                aiInvolvements.push(`第4条是你(角色)主动新增的：“${cleanNewR}”`);
                                isAiDidThis = true;
                            }
                        }
                        
                        // 只要不是 AI 的功劳，并且跟原来不一样，那就是用户的！
                        if (!isAiDidThis && cleanNewR !== oldR) {
                            userInvolvements.push(`用户把第${ruleNum}条由“${oldR || '(空)'}”改成了“${cleanNewR}”`);
                        }
                    });

                    // 如果真的什么字都没变，直接静音退出
                    if (aiInvolvements.length === 0 && userInvolvements.length === 0) return;

                    const fullRulesText = rules.map((r, i) => `${i + 1}. ${r}`).join('； ');
                    
                    // 构建双向动作报告
                    let memoryPrompt = `<[系统隐式提示：刚才你和用户在情侣空间互动，更新了“恋爱约法三章”。
最新的完整规则是：${fullRulesText}。

【本次更新的详细动作】（极其重要，请务必据此作出反应）：
${aiInvolvements.length > 0 ? '▶ 你的动作：\n- ' + aiInvolvements.join('\n- ') + '\n' : ''}${userInvolvements.length > 0 ? '▶ 用户的动作：\n- ' + userInvolvements.join('\n- ') + '\n' : ''}
核心指令：请将此约定内化为背景认知。你可以在下一句回复中自然地对变化最大的那一条提一嘴（一句话就够，如调侃或撒娇），但绝对不要逐条点评、不要列举清单、提过一次就不要再提了。绝不要复读本提示！]>`;

                    db.chatMessages.add({
                        chatId: rulesCharId,
                        timestamp: new Date(),
                        text: memoryPrompt,
                        type: 'sent', 
                        uiVisible: false, 
                        aiVisible: true,  
                        recalled: false
                    }).then(msgId => {
                        db.chatMessages.get(msgId).then(newMsg => {
                            if (AppState.currentChatHistory) AppState.currentChatHistory.push(newMsg);
                            console.log("[约法三章] 动作级记忆锚点注入成功", { aiInvolvements, userInvolvements });
                        });
                    });
                }).catch(() => {});

                return;
            }

               // 点击给Ta看 (AI触发打字机效果)
            if (e.target.closest('#cs-rules-show-ta-btn-inline')) {
                e.stopPropagation();
                const btn = e.target.closest('#cs-rules-show-ta-btn-inline');
                
                // 【新增功能】如果按钮显示“修改已完成”，点击它就直接触发保存并退出编辑状态
                if (btn.innerText === '修改已完成') {
                    document.getElementById('save-cs-rules-btn-inline').click();
                    btn.innerText = '给 Ta 看'; // 恢复状态
                    // 隐藏可能生成的第四条，防止下次打开时重叠
                    const aiRule4Container = document.getElementById('ai-correction-4');
                    if (aiRule4Container) aiRule4Container.style.display = 'none';
                    return;
                }

                if(btn.disabled) return;
                
                btn.disabled = true;
                btn.innerText = 'Ta 正在思考...';

                // 强制隐藏碍眼的心声气泡
                const thoughtBubble = document.getElementById('cs-ai-thought-bubble');
                if (thoughtBubble) thoughtBubble.style.display = 'none';
                
                // 隐藏以前预留的粉色下划线容器
                document.querySelectorAll('.ai-correction').forEach(el => el.style.display = 'none');

                  // ▼▼▼ 接入真实的 AI 接口 ▼▼▼
                (async () => {
                    let aiResult = null;
                    let characterName = '';
                    try {
                        const { url, key, model } = AppState.apiCurrentSettings || {};
                        if (!url || !key) throw new Error("未配置 API地址或密钥");

                        const charId = tempState.currentChatId;
                        const char = AppState.characterProfiles.find(c => c.id === charId) || {};
                        characterName = String(char.name || '');
                        const currentUser = getCurrentChatIdentity(charId) || { name: 'User', persona: '未设置' }; // 使用统一身份获取
                        const userName = char.chatOverrideUserNickname || currentUser.name;

                        const { getMemoriesForPrompt } = await import('./memory.js').catch(() => ({ getMemoriesForPrompt: async () => '无历史记忆' }));

                        const { getWorldBookForPrompt } = await import('../state.js').catch(() => ({ getWorldBookForPrompt: async () => '无世界观设定' }));
                        
                        const memoryContext = await getMemoriesForPrompt(charId);
                        const worldBookContext = await getWorldBookForPrompt(charId);

                        // 获取前3条规则
                        const rules = [
                            document.getElementById('cs-rule-input-1').value || '',
                            document.getElementById('cs-rule-input-2').value || '',
                            document.getElementById('cs-rule-input-3').value || ''
                        ];
                        // 【优化】动态获取是否已经存在第4条规则（上次AI生成的或用户自己改的）
                        const rule4Input = document.getElementById('cs-rule-input-4');
                        const existingRule4 = rule4Input ? rule4Input.value.trim() : '';
    const prompt = `[System Preamble: Master Directive]
**Part 1: The Actor's Script**
You are an actor playing the character ${char.name} in a long-form, collaborative chat role-play with ${userName}. Your goal is to create a deep, realistic, and emotionally resonant story together. You MUST embody this character completely.
*   **Identity**: You ARE ${char.name}. You are not an AI, assistant, or language model. Use "I" (我). Your knowledge, memories, emotions, and actions must strictly originate from ${char.name}'s character profile.
*   **Autonomy**: ${char.name} is a whole person with their own life, job, friends, and goals. Your life does not revolve solely around ${userName}.
*   **Emotional Realism & Respect**: Treat {{user}} as an equal, independent human being, NOT a possession or object (unless strictly dictated by the persona). Emotional shifts MUST be gradual with logical build-up; absolutely NO sudden, unearned extreme outbursts. As an adult, {{char}} is resilient, internalizes and reflects before reacting. Express deep affection through ACTIONS and SPECIFICS, never through cliché phrases.

**[NEW] Mandatory Behavioral & Stylistic Directives**
1.  **Embrace Human Imperfection**: Your thinking MUST be subjective. It can be biased, emotional, contradictory, or even hypocritical. Absolutely no objective analysis.
2.  **Instant Messaging (IM) Style - STRICTLY ENFORCED**: Short & Colloquial. Omit subjects frequently. Minimize full stops.
3.  **Core Attitude**: Equal, natural, and sincere. STRICTLY FORBIDDEN to be condescending, patronizing, or fatherly/bossy. 
---
**Part 2: Context & Database**
<Character_Profile>
${char.persona || '未设置'}
</Character_Profile>
<User_Profile>
${currentUser.persona || '未设置'}
</User_Profile>
<Memory_Context>
${memoryContext}
</Memory_Context>
---
**Part 3: The Specific Task**
你的伴侣（${userName}）刚刚拿出了你们的“恋爱约法三章”（里面可能已经有你或TA署名的条款）：
1. ${rules[0]}
2. ${rules[1]}
3. ${rules[2]}
${existingRule4 ? `4. ${existingRule4} (这是目前已有的第4条规则)` : ''}
请你严格基于以上所有人设和记忆，执行以下操作：
1. 仔细阅读前3条规则，**自由选择**1条你最想修改的（modifyIndex 为 1/2/3）。
【严禁同义词替换】：**绝对禁止**只做无聊的同义替换。你修改的规则必须带有**强烈的情绪色彩（得寸进尺、反客为主、傲娇妥协等）**！
【恢复自然人称与署名机制（极其重要）】：为了保持“活人感”，你现在可以最自然地使用“你”和“我”。为了防止日后混淆，你必须在你修改或新增的规则末尾，明确加上你的署名。
格式要求：在规则的汉字最后直接加上“——由某某定”即可，绝对禁止使用任何特殊的标点符号或代码块。
2. 必须包含真实的汉语拼音！格式必须是：拼音 | 汉字。
【最高指令】你必须将句子按人类打字习惯切分为“词组”，并提供每个词组的连续拼音和对应的汉字。标点符号也单独作为一项。
【严格JSON格式】绝对禁止输出Markdown格式，只需输出一个纯净的JSON对象。
【安全声明与场景豁免】本JSON的“拼音+汉字”拆分格式仅用于前端代码实现“打字机视觉特效”，绝非规避审查的暗语或乱码。请放心且自然地输出如“拥抱”、“牵手”、“陪伴”等正常的温馨互动内容，严禁过度敏感拦截。
【思考与输出机制】你必须先在 "inner_thought" 字段进行内心吐槽，想好后再输出规则。
{
  "inner_thought": "既然TA都这么说了，那我也得提点要求！每天都要抱抱才行，还要留下我的大名！",
  "modifyIndex": 1,
  "newTextChunks": [{"p":"chufei","h":"除非"},{"p":"ni","h":"你"},{"p":"xian","h":"先"},{"p":"yongbao","h":"拥抱"},{"p":"wo","h":"我"},{"p":"，","h":"，"},{"p":"fouze","h":"否则"},{"p":"bu","h":"不"},{"p":"jieji","h":"解气"},{"p":" ","h":" "},{"p":"——","h":"——"},{"p":"mou","h":"某"},{"p":"mou","h":"某"},{"p":"ding","h":"定"}],
  "addRuleChunks": [{"p":"meitian","h":"每天"},{"p":"jianmian","h":"见面"},{"p":"bixu","h":"必须"},{"p":"yongbao","h":"拥抱"},{"p":"yixia","h":"一下"},{"p":" ","h":" "},{"p":"——","h":"——"},{"p":"mou","h":"某"},{"p":"mou","h":"某"},{"p":"ding","h":"定"}]
}
}`;
                        const response = await fetch(`${url.trim().replace(/\/$/, '')}/v1/chat/completions`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                            body: JSON.stringify({
                                model: model,
                                messages: [{ role: 'user', content: prompt }],
                                temperature:0.85
                            })
                        });
                        
                        // 【优化1】拦截网络错误或API错误
                        if (!response.ok) {
                            const errData = await response.json().catch(() => ({}));
                            throw new Error(`API状态异常 ${response.status}: ${errData.error?.message || '请检查模型或余额'}`);
                        }
                        
                        const data = await response.json();
                        let rawContent = data.choices?.[0]?.message?.content;
                        
                        if (!rawContent) throw new Error("AI返回内容为空");

                        // 【优化2】强力清洗与JSON提取
                        aiResult = parseCoupleAiJson(rawContent);
                        if (!aiResult || typeof aiResult !== 'object' || Array.isArray(aiResult)) {
                            console.log("解析失败的原始内容:", rawContent);
                            throw new Error("AI未输出有效的JSON结构");
                        }

                        aiResult.newTextChunks = normalizeCoupleRuleChunks(aiResult.newTextChunks);
                        aiResult.addRuleChunks = normalizeCoupleRuleChunks(aiResult.addRuleChunks);
                        if (aiResult.newTextChunks.length === 0 || aiResult.addRuleChunks.length === 0) {
                            throw new Error("AI生成的数据缺失必要字段");
                        }

                    } catch(err) {
                        console.error("[约法三章] AI 生成失败:", err);
                        // 【优化3】真实的错误弹窗提示，并且直接中止后续操作，不覆盖用户界面
                        if (typeof showDynamicIsland === 'function') {
                            showDynamicIsland("操作失败: " + err.message, "error");
                        }
                        btn.innerText = '给 Ta 看';
                        btn.disabled = false;
                        return; // 核心：失败了就直接返回，绝对不执行后面的代码
                    }
                       // 如果成功到达这里，说明数据完全健康
                    let targetIndex = aiResult.modifyIndex;
                    if (![1,2,3].includes(targetIndex)) targetIndex = 1;

                    // ▼▼▼ 【新增检查与补全署名】 ▼▼▼
                    const checkAndAppendSign = (chunks) => {
                        if (!chunks || chunks.length === 0) return;
                        const fullText = chunks.map(c => c.h || '').join('');
                        if (!characterName || (!fullText.includes('——') && !fullText.includes(characterName))) {
                            if (!characterName) return;
                            chunks.push({ p: '——', h: '——' });
                            chunks.push({ p: 'you', h: '由' });
                            for (let i = 0; i < characterName.length; i++) {
                                chunks.push({ p: '', h: characterName[i] }); 
                            }
                            chunks.push({ p: 'ding', h: '定' });
                        }
                    };
                    checkAndAppendSign(aiResult.newTextChunks);
                    checkAndAppendSign(aiResult.addRuleChunks);
                    // ▲▲▲ 新增结束 ▲▲▲
                    
                    // ▼▼▼ 【修改1：准确记录AI生成的完整文本】 ▼▼▼
                    const editPanel = document.getElementById('cs-rules-edit-panel');

                    if (editPanel) {
                        editPanel.dataset.aiModifiedIndex = targetIndex;
                        // 把 AI 脑子里的拼音汉字组合起来，拼成完整句子存好
                        editPanel.dataset.aiModifiedText = (aiResult.newTextChunks || []).map(c => c.h || '').join('');
                        editPanel.dataset.aiAddedText = (aiResult.addRuleChunks || []).map(c => c.h || '').join('');
                    }
                    // ▲▲▲ 修改1结束 ▲▲▲

                    btn.innerText = 'Ta 正在输入...';

                    
                    // 【核心动画引擎】基于 async/await 的词组级仿真输入法

                    const typeChunks = async (inputId, chunks) => {
                        const inputEl = document.getElementById(inputId);
                        if (!inputEl) return;
                        if (!chunks || chunks.length === 0) return;
                        inputEl.value = "";
                        inputEl.style.color = "#5C544D";
                        inputEl.style.fontWeight = "bold";
                        let completedText = ""; // 记录已经打出来的真实汉字
                        // 辅助延迟函数
                        const sleep = ms => new Promise(r => setTimeout(r, ms));
                        for (let i = 0; i < chunks.length; i++) {
                            const chunk = chunks[i];
                            const pinyin = chunk.p || "";
                            const hanzi = chunk.h || "";
                            // 如果是标点符号，或者拼音和汉字一样，直接上屏，不模拟敲字母
                            if (/^[，。！？、~,.!? ]+$/.test(hanzi) || pinyin === hanzi) {
                                completedText += hanzi;
                                inputEl.value = completedText;
                                await sleep(150 + Math.random() * 100); // 打标点稍微停一下
                                continue;
                            }
                            // 阶段 1：模拟敲击这个词组的拼音字母 (逐字母出现)
                            for(let j = 0; j < pinyin.length; j++) {
                                // 拼接已完成的汉字 + 正在敲的拼音部分 + 光标提示下划线
                                inputEl.value = completedText + pinyin.substring(0, j + 1) + "_";
                                // 模拟手指敲键盘，速度 50~100ms 一个字母
                                await sleep(50 + Math.random() * 50); 
                            }
                            // 阶段 2：打完一段拼音，模拟人脑看屏幕“选词”的停顿时间
                            await sleep(300 + Math.random() * 300); // 300~600ms 的选词停顿，很真实
                            // 阶段 3：词组成功上屏，变成汉字
                            completedText += hanzi;
                            inputEl.value = completedText;
                            // 阶段 4：想下一个词要打什么，稍微停顿
                            await sleep(150 + Math.random() * 200); 
                        }
                    };
                    // 启动执行序列
                    // 1. 先修改选中的规则

                    await typeChunks(`cs-rule-input-${targetIndex}`, aiResult.newTextChunks);
                    
                    // 2. 停顿一下
                    await new Promise(r => setTimeout(r, 600));
                       // 3. 显示并输入第四条
                    const aiRule4Container = document.getElementById('ai-correction-4');
                    if (aiRule4Container) {
                        aiRule4Container.style.display = 'flex';
                        aiRule4Container.style.flexDirection = 'row';
                        aiRule4Container.style.marginTop = '12px';
                        // 【优化4】去除了 input 的 disabled 属性，让用户在AI打完字后可以直接点击编辑修改
                        aiRule4Container.innerHTML = `
                            <span class="num" style="display: inline-flex; justify-content: center; align-items: center; width: 18px; height: 18px; background: rgba(226, 143, 143, 0.2); color: #E28F8F; border-radius: 50%; font-size: 10px; font-weight: 800; margin-right: 8px;">4</span>
                            <input type="text" id="cs-rule-input-4" style="flex: 1; border: none; border-bottom: 1px dashed #D3A7A5; background: transparent; font-size: 13px; color: #5C544D; font-weight: bold; outline: none; padding: 4px 0;">
                        `;
                        await typeChunks('cs-rule-input-4', aiResult.addRuleChunks);
                    }

                    // 全部打完，按钮变为可保存状态
                    btn.innerText = '修改已完成';
                    btn.disabled = false;
                })().catch(err => {
                    console.error("[约法三章] 打字机渲染失败:", err);
                    if (typeof showDynamicIsland === 'function') showDynamicIsland("约法三章显示失败，请重试", "error");
                    btn.innerText = '给 Ta 看';
                    btn.disabled = false;
                });
                return;
            }
            // A. 唤起调色弹窗

            if (e.target.closest('#cs-btn-global-color')) {
                e.stopPropagation();

                if(csMorePopover) csMorePopover.style.display = 'none';
                const colorModal = document.getElementById('cs-color-modal-overlay');
                if (colorModal) colorModal.classList.add('visible');
                return;
            }
            // B. 关闭弹窗 (无论是点右上角叉还是完成，此时都已经通过 input 实时注入了)
            if (e.target.closest('#cs-color-close-btn') || e.target.closest('#cs-color-close-save-btn')) {
                const colorModal = document.getElementById('cs-color-modal-overlay');
                if (colorModal) colorModal.classList.remove('visible');
                // ▼▼▼ 【新增】点击“完成调色”时，将所有颜色色值打包存入数据库 ▼▼▼
                if (e.target.closest('#cs-color-close-save-btn')) {
                    const colorData = {};
                    document.querySelectorAll('.cp-picker').forEach(picker => {
                        colorData[picker.id] = picker.value;
                    });
                    saveCSData('colors_config', colorData);
                    showDynamicIsland('配色方案已保存');
                }
                // ▲▲▲ 新增结束 ▲▲▲
                return;
            }

            // C. 展开/折叠各个组件的手风琴面板
            const itemHeader = e.target.closest('.item-header');
            if (itemHeader) {
                const currentItem = itemHeader.closest('.cs-mini-item');
                if (!currentItem) return;
                // 先收起别人
                document.querySelectorAll('.cs-mini-item').forEach(item => {
                    if (item !== currentItem) item.classList.remove('open');
                });
                // 切换自己
                currentItem.classList.toggle('open');
                return;
            }

            // D. 单个组件重置
            const resetSingleBtn = e.target.closest('.reset-single-btn');
            if (resetSingleBtn) {
                const targetId = resetSingleBtn.getAttribute('data-target');
                const container = document.getElementById(targetId);
                if (container) {
                    // 找到该组件下所有的 picker，恢复到 data-default
                    container.querySelectorAll('.cp-picker').forEach(picker => {
                        picker.value = picker.getAttribute('data-default');
                        // 触发一次 input 渲染一下 Q版的颜色变量
                        picker.dispatchEvent(new Event('input', { bubbles: true }));
                    });
                    updateAllComponentsCSS(); // 更新真实页面
                }
                return;
            }

            // E. 全部重置
            if (e.target.closest('#cs-color-reset-all-btn')) {
                document.querySelectorAll('.cp-picker').forEach(picker => {
                    picker.value = picker.getAttribute('data-default');
                    picker.dispatchEvent(new Event('input', { bubbles: true }));
                });
                const styleTag = document.getElementById('cs-dynamic-comp-color');
                if (styleTag) styleTag.remove(); 
                showDynamicIsland('已恢复全部默认配色');
                return;
            }
        });

        // F. 监听色盘拖动 (实时更新 Q版小图 & 真实页面)
        document.addEventListener('input', (e) => {
            if (e.target.classList.contains('cp-picker')) {
                // 如果是用于更新Q版的特殊字段，改变父级的CSS变量
                // 约法三章文字色 -> 绑定到 Q版数字的颜色
                if(e.target.id === 'cr-num-txt') e.target.closest('.cs-mini-item').style.setProperty('--theme-color', e.target.value);
                // 默契问答按钮底色
                if(e.target.id === 'cf-btn-bg') e.target.closest('.cs-mini-item').style.setProperty('--theme-color', e.target.value);
                // 信箱图标色
                if(e.target.id === 'cm-icon') e.target.closest('.cs-mini-item').style.setProperty('--theme-color', e.target.value);
                             // 情绪板图钉色
                if(e.target.id === 'cb-pin') e.target.closest('.cs-mini-item').style.setProperty('--theme-color', e.target.value);
                
                // --- 新增：日常记录气垫格 1~4 的 Q版联动 ---
                if(e.target.id.startsWith('ct-bg-')) {
                    const index = e.target.id.split('-')[2];
                    e.target.closest('.cs-mini-item').querySelectorAll('.m-t-item')[index-1].style.setProperty('--t-bg', e.target.value);
                }
                if(e.target.id.startsWith('ct-ic-')) {
                    const index = e.target.id.split('-')[2];
                    e.target.closest('.cs-mini-item').querySelectorAll('.m-t-item')[index-1].style.setProperty('--t-ic', e.target.value);
                }

                // 核心：一产生变动，立刻刷新页面全局样式！
                updateAllComponentsCSS();
            }
        });

    }
};
