import { AppState, tempState } from '../state.js';

export const DEFAULT_CALL_SETTINGS = {
    rejectRate: 0.1,
    ambientEnabled: false,
    ambientSrc: '',
    ambientName: '',
    ambientVolume: 0.2,
    voiceVolume: 1.35,
    voiceDescriptionEnabled: false,
    aiStarts: false,
    userStarts: true
};

let ambientSource = null;
let ambientGain = null;
let ambientRequestId = 0;

function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

export function normalizeCallSettings(settings = {}) {
    const aiStarts = settings.aiStarts === true;
    const userStarts = settings.userStarts === true;
    return {
        ...DEFAULT_CALL_SETTINGS,
        ...settings,
        ambientEnabled: settings.ambientEnabled === true,
        ambientVolume: clamp(settings.ambientVolume, 0, 1, DEFAULT_CALL_SETTINGS.ambientVolume),
        voiceVolume: clamp(settings.voiceVolume, 0.5, 2, DEFAULT_CALL_SETTINGS.voiceVolume),
        voiceDescriptionEnabled: settings.voiceDescriptionEnabled === true,
        aiStarts: aiStarts && !userStarts,
        userStarts: userStarts || !aiStarts
    };
}

export function getCallSettings(chatId) {
    const character = AppState.characterProfiles.find(char => String(char.id) === String(chatId));
    return normalizeCallSettings(character?.callSettings || {});
}

export function getActiveCallChatId() {
    if (tempState.activeCallMode && tempState.activeCallChatId) {
        return tempState.activeCallChatId;
    }
    return null;
}

export function getCallVoiceVolume(chatId) {
    const activeChatId = getActiveCallChatId();
    if (!activeChatId) return 1;
    const activeCharacter = AppState.characterProfiles.find(char => String(char.id) === String(activeChatId));
    const isCallSpeaker = !chatId
        || String(activeChatId) === String(chatId)
        || (activeCharacter?.isGroup && (activeCharacter.memberIds || []).some(id => String(id) === String(chatId)));
    if (!isCallSpeaker) return 1;
    return getCallSettings(activeChatId).voiceVolume;
}

export function getActiveCallSettings() {
    return getCallSettings(getActiveCallChatId());
}

export function requestCallQuickSettings(chatId, mode = 'voice') {
    document.dispatchEvent(new CustomEvent('open-call-quick-settings', {
        detail: { chatId, mode }
    }));
}

export function stopCallAmbient() {
    ambientRequestId += 1;
    if (ambientSource) {
        try { ambientSource.stop(); } catch (error) { /* already stopped */ }
        ambientSource.disconnect();
        ambientSource = null;
    }
    if (ambientGain) {
        ambientGain.disconnect();
        ambientGain = null;
    }
}

export function setCallAmbientVolume(value) {
    if (ambientGain) {
        ambientGain.gain.value = clamp(value, 0, 1, DEFAULT_CALL_SETTINGS.ambientVolume);
    }
}

export async function startCallAmbient(chatId) {
    stopCallAmbient();
    const settings = getCallSettings(chatId);
    if (!settings.ambientEnabled || !settings.ambientSrc) return;

    const context = window.sharedAudioContext;
    if (!context) return;
    const requestId = ambientRequestId;

    try {
        if (context.state !== 'running') await context.resume();
        const response = await fetch(settings.ambientSrc);
        if (!response.ok) throw new Error(`Ambient audio request failed: ${response.status}`);
        const audioBuffer = await context.decodeAudioData(await response.arrayBuffer());
        if (requestId !== ambientRequestId || tempState.activeCallMode === null) return;

        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = audioBuffer;
        source.loop = true;
        gain.gain.value = settings.ambientVolume;
        source.connect(gain);
        gain.connect(context.destination);
        source.start(0);
        ambientSource = source;
        ambientGain = gain;
    } catch (error) {
        console.warn('[Call Audio] 环境音播放失败:', error);
    }
}
