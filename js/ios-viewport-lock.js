(function () {
  'use strict';

  var debug = window.__iosViewportLockDebug = {
    enabled: false,
    disabledReason: 'default-off',
    mode: 'body-fixed',
    scrollX: 0,
    scrollY: 0
  };

  var params = new URLSearchParams(window.location.search);
  var explicitlyEnabled = params.get('vplock') === '1';
  var explicitlyDisabled = params.get('novplock') === '1';

  if (!explicitlyEnabled || explicitlyDisabled) {
    debug.disabledReason = explicitlyDisabled ? 'novplock' : 'default-off';
    return;
  }

  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (!isIOS) {
    debug.disabledReason = 'non-ios';
    return;
  }

  var isStandalone = Boolean(window.navigator.standalone) ||
    Boolean(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  if (!isStandalone) {
    debug.disabledReason = 'non-standalone';
    return;
  }

  var style = document.createElement('style');
  style.id = 'ios-viewport-lock-style';
  style.textContent = [
    'body.ios-vp-lock-body {',
    '  position: fixed !important;',
    '  top: 0 !important;',
    '  left: 0 !important;',
    '  right: 0 !important;',
    '  bottom: 0 !important;',
    '  width: 100% !important;',
    '  height: 100% !important;',
    '  overflow: hidden !important;',
    '  overscroll-behavior: none !important;',
    '}'
  ].join('\n');

  document.head.appendChild(style);

  debug.scrollX = window.scrollX || document.documentElement.scrollLeft || 0;
  debug.scrollY = window.scrollY || document.documentElement.scrollTop || 0;
  window.scrollTo(0, 0);
  document.body.classList.add('ios-vp-lock-body');
  debug.enabled = true;
  debug.disabledReason = 'none';
}());
