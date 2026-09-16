import { db } from '../state.js';

export const RELATIONSHIP_SCORE_EVENTS = Object.freeze({
    offline_session: 8,
    user_friend_request: 5,
    char_friend_request: 10,
    friend_request_accept: 20,
    friend_request_reject: -5,
    good_vibe: 5,
    cold_scene: -5,
    ai_suggested: 0
});

const AI_RELATIONSHIP_DELTA_LIMIT = 5;

const RELATIONSHIP_EVENT_LABELS = Object.freeze({
    offline_session: '线下见面',
    user_friend_request: '用户发出好友申请',
    char_friend_request: '角色发出好友申请',
    friend_request_accept: '好友申请通过',
    friend_request_reject: '好友申请拒绝',
    good_vibe: '氛围升温',
    cold_scene: '关系冷场',
    ai_suggested: 'AI关系建议'
});

function clampNumber(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(min, Math.min(max, Math.round(number)));
}

export function getRelationshipStageByScore(score) {
    const value = Math.max(0, Math.min(100, Number(score) || 0));
    if (value >= 81) return '亲近';
    if (value >= 61) return '熟悉';
    if (value >= 41) return '普通朋友';
    if (value >= 21) return '见过几面';
    return '陌生';
}

export function clampRelationshipDelta(delta, limit = AI_RELATIONSHIP_DELTA_LIMIT) {
    const safeLimit = Math.max(0, Number(limit) || AI_RELATIONSHIP_DELTA_LIMIT);
    return clampNumber(delta, -safeLimit, safeLimit);
}

export async function applyRelationshipScoreEvent(char, eventType, options = {}) {
    if (!char?.id || !Object.prototype.hasOwnProperty.call(RELATIONSHIP_SCORE_EVENTS, eventType)) return null;
    const existingEvents = Array.isArray(char.relationshipEvents) ? char.relationshipEvents : [];
    if (options.sessionId && existingEvents.some(event => event?.type === eventType && String(event.sessionId || '') === String(options.sessionId))) {
        return null;
    }
    if (options.requestId && existingEvents.some(event => event?.type === eventType && String(event.requestId || '') === String(options.requestId))) {
        return null;
    }
    const before = Math.max(0, Math.min(100, Number(char.familiarity) || 0));
    const baseDelta = RELATIONSHIP_SCORE_EVENTS[eventType];
    const aiDelta = clampRelationshipDelta(options.relationshipDelta || 0);
    const delta = baseDelta + aiDelta;
    if (delta === 0 && !options.forceRecord) return null;

    const after = Math.max(0, Math.min(100, before + delta));
    const event = {
        id: `rel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: eventType,
        title: options.title || RELATIONSHIP_EVENT_LABELS[eventType] || '关系事件',
        summary: options.summary || `熟悉度 ${before} -> ${after}`,
        baseDelta,
        aiDelta,
        delta,
        before,
        after,
        stageBefore: getRelationshipStageByScore(before),
        stageAfter: getRelationshipStageByScore(after),
        source: options.source || 'system',
        requestId: options.requestId || null,
        sessionId: options.sessionId || null,
        createdAt: Date.now()
    };
    const relationshipEvents = [...existingEvents, event];

    char.familiarity = after;
    char.relationshipEvents = relationshipEvents;
    await db.characterProfiles.update(char.id, { familiarity: after, relationshipEvents });
    return event;
}
