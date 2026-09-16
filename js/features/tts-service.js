import { AppState, db, tempState } from '../state.js'; // 引入全局状态
import { showDynamicIsland } from '../ui.js';
import { getCallVoiceVolume } from './call-audio.js';
import { isNativeRuntime, isHarmonyRuntime } from '../native-bridge.js';
let currentTtsSource = null;
let currentTtsGain = null;
let currentTtsGainIsCall = false;
// [新增] TTS 播放队列和状态
const speechQueue = []; // 用于存放待播放语音任务 { text, charId }
let isSpeaking = false; // 标记当前是否正在播放语音
const TTS_CACHE_LIMIT_PER_CHAR = 20;
const ALLOWED_TTS_EMOTIONS = new Set(['auto', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'calm']);
const TTS_AUDIO_MIME_TYPE = 'audio/mpeg';

function normalizeTtsEmotion(emotion) {
    const value = String(emotion || '').trim().toLowerCase();
    return ALLOWED_TTS_EMOTIONS.has(value) ? value : null;
}

function cleanTtsTextForSpeech(text) {
    return String(text || '')
        .replace(/\[[\s\S]*?\]|【[\s\S]*?】|\([\s\S]*?\)|\（[\s\S]*?\）/g, '')
        .replace(/<#\d+(?:\.\d+)?#>/g, '，')
        .replace(/\n+/g, '，')
        .replace(/，{2,}/g, '，')
        .trim();
}

export function setCallTtsVolume(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    if (currentTtsGain && currentTtsGainIsCall) {
        currentTtsGain.gain.value = Math.max(0.5, Math.min(2, number));
    } else if (currentTtsSource && typeof currentTtsSource.pause === 'function' && currentTtsGainIsCall) {
        currentTtsSource.volume = Math.max(0, Math.min(1, number));
    }
}

async function trimTtsCacheForChar(charId) {
    if (!charId) return;
    const count = await db.ttsCache.where({ charId }).count();
    if (count <= TTS_CACHE_LIMIT_PER_CHAR) return;

    const overflow = count - TTS_CACHE_LIMIT_PER_CHAR;
    const oldestItems = await db.ttsCache
        .where({ charId })
        .sortBy('timestamp')
        .then(items => items.slice(0, overflow));

    await db.ttsCache.bulkDelete(oldestItems.map(item => item.key));
}

function toPlayableTtsBlob(audio, mimeType = TTS_AUDIO_MIME_TYPE) {
    if (!audio || typeof Blob !== 'function') return null;
    if (audio instanceof Blob) return audio;
    if (typeof audio.arrayBuffer === 'function' && typeof audio.size === 'number') return audio;
    if (audio instanceof ArrayBuffer) return new Blob([audio], { type: mimeType });
    if (ArrayBuffer.isView(audio)) {
        const bytes = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength);
        return new Blob([bytes], { type: mimeType });
    }
    return null;
}

async function toTtsCacheAudio(audio) {
    if (!audio) return null;
    if (audio instanceof ArrayBuffer) return audio;
    if (ArrayBuffer.isView(audio)) {
        return audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength);
    }
    if (typeof audio.arrayBuffer === 'function') return audio.arrayBuffer();
    return null;
}

async function saveTtsCache(cacheKey, audio, charId) {
    try {
        const audioData = await toTtsCacheAudio(audio);
        if (!audioData) return false;
        await db.ttsCache.put({
            key: cacheKey,
            audio: audioData,
            audioType: typeof audio.type === 'string' && audio.type ? audio.type : TTS_AUDIO_MIME_TYPE,
            timestamp: Date.now(),
            charId
        });
        await trimTtsCacheForChar(charId);
        return true;
    } catch (error) {
        // 语音已经生成并可以播放时，缓存失败不能阻断本次播放。
        console.warn('[TTS Cache] 音频缓存失败，跳过缓存:', error);
        return false;
    }
}

// 辅助函数：将十六进制字符串转换为 Uint8Array
function hexToUint8Array(hexString) {
    if (!hexString) return new Uint8Array(0);
    const match = hexString.match(/.{1,2}/g);
    if (!match) return new Uint8Array(0);
    return new Uint8Array(match.map(byte => parseInt(byte, 16)));
}

function stopCurrentTtsSource() {
    const source = currentTtsSource;
    currentTtsSource = null;
    currentTtsGain = null;
    currentTtsGainIsCall = false;
    if (!source) return;

    try {
        if (typeof source.stop === 'function') {
            source.stop();
        } else if (typeof source.pause === 'function') {
            source.pause();
            source.currentTime = 0;
        }
    } catch (error) {
        // 忽略已经结束或失效的音频源
    }

    if (source.__lookyObjectUrl) {
        URL.revokeObjectURL(source.__lookyObjectUrl);
        source.__lookyObjectUrl = '';
    }
}

function getNativeTtsVolume(charId) {
    const volume = Number(getCallVoiceVolume(charId));
    return Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
}

function shouldUseNativeTtsAudio() {
    return isNativeRuntime() && (isHarmonyRuntime() || window.sharedAudioContext?.state !== 'running');
}

function playTtsBlobViaHtmlAudio(blob, charId, onEnded, force = false) {
    if ((!force && !shouldUseNativeTtsAudio()) || typeof Audio !== 'function' || !URL.createObjectURL) return false;

    let objectUrl = '';
    let audio = null;
    try {
        objectUrl = URL.createObjectURL(blob);
        audio = new Audio(objectUrl);
        audio.preload = 'auto';
        audio.volume = getNativeTtsVolume(charId);
        audio.__lookyObjectUrl = objectUrl;
        currentTtsSource = audio;
    } catch (error) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        console.error('TTS HTML Audio 对象创建失败:', error);
        return false;
    }

    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        audio.removeEventListener('ended', cleanup);
        audio.removeEventListener('error', cleanup);
        if (currentTtsSource === audio) {
            currentTtsSource = null;
            currentTtsGain = null;
            currentTtsGainIsCall = false;
        }
        if (audio.__lookyObjectUrl) {
            URL.revokeObjectURL(audio.__lookyObjectUrl);
            audio.__lookyObjectUrl = '';
        }
        onEnded?.();
    };
    audio.addEventListener('ended', cleanup, { once: true });
    audio.addEventListener('error', cleanup, { once: true });

    try {
        const playPromise = audio.play();
        if (playPromise?.catch) {
            playPromise.catch(error => {
                console.error('TTS HTML Audio 播放失败:', error);
                cleanup();
            });
        }
    } catch (error) {
        console.error('TTS HTML Audio 播放失败:', error);
        cleanup();
        return false;
    }
    return true;
}

export const TTSService = {
    async playAudioBlob(blob, options = {}) {
        // 1. 清理状态
        speechQueue.length = 0;
        isSpeaking = false; 

        // 2. 停止当前正在播放的声音 (如果有)
        stopCurrentTtsSource();

        const playableBlob = toPlayableTtsBlob(blob);
        if (!playableBlob) {
            console.error('TTS 播放失败: 音频数据无效');
            showDynamicIsland("⚠️ 语音数据无效", "error");
            return;
        }

        const isCallAudio = tempState.activeCallMode === 'voice' || tempState.activeCallMode === 'video';
        if (playTtsBlobViaHtmlAudio(playableBlob, options.charId)) {
            currentTtsGainIsCall = isCallAudio;
            return;
        }

        // 3. 获取我们在 main.js 解锁好的引擎
        const ctx = window.sharedAudioContext;
        if (!ctx) {
            if (playTtsBlobViaHtmlAudio(playableBlob, options.charId, null, true)) {
                currentTtsGainIsCall = isCallAudio;
                return;
            }
            showDynamicIsland("⚠️ 语音播放失败", "error");
            return;
        }

        try {
            // 4. 解码并播放 (Web Audio API 核心逻辑)
            if (ctx.state !== 'running' && typeof ctx.resume === 'function') await ctx.resume();
            const arrayBuffer = await playableBlob.arrayBuffer();
            const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

            const source = ctx.createBufferSource();
            const gain = ctx.createGain();
            const compressor = isCallAudio ? ctx.createDynamicsCompressor() : null;
            source.buffer = audioBuffer;
            gain.gain.value = getCallVoiceVolume(options.charId);
            if (compressor) {
                compressor.threshold.value = -24;
                compressor.knee.value = 18;
                compressor.ratio.value = 3;
                compressor.attack.value = 0.003;
                compressor.release.value = 0.18;
            }
            source.connect(gain);
            gain.connect(compressor || ctx.destination);
            compressor?.connect(ctx.destination);
            currentTtsSource = source;
            currentTtsGain = gain;
            currentTtsGainIsCall = isCallAudio;
            source.start(0);

            source.onended = () => {
                if (currentTtsSource !== source) return;
                currentTtsSource = null;
                currentTtsGain = null;
                currentTtsGainIsCall = false;
            };
        } catch (e) {
            console.warn("TTS Web Audio 播放失败，尝试兼容播放:", e);
            if (playTtsBlobViaHtmlAudio(playableBlob, options.charId, null, true)) {
                currentTtsGainIsCall = isCallAudio;
                return;
            }
            console.error("TTS 播放失败:", e);
            showDynamicIsland("⚠️ 语音播放失败", "error");
        }
    },async generateElevenLabsSpeech(text, options = {}) {
        const config = AppState.ttsGlobalSettings?.elevenlabs || {};
        const apiKey = String(config.apiKey || '').trim();
        const voiceId = String(options.voiceId || '').trim();

        if (!apiKey || !voiceId) {
            showDynamicIsland("ElevenLabs配置缺失", "error");
            return null;
        }

        const modelId = String(config.model || 'eleven_multilingual_v2').trim();
        const outputFormat = String(config.outputFormat || 'mp3_44100_128').trim();
        const requestUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;

        try {
            const response = await fetch(requestUrl, {
                method: 'POST',
                headers: {
                    'xi-api-key': apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg'
                },
                body: JSON.stringify({
                    text,
                    model_id: modelId
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('ElevenLabs TTS API 报错:', response.status, errorText);
                showDynamicIsland(`ElevenLabs请求失败: ${response.status}`, "error");
                return null;
            }

            return await response.blob();
        } catch (error) {
            console.error("ElevenLabs TTS 网络请求异常:", error);
            showDynamicIsland("ElevenLabs网络错误", "error");
            return null;
        }
    },
async generateSpeech(text, options = {}, tempConfig = null) {
        if (!tempConfig && AppState.ttsGlobalSettings?.provider === 'elevenlabs') {
            return this.generateElevenLabsSpeech(text, options);
        }
        const globalConfig = tempConfig || AppState.ttsGlobalSettings?.minimax;
            if (!globalConfig || !globalConfig.apiKey || !globalConfig.groupId) {
            showDynamicIsland("TTS配置缺失", "error");
            return null;
        }

              // ▼▼▼ [代理修复] 智能判断环境，线上走代理，本地走直连 ▼▼▼
        let baseUrl = 'https://api.minimaxi.com'; // 默认是官方地址(本地用)
        
        // 检测当前网址，如果不是 localhost 或 127.0.0.1，说明是线上
        const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        
        if (!isLocal) {
            // 线上环境：使用相对路径 /minimax-api，这会触发我们刚写的 netlify.toml/_redirects 规则
            // 从而绕过浏览器的 CORS 拦截
            baseUrl = '/minimax-api';
            console.log('[TTS] 线上环境检测到，已启用反向代理通道');
        } else {
            console.log('[TTS] 本地环境检测到，直连官方接口');
        }

        // 拼接最终的请求地址，保留官方文档要求的 /v1/t2a_v2
        const requestUrl = `${baseUrl}/v1/t2a_v2?GroupId=${globalConfig.groupId}`;
        // ▲▲▲ [修复结束] ▲▲▲

        // 【关键修复】如果用户之前保存的是旧模型 speech-01，强制替换为 speech-01-turbo

        let useModel = globalConfig.model || 'speech-01-turbo';
        if (useModel === 'speech-01') {
            useModel = 'speech-01-turbo';
            console.warn('[TTS] 自动修正模型为 speech-01-turbo (适配 V2 接口)');
        }

      const payload = {
            model: useModel,
            text: text,
            stream: false,
            language_boost: 'Chinese' // 【关键修复】为 v2 模型提供一个默认的语言
        };

        // 【最终修复】只有在明确提供了 voiceId 的情况下，才构造并添加 voice_setting 对象
        if (options.voiceId) {
            payload.voice_setting = {
                voice_id: options.voiceId,
                speed: parseFloat(options.speed) || 1.0,
                vol: 1.0,
                pitch: 0
            };
            const emotion = normalizeTtsEmotion(options.emotion);
            if (emotion && emotion !== 'auto') payload.voice_setting.emotion = emotion;
        }

        // 【最终修复】根据官方文档，使用 language_boost 参数来指定语言
        const langBoostMap = {
      'yue': 'Chinese,Yue',
        'zh': 'Chinese',
        'en': 'English',
        'ja': 'Japanese',
        'ko': 'Korean'
        // ...可以根据文档未来添加更多
    };

    if (options.lang && options.lang !== 'auto' && langBoostMap[options.lang]) {
        payload.language_boost = langBoostMap[options.lang];
    }



           try {
            const response = await fetch(requestUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${globalConfig.apiKey}`,
                    'Content-Type': 'application/json'
                },

                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('TTS API 报错:', response.status, errorText);
                showDynamicIsland(`TTS请求失败: ${response.status}`, "error");
                return null;
            }

            const jsonResponse = await response.json();

            // 检查业务错误 (比如 invalid params)
            if (jsonResponse.base_resp && jsonResponse.base_resp.status_code !== 0) {
                console.error("TTS 业务错误:", jsonResponse.base_resp);
                showDynamicIsland(`TTS错误: ${jsonResponse.base_resp.status_msg}`, "error");
                return null;
            }

            if (jsonResponse.data && jsonResponse.data.audio) {
                const audioBytes = hexToUint8Array(jsonResponse.data.audio);
                return new Blob([audioBytes], { type: 'audio/mpeg' });
            } else {
                console.error("TTS 返回数据格式异常:", jsonResponse);
                showDynamicIsland("TTS 返回无效", "error");
                return null;
            }

        } catch (error) {
            console.error("TTS 网络请求异常:", error);
            showDynamicIsland("网络错误", "error");
            return null;
        }
    },
async speakForCharacter(text, charId, options = {}) {
    if (!AppState.ttsGlobalSettings.enabled) return;

    const cleanText = cleanTtsTextForSpeech(text);
    
    // 2. 如果净化后文本为空（比如原文只有"[图片]"），则直接跳过，不进行播放
    if (!cleanText) {

        console.log('[TTS] 文本净化后为空，已跳过播放。');
        return;
    }
    // ▲▲▲ 修改结束 ▲▲▲

    const character = AppState.characterProfiles.find(c => c.id === charId);
    if (!character) return;
    const characterTtsConfig = character.tts || {};
// 如果没有填 Voice ID，直接结束函数，什么都不做
        if (!characterTtsConfig.voiceId) {
            console.log(`[TTS] 角色 ${character.name} 未配置 Voice ID，跳过播放。`);
            return;
        }
    const provider = AppState.ttsGlobalSettings?.provider || 'minimax';
    const voiceId = characterTtsConfig.voiceId || 'default';
    const emotion = normalizeTtsEmotion(options.emotion);
    // 3. 【重要】使用净化后的文本来生成缓存键
    const cacheKey = `${provider}_${cleanText}_${voiceId}_${emotion || 'neutral'}`;

     const cachedAudio = await db.ttsCache.get(cacheKey);

    // 兼容旧版本缓存中的 Blob，以及当前版本缓存中的 ArrayBuffer。
    const cachedAudioBlob = toPlayableTtsBlob(cachedAudio?.audio, cachedAudio?.audioType);
    if (cachedAudioBlob) {
        console.log(`[TTS Cache] 命中！从缓存播放: ${cacheKey} (角色: ${charId})`);
        this.playAudioBlob(cachedAudioBlob, { charId });
        try {
            if (cachedAudio?.audio instanceof Blob) {
                await saveTtsCache(cacheKey, cachedAudioBlob, charId);
            } else {
                await db.ttsCache.update(cacheKey, { timestamp: Date.now() });
            }
        } catch (error) {
            console.warn('[TTS Cache] 更新缓存时间失败，已保留本次播放:', error);
        }
        return;
    }


    // 4. 【重要】使用净化后的文本去生成语音
    const audioBlob = await this.generateSpeech(cleanText, {
        voiceId: characterTtsConfig.voiceId,
        speed: characterTtsConfig.speed,
        lang: characterTtsConfig.language,
        emotion
    });


    if (audioBlob) {
        this.playAudioBlob(audioBlob, { charId });

        console.log(`[TTS Cache] 未命中，存入新缓存: ${cacheKey}`);
        await saveTtsCache(cacheKey, audioBlob, charId);
    }
}, 
/**
 * [视频通话专属] 朗读角色台词，带严格的台词提取和过滤
 * @param {string} text - 包含旁白和台词的原始文本
 * @param {string} charId - 角色ID
 */
async speakForVideoCallCharacter(text, charId, options = {}) {
    if (!AppState.ttsGlobalSettings.enabled) return;
    if (!text) return;
    let cleanText = text.replace(/\[.*?\]|\(.*?\)|\（.*?\）/g, '').trim();
    
    // 2. 【核心修改】严格提取引号内的台词 (支持中文引号 “...” 和 英文引号 "...")
    // 注意：这里 match 会返回包含引号的完整字符串数组
    const quoteMatches = cleanText.match(/“[^”]+”|"[^"]+"/g);
    
    if (quoteMatches && quoteMatches.length > 0) {
        // 3. 过滤掉拟声词 (短且无标点)
        const validDialogues = quoteMatches.filter(q => {
            // 去掉首尾引号
            const content = q.slice(1, -1);
            // 规则：内容长度 > 4 或者 包含标点符号，才会被读出来
            // 这样 "joke" (4字符无标点) 就不会被读出来，而 "Hello" (5字符) 或 "Hi!" (含标点) 会被读
            return content.length > 4 || /[，。？！…～,.?!~]/.test(content);
        });
        
        if (validDialogues.length > 0) {
            // 只保留有效台词，去掉引号并用逗号连接，让 TTS 朗读更自然
            cleanText = validDialogues.map(q => q.slice(1, -1)).join('，');
        } else {
            // 如果全是拟声词或短比喻，则不发声
            console.log('[TTS-Video] 仅检测到拟声词/非台词引用，跳过朗读。');
            return;
        }
    } else {
        // 如果没有引号，认为没有台词，则不发声
        console.log('[TTS-Video] 未检测到“台词”引号，跳过朗读。');
        return;
    }
    
    // 4. 如果最终文本为空，则退出
    if (!cleanText) return;
    console.log(`[TTS-Video] 提取台词朗读: "${cleanText}"`);
    
    // 视频通话里必须走队列，避免同一轮多句台词同时发起 TTS 请求。
    this.addToSpeechQueue(cleanText, charId, options);
},
 // [新增] 函数1：将语音任务添加到队列，并尝试启动播放
    addToSpeechQueue(text, charId, options = {}) {
        if (!AppState.ttsGlobalSettings.enabled) return;
        
        const cleanText = cleanTtsTextForSpeech(text);
        
        if (!cleanText) {
            console.log('[TTS Queue] 文本净化后为空，已跳过加入队列。');
            return;
        }

        speechQueue.push({ text: cleanText, charId, emotion: normalizeTtsEmotion(options.emotion) });
        this._processSpeechQueue(); // 尝试处理队列
    },

    // [新增] 函数2：处理语音队列的核心逻辑
    async _processSpeechQueue() {
        if (isSpeaking || speechQueue.length === 0) {
            return; // 如果正在播放，或队列已空，则退出
        }

        isSpeaking = true; // 标记为“正在播放”
        const task = speechQueue.shift(); // 取出队列中的第一个任务

        const character = AppState.characterProfiles.find(c => c.id === task.charId);
        if (!character) {
            isSpeaking = false;
            this._processSpeechQueue(); // 角色不存在，直接处理下一条
            return;
        }

        const characterTtsConfig = character.tts || {};
        if (!characterTtsConfig.voiceId) {
            console.log(`[TTS Queue] 角色 ${character.name} 未配置 Voice ID，跳过队列任务。`);
            isSpeaking = false; // 标记为空闲
            this._processSpeechQueue(); // 继续处理队列里的下一条
            return;
        }
        const provider = AppState.ttsGlobalSettings?.provider || 'minimax';
        const voiceId = characterTtsConfig.voiceId || 'default';
        const emotion = normalizeTtsEmotion(task.emotion);
        const cacheKey = `${provider}_${task.text.trim()}_${voiceId}_${emotion || 'neutral'}`;
        const cachedAudio = await db.ttsCache.get(cacheKey);

        let audioBlob = null;
        const cachedAudioBlob = toPlayableTtsBlob(cachedAudio?.audio, cachedAudio?.audioType);
        if (cachedAudioBlob) {
            console.log(`[TTS Queue] 命中缓存: ${cacheKey}`);
            audioBlob = cachedAudioBlob;
        } else {
            console.log(`[TTS Queue] 未命中缓存，正在生成: ${cacheKey}`);
            audioBlob = await this.generateSpeech(task.text, {
                voiceId: characterTtsConfig.voiceId,
                speed: characterTtsConfig.speed,
                lang: characterTtsConfig.language,
                emotion
            });
            // 存入缓存
            if (audioBlob) {
                await saveTtsCache(cacheKey, audioBlob, task.charId);
            }
        }

        if (audioBlob) {
            this._playQueueItem(audioBlob, task.charId);
        } else {
            // 如果生成失败，也要继续处理队列
            isSpeaking = false;
            this._processSpeechQueue();
        }
    },async _playQueueItem(blob, charId = null) {
        const isCallAudio = tempState.activeCallMode === 'voice' || tempState.activeCallMode === 'video';
        const playableBlob = toPlayableTtsBlob(blob);
        const finishQueueItem = () => {
            isSpeaking = false;
            this._processSpeechQueue();
        };
        if (!playableBlob) {
            finishQueueItem();
            return;
        }
        if (playTtsBlobViaHtmlAudio(playableBlob, charId, finishQueueItem)) {
            currentTtsGainIsCall = isCallAudio;
            return;
        }

        const ctx = window.sharedAudioContext;
        if (!ctx) {
             if (playTtsBlobViaHtmlAudio(playableBlob, charId, finishQueueItem, true)) {
                 currentTtsGainIsCall = isCallAudio;
                 return;
             }
             finishQueueItem();
             return;
        }

        try {
            // 解码数据
            if (ctx.state !== 'running' && typeof ctx.resume === 'function') await ctx.resume();
            const arrayBuffer = await playableBlob.arrayBuffer();
            const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

            // 创建音源
            const source = ctx.createBufferSource();
             const gain = ctx.createGain();
             const compressor = ctx.createDynamicsCompressor();
             source.buffer = audioBuffer;
             gain.gain.value = getCallVoiceVolume(charId);
            compressor.threshold.value = -24;
            compressor.knee.value = 18;
            compressor.ratio.value = 3;
            compressor.attack.value = 0.003;
            compressor.release.value = 0.18;
             source.connect(gain);
             gain.connect(compressor);
             compressor.connect(ctx.destination);
             currentTtsSource = source;
             currentTtsGain = gain;
             currentTtsGainIsCall = isCallAudio;
            
            // 播放
            source.start(0);

            // 监听播放结束，继续下一条
             source.onended = () => {
                 if (currentTtsSource === source) {
                     currentTtsSource = null;
                     currentTtsGain = null;
                     currentTtsGainIsCall = false;
                 }
                 isSpeaking = false; 
                this._processSpeechQueue(); 
            };
         } catch (e) {
             console.warn("TTS 队列 Web Audio 播放失败，尝试兼容播放:", e);
             if (playTtsBlobViaHtmlAudio(playableBlob, charId, finishQueueItem, true)) {
                 currentTtsGainIsCall = isCallAudio;
                 return;
             }
             console.error("TTS 队列播放失败:", e);
             // 即使失败，也要重置状态并继续下一条，防止卡死
             finishQueueItem();
         }
    }
};

