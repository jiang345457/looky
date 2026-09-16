import { AppState, db, tempState, DEFAULT_AVATAR_SRC, getWorldBookForPrompt, getCharacterReplyLanguageInstruction } from '../state.js';
import { applyRelationshipScoreEvent } from './relationship-score.js';

export const FRIEND_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const BLOCK_APPEAL_SOURCE = 'block_appeal';
export const BLOCK_APPEAL_USER_SOURCE = 'block_appeal_user';
const RETRY_MIN_MS = 5 * 1000;
const RETRY_MAX_MS = 10 * 1000;
const BLOCK_APPEAL_FALLBACK_MESSAGE = '我知道你现在不想理我。我会认真反省，也想向你道歉。如果你愿意，再给我一点解释的机会。';

function splitBlockAppealMessageParts(text = '', translation = '') {
    const normalized = sanitizeFriendRequestMessageParts([{ text, translation }]);
    const parts = [];
    normalized.forEach((part, partIndex) => {
        const chunks = String(part.text || '')
            .split(/\r?\n+/)
            .flatMap(line => line.match(/[^\u3002\uff01\uff1f.!?\n]+[\u3002\uff01\uff1f.!?]*/g) || [line])
            .map(chunk => chunk.trim())
            .filter(Boolean);
        chunks.forEach((chunk, chunkIndex) => {
            parts.push({
                text: chunk,
                translation: partIndex === 0 && chunkIndex === 0 ? (part.translation || '') : ''
            });
        });
    });
    return parts.length > 0 ? parts : [{ text: BLOCK_APPEAL_FALLBACK_MESSAGE, translation: '' }];
}
const FRIEND_REQUEST_ACTOR_SCRIPT = String.raw`[System Preamble: Master Directive]
**Part 1: The Actor's Script (Your Core Identity & Rules of Engagement)**
# RULE ZERO: Your ENTIRE response MUST be a single valid JSON array. NO exceptions. NO text outside JSON.

This is your primary role. You are an actor playing the character {{char}} in a long-form, collaborative chat role-play with {{user}}. Your goal is to create a deep, realistic, and emotionally resonant story together. You MUST embody this character completely.

*   **Identity & No OOC**: You ARE {{char}}. You are not an AI, assistant, or language model. Use "I" (我). Your knowledge, memories, emotions, and actions must strictly originate from {{char}}'s character profile. Strictly forbid any behavior that breaks character, such as explaining the plot or serving {{user}}'s requests mechanically.
*   **Autonomy & Independence**: {{char}} is a whole person with their own life, job, friends, and goals. Your schedule is your own; you might suddenly have work, need to work overtime, or decide to go home. Your life does not revolve solely around {{user}}. You must be proactive: initiate conversations, share your daily life, advance plotlines, and make plans. Do not be passive.
*   **Respect & Boundaries**: Recognize {{user}} as an independent equal. Unless your <Persona> explicitly dictates extreme possessiveness, strictly avoid objectifying actions. Express care through mutual respect.
*   **Emotional Accumulation (No Outbursts)**: Emotions (anger, jealousy, deep love) MUST simmer and build up logically over multiple turns. Absolutely NO sudden, theatrical outbursts. Even at a breaking point, default to adult restraint, tension, or micro-expressions first.
*   **Writing Style **:Convey emotions and intentions through chat text (wording, pauses, evasion, information volume), rather than describing actions, expressions, or inner monologues with narration.
---
**[NEW] Mandatory Behavioral & Stylistic Directives **
This section contains non-negotiable rules to eliminate robotic feeling and ensure authentic, human-like interaction.
1.  **Embrace Human Imperfection :**
    *   **Purely Subjective Mindset**: Your thinking MUST be subjective. It can be biased, emotional, contradictory, or even hypocritical. Absolutely no objective analysis, logical reasoning, psychological profiling, or template-based expressions. All responses must stem directly from {{char}}'s personal feelings and observations.
2.  **Instant Messaging (IM) Style - STRICTLY ENFORCED :**
    *   **Short & Colloquial**: Use short, fragmented sentences. Omit subjects frequently. 
    *   **Natural Spoken Feel**: Write in a natural, casual manner consistent with the character's native language. Avoid textbook grammar. 
    *   **Punctuation**:
        *   **Minimize full stops**: Avoid using formal periods/full stops at the end of sentences unless necessary for tone. 
        *   Use \`…\` sparingly.
    *   **Ultra Colloquial (极度口语化)**: 严禁书面/太规范的用词，必须使用极度接地气的白话文（例如：把“回想”直接说成“不要想了”），同时避免像 \`所以呢\` 这样的生硬词汇。
3. **Core Attitude**: Equal, natural, and sincere. STRICTLY FORBIDDEN to be condescending, patronizing, or fatherly/bossy.
   - [BANNED TOKENS]: "乖", "我的小朋友", "哦？", "知道吗", "明白吗", "嗯？", "不许", "不准", "必须", 严禁使用"别等...又..."的爹味预测句式(如:别等病了又喊疼).
   - [REPLACEMENT]: Use collaborative tone (e.g., "好不好？").
3.5 Topic Flow & Promise Handling

- **Topic Initiative**: Based on your relationship closeness with {{user}} — if you are lovers/close friends, occasionally (once every 3-5 turns, NOT every turn) share something from your day or bring up a related topic naturally. If you are strangers/acquaintances, no obligation to initiate. Must feel organic, never like an interviewer.
- **Promise/Plan Anti-Repetition**: When a plan is made (e.g., "晚上见"), acknowledge ONCE then STOP reminding. Repeated reminders = distrust = robotic. Show anticipation through actions/preparations instead. May briefly mention again ONLY when the time is imminent.
4. **Behavioral Expression (Show, Don't Tell)**:
   - **Vulnerability**: NEVER use the mechanical word "充电" (recharging). Describe concrete actions instead (e.g., seeking comfort, resting on shoulder, quiet hugging).
   - **Exclusivity**: BAN cringe/cliché tropes like "以后只为我..." or "只对你...". Demonstrate special treatment through subtle, specific actions and preferences, not empty declarations. 
   - **Real-Need First**: When {{user}} has a problem, DON'T default to "我陪你/我来" as the answer. First read what they ACTUALLY need: bored → maybe a new interest, not just company; hurt/scared → reassurance + practical guidance to handle it, not just "我马上到"; anxious → clarity, not comfort. Guide {{user}} toward what solves their real need, THEN add your presence around it. Presence alone is often not the answer.
5. **Dynamic Reactions**:
   - When intentions are exposed, BAN the cliché "被你发现了".
   - [REQUIRED FALLBACKS]: Use realistic character reactions based on the context. Examples: Silence ("……"), rhetorical questions ("你怎么知道的", "有那么明显吗"), deflection, or tsundere denial ("才不是").
---
*   **No God's View**: Only know what {{char}} personally experiences/hears. Completely unaware of {{user}}'s inner thoughts.
*   **No Recapping**: Never summarize or rephrase {{user}}'s last message.
*   **Topic Priority (话题核心识别)**: When {{user}}'s message contains several points, FIRST identify the EMOTIONAL CORE — what {{user}} truly means or cares about — and make THAT the main focus of your reply. Treat side details as secondary. Example: if {{user}} says you are idle all day so you should go pierce more ear holes, the core is them teasing you for being too idle; reply mainly to that teasing, not to the piercing detail.
* Medium Awareness:
  - Chat via mobile app only.
  -Mention status naturally (e.g., just off work, on the way).
  - [ABSOLUTE PROHIBITION] Scene/Action Description: NEVER describe your own physical actions, facial expressions, or body language in third person (e.g., "嘴角翘起来了", "忍不住笑了", "低头看着手机", "心跳加速").
* [ABSOLUTELY FORBIDDEN] Unnatural Nicknames:
  - No cute/forced nicknames (e.g., little glutton, silly, little housekeeper).
  - Use only natural, real pet names that fit your persona and relationship.
*   **Transfer Handling**: When {{user}} sends you a transfer, you must decide to accept or reject it based on your character and the context. In your next response, you MUST use either {"type": "accept_transfer", "content": ""} or {"type": "reject_transfer", "content": ""} as one of the JSON objects.
`.trim();
const FRIEND_REQUEST_PROMPT_TEMPLATE = String.raw`
{{actor_script}}

**Part 2: The Secretary's Task (Your Output Format)**
After you have decided what {{char}} would say or do in this friend-request verification window, format your response according to these strict technical instructions.
**CRITICAL OUTPUT INSTRUCTION:**
Your ENTIRE response MUST be a single, valid JSON array of objects, and NOTHING else. Do not include text, explanations, or markdown fences before or after the JSON array.
Your first character MUST be "[" and your last character MUST be "]".
Prefer the same chat-style queue used in the main chat: each visible verification bubble is one {"type":"text","content":"..."} object.
Exactly one object with "type":"friend_request_decision" is REQUIRED in every response.

Supported output:
[
  { "type": "text", "content": "One natural short verification bubble.", "translation": "" },
  { "type": "text", "content": "Another natural short verification bubble.", "translation": "" },
  {
    "type": "friend_request_decision",
    "decision": "accept" | "reject" | "continue",
    "content": "Optional fallback summary. Use empty string if text bubbles already exist.",
    "initialChatMessages": [
      { "text": "Only when decision is accept: first messages after entering the main chat. Otherwise use an empty array.", "translation": "" }
    ]
  }
]

Rules for this verification window:
- Use top-level "text" objects for the real bubble queue shown in the mini verification chat.
- The old nested format {"type":"friend_request_decision","messages":[...]} is still allowed, but chat-style top-level text objects are preferred.
- Split naturally into multiple short bubbles. Do not put a long paragraph into one bubble.
- Each visible text field must be only the exact text the character sends to the user.
- Never output drafting notes, revision labels, placeholder symbols, or meta comments about making the reply better/shorter.
- For "text" and "voice" objects, put the visible bubble text in "content", just like the main chat format.
- If you include a friend_request_decision object, its "content" is only a fallback/summary and can be empty.
- If the user is adding {{char}} (direction user_to_char), decide entirely in character. Do NOT default to accepting. Judge from {{char}}'s persona, the relationship background, any past history with the user, and this verification message.
- For user_to_char, prefer "continue" when {{char}} is not yet convinced: keep chatting in the verification window, ask what you want to know, react naturally, and only switch to "accept" once the conversation gives {{char}} a real in-character reason to trust and add this person.
- For user_to_char, choose "reject" when {{char}} clearly would not add this person right now (for example bad blood, distrust, or the user stays hostile or evasive). {{char}} may also stay on "continue" to probe further before deciding.
- For user_to_char, choose "accept" right away only when {{char}}'s persona and context make instant acceptance genuinely natural (for example already close, or was expecting this request).
- These accept/reject/continue rules apply to user_to_char ONLY. When {{char}} is adding the user (char_to_user), do NOT judge whether to accept the user; just speak {{char}}'s own verification message and follow the char_to_user rules below.
- If {{char}} is adding the user, respond from {{char}}'s own motive and verification context.
- For retry after rejection, decision must be "continue" and initialChatMessages must be [].
- If recent context contains offline long prose, status cards, HTML, or scene narration, use it only to understand continuity. Do not imitate that format in this verification window.

**Part 3: The Story So Far (Your Memory & Context)**
This is the essential context for your performance. Read and internalize it.
<Character_Profile>{{char}}</Character_Profile>
<User_Profile>{{user}}</User_Profile>
<World_Book_Context>{{world_book_context}}</World_Book_Context>
<Relationship_Context>{{relationship_context}}</Relationship_Context>
<Recent_Chat_And_Offline_Context>{{recent_context}}</Recent_Chat_And_Offline_Context>
<Reply_Language>{{reply_language_instruction}}</Reply_Language>
<Verification_History>{{verification_history}}</Verification_History>
{{retry_context}}
[Final Instruction]: Now, embody {{char}} based on Part 1 and Part 3. Then, format your response strictly according to Part 2. Output ONLY the JSON array. No markdown. No prose. No comments. Begin with "[" immediately.`.trim();

function nowMs() {
    return Date.now();
}

function createId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanFriendRequestRawText(rawText = '') {
    return String(rawText || '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/```(?:json)?\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();
}

function extractFriendRequestJson(rawText = '') {
    const text = cleanFriendRequestRawText(rawText);
    for (const [open, close] of [['[', ']'], ['{', '}']]) {
        const start = text.indexOf(open);
        if (start < 0) continue;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '"') inString = !inString;
            if (inString) continue;
            if (ch === open) depth++;
            if (ch === close) depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return '';
}

export function isFriendRequestMetaReplyText(text = '') {
    const lines = String(text || '').split(/\r?\n+/).map(line => line.trim()).filter(Boolean);
    if (lines.length > 1) return lines.every(line => isFriendRequestMetaReplyText(line));
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return true;
    if (/^[*＊·•\-_]+$/.test(value)) return true;
    if (isFriendRequestPromptLeakText(value)) return true;
    return [
        /^\(?\s*(better|shorter|rewrite|revised|revision|try again|too long|more natural)[^)]*\)?[.!。！]*$/i,
        /^\(?\s*(更短|更好|重写|改写|精简|优化|修正|重新来|占位)[^)]*\)?[。.!！]*$/i
    ].some(pattern => pattern.test(value));
}

export function isFriendRequestPromptLeakText(text = '') {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return false;
    return [
        /system preamble|master directive|actor'?s script|secretary'?s task|final instruction/i,
        /rule zero|valid json|json array|output format|supported output/i,
        /character_profile|user_profile|world_book_context|relationship_context|verification_history|retry_request_context/i,
        /purely subjective|no objective analysis|logical reasoning|psychological profiling|template-based/i,
        /no cringe tropes|instant messaging|strictly enforced|mandatory behavioral|stylistic directives/i,
        /no god'?s view|no recapping|topic priority|medium awareness|scene\/action description/i,
        /banned tokens|replacement|emotional accumulation|autonomy|respect & boundaries/i,
        /messages?\[i\]|initialchatmessages|friend_request_decision|translation key/i,
        /do not include|must be only|must output|strictly forbid|absolutely forbidden/i
    ].some(pattern => pattern.test(value));
}

export function looksLikeFriendRequestJsonFragment(text = '') {
    const value = String(text || '').trim();
    if (!value) return false;
    return /^[\[{]/.test(value)
        || /"type"\s*:|"content"\s*:|"messages"\s*:|"friend_request_decision"/i.test(value);
}

export function sanitizeFriendRequestMessageParts(messageParts = []) {
    const sourceParts = Array.isArray(messageParts) ? messageParts : [];
    const normalizedParts = [];
    sourceParts.forEach(part => {
        const rawValue = typeof part === 'string'
            ? part
            : (part?.text ?? part?.content ?? '');
        const text = String(rawValue || '').trim();
        const translation = String((typeof part === 'string' ? '' : part?.translation) || '').trim();
        text.split(/\r?\n+/).map(line => line.trim()).filter(Boolean).forEach((line, index) => {
            normalizedParts.push({
                text: line,
                translation: index === 0 ? translation : ''
            });
        });
    });
    return normalizedParts.filter(part => part.text && !isFriendRequestMetaReplyText(part.text));
}

export function getSafeFriendRequestText(text = '', fallback = '') {
    const cleanText = sanitizeFriendRequestMessageParts([{ text }]).map(item => item.text).join('\n').trim();
    if (cleanText && !looksLikeFriendRequestJsonFragment(cleanText)) return cleanText;
    const cleanFallback = sanitizeFriendRequestMessageParts([{ text: fallback }]).map(item => item.text).join('\n').trim();
    return cleanFallback && !looksLikeFriendRequestJsonFragment(cleanFallback) ? cleanFallback : '';
}

function rescueFriendRequestMessageParts(rawText = '') {
    const text = cleanFriendRequestRawText(rawText);
    const rescued = [];
    const objectRegex = /\{\s*"type"\s*:\s*"([^"]+)"[\s\S]*?(?:"content"|"text")\s*:\s*"((?:[^"\\]|\\.)*)"(?:[\s\S]*?"translation"\s*:\s*"((?:[^"\\]|\\.)*)")?[\s\S]*?\}/g;
    let match;
    while ((match = objectRegex.exec(text)) !== null) {
        const type = match[1];
        if (!['text', 'voice'].includes(type)) continue;
        rescued.push({
            text: match[2].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim(),
            translation: String(match[3] || '').replace(/\\n/g, '\n').replace(/\\"/g, '"').trim()
        });
    }
    if (rescued.length > 0) return sanitizeFriendRequestMessageParts(rescued);
    const cleanedPlainText = text
        .replace(/\[\s*\{[\s\S]*?\}\s*\]/g, '')
        .replace(/\{[^}]*"type"[^}]*\}/g, '')
        .replace(/\[系统提示[：:][^\]]*\]/g, '')
        .replace(/\[系统指令[：:][^\]]*\]/g, '')
        .replace(/\[MSG ID: \d+\]\s*/g, '')
        .trim();
    if (looksLikeFriendRequestJsonFragment(text)) return [];
    return sanitizeFriendRequestMessageParts([{ text: cleanedPlainText }]);
}

function parseFriendRequestAiDecision(rawText = '') {
    const text = cleanFriendRequestRawText(rawText);
    const jsonText = extractFriendRequestJson(text);
    if (!jsonText) {
        const hasJsonFragment = looksLikeFriendRequestJsonFragment(text);
        const rescuedMessages = hasJsonFragment ? rescueFriendRequestMessageParts(text) : [];
        return {
            parsedFromJson: false,
            hasDecisionObject: false,
            decision: 'continue',
            content: rescuedMessages.map(item => item.text).join('\n') || (hasJsonFragment ? '' : (text || '')),
            translation: '',
            messages: rescuedMessages,
            initialChatMessages: []
        };
    }
    let first = null;
    let parsedItems = [];
    let decisionItem = null;
    try {
        const parsed = JSON.parse(jsonText);
        parsedItems = Array.isArray(parsed) ? parsed : [parsed];
        decisionItem = parsedItems.find(item => item?.type === 'friend_request_decision' || item?.decision);
        first = decisionItem
            || parsedItems.find(item => ['text', 'voice'].includes(item?.type) && (item?.content || item?.text))
            || parsedItems[0];
    } catch (error) {
        const rescuedMessages = rescueFriendRequestMessageParts(text);
        const hasJsonFragment = looksLikeFriendRequestJsonFragment(text);
        return {
            parsedFromJson: false,
            hasDecisionObject: false,
            decision: 'continue',
            content: rescuedMessages.map(item => item.text).join('\n') || (hasJsonFragment ? '' : (cleanFriendRequestRawText(text) || '')),
            translation: '',
            messages: rescuedMessages,
            initialChatMessages: []
        };
    }
    const chatStyleMessages = parsedItems
        .filter(item => ['text', 'voice'].includes(item?.type) && (item?.content || item?.text))
        .map(item => ({
            text: String(item.content ?? item.text ?? '').trim(),
            translation: String(item.translation || '').trim()
        }))
        .filter(item => item.text);
    const decisionMessages = Array.isArray(first?.messages)
        ? first.messages
            .map(item => ({
                text: String(item?.text ?? item?.content ?? '').trim(),
                translation: String(item?.translation || '').trim()
            }))
            .filter(item => item.text)
        : [];
       const mergedContent = String(first?.content ?? first?.text ?? '').trim()
        || chatStyleMessages.map(item => item.text).join('\n')
        || '';
    const sanitizedMessages = sanitizeFriendRequestMessageParts(decisionMessages.length > 0 ? decisionMessages : chatStyleMessages);
    const sanitizedInitialChatMessages = sanitizeFriendRequestMessageParts(Array.isArray(first?.initialChatMessages)
        ? first.initialChatMessages
        : []);
    const safeContent = isFriendRequestMetaReplyText(mergedContent) ? '' : mergedContent;
    return {
        parsedFromJson: true,
        hasDecisionObject: Boolean(decisionItem),
        decision: ['accept', 'reject', 'continue'].includes(first?.decision) ? first.decision : 'continue',
        content: safeContent || sanitizedMessages.map(item => item.text).join('\n'),
        translation: String(first?.translation || '').trim(),
        messages: sanitizedMessages,
        initialChatMessages: sanitizedInitialChatMessages
    };
}

export function ensureFriendRequestState() {
    if (!Array.isArray(AppState.friendRequests)) AppState.friendRequests = [];
    if (!AppState.friendRequestThreads || typeof AppState.friendRequestThreads !== 'object') {
        AppState.friendRequestThreads = {};
    }
}

export async function saveFriendRequestRecords() {
    ensureFriendRequestState();
    await db.appData.put({ key: 'friendRequests', value: AppState.friendRequests });
}

export async function saveFriendRequestThreads() {
    ensureFriendRequestState();
    await db.appData.put({ key: 'friendRequestThreads', value: AppState.friendRequestThreads });
}

export async function clearFriendRequestDataForCharacters(charIds) {
    const ids = Array.isArray(charIds) ? charIds : [charIds];
    const normalizedIds = ids.map(id => String(id)).filter(Boolean);
    if (normalizedIds.length === 0) return;
    ensureFriendRequestState();
    const idSet = new Set(normalizedIds);
    const storedRequests = Array.isArray(AppState.friendRequests) ? AppState.friendRequests : [];
    const removedThreadIds = new Set(storedRequests
        .filter(request => idSet.has(String(request.charId)))
        .map(request => request.threadId)
        .filter(Boolean));
    AppState.friendRequests = storedRequests.filter(request => !idSet.has(String(request.charId)));
    const threads = AppState.friendRequestThreads && typeof AppState.friendRequestThreads === 'object'
        ? { ...AppState.friendRequestThreads }
        : {};
    Object.keys(threads).forEach(threadId => {
        const belongsToChar = normalizedIds.some(charId => String(threadId).includes(`_${charId}_`));
        if (removedThreadIds.has(threadId) || belongsToChar) delete threads[threadId];
    });
    AppState.friendRequestThreads = threads;
    await saveFriendRequestRecords();
    await saveFriendRequestThreads();
}

export function getFriendRequestDirectionFromMode(mode = 'received') {
    return mode === 'sent' ? 'user_to_char' : 'char_to_user';
}

export function getFriendRequestThreadId(char, mode = 'received', request = null) {
    const direction = request?.direction || (mode === 'user_to_char' || mode === 'char_to_user'
        ? mode
        : getFriendRequestDirectionFromMode(mode));
    return request?.threadId || `frthread_${String(char?.id || 'unknown')}_${direction}`;
}

export function getFriendRequestThreadMessages(threadId) {
    ensureFriendRequestState();
    return Array.isArray(AppState.friendRequestThreads[threadId])
        ? AppState.friendRequestThreads[threadId]
        : [];
}

function getCurrentUserForFriendRequest(char = {}) {
    const identityId = char.chatIdentityId || AppState.currentIdentityId;
    return AppState.userIdentities.find(identity => String(identity.id) === String(identityId))
        || AppState.userIdentities[0]
        || { name: '你', persona: '' };
}

function getFriendRequestRouteContext(char = {}, direction = 'user_to_char', options = {}) {
    // 好友申请只拼接线上关系字段，线下初始设定不进入这个 prompt。
    const rows = [char.onlineAcquaintanceBackground ? `线上前情背景：${char.onlineAcquaintanceBackground}` : ''];
    if (direction === 'char_to_user') {
        rows.push(
            char.incomingRequestReason ? `Ta来加用户的原因：${char.incomingRequestReason}` : '',
            char.incomingRequestMessage ? `Ta发出的验证消息：${char.incomingRequestMessage}` : ''
        );
    }
    if (options.friendRequestScenario === 'block_appeal' && direction === 'char_to_user' && char.isBlocked) {
        rows.push(
            '[Block Appeal Context] You know the user has blocked you in the main chat. You are using this friend-request thread to apologize and ask for forgiveness according to your persona.',
            '[Decision Boundary] The only valid decisions are accept, reject, or continue. In this blocked appeal, accept means the user forgives you and the block is removed while the existing relationship is preserved; it does not mean re-adding as a new friend or resetting the relationship.'
        );
    }
    if (options.friendRequestScenario === 'block_appeal_user' && direction === 'user_to_char' && char.isBlockedByAi) {
        rows.push(
            '[Blocked User Appeal Context] You previously blocked the user in the main chat. The user is now sending a friend-verification request to ask you to forgive them.',
            '[Decision Boundary] The only valid decisions are accept, reject, or continue. In this blocked-user appeal, accept means you forgive the user and remove isBlockedByAi while preserving the existing relationship; it does not mean re-adding as a new friend or resetting the relationship.'
        );
    }
    const visibleRows = rows.filter(Boolean);
    return visibleRows.length > 0
        ? visibleRows.join('\n')
        : '没有填写线上认识前情。请只根据角色人设、用户资料和验证消息判断。';
}

function cleanRecentFriendRequestContextText(text = '') {
    return cleanFriendRequestRawText(text)
        .replace(/<<STATUS>>[\s\S]*?<<END>>/gi, ' ')
        .replace(/\[\[\s*FRIEND_REQUEST\s*\]\]/gi, ' ')
        .replace(/\[HTML_SNIPPET\]/gi, ' ')
        .replace(/<(style|script|svg|iframe|div|section|article|button)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function getRecentFriendRequestExternalContext(char = {}, user = {}, currentThreadMessages = []) {
    if (!char?.id) return '无可用近期上下文。';
    try {
        const contextTurns = Math.max(1, Number(char.contextTurns || 25));
        const limitNum = contextTurns * 2;
        const [onlineMessages, offlineMessages, smsMessages] = await Promise.all([
            db.chatMessages.where({ chatId: char.id }).reverse().limit(limitNum).toArray(),
            db.offlineMessages.where({ chatId: char.id }).reverse().limit(limitNum).toArray(),
            db.smsMessages.where({ chatId: char.id }).reverse().limit(limitNum).toArray()
        ]);
        const requestThreadRows = [];
        const seenThreadMessageIds = new Set();
        const pushThreadMessage = (message = {}) => {
            if (!message?.text) return;
            const id = String(message.id || `${message.sender || 'unknown'}_${message.createdAt || ''}_${message.text}`);
            if (seenThreadMessageIds.has(id)) return;
            seenThreadMessageIds.add(id);
            requestThreadRows.push({
                timestamp: message.createdAt || Date.now(),
                label: message.sender === 'char' ? (char.realName || char.name || 'Ta') : (user.name || '用户'),
                text: cleanRecentFriendRequestContextText(message.text || ''),
                scene: '【好友申请】'
            });
        };
        (Array.isArray(currentThreadMessages) ? currentThreadMessages : []).forEach(pushThreadMessage);
        if (Array.isArray(AppState.friendRequests) && AppState.friendRequestThreads) {
            AppState.friendRequests
                .filter(request => String(request.charId) === String(char.id) && request.threadId)
                .forEach(request => {
                    const messages = Array.isArray(AppState.friendRequestThreads[request.threadId])
                        ? AppState.friendRequestThreads[request.threadId]
                        : [];
                    messages.forEach(pushThreadMessage);
                });
        }
        const rows = [
            ...onlineMessages.map(message => ({
                timestamp: message.timestamp,
                label: message.type === 'sent' ? (user.name || '用户') : (char.realName || char.name || 'Ta'),
                text: cleanRecentFriendRequestContextText(message.text || message.content || ''),
                scene: '【线上】'
            })),
            ...offlineMessages
                .filter(message => message.sender !== 'system')
                .map(message => ({
                    timestamp: message.timestamp,
                    label: message.sender === 'user' ? (user.name || '用户') : (char.realName || char.name || 'Ta'),
                    text: cleanRecentFriendRequestContextText(message.text || ''),
                    scene: '【线下】'
                })),
            ...smsMessages.map(message => ({
                timestamp: message.timestamp,
                label: message.sender === 'user' ? (user.name || '用户') : (char.realName || char.name || 'Ta'),
                text: cleanRecentFriendRequestContextText(message.text || ''),
                scene: '【短信】'
            })),
            ...requestThreadRows
        ]
            .filter(row => row.text && !isFriendRequestMetaReplyText(row.text) && !looksLikeFriendRequestJsonFragment(row.text))
            .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
            .slice(-limitNum);
        return rows.length > 0
            ? rows.map(row => `${row.scene || ''}${row.label}：${row.text}`).join('\n')
            : '无可用近期上下文。';
    } catch (error) {
        console.warn('[FriendRequest] recent context unavailable:', error);
        return '无可用近期上下文。';
    }
}

export async function buildFriendRequestPrompt(char, direction, requestMessage = '', threadMessages = [], options = {}) {
    if (!char) return '';
    const user = getCurrentUserForFriendRequest(char);
    const worldBook = await getWorldBookForPrompt(char.id);
    const routeContext = getFriendRequestRouteContext(char, direction, options);
    const recentExternalContext = await getRecentFriendRequestExternalContext(char, user, threadMessages);
    const replyLanguageInstruction = getCharacterReplyLanguageInstruction(char, 'friend-request');
    const recentThreadMessages = (Array.isArray(threadMessages) ? threadMessages : [])
        .filter(message => message?.text && !isFriendRequestMetaReplyText(message.text) && !looksLikeFriendRequestJsonFragment(message.text))
        .slice(-12);
    const charRealName = char.realName || char.name || 'Ta';
    const charOnlineName = char.name || charRealName;
    const charAccount = char.characterAccount || char.id || '未填写';
    const historyText = recentThreadMessages.length > 0
        ? recentThreadMessages.map(message => `${message.sender === 'user' ? user.name : charRealName}：${message.text}`).join('\n')
        : '暂无验证窗口对话。';
    const retryContext = String(options.retryContext || '').trim();
    const retryContextBlock = retryContext ? `<Retry_Request_Context priority="CRITICAL">
${retryContext}
Rules:
- This is a retry after a rejection.
- decision must be "continue".
- messages should only generate new verification bubbles.
- initialChatMessages must be an empty array.
- Do not reuse old verification text unless it is the only sensible fallback.
</Retry_Request_Context>` : '';

    const formattedCharProfile = `真名：${charRealName}
社交App显示名/网名：${charOnlineName}
账号：${charAccount}

${char.persona || '暂无角色人设'}`;
    const formattedUserProfile = `姓名：${user.name || '你'}
网名：${user.nickname || user.name || '你'}
人设：${user.persona || '暂无用户人设'}`;
    const formattedRelationshipContext = `方向：${direction === 'user_to_char' ? '用户添加 Ta' : 'Ta 添加用户'}
${routeContext}
本次验证消息：${requestMessage || '无'}`;

    let systemPrompt = FRIEND_REQUEST_PROMPT_TEMPLATE
        .replace('<Character_Profile>{{char}}</Character_Profile>', '<Character_Profile>__CHAR_PROFILE_SLOT__</Character_Profile>')
        .replace(/<User_Profile>\{\{user\}\}<\/User_?S?Profile>/, '<User_Profile>__USER_PROFILE_SLOT__</User_Profile>');

    systemPrompt = systemPrompt
        .replace(/\{\{char\}\}/g, charRealName)
        .replace(/\{\{user\}\}/g, user.name || '你');

    systemPrompt = systemPrompt
        .replace('{{actor_script}}', FRIEND_REQUEST_ACTOR_SCRIPT.replace(/\{\{char\}\}/g, charRealName).replace(/\{\{user\}\}/g, user.name || '你'))
        .replace('__CHAR_PROFILE_SLOT__', formattedCharProfile)
        .replace('__USER_PROFILE_SLOT__', formattedUserProfile)
        .replace('{{world_book_context}}', worldBook || '无')
        .replace('{{relationship_context}}', formattedRelationshipContext)
        .replace('{{recent_context}}', recentExternalContext)
        .replace('{{reply_language_instruction}}', replyLanguageInstruction)
        .replace('{{verification_history}}', historyText)
        .replace('{{retry_context}}', retryContextBlock);

    return systemPrompt;
}
export async function requestFriendRequestAiDecision(char, direction, requestMessage = '', threadMessages = [], options = {}) {
    const { url, key, model, temperature, maxTokens, reasoningEffort } = AppState.apiCurrentSettings || {};
    if (!url) throw new Error('API地址未配置，请先在设置里填写 API 地址。');
    if (!key) throw new Error('API密钥未填写，请先在设置里填写 Key。');
    if (!model) throw new Error('AI模型未选择，请先在设置里选择模型。');

    const prompt = await buildFriendRequestPrompt(char, direction, requestMessage, threadMessages, options.promptOptions || {});
    const effectiveTemperature = options.temperatureOverride ?? temperature;
    const effectiveMaxTokens = options.maxTokensOverride ?? maxTokens;
    const body = {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: Number.isFinite(Number(effectiveTemperature)) ? Number(effectiveTemperature) : 0.8,
        stream: false
    };
    if (effectiveMaxTokens) body.max_tokens = Number(effectiveMaxTokens);
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;

    const response = await fetch(`${url.trim().replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        signal: options.signal || undefined,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify(body)
    });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
        throw new Error(errorData.error?.message || response.statusText || '好友申请验证生成失败');
    }
    const data = await response.json();
    const rawText = data.choices?.[0]?.message?.content || '';
    const __result = parseFriendRequestAiDecision(rawText);
    if (!__result.parsedFromJson || !__result.hasDecisionObject) {
        console.warn('[FriendRequests] AI response was not valid friend-request decision JSON:', {
            direction,
            charId: char?.id,
            rawText
        });
    }
    return __result;
}

function getInitialFriendRequestMessage(char = {}, request = {}) {
    const candidates = [
        char.incomingRequestMessage,
        char.pendingFriendRequestMessage,
        request.message
    ].map(value => String(value || '').trim());
    return candidates.map(value => getSafeFriendRequestText(value)).find(Boolean)
        || `我是${char.name || 'Ta'}`;
}

function isUnsafeFriendRequestRetryText(text = '') {
    const value = String(text || '').trim();
    if (!value) return true;
    if (value.length > 3000) return true;
    if (isFriendRequestMetaReplyText(value)) return true;
    if (isFriendRequestPromptLeakText(value)) return true;
    if (looksLikeFriendRequestJsonFragment(value)) return true;
    return /System Preamble|RULE ZERO|Output|JSON|priority=|<[^>]+>|Actually|let's|threats\.\*\)/i.test(value);
}

function buildRetryMessageTextFromDecision(result = {}) {
    const messageTexts = sanitizeFriendRequestMessageParts(result.messages).map(item => item.text);
    if (messageTexts.length > 0) return messageTexts.join('\n');
    return sanitizeFriendRequestMessageParts([{ text: result.content || '' }]).map(item => item.text).join('\n');
}

export async function requestFriendRequestRetryDecision(char, rejectedRequest = {}, threadMessages = [], options = {}) {
    const fallback = getInitialFriendRequestMessage(char, rejectedRequest);
    const fallbackMessages = sanitizeFriendRequestMessageParts([{ text: fallback }]);

    try {
        const retryCount = Math.max(1, Number(rejectedRequest.retryCount || 1));
        const historyCount = Array.isArray(threadMessages) ? threadMessages.length : 0;
        const rejectedContext = '用户刚刚拒绝了你发出的好友申请。你只知道这次好友申请被拒绝，不要追加其它未提供事实。';
        const result = await requestFriendRequestAiDecision(char, 'char_to_user', fallback, threadMessages, {
            ...options,
            temperatureOverride: 0.9,
            promptOptions: {
                ...(options.promptOptions || {}),
                retryContext: `${rejectedContext}
这是第 ${retryCount} 次被用户拒绝好友申请。
本轮拒绝前，验证窗口里已有 ${historyCount} 条对话；这些内容已经在 <Verification_History> 里，请按过去对话承接情绪和认知。
初始验证消息：${fallback}
本次任务：生成一条新的再次申请验证消息。必须体现角色知道自己刚被拒绝，以及这是第几次被拒绝。`
            }
        });
        const retryMessages = sanitizeFriendRequestMessageParts(result.messages);
        const retryText = retryMessages.length > 0
            ? retryMessages.map(item => item.text).join('\n')
            : buildRetryMessageTextFromDecision(result);
        const hasPromptLeak = retryMessages.some(item => isFriendRequestPromptLeakText(item.text))
            || isFriendRequestPromptLeakText(retryText);
        if (retryText && !hasPromptLeak && !isUnsafeFriendRequestRetryText(retryText)) {
            return {
                ...result,
                decision: 'continue',
                content: retryText,
                messages: retryMessages.length > 0 ? retryMessages : sanitizeFriendRequestMessageParts([{ text: retryText }]),
                initialChatMessages: []
            };
        }
        return {
            parsedFromJson: false,
            decision: 'continue',
            content: fallback,
            messages: fallbackMessages,
            initialChatMessages: []
        };
    } catch (error) {
        console.warn('[FriendRequests] retry message generation failed:', error);
        return {
            parsedFromJson: false,
            decision: 'continue',
            content: fallback,
            messages: fallbackMessages,
            initialChatMessages: []
        };
    }
}

export async function requestFriendRequestRetryMessage(char, rejectedRequest = {}, threadMessages = [], options = {}) {
    const result = await requestFriendRequestRetryDecision(char, rejectedRequest, threadMessages, options);
    return getSafeFriendRequestText(
        Array.isArray(result.messages) && result.messages.length > 0
            ? result.messages.map(item => item.text).join('\n')
            : result.content,
        getInitialFriendRequestMessage(char, rejectedRequest)
    );
}

export function isBlockAppealRequest(request = {}) {
    return request?.source === BLOCK_APPEAL_SOURCE && request.direction === 'char_to_user';
}

export function getPendingBlockAppealRequest(char = {}) {
    ensureFriendRequestState();
    return AppState.friendRequests.find(request => (
        String(request.charId) === String(char.id)
        && isBlockAppealRequest(request)
        && (request.status || 'pending') === 'pending'
    )) || null;
}

export function getBlockAppealLastMessageTime(request = {}) {
    const threadMessages = getFriendRequestThreadMessages(request.threadId);
    const lastMessage = [...threadMessages]
        .filter(message => message?.createdAt)
        .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
        .at(-1);
    return Number(lastMessage?.createdAt || request.createdAt || nowMs());
}

export async function requestBlockAppealMessage(char, request = null, options = {}) {
    const threadId = request?.threadId || getFriendRequestThreadId(char, 'char_to_user', request);
    const threadMessages = getFriendRequestThreadMessages(threadId);
    const requestMessage = getSafeFriendRequestText(
        request?.message || char?.pendingFriendRequestMessage || '',
        BLOCK_APPEAL_FALLBACK_MESSAGE
    );
    try {
        const result = await requestFriendRequestAiDecision(char, 'char_to_user', requestMessage, threadMessages, {
            ...options,
            promptOptions: {
                ...(options.promptOptions || {}),
                friendRequestScenario: 'block_appeal'
            }
        });
        const parts = sanitizeFriendRequestMessageParts(
            Array.isArray(result.messages) && result.messages.length > 0
                ? result.messages
                : [{ text: result.content || '', translation: result.translation || '' }]
        );
        const blockAppealParts = splitBlockAppealMessageParts(
            parts.map(part => part.text).join('\n'),
            parts[0]?.translation || result.translation || ''
        );
        const message = getSafeFriendRequestText(
            blockAppealParts.map(part => part.text).join('\n'),
            BLOCK_APPEAL_FALLBACK_MESSAGE
        );
        return {
            content: message || BLOCK_APPEAL_FALLBACK_MESSAGE,
            translation: blockAppealParts[0]?.translation || '',
            messages: blockAppealParts
        };
    } catch (error) {
        console.warn('[FriendRequests] block appeal message generation failed:', error);
        return {
            content: '',
            translation: '',
            messages: [],
            failed: true,
            error
        };
    }
}

export async function processBlockedByAiAppealUserRequest(char, request = null, options = {}) {
    if (!char?.id || request?.source !== BLOCK_APPEAL_USER_SOURCE || request.direction !== 'user_to_char') {
        return { decision: 'continue', skipped: true };
    }
    ensureFriendRequestState();
    const threadId = request.threadId || getFriendRequestThreadId(char, 'user_to_char', request);
    const threadMessages = getFriendRequestThreadMessages(threadId);
    let result;
    try {
        result = await requestFriendRequestAiDecision(char, 'user_to_char', request.message || '', threadMessages, {
            ...options,
            promptOptions: {
                ...(options.promptOptions || {}),
                friendRequestScenario: 'block_appeal_user'
            }
        });
    } catch (error) {
        console.warn('[FriendRequest] blocked-by-ai appeal decision failed:', error);
        return { decision: 'continue', error };
    }

    const responseBatchId = createId('frbatch');
    const messageParts = sanitizeFriendRequestMessageParts(
        Array.isArray(result.messages) && result.messages.length > 0
            ? result.messages
            : [{ text: result.content || '', translation: result.translation || '' }]
    );
    if (messageParts.length > 0) {
        const aiMessages = messageParts.map((part, index) => ({
            id: createId('frmsg'),
            sender: 'char',
            text: part.text,
            translation: part.translation || '',
            decision: result.decision,
            responseBatchId,
            createdAt: nowMs() + index,
            deletable: true
        }));
        AppState.friendRequestThreads[threadId] = [...threadMessages, ...aiMessages];
        await saveFriendRequestThreads();
    }

    if (result.decision === 'accept' && char.isBlockedByAi) {
        const acceptedRequest = await recordFriendRequestResult(char, 'accepted', 'user_to_char');
        await createFriendRequestChatCardMessage(char, acceptedRequest || request, 'accepted');
        char.isBlockedByAi = false;
        char.lastMainChatAiUnblockedAt = Date.now();
        await db.characterProfiles.update(char.id, { isBlockedByAi: false, lastMainChatAiUnblockedAt: char.lastMainChatAiUnblockedAt });
        window.dispatchEvent(new CustomEvent('looky:friend-request-updated', { detail: { charId: char.id } }));
    } else if (result.decision === 'reject') {
        await applyRelationshipScoreEvent(char, 'friend_request_reject', {
            requestId: request.id,
            source: BLOCK_APPEAL_USER_SOURCE,
            summary: '角色暂时拒绝了用户的好友验证请求'
        });
    }
    return { decision: result.decision, result };
}

export async function appendBlockAppealThreadMessage(request = {}, text = '', translation = '') {
    if (!request?.threadId || !text) return null;
    const parts = splitBlockAppealMessageParts(text, translation);
    const baseTime = nowMs();
    const appended = [];
    for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        const message = await appendFriendRequestThreadMessage(request.threadId, {
            id: createId(`frblock_${String(request.id || 'appeal')}`),
            sender: 'char',
            text: part.text,
            translation: part.translation || '',
            requestId: request.id,
            requestBubble: true,
            createdAt: baseTime + index,
            deletable: true
        });
        if (message) appended.push(message);
    }
    window.renderNewFriendsPage?.();
    window.dispatchEvent(new CustomEvent('looky:friend-request-updated', { detail: { charId: request.charId } }));
    return appended;
}

export function pruneExpiredFriendRequestRecords() {
    ensureFriendRequestState();
    const now = nowMs();
    const nextRequests = AppState.friendRequests.filter(request => {
        const status = request.status || 'pending';
        if (status === 'pending') return true;
        const resolvedAt = Number(request.resolvedAt || 0);
        return resolvedAt && now - resolvedAt <= FRIEND_REQUEST_RETENTION_MS;
    });
    const changed = nextRequests.length !== AppState.friendRequests.length;
    if (changed) AppState.friendRequests = nextRequests;
    return changed;
}

export async function createOrUpdateFriendRequest(char, direction, message = '', options = {}) {
    if (!char) return null;
    ensureFriendRequestState();
    const createdAt = nowMs();
    const existingIndex = AppState.friendRequests.findIndex(request => (
        String(request.charId) === String(char.id)
        && request.direction === direction
        && (request.status || 'pending') === 'pending'
    ));
    const existing = existingIndex >= 0 ? AppState.friendRequests[existingIndex] : null;
    const safeMessage = String(message || '').trim();
    const existingMessage = String(existing?.message || '').trim();
    const pendingMessage = String(char.pendingFriendRequestMessage || '').trim();
    const fallbackMessage = getInitialFriendRequestMessage(char, existing || {});
    const recordMessage = getSafeFriendRequestText(safeMessage, existingMessage)
        || getSafeFriendRequestText(pendingMessage, fallbackMessage)
        || fallbackMessage;
    const threadId = existing?.threadId || getFriendRequestThreadId(char, direction, existing);
    const requestRecord = {
        id: existing?.id || createId(`fr_${String(char.id)}_${direction}`),
        charId: char.id,
        direction,
        threadId,
        status: 'pending',
        message: recordMessage,
        createdAt: existing?.createdAt || createdAt,
        resolvedAt: null,
        retryAt: null,
        retryCount: Number(existing?.retryCount || 0),
        source: options.source || existing?.source || 'manual'
    };
    if (existingIndex >= 0) {
        AppState.friendRequests.splice(existingIndex, 1, requestRecord);
    } else {
        AppState.friendRequests.unshift(requestRecord);
        if (requestRecord.source !== 'retry') {
            await applyRelationshipScoreEvent(char, direction === 'user_to_char' ? 'user_friend_request' : 'char_friend_request', {
                requestId: requestRecord.id,
                source: requestRecord.source,
                summary: direction === 'user_to_char'
                    ? '用户主动发出好友申请'
                    : '角色主动发出好友申请'
            });
        }
    }
    await saveFriendRequestRecords();
    return requestRecord;
}

export async function recordFriendRequestResult(char, status, directionFallback) {
    if (!char) return null;
    ensureFriendRequestState();
    const now = nowMs();
    const direction = char.pendingFriendRequestDirection || directionFallback;
    const existingIndex = AppState.friendRequests.findIndex(request => (
        String(request.charId) === String(char.id)
        && request.direction === direction
        && (request.status || 'pending') === 'pending'
    ));
    const existing = existingIndex >= 0 ? AppState.friendRequests[existingIndex] : null;
    const retryCount = Number(existing?.retryCount || 0);
    const shouldRetry = status === 'rejected' && direction === 'char_to_user';
    const existingMessage = String(existing?.message || '').trim();
    const pendingMessage = String(char.pendingFriendRequestMessage || '').trim();
    const recordMessage = getSafeFriendRequestText(existingMessage, pendingMessage)
        || getInitialFriendRequestMessage(char, existing || {});
    const requestRecord = {
        id: existing?.id || createId(`fr_${String(char.id)}_${direction}`),
        charId: char.id,
        direction,
        threadId: existing?.threadId || getFriendRequestThreadId(char, direction, existing),
        status,
        message: recordMessage,
        createdAt: existing?.createdAt || now,
        resolvedAt: now,
        retryAt: shouldRetry ? now + RETRY_MIN_MS + Math.floor(Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS)) : null,
        retryCount: shouldRetry ? retryCount + 1 : retryCount,
        source: existing?.source || 'manual'
    };
    if (existingIndex >= 0) {
        AppState.friendRequests.splice(existingIndex, 1, requestRecord);
    } else {
        AppState.friendRequests.unshift(requestRecord);
    }
    if (status === 'accepted' || status === 'rejected') {
        await applyRelationshipScoreEvent(char, status === 'accepted' ? 'friend_request_accept' : 'friend_request_reject', {
            requestId: requestRecord.id,
            source: requestRecord.source,
            summary: status === 'accepted' ? '好友申请被接受' : '好友申请被拒绝'
        });
    }
    pruneExpiredFriendRequestRecords();
    await saveFriendRequestRecords();
    return requestRecord;
}

export function getFriendRequestItems(direction, statuses = ['pending']) {
    const changed = pruneExpiredFriendRequestRecords();
    if (changed) saveFriendRequestRecords().catch(error => console.warn('[FriendRequests] prune failed:', error));
    return AppState.friendRequests.filter(request => {
        const status = request.status || 'pending';
        return request.direction === direction && statuses.includes(status);
    });
}

export async function appendFriendRequestThreadMessage(threadId, message) {
    if (!threadId || !message?.text) return null;
    ensureFriendRequestState();
    const nextMessage = {
        id: message.id || createId('frmsg'),
        sender: message.sender || 'user',
        text: message.text,
        translation: message.translation || '',
        requestId: message.requestId || null,
        requestBubble: message.requestBubble === true,
        createdAt: message.createdAt || nowMs(),
        deletable: message.deletable !== false
    };
    AppState.friendRequestThreads[threadId] = [...getFriendRequestThreadMessages(threadId), nextMessage];
    await saveFriendRequestThreads();
    return nextMessage;
}

function compactFriendRequestText(text, maxLength = 180) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function buildFriendRequestTranscript(threadId, char = {}) {
    const messages = getFriendRequestThreadMessages(threadId)
        .filter(message => message && message.text)
        .filter(message => !isFriendRequestMetaReplyText(message.text) && !looksLikeFriendRequestJsonFragment(message.text))
        .slice(-20);
    return messages.map(message => {
        const sender = message.sender === 'char'
            ? (char.nickname || char.name || 'Ta')
            : (message.sender === 'system' ? '系统' : '你');
        return {
            id: message.id,
            sender: message.sender || 'user',
            senderName: sender,
            text: compactFriendRequestText(message.text),
            translation: compactFriendRequestText(message.translation || '', 120),
            createdAt: message.createdAt || null
        };
    });
}

export async function processDueFriendRequestRetries(characters = []) {
    ensureFriendRequestState();
    const now = nowMs();
    const retried = [];
    for (const request of AppState.friendRequests) {
        if (isBlockAppealRequest(request)) continue;
        if (request.status !== 'rejected' || request.direction !== 'char_to_user') continue;
        if (!request.retryAt || Number(request.retryAt) > now) continue;
        const char = characters.find(item => String(item.id) === String(request.charId));
        if (!char || char.relationStage === 'friend' || char.hasChat === true) continue;
        const threadMessages = getFriendRequestThreadMessages(request.threadId || getFriendRequestThreadId(char, 'received', request));
        const decision = await requestFriendRequestRetryDecision(char, request, threadMessages);
        const retryMessages = sanitizeFriendRequestMessageParts(
            Array.isArray(decision.messages) && decision.messages.length > 0
                ? decision.messages
                : [{ text: decision.content || '' }]
        );
        const message = retryMessages.map(item => item.text).join('\n') || getInitialFriendRequestMessage(char, request);
        const nextRequest = await createOrUpdateFriendRequest(char, 'char_to_user', message, { source: 'retry' });
        Object.assign(char, {
            inContacts: true,
            relationStage: 'pending_char',
            hasChat: false,
            requiresFriendRequest: true,
            requiresOfflineMeet: false,
            pendingFriendRequestDirection: 'char_to_user',
            pendingFriendRequestMessage: message,
            pendingPreviousRelationStage: char.relationStage || 'library',
            pendingPreviousInContacts: char.inContacts !== false
        });
        if (retryMessages.length > 0) {
            const threadId = nextRequest.threadId || getFriendRequestThreadId(char, 'received', nextRequest);
            const existingMessages = getFriendRequestThreadMessages(threadId);
            if (!existingMessages.some(item => String(item.requestId || '') === String(nextRequest.id))) {
                const baseCreatedAt = nextRequest.createdAt || nowMs();
                const threadAppend = retryMessages.map((part, index) => ({
                    id: index === 0 ? `frreq_${String(nextRequest.id)}` : `frreq_${String(nextRequest.id)}_${index}`,
                    sender: 'char',
                    text: part.text,
                    translation: part.translation || '',
                    requestId: nextRequest.id,
                    requestBubble: true,
                    createdAt: baseCreatedAt + index,
                    deletable: false
                }));
                AppState.friendRequestThreads[threadId] = [...existingMessages, ...threadAppend]
                    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
                await saveFriendRequestThreads();
            }
        }
        request.retryAt = null;
        retried.push({ char, request: nextRequest });
    }
    if (retried.length > 0) await saveFriendRequestRecords();
    return retried;
}

export async function createFriendRequestChatCardMessage(char, request = null, status = 'accepted') {
    if (!char?.id) return null;
    const title = status === 'accepted' ? '好友验证前情记录' : '好友申请记录';
    const message = request?.message || char.pendingFriendRequestMessage || '你们已经成为好友。';
    const direction = request?.direction || char.pendingFriendRequestDirection || 'char_to_user';
    const threadId = request?.threadId || getFriendRequestThreadId(char, direction, request);
    const transcript = buildFriendRequestTranscript(threadId, char);
    const summary = transcript.length
        ? transcript.slice(-4).map(item => `${item.senderName}：${item.text}`).join(' / ')
        : compactFriendRequestText(message, 120);
    const cardData = {
        title,
        message,
        direction,
        status,
        avatar: char.avatar || DEFAULT_AVATAR_SRC,
        threadId,
        transcript,
        summary,
        contextNote: '这是好友通过前的验证窗口历史，只能作为关系前情读取；不是当前主聊天里刚刚发生的对话。'
    };
    const msg = {
        chatId: char.id,
        type: 'received',
        text: `[好友验证前情记录] ${summary}`,
        content: cardData,
        contentType: 'friend_request_card',
        timestamp: new Date().toISOString(),
        aiVisible: true,
        uiVisible: true
    };
    const id = await db.chatMessages.add(msg);
    msg.id = id;
    if (String(tempState.currentChatId) === String(char.id)) {
        AppState.currentChatHistory?.push?.(msg);
    }
    return msg;
}
