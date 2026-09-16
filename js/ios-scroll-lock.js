(function () {
  'use strict';

  var debug = window.__iosLockDebug = {
    enabled: false,
    disabledReason: 'none',
    touchmoveTotal: 0,
    preventedCount: 0,
    lastCancelable: 'N/A',
    lastAncestorFound: 'N/A',
    lastEarlyReturnReason: 'none',
    lastDeltaX: 0,
    lastDeltaY: 0
  };

  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  var isNativeAndroid = /Android/.test(navigator.userAgent) &&
    (window.__lookyRuntime === 'native' ||
      document.documentElement.classList.contains('looky-native') ||
      Boolean(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()));
  if (!isIOS && !isNativeAndroid) {
    debug.disabledReason = 'non-ios';
    return;
  }

  var params = new URLSearchParams(window.location.search);
  if (params.get('noscrolllock') === '1') {
    debug.disabledReason = 'noscrolllock';
    return;
  }

  debug.enabled = true;

  var startX = 0;
  var startY = 0;
  var hasTouchStart = false;
  var EDGE_TOLERANCE = 1;
  var HORIZONTAL_THRESHOLD = 10;

  function isScrollableY(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    var style = window.getComputedStyle(element);
    var overflowY = style.overflowY;
    var webkitOverflowScrolling = style.getPropertyValue('-webkit-overflow-scrolling');
    var canOverflowY = overflowY === 'auto' ||
      overflowY === 'scroll' ||
      webkitOverflowScrolling === 'touch';

    return canOverflowY && element.scrollHeight > element.clientHeight + EDGE_TOLERANCE;
  }

  function hasScrollableYAncestorThatCanMove(target, deltaY) {
    var element = target && target.nodeType === Node.ELEMENT_NODE ? target : target && target.parentElement;

    while (element && element !== document.documentElement) {
      if (isScrollableY(element) && !isAtScrollBoundary(element, deltaY)) {
        return true;
      }
      element = element.parentElement;
    }

    return false;
  }

  function isAtScrollBoundary(scrollable, deltaY) {
    var scrollTop = scrollable.scrollTop;
    var maxScrollTop = scrollable.scrollHeight - scrollable.clientHeight;
    var isPullingPastTop = deltaY > 0 && scrollTop <= EDGE_TOLERANCE;
    var isPushingPastBottom = deltaY < 0 && scrollTop >= maxScrollTop - EDGE_TOLERANCE;

    return isPullingPastTop || isPushingPastBottom;
  }

  function isAndroidKeyboardOpen() {
    return document.body.classList.contains('android-pwa-keyboard-open');
  }

  function isVideoCallDragTarget(target) {
    var element = target && target.nodeType === Node.ELEMENT_NODE
      ? target
      : target && target.parentElement;
    return Boolean(element && element.closest && element.closest('#video-call-container .local-view'));
  }

  function onTouchStart(event) {
    if (isNativeAndroid && !isAndroidKeyboardOpen()) {
      hasTouchStart = false;
      return;
    }
    if (!event.touches || event.touches.length !== 1) {
      hasTouchStart = false;
      return;
    }

    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    hasTouchStart = true;
  }

  function onTouchMove(event) {
    debug.touchmoveTotal += 1;
    debug.lastCancelable = Boolean(event.cancelable);
    debug.lastEarlyReturnReason = 'none';

    // 视频小窗有自己的拖拽处理，不要在这里再次遍历父元素并读取滚动样式。
    // 只跳过小窗，不改变视频消息列表原有的滚动边界保护。
    if (isVideoCallDragTarget(event.target)) {
      debug.lastEarlyReturnReason = 'video-call-drag-target';
      debug.lastAncestorFound = 'N/A';
      return;
    }

    if (isNativeAndroid && !isAndroidKeyboardOpen()) {
      debug.lastEarlyReturnReason = 'android-keyboard-closed';
      return;
    }

    if (!event.touches || event.touches.length !== 1) {
      debug.lastEarlyReturnReason = 'multi-touch';
      debug.lastAncestorFound = 'N/A';
      return;
    }

    if (!hasTouchStart) {
      debug.lastEarlyReturnReason = 'no-touchstart';
      debug.lastAncestorFound = 'N/A';
      return;
    }

    var touch = event.touches[0];
    var deltaX = touch.clientX - startX;
    var deltaY = touch.clientY - startY;
    debug.lastDeltaX = deltaX;
    debug.lastDeltaY = deltaY;

    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > HORIZONTAL_THRESHOLD) {
      debug.lastEarlyReturnReason = 'horizontal';
      debug.lastAncestorFound = 'N/A';
      return;
    }

    var ancestorCanMove = hasScrollableYAncestorThatCanMove(event.target, deltaY);
    debug.lastAncestorFound = ancestorCanMove;

    if (!ancestorCanMove && event.cancelable) {
      event.preventDefault();
      debug.preventedCount += 1;
      return;
    }

    if (!ancestorCanMove && !event.cancelable) {
      debug.lastEarlyReturnReason = 'not-cancelable';
    }
  }

  function onTouchEnd() {
    hasTouchStart = false;
  }

  document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
  document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
  document.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true });
}());
