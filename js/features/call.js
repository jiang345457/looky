// js/features/call.js

import { AppState, db, tempState, DEFAULT_AVATAR_SRC } from '../state.js';
import { showDynamicIsland, showPage } from '../ui.js';
import { formatTime, isValidAvatarSrc, escapeHTML } from '../utils.js';
import { createAndAppendMessage as appendMessageToUI,getCurrentChatIdentity } from './chat-ui.js';
import { startVideoCall as launchVideoCall } from './video-call.js';
import { showCallMiniWidget, hideCallMiniWidget, setCallMiniWidgetGenerating } from './call-widget.js';
import { TTSService } from './tts-service.js';
import { getCallSettings, requestCallQuickSettings, startCallAmbient, stopCallAmbient } from './call-audio.js';
import { getVoiceRecognitionSettings, isApiVoiceRecognitionEnabled, isApiVoiceCaptureActive, startApiVoiceCapture, stopApiVoiceCapture, cancelApiVoiceCapture } from './speech-service.js';
import { isNativeRuntime } from '../native-bridge.js';
import { getSleepCallRejectRate, markSleepAwakenedByCall } from './sleep-system.js';
const isSameCharacterId = (left, right) => left != null && right != null && String(left) === String(right);
const hasCharacterId = (ids, id) => (ids || []).some(item => isSameCharacterId(item, id));
const findCharacterById = (id) => AppState.characterProfiles.find(char => isSameCharacterId(char.id, id));

function getGroupParticipants(group) {
    const members = (group?.memberIds || []).map(findCharacterById).filter(Boolean);
    const memberNames = new Set(members.map(member => member.name));
    const npcs = (Array.isArray(group?.groupNpcMembers) ? group.groupNpcMembers : [])
        .map((npc, index) => ({ ...npc, id: String(npc?.id || `group-npc:${npc?.ownerId}:${index}`), isGroupNpc: true }))
        .filter(npc => npc.ownerId && hasCharacterId(group.memberIds, npc.ownerId) && npc.name && !memberNames.has(npc.name));
    return [...members, ...npcs];
}

function findGroupParticipantById(group, id) {
    return getGroupParticipants(group).find(member => isSameCharacterId(member.id, id));
}

function normalizeVoiceCallDescription(value) {
    return typeof value === 'string'
        ? value.replace(/[\r\n]+/g, ' ').trim().slice(0, 240)
        : '';
}
let pendingAiVoiceCallChatId = null;
let pendingAiGroupCallChatId = null;
let pendingAiVideoCallChatId = null;
let currentVoiceCallChatId = null;
let currentVoiceCallContext = null;
// 模块级别的变量
let callTimerInterval = null;
let callSeconds = 0;
let callStartTimeout = null; 
const callHistoryModalOverlay = document.getElementById('call-history-modal-overlay');
const callHistoryMessageList = document.getElementById('call-history-message-list');
const closeCallHistoryBtn = document.getElementById('close-call-history-btn');
const callHistoryCharAvatar = document.getElementById('call-history-char-avatar');
const callHistoryCharName = document.getElementById('call-history-char-name');
const callHistoryModalCard = document.getElementById('call-history-modal-card');
function setVoiceCallGeneratingState(isGenerating) {
    const sendBtn = document.getElementById('voice-call-send-btn');
    if (sendBtn) sendBtn.classList.toggle('is-generating', Boolean(isGenerating));
    setCallMiniWidgetGenerating(isGenerating);
}

function syncVoiceCallMiniWidget(displayAvatar, displayName, onRestore, onHangUp, options = {}) {
    const voiceCallStatus = document.getElementById('voice-call-status');
    const widgetOptions = {
        mode: 'voice',
        avatarSrc: displayAvatar || DEFAULT_AVATAR_SRC,
        title: displayName || '语音通话',
        subtitle: options.subtitle || voiceCallStatus?.textContent || '语音通话中',
        timer: formatTime(callSeconds),
        onRestore,
        onHangUp,
    };
    if (typeof options.expanded === 'boolean') widgetOptions.expanded = options.expanded;
    if (typeof options.inputValue === 'string') widgetOptions.inputValue = options.inputValue;
    if (typeof options.placeholder === 'string') widgetOptions.placeholder = options.placeholder;
    if (typeof options.onSendText === 'function') widgetOptions.onSendText = options.onSendText;
    if (typeof options.onDraftChange === 'function') widgetOptions.onDraftChange = options.onDraftChange;
    if (typeof options.onRegenerate === 'function') widgetOptions.onRegenerate = options.onRegenerate;
    if (typeof options.onDelete === 'function') widgetOptions.onDelete = options.onDelete;
    showCallMiniWidget(widgetOptions);
}

function restoreVoiceCallScreen() {
    if (!tempState.currentCallId) return;
    const chatDetailPage = document.getElementById('page-chat-detail');
    const activeCallChatId = tempState.activeCallChatId || currentVoiceCallChatId;
    if (chatDetailPage?.style.display === 'flex'
        && tempState.currentChatId
        && activeCallChatId
        && String(tempState.currentChatId) !== String(activeCallChatId)) {
        tempState.callReturnChatId = tempState.currentChatId;
    }
    tempState.callWidgetMinimized = false;
    hideCallMiniWidget({ clearDraft: false });
    tempState.currentChatId = activeCallChatId || tempState.currentChatId;
    showPage('page-voice-call');
}

function createSimplifiedMessageElementForCall(messageData) {
    if (messageData.uiVisible === false || messageData.type === 'system' || messageData.recalled) {
        return null;
    }
    const messageWrapper = document.createElement('div');
    messageWrapper.dataset.messageId = String(messageData.id);
    const voiceDescription = normalizeVoiceCallDescription(messageData.voiceDescription);
    messageWrapper.className = `call-log-entry ${messageData.type}${voiceDescription ? ' has-voice-description' : ''}`;
    
    let finalAvatarSrc = DEFAULT_AVATAR_SRC;
    // 获取当前角色信息，用于查找覆写设置
    const callChatId = messageData.chatId || tempState.activeCallChatId || currentVoiceCallChatId;
    const character = findCharacterById(callChatId);

    // ▼▼▼ 【核心修改】头像逻辑 ▼▼▼
    if (messageData.type === 'sent') {
        const identityIdToUse = messageData.callIdentityId || character?.chatIdentityId || AppState.currentIdentityId;
        const user = AppState.userIdentities.find(id => String(id.id) === String(identityIdToUse)) || AppState.userIdentities[0];
        // 优先使用在该角色下的用户专属头像
        finalAvatarSrc = messageData.avatarSrc || character?.chatOverrideUserAvatar || user?.avatar || DEFAULT_AVATAR_SRC;
    } else {
        // 通话消息入库时已经保存了当时绑定的头像，优先使用它，不能再按当前页面角色重算
        if (isValidAvatarSrc(messageData.avatarSrc)) {
            finalAvatarSrc = messageData.avatarSrc;
        }
        // ▼▼▼ 【修复：精准提取群聊成员头像】 ▼▼▼
        const speakerProfile = messageData.speakerId
            ? (character?.isGroup ? findGroupParticipantById(character, messageData.speakerId) : findCharacterById(messageData.speakerId))
            : null;
        if (!isValidAvatarSrc(messageData.avatarSrc) && character && character.isGroup) {
            // 如果是群聊，优先根据ID找，找不到再根据名字找他的真实人脸头像
            let groupSpeakerProfile = speakerProfile;
            if (!groupSpeakerProfile && messageData.speakerName) {
                groupSpeakerProfile = getGroupParticipants(character).find(member => member.name === messageData.speakerName);
            }
            finalAvatarSrc = groupSpeakerProfile?.avatar || character?.avatar || DEFAULT_AVATAR_SRC;
        } else if (!isValidAvatarSrc(messageData.avatarSrc)) {

            // 单聊，老老实实使用单聊角色的头像
            finalAvatarSrc = speakerProfile?.chatOverrideAvatar || speakerProfile?.avatar || character?.chatOverrideAvatar || character?.avatar || DEFAULT_AVATAR_SRC;
        }
        // ▲▲▲ 修改结束 ▲▲▲
    }

    const avatarColumn = document.createElement('div');
    avatarColumn.className = 'call-log-side';
    const avatar = document.createElement('img');
    avatar.className = 'call-log-avatar';
    avatar.src = isValidAvatarSrc(finalAvatarSrc) ? finalAvatarSrc : DEFAULT_AVATAR_SRC;
    avatarColumn.appendChild(avatar);
   
    const bubble = document.createElement('article');
    bubble.className = 'call-log-card';
    const meta = document.createElement('div');
    meta.className = 'call-log-meta';
    meta.textContent = messageData.type === 'sent' ? 'YOU / OUTGOING' : 'VOICE / INCOMING';
    const bubbleText = document.createElement('p');
    bubbleText.className = 'call-log-text';
    const cleanText = messageData.text
        .replace(/<[^>]+>/g, '')             
        .replace(/\[MSG ID: \d+\]\s*/g, '')
        .replace(/\[语音消息\]/g, ''); 
        bubbleText.innerHTML = escapeHTML(cleanText).replace(/\n/g, '<br>');

    bubble.appendChild(meta);
    bubble.appendChild(bubbleText);
    if (messageData.translation) {
        const transDiv = document.createElement('div');
        transDiv.className = 'call-log-translation';
        transDiv.innerHTML = escapeHTML(messageData.translation).replace(/\n/g, '<br>');
        bubble.appendChild(transDiv);
    }
    if (messageData.type === 'received' && cleanText) {
        const ttsBtn = document.createElement('button');
        ttsBtn.type = 'button';
        ttsBtn.className = 'call-history-tts-btn';
        ttsBtn.title = '播放这段语音';
        ttsBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="9" width="2" height="6" rx="1"></rect><rect x="10" y="6" width="2" height="12" rx="1"></rect><rect x="14" y="8" width="2" height="8" rx="1"></rect><rect x="18" y="10" width="2" height="4" rx="1"></rect></svg>';
        ttsBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            const displayedSpeaker = character?.isGroup && messageData.speakerId
                ? findGroupParticipantById(character, messageData.speakerId)
                : null;
            const speakerId = displayedSpeaker?.ownerId || messageData.speakerId || tempState.currentChatId;
            if (messageData.isVideoHistory) {
                TTSService.speakForVideoCallCharacter(cleanText, speakerId, { emotion: messageData.ttsEmotion });
            } else {
                TTSService.speakForCharacter(cleanText, speakerId, { emotion: messageData.ttsEmotion });
            }
        });
        avatarColumn.appendChild(ttsBtn);
    }
    messageWrapper.appendChild(avatarColumn);
    messageWrapper.appendChild(bubble);
    if (voiceDescription) {
        const descriptionBox = document.createElement('div');
        descriptionBox.className = 'voice-call-description';
        descriptionBox.textContent = voiceDescription;
        messageWrapper.appendChild(descriptionBox);
    }

    return messageWrapper;
}

export async function showCallHistoryModal(callId) {
    if (callHistoryModalCard) {
        callHistoryModalCard.classList.remove('video-history-mode');
        callHistoryModalCard.style.backgroundImage = '';
    }
    if (callHistoryCharName) {
        callHistoryCharName.style.color = ''; 
    }
    const callMessages = await db.chatMessages.where('callId').equals(callId).sortBy('timestamp');
    const visibleMessages = callMessages.filter(m =>
        m.contentType !== 'voice_call_summary' && m.type !== 'system'
    );
    if (visibleMessages.length === 0) {
        showDynamicIsland('没有聊天记录');
        return;
    }
    const character = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
    
    // ▼▼▼ 【核心修改】头部信息 ▼▼▼
    if (character) {
        const displayAvatar = character.chatOverrideAvatar || character.avatar || DEFAULT_AVATAR_SRC;
        const displayName = character.chatOverrideName || character.name || '角色';
        
        callHistoryCharAvatar.src = displayAvatar;
        callHistoryCharName.textContent = displayName;
    }
    // ▲▲▲ 修改结束 ▲▲▲

    callHistoryMessageList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    visibleMessages.forEach(msg => {
        const msgElement = createSimplifiedMessageElementForCall(msg);
        if (msgElement) {
            fragment.appendChild(msgElement);
        }
    });
    callHistoryMessageList.appendChild(fragment);
    callHistoryModalOverlay.classList.add('visible');
    callHistoryMessageList.scrollTop = callHistoryMessageList.scrollHeight;
}

/**
 * 由 AI 主动发起通话，显示来电界面
 */
export async function initiateAiCall(chatId = null) {
    const targetChatId = chatId || tempState.currentChatId;
    const chatDetailPage = document.getElementById('page-chat-detail');
    if (!chatDetailPage || chatDetailPage.style.display !== 'flex' || tempState.currentCallId) {
        return;
    }

    const char = AppState.characterProfiles.find(c => isSameCharacterId(c.id, targetChatId));
    if (!char) return;

    const incomingCallOverlay = document.getElementById('incoming-call-overlay');
    const incomingCallAvatar = document.getElementById('incoming-call-avatar');
    const incomingCallName = document.getElementById('incoming-call-name');
    const incomingCallBg = document.getElementById('incoming-call-bg');

    if (!incomingCallOverlay || !incomingCallAvatar || !incomingCallName || !incomingCallBg) return;

    // ▼▼▼ 【核心修改】显示覆写信息 ▼▼▼
    const displayAvatar = char.chatOverrideAvatar || char.avatar || DEFAULT_AVATAR_SRC;
    const displayName = char.chatOverrideName || char.name;
    // ▼▼▼ 【核心修改】区分群聊横幅与单聊全屏 ▼▼▼
    if (char.isGroup) {
        const banner = document.getElementById('incoming-group-call-banner');
        const bannerAvatar = document.getElementById('incoming-group-call-avatar');
        const bannerName = document.getElementById('incoming-group-call-name');
        if (banner && bannerAvatar && bannerName) {
            pendingAiGroupCallChatId = targetChatId;
            bannerAvatar.src = displayAvatar;
            bannerName.textContent = displayName;
            banner.classList.add('show'); // 触发横幅滑出动画
        }
    } else {
        pendingAiVoiceCallChatId = targetChatId;
        incomingCallAvatar.src = displayAvatar;
        incomingCallName.textContent = displayName;
        incomingCallBg.style.backgroundImage = `url(${displayAvatar})`;
        incomingCallOverlay.classList.add('visible'); // 触发全屏动画
    }
    // ▲▲▲ 修改结束 ▲▲▲
    
    if (window.playIncomingCallSound) {

        window.playIncomingCallSound();
    }
}

/**
 * 初始化通话功能的所有逻辑和事件监听
 * @param {object} deps - 依赖的外部函数
 */
export function initCallFunctionality(deps) {
     initVideoIncomingEvents();
      const voiceCrashBackup = sessionStorage.getItem('voice_call_crash_backup');
    if (voiceCrashBackup) {
        try {
            const backupData = JSON.parse(voiceCrashBackup);
            const duration = Math.round((Date.now() - backupData.startTime) / 1000); // 计算时长
            // 补发一条总结消息到数据库
            db.chatMessages.add({
                chatId: backupData.chatId,
                timestamp: new Date(),
                type: backupData.initiator === 'ai' ? 'received' : 'sent', // 谁发起的，总结就算谁发的
                contentType: 'voice_call_summary',
                text: `通话意外中断 (时长 ${formatTime(duration)})`, // 加上时间
                duration: duration,
                callId: backupData.id,
            }).then(() => console.log('[Voice Call Guard] 已成功补救意外中断的语音通话记录。'));
        } catch (e) { console.error('恢复语音通话记录失败', e); }
        sessionStorage.removeItem('voice_call_crash_backup'); // 清除备份
    }
    const {
        loadAndRenderChatHistory,
        hideTypingIndicator,
        getCurrentChatIdentity,
        showTypingIndicator,
        triggerAiResponse,
        cancelAiGeneration,
        isModeGenerating,
        regenerateLastResponse,
        deleteLastCallResponse,
    } = deps;
    let voiceCallMiniMeta = {
        avatar: DEFAULT_AVATAR_SRC,
        name: '语音通话',
    };
    let submitVoiceCallMessage = null;
    let speechRecognition = null;
    let speechRecognitionRequested = false;
    let speechRecognitionActive = false;
    let speechRecognitionRestartTimer = null;
    let speechRecognitionBaseText = '';
    let speechRecognitionCallContext = null;
    let apiVoiceCallContext = null;
    let speechSendChain = Promise.resolve();
    let speechSilenceTimer = null;
    let speechRecognitionInterimText = '';
    let toggleMicBtn = null;
    let voiceCallTextarea = null;
    let voiceCallTranscriptPreview = null;
    let apiVoiceCaptureStopping = false;

    const speechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const getActiveVoiceCallContext = () => {
        if (!tempState.currentCallId || tempState.activeCallMode !== 'voice') return null;
        const chatId = tempState.activeCallChatId || currentVoiceCallChatId;
        if (!chatId) return null;
        return Object.freeze({ callId: String(tempState.currentCallId), chatId });
    };
    const isActiveVoiceCallContext = (context) => Boolean(
        context
        && tempState.activeCallMode === 'voice'
        && String(tempState.currentCallId) === String(context.callId)
        && String(tempState.activeCallChatId) === String(context.chatId)
    );
    const setVoiceTranscriptPreview = (text = '') => {
        if (!voiceCallTranscriptPreview) return;
        const value = String(text || '').trim();
        voiceCallTranscriptPreview.textContent = value;
        voiceCallTranscriptPreview.hidden = !value;
    };
    const setSpeechRecognitionUi = (isActive, statusText = '') => {
        if (!toggleMicBtn) return;
        toggleMicBtn.classList.toggle('is-listening', Boolean(isActive));
        toggleMicBtn.setAttribute('aria-pressed', String(Boolean(isActive)));
        toggleMicBtn.title = isActive ? '停止语音识别' : '开始语音识别';
        toggleMicBtn.setAttribute('aria-label', toggleMicBtn.title);
    };

    const clearSpeechSilenceTimer = () => {
        if (!speechSilenceTimer) return;
        clearTimeout(speechSilenceTimer);
        speechSilenceTimer = null;
    };

    const scheduleSpeechRecognitionSend = (callContext) => {
        clearSpeechSilenceTimer();
        if (!speechRecognitionBaseText && !speechRecognitionInterimText) return;
        setSpeechRecognitionUi(true, '已识别，停顿 5 秒自动发送');
        speechSilenceTimer = setTimeout(() => {
            speechSilenceTimer = null;
            const recognizedText = [speechRecognitionBaseText, speechRecognitionInterimText]
                .filter(Boolean)
                .join(' ')
                .trim();
            speechRecognitionBaseText = '';
            speechRecognitionInterimText = '';
            if (!recognizedText || !isActiveVoiceCallContext(callContext)) return;
            speechSendChain = speechSendChain.then(async () => {
                const sent = await sendRecognizedVoiceText(recognizedText, callContext);
                if (sent === false && isActiveVoiceCallContext(callContext)) {
                    speechRecognitionBaseText = [recognizedText, speechRecognitionBaseText].filter(Boolean).join(' ');
                    setVoiceTranscriptPreview(speechRecognitionBaseText);
                }
            }).catch((error) => {
                if (!isActiveVoiceCallContext(callContext)) return;
                speechRecognitionBaseText = [recognizedText, speechRecognitionBaseText].filter(Boolean).join(' ');
                setVoiceTranscriptPreview(speechRecognitionBaseText);
                console.error('[Voice Call] 识别文本发送失败：', error);
            });
        }, 5 * 1000);
    };

    const stopSpeechRecognition = () => {
        cancelApiVoiceCapture();
        apiVoiceCaptureStopping = false;
        speechRecognitionRequested = false;
        speechRecognitionBaseText = '';
        speechRecognitionInterimText = '';
        clearSpeechSilenceTimer();
        speechRecognitionCallContext = null;
        apiVoiceCallContext = null;
        setVoiceTranscriptPreview('');
        if (speechRecognitionRestartTimer) {
            clearTimeout(speechRecognitionRestartTimer);
            speechRecognitionRestartTimer = null;
        }
        if (speechRecognition) {
            try { speechRecognition.abort(); } catch (error) { /* already stopped */ }
        }
        speechRecognitionActive = false;
        setSpeechRecognitionUi(false);
    };

    const sendRecognizedVoiceText = async (recognizedResult, callContext) => {
        const result = typeof recognizedResult === 'string'
            ? { text: recognizedResult }
            : (recognizedResult || {});
        const text = String(result.text || '').trim();
        const speechContext = String(result.speechContext || '').trim().slice(0, 240);
        if (!text || !isActiveVoiceCallContext(callContext)) return false;
        setVoiceTranscriptPreview(text);
        const sent = await submitVoiceCallMessage?.(text, { fromSpeech: true, speechContext, callContext });
        if (!isActiveVoiceCallContext(callContext)) return false;
        if (sent === false && voiceCallTextarea) voiceCallTextarea.value = text;
        return sent;
    };

    const startApiVoiceRecognition = async () => {
        const callContext = getActiveVoiceCallContext();
        if (!callContext) return;
        try {
            const session = await startApiVoiceCapture(callContext);
            apiVoiceCallContext = callContext;
            session.onLimitReached = (message) => {
                if (!isActiveVoiceCallContext(callContext)) return;
                stopApiVoiceRecognition();
            };
            session.onSilence = () => {
                if (!isActiveVoiceCallContext(callContext)) return;
                stopApiVoiceRecognition({ automatic: true });
            };
            if (!isActiveVoiceCallContext(callContext)) {
                cancelApiVoiceCapture();
                return;
            }
            setVoiceTranscriptPreview('正在录音，停顿 5 秒后自动识别并发送');
            setSpeechRecognitionUi(true, '正在录入，停顿 5 秒自动发送');
        } catch (error) {
            if (!isActiveVoiceCallContext(callContext)) return;
            showDynamicIsland(error?.message || '无法启动语音识别');
            setSpeechRecognitionUi(false, '识别未启动');
        }
    };

    const stopApiVoiceRecognition = async ({ automatic = false } = {}) => {
        if (apiVoiceCaptureStopping) return;
        apiVoiceCaptureStopping = true;
        const callContext = apiVoiceCallContext;
        setSpeechRecognitionUi(false, automatic ? '检测到停顿，正在识别' : '识别中，请稍候');
        try {
            const recognizedResult = await stopApiVoiceCapture();
            if (recognizedResult?.text) await sendRecognizedVoiceText(recognizedResult, callContext);
            else if (isActiveVoiceCallContext(callContext)) showDynamicIsland('没有识别到语音内容');
        } catch (error) {
            if (isActiveVoiceCallContext(callContext)) showDynamicIsland(error?.message || '语音识别失败');
            console.warn('[Voice Call] 自定义识别 API 失败：', error);
        } finally {
            apiVoiceCaptureStopping = false;
            if (isActiveVoiceCallContext(callContext)) setSpeechRecognitionUi(false);
            if (apiVoiceCallContext === callContext) apiVoiceCallContext = null;
        }
    };

    const startSpeechRecognition = () => {
        if (isNativeRuntime()) {
            showDynamicIsland('APK 不使用浏览器语音识别，请在“声音与语音”中配置识别 API');
            setSpeechRecognitionUi(false, '请配置识别 API');
            return;
        }
        if (!speechRecognitionCtor) {
            showDynamicIsland('当前浏览器不支持语音识别，请使用 Chrome 或 Edge');
            setSpeechRecognitionUi(false, '浏览器不支持');
            return;
        }
        if (!tempState.currentCallId || tempState.activeCallMode !== 'voice') return;
        const callContext = getActiveVoiceCallContext();
        speechRecognitionCallContext = callContext;
        const selectedLanguage = getVoiceRecognitionSettings().language;
        const languageMap = { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP' };
        if (!speechRecognition) {
            speechRecognition = new speechRecognitionCtor();
            speechRecognition.continuous = true;
            speechRecognition.interimResults = true;
            speechRecognition.maxAlternatives = 1;

            speechRecognition.onstart = () => {
                if (!isActiveVoiceCallContext(speechRecognitionCallContext)) {
                    try { speechRecognition.abort(); } catch (error) { /* recognition already stopped */ }
                    return;
                }
                speechRecognitionActive = true;
                setSpeechRecognitionUi(true, '正在识别，停顿 5 秒自动发送');
            };

            speechRecognition.onresult = (event) => {
                const resultCallContext = speechRecognitionCallContext;
                if (!isActiveVoiceCallContext(resultCallContext)) return;
                let finalText = '';
                let interimText = '';
                for (let index = event.resultIndex; index < event.results.length; index += 1) {
                    const transcript = event.results[index][0]?.transcript || '';
                    if (event.results[index].isFinal) finalText += transcript;
                    else interimText += transcript;
                }

                if (interimText) speechRecognitionInterimText = interimText.trim();
                if (finalText.trim()) {
                    speechRecognitionBaseText = [speechRecognitionBaseText, finalText.trim()]
                        .filter(Boolean)
                        .join(' ');
                    speechRecognitionInterimText = '';
                }
                const previewText = [speechRecognitionBaseText, speechRecognitionInterimText]
                    .filter(Boolean)
                    .join(' ')
                    .trim();
                if (!previewText) return;
                setVoiceTranscriptPreview(previewText);
                scheduleSpeechRecognitionSend(resultCallContext);
            };

            speechRecognition.onerror = (event) => {
                if (event.error === 'aborted' || !speechRecognitionRequested) {
                    return;
                }
                console.warn('[Voice Call] 语音识别失败：', event.error);
                if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                    speechRecognitionRequested = false;
                    showDynamicIsland(isNativeRuntime()
                        ? 'APK 的浏览器语音识别不可用，请在“声音与语音”中配置识别 API'
                        : '请允许浏览器使用麦克风');
                    setSpeechRecognitionUi(false, '麦克风未授权');
                } else if (event.error === 'network') {
                    speechRecognitionRequested = false;
                    showDynamicIsland('语音识别服务暂时不可用');
                    setSpeechRecognitionUi(false, '识别不可用');
                } else if (event.error === 'no-speech') {
                    if (speechRecognitionBaseText || speechRecognitionInterimText) {
                        scheduleSpeechRecognitionSend(speechRecognitionCallContext);
                    } else {
                        setSpeechRecognitionUi(true, '正在等待你说话');
                    }
                } else if (event.error === 'audio-capture') {
                    speechRecognitionRequested = false;
                    showDynamicIsland('无法获取麦克风音频');
                    setSpeechRecognitionUi(false, '麦克风不可用');
                } else if (event.error === 'language-not-supported') {
                    speechRecognitionRequested = false;
                    showDynamicIsland('当前识别语言不受支持');
                    setSpeechRecognitionUi(false, '语言不支持');
                } else {
                    speechRecognitionRequested = false;
                    setSpeechRecognitionUi(false, '识别失败');
                }
            };

            speechRecognition.onend = () => {
                speechRecognitionActive = false;
                if (speechRecognitionRequested && isActiveVoiceCallContext(speechRecognitionCallContext)) {
                    setSpeechRecognitionUi(true, '正在重新连接');
                    speechRecognitionRestartTimer = setTimeout(() => {
                        speechRecognitionRestartTimer = null;
                        try { speechRecognition.start(); } catch (error) { /* browser is still closing */ }
                    }, 180);
                } else {
                    setSpeechRecognitionUi(false);
                }
            };
        }

        speechRecognition.lang = languageMap[selectedLanguage] || navigator.language || 'zh-CN';
        speechRecognitionRequested = true;
        if (speechRecognitionActive) return;
        try {
            speechRecognition.start();
        } catch (error) {
            if (error?.name !== 'InvalidStateError') {
                speechRecognitionRequested = false;
                setSpeechRecognitionUi(false, '识别失败');
                showDynamicIsland('无法启动语音识别');
            }
        }
    };

    const startCallTimer = () => {
        const voiceCallTimer = document.getElementById('voice-call-timer');
        const voiceCallStatus = document.getElementById('voice-call-status');
        clearInterval(callTimerInterval);
         if (callStartTimeout) clearTimeout(callStartTimeout); 
        callSeconds = 0;
        voiceCallTimer.textContent = formatTime(callSeconds);
       callStartTimeout = setTimeout(() => {
            voiceCallStatus.textContent = "通话中";
            callTimerInterval = setInterval(() => {
                callSeconds++;
                voiceCallTimer.textContent = formatTime(callSeconds);
                if (tempState.callWidgetMinimized) {
                    syncVoiceCallMiniWidget(voiceCallMiniMeta.avatar, voiceCallMiniMeta.name, restoreVoiceCallScreen, hangUpVoiceCall);
                }
            }, 1000);
        }, 2000);
    };

  const setupAndStartCallScreen = async (character) => {
        stopSpeechRecognition();
        currentVoiceCallChatId = character.id;
        tempState.currentChatId = character.id;
        tempState.currentCallId = Date.now().toString();
        currentVoiceCallContext = Object.freeze({
            callId: tempState.currentCallId,
            chatId: character.id,
        });
        tempState.activeCallChatId = character.id;
        tempState.activeCallMode = 'voice';
        tempState.callReturnPageId = 'page-chat-detail';
        tempState.callReturnChatId = character.id;
        tempState.callWidgetMinimized = false;
        hideCallMiniWidget();
                // 【新增防错】：一旦进入语音通话界面，强制掐断所有铃声
        if (window.stopIncomingCallSound) window.stopIncomingCallSound();

         sessionStorage.setItem('voice_call_crash_backup', JSON.stringify({
            id: tempState.currentCallId,
            chatId: currentVoiceCallChatId,
            startTime: Date.now(),
            initiator: tempState.callInitiator || 'user'
        }));
        if ((tempState.callInitiator || 'user') === 'user') {
            await markSleepAwakenedByCall(character, tempState.currentCallId).catch(error => {
                console.warn('[睡眠计划] 记录语音通话唤醒状态失败:', error);
            });
        }
            // ▼▼▼ 【新增】动态生成群聊和单聊的系统指令，严格限制发言人 ▼▼▼
        const callSettings = getCallSettings(character.id);
        let callSystemPrompt = `[系统指令：语音通话模式已激活]\n你的行为模式必须立即切换：\n1. **输出内容**：你的所有回复都必须是**纯粹的口语对话**，模拟真人在说话。\n2. **声音描述设置**：是否输出声音与环境描述，以每次回复前注入的当前设置为准。\n3. **格式限制**：通话中只允许输出 JSON 类型 "voice"、"hang_up_call"。普通说话必须用 "voice"，不要用 "text"；翻译必须写在 "voice.translation" 字段里，不是单独的 JSON 类型。\n4. **语音情绪**：每个 "voice" 必须带 "emotion" 字段；优先使用 "auto"，让语音模型根据 content 自己判断语气。只有当情绪非常明确时，才从 "happy"、"sad"、"angry"、"fearful"、"disgusted"、"calm" 中选择；不要使用 "surprised"。这个字段只给语音合成用，不要写进 content。\n5. **语音分段**：普通语音电话回复通常输出 2-3 条 "voice"，每条 content 控制在 1-2 句自然口语；不要切成很多碎片，也不要把一大段话塞进同一个 "voice"。如果情绪发生变化，请拆成不同 "voice" 并分别使用对应 emotion。\n6. **绝对禁止**：严禁输出 "transfer"、"accept_transfer"、"reject_transfer"、"sticker"、"photo"、"location"、"post_moment"、"call"、"video_call" 等其他任何JSON指令。\n7. **翻译**：如果 "voice" 的 content 不是普通话中文，必须带上 "translation" 字段写中文翻译。\n8. **风格**：保持对话自然、口语化，不要机械分句。`;
        
        if (character.isGroup) {
            let activeNames = '全体成员';
            if (tempState.callParticipants && tempState.callParticipants.length > 0) {
                const activeChars = tempState.callParticipants.map(id => findGroupParticipantById(character, id)?.name).filter(Boolean);
                activeNames = activeChars.join('、');
            }
            callSystemPrompt += `\n5. **【最高红线：群聊参与者限制】**：当前是群语音通话，只有以下成员接听了电话并参与通话：【${activeNames}】。除了这些人，群里的其他任何成员都**绝对不可以发言**！你必须强制让未参与的成员保持沉默！`;
        }
        callSystemPrompt += `\n请严格遵守以上规则，开始你的通话。`;

        const systemMessage = {
            chatId: currentVoiceCallChatId,
            timestamp: new Date(),
            type: 'system',
            text: callSystemPrompt,
            aiVisible: true,
            uiVisible: false,
            callId: tempState.currentCallId
        };
        // ▲▲▲ 修改结束 ▲▲▲

        await db.chatMessages.add(systemMessage);
        
        const voiceCallList = document.getElementById('voice-call-message-list');
        if (voiceCallList) {
            voiceCallList.innerHTML = '';
        }
        // ▼▼▼ 【核心修改】切换单聊/群聊界面并渲染头像 ▼▼▼
        const singleInfoBox = document.getElementById('voice-call-single-info');
        const groupInfoBox = document.getElementById('voice-call-group-info');
        const voiceCallBg = document.getElementById('voice-call-bg');
        if (character.isGroup) {
            // 群聊模式
            if (voiceCallList) voiceCallList.classList.add('is-group-call'); // 【新增】为群聊贴上专属 CSS 标签
            if (singleInfoBox) singleInfoBox.style.display = 'none';

            if (groupInfoBox) groupInfoBox.style.display = 'flex';
            
            document.getElementById('voice-call-group-name').textContent = character.name;
            document.getElementById('voice-call-group-status').textContent = "正在等待大家加入...";
            voiceCallBg.style.backgroundImage = `url(${isValidAvatarSrc(character.avatar) ? character.avatar : DEFAULT_AVATAR_SRC})`;
            voiceCallMiniMeta = {
                avatar: isValidAvatarSrc(character.avatar) ? character.avatar : DEFAULT_AVATAR_SRC,
                name: character.name || '群语音通话',
            };

            // 渲染选中的成员头像网格
            const avatarsGrid = document.getElementById('group-call-avatars-grid');
            if (avatarsGrid) {
                avatarsGrid.innerHTML = '';
                const participants = tempState.callParticipants || getGroupParticipants(character).map(member => member.id);
                const activeMembers = participants.map(id => findGroupParticipantById(character, id)).filter(Boolean);
                
                // 最多显示9个人防UI爆炸
                activeMembers.slice(0, 9).forEach(m => {
                    const item = document.createElement('div');
                    item.className = 'group-call-avatar-item';
                    item.innerHTML = `<img src="${isValidAvatarSrc(m.avatar) ? m.avatar : DEFAULT_AVATAR_SRC}"><span class="name">${escapeHTML(m.name)}</span>`;
                    avatarsGrid.appendChild(item);
                });
            }
        } else {
            // 单聊模式
            if (voiceCallList) voiceCallList.classList.remove('is-group-call'); // 【新增】单聊拔掉标签，确保安全
            if (singleInfoBox) singleInfoBox.style.display = 'flex';

            if (groupInfoBox) groupInfoBox.style.display = 'none';

            const displayAvatar = isValidAvatarSrc(character.chatOverrideAvatar)
                ? character.chatOverrideAvatar
                : isValidAvatarSrc(character.avatar)
                    ? character.avatar
                    : DEFAULT_AVATAR_SRC;
            const displayName = character.chatOverrideName || character.name;
            voiceCallMiniMeta = { avatar: displayAvatar, name: displayName };
            document.getElementById('voice-call-avatar').src = displayAvatar;
            document.getElementById('voice-call-name').textContent = displayName;
            voiceCallBg.style.backgroundImage = `url(${displayAvatar})`;
            document.getElementById('voice-call-status').textContent = "正在等待对方接受邀请...";
        }
        // ▲▲▲ 修改结束 ▲▲▲

        showPage('page-voice-call');
        startCallTimer();
        startCallAmbient(character.id);
        if (callSettings.aiStarts && typeof submitVoiceCallMessage === 'function') {
            const aiStartCallContext = currentVoiceCallContext;
            setTimeout(() => {
                if (isActiveVoiceCallContext(aiStartCallContext)) {
                    submitVoiceCallMessage('', { callContext: aiStartCallContext });
                }
            }, 300);
        }
    };

    async function handleRejectedCall(character, isVideo = false) {
        const rejectedMessage = {
            chatId: character.id,
            timestamp: new Date(),
            type: 'received',
            contentType: 'voice_call_rejected',
            text: isVideo ? '已拒绝视频通话' : '已拒绝',
            isVideo,
            avatarSrc: character.avatar,
        };
        const messageId = await db.chatMessages.add(rejectedMessage);
        const newMessage = await db.chatMessages.get(messageId);
        if (newMessage) {
            await appendMessageToUI(newMessage);
        }
        showDynamicIsland('对方已拒接');
    }

    const startVoiceCall = async () => {
        const chatDetailPage = document.getElementById('page-chat-detail');
        const isChatPageVisible = chatDetailPage && chatDetailPage.style.display === 'flex';
        if (!isChatPageVisible || !tempState.currentChatId) return;
        const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
        if (!char) return;
        const rejectRate = getSleepCallRejectRate(char, char.callSettings?.rejectRate || 0.1);
        const shouldReject = Math.random() < rejectRate;
        if (shouldReject) {
            await handleRejectedCall(char);
            return;
        }
        await setupAndStartCallScreen(char);
    };

    const startUserVideoCall = async (character) => {
        if (!character) return;
        const rejectRate = getSleepCallRejectRate(character, character.callSettings?.rejectRate || 0.1);
        if (Math.random() < rejectRate) {
            await handleRejectedCall(character, true);
            return;
        }
        await launchVideoCall(character, 'user');
    };
    
 const hangUpVoiceCall = async () => {
        stopSpeechRecognition();
        clearInterval(callTimerInterval);
        // 【新增防错】：语音挂断时，强制清理可能残留的幽灵铃声
        if (window.stopIncomingCallSound) window.stopIncomingCallSound();
        hideCallMiniWidget();

        sessionStorage.removeItem('voice_call_crash_backup');
        if (callStartTimeout) clearTimeout(callStartTimeout);
        const finalCallId = tempState.currentCallId;
        const finalChatId = currentVoiceCallChatId || tempState.currentChatId;
        const returnChatId = tempState.currentChatId;
        const voiceCallPage = document.getElementById('page-voice-call');
        const wasOnVoiceCallPage = voiceCallPage && getComputedStyle(voiceCallPage).display !== 'none';
         const finalDuration = callSeconds;
         const callInitiator = tempState.callInitiator || 'user';

         if (finalChatId && isModeGenerating?.('online', finalChatId)) {
             cancelAiGeneration?.('online', finalChatId);
         }
         
         delete tempState.currentCallId;
        currentVoiceCallChatId = null;
        currentVoiceCallContext = null;
        delete tempState.callInitiator;
        delete tempState.activeCallChatId;
        delete tempState.activeCallMode;
        delete tempState.callReturnChatId;
        tempState.callWidgetMinimized = false;
        callSeconds = 0;
        setVoiceCallGeneratingState(false);
        hideTypingIndicator();

        if (finalCallId) {
            const systemMessage = {
                chatId: finalChatId,
                timestamp: new Date(),
                type: 'system',
                text: '（系统提示：语音通话已结束。）',
                aiVisible: true,
                uiVisible: false,
                callId: finalCallId
            };
            await db.chatMessages.add(systemMessage);
             if (finalDuration > 0) {
                const summaryMessageType = callInitiator === 'ai' ? 'received' : 'sent';
                // ▼▼▼ 【修复】在群聊挂断时，把到底是谁接的电话印在系统消息上 ▼▼▼
                let participantStr = '';
                const currentGrp = AppState.characterProfiles.find(c => c.id === finalChatId);
                if (currentGrp && currentGrp.isGroup && tempState.callParticipants) {
                    const names = tempState.callParticipants.map(id => findGroupParticipantById(currentGrp, id)?.name).filter(Boolean);
                    if (names.length > 0) participantStr = ` (参与成员: ${names.join('、')})`;
                }
                // ▲▲▲ 修复结束 ▲▲▲
                const summaryMessage = {
                    chatId: finalChatId,
                    timestamp: new Date(),
                    type: summaryMessageType,
                    contentType: 'voice_call_summary',
                    text: `通话时长 ${formatTime(finalDuration)}${participantStr}`,
                    duration: finalDuration,
                    callId: finalCallId,
                };
                await db.chatMessages.add(summaryMessage);

            }
        }
        stopCallAmbient();
        tempState.currentChatId = returnChatId || finalChatId;
        tempState.callWidgetMinimized = false;
        if (wasOnVoiceCallPage) {
            tempState.currentChatId = finalChatId;
            await loadAndRenderChatHistory(finalChatId);
            showPage(tempState.callReturnPageId || 'page-chat-detail');
        }
    };
    const callBtn = document.getElementById('call-btn');
    const callMenuOverlay = document.getElementById('call-menu-overlay');
    const videoCallBtn = document.getElementById('video-call-btn');
    const voiceCallBtn = document.getElementById('voice-call-btn');
    const cancelCallBtn = document.getElementById('cancel-call-btn');

    // ▼▼▼ 【新增】群聊通话选人逻辑 ▼▼▼
    const groupCallSelectOverlay = document.getElementById('group-call-select-overlay');
    const groupCallMemberList = document.getElementById('group-call-member-list');
    const startGroupCallBtn = document.getElementById('start-group-call-confirm-btn');
    const closeGroupCallSelectBtn = document.getElementById('close-group-call-select-btn');
    let pendingCallType = 'voice'; // 记录想发起的通话类型

    const showGroupCallSelectModal = (char, type) => {
        pendingCallType = type;
        groupCallMemberList.innerHTML = '';
        const members = getGroupParticipants(char);
        
        members.forEach(m => {
            const item = document.createElement('label');
            item.style.cssText = 'display:flex; align-items:center; padding:10px; border-radius:12px; border:1px solid #eee; cursor:pointer;';
            item.innerHTML = `
                <input type="checkbox" value="${m.id}" checked style="margin-right:12px; transform:scale(1.2);">
                <img src="${isValidAvatarSrc(m.avatar) ? m.avatar : DEFAULT_AVATAR_SRC}" style="width:36px; height:36px; border-radius:50%; object-fit:cover; margin-right:10px;">
                <span style="font-size:14px; color:#111; font-weight:500;">${escapeHTML(m.name)}</span>
            `;
            groupCallMemberList.appendChild(item);
        });

        groupCallSelectOverlay.style.display = 'flex';
        setTimeout(() => groupCallSelectOverlay.style.opacity = '1', 10);
    };

    if (closeGroupCallSelectBtn) {
        const closeSelectModal = () => {
            groupCallSelectOverlay.style.opacity = '0';
            setTimeout(() => groupCallSelectOverlay.style.display = 'none', 300);
        };
        closeGroupCallSelectBtn.onclick = closeSelectModal;
        groupCallSelectOverlay.onclick = (e) => { if(e.target === groupCallSelectOverlay) closeSelectModal(); };
    }

    if (startGroupCallBtn) {
        startGroupCallBtn.onclick = () => {
            const checkboxes = groupCallMemberList.querySelectorAll('input[type="checkbox"]:checked');
            const selectedIds = Array.from(checkboxes).map(cb => cb.value);
            
            if (selectedIds.length === 0) {
                showDynamicIsland('请至少选择一位成员参与通话', 'warning');
                return;
            }
            // 保存选中的人到全局状态
            tempState.callParticipants = selectedIds;
            
            groupCallSelectOverlay.style.opacity = '0';
            setTimeout(() => {
                groupCallSelectOverlay.style.display = 'none';
                if (pendingCallType === 'voice') startVoiceCall();
                else startUserVideoCall(AppState.characterProfiles.find(c => c.id === tempState.currentChatId));
            }, 300);
        };
    }
    // ▲▲▲ 新增结束 ▲▲▲

    if (callBtn && callMenuOverlay) {
        const showCallMenu = () => {
            document.getElementById('chat-function-panel').classList.add('hidden');
            document.getElementById('sticker-picker-panel').classList.add('hidden');
            callMenuOverlay.classList.add('visible');
        };
        const hideCallMenu = () => {
            callMenuOverlay.classList.remove('visible');
        };
        callBtn.addEventListener('click', (e) => { e.stopPropagation(); showCallMenu(); });
        callMenuOverlay.addEventListener('click', (e) => { if (e.target === callMenuOverlay) hideCallMenu(); });
        cancelCallBtn.addEventListener('click', hideCallMenu);
        
        // ▼▼▼ 修改：点击时判断是否为群聊 ▼▼▼
        videoCallBtn.addEventListener('click', () => {
            hideCallMenu();
            const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            if (char && char.isGroup) showGroupCallSelectModal(char, 'video');
            else startUserVideoCall(char); 
        });
        voiceCallBtn.addEventListener('click', () => {
            hideCallMenu();
            const char = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
            if (char && char.isGroup) showGroupCallSelectModal(char, 'voice');
            else startVoiceCall();
        });
        // ▲▲▲ 修改结束 ▲▲▲
    }

    const voiceCallPage = document.getElementById('page-voice-call');
    if (voiceCallPage) {
        const hangUpBtn = document.getElementById('hang-up-btn');
        toggleMicBtn = document.getElementById('toggle-mic-btn');
        const toggleSpeakerBtn = document.getElementById('toggle-speaker-btn');
        voiceCallTextarea = document.getElementById('voice-call-textarea');
        voiceCallTranscriptPreview = document.getElementById('voice-call-transcript-preview');
        const voiceCallSendBtn = document.getElementById('voice-call-send-btn');
        const voiceCallHeaderBtns = document.querySelectorAll('.voice-call-header .call-header-btn');
        const minimizeVoiceCallBtn = voiceCallHeaderBtns[0];
        const quickSettingsBtn = document.getElementById('voice-call-quick-settings-btn');
        
        hangUpBtn.addEventListener('click', hangUpVoiceCall); 
         toggleMicBtn.addEventListener('click', async () => {
             if (isApiVoiceRecognitionEnabled()) {
                 if (apiVoiceCaptureStopping) return;
                 if (isApiVoiceCaptureActive()) await stopApiVoiceRecognition();
                else await startApiVoiceRecognition();
                return;
            }
            if (speechRecognitionRequested) stopSpeechRecognition();
            else startSpeechRecognition();
        });
        toggleSpeakerBtn.addEventListener('click', () => { /* ... */ });
        quickSettingsBtn?.addEventListener('click', () => requestCallQuickSettings(currentVoiceCallChatId || tempState.activeCallChatId, 'voice'));
        const syncVoiceDraftToPage = (value) => {
            if (!voiceCallTextarea) return;
            voiceCallTextarea.value = value;
        };

        submitVoiceCallMessage = async (rawText = '', options = {}) => {
            const callContext = options.callContext || currentVoiceCallContext;
            const callChatId = callContext?.chatId || currentVoiceCallChatId || tempState.currentChatId;
            const callId = callContext?.callId || tempState.currentCallId;
            const messageText = String(rawText || '').trim();
            if (!callId
                || !callChatId
                || tempState.activeCallMode !== 'voice'
                || String(tempState.currentCallId) !== String(callId)
                || String(tempState.activeCallChatId) !== String(callChatId)) return false;
            if (isModeGenerating && isModeGenerating('online', callChatId)) {
                cancelAiGeneration?.('online', callChatId);
                hideTypingIndicator();
                setVoiceCallGeneratingState(false);
                if (!options.fromSpeech) {
                    showDynamicIsland('已打断生成');
                    return false;
                }
            }
            if (!messageText) {
                const currentUser = getCurrentChatIdentity(callChatId);
                await db.chatMessages.add({
                    chatId: callChatId,
                    timestamp: new Date(),
                    text: '<[系统隐式提示：请在当前语音电话中自然续写一句或几句，不要重复上一句话。]>',
                    type: 'sent',
                    avatarSrc: currentUser.avatar,
                 callIdentityId: currentUser.id,
                 uiVisible: false,
                 aiVisible: true,
                 recalled: false,
                 callId
             });
                if (!isActiveVoiceCallContext(callContext)) return false;
                 showTypingIndicator();
                setVoiceCallGeneratingState(true);
                try {
                    await triggerAiResponse(null, callChatId);
                } finally {
                    setVoiceCallGeneratingState(false);
                }
                return true;
            }
            const currentUser = getCurrentChatIdentity(callChatId);
            const messageToSave = {
                chatId: callChatId,
                timestamp: new Date(),
                text: messageText,
                type: 'sent',
                contentType: 'voice', 
                avatarSrc: currentUser.avatar,
                callIdentityId: currentUser.id,
                recalled: false,
                replyToMessageId: null,
                callId,
                ...(options.speechContext ? { speechContext: String(options.speechContext).trim().slice(0, 240) } : {})
            };
            const messageId = await db.chatMessages.add(messageToSave);
            const newMessage = await db.chatMessages.get(messageId);
            
             await appendMessageToUI(newMessage); 

             if (!isActiveVoiceCallContext(callContext)) return false;
 
             showTypingIndicator();
            setVoiceCallGeneratingState(true);
            try {
               await triggerAiResponse(messageText, callChatId); 
            } finally {
                setVoiceCallGeneratingState(false);
            }
            return true;
        };

        setSpeechRecognitionUi(false);

        const createWidgetCallActions = () => {
            const widgetCallContext = currentVoiceCallContext || Object.freeze({
                callId: tempState.currentCallId,
                chatId: currentVoiceCallChatId,
            });
            return {
                onRegenerate: typeof regenerateLastResponse === 'function'
                    ? async () => {
                        setVoiceCallGeneratingState(true);
                        try {
                            return await regenerateLastResponse(null, widgetCallContext);
                        } finally {
                            setVoiceCallGeneratingState(false);
                        }
                    }
                    : null,
                onDelete: typeof deleteLastCallResponse === 'function'
                    ? () => deleteLastCallResponse(widgetCallContext)
                    : null,
            };
        };

        if (minimizeVoiceCallBtn) {
            minimizeVoiceCallBtn.addEventListener('click', () => {
                if (!tempState.currentCallId) return;
                tempState.callWidgetMinimized = true;
                tempState.currentChatId = tempState.callReturnChatId || currentVoiceCallChatId || tempState.currentChatId;
                const widgetCallActions = createWidgetCallActions();
                syncVoiceCallMiniWidget(voiceCallMiniMeta.avatar, voiceCallMiniMeta.name, restoreVoiceCallScreen, hangUpVoiceCall, {
                    expanded: false,
                    inputValue: voiceCallTextarea?.value || '',
                    onSendText: submitVoiceCallMessage,
                    onDraftChange: syncVoiceDraftToPage,
                    onRegenerate: widgetCallActions.onRegenerate,
                    onDelete: widgetCallActions.onDelete,
                });
                showPage(tempState.callReturnPageId || 'page-chat-detail');
            });
        }
        const sendVoiceCallMessage = async () => {
            const draftText = voiceCallTextarea.value;
            if (!draftText.trim()) return;
            voiceCallTextarea.value = '';
            syncVoiceDraftToPage('');
            voiceCallTextarea.style.height = 'auto';
            try {
                const sent = await submitVoiceCallMessage(draftText);
                if (sent === false) {
                    voiceCallTextarea.value = draftText;
                    syncVoiceDraftToPage(draftText);
                }
            } catch (error) {
                voiceCallTextarea.value = draftText;
                syncVoiceDraftToPage(draftText);
                console.error('[Voice Call] 发送消息失败：', error);
            }
        };

        if (voiceCallSendBtn) {
            voiceCallSendBtn.addEventListener('click', sendVoiceCallMessage);
        }
        if (voiceCallTextarea) {
            voiceCallTextarea.addEventListener('input', () => { /* ... */ });
            voiceCallTextarea.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    sendVoiceCallMessage();
                }
            });
        }
    }

    const incomingCallOverlay = document.getElementById('incoming-call-overlay');
    if (incomingCallOverlay) {
        const acceptCallBtn = document.getElementById('accept-call-btn');
        const rejectCallBtn = document.getElementById('reject-call-btn');

        // ▼▼▼ 【核心修改】使用 main.js 中定义的全局函数停止铃声 ▼▼▼
        const stopRinging = () => {
            if (window.stopIncomingCallSound) {
                window.stopIncomingCallSound();
            } else {
                console.error("全局铃声停止函数 'stopIncomingCallSound' 未找到!");
            }
            const rAudio = document.getElementById('ringtone-audio');
            if (rAudio) { rAudio.pause(); rAudio.currentTime = 0; }

            incomingCallOverlay.classList.remove('visible');
        };
        // ▲▲▲ 修改结束 ▲▲▲

        acceptCallBtn.addEventListener('click', async () => {
            stopRinging();
            const targetChatId = pendingAiVoiceCallChatId || tempState.currentChatId;
            pendingAiVoiceCallChatId = null;
            const char = AppState.characterProfiles.find(c => isSameCharacterId(c.id, targetChatId));
            if (char) {
                tempState.currentChatId = char.id;
                tempState.callInitiator = 'ai';
                await setupAndStartCallScreen(char);
            }
        });

        rejectCallBtn.addEventListener('click', async () => {
            stopRinging();
            const targetChatId = pendingAiVoiceCallChatId || tempState.currentChatId;
            pendingAiVoiceCallChatId = null;
            const char = AppState.characterProfiles.find(c => isSameCharacterId(c.id, targetChatId));
            if (!char) return;
            const rejectedMessage = {
                chatId: targetChatId,
                timestamp: new Date(),
                type: 'sent',
                contentType: 'voice_call_rejected', 
                text: '已拒绝',
                avatarSrc: getCurrentChatIdentity(targetChatId).avatar,
            };
            const msgId = await db.chatMessages.add(rejectedMessage);
            await appendMessageToUI(await db.chatMessages.get(msgId));
        });
    }
    // ▼▼▼ 【新增】绑定群聊横幅来电的接听/拒绝事件 ▼▼▼
    const groupCallBanner = document.getElementById('incoming-group-call-banner');
    if (groupCallBanner) {
        const acceptGroupBtn = document.getElementById('accept-group-call-btn');
        const rejectGroupBtn = document.getElementById('reject-group-call-btn');

        const closeGroupBanner = () => {
            if (window.stopIncomingCallSound) window.stopIncomingCallSound();
            const rAudio = document.getElementById('ringtone-audio');
            if (rAudio) { rAudio.pause(); rAudio.currentTime = 0; }

            groupCallBanner.classList.remove('show');
        };
        acceptGroupBtn.addEventListener('click', async () => {
            closeGroupBanner();
            const targetChatId = pendingAiGroupCallChatId || tempState.currentChatId;
            pendingAiGroupCallChatId = null;
            const char = AppState.characterProfiles.find(c => isSameCharacterId(c.id, targetChatId));
            if (char) {
                tempState.currentChatId = char.id;
                tempState.callInitiator = 'ai';
                // ▼▼▼ 【修改】读取系统刚刚解析好的AI邀请名单 ▼▼▼
                if (tempState.aiCallPendingParticipants) {
                    tempState.callParticipants = [...tempState.aiCallPendingParticipants];
                    delete tempState.aiCallPendingParticipants; // 用完立刻清理
                    delete tempState.aiCallInitiatorId;
                } else {
                    tempState.callParticipants = getGroupParticipants(char).map(member => member.id);
                }
                // ▲▲▲ 修改结束 ▲▲▲
                await setupAndStartCallScreen(char);
            }
        });

        rejectGroupBtn.addEventListener('click', async () => {
            closeGroupBanner();
            const targetChatId = pendingAiGroupCallChatId || tempState.currentChatId;
            pendingAiGroupCallChatId = null;
            const char = AppState.characterProfiles.find(c => isSameCharacterId(c.id, targetChatId));
            if (!char) return;
            const msgId = await db.chatMessages.add({
                chatId: targetChatId,
                timestamp: new Date(),
                type: 'sent',
                contentType: 'voice_call_rejected',
                text: '已拒绝群通话',
                avatarSrc: getCurrentChatIdentity(targetChatId).avatar,
            });
            await appendMessageToUI(await db.chatMessages.get(msgId));
        });
    }
    // ▲▲▲ 新增结束 ▲▲▲

    if (callHistoryModalOverlay && closeCallHistoryBtn) {
        const closeModal = () => callHistoryModalOverlay.classList.remove('visible');
     const newCloseBtn = closeCallHistoryBtn.cloneNode(true);
        closeCallHistoryBtn.parentNode.replaceChild(newCloseBtn, closeCallHistoryBtn);
        
        newCloseBtn.addEventListener('click', closeModal);
        callHistoryModalOverlay.addEventListener('click', (e) => {
            if (e.target === callHistoryModalOverlay) {
                closeModal();
            }
        });
    }
}
/**
 * 【新增】显示视频通话记录弹窗
 */
export async function showVideoHistoryModal(callId) {
    if (!callHistoryModalOverlay) return;
    
    const callMessages = await db.chatMessages.where('callId').equals(callId).sortBy('timestamp');
    const visibleMessages = callMessages.filter(m =>
        m.contentType !== 'voice_call_summary' && m.type !== 'system'
    );
    const character = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
    
    callHistoryModalCard.classList.add('video-history-mode');
    
    // ▼▼▼ 【核心修改】显示覆写信息 ▼▼▼
    if (character) {
        const displayAvatar = character.chatOverrideAvatar || character.avatar || DEFAULT_AVATAR_SRC;
        const displayName = character.chatOverrideName || character.name;

        // 设置背景图
        callHistoryModalCard.style.backgroundImage = `linear-gradient(rgba(0,0,0,0.6), rgba(0,0,0,0.6)), url('${displayAvatar}')`;
        callHistoryModalCard.style.backgroundSize = 'cover';
        callHistoryModalCard.style.backgroundPosition = 'center';

        // 设置头部信息
        callHistoryCharAvatar.src = displayAvatar;
        callHistoryCharName.textContent = displayName;
        callHistoryCharName.style.color = '#fff'; 
    }
    // ▲▲▲ 修改结束 ▲▲▲

    callHistoryMessageList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    
    visibleMessages.forEach(msg => {
        const msgElement = createSimplifiedMessageElementForCall({ ...msg, isVideoHistory: true, uiVisible: true });
        if (msgElement) {
            msgElement.classList.add('video-history-item');
            fragment.appendChild(msgElement);
        }
    });
    callHistoryMessageList.appendChild(fragment);
    
    callHistoryModalOverlay.classList.add('visible');
    
    const cleanup = () => {
        callHistoryModalCard.classList.remove('video-history-mode');
        callHistoryModalCard.style.backgroundImage = ''; 
        callHistoryCharName.style.color = ''; 
    };
    
    const closeBtn = document.getElementById('close-call-history-btn');
    const oldClone = closeBtn.cloneNode(true); 
    closeBtn.parentNode.replaceChild(oldClone, closeBtn); 
    oldClone.addEventListener('click', () => {
        callHistoryModalOverlay.classList.remove('visible');
        cleanup();
    });
}
/**
 * 【新增】由 AI 主动发起视频通话，显示来电界面
 */
export async function initiateAiVideoCall(chatId = null) {
    const targetChatId = chatId || tempState.currentChatId;
    const chatDetailPage = document.getElementById('page-chat-detail');
    if (!chatDetailPage || chatDetailPage.style.display !== 'flex' || tempState.currentCallId || tempState.currentVideoCallId) {
        return;
    }

    const char = AppState.characterProfiles.find(c => isSameCharacterId(c.id, targetChatId));
    if (!char) return;

    const overlay = document.getElementById('incoming-video-call-overlay');
    const avatar = document.getElementById('incoming-video-call-avatar');
    const name = document.getElementById('incoming-video-call-name');
    const bg = document.getElementById('incoming-video-call-bg');

    if (overlay && avatar && name && bg) {
        // ▼▼▼ 【核心修改】显示覆写信息 ▼▼▼
        const displayAvatar = char.chatOverrideAvatar || char.avatar || DEFAULT_AVATAR_SRC;
        const displayName = char.chatOverrideName || char.name;

        pendingAiVideoCallChatId = targetChatId;
        avatar.src = displayAvatar;
        name.textContent = displayName;
        bg.style.backgroundImage = `url(${displayAvatar})`;
        // ▲▲▲ 修改结束 ▲▲▲
        
        overlay.classList.add('visible');
        
        if (window.playIncomingCallSound) {
            window.playIncomingCallSound();
        }
    }
}

// 初始化视频来电的按钮事件 (在 initCallFunctionality 内部调用)
function initVideoIncomingEvents() {
    const overlay = document.getElementById('incoming-video-call-overlay');
    if (!overlay) return;

    const acceptBtn = document.getElementById('accept-video-call-btn');
    const rejectBtn = document.getElementById('reject-video-call-btn');

    const stopRinging = () => {
        if (window.stopIncomingCallSound) window.stopIncomingCallSound();
        const rAudio = document.getElementById('ringtone-audio');
        if (rAudio) { rAudio.pause(); rAudio.currentTime = 0; }
        overlay.classList.remove('visible');
    };
     // 接听按钮
    acceptBtn.onclick = () => {
        stopRinging();
        const targetChatId = pendingAiVideoCallChatId || tempState.currentChatId;
        pendingAiVideoCallChatId = null;
        const char = AppState.characterProfiles.find(c => isSameCharacterId(c.id, targetChatId));
        if (char) {
            tempState.currentChatId = char.id;
            // ▼▼▼ 【修改】读取系统刚刚解析好的AI邀请名单 ▼▼▼
            if (tempState.aiCallPendingParticipants) {
                tempState.callParticipants = [...tempState.aiCallPendingParticipants];
                delete tempState.aiCallPendingParticipants; // 用完立刻清理
                delete tempState.aiCallInitiatorId;
            } else {
                tempState.callParticipants = getGroupParticipants(char).map(member => member.id);
            }
            // ▲▲▲ 修改结束 ▲▲▲
            // 调用 video-call.js 的启动函数，并标记为 'ai' 发起
            launchVideoCall(char, 'ai');
        }
    };

    // 拒绝按钮
    rejectBtn.onclick = async () => {
        stopRinging();
        const targetChatId = pendingAiVideoCallChatId || tempState.currentChatId;
        pendingAiVideoCallChatId = null;
        const char = AppState.characterProfiles.find(c => isSameCharacterId(c.id, targetChatId));
        if (!char) return;
        // 写入一条拒绝消息
        const rejectedMessage = {
            chatId: targetChatId,
            timestamp: new Date(),
            type: 'sent',
            contentType: 'voice_call_rejected', // 视频拒绝也可以复用这个类型显示
            text: '已拒绝视频邀请',
            isVideo: true,
            avatarSrc: getCurrentChatIdentity(targetChatId).avatar,
        };
        const msgId = await db.chatMessages.add(rejectedMessage);
        const msg = await db.chatMessages.get(msgId);
        if(window.createAndAppendMessage) window.createAndAppendMessage(msg);
    };
}
