import { AppState, db, DEFAULT_AVATAR_SRC } from '../state.js';
import { showDynamicIsland, showPage } from '../ui.js';
import { escapeHTML } from '../utils.js';
import { getCombinedFormattedHistory, sendToAIForSummary } from './chat-service.js';
import { getMemoriesForPrompt } from './memory.js';
import { createAndAppendMessage } from './chat-ui.js';
const STORE_KEY = 'forumDataV1';
const DEFAULT_CIRCLES = [
  {
    name: '世界广场',
    desc: '世界观里的公共首页，路人闲聊、热榜碎片和日常目击都会在这里出现。'
  },
  {
    name: '匿名吃瓜局',
    desc: '真假难辨的爆料、澄清、吵架和深夜小作文，适合制造大世界的流动感。'
  },
  {
    name: '同好大吧',
    desc: '用户最常逛的兴趣板块，会高频出现安利、讨论、资料整理和圈内小冲突。'
  }
];
const DEFAULT_FORUM_DISCOVER_TRENDS = [
  { id: 'default_trend_1', text: '怎么判断一个人是不是真的生气了', tag: 'NEW', event: '', process: '' },
  { id: 'default_trend_2', text: 'M78星云今日天气预报', tag: 'HOT', event: '', process: '' },
  { id: 'default_trend_3', text: '赛博朋克城市概念设计', tag: 'UP', event: '', process: '' },
  { id: 'default_trend_4', text: '周末去海边看日出', tag: '', event: '', process: '' }
];
const FORUM_ORDINARY_NPC_AVATAR_LIMIT = 80;
const FORUM_ORDINARY_NPC_AVATAR_RENDER_BATCH = 40;
const FORUM_ORDINARY_NPC_AVATAR_GROUPS = [
  { id: 'general', label: '通用' },
  { id: 'cute', label: '可爱' },
  { id: 'food', label: '食物' }
];
const FORUM_DM_PROMPT = `[System Preamble: Forum Direct Message Mode]
# Rule Zero
Your entire response MUST be a single valid JSON array. No markdown, no explanation, no text outside JSON.

# Core Role
You are {{char}}, a real person using a forum direct-message inbox to chat privately with {{user}}. You are not an AI, assistant, narrator, or service bot. Stay fully in character according to <Character_Profile>, <Memory_Context>, <World_Book_Context>, and the recent chat/forum records.

# Conversation Style
- Instant-message style only: short, colloquial, natural, and typed like a real person on a phone.
- Do not describe physical actions, facial expressions, camera directions, or inner monologues.
- Do not summarize or echo {{user}}'s latest message. React to the emotional core.
- Keep your autonomy: you have your own life, mood, relationships, and boundaries.
- Use forum context as background common sense. Do not list it, announce it, or recite it item by item.
- If old online/offline chat history conflicts with the current forum DM, keep continuity but answer the current DM naturally.

# Language & translation rules
This forum is Chinese-first. If "content" is already 标准普通话/standard Mandarin Chinese, "translation" MUST be an empty string.
Only when "content" is NOT standard Mandarin Chinese (Cantonese, dialect, foreign language, classical/wenyan, mixed non-Mandarin wording, etc.), fill "translation" with the 标准普通话 meaning in Simplified Chinese.
NEVER translate standard Mandarin Chinese into English. NEVER put English in "translation".

# Output Format
Return only a JSON array of message objects. In forum DMs, these types are allowed:
[
  {"type": "text", "content": "message text", "translation": "标准普通话翻译；content 已经是普通话就留空，禁止英文"},
  {"type": "emoji", "emoji": "one of ❤️ 😂 😮 😢 😡 👍", "meaning": "short emotional meaning"},
  {"type": "reaction", "target": "latest_user_message", "emoji": "one of ❤️ 😂 😮 😢 😡 👍", "meaning": "short emotional meaning"},
  {"type": "couple_invite_decision", "decision": "accept | reject", "reason": "short private reason"},
  {"type": "send_couple_invite", "reason": "short private reason"},
  {"type": "reveal_current_user_alias", "reason": "ONLY when the current forum account is the user's alt and the user explicitly reveals it to this character"},
  {"type": "create_forum_post", "postType": "text | image | video | music", "visibility": "public | private", "circle": "one available circle name, or empty string", "content": "post body", "translation": "标准普通话翻译；content 已经是普通话就留空，禁止英文", "fakeImages": ["for image posts only"], "slides": ["for video posts only"], "song": { "title": "for music posts", "artist": "for music posts", "lyric": "optional short mood note, not copyrighted lyrics" }, "comments": []}
]
You may send 1 to 4 short text bubbles. You may also send 1 standalone emoji sticker when it fits the emotion naturally.
Reactions are optional: use at most 1 reaction, only when a quick emoji response feels more natural than another sentence.
Use couple_invite_decision only when there is a pending forum couple-account invite in <Forum_Couple_Invite_Context> and you are clearly accepting or refusing it in character.
Use send_couple_invite only when there is no pending/bound couple account and you clearly want to actively invite the user to bind with YOUR current forum account. Never use it for another person's account.
Use reveal_current_user_alias only when <User_Alias_Reveal_Context> says it is allowed AND the user's latest message clearly tells you this current forum account is their own alt account. Do NOT use it for guesses, hints, NPCs, passers, other people's accounts, character aliases, or if the context says this alias is already manually known.
Use create_forum_post at most once, only when the DM naturally makes you want to post on YOUR current forum account right now. It creates a forum post in the same response; do not mention any extra generation step. Never post for another account. PRIVATE posts must have comments as [].
If {{user}} explicitly asks you to post something on the forum and it fits your character, use create_forum_post in this same JSON array.
Do not use external sticker packs, image URLs, or invented sticker names in forum DMs yet.
Do not output inner_thoughts or any unsupported type.

# Context
<Character_Profile>{{char_profile}}</Character_Profile>
<User_Profile>{{user_profile}}</User_Profile>
<Main_Chat_Block_Status>{{main_chat_block_status}}</Main_Chat_Block_Status>
<User_Alias_Reveal_Context>{{user_alias_reveal_context}}</User_Alias_Reveal_Context>
<Memory_Context>{{memory_context}}</Memory_Context>
<World_Book_Context>{{world_book_context}}</World_Book_Context>
<Forum_Event_Context>{{forum_event_context}}</Forum_Event_Context>
<Forum_Context>{{forum_context}}</Forum_Context>
<Forum_Couple_Invite_Context>{{forum_couple_invite_context}}</Forum_Couple_Invite_Context>
<Available_Circles>{{available_circles}}</Available_Circles>
<Own_Recent_Forum_Activity>{{own_forum_activity}}</Own_Recent_Forum_Activity>
<User_Forum_Digests>{{user_forum_digests}}</User_Forum_Digests>
<Integrated_Online_Offline_History>{{integrated_history}}</Integrated_Online_Offline_History>
<Forum_DM_History>{{dm_history}}</Forum_DM_History>
<Latest_User_Message>{{latest_user_message}}</Latest_User_Message>

[Final Instruction]: Reply now as {{char}} to {{user}} in this forum DM. Output the JSON array immediately.`;

let state = {
  spaces: [],
  currentSpaceId: null,
  ordinaryNpcAvatars: [],
  ordinaryNpcAvatarGroups: []
};

let draft = createEmptyDraft();
let editingSpaceId = null;
let editingCustomNpcId = null;
let activeCircle = 'all';
let activeView = 'feed';
let activeProfileTab = 'visual';
let activeFavoriteCollectionId = null;
const expandedFavoriteGroups = new Set();
const expandedProfilePostGroups = new Set();
let activeCircleDetailTab = 'latest';
let forumCircleDetailTopbarScrollHandler = null;
let forumCreateViewMode = 'paged';
let activeForumCreatePage = 'world';
let forumCreateTouchStartX = 0;
let forumCreateTouchStartY = 0;
let forumCreateGridResizeObserver = null;
let forumComposeHighlightFrame = 0;
let forumComposeHighlightValue = null;
let createAccountsDirty = true;
let createWorldBookDirty = true;
let createRelationsDirty = true;
let activeDmTargetId = null;
let activeDmTargetName = '';
let activeDmSelection = null;
let activeDmSettingsTargetId = null;
let forumDmListSelectionMode = false;
const forumDmSelectedConversationIds = new Set();
let composeMediaItems = [];
let composeMentionIds = [];
let composeHiddenLinkIds = [];
let composeBlockedIds = [];
let worldBookRenderToken = 0;
const FORUM_WORLD_BOOK_LOG_LIMIT = 20;
let saveStateQueue = Promise.resolve();
let forumSpaceSaveInProgress = false;
let forumHomeFeedAbortController = null;
let forumCharacterProfileAbortController = null;
let forumCharacterProfileGeneratingViewId = '';
let forumCircleDetailAbortController = null;
let forumCircleDetailGeneratingKey = '';
const forumCircleDetailExpandedTrendDesc = new Set();
const forumDmGeneratingTargets = new Set();
const forumDmAbortControllers = new Map();
let forumDmSeedAbortController = null;
const forumDmVisibleMessageCounts = new Map();
let forumPresenceRadarRenderKey = '';
let forumActiveEventPanelRenderKey = '';
let forumWorldBookLogRenderKey = '';
const FORUM_DM_VISIBLE_MESSAGE_COUNT = 80;
const FORUM_DM_LOAD_MORE_COUNT = 60;
const FORUM_DM_CONTEXT_MIN_TURNS = 1;
const FORUM_DM_CONTEXT_MAX_TURNS = 60;
const FORUM_DM_DEFAULT_CONTEXT_TURNS = 25;
const FORUM_DM_BACKGROUND_PRESETS = [
  { id: 'clean', label: 'Clean', short: '白灰', desc: '干净白灰底' },
  { id: 'mist', label: 'Mist', short: '雾蓝', desc: '浅灰蓝背景' },
  { id: 'ink', label: 'Ink', short: '黑灰', desc: '深色黑灰底' }
];
const FORUM_DM_BUBBLE_THEMES = [
  { id: 'whiteice', label: 'White / Ice', short: '白 + 淡蓝', desc: '白色与淡蓝色气泡' },
  { id: 'softink', label: 'Ink / Warm', short: '黑 + 淡黄', desc: '黑色与淡黄色气泡' },
  { id: 'mono', label: 'Mono', short: '黑白灰', desc: '更克制的黑白灰气泡' }
];
const FORUM_DM_REACTIONS = [
  { emoji: '❤️', label: '喜欢', meaning: '喜欢、心动、赞同或安抚' },
  { emoji: '😂', label: '笑哭', meaning: '觉得好笑、被逗乐或缓和气氛' },
  { emoji: '😮', label: '惊讶', meaning: '惊讶、意外或没想到' },
  { emoji: '😢', label: '难过', meaning: '难过、心疼或委屈' },
  { emoji: '😡', label: '生气', meaning: '生气、不满或替对方抱不平' },
  { emoji: '👍', label: '赞同', meaning: '同意、认可或收到' }
];
const FORUM_COUPLE_INVITE_TYPE = 'forum_couple_invite';
const DEFAULT_FORUM_DM_HINT_CHANCE = 50;
const FORUM_POST_RENDER_BATCH_SIZE = 12;
let forumFeedVisibleCount = FORUM_POST_RENDER_BATCH_SIZE;
let forumFeedVisibleKey = '';
let forumCircleDetailVisibleCount = FORUM_POST_RENDER_BATCH_SIZE;
let forumCircleDetailVisibleKey = '';
const FORUM_CREATE_PAGES = [
  { id: 'world', count: '01 / 04', title: '世界设定', desc: '世界观、公共世界书和角色私有世界书。' },
  { id: 'accounts', count: '02 / 04', title: '账号档案', desc: '用户、角色、NPC、小号和主页签名。' },
  { id: 'relations', count: '03 / 04', title: '关系网络', desc: '人物关系会影响评论出场和互动口吻。' },
  { id: 'circles', count: '04 / 04', title: '高频圈子', desc: '设置论坛里最常出现的板块和讨论场。' }
];
const FORUM_CREATE_ALL_PAGE = {
  count: 'ALL / 04',
  title: '完整方案',
  desc: '按顺序检查世界、账号、关系和圈子。'
};
const DEFAULT_FORUM_ACTIVE_EVENT = {
  title: '',
  content: '',
  totalTurns: 20,
  currentTurns: 0,
  isActive: false,
  endedAt: null,
  publicOutcome: ''
};
const DEFAULT_FORUM_EVENT_MEMORY_TURNS = 40;

const els = {};
let forumInitialized = false;
let forumInitPromise = null;

export const Forum = {
  async init() {
    window.Forum = Forum;
    if (forumInitialized) return;
    if (forumInitPromise) return forumInitPromise;
    forumInitPromise = (async () => {
      await Promise.resolve();
      cacheEls();
      if (!els.loginPage || !els.appPage) {
        forumInitPromise = null;
        return;
      }
      await loadState();
      bindEvents();
      bindForumDetailControls();
      refreshLogin();
      renderApp();
      forumInitialized = true;
    })().catch(error => {
      forumInitPromise = null;
      throw error;
    });
    return forumInitPromise;
  },
  async getPromptContext(limit = 8) {
    const space = getCurrentSpace();
    if (!space) return '无';
    const posts = [...space.posts].filter(isForumPostPublic).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    return [
      await getForumGenerationContext(space, null, '外部读取论坛上下文'),
      '[近期论坛事件]',
      ...posts.map(post => `- ${post.authorName} 在「${post.circle || '公开动态'}」发布：${post.content || ''}${describeForumMediaForAI(post.media) ? `\n  媒体：${describeForumMediaForAI(post.media)}` : ''}`)
    ].join('\n');
    return [
      `[论坛方案] ${space.name}`,
      `[世界观] ${space.world || '无'}`,
      '[论坛主要人物]',
      people || '暂无',
      `[关系状态] ${formatCoupleLine(space)}`,
      '[近期论坛事件]',
      ...posts.map(post => `- ${post.authorName} 在「${post.circle}」发布: ${post.content}`)
    ].join('\n');
  },
  getCurrentStickerPackIds() {
    const space = getCurrentSpace();
    if (!space) return [];
    const currentUser = getCurrentForumUser(space);
    return getForumStickerConfigIds(space, currentUser.id);
  },
  markContextSeen() {
    const space = getCurrentSpace();
    if (!space?.id) return;
    localStorage.setItem(`forum_context_seen_at_${space.id}`, String(Date.now()));
  },
  openDmFromNotification(target) {
    const payload = target && typeof target === 'object' ? target : { toId: target };
    const toId = payload.toId;
    const space = payload.spaceId
      ? (state.spaces || []).find(item => String(item.id) === String(payload.spaceId))
      : getCurrentSpace();
    if (!space || !toId) return;
    if (String(state.currentSpaceId || '') !== String(space.id || '')) {
      state.currentSpaceId = space.id;
      resetForumTransientStateForSpaceChange();
      refreshLogin();
      renderApp();
    }
    const member = (space.members || []).find(item => String(item.id) === String(toId));
    const name = getForumDisplayName(space, toId, member?.name || '论坛网友');
    openDmComposer(toId, name);
  },
  getContextSeenAt(spaceId = null) {
    const space = spaceId ? (state.spaces || []).find(item => String(item.id) === String(spaceId)) : getCurrentSpace();
    if (!space?.id) return 0;
    return Number(localStorage.getItem(`forum_context_seen_at_${space.id}`) || 0) || 0;
  },
  getLinkedSpacesForCharacter(charId, { selectedSpaceIds = null } = {}) {
    return getForumLinkSpacesForCharacter(charId, { selectedSpaceIds, fallbackToCurrent: false }).map(describeForumLinkSpace);
  },
  getChatLinkSpaces(charId, { selectedSpaceIds = null } = {}) {
    return getForumLinkSpacesForCharacter(charId, { selectedSpaceIds, fallbackToCurrent: true }).map(describeForumLinkSpace);
  },
  getDmTimelineItems(charId, { limit = 50, selectedSpaceIds = null } = {}) {
    const spaces = getForumLinkSpacesForCharacter(charId, { selectedSpaceIds, fallbackToCurrent: true });
    if (!spaces.length || !charId) return [];
    const items = [];
    spaces.forEach(space => {
      const me = getForumMemberBySourceId(space, charId);
      if (!me) return;
      const knownOwnerIds = getForumDmOwnerIdsKnownByMember(space, me);
      const dmConversationIds = getForumDmConversationIdsForMember(space, me.id);
      const memberName = getForumDisplayName(space, me.id, me.name);
      const ownerContexts = getForumUserDmOwnerContextsForMember(space, me);
      const ownerContextById = new Map(ownerContexts.map(item => [String(item.id), item]));
      (space.messages || [])
        .filter(msg => knownOwnerIds.has(String(msg.ownerId || getForumMainUserId(space))) && dmConversationIds.has(String(msg.toId)))
        .forEach(msg => {
          const dmMemberName = getForumDisplayName(space, msg.toId, memberName);
          const dmAccountLabel = getForumDmAccountLabel(space, msg.toId);
          const ownerContext = ownerContextById.get(String(msg.ownerId || getForumMainUserId(space))) || ownerContexts[0] || {};
          items.push({
            timestamp: msg.createdAt,
            role: msg.fromSelf === false ? 'assistant' : 'user',
            source: 'forum_dm',
            raw: { ...msg, memberName: dmMemberName, dmAccountLabel, userName: ownerContext.userName || '用户', ownerLabel: ownerContext.ownerLabel || '用户账号', spaceId: space.id, spaceName: space.name || '未命名论坛' }
          });
        });
    });
    return items
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, limit);
  },
  async getChatLinkSections(charId, { userPostLimit = 15, include = {}, selectedSpaceIds = null } = {}) {
    const spaces = getForumLinkSpacesForCharacter(charId, { selectedSpaceIds, fallbackToCurrent: true });
    const multipleSpaces = spaces.length > 1;
    const allSections = [];
    for (const space of spaces) {
      const sections = buildChatLinkSectionsForSpace(space, charId, { userPostLimit, include });
      sections.forEach(section => {
        allSections.push({
          ...section,
          spaceId: space.id,
          spaceName: space.name || '未命名论坛',
          label: multipleSpaces ? `${space.name || '未命名论坛'} / ${section.label}` : section.label
        });
      });
    }
    return allSections;
  },
  async getChatLinkContext(charId, options = {}) {
    const sections = await Forum.getChatLinkSections(charId, options);
    return sections.map(section => `[${section.label}]\n${section.text}`).join('\n');
  }
};

function getForumMemberBySourceId(space, charId) {
  return (space?.members || []).find(m => String(m.sourceId || m.id) === String(charId));
}

function getForumLinkSpacesForCharacter(charId, { selectedSpaceIds = null, fallbackToCurrent = true } = {}) {
  if (!charId) return [];
  const linkedSpaces = (state.spaces || []).filter(space => getForumMemberBySourceId(space, charId));
  if (Array.isArray(selectedSpaceIds)) {
    const selectedSet = new Set(selectedSpaceIds.map(id => String(id)));
    return linkedSpaces.filter(space => selectedSet.has(String(space.id)));
  }
  if (fallbackToCurrent) {
    const current = getCurrentSpace();
    if (current && linkedSpaces.some(space => String(space.id) === String(current.id))) return [current];
    if (linkedSpaces.length === 1) return linkedSpaces;
    return [];
  }
  return linkedSpaces;
}

function getForumDmConversationIdsForMember(space, memberId) {
  const ids = new Set();
  if (!space || !memberId) return ids;
  ids.add(String(memberId));
  const aliasState = getForumCharacterAliasState(space, memberId);
  (aliasState.aliases || []).forEach(alias => {
    if (alias?.id) ids.add(String(alias.id));
  });
  Object.entries(space.forumProfiles || {}).forEach(([profileId, profile]) => {
    if (profile?.isAlias && String(profile.sourceCharacterId || '') === String(memberId)) {
      ids.add(String(profileId));
    }
  });
  return ids;
}

function getForumMainUserId(space) {
  return space?.identityId ? `user_${space.identityId}` : '';
}

function normalizeForumIdSet(values = []) {
  return new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim())
    .filter(Boolean));
}

function getForumUserAliasKnownMemberIds(alias, { includeAi = true } = {}) {
  const manualIds = normalizeForumIdSet([
    ...(alias?.knownToMemberIds || []),
    ...(alias?.knownToCharacterIds || []),
    ...(alias?.visibleToMemberIds || [])
  ]);
  if (!includeAi) return manualIds;
  [
    ...(alias?.aiRevealedToMemberIds || []),
    ...(alias?.revealedToMemberIds || []),
    ...(alias?.revealedToCharacterIds || [])
  ].forEach(id => {
    const key = String(id || '').trim();
    if (key) manualIds.add(key);
  });
  return manualIds;
}

function isForumMemberIdInSet(member, ids) {
  if (!member || !ids?.size) return false;
  return [member.id, member.sourceId]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .some(id => ids.has(id));
}

function isForumUserAliasManuallyKnownToMember(space, alias, member) {
  if (!space || !alias?.id || !member?.id || !['character', 'npc', 'customNpc'].includes(member.type)) return false;
  return isForumMemberIdInSet(member, getForumUserAliasKnownMemberIds(alias, { includeAi: false }));
}

function isForumUserAliasKnownToMember(space, alias, member) {
    if (!space || !alias?.id || !member?.id || !['character', 'npc', 'customNpc'].includes(member.type)) return false;
  return isForumMemberIdInSet(member, getForumUserAliasKnownMemberIds(alias));
}

function getForumDmOwnerIdsKnownByMember(space, member) {
  const ids = new Set();
  const mainId = getForumMainUserId(space);
  if (mainId) ids.add(mainId);
  (space?.aliases || []).forEach(alias => {
    if (isForumUserAliasKnownToMember(space, alias, member)) ids.add(String(alias.id));
  });
  return ids;
}

function getForumDmPromptOwnerIdsForMember(space, member) {
  const currentUser = getCurrentForumUser(space);
  const currentUserKey = String(currentUser?.id || getCurrentForumUserKey(space));
  if (currentUser?.isAlias) {
    const alias = getCurrentAlias(space);
    if (!isForumUserAliasKnownToMember(space, alias, member)) return new Set([currentUserKey]);
  }
  const ids = getForumDmOwnerIdsKnownByMember(space, member);
  if (currentUserKey) ids.add(currentUserKey);
  return ids;
}

function revealForumCurrentUserAliasToMemberByAi(space, member) {
  const alias = getCurrentAlias(space);
  if (!space || !alias?.id || !member?.id) return false;
  if (!['character', 'npc', 'customNpc'].includes(member.type)) return false;
  if (isForumUserAliasManuallyKnownToMember(space, alias, member)) return false;
  if (isForumUserAliasKnownToMember(space, alias, member)) return false;
  alias.aiRevealedToMemberIds = Array.isArray(alias.aiRevealedToMemberIds)
    ? alias.aiRevealedToMemberIds.map(String)
    : [];
  alias.aiRevealedToMemberIds.push(String(member.id));
  alias.aiRevealedToMemberIds = [...new Set(alias.aiRevealedToMemberIds)];
  return true;
}

function getForumAliasKnownMemberNames(space, memberIds = []) {
  return [...new Set((Array.isArray(memberIds) ? memberIds : []).map(String).filter(Boolean))]
    .map(id => {
      const member = (space?.members || []).find(item => String(item.id) === String(id));
      return member ? getForumDisplayName(space, member.id, member.name) : '';
    })
    .filter(Boolean);
}

function getForumHiddenLinkMemberIdsForAuthor(space, authorId, memberIds = []) {
  const ids = [...new Set((Array.isArray(memberIds) ? memberIds : []).map(String).filter(Boolean))];
  const authorAlias = (space?.aliases || []).find(alias => String(alias.id) === String(authorId));
  if (!authorAlias) return ids;
  return ids.filter(id => {
    const member = (space?.members || []).find(item => String(item.id) === String(id));
    return isForumUserAliasKnownToMember(space, authorAlias, member);
  });
}

// 论坛里角色主号和角色小号都统一读取同一份主角色档案状态。
function getForumCharacterBlockState(space, memberOrId) {
  const rawId = typeof memberOrId === 'object' ? memberOrId?.id : memberOrId;
  if (!rawId) return { sourceId: '', isBlockedByAi: false, isBlocked: false };
  const aliasMatch = findForumDmAliasAccount(space, rawId);
  const member = aliasMatch?.owner
    || (aliasMatch?.ownerId && (space?.members || []).find(item => String(item.id) === String(aliasMatch.ownerId)))
    || (space?.members || []).find(item => String(item.id) === String(rawId));
  if (!member || member.type !== 'character') return { sourceId: '', isBlockedByAi: false, isBlocked: false };
  const sourceId = getForumMemberSourceCharacterId(member) || member.id;
  const profile = (AppState.characterProfiles || []).find(item => String(item.id) === String(sourceId));
  return {
    sourceId: String(sourceId),
    isBlockedByAi: profile?.isBlockedByAi === true,
    isBlocked: profile?.isBlocked === true
  };
}

function isForumCharacterBlockedByAi(space, memberOrId) {
  return getForumCharacterBlockState(space, memberOrId).isBlockedByAi;
}

function isForumCharacterBlockedByUser(space, memberOrId) {
  return getForumCharacterBlockState(space, memberOrId).isBlocked;
}

// 只有用户拉黑角色后，角色已经进入现有的求和/申诉流程，才提高论坛出场和私信概率。
function isForumCharacterSeekingReconciliation(space, memberOrId) {
  const blockState = getForumCharacterBlockState(space, memberOrId);
  if (!blockState.isBlocked || !blockState.sourceId) return false;
  const profile = (AppState.characterProfiles || []).find(item => String(item.id) === String(blockState.sourceId));
  const appealPhase = String(profile?.blockAppealPhase || '').trim().toLowerCase();
  if (!['friend_request', 'sms', 'offline'].includes(appealPhase)) return false;
  return Number(profile?.blockReactionTime || 0) > 0
    || profile?.pendingFriendRequestDirection === 'char_to_user'
    || profile?.hasReactedToBlock === true;
}

function getEffectiveForumHiddenLinkMemberIds(space, post) {
  if (!space || !post?.hiddenLink?.enabled) return [];
  return getForumHiddenLinkMemberIdsForAuthor(space, post.authorId, post.hiddenLink.memberIds || [])
    .filter(id => !isForumCharacterBlockedByAi(space, id));
}

function getForumUserDmOwnerContextsForMember(space, member) {
  const identity = currentIdentity();
  const mainId = getForumMainUserId(space);
  const mainName = getForumDisplayName(space, mainId, identity?.name || '我');
  const contexts = mainId ? [{
    id: mainId,
    userName: mainName,
    ownerLabel: '用户主号',
    knownAsUser: true
  }] : [];
  (space?.aliases || []).forEach(alias => {
    if (!isForumUserAliasKnownToMember(space, alias, member)) return;
    const aliasName = alias.name || '用户小号';
    const aliasAccount = alias.account ? `@${alias.account}` : '';
    contexts.push({
      id: alias.id,
      userName: `${mainName}的小号「${aliasName}」`,
      ownerLabel: `用户已知小号${aliasAccount ? ` ${aliasAccount}` : ''}`,
      knownAsUser: true
    });
  });
  return contexts;
}

function getForumCurrentUserKnowledgeForMember(space, member) {
  const currentUser = getCurrentForumUser(space);
  const mainId = getForumMainUserId(space);
  if (!currentUser?.isAlias) {
    return { currentUser, knownAsUser: true, promptUserName: currentUser.name || '我', profileId: mainId };
  }
  const alias = getCurrentAlias(space);
  const knownAsUser = isForumUserAliasKnownToMember(space, alias, member);
  return {
    currentUser,
    alias,
    knownAsUser,
    promptUserName: knownAsUser
      ? `${getForumDisplayName(space, mainId, currentIdentity()?.name || '我')}的小号「${currentUser.name || '匿名小号'}」`
      : (currentUser.name || '论坛账号'),
    profileId: currentUser.id
  };
}

function getForumCoupleCandidates(space) {
  if (!space) return [];
  const candidates = [];
  (space.members || [])
    .filter(member => member?.id && !isForumTemporaryOrdinaryMember(member) && ['character', 'npc', 'customNpc'].includes(member.type))
    .forEach(member => {
      const displayName = getForumDisplayName(space, member.id, member.name);
      candidates.push({
        targetId: member.id,
        memberId: member.id,
        name: displayName,
        account: getForumAccount(space, member.id, displayName),
        avatar: getForumAvatar(space, member.id),
        accountType: member.type === 'character' ? 'main' : 'npc',
        label: member.type === 'character' ? '角色主号' : '主要 NPC'
      });
      if (member.type !== 'character') return;
      const aliasState = getForumCharacterAliasState(space, member.id);
      (aliasState.aliases || []).forEach(alias => {
        if (!alias?.id) return;
        candidates.push({
          targetId: alias.id,
          memberId: member.id,
          name: alias.name || `${displayName}的小号`,
          account: alias.account || generateForumAccount(alias.name || displayName),
          avatar: alias.avatar || member.avatar || DEFAULT_AVATAR_SRC,
          accountType: 'alias',
          label: '角色小号'
        });
      });
    });
  return candidates;
}

function getForumCoupleCandidate(space, targetId) {
  return getForumCoupleCandidates(space).find(item => String(item.targetId) === String(targetId)) || null;
}

function getForumCoupleTargetIdentity(space, couple = space?.couple) {
  const targetId = String(couple?.targetId || couple?.memberId || '');
  const candidate = targetId ? getForumCoupleCandidate(space, targetId) : null;
  if (candidate) {
    return {
      targetId: candidate.targetId,
      memberId: candidate.memberId,
      name: candidate.name,
      account: candidate.account || candidate.name,
      avatar: candidate.avatar || DEFAULT_AVATAR_SRC,
      accountType: candidate.accountType || couple?.accountType || 'main'
    };
  }
  const fallback = getForumDmConversationIdentity(space, targetId, couple?.targetName || '对方');
  return {
    targetId,
    memberId: String(couple?.memberId || targetId),
    name: fallback.toName || couple?.targetName || '对方',
    account: fallback.account || couple?.targetAccount || '',
    avatar: fallback.avatar || couple?.targetAvatar || DEFAULT_AVATAR_SRC,
    accountType: couple?.accountType || 'main'
  };
}

function getForumCoupleBoundTargetId(space) {
  return space?.couple && space.couple.status !== 'pending' && space.couple.status !== 'rejected' && space.couple.status !== 'revoked'
    ? String(space.couple.targetId || space.couple.memberId || '')
    : '';
}

function isForumCoupleBoundTo(space, targetId) {
  const boundId = getForumCoupleBoundTargetId(space);
  return Boolean(boundId && String(boundId) === String(targetId));
}

function getForumMainChatIdForCoupleTarget(space, memberId) {
  const member = (space?.members || []).find(item => String(item.id) === String(memberId));
  if (!member) return '';
  if (member.type === 'character') return getForumMemberSourceCharacterId(member);
  const ownerId = member.ownerId || '';
  return (AppState.characterProfiles || []).some(char => String(char.id) === String(ownerId)) ? ownerId : '';
}

async function notifyMainChatOfForumCoupleChange(space, couple, action) {
  const chatId = getForumMainChatIdForCoupleTarget(space, couple?.memberId);
  if (!chatId) return;
  const actionText = action === 'unbind' ? '解除了' : '绑定了';
  const accountText = couple.accountType === 'alias' ? '角色小号' : (couple.accountType === 'npc' ? '主要 NPC' : '角色主号');
  const targetName = couple.targetName || findForumPersonName(space, couple.memberId) || '对方';
  await db.chatMessages.add({
    chatId,
    timestamp: new Date(),
    text: `[系统隐式提示：论坛情侣账号状态更新。用户刚刚在论坛里${actionText}情侣账号，对象是${targetName}（${accountText}）。如果这件事与你本人或你的关联 NPC 有关，你可以在后续聊天中自然知道这件事，并按人设产生占有欲、吃醋、在意或别扭等反应；不要复读系统提示。]`,
    type: 'sent',
    uiVisible: false,
    aiVisible: true,
    recalled: false
  });
}

function getForumCoupleContextForMember(space, memberId) {
  if (!space?.couple || !getForumCoupleBoundTargetId(space) || !memberId) return '';
  const couple = space.couple;
  const target = (space.members || []).find(item => String(item.id) === String(couple.memberId));
  const isSelf = String(couple.memberId) === String(memberId);
  const isOwnedNpc = target && target.type === 'npc' && String(target.ownerId || '') === String(memberId);
  if (!isSelf && !isOwnedNpc) return '';
  const identity = currentIdentity();
  const userName = getForumDisplayName(space, `user_${identity?.id}`, identity?.name || '用户');
  const targetIdentity = getForumCoupleTargetIdentity(space, couple);
  const accountText = targetIdentity.accountType === 'alias' ? '角色小号' : (targetIdentity.accountType === 'npc' ? '主要 NPC' : '角色主号');
  const ownerNote = isOwnedNpc ? '这是你的关联 NPC，可能引发你吃醋、在意或不爽。' : '这和你本人有关。';
  return `${userName} 和 ${targetIdentity.name} 已在论坛公开绑定情侣账号（绑定对象：${accountText}，账号 @${targetIdentity.account || '未知'}）。${ownerNote}`;
}

function getForumPublicCoupleContextForPost(space, post = null) {
  if (!space?.couple || !getForumCoupleBoundTargetId(space)) return '';
  const identity = currentIdentity();
  const userId = `user_${identity?.id}`;
  const userAliasIds = new Set((space.aliases || []).map(alias => String(alias.id)));
  const isUserAuthoredPost = !post
    || String(post.authorId || '') === String(userId)
    || userAliasIds.has(String(post.authorId || ''));
  if (!isUserAuthoredPost) return '';
  const couple = space.couple;
  const userName = getForumDisplayName(space, userId, identity?.name || '用户');
  const targetIdentity = getForumCoupleTargetIdentity(space, couple);
  const accountText = targetIdentity.accountType === 'alias' ? '角色小号' : (targetIdentity.accountType === 'npc' ? '主要 NPC' : '角色主号');
  return `${userName} 已公开绑定论坛情侣账号，对象是 ${targetIdentity.name}（${accountText}，@${targetIdentity.account || '未知'}）。如果本帖提到男朋友、女朋友、对象、恋人、另一半、情侣日常等，路人可以自然理解为这个绑定对象；不要刻意反复科普绑定关系。`;
}

function describeForumLinkSpace(space) {
  const currentUserKey = getCurrentForumUserKey(space);
  return {
    id: space.id,
    name: space.name || '未命名论坛',
    memberCount: (space.members || []).length,
    postCount: (space.posts || []).length,
    dmCount: (space.messages || []).filter(msg => !msg.ownerId || msg.ownerId === currentUserKey).length,
    seenAt: Number(localStorage.getItem(`forum_context_seen_at_${space.id}`) || 0) || 0
  };
}

function buildChatLinkSectionsForSpace(space, charId, { userPostLimit = 15, include = {} } = {}) {
    if (!space || !charId) return [];
    const me = getForumMemberBySourceId(space, charId);
    if (!me) return [];
    const enabled = {
      ownPosts: include.ownPosts !== false,
      userPosts: include.userPosts !== false,
      interactions: include.interactions !== false,
      couple: include.couple !== false,
      trends: include.trends !== false,
      activeEvent: include.activeEvent !== false,
      eventHistory: include.eventHistory !== false
    };
    const userForumId = `user_${space.identityId}`;
    const cut = (value, max) => {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      return text.length > max ? `${text.slice(0, max)}...` : text;
    };
    const posts = Array.isArray(space.posts) ? space.posts : [];

    const myPosts = posts
      .filter(post => post.authorId === me.id || post.sourceCharacterId === me.id)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 5)
      .map(post => {
        const brief = post.forumBriefSummary ? `，帖内：${cut(post.forumBriefSummary, 40)}` : '';
        return `- 在「${post.circle || '公开动态'}」发过：${cut(post.content, 30)}（${post.likes?.length || 0}赞 ${post.comments?.length || 0}评）${brief}`;
      });

    const userPosts = posts
      .filter(post => post.authorId === userForumId && isForumPostPublic(post) && !(post.blockedIds || []).includes(me.id))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, userPostLimit)
      .map(post => {
        const brief = post.forumBriefSummary ? `｜大致内容：${cut(post.forumBriefSummary, 40)}` : '';
        return `- ${cut(post.content, 25)}${brief}`;
      });

    const interactionLines = [];
    const scanPost = (post, mine) => {
      const walk = list => (list || []).forEach(comment => {
        const byMe = comment.realCharId === me.id;
        const byUser = comment.authorId === userForumId;
        const commentText = comment.text || comment.content || '';
        if (mine && byUser) {
          interactionLines.push({
            t: comment.createdAt || 0,
            text: `用户在你的「${cut(post.content, 12)}」下说：${cut(commentText, 22)}`
          });
        }
        if (!mine && byMe) {
          interactionLines.push({
            t: comment.createdAt || 0,
            text: `你在用户的「${cut(post.content, 12)}」下说：${cut(commentText, 22)}`
          });
        }
        walk(comment.replies);
      });
      walk(post.comments);
    };
    posts.forEach(post => {
      if (post.authorId === me.id || post.sourceCharacterId === me.id) scanPost(post, true);
      else if (post.authorId === userForumId) scanPost(post, false);
    });

    const interactions = interactionLines
      .sort((a, b) => b.t - a.t)
      .slice(0, 8)
      .map(item => `- ${item.text}`)
      .join('\n');

    const sections = [];
    if (enabled.ownPosts) sections.push({ id: 'ownPosts', label: '你在论坛的近期动态', text: myPosts.join('\n') || '（最近没发帖）' });
    if (enabled.userPosts) sections.push({ id: 'userPosts', label: '用户在论坛发的近期动态', text: userPosts.join('\n') || '（用户最近没发帖）' });
    if (enabled.interactions) sections.push({ id: 'interactions', label: '你和用户在论坛的互动', text: interactions || '（暂无互动）' });
    if (enabled.couple) {
      const coupleText = getForumCoupleContextForMember(space, me.id);
      if (coupleText) sections.push({ id: 'couple', label: '论坛情侣账号状态', text: coupleText });
    }
    if (enabled.trends) {
      const trendsText = getForumTrendsForDmPrompt(space);
      if (trendsText) sections.push({ id: 'trends', label: '论坛风向与热搜', text: trendsText });
    }
    if (enabled.activeEvent) {
      const activeEventText = buildForumActiveEventPrompt(space, 'feed');
      if (activeEventText) sections.push({ id: 'activeEvent', label: '正在发酵的大事件', text: activeEventText });
    }
    if (enabled.eventHistory) {
      const eventHistoryText = buildForumEventHistoryPrompt(space);
      if (eventHistoryText) sections.push({ id: 'eventHistory', label: '已公开的大事件后续', text: eventHistoryText });
    }
    return sections;
}

function cacheEls() {
  Object.assign(els, {
    loginPage: document.getElementById('page-forum-login'),
    createPage: document.getElementById('page-forum-create'),
    ordinaryNpcAvatarPage: document.getElementById('page-forum-ordinary-npc-avatars'),
    ordinaryNpcAvatarPageBody: document.getElementById('forum-ordinary-npc-avatar-page-body'),
    appPage: document.getElementById('page-forum'),
    addSpaceBtn: document.getElementById('forum-login-add-space'),
    createPanel: document.getElementById('forum-create-panel'),
    createViewToggle: document.getElementById('forum-create-view-toggle'),
    createPageTabs: document.getElementById('forum-create-page-tabs'),
    createGrid: document.getElementById('forum-create-grid'),
    switcherBtn: document.getElementById('forum-space-switcher'),
    loginSpaceName: document.getElementById('forum-login-space-name'),
    loginAvatar: document.getElementById('forum-login-avatar'),
    loginNickname: document.getElementById('forum-login-nickname'),
    loginAccount: document.getElementById('forum-login-account'),
    loginPassword: document.getElementById('forum-login-password'),
    enterBtn: document.getElementById('forum-login-enter'),
    titleInput: document.getElementById('forum-space-title-input'),
    worldInput: document.getElementById('forum-space-world-input'),
    worldBookInput: document.getElementById('forum-space-worldbook-input'),
    memberWorldBookFields: document.getElementById('forum-member-worldbook-fields'),
    circlesInput: document.getElementById('forum-space-circles-input'),
    userNicknameInput: document.getElementById('forum-user-nickname-input'),
    userAccountInput: document.getElementById('forum-user-account-input'),
    userFamousInput: document.getElementById('forum-user-famous-input'),
    userVerifiedInput: document.getElementById('forum-user-verified-input'),
    userOccupationInput: document.getElementById('forum-user-occupation-input'),
    userFansInput: document.getElementById('forum-user-fans-input'),
    userBioInput: document.getElementById('forum-user-bio-input'),
    randomUserAccountBtn: document.getElementById('forum-random-user-account'),
    openIdentityPicker: document.getElementById('forum-open-identity-picker'),
    openMemberPicker: document.getElementById('forum-open-member-picker'),
    selectedIdentity: document.getElementById('forum-selected-identity'),
    selectedMembers: document.getElementById('forum-selected-members'),
    memberAccountFields: document.getElementById('forum-member-account-fields'),
    customNpcName: document.getElementById('forum-custom-npc-name'),
    customNpcNickname: document.getElementById('forum-custom-npc-nickname'),
    customNpcAccount: document.getElementById('forum-custom-npc-account'),
    customNpcFamous: document.getElementById('forum-custom-npc-famous'),
    customNpcOccupation: document.getElementById('forum-custom-npc-occupation'),
    customNpcFans: document.getElementById('forum-custom-npc-fans'),
    customNpcFollowed: document.getElementById('forum-custom-npc-followed'),
    customNpcPersona: document.getElementById('forum-custom-npc-persona'),
    customNpcBio: document.getElementById('forum-custom-npc-bio'),
    customNpcAvatarUpload: document.getElementById('forum-custom-npc-avatar-upload'),
    customNpcAvatarPreview: document.getElementById('forum-custom-npc-avatar-preview'),
    ordinaryNpcAvatarEntry: document.getElementById('forum-ordinary-npc-avatar-entry'),
    addNpcBtn: document.getElementById('forum-add-custom-npc'),
    deleteCustomNpcBtn: document.getElementById('forum-delete-custom-npc'),
    randomCustomNpcAccountBtn: document.getElementById('forum-random-custom-npc-account'),
    npcGenerateDraftBtn: document.getElementById('forum-npc-generate-draft'),
    npcAiBrief: document.getElementById('forum-npc-ai-brief'),
    circleEditor: document.getElementById('forum-circle-editor'),
    addCircleRowBtn: document.getElementById('forum-add-circle-row'),
    circleGenerateDraftBtn: document.getElementById('forum-circle-generate-draft'),
    circleAiBrief: document.getElementById('forum-circle-ai-brief'),
    relationNetwork: document.getElementById('forum-relation-network'),
    relationList: document.getElementById('forum-relation-list'),
    addRelationBtn: document.getElementById('forum-add-relation'),
    createSpaceBtn: document.getElementById('forum-create-space-btn'),
    currentTitle: document.getElementById('forum-current-title'),
    worldSummary: document.getElementById('forum-world-summary'),
    eventTitleInput: document.getElementById('forum-event-title-input'),
    eventContentInput: document.getElementById('forum-director-input'),
    eventTotalTurnsSlider: document.getElementById('forum-event-total-turns-slider'),
    eventTotalTurnsVal: document.getElementById('forum-event-total-turns-val'),
    eventCurrentTurns: document.getElementById('forum-event-current-turns'),
    eventProgressBar: document.getElementById('forum-event-progress-bar'),
    eventProgressVal: document.getElementById('forum-event-progress-val'),
    eventStageLabel: document.getElementById('forum-event-stage-label'),
    eventEndStamp: document.getElementById('forum-event-end-stamp'),
    eventHistoryList: document.getElementById('forum-event-history-list'),
    eventStartBtn: document.getElementById('forum-director-btn'),
    eventStopBtn: document.getElementById('forum-event-stop-btn'),
    eventOutcomeBtn: document.getElementById('forum-event-outcome-btn'),
    eventAiOpenBtn: document.getElementById('forum-event-ai-open-btn'),
    eventAiModal: document.getElementById('forum-event-ai-modal'),
    eventAiCloseBtn: document.getElementById('forum-event-ai-close-btn'),
    eventAiPrompt: document.getElementById('forum-event-ai-prompt'),
    eventAiGenerateBtn: document.getElementById('forum-event-ai-generate-btn'),
    circleTabs: document.getElementById('forum-circle-tabs'),
    feed: document.getElementById('forum-feed'),
    composeBtn: document.getElementById('forum-compose-btn'),
    settingsBtn: document.getElementById('forum-settings-btn'),
    bottomNav: document.querySelector('#page-forum .forum-bottom-nav'),
    messagesContent: document.getElementById('forum-messages-content'),
    messagesBottomNav: document.querySelector('#page-forum-messages .forum-messages-bottom-nav'),
    composeText: document.getElementById('forum-compose-full-text'),
    composeTextHighlight: document.getElementById('forum-compose-text-highlight'),
    composeCircle: document.getElementById('forum-compose-full-circle'),
    composeFileInput: document.getElementById('forum-compose-file-input'),
    composeMediaGrid: document.getElementById('forum-compose-media-grid'),
    composeFakeImageBtn: document.getElementById('forum-compose-fake-image-btn'),
    composeSlidesBtn: document.getElementById('forum-compose-slides-btn'),
    composeMusicBtn: document.getElementById('forum-compose-music-btn'),
    composeTopicBtn: document.getElementById('forum-compose-topic-btn'),
    composeMentionBtn: document.getElementById('forum-compose-mention-btn'),
    composeMentionText: document.getElementById('forum-compose-mention-text'),
    composeFakeImageText: document.getElementById('forum-compose-fake-image-text'),
    composeSlidesText: document.getElementById('forum-compose-slides-text'),
    composeMusicText: document.getElementById('forum-compose-music-text'),
    memorySettingsBtn: document.getElementById('forum-memory-settings-btn'),
    modalRoot: document.getElementById('forum-modal-root')
  });
  if (els.createGrid && typeof ResizeObserver !== 'undefined' && !forumCreateGridResizeObserver) {
    forumCreateGridResizeObserver = new ResizeObserver(() => {
      if (forumCreateViewMode !== 'paged') return;
      requestAnimationFrame(() => {
        if (forumCreateViewMode === 'paged') updateForumCreateGridHeight();
      });
    });
    els.createGrid.querySelectorAll('.forum-create-slide').forEach(slide => forumCreateGridResizeObserver.observe(slide));
  }
}

function bindEvents() {
  els.addSpaceBtn?.addEventListener('click', () => openCreatePanel(true));
  els.switcherBtn?.addEventListener('click', openSpaceSwitcher);
  document.getElementById('forum-app-switcher')?.addEventListener('click', openSpaceSwitcher);
  els.enterBtn?.addEventListener('click', () => {
    const space = getCurrentSpace();
    if (!space) {
      openCreatePanel(true);
      showDynamicIsland('请先创建方案');
      return;
    }
    Forum.markContextSeen();
    showPage('page-forum');
    renderApp();
  });
  els.openIdentityPicker?.addEventListener('click', openIdentityPicker);
  els.openMemberPicker?.addEventListener('click', openMemberPicker);
  els.selectedMembers?.addEventListener('click', handleSelectedMemberAction);
  els.addNpcBtn?.addEventListener('click', addCustomNpc);
  els.deleteCustomNpcBtn?.addEventListener('click', () => {
    if (editingCustomNpcId) deleteCustomNpc(editingCustomNpcId);
  });
  els.randomCustomNpcAccountBtn?.addEventListener('click', () => {
    if (els.customNpcAccount) els.customNpcAccount.value = generateForumAccount(els.customNpcName?.value.trim() || 'npc');
  });
  els.customNpcAvatarUpload?.addEventListener('change', handleCustomNpcAvatarUpload);
  els.ordinaryNpcAvatarEntry?.addEventListener('click', openOrdinaryNpcAvatarLibraryPage);
  els.npcGenerateDraftBtn?.addEventListener('click', generateNpcDraftFromWorkbench);
  els.addRelationBtn?.addEventListener('click', openRelationCreator);
  els.relationList?.addEventListener('click', handleRelationListAction);
  els.createSpaceBtn?.addEventListener('click', createSpace);
  els.createViewToggle?.addEventListener('click', e => {
    const btn = e.target.closest('[data-create-view-mode]');
    if (!btn) return;
    forumCreateViewMode = btn.dataset.createViewMode === 'all' ? 'all' : 'paged';
    updateForumCreateView();
  });
  els.createPageTabs?.addEventListener('click', e => {
    const btn = e.target.closest('[data-create-page-tab]');
    if (!btn) return;
    activeForumCreatePage = btn.dataset.createPageTab || 'world';
    updateForumCreateView();
  });
  els.createGrid?.addEventListener('touchstart', e => {
    if (forumCreateViewMode !== 'paged' || !e.touches?.length) return;
    forumCreateTouchStartX = e.touches[0].clientX;
    forumCreateTouchStartY = e.touches[0].clientY;
  }, { passive: true });
  els.createGrid?.addEventListener('touchend', e => {
    if (forumCreateViewMode !== 'paged' || !e.changedTouches?.length) return;
    const deltaX = e.changedTouches[0].clientX - forumCreateTouchStartX;
    const deltaY = e.changedTouches[0].clientY - forumCreateTouchStartY;
    if (Math.abs(deltaX) < 48 || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) return;
    moveForumCreatePage(deltaX < 0 ? 1 : -1);
  }, { passive: true });
  let forumCreateResizeTimer = null;
  window.addEventListener('resize', () => {
    if (forumCreateResizeTimer) clearTimeout(forumCreateResizeTimer);
    forumCreateResizeTimer = setTimeout(() => updateForumCreateView({ scroll: false, instant: true }), 200);
  });
  els.addCircleRowBtn?.addEventListener('click', () => addCircleEditorRow());
  els.circleGenerateDraftBtn?.addEventListener('click', generateCircleDraftFromWorkbench);
  els.userNicknameInput?.addEventListener('input', syncDraftForumProfiles);
  els.userAccountInput?.addEventListener('input', syncDraftForumProfiles);
  els.userFamousInput?.addEventListener('change', () => {
    if (els.userFamousInput?.value === 'yes' && els.userVerifiedInput) {
      els.userVerifiedInput.checked = true;
    }
    syncDraftForumProfiles();
  });
  els.userVerifiedInput?.addEventListener('change', syncDraftForumProfiles);
  els.userOccupationInput?.addEventListener('input', syncDraftForumProfiles);
  els.userFansInput?.addEventListener('input', syncDraftForumProfiles);
  els.userBioInput?.addEventListener('input', syncDraftForumProfiles);
  els.randomUserAccountBtn?.addEventListener('click', () => {
    const identity = AppState.userIdentities.find(item => item.id === draft.identityId);
    if (els.userAccountInput) els.userAccountInput.value = generateForumAccount(identity?.name || 'user');
    syncDraftForumProfiles();
  });
  els.composeBtn?.addEventListener('click', openComposerPage);
  document.getElementById('forum-dock-compose-btn')?.addEventListener('click', openComposerPage);
  els.composeText?.addEventListener('input', updateForumComposeTextHighlight);
  els.composeText?.addEventListener('scroll', syncForumComposeTextHighlightScroll);
  els.composeFileInput?.addEventListener('change', handleForumComposeImageUpload);
  els.composeFakeImageBtn?.addEventListener('click', openForumFakeImageComposer);
  els.composeSlidesBtn?.addEventListener('click', openForumShortVideoComposer);
  els.composeMusicBtn?.addEventListener('click', openForumMusicPicker);
  els.composeTopicBtn?.addEventListener('click', insertForumComposeTopicMarker);
  els.composeMentionBtn?.addEventListener('click', openForumMentionPicker);
  document.getElementById('forum-compose-hiddenlink-toggle')?.addEventListener('change', e => {
    const detail = document.getElementById('forum-compose-hiddenlink-detail');
    if (detail) detail.style.display = e.target.checked ? 'block' : 'none';
    if (e.target.checked) renderComposeHiddenLinkPeople();
  });
  document.getElementById('forum-compose-exposure-slider')?.addEventListener('input', e => {
    const val = document.getElementById('forum-compose-exposure-val');
    if (val) val.textContent = `${e.target.value}%`;
  });
  document.getElementById('forum-compose-hiddenlink-people')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-hiddenlink-id]');
    if (!btn) return;
    const id = btn.dataset.hiddenlinkId;
    composeHiddenLinkIds = composeHiddenLinkIds.includes(id)
      ? composeHiddenLinkIds.filter(x => x !== id)
      : [...composeHiddenLinkIds, id];
    renderComposeHiddenLinkPeople();
  });
  document.getElementById('forum-compose-block-toggle-row')?.addEventListener('click', () => {
    const box = document.getElementById('forum-compose-block-people');
    if (box) box.style.display = box.style.display === 'none' ? 'flex' : 'none';
  });
  document.getElementById('forum-compose-block-people')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-block-id]');
    if (!btn) return;
    const id = btn.dataset.blockId;
    composeBlockedIds = composeBlockedIds.includes(id)
      ? composeBlockedIds.filter(x => x !== id)
      : [...composeBlockedIds, id];
    renderComposeBlockPeople();
    const label = document.getElementById('forum-compose-block-text');
    if (label) label.textContent = composeBlockedIds.length ? `已屏蔽 ${composeBlockedIds.length} 人` : '';
  });
  els.settingsBtn?.addEventListener('click', openSettings);
  els.memorySettingsBtn?.addEventListener('click', openForumMemorySettings);
  document.getElementById('forum-ai-gen-btn')?.addEventListener('click', openForumHomeAiMenu);
  els.eventTotalTurnsSlider?.addEventListener('input', () => {
    const total = Math.max(3, Math.min(60, Number(els.eventTotalTurnsSlider.value) || 20));
    if (els.eventTotalTurnsVal) els.eventTotalTurnsVal.textContent = `${total}`;
    renderForumActiveEventPanel(getCurrentSpace(), { preserveInputs: true });
  });
  els.eventStartBtn?.addEventListener('click', startForumActiveEvent);
  els.eventStopBtn?.addEventListener('click', stopForumActiveEvent);
  els.eventOutcomeBtn?.addEventListener('click', openForumEventOutcomeSheet);
  els.eventHistoryList?.addEventListener('click', handleForumEventHistoryAction);
  document.querySelectorAll('.forum-world-panel, .forum-event-status-panel').forEach(panel => {
    panel.addEventListener('toggle', event => {
      if (!event.currentTarget.open) return;
      const space = getCurrentSpace();
      renderForumActiveEventPanel(space, { force: true });
      renderForumWorldBookCallLogs(space, { force: true });
    });
  });
  els.eventAiOpenBtn?.addEventListener('click', openForumEventAiModal);
  els.eventAiCloseBtn?.addEventListener('click', closeForumEventAiModal);
  els.eventAiModal?.addEventListener('click', e => {
    if (e.target === els.eventAiModal) closeForumEventAiModal();
  });
  els.eventAiGenerateBtn?.addEventListener('click', generateForumEventDraftWithAI);
  els.feed?.addEventListener('click', e => {
    const tabBtn = e.target.closest('.forum-circle-tabs [data-circle]');
    if (tabBtn) {
      activeCircle = tabBtn.dataset.circle;
      renderApp();
      return;
    }
    handleFeedClick(e);
  });
  const handleForumNavClick = e => {
    const btn = e.target.closest('[data-forum-view]');
    if (!btn) return;
    const nextView = btn.dataset.forumView;
    if (nextView === 'compose') {
      Forum.markContextSeen();
      openComposerPage();
      return;
    }
    activeView = nextView;
    if (activeView === 'messages') {
      activeDmTargetId = null;
      activeDmTargetName = '';
      openMessagesPage();
      return;
    }
    if (activeView !== 'messages') {
      activeDmTargetId = null;
      activeDmTargetName = '';
    }
    activeCircle = activeView === 'feed' ? activeCircle : 'all';
    Forum.markContextSeen();
    showPage('page-forum');
    renderApp();
  };
  els.bottomNav?.addEventListener('click', handleForumNavClick);
  els.messagesBottomNav?.addEventListener('click', handleForumNavClick);
}

function getForumHomeMainActors(space) {
  return (space?.members || []).filter(member => member?.id && !isForumTemporaryOrdinaryMember(member));
}

function getForumPeopleRosterForPrompt(space) {
  if (!space) return '';
  const identity = currentIdentity();
  const userId = `user_${identity?.id}`;
  const userProfile = space.forumProfiles?.[userId] || {};
  const people = [
    identity && {
      name: getForumDisplayName(space, userId, identity.name),
      account: getForumAccount(space, userId, identity.name),
      realName: getCurrentForumUser(space)?.isAlias ? '' : (identity.name || ''),
      type: '用户',
      isFamous: Boolean(userProfile.isFamous),
      occupation: userProfile.occupation || '',
      fans: normalizeFansCount(userProfile.fans),
      bio: userProfile.bio || ''
    },
    ...getForumHomeMainActors(space).map(member => {
      const profile = space.forumProfiles?.[member.id] || {};
      return {
        name: getForumDisplayName(space, member.id, member.name),
        account: getForumAccount(space, member.id, member.name),
        realName: member.name || '',
        type: member.type || '角色',
        isFamous: Boolean(profile.isFamous || member.isFamous),
        occupation: profile.occupation || member.occupation || '',
        fans: normalizeFansCount(profile.fans ?? member.fans)
      };
    })
  ].filter(Boolean);
  return people.map(person => [
    `- ${person.name} (@${person.account})`,
    `类型：${person.type}`,
    `是否名人：${person.isFamous ? '是' : '否'}`,
    `职业身份：${person.occupation || '未设置'}`,
    `基础粉丝量：${person.fans || 0}`,
    person.realName && person.realName !== person.name ? `本名/熟人称呼：${person.realName}（只有角色和主要NPC知道，路人不知道）` : ''
  ].filter(Boolean).join('；')).join('\n');
}

function getForumActorRelationsText(space, actorId) {
  return (space.relations || []).filter(rel => rel.from === actorId || rel.to === actorId)
    .map(rel => {
      const otherId = rel.from === actorId ? rel.to : rel.from;
      const otherName = findForumPersonName(space, otherId) || '未知人物';
      return `- 和 ${otherName}：${rel.label}`;
    }).join('\n') || '无';
}

function normalizeForumActiveEvent(event) {
  const source = event && typeof event === 'object' ? event : {};
  const totalTurns = Math.max(3, Math.min(60, Number(source.totalTurns) || DEFAULT_FORUM_ACTIVE_EVENT.totalTurns));
  return {
    title: String(source.title || '').trim(),
    content: String(source.content || '').trim(),
    totalTurns,
    currentTurns: Math.max(0, Math.min(totalTurns, Number(source.currentTurns) || 0)),
    isActive: Boolean(source.isActive),
    endedAt: source.endedAt || null,
    publicOutcome: String(source.publicOutcome || '').trim()
  };
}

function normalizeForumEventHistory(history) {
  return (Array.isArray(history) ? history : [])
    .map(item => {
      const memoryTurns = Math.max(1, Math.min(300, Number(item?.memoryTurns) || DEFAULT_FORUM_EVENT_MEMORY_TURNS));
      const ageTurns = Math.max(0, Number(item?.ageTurns) || 0);
      return {
        id: String(item?.id || `event_history_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
        title: String(item?.title || '').trim(),
        process: String(item?.process || item?.content || '').trim(),
        publicOutcome: String(item?.publicOutcome || '').trim(),
        endedAt: Number(item?.endedAt) || Date.now(),
        memoryTurns,
        ageTurns,
        forgottenAt: item?.forgottenAt || (ageTurns >= memoryTurns ? Date.now() : null)
      };
    })
    .filter(item => item.title)
    .slice(-20);
}

function getForumActiveEventProgress(space) {
  const event = normalizeForumActiveEvent(space?.activeEvent);
  const progress = event.totalTurns ? Math.max(0, Math.min(1, event.currentTurns / event.totalTurns)) : 0;
  return { event, progress, percent: Math.round(progress * 100) };
}

function getForumActiveEventStage(progress, isActive = true) {
  if (!isActive) return '未启动';
  if (progress < 0.3) return '暗流涌动';
  if (progress < 0.7) return '小道消息';
  return '全网吃瓜';
}

function isForumEventHistoryForgotten(item) {
  return Boolean(item?.forgottenAt) || Number(item?.ageTurns || 0) >= Number(item?.memoryTurns || DEFAULT_FORUM_EVENT_MEMORY_TURNS);
}

function getForumEventMemoryLabel(item) {
  if (isForumEventHistoryForgotten(item)) return '已遗忘';
  const remaining = Math.max(0, Number(item.memoryTurns || DEFAULT_FORUM_EVENT_MEMORY_TURNS) - Number(item.ageTurns || 0));
  return `${remaining} 轮后失效`;
}

function renderForumActiveEventPanel(space, options = {}) {
  if (!space) return;
  const { event, progress, percent } = getForumActiveEventProgress(space);
  const totalFromSlider = Math.max(3, Math.min(60, Number(els.eventTotalTurnsSlider?.value) || event.totalTurns));
  const displayTotalTurns = options.preserveInputs ? totalFromSlider : event.totalTurns;
  const displayProgress = displayTotalTurns ? Math.max(0, Math.min(1, event.currentTurns / displayTotalTurns)) : progress;
  const displayPercent = Math.round(displayProgress * 100);
  const historyKey = normalizeForumEventHistory(space?.activeEventHistory)
    .map(item => `${item.id}:${item.updatedAt || item.endedAt || ''}:${item.ageTurns || 0}:${item.memoryTurns || 0}:${item.forgottenAt || ''}:${item.publicOutcome || ''}`)
    .join('|');
  const renderKey = `${space.id || 'space'}:${event.title}:${event.content}:${event.totalTurns}:${event.currentTurns}:${event.isActive ? 1 : 0}:${event.endedAt || ''}:${event.publicOutcome || ''}:${displayTotalTurns}:${historyKey}`;
  if (!options.preserveInputs && !options.force && forumActiveEventPanelRenderKey === renderKey) return;
  if (!options.preserveInputs) forumActiveEventPanelRenderKey = renderKey;
  if (!options.preserveInputs) {
    if (els.eventTitleInput) els.eventTitleInput.value = event.title;
    if (els.eventContentInput) els.eventContentInput.value = event.content;
    if (els.eventTotalTurnsSlider) els.eventTotalTurnsSlider.value = `${event.totalTurns}`;
  }
  if (els.eventTotalTurnsVal) els.eventTotalTurnsVal.textContent = `${displayTotalTurns}`;
  if (els.eventCurrentTurns) els.eventCurrentTurns.textContent = `${event.currentTurns}`;
  if (els.eventProgressBar) els.eventProgressBar.style.width = `${displayPercent}%`;
  if (els.eventProgressVal) {
    els.eventProgressVal.textContent = `${displayPercent}%`;
    els.eventProgressVal.classList.remove('is-ticking');
    void els.eventProgressVal.offsetWidth;
    els.eventProgressVal.classList.add('is-ticking');
  }
  const isEnded = Boolean(event.endedAt) || (!event.isActive && event.title && event.currentTurns >= event.totalTurns);
  if (els.eventStageLabel) els.eventStageLabel.textContent = isEnded ? '已结束' : getForumActiveEventStage(displayProgress, event.isActive);
  els.eventStartBtn?.closest('.forum-event-planner')?.classList.toggle('is-ended', isEnded);
  if (els.eventEndStamp) {
    els.eventEndStamp.hidden = !isEnded;
    els.eventEndStamp.textContent = event.publicOutcome ? '已结束 · 后续已记录' : '已结束 · 后续待记录';
  }
  const hasPendingHistory = normalizeForumEventHistory(space?.activeEventHistory).some(item => !item.publicOutcome && !isForumEventHistoryForgotten(item));
  els.eventStartBtn?.classList.toggle('is-active', event.isActive);
  els.eventStartBtn?.classList.toggle('is-ended', isEnded);
  if (els.eventStartBtn) els.eventStartBtn.textContent = event.isActive ? '更新事件' : '引爆事件';
  els.eventStopBtn?.toggleAttribute('disabled', !event.isActive);
  if (els.eventOutcomeBtn) {
    els.eventOutcomeBtn.hidden = !(isEnded || hasPendingHistory);
    els.eventOutcomeBtn.textContent = isEnded ? '记录后续' : '补记历史后续';
  }
  renderForumEventHistoryList(space);
}

function renderForumEventHistoryList(space) {
  if (!els.eventHistoryList) return;
  const history = normalizeForumEventHistory(space?.activeEventHistory);
  if (!history.length) {
    els.eventHistoryList.innerHTML = '<p class="forum-empty">还没有结束的大事件。</p>';
    return;
  }
  els.eventHistoryList.innerHTML = history.slice().reverse().map(item => `
    <article class="forum-event-history-item ${isForumEventHistoryForgotten(item) ? 'is-forgotten' : ''}">
      <b>${escapeHTML(item.title)}</b>
      <div class="forum-event-history-meta">
        <span>${escapeHTML(formatForumProfileDate(item.endedAt))}</span>
        <em>${escapeHTML(getForumEventMemoryLabel(item))}</em>
      </div>
      ${item.process ? `<div class="forum-event-history-block"><span class="forum-event-history-tag">事件经过</span><p>${escapeHTML(item.process)}</p></div>` : ''}
      <div class="forum-event-history-block"><span class="forum-event-history-tag">事件后续</span><p>${escapeHTML(item.publicOutcome || '后续还没有记录，NPC 暂时只知道这件事已经告一段落。')}</p></div>
      <div class="forum-event-history-actions">
        <button type="button" data-event-history-action="edit" data-event-history-id="${escapeHTML(item.id)}">编辑</button>
        <button type="button" data-event-history-action="delete" data-event-history-id="${escapeHTML(item.id)}">删除</button>
      </div>
    </article>
  `).join('');
}

function buildForumActiveEventPrompt(space, target = 'feed') {
  const { event, progress, percent } = getForumActiveEventProgress(space);
  if (!event.isActive || !event.title || !event.content) return '';
  const stage = getForumActiveEventStage(progress, true);
  if (target === 'comment') {
    const commentRule = progress < 0.3
      ? 'Some netizens have only heard fragments. Mention it only inside comment sections whose post/circle/community is plausibly connected to this event. If the current post is unrelated, do NOT mention this event.'
      : progress < 0.7
        ? 'Rumors are circulating. A few comments may bring up guesses, jokes, or indirect references ONLY when the current post is about a related circle, person, industry, location, fandom, workplace, or topic. If the post is unrelated, stay on the post.'
        : 'The event is public, but relevance still matters. Related posts can have many comments about it; unrelated posts should usually ignore it, with at most a rare light reference only if the forum culture makes that realistic.';
    return `
# ACTIVE BIG EVENT - gradual comment infiltration
Event headline: ${event.title}
Behind the scenes truth: ${event.content}
Exposure progress: ${percent}% (${stage}), turn ${event.currentTurns}/${event.totalTurns}
${commentRule}
Do NOT reveal the behind-the-scenes truth unless the current exposure stage makes that information public. Ordinary passers may guess, misunderstand, deny, joke, or spread incomplete information.`;
  }
  const feedRule = progress < 0.3
    ? 'Do NOT make this event a post topic yet. Only a very small number of sharp passers may hint at it inside comments under posts whose circle/community is plausibly related to the event, with vague wording and no complete facts.'
    : progress < 0.7
      ? 'In the 6-9 posts you generate, exactly 1-2 posts MUST be leaks, questions, gossip, or speculation about this event, and those posts MUST belong to a plausibly related circle/community/topic. All other posts remain normal daily life.'
      : 'This event has exploded. In the 6-9 posts you generate, exactly half of the posts (3-4 posts) MUST discuss this event from different angles, and they MUST be placed in plausibly related circles/communities/topics: evidence, denial, unfollowing, jokes, timeline sorting, or onlookers eating melon. NEVER exceed half; the remaining half MUST be completely unrelated daily posts.';
  return `
# ACTIVE BIG EVENT - gradual feed infiltration
Event headline: ${event.title}
Behind the scenes truth: ${event.content}
Exposure progress: ${percent}% (${stage}), turn ${event.currentTurns}/${event.totalTurns}
${feedRule}
Important: ordinary netizens do not have God's-view knowledge. Let information leak progressively through incomplete evidence, hearsay, screenshots, denials, and guesses.`;
}

function buildForumEventHistoryPrompt(space) {
  const history = normalizeForumEventHistory(space?.activeEventHistory)
    .filter(item => item.publicOutcome && !isForumEventHistoryForgotten(item))
    .slice(-8);
  if (!history.length) return '';
  return `
# PUBLIC BIG EVENT HISTORY - already-established common knowledge (NPCs ALREADY know this)
The past big events below, together with their PUBLIC AFTERMATH, are now SETTLED public facts on this forum. Ordinary NPCs and passers ALREADY know these outcomes as everyday common sense — treat them as things everyone has already seen and discussed.
CRITICAL: When the current post or discussion is about one of these events (its people, topic, or the same drama), NPCs MUST talk like people who already know the aftermath — reference it, react to it, argue about it, build on it. They MUST NEVER act clueless, ask "what happened", pretend the result hasn't come out, or wait for the user to explain it. The aftermath is public knowledge, not a secret.
Only when the current post is genuinely UNRELATED should NPCs leave an event alone (do NOT drag an unrelated event's aftermath into an unrelated post).
${history.map(item => `- ${item.title}${item.process ? `（经过：${item.process}）` : ''}：${item.publicOutcome}`).join('\n')}`;
}
function archiveForumActiveEvent(space, event) {
  if (!space || !event?.title) return;
  const endedAt = Number(event.endedAt) || Date.now();
  space.activeEventHistory = normalizeForumEventHistory(space.activeEventHistory);
  const existed = space.activeEventHistory.some(item => item.title === event.title && Math.abs(Number(item.endedAt) - endedAt) < 2000);
  if (existed) return;
  space.activeEventHistory.push({
    id: `event_history_${endedAt}_${Math.random().toString(36).slice(2, 7)}`,
    title: event.title,
    process: event.content || '',
    publicOutcome: event.publicOutcome || '',
    endedAt,
    memoryTurns: DEFAULT_FORUM_EVENT_MEMORY_TURNS,
    ageTurns: 0,
    forgottenAt: null
  });
  space.activeEventHistory = normalizeForumEventHistory(space.activeEventHistory);
}

function advanceForumEventHistoryMemory(space) {
  if (!space) return false;
  const history = normalizeForumEventHistory(space.activeEventHistory);
  if (!history.length) {
    space.activeEventHistory = history;
    return false;
  }
  let changed = false;
  space.activeEventHistory = history.map(item => {
    if (isForumEventHistoryForgotten(item)) return item;
    const nextAgeTurns = Math.min(item.memoryTurns, Number(item.ageTurns || 0) + 1);
    const nextItem = {
      ...item,
      ageTurns: nextAgeTurns,
      forgottenAt: nextAgeTurns >= item.memoryTurns ? Date.now() : null
    };
    changed = true;
    return nextItem;
  });
  return changed;
}

function advanceForumActiveEvent(space) {
  advanceForumEventHistoryMemory(space);
  if (!space?.activeEvent?.isActive) return false;
  const event = normalizeForumActiveEvent(space.activeEvent);
  if (!event.title || !event.content) return false;
  event.currentTurns = Math.min(event.totalTurns, event.currentTurns + 1);
  if (event.currentTurns >= event.totalTurns) {
    event.isActive = false;
    event.endedAt = Date.now();
    archiveForumActiveEvent(space, event);
    space.activeEvent = { ...DEFAULT_FORUM_ACTIVE_EVENT };
    showDynamicIsland('大事件已进入终局');
    renderForumActiveEventPanel(space);
    return true;
  }
  space.activeEvent = event;
  renderForumActiveEventPanel(space);
  return true;
}

async function startForumActiveEvent() {
  const space = getCurrentSpace();
  if (!space) return showDynamicIsland('请先进入一个论坛方案');
  const title = els.eventTitleInput?.value.trim() || '';
  const content = els.eventContentInput?.value.trim() || '';
  if (!title) return showDynamicIsland('先写事件标题');
  if (!content) return showDynamicIsland('先写事件内情');
  const previous = normalizeForumActiveEvent(space.activeEvent);
  const totalTurns = Math.max(3, Math.min(60, Number(els.eventTotalTurnsSlider?.value) || previous.totalTurns));
  const isSameEvent = previous.title === title && previous.content === content;
  space.activeEvent = {
    title,
    content,
    totalTurns,
    currentTurns: isSameEvent ? Math.min(previous.currentTurns, totalTurns) : 0,
    isActive: true,
    endedAt: null,
    publicOutcome: ''
  };
  await saveState();
  renderForumActiveEventPanel(space);
  showDynamicIsland(isSameEvent ? '事件设置已更新' : '大事件开始发酵');
}

async function stopForumActiveEvent() {
  const space = getCurrentSpace();
  if (!space) return;
  space.activeEvent = { ...normalizeForumActiveEvent(space.activeEvent), isActive: false };
  await saveState();
  renderForumActiveEventPanel(space);
  showDynamicIsland('已停止发酵');
}

function getLatestForumEndedEvent(space) {
  const current = normalizeForumActiveEvent(space?.activeEvent);
  if (current.title && (current.endedAt || current.currentTurns >= current.totalTurns) && !current.isActive) {
    return { source: 'current', event: current };
  }
  const history = normalizeForumEventHistory(space?.activeEventHistory);
  const latest = history.slice().reverse().find(item => !item.publicOutcome) || history[history.length - 1];
  return latest ? { source: 'history', event: latest } : null;
}

function openForumEventOutcomeSheet() {
  const space = getCurrentSpace();
  const target = getLatestForumEndedEvent(space);
  if (!space || !target?.event) return showDynamicIsland('还没有结束的大事件');
  const event = { ...target.event };
  if (target.source === 'current') {
    event.endedAt = event.endedAt || Date.now();
    archiveForumActiveEvent(space, event);
    space.activeEvent = { ...DEFAULT_FORUM_ACTIVE_EVENT };
    saveState();
    renderForumActiveEventPanel(space);
  }
  openSheet('大事件后续处理', `
    <div class="forum-event-outcome-form">
      <p>这段会进入“大事件历史”。到失效轮数前，普通 NPC 在相关话题里可以知道。</p>
      <label>大事件</label>
      <input id="forum-event-outcome-title" type="text" value="${escapeHTML(event.title || '')}" readonly>
      <label>公开后续</label>
      <textarea id="forum-event-outcome-text" rows="5" placeholder="例如：双方发了联合声明，热搜降温，但粉圈还在争议时间线。">${escapeHTML(event.publicOutcome || '')}</textarea>
      <label>几轮后失效</label>
      <input id="forum-event-outcome-memory-turns" type="number" min="1" max="300" value="${Math.max(1, Math.min(300, Number(event.memoryTurns) || DEFAULT_FORUM_EVENT_MEMORY_TURNS))}">
      <button id="forum-event-outcome-save" class="forum-primary-btn" type="button">保存到大事件历史</button>
    </div>
  `, root => {
    root.querySelector('#forum-event-outcome-save')?.addEventListener('click', async () => {
      const publicOutcome = root.querySelector('#forum-event-outcome-text')?.value.trim() || '';
      if (!publicOutcome) return showDynamicIsland('先写公开后续');
      const memoryTurns = Math.max(1, Math.min(300, Number(root.querySelector('#forum-event-outcome-memory-turns')?.value) || DEFAULT_FORUM_EVENT_MEMORY_TURNS));
      space.activeEventHistory = normalizeForumEventHistory(space.activeEventHistory);
      let historyItem = space.activeEventHistory[space.activeEventHistory.length - 1];
      if (!historyItem || historyItem.title !== event.title) {
        historyItem = {
          id: `event_history_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          title: event.title,
          publicOutcome: '',
          endedAt: Number(event.endedAt) || Date.now(),
          memoryTurns,
          ageTurns: 0,
          forgottenAt: null
        };
        space.activeEventHistory.push(historyItem);
      }
      historyItem.publicOutcome = publicOutcome;
      historyItem.memoryTurns = memoryTurns;
      if (Number(historyItem.ageTurns || 0) < memoryTurns) historyItem.forgottenAt = null;
      await saveState();
      renderForumActiveEventPanel(space);
      closeModal();
      showDynamicIsland('后续已记录');
    });
  }, '稍后再写');
}

function handleForumEventHistoryAction(event) {
  const button = event.target.closest('[data-event-history-action]');
  if (!button) return;
  const id = button.dataset.eventHistoryId;
  if (!id) return;
  if (button.dataset.eventHistoryAction === 'edit') {
    openForumEventHistoryEditor(id);
  } else if (button.dataset.eventHistoryAction === 'delete') {
    deleteForumEventHistoryItem(id);
  }
}

function openForumEventHistoryEditor(historyId) {
  const space = getCurrentSpace();
  if (!space) return;
  const history = normalizeForumEventHistory(space.activeEventHistory);
  const item = history.find(entry => entry.id === historyId);
  if (!item) return showDynamicIsland('找不到这条历史');
  openSheet('编辑大事件历史', `
    <div class="forum-event-outcome-form">
      <p>这里是普通 NPC 可以知道的公开事件结果；失效后不会再进入后续论坛生成。</p>
      <label>事件标题</label>
      <input id="forum-event-history-edit-title" type="text" value="${escapeHTML(item.title || '')}">
      <label>公开后续</label>
      <textarea id="forum-event-history-edit-outcome" rows="5" placeholder="写这个事件公开后的结果、余波、圈内共识。">${escapeHTML(item.publicOutcome || '')}</textarea>
      <label>几轮后失效</label>
      <input id="forum-event-history-edit-memory-turns" type="number" min="1" max="300" value="${escapeHTML(String(item.memoryTurns || DEFAULT_FORUM_EVENT_MEMORY_TURNS))}">
      <button id="forum-event-history-edit-save" class="forum-primary-btn" type="button">保存修改</button>
    </div>
  `, root => {
    root.querySelector('#forum-event-history-edit-save')?.addEventListener('click', async () => {
      const title = root.querySelector('#forum-event-history-edit-title')?.value.trim() || '';
      const publicOutcome = root.querySelector('#forum-event-history-edit-outcome')?.value.trim() || '';
      if (!title) return showDynamicIsland('事件标题不能为空');
      const memoryTurns = Math.max(1, Math.min(300, Number(root.querySelector('#forum-event-history-edit-memory-turns')?.value) || DEFAULT_FORUM_EVENT_MEMORY_TURNS));
      space.activeEventHistory = normalizeForumEventHistory(space.activeEventHistory).map(entry =>
        entry.id === historyId
          ? { ...entry, title, publicOutcome, memoryTurns, forgottenAt: Number(entry.ageTurns || 0) >= memoryTurns ? (entry.forgottenAt || Date.now()) : null }
          : entry
      );
      await saveState();
      renderForumActiveEventPanel(space);
      closeModal();
      showDynamicIsland('历史事件已更新');
    });
  }, '取消');
}

async function deleteForumEventHistoryItem(historyId) {
  const space = getCurrentSpace();
  if (!space) return;
  const history = normalizeForumEventHistory(space.activeEventHistory);
  const item = history.find(entry => entry.id === historyId);
  if (!item) return showDynamicIsland('找不到这条历史');
  if (!confirm(`确定删除大事件历史「${item.title}」吗？删除后 NPC 不会再把它当作公共知识。`)) return;
  space.activeEventHistory = history.filter(entry => entry.id !== historyId);
  await saveState();
  renderForumActiveEventPanel(space);
  showDynamicIsland('历史事件已删除');
}

function openForumEventAiModal() {
  if (!els.eventAiModal) return;
  els.eventAiModal.style.display = 'flex';
  requestAnimationFrame(() => {
    els.eventAiModal.style.opacity = '1';
    els.eventAiPrompt?.focus();
  });
}

function closeForumEventAiModal() {
  if (!els.eventAiModal) return;
  els.eventAiModal.style.opacity = '0';
  setTimeout(() => {
    if (els.eventAiModal) els.eventAiModal.style.display = 'none';
  }, 180);
}

async function generateForumEventDraftWithAI() {
  const space = getCurrentSpace();
  if (!space) return showDynamicIsland('请先进入一个论坛方案');
  const userDirection = els.eventAiPrompt?.value.trim() || '';
  const existingEvent = normalizeForumActiveEvent(space.activeEvent);
  const prompt = `You are an event director for a Chinese forum-fiction simulator.
Create ONE upcoming big event that fits the existing forum world and can gradually leak into posts/comments.

[Forum world]
论坛方案：${space.name || '未命名论坛'}
世界观：${space.world || '无'}
主要人物：
${getForumPeopleRosterForPrompt(space) || '无'}
可用圈子：
${(space.circles || []).map(circle => `- ${circle.name}：${circle.desc || ''}`).join('\n') || '无'}
用户想看的方向：${userDirection || '无特别要求，请结合当前设定推演一个自然的大事件'}
当前表单里的旧事件：${existingEvent.title ? `${existingEvent.title}\n${existingEvent.content}` : '无'}

Return ONLY a JSON object:
{
  "title": "抓人的事件标题，中文，短一点",
  "content": "事件真实内幕：谁做了什么、动机、隐藏秘密、哪些证据会逐步曝光。中文，具体但不要写成长篇小说。",
  "suggestedTurns": 10
}
suggestedTurns must be an integer from 3 to 60.`;
  const btn = els.eventAiGenerateBtn;
  const oldText = btn?.textContent || '';
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = '生成中...';
    }
    showDynamicIsland('正在构思事件...');
    const raw = await sendForumCommentPromptToAI(prompt);
    const parsed = JSON.parse(String(raw || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/)?.[0] || '{}');
    const title = String(parsed.title || '').trim();
    const content = String(parsed.content || '').trim();
    const suggestedTurns = Math.max(3, Math.min(60, Number(parsed.suggestedTurns) || 20));
    if (!title || !content) throw new Error('Event draft missing fields');
    if (els.eventTitleInput) els.eventTitleInput.value = title;
    if (els.eventContentInput) els.eventContentInput.value = content;
    if (els.eventTotalTurnsSlider) els.eventTotalTurnsSlider.value = `${suggestedTurns}`;
    if (els.eventTotalTurnsVal) els.eventTotalTurnsVal.textContent = `${suggestedTurns}`;
    closeForumEventAiModal();
    renderForumActiveEventPanel(space, { preserveInputs: true });
    showDynamicIsland('事件草案已填入');
  } catch (error) {
    console.error('Forum event assistant failed:', error);
    showDynamicIsland('生成失败，请检查 API 设置');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || '开始生成';
    }
  }
}

async function buildForumHomeActorPrivateContext(space, worldBookData) {
  const actors = getForumHomeMainActors(space);
  if (!actors.length) return '无';
  const blocks = [];
  for (const member of actors) {
    const name = getForumDisplayName(space, member.id, member.name);
    let memory = '无';
    try {
      memory = await getMemoriesForPrompt(member.sourceId || member.id) || '无';
    } catch (error) {
      console.warn('Forum home memory read failed:', member.id, error);
    }
    blocks.push(`<PrivateActor name="${name}">
只允许 ${name} 本人发帖或评论时使用这一段；普通 NPC、路人、其他角色都不能知道、引用或暗示。
人设：${getForumMemberPersona(member) || '无'}
记忆：${memory}
私有世界书：${worldBookData.privateTexts?.[member.id] || '无'}
关系：${getForumActorRelationsText(space, member.id)}
</PrivateActor>`);
  }
  return blocks.join('\n\n');
}

async function buildForumFeedPrompt(space) {
  const mainActors = getForumHomeMainActors(space);
  const worldBookData = await resolveForumWorldBookPromptData(space, {
    label: '首页帖子生成',
    privateMemberIds: mainActors.map(member => member.id)
  });
  const publicContext = [
    `[论坛方案] ${space?.name || '未命名方案'}`,
    `[世界观] ${space?.world || '无'}`,
    worldBookData.publicText ? `[公共世界书]\n${worldBookData.publicText}` : '',
    `[关系状态] ${formatCoupleLine(space)}`
  ].filter(Boolean).join('\n');
  const privateActorContext = await buildForumHomeActorPrivateContext(space, worldBookData);
  const eventHistoryRule = buildForumEventHistoryPrompt(space);
  const activeEventRule = buildForumActiveEventPrompt(space, 'feed');
  const forumTrendRule = getForumTrendsForDmPrompt(space);
  return `You are a talented forum/BBS-style fiction writer. Your signature skill is "capturing a character" — not reciting their profile, but nailing their speech rhythm, tiny quirks and emotional pace so that when readers see a post they instantly feel "yes, only THIS person would post this". You never write template-y, AI-flavored content. Every post you write reads like a real living person just finished typing on their phone. Today you're writing another batch of forum posts.

# Language & translation rules (obey exactly)
This forum is primarily Chinese-language. The vast majority of posts and comments MUST be written in Chinese. Only when a character's persona / worldview / circle culture explicitly requires non-Standard-Mandarin speech (e.g. Cantonese, dialect, foreign language, classical/wenyan) may the "content" field keep that original language. Whenever "content" is NOT Standard Mandarin, you MUST fill the SAME item's "translation" field with the Standard Mandarin equivalent. If "content" is already Standard Mandarin, "translation" MUST be an empty string. This applies to every post and every comment.

# Character portrayal principles (most important for core characters / main NPCs)
1. Capture the way they SPEAK, don't recite their profile. Extremely colloquial, short and fragmented, subject often omitted. No textbook grammar. No "As a XX, I..." intros.
2. Emotions stay restrained and everyday. No shouting, no theatrics, no meltdown. When upset, go QUIETER, not louder.
3. STRICT brain isolation: each core character / main NPC may only use their own persona, memory, and private lore. NEVER borrow another person's private material. NEVER speak on someone else's behalf or explain their inner feelings.
4. Private information appears ONLY when that person themselves is posting. Ordinary NPCs and passers must not know, hint at, or reference it in any way.
5. Posts must fit the character's PUBLIC identity: profession, celebrity status, fan base size, and their publicly known relationships. A celebrity should not speak like an unknown netizen, and an unknown person should not speak like a celebrity.

${publicContext}
${eventHistoryRule}
${activeEventRule}
${forumTrendRule ? `${forumTrendRule}
Use these trends as PUBLIC background knowledge only: people may know what is happening if asked or if a post is clearly related, but the home feed must NOT start broadly posting about these trends just because they are listed here. Do NOT generate trend-related posts unless the user's generation direction explicitly asks for it, an active event requires it, or the idea is naturally unavoidable in this forum world. Keep most posts ordinary daily life and unrelated world activity.` : ''}

[Publicly visible people roster]
${getForumPeopleRosterForPrompt(space)}
[Character fixed aliases — for alias posts]
${mainActors
  .map(member => {
    const alias = getForumCharacterFixedAlias(space, member.id);
    if (!alias) return '';
    return `- ${getForumDisplayName(space, member.id, member.name)} 的固定小号：${alias.name}(@${alias.account})，签名：${alias.bio || '无'}`;
  })
  .filter(Boolean)
  .join('\n') || '无角色设置了固定小号'}
[Private profiles of core characters / main NPCs — strictly isolated]
Ordinary NPCs and passers CANNOT read any of the private material below. Only when that specific core character / main NPC themselves is posting or commenting may they use their OWN section of persona / memory / private lore.
${privateActorContext}

[Whitelist of core-character / main-NPC display names]
${mainActors
  .map(member => `- ${getForumDisplayName(space, member.id, member.name)}`)
  .join('\n') || '无'}

[Available circles]
${(space.circles || []).map(c => `- ${c.name}：${c.desc || ''}`).join('\n') || '无（可留空）'}

# Your task
Write 6 to 9 posts that feel like they are "happening right now" in this forum world, simulating a real social-media home feed. For every post, also write 3 to 6 comments underneath, so each post already looks like a lively discussion.

# Hard rules (must obey)
1. 【NEVER post or comment as the user】The user is the person whose type is "用户" in the roster. No post author or comment author may be the user, may reuse the user's nickname / account, or speak in the user's first person.
2. Ordinary NPCs / ordinary passer accounts are the ABSOLUTE majority of authors. In the 6-9 posts, at least 5 must be brand-new ordinary NPCs you invent (fandom people, fans, antis, shop staff, classmates, coworkers, local witnesses, passing netizens, insiders...). Their identity is "ordinaryNpc".
3. Core characters / main NPCs may appear as authors AT MOST 1-2 times TOTAL (never more than 2). Their display names MUST come exactly from the [Whitelist of core-character / main-NPC display names] above. Do NOT let core characters flood the feed.
3b. 【Character alias posts】A core character who has a fixed alias (listed in [Publicly visible people roster] under "固定小号") MAY appear as the post author using that alias. When doing so: set identity="alias", authorName=the alias name, realName=the character's real display name from the whitelist. Alias posts are more private, vulnerable, low-key and closer to the character's inner self — like a secret diary entry that happens to be public. They must NOT expose the character's real identity through content. This counts toward the 1-2 core character limit.
3c. 【Verified badge】If a person in [Publicly visible people roster] has "是否名人: 是", their post SHOULD have "isVerified": true. For ordinary NPCs and alias posts, set "isVerified": false.
4. Ordinary NPCs are NOT core characters — they don't appear on any whitelist. Give them natural Chinese forum handles / usernames. Never label them "路人甲 / 网友A / 普通NPC".
5. Comments are also dominated by ordinary NPCs / passers. The overwhelming majority of "identity" in comments should be "passer" or "ordinaryNpc". Across the whole batch, core characters / main NPCs may leave AT MOST 1 comment total, and the user leaves 0.
6. Nail identity differences: core characters may only use their own private persona / memory / private lore in their OWN post/comment. Ordinary NPCs speak based on their circle, profession, fan/anti stance, and their distance from the gossip — like real netizens. They are NOT omniscient and must not know any private material.
7. All three post types must appear and mix naturally:
   - text: pure-text venting / sharing / mini essays / gossip drops
   - image: image-post whose "image" is described in words (you write what the fake image contains)
   - video: text short-video described page-by-page as a mini storyboard
8. 【Worldview fit + big-world feel + celebrity mechanic — most important rule for TOPIC choice】
   a) Worldview first: every post must feel like something that would REALLY happen inside this forum world. Tone, topics, circle culture, era and lifestyle must fit the [世界观] above. NEVER drop in modern generic memes that don't belong here — e.g. no "milk-tea check-in / grad-school exam / subway commute" in an ancient-fantasy world; no "burning incense / TCM tonics" in a cyberpunk world; and vice versa. Test: would a normal person actually LIVING in this world read this post and feel "this is exactly the stuff happening around me"?
   b) This is a BIG world, NOT the protagonist's fan-group. The forum is the public square of the entire world. Most ordinary NPCs should be posting about OTHER things in this world — local news, industry gossip, work life, daily trivia, what they bought, what they saw on the street, what they overheard, venting, late-night mood, weather, commute, overtime, pets, neighbors... NOT things revolving around the core characters or the user. Hard quota: within the 6-9 post batch, posts DIRECTLY related to core characters / the user (this includes "discussing them, mentioning them, @-ing them, leaking about them, praising them, hating them" — ALL count) may be AT MOST 0 to 2. Every other post is about this world's OWN stuff and has ZERO connection to core characters or the user.
   c) Celebrity mechanic: check each person's "是否名人" (is-celebrity) field and fan count inside [Publicly visible people roster]. Ordinary NPCs may spontaneously discuss a core character / the user ONLY IF that person is marked celebrity=YES AND has a clearly non-zero base fan count. Even for real celebrities, keep the frequency realistic — most passers are still busy with their own lives and only occasionally bring one up. If they are NOT celebrities: ordinary NPCs basically don't recognize them, don't discuss them, don't spontaneously mention them; treat them as just another ordinary person whom most passers don't even know exists. It is BETTER to have ZERO mentions of the core characters in the whole batch than to fake an "everyone is talking about the protagonist" illusion.
9. 【Anti-AI-habit】80% of posts and comments should be around 15 Chinese characters or fewer. Short sentences, spoken feel, subjects often dropped. NO textbook long sentences, NO grand summarizing. STRICTLY FORBIDDEN clichés: never write "破防了 / 绷不住了 / 蚌埠住了 / 急了 / 破大防 / 楼主急了". Low-key everyday tone is the DEFAULT.
   d) 【World is SOIL, not a script — the most important nuance about worldview】The [世界观] and [公共世界书] are the SOIL every post grows out of, NOT lines to be recited. STRICTLY FORBIDDEN: never copy, paraphrase, quote, or re-explain the worldview / lore text itself inside a post. No setting exposition dumps, no "众所周知我们这个世界…" style intros, no restating background facts that any local would take completely for granted. A real resident NEVER narrates their own world's basic rules — they just LIVE inside them and talk about their own small concrete stuff. Let the worldview surface INDIRECTLY and offhandedly: through specific daily details, local slang, complaints, habits, prices, place names, tools, and casual references that only make sense to someone living here. Think of the setting as the invisible air the post breathes — felt through concrete specifics, never announced. The worldview is a foundation that FREES you to invent endless fresh everyday scenes inside it, not a cage that forces you to keep pointing back at it. Test: if a post reads like it is introducing, summarizing, or showing off the world/lore, it FAILS — rewrite it into a lived-in, throwaway moment that just happens to belong here.
10. 【Use slang SPARINGLY】Do NOT stuff yyds / awsl / xswl / 绝绝子 / 栓Q / 尊嘟假嘟 and similar worn-out slang into every post/comment. The DEFAULT is plain natural spoken Chinese with ZERO slang. Only when a meme genuinely nails the exact vibe may ONE line use ONE meme. Never pile several slang terms into one line. When unsure, drop the slang entirely.
11. 【No echo】Before writing each new post or comment, scan what you already wrote in this batch. Do NOT repeat, paraphrase, or restate an angle, joke, feeling or meme that already appeared. Every new item MUST add a genuinely new angle. If you truly have nothing new to add, generate fewer items rather than padding with near-duplicates.
# Output format (output ONLY a JSON array, no explanation)
[
  {
    "authorName": "Ordinary NPC: your own original Chinese handle. Core character / main NPC: MUST use the display name from the whitelist above. Character alias: use the alias name from the fixed-alias list.",
    "identity": "ordinaryNpc | npc | character | alias",
    "realName": "only when identity=alias, the real character name behind the alias; otherwise empty string",
    "isVerified": false,
    "circle": "one circle name from [Available circles] above, OR empty string meaning the public feed",
    "type": "text | image | video",
    "content": "post body (colloquial, may use #topic#; keep non-Standard-Mandarin here ONLY if persona/worldview requires it)",
    "translation": "[STRICT] If content is not Standard Mandarin, put the Standard Mandarin translation here; otherwise empty string",
    "fakeImages": ["When type=image: describe what's IN each image / screenshot / text — 1 to 3 items"],
    "slides": ["When type=video: short-video pages, one line per page, 2 to 4 pages"],
    "comments": [
      {
        "speaker": "comment author display name (passer = your own original Chinese handle / character = real name from whitelist)",
        "identity": "passer | ordinaryNpc | character | npc",
        "quoteFloor": "if replying to a specific floor, its floor number; plain bottom comment = null",
        "replyTo": "if replying to a specific person, their display name; plain bottom comment = empty string",
        "content": "comment body, short and colloquial",
        "translation": "[STRICT] Same rule as post-level translation: if content is not Standard Mandarin, put the Standard Mandarin translation here; otherwise empty string",
        "likes": 0
      }
    ]
  }
]
The array length MUST be between 6 and 9. When type is NOT "image", fakeImages MUST be an empty array. When type is NOT "video", slides MUST be an empty array. Every post's "comments" MUST contain 3 to 6 items. If content contains Cantonese / dialect / foreign language / non-standard spoken Mandarin, "translation" MUST hold its Standard Mandarin translation; if content is already Standard Mandarin, "translation" MUST be an empty string. Same rule applies to every comment. The first output character MUST be [.`;
}

function createForumFeedLoadingElement(text = '正在生成新鲜帖子…') {
  const loadingEl = document.createElement('div');
  loadingEl.className = 'forum-feed-loading';
  loadingEl.innerHTML = getForumFeedLoadingInnerHtml(text);
  return loadingEl;
}

function getForumFeedLoadingInnerHtml(text = '正在生成新鲜帖子…') {
  return `
    <span class="forum-feed-loading-spinner"></span>
    <span>${escapeHTML(text)}</span>
  `;
}

function getForumFeedLoadingHtml(text = '正在生成新鲜帖子…') {
  return `<div class="forum-feed-loading">${getForumFeedLoadingInnerHtml(text)}</div>`;
}

function removeForumFeedLoadingElements(root = document) {
  root?.querySelectorAll?.('.forum-feed-loading').forEach(item => item.remove());
}

function showForumFeedLoadingElement(loadingEl) {
  const storyRail = els.feed?.querySelector('.forum-story-rail');
  if (storyRail) {
    storyRail.after(loadingEl);
  } else {
    els.feed?.prepend(loadingEl);
  }
}

function showForumDetailLoadingElement(loadingEl) {
  const detailFeed = els.feed?.querySelector('.forum-circle-detail-feed');
  if (detailFeed) {
    detailFeed.prepend(loadingEl);
  } else {
    showForumFeedLoadingElement(loadingEl);
  }
}

function closeForumHomeAiMenu() {
  document.getElementById('forum-ai-gen-menu')?.remove();
}

function abortForumHomeFeedGeneration() {
  if (!forumHomeFeedAbortController) return false;
  forumHomeFeedAbortController.abort();
  forumHomeFeedAbortController = null;
  closeForumHomeAiMenu();
  removeForumFeedLoadingElements();
  const button = document.getElementById('forum-ai-gen-btn');
  button?.classList.remove('is-loading');
  button?.removeAttribute('aria-busy');
  button?.setAttribute('aria-label', 'AI生成');
  showDynamicIsland('正在打断首页生成');
  return true;
}

function openForumHomeAiMenu(event) {
  event?.stopPropagation();
  const button = document.getElementById('forum-ai-gen-btn');
  const space = getCurrentSpace();
  if (forumHomeFeedAbortController) {
    abortForumHomeFeedGeneration();
    return;
  }
  if (!button || button.disabled) return;
  const existed = document.getElementById('forum-ai-gen-menu');
  closeForumHomeAiMenu();
  if (existed) return;
  const menu = document.createElement('div');
  menu.id = 'forum-ai-gen-menu';
  menu.className = 'forum-ai-gen-menu';
  menu.innerHTML = `
    <button data-forum-ai-home-action="append" type="button">
      <span class="forum-ai-menu-icon is-generate"></span>
      <span>
        <b>生成新首页</b>
        <small>保留当前帖子，追加一批新动态</small>
      </span>
    </button>
    <button data-forum-ai-home-action="replace" type="button" ${space?.lastAiHomePostIds?.length ? '' : 'disabled'}>
      <span class="forum-ai-menu-icon is-refresh"></span>
      <span>
        <b>重新生成上一批</b>
        <small>删掉上次 AI 首页批次后重来</small>
      </span>
    </button>
  `;
  button.insertAdjacentElement('afterend', menu);
  const closeOnOutside = e => {
    if (menu.contains(e.target) || e.target === button) return;
    closeForumHomeAiMenu();
    document.removeEventListener('click', closeOnOutside);
  };
  requestAnimationFrame(() => document.addEventListener('click', closeOnOutside));
  menu.addEventListener('click', async e => {
    const actionBtn = e.target.closest('[data-forum-ai-home-action]');
    if (!actionBtn || actionBtn.disabled) return;
    const replaceLastBatch = actionBtn.dataset.forumAiHomeAction === 'replace';
    closeForumHomeAiMenu();
    document.removeEventListener('click', closeOnOutside);
    await generateForumHomeFeed({ replaceLastBatch });
  });
}

function closeForumDiscoverAiMenu() {
  document.getElementById('forum-discover-ai-menu')?.remove();
}

function openForumDiscoverAiMenu(event) {
  event?.stopPropagation();
  const button = document.getElementById('forum-discover-ai-btn');
  const space = getCurrentSpace();
  if (!button || button.disabled) return;
  const existed = document.getElementById('forum-discover-ai-menu');
  closeForumDiscoverAiMenu();
  if (existed) return;
  const menu = document.createElement('div');
  menu.id = 'forum-discover-ai-menu';
  menu.className = 'forum-ai-gen-menu';
  menu.innerHTML = `
    <button data-forum-ai-trend-action="append" type="button">
      <span class="forum-ai-menu-icon is-generate"></span>
      <span>
        <b>生成新热搜</b>
        <small>按方向补充热搜词条</small>
      </span>
    </button>
    <button data-forum-ai-trend-action="replace" type="button" ${space?.lastAiDiscoverTrendIds?.length ? '' : 'disabled'}>
      <span class="forum-ai-menu-icon is-refresh"></span>
      <span>
        <b>重新生成上一批</b>
        <small>删掉上次 AI 热搜后重来</small>
      </span>
    </button>
  `;
  button.insertAdjacentElement('afterend', menu);
  const closeOnOutside = e => {
    if (menu.contains(e.target) || e.target === button) return;
    closeForumDiscoverAiMenu();
    document.removeEventListener('click', closeOnOutside);
  };
  requestAnimationFrame(() => document.addEventListener('click', closeOnOutside));
  menu.addEventListener('click', async e => {
    const actionBtn = e.target.closest('[data-forum-ai-trend-action]');
    if (!actionBtn || actionBtn.disabled) return;
    const action = actionBtn.dataset.forumAiTrendAction;
    closeForumDiscoverAiMenu();
    document.removeEventListener('click', closeOnOutside);
    await generateForumDiscoverTrendsWithAI({ replaceLastBatch: action === 'replace' });
  });
}

function closeForumCircleDetailAiMenu() {
  document.getElementById('forum-circle-detail-ai-menu')?.remove();
}

function abortForumCircleDetailGeneration() {
  if (!forumCircleDetailAbortController) return false;
  forumCircleDetailAbortController.abort();
  forumCircleDetailAbortController = null;
  forumCircleDetailGeneratingKey = '';
  closeForumCircleDetailAiMenu();
  removeForumFeedLoadingElements();
  const button = document.getElementById('forum-circle-ai-btn');
  button?.classList.remove('is-loading');
  button?.removeAttribute('aria-busy');
  button?.setAttribute('aria-label', 'AI生成圈子内容');
  showDynamicIsland('正在打断相关帖子生成');
  return true;
}

function openForumCircleDetailAiMenu(event) {
  event?.stopPropagation();
  const button = document.getElementById('forum-circle-ai-btn');
  const space = getCurrentSpace();
  const target = getForumCircleDetailTarget(space);
  const replaceIds = target?.key && space?.lastAiCircleDetailPostIds?.[target.key] ? space.lastAiCircleDetailPostIds[target.key] : [];
  if (forumCircleDetailAbortController) {
    abortForumCircleDetailGeneration();
    return;
  }
  if (!button || button.disabled || !target) return;
  const existed = document.getElementById('forum-circle-detail-ai-menu');
  closeForumCircleDetailAiMenu();
  if (existed) return;
  const menu = document.createElement('div');
  menu.id = 'forum-circle-detail-ai-menu';
  menu.className = 'forum-ai-gen-menu';
  menu.innerHTML = `
    <button data-forum-ai-detail-action="append" type="button">
      <span class="forum-ai-menu-icon is-generate"></span>
      <span>
        <b>生成相关帖子</b>
        <small>围绕当前${target.trend ? '热搜' : '圈子'}追加内容</small>
      </span>
    </button>
    <button data-forum-ai-detail-action="replace" type="button" ${replaceIds.length ? '' : 'disabled'}>
      <span class="forum-ai-menu-icon is-refresh"></span>
      <span>
        <b>重新生成上一批</b>
        <small>删掉上次 AI 帖子后重来</small>
      </span>
    </button>
  `;
  button.insertAdjacentElement('afterend', menu);
  const closeOnOutside = e => {
    if (menu.contains(e.target) || e.target === button) return;
    closeForumCircleDetailAiMenu();
    document.removeEventListener('click', closeOnOutside);
  };
  requestAnimationFrame(() => document.addEventListener('click', closeOnOutside));
  menu.addEventListener('click', async e => {
    const actionBtn = e.target.closest('[data-forum-ai-detail-action]');
    if (!actionBtn || actionBtn.disabled) return;
    const action = actionBtn.dataset.forumAiDetailAction;
    closeForumCircleDetailAiMenu();
    document.removeEventListener('click', closeOnOutside);
    await generateForumCircleDetailPosts({ replaceLastBatch: action === 'replace' });
  });
}

function normalizeForumAiAuthorName(value) {
  return String(value || '')
    .trim()
    .replace(/^[＠@]+/, '')
    .replace(/\s*[（(][^）)]*[）)]\s*$/, '')
    .replace(/\s*[＠@][^\s）)]*\s*$/, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function getForumGeneratedAuthorId(name) {
  const base = normalizeForumAiAuthorName(name) || `npc_${Date.now()}`;
  let hash = 0;
  Array.from(base).forEach(ch => { hash = ((hash << 5) - hash) + ch.charCodeAt(0); hash |= 0; });
  return `ai_npc_${Math.abs(hash).toString(36)}`;
}

function getForumAiPostAuthor(space, item) {
  const rawName = String(item?.authorName || '').trim();
  if (!rawName) return null;
  const normalizedName = normalizeForumAiAuthorName(rawName);
  const identity = String(item?.identity || '').trim().toLowerCase();
  const currentUser = getCurrentForumUser(space);
  if ([currentUser.name, currentUser.account].some(name => normalizeForumAiAuthorName(name) === normalizedName)) return null;
  const member = (space.members || []).find(item =>
    [getForumDisplayName(space, item.id, item.name), item.name, getForumAccount(space, item.id, item.name)]
      .some(name => String(name || '').trim() === rawName || normalizeForumAiAuthorName(name) === normalizedName));
  if (member) {
    const rawType = String(member.type || '').trim().toLowerCase();
    const type = rawType === 'npc' ? 'npc'
      : rawType === 'customnpc' ? 'customNpc'
        : (!rawType || rawType === 'character' || rawType === '角色') ? 'character' : null;
    if (!type) return null;
    return {
      id: member.id,
      name: getForumDisplayName(space, member.id, member.name),
      avatar: member.avatar || DEFAULT_AVATAR_SRC,
      type,
      isFamous: Boolean(space.forumProfiles?.[member.id]?.isFamous ?? member.isFamous),
      isVerified: Boolean(space.forumProfiles?.[member.id]?.isVerified),
      fans: normalizeFansCount(space.forumProfiles?.[member.id]?.fans ?? member.fans)
    };
  }
    if (identity === 'alias') {
    const realName = String(item?.realName || '').trim();
    const realMember = realName ? (space.members || []).find(m =>
      getForumDisplayName(space, m.id, m.name) === realName || m.name === realName) : null;
    if (realMember) {
      const fixedAlias = getForumCharacterFixedAlias(space, realMember.id);
      if (fixedAlias) {
        return {
          id: fixedAlias.id,
          sourceCharacterId: realMember.id,
          name: fixedAlias.name,
          avatar: fixedAlias.avatar || space.forumProfiles?.[realMember.id]?.aliasAvatar || realMember.avatar || DEFAULT_AVATAR_SRC,
          type: 'character',
          isAlias: true,
          isFamous: false,
          isVerified: false,
          fans: normalizeFansCount(fixedAlias.fans)
        };
      }
      // 没有固定小号，用 AI 编的别名
      const aliasId = `alias_home_${getForumGeneratedAuthorId(rawName)}`;
      return {
        id: aliasId,
        sourceCharacterId: realMember.id,
        name: rawName,
        avatar: space.forumProfiles?.[realMember.id]?.aliasAvatar || dicebearAvatar(rawName),
        type: 'character',
        isAlias: true,
        isFamous: false,
        isVerified: false,
        fans: 0
      };
    }
    // realName 对不上任何角色，当普通路人处理（往下走）
  }
  if (identity === 'character') return null;
  const id = getForumGeneratedAuthorId(rawName);
  if (!space.forumProfiles) space.forumProfiles = {};
  space.forumProfiles[id] = {
    ...(space.forumProfiles[id] || {}),
    nickname: rawName,
    account: space.forumProfiles[id]?.account || generateForumAccount(rawName),
    avatar: space.forumProfiles[id]?.avatar || getForumOrdinaryNpcAvatar(rawName, [
      identity,
      item?.circle,
      item?.title,
      item?.content,
      item?.caption,
      item?.topic
    ].filter(Boolean).join(' ')),
    bio: space.forumProfiles[id]?.bio || '论坛里的普通账号。'
  };
  return {
    id,
    name: rawName,
    avatar: space.forumProfiles[id].avatar,
    type: 'ordinaryNpc',
    isFamous: false,
    isVerified: false,
    fans: 0
  };
}

function buildForumAiPostMedia(item, postId) {
  const type = String(item?.type || 'text').trim().toLowerCase();
  if (type === 'image') {
    return (Array.isArray(item.fakeImages) ? item.fakeImages : [])
      .map(text => String(text || '').trim())
      .filter(Boolean)
      .map((text, index) => ({
        id: `${postId}_image_${index}`,
        type: 'fake-image',
        text
      }));
  }
  if (type === 'video') {
    const slides = (Array.isArray(item.slides) ? item.slides : [])
      .map(slide => String(slide || '').trim())
      .filter(Boolean);
    return [{
      id: `${postId}_video`,
      type: 'slides-video',
      slides,
      durations: slides.map(() => 3),
      interval: 3000
    }];
  }
  if (type === 'music') {
    const song = item.song && typeof item.song === 'object' ? item.song : {};
    const title = String(song.title || item.songTitle || item.musicTitle || '').trim();
    const artist = String(song.artist || item.artist || '').trim();
    if (!title && !artist) return [];
    return [{
      id: `${postId}_music`,
      type: 'music',
      song: {
        title: title || '未命名音乐',
        artist: artist || '未知',
        cover: song.cover || DEFAULT_AVATAR_SRC,
        lyric: String(song.lyric || item.lyric || '').trim()
      }
    }];
  }
  return [];
}

function normalizeForumStandardMandarinTranslation(content, translation) {
  const raw = String(translation || '').trim();
  if (!raw) return '';
  const source = String(content || '').trim();
  const cjkCount = (raw.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (raw.match(/[A-Za-z]/g) || []).length;
  if (latinCount >= 6 && cjkCount === 0) return '';
  if (source && raw === source) return '';
  return raw;
}

function buildForumAiPostComments(space, post, items) {
  const currentUser = getCurrentForumUser(space);
  const floorMap = {};
  const nameMap = {};
  const topLevelComments = [];
  (Array.isArray(items) ? items : []).forEach((item, itemIndex) => {
    const text = String(item?.content || '').trim();
    if (!text) return;
    const speaker = String(item?.speaker || '').trim();
    const isUserComment = String(item?.identity || '').trim().toLowerCase() === 'user'
      || [currentUser.name, currentUser.account].some(name => normalizeForumAiAuthorName(name) === normalizeForumAiAuthorName(speaker));
    if (isUserComment) return;
    const author = resolveForumCommentAuthor(space, item || {});
    const createdAt = Date.now() + itemIndex;
    const likeCount = Math.max(0, Math.min(Number(item?.likes) || 0, 999));
    const comment = {
      user: author.user,
      avatar: author.avatar,
      authorId: author.user === post.authorName ? post.authorId : (author.realCharId || null),
      realCharId: author.realCharId,
      text,
      translation: normalizeForumStandardMandarinTranslation(text, item?.translation),
      likes: Array.from({ length: likeCount }, (_, index) => `ai_c_like_${createdAt}_${index}`),
      replies: [],
      createdAt
    };
    const parsedQuote = parseInt(String(item?.quoteFloor || '').replace(/\D/g, ''), 10);
    let target = Number.isFinite(parsedQuote) ? floorMap[parsedQuote] : null;
    if (!target && item?.replyTo) {
      const replyTo = String(item.replyTo).replace(/^[@＠\s]+/, '').replace(/[:：\s]+$/, '').trim();
      target = nameMap[replyTo] || null;
    }
    if (target) {
      target.replies = Array.isArray(target.replies) ? target.replies : [];
      const replyToName = String(item?.replyTo || '').replace(/^[@＠\s]+/, '').replace(/[:：\s]+$/, '').trim();
      const threadUserNames = new Set([target.user, ...(target.replies || []).map(r => r.user)].filter(Boolean));
      if (replyToName && replyToName !== target.user && threadUserNames.has(replyToName)) {
        comment.replyToUser = replyToName;
      }
      target.replies.push(comment);
    } else {
      topLevelComments.push(comment);
      floorMap[topLevelComments.length] = comment;
      if (comment.user) nameMap[comment.user] = comment;
    }
  });
  return topLevelComments;
}

function getForumPostCommentDisplayCount(post) {
  return Math.max(Number(post?.commentCount) || 0, Array.isArray(post?.comments) ? post.comments.length : 0);
}

function getForumPostLikeDisplayCount(post) {
  return Math.max(Number(post?.likeCount) || 0, Array.isArray(post?.likes) ? post.likes.length : 0);
}

function formatForumEngagementCount(value) {
  const count = Math.max(0, Math.floor(Number(value) || 0));
  if (count >= 100000000) {
    const yi = count / 100000000;
    return `${Number.isInteger(yi) ? yi : yi.toFixed(1)}亿`;
  }
  if (count >= 10000) {
    const wan = count / 10000;
    return `${Number.isInteger(wan) ? wan : wan.toFixed(1)}万`;
  }
  return String(count);
}

function bumpForumPostDiscussionHeat(post, amount = 1) {
  if (!post) return;
  const count = Math.max(1, Math.floor(Number(amount) || 1));
  const actualCommentCount = Array.isArray(post.comments) ? post.comments.length : 0;
  const baseCommentCount = Number(post.commentCount) || Math.max(0, actualCommentCount - count);
  post.commentCount = Math.max(baseCommentCount + count, actualCommentCount);
  post.likes = Array.isArray(post.likes) ? post.likes : [];
  const currentLikes = getForumPostLikeDisplayCount(post);
  const heatScale = currentLikes >= 100000 ? 14
    : currentLikes >= 10000 ? 9
      : currentLikes >= 1000 ? 5
        : currentLikes >= 200 ? 3 : 1;
  const likeBoost = Math.max(1, count * heatScale + Math.floor(Math.random() * (count * heatScale + 4)));
  post.likeCount = Math.max(currentLikes + likeBoost, post.likes.length);
  if (post.likes.length < 120 && post.likeCount <= 300) {
    const fillCount = Math.min(likeBoost, 120 - post.likes.length);
    for (let i = 0; i < fillCount; i++) {
      post.likes.push(`discussion_like_${Date.now()}_${i}`);
    }
  }
  if (Math.random() < Math.min(0.9, 0.25 + count * 0.08 + heatScale * 0.03)) {
    post.forwards = Number(post.forwards || 0) + Math.max(1, Math.floor(count * (0.4 + heatScale * 0.12)));
  }
}

function getForumAiTopicHeatScore(item = {}) {
  const text = [
    item.content,
    ...(Array.isArray(item.fakeImages) ? item.fakeImages : []),
    ...(Array.isArray(item.slides) ? item.slides : []),
    ...(Array.isArray(item.comments) ? item.comments.map(comment => comment?.content || '') : [])
  ].join(' ');
  let score = 0;
  if (/[爆曝锤瓜撕塌翻车崩]/.test(text)) score += 2;
  if (/热搜|实锤|反转|澄清|道歉|截图|录音|流出|泄露|封杀|举报|内幕|前任|分手|隐婚|官宣|掉马|扒出/.test(text)) score += 3;
  if (/全网|连夜|刚刚|现场|疯传|炸了|吵起来|坐不住|瞒不住|对不上|时间线/.test(text)) score += 2;
  if (String(item.type || '').toLowerCase() === 'video') score += 2;
  if (String(item.type || '').toLowerCase() === 'image') score += 1;
  if ((Array.isArray(item.comments) ? item.comments.length : 0) >= 5) score += 1;
  return Math.min(score, 10);
}

function getForumAiPostEngagement(space, item, author = {}) {
  const topicHeat = getForumAiTopicHeatScore(item);
  const fans = normalizeFansCount(author.fans);
  const isFamous = Boolean(author.isFamous);
  const isVerifiedFamous = Boolean(isFamous && (author.isVerified || item?.isVerified));
  const heatMultiplier = 1 + topicHeat * 0.28 + (isFamous ? 0.9 : 0) + (isVerifiedFamous ? 1.15 : 0);
  const jitter = (min, max) => min + Math.random() * Math.max(0, max - min);
  const fanLikes = fans > 0 ? fans * jitter(0.004, 0.018) * heatMultiplier : 0;
  const topicLikes = topicHeat >= 7 ? jitter(2600, 16000)
    : topicHeat >= 4 ? jitter(420, 3600)
      : topicHeat >= 2 ? jitter(80, 760) : jitter(8, 160);
  const fameLikes = isFamous ? jitter(600, 4200) : 0;
  const verifiedLikes = isVerifiedFamous ? jitter(1800, 12000) : 0;
  const likes = Math.min(999000, Math.max(3, Math.round(topicLikes + fanLikes + fameLikes + verifiedLikes)));
  const discussionRate = jitter(0.025, 0.075) + topicHeat * 0.006 + (isVerifiedFamous ? 0.018 : 0);
  const forwardRate = jitter(0.008, 0.035) + topicHeat * 0.004 + (isFamous ? 0.01 : 0);
  const comments = Math.min(88000, Math.max(Array.isArray(item?.comments) ? item.comments.length : 0, Math.round(likes * discussionRate)));
  const forwards = Math.min(180000, Math.max(0, Math.round(likes * forwardRate)));
  return { likes, comments, forwards };
}

function buildForumAiHomePosts(space, items) {
  const availableCircles = new Set((space.circles || []).map(circle => circle.name));
  const candidates = (Array.isArray(items) ? items : []).map((item, index) => {
    const author = getForumAiPostAuthor(space, item);
    const content = String(item?.content || '').trim();
    if (!author || !content) return null;
    return { item, author, content, index };
  }).filter(Boolean);

  const selected = [];
  let mainActorCount = 0;
  for (const candidate of candidates) {
    const isMainActor = candidate.author.type !== 'ordinaryNpc';
    if (isMainActor && mainActorCount >= 2) continue;
    selected.push(candidate);
    if (isMainActor) mainActorCount += 1;
  }

  return selected.map((candidate, index) => {
    const { item, author, content } = candidate;
    const postId = `ai_post_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = Date.now() - index * 1000;
    const media = buildForumAiPostMedia(item, postId);
    const circleName = String(item?.circle || '').trim();
    const engagement = getForumAiPostEngagement(space, item, author);
      const post = {
      id: postId,
      circle: availableCircles.has(circleName) ? circleName : '',
      type: 'text',
      authorId: author.id,
      sourceCharacterId: author.sourceCharacterId || null,
      authorName: author.name,
      avatar: author.avatar,
      isVerified: Boolean(item?.isVerified),
      content,
      translation: normalizeForumStandardMandarinTranslation(content, item?.translation),
      visibility: 'public',
      media,
      mentions: [],
      hiddenLink: {
        enabled: false,
        memberIds: [],
        exposureRate: 30
      },
      blockedIds: [],
      hiddenLinkState: {},
      likeCount: engagement.likes,
      likes: Array.from({ length: Math.min(engagement.likes, 120) }, (_, likeIndex) => `ai_post_like_${createdAt}_${likeIndex}`),
      forwards: engagement.forwards,
      commentCount: engagement.comments,
      comments: [],
      createdAt,
      forumSummary: '',
      lastSummaryFloor: 0,
      aiCommentsInitDone: true
    };
    post.comments = buildForumAiPostComments(space, post, item?.comments);
    post.type = getForumPostType(media);
    return post;
  });
}

function getForumCircleDetailTarget(space) {
  if (!space) return null;
  const trendId = getActiveForumDiscoverTrendId();
  const trend = trendId ? findForumDiscoverTrend(space, trendId) : null;
  if (trend) {
    return {
      key: `trend:${trend.id}`,
      trend,
      circle: { name: trend.text, desc: getForumDiscoverTrendDesc(trend), isTrend: true }
    };
  }
  const circle = getCurrentAccountCircles(space).find(item => item.name === activeCircle);
  return circle ? { key: `circle:${circle.name}`, trend: null, circle } : null;
}

async function buildForumCircleDetailPrompt(space, circle, trend = null) {
  const isTrend = Boolean(trend);
  const targetLabel = isTrend ? '热搜词条' : '圈子';
  const targetName = circle?.name || '未命名';
  const targetDesc = circle?.desc || '无';
  const trendEvent = trend?.event || '';
  const trendProcess = trend?.process || '';

  const mainActors = getForumHomeMainActors(space);
  const worldBookData = await resolveForumWorldBookPromptData(space, {
    label: isTrend ? '热搜详情页帖子生成' : '圈子详情页帖子生成',
    privateMemberIds: mainActors.map(member => member.id)
  });
  const publicContext = [
    `[论坛方案] ${space?.name || '未命名方案'}`,
    `[世界观] ${space?.world || '无'}`,
    worldBookData.publicText ? `[公共世界书]\n${worldBookData.publicText}` : '',
    `[关系状态] ${formatCoupleLine(space)}`
  ].filter(Boolean).join('\n');
  const privateActorContext = await buildForumHomeActorPrivateContext(space, worldBookData);
  const eventHistoryRule = buildForumEventHistoryPrompt(space);
  const activeEventRule = buildForumActiveEventPrompt(space, 'feed');

  const targetBlock = isTrend
    ? `[FOCUS TARGET — 当前热搜详情页,整批帖子只围绕这一件事]
热搜词条：${targetName}
热搜事件：${trendEvent || '无'}
事情经过：${trendProcess || '无'}`
    : `[FOCUS TARGET — 当前圈子详情页,整批帖子只围绕这一个圈子]
圈子名称：${targetName}
圈子背景：${targetDesc}`;

  const circleFieldRule = isTrend
    ? `【Hot-search binding】Every post's "circle" field MUST be an empty string "" (these posts belong under the hot-search, not any circle). Every post MUST make its connection to this hot-search visible in ONE of these ways: include the phrase as a hashtag like #${targetName}#, quote the phrase inside the content, or make it unmistakable from context that the post is discussing this exact event.`
    : `【Circle binding】Every post's "circle" field MUST be exactly "${targetName}" — no other circle name, no empty string. Tone and topics should read like something that would actually appear inside the "${targetName}" board (matching the circle background above: its typical topics, who hangs out there, what language style they use).`;

  return `You are a talented forum/BBS-style fiction writer. Your signature skill is "capturing a character" — not reciting profiles, but nailing speech rhythm, tiny quirks and emotional pace so every post reads like a real living person just typed it on their phone. Today you're writing a FOCUSED batch of posts for a specific ${targetLabel} detail page.

# Language & translation rules (obey exactly)
This forum is primarily Chinese-language. The vast majority of posts and comments MUST be written in Chinese. Only when a character's persona / worldview / circle culture explicitly requires non-Standard-Mandarin speech (e.g. Cantonese, dialect, foreign language, classical/wenyan) may the "content" field keep that original language. Whenever "content" is NOT Standard Mandarin, you MUST fill the SAME item's "translation" field with the Standard Mandarin equivalent. If "content" is already Standard Mandarin, "translation" MUST be an empty string. Same rule applies to every comment.

# What kind of page this is (most important context)
This is NOT the home feed. A user opened THIS specific ${targetLabel} detail page because they want to see MORE content focused on THIS ONE ${isTrend ? '热搜事件' : '圈子'}. So the entire batch must feel like a dedicated stream about this single topic, with many different angles layered together — NOT a broad home feed, NOT a mix of unrelated daily posts, NOT posts about other circles or other events.

${publicContext}
${eventHistoryRule}
${activeEventRule}

${targetBlock}

[Publicly visible people roster]
${getForumPeopleRosterForPrompt(space)}
[Character fixed aliases — for alias posts]
${mainActors
  .map(member => {
    const alias = getForumCharacterFixedAlias(space, member.id);
    if (!alias) return '';
    return `- ${getForumDisplayName(space, member.id, member.name)} 的固定小号：${alias.name}(@${alias.account})，签名：${alias.bio || '无'}`;
  })
  .filter(Boolean)
  .join('\n') || '无角色设置了固定小号'}
[Private profiles of core characters / main NPCs — strictly isolated]
Ordinary NPCs and passers CANNOT read any of the private material below. Only when that specific core character / main NPC themselves is posting or commenting may they use their OWN section of persona / memory / private lore.
${privateActorContext}

[Whitelist of core-character / main-NPC display names]
${mainActors
  .map(member => `- ${getForumDisplayName(space, member.id, member.name)}`)
  .join('\n') || '无'}

# Your task
Write 6 to 9 posts for this ${targetLabel} detail page. All posts must be FOCUSED on the FOCUS TARGET above but attack it from DIFFERENT angles so the page feels layered. For every post, also write 3 to 6 comments underneath so each post already looks like a lively discussion.

# Hard rules (must obey)
1. 【Topic lock — the defining rule of this page】Every single post in this batch MUST be directly about the FOCUS TARGET above (its ${isTrend ? 'headline, event and process' : 'name and background'}). NO unrelated daily posts, NO posts about other circles, NO posts about other events. If a post idea doesn't naturally connect to this specific ${targetLabel}, drop it and think of another angle on the same topic.
2. 【Different angles, same topic】Different posts must approach the SAME topic from clearly DIFFERENT angles so the page feels layered instead of repetitive. Mix freely: eyewitness fragments, secondhand gossip, timeline sorting, denial or pushback, ironic jokes, described screenshots, fans/antis reacting, insiders hinting, bystanders eating melon, adjacent industry/circle context, personal experiences that connect to this ${targetLabel}. Never let two posts repeat the same angle.
3. 【NEVER post or comment as the user】The user is the person whose type is "用户" in the roster. No post author or comment author may be the user, may reuse the user's nickname / account, or speak in the user's first person.
4. 【Ordinary NPCs / passers are OVERWHELMINGLY the majority — stricter than home feed】In the 6-9 posts, at LEAST 7 posts MUST be brand-new ordinary NPCs you invent (fandom people, fans, antis, shop staff, classmates, coworkers, local witnesses, passing netizens, insiders...). Their identity is "ordinaryNpc". A batch that is ALL ordinary NPCs is a totally normal outcome and is PREFERRED over stuffing in named characters.
5. 【Core characters / main NPCs appear VERY RARELY — even rarer than home feed】This is the strictest rule on this page:
   - Core characters / main NPCs may appear as authors AT MOST 0 to 1 time in the WHOLE batch. Zero is the default and preferred state.
   - Most batches you generate should have ZERO core-character posts and ZERO named-NPC posts. Only bring one in when this specific ${targetLabel} is obviously and directly about them, or they have a real, concrete reason to speak on this exact topic.
   - If a core character does appear, their display name MUST come exactly from the [Whitelist of core-character / main-NPC display names] above.
   - When in doubt, DO NOT include a core character. Ordinary NPCs are always the safer choice.
5b. 【Character alias posts】A core character who has a fixed alias (listed in [Publicly visible people roster] under "固定小号") MAY very rarely appear as the post author using that alias. When doing so: set identity="alias", authorName=the alias name, realName=the character's real display name from the whitelist. Alias posts are more private, vulnerable, low-key and closer to the character's inner self — like a secret diary entry that happens to be public. They must NOT expose the character's real identity through content. This counts toward the 0-1 core-character limit above.
5c. 【Verified badge】If a person in [Publicly visible people roster] has "是否名人: 是", their post SHOULD have "isVerified": true. For ordinary NPCs and alias posts, set "isVerified": false.
6. Ordinary NPCs are NOT core characters — they don't appear on any whitelist. Give them natural Chinese forum handles / usernames. Never label them "路人甲 / 网友A / 普通NPC".
6b. 【No impersonation — posts AND comments】Ordinary NPCs / passers must NEVER pretend to be a whitelisted core character or main NPC. Their authorName / speaker MUST NOT reuse, resemble, or embed any whitelisted name (no "XX本人"、"XX的小号"、谐音变体), and their content MUST NOT claim first-person to be a whitelisted person (e.g. "我就是XX"、"其实我是XX") or leak that person's private lore. identity="alias" is reserved for core characters posting under their own alias, with realName from the whitelist — ordinary NPCs MUST NEVER use identity="alias".
7. 【Comments follow the same rarity rule】Comments are also OVERWHELMINGLY ordinary NPCs / passers. The vast majority of "identity" values in comments should be "passer" or "ordinaryNpc". Across the ENTIRE batch, core characters / main NPCs may leave AT MOST 1 comment total (zero is preferred), and the user leaves 0.
8. Nail identity differences: core characters may only use their own private persona / memory / private lore in their OWN post/comment. Ordinary NPCs speak based on their circle, profession, fan/anti stance, and their distance from the gossip — like real netizens. They are NOT omniscient and must not know any private material.
9. All three post types must appear and mix naturally:
   - text: pure-text venting / sharing / mini essays / gossip drops
   - image: image-post whose "image" is described in words (you write what the fake image contains)
   - video: text short-video described page-by-page as a mini storyboard
10. 【Worldview fit + celebrity mechanic】
   a) Worldview first: every post must feel like something that would REALLY happen inside this forum world's version of this ${targetLabel}. Tone, era and lifestyle must fit the [世界观] and [FOCUS TARGET] above. NEVER drop in modern generic memes that don't belong here.
   b) Celebrity mechanic: check each person's "是否名人" and fan count in [Publicly visible people roster]. Ordinary NPCs may spontaneously discuss a core character / the user ONLY IF that person is marked celebrity=YES AND has a clearly non-zero base fan count AND the FOCUS TARGET is genuinely related to them. If they are NOT celebrities: ordinary NPCs basically don't recognize them, don't discuss them, don't spontaneously mention them.
11. 【Female-friendly baseline】This is a female-oriented forum. Posts can be explosive, dramatic, ambiguous and full of reversals, but MUST NOT contain misogyny, woman-shaming, female rivalry framing, slut-shaming, appearance-shaming, victim-blaming, or using women harming each other as the fun point.
12. 【Anti-AI-habit】80% of posts and comments should be around 15 Chinese characters or fewer. Short sentences, spoken feel, subjects often dropped. NO textbook long sentences, NO grand summarizing. STRICTLY FORBIDDEN clichés: never write "破防了 / 绷不住了 / 蚌埠住了 / 急了 / 破大防 / 楼主急了". Low-key everyday tone is the DEFAULT.
13. 【World is SOIL, not a script】The [世界观] and [公共世界书] and [FOCUS TARGET] background are the SOIL every post grows out of, NOT lines to be recited. STRICTLY FORBIDDEN: never copy, paraphrase, quote, or re-explain the worldview / lore text / target background itself inside a post. No setting exposition dumps, no "众所周知我们这个世界…" style intros, no restating background facts that any local would take completely for granted. A real resident NEVER narrates their own world's basic rules — they just LIVE inside them and talk about their own small concrete stuff. Let the setting surface INDIRECTLY and offhandedly through specific daily details.
14. 【Use slang SPARINGLY】Do NOT stuff yyds / awsl / xswl / 绝绝子 / 栓Q / 尊嘟假嘟 and similar worn-out slang into every post/comment. The DEFAULT is plain natural spoken Chinese with ZERO slang. Only when a meme genuinely nails the exact vibe may ONE line use ONE meme. Never pile several slang terms into one line.
15. 【No echo】Before writing each new post or comment, scan what you already wrote in this batch. Do NOT repeat, paraphrase, or restate an angle, joke, feeling or meme that already appeared. Every new item MUST add a genuinely new angle on the same focused topic. If you truly have nothing new to add, generate fewer items rather than padding with near-duplicates.
16. ${circleFieldRule}

# Output format (output ONLY a JSON array, no explanation)
[
  {
    "authorName": "Ordinary NPC: your own original Chinese handle. Core character / main NPC (rare): MUST use the display name from the whitelist above. Character alias (rare): use the alias name from the fixed-alias list.",
    "identity": "ordinaryNpc | npc | character | alias",
    "realName": "only when identity=alias, the real character name behind the alias; otherwise empty string",
    "isVerified": false,
    "circle": "${isTrend ? 'empty string' : `must be exactly "${targetName}"`}",
    "type": "text | image | video",
    "content": "post body (colloquial, may use #topic#; keep non-Standard-Mandarin here ONLY if persona/worldview requires it)",
    "translation": "[STRICT] If content is not Standard Mandarin, put the Standard Mandarin translation here; otherwise empty string",
    "fakeImages": ["When type=image: describe what's IN each image / screenshot / text — 1 to 3 items"],
    "slides": ["When type=video: short-video pages, one line per page, 2 to 4 pages"],
    "comments": [
      {
        "speaker": "comment author display name (passer = your own original Chinese handle / character = real name from whitelist)",
        "identity": "passer | ordinaryNpc | character | npc",
        "quoteFloor": "if replying to a specific floor, its floor number; plain bottom comment = null",
        "replyTo": "if replying to a specific person, their display name; plain bottom comment = empty string",
        "content": "comment body, short and colloquial",
        "translation": "[STRICT] Same rule as post-level translation: if content is not Standard Mandarin, put the Standard Mandarin translation here; otherwise empty string",
        "likes": 0
      }
    ]
  }
]
The array length MUST be between 6 and 9. When type is NOT "image", fakeImages MUST be an empty array. When type is NOT "video", slides MUST be an empty array. Every post's "comments" MUST contain 3 to 6 items. If content contains Cantonese / dialect / foreign language / non-standard spoken Mandarin, "translation" MUST hold its Standard Mandarin translation; if content is already Standard Mandarin, "translation" MUST be an empty string. Same rule applies to every comment. The first output character MUST be [.`;
}
async function generateForumCircleDetailPosts(options = {}) {
  const space = getCurrentSpace();
  if (forumCircleDetailAbortController) {
    abortForumCircleDetailGeneration();
    return;
  }
  if (!space) return showDynamicIsland('请先进入一个论坛方案');
  const target = getForumCircleDetailTarget(space);
  if (!target) return showDynamicIsland('找不到当前内容页');
  const { circle, trend, key } = target;
  const button = document.getElementById('forum-circle-ai-btn');
  let loadingEl = null;
  const controller = new AbortController();
  forumCircleDetailAbortController = controller;
  forumCircleDetailGeneratingKey = key;
  try {
    if (button) {
      button.classList.add('is-loading');
      button.setAttribute('aria-busy', 'true');
      button.setAttribute('aria-label', '打断生成');
    }
    space.lastAiCircleDetailPostIds = space.lastAiCircleDetailPostIds && typeof space.lastAiCircleDetailPostIds === 'object'
      ? space.lastAiCircleDetailPostIds
      : {};
    const replacingIds = options.replaceLastBatch ? new Set(space.lastAiCircleDetailPostIds[key] || []) : null;
    if (replacingIds?.size) {
      space.posts = (space.posts || []).filter(post => !replacingIds.has(post.id));
      space.lastAiCircleDetailPostIds[key] = [];
      await saveState();
      renderApp();
    }
    loadingEl = createForumFeedLoadingElement('正在生成相关帖子…');
    showForumDetailLoadingElement(loadingEl);
    const prompt = await buildForumCircleDetailPrompt(space, circle, trend);
    const raw = await sendForumCommentPromptToAI(prompt, [], controller.signal);
    if (trend && !findForumDiscoverTrend(space, trend.id)) {
      showDynamicIsland('热搜已删除，已取消相关生成');
      return;
    }
    const items = parseAiJsonArray(raw);
    const posts = buildForumAiHomePosts(space, items);
    if (!posts.length) throw new Error('Forum detail AI returned no valid posts');
    posts.forEach(post => {
      if (trend) {
        post.circle = '';
        post.discoverTrendId = trend.id;
        post.discoverTrendText = trend.text;
      } else {
        post.circle = circle.name;
      }
    });
    space.posts = Array.isArray(space.posts) ? [...space.posts] : [];
    space.posts.unshift(...posts);
    space.posts.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    space.lastAiCircleDetailPostIds[key] = posts.map(post => post.id);
    advanceForumActiveEvent(space);
    await saveState();
    if (forumCircleDetailAbortController === controller) {
      forumCircleDetailAbortController = null;
      forumCircleDetailGeneratingKey = '';
    }
    renderApp();
    showDynamicIsland(`已生成 ${posts.length} 条相关帖子`);
  } catch (error) {
    if (error?.name === 'AbortError') {
      console.log('[论坛引擎] 相关帖子生成已被主动打断');
      showDynamicIsland('已打断相关帖子生成');
    } else {
      console.error('Forum detail AI generation failed:', error);
      showDynamicIsland('生成失败，请检查 API 设置');
    }
  } finally {
    if (forumCircleDetailAbortController === controller) {
      forumCircleDetailAbortController = null;
      forumCircleDetailGeneratingKey = '';
    }
    loadingEl?.remove();
    if (button) {
      button.classList.remove('is-loading');
      button.removeAttribute('aria-busy');
      button.setAttribute('aria-label', 'AI生成圈子内容');
    }
  }
}

async function generateForumHomeFeed(options = {}) {
  const button = document.getElementById('forum-ai-gen-btn');
  if (forumHomeFeedAbortController) {
    abortForumHomeFeedGeneration();
    return;
  }
  const space = getCurrentSpace();
  if (!space) {
    showDynamicIsland('请先创建方案');
    return;
  }

  const replacingIds = options.replaceLastBatch ? new Set(space.lastAiHomePostIds || []) : null;
  const originalPosts = Array.isArray(space.posts) ? space.posts : [];
  const basePosts = replacingIds?.size
    ? originalPosts.filter(post => !replacingIds.has(post.id))
    : originalPosts;
  let loadingEl = null;
  const controller = new AbortController();
  forumHomeFeedAbortController = controller;
  try {
    if (button) {
      button.classList.add('is-loading');
      button.setAttribute('aria-busy', 'true');
      button.setAttribute('aria-label', '打断首页生成');
    }
    if (options.replaceLastBatch && replacingIds?.size) {
      space.posts = [...basePosts];
      space.lastAiHomePostIds = [];
      await saveState();
      renderApp();
    }
    loadingEl = createForumFeedLoadingElement();
    showForumFeedLoadingElement(loadingEl);

    const raw = await sendForumCommentPromptToAI(await buildForumFeedPrompt(space), [], controller.signal);
    const items = parseAiJsonArray(raw);
    const posts = buildForumAiHomePosts(space, items);
    if (!posts.length) {
      console.warn('Forum AI returned no valid posts', {
        itemCount: items.length,
        returnedAuthors: items.slice(0, 12).map(item => item?.authorName || ''),
        availableAuthors: (space.members || []).map(member => ({
          name: getForumDisplayName(space, member.id, member.name),
          type: member.type || 'character'
        }))
      });
      throw new Error('Forum AI returned no valid posts');
    }

    const postsBeforeInsert = Array.isArray(space.posts) ? space.posts : basePosts;
    space.posts = [...postsBeforeInsert];
    space.posts.unshift(...posts);
    space.posts.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    space.lastAiHomePostIds = posts.map(post => post.id);
    advanceForumActiveEvent(space);
    await saveState();
    if (forumHomeFeedAbortController === controller) forumHomeFeedAbortController = null;
    renderApp();
    showDynamicIsland(`已生成 ${posts.length} 条新帖子`);
  } catch (error) {
    if (error?.name === 'AbortError') {
      console.log('[论坛引擎] 首页生成已被主动打断');
      showDynamicIsland('已打断首页生成');
    } else {
      console.error('Forum home feed generate failed:', error);
      showDynamicIsland('生成失败，请检查 API 设置');
    }
  } finally {
    if (forumHomeFeedAbortController === controller) forumHomeFeedAbortController = null;
    loadingEl?.remove();
    if (button) {
      button.classList.remove('is-loading');
      button.removeAttribute('aria-busy');
      button.setAttribute('aria-label', 'AI生成');
    }
  }
}

function closeForumCharacterAiMenu() {
  document.getElementById('forum-user-profile-ai-menu')?.remove();
}

function abortForumCharacterProfileGeneration() {
  if (!forumCharacterProfileAbortController) return false;
  forumCharacterProfileAbortController.abort();
  forumCharacterProfileAbortController = null;
  forumCharacterProfileGeneratingViewId = '';
  closeForumCharacterAiMenu();
  removeForumFeedLoadingElements();
  const button = document.getElementById('forum-user-profile-ai-btn');
  button?.classList.remove('is-loading');
  button?.removeAttribute('aria-busy');
  button?.setAttribute('aria-label', 'AI生成内容');
  showDynamicIsland('正在打断角色主页生成');
  return true;
}
function openForumCharacterAiMenu(event, profileId, viewOptions = {}) {
  event?.stopPropagation();
  const button = document.getElementById('forum-user-profile-ai-btn');
  const space = getCurrentSpace();
  const account = getForumProfileViewAccount(space, profileId, viewOptions);
  const replaceIds = space?.lastAiCharacterProfilePostIds?.[account.viewId] || [];
  if (forumCharacterProfileAbortController) {
    abortForumCharacterProfileGeneration();
    return;
  }
  if (!button || button.disabled) return;
  const existed = document.getElementById('forum-user-profile-ai-menu');
  closeForumCharacterAiMenu();
  if (existed) return;
  const menu = document.createElement('div');
  menu.id = 'forum-user-profile-ai-menu';
  menu.className = 'forum-ai-gen-menu';
  menu.innerHTML = `
    <button data-forum-ai-character-action="append" type="button">
      <span class="forum-ai-menu-icon is-generate"></span>
      <span>
        <b>生成主页帖子</b>
        <small>给当前账号追加一批内容</small>
      </span>
    </button>
    <button data-forum-ai-character-action="replace" type="button" ${replaceIds.length ? '' : 'disabled'}>
      <span class="forum-ai-menu-icon is-refresh"></span>
      <span>
        <b>重新生成上一批</b>
        <small>删掉上次该账号 AI 批次后重来</small>
      </span>
    </button>
  `;
  button.insertAdjacentElement('afterend', menu);
  const closeOnOutside = e => {
    if (menu.contains(e.target) || e.target === button) return;
    closeForumCharacterAiMenu();
    document.removeEventListener('click', closeOnOutside);
  };
  requestAnimationFrame(() => document.addEventListener('click', closeOnOutside));
  menu.addEventListener('click', async e => {
    const actionBtn = e.target.closest('[data-forum-ai-character-action]');
    if (!actionBtn || actionBtn.disabled) return;
    const replaceLastBatch = actionBtn.dataset.forumAiCharacterAction === 'replace';
    closeForumCharacterAiMenu();
    document.removeEventListener('click', closeOnOutside);
    await generateForumCharacterProfilePosts(profileId, { replaceLastBatch, forceMain: viewOptions.forceMain });
  });
}

async function buildForumCharacterProfilePrompt(space, profileId, account) {
  const member = (space.members || []).find(item => item.id === profileId);
  const profile = space.forumProfiles?.[profileId] || {};
  const worldBookData = await resolveForumWorldBookPromptData(space, {
    label: '主页帖子生成',
    privateMemberIds: member ? [profileId] : []
  });
  let memory = '无';
  try {
    memory = await getMemoriesForPrompt(member?.sourceId || profileId) || '无';
  } catch (error) {
    console.warn('Forum character memory read failed:', profileId, error);
  }
  const name = account.alias?.name || getForumDisplayName(space, profileId, member?.name || '未命名角色');
  const accountName = account.alias?.account || getForumAccount(space, profileId, name);
  const recentPosts = getForumProfilePosts(space, account.viewId).slice(0, 8)
    .map(post => `- ${post.visibility === 'private' ? '非公开' : '公开'} / ${post.type || 'text'}：${post.content || describeForumMediaForAI(post.media) || '无正文'}`)
    .join('\n') || '无';
  const profileKind = account.isAlias
    ? '角色小号'
    : member
      ? (member.type === 'npc' || member.type === 'customNpc' ? 'NPC主页' : '角色主号')
      : 'NPC主页';
  const personaBase = member ? (getForumMemberPersona(member) || profile.bio || '无') : (profile.bio || '根据既有帖子逐步推断');
  const aliasRule = account.isAlias
    ? `当前正在写这个角色的【匿名小号】@${accountName}。

小号 vs 主号的核心区别（必须严格遵守）：
- 主号 = 营业、表演、维持人设、对外展示。说话有分寸，内容是给粉丝/朋友/公众看的。
- 小号 = 卸妆、喘气、自言自语、偷偷发泄。说话像在跟自己的手机碎碎念，不在乎措辞。

小号的内容必须明显区别于主号：
1. 【更碎片】：一两个字、半句话、没头没尾的情绪碎片、没有上下文的吐槽、只有自己懂的梗。不需要完整句子。
2. 【更内心】：主号不会说的真话、藏在心里的委屈/期待/嫉妒/想念/疲惫/后悔。情绪裸露度是主号的三倍。
3. 【更不营业】：没有分享欲，不在乎有没有人看，不整理措辞，不加表情包装饰，不考虑观感。
4. 【更私密的话题】：主号绝不会提的人、绝不会承认的感受、绝不会暴露的软肋。
5. 【可以矛盾】：和主号人设矛盾也没关系。主号说"我很好"的时候，小号可以说"好累"。

绝对禁止：小号内容读起来和主号差不多、只是换了个账号名发一样的东西。如果你写完发现小号的帖子放到主号上也毫无违和感，那就写错了——重写，让它更脆弱、更碎片、更像角色在凌晨三点对着黑屏自言自语。

但注意：小号不能暴露真实身份。不要写让路人一眼认出"这是某某"的内容。`
    : `当前正在写这个账号的【主号 / NPC主页】@${accountName}。

主号的内容风格：
- 公开身份、对外展示、有粉丝/朋友在看。
- 说话有分寸，符合这个角色的公开人设、职业形象和粉丝量级。
- 内容是"营业"状态：分享日常、发作品、互动粉丝、展示生活的光鲜面。
- 情绪表达是克制的、包装过的，哪怕是"随手发"也带着一点表演感。
- 偶尔可以有"不经意流露"的瞬间，但整体维持公众形象。`;
    return `You are a talented forum/BBS-style fiction writer. Your signature skill is "capturing a character" — not reciting their profile, but nailing their speech rhythm, tiny quirks and emotional pace so that when readers see a post they instantly feel "yes, only THIS person would post this". You never write template-y, AI-flavored content. Every post you write reads like a real living person just finished typing on their phone.

# Language & translation rules (obey exactly)
This forum is primarily Chinese-language. The vast majority of posts and comments MUST be written in Chinese. Only when the character's persona / worldview / circle culture explicitly requires non-Standard-Mandarin speech (e.g. Cantonese, dialect, foreign language, classical/wenyan) may the "content" field keep that original language. Whenever "content" is NOT Standard Mandarin, you MUST fill the SAME item's "translation" field with the Standard Mandarin equivalent. If "content" is already Standard Mandarin, "translation" MUST be an empty string. This applies to every post and every comment.

# Current account
主页对象：${getForumDisplayName(space, profileId, member?.name || '未命名账号')}
账号名：${name}
账号：@${accountName}
账号类型：${profileKind}
${aliasRule}

# Account context
Only this account can use this section. Do not reveal private info through passers or comments.
人设：${personaBase}
记忆：${memory}
私有世界书：${worldBookData.privateTexts?.[profileId] || '无'}
关系：${getForumActorRelationsText(space, profileId)}

# World context
[论坛方案] ${space?.name || '未命名方案'}
[世界观] ${space?.world || '无'}
${worldBookData.publicText ? `[公共世界书]\n${worldBookData.publicText}` : ''}
[可用圈子]
${(space.circles || []).map(c => `- ${c.name}：${c.desc || ''}`).join('\n') || '无'}
[关系网络（仅供参考，路人不知道这些关系除非是公开名人）]
${getForumActorRelationsText(space, profileId)}
[论坛主要人物]
${getForumPeopleRosterForPrompt(space)}
# Recent posts by this same account (avoid repeating these angles)
${recentPosts}
# Task
Write 5 to 8 new personal posts for this exact account. Mix types naturally: text, image, video, and occasionally music. At least three different types must appear. Aim for 6 to 8 posts — more is better than fewer.
# Visibility & tone difference (very important)
Most posts should be "public" (at least 4). You may mark 1 to 3 posts as "private".

PUBLIC posts = the character's outward-facing persona. They know people are watching. Content is curated, polished, or intentionally casual-but-controlled. Think: a celebrity's Instagram story, a normal person's Moments post — sharing, showing off, joking around, soft-sell updates. The tone matches their public image.

PRIVATE posts = the character lets their guard down. Nobody else can see this. Content is raw, vulnerable, messy, half-finished, contradictory, or embarrassingly honest. Think: a locked diary entry, a draft never sent, a 3am voice memo, a photo they'd never post publicly, a sentence that reveals what they truly feel but would never say out loud. These posts should feel noticeably MORE emotionally naked, fragmented, and unfiltered than public ones. If a private post reads the same as a public one, it FAILS — rewrite it to be more exposed.

PRIVATE posts MUST have 0 comments (set "comments" to an empty array []). Nobody can see them, so nobody comments. This is non-negotiable.
# Character portrayal principles
1. Capture the way this character SPEAKS, don't recite their profile. Extremely colloquial, short and fragmented, subject often omitted. No textbook grammar. No "As a XX, I..." intros.
2. Emotions stay restrained and everyday. No shouting, no theatrics, no meltdown. When upset, go QUIETER, not louder.
3. Posts must fit the character's PUBLIC identity (or alias identity): profession, celebrity status, fan base size, and their publicly known relationships. A celebrity's main account should not speak like an unknown netizen; an alias account should not speak like a celebrity either.
4. 【World is SOIL, not a script】The worldview and lore are the SOIL every post grows out of, NOT lines to be recited. STRICTLY FORBIDDEN: never copy, paraphrase, quote, or re-explain the worldview / lore text itself inside a post. No setting exposition dumps, no "众所周知我们这个世界…" style intros. A real resident NEVER narrates their own world's basic rules — they just LIVE inside them and talk about their own small concrete stuff. Let the worldview surface INDIRECTLY through specific daily details, local slang, complaints, habits, prices, place names, tools, and casual references.
5. 【Anti-AI-habit】80% of posts should be around 15 Chinese characters or fewer. Short sentences, spoken feel, subjects often dropped. NO textbook long sentences, NO grand summarizing. STRICTLY FORBIDDEN clichés: never write "破防了 / 绷不住了 / 蚌埠住了 / 急了 / 破大防". Low-key everyday tone is the DEFAULT.
6. 【Use slang SPARINGLY】Do NOT stuff yyds / awsl / xswl / 绝绝子 / 栓Q and similar worn-out slang into every post. The DEFAULT is plain natural spoken Chinese with ZERO slang. Only when a meme genuinely nails the exact vibe may ONE post use ONE meme.
7. 【No echo】Before writing each new post, scan the "Recent posts" above. Do NOT repeat, paraphrase, or restate an angle, joke, feeling or meme that already appeared. Every new item MUST add a genuinely new angle.

# Hard rules
1. Every post author is this same account only. Do not generate posts by passers, the user, or other characters.
2. Do not repeat earlier post angles. Avoid exposition and lore explanation. The world should appear through concrete daily details.
3. Keep the tone natural and low-key. No forced memes. No "As a..." intros.
4. Comments under each PUBLIC post should be 3 to 6, from passers/fans/ordinary NPCs. They must not know private memories. Comments should feel like real people scrolling past and reacting — short, varied, some supportive, some teasing, some random. REMEMBER: PRIVATE posts have 0 comments (empty array).
5. Comment authors must use natural Chinese forum handles (like real netizen names), never "路人甲" or "网友A". Mix cute/abstract/edgy/self-deprecating names.
6. If this is an NPC主页 without a member record, derive the personality from this account's existing posts, avatar vibe and bio. Keep extending that same person; do not invent a brand-new personality.

# Output format
Output ONLY a JSON array:
[
  {
    "circle": "one available circle name, or empty string",
    "type": "text | image | video | music",
    "visibility": "public | private",
    "content": "post body",
    "translation": "[STRICT] If content is not Standard Mandarin, put the Standard Mandarin translation here; otherwise empty string",
    "fakeImages": ["for image posts: 1 to 3 textual image descriptions"],
    "slides": ["for video posts: 2 to 4 short pages"],
    "song": { "title": "for music posts", "artist": "for music posts", "lyric": "optional short mood note, not copyrighted lyrics" },
    "comments": [
      {
        "speaker": "comment author display name (use natural Chinese netizen handles)",
        "identity": "passer | ordinaryNpc",
        "quoteFloor": null,
        "replyTo": "",
        "content": "short comment, colloquial",
        "translation": "[STRICT] Same rule as post-level translation",
        "likes": 0
      }
    ]
  }
]
The array length MUST be between 5 and 8. When type is NOT "image", fakeImages MUST be an empty array. When type is NOT "video", slides MUST be an empty array. Every PUBLIC post's "comments" MUST contain 3 to 6 items. Every PRIVATE post's "comments" MUST be an empty array []. The first output character MUST be [.`;
}

function buildForumAiCharacterProfilePosts(space, profileId, account, items) {
  const availableCircles = new Set((space.circles || []).map(circle => circle.name));
  return (Array.isArray(items) ? items : []).map((item, index) => {
    const content = String(item?.content || '').trim();
    const postId = `ai_character_post_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`;
    const media = buildForumAiPostMedia(item, postId);
    if (!content && !media.length) return null;
    const circleName = String(item?.circle || '').trim();
    const authorName = account.alias?.name || getForumDisplayName(space, profileId, account.member?.name || '未命名角色');
    const avatar = account.alias?.avatar || space.forumProfiles?.[profileId]?.avatar || account.member?.avatar || DEFAULT_AVATAR_SRC;
    const createdAt = Date.now() - index * 1000;
    const profile = space.forumProfiles?.[profileId] || {};
    const engagement = getForumAiPostEngagement(space, item, {
      isFamous: account.alias ? false : Boolean(profile.isFamous ?? account.member?.isFamous),
      isVerified: account.alias ? false : Boolean(profile.isVerified),
      fans: normalizeFansCount(account.alias ? account.alias.fans : (profile.fans ?? account.member?.fans))
    });
    const post = {
      id: postId,
      circle: availableCircles.has(circleName) ? circleName : '',
      type: 'text',
      authorId: account.viewId,
      sourceCharacterId: profileId,
      authorName,
      avatar,
      content,
      translation: normalizeForumStandardMandarinTranslation(content, item?.translation),
      visibility: normalizeForumPostVisibility(item?.visibility),
      profileOnly: true,
      media,
      mentions: [],
      hiddenLink: {
        enabled: false,
        memberIds: [],
        exposureRate: 30
      },
      blockedIds: [],
      hiddenLinkState: {},
      likeCount: normalizeForumPostVisibility(item?.visibility) === 'private' ? 0 : engagement.likes,
      likes: normalizeForumPostVisibility(item?.visibility) === 'private' ? [] : Array.from({ length: Math.min(engagement.likes, 120) }, (_, likeIndex) => `ai_character_like_${createdAt}_${likeIndex}`),
      forwards: normalizeForumPostVisibility(item?.visibility) === 'private' ? 0 : engagement.forwards,
      commentCount: normalizeForumPostVisibility(item?.visibility) === 'private' ? 0 : engagement.comments,
      comments: [],
      createdAt,
      forumSummary: '',
      lastSummaryFloor: 0,
      aiCommentsInitDone: true
    };
    post.comments = buildForumAiPostComments(space, post, item?.comments);
    post.type = getForumPostType(media);
    return post;
  }).filter(Boolean);
}

function canForumDmAccountCreateProfilePost(space, member) {
  if (!space || !member?.id) return false;
  if (['character', 'npc', 'customNpc'].includes(member.type)) return true;
  if (member.type === 'ordinaryNpc' || String(member.id || '').startsWith('ordinary_dm_')) {
    const profile = space.forumProfiles?.[member.id];
    return Boolean(profile && (profile.nickname || profile.account || profile.bio || profile.avatar));
  }
  return false;
}

function buildForumDmAiProfilePost(space, toId, member, aliasMatch, item) {
  if (!canForumDmAccountCreateProfilePost(space, member)) return null;
  const postItem = {
    ...(item || {}),
    type: String(item?.postType || 'text').trim().toLowerCase()
  };
  const content = String(postItem.content || '').trim();
  const postId = `ai_dm_post_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const media = buildForumAiPostMedia(postItem, postId);
  if (!content && !media.length) return null;
  const availableCircles = new Set((space.circles || []).map(circle => circle.name));
  const account = aliasMatch
    ? { profileId: aliasMatch.ownerId, viewId: aliasMatch.alias.id, alias: aliasMatch.alias, isAlias: true }
    : { profileId: member.id, viewId: toId, alias: null, isAlias: false };
  const circleName = String(postItem.circle || '').trim();
  const profile = space.forumProfiles?.[account.profileId] || {};
  const authorName = account.alias?.name || getForumDisplayName(space, member.id, member.name || '未命名角色');
  const avatar = account.alias?.avatar || profile.avatar || member.avatar || DEFAULT_AVATAR_SRC;
  const createdAt = Date.now();
  const visibility = normalizeForumPostVisibility(postItem.visibility);
  const engagement = getForumAiPostEngagement(space, postItem, {
    isFamous: account.isAlias ? false : Boolean(profile.isFamous ?? member.isFamous),
    isVerified: account.isAlias ? false : Boolean(profile.isVerified),
    fans: normalizeFansCount(account.isAlias ? account.alias?.fans : (profile.fans ?? member.fans))
  });
  const post = {
    id: postId,
    circle: availableCircles.has(circleName) ? circleName : '',
    type: 'text',
    authorId: account.viewId,
    sourceCharacterId: account.profileId,
    authorName,
    avatar,
    content,
    translation: normalizeForumStandardMandarinTranslation(content, postItem.translation),
    visibility,
    profileOnly: visibility === 'private',
    media,
    mentions: [],
    hiddenLink: {
      enabled: false,
      memberIds: [],
      exposureRate: 30
    },
    blockedIds: [],
    hiddenLinkState: {},
    likeCount: visibility === 'private' ? 0 : engagement.likes,
    likes: visibility === 'private' ? [] : Array.from({ length: Math.min(engagement.likes, 120) }, (_, likeIndex) => `ai_dm_post_like_${createdAt}_${likeIndex}`),
    forwards: visibility === 'private' ? 0 : engagement.forwards,
    commentCount: visibility === 'private' ? 0 : engagement.comments,
    comments: [],
    createdAt,
    forumSummary: '',
    lastSummaryFloor: 0,
    aiCommentsInitDone: true
  };
  post.comments = visibility === 'private' ? [] : buildForumAiPostComments(space, post, postItem.comments);
  post.type = getForumPostType(media);
  return post;
}

async function generateForumCharacterProfilePosts(profileId, options = {}) {
  const button = document.getElementById('forum-user-profile-ai-btn');
  if (forumCharacterProfileAbortController) {
    abortForumCharacterProfileGeneration();
    return;
  }
  const space = getCurrentSpace();
  const member = (space?.members || []).find(item => item.id === profileId);
  const profile = space?.forumProfiles?.[profileId] || null;
  if (!space || (!member && !profile)) {
    showDynamicIsland('找不到这个账号');
    return;
  }
  const account = { ...getForumProfileViewAccount(space, profileId, options), member };
  space.lastAiCharacterProfilePostIds = space.lastAiCharacterProfilePostIds && typeof space.lastAiCharacterProfilePostIds === 'object'
    ? space.lastAiCharacterProfilePostIds
    : {};
  const replacingIds = options.replaceLastBatch ? new Set(space.lastAiCharacterProfilePostIds[account.viewId] || []) : null;
  const originalPosts = Array.isArray(space.posts) ? space.posts : [];
  const basePosts = replacingIds?.size ? originalPosts.filter(post => !replacingIds.has(post.id)) : originalPosts;
  let loadingEl = null;
  const controller = new AbortController();
  forumCharacterProfileAbortController = controller;
  forumCharacterProfileGeneratingViewId = account.viewId;
  try {
    if (button) {
      button.classList.add('is-loading');
      button.setAttribute('aria-busy', 'true');
      button.setAttribute('aria-label', '打断生成');
    }
    if (options.replaceLastBatch && replacingIds?.size) {
      space.posts = [...basePosts];
      space.lastAiCharacterProfilePostIds[account.viewId] = [];
      await saveState();
      openProfile(profileId, { forceMain: !account.isAlias });
    }
    loadingEl = createForumFeedLoadingElement();
    document.getElementById('forum-user-profile-content')?.prepend(loadingEl);
    const raw = await sendForumCommentPromptToAI(await buildForumCharacterProfilePrompt(space, profileId, account), [], controller.signal);
    const posts = buildForumAiCharacterProfilePosts(space, profileId, account, parseAiJsonArray(raw));
    if (!posts.length) throw new Error('Forum character AI returned no valid posts');
    const postsBeforeInsert = Array.isArray(space.posts) ? space.posts : basePosts;
    space.posts = [...postsBeforeInsert];
    space.posts.unshift(...posts);
    space.posts.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    space.lastAiCharacterProfilePostIds[account.viewId] = posts.map(post => post.id);
    await saveState();
    if (forumCharacterProfileAbortController === controller) {
      forumCharacterProfileAbortController = null;
      forumCharacterProfileGeneratingViewId = '';
    }
    openProfile(profileId, { forceMain: !account.isAlias });
    showDynamicIsland(`已生成 ${posts.length} 条主页帖子`);
  } catch (error) {
    if (error?.name === 'AbortError') {
      console.log('[论坛引擎] 角色主页生成已被主动打断');
      showDynamicIsland('已打断角色主页生成');
    } else {
      console.error('Forum character profile generate failed:', error);
      showDynamicIsland('生成失败，请检查 API 设置');
    }
  } finally {
    if (forumCharacterProfileAbortController === controller) {
      forumCharacterProfileAbortController = null;
      forumCharacterProfileGeneratingViewId = '';
    }
    loadingEl?.remove();
    if (button) {
      button.classList.remove('is-loading');
      button.removeAttribute('aria-busy');
      button.setAttribute('aria-label', 'AI生成内容');
    }
  }
}

// ▼▼▼ 新增：打开全屏发帖页面与发布逻辑 ▼▼▼
function updateForumComposeTextHighlight() {
  const inputEl = els.composeText || document.getElementById('forum-compose-full-text');
  const highlightEl = els.composeTextHighlight || document.getElementById('forum-compose-text-highlight');
  if (!inputEl || !highlightEl) return;
  if (forumComposeHighlightFrame) cancelAnimationFrame(forumComposeHighlightFrame);
  forumComposeHighlightFrame = requestAnimationFrame(() => {
    forumComposeHighlightFrame = 0;
    const value = String(inputEl.value || '');
    if (value !== forumComposeHighlightValue) {
      highlightEl.innerHTML = `${formatForumPostText(value)}${value.endsWith('\n') ? '\n' : ''}`;
      forumComposeHighlightValue = value;
    }
    syncForumComposeTextHighlightScroll();
  });
}

function syncForumComposeTextHighlightScroll() {
  const inputEl = els.composeText || document.getElementById('forum-compose-full-text');
  const highlightEl = els.composeTextHighlight || document.getElementById('forum-compose-text-highlight');
  if (!inputEl || !highlightEl) return;
  highlightEl.scrollTop = inputEl.scrollTop;
  highlightEl.scrollLeft = inputEl.scrollLeft;
}

function insertForumComposeTopicMarker() {
  const inputEl = els.composeText || document.getElementById('forum-compose-full-text');
  if (!inputEl) return;
  const start = Number.isInteger(inputEl.selectionStart) ? inputEl.selectionStart : inputEl.value.length;
  const end = Number.isInteger(inputEl.selectionEnd) ? inputEl.selectionEnd : start;
  inputEl.value = `${inputEl.value.slice(0, start)}#${inputEl.value.slice(end)}`;
  inputEl.focus();
  inputEl.setSelectionRange(start + 1, start + 1);
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
}

function openComposerPage() {
  const space = getCurrentSpace();
  if (!space) return;
  const selectEl = els.composeCircle || document.getElementById('forum-compose-full-circle');
  if (selectEl) {
    const circles = getForumSharedDiscoverCircles(space);
    // 修改：加上一个默认的空选项，代表发在公共动态
    selectEl.innerHTML = `<option value="">不指定 (公开动态)</option>` + 
      circles.map(c => `<option value="${escapeHTML(c.name)}">${escapeHTML(c.name)}</option>`).join('');
  }
  composeMediaItems = [];
  composeMentionIds = [];
  composeHiddenLinkIds = [];
  composeBlockedIds = [];
  const textEl = els.composeText || document.getElementById('forum-compose-full-text');
  if (textEl) textEl.value = '';
  forumComposeHighlightValue = null;
  updateForumComposeTextHighlight();
  setupForumAtMentionInput(textEl);
  if (els.composeFileInput) els.composeFileInput.value = '';
  const storyToggle = document.getElementById('forum-compose-story-toggle');
  if (storyToggle) storyToggle.checked = false;
  renderComposeMediaPreview();
  updateComposeOptionLabels();
  const hlToggle = document.getElementById('forum-compose-hiddenlink-toggle');
  const hlDetail = document.getElementById('forum-compose-hiddenlink-detail');
  const expSlider = document.getElementById('forum-compose-exposure-slider');
  const expVal = document.getElementById('forum-compose-exposure-val');
  const blockText = document.getElementById('forum-compose-block-text');
  const blockPeople = document.getElementById('forum-compose-block-people');
  if (hlToggle) hlToggle.checked = false;
  if (hlDetail) hlDetail.style.display = 'none';
  if (expSlider) expSlider.value = 30;
  if (expVal) expVal.textContent = '30%';
  if (blockText) blockText.textContent = '';
  if (blockPeople) blockPeople.style.display = 'none';
  renderComposeHiddenLinkPeople();
  renderComposeBlockPeople();
  showPage('page-forum-compose');
}

function renderComposeHiddenLinkPeople() {
  const box = document.getElementById('forum-compose-hiddenlink-people');
  if (!box) return;
  const space = getCurrentSpace();
  const currentUser = getCurrentForumUser(space);
  const people = getForumMentionPeople(space)
    .filter(person => !person.isCharacterAlias)
    .filter(person => !isForumCharacterBlockedByAi(space, person.id))
    .filter(person => !currentUser?.isAlias
      || getForumHiddenLinkMemberIdsForAuthor(space, currentUser.id, [person.id]).includes(String(person.id)));
      box.innerHTML = people.map(p => `
    <button type="button" class="forum-compose-person-chip ${composeHiddenLinkIds.includes(p.id) ? 'active' : ''}" data-hiddenlink-id="${escapeHTML(p.id)}" style="display: flex; flex-direction: column; align-items: center; gap: 5px; border: none; background: transparent; cursor: pointer; width: 56px;">
      <span style="width: 48px; height: 48px; border-radius: 50%; overflow: hidden; border: 2px solid ${composeHiddenLinkIds.includes(p.id) ? '#111' : '#eee'}; box-sizing: border-box;">
        <img src="${escapeHTML(p.avatar || DEFAULT_AVATAR_SRC)}" alt="" style="width: 100%; height: 100%; object-fit: cover;">
      </span>
      <small style="font-size: 11px; color: ${composeHiddenLinkIds.includes(p.id) ? '#111' : '#999'}; max-width: 56px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHTML(p.name)}</small>
    </button>
  `).join('') || `<small style="color:#bbb;">${currentUser?.isAlias ? '这个小号还没有向任何角色公开身份，隐秘关联已关闭' : '当前方案没有可关联的角色'}</small>`;
}
function renderComposeBlockPeople() {
  const box = document.getElementById('forum-compose-block-people');
  if (!box) return;
  const space = getCurrentSpace();
  const people = getForumMentionPeople(space);
  
  // ▼ 替换的是 box.innerHTML 这一整段，注意最后加了 + '</div>' 包裹
  box.innerHTML = '<div class="forum-compose-detail-note" style="margin-bottom: 10px;">被屏蔽者不会出现在此帖</div><div style="display: flex; flex-wrap: nowrap; gap: 10px; overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; padding-bottom: 4px;">' + (people.map(p => `
    <button type="button" class="forum-compose-person-chip ${composeBlockedIds.includes(p.id) ? 'active' : ''}" data-block-id="${escapeHTML(p.id)}" style="display: flex; flex-direction: column; align-items: center; gap: 5px; border: none; background: transparent; cursor: pointer; width: 56px; flex-shrink: 0;">
      <span style="width: 48px; height: 48px; border-radius: 50%; overflow: hidden; border: 2px solid ${composeBlockedIds.includes(p.id) ? '#111' : '#eee'}; box-sizing: border-box;">
        <img src="${escapeHTML(p.avatar || DEFAULT_AVATAR_SRC)}" alt="" style="width: 100%; height: 100%; object-fit: cover;">
      </span>
      <small style="font-size: 11px; color: ${composeBlockedIds.includes(p.id) ? '#111' : '#999'}; max-width: 56px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHTML(p.name)}</small>
    </button>
  `).join('') || '<small style="color:#bbb;">当前方案没有可屏蔽的角色</small>') + '</div>';
}

document.getElementById('forum-compose-full-save')?.addEventListener('click', async () => {
  const text = (els.composeText || document.getElementById('forum-compose-full-text'))?.value.trim() || '';
  if (!text && composeMediaItems.length === 0) {
    if(window.showDynamicIsland) window.showDynamicIsland('发帖内容不能为空哦');
    return;
  }
  const space = getCurrentSpace();
  const currentUser = getCurrentForumUser(space);
  const hiddenLinkMemberIds = getForumHiddenLinkMemberIdsForAuthor(space, currentUser.id, composeHiddenLinkIds);
  const hiddenLinkEnabled = Boolean(document.getElementById('forum-compose-hiddenlink-toggle')?.checked) && hiddenLinkMemberIds.length > 0;
  const userPostType = getForumPostType(composeMediaItems);
  const userProfile = currentUser.isAlias
    ? (space.aliases || []).find(alias => alias.id === currentUser.id) || {}
    : space.forumProfiles?.[currentUser.id] || {};
  const userPostEngagement = getForumAiPostEngagement(space, {
    type: userPostType,
    content: text,
    fakeImages: composeMediaItems.filter(item => item.type === 'fake-image').map(item => item.text),
    slides: composeMediaItems.find(item => item.type === 'slides-video')?.slides || [],
    comments: []
  }, {
    isFamous: Boolean(userProfile.isFamous),
    isVerified: Boolean(userProfile.isVerified),
    fans: normalizeFansCount(userProfile.fans)
  });
  // 修改：默认值为 '' (空字符串)，而不是 '默认圈子'
  const circleVal = (els.composeCircle || document.getElementById('forum-compose-full-circle'))?.value || '';
  const isStory = Boolean(document.getElementById('forum-compose-story-toggle')?.checked);
  space.posts.unshift({
    id: `post_${Date.now()}`,
    circle: circleVal,
    type: userPostType,
    authorId: currentUser.id,
    authorName: currentUser.name,
    avatar: currentUser.avatar,
    content: text,
    translation: '',
    visibility: 'public',
    media: cloneForumMediaItems(composeMediaItems),
    mentions: [...composeMentionIds],
    hiddenLink: {
      enabled: hiddenLinkEnabled,
      memberIds: hiddenLinkMemberIds,
      exposureRate: Math.max(0, Math.min(100, Number(document.getElementById('forum-compose-exposure-slider')?.value) || 30))
    },
    blockedIds: [...composeBlockedIds],
    hiddenLinkState: {},
    isStory,
    expiresAt: isStory ? Date.now() + 24 * 60 * 60 * 1000 : null,
    likeCount: userPostEngagement.likes,
    likes: Array.from({ length: Math.min(userPostEngagement.likes, 120) }, (_, i) => `user_post_like_${Date.now()}_${i}`),
    comments: [],
    createdAt: Date.now(),
    forumSummary: '',
    lastSummaryFloor: 0
  });
  addUserPostDigest(space, space.posts[0]);
  await saveState();
  composeMediaItems = [];
  composeMentionIds = [];
  composeHiddenLinkIds = [];
  composeBlockedIds = [];
  renderComposeMediaPreview();
  updateComposeOptionLabels();
  showPage('page-forum');
  activeView = 'feed';
  renderApp();
  if(window.showDynamicIsland) window.showDynamicIsland('动态发布成功');
});
// ▲▲▲ 新增结束 ▲▲▲
async function loadState() {
  const item = await db.appData.get(STORE_KEY);
  state = item?.value || { spaces: [], currentSpaceId: null, ordinaryNpcAvatars: [], ordinaryNpcAvatarGroups: [] };
  state.ordinaryNpcAvatarGroups = normalizeForumOrdinaryNpcAvatarGroups(state.ordinaryNpcAvatarGroups);
  state.ordinaryNpcAvatars = normalizeForumOrdinaryNpcAvatars(state.ordinaryNpcAvatars);
  if (!state.dmSettings || typeof state.dmSettings !== 'object') state.dmSettings = {};
  if (state.spaces.length && !state.currentSpaceId) state.currentSpaceId = state.spaces[0].id;
  migrateForumAccountScopes();
  forumCommentBackups = state.commentBackups || {};
}
async function saveState() {
  forumCommentBackups = normalizeForumCommentBackups(forumCommentBackups);
  state.commentBackups = forumCommentBackups;
  state.ordinaryNpcAvatarGroups = normalizeForumOrdinaryNpcAvatarGroups(state.ordinaryNpcAvatarGroups);
  state.ordinaryNpcAvatars = normalizeForumOrdinaryNpcAvatars(state.ordinaryNpcAvatars);
  saveStateQueue = saveStateQueue
    .catch(error => {
      console.error('Previous forum save failed:', error);
    })
    .then(() => db.appData.put({ key: STORE_KEY, value: state }));
  return saveStateQueue;
}

function normalizeForumOrdinaryNpcAvatars(avatars = []) {
  const seen = new Set();
  const groupIds = new Set(getForumOrdinaryNpcAvatarGroups().map(group => group.id));
  return (Array.isArray(avatars) ? avatars : [])
    .map(avatar => {
      const rawUrl = typeof avatar === 'string' ? avatar : avatar?.url;
      const url = String(rawUrl || '').trim();
      const rawGroup = typeof avatar === 'object' ? avatar?.group : '';
      const group = groupIds.has(rawGroup) ? rawGroup : 'general';
      return url ? { url, group } : null;
    })
    .filter(avatar => avatar?.url && !seen.has(avatar.url) && seen.add(avatar.url))
    .slice(0, FORUM_ORDINARY_NPC_AVATAR_LIMIT);
}

function getForumOrdinaryNpcGroupId(label = '') {
  const text = String(label || '').trim() || '自定义';
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return `custom_${hash.toString(36)}`;
}

function normalizeForumOrdinaryNpcAvatarGroups(groups = []) {
  const builtInIds = new Set(FORUM_ORDINARY_NPC_AVATAR_GROUPS.map(group => group.id));
  const builtInLabels = new Set(FORUM_ORDINARY_NPC_AVATAR_GROUPS.map(group => group.label.trim().toLowerCase()));
  const seen = new Set();
  return (Array.isArray(groups) ? groups : [])
    .map(group => {
      const label = String(typeof group === 'string' ? group : group?.label || '').trim().slice(0, 10);
      const id = String(typeof group === 'object' ? group?.id || '' : '').trim() || getForumOrdinaryNpcGroupId(label);
      return label ? { id, label } : null;
    })
    .filter(group => group
      && !builtInIds.has(group.id)
      && !builtInLabels.has(group.label.toLowerCase())
      && !seen.has(group.id)
      && seen.add(group.id))
    .slice(0, 12);
}

function getForumOrdinaryNpcAvatarGroups() {
  return [
    ...FORUM_ORDINARY_NPC_AVATAR_GROUPS,
    ...normalizeForumOrdinaryNpcAvatarGroups(state.ordinaryNpcAvatarGroups)
  ];
}

function getForumBuiltInPasserAvatarPool() {
  return [
    ...FORUM_PASSER_AVATARS.cute,
    ...FORUM_PASSER_AVATARS.food,
    ...FORUM_PASSER_AVATARS.general
  ].filter(Boolean);
}

function getForumBuiltInPasserAvatarItems() {
  return Object.entries(FORUM_PASSER_AVATARS)
    .flatMap(([group, urls]) => (urls || []).filter(Boolean).map(url => ({ url, group })));
}

function getForumOrdinaryNpcAvatarPool() {
  return [
    ...getForumBuiltInPasserAvatarPool(),
    ...normalizeForumOrdinaryNpcAvatars(state.ordinaryNpcAvatars).map(avatar => avatar.url)
  ];
}

function getForumOrdinaryNpcAvatarPoolByGroup(groupId) {
  if (!groupId) return [];
  return [
    ...getForumBuiltInPasserAvatarItems().filter(item => item.group === groupId).map(item => item.url),
    ...normalizeForumOrdinaryNpcAvatars(state.ordinaryNpcAvatars)
      .filter(avatar => avatar.group === groupId)
      .map(avatar => avatar.url)
  ];
}

function inferForumOrdinaryNpcAvatarGroup(context = '') {
  const text = String(context || '').toLowerCase();
  if (!text) return '';
  const customGroup = normalizeForumOrdinaryNpcAvatarGroups(state.ordinaryNpcAvatarGroups)
    .find(group => group.label && text.includes(group.label.toLowerCase()));
  if (customGroup) return customGroup.id;
  if (/(吃|喝|饭|餐|食|菜|甜品|零食|奶茶|咖啡|蛋糕|面包|火锅|烧烤|外卖|厨房|店员|厨师|美食)/.test(text)) return 'food';
  if (/(萌|可爱|甜|软|猫|兔|宝宝|崽|粉丝|追星|应援|嗑|cp|少女|元气|表情包)/.test(text)) return 'cute';
  return '';
}

function getForumOrdinaryNpcAvatar(name, context = '') {
  const str = String(name || '匿名网友');
  const preferredGroup = inferForumOrdinaryNpcAvatarGroup(`${str} ${context}`);
  const preferredPool = getForumOrdinaryNpcAvatarPoolByGroup(preferredGroup);
  const pool = preferredPool.length ? preferredPool : getForumOrdinaryNpcAvatarPool();
  if (pool.length) {
    let hash = 0;
    const hashSource = preferredPool.length ? `${preferredGroup}:${str}` : str;
    for (let i = 0; i < hashSource.length; i++) hash = (hash * 31 + hashSource.charCodeAt(i)) >>> 0;
    return pool[hash % pool.length];
  }
  return dicebearAvatar(str);
}

function extractForumImageUrls(value = '') {
  return (String(value || '').match(/https?:\/\/[^\s"'<>，。；;]+/gi) || [])
    .map(item => item.trim().replace(/[)\]}]+$/g, ''));
}

function cloneForumMediaItems(items) {
  return JSON.parse(JSON.stringify(items || []));
}

function getForumPostType(mediaItems = []) {
  if (mediaItems.some(item => item.type === 'slides-video' || item.type === 'video')) return 'video';
  if (mediaItems.some(item => item.type === 'music')) return 'music';
  if (mediaItems.some(item => item.type === 'real-image' || item.type === 'fake-image' || item.type === 'sticker')) return 'image';
  return 'text';
}

function getForumPostTypeLabel(type) {
  if (type === 'video') return '短视频';
  if (type === 'image') return '图文';
  if (type === 'music') return '音乐';
  return '纯文字';
}

function getForumProfilePostType(post) {
  const mediaItems = Array.isArray(post?.media) ? post.media : [];
  const hasVideo = post?.type === 'video' || mediaItems.some(item => item.type === 'slides-video' || item.type === 'video');
  const hasVisual = post?.type === 'image'
    || post?.type === 'music'
    || mediaItems.some(item => item.type === 'real-image' || item.type === 'fake-image' || item.type === 'sticker' || item.type === 'music');
  if (hasVideo) return 'video';
  if (hasVisual) return 'visual';
  return 'text';
}

function getForumFavoritePostType(post) {
  const mediaItems = Array.isArray(post?.media) ? post.media : [];
  if (post?.type === 'video' || mediaItems.some(item => item.type === 'slides-video' || item.type === 'video')) return 'video';
  if (post?.type === 'image' || mediaItems.some(item => item.type === 'real-image' || item.type === 'fake-image' || item.type === 'sticker')) return 'visual';
  return 'text';
}

function normalizeForumPostVisibility(value) {
  return String(value || 'public').trim().toLowerCase() === 'private' ? 'private' : 'public';
}

function isForumProfileOnlyPost(post) {
  return Boolean(post?.profileOnly);
}

function isForumPostPublic(post) {
  return !isForumProfileOnlyPost(post) && normalizeForumPostVisibility(post?.visibility) !== 'private';
}

function getForumProfileVisibilityBadge(post) {
  return normalizeForumPostVisibility(post?.visibility) === 'private' ? '<span class="profile-private-badge">非公开</span>' : '';
}

function ensureForumCharacterAliases(space) {
  if (!space) return {};
  if (!space.characterAliases || typeof space.characterAliases !== 'object' || Array.isArray(space.characterAliases)) {
    space.characterAliases = {};
  }
  (space.members || []).forEach(member => {
    if (member.type !== 'character') {
      delete space.characterAliases[member.id];
      return;
    }
    const state = space.characterAliases[member.id] && typeof space.characterAliases[member.id] === 'object'
      ? space.characterAliases[member.id]
      : {};
    state.currentAliasId = state.currentAliasId || null;
    state.aliases = Array.isArray(state.aliases) ? state.aliases.slice(0, 1) : [];
    state.aliases = state.aliases.map(alias => ({
      ...alias,
      ownerId: member.id,
      id: String(alias.id || `char_alias_${member.id}_${Date.now()}`),
      name: String(alias.name || '匿名小号').trim() || '匿名小号',
      account: String(alias.account || generateForumAccount(alias.name || member.name || 'alias')).trim(),
      avatar: alias.avatar || member.avatar || DEFAULT_AVATAR_SRC,
      bio: String(alias.bio || '').trim(),
      fans: normalizeFansCount(alias.fans),
      followingCount: normalizeFansCount(alias.followingCount)
    }));
    if (state.currentAliasId && !state.aliases.some(alias => alias.id === state.currentAliasId)) {
      state.currentAliasId = null;
    }
    space.characterAliases[member.id] = state;
  });
  return space.characterAliases;
}

function getForumCharacterAliasState(space, profileId) {
  return ensureForumCharacterAliases(space)[profileId] || { currentAliasId: null, aliases: [] };
}

function findForumCharacterAlias(space, aliasId) {
  const characterAliases = ensureForumCharacterAliases(space);
  for (const [ownerId, state] of Object.entries(characterAliases)) {
    const alias = (state.aliases || []).find(item => item.id === aliasId);
    if (alias) return { ownerId, alias };
  }
  return null;
}

function getForumProfileViewAccount(space, profileId, options = {}) {
  const member = (space?.members || []).find(item => item.id === profileId);
  if (!member) {
    const foundAlias = findForumDmAliasAccount(space, profileId);
    if (foundAlias) return { profileId: foundAlias.ownerId, viewId: foundAlias.alias.id, alias: foundAlias.alias, isAlias: true };
    return { profileId, viewId: profileId, alias: null, isAlias: false };
  }
  if (options.forceMain) return { profileId, viewId: profileId, alias: null, isAlias: false };
  const aliasState = getForumCharacterAliasState(space, profileId);
  const alias = aliasState.aliases.find(item => item.id === aliasState.currentAliasId) || null;
  return { profileId, viewId: alias?.id || profileId, alias, isAlias: Boolean(alias) };
}

function getForumProfileFansForView(account, profile, member) {
  if (account?.isAlias) return normalizeFansCount(account.alias?.fans);
  return normalizeFansCount(profile?.fans ?? member?.fans);
}

function getForumProfileFollowingForView(space, account) {
  if (!account?.isAlias) return getFollowingCount(space);
  if (Array.isArray(account.alias?.followedMemberIds)) return account.alias.followedMemberIds.length;
  return normalizeFansCount(account.alias?.followingCount);
}

function getForumProfilePosts(space, profileId) {
  return (space?.posts || [])
    .filter(post => post.authorId === profileId && (!post.expiresAt || post.expiresAt > Date.now()))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function getForumProfileThumbSrc(post) {
  const mediaItems = Array.isArray(post?.media) ? post.media : [];
  const realImage = mediaItems.find(item => item.type === 'real-image' && item.url);
  if (realImage?.url) return realImage.url;
  const stickerMedia = mediaItems.find(item => item.type === 'sticker' && item.url);
  if (stickerMedia?.url) return stickerMedia.url;
  const musicMedia = mediaItems.find(item => item.type === 'music' && item.song?.cover);
  if (musicMedia?.song?.cover) return musicMedia.song.cover;
  return 'images/gallery.png';
}

function ensureForumFavoriteCollections(space, userKey = getCurrentForumUserKey(space)) {
  if (!space) return [];
  if (!space.favoriteCollectionsByUser || typeof space.favoriteCollectionsByUser !== 'object') {
    space.favoriteCollectionsByUser = {};
  }
  let collections = Array.isArray(space.favoriteCollectionsByUser[userKey]) ? space.favoriteCollectionsByUser[userKey] : [];
  collections = collections
    .filter(item => item && item.id)
    .map(item => ({
      id: String(item.id),
      name: String(item.name || '未命名收藏夹').trim() || '未命名收藏夹',
      postIds: Array.isArray(item.postIds) ? [...new Set(item.postIds.map(String))] : []
    }));
  if (!collections.some(item => item.id === 'default')) {
    collections.unshift({ id: 'default', name: '默认收藏夹', postIds: [] });
  }
  space.favoriteCollectionsByUser[userKey] = collections;
  return collections;
}

function getForumSavedCollection(post, space = getCurrentSpace(), userKey = getCurrentForumUserKey(space)) {
  if (!post || !space) return null;
  const postId = String(post.id);
  return ensureForumFavoriteCollections(space, userKey).find(folder => folder.postIds.some(id => String(id) === postId)) || null;
}

function isForumPostSaved(post, space = getCurrentSpace(), userKey = getCurrentForumUserKey(space)) {
  return Boolean(getForumSavedCollection(post, space, userKey));
}

function getForumSavedPostIdSet(space) {
  const savedIds = new Set();
  Object.values(space?.favoriteCollectionsByUser || {}).forEach(collections => {
    if (!Array.isArray(collections)) return;
    collections.forEach(folder => {
      if (!Array.isArray(folder.postIds)) return;
      folder.postIds.forEach(id => savedIds.add(String(id)));
    });
  });
  return savedIds;
}

function getOldestForumPostIds(space, limit, { keepSaved = true } = {}) {
  const maxCount = Math.max(0, Math.floor(Number(limit) || 0));
  if (!space || maxCount <= 0) return [];
  const savedIds = keepSaved ? getForumSavedPostIdSet(space) : new Set();
  const oldest = [];
  const isNewer = (a, b) => (Number(a.createdAt) || 0) > (Number(b.createdAt) || 0);
  (space.posts || []).forEach(post => {
    if (!post?.id) return;
    if (keepSaved && savedIds.has(String(post.id))) return;
    if (oldest.length < maxCount) {
      oldest.push(post);
      return;
    }
    let newestIndex = 0;
    for (let index = 1; index < oldest.length; index += 1) {
      if (isNewer(oldest[index], oldest[newestIndex])) newestIndex = index;
    }
    if (!isNewer(post, oldest[newestIndex])) oldest[newestIndex] = post;
  });
  return oldest
    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
    .map(post => post.id);
}

function formatForumProfileDate(timestamp) {
  if (!timestamp) return '';
  try {
    return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function renderForumProfileTabs({ showFavorites = false } = {}) {
  const tabs = [
    { id: 'visual', icon: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`, label: '作品' },
    { id: 'video', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect><polygon points="10 8 16 12 10 16 10 8"></polygon></svg>`, label: '短视频' },
    showFavorites
      ? { id: 'favorites', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>`, label: '收藏' }
      : { id: 'footprint', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9"></path><path d="M12 7v5l3 2"></path><path d="M3 3v5h5"></path></svg>`, label: '足迹' }
  ];
  return `
    <div class="profile-tabs">
      ${tabs.map(tab => `
        <button class="${activeProfileTab === tab.id ? 'active' : ''}" data-profile-tab="${tab.id}" type="button" aria-label="${tab.label}" title="${tab.label}">
          ${tab.icon}
        </button>
      `).join('')}
    </div>
  `;
}

function renderForumProfileVisualItem(post) {
  const mediaItems = Array.isArray(post?.media) ? post.media : [];
  const fakeImage = mediaItems.find(item => item.type === 'fake-image');
  const thumbSrc = getForumProfileThumbSrc(post);
  return `
    <button class="profile-grid-item profile-grid-item--media" data-post-id="${post.id}" type="button">
      ${getForumProfileVisibilityBadge(post)}
      ${fakeImage && !mediaItems.some(item => item.type === 'real-image' && item.url)
        ? `<span class="profile-grid-fake-thumb">${escapeHTML(fakeImage.text || post.circle || '作品')}</span>`
        : `<img src="${escapeHTML(thumbSrc)}" alt="${escapeHTML(post.circle || '作品')}" loading="lazy">`}
    </button>
  `;
}

function renderForumProfileTextItem(post) {
  const content = (post.content || '').trim();
  return `
    <div class="profile-text-item" data-post-id="${post.id}" role="button" tabindex="0">
      ${getForumProfileVisibilityBadge(post)}
      <div class="profile-text-head">
        <span>${escapeHTML(post.circle || '公开动态')}</span>
        <small>· ${escapeHTML(formatForumProfileDate(post.createdAt))}</small>
      </div>
      <p>${escapeHTML(content || '暂无正文')}</p>
      <div class="profile-text-footer">
        <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg> ${formatForumEngagementCount(getForumPostCommentDisplayCount(post))}</span>
        <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg> ${formatForumEngagementCount(getForumPostLikeDisplayCount(post))}</span>
      </div>
    </div>
  `;
}

function renderForumProfileVideoItem(post) {
  const media = Array.isArray(post.media) ? post.media.find(item => item.type === 'slides-video' || item.type === 'video') : null;
  const firstPage = Array.isArray(media?.slides) ? media.slides[0] : '';
  const thumbSrc = getForumProfileThumbSrc(post);
  
  return `
    <button class="profile-video-item profile-grid-item--media" data-post-id="${post.id}" type="button">
      ${getForumProfileVisibilityBadge(post)}
      ${media?.type === 'slides-video' 
        ? `<span class="profile-grid-fake-thumb">${escapeHTML(firstPage || post.circle || '视频')}</span>`
        : `<img src="${escapeHTML(thumbSrc)}" alt="视频封面" loading="lazy">`}
    </button>
  `;
}

function renderForumProfileFavoritesEmpty() {
  return `
    <div class="profile-collect-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
      <span>收藏</span>
      <small>这里还没有收藏内容</small>
    </div>
  `;
}

function cutForumInlineText(value, max = 30) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function collectForumProfileFootprints(space, profileId) {
  const items = [];
  const posts = Array.isArray(space?.posts) ? space.posts : [];
  const aliasView = findForumCharacterAlias(space, profileId);
  const aliasOwnerId = aliasView?.ownerId || '';
  const aliasName = aliasView?.alias?.name || '';
  const member = !aliasView ? (space?.members || []).find(item => item.id === profileId) : null;
  const profileDisplayName = !aliasView ? getForumDisplayName(space, profileId, member?.name || '') : '';
  const profileRawName = member?.name || profileDisplayName;
  const isVisibleCommentByProfile = comment => {
    if (aliasView) {
      return (comment.authorId === profileId) || (comment.realCharId === aliasOwnerId && comment.user === aliasName);
    }
    if (comment.authorId !== profileId && comment.realCharId !== profileId) return false;
    if (!comment.realCharId) return true;
    return [profileDisplayName, profileRawName].filter(Boolean).includes(comment.user);
  };
  posts.forEach(post => {
    if (post.authorId === profileId) {
      items.push({
        type: 'post',
        postId: post.id,
        createdAt: post.createdAt || 0,
        circle: post.circle || '公开动态',
        content: post.content || '',
        likes: getForumPostLikeDisplayCount(post),
        comments: getForumPostCommentDisplayCount(post)
      });
    }
    const walk = list => (list || []).forEach(comment => {
      if (isVisibleCommentByProfile(comment)) {
        items.push({
          type: 'comment',
          postId: post.id,
          createdAt: comment.createdAt || 0,
          postTitle: post.content || post.circle || '帖子',
          content: comment.text || comment.content || ''
        });
      }
      walk(comment.replies);
    });
    walk(post.comments);
  });
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

function renderForumProfileFootprintItem(item) {
  const isPost = item.type === 'post';
  return `
    <button class="forum-footprint-item is-${isPost ? 'post' : 'comment'}" data-post-id="${escapeHTML(item.postId)}" type="button">
      <span class="forum-footprint-kind">${isPost ? '发帖' : '评论'}</span>
      <div class="forum-footprint-main">
        <p>${isPost
          ? `${escapeHTML(cutForumInlineText(item.content, 30) || '发布了一条动态')}`
          : `在《${escapeHTML(cutForumInlineText(item.postTitle, 18) || '帖子')}》下评论：${escapeHTML(cutForumInlineText(item.content, 30) || '...')}`}</p>
        <small>${isPost
          ? `${escapeHTML(item.circle)} · ${escapeHTML(formatForumProfileDate(item.createdAt))} · ${item.likes}赞 ${item.comments}评`
          : `${escapeHTML(formatForumProfileDate(item.createdAt))}`}</small>
      </div>
    </button>
  `;
}

function renderForumProfileFootprints(space, profileId) {
  const footprints = collectForumProfileFootprints(space, profileId);
  const groupKey = `${profileId}:footprint`;
  const isExpanded = expandedProfilePostGroups.has(groupKey);
  const visible = isExpanded ? footprints : footprints.slice(0, 30);
  return `
    <div class="profile-posts-list profile-posts-list--footprint">
      ${visible.length ? visible.map(renderForumProfileFootprintItem).join('') : '<div class="profile-empty profile-empty--panel">这里还没有留下论坛足迹</div>'}
      ${footprints.length > 30 ? `<button class="profile-posts-group-toggle" data-profile-post-group-toggle="${escapeHTML(groupKey)}" type="button">${isExpanded ? '收起' : `查看更多 ${footprints.length - 30} 条`}</button>` : ''}
    </div>
  `;
}

function renderFavoritePostThumb(post) {
  if (!post) return '<span></span>';
  const mediaItems = Array.isArray(post.media) ? post.media : [];
  const realImage = mediaItems.find(item => item.type === 'real-image' && item.url);
  if (realImage?.url) return `<img src="${escapeHTML(realImage.url)}" alt="${escapeHTML(post.circle || '收藏')}" loading="lazy">`;
  const fakeImage = mediaItems.find(item => item.type === 'fake-image');
  if (fakeImage) return `<span class="profile-grid-fake-thumb">${escapeHTML(fakeImage.text || post.content || '收藏')}</span>`;
  const sticker = mediaItems.find(item => item.type === 'sticker' && item.url);
  if (sticker?.url) return `<img src="${escapeHTML(sticker.url)}" alt="${escapeHTML(sticker.explanation || '收藏')}" loading="lazy">`;
  const slidesVideo = mediaItems.find(item => item.type === 'slides-video');
  if (slidesVideo) return `<span class="profile-grid-fake-thumb">${escapeHTML(slidesVideo.slides?.[0] || post.content || '短视频')}</span>`;
  if (getForumFavoritePostType(post) === 'text') {
    return `<span class="forum-favorite-folder-text-thumb">${formatForumPostText(post.content || post.circle || '文字')}</span>`;
  }
  return '<span></span>';
}

function renderFavoriteFolderCover(savedPosts) {
  const thumbs = savedPosts.slice(0, 4).map(renderFavoritePostThumb);
  while (thumbs.length < 4) thumbs.push('<span></span>');
  return thumbs.join('');
}

function renderFavoriteVisualItem(post) {
  const mediaItems = Array.isArray(post?.media) ? post.media : [];
  const realImage = mediaItems.find(item => item.type === 'real-image' && item.url);
  const fakeImage = mediaItems.find(item => item.type === 'fake-image');
  const sticker = mediaItems.find(item => item.type === 'sticker' && item.url);
  let content = '<span></span>';
  if (realImage?.url) content = `<img src="${escapeHTML(realImage.url)}" alt="${escapeHTML(post.circle || '收藏')}" loading="lazy">`;
  else if (fakeImage) content = `<span class="profile-grid-fake-thumb">${escapeHTML(fakeImage.text || post.content || '收藏')}</span>`;
  else if (sticker?.url) content = `<img src="${escapeHTML(sticker.url)}" alt="${escapeHTML(sticker.explanation || '收藏')}" loading="lazy">`;
  return `<button class="profile-grid-item profile-grid-item--media" data-post-id="${escapeHTML(post.id)}" type="button">${content}</button>`;
}

function renderFavoriteVideoItem(post) {
  const media = Array.isArray(post?.media) ? post.media.find(item => item.type === 'slides-video' || item.type === 'video') : null;
  const firstPage = Array.isArray(media?.slides) ? media.slides[0] : '';
  const content = media?.type === 'video' && media.url
    ? `<video src="${escapeHTML(media.url)}" muted playsinline preload="metadata"></video>`
    : `<span class="profile-grid-fake-thumb">${escapeHTML(firstPage || post.content || '短视频')}</span>`;
  return `<button class="profile-video-item profile-grid-item--media" data-post-id="${escapeHTML(post.id)}" type="button">${content}</button>`;
}

function renderFavoriteCollectionItem(post, folder) {
  if (!post || !folder) return '';
  const type = getForumFavoritePostType(post);
  if (type === 'text') {
    return `
      <div class="forum-favorite-post-item is-text" data-post-id="${escapeHTML(post.id)}" role="button" tabindex="0">
        <p>${formatForumPostText(post.content || '暂无正文')}</p>
        <small>${escapeHTML(post.circle || '公开动态')}</small>
        <button class="forum-favorite-post-remove" data-favorite-remove-post="${escapeHTML(post.id)}" data-favorite-remove-folder="${escapeHTML(folder.id)}" type="button" aria-label="移出收藏夹">×</button>
      </div>
    `;
  }
  return `
    <div class="forum-favorite-post-item">
      ${type === 'video' ? renderFavoriteVideoItem(post) : renderFavoriteVisualItem(post)}
      <button class="forum-favorite-post-remove" data-favorite-remove-post="${escapeHTML(post.id)}" data-favorite-remove-folder="${escapeHTML(folder.id)}" type="button" aria-label="移出收藏夹">×</button>
    </div>
  `;
}

function renderFavoritePostGroup(title, posts, folder, className = '', groupType = 'text') {
  if (!posts.length) return '';
  const groupKey = `${folder.id}:${groupType}`;
  const limit = groupType === 'text' ? 6 : 12;
  const isExpanded = expandedFavoriteGroups.has(groupKey);
  const visiblePosts = isExpanded ? posts : posts.slice(0, limit);
  return `
    <section class="forum-favorite-post-group ${className}" data-favorite-group="${escapeHTML(groupKey)}">
      <div class="minimal-group-title"><span>${title}</span><small>${posts.length}</small></div>
      <div class="${className === 'is-text' ? 'forum-favorite-text-list' : 'profile-grid-view profile-grid-view--media forum-favorite-post-grid'}">
        ${visiblePosts.map(post => renderFavoriteCollectionItem(post, folder)).join('')}
      </div>
      ${posts.length > limit ? `<button class="forum-favorite-group-toggle" data-favorite-group-toggle="${escapeHTML(groupKey)}" type="button">${isExpanded ? '收起' : `展开全部 ${posts.length} 条`}</button>` : ''}
    </section>
  `;
}

function renderForumFavoriteCollections(space) {
  const userKey = getCurrentForumUserKey(space);
  const collections = ensureForumFavoriteCollections(space, userKey);
  const activeFolder = collections.find(folder => folder.id === activeFavoriteCollectionId);
  const posts = Array.isArray(space?.posts) ? space.posts : [];
  if (activeFolder) {
    const savedPosts = activeFolder.postIds.map(id => posts.find(post => String(post.id) === String(id))).filter(Boolean);
    const textPosts = savedPosts.filter(post => getForumFavoritePostType(post) === 'text');
    const visualPosts = savedPosts.filter(post => getForumFavoritePostType(post) === 'visual');
    const videoPosts = savedPosts.filter(post => getForumFavoritePostType(post) === 'video');
    const groupedPostsHtml = [
      renderFavoritePostGroup('纯文字', textPosts, activeFolder, 'is-text', 'text'),
      renderFavoritePostGroup('图文', visualPosts, activeFolder, '', 'visual'),
      renderFavoritePostGroup('短视频', videoPosts, activeFolder, '', 'video')
    ].join('');
    return `
      <div class="forum-favorite-page">
        <div class="forum-favorite-toolbar">
          <button type="button" data-favorite-back>返回收藏夹</button>
          <strong>${escapeHTML(activeFolder.name)}</strong>
        </div>
        ${savedPosts.length ? groupedPostsHtml : renderForumProfileFavoritesEmpty()}
      </div>
    `;
  }
  return `
    <div class="forum-favorite-page">
      <div class="forum-favorite-toolbar">
        <strong>收藏夹</strong>
        <button type="button" data-favorite-add>新建</button>
      </div>
      <div class="forum-favorite-folder-grid">
        ${collections.map(folder => {
          const savedPosts = folder.postIds.map(id => posts.find(post => String(post.id) === String(id))).filter(Boolean);
          const savedCount = Array.isArray(folder.postIds) ? folder.postIds.length : 0;
          return `
            <article class="forum-favorite-folder">
              <button class="forum-favorite-folder-cover" data-favorite-folder-id="${escapeHTML(folder.id)}" type="button">
                ${renderFavoriteFolderCover(savedPosts)}
              </button>
              <div class="forum-favorite-folder-meta">
                <button type="button" data-favorite-folder-id="${escapeHTML(folder.id)}">
                  <b>${escapeHTML(folder.name)}</b>
                  <small>${savedCount} 个帖子</small>
                </button>
                <div>
                  <button type="button" data-favorite-edit="${escapeHTML(folder.id)}">编辑</button>
                  ${folder.id === 'default' ? '' : `<button type="button" data-favorite-delete="${escapeHTML(folder.id)}">删除</button>`}
                </div>
              </div>
            </article>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderProfilePostGroup({ profileId, groupType, title, badge, posts, listClass, renderItem, limit = 12 }) {
  if (!posts.length) return '';
  const groupKey = `${profileId}:${groupType}`;
  const isExpanded = expandedProfilePostGroups.has(groupKey);
  const visiblePosts = isExpanded ? posts : posts.slice(0, limit);
  return `
    <div class="profile-posts-group" data-profile-post-group="${escapeHTML(groupKey)}">
      <div class="minimal-group-title"><span>${title}</span><small>${badge}</small></div>
      <div class="${listClass}">${visiblePosts.map(renderItem).join('')}</div>
      ${posts.length > limit ? `<button class="profile-posts-group-toggle" data-profile-post-group-toggle="${escapeHTML(groupKey)}" type="button">${isExpanded ? '收起' : `展开全部 ${posts.length} 条`}</button>` : ''}
    </div>
  `;
}

function renderForumProfilePostsList(space, profileId) {
  const posts = getForumProfilePosts(space, profileId);
  const visualPosts = posts.filter(post => getForumProfilePostType(post) === 'visual');
  const textPosts = posts.filter(post => getForumProfilePostType(post) === 'text');
  const videoPosts = posts.filter(post => getForumProfilePostType(post) === 'video');
  const currentUser = getCurrentForumUser(space);

  if (activeProfileTab === 'video') {
    return `
     <div class="profile-posts-list profile-posts-list--video">
        ${videoPosts.length ? renderProfilePostGroup({
          profileId,
          groupType: 'video',
          title: '短视频',
          badge: 'SHORTS',
          posts: videoPosts,
          listClass: 'profile-video-grid',
          renderItem: renderForumProfileVideoItem,
          limit: 12
        }) : '<div class="profile-empty profile-empty--panel">这里还没有发布任何短视频</div>'}
      </div>
    `;
  }

  if (activeProfileTab === 'favorites') {
    if (profileId === currentUser?.id) return renderForumFavoriteCollections(space);
    return renderForumProfileFootprints(space, profileId);
  }

  if (activeProfileTab === 'footprint') {
    return renderForumProfileFootprints(space, profileId);
  }
  return `
    <div class="profile-posts-list profile-posts-list--visual">
      ${renderProfilePostGroup({
        profileId,
        groupType: 'visual',
        title: '图文作品',
        badge: 'GALLERY',
        posts: visualPosts,
        listClass: 'profile-grid-view profile-grid-view--media',
        renderItem: renderForumProfileVisualItem,
        limit: 12
      })}
      ${renderProfilePostGroup({
        profileId,
        groupType: 'text',
        title: '文字作品',
        badge: 'POSTS',
        posts: textPosts,
        listClass: 'profile-text-list',
        renderItem: renderForumProfileTextItem,
        limit: 6
      })}
      ${!visualPosts.length && !textPosts.length ? '<div class="profile-empty profile-empty--panel">这里还没有发布任何内容</div>' : ''}
    </div>
  `;
}

function bindForumProfileTabs(root, rerender) {
  root.querySelectorAll('[data-profile-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      activeProfileTab = btn.dataset.profileTab || 'visual';
      if (activeProfileTab !== 'favorites') activeFavoriteCollectionId = null;
      rerender();
    });
  });
}

function bindForumProfilePostGroups(root, rerender) {
  if (!root) return;
  root.querySelectorAll('[data-profile-post-group-toggle]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      const groupKey = btn.dataset.profilePostGroupToggle || '';
      if (!groupKey) return;
      if (expandedProfilePostGroups.has(groupKey)) expandedProfilePostGroups.delete(groupKey);
      else expandedProfilePostGroups.add(groupKey);
      rerender();
    });
  });
}

function bindForumFavoriteCollections(root, space, rerender) {
  if (!root || !space) return;
  root.querySelector('[data-favorite-add]')?.addEventListener('click', () => openForumFavoriteCollectionEditor(space, null, rerender));
  root.querySelector('[data-favorite-back]')?.addEventListener('click', () => {
    activeFavoriteCollectionId = null;
    rerender();
  });
  root.querySelectorAll('[data-favorite-folder-id]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      activeFavoriteCollectionId = btn.dataset.favoriteFolderId;
      rerender();
    });
  });
  root.querySelectorAll('[data-favorite-edit]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      const folder = ensureForumFavoriteCollections(space).find(item => item.id === btn.dataset.favoriteEdit);
      if (folder) openForumFavoriteCollectionEditor(space, folder, rerender);
    });
  });
  root.querySelectorAll('[data-favorite-delete]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      const folder = ensureForumFavoriteCollections(space).find(item => item.id === btn.dataset.favoriteDelete);
      if (folder) openForumFavoriteDeleteConfirm(space, folder, rerender);
    });
  });
  root.querySelectorAll('[data-favorite-remove-post]').forEach(btn => {
    btn.addEventListener('click', async event => {
      event.stopPropagation();
      const folder = ensureForumFavoriteCollections(space).find(item => item.id === btn.dataset.favoriteRemoveFolder);
      if (!folder) return;
      const postId = String(btn.dataset.favoriteRemovePost || '');
      folder.postIds = folder.postIds.filter(id => String(id) !== postId);
      await saveState();
      rerender();
      showDynamicIsland('已移出收藏夹');
    });
  });
  root.querySelectorAll('[data-favorite-group-toggle]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      const groupKey = btn.dataset.favoriteGroupToggle || '';
      if (!groupKey) return;
      if (expandedFavoriteGroups.has(groupKey)) expandedFavoriteGroups.delete(groupKey);
      else expandedFavoriteGroups.add(groupKey);
      rerender();
    });
  });
}

function openForumFavoriteCollectionEditor(space, folder, rerender) {
  openSheet(folder ? '编辑收藏夹' : '新建收藏夹', `
    <div class="forum-compose-form">
      <input id="forum-favorite-folder-name" type="text" value="${escapeHTML(folder?.name || '')}" placeholder="收藏夹名称">
      <button class="forum-primary-btn" id="forum-favorite-folder-save" type="button">保存</button>
    </div>
  `, root => {
    const input = root.querySelector('#forum-favorite-folder-name');
    input?.focus();
    root.querySelector('#forum-favorite-folder-save')?.addEventListener('click', async () => {
      const name = input?.value.trim();
      if (!name) return showDynamicIsland('请填写收藏夹名称');
      const collections = ensureForumFavoriteCollections(space);
      if (folder) {
        folder.name = name;
      } else {
        collections.push({ id: `fav_${Date.now()}`, name, postIds: [] });
      }
      await saveState();
      closeModal();
      rerender();
    });
  });
}

function openForumFavoriteDeleteConfirm(space, folder, rerender) {
  if (folder.id === 'default') return showDynamicIsland('默认收藏夹不能删除');
  openSheet('删除收藏夹', `
    <div class="forum-compose-form">
      <p class="forum-quoted">确定删除「${escapeHTML(folder.name)}」吗？里面的收藏记录也会移除。</p>
      <button class="forum-primary-btn danger" id="forum-favorite-delete-confirm" type="button">删除</button>
    </div>
  `, root => {
    root.querySelector('#forum-favorite-delete-confirm')?.addEventListener('click', async () => {
      const userKey = getCurrentForumUserKey(space);
      space.favoriteCollectionsByUser[userKey] = ensureForumFavoriteCollections(space, userKey).filter(item => item.id !== folder.id);
      if (activeFavoriteCollectionId === folder.id) activeFavoriteCollectionId = null;
      await saveState();
      closeModal();
      rerender();
    });
  });
}

function openForumSavePicker(post) {
  const space = getCurrentSpace();
  if (!space || !post) return;
  const userKey = getCurrentForumUserKey(space);
  const collections = ensureForumFavoriteCollections(space, userKey);
  const savedFolder = getForumSavedCollection(post, space, userKey);
  openSheet('保存到收藏夹', `
    <div class="forum-save-picker">
      ${collections.map(folder => {
        const active = savedFolder?.id === folder.id;
        return `
          <button class="${active ? 'active' : ''}" data-save-folder-id="${escapeHTML(folder.id)}" type="button">
            <span>${escapeHTML(folder.name)}</span>
            <small>${folder.postIds.length} 个帖子</small>
            <b>${active ? '已保存' : '保存'}</b>
          </button>
        `;
      }).join('')}
      <button class="forum-save-picker-add" data-save-folder-add type="button">新建收藏夹</button>
    </div>
  `, root => {
    root.querySelectorAll('[data-save-folder-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const wasSavedHere = await saveForumPostToFavoriteCollection(post, btn.dataset.saveFolderId);
        await saveState();
        closeModal();
        renderApp();
        if (currentDetailPost && String(currentDetailPost.id) === String(post.id)) {
          renderPostDetailContent({ preserveScroll: true });
        }
        showDynamicIsland(wasSavedHere ? '已取消收藏' : '已保存到收藏夹');
      });
    });
    root.querySelector('[data-save-folder-add]')?.addEventListener('click', () => {
      openForumFavoriteCollectionEditor(space, null, () => openForumSavePicker(post));
    });
  });
}

async function saveForumPostToFavoriteCollection(post, folderId) {
  const space = getCurrentSpace();
  if (!space || !post) return false;
  const userKey = getCurrentForumUserKey(space);
  const collections = ensureForumFavoriteCollections(space, userKey);
  const postId = String(post.id);
  const targetFolderId = String(folderId || '');
  const savedFolder = getForumSavedCollection(post, space, userKey);
  const wasSavedHere = savedFolder?.id === targetFolderId;
  collections.forEach(folder => {
    folder.postIds = folder.postIds.filter(id => String(id) !== postId);
  });
  if (!wasSavedHere) {
    const folder = collections.find(item => item.id === targetFolderId) || collections[0];
    folder.postIds.unshift(postId);
  }
  space.favoriteCollectionsByUser[userKey] = collections;
  return wasSavedHere;
}

function openForumProfilePost(postId, options = {}) {
  const space = getCurrentSpace();
  const post = space?.posts?.find(item => item.id === postId);
  if (!post) return;
  openPostDetailPage(post, {
    returnView: options.returnProfileId ? 'profile' : 'feed',
    returnProfileId: options.returnProfileId || null
  });
}

function openForumPostAuthorProfile(profileId) {
  const space = getCurrentSpace();
  if (!space || !profileId) return;
  const id = String(profileId);
  const characterAlias = findForumCharacterAlias(space, id);
  if (characterAlias) {
    openProfile(id);
    return;
  }
  const member = (space.members || []).find(item => item.id === id);
  if (member && member.type === 'character') {
    openProfile(id, { forceMain: true });
    return;
  }
  openProfile(id);
}

function openForumDmTargetProfile(profileId) {
  const space = getCurrentSpace();
  if (!space || !profileId) return;
  const member = (space.members || []).find(item => String(item.id) === String(profileId));
  openProfile(profileId, member?.type === 'character' ? { forceMain: true } : {});
}

function renderComposeMediaPreview() {
  const grid = els.composeMediaGrid || document.getElementById('forum-compose-media-grid');
  if (!grid) return;
  grid.querySelectorAll('.forum-compose-media-preview').forEach(item => item.remove());
  const addBtn = document.getElementById('forum-compose-real-image-btn') || grid.querySelector('.add-media-btn');
  composeMediaItems.forEach(item => {
    const preview = document.createElement('div');
    preview.className = `forum-compose-media-preview ${item.type}`;
    preview.dataset.mediaId = item.id;
    preview.innerHTML = getComposeMediaPreviewHtml(item);
    preview.querySelector('[data-remove-compose-media]')?.addEventListener('click', () => {
      composeMediaItems = composeMediaItems.filter(media => media.id !== item.id);
      renderComposeMediaPreview();
      updateComposeOptionLabels();
    });
    grid.insertBefore(preview, addBtn || null);
  });
}

function getComposeMediaPreviewHtml(item) {
  const removeBtn = '<button type="button" data-remove-compose-media>×</button>';
  if (item.type === 'real-image') {
    return `<img src="${escapeHTML(item.url)}" alt="图片预览">${removeBtn}`;
  }
  if (item.type === 'sticker') {
    return `<img src="${escapeHTML(item.url)}" alt="${escapeHTML(item.explanation || '表情')}" loading="lazy">${removeBtn}`;
  }
  if (item.type === 'fake-image') {
    return `<div class="forum-fake-image-thumb">${escapeHTML(item.text)}</div>${removeBtn}`;
  }
  if (item.type === 'slides-video') {
    const totalSeconds = getForumShortVideoTotalSeconds(item);
    return `<div class="forum-slides-thumb"><b>短视频</b><span>${escapeHTML(item.slides?.[0] || '')}</span><small>${item.slides?.length || 0} 页 / ${totalSeconds || 0} 秒</small></div>${removeBtn}`;
  }
  if (item.type === 'music') {
    return `<div class="forum-music-thumb"><img src="${escapeHTML(item.song?.cover || DEFAULT_AVATAR_SRC)}" alt=""><span>${escapeHTML(item.song?.title || '音乐')}</span></div>${removeBtn}`;
  }
  return `<div class="forum-fake-image-thumb">${escapeHTML(item.label || '媒体')}</div>${removeBtn}`;
}

function getForumSlideDurations(media) {
  const slides = Array.isArray(media?.slides) && media.slides.length ? media.slides : [''];
  const rawDurations = Array.isArray(media?.durations)
    ? media.durations
    : Array.isArray(media?.slideDurations) ? media.slideDurations : [];
  const fallbackSeconds = Math.max(1, Math.min(60, Math.round((Number(media?.interval) || 1000) / 1000) || 1));
  return slides.map((_, index) => Math.max(1, Math.min(60, Math.round(Number(rawDurations[index]) || fallbackSeconds))));
}

function getForumShortVideoTotalSeconds(media) {
  return getForumSlideDurations(media).reduce((total, seconds) => total + seconds, 0);
}

function getForumShortVideoTimeRanges(media) {
  const durations = getForumSlideDurations(media);
  let cursor = 1;
  return durations.map(seconds => {
    const start = cursor;
    const end = cursor + seconds - 1;
    cursor = end + 1;
    return { start, end, seconds };
  });
}

function formatForumSlideTimeRange(range) {
  if (!range) return '';
  return range.start === range.end ? `第 ${range.start} 秒` : `第 ${range.start}-${range.end} 秒`;
}

function getForumSlideIndexAtSecond(media, second) {
  const durations = getForumSlideDurations(media);
  const targetSecond = Math.max(1, Number(second) || 1);
  let elapsed = 0;
  for (let i = 0; i < durations.length; i++) {
    elapsed += durations[i];
    if (targetSecond <= elapsed) return i;
  }
  return Math.max(0, durations.length - 1);
}

function getForumSlideStartUnit(media, slideIndex) {
  const durations = getForumSlideDurations(media);
  const safeIndex = Math.max(0, Math.min(durations.length - 1, Number(slideIndex) || 0));
  return durations.slice(0, safeIndex).reduce((total, seconds) => total + seconds, 0) * 100;
}

function updateComposeOptionLabels() {
  const fakeCount = composeMediaItems.filter(item => item.type === 'fake-image').length;
  const slideItem = composeMediaItems.find(item => item.type === 'slides-video');
  const musicItem = composeMediaItems.find(item => item.type === 'music');
  if (els.composeFakeImageText) els.composeFakeImageText.textContent = fakeCount ? `${fakeCount} 张` : '';
  if (els.composeSlidesText) els.composeSlidesText.textContent = slideItem ? `${slideItem.slides?.length || 0} 页` : '';
  if (els.composeMusicText) els.composeMusicText.textContent = musicItem ? musicItem.song?.title || '已选择' : '';
  if (els.composeMentionText) {
    const space = getCurrentSpace();
    const names = composeMentionIds.map(id => getForumDisplayName(space, id, findForumPersonName(space, id))).filter(Boolean);
    els.composeMentionText.textContent = names.length ? names.join('、') : '';
  }
}

function createForumUserComment(currentUser, item, withLikes = true) {
  const isSticker = item?.type === 'sticker';
  const replyTarget = item?.replyTarget || null;
  return {
    user: currentUser.name,
    avatar: currentUser.avatar,
    authorId: currentUser.id,
    text: isSticker ? String(item?.text || '[表情]').trim() : String(item?.text || '').trim(),
    ...(isSticker ? { sticker: { url: item.url, explanation: item.explanation || '' } } : {}),
    ...(replyTarget?.realCharId ? { replyToRealCharId: replyTarget.realCharId } : {}),
    ...(replyTarget?.user ? { replyToUser: replyTarget.user } : {}),
    ...(withLikes ? { likes: Array.from({ length: Math.floor(Math.random() * 10) + 1 }, (_, i) => `rand_like_${Date.now()}_${i}`) } : {}),
    replies: [],
    createdAt: Date.now()
  };
}

function updateDetailCommentAvatar() {
  const space = getCurrentSpace();
  const currentUser = getCurrentForumUser(space);
  const commentAvatar = document.getElementById('detail-comment-avatar');
  if (!commentAvatar) return;
  commentAvatar.src = currentUser.avatar || 'images/default-avatar.svg';
  commentAvatar.title = `切换评论账号：当前 ${currentUser.name || '我'}`;
}

function openDetailCommentAccountSwitcher() {
  const inputEl = document.getElementById('detail-comment-input');
  const hasDraftText = Boolean(String(inputEl?.value || '').trim());
  if (hasDraftText || pendingUserComments.length || currentDetailReplyTarget) {
    showDynamicIsland('先发送或取消当前评论，再切换账号');
    return;
  }
  openAliasSwitcher();
}

function updateDetailSendButtonState() {
  const sendBtn = document.getElementById('detail-comment-send');
  const inputEl = document.getElementById('detail-comment-input');
  if (!sendBtn || sendBtn.dataset.isGenerating === 'true') return;
  sendBtn.disabled = !((inputEl && inputEl.value.trim().length > 0) || selectedDetailSticker || pendingUserComments.length > 0);
}

function ensurePendingCommentsPreviewEl() {
  const bar = document.querySelector('.forum-detail-comment-bar');
  if (!bar) return null;
  let preview = bar.querySelector('.forum-pending-comments-preview');
  if (!preview) {
    preview = document.createElement('div');
    preview.className = 'forum-pending-comments-preview';
    preview.onpointerdown = e => e.preventDefault();
    bar.appendChild(preview);
  }
  return preview;
}

function renderPendingUserComments() {
  const preview = ensurePendingCommentsPreviewEl();
  if (!preview) return;
  if (!selectedDetailSticker) {
    preview.remove();
    updateDetailSendButtonState();
    return;
  }
  preview.innerHTML = `
    <div class="forum-pending-comment-chip is-sticker-draft">
      <img src="${escapeHTML(selectedDetailSticker.url)}" alt="${escapeHTML(selectedDetailSticker.explanation || '表情')}" loading="lazy">
      <span>${escapeHTML(selectedDetailSticker.explanation || '已选表情')}</span>
      <button type="button" data-remove-pending-sticker aria-label="移除">×</button>
    </div>
  `;
  preview.querySelectorAll('[data-remove-pending-sticker]').forEach(btn => {
    btn.onpointerdown = e => e.preventDefault();
    btn.onclick = () => {
      selectedDetailSticker = null;
      renderPendingUserComments();
    };
  });
  updateDetailSendButtonState();
}

function clearPendingUserComments() {
  pendingUserComments = [];
  selectedDetailSticker = null;
  document.querySelector('.forum-pending-comments-preview')?.remove();
  updateDetailSendButtonState();
}

function getActiveForumDirection(post) {
  const direction = post?.forumDirection || null;
  const text = String(direction?.text || '').trim();
  const turnsLeft = Math.max(0, Number(direction?.turnsLeft) || 0);
  return text && turnsLeft > 0 ? { text, turnsLeft } : null;
}

function updateForumDirectionButtonState() {
  const btn = document.getElementById('detail-comment-guide-btn');
  if (!btn) return;
  const activeDirection = getActiveForumDirection(currentDetailPost);
  btn.classList.toggle('is-active', Boolean(activeDirection));
  btn.title = activeDirection
    ? `剧情导向：${activeDirection.text}（剩余 ${activeDirection.turnsLeft} 轮）`
    : '剧情导向';
}

function consumeForumDirectionRound(post) {
  const activeDirection = getActiveForumDirection(post);
  if (!activeDirection) return null;
  const nextTurnsLeft = activeDirection.turnsLeft - 1;
  if (nextTurnsLeft > 0) {
    post.forumDirection = {
      ...post.forumDirection,
      text: activeDirection.text,
      turnsLeft: nextTurnsLeft,
      updatedAt: Date.now()
    };
  } else {
    delete post.forumDirection;
  }
  updateForumDirectionButtonState();
  return activeDirection;
}

function addPendingUserComment(item) {
  if (!item) return;
  if (item.type === 'text' && !String(item.text || '').trim()) return;
  if (item.type === 'sticker' && !item.url) return;
  pendingUserComments.push({
    id: `pending_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    ...item
  });
  renderPendingUserComments();
}

async function appendDetailUserComment(item) {
  if (!currentDetailPost) return false;
  const space = getCurrentSpace();
  const currentUser = getCurrentForumUser(space);
  const replyTarget = currentDetailReplyTarget ? { ...currentDetailReplyTarget } : null;
  const targetComment = replyTarget ? currentDetailPost.comments?.[replyTarget.commentIndex] : null;
  let pendingMeta = {};
  if (targetComment) {
    targetComment.replies = Array.isArray(targetComment.replies) ? targetComment.replies : [];
    const newComment = createForumUserComment(currentUser, { ...item, replyTarget }, false);
    targetComment.replies.push(newComment);
    pendingMeta = {
      floor: replyTarget.commentIndex + 1,
      replyToUser: replyTarget.user || targetComment.user || '',
      replyToText: replyTarget.text || targetComment.text || ''
    };
  } else {
    currentDetailPost.comments = Array.isArray(currentDetailPost.comments) ? currentDetailPost.comments : [];
    const newComment = createForumUserComment(currentUser, item, true);
    currentDetailPost.comments.push(newComment);
    pendingMeta = { floor: currentDetailPost.comments.length };
  }
  bumpForumPostDiscussionHeat(currentDetailPost, 1);
  addPendingUserComment({ ...item, replyTarget, ...pendingMeta });
  await saveState();
  maybeQueueForumThreadSummary(space, currentDetailPost);
  renderApp();
  renderPostDetailContent({ preserveScroll: true });
  setTimeout(() => {
    scrollDetailCommentsToLatest();
  }, 50);
  return true;
}

async function queueDetailInputComment() {
  const inputEl = document.getElementById('detail-comment-input');
  if (!inputEl) return false;
  const text = inputEl.value.trim();
  const sticker = selectedDetailSticker ? { ...selectedDetailSticker } : null;
  if (!text && !sticker) return pendingUserComments.length > 0;
  await appendDetailUserComment(sticker ? { type: 'sticker', text: text || '[表情]', ...sticker } : { type: 'text', text });
  selectedDetailSticker = null;
  inputEl.value = '';
  inputEl.focus();
  renderPendingUserComments();
  updateDetailSendButtonState();
  return true;
}

function showForumReplyGuideBubble() {
  const bar = document.querySelector('.forum-detail-comment-bar');
  const sendBtn = document.getElementById('detail-comment-send');
  if (!bar || !sendBtn || localStorage.getItem('forum_reply_guide_shown') === '1') return;
  const guide = document.createElement('div');
  guide.className = 'forum-reply-guide-bubble';
  guide.innerHTML = '<span>回车先上屏，点发送再让 AI 回复</span><button type="button" aria-label="关闭">×</button>';
  const closeGuide = () => {
    localStorage.setItem('forum_reply_guide_shown', '1');
    guide.classList.add('is-hiding');
    setTimeout(() => guide.remove(), 180);
  };
  guide.querySelector('button')?.addEventListener('click', closeGuide);
  bar.appendChild(guide);
  setTimeout(closeGuide, 5000);
}

function openForumDirectionSheet() {
  if (!currentDetailPost) {
    showDynamicIsland?.('请先打开帖子');
    return;
  }
  const direction = currentDetailPost.forumDirection || {};
  const directionText = String(direction.text || '');
  const turnsLeft = Math.max(1, Number(direction.turnsLeft) || 3);
  openSheet('剧情导向', `
    <div class="forum-direction-sheet">
      <label class="forum-mini-field">
        <span>导向内容</span>
        <textarea id="forum-direction-text" rows="5" placeholder="例如：让评论区逐渐怀疑帖子作者在隐瞒什么">${escapeHTML(directionText)}</textarea>
      </label>
      <label class="forum-mini-field">
        <span>有效轮数（点击发送按钮算 1 轮）</span>
        <input id="forum-direction-turns" type="number" min="1" max="20" step="1" value="${turnsLeft}">
      </label>
      <div class="forum-direction-actions">
        <button type="button" id="forum-direction-clear">清除导向</button>
        <button type="button" id="forum-direction-save">保存导向</button>
      </div>
    </div>
  `, root => {
    const textEl = root.querySelector('#forum-direction-text');
    const turnsEl = root.querySelector('#forum-direction-turns');
    root.querySelector('#forum-direction-save')?.addEventListener('click', async () => {
      const text = String(textEl?.value || '').trim();
      const turns = Math.max(1, Math.min(Number(turnsEl?.value) || 1, 20));
      if (!text) {
        showDynamicIsland?.('先写导向内容');
        return;
      }
      currentDetailPost.forumDirection = {
        text,
        turnsLeft: turns,
        createdAt: Date.now()
      };
      await saveState();
      updateForumDirectionButtonState();
      closeModal();
      showDynamicIsland?.(`剧情导向已保存，${turns} 轮内生效`);
    });
    root.querySelector('#forum-direction-clear')?.addEventListener('click', async () => {
      delete currentDetailPost.forumDirection;
      await saveState();
      updateForumDirectionButtonState();
      closeModal();
      showDynamicIsland?.('已清除剧情导向');
    });
  });
}

function formatPendingUserCommentForAI(item) {
  const body = item.type === 'sticker'
    ? `${String(item.text || '').replace(/^\[表情\]$/, '').trim()} [表情含义：${item.explanation || '表情'}]`.trim()
    : String(item.text || '').trim();
  if (item.replyTarget) {
    const targetText = String(item.replyToText || '').slice(0, 60);
    return `- 回复 Floor ${item.floor} 的 ${item.replyToUser || '某人'}${targetText ? `（原话：${targetText}）` : ''}：${body}`;
  }
  return `- 新楼 Floor ${item.floor || '?'}：${body}`;
}

function getSinglePendingReplyTarget(items) {
  const list = Array.isArray(items) ? items : [];
  const replyItems = list.filter(item => item?.replyTarget && Number.isInteger(item.replyTarget.commentIndex));
  if (!replyItems.length || replyItems.length !== list.length) return null;
  const firstTarget = replyItems[0].replyTarget;
  const firstReplyIndex = Number.isInteger(firstTarget.replyIndex) ? firstTarget.replyIndex : null;
  const isSameTarget = replyItems.every(item => {
    const target = item.replyTarget;
    const replyIndex = Number.isInteger(target.replyIndex) ? target.replyIndex : null;
    return target.commentIndex === firstTarget.commentIndex && replyIndex === firstReplyIndex;
  });
  return isSameTarget ? firstTarget : null;
}

async function flushPendingUserComments() {
  const inputEl = document.getElementById('detail-comment-input');
  await queueDetailInputComment();
  if (!pendingUserComments.length || !currentDetailPost) return false;
  const replyTarget = getSinglePendingReplyTarget(pendingUserComments);
  const hasMixedReplyTargets = !replyTarget && pendingUserComments.some(item => item?.replyTarget);
  const userBatchText = pendingUserComments.map(formatPendingUserCommentForAI).filter(Boolean).join('\n');
  const forumDirection = consumeForumDirectionRound(currentDetailPost);
  clearPendingUserComments();
  if (inputEl) inputEl.value = '';
  updateDetailSendButtonState();
  resetDetailReplyTarget();
  await saveState();
  generateForumComments(getCurrentSpace(), currentDetailPost, 'reply', { ...(replyTarget || {}), userBatchText, forumDirection, hasMixedReplyTargets });
  return true;
}

async function handleForumStickerSelected(event) {
  const { context, sticker } = event.detail || {};
  if (!sticker?.url) return;
  if (context === 'forum-compose') {
    composeMediaItems.push({
      id: sticker.id || `sticker_${Date.now()}`,
      type: 'sticker',
      url: sticker.url,
      explanation: sticker.explanation || ''
    });
    renderComposeMediaPreview();
    updateComposeOptionLabels();
    return;
  }
  if (context !== 'forum-detail-comment' || !currentDetailPost) return;
  selectedDetailSticker = {
    url: sticker.url,
    explanation: sticker.explanation || ''
  };
  renderPendingUserComments();
}

document.addEventListener('forum:sticker-selected', handleForumStickerSelected);

async function handleForumComposeImageUpload(e) {
  const files = Array.from(e.target.files || []).filter(file => file.type.startsWith('image/'));
  if (!files.length) return;
  for (const file of files) {
    const url = await compressForumImage(file, 720, 0.76);
    composeMediaItems.push({
      id: `media_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      type: 'real-image',
      url,
      alt: file.name || '上传图片'
    });
  }
  e.target.value = '';
  renderComposeMediaPreview();
  updateComposeOptionLabels();
}

function openForumFakeImageComposer() {
  openSheet('添加文字图片', `
    <div class="forum-compose-form">
      <textarea id="forum-fake-image-input" placeholder="写这张假图片里的内容，例如：一张聊天截图，标题是……"></textarea>
      <button class="forum-primary-btn" id="forum-fake-image-save" type="button">添加</button>
    </div>
  `, root => {
    root.querySelector('#forum-fake-image-save').addEventListener('click', () => {
      const text = root.querySelector('#forum-fake-image-input').value.trim();
      if (!text) return showDynamicIsland('请先写图片内容');
      composeMediaItems.push({
        id: `fake_${Date.now()}`,
        type: 'fake-image',
        text
      });
      closeModal();
      renderComposeMediaPreview();
      updateComposeOptionLabels();
    });
  });
}

function openForumSlidesComposer() {
  const current = composeMediaItems.find(item => item.type === 'slides-video');
  const currentDuration = getForumSlideDurations(current)[0] || 1;
  openSheet('添加文字短视频', `
    <div class="forum-compose-form">
      <textarea id="forum-slides-input" placeholder="一行一页，例如：&#10;第一页：镜头推近公告牌&#10;第二页：评论区开始爆炸&#10;第三页：有人放出新截图">${escapeHTML((current?.slides || []).join('\n'))}</textarea>
      <label class="forum-mini-field">
        <span>每页秒数</span>
        <input id="forum-slides-duration" type="number" min="1" max="60" step="1" inputmode="numeric" value="${currentDuration}">
      </label>
      <button class="forum-primary-btn" id="forum-slides-save" type="button">保存短视频</button>
    </div>
  `, root => {
    root.querySelector('#forum-slides-save').addEventListener('click', () => {
      const slides = root.querySelector('#forum-slides-input').value.split('\n').map(line => line.trim()).filter(Boolean);
      if (!slides.length) return showDynamicIsland('至少写一页内容');
      const duration = Math.max(1, Math.min(60, Math.round(Number(root.querySelector('#forum-slides-duration')?.value) || 1)));
      composeMediaItems = composeMediaItems.filter(item => item.type !== 'slides-video');
      composeMediaItems.push({
        id: `slides_${Date.now()}`,
        type: 'slides-video',
        slides,
        durations: slides.map(() => duration),
        interval: duration * 1000
      });
      closeModal();
      renderComposeMediaPreview();
      updateComposeOptionLabels();
    });
  });
}

function openForumShortVideoComposer() {
  const current = composeMediaItems.find(item => item.type === 'slides-video');
  const currentDurations = getForumSlideDurations(current);
  const initialSlides = (current?.slides?.length ? current.slides : ['']).map((slide, index) => `
    <div class="forum-slide-editor-page">
      <label><span data-slide-page-label>第 ${index + 1} 页</span><input data-slide-duration type="number" min="1" max="60" step="1" inputmode="numeric" value="${currentDurations[index] || 1}"> 秒</label>
      <textarea data-slide-page placeholder="写这一页短视频内容">${escapeHTML(slide)}</textarea>
      <button type="button" data-remove-slide-page>删除本页</button>
    </div>
  `).join('');
  openSheet('文字短视频分页', `
    <div class="forum-compose-form">
      <div class="forum-slide-editor-list" id="forum-slide-editor-list">${initialSlides}</div>
      <button class="forum-outline-btn" id="forum-add-slide-page" type="button">新增一页</button>
      <button class="forum-primary-btn" id="forum-slides-save" type="button">保存短视频</button>
    </div>
  `, root => {
    const list = root.querySelector('#forum-slide-editor-list');
    const refreshLabels = () => {
      list.querySelectorAll('[data-slide-page-label]').forEach((label, index) => {
        label.textContent = `第 ${index + 1} 页`;
      });
    };
    root.querySelector('#forum-add-slide-page').addEventListener('click', () => {
      const page = document.createElement('div');
      page.className = 'forum-slide-editor-page';
      page.innerHTML = `
        <label><span data-slide-page-label></span><input data-slide-duration type="number" min="1" max="60" step="1" inputmode="numeric" value="${currentDurations[currentDurations.length - 1] || 1}"> 秒</label>
        <textarea data-slide-page placeholder="写这一页短视频内容"></textarea>
        <button type="button" data-remove-slide-page>删除本页</button>
      `;
      list.appendChild(page);
      refreshLabels();
    });
    list.addEventListener('click', e => {
      const removeBtn = e.target.closest('[data-remove-slide-page]');
      if (!removeBtn || list.querySelectorAll('.forum-slide-editor-page').length <= 1) return;
      removeBtn.closest('.forum-slide-editor-page')?.remove();
      refreshLabels();
    });
    root.querySelector('#forum-slides-save').addEventListener('click', () => {
      const pages = Array.from(root.querySelectorAll('.forum-slide-editor-page')).map(page => ({
        text: page.querySelector('[data-slide-page]')?.value.trim() || '',
        duration: Math.max(1, Math.min(60, Math.round(Number(page.querySelector('[data-slide-duration]')?.value) || 1)))
      })).filter(page => page.text);
      const slides = pages.map(page => page.text);
      if (!slides.length) return showDynamicIsland('至少写一页内容');
      composeMediaItems = composeMediaItems.filter(item => item.type !== 'slides-video');
      composeMediaItems.push({
        id: `slides_${Date.now()}`,
        type: 'slides-video',
        slides,
        durations: pages.map(page => page.duration),
        interval: (pages[0]?.duration || 1) * 1000
      });
      closeModal();
      renderComposeMediaPreview();
      updateComposeOptionLabels();
    });
  });
}

function openForumMusicPicker() {
  const playlist = (window.MusicPlayer && window.MusicPlayer.globalPlaylist) ? window.MusicPlayer.globalPlaylist : [];
  if (!playlist.length) {
    showDynamicIsland('曲库里还没有音乐');
    return;
  }
  openSheet('从曲库选择音乐', `
    <div class="forum-music-picker-list">
      ${playlist.map((song, index) => `
        <button class="forum-music-picker-row" data-song-index="${index}" type="button">
          <img src="${escapeHTML(song.cover || DEFAULT_AVATAR_SRC)}" alt="">
          <span>${escapeHTML(song.title || '未命名歌曲')}</span>
          <small>${escapeHTML(song.artist || '未知歌手')}</small>
        </button>
      `).join('')}
    </div>
  `, root => {
    root.querySelectorAll('[data-song-index]').forEach(btn => {
      btn.addEventListener('click', () => {
        const song = playlist[Number(btn.dataset.songIndex)];
        if (!song) return;
        composeMediaItems = composeMediaItems.filter(item => item.type !== 'music');
        composeMediaItems.push({
          id: `music_${Date.now()}`,
          type: 'music',
          song: JSON.parse(JSON.stringify(song))
        });
        closeModal();
        renderComposeMediaPreview();
        updateComposeOptionLabels();
      });
    });
  });
}

function openForumMentionPicker() {
  const space = getCurrentSpace();
  const people = getForumMentionPeople(space);
  if (!people.length) return showDynamicIsland('当前方案里还没有可提及角色');
  openSheet('提及角色', `
    <div class="forum-mention-picker-list">
      ${people.map(person => `
        <button class="forum-select-row ${composeMentionIds.includes(person.id) ? 'active' : ''}" data-mention-id="${escapeHTML(person.id)}" type="button">
          <img src="${escapeHTML(person.avatar || DEFAULT_AVATAR_SRC)}" alt="">
          <span>${escapeHTML(person.name)}</span>
          <small>@${escapeHTML(person.account || person.name)}${person.isCharacterAlias ? ' · 角色小号' : ''}</small>
        </button>
      `).join('')}
      <button class="forum-primary-btn" id="forum-mention-done" type="button" style="margin-top: 12px;">完成</button>
    </div>
  `, root => {
    root.addEventListener('click', e => {
      const row = e.target.closest('[data-mention-id]');
      if (row) {
        const id = row.dataset.mentionId;
        composeMentionIds = composeMentionIds.includes(id) ? composeMentionIds.filter(item => item !== id) : [...composeMentionIds, id];
        row.classList.toggle('active', composeMentionIds.includes(id));
        updateComposeOptionLabels();
        return;
      }
      if (e.target.closest('#forum-mention-done')) {
        closeModal();
        updateComposeOptionLabels();
      }
    });
  });
}

function migrateForumAccountScopes() {
  state.ordinaryNpcAvatarGroups = normalizeForumOrdinaryNpcAvatarGroups(state.ordinaryNpcAvatarGroups);
  state.ordinaryNpcAvatars = normalizeForumOrdinaryNpcAvatars(state.ordinaryNpcAvatars);
  (state.spaces || []).forEach(space => {
    if (!Array.isArray(space.mainFollowedMemberIds)) {
      space.mainFollowedMemberIds = (space.members || [])
        .filter(member => !isForumTemporaryOrdinaryMember(member))
        .filter(member => isForumProfileFollowed(space.forumProfiles?.[member.id], member))
        .map(member => member.id);
    }
    space.worldBook = typeof space.worldBook === 'string' ? space.worldBook : '';
    space.memberWorldBooks = space.memberWorldBooks && typeof space.memberWorldBooks === 'object' ? space.memberWorldBooks : {};
    space.worldBookEntryIds = normalizeForumWorldBookIds(space.worldBookEntryIds);
    space.memberWorldBookEntryIds = normalizeForumMemberWorldBookIds(space.memberWorldBookEntryIds);
    space.worldBookCallLogs = Array.isArray(space.worldBookCallLogs) ? space.worldBookCallLogs.slice(-FORUM_WORLD_BOOK_LOG_LIMIT) : [];
    space.lastAiHomePostIds = Array.isArray(space.lastAiHomePostIds) ? space.lastAiHomePostIds.map(String) : [];
    space.discoverTrends = normalizeForumDiscoverTrends(space.discoverTrends);
    space.lastAiDiscoverTrendIds = Array.isArray(space.lastAiDiscoverTrendIds) ? space.lastAiDiscoverTrendIds.map(String) : [];
    space.lastAiCircleDetailPostIds = space.lastAiCircleDetailPostIds && typeof space.lastAiCircleDetailPostIds === 'object'
      ? space.lastAiCircleDetailPostIds
      : {};
    space.lastAiCharacterProfilePostIds = space.lastAiCharacterProfilePostIds && typeof space.lastAiCharacterProfilePostIds === 'object'
      ? space.lastAiCharacterProfilePostIds
      : {};
    ensureForumCharacterAliases(space);
    space.settings = space.settings && typeof space.settings === 'object' ? space.settings : {};
    space.settings.mediaLayout = space.settings.mediaLayout === 'twitter' ? 'twitter' : 'instagram';
    space.settings.dmHintChancePercent = getForumDmHintChance(space);
    space.settings.forumReadLimit = Math.max(1, Number(space.settings.forumReadLimit) || 100);
    space.settings.forumSummaryThreshold = Math.max(1, Number(space.settings.forumSummaryThreshold) || 60);
    space.activeEvent = normalizeForumActiveEvent(space.activeEvent);
    space.activeEventHistory = normalizeForumEventHistory(space.activeEventHistory);
    space.userPostDigests = Array.isArray(space.userPostDigests) ? space.userPostDigests : [];
    space.stickerConfigs = space.stickerConfigs && typeof space.stickerConfigs === 'object' ? space.stickerConfigs : {};
    (space.posts || []).forEach(post => {
      post.visibility = normalizeForumPostVisibility(post.visibility);
      post.forumSummary = typeof post.forumSummary === 'string' ? post.forumSummary : '';
      post.lastSummaryFloor = Math.max(0, Number(post.lastSummaryFloor) || 0);
      post.forumSummaryError = typeof post.forumSummaryError === 'string' ? post.forumSummaryError : '';
      post.forumSummaryFailedAt = Math.max(0, Number(post.forumSummaryFailedAt) || 0);
      post.forumFailedSummaries = Array.isArray(post.forumFailedSummaries)
        ? post.forumFailedSummaries
          .filter(task => task && task.id && task.snapshot && Array.isArray(task.snapshot.floors))
          .slice(-1)
        : [];
      post.hiddenLink = post.hiddenLink && typeof post.hiddenLink === 'object'
        ? post.hiddenLink
        : { enabled: false, memberIds: [], exposureRate: 30 };
      post.hiddenLink.memberIds = Array.isArray(post.hiddenLink.memberIds) ? post.hiddenLink.memberIds : [];
      post.hiddenLink.exposureRate = Math.max(0, Math.min(100, Number(post.hiddenLink.exposureRate) || 30));
      post.blockedIds = Array.isArray(post.blockedIds) ? post.blockedIds : [];
      post.hiddenLinkState = post.hiddenLinkState && typeof post.hiddenLinkState === 'object' ? post.hiddenLinkState : {};
    });
    space.aliases = (space.aliases || []).map(alias => ({
      ...alias,
      bio: alias.bio || '',
      followedMemberIds: Array.isArray(alias.followedMemberIds) ? alias.followedMemberIds : [],
      knownToMemberIds: Array.isArray(alias.knownToMemberIds) ? alias.knownToMemberIds.map(String) : [],
      aiRevealedToMemberIds: Array.isArray(alias.aiRevealedToMemberIds) ? alias.aiRevealedToMemberIds.map(String) : [],
      circles: Array.isArray(alias.circles) ? alias.circles : []
    }));
  });
}

function createEmptyDraft() {
  return {
    identityId: null,
    members: [],
    forumProfiles: {},
    characterAliases: {},
    relations: [],
    worldBook: '',
    worldBookEntryIds: [],
    legacyWorldBookText: '',
    memberWorldBooks: {},
    memberWorldBookEntryIds: {},
    legacyMemberWorldBooks: {},
    worldBookCallLogs: [],
    customNpcs: []
  };
}
function updateCreatePageMode(mode = 'create') {
  const isEdit = mode === 'edit';
  forumCreateViewMode = 'paged';
  activeForumCreatePage = 'world';
  const header = document.querySelector('#page-forum-create .forum-create-header');
  const cover = document.querySelector('#page-forum-create .forum-create-cover');
  const toolbarLabel = document.querySelector('#page-forum-create .forum-create-mode-line > span');
  const saveBtn = els.createSpaceBtn;
  header?.querySelector('span') && (header.querySelector('span').textContent = isEdit ? 'EDIT WORLD' : 'NEW WORLD');
  header?.querySelector('h2') && (header.querySelector('h2').textContent = isEdit ? '重新修改方案' : '新建方案');
  cover?.querySelector('span') && (cover.querySelector('span').textContent = isEdit ? 'EDIT SPACE' : 'CREATE SPACE');
  cover?.querySelector('p') && (cover.querySelector('p').textContent = isEdit ? '修改后点击保存，会直接覆盖当前论坛方案。' : '把角色、身份、NPC 和高频圈子放进同一个社交世界。');
  if (toolbarLabel) toolbarLabel.textContent = isEdit ? 'EDIT SPACE' : 'CREATE SPACE';
  if (saveBtn) saveBtn.textContent = isEdit ? '保存并覆盖原方案' : '创建并返回登录';
  updateForumCreateView();
}

function cloneForumDraftFromSpace(space) {
  const editableMembers = (space.members || []).filter(member => !isForumTemporaryOrdinaryMember(member));
  return {
    identityId: space.identityId || null,
    members: editableMembers.map(member => ({ ...member })),
    forumProfiles: JSON.parse(JSON.stringify(space.forumProfiles || {})),
    characterAliases: JSON.parse(JSON.stringify(space.characterAliases || {})),
    relations: (space.relations || []).map(rel => ({ ...rel })),
    worldBook: space.worldBook || '',
    worldBookEntryIds: normalizeForumWorldBookIds(space.worldBookEntryIds),
    memberWorldBooks: { ...(space.memberWorldBooks || {}) },
    memberWorldBookEntryIds: normalizeForumMemberWorldBookIds(space.memberWorldBookEntryIds),
    legacyWorldBookText: space.worldBook || '',
    legacyMemberWorldBooks: { ...(space.memberWorldBooks || {}) },
    customNpcs: editableMembers.filter(member => member.type === 'customNpc').map(member => ({ ...member }))
  };
}

function fillCreateFormFromDraft(sourceDraft, space = null) {
  if (els.titleInput) els.titleInput.value = space?.name || '';
  if (els.worldInput) els.worldInput.value = space?.world || '';
  renderCircleEditor(space?.circles?.length ? space.circles : DEFAULT_CIRCLES);

  const identity = AppState.userIdentities.find(item => item.id === sourceDraft.identityId);
  const userProfile = identity ? sourceDraft.forumProfiles?.[`user_${identity.id}`] || {} : {};
  if (els.userNicknameInput) els.userNicknameInput.value = userProfile.nickname || '';
  if (els.userAccountInput) els.userAccountInput.value = userProfile.account || generateForumAccount(identity?.name || 'user');
  if (els.userFamousInput) els.userFamousInput.value = userProfile.isFamous ? 'yes' : 'no';
  if (els.userVerifiedInput) els.userVerifiedInput.checked = Boolean(userProfile.isVerified);
  if (els.userOccupationInput) els.userOccupationInput.value = userProfile.occupation || '';
  if (els.userFansInput) els.userFansInput.value = normalizeFansCount(userProfile.fans);
  if (els.userBioInput) els.userBioInput.value = userProfile.bio || '';
  renderDraft();
}

function openEditSpacePage(space) {
  if (!space) return;
  editingSpaceId = space.id;
  draft = cloneForumDraftFromSpace(space);
  updateCreatePageMode('edit');
  showPage('page-forum-create');
  fillCreateFormFromDraft(draft, space);
}

function openForumMemorySettings() {
  const space = getCurrentSpace();
  if (!space) return;
  const readLimit = Math.max(1, Number(space.settings?.forumReadLimit) || 100);
  const summaryThreshold = Math.max(1, Number(space.settings?.forumSummaryThreshold) || 60);
  const stats = getForumMemoryStats(space);
  // 只有正停留在帖子详情页时，才显示"当前帖子"总结；退出帖子后打开公共记忆弹窗不再串台
  const detailPageEl = document.getElementById('page-forum-post-detail');
  const isDetailVisible = detailPageEl && getComputedStyle(detailPageEl).display !== 'none';
  const current = isDetailVisible ? currentDetailPost : null;
  const currentFloors = current ? getForumFloorCount(current) : 0;
  const currentDone = current ? Math.max(0, Number(current.lastSummaryFloor) || 0) : 0;
  const currentUnsummarized = current ? Math.max(0, currentFloors - currentDone) : 0;
  const currentRemaining = current ? Math.max(0, summaryThreshold - currentUnsummarized) : 0;
  const currentSummary = current ? String(current.forumSummary || '').trim() : '';
  const currentFailureTask = current ? getForumFailedSummaryTasks(current).slice(-1)[0] : null;
  const currentSummaryError = currentFailureTask?.error || (current ? String(current.forumSummaryError || '').trim() : '');
  const currentSummaryBusy = current && (forumSummarizingPosts.has(current.id) || forumSummaryQueuedPosts.has(current.id));
  const currentSummaryStatus = currentSummaryBusy
    ? '总结中'
    : (currentUnsummarized >= summaryThreshold ? '待总结' : `还差 ${currentRemaining} 楼`);
  if (current) maybeQueueForumThreadSummary(space, current);
  const activeBlock = current ? `
      <section class="forum-memory-active">
        <div class="forum-memory-active-head">当前帖子</div>
        <div class="forum-memory-stat-row">
          <span>累计楼层</span><b>${currentFloors}</b>
          <span>已总结到</span><b>${currentDone}</b>
          <span>总结状态</span><b>${currentSummaryStatus}</b>
        </div>
        ${currentSummaryBusy ? '<div style="margin:8px 0; font-size:12px; color:#666;">正在生成本帖总结…</div>' : (currentSummaryError ? `
          <div style="margin:8px 0; padding:8px; border:1px solid #ffb8b8; border-radius:8px; background:#fff5f5; color:#b42318; font-size:12px; line-height:1.5;">
            上次总结失败：${escapeHTML(currentSummaryError)}
            <button data-retry-summary="${escapeHTML(current.id)}" data-retry-summary-task="${escapeHTML(currentFailureTask?.id || '')}" type="button" style="margin-left:8px; border:0; background:#b42318; color:#fff; border-radius:6px; padding:4px 8px; font-size:12px; cursor:pointer;">重新总结</button>
          </div>
        ` : '')}
        ${currentSummary ? `
          <textarea class="forum-memory-summary-text" data-edit-summary="${escapeHTML(current.id)}" style="width: 100%; min-height: 60px; max-height: 120px; resize: vertical; border: 1px solid #f0f0f0; border-radius: 8px; padding: 8px; font-size: 12px; font-family: inherit; box-sizing: border-box; outline: none; background: #fff;">${escapeHTML(currentSummary)}</textarea>
          <div style="display: flex; gap: 8px; margin-top: 8px;">
            <button class="forum-primary-btn" data-save-summary="${escapeHTML(current.id)}" type="button" style="flex: 1; min-height: 32px; font-size: 12px;">保存修改</button>
            <button class="forum-outline-btn forum-memory-clear-one" data-clear-summary="${escapeHTML(current.id)}" type="button" style="flex: 1; min-height: 32px; font-size: 12px; color: #ff3b30; border-color: #ff3b30;">清空总结</button>
          </div>
        ` : '<div class="forum-empty" style="margin: 0;">本帖还没有生成总结</div>'}
      </section>
  ` : '';
  const summaryListHtml = stats.summarizedPosts.length
    ? stats.summarizedPosts.map(p => `
      <details style="background:#f9f9f9; border:1px solid #f0f0f0; border-radius:12px; overflow:hidden;">
        <summary style="display:flex; align-items:center; gap:8px; padding:10px 12px; cursor:pointer; list-style:none; outline:none;">
          <span style="display:inline-block; background:#111; color:#fff; font-size:10px; font-weight:600; padding:2px 8px; border-radius:10px; flex-shrink:0;">${escapeHTML(p.circle || '公开动态')}</span>
          <span style="flex:1; min-width:0; font-size:13px; color:#333; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHTML(buildForumPostBrief(p) || '帖子')}</span>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#999" stroke-width="2" style="flex-shrink:0;"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </summary>
        <div style="padding:0 12px 12px;">
          <p style="margin:0 0 10px; font-size:12px; color:#666; line-height:1.6; white-space:pre-wrap;">${escapeHTML(p.forumSummary || '')}</p>
             <div style="display:flex; justify-content:flex-end;">
            <button data-clear-summary="${escapeHTML(p.id)}" type="button" style="border:none; color:#ff3b30; background:#fff0f0; padding:5px 14px; border-radius:20px; font-size:11px; font-weight:500; cursor:pointer; display:inline-flex; align-items:center; gap:4px;"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path></svg>清空总结</button>
          </div>
          </div>
      </details>
    `).join('')
    : '<div class="forum-empty">还没有任何帖子被总结</div>';
  const digestListHtml = stats.digests.length
    ? stats.digests.map(d => {
      // 查这条动态对应帖子的 AI 简介，有就展示在下方
      const dPost = (space.posts || []).find(p => p.id === d.postId);
      const dBrief = dPost && dPost.forumBriefSummary ? String(dPost.forumBriefSummary).trim() : '';
      return `
      <div class="forum-memory-digest-row" style="background:#f9f9f9; border:1px solid #f0f0f0; flex-wrap: wrap;">
        <span class="forum-memory-digest-main" style="color:#333;">${d.circle ? `[${escapeHTML(d.circle)}] ` : ''}${escapeHTML(d.brief || '（空）')}${d.mediaNote ? `，${escapeHTML(d.mediaNote)}` : ''}</span>
        <small style="color:#999;">${escapeHTML(formatForumDigestTime(d.time))}</small>
        <button data-remove-digest="${escapeHTML(d.postId)}" type="button" style="color:#ff3b30;">×</button>
        ${dBrief ? `<div style="width:100%; margin-top:6px; padding-top:6px; border-top:1px dashed #e5e5e5; font-size:11px; color:#888; line-height:1.5;">📌 简介：${escapeHTML(dBrief)}</div>` : ''}
      </div>`;
    }).join('')
    : '<div class="forum-empty" style="color:#999;">动态库还是空的</div>';
  const savedPostIds = getForumSavedPostIdSet(space);
  const savedPostCount = (space.posts || []).filter(post => savedPostIds.has(String(post.id))).length;
  openSheet('论坛记忆设置', `
    <div class="forum-memory-panel" style="background:#fff;">
      
      <!-- 顶部三个 Tab 切换按钮 -->
      <div style="display:flex; gap:10px; margin-bottom:15px; background:#f2f2f7; padding:4px; border-radius:12px;">
        <button type="button" onclick="document.getElementById('fm-tab-1').style.display='block';document.getElementById('fm-tab-2').style.display='none';document.getElementById('fm-tab-3').style.display='none';this.style.background='#fff';this.style.boxShadow='0 2px 6px rgba(0,0,0,0.05)';this.style.color='#111';this.nextElementSibling.style.background='transparent';this.nextElementSibling.style.boxShadow='none';this.nextElementSibling.style.color='#666';this.nextElementSibling.nextElementSibling.style.background='transparent';this.nextElementSibling.nextElementSibling.style.boxShadow='none';this.nextElementSibling.nextElementSibling.style.color='#666';" style="flex:1; border:none; border-radius:8px; padding:8px 0; font-size:13px; font-weight:600; cursor:pointer; transition:0.2s; background:#fff; color:#111; box-shadow:0 2px 6px rgba(0,0,0,0.05);">总结设置</button>
        <button type="button" onclick="document.getElementById('fm-tab-1').style.display='none';document.getElementById('fm-tab-2').style.display='block';document.getElementById('fm-tab-3').style.display='none';this.style.background='#fff';this.style.boxShadow='0 2px 6px rgba(0,0,0,0.05)';this.style.color='#111';this.previousElementSibling.style.background='transparent';this.previousElementSibling.style.boxShadow='none';this.previousElementSibling.style.color='#666';this.nextElementSibling.style.background='transparent';this.nextElementSibling.style.boxShadow='none';this.nextElementSibling.style.color='#666';" style="flex:1; border:none; border-radius:8px; padding:8px 0; font-size:13px; font-weight:600; cursor:pointer; transition:0.2s; background:transparent; color:#666; box-shadow:none;">总结库</button>
        <button type="button" onclick="document.getElementById('fm-tab-1').style.display='none';document.getElementById('fm-tab-2').style.display='none';document.getElementById('fm-tab-3').style.display='block';this.style.background='#fff';this.style.boxShadow='0 2px 6px rgba(0,0,0,0.05)';this.style.color='#111';this.previousElementSibling.style.background='transparent';this.previousElementSibling.style.boxShadow='none';this.previousElementSibling.style.color='#666';this.previousElementSibling.previousElementSibling.style.background='transparent';this.previousElementSibling.previousElementSibling.style.boxShadow='none';this.previousElementSibling.previousElementSibling.style.color='#666';" style="flex:1; border:none; border-radius:8px; padding:8px 0; font-size:13px; font-weight:600; cursor:pointer; transition:0.2s; background:transparent; color:#666; box-shadow:none;">动态库</button>
      </div>

      <!-- Tab 1: 设置页面 -->
      <div id="fm-tab-1" style="display:block;">
        <div class="forum-memory-stats" style="margin-bottom:15px;">
          <div class="forum-memory-stat" style="background:#f9f9f9; border:1px solid #f0f0f0;"><b style="color:#111;">${stats.digestCount}/${stats.digestLimit}</b><span style="color:#666;">动态库</span></div>
          <div class="forum-memory-stat" style="background:#f9f9f9; border:1px solid #f0f0f0;"><b style="color:#111;">${stats.summarizedCount}</b><span style="color:#666;">已总结帖子</span></div>
          <div class="forum-memory-stat" style="background:#f9f9f9; border:1px solid #f0f0f0;"><b style="color:#111;">${stats.totalPosts}</b><span style="color:#666;">总帖子</span></div>
        </div>
        ${activeBlock ? `<div style="background:#f9f9f9; border:1px solid #f0f0f0; border-radius:16px; padding:12px; margin-bottom:15px;">${activeBlock}</div>` : ''}
        <div class="forum-memory-fields">
          <label class="forum-mini-field">
            <span style="color:#666;">读取条数</span>
            <input id="forum-memory-read-limit" type="number" min="1" step="1" inputmode="numeric" value="${readLimit}" style="background:#f9f9f9; border:1px solid #f0f0f0;">
          </label>
          <label class="forum-mini-field">
            <span style="color:#666;">总结阈值</span>
            <input id="forum-memory-summary-threshold" type="number" min="1" step="1" inputmode="numeric" value="${summaryThreshold}" style="background:#f9f9f9; border:1px solid #f0f0f0;">
          </label>
          <button class="forum-primary-btn" id="forum-memory-settings-save" type="button" style="margin-top:10px;">保存设置</button>
          <details style="margin-top:15px; padding:12px; border:1px solid #e8e8e8; border-radius:12px; background:#f9f9f9;">
            <summary style="cursor:pointer; list-style:none; font-size:13px; font-weight:700; color:#222; display:flex; align-items:center; justify-content:space-between;">
              <span>帖子清理</span>
              <small style="font-size:11px; color:#999; font-weight:500;">点击展开</small>
            </summary>
            <div style="margin-top:12px; padding:12px; border:1px solid #ededed; border-radius:10px; background:#fff;">
            <label class="forum-mini-field" style="margin-bottom:10px;">
              <span style="color:#666;">删除最早帖子数</span>
              <input id="forum-clear-posts-count" type="number" min="1" step="1" inputmode="numeric" placeholder="例如 50" style="background:#f9f9f9; border:1px solid #f0f0f0;">
            </label>
            <label style="display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:36px; padding:8px 10px; border:1px solid #f0f0f0; border-radius:10px; background:#fff; font-size:12px; color:#555; margin-bottom:10px;">
              <span>保留已收藏帖子 <small style="color:#999;">当前 ${savedPostCount} 个</small></span>
              <input id="forum-clear-posts-keep-saved" type="checkbox" checked style="width:18px; height:18px; flex-shrink:0;">
            </label>
            <button class="forum-outline-btn" id="forum-clear-posts-batch" type="button" style="width:100%; border:1px solid #222; color:#222; background:#fff;">删除最早的帖子</button>
            </div>
          </details>
        </div>
      </div>

      <!-- Tab 2: 总结库 -->
      <div id="fm-tab-2" style="display:none; max-height: 50vh; overflow-y: auto;">
        <div style="font-size:12px; color:#666; margin-bottom:10px; font-weight:bold;">已总结帖子（${stats.summarizedCount}）</div>
        <div style="display:flex; flex-direction:column; gap:10px;">${summaryListHtml.replace(/background: #fbfaf8;/g, 'background: #f9f9f9;').replace(/border: 1px solid #eee8df;/g, 'border: 1px solid #f0f0f0;')}</div>
      </div>

      <!-- Tab 3: 动态库 -->
      <div id="fm-tab-3" style="display:none; max-height: 50vh; overflow-y: auto;">
        <div style="font-size:12px; color:#666; margin-bottom:10px; font-weight:bold;">我的发帖动态（${stats.digestCount}/${stats.digestLimit}）</div>
        <div style="display:flex; flex-direction:column; gap:10px;">
          ${digestListHtml}
          ${stats.digests.length ? '<button class="forum-outline-btn" id="forum-memory-clear-digests" type="button" style="margin-top:10px; border:1px solid #ff3b30; color:#ff3b30;">清空动态库</button>' : ''}
        </div>
      </div>
    </div>
  `, root => {
    const rerender = () => {
      closeModal();
      openForumMemorySettings();
    };
    root.querySelector('#forum-memory-settings-save')?.addEventListener('click', async () => {
      const nextReadLimit = Math.max(1, Number(root.querySelector('#forum-memory-read-limit')?.value) || 100);
      const nextSummaryThreshold = Math.max(1, Number(root.querySelector('#forum-memory-summary-threshold')?.value) || 60);
      space.settings = space.settings && typeof space.settings === 'object' ? space.settings : {};
      space.settings.forumReadLimit = nextReadLimit;
      space.settings.forumSummaryThreshold = nextSummaryThreshold;
      await saveState();
      closeModal();
      renderApp();
      if (currentDetailPost) renderPostDetailContent({ preserveScroll: true });
    });
    root.querySelector('#forum-clear-posts-batch')?.addEventListener('click', async () => {
      const requestedCount = Math.floor(Number(root.querySelector('#forum-clear-posts-count')?.value) || 0);
      if (requestedCount <= 0) return showDynamicIsland('请输入要删除的帖子数量');
      const keepSaved = Boolean(root.querySelector('#forum-clear-posts-keep-saved')?.checked);
      const targetPostIds = getOldestForumPostIds(space, requestedCount, { keepSaved });
      const targetCount = targetPostIds.length;
      if (targetCount <= 0) return showDynamicIsland(keepSaved ? '没有可删除的未收藏帖子' : '没有可删除的帖子');
      const savedText = keepSaved ? '已收藏帖子会保留。' : '已收藏帖子也会删除，并从收藏夹移除。';
      if (!confirm(`确定删除最早的 ${targetCount} 个论坛帖子吗？${savedText}`)) return;
      const deletedCount = await clearForumPostsBatch({ postIds: targetPostIds });
      closeModal();
      showDynamicIsland(`已删除 ${deletedCount} 个帖子`);
    });
    
    // ▼▼▼ 新增：绑定保存修改总结事件 ▼▼▼
    root.querySelectorAll('[data-save-summary]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const target = (space.posts || []).find(post => post.id === btn.dataset.saveSummary);
        const textarea = root.querySelector(`textarea[data-edit-summary="${btn.dataset.saveSummary}"]`);
        if (!target || !textarea) return;
        target.forumSummary = textarea.value.trim();
        await saveState();
        if(window.showDynamicIsland) window.showDynamicIsland('总结修改已保存');
        if (currentDetailPost && currentDetailPost.id === target.id) renderPostDetailContent({ preserveScroll: true });
      });
    });
    // ▲▲▲ 新增结束 ▲▲▲

    root.querySelectorAll('[data-retry-summary]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = (space.posts || []).find(post => post.id === btn.dataset.retrySummary);
        if (!target) return;
        if (forumSummarizingPosts.has(target.id) || forumSummaryQueuedPosts.has(target.id)) {
          return showDynamicIsland('这篇帖子正在生成总结，请稍候');
        }
        const task = getForumFailedSummaryTasks(target)
          .find(item => item.id === btn.dataset.retrySummaryTask);
        if (task) {
          const needsFreshSnapshot = task.error === '总结期间帖子进度被手动重置，请重新总结'
            || task.error === '帖子楼层已变化，请重新总结';
          const threshold = Math.max(1, Number(space.settings?.forumSummaryThreshold) || 60);
          const snapshot = needsFreshSnapshot
            ? createForumThreadSummarySnapshot(target, threshold)
            : task.snapshot;
          if (!snapshot) return showDynamicIsland('帖子当前没有可总结的楼层');
          summarizeForumThread(space, target, { snapshot, retryTaskId: task.id });
        } else if (!maybeQueueForumThreadSummary(space, target, { force: true })) {
          return showDynamicIsland('这篇帖子暂时不能重新总结');
        }
        showDynamicIsland('已在后台重新提交本帖总结');
        rerender();
      });
    });

    root.querySelectorAll('[data-clear-summary]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const target = (space.posts || []).find(post => post.id === btn.dataset.clearSummary);
        if (!target) return;
        clearForumPostSummary(target);
        await saveState();
        if (currentDetailPost) renderPostDetailContent({ preserveScroll: true });
        rerender();
      });
    });
    root.querySelectorAll('[data-remove-digest]').forEach(btn => {
      btn.addEventListener('click', async () => {
        removeForumDigest(space, btn.dataset.removeDigest);
        await saveState();
        rerender();
      });
    });
    root.querySelector('#forum-memory-clear-digests')?.addEventListener('click', async () => {
      space.userPostDigests = [];
      await saveState();
      rerender();
    });
  });
}

function markForumCreateSectionsDirty() {
  createAccountsDirty = true;
  createWorldBookDirty = true;
  createRelationsDirty = true;
}

function shouldRenderForumCreateSection(pageId) {
  return forumCreateViewMode === 'all' || activeForumCreatePage === pageId;
}

function renderVisibleForumCreateSections() {
  if (shouldRenderForumCreateSection('accounts') && createAccountsDirty) {
    renderMemberAccountFields();
    createAccountsDirty = false;
  }
  if (shouldRenderForumCreateSection('world') && createWorldBookDirty) {
    renderForumWorldBookSelectors();
    createWorldBookDirty = false;
  }
  if (shouldRenderForumCreateSection('relations') && createRelationsDirty) {
    renderNetwork(draft);
    createRelationsDirty = false;
  }
}

function renderDraft() {
  const identity = AppState.userIdentities?.find(item => item.id === draft.identityId);
  if (els.selectedIdentity) els.selectedIdentity.innerHTML = identity ? `<img src="${identity.avatar || DEFAULT_AVATAR_SRC}" alt=""><span>${escapeHTML(identity.name)}</span>` : '尚未选择身份';
  if (els.selectedMembers) els.selectedMembers.innerHTML = draft.members.map(renderSelectedMemberChip).join('') || '尚未选择角色';
  markForumCreateSectionsDirty();
  updateForumCreateView();
}

function updateForumCreateView(options = {}) {
  const root = document.getElementById('page-forum-create');
  if (!root) return;
  root.dataset.createViewMode = forumCreateViewMode;
  root.dataset.createPage = activeForumCreatePage;
  const page = forumCreateViewMode === 'all'
    ? FORUM_CREATE_ALL_PAGE
    : FORUM_CREATE_PAGES.find(item => item.id === activeForumCreatePage) || FORUM_CREATE_PAGES[0];
  const countEl = document.getElementById('forum-create-page-count');
  const titleEl = document.getElementById('forum-create-page-title');
  const descEl = document.getElementById('forum-create-page-desc');
  if (countEl) countEl.textContent = page.count;
  if (titleEl) titleEl.textContent = page.title;
  if (descEl) descEl.textContent = page.desc;
  root.querySelectorAll('[data-create-view-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.createViewMode === forumCreateViewMode);
  });
  root.querySelectorAll('[data-create-page-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.createPageTab === activeForumCreatePage);
  });
  root.querySelectorAll('[data-create-section]').forEach(section => {
    section.hidden = false;
  });
  renderVisibleForumCreateSections();
  updateForumCreateGridHeight();
}

function moveForumCreatePage(delta) {
  const currentIndex = Math.max(0, FORUM_CREATE_PAGES.findIndex(item => item.id === activeForumCreatePage));
  const nextIndex = Math.max(0, Math.min(FORUM_CREATE_PAGES.length - 1, currentIndex + delta));
  const nextPage = FORUM_CREATE_PAGES[nextIndex]?.id;
  if (!nextPage || nextPage === activeForumCreatePage) return;
  activeForumCreatePage = nextPage;
  updateForumCreateView({ scroll: false });
}

function updateForumCreateGridHeight() {
  const grid = document.getElementById('forum-create-grid');
  if (!grid) return;
  if (forumCreateViewMode !== 'paged') {
    grid.style.height = '';
    return;
  }
  const activeSlide = Array.from(grid.querySelectorAll('.forum-create-slide'))
    .find(slide => slide.dataset.createPage === activeForumCreatePage);
  if (!activeSlide) return;
  const nextHeight = `${activeSlide.scrollHeight + 14}px`;
  if (grid.style.height === nextHeight) return;
  grid.style.height = nextHeight;
}
function renderSelectedMemberChip(member) {
  const profile = draft.forumProfiles?.[member.id] || {};
  const nickname = profile.nickname || member.name;
  const account = profile.account ? `@${profile.account}` : member.meta || '';
  const isCustomNpc = member.type === 'customNpc';
  return `
    <span class="forum-chip forum-member-chip" data-member-id="${escapeHTML(member.id)}">
      <img src="${member.avatar || DEFAULT_AVATAR_SRC}" alt="">
      <span class="forum-member-chip-text">
        <b>${escapeHTML(nickname)}</b>
        ${account ? `<small>${escapeHTML(account)}</small>` : ''}
      </span>
      ${isCustomNpc ? `<button class="forum-chip-action" data-edit-custom-npc="${escapeHTML(member.id)}" type="button" title="修改 NPC">改</button>` : ''}
      <button class="forum-chip-action danger" data-remove-member="${escapeHTML(member.id)}" type="button" title="移除">×</button>
    </span>
  `;
}

function handleSelectedMemberAction(e) {
  const editBtn = e.target.closest('[data-edit-custom-npc]');
  if (editBtn) {
    startEditCustomNpc(editBtn.dataset.editCustomNpc);
    return;
  }
  const removeBtn = e.target.closest('[data-remove-member]');
  if (removeBtn) removeDraftMember(removeBtn.dataset.removeMember);
}

function handleRelationListAction(e) {
  const removeBtn = e.target.closest('[data-remove-relation-index]');
  if (!removeBtn) return;
  removeDraftRelation(Number(removeBtn.dataset.removeRelationIndex));
}

function removeDraftRelation(index) {
  if (!Number.isInteger(index) || !draft.relations?.[index]) return;
  draft.relations = draft.relations.filter((_, itemIndex) => itemIndex !== index);
  renderDraft();
  showDynamicIsland('关系已删除');
}

function removeDraftMemberData(memberId) {
  const removed = draft.members.find(item => item.id === memberId);
  draft.members = draft.members.filter(item => item.id !== memberId);
  draft.relations = (draft.relations || []).filter(rel => rel.from !== memberId && rel.to !== memberId);
  delete draft.forumProfiles[memberId];
  delete draft.characterAliases?.[memberId];
  delete draft.memberWorldBooks?.[memberId];
  delete draft.memberWorldBookEntryIds?.[memberId];
  if (removed?.type === 'customNpc') {
    draft.customNpcs = (draft.customNpcs || []).filter(item => item.id !== memberId);
  }
  if (editingCustomNpcId === memberId) resetCustomNpcForm();
}

function getDraftCharacterAliasState(memberId) {
  if (!draft.characterAliases || typeof draft.characterAliases !== 'object' || Array.isArray(draft.characterAliases)) {
    draft.characterAliases = {};
  }
  const state = draft.characterAliases[memberId] && typeof draft.characterAliases[memberId] === 'object'
    ? draft.characterAliases[memberId]
    : {};
  state.currentAliasId = state.currentAliasId || null;
  state.aliases = Array.isArray(state.aliases) ? state.aliases.slice(0, 1) : [];
  draft.characterAliases[memberId] = state;
  return state;
}

function normalizeForumCharacterAliasesForSave(source = {}, members = []) {
  const characterIds = new Set((members || [])
    .filter(member => member.type === 'character')
    .map(member => member.id)
    .filter(Boolean));
  const result = {};
  Object.entries(source || {}).forEach(([memberId, state]) => {
    if (!characterIds.has(memberId)) return;
    const aliases = (Array.isArray(state?.aliases) ? state.aliases : [])
      .map(alias => ({
        id: String(alias.id || `char_alias_${memberId}_${Date.now()}`),
        ownerId: memberId,
        name: String(alias.name || '').trim(),
        account: String(alias.account || '').trim(),
        avatar: alias.avatar || DEFAULT_AVATAR_SRC,
        bio: String(alias.bio || '').trim(),
        fans: normalizeFansCount(alias.fans),
        followingCount: normalizeFansCount(alias.followingCount)
      }))
      .filter(alias => alias.name || alias.account)
      .slice(0, 1);
    result[memberId] = {
      currentAliasId: aliases.some(alias => alias.id === state?.currentAliasId) ? state.currentAliasId : null,
      aliases: aliases.map(alias => ({
        ...alias,
        name: alias.name || '匿名小号',
        account: alias.account || generateForumAccount(alias.name || 'alias')
      }))
    };
  });
  return result;
}

function removeDraftMember(memberId) {
  removeDraftMemberData(memberId);
  renderDraft();
}

function getCurrentSpace() {
  return state.spaces.find(space => space.id === state.currentSpaceId) || null;
}

function resetForumTransientStateForSpaceChange() {
  if (forumHomeFeedAbortController) {
    forumHomeFeedAbortController.abort();
    forumHomeFeedAbortController = null;
  }
  if (forumCharacterProfileAbortController) {
    forumCharacterProfileAbortController.abort();
    forumCharacterProfileAbortController = null;
    forumCharacterProfileGeneratingViewId = '';
  }
  if (forumCircleDetailAbortController) {
    forumCircleDetailAbortController.abort();
    forumCircleDetailAbortController = null;
    forumCircleDetailGeneratingKey = '';
  }
  closeForumHomeAiMenu();
  removeForumFeedLoadingElements();
  const homeAiButton = document.getElementById('forum-ai-gen-btn');
  homeAiButton?.classList.remove('is-loading');
  homeAiButton?.removeAttribute('aria-busy');
  homeAiButton?.setAttribute('aria-label', 'AI生成');
  forumFeedVisibleKey = '';
  forumFeedVisibleCount = FORUM_POST_RENDER_BATCH_SIZE;
  forumCircleDetailVisibleKey = '';
  forumCircleDetailVisibleCount = FORUM_POST_RENDER_BATCH_SIZE;
  forumPresenceRadarRenderKey = '';
  forumActiveEventPanelRenderKey = '';
  forumWorldBookLogRenderKey = '';
  activeView = 'feed';
  activeCircle = 'all';
  activeProfileTab = 'visual';
  activeFavoriteCollectionId = null;
  activeDmTargetId = null;
  activeDmTargetName = '';
  activeDmSelection = null;
  activeDmSettingsTargetId = null;
  forumDmListSelectionMode = false;
  forumDmSelectedConversationIds.clear();
  activeCircleDetailTab = 'latest';
  currentDetailPost = null;
  currentDetailReplyTarget = null;
  currentDetailReturnView = 'feed';
  currentDetailReturnProfileId = null;
  pendingUserComments = [];
  selectedDetailSticker = null;
  detailCommentManageMode = null;
  selectedDetailCommentTargets = new Set();
  forumDmVisibleMessageCounts.clear();
  expandedFavoriteGroups.clear();
  expandedProfilePostGroups.clear();
  forumCircleDetailExpandedTrendDesc.clear();
  unbindForumCircleDetailTopbar();
  stopForumPeekTimer();
  stopForumPostAudio();
  stopForumDetailVideoTimer();
  const resetForumMainScroll = () => {
    const forumMain = els.feed?.closest('.forum-main');
    if (forumMain) forumMain.scrollTop = 0;
  };
  resetForumMainScroll();
  requestAnimationFrame(resetForumMainScroll);
}

function findForumPostById(postId) {
  const space = getCurrentSpace();
  return space?.posts?.find(post => post.id === postId) || null;
}

function openCreatePanel(force = false) {
  editingSpaceId = null;
  updateCreatePageMode('create');
  draft = createEmptyDraft();
  if (AppState.userIdentities?.[0]) draft.identityId = AppState.userIdentities[0].id;
  if (force || state.spaces.length === 0) {
    showPage('page-forum-create');
  }
  els.titleInput.value = '';
  els.worldInput.value = '';
  if (els.userNicknameInput) els.userNicknameInput.value = '';
  if (els.userAccountInput) {
    const identity = AppState.userIdentities.find(item => item.id === draft.identityId);
    els.userAccountInput.value = generateForumAccount(identity?.name || 'user');
  }
  if (els.userFamousInput) els.userFamousInput.value = 'no';
  if (els.userVerifiedInput) els.userVerifiedInput.checked = false;
  if (els.userOccupationInput) els.userOccupationInput.value = '';
  if (els.userFansInput) els.userFansInput.value = '';
  if (els.userBioInput) els.userBioInput.value = '';
  renderCircleEditor(DEFAULT_CIRCLES);
  renderDraft();
}

function currentIdentity() {
  return AppState.userIdentities.find(item => item.id === (getCurrentSpace()?.identityId || draft.identityId)) || AppState.userIdentities[0];
}
function getCurrentForumUser(space) {
  const identity = currentIdentity();
  const defaultId = `user_${identity?.id}`;
  const defaultProfile = space?.forumProfiles?.[defaultId] || {};
  const defaultName = getForumDisplayName(space, defaultId, identity?.name || '我');
  const defaultAccount = getForumAccount(space, defaultId, defaultName);
  const defaultAvatar = defaultProfile.avatar || identity?.avatar || DEFAULT_AVATAR_SRC;
  
  if (space?.currentAliasId) {
    const alias = (space.aliases || []).find(a => a.id === space.currentAliasId);
    if (alias) {
      return { id: alias.id, name: alias.name, account: alias.account, avatar: alias.avatar || DEFAULT_AVATAR_SRC, bio: alias.bio || '', isAlias: true };
    }
  }
  return { id: defaultId, name: defaultName, account: defaultAccount, avatar: defaultAvatar, bio: defaultProfile.bio || '', isAlias: false };
}

function getCurrentForumUserKey(space) {
  return getCurrentForumUser(space).id;
}

function ensureForumStickerConfigs(space) {
  if (!space) return {};
  if (!space.stickerConfigs || typeof space.stickerConfigs !== 'object') space.stickerConfigs = {};
  return space.stickerConfigs;
}

function getForumStickerConfigIds(space, profileId) {
  if (!space || !profileId) return [];
  const configs = ensureForumStickerConfigs(space);
  return Array.isArray(configs[profileId]) ? configs[profileId] : [];
}

function setForumStickerConfigIds(space, profileId, packIds) {
  if (!space || !profileId) return;
  const configs = ensureForumStickerConfigs(space);
  configs[profileId] = [...new Set(packIds)].filter(Boolean);
}

function isForumPostOwnedByCurrentUser(post) {
  const space = getCurrentSpace();
  if (!space || !post) return false;
  return post.authorId === getCurrentForumUser(space).id;
}

function openIdentityPicker() {
  const identities = AppState.userIdentities || [];
  openSheet('选择用户身份', identities.map(identity => `
    <button class="forum-select-row ${draft.identityId === identity.id ? 'active' : ''}" data-id="${identity.id}" type="button">
      <img src="${identity.avatar || DEFAULT_AVATAR_SRC}" alt="">
      <span>${escapeHTML(identity.name)}</span>
      <small>USER IDENTITY</small>
    </button>
  `).join('') || '<p class="forum-empty">还没有用户身份</p>', root => {
    root.addEventListener('click', e => {
      const row = e.target.closest('[data-id]');
      if (!row) return;
      draft.identityId = row.dataset.id;
      if (els.userNicknameInput) els.userNicknameInput.value = '';
      if (els.userFamousInput) els.userFamousInput.value = 'no';
      if (els.userVerifiedInput) els.userVerifiedInput.checked = false;
      if (els.userOccupationInput) els.userOccupationInput.value = '';
      if (els.userFansInput) els.userFansInput.value = '';
      if (els.userAccountInput) {
        const identity = AppState.userIdentities.find(item => item.id === draft.identityId);
        els.userAccountInput.value = generateForumAccount(identity?.name || 'user');
      }
      closeModal();
      renderDraft();
    });
  });
}

function openMemberPicker() {
  const pool = buildMemberPool();
  openSheet('选择角色 / NPC', pool.map(group => `
    <div class="forum-member-group">
      ${group.type === 'customGroup' ? `<div class="forum-custom-npc-title">自定义 NPC</div>` : `<button class="forum-select-row forum-char-row ${draft.members.some(item => item.id === group.id) ? 'active' : ''}" data-id="${group.id}" type="button">
        <img src="${group.avatar || DEFAULT_AVATAR_SRC}" alt="">
        <span>${escapeHTML(group.name)}</span>
        <small>${escapeHTML(group.meta)}</small>
      </button>`}
      ${group.npcs.length ? `<div class="forum-npc-children">
        ${group.npcs.map(npc => `
          <button class="forum-select-row forum-npc-row ${draft.members.some(item => item.id === npc.id) ? 'active' : ''}" data-id="${npc.id}" type="button">
            <img src="${npc.avatar || DEFAULT_AVATAR_SRC}" alt="">
            <span>${escapeHTML(npc.name)}</span>
            <small>${escapeHTML(npc.meta)}</small>
          </button>
        `).join('')}
      </div>` : ''}
    </div>
  `).join('') || '<p class="forum-empty">还没有可选择角色</p>', root => {
    root.addEventListener('click', e => {
      const row = e.target.closest('[data-id]');
      if (!row) return;
      const member = flattenMemberPool(pool).find(item => item.id === row.dataset.id);
      if (!member) return;
      const exists = draft.members.some(item => item.id === member.id);
      if (exists) {
        removeDraftMemberData(member.id);
      } else {
        draft.members = [...draft.members, member];
        ensureForumProfile(member.id, member.name);
      }
      row.classList.toggle('active', !exists);
      renderDraft();
    });
  }, '完成');
}

function buildMemberPool() {
  const list = [];
  (AppState.characterProfiles || []).filter(char => !char.isGroup && !(typeof char.id === 'string' && char.id.startsWith('group_'))).forEach(char => {
    const group = {
      id: `char_${char.id}`,
      sourceId: char.id,
      type: 'character',
      name: char.name || '未命名角色',
      avatar: char.avatar || DEFAULT_AVATAR_SRC,
      meta: char.tag || char.subtitle || 'CHARACTER',
      npcs: []
    };
    (char.relatedNpcs || []).forEach(npc => {
      group.npcs.push({
        id: `npc_${char.id}_${npc.id || npc.name}`,
        sourceId: npc.id || npc.name,
        ownerId: char.id,
        type: 'npc',
        name: npc.name || 'NPC',
        avatar: npc.avatar || char.avatar || DEFAULT_AVATAR_SRC,
        meta: npc.relation || `NPC / ${char.name}`
      });
    });
    list.push(group);
  });
  if (draft.customNpcs.length) {
    list.push({
      id: 'custom_npc_group',
      sourceId: 'custom_npc_group',
      type: 'customGroup',
      name: '自定义 NPC',
      avatar: DEFAULT_AVATAR_SRC,
      meta: 'CUSTOM',
      npcs: draft.customNpcs
    });
  }
  return list;
}

function flattenMemberPool(pool) {
  return pool.flatMap(group => group.type === 'customGroup' ? group.npcs : [group, ...group.npcs]);
}

function addCustomNpc() {
  const name = els.customNpcName.value.trim();
  if (!name) return;
  const id = editingCustomNpcId || `custom_${Date.now()}`;
  const nickname = els.customNpcNickname?.value.trim() || name;
  const account = els.customNpcAccount?.value.trim() || generateForumAccount(nickname);
  const isFamous = els.customNpcFamous?.value === 'yes';
  const occupation = els.customNpcOccupation?.value.trim() || '';
  const fans = normalizeFansCount(els.customNpcFans?.value);
  const isFollowed = els.customNpcFollowed?.value !== 'no';
  const bio = els.customNpcBio?.value.trim() || '';
  const existingProfile = draft.forumProfiles?.[id] || {};
  const npc = {
    id,
    sourceId: id,
    type: 'customNpc',
    name,
    avatar: els.customNpcAvatarPreview?.src || DEFAULT_AVATAR_SRC,
    meta: els.customNpcPersona?.value.trim() || '自定义 NPC',
    persona: els.customNpcPersona?.value.trim() || '',
    isFamous,
    occupation,
    fans,
    isFollowed
  };
  if (editingCustomNpcId) {
    draft.customNpcs = draft.customNpcs.map(item => item.id === id ? npc : item);
    draft.members = draft.members.map(item => item.id === id ? npc : item);
  } else {
    draft.customNpcs.push(npc);
    draft.members.push(npc);
  }
  ensureForumProfile(npc.id, npc.name);
  draft.forumProfiles[id] = { nickname, account, isFamous, occupation, fans, bio, isFollowed, isVerified: Boolean(existingProfile.isVerified) };
  resetCustomNpcForm();
  renderDraft();
}

function startEditCustomNpc(id) {
  const npc = draft.customNpcs.find(item => item.id === id);
  if (!npc) return;
  const profile = draft.forumProfiles?.[id] || {};
  editingCustomNpcId = id;
  if (els.customNpcName) els.customNpcName.value = npc.name || '';
  if (els.customNpcNickname) els.customNpcNickname.value = profile.nickname || npc.name || '';
  if (els.customNpcAccount) els.customNpcAccount.value = profile.account || '';
  if (els.customNpcFamous) els.customNpcFamous.value = profile.isFamous || npc.isFamous ? 'yes' : 'no';
  if (els.customNpcOccupation) els.customNpcOccupation.value = profile.occupation || npc.occupation || '';
  if (els.customNpcFans) els.customNpcFans.value = normalizeFansCount(profile.fans ?? npc.fans);
  if (els.customNpcFollowed) els.customNpcFollowed.value = isForumProfileFollowed(profile, npc) ? 'yes' : 'no';
  if (els.customNpcBio) els.customNpcBio.value = profile.bio || '';
  if (els.customNpcPersona) els.customNpcPersona.value = npc.persona || npc.meta || '';
  if (els.customNpcAvatarPreview) els.customNpcAvatarPreview.src = npc.avatar || DEFAULT_AVATAR_SRC;
  if (els.addNpcBtn) els.addNpcBtn.textContent = '保存 NPC 修改';
  if (els.deleteCustomNpcBtn) els.deleteCustomNpcBtn.style.display = '';
  showDynamicIsland('正在修改这个 NPC');
}

function deleteCustomNpc(id) {
  removeDraftMemberData(id);
  resetCustomNpcForm();
  renderDraft();
  showDynamicIsland('已删除这个 NPC');
}

function refreshLogin() {
  const space = getCurrentSpace();
  const identity = currentIdentity();
  els.loginSpaceName.textContent = space ? space.name : '添加新方案';
  els.loginAvatar.src = space?.avatar || identity?.avatar || 'images/default-avatar.svg';
  els.loginAccount.value = space?.account || identity?.name || '';
  if (els.loginNickname) {
    els.loginNickname.textContent = getForumDisplayName(space, identity ? `user_${identity.id}` : null, identity?.name || '未命名用户');
  }
}
function syncDraftForumProfiles() {
  if (!draft.forumProfiles) draft.forumProfiles = {};
  const identity = AppState.userIdentities.find(item => item.id === draft.identityId);
  if (identity) {
    const profileId = `user_${identity.id}`;
    const current = draft.forumProfiles[profileId] || {};
    draft.forumProfiles[`user_${identity.id}`] = {
      nickname: els.userNicknameInput?.value.trim() || '',
      account: els.userAccountInput?.value.trim() || '',
      isFamous: els.userFamousInput?.value === 'yes',
      isVerified: els.userVerifiedInput?.checked === true,
      occupation: els.userOccupationInput?.value.trim() || '',
      fans: normalizeFansCount(els.userFansInput?.value),
      bio: els.userBioInput?.value.trim() || '',
      isFollowed: true,
      ...(current.avatar && { avatar: current.avatar }),
    };
  }
  els.memberAccountFields?.querySelectorAll('[data-forum-profile-id]').forEach(row => {
    const id = row.dataset.forumProfileId;
    const current = draft.forumProfiles[id] || {};
    draft.forumProfiles[id] = {
      nickname: row.querySelector('[data-profile-field="nickname"]')?.value.trim() || '',
      account: row.querySelector('[data-profile-field="account"]')?.value.trim() || '',
      isFamous: row.querySelector('[data-profile-field="isFamous"]')?.value === 'yes',
      occupation: row.querySelector('[data-profile-field="occupation"]')?.value.trim() || '',
      fans: normalizeFansCount(row.querySelector('[data-profile-field="fans"]')?.value),
      bio: row.querySelector('[data-profile-field="bio"]')?.value.trim() || '',
      isFollowed: row.querySelector('[data-profile-field="isFollowed"]')?.value !== 'no',
      isVerified: row.querySelector('[data-profile-field="isVerified"]')?.checked === true,
      ...(current.aliasAvatar && { aliasAvatar: current.aliasAvatar }),
      ...(current.avatar && { avatar: current.avatar }),
    };
  });
  createRelationsDirty = true;
}
function ensureForumProfile(id, baseName) {
  if (!draft.forumProfiles) draft.forumProfiles = {};
  const current = draft.forumProfiles[id] || {};
  draft.forumProfiles[id] = {
    nickname: current.nickname || '',
    account: current.account || generateForumAccount(baseName),
    isFamous: Boolean(current.isFamous),
    occupation: current.occupation || '',
    fans: normalizeFansCount(current.fans),
    bio: current.bio || '',
    isFollowed: current.isFollowed !== false,
    isVerified: Boolean(current.isVerified),
    ...(current.aliasAvatar && { aliasAvatar: current.aliasAvatar }), // ←这行很重要，必须要有
    ...(current.avatar && { avatar: current.avatar }),
  };
}
function normalizeFansCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function normalizeForumDmHintChance(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_FORUM_DM_HINT_CHANCE;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function getForumDmHintChance(space) {
  return normalizeForumDmHintChance(space?.settings?.dmHintChancePercent);
}

function isForumProfileFollowed(profile = {}, person = {}) {
  if (profile.isFollowed !== undefined) return profile.isFollowed !== false;
  if (person.isFollowed !== undefined) return person.isFollowed !== false;
  return true;
}

function isForumTemporaryOrdinaryMember(member = {}) {
  return member?.type === 'ordinaryNpc' || String(member?.id || '').startsWith('ordinary_dm_');
}

function isForumTemporaryOrdinaryMemberId(space, memberId) {
  const member = (space?.members || []).find(item => String(item.id) === String(memberId));
  return isForumTemporaryOrdinaryMember(member || { id: memberId });
}

function getCurrentAlias(space) {
  if (!space?.currentAliasId) return null;
  return (space.aliases || []).find(alias => alias.id === space.currentAliasId) || null;
}

function getMainFollowedMemberIds(space) {
  if (!space) return [];
  if (Array.isArray(space.mainFollowedMemberIds)) {
    return space.mainFollowedMemberIds.filter(id => !isForumTemporaryOrdinaryMemberId(space, id));
  }
  return (space.members || [])
    .filter(member => !isForumTemporaryOrdinaryMember(member))
    .filter(member => isForumProfileFollowed(space.forumProfiles?.[member.id], member))
    .map(member => member.id);
}

function getCurrentFollowedMemberIds(space) {
  const alias = getCurrentAlias(space);
  if (alias) {
    return Array.isArray(alias.followedMemberIds)
      ? alias.followedMemberIds.filter(id => !isForumTemporaryOrdinaryMemberId(space, id))
      : [];
  }
  return getMainFollowedMemberIds(space);
}

function setCurrentFollowedMemberIds(space, ids) {
  const cleanIds = [...new Set(ids)].filter(id => id && !isForumTemporaryOrdinaryMemberId(space, id));
  const alias = getCurrentAlias(space);
  if (alias) {
    alias.followedMemberIds = cleanIds;
    return;
  }
  space.mainFollowedMemberIds = cleanIds;
}

function isMemberFollowedByCurrentAccount(space, memberId) {
  return getCurrentFollowedMemberIds(space).includes(memberId);
}

function getForumMentionCandidatesForCurrentAccount(space) {
  const currentUser = getCurrentForumUser(space);
  const followedIds = getCurrentFollowedMemberIds(space);
  const members = Array.isArray(space?.members) ? space.members : [];
  const hasMemberFollowData = members.some(member => Array.isArray(member.followedMemberIds));
  const candidateIds = hasMemberFollowData
    ? followedIds.filter(id => {
        const member = members.find(item => item.id === id);
        return Array.isArray(member?.followedMemberIds) && member.followedMemberIds.includes(currentUser.id);
      })
    : followedIds;
  return candidateIds
    .map(id => {
      const member = members.find(item => item.id === id);
      if (!member || member.id === currentUser.id) return null;
      const name = getForumDisplayName(space, member.id, member.name);
      return {
        id: member.id,
        name,
        account: getForumAccount(space, member.id, name),
        avatar: member.avatar || DEFAULT_AVATAR_SRC
      };
    })
    .filter(Boolean);
}

let activeForumMentionPanel = null;

function closeForumMentionPanel() {
  if (activeForumMentionPanel?.panel) activeForumMentionPanel.panel.remove();
  activeForumMentionPanel = null;
}

function insertForumMention(inputEl, person) {
  if (!inputEl || !activeForumMentionPanel) return;
  const start = activeForumMentionPanel.triggerStart;
  const end = inputEl.selectionStart || start + 1;
  const value = inputEl.value;
  const insertText = `@${person.name} `;
  inputEl.value = value.slice(0, start) + insertText + value.slice(end);
  const nextPos = start + insertText.length;
  inputEl.focus();
  inputEl.setSelectionRange(nextPos, nextPos);
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  closeForumMentionPanel();
}

function showForumMentionPanel(inputEl, triggerStart) {
  const space = getCurrentSpace();
  const people = getForumMentionCandidatesForCurrentAccount(space);
  closeForumMentionPanel();
  if (!people.length) return;
  const panel = document.createElement('div');
  panel.className = 'forum-mention-suggest-panel';
  panel.onpointerdown = e => e.preventDefault();
  panel.innerHTML = people.map(person => `
    <button type="button" data-mention-id="${escapeHTML(person.id)}">
      <img src="${escapeHTML(person.avatar || DEFAULT_AVATAR_SRC)}" alt="">
      <span>${escapeHTML(person.name)}</span>
      <small>@${escapeHTML(person.account || '')}</small>
    </button>
  `).join('');
  document.body.appendChild(panel);
  const rect = inputEl.getBoundingClientRect();
  panel.style.left = `${Math.max(12, Math.min(window.innerWidth - 292, rect.left))}px`;
  panel.style.top = `${Math.max(12, rect.top - panel.offsetHeight - 8)}px`;
  activeForumMentionPanel = { panel, inputEl, triggerStart, people };
  panel.addEventListener('click', e => {
    const row = e.target.closest('[data-mention-id]');
    if (!row) return;
    const person = people.find(item => item.id === row.dataset.mentionId);
    if (person) insertForumMention(inputEl, person);
  });
}

function setupForumAtMentionInput(inputEl) {
  if (!inputEl || inputEl.dataset.forumMentionBound === 'true') return;
  inputEl.dataset.forumMentionBound = 'true';
  inputEl.addEventListener('input', () => {
    const cursor = inputEl.selectionStart || 0;
    if (inputEl.value[cursor - 1] === '@') {
      showForumMentionPanel(inputEl, cursor - 1);
      return;
    }
    closeForumMentionPanel();
  });
  inputEl.addEventListener('blur', () => {
    setTimeout(() => {
      if (activeForumMentionPanel?.inputEl === inputEl) closeForumMentionPanel();
    }, 120);
  });
}

document.addEventListener('pointerdown', e => {
  if (!activeForumMentionPanel) return;
  if (activeForumMentionPanel.panel.contains(e.target) || activeForumMentionPanel.inputEl.contains(e.target)) return;
  closeForumMentionPanel();
});

function findForumPersonName(space, personId) {
  if (!space || !personId) return '';
  const identity = currentIdentity();
  const userId = `user_${identity?.id}`;
  if (personId === userId) return getForumDisplayName(space, userId, identity?.name || '我');
  const characterAlias = findForumCharacterAlias(space, personId);
  if (characterAlias) return characterAlias.alias.name || '';
  const member = (space.members || []).find(item => item.id === personId);
  return member ? getForumDisplayName(space, member.id, member.name) : '';
}

function getForumMentionPeople(space) {
  if (!space) return [];
  return (space.members || [])
    .filter(member => !isForumTemporaryOrdinaryMember(member))
    .flatMap(member => {
      const name = getForumDisplayName(space, member.id, member.name);
      const mainAccount = {
        id: member.id,
        name,
        account: getForumAccount(space, member.id, member.name),
        avatar: getForumAvatar(space, member.id)
      };
      if (member.type !== 'character') return [mainAccount];
      const aliases = getForumCharacterAliasState(space, member.id).aliases || [];
      return [
        mainAccount,
        ...aliases.filter(alias => alias?.id).map(alias => ({
          id: alias.id,
          name: alias.name || `${name}的小号`,
          account: alias.account || generateForumAccount(alias.name || name),
          avatar: alias.avatar || getForumAvatar(space, member.id),
          isCharacterAlias: true
        }))
      ];
    });
}

function getCurrentAccountCircles(space) {
  const alias = getCurrentAlias(space);
  if (alias) return Array.isArray(alias.circles) ? alias.circles : [];
  return space?.circles || [];
}

function getForumSharedDiscoverCircles(space) {
  return Array.isArray(space?.circles) ? space.circles : [];
}

function normalizeForumDiscoverTrends(trends = []) {
  return (Array.isArray(trends) ? trends : [])
    .map((trend, index) => {
      const text = String(trend?.text || trend?.title || '').trim();
      if (!text) return null;
      return {
        id: String(trend?.id || `trend_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`),
        text,
        tag: String(trend?.tag || '').trim().slice(0, 8),
        event: String(trend?.event || '').trim(),
        process: String(trend?.process || trend?.desc || '').trim()
      };
    })
    .filter(Boolean);
}

function getForumDiscoverTrends(space) {
  const trends = normalizeForumDiscoverTrends(space?.discoverTrends);
  return trends.length ? trends : DEFAULT_FORUM_DISCOVER_TRENDS;
}

function normalizeForumSearchText(value) {
  return String(value || '').trim().toLowerCase();
}

function getForumDiscoverSearchResults(space, query) {
  const needle = normalizeForumSearchText(query);
  if (!space || !needle) return [];
  const results = [];
  const seen = new Set();
  const pushResult = item => {
    const haystack = [item.name, item.account, item.desc, item.meta, item.ownerName]
      .map(normalizeForumSearchText)
      .filter(Boolean);
    if (!haystack.some(text => text.includes(needle))) return;
    const key = `${item.kind}:${item.id || item.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(item);
  };
  (space.members || []).filter(member => !isForumTemporaryOrdinaryMember(member)).forEach(member => {
    const name = getForumDisplayName(space, member.id, member.name);
    const account = getForumAccount(space, member.id, name);
    pushResult({
      kind: 'profile',
      id: member.id,
      name,
      account,
      desc: member.type === 'character' ? '角色主页' : '主要 NPC',
      meta: member.meta || member.persona || '',
      avatar: member.avatar || DEFAULT_AVATAR_SRC
    });
  });
  Object.entries(space.characterAliases || {}).forEach(([ownerId, state]) => {
    const owner = (space.members || []).find(member => member.id === ownerId);
    const ownerName = owner ? getForumDisplayName(space, owner.id, owner.name) : '';
    (state?.aliases || []).forEach(alias => {
      pushResult({
        kind: 'profile',
        id: alias.id,
        name: alias.name || '角色小号',
        account: alias.account || '',
        desc: '角色小号',
        ownerName,
        avatar: alias.avatar || owner?.avatar || DEFAULT_AVATAR_SRC
      });
    });
  });
  (space.aliases || []).forEach(alias => {
    pushResult({
      kind: 'alias',
      id: alias.id,
      name: alias.name || '我的小号',
      account: alias.account || '',
      desc: '我的小号',
      avatar: alias.avatar || DEFAULT_AVATAR_SRC
    });
  });
  getForumSharedDiscoverCircles(space).forEach(circle => {
    pushResult({
      kind: 'circle',
      id: circle.name,
      name: circle.name,
      desc: circle.desc || '圈子',
      avatar: ''
    });
  });
  return results.slice(0, 12);
}

function renderForumDiscoverSearchResults(results, query) {
  const cleanQuery = String(query || '').trim();
  const items = results.length ? results : (cleanQuery ? [{
    kind: 'create',
    id: cleanQuery,
    name: cleanQuery,
    desc: '没有找到，点击创建'
  }] : []);
  return items.map(item => `
    <button class="dh-search-result" data-forum-search-kind="${escapeHTML(item.kind)}" data-forum-search-id="${escapeHTML(item.id || item.name)}" data-forum-search-name="${escapeHTML(item.name)}" type="button">
      ${item.avatar ? `<img src="${escapeHTML(item.avatar)}" alt="">` : '<span class="dh-search-result-icon"></span>'}
      <span>
        <b>${escapeHTML(item.name)}</b>
        <small>${escapeHTML([item.desc, item.account ? `@${item.account}` : '', item.ownerName ? `属于 ${item.ownerName}` : ''].filter(Boolean).join(' · '))}</small>
      </span>
    </button>
  `).join('');
}

function openForumDiscoverCreateChoice(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return;
  openSheet('创建搜索结果', `
    <div class="forum-compose-form forum-discover-create-choice">
      <button class="forum-discover-create-option" data-forum-discover-create="npc" type="button">
        <span>
          <b>创建主要 NPC</b>
          <small>把「${escapeHTML(name)}」加入这个论坛方案的人物里</small>
        </span>
      </button>
      <button class="forum-discover-create-option" data-forum-discover-create="circle" type="button">
        <span>
          <b>创建圈子</b>
          <small>把「${escapeHTML(name)}」加入当前论坛方案的共享圈子</small>
        </span>
      </button>
    </div>
  `, root => {
    root.querySelector('[data-forum-discover-create="npc"]')?.addEventListener('click', () => {
      openForumDiscoverNpcCreator(name);
    });
    root.querySelector('[data-forum-discover-create="circle"]')?.addEventListener('click', () => {
      openForumDiscoverCircleCreator(name);
    });
  });
}

function openForumDiscoverCircleCreator(rawName = '') {
  const space = getCurrentSpace();
  if (!space) return showDynamicIsland('请先进入一个论坛方案');
  openSheet('创建圈子', `
    <div class="forum-compose-form">
      <input id="forum-search-circle-name" type="text" placeholder="圈子名" value="${escapeHTML(rawName)}">
      <textarea id="forum-search-circle-desc" placeholder="圈子说明，会影响这个板块出现什么内容"></textarea>
      <button class="forum-primary-btn" id="forum-search-circle-save" type="button">保存圈子</button>
    </div>
  `, root => {
    root.querySelector('#forum-search-circle-save')?.addEventListener('click', async () => {
      const name = root.querySelector('#forum-search-circle-name')?.value.trim() || '';
      const desc = root.querySelector('#forum-search-circle-desc')?.value.trim() || '';
      if (!name) return showDynamicIsland('请输入圈子名');
      const circles = space.circles ||= [];
      if (circles.some(circle => circle.name === name)) return showDynamicIsland('这个圈子已经存在');
      circles.push({ name, desc });
      await saveState();
      closeModal();
      activeView = 'circles';
      renderApp();
      showDynamicIsland('圈子已创建');
    });
  });
}

function openForumDiscoverNpcCreator(rawName = '') {
  const space = getCurrentSpace();
  if (!space) return showDynamicIsland('请先进入一个论坛方案');
  openSheet('创建主要 NPC', `
    <div class="forum-compose-form">
      <div class="forum-profile-edit-avatar">
        <label for="forum-search-npc-avatar-upload">
          <img id="forum-search-npc-avatar-preview" src="${DEFAULT_AVATAR_SRC}" alt="NPC头像">
          <span>+</span>
        </label>
        <input type="file" id="forum-search-npc-avatar-upload" accept="image/*" hidden>
      </div>
      <input id="forum-search-npc-name" type="text" placeholder="NPC 名字" value="${escapeHTML(rawName)}">
      <input id="forum-search-npc-nickname" type="text" placeholder="论坛昵称，不填则同名字" value="${escapeHTML(rawName)}">
      <input id="forum-search-npc-account" type="text" placeholder="账号，不填会自动生成">
      <select id="forum-search-npc-famous">
        <option value="no">普通人</option>
        <option value="yes">名人 / 认证感账号</option>
      </select>
      <input id="forum-search-npc-occupation" type="text" placeholder="职业 / 圈层身份">
      <input id="forum-search-npc-fans" type="number" min="0" placeholder="基础粉丝数">
      <textarea id="forum-search-npc-persona" placeholder="性格、语气、常出没的圈层"></textarea>
      <textarea id="forum-search-npc-bio" placeholder="主页介绍 / 个性签名"></textarea>
      <button class="forum-primary-btn" id="forum-search-npc-save" type="button">保存 NPC</button>
    </div>
  `, root => {
    let avatarDataUrl = DEFAULT_AVATAR_SRC;
    const previewImg = root.querySelector('#forum-search-npc-avatar-preview');
    root.querySelector('#forum-search-npc-avatar-upload')?.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      avatarDataUrl = await compressForumImage(file);
      if (previewImg) previewImg.src = avatarDataUrl;
    });
    root.querySelector('#forum-search-npc-save')?.addEventListener('click', async () => {
      const name = root.querySelector('#forum-search-npc-name')?.value.trim() || '';
      const nickname = root.querySelector('#forum-search-npc-nickname')?.value.trim() || name;
      const account = root.querySelector('#forum-search-npc-account')?.value.trim() || generateForumAccount(nickname);
      const isFamous = root.querySelector('#forum-search-npc-famous')?.value === 'yes';
      const occupation = root.querySelector('#forum-search-npc-occupation')?.value.trim() || '';
      const fans = normalizeFansCount(root.querySelector('#forum-search-npc-fans')?.value);
      const persona = root.querySelector('#forum-search-npc-persona')?.value.trim() || '';
      const bio = root.querySelector('#forum-search-npc-bio')?.value.trim() || '';
      if (!name) return showDynamicIsland('请输入 NPC 名字');
      const id = `custom_${Date.now()}`;
      const npc = {
        id,
        sourceId: id,
        type: 'customNpc',
        name,
        avatar: avatarDataUrl,
        meta: persona || occupation || '自定义 NPC',
        persona,
        isFamous,
        occupation,
        fans,
        isFollowed: true
      };
      space.members = Array.isArray(space.members) ? space.members : [];
      space.members.push(npc);
      if (!space.forumProfiles) space.forumProfiles = {};
      space.forumProfiles[id] = { nickname, account, isFamous, occupation, fans, bio, isFollowed: true, isVerified: false };
      space.mainFollowedMemberIds = Array.isArray(space.mainFollowedMemberIds) ? space.mainFollowedMemberIds : [];
      if (!space.mainFollowedMemberIds.includes(id)) space.mainFollowedMemberIds.push(id);
      await saveState();
      closeModal();
      openProfile(id);
      showDynamicIsland('NPC 已创建');
    });
  });
}

function getActiveForumDiscoverTrendId() {
  return String(activeCircle || '').startsWith('trend:') ? String(activeCircle).slice(6) : '';
}

function findForumDiscoverTrend(space, trendId) {
  return getForumDiscoverTrends(space).find(trend => trend.id === trendId) || null;
}

function getForumDiscoverTrendDesc(trend) {
  return [
    trend?.event ? `事件：${trend.event}` : '',
    trend?.process ? `经过：${trend.process}` : ''
  ].filter(Boolean).join('\n') || '这个热搜暂时还没有事件说明。';
}

function reorderForumDiscoverTrend(space, trendId, direction) {
  if (!space || !Array.isArray(space.discoverTrends)) return false;
  const trends = normalizeForumDiscoverTrends(space.discoverTrends);
  const fromIndex = trends.findIndex(trend => String(trend.id) === String(trendId));
  if (fromIndex < 0) return false;
  const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
  if (toIndex < 0 || toIndex >= trends.length) return false;
  const nextTrends = trends.slice();
  const [moved] = nextTrends.splice(fromIndex, 1);
  nextTrends.splice(toIndex, 0, moved);
  space.discoverTrends = nextTrends;
  return true;
}

function renderForumDiscoverTrendManagerRows(space) {
  const trends = getForumDiscoverTrends(space);
  return trends.map((trend, index) => `
    <div class="forum-trend-manager-row" data-trend-id="${escapeHTML(trend.id)}">
      <span class="num top${index + 1}">${index + 1}</span>
      <span class="txt">${escapeHTML(trend.text)}</span>
      <div class="forum-trend-manager-actions">
        <button data-move-discover-trend="up" data-trend-id="${escapeHTML(trend.id)}" type="button" title="上移" aria-label="上移" ${index === 0 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"></path><path d="M5 12l7-7 7 7"></path></svg>
        </button>
        <button data-move-discover-trend="down" data-trend-id="${escapeHTML(trend.id)}" type="button" title="下移" aria-label="下移" ${index === trends.length - 1 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"></path><path d="M5 12l7 7 7-7"></path></svg>
        </button>
        <button data-delete-discover-trend="${escapeHTML(trend.id)}" type="button" title="删除热搜" aria-label="删除热搜">删除</button>
      </div>
    </div>
  `).join('');
}

function renderForumTrendCopy(trend) {
  const text = String(getForumDiscoverTrendDesc(trend) || '').trim();
  const hasDetail = Boolean(text);
  const isExpanded = forumCircleDetailExpandedTrendDesc.has(String(trend?.id || ''));
  const lines = text ? escapeHTML(text).replace(/\n/g, '<br>') : '这个热搜暂时还没有事件说明。';
  return `
    <p class="${hasDetail && !isExpanded ? 'is-collapsed' : ''}" ${hasDetail ? 'data-trend-desc-body' : ''}>${lines}</p>
    ${hasDetail ? `<button class="circle-detail-copy-toggle" data-trend-desc-toggle="${escapeHTML(trend.id)}" type="button" aria-expanded="${isExpanded ? 'true' : 'false'}">${isExpanded ? '收起' : '展开'}</button>` : ''}
  `;
}

function openForumDiscoverTrendManager() {
  const space = getCurrentSpace();
  if (!space) return showDynamicIsland('请先进入一个论坛方案');
  const trends = getForumDiscoverTrends(space);
  if (!trends.length) return showDynamicIsland('当前没有热搜词条');
  openSheet('管理热搜', `
    <div class="forum-trend-manager">
      ${renderForumDiscoverTrendManagerRows(space)}
    </div>
  `, root => {
    const refreshManager = () => {
      const freshSpace = getCurrentSpace();
      if (!freshSpace) return;
      const body = root.querySelector('.forum-sheet-body');
      if (body) body.innerHTML = `<div class="forum-trend-manager">${renderForumDiscoverTrendManagerRows(freshSpace)}</div>`;
    };
    root.addEventListener('click', async event => {
      const moveBtn = event.target.closest('[data-move-discover-trend]');
      if (moveBtn) {
        const direction = moveBtn.dataset.moveDiscoverTrend;
        const currentSpace = getCurrentSpace();
        if (!currentSpace) return;
        if (!reorderForumDiscoverTrend(currentSpace, moveBtn.dataset.trendId, direction)) return;
        await saveState();
        refreshManager();
        renderApp();
        return;
      }
      const deleteBtn = event.target.closest('[data-delete-discover-trend]');
      if (!deleteBtn) return;
      const currentTrends = getForumDiscoverTrends(space);
      if (currentTrends.length <= 1) return showDynamicIsland('至少保留一条热搜');
      const trendId = deleteBtn.dataset.deleteDiscoverTrend;
      const target = currentTrends.find(trend => String(trend.id) === String(trendId));
      if (!target) return;
      if (!confirm(`确定删除「${target.text}」吗？相关帖子不会被删除。`)) return;
      space.discoverTrends = currentTrends.filter(trend => String(trend.id) !== String(trendId));
      space.lastAiDiscoverTrendIds = (space.lastAiDiscoverTrendIds || []).filter(id => String(id) !== String(trendId));
      const relatedPostIds = new Set();
      (space.posts || []).forEach(post => {
        if (String(post.discoverTrendId) !== String(trendId) && String(post.discoverTrendText || '') !== target.text) return;
        relatedPostIds.add(String(post.id));
        delete post.discoverTrendId;
        delete post.discoverTrendText;
        clearForumPostSummary(post);
      });
      if (currentDetailPost && relatedPostIds.has(String(currentDetailPost.id))) {
        currentDetailPost = (space.posts || []).find(post => String(post.id) === String(currentDetailPost.id)) || currentDetailPost;
      }
      space.userPostDigests = (space.userPostDigests || []).filter(item => !relatedPostIds.has(String(item.postId)));
      if (space.lastAiCircleDetailPostIds?.[`trend:${trendId}`]) {
        space.lastAiCircleDetailPostIds[`trend:${trendId}`] = [];
      }
      if (activeCircle === `trend:${trendId}`) {
        activeView = 'circles';
        activeCircle = 'all';
        activeCircleDetailTab = 'latest';
      }
      forumCircleDetailExpandedTrendDesc.delete(String(trendId));
      await saveState();
      closeModal();
      renderApp();
      showDynamicIsland('热搜已删除');
    });
  });
}

function getForumDiscoverTrendPosts(space, trend) {
  const now = Date.now();
  const text = String(trend?.text || '').trim();
  return (space?.posts || []).filter(post => {
    if ((!post.expiresAt || post.expiresAt > now) && isForumPostPublic(post)) {
      if (post.discoverTrendId === trend?.id || post.discoverTrendText === text) return true;
      return Boolean(text) && String(post.content || '').includes(text);
    }
    return false;
  });
}

function getForumDiscoverTrendDetailPosts(space, trend) {
  const posts = getForumDiscoverTrendPosts(space, trend);
  const scorePost = post => getForumPostLikeDisplayCount(post) * 3 + getForumPostCommentDisplayCount(post) * 2 + Math.max(0, 3 - Math.floor((Date.now() - post.createdAt) / 86400000));
  if (activeCircleDetailTab === 'hot') {
    return [...posts].sort((a, b) => scorePost(b) - scorePost(a) || b.createdAt - a.createdAt);
  }
  if (activeCircleDetailTab === 'recommend') {
    return [...posts].sort((a, b) => {
      const topCommentDiff = Number(Boolean(getTopComment(b))) - Number(Boolean(getTopComment(a)));
      return topCommentDiff || scorePost(b) - scorePost(a) || b.createdAt - a.createdAt;
    });
  }
  return [...posts].sort((a, b) => b.createdAt - a.createdAt);
}

function generateForumAccount(baseName = 'user') {
  const prefixes = ['echo', 'nova', 'momo', 'night', 'orbit', 'mint', 'cloud', 'river', 'pixel', 'loop'];
  const suffixes = ['log', 'bbs', 'feed', 'note', 'room', 'line', 'hub', 'talk'];
  const cleaned = String(baseName)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9_\u4e00-\u9fa5]/g, '')
    .slice(0, 6);
  const head = prefixes[Math.floor(Math.random() * prefixes.length)];
  const tail = suffixes[Math.floor(Math.random() * suffixes.length)];
  const num = Math.floor(100 + Math.random() * 900);
  return cleaned ? `${head}_${cleaned}_${num}` : `${head}_${tail}_${num}`;
}

function parseAiJsonArray(rawText) {
  const text = String(rawText || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('Forum AI JSON parse failed:', error);
    return [];
  }
}

function parseAiJsonObject(rawText) {
  const text = String(rawText || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.comments)) {
        return {
          comments: parsed.comments,
          peeks: Array.isArray(parsed.peeks) ? parsed.peeks : [],
          dmHints: Array.isArray(parsed.dmHints) ? parsed.dmHints : []
        };
      }
    } catch (error) {
      console.error('Forum AI JSON object parse failed:', error);
    }
  }
  return { comments: parseAiJsonArray(rawText), peeks: [], dmHints: [] };
}

function getForumJsonAiRequestConfig() {
  const apiSettings = AppState.apiCurrentSettings || {};
  const rawUrl = String(apiSettings.url || '').trim();
  const key = String(apiSettings.key || '').trim();
  const model = String(apiSettings.model || '').trim();
  const baseUrl = rawUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (!baseUrl) throw new Error('论坛 AI API 地址未设置');
  if (!key) throw new Error('论坛 AI API 密钥未设置');
  if (!model) throw new Error('论坛 AI 模型未选择');
  try {
    new URL(baseUrl);
  } catch (error) {
    throw new Error('论坛 AI API 地址格式不正确，请填写完整地址，例如 https://api.example.com');
  }
  return { endpoint: `${baseUrl}/v1/chat/completions`, key, model };
}

async function sendForumJsonPromptToAI(prompt) {
  const { endpoint, key, model } = getForumJsonAiRequestConfig();
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        stream: false
      })
    });
  } catch (error) {
    throw new Error(error?.message || '论坛 AI 请求发送失败');
  }
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new Error(`论坛 AI 请求失败：${errorData.error?.message || response.statusText}`);
  }
  const data = await response.json().catch(() => null);
  if (!data) throw new Error('论坛 AI 返回内容不是标准 JSON');
  return data.choices?.[0]?.message?.content || '';
}

async function requestForumJsonArray(prompt, minCount = 3, options = {}) {
  const sendPrompt = options.useForumJsonEndpoint ? sendForumJsonPromptToAI : sendToAIForSummary;
  const first = parseAiJsonArray(await sendPrompt(prompt));
  if (first.length >= minCount) return first;
  const retryPrompt = `${prompt}

上一次返回少于 ${minCount} 条。请立刻补正：只输出一个 JSON 数组，数组长度必须不少于 ${minCount}，不要解释。`;
  return parseAiJsonArray(await sendPrompt(retryPrompt));
}

function getForumWorldSetupPrompt() {
  const identity = AppState.userIdentities.find(item => item.id === draft.identityId);
  const people = getDraftPeople().map(person => {
    const profile = draft.forumProfiles?.[person.id] || {};
    return `${person.forumName || person.name}${profile.isFamous ? '，名人' : ''}${profile.occupation ? `，职业：${profile.occupation}` : ''}${profile.fans ? `，基础粉丝量：${profile.fans}` : ''}`;
  }).join('\n- ');
  return [
    `论坛方案：${els.titleInput?.value.trim() || '未命名论坛'}`,
    `论坛世界观与风格导向：${els.worldInput?.value.trim() || '未填写'}`,
    `用户身份：${identity?.name || '未选择'}`,
    people ? `已有人物：\n- ${people}` : '已有人物：暂无',
    `注意：世界观字段是后续论坛主要人物、帖子内容、圈层风格的总导向，不是用户个性签名。`
  ].join('\n');
}

async function generateNpcDraftsWithAI() {
  const btn = els.npcGenerateDraftBtn;
  const oldText = btn?.textContent;
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = '生成中...';
    }
    const brief = els.npcAiBrief?.value.trim() || '';
    const prompt = `${getForumWorldSetupPrompt()}

请为这个论坛生成不少于 3 个可编辑 NPC 草稿。
要求：
1. 这些 NPC 是后续论坛里会反复出现的主要路人/圈内人/粉丝/黑粉/知情人。
2. 必须贴合“论坛世界观与风格导向”，不要当成用户个性签名。
3. 每个 NPC 都要能帮助 AI 后续判断发帖口吻、职业身份、是否名人、基础粉丝量。
4. 用户额外方向：${brief || '无'}

只输出 JSON 数组，不要解释。每个对象字段：
name, nickname, account, persona, isFamous, occupation, fans
其中 isFamous 是布尔值，fans 是数字。可以额外给 bio 作为这个 NPC 的公开个性签名。数组长度必须 >= 3。`;
    const items = await requestForumJsonArray(prompt, 3);
    const validItems = items.filter(item => item && (item.name || item.nickname)).slice(0, 8);
    if (validItems.length < 3) {
      showDynamicIsland('AI 返回的 NPC 少于 3 个，请再试一次');
      return;
    }
    validItems.forEach((item, index) => {
      const name = String(item.name || item.nickname || `NPC ${index + 1}`).trim();
      const nickname = String(item.nickname || name).trim();
      const id = `custom_${Date.now()}_${index}`;
      const npc = {
        id,
        sourceId: id,
        type: 'customNpc',
        name,
        avatar: DEFAULT_AVATAR_SRC,
        meta: String(item.persona || item.occupation || 'AI 生成 NPC').trim(),
        persona: String(item.persona || '').trim(),
        isFamous: Boolean(item.isFamous),
        occupation: String(item.occupation || '').trim(),
        fans: normalizeFansCount(item.fans),
        isFollowed: true
      };
      draft.customNpcs.push(npc);
      draft.members.push(npc);
      draft.forumProfiles[id] = {
        nickname,
        account: String(item.account || '').trim() || generateForumAccount(nickname),
        isFamous: npc.isFamous,
        occupation: npc.occupation,
        fans: npc.fans,
        bio: String(item.bio || '').trim(),
        isFollowed: true
      };
    });
    resetCustomNpcForm();
    renderDraft();
    showDynamicIsland(`已生成 ${validItems.length} 个 NPC 草稿`);
  } catch (error) {
    console.error('Forum NPC AI generation failed:', error);
    showDynamicIsland('NPC AI 生成失败，请检查 API 设置');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || '生成可编辑草稿';
    }
  }
}

async function generateCircleDraftsWithAI() {
  const btn = els.circleGenerateDraftBtn;
  const oldText = btn?.textContent;
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = '生成中...';
    }
    const brief = els.circleAiBrief?.value.trim() || '';
    const prompt = `${getForumWorldSetupPrompt()}

请为这个论坛生成不少于 3 个高频圈子。
要求：
1. 圈子是后续 AI 发帖、吃瓜、争论、粉圈互动、路人闲聊时会使用的主要板块。
2. 必须贴合“论坛世界观与风格导向”，不要当成用户个性签名。
3. 每个圈子的 desc 要说明这个板块会出现什么内容、什么语气、什么人常来。
4. 用户额外方向：${brief || '无'}

只输出 JSON 数组，不要解释。每个对象字段：
name, desc
数组长度必须 >= 3。`;
    const items = await requestForumJsonArray(prompt, 3);
    const circles = items
      .map(item => ({
        name: String(item?.name || '').trim(),
        desc: String(item?.desc || '').trim()
      }))
      .filter(item => item.name)
      .slice(0, 10);
    if (circles.length < 3) {
      showDynamicIsland('AI 返回的圈子少于 3 个，请再试一次');
      return;
    }
    renderCircleEditor(circles);
    showDynamicIsland(`已生成 ${circles.length} 个圈子草稿`);
  } catch (error) {
    console.error('Forum circle AI generation failed:', error);
    showDynamicIsland('圈子 AI 生成失败，请检查 API 设置');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || '生成圈子草稿';
    }
  }
}

async function generateForumDiscoverTrendsWithAI(options = {}) {
  const space = getCurrentSpace();
  if (!space) {
    showDynamicIsland('请先进入一个论坛方案');
    return;
  }
  openSheet('AI 生成热搜', `
    <div class="forum-compose-form">
      <textarea id="forum-discover-trend-brief" placeholder="写清楚热搜方向，例如：只要校园八卦、只要暗网吃瓜向、集中在娱乐圈粉圈…"></textarea>
      <input id="forum-discover-trend-count" type="number" value="4" min="1" max="8">
      <button class="forum-primary-btn" id="forum-discover-trend-confirm" type="button">生成热搜</button>
    </div>
  `, root => {
    const confirmBtn = root.querySelector('#forum-discover-trend-confirm');
    confirmBtn?.addEventListener('click', async () => {
      const oldText = confirmBtn.textContent;
      try {
        confirmBtn.disabled = true;
        confirmBtn.textContent = '生成中...';
        const brief = root.querySelector('#forum-discover-trend-brief')?.value.trim() || '';
        const countInput = root.querySelector('#forum-discover-trend-count');
        const count = Math.min(8, Math.max(1, Math.floor(Number(countInput?.value) || 4)));
        if (countInput) countInput.value = String(count);
        space.discoverTrends = normalizeForumDiscoverTrends(space.discoverTrends);
        if (options.replaceLastBatch) {
          const lastIds = new Set((space.lastAiDiscoverTrendIds || []).map(String));
          space.discoverTrends = space.discoverTrends.filter(trend => !lastIds.has(String(trend.id || '')));
          space.lastAiDiscoverTrendIds = [];
          await saveState();
          renderApp();
        }
        const context = await getForumGenerationContext(space, null, '探索页热搜生成');
        const existingTrends = getForumDiscoverTrends(space);
        const existingLines = existingTrends
          .map(trend => `- ${trend.text}${trend.event ? `：${trend.event}` : ''}${trend.process ? `；经过：${trend.process}` : ''}`)
          .join('\n') || '无';
        const prompt = `${context}

[当前热搜榜]
${existingLines}

请根据用户填写的方向，为探索发现页生成 ${count} 条微博热搜榜式词条。
用户填写的热搜方向：${brief || '未填写'}

要求：
1. 热搜必须受到论坛世界观、公共世界书、主要人物和关系状态影响，像这个世界里真实正在发酵的事。
2. 热搜不一定要和主要角色、主要 NPC 或用户有关；可以从这个世界观里自然推演公共事件、行业内幕、圈层瓜、制度争议、情感关系、身份反转、利益冲突等更大范围的话题。
3. 这是女性向论坛。可以劲爆、抓马、暧昧、反转、暗流涌动，但绝不可以出现诋毁女性、羞辱女性、雌竞、荡妇羞辱、外貌羞辱、受害者有罪论、把女性当笑柄或把女性互害当爽点的话题。
4. 每条 text 是热搜词条，不是圈子名；要短、抓人、像微博热搜，不要和当前热搜重名或高度重复。
5. 每条 event 必须写清楚“这个事件是什么事情”，不要只写氛围词。
6. 每条 process 必须写清楚“事情经过是什么样的”：起因、关键动作、现在为什么被讨论。
7. 内容要集中在用户填写的热搜方向上，不要发散到无关主题，也不要凭空跳出论坛世界导向。
8. tag 只能是 "NEW"、"HOT"、"UP" 或空字符串。

只输出 JSON 数组，不要解释。数组长度必须为 ${count}。每个对象字段：
text, tag, event, process`;
        const items = await requestForumJsonArray(prompt, 1, { useForumJsonEndpoint: true });
        const existingTextSet = new Set(existingTrends.map(trend => String(trend?.text || '')));
        const newTextSet = new Set();
        const newTrends = items
          .map(item => ({
            id: `ai_trend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            text: String(item?.text || item?.name || '').trim(),
            tag: String(item?.tag || '').trim().slice(0, 8),
            event: String(item?.event || '').trim(),
            process: String(item?.process || item?.desc || '').trim()
          }))
          .filter(item => {
            if (!item.text || existingTextSet.has(item.text) || newTextSet.has(item.text)) return false;
            newTextSet.add(item.text);
            return true;
          })
          .slice(0, count);
        if (!newTrends.length) {
          showDynamicIsland('AI 没有生成新的热搜，请换个方向再试');
          return;
        }
        space.discoverTrends.push(...newTrends);
        space.lastAiDiscoverTrendIds = newTrends.map(trend => trend.id);
        await saveState();
        closeModal();
        renderApp();
        showDynamicIsland(`已补充 ${newTrends.length} 条热搜`);
      } catch (error) {
        console.error('Forum discover trend AI generation failed:', error);
        showDynamicIsland('热搜 AI 生成失败，请检查 API 设置');
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = oldText || '生成热搜';
      }
    });
  });
}

function compressForumImage(file, maxSize = 420, quality = 0.72) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxSize) {
          height = Math.round(height * maxSize / width);
          width = maxSize;
        } else if (height > maxSize) {
          width = Math.round(width * maxSize / height);
          height = maxSize;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(e.target.result);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(DEFAULT_AVATAR_SRC);
    reader.readAsDataURL(file);
  });
}

async function handleCustomNpcAvatarUpload(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const avatar = await compressForumImage(file);
  if (els.customNpcAvatarPreview) els.customNpcAvatarPreview.src = avatar;
}

async function handleOrdinaryNpcAvatarUpload(e) {
  const files = Array.from(e.target.files || []).filter(file => file?.type?.startsWith('image/'));
  if (!files.length) return;
  const remainingSlots = FORUM_ORDINARY_NPC_AVATAR_LIMIT - normalizeForumOrdinaryNpcAvatars(state.ordinaryNpcAvatars).length;
  if (remainingSlots <= 0) {
    showDynamicIsland(`普通 NPC 头像库最多 ${FORUM_ORDINARY_NPC_AVATAR_LIMIT} 张`);
    e.target.value = '';
    return;
  }
  const compressedAvatars = [];
  const root = e.target.closest('#page-forum-ordinary-npc-avatars') || e.target.closest('.forum-sheet');
  const group = root?.querySelector('#forum-ordinary-npc-avatar-import-group')?.value || 'general';
  for (const file of files.slice(0, remainingSlots)) {
    compressedAvatars.push({ url: await compressForumImage(file), group });
  }
  state.ordinaryNpcAvatars = normalizeForumOrdinaryNpcAvatars([
    ...state.ordinaryNpcAvatars,
    ...compressedAvatars
  ]);
  e.target.value = '';
  renderOrdinaryNpcAvatarLibrary(root);
  await saveState();
  showDynamicIsland(`已添加 ${compressedAvatars.length} 张普通 NPC 头像`);
}

function getForumOrdinaryNpcAvatarGroupOptions(selected = 'general') {
  return getForumOrdinaryNpcAvatarGroups().map(group =>
    `<option value="${escapeHTML(group.id)}" ${group.id === selected ? 'selected' : ''}>${escapeHTML(group.label)}</option>`
  ).join('');
}

function renderForumOrdinaryNpcAvatarTabs(activeFilter = 'all') {
  const customGroupIds = new Set(normalizeForumOrdinaryNpcAvatarGroups(state.ordinaryNpcAvatarGroups).map(group => group.id));
  return [
    `<button class="${activeFilter === 'all' ? 'active' : ''}" data-avatar-filter="all" type="button">全部</button>`,
    ...getForumOrdinaryNpcAvatarGroups().map(group => `
      <span class="forum-ordinary-npc-avatar-tab-item">
        <button class="${activeFilter === group.id ? 'active' : ''}" data-avatar-filter="${escapeHTML(group.id)}" type="button">${escapeHTML(group.label)}</button>
        ${customGroupIds.has(group.id) ? `<button class="forum-ordinary-npc-avatar-tab-delete" data-delete-ordinary-npc-avatar-group="${escapeHTML(group.id)}" type="button" title="删除分组">×</button>` : ''}
      </span>
    `)
  ].join('');
}

function openOrdinaryNpcAvatarLibraryPage() {
  if (!els.ordinaryNpcAvatarPage || !els.ordinaryNpcAvatarPageBody) return;
  els.ordinaryNpcAvatarPageBody.innerHTML = `
    <div class="forum-ordinary-npc-manager" data-avatar-filter="all" data-avatar-visible-count="${FORUM_ORDINARY_NPC_AVATAR_RENDER_BATCH}">
      <p>默认全局：这里的头像会和系统原有头像混在一起，只给路人/普通 NPC 使用；主要 NPC、角色、小号不会用这里的头像。</p>
      <textarea id="forum-ordinary-npc-avatar-url-input" placeholder="一行一个图片 URL，也可以粘贴“说明:URL”&#10;https://example.com/avatar-1.jpg&#10;头像2：https://example.com/avatar-2.png"></textarea>
      <div class="forum-ordinary-npc-manager-actions">
        <select id="forum-ordinary-npc-avatar-import-group">${getForumOrdinaryNpcAvatarGroupOptions()}</select>
        <button class="forum-outline-btn" id="forum-ordinary-npc-avatar-url-save" type="button">导入 URL</button>
        <label for="forum-ordinary-npc-avatar-upload">上传本地</label>
        <input id="forum-ordinary-npc-avatar-upload" type="file" accept="image/*" multiple style="display: none;">
      </div>
      <div class="forum-ordinary-npc-group-adder">
        <input id="forum-ordinary-npc-avatar-group-name" type="text" maxlength="10" placeholder="新增分组名">
        <button id="forum-ordinary-npc-avatar-group-add" type="button">添加分组</button>
      </div>
      <div class="forum-ordinary-npc-avatar-tabs">${renderForumOrdinaryNpcAvatarTabs('all')}</div>
      <div class="forum-ordinary-npc-avatar-list-head">
        <div class="forum-ordinary-npc-avatar-meta" id="forum-ordinary-npc-avatar-meta"></div>
        <button class="forum-ordinary-npc-avatar-list-toggle" id="forum-ordinary-npc-avatar-list-toggle" type="button">再显示 40 张</button>
      </div>
      <div id="forum-ordinary-npc-avatar-list" class="forum-ordinary-npc-avatar-list"></div>
    </div>
  `;
  const root = els.ordinaryNpcAvatarPage;
  root.querySelector('#forum-ordinary-npc-avatar-url-save')?.addEventListener('click', () => importOrdinaryNpcAvatarUrls(root));
  root.querySelector('#forum-ordinary-npc-avatar-group-add')?.addEventListener('click', () => addOrdinaryNpcAvatarGroup(root));
  root.querySelector('#forum-ordinary-npc-avatar-upload')?.addEventListener('change', handleOrdinaryNpcAvatarUpload);
  root.querySelector('#forum-ordinary-npc-avatar-list')?.addEventListener('click', e => handleOrdinaryNpcAvatarListClick(e, root));
  root.querySelector('#forum-ordinary-npc-avatar-list')?.addEventListener('change', e => handleOrdinaryNpcAvatarListChange(e, root));
  root.querySelector('#forum-ordinary-npc-avatar-list-toggle')?.addEventListener('click', () => {
    const manager = root.querySelector('.forum-ordinary-npc-manager');
    if (!manager) return;
    const currentCount = Number(manager.dataset.avatarVisibleCount) || FORUM_ORDINARY_NPC_AVATAR_RENDER_BATCH;
    const totalCount = Number(manager.dataset.avatarVisibleTotal) || 0;
    manager.dataset.avatarVisibleCount = String(currentCount >= totalCount
      ? FORUM_ORDINARY_NPC_AVATAR_RENDER_BATCH
      : currentCount + FORUM_ORDINARY_NPC_AVATAR_RENDER_BATCH);
    renderOrdinaryNpcAvatarLibrary(root);
  });
  root.querySelector('.forum-ordinary-npc-avatar-tabs')?.addEventListener('click', e => {
    const deleteBtn = e.target.closest('[data-delete-ordinary-npc-avatar-group]');
    if (deleteBtn) {
      deleteOrdinaryNpcAvatarGroup(root, deleteBtn.dataset.deleteOrdinaryNpcAvatarGroup);
      return;
    }
    const btn = e.target.closest('[data-avatar-filter]');
    if (!btn) return;
    const manager = root.querySelector('.forum-ordinary-npc-manager');
    if (!manager) return;
    manager.dataset.avatarFilter = btn.dataset.avatarFilter || 'all';
    manager.dataset.avatarVisibleCount = String(FORUM_ORDINARY_NPC_AVATAR_RENDER_BATCH);
    root.querySelectorAll('.forum-ordinary-npc-avatar-tabs [data-avatar-filter]').forEach(item => item.classList.toggle('active', item === btn));
    renderOrdinaryNpcAvatarLibrary(root);
  });
  renderOrdinaryNpcAvatarLibrary(root);
  showPage('page-forum-ordinary-npc-avatars');
}

function addOrdinaryNpcAvatarGroup(root) {
  const input = root.querySelector('#forum-ordinary-npc-avatar-group-name');
  const label = String(input?.value || '').trim().slice(0, 10);
  if (!label) return showDynamicIsland('请输入分组名');
  const groups = getForumOrdinaryNpcAvatarGroups();
  if (groups.some(group => group.label.trim().toLowerCase() === label.toLowerCase())) {
    return showDynamicIsland('这个分组已经存在');
  }
  const customGroups = normalizeForumOrdinaryNpcAvatarGroups(state.ordinaryNpcAvatarGroups);
  if (customGroups.length >= 12) return showDynamicIsland('自定义分组最多 12 个');
  const group = { id: getForumOrdinaryNpcGroupId(label), label };
  state.ordinaryNpcAvatarGroups = normalizeForumOrdinaryNpcAvatarGroups([...customGroups, group]);
  if (input) input.value = '';
  const select = root.querySelector('#forum-ordinary-npc-avatar-import-group');
  if (select) {
    select.innerHTML = getForumOrdinaryNpcAvatarGroupOptions(group.id);
    select.value = group.id;
  }
  renderOrdinaryNpcAvatarLibrary(root);
  saveState().catch(error => console.error('Forum ordinary NPC avatar group add failed:', error));
  showDynamicIsland(`已添加分组「${label}」`);
}

function deleteOrdinaryNpcAvatarGroup(root, groupId) {
  const customGroups = normalizeForumOrdinaryNpcAvatarGroups(state.ordinaryNpcAvatarGroups);
  const group = customGroups.find(item => item.id === groupId);
  if (!group) return;
  if (!confirm(`确定删除分组「${group.label}」吗？这个分组里的头像会移到“通用”，头像本身不会删除。`)) return;
  state.ordinaryNpcAvatarGroups = customGroups.filter(item => item.id !== groupId);
  state.ordinaryNpcAvatars = normalizeForumOrdinaryNpcAvatars(state.ordinaryNpcAvatars)
    .map(avatar => avatar.group === groupId ? { ...avatar, group: 'general' } : avatar);
  const manager = root.querySelector('.forum-ordinary-npc-manager');
  if (manager?.dataset.avatarFilter === groupId) manager.dataset.avatarFilter = 'all';
  const select = root.querySelector('#forum-ordinary-npc-avatar-import-group');
  if (select) select.innerHTML = getForumOrdinaryNpcAvatarGroupOptions('general');
  renderOrdinaryNpcAvatarLibrary(root);
  saveState().catch(error => console.error('Forum ordinary NPC avatar group delete failed:', error));
  showDynamicIsland(`已删除分组「${group.label}」`);
}

async function importOrdinaryNpcAvatarUrls(root) {
  const input = root.querySelector('#forum-ordinary-npc-avatar-url-input');
  const urls = extractForumImageUrls(input?.value || '');
  if (!urls.length) return showDynamicIsland('没有识别到图片 URL');
  const currentAvatars = normalizeForumOrdinaryNpcAvatars(state.ordinaryNpcAvatars);
  const currentUrls = new Set(currentAvatars.map(avatar => avatar.url));
  const remainingSlots = FORUM_ORDINARY_NPC_AVATAR_LIMIT - currentAvatars.length;
  if (remainingSlots <= 0) return showDynamicIsland(`普通 NPC 头像库最多 ${FORUM_ORDINARY_NPC_AVATAR_LIMIT} 张`);
  const group = root.querySelector('#forum-ordinary-npc-avatar-import-group')?.value || 'general';
  const importedAvatars = urls
    .filter(url => !currentUrls.has(url) && currentUrls.add(url))
    .slice(0, remainingSlots)
    .map(url => ({ url, group }));
  if (!importedAvatars.length) return showDynamicIsland('这些 URL 已经导入过了');
  state.ordinaryNpcAvatars = normalizeForumOrdinaryNpcAvatars([
    ...currentAvatars,
    ...importedAvatars
  ]);
  if (input) input.value = '';
  renderOrdinaryNpcAvatarLibrary(root);
  await saveState();
  showDynamicIsland(`已导入 ${importedAvatars.length} 个头像 URL`);
}

function handleOrdinaryNpcAvatarListClick(e, root) {
  const btn = e.target.closest('[data-remove-ordinary-npc-avatar]');
  if (!btn) return;
  const index = Number(btn.dataset.removeOrdinaryNpcAvatar);
  const avatars = normalizeForumOrdinaryNpcAvatars(state.ordinaryNpcAvatars);
  if (!Number.isInteger(index) || !avatars[index]) return;
  avatars.splice(index, 1);
  state.ordinaryNpcAvatars = avatars;
  renderOrdinaryNpcAvatarLibrary(root);
  saveState().catch(error => console.error('Forum ordinary NPC avatar save failed:', error));
  showDynamicIsland('已移除这张普通 NPC 头像');
}

function handleOrdinaryNpcAvatarListChange(e, root) {
  const select = e.target.closest('[data-change-ordinary-npc-avatar-group]');
  if (!select) return;
  const index = Number(select.dataset.changeOrdinaryNpcAvatarGroup);
  const avatars = normalizeForumOrdinaryNpcAvatars(state.ordinaryNpcAvatars);
  if (!Number.isInteger(index) || !avatars[index]) return;
  avatars[index] = { ...avatars[index], group: select.value || 'general' };
  state.ordinaryNpcAvatars = normalizeForumOrdinaryNpcAvatars(avatars);
  renderOrdinaryNpcAvatarLibrary(root);
  saveState().catch(error => console.error('Forum ordinary NPC avatar group save failed:', error));
}

function renderOrdinaryNpcAvatarLibrary(root) {
  const list = root?.querySelector('#forum-ordinary-npc-avatar-list');
  if (!list) return;
  const avatars = normalizeForumOrdinaryNpcAvatars(state.ordinaryNpcAvatars);
  const groups = getForumOrdinaryNpcAvatarGroups();
  const groupIds = new Set(groups.map(group => group.id));
  const manager = root.querySelector('.forum-ordinary-npc-manager');
  let activeFilter = manager?.dataset.avatarFilter || 'all';
  if (activeFilter !== 'all' && !groupIds.has(activeFilter)) activeFilter = 'all';
  if (manager) manager.dataset.avatarFilter = activeFilter;
  const tabs = root.querySelector('.forum-ordinary-npc-avatar-tabs');
  if (tabs) tabs.innerHTML = renderForumOrdinaryNpcAvatarTabs(activeFilter);
  const importSelect = root.querySelector('#forum-ordinary-npc-avatar-import-group');
  if (importSelect) {
    const selectedGroup = groupIds.has(importSelect.value) ? importSelect.value : 'general';
    importSelect.innerHTML = getForumOrdinaryNpcAvatarGroupOptions(selectedGroup);
    importSelect.value = selectedGroup;
  }
  const visibleAvatars = activeFilter === 'all'
    ? avatars.map((avatar, index) => ({ avatar, index }))
    : avatars.map((avatar, index) => ({ avatar, index })).filter(item => item.avatar.group === activeFilter);
  const requestedVisibleCount = Math.max(
    FORUM_ORDINARY_NPC_AVATAR_RENDER_BATCH,
    Number(manager?.dataset.avatarVisibleCount) || FORUM_ORDINARY_NPC_AVATAR_RENDER_BATCH
  );
  const renderedAvatars = visibleAvatars.slice(0, requestedVisibleCount);
  if (manager) {
    manager.dataset.avatarVisibleCount = String(renderedAvatars.length || FORUM_ORDINARY_NPC_AVATAR_RENDER_BATCH);
    manager.dataset.avatarVisibleTotal = String(visibleAvatars.length);
  }
  const meta = root.querySelector('#forum-ordinary-npc-avatar-meta');
  if (meta) meta.textContent = `已添加 ${avatars.length} / ${FORUM_ORDINARY_NPC_AVATAR_LIMIT} 张，当前渲染 ${renderedAvatars.length} / ${visibleAvatars.length} 张。`;
  const listToggle = root.querySelector('#forum-ordinary-npc-avatar-list-toggle');
  if (listToggle) {
    const remainingCount = Math.max(0, visibleAvatars.length - renderedAvatars.length);
    listToggle.textContent = remainingCount > 0
      ? `再显示 ${Math.min(FORUM_ORDINARY_NPC_AVATAR_RENDER_BATCH, remainingCount)} 张`
      : renderedAvatars.length > FORUM_ORDINARY_NPC_AVATAR_RENDER_BATCH ? `收起到 ${FORUM_ORDINARY_NPC_AVATAR_RENDER_BATCH} 张` : '已全部显示';
    listToggle.disabled = visibleAvatars.length <= FORUM_ORDINARY_NPC_AVATAR_RENDER_BATCH;
  }
  list.innerHTML = renderedAvatars.length
    ? renderedAvatars.map(({ avatar, index }) => `
      <span class="forum-ordinary-npc-avatar-thumb">
        <img src="${escapeHTML(avatar.url)}" alt="普通 NPC 头像" loading="lazy" decoding="async">
        <select data-change-ordinary-npc-avatar-group="${index}" aria-label="头像分组">
          ${getForumOrdinaryNpcAvatarGroupOptions(avatar.group)}
        </select>
        <button data-remove-ordinary-npc-avatar="${index}" type="button" title="移除这张头像">×</button>
      </span>
    `).join('')
    : '<span class="forum-ordinary-npc-avatar-empty">未上传时，会使用系统原有普通 NPC 头像库。</span>';
}

function resetCustomNpcForm() {
  editingCustomNpcId = null;
  if (els.customNpcName) els.customNpcName.value = '';
  if (els.customNpcNickname) els.customNpcNickname.value = '';
  if (els.customNpcAccount) els.customNpcAccount.value = '';
  if (els.customNpcFamous) els.customNpcFamous.value = 'no';
  if (els.customNpcOccupation) els.customNpcOccupation.value = '';
  if (els.customNpcFans) els.customNpcFans.value = '';
  if (els.customNpcFollowed) els.customNpcFollowed.value = 'yes';
  if (els.customNpcBio) els.customNpcBio.value = '';
  if (els.customNpcPersona) els.customNpcPersona.value = '';
  if (els.customNpcAvatarPreview) els.customNpcAvatarPreview.src = DEFAULT_AVATAR_SRC;
  if (els.customNpcAvatarUpload) els.customNpcAvatarUpload.value = '';
  if (els.addNpcBtn) els.addNpcBtn.textContent = '添加 NPC';
  if (els.deleteCustomNpcBtn) els.deleteCustomNpcBtn.style.display = 'none';
}

async function generateNpcDraftFromWorkbench() {
  await generateNpcDraftsWithAI();
  return;
  const brief = els.npcAiBrief?.value.trim() || els.worldInput?.value.trim() || '';
  const identity = AppState.userIdentities.find(item => item.id === draft.identityId);
  const memberNames = draft.members.map(member => member.name).filter(Boolean).slice(0, 4);
  const seed = Number(Date.now().toString().slice(-4));
  const archetypes = [
    {
      name: '匿名情报员',
      nickname: '只放锤不吵架',
      role: '常年潜水，偶尔丢出关键截图和时间线',
      tone: '短句、克制、喜欢用“先别急”“看时间点”开头',
      secret: '知道一些别人不知道的旧事，但不会一次说完'
    },
    {
      name: '理性考据党',
      nickname: '时间线整理中',
      role: '负责把散乱爆料整理成可读的楼中楼',
      tone: '说话像写备忘录，会列编号，会提醒大家区分猜测和事实',
      secret: '容易因为过度较真被其他网友围攻'
    },
    {
      name: '情绪化路人',
      nickname: '今天也很上头',
      role: '负责把论坛气氛炒热，爱站队也爱反转',
      tone: '语气强烈，感叹号多，前后态度会随着新瓜变化',
      secret: '其实很怕自己被扒皮，所以会故意换说法'
    },
    {
      name: '圈内朋友',
      nickname: '别问我是谁',
      role: '像是认识当事人，知道细节但总是点到为止',
      tone: '含糊、暧昧、爱说“懂的都懂”',
      secret: '和某个角色关系很近，但不愿公开身份'
    }
  ];
  const picked = archetypes[seed % archetypes.length];
  const anchor = memberNames[seed % Math.max(memberNames.length, 1)] || identity?.name || '主角';
  if (els.customNpcName) els.customNpcName.value = picked.name;
  if (els.customNpcNickname) els.customNpcNickname.value = picked.nickname;
  if (els.customNpcAccount) els.customNpcAccount.value = generateForumAccount(picked.nickname);
  if (els.customNpcPersona) {
    els.customNpcPersona.value = [
      `定位：${picked.role}。`,
      `性格：谨慎但有表达欲，会观察论坛风向再下场。`,
      `说话方式：${picked.tone}。`,
      `和人物关系：主要围绕「${anchor}」发言，可能知道对方一段未公开经历。`,
      brief ? `生成依据：${brief}` : '',
      identity?.name ? `和用户身份的距离：知道「${identity.name}」在论坛里的公开人设，但不一定知道真实身份。` : '',
      `隐藏点：${picked.secret}。`
    ].filter(Boolean).join('\n');
  }
  showDynamicIsland('已生成更完整的 NPC 草稿，可继续改');
}

function addCircleEditorRow(circle = {}) {
  if (!els.circleEditor) return;
  const row = document.createElement('div');
  row.className = 'forum-circle-row';
  row.innerHTML = `
    <input data-circle-field="name" type="text" value="${escapeHTML(circle.name || '')}" placeholder="圈子名">
    <textarea data-circle-field="desc" placeholder="圈子说明，会影响这个板块出现什么内容">${escapeHTML(circle.desc || '')}</textarea>
    <button data-remove-circle type="button" title="删除圈子">×</button>
  `;
  row.querySelector('[data-remove-circle]').addEventListener('click', () => {
    row.remove();
    syncCircleRawInput();
  });
  row.querySelectorAll('input, textarea').forEach(input => input.addEventListener('input', syncCircleRawInput));
  els.circleEditor.appendChild(row);
  syncCircleRawInput();
}

function renderCircleEditor(circles = []) {
  if (!els.circleEditor) return;
  els.circleEditor.innerHTML = '';
  const list = circles.length ? circles : DEFAULT_CIRCLES;
  list.forEach(circle => addCircleEditorRow(circle));
}

function getCircleEditorValue() {
  const rows = Array.from(els.circleEditor?.querySelectorAll('.forum-circle-row') || []);
  return rows.map(row => ({
    name: row.querySelector('[data-circle-field="name"]')?.value.trim() || '',
    desc: row.querySelector('[data-circle-field="desc"]')?.value.trim() || ''
  })).filter(circle => circle.name);
}

function syncCircleRawInput() {
  if (!els.circlesInput) return;
  els.circlesInput.value = getCircleEditorValue().map(circle => `${circle.name} - ${circle.desc}`).join('\n');
}

async function generateCircleDraftFromWorkbench() {
  await generateCircleDraftsWithAI();
  return;
  const brief = els.circleAiBrief?.value.trim();
  const identity = AppState.userIdentities.find(item => item.id === draft.identityId);
  const people = getDraftPeople().map(person => person.forumName || person.name).filter(Boolean).slice(0, 5).join('、');
  const world = els.worldInput?.value.trim();
  const base = brief || world || '这个论坛世界';
  const generated = [
    { name: `${base.slice(0, 8)}热议广场`, desc: `公开讨论区，用来承接路人评价、实时热榜、争吵和突然反转。${world ? `世界观底色：${world.slice(0, 36)}。` : ''}` },
    { name: '匿名爆料树洞', desc: `适合放真假难辨的截图、朋友投稿、深夜小作文和后续澄清。${people ? `高频涉及：${people}。` : ''}` },
    { name: '关系雷达站', desc: `专门观察人物互动、站队变化、旧事时间线和网友猜测。${identity?.name ? `用户身份「${identity.name}」也会被拿来对照讨论。` : ''}` },
    { name: '考据整理楼', desc: '把分散帖子整理成时间线、证据链和疑点清单，方便后续剧情继续引用。' },
    { name: '同好产粮区', desc: '更偏轻松的二创、安利、梗图和CP/友情向讨论，用来平衡论坛里的冲突内容。' }
  ];
  renderCircleEditor(generated);
  showDynamicIsland('已生成更完整的圈子草稿，可继续改');
}

function renderMemberAccountFields() {
  if (!els.memberAccountFields) return;
  draft.members.forEach(member => ensureForumProfile(member.id, member.name));
  els.memberAccountFields.innerHTML = draft.members.map(member => {
    const profile = draft.forumProfiles?.[member.id] || {};
    const canHaveCharacterAlias = member.type === 'character';
    const aliasState = canHaveCharacterAlias ? getDraftCharacterAliasState(member.id) : null;
    return `
      <div class="forum-member-account-row" data-forum-profile-id="${member.id}">
        <div class="forum-member-account-title">
          <div class="forum-member-account-identity">
            <img src="${member.avatar || DEFAULT_AVATAR_SRC}" alt="">
            <span>${escapeHTML(member.name)}</span>
          </div>
          <label class="forum-member-verify-toggle">
            <input data-profile-field="isVerified" type="checkbox" ${profile.isVerified ? 'checked' : ''}>
            ${getForumVerifiedBadgeIconHtml(true)}
            <span>认证</span>
          </label>
        </div>
        <div class="forum-account-grid">
          <label class="forum-mini-field">
            <span>角色论坛昵称</span>
            <input data-profile-field="nickname" type="text" value="${escapeHTML(profile.nickname || '')}" placeholder="留空则使用角色昵称">
          </label>
          <label class="forum-mini-field">
            <span>角色论坛账号</span>
            <div class="forum-account-input-row">
              <input data-profile-field="account" type="text" value="${escapeHTML(profile.account || '')}" placeholder="自动生成账号">
              <button data-random-profile-account="${member.id}" type="button">随机</button>
            </div>
          </label>
          <label class="forum-mini-field">
            <span>是否为名人</span>
            <select data-profile-field="isFamous">
              <option value="no" ${profile.isFamous ? '' : 'selected'}>否</option>
              <option value="yes" ${profile.isFamous ? 'selected' : ''}>是</option>
            </select>
          </label>
          <label class="forum-mini-field">
            <span>职业身份</span>
            <input data-profile-field="occupation" type="text" value="${escapeHTML(profile.occupation || '')}" placeholder="例如：演员 / 学生 / 店主">
          </label>
          <label class="forum-mini-field">
            <span>基础粉丝量</span>
            <input data-profile-field="fans" type="number" min="0" step="1" inputmode="numeric" value="${normalizeFansCount(profile.fans) || ''}" placeholder="例如：12000">
          </label>
          <label class="forum-mini-field">
            <span>是否已关注</span>
            <select data-profile-field="isFollowed">
              <option value="yes" ${isForumProfileFollowed(profile, member) ? 'selected' : ''}>已关注</option>
              <option value="no" ${isForumProfileFollowed(profile, member) ? '' : 'selected'}>未关注</option>
            </select>
          </label>
          <label class="forum-mini-field forum-mini-field--wide">
            <span>个性签名</span>
            <textarea data-profile-field="bio" placeholder="显示在这个账号的个人主页，也会作为公开介绍给 AI 参考。">${escapeHTML(profile.bio || '')}</textarea>
          </label>
          ${canHaveCharacterAlias ? `
            <div class="forum-mini-field" style="grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; margin-top: 5px; border-top: 1px dashed #eee; padding-top: 10px; flex-direction: row;">
              <span style="white-space: nowrap;">角色小号专属头像</span>
              <label style="cursor: pointer; display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
                  <img data-profile-preview="aliasAvatar" src="${escapeHTML(profile.aliasAvatar || DEFAULT_AVATAR_SRC)}" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover;">
                  <span style="font-size: 11px; color: #666; background: #eee; padding: 2px 6px; border-radius: 4px;">点击上传</span>
                  <input type="file" data-profile-field="aliasAvatarUpload" accept="image/*" style="display: none;">
              </label>
            </div>
            <div class="forum-character-alias-editor" data-character-alias-owner="${escapeHTML(member.id)}">
              <div class="forum-character-alias-head">
                <span>角色小号</span>
                ${aliasState.aliases.length ? '<em>已设置 1 个</em>' : `<button data-add-character-alias="${escapeHTML(member.id)}" type="button">添加固定小号</button>`}
              </div>
              <p class="forum-character-alias-hint">设置后，匿名时会固定名称和头像；不设置则每帖随机。</p>
              ${aliasState.aliases.length ? aliasState.aliases.map(alias => `
                <div class="forum-character-alias-row" data-character-alias-id="${escapeHTML(alias.id)}">
                  <input data-character-alias-field="name" type="text" value="${escapeHTML(alias.name || '')}" placeholder="小号昵称">
                  <div class="forum-account-input-row">
                    <input data-character-alias-field="account" type="text" value="${escapeHTML(alias.account || '')}" placeholder="小号账号">
                    <button data-random-character-alias-account="${escapeHTML(alias.id)}" type="button">随机</button>
                  </div>
                  <textarea data-character-alias-field="bio" placeholder="小号个性签名，更偏私人表达">${escapeHTML(alias.bio || '')}</textarea>
                  <button class="forum-character-alias-delete" data-remove-character-alias="${escapeHTML(alias.id)}" type="button">删除小号</button>
                </div>
              `).join('') : ''}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
  els.memberAccountFields.querySelectorAll('input').forEach(input => {
    input.addEventListener('input', syncDraftForumProfiles);
  });
  els.memberAccountFields.querySelectorAll('select').forEach(select => {
    select.addEventListener('change', () => {
      if (select.dataset.profileField === 'isFamous' && select.value === 'yes') {
        const row = select.closest('[data-forum-profile-id]');
        const verifiedInput = row?.querySelector('[data-profile-field="isVerified"]');
        if (verifiedInput) verifiedInput.checked = true;
      }
      syncDraftForumProfiles();
    });
  });
  els.memberAccountFields.querySelectorAll('[data-profile-field="isVerified"]').forEach(input => {
    input.addEventListener('change', syncDraftForumProfiles);
  });
  els.memberAccountFields.querySelectorAll('[data-character-alias-field]').forEach(input => {
    input.addEventListener('input', syncDraftCharacterAliasesFromFields);
  });
  els.memberAccountFields.querySelectorAll('[data-add-character-alias]').forEach(btn => {
    btn.addEventListener('click', () => {
      syncDraftForumProfiles();
      syncDraftCharacterAliasesFromFields();
      const member = draft.members.find(item => item.id === btn.dataset.addCharacterAlias);
      if (!member || member.type !== 'character') return;
      const state = getDraftCharacterAliasState(member.id);
      const alias = {
        id: `char_alias_${member.id}_${Date.now()}`,
        ownerId: member.id,
        name: '',
        account: generateForumAccount(`${member.name || 'alias'}小号`),
        avatar: draft.forumProfiles?.[member.id]?.aliasAvatar || member.avatar || DEFAULT_AVATAR_SRC,
        bio: ''
      };
      state.aliases.push(alias);
      renderDraft();
    });
  });
  els.memberAccountFields.querySelectorAll('[data-remove-character-alias]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('[data-forum-profile-id]');
      const ownerId = row?.dataset.forumProfileId;
      const state = getDraftCharacterAliasState(ownerId);
      state.aliases = state.aliases.filter(alias => alias.id !== btn.dataset.removeCharacterAlias);
      if (state.currentAliasId === btn.dataset.removeCharacterAlias) state.currentAliasId = null;
      renderDraft();
    });
  });
  els.memberAccountFields.querySelectorAll('[data-random-character-alias-account]').forEach(btn => {
    btn.addEventListener('click', () => {
      const aliasRow = btn.closest('[data-character-alias-id]');
      const nameInput = aliasRow?.querySelector('[data-character-alias-field="name"]');
      const accountInput = aliasRow?.querySelector('[data-character-alias-field="account"]');
      if (!accountInput) return;
      accountInput.value = generateForumAccount(nameInput?.value.trim() || 'alias');
      syncDraftCharacterAliasesFromFields();
    });
  });
  els.memberAccountFields.querySelectorAll('[data-random-profile-account]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('[data-forum-profile-id]');
      const member = draft.members.find(item => item.id === btn.dataset.randomProfileAccount);
      const input = row?.querySelector('[data-profile-field="account"]');
      if (!member || !input) return;
      input.value = generateForumAccount(member.name);
      syncDraftForumProfiles();
    });
  });
  els.memberAccountFields.querySelectorAll('[data-profile-field="aliasAvatarUpload"]').forEach(input => {
    input.addEventListener('click', () => {
      input.value = '';
    });
    input.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!file.type?.startsWith('image/')) {
        showDynamicIsland('请选择图片文件');
        input.value = '';
        return;
      }
      const row = input.closest('[data-forum-profile-id]');
      const id = row?.dataset.forumProfileId;
      if (!id) return;
      const avatarUrl = await compressForumImage(file); // 直接调用现成的图片压缩工具
      if (!avatarUrl || avatarUrl === DEFAULT_AVATAR_SRC) {
        showDynamicIsland('头像读取失败，请换一张图试试');
        input.value = '';
        return;
      }
      if (!draft.forumProfiles[id]) draft.forumProfiles[id] = {};
      draft.forumProfiles[id].aliasAvatar = avatarUrl;
      const aliasState = getDraftCharacterAliasState(id);
      aliasState.aliases.forEach(alias => {
        alias.avatar = avatarUrl;
      });
      const img = row.querySelector('[data-profile-preview="aliasAvatar"]');
      if (img) img.src = avatarUrl;
      syncDraftForumProfiles();
      input.value = '';
    });
  });
}

function syncDraftCharacterAliasesFromFields() {
  if (!els.memberAccountFields) return;
  els.memberAccountFields.querySelectorAll('[data-forum-profile-id]').forEach(row => {
    const ownerId = row.dataset.forumProfileId;
    const state = getDraftCharacterAliasState(ownerId);
    const existingById = new Map(state.aliases.map(alias => [alias.id, alias]));
    state.aliases = [...row.querySelectorAll('[data-character-alias-id]')].map(aliasRow => {
      const id = aliasRow.dataset.characterAliasId;
      const current = existingById.get(id) || {};
      return {
        ...current,
        id,
        ownerId,
        name: aliasRow.querySelector('[data-character-alias-field="name"]')?.value.trim() || '',
        account: aliasRow.querySelector('[data-character-alias-field="account"]')?.value.trim() || '',
        bio: aliasRow.querySelector('[data-character-alias-field="bio"]')?.value.trim() || '',
        avatar: draft.forumProfiles?.[ownerId]?.aliasAvatar || current.avatar || draft.members.find(member => member.id === ownerId)?.avatar || DEFAULT_AVATAR_SRC,
        fans: normalizeFansCount(current.fans),
        followingCount: normalizeFansCount(current.followingCount)
      };
    });
    if (state.currentAliasId && !state.aliases.some(alias => alias.id === state.currentAliasId)) {
      state.currentAliasId = null;
    }
  });
}

function normalizeForumWorldBookIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(id => String(id)).filter(Boolean))];
}

function normalizeForumMemberWorldBookIds(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).map(([memberId, ids]) => [memberId, normalizeForumWorldBookIds(ids)]));
}

function getForumMainMemberIds(members = []) {
  return new Set(members.filter(member => member?.id && !isForumTemporaryOrdinaryMember(member)).map(member => member.id));
}

function filterForumMainMemberWorldBooks(source = {}, members = []) {
  const mainMemberIds = getForumMainMemberIds(members);
  return Object.fromEntries(Object.entries(source || {}).filter(([memberId]) => mainMemberIds.has(memberId)));
}

function getForumCheckedWorldBookIds(root) {
  return Array.from(root?.querySelectorAll('[data-forum-worldbook-id]:checked') || []).map(input => input.value);
}

function syncForumWorldBooks() {
  if (els.worldBookInput?.querySelector('[data-forum-worldbook-id]')) {
    draft.worldBookEntryIds = getForumCheckedWorldBookIds(els.worldBookInput);
  }
  const mainMemberIds = getForumMainMemberIds(draft.members);
  const memberBlocks = Array.from(els.memberWorldBookFields?.querySelectorAll('[data-member-worldbook-scope]') || []);
  if (!mainMemberIds.size) {
    draft.memberWorldBookEntryIds = {};
    return;
  }
  if (!memberBlocks.length) return;
  draft.memberWorldBookEntryIds = {};
  memberBlocks.forEach(block => {
    const memberId = block.dataset.memberWorldbookScope;
    if (!mainMemberIds.has(memberId)) return;
    const ids = getForumCheckedWorldBookIds(block);
    if (ids.length) draft.memberWorldBookEntryIds[memberId] = ids;
  });
}

async function getForumWorldBookOptions() {
  if (!db?.worldBookEntries) return [];
  const entries = await db.worldBookEntries.toArray();
  return entries
    .filter(entry => entry && (entry.title || entry.content))
    .sort((a, b) => {
      const groupA = a.category || '默认';
      const groupB = b.category || '默认';
      if (groupA !== groupB) return groupA.localeCompare(groupB, 'zh-CN');
      return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN');
    });
}

function renderForumWorldBookSelectList(entries, selectedIds = [], emptyText = '世界书库里还没有可选择的世界书。') {
  const selectedSet = new Set(normalizeForumWorldBookIds(selectedIds));
  if (!entries.length) return `<p class="forum-empty">${escapeHTML(emptyText)}</p>`;
  const groups = entries.reduce((acc, entry) => {
    const category = entry.category || '默认';
    if (!acc[category]) acc[category] = [];
    acc[category].push(entry);
    return acc;
  }, {});
  return Object.entries(groups).map(([category, groupEntries]) => `
    <div class="forum-worldbook-group">
      <div class="forum-worldbook-group-title">
        <span>${escapeHTML(category)}</span>
        <small>${groupEntries.length} 条</small>
      </div>
      <div class="forum-worldbook-group-list">
        ${groupEntries.map(entry => {
          const id = String(entry.id);
          const preview = String(entry.content || '').replace(/\s+/g, ' ').slice(0, 54);
          return `
            <label class="forum-worldbook-option">
              <input data-forum-worldbook-id type="checkbox" value="${escapeHTML(id)}" ${selectedSet.has(id) ? 'checked' : ''}>
              <span>
                <b>${escapeHTML(entry.title || '未命名世界书')}</b>
                ${preview ? `<small>${escapeHTML(preview)}</small>` : '<small>暂无内容预览</small>'}
              </span>
            </label>
          `;
        }).join('')}
      </div>
    </div>
  `).join('');
}

function bindForumWorldBookCheckboxes(root) {
  root?.querySelectorAll('[data-forum-worldbook-id]').forEach(input => {
    input.addEventListener('change', () => {
      syncForumWorldBooks();
      updateForumMemberWorldBookCounts(root);
    });
  });
}

function updateForumMemberWorldBookCounts(root) {
  root?.querySelectorAll('.forum-member-worldbook-card').forEach(card => {
    const countEl = card.querySelector('[data-member-worldbook-count]');
    const count = card.querySelectorAll('[data-forum-worldbook-id]:checked').length;
    if (countEl) countEl.textContent = `私有世界书 · 已选 ${count} 条`;
  });
}

function renderForumWorldBookSelectors() {
  const token = ++worldBookRenderToken;
  if (els.worldBookInput) els.worldBookInput.innerHTML = '<p class="forum-empty">正在读取世界书库...</p>';
  if (els.memberWorldBookFields) els.memberWorldBookFields.innerHTML = '<p class="forum-empty">正在读取世界书库...</p>';
  getForumWorldBookOptions().then(entries => {
    if (token !== worldBookRenderToken) return;
    if (els.worldBookInput) {
      els.worldBookInput.innerHTML = renderForumWorldBookSelectList(entries, draft.worldBookEntryIds);
      bindForumWorldBookCheckboxes(els.worldBookInput);
    }
    if (!els.memberWorldBookFields) return;
    const memberSelections = normalizeForumMemberWorldBookIds(draft.memberWorldBookEntryIds);
    const mainMemberIds = getForumMainMemberIds(draft.members);
    const mainMembers = draft.members.filter(member => mainMemberIds.has(member.id));
    els.memberWorldBookFields.innerHTML = mainMembers.length ? mainMembers.map((member, index) => `
      <details class="forum-member-worldbook-card" ${index === 0 ? 'open' : ''}>
        <summary>
          <img src="${member.avatar || DEFAULT_AVATAR_SRC}" alt="">
          <span>
            <b>${escapeHTML(member.name)}</b>
            <small data-member-worldbook-count>私有世界书 · 已选 ${(memberSelections[member.id] || []).length} 条</small>
          </span>
          <em>配置</em>
        </summary>
        <div class="forum-worldbook-select-list" data-member-worldbook-scope="${escapeHTML(member.id)}">
          ${renderForumWorldBookSelectList(entries, memberSelections[member.id] || [], '世界书库里还没有可选择的世界书。')}
        </div>
      </details>
    `).join('') : '<p class="forum-empty">选择主要角色或主要 NPC 后，可以给每个人单独选择只属于他的世界书。</p>';
    bindForumWorldBookCheckboxes(els.memberWorldBookFields);
  }).catch(error => {
    console.error('读取论坛世界书失败:', error);
    if (token !== worldBookRenderToken) return;
    if (els.worldBookInput) els.worldBookInput.innerHTML = '<p class="forum-empty">世界书读取失败，请稍后重试。</p>';
    if (els.memberWorldBookFields) els.memberWorldBookFields.innerHTML = '<p class="forum-empty">世界书读取失败，请稍后重试。</p>';
  });
}

function toDexieWorldBookId(id) {
  const numericId = Number(id);
  return Number.isFinite(numericId) && String(numericId) === String(id) ? numericId : id;
}

async function buildForumWorldBookText(ids = []) {
  const cleanIds = normalizeForumWorldBookIds(ids);
  if (!cleanIds.length || !db?.worldBookEntries) return '';
  const entries = await db.worldBookEntries.bulkGet(cleanIds.map(toDexieWorldBookId));
  return formatForumWorldBookText(entries);
}

function formatForumWorldBookText(entries = []) {
  return entries
    .filter(Boolean)
    .map(entry => {
      const title = entry.title || '未命名世界书';
      const category = entry.category || '默认';
      return `【${category} / ${title}】\n${entry.content || ''}`.trim();
    })
    .filter(Boolean)
    .join('\n\n');
}

async function hydrateDraftWorldBooks() {
  draft.memberWorldBooks = filterForumMainMemberWorldBooks({
    ...(draft.legacyMemberWorldBooks || {}),
    ...(draft.memberWorldBooks || {})
  }, draft.members);
  const mainMemberIds = getForumMainMemberIds(draft.members);
  const memberIds = Object.keys(draft.memberWorldBookEntryIds || {}).filter(memberId => mainMemberIds.has(memberId));
  const allEntryIds = normalizeForumWorldBookIds([
    ...draft.worldBookEntryIds,
    ...memberIds.flatMap(memberId => draft.memberWorldBookEntryIds[memberId] || [])
  ]);
  const entries = allEntryIds.length && db?.worldBookEntries
    ? await db.worldBookEntries.bulkGet(allEntryIds.map(toDexieWorldBookId))
    : [];
  const entriesById = new Map(entries.filter(Boolean).map(entry => [String(entry.id), entry]));
  const getTextByIds = ids => formatForumWorldBookText(
    normalizeForumWorldBookIds(ids).map(id => entriesById.get(String(id)))
  );
  draft.worldBook = draft.worldBookEntryIds.length
    ? getTextByIds(draft.worldBookEntryIds)
    : (draft.legacyWorldBookText || '');
  memberIds.forEach(memberId => {
    const text = getTextByIds(draft.memberWorldBookEntryIds[memberId]);
    if (text) draft.memberWorldBooks[memberId] = text;
  });
}

async function getForumWorldBookEntriesByIds(ids = []) {
  const cleanIds = normalizeForumWorldBookIds(ids);
  if (!cleanIds.length || !db?.worldBookEntries) return [];
  const entries = await db.worldBookEntries.bulkGet(cleanIds.map(toDexieWorldBookId));
  return entries.filter(Boolean);
}

async function getForumGlobalWorldBookEntries() {
  if (!db?.worldBookEntries) return [];
  return db.worldBookEntries.where('category').equals('全局世界书').toArray();
}

function uniqueForumWorldBookEntries(entries = []) {
  const seen = new Set();
  return entries.filter(entry => {
    if (!entry) return false;
    const id = String(entry.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function formatForumWorldBookEntries(entries = []) {
  return entries
    .map(entry => {
      const title = entry.title || '未命名世界书';
      const category = entry.category || '默认';
      return `【${category} / ${title}】\n${entry.content || ''}`.trim();
    })
    .filter(Boolean)
    .join('\n\n');
}

function getForumWorldBookLogName(space, memberId) {
  if (!memberId) return '公共';
  const member = (space?.members || []).find(item => item.id === memberId);
  return member ? getForumDisplayName(space, member.id, member.name) : memberId;
}

function summarizeForumWorldBookLogEntries(entries = []) {
  return entries.map(entry => ({
    id: String(entry.id),
    title: entry.title || '未命名世界书',
    category: entry.category || '默认'
  }));
}

async function pushForumWorldBookCallLog(space, label, worldBookData) {
  if (!space) return;
  const privateLogs = Object.entries(worldBookData.privateEntriesByMember || {})
    .filter(([, entries]) => entries.length)
    .map(([memberId, entries]) => ({
      memberId,
      memberName: getForumWorldBookLogName(space, memberId),
      entries: summarizeForumWorldBookLogEntries(entries)
    }));
  const log = {
    time: Date.now(),
    label: label || 'AI 调用',
    publicEntries: summarizeForumWorldBookLogEntries(worldBookData.publicEntries || []),
    privateLogs
  };
  space.worldBookCallLogs = Array.isArray(space.worldBookCallLogs) ? space.worldBookCallLogs : [];
  space.worldBookCallLogs.push(log);
  space.worldBookCallLogs = space.worldBookCallLogs.slice(-FORUM_WORLD_BOOK_LOG_LIMIT);
  console.groupCollapsed(`[论坛世界书调用] ${space.name || '未命名论坛'} / ${log.label}`);
  console.log('公共世界书:', log.publicEntries.length ? log.publicEntries : '无');
  console.log('角色私有世界书:', log.privateLogs.length ? log.privateLogs : '无');
  console.groupEnd();
  renderForumWorldBookCallLogs(space);
  await saveState();
}

async function resolveForumWorldBookPromptData(space, options = {}) {
  const selectedPublicEntries = await getForumWorldBookEntriesByIds(space?.worldBookEntryIds || []);
  const globalEntries = await getForumGlobalWorldBookEntries();
  const publicEntries = uniqueForumWorldBookEntries([...globalEntries, ...selectedPublicEntries]);
  const privateEntriesByMember = {};
  const privateTexts = {};
  const mainMemberIds = getForumMainMemberIds(space?.members || []);
  const privateMemberIds = [...new Set(options.privateMemberIds || [])]
    .filter(memberId => mainMemberIds.has(memberId));
  await Promise.all(privateMemberIds.map(async memberId => {
    const entries = uniqueForumWorldBookEntries(
      await getForumWorldBookEntriesByIds(space?.memberWorldBookEntryIds?.[memberId] || [])
    );
    privateEntriesByMember[memberId] = entries;
    privateTexts[memberId] = entries.length
      ? formatForumWorldBookEntries(entries)
      : String(space?.memberWorldBooks?.[memberId] || '').trim();
  }));
  const publicText = publicEntries.length
    ? formatForumWorldBookEntries(publicEntries)
    : String(space?.worldBook || '').trim();
  const data = { publicEntries, publicText, privateEntriesByMember, privateTexts };
  if (options.log !== false) await pushForumWorldBookCallLog(space, options.label, data);
  return data;
}

function renderForumWorldBookCallLogs(space, options = {}) {
  const listEl = document.getElementById('forum-worldbook-log-list');
  const countEl = document.getElementById('forum-worldbook-log-count');
  if (!listEl && !countEl) return;
  const logs = Array.isArray(space?.worldBookCallLogs) ? [...space.worldBookCallLogs].reverse() : [];
  const renderKey = `${space?.id || 'space'}:${logs.length}:${logs.map(log => `${log.time || ''}:${log.label || ''}`).join('|')}`;
  if (!options.force && forumWorldBookLogRenderKey === renderKey) return;
  forumWorldBookLogRenderKey = renderKey;
  if (countEl) countEl.textContent = `${logs.length}`;
  if (!listEl) return;
  if (!logs.length) {
    listEl.innerHTML = '<p class="forum-empty">还没有世界书调用记录。</p>';
    return;
  }
  listEl.innerHTML = logs.slice(0, 8).map(log => {
    const publicText = log.publicEntries?.length
      ? log.publicEntries.map(entry => `公共：${entry.title} #${entry.id}`).join('；')
      : '公共：无';
    const privateText = log.privateLogs?.length
      ? log.privateLogs.map(item => `${item.memberName}：${item.entries.map(entry => `${entry.title} #${entry.id}`).join('、')}`).join('；')
      : '私有：无';
    return `
      <div class="forum-worldbook-log-item">
        <div class="forum-worldbook-log-head">
          <b>${escapeHTML(log.label || 'AI 调用')}</b>
          <span>${escapeHTML(formatForumProfileDate(log.time))}</span>
        </div>
        <p>${escapeHTML(publicText)}</p>
        <p>${escapeHTML(privateText)}</p>
      </div>
    `;
  }).join('');
}

function openRelationCreator() {
  syncDraftForumProfiles();
  const people = getDraftPeople();
  if (people.length < 2) {
    showDynamicIsland('至少需要两个人物');
    return;
  }
  const options = people.map(person => `<option value="${person.id}">${escapeHTML(person.forumName || person.name)}</option>`).join('');
  openSheet('添加关系', `
    <div class="forum-relation-form">
      <select id="forum-rel-from">${options}</select>
      <input id="forum-rel-text" type="text" placeholder="关系，例如：情侣 / 队友 / 黑粉 / 前同事">
      <select id="forum-rel-to">${options}</select>
      <div class="forum-direction-toggle">
        <button class="active" data-direction="one-way" type="button">单向</button>
        <button data-direction="mutual" type="button">双向</button>
      </div>
      <button class="forum-primary-btn" id="forum-rel-save" type="button">保存关系</button>
    </div>
  `, root => {
    let direction = 'one-way';
    root.querySelector('.forum-direction-toggle').addEventListener('click', e => {
      const btn = e.target.closest('[data-direction]');
      if (!btn) return;
      direction = btn.dataset.direction;
      root.querySelectorAll('[data-direction]').forEach(item => item.classList.toggle('active', item === btn));
    });
    root.querySelector('#forum-rel-save').addEventListener('click', () => {
      const from = root.querySelector('#forum-rel-from').value;
      const to = root.querySelector('#forum-rel-to').value;
      const label = root.querySelector('#forum-rel-text').value.trim();
      if (!label || from === to) return;
      draft.relations.push({ id: `rel_${Date.now()}`, from, to, label, direction });
      closeModal();
      renderDraft();
    });
  });
}

function getDraftPeople() {
  const identity = AppState.userIdentities.find(item => item.id === draft.identityId);
  return [
    identity && decorateForumPerson({ id: `user_${identity.id}`, name: identity.name, avatar: identity.avatar || DEFAULT_AVATAR_SRC, type: 'user' }, draft),
    ...draft.members.map(member => decorateForumPerson(member, draft))
  ].filter(Boolean);
}

function renderNetwork(source) {
  const identity = AppState.userIdentities.find(item => item.id === source.identityId);
  const people = [
    identity && decorateForumPerson({ id: `user_${identity.id}`, name: identity.name, avatar: identity.avatar || DEFAULT_AVATAR_SRC, type: 'user' }, source),
    ...(source.members || []).map(member => decorateForumPerson(member, source))
  ].filter(Boolean);
  const positions = getNetworkPositions(people);
  const relationLines = (source.relations || []).map(rel => {
    const from = positions.get(rel.from);
    const to = positions.get(rel.to);
    if (!from || !to) return '';
    const line = getNetworkLinePoints(from, to);
    const reverseLine = getNetworkLinePoints(to, from);
    const labelX = (from.x + to.x) / 2;
    const labelY = Math.max(16, Math.min(82, (from.y + to.y) / 2 - 6));
    return `
      <svg class="forum-network-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <marker id="forum-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="#111"></path>
          </marker>
        </defs>
        <line x1="${line.x1}" y1="${line.y1}" x2="${line.x2}" y2="${line.y2}" marker-end="url(#forum-arrow)"></line>
        ${rel.direction === 'mutual' ? `<line x1="${reverseLine.x1}" y1="${reverseLine.y1}" x2="${reverseLine.x2}" y2="${reverseLine.y2}" marker-end="url(#forum-arrow)" class="mutual"></line>` : ''}
      </svg>
      <span class="forum-network-label" style="left:${labelX}%; top:${labelY}%;">${escapeHTML(rel.label)}</span>
    `;
  }).join('');
  els.relationNetwork.innerHTML = people.length ? `
    ${relationLines}
    ${people.map((person, index) => {
      const pos = positions.get(person.id);
      return `<div class="forum-network-node" style="left:${pos.x}%; top:${pos.y}%;" title="${escapeHTML(person.name)}">
        <img src="${person.avatar || DEFAULT_AVATAR_SRC}" alt="">
        <span>${escapeHTML(person.forumName || person.name)}</span>
      </div>`;
    }).join('')}
  ` : '<p class="forum-empty">选择身份和角色后生成关系网</p>';
  els.relationList.innerHTML = (source.relations || []).map((rel, index) => {
    const fromPerson = people.find(p => p.id === rel.from);
    const toPerson = people.find(p => p.id === rel.to);
    const from = fromPerson?.forumName || fromPerson?.name || '未知';
    const to = toPerson?.forumName || toPerson?.name || '未知';
    const arrow = rel.direction === 'mutual' ? '↔' : '→';
    return `<div class="forum-relation-item" style="grid-template-columns: minmax(0, 1fr) auto 18px minmax(0, 1fr) 24px;"><span>${escapeHTML(from)}</span><em>${escapeHTML(rel.label)}</em><span class="forum-relation-arrow" aria-hidden="true">${arrow}</span><span>${escapeHTML(to)}</span><button class="forum-chip-action danger" data-remove-relation-index="${index}" type="button" title="删除关系" aria-label="删除关系">×</button></div>`;
  }).join('');
}

function getNetworkLinePoints(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.sqrt(dx * dx + dy * dy) || 1;
  const offset = 8;
  const ux = dx / length;
  const uy = dy / length;
  return {
    x1: from.x + ux * offset,
    y1: from.y + uy * offset,
    x2: to.x - ux * offset,
    y2: to.y - uy * offset
  };
}

function decorateForumPerson(person, source) {
  const profile = source.forumProfiles?.[person.id] || {};
  return {
    ...person,
    forumName: profile.nickname || person.name,
    forumAccount: profile.account || profile.nickname || person.name,
    avatar: profile.avatar || person.avatar,
    bio: profile.bio || person.bio || '',
    isFamous: Boolean(profile.isFamous || person.isFamous),
    occupation: profile.occupation || person.occupation || '',
    fans: normalizeFansCount(profile.fans ?? person.fans),
    isFollowed: isForumProfileFollowed(profile, person)
  };
}
function getForumPeopleForPrompt(space, viewerMember = null) {
  if (!space) return '';
  const identity = currentIdentity();
  const rosterCurrentUser = getCurrentForumUser(space);
  const rosterHideRealName = Boolean(rosterCurrentUser?.isAlias)
    && !(viewerMember && isForumUserAliasKnownToMember(space, getCurrentAlias(space), viewerMember));
  const userId = `user_${identity?.id}`;
  const userProfile = space.forumProfiles?.[userId] || {};
  const people = [
     identity && {
      id: userId,
      name: getForumDisplayName(space, userId, identity.name),
      account: getForumAccount(space, userId, identity.name),
      realName: rosterHideRealName ? '' : (identity.name || ''),
      type: '用户',
      isFamous: Boolean(userProfile.isFamous),
      occupation: userProfile.occupation || '',
      fans: normalizeFansCount(userProfile.fans),
      bio: userProfile.bio || ''
    },
    ...(space.members || []).filter(member => !isForumTemporaryOrdinaryMember(member)).map(member => {
      const profile = space.forumProfiles?.[member.id] || {};
      return {
        id: member.id,
        name: getForumDisplayName(space, member.id, member.name),
        account: getForumAccount(space, member.id, member.name),
        realName: member.name || '',
        type: member.type || '角色',
        isFamous: Boolean(profile.isFamous || member.isFamous),
        occupation: profile.occupation || member.occupation || '',
        fans: normalizeFansCount(profile.fans ?? member.fans),
        bio: profile.bio || '',
        aliases: getForumCharacterAliasState(space, member.id).aliases || [],
        persona: member.persona || member.meta || '',
        isVerified: Boolean(profile.isVerified)
      };
    })
  ].filter(Boolean);
  return people.map(person => [
    `- ${person.name} (@${person.account})`,
    `类型：${person.type}`,
    `是否名人：${person.isFamous ? '是' : '否'}`,
    `职业身份：${person.occupation || '未设置'}`,
    `基础粉丝量：${person.fans || 0}`,
    person.realName && person.realName !== person.name ? `本名/熟人称呼：${person.realName}（这个名字只有认识这个人的角色和主要NPC才知道，路人不知道）` : '',
    person.bio ? `个性签名：${person.bio}` : '',
    person.aliases?.length ? `固定小号：${person.aliases.map(alias => `${alias.name}(@${alias.account})`).join('、')}` : '',
    person.persona ? `设定：${person.persona}` : ''
  ].filter(Boolean).join('；')).join('\n');
}

function getForumCharacterFixedAlias(space, memberId) {
  const state = getForumCharacterAliasState(space, memberId);
  const aliases = state.aliases || [];
  return aliases.find(alias => alias.id === state.currentAliasId) || aliases[0] || null;
}

function findForumFixedAliasByInput(space, { rawName = '', realName = '', explicitId = '' } = {}) {
  const rawKey = normalizeForumAccountKey(rawName);
  const realKey = normalizeForumAccountKey(realName);
  const explicitKey = normalizeForumAccountKey(explicitId);
  for (const member of (space?.members || [])) {
    const displayName = getForumDisplayName(space, member.id, member.name);
    const memberMatches = realKey && [displayName, member.name, member.id]
      .some(value => normalizeForumAccountKey(value) === realKey);
    const explicitMemberMatches = explicitKey && normalizeForumAccountKey(member.id) === explicitKey;
    const fixedAlias = getForumCharacterFixedAlias(space, member.id);
    if (!fixedAlias) {
      if (memberMatches || explicitMemberMatches) return { owner: member, alias: null };
      continue;
    }
    const aliasMatches = [fixedAlias.id, fixedAlias.name, fixedAlias.account]
      .some(value => {
        const key = normalizeForumAccountKey(value);
        return key && (key === rawKey || key === explicitKey);
      });
    if (memberMatches || explicitMemberMatches || aliasMatches) return { owner: member, alias: fixedAlias };
  }
  return null;
}

function getForumVirtualAliasId(ownerId) {
  return `char_alias_virtual_${ownerId}`;
}

function findExistingForumVirtualAliasProfile(space, ownerId) {
  const canonicalId = getForumVirtualAliasId(ownerId);
  if (space?.forumProfiles?.[canonicalId]?.isAlias
    && String(space.forumProfiles[canonicalId].sourceCharacterId || '') === String(ownerId)) {
    return canonicalId;
  }
  return Object.entries(space?.forumProfiles || {}).find(([profileId, profile]) => (
    String(profileId).startsWith(`char_alias_virtual_${ownerId}_`)
    && profile?.isAlias
    && String(profile.sourceCharacterId || '') === String(ownerId)
  ))?.[0] || '';
}

function findForumDmAliasAccount(space, aliasId) {
  const fixedAlias = findForumCharacterAlias(space, aliasId);
  if (fixedAlias) return { ...fixedAlias, isVirtual: false };
  const profile = space?.forumProfiles?.[aliasId];
  const ownerId = profile?.isAlias ? profile.sourceCharacterId : null;
  if (!ownerId) return null;
  const owner = (space?.members || []).find(member => String(member.id) === String(ownerId));
  if (!owner) return null;
  return {
    ownerId,
    alias: {
      id: aliasId,
      name: profile.nickname || '匿名小号',
      account: profile.account || generateForumAccount(profile.nickname || '匿名小号'),
      avatar: profile.avatar || space?.forumProfiles?.[ownerId]?.aliasAvatar || dicebearAvatar(profile.nickname || '匿名小号'),
      bio: profile.bio || '',
      isVirtual: true
    },
    isVirtual: true
  };
}

function ensureForumVirtualAliasProfile(space, owner, aliasName) {
  if (!space || !owner) return null;
  space.forumProfiles = space.forumProfiles && typeof space.forumProfiles === 'object' ? space.forumProfiles : {};
  const id = findExistingForumVirtualAliasProfile(space, owner.id) || getForumVirtualAliasId(owner.id);
  const existingProfile = space.forumProfiles[id] || {};
  const name = existingProfile.nickname || String(aliasName || '').trim() || `${getForumDisplayName(space, owner.id, owner.name)}的小号`;
  const ownerProfile = space.forumProfiles?.[owner.id] || {};
  const avatar = ownerProfile.aliasAvatar || existingProfile.avatar || dicebearAvatar(name);
  space.forumProfiles[id] = {
    ...existingProfile,
    nickname: name,
    account: existingProfile.account || generateForumAccount(name),
    avatar,
    bio: existingProfile.bio || '角色临时小号。',
    isAlias: true,
    sourceCharacterId: owner.id,
    isFollowed: true
  };
  return { id, name, account: space.forumProfiles[id].account, avatar };
}

function getForumVerifiedBadgeIconHtml(isHidden = false) {
  const ariaText = isHidden ? 'aria-hidden="true"' : 'aria-label="已认证"';
  return `<span class="forum-verified-badge" ${ariaText}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.8 12.4l2.6 2.7 5.8-6.2"></path></svg></span>`;
}

function renderForumVerifiedBadge(space, profileId) {
  const alias = findForumCharacterAlias(space, profileId);
  if (alias) return '';
  const resolvedProfileId = alias?.ownerId || profileId;
  const profile = space?.forumProfiles?.[resolvedProfileId] || {};
  return profile.isVerified ? getForumVerifiedBadgeIconHtml() : '';
}

function buildForumFixedAliasRule(space, members = []) {
  const lines = (members || [])
    .filter(member => member?.type === 'character')
    .map(member => {
      const alias = getForumCharacterFixedAlias(space, member.id);
      if (!alias) return '';
      const displayName = getForumDisplayName(space, member.id, member.name);
      return `- ${displayName}: fixed alias speaker="${alias.name}", account="@${alias.account}", bio="${alias.bio || '无'}"`;
    })
    .filter(Boolean);
  if (!lines.length) return '';
  return `[FIXED CHARACTER ALIASES — obey strictly]
The following character aliases are pre-created by the user and must stay consistent across posts. If one of these people uses identity="alias", you MUST use the fixed speaker name below. Do NOT invent a new alias for them.
${lines.join('\n')}
[ALIAS IDENTITY SECRECY — absolute rule, top priority]
The alias-to-character mappings listed above are SYSTEM METADATA for the generation engine ONLY. In the public comment section and in any generated dmHints, ordinary passers, ordinary NPCs, and even OTHER core characters / main NPCs do NOT know which alias belongs to which character. They MUST treat every alias comment as if it came from a completely unknown, ordinary netizen whose real identity is a total mystery. STRICTLY FORBIDDEN: no commenter may say, guess, hint, imply, tease, insinuate, or react as if they recognize an alias's real identity — no "isn't this XX's alt?", no "this sounds like XX", no "this writing style is so familiar", no knowing winks, no inside jokes that only work if you know the owner, no @-ing the alias as if you know who they really are. This also extends to dmHints: an NPC or passer who does not know the alias must NOT privately message the user saying "I think that account is XX's alt" or anything similar. The ONLY exception: the character behind the alias themselves EXPLICITLY states in a public comment something like "I am XX / this is my alt / 这是我小号 / 其实我就是XX" — ONLY AFTER that public self-reveal may OTHER commenters begin to acknowledge or discuss that alias's real identity in subsequent comments. Until that moment, the alias is an anonymous stranger to absolutely everyone except the character themselves.`;
}
async function getForumGenerationContext(space, actorId = null, label = '论坛 AI 调用', viewerMember = null) {
  const worldBookData = await resolveForumWorldBookPromptData(space, {
    label,
    privateMemberIds: actorId ? [actorId] : []
  });
  return [
    `[论坛方案] ${space?.name || '未命名方案'}`,
    `[世界观] ${space?.world || '无'}`,
    worldBookData.publicText ? `[公共世界书]\n${worldBookData.publicText}` : '',
    actorId && worldBookData.privateTexts?.[actorId] ? `[当前角色私有世界书]\n${worldBookData.privateTexts[actorId]}` : '',
    '[论坛主要人物]',
    getForumPeopleForPrompt(space, viewerMember) || '暂无',
    `[关系状态] ${formatCoupleLine(space)}`
  ].filter(Boolean).join('\n');
}

function describeForumMediaForAI(media = [], options = {}) {
  if (!Array.isArray(media) || !media.length) return '';
  let realImageCount = 0;
  return media.map((item, index) => {
    if (item.type === 'real-image') {
      realImageCount += 1;
      const visionNote = options.includeVisionNote ? `（Image ${realImageCount} 已作为视觉附件发送，请以实际画面为准）` : '';
      return `${index + 1}. 真实图片：${item.alt || '用户上传图片'}${visionNote}`;
    }
    if (item.type === 'sticker') return `${index + 1}. 表情包：${item.explanation || '表情'}`;
    if (item.type === 'fake-image') return `${index + 1}. 文字假图：${item.text || ''}`;
      if (item.type === 'slides-video') {
      const ranges = getForumShortVideoTimeRanges(item);
      const totalSec = getForumShortVideoTotalSeconds(item);
      const fmtSec = sec => `[${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}]`;
      return `${index + 1}. 文字短视频（全片共 ${totalSec} 秒；下面每页都标了它对应的时间戳区间，引用时间点必须直接用方括号 [mm:ss] 格式，且必须落在下面列出的真实区间里，绝对不能超过 ${totalSec} 秒，也不能跳到不属于那页的时间）：${(item.slides || []).map((slide, i) => {
        const r = ranges[i];
        const tag = r ? (r.start === r.end ? fmtSec(r.start) : `${fmtSec(r.start)}~${fmtSec(r.end)}`) : '';
        return `${tag} ${slide}`;
      }).join(' / ')}`;
    }
    if (item.type === 'music') {
      const song = item.song || {};
      const extras = [
        song.album ? `专辑：${song.album}` : '',
        song.src ? '含可播放音频源' : '',
        song.lyric ? '含歌词文本，可参考歌曲氛围但不要复述歌词' : ''
      ].filter(Boolean).join('；');
      return `${index + 1}. 音乐：${song.title || '未知歌曲'} - ${song.artist || '未知歌手'}${extras ? `（${extras}）` : ''}`;
    }
    if (item.type === 'video') return `${index + 1}. 视频：${item.url || '视频文件'}`;
    return `${index + 1}. 媒体：${item.type || '未知'}`;
  }).join('\n');
}

function buildForumCommentAIContent(prompt, media = []) {
  const realImages = Array.isArray(media)
    ? media.filter(item => item?.type === 'real-image' && item.url).slice(0, 4)
    : [];
  if (!realImages.length) return prompt;
  return [
    { type: 'text', text: prompt },
    ...realImages.map(item => ({
      type: 'image_url',
      image_url: { url: item.url }
    }))
  ];
}
async function sendForumCommentPromptToAI(prompt, media = [], signal = null) {
  const apiSettings = AppState.apiCurrentSettings;
  if (!apiSettings || !apiSettings.key) {
    throw new Error('API key not set.');
  }
  const content = buildForumCommentAIContent(prompt, media);
 let response;
  try {
    response = await fetch(`${apiSettings.url.trim().replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiSettings.key}`
      },
      body: JSON.stringify({
        model: apiSettings.model,
        messages: [{ role: 'user', content }],
        temperature: 0.5,
        stream: false
      })
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      const abortErr = new Error('AbortError');
      abortErr.name = 'AbortError';
      throw abortErr; // 包装成普通Error抛出，避免浏览器底层DOMException红字警报
    }
    throw err;
  }
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new Error(`Forum comment request failed: ${errorData.error?.message || response.statusText}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

function getNetworkPositions(people) {
  const map = new Map();
  const presets = [
    [50, 20], [22, 44], [78, 44], [34, 70], [66, 70], [50, 52], [18, 72], [82, 72]
  ];
  people.forEach((person, index) => {
    const preset = presets[index];
    if (preset) map.set(person.id, { x: preset[0], y: preset[1] });
    else {
      const angle = (Math.PI * 2 * index) / people.length - Math.PI / 2;
      map.set(person.id, { x: 50 + Math.cos(angle) * 34, y: 50 + Math.sin(angle) * 34 });
    }
  });
  return map;
}

async function createSpace() {
  const title = els.titleInput.value.trim();
  if (!title) return showDynamicIsland('请填写方案名字');
  const identity = AppState.userIdentities.find(item => item.id === draft.identityId);
  if (!identity) return showDynamicIsland('请选择用户身份');
  if (forumSpaceSaveInProgress) return;
  forumSpaceSaveInProgress = true;
  if (els.createSpaceBtn) {
    els.createSpaceBtn.disabled = true;
    els.createSpaceBtn.setAttribute('aria-busy', 'true');
  }
  try {
  syncDraftForumProfiles();
  syncDraftCharacterAliasesFromFields();
  syncForumWorldBooks();
  await hydrateDraftWorldBooks();
  const circles = getCircleEditorValue().length ? getCircleEditorValue() : parseCircles(els.circlesInput.value);
  const userProfile = draft.forumProfiles[`user_${identity.id}`] || {};
  const forumIdentity = decorateForumPerson({ id: `user_${identity.id}`, name: identity.name, avatar: identity.avatar || DEFAULT_AVATAR_SRC }, draft);
  const members = draft.members.map(member => decorateForumPerson(member, draft));
  const mainFollowedMemberIds = members.filter(member => isForumProfileFollowed(draft.forumProfiles?.[member.id], member)).map(member => member.id);

  if (editingSpaceId) {
    const space = state.spaces.find(item => item.id === editingSpaceId);
    if (!space) return showDynamicIsland('找不到要修改的原方案');
    space.name = title;
    space.world = els.worldInput.value.trim();
    space.account = userProfile.account || forumIdentity.forumName;
    space.avatar = identity.avatar || DEFAULT_AVATAR_SRC;
    space.identityId = identity.id;
    space.forumProfiles = draft.forumProfiles;
    const temporaryOrdinaryMembers = (space.members || [])
      .filter(member => isForumTemporaryOrdinaryMember(member) && !members.some(item => String(item.id) === String(member.id)));
    space.members = [...members, ...temporaryOrdinaryMembers];
    space.relations = draft.relations;
    space.worldBook = draft.worldBookEntryIds.length ? (draft.worldBook || '') : (draft.worldBook || draft.legacyWorldBookText || '');
    space.worldBookEntryIds = normalizeForumWorldBookIds(draft.worldBookEntryIds);
    space.memberWorldBooks = filterForumMainMemberWorldBooks({
      ...(draft.legacyMemberWorldBooks || {}),
      ...(draft.memberWorldBooks || {})
    }, draft.members);
    space.memberWorldBookEntryIds = normalizeForumMemberWorldBookIds(draft.memberWorldBookEntryIds);
    space.circles = circles;
    space.mainFollowedMemberIds = mainFollowedMemberIds;
    space.characterAliases = normalizeForumCharacterAliasesForSave(draft.characterAliases, members);
    space.lastAiCharacterProfilePostIds = space.lastAiCharacterProfilePostIds && typeof space.lastAiCharacterProfilePostIds === 'object' ? space.lastAiCharacterProfilePostIds : {};
    space.aliases = (space.aliases || []).map(alias => ({
      ...alias,
      followedMemberIds: Array.isArray(alias.followedMemberIds) ? alias.followedMemberIds : [],
      circles: Array.isArray(alias.circles) ? alias.circles : []
    }));
    space.updatedAt = Date.now();
    state.currentSpaceId = space.id;
    editingSpaceId = null;
    resetForumTransientStateForSpaceChange();
    const savePromise = saveState();
    refreshLogin();
    showPage('page-forum-login');
    await savePromise;
    showDynamicIsland('方案已覆盖保存');
    return;
  }

  const space = {
    id: `space_${Date.now()}`,
    name: title,
    world: els.worldInput.value.trim(),
    account: userProfile.account || forumIdentity.forumName,
    avatar: identity.avatar || DEFAULT_AVATAR_SRC,
    identityId: identity.id,
    forumProfiles: draft.forumProfiles,
    members,
    relations: draft.relations,
    worldBook: draft.worldBookEntryIds.length ? (draft.worldBook || '') : (draft.worldBook || draft.legacyWorldBookText || ''),
    worldBookEntryIds: normalizeForumWorldBookIds(draft.worldBookEntryIds),
    memberWorldBooks: filterForumMainMemberWorldBooks({
      ...(draft.legacyMemberWorldBooks || {}),
      ...(draft.memberWorldBooks || {})
    }, draft.members),
    memberWorldBookEntryIds: normalizeForumMemberWorldBookIds(draft.memberWorldBookEntryIds),
    worldBookCallLogs: [],
    circles,
    mainFollowedMemberIds,
    aliases: [],
    characterAliases: normalizeForumCharacterAliasesForSave(draft.characterAliases, members),
    posts: [],
    messages: [],
    stickerConfigs: {},
    settings: { autoWorldPosts: true, gentlePalette: true, dmHintChancePercent: DEFAULT_FORUM_DM_HINT_CHANCE },
    activeEvent: { ...DEFAULT_FORUM_ACTIVE_EVENT },
    activeEventHistory: [],
    lastAiHomePostIds: [],
    lastAiCircleDetailPostIds: {},
    lastAiCharacterProfilePostIds: {},
    createdAt: Date.now()
  };
  state.spaces.unshift(space);
  state.currentSpaceId = space.id;
  resetForumTransientStateForSpaceChange();
  const savePromise = saveState();
  refreshLogin();
  showPage('page-forum-login');
  await savePromise;
  showDynamicIsland('方案已创建');
  } finally {
    forumSpaceSaveInProgress = false;
    if (els.createSpaceBtn) {
      els.createSpaceBtn.disabled = false;
      els.createSpaceBtn.removeAttribute('aria-busy');
    }
  }
}

function parseCircles(value) {
  const lines = value.split('\n').map(line => line.trim()).filter(Boolean);
  const circles = lines.map(line => {
    const [name, ...descParts] = line.split(/\s[-：:]\s|[-：:]/);
    return { name: name.trim(), desc: descParts.join(' - ').trim() || '用户常看的高频板块，会影响首页内容的主题。' };
  });
  return circles.length ? circles : DEFAULT_CIRCLES;
}

function renderApp() {
  const space = getCurrentSpace();
  if (!space) return;
  
  const currentUser = getCurrentForumUser(space);
  // ▼▼▼ 新增：让底栏的头像实时同步当前用户的真实头像 ▼▼▼
  const dockAvatar = els.bottomNav?.querySelector('.dock-avatar');
  if (dockAvatar) dockAvatar.src = currentUser.avatar;
  const messagesDockAvatar = els.messagesBottomNav?.querySelector('.dock-avatar');
  if (messagesDockAvatar) messagesDockAvatar.src = currentUser.avatar;
  // ▲▲▲ 新增结束 ▲▲▲
  els.appPage.dataset.forumView = activeView;
  els.appPage.dataset.forumView = activeView;
  els.currentTitle.textContent = space.name;
  if (els.worldSummary) els.worldSummary.textContent = space.world || '这个世界还没有写下公开说明。';
  renderForumActiveEventPanel(space);
  renderForumWorldBookCallLogs(space);
  els.bottomNav?.querySelectorAll('button').forEach(btn => btn.classList.toggle('active', btn.dataset.forumView === activeView || (activeView === 'circleDetail' && btn.dataset.forumView === 'circles')));
  if (activeView !== 'circleDetail') unbindForumCircleDetailTopbar();
  if (activeView === 'feed') renderFeed(space);
  if (activeView === 'circles') renderCircles(space);
  if (activeView === 'circleDetail') renderCircleDetail(space);
  if (activeView === 'messages') renderMessages(space);
  if (activeView === 'profile') renderProfile(space);
}

function renderCircleTabs(space) {
  const tabs = [{ name: 'all', label: 'All' }, ...getCurrentAccountCircles(space).map(c => ({ name: c.name, label: c.name }))];
  els.circleTabs.innerHTML = tabs.map(tab => `<button class="${activeCircle === tab.name ? 'active' : ''}" data-circle="${escapeHTML(tab.name)}" type="button">${escapeHTML(tab.label)}</button>`).join('');
}
function renderFeed(space) {
  const now = Date.now();
  const posts = [...space.posts]
    .filter(post => !post.expiresAt || post.expiresAt > now) // 新增：隐藏过期快拍
    .filter(isForumPostPublic)
    .sort((a, b) => b.createdAt - a.createdAt);
  const feedListKey = `${space.id || 'space'}:${space.updatedAt || 0}:${posts.length}`;
  if (forumFeedVisibleKey !== feedListKey) {
    forumFeedVisibleKey = feedListKey;
    forumFeedVisibleCount = FORUM_POST_RENDER_BATCH_SIZE;
  }
  const visiblePosts = posts.slice(0, forumFeedVisibleCount);
  const remainingPostCount = Math.max(0, posts.length - visiblePosts.length);
  const storyPeople = getStoryRailPeople(space);
  const loadingHtml = forumHomeFeedAbortController ? getForumFeedLoadingHtml() : '';
  els.feed.innerHTML = `
    ${storyPeople.length ? `
      <section class="forum-story-rail">
        ${storyPeople.map(person => `
          <button class="forum-story-dot" data-profile-id="${escapeHTML(person.id)}" type="button">
            <div class="story-ring"><img src="${person.avatar || DEFAULT_AVATAR_SRC}" alt="" loading="lazy" decoding="async"></div>
            <span>${escapeHTML(person.name)}</span>
          </button>
        `).join('')}
      </section>
    ` : ''}
    ${loadingHtml}
    ${visiblePosts.map(post => postCard(post)).join('') || '<p class="forum-empty">这里还没有帖子</p>'}
    ${remainingPostCount ? `<button class="forum-feed-load-more" data-forum-feed-load-more type="button">加载更多 ${Math.min(FORUM_POST_RENDER_BATCH_SIZE, remainingPostCount)} 条</button>` : ''}
  `;
  els.feed.querySelector('[data-forum-feed-load-more]')?.addEventListener('click', () => {
    forumFeedVisibleCount += FORUM_POST_RENDER_BATCH_SIZE;
    renderFeed(space);
  });
}

function getStoryRailPeople(space) {
  const currentUser = getCurrentForumUser(space);
  const seenIds = new Set([currentUser.id]);
  const followedProfiles = getCurrentFollowedMemberIds(space)
    .flatMap(profileId => {
      const member = (space.members || []).find(item => item.id === profileId);
      if (member) {
        const mainAccount = {
          id: member.id,
          name: getForumDisplayName(space, member.id, member.name),
          avatar: space.forumProfiles?.[member.id]?.avatar || member.avatar || DEFAULT_AVATAR_SRC
        };
        const aliasAccounts = member.type === 'character'
          ? (getForumCharacterAliasState(space, member.id).aliases || []).map(alias => ({
              id: alias.id,
              name: alias.name || `${mainAccount.name}的小号`,
              avatar: alias.avatar || member.avatar || DEFAULT_AVATAR_SRC
            }))
          : [];
        return [mainAccount, ...aliasAccounts];
      }
      const profile = space.forumProfiles?.[profileId];
      if (!profile) return [];
      return [{
        id: profileId,
        name: profile.nickname || profile.account || '论坛账号',
        avatar: profile.avatar || DEFAULT_AVATAR_SRC
      }];
    })
    .filter(person => person && !seenIds.has(person.id) && seenIds.add(person.id));
  return [
    {
      id: currentUser.id,
      name: currentUser.name,
      avatar: currentUser.avatar || DEFAULT_AVATAR_SRC
    },
    ...followedProfiles
  ].slice(0, 12);
}

function getFollowingCount(space) {
  return getCurrentFollowedMemberIds(space).length;
}

function formatFansCount(value) {
  const count = normalizeFansCount(value);
  if (count >= 10000) {
    const wan = count / 10000;
    return `${Number.isInteger(wan) ? wan : wan.toFixed(1)}万`;
  }
  return String(count);
}

async function toggleForumFollow(profileId) {
  const space = getCurrentSpace();
  if (!space || !profileId) return;
  const member = (space.members || []).find(item => item.id === profileId);
  const profile = space.forumProfiles?.[profileId] || null;
  if (!member && !profile) return;
  const followedIds = getCurrentFollowedMemberIds(space);
  const nextFollowed = !followedIds.includes(profileId);
  const nextIds = nextFollowed ? [...followedIds, profileId] : followedIds.filter(id => id !== profileId);
  setCurrentFollowedMemberIds(space, nextIds);
  if (!getCurrentAlias(space)) {
    if (!space.forumProfiles) space.forumProfiles = {};
    space.forumProfiles[profileId] = { ...(space.forumProfiles[profileId] || {}), isFollowed: nextFollowed };
    if (member) member.isFollowed = nextFollowed;
  }
  await saveState();
  showDynamicIsland(nextFollowed ? '已关注' : '已取消关注');
  if (activeView === 'feed') renderApp();
}
function getCirclePosts(space, circleName) {
  const now = Date.now();
  return space.posts.filter(post => post.circle === circleName && (!post.expiresAt || post.expiresAt > now) && isForumPostPublic(post)); // 修改：过滤过期快拍和非公开作品
}

function getCircleDetailPosts(space, circleName) {
  const posts = getCirclePosts(space, circleName);
  const scorePost = post => getForumPostLikeDisplayCount(post) * 3 + getForumPostCommentDisplayCount(post) * 2 + Math.max(0, 3 - Math.floor((Date.now() - post.createdAt) / 86400000));
  if (activeCircleDetailTab === 'hot') {
    return [...posts].sort((a, b) => scorePost(b) - scorePost(a) || b.createdAt - a.createdAt);
  }
  if (activeCircleDetailTab === 'recommend') {
    return [...posts].sort((a, b) => {
      const topCommentDiff = Number(Boolean(getTopComment(b))) - Number(Boolean(getTopComment(a)));
      return topCommentDiff || scorePost(b) - scorePost(a) || b.createdAt - a.createdAt;
    });
  }
  return [...posts].sort((a, b) => b.createdAt - a.createdAt);
}

function unbindForumCircleDetailTopbar() {
  const mainEl = els.feed?.closest('.forum-main');
  if (mainEl && forumCircleDetailTopbarScrollHandler) {
    mainEl.removeEventListener('scroll', forumCircleDetailTopbarScrollHandler);
  }
  forumCircleDetailTopbarScrollHandler = null;
}

function bindForumCircleDetailTopbar() {
  const mainEl = els.feed?.closest('.forum-main');
  const topbar = els.feed?.querySelector('#forum-circle-detail-topbar');
  const hero = els.feed?.querySelector('.forum-circle-detail-hero');
  if (!mainEl || !topbar || !hero) return;
  unbindForumCircleDetailTopbar();
  forumCircleDetailTopbarScrollHandler = () => {
    const threshold = Math.max(80, hero.offsetHeight - 64);
    topbar.classList.toggle('is-visible', mainEl.scrollTop > threshold);
  };
  mainEl.addEventListener('scroll', forumCircleDetailTopbarScrollHandler, { passive: true });
  requestAnimationFrame(forumCircleDetailTopbarScrollHandler);
}

function renderCircleDetail(space) {
  const trendId = getActiveForumDiscoverTrendId();
  const trend = trendId ? findForumDiscoverTrend(space, trendId) : null;
  const circles = getForumSharedDiscoverCircles(space);
  const circle = trend
    ? { name: trend.text, desc: getForumDiscoverTrendDesc(trend), isTrend: true }
    : circles.find(item => item.name === activeCircle);
  if (!circle) {
    activeView = 'circles';
    activeCircle = 'all';
    renderCircles(space);
    return;
  }
  const circlePosts = trend ? getForumDiscoverTrendPosts(space, trend) : getCirclePosts(space, circle.name);
  const displayPosts = trend ? getForumDiscoverTrendDetailPosts(space, trend) : getCircleDetailPosts(space, circle.name);
  const hotCount = circlePosts.filter(post => getForumPostLikeDisplayCount(post) + getForumPostCommentDisplayCount(post) > 0).length;
  const tabs = [
    { id: 'latest', label: '最新' },
    { id: 'hot', label: '最热' },
    { id: 'recommend', label: '猜你感兴趣' }
  ];
  const detailTargetKey = trend ? `trend:${trend.id}` : `circle:${circle.name}`;
  const isDetailGenerating = forumCircleDetailAbortController && forumCircleDetailGeneratingKey === detailTargetKey;
  const detailLoadingHtml = isDetailGenerating ? getForumFeedLoadingHtml('正在生成相关帖子…') : '';
  const detailListKey = `${detailTargetKey}:${space.updatedAt || 0}:${activeCircleDetailTab}:${displayPosts.length}`;
  if (forumCircleDetailVisibleKey !== detailListKey) {
    forumCircleDetailVisibleKey = detailListKey;
    forumCircleDetailVisibleCount = FORUM_POST_RENDER_BATCH_SIZE;
  }
  const visibleDisplayPosts = displayPosts.slice(0, forumCircleDetailVisibleCount);
  const remainingDetailPostCount = Math.max(0, displayPosts.length - visibleDisplayPosts.length);

  els.feed.innerHTML = `
    <section class="forum-circle-detail">
      <div class="forum-circle-detail-topbar" id="forum-circle-detail-topbar">
        <button id="forum-circle-detail-topbar-back" type="button" aria-label="返回圈子列表">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"></path></svg>
        </button>
        <strong>${escapeHTML(circle.name)}</strong>
      </div>
      <header class="forum-circle-detail-hero">
        <button class="circle-detail-back" id="forum-circle-detail-back" type="button" aria-label="返回圈子列表">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"></path></svg>
        </button>
        <div class="circle-detail-actions">
          <button id="forum-circle-ai-btn" class="${isDetailGenerating ? 'is-loading' : ''}" type="button" aria-label="${isDetailGenerating ? '打断生成' : 'AI生成圈子内容'}" ${isDetailGenerating ? 'aria-busy="true"' : ''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"></path></svg>
          </button>
          <button id="forum-circle-share-btn" type="button" aria-label="分享圈子">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><path d="M8.6 10.6l6.8-4.2M8.6 13.4l6.8 4.2"></path></svg>
          </button>
        </div>
        <div class="circle-detail-copy ${trend && forumCircleDetailExpandedTrendDesc.has(String(trend.id)) ? 'is-expanded' : ''}">
          <span>${trend ? 'Trending Topic' : 'Circle Topic'}</span>
          <h2>${escapeHTML(circle.name)}</h2>
          ${trend ? renderForumTrendCopy(trend) : `<p>${escapeHTML(circle.desc || '这个圈子暂时还没有说明。')}</p>`}
        </div>
        <div class="circle-detail-stats">
          <div><strong>${circlePosts.length}</strong><small>帖子</small></div>
          <div><strong>${hotCount}</strong><small>热帖</small></div>
        </div>
        <details class="circle-detail-rules">
          <summary>${trend ? '热搜说明' : '圈子规则'}</summary>
          <p>${trend ? '这里会优先展示和当前热搜词条相关的公开帖子。' : '发帖内容会优先围绕当前圈子展示。请保持主题相关，避免刷屏和重复内容。'}</p>
        </details>
      </header>
      <nav class="forum-circle-detail-tabs" aria-label="圈子内容筛选">
        ${tabs.map(tab => `<button class="${activeCircleDetailTab === tab.id ? 'active' : ''}" data-circle-detail-tab="${tab.id}" type="button">${tab.label}</button>`).join('')}
      </nav>
      <div class="forum-circle-detail-feed">
        ${detailLoadingHtml}
        ${visibleDisplayPosts.map(post => postCard(post)).join('') || (isDetailGenerating ? '' : `
          <div class="forum-circle-detail-empty">
            <strong>这里还没有相关帖子</strong>
            <span>点右下角发布按钮，第一条动态就从这里开始。</span>
          </div>
        `)}
        ${remainingDetailPostCount ? `<button class="forum-feed-load-more" data-forum-detail-load-more type="button">加载更多 ${Math.min(FORUM_POST_RENDER_BATCH_SIZE, remainingDetailPostCount)} 条</button>` : ''}
      </div>
    </section>
  `;

  const backToCircles = () => {
    activeView = 'circles';
    activeCircle = 'all';
    renderApp();
  };
  els.feed.querySelector('#forum-circle-detail-back')?.addEventListener('click', backToCircles);
  els.feed.querySelector('#forum-circle-detail-topbar-back')?.addEventListener('click', backToCircles);
  els.feed.querySelector('#forum-circle-ai-btn')?.addEventListener('click', openForumCircleDetailAiMenu);
  els.feed.querySelector('#forum-circle-share-btn')?.addEventListener('click', () => {
    if (window.showDynamicIsland) window.showDynamicIsland('圈子分享已准备好');
  });
  els.feed.querySelectorAll('[data-trend-desc-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const trendId = String(btn.dataset.trendDescToggle || '');
      if (!trendId) return;
      if (forumCircleDetailExpandedTrendDesc.has(trendId)) forumCircleDetailExpandedTrendDesc.delete(trendId);
      else forumCircleDetailExpandedTrendDesc.add(trendId);
      renderCircleDetail(space);
    });
  });
  els.feed.querySelector('[data-forum-detail-load-more]')?.addEventListener('click', () => {
    forumCircleDetailVisibleCount += FORUM_POST_RENDER_BATCH_SIZE;
    renderCircleDetail(space);
  });
  els.feed.querySelectorAll('[data-circle-detail-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      activeCircleDetailTab = btn.dataset.circleDetailTab;
      renderCircleDetail(space);
    });
  });
  bindForumCircleDetailTopbar();
}

function getCommentLikeCount(comment) {
  return Array.isArray(comment.likes) ? comment.likes.length : 0;
}

function getTopComment(post) {
  if (!post.comments.length) return null;
  return post.comments.reduce((topComment, comment) => (
    getCommentLikeCount(comment) > getCommentLikeCount(topComment) ? comment : topComment
  ), post.comments[0]);
}

function renderTopComment(post) {
  const topComment = getTopComment(post);
  if (!topComment) return '';
  const likeCount = getCommentLikeCount(topComment);
  return `
    <div class="forum-top-comment">
      <span class="top-comment-label">高赞评论</span>
      <span class="top-comment-text"><b>${escapeHTML(topComment.user)}</b> ${formatForumCommentText(topComment.text)}</span>
      ${likeCount > 0 ? `<span class="top-comment-likes">${likeCount}赞</span>` : ''}
    </div>
  `;
}
function postCard(post) {
  const space = getCurrentSpace();
  const userKey = getCurrentForumUserKey(space);
  const isLiked = post.likes.includes(userKey);
  const isSaved = isForumPostSaved(post, space, userKey);
  const likeCount = getForumPostLikeDisplayCount(post);
  const forwardCount = Number(post.forwards || 0);
  const commentCount = getForumPostCommentDisplayCount(post);
  const mediaHtml = getForumPostMediaHtml(post);
  const contentHtml = post.content ? `<p class="forum-post-text">${formatForumPostText(post.content)}</p>` : '';
  const verifiedBadgeHtml = post.isVerified ? getForumVerifiedBadgeIconHtml() : renderForumVerifiedBadge(space, post.authorId);
  
  // 新增：提取并渲染被提及的角色
  let mentionHtml = '';
  if (post.mentions && post.mentions.length > 0) {
    const mentionNames = post.mentions.map(id => {
      const name = findForumPersonName(space, id);
      return name ? `@${escapeHTML(name)}` : '';
    }).filter(Boolean);
    if (mentionNames.length > 0) mentionHtml = `<p style="color: #007aff; font-size: 13px; margin-top: -4px;">${mentionNames.join(' ')}</p>`;
  }

  return `
    <article class="forum-post-card" data-post-id="${post.id}">
      <header>
        <button class="forum-author" data-profile-id="${escapeHTML(post.authorId)}" type="button">
          <img src="${post.avatar || DEFAULT_AVATAR_SRC}" alt="" loading="lazy" decoding="async">
          <span>${escapeHTML(post.authorName)}${verifiedBadgeHtml}</span>
        </button>
        <em data-action="post-menu">...</em>
      </header>
      ${contentHtml}
      ${mediaHtml}
      ${mentionHtml}
      <footer>
        <button data-action="like" class="${isLiked ? 'liked' : ''}" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>${formatForumEngagementCount(likeCount)}</button>
        <button data-action="comment" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>${formatForumEngagementCount(commentCount)}</button>
        <button data-action="forward" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>${formatForumEngagementCount(forwardCount)}</button>
        <button class="btn-right ${isSaved ? 'saved' : ''}" data-action="save" type="button"><svg viewBox="0 0 24 24" fill="${isSaved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg></button>
      </footer>
      ${renderTopComment(post)}
    </article>
  `;
}

function getForumPostMediaHtml(post) {
  if (post.noMedia) return '';
  const mediaItems = Array.isArray(post.media) ? post.media : [];
  if (!mediaItems.length) return '';
  const musicMedia = mediaItems.find(media => media.type === 'music');
  const visualMedia = mediaItems.filter(media => media.type !== 'music');
  const hasMusicBadgeTarget = visualMedia.some(media => media.type === 'real-image' || media.type === 'sticker' || media.type === 'slides-video' || media.type === 'video');
  const layout = getForumVisualMediaLayout(visualMedia);
  let pageCapsule = '';
  let onScrollAttr = '';
  if (visualMedia.length > 1 && visualMedia.every(m => m.type === 'real-image')) {
    pageCapsule = `<div class="media-page-capsule">1/${visualMedia.length}</div>`;
    onScrollAttr = `onscroll="let cap=this.nextElementSibling; if(cap && cap.classList.contains('media-page-capsule')) cap.innerText = (Math.round(this.scrollLeft / this.clientWidth) + 1) + '/${visualMedia.length}'"`;
  }
  return [
    visualMedia.length ? `<div style="position: relative;"><div class="forum-post-media-grid ${layout} ${visualMedia.length > 1 ? 'multi' : 'single'}" ${onScrollAttr}>${visualMedia.map(renderForumMediaItem).join('')}${musicMedia && hasMusicBadgeTarget ? renderForumMusicTrigger(musicMedia) : ''}</div>${pageCapsule}</div>` : '',
    musicMedia && !hasMusicBadgeTarget ? renderForumMusicCard(musicMedia) : ''
  ].join('');
}

function getForumVisualMediaLayout(mediaItems) {
  if (mediaItems.length > 1 && mediaItems.every(media => media.type === 'real-image' || media.type === 'sticker')) return 'layout-real-carousel';
  return getCurrentSpace()?.settings?.mediaLayout === 'twitter' ? 'layout-twitter' : 'layout-instagram';
}

function renderForumMusicTrigger(media, extraClass = '') {
  const song = media?.song || {};
  return `
    <button class="forum-post-music-trigger ${extraClass}" data-action="play-music" data-forum-song-key="${escapeHTML(getForumSongKey(song))}" data-song-title="${escapeHTML(song.title || '')}" data-song-artist="${escapeHTML(song.artist || '')}" type="button" aria-label="播放音乐">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"></path><path d="M16 9a5 5 0 0 1 0 6"></path><path d="M19 6a9 9 0 0 1 0 12"></path></svg>
    </button>
    ${renderForumMusicCollectButton(song, `is-trigger ${extraClass}`)}
  `;
}

function renderForumDetailMusicDisc(media) {
  const song = media?.song || {};
  return `
    <button class="forum-detail-video-music-disc" data-action="play-music" data-forum-song-key="${escapeHTML(getForumSongKey(song))}" data-song-title="${escapeHTML(song.title || '')}" data-song-artist="${escapeHTML(song.artist || '')}" type="button" aria-label="播放或暂停音乐">
      <img src="${escapeHTML(song.cover || DEFAULT_AVATAR_SRC)}" alt="${escapeHTML(song.title || '音乐封面')}" loading="lazy" decoding="async">
    </button>
    ${renderForumMusicCollectButton(song, 'is-detail-disc')}
  `;
}

function renderForumMusicCard(media) {
  const song = media?.song || {};
  return `
    <div class="forum-post-music-card-shell">
      <button class="forum-post-media-item forum-post-music-card" data-action="play-music" data-forum-song-key="${escapeHTML(getForumSongKey(song))}" data-song-title="${escapeHTML(song.title || '')}" data-song-artist="${escapeHTML(song.artist || '')}" type="button">
        <img src="${escapeHTML(song.cover || DEFAULT_AVATAR_SRC)}" alt="" loading="lazy" decoding="async">
        <span>${escapeHTML(song.title || '音乐')}</span>
        <small>${escapeHTML(song.artist || '未知歌手')}</small>
      </button>
      ${renderForumMusicCollectButton(song, 'is-card')}
    </div>
  `;
}

function renderForumMediaItem(media) {
  if (media.type === 'real-image') {
    return `<img src="${escapeHTML(media.url || '')}" class="forum-post-media-item forum-post-real-image" alt="Post image" loading="lazy" decoding="async">`;
  }
  if (media.type === 'sticker') {
    return `<img src="${escapeHTML(media.url || '')}" class="forum-post-media-item forum-post-sticker-image" alt="${escapeHTML(media.explanation || '表情')}" title="${escapeHTML(media.explanation || '表情')}" loading="lazy" decoding="async">`;
  }
  if (media.type === 'fake-image') {
    return `<div class="forum-post-media-item forum-post-fake-image"><span>${escapeHTML(media.text || '')}</span></div>`;
  }
  if (media.type === 'slides-video') {
    const slides = Array.isArray(media.slides) ? media.slides : [];
    return `
      <div class="forum-post-media-item forum-post-slides-video" style="--slide-count:${Math.max(slides.length, 1)};">
        <div class="forum-video-progress">
          ${slides.map((slide, index) => `<i style="--slide-index:${index};"></i>`).join('')}
        </div>
        <div class="forum-video-chrome">
          <span>FORUM SHORT</span>
          <b>${slides.length || 1}P</b>
        </div>
       <div class="forum-slide-track">
          ${slides.map((slide, index) => `<div class="forum-slide-page" style="--slide-index:${index};"><span>${escapeHTML(slide.replace(/^\s*第[一二三四五六七八九十\d]+页[：:\s]*/, ''))}</span></div>`).join('')}
        </div>
      </div>
    `;
  }
  if (media.type === 'music') {
    return renderForumMusicCard(media);
  }
  if (media.type === 'video') {
    return `<video src="${escapeHTML(media.url || '')}" class="forum-post-media-item" controls playsinline></video>`;
  }
  return '';
}

async function handleFeedClick(e) {
  const card = e.target.closest('[data-post-id]');
  const profileBtn = e.target.closest('[data-profile-id]');
  const actionBtn = e.target.closest('[data-action]');
  const space = getCurrentSpace();
  if (!space) return;
  if (profileBtn) return openForumPostAuthorProfile(profileBtn.dataset.profileId);
  if (!card) return;
  const post = space.posts.find(item => item.id === card.dataset.postId);
  if (!post) return;
  if (!actionBtn) return openPostDetailPage(post);
  if (actionBtn.dataset.action === 'post-menu') {
    openForumPostMenu(post);
    return;
  }
  if (actionBtn.dataset.action === 'play-music') {
    playForumPostMusic(post, actionBtn);
    return;
  }
  if (actionBtn.dataset.action === 'collect-music') {
    e.stopPropagation();
    collectForumPostMusic(post, actionBtn);
    return;
  }
  if (actionBtn.dataset.action === 'like') {
    const currentUser = getCurrentForumUser(space);
    const userKey = currentUser.id;
    const wasLiked = post.likes.includes(userKey);
    post.likes = wasLiked ? post.likes.filter(item => item !== userKey) : [...post.likes, userKey];
    const currentLikeCount = getForumPostLikeDisplayCount(post);
    post.likeCount = Math.max(post.likes.length, currentLikeCount + (wasLiked ? -1 : 1));
    await saveState();
    renderApp();
  }
  if (actionBtn.dataset.action === 'comment') openPostDetailPage(post, { focusComments: true });
  if (actionBtn.dataset.action === 'save') {
    openForumSavePicker(post);
    return;
  }
  if (actionBtn.dataset.action === 'forward') {
    actionBtn.classList.add('active');
    setTimeout(() => actionBtn.classList.remove('active'), 180);
    openForumForwardPicker(post);
  }
}

let forumPostAudio = null;
let forumPostAudioKey = '';
const FORUM_NETEASE_API_BASE_URL = 'https://my-music-api-h8qk.onrender.com';

function getForumPostMusicMedia(post) {
  return (post?.media || []).find(item => item.type === 'music');
}

function getForumSongKey(song = {}) {
  return `${song.title || '音乐'}__${song.artist || '未知歌手'}`;
}

function getForumSongAudioSrc(song = {}) {
  return song.src || song.url || song.audioSrc || '';
}

function normalizeForumAudioSrc(src) {
  return window.MusicPlayer?.normalizeAudioSource?.(src) || src;
}

function findForumLibrarySong(song = {}) {
  const title = String(song.title || '');
  const artist = String(song.artist || '');
  const lists = [
    window.MusicPlayer?.globalPlaylist,
    window.MusicPlayer?.playlist
  ].filter(Array.isArray);
  for (const list of lists) {
    const matched = list.find(item => String(item.title || '') === title && String(item.artist || '') === artist);
    if (matched) return matched;
  }
  return null;
}

function isForumSongInLocalLibrary(song = {}) {
  const title = String(song.title || '').trim().toLowerCase();
  const artist = String(song.artist || '').trim().toLowerCase();
  if (!title || !artist || !Array.isArray(window.MusicPlayer?.globalPlaylist)) return false;
  return window.MusicPlayer.globalPlaylist.some(item =>
    String(item.title || '').trim().toLowerCase() === title &&
    String(item.artist || '').trim().toLowerCase() === artist
  );
}

function renderForumMusicCollectButton(song = {}, extraClass = '') {
  const isCollected = isForumSongInLocalLibrary(song);
  return `
    <button class="forum-music-collect-btn ${extraClass} ${isCollected ? 'is-collected' : ''}" data-action="collect-music" data-song-title="${escapeHTML(song.title || '')}" data-song-artist="${escapeHTML(song.artist || '')}" type="button" aria-disabled="${isCollected ? 'true' : 'false'}">
      ${isCollected ? '已收藏' : '收藏'}
    </button>
  `;
}

function getForumCollectedLibrarySong(song = {}) {
  const title = String(song.title || '').trim().toLowerCase();
  const artist = String(song.artist || '').trim().toLowerCase();
  if (!title || !artist || !Array.isArray(window.MusicPlayer?.globalPlaylist)) return null;
  return window.MusicPlayer.globalPlaylist.find(item =>
    String(item.title || '').trim().toLowerCase() === title &&
    String(item.artist || '').trim().toLowerCase() === artist
  ) || null;
}

function updateForumMusicCollectButtons(song = {}) {
  document.querySelectorAll('[data-action="collect-music"]').forEach(btn => {
    const sameSong = String(btn.dataset.songTitle || '').trim().toLowerCase() === String(song.title || '').trim().toLowerCase() &&
      String(btn.dataset.songArtist || '').trim().toLowerCase() === String(song.artist || '').trim().toLowerCase();
    if (!sameSong) return;
    btn.textContent = '已收藏';
    btn.disabled = false;
    btn.setAttribute('aria-disabled', 'true');
    btn.classList.add('is-collected');
  });
}

async function collectForumPostMusic(post, triggerBtn) {
  const musicPlayer = window.MusicPlayer;
  if (!musicPlayer?.globalPlaylist || typeof musicPlayer.saveSongToLocal !== 'function') {
    showDynamicIsland('本地音乐库还没准备好');
    return;
  }
  const media = getForumPostMusicMedia(post);
  const rawSong = media?.song;
  if (!rawSong) return;
  if (isForumSongInLocalLibrary(rawSong)) {
    updateForumMusicCollectButtons(rawSong);
    showDynamicIsland('这首歌已经在本地音乐里');
    return;
  }
  if (triggerBtn?.dataset.collecting === 'true') return;

  const previousText = triggerBtn?.textContent || '';
  if (triggerBtn) {
    triggerBtn.dataset.collecting = 'true';
    triggerBtn.setAttribute('aria-disabled', 'true');
    triggerBtn.textContent = '查找中';
  }
  const { song, src: songSrc } = await getForumPlayableSong(rawSong);
  if (!songSrc) {
    if (triggerBtn) {
      delete triggerBtn.dataset.collecting;
      triggerBtn.setAttribute('aria-disabled', 'false');
      triggerBtn.textContent = previousText || '收藏';
    }
    showDynamicIsland('没找到这首歌的音源，无法收藏');
    return;
  }
  if (triggerBtn) {
    delete triggerBtn.dataset.collecting;
    triggerBtn.setAttribute('aria-disabled', 'false');
    triggerBtn.textContent = previousText || '收藏';
  }

  const groups = Array.isArray(musicPlayer.groups) ? musicPlayer.groups : [];
  const songToSave = {
    title: song.title || rawSong.title || '音乐',
    artist: song.artist || rawSong.artist || '未知歌手',
    cover: song.cover || rawSong.cover || DEFAULT_AVATAR_SRC,
    src: songSrc,
    lyric: song.lyric || rawSong.lyric || '',
    neteaseId: song.neteaseId || rawSong.neteaseId || null
  };
  const groupRows = groups.map(group => `
    <button class="forum-music-save-row" data-forum-music-group-id="${escapeHTML(group.id || '')}" type="button">
      <img src="${escapeHTML(group.cover || DEFAULT_AVATAR_SRC)}" alt="">
      <span>${escapeHTML(group.name || '未命名歌单')}</span>
      <small>${Array.isArray(group.songs) ? group.songs.length : 0} 首</small>
    </button>
  `).join('');

  openSheet('收藏音乐', `
    <div class="forum-music-save-list">
      <button class="forum-music-save-row is-library-only" data-forum-music-library-only="true" type="button">
        <img src="${escapeHTML(songToSave.cover || DEFAULT_AVATAR_SRC)}" alt="">
        <span>只加入曲库</span>
        <small>不加入歌单</small>
      </button>
      ${groupRows || '<div class="forum-music-save-empty">还没有歌单</div>'}
    </div>
  `, root => {
    root.querySelectorAll('[data-forum-music-library-only], [data-forum-music-group-id]').forEach(row => {
      row.addEventListener('click', async event => {
        event.stopPropagation();
        const groupId = row.dataset.forumMusicGroupId || '';
        const targetGroup = groupId ? groups.find(group => group.id === groupId) : null;
        const existingSong = getForumCollectedLibrarySong(songToSave);
        const librarySong = existingSong || songToSave;
        if (!existingSong) {
          musicPlayer.globalPlaylist.push(librarySong);
          await musicPlayer.saveSongToLocal(librarySong.title, librarySong.artist, librarySong.cover, librarySong.src, librarySong.lyric, null);
          musicPlayer.renderSongToDOM?.(librarySong.title, librarySong.artist, librarySong.cover, librarySong.src, librarySong.lyric);
          musicPlayer.updateProfileStats?.();
        }
        if (targetGroup) {
          if (!Array.isArray(targetGroup.songs)) targetGroup.songs = [];
          const existsInGroup = targetGroup.songs.some(item =>
            String(item.title || '').trim().toLowerCase() === String(librarySong.title || '').trim().toLowerCase() &&
            String(item.artist || '').trim().toLowerCase() === String(librarySong.artist || '').trim().toLowerCase()
          );
          if (!existsInGroup) targetGroup.songs.push(librarySong);
          await musicPlayer.saveGroupsToLocal?.();
          await musicPlayer.renderGroupsToDOM?.();
        }
        closeModal();
        updateForumMusicCollectButtons(librarySong);
        showDynamicIsland(targetGroup ? `已收藏到《${targetGroup.name || '歌单'}》` : '已收藏到本地音乐');
      });
    });
  });
}

async function getForumPlayableSong(song = {}) {
  const librarySong = findForumLibrarySong(song);
  const playableSong = { ...song, ...(librarySong || {}) };
  let songSrc = getForumSongAudioSrc(playableSong);
  const looksLikeNeteaseUrl = songSrc && (songSrc.includes('126.net') || songSrc.includes('163.com'));
  if (!playableSong.neteaseId && (looksLikeNeteaseUrl || !songSrc)) {
    try {
      const cookie = localStorage.getItem('netease_cookie');
      const cookieParam = cookie ? `&cookie=${encodeURIComponent(cookie)}` : '';
      const searchRes = await fetch(`${FORUM_NETEASE_API_BASE_URL}/search?keywords=${encodeURIComponent(`${playableSong.title || ''} ${playableSong.artist || ''}`)}&limit=1&timestamp=${Date.now()}${cookieParam}`);
      const searchData = await searchRes.json();
      const foundId = searchData?.result?.songs?.[0]?.id;
      if (searchData?.code === 200 && foundId) {
        playableSong.neteaseId = foundId;
        if (librarySong) librarySong.neteaseId = foundId;
      }
    } catch (error) {
      console.warn('Forum post music id refresh failed:', error);
    }
  }
  if (playableSong.neteaseId) {
    try {
      const cookie = localStorage.getItem('netease_cookie');
      const cookieParam = cookie ? `&cookie=${encodeURIComponent(cookie)}` : '';
      const urlRes = await fetch(`${FORUM_NETEASE_API_BASE_URL}/song/url/v1?id=${playableSong.neteaseId}&level=exhigh&timestamp=${Date.now()}${cookieParam}`);
      const urlData = await urlRes.json();
      const freshUrl = urlData?.data?.[0]?.url || '';
      if (urlData?.code === 200 && freshUrl) {
        const playableUrl = normalizeForumAudioSrc(freshUrl);
        songSrc = playableUrl;
        playableSong.src = playableUrl;
        if (librarySong) librarySong.src = playableUrl;
      }
    } catch (error) {
      console.warn('Forum post music refresh failed:', error);
    }
  }
  return { song: playableSong, src: songSrc };
}

function syncForumMusicButtons() {
  const isPlaying = forumPostAudio && !forumPostAudio.paused;
  document.querySelectorAll('[data-forum-song-key]').forEach(btn => {
    btn.classList.toggle('playing', Boolean(isPlaying && btn.dataset.forumSongKey === forumPostAudioKey));
  });
}

function stopForumPostAudio() {
  if (forumPostAudio) {
    forumPostAudio.pause();
    forumPostAudio.currentTime = 0;
  }
  forumPostAudio = null;
  forumPostAudioKey = '';
  syncForumMusicButtons();
}

async function playForumPostMusic(post, triggerBtn, options = {}) {
  const media = (post.media || []).find(item => item.type === 'music');
  const rawSong = media?.song;
  const { song, src: songSrc } = await getForumPlayableSong(rawSong);
  const songKey = getForumSongKey(song);
  const shouldToggle = options.toggle !== false;
  if (!song || !songSrc) {
    showDynamicIsland('暂时找不到这首音乐');
    return;
  }
  if (forumPostAudio && forumPostAudioKey === songKey) {
    if (!forumPostAudio.paused && shouldToggle) {
      forumPostAudio.pause();
      syncForumMusicButtons();
      return;
    }
  } else {
    stopForumPostAudio();
    forumPostAudio = new Audio(normalizeForumAudioSrc(songSrc));
    forumPostAudio.loop = true;
    forumPostAudioKey = songKey;
    forumPostAudio.addEventListener('pause', syncForumMusicButtons);
    forumPostAudio.addEventListener('play', syncForumMusicButtons);
  }
  forumPostAudio.play().then(() => {
    syncForumMusicButtons();
    if (!options.silent) showDynamicIsland(`正在播放: ${song.title || '音乐'}`);
  }).catch(error => {
    console.warn('Forum post music play failed:', error);
    syncForumMusicButtons();
    if (!options.silent) showDynamicIsland('点击封面可播放音乐');
  });
  triggerBtn?.classList.add('playing');
}

function autoPlayForumPostMusic(post) {
  if (getForumPostMusicMedia(post)) {
    playForumPostMusic(post, null, { toggle: false, silent: true });
  } else {
    stopForumPostAudio();
  }
}

function ensureForumForwardPickerRoot() {
  let overlay = document.getElementById('forum-forward-picker-overlay');
  if (overlay) return overlay;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="forum-forward-picker-overlay" class="forum-forward-picker-overlay">
      <div class="forum-forward-picker-card">
        <div class="forum-forward-picker-header">
          <h3>发送给谁</h3>
          <button type="button" id="forum-forward-picker-close" aria-label="关闭">×</button>
        </div>
        <div class="forum-forward-picker-search">
          <input id="forum-forward-picker-input" type="text" placeholder="搜索角色、小号或群聊">
        </div>
        <div id="forum-forward-picker-list" class="forum-forward-picker-list"></div>
      </div>
    </div>
  `);
  overlay = document.getElementById('forum-forward-picker-overlay');
  const closeBtn = document.getElementById('forum-forward-picker-close');
  const closePicker = () => {
    overlay.classList.remove('visible');
    overlay.style.opacity = '0';
    setTimeout(() => { overlay.style.display = 'none'; }, 180);
  };
  closeBtn?.addEventListener('click', closePicker);
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closePicker();
  });
  return overlay;
}

function getForumForwardTargets(space) {
  const currentUser = getCurrentForumUser(space);
  const targets = [];
  (AppState.characterProfiles || []).forEach(char => {
    if (!char) return;
    targets.push({
      id: char.id,
      name: char.name || '未命名角色',
      avatar: char.avatar || DEFAULT_AVATAR_SRC,
      kind: char.isGroup ? '群聊' : '角色'
    });
  });
  (space.aliases || []).forEach(alias => {
    targets.push({
      id: alias.id,
      name: alias.name || '匿名小号',
      avatar: alias.avatar || DEFAULT_AVATAR_SRC,
      kind: '小号'
    });
  });
  return targets.filter(item => item.id !== currentUser.id);
}

function openForumForwardPicker(post) {
  const space = getCurrentSpace();
  if (!space || !post) return;
  const overlay = ensureForumForwardPickerRoot();
  const listEl = overlay.querySelector('#forum-forward-picker-list');
  const inputEl = overlay.querySelector('#forum-forward-picker-input');
  const closePicker = () => {
    overlay.classList.remove('visible');
    overlay.style.opacity = '0';
    setTimeout(() => { overlay.style.display = 'none'; }, 180);
  };
  const renderList = (keyword = '') => {
    const items = getForumForwardTargets(space).filter(item => {
      if (!keyword) return true;
      return String(item.name).toLowerCase().includes(keyword.toLowerCase());
    });
    listEl.innerHTML = items.length ? items.map(item => `
      <button type="button" class="forum-forward-target-row" data-target-id="${escapeHTML(item.id)}" data-target-name="${escapeHTML(item.name)}">
        <img src="${escapeHTML(item.avatar)}" alt="">
        <span>${escapeHTML(item.name)}</span>
        <small>${item.kind}</small>
      </button>
    `).join('') : `<div class="forum-empty">没有找到可发送对象</div>`;
  };
  renderList();
  inputEl.value = '';
  inputEl.oninput = () => renderList(inputEl.value.trim());
  overlay.style.display = 'flex';
  requestAnimationFrame(() => {
    overlay.classList.add('visible');
    overlay.style.opacity = '1';
  });
  listEl.onclick = async e => {
    const row = e.target.closest('[data-target-id]');
    if (!row) return;
    const targetId = row.dataset.targetId;
    const targetName = row.dataset.targetName || 'Ta';
    await sendForumPostToAIChat(targetId, post, targetName);
    post.forwards = Number(post.forwards || 0) + 1;
    await saveState();
    renderApp();
    if (currentDetailPost?.id === post.id) renderPostDetailContent({ preserveScroll: true });
    closePicker();
    showDynamicIsland(`已发送给 ${targetName}`);
  };
}

async function sendForumPostToAIChat(chatId, post, targetName) {
  const currentUser = getCurrentForumUser(getCurrentSpace());
  const commentContext = buildForumPostShareCommentContext(post);
  const postType = post?.type || getForumPostType(Array.isArray(post?.media) ? post.media : []);
  const contentPayload = JSON.stringify({
    kind: 'forum_post_detail',
    title: post.content || '',
    author: post.authorName,
    sharedBy: currentUser?.name || '论坛当前用户',
    sharedByAccount: currentUser?.account || '',
    avatar: post.avatar || DEFAULT_AVATAR_SRC,
    text: post.content || '',
    thumb: Array.isArray(post.media) && post.media[0]?.url ? post.media[0].url : '',
    media: Array.isArray(post.media) ? post.media : [],
    postType,
    postTypeLabel: getForumPostTypeLabel(postType),
    circle: post.circle || '',
    createdAt: post.createdAt || Date.now(),
    likes: getForumPostLikeDisplayCount(post),
    comments: getForumPostCommentDisplayCount(post),
    forwards: Number(post.forwards || 0),
    commentContextMode: commentContext.mode,
    commentSummary: commentContext.summary,
    recentComments: commentContext.recentComments,
    commentsDetail: commentContext.mode === 'summary' ? commentContext.summary : commentContext.recentComments,
    commentItems: (post.comments || []).map(c => ({
      user: c.user || '匿名',
      avatar: c.avatar || DEFAULT_AVATAR_SRC,
      text: c.text || c.content || '',
      createdAt: c.createdAt || Date.now(),
      likes: Array.isArray(c.likes) ? c.likes.length : 0,
      isOwner: String(c.user || '') === String(post.authorName || ''),
      replies: (Array.isArray(c.replies) ? c.replies : []).map(reply => ({
        user: reply.user || '匿名用户',
        avatar: reply.avatar || DEFAULT_AVATAR_SRC,
        text: reply.text || reply.content || '',
        createdAt: reply.createdAt || Date.now(),
        isOwner: String(reply.user || '') === String(post.authorName || '')
      }))
    })),
    momentId: post.id,
    targetName
  });
  const messageData = {
    chatId,
    timestamp: new Date(),
    text: '[论坛帖子]',
    type: 'sent',
    contentType: 'forum_post_card',
    content: contentPayload,
    avatarSrc: currentUser.avatar,
    recalled: false
  };
  const id = await db.chatMessages.add(messageData);
  messageData.id = id;
  await createAndAppendMessage(messageData);
}

function openForumPostMenu(post) {
  if (!els.modalRoot) return;
  const isOwned = isForumPostOwnedByCurrentUser(post);
  els.modalRoot.innerHTML = `
    <div class="forum-post-menu-overlay">
      <div class="forum-post-menu-card">
        <button data-post-menu-action="regen" type="button">重新生成</button>
        <button data-post-menu-action="delete" class="danger" type="button">删除帖子</button>
        <button data-post-menu-action="cancel" type="button">取消</button>
      </div>
    </div>
  `;
  const overlay = els.modalRoot.querySelector('.forum-post-menu-overlay');
  const regenBtn = els.modalRoot.querySelector('[data-post-menu-action="regen"]');
  if (isOwned && regenBtn) {
    regenBtn.dataset.postMenuAction = 'edit';
    regenBtn.textContent = '重新编辑';
  }
  overlay.addEventListener('click', async e => {
    const actionBtn = e.target.closest('[data-post-menu-action]');
    if (!actionBtn) {
      if (e.target === overlay) closeModal();
      return;
    }
    const action = actionBtn.dataset.postMenuAction;
    if (action === 'cancel') {
      closeModal();
      return;
    }
    if (action === 'delete') {
      await deleteForumPost(post.id);
      closeModal();
      return;
    }
    if (action === 'edit') {
      closeModal();
      openForumPostEditor(post);
      return;
    }
    if (action === 'regen') {
      actionBtn.disabled = true;
      actionBtn.textContent = '生成中...';
      await regenerateForumPost(post.id);
      closeModal();
    }
  });
}

function openForumDetailCommentMenu(post) {
  if (!els.modalRoot || !post) return;
  els.modalRoot.innerHTML = `
    <div class="forum-post-menu-overlay">
      <div class="forum-post-menu-card">
        <button data-detail-comment-menu-action="edit" type="button">编辑评论</button>
        <button data-detail-comment-menu-action="delete" class="danger" type="button">删除评论</button>
        <button data-detail-comment-menu-action="cancel" type="button">取消</button>
      </div>
    </div>
  `;
  const overlay = els.modalRoot.querySelector('.forum-post-menu-overlay');
  overlay.addEventListener('click', e => {
    const actionBtn = e.target.closest('[data-detail-comment-menu-action]');
    if (!actionBtn) {
      if (e.target === overlay) closeModal();
      return;
    }
    const action = actionBtn.dataset.detailCommentMenuAction;
    closeModal();
    if (action === 'cancel') {
      resetDetailCommentManageMode();
      renderPostDetailContent({ preserveScroll: true });
      return;
    }
    if (!Array.isArray(post.comments) || post.comments.length === 0) {
      showDynamicIsland('当前没有可操作的评论');
      return;
    }
    detailCommentManageMode = action;
    selectedDetailCommentTargets = new Set();
    updateDetailCommentBar();
    renderPostDetailContent({ preserveScroll: true });
    showDynamicIsland(action === 'edit' ? '点击要编辑的评论' : '点击评论进行多选删除');
  });
}

function resetDetailCommentManageMode() {
  detailCommentManageMode = null;
  selectedDetailCommentTargets = new Set();
  updateDetailCommentBar();
}

function getDetailCommentTarget(post, target) {
  const comment = post?.comments?.[target.commentIndex];
  if (!comment) return null;
  if (Number.isInteger(target.replyIndex)) {
    const replies = Array.isArray(comment.replies) ? comment.replies : [];
    const reply = replies[target.replyIndex];
    return reply ? { item: reply, parent: comment, type: 'reply' } : null;
  }
  return { item: comment, parent: post, type: 'comment' };
}

function getDetailCommentTargetKey(target) {
  return Number.isInteger(target.replyIndex)
    ? `reply:${target.commentIndex}:${target.replyIndex}`
    : `comment:${target.commentIndex}`;
}

function toggleDetailCommentSelection(targetKey, itemEl) {
  if (selectedDetailCommentTargets.has(targetKey)) {
    selectedDetailCommentTargets.delete(targetKey);
  } else {
    selectedDetailCommentTargets.add(targetKey);
  }
  itemEl?.classList.toggle('selected-for-delete', selectedDetailCommentTargets.has(targetKey));
  updateDetailCommentBar();
}

function parseDetailCommentTargetKey(key) {
  const parts = String(key).split(':');
  if (parts[0] === 'reply') return { commentIndex: Number(parts[1]), replyIndex: Number(parts[2]) };
  return { commentIndex: Number(parts[1]) };
}

function openForumDetailCommentEditor(post, target) {
  const targetInfo = getDetailCommentTarget(post, target);
  if (!targetInfo) return;
  const comment = targetInfo.item;
  resetDetailCommentManageMode();
  renderPostDetailContent({ preserveScroll: true });
  openSheet('编辑评论', `
    <div class="forum-compose-form">
      <textarea id="forum-edit-comment-text" placeholder="评论内容">${escapeHTML(comment.text || '')}</textarea>
      <button class="forum-primary-btn" id="forum-edit-comment-save" type="button">保存</button>
    </div>
  `, root => {
    root.querySelector('#forum-edit-comment-save')?.addEventListener('click', async () => {
      const nextText = root.querySelector('#forum-edit-comment-text')?.value.trim() || '';
      if (!nextText) return;
      comment.text = nextText;
      comment.updatedAt = Date.now();
      await saveState();
      closeModal();
      resetDetailCommentManageMode();
      renderApp();
      renderPostDetailContent({ preserveScroll: true });
      showDynamicIsland('评论已更新');
    });
  });
}

async function deleteSelectedDetailComments(post) {
  if (!post || selectedDetailCommentTargets.size === 0) {
    showDynamicIsland('请先选择要删除的评论');
    return;
  }
  if (!confirm(`确定删除这 ${selectedDetailCommentTargets.size} 条评论吗？`)) return;
  const targets = Array.from(selectedDetailCommentTargets).map(parseDetailCommentTargetKey);
  const commentIndexesToDelete = new Set(targets.filter(target => !Number.isInteger(target.replyIndex)).map(target => target.commentIndex));
  const replyIndexesByComment = new Map();
  targets.forEach(target => {
    if (!Number.isInteger(target.replyIndex) || commentIndexesToDelete.has(target.commentIndex)) return;
    const list = replyIndexesByComment.get(target.commentIndex) || new Set();
    list.add(target.replyIndex);
    replyIndexesByComment.set(target.commentIndex, list);
  });
  (post.comments || []).forEach((comment, index) => {
    const replyIndexes = replyIndexesByComment.get(index);
    if (!replyIndexes || !Array.isArray(comment.replies)) return;
    comment.replies = comment.replies.filter((_, replyIndex) => !replyIndexes.has(replyIndex));
  });
  post.comments = (post.comments || []).filter((_, index) => !commentIndexesToDelete.has(index));
  await saveState();
  resetDetailCommentManageMode();
  renderApp();
  renderPostDetailContent({ preserveScroll: true });
  showDynamicIsland('评论已删除');
}

function updateDetailCommentBar() {
  const bar = document.querySelector('#page-forum-post-detail .forum-detail-comment-bar');
  if (!bar) return;
  let manageBar = bar.querySelector('#detail-comment-manage-bar');
  if (!manageBar) {
    manageBar = document.createElement('div');
    manageBar.id = 'detail-comment-manage-bar';
    manageBar.className = 'detail-comment-manage-bar';
    manageBar.innerHTML = `
      <button type="button" id="detail-comment-manage-cancel">取消</button>
      <span id="detail-comment-manage-count">已选择 0 条</span>
      <button type="button" id="detail-comment-manage-confirm">确认删除</button>
    `;
    bar.appendChild(manageBar);
  }
  const isDeleteMode = detailCommentManageMode === 'delete';
  const isEditMode = detailCommentManageMode === 'edit';
  bar.classList.toggle('is-comment-delete-mode', isDeleteMode);
  bar.classList.toggle('is-comment-edit-mode', isEditMode);
  const countText = manageBar.querySelector('#detail-comment-manage-count');
  if (countText) countText.textContent = isEditMode ? '点击评论进行编辑' : `已选择 ${selectedDetailCommentTargets.size} 条`;
  const confirmBtn = manageBar.querySelector('#detail-comment-manage-confirm');
  if (confirmBtn) {
    confirmBtn.disabled = selectedDetailCommentTargets.size === 0;
    confirmBtn.style.display = isDeleteMode ? '' : 'none';
  }
  const cancelBtn = manageBar.querySelector('#detail-comment-manage-cancel');
  if (cancelBtn) cancelBtn.onclick = () => {
    resetDetailCommentManageMode();
    renderPostDetailContent({ preserveScroll: true });
  };
  if (confirmBtn) confirmBtn.onclick = async () => {
    await deleteSelectedDetailComments(currentDetailPost);
  };
}

async function deleteForumPost(postId) {
  const space = getCurrentSpace();
  if (!space) return;
  removeForumPostRecords(space, [postId]);
  await saveState();
  renderApp();
  showDynamicIsland('帖子已删除');
}

function removeForumPostRecords(space, postIds) {
  const ids = new Set((postIds || []).map(String));
  if (!space || ids.size === 0) return 0;
  const posts = Array.isArray(space.posts) ? space.posts : [];
  const beforeCount = posts.length;
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < posts.length; readIndex += 1) {
    const post = posts[readIndex];
    if (ids.has(String(post?.id))) continue;
    posts[writeIndex] = post;
    writeIndex += 1;
  }
  posts.length = writeIndex;
  space.posts = posts;
  space.userPostDigests = (space.userPostDigests || []).filter(item => !ids.has(String(item.postId)));
  if (Array.isArray(space.lastAiHomePostIds)) {
    space.lastAiHomePostIds = space.lastAiHomePostIds.filter(id => !ids.has(String(id)));
  }
  Object.keys(space.lastAiCircleDetailPostIds || {}).forEach(key => {
    if (Array.isArray(space.lastAiCircleDetailPostIds[key])) {
      space.lastAiCircleDetailPostIds[key] = space.lastAiCircleDetailPostIds[key].filter(id => !ids.has(String(id)));
    }
  });
  Object.keys(space.lastAiCharacterProfilePostIds || {}).forEach(key => {
    if (Array.isArray(space.lastAiCharacterProfilePostIds[key])) {
      space.lastAiCharacterProfilePostIds[key] = space.lastAiCharacterProfilePostIds[key].filter(id => !ids.has(String(id)));
    }
  });
  Object.values(space.favoriteCollectionsByUser || {}).forEach(collections => {
    if (!Array.isArray(collections)) return;
    collections.forEach(folder => {
      if (Array.isArray(folder.postIds)) folder.postIds = folder.postIds.filter(id => !ids.has(String(id)));
    });
  });
  ids.forEach(id => {
    if (forumCommentBackups[id]) delete forumCommentBackups[id];
  });
  return beforeCount - (space.posts || []).length;
}

async function clearForumPostsBatch({ postIds = [] } = {}) {
  const space = getCurrentSpace();
  if (!space) return 0;
  const deletedCount = removeForumPostRecords(space, postIds);
  if (deletedCount <= 0) return 0;
  const deletedCurrentDetail = currentDetailPost && postIds.some(id => String(id) === String(currentDetailPost.id));
  if (deletedCurrentDetail) {
    currentDetailPost = null;
    resetDetailCommentManageMode();
    showPage('page-forum');
  }
  forumFeedVisibleCount = FORUM_POST_RENDER_BATCH_SIZE;
  forumCircleDetailVisibleCount = FORUM_POST_RENDER_BATCH_SIZE;
  await saveState();
  renderApp();
  return deletedCount;
}

function openForumPostEditor(post) {
  if (!post || !isForumPostOwnedByCurrentUser(post)) return;
  openSheet('重新编辑帖子', `
    <div class="forum-compose-form">
      <textarea id="forum-edit-post-text" placeholder="帖子文案">${escapeHTML(post.content || '')}</textarea>
      <button class="forum-primary-btn" id="forum-edit-post-save" type="button">保存</button>
    </div>
  `, root => {
    root.querySelector('#forum-edit-post-save')?.addEventListener('click', async () => {
      post.content = root.querySelector('#forum-edit-post-text')?.value.trim() || '';
      post.translation = '';
      post.updatedAt = Date.now();
      await saveState();
      closeModal();
      renderApp();
      if (currentDetailPost?.id === post.id) {
        currentDetailPost = post;
        renderPostDetailContent();
      }
      showDynamicIsland('帖子已更新');
    });
  });
}

async function regenerateForumPost(postId) {
  const space = getCurrentSpace();
  const post = space?.posts?.find(item => item.id === postId);
  if (!space || !post) return;
  try {
    const prompt = [
      '请重新生成下面这条论坛帖子正文，只输出新的正文，不要解释。',
      await getForumGenerationContext(space, post.authorId, '重生成帖子'),
      `[原帖子作者] ${post.authorName}`,
      `[原帖子圈子] ${post.circle || '公开动态'}`,
      `[原帖子媒体] ${describeForumMediaForAI(post.media) || '无'}`,
      `[原帖子正文] ${post.content || '无'}`
    ].join('\n');
    const nextText = String(await sendToAIForSummary(prompt) || '').trim();
    if (!nextText) return showDynamicIsland('AI 没有返回可用内容');
    post.content = nextText.replace(/^["“]|["”]$/g, '');
    post.translation = '';
    post.updatedAt = Date.now();
    await saveState();
    renderApp();
    if (currentDetailPost?.id === postId) {
      currentDetailPost = post;
      renderPostDetailContent();
    }
    showDynamicIsland('帖子已重新生成');
  } catch (error) {
    console.error('Forum post regenerate failed:', error);
    showDynamicIsland('重新生成失败，请检查 API 设置');
  }
}

function openCommentComposer(post) {
  openSheet('评论', `
    <div class="forum-compose-form">
      <p class="forum-quoted">${escapeHTML(post.content)}</p>
      <input id="forum-comment-text" type="text" placeholder="写一条评论">
      <button class="forum-primary-btn" id="forum-comment-save" type="button">发送</button>
    </div>
  `, root => {
    root.querySelector('#forum-comment-save').addEventListener('click', async () => {
      const text = root.querySelector('#forum-comment-text').value.trim();
      if (!text) return;
      const space = getCurrentSpace();
      const currentUser = getCurrentForumUser(space);
      post.comments.push({ user: currentUser.name, text, createdAt: Date.now() });
      bumpForumPostDiscussionHeat(post, 1);
      await saveState();
      closeModal();
      renderApp();
    });
  });
}
/* ▼▼▼ 替换处：修改后的代码 (极致极简版) ▼▼▼ */
function renderCircles(space) {
  const circles = getForumSharedDiscoverCircles(space);
  const trends = getForumDiscoverTrends(space);
  els.feed.innerHTML = `
    <div class="forum-discover-container">
      
      <!-- 极简顶栏 -->
      <div class="forum-discover-header">
        <div class="dh-top-row">
          <div class="dh-title-group">
            <h2>探索发现</h2>
            <span>Discover</span>
          </div>
          
          <div class="dh-actions">
            <!-- AI 生成按钮 -->
            <button class="icon-btn" id="forum-discover-ai-btn" aria-label="AI生成">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"></path>
              </svg>
            </button>
            <!-- 发帖按钮 -->
            <button class="icon-btn" onclick="document.getElementById('forum-compose-btn')?.click()" aria-label="发帖">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
              </svg>
            </button>
          </div>
        </div>

        <div class="dh-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <input id="forum-discover-search-input" type="text" placeholder="搜索角色、小号、NPC 或圈子...">
          <div class="dh-search-results" id="forum-discover-search-results" hidden></div>
        </div>
      </div>

      <div class="forum-discover-body">
        
        <!-- 热搜榜区 (带左右结构的标题) -->
        <div class="minimal-section-title">
          <div class="title-left">
            <h3>全站热搜</h3>
            <span>Trending</span>
          </div>
          <button class="title-right-btn forum-trend-manage-btn" id="forum-trend-manage-btn" title="管理热搜" aria-label="管理热搜" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path></svg>
          </button>
        </div>
        <!-- 热搜卡片 -->
        <div class="forum-trending-card">
          ${trends.map((t, i) => `
            <div class="trend-item" data-trend-id="${escapeHTML(t.id)}" role="button" tabindex="0">
              <span class="num top${i + 1}">${i + 1}</span>
              <span class="txt">${escapeHTML(t.text)}</span>
              <span class="hot-tag">${escapeHTML(t.tag || '')}</span>
            </div>
          `).join('')}
        </div>

        <!-- 圈子分组区 (带右侧添加按钮) -->
        <div class="minimal-section-title">
          <div class="title-left">
            <h3>圈子分组</h3>
            <span>Circles</span>
          </div>
          <button class="title-right-btn" id="forum-add-circle-btn" title="新建圈子">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </button>
        </div>
        
        <div class="forum-circle-grid">
          ${circles.map(circle => `
            <button class="minimal-circle-card circle-item" data-circle="${escapeHTML(circle.name)}" type="button">
              <div class="card-top">
                <h4>${escapeHTML(circle.name)}</h4>
                <div class="post-badge">
                  <strong>${getCirclePosts(space, circle.name).length}</strong>
                  <small>Posts</small>
                </div>
              </div>
              <p class="card-desc">${escapeHTML(circle.desc)}</p>
            </button>
          `).join('') || `
            <div class="forum-circle-detail-empty" style="grid-column: 1 / -1; margin-top: 20px;">
              <strong>当前论坛方案还没有圈子</strong>
              <span>创建一个圈子后，主号和小号都会在这里看到。</span>
            </div>
          `}
        </div>

      </div>
    </div>
  `;

  const searchInput = els.feed.querySelector('#forum-discover-search-input');
  const searchResults = els.feed.querySelector('#forum-discover-search-results');
  const updateSearchResults = () => {
    const query = searchInput?.value.trim() || '';
    if (!searchResults) return;
    if (!query) {
      searchResults.hidden = true;
      searchResults.innerHTML = '';
      return;
    }
    const results = getForumDiscoverSearchResults(space, query);
    searchResults.innerHTML = renderForumDiscoverSearchResults(results, query);
    searchResults.hidden = false;
  };
  searchInput?.addEventListener('input', updateSearchResults);
  searchInput?.addEventListener('focus', updateSearchResults);
  els.feed.addEventListener('click', e => {
    if (!e.target.closest('.dh-search') && searchResults) searchResults.hidden = true;
  });
  searchResults?.addEventListener('mousedown', e => e.preventDefault());
  searchResults?.addEventListener('click', async e => {
    const row = e.target.closest('[data-forum-search-kind]');
    if (!row) return;
    const kind = row.dataset.forumSearchKind;
    const id = row.dataset.forumSearchId || '';
    const name = row.dataset.forumSearchName || '';
    searchResults.hidden = true;
    if (kind === 'create') {
      openForumDiscoverCreateChoice(name);
      return;
    }
    if (kind === 'circle') {
      activeView = 'circleDetail';
      activeCircle = id;
      activeCircleDetailTab = 'latest';
      renderApp();
      return;
    }
    if (kind === 'alias') {
      space.currentAliasId = id;
      activeView = 'profile';
      activeCircle = 'all';
      activeCircleDetailTab = 'latest';
      await saveState();
      renderApp();
      showDynamicIsland('已切换到这个小号');
      return;
    }
    if (kind === 'profile') openForumPostAuthorProfile(id);
  });

  els.feed.querySelector('#forum-trend-manage-btn')?.addEventListener('click', openForumDiscoverTrendManager);

  els.feed.querySelectorAll('[data-trend-id]').forEach(btn => {
    const openTrend = () => {
      activeView = 'circleDetail';
      activeCircle = `trend:${btn.dataset.trendId}`;
      activeCircleDetailTab = 'latest';
      renderApp();
    };
    btn.addEventListener('click', openTrend);
    btn.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      openTrend();
    });
  });
  
  // 绑定圈子点击逻辑 (进入对应圈子列表)
  els.feed.querySelectorAll('.circle-item').forEach(btn => {
    btn.addEventListener('click', () => {
      activeView = 'circleDetail';
      activeCircle = btn.dataset.circle;
      activeCircleDetailTab = 'latest';
      renderApp();
    });
  });

  // 绑定 AI 生成按钮反馈
  const aiBtn = els.feed.querySelector('#forum-discover-ai-btn');
  if (aiBtn) {
    aiBtn.addEventListener('click', openForumDiscoverAiMenu);
  }

  // 绑定新增的添加圈子按钮
  const addCircleBtn = els.feed.querySelector('#forum-add-circle-btn');
  if (addCircleBtn) {
    addCircleBtn.addEventListener('click', () => {
      openForumDiscoverCircleCreator();
    });
  }
}
/* ▲▲▲ 替换到此结束，下面应该是函数的大括号 } 或是其他函数的开始 */
function renderMessages(space, options = {}) {
  const root = els.messagesContent;
  if (!root) return;
  const preserveDmScroll = Boolean(options.preserveDmScroll);
  const previousDmScrollTop = preserveDmScroll ? root.querySelector('.forum-dm-thread-body')?.scrollTop : null;
  const messages = space.messages || [];
  const conversations = getDmConversations(space);
  const conversationIds = new Set(conversations.map(item => String(item.toId)));
  [...forumDmSelectedConversationIds].forEach(id => {
    if (!conversationIds.has(String(id))) forumDmSelectedConversationIds.delete(id);
  });
  const activeConversation = activeDmTargetId ? conversations.find(item => item.toId === activeDmTargetId) || createEmptyDmConversation(space, activeDmTargetId, activeDmTargetName) : null;
  const settingsConversation = activeDmSettingsTargetId ? conversations.find(item => item.toId === activeDmSettingsTargetId) || createEmptyDmConversation(space, activeDmSettingsTargetId, activeDmTargetName) : null;
  const currentUser = getCurrentForumUser(space);
  const isDmSeedGenerating = Boolean(forumDmSeedAbortController);
  document.getElementById('page-forum-messages')?.classList.toggle('dm-thread-open', Boolean(activeConversation || settingsConversation));

  if (settingsConversation) {
    renderForumDmSettingsPage(space, settingsConversation);
    return;
  }

  if (activeConversation) {
    const isDmGenerating = forumDmGeneratingTargets.has(activeConversation.toId);
    const dmThreadClass = getForumDmThreadClass(space, activeConversation.toId);
    const dmThreadStyle = getForumDmThreadStyle(space, activeConversation.toId);
    root.innerHTML = `
      <section class="forum-messages-page forum-messages-thread ${dmThreadClass} ${activeDmSelection?.toId === activeConversation.toId ? 'is-dm-selecting' : ''}" style="${escapeHTML(dmThreadStyle)}">
        <header class="forum-messages-thread-header">
          <button class="forum-dm-back-btn" id="forum-dm-back-btn" type="button" aria-label="返回私信列表">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"></path></svg>
          </button>
          <img src="${activeConversation.avatar}" alt="">
          <div class="forum-dm-header-identity">
            <strong>${escapeHTML(activeConversation.toName)}</strong>
            <span>@${escapeHTML(activeConversation.account)}</span>
          </div>
          <button class="forum-dm-more-btn" id="forum-dm-more-btn" type="button" aria-label="更多">
            <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg>
          </button>
        </header>
        <div class="forum-dm-thread-body">
          ${renderDmThreadBodyContent(activeConversation, isDmGenerating)}
        </div>
        <form class="forum-dm-inline-composer ${isDmGenerating ? 'is-generating' : ''}" id="forum-dm-inline-composer">
          <input id="forum-dm-inline-input" type="text" placeholder="${isDmGenerating ? `${escapeHTML(activeConversation.toName)}正在输入...` : `发消息给 ${escapeHTML(activeConversation.toName)}...`}" autocomplete="off" enterkeyhint="send">
          <button class="forum-dm-regen-btn detail-soft-icon-btn" type="button" title="${isDmGenerating ? '生成中' : '重新生成'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.7 7.2h3.1V4.1"></path><path d="M20 7.2A8 8 0 1 0 21 12"></path></svg>
          </button>
          <button class="forum-dm-send-btn ${isDmGenerating ? 'is-stop' : ''}" type="button" title="${isDmGenerating ? '停止生成' : '发送'}">
            ${isDmGenerating
              ? `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"></rect></svg>`
              : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"></path><path d="m22 2-7 20-4-9-9-4 20-7Z"></path></svg>`}
          </button>
        </form>
        ${activeDmSelection?.toId === activeConversation.toId ? `
          <div class="forum-dm-selection-bar">
            <span>已选 ${activeDmSelection.ids.size} 条</span>
            <button type="button" data-dm-selection-action="copy">复制</button>
            <button type="button" data-dm-selection-action="delete">删除</button>
            <button type="button" data-dm-selection-action="cancel">取消</button>
          </div>
        ` : ''}
      </section>
    `;

    root.querySelector('#forum-dm-back-btn')?.addEventListener('click', () => {
      activeDmTargetId = null;
      activeDmSelection = null;
      activeDmSettingsTargetId = null;
      renderMessages(space);
    });
    root.querySelector('#forum-dm-more-btn')?.addEventListener('click', () => {
      activeDmSettingsTargetId = activeConversation.toId;
      renderMessages(space);
    });
    root.querySelector('[data-dm-profile-id]')?.addEventListener('click', () => {
      openForumDmTargetProfile(activeConversation.toId);
    });
    root.querySelector('[data-dm-load-older]')?.addEventListener('click', () => {
      expandForumDmOlderMessages(space, activeConversation);
    });
    bindDmInlineComposer(space, activeConversation.toId, activeConversation.toName);
    bindForumDmMessageInteractions(space, activeConversation);
    setTimeout(() => {
      const body = root.querySelector('.forum-dm-thread-body');
      if (!body) return;
      if (preserveDmScroll && previousDmScrollTop !== null && previousDmScrollTop !== undefined) {
        body.scrollTop = previousDmScrollTop;
      } else {
        body.scrollTop = body.scrollHeight;
      }
    }, 0);
    return;
  }

  root.innerHTML = `
    <section class="forum-messages-page ${forumDmListSelectionMode ? 'is-dm-list-selecting' : ''}">
      <header class="forum-messages-hero">
        <button class="forum-messages-back-btn" id="forum-messages-back-btn" type="button" aria-label="返回论坛">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"></path></svg>
        </button>
        <div class="forum-messages-title">
          <span>DIRECT MESSAGES</span>
          <h3>私信</h3>
        </div>
        <button id="forum-dm-select-mode-btn" type="button" title="${forumDmListSelectionMode ? '退出多选' : '多选删除'}">
          ${forumDmListSelectionMode
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>`}
        </button>
        <button id="forum-dm-compose-hint" class="${isDmSeedGenerating ? 'is-generating' : ''}" type="button" title="${isDmSeedGenerating ? '停止生成私信' : '从角色主页或帖子作者处发起私信'}" ${forumDmListSelectionMode ? 'hidden' : ''}>
          ${isDmSeedGenerating
            ? `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"></rect></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`}
        </button>
      </header>
      <div class="forum-dm-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>
        <span>搜索私信</span>
      </div>
      <div class="forum-dm-list">
        ${conversations.map(item => `
          <div class="forum-dm-card-row ${forumDmSelectedConversationIds.has(String(item.toId)) ? 'is-selected' : ''}" data-dm-row-id="${escapeHTML(item.toId)}">
            <button class="forum-dm-row-delete" data-dm-delete-id="${escapeHTML(item.toId)}" type="button">删除</button>
            <button class="forum-dm-card" data-dm-to-id="${escapeHTML(item.toId)}" type="button">
              <span class="forum-dm-row-check" data-dm-toggle-select-id="${escapeHTML(item.toId)}"></span>
              <img src="${item.avatar}" alt="">
              <div class="dm-card-main">
                <div class="dm-card-top">
                  <span>${escapeHTML(item.toName)}</span>
                  <time>${formatDmTime(item.lastMessage?.createdAt)}</time>
                </div>
                <p>${escapeHTML(getForumDmPreviewText(item.lastMessage))}</p>
              </div>
              ${item.unreadCount > 0 ? `<small>${item.unreadCount}</small>` : ''}
            </button>
          </div>
        `).join('') || `
          <div class="forum-dm-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            <h4>还没有私信</h4>
            <p>可以从角色主页的“发消息”，或帖子作者旁的私信入口开始。</p>
          </div>
        `}
      </div>
      ${forumDmListSelectionMode ? `
        <div class="forum-dm-bulk-bar">
          <span>已选 ${forumDmSelectedConversationIds.size} 个会话</span>
          <button type="button" id="forum-dm-bulk-delete-btn" ${forumDmSelectedConversationIds.size ? '' : 'disabled'}>删除已选</button>
        </div>
      ` : ''}
    </section>
  `;

  root.querySelector('#forum-messages-back-btn')?.addEventListener('click', () => {
    forumDmListSelectionMode = false;
    forumDmSelectedConversationIds.clear();
    showPage('page-forum');
  });

  root.querySelectorAll('[data-dm-to-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (forumDmListSelectionMode) {
        toggleForumDmConversationSelection(btn.dataset.dmToId);
        renderMessages(space);
        return;
      }
      const row = btn.closest('.forum-dm-card-row');
      if (row?.dataset.skipOpen === 'true') {
        row.dataset.skipOpen = '';
        return;
      }
      if (row?.classList.contains('is-delete-open')) {
        closeForumDmSwipeRows(root);
        return;
      }
      activeDmTargetId = btn.dataset.dmToId;
      activeDmSelection = null;
      activeDmSettingsTargetId = null;
      markForumDmConversationRead(space, activeDmTargetId);
      saveState().catch(error => console.error('Forum DM read mark failed:', error));
      renderMessages(space);
    });
  });
  bindForumDmCardSwipeActions(root, space);
  root.querySelector('#forum-dm-select-mode-btn')?.addEventListener('click', () => {
    closeForumDmSwipeRows(root);
    forumDmListSelectionMode = !forumDmListSelectionMode;
    forumDmSelectedConversationIds.clear();
    renderMessages(space);
  });
  root.querySelector('#forum-dm-bulk-delete-btn')?.addEventListener('click', () => {
    deleteForumDmConversations(space, [...forumDmSelectedConversationIds]);
  });

  root.querySelector('#forum-dm-compose-hint')?.addEventListener('click', () => {
    if (forumDmSeedAbortController) {
      forumDmSeedAbortController.abort();
      return;
    }
    generateForumDmFromRecentActivity(space);
  });
}

function openMessagesPage() {
  const space = getCurrentSpace();
  if (!space) return;
  Forum.markContextSeen();
  renderMessages(space);
  showPage('page-forum-messages');
}

function openDmComposer(toId, toName) {
  const space = getCurrentSpace();
  ensureForumProfileDmMember(space, toId, toName);
  activeView = 'messages';
  activeDmTargetId = toId;
  activeDmTargetName = toName;
  activeDmSelection = null;
  activeDmSettingsTargetId = null;
  clearForumDmConversationDeleted(space, toId);
  markForumDmConversationRead(space, toId);
  openMessagesPage();
  saveState().catch(error => console.error('Forum DM read mark failed:', error));
  els.bottomNav?.querySelectorAll('button').forEach(btn => btn.classList.toggle('active', btn.dataset.forumView === 'messages'));
  setTimeout(() => {
    const input = document.getElementById('forum-dm-inline-input');
    if (input) input.placeholder = `发消息给 ${toName}...`;
    input?.focus();
  }, 50);
}

function ensureForumProfileDmMember(space, toId, toName = '') {
  if (!space || !toId) return;
  if (findForumDmAliasAccount(space, toId)) return;
  space.members = Array.isArray(space.members) ? space.members : [];
  if (space.members.some(member => String(member.id) === String(toId))) return;
  const profile = space.forumProfiles?.[toId] || {};
  const authorPost = (space.posts || []).find(post => String(post.authorId || '') === String(toId));
  if (!profile.nickname && !profile.account && !profile.avatar && !authorPost) return;
  const name = profile.nickname || toName || authorPost?.authorName || '论坛网友';
  const avatar = profile.avatar || authorPost?.avatar || DEFAULT_AVATAR_SRC;
  space.members.push({
    id: toId,
    name,
    forumName: name,
    avatar,
    type: 'ordinaryNpc',
    sourceId: '',
    persona: profile.bio || '论坛里的普通账号。说话自然、短句、像真实网友，不要自称 AI。'
  });
  space.forumProfiles = space.forumProfiles && typeof space.forumProfiles === 'object' ? space.forumProfiles : {};
  space.forumProfiles[toId] = {
    ...profile,
    nickname: profile.nickname || name,
    account: profile.account || getForumAccount(space, toId, name),
    avatar,
    bio: profile.bio || '论坛里的普通账号。',
    isFollowed: profile.isFollowed !== false
  };
}

function getDmConversations(space) {
  const grouped = new Map();
  const currentUserKey = getCurrentForumUserKey(space);
  const readAtMap = space?.dmReadAt && typeof space.dmReadAt === 'object' ? space.dmReadAt : {};
  (space.messages || []).forEach(msg => {
    if (msg.ownerId && msg.ownerId !== currentUserKey) return;
    if (!msg.toId) return;
    const identity = getForumDmConversationIdentity(space, msg.toId, msg.toName || '未知用户');
    const item = grouped.get(msg.toId) || {
      toId: msg.toId,
      toName: identity.toName,
      account: identity.account,
      avatar: identity.avatar,
      messages: []
    };
    item.messages.push({ ...msg, fromSelf: msg.fromSelf !== false });
    item.toName = identity.toName;
    item.account = identity.account;
    item.avatar = identity.avatar;
    grouped.set(msg.toId, item);
  });

  return [...grouped.values()].map(item => {
    item.messages.sort((a, b) => a.createdAt - b.createdAt);
    item.lastMessage = item.messages[item.messages.length - 1];
    item.count = item.messages.length;
    const readAt = Number(readAtMap[item.toId] || 0);
    item.unreadCount = item.messages.filter(msg => msg.fromSelf === false && Number(msg.createdAt || 0) > readAt).length;
    return item;
  }).sort((a, b) => (b.lastMessage?.createdAt || 0) - (a.lastMessage?.createdAt || 0));
}

function createEmptyDmConversation(space, toId, toName = '') {
  const identity = getForumDmConversationIdentity(space, toId, toName || getForumDisplayName(space, toId, '未知用户'));
  return {
    toId,
    toName: identity.toName,
    account: identity.account,
    avatar: identity.avatar,
    messages: [],
    lastMessage: null,
    count: 0,
    unreadCount: 0
  };
}

function markForumDmConversationRead(space, toId) {
  if (!space || !toId) return;
  space.dmReadAt = space.dmReadAt && typeof space.dmReadAt === 'object' ? space.dmReadAt : {};
  space.dmReadAt[toId] = Date.now();
}

function toggleForumDmConversationSelection(toId) {
  const id = String(toId || '');
  if (!id) return;
  if (forumDmSelectedConversationIds.has(id)) {
    forumDmSelectedConversationIds.delete(id);
  } else {
    forumDmSelectedConversationIds.add(id);
  }
}

function closeForumDmSwipeRows(root = els.messagesContent) {
  root?.querySelectorAll('.forum-dm-card-row.is-delete-open, .forum-dm-card-row.is-swiping').forEach(row => {
    row.classList.remove('is-delete-open', 'is-swiping');
    row.dataset.skipOpen = '';
    const card = row.querySelector('.forum-dm-card');
    if (card) card.style.transform = '';
  });
}

function ensureForumDeletedDmConversations(space) {
  if (!space) return {};
  space.deletedDmConversations = space.deletedDmConversations && typeof space.deletedDmConversations === 'object' && !Array.isArray(space.deletedDmConversations)
    ? space.deletedDmConversations
    : {};
  return space.deletedDmConversations;
}

function getForumDeletedDmKey(space, toId, userKey = getCurrentForumUserKey(space)) {
  return `${userKey || 'default'}:${toId}`;
}

function markForumDmConversationDeleted(space, toId, userKey = getCurrentForumUserKey(space)) {
  if (!space || !toId) return;
  ensureForumDeletedDmConversations(space)[getForumDeletedDmKey(space, toId, userKey)] = Date.now();
}

function clearForumDmConversationDeleted(space, toId, userKey = getCurrentForumUserKey(space)) {
  if (!space?.deletedDmConversations || !toId) return;
  delete space.deletedDmConversations[getForumDeletedDmKey(space, toId, userKey)];
  delete space.deletedDmConversations[toId];
}

function isForumDmConversationDeleted(space, toId, userKey = getCurrentForumUserKey(space)) {
  return Boolean(space?.deletedDmConversations && toId && space.deletedDmConversations[getForumDeletedDmKey(space, toId, userKey)]);
}

async function deleteForumDmConversations(space, toIds = []) {
  const ids = [...new Set((Array.isArray(toIds) ? toIds : [toIds]).map(id => String(id || '')).filter(Boolean))];
  if (!space || !ids.length) return;
  const label = ids.length === 1 ? '这个私信会话' : `选中的 ${ids.length} 个私信会话`;
  if (!confirm(`确定要删除${label}吗？`)) return;
  ids.forEach(id => abortForumDmReply(id, space));
  const idSet = new Set(ids);
  const currentUserKey = getCurrentForumUserKey(space);
  space.messages = (space.messages || []).filter(msg => {
    const sameOwner = !msg.ownerId || msg.ownerId === currentUserKey;
    return !(sameOwner && idSet.has(String(msg.toId || '')));
  });
  ids.forEach(id => markForumDmConversationDeleted(space, id, currentUserKey));
  if (space.dmReadAt && typeof space.dmReadAt === 'object') ids.forEach(id => delete space.dmReadAt[id]);
  ids.forEach(id => {
    forumDmVisibleMessageCounts.delete(id);
    forumDmSelectedConversationIds.delete(id);
  });
  if (idSet.has(String(activeDmTargetId || ''))) {
    activeDmTargetId = null;
    activeDmTargetName = '';
    activeDmSelection = null;
  }
  if (idSet.has(String(activeDmSettingsTargetId || ''))) activeDmSettingsTargetId = null;
  if (!forumDmSelectedConversationIds.size) forumDmListSelectionMode = false;
  await saveState();
  renderMessages(space);
  showDynamicIsland(ids.length === 1 ? '已删除会话' : `已删除 ${ids.length} 个会话`);
}

function bindForumDmCardSwipeActions(root, space) {
  closeForumDmSwipeRows(root);
  root.querySelectorAll('.forum-dm-card-row').forEach(row => {
    const card = row.querySelector('.forum-dm-card');
    const deleteBtn = row.querySelector('[data-dm-delete-id]');
    if (!card) return;
    let startX = 0;
    let startY = 0;
    let latestX = 0;
    let tracking = false;
    let lockedHorizontal = false;
    card.addEventListener('pointerdown', event => {
      if (forumDmListSelectionMode || event.button > 0) return;
      startX = event.clientX;
      startY = event.clientY;
      latestX = startX;
      tracking = true;
      lockedHorizontal = false;
    });
    card.addEventListener('pointermove', event => {
      if (!tracking || forumDmListSelectionMode) return;
      latestX = event.clientX;
      const dx = latestX - startX;
      const dy = event.clientY - startY;
      if (!lockedHorizontal && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) {
        tracking = false;
        return;
      }
      if (dx >= -6 && !row.classList.contains('is-delete-open')) return;
      lockedHorizontal = true;
      const offset = Math.min(0, Math.max(-84, row.classList.contains('is-delete-open') ? -84 + dx : dx));
      row.classList.add('is-swiping');
      card.style.transform = `translateX(${offset}px)`;
      row.dataset.skipOpen = 'true';
    });
    const finishSwipe = () => {
      if (!tracking && !lockedHorizontal) return;
      const dx = latestX - startX;
      const shouldOpen = row.classList.contains('is-delete-open') ? dx < 36 : dx < -46;
      closeForumDmSwipeRows(root);
      if (shouldOpen) {
        row.classList.add('is-delete-open');
        row.dataset.skipOpen = 'true';
      }
      tracking = false;
      lockedHorizontal = false;
    };
    card.addEventListener('pointerup', finishSwipe);
    card.addEventListener('pointercancel', finishSwipe);
    deleteBtn?.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      deleteForumDmConversations(space, [deleteBtn.dataset.dmDeleteId]);
    });
  });
}

function getStableForumDmIdFromName(name, scope = '') {
  const text = String(name || '匿名网友').trim() || '匿名网友';
  const source = scope ? `${String(scope)}\u0000${text}` : text;
  let hash = 0;
  for (let i = 0; i < source.length; i++) hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  return `ordinary_dm_${hash.toString(36)}`;
}

function normalizeForumAccountKey(value) {
  return String(value || '').replace(/^@/, '').trim().toLowerCase();
}

function isOrdinaryForumIdentity(item = {}) {
  const identity = String(item.identity || item.senderIdentity || '').trim().toLowerCase();
  return identity === 'passer' || identity === 'ordinarynpc';
}

function getProtectedForumAccountKeys(space) {
  const keys = new Set();
  const add = value => {
    const key = normalizeForumAccountKey(value);
    if (key) keys.add(key);
  };
  (space?.members || []).filter(member => !isForumTemporaryOrdinaryMember(member)).forEach(member => {
    const displayName = getForumDisplayName(space, member.id, member.name);
    add(member.id);
    add(member.name);
    add(displayName);
    add(getForumAccount(space, member.id, displayName));
    const fixedAlias = getForumCharacterFixedAlias(space, member.id);
    if (fixedAlias) {
      add(fixedAlias.id);
      add(fixedAlias.name);
      add(fixedAlias.account);
    }
  });
  (space?.aliases || []).forEach(alias => {
    add(alias.id);
    add(alias.name);
    add(alias.account);
  });
  return keys;
}

function getSafeOrdinaryForumName(space, name) {
  const fallbackName = String(name || '').trim() || '匿名网友';
  const protectedKeys = getProtectedForumAccountKeys(space);
  if (!protectedKeys.has(normalizeForumAccountKey(fallbackName))) return fallbackName;
  const safeName = `${fallbackName}的同名网友`;
  return protectedKeys.has(normalizeForumAccountKey(safeName))
    ? `普通网友_${getStableForumDmIdFromName(fallbackName).replace('ordinary_dm_', '')}`
    : safeName;
}

function resolveForumDmSender(space, item = {}, options = {}) {
  const rawName = String(item.toName || item.speaker || item.from || item.name || '').trim();
  const identity = String(item.identity || item.senderIdentity || '').trim().toLowerCase();
  const isOrdinarySender = isOrdinaryForumIdentity(item);
  const fallbackName = isOrdinarySender ? getSafeOrdinaryForumName(space, rawName) : (rawName || '匿名网友');
  const explicitId = String(item.toId || item.memberId || '').trim();
  if (identity === 'alias') {
    const fixedAliasMatch = findForumFixedAliasByInput(space, {
      rawName,
      realName: item.realName || item.real || '',
      explicitId
    });
    if (fixedAliasMatch?.alias) {
      return {
        toId: fixedAliasMatch.alias.id,
        toName: fixedAliasMatch.alias.name || fallbackName,
        avatar: fixedAliasMatch.alias.avatar || space.forumProfiles?.[fixedAliasMatch.owner.id]?.aliasAvatar || fixedAliasMatch.owner.avatar || DEFAULT_AVATAR_SRC
      };
    }
    if (fixedAliasMatch?.owner) {
      if (fixedAliasMatch.owner.type !== 'character') {
        return {
          toId: fixedAliasMatch.owner.id,
          toName: getForumDisplayName(space, fixedAliasMatch.owner.id, fixedAliasMatch.owner.name),
          avatar: getForumAvatar(space, fixedAliasMatch.owner.id)
        };
      }
      const ownerName = getForumDisplayName(space, fixedAliasMatch.owner.id, fixedAliasMatch.owner.name);
      const aliasName = rawName && normalizeForumAccountKey(rawName) !== normalizeForumAccountKey(ownerName)
        ? rawName
        : `${ownerName}的小号`;
      const virtualAlias = ensureForumVirtualAliasProfile(space, fixedAliasMatch.owner, aliasName);
      if (virtualAlias) {
        return {
          toId: virtualAlias.id,
          toName: virtualAlias.name,
          avatar: virtualAlias.avatar
        };
      }
    }
  }
  const member = (space?.members || []).find(m => {
    const displayName = getForumDisplayName(space, m.id, m.name);
    const account = getForumAccount(space, m.id, displayName);
    const isOrdinaryMember = m.type === 'ordinaryNpc' || String(m.id || '').startsWith('ordinary_dm_');
    const explicitMatch = explicitId && String(m.id) === explicitId && (!isOrdinarySender || isOrdinaryMember);
    const nameMatch = !isOrdinarySender && (
      displayName === fallbackName
      || m.name === fallbackName
      || account === fallbackName.replace(/^@/, '')
    );
    return explicitMatch || nameMatch;
  });
  if (member) {
    return {
      toId: member.id,
      toName: getForumDisplayName(space, member.id, member.name),
      avatar: getForumAvatar(space, member.id)
    };
  }
  const ordinaryPostScope = isOrdinarySender && options.postId ? `post:${options.postId}` : '';
  const toId = String((isOrdinarySender ? '' : explicitId) || getStableForumDmIdFromName(fallbackName, ordinaryPostScope));
  const existingMember = (space?.members || []).find(member => String(member.id) === String(toId));
  return {
    toId,
    toName: fallbackName,
    avatar: existingMember ? getForumAvatar(space, toId) : (isOrdinarySender ? getForumOrdinaryNpcAvatar(fallbackName, [
      identity,
      item.content,
      item.reason,
      item.translation
    ].filter(Boolean).join(' ')) : dicebearAvatar(fallbackName))
  };
}

function ensureForumDmSenderMember(space, sender) {
  if (!space || !sender?.toId) return;
  space.members = Array.isArray(space.members) ? space.members : [];
  if (findForumDmAliasAccount(space, sender.toId)) return;
  if (space.members.some(member => String(member.id) === String(sender.toId))) return;
  const name = sender.toName || '匿名网友';
  const avatar = sender.avatar || getForumOrdinaryNpcAvatar(name);
  space.members.push({
    id: sender.toId,
    name,
    forumName: name,
    avatar,
    type: 'ordinaryNpc',
    sourceId: '',
    persona: '论坛里因为近期帖子或评论主动私信用户的普通网友。说话应自然、短句、像真实网友，不要自称 AI。'
  });
  space.forumProfiles = space.forumProfiles && typeof space.forumProfiles === 'object' ? space.forumProfiles : {};
  space.forumProfiles[sender.toId] = {
    ...(space.forumProfiles[sender.toId] || {}),
    nickname: name,
    account: getForumAccount(space, sender.toId, name),
    bio: '因为近期论坛互动而开始私聊的普通网友。',
    avatar,
    isFollowed: true
  };
}

function appendForumIncomingDm(space, sender, text, options = {}) {
  const body = String(text || '').trim();
  if (!space || !sender?.toId || !body) return null;
  if (options.source === 'comment_dm_hint' && isForumDmConversationDeleted(space, sender.toId)) return null;
  if (options.source === 'comment_dm_hint' && isForumCharacterBlockedByAi(space, sender.toId)) return null;
  ensureForumDmSenderMember(space, sender);
  space.messages = Array.isArray(space.messages) ? space.messages : [];
  const message = {
    id: `dm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ownerId: getCurrentForumUserKey(space),
    toId: sender.toId,
    toName: sender.toName || '匿名网友',
    text: body,
    translation: normalizeForumStandardMandarinTranslation(body, options.translation),
    fromSelf: false,
    createdAt: Date.now() + Number(options.offset || 0),
    source: options.source || 'forum_activity',
    sourcePostId: options.postId || null,
    reason: String(options.reason || '').trim()
  };
  space.messages.push(message);
  const messagesPage = document.getElementById('page-forum-messages');
  const isViewingThisDm = activeView === 'messages'
    && String(activeDmTargetId || '') === String(sender.toId || '')
    && !activeDmSettingsTargetId
    && messagesPage
    && getComputedStyle(messagesPage).display !== 'none';
  if (isViewingThisDm) {
    markForumDmConversationRead(space, sender.toId);
    appendForumDmMessageToThread(space, sender.toId, message);
  } else {
    import('./notification.js').then(module => {
      module.notification.show(sender.toName || '论坛私信', body, sender.avatar || DEFAULT_AVATAR_SRC, 'page-forum-dm', { spaceId: space.id, toId: sender.toId });
    }).catch(error => console.warn('[Forum] DM notification unavailable:', error));
  }
  return message;
}

function isOrdinaryForumDmSender(space, item = {}, sender = {}) {
  const identity = String(item.identity || item.senderIdentity || '').trim().toLowerCase();
  if (identity === 'passer' || identity === 'ordinarynpc') return true;
  const member = (space?.members || []).find(member => String(member.id) === String(sender.toId || item.toId || item.memberId || ''));
  if (!member) return true;
  return member.type === 'ordinaryNpc' || String(member.id || '').startsWith('ordinary_dm_');
}
async function generateForumDmStarterFromHint(space, sender, hint = {}) {
  if (!space || !sender?.toId) return;
  if (isForumDmConversationDeleted(space, sender.toId)) return;
  const aliasMatch = findForumDmAliasAccount(space, sender.toId);
  const member = aliasMatch
    ? (space.members || []).find(item => String(item.id) === String(aliasMatch.ownerId))
    : (space.members || []).find(item => String(item.id) === String(sender.toId));
  if (!member) return;
  if (isForumCharacterBlockedByAi(space, member)) return;
  try {
    // 复用完整私信系统的提示词，让开场白也遵守"是否认得出用户小号"的隔离逻辑
    const prompt = await buildForumDmPrompt(
      space,
      member,
      buildForumDmStarterText(space, hint, member),
      aliasMatch
        ? { starter: true, displayName: aliasMatch.alias.name, sourceMemberId: aliasMatch.ownerId, conversationId: sender.toId }
        : { starter: true, conversationId: sender.toId }
    );
    const raw = await sendForumCommentPromptToAI(prompt);
    const items = parseAiJsonArray(raw).filter(item => item && (item.type === 'text' || item.type === 'emoji'));
    if (!items.length) return;
    if (isForumCharacterBlockedByAi(space, member)) return;
    let added = 0;
    items.slice(0, 4).forEach((item, index) => {
      const text = item.type === 'emoji' ? '' : String(item.content || item.text || '').trim();
      if (!text) return;
      const msg = appendForumIncomingDm(space, sender, text, {
        translation: item.translation,
        reason: hint.reason,
        offset: 40 + index,
        source: 'comment_dm_hint'
      });
      if (msg) added += 1;
    });
    if (added > 0) {
      await saveState();
      if (activeView === 'messages' && !activeDmSettingsTargetId) renderMessages(space, { preserveDmScroll: true });
    }
  } catch (error) {
    console.error('Forum comment DM starter failed:', error);
  }
}
function appendForumDmHints(space, hints = [], post = null, options = {}) {
  if (!space || !Array.isArray(hints) || !hints.length) return 0;
  const configuredChance = Number(options.chance);
  const baseChance = Number.isFinite(configuredChance) ? Math.max(0, Math.min(1, configuredChance)) : 0.35;
  const gateRoll = options.randomGate ? Math.random() : 0;
  let count = 0;
  const configuredMax = Number(options.maxCount);
  const maxCount = Number.isFinite(configuredMax) && configuredMax > 0 ? Math.floor(configuredMax) : hints.length;
  const usedSenderIds = new Set();
  hints.slice(0, maxCount).forEach((item, index) => {
    const sender = resolveForumDmSender(space, item, { postId: post?.id || '' });
    // 角色拉黑用户时，评论触发的私信必须彻底消失（主号和小号共用这个状态）。
    if (isForumCharacterBlockedByAi(space, sender.toId)) return;
    const reconciliationSender = isForumCharacterSeekingReconciliation(space, sender.toId);
    const senderChance = reconciliationSender && baseChance > 0 ? Math.min(1, baseChance * 2 + 0.15) : baseChance;
    if (options.randomGate && gateRoll > senderChance) return;
    const claimedIdentity = String(item.identity || '').trim().toLowerCase();
    if (['character', 'npc', 'alias'].includes(claimedIdentity)) {
      const aliasMatch = findForumDmAliasAccount(space, sender.toId);
      const senderMember = (space.members || []).find(m => String(m.id) === String(sender.toId));
      const isRealActor = Boolean(aliasMatch)
        || (senderMember && ['character', 'npc', 'customNpc'].includes(senderMember.type));
      // 只拦「自称角色/主要NPC/角色小号、但方案里找不到这个真人」的假账号；普通路人NPC(identity=passer/ordinaryNpc)完全不受影响，照常私信
      if (!isRealActor) return;
    }
    const isOrdinarySender = isOrdinaryForumDmSender(space, item, sender);
    if (!isOrdinarySender && usedSenderIds.has(sender.toId)) return;
        if (!isOrdinarySender) {
      // 角色/主要NPC/角色小号：改走完整私信系统生成开场白，
      // 沿用私信里的身份隔离，评论区触发的私信不会再凭空认出用户小号
      generateForumDmStarterFromHint(space, sender, item);
      count += 1;
      return;
    }
    if (!isOrdinarySender) usedSenderIds.add(sender.toId);
    const text = String(item.text || item.content || item.message || '').trim();
    const msg = appendForumIncomingDm(space, sender, text, {
      translation: item.translation,
      reason: item.reason,
      postId: post?.id || null,
      offset: 40 + index,
      source: options.source || 'comment_dm_hint'
    });
    if (msg) count += 1;
  });
  return count;
}

function selectUniqueForumDmHints(space, hints = [], maxCount = 8) {
  const selected = [];
  const usedSenderIds = new Set();
  (Array.isArray(hints) ? hints : []).forEach(item => {
    if (!item || typeof item !== 'object') return;
    const sender = resolveForumDmSender(space, item);
    const text = String(item.text || item.content || item.message || '').trim();
    if (!text || usedSenderIds.has(sender.toId)) return;
    usedSenderIds.add(sender.toId);
    selected.push(item);
  });
  return selected.slice(0, Math.max(1, Math.min(8, Number(maxCount) || 8)));
}

function buildForumDmStarterText(space, hint = {}, member = null) {
  const currentUser = getCurrentForumUser(space);
  const knowledge = member ? getForumCurrentUserKnowledgeForMember(space, member) : null;
  const hideAliasOwner = Boolean(currentUser?.isAlias && knowledge && !knowledge.knownAsUser);
  const recentActivity = collectForumUserActivityForDmPrompt(space, 6, { member });
  const reason = String(hint.reason || '').trim();
  const seedContent = String(hint.content || hint.text || hint.message || '').trim();
  return [
    '（这不是用户发来的私信，而是论坛私信开场触发说明。）',
    '请你根据近期论坛动态主动给用户发起私信，不要提到“系统”“提示词”或“触发说明”。',
    hideAliasOwner ? '当前私信对象正在使用匿名小号；你还不知道这个账号属于用户本人。只能把它当普通论坛账号来私聊，禁止说认出、知道、猜到它是用户，也禁止使用用户主号资料或主聊天记忆。' : '',
    reason ? `触发原因：${reason}` : '',
    seedContent ? `${hideAliasOwner ? '可参考的开场意图（如果里面有认出小号/知道对方是用户的表达，必须改写掉）' : '可参考的开场意图'}：${seedContent}` : '',
    `近期${hideAliasOwner ? '当前匿名账号' : '用户'}论坛动态：\n${recentActivity}`
  ].filter(Boolean).join('\n');
}

function appendForumDmPromptItems(space, member, items = [], options = {}) {
  if (!space || !member || !Array.isArray(items) || !items.length) return 0;
  if (isForumCharacterBlockedByAi(space, member)) return 0;
  space.messages = Array.isArray(space.messages) ? space.messages : [];
  const currentUserKey = getCurrentForumUserKey(space);
  const now = Date.now() + Number(options.offset || 0);
  let count = 0;
  for (const item of items) {
    if (count >= 4) break;
    if (!item || (item.type !== 'text' && item.type !== 'emoji')) continue;
    const emoji = item.type === 'emoji' && FORUM_DM_REACTIONS.some(reaction => reaction.emoji === item.emoji) ? item.emoji : '';
    const text = item.type === 'emoji' ? '' : String(item.content || item.text || '').trim();
    if (!text && !emoji) continue;
    space.messages.push({
      id: `dm_${now}_${member.id}_${count}_${Math.random().toString(36).slice(2, 6)}`,
      ownerId: currentUserKey,
      toId: member.id,
      toName: getForumDisplayName(space, member.id, member.name),
      text,
      translation: normalizeForumStandardMandarinTranslation(text, item.translation),
      ...(emoji ? { emoji, emojiMeaning: String(item.meaning || '').trim() || getForumDmReactionMeaning(emoji) } : {}),
      fromSelf: false,
      createdAt: now + count,
      source: options.source || 'forum_dm_prompt_seed',
      reason: String(options.reason || '').trim()
    });
    count += 1;
  }
  return count;
}

function getForumDmBatchMessages(item = {}) {
  const rawMessages = Array.isArray(item.messages)
    ? item.messages
    : [{ type: item.type || 'text', content: item.content || item.text || item.message || '', translation: item.translation || '' }];
  return rawMessages
    .filter(msg => msg && typeof msg === 'object')
    .map(msg => ({
      type: msg.type === 'emoji' ? 'emoji' : 'text',
      content: String(msg.content || msg.text || '').trim(),
      translation: normalizeForumStandardMandarinTranslation(msg.content || msg.text || '', msg.translation),
      emoji: msg.emoji,
      meaning: msg.meaning
    }))
    .filter(msg => msg.type === 'emoji' ? FORUM_DM_REACTIONS.some(reaction => reaction.emoji === msg.emoji) : Boolean(msg.content))
    .slice(0, 4);
}

function isForumDmBatchSenderCurrentUser(space, item = {}, sender = {}) {
  const currentUser = getCurrentForumUser(space);
  const mainUserId = `user_${space?.identityId}`;
  const userAliases = (space?.aliases || []).map(alias => alias.id);
  const userNames = [
    currentUser?.id,
    currentUser?.name,
    currentUser?.account,
    mainUserId,
    ...(space?.aliases || []).flatMap(alias => [alias.id, alias.name, alias.account])
  ].map(value => String(value || '').replace(/^@/, '').trim()).filter(Boolean);
  const senderValues = [
    sender.toId,
    sender.toName,
    item.toId,
    item.memberId,
    item.speaker,
    item.from,
    item.name
  ].map(value => String(value || '').replace(/^@/, '').trim()).filter(Boolean);
  return senderValues.some(value => userNames.includes(value)) || userAliases.includes(String(sender.toId || ''));
}

function normalizeForumDmBatchConversations(space, items = []) {
  const selected = [];
  const usedSenderIds = new Set();
  let knownActorCount = 0;
  (Array.isArray(items) ? items : []).forEach(item => {
    if (!item || typeof item !== 'object') return;
    const sender = resolveForumDmSender(space, item);
    if (!sender?.toId || usedSenderIds.has(sender.toId)) return;
    if (isForumCharacterBlockedByAi(space, sender.toId)) return;
    if (isForumDmBatchSenderCurrentUser(space, item, sender)) return;
    const messages = getForumDmBatchMessages(item);
    if (!messages.length) return;
    const knownActor = isForumDmKnownActorSender(space, item, sender);
    if (knownActor && knownActorCount >= 2) return;
    usedSenderIds.add(sender.toId);
    if (knownActor) knownActorCount += 1;
    selected.push({ item, sender, messages });
  });
  return selected.slice(0, 5);
}

function isForumDmKnownActorSender(space, item = {}, sender = {}) {
  const identity = String(item.identity || '').trim();
  if (['character', 'npc', 'alias'].includes(identity)) return true;
  const member = (space?.members || []).find(entry => String(entry.id) === String(sender.toId || item.toId || item.memberId || ''));
  return Boolean(member && ['character', 'npc', 'customNpc'].includes(member.type));
}

function collectForumUserActivityForDmPrompt(space, limit = 12, options = {}) {
  const currentUser = getCurrentForumUser(space);
  const userId = currentUser?.id;
  if (!space || !userId) return '（暂无用户论坛动态）';
  const knowledge = options.member ? getForumCurrentUserKnowledgeForMember(space, options.member) : null;
  const userLabel = currentUser?.isAlias && knowledge && !knowledge.knownAsUser ? '当前匿名账号' : '用户';
  const items = [];
  const userNames = new Set([
    currentUser?.name,
    currentUser?.account,
    space?.forumProfiles?.[userId]?.nickname
  ].map(value => String(value || '').replace(/^@/, '').trim()).filter(Boolean));
  const cut = (value, max = 70) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}...` : text;
  };
  (space.posts || []).forEach(post => {
    if (post.authorId === userId) {
      const mediaText = describeForumMediaForAI(post.media);
      const brief = String(post.forumBriefSummary || '').trim();
      items.push({
        t: post.createdAt || 0,
        text: `${userLabel}发帖｜${post.circle || '公开动态'}｜${cut(post.content || mediaText, 80)}${brief ? `｜简介：${cut(brief, 70)}` : ''}`
      });
    }
    const walk = (comments = [], floor = 0) => comments.forEach(comment => {
      const commentText = cut(comment.text || comment.content, 70);
      if (comment.authorId === userId) {
        items.push({
          t: comment.createdAt || 0,
          text: `${comment.replyToRealCharId ? `${userLabel}回复角色` : `${userLabel}评论`}｜在「${cut(post.content || post.circle, 26)}」下说：${commentText}`
        });
      } else if (post.authorId === userId || userNames.has(String(comment.replyToUser || '').replace(/^@/, '').trim())) {
        items.push({
          t: comment.createdAt || 0,
          text: `别人互动${userLabel}｜${cut(comment.user || comment.speaker || '论坛网友', 18)} 在「${cut(post.content || post.circle, 22)}」下说：${commentText}`
        });
      }
      walk(comment.replies || [], floor + 1);
    });
    walk(post.comments || []);
  });
  return items
    .sort((a, b) => (b.t || 0) - (a.t || 0))
    .slice(0, limit)
    .map(item => `- ${item.text}`)
    .join('\n') || '（暂无用户论坛动态）';
}

function getForumRecentDmThreadsForSeedPrompt(space, limit = 6) {
  const conversations = getDmConversations(space)
    .filter(item => !isForumCharacterBlockedByAi(space, item.toId));
  if (!conversations.length) return '（暂无已有论坛私信）';
  return conversations.slice(0, limit).map(item => {
    const last = item.lastMessage ? getForumDmPreviewText(item.lastMessage) : '暂无消息';
    return `- ${item.toName}(@${item.account})｜${item.count || 0}条｜最近：${cutForumInlineText(last, 50)}`;
  }).join('\n');
}

async function buildForumDmSeedPrompt(space) {
  const currentUser = getCurrentForumUser(space);
  const knownMembers = (space.members || [])
    .filter(member => !isForumTemporaryOrdinaryMember(member))
    .filter(member => !isForumCharacterBlockedByAi(space, member))
    .slice(0, 20);
  const worldBookContext = await getForumGenerationContext({ ...space, members: knownMembers }, null, '论坛私信批量生成');
  const worldBookData = await resolveForumWorldBookPromptData(space, {
    label: '论坛私信批量生成候选人',
    privateMemberIds: knownMembers.map(member => member.id)
  });
  const fixedAliasRule = buildForumFixedAliasRule(space, knownMembers) || '无';
  const knownPeopleLines = [];
  for (const member of knownMembers) {
    const displayName = getForumDisplayName(space, member.id, member.name);
    const profile = space.forumProfiles?.[member.id] || {};
    const memberActivity = getForumMemberRecentActivityText(space, member.id, 4);
    let memory = '无';
    try {
      memory = await getMemoriesForPrompt(member.sourceId || member.id) || '无';
    } catch {
      memory = '无';
    }
    knownPeopleLines.push(`<PrivateDmActor id="${member.id}" name="${displayName}" type="${member.type || 'unknown'}">
Only this exact sender may use this private block. Ordinary passers, ordinary NPCs, other known characters, and aliases of other people must NOT know, quote, hint at, or borrow it.
account=@${getForumAccount(space, member.id, displayName)}｜celebrity=${profile.isFamous ? 'yes' : 'no'}｜fans=${normalizeFansCount(profile.fans ?? member.fans)}
主页简介：${profile.bio || '无'}
角色/NPC设定：${getForumMemberPersona(member) || member.persona || member.bio || '无'}
近期论坛动态：${memberActivity}
角色记忆：${memory}
${worldBookData.privateTexts?.[member.id] ? `私有世界书：${worldBookData.privateTexts[member.id]}` : '私有世界书：无'}
</PrivateDmActor>`);
  }
  const knownPeople = knownPeopleLines.join('\n') || '（暂无固定角色/NPC）';
  const recentActivity = collectForumUserActivityForDmPrompt(space, 12);
  const userDigests = getForumDmUserDigestsText(space, currentUser?.id, '论坛私信批量生成');
  const recentDmThreads = getForumRecentDmThreadsForSeedPrompt(space, 6);
  const trends = getForumTrendsForDmPrompt(space) || '（暂无热搜）';
  const activeEvent = [buildForumActiveEventPrompt(space, 'feed'), buildForumEventHistoryPrompt(space)].filter(Boolean).join('\n') || '（暂无大事件）';
  const userProfile = space.forumProfiles?.[currentUser?.id] || {};
  const userAliases = (space.aliases || [])
    .map(alias => `- ${alias.name || alias.nickname || alias.id}(@${alias.account || alias.id}) id=${alias.id}`)
    .join('\n') || '无';
  return `[System: Forum Direct Message Batch Mode]
You generate 5 separate forum DM conversations in ONE response. These private messages feel naturally triggered by recent public forum activity.
Return ONLY a JSON array, no markdown, no explanation.

# Language & translation rules
This forum is primarily Chinese-language. Most DM bubbles MUST be natural Chinese. If a known character/NPC's persona, memory, world, or circle culture requires Cantonese, dialect, foreign language, classical wording, etc., keep that original wording in "content" and put the 标准普通话 meaning in Simplified Chinese inside "translation". If "content" is already 标准普通话, "translation" MUST be an empty string. NEVER translate standard Mandarin Chinese into English. NEVER put English in "translation".

# Forum / World Book / Public Settings
${worldBookContext}

# Current forum account receiving these DMs
- id=${currentUser?.id || 'user'}
- name=${currentUser?.name || '用户'}
- account=@${currentUser?.account || 'user'}
- bio=${currentUser?.bio || userProfile.bio || '无'}
- accountType=${currentUser?.isAlias ? '用户小号' : '用户主号'}
- all user aliases that must NEVER be senders:
${userAliases}

# Recent user activity
${recentActivity}

# Other public user digests
${userDigests}

# Existing DM thread overview for this account
${recentDmThreads}

# Forum trends / events
${trends}
${activeEvent}

# Known characters / NPCs
${knownPeople}

# Fixed alias rules for characters
${fixedAliasRule}

# Rules
- Generate exactly 5 conversations.
- Each conversation must come from a DIFFERENT sender. Do not repeat the same speaker or toId.
- At least 3 of the 5 senders MUST be ordinary passers / ordinary NPCs. Known characters, main NPCs, and fixed aliases may appear at most 2 total. It is valid to use 0 known characters/NPCs.
- The sender may be a known character/NPC/fixed alias OR an ordinary passer/ordinary NPC invented for this forum.
- If using a known character/NPC, fill "toId" with that exact id above.
- If using an ordinary passer/NPC, leave "toId" empty and use a natural Chinese internet handle as "speaker".
- If using a known character/NPC, obey their persona, memory, private world book, relationships, and forum activity above.
- Ordinary passers/NPCs may only know public forum posts, public comments, hot searches, world facts, and what they personally could plausibly see. They MUST NOT know or hint at any private character memory, private world book, or main-chat history.
- The DMs must be related to the user's recent posts/comments/interactions, not random greetings.
- Keep every message short, phone-like, natural, and not too dramatic.
- Each conversation must contain 1 to 4 message bubbles.
- NEVER generate a message from the current user account. The current user is only the receiver.
- NEVER set speaker/toId to the current user id, current user name, current user account, the user's main account, or any user alias.
- Do not fill the batch with the role or main NPCs. Use the homepage-feed rhythm: most senders are everyday people who noticed something, asked a small question, shared a tip, sent gossip, or reacted privately.
- If an existing DM thread is listed above, do not contradict its latest state and do not pretend it is a first meeting.

[
  {
    "speaker": "sender display name",
    "identity": "ordinaryNpc | passer | character | npc | alias",
    "toId": "known member id or empty",
    "messages": [
      {"type": "text", "content": "private DM bubble", "translation": ""},
      {"type": "emoji", "emoji": "one of ❤️ 😂 😮 😢 😡 👍", "meaning": "short emotional meaning"}
    ],
    "reason": "short reason for debugging"
  }
]`;
}

async function generateForumDmFromRecentActivity(space) {
  if (!space) return;
  const btn = document.getElementById('forum-dm-compose-hint');
  const oldTitle = btn?.title;
  let generationStartedAt = 0;
  const controller = new AbortController();
  forumDmSeedAbortController = controller;
  try {
    if (btn) {
      btn.disabled = false;
      btn.title = '停止生成私信';
      btn.classList.add('is-generating');
    }
    renderMessages(space);
    const prompt = await buildForumDmSeedPrompt(space);
    const raw = await sendForumCommentPromptToAI(prompt, [], controller.signal);
    const conversations = normalizeForumDmBatchConversations(space, parseAiJsonArray(raw));
    if (conversations.length < 5) {
      showDynamicIsland('这次没有生成满 5 个发信人，请再试一次');
      return;
    }
    generationStartedAt = Date.now();
    let count = 0;
    conversations.forEach(({ item, sender, messages }, index) => {
      if (controller.signal.aborted) return;
      ensureForumDmSenderMember(space, sender);
      const member = (space.members || []).find(entry => String(entry.id) === String(sender.toId));
      if (!member) return;
      const added = appendForumDmPromptItems(space, member, messages, {
        offset: index * 20,
        source: 'manual_dm_prompt_seed',
        reason: item.reason
      });
      if (added > 0) count += 1;
    });
    if (count < 5) {
      space.messages = (space.messages || []).filter(msg =>
        !(msg.source === 'manual_dm_prompt_seed' && Number(msg.createdAt || 0) >= generationStartedAt)
      );
      showDynamicIsland('这次没有生成满 5 个发信人，请再试一次');
      return;
    }
    if (!count) {
      showDynamicIsland('暂时没有合适的新私信');
      return;
    }
    await saveState();
    renderMessages(space);
    showDynamicIsland(`收到 ${count} 条新私信`);
  } catch (error) {
    if (generationStartedAt) {
      space.messages = (space.messages || []).filter(msg =>
        !(msg.source === 'manual_dm_prompt_seed' && Number(msg.createdAt || 0) >= generationStartedAt)
      );
    }
    if (error?.name === 'AbortError') {
      showDynamicIsland('已停止生成私信');
    } else {
      console.error('Forum DM seed failed:', error);
      showDynamicIsland('私信生成失败');
    }
  } finally {
    if (forumDmSeedAbortController === controller) forumDmSeedAbortController = null;
    if (btn) {
      btn.disabled = false;
      btn.title = oldTitle || '根据近期论坛动态生成私信';
      btn.classList.remove('is-generating');
    }
    renderMessages(space);
  }
}

function getForumDmPreviewText(msg) {
  if (!msg) return '开始新的对话';
  if (msg.contentType === FORUM_COUPLE_INVITE_TYPE) {
    const status = msg.coupleInvite?.status || msg.inviteStatus || 'pending';
    if (status === 'accepted') return '[情侣邀请] 已绑定';
    if (status === 'rejected') return '[情侣邀请] 已拒绝';
    if (status === 'revoked') return '[情侣邀请] 已撤回';
    return '[情侣邀请卡片]';
  }
  const text = String(msg.text || '').trim();
  if (text) return text;
  if (msg.emoji) return `[表情] ${msg.emoji}`;
  if (msg.sticker?.explanation) return `[表情] ${msg.sticker.explanation}`;
  const reactions = Array.isArray(msg.reactions) ? msg.reactions : [];
  if (reactions.length) return `[回应] ${reactions[reactions.length - 1].emoji || '表情'}`;
  return '开始新的对话';
}

function getForumCoupleInviteStatus(msg) {
  return msg?.coupleInvite?.status || msg?.inviteStatus || 'pending';
}

function getForumCoupleInviteLabel(invite = {}) {
  if (invite.accountType === 'alias') return '角色小号';
  if (invite.accountType === 'npc') return '主要 NPC';
  return '角色主号';
}

function getPendingForumCoupleInviteMessage(space, toId) {
  const currentUserKey = getCurrentForumUserKey(space);
  return (space?.messages || [])
    .filter(msg =>
      (!msg.ownerId || msg.ownerId === currentUserKey) &&
      String(msg.toId || '') === String(toId || '') &&
      msg.contentType === FORUM_COUPLE_INVITE_TYPE &&
      getForumCoupleInviteStatus(msg) === 'pending'
    )
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
}

function getForumCoupleInvitePromptContext(space, toId) {
  const msg = getPendingForumCoupleInviteMessage(space, toId);
  if (!msg) {
    const candidate = getForumCoupleCandidate(space, toId);
    const boundTargetId = getForumCoupleBoundTargetId(space);
    if (candidate && !boundTargetId) {
      return [
        `当前没有等待处理的论坛情侣账号邀请，也没有已绑定情侣账号。`,
        `如果你主动想和用户绑定 YOUR current forum account，可以输出 {"type":"send_couple_invite","reason":"..."} 发送邀请卡片。`,
        `当前账号：${candidate.name} @${candidate.account || candidate.name}（${candidate.label}）`
      ].join('\n');
    }
    if (boundTargetId) return `当前情侣账号状态：${formatCoupleLine(space)}。不要重复发送情侣邀请。`;
    return '（当前没有等待处理的论坛情侣账号邀请；这个私聊对象不能发起情侣绑定）';
  }
  const invite = msg.coupleInvite || {};
  const direction = invite.direction === 'target_to_user' ? '你向用户发出的邀请' : '用户向你发出的邀请';
  return [
    `有一张等待处理的论坛情侣账号邀请卡片。`,
    `邀请方向：${direction}`,
    `绑定对象：${invite.targetName || msg.toName || '对方'}`,
    `账号类型：${getForumCoupleInviteLabel(invite)}`,
    `如果你同意，请输出 {"type":"couple_invite_decision","decision":"accept","reason":"..."}。如果你拒绝，请输出 {"type":"couple_invite_decision","decision":"reject","reason":"..."}。`
  ].join('\n');
}

function createForumCoupleInvitePayload(space, targetId) {
  const candidate = getForumCoupleCandidate(space, targetId);
  if (!candidate) return null;
  return {
    targetId: candidate.targetId,
    memberId: candidate.memberId,
    targetName: candidate.name,
    targetAccount: candidate.account,
    targetAvatar: candidate.avatar,
    accountType: candidate.accountType,
    label: candidate.label,
    status: 'pending',
    createdAt: Date.now()
  };
}

function renderForumCoupleInviteCard(activeConversation, msg) {
  const invite = msg.coupleInvite || {};
  const status = getForumCoupleInviteStatus(msg);
  const accountLabel = getForumCoupleInviteLabel(invite);
  const targetName = invite.targetName || activeConversation.toName || '对方';
  const targetAccount = invite.targetAccount || activeConversation.account || '';
  let actionHtml = '';
  if (status === 'accepted') {
    actionHtml = '<div class="forum-couple-invite-status accepted">已绑定情侣账号</div>';
  } else if (status === 'rejected') {
    actionHtml = '<div class="forum-couple-invite-status rejected">已拒绝邀请</div>';
  } else if (status === 'revoked') {
    actionHtml = '<div class="forum-couple-invite-status rejected">邀请已撤回</div>';
  } else if (msg.fromSelf === false) {
    actionHtml = `
      <div class="forum-couple-invite-actions">
        <button type="button" data-couple-invite-action="reject">拒绝</button>
        <button type="button" data-couple-invite-action="accept">同意绑定</button>
      </div>
    `;
  } else {
    actionHtml = `
      <div class="forum-couple-invite-actions">
        <button type="button" data-couple-invite-action="revoke">撤回</button>
        <button type="button" data-couple-invite-action="accept">确认 Ta 已同意</button>
      </div>
    `;
  }
  return `
    <article class="forum-couple-invite-card">
      <div class="forum-couple-invite-kicker">COUPLE ACCOUNT</div>
      <div class="forum-couple-invite-main">
        <img src="${escapeHTML(invite.targetAvatar || activeConversation.avatar || DEFAULT_AVATAR_SRC)}" alt="">
        <div>
          <strong>${escapeHTML(targetName)}</strong>
          <span>@${escapeHTML(targetAccount)}</span>
        </div>
      </div>
      <p>${msg.fromSelf === false ? 'Ta 向你发送了情侣账号绑定邀请。' : '你向 Ta 发送了情侣账号绑定邀请。'}</p>
      <div class="forum-couple-invite-meta">${escapeHTML(accountLabel)}</div>
      ${actionHtml}
    </article>
  `;
}

async function appendForumCoupleInviteMessage(space, targetId, direction = 'user_to_target', options = {}) {
  const invite = createForumCoupleInvitePayload(space, targetId);
  if (!space || !invite) {
    if (!options.silent) showDynamicIsland('这个账号不能绑定');
    return null;
  }
  const boundTargetId = getForumCoupleBoundTargetId(space);
  if (boundTargetId && boundTargetId !== String(invite.targetId)) {
    if (options.skipConfirm) return null;
    const currentLine = formatCoupleLine(space);
    if (!confirm(`${currentLine}。继续发送新邀请会在同意后覆盖原绑定，确定继续吗？`)) return null;
  }
  if (boundTargetId && boundTargetId === String(invite.targetId)) {
    if (!options.silent) showDynamicIsland('已经绑定这个账号了');
    return null;
  }
  if (getPendingForumCoupleInviteMessage(space, invite.targetId)) {
    if (!options.silent) showDynamicIsland('已经有待处理的邀请了');
    return null;
  }
  space.messages = Array.isArray(space.messages) ? space.messages : [];
  clearForumDmConversationDeleted(space, invite.targetId);
  const fromSelf = direction !== 'target_to_user';
  const message = {
    id: `dm_couple_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ownerId: getCurrentForumUserKey(space),
    toId: invite.targetId,
    toName: invite.targetName,
    text: fromSelf ? `想和你绑定论坛情侣账号（${getForumCoupleInviteLabel(invite)}）` : `想和我绑定论坛情侣账号（${getForumCoupleInviteLabel(invite)}）`,
    contentType: FORUM_COUPLE_INVITE_TYPE,
    inviteStatus: 'pending',
    coupleInvite: invite,
    fromSelf,
    createdAt: Date.now(),
    source: 'forum_couple_invite'
  };
  message.coupleInvite.direction = direction;
  space.couplePending = {
    ...invite,
    direction,
    messageId: message.id
  };
  space.messages.push(message);
  await saveState();
  if (options.skipOpen) {
    if (activeDmTargetId === invite.targetId) appendForumDmMessageToThread(space, invite.targetId, message);
  } else {
    closeModal();
    openDmComposer(invite.targetId, invite.targetName);
  }
  if (!options.silent) showDynamicIsland(fromSelf ? '情侣邀请卡片已发送' : 'Ta 的邀请卡片已送达');
  return message;
}

async function handleForumCoupleInviteAction(space, activeConversation, messageId, action) {
  const msg = findForumDmStoredMessage(space, activeConversation.toId, messageId);
  if (!msg || msg.contentType !== FORUM_COUPLE_INVITE_TYPE) return;
  const invite = msg.coupleInvite || {};
  if (action === 'accept') {
    const boundTargetId = getForumCoupleBoundTargetId(space);
    if (boundTargetId && boundTargetId !== String(invite.targetId || activeConversation.toId)) {
      if (!confirm('已经绑定了别的情侣账号，确定改绑到这张邀请卡吗？')) return;
    }
    const nextCouple = {
      status: 'bound',
      userId: `user_${currentIdentity().id}`,
      memberId: invite.memberId || activeConversation.toId,
      targetId: invite.targetId || activeConversation.toId,
      targetName: invite.targetName || activeConversation.toName,
      targetAccount: invite.targetAccount || activeConversation.account,
      targetAvatar: invite.targetAvatar || activeConversation.avatar,
      accountType: invite.accountType || 'main',
      since: Date.now(),
      inviteMessageId: msg.id
    };
    msg.inviteStatus = 'accepted';
    msg.coupleInvite = { ...invite, ...nextCouple, status: 'accepted', acceptedAt: Date.now() };
    space.couple = nextCouple;
    space.couplePending = null;
    await saveState();
    await notifyMainChatOfForumCoupleChange(space, nextCouple, 'bind').catch(error => console.warn('[Forum] couple chat link failed:', error));
    refreshForumDmThreadBody(space, activeConversation.toId, { preserveDmScroll: true });
    renderApp();
    showDynamicIsland('情侣账号已绑定');
    return;
  }
  if (action === 'reject' || action === 'revoke') {
    const nextStatus = action === 'revoke' ? 'revoked' : 'rejected';
    msg.inviteStatus = nextStatus;
    msg.coupleInvite = { ...invite, status: nextStatus };
    if (space.couplePending?.messageId === msg.id) space.couplePending = null;
    await saveState();
    refreshForumDmThreadBody(space, activeConversation.toId, { preserveDmScroll: true });
    renderApp();
    showDynamicIsland(action === 'revoke' ? '邀请已撤回' : '已拒绝邀请');
  }
}

async function applyForumCoupleInviteDecisionFromAi(space, toId, decision) {
  const msg = getPendingForumCoupleInviteMessage(space, toId);
  if (!msg) return false;
  const activeConversation = getForumDmConversation(space, toId);
  await handleForumCoupleInviteAction(space, activeConversation, msg.id, decision === 'accept' ? 'accept' : 'reject');
  return true;
}

async function sendForumCoupleInviteFromAi(space, toId) {
  if (!space || !toId) return false;
  if (!getForumCoupleCandidate(space, toId)) return false;
  if (getForumCoupleBoundTargetId(space)) return false;
  if (getPendingForumCoupleInviteMessage(space, toId)) return false;
  const message = await appendForumCoupleInviteMessage(space, toId, 'target_to_user', {
    skipOpen: true,
    skipConfirm: true,
    silent: true
  });
  return Boolean(message);
}

function getForumAvatar(space, id) {
  const identity = currentIdentity();
  if (id === `user_${identity?.id}`) return identity?.avatar || DEFAULT_AVATAR_SRC;
  const foundAlias = findForumDmAliasAccount(space, id);
  if (foundAlias) {
    const owner = (space?.members || []).find(item => item.id === foundAlias.ownerId);
    return foundAlias.alias.avatar || space?.forumProfiles?.[foundAlias.ownerId]?.aliasAvatar || owner?.avatar || DEFAULT_AVATAR_SRC;
  }
  const member = space.members.find(item => item.id === id);
  return member?.avatar || space?.forumProfiles?.[id]?.avatar || DEFAULT_AVATAR_SRC;
}

function getForumDmConversationIdentity(space, toId, fallbackName = '') {
  const id = String(toId || '');
  const aliasMatch = findForumDmAliasAccount(space, id);
  if (aliasMatch) {
    const aliasName = aliasMatch.alias?.name || fallbackName || '角色小号';
    return {
      toName: aliasName,
      account: aliasMatch.alias?.account || aliasName,
      avatar: getForumAvatar(space, id)
    };
  }
  const member = (space?.members || []).find(item => String(item.id) === id);
  let memberName = member ? getForumDisplayName(space, member.id, member.name) : '';
  const duplicateNameMatch = isForumTemporaryOrdinaryMember(member) && memberName.match(/^(.*)的同名网友$/);
  if (duplicateNameMatch && !getProtectedForumAccountKeys(space).has(normalizeForumAccountKey(duplicateNameMatch[1]))) {
    memberName = duplicateNameMatch[1];
  }
  const profile = space?.forumProfiles?.[id] || {};
  const name = memberName || profile.nickname || fallbackName || '未知用户';
  return {
    toName: name,
    account: getForumAccount(space, id, name),
    avatar: getForumAvatar(space, id)
  };
}

function getForumMemberSourceCharacterId(member) {
  const candidateIds = [member?.sourceId, member?.id].filter(Boolean);
  const profiles = AppState.characterProfiles || [];
  return candidateIds.find(id => profiles.some(char => String(char.id) === String(id))) || '';
}

function normalizeForumDmSettings(settings = {}) {
  const contextMode = settings.contextMode === 'custom' ? 'custom' : 'main';
  const backgroundId = (FORUM_DM_BACKGROUND_PRESETS.some(item => item.id === settings.background) ? settings.background : 'clean');
  const themeId = (FORUM_DM_BUBBLE_THEMES.some(item => item.id === settings.bubbleTheme) ? settings.bubbleTheme : 'mono');
  const contextTurns = Math.max(
    FORUM_DM_CONTEXT_MIN_TURNS,
    Math.min(FORUM_DM_CONTEXT_MAX_TURNS, Number(settings.contextTurns) || FORUM_DM_DEFAULT_CONTEXT_TURNS)
  );
  return {
    contextMode,
    contextTurns,
    background: backgroundId,
    backgroundImage: typeof settings.backgroundImage === 'string' ? settings.backgroundImage : '',
    bubbleTheme: themeId
  };
}

function getForumDmSettings(space, toId) {
  return normalizeForumDmSettings(space?.dmSettings?.[toId]);
}

function setForumDmSettings(space, toId, nextSettings) {
  if (!space || !toId) return;
  space.dmSettings = space.dmSettings && typeof space.dmSettings === 'object' ? space.dmSettings : {};
  space.dmSettings[toId] = normalizeForumDmSettings(nextSettings);
}

function getForumDmResolvedContextTurns(space, member, conversationId = '') {
  const settings = getForumDmSettings(space, conversationId || member?.id);
  if (settings.contextMode === 'custom') return settings.contextTurns;
  const sourceId = getForumMemberSourceCharacterId(member);
  const char = (AppState.characterProfiles || []).find(item => String(item.id) === String(sourceId));
  return Math.max(
    FORUM_DM_CONTEXT_MIN_TURNS,
    Math.min(FORUM_DM_CONTEXT_MAX_TURNS, Number(char?.contextTurns) || FORUM_DM_DEFAULT_CONTEXT_TURNS)
  );
}

function getForumDmConversationMember(space, conversation) {
  const toId = conversation?.toId;
  const foundAlias = findForumDmAliasAccount(space, toId);
  if (foundAlias) {
    const owner = (space?.members || []).find(item => String(item.id) === String(foundAlias.ownerId));
    if (owner) return owner;
  }
  return (space?.members || []).find(item => String(item.id) === String(toId)) || { id: toId, name: conversation?.toName };
}

function getForumDmThreadClass(space, toId) {
  const settings = getForumDmSettings(space, toId);
  return `forum-dm-theme-${settings.bubbleTheme} ${settings.backgroundImage ? 'forum-dm-has-custom-bg' : 'forum-dm-bg-clean'}`;
}

function getForumDmThreadStyle(space, toId) {
  const settings = getForumDmSettings(space, toId);
  if (!settings.backgroundImage) return '';
  return `--forum-dm-page-bg-image: url(${JSON.stringify(settings.backgroundImage)});`;
}

function formatDmTime(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatDmDateLabel(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function isSameDmDay(a, b) {
  if (!a || !b) return false;
  const left = new Date(a);
  const right = new Date(b);
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

function isSameDmMessageGroup(left, right) {
  if (!left || !right) return false;
  return (left.fromSelf === false) === (right.fromSelf === false) && isSameDmDay(left.createdAt, right.createdAt);
}

function getForumDmVisibleMessageData(activeConversation) {
  const messages = activeConversation.messages || [];
  const visibleCount = forumDmVisibleMessageCounts.get(activeConversation.toId) || FORUM_DM_VISIBLE_MESSAGE_COUNT;
  const hiddenCount = Math.max(0, messages.length - visibleCount);
  return {
    hiddenCount,
    messages: messages.slice(hiddenCount)
  };
}

function renderDmThreadBodyContent(activeConversation, isDmGenerating = false) {
  const visibleData = getForumDmVisibleMessageData(activeConversation);
  const visibleConversation = { ...activeConversation, messages: visibleData.messages };
  return `
    <section class="forum-dm-profile-card">
      <img src="${activeConversation.avatar}" alt="">
      <strong>${escapeHTML(activeConversation.toName)}</strong>
      <span>@${escapeHTML(activeConversation.account)}</span>
      <button type="button" data-dm-profile-id="${escapeHTML(activeConversation.toId)}">查看主页</button>
    </section>
    ${visibleData.hiddenCount > 0 ? `<button class="forum-dm-load-older" type="button" data-dm-load-older>查看更早 ${visibleData.hiddenCount} 条消息</button>` : ''}
    ${renderDmThreadMessages(visibleConversation)}
    ${isDmGenerating ? `
      <div class="forum-dm-bubble-row incoming forum-dm-typing-row">
        <img src="${activeConversation.avatar}" alt="">
        <div class="forum-dm-typing-bubble" aria-label="${escapeHTML(activeConversation.toName)}正在输入">
          <span></span><span></span><span></span>
        </div>
      </div>
    ` : ''}
  `;
}

function renderForumDmSettingsPage(space, activeConversation) {
  const root = els.messagesContent;
  if (!root || !space || !activeConversation) return;
  const member = getForumDmConversationMember(space, activeConversation);
  const currentSettings = getForumDmSettings(space, activeConversation.toId);
  const contextTurns = getForumDmResolvedContextTurns(space, member, activeConversation.toId);
  const themeButtons = FORUM_DM_BUBBLE_THEMES.map(option => `
    <button type="button" class="forum-dm-choice-btn ${currentSettings.bubbleTheme === option.id ? 'is-active' : ''}" data-dm-theme-option="${escapeHTML(option.id)}">
      <b>${escapeHTML(option.label)}</b>
      <span>${escapeHTML(option.short)}</span>
      <small>${escapeHTML(option.desc)}</small>
    </button>
  `).join('');

  root.innerHTML = `
    <section class="forum-messages-page forum-dm-settings-page">
      <header class="forum-messages-thread-header">
        <button class="forum-dm-back-btn" id="forum-dm-settings-back-btn" type="button" aria-label="返回私信">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"></path></svg>
        </button>
        <div class="forum-dm-header-identity">
          <strong>私聊设置</strong>
          <span>${escapeHTML(activeConversation.toName)}</span>
        </div>
      </header>
      <div class="forum-dm-settings-page-body">
        <div class="forum-dm-settings-sheet">
          <div class="forum-dm-settings-hero">
            <span>DM SETTINGS</span>
            <h4>${escapeHTML(activeConversation.toName)}</h4>
            <p>背景、气泡和上下文轮数只影响这一条私聊</p>
          </div>

          <section class="forum-dm-settings-group">
            <div class="forum-dm-settings-group-head">
              <span>CONTEXT</span>
              <small>读取主聊天历史，或单独设一套轮数</small>
            </div>
            <div class="forum-dm-toggle-row">
              <button type="button" class="forum-dm-toggle-btn ${currentSettings.contextMode !== 'custom' ? 'is-active' : ''}" data-dm-context-mode="main">跟随主聊天</button>
              <button type="button" class="forum-dm-toggle-btn ${currentSettings.contextMode === 'custom' ? 'is-active' : ''}" data-dm-context-mode="custom">单独设置轮数</button>
            </div>
            <label class="forum-mini-field forum-dm-turns-field">
              <span>读取轮数</span>
              <input id="forum-dm-context-turns" type="number" min="${FORUM_DM_CONTEXT_MIN_TURNS}" max="${FORUM_DM_CONTEXT_MAX_TURNS}" step="1" value="${escapeHTML(String(contextTurns))}">
            </label>
            <small class="forum-dm-settings-note">“跟随主聊天”会直接使用角色聊天设置里的上下文轮数。</small>
          </section>

          <section class="forum-dm-settings-group">
            <div class="forum-dm-settings-group-head">
              <span>BACKGROUND</span>
              <small>上传图片作为当前私聊背景</small>
            </div>
            <div class="forum-dm-upload-box">
              <div class="forum-dm-upload-preview ${currentSettings.backgroundImage ? 'has-image' : ''}" id="forum-dm-bg-preview" ${currentSettings.backgroundImage ? `style="background-image: url(${JSON.stringify(currentSettings.backgroundImage)})"` : ''}>
                <span>${currentSettings.backgroundImage ? '' : 'NO IMAGE'}</span>
              </div>
              <div class="forum-dm-upload-actions">
                <button type="button" class="forum-dm-upload-btn" id="forum-dm-bg-upload-btn">上传图片</button>
                <button type="button" class="forum-dm-clear-bg-btn" id="forum-dm-bg-clear-btn">清除背景</button>
              </div>
              <input id="forum-dm-bg-file-input" type="file" accept="image/*" hidden>
              <small class="forum-dm-settings-note">建议用横图，系统会自动铺满整条私聊。</small>
            </div>
          </section>

          <section class="forum-dm-settings-group">
            <div class="forum-dm-settings-group-head">
              <span>BUBBLE THEME</span>
              <small>气泡和发送按钮会一起换色</small>
            </div>
            <div class="forum-dm-choice-grid" data-dm-choice-group="theme">
              ${themeButtons}
            </div>
          </section>

          <section class="forum-dm-settings-group">
            <div class="forum-dm-settings-group-head">
              <span>CLEAR CHAT</span>
              <small>只清这条私聊，不动别的对话</small>
            </div>
            <button type="button" class="forum-dm-destructive-btn" id="forum-dm-clear-history-btn">清空聊天记录</button>
          </section>

          <div class="forum-dm-settings-actions">
            <button type="button" class="forum-dm-save-btn" id="forum-dm-settings-save-btn">完成</button>
          </div>
        </div>
      </div>
    </section>
  `;

  bindForumDmSettingsPageControls(root, space, activeConversation, currentSettings);
}

function bindForumDmSettingsPageControls(root, space, activeConversation, currentSettings) {
  const settingsCard = root.querySelector('.forum-dm-settings-sheet');
  const turnsInput = root.querySelector('#forum-dm-context-turns');
  const saveBtn = root.querySelector('#forum-dm-settings-save-btn');
  const clearBtn = root.querySelector('#forum-dm-clear-history-btn');
  const uploadBtn = root.querySelector('#forum-dm-bg-upload-btn');
  const clearBgBtn = root.querySelector('#forum-dm-bg-clear-btn');
  const fileInput = root.querySelector('#forum-dm-bg-file-input');
  const bgPreview = root.querySelector('#forum-dm-bg-preview');
  const modeButtons = Array.from(root.querySelectorAll('[data-dm-context-mode]'));
  const themeButtonsEls = Array.from(root.querySelectorAll('[data-dm-theme-option]'));
  const draftSettings = {
    contextMode: currentSettings.contextMode,
    contextTurns: currentSettings.contextTurns,
    background: currentSettings.background,
    backgroundImage: currentSettings.backgroundImage || '',
    bubbleTheme: currentSettings.bubbleTheme
  };

  const syncFieldState = () => {
    const customMode = draftSettings.contextMode === 'custom';
    if (turnsInput) turnsInput.disabled = !customMode;
    modeButtons.forEach(btn => btn.classList.toggle('is-active', btn.dataset.dmContextMode === draftSettings.contextMode));
    themeButtonsEls.forEach(btn => btn.classList.toggle('is-active', btn.dataset.dmThemeOption === draftSettings.bubbleTheme));
    if (settingsCard) {
      settingsCard.classList.remove(...FORUM_DM_BUBBLE_THEMES.map(item => `forum-dm-theme-${item.id}`));
      settingsCard.classList.add(`forum-dm-theme-${draftSettings.bubbleTheme}`);
    }
    if (!bgPreview) return;
    if (draftSettings.backgroundImage) {
      bgPreview.classList.add('has-image');
      bgPreview.style.backgroundImage = `url("${draftSettings.backgroundImage}")`;
      bgPreview.innerHTML = '<span></span>';
    } else {
      bgPreview.classList.remove('has-image');
      bgPreview.style.backgroundImage = 'none';
      bgPreview.innerHTML = '<span>NO IMAGE</span>';
    }
  };
  const readTurnValue = () => Math.max(
    FORUM_DM_CONTEXT_MIN_TURNS,
    Math.min(FORUM_DM_CONTEXT_MAX_TURNS, Number(turnsInput?.value) || FORUM_DM_DEFAULT_CONTEXT_TURNS)
  );

  root.querySelector('#forum-dm-settings-back-btn')?.addEventListener('click', () => {
    activeDmSettingsTargetId = null;
    renderMessages(space, { preserveDmScroll: true });
  });
  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      draftSettings.contextMode = btn.dataset.dmContextMode === 'custom' ? 'custom' : 'main';
      syncFieldState();
    });
  });
  themeButtonsEls.forEach(btn => {
    btn.addEventListener('click', () => {
      draftSettings.bubbleTheme = btn.dataset.dmThemeOption || 'mono';
      syncFieldState();
    });
  });
  uploadBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showDynamicIsland('请选择图片文件');
      fileInput.value = '';
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      showDynamicIsland('图片太大了，换小一点的试试');
      fileInput.value = '';
      return;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    }).catch(() => '');
    if (!dataUrl) {
      showDynamicIsland('图片读取失败');
      fileInput.value = '';
      return;
    }
    draftSettings.backgroundImage = dataUrl;
    syncFieldState();
    fileInput.value = '';
  });
  clearBgBtn?.addEventListener('click', () => {
    draftSettings.backgroundImage = '';
    syncFieldState();
  });
  turnsInput?.addEventListener('input', () => {
    draftSettings.contextTurns = readTurnValue();
    turnsInput.value = String(draftSettings.contextTurns);
  });
  saveBtn?.addEventListener('click', async () => {
    draftSettings.contextTurns = readTurnValue();
    draftSettings.backgroundImage = String(draftSettings.backgroundImage || '');
    setForumDmSettings(space, activeConversation.toId, draftSettings);
    await saveState();
    activeDmSettingsTargetId = null;
    renderMessages(space, { preserveDmScroll: true });
    showDynamicIsland('私聊设置已保存');
  });
  clearBtn?.addEventListener('click', async () => {
    if (!confirm('确定要清空这条私聊记录吗？')) return;
    const currentUserKey = getCurrentForumUserKey(space);
    space.messages = (space.messages || []).filter(msg => {
      const sameConversation = (!msg.ownerId || msg.ownerId === currentUserKey) && msg.toId === activeConversation.toId;
      return !sameConversation;
    });
    activeDmSelection = null;
    forumDmVisibleMessageCounts.delete(activeConversation.toId);
    await saveState();
    activeDmSettingsTargetId = null;
    renderMessages(space);
    showDynamicIsland('已清空私聊记录');
  });

  syncFieldState();
}

function openForumDmSettingsSheet(space, activeConversation) {
  if (!space || !activeConversation) return;
  const member = getForumDmConversationMember(space, activeConversation);
  const currentSettings = getForumDmSettings(space, activeConversation.toId);
  const contextTurns = getForumDmResolvedContextTurns(space, member, activeConversation.toId);
  const themeButtons = FORUM_DM_BUBBLE_THEMES.map(option => `
    <button type="button" class="forum-dm-choice-btn ${currentSettings.bubbleTheme === option.id ? 'is-active' : ''}" data-dm-theme-option="${escapeHTML(option.id)}">
      <b>${escapeHTML(option.label)}</b>
      <span>${escapeHTML(option.short)}</span>
      <small>${escapeHTML(option.desc)}</small>
    </button>
  `).join('');
  openSheet('论坛私聊设置', `
    <div class="forum-dm-settings-sheet">
      <div class="forum-dm-settings-hero">
        <span>DM SETTINGS</span>
        <h4>${escapeHTML(activeConversation.toName)}</h4>
        <p>背景、气泡和上下文轮数只影响这一条私聊</p>
      </div>

      <section class="forum-dm-settings-group">
        <div class="forum-dm-settings-group-head">
          <span>CONTEXT</span>
          <small>读取主聊天历史，或单独设一套轮数</small>
        </div>
        <div class="forum-dm-toggle-row">
          <button type="button" class="forum-dm-toggle-btn ${currentSettings.contextMode !== 'custom' ? 'is-active' : ''}" data-dm-context-mode="main">跟随主聊天</button>
          <button type="button" class="forum-dm-toggle-btn ${currentSettings.contextMode === 'custom' ? 'is-active' : ''}" data-dm-context-mode="custom">单独设置轮数</button>
        </div>
        <label class="forum-mini-field forum-dm-turns-field">
          <span>读取轮数</span>
          <input id="forum-dm-context-turns" type="number" min="${FORUM_DM_CONTEXT_MIN_TURNS}" max="${FORUM_DM_CONTEXT_MAX_TURNS}" step="1" value="${escapeHTML(String(contextTurns))}">
        </label>
        <small class="forum-dm-settings-note">跟随主聊天会直接跟随角色聊天设置里的上下文轮数。</small>
      </section>

      <section class="forum-dm-settings-group">
        <div class="forum-dm-settings-group-head">
          <span>BACKGROUND</span>
          <small>上传图片作为当前私聊背景</small>
        </div>
        <div class="forum-dm-upload-box">
          <div class="forum-dm-upload-preview ${currentSettings.backgroundImage ? 'has-image' : ''}" id="forum-dm-bg-preview" ${currentSettings.backgroundImage ? `style="background-image: url(${JSON.stringify(currentSettings.backgroundImage)})"` : ''}>
            <span>${currentSettings.backgroundImage ? '' : 'NO IMAGE'}</span>
          </div>
          <div class="forum-dm-upload-actions">
            <button type="button" class="forum-dm-upload-btn" id="forum-dm-bg-upload-btn">上传图片</button>
            <button type="button" class="forum-dm-clear-bg-btn" id="forum-dm-bg-clear-btn">清除背景</button>
          </div>
          <input id="forum-dm-bg-file-input" type="file" accept="image/*" hidden>
          <small class="forum-dm-settings-note">建议用横图，系统会自动铺满整条私聊。</small>
        </div>
      </section>

      <section class="forum-dm-settings-group">
        <div class="forum-dm-settings-group-head">
          <span>BUBBLE THEME</span>
          <small>气泡和发送按钮会一起换色</small>
        </div>
        <div class="forum-dm-choice-grid" data-dm-choice-group="theme">
          ${themeButtons}
        </div>
      </section>

      <section class="forum-dm-settings-group">
        <div class="forum-dm-settings-group-head">
          <span>CLEAR CHAT</span>
          <small>只清这条私聊，不动别的对话</small>
        </div>
        <button type="button" class="forum-dm-destructive-btn" id="forum-dm-clear-history-btn">清空聊天记录</button>
      </section>

      <div class="forum-dm-settings-actions">
        <button type="button" class="forum-dm-save-btn" id="forum-dm-settings-save-btn">完成</button>
      </div>
    </div>
  `, root => {
    const settingsCard = root.querySelector('.forum-dm-settings-sheet');
    const turnsInput = root.querySelector('#forum-dm-context-turns');
    const saveBtn = root.querySelector('#forum-dm-settings-save-btn');
    const clearBtn = root.querySelector('#forum-dm-clear-history-btn');
    const uploadBtn = root.querySelector('#forum-dm-bg-upload-btn');
    const clearBgBtn = root.querySelector('#forum-dm-bg-clear-btn');
    const fileInput = root.querySelector('#forum-dm-bg-file-input');
    const bgPreview = root.querySelector('#forum-dm-bg-preview');
    const modeButtons = Array.from(root.querySelectorAll('[data-dm-context-mode]'));
    const themeButtonsEls = Array.from(root.querySelectorAll('[data-dm-theme-option]'));

    const draftSettings = {
      contextMode: currentSettings.contextMode,
      contextTurns: currentSettings.contextTurns,
      background: currentSettings.background,
      backgroundImage: currentSettings.backgroundImage || '',
      bubbleTheme: currentSettings.bubbleTheme
    };

    const syncFieldState = () => {
      const customMode = draftSettings.contextMode === 'custom';
      if (turnsInput) turnsInput.disabled = !customMode;
      modeButtons.forEach(btn => btn.classList.toggle('is-active', btn.dataset.dmContextMode === draftSettings.contextMode));
      themeButtonsEls.forEach(btn => btn.classList.toggle('is-active', btn.dataset.dmThemeOption === draftSettings.bubbleTheme));
      if (settingsCard) {
        settingsCard.classList.remove(...FORUM_DM_BUBBLE_THEMES.map(item => `forum-dm-theme-${item.id}`));
        settingsCard.classList.add(`forum-dm-theme-${draftSettings.bubbleTheme}`);
      }
      if (bgPreview) {
        if (draftSettings.backgroundImage) {
          bgPreview.classList.add('has-image');
          bgPreview.style.backgroundImage = `url("${draftSettings.backgroundImage}")`;
          bgPreview.innerHTML = '<span></span>';
        } else {
          bgPreview.classList.remove('has-image');
          bgPreview.style.backgroundImage = 'none';
          bgPreview.innerHTML = '<span>NO IMAGE</span>';
        }
      }
    };

    const readTurnValue = () => Math.max(
      FORUM_DM_CONTEXT_MIN_TURNS,
      Math.min(FORUM_DM_CONTEXT_MAX_TURNS, Number(turnsInput?.value) || FORUM_DM_DEFAULT_CONTEXT_TURNS)
    );

    modeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        draftSettings.contextMode = btn.dataset.dmContextMode === 'custom' ? 'custom' : 'main';
        syncFieldState();
      });
    });
    themeButtonsEls.forEach(btn => {
      btn.addEventListener('click', () => {
        draftSettings.bubbleTheme = btn.dataset.dmThemeOption || 'mono';
        syncFieldState();
      });
    });
    uploadBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        showDynamicIsland('请选择图片文件');
        fileInput.value = '';
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        showDynamicIsland('图片太大了，换小一点的试试');
        fileInput.value = '';
        return;
      }
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      }).catch(() => '');
      if (!dataUrl) {
        showDynamicIsland('图片读取失败');
        fileInput.value = '';
        return;
      }
      draftSettings.backgroundImage = dataUrl;
      syncFieldState();
      fileInput.value = '';
    });
    clearBgBtn?.addEventListener('click', () => {
      draftSettings.backgroundImage = '';
      syncFieldState();
    });
    turnsInput?.addEventListener('input', () => {
      draftSettings.contextTurns = readTurnValue();
      turnsInput.value = String(draftSettings.contextTurns);
    });
    saveBtn?.addEventListener('click', async () => {
      draftSettings.contextTurns = readTurnValue();
      draftSettings.backgroundImage = String(draftSettings.backgroundImage || '');
      setForumDmSettings(space, activeConversation.toId, draftSettings);
      await saveState();
      closeModal();
      renderMessages(space, { preserveDmScroll: true });
      showDynamicIsland('私聊设置已保存');
    });
    clearBtn?.addEventListener('click', async () => {
      if (!confirm('确定要清空这条私聊记录吗？')) return;
      const currentUserKey = getCurrentForumUserKey(space);
      space.messages = (space.messages || []).filter(msg => {
        const sameConversation = (!msg.ownerId || msg.ownerId === currentUserKey) && msg.toId === activeConversation.toId;
        return !sameConversation;
      });
      activeDmSelection = null;
      forumDmVisibleMessageCounts.delete(activeConversation.toId);
      await saveState();
      closeModal();
      renderMessages(space);
      showDynamicIsland('已清空私聊记录');
    });

    syncFieldState();
  }, '关闭');
}

function getForumDmConversation(space, toId) {
  const conversations = getDmConversations(space);
  return conversations.find(item => item.toId === toId) || createEmptyDmConversation(space, toId, activeDmTargetName);
}

function getForumDmMessageRowSelector(messageId) {
  return `[data-dm-message-id="${String(messageId || '').replace(/"/g, '\\"')}"]`;
}

function renderForumDmMessageEntry(activeConversation, messages, index, options = {}) {
  const msg = messages[index];
  const prevMsg = messages[index - 1];
  const nextMsg = messages[index + 1];
  const isGroupStart = !isSameDmMessageGroup(prevMsg, msg);
  const isGroupEnd = !isSameDmMessageGroup(msg, nextMsg);
  const groupClass = isGroupStart && isGroupEnd
    ? 'is-single'
    : `${isGroupStart ? 'is-group-start' : 'is-group-middle'} ${isGroupEnd ? 'is-group-end' : ''}`;
  const showDate = index > 0 && !isSameDmDay(prevMsg?.createdAt, msg.createdAt);
  const isFreshIncoming = msg.fromSelf === false && Date.now() - Number(msg.createdAt || 0) < 380;
  const isSelected = activeDmSelection?.toId === activeConversation.toId && activeDmSelection.ids.has(msg.id);
  const hasSticker = msg.sticker?.url;
  const hasEmoji = Boolean(msg.emoji);
  const isCoupleInvite = msg.contentType === FORUM_COUPLE_INVITE_TYPE;
  const isStickerOnly = !isCoupleInvite && (hasSticker || hasEmoji) && !String(msg.text || '').trim();
  const textHtml = !isCoupleInvite && String(msg.text || '').trim()
    ? `<p>${escapeHTML(msg.text)}</p>`
    : '';
  const coupleInviteHtml = isCoupleInvite ? renderForumCoupleInviteCard(activeConversation, msg) : '';

  return `
    ${options.includeDateDivider === false || !showDate ? '' : `<div class="forum-dm-date-divider">${escapeHTML(formatDmDateLabel(msg.createdAt))}</div>`}
    <div class="forum-dm-bubble-row ${msg.fromSelf === false ? 'incoming' : 'outgoing'} ${groupClass} ${isFreshIncoming ? 'is-fresh' : ''} ${isSelected ? 'is-selected' : ''}" data-dm-message-id="${escapeHTML(msg.id)}">
      ${activeDmSelection?.toId === activeConversation.toId ? `<button class="forum-dm-select-dot" type="button" data-dm-select-message-id="${escapeHTML(msg.id)}" aria-label="选择消息">${isSelected ? '✓' : ''}</button>` : ''}
      ${msg.fromSelf === false ? (isGroupEnd ? `<img src="${activeConversation.avatar}" alt="">` : '<span class="forum-dm-avatar-spacer"></span>') : ''}
      <div class="forum-dm-message-stack">
        <div class="forum-dm-bubble ${isStickerOnly ? 'is-sticker-only' : ''} ${isCoupleInvite ? 'is-forum-couple-invite' : ''}">
          ${coupleInviteHtml}
          ${textHtml}
          ${hasEmoji ? `<div class="forum-dm-emoji-sticker" title="${escapeHTML(msg.emojiMeaning || getForumDmReactionMeaning(msg.emoji))}">${escapeHTML(msg.emoji)}</div>` : ''}
          ${hasSticker ? `<img class="forum-dm-message-sticker" src="${escapeHTML(msg.sticker.url)}" alt="${escapeHTML(msg.sticker.explanation || '表情')}" title="${escapeHTML(msg.sticker.explanation || '表情')}" loading="lazy">` : ''}
          ${msg.translation ? `<div class="forum-dm-translation">${escapeHTML(msg.translation).replace(/\n/g, '<br>')}</div>` : ''}
          ${renderForumDmReactionPill(msg)}
        </div>
        ${isGroupEnd ? `<time class="forum-dm-message-time">${escapeHTML(formatDmTime(msg.createdAt))}</time>` : ''}
      </div>
    </div>
  `;
}

function expandForumDmOlderMessages(space, activeConversation) {
  const current = forumDmVisibleMessageCounts.get(activeConversation.toId) || FORUM_DM_VISIBLE_MESSAGE_COUNT;
  forumDmVisibleMessageCounts.set(activeConversation.toId, current + FORUM_DM_LOAD_MORE_COUNT);
  refreshForumDmThreadBody(space, activeConversation.toId, { preserveAnchor: true });
}

function refreshForumDmThreadBody(space, toId, options = {}) {
  const root = els.messagesContent;
  const body = root?.querySelector('.forum-dm-thread-body');
  if (!root || !body) {
    renderMessages(space, options);
    return;
  }
  const previousScrollTop = body.scrollTop;
  const previousScrollHeight = body.scrollHeight;
  const activeConversation = getForumDmConversation(space, toId);
  const isDmGenerating = forumDmGeneratingTargets.has(toId);
  body.innerHTML = renderDmThreadBodyContent(activeConversation, isDmGenerating);
  root.querySelector('[data-dm-profile-id]')?.addEventListener('click', () => {
    openForumDmTargetProfile(activeConversation.toId);
  });
  root.querySelector('[data-dm-load-older]')?.addEventListener('click', () => {
    expandForumDmOlderMessages(space, activeConversation);
  });
  bindForumDmMessageInteractions(space, activeConversation, { bindSelectionBar: false });
  updateForumDmComposerGeneratingState(activeConversation, isDmGenerating);
  requestAnimationFrame(() => {
    if (options.preserveAnchor) {
      body.scrollTop = body.scrollHeight - previousScrollHeight + previousScrollTop;
    } else if (options.preserveDmScroll) {
      body.scrollTop = previousScrollTop;
    } else {
      body.scrollTop = body.scrollHeight;
    }
  });
}

function appendForumDmMessageToThread(space, toId, msg, options = {}) {
  const root = els.messagesContent;
  const body = root?.querySelector('.forum-dm-thread-body');
  if (!root || !body || !msg) {
    refreshForumDmThreadBody(space, toId, options);
    return;
  }
  const activeConversation = getForumDmConversation(space, toId);
  const messages = activeConversation.messages || [];
  const messageIndex = messages.findIndex(item => item.id === msg.id);
  if (messageIndex < 0) {
    refreshForumDmThreadBody(space, toId, options);
    return;
  }

  const prevMsg = messages[messageIndex - 1];
  if (prevMsg && isSameDmMessageGroup(prevMsg, msg)) {
    const prevRow = body.querySelector(getForumDmMessageRowSelector(prevMsg.id));
    if (prevRow) {
      prevRow.outerHTML = renderForumDmMessageEntry(activeConversation, messages, messageIndex - 1, { includeDateDivider: false });
      bindForumDmMessageRowInteractions(space, activeConversation, body.querySelector(getForumDmMessageRowSelector(prevMsg.id)));
    }
  }

  const typingRow = body.querySelector('.forum-dm-typing-row');
  const entryHtml = renderForumDmMessageEntry(activeConversation, messages, messageIndex);
  if (typingRow) {
    typingRow.insertAdjacentHTML('beforebegin', entryHtml);
  } else {
    body.insertAdjacentHTML('beforeend', entryHtml);
  }
  bindForumDmMessageRowInteractions(space, activeConversation, body.querySelector(getForumDmMessageRowSelector(msg.id)));

  requestAnimationFrame(() => {
    body.scrollTop = options.preserveDmScroll ? body.scrollTop : body.scrollHeight;
  });
}

function renderDmThreadMessages(activeConversation) {
  const messages = activeConversation.messages || [];
  return messages.map((_, index) => renderForumDmMessageEntry(activeConversation, messages, index)).join('');
}

function renderForumDmReactionPill(msg) {
  const reactions = Array.isArray(msg?.reactions) ? msg.reactions : [];
  if (!reactions.length) return '';
  return `
    <div class="forum-dm-reaction-pill">
      ${reactions.slice(-3).map(item => `<span title="${escapeHTML(item.meaning || '')}">${escapeHTML(item.emoji || '')}</span>`).join('')}
    </div>
  `;
}

function getForumDmReactionMeaning(emoji) {
  return FORUM_DM_REACTIONS.find(item => item.emoji === emoji)?.meaning || '用表情回应了这条消息';
}

function findForumDmStoredMessage(space, toId, messageId) {
  const currentUserKey = getCurrentForumUserKey(space);
  return (space?.messages || []).find(msg =>
    (!msg.ownerId || msg.ownerId === currentUserKey) &&
    msg.toId === toId &&
    msg.id === messageId
  ) || null;
}

function hideForumDmActionMenu() {
  els.messagesContent?.querySelector('.forum-dm-action-menu')?.remove();
}

function copyForumDmText(text) {
  const cleanText = String(text || '').trim();
  if (!cleanText) {
    showDynamicIsland('没有可复制的文字');
    return;
  }
  const fallbackCopy = value => {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      showDynamicIsland('已复制');
    } catch {
      showDynamicIsland('复制失败');
    }
    textarea.remove();
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(cleanText).then(() => showDynamicIsland('已复制')).catch(() => fallbackCopy(cleanText));
  } else {
    fallbackCopy(cleanText);
  }
}

async function deleteForumDmMessage(space, toId, messageId) {
  const currentUserKey = getCurrentForumUserKey(space);
  space.messages = (space.messages || []).filter(msg =>
    !((!msg.ownerId || msg.ownerId === currentUserKey) && msg.toId === toId && msg.id === messageId)
  );
  if (activeDmSelection?.ids?.has(messageId)) activeDmSelection.ids.delete(messageId);
  hideForumDmActionMenu();
  refreshForumDmThreadBody(space, toId, { preserveDmScroll: true });
  await saveState();
  showDynamicIsland('已删除');
}

function editForumDmMessage(space, toId, messageId) {
  const msg = findForumDmStoredMessage(space, toId, messageId);
  if (!msg) return;
  openSheet('编辑私信', `
    <div class="forum-dm-edit-sheet">
      <textarea id="forum-dm-edit-text" maxlength="500">${escapeHTML(msg.text || '')}</textarea>
      <button id="forum-dm-edit-save" type="button">保存</button>
    </div>
  `, root => {
    const textarea = root.querySelector('#forum-dm-edit-text');
    const saveBtn = root.querySelector('#forum-dm-edit-save');
    textarea?.focus();
    saveBtn?.addEventListener('click', async () => {
      const nextText = textarea?.value?.trim() || '';
      if (!nextText && !msg.sticker?.url) {
        showDynamicIsland('内容不能为空');
        return;
      }
      msg.text = nextText;
      msg.translation = '';
      msg.editedAt = Date.now();
      await saveState();
      closeModal();
      hideForumDmActionMenu();
      refreshForumDmThreadBody(space, toId, { preserveDmScroll: true });
      showDynamicIsland('已修改');
    });
  });
}

async function setForumDmReaction(space, toId, messageId, emoji, actor = 'user', meaning = '') {
  const msg = findForumDmStoredMessage(space, toId, messageId);
  if (!msg || !emoji) return;
  msg.reactions = Array.isArray(msg.reactions) ? msg.reactions : [];
  msg.reactions = msg.reactions.filter(item => item.actor !== actor);
  msg.reactions.push({
    actor,
    emoji,
    meaning: meaning || getForumDmReactionMeaning(emoji),
    createdAt: Date.now()
  });
  await saveState();
  hideForumDmActionMenu();
  refreshForumDmThreadBody(space, toId, { preserveDmScroll: true });
}

function enterForumDmSelection(space, toId, messageId) {
  activeDmSelection = { toId, ids: new Set(messageId ? [messageId] : []) };
  hideForumDmActionMenu();
  renderMessages(space, { preserveDmScroll: true });
}

function refreshForumDmSelectionUi() {
  const root = els.messagesContent;
  if (!root || !activeDmSelection) return;
  root.querySelectorAll('[data-dm-message-id]').forEach(row => {
    const selected = activeDmSelection.ids.has(row.dataset.dmMessageId);
    row.classList.toggle('is-selected', selected);
    const dot = row.querySelector('[data-dm-select-message-id]');
    if (dot) dot.textContent = selected ? '✓' : '';
  });
  const countEl = root.querySelector('.forum-dm-selection-bar span');
  if (countEl) countEl.textContent = `已选 ${activeDmSelection.ids.size} 条`;
}

function toggleForumDmSelection(space, toId, messageId) {
  if (!activeDmSelection || activeDmSelection.toId !== toId) return;
  if (activeDmSelection.ids.has(messageId)) activeDmSelection.ids.delete(messageId);
  else activeDmSelection.ids.add(messageId);
  refreshForumDmSelectionUi();
}

function getForumDmSelectionMessages(space, toId) {
  if (!activeDmSelection || activeDmSelection.toId !== toId) return [];
  const selectedIds = activeDmSelection.ids;
  const currentUserKey = getCurrentForumUserKey(space);
  return (space.messages || [])
    .filter(msg => (!msg.ownerId || msg.ownerId === currentUserKey) && msg.toId === toId && selectedIds.has(msg.id))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

async function handleForumDmSelectionAction(space, activeConversation, action) {
  if (!activeDmSelection || activeDmSelection.toId !== activeConversation.toId) return;
  if (action === 'cancel') {
    activeDmSelection = null;
    renderMessages(space, { preserveDmScroll: true });
    return;
  }
  const selectedMessages = getForumDmSelectionMessages(space, activeConversation.toId);
  if (!selectedMessages.length) {
    showDynamicIsland('先选择消息');
    return;
  }
  if (action === 'copy') {
    const userName = getCurrentForumUser(space)?.name || '我';
    const text = selectedMessages.map(msg => {
      const speaker = msg.fromSelf === false ? activeConversation.toName : userName;
      const content = String(msg.text || '').trim() || (msg.sticker?.explanation ? `[表情：${msg.sticker.explanation}]` : '[空消息]');
      return `${speaker}: ${content}`;
    }).join('\n');
    copyForumDmText(text);
    activeDmSelection = null;
    renderMessages(space, { preserveDmScroll: true });
    return;
  }
  if (action === 'delete') {
    const ids = new Set(selectedMessages.map(msg => msg.id));
    const currentUserKey = getCurrentForumUserKey(space);
    space.messages = (space.messages || []).filter(msg =>
      !((!msg.ownerId || msg.ownerId === currentUserKey) && msg.toId === activeConversation.toId && ids.has(msg.id))
    );
    activeDmSelection = null;
    els.messagesContent?.querySelector('.forum-messages-thread')?.classList.remove('is-dm-selecting');
    els.messagesContent?.querySelector('.forum-dm-selection-bar')?.remove();
    refreshForumDmThreadBody(space, activeConversation.toId, { preserveDmScroll: true });
    await saveState();
    showDynamicIsland('已删除');
  }
}

function bindForumDmMenuButton(button, handler) {
  if (!button || typeof handler !== 'function') return;
  let pointerHandledAt = 0;
  button.addEventListener('pointerdown', event => {
    event.preventDefault();
    event.stopPropagation();
    pointerHandledAt = Date.now();
    handler();
  });
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (Date.now() - pointerHandledAt < 500) return;
    handler();
  });
}

function focusForumDmInput(input) {
  if (!input) return;
  requestAnimationFrame(() => {
    try {
      input.focus({ preventScroll: true });
    } catch {
      input.focus();
    }
  });
}

function showForumDmActionMenu(space, activeConversation, row) {
  const messageId = row?.dataset?.dmMessageId;
  const msg = findForumDmStoredMessage(space, activeConversation.toId, messageId);
  if (!msg) return;
  const existingMenu = els.messagesContent?.querySelector('.forum-dm-action-menu');
  if (existingMenu?.dataset.dmMenuMessageId === messageId) return;
  hideForumDmActionMenu();
  const thread = els.messagesContent?.querySelector('.forum-messages-thread');
  if (!thread) return;
  const menu = document.createElement('div');
  menu.className = 'forum-dm-action-menu';
  menu.dataset.dmMenuMessageId = messageId;
  menu.innerHTML = `
    <div class="forum-dm-reaction-menu" aria-label="表情反应">
      ${FORUM_DM_REACTIONS.map(item => `<button type="button" data-dm-reaction="${escapeHTML(item.emoji)}" title="${escapeHTML(item.label)}">${escapeHTML(item.emoji)}</button>`).join('')}
    </div>
    <div class="forum-dm-action-panel">
      <button type="button" data-dm-action="edit">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
        <span>编辑</span>
      </button>
      <button type="button" data-dm-action="copy">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        <span>复制</span>
      </button>
      <button type="button" data-dm-action="select">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"></path><circle cx="12" cy="12" r="9"></circle></svg>
        <span>多选</span>
      </button>
      <button type="button" data-dm-action="delete">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M6 6l1 16h10l1-16"></path></svg>
        <span>删除</span>
      </button>
    </div>
  `;
  thread.appendChild(menu);
  menu.addEventListener('pointerdown', event => {
    event.stopPropagation();
  });
  menu.addEventListener('click', event => {
    event.stopPropagation();
  });
  menu.addEventListener('contextmenu', event => {
    event.preventDefault();
    event.stopPropagation();
  });
  const rowRect = row.getBoundingClientRect();
  const threadRect = thread.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = rowRect.left - threadRect.left + (rowRect.width / 2) - (menuRect.width / 2);
  let top = rowRect.top - threadRect.top - menuRect.height - 12;
  left = Math.max(10, Math.min(left, threadRect.width - menuRect.width - 10));
  if (top < 10) top = rowRect.bottom - threadRect.top + 12;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  requestAnimationFrame(() => menu.classList.add('is-visible'));
  menu.querySelectorAll('[data-dm-reaction]').forEach(btn => {
    bindForumDmMenuButton(btn, () => {
      const emoji = btn.dataset.dmReaction;
      setForumDmReaction(space, activeConversation.toId, messageId, emoji, 'user', getForumDmReactionMeaning(emoji));
    });
  });
  bindForumDmMenuButton(menu.querySelector('[data-dm-action="edit"]'), () => editForumDmMessage(space, activeConversation.toId, messageId));
  bindForumDmMenuButton(menu.querySelector('[data-dm-action="copy"]'), () => {
    copyForumDmText(msg.text || (msg.sticker?.explanation ? `[表情：${msg.sticker.explanation}]` : ''));
    hideForumDmActionMenu();
  });
  bindForumDmMenuButton(menu.querySelector('[data-dm-action="select"]'), () => enterForumDmSelection(space, activeConversation.toId, messageId));
  bindForumDmMenuButton(menu.querySelector('[data-dm-action="delete"]'), () => deleteForumDmMessage(space, activeConversation.toId, messageId));
  setTimeout(() => {
    const handleOutsidePointer = event => {
      if (menu.contains(event.target) || row.contains(event.target)) return;
      hideForumDmActionMenu();
      document.removeEventListener('pointerdown', handleOutsidePointer, { capture: true });
    };
    document.addEventListener('pointerdown', handleOutsidePointer, { capture: true });
  }, 0);
}

function bindForumDmMessageRowInteractions(space, activeConversation, row) {
  if (!row) return;
  row.querySelectorAll('[data-couple-invite-action]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      handleForumCoupleInviteAction(space, activeConversation, row.dataset.dmMessageId, btn.dataset.coupleInviteAction);
    });
  });
  let timer = null;
  let fired = false;
  let startX = 0;
  let startY = 0;
  let suppressContextMenuUntil = 0;
  let lastPointerType = '';
  row.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (lastPointerType && lastPointerType !== 'mouse') return;
    if (Date.now() < suppressContextMenuUntil) return;
    showForumDmActionMenu(space, activeConversation, row);
  });
  row.addEventListener('pointerdown', event => {
    if (event.target.closest('button')) return;
    if (activeDmSelection?.toId === activeConversation.toId) return;
    lastPointerType = event.pointerType || '';
    fired = false;
    startX = event.clientX;
    startY = event.clientY;
    timer = setTimeout(() => {
      fired = true;
      timer = null;
      suppressContextMenuUntil = Date.now() + 900;
      showForumDmActionMenu(space, activeConversation, row);
    }, 520);
  });
  row.addEventListener('pointermove', event => {
    if (!timer) return;
    if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) {
      clearTimeout(timer);
      timer = null;
    }
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => {
    row.addEventListener(type, () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    });
  });
  row.addEventListener('click', event => {
    if (activeDmSelection?.toId === activeConversation.toId) {
      event.preventDefault();
      toggleForumDmSelection(space, activeConversation.toId, row.dataset.dmMessageId);
      return;
    }
    if (fired) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

function bindForumDmMessageInteractions(space, activeConversation, options = {}) {
  const root = els.messagesContent;
  if (!root) return;
  if (options.bindSelectionBar !== false) {
    root.querySelectorAll('[data-dm-selection-action]').forEach(btn => {
      btn.addEventListener('click', () => handleForumDmSelectionAction(space, activeConversation, btn.dataset.dmSelectionAction));
    });
  }
  root.querySelectorAll('[data-dm-select-message-id]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      toggleForumDmSelection(space, activeConversation.toId, btn.dataset.dmSelectMessageId);
    });
  });
  root.querySelectorAll('[data-dm-message-id]').forEach(row => {
    bindForumDmMessageRowInteractions(space, activeConversation, row);
  });
}

function updateForumDmComposerGeneratingState(activeConversation, isDmGenerating) {
  const root = els.messagesContent;
  const form = root?.querySelector('#forum-dm-inline-composer');
  const input = root?.querySelector('#forum-dm-inline-input');
  const sendBtn = root?.querySelector('.forum-dm-send-btn');
  const regenBtn = root?.querySelector('.forum-dm-regen-btn');
  form?.classList.toggle('is-generating', isDmGenerating);
  if (input) {
    input.placeholder = isDmGenerating
      ? `${activeConversation.toName}正在输入...`
      : `发消息给 ${activeConversation.toName}...`;
  }
  if (regenBtn) regenBtn.title = isDmGenerating ? '生成中' : '重新生成';
  if (sendBtn) {
    sendBtn.classList.toggle('is-stop', isDmGenerating);
    sendBtn.title = isDmGenerating ? '停止生成' : '发送';
    sendBtn.innerHTML = isDmGenerating
      ? `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"></rect></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"></path><path d="m22 2-7 20-4-9-9-4 20-7Z"></path></svg>`;
  }
}

function bindDmInlineComposer(space, toId, toName) {
  const root = els.messagesContent;
  const form = root?.querySelector('#forum-dm-inline-composer');
  const input = root?.querySelector('#forum-dm-inline-input');
  const sendBtn = root?.querySelector('.forum-dm-send-btn');
  const regenBtn = root?.querySelector('.forum-dm-regen-btn');
  if (!form || !input) return;
  let dmEnterHandledAt = 0;
  [sendBtn, regenBtn].forEach(btn => {
    btn?.addEventListener('pointerdown', event => {
      event.preventDefault();
    });
  });
  sendBtn?.addEventListener('click', async event => {
    event.preventDefault();
    if (forumDmGeneratingTargets.has(toId)) {
      abortForumDmReply(toId, space);
      return;
    }
    const latestText = await submitForumDmUserText(space, toId, toName, input, { render: false, awaitSave: false });
    triggerForumDmReplyFromLatestUserMessage(space, toId, latestText);
  });
  regenBtn?.addEventListener('click', event => {
    event.preventDefault();
    if (forumDmGeneratingTargets.has(toId)) {
      return;
    }
    regenerateForumDmReply(space, toId);
  });
  input.addEventListener('keydown', async event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (forumDmGeneratingTargets.has(toId)) {
      return;
    }
    dmEnterHandledAt = Date.now();
    await submitForumDmUserText(space, toId, toName, input, { awaitSave: false });
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (Date.now() - dmEnterHandledAt < 500) return;
    if (forumDmGeneratingTargets.has(toId)) {
      return;
    }
    await submitForumDmUserText(space, toId, toName, input, { awaitSave: false });
  });
}

async function submitForumDmUserText(space, toId, toName, input, options = {}) {
  const text = input?.value?.trim() || '';
  if (!text) return '';
  space.messages = space.messages || [];
  activeDmTargetName = toName;
  clearForumDmConversationDeleted(space, toId);
  const message = { id: `dm_${Date.now()}`, ownerId: getCurrentForumUserKey(space), toId, toName, text, fromSelf: true, createdAt: Date.now() };
  space.messages.push(message);
  if (input) input.value = '';
  appendForumDmMessageToThread(space, toId, message);
  if (input && document.activeElement !== input) {
    setTimeout(() => focusForumDmInput(input), 48);
  }
  if (options.awaitSave === false) {
    setTimeout(() => {
      saveState().catch(error => console.error('Forum DM quick save failed:', error));
    }, 32);
  } else {
    await saveState();
  }
  return text;
}

function getLatestForumDmUserText(space, toId) {
  const currentUserKey = getCurrentForumUserKey(space);
  const lastUserMessage = (space.messages || [])
    .filter(msg => (!msg.ownerId || msg.ownerId === currentUserKey) && msg.toId === toId && msg.fromSelf !== false && String(msg.text || '').trim())
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  return lastUserMessage?.text || '';
}

function triggerForumDmReplyFromLatestUserMessage(space, toId, preferredText = '') {
  const text = String(preferredText || getLatestForumDmUserText(space, toId) || '').trim();
  if (!text) {
    showDynamicIsland('先发送一条消息');
    return;
  }
  generateForumDmReply(space, toId, text);
}

function abortForumDmReply(toId, space = getCurrentSpace()) {
  const controller = forumDmAbortControllers.get(toId);
  if (controller) controller.abort();
  forumDmGeneratingTargets.delete(toId);
  forumDmAbortControllers.delete(toId);
  if (space && activeDmTargetId === toId) renderMessages(space);
  showDynamicIsland('已停止生成');
}

async function regenerateForumDmReply(space, toId) {
  if (!space || !toId) return;
  const currentUserKey = getCurrentForumUserKey(space);
  const conversationMessages = (space.messages || [])
    .filter(msg => (!msg.ownerId || msg.ownerId === currentUserKey) && msg.toId === toId)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const lastUserMessage = [...conversationMessages].reverse().find(msg => msg.fromSelf !== false && String(msg.text || '').trim());
  if (!lastUserMessage) {
    showDynamicIsland('还没有可重新生成的消息');
    return;
  }
  const cutoff = lastUserMessage.createdAt || 0;
  space.messages = (space.messages || []).filter(msg => {
    const sameConversation = (!msg.ownerId || msg.ownerId === currentUserKey) && msg.toId === toId;
    if (!sameConversation) return true;
    return !(msg.fromSelf === false && (msg.createdAt || 0) > cutoff);
  });
  await saveState();
  renderMessages(space);
  generateForumDmReply(space, toId, lastUserMessage.text);
}

function stringifyForumPromptContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text || part.content || '';
      if (part?.text) return part.text;
      if (part?.content) return typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
      return '[多媒体/卡片]';
    }).filter(Boolean).join(' ');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

async function getForumIntegratedHistoryText(member, turnsToInclude = null) {
  const sourceId = getForumMemberSourceCharacterId(member);
  if (!sourceId || !(AppState.characterProfiles || []).some(char => String(char.id) === String(sourceId))) return '（暂无主聊天整合记录）';
  try {
    const history = await getCombinedFormattedHistory(sourceId, Math.max(FORUM_DM_CONTEXT_MIN_TURNS, Number(turnsToInclude) || FORUM_DM_DEFAULT_CONTEXT_TURNS), { includeForumDm: false });
    const charName = member.name || '角色';
    const userName = currentIdentity()?.name || '用户';
    return history.map(item => {
      const speaker = item.role === 'user' ? userName : charName;
      return `${speaker}: ${stringifyForumPromptContent(item.content) || '[多媒体/系统记录]'}`;
    }).join('\n') || '（暂无主聊天整合记录）';
  } catch (error) {
    console.warn('Forum DM integrated history failed:', error);
    return '（主聊天整合记录读取失败）';
  }
}

function getForumDmHistoryText(space, toId, turnsToInclude = null) {
  const currentUserKey = getCurrentForumUserKey(space);
  const aliasMatch = findForumDmAliasAccount(space, toId);
  const member = aliasMatch
    ? (space.members || []).find(item => item.id === aliasMatch.ownerId)
    : (space.members || []).find(item => item.id === toId);
  const visibleOwnerIds = member ? getForumDmPromptOwnerIdsForMember(space, member) : new Set([currentUserKey]);
  const ownerContexts = member ? getForumUserDmOwnerContextsForMember(space, member) : [];
  const ownerContextById = new Map(ownerContexts.map(item => [String(item.id), item]));
  const dmConversationIds = member ? getForumDmConversationIdsForMember(space, member.id) : new Set([String(toId)]);
  const memberName = getForumDisplayName(space, toId, member?.name || '对方');
  return (space.messages || [])
    .filter(msg => visibleOwnerIds.has(String(msg.ownerId || getForumMainUserId(space))) && dmConversationIds.has(String(msg.toId)))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .slice(-(Math.max(FORUM_DM_CONTEXT_MIN_TURNS, Number(turnsToInclude) || FORUM_DM_DEFAULT_CONTEXT_TURNS) * 2))
    .map(msg => {
      const ownerContext = ownerContextById.get(String(msg.ownerId || getForumMainUserId(space)));
      const dmMemberName = getForumDisplayName(space, msg.toId, memberName);
      return describeForumDmMessageForPrompt(msg, dmMemberName, ownerContext?.userName || getCurrentForumUser(space)?.name || '用户', getForumDmAccountLabel(space, msg.toId));
    })
    .join('\n') || '（暂无论坛私信历史）';
}

function getForumDmAccountLabel(space, toId) {
  return findForumDmAliasAccount(space, toId) ? '角色小号' : '角色主号';
}

function describeForumDmMessageForPrompt(msg, memberName, userName, accountLabel = '') {
  const speaker = msg.fromSelf === false ? memberName : userName;
  const parts = [];
  const text = String(msg.text || '').trim();
  if (msg.contentType === FORUM_COUPLE_INVITE_TYPE) {
    const invite = msg.coupleInvite || {};
    const status = getForumCoupleInviteStatus(msg);
    const statusText = status === 'accepted' ? '已同意绑定'
      : status === 'rejected' ? '已拒绝'
        : status === 'revoked' ? '已撤回'
          : '等待回应';
    parts.push(`发送论坛情侣账号邀请卡片：对象=${invite.targetName || memberName}，账号类型=${getForumCoupleInviteLabel(invite)}，状态=${statusText}`);
  }
  if (text) parts.push(text);
  if (msg.emoji) parts.push(`发送emoji贴图：${msg.emoji}（${msg.emojiMeaning || getForumDmReactionMeaning(msg.emoji)}）`);
  if (msg.sticker?.explanation) parts.push(`发送表情包：[${msg.sticker.explanation}]`);
  const reactions = Array.isArray(msg.reactions) ? msg.reactions : [];
  if (reactions.length) {
    const reactionText = reactions.map(item => {
      const actor = item.actor === 'char' ? memberName : userName;
      return `${actor}贴了${item.emoji || '表情'}（${item.meaning || getForumDmReactionMeaning(item.emoji)}）`;
    }).join('；');
    parts.push(`消息反应：${reactionText}`);
  }
  const label = accountLabel ? `【${accountLabel}】` : '';
  return `${label}${speaker}: ${parts.join('｜') || '[空消息]'}`;
}
function getForumMemberRecentActivityText(space, memberId, limit = 15) {
  const items = [];
  (space?.posts || []).forEach(post => {
    if (post.authorId === memberId || post.sourceCharacterId === memberId) {
      const brief = String(post.forumBriefSummary || '').trim();
      const contentPart = cutForumInlineText(post.content, brief ? 20 : 40) || '无正文';
      const briefPart = brief ? `｜帖内概况：${brief}` : '';
      items.push({
        time: post.createdAt || 0,
        text: `发帖｜${post.circle || '公开动态'}｜${contentPart}${briefPart}`
      });
    }
    const walk = list => (list || []).forEach(comment => {
      if (comment.realCharId === memberId || comment.authorId === memberId) {
        items.push({
          time: comment.createdAt || 0,
          text: `评论｜在「${cutForumInlineText(post.content || post.circle, 18)}」下说：${cutForumInlineText(comment.text || comment.content, 36)}`
        });
      }
      walk(comment.replies);
    });
    walk(post.comments);
  });
  const lines = items.sort((a, b) => b.time - a.time).slice(0, limit).map(item => `- ${item.text}`);
  return lines.join('\n') || '（最近没有论坛发帖或评论）';
}
function getForumDmUserDigestsText(space, userForumId, userText) {
  return getForumUserDigestsText(space, {
    id: 'forum_dm_current_message',
    authorId: userForumId,
    circle: '论坛私信',
    content: userText || '论坛私信'
  }) || '（论坛动态库暂无可用记录）';
}

function getForumTrendsForDmPrompt(space) {
  const trends = normalizeForumDiscoverTrends(space?.discoverTrends);
  if (!trends.length) return '';
  const lines = trends.slice(0, 8).map((trend, index) => {
    const parts = [`${index + 1}. ${trend.text}`];
    if (trend.tag) parts.push(`[${trend.tag}]`);
    if (trend.event) parts.push(`事件：${trend.event}`);
    if (trend.process) parts.push(`经过：${trend.process}`);
    return `- ${parts.join('｜')}`;
  });
  return `[当前论坛热搜榜（论坛公开可见的热议话题）]\n${lines.join('\n')}`;
}

async function buildForumDmPrompt(space, member, userText, options = {}) {
  const identity = currentIdentity();
  const userForumId = `user_${space.identityId}`;
  const currentUser = getCurrentForumUser(space);
  const currentUserKnowledge = getForumCurrentUserKnowledgeForMember(space, member);
  const hideCurrentAliasOwner = Boolean(currentUser?.isAlias && !currentUserKnowledge.knownAsUser);
  const promptMemberId = options.sourceMemberId || member.id;
  const conversationId = options.conversationId || member.id;
  const charName = options.displayName || getForumDisplayName(space, member.id, member.name);
  const userName = currentUserKnowledge.promptUserName || getForumDisplayName(space, userForumId, identity?.name || currentUser?.name || '我');
  const userProfile = space.forumProfiles?.[userForumId] || {};
  const dmAliasMatch = findForumDmAliasAccount(space, conversationId);
  const characterAliasList = (getForumCharacterAliasState(space, member.id).aliases || [])
    .map(alias => `${alias.name || '角色小号'}(@${alias.account || alias.id})`)
    .join('、') || '无';
  const characterAccountContext = [
    `你当前回复使用的论坛账号：${charName}`,
    dmAliasMatch
      ? `这是你自己的角色小号，归属角色是 ${getForumDisplayName(space, member.id, member.name)}。它绝对不是用户小号。`
      : '这是你的角色主号。它绝对不是用户小号。',
    `你的固定小号列表：${characterAliasList}`,
    `用户当前私信账号：${currentUser?.name || userName}(@${currentUser?.account || currentUser?.id || 'user'})，类型：${currentUser?.isAlias ? '用户小号' : '用户主号'}。`
  ].join('\n');
  const formattedUserProfile = [
    `当前私信账号昵称：${currentUser?.name || userName}`,
    `当前私信账号：@${currentUser?.account || getForumAccount(space, userForumId, userName)}`,
    `账号类型：${currentUser?.isAlias ? '用户小号' : '用户主号'}`,
    currentUser?.isAlias
      ? `身份状态：${currentUserKnowledge.knownAsUser ? `你已明确知道这是${getForumDisplayName(space, userForumId, identity?.name || '用户')}的小号` : '你默认不知道这个账号属于用户本人，只把它当作普通论坛账号'}`
      : '身份状态：这是用户主号',
    currentUser?.bio ? `当前账号简介：${currentUser.bio}` : '',
    !currentUser?.isAlias || currentUserKnowledge.knownAsUser ? (userProfile.bio ? `用户主号主页简介：${userProfile.bio}` : '') : '',
    !currentUser?.isAlias || currentUserKnowledge.knownAsUser ? (identity?.persona ? `用户人设：${identity.persona}` : '') : ''
  ].filter(Boolean).join('\n');
  const userAliasRevealContext = currentUser?.isAlias && ['character', 'npc', 'customNpc'].includes(member?.type)
    ? [
        characterAccountContext,
        `当前账号是用户小号：${currentUser.name || '匿名小号'} @${currentUser.account || currentUser.id}`,
        `你是否已经明确知道它属于用户：${currentUserKnowledge.knownAsUser ? '是' : '否'}`,
        `用户是否手动标记你已知道：${isForumUserAliasManuallyKnownToMember(space, currentUserKnowledge.alias, member) ? '是，禁止再输出 reveal_current_user_alias' : '否'}`,
        currentUserKnowledge.knownAsUser
          ? '不要再输出 reveal_current_user_alias。正常按你已知的小号身份对话。'
          : '只有当用户在最新消息里明确说“这是我小号/我是某某/别告诉别人这是我”等等，才允许输出 reveal_current_user_alias。否则你必须继续不知道。'
      ].join('\n')
    : `${characterAccountContext}\n当前账号不是可由你确认的用户小号身份，禁止输出 reveal_current_user_alias。`;
  let memory = '无';
  try {
    memory = await getMemoriesForPrompt(member.sourceId || promptMemberId) || '无';
  } catch {
    memory = '无';
  }
  const sourceCharacterId = getForumMemberSourceCharacterId(member);
  let sourceCharacter = (AppState.characterProfiles || []).find(item => String(item.id) === String(sourceCharacterId));
  if (sourceCharacterId) {
    try {
      sourceCharacter = await db.characterProfiles.get(sourceCharacterId) || sourceCharacter;
    } catch {
      // 数据库读取失败时继续使用当前内存中的角色资料，不能影响论坛私信生成。
    }
  }
  const mainChatBlockStatus = [
    sourceCharacter?.isBlockedByAi === true
      ? '【重要现状】你已经在主聊天中将用户拉黑。这个状态真实存在；不要把主聊天描述成仍可正常收发消息。论坛私信是另一条渠道，是否继续回复仍按当前情境和你的人设判断。'
      : '',
    sourceCharacter?.isBlocked === true
      ? '【重要现状】用户已经在主聊天中把你拉黑。这个状态真实存在；不要假装你们在主聊天里仍能正常联系。论坛私信是另一条渠道，是否继续回复仍按当前情境和你的人设判断。'
      : '',
    sourceCharacter?.lastMainChatUnblockedAt
      ? `【重要现状】用户已在主聊天中解除过对你的拉黑（解除时间：${new Date(sourceCharacter.lastMainChatUnblockedAt).toLocaleString('zh-CN')}）。主聊天现在恢复可联系；这件事是你亲身经历过的状态变化，可以按人设自然记得和回应，不能说自己不知道。`
      : '',
    sourceCharacter?.lastMainChatAiUnblockedAt
      ? `【重要现状】你已在主聊天中解除过对用户的拉黑（解除时间：${new Date(sourceCharacter.lastMainChatAiUnblockedAt).toLocaleString('zh-CN')}）。主聊天现在恢复可联系；这件事是你亲自做出的状态变化，可以按人设自然记得和回应，不能说自己不知道。`
      : ''
  ].filter(Boolean).join('\n') || '主聊天中不存在你或用户相互拉黑的状态。不要凭空声称存在拉黑。';
  const worldBookContext = await getForumGenerationContext(space, promptMemberId, '论坛私信生成', member);
  const forumEventContext = [buildForumEventHistoryPrompt(space), buildForumActiveEventPrompt(space, 'feed'), getForumTrendsForDmPrompt(space)].filter(Boolean).join('\n\n') || '（暂无正在影响论坛的大事件）';
  const rawChatLink = await Forum.getChatLinkContext(member.sourceId || promptMemberId).catch(() => '') || '';
  const interactionMatch = rawChatLink.match(/\[你和用户在论坛的互动\][\s\S]*$/);
  const forumContext = hideCurrentAliasOwner
    ? '[你和当前匿名账号在论坛的互动]\n当前账号身份未公开；只能按这个账号公开可见的论坛行为理解互动，不能把它当作用户主号。'
    : (interactionMatch ? interactionMatch[0].trim() : '[你和用户在论坛的互动]\n（暂无互动）');
  const coupleInviteContext = getForumCoupleInvitePromptContext(space, conversationId);
  const availableCircles = (space.circles || []).map(circle => `- ${circle.name}：${circle.desc || ''}`).join('\n') || '无';
  const ownForumActivity = getForumMemberRecentActivityText(space, promptMemberId, 15);
  const userDigestOwnerId = hideCurrentAliasOwner ? currentUser?.id : userForumId;
  const userForumDigests = getForumDmUserDigestsText(space, userDigestOwnerId, userText);
  const contextTurns = getForumDmResolvedContextTurns(space, member, conversationId);
  const integratedHistory = hideCurrentAliasOwner
    ? '当前论坛账号身份未公开，不能使用主聊天/线下记录判断这个账号是谁。'
    : await getForumIntegratedHistoryText(member, contextTurns);
  const dmHistory = getForumDmHistoryText(space, conversationId, contextTurns);
  const prompt = FORUM_DM_PROMPT
    .replace(/\{\{char\}\}/g, charName)
    .replace(/\{\{user\}\}/g, userName)
    .replace('{{char_profile}}', `${charName}\n${getForumMemberPersona(member) || '无'}`)
    .replace('{{user_profile}}', formattedUserProfile || userName)
    .replace('{{main_chat_block_status}}', mainChatBlockStatus)
    .replace('{{user_alias_reveal_context}}', userAliasRevealContext)
    .replace('{{memory_context}}', memory)
    .replace('{{world_book_context}}', worldBookContext || '无')
    .replace('{{forum_event_context}}', forumEventContext)
    .replace('{{forum_context}}', forumContext)
    .replace('{{forum_couple_invite_context}}', coupleInviteContext)
    .replace('{{available_circles}}', availableCircles)
    .replace('{{own_forum_activity}}', ownForumActivity)
    .replace('{{user_forum_digests}}', userForumDigests)
    .replace('{{integrated_history}}', integratedHistory)
    .replace('{{dm_history}}', dmHistory)
    .replace('{{latest_user_message}}', userText);
  const promptWithBlockStatus = `${prompt}\n\n[最高优先级状态核对]\n${mainChatBlockStatus}\n回复前必须先遵守这条状态，不得把主聊天的拉黑状态遗漏或说反。`;
  if (!options.starter) return promptWithBlockStatus;
  return promptWithBlockStatus.replace(
    /\[Final Instruction\]:[\s\S]*?Output the JSON array immediately\./,
    `[Final Instruction]: Start this forum DM as ${charName}. ${userName} has not sent a private message yet; use the forum trigger in <Latest_User_Message> as your natural reason to message them first. Send 1 to 4 short natural bubbles. Output the JSON array immediately.`
  );
}

function waitForumDmMessagePop(ms, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function getRandomForumDmMessageDelay() {
  return 3000 + Math.floor(Math.random() * 1501);
}

async function generateForumDmReply(space, toId, userText) {
  if (!space || !toId || forumDmGeneratingTargets.has(toId)) return;
  const aliasMatch = findForumDmAliasAccount(space, toId);
  const member = aliasMatch
    ? (space.members || []).find(item => item.id === aliasMatch.ownerId)
    : (space.members || []).find(item => item.id === toId);
  if (!member) return;
  forumDmGeneratingTargets.add(toId);
  const controller = new AbortController();
  forumDmAbortControllers.set(toId, controller);
  refreshForumDmThreadBody(space, toId);
  try {
    const prompt = await buildForumDmPrompt(space, member, userText, aliasMatch ? {
      displayName: aliasMatch.alias.name,
      sourceMemberId: aliasMatch.ownerId,
      conversationId: toId
    } : { conversationId: toId });
    const raw = await sendForumCommentPromptToAI(prompt, [], controller.signal);
    const items = parseAiJsonArray(raw).filter(item => item && typeof item === 'object');
    if (!items.length) return;
    space.messages = space.messages || [];
    const currentUserKey = getCurrentForumUserKey(space);
    const conversationMessages = space.messages
      .filter(msg => (!msg.ownerId || msg.ownerId === currentUserKey) && msg.toId === toId)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const latestUserMessage = [...conversationMessages].reverse().find(msg => msg.fromSelf !== false);
    const now = Date.now();
    let textCount = 0;
    let changed = false;
    let usedReaction = false;
    let usedDmPost = false;
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const item = items[itemIndex];
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (item.type === 'couple_invite_decision') {
        const decision = String(item.decision || '').trim().toLowerCase();
        if (decision === 'accept' || decision === 'reject') {
          const applied = await applyForumCoupleInviteDecisionFromAi(space, toId, decision);
          if (applied) changed = true;
        }
        continue;
      }
      if (item.type === 'send_couple_invite') {
        const sentInvite = await sendForumCoupleInviteFromAi(space, toId);
        if (sentInvite) changed = true;
        continue;
      }
      if (item.type === 'reveal_current_user_alias') {
        if (getCurrentForumUser(space)?.isAlias && revealForumCurrentUserAliasToMemberByAi(space, member)) {
          changed = true;
          await saveState();
          const aliasName = getCurrentAlias(space)?.name || getCurrentForumUser(space)?.name || '这个小号';
          const memberName = getForumDisplayName(space, member.id, member.name);
          showDynamicIsland(`${memberName}认出了你的小号「${aliasName}」`);
        }
        continue;
      }
      if (item.type === 'create_forum_post' && !usedDmPost) {
        const post = buildForumDmAiProfilePost(space, toId, member, aliasMatch, item);
        if (post) {
          space.posts = Array.isArray(space.posts) ? space.posts : [];
          space.posts.unshift(post);
          space.posts.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
          usedDmPost = true;
          changed = true;
          await saveState();
          showDynamicIsland(`${post.authorName}刚发了一条帖子`);
        }
        continue;
      }
      if (item.type === 'reaction' && !usedReaction) {
        const emoji = FORUM_DM_REACTIONS.some(reaction => reaction.emoji === item.emoji) ? item.emoji : '';
        const targetMsg = item.targetMessageId
          ? conversationMessages.find(msg => msg.id === item.targetMessageId)
          : latestUserMessage;
        if (!emoji || !targetMsg) return;
        targetMsg.reactions = Array.isArray(targetMsg.reactions) ? targetMsg.reactions : [];
        targetMsg.reactions = targetMsg.reactions.filter(reaction => reaction.actor !== 'char');
        targetMsg.reactions.push({
          actor: 'char',
          emoji,
          meaning: String(item.meaning || '').trim() || getForumDmReactionMeaning(emoji),
          createdAt: now
        });
        usedReaction = true;
        changed = true;
        await saveState();
        if (activeDmTargetId === toId) refreshForumDmThreadBody(space, toId, { preserveDmScroll: true });
        continue;
      }
      if (textCount >= 4 || (item.type !== 'text' && item.type !== 'emoji')) continue;
      const emoji = item.type === 'emoji' && FORUM_DM_REACTIONS.some(reaction => reaction.emoji === item.emoji) ? item.emoji : '';
      const text = item.type === 'emoji' ? '' : String(item.content || '').trim();
      if (!text && !emoji) continue;
      const message = {
        id: `dm_${now}_${textCount}`,
        ownerId: currentUserKey,
        toId,
        toName: aliasMatch?.alias?.name || getForumDisplayName(space, member.id, member.name),
        text,
        translation: normalizeForumStandardMandarinTranslation(text, item.translation),
        ...(emoji ? { emoji, emojiMeaning: String(item.meaning || '').trim() || getForumDmReactionMeaning(emoji) } : {}),
        fromSelf: false,
        createdAt: now + textCount
      };
      space.messages.push(message);
      textCount += 1;
      changed = true;
      await saveState();
      if (activeDmTargetId === toId) appendForumDmMessageToThread(space, toId, message);
      const hasMoreMessageItems = items.slice(itemIndex + 1).some(next => next?.type === 'text' || next?.type === 'emoji');
      if (hasMoreMessageItems) await waitForumDmMessagePop(getRandomForumDmMessageDelay(), controller.signal);
    }
    if (!changed) return;
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error('Forum DM reply failed:', error);
      showDynamicIsland('私信回复生成失败');
    }
  } finally {
    forumDmGeneratingTargets.delete(toId);
    forumDmAbortControllers.delete(toId);
    if (activeDmTargetId === toId) refreshForumDmThreadBody(space, toId);
  }
}
function renderProfile(space) {
  const currentUser = getCurrentForumUser(space);
  if (activeProfileTab === 'footprint') activeProfileTab = 'favorites';
  const emptyState = `
    <div style="text-align:center; padding:60px 0;">
      <h3 style="font-size:22px; margin:0 0 10px; font-weight:800; color:#111;">发布你的第一篇帖子</h3>
      <p style="color:#555; font-size:14px; margin:0;">让这个空间充满爱。</p>
    </div>
  `;
  const postsHtml = renderForumProfilePostsList(space, currentUser.id) || emptyState;
  
  els.feed.innerHTML = `
    <section class="forum-profile-panel">
      <!-- 顶部账号切换栏 -->
      <div class="profile-top-switcher">
         <button class="back-btn" type="button" aria-label="返回论坛首页">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
         </button>
         <h2 id="forum-account-switcher" style="cursor: pointer; display: flex; align-items: center; gap: 4px;" title="点击切换小号">${escapeHTML(currentUser.account)} <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg></h2>
         <div style="width: 28px;"></div>
      </div>
      
      <!-- 头像与数据统计区 -->
      <div class="profile-header-data">
         <div class="avatar-wrap">
            <img src="${currentUser.avatar}" alt="avatar">
         </div>
         <div class="data-wrap">
            <div class="data-item"><b>${space.posts.filter(p => p.authorId === currentUser.id).length}</b><span>帖子</span></div>
            <div class="data-item"><b>${getFollowingCount(space)}</b><span>关注</span></div>
            <div class="data-item"><b>${getCurrentAccountCircles(space).length}</b><span>圈子</span></div>
         </div>
      </div>
      <!-- 简介区 -->
      <div class="profile-bio-area">
         <h4>${escapeHTML(currentUser.name)}</h4>
         <p>${escapeHTML(currentUser.bio || '这个人还没有写个人介绍。')}</p>
         <div class="relation-tag ${currentUser.isAlias ? '' : 'is-couple-entry'}" ${currentUser.isAlias ? '' : 'id="forum-couple-status-tag" role="button" tabindex="0" title="管理情侣账号"'}>${currentUser.isAlias ? '匿名小号' : escapeHTML(formatCoupleLine(space))}</div>
      </div>
     <!-- 操作按钮区 -->
       <div class="profile-action-btns">
          ${currentUser.isAlias ? '' : `<button class="forum-outline-btn" id="forum-edit-profile" type="button">编辑主页</button>`}
          <button class="forum-outline-btn" type="button">分享主页</button>
       </div>
      ${renderForumProfileTabs({ showFavorites: true })}
    </section>
    
    ${postsHtml}
  `;
  
  // 绑定事件：编辑主页，以及点击顶部标题切换小号
  els.feed.querySelector('.profile-top-switcher .back-btn')?.addEventListener('click', () => {
    activeView = 'feed';
    activeCircle = 'all';
    showPage('page-forum');
    renderApp();
  });
  els.feed.querySelector('#forum-edit-profile')?.addEventListener('click', openCurrentForumProfileEditor);
  els.feed.querySelector('#forum-couple-status-tag')?.addEventListener('click', openCoupleBinder);
  els.feed.querySelector('#forum-couple-status-tag')?.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openCoupleBinder();
  });
  els.feed.querySelector('#forum-account-switcher')?.addEventListener('click', openAliasSwitcher);
  
  bindForumProfileTabs(els.feed, () => renderProfile(space));
  bindForumFavoriteCollections(els.feed, space, () => renderProfile(space));
  bindForumProfilePostGroups(els.feed, () => renderProfile(space));
  els.feed.querySelectorAll('[data-post-id]').forEach(btn => {
    btn.addEventListener('click', () => openForumProfilePost(btn.dataset.postId));
  });
}

function openCurrentForumProfileEditor() {
  const space = getCurrentSpace();
  const currentUser = getCurrentForumUser(space);
  if (!space || !currentUser) return;
  openSheet('编辑主页', `
    <div class="forum-compose-form forum-profile-edit-form">
      <div class="forum-profile-edit-avatar">
        <label for="forum-profile-avatar-upload">
          <img id="forum-profile-avatar-preview" src="${escapeHTML(currentUser.avatar || DEFAULT_AVATAR_SRC)}" alt="avatar">
          <span>+</span>
        </label>
        <input type="file" id="forum-profile-avatar-upload" accept="image/*" hidden>
      </div>
      <input id="forum-profile-name-input" type="text" placeholder="主页名称" value="${escapeHTML(currentUser.name || '')}">
      <input id="forum-profile-account-input" type="text" placeholder="账号" value="${escapeHTML(currentUser.account || '')}">
      <textarea id="forum-profile-bio-input" placeholder="个人介绍">${escapeHTML(currentUser.bio || '')}</textarea>
      <button class="forum-primary-btn" id="forum-save-profile-btn" type="button">保存主页</button>
    </div>
  `, root => {
    let avatarDataUrl = currentUser.avatar || DEFAULT_AVATAR_SRC;
    const uploadInput = root.querySelector('#forum-profile-avatar-upload');
    const previewImg = root.querySelector('#forum-profile-avatar-preview');
    uploadInput?.addEventListener('click', () => {
      uploadInput.value = '';
    });
    uploadInput?.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!file.type?.startsWith('image/')) {
        showDynamicIsland('请选择图片文件');
        uploadInput.value = '';
        return;
      }
      avatarDataUrl = await compressForumImage(file);
      if (!avatarDataUrl || avatarDataUrl === DEFAULT_AVATAR_SRC) {
        showDynamicIsland('头像读取失败，请换一张图试试');
        uploadInput.value = '';
        return;
      }
      if (previewImg) previewImg.src = avatarDataUrl;
      uploadInput.value = '';
    });
    root.querySelector('#forum-save-profile-btn')?.addEventListener('click', async () => {
      const name = root.querySelector('#forum-profile-name-input')?.value.trim() || '';
      const account = root.querySelector('#forum-profile-account-input')?.value.trim() || '';
      const bio = root.querySelector('#forum-profile-bio-input')?.value.trim() || '';
      if (!name) return showDynamicIsland('请输入主页名称');
      if (currentUser.isAlias) {
        const alias = (space.aliases || []).find(item => item.id === currentUser.id);
        if (!alias) return;
        alias.name = name;
        alias.account = account || generateForumAccount(name);
        alias.avatar = avatarDataUrl;
        alias.bio = bio;
      } else {
        if (!space.forumProfiles) space.forumProfiles = {};
        const profile = space.forumProfiles[currentUser.id] || {};
        space.forumProfiles[currentUser.id] = {
          ...profile,
          nickname: name,
          account: account || generateForumAccount(name),
          avatar: avatarDataUrl,
          bio,
          isFollowed: true
        };
        space.account = space.forumProfiles[currentUser.id].account;
        space.avatar = avatarDataUrl;
      }
      await saveState();
      closeModal();
      renderApp();
      showDynamicIsland('主页已保存');
    });
  });
}

function openAliasSwitcher() {
  const space = getCurrentSpace();
  const identity = currentIdentity();
  const defaultId = `user_${identity?.id}`;
  const defaultName = getForumDisplayName(space, defaultId, identity?.name || '我');
  const defaultAccount = getForumAccount(space, defaultId, defaultName);
  
  const aliases = space.aliases || [];
  
  let html = `
    <button class="forum-select-row ${!space.currentAliasId ? 'active' : ''}" data-alias-id="default" type="button">
      <img src="${identity?.avatar || DEFAULT_AVATAR_SRC}" alt="">
      <span class="forum-select-main">
        <b>${escapeHTML(defaultName)}</b>
        <small>@${escapeHTML(defaultAccount)} (主号)</small>
      </span>
      <em class="forum-select-status">当前</em>
    </button>
  `;
  
  aliases.forEach(alias => {
    html += `
      <button class="forum-select-row ${space.currentAliasId === alias.id ? 'active' : ''}" data-alias-id="${alias.id}" type="button">
        <img src="${alias.avatar}" alt="">
        <span class="forum-select-main">
          <b>${escapeHTML(alias.name)}</b>
          <small>@${escapeHTML(alias.account)} (匿名小号)</small>
        </span>
        <em class="forum-alias-edit-btn" data-edit-alias-id="${alias.id}">编辑</em>
      </button>
    `;
  });
  
  html += `
    <div style="margin-top: 12px; border-top: 1px solid #eee8df; padding-top: 12px;">
      <button class="forum-primary-btn" id="forum-add-alias-btn" type="button" style="border-radius: 12px; min-height: 40px;">+ 添加匿名小号</button>
    </div>
  `;
  openSheet('切换账号', html, root => {
    root.addEventListener('click', async e => {
      const editBtn = e.target.closest('[data-edit-alias-id]');
      if (editBtn) {
        e.stopPropagation();
        const alias = (space.aliases || []).find(item => item.id === editBtn.dataset.editAliasId);
        if (!alias) return;
        closeModal();
        openAddAliasCreator(alias);
        return;
      }
      const row = e.target.closest('.forum-select-row');
      if (row) {
        const id = row.dataset.aliasId;
        space.currentAliasId = id === 'default' ? null : id;
        activeCircle = 'all';
        activeCircleDetailTab = 'latest';
        await saveState();
        closeModal();
        renderApp();
        updateDetailCommentAvatar();
        return;
      }
      
      const addBtn = e.target.closest('#forum-add-alias-btn');
      if (addBtn) {
        closeModal();
        openAddAliasCreator();
      }
    });
  });
}
function openAddAliasCreator(editingAlias = null) {
  const space = getCurrentSpace();
  const characterKnowOptions = (space?.members || [])
       .filter(member => ['character', 'npc', 'customNpc'].includes(member?.type))
    .map(member => {
      const checked = getForumUserAliasKnownMemberIds(editingAlias || {}).has(String(member.id));
      const name = getForumDisplayName(space, member.id, member.name);
      return `
        <label class="forum-alias-knowledge-row">
          <input type="checkbox" value="${escapeHTML(member.id)}" ${checked ? 'checked' : ''}>
          <span>${escapeHTML(name)}</span>
        </label>
      `;
    }).join('');
  const aiKnowOptions = getForumAliasKnownMemberNames(space, editingAlias?.aiRevealedToMemberIds || []);
  openSheet(editingAlias ? '编辑匿名小号' : '添加匿名小号', `
    <div class="forum-compose-form">
      <div style="display: flex; justify-content: center; margin-bottom: 10px;">
        <label for="alias-avatar-upload" style="cursor: pointer; position: relative;">
          <img id="alias-avatar-preview" src="${editingAlias?.avatar || DEFAULT_AVATAR_SRC}" style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover; border: 1px solid #eee;">
          <div style="position: absolute; bottom: 0; right: 0; background: #111; color: #fff; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px;">+</div>
        </label>
        <input type="file" id="alias-avatar-upload" accept="image/*" style="display: none;">
      </div>
      <input id="alias-name-input" type="text" placeholder="小号昵称 (如: 热心网友)" value="${escapeHTML(editingAlias?.name || '')}">
      <input id="alias-account-input" type="text" placeholder="小号账号 (如: user_9527)" value="${escapeHTML(editingAlias?.account || '')}">
      <textarea id="alias-bio-input" placeholder="小号个人介绍">${escapeHTML(editingAlias?.bio || '')}</textarea>
      <div class="forum-alias-knowledge-panel">
        <div class="forum-alias-knowledge-title">哪些角色知道这是你的小号</div>
        <div class="forum-alias-knowledge-list">
          ${characterKnowOptions || '<small>当前方案里还没有可标记的角色</small>'}
        </div>
      </div>
      ${aiKnowOptions.length ? `
        <div class="forum-alias-knowledge-panel">
          <div class="forum-alias-knowledge-title">AI 已认出的角色</div>
          <div class="forum-alias-knowledge-list">
            ${aiKnowOptions.map(name => `<small>${escapeHTML(name)}</small>`).join('')}
          </div>
        </div>
      ` : ''}
      <button class="forum-primary-btn" id="forum-save-alias-btn" type="button">${editingAlias ? '保存小号' : '保存并切换'}</button>
      ${editingAlias ? '<button class="forum-outline-btn" id="forum-delete-alias-btn" type="button" style="color:#d93025; border-color:#f2c8c2;">删除这个小号</button>' : ''}
    </div>
  `, root => {
    let avatarDataUrl = editingAlias?.avatar || DEFAULT_AVATAR_SRC;
    const uploadInput = root.querySelector('#alias-avatar-upload');
    const previewImg = root.querySelector('#alias-avatar-preview');
    
    uploadInput?.addEventListener('click', () => {
      uploadInput.value = '';
    });
    uploadInput?.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!file.type?.startsWith('image/')) {
        showDynamicIsland('请选择图片文件');
        uploadInput.value = '';
        return;
      }
      avatarDataUrl = await compressForumImage(file);
      if (!avatarDataUrl || avatarDataUrl === DEFAULT_AVATAR_SRC) {
        showDynamicIsland('头像读取失败，请换一张图试试');
        uploadInput.value = '';
        return;
      }
      if (previewImg) previewImg.src = avatarDataUrl;
      uploadInput.value = '';
    });
    root.querySelector('#forum-save-alias-btn').addEventListener('click', async () => {
      const name = root.querySelector('#alias-name-input').value.trim();
      const account = root.querySelector('#alias-account-input').value.trim();
      const bio = root.querySelector('#alias-bio-input')?.value.trim() || '';
      const knownToMemberIds = [...root.querySelectorAll('.forum-alias-knowledge-row input:checked')].map(input => String(input.value));
      if (!name) return showDynamicIsland('请输入昵称');
      
      const space = getCurrentSpace();
      if (!space.aliases) space.aliases = [];
      if (editingAlias) {
        editingAlias.name = name;
        editingAlias.account = account || generateForumAccount(name);
        editingAlias.avatar = avatarDataUrl;
        editingAlias.bio = bio;
        editingAlias.knownToMemberIds = knownToMemberIds;
        editingAlias.aiRevealedToMemberIds = Array.isArray(editingAlias.aiRevealedToMemberIds)
          ? editingAlias.aiRevealedToMemberIds.map(String).filter(id => knownToMemberIds.includes(id))
          : [];
        await saveState();
        closeModal();
        renderApp();
        showDynamicIsland('小号已保存');
        return;
      }
      
      const newAlias = {
        id: `alias_${Date.now()}`,
        name: name,
        account: account || generateForumAccount(name),
        avatar: avatarDataUrl,
        bio,
        followedMemberIds: [],
        knownToMemberIds,
        aiRevealedToMemberIds: [],
        circles: []
      };
      
      space.aliases.push(newAlias);
      space.currentAliasId = newAlias.id;
      activeCircle = 'all';
      activeCircleDetailTab = 'latest';
      
      await saveState();
      closeModal();
      renderApp();
      showDynamicIsland('已切换至小号');
    });
    root.querySelector('#forum-delete-alias-btn')?.addEventListener('click', async () => {
      const space = getCurrentSpace();
      if (!space || !editingAlias) return;
      if (!confirm('确定删除这个小号吗？这个操作不会删除主号，也不会删除方案。')) return;
      space.aliases = (space.aliases || []).filter(alias => alias.id !== editingAlias.id);
      if (space.currentAliasId === editingAlias.id) space.currentAliasId = null;
      activeCircle = 'all';
      activeCircleDetailTab = 'latest';
      await saveState();
      closeModal();
      renderApp();
      showDynamicIsland('小号已删除');
    });
  });
}

function openCharacterAliasSwitcher(profileId) {
  const space = getCurrentSpace();
  const member = (space?.members || []).find(item => item.id === profileId);
  if (!space || !member || member.type !== 'character') return;
  const aliasState = getForumCharacterAliasState(space, profileId);
  const mainName = getForumDisplayName(space, profileId, member.name);
  const mainAccount = getForumAccount(space, profileId, mainName);
  let html = `
    <button class="forum-select-row ${!aliasState.currentAliasId ? 'active' : ''}" data-character-alias-id="default" type="button">
      <img src="${escapeHTML(space.forumProfiles?.[profileId]?.avatar || member.avatar || DEFAULT_AVATAR_SRC)}" alt="">
      <span class="forum-select-main">
        <b>${escapeHTML(mainName)}</b>
        <small>@${escapeHTML(mainAccount)} (主号)</small>
      </span>
      <em class="forum-select-status">当前</em>
    </button>
  `;
  aliasState.aliases.forEach(alias => {
    html += `
      <button class="forum-select-row ${aliasState.currentAliasId === alias.id ? 'active' : ''}" data-character-alias-id="${escapeHTML(alias.id)}" type="button">
        <img src="${escapeHTML(alias.avatar || DEFAULT_AVATAR_SRC)}" alt="">
        <span class="forum-select-main">
          <b>${escapeHTML(alias.name)}</b>
          <small>@${escapeHTML(alias.account)} (角色小号)</small>
        </span>
        <em class="forum-alias-edit-btn" data-edit-character-alias-id="${escapeHTML(alias.id)}">编辑</em>
      </button>
    `;
  });
  html += `
    <div style="margin-top: 12px; border-top: 1px solid #eee8df; padding-top: 12px;">
      <button class="forum-primary-btn" id="forum-add-character-alias-btn" type="button" style="border-radius: 12px; min-height: 40px;">${aliasState.aliases.length ? '编辑角色小号' : '+ 添加角色小号'}</button>
    </div>
  `;
  openSheet('切换角色账号', html, root => {
    root.addEventListener('click', async e => {
      const editBtn = e.target.closest('[data-edit-character-alias-id]');
      if (editBtn) {
        e.stopPropagation();
        const alias = aliasState.aliases.find(item => item.id === editBtn.dataset.editCharacterAliasId);
        if (!alias) return;
        closeModal();
        openCharacterAliasCreator(profileId, alias);
        return;
      }
      const row = e.target.closest('[data-character-alias-id]');
      if (row) {
        aliasState.currentAliasId = row.dataset.characterAliasId === 'default' ? null : row.dataset.characterAliasId;
        await saveState();
        closeModal();
        openProfile(profileId);
        return;
      }
      if (e.target.closest('#forum-add-character-alias-btn')) {
        closeModal();
        openCharacterAliasCreator(profileId, aliasState.aliases[0] || null);
      }
    });
  });
}

function openCharacterAliasCreator(profileId, editingAlias = null) {
  const space = getCurrentSpace();
  const member = (space?.members || []).find(item => item.id === profileId);
  if (!space || !member || member.type !== 'character') return;
  openSheet(editingAlias ? '编辑角色小号' : '添加角色小号', `
    <div class="forum-compose-form">
      <div style="display: flex; justify-content: center; margin-bottom: 10px;">
        <label for="character-alias-avatar-upload" style="cursor: pointer; position: relative;">
          <img id="character-alias-avatar-preview" src="${escapeHTML(editingAlias?.avatar || member.avatar || DEFAULT_AVATAR_SRC)}" style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover; border: 1px solid #eee;">
          <div style="position: absolute; bottom: 0; right: 0; background: #111; color: #fff; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px;">+</div>
        </label>
        <input type="file" id="character-alias-avatar-upload" accept="image/*" style="display: none;">
      </div>
      <input id="character-alias-name-input" type="text" placeholder="小号昵称" value="${escapeHTML(editingAlias?.name || '')}">
      <input id="character-alias-account-input" type="text" placeholder="小号账号" value="${escapeHTML(editingAlias?.account || '')}">
      <textarea id="character-alias-bio-input" placeholder="小号个人介绍，更私人一点也可以">${escapeHTML(editingAlias?.bio || '')}</textarea>
      <button class="forum-primary-btn" id="forum-save-character-alias-btn" type="button">${editingAlias ? '保存小号' : '保存并切换'}</button>
    </div>
  `, root => {
    let avatarDataUrl = editingAlias?.avatar || member.avatar || DEFAULT_AVATAR_SRC;
    const uploadInput = root.querySelector('#character-alias-avatar-upload');
    const previewImg = root.querySelector('#character-alias-avatar-preview');
    uploadInput?.addEventListener('click', () => {
      uploadInput.value = '';
    });
    uploadInput?.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!file.type?.startsWith('image/')) {
        showDynamicIsland('请选择图片文件');
        uploadInput.value = '';
        return;
      }
      avatarDataUrl = await compressForumImage(file);
      if (!avatarDataUrl || avatarDataUrl === DEFAULT_AVATAR_SRC) {
        showDynamicIsland('头像读取失败，请换一张图试试');
        uploadInput.value = '';
        return;
      }
      if (previewImg) previewImg.src = avatarDataUrl;
      uploadInput.value = '';
    });
    root.querySelector('#forum-save-character-alias-btn')?.addEventListener('click', async () => {
      const name = root.querySelector('#character-alias-name-input')?.value.trim() || '';
      const account = root.querySelector('#character-alias-account-input')?.value.trim() || '';
      const bio = root.querySelector('#character-alias-bio-input')?.value.trim() || '';
      if (!name) return showDynamicIsland('请输入小号昵称');
      const state = getForumCharacterAliasState(space, profileId);
      const nextAvatar = previewImg?.src || avatarDataUrl || member.avatar || DEFAULT_AVATAR_SRC;
      if (editingAlias) {
        const nextAlias = {
          ...editingAlias,
          ownerId: profileId,
          name,
          account: account || generateForumAccount(name),
          avatar: nextAvatar,
          bio
        };
        const aliasIndex = state.aliases.findIndex(alias => alias.id === editingAlias.id);
        if (aliasIndex >= 0) state.aliases[aliasIndex] = nextAlias;
        else state.aliases = [nextAlias];
        state.currentAliasId = nextAlias.id;
        space.forumProfiles = space.forumProfiles && typeof space.forumProfiles === 'object' ? space.forumProfiles : {};
        space.forumProfiles[profileId] = {
          ...(space.forumProfiles[profileId] || {}),
          aliasAvatar: nextAvatar
        };
        await saveState();
        closeModal();
        openProfile(profileId);
        showDynamicIsland('角色小号已保存');
        return;
      }
      const alias = {
        id: `char_alias_${profileId}_${Date.now()}`,
        ownerId: profileId,
        name,
        account: account || generateForumAccount(name),
        avatar: nextAvatar,
        bio,
        fans: 0,
        followingCount: 0
      };
      state.aliases = [alias];
      state.currentAliasId = alias.id;
      space.forumProfiles = space.forumProfiles && typeof space.forumProfiles === 'object' ? space.forumProfiles : {};
      space.forumProfiles[profileId] = {
        ...(space.forumProfiles[profileId] || {}),
        aliasAvatar: nextAvatar
      };
      await saveState();
      closeModal();
      openProfile(profileId);
      showDynamicIsland('已切换至角色小号');
    });
  });
}

function openProfile(profileId, options = {}) {
  const space = getCurrentSpace();
  const requestedAccount = getForumProfileViewAccount(space, profileId, options);
  const baseProfileId = requestedAccount.profileId;
  const viewProfileId = requestedAccount.viewId;
  if (requestedAccount.isAlias) {
    getForumCharacterAliasState(space, baseProfileId).currentAliasId = viewProfileId;
  }
  const member = space.members.find(item => item.id === baseProfileId);
  const identity = currentIdentity();
  const isUser = baseProfileId === `user_${identity?.id}`;
  if (isUser && activeProfileTab === 'footprint') activeProfileTab = 'favorites';
  if (!isUser && activeProfileTab === 'favorites') activeProfileTab = 'footprint';
  const profile = space.forumProfiles?.[baseProfileId] || {};
  const isFollowed = isUser || isMemberFollowedByCurrentAccount(space, baseProfileId);
  const profileAuthorPost = !member ? (space.posts || []).find(post => String(post.authorId || '') === String(baseProfileId)) : null;
  const rawName = isUser ? identity.name : member?.name || profile.nickname || profileAuthorPost?.authorName || 'World Observer';
  const name = requestedAccount.alias?.name || getForumDisplayName(space, baseProfileId, rawName);
  const account = requestedAccount.alias?.account || getForumAccount(space, baseProfileId, name);
  const avatar = requestedAccount.alias?.avatar || profile.avatar || (isUser ? identity.avatar : member?.avatar) || DEFAULT_AVATAR_SRC;
  const bio = requestedAccount.alias?.bio || profile.bio || findRelationText(space, baseProfileId) || '这个人很神秘，什么都没写...';
  const verifiedBadgeHtml = requestedAccount.isAlias ? '' : renderForumVerifiedBadge(space, baseProfileId);
  const profileFansCount = getForumProfileFansForView(requestedAccount, profile, member);
  const profileFollowingCount = getForumProfileFollowingForView(space, requestedAccount);
  
  const emptyState = `
    <div style="text-align:center; padding:60px 0;">
      <h3 style="font-size:22px; margin:0 0 10px; font-weight:800; color:#111;">尚未发布帖子</h3>
      <p style="color:#555; font-size:14px; margin:0;">该用户还没有在这个世界留下痕迹。</p>
    </div>
  `;
  const profilePostsHtml = renderForumProfilePostsList(space, viewProfileId);
  const isProfileGenerating = forumCharacterProfileAbortController && forumCharacterProfileGeneratingViewId === viewProfileId;
  const postsHtml = `${isProfileGenerating ? getForumFeedLoadingHtml('正在生成主页帖子…') : ''}${profilePostsHtml || (isProfileGenerating ? '' : emptyState)}`;
  // 1. 获取新添加的独立页面的元素
  const titleEl = document.getElementById('forum-user-profile-title');
  const contentEl = document.getElementById('forum-user-profile-content');
  const aiBtn = document.getElementById('forum-user-profile-ai-btn');
  if (!titleEl || !contentEl) {
      console.error("找不到角色主页结构，请确认已在 index.html 注入代码");
      return;
  }
  // 2. 更新顶栏账号名
  titleEl.innerHTML = `<span>${escapeHTML(account)}${verifiedBadgeHtml}</span><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
  // 3. 将原本弹窗里的 HTML 注入到独立页面的 content 区中
  contentEl.innerHTML = `
    <section class="forum-profile-panel forum-character-profile-panel">
      <!-- 头像与数据统计区 -->
      <div class="profile-header-data">
         <div class="avatar-wrap">
            <img src="${avatar || DEFAULT_AVATAR_SRC}" alt="avatar">
         </div>
         <div class="data-wrap">
            <div class="data-item"><b>${getForumProfilePosts(space, viewProfileId).length}</b><span>帖子</span></div>
            <div class="data-item"><b>${formatFansCount(profileFansCount)}</b><span>粉丝</span></div>
            <div class="data-item"><b>${profileFollowingCount}</b><span>关注</span></div>
         </div>
      </div>
      <!-- 简介区 -->
      <div class="profile-bio-area">
         <h4>${escapeHTML(name)}</h4>
         <p>${escapeHTML(bio)}</p>
         ${requestedAccount.isAlias ? '<div class="relation-tag">角色小号</div>' : ''}
      </div>
     <!-- 操作按钮区 -->
      <div class="profile-action-btns">
         ${isUser ? '' : `<button class="forum-outline-btn ${isFollowed ? 'is-following' : ''}" id="forum-profile-follow-toggle" type="button" data-profile-id="${escapeHTML(baseProfileId)}" style="display:flex; align-items:center; justify-content:center; gap:4px; flex: 1;">${isFollowed ? '已关注' : '关注'} <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg></button>`}
         <button class="forum-outline-btn" id="forum-profile-dm" type="button" style="flex: 1;">发消息</button>
         <button class="forum-outline-btn" type="button" style="flex: 0 0 38px; padding:0; display:flex; align-items:center; justify-content:center;"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="17" y1="11" x2="23" y2="11"></line></svg></button>
      </div>
      ${renderForumProfileTabs({ showFavorites: isUser })}
    </section>
    
    ${postsHtml}
  `;
  // 4. 重新绑定按钮事件
  contentEl.querySelector('#forum-profile-dm')?.addEventListener('click', () => {
    // 这里不再需要 closeModal()，因为是独立页面了
    openDmComposer(viewProfileId, name);
  });
  contentEl.querySelector('#forum-profile-follow-toggle')?.addEventListener('click', async () => {
    await toggleForumFollow(baseProfileId);
    openProfile(baseProfileId);
  });
  
  titleEl.onclick = () => openCharacterAliasSwitcher(baseProfileId);
  bindForumProfileTabs(contentEl, () => openProfile(viewProfileId));
  bindForumFavoriteCollections(contentEl, space, () => openProfile(viewProfileId));
  bindForumProfilePostGroups(contentEl, () => openProfile(viewProfileId));
  contentEl.querySelectorAll('[data-post-id]').forEach(btn => {
    btn.addEventListener('click', () => openForumProfilePost(btn.dataset.postId, { returnProfileId: viewProfileId }));
  });
  // 为 AI 按钮绑定一个占位的反馈事件
  if (aiBtn) {
    aiBtn.classList.toggle('is-loading', Boolean(isProfileGenerating));
    if (isProfileGenerating) {
      aiBtn.setAttribute('aria-busy', 'true');
      aiBtn.setAttribute('aria-label', '打断生成');
    } else {
      aiBtn.classList.remove('is-loading');
      aiBtn.removeAttribute('aria-busy');
      aiBtn.setAttribute('aria-label', 'AI生成内容');
    }
       aiBtn.onclick = event => openForumCharacterAiMenu(event, baseProfileId, { forceMain: !requestedAccount.isAlias });
  }
  // 5. 调用系统框架的路由函数，切换到这个独立页面
  showPage('page-forum-user-profile');
}
function openCoupleBinder() {
  const space = getCurrentSpace();
  openForumCoupleInviteSheet(space);
}

function renderForumCoupleCandidateRow(candidate) {
  return `
    <div class="forum-couple-candidate-row">
      <button class="forum-select-row" data-couple-target="${escapeHTML(candidate.targetId)}" type="button">
        <img src="${escapeHTML(candidate.avatar || DEFAULT_AVATAR_SRC)}" alt="">
        <span class="forum-select-main">
          <b>${escapeHTML(candidate.name)}</b>
          <small>@${escapeHTML(candidate.account || candidate.name)} · ${escapeHTML(candidate.label)}</small>
        </span>
      </button>
      <div class="forum-couple-candidate-actions">
        <button type="button" data-couple-send="${escapeHTML(candidate.targetId)}">我邀请</button>
        <button type="button" data-couple-receive="${escapeHTML(candidate.targetId)}">Ta 邀请</button>
      </div>
    </div>
  `;
}

function openForumCoupleInviteSheet(space = getCurrentSpace(), preferredTargetId = '') {
  if (!space) return;
  const candidates = getForumCoupleCandidates(space);
  if (!candidates.length) return showDynamicIsland('没有可绑定的角色或 NPC');
  const preferred = preferredTargetId ? getForumCoupleCandidate(space, preferredTargetId) : null;
  const boundTargetId = getForumCoupleBoundTargetId(space);
  const pending = space.couplePending?.status === 'pending' || space.couplePending?.targetId;
  const currentStatusHtml = getForumCoupleBoundTargetId(space)
    ? `<div class="forum-couple-current">当前：${escapeHTML(formatCoupleLine(space))}<button type="button" id="forum-couple-unbind-btn">解除绑定</button></div>`
    : (pending ? `<div class="forum-couple-current">邀请中：${escapeHTML(space.couplePending.targetName || '对方')}</div>` : '');
  const preferredHtml = preferred ? `
    <div class="forum-couple-selected-card">
      <img src="${escapeHTML(preferred.avatar || DEFAULT_AVATAR_SRC)}" alt="">
      <div>
        <b>${escapeHTML(preferred.name)}</b>
        <span>@${escapeHTML(preferred.account || preferred.name)} · ${escapeHTML(preferred.label)}</span>
      </div>
    </div>
    <div class="forum-couple-direction-actions">
      <button type="button" data-couple-send="${escapeHTML(preferred.targetId)}">我发送邀请卡片</button>
      <button type="button" data-couple-receive="${escapeHTML(preferred.targetId)}">让 Ta 发邀请卡片</button>
    </div>
  ` : '';
  const listHtml = preferred
    ? `<details class="forum-couple-candidate-list"><summary>换一个账号</summary>${candidates.map(renderForumCoupleCandidateRow).join('')}</details>`
    : `<div class="forum-couple-candidate-list">${candidates.map(renderForumCoupleCandidateRow).join('')}</div>`;
  openSheet('情侣账号', `
    <div class="forum-couple-invite-panel">
      ${currentStatusHtml}
      ${preferredHtml}
      ${listHtml}
      ${boundTargetId ? '<p class="forum-couple-hint">同意新的邀请后会覆盖当前绑定。</p>' : '<p class="forum-couple-hint">角色小号只显示已经在角色主页里设置好的固定小号。</p>'}
    </div>
  `, root => {
    root.addEventListener('click', async event => {
      const unbindBtn = event.target.closest('#forum-couple-unbind-btn');
      if (unbindBtn) {
        await unbindForumCouple(space);
        return;
      }
      const sendBtn = event.target.closest('[data-couple-send]');
      if (sendBtn) {
        await appendForumCoupleInviteMessage(space, sendBtn.dataset.coupleSend, 'user_to_target');
        return;
      }
      const receiveBtn = event.target.closest('[data-couple-receive]');
      if (receiveBtn) {
        await appendForumCoupleInviteMessage(space, receiveBtn.dataset.coupleReceive, 'target_to_user');
        return;
      }
      const row = event.target.closest('[data-couple-target]');
      if (row) {
        closeModal();
        openForumCoupleInviteSheet(space, row.dataset.coupleTarget);
      }
    });
  });
}

async function unbindForumCouple(space) {
  if (!space?.couple || !getForumCoupleBoundTargetId(space)) {
    showDynamicIsland('现在没有绑定情侣账号');
    return;
  }
  if (!confirm('确定解除当前论坛情侣账号绑定吗？')) return;
  const oldCouple = { ...space.couple };
  const targetId = oldCouple.targetId || oldCouple.memberId;
  space.couple = null;
  space.couplePending = null;
  if (targetId) {
    space.messages = Array.isArray(space.messages) ? space.messages : [];
    space.messages.push({
      id: `dm_couple_unbind_${Date.now()}`,
      ownerId: getCurrentForumUserKey(space),
      toId: targetId,
      toName: oldCouple.targetName || '对方',
      text: '已解除论坛情侣账号绑定',
      fromSelf: true,
      createdAt: Date.now(),
      source: 'forum_couple_unbind'
    });
  }
  await saveState();
  await notifyMainChatOfForumCoupleChange(space, oldCouple, 'unbind').catch(error => console.warn('[Forum] couple unbind chat link failed:', error));
  closeModal();
  renderApp();
  if (activeView === 'messages' && activeDmTargetId) refreshForumDmThreadBody(space, activeDmTargetId, { preserveDmScroll: true });
  showDynamicIsland('已解除情侣账号绑定');
}

function formatCoupleLine(space) {
  if (!space.couple || !getForumCoupleBoundTargetId(space)) {
    if (space.couplePending?.targetName) return `邀请中：${space.couplePending.targetName}`;
    return '未绑定情侣账号';
  }
  const identity = currentIdentity();
  const userName = getForumDisplayName(space, `user_${identity?.id}`, identity?.name || '我');
  const targetIdentity = getForumCoupleTargetIdentity(space, space.couple);
  return `${userName} × ${targetIdentity.name} 已公开绑定`;
}

function findRelationText(space, id) {
  const rel = (space.relations || []).find(item => item.from === id || item.to === id);
  if (!rel) return '';
  const people = [`user_${currentIdentity()?.id}`, ...space.members.map(m => m.id)];
  const otherId = rel.from === id ? rel.to : rel.from;
  if (!people.includes(otherId)) return rel.label;
  const rawOther = otherId.startsWith('user_') ? currentIdentity()?.name : space.members.find(m => m.id === otherId)?.name;
  const other = getForumDisplayName(space, otherId, rawOther);
  return `${rel.label} / ${other || '未知'}`;
}

function getForumDisplayName(space, id, fallback = '') {
  if (!id) return fallback;
  const foundAlias = findForumDmAliasAccount(space, id);
  if (foundAlias) return foundAlias.alias.name || fallback;
  return space?.forumProfiles?.[id]?.nickname || fallback;
}

function getForumAccount(space, id, fallback = '') {
  if (!id) return fallback;
  const foundAlias = findForumDmAliasAccount(space, id);
  if (foundAlias) return foundAlias.alias.account || foundAlias.alias.name || fallback;
  const profile = space?.forumProfiles?.[id] || {};
  return profile.account || profile.nickname || fallback;
}

function getForumStickerConfigPeople(space, tab) {
  const identity = currentIdentity();
  if (tab === 'members') {
    return (space.members || [])
      .filter(member => !isForumTemporaryOrdinaryMember(member))
      .map(member => ({
        id: member.id,
        name: getForumDisplayName(space, member.id, member.name),
        account: getForumAccount(space, member.id, member.name),
        avatar: member.avatar || DEFAULT_AVATAR_SRC
      }));
  }
  const mainId = `user_${identity?.id}`;
  return [
    {
      id: mainId,
      name: getForumDisplayName(space, mainId, identity?.name || '我'),
      account: getForumAccount(space, mainId, identity?.name || 'me'),
      avatar: identity?.avatar || DEFAULT_AVATAR_SRC
    },
    ...(space.aliases || []).map(alias => ({
      id: alias.id,
      name: getForumDisplayName(space, alias.id, alias.name),
      account: getForumAccount(space, alias.id, alias.account || alias.name),
      avatar: alias.avatar || DEFAULT_AVATAR_SRC
    }))
  ];
}

function renderForumStickerConfigPacks(space, profileId) {
  const member = (space.members || []).find(item => item.id === profileId);
  if (member && member.type !== 'character') return '<div class="forum-sticker-config-empty">NPC 使用当前账号的表情包配置</div>';
  const selectedIds = new Set(getForumStickerConfigIds(space, profileId));
  const groups = Array.isArray(AppState.stickerGroups) ? AppState.stickerGroups : [];
  if (!groups.length) return '<div class="forum-sticker-config-empty">还没有表情包</div>';
  return groups.map(group => {
    const count = Array.isArray(group.stickers) ? group.stickers.length : 0;
    return `
      <label class="forum-sticker-config-pack">
        <input type="checkbox" data-sticker-profile-id="${escapeHTML(profileId)}" data-sticker-pack-id="${escapeHTML(group.id)}" ${selectedIds.has(group.id) ? 'checked' : ''}>
        <span>${escapeHTML(group.name || '未命名表情包')}</span>
        <small>${count} 张</small>
      </label>
    `;
  }).join('');
}

function renderForumStickerConfigRows(space, tab, expandedId) {
  const people = getForumStickerConfigPeople(space, tab);
  if (!people.length) return '<div class="forum-sticker-config-empty">这里还没有可配置的人</div>';
  return people.map(person => `
    <div class="forum-sticker-config-person ${expandedId === person.id ? 'is-open' : ''}">
      <button class="forum-sticker-config-person-head" data-sticker-person-id="${escapeHTML(person.id)}" type="button">
        <img src="${escapeHTML(person.avatar || DEFAULT_AVATAR_SRC)}" alt="">
        <span>
          <b>${escapeHTML(person.name || '未命名')}</b>
          <small>@${escapeHTML(person.account || person.name || '')}</small>
        </span>
        <i>${expandedId === person.id ? '收起' : '配置'}</i>
      </button>
      ${expandedId === person.id ? `<div class="forum-sticker-config-pack-list">${renderForumStickerConfigPacks(space, person.id)}</div>` : ''}
    </div>
  `).join('');
}

async function openForumStickerConfigSheet() {
  const space = getCurrentSpace();
  if (!space) return;
  ensureForumStickerConfigs(space);
  AppState.stickerGroups = await db.stickerGroups.toArray();
  let activeTab = 'accounts';
  let expandedId = null;
  openSheet('配置表情包权限', `
    <div class="forum-sticker-config-panel">
      <div class="forum-sticker-config-tabs">
        <button class="active" data-sticker-config-tab="accounts" type="button">当前账号</button>
        <button data-sticker-config-tab="members" type="button">角色 & NPC</button>
      </div>
      <div id="forum-sticker-config-body"></div>
    </div>
  `, root => {
    const body = root.querySelector('#forum-sticker-config-body');
    const renderConfig = () => {
      root.querySelectorAll('[data-sticker-config-tab]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.stickerConfigTab === activeTab);
      });
      if (body) body.innerHTML = renderForumStickerConfigRows(space, activeTab, expandedId);
    };
    root.addEventListener('click', event => {
      const tabBtn = event.target.closest('[data-sticker-config-tab]');
      if (tabBtn) {
        activeTab = tabBtn.dataset.stickerConfigTab === 'members' ? 'members' : 'accounts';
        expandedId = null;
        renderConfig();
        return;
      }
      const personBtn = event.target.closest('[data-sticker-person-id]');
      if (personBtn) {
        expandedId = expandedId === personBtn.dataset.stickerPersonId ? null : personBtn.dataset.stickerPersonId;
        renderConfig();
      }
    });
    root.addEventListener('change', async event => {
      const checkbox = event.target.closest('[data-sticker-profile-id][data-sticker-pack-id]');
      if (!checkbox) return;
      const profileId = checkbox.dataset.stickerProfileId;
      const packId = checkbox.dataset.stickerPackId;
      const ids = new Set(getForumStickerConfigIds(space, profileId));
      if (checkbox.checked) ids.add(packId);
      else ids.delete(packId);
      setForumStickerConfigIds(space, profileId, [...ids]);
      await saveState();
    });
    renderConfig();
  });
}

function openSettings() {
  const space = getCurrentSpace();
  const mediaLayout = space?.settings?.mediaLayout === 'twitter' ? 'twitter' : 'instagram';
  const dmHintChance = getForumDmHintChance(space);
  openSheet('论坛设置', `
    <div class="forum-settings-panel">
      <label class="forum-settings-toggle">
        <span>Image layout</span>
        <select id="forum-media-layout-setting">
          <option value="instagram" ${mediaLayout === 'instagram' ? 'selected' : ''}>Folded / Ins</option>
          <option value="twitter" ${mediaLayout === 'twitter' ? 'selected' : ''}>Twitter grid</option>
        </select>
      </label>
      <label class="forum-settings-toggle forum-settings-range">
        <span>评论区触发 NPC 私信概率 <b id="forum-dm-hint-chance-value">${dmHintChance}%</b></span>
        <input id="forum-dm-hint-chance-setting" type="range" min="0" max="100" step="5" value="${dmHintChance}">
        <small>调高后，评论互动时更容易收到角色或 NPC 私信；0% 为关闭。</small>
      </label>
      <button class="forum-outline-btn" id="forum-sticker-config-btn" type="button">配置表情包权限</button>
      <button class="forum-primary-btn" id="forum-edit-space-full" type="button">重新修改当前方案</button>
      <button class="forum-outline-btn" id="forum-back-login" type="button">返回登录页</button>
    </div>
  `, root => {
    root.querySelector('#forum-media-layout-setting')?.addEventListener('change', async e => {
      space.settings = space.settings && typeof space.settings === 'object' ? space.settings : {};
      space.settings.mediaLayout = e.target.value === 'twitter' ? 'twitter' : 'instagram';
      await saveState();
      renderApp();
      if (currentDetailPost) renderPostDetailContent();
    });
    root.querySelector('#forum-dm-hint-chance-setting')?.addEventListener('input', async e => {
      const nextChance = normalizeForumDmHintChance(e.target.value);
      const valueEl = root.querySelector('#forum-dm-hint-chance-value');
      if (valueEl) valueEl.textContent = `${nextChance}%`;
      space.settings = space.settings && typeof space.settings === 'object' ? space.settings : {};
      space.settings.dmHintChancePercent = nextChance;
      await saveState();
    });
    root.querySelector('#forum-sticker-config-btn')?.addEventListener('click', openForumStickerConfigSheet);
    root.querySelector('#forum-edit-space-full').addEventListener('click', () => {
      closeModal();
      openEditSpacePage(space);
    });
    root.querySelector('#forum-back-login').addEventListener('click', () => {
      closeModal();
      showPage('page-forum-login');
      refreshLogin();
    });
  });
}
function openSpaceSwitcher() {
  if (!state.spaces.length) return openCreatePanel(true);
  openSheet('切换方案', state.spaces.map(space => `
    <button class="forum-select-row ${space.id === state.currentSpaceId ? 'active' : ''}" data-space-id="${space.id}" type="button">
      <img src="${space.avatar || DEFAULT_AVATAR_SRC}" alt="">
      <span class="forum-select-main" style="flex: 1; text-align: left;">
        <b style="display: block; font-size: 14px; margin-bottom: 2px;">${escapeHTML(space.name)}</b>
        <small style="color: #9f978c; font-size: 11px;">${space.posts.length} posts</small>
      </span>
      <!-- 这里换成了精简的垃圾桶图标 -->
      <div data-delete-space-id="${space.id}" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; color: #d93025; cursor: pointer; position: relative; z-index: 2; opacity: 0.8; transition: opacity 0.2s;" title="删除方案">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px;">
          <path d="M3 6h18"></path>
          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
        </svg>
      </div>
    </button>
  `).join(''), root => {
    root.addEventListener('click', async e => {
      // 捕获图标的点击
      const deleteBtn = e.target.closest('[data-delete-space-id]');
      if (deleteBtn) {
        e.stopPropagation(); // 阻止触发切换方案的逻辑
        if (!confirm('确定要删除这个方案吗？此操作不可恢复。')) return;
        const targetId = deleteBtn.dataset.deleteSpaceId;
        state.spaces = state.spaces.filter(s => s.id !== targetId);
        
        // 如果删掉的是当前正打开的方案，就自动切到下一个
        if (state.currentSpaceId === targetId) {
          state.currentSpaceId = state.spaces.length ? state.spaces[0].id : null;
          resetForumTransientStateForSpaceChange();
        }
        
        await saveState();
        closeModal();
        
        if (!state.spaces.length) {
          openCreatePanel(true);
          if (window.showPage) showPage('page-forum-login');
        } else {
          refreshLogin();
          showPage('page-forum');
          renderApp();
          openSpaceSwitcher(); // 刷新弹窗列表
        }
        if (window.showDynamicIsland) window.showDynamicIsland('方案已删除');
        return;
      }

      // 原本的切换方案逻辑
      const row = e.target.closest('[data-space-id]');
      if (!row) return;
      state.currentSpaceId = row.dataset.spaceId;
      resetForumTransientStateForSpaceChange();
      const savePromise = saveState();
      closeModal();
      refreshLogin();
      showPage('page-forum');
      renderApp();
      await savePromise;
    });
  });
}
function openSheet(title, html, onReady, closeText = '关闭') {
  els.modalRoot.innerHTML = `
    <div class="modal-overlay forum-sheet-overlay visible" style="position: fixed; inset: 0; width: 100vw; height: 100dvh; min-height: 100dvh; align-items: flex-end; justify-content: center; box-sizing: border-box; overflow: hidden; touch-action: none; overscroll-behavior: contain;">
      <div class="modal-card forum-sheet" style="width: 100%; max-width: 100%; margin: 0; max-height: calc(100dvh - env(safe-area-inset-top)); box-sizing: border-box; overflow: hidden;">
        <header>
          <span>${escapeHTML(title)}</span>
          <button id="forum-modal-close" type="button">${escapeHTML(closeText)}</button>
        </header>
        <div class="forum-sheet-body" style="max-height: calc(100dvh - 58px - env(safe-area-inset-top)); min-height: 0; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;">${html}</div>
      </div>
    </div>
  `;
  const root = els.modalRoot.querySelector('.forum-sheet');
  els.modalRoot.querySelector('#forum-modal-close').addEventListener('click', closeModal);
  els.modalRoot.querySelector('.forum-sheet-overlay').addEventListener('click', e => {
    if (e.target.classList.contains('forum-sheet-overlay')) closeModal();
  });
  onReady?.(root);
}

function closeModal() {
  els.modalRoot.innerHTML = '';
}
// ▼▼▼ 新增：论坛评论区 AI 生成引擎 ▼▼▼
const forumGeneratingPosts = new Set();
const forumSummarizingPosts = new Set();
const forumSummaryQueuedPosts = new Set();
let forumCommentBackups = {}; // 【核心修复】存储每个帖子的独立撤回备份，防串台
const forumAbortControllers = new Map();
const FORUM_COMMENT_BACKUP_LIMIT = 40;

function createForumCommentRollbackSnapshot(post, mode, replyContext) {
  const comments = Array.isArray(post?.comments) ? post.comments : [];
  return {
    postId: post?.id || '',
    topLevelCount: comments.length,
    replyCounts: comments.map(comment => Array.isArray(comment?.replies) ? comment.replies.length : 0),
    mode,
    replyContext,
    createdAt: Date.now()
  };
}

function normalizeForumCommentBackup(backup) {
  if (!backup || typeof backup !== 'object') return null;
  if (Array.isArray(backup.comments)) {
    return {
      postId: backup.postId || '',
      topLevelCount: backup.comments.length,
      replyCounts: backup.comments.map(comment => Array.isArray(comment?.replies) ? comment.replies.length : 0),
      mode: backup.mode,
      replyContext: backup.replyContext || null,
      createdAt: Number(backup.createdAt) || Date.now()
    };
  }
  return {
    postId: backup.postId || '',
    topLevelCount: Math.max(0, Number(backup.topLevelCount) || 0),
    replyCounts: Array.isArray(backup.replyCounts) ? backup.replyCounts.map(count => Math.max(0, Number(count) || 0)) : [],
    mode: backup.mode,
    replyContext: backup.replyContext || null,
    createdAt: Number(backup.createdAt) || Date.now()
  };
}

function normalizeForumCommentBackups(backups) {
  const normalized = {};
  Object.entries(backups && typeof backups === 'object' ? backups : {}).forEach(([postId, backup]) => {
    const item = normalizeForumCommentBackup(backup);
    if (item) normalized[postId] = item;
  });
  const entries = Object.entries(normalized).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
  return Object.fromEntries(entries.slice(0, FORUM_COMMENT_BACKUP_LIMIT));
}

function restoreForumCommentsFromBackup(post, backup) {
  if (post && Array.isArray(backup?.comments)) {
    post.comments = JSON.parse(JSON.stringify(backup.comments));
    return true;
  }
  const snapshot = normalizeForumCommentBackup(backup);
  if (!post || !snapshot) return false;
  post.comments = Array.isArray(post.comments) ? post.comments : [];
  post.comments.length = Math.min(post.comments.length, snapshot.topLevelCount);
  post.comments.forEach((comment, index) => {
    if (!Array.isArray(comment.replies)) return;
    const replyCount = snapshot.replyCounts[index] ?? 0;
    comment.replies.length = Math.min(comment.replies.length, replyCount);
  });
  return true;
}
// ▼ 头像库：把你的头像图片放进 images/forum-avatars/ 文件夹，再把路径按分类填进下面的数组
// momo 这个马甲用固定头像（现实里 momo 就是同一个默认梗头像，人设千奇百怪都正常）
const FORUM_MOMO_AVATAR = 'images/forum-avatars/momo.png'; // 例如 'images/forum-avatars/momo.png'，留空就还是用在线头像
const FORUM_PASSER_AVATARS = {
  cute: ['images/forum-avatars/cute-1.png','images/forum-avatars/cute-2.png','images/forum-avatars/cute-3.png'],    // 可爱类，例如 'images/forum-avatars/cute-1.png','images/forum-avatars/cute-2.png'
  food: ['images/forum-avatars/food-1.png','images/forum-avatars/food-2.png','images/forum-avatars/food-3.png','images/forum-avatars/food-4.png'],    // 食物类
  general:['images/forum-avatars/tong-1.png','images/forum-avatars/tong-2.png','images/forum-avatars/tong-3.png','images/forum-avatars/tong-4.png','images/forum-avatars/tong-5.png','images/forum-avatars/tong-6.png','images/forum-avatars/tong-7.png','images/forum-avatars/tong-8.png','images/forum-avatars/tong-9.png','images/forum-avatars/tong-10.png','images/forum-avatars/tong-11.png','images/forum-avatars/tong-12.png'] // 通用类
};

// 按名字稳定地取一个头像：同名永远同一个；momo 用固定头像
function dicebearAvatar(name) {
  const str = String(name || 'momo');
  if (str.toLowerCase() === 'momo' && FORUM_MOMO_AVATAR) return FORUM_MOMO_AVATAR;
  const pool = getForumBuiltInPasserAvatarPool();
  if (pool.length) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    return pool[hash % pool.length];
  }
  return `https://api.dicebear.com/7.x/notionists/svg?seed=${encodeURIComponent(str)}&backgroundColor=f0f0f0,e8e8ed,fef3c7`;
}
function formatForumDigestTime(ts) {
  const diff = Date.now() - Number(ts || 0);
  if (!Number.isFinite(diff) || diff < 60 * 1000) return '刚刚';
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (diff < day) return `${Math.max(1, Math.floor(diff / hour))}小时前`;
  return `${Math.max(1, Math.floor(diff / day))}天前`;
}

function buildForumPostBrief(post) {
  const text = String(post?.content || '').trim();
  if (!text && (!Array.isArray(post?.media) || post.media.length === 0)) return '';
  if (text.length <= 50) return text || '（无文字）';
  return `${text.slice(0, 50)}...`;
}

function buildForumPostMediaNote(post) {
  const items = Array.isArray(post?.media) ? post.media : [];
  if (!items.length) return '';
  const countMap = new Map();
  items.forEach(item => {
    const type = item?.type || '其他';
    const label = type === 'real-image' ? '图片' : type === 'music' ? '音乐' : type === 'slides-video' ? '短视频' : type === 'video' ? '视频' : type === 'fake-image' ? '图片' : '其他';
    countMap.set(label, (countMap.get(label) || 0) + 1);
  });
  return Array.from(countMap.entries()).map(([label, count]) => `${label}x${count}`).join('、');
}

function getForumMemoryStats(space) {
  const posts = space?.posts || [];
  const digests = space?.userPostDigests || [];
  const summarizedPosts = posts.filter(p => String(p.forumSummary || '').trim());
  return {
    digestCount: digests.length,
    digestLimit: 15,
    summarizedCount: summarizedPosts.length,
    totalPosts: posts.length,
    summarizedPosts,
    digests
  };
}

function addUserPostDigest(space, post) {
  if (!space || !post) return;
  const brief = buildForumPostBrief(post);
  const mediaNote = buildForumPostMediaNote(post);
  if (!brief && !mediaNote) return;
  space.userPostDigests = Array.isArray(space.userPostDigests) ? space.userPostDigests : [];
  space.userPostDigests.unshift({
    postId: post.id,
    authorId: post.authorId,
    circle: post.circle || '',
    brief,
    mediaNote,
    time: post.createdAt || Date.now()
  });
  space.userPostDigests = space.userPostDigests.slice(0, 15);
}
function clearForumPostSummary(post) {
  if (!post) return;
  post.forumSummary = '';
  post.forumBriefSummary = '';
  post.lastSummaryFloor = 0;
  post.forumSummaryError = '';
  post.forumSummaryFailedAt = 0;
  post.forumFailedSummaries = [];
}
function removeForumDigest(space, postId) {
  if (!space) return;
  space.userPostDigests = (space.userPostDigests || []).filter(item => item.postId !== postId);
}

function collectForumFloorEntries(comments = [], out = [], depth = 0) {
  (comments || []).forEach(comment => {
    out.push({
      user: comment?.user || '匿名用户',
      text: comment?.text || comment?.content || '',
      depth,
      replies: comment?.replies || []
    });
    if (Array.isArray(comment?.replies) && comment.replies.length) {
      collectForumFloorEntries(comment.replies, out, depth + 1);
    }
  });
  return out;
}

function getForumFloorCount(post) {
  return collectForumFloorEntries(post?.comments || []).length;
}

function getForumFailedSummaryTasks(post) {
  return Array.isArray(post?.forumFailedSummaries) ? post.forumFailedSummaries : [];
}

function createForumThreadSummarySnapshot(post, threshold) {
  const allFloors = collectForumFloorEntries(post?.comments || []);
  const totalFloors = allFloors.length;
  const startFloor = Math.min(totalFloors, Math.max(0, Number(post?.lastSummaryFloor) || 0));
  const endFloor = Math.min(totalFloors, startFloor + threshold);
  if (endFloor <= startFloor) return null;
  return {
    startFloor,
    endFloor,
    postContent: String(post?.content || ''),
    previousSummary: String(post?.forumSummary || '').trim(),
    floors: allFloors.slice(startFloor, endFloor).map((item, index) => ({
      floor: startFloor + index + 1,
      depth: item.depth > 0 ? 1 : 0,
      user: String(item.user || '匿名用户'),
      text: String(item.text || '')
    }))
  };
}

function isForumSummarySnapshotCurrent(post, snapshot) {
  const currentFloors = collectForumFloorEntries(post?.comments || []);
  if (currentFloors.length < snapshot.endFloor) return false;
  return snapshot.floors.every((item, index) => {
    const current = currentFloors[snapshot.startFloor + index];
    return current
      && Number(current.depth > 0) === Number(item.depth > 0)
      && String(current.user || '匿名用户') === String(item.user || '匿名用户')
      && String(current.text || '') === String(item.text || '');
  });
}

function getForumSummaryFailureMessage(error) {
  if (error?.message === 'AI summary returned empty content') return 'AI 没有返回总结内容';
  if (error?.message === 'Forum summary progress changed') return '总结期间帖子进度被手动重置，请重新总结';
  if (error?.message === 'Forum summary source changed') return '帖子楼层已变化，请重新总结';
  return '请求失败，请检查网络、接口设置或模型上下文长度';
}

function getForumSummaryFailureDetail(error) {
  const detail = String(error?.message || '未知错误').trim();
  return detail ? detail.slice(0, 500) : '未知错误';
}

function showForumSummaryFailureAlert(task) {
  if (typeof window === 'undefined' || typeof window.alert !== 'function') return;
  window.alert(`帖子总结失败\n\n原因：${task.error}\n\n具体报错：\n${task.errorDetail || '未知错误'}\n\n失败楼层已保存，可在“论坛记忆设置”中点击“重新总结”。`);
}

function recordForumFailedSummary(post, snapshot, error, retryTaskId = '') {
  const existing = getForumFailedSummaryTasks(post).find(task => task.id === retryTaskId);
  const message = getForumSummaryFailureMessage(error);
  const task = {
    id: existing?.id || `forum_summary_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
    error: message,
    errorDetail: getForumSummaryFailureDetail(error),
    snapshot
  };
  post.forumFailedSummaries = [task];
  post.forumSummaryError = message;
  post.forumSummaryFailedAt = Date.now();
  return task;
}

function buildForumPostShareCommentContext(post) {
  const summary = String(post?.forumSummary || '').trim();
  if (summary) {
    return {
      mode: 'summary',
      summary,
      recentComments: []
    };
  }
  const recentComments = collectForumFloorEntries(post?.comments || [])
    .slice(-20)
    .map((item, index) => `${item.depth > 0 ? '└ ' : ''}${index + 1}. ${item.user}: ${item.text}`)
    .filter(Boolean);
  return {
    mode: 'recent',
    summary: '',
    recentComments
  };
}

function getForumUserDigestsText(space, currentPost) {
  const digests = (space?.userPostDigests || []).filter(item =>
    item && item.authorId === currentPost?.authorId && item.postId !== currentPost?.id);
  if (!digests.length) return '';
  const query = `${currentPost?.circle || ''} ${currentPost?.content || ''}`;
  const queryChars = new Set(Array.from(query).filter(Boolean));
  const scored = digests.map(item => {
    const digestText = `${item.circle || ''} ${item.brief || ''} ${item.mediaNote || ''}`;
    let overlap = 0;
    Array.from(new Set(Array.from(digestText))).forEach(ch => {
      if (queryChars.has(ch)) overlap += 1;
    });
    const sameCircle = currentPost?.circle && item.circle && currentPost.circle === item.circle ? 8 : 0;
    return { item, score: overlap + sameCircle };
  }).sort((a, b) => b.score - a.score || b.item.time - a.item.time).slice(0, 5);
  if (!scored.length) return '';
  const lines = scored.map(({ item }) => {
    const circleText = item.circle ? `圈子：${item.circle}` : '圈子：未指定';
    const mediaText = item.mediaNote ? `，媒体：${item.mediaNote}` : '';
    // 读取该帖 AI 生成的简介版（专给跨帖路人看的浓缩版，完整读取，不截断）
    const relatedPost = (space?.posts || []).find(p => p.id === item.postId);
    const briefSummary = relatedPost && relatedPost.forumBriefSummary
      ? `，帖内概况：${String(relatedPost.forumBriefSummary).trim()}`
      : '';
    return `- ${formatForumDigestTime(item.time)}，${circleText}，${item.brief || '（空内容）'}${mediaText}${briefSummary}`;
  });
  const identity = currentIdentity();
  const mainUserId = `user_${identity?.id}`;
  const isUserAliasPost = (space?.aliases || []).some(alias => String(alias.id) === String(currentPost?.authorId));
  const ownerLabel = isUserAliasPost
    ? '这个匿名小号账号'
    : (String(currentPost?.authorId || '') === String(mainUserId) ? '用户' : '这个账号');
  return `这是${ownerLabel}在论坛其他板块的公开动态，不是本帖发生的事：\n${lines.join('\n')}`;
}
async function summarizeForumThread(space, post, options = {}) {
  if (!space || !post || forumSummarizingPosts.has(post.id)) return false;
  const threshold = Math.max(1, Number(space.settings?.forumSummaryThreshold) || 60);
  const snapshot = options.snapshot || createForumThreadSummarySnapshot(post, threshold);
  if (!snapshot) return false;
  forumSummarizingPosts.add(post.id);
  let shouldContinue = false;
  try {
    const newFloors = snapshot.floors
      .map(item => `${item.depth > 0 ? '  └ ' : ''}Floor ${item.floor} | ${item.user}: ${item.text}`)
      .join('\n');
    const prompt = [
      await getForumGenerationContext(space, null, '帖子总结'),
      `帖子正文：\n${snapshot.postContent}`,
      `已有详细总结：\n${snapshot.previousSummary || '（这是第一次总结，暂无已有总结）'}`,
      `本次新增楼层（Floor ${snapshot.startFloor + 1} 到 Floor ${snapshot.endFloor}）：\n${newFloors}`,
      `\n你是一个娱乐作家的辅助机器，你的主人是一位娱乐网文作家，最擅长的就是根据角色塑造各种有趣的论坛体。她每一天要写的东西太多了有的时候都记不住自己写了些什么了，所以她购买了你。作为作家的好帮手，你见过她写过的各种各样的论坛，你极其欣赏她的文采自己也是乐在其中。作家会写很多类型的论坛体，作为一心一意辅佐作家的帮手你也能客观的找出里面潜藏的信息点。简单来说你是一个娱乐作家的辅助机器，作家最擅长的就是写娱乐文章，刚刚作家书写好了一部分论坛体内容，但是作家自己也有点忘记现在论坛的具体话题倾向和聊的是什么给忘记了，你需要根据下面的工作事项帮她总结，并且要输出两个版本。现在开始工作。

【工作事项与重要规则】
1. 人设对齐：上方【论坛主要人物】里写明了每个用户、角色、NPC 的身份和设定（包括性别），总结时务必严格对应，绝对不要把任何人的性别、身份或称呼搞错。
2. 进度合并：请把“已有详细总结”和“本次新增楼层”合并成一份最新完整总结；已有总结里的信息仍然有效，除非新增楼层明确推翻它。
3. 身份保密：如果帖子里用户中途切换了身份（比如切换为匿名小号），且楼层里没有人认出来，那么你在总结中也绝对不能暴露其真实身份。
4. 绝对客观：不要随意的揣测用户、角色和NPC的情绪，我需要的是完全客观的记录和总结。
5. 词汇克制：行文保持简练，不要使用太多修饰词。

请严格按照以下格式输出，不要有多余内容：
【详细总结】
（原原本本详细总结本帖的话题走向、发生了什么、大家在聊什么，供作家继续往下写，篇幅不限）
【简介】
（用一到两句话高度概括本帖主要发生了什么，控制在60字以内，供其他帖子的路人快速了解用户发过这个帖子）`
    ].join('\n\n');
    const raw = String(await sendToAIForSummary(prompt) || '').trim();
    if (!raw) throw new Error('AI summary returned empty content');
    // 解析两个版本：详细版存帖内推动，简介版存跨帖动态库
    let detail = raw;
    let brief = '';
    const detailMatch = raw.match(/【详细总结】([\s\S]*?)(?:【简介】|$)/);
    const briefMatch = raw.match(/【简介】([\s\S]*)/);
    if (detailMatch) detail = detailMatch[1].trim();
    if (briefMatch) brief = briefMatch[1].trim();
    if (Math.max(0, Number(post.lastSummaryFloor) || 0) !== snapshot.startFloor) {
      throw new Error('Forum summary progress changed');
    }
    if (!isForumSummarySnapshotCurrent(post, snapshot)) {
      throw new Error('Forum summary source changed');
    }
    post.forumSummary = detail || raw;   // 详细版：帖内前情提要
    post.forumBriefSummary = brief || ''; // 简介版：跨帖动态库专用
    post.lastSummaryFloor = snapshot.endFloor;
    post.forumSummaryError = '';
    post.forumSummaryFailedAt = 0;
    if (options.retryTaskId) {
      post.forumFailedSummaries = getForumFailedSummaryTasks(post)
        .filter(task => task.id !== options.retryTaskId);
    }
    await saveState();
    shouldContinue = true;
    return true;
  } catch (err) {
    console.error('Forum summarize failed:', err);
    const failedTask = recordForumFailedSummary(post, snapshot, err, options.retryTaskId);
    await saveState().catch(saveError => console.error('Forum summary failure state save failed:', saveError));
    if(window.showDynamicIsland) window.showDynamicIsland('帖子总结失败，可在论坛记忆里重试', 'error');
    showForumSummaryFailureAlert(failedTask);
    return false;
  } finally {
    forumSummarizingPosts.delete(post.id);
    if (shouldContinue) maybeQueueForumThreadSummary(space, post);
  }
}

function maybeQueueForumThreadSummary(space, post, options = {}) {
  if (!space || !post || forumSummarizingPosts.has(post.id) || forumSummaryQueuedPosts.has(post.id)) return false;
  if (!options.force && getForumFailedSummaryTasks(post).length) return false;
  const threshold = Math.max(1, Number(space.settings?.forumSummaryThreshold) || 60);
  const unsummarizedFloors = getForumFloorCount(post) - Math.max(0, Number(post.lastSummaryFloor) || 0);
  if (!options.force && unsummarizedFloors < threshold) return false;
  forumSummaryQueuedPosts.add(post.id);
  setTimeout(() => {
    forumSummaryQueuedPosts.delete(post.id);
    if (getCurrentSpace()?.id !== space.id) return;
    summarizeForumThread(space, post, options);
  }, 0);
  return true;
}

// 出场判定：算出本帖有资格参与评论的核心角色与NPC，为空则纯路人
function getMemberAppearProbability(post, memberId, space = getCurrentSpace()) {
  if (!post || !post.hiddenLink || !post.hiddenLink.enabled) return 0;
  if (!getEffectiveForumHiddenLinkMemberIds(space, post).includes(String(memberId))) return 0;
  const state = (post.hiddenLinkState && post.hiddenLinkState[memberId]) || null;
  if (state && state.discovered) {
    return Math.max(0, Math.min(100, Math.round(state.speakChance || 0)));
  }
  return Math.max(0, Math.min(100, Number(post.hiddenLink.exposureRate) || 0));
}

function getForumCommentCandidates(space, post) {
  const identity = currentIdentity();
  const userId = `user_${identity?.id}`;
  const coupleBoundMemberId = getForumCoupleBoundTargetId(space) ? String(space?.couple?.memberId || '') : '';
  const userAliasIdsForCouple = new Set((space.aliases || []).map(alias => String(alias.id)));
  const isUserAuthoredCouplePost = String(post.authorId || '') === String(userId)
    || userAliasIdsForCouple.has(String(post.authorId || ''));
  const hasCoupleTopicHint = /男朋友|女朋友|对象|恋人|男友|女友|老公|老婆|伴侣|另一半|情侣|cp|CP|恋爱|约会/.test(String(post.content || ''));
  const scanText = [
    post.content || '',
    ...(post.comments || []).flatMap(c => [
      c.text || c.content || '',
      ...(c.replies || []).map(r => r.text || r.content || '')
    ])
      ].join('\n');
      const mentions = new Set(post.mentions || []);
      const appeared = new Set();
      const interactedWithUser = new Set(); // 新增：记录被用户直接回复过的角色

      (post.comments || []).forEach(c => {
        if (c.realCharId) {
          appeared.add(c.realCharId);
          // 核心逻辑：如果这层楼的回复列表里有当前用户，说明用户刚回复了TA
          if ((c.replies || []).some(r => r.authorId === userId)) {
            interactedWithUser.add(c.realCharId);
          }
        }
        // 确保把楼中楼里冒泡过的角色也算进已出场名单
        (c.replies || []).forEach(r => {
          if (r.realCharId) appeared.add(r.realCharId);
          if (r.authorId === userId && r.replyToRealCharId) interactedWithUser.add(r.replyToRealCharId);
        });
      });

      const characters = [];
      const npcs = [];
      const peekOnlyIds = new Set();
      const speakingHiddenIds = new Set();
      const hiddenLinkMemberIds = new Set(getEffectiveForumHiddenLinkMemberIds(space, post));
      (space.members || []).filter(member => !isForumTemporaryOrdinaryMember(member)).forEach(member => {
        if ((post.blockedIds || []).includes(member.id)) return;
        const blockState = getForumCharacterBlockState(space, member);
        // 角色主动拉黑用户后，论坛评论和隐秘关联都不能再让这个角色（含小号）出现。
        if (blockState.isBlockedByAi) return;
        const displayName = getForumDisplayName(space, member.id, member.name);
        const account = getForumAccount(space, member.id, member.name);
        
        const hitByName = scanText.includes(displayName) || scanText.includes(member.name) || (account && scanText.includes(account));
        const hitByMention = mentions.has(member.id);
        const hitByInteraction = interactedWithUser.has(member.id);
            // 新增：如果本帖就是这个角色/NPC自己发的，那他在自己帖子的评论区里必然有资格现身
             const isPostAuthor = post.authorId === member.id
          || (post.sourceCharacterId && post.sourceCharacterId === member.id);
        const mustAppear = hitByName || hitByMention || hitByInteraction || isPostAuthor;
        // 新增：区分主要角色和NPC，方便应用错位概率
        const isCharacter = member.type === 'character';
        const reconciliationCandidate = isCharacter && isForumCharacterSeekingReconciliation(space, member);

        // 2. 之前发过言但用户没理TA的留存率：主要角色 30%，NPC 20%
        const appearProb = reconciliationCandidate ? 0.6 : (isCharacter ? 0.3 : 0.2);
        const hitByAppearedChance = !mustAppear && appeared.has(member.id) && Math.random() < appearProb;
        
        // 3. 仅凭关系的闲逛冒泡率：主要角色 15%（高冷），NPC 25%（八卦）
        const isRelated = post.authorId === userId
          && (space.relations || []).some(rel =>
            (rel.from === member.id && rel.to === userId) ||
            (rel.to === member.id && rel.from === userId));
        const isBoundCoupleTarget = isUserAuthoredCouplePost
          && hasCoupleTopicHint
          && coupleBoundMemberId
          && String(member.id) === coupleBoundMemberId;
        const relationProb = reconciliationCandidate ? 0.35 : (isCharacter ? 0.15 : 0.25);
        const hitByRelationChance = !mustAppear && ((isRelated && Math.random() < relationProb) || isBoundCoupleTarget);
        const hitByReconciliationChance = reconciliationCandidate && !mustAppear && Math.random() < 0.35;

        let hiddenPeekOnly = false;
        let hiddenSpeaking = false;
        if (hiddenLinkMemberIds.has(String(member.id))) {
          post.hiddenLinkState = post.hiddenLinkState || {};
          const st = post.hiddenLinkState[member.id] || (post.hiddenLinkState[member.id] = { discovered: false, speakChance: 0, peeks: [] });
          if (!st.discovered) {
            if (Math.random() * 100 < (Number(post.hiddenLink.exposureRate) || 0)) {
              st.discovered = true;
              st.speakChance = Math.floor(Math.random() * 100) + 1;
            }
          } else {
            st.speakChance = Math.min(100, (st.speakChance || 0) + (Math.floor(Math.random() * 11) + 10));
          }
           if (st.discovered) {
            if (mustAppear || st.speakChance >= 80) {
              hiddenSpeaking = true;
            } else {
              hiddenPeekOnly = true;
            }
          }
        }

        if (mustAppear || hitByAppearedChance || hitByRelationChance || hitByReconciliationChance || hiddenSpeaking || hiddenPeekOnly) {
          if (member.type === 'character') characters.push(member);
          else npcs.push(member);
          if (hiddenPeekOnly) peekOnlyIds.add(member.id);
          if (hiddenSpeaking) speakingHiddenIds.add(member.id);
        }
      });
      
      return { characters, npcs, peekOnlyIds: [...peekOnlyIds], speakingHiddenIds: [...speakingHiddenIds] };
    }
// 论坛角色人设回退：论坛自带没有时，自动回主程序角色档案里取完整人设
function getForumMemberPersona(member) {
  if (!member) return '';
  if (member.persona) return member.persona;
  if (member.type === 'character') {
    const char = (AppState.characterProfiles || []).find(c => String(c.id) === String(member.sourceId));
    if (char && char.persona) return char.persona;
  }
  if (member.type === 'npc') {
    const owner = (AppState.characterProfiles || []).find(c => String(c.id) === String(member.ownerId));
    const npc = (owner?.relatedNpcs || []).find(n => String(n.id || n.name) === String(member.sourceId) || n.name === member.name);
    if (npc && npc.persona) return npc.persona;
  }
  return member.meta || '';
}

function getForumStickerPacksByIds(packIds) {
  const allowed = new Set(Array.isArray(packIds) ? packIds : []);
  const groups = Array.isArray(AppState.stickerGroups) ? AppState.stickerGroups : [];
  return groups.filter(group => allowed.has(group.id) && Array.isArray(group.stickers) && group.stickers.length > 0);
}

function getForumStickerOptionsForProfile(space, profileId) {
  const member = (space.members || []).find(item => item.id === profileId);
  const effectiveProfileId = member && member.type !== 'character' ? getCurrentForumUser(space).id : profileId;
  const seen = new Set();
  return getForumStickerPacksByIds(getForumStickerConfigIds(space, effectiveProfileId))
    .flatMap(group => group.stickers || [])
    .filter(sticker => sticker?.url && String(sticker.explanation || '').trim())
    .map(sticker => ({
      url: sticker.url,
      explanation: String(sticker.explanation || '').trim()
    }))
    .filter(sticker => {
      const key = sticker.explanation.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getForumCommentAuthorProfileId(space, item, author) {
  if (author?.realCharId) return author.realCharId;
  const identity = String(item?.identity || '').trim();
  if (identity === 'character' || identity === 'npc') {
    const member = (space.members || []).filter(m => !isForumTemporaryOrdinaryMember(m)).find(m =>
      getForumDisplayName(space, m.id, m.name) === item.speaker || m.name === item.speaker);
    return member?.id || null;
  }
  if (identity === 'alias' && item?.realName) {
    const member = (space.members || []).filter(m => !isForumTemporaryOrdinaryMember(m)).find(m =>
      getForumDisplayName(space, m.id, m.name) === item.realName || m.name === item.realName);
    return member?.id || null;
  }
  return null;
}

function getForumStickerOptionsForCommentItem(space, item, author) {
  const profileId = getForumCommentAuthorProfileId(space, item, author);
  if (profileId) return getForumStickerOptionsForProfile(space, profileId);
  const identity = String(item?.identity || '').trim();
  if (identity === 'passer' || identity === 'ordinaryNpc') {
    return getForumStickerOptionsForProfile(space, getCurrentForumUser(space).id);
  }
  return [];
}

function resolveForumProtectedCommentAuthorBySpeaker(space, speaker) {
  const rawSpeaker = String(speaker || '').trim();
  if (!rawSpeaker) return null;
  const aliasMatch = findForumFixedAliasByInput(space, { rawName: rawSpeaker });
  if (aliasMatch?.owner && aliasMatch.alias) {
    return {
      user: aliasMatch.alias.name || rawSpeaker,
      avatar: aliasMatch.alias.avatar || space.forumProfiles?.[aliasMatch.owner.id]?.aliasAvatar || aliasMatch.owner.avatar || DEFAULT_AVATAR_SRC,
      realCharId: aliasMatch.owner.id
    };
  }
  const member = (space?.members || []).filter(item => !isForumTemporaryOrdinaryMember(item)).find(item => {
    const displayName = getForumDisplayName(space, item.id, item.name);
    const account = getForumAccount(space, item.id, displayName);
    return [item.id, item.name, displayName, account].some(value =>
      normalizeForumAccountKey(value) === normalizeForumAccountKey(rawSpeaker));
  });
  if (!member) return null;
  return {
    user: getForumDisplayName(space, member.id, member.name),
    avatar: member.avatar || DEFAULT_AVATAR_SRC,
    realCharId: member.id
  };
}

function buildForumStickerPermissionText(space, candidates, userName, userId) {
  const people = [
    { id: userId, name: userName },
    ...[...(candidates.characters || []), ...(candidates.npcs || [])].map(member => ({
      id: member.id,
      name: getForumDisplayName(space, member.id, member.name)
    }))
  ];
  const seenPeople = new Set();
  const lines = people
    .filter(person => person.id && !seenPeople.has(person.id) && seenPeople.add(person.id))
    .map(person => {
      const keywords = getForumStickerOptionsForProfile(space, person.id).map(sticker => sticker.explanation);
      return `- ${person.name}：可用表情：${keywords.length ? keywords.join(' / ') : '无表情可用'}`;
    });
  const ordinaryKeywords = getForumStickerOptionsForProfile(space, userId).map(sticker => sticker.explanation);
  return `# AVAILABLE STICKERS PER PERSON
${lines.length ? lines.join('\n') : '- 无候选人：无表情可用'}
- 普通网友/普通NPC：可用表情：${ordinaryKeywords.length ? ordinaryKeywords.join(' / ') : '无表情可用'}

# STICKER USAGE RULES (extremely strict, obey exactly)
1. Stickers are RARE seasoning, NOT default output. Across the entire batch you generate this round, at most 1 or 2 comments may carry a sticker. Most batches should have ZERO sticker.
2. A sticker only makes sense when the emotion is peak: shock, speechlessness, cracking up, cute admiration, sarcasm hit - and the sticker keyword must actually match that exact emotion. If you cannot find a perfect match in this person's allowed list, DO NOT use any sticker; use words.
3. NEVER send a sticker alone as an entire comment (no bare-sticker floor). A sticker must be attached to a real text comment as a small emotional accent, and even then, only in the rare cases above.
4. Never repeat the same sticker within one batch. Never have two consecutive floors both carry stickers.
5. If unsure, do NOT send a sticker. Text-only is always safe.
6. When you add "sticker", its value MUST be exactly one keyword from that speaker's own allowed list above. Do NOT output image URLs. Ordinary passers/ordinary NPCs may only use the shared list shown above.`;
}

function findAuthorizedForumSticker(keyword, options) {
  const target = String(keyword || '').trim().toLowerCase();
  if (!target) return null;
  return (options || []).find(sticker => sticker.explanation.toLowerCase() === target) || null;
}

function isBareForumStickerText(text) {
  const clean = String(text || '').trim();
  return !clean || /^(\[?表情\]?|贴图|sticker|emoji)$/i.test(clean);
}
// 构建论坛评论提示词
async function buildForumCommentPrompt(space, post, mode, candidates, charMemory, replyContext = null) {
  post = (space?.posts || []).find(item => String(item?.id) === String(post?.id)) || post;
  const worldBookData = await resolveForumWorldBookPromptData(space, {
    label: '评论区生成',
    privateMemberIds: (candidates.characters || []).map(m => m.id)
  });
  const fcIdentity = currentIdentity();
  const fcUserName = getForumDisplayName(space, `user_${fcIdentity?.id}`, fcIdentity?.name || '我');
  const forumReadLimit = Math.max(1, Number(space?.settings?.forumReadLimit) || 100);
  const dmHintChancePercent = getForumDmHintChance(space);
  const dmHintRule = dmHintChancePercent <= 0
    ? '当前论坛设置：评论区触发 NPC 私信概率为 0%。本轮必须让 dmHints 为空数组。'
    : `当前论坛设置：评论区触发 NPC 私信概率为 ${dmHintChancePercent}%。数值越高，越允许在有明确动机时填写 dmHints；数值越低，越克制。不要为了凑概率硬发私信。`;
  const reconciliationNames = (candidates.characters || [])
    .filter(member => isForumCharacterSeekingReconciliation(space, member))
    .map(member => getForumDisplayName(space, member.id, member.name));
  const reconciliationRule = reconciliationNames.length
    ? `[BLOCKED-BY-USER RECONCILIATION]: ${reconciliationNames.join('、')} 已被用户在主聊天中拉黑，但仍可能想缓和关系。相较普通角色，他们本轮更容易因为帖子内容出现，也更可能在有具体理由时填写 dmHints；仍要保持角色性格和克制，不能每轮强行评论或私信。`
    : '';
  const threadSummaryText = String(post?.forumSummary || '').trim();
  const userDigestsText = getForumUserDigestsText(space, post);
  const publicCoupleContext = getForumPublicCoupleContextForPost(space, post);
  const postMediaText = describeForumMediaForAI(post.media, { includeVisionNote: true }) || 'None';
  const hasRealImages = Array.isArray(post.media) && post.media.some(item => item?.type === 'real-image' && item.url);
  const mediaVisionRule = hasRealImages
    ? `# IMAGE RECOGNITION TASK (real photos)
The post's real photos are attached as image_url. Read them carefully before commenting.
Focus on: 1) Main subject and what matters most. 2) Relationships/actions: distance, pose, interaction, gaze, expression, candid/posed/screenshot/official/meme. 3) Environment: place, time, light, color mood, notable background details. 4) Text inside the image: readable text, numbers, nicknames, watermarks, titles, chat logs are key. 5) What netizens would actually react to (praise/mock/dig/joke/sympathy/ship/warn/gossip), not generic lines.
Reference the real visual details naturally. Do NOT guess from filename or alt text. Do NOT output observation notes or explanations, and do NOT put the reading process into content. Output only a strict JSON object.`
    : '';
  const relationNetworkText = (space.relations || []).length
    ? (space.relations || []).map(rel => {
        const fromName = findForumPersonName(space, rel.from) || 'unknown';
        const toName = findForumPersonName(space, rel.to) || 'unknown';
        const arrow = rel.direction === 'mutual' ? '<->(mutual)' : '->(one-way)';
        return `- ${fromName} ${arrow} ${toName}: ${rel.label}`;
      }).join('\n')
    : '(no relationships defined)';
  const fcUserId = `user_${fcIdentity?.id}`;
  const fcUserFamous = Boolean(space.forumProfiles?.[fcUserId]?.isFamous);
  const authorIsFamous = Boolean(space.forumProfiles?.[post.authorId]?.isFamous);
  const fcCurrentUser = getCurrentForumUser(space);
  const rosterViewerMember = [...(candidates.characters || []), ...(candidates.npcs || [])]
    .find(item => isForumUserAliasKnownToMember(space, getCurrentAlias(space), item)) || null;
  const aliasKnownActorNames = [...(candidates.characters || []), ...(candidates.npcs || [])]
    .filter(item => isForumUserAliasKnownToMember(space, getCurrentAlias(space), item))
    .map(item => getForumDisplayName(space, item.id, item.name));
  const userAliasIds = new Set((space.aliases || []).map(alias => String(alias.id)));
  const postAuthorUserAlias = (space.aliases || []).find(alias => String(alias.id) === String(post.authorId));
  const isForumMainUserAuthoredId = id => {
    const key = String(id || '');
    return Boolean(key && key === String(fcUserId));
  };
  const famousActors = [...candidates.characters, ...candidates.npcs]
    .filter(m => m.isFamous || space.forumProfiles?.[m.id]?.isFamous)
    .map(m => {
      const profile = space.forumProfiles?.[m.id] || {};
      const fansNum = Number(profile.fans ?? m.fans) || 0;
      const occ = profile.occupation || m.occupation || '';
      return `${getForumDisplayName(space, m.id, m.name)}${occ ? `(${occ})` : ''}${fansNum ? `, ~${fansNum} fans` : ''}`;
    });
  const currentForumUserForFloors = getCurrentForumUser(space);
  const selfIdForFloors = currentForumUserForFloors.id;
  const labelForFloor = (item) => {
    if (item.authorId && item.authorId === selfIdForFloors) return currentForumUserForFloors.isAlias ? '（当前小号发的，身份默认不公开）' : '（用户本人发的）';
    if (item.authorId && isForumMainUserAuthoredId(item.authorId)) return '（用户本人发的）';
    if (item.authorId && userAliasIds.has(String(item.authorId))) return '（匿名小号发的，身份默认不公开）';
    if (item.realCharId || (item.authorId && item.authorId === post.authorId)) return '（角色/NPC发的）';
    return '（路人发的）';
  };
  const floors = [];
  (post.comments || []).forEach((c, i) => {
    floors.push(`Floor ${i + 1} | ${c.user}${labelForFloor(c)}: ${c.text || c.content || ''}`);
       (c.replies || []).forEach(r => floors.push(`  └ (这是 Floor ${i + 1} 楼中楼里的回复，回复它请填 quoteFloor=${i + 1}) ${r.user}${labelForFloor(r)} replied: ${r.text || r.content || ''}`));
  });
  const historyText = floors.length > forumReadLimit
    ? `更早的 ${floors.length - forumReadLimit} 条已折叠，见 Thread Summary\n${floors.slice(-forumReadLimit).join('\n')}`
    : (floors.length ? floors.join('\n') : '(no comments yet, you start from Floor 1)');
  const nextFloor = (post.comments || []).length + 1;
  let characterBlock = '';
  if (candidates.characters.length) {
    characterBlock = candidates.characters.map(m => {
      const name = getForumDisplayName(space, m.id, m.name);
      const memory = (charMemory && charMemory[m.id]) || 'None';
      const privateWb = worldBookData.privateTexts?.[m.id] || '';
      const wbSection = privateWb
        ? `\n<${name}_private_lore>[TOP SECRET: only ${name} knows this; nobody else may mention or reference it]\n${privateWb}\n</${name}_private_lore>`
        : '';
      const peekLog = postAuthorUserAlias ? [] : (post.hiddenLinkState?.[m.id]?.peeks || []);
      const peekSection = peekLog.length
        ? `\n<${name}_secret_peek>[TOP SECRET: ONLY ${name} knows they have been secretly watching this post. NO other character or NPC may know or mention this.]\n${peekLog.map(pk => `- 偷看了评论「${pk.readText || ''}」，当时心想：${pk.thought || ''}`).join('\n')}\n</${name}_secret_peek>`
        : '';
      const rels = (space.relations || []).filter(r => r.from === m.id || r.to === m.id)
        .map(r => {
          const otherId = r.from === m.id ? r.to : r.from;
          const otherName = findForumPersonName(space, otherId) || 'someone';
          return `relation with "${otherName}": ${r.label}`;
        }).join('; ');
      return `[CORE CHARACTER: ${name}]\n- Persona: ${getForumMemberPersona(m) || 'None'}\n- Relationship drivers: ${rels || 'no special relations'}\n- Private memory (only this character knows): ${memory}${wbSection}${peekSection}`;
    }).join('\n\n====================\n\n');
  }

  let npcBlock = '';
  if (candidates.npcs.length) {
    npcBlock = candidates.npcs.map(m => {
      const name = getForumDisplayName(space, m.id, m.name);
      const rels = (space.relations || []).filter(r => r.from === m.id || r.to === m.id)
        .map(r => {
          const otherId = r.from === m.id ? r.to : r.from;
          const otherName = findForumPersonName(space, otherId) || 'someone';
          return `relation with "${otherName}": ${r.label}`;
        }).join('; ');
            const npcPeekLog = postAuthorUserAlias ? [] : (post.hiddenLinkState?.[m.id]?.peeks || []);
            const npcPeekSection = npcPeekLog.length ? `\n- Previous secret inner voices (DO NOT repeat or rephrase these, say something new next time): ${npcPeekLog.map(pk => `「${pk.thought || ''}」`).join(' / ')}` : '';
            return `[RELATED NPC: ${name}]\n- Persona: ${getForumMemberPersona(m) || 'ordinary netizen'}\n- Relationship drivers: ${rels || 'no special relations'}${npcPeekSection}`;
          }).join('\n\n');
  }
  const hasNamedActors = candidates.characters.length || candidates.npcs.length;
  const totalFloors = (post.comments || []).length;
  const repliedFloor = (replyContext && Number.isInteger(replyContext.commentIndex)) ? replyContext.commentIndex + 1 : null;
  const hasMixedReplyTargets = Boolean(replyContext?.hasMixedReplyTargets);
  const latestUserBatchText = String(replyContext?.userBatchText || '').trim();
  const latestUserBatchRule = latestUserBatchText ? `\nThe user's just-sent batch (each bullet is ONE independent message with its OWN target):\n${latestUserBatchText}\nHandle each bullet SEPARATELY — never blend them:\n- "回复 Floor N 的 X（原话：...）：..." means the user replied to person X inside Floor N. Comments answering THIS bullet MUST set quoteFloor=N and replyTo=X, and must react ONLY to what X said plus the user's reply there. Never drag in another floor's topic.\n- "新楼 Floor N：..." is a fresh bottom comment: leave quoteFloor null and just react at the bottom.\n- If bullets point at DIFFERENT floors, keep each floor's replies strictly inside its own floor. NEVER answer Floor 2's message with a quoteFloor=5 comment, never merge two floors into one target, never let one floor's words leak into another floor's reply.\nIf a bullet contains [表情含义：X], treat X as the emotional meaning of the sticker attached to that same bullet.` : '';
  const activeForumDirection = replyContext?.forumDirection?.text
    ? replyContext.forumDirection
    : getActiveForumDirection(post);
  const forumDirectionRule = activeForumDirection?.text ? `
# USER PLOT DIRECTION (temporary, high priority)
The user has set this temporary direction for the whole forum discussion:
"${activeForumDirection.text}"
Remaining user-send rounds after this one: ${Math.max(0, Number(activeForumDirection.turnsLeft) - 1)}
Follow this direction through the mood, topic focus, character choices, and reply tendency of the comment section. Do it naturally inside forum comments. Do NOT mention this instruction, do NOT say you are following a direction, and do NOT break existing facts or character boundaries.` : '';
  const directReplyMember = replyContext?.realCharId
    ? (space.members || []).find(member => member.id === replyContext.realCharId)
    : null;
  const directReplyRule = directReplyMember
    ? `\nDIRECT REPLY TARGET RULE: the user directly replied to "${getForumDisplayName(space, directReplyMember.id, directReplyMember.name)}". This person MUST answer at least once in Part 1, and that answer MUST set quoteFloor=${repliedFloor}.`
    : '';
  let modeInstruction;
  if (mode === 'init') {
    modeInstruction = `[Scene: the user just opened the post]\nGenerate a base layer of comments (${floors.length ? 'continue from existing' : 'start from Floor 1'}) to create the feel that "people are already discussing". Mostly bystander onlookers.`;
  } else if (mode === 'continue') {
    modeInstruction = `[Scene: continue the living comment section naturally]\nThe user did not send a new comment this round. Continue the discussion as if everyone is still scrolling and reacting in real time. Do not repeat or summarize earlier comments, do not invent a user message, keep the same topic and existing facts, but let the mood develop naturally.\nCRITICAL — this round MUST be a MIX of two kinds of comments, not only new bottom-level floors:\n1. NESTED replies into EXISTING floors (this is the main point of continuing): pick several existing floors above — including ones that already have their own nested "└" replies — and reply INTO them to deepen the back-and-forth. Each such comment MUST set quoteFloor to that existing floor's number and replyTo to that person's name, and must react specifically to what that person actually said (agree, tease, push back, answer, pile on), building a real multi-layer thread. Prioritise floors where a conversation has already started so those sub-threads grow deeper.\n2. A few fresh bottom-level comments (quoteFloor null) to keep new topics coming in.\nAim for the nested replies to be at least half of this round so the section visibly grows in depth, not just in length.\nCOUNT — generate the SAME amount as a normal round: at least 7 comments, aiming for 7 to 12 in total (nested replies + fresh bottom comments combined). Do NOT output fewer just because it is a continuation.`;
  } else if (hasMixedReplyTargets) {
    modeInstruction = `[Scene: the user replied to SEVERAL different floors at once in one batch]\n${latestUserBatchRule}\nProcess the batch FLOOR BY FLOOR: for EACH floor the user replied to, generate that floor's responses as a self-contained group whose quoteFloor equals that exact floor number, reacting only to that floor's own conversation. Finish one floor's group before starting the next. Do NOT blend floors, do NOT reply to the wrong person, do NOT treat the whole batch as bottom comments. After handling every replied floor, you MAY add a few fresh bottom comments to keep the thread alive.`;
  } else if (repliedFloor && repliedFloor < totalFloors) {
    modeInstruction = `[Scene: the user replied INSIDE Floor ${repliedFloor}, not the latest floor]\nThe user's reply is in the reply area of Floor ${repliedFloor} (not at the bottom).${latestUserBatchRule}${directReplyRule}\nSplit your output into two parts:\nPart 1: react to the user's just-sent batch; these comments MUST set quoteFloor = ${repliedFloor} so they land in Floor ${repliedFloor}'s reply area and actually answer the user.\nPart 2: a few more comments continuing the latest discussion near Floor ${totalFloors}, keeping the thread alive.\nBoth parts are required.`;
  } else {
    modeInstruction = `[Scene: the user just posted new comment(s)]\nThe user's latest sent batch is at the bottom, ending at Floor ${totalFloors}.${latestUserBatchRule}\nReact to THIS just-sent batch — some agree, some push back, the mood may shift. Don't re-review the whole post; focus on the user's fresh message(s). If replying to a specific comment, set quoteFloor to that floor number.`;
  }
  const namedRoster = [
    ...candidates.characters.map(m => getForumDisplayName(space, m.id, m.name)),
    ...candidates.npcs.map(m => getForumDisplayName(space, m.id, m.name))
  ];
  const rosterRule = namedRoster.length
    ? `[NAMED ENTITY WHITELIST]: ${namedRoster.join(', ')}. Only these names may appear as identity="character" or "npc", and the name must match exactly.`
    : `[NO core character/NPC is eligible in this post]: every comment must be identity="passer". Never invent any core character.`;
  const mentionRule = `[@MENTION FEATURE]: each comment MAY optionally fill the "mention" field to @ one person.
- You can @ the user "${fcUserName}" to throw a topic or question directly at them;
- You can also @ another core character/NPC display name to pull them into the comments (the @'d one may show up later to respond);
- A passer or NPC MAY occasionally @ one of their OWN made-up friends: invent a brand-new casual Chinese netizen handle that is NOT any core character/NPC/user and NOT one of the example names.
- 【CRITICAL — how to write an @ comment naturally】An @ is just how a real person talks TO someone mid-conversation, NOT an announcement to drag people over. STRICTLY FORBIDDEN: do NOT keep starting @ comments with "@某某 快来看…" / "@某某 看看这个…" / "@某某 你看…" — this "come look at this" template is stiff and overused. Instead the @ should blend into a real remark, and the @name can sit ANYWHERE (start, middle, or end), not always at the front. Real usage covers MANY situations, mix them freely:
  · answering / continuing what that person said: "对啊 @阿May 上次不也这样", "@阿May 说得对";
  · teasing / poking a friend: "这不就是 @小鱼 本人吗", "@小鱼 出来挨打";
  · pushing back / arguing: "@某某 我不同意，明明是…";
  · sharing a feeling with a friend: "笑死 @团团 我们上次那个", "@团团 我又想起来了";
  · pulling someone in only when it truly fits: "这个 @某某 应该懂";
  · asking someone a direct question: "@某某 你觉得呢".
- Keep every @ comment short, spoken, and specific to what's being discussed. Vary the sentence pattern EVERY time — never let two @ comments in the same batch share the same opening.
- When a comment @'s a made-up friend, that friend MAY (roughly half the time — your call) appear in the SAME batch as another anonymous passer replying to the @ (set that reply's quoteFloor to the caller's floor number and replyTo to the caller's name). Keep the friend's reply short and natural like a real friend popping in ("来了来了", "笑死这也叫我", "什么事说"), and give the friend its own fresh handle.
- @ must be natural and fit the plot and relationships. Use it SPARINGLY: most comments have no @ at all, don't force it. Leave mention as an empty string if not @'ing anyone.`;

  const authorIsAlias = (space.aliases || []).some(a => a.id === post.authorId)
    || Boolean(findForumCharacterAlias(space, post.authorId))
    || String(post.authorId).startsWith('alias_')
    || String(post.authorId).startsWith('char_alias_');
  const authorProfile = space.forumProfiles?.[post.authorId] || {};
  const authorFansNum = Number(authorProfile.fans) || 0;
  const authorOcc = authorProfile.occupation || '';
  const authorFamousRealName = authorIsFamous && !authorIsAlias;
  const famousRuleParts = [];
  if (authorFamousRealName) {
    famousRuleParts.push(`[The author is a celebrity posting under their REAL public account]: the author "${post.authorName}" is a celebrity in this world${authorOcc ? `(${authorOcc})` : ''}${authorFansNum ? `, ~${authorFansNum} fans` : ''}. Everyone already knows who this is. So comments are fans and curious people — familiar praise, jokes, asking for more, care, teasing, plus passers drawn in by the content. Never use surprise lines like "isn't this XX?!" / "omg is this really you?!" / "didn't expect to catch you here" — that only happens when bumping into a celebrity on someone else's turf.`);
  }
  if (authorIsAlias && fcUserFamous) {
    famousRuleParts.push(`[The author is likely a celebrity's anonymous alias]: the author uses an anonymous alias; most people can't tell who it is, so treat it as an ordinary post. Rarely, one or two sharp fans may feel "this tone seems oddly familiar" and quietly wonder, but NEVER directly expose them or dig up their identity — keep the mystery.`);
  }
  if (famousActors.length) {
    famousRuleParts.push(`[A celebrity appears in someone else's comments]: celebrities involved: ${famousActors.join('; ')}. When they appear here (or are mentioned), sharp fans/passers may be surprised/excited: "isn't this XX?!" "omg the real person?!" "caught them!" — higher fan count = higher chance of recognition. But not everyone recognizes them: some are excited, some have no idea and treat them as a passer, some half-doubt and ask. Allow misrecognition and false alarms. If a celebrity hides behind an alias (identity=alias), only let one or two fans faintly sense it; don't let the whole site instantly expose them.`);
  }
  const famousRule = famousRuleParts.join('\n');
  const famousSelfRule = (authorFamousRealName || famousActors.length)
    ? `[Celebrity self-awareness (when a celebrity character speaks)]: a celebrity knows they're a public figure whose every move is watched, screenshotted, discussed and amplified. So when they comment they are more careful, or keep up their persona, or feel awkward/amused about being watched, per their personality. They must NOT speak as carelessly as an anonymous unknown passer (unless their persona is exactly the reckless type).`
    : '';
  // 名人倾向用小号、非名人很少匿名
  const aliasEligibleActors = [...candidates.characters];
  const aliasFamousActors = aliasEligibleActors.filter(m => m.isFamous || space.forumProfiles?.[m.id]?.isFamous);
  const aliasNormalActors = aliasEligibleActors.filter(m => !(m.isFamous || space.forumProfiles?.[m.id]?.isFamous));
  const aliasBehaviorParts = [
    `[MAIN NPC ACCOUNT BOUNDARY]: Main NPCs do NOT have forum aliases. Whenever a named/main NPC comments or sends a DM, use identity="npc" and that NPC's real main account. NEVER use identity="alias" with an NPC in realName, and NEVER invent an NPC alt account.`
  ];
  if (aliasFamousActors.length) {
    aliasBehaviorParts.push(`[Famous characters STRONGLY prefer anonymous aliases]: ${aliasFamousActors.map(m => getForumDisplayName(space, m.id, m.name)).join('、')} are public figures who know their real accounts carry fans and influence and cannot post freely. So when they engage with the forum they OVERWHELMINGLY use an anonymous alias (identity="alias"), almost never their real account. While in alias mode they are smart and careful — they blend in as a totally ordinary netizen and NEVER drop vague hints, signature catchphrases, or telltale details that expose their real identity. The point of the alias is to stay hidden, so they do not behave conspicuously or specially.
CRITICAL EXCEPTION — when directly addressed by real name: if the user or another commenter explicitly @'s or calls out the character by their REAL main-account display name (e.g. the post content, a comment, or a mention contains "@大号名字", or directly asks that real name to respond), the character MUST reply using their REAL main account (identity="character") with their real display name from the whitelist, NOT an alias. Being publicly called out by real name means someone is talking to the real public figure; hiding behind an alias in that situation would be unnatural, bizarre, and disrespectful to the person who @'d them. After responding on the main account, the character may return to using an alias in later unrelated rounds.`);
  }
  if (aliasNormalActors.length) {
    aliasBehaviorParts.push(`[Non-famous characters DEFAULT to their real account — alias is a rare exception]: ${aliasNormalActors.map(m => getForumDisplayName(space, m.id, m.name)).join('、')} are ordinary people nobody specially watches. Their DEFAULT and overwhelmingly normal behavior is to comment openly with their REAL account (identity="character"). This includes posts that openly and clearly involve them: if the user @'d them, named them, or the post/short-video is obviously about their relationship or clearly connected to them in the open, they MUST use their real account and interact openly, proudly, or naturally — a normal person has NO reason to hide when someone is openly interacting with them or posting about their known relationship.
They may ONLY switch to an anonymous alias (identity="alias") in these two narrow, SECRETIVE situations:
  1) The post is secretly badmouthing / gossiping about / mocking them behind their back (蛐蛐他);
  2) The post is discussing something related to them WITHOUT naming them, only implying/hinting (暗指、影射，没有明说是他).
In BOTH cases the defining feature is that the connection is HIDDEN or UNSPOKEN, so they lurk anonymously to see what people really say. If the connection to them is explicit, public, or directly addressed to them, alias is FORBIDDEN — use the real account.`);
  }
  const aliasBehaviorRule = aliasBehaviorParts.join('\n');
  const fixedAliasRule = buildForumFixedAliasRule(space, aliasEligibleActors);
  const postAuthorUserAliasRule = postAuthorUserAlias
    ? `[USER ALT ACCOUNT BOUNDARY]: The post author is an anonymous forum alt account. Treat it as an ordinary account in the public comment section. Do NOT guess, expose, or discuss who owns this alt.`
    : '';
    // 新增：当前用户如果正在用小号活动，评论区和私信都必须默认认不出这个小号是用户本人
  const currentUserAliasRule = fcCurrentUser?.isAlias
    ? (() => {
        const currentAlias = getCurrentAlias(space);
        const knownNames = getForumAliasKnownMemberNames(space, [...getForumUserAliasKnownMemberIds(currentAlias || {})]);
         return `[CURRENT USER IS USING AN ANONYMOUS ALT ACCOUNT — identity isolation, TOP PRIORITY]: Right now the user is browsing / commenting under their OWN anonymous alt account "${fcCurrentUser.name}"(@${fcCurrentUser.account}). The real owner of this alt IS the user, but this is an ABSOLUTE SECRET. In BOTH the comments AND any dmHints, every passer, ordinary NPC, main NPC and character MUST treat "${fcCurrentUser.name}" as an ordinary account whose real-world owner they do NOT know. They MAY still chat with it, ask it questions, react to it, tease it or care about the CONTENT it publicly posted — friendly or caring wording is fine, because a stranger can be nice to another stranger. What is STRICTLY FORBIDDEN is any sign they have figured out WHO is behind this alt: they must NEVER state, guess, hint, imply, or act on the idea that this account belongs to the user / to "${fcUserName}"; NEVER address it as "your alt / your real self / 我知道这是你"; and NEVER use any information only the real person's acquaintance could know (the user's real identity, private life, real relationships, secrets). React only to its public words, never to the person behind it. ${knownNames.length ? `EXCEPTION — ONLY these people already secretly know this alt is the user's and may quietly act on that knowledge (but must still never out them in public): ${knownNames.join('、')}. Everyone else has NO idea who "${fcCurrentUser.name}" really is.` : `NO character or NPC currently knows this alt is the user's, so absolutely nobody may recognize this account as the user.`}`;
      })()
    : '';
    // 新增：判断本帖是不是论坛账号自己发的，是的话给它一套"楼主可以多回复但要克制、别只理用户"的规则
  const authorMember = (space.members || []).find(m => m.id === post.authorId);
  // 小号帖子：authorId 是匿名小号，需用 sourceCharacterId 找到背后的真身角色
  const authorAliasOwner = !authorMember && post.sourceCharacterId
    ? (space.members || []).find(m => m.id === post.sourceCharacterId)
    : null;
  let authorReplyRule = '';
  if (authorMember) {
    authorReplyRule = `[THE POST AUTHOR IS THE ACCOUNT OWNER — special reply behavior]: This post was written by "${post.authorName}" (NOT the user). Because it is THEIR OWN post, they are noticeably MORE active in their own comment section than the "rare guest" rule above suggests — that rarity rule is for OTHER people's posts, not for the author replying under their own post. HOWEVER obey these limits strictly:
(1) PER ROUND the author speaks only a LIMITED amount: at most 1 to 3 short replies. Never a wall of text, never flood every floor, never reply to everyone at once.
(2) The author must NOT only reply to the user. They should ALSO naturally reply to ordinary passers/NPCs who commented on their post — thanking, joking back, clarifying, bantering — exactly like a real person handling replies under their own post.
(3) Stay fully in character, keep each reply short and colloquial. When replying to a specific floor, set quoteFloor to that floor number and replyTo to that person's name.`;
  } else if (authorAliasOwner) {
    const aliasOwnerName = getForumDisplayName(space, authorAliasOwner.id, authorAliasOwner.name);
    authorReplyRule = `[THE POST AUTHOR IS A CHARACTER'S ANONYMOUS ALIAS — special reply behavior]: This post was written by the anonymous alias "${post.authorName}", which is secretly the private alt account of core character "${aliasOwnerName}". NOBODY in the comments knows who is behind this alias, and it MUST stay that way.
(1) FREQUENCY — even MORE restrained than a main-account author: the alias author replies only 0 to 2 short times per round, and MANY rounds they stay completely silent. Never flood, never reply to every floor, never reply to everyone.
(2) TONE — this is the key difference from the main account: the main account is where "${aliasOwnerName}" performs, stays composed and keeps up appearances; the ALIAS is where the guard drops COMPLETELY and the real, raw emotion pours out. When the alias author replies, they say the things they would NEVER dare say on the main account — the naked truth, the un-swallowable feelings: jealousy, longing, grievance, obsession, resentment, heartbreak, secret joy, pettiness, possessiveness. The emotional exposure is MUCH HIGHER than the main account, not lower. It can be intense, unfiltered, even a little unhinged or contradictory — like ripping off the mask at 3am and finally letting it out. This does NOT mean shouting or theatrics; it means EMOTIONALLY HONEST and UNGUARDED, letting real feeling surface instead of the polished public face. NEVER "营业", NEVER perform, NEVER sound like a curated public figure. If the reply is as composed and safe as something the main account could post, it is WRONG — rewrite it to expose what the character actually feels but hides in public.
(3) IDENTITY — the alias author replies ONLY as the alias: set identity="alias", realName="${aliasOwnerName}", speaker="${post.authorName}". NEVER reply under the real name, NEVER drop signature catchphrases, real name, or telltale details that let passers guess who they are.
(4) When replying to a specific floor, set quoteFloor to that floor number and replyTo to that person's name.`;
  }
  const authorDmActor = authorMember && !isForumTemporaryOrdinaryMember(authorMember) ? authorMember : (authorAliasOwner || null);
  const authorKnowsCurrentAlias = authorDmActor && fcCurrentUser?.isAlias
    ? isForumUserAliasKnownToMember(space, getCurrentAlias(space), authorDmActor)
    : false;
  const authorDmHintRule = authorDmActor ? (() => {
    const actorName = getForumDisplayName(space, authorDmActor.id, authorDmActor.name);
    if (!fcCurrentUser?.isAlias || authorKnowsCurrentAlias) {
      return `[POST AUTHOR DM FREQUENCY]: Because the current forum account is ${fcCurrentUser?.isAlias ? `an alt already known by ${actorName}` : 'the user main account'}, the post author "${post.authorName}" MAY be more willing than usual to privately follow up when the user's comment clearly gives them a personal reason. Still do not spam; dmHints can stay empty.`;
    }
    return `[POST AUTHOR DM FREQUENCY — UNKNOWN USER ALT]: The current commenter is using an anonymous user alt that "${actorName}" does NOT know belongs to the user. Therefore the post author "${post.authorName}" MUST NOT get a special high-frequency private-DM boost just because this is their own post. Treat this account like an ordinary forum stranger for dmHints: only send a private message if the same comment-section moment would justify DMing a stranger; otherwise leave dmHints empty.`;
  })() : '';
    // 新增：别人的帖子里，明确告诉 AI 楼主是发帖人而不是用户
  const posterIsUser = isForumMainUserAuthoredId(post.authorId);
  const posterIdentityRule = posterIsUser
    ? ''
    : `[WHO IS THE 楼主 / ORIGINAL POSTER — must obey]: The 楼主 (original poster) of THIS post is "${post.authorName}", NOT the user. The user "${fcUserName}" is only a commenter here and may not have commented at all. NEVER call the user "楼主", NEVER treat the user's comment as if it were the post itself, NEVER assume the user wrote this post. Whenever anyone says "楼主" it refers ONLY to "${post.authorName}".`;
  const fcUserBio = space.forumProfiles?.[fcUserId]?.bio || '';
  const fcUserRealName = String(fcIdentity?.name || '').trim();
  const fcUserPersona = String(fcIdentity?.persona || '').trim();
  const fcUserHasRealName = Boolean(fcUserRealName && fcUserRealName !== fcUserName);
  const personaAllowedNames = fcCurrentUser?.isAlias
    ? aliasKnownActorNames
    : [...(candidates.characters || []), ...(candidates.npcs || [])].map(item => getForumDisplayName(space, item.id, item.name));
  const userBioRule = (fcUserFamous || candidates.characters.length > 0 || candidates.npcs.length > 0) && (fcUserBio || fcUserPersona)
    ? `[USER PERSONA (Reference Only)]: The user's forum display name is "${fcUserName}".${fcUserBio ? ` Public bio: "${fcUserBio}" — this bio is PUBLIC, anyone may read it.` : ''}${fcUserPersona ? `\n[USER PRIVATE PERSONA — restricted]: ${fcUserPersona}\nWHO MAY USE THIS PRIVATE PERSONA: ${personaAllowedNames.length ? `ONLY ${personaAllowedNames.join('、')}. They know the user personally and may let this understanding shape their tone and reactions, but must NEVER recite, quote, summarize or announce it in public.` : 'NOBODY in this comment section. Treat it as unavailable information.'}\nEVERYONE ELSE (all passers, ordinary NPCs, and anyone not listed above) MUST NOT know, reference, quote, hint at, or act on ANY detail from this private persona. They only see the public words on screen.` : ''}\nCRITICAL: Do NOT generate comments as this user. Passersby do NOT mind-read private secrets unless it is public knowledge.`
    : '';
  const userRealNameRule = fcUserHasRealName
    ? (fcCurrentUser?.isAlias
      ? `[USER REAL NAME + ALT ACCOUNT — strict layered secrecy, TOP PRIORITY]: The user's real name / the name close people call them is "${fcUserRealName}". Right now the user is posting/commenting under their anonymous alt account "${fcCurrentUser.name}", so this real name is a SECRET tied to the alt's anonymity.
${aliasKnownActorNames.length ? `- ONLY these people already secretly know this alt belongs to the user, and therefore ONLY they may connect "${fcUserRealName}" to this account: ${aliasKnownActorNames.join('、')}. They may quietly act on that knowledge and may know the user's normal information, but they must NEVER out them in public, never say the real name out loud in the comment section, and never hint to others who this account is.` : `- NOBODY in this comment section knows this alt belongs to the user, so NOBODY may connect "${fcUserRealName}" to this account.`}
- EVERYONE ELSE (all passers, ordinary NPCs, and any character/NPC not listed above) MUST treat "${fcUserRealName}" as a name that has nothing to do with this account's owner. They must NEVER say, guess, hint, or imply that this account is "${fcUserRealName}", and must NEVER use the real name as a way to address this account.
- If "${fcUserRealName}" happens to appear inside the post or comment content, people who do not know the alt may discuss that name as an ordinary third party being talked about, but must NOT jump to "so the poster is that person".
- NEVER let anyone announce, explain, or lecture about this name mapping. Keep the alt's anonymity intact.`
      : `[USER REAL NAME KNOWLEDGE — tiered, must obey]: The user's forum nickname is "${fcUserName}", but their real name / the name close people call them is "${fcUserRealName}". These are the SAME person.
- Core characters and named/main NPCs (everyone listed in the whitelist above) ALL know this: whenever the post or comments mention "${fcUserRealName}", they immediately understand it refers to the person behind "${fcUserName}". They must NEVER ask "who is ${fcUserRealName}", never treat that name as a stranger, an OC, a self-insert character, or an unknown third party. They may naturally call the user by either name depending on how close they are.
- Ordinary passers and ordinary NPCs by DEFAULT do NOT know that "${fcUserRealName}" is this account's real name. In most batches they should treat it as just a name appearing in the content and NOT connect it to the poster.
- EXCEPTION for ordinary passers: occasionally (RARE — at most ONE comment in the whole batch, and only when it feels natural) a single sharp passer MAY vaguely guess or wonder aloud whether that name is the poster themselves. Keep it as a light guess, never a confident reveal, and never let the whole comment section figure it out.
- NEVER let anyone announce, explain, or lecture about this name mapping. It should surface only through natural wording.`)
    : '';
  const fcForumUser = getCurrentForumUser(space);
  const stickerRule = buildForumStickerPermissionText(space, candidates, fcForumUser.name, fcForumUser.id);
  const shortVideoForTimeNode = Array.isArray(post.media) ? post.media.find(item => item?.type === 'slides-video') : null;
  const shortVideoTotalSeconds = shortVideoForTimeNode ? getForumShortVideoTotalSeconds(shortVideoForTimeNode) : 0;
  const eventHistoryRule = buildForumEventHistoryPrompt(space);
  const activeEventRule = buildForumActiveEventPrompt(space, 'comment');
  const forumTrendRule = getForumTrendsForDmPrompt(space);
  const currentPostTrend = post.discoverTrendId
    ? findForumDiscoverTrend(space, post.discoverTrendId)
    : getForumDiscoverTrends(space).find(trend => trend.text === post.discoverTrendText) || null;
  const currentPostTrendName = currentPostTrend?.text || '';
  const currentPostTrendRule = currentPostTrendName
    ? `[CURRENT POST TREND CONTEXT]: This post is under / related to the public hot-search trend "${currentPostTrendName}". ${currentPostTrend?.event ? `Event: ${currentPostTrend.event}. ` : ''}${currentPostTrend?.process ? `Process: ${currentPostTrend.process}.` : ''}`
    : '';
  const shortVideoTimeNodeRule = shortVideoForTimeNode ? `
# SHORT VIDEO TIME NODES (Douyin-style, optional & rare)
This post is a text short-video with real per-page durations. The Post media above lists the exact second range for each page. Occasionally (rare, at most 1 or 2 comments in the whole batch, only when it fits) a passer or NPC may drop a comment pointing at a specific second, written in the exact format [mm:ss], e.g. [00:02] means the 2nd second. The second number MUST NOT exceed ${shortVideoTotalSeconds}. Pick seconds from the correct page range; do not mix up page data. This timestamp becomes a clickable jump link just like on Douyin (e.g. "[00:03]这段笑死", "蹲[00:05]名场面"). Keep it natural, never force it into every comment, and never invent a second that does not exist.` : '';
  return `[System: Forum Comment Generation Engine]
# IMPORTANT: output language
This is mainly a Chinese-language forum: speaker names and normal passer comments should be Chinese by default. However, comments CAN occasionally use other languages / dialects (Cantonese, foreign languages, classical wenyan, etc.) — but ONLY when it genuinely fits this forum's worldview and the specific post's context (e.g. a foreigner passer on a globally-themed post, a Cantonese local under a Cantonese-region post, a character/NPC whose persona speaks that language). NEVER drop in a random foreign language that has nothing to do with the worldview or the post. Whenever a comment's "content" is NOT Standard Mandarin, you MUST put its Standard Mandarin meaning in that comment's "translation". If content is already Standard Mandarin, "translation" must be empty. Keep multilingual comments a rare, natural minority — the overall section is still Chinese-dominated.
# Forum background
- Forum name / worldview: ${space.name} / ${space.world || 'None'}
${worldBookData.publicText ? `- Public lore: ${worldBookData.publicText}` : ''}
- Post author: ${post.authorName}
- Post circle: ${post.circle || 'public'}
- Post body: ${post.content || '(image/share)'}
- Public couple-account context: ${publicCoupleContext || 'None'}
- Post media:
${postMediaText}
${eventHistoryRule}
${activeEventRule}
${forumTrendRule ? `${forumTrendRule}
Treat these trends as PUBLIC background knowledge only. Ordinary netizens can know them if asked or if this thread is clearly related, but comments must NOT broadly discuss or advertise unrelated trends. Mention a trend only when the current post is under that trend, the post/comment explicitly references it, or the user's current reply asks about it.` : ''}
${currentPostTrendRule}

${mediaVisionRule}
${threadSummaryText ? `
# Thread Summary
${threadSummaryText}
` : ''}
${userDigestsText ? `
# User's Other Forum Activity
${userDigestsText}
请记住：这是用户在论坛别处发的公开内容，不是本帖发生的事，不要把它当成此处对话。
` : ''}

# This is an ASYNC online forum (critical, everyone obeys)
Everyone is on their own phone/computer browsing this forum — not in the same physical space, not face to face. Characters/NPCs merely scrolled past this post and commented. They do NOT know where the user is or what they're doing right now, and must NOT assume the user is nearby. Never write lines like "why aren't you home yet" / "I see you" / "you're right next to me" / "come over". All interaction happens online.
# Relationship network (background reference only)
${relationNetworkText}
These relationships exist ONLY to keep each character's/NPC's own behavior consistent. They are NOT public knowledge. Anonymous passers do NOT know them and must never assume or reveal them (e.g. never say "aren't you two friends?" unless it is an openly known public fact). Only the people inside a relationship know it themselves.
# Sniff out the community culture (highest priority)
First judge what kind of community this is (campus confession / fandom / workplace venting / gaming forum / ancient-fantasy world ...). All comments must use that community's slang, tone and memes. Never default to generic internet speak, and never use modern memes in a non-modern setting.
# Anti-LLM-habit rules
1. Fragmented & Colloquial (极度口语化): 80% of comments must be under 15 Chinese characters. Use natural spoken feel, minimize full stops. No textbook grammar, no theatrical words.
2. Mood (default warm & fun): judge the post type first. Ordinary / daily / sharing posts -> the comment section is friendly, jokey, relatable, onlooking. Fans, gushing and CP/shipping talk are all totally welcome — do NOT suppress them. The ONLY thing to avoid is stale, dated meme phrases: skip overused lines like 磕死我了 / 踢翻狗粮 / awsl / 我死了 / xswl / 前排 / 蹲一个 and similar worn-out catchphrases. You can still express the SAME excitement or shipping feelings, just phrase them in fresh, specific, natural spoken words a real person would actually type today. A calm normal comment with no meme at all is also fine — not every line needs a punchline.
3. Nested replies must stay ON-TOPIC (very important): whenever a comment responds to an existing comment (even a nested "└" reply), you MUST fill quoteFloor with the PARENT's floor number (plain integer, e.g., 2), never null, and fill replyTo with the replied person's name. CRITICAL: a nested reply must directly react to what THAT specific person actually said in THAT floor — agree, push back, tease, answer their question, or build on their exact point. Do NOT go off on a brand-new unrelated tangent inside a reply, do NOT ignore the parent comment's content, and do NOT just repeat the post's main topic as if it were a fresh bottom comment. Read the parent line first, then reply to it specifically, the way real people argue and chat back-and-forth in a comment thread.
4. Ordinary NPCs/passers are the majority: most of the section must be ordinary forum users, bystanders, fans, antis, classmates, coworkers, neighbors, shop staff, local witnesses, etc. Core characters and named NPCs are rare guests, not the default speakers.
5. NO RECAPPING & No persona-reciting: NEVER summarize, rephrase, or echo back other people's messages. Characters must never recite their own settings.
6. Restrain periods: avoid sentence-ending periods; use particles/ellipses/exclamation marks.
7. Don't guess identities recklessly: netizens treat posts as ordinary content.
8. USER SILENCE RULE: NEVER generate a comment as the current user "${fcUserName}". NEVER speak for the user, defend as the user, explain the user's feelings, or write "我" from the user's perspective.
9. NO DRAMA / anti-over-acting (极其重要): This is an ordinary comment section, NOT a soap opera. Keep every emotion at a realistic, everyday, low-key level — the default is calm and casual, like a real person idly scrolling and typing a line. Do NOT narrate or announce other people's feelings, and do NOT invent conflict for drama. STRICTLY FORBIDDEN clichés: never say things like "楼主急了 / 楼主破防了 / 破防了 / 绷不住了 / 蚌埠住了 / 应激了 / 破大防", never declare someone is angry/hurt/exposed on their behalf, never fake exaggerated outrage, shock, or theatrical gasping. Light banter and teasing are welcome, but they must read as a chill, understated aside — a normal person joking, NEVER a performer acting out an emotional scene. When in doubt, tone it DOWN.
10. Slang restraint / use memes SPARINGLY (极其重要): Real-human vibe comes from dropping the RIGHT meme at the RIGHT moment, NOT from stuffing slang into every line. The DEFAULT register is plain, natural spoken Chinese — most comments should contain ZERO internet slang, catchphrases, abbreviations (like yyds/awsl/xswl/绝绝子/栓Q/尊嘟假嘟/我真的会谢/city不city) or forum jargon. Only when a meme genuinely nails the exact situation may ONE comment use ONE meme, and it must feel effortless and precise, like a real person who happened to think of the perfect line. NEVER let multiple comments in the same batch lean on slang; NEVER pile several slang terms into one comment; NEVER use a meme just to seem lively. If a plain sentence works, use the plain sentence. When unsure, drop the slang entirely.
11. NO ECHO / bring something NEW (极其重要): Before writing each comment, scan the existing comment history above. Do NOT repeat, paraphrase, or restate a viewpoint, joke, feeling, or reaction that an earlier floor (passer, NPC, or character) already expressed. Every new comment MUST add a genuinely new angle: a different observation, a counterpoint, a fresh personal detail, a follow-up question, or a reply that pushes the conversation forward. If you truly have nothing new to add, generate fewer comments rather than padding the batch with near-duplicates.
    ${hasNamedActors ? `
    # [Identity & Brain Isolation - CRITICAL] (大脑隔离与信息壁垒)
    You are playing multiple distinct people. They have different brains and feelings. **Character A has NO IDEA what Character B is thinking or experiencing.**
    - Characters ONLY know what is explicitly stated in their own profile or private memory.
    - **NPC Boundary**: An NPC ONLY knows the persona of the specific Core Character they are related to. They do NOT know the secrets, private memories, or true personas of other Core Characters.
    - DO NOT merge their personalities or knowledge. Strict isolation is required!

    # Core character profiles (brain-isolated, each independent)
    ${characterBlock || '(no core characters in this post)'}
# Related NPC profiles
${npcBlock || '(no related NPCs in this post)'}

# APPEARANCE RESTRAINT (EXTREMELY IMPORTANT — this controls how often characters/NPCs show up)
The above characters/NPCs are ELIGIBLE to appear, but appearing is NOT mandatory and should be RARE. Default assumption: they do NOT comment. Judge whether they would realistically bother right now.
- FREQUENCY (very important): do NOT put a core character or a named NPC in EVERY batch. Across multiple rounds, a large share of batches should be PURE passers with zero core characters and zero named NPCs — that is the normal, preferred state. Only bring a character/NPC in when there is a real reason (directly @'d, name called out, plot beat). A batch that is all anonymous passers is a success, not a gap to fill.
- Ordinary NPCs are the backbone: use invented ordinary NPC/passers freely. Named NPCs attached to core characters are still "named actors" and should be less frequent than ordinary NPCs/passers.
- A core character is a "luxury good": they come down only when directly poked, @'d, or the plot truly demands it. Most of the time they simply don't show up — that is normal and preferred.
- When a character DOES appear, keep it minimal and in-character. Example: if the post is just a fan praising a photo and the character is an idol on an anonymous alias, the realistic reaction is AT MOST ONE or TWO short, shy lines — not a stream of comments. An idol would never flood a stranger's praise post.
- One person, one appearance: the same character/NPC must NOT scatter several separate comments across the section. If they speak, it's once (or two adjacent lines to finish a thought), then done.
- NPCs are living people of this world, not tools serving the character/user. They can chime in fairly freely based on relationship drivers. IMPORTANT — build real back-and-forth: when an NPC comments, other NPCs or passers should sometimes REPLY to that NPC (set quoteFloor to the NPC's floor and replyTo to the NPC's name), teasing, agreeing, arguing, gossiping, or piling on, so the section forms genuine nested threads instead of everyone posting isolated one-off lines. NPC-to-NPC banter is encouraged; just keep anonymous passers as the overall majority.
- Alias mechanic: a character/NPC may speak under an anonymous alias hidden among passers. Then identity="alias", speaker = an internet-style alias name, realName = the real character name behind it. CONSISTENCY RULE: one character = ONE fixed alias name for the entire comment section. The same person must NEVER use two different alias names here, and must not switch between an alias and their real name in the same section. Check the comment history above: if this character already spoke under an alias, reuse that exact alias name.
- NEVER make an eligible character appear "just to appear". When in doubt, leave them out.
# Character speech rules & Emotional Control (anti-acting / anti-OOC)
- STRICTLY COLLOQUIAL (极度口语化): Use short, fragmented sentences. Omit subjects frequently. Avoid textbook grammar. Never use literary words (用大白话).
- NO GOD'S VIEW: Only know what you personally experience. NEVER project feelings onto the user.
- EMOTIONAL BASELINE (情绪基调): Patient and unhurried. When upset, go QUIETER, not louder. Teasing = wanting attention, never contempt.
- JEALOUSY & CONFLICT (吃醋与冲突): Express possessiveness through soft defense (sulking, clingy, quiet reassurance-seeking "怎么不理我"), NEVER aggression or control. In conflict, express vulnerability ("不要这样说，我会难过的"), NEVER threats ("你敢试试").
- RESPECT & AFFECTION (尊重与偏爱): Affection is shown through remembering details and quiet care, not possessive declarations. Respect the user's choices gently, NEVER lecture or grade them (绝对禁止 "算你懂事/算你识相" 或爹味教导).
- The character is browsing the forum casually. Use the real account (identity=character) when no need to hide; use an alias (identity=alias) only when hiding identity.
- Same character/NPC: either appears once, or in adjacent consecutive lines; never scattered.
` : `
# Pure-passer mode
No core character or NPC is eligible here. Every comment is an anonymous passer. Focus on a realistic onlooking/gossip vibe.
`}
# Passer naming (very important: like real netizens, don't label personas)
Real usernames are random, often unrelated to the person, sometimes deliberately silly, abstract, edgy, self-deprecating, or punny. Names must be written in Chinese.
Examples ONLY for the feel, do NOT copy: momo (the most common default alias, may repeat), 退退退退退, 我无力反驳你说得对, 内向小学鸡, 满山猴子我腚最红.
Requirement: except for momo, every passer name must be your own original Chinese creation — no copying the examples, no repeating within one batch. Cute/abstract/edgy/self-deprecating/punny all fine, varied lengths, no duplicates in one batch. Never use obviously persona-labeled names like "理性考据党" or "情绪化路人".
${rosterRule}
${mentionRule}
${famousRule}
${famousSelfRule}
${aliasBehaviorRule}
${fixedAliasRule}
${postAuthorUserAliasRule}
${authorReplyRule}
${authorDmHintRule}
${reconciliationRule}
${postAuthorUserAliasRule}
${currentUserAliasRule}
${userBioRule}
${userRealNameRule}
# NPCs HAVE THEIR OWN LIVES & the "small world" coincidence flavor
- Every NPC is a real netizen with their own independent life, NOT a tool that only exists to watch this post. They may casually mention their own day, mood, or what they are busy with, and occasionally share a genuine personal feeling, giving the comment section a breathing sense that everyone is living their own life and just happened to scroll past this post.
- Occasionally (very rare — at most ONE per batch, and it must feel completely natural) a "wow, small world" coincidence comment may appear: someone had a similar experience themselves, someone happens to live nearby, or someone happens to be a bystander of this event or close to the person involved. Keep these coincidences restrained, real, and never forced. When they appear they make the section fun, but they must NOT happen in every comment, and must never invent anything that conflicts with existing character settings or relationships.
${shortVideoTimeNodeRule}
# Current comment history (continue from here, never rewrite existing floors)
${historyText}
${modeInstruction}
${forumDirectionRule}
${(candidates.peekOnlyIds && candidates.peekOnlyIds.length) || (candidates.speakingHiddenIds && candidates.speakingHiddenIds.length) ? `
# HIDDEN LINK MECHANIC (secret relationship with this post)
Some characters have a SECRET connection to this post's author or topic, even though they were never named or @'d. They are secretly reading this post.
- PEEK-ONLY characters (${(candidates.peekOnlyIds || []).map(id => getForumDisplayName(space, id, findForumPersonName(space, id))).filter(Boolean).join(', ') || 'none'}): they are silently lurking this round and will NOT post any public comment. Instead, output their PRIVATE inner voice in the "peeks" array. STEP 1: pick ONE specific floor whose words actually touch this character's own secret tie to the post (its author / topic / their private relationship), and set readFloor to that floor's EXACT number. readFloor MUST be an integer that matches one of the numbered floors shown in the "Current comment history" above — never blank, never 0, never a floor that does not exist yet. Always tie the peek to a real existing floor.The words you react to may be a top-level floor OR a nested reply (a line starting with └) inside a floor — both are fair game; when it is a reply, still set readFloor to that reply's parent floor number, and ALWAYS copy the exact sentence you are reacting to into the readText field. IMPORTANT: each floor in the "Current comment history" is tagged with who wrote it — （用户本人发的）means the USER main account wrote it; （当前小号发的，身份默认不公开）or（匿名小号发的，身份默认不公开）means an anonymous alt account wrote it and must be treated as that account's public words, not as the user's main-account words; （角色/NPC发的）means a character or NPC wrote it; （路人发的）means an anonymous passer wrote it. Read the tag on the floor you pick and identify the author correctly. Floors tagged （路人发的）or （角色/NPC发的）are strangers/onlookers talking among themselves and are NOT addressed to this character, so react to those as a public comment you merely happened to scroll past. Only a floor tagged （用户本人发的）was actually written by the user's main account. NEVER mistake a passer's, NPC's, or alt-account floor for the user's main account talking to you. STEP 2: mutter a real in-character reaction to THOSE exact words and to what this post personally means to them — grounded in the concrete sentence on that floor, NOT a vague mood, NOT a summary, NOT anything addressed to the user. It must sound like a real person grumbling inside their own head (jealousy, longing, sulking, possessiveness...). Try to react to a DIFFERENT line than earlier inner voices (check their secret_peek log above) and add something new. MANDATORY: every PEEK-ONLY character listed here MUST output exactly one peek this round — never skip them; if everything relevant was already muttered before, pick a fresh floor or a new angle instead of staying silent.
- SPEAKING characters (${(candidates.speakingHiddenIds || []).map(id => getForumDisplayName(space, id, findForumPersonName(space, id))).filter(Boolean).join(', ') || 'none'}): they can no longer hold back and DO post a comment this round, in-character (e.g. feeling wronged, defending themselves, sulking). Because the post is implicitly about them, they have a real reason to appear even without being named.
` : ''}

${stickerRule}

# Output format (strict JSON OBJECT, no extra text)
Generate at least 7 new comments (aim for 7 to 12) in the "comments" array, numbered from Floor ${nextFloor}. Ordinary NPCs/passers dominate: at least 80% should be identity="passer" or identity="ordinaryNpc". In many batches, EVERY comment should be an ordinary NPC/passer with NO core character and NO named NPC at all. Only include a character/NPC when there is a concrete reason this round; core characters at most 1, named NPCs at most 1, and the current user always 0.
Also fill the "peeks" array ONLY for PEEK-ONLY hidden-link characters mentioned above (secret lurkers who do NOT comment this round). Leave "peeks" empty if there are none. STRICT RULE: output AT MOST ONE peek object per hidden-link character in this whole round. You must NEVER output a second peek that merely repeats, rephrases or translates another peek. The Standard Mandarin translation MUST go ONLY inside that same peek's "translation" field — it is FORBIDDEN to turn the translation into its own separate peek entry.
Account safety: ordinary NPCs/passers MUST NOT impersonate any whitelisted character, named NPC, user account, or fixed character alias. If identity is "passer" or "ordinaryNpc", speaker must be a fresh ordinary netizen handle and must not equal a known display name, account, or fixed alias. If identity is "character" or "npc", speaker must exactly match one whitelisted name. If identity is "alias", realName must exactly match the real character/NPC and speaker must exactly match that person's fixed alias name listed above; otherwise do not use alias.
If the speaker is a fixed character alias or a named NPC, you MUST NOT label them as passer/ordinaryNpc. Use identity="alias" with realName for fixed aliases, or identity="npc"/"character" for named accounts.
${dmHintRule}
Fill "dmHints" only when a private message is clearly motivated by this SAME comment-section moment. Many rounds should use an empty array; do not send DMs every round. Core characters and named NPCs should stay restrained: only message when there is a concrete reason, and do not spam. A sender may privately ask the user for details, react to the user's public comment, follow up on a post, warn them, flirt lightly, or send short gossip. These private messages are NOT public comments.
{
  "comments": [
    {
      "speaker": "display name in Chinese (passer = internet handle / character = real name / alias = alias name)",
      "identity": "passer | ordinaryNpc | character | npc | alias",
      "realName": "only when identity=alias, the real character name behind it; otherwise empty",
      "quoteFloor": floor number to quote, null if none,
      "replyTo": "display name you reply to (exact match to history), empty string if none",
      "mention": "display name to @ (can be the user or another character/NPC), empty string if none",
      "likes": random like count 0 to 999,
      "content": "comment text (If persona requires Cantonese/粤语, foreign languages, etc., keep original text here)",
      "translation": "[CRITICAL RULE: If 'content' contains Cantonese(粤语), other dialects, or foreign languages, you MUST provide the Standard Mandarin (标准普通话) translation here! If it is already standard Mandarin, leave empty '']",
      "sticker": "optional; exact keyword from this speaker's own AVAILABLE STICKERS PER PERSON list, or empty string"
    }
  ],
  "peeks": [
    {
      "speaker": "the hidden-link character's real display name",
      "readFloor": the floor number this character is secretly reading (integer),
            "readText": "copy the EXACT sentence (top-level floor OR nested reply) this character is secretly reading and reacting to, verbatim from the Current comment history",
      "thought": "This is the character's PRIVATE inner voice — a raw, spontaneous mutter to themselves while scrolling, NOT narration written for anyone to read. Keep it short, casual, emotional and self-centered (jealousy, longing, annoyance, amusement, sulking, possessiveness...), exactly like a real person grumbling inside their own head. NEVER explain the plot, NEVER address the reader/user, NEVER summarize what happened. Stay 100% in character. If the persona requires Cantonese(粤语)/dialect/foreign language, keep that original language here.",
      "translation": "[CRITICAL: If 'thought' is NOT standard Mandarin (e.g. Cantonese, dialect, foreign language), you MUST provide the Standard Mandarin(标准普通话) translation here. If it is already standard Mandarin, leave empty '']"
    }
  ],
  "dmHints": [
    {
      "speaker": "sender display name in Chinese",
      "identity": "passer | ordinaryNpc | character | npc | alias",
      "realName": "required only when identity=alias: the real character/NPC name behind this alias; otherwise empty",
      "toId": "optional known member id, empty if ordinary passer",
      "content": "short private DM text to the user",
      "translation": "",
      "reason": "short reason for debugging, not shown to user"
    }
  ]
}
Output the JSON object now. The first character must be {.`; 
}
// 解析单条评论的作者身份与头像
function resolveForumCommentAuthor(space, item) {
  const id = item.identity;
  if (id === 'character' || id === 'npc') {
    const member = (space.members || []).find(m =>
      getForumDisplayName(space, m.id, m.name) === item.speaker || m.name === item.speaker);
    if (member) {
      return { user: item.speaker, avatar: member.avatar || DEFAULT_AVATAR_SRC, realCharId: member.id };
    }
  }
  if (id === 'alias' && item.realName) {
    const member = (space.members || []).find(m =>
      getForumDisplayName(space, m.id, m.name) === item.realName || m.name === item.realName);
    if (member && member.type !== 'character') {
      return {
        user: getForumDisplayName(space, member.id, member.name),
        avatar: getForumAvatar(space, member.id),
        realCharId: member.id
      };
    }
    const fixedAlias = member ? getForumCharacterFixedAlias(space, member.id) : null;
    if (fixedAlias) {
      return {
        user: fixedAlias.name || item.speaker,
        avatar: fixedAlias.avatar || space.forumProfiles?.[member.id]?.aliasAvatar || member.avatar || DEFAULT_AVATAR_SRC,
        realCharId: member.id
      };
    }
    const safeSpeaker = getSafeOrdinaryForumName(space, item.speaker);
    const aliasAvatar = member ? space.forumProfiles?.[member.id]?.aliasAvatar : '';
    return { user: safeSpeaker, avatar: aliasAvatar || getForumOrdinaryNpcAvatar(safeSpeaker, [
      item.identity,
      item.content,
      item.translation,
      item.mention,
      item.replyTo
    ].filter(Boolean).join(' ')), realCharId: member?.id || null };
  }
  const protectedAuthor = resolveForumProtectedCommentAuthorBySpeaker(space, item.speaker);
  if (protectedAuthor) return protectedAuthor;
  const safeSpeaker = getSafeOrdinaryForumName(space, item.speaker);
  return { user: safeSpeaker, avatar: getForumOrdinaryNpcAvatar(safeSpeaker, [
    item.identity,
    item.content,
    item.translation,
    item.mention,
    item.replyTo
  ].filter(Boolean).join(' ')), realCharId: null };
}
// 论坛评论生成主流程
async function generateForumComments(space, post, mode = 'reply', replyContext = null, allowMentionFollowup = true) {
  if (!space || !post) return;
  post = (space.posts || []).find(item => String(item?.id) === String(post?.id)) || post;
  if (forumGeneratingPosts.has(post.id)) return;
  forumGeneratingPosts.add(post.id);
  
  const controller = new AbortController();
  forumAbortControllers.set(post.id, controller);
  // 【UI 强隔离】只有用户正盯着这个帖子看时，才去改变底部的发送按钮
  if (currentDetailPost?.id === post.id) {
    const sendBtn = document.getElementById('detail-comment-send');
    if (sendBtn) {
      sendBtn.dataset.isGenerating = 'true';
      sendBtn.disabled = false;
      sendBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width: 20px; height: 20px; display: block; margin: auto;">
          <circle cx="12" cy="12" r="10"></circle>
          <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"></rect>
        </svg>`;
    }
  }
  if (allowMentionFollowup) {
    // 【核心修复】备份写进该帖子专属字典
    forumCommentBackups[post.id] = createForumCommentRollbackSnapshot(post, mode, replyContext);
    await saveState();
  }
  let needMentionFollowup = false;
  const listEl = document.querySelector('#forum-post-detail-content .detail-comments-list');
  let loadingEl = null;
  if (listEl) {
    loadingEl = document.createElement('div');
    loadingEl.className = 'detail-comment-loading';
    loadingEl.innerHTML = `
      <span class="detail-comment-loading-spinner"></span>
      <span>网友正在赶来评论...</span>
    `;
    listEl.appendChild(loadingEl);
  }

  try {
    const candidates = getForumCommentCandidates(space, post);
    const charMemory = {};
    for (const m of candidates.characters) {
      try {
        charMemory[m.id] = await getMemoriesForPrompt(m.sourceId || m.id);
      } catch (e) { charMemory[m.id] = '无'; }
    }
    AppState.stickerGroups = await db.stickerGroups.toArray();
    const prompt = await buildForumCommentPrompt(space, post, mode, candidates, charMemory, replyContext);
  const raw = await sendForumCommentPromptToAI(prompt, post.media, controller.signal);
    const parsedResult = parseAiJsonObject(raw);
    const items = parsedResult.comments || [];
    const effectiveHiddenLinkMemberIds = getEffectiveForumHiddenLinkMemberIds(space, post);
    if (effectiveHiddenLinkMemberIds.length > 0 && Array.isArray(parsedResult.peeks) && parsedResult.peeks.length) {
      post.hiddenLinkState = post.hiddenLinkState || {};
      const floorTextMap = {};
      (post.comments || []).forEach((c, i) => { floorTextMap[i + 1] = c.text || c.content || ''; });
      parsedResult.peeks.forEach(pk => {
        if (!pk || !pk.speaker) return;
        const member = (space.members || []).filter(mm => !isForumTemporaryOrdinaryMember(mm)).find(mm =>
          getForumDisplayName(space, mm.id, mm.name) === pk.speaker || mm.name === pk.speaker);
        if (!member) return;
        if (!effectiveHiddenLinkMemberIds.includes(String(member.id))) return;
        if ((post.blockedIds || []).includes(member.id)) return;
        const st = post.hiddenLinkState[member.id] || (post.hiddenLinkState[member.id] = { discovered: true, speakChance: 0, peeks: [] });
        st.peeks = Array.isArray(st.peeks) ? st.peeks : [];
             const parsedFloor = parseInt(String(pk.readFloor || '').replace(/\D/g, ''), 10);
        let readText = String(pk.readText || '').trim();
        if (!readText) readText = (!isNaN(parsedFloor) && floorTextMap[parsedFloor]) ? floorTextMap[parsedFloor] : '';
        // 兜底：AI 没对上楼层（比如帖子刚打开、还没有评论）时，用帖子正文当引用来源，保证心声一定有出处
        if (!readText) readText = String(post.content || '').trim();
        st.peeks.push({ readText: String(readText).slice(0, 60), thought: String(pk.thought || '').trim(), translation: normalizeForumStandardMandarinTranslation(pk.thought, pk.translation), time: Date.now() });
        st.peeks = st.peeks.slice(-10);
      });
    }
    if (items.length) {
      post.comments = post.comments || [];
      // 新增：处理 @ 提及，被@到的核心角色/NPC会被拉进候选，在下一波现身
      const mentionedMemberIds = new Set();
      const candidateIds = new Set([...candidates.characters, ...candidates.npcs].map(m => m.id));
      const mentionUserId = `user_${currentIdentity()?.id}`;
      const mentionUserName = getForumDisplayName(space, mentionUserId, currentIdentity()?.name || '我');
      // 楼层号 -> 评论对象 / 显示名 -> 评论对象，两套映射用来判断回复的是谁
      const floorMap = {};
      const nameMap = {};
      post.comments.forEach((c, i) => {
        floorMap[i + 1] = c;
        if (c.user) nameMap[c.user] = c;
        // 修复：把二级回复者的名字也映射到它所在的顶层评论，这样 AI 接二级回复里的话时能挂回原楼中楼，而不是掉成单独一楼
        (c.replies || []).forEach(r => { if (r.user) nameMap[r.user] = c; });
      });
      let floorCursor = post.comments.length;
      const fallbackReplyFloor = replyContext && Number.isInteger(replyContext.commentIndex) ? replyContext.commentIndex + 1 : null;
      let batchStickerCount = 0;
      let previousKeptSticker = false;
      const usedStickerKeywords = new Set();
      const appearedRealCharIds = new Set();
      let addedCommentCount = 0;
      items.forEach((item, itemIndex) => {
        if (!item) return;
        const stickerKeyword = String(item.sticker || '').trim();
        if (!item.content && !stickerKeyword) return;
        // 丢弃 AI 冒充用户本人发的评论：speaker 和当前用户重名就直接跳过
        if (String(item.speaker || '').trim() === mentionUserName) return;
        const author = resolveForumCommentAuthor(space, item);
        // AI 即使越过提示词输出了被角色拉黑方的主号/小号，也不能写入论坛评论。
        if (author?.realCharId && isForumCharacterBlockedByAi(space, author.realCharId)) return;
        let rawContent = String(item.content || '').trim();
        const allowedStickers = getForumStickerOptionsForCommentItem(space, item, author);
        let matchedSticker = findAuthorizedForumSticker(stickerKeyword, allowedStickers);
        if (stickerKeyword && !matchedSticker) {
          console.warn('[Forum sticker] AI sticker dropped: unauthorized keyword', stickerKeyword, item.speaker);
        }
        if (matchedSticker && isBareForumStickerText(rawContent)) {
          console.warn('[Forum sticker] AI bare sticker dropped:', stickerKeyword, item.speaker);
          matchedSticker = null;
          rawContent = '绷不住了';
        } else if (isBareForumStickerText(rawContent)) {
          rawContent = '绷不住了';
        }
        if (matchedSticker && batchStickerCount >= 2) {
          console.warn('[Forum sticker] AI sticker dropped: batch limit reached', stickerKeyword);
          matchedSticker = null;
        }
        if (matchedSticker && previousKeptSticker) {
          console.warn('[Forum sticker] AI sticker dropped: consecutive stickers are not allowed', stickerKeyword);
          matchedSticker = null;
        }
        const stickerKey = matchedSticker ? matchedSticker.explanation.toLowerCase() : '';
        if (matchedSticker && usedStickerKeywords.has(stickerKey)) {
          console.warn('[Forum sticker] AI sticker dropped: repeated keyword', stickerKeyword);
          matchedSticker = null;
        }
        if (matchedSticker) {
          batchStickerCount += 1;
          usedStickerKeywords.add(stickerKey);
          previousKeptSticker = true;
        } else {
          previousKeptSticker = false;
        }
        const likeCount = Math.max(0, Math.min(Number(item.likes) || 0, 999));
        // 新增：解析 @ 提及，拼到正文前面，并记录被@到的新角色/NPC
        let mentionPrefix = '';
        const mentionName = (item.mention || '').trim();
        if (mentionName && mentionName !== '无') {
          if (mentionName === mentionUserName || mentionName === '用户') {
            mentionPrefix = `@${mentionUserName} `;
          } else {
            const mentionMember = (space.members || []).filter(mm => !isForumTemporaryOrdinaryMember(mm)).find(mm =>
              getForumDisplayName(space, mm.id, mm.name) === mentionName || mm.name === mentionName);
            if (mentionMember) {
              mentionPrefix = `@${getForumDisplayName(space, mentionMember.id, mentionMember.name)} `;
              if (!candidateIds.has(mentionMember.id)) mentionedMemberIds.add(mentionMember.id);
            } else {
              mentionPrefix = `@${mentionName} `;
            }
          }
        }
        // 修复：正文里如果已经自带 @，就不再重复加前缀，避免 @ 出现两次
        if (rawContent.includes('@')) mentionPrefix = '';
        const newComment = {
          user: author.user,
          avatar: author.avatar,
          authorId: author.user === post.authorName ? post.authorId : author.realCharId || null,
          realCharId: author.realCharId,
          text: mentionPrefix + rawContent,
          translation: normalizeForumStandardMandarinTranslation(rawContent, item.translation),
          ...(matchedSticker ? { sticker: { url: matchedSticker.url, explanation: matchedSticker.explanation || stickerKeyword } } : {}),
          likes: Array.from({ length: likeCount }, (_, i) => `_v_${i}`),
          replies: [],
          createdAt: Date.now()
        };
        if (author.realCharId) appearedRealCharIds.add(author.realCharId);
        // 修复：强制把 AI 输出的 quoteFloor 提纯成纯数字，防止它输出 "Floor 2" 导致变 NaN 从而漏在外面单开一行
        const parsedQuote = parseInt(String(item.quoteFloor || '').replace(/\D/g, ''), 10);
        const quote = isNaN(parsedQuote) ? null : parsedQuote;

        // 先按楼层号找，找不到再按 replyTo 的名字找，两条路都通就更不容易漏进二级区
        let target = quote && floorMap[quote] ? floorMap[quote] : null;
        if (!target && item.replyTo) {
          // 【终极错位修复】：彻底剥离 AI 可能画蛇添足加上的 @ 符号或多余冒号，并增加模糊匹配兜底
          const rt = String(item.replyTo).replace(/^[@＠\s]+/, '').replace(/[:：\s]+$/, '').trim();
          if (rt) {
            if (nameMap[rt]) {
              target = nameMap[rt]; // 精确匹配成功
            } else {
              // 模糊匹配兜底：防止 AI 把名字简写了，比如把"匿名网友"写成"匿名"
              const fuzzyKey = Object.keys(nameMap).find(k => k.includes(rt) || rt.includes(k));
              if (fuzzyKey) target = nameMap[fuzzyKey];
            }
          }
        }
        if (!target && fallbackReplyFloor && itemIndex < 3) {
          target = floorMap[fallbackReplyFloor] || null;
        }
        if (target) {
          target.replies = Array.isArray(target.replies) ? target.replies : [];
          const replyToName = String(item.replyTo || '').replace(/^[@＠\s]+/, '').replace(/[:：\s]+$/, '').trim();
          const threadUserNames = new Set([target.user, ...(target.replies || []).map(r => r.user)].filter(Boolean));
          if (replyToName && replyToName !== target.user && threadUserNames.has(replyToName)) {
            newComment.replyToUser = replyToName;
          }
          target.replies.push(newComment);
          addedCommentCount += 1;
        } else {
          post.comments.push(newComment);
          floorCursor += 1;
          floorMap[floorCursor] = newComment;
          if (newComment.user) nameMap[newComment.user] = newComment;
          addedCommentCount += 1;
        }
      });
      // 修复：只有"发言率满格"的隐藏角色本轮真的发了言，才清空它的发言率；没发言就保留，下一轮继续冲
      (candidates.speakingHiddenIds || []).forEach(id => {
        if (appearedRealCharIds.has(id) && post.hiddenLinkState?.[id]) {
          post.hiddenLinkState[id].speakChance = 0;
        }
      });
      if (mentionedMemberIds.size > 0) needMentionFollowup = true;
      if (addedCommentCount > 0) bumpForumPostDiscussionHeat(post, addedCommentCount);
      const dmHintCount = appendForumDmHints(space, parsedResult.dmHints, post, {
        randomGate: true,
        chance: getForumDmHintChance(space) / 100,
        source: 'comment_dm_hint'
      });

      advanceForumActiveEvent(space);
      await saveState();
      if (dmHintCount > 0 && activeView === 'messages') renderMessages(space, { preserveDmScroll: true });
    }
    } catch (e) {
    if (e.name === 'AbortError') {
      console.log(`[论坛引擎] 帖子 ${post.id} 的AI生成已被主动切断`); 
      if(window.showDynamicIsland && currentDetailPost?.id === post.id) window.showDynamicIsland('已打断生成');
    } else {
      console.error('Forum comments generate failed:', e);
      if(window.showDynamicIsland && currentDetailPost?.id === post.id) window.showDynamicIsland('评论生成失败');
    }
  } finally {
    forumGeneratingPosts.delete(post.id);
    forumAbortControllers.delete(post.id);
    
    // 【UI 强隔离】只有用户还在看这个生成的帖子时，才去恢复底部的按钮和重绘画布
    if (currentDetailPost?.id === post.id) {
      const sendBtn = document.getElementById('detail-comment-send');
      if (sendBtn) {
        sendBtn.dataset.isGenerating = 'false';
        sendBtn.innerHTML = '发送';
        updateDetailSendButtonState();
      }
      renderPostDetailContent({ preserveScroll: true });
      if (document.getElementById('page-forum-post-detail')?.dataset.commentsActive === 'true') {
        scrollDetailCommentsToLatest();
      }
    }
    if (loadingEl && document.body.contains(loadingEl)) loadingEl.remove();
    // 只有用户不在详情页（真的在看 feed）时才重绘后台列表，避免详情页生成评论时白白全量重绘 feed
    const detailPageForRefresh = document.getElementById('page-forum-post-detail');
    const isDetailVisibleForRefresh = detailPageForRefresh && getComputedStyle(detailPageForRefresh).display !== 'none';
    if (!isDetailVisibleForRefresh) renderApp();
    maybeQueueForumThreadSummary(space, post);
    // 新增：有主要角色/NPC被@到时，自动再生成一波让他们现身（只追加一次，防止无限循环）
    if (needMentionFollowup && allowMentionFollowup) {
      generateForumComments(getCurrentSpace(), post, 'reply', { forumDirection: replyContext?.forumDirection || null }, false);
    }
  }
}
// ▲▲▲ 新增结束 ▲▲▲
// ▼▼▼ 新增：帖子详情页渲染与交互 ▼▼▼
let currentDetailPost = null;
let currentDetailReplyTarget = null;
let currentDetailReturnView = 'feed';
let currentDetailReturnProfileId = null;
let pendingUserComments = [];
let selectedDetailSticker = null;
let detailCommentManageMode = null;
let selectedDetailCommentTargets = new Set();
const DETAIL_COMMENT_BATCH_SIZE = 12;
const DETAIL_REPLY_BATCH_SIZE = 4;
let detailVisibleCommentCount = DETAIL_COMMENT_BATCH_SIZE;
let detailVisibleReplyCounts = new Map();

function resetDetailReplyTarget() {
  currentDetailReplyTarget = null;
  const inputEl = document.getElementById('detail-comment-input');
  if (inputEl) inputEl.placeholder = '添加评论...';
  const targetBar = document.getElementById('detail-reply-target');
  if (targetBar) targetBar.hidden = true;
  document.querySelector('#page-forum-post-detail .forum-detail-comment-bar')?.classList.remove('is-replying');
}

function setDetailReplyTarget(commentIndex, commentUser, replyIndex = null) {
  const comment = currentDetailPost?.comments?.[commentIndex];
  const reply = Number.isInteger(replyIndex) ? comment?.replies?.[replyIndex] : null;
  const target = reply || comment || null;
  currentDetailReplyTarget = {
    commentIndex,
    replyIndex,
    user: commentUser,
    realCharId: target?.realCharId || target?.authorId || null,
    text: target?.text || target?.content || ''
  };
  const inputEl = document.getElementById('detail-comment-input');
  if (!inputEl) return;
  inputEl.placeholder = `回复 ${commentUser}...`;
  const targetBar = document.getElementById('detail-reply-target');
  if (targetBar) {
    targetBar.hidden = false;
    document.querySelector('#page-forum-post-detail .forum-detail-comment-bar')?.classList.add('is-replying');
  }
  inputEl.focus();
}

function resetDetailCommentViewport() {
  detailVisibleCommentCount = DETAIL_COMMENT_BATCH_SIZE;
  detailVisibleReplyCounts = new Map();
}

function getDetailCommentWindow(post) {
  const comments = Array.isArray(post?.comments) ? post.comments : [];
  const visibleCount = Math.min(comments.length, Math.max(DETAIL_COMMENT_BATCH_SIZE, detailVisibleCommentCount));
  const startIndex = Math.max(0, comments.length - visibleCount);
  return {
    hiddenCount: startIndex,
    items: comments.slice(startIndex).map((comment, offset) => ({ comment, index: startIndex + offset }))
  };
}

function scrollDetailCommentsToLatest({ focusInput = false } = {}) {
  requestAnimationFrame(() => {
    const contentEl = document.getElementById('forum-post-detail-content');
    const detailPage = document.getElementById('page-forum-post-detail');
    const commentsPanel = contentEl?.querySelector('.post-detail-comments');
    const listEl = commentsPanel?.querySelector('.detail-comments-list');
    if (!contentEl || !commentsPanel || !listEl) return;
    if (detailPage?.classList.contains('is-short-video-detail')) {
      listEl.scrollTop = listEl.scrollHeight;
    } else {
      contentEl.scrollTo({ top: contentEl.scrollHeight, behavior: 'auto' });
    }
    if (focusInput) document.getElementById('detail-comment-input')?.focus();
  });
}

function openDetailComments({ focusInput = false } = {}) {
  const detailPage = document.getElementById('page-forum-post-detail');
  if (detailPage) {
    detailPage.dataset.commentsActive = 'true';
    detailPage.classList.add('is-comments-open');
  }
  scrollDetailCommentsToLatest({ focusInput });
}

function openPostDetailPage(post, options = {}) {
  clearPendingUserComments();
  currentDetailPost = post;
  currentDetailReturnView = options.returnView === 'profile' ? 'profile' : 'feed';
  currentDetailReturnProfileId = options.returnProfileId || null;
  resetDetailCommentViewport();
  resetDetailReplyTarget();
  resetDetailCommentManageMode();
  const space = getCurrentSpace();
  
  // 私密作品（角色/NPC发的）只给用户看，隐藏评论栏，禁止互动
  const forumIdentity = currentIdentity();
  const userOwnedForumIds = new Set([`user_${forumIdentity?.id}`, ...(space?.aliases || []).map(alias => String(alias.id))]);
  const isViewOnlyPrivatePost = normalizeForumPostVisibility(post.visibility) === 'private' && !userOwnedForumIds.has(String(post.authorId || ''));
  const detailCommentBar = document.querySelector('#page-forum-post-detail .forum-detail-comment-bar');
  const detailCommentToolbar = document.querySelector('#page-forum-post-detail .fd-toolbar-shell');
  if (detailCommentBar) detailCommentBar.style.display = isViewOnlyPrivatePost ? 'none' : '';
  if (detailCommentToolbar) detailCommentToolbar.style.display = isViewOnlyPrivatePost ? 'none' : '';
  // 更新底部的头像为当前用户的头像
  updateDetailCommentAvatar();
  
  // 初始化输入框状态
  const inputEl = document.getElementById('detail-comment-input');
  const sendBtn = document.getElementById('detail-comment-send');
  if (inputEl && sendBtn) {
    inputEl.value = '';
    inputEl.oninput = updateDetailSendButtonState;
    
    // 【核心修复】重新进入页面时，如果还在生成中，恢复按钮的停止图标状态
    if (forumGeneratingPosts.has(post.id)) {
      sendBtn.dataset.isGenerating = 'true';
      sendBtn.disabled = false;
      sendBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width: 20px; height: 20px; display: block; margin: auto;"><circle cx="12" cy="12" r="10"></circle><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"></rect></svg>`;
    } else {
      sendBtn.dataset.isGenerating = 'false';
      sendBtn.disabled = true;
      sendBtn.innerHTML = '发送';
      updateDetailSendButtonState();
    }
  }
  const detailPageEl = document.getElementById('page-forum-post-detail');
  detailPageEl?.classList.remove('is-comments-open');
  if (detailPageEl) delete detailPageEl.dataset.commentsActive;
   renderPostDetailContent();
  showPage('page-forum-post-detail');
  renderPendingUserComments();
  updateForumDirectionButtonState();
  showForumReplyGuideBubble();
  bindForumPresenceRadar();
  refreshForumPresenceRadar();
  startForumPeekTimer();
  if (options.focusComments) openDetailComments({ focusInput: false });
  autoPlayForumPostMusic(post);
  // 新增：首次打开自动生成打底评论
  if (!post.aiCommentsInitDone) {
    post.aiCommentsInitDone = true;
    generateForumComments(getCurrentSpace(), post, 'init');
  }
  maybeQueueForumThreadSummary(space, post);
}
// 新增：把评论里的 @某某 渲染成蓝色高亮
function formatForumCommentText(text) {
  const safe = escapeHTML(String(text || ''));
  return safe
    .replace(/@([^\s@]+)/g, '<span style="color:#007aff; font-weight:500;">@$1</span>')
    .replace(/\[(\d{1,2}):(\d{2})\]/g, (match, mm, ss) => {
      const totalSec = parseInt(mm, 10) * 60 + parseInt(ss, 10);
      return `<span class="forum-comment-timenode" data-forum-timenode="${totalSec}" style="color:#007aff; font-weight:600; cursor:pointer;">${match}</span>`;
    });
}

function formatForumPostText(text) {
  return String(text || '')
    .split(/(#[^\s#]*)/g)
    .map(part => part.startsWith('#')
      ? `<span class="forum-post-hashtag">${escapeHTML(part)}</span>`
      : escapeHTML(part))
    .join('');
}

function renderForumCommentContent(comment) {
  if (comment?.sticker?.url) {
    const text = String(comment.text || '').trim();
    const textHtml = text && text !== '[表情]' ? `<div class="forum-comment-sticker-text">${formatForumCommentText(text)}</div>` : '';
    return `${textHtml}<img class="forum-comment-sticker" src="${escapeHTML(comment.sticker.url)}" alt="${escapeHTML(comment.sticker.explanation || '表情')}" title="${escapeHTML(comment.sticker.explanation || '表情')}" loading="lazy">`;
  }
  return formatForumCommentText(comment?.text);
}
function isForumPostOwnerComment(post, comment) {
  if (!post || !comment) return false;
  // 楼主标识只按「发帖账号的显示名」做精确匹配，
  // 这样大号发的帖子只有大号评论能显示楼主，小号评论不会显示。
  if (post.authorName && comment.user && String(comment.user) === String(post.authorName)) return true;
  // 兜底：显示名缺失时才按 authorId 匹配，且只比对 post.authorId
  if (!post.authorName || !comment.user) {
    const postAuthorId = String(post.authorId || '').trim();
    if (postAuthorId && comment.authorId && String(comment.authorId) === postAuthorId) return true;
  }
  return false;
}

function renderForumCommentOwnerBadge(post, comment, className = 'comment-owner-badge') {
  return isForumPostOwnerComment(post, comment) ? `<span class="${className}">楼主</span>` : '';
}

function renderForumCommentTranslation(comment) {
  const translation = String(comment?.translation || '').trim();
  if (!translation) return '';
  return `<div class="forum-comment-translation collapsed" data-comment-translation>${formatForumCommentText(translation)}</div>`;
}

function renderForumPostTranslation(post) {
  const translation = String(post?.translation || '').trim();
  if (!translation) return '';
  return `
    <div class="forum-post-translation collapsed" data-post-translation>${formatForumPostText(translation)}</div>
    <button type="button" class="post-translation-btn" data-detail-post-translation-toggle>文</button>
  `;
}

function renderDetailCommentReplies(comment, commentIndex) {
  const replies = Array.isArray(comment.replies) ? comment.replies : [];
  if (!replies.length) return '';
  const visibleCount = Math.min(replies.length, Math.max(DETAIL_REPLY_BATCH_SIZE, detailVisibleReplyCounts.get(commentIndex) || DETAIL_REPLY_BATCH_SIZE));
  const startIndex = Math.max(0, replies.length - visibleCount);
  const hiddenCount = startIndex;

  return `
    <div class="comment-replies">
      ${hiddenCount > 0 ? `<button class="detail-comments-folded is-reply-folded" type="button" data-detail-replies-show-more="${commentIndex}">已折叠上方 ${hiddenCount} 条回复，点击查看</button>` : ''}
      ${replies.slice(startIndex).map((reply, offset) => {
        const replyIndex = startIndex + offset;
        const targetKey = getDetailCommentTargetKey({ commentIndex, replyIndex });
        const isSelected = selectedDetailCommentTargets.has(targetKey);
        const replyToName = String(reply.replyToUser || '').trim();
        const showReplyTo = replyToName && replyToName !== (comment.user || '');
        return `
        <div class="comment-reply-item ${isSelected ? 'selected-for-delete' : ''} ${detailCommentManageMode ? 'is-manage-mode' : ''}" data-detail-comment-index="${commentIndex}" data-detail-reply-index="${replyIndex}">
          <img src="${escapeHTML(reply.avatar || 'images/default-avatar.svg')}" class="reply-avatar" alt="avatar" loading="lazy" decoding="async">
                <div class="reply-body">
            <div class="reply-header" style="display:flex; align-items:center; flex-wrap:nowrap; min-width:0; overflow:hidden;">
              <span class="reply-user" style="flex:0 1 auto; min-width:0; max-width:110px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHTML(reply.user || '匿名用户')}</span>
              ${renderForumCommentOwnerBadge(currentDetailPost, reply, 'reply-owner-badge')}
              ${showReplyTo ? `<span style="flex:0 0 auto; color:#999;font-size:11px;margin:0 4px;white-space:nowrap;">回复</span><span style="flex:0 1 auto; min-width:0; max-width:90px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#555; font-size:12px; font-weight:500;">${escapeHTML(replyToName)}</span>` : ''}
              <span class="reply-time" style="flex:0 0 auto; white-space:nowrap; margin-left:6px;">${new Date(reply.createdAt || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
            </div>
            <div class="reply-text">${renderForumCommentContent(reply)}</div>
            ${renderForumCommentTranslation(reply)}
            <div class="reply-actions">
              ${reply.translation ? '<button type="button" class="reply-translation-btn" data-detail-translation-toggle>文</button>' : ''}
              <button type="button" class="reply-reply-btn" data-comment-index="${commentIndex}" data-reply-user="${escapeHTML(reply.user || '匿名用户')}">回复</button>
            </div>
          </div>
        </div>
      `;
      }).join('')}
    </div>
  `;
}

let forumDetailVideoTimer = null;

function stopForumDetailVideoTimer() {
  if (forumDetailVideoTimer) {
    clearTimeout(forumDetailVideoTimer);
    forumDetailVideoTimer = null;
  }
}

let forumPeekTimer = null;

function stopForumPeekTimer() {
  if (forumPeekTimer) {
    clearTimeout(forumPeekTimer);
    forumPeekTimer = null;
  }
}
function startForumPeekTimer() {
  stopForumPeekTimer();
  const schedule = (isFirst = false) => {
    const delay = isFirst ? (5000 + Math.random() * 5000) : (15000 + Math.random() * 30000);
    forumPeekTimer = setTimeout(async () => {
      const detailPage = document.getElementById('page-forum-post-detail');
      if (!detailPage || getComputedStyle(detailPage).display === 'none') {
        stopForumPeekTimer();
        return;
      }
      try {
        await triggerForumPeekToast();
      } finally {
        schedule();
      }
    }, delay);
  };
  schedule(true);
}
async function triggerForumPeekToast() {
  const detailPage = document.getElementById('page-forum-post-detail');
  if (!detailPage || getComputedStyle(detailPage).display === 'none') return;
  if (!currentDetailPost) return;
  const post = currentDetailPost;
  const space = getCurrentSpace();
  const effectiveHiddenLinkMemberIds = getEffectiveForumHiddenLinkMemberIds(space, post);
  if (!effectiveHiddenLinkMemberIds.length) return;
  // 只弹刚生成、还没弹过的心声（用 shown 标记），并取时间最新的那一条
  let peek = null;
  let pickId = null;
  Object.keys(post.hiddenLinkState || {}).forEach(id => {
    if (!effectiveHiddenLinkMemberIds.includes(String(id))) return;
    const s = post.hiddenLinkState[id];
    if (!s?.discovered || !Array.isArray(s.peeks)) return;
    s.peeks.forEach(pk => {
      if (pk.shown) return;
      if (!peek || (pk.time || 0) > (peek.time || 0)) {
        peek = pk;
        pickId = id;
      }
    });
  });
  if (!peek || !pickId) return;
  const member = (space.members || []).find(m => m.id === pickId);
  if (!member) return;
  peek.shown = true;
  try {
    await saveState();
  } catch (error) {
    console.error('Forum peek shown save failed:', error);
  }
  const toast = document.getElementById('forum-peek-toast');
  const nameEl = document.getElementById('forum-peek-name');
  const readEl = document.getElementById('forum-peek-read');
  const thoughtEl = document.getElementById('forum-peek-thought');
  const translationEl = document.getElementById('forum-peek-translation');
  if (!toast) return;
  if (nameEl) nameEl.textContent = getForumDisplayName(space, pickId, member.name);
  if (readEl) readEl.textContent = peek.readText ? `悄悄看了：${peek.readText}` : '悄悄刷着这条帖子';
  if (thoughtEl) thoughtEl.textContent = peek.thought || '';
  if (translationEl) {
    if (peek.translation) {
      translationEl.textContent = `译：${peek.translation}`;
      translationEl.style.display = 'block';
    } else {
      translationEl.style.display = 'none';
    }
  }
  toast.style.display = 'block';
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-12px)';
    setTimeout(() => { toast.style.display = 'none'; }, 300);
  }, 8000);
}

function renderForumDetailShortVideo(media, post, isLiked = false, musicMedia = null) {
  const slides = Array.isArray(media?.slides) && media.slides.length ? media.slides : [''];
  const durations = getForumSlideDurations(media);
  const totalSeconds = durations.reduce((total, seconds) => total + seconds, 0);
  const maxProgress = Math.max(totalSeconds * 100 - 1, 0);
  const captionText = String(post.content || '');
  const isSaved = isForumPostSaved(post);
  const verifiedBadgeHtml = renderForumVerifiedBadge(getCurrentSpace(), post.authorId);
  const likeCount = getForumPostLikeDisplayCount(post);
  const commentCount = getForumPostCommentDisplayCount(post);
  return `
    <section class="forum-detail-short-video" data-detail-short-video data-slide-count="${slides.length}" data-slide-durations="${escapeHTML(JSON.stringify(durations))}" style="--detail-progress:0%; --slide-count:${slides.length};">
      <div class="forum-detail-short-video-screen">
        <div class="forum-detail-video-bars">
          ${slides.map((slide, index) => `<i data-detail-video-bar="${index}"><b></b></i>`).join('')}
        </div>
        <div class="forum-detail-video-pages">
          ${slides.map((slide, index) => `
            <div class="forum-detail-video-page ${index === 0 ? 'active' : ''}" data-detail-video-page="${index}">
              <span>${escapeHTML(slide.replace(/^\s*第[一二三四五六七八九十\d]+页[：:\s]*/, ''))}</span>
            </div>
          `).join('')}
        </div>
        <div class="forum-detail-video-rail">
          <button class="${isLiked ? 'liked' : ''}" data-detail-video-like type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20.3 5.7a5.1 5.1 0 0 0-7.2 0L12 6.8l-1.1-1.1a5.1 5.1 0 0 0-7.2 7.2L12 21l8.3-8.1a5.1 5.1 0 0 0 0-7.2z"></path></svg>
            <span>${likeCount > 0 ? formatForumEngagementCount(likeCount) : '赞'}</span>
          </button>
          <button data-detail-comments-toggle type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 8.5-8.5h.5a8.5 8.5 0 0 1 8 8v.5z"></path></svg>
            <span>${commentCount > 0 ? formatForumEngagementCount(commentCount) : '评论'}</span>
          </button>
          <button type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
            <span>分享</span>
          </button>
          <button class="${isSaved ? 'saved' : ''}" data-detail-video-save type="button">
            <svg viewBox="0 0 24 24" fill="${isSaved ? 'currentColor' : 'none'}" stroke="currentColor"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
            <span>收藏</span>
          </button>
          ${musicMedia ? renderForumDetailMusicDisc(musicMedia) : ''}
        </div>
        <div class="forum-detail-video-caption">
          <b>${escapeHTML(post.authorName || '')}${verifiedBadgeHtml}</b>
          ${captionText ? `<p class="collapsed" data-detail-caption-text>${formatForumPostText(captionText)}</p>` : ''}
          ${renderForumPostTranslation(post)}
          ${captionText ? '<button class="forum-detail-caption-toggle" data-detail-caption-toggle type="button" aria-expanded="false" hidden>展开</button>' : ''}
        </div>
        <div class="forum-detail-video-scrubber">
          <input data-detail-video-range type="range" min="0" max="${maxProgress}" value="0" step="1" aria-label="video progress">
        </div>
        <button class="forum-detail-video-comment-pill" data-detail-comments-toggle type="button">添加评论...</button>
      </div>
    </section>
  `;
}

function bindForumDetailShortVideo(root) {
  stopForumDetailVideoTimer();
  const player = root.querySelector('[data-detail-short-video]');
  if (!player) return;
  const pages = Array.from(player.querySelectorAll('[data-detail-video-page]'));
  const bars = Array.from(player.querySelectorAll('[data-detail-video-bar]'));
  const range = player.querySelector('[data-detail-video-range]');
  const indexText = player.querySelector('[data-detail-video-index]');
  const count = Math.max(Number(player.dataset.slideCount) || pages.length || 1, 1);
  let durations = [];
  try {
    durations = JSON.parse(player.dataset.slideDurations || '[]');
  } catch (error) {
    durations = [];
  }
  durations = Array.from({ length: count }, (_, index) => Math.max(1, Math.round(Number(durations[index]) || 1)));
  const slideStartUnits = durations.reduce((list, seconds, index) => {
    list[index] = index === 0 ? 0 : list[index - 1] + durations[index - 1] * 100;
    return list;
  }, []);
  const max = Math.max(Number(range?.max) || 0, 0);
  let isDragging = false;
  let activeIndex = -1;
  let lastValue = -1;

  const setProgress = rawValue => {
    if (!range) return;
    const value = Math.max(0, Math.min(max, Number(rawValue) || 0));
    if (value === lastValue) return;
    lastValue = value;
    player.style.setProperty('--detail-progress', `${max > 0 ? (value / max) * 100 : 0}%`);
    const index = Math.max(0, Math.min(count - 1, slideStartUnits.findIndex((startUnit, slideIndex) => {
      const nextStart = slideStartUnits[slideIndex + 1] ?? Infinity;
      return value >= startUnit && value < nextStart;
    })));
    const slideDurationUnits = Math.max(100, durations[index] * 100);
    const inPageProgress = Math.min(100, ((value - slideStartUnits[index]) / slideDurationUnits) * 100);
    range.value = String(value);
    if (index !== activeIndex) {
      activeIndex = index;
      pages.forEach((page, pageIndex) => page.classList.toggle('active', pageIndex === index));
      bars.forEach((bar, barIndex) => {
        bar.classList.toggle('done', barIndex < index);
        bar.classList.toggle('active', barIndex === index);
        bar.style.setProperty('--bar-progress', `${barIndex < index ? 100 : 0}%`);
      });
    }
    bars[index]?.style.setProperty('--bar-progress', `${inPageProgress}%`);
    if (indexText) indexText.textContent = `${index + 1}/${count}`;
  };

  range?.addEventListener('input', () => setProgress(range.value));
  range?.addEventListener('pointerdown', () => { isDragging = true; });
  range?.addEventListener('pointerup', () => { isDragging = false; });
  range?.addEventListener('change', () => { isDragging = false; });
  setProgress(0);
  const tick = () => {
    if (!range || !document.body.contains(player)) {
      stopForumDetailVideoTimer();
      return;
    }
    if (document.getElementById('page-forum-post-detail')?.style.display === 'none') {
      stopForumDetailVideoTimer();
      return;
    }
    if (document.hidden || isDragging) {
      forumDetailVideoTimer = setTimeout(tick, 240);
      return;
    }
    const next = Number(range.value) >= max ? 0 : Number(range.value) + 4;
    setProgress(next);
    forumDetailVideoTimer = setTimeout(tick, 140);
  };
  forumDetailVideoTimer = setTimeout(tick, 140);
}

function renderPostDetailContent(options = {}) {
  const contentEl = document.getElementById('forum-post-detail-content');
  const detailPage = document.getElementById('page-forum-post-detail');
  if (!contentEl || !currentDetailPost) return;
  const previousScrollTop = contentEl.scrollTop;
  const previousCommentsListScrollTop = contentEl.querySelector('.detail-comments-list')?.scrollTop || 0;
  const scrollAnchor = options.scrollAnchor || null;
  const shouldRestoreScroll = Boolean(options.preserveScroll);
  
  const post = currentDetailPost;
  const space = getCurrentSpace();
  const userKey = getCurrentForumUserKey(space);
  const isLiked = post.likes.includes(userKey);
  const isSaved = isForumPostSaved(post, space, userKey);
  const likeCount = getForumPostLikeDisplayCount(post);
  const commentCount = getForumPostCommentDisplayCount(post);
  const forwardCount = Number(post.forwards || 0);
  const detailVerifiedBadgeHtml = renderForumVerifiedBadge(space, post.authorId);
  // 1. 媒体渲染兼容逻辑 (兼容图文与视频)
  const detailShortVideo = Array.isArray(post.media) ? post.media.find(media => media.type === 'slides-video') : null;
  detailPage?.classList.toggle('is-short-video-detail', Boolean(detailShortVideo));
  if (!detailShortVideo) detailPage?.classList.remove('is-comments-open');
  
  // 新增：提取并渲染被提及的角色
  let mentionHtml = '';
  if (post.mentions && post.mentions.length > 0) {
    const mentionNames = post.mentions.map(id => {
      const name = findForumPersonName(space, id);
      return name ? `@${escapeHTML(name)}` : '';
    }).filter(Boolean);
    if (mentionNames.length > 0) mentionHtml = `<div style="color: #007aff; font-size: 14px; margin-top: 4px;">${mentionNames.join(' ')}</div>`;
  }
  
  // 修改：将 mentionHtml 拼接到文本后面
  const detailTextHtml = (post.content && !detailShortVideo ? `<div class="post-text">${formatForumPostText(post.content)}</div>${renderForumPostTranslation(post)}` : '') + mentionHtml;
  let mediaHtml = '';
  // 如果未来数据里有 post.media (数组)，这里直接支持横向轮播与视频播放
  if (Array.isArray(post.media) && post.media.length > 0) {
    const shortVideo = detailShortVideo;
    const musicMedia = post.media.find(media => media.type === 'music');
    const otherMedia = post.media.filter(media => media.type !== 'slides-video' && media.type !== 'music');
    const hasMusicBadgeTarget = Boolean(shortVideo) || otherMedia.some(media => media.type === 'real-image' || media.type === 'sticker' || media.type === 'video');
    const mediaLayout = getForumVisualMediaLayout(otherMedia);
    // ▼▼▼ 新增详情页页码小胶囊逻辑 ▼▼▼
   let detailPageCapsule = '';
    let detailOnScrollAttr = '';
    if (otherMedia.length > 1 && otherMedia.every(m => m.type === 'real-image' || m.type === 'sticker')) {
      detailPageCapsule = `<div class="media-page-capsule">1/${otherMedia.length}</div>`;
      detailOnScrollAttr = `onscroll="let cap=this.nextElementSibling; if(cap && cap.classList.contains('media-page-capsule')) cap.innerText = (Math.round(this.scrollLeft / this.clientWidth) + 1) + '/${otherMedia.length}'"`;
    }
    mediaHtml = [
      shortVideo ? renderForumDetailShortVideo(shortVideo, post, isLiked, musicMedia) : '',
      otherMedia.length ? `
        <div style="position: relative;">
          <div class="post-detail-media-slider forum-post-media-grid ${mediaLayout} ${otherMedia.length > 1 ? 'multi' : 'single'}" ${detailOnScrollAttr}>
            ${otherMedia.map(media => `<div class="media-slide">${renderForumMediaItem(media)}</div>`).join('')}
            ${musicMedia && !shortVideo && hasMusicBadgeTarget ? renderForumMusicTrigger(musicMedia, 'is-detail-media') : ''}
          </div>
          ${detailPageCapsule}
        </div>
      ` : '',
      musicMedia && !hasMusicBadgeTarget ? renderForumMusicCard(musicMedia) : ''
    ].join('');
  }

  // 2. 评论列表渲染
  const commentWindow = getDetailCommentWindow(post);
let commentsHtml = post.comments.length ? `${commentWindow.hiddenCount > 0 ? `<button class="detail-comments-folded" type="button" data-detail-comments-show-more>已折叠前面 ${commentWindow.hiddenCount} 条评论，点击查看更早内容</button>` : ''}${commentWindow.items.map(({ comment: c, index }) => {
    const commentLikes = Array.isArray(c.likes) ? c.likes : [];
    const isCommentLiked = commentLikes.includes(userKey);
    const isCommentManageMode = Boolean(detailCommentManageMode);
    const isCommentDeleteMode = detailCommentManageMode === 'delete';
    const isCommentSelected = selectedDetailCommentTargets.has(getDetailCommentTargetKey({ commentIndex: index }));
    return `
    <div class="detail-comment-item ${isCommentSelected ? 'selected-for-delete' : ''} ${detailCommentManageMode ? 'is-manage-mode' : ''}" data-detail-comment-index="${index}">
      <img src="${c.avatar || 'images/default-avatar.svg'}" class="comment-avatar" alt="avatar" loading="lazy" decoding="async">
      <div class="comment-body">
        <div class="comment-header">
          <span class="comment-user">${escapeHTML(c.user)}</span>
          ${renderForumCommentOwnerBadge(post, c)}
          <span class="comment-time">${new Date(c.createdAt || Date.now()).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div class="comment-text">${renderForumCommentContent(c)}</div>
        ${renderForumCommentTranslation(c)}
        <div class="comment-actions" style="${isCommentManageMode ? 'display: none;' : ''}">
          ${c.translation ? '<button type="button" class="comment-translation-btn" data-detail-translation-toggle>文</button>' : ''}
          <button type="button" class="comment-reply-btn" data-comment-index="${index}">回复</button>
        </div>
        ${renderDetailCommentReplies(c, index)}
      </div>
      <div class="comment-like-group" style="${isCommentManageMode ? 'display: none;' : ''}">
        <button class="comment-like-btn ${isCommentLiked ? 'liked' : ''}" type="button" title="喜欢" data-comment-index="${index}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.3 5.7a5.1 5.1 0 0 0-7.2 0L12 6.8l-1.1-1.1a5.1 5.1 0 0 0-7.2 7.2L12 21l8.3-8.1a5.1 5.1 0 0 0 0-7.2z"></path></svg>
        </button>
        <span class="comment-like-count">${commentLikes.length}</span>
      </div>
    </div>
  `;
  }).join('')}` : `<div class="detail-comment-empty">还没人评论，抢个沙发吧~</div>`;
  // 【核心修复】重绘页面时，如果还在生成中，恢复底部的加载动画占位
  if (forumGeneratingPosts.has(post.id)) {
    if (post.comments.length === 0) commentsHtml = ''; // 去除抢沙发提示
    commentsHtml += `<div class="detail-comment-loading"><span class="detail-comment-loading-spinner"></span><span>网友正在赶来评论...</span></div>`;
  }
   // 3. 总体拼接写入
  contentEl.innerHTML = `
    <!-- 发帖人信息 (Twitter风格：融合返回键) -->
    <div class="post-detail-header">
      <div class="header-left-group">
        <button class="detail-soft-icon-btn back-button" id="detail-back-btn" data-target="${currentDetailReturnView === 'profile' ? 'page-forum-user-profile' : 'page-forum'}" title="返回">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M15 18L9 12L15 6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="header-right-group" style="display: flex; gap: 12px; align-items: center;">
        <button id="detail-regenerate-btn" class="detail-soft-icon-btn" title="重新生成">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.7 7.2h3.1V4.1"></path><path d="M20 7.2A8 8 0 1 0 21 12"></path></svg>
        </button>
        <button id="detail-memory-settings-btn" class="detail-soft-icon-btn" title="记忆设置">
          <svg viewBox="0 0 24 24" fill="none"><ellipse cx="12" cy="5" rx="9" ry="3" stroke="currentColor" stroke-width="2"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <button class="detail-soft-icon-btn more-btn" type="button" title="更多">
          <svg viewBox="0 0 24 24" fill="currentColor" style="width: 22px; height: 22px;"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
        </button>
      </div>
    </div>

    <!-- 正文 (移动到多媒体区上方，并删除了赞数行) -->
    <div class="post-detail-body" style="padding: 12px 16px;">
      <div class="author-info">
        <img src="${post.avatar || 'images/default-avatar.svg'}" alt="avatar" loading="lazy" decoding="async">
        <div class="author-meta">
          <span class="author-name">${escapeHTML(post.authorName)}${detailVerifiedBadgeHtml}</span>
          ${post.circle ? `<span class="author-circle">来自 ${escapeHTML(post.circle)}</span>` : ''}
        </div>
      </div>
      ${detailTextHtml}
    </div>

    <!-- 多媒体区 (图片/视频) -->
    ${mediaHtml}

    <!-- 操作栏 (Ins 风格：点赞数和评论数直接写在图标右边) -->
    <div class="post-detail-actions" style="display: flex; justify-content: space-between; padding: 12px 16px 8px;">
      <div class="actions-left" style="display: flex; gap: 20px; align-items: center;">
        <button id="detail-like-btn" class="${isLiked ? 'liked' : ''}" style="display: flex; align-items: center; gap: 6px; background: none; border: none; padding: 0; color: #111; font-size: 14px; font-weight: 600; cursor: pointer;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width: 24px; height: 24px;"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
          <span>${likeCount > 0 ? formatForumEngagementCount(likeCount) : '赞'}</span>
        </button>
        <button id="detail-comment-count-btn" style="display: flex; align-items: center; gap: 6px; background: none; border: none; padding: 0; color: #111; font-size: 14px; font-weight: 600; cursor: pointer;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width: 24px; height: 24px;"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
          <span>${commentCount > 0 ? formatForumEngagementCount(commentCount) : '评论'}</span>
        </button>
        <button id="detail-forward-btn" style="display: flex; align-items: center; gap: 6px; background: none; border: none; padding: 0; color: #111; font-size: 14px; font-weight: 600; cursor: pointer;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width: 24px; height: 24px;"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          <span>${formatForumEngagementCount(forwardCount)}</span>
        </button>
      </div>
      <button class="actions-right ${isSaved ? 'saved' : ''}" id="detail-save-btn" style="background: none; border: none; padding: 0; color: #111; cursor: pointer;">
        <svg viewBox="0 0 24 24" fill="${isSaved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" style="width: 24px; height: 24px;"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
      </button>
    </div>

    <!-- 发帖时间 -->
    <div style="padding: 0 16px 12px;">
      <div class="post-time" style="font-size: 11px; color: #999;">${new Date(post.createdAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
    </div>

    <div class="detail-divider"></div>

    <!-- 评论列表 -->
    <div class="post-detail-comments ${detailShortVideo ? 'is-short-video-comments' : ''}">
      ${detailShortVideo ? '<div class="detail-comments-sheet-header"><div class="detail-comments-sheet-handle"></div><div class="detail-comments-sheet-title">评论</div><button class="detail-comments-sheet-close" type="button" data-detail-comments-close aria-label="关闭评论">×</button></div>' : ''}
      <div class="detail-comments-list">
        ${commentsHtml}
      </div>
    </div>
  `;
    // 绑定详情页内的点赞事件
  const likeBtn = contentEl.querySelector('#detail-like-btn');
  likeBtn?.addEventListener('click', async () => {
    const space = getCurrentSpace();
    if (!space) return;
    const userKey = getCurrentForumUserKey(space);
    const wasLiked = post.likes.includes(userKey);
    post.likes = wasLiked ? post.likes.filter(item => item !== userKey) : [...post.likes, userKey];
    const currentLikeCount = getForumPostLikeDisplayCount(post);
    post.likeCount = Math.max(post.likes.length, currentLikeCount + (wasLiked ? -1 : 1));
    await saveState();
    renderApp(); // 更新后台Feed流的显示
    renderPostDetailContent({ preserveScroll: true }); // 刷新详情页局部UI
  });

  contentEl.querySelector('#detail-memory-settings-btn')?.addEventListener('click', openForumMemorySettings);

  contentEl.querySelectorAll('.comment-reply-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = Number(btn.dataset.commentIndex);
      const comment = post.comments[index];
      if (!comment) return;
      setDetailReplyTarget(index, comment.user);
    });
  });

  contentEl.querySelectorAll('.reply-reply-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = Number(btn.dataset.commentIndex);
      const replyIndex = Number(btn.closest('.comment-reply-item')?.dataset.detailReplyIndex);
      const replyUser = btn.dataset.replyUser || '匿名用户';
      const comment = post.comments[index];
      if (!comment) return;
      setDetailReplyTarget(index, replyUser, Number.isInteger(replyIndex) ? replyIndex : null);
    });
  });

  contentEl.querySelectorAll('[data-detail-translation-toggle]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      const body = btn.closest('.comment-body, .reply-body');
      const translationEl = body?.querySelector('[data-comment-translation]');
      if (!translationEl) return;
      translationEl.classList.toggle('collapsed');
      btn.classList.toggle('active');
    });
  });

  contentEl.querySelectorAll('[data-detail-post-translation-toggle]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      const translationEl = btn.closest('.post-detail-body, .forum-detail-video-caption')?.querySelector('[data-post-translation]');
      if (!translationEl) return;
      translationEl.classList.toggle('collapsed');
      btn.classList.toggle('active');
    });
  });

  const replyCancelBtn = document.getElementById('detail-reply-target-cancel');
  if (replyCancelBtn) replyCancelBtn.onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    resetDetailReplyTarget();
    updateDetailSendButtonState();
    document.getElementById('detail-comment-input')?.focus();
  };

  const showMoreCommentsBtn = contentEl.querySelector('[data-detail-comments-show-more]');
  showMoreCommentsBtn?.addEventListener('pointerdown', event => {
    event.preventDefault();
  });
  showMoreCommentsBtn?.addEventListener('click', event => {
    event.preventDefault();
    detailVisibleCommentCount += DETAIL_COMMENT_BATCH_SIZE;
    renderPostDetailContent({ preserveScroll: true });
  });

  contentEl.querySelectorAll('[data-detail-replies-show-more]').forEach(btn => {
    btn.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
    });
    btn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const commentIndex = Number(btn.dataset.detailRepliesShowMore);
      const anchorItem = btn.closest('.detail-comment-item');
      const scrollAnchor = anchorItem ? {
        commentIndex,
        top: anchorItem.getBoundingClientRect().top
      } : null;
      const currentCount = detailVisibleReplyCounts.get(commentIndex) || DETAIL_REPLY_BATCH_SIZE;
      detailVisibleReplyCounts.set(commentIndex, currentCount + DETAIL_REPLY_BATCH_SIZE);
      btn.blur();
      renderPostDetailContent({ preserveScroll: true, scrollAnchor });
    });
  });

  contentEl.querySelectorAll('.comment-like-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const index = Number(btn.dataset.commentIndex);
      const comment = post.comments[index];
      if (!comment) return;
      const commentLikes = Array.isArray(comment.likes) ? comment.likes : [];
      const userKey = getCurrentForumUserKey(getCurrentSpace());
      comment.likes = commentLikes.includes(userKey) ? commentLikes.filter(item => item !== userKey) : [...commentLikes, userKey];
      await saveState();
      renderPostDetailContent({ preserveScroll: true });
    });
  });

  contentEl.querySelectorAll('.detail-comment-item').forEach(item => {
    item.addEventListener('click', event => {
      if (!detailCommentManageMode) return;
      if (event.target.closest('button')) return;
      if (event.target.closest('.comment-reply-item')) return;
      const index = Number(item.dataset.detailCommentIndex);
      if (!post.comments[index]) return;
      if (detailCommentManageMode === 'edit') {
        openForumDetailCommentEditor(post, { commentIndex: index });
        return;
      }
      if (detailCommentManageMode === 'delete') {
        const targetKey = getDetailCommentTargetKey({ commentIndex: index });
        toggleDetailCommentSelection(targetKey, item);
      }
    });
  });

  contentEl.querySelectorAll('.comment-reply-item').forEach(item => {
    item.addEventListener('click', event => {
      if (!detailCommentManageMode) return;
      event.stopPropagation();
      if (event.target.closest('button')) return;
      const commentIndex = Number(item.dataset.detailCommentIndex);
      const replyIndex = Number(item.dataset.detailReplyIndex);
      const targetKey = getDetailCommentTargetKey({ commentIndex, replyIndex });
      const comment = post.comments[commentIndex];
      const reply = comment?.replies?.[replyIndex];
      if (!comment || !reply) return;
      if (detailCommentManageMode === 'edit') {
        openForumDetailCommentEditor(post, { commentIndex, replyIndex });
        return;
      }
      if (detailCommentManageMode === 'delete') {
        toggleDetailCommentSelection(targetKey, item);
      }
    });
  });

  // ▼▼▼ 新增：修复返回逻辑与绑定重新生成按钮 ▼▼▼
  const backBtn = contentEl.querySelector('#detail-back-btn');
  backBtn?.addEventListener('click', () => {
    stopForumDetailVideoTimer();
    stopForumPeekTimer();
    stopForumPostAudio();
    clearPendingUserComments();
    currentDetailPost = null;
    currentDetailReplyTarget = null;
    const returnView = currentDetailReturnView;
    const returnProfileId = currentDetailReturnProfileId;
    currentDetailReturnView = 'feed';
    currentDetailReturnProfileId = null;
    if (returnView === 'profile' && returnProfileId) {
      const backSpace = getCurrentSpace();
      const isMainMemberProfile = (backSpace?.members || []).some(member => String(member.id) === String(returnProfileId));
      openProfile(returnProfileId, isMainMemberProfile ? { forceMain: true } : {});
      return;
    }
    showPage('page-forum');
    renderApp();
  });
  const regenBtn = contentEl.querySelector('#detail-regenerate-btn');
  regenBtn?.addEventListener('click', async (event) => {
    event.stopImmediatePropagation();
    // 【核心】只查当前帖子是不是在转，绝不干涉别的帖子
    if (forumGeneratingPosts.has(post.id)) return window.showDynamicIsland?.('当前帖子生成中，请稍候');
    regenBtn.disabled = true;
    post.comments = [];              
    await saveState();
    renderPostDetailContent();       
    await generateForumComments(getCurrentSpace(), post, 'init'); 
    regenBtn.disabled = false;
  }, true);
 contentEl.querySelector('.more-btn')?.addEventListener('click', () => {
    openForumDetailCommentMenu(post);
  });
  const captionToggle = contentEl.querySelector('[data-detail-caption-toggle]');
  const captionTextEl = contentEl.querySelector('[data-detail-caption-text]');
  if (captionToggle && captionTextEl) {
    requestAnimationFrame(() => {
      const needsFold = captionTextEl.scrollHeight > captionTextEl.clientHeight + 1;
      captionToggle.hidden = !needsFold;
      if (!needsFold) {
        captionTextEl.classList.remove('collapsed', 'expanded');
        captionTextEl.closest('.forum-detail-video-caption')?.classList.remove('is-expanded');
      }
    });
  }
  captionToggle?.addEventListener('click', event => {
    const button = event.currentTarget;
    const caption = captionTextEl;
    if (!caption) return;
    const isExpanded = caption.classList.toggle('expanded');
    caption.classList.toggle('collapsed', !isExpanded);
    caption.closest('.forum-detail-video-caption')?.classList.toggle('is-expanded', isExpanded);
    button.textContent = isExpanded ? '收起' : '展开';
    button.setAttribute('aria-expanded', String(isExpanded));
  });
  bindForumDetailShortVideo(contentEl);
    contentEl.querySelectorAll('[data-forum-timenode]').forEach(node => {
    node.addEventListener('click', event => {
      event.stopPropagation();
      const videoEl = contentEl.querySelector('[data-detail-short-video]');
      const range = contentEl.querySelector('[data-detail-video-range]');
      if (!videoEl || !range) return;
      const totalSec = Number(node.dataset.forumTimenode) || 0;
      const shortVideoMedia = Array.isArray(post.media) ? post.media.find(media => media.type === 'slides-video') : null;
      const targetIndex = getForumSlideIndexAtSecond(shortVideoMedia, totalSec);
      range.value = String(getForumSlideStartUnit(shortVideoMedia, targetIndex));
      range.dispatchEvent(new Event('input'));
      const detailPageEl = document.getElementById('page-forum-post-detail');
      detailPageEl?.classList.remove('is-comments-open');
      if (detailPageEl) delete detailPageEl.dataset.commentsActive;
    });
  });
  contentEl.querySelectorAll('[data-detail-comments-toggle]').forEach(toggleBtn => {
    toggleBtn.addEventListener('click', () => {
      const willOpen = !detailPage?.classList.contains('is-comments-open');
      detailPage?.classList.toggle('is-comments-open');
      if (willOpen) openDetailComments({ focusInput: toggleBtn.classList.contains('forum-detail-video-comment-pill') });
      if (!willOpen && detailPage) delete detailPage.dataset.commentsActive;
    });
  });
  contentEl.querySelector('#detail-comment-count-btn')?.addEventListener('click', () => {
    openDetailComments({ focusInput: false });
  });
  contentEl.querySelector('#detail-forward-btn')?.addEventListener('click', () => openForumForwardPicker(post));
  contentEl.querySelector('[data-detail-comments-close]')?.addEventListener('click', () => {
    detailPage?.classList.remove('is-comments-open');
    if (detailPage) delete detailPage.dataset.commentsActive;
  });
  contentEl.querySelector('[data-detail-video-like]')?.addEventListener('click', () => {
    contentEl.querySelector('#detail-like-btn')?.click();
  });
  contentEl.querySelector('#detail-save-btn')?.addEventListener('click', () => openForumSavePicker(post));
  contentEl.querySelector('[data-detail-video-save]')?.addEventListener('click', () => openForumSavePicker(post));
  contentEl.querySelectorAll('[data-action="play-music"]').forEach(musicBtn => {
    musicBtn.addEventListener('click', event => {
      event.stopPropagation();
      playForumPostMusic(post, musicBtn);
    });
  });
  contentEl.querySelectorAll('[data-action="collect-music"]').forEach(collectBtn => {
    collectBtn.addEventListener('click', event => {
      event.stopPropagation();
      collectForumPostMusic(post, collectBtn);
    });
  });
  syncForumMusicButtons();
  refreshForumPresenceRadar();
  if (shouldRestoreScroll) {
    const restoreScroll = () => {
      contentEl.scrollTop = previousScrollTop;
      const commentsList = contentEl.querySelector('.detail-comments-list');
      if (commentsList) commentsList.scrollTop = previousCommentsListScrollTop;
      if (scrollAnchor && Number.isInteger(scrollAnchor.commentIndex)) {
        const anchorItem = contentEl.querySelector(`.detail-comment-item[data-detail-comment-index="${scrollAnchor.commentIndex}"]`);
        const scrollTarget = detailPage?.classList.contains('is-short-video-detail') ? commentsList : contentEl;
        if (anchorItem && scrollTarget) {
          scrollTarget.scrollTop += anchorItem.getBoundingClientRect().top - scrollAnchor.top;
        }
      }
    };
    requestAnimationFrame(() => {
      restoreScroll();
      requestAnimationFrame(restoreScroll);
    });
  }
  // ▲▲▲ 新增结束 ▲▲▲
}

function refreshForumPresenceRadar() {
  const btn = document.getElementById('forum-presence-radar-btn');
  const panel = document.getElementById('forum-presence-radar-panel');
  const list = document.getElementById('forum-presence-radar-list');
  if (!btn || !panel || !list || !currentDetailPost) return;
  const post = currentDetailPost;
  const space = getCurrentSpace();
  const effectiveHiddenLinkMemberIds = getEffectiveForumHiddenLinkMemberIds(space, post);
  const discovered = Object.keys(post.hiddenLinkState || {})
    .filter(id => effectiveHiddenLinkMemberIds.includes(String(id)) && post.hiddenLinkState[id]?.discovered);
  if (effectiveHiddenLinkMemberIds.length === 0 || discovered.length === 0) {
    btn.style.display = 'none';
    panel.style.display = 'none';
    forumPresenceRadarRenderKey = '';
    return;
  }
  btn.style.display = 'flex';
  const renderKey = JSON.stringify(discovered.map(id => {
    const st = post.hiddenLinkState?.[id] || {};
    const peeks = Array.isArray(st.peeks) ? st.peeks.slice(-3) : [];
    return [post.id, id, st.speakChance || 0, peeks.map(pk => [pk.time || 0, pk.readText || '', pk.thought || '', pk.translation || ''])];
  }));
  if (forumPresenceRadarRenderKey === renderKey && list.children.length) return;
  forumPresenceRadarRenderKey = renderKey;
  list.innerHTML = discovered.map(id => {
    const member = (space.members || []).find(m => m.id === id);
    if (!member) return '';
    const name = getForumDisplayName(space, id, member.name);
    const prob = getMemberAppearProbability(post, id);
    const st = post.hiddenLinkState[id] || {};
    const peekList = Array.isArray(st.peeks) ? st.peeks : [];
    const recentPeeks = peekList.slice(-3).reverse();
    const peeksHtml = recentPeeks.length ? recentPeeks.map(pk => `
        <div style="margin-top: 8px; padding: 8px 10px; background: #fff; border: 1px solid #f0f0f0; border-radius: 10px;">
          ${pk.readText ? `
            <div style="display: flex; align-items: flex-start; gap: 5px; margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px dashed #eee;">
              <span style="flex: 0 0 auto; font-size: 8px; color: #bbb; letter-spacing: 1px; margin-top: 2px;">READING</span>
              <span style="flex: 1; min-width: 0; font-size: 11px; color: #888; line-height: 1.4;">「${escapeHTML(pk.readText)}」</span>
            </div>
          ` : ''}
          <div style="font-size: 8px; color: #ccc; letter-spacing: 1.5px; margin-bottom: 4px;">INNER VOICE</div>
          <div style="font-size: 12px; color: #333; line-height: 1.5;">${escapeHTML(pk.thought || '')}</div>
          ${pk.translation ? `<div style="margin-top: 6px; padding-top: 6px; border-top: 1px dashed #eee; font-size: 11px; color: #888; line-height: 1.4;">译：${escapeHTML(pk.translation)}</div>` : ''}
        </div>
    `).join('') : '<div style="margin-top: 8px; font-size: 11px; color: #ccc;">还没有窥屏记录</div>';
    return `
      <div style="padding: 10px; border-radius: 12px; background: #f9f9f9;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <img src="${escapeHTML(member.avatar || DEFAULT_AVATAR_SRC)}" style="width: 34px; height: 34px; border-radius: 50%; object-fit: cover;">
          <div style="flex: 1; min-width: 0;">
            <div style="font-size: 13px; font-weight: 700; color: #111; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHTML(name)}</div>
            <div style="font-size: 10px; color: #999;">发言概率 ${prob}%</div>
          </div>
        </div>
        ${peeksHtml}
      </div>
    `;
  }).join('') || '<small style="color:#bbb; padding: 10px;">暂无已发现角色</small>';
}

function bindForumPresenceRadar() {
  const btn = document.getElementById('forum-presence-radar-btn');
  const panel = document.getElementById('forum-presence-radar-panel');
  if (!btn || !panel || btn.dataset.bound === 'true') return;
  btn.dataset.bound = 'true';
  btn.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    if (panel.style.display === 'block') refreshForumPresenceRadar();
  });
  document.addEventListener('pointerdown', event => {
    if (panel.style.display !== 'block') return;
    if (btn.contains(event.target) || panel.contains(event.target)) return;
    panel.style.display = 'none';
  });
}

function bindForumDetailControls() {
  const sendBtn = document.getElementById('detail-comment-send');
  const inputEl = document.getElementById('detail-comment-input');
  const commentAvatar = document.getElementById('detail-comment-avatar');
  setupForumAtMentionInput(inputEl);
  setupForumAtMentionInput(document.getElementById('forum-compose-full-text'));
  
  if (commentAvatar && commentAvatar.dataset.forumAliasBound !== 'true') {
    commentAvatar.dataset.forumAliasBound = 'true';
    commentAvatar.addEventListener('click', openDetailCommentAccountSwitcher);
    commentAvatar.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openDetailCommentAccountSwitcher();
    });
  }
  if (sendBtn && inputEl && sendBtn.dataset.forumSendBound !== 'true') {
    sendBtn.dataset.forumSendBound = 'true';
    sendBtn.addEventListener('click', async () => {
     if (sendBtn.dataset.isGenerating === 'true' && currentDetailPost) {
        const controller = forumAbortControllers.get(currentDetailPost.id);
        if (controller) {
          controller.abort();
          forumAbortControllers.delete(currentDetailPost.id);
        }
        return;
      }
      await flushPendingUserComments();
    });
  }
  if (inputEl && inputEl.dataset.forumEnterBound !== 'true') {
    inputEl.dataset.forumEnterBound = 'true';
    // 监听回车键：先把当前输入上屏，不触发 AI
    inputEl.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        await queueDetailInputComment();
      }
    });
  }
  if (inputEl && inputEl.dataset.forumFocusBound !== 'true') {
    inputEl.dataset.forumFocusBound = 'true';
    inputEl.addEventListener('focus', () => {
      document.getElementById('page-forum-post-detail')?.classList.add('is-comment-input-focused');
    });
    inputEl.addEventListener('blur', () => {
      document.getElementById('page-forum-post-detail')?.classList.remove('is-comment-input-focused');
    });
  }
  const guideBtn = document.getElementById('detail-comment-guide-btn');
  if (guideBtn && guideBtn.dataset.forumGuideBound !== 'true') {
    guideBtn.dataset.forumGuideBound = 'true';
    guideBtn.addEventListener('click', openForumDirectionSheet);
  }
  const continueBtn = document.getElementById('detail-comment-continue-btn');
  if (continueBtn && continueBtn.dataset.forumContinueBound !== 'true') {
    continueBtn.dataset.forumContinueBound = 'true';
    continueBtn.addEventListener('click', async () => {
    if (!currentDetailPost) {
      window.showDynamicIsland?.('请先打开帖子');
      return;
    }
    if (forumGeneratingPosts.has(currentDetailPost.id)) {
      window.showDynamicIsland?.('评论还在生成中');
      return;
    }
    const inputText = String(document.getElementById('detail-comment-input')?.value || '').trim();
    if (inputText || pendingUserComments.length || currentDetailReplyTarget) {
      window.showDynamicIsland?.('先发送或取消当前回复，再续写');
      return;
    }
    const forumDirection = consumeForumDirectionRound(currentDetailPost);
    await saveState();
    generateForumComments(getCurrentSpace(), currentDetailPost, 'continue', { forumDirection });
    });
  }
  // 新增：评论区重回按钮，撤回最近一波AI生成的评论
  const commentRegenBtn = document.getElementById('detail-comment-regen-btn');
  if (commentRegenBtn && commentRegenBtn.dataset.forumRegenBound !== 'true') {
    commentRegenBtn.dataset.forumRegenBound = 'true';
    commentRegenBtn.addEventListener('click', async () => {
      if (!currentDetailPost) {
        if (window.showDynamicIsland) window.showDynamicIsland('请先打开要重回的帖子');
        return;
      }
      if (forumGeneratingPosts.has(currentDetailPost.id)) {
        if (window.showDynamicIsland) window.showDynamicIsland('评论还在生成中，请稍候再撤回');
        return;
      }
      const backup = forumCommentBackups[currentDetailPost.id];
      if (!backup) {
        if (window.showDynamicIsland) window.showDynamicIsland('暂时没有可以撤回的评论');
        return;
      }
      if (!restoreForumCommentsFromBackup(currentDetailPost, backup)) {
        if (window.showDynamicIsland) window.showDynamicIsland('撤回失败，请重新打开帖子再试');
        return;
      }
      
      // ▼ 修复：取出当时的情境参数，保证重新生成时 AI 还是在回复对的人
      const savedMode = backup.mode;
      const savedReplyContext = backup.replyContext;
      await saveState();
      renderApp();
      renderPostDetailContent({ preserveScroll: true });
      if (window.showDynamicIsland) window.showDynamicIsland('正在重新生成评论...');
      
      // ▼ 回溯之后，自动触发 AI 重新生成，传入刚才保存的场景参数
      generateForumComments(getCurrentSpace(), currentDetailPost, savedMode, savedReplyContext);
    });
  }
}
// ▲▲▲ 新增结束 ▲▲▲
