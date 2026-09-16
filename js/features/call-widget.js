import { DEFAULT_AVATAR_SRC } from '../state.js';
import { isValidAvatarSrc } from '../utils.js';

let callWidgetEl = null;
let callWidgetAvatarEl = null;
let callWidgetTitleEl = null;
let callWidgetSubtitleEl = null;
let callWidgetTimerEl = null;
let callWidgetCompactBtn = null;
let callWidgetCompactLabelEl = null;
let callWidgetCompactTimerEl = null;
let callWidgetCompactDotEl = null;
let callWidgetPanelEl = null;
let callWidgetMessageListEl = null;
let callWidgetInputEl = null;
let callWidgetSendBtn = null;
let callWidgetCollapseBtn = null;
let callWidgetRestoreBtn = null;
let callWidgetHangUpBtn = null;
let callWidgetRegenerateBtn = null;
let callWidgetDeleteBtn = null;
let callWidgetDragHandleEl = null;

const callWidgetState = {
    onRestore: null,
    onHangUp: null,
    onRegenerate: null,
    onDelete: null,
    onSendText: null,
    onDraftChange: null,
};

let callWidgetExpanded = false;
let callWidgetMode = 'voice';
let callWidgetPosition = null;
let dragState = null;
let compactClickBlockedUntil = 0;
let callWidgetMessageObserver = null;
let callWidgetMessageSyncRaf = 0;
let callWidgetMessageSyncPaused = false;
let callWidgetGenerating = false;
const COMPACT_WIDGET_WIDTH = 78;
const WIDGET_EDGE_MARGIN = 8;

function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
}

function getWidgetDragRect() {
    const target = callWidgetExpanded ? callWidgetPanelEl : callWidgetCompactBtn;
    return (target || callWidgetEl)?.getBoundingClientRect();
}

function updateWidgetEdge(rect) {
    if (!callWidgetEl || !rect) return false;
    const compactLeft = callWidgetExpanded && callWidgetEl.classList.contains('edge-right')
        ? rect.right - COMPACT_WIDGET_WIDTH
        : rect.left;
    const compactTop = callWidgetExpanded && callWidgetEl.classList.contains('edge-bottom')
        ? rect.bottom - COMPACT_WIDGET_WIDTH
        : rect.top;
    const onRight = compactLeft + COMPACT_WIDGET_WIDTH / 2 >= window.innerWidth / 2;
    const onBottom = compactTop + COMPACT_WIDGET_WIDTH / 2 >= window.innerHeight / 2;
    callWidgetEl.classList.toggle('edge-right', onRight);
    callWidgetEl.classList.toggle('edge-left', !onRight);
    callWidgetEl.classList.toggle('edge-bottom', onBottom);
    callWidgetEl.classList.toggle('edge-top', !onBottom);
    return { onRight, onBottom };
}

function getWidgetAnchorLeft(rect, onRight = callWidgetEl?.classList.contains('edge-right')) {
    if (callWidgetExpanded && onRight) return rect.right - COMPACT_WIDGET_WIDTH;
    return rect.left;
}

function getWidgetAnchorTop(rect, onBottom = callWidgetEl?.classList.contains('edge-bottom')) {
    if (callWidgetExpanded && onBottom) return rect.bottom - COMPACT_WIDGET_WIDTH;
    return rect.top;
}

function syncCallWidgetMessages() {
    if (!callWidgetMessageListEl || callWidgetMessageSyncPaused) return;
    const voiceCallList = document.getElementById('voice-call-message-list');
    if (!voiceCallList) {
        callWidgetMessageListEl.replaceChildren();
        return;
    }

    const sourceItems = Array.from(voiceCallList.children).slice(-18);
    const fragment = document.createDocumentFragment();
    sourceItems.forEach((item) => {
        if (item.id === 'typing-indicator' || item.querySelector('.typing-indicator')) return;
        const clonedItem = item.cloneNode(true);
        if (clonedItem.id) clonedItem.removeAttribute('id');
        clonedItem.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
        clonedItem.querySelectorAll('.call-history-tts-btn').forEach((button) => button.remove());
        fragment.appendChild(clonedItem);
    });
    callWidgetMessageListEl.replaceChildren(fragment);
    if (callWidgetGenerating) {
        const typingWrapper = document.createElement('div');
        typingWrapper.className = 'message-wrapper received call-widget-typing-wrapper';
        typingWrapper.innerHTML = `
            <div class="message-bubble typing-indicator voice-call-typing call-widget-typing" aria-label="正在生成回复">
                <span></span><span></span><span></span>
            </div>
        `;
        callWidgetMessageListEl.appendChild(typingWrapper);
    }
    callWidgetMessageListEl.scrollTop = callWidgetMessageListEl.scrollHeight;
}

function scheduleCallWidgetMessageSync() {
    if (callWidgetMessageSyncRaf) return;
    callWidgetMessageSyncRaf = requestAnimationFrame(() => {
        callWidgetMessageSyncRaf = 0;
        syncCallWidgetMessages();
    });
}

function startCallWidgetMessageObserver() {
    if (callWidgetMessageObserver || !callWidgetMessageListEl) return;
    const voiceCallList = document.getElementById('voice-call-message-list');
    if (!voiceCallList || typeof MutationObserver === 'undefined') {
        if (callWidgetExpanded) syncCallWidgetMessages();
        return;
    }
    callWidgetMessageObserver = new MutationObserver((mutations) => {
        let hasIncomingMessage = false;
        let hasMessageChange = false;
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType !== Node.ELEMENT_NODE) return;
                const isTypingNode = node.matches('.typing-indicator, #typing-indicator')
                    || node.querySelector('.typing-indicator, #typing-indicator');
                if (node.matches('.call-log-entry, .message-wrapper')
                    || node.querySelector('.call-log-entry, .message-wrapper')) {
                    if (isTypingNode) return;
                    hasMessageChange = true;
                }
                if (node.matches('.call-log-entry.received, .message-wrapper.received')
                    || node.querySelector('.call-log-entry.received, .message-wrapper.received')) {
                    if (isTypingNode) return;
                    hasIncomingMessage = true;
                }
            });
            mutation.removedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE
                    && (node.matches('.call-log-entry, .message-wrapper')
                        || node.querySelector('.call-log-entry, .message-wrapper'))) {
                    hasMessageChange = true;
                }
            });
        });
        if (hasIncomingMessage && !callWidgetExpanded) {
            setCallWidgetAttentionVisible(true);
        }
        if (callWidgetExpanded && hasMessageChange) scheduleCallWidgetMessageSync();
    });
    callWidgetMessageObserver.observe(voiceCallList, { childList: true });
    if (callWidgetExpanded) syncCallWidgetMessages();
}

function stopCallWidgetMessageObserver() {
    callWidgetMessageObserver?.disconnect();
    callWidgetMessageObserver = null;
    if (callWidgetMessageSyncRaf) {
        cancelAnimationFrame(callWidgetMessageSyncRaf);
        callWidgetMessageSyncRaf = 0;
    }
}

function setWidgetExpanded(nextExpanded, focusInput = false) {
    if (!callWidgetEl) return;
    if (callWidgetExpanded !== Boolean(nextExpanded)) {
        const rect = callWidgetEl.getBoundingClientRect();
        if (rect && rect.width > 0 && rect.height > 0) {
            const edges = updateWidgetEdge(rect);
            let anchorLeft, anchorTop;
            if (callWidgetExpanded) {
                anchorLeft = edges.onRight ? rect.right - COMPACT_WIDGET_WIDTH : rect.left;
                anchorTop = edges.onBottom ? rect.bottom - COMPACT_WIDGET_WIDTH : rect.top;
                anchorLeft = clamp(
                    anchorLeft,
                    WIDGET_EDGE_MARGIN,
                    Math.max(WIDGET_EDGE_MARGIN, window.innerWidth - WIDGET_EDGE_MARGIN - COMPACT_WIDGET_WIDTH)
                );
                anchorTop = clamp(
                    anchorTop,
                    WIDGET_EDGE_MARGIN,
                    Math.max(WIDGET_EDGE_MARGIN, window.innerHeight - WIDGET_EDGE_MARGIN - COMPACT_WIDGET_WIDTH)
                );
            } else {
                anchorLeft = rect.left;
                anchorTop = rect.top;
            }
            callWidgetPosition = { left: anchorLeft, top: anchorTop };
            callWidgetEl.style.left = `${anchorLeft}px`;
            callWidgetEl.style.top = `${anchorTop}px`;
            callWidgetEl.style.right = 'auto';
            callWidgetEl.style.bottom = 'auto';
            callWidgetEl.style.transform = '';
        }
    }
    callWidgetExpanded = Boolean(nextExpanded);
    if (!callWidgetExpanded) {
        const active = document.activeElement;
        if (active && callWidgetEl.contains(active) && typeof active.blur === 'function') {
            active.blur();
        }
    }
    callWidgetEl.dataset.state = callWidgetExpanded ? 'expanded' : 'compact';
    callWidgetEl.classList.toggle('is-expanded', callWidgetExpanded);
    callWidgetEl.classList.toggle('is-compact', !callWidgetExpanded);
    callWidgetEl.classList.toggle('is-dragging', false);
    callWidgetCompactBtn?.setAttribute('aria-expanded', String(callWidgetExpanded));
    callWidgetPanelEl?.setAttribute('aria-hidden', String(!callWidgetExpanded));
    if (callWidgetPanelEl) callWidgetPanelEl.hidden = !callWidgetExpanded;
    if (callWidgetCompactBtn) callWidgetCompactBtn.hidden = callWidgetExpanded;
    if (callWidgetExpanded) {
        callWidgetEl.style.visibility = 'hidden';
        const expandedRect = callWidgetPanelEl?.getBoundingClientRect();
        if (expandedRect && expandedRect.height > 0) {
            let adjustedLeft = callWidgetPosition?.left ?? expandedRect.left;
            let adjustedTop = callWidgetPosition?.top ?? expandedRect.top;
            if (expandedRect.left < WIDGET_EDGE_MARGIN) {
                adjustedLeft += WIDGET_EDGE_MARGIN - expandedRect.left;
            } else if (expandedRect.right > window.innerWidth - WIDGET_EDGE_MARGIN) {
                adjustedLeft -= expandedRect.right - (window.innerWidth - WIDGET_EDGE_MARGIN);
            }
            if (expandedRect.top < WIDGET_EDGE_MARGIN) {
                adjustedTop += WIDGET_EDGE_MARGIN - expandedRect.top;
            } else if (expandedRect.bottom > window.innerHeight - WIDGET_EDGE_MARGIN) {
                adjustedTop -= expandedRect.bottom - (window.innerHeight - WIDGET_EDGE_MARGIN);
            }
            if (adjustedLeft !== callWidgetPosition?.left || adjustedTop !== callWidgetPosition?.top) {
                adjustedLeft = Math.max(WIDGET_EDGE_MARGIN, adjustedLeft);
                adjustedTop = Math.max(WIDGET_EDGE_MARGIN, adjustedTop);
                callWidgetPosition = { left: adjustedLeft, top: adjustedTop };
                callWidgetEl.style.left = `${adjustedLeft}px`;
                callWidgetEl.style.top = `${adjustedTop}px`;
            }
        }
        callWidgetEl.style.visibility = '';
        startCallWidgetMessageObserver();
        syncCallWidgetMessages();
        setCallWidgetAttentionVisible(false);
    } else {
        startCallWidgetMessageObserver();
    }
    if (callWidgetExpanded && focusInput) {
        requestAnimationFrame(() => {
            callWidgetInputEl?.focus({ preventScroll: true });
        });
    }
}

function setWidgetVisible(isVisible) {
    if (!callWidgetEl) return;
    if (!isVisible) {
        const active = document.activeElement;
        if (active && callWidgetEl.contains(active) && typeof active.blur === 'function') {
            active.blur();
        }
    }
    callWidgetEl.style.display = isVisible ? 'flex' : 'none';
    callWidgetEl.setAttribute('aria-hidden', String(!isVisible));
    if ('inert' in callWidgetEl) {
        callWidgetEl.inert = !isVisible;
    }
}

function updateCompactCopy() {
    if (!callWidgetCompactLabelEl || !callWidgetMode) return;
    const subtitle = callWidgetSubtitleEl?.textContent || '';
    if (subtitle.includes('等待')) {
        callWidgetCompactLabelEl.textContent = '等待接听';
    } else if (subtitle.includes('通话中')) {
        callWidgetCompactLabelEl.textContent = '通话中';
    } else {
        callWidgetCompactLabelEl.textContent = subtitle;
    }
    callWidgetCompactBtn?.setAttribute(
        'aria-label',
        callWidgetMode === 'video' ? '展开视频通话小窗' : '展开语音通话小窗'
    );
}

export function setCallWidgetAttentionVisible(isVisible) {
    if (!callWidgetCompactDotEl) return;
    callWidgetCompactDotEl.hidden = !isVisible;
}

export function setCallMiniWidgetGenerating(isGenerating) {
    callWidgetGenerating = Boolean(isGenerating);
    if (callWidgetExpanded) syncCallWidgetMessages();
}

function handleDraftInput() {
    if (!callWidgetInputEl) return;
    callWidgetState.onDraftChange?.(callWidgetInputEl.value);
}

function submitWidgetText() {
    if (!callWidgetInputEl) return;
    const draftText = callWidgetInputEl.value;
    const trimmedText = draftText.trim();
    if (!trimmedText) return;
    if (typeof callWidgetState.onSendText !== 'function') return;
    callWidgetInputEl.value = '';
    callWidgetState.onDraftChange?.('');
    Promise.resolve(callWidgetState.onSendText(draftText))
        .then((ok) => {
            if (ok === false) {
                callWidgetInputEl.value = draftText;
                callWidgetState.onDraftChange?.(draftText);
            }
        })
        .catch(() => {
            callWidgetInputEl.value = draftText;
            callWidgetState.onDraftChange?.(draftText);
        });
}

function beginDrag(source, event) {
    if (!callWidgetEl) return;
    if (event.button !== undefined && event.button !== 0) return;
    if (source !== 'compact' && event.pointerType === 'mouse' && event.target.closest('button, textarea, input, select, option, a')) {
        return;
    }
    window.getSelection?.()?.removeAllRanges();

    const rect = getWidgetDragRect();
    if (!rect) return;
    dragState = {
        source,
        pointerId: event.pointerId ?? null,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top,
        currentLeft: rect.left,
        currentTop: rect.top,
        width: rect.width,
        height: rect.height,
        dragged: false,
        rafId: 0,
    };
    callWidgetEl.style.transition = 'none';

    document.addEventListener('pointermove', handleDragMove, { passive: false });
    document.addEventListener('pointerup', handleDragEnd, { passive: false });
    document.addEventListener('pointercancel', handleDragEnd, { passive: false });
}

function handleDragMove(event) {
    if (!dragState) return;
    if (dragState.pointerId !== null && event.pointerId !== dragState.pointerId) return;
    event.preventDefault();

    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
     if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) {
        if (!dragState.dragged) {
            const onRight = callWidgetEl.classList.contains('edge-right');
            const onBottom = callWidgetEl.classList.contains('edge-bottom');
            const freshRect = getWidgetDragRect();
            if (freshRect) {
                const anchorLeft = getWidgetAnchorLeft(freshRect, onRight);
                const anchorTop = getWidgetAnchorTop(freshRect, onBottom);
                callWidgetEl.style.left = `${anchorLeft}px`;
                callWidgetEl.style.top = `${anchorTop}px`;
                callWidgetEl.style.right = 'auto';
                callWidgetEl.style.bottom = 'auto';
            }
            callWidgetEl.classList.add('is-dragging');
            callWidgetMessageSyncPaused = true;
            stopCallWidgetMessageObserver();
            callWidgetEl.style.transition = 'none';
        }
        dragState.dragged = true;
    }
    dragState.currentLeft = dragState.startLeft + deltaX;
    dragState.currentTop = dragState.startTop + deltaY;

    if (dragState.rafId) return;
    dragState.rafId = requestAnimationFrame(() => {
        dragState.rafId = 0;
        const maxLeft = Math.max(0, window.innerWidth - dragState.width - 8);
        const maxTop = Math.max(0, window.innerHeight - dragState.height - 8);
        const nextLeft = clamp(dragState.currentLeft, 8, maxLeft);
        const nextTop = clamp(dragState.currentTop, 8, maxTop);
        callWidgetEl.style.transform = `translate3d(${nextLeft - dragState.startLeft}px, ${nextTop - dragState.startTop}px, 0)`;
    });
}

function handleDragEnd(event) {
    if (!dragState) return;
    if (dragState.pointerId !== null && event.pointerId !== dragState.pointerId) return;

    if (dragState.rafId) {
        cancelAnimationFrame(dragState.rafId);
        dragState.rafId = 0;
    }
    if (!dragState.dragged) {
        callWidgetEl.style.transition = '';
        document.removeEventListener('pointermove', handleDragMove);
        document.removeEventListener('pointerup', handleDragEnd);
        document.removeEventListener('pointercancel', handleDragEnd);
        if (dragState.source === 'compact') {
            compactClickBlockedUntil = Date.now() + 420;
            setWidgetExpanded(true, true);
        }
        dragState = null;
        return;
    }
    const finalLeft = clamp(dragState.currentLeft, 8, Math.max(0, window.innerWidth - dragState.width - 8));
    const finalTop = clamp(dragState.currentTop, 8, Math.max(0, window.innerHeight - dragState.height - 8));
    const finalRect = {
        left: finalLeft,
        top: finalTop,
        width: dragState.width,
        height: dragState.height,
        right: finalLeft + dragState.width,
    };
    const edges = updateWidgetEdge(finalRect);
    const anchorLeft = callWidgetExpanded && edges.onRight
        ? finalRect.right - COMPACT_WIDGET_WIDTH
        : finalLeft;
    const anchorTop = callWidgetExpanded && edges.onBottom
        ? finalRect.bottom - COMPACT_WIDGET_WIDTH
        : finalTop;
    callWidgetPosition = { left: anchorLeft, top: anchorTop };
    callWidgetEl.style.transform = '';
    callWidgetEl.style.left = `${anchorLeft}px`;
    callWidgetEl.style.top = `${anchorTop}px`;
    callWidgetEl.style.transition = '';
    callWidgetEl.classList.remove('is-dragging');
    callWidgetMessageSyncPaused = false;
    if (callWidgetExpanded) {
        startCallWidgetMessageObserver();
        scheduleCallWidgetMessageSync();
    } else {
        startCallWidgetMessageObserver();
    }
    compactClickBlockedUntil = Date.now() + 220;
    setTimeout(() => {
        if (compactClickBlockedUntil && Date.now() >= compactClickBlockedUntil) {
            compactClickBlockedUntil = 0;
        }
    }, 180);
    document.removeEventListener('pointermove', handleDragMove);
    document.removeEventListener('pointerup', handleDragEnd);
    document.removeEventListener('pointercancel', handleDragEnd);
    dragState = null;
}

function ensureCallWidget() {
    if (callWidgetEl) return callWidgetEl;

    callWidgetEl = document.createElement('div');
    callWidgetEl.id = 'global-call-widget';
    callWidgetEl.className = 'global-call-widget edge-right is-compact';
    callWidgetEl.style.display = 'none';
    callWidgetEl.setAttribute('aria-hidden', 'true');
    if ('inert' in callWidgetEl) {
        callWidgetEl.inert = true;
    }
    callWidgetEl.innerHTML = `
        <button type="button" class="call-widget-compact" aria-expanded="false">
            <span class="call-widget-compact-icon voice" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.978.978 0 0 0-1.01.24l-1.57 1.57c-2.83-1.35-5.48-3.9-6.89-6.83l1.57-1.57c.27-.27.36-.66.25-1.01C8.2 6.2 8.01 5.01 8.01 3.78c0-.54-.45-.99-.99-.99H3.51c-.54 0-.99.45-.99.99 0 9.28 7.72 17 17 17 .54 0 .99-.45.99-.99v-3.51c0-.54-.45-.99-.99-.99z"></path></svg>
            </span>
            <span class="call-widget-compact-icon video" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M15 8v8H5V8h10m1-2H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4V7c0-.55-.45-1-1-1z"></path></svg>
            </span>
            <span class="call-widget-compact-label"></span>
            <span class="call-widget-compact-timer">00:00</span>
            <span class="call-widget-compact-dot" aria-hidden="true"></span>
        </button>
        <section class="call-widget-panel" aria-hidden="true" hidden>
            <div class="call-widget-drag-handle" aria-hidden="true"></div>
            <header class="call-widget-panel-head">
                <div class="call-widget-panel-main">
                    <img class="call-widget-avatar" src="${DEFAULT_AVATAR_SRC}" alt="call avatar">
                    <div class="call-widget-copy">
                        <div class="call-widget-title"></div>
                        <div class="call-widget-subtitle"></div>
                    </div>
                    <div class="call-widget-timer">00:00</div>
                </div>
                <div class="call-widget-panel-actions">
                    <button type="button" class="call-widget-btn collapse" title="收起小窗" aria-label="收起小窗">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 12h9"></path></svg>
                    </button>
                </div>
            </header>
            <div class="call-widget-message-list" aria-live="polite"></div>
            <div class="call-widget-input-row">
                <textarea class="call-widget-input" rows="2" placeholder="在此输入消息..."></textarea>
                <button type="button" class="call-widget-send-btn" title="发送消息" aria-label="发送消息">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path></svg>
                </button>
            </div>
            <div class="call-widget-actions">
                <button type="button" class="call-widget-btn restore" title="恢复通话">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path></svg>
                </button>
                <div class="call-widget-action-tools">
                    <button type="button" class="call-widget-btn regenerate" title="重新生成上一条回复" aria-label="重新生成上一条回复">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0 2 5"></path><path d="M20 4v7h-7"></path></svg>
                    </button>
                    <button type="button" class="call-widget-btn delete" title="删除最近一轮通话消息" aria-label="删除最近一轮通话消息">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M10 11v6M14 11v6"></path><path d="M6 7l1 13h10l1-13M9 7V4h6v3"></path></svg>
                    </button>
                </div>
                <button type="button" class="call-widget-btn hang-up" title="挂断通话">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.978.978 0 0 0-1.01.24l-1.57 1.57c-2.83-1.35-5.48-3.9-6.89-6.83l1.57-1.57c.27-.27.36-.66.25-1.01C8.2 6.2 8.01 5.01 8.01 3.78c0-.54-.45-.99-.99-.99H3.51c-.54 0-.99.45-.99.99 0 9.28 7.72 17 17 17 .54 0 .99-.45.99-.99v-3.51c0-.54-.45-.99-.99-.99z"></path></svg>
                </button>
            </div>
        </section>
    `;

    document.body.appendChild(callWidgetEl);

    callWidgetCompactBtn = callWidgetEl.querySelector('.call-widget-compact');
    callWidgetCompactLabelEl = callWidgetEl.querySelector('.call-widget-compact-label');
    callWidgetCompactTimerEl = callWidgetEl.querySelector('.call-widget-compact-timer');
    callWidgetCompactDotEl = callWidgetEl.querySelector('.call-widget-compact-dot');
    callWidgetPanelEl = callWidgetEl.querySelector('.call-widget-panel');
    callWidgetMessageListEl = callWidgetEl.querySelector('.call-widget-message-list');
    callWidgetAvatarEl = callWidgetEl.querySelector('.call-widget-avatar');
    callWidgetTitleEl = callWidgetEl.querySelector('.call-widget-title');
    callWidgetSubtitleEl = callWidgetEl.querySelector('.call-widget-subtitle');
    callWidgetTimerEl = callWidgetEl.querySelector('.call-widget-timer');
    callWidgetInputEl = callWidgetEl.querySelector('.call-widget-input');
    callWidgetSendBtn = callWidgetEl.querySelector('.call-widget-send-btn');
    callWidgetCollapseBtn = callWidgetEl.querySelector('.call-widget-btn.collapse');
    callWidgetRestoreBtn = callWidgetEl.querySelector('.call-widget-btn.restore');
    callWidgetRegenerateBtn = callWidgetEl.querySelector('.call-widget-btn.regenerate');
    callWidgetDeleteBtn = callWidgetEl.querySelector('.call-widget-btn.delete');
    callWidgetHangUpBtn = callWidgetEl.querySelector('.call-widget-btn.hang-up');
    callWidgetDragHandleEl = callWidgetEl.querySelector('.call-widget-drag-handle');
    setCallWidgetAttentionVisible(false);

    callWidgetCompactBtn?.addEventListener('click', (event) => {
        if (Date.now() < compactClickBlockedUntil) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        setWidgetExpanded(true, true);
    });
    callWidgetEl.addEventListener('pointerdown', (event) => {
        if (callWidgetExpanded) return;
        beginDrag('compact', event);
    });
    callWidgetCompactBtn?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setWidgetExpanded(true, true);
        }
    });

    callWidgetDragHandleEl?.addEventListener('pointerdown', (event) => beginDrag('panel', event));
    callWidgetInputEl?.addEventListener('input', handleDraftInput);
    callWidgetInputEl?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submitWidgetText();
        }
    });
    callWidgetSendBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        submitWidgetText();
    });
    callWidgetCollapseBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        setWidgetExpanded(false, false);
    });
    callWidgetRestoreBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        callWidgetState.onRestore?.();
    });
    callWidgetRegenerateBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        callWidgetState.onRegenerate?.();
    });
    callWidgetDeleteBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        callWidgetState.onDelete?.();
    });
    callWidgetHangUpBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        callWidgetState.onHangUp?.();
    });

    setWidgetExpanded(false, false);
    updateCompactCopy();
    return callWidgetEl;
}

export function updateCallMiniWidget(options = {}) {
    const widget = ensureCallWidget();
    if (options.mode) {
        callWidgetMode = options.mode;
        widget.dataset.mode = options.mode;
    }
    if (Object.prototype.hasOwnProperty.call(options, 'expanded')) {
        setWidgetExpanded(Boolean(options.expanded), Boolean(options.focusInput));
    }
    if (Object.prototype.hasOwnProperty.call(options, 'avatarSrc')) {
        const nextAvatarSrc = typeof options.avatarSrc === 'string' && isValidAvatarSrc(options.avatarSrc)
            ? options.avatarSrc
            : DEFAULT_AVATAR_SRC;
        callWidgetAvatarEl.src = nextAvatarSrc;
    }
    if (typeof options.title === 'string') callWidgetTitleEl.textContent = options.title;
    if (typeof options.subtitle === 'string') {
        callWidgetSubtitleEl.textContent = options.subtitle;
        callWidgetCompactLabelEl.textContent = options.subtitle;
    }
    if (typeof options.timer === 'string') {
        callWidgetTimerEl.textContent = options.timer;
        callWidgetCompactTimerEl.textContent = options.timer;
    }
    if (Object.prototype.hasOwnProperty.call(options, 'inputValue') && typeof options.inputValue === 'string') {
        callWidgetInputEl.value = options.inputValue;
    }
    if (typeof options.placeholder === 'string') {
        callWidgetInputEl.placeholder = options.placeholder;
    }
    if (typeof options.onRestore === 'function') callWidgetState.onRestore = options.onRestore;
    if (typeof options.onHangUp === 'function') callWidgetState.onHangUp = options.onHangUp;
    if (typeof options.onRegenerate === 'function') callWidgetState.onRegenerate = options.onRegenerate;
    if (typeof options.onDelete === 'function') callWidgetState.onDelete = options.onDelete;
    if (typeof options.onSendText === 'function') callWidgetState.onSendText = options.onSendText;
    if (typeof options.onDraftChange === 'function') callWidgetState.onDraftChange = options.onDraftChange;
    updateCompactCopy();
    return widget;
}

export function showCallMiniWidget(options = {}) {
    const widget = updateCallMiniWidget(options);
    setWidgetVisible(true);
    startCallWidgetMessageObserver();
    return widget;
}

export function hideCallMiniWidget(options = {}) {
    if (!callWidgetEl) return;
    const clearDraft = options.clearDraft !== false;
    if (clearDraft && callWidgetInputEl) {
        callWidgetInputEl.value = '';
        callWidgetState.onDraftChange?.('');
    }
    callWidgetExpanded = false;
    callWidgetEl.dataset.state = 'compact';
    callWidgetEl.classList.remove('is-expanded');
    callWidgetEl.classList.add('is-compact');
    if (callWidgetPanelEl) callWidgetPanelEl.hidden = true;
    if (callWidgetCompactBtn) callWidgetCompactBtn.hidden = false;
    setCallWidgetAttentionVisible(false);
    stopCallWidgetMessageObserver();
    callWidgetMessageSyncPaused = false;
    setWidgetVisible(false);
}

export function isCallMiniWidgetVisible() {
    return !!callWidgetEl && callWidgetEl.style.display !== 'none';
}
