const videoCallContainer = document.getElementById('video-call-container');
const remoteVideoAvatar = document.getElementById('remote-video-avatar');
const localVideoAvatar = document.getElementById('local-video-avatar');
const remoteVideoUsername = document.getElementById('remote-video-username');
const videoCallStatus = document.getElementById('video-call-status');
const videoCallTimer = document.getElementById('video-call-timer');
const videoCallInput = document.getElementById('video-call-input');
const videoCallSendBtn = document.getElementById('video-call-send-btn');
const videoHangUpBtn = document.getElementById('video-hang-up-btn');
const videoToggleMicBtn = document.getElementById('video-mute-btn');
const videoCallTranscriptPreview = document.getElementById('video-call-transcript-preview');
const videoCallMessageList = document.getElementById('video-call-message-list');
const localVideoPreview = document.getElementById('local-video-preview');
const videoSwitchCameraBtn = document.getElementById('video-switch-camera-btn');
const localView = document.querySelector('.local-view'); // 自己的小窗
const phoneScreen = document.querySelector('.phone-screen'); // 手机屏幕作为拖拽容器
// 2. 导入依赖
import { showPage, showDynamicIsland } from '../ui.js';
import { AppState, tempState, db, DEFAULT_AVATAR_SRC } from '../state.js'; 
import { formatTime, escapeHTML } from '../utils.js';
import { sendVideoCallMessageToAI, cancelAiGeneration, isModeGenerating } from './chat-service.js';
import { createAndAppendMessage, getCurrentChatIdentity, loadAndRenderChatHistory } from './chat-ui.js'; // <-- 引入 getCurrentChatIdentity
import { hideCallMiniWidget } from './call-widget.js';
import { TTSService } from './tts-service.js';
import { getCallSettings, requestCallQuickSettings, startCallAmbient, stopCallAmbient } from './call-audio.js';
import { isApiVoiceRecognitionEnabled, isApiVoiceCaptureActive, startApiVoiceCapture, stopApiVoiceCapture, cancelApiVoiceCapture } from './speech-service.js';
import { markSleepAwakenedByCall } from './sleep-system.js';

const isSameCharacterId = (left, right) => left != null && right != null && String(left) === String(right);
const hasCharacterId = (ids, id) => (ids || []).some(item => isSameCharacterId(item, id));
function getGroupParticipants(group) {
    const members = (group?.memberIds || []).map(id => AppState.characterProfiles.find(char => isSameCharacterId(char.id, id))).filter(Boolean);
    const memberNames = new Set(members.map(member => member.name));
    const npcs = (Array.isArray(group?.groupNpcMembers) ? group.groupNpcMembers : [])
        .map((npc, index) => ({ ...npc, id: String(npc?.id || `group-npc:${npc?.ownerId}:${index}`), isGroupNpc: true }))
        .filter(npc => npc.ownerId && hasCharacterId(group.memberIds, npc.ownerId) && npc.name && !memberNames.has(npc.name));
    return [...members, ...npcs];
}
function findGroupParticipantById(group, id) {
    return getGroupParticipants(group).find(member => isSameCharacterId(member.id, id));
}
// 3. 模块内部变量
let videoCallTimerInterval = null;
let videoCallSeconds = 0;
let currentVideoCallChatId = null;
let videoApiVoiceCallContext = null;
let videoApiVoiceCaptureStopping = false;
let videoCameraStream = null;
let videoCameraFacingMode = 'user';
let videoCameraRequestId = 0;
let videoMessageScrollFrame = 0;
let videoCallMiniMeta = {
    avatar: DEFAULT_AVATAR_SRC,
    name: '视频通话',
};

function getActiveVideoCallContext() {
    const callId = tempState.currentVideoCallId;
    const chatId = currentVideoCallChatId || tempState.activeCallChatId || tempState.currentChatId;
    if (!callId || !chatId || tempState.activeCallMode !== 'video') return null;
    return { callId, chatId };
}

function isActiveVideoCallContext(callContext) {
    return Boolean(
        callContext?.callId
        && callContext?.chatId
        && tempState.activeCallMode === 'video'
        && String(tempState.currentVideoCallId) === String(callContext.callId)
        && String(tempState.activeCallChatId) === String(callContext.chatId)
    );
}

function setVideoTranscriptPreview(text = '') {
    if (!videoCallTranscriptPreview) return;
    const value = String(text || '').trim();
    videoCallTranscriptPreview.textContent = value;
    videoCallTranscriptPreview.hidden = !value;
}

function scheduleVideoMessageScroll() {
    if (!videoCallMessageList || videoMessageScrollFrame) return;
    videoMessageScrollFrame = requestAnimationFrame(() => {
        videoMessageScrollFrame = 0;
        if (videoCallMessageList) videoCallMessageList.scrollTop = videoCallMessageList.scrollHeight;
    });
}

function setVideoSpeechRecognitionUi(isActive) {
    if (!videoToggleMicBtn) return;
    videoToggleMicBtn.classList.toggle('is-listening', Boolean(isActive));
    videoToggleMicBtn.setAttribute('aria-pressed', String(Boolean(isActive)));
    videoToggleMicBtn.title = isActive ? '停止语音识别' : '开始语音识别';
    videoToggleMicBtn.setAttribute('aria-label', videoToggleMicBtn.title);
}

function notifyVideoCameraState(enabled, chatId = currentVideoCallChatId || tempState.activeCallChatId) {
    document.dispatchEvent(new CustomEvent('video-call-camera-state', {
        detail: { enabled: Boolean(enabled), chatId }
    }));
}

function stopVideoCamera({ notify = true } = {}) {
    videoCameraRequestId += 1;
    if (videoCameraStream) {
        videoCameraStream.getTracks().forEach(track => track.stop());
        videoCameraStream = null;
    }
    if (localVideoPreview) {
        localVideoPreview.srcObject = null;
        localVideoPreview.hidden = true;
    }
    if (localVideoAvatar) localVideoAvatar.hidden = false;
    const currentCall = AppState.characterProfiles.find(char => String(char.id) === String(currentVideoCallChatId));
    if (currentCall?.isGroup && localView) localView.style.display = 'none';
    if (notify) notifyVideoCameraState(false);
}

async function startVideoCamera(facingMode = videoCameraFacingMode, { preserveCurrent = false } = {}) {
    const callContext = getActiveVideoCallContext();
    if (!callContext || !navigator.mediaDevices?.getUserMedia) {
        showDynamicIsland('当前浏览器不支持摄像头');
        notifyVideoCameraState(Boolean(videoCameraStream), callContext?.chatId);
        return false;
    }
    const requestId = ++videoCameraRequestId;
    let nextStream = null;
    try {
        nextStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                facingMode: { ideal: facingMode },
                width: { ideal: 640 },
                height: { ideal: 480 }
            }
        });
        if (requestId !== videoCameraRequestId || !isActiveVideoCallContext(callContext)) {
            nextStream.getTracks().forEach(track => track.stop());
            return false;
        }
        const previousStream = videoCameraStream;
        videoCameraStream = nextStream;
        videoCameraFacingMode = facingMode;
        if (localVideoPreview) {
            localVideoPreview.srcObject = nextStream;
            localVideoPreview.hidden = false;
            await localVideoPreview.play().catch(() => {});
        }
        if (localVideoAvatar) localVideoAvatar.hidden = true;
        const currentCall = AppState.characterProfiles.find(char => String(char.id) === String(callContext.chatId));
        if (currentCall?.isGroup && localView) localView.style.display = 'block';
        if (previousStream && previousStream !== nextStream) previousStream.getTracks().forEach(track => track.stop());
        notifyVideoCameraState(true, callContext.chatId);
        return true;
    } catch (error) {
        if (nextStream) nextStream.getTracks().forEach(track => track.stop());
        const keepCurrentCamera = preserveCurrent && Boolean(videoCameraStream);
        if (!keepCurrentCamera) stopVideoCamera({ notify: false });
        if (isActiveVideoCallContext(callContext)) {
            showDynamicIsland(error?.name === 'NotAllowedError' ? '摄像头权限被拒绝' : '无法开启摄像头');
            notifyVideoCameraState(keepCurrentCamera, callContext.chatId);
        }
        return false;
    }
}

async function switchVideoCamera() {
    if (!videoCameraStream) {
        showDynamicIsland('请先在通话设置中开启摄像头');
        return;
    }
    const nextFacingMode = videoCameraFacingMode === 'user' ? 'environment' : 'user';
    const activeTrack = videoCameraStream.getVideoTracks()[0];
    if (activeTrack?.applyConstraints) {
        try {
            await activeTrack.applyConstraints({ facingMode: { exact: nextFacingMode } });
            videoCameraFacingMode = nextFacingMode;
            return;
        } catch (error) {
            console.warn('[Video Call] 当前摄像头不支持直接翻转，尝试重新打开镜头：', error);
        }
    }
    await startVideoCamera(nextFacingMode, { preserveCurrent: true });
}

function captureVideoFrameForAI() {
    if (!videoCameraStream || !localVideoPreview || localVideoPreview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return '';
    const width = Math.min(localVideoPreview.videoWidth || 640, 640);
    const height = Math.min(localVideoPreview.videoHeight || 480, 480);
    if (!width || !height) return '';
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return '';
    context.drawImage(localVideoPreview, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.68);
}

function handleVideoCameraToggle(event) {
    const detail = event.detail || {};
    const callContext = getActiveVideoCallContext();
    if (!callContext || String(detail.chatId) !== String(callContext.chatId)) return;
    if (detail.enabled) startVideoCamera();
    else stopVideoCamera();
}

function handleVideoCameraStateRequest(event) {
    const callContext = getActiveVideoCallContext();
    const requestedChatId = event.detail?.chatId;
    if (!callContext || String(requestedChatId) !== String(callContext.chatId)) return;
    notifyVideoCameraState(Boolean(videoCameraStream), callContext.chatId);
}
// =========================================================================
// === 核心功能函数 ===
// =========================================================================
/**
 * 【修复】显示视频通话中的“对方正在输入”动画
 */
function showVideoTyping() {
    if (document.getElementById('video-typing')) return;
    const indicator = document.createElement('div');
    indicator.id = 'video-typing';
    indicator.className = 'message-wrapper received';
    indicator.innerHTML = `
        <div class="message-bubble typing-indicator">
            <span></span><span></span><span></span>
        </div>`;
    if (videoCallMessageList) {
        videoCallMessageList.appendChild(indicator);
        scheduleVideoMessageScroll();
    }
}
/**
 * 隐藏“对方正在输入”动画
 */
function hideVideoTyping() {
    const indicator = document.getElementById('video-typing');
    if (indicator) indicator.remove();
}
/**
 * 【修复】为视频通话界面创建一个消息元素 (支持对话分段高亮 + 英文引号 + 智能比喻过滤)
 */
function createVideoCallMessageElement(messageData) {
    if (messageData.contentType === 'voice_call_summary') {
        console.warn('[Video Call Guard] 已拦截一条通话总结消息，防止其在通话中显示。');
        return null;
    }
    const messageWrapper = document.createElement('div');
    messageWrapper.className = `message-wrapper video-call-message ${messageData.type}`;
    const contentContainer = document.createElement('div');
    contentContainer.className = 'video-msg-container';
    const translationText = typeof messageData.translation === 'string' ? messageData.translation.trim() : '';

   let text = (messageData.text || '') 
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
        .replace(/\[MSG ID: \d+\]\s*/g, '');
    const dialoguePattern = /((?:“(?=[^”]*[，。？！…～,.?!~]|[^”]{5,})[^”]*”)|(?:"(?=[^"]*[，。？！…～,.?!~]|[^"]{5,})[^"]*"))/g;
    const parts = text.split(dialoguePattern).filter(p => p.trim() !== '');

    let lastBubble = null;
    parts.forEach(part => {
        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';

        // 【修改】检测当前片段是否为引号包裹的台词 (支持中英文)
        if (/^(?:“[^”]*”|"[^"]*")$/.test(part)) {
            bubble.classList.add('spoken-content');
            // 去除首尾引号再显示
            const innerText = part.slice(1, -1);
            bubble.innerHTML = `<p>${escapeHTML(innerText)}</p>`;
        } else {
            let processed = escapeHTML(part)
                .replace(/\*{2}([\s\S]+?)\*{2}/g, '<span class="italic">$1</span>')
                .replace(/\*([^\*]+?)\*/g, '<span class="italic">$1</span>');
            bubble.innerHTML = `<p>${processed}</p>`;
            }
        contentContainer.appendChild(bubble);
        lastBubble = bubble;
    });
    if (translationText && messageData.type === 'received') {
        const translationEl = document.createElement('div');
        translationEl.className = 'video-call-translation';
        translationEl.innerHTML = escapeHTML(translationText).replace(/\n/g, '<br>');
        const targetBubble = lastBubble || document.createElement('div');
        if (!lastBubble) {
            targetBubble.className = 'message-bubble';
            contentContainer.appendChild(targetBubble);
        }
        targetBubble.appendChild(translationEl);
    }
    // ▼▼▼ 新增：如果是群聊，且为特定角色发言，才在气泡容器的右下角添加小头像 ▼▼▼
    const callChatId = messageData.chatId || currentVideoCallChatId || tempState.activeCallChatId || tempState.currentChatId;
    const currentCallChar = AppState.characterProfiles.find(c => c.id === callChatId);
    if (currentCallChar && currentCallChar.isGroup && messageData.type === 'received' && messageData.avatarSrc && messageData.speakerName) {
        const avatarImg = document.createElement('img');
        avatarImg.src = messageData.avatarSrc;

        avatarImg.style.cssText = `
            width: 26px;
            height: 26px;
            border-radius: 50%;
            object-fit: cover;
            position: absolute;
            bottom: -10px;
            right: -10px;
            border: 2px solid #222;
            box-shadow: 0 2px 5px rgba(0,0,0,0.6);
            z-index: 10;
        `;
        contentContainer.style.position = 'relative';
        contentContainer.appendChild(avatarImg);
    }
    // ▲▲▲ 新增结束 ▲▲▲


    messageWrapper.appendChild(contentContainer);
    return messageWrapper;
}

/**
 * 将消息添加到视频通话的UI上
 * 【修改】增加了 id 参数，并且返回创建的元素对象
 */
function appendMessageToVideoUI(messageData, id = null) {
    if (!videoCallMessageList) return null;
    const messageElement = createVideoCallMessageElement(messageData);
    if (!messageElement) return null;
    
    // 如果传入了 id，就绑定到标签上
    if (id) {
        messageElement.dataset.messageId = id;
    }
    if (messageData.responseGroupId) {
        messageElement.dataset.responseGroupId = messageData.responseGroupId;
    }
    
    videoCallMessageList.appendChild(messageElement);
    scheduleVideoMessageScroll();
    
    // 返回这个元素，方便后面绑定长按事件
    return messageElement;
}

/**
 * 保存视频通话消息到数据库
 * 【修改】增加了 return id，以便后续绑定事件使用
 */
async function saveVideoMessage(text, type, speakerName = null, avatarSrc = null, speakerId = null, ttsEmotion = null, translation = null, responseGroupId = null, callContext = null, speechContext = '') {
    const chatId = callContext?.chatId || currentVideoCallChatId || tempState.currentChatId;
    const callId = callContext?.callId || tempState.currentVideoCallId;
    if (!callId || !chatId) return null;
    const currentUser = getCurrentChatIdentity(chatId);
    const character = AppState.characterProfiles.find(c => c.id === chatId);
    const msg = {
        chatId,
        callId,
        timestamp: new Date(),
        text: text,
        type: type,
        speakerName: speakerName,
        speakerId: speakerId,
        ttsEmotion: ttsEmotion,
        translation: translation,
        responseGroupId: responseGroupId,
        avatarSrc: avatarSrc || (type === 'sent' ? currentUser.avatar : character.avatar),
        recalled: false,
        aiVisible: true,
        uiVisible: false 
    };
    const normalizedSpeechContext = String(speechContext || '').trim().slice(0, 240);
    if (normalizedSpeechContext) {
        msg.contentType = 'voice';
        msg.speechContext = normalizedSpeechContext;
    }
    // 这里修改了：接收返回的 id 并返回
    const id = await db.chatMessages.add(msg);
    return id;
}
/**
 * 发送视频通话消息
 * 【修改】绑定了长按菜单事件
 */
async function submitVideoCallMessage(rawText = '', options = {}) {
    const callContext = options.callContext || getActiveVideoCallContext();
    const chatId = callContext?.chatId;
    const callId = callContext?.callId;
    const text = String(rawText || '').trim();
    if (!isActiveVideoCallContext(callContext)) return false;
    if (isModeGenerating && isModeGenerating('online', chatId)) {
        cancelAiGeneration?.('online', chatId);
        hideVideoTyping();
        if (!options.fromSpeech) {
            showDynamicIsland('已打断生成');
            return false;
        }
    }
    if (!text) {
        const continuePrompt = '<[系统隐式提示：请在当前视频电话中自然续写一两个新的画面/动作/对话节拍，不要重复上一句话。]>';
        await saveVideoMessage(continuePrompt, 'sent', null, null, null, null, null, null, { callId, chatId });
        showVideoTyping();
        await sendVideoCallMessageToAI(continuePrompt, chatId, callId);
        return true;
    }

    // 1. 先保存数据库，拿到 ID
    const msgId = await saveVideoMessage(text, 'sent', null, null, null, null, null, null, { callId, chatId }, options.speechContext);
    
    // 2. 再显示在界面上，并传入 ID
    const msgElement = appendMessageToVideoUI({ text: text, type: 'sent' }, msgId);
    
    // 3. 【新增】绑定长按事件 (用户消息只能删除)
    if (msgElement && msgId) {
        setupVideoLongPress(msgElement, msgId, 'sent');
    }

    showVideoTyping();
    const userCameraFrame = options.fromSpeech || text ? captureVideoFrameForAI() : '';
    await sendVideoCallMessageToAI(text, chatId, callId, { userCameraFrame });
    return true;
}

async function sendVideoCallMessage() {
    const draftText = videoCallInput.value;
    if (!draftText.trim()) return;
    videoCallInput.value = '';
    try {
        const sent = await submitVideoCallMessage(draftText);
        if (sent === false) {
            videoCallInput.value = draftText;
        }
    } catch (error) {
        videoCallInput.value = draftText;
        console.error('[Video Call] 发送消息失败：', error);
    }
}

async function stopVideoApiVoiceRecognition({ automatic = false } = {}) {
    if (videoApiVoiceCaptureStopping) return;
    videoApiVoiceCaptureStopping = true;
    const callContext = videoApiVoiceCallContext;
    setVideoSpeechRecognitionUi(false);
    if (automatic && isActiveVideoCallContext(callContext)) {
        setVideoTranscriptPreview('检测到停顿，正在识别语音...');
    }
    try {
        const recognizedResult = await stopApiVoiceCapture();
        if (!recognizedResult?.text || !isActiveVideoCallContext(callContext)) {
            if (!recognizedResult?.text && isActiveVideoCallContext(callContext)) {
                setVideoTranscriptPreview('点击麦克风开始说话');
                showDynamicIsland('没有识别到语音内容');
            }
            return;
        }
        const text = String(recognizedResult.text).trim();
        const speechContext = String(recognizedResult.speechContext || '').trim().slice(0, 240);
        setVideoTranscriptPreview(text);
        const sent = await submitVideoCallMessage(text, { fromSpeech: true, speechContext, callContext });
        if (sent === false && isActiveVideoCallContext(callContext)) videoCallInput.value = text;
    } catch (error) {
        if (isActiveVideoCallContext(callContext)) {
            const message = error?.message || '语音识别失败，请重试';
            setVideoTranscriptPreview(`语音识别失败：${message}`);
            showDynamicIsland(message);
        }
        console.warn('[Video Call] 自定义识别 API 失败：', error);
    } finally {
        videoApiVoiceCaptureStopping = false;
        if (isActiveVideoCallContext(callContext)) setVideoSpeechRecognitionUi(false);
        if (videoApiVoiceCallContext === callContext) videoApiVoiceCallContext = null;
    }
}

async function startVideoApiVoiceRecognition() {
    const callContext = getActiveVideoCallContext();
    if (!callContext) return;
    if (!isApiVoiceRecognitionEnabled()) {
        showDynamicIsland('请先在“声音与语音”中配置自接语音识别');
        return;
    }
    try {
        const session = await startApiVoiceCapture(callContext);
        videoApiVoiceCallContext = callContext;
        session.onLimitReached = () => {
            if (isActiveVideoCallContext(callContext)) stopVideoApiVoiceRecognition();
        };
        session.onSilence = () => {
            if (isActiveVideoCallContext(callContext)) stopVideoApiVoiceRecognition({ automatic: true });
        };
        session.onSilenceProgress = (remainingMs) => {
            if (!isActiveVideoCallContext(callContext) || remainingMs <= 0) return;
            const remainingSeconds = Math.ceil(remainingMs / 1000);
            setVideoTranscriptPreview(`检测到停顿，${remainingSeconds} 秒后自动识别并发送`);
        };
        session.onSpeechActivity = () => {
            if (isActiveVideoCallContext(callContext)) {
                setVideoTranscriptPreview('正在录音，停顿 5 秒后自动识别并发送');
            }
        };
        if (!isActiveVideoCallContext(callContext)) {
            cancelApiVoiceCapture();
            return;
        }
        setVideoTranscriptPreview('正在录音，停顿 5 秒后自动识别并发送');
        setVideoSpeechRecognitionUi(true);
    } catch (error) {
        if (isActiveVideoCallContext(callContext)) showDynamicIsland(error?.message || '无法启动语音识别');
        setVideoSpeechRecognitionUi(false);
    }
}


// =========================================================================
// === 交互逻辑函数 ===
// =========================================================================

/**
 * 让小窗元素变得可拖拽
 */
function makeDraggable(element, container) {
    let isDragging = false;
    let hasDragged = false;
    let startX, startY, initialLeft, initialTop;
    let containerRect = null;
    let elementWidth = 0;
    let elementHeight = 0;
    let pendingLeft = 0;
    let pendingTop = 0;
    let dragFrame = 0;

    const onDown = (e) => {
        // 如果点击的是图片，防止默认拖拽图片行为
        if (e.target.tagName === 'IMG') e.preventDefault();
        
        isDragging = true;
        hasDragged = false;
        element.style.transition = 'none';
        
        const event = e.type === 'touchstart' ? e.touches[0] : e;
        startX = event.clientX;
        startY = event.clientY;
        initialLeft = element.offsetLeft;
        initialTop = element.offsetTop;
        containerRect = container.getBoundingClientRect();
        elementWidth = element.offsetWidth;
        elementHeight = element.offsetHeight;
        pendingLeft = initialLeft;
        pendingTop = initialTop;
        element.style.willChange = 'transform';

        document.addEventListener('mousemove', onMove, { passive: false });
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchend', onUp);
        document.addEventListener('touchcancel', onUp);
    };

    const onMove = (e) => {
        if (!isDragging) return;
        e.preventDefault();
        
        const event = e.type === 'touchmove' ? e.touches[0] : e;
        if (!event || !containerRect) return;
        
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
            hasDragged = true;
        }
        
        let newLeft = initialLeft + dx;
        let newTop = initialTop + dy;

        newLeft = Math.max(0, Math.min(newLeft, containerRect.width - elementWidth));
        newTop = Math.max(0, Math.min(newTop, containerRect.height - elementHeight));
        pendingLeft = newLeft;
        pendingTop = newTop;

        if (!dragFrame) {
            dragFrame = requestAnimationFrame(() => {
                dragFrame = 0;
                element.style.transform = `translate3d(${pendingLeft - initialLeft}px, ${pendingTop - initialTop}px, 0)`;
            });
        }
    };

    const onUp = () => {
        if (!isDragging) return;
        isDragging = false;
        if (dragFrame) {
            cancelAnimationFrame(dragFrame);
            dragFrame = 0;
        }
        if (hasDragged) {
            element.style.left = `${pendingLeft}px`;
            element.style.top = `${pendingTop}px`;
        }
        element.style.transform = '';
        element.style.willChange = '';
        element.style.transition = '';
        if (hasDragged) {
            element.dataset.justDragged = '1';
            setTimeout(() => {
                if (element.dataset.justDragged === '1') delete element.dataset.justDragged;
            }, 180);
        }
        
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchend', onUp);
        document.removeEventListener('touchcancel', onUp);
        containerRect = null;
    };
    
    element.removeEventListener('mousedown', onDown);
    element.removeEventListener('touchstart', onDown);
    element.addEventListener('mousedown', onDown);
    element.addEventListener('touchstart', onDown);
}

/**
 * 启动计时器
 */
function startVideoTimer() {
    clearInterval(videoCallTimerInterval);
    videoCallSeconds = 0;
    
    if (videoCallStatus) videoCallStatus.textContent = "正在等待对方接听...";
    if (videoCallTimer) videoCallTimer.textContent = formatTime(videoCallSeconds);

    setTimeout(() => {
        if (videoCallContainer.style.display !== 'flex') return;

        if (videoCallStatus) videoCallStatus.textContent = "视频通话中";
        
        videoCallTimerInterval = setInterval(() => {
            videoCallSeconds++;
            if (videoCallTimer) {
                videoCallTimer.textContent = formatTime(videoCallSeconds);
            }
        }, 1000);

    }, 2000);
}

// =========================================================================
// === 流程控制函数 ===
// =========================================================================

/**
 * 启动视频通话
 */
export async function startVideoCall(character, initiator = 'user') {
    if (!character) return; 
    // 【新增防错】：无论如何，一旦进入视频画面，强制掐断所有铃声
    if (window.stopIncomingCallSound) window.stopIncomingCallSound();
    cancelApiVoiceCapture();
    stopVideoCamera({ notify: false });
    videoApiVoiceCallContext = null;
    videoApiVoiceCaptureStopping = false;
    setVideoTranscriptPreview('');
    setVideoSpeechRecognitionUi(false);

    // 【修改】使用传入的参数记录发起方
    tempState.callInitiator = initiator;
    currentVideoCallChatId = character.id;
    tempState.currentChatId = character.id;
    tempState.currentVideoCallId = `vid-${Date.now()}`;
    tempState.activeCallChatId = character.id;
    tempState.activeCallMode = 'video';
    tempState.callReturnPageId = 'page-chat-detail';
    tempState.callWidgetMinimized = false;
    hideCallMiniWidget();
    if (initiator === 'user') {
        await markSleepAwakenedByCall(character, tempState.currentVideoCallId).catch(error => {
            console.warn('[睡眠计划] 记录视频通话唤醒状态失败:', error);
        });
    }
    const currentUserIdentity = getCurrentChatIdentity();
    sessionStorage.setItem('video_call_crash_backup', JSON.stringify({
        id: tempState.currentVideoCallId,
        chatId: character.id,
        startTime: Date.now(),
        initiator: initiator
    }));
     // ▼▼▼ 【核心修改】优先使用覆写设置 (备注名/专属头像) ▼▼▼
    const displayCharName = character.chatOverrideName || character.name;
    const displayCharAvatar = character.chatOverrideAvatar || character.avatar || DEFAULT_AVATAR_SRC;
    const displayUserAvatar = character.chatOverrideUserAvatar || currentUserIdentity.avatar || DEFAULT_AVATAR_SRC;
    videoCallMiniMeta = { avatar: displayCharAvatar, name: displayCharName };
    // ▲▲▲ 修改结束 ▲▲▲

    // 【防报错修复】直接使用原有的 class 选择器，如果找不到则动态创建群聊网格
    const singleVideoBg = document.querySelector('.video-call-bg-view');
    const singleLocalView = document.querySelector('.local-view');
    let groupVideoGrid = document.getElementById('group-video-grid');
    
    if (!groupVideoGrid && videoCallContainer) {
        groupVideoGrid = document.createElement('div');
        groupVideoGrid.id = 'group-video-grid';
        groupVideoGrid.style.cssText = 'display: none; position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 1; flex-wrap: wrap; align-content: flex-start; background: #111;';
        videoCallContainer.insertBefore(groupVideoGrid, videoCallContainer.firstChild);
    }

    const wallpapers = character.videoWallpapers || {};

    if (character.isGroup) {
        // 群聊网格模式 (安全检测)
        if (singleVideoBg) singleVideoBg.style.display = 'none';
        if (singleLocalView) singleLocalView.style.display = 'none';
        if (groupVideoGrid) {
            groupVideoGrid.style.display = 'flex';
            groupVideoGrid.innerHTML = ''; // 清空旧数据
        }

        // 获取参会人员 (包括自己)
        const participants = tempState.callParticipants || getGroupParticipants(character).map(member => member.id);
        const activeMembers = participants.map(id => findGroupParticipantById(character, id)).filter(Boolean);
        const allParticipants = [{ id: currentUserIdentity.id, name: currentUserIdentity.name, avatar: displayUserAvatar }, ...activeMembers];

        // 动态计算每个格子大小 (1-4人占50%，5人以上占33%)
        const count = allParticipants.length;
        const flexBasis = count > 4 ? '33.33%' : '50%';
        const heightBasis = count <= 2 ? '50%' : (count <= 4 ? '50%' : '33.33%');
        
        allParticipants.forEach(member => {
            // ▼▼▼ 核心修复：正确读取用户在群聊中的专属壁纸 ▼▼▼
            const isUser = member.id === currentUserIdentity.id;
            const memberBg = isUser ? (wallpapers.user || member.avatar || DEFAULT_AVATAR_SRC) : (wallpapers[member.id] || member.avatar || DEFAULT_AVATAR_SRC);
            // ▲▲▲ 修复结束 ▲▲▲
            
            const gridItem = document.createElement('div');
            gridItem.style.cssText = `flex: 1 1 ${flexBasis}; height: ${heightBasis}; position: relative; border: 1px solid rgba(255,255,255,0.1); box-sizing: border-box; overflow: hidden;`;

            gridItem.innerHTML = `
                <img id="video-bg-${member.id}" src="${memberBg}" style="width: 100%; height: 100%; object-fit: cover; filter: brightness(0.85);">
                <div style="position: absolute; bottom: 10px; left: 10px; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); padding: 4px 10px; border-radius: 12px; font-size: 12px; color: #fff;">${escapeHTML(member.name)}</div>
            `;
            if (groupVideoGrid) groupVideoGrid.appendChild(gridItem);
        });
        if (remoteVideoUsername) remoteVideoUsername.textContent = character.name;
    } else {
        // 单聊全屏模式 (安全检测)
        if (groupVideoGrid) groupVideoGrid.style.display = 'none';
        if (singleVideoBg) singleVideoBg.style.display = 'block';
        if (singleLocalView) singleLocalView.style.display = 'block';

        if (remoteVideoAvatar) remoteVideoAvatar.src = wallpapers.char || displayCharAvatar;
        if (localVideoAvatar) localVideoAvatar.src = wallpapers.user || displayUserAvatar;
        if (remoteVideoUsername) remoteVideoUsername.textContent = character.subtitle || displayCharName;
    }

    if (videoCallInput) videoCallInput.value = '';

    if (videoMessageScrollFrame) {
        cancelAnimationFrame(videoMessageScrollFrame);
        videoMessageScrollFrame = 0;
    }
    if (videoCallMessageList) videoCallMessageList.innerHTML = '';
    
    showPage('video-call-container');
    startVideoTimer();
    startCallAmbient(character.id);
    if (getCallSettings(character.id).aiStarts) {
        setTimeout(() => submitVideoCallMessage(''), 300);
    }
    console.log(`[Video Call] 正在与 ${displayCharName} 发起视频通话... (由 ${initiator} 发起)`);
}


/**
 * 【修复】结束视频通话 (生成总结)
 */
async function endVideoCall() {
    clearInterval(videoCallTimerInterval);
        // 【新增防错】：视频挂断时，强制清理可能残留的幽灵铃声
    if (window.stopIncomingCallSound) window.stopIncomingCallSound();
    cancelApiVoiceCapture();
    stopVideoCamera({ notify: false });
    videoApiVoiceCallContext = null;
    videoApiVoiceCaptureStopping = false;
    setVideoTranscriptPreview('');
    setVideoSpeechRecognitionUi(false);
    hideCallMiniWidget();

    const duration = videoCallSeconds;
    const callId = tempState.currentVideoCallId;
    const callChatId = currentVideoCallChatId || tempState.currentChatId;
    const returnChatId = tempState.currentChatId;
    const videoCallPage = document.getElementById('video-call-container');
    const wasOnVideoCallPage = videoCallPage && getComputedStyle(videoCallPage).display !== 'none';
    const callInitiator = tempState.callInitiator || 'user'; // 获取发起方
    // 重置状态
    videoCallSeconds = 0;
    stopCallAmbient();
    delete tempState.currentVideoCallId;
    currentVideoCallChatId = null;
    sessionStorage.removeItem('video_call_crash_backup');
    delete tempState.callInitiator;
    delete tempState.activeCallChatId;
    delete tempState.activeCallMode;
    tempState.callWidgetMinimized = false;
    hideVideoTyping();
    
    console.log('[Video Call] 视频通话已结束。');
    if (callId && duration > 0) {
        // 【修复】根据谁发起的通话，决定这条总结消息是谁发的
        const summaryMessageType = callInitiator === 'ai' ? 'received' : 'sent';
        
        // ▼▼▼ 【修复】在群聊挂断时，把到底是谁接的电话印在系统消息上 ▼▼▼
        let participantStr = '';
        const currentGrp = AppState.characterProfiles.find(c => c.id === callChatId);
        if (currentGrp && currentGrp.isGroup && tempState.callParticipants) {
            const names = tempState.callParticipants.map(id => findGroupParticipantById(currentGrp, id)?.name).filter(Boolean);
            if (names.length > 0) participantStr = ` (参与成员: ${names.join('、')})`;
        }
        // ▲▲▲ 修复结束 ▲▲▲

        const summaryMsg = {
            chatId: callChatId,
            timestamp: new Date(),
            type: summaryMessageType, // 使用我们判断好的类型
            contentType: 'voice_call_summary', // 复用这个类型
            text: `视频通话时长 ${formatTime(duration)}${participantStr}`, // 【修复】加上名单
            duration: duration,
            callId: callId,
            isVideo: true // 【修复】加上这个关键的标志！
        };
        
        const id = await db.chatMessages.add(summaryMsg);

        const fullMsg = await db.chatMessages.get(id);
        tempState.currentChatId = callChatId;
        await createAndAppendMessage(fullMsg);
    }
    tempState.currentChatId = returnChatId || callChatId;
    if (wasOnVideoCallPage) {
        tempState.currentChatId = callChatId;
        await loadAndRenderChatHistory(callChatId);
        showPage(tempState.callReturnPageId || 'page-chat-detail');
    }
}

/**
 * 处理 AI 回复事件
 * 【修改】绑定了长按菜单事件
 */
async function handleAiResponse(e) {
    const { callId, chatId } = e.detail || {};
    if (tempState.activeCallMode !== 'video'
        || String(tempState.currentVideoCallId) !== String(callId)
        || String(currentVideoCallChatId) !== String(chatId)) return;
    hideVideoTyping();
    const { text, isError, speakerName, avatarSrc, speakerId, emotion, translation, responseGroupId } = e.detail;
    
    if (text && !isError) {
        // 1. 先保存数据库，把新拆出来的名字和头像带进去
        const msgId = await saveVideoMessage(text, 'received', speakerName, avatarSrc, speakerId, emotion || null, translation || null, responseGroupId || null, { callId, chatId });
        
        // 2. 再显示在界面上，并传入数据画头像
        const msgElement = appendMessageToVideoUI({ text: text, type: 'received', speakerName, avatarSrc, translation, responseGroupId }, msgId);

        // 3. 【新增】绑定长按事件 (AI消息可以删除和重回)
        if (msgElement && msgId) {
            setupVideoLongPress(msgElement, msgId, 'received');
        }

        // ▼▼▼ 修改：群聊已经在底层加入了独立队列，这里只放行单聊视频发音，避免双重重叠回音 ▼▼▼
        const callChatId = currentVideoCallChatId || tempState.currentChatId;
        const isGroupCall = AppState.characterProfiles.find(c => c.id === callChatId)?.isGroup;
        if (!isGroupCall) {
            TTSService.speakForVideoCallCharacter(text, callChatId, { emotion });
        }
        // ▲▲▲ 修改结束 ▲▲▲
    } else if (isError) {

        const msgElement = appendMessageToVideoUI({
            text: `(连接中断: ${text})`,
            type: 'system'
        });
        // 修复：给报错的系统消息也绑上长按事件
        if (msgElement) {
            setupVideoLongPress(msgElement, null, 'system');
        }
    }
}
/**
 * 【新增】处理视频背景自动切换 (支持群聊独立路由)
 */
function handleVideoBgUpdate(e) {
    const { imageUrl, speakerId, callId, chatId } = e.detail;
    if (!imageUrl
        || tempState.activeCallMode !== 'video'
        || String(tempState.currentVideoCallId) !== String(callId)
        || String(currentVideoCallChatId) !== String(chatId)) return;

    // ▼▼▼ 核心防串台隔离：必须先判断当前到底处于单聊还是群聊 ▼▼▼
    const currentCallChar = AppState.characterProfiles.find(c => String(c.id) === String(chatId));
    if (!currentCallChar) return;

    if (currentCallChar.isGroup) {
        // 群聊模式：只允许修改群员的格子，绝对不能碰单聊的全屏背景！
        if (speakerId) {
            const targetImg = document.getElementById(`video-bg-${speakerId}`);
            if (targetImg) {
                console.log(`[Video UI] 更新群员 ${speakerId} 动态场景: ${imageUrl}`);
                targetImg.src = imageUrl;
            }
        }
        // 如果是群聊且 speakerId 为空，什么也不做，防止污染！
    } else {
        // 单聊模式：只允许修改全屏背景
        if (remoteVideoAvatar) {
            console.log(`[Video UI] 应用单聊动态场景: ${imageUrl}`);
            remoteVideoAvatar.src = imageUrl;
        }
    }
    // ▲▲▲ 隔离结束 ▲▲▲
}

/**
 * 处理回车发送
 */
function handleInputKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendVideoCallMessage();
    }
}

async function handleVideoSpeechRecognitionToggle() {
    if (videoApiVoiceCaptureStopping) return;
    if (isApiVoiceCaptureActive()) await stopVideoApiVoiceRecognition();
    else await startVideoApiVoiceRecognition();
}
/**
 * 初始化模块
 */
export function initVideoCallModule() {
    if (!videoCallContainer) return;
    
    videoHangUpBtn.removeEventListener('click', endVideoCall);
    videoHangUpBtn.addEventListener('click', endVideoCall);
    
    videoCallSendBtn.removeEventListener('click', sendVideoCallMessage);
    videoCallSendBtn.addEventListener('click', sendVideoCallMessage);

    videoToggleMicBtn?.removeEventListener('click', handleVideoSpeechRecognitionToggle);
    videoToggleMicBtn?.addEventListener('click', handleVideoSpeechRecognitionToggle);

    videoSwitchCameraBtn?.removeEventListener('click', switchVideoCamera);
    videoSwitchCameraBtn?.addEventListener('click', switchVideoCamera);
    document.removeEventListener('video-call-camera-toggle', handleVideoCameraToggle);
    document.addEventListener('video-call-camera-toggle', handleVideoCameraToggle);
    document.removeEventListener('video-call-camera-state-request', handleVideoCameraStateRequest);
    document.addEventListener('video-call-camera-state-request', handleVideoCameraStateRequest);
    
    videoCallInput.removeEventListener('keydown', handleInputKeydown);
    videoCallInput.addEventListener('keydown', handleInputKeydown);
    document.getElementById('video-call-settings-btn')?.addEventListener('click', () => {
        requestCallQuickSettings(currentVideoCallChatId || tempState.activeCallChatId, 'video');
    });
    localView.style.top = '';
    localView.style.left = '';
    makeDraggable(localView, phoneScreen);
   document.removeEventListener('video_call_ai_response', handleAiResponse);
    document.addEventListener('video_call_ai_response', handleAiResponse);
    
    // ▼▼▼ 【新增】注册背景切换监听器 ▼▼▼
    document.removeEventListener('video_call_update_bg', handleVideoBgUpdate);
    document.addEventListener('video_call_update_bg', handleVideoBgUpdate);
   
    console.log("[Video Call] 模块初始化完成。");
    const crashBackup = sessionStorage.getItem('video_call_crash_backup');
    if (crashBackup) {
        try {
            const backupData = JSON.parse(crashBackup);
            const duration = Math.round((Date.now() - backupData.startTime) / 1000); // 计算意外退出到现在的时长
            // 补发一条总结消息到数据库
            db.chatMessages.add({
                chatId: backupData.chatId,
                timestamp: new Date(),
                type: backupData.initiator === 'ai' ? 'received' : 'sent',
                contentType: 'voice_call_summary',
                text: `视频通话意外中断 (时长 ${formatTime(duration)})`,
                duration: duration,
                callId: backupData.id,
                isVideo: true
            }).then(() => {
                console.log('[Video Call Guard] 已成功补救意外中断的通话记录。');
            });
        } catch (e) { console.error('恢复通话记录失败', e); }
        sessionStorage.removeItem('video_call_crash_backup'); // 处理完一定要清除
    }
}
// =========================================================================
// === 【新增】视频通话长按菜单功能 ===
// =========================================================================

/**
 * 设置长按事件监听
 */
function setupVideoLongPress(element, messageId, type) {
    let timer = null;
    let isLongPress = false;

    const start = (e) => {
        isLongPress = false;
        timer = setTimeout(() => {
            isLongPress = true;
            showVideoActionMenu(e, element, messageId, type);
        }, 500); // 500毫秒算长按
    };

    const cancel = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };
    // 触摸屏事件
    element.addEventListener('touchstart', start, { passive: true });
    element.addEventListener('touchend', (e) => {
        cancel();
        if (isLongPress && e.cancelable) e.preventDefault(); 
    });
    element.addEventListener('touchmove', cancel, { passive: true });

    // 鼠标事件 (方便电脑端调试)
    element.addEventListener('mousedown', start);
    element.addEventListener('mouseup', cancel);
    element.addEventListener('mouseleave', cancel);
}

/**
 * 显示操作菜单 (删除/重回)
 */
function showVideoActionMenu(e, element, messageId, type) {
    // 移除已有的菜单
    const existingMenu = document.querySelector('.video-action-menu');
    if (existingMenu) existingMenu.remove();

    // 创建菜单
    const menu = document.createElement('div');
    menu.className = 'video-action-menu';
    menu.style.position = 'fixed';
    menu.style.zIndex = '10030';
    menu.style.visibility = 'hidden';

    // 1. 删除按钮
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'video-action-menu-btn delete';
    deleteBtn.innerHTML = `<span>删除</span>`;
    deleteBtn.onclick = async () => {
        if (confirm('确定删除这条消息吗？')) {
            if (messageId) await db.chatMessages.delete(Number(messageId)); // 删库
            element.remove(); // 删界面
            menu.remove(); // 关菜单
        }
    };
     menu.appendChild(deleteBtn);

    // 2. 重回按钮 (开放给 AI 消息和系统报错消息)
    if (type === 'received' || type === 'system') {
        // 加个分割线

        const divider = document.createElement('div');
        divider.className = 'video-action-menu-divider';
        menu.appendChild(divider);

        const regenBtn = document.createElement('button');
        regenBtn.type = 'button';
        regenBtn.className = 'video-action-menu-btn';
        regenBtn.innerHTML = `<span>重新生成</span>`;
        regenBtn.onclick = async () => {
            menu.remove(); 
            await handleVideoRegenerate(messageId, element);
        };
        menu.appendChild(regenBtn);
    }
    // 计算显示位置
    const rect = element.getBoundingClientRect();
    const point = e.touches?.[0] || e.changedTouches?.[0] || e;
    const anchorX = Number.isFinite(point.clientX) ? point.clientX : rect.left + rect.width / 2;
    const anchorY = Number.isFinite(point.clientY) ? point.clientY : rect.top;
    document.body.appendChild(menu);
    const menuRect = menu.getBoundingClientRect();
    const margin = 12;
    let left = anchorX - menuRect.width / 2;
    let top = anchorY - menuRect.height - margin;
    if (top < margin) top = Math.min(window.innerHeight - menuRect.height - margin, anchorY + margin);
    left = Math.max(margin, Math.min(left, window.innerWidth - menuRect.width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - menuRect.height - margin));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = 'visible';

    // 点击其他地方关闭菜单
    const openedAt = Date.now();
    const closeMenu = (ev) => {
        if (Date.now() - openedAt < 450) return;
        if (!menu.contains(ev.target)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
            document.removeEventListener('pointerdown', closeMenu);
        }
    };
    // 延迟一点绑定，防止立即触发
    setTimeout(() => {
        document.addEventListener('click', closeMenu);
        document.addEventListener('pointerdown', closeMenu);
    }, 0);
}

/**
 * 处理“重回”逻辑
 */
async function handleVideoRegenerate(messageId, element) {
    try {
        const targetMessageId = messageId ? Number(messageId) : null;
        const targetMessageRecord = targetMessageId ? await db.chatMessages.get(targetMessageId) : null;
        const lockedCallId = targetMessageRecord?.callId || tempState.currentVideoCallId;
        const lockedChatId = targetMessageRecord?.chatId || currentVideoCallChatId || tempState.currentChatId;
        if (!lockedCallId
            || tempState.activeCallMode !== 'video'
            || String(tempState.currentVideoCallId) !== String(lockedCallId)
            || String(currentVideoCallChatId) !== String(lockedChatId)) {
            hideVideoTyping();
            showDynamicIsland('视频通话已结束，不能重新生成');
            return;
        }
        const callMessages = await db.chatMessages
            .where('callId').equals(lockedCallId)
            .toArray();
        callMessages.sort((a, b) => (a.id || 0) - (b.id || 0));

        const targetMessage = targetMessageId ? callMessages.find(m => Number(m.id) === targetMessageId) : null;
        const responseGroupId = targetMessage?.responseGroupId || element?.dataset?.responseGroupId || null;
        let messagesToDelete = [];
        let lastUserMsg = null;

        if (responseGroupId) {
            messagesToDelete = callMessages.filter(m => m.responseGroupId === responseGroupId);
            const firstReplyId = Math.min(...messagesToDelete.map(m => Number(m.id)).filter(Boolean));
            lastUserMsg = [...callMessages].reverse().find(m => m.type === 'sent' && Number(m.id) < firstReplyId);
        } else {
            const targetIndex = callMessages.findIndex(m => Number(m.id) === targetMessageId);
            const prevSentItem = targetIndex >= 0
                ? callMessages.slice(0, targetIndex).map((m, index) => ({ m, index })).reverse().find(item => item.m.type === 'sent')
                : null;
            const nextSentOffset = targetIndex >= 0
                ? callMessages.slice(targetIndex + 1).findIndex(m => m.type === 'sent')
                : -1;
            const startIndex = prevSentItem ? prevSentItem.index + 1 : targetIndex;
            const endIndex = nextSentOffset >= 0 ? targetIndex + 1 + nextSentOffset : callMessages.length;
            messagesToDelete = targetIndex >= 0
                ? callMessages.slice(startIndex, endIndex).filter(m => m.type === 'received' || m.type === 'system')
                : (targetMessage ? [targetMessage] : []);
            lastUserMsg = prevSentItem?.m || null;
        }

        const deleteIds = messagesToDelete.map(m => Number(m.id)).filter(Boolean);
        if (deleteIds.length > 0) {
            await db.chatMessages.bulkDelete(deleteIds);
        }

        const deleteIdSet = new Set(deleteIds.map(String));
        Array.from(videoCallMessageList?.querySelectorAll('[data-message-id]') || []).forEach(node => {
            if (deleteIdSet.has(String(node.dataset.messageId))) node.remove();
        });
        if (deleteIds.length === 0 && element) element.remove();

        showVideoTyping();

        if (lastUserMsg) {
            console.log('正在重新生成本次视频回复，使用上一条用户消息:', lastUserMsg.text);
            await sendVideoCallMessageToAI(lastUserMsg.text, lockedChatId, lockedCallId);
        } else {
            console.error('找不到上一条用户消息，无法重新生成');
            hideVideoTyping();
        }
    } catch (error) {
        console.error('重新生成失败:', error);
        hideVideoTyping();
    }
}
