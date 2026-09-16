import { AppState, db } from '../state.js';

const DEFAULT_SLEEP_TIME = '23:00';
const DEFAULT_WAKE_TIME = '07:30';
export const SLEEP_CALL_REJECTION_BOOST = 0.35;

export function getLocalDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function timeToMinutes(value, fallback) {
    const match = String(value || fallback).match(/^(\d{2}):(\d{2})$/);
    if (!match) return timeToMinutes(fallback, DEFAULT_SLEEP_TIME);
    return Math.min(23, Number(match[1])) * 60 + Math.min(59, Number(match[2]));
}

function projectionDateTime(dateKey, timeValue) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || '')) || !/^\d{2}:\d{2}$/.test(String(timeValue || ''))) return null;
    const value = new Date(`${dateKey}T${timeValue}:00`);
    return Number.isNaN(value.getTime()) ? null : value;
}

export function resolveSleepWindow(record) {
    if (!record || typeof record !== 'object') return null;
    let wakeDate = record.wakeDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(wakeDate || '')) && /^\d{4}-\d{2}-\d{2}$/.test(String(record.sleepDate || ''))) {
        const fallbackWakeDate = new Date(`${record.sleepDate}T12:00:00`);
        fallbackWakeDate.setDate(fallbackWakeDate.getDate() + 1);
        wakeDate = getLocalDateKey(fallbackWakeDate);
    }
    const wakeAt = projectionDateTime(wakeDate, record.actualWakeTime);
    if (!wakeAt) return null;
    const durationMinutes = calculateSleepMinutes(record.actualSleepTime, record.actualWakeTime);
    return {
        sleepAt: new Date(wakeAt.getTime() - durationMinutes * 60000),
        wakeAt,
        durationMinutes
    };
}

export function getSleepProjectionPhase(projection, now = new Date()) {
    if (!projection || typeof projection !== 'object') return { started: false, completed: false };
    const window = resolveSleepWindow(projection);
    const sleepAt = window?.sleepAt || null;
    const wakeAt = window?.wakeAt || null;
    return {
        started: Boolean(sleepAt && now.getTime() >= sleepAt.getTime()),
        completed: Boolean(wakeAt && now.getTime() >= wakeAt.getTime()),
        sleepAt,
        wakeAt
    };
}

export function getSleepSettings(char = {}) {
    const timePerceptionEnabled = (char.timeSettings?.perceptionEnabled ?? true) === true;
    return {
        enabled: char.sleepScheduleEnabled === true && timePerceptionEnabled,
        timePerceptionEnabled,
        sleepTime: char.sleepTime || DEFAULT_SLEEP_TIME,
        wakeTime: char.wakeTime || DEFAULT_WAKE_TIME,
        wakeAfterMessages: Math.max(1, Math.min(20, Number(char.sleepWakeAfterMessages) || 6))
    };
}

function getEffectiveSleepTimes(char, now) {
    const baseline = getSleepSettings(char);
    const projection = char.sleepProjection && typeof char.sleepProjection === 'object' ? char.sleepProjection : null;
    const todayKey = getLocalDateKey(now);
    if (projection?.sleepDate === todayKey && projection.actualSleepTime && projection.actualWakeTime) {
        return { sleepTime: projection.actualSleepTime, wakeTime: projection.actualWakeTime, source: 'dynamic' };
    }
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (projection?.sleepDate === getLocalDateKey(yesterday) && projection.actualWakeTime) {
        return { sleepTime: projection.actualSleepTime || baseline.sleepTime, wakeTime: projection.actualWakeTime, source: 'dynamic' };
    }
    return { sleepTime: baseline.sleepTime, wakeTime: baseline.wakeTime, source: 'baseline' };
}

export function getSleepState(char, now = new Date()) {
    const settings = getSleepSettings(char);
    if (!settings.enabled) return { sleeping: false, phase: 'awake', progress: 0, ...settings };
    if (Number(char.sleepAwakeOverrideUntil) > now.getTime()) {
        return { sleeping: false, phase: 'awake', progress: 0, ...settings };
    }
    const projectionWindow = resolveSleepWindow(char.sleepProjection);
    if (projectionWindow && now.getTime() >= projectionWindow.sleepAt.getTime() && now.getTime() < projectionWindow.wakeAt.getTime()) {
        const elapsed = now.getTime() - projectionWindow.sleepAt.getTime();
        const progress = Math.min(1, elapsed / (projectionWindow.durationMinutes * 60000));
        const phase = progress < 1 / 3 ? 'drowsy' : progress < 2 / 3 ? 'half-awake' : 'deep-sleep';
        return {
            sleeping: true,
            phase,
            progress,
            durationMinutes: projectionWindow.durationMinutes,
            effectiveSleepTime: char.sleepProjection.actualSleepTime,
            effectiveWakeTime: char.sleepProjection.actualWakeTime,
            timeSource: 'dynamic',
            ...settings
        };
    }
    if (projectionWindow && char.sleepProjection?.sleepDate === getLocalDateKey(now) && now.getTime() < projectionWindow.sleepAt.getTime()) {
        return { sleeping: false, phase: 'awake', progress: 0, timeSource: 'dynamic', ...settings };
    }
    const effective = getEffectiveSleepTimes(char, now);
    const sleepMinute = timeToMinutes(effective.sleepTime, DEFAULT_SLEEP_TIME);
    const wakeMinute = timeToMinutes(effective.wakeTime, DEFAULT_WAKE_TIME);
    const nowMinute = now.getHours() * 60 + now.getMinutes();
    const duration = (wakeMinute - sleepMinute + 1440) % 1440 || 1440;
    const elapsed = (nowMinute - sleepMinute + 1440) % 1440;
    const sleeping = elapsed < duration;
    const progress = sleeping ? elapsed / duration : 0;
    const phase = !sleeping ? 'awake' : progress < 1 / 3 ? 'drowsy' : progress < 2 / 3 ? 'half-awake' : 'deep-sleep';
    return { sleeping, phase, progress, durationMinutes: duration, effectiveSleepTime: effective.sleepTime, effectiveWakeTime: effective.wakeTime, timeSource: effective.source, ...settings };
}

export function getSleepCallRejectRate(char, baseRate = 0.1, now = new Date()) {
    const numericRate = Number(baseRate);
    const normalRate = Number.isFinite(numericRate)
        ? Math.max(0, Math.min(1, numericRate))
        : 0.1;
    return getSleepState(char, now).sleeping
        ? Math.min(1, normalRate + SLEEP_CALL_REJECTION_BOOST)
        : normalRate;
}

function calculateSleepMinutes(sleepTime, wakeTime) {
    const start = timeToMinutes(sleepTime, DEFAULT_SLEEP_TIME);
    const end = timeToMinutes(wakeTime, DEFAULT_WAKE_TIME);
    return (end - start + 1440) % 1440 || 1440;
}

function calculateSleepOverlap(char, fromMs, toMs) {
    if (toMs <= fromMs || !getSleepSettings(char).enabled) return 0;
    let overlap = 0;
    const safeFromMs = Math.max(fromMs, toMs - 30 * 86400000);
    const cursor = new Date(safeFromMs);
    cursor.setDate(cursor.getDate() - 1);
    cursor.setHours(12, 0, 0, 0);
    const lastDay = new Date(toMs);
    lastDay.setHours(12, 0, 0, 0);
    while (cursor <= lastDay) {
        const effective = getEffectiveSleepTimes(char, cursor);
        const sleepParts = effective.sleepTime.split(':').map(Number);
        const wakeParts = effective.wakeTime.split(':').map(Number);
        const start = new Date(cursor);
        start.setHours(sleepParts[0], sleepParts[1], 0, 0);
        const end = new Date(cursor);
        end.setDate(end.getDate() + 1);
        end.setHours(wakeParts[0], wakeParts[1], 0, 0);
        overlap += Math.max(0, Math.min(toMs, end.getTime()) - Math.max(safeFromMs, start.getTime()));
        cursor.setDate(cursor.getDate() + 1);
    }
    return overlap;
}

async function shiftPausedTimers(char, pausedMs) {
    if (!pausedMs) return;
    const updates = {};
    if (char.activeMessageStartTime) updates.activeMessageStartTime = Number(char.activeMessageStartTime) + pausedMs;
    if (char.followUpPlan) {
        updates.followUpPlan = { ...char.followUpPlan };
        if (Number(char.followUpPlan.firedCount || 0) > 0 && Number(char.followUpPlan.lastFiredAt)) {
            updates.followUpPlan.lastFiredAt = Number(char.followUpPlan.lastFiredAt) + pausedMs;
        } else {
            updates.followUpPlan.sleepPausedMs = Number(char.followUpPlan.sleepPausedMs || 0) + pausedMs;
        }
    }
    Object.assign(char, updates);
    if (Object.keys(updates).length) await db.characterProfiles.update(char.id, updates);
}

export async function markSleepAwakenedByCall(char, callId = null, nowMs = Date.now()) {
    if (!char) return { awakened: false };
    const now = new Date(nowMs);
    const state = getSleepState(char, now);
    if (!state.sleeping) return { awakened: false, state };

    const projectionWindow = resolveSleepWindow(char.sleepProjection);
    const hasActiveProjectionWindow = projectionWindow
        && nowMs >= projectionWindow.sleepAt.getTime()
        && nowMs < projectionWindow.wakeAt.getTime();
    let wakeAtMs = hasActiveProjectionWindow ? projectionWindow.wakeAt.getTime() : 0;
    if (!wakeAtMs) {
        const wakeMinutes = timeToMinutes(state.effectiveWakeTime || state.wakeTime, DEFAULT_WAKE_TIME);
        const wakeAt = new Date(nowMs);
        wakeAt.setHours(Math.floor(wakeMinutes / 60), wakeMinutes % 60, 0, 0);
        if (wakeAt.getTime() <= nowMs) wakeAt.setDate(wakeAt.getDate() + 1);
        wakeAtMs = wakeAt.getTime();
    }

    char.sleepAwakeOverrideUntil = wakeAtMs;
    const liveChar = window.AppState?.characterProfiles?.find(item => String(item.id) === String(char.id));
    if (liveChar && liveChar !== char) liveChar.sleepAwakeOverrideUntil = wakeAtMs;

    const runtimeKey = `sleep_runtime_${char.id}`;
    const runtimeRecord = await db.appData.get(runtimeKey);
    const runtime = runtimeRecord?.value || {};
    const sleepStartedAt = runtime.sleeping && Number(runtime.sleepStartedAt)
        ? Number(runtime.sleepStartedAt)
        : nowMs;
    const pausedMs = runtime.sleeping && runtime.sleepStartedAt
        ? Math.max(0, nowMs - Number(runtime.sleepStartedAt))
        : 0;
    if (pausedMs) await shiftPausedTimers(char, pausedMs);

    await Promise.all([
        db.characterProfiles.update(char.id, { sleepAwakeOverrideUntil: wakeAtMs }),
        db.appData.put({
            key: runtimeKey,
            value: {
                ...runtime,
                sleeping: false,
                sleepStartedAt,
                wokenByCallAt: nowMs,
                wokenByCallId: callId == null ? null : String(callId),
                awakeConversationStartedAt: nowMs,
                lastUserActivityAt: nowMs,
                resleepNotifiedAt: null
            }
        })
    ]);
    return { awakened: true, state, wakeAt: new Date(wakeAtMs), sleepStartedAt };
}

export async function saveSleepProjection(char, sleepDate, health = {}) {
    if (!char || !getSleepSettings(char).enabled || !isValidSleepHealth(health)) return null;
    const actualSleepTime = health.actualSleepTime;
    const actualWakeTime = health.actualWakeTime;
    const wakeDateObj = new Date(`${sleepDate}T12:00:00`);
    wakeDateObj.setDate(wakeDateObj.getDate() + 1);
    const sleepDurationMinutes = calculateSleepMinutes(actualSleepTime, actualWakeTime);
    const record = {
        sleepDate,
        wakeDate: getLocalDateKey(wakeDateObj),
        actualSleepTime,
        actualWakeTime,
        sleepDurationMinutes,
        sleepQuality: Math.max(0, Math.min(100, Number(health.sleepQuality) || 0)),
        fatigue: Math.max(0, Math.min(100, Number(health.fatigue) || 0)),
        statusText: String(health.statusText || '已完成动态睡眠推演').slice(0, 80),
        updatedAt: Date.now()
    };
    const historyKey = `ls_sleep_history_${char.id}`;
    const old = await db.appData.get(historyKey);
    const history = Array.isArray(old?.value) ? old.value.filter(item => item?.sleepDate !== sleepDate) : [];
    history.push(record);
    history.sort((a, b) => String(a.sleepDate).localeCompare(String(b.sleepDate)));
    const trimmedHistory = history.slice(-90);
    char.sleepProjection = record;
    const liveChar = window.AppState?.characterProfiles?.find(item => String(item.id) === String(char.id));
    if (liveChar && liveChar !== char) liveChar.sleepProjection = record;
    await Promise.all([
        db.appData.put({ key: historyKey, value: trimmedHistory }),
        db.appData.put({ key: `ls_health_data_${char.id}`, value: record }),
        db.characterProfiles.update(char.id, { sleepProjection: record })
    ]);
    return record;
}

export async function disableSleepSchedule(char) {
    if (!char) return;
    char.sleepScheduleEnabled = false;
    char.sleepAwakeOverrideUntil = null;
    char.sleepProjection = null;
    const liveChar = window.AppState?.characterProfiles?.find(item => String(item.id) === String(char.id));
    if (liveChar && liveChar !== char) {
        liveChar.sleepScheduleEnabled = false;
        liveChar.sleepAwakeOverrideUntil = null;
        liveChar.sleepProjection = null;
    }
    await Promise.all([
        db.characterProfiles.update(char.id, { sleepScheduleEnabled: false, sleepAwakeOverrideUntil: null, sleepProjection: null }),
        db.appData.put({ key: `sleep_runtime_${char.id}`, value: { sleeping: false, disabledAt: Date.now() } }),
        db.appData.delete(`sleep_settings_undo_${char.id}`)
    ]);
}

export async function getSleepHistory(charId, limit = 7) {
    const record = await db.appData.get(`ls_sleep_history_${charId}`);
    const history = Array.isArray(record?.value) ? record.value : [];
    if (history.length) return history.slice(-Math.max(1, limit));
    const legacyLatest = await db.appData.get(`ls_health_data_${charId}`);
    return legacyLatest?.value ? [legacyLatest.value] : [];
}

export async function getSleepRecordBySleepDate(charId, dateKey) {
    const history = await getSleepHistory(charId, 90);
    return [...history].reverse().find(item => item?.sleepDate === dateKey) || null;
}

export async function getSleepRecordByWakeDate(charId, dateKey) {
    const history = await getSleepHistory(charId, 90);
    return [...history].reverse().find(item => item?.wakeDate === dateKey) || null;
}

export function isValidSleepHealth(health) {
    const isValidTime = value => {
        const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
        return Boolean(match && Number(match[1]) >= 0 && Number(match[1]) <= 23 && Number(match[2]) >= 0 && Number(match[2]) <= 59);
    };
    return Boolean(
        health &&
        isValidTime(health.actualSleepTime) &&
        isValidTime(health.actualWakeTime) &&
        Number.isFinite(Number(health.sleepQuality)) && Number(health.sleepQuality) >= 0 && Number(health.sleepQuality) <= 100 &&
        Number.isFinite(Number(health.fatigue)) && Number(health.fatigue) >= 0 && Number(health.fatigue) <= 100 &&
        String(health.statusText || '').trim()
    );
}

export async function getSleepReplyPolicy(char) {
    const state = getSleepState(char);
    const wakeAfterMessages = state.wakeAfterMessages;
    const makePolicy = (action, wakeCount = 0) => ({
        action,
        state,
        wakeCount,
        wakeAfterMessages,
        remainingMessages: Math.max(0, wakeAfterMessages - wakeCount)
    });
    if (!state.sleeping) return makePolicy('normal');
    const recent = await db.chatMessages.where('chatId').equals(char.id).reverse().limit(state.wakeAfterMessages + 4).toArray();
    const runtimeRecord = await db.appData.get(`sleep_runtime_${char.id}`);
    const runtime = runtimeRecord?.value || {};
    const sleepCycleStartedAt = Number(runtime.sleepStartedAt) || 0;
    const dreamHasBeenShown = sleepCycleStartedAt > 0 && Number(runtime.dreamShownAt) >= sleepCycleStartedAt;
    let consecutiveUserMessages = 0;
    const nonReplyContentTypes = new Set([
        'dream', 'system_event', 'narration', 'focus_record_card', 'phone_npc_chat_card',
        'friend_request_card', 'char_interaction_card', 'npc_chat_forward', 'chat_forward', 'mcp_tool_card'
    ]);
    for (const message of recent) {
        if (message.uiVisible === false) continue;
        if (message.aiVisible === false || message.type === 'system' || nonReplyContentTypes.has(message.contentType)) continue;
        if (message.type === 'sent') consecutiveUserMessages++;
        else if (message.type === 'received') break;
    }
    if (dreamHasBeenShown && consecutiveUserMessages >= state.wakeAfterMessages) {
        const wakeMinutes = timeToMinutes(state.effectiveWakeTime || state.wakeTime, DEFAULT_WAKE_TIME);
        const until = new Date();
        until.setHours(Math.floor(wakeMinutes / 60), wakeMinutes % 60, 0, 0);
        if (until.getTime() <= Date.now()) until.setDate(until.getDate() + 1);
        char.sleepAwakeOverrideUntil = until.getTime();
        const runtimeKey = `sleep_runtime_${char.id}`;
        const lastUserMessage = recent.find(message => message.type === 'sent' && message.uiVisible !== false && message.aiVisible !== false);
        await Promise.all([
            db.characterProfiles.update(char.id, { sleepAwakeOverrideUntil: char.sleepAwakeOverrideUntil }),
            db.appData.put({
                key: runtimeKey,
                value: {
                    ...runtime,
                    awakeConversationStartedAt: Date.now(),
                    lastUserActivityAt: new Date(lastUserMessage?.timestamp || Date.now()).getTime(),
                    resleepNotifiedAt: null
                }
            })
        ]);
        return makePolicy('woken', consecutiveUserMessages);
    }
    if (state.phase === 'drowsy') return makePolicy('sleepy-text', consecutiveUserMessages);
    if (state.phase === 'half-awake') return makePolicy('sleepy-voice', consecutiveUserMessages);
    if (!dreamHasBeenShown) return makePolicy('dream', consecutiveUserMessages);
    return makePolicy('sleeping', consecutiveUserMessages);
}

export async function syncSleepRuntime(char, nowMs = Date.now()) {
    const key = `sleep_runtime_${char.id}`;
    const state = getSleepState(char, new Date(nowMs));
    const record = await db.appData.get(key);
    const runtime = record?.value || {};
    if (!state.enabled) {
        if (runtime.sleeping) await db.appData.put({ key, value: { sleeping: false, disabledAt: nowMs } });
        return state;
    }
    if (state.sleeping) {
        if (!runtime.sleeping) await db.appData.put({ key, value: { sleeping: true, sleepStartedAt: nowMs } });
        return state;
    }
    if (runtime.sleeping && runtime.sleepStartedAt) {
        const pausedMs = Math.max(0, nowMs - Number(runtime.sleepStartedAt));
        await shiftPausedTimers(char, pausedMs);
        await db.appData.put({ key, value: { sleeping: false, wokeAt: nowMs } });
        return { ...state, justWoke: true };
    }
    return state;
}

export async function restoreBackgroundActivityAfterBoot() {
    const now = Date.now();
    const record = await db.appData.get('lastBackgroundActivityTime');
    const lastTime = Number(record?.value) || now;
    await db.appData.put({ key: 'lastBackgroundActivityTime', value: now });
    for (const char of AppState.characterProfiles || []) {
        const settings = getSleepSettings(char);
        if (!settings.enabled) {
            if (char.sleepScheduleEnabled === true && !settings.timePerceptionEnabled) await disableSleepSchedule(char);
            continue;
        }
        await shiftPausedTimers(char, calculateSleepOverlap(char, lastTime, now));
        const state = getSleepState(char, new Date(now));
        await db.appData.put({ key: `sleep_runtime_${char.id}`, value: state.sleeping ? { sleeping: true, sleepStartedAt: now } : { sleeping: false, wokeAt: now } });
    }
    return Math.max(0, now - lastTime);
}

export async function markBackgroundActivity() {
    await db.appData.put({ key: 'lastBackgroundActivityTime', value: Date.now() });
}

export function getSleepSchedulePrompt(char, { targetDateKey = getLocalDateKey(), previousNightRecord = null } = {}) {
    const state = getSleepSettings(char);
    if (!state.enabled) return '';
    const previousDate = new Date(`${targetDateKey}T12:00:00`);
    previousDate.setDate(previousDate.getDate() - 1);
    const previousDateKey = getLocalDateKey(previousDate);
    const matchedRecord = previousNightRecord?.sleepDate === previousDateKey && previousNightRecord?.wakeDate === targetDateKey
        ? previousNightRecord
        : null;
    const previousWindow = resolveSleepWindow(matchedRecord);
    const previousNightContext = previousWindow
        ? `<PREVIOUS_NIGHT_SLEEP>\nTarget schedule date: ${targetDateKey}\nNight anchor date: ${previousDateKey}\nResolved sleep time: ${getLocalDateKey(previousWindow.sleepAt)} ${matchedRecord.actualSleepTime}\nResolved wake time: ${targetDateKey} ${matchedRecord.actualWakeTime}\nDuration: ${previousWindow.durationMinutes} minutes\nQuality: ${matchedRecord.sleepQuality}\nFatigue: ${matchedRecord.fatigue}\nSource: dynamic\n</PREVIOUS_NIGHT_SLEEP>`
        : `<PREVIOUS_NIGHT_SLEEP>\nTarget schedule date: ${targetDateKey}\nResolved wake time: ${targetDateKey} ${state.wakeTime}\nSource: baseline\n</PREVIOUS_NIGHT_SLEEP>`;
    return `\n${previousNightContext}\n<SLEEP_CONTEXT>\nThe character has a baseline sleep preference of ${state.sleepTime} -> ${state.wakeTime}. This is a behavioral tendency, not a fixed timetable.\n\nThere are two different sleep windows in this scheduling task and they MUST NOT be confused:\n\n1. INCOMING SLEEP:\nThe sleep that began on the previous night and ends on the target schedule date. If <PREVIOUS_NIGHT_SLEEP> is provided, its wake time determines when the character becomes available for waking activities on the target date.\n\n2. OUTGOING SLEEP:\nThe sleep that begins after the target date's waking activities and ends on the following calendar date. Predict this only after reasoning through the target day's work, commute, meals, social activity, emotional state, fatigue, entertainment, habits, recent conversation, and unexpected events.\n\nNever create a sleep block inside schedules. Return the outgoing sleep prediction only through health.actualSleepTime, health.actualWakeTime, health.sleepQuality, health.fatigue, and health.statusText. health.actualSleepTime belongs to the target date's night. health.actualWakeTime belongs to the following calendar date. The following-morning wake time MUST NEVER be used as the wake time of the target schedule date.\n\nThe prediction must remain character-specific. Overtime, insomnia, late-night entertainment, commuting, emotional distress, anticipation, habits, revenge bedtime procrastination, early work, and exhaustion may shift bedtime and wake time when supported by context. health.statusText must be a short natural Chinese description.\n</SLEEP_CONTEXT>`;
}
