import { db, AppState, DEFAULT_AVATAR_SRC } from '../state.js';
import { UI, showDynamicIsland } from '../ui.js';
import { escapeHTML } from '../utils.js';
import { findBestImageForDescription } from './gallery.js';
import { generateImage, getCharacterImageGenMode, getImageGenSettings } from './image-gen.js';
import { generateMomentCommentsBatch, generateMomentComment, generateMomentReplyComment, generateCharacterMoment, generateNpcMomentComment } from './chat-service.js'; 
import { notification } from './notification.js'; // <--- 新增
import { getSleepState } from './sleep-system.js';


const PROFILE_ID = 1; // 假设我们的用户资料在数据库里ID总是1
const activeMomentImageGenerations = new Map();
const activeMomentCommentRequests = new Set();

function getMomentImageGenerationKey(momentId, mediaIndex) {
    return `${Number(momentId)}:${Number(mediaIndex)}`;
}

function parseMomentImagePrompt(text = '') {
    const match = String(text || '').match(/^\[配图:\s*(.+)\]$/);
    return match ? match[1].trim() : String(text || '').trim();
}

function createMomentImageGenerationPlaceholder(promptText, charId, options = {}) {
    const keywords = String(options.keywords || promptText || '').trim();
    const naiTags = String(options.naiTags || '').trim();
    const includeCharacter = typeof options.includeCharacter === 'boolean'
        ? options.includeCharacter
        : undefined;
    return {
        type: 'image_generating',
        isAiGenerated: true,
        content: promptText,
        prompt: promptText,
        keywords,
        includeCharacter,
        imageGenerationStatus: 'loading',
        imageGenerationError: '',
        imageGenerationPayload: {
            description: promptText,
            keywords,
            ...(naiTags ? { naiTags } : {}),
            charId,
            scene: 'moments',
            ...(typeof includeCharacter === 'boolean' ? { includeCharacter } : {})
        }
    };
}

async function refreshMomentCard(momentId) {
    const updatedMoment = await db.moments.get(momentId);
    if (!updatedMoment) return null;
    const oldCard = document.querySelector(`.moment-card[data-id="${momentId}"]`);
    if (oldCard) {
        const newCard = createMomentElement(updatedMoment);
        oldCard.replaceWith(newCard);
        bindCardEvents(newCard);
    }
    return updatedMoment;
}

async function updateMomentMediaItem(momentId, mediaIndex, patch = {}) {
    let nextMoment = null;
    await db.transaction('rw', db.moments, async () => {
        const moment = await db.moments.get(momentId);
        if (!moment || !Array.isArray(moment.media)) return;
        const nextMedia = moment.media.slice();
        if (!nextMedia[mediaIndex]) return;
        nextMedia[mediaIndex] = { ...nextMedia[mediaIndex], ...patch };
        moment.media = nextMedia;
        await db.moments.put(moment);
        nextMoment = moment;
    });
    if (nextMoment) await refreshMomentCard(momentId);
    return nextMoment;
}

async function runMomentImageGeneration(momentId, mediaIndex, payload) {
    const key = getMomentImageGenerationKey(momentId, mediaIndex);
    const controller = new AbortController();
    activeMomentImageGenerations.set(key, controller);
    await updateMomentMediaItem(momentId, mediaIndex, {
        type: 'image_generating',
        imageGenerationStatus: 'loading',
        imageGenerationError: '',
        imageGenerationPayload: payload
    });
    try {
        const result = await generateImage({
            userPrompt: payload.description,
            keywords: payload.keywords,
            naiTags: payload.naiTags,
            charId: payload.charId,
            includeCharacter: payload.includeCharacter,
            signal: controller.signal
        });
        await updateMomentMediaItem(momentId, mediaIndex, {
            type: 'image',
            src: result.imageUrl,
            content: payload.description,
            isAiGenerated: true,
            imageGenerationStatus: 'done',
            imageGenerationError: '',
            imageGenerationPayload: payload,
            includeCharacter: payload.includeCharacter,
            generationPrompt: result.prompt,
            generationKeywords: payload.keywords,
            imageAiDescription: payload.description,
            isSticker: false
        });
    } catch (error) {
        const stopped = error?.name === 'AbortError';
        await updateMomentMediaItem(momentId, mediaIndex, {
            type: 'image_generating',
            imageGenerationStatus: stopped ? 'stopped' : 'error',
            imageGenerationError: stopped ? '' : (error?.message || '生成失败'),
            imageGenerationPayload: payload
        });
        if (!stopped) console.error('[Moments image generation failed]', error);
    } finally {
        activeMomentImageGenerations.delete(key);
        await refreshMomentCard(momentId);
    }
}

async function stopAiMomentImageGeneration(momentId, mediaIndex) {
    const key = getMomentImageGenerationKey(momentId, mediaIndex);
    const controller = activeMomentImageGenerations.get(key);
    if (controller) {
        controller.abort();
        return;
    }
    await updateMomentMediaItem(momentId, mediaIndex, {
        type: 'image_generating',
        imageGenerationStatus: 'stopped'
    });
}

async function retryAiMomentImageGeneration(momentId, mediaIndex) {
    const key = getMomentImageGenerationKey(momentId, mediaIndex);
    if (activeMomentImageGenerations.has(key)) {
        showDynamicIsland('图片正在生成中，请先等待或停止', 'warning');
        return;
    }
    const moment = await db.moments.get(momentId);
    const mediaItem = moment?.media?.[mediaIndex];
    const payload = mediaItem?.imageGenerationPayload;
    if (!payload) {
        showDynamicIsland('这张图缺少重试信息', 'warning');
        return;
    }
    await runMomentImageGeneration(momentId, mediaIndex, payload);
}

// =========================================================================
// == 核心数据操作 (与数据库交互)
// =========================================================================
/**
 * 【修改版】从数据库加载并渲染动态卡片 (分页模式：每次只加载20条)
 */
async function loadAndRenderMoments() {
    const momentsContainer = document.querySelector('.moments-content');
    if (!momentsContainer) return;
    // 1. 先清理掉现有的卡片和底部的“加载更多”按钮（如果有的话）
    momentsContainer.querySelectorAll('.moment-card, #moments-load-more-btn, .moments-end-msg').forEach(el => el.remove());
    
    try {
        // 2. 获取动态总数（优化：不一次性加载所有数据到内存）
        const totalCount = await db.moments.count();
        
        // === 分页配置 ===
        const PAGE_SIZE = 8; // 每次加载多少条
        let currentOffset = 0; // 当前加载到了第几条

        // === 定义一个内部函数，用来加载下一批 ===
        const renderNextBatch = async () => {
            // 算出这一批要截取的数据（优化：每次只从数据库拿需要的20条）
            const nextSlice = await db.moments.orderBy('id').reverse().offset(currentOffset).limit(PAGE_SIZE).toArray();
            
            // 渲染这一批卡片（优化：使用 DocumentFragment 批量插入，避免频繁重排导致白屏）
            const fragment = document.createDocumentFragment();
            nextSlice.forEach(momentData => {
                const momentElement = createMomentElement(momentData);
                fragment.appendChild(momentElement); 
                bindCardEvents(momentElement);
            });
            momentsContainer.appendChild(fragment);

            // 更新偏移量
            currentOffset += PAGE_SIZE;
            // --- 处理底部按钮逻辑 ---
            
            // 先删掉旧的按钮（防止出现多个）
            const oldBtn = document.getElementById('moments-load-more-btn');
            if (oldBtn) oldBtn.remove();

            // 如果还有没显示完的，就加个“加载更多”按钮
            if (currentOffset < totalCount) {
                const loadMoreBtn = document.createElement('div');
                loadMoreBtn.id = 'moments-load-more-btn';
                loadMoreBtn.textContent = '加载更多';
                // 直接写样式，省得你去改CSS文件
                loadMoreBtn.style.cssText = 'text-align: center; padding: 20px; color: #576b95; cursor: pointer; font-size: 14px; margin-bottom: 20px; font-weight: 500;';
                
                // 点击后，递归调用自己，加载下一批
                loadMoreBtn.onclick = () => {
                    loadMoreBtn.textContent = '加载中...'; // 给点反馈
                    setTimeout(renderNextBatch, 300); // 稍微延迟一点点，感觉更流畅
                };
                
                momentsContainer.appendChild(loadMoreBtn);
            } 
            // 如果全都显示完了，且总数超过了20条，显示一个“到底了”的提示
            else if (totalCount > PAGE_SIZE) {
                const endMsg = document.createElement('div');
                endMsg.className = 'moments-end-msg';
                endMsg.textContent = '— 到底了 —';
                endMsg.style.cssText = 'text-align: center; padding: 20px; color: #ccc; font-size: 12px; margin-bottom: 20px;';
                momentsContainer.appendChild(endMsg);
            }
        };

        // 3. 立即触发第一次加载
        await renderNextBatch();
        
    } catch (error) {
        console.error("❌ 加载动态失败:", error);

    }
}

/**
 * 保存一条新的动态到数据库
 * @param {object} momentData - 动态数据对象
 */
async function saveMoment(momentData) {
    try {
        const newId = await db.moments.add(momentData);
        console.log(`✅ 动态已保存到数据库，ID: ${newId}`);
        return newId; // 返回新生成的 ID
    } catch (error) {
        console.error("❌ 保存动态到数据库失败:", error);
    }
}
/**
 * 更新数据库中的点赞状态
 * @param {number} momentId - 动态的 ID
 * @param {boolean} isLiked - 当前是否为点赞状态
 * @param {string} userName - 当前用户名
 */
async function updateLikeInDB(momentId, isLiked, userName) {
    try {
        await db.transaction('rw', db.moments, async () => {
            const moment = await db.moments.get(momentId);
            if (!moment) return;
            if (!Array.isArray(moment.likes)) moment.likes = [];
            const userIndex = moment.likes.indexOf(userName);
            if (isLiked && userIndex === -1) {
                moment.likes.unshift(userName);
            } else if (!isLiked && userIndex > -1) {
                moment.likes.splice(userIndex, 1);
            }
            await db.moments.put(moment);
        });
    } catch (error) {
        console.error("❌ 更新点赞数据失败:", error);
    }
}

/**
 * 保存一条新评论到数据库
 * @param {number} momentId - 动态的 ID
 * @param {object} commentObject - { user, content, replyToUser }
 */
async function addCommentToDB(momentId, commentObject) {
    try {
        const moment = await db.moments.get(momentId);
        if (!moment) return;
        
        // 确保 comments 数组存在
        if (!Array.isArray(moment.comments)) {
            moment.comments = [];
        }
        
        // 添加新评论并保存
        moment.comments.push(commentObject);
        await db.moments.put(moment);

    } catch (error) {
        console.error("❌ 保存评论到数据库失败:", error);
    }
}

function normalizeMomentSpeakerName(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[\s"'`“”‘’「」『』【】[\]（）()]/g, '');
}

function getBatchParticipantName(participant) {
    if (!participant) return '';
    if (participant.type === 'npc') {
        return participant.data?.name || participant.npcData?.name || participant.name || '';
    }
    const charId = participant.id || participant.charId || participant.data?.id;
    const character = AppState.characterProfiles.find(c => String(c.id) === String(charId));
    return character?.name || participant.name || '';
}
function getBatchParticipantCharId(participant) {
    if (!participant) return null;
    return participant.id || participant.charId || participant.data?.id || null;
}

// 根据参与者，找它对应的 AI 决策（按参与者反查）
function findBatchDecisionForParticipant(decisions, participant) {
    const targetName = normalizeMomentSpeakerName(getBatchParticipantName(participant));
    if (!targetName) return null;
    return (decisions || []).find(decision =>
        normalizeMomentSpeakerName(decision?.speaker) === targetName
    ) || null;
}

// 根据 AI 返回的决策，反查它对应的参与者（用于按AI顺序渲染）
function findParticipantForBatchDecision(participants, decision) {
    const target = normalizeMomentSpeakerName(decision?.speaker);
    if (!target) return null;
    return (participants || []).find(p => normalizeMomentSpeakerName(getBatchParticipantName(p)) === target) || null;
}
// 根据发言人名字，重建参与者对象（用于重回时找回整批人）
function buildParticipantFromSpeaker(speakerName) {
    const cleanName = String(speakerName || '').trim();
    // 【优化3】去除 && !c.isGroup 的限制并增加 trim()，防止因为名字带空格或群聊角色导致无法识别
    const mainChar = AppState.characterProfiles.find(c => c.name.trim() === cleanName);
    if (mainChar) return { type: 'character', id: mainChar.id };
    for (const c of AppState.characterProfiles) {
        const npc = (c.relatedNpcs || []).find(n => n.name.trim() === cleanName);
        if (npc) return { type: 'npc', data: npc, ownerCharId: c.id };
    }
    return null;
}
// 同步重绘某条动态的整个评论区（用于批量删除后刷新）
function renderMomentCommentList(card, comments) {
    if (!card) return;
    const list = comments || [];
    const commentList = card.querySelector('.comment-list');
    if (commentList) {
        commentList.innerHTML = list.map((c, index) => {
            const transSuffix = c.translation ? `<span class="comment-translation" style="display:table;margin-top:5px;padding:5px 10px;background:#fff;color:#888;font-size:11px;line-height:1.5;border-radius:8px;">${c.translation}</span>` : '';
            if (c.replyToUser) {
                return `<div class="comment-item" data-user="${c.user}" data-index="${index}"><span class="comment-user">${c.user}</span> <span class="reply-indicator">回复</span> <span class="comment-user">${c.replyToUser}:</span><span class="comment-content"> ${c.content}</span>${transSuffix}</div>`;
            }
            return `<div class="comment-item" data-user="${c.user}" data-index="${index}"><span class="comment-user">${c.user}:</span><span class="comment-content"> ${c.content}</span>${transSuffix}</div>`;
        }).join('');
    }
    const countSpan = card.querySelector('.js-toggle-comment .count');
    if (countSpan) countSpan.innerText = list.length || '';
}

function showMomentBatchLoading(momentId, participants, label = '正在输入...') {
    const card = document.querySelector(`.moment-card[data-id="${momentId}"]`);
    const commentList = card?.querySelector('.comment-list');
    if (!commentList) return () => {};

    const loadingIds = [];
    (participants || []).forEach(participant => {
        const name = getBatchParticipantName(participant);
        if (!name) return;

        const loadingDiv = document.createElement('div');
        const loadingId = `loading-batch-${Date.now()}-${Math.random()}`;
        loadingDiv.id = loadingId;
        loadingDiv.className = 'comment-item ai-loading-indicator';
        loadingDiv.style.cssText = 'color: #999; font-size: 0.9em; padding: 5px 0; font-style: italic;';
        loadingDiv.innerHTML = `<span class="comment-user">${name}:</span> ${label}`;
        commentList.appendChild(loadingDiv);
        loadingIds.push(loadingId);
    });

    return () => loadingIds.forEach(id => document.getElementById(id)?.remove());
}

async function processPostBatchDecisions(decisions, participants, momentId) {
    const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const orderedDecisions = Array.isArray(decisions) ? decisions : [];
    for (const decision of orderedDecisions) {
        const participant = findParticipantForBatchDecision(participants, decision);
        if (!participant) continue;
        const charId = getBatchParticipantCharId(participant);
        if (!charId) continue;
        await processAiDecision(decision, charId, momentId, batchId);
    }
}

async function processReplyBatchDecisions(decisions, participants, momentId, fallbackReplyTo) {
    const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const orderedDecisions = Array.isArray(decisions) ? decisions : [];
    for (const decision of orderedDecisions) {
        if (!decision?.reply) continue;
        const participant = findParticipantForBatchDecision(participants, decision);
        if (!participant) continue;
        const replyToTarget = decision.replyTo || fallbackReplyTo;
        if (participant.type === 'npc') {
            await processAiReply(
                decision.reply,
                participant.ownerCharId,
                momentId,
                replyToTarget,
                participant.data || participant.npcData,
                decision.translation,
                batchId
            );
        } else {
            await processAiReply(
                decision.reply,
                getBatchParticipantCharId(participant),
                momentId,
                replyToTarget,
                null,
                decision.translation,
                batchId
            );
        }
    }
}

async function generateMomentBatchOrFallback(options) {
    const participants = options.participants || [];
    const decisions = await generateMomentCommentsBatch(options);
    const validDecisions = Array.isArray(decisions) ? decisions : [];
    const missingParticipants = validDecisions.length > 0
        ? participants.filter(participant => !findBatchDecisionForParticipant(validDecisions, participant))
        : participants;

    if (missingParticipants.length === 0) return validDecisions;

    console.warn(validDecisions.length > 0
        ? '[朋友圈系统] 批量生成缺少部分参与者，正在为缺失参与者降级补生成。'
        : '[朋友圈系统] 批量生成失败或无可解析结果，降级为旧的逐人生成流程。'
    );
    const fallbackDecisions = [];

    for (const participant of missingParticipants) {
        const speaker = getBatchParticipantName(participant);
        try {
            if (options.kind === 'post') {
                const charId = getBatchParticipantCharId(participant);
                if (!charId) continue;
                const audienceIds = (options.audienceIds || []).filter(id => String(id) !== String(charId));
                const decision = await generateMomentComment(
                    charId,
                    options.momentData,
                    options.contextMode,
                    audienceIds
                );
                if (decision) fallbackDecisions.push({ ...decision, speaker });
                continue;
            }

            if (participant.type === 'npc') {
                const decision = await generateNpcMomentComment(
                    participant.data || participant.npcData,
                    options.momentData
                );
                if (decision) fallbackDecisions.push({ ...decision, speaker });
                continue;
            }

            const charId = getBatchParticipantCharId(participant);
            if (!charId) continue;
            const audienceIds = (options.audienceIds || []).filter(id => String(id) !== String(charId));
            const decision = await generateMomentReplyComment(
                charId,
                options.momentData,
                options.userReplyComment,
                options.contextMode,
                audienceIds
            );
            if (decision) fallbackDecisions.push({ ...decision, speaker });
        } catch (error) {
            console.warn(`[朋友圈系统] ${speaker || '未知参与者'} 的降级生成失败:`, error);
        }
    }

    return [...validDecisions, ...fallbackDecisions];
}



/**
 * 从数据库删除一条动态
 * @param {number} momentId - 动态的 ID
 */
async function deleteMomentFromDB(momentId) {
    try {
        await db.moments.delete(momentId);
        console.log(`✅ 动态 ID: ${momentId} 已从数据库删除。`);
    } catch (error) {
        console.error(`❌ 删除动态 ID: ${momentId} 失败:`, error);
    }
}

// =========================================================================
// == UI 渲染与事件绑定
// =========================================================================
/**
 * 格式化时间戳，显示成“xx分钟前”等
 */
function formatTime(timestamp) {
    const now = new Date();
    const past = new Date(timestamp);
    const diffSeconds = Math.floor((now - past) / 1000);
    if (diffSeconds < 60) return '刚刚';
    if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}分钟前`;
    if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}小时前`;
    return past.toLocaleDateString();
}
/**
 * 创建动态卡片的 HTML 结构 (只负责创建，不绑定逻辑)
 * @param {object} data - 从数据库读取的动态数据
 */
function createMomentElement(data) {
    const article = document.createElement('article');
    article.className = 'moment-card';
    article.dataset.id = data.id; //【关键】将数据库ID存到DOM上
    const media = data.media || [];
    const likes = data.likes || [];
    const comments = data.comments || [];
    
    // 【新增】生成评论HTML的逻辑
    const commentsHtml = comments.map((c, index) => {
        const transSuffix = c.translation ? `<span class="comment-translation" style="display:table;margin-top:5px;padding:5px 10px;background:#fff;color:#888;font-size:11px;line-height:1.5;border-radius:8px;">${c.translation}</span>` : '';
        if (c.replyToUser) {
            // 这是回复别人的评论
            return `<div class="comment-item" data-user="${c.user}" data-index="${index}"><span class="comment-user">${c.user}</span> <span class="reply-indicator">回复</span> <span class="comment-user">${c.replyToUser}:</span><span class="comment-content"> ${c.content}</span>${transSuffix}</div>`;
        } else {
            // 这是普通的评论
            return `<div class="comment-item" data-user="${c.user}" data-index="${index}"><span class="comment-user">${c.user}:</span><span class="comment-content"> ${c.content}</span>${transSuffix}</div>`;
        }
    }).join('');
    // 检查是否有音乐
    const hasMusic = media.some(item => item.type === 'music');
    // 如果有音乐，强制不使用九宫格，而是只显示音乐卡片
    const count = hasMusic ? 1 : media.length; 
    let gridClass = hasMusic ? 'grid-1' : ('grid-' + count);
    if (count > 9) gridClass = 'grid-9';

    const mediaHtml = media.map((item, index) => {
        // ▼▼▼ 新增：渲染音乐卡片 ▼▼▼
        if (item.type === 'music') {
            const song = item.songData;
            // 把歌曲数据存在 dataset 里，方便点击时读取
            // 【终极修复】使用 URL 编码彻底解决歌词或歌名中包含单引号(')导致的 JSON 截断报错
            const songDataStr = encodeURIComponent(JSON.stringify(song));
            return `
            <div class="moment-music-card" data-song="${songDataStr}" onclick="
                event.stopPropagation();
                if(window.MusicPlayer) {
                    const songData = JSON.parse(decodeURIComponent(this.getAttribute('data-song')));
                    let targetIdx = window.MusicPlayer.globalPlaylist.findIndex(s => s.title === songData.title && s.artist === songData.artist);

                    // 【修复】：本地曲库没有这首歌时，只临时播放，不写入用户曲库
                    if(targetIdx === -1) {
                        window.MusicPlayer.playlist = [songData];
                        targetIdx = 0;
                    } else {
                        window.MusicPlayer.playlist = [...window.MusicPlayer.globalPlaylist];
                    }
                    window.MusicPlayer.updatePlaylistDrawer();
                    window.MusicPlayer.playSongAtIndex(targetIdx);
                    if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland('正在播放: ' + songData.title, 'success');
                }
            ">
                <div class="music-share-card" style="width: 100%; margin-top: 8px;">

                    <div class="music-top-deco"><span class="deco-text">♫ NOW PLAYING</span><span class="deco-line"></span></div>
                    <div class="music-card-header">
                        <div class="music-cover-wrap">
                            <img src="${song.cover || 'images/default-avatar.svg'}" class="music-cover" loading="lazy" decoding="async">
                            <div class="play-icon-overlay"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>
                            <div class="vinyl-record-deco"></div>
                        </div>
                        <div class="music-info-wrap">
                            <div class="music-title">${song.title}</div>
                            <div class="music-artist">${song.artist}</div>
                        </div>
                    </div>
                </div>
            </div>`;
        }
        // ▲▲▲ 新增结束 ▲▲▲
        else if (item.type === 'image_generating') {
            const status = item.imageGenerationStatus || 'loading';
            const isLoading = status === 'loading';
            const title = isLoading ? '生成中...' : (status === 'stopped' ? '已停止' : '生成失败');
            const detail = item.imageGenerationError
                ? item.imageGenerationError
                : (item.imageGenerationPayload?.description || item.content || '');
            return `
            <div class="media-item moment-image-task is-${status}" data-media-index="${index}">
                <div class="moment-image-task-head">
                    <div class="moment-image-task-spinner" aria-hidden="true"></div>
                    <div class="moment-image-task-title">
                        <strong>${escapeHTML(title)}</strong>
                        <span>AI IMAGE</span>
                    </div>
                </div>
                <div class="moment-image-task-detail">
                    <span>画面描述</span>
                    <p>${escapeHTML(detail)}</p>
                </div>
                <div class="moment-image-task-actions">
                    <button type="button" data-moment-image-action="retry">重试</button>
                    ${isLoading ? '<button type="button" data-moment-image-action="stop">停止</button>' : ''}
                </div>
            </div>`;
        } else if (item.type === 'image') {
            const description = item.imageAiDescription || item.generationPrompt || item.content || '无描述';
            const generatedImageClass = item.isAiGenerated ? ' is-generated-image' : '';
            return `
    <div class="media-item image-reveal-container${generatedImageClass}" data-media-index="${index}" onclick="this.classList.toggle('show-desc'); event.stopPropagation();">
                <img src="${item.src}" loading="lazy" decoding="async" fetchpriority="low">
                <div class="hidden-desc-overlay">
                    <p>${description}</p>
                </div>
            </div>`;
        } else {
            return `<div class="media-item"><div class="simulated-image-container" onclick="this.classList.toggle('is-revealed'); event.stopPropagation();"><div class="spoiler-overlay"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path></svg><span>TAP</span></div><div class="simulated-content">${item.content}</div></div></div>`;
        }
    }).join('');

    const locationHtml = data.location ? `<span class="separator">·</span><span class="location">${data.location}</span>` : '';
      const amILiking = AppState.userProfile && likes.includes(AppState.userProfile.name);
    // 逻辑：如果动态自带身份证(ID)，就只认身份证，防止同名误判；如果是旧动态(无ID)，才退而求其次认名字。
    const char = AppState.characterProfiles.find(c => {
        if (data.characterId) {
            return c.id === data.characterId; // 有ID只比对ID
        } else {
            return c.name === data.author; // 没ID才比对名字
        }
    });
    const displayAvatar = char ? (char.chatOverrideAvatar || char.avatar) : data.avatar;
    const displayName = char ? (char.chatOverrideName || char.name) : data.author;
    article.innerHTML = `
        <header class="moment-card__header">
            <div class="avatar-wrapper"><img src="${displayAvatar}" class="avatar-img author-avatar" alt="avatar" loading="lazy" decoding="async"></div>
            <div class="meta-wrapper">
                <div class="author-name" data-author="${data.author}">${displayName}</div>
                <div class="meta-info"><span class="time">${formatTime(data.id)}</span>${locationHtml}</div>
            </div>

            <button class="more-btn"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="1.5"/><circle cx="6" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/></svg></button>
        </header>
        <div class="moment-card__body">
            ${data.content ? `<p class="content-text">${data.content}</p>` : ''}
            ${data.translation ? `<p class="content-translation" style="display:table;margin-top:5px;padding:5px 10px;background:#f9f9f9;color:#888;font-size:12px;line-height:1.5;border-radius:8px;">${data.translation}</p>` : ''}
            ${count > 0 ? `<div class="media-grid ${gridClass}">${mediaHtml}</div>` : ''}
        </div>
        <footer class="moment-card__footer">
            <button class="action-btn js-toggle-comment" aria-label="评论">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
                </svg>
                <span class="count">${comments.length || ''}</span>
            </button>
            <button class="action-btn like-btn ${amILiking ? 'liked' : ''}" aria-label="点赞">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                </svg>
                <span class="count">${likes.length || ''}</span>
            </button>
            <button class="action-btn" aria-label="转发">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path>
                    <polyline points="16 6 12 2 8 6"></polyline>
                    <line x1="12" y1="2" x2="12" y2="15"></line>
                </svg>
                <span class="count">${data.forwards || ''}</span>
            </button>
        </footer>
        <div class="moment-card__comments" style="display: none;">
            <div class="comments-box">
                <div class="likes-list" style="${likes.length > 0 ? '' : 'display: none;'}">
                    <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:#576b95;margin-right:4px;">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                    </svg>
                    <span> ${likes.join(', ')}</span>
                </div>
                <div class="comment-list">
                    ${commentsHtml}
                </div>
                <div class="comment-input-wrapper"><input type="text" placeholder="评论一句..."><button>发送</button></div>
            </div>
        </div>
    `;
    return article;
}
/**
 * 更新数据库中的一条动态
 * @param {object} momentData - 完整的动态数据
 */
async function updateMomentInDB(momentData) {
    try {
        await db.moments.put(momentData);
        console.log(`✅ 动态 ID: ${momentData.id} 已在数据库中更新。`);
    } catch (error) {
        console.error(`❌ 更新动态 ID: ${momentData.id} 失败:`, error);
    }
}

/**
 * ✨【修改版】创建并显示动态卡片的操作菜单 (区分 用户编辑 / AI重生成)
 * @param {HTMLElement} buttonEl - 被点击的 .more-btn 按钮
 * @param {number} momentId - 动态的 ID
 */
function createAndShowActionMenu(buttonEl, momentId) {
    // 防止重复创建
    if (document.getElementById('moment-action-menu-overlay')) return;

    // 1. 获取作者名字，判断是 AI 还是 用户
    const card = buttonEl.closest('.moment-card');
    // 读取存入的真名，而不是显示的文字
const authorName = card.querySelector('.author-name').getAttribute('data-author');

    // 尝试在角色列表里找到对应名字的角色对象
    const aiCharacter = AppState.characterProfiles.find(c => c.name === authorName);
    const isAi = !!aiCharacter; // 如果找到了，就是AI

    // 2. 创建遮罩层
    const overlay = document.createElement('div');
    overlay.id = 'moment-action-menu-overlay';
    overlay.className = 'moment-action-menu-overlay';

    // 3. 根据身份决定第一个按钮的 HTML (重生成 vs 编辑)
    let firstButtonHtml = '';
    if (isAi) {
        // AI: 显示“重生成”按钮 (使用刷新图标)
        firstButtonHtml = `
        <button class="menu-item js-regenerate-moment">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
            重生成
        </button>`;
    } else {
        // 用户: 显示“编辑”按钮 (保持原有逻辑)
        firstButtonHtml = `
        <button class="menu-item js-edit-moment">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            编辑
        </button>`;
    }

    // 4. 创建菜单 DOM (组合第一个按钮和删除按钮)
    const menu = document.createElement('div');
    menu.className = 'moment-action-menu';
    menu.innerHTML = `
        ${firstButtonHtml}
        <button class="menu-item danger js-delete-moment">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
            删除
        </button>
    `;

    document.body.appendChild(overlay);
    overlay.appendChild(menu);

    // 5. 计算菜单位置
    const rect = buttonEl.getBoundingClientRect();
    menu.style.top = `${window.scrollY + rect.bottom - 5}px`;
    menu.style.right = `${window.innerWidth - rect.right - 5}px`;
    
    // 6. 关闭函数
    const closeMenu = () => {
        const overlayToRemove = document.getElementById('moment-action-menu-overlay');
        if (overlayToRemove) overlayToRemove.remove();
    };

    // 绑定事件
    overlay.onclick = closeMenu;
    
    // --- 通用：删除按钮事件 ---
    menu.querySelector('.js-delete-moment').onclick = async () => {
        if (confirm('确定要删除这条动态吗？')) {
            await deleteMomentFromDB(momentId);
            // 从界面移除
            if (card) card.remove();
            closeMenu();
        }
    };
    
    // --- 分支：AI 重生成 vs 用户 编辑 ---
    if (isAi) {
        // 如果是 AI -> 绑定重生成事件
        menu.querySelector('.js-regenerate-moment').onclick = async () => {
            if (confirm('确定要重新生成吗？当前动态将被删除。')) {
                closeMenu(); 
                
                // 1. 删除旧的动态 (数据库 + 界面)
                await deleteMomentFromDB(momentId);
                if (card) card.remove();

                // 2. 触发新的生成
                // aiCharacter 是我们在第一步里找到的角色对象，直接用它的 ID
                if (aiCharacter) {
                    console.log(`[AI动态] 重生成触发：${aiCharacter.name}`);
                    // 传入 false，表示“这是手动操作，不要检查冷却时间，立即执行”
                    triggerAiPostMoment(aiCharacter.id, false);
                } else {
                    showDynamicIsland('错误：找不到角色信息');
                }
            }
        };
    } else {
        // 如果是 用户 -> 绑定编辑事件
        menu.querySelector('.js-edit-moment').onclick = () => {
            openEditModal(momentId);
            closeMenu();
        };
    }
}


/**
 * ✨【新增】处理AI动态重生成
 * 逻辑：删除旧动态 -> 界面移除 -> 查找角色ID -> 触发新动态生成
 */
async function handleAiRegenerate(oldMomentId, authorName, cardElement) {
    // 1. 删除旧的
    await deleteMomentFromDB(oldMomentId);
    if (cardElement) cardElement.remove();

    // 2. 找到是哪个AI
    const character = AppState.characterProfiles.find(c => c.name === authorName);
    
    if (character) {
        console.log(`[AI动态] 重生成：角色 ${character.name} (ID: ${character.id})`);
        // 3. 触发生成 (复用你已有的 triggerAiPostMoment 函数)
        // 注意：triggerAiPostMoment 内部会自动把新动态插入到列表顶部
        triggerAiPostMoment(character.id);
    } else {
        showDynamicIsland('找不到该角色信息，无法重生成', 'error');
    }
}

/**
 * ✨【新增】打开编辑模式的弹窗
 * @param {number} momentId 
 */
async function openEditModal(momentId) {
    const momentData = await db.moments.get(momentId);
    if (!momentData) {
        alert("找不到要编辑的动态！");
        return;
    }
    
    // 打开通用的创建/编辑弹窗
    const modal = document.getElementById('create-moment-modal');
    openCreateModal(); // 调用你已有的打开函数
  const postBtn = document.getElementById('post-moment-btn');
    if (postBtn) {
        postBtn.textContent = '保存';
    }
    // 标记为编辑模式，并存入ID
    modal.dataset.editId = momentId;

    // 填充数据
    const textarea = document.getElementById('moment-textarea');
    if (textarea) textarea.value = momentData.content || '';
    // 清空并重新填充图片
    const grid = document.querySelector('.moment-media-grid');
    grid.querySelectorAll('.media-item-wrapper').forEach(item => item.remove());
    if (momentData.media && momentData.media.length > 0) {
        momentData.media.forEach(mediaItem => {
            if (mediaItem.type === 'music') {
                addMediaToGrid(null, false, true, mediaItem.songData);
            } else {
                const content = mediaItem.type === 'image' ? mediaItem.src : mediaItem.content;
                const isSimulated = mediaItem.type !== 'image';
                addMediaToGrid(content, isSimulated);
            }
        });
    }

    // 可以在这里填充地点、@好友等，如果需要的话

}

/**
 * 为卡片绑定交互事件
 * @param {HTMLElement} article - 卡片元素
 */
function bindCardEvents(article) {
    const momentId = parseInt(article.dataset.id);
    if (!momentId || !AppState.userProfile) return;
    const currentUser = AppState.userProfile;
    
    // 用来记录当前准备回复谁
    let replyTargetUser = null; 

    // --- 1. 点赞逻辑 (保持不变) ---
    const likeBtn = article.querySelector('.like-btn');
    if (likeBtn) {
        likeBtn.onclick = function() {
            const isLiked = this.classList.toggle('liked');
            updateLikeInDB(momentId, isLiked, currentUser.name);
            const countSpan = this.querySelector('.count');
            let count = parseInt(countSpan.innerText) || 0;
            const likesList = article.querySelector('.likes-list');
            const namesSpan = likesList.querySelector('span');
            let names = namesSpan.innerText.trim() ? namesSpan.innerText.trim().split(/,\s*/) : [];
            if (isLiked) {
                countSpan.innerText = count + 1;
                if (!names.includes(currentUser.name)) names.unshift(currentUser.name);
            } else {
                countSpan.innerText = count > 1 ? count - 1 : '';
                names = names.filter(name => name !== currentUser.name);
            }
            namesSpan.innerText = ' ' + names.join(', ');
            likesList.style.display = names.length > 0 ? 'flex' : 'none';
        };
    }

    // --- 2. 评论区展开/收起 (保持不变) ---
    const commentToggleBtn = article.querySelector('.js-toggle-comment');
    const commentsSection = article.querySelector('.moment-card__comments');
    if (commentToggleBtn) {
        commentToggleBtn.onclick = () => {
            const isHidden = commentsSection.style.display === 'none' || !commentsSection.style.display;
            commentsSection.style.display = isHidden ? 'block' : 'none';
        };
    }
    
     // --- 3. 更多操作按钮 (修改：强制显示，方便调试) ---
    const moreBtn = article.querySelector('.more-btn');
    if (moreBtn) {
        // 直接让它显示，不再判断是谁发的
        moreBtn.style.display = 'block'; 
        
        moreBtn.onclick = function(e) {
            e.stopPropagation();
            createAndShowActionMenu(this, momentId);
        };
    }

 
    const forwardBtn = article.querySelector('.action-btn[aria-label="转发"]');
    if (forwardBtn) {
        forwardBtn.onclick = function() {
            // 1. 收集当前动态的基础数据
            const author = article.querySelector('.author-name').innerText;
            const avatar = article.querySelector('.author-avatar').src;
            const content = article.querySelector('.content-text')?.innerText || '';
            
            // 获取第一张图作为缩略图
            let thumb = '';
            const firstImg = article.querySelector('.media-item img');
            if (firstImg) thumb = firstImg.src;
            
            // 获取点赞和评论数
            const likesCount = parseInt(article.querySelector('.like-btn .count').innerText) || 0;
            const commentsCount = parseInt(article.querySelector('.js-toggle-comment .count').innerText) || 0;

            // ▼▼▼【新增】抓取具体的评论内容 ▼▼▼
            let commentsTextArray = [];
            const commentItems = article.querySelectorAll('.comment-list .comment-item');
            
            commentItems.forEach(item => {
                // 排除掉“正在思考...”这种占位符
                if(item.classList.contains('ai-loading-indicator')) return;

                const userEl = item.querySelector('.comment-user');
                const contentEl = item.querySelector('.comment-content');
                
                if (userEl && contentEl) {
                    // 格式化为 "用户名: 内容"
                    let text = `${userEl.innerText.replace(/[:：]/g, '')}: ${contentEl.innerText}`;
                    // 如果是回复别人的，稍微处理一下
                    const replyIndicator = item.querySelector('.reply-indicator');
                    if (replyIndicator) {
                        // 如果是回复，结构稍复杂，我们简单提取纯文本即可
                        text = item.innerText.replace(/[\r\n]+/g, ' '); 
                    }
                    commentsTextArray.push(text);
                }
            });
            // ▲▲▲【新增结束】▲▲▲

            const cardData = {
                momentId: momentId,
                author,
                avatar,
                text: content,
                thumb,
                likes: likesCount,
                comments: commentsCount,
                // 把抓取到的评论列表传下去
                commentsDetail: commentsTextArray 
            };

            // 2. 打开选择好友弹窗
            openForwardFriendSelectModal(cardData);
        };
    }
    // --- 4. 评论交互核心逻辑 (有2处关键修正) ---
    const commentInput = article.querySelector('.comment-input-wrapper input');
    const commentSendBtn = article.querySelector('.comment-input-wrapper button');
    const commentList = article.querySelector('.comment-list');
    const commentCountSpan = article.querySelector('.js-toggle-comment .count');

    // --- 4. 评论交互核心逻辑 (长按菜单 + 点击回复) ---
    if (commentList) {
        let pressTimer = null;
        let isLongPress = false;

        // 1. 手指按下 (开始计时)
        const startPress = (e) => {
            // 如果是AI正在输入的状态条，忽略
            if (e.target.closest('.ai-loading-indicator')) return;
            
            isLongPress = false; // 重置状态
            pressTimer = setTimeout(() => {
                isLongPress = true; // 标记为长按触发
                const item = e.target.closest('.comment-item');
                if (item) {
                    // 触发长按菜单
                    handleCommentLongPress(item, momentId, parseInt(item.dataset.index));
                }
            }, 600); // 600毫秒算长按
        };

        // 2. 手指抬起/移动 (取消计时)
        const cancelPress = () => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
        };

        // 绑定触摸事件 (兼容手机和鼠标)
        commentList.addEventListener('touchstart', startPress, { passive: true });
        commentList.addEventListener('touchend', cancelPress);
        commentList.addEventListener('touchmove', cancelPress);
        commentList.addEventListener('mousedown', startPress);
        commentList.addEventListener('mouseup', cancelPress);
        commentList.addEventListener('mouseleave', cancelPress);

        // 3. 点击事件 (如果是长按触发了，就不要执行回复逻辑)
        commentList.onclick = (e) => {
            if (isLongPress) return; // 如果是长按，拦截点击，不让它变成“回复”

            const item = e.target.closest('.comment-item');
            if (!item) return;
            if (item.classList.contains('ai-loading-indicator')) return;

            const userToReply = item.dataset.user;
            if (!userToReply) return;

            if (userToReply === currentUser.name) return; // 不能回复自己

            // 正常的回复逻辑
            replyTargetUser = userToReply;
            if (commentInput) {
                commentInput.placeholder = `回复 ${userToReply}:`;
                commentInput.focus();
            }
        };
    }
    // 点击卡片内部（非输入框）时取消回复状态
    article.addEventListener('click', async event => {
        const imageAction = event.target.closest('[data-moment-image-action]');
        if (imageAction) {
            const mediaCard = imageAction.closest('[data-media-index]');
            const mediaIndex = Number(mediaCard?.dataset.mediaIndex);
            if (Number.isFinite(mediaIndex)) {
                event.stopPropagation();
                event.preventDefault();
                if (imageAction.dataset.momentImageAction === 'stop') {
                    await stopAiMomentImageGeneration(momentId, mediaIndex);
                } else if (imageAction.dataset.momentImageAction === 'retry') {
                    await retryAiMomentImageGeneration(momentId, mediaIndex);
                }
            }
            return;
        }

        const imageCard = event.target.closest('.image-reveal-container.is-generated-image');
        if (imageCard) {
            const img = imageCard.querySelector('img');
            const imageUrl = img?.currentSrc || img?.src;
            if (imageUrl) {
                event.stopPropagation();
                event.preventDefault();
                const mediaIndex = Number(imageCard.dataset.mediaIndex);
                const moment = await db.moments.get(momentId);
                const mediaItem = Number.isFinite(mediaIndex) ? moment?.media?.[mediaIndex] : null;
                const { showChatImageViewer } = await import('./chat-ui.js');
                showChatImageViewer({
                    id: `moment-${momentId}-${mediaIndex}`,
                    stickerUrl: imageUrl,
                    imageAiDescription: mediaItem?.imageAiDescription || mediaItem?.content || '',
                    generationKeywords: mediaItem?.generationKeywords || '',
                    isAiGenerated: true,
                    savedToGallery: true
                }, { allowSave: false });
            }
            return;
        }

    }, true);

    article.addEventListener('click', (event) => {
        if (article.contains(event.target)) {
            const isClickInsideInput = article.querySelector('.comment-input-wrapper')?.contains(event.target);
            if (!isClickInsideInput) {
                replyTargetUser = null;
                if (commentInput) commentInput.placeholder = '评论一句...';
            }
        }
    }, true);
    // 发送评论
    if (commentInput && commentSendBtn) {
        const sendComment = async () => {
            const text = commentInput.value.trim();
            if (!text) return;
            
            const commentObject = { 
                user: currentUser.name, 
                content: text,
                replyToUser: replyTargetUser
            };

            commentInput.value = '';
            replyTargetUser = null;
            commentInput.placeholder = '评论一句...';

            // 1. 显示用户自己的评论 (UI先行)
            const newCommentItem = document.createElement('div');
            newCommentItem.className = 'comment-item';
            newCommentItem.setAttribute('data-user', commentObject.user);
            if(commentObject.replyToUser) {
                newCommentItem.innerHTML = `<span class="comment-user">${commentObject.user}</span> <span class="reply-indicator">回复</span> <span class="comment-user">${commentObject.replyToUser}:</span><span class="comment-content"> ${commentObject.content}</span>`;
            } else {
                newCommentItem.innerHTML = `<span class="comment-user">${commentObject.user}:</span><span class="comment-content"> ${commentObject.content}</span>`;
            }
            commentList.appendChild(newCommentItem);
            let currentCount = parseInt(commentCountSpan.innerText) || 0;
            commentCountSpan.innerText = currentCount + 1;

            // 2. 保存到数据库
            await addCommentToDB(momentId, commentObject);
            
                // ▼▼▼ 【核心逻辑重构 V3.0 - 统一导演模式】▼▼▼
            const momentData = await db.moments.get(momentId);
            if (!momentData) return;
            
            const isAiPost = AppState.characterProfiles.some(c => c.name === momentData.author);

            if (isAiPost) {
                // 情况A: 动态是AI发的 -> 启动AI动态的专属群聊导演
                manageAiMomentInteraction(momentId, momentData, commentObject);
            } else {
                // 情况B: 动态是用户发的 -> 启动用户动态的群聊导演 (沿用旧逻辑)
                manageMomentInteraction(momentId, momentData, commentObject);
            }
        };

        commentSendBtn.onclick = sendComment;
        commentInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendComment();
            }
        };
    }

}
// moments.js

/**
 * ✨【全新清洁函数】重置“创建动态”弹窗的所有状态，恢复到初始空白状态
 */
function resetCreateModalState() {
    console.log('[状态重置] 正在清理“创建动态”弹窗...');

    const modal = document.getElementById('create-moment-modal');
    if (!modal) return;

    // 1. 清空文本内容
    const textarea = document.getElementById('moment-textarea');
    if (textarea) textarea.value = '';

    // 2. 清空所有已选的图片/媒体
    const grid = document.querySelector('.moment-media-grid');
    if (grid) {
        grid.querySelectorAll('.media-item-wrapper').forEach(item => item.remove());
    }

    // 3. 重置位置信息
    const locationSpan = document.getElementById('location-status-text');
    if (locationSpan) {
        locationSpan.innerText = '添加地点';
        locationSpan.style.color = '#bbb';
    }

    // 4. 重置“提醒谁看”
    const remindSpan = document.getElementById('remind-status-text');
    if (remindSpan) {
        remindSpan.textContent = '';
        remindSpan.style.color = '#bbb';
    }
    // 并且清空其背后存储的数据
    remindSelection.clear();
    remindSelectionNames = [];

    // 5. 重置隐私设置
    const privacySpan = document.getElementById('privacy-status-text');
    if (privacySpan) {
        privacySpan.textContent = '公开';
    }
    // 并且清空其背后存储的数据，恢复为“公开”
    currentPrivacySelection.clear();
    currentPrivacyNames.clear();
    currentPrivacySelection.add('public');
    currentPrivacyNames.add('公开');
    const postBtn = document.getElementById('post-moment-btn');
    if (postBtn) {
        postBtn.textContent = '发布';
    }
    // 6. 【最关键的一步】清除“编辑模式”的标记
    // 这样可以防止下一次新建时错误地触发“更新”逻辑
    if (modal.dataset.editId) {
        delete modal.dataset.editId;
        console.log('[状态重置] “编辑模式”标记已移除。');
    }
    
    console.log('[状态重置] 弹窗清理完毕，已恢复至初始状态。');
}


/**
 * 处理发布/更新动态的逻辑
 */
async function handlePostMoment() {
    const modal = document.getElementById('create-moment-modal');
    const editId = modal.dataset.editId ? parseInt(modal.dataset.editId) : null;

    const textarea = document.getElementById('moment-textarea');
    const content = textarea ? textarea.value.trim() : '';
    const mediaElements = document.querySelectorAll('.moment-media-grid .media-item-wrapper .media-item');
    const locationSpan = document.getElementById('location-status-text');
    
    const mediaData = Array.from(mediaElements).map(el => {
        if (el.dataset.type === 'music') {
            return {
                type: 'music',
                songData: JSON.parse(el.dataset.song.replace(/&apos;/g, "'"))
            };
        }
        return {
            type: el.dataset.type === 'real' ? 'image' : 'text',
            src: el.src, 
            content: el.innerText
        };
    });

    if (!content && mediaData.length === 0) {
        alert('请写点什么或添加媒体~');
        return;
    }

    const momentDataPayload = {
        author: AppState.userProfile.name,
        avatar: AppState.userProfile.avatar,
        content: content,
        media: mediaData,
        location: (locationSpan && locationSpan.innerText !== '添加地点') ? locationSpan.innerText : '',
    };

    if (editId) {
        // --- 更新模式 (这部分逻辑不变) ---
        const originalMoment = await db.moments.get(editId);
        const updatedMoment = {
            ...originalMoment,
            ...momentDataPayload,
            id: editId,
        };
        await updateMomentInDB(updatedMoment);
        
        const oldCard = document.querySelector(`.moment-card[data-id="${editId}"]`);
        if (oldCard) {
            const newCard = createMomentElement(updatedMoment);
            oldCard.replaceWith(newCard);
            bindCardEvents(newCard);
        }

    } else {
        // --- 新建模式 ---
        const momentData = {
            id: Date.now(),
            ...momentDataPayload,
            likes: [],
            comments: [],
            forwards: 0,
            visibleTo: Array.from(currentPrivacySelection), 
        };
        await saveMoment(momentData);
        
        const profileSection = document.querySelector('.moments-profile');
        if (profileSection) {
            const momentElement = createMomentElement(momentData);
            profileSection.after(momentElement);
            bindCardEvents(momentElement);
        }
showDynamicIsland('动态已发布，朋友们正在赶来的路上...', 'ai-thinking');      
 // ▼▼▼【第一步】用这个新版AI评论触发逻辑，替换旧的 ▼▼▼
console.log('[朋友圈系统] 开始处理AI评论...');

// 1. 解析可见性设置
// a. 找出所有被选中的分组ID
const visibleGroupIds = Array.from(currentPrivacySelection)
    .filter(v => v.startsWith('group_'))
    .map(v => v.replace('group_', ''));

// b. 找出所有单独被选中的角色ID
const visibleCharIds = Array.from(currentPrivacySelection)
    .filter(v => v.startsWith('char_'))
    .map(v => v.replace('char_', ''));

const isPublic = currentPrivacySelection.has('public');

// 2. 准备两个不同的“派对”名单
const groupPartyAttendees = new Map(); // 存分组派对的参与者 <groupId, [charId1, charId2...]>
const privateInvitees = new Set(visibleCharIds); // 存收到私密邀请函的角色ID

// 3. 分配派对参与者
if (isPublic) {
    // 如果是公开，所有角色都加入一个“公共派对”
    // 👇 增加 .filter(c => !c.isGroup) 
    const allCharIds = AppState.characterProfiles.filter(c => !c.isGroup).map(c => c.id);
    groupPartyAttendees.set('public_party', allCharIds);
} else {
    // 如果不是公开，则处理分组
    visibleGroupIds.forEach(groupId => {
        const members = AppState.characterProfiles
            // 👇 增加 && !c.isGroup 的判断
            .filter(c => c.groupId === groupId && !c.isGroup)
            .map(c => c.id);
        if (members.length > 0) {
            groupPartyAttendees.set(groupId, members);
        }
    });
}

// 4. 触发AI评论，并明确告知“派对模式”
setTimeout(async () => {
    // a. 处理“分组派对”
    for (const [groupId, attendees] of groupPartyAttendees.entries()) {
        console.log(`[朋友圈系统] 处理分组派对: ${groupId}, 参与者:`, attendees);
        const participants = attendees.map(id => ({ type: 'character', id }));
        const cleanupLoading = showMomentBatchLoading(momentData.id, participants, '正在思考...');
        try {
            const decisions = await generateMomentBatchOrFallback({
                kind: 'post',
                momentData,
                participants,
                contextMode: 'group',
                audienceIds: attendees
            });
            await processPostBatchDecisions(decisions, participants, momentData.id);
        } finally {
            cleanupLoading();
        }
    }

    // b. 处理“私密邀请函”
    // 私密邀请按角色分别请求，避免不同私密可见范围在同一提示词中互相泄露。
    for (const charId of privateInvitees) {
        console.log(`[朋友圈系统] 处理私密邀请: ${charId}`);
        const participants = [{ type: 'character', id: charId }];
        const cleanupLoading = showMomentBatchLoading(momentData.id, participants, '正在思考...');
        try {
            const decisions = await generateMomentBatchOrFallback({
                kind: 'post',
                momentData,
                participants,
                contextMode: 'private',
                audienceIds: []
            });
            await processPostBatchDecisions(decisions, participants, momentData.id);
        } finally {
            cleanupLoading();
        }
    }

    console.log('[朋友圈系统] AI评论处理完毕。');

}, 1500); // 延迟1.5秒开始，感觉更自然

    }
    
    // 清理并关闭弹窗
    if (modal.dataset.editId) delete modal.dataset.editId;
    closeCreateModal(); 
}

// 辅助函数：统一处理AI的决策（点赞/评论），避免代码重复
async function processAiDecision(aiDecision, charId, momentId, batchId = null) {
    if (!aiDecision) return;
    const card = document.querySelector(`.moment-card[data-id="${momentId}"]`);
    const character = AppState.characterProfiles.find(c => c.id === charId);
    // 处理点赞
    if (aiDecision.shouldLike && character) {
        await updateLikeInDB(momentId, true, character.name);
        if (card) {
            const likesList = card.querySelector('.likes-list');
            const namesSpan = likesList.querySelector('span');
            let names = namesSpan.innerText.trim() ? namesSpan.innerText.trim().split(/,\s*/) : [];
            if (!names.includes(character.name)) {
                names.unshift(character.name);
                namesSpan.innerText = ' ' + names.join(', ');
                likesList.style.display = 'flex';
                const likeBtn = card.querySelector('.like-btn .count');
                likeBtn.innerText = names.length || '';
            }
        }
    }

    // 处理评论
    if (aiDecision.comment && aiDecision.comment.content) {
        // 【关键】如果是分组派对，AI的评论需要包含所有其他参与者的信息
        if (aiDecision.comment.context === 'group') {
            const audience = aiDecision.comment.audience; // 其他参与者的名字数组
            // 可以在这里决定评论格式，例如，是否要在评论中@所有人
            // 为简化，我们暂时不在UI上特殊显示，但AI内部已经知道了
        }
        if (!aiDecision.comment.replyToUser && aiDecision.replyTo) {
            aiDecision.comment.replyToUser = aiDecision.replyTo;
        }
        aiDecision.comment.batchId = batchId;
        await addCommentToDB(momentId, aiDecision.comment);

        if (!card) return;
        
        const commentList = card.querySelector('.comment-list');
        const commentCountSpan = card.querySelector('.js-toggle-comment .count');
        const newCommentItem = document.createElement('div');
        newCommentItem.className = 'comment-item';
        newCommentItem.setAttribute('data-user', aiDecision.comment.user);
        const decTransSuffix = aiDecision.comment.translation ? `<span class="comment-translation" style="display:table;margin-top:5px;padding:5px 10px;background:#fff;color:#888;font-size:11px;line-height:1.5;border-radius:8px;">${aiDecision.comment.translation}</span>` : '';
        if (aiDecision.comment.replyToUser) {
            newCommentItem.innerHTML = `<span class="comment-user">${aiDecision.comment.user}</span> <span class="reply-indicator">回复</span> <span class="comment-user">${aiDecision.comment.replyToUser}:</span><span class="comment-content"> ${aiDecision.comment.content}</span>${decTransSuffix}`;
        } else {
            newCommentItem.innerHTML = `<span class="comment-user">${aiDecision.comment.user}:</span><span class="comment-content"> ${aiDecision.comment.content}</span>${decTransSuffix}`;
        }
        commentList.appendChild(newCommentItem);
        
        let currentCount = parseInt(commentCountSpan.innerText) || 0;
        commentCountSpan.innerText = currentCount + 1;
        
        const commentsSection = card.querySelector('.moment-card__comments');
        if (commentsSection.style.display === 'none' || !commentsSection.style.display) {
            commentsSection.style.display = 'block';
        }
    }
}

/**
 * 查找角色有权限看到的用户最新一条动态。
 * 聊天回复和朋友圈写入共用这份校验，避免评论错动态或越权读取。
 */
async function getLatestUserMomentForCharacter(charId) {
    const character = AppState.characterProfiles.find(c => String(c.id) === String(charId));
    const userProfile = AppState.userProfile || await db.userProfile.get(PROFILE_ID);
    if (!character || !userProfile?.name || character.isGroup) return null;

    const moments = await db.moments.orderBy('id').reverse().limit(50).toArray();
    return moments.find(moment => {
        if (moment.author !== userProfile.name) return false;
        const visibleTo = new Set(Array.isArray(moment.visibleTo) && moment.visibleTo.length > 0 ? moment.visibleTo : ['public']);
        if (visibleTo.has('public') || visibleTo.has(`char_${charId}`)) return true;
        return Boolean(character.groupId && visibleTo.has(`group_${character.groupId}`));
    }) || null;
}

/**
 * 在聊天中响应“评论我的朋友圈”动作。
 * 评论文字由聊天主请求直接生成，这里只做权限校验、数据库写入和界面更新。
 */
async function triggerAiCommentOnLatestUserMoment(charId, generatedComment = null) {
    const character = AppState.characterProfiles.find(c => String(c.id) === String(charId));
    const userProfile = AppState.userProfile || await db.userProfile.get(PROFILE_ID);
    if (!character || !userProfile?.name || character.isGroup) return null;
    const requestKey = String(charId);
    if (activeMomentCommentRequests.has(requestKey)) return null;
    activeMomentCommentRequests.add(requestKey);

    try {
        const momentData = await getLatestUserMomentForCharacter(charId);
        if (!momentData) return null;

        const visibleTo = new Set(Array.isArray(momentData.visibleTo) && momentData.visibleTo.length > 0 ? momentData.visibleTo : ['public']);
        let audienceIds = [];
        if (visibleTo.has('public')) {
            audienceIds = AppState.characterProfiles.filter(c => !c.isGroup).map(c => c.id);
        } else {
            const directIds = Array.from(visibleTo)
                .filter(value => value.startsWith('char_'))
                .map(value => AppState.characterProfiles.find(c => String(c.id) === value.slice(5))?.id)
                .filter(id => id !== undefined && id !== null);
            const groupIds = Array.from(visibleTo)
                .filter(value => value.startsWith('group_'))
                .map(value => value.slice(6));
            const groupMemberIds = groupIds.flatMap(groupId =>
                AppState.characterProfiles.filter(c => !c.isGroup && String(c.groupId) === String(groupId)).map(c => c.id)
            );
            audienceIds = [...new Set([...directIds, ...groupMemberIds])];
        }
        audienceIds = audienceIds.filter(id => String(id) !== String(charId));
        const contextMode = visibleTo.has('public') || audienceIds.length > 1 ? 'group' : 'private';
        let aiDecision = null;
        if (generatedComment && typeof generatedComment === 'object') {
            const generatedMomentId = Number(generatedComment.momentId ?? generatedComment.id);
            const rawComment = generatedComment.comment ?? generatedComment.text ?? '';
            const commentText = String(typeof rawComment === 'object'
                ? (rawComment?.content ?? rawComment?.text ?? '')
                : rawComment).trim();
            if (!Number.isFinite(generatedMomentId) || generatedMomentId !== Number(momentData.id) || !commentText) return null;
            aiDecision = {
                shouldLike: generatedComment.shouldLike === true,
                comment: {
                    user: character.name,
                    content: commentText,
                    translation: String(generatedComment.translation || '').trim(),
                    replyToUser: String(generatedComment.replyToUser || '').trim(),
                    context: contextMode,
                    audience: audienceIds
                }
            };
        } else {
            // 朋友圈页面原有的自动评论流程仍使用独立请求。
            aiDecision = await generateMomentComment(charId, momentData, contextMode, audienceIds, { forceComment: true });
        }
        if (!aiDecision) return null;

        await processAiDecision(aiDecision, character.id, momentData.id);
        const momentsPage = document.getElementById('page-dynamics');
        if (!momentsPage?.classList.contains('active')) {
            notification.show(
                character.chatOverrideName || character.name,
                aiDecision.comment?.content ? '评论了你的朋友圈' : '赞了你的朋友圈',
                character.avatar,
                'page-dynamics'
            );
        }
        return aiDecision;
    } finally {
        activeMomentCommentRequests.delete(requestKey);
    }
}


// =========================================================================
// == 个人资料与UI更新 ("广播"功能)
// =========================================================================
/**
 * 加载用户资料并存入全局状态
 */
async function loadAndCacheProfile() {
    try {
        let profile = await db.userProfile.get(PROFILE_ID);
        if (!profile) {
            profile = { id: PROFILE_ID, name: 'Amireux', avatar: 'images/default-avatar.svg', coverImage: '' };
            await db.userProfile.put(profile);
        }
        // 【关键】将用户信息存入全局状态
        AppState.userProfile = profile;
        // 首次渲染UI
        if (UI.moments.userName) UI.moments.userName.textContent = profile.name;
        if (UI.moments.userAvatar) UI.moments.userAvatar.src = profile.avatar;
        if (UI.moments.coverImage && profile.coverImage) {
            UI.moments.coverImage.style.backgroundImage = `url(${profile.coverImage})`;
        }
        
    } catch (error) {
        console.error("加载用户资料失败:", error);
    }
}
/**
 * 【增强版】更新所有与当前用户相关的头像
 */
function updateAllMyAvatars(newAvatarSrc) {
    if (!AppState.userProfile) return;
    const myName = AppState.userProfile.name;
    // 1. 更新顶部和发布区的头像
    if (UI.moments.userAvatar) UI.moments.userAvatar.src = newAvatarSrc;
    // 2. 更新所有我发布的动态卡片上的头像
    document.querySelectorAll('.moment-card').forEach(card => {
        const authorNameEl = card.querySelector('.author-name');
        if (authorNameEl && authorNameEl.textContent === myName) {
            const avatarImg = card.querySelector('.author-avatar');
            if (avatarImg) avatarImg.src = newAvatarSrc;
        }
    });
}
/**
 * 【增强版】更新所有与当前用户相关的昵称
 */
function updateAllMyNames(newName) {
    if (!AppState.userProfile || !newName) return;
    const oldName = AppState.userProfile.name;
    // 1. 更新顶部和发布区的昵称
    if (UI.moments.userName) UI.moments.userName.textContent = newName;
    // 2. 更新所有我发布的动态卡片上的昵称
    document.querySelectorAll('.moment-card').forEach(card => {
        const authorNameEl = card.querySelector('.author-name');
        if (authorNameEl && authorNameEl.textContent === oldName) {
            authorNameEl.textContent = newName;
        }
    });
    
    // 【重要】更新点赞和评论里的旧名字
    document.querySelectorAll('.likes-list span, .comment-user').forEach(nameEl => {
        if (nameEl.textContent.includes(oldName)) {
            nameEl.textContent = nameEl.textContent.replace(new RegExp(oldName, 'g'), newName);
        }
    });
}
/**
 * 处理昵称修改
 */
async function handleNameChange() {
    if (!UI.moments.userName || !AppState.userProfile) return;
    const newName = UI.moments.userName.textContent.trim();
    if (!newName || newName === AppState.userProfile.name) return;
    const oldName = AppState.userProfile.name;
    // 实时更新UI
    updateAllMyNames(newName);
    
    // 更新数据库
    await db.userProfile.update(PROFILE_ID, { name: newName });
    await db.moments.where({ author: oldName }).modify({ author: newName });
    
    // 更新全局状态
    AppState.userProfile.name = newName;
}
/**
 * 处理头像/封面修改
 */
async function handleImageChange(event, type) {
    const file = event.target.files[0];
    if (!file) return;
    try {
        const base64String = await fileToBase64(file);
        if (type === 'avatar') {
            updateAllMyAvatars(base64String); // 实时更新UI
            await db.userProfile.update(PROFILE_ID, { avatar: base64String }); // 更新数据库
            await db.moments.where({ author: AppState.userProfile.name }).modify({ avatar: base64String });
            AppState.userProfile.avatar = base64String; // 更新全局状态
        } else if (type === 'cover') {
            if (UI.moments.coverImage) UI.moments.coverImage.style.backgroundImage = `url(${base64String})`;
            await db.userProfile.update(PROFILE_ID, { coverImage: base64String });
        }
    } catch (error) { console.error(error); }
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
    });
}

// === 新增：全局变量，记录当前选中的隐私值 ===
// === 新增：提醒谁看相关逻辑 ===
let remindSelection = new Set(); // 存储选中的 ID (例如 'char_1', 'group_2')
let remindSelectionNames = [];   // 存储选中的名字，用于显示
let currentPrivacySelection = new Set(['public']); 
let currentPrivacyNames = new Set(['公开']);       

/**
 * 初始化“提醒谁看”点击事件
 */
function initRemindLogic() {
    const triggerRow = document.getElementById('remind-option-trigger');
    if (triggerRow) {
        triggerRow.onclick = openRemindSheet;
    }
}

/**
 * 打开“提醒谁看”选择面板
 */
function openRemindSheet() {
    if (!document.getElementById('custom-remind-sheet')) {
        createRemindSheetHTML();
    }
    renderRemindList();
    
    const sheet = document.getElementById('custom-remind-sheet');
    sheet.style.display = 'flex';
    setTimeout(() => { sheet.classList.add('visible'); }, 10);
}

/**
 * 创建面板 HTML (复用 privacy 的样式，但增加“完成”按钮)
 */
function createRemindSheetHTML() {
    const html = `
    <div id="custom-remind-sheet" class="modal-overlay privacy-sheet-overlay">
        <div class="modal-card privacy-sheet-card">
            <div class="privacy-sheet-header" style="justify-content: space-between; display: flex; align-items: center;">
                <span style="flex:1"></span>
                <span style="flex:2; text-align:center; font-weight:600;">提醒谁看</span>
                <button id="remind-sheet-done" class="btn-text-link" style="flex:1; text-align:right; font-weight:600; color:var(--c-accent);">完成</button>
            </div>
            <div class="privacy-sheet-list" id="remind-sheet-list" style="max-height: 50vh; overflow-y: auto;">
                <!-- 列表内容 -->
            </div>
        </div>
    </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);

    // 绑定事件
    const sheet = document.getElementById('custom-remind-sheet');
    const doneBtn = document.getElementById('remind-sheet-done');

    // 关闭/完成处理
    const closeSheet = () => {
        sheet.classList.remove('visible');
        setTimeout(() => { sheet.style.display = 'none'; }, 300);
        updateRemindTextDisplay(); // 更新界面上的文字
    };

    doneBtn.onclick = closeSheet;
    
    // 点击遮罩层也可以关闭（相当于确认）
    sheet.onclick = (e) => {
        if (e.target === sheet) closeSheet();
    };
}

/**
 * 渲染联系人列表 (多选模式)
 */
function renderRemindList() {
    const listContainer = document.getElementById('remind-sheet-list');
    listContainer.innerHTML = ''; 

    // 1. 分组
    if (AppState.characterGroups && AppState.characterGroups.length > 0) {
        const validGroups = AppState.characterGroups.filter(g => g.id !== 'default');
       if (validGroups.length > 0) {
            renderSectionHeader(listContainer, '分组');
            validGroups.forEach(group => {
                
                // 👇 1. 修改这一行：加上 && !c.isGroup
                const memberCount = AppState.characterProfiles.filter(c => c.groupId === group.id && !c.isGroup).length;
                
                // 👇 2. 新增一个 if 判断：如果这个分组里有真实人物，才显示它
                if (memberCount > 0) {
                    renderRemindItem(listContainer, {
                        value: `group_${group.id}`,
                        label: group.name,
                        subLabel: `${memberCount} 位成员`, 
                        type: 'group'
                    });
                } 
            });
        }
    }
    // 2. 角色
    if (AppState.characterProfiles && AppState.characterProfiles.length > 0) {
        renderSectionHeader(listContainer, '联系人');
        // 👇 将原本的 forEach 替换，增加过滤
        AppState.characterProfiles.filter(c => !c.isGroup).forEach(char => {
            renderRemindItem(listContainer, {
                value: `char_${char.id}`,
                label: char.name,
                avatar: char.avatar || 'images/default-avatar.svg', 
                type: 'char'
            });
        });
    }
    
    // 如果没有任何数据
    if (listContainer.children.length === 0) {
        listContainer.innerHTML = `<div style="padding: 20px; text-align: center; color: #999;">暂无联系人</div>`;
    }
}

/**
 * 渲染单个多选条目
 */
function renderRemindItem(container, opt) {
    const item = document.createElement('div');
    // 检查是否已选中
    const isSelected = remindSelection.has(opt.value);
    
    item.className = `privacy-sheet-item type-${opt.type} ${isSelected ? 'selected' : ''}`;
    
    let iconHtml = '';
    if (opt.type === 'char') {
        iconHtml = `<img src="${opt.avatar}" alt="头像" onerror="this.src='images/default-avatar.svg'">`;
    } else {
        iconHtml = `<svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"></path></svg>`;
    }

    // ▼▼▼ 【修改】将 fill 颜色改为 #000000 (黑色) ▼▼▼
    const checkIcon = isSelected ? 
        `<svg viewBox="0 0 24 24" fill="#000000"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"></path></svg>` : 
        `<div style="width:20px; height:20px; border:2px solid #ddd; border-radius:50%;"></div>`; // 未选中是个灰色圈

    item.innerHTML = `
        <div class="item-icon-wrapper">${iconHtml}</div>
        <div class="item-content">
            <span class="item-label">${opt.label}</span>
            ${opt.subLabel ? `<span class="item-sub-label">${opt.subLabel}</span>` : ''}
        </div>
        <div class="item-check-custom" style="margin-left:auto;">${checkIcon}</div>
    `;

    // 点击切换选中状态
    item.onclick = () => {
        if (remindSelection.has(opt.value)) {
            remindSelection.delete(opt.value);
            // 移除名字
            const idx = remindSelectionNames.indexOf(opt.label);
            if (idx > -1) remindSelectionNames.splice(idx, 1);
            item.classList.remove('selected');
            item.querySelector('.item-check-custom').innerHTML = `<div style="width:20px; height:20px; border:2px solid #ddd; border-radius:50%;"></div>`;
        } else {
            remindSelection.add(opt.value);
            remindSelectionNames.push(opt.label);
            item.classList.add('selected');
            // ▼▼▼ 【修改】这里也改为黑色 ▼▼▼
            item.querySelector('.item-check-custom').innerHTML = `<svg viewBox="0 0 24 24" fill="#000000"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"></path></svg>`;
        }
    };

    container.appendChild(item);
}


/**
 * 更新页面上的“提醒谁看”文字
 */
function updateRemindTextDisplay() {
    const textSpan = document.getElementById('remind-status-text');
    if (!textSpan) return;

    if (remindSelection.size === 0) {
        textSpan.textContent = '';
        textSpan.style.color = '#bbb';
    } else {
        // 显示前两个名字，加人数
        let text = remindSelectionNames[0];
        if (remindSelection.size > 1) {
            text = `${remindSelectionNames[0]}等${remindSelection.size}人`;
        }
        textSpan.textContent = text;
        textSpan.style.color = '#000';
    }
}

let currentPrivacyValue = 'public'; 
let currentPrivacyLabel = '公开 (所有好友可见)';

/**
 * 初始化隐私选择器
 */
function loadPrivacyOptions() {
    const nativeSelect = document.getElementById('moment-privacy-select');
    if (!nativeSelect) return;

    // 1. 隐藏原生的 select 元素
    nativeSelect.style.display = 'none';

    // 2. 绑定点击事件
    const triggerRow = nativeSelect.closest('.moment-option-row');
    if (triggerRow) {
        triggerRow.removeEventListener('click', openPrivacySheet);
        triggerRow.addEventListener('click', openPrivacySheet);
    }
    
    // 初始化显示的文字
    updatePrivacyTextDisplay();
}

// ==========================================
// ▼▼▼ 核心修复：位置输入功能 (Clean Version) ▼▼▼
// ==========================================

/**
 * 处理点击“所在位置”
 */
function handleLocationClick() {
    const modal = document.getElementById('location-input-modal-overlay');
    const input = document.getElementById('location-modal-input');
    const displaySpan = document.getElementById('location-status-text');

    if (!modal) {
        console.error("❌ 错误：在 HTML 中找不到 id='location-input-modal-overlay' 的弹窗元素！");
        alert("错误：位置弹窗 HTML 缺失，请检查 index.html 底部。");
        return;
    }

    // 1. 强制提升层级 (解决点击没反应的问题)
    modal.style.zIndex = "99999"; 
    
    // 2. 回填已有文字
    const currentText = displaySpan ? displaySpan.innerText : '';
    if (input) {
        input.value = (currentText === '添加地点') ? '' : currentText;
    }

    // 3. 显示弹窗
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('visible'), 10);
    if (input) setTimeout(() => input.focus(), 100);

    // 4. 绑定按钮事件 (使用 onclick 覆盖，防止重复绑定)
    const cancelBtn = document.getElementById('location-modal-cancel');
    const confirmBtn = document.getElementById('location-modal-confirm');

    // 关闭函数
    const closeModal = () => {
        modal.classList.remove('visible');
        setTimeout(() => { modal.style.display = 'none'; }, 300);
    };

    if (cancelBtn) cancelBtn.onclick = closeModal;
    
    if (confirmBtn) {
        confirmBtn.onclick = () => {
            if (input && displaySpan) {
                const text = input.value.trim();
                if (text) {
                    displaySpan.innerText = text;
                    displaySpan.style.color = '#000';
                } else {
                    displaySpan.innerText = '添加地点';
                    displaySpan.style.color = '#bbb';
                }
            }
            closeModal();
        };
    }

    // 点击遮罩关闭
    modal.onclick = (e) => {
        if (e.target === modal) closeModal();
    };
}

/**
 * 初始化位置逻辑
 * 在 openCreateModal 中调用
 */
function initLocationLogic() {
    const triggerRow = document.getElementById('location-option-trigger');
    
    if (triggerRow) {
        // 使用 onclick 强制覆盖，确保一定能触发
        triggerRow.onclick = handleLocationClick;
        console.log("✅ 位置按钮点击事件已绑定");
    } else {
        console.warn("⚠️ 未找到 id='location-option-trigger' 的行");
    }
}
// ==========================================
// ▲▲▲ 位置功能结束 ▲▲▲
// ==========================================


/**
 * 打开自定义隐私选择面板
 */
function openPrivacySheet() {
    if (!document.getElementById('custom-privacy-sheet')) {
        createPrivacySheetHTML();
    }
    renderPrivacyList();
    const sheet = document.getElementById('custom-privacy-sheet');
    sheet.style.display = 'flex';
    setTimeout(() => { sheet.classList.add('visible'); }, 10);
}


/**
 * 创建隐私面板 HTML (多选模式)
 */
function createPrivacySheetHTML() {
    const html = `
    <div id="custom-privacy-sheet" class="modal-overlay privacy-sheet-overlay">
        <div class="modal-card privacy-sheet-card">
            <div class="privacy-sheet-header" style="justify-content: space-between; display: flex; align-items: center;">
                <span style="flex:1"></span>
                <span style="flex:2; text-align:center; font-weight:600;">谁可以看</span>
                <button id="privacy-sheet-done" class="btn-text-link" style="flex:1; text-align:right; font-weight:600; color:var(--c-accent);">完成</button>
            </div>
            <div class="privacy-sheet-list" id="privacy-sheet-list"></div>
        </div>
    </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);

    // 绑定事件
    const sheet = document.getElementById('custom-privacy-sheet');
    const doneBtn = document.getElementById('privacy-sheet-done');

    // 关闭/完成处理
    const closeSheet = () => {
        // 如果用户一个都没选，就强制帮他选上“公开”
        if (currentPrivacySelection.size === 0) {
            currentPrivacySelection.add('public');
            currentPrivacyNames.add('公开');
        }
        sheet.classList.remove('visible');
        setTimeout(() => { sheet.style.display = 'none'; }, 300);
        updatePrivacyTextDisplay(); // 根据用户的多选结果，更新主界面上的文字
    };

    doneBtn.onclick = closeSheet;
    
    // 点击遮罩层也相当于点击“完成”
    sheet.onclick = (e) => {
        if (e.target === sheet) closeSheet();
    };
}

/**
 * 渲染隐私选项列表
 */
function renderPrivacyList() {
    const listContainer = document.getElementById('privacy-sheet-list');
    listContainer.innerHTML = ''; 

    // 通用部分
    renderPrivacyItem(listContainer, { value: 'public', label: '公开', subLabel: '所有好友可见', type: 'system', icon: 'globe' });

    // 分组部分
    if (AppState.characterGroups && AppState.characterGroups.length > 0) {
        const validGroups = AppState.characterGroups.filter(g => g.id !== 'default');
       if (validGroups.length > 0) {
            renderSectionHeader(listContainer, '我的分组');
            validGroups.forEach(group => {
                // 👇 1. 修改这里：加上 && !char.isGroup
                const memberCount = AppState.characterProfiles.filter(
                    char => char.groupId === group.id && !char.isGroup
                ).length;
                // 👇 2. 新增一个 if 判断：如果这个分组里有真实人物，才显示它
                if (memberCount > 0) {
                    renderPrivacyItem(listContainer, {
                        value: `group_${group.id}`,
                        label: group.name,
                        subLabel: `${memberCount} 位成员`,
                        type: 'group',
                        icon: 'folder'
                    });
                }
});

        }
    }
    // 角色部分
    if (AppState.characterProfiles && AppState.characterProfiles.length > 0) {
        renderSectionHeader(listContainer, '特定角色');
        // 👇 将原本的 forEach 替换，增加过滤
        AppState.characterProfiles.filter(c => !c.isGroup).forEach(char => {
            renderPrivacyItem(listContainer, {
                value: `char_${char.id}`,
                label: char.name,
                avatar: char.avatar || 'images/default-avatar.svg', 
                type: 'char'
            });
        });
    }
}

function renderPrivacyItem(container, opt) {
    const item = document.createElement('div');
    // 检查当前项是否在我们的多选Set里
    const isSelected = currentPrivacySelection.has(opt.value);
    
    item.className = `privacy-sheet-item type-${opt.type} ${isSelected ? 'selected' : ''}`;
    
    let iconHtml = '';
    if (opt.type === 'char' && opt.avatar) {
        iconHtml = `<img src="${opt.avatar}" alt="头像" onerror="this.src='images/default-avatar.svg'">`;
    } else if (opt.type === 'group') {
        iconHtml = `<svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"></path></svg>`;
    } else { // 'public'
        iconHtml = `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"></path></svg>`;
    }
    
    // 多选的勾选图标 (和“提醒谁看”用一样的)
    const checkIcon = isSelected ? 
        `<svg viewBox="0 0 24 24" fill="#000000"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"></path></svg>` : 
        `<div style="width:20px; height:20px; border:2px solid #ddd; border-radius:50%;"></div>`;

    item.innerHTML = `
        <div class="item-icon-wrapper">${iconHtml}</div>
        <div class="item-content">
            <span class="item-label">${opt.label}</span>
            ${opt.subLabel ? `<span class="item-sub-label">${opt.subLabel}</span>` : ''}
        </div>
        <div class="item-check-custom" style="margin-left:auto;">${checkIcon}</div>
    `;

item.onclick = () => {
    // --- 第一步：根据点击更新数据 ---

    if (opt.value === 'public') {
        // 如果点击的是“公开”，则清空所有，只保留“公开”
        currentPrivacySelection.clear();
        currentPrivacyNames.clear();
        currentPrivacySelection.add('public');
        currentPrivacyNames.add('公开');
    } else {
        // 如果点击的是其他选项

        // 1. 先检查并移除“公开”
        if (currentPrivacySelection.has('public')) {
            currentPrivacySelection.delete('public');
            currentPrivacyNames.delete('公开');
        }

        // 2. 然后处理当前点击项的选中/取消选中
        if (currentPrivacySelection.has(opt.value)) {
            // 如果已经选中了，就取消
            currentPrivacySelection.delete(opt.value);
            currentPrivacyNames.delete(opt.label);
        } else {
            // 如果没选中，就添加
            currentPrivacySelection.add(opt.value);
            currentPrivacyNames.add(opt.label);
        }
    }

    renderPrivacyList();
};


    container.appendChild(item);
}


function renderSectionHeader(container, title) {
    const header = document.createElement('div');
    header.className = 'privacy-section-header';
    header.textContent = title;
    container.appendChild(header);
}

function updatePrivacyTextDisplay() {
    const textSpan = document.getElementById('privacy-status-text');
    if (!textSpan) return;

    if (currentPrivacySelection.size === 0) {
        // 如果啥也没选，默认显示公开
        textSpan.textContent = '公开';
        return;
    }
    
    // 如果只选了“公开”
    if (currentPrivacySelection.size === 1 && currentPrivacySelection.has('public')) {
        textSpan.textContent = '公开';
        return;
    }

    // 如果选了多个，但包含“公开”，则“公开”优先
    if (currentPrivacySelection.has('public')) {
        textSpan.textContent = '公开';
        return;
    }

    // 其他多选情况，显示 "xxx等x人可见"
    const namesArray = Array.from(currentPrivacyNames);
    let text = namesArray[0];
    if (namesArray.length > 1) {
        text = `${namesArray[0]}等${namesArray.length}人`;
    }
    textSpan.textContent = text;
}


/**
 * 打开创建动态弹窗 (入口函数)
 */
function openCreateModal() {
    const modal = document.getElementById('create-moment-modal');
    if (modal) {
        if (modal._createMomentCloseTimer) {
            clearTimeout(modal._createMomentCloseTimer);
            modal._createMomentCloseTimer = null;
        }
        if (modal._createMomentCloseHandler) {
            modal.removeEventListener('transitionend', modal._createMomentCloseHandler);
            modal._createMomentCloseHandler = null;
        }
        modal.style.display = 'block';
        modal.offsetHeight;
        loadPrivacyOptions(); // 刷新隐私
        initMediaLogic();     // 刷新图片
        initLocationLogic();  
        initRemindLogic();  
        modal.classList.add('active');
    }
}
function closeCreateModal() {
    const modal = document.getElementById('create-moment-modal');
    if (modal) {
        if (modal._createMomentCloseTimer) {
            clearTimeout(modal._createMomentCloseTimer);
            modal._createMomentCloseTimer = null;
        }
        if (modal._createMomentCloseHandler) {
            modal.removeEventListener('transitionend', modal._createMomentCloseHandler);
            modal._createMomentCloseHandler = null;
        }
        modal._createMomentCloseHandler = (event) => {
            if (event.target !== modal || event.propertyName !== 'transform') return;
            clearTimeout(modal._createMomentCloseTimer);
            modal._createMomentCloseTimer = null;
            modal.removeEventListener('transitionend', modal._createMomentCloseHandler);
            modal._createMomentCloseHandler = null;
            if (!modal.classList.contains('active')) {
                modal.style.display = 'none';
            }
        };
        modal.addEventListener('transitionend', modal._createMomentCloseHandler);
        modal.classList.remove('active');
        modal._createMomentCloseTimer = setTimeout(() => {
            clearTimeout(modal._createMomentCloseTimer);
            if (modal._createMomentCloseHandler) {
                modal.removeEventListener('transitionend', modal._createMomentCloseHandler);
                modal._createMomentCloseHandler = null;
            }
            modal._createMomentCloseTimer = null;
            if (!modal.classList.contains('active')) {
                modal.style.display = 'none';
            }
        }, 450);
    }
}
// === 图片上传逻辑 ===
function initMediaLogic() {
    const addBtn = document.getElementById('add-moment-image-btn');
    if (!addBtn) return;
    addBtn.onclick = openMediaModal; // 使用 onclick 防止重复

    if (!document.getElementById('hidden-moment-file-input')) {
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'hidden-moment-file-input';
        input.accept = 'image/*';
        input.style.display = 'none';
        input.addEventListener('change', handleRealFileSelect);
        document.body.appendChild(input);
    }
}

function openMediaModal() {
    if (!document.getElementById('media-select-modal')) {
        // 创建媒体选择弹窗
        const html = `
        <div id="media-select-modal" class="media-select-overlay">
            <div class="media-select-card">
                <h3>添加图片</h3>
                <button class="btn-select-album" id="btn-open-album">
                    <svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
                    从相册选择
                </button>
                          <div class="simulated-input-row">
                    <input type="text" id="sim-img-text" placeholder="或输入文字生成图片">
                    <button id="btn-add-sim">添加</button>
                </div>
                <button class="btn-select-album" id="btn-open-music" style="margin-top: 10px; background-color: #fcfcfc; color: #333; border: 1px solid #eee;">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
                    从曲库选择音乐
                </button>
                <button class="btn-media-close" id="btn-media-close">取消</button>
            </div>
        </div>`;

        document.body.insertAdjacentHTML('beforeend', html);

        const modal = document.getElementById('media-select-modal');
        const albumBtn = document.getElementById('btn-open-album');
        const addSimBtn = document.getElementById('btn-add-sim');
        const closeBtn = document.getElementById('btn-media-close');
        const simInput = document.getElementById('sim-img-text');
        const musicBtn = document.getElementById('btn-open-music');

        const closeModal = () => {

            modal.classList.remove('visible');
            setTimeout(() => { modal.style.display = 'none'; }, 200);
            simInput.value = '';
        };

        albumBtn.onclick = () => {
            document.getElementById('hidden-moment-file-input').click();
            closeModal();
        };

        addSimBtn.onclick = () => {
            const text = simInput.value.trim() || '[图片]';
            addMediaToGrid(text, true);
            closeModal();
        };
        
        if (musicBtn) {
            musicBtn.onclick = () => {
                closeModal();
                openMusicSelectModalForMoments();
            };
        }

        closeBtn.onclick = closeModal;

        modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    }

    const modal = document.getElementById('media-select-modal');
    modal.style.display = 'flex';
    setTimeout(() => { 
        modal.classList.add('visible'); 
        const input = document.getElementById('sim-img-text');
        if(input) input.focus();
    }, 10);
}
function openMusicSelectModalForMoments() {
    if (!document.getElementById('moment-music-select-modal')) {
        const html = `
        <div id="moment-music-select-modal" class="media-select-overlay">
            <div class="media-select-card" style="max-height: 70vh; display: flex; flex-direction: column;">
                <h3>选择一首音乐</h3>
                <div id="moment-music-list" style="overflow-y: auto; flex: 1; margin-top: 10px; display: flex; flex-direction: column; gap: 8px;"></div>
                <button class="btn-media-close" id="btn-music-close" style="margin-top: 15px;">取消</button>
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
        
        const modal = document.getElementById('moment-music-select-modal');
        const closeBtn = document.getElementById('btn-music-close');
        const closeModal = () => {
            modal.classList.remove('visible');
            setTimeout(() => { modal.style.display = 'none'; }, 200);
        };
        closeBtn.onclick = closeModal;
        modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    }
    const modal = document.getElementById('moment-music-select-modal');
    const listContainer = document.getElementById('moment-music-list');
    listContainer.innerHTML = '';
    const playlist = (window.MusicPlayer && window.MusicPlayer.globalPlaylist) ? window.MusicPlayer.globalPlaylist : [];
    
    if (playlist.length === 0) {
        listContainer.innerHTML = '<div style="text-align:center; padding: 20px; color:#999; font-size:14px;">曲库里还没有音乐哦</div>';
    } else {
        playlist.forEach(song => {
            const item = document.createElement('div');
            const defaultCover = "https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=100&auto=format&fit=crop&grayscale";
            item.style.cssText = "display: flex; align-items: center; padding: 8px; border-radius: 8px; background: #f9f9f9; cursor: pointer;";
            item.innerHTML = `
                <img src="${song.cover || defaultCover}" style="width: 40px; height: 40px; border-radius: 6px; object-fit: cover; margin-right: 12px;">
                <div style="flex: 1; overflow: hidden;">
                    <div style="font-size: 14px; color: #333; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${song.title}</div>
                    <div style="font-size: 12px; color: #999; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${song.artist}</div>
                </div>
            `;
            item.onclick = () => {
                addMediaToGrid(null, false, true, song);
                modal.classList.remove('visible');
                setTimeout(() => { modal.style.display = 'none'; }, 200);
            };
            listContainer.appendChild(item);
        });
    }
    modal.style.display = 'flex';
    setTimeout(() => { modal.classList.add('visible'); }, 10);
}
async function handleRealFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const base64 = await fileToBase64(file);
        addMediaToGrid(base64, false);
    } catch (err) { console.error(err); alert("图片读取失败"); }
    e.target.value = '';
}
function addMediaToGrid(content, isSimulated, isMusic = false, songData = null) {
    const grid = document.getElementById('moment-media-grid');
    const addBtn = document.getElementById('add-moment-image-btn');
    if (!grid || !addBtn) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'media-item-wrapper';

    if (isMusic) {
        const safeSongData = JSON.stringify(songData).replace(/'/g, "&apos;");
        wrapper.innerHTML = `
            <div class="media-item simulated-img" data-type="music" data-song='${safeSongData}' style="background:#000; color:#fff;">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" style="margin-bottom:4px;"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg><br>
                <span style="font-size:12px; display:block; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; width:100%; padding:0 4px;">${songData.title}</span>
            </div>
            <div class="delete-media-btn">×</div>`;
    } else if (isSimulated) {
        wrapper.innerHTML = `<div class="media-item simulated-img" data-type="simulated">${content}</div><div class="delete-media-btn">×</div>`;
    } else {
        wrapper.innerHTML = `<img src="${content}" class="media-item" data-type="real"><div class="delete-media-btn">×</div>`;
    }

    wrapper.querySelector('.delete-media-btn').onclick = () => wrapper.remove();
    grid.insertBefore(wrapper, addBtn);
}


/**
 * 初始化动态模块
 */
async function init() {
    // 【关键】先加载用户资料，再加载动态
    await loadAndCacheProfile();
    await loadAndRenderMoments();
    // 绑定页面顶部的个人资料编辑事件
    if (UI.moments.userAvatarInput) UI.moments.userAvatarInput.addEventListener('change', (e) => handleImageChange(e, 'avatar'));
    if (UI.moments.coverImageInput) UI.moments.coverImageInput.addEventListener('change', (e) => handleImageChange(e, 'cover'));
    if (UI.moments.userName) UI.moments.userName.addEventListener('blur', handleNameChange);
    // 绑定发布动态相关事件
  const cameraBtn = document.querySelector('.moments-header__actions');
    if (cameraBtn) {
        // 当用户点击相机图标（即明确要新建）时：
        cameraBtn.addEventListener('click', () => {
            // 1. 先调用我们的“清洁工”，把弹窗擦干净
            resetCreateModalState(); 
            // 2. 然后再打开这个焕然一新的弹窗
            openCreateModal();
        });
    }
    const cancelBtn = document.getElementById('close-moment-modal-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', closeCreateModal);
    const postBtn = document.getElementById('post-moment-btn');
    if (postBtn) postBtn.onclick = handlePostMoment;
    
    console.log('✅ Moments 模块 (含数据持久化) 已初始化.');
}
export async function triggerAiPostMoment(charId, checkCooldown = true) {
    // 1. 获取角色信息 (用于头像和名字)
    const char = AppState.characterProfiles.find(c => c.id === charId);
    if (!char) return;
    if (checkCooldown && getSleepState(char).sleeping) return;

    // 【新增：安全兜底机制】如果是用户手动强制测试，清理可能因网络超时遗留的死锁
    if (!checkCooldown && char.isGeneratingMoment) {
        char.isGeneratingMoment = false;
    }
    // A. 防并发锁（必须保留！）：无论手动还是自动，只要正在写，就不能被打断，防止重复

    // 【死锁自愈】锁被卡住超过3分钟(生成早该结束了)，或没有加锁时间戳(异常遗留)，判定为死锁并强制解锁
    if (char.isGeneratingMoment && (!char._momentLockTime || Date.now() - char._momentLockTime > 3 * 60 * 1000)) {
        console.warn(`[AI动态] ${char.name} 的生成锁疑似卡死，已强制解锁`);
        char.isGeneratingMoment = false;
    }

    if (char.isGeneratingMoment) {
        showDynamicIsland('正在生成中，请耐心等待', 'warning');
        console.log(`[AI动态] ${char.name} 正在生成中，跳过本次请求`);
        return; 
    }

    // B. 频率控制（根据参数决定是否检查）：只有 checkCooldown 为 true 时才检查时间
    // 手动点击重生成、或者聊天触发时，我们会传入 false，从而跳过这个检查
    if (checkCooldown) {
        const freqSetting = char.momentsFrequency || 'low'; 
        const freqMap = { 'high': 30, 'medium': 40, 'low': 60 }; 
        const minInterval = (freqMap[freqSetting] || 60) * 60 * 1000; 
        // C. 检查上一条动态的时间
        try {
            const lastMoment = await db.moments.where({ characterId: charId }).reverse().first();
            if (lastMoment) {
                const timePassed = Date.now() - lastMoment.id; // id是时间戳
                // 【新增：安全兜底机制】防御未来错误时间戳，timePassed 必须大于等于0
                if (timePassed >= 0 && timePassed < minInterval) {
                    console.log(`[AI动态] 冷却中(自动模式)。设置:${freqSetting}。需等待${minInterval/60000}分`);
                    return; // 时间没到，直接结束
                }
            }
        } catch (e) { console.error("冷却检查失败", e); }
    }
    // D. 加锁：标记为正在生成
    char.isGeneratingMoment = true;
    char._momentLockTime = Date.now();
    showDynamicIsland('正在生成AI动态...', 'loading');
    try {
        // 2. 让大脑思考
        const aiResult = await generateCharacterMoment(charId);
        
        if (!aiResult || !aiResult.content) {
            showDynamicIsland('AI灵感枯竭了', 'error');
            return;
        }

        // 3. 组装数据
        const momentImageGenSettings = await getImageGenSettings();
        const momentImageGenAllowed = Boolean(momentImageGenSettings.authorizedScenes?.moments);
        const momentImageGenMode = getCharacterImageGenMode(momentImageGenSettings, char, 'moments');
        const preparedMedia = [];
        for (const mediaItem of (aiResult.media || [])) {
            if (mediaItem?.type === 'music') {
                preparedMedia.push(mediaItem);
                continue;
            }
            
            // ▼▼▼ 【修复】：提取完整的句子用于展示，提取关键词用于搜图 ▼▼▼
            const promptText = parseMomentImagePrompt(mediaItem?.content || mediaItem?.prompt || '');
            const keywordsText = mediaItem?.keywords || promptText; // 如果有关键词就用关键词，没有才退回到整句
            const generationOptions = {
                keywords: keywordsText,
                naiTags: mediaItem?.naiTags,
                includeCharacter: mediaItem?.includeCharacter
            };

            if (mediaItem?.type === 'image' && mediaItem.isSticker && momentImageGenAllowed && momentImageGenMode === 'gen_only') {
                preparedMedia.push(createMomentImageGenerationPlaceholder(promptText, char.id, generationOptions));
                continue;
            }
            if (mediaItem?.type === 'image') {
                preparedMedia.push({ ...mediaItem, content: promptText });
                continue;
            }
             let galleryImageUrl = null;
            if (momentImageGenMode !== 'gen_only') {
                // 【修复】：优先使用 AI 提取的精确 keywords 去相册搜图，如果没有再退回长描述
                const searchKeyword = mediaItem.keywords || promptText;
                galleryImageUrl = await findBestImageForDescription(char.id, searchKeyword);
            }
            if (galleryImageUrl) {
                preparedMedia.push({
                    type: 'image',
                    src: galleryImageUrl,
                    content: promptText, // 展示依然用完整的画面描述
                    ...generationOptions,
                    isSticker: false,
                    source: 'gallery'
                });
                continue;
            }
            if (momentImageGenAllowed && momentImageGenMode !== 'match_only') {
                preparedMedia.push(createMomentImageGenerationPlaceholder(promptText, char.id, generationOptions));
                continue;
            }
            preparedMedia.push({
                ...mediaItem,
                type: 'text',
                content: `[配图: ${promptText}]`
            });
        }
    const newMoment = {
        id: Date.now(),
        author: char.name,        // 作者是角色名
        characterId: char.id,
        avatar: char.avatar,      // 头像是角色头像
        content: aiResult.content,
        translation: aiResult.translation || '',
        media: preparedMedia,
        likes: [],
        comments: [],
        forwards: 0,
        location: aiResult.location || '',
         visibleTo: ['user_only']      // 默认公开
    };

    // 4. 存库
    await saveMoment(newMoment);

    // 5. 渲染到页面 (插入到最前面)
    const momentsContainer = document.querySelector('.moments-content');
    // 如果当前在动态页，才需要立即插入 DOM
    if (momentsContainer) {
        // 注意：朋友圈通常新发的在上面，或者根据你的 createMomentElement 逻辑
        // 这里我们简单粗暴重新加载一次，或者手动插入
        const card = createMomentElement(newMoment);
        // 找到输入框区域下面的第一条动态插入，或者直接 prepend 到列表容器
        // 这里假设 profileSection 是第一个元素
        const profileSection = document.querySelector('.moments-profile');
        if (profileSection) {
            profileSection.after(card);
        } else {
            momentsContainer.prepend(card);
        }
        bindCardEvents(card);
    }

    (preparedMedia || []).forEach((mediaItem, index) => {
        if (mediaItem?.type === 'image_generating' && mediaItem.imageGenerationPayload) {
            runMomentImageGeneration(newMoment.id, index, mediaItem.imageGenerationPayload);
        }
    });
    
    const momentsPage = document.getElementById('page-dynamics');
const isMomentsPageVisible = momentsPage && momentsPage.classList.contains('active');
if (isMomentsPageVisible) {
    // 如果在动态页，就显示灵动岛提示
    showDynamicIsland('AI动态发布成功！', 'success');
} else {
    // 如果不在动态页，就显示顶部弹窗通知
    notification.show(
        char.name,              // 标题
        '发布了一条新动态',       // 内容
        char.avatar,            // 头像
        'page-dynamics'         // 跳转目标页
    );
}
          // 6. 启动NPC互动剧场
         if (char.relatedNpcs && char.relatedNpcs.length > 0) {
            setTimeout(() => {
                triggerNpcMomentInteraction(newMoment, char.relatedNpcs, charId); 
            }, 1000);
        }
    } catch (error) {
        console.error('[AI动态] 生成过程发生异常:', error);
        showDynamicIsland('生成过程出错，请重试', 'error');
    } finally {
        // 无论成功失败，必须无条件解锁，防止角色被永远锁死
        char.isGeneratingMoment = false; 
    }
}

export const momentsModule = {
    init,
    triggerAiPostMoment,
    triggerAiCommentOnLatestUserMoment,
    getLatestUserMomentForCharacter
};

// 【新增】将需要调试的函数挂载到 window 对象，方便在控制台调用
window.momentsModule = momentsModule;
window.addCommentToDB = addCommentToDB; // 模拟函数需要这个
window.manageAiMomentInteraction = manageAiMomentInteraction; // 模拟函数需要这个
window.manageMomentInteraction = manageMomentInteraction; // 模拟函数需要这个



/**
 * 【全新剧本杀模式】评论会话主持人
 * 一次性收集所有信息，让每个AI独立决策，合并API请求。
 * @param {number} momentId - 动态ID
 * @param {object} initialMomentData - 触发时的动态数据
 * @param {object} initialComment - 触发本次互动的评论
 */
async function manageMomentInteraction(momentId, initialMomentData, initialComment) {
    console.log(`[剧本杀主持人] 开始主持动态 ${momentId} 的评论区互动...`);

    // 1. 确定所有在场的AI参与者 (这部分逻辑不变)
        const visibleTo = new Set(initialMomentData.visibleTo || ['public']);
    const isPublic = visibleTo.has('public');
    let allVisibleCharIds = [];
    if (isPublic) {
        // 👇 增加 .filter(c => !c.isGroup)
        allVisibleCharIds = AppState.characterProfiles.filter(c => !c.isGroup).map(c => c.id);
    } else {
        const visibleGroupIds = Array.from(visibleTo).filter(v => v.startsWith('group_')).map(v => v.replace('group_', ''));
        const visibleCharIds = Array.from(visibleTo).filter(v => v.startsWith('char_')).map(v => v.replace('char_', ''));
        const groupMemberIds = visibleGroupIds.flatMap(groupId => 
            // 👇 增加 && !c.isGroup 的判断
            AppState.characterProfiles.filter(c => c.groupId === groupId && !c.isGroup).map(c => c.id)
        );
        allVisibleCharIds = [...new Set([...visibleCharIds, ...groupMemberIds])];
    }
    const participants = allVisibleCharIds.filter(id => {
        const char = AppState.characterProfiles.find(c => c.id === id);
        return char && char.name !== initialComment.user;
    });

    if (participants.length === 0) {
        console.log('[剧本杀主持人] 没有其他AI参与者，互动结束。');
        return;
    }
    console.log('[剧本杀主持人] 在场参与者:', participants.map(id => AppState.characterProfiles.find(c => c.id === id)?.name));

    const batchParticipants = participants.map(id => ({ type: 'character', id }));
    const cleanupLoading = showMomentBatchLoading(momentId, batchParticipants, '正在输入...');
    try {
        const decisions = await generateMomentBatchOrFallback({
            kind: 'reply',
            momentData: initialMomentData,
            participants: batchParticipants,
            contextMode: 'group',
            audienceIds: participants,
            userReplyComment: initialComment
        });
        await processReplyBatchDecisions(
            decisions,
            batchParticipants,
            momentId,
            initialComment.user
        );
    } finally {
        cleanupLoading();
    }

    console.log('[剧本杀主持人] 本次评论区互动主持完毕。');
}

/**
 * 【升级版】处理并显示AI（包括NPC）的回复
 * @param {string} aiReplyText - AI生成的回复内容
 * @param {string|null} charId - 回复者的ID (如果是主角AI)
 * @param {number} momentId - 动态ID
 * @param {string} replyToUserName - 回复目标的名字
 * @param {object|null} npcData - 回复者的信息 (如果是NPC)
 * @returns {Promise<object|null>} 成功则返回更新后的moment对象，失败返回null
 */
async function processAiReply(aiReplyText, charId, momentId, replyToUserName, npcData = null, translation = '', batchId = null) {
    if (!aiReplyText) {
        console.log(`[AI回复处理] 内容为空，不执行任何操作。`);
        return null;
    }

    // 决定回复者的身份
    let commenter, commenterName, commenterAvatar;
    if (npcData) {
        // 这是NPC
        commenterName = npcData.name;
        // NPC没有独立头像，我们给个通用标识或用主角头像
        const author = await db.characterProfiles.get(charId); // 找到NPC所属的主角
        commenterAvatar = author ? author.avatar : DEFAULT_AVATAR_SRC;
        console.log(`[AI回复处理] 识别到回复者为NPC: ${commenterName}`);
    } else {
        // 这是主角AI
        commenter = AppState.characterProfiles.find(c => c.id === charId);
        if (!commenter) return null;
        commenterName = commenter.name;
        commenterAvatar = commenter.avatar;
         console.log(`[AI回复处理] 识别到回复者为主角: ${commenterName}`);
    }
    
    const card = document.querySelector(`.moment-card[data-id="${momentId}"]`);
    if (!card) return null;
    const aiReplyObject = {
        user: commenterName,
        content: aiReplyText,
        replyToUser: replyToUserName,
        translation: translation || '',
        batchId: batchId || null
    };

    // 存库并更新UI
    try {
        const moment = await db.moments.get(momentId);
        if (moment) {
            moment.comments.push(aiReplyObject);
            await db.moments.put(moment);
            console.log(`[数据库] ${commenterName} 的回复已保存。`);

            // 更新UI
            const commentList = card.querySelector('.comment-list');
            const commentCountSpan = card.querySelector('.js-toggle-comment .count');
             const aiReplyItem = document.createElement('div');
            aiReplyItem.className = 'comment-item';
            aiReplyItem.setAttribute('data-user', aiReplyObject.user);
            const transSuffix = aiReplyObject.translation ? `<span class="comment-translation" style="display:table;margin-top:5px;padding:5px 10px;background:#fff;color:#888;font-size:11px;line-height:1.5;border-radius:8px;">${aiReplyObject.translation}</span>` : '';
            if (aiReplyObject.replyToUser) {
                aiReplyItem.innerHTML = `<span class="comment-user">${aiReplyObject.user}</span> <span class="reply-indicator">回复</span> <span class="comment-user">${aiReplyObject.replyToUser}:</span><span class="comment-content"> ${aiReplyObject.content}</span>${transSuffix}`;
            } else {
                 aiReplyItem.innerHTML = `<span class="comment-user">${aiReplyObject.user}:</span><span class="comment-content"> ${aiReplyObject.content}</span>${transSuffix}`;
            }
            commentList.appendChild(aiReplyItem);
            
            let count = parseInt(commentCountSpan.innerText) || 0;
            commentCountSpan.innerText = count + 1;
            
            return moment; 
        }
        return null;
    } catch (error) {
        console.error(`❌ 保存AI回复到数据库失败:`, error);
        return null;
    }
}

/**
 * ✨【新增】处理评论长按菜单
 */
function handleCommentLongPress(commentElement, momentId, commentIndex) {
    // 震动反馈 (如果手机支持)
    if (navigator.vibrate) navigator.vibrate(50);
   // 获取评论信息
    const userName = commentElement.dataset.user;
    if (!userName) return;
    const isMe = userName === AppState.userProfile.name;
    
    let realName = userName;
    if (userName.includes('(失败)')) {
        realName = userName.replace('(失败)', '').trim();
    }
    // 检查是否为AI (在角色列表里能找到名字)
    let aiChar = AppState.characterProfiles.find(c => c.name === realName);
    
    // 检查是否为 NPC (在相关角色列表里查找)
    if (!aiChar) {
        for (const c of AppState.characterProfiles) {
            if (c.relatedNpcs && c.relatedNpcs.some(n => n.name === realName)) {
                aiChar = c;
                break;
            }
        }
    }
    const isAi = !!aiChar;
    // 如果既不是我，也不是AI，就不弹菜单 (比如其他用户的评论)
    if (!isMe && !isAi) return;
    // 创建菜单 HTML
    const overlayId = 'comment-action-overlay';
    if (document.getElementById(overlayId)) return; // 防止重复

    const overlay = document.createElement('div');
    overlay.id = overlayId;
    overlay.className = 'moment-action-menu-overlay'; // 复用遮罩样式
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';

    // 菜单卡片内容
    let buttonsHtml = '';
    
    if (isAi) {
        // AI: 删除 + 重回
        buttonsHtml = `
            <div class="comment-menu-btn js-regen">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                重回
            </div>
            <div class="comment-menu-btn js-del danger">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                删除
            </div>
        `;
    } else {
        // 我自己: 只有删除
        buttonsHtml = `
            <div class="comment-menu-btn js-del danger">删除</div>
        `;
    }

    const menuCard = document.createElement('div');
    menuCard.className = 'comment-action-card'; // 新样式类
    menuCard.innerHTML = `<div class="comment-menu-title">操作</div>${buttonsHtml}`;

    overlay.appendChild(menuCard);
    document.body.appendChild(overlay);

    // 关闭函数
    const close = () => overlay.remove();
    overlay.onclick = (e) => { if(e.target === overlay) close(); };

    // 绑定事件
    const btnDel = menuCard.querySelector('.js-del');
    const btnRegen = menuCard.querySelector('.js-regen');
    // --- 删除逻辑 ---
    if (btnDel) {
        btnDel.onclick = async () => {
            if (confirm('确定删除这条评论吗？')) {
                await deleteComment(momentId, commentIndex);
                commentElement.remove();
                
                // 【修复】：只有当它是一条真实存在的评论（index 不是 NaN）时，才去减去计数
                if (!isNaN(commentIndex)) {
                    const card = document.querySelector(`.moment-card[data-id="${momentId}"]`);
                    if(card) {
                        const countSpan = card.querySelector('.js-toggle-comment .count');
                        let c = parseInt(countSpan.innerText) || 0;
                        countSpan.innerText = Math.max(0, c - 1);
                    }
                }
                close();
            }
        };
    }
    if (btnRegen && aiChar) {
        btnRegen.onclick = async () => {
            if (confirm('要删除并让AI重新回答吗？(同一批生成的评论会一起重写)')) {
                close(); // 先关菜单

                // 1. 读取动态，找到被点击评论及其所属的“同批次”标记
                const momentData = await db.moments.get(momentId);
                if (!momentData) return;
                const clickedComment = momentData.comments?.[commentIndex];
                const targetBatchId = clickedComment?.batchId || null;

                // 2. 收集这一批（同一次生成）里的所有AI评论
                let siblingComments = [];
                if (targetBatchId) {
                    siblingComments = (momentData.comments || []).filter(c => c.batchId === targetBatchId);
                } else if (clickedComment) {
                    siblingComments = [clickedComment];
                }

                // 3. 根据这些评论的发言人，重建参与者名单
                const regenParticipants = [];
                const seenSpeakers = new Set();
                siblingComments.forEach(c => {
                    if (seenSpeakers.has(c.user)) return;
                    seenSpeakers.add(c.user);
                    const p = buildParticipantFromSpeaker(c.user);
                    if (p) regenParticipants.push(p);
                });

                if (regenParticipants.length === 0) {
                    showDynamicIsland('无法识别评论作者，重写失败', 'error');
                    return;
                }

                // 4. 从数据库删除这一批旧评论，并刷新评论区显示
                if (targetBatchId) {
                    momentData.comments = (momentData.comments || []).filter(c => c.batchId !== targetBatchId);
                } else if (!isNaN(commentIndex)) {
                    momentData.comments.splice(commentIndex, 1);
                }
                await db.moments.put(momentData);
                const card = document.querySelector(`.moment-card[data-id="${momentId}"]`);
                renderMomentCommentList(card, momentData.comments);

                // 5. 走批量引擎，整批重新生成
                const regenAudience = regenParticipants.map(p => getBatchParticipantCharId(p)).filter(Boolean);
                const cleanupRegenLoading = showMomentBatchLoading(momentId, regenParticipants, '正在重写...');
                try {
                    const decisions = await generateMomentBatchOrFallback({
                        kind: 'reply',
                        momentData,
                        participants: regenParticipants,
                        contextMode: regenParticipants.length > 1 ? 'group' : 'private',
                        audienceIds: regenAudience
                    });
                    await processReplyBatchDecisions(decisions, regenParticipants, momentId, momentData.author);
                } finally {
                    cleanupRegenLoading();
                }
            }
        };
    }
}
/**
 * 辅助函数：从数据库删除指定索引的评论
 */
async function deleteComment(momentId, index) {
    try {
        if (isNaN(index)) return; // 报错消息因为没有存库所以 index 为 NaN，直接跳过数据库删除
        const moment = await db.moments.get(momentId);
        if (moment && moment.comments) {
            moment.comments.splice(index, 1); // 删除数组中指定位置的元素
            await db.moments.put(moment);
            console.log('评论已删除');
        }
    } catch (e) {
        console.error('删除评论失败', e);
    }
}
/**
 * 【全新导演】管理AI动态下的评论互动 (群聊模式)
 * @param {number} momentId - 动态ID
 * @param {object} initialMomentData - 触发时的动态数据
 * @param {object} userComment - 用户刚刚发布的评论
 */
async function manageAiMomentInteraction(momentId, initialMomentData, userComment) {
    const authorChar = AppState.characterProfiles.find(c => c.name === initialMomentData.author);
    if (!authorChar) return;

    console.log(`[AI动态导演] 开始主持 ${authorChar.name} 的动态评论区...`);

    // 1. 确定所有潜在参与者：作者本人 + 其所有关联NPC
    const participants = [
        { type: 'character', data: authorChar },
        ...(authorChar.relatedNpcs || []).map(npc => ({ type: 'npc', data: npc }))
    ];

    // 2. 过滤掉用户自己，因为用户不需要AI来扮演
    const aiParticipants = participants.filter(p => p.data.name !== userComment.user);

    if (aiParticipants.length === 0) {
        console.log('[AI动态导演] 没有其他AI或NPC可参与互动，结束。');
        return;
    }
    
    console.log('[AI动态导演] 在场AI/NPC:', aiParticipants.map(p => p.data.name));

    const batchParticipants = aiParticipants.map(participant =>
        participant.type === 'character'
            ? { type: 'character', id: participant.data.id }
            : { type: 'npc', data: participant.data, ownerCharId: authorChar.id }
    );
    const cleanupLoading = showMomentBatchLoading(momentId, batchParticipants, '正在输入...');
    try {
        const decisions = await generateMomentBatchOrFallback({
            kind: 'reply',
            momentData: initialMomentData,
            participants: batchParticipants,
            contextMode: 'group',
            audienceIds: [authorChar.id],
            userReplyComment: userComment
        });
        await processReplyBatchDecisions(
            decisions,
            batchParticipants,
            momentId,
            userComment.user
        );
    } finally {
        cleanupLoading();
    }

    console.log('[AI动态导演] 本轮互动主持完毕。');
}

/**
 * 【全新功能】舞台剧总导演：触发NPC在动态下的互动
 * @param {object} momentData - 主角刚刚发布的完整动态数据
 * @param {object[]} npcs - 主角关联的NPC列表
 * @param {string} ownerCharId - 主角角色的ID (用于在 processAiReply 中查找归属)
 */
async function triggerNpcMomentInteraction(momentData, npcs, ownerCharId) {
    if (!npcs || npcs.length === 0) return;

    const MAX_NPC_COMMENTERS = 3; // 最多只允许3个NPC评论
    
    // 1. 打乱NPC数组，实现随机性
    const shuffledNpcs = npcs.sort(() => 0.5 - Math.random());
    
    // 2. 只选取前 MAX_NPC_COMMENTERS 个NPC
    const participants = shuffledNpcs.slice(0, MAX_NPC_COMMENTERS);
    console.log(`[NPC剧场] 导演就位！准备组织 ${participants.length} 位NPC进行互动。`);

    const selectedNpcs = participants.filter(npc => {
        const probSetting = (npc.probability !== undefined) ? npc.probability : 70;
        const threshold = probSetting / 100;
        console.log(`[NPC剧场] ${npc.name} 的评论概率是: ${probSetting}%`);
        if (Math.random() > threshold) {
            console.log(`[NPC剧场] NPC“${npc.name}”这次选择潜水，不参与评论。`);
            return false;
        }
        return true;
    });

    if (selectedNpcs.length === 0) {
        console.log('[NPC剧场] 本轮概率筛选后没有NPC出场。');
        return;
    }

    const latestMomentData = await db.moments.get(momentData.id);
    if (!latestMomentData) return;

    const batchParticipants = selectedNpcs.map(npc => ({
        type: 'npc',
        data: npc,
        ownerCharId
    }));
    const cleanupLoading = showMomentBatchLoading(momentData.id, batchParticipants, '正在输入...');
    let decisions = [];
    try {
        decisions = await generateMomentBatchOrFallback({
            kind: 'reply',
            momentData: latestMomentData,
            participants: batchParticipants,
            contextMode: 'group',
            audienceIds: [ownerCharId]
        });
    } finally {
        cleanupLoading();
    }

    for (const participant of batchParticipants) {
        const delay = 3000 + Math.random() * 5000;
        await new Promise(resolve => setTimeout(resolve, delay));

        const decision = findBatchDecisionForParticipant(decisions, participant);
        if (!decision?.reply) {
            console.log(`[NPC剧场] NPC“${participant.data.name}”决定保持沉默。`);
            continue;
        }
        await processAiReply(
            decision.reply,
            ownerCharId,
            momentData.id,
            decision.replyTo || momentData.author,
            participant.data,
            decision.translation // <--- 补上缺失的翻译字段，就差这一行！
        );
    }

    console.log(`[NPC剧场] 本轮互动结束。`);
}
// ===============================================
// ▼▼▼ 【新增】转发功能辅助函数 (放在文件末尾) ▼▼▼
// ===============================================

/**
 * 打开好友选择弹窗
 */
function openForwardFriendSelectModal(cardData) {
    // 1. 如果弹窗 HTML 还没创建，就创建它
    if (!document.getElementById('forward-modal-overlay')) {
        const html = `
            <div id="forward-modal-overlay" class="forward-modal-overlay">
                <div class="forward-modal-card">
                    <h3>选择发送给...</h3>
                    <div class="friend-list-scroll" id="forward-friend-list"></div>
                    <button class="modal-cancel-btn" id="forward-cancel-btn">取消</button>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', html);
        
        // 绑定取消事件
        const overlay = document.getElementById('forward-modal-overlay');
        const cancelBtn = document.getElementById('forward-cancel-btn');
        const close = () => { overlay.classList.remove('visible'); setTimeout(() => overlay.style.display='none', 200); };
        cancelBtn.onclick = close;
        overlay.onclick = (e) => { if(e.target === overlay) close(); };
    }

    // 2. 获取好友列表 (过滤掉没有聊天的角色)
    const friends = AppState.characterProfiles.filter(c => c.hasChat);
    const listContainer = document.getElementById('forward-friend-list');
    listContainer.innerHTML = '';

    // 3. 渲染列表
    friends.forEach(friend => {
        const item = document.createElement('div');
        item.className = 'forward-friend-item';
        item.innerHTML = `
            <img src="${friend.avatar || 'images/default-avatar.svg'}">
            <span>${friend.name}</span>
        `;
        
        // 4. 点击好友，直接发送
        item.onclick = async () => {
            if(confirm(`确定发送给 ${friend.name} 吗？`)) {
                await sendMomentCardToChat(friend.id, cardData);
                // 关闭弹窗
                document.getElementById('forward-cancel-btn').click();
                showDynamicIsland('已转发');
            }
        };
        listContainer.appendChild(item);
    });

    // 5. 显示弹窗
    const overlay = document.getElementById('forward-modal-overlay');
    overlay.style.display = 'flex';
    setTimeout(() => overlay.classList.add('visible'), 10);
}

/**
 * 执行发送操作 (写入数据库)
 */
async function sendMomentCardToChat(chatId, cardData) {
    try {
        const currentUser = AppState.userProfile;
        
        // 构造存入 content 字段的 JSON 字符串
        // 这里我们把数据精简一下，只存展示需要的
          // 构造存入 content 字段的 JSON 字符串
        const contentPayload = JSON.stringify({
            author: cardData.author,
            avatar: cardData.avatar,
            text: cardData.text,
            thumb: cardData.thumb,
            likes: cardData.likes,
            comments: cardData.comments,
            commentsDetail: cardData.commentsDetail, 
            momentId: cardData.momentId
        });


        // 构造消息对象
        const messageData = {
            chatId: chatId,
            timestamp: new Date(),
            text: '[动态]', // 作为降级显示的文本
            type: 'sent',
            contentType: 'moment_card', // 【关键】标记类型
            content: contentPayload,    // 【关键】存入卡片数据
            avatarSrc: currentUser.avatar,
            recalled: false
        };

        // 写入数据库
        await db.chatMessages.add(messageData);
        console.log('动态卡片已发送给', chatId);
        
    } catch (error) {
        console.error('转发失败', error);
        showDynamicIsland('转发失败');
    }
}
