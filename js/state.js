
/* ========================================================================== */
  /* == 1. 核心初始化与状态管理 (CORE INITIALIZATION & STATE) == */
  /* ========================================================================== */
import Dexie from './lib/dexie.mjs';
export const DEFAULT_NOTIFICATION_SRC = 'assets/notification.mp3';
export const DEFAULT_SEND_SOUND_SRC = 'assets/发送.mp3';
export const DEFAULT_GALLERY_SETTINGS = {
    isAiEnabled: false,      // AI智能搜索是否开启，默认关闭
    aiThreshold: 0.55,       // AI搜索的相似度阈值 (0.0 to 1.0)
    fallbackThreshold: 0.2,  // 备用搜索的相似度阈值 (0.0 to 1.0)
};
export const DEFAULT_AVATAR_SRC = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
export const DEFAULT_CHAR_INTERACTION_CARD_ENABLED = true;
export const DEFAULT_DESKTOP_ICON_NAME_COLOR = '#333333';
export const CHARACTER_REPLY_LANGUAGE_OPTIONS = {
    auto: 'Follow the character profile, world settings, and current context',
    zh: 'Mandarin Chinese',
    en: 'English',
    ja: 'Japanese',
    ko: 'Korean',
    yue: 'Cantonese'
};

export function getCharacterReplyLanguage(char = {}) {
    const value = String(char.replyLanguage || 'auto').trim();
    return Object.prototype.hasOwnProperty.call(CHARACTER_REPLY_LANGUAGE_OPTIONS, value) ? value : 'auto';
}

export function getCharacterReplyLanguageInstruction(char = {}, scope = 'chat') {
    const value = getCharacterReplyLanguage(char);
    const label = CHARACTER_REPLY_LANGUAGE_OPTIONS[value];
    if (value === 'auto') {
        return `[Character Reply Language - ${scope} | HIGHEST PRIORITY]\nVisible text/voice should follow the character profile, world settings, and current context. Do not change persona just to match the user's language. This language rule overrides the user's language, chat history examples, and quoted examples.`;
    }
    return `[Character Reply Language - ${scope} | HIGHEST PRIORITY]\nEvery visible text/voice content from this character MUST be written in ${label}. This overrides the user's language, chat history examples, and quoted examples. Keep the same persona, tone, catchphrases, and relationship attitude. If a required translation field exists and the visible content is not Mandarin Chinese, put a natural Mandarin Chinese translation there.`;
}

export function normalizeDesktopIconNameColor(value) {
    const color = typeof value === 'string' ? value.trim() : '';
    if (!color) return DEFAULT_DESKTOP_ICON_NAME_COLOR;
    if (typeof CSS !== 'undefined' && CSS.supports && CSS.supports('color', color)) return color;
    return DEFAULT_DESKTOP_ICON_NAME_COLOR;
}
  /* --- 1.1 数据库初始化 (Dexie.js) --- */
  // 使用 Dexie.js 库创建一个名为 'pxGlgUserData' 的本地 IndexedDB 数据库
export  const db = new Dexie('pxGlgUserData');
db.version(40).stores({ 
  appData: '&key', 
  shopCustomData: '++id, type, catId',
  chatMessages: '++id, chatId, timestamp, [chatId+timestamp], [chatId+isFavorite], replyToMessageId, [chatId+type], [chatId+type+transferInfo.status], callId', 
  lookyLedger: '&id, timestamp, type, category, source, sourceId, &[source+sourceId], char',
  lookyVaults: '&charId, status, updatedAt',
  lookyVaultLogs: '++id, charId, timestamp, type, source, sourceId',
  
  stickerGroups: '&id, name',
  galleryImages: '++id, charId, groupId, timestamp',
  galleryGroups: '++id, charId, name',
  importantMemories: '++id, charId, date, [chatId+date]',
  worldBookCategories: '++id, &name',
  worldBookEntries: '++id, title, content, category, importance, createdAt, [category+importance]',

  characterProfiles: 'id', // 【修复】：精简索引，只保留主键id，解决带有对象的属性引发的保存失败Bug
  
  ttsCache: '&key, charId, timestamp, [charId+timestamp]',
  offlineMessages: '++id, chatId, sessionId, sender, text, timestamp, isSummarized, [chatId+isSummarized]',
  offlineSessions: '++id, chatId, &startTime', 
  userProfile: `++id, name`,
  moments: '++id, author, characterId',
  themeSchemes: '++id, name, type, date' ,
  themeApplications: '++id, [type+schemeId], type, schemeId, *characterIds',
  diaries: '++id, [charId+date], charId, date',
  diarySettings: '++id, charId',
  smsMessages: '++id, chatId, timestamp'
}).upgrade(tx => {
  console.log("Database upgraded to version 40. Add favorite message index.");
});
/**
 *  记忆系统核心配置
 */
export const D3EVE_MEMORY_CONFIG = {
    CONVERSATION_BUFFER_SIZE: 20, // 每20轮对话触发一次总结
    LONG_TERM_MEMORY_THRESHOLD: 7, // 重要性评分 > 7 的信息进入长期记忆
    SHORT_TERM_MEMORY_TTL_DAYS: 3 // 短期记忆的存活时间（天）
};
/**
 * 聊天消息折叠功能的配置
 */
export const config = {
    onlineMessageFoldThreshold: 100,  
    offlineMessageFoldThreshold: 40, 
    onlineMessageLoadChunkSize: 100,  // 【线上】每次点击加载的数量
    offlineMessageLoadChunkSize: 40, 
};
/**
 * 存放聊天相关的临时状态，比如被折叠的消息
 */
export const chatState = {
    unrenderedMessages: new Map(), 
    inConversationTimestampTimer: null,
     pendingMessageQueue: new Map(), 
};
/**
 * 为新角色创建默认的记忆档案结构
 * @returns {object} 一个空的、结构化的记忆档案
 */
export function createDefaultMemoryProfile() {
    return {
        long_term_memory: {
            core_info: "", // 核心事实、关系摘要
            preferences: [], // 用户偏好, e.g., [{ key: "favorite_color", value: "蓝色", emotion: "neutral" }]
            commitments: [], // 约定承诺, e.g., [{ content: "下周去看电影", importance: 9, emotion: "positive" }]
        },
        short_term_memory: [], // 近期记忆, e.g., [{ content: "用户今天午饭吃了披萨", importance: 2, emotion: "neutral", timestamp: 123456789 }]
    };
}


  /* --- 1.2 全局应用状态 (AppState) --- */
  // 这个对象储存了整个应用运行时的所有核心数据
const RELATION_START_MODES = new Set(['stranger', 'known', 'library_only']);
const RELATION_STAGES = new Set(['library', 'offline_met', 'pending_user', 'pending_char', 'friend']);

export function normalizeCharacterRelationshipFields(char = {}) {
    const hasExistingChat = Boolean(char.hasChat);
    let relationStartMode = RELATION_START_MODES.has(char.relationStartMode)
        ? char.relationStartMode
        : (hasExistingChat ? 'known' : 'library_only');
    let relationStage = RELATION_STAGES.has(char.relationStage)
        ? char.relationStage
        : (relationStartMode === 'known' ? 'friend' : 'library');

    if (relationStartMode === 'known') {
        relationStage = 'friend';
    }
    if (char.blockAppealPhase && char.pendingFriendRequestDirection === 'char_to_user' && RELATION_STAGES.has(char.pendingPreviousRelationStage)) {
        relationStage = char.pendingPreviousRelationStage;
    }

    const hasChat = relationStage === 'friend';
    const requiresOfflineMeet = relationStartMode === 'stranger' && relationStage !== 'friend'
        ? char.requiresOfflineMeet !== false
        : false;
    const requiresFriendRequest = relationStartMode === 'stranger' && relationStage !== 'friend'
        ? char.requiresFriendRequest !== false
        : false;
    const numericFamiliarity = Number(char.familiarity);
    const familiarity = Number.isFinite(numericFamiliarity)
        ? Math.max(0, Math.min(100, numericFamiliarity))
        : 0;
    const accountSeed = String(char.id || Date.now()).replace(/\D/g, '').slice(-6).padStart(6, '0');

    return {
        relationStartMode,
        relationStage,
        hasChat,
        requiresOfflineMeet,
        requiresFriendRequest,
        characterAccount: char.characterAccount || `looky_${accountSeed}`,
        familiarity,
        relationshipEvents: Array.isArray(char.relationshipEvents) ? char.relationshipEvents : [],
        inContacts: char.inContacts !== false
    };
}

export function isCharacterFriend(char = {}) {
    return char.relationStage === 'friend' || char.hasChat === true;
}

export function createFriendRelationshipUpdates(char = {}, shouldBeFriend = true) {
    if (shouldBeFriend) {
        return {
            relationStartMode: RELATION_START_MODES.has(char.relationStartMode) ? char.relationStartMode : 'known',
            relationStage: 'friend',
            hasChat: true,
            requiresOfflineMeet: false,
            requiresFriendRequest: false,
            inContacts: true,
            pendingFriendRequestDirection: null,
            pendingFriendRequestMessage: '',
            pendingPreviousRelationStage: null,
            pendingPreviousInContacts: null
        };
    }

    const relationStartMode = char.relationStartMode === 'stranger' ? 'stranger' : 'library_only';
    return {
        relationStartMode,
        relationStage: 'library',
        hasChat: false,
        requiresOfflineMeet: relationStartMode === 'stranger',
        requiresFriendRequest: relationStartMode === 'stranger',
        pendingFriendRequestDirection: null,
        pendingFriendRequestMessage: '',
        pendingPreviousRelationStage: null,
        pendingPreviousInContacts: null
    };
}

export  let AppState = {
      profileDIY: {
        nickname: "点击修改昵称",
        signature: "点击输入个性签名...",
        avatar: "default-avatar.svg",
        background: "images/default-bg.jpg",
        themeColor: "white" // 预留字段
    },
    userIdentities: [], // 所有用户身份
    currentIdentityId: 'default', // 当前使用的用户身份ID
    characterProfiles: [], // 所有AI角色（好友/联系人）的资料
    characterGroups: [], // AI角色的分组
    apiConfigurations: [], // 保存的API配置方案
    apiCurrentSettings: null, // 当前正在使用的API设置
    mcpSettings: null, // 远程 MCP 服务器、工具与全局限制
    lastUsedApiConfigName: '无', // 最后使用的API配置名称
    sharedStickers: [], // 共享的表情包库
    stickerGroups: [], // 表情包的分组
    iconSettings: {}, // 自定义图标的设置
    desktopIconNameColor: DEFAULT_DESKTOP_ICON_NAME_COLOR, // 桌面图标名字颜色
    idCardData: {}, // 证件卡组件的数据 (文字、图片)
    playerWidgetData: {}, // 音乐播放器组件的数据 (头像、背景、文字)
    desktopSchemes: [], // ▼▼▼ 新增：保存的桌面方案列表 ▼▼▼
    wallpapers: { // 壁纸设置
      home: null, // 主屏幕壁纸
      system: null, // 手机系统背景（顶栏和状态栏）
      app: null // 应用内背景
    },
    homeScreenImages: { // 主屏幕上可更换的图片
      'large-photo-img': null,
      'ticket-photo-img': null,
       'polaroid-img-1': null, 
      'polaroid-img-2': null,
      'polaroid-img-3': null,
      'insta-display-img': null,
      'tw-img-1': null,
      'tw-img-2': null,
      'tw-img-3': null
    },
gallerySettings: {},
currentChatHistory: [],
friendRequests: [],
friendRequestThreads: {},
// ▼▼▼ 【新增】全局TTS设置 ▼▼▼
    ttsGlobalSettings: {
        provider: 'minimax', // 当前使用的 TTS 服务商
        enabled: true,       // 全局 TTS 开关
        autoPlay: false,     // 收到AI消息后是否自动播放语音
        // MiniMax 的专属配置
        minimax: {
            // API版本/终结点，默认是官方地址
            endpoint: 'https://api.minimaxi.com/v1/t2a_v2',
            groupId: '', // 用户填写的 Group ID
            apiKey: '',  // 用户填写的 API Key
            model: 'speech-01', // 默认使用的TTS模型
        },
        // ElevenLabs 的专属配置
        elevenlabs: {
            apiKey: '',
            model: 'eleven_multilingual_v2',
            outputFormat: 'mp3_44100_128'
        }
    },
    voiceRecognitionSettings: {
        provider: 'browser',
        endpoint: '',
        apiKey: '',
        model: '',
        language: 'zh'
    }
  };

 /* --- 1.3 全局临时状态 --- */
// 用一个对象来封装所有可变的临时状态，以解决ESM导入绑定为只读的问题
export const tempState = {
  editingContactId: null,
  editingCharId: null,    
  islandTimeout: null,  
  selectedCharIds: [],  
  replyingToId: null,   
  isMultiSelectMode: false,  
  selectedMessageIds: new Set(), 
  editingMemoryId: null,
  currentChatId: null,
  currentChatHomeSection: 'friends-content',
  conversationBuffers: {},
  activeOfflineSession: null,   
  hybridModeTurnCounters: {},
  hybridSessionMessages: {},
  currentOfflineSessionId: null,
  isRenderingHistory: false,
  activeCallChatId: null,
  activeCallMode: null,
  callReturnPageId: 'page-chat-detail',
  callReturnChatId: null,
  callWidgetMinimized: false,
};

export function isChatInActiveCall(chatId) {
    if (!chatId || !tempState.activeCallChatId) return false;
    return String(chatId) === String(tempState.activeCallChatId);
}
/**
 * [已修正] 设置一个“忠实哨兵”，监听你是否离开页面。
 * 现在它会把离开时间记录到更持久的 sessionStorage “便利贴”上。
 */
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        // 当页面隐藏时，将当前时间戳存入 sessionStorage
        sessionStorage.setItem('link_page_leave_timestamp', Date.now());
        console.log(`页面被隐藏，记录离开时间到 sessionStorage`);
    } 
});

/**
 * 添加一条新的重要记忆
 * @param {object} memoryData 
 * @returns {Promise<number>} 
 */
export async function addImportantMemory(memoryData) {
    return await db.importantMemories.add(memoryData);
}

/**
 * 根据角色ID获取所有重要记忆
 * @param {string} charId - 角色ID
 * @returns {Promise<Array>} 返回该角色的记忆数组
 */
export async function getImportantMemoriesForChar(charId) {
     if (!charId) return [];
    return await db.importantMemories.where({ charId }).reverse().sortBy('date');
}


/**
 * 更新一条已有的重要记忆
 * @param {number} memoryId - 记忆的ID
 * @param {object} updates - 包含要更新的字段的对象 (e.g., { date, content })
 * @returns {Promise<number>}
 */
export async function updateImportantMemory(memoryId, updates) {
    return await db.importantMemories.update(memoryId, updates);
}

/**
 * 删除一条重要记忆
 * @param {number} memoryId - 记忆的ID
 * @returns {Promise<void>}
 */
export async function deleteImportantMemory(memoryId) {
    return await db.importantMemories.delete(memoryId);
}

/**
 * 获取与指定角色的第一条消息的时间戳
 * @param {string} charId 角色ID
 * @returns {Promise<number|null>} 返回最早的时间戳，如果没有消息则返回null
 */
export async function getFirstMessageTimestamp(charId) {
  if (!charId) return null;
  try {
    // 【核心修复】利用 Dexie 复合索引直接秒取第一条，不加载多余数据，0内存占用！
    const firstMessage = await db.chatMessages
        .where('[chatId+timestamp]')
        .between([charId, Dexie.minKey], [charId, Dexie.maxKey])
        .first();
    
    return firstMessage ? firstMessage.timestamp : null;
  } catch (error) {
    console.error("查询第一条消息时间失败:", error);
    return null;
  }
}



/**
 * 更新指定角色的记忆保留时间设置
 * @param {number} charId 角色ID
 * @param {string} period 保留时间 (例如 '7d', '30d', 'permanent')
 */
export async function updateCharacterRetentionPeriod(charId, period) {
    try {
        await db.characterProfiles.update(charId, { retentionPeriod: period });
        // 同时更新内存中的 AppState，以便立即生效
        const charInState = AppState.characterProfiles.find(c => c.id === charId);
        if (charInState) {
            charInState.retentionPeriod = period;
        }
        console.log(`角色 ${charId} 的记忆保留时间已更新为 ${period}`);
    } catch (error) {
        console.error("更新角色记忆保留时间失败:", error);
        throw error; // 抛出错误，让调用方处理
    }
}
// 文件: /link.js/state.js

/**
 * 获取指定角色挂载的世界书内容，用于AI Prompt
 * @param {number} charId - 当前角色的ID
 * @returns {Promise<string>} 格式化后的世界书内容字符串
 */
function formatKnownRelationshipForPrompt(background = {}) {
    const rows = [
        ['认识多久', background.duration],
        ['原本关系', background.originalRelation],
        ['共同经历', background.sharedHistory],
        ['现在关系', background.currentRelation],
        ['Ta怎么称呼你', background.nicknameForUser],
        ['开场话题/当前前提', background.openingContext]
    ].filter(([, value]) => String(value || '').trim());

    return rows.length > 0
        ? `[已认识关系背景]\n${rows.map(([label, value]) => `${label}：${value}`).join('\n')}`
        : '';
}

export async function getWorldBookForPrompt(charId) {
    if (!charId) return "无";

    try {
        const character = await db.characterProfiles.get(charId);
        const mountedIds = character?.mountedWBIds;
        const mountedCategories = Array.isArray(character?.mountedWBCategories)
            ? character.mountedWBCategories.filter(Boolean)
            : [];

        // ▼▼▼ 修改开始：获取全局世界书，并与手动挂载的强行合并 ▼▼▼
        const globalEntries = await db.worldBookEntries.where('category').equals('全局世界书').toArray();
        const globalIds = globalEntries.map(entry => entry.id);
        const categoryEntries = mountedCategories.length > 0
            ? await db.worldBookEntries.where('category').anyOf(mountedCategories).toArray()
            : [];
        const categoryIds = categoryEntries.map(entry => entry.id);
        const finalMountedIds = [...new Set([...(mountedIds || []), ...categoryIds, ...globalIds])];

        const relationshipBackground = character?.relationStartMode === 'known'
            ? formatKnownRelationshipForPrompt(character.knownRelationshipBackground)
            : '';

        // 如果角色没有配置且没有全局世界书，则返回
        if (!finalMountedIds || finalMountedIds.length === 0) {
            // ▼▼▼【日志添加】▼▼▼
            console.log(`[世界书调用日志] 角色ID ${charId} (${character.name}) 未挂载任何世界书。`);
            // ▲▲▲【日志结束】▲▲▲
            return relationshipBackground || "无";
        }

        // ▼▼▼ 修正：在这里统一使用 finalMountedIds 进行一次查询 ▼▼▼
        const mountedEntries = await db.worldBookEntries
            .where('id').anyOf(finalMountedIds)
            .toArray();
        
        // ▼▼▼【日志添加】▼▼▼
        console.groupCollapsed(`[世界书调用日志] 角色ID ${charId} (${character.name})`);
        if (mountedEntries.length > 0) {
            console.log(`查询到 ${mountedEntries.length} 条挂载的世界书:`);
            mountedEntries.forEach(entry => console.log(`- "${entry.title}" (ID: ${entry.id})`));
        } else {
            console.warn(`未在数据库中找到任何挂载条目。`);
        }
        console.groupEnd();
        // ▲▲▲【日志结束】▲▲▲
        
        const importanceOrder = { high: 1, medium: 2, low: 3 };
        
        mountedEntries.sort((a, b) => {
            const orderA = importanceOrder[a.importance] || 3;
            const orderB = importanceOrder[b.importance] || 3;
            return orderA - orderB;
        });
        
        const formattedEntries = mountedEntries.map(entry => `[${entry.title}]: ${entry.content}`).join('\n');
        
        return [`[世界书设定]\n${formattedEntries}`, relationshipBackground].filter(Boolean).join('\n\n');

    } catch (error) {
        console.error(`[世界书调用日志] 获取角色 ${charId} 的世界书内容失败:`, error);
        return "无";
    }
}

/**
 * 获取指定角色的世界书内容，并按注入位置分组。
 * 默认位置保持 getWorldBookForPrompt 的旧行为，额外支持关键词触发过滤。
 * @param {number|string} chatId - 当前角色/聊天ID
 * @param {string} recentText - 最近对话文本，用于关键词匹配
 * @returns {Promise<{default:string, beforeChar:string, afterChar:string, beforeHistory:string, afterHistory:string}>}
 */
export async function getWorldBookWithPositions(chatId, recentText = '') {
    const result = { default: '无', beforeChar: '', afterChar: '', beforeHistory: '', afterHistory: '' };
    if (!chatId) return result;

    try {
        const character = await db.characterProfiles.get(chatId);
        if (!character) return result;

        const mountedIds = Array.isArray(character.mountedWBIds) ? character.mountedWBIds : [];
        const mountedCategories = Array.isArray(character.mountedWBCategories)
            ? character.mountedWBCategories.filter(Boolean)
            : [];

        const globalEntries = await db.worldBookEntries.where('category').equals('全局世界书').toArray();
        const categoryEntries = mountedCategories.length > 0
            ? await db.worldBookEntries.where('category').anyOf(mountedCategories).toArray()
            : [];
        const selectedEntries = mountedIds.length > 0
            ? (await db.worldBookEntries.bulkGet(mountedIds)).filter(Boolean)
            : [];

        const entriesById = new Map();
        [...globalEntries, ...categoryEntries, ...selectedEntries].forEach(entry => {
            if (entry?.id !== undefined) entriesById.set(String(entry.id), entry);
        });

        const allEntries = [...entriesById.values()];
        const searchText = String(recentText || '').toLowerCase();
        const getEntryKeywordStatus = (entry) => {
            const keywordTriggerEnabled = !!entry.keywordTriggerEnabled;
            const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];
            const matched = !keywordTriggerEnabled || keywords.length === 0
                ? true
                : keywords.some(keyword => searchText.includes(String(keyword).toLowerCase()));
            return { keywordTriggerEnabled, keywords, matched };
        };
        const filteredEntries = allEntries.filter(entry => getEntryKeywordStatus(entry).matched);

        const importanceOrder = { high: 1, medium: 2, low: 3 };
        filteredEntries.sort((a, b) => (importanceOrder[a.importance] || 3) - (importanceOrder[b.importance] || 3));

        const buckets = { default: [], beforeChar: [], afterChar: [], beforeHistory: [], afterHistory: [] };
        const positionMap = {
            default: 'default',
            before_char: 'beforeChar',
            after_char: 'afterChar',
            before_history: 'beforeHistory',
            after_history: 'afterHistory'
        };

        filteredEntries.forEach(entry => {
            const injectionPosition = entry.injectionPosition || 'default';
            const position = positionMap[injectionPosition] || 'default';
            buckets[position].push(`[${entry.title || '未命名世界书'}]: ${entry.content || ''}`);
        });

        const relationshipBackground = character.relationStartMode === 'known'
            ? formatKnownRelationshipForPrompt(character.knownRelationshipBackground)
            : '';
        const defaultWorldBook = buckets.default.length > 0
            ? `[世界书设定]\n${buckets.default.join('\n')}`
            : '';

        result.default = [defaultWorldBook, relationshipBackground].filter(Boolean).join('\n\n') || '无';
        result.beforeChar = buckets.beforeChar.join('\n\n');
        result.afterChar = buckets.afterChar.join('\n\n');
        result.beforeHistory = buckets.beforeHistory.join('\n\n');
        result.afterHistory = buckets.afterHistory.join('\n\n');

        const positionLabelMap = {
            default: '默认位置',
            before_char: '角色人设之前',
            after_char: '角色人设之后',
            before_history: '聊天历史之前',
            after_history: '聊天历史之后'
        };
        console.groupCollapsed(`[世界书调用记录] ${character.name || '未命名角色'} / ${chatId}`);
        console.log('这个角色配置的世界书：');
        console.table(allEntries.map(entry => {
            const keywordStatus = getEntryKeywordStatus(entry);
            const injectionPosition = entry.injectionPosition || 'default';
            return {
                id: entry.id,
                title: entry.title || '未命名世界书',
                category: entry.category || '',
                importance: entry.importance || 'low',
                position: positionLabelMap[injectionPosition] || '默认位置',
                keywordTrigger: keywordStatus.keywordTriggerEnabled ? '开启' : '关闭',
                keywords: keywordStatus.keywords.join(', ') || '无',
                thisRound: keywordStatus.matched ? '本轮使用' : '本轮未使用（关键词未命中）'
            };
        }));
        console.log('本轮实际使用：', filteredEntries.map(entry => {
            const injectionPosition = entry.injectionPosition || 'default';
            return `${entry.title || '未命名世界书'} → ${positionLabelMap[injectionPosition] || '默认位置'}`;
        }));
        console.log('本轮分桶数量：', {
            默认位置: buckets.default.length,
            角色人设之前: buckets.beforeChar.length,
            角色人设之后: buckets.afterChar.length,
            聊天历史之前: buckets.beforeHistory.length,
            聊天历史之后: buckets.afterHistory.length
        });
        console.groupEnd();
        return result;
    } catch (error) {
        console.error(`[世界书调用日志] 获取角色 ${chatId} 的分位置世界书内容失败:`, error);
        return result;
    }
}

/**
 * 获取所有世界书条目并按分组整理，用于UI渲染
 * @returns {Promise<Object>} 返回一个以分组名为键，条目数组为值的对象
 */
export async function getAllWorldBooksGrouped() {
    const categories = await db.worldBookCategories.toArray();
    const entries = await db.worldBookEntries.toArray();
    // ▼▼▼ 修改这行：初始化结果对象，包含全局世界书和默认分组 ▼▼▼
    const grouped = { '全局世界书': [], '默认': [] };
    // ▲▲▲ 修改结束 ▲▲▲
    categories.forEach(cat => {
        grouped[cat.name] = [];
    });
    // 将条目放入对应的分组
    entries.forEach(entry => {
        if (grouped[entry.category]) {
            grouped[entry.category].push(entry);
        } else {
            grouped['默认'].push(entry); // 如果分类不存在，则归入默认
        }
    });
    return grouped;
}
/**
 * 【新增】加载相册设置，如果本地没有则使用默认值
 */
export function loadGallerySettings() {
    const storedSettings = localStorage.getItem('link_gallery_settings');
    AppState.gallerySettings = storedSettings 
        ? { ...DEFAULT_GALLERY_SETTINGS, ...JSON.parse(storedSettings) } 
        : { ...DEFAULT_GALLERY_SETTINGS };
    console.log("Loaded Gallery Settings:", AppState.gallerySettings);
}
/**
 * 【新增】一个专门用于保存相册设置的函数
 */
export function saveGallerySettings() {
    localStorage.setItem('link_gallery_settings', JSON.stringify(AppState.gallerySettings));
    console.log("Saved Gallery Settings:", AppState.gallerySettings);
}
/**
 * 【新增】获取并格式化最近的线下模式聊天记录，用于构建Prompt
 * @param {string} chatId - 聊天ID
 * @param {number} turnsToInclude - 要包含的对话轮次
 * @returns {Promise<Array>} - 格式化后的消息历史
 */
export async function getFormattedOfflineHistory(chatId, turnsToInclude = 15) {
    if (!chatId) return [];
    
    // 获取最近的消息记录
    const messages = await db.offlineMessages
        .where('chatId')
        .equals(chatId)
        .reverse() // 从最新的开始
        .limit(turnsToInclude * 2) // 获取用户+AI的完整轮次
        .toArray();
    
    // 恢复时间顺序并格式化
    const recentMessages = messages.reverse();
    
    return recentMessages.map(msg => ({
        role: msg.sender === 'user' ? 'user' : 'assistant',
        content: msg.text
    }));
}
// ▼▼▼ 在这里粘贴下面的新代码 ▼▼▼

/**
 * [新增] 将混合模式的状态保存到 sessionStorage
 */
export function saveHybridStateToSession() {
    const stateToSave = {
        activeOfflineSession: tempState.activeOfflineSession,
        hybridModeTurnCounters: tempState.hybridModeTurnCounters
    };
    // 使用 sessionStorage.setItem() 将状态对象转换为 JSON 字符串并保存
    sessionStorage.setItem('link_hybrid_state', JSON.stringify(stateToSave));
}

/**
 * [新增] 从 sessionStorage 加载混合模式的状态
 */
export function loadHybridStateFromSession() { 
    // 使用 sessionStorage.getItem() 读取保存的字符串
    const savedStateJSON = sessionStorage.getItem('link_hybrid_state');
    if (savedStateJSON) {
        try {
            // 将字符串解析回 JavaScript 对象
            const savedState = JSON.parse(savedStateJSON);
            // 将读取到的状态恢复到 tempState 中
            tempState.activeOfflineSession = savedState.activeOfflineSession || null;
            tempState.hybridModeTurnCounters = savedState.hybridModeTurnCounters || {};
            console.log('[持久化] 已成功从 sessionStorage 恢复混合模式状态:', tempState);
        } catch (e) {
            console.error('[持久化] 从 sessionStorage 恢复混合模式状态失败:', e);
            // 如果解析失败，就使用默认的空状态
            tempState.activeOfflineSession = null;
            tempState.hybridModeTurnCounters = {};
        }
    }
}
// ▼▼▼ 在这里粘贴下面的新代码 ▼▼▼
const CHARACTER_SCOPED_THEME_TYPES = new Set(['detail', 'bubble', 'offline']);

function hasValidThemeTargetId(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

/** chat 类型本身就是全局主题规则；旧数据可能没有 characterIds。 */
export function isGlobalChatThemeRule(rule) {
  return rule?.type === 'chat';
}

/** detail/bubble/offline 必须至少包含一个有效的具体目标 ID。 */
export function isCharacterScopedThemeRule(rule) {
  return CHARACTER_SCOPED_THEME_TYPES.has(rule?.type) &&
    Array.isArray(rule.characterIds) &&
    rule.characterIds.some(hasValidThemeTargetId);
}

export function isInvalidCharacterScopedThemeRule(rule) {
  return CHARACTER_SCOPED_THEME_TYPES.has(rule?.type) && !isCharacterScopedThemeRule(rule);
}

/** 判断规则是否命中当前角色或群聊；非 chat 不再把空数组当成全局。 */
export function themeRuleTargetsCharacter(rule, characterId) {
  if (isGlobalChatThemeRule(rule)) return true;
  if (!isCharacterScopedThemeRule(rule) || !hasValidThemeTargetId(characterId)) return false;
  const targetId = String(characterId);
  return rule.characterIds.some(id => hasValidThemeTargetId(id) && String(id) === targetId);
}

/**
 * 选择当前目标真正生效的主题规则。
 * 只接受命中目标且仍有对应方案的规则；同一 type + target 取 application id 最大者。
 */
export function getEffectiveThemeRuleForTarget(applications, schemes, type, targetId) {
  const schemeById = new Map(
    (Array.isArray(schemes) ? schemes : [])
      .filter(scheme => scheme && scheme.id !== null && scheme.id !== undefined)
      .map(scheme => [String(scheme.id), scheme])
  );
  return (Array.isArray(applications) ? applications : [])
    .filter(rule => rule?.type === type && themeRuleTargetsCharacter(rule, targetId))
    .map(rule => ({ rule, scheme: schemeById.get(String(rule.schemeId)) }))
    .filter(item => item.scheme)
    .sort((left, right) => (Number(right.rule.id) || 0) - (Number(left.rule.id) || 0))[0] || null;
}

/** 仅用于 themeApplications.characterIds 的字符串等价去重。 */
export function mergeThemeCharacterIds(...groups) {
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const id of group) {
      if (!hasValidThemeTargetId(id)) continue;
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(id);
    }
  }
  return merged;
}

/**
 * 清理历史上的 detail/bubble/offline 脏规则。
 * 不触碰 chat + []，可重复执行且只扫描指定类型。
 */
export async function cleanupInvalidCharacterScopedThemeApplications(types) {
  const targetTypes = Array.isArray(types) && types.length
    ? types
    : [...CHARACTER_SCOPED_THEME_TYPES];
  const applications = await db.themeApplications.where('type').anyOf(targetTypes).toArray();
  const invalidIds = applications
    .filter(isInvalidCharacterScopedThemeRule)
    .map(rule => rule.id)
    .filter(id => id !== null && id !== undefined);
  if (invalidIds.length > 0) {
    await db.themeApplications.bulkDelete(invalidIds);
  }
  return invalidIds;
}

/**
 * [新增] 专门用来操作“主题应用”数据的小帮手函数集合
 */
export const themeState = {
  // 获取所有保存的方案
  async getAllSchemes() {
    return await db.themeSchemes.toArray();
  },
  // 只获取列表和选择器需要的轻量摘要，避免把方案里的大图片/CSS读入内存。
  async getAllSchemeSummaries() {
    const summaries = [];
    await db.themeSchemes.orderBy('id').reverse().each(scheme => {
      summaries.push({
        id: scheme.id,
        name: scheme.name,
        typeName: scheme.typeName,
        date: scheme.date
      });
    });
    return summaries;
  },
  // 获取所有“主题应用”的规则
  async getAllApplications() {
    const applications = await db.themeApplications.toArray();
    const invalidIds = applications
      .filter(isInvalidCharacterScopedThemeRule)
      .map(rule => rule.id)
      .filter(id => id !== null && id !== undefined);
    if (invalidIds.length > 0) {
      await db.themeApplications.bulkDelete(invalidIds);
    }
    return applications.filter(rule => !isInvalidCharacterScopedThemeRule(rule));
  },
  /**
   * 保存或更新一个应用规则
   * @param {string} type - 页面类型 (例如: 'chat', 'detail')
   * @param {number|null} schemeId - 应用的方案ID，null代表不应用
   * @param {number[]} characterIds - 应用的角色ID数组
   */
  async saveApplication(type, schemeId, characterIds) {
    const existing = await db.themeApplications.where({ type }).first();
    const currentData = { 
        schemeId: schemeId,
        ...(type === 'chat'
          ? { characterIds: [] }
          : (Array.isArray(characterIds) ? { characterIds } : {}))
    };
    if (existing) {
      // 如果已经有这个页面的规则了，就更新它
      return db.themeApplications.update(existing.id, currentData);
    } else {
      // 如果是第一次设置，就新建一条规则
      return db.themeApplications.add({ type, ...currentData });
    }
  }
};

// --- 仅用于调试 ---
window.tempState = tempState;
window.AppState = AppState;
window.db = db;
/**
 * [新增] 专注记录管理 (存储于 IndexedDB 的 appData 表中，异步读写防卡顿)
 */
export const focusState = {
    // 读取记录
    async getRecords() {
        try {
            const record = await db.appData.get('focus_global_records');
            if (record && record.value) {
                return record.value;
            }
        } catch (e) {
            console.error("读取专注记录失败", e);
        }
        // 如果是第一次使用，返回默认的空数据结构
        return {
            totalFlowers: 0,
            totalMinutes: 0,
            charTime: {},     // 记录每个角色的陪伴时长 { charId: minutes }
            dailyHistory: {}  // 记录每天的时长 { "2023-10-24": minutes }
        };
    },
    
    // 增加新记录并保存
    async addRecord(charId, minutes, isSuccess) {
        try {
            // 先在后台读取旧数据
            const data = await this.getRecords();
            
            // 只有专注成功，才奖励一朵小花
            if (isSuccess) {
                data.totalFlowers += 1;
            }
            // 无论成功失败，陪伴的时间都算数
            data.totalMinutes += minutes;
            
            // 累加对应角色的陪伴时间
            if (charId) {
                if (!data.charTime[charId]) data.charTime[charId] = 0;
                data.charTime[charId] += minutes;
            }
            
            // 累加当天的专注时间 (用于图表)
            const todayStr = new Date().toISOString().split('T')[0];
            if (!data.dailyHistory[todayStr]) data.dailyHistory[todayStr] = 0;
            data.dailyHistory[todayStr] += minutes;
            
            // 异步将更新后的数据塞回数据库
            await db.appData.put({ key: 'focus_global_records', value: data });
            return data;
        } catch (e) {
            console.error("保存专注记录失败", e);
        }
    }
};
let persistentStorageCheckPromise = null;

export async function ensurePersistentStorage() {
  if (persistentStorageCheckPromise) return persistentStorageCheckPromise;

  persistentStorageCheckPromise = (async () => {
    const status = {
      supported: !!navigator.storage,
      isStandalone: window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)')?.matches === true,
      persisted: false,
      usage: null,
      quota: null,
      usageRatio: null
    };

    try {
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        status.usage = estimate.usage || 0;
        status.quota = estimate.quota || 0;
        status.usageRatio = status.quota ? status.usage / status.quota : null;
        console.log(`[Storage Manager] 当前已用: ${(status.usage / 1024 / 1024).toFixed(2)}MB / ${(status.quota / 1024 / 1024).toFixed(2)}MB`);
        if (status.usageRatio !== null && status.usageRatio > 0.85) {
          console.warn('[Storage Manager] 存储空间占用超过 85%，建议尽快导出备份并清理大图片/音频数据。');
        }
      }

      if (navigator.storage?.persisted) {
        status.persisted = await navigator.storage.persisted();
        console.log(`[Storage Manager] 当前存储是否已持久化: ${status.persisted}`);
      }

      if (!status.persisted && navigator.storage?.persist) {
        status.persisted = await navigator.storage.persist();
        if (status.persisted) {
          console.log('[Storage Manager] 成功获取持久化存储权限，数据更安全了。');
      } else {
          console.warn('[Storage Manager] 持久化存储权限请求被拒绝，数据仍有被系统清理的风险。');
        }
      } else if (!navigator.storage?.persist) {
        console.warn(`[Storage Manager] 当前环境不支持手动申请持久化存储 API${status.isStandalone ? '（Safari 添加到主屏幕也常见）' : ''}。本地数据库仍可正常使用，但建议定期导出备份。`);
      }
    } catch (error) {
      console.error('[Storage Manager] 存储体检失败:', error);
    }

    return status;
  })();

  return persistentStorageCheckPromise;
}
