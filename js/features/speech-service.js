import { AppState } from '../state.js';

const DEFAULT_VOICE_RECOGNITION_SETTINGS = {
    provider: 'browser',
    endpoint: '',
    apiKey: '',
    model: '',
    language: 'zh'
};

let activeApiCapture = null;
const pendingApiCaptures = new Set();
const MAX_CAPTURE_DURATION_MS = 60 * 1000;
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const AUTO_SEND_SILENCE_MS = 5 * 1000;
const SPEECH_ACTIVITY_THRESHOLD = 0.015;
const SPEECH_ACTIVITY_CHECK_INTERVAL_MS = 150;
const SPEECH_CONTEXT_MAX_LENGTH = 240;
const SENSEVOICE_TAGS = new Map([
    ['HAPPY', '情绪：开心'],
    ['SAD', '情绪：难过'],
    ['ANGRY', '情绪：生气'],
    ['FEARFUL', '情绪：害怕'],
    ['DISGUSTED', '情绪：厌恶'],
    ['NEUTRAL', '情绪：平静'],
    ['SPEECH', '声音事件：说话'],
    ['BGM', '声音事件：背景音乐'],
    ['APPLAUSE', '声音事件：掌声'],
    ['LAUGHTER', '声音事件：笑声'],
    ['CRY', '声音事件：哭声'],
    ['MUSIC', '声音事件：音乐'],
    ['NOISE', '声音事件：噪声']
]);
const SENSEVOICE_CONTROL_TAGS = new Set([
    ...SENSEVOICE_TAGS.keys(),
    'ZH', 'EN', 'JA', 'KO', 'YUE', 'WITHITN', 'WOITN'
]);

function normalizeSpeechContextValue(value) {
    return String(value || '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 80);
}

function extractSpeechContext(data, rawText) {
    const contextParts = [];
    const addContext = (value) => {
        const normalized = normalizeSpeechContextValue(value);
        if (normalized && !contextParts.includes(normalized)) contextParts.push(normalized);
    };
    const addKnownLabel = (value, prefix) => {
        const normalized = normalizeSpeechContextValue(value).toUpperCase();
        if (!normalized) return;
        const label = normalized.replace(/[<>|_\-]/g, '');
        const knownEmotion = SENSEVOICE_TAGS.get(label);
        if (knownEmotion && knownEmotion.startsWith(prefix)) addContext(knownEmotion);
    };

    const tagPattern = /<\|([A-Za-z][A-Za-z0-9_-]{1,24})\|>/g;
    for (const match of String(rawText || '').matchAll(tagPattern)) {
        const tag = String(match[1] || '').toUpperCase();
        if (SENSEVOICE_TAGS.has(tag)) addContext(SENSEVOICE_TAGS.get(tag));
    }

    const sources = [data, data?.result, data?.data].filter(value => value && typeof value === 'object');
    for (const source of sources) {
        addKnownLabel(source.emotion, '情绪');
        addKnownLabel(source.emotionLabel, '情绪');
        const events = source.events || source.audioEvents || source.audio_events;
        if (Array.isArray(events)) events.forEach(event => addKnownLabel(event, '声音事件'));
        else if (typeof events === 'string') events.split(/[,，、|]/).forEach(event => addKnownLabel(event, '声音事件'));

        const pauseCount = Number(source.pauseCount ?? source.pause_count);
        if (Number.isInteger(pauseCount) && pauseCount > 0 && pauseCount <= 100) {
            addContext(`停顿次数：${pauseCount}`);
        }
        const pauses = Array.isArray(source.pauses) ? source.pauses : [];
        if (pauses.length > 0 && pauses.length <= 100) addContext(`检测到停顿：${pauses.length} 次`);
    }

    return contextParts.join('；').slice(0, SPEECH_CONTEXT_MAX_LENGTH);
}

export function getVoiceRecognitionSettings() {
    return {
        ...DEFAULT_VOICE_RECOGNITION_SETTINGS,
        ...(AppState.voiceRecognitionSettings || {})
    };
}

export function isApiVoiceRecognitionEnabled() {
    const settings = getVoiceRecognitionSettings();
    return settings.provider === 'api'
        && Boolean(String(settings.endpoint || '').trim())
        && Boolean(String(settings.model || '').trim());
}

function chooseRecordingMimeType() {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
        return '';
    }
    const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus'
    ];
    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function getFileExtension(mimeType) {
    if (mimeType.includes('mp4')) return 'm4a';
    if (mimeType.includes('ogg')) return 'ogg';
    return 'webm';
}

function stopSpeechActivityMonitor(session) {
    if (session.speechActivityTimer) {
        clearInterval(session.speechActivityTimer);
        session.speechActivityTimer = null;
    }
    if (session.audioContext) {
        session.audioContext.close().catch(() => {});
        session.audioContext = null;
    }
    session.audioAnalyser = null;
}

function startSpeechActivityMonitor(session) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    try {
        const audioContext = new AudioContextCtor();
        audioContext.resume().catch(() => {});
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024;
        const source = audioContext.createMediaStreamSource(session.stream);
        source.connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        session.audioContext = audioContext;
        session.audioAnalyser = analyser;
        session.lastSpeechAt = 0;
        session.hasDetectedSpeech = false;
        session.silenceNotified = false;
        session.speechActivityTimer = setInterval(() => {
            if (session.cancelled || session.limitReached || !session.audioAnalyser) return;
            analyser.getByteTimeDomainData(samples);
            let sum = 0;
            for (const sample of samples) {
                const value = (sample - 128) / 128;
                sum += value * value;
            }
            const level = Math.sqrt(sum / samples.length);
            const now = Date.now();
            if (level >= SPEECH_ACTIVITY_THRESHOLD) {
                session.hasDetectedSpeech = true;
                session.lastSpeechAt = now;
                session.silenceNotified = false;
                session.lastSilenceRemainingSecond = null;
                if (session.silenceCountdownActive) {
                    session.silenceCountdownActive = false;
                    session.onSpeechActivity?.();
                }
                return;
            }
            if (session.hasDetectedSpeech && !session.silenceNotified) {
                const silenceElapsedMs = now - session.lastSpeechAt;
                const silenceRemainingMs = Math.max(0, AUTO_SEND_SILENCE_MS - silenceElapsedMs);
                const silenceRemainingSecond = Math.ceil(silenceRemainingMs / 1000);
                session.silenceCountdownActive = true;
                if (silenceRemainingSecond !== session.lastSilenceRemainingSecond) {
                    session.lastSilenceRemainingSecond = silenceRemainingSecond;
                    session.onSilenceProgress?.(silenceRemainingMs, AUTO_SEND_SILENCE_MS);
                }
                if (silenceElapsedMs >= AUTO_SEND_SILENCE_MS) {
                    session.silenceNotified = true;
                    session.onSilence?.();
                }
            }
        }, SPEECH_ACTIVITY_CHECK_INTERVAL_MS);
    } catch (error) {
        console.warn('[Speech Service] 无法启用静默检测：', error);
    }
}

function getTranscriptionEndpoint(endpoint) {
    const normalized = String(endpoint || '').trim().replace(/\/$/, '');
    if (/\/audio\/transcriptions$/i.test(normalized)) return normalized;
    return `${normalized}/audio/transcriptions`;
}

function getModelsEndpoint(endpoint) {
    const transcriptionEndpoint = getTranscriptionEndpoint(endpoint);
    return transcriptionEndpoint.replace(/\/audio\/transcriptions$/i, '/models');
}

export async function fetchVoiceRecognitionModels() {
    const settings = getVoiceRecognitionSettings();
    const endpoint = String(settings.endpoint || '').trim();
    const apiKey = String(settings.apiKey || '').trim();
    if (!endpoint) throw new Error('请先填写识别 API 地址');
    if (!apiKey) throw new Error('拉取模型前请先填写 API Key');

    const response = await fetch(getModelsEndpoint(endpoint), {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${apiKey}`
        },
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
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

    const models = data.data?.map(item => item?.id)
        || data.models?.map(item => item?.id || item?.name)
        || [];
    return [...new Set(models.map(model => String(model || '').trim()).filter(Boolean))].sort();
}

async function transcribeAudio(blob, settings, controller) {
    const formData = new FormData();
    formData.append('file', blob, `voice-message.${getFileExtension(blob.type)}`);
    formData.append('model', String(settings.model).trim());
    const isSiliconFlow = /api\.siliconflow\.cn/i.test(String(settings.endpoint || ''));
    if (settings.language) {
        formData.append('language', String(settings.language).trim());
    }
    if (!isSiliconFlow) formData.append('response_format', 'json');

    const headers = {};
    const apiKey = String(settings.apiKey || '').trim();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const signal = controller?.signal;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
        timedOut = true;
        controller?.abort();
    }, 90000);
    try {
        const response = await fetch(getTranscriptionEndpoint(settings.endpoint), {
            method: 'POST',
            headers,
            body: formData,
            signal,
            cache: 'no-store',
            credentials: 'omit',
            referrerPolicy: 'no-referrer'
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error?.message || data.message || `识别 API 请求失败 (${response.status})`);
        }

        const rawText = data.text || data.transcript || data.result?.text || data.data?.text;
        if (!String(rawText || '').trim()) throw new Error('识别 API 没有返回文字');
        const speechContext = extractSpeechContext(data, rawText);
        const text = String(rawText)
            .replace(/<\|([A-Za-z][A-Za-z0-9_-]{1,24})\|>/g, (fullTag, tag) => (
                SENSEVOICE_CONTROL_TAGS.has(String(tag).toUpperCase()) ? ' ' : fullTag
            ))
            .replace(/\s{2,}/g, ' ')
            .trim();
        if (!text) throw new Error('识别 API 只返回了语音标签，没有可发送的文字');
        return { text, speechContext };
    } catch (error) {
        if (error?.name === 'AbortError') {
            if (timedOut) throw new Error('识别 API 请求超时');
            throw error;
        }
        if (error instanceof TypeError) throw new Error('无法连接识别 API，请检查地址、网络或跨域设置');
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

export async function startApiVoiceCapture(callContext = null) {
    if (activeApiCapture) return activeApiCapture;
    if (!isApiVoiceRecognitionEnabled()) throw new Error('请先在“声音与语音”中填写识别 API 地址和模型');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风采集');
    if (typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持临时音频采集');

    const settings = getVoiceRecognitionSettings();
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: { ideal: true },
            noiseSuppression: { ideal: true },
            autoGainControl: { ideal: true },
            channelCount: { ideal: 1 }
        }
    });
    let recorder = null;
    try {
        const mimeType = chooseRecordingMimeType();
        recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (error) {
        stream.getTracks().forEach(track => track.stop());
        throw error;
    }
    const session = {
        recorder,
        stream,
        settings,
        callContext,
        chunks: [],
        totalBytes: 0,
        cancelled: false,
        limitReached: false,
        limitError: null,
        limitNotified: false,
        durationTimer: null,
        abortController: null,
        onLimitReached: null,
        onSilence: null,
        speechActivityTimer: null,
        audioContext: null,
        audioAnalyser: null,
        lastSpeechAt: 0,
        hasDetectedSpeech: false,
        silenceNotified: false,
        silenceCountdownActive: false,
        lastSilenceRemainingSecond: null,
    };
    activeApiCapture = session;

    recorder.addEventListener('dataavailable', event => {
        if (session.cancelled || !event.data?.size) return;
        session.totalBytes += event.data.size;
        session.chunks.push(event.data);
        if (session.totalBytes > MAX_CAPTURE_BYTES && !session.limitReached) {
            session.limitReached = true;
            session.limitError = new Error('录音文件超过 10MB，已停止录音');
            if (!session.limitNotified) {
                session.limitNotified = true;
                session.onLimitReached?.(session.limitError.message);
            }
            try { if (recorder.state !== 'inactive') recorder.stop(); } catch (error) { /* recorder already stopped */ }
        }
    });
    session.durationTimer = setTimeout(() => {
        if (session.cancelled || session.limitReached) return;
        session.limitReached = true;
        if (!session.limitNotified) {
            session.limitNotified = true;
            session.onLimitReached?.('录音超过 60 秒，已停止录音');
        }
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch (error) { /* recorder already stopped */ }
    }, MAX_CAPTURE_DURATION_MS);
    startSpeechActivityMonitor(session);
    try {
        recorder.start(250);
    } catch (error) {
        clearTimeout(session.durationTimer);
        stopSpeechActivityMonitor(session);
        activeApiCapture = null;
        stream.getTracks().forEach(track => track.stop());
        throw error;
    }
    return session;
}

export function isApiVoiceCaptureActive() {
    return Boolean(activeApiCapture);
}

export function cancelApiVoiceCapture() {
    const sessions = [activeApiCapture, ...pendingApiCaptures].filter(Boolean);
    activeApiCapture = null;
    sessions.forEach(session => {
        session.cancelled = true;
        clearTimeout(session.durationTimer);
        stopSpeechActivityMonitor(session);
        session.abortController?.abort();
        try {
            if (session.recorder.state !== 'inactive') session.recorder.stop();
        } catch (error) { /* recorder already stopped */ }
        session.stream.getTracks().forEach(track => track.stop());
        session.chunks.length = 0;
        session.totalBytes = 0;
    });
}

export function stopApiVoiceCapture() {
    const session = activeApiCapture;
    if (!session) return Promise.resolve('');
    activeApiCapture = null;
    clearTimeout(session.durationTimer);
    stopSpeechActivityMonitor(session);
    pendingApiCaptures.add(session);

    return new Promise((resolve, reject) => {
        const finish = async () => {
            session.stream.getTracks().forEach(track => track.stop());
            if (session.cancelled) {
                session.chunks.length = 0;
                pendingApiCaptures.delete(session);
                resolve('');
                return;
            }
            if (session.limitError) {
                session.chunks.length = 0;
                pendingApiCaptures.delete(session);
                reject(session.limitError);
                return;
            }
            let blob = null;
            try {
                blob = new Blob(session.chunks, { type: session.recorder.mimeType || 'audio/webm' });
                session.chunks.length = 0;
                session.totalBytes = 0;
                session.abortController = new AbortController();
                pendingApiCaptures.add(session);
                const result = await transcribeAudio(blob, session.settings, session.abortController);
                resolve(session.cancelled ? '' : result);
            } catch (error) {
                if (session.cancelled || error?.name === 'AbortError') resolve('');
                else reject(error);
            } finally {
                pendingApiCaptures.delete(session);
                session.abortController = null;
                session.chunks.length = 0;
                blob = null;
            }
        };
        session.recorder.addEventListener('stop', finish, { once: true });
        try {
            if (session.recorder.state === 'inactive') finish();
            else session.recorder.stop();
        } catch (error) {
            session.stream.getTracks().forEach(track => track.stop());
            pendingApiCaptures.delete(session);
            session.abortController?.abort();
            session.chunks.length = 0;
            reject(error);
        }
    });
}
