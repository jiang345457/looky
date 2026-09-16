function getPlatform() {
  try {
    const capacitor = typeof window !== 'undefined' ? window.Capacitor : null;
    if (typeof capacitor?.isNativePlatform === 'function') {
      return capacitor.isNativePlatform() ? (capacitor.getPlatform?.() || 'android') : 'web';
    }
    return capacitor?.getPlatform?.() || 'web';
  } catch {
    return 'web';
  }
}

export function isNativeRuntime() {
  try {
    return typeof window !== 'undefined' && getPlatform() !== 'web';
  } catch {
    return false;
  }
}

export function isHarmonyRuntime() {
  try {
    const capacitorPlatform = typeof window !== 'undefined' ? window.Capacitor?.getPlatform?.() : '';
    const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    return String(capacitorPlatform || '').toLowerCase() === 'harmony'
      || /OpenHarmony|HarmonyOS|ArkWeb/i.test(userAgent);
  } catch {
    return false;
  }
}

let nativeModulesPromise = null;
const nativeChunkedExportSessions = new Set();
// Capacitor serializes this string through the WebView bridge. A JavaScript
// character can occupy up to four UTF-8 bytes (emoji), so the old 256K-char
// limit could become close to 1MB before Android received the message.
// This only changes the transport slice size; backup file chunk sizes stay
// unchanged.
const MAX_NATIVE_BRIDGE_CHARS = 128 * 1024;

async function getNativeModules() {
  if (!nativeModulesPromise) {
    nativeModulesPromise = Promise.all([
      import('@capacitor/core'),
      import('@capacitor/filesystem'),
      import('@capacitor/share'),
      import('@capacitor/local-notifications')
    ]).then(([core, filesystem, share, localNotifications]) => ({
      Capacitor: core.Capacitor,
      NativeBackup: core.registerPlugin('NativeBackup'),
      NativeMedia: core.registerPlugin('NativeMedia'),
      NativeSpeech: core.registerPlugin('NativeSpeech'),
      Directory: filesystem.Directory,
      Filesystem: filesystem.Filesystem,
      Share: share.Share,
      LocalNotifications: localNotifications.LocalNotifications
    }));
  }
  return nativeModulesPromise;
}

let nativeNotificationChannelPromise = null;

export async function getNativeNotificationPermission() {
  if (!isNativeRuntime()) return 'unsupported';

  try {
    const { LocalNotifications } = await getNativeModules();
    const result = await LocalNotifications.checkPermissions();
    return String(result?.display || 'denied');
  } catch (error) {
    console.warn('[NativeBridge] Notification permission check failed:', error);
    return 'denied';
  }
}

export async function requestNativeNotificationPermission() {
  if (!isNativeRuntime()) return 'unsupported';

  try {
    const { LocalNotifications } = await getNativeModules();
    let result = await LocalNotifications.checkPermissions();
    if (result?.display !== 'granted') {
      result = await LocalNotifications.requestPermissions();
    }
    return String(result?.display || 'denied');
  } catch (error) {
    console.warn('[NativeBridge] Notification permission request failed:', error);
    return 'denied';
  }
}

async function ensureNativeNotificationChannel(LocalNotifications) {
  if (!nativeNotificationChannelPromise) {
    nativeNotificationChannelPromise = LocalNotifications.createChannel({
       id: 'looky-messages-v3',
      name: 'LOOKY 消息通知',
      description: 'LOOKY 后台消息提醒',
      importance: 5,
      vibration: true,
      lights: true
    }).catch(error => {
      nativeNotificationChannelPromise = null;
      throw error;
    });
  }
  await nativeNotificationChannelPromise;
}

export async function showNativeNotification(title, body, extra = {}) {
  if (!isNativeRuntime()) return false;

  const { LocalNotifications } = await getNativeModules();
  const permission = await getNativeNotificationPermission();
  if (permission !== 'granted') return false;

  const avatar = typeof extra.avatar === 'string' ? extra.avatar : '';
  if (avatar) {
    try {
      let avatarData = '';
      if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(avatar)) {
        avatarData = avatar;
      } else if (/^https:\/\//i.test(avatar)) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const response = await fetch(avatar, { cache: 'force-cache', signal: controller.signal });
          const blob = await response.blob();
          if (response.ok && blob.size > 0 && blob.size <= 2 * 1024 * 1024 && /^image\/(?:png|jpe?g|webp|gif)$/i.test(blob.type || '')) {
            avatarData = `data:${blob.type};base64,${await blobToBase64(blob)}`;
          }
        } finally {
          clearTimeout(timeout);
        }
      }
      if (avatarData) {
        const { NativeMedia } = await getNativeModules();
        const result = await NativeMedia.showMessageNotification({
          title: String(title || 'LOOKY'),
          body: String(body || ''),
          avatarData,
          targetPage: String(extra.targetPage || ''),
          targetId: String(extra.targetId || '')
        });
        if (result?.shown === true) return true;
      }
    } catch (error) {
      console.warn('[NativeBridge] Avatar notification fallback:', error);
    }
  }

  await ensureNativeNotificationChannel(LocalNotifications);
  await LocalNotifications.schedule({
    notifications: [{
      id: Math.floor(Date.now() % 2147483647),
      title: String(title || 'LOOKY'),
      body: String(body || ''),
       channelId: 'looky-messages-v3',
      smallIcon: 'ic_stat_looky',
      extra
    }]
  });
  return true;
}

export async function isNativeBackupSupported() {
  if (!isNativeRuntime()) return false;
  try {
    const { NativeBackup } = await getNativeModules();
    const result = await NativeBackup.isSupported();
    return result?.supported === true;
  } catch (error) {
    console.warn('[NativeBridge] Native backup unavailable:', error);
    return false;
  }
}

export async function beginNativeBackupExport(fileName) {
  const { NativeBackup } = await getNativeModules();
  const result = await NativeBackup.beginExport({ fileName });
  if (result?.chunkedEntry === true && result?.sessionId) {
    nativeChunkedExportSessions.add(result.sessionId);
  }
  return result;
}

export async function appendNativeBackupPart(sessionId, entryName, blob) {
  const { NativeBackup } = await getNativeModules();
  if (nativeChunkedExportSessions.has(sessionId)) {
    await NativeBackup.beginExportEntry({ sessionId, entryName });
    const appendTextChunks = async (data) => {
      let offset = 0;
      while (offset < data.length) {
        let end = Math.min(offset + MAX_NATIVE_BRIDGE_CHARS, data.length);
        if (end < data.length && data.charCodeAt(end - 1) >= 0xD800 && data.charCodeAt(end - 1) <= 0xDBFF && data.charCodeAt(end) >= 0xDC00 && data.charCodeAt(end) <= 0xDFFF) {
          end--;
        }
        if (end <= offset) end = Math.min(offset + MAX_NATIVE_BRIDGE_CHARS + 1, data.length);
        await NativeBackup.appendExportEntryData({
          sessionId,
          data: data.slice(offset, end)
        });
        offset = end;
      }
    };

    // Stream Blob data when the WebView supports it. The old path called
    // blob.text(), which created a complete UTF-16 copy before sending the
    // same entry in 256KB pieces to the native plugin.
    if (typeof blob !== 'string' && typeof blob?.stream === 'function' && typeof TextDecoder === 'function') {
      const reader = blob.stream().getReader();
      const decoder = new TextDecoder();
      let pending = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          pending += decoder.decode(value || new Uint8Array(), { stream: !done });
          while (pending.length >= MAX_NATIVE_BRIDGE_CHARS) {
            let end = MAX_NATIVE_BRIDGE_CHARS;
            if (end < pending.length && pending.charCodeAt(end - 1) >= 0xD800 && pending.charCodeAt(end - 1) <= 0xDBFF && pending.charCodeAt(end) >= 0xDC00 && pending.charCodeAt(end) <= 0xDFFF) {
              end--;
            }
            if (end <= 0) end = MAX_NATIVE_BRIDGE_CHARS;
            await NativeBackup.appendExportEntryData({ sessionId, data: pending.slice(0, end) });
            pending = pending.slice(end);
          }
          if (done) break;
        }
        if (pending) await appendTextChunks(pending);
      } finally {
        reader.releaseLock?.();
      }
    } else {
      const data = typeof blob === 'string' ? blob : await blob.text();
      await appendTextChunks(data);
    }
    return NativeBackup.finishExportEntry({ sessionId });
  }
  const data = typeof blob === 'string' ? blob : await blob.text();
  return NativeBackup.appendExportPart({ sessionId, entryName, data });
}

export async function finishNativeBackupExport(sessionId) {
  const { NativeBackup } = await getNativeModules();
  try {
    return await NativeBackup.finishExport({ sessionId });
  } finally {
    nativeChunkedExportSessions.delete(sessionId);
  }
}

export async function abortNativeBackupExport(sessionId) {
  if (!sessionId) return;
  try {
    const { NativeBackup } = await getNativeModules();
    await NativeBackup.abortExport({ sessionId });
  } catch (error) {
    console.warn('[NativeBridge] Native backup cleanup failed:', error);
  } finally {
    nativeChunkedExportSessions.delete(sessionId);
  }
}

export async function openNativeBackupImport() {
  const { NativeBackup } = await getNativeModules();
  return NativeBackup.beginImport();
}

export async function readNativeBackupPart(sessionId, entryName) {
  const { NativeBackup } = await getNativeModules();
  const result = await NativeBackup.readImportPart({ sessionId, entryName });
  return String(result?.data || '');
}

export async function closeNativeBackupImport(sessionId) {
  if (!sessionId) return;
  try {
    const { NativeBackup } = await getNativeModules();
    await NativeBackup.closeImport({ sessionId });
  } catch (error) {
    console.warn('[NativeBridge] Native import cleanup failed:', error);
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取备份文件'));
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.readAsDataURL(blob);
  });
}

function normalizeFileName(fileName) {
  return String(fileName || 'looky_backup.json').replace(/[\\/:*?"<>|]+/g, '_');
}

export async function saveImageToNativeGallery(imageUrl, fileName) {
  if (!isNativeRuntime() || !imageUrl) return false;

  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`图片读取失败: ${response.status}`);
  const blob = await response.blob();
  const mimeType = blob.type?.startsWith('image/') ? blob.type : 'image/jpeg';
  const data = await blobToBase64(blob);
  const { NativeMedia } = await getNativeModules();
  const result = await NativeMedia.saveImage({
    data,
    mimeType,
    fileName: normalizeFileName(fileName || `LOOKY_${Date.now()}.jpg`)
  });
  return result?.saved === true;
}

export function isAppleMobile() {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function openImageForAppleSave(imageUrl) {
  if (!isAppleMobile() || !imageUrl || typeof document === 'undefined') return false;
  const link = document.createElement('a');
  link.href = imageUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => link.remove(), 1000);
  return true;
}

export async function shareBlobToApple(blob, fileName) {
  if (typeof navigator === 'undefined') return 'unsupported';

  if (!isAppleMobile()) return 'unsupported';
  if (!blob) return 'unavailable';
  if (typeof File !== 'function' || typeof navigator.share !== 'function') {
    return 'unavailable';
  }

  const mimeType = /^image\//i.test(blob.type || '') ? blob.type : 'image/jpeg';
  let file;
  try {
    file = new File([blob], fileName, { type: mimeType });
    if (blob.size > 16 * 1024 * 1024) return 'unavailable';
    if (typeof navigator.canShare === 'function' && !navigator.canShare({ files: [file] })) return 'unavailable';
  } catch (error) {
    console.warn('[NativeBridge] Apple image share preparation failed:', error);
    return 'unavailable';
  }

  try {
    await navigator.share({
      files: [file],
      title: fileName
    });
    return 'shared';
  } catch (error) {
    if (error?.name === 'AbortError') return 'cancelled';
    console.warn('[NativeBridge] Apple image share failed:', error);
    return 'failed';
  }
}

export async function startNativeKeepAlive() {
  if (!isNativeRuntime()) return false;
  const { NativeMedia } = await getNativeModules();
  const result = await NativeMedia.startKeepAlive();
  return result?.started === true;
}

export async function stopNativeKeepAlive() {
  if (!isNativeRuntime()) return false;
  const { NativeMedia } = await getNativeModules();
  const result = await NativeMedia.stopKeepAlive();
  return result?.stopped === true;
}

export async function updateNativeMediaMetadata(title, artist, isPlaying = true, position = 0, duration = 0, albumArt = '') {
  if (!isNativeRuntime()) return false;
  const { NativeMedia } = await getNativeModules();
  const result = await NativeMedia.updateMediaMetadata({
    title: String(title || 'LOOKY'),
    artist: String(artist || ''),
    isPlaying: Boolean(isPlaying),
    position: Number.isFinite(Number(position)) ? Number(position) : 0,
    duration: Number.isFinite(Number(duration)) ? Number(duration) : 0,
    albumArt: typeof albumArt === 'string' && /^https?:\/\//i.test(albumArt) ? albumArt : ''
  });
  return result?.updated === true;
}

export async function saveBlobToNativeStorage(blob, fileName, options = {}) {
  if (!isNativeRuntime()) return false;

  const { Directory, Filesystem, Share } = await getNativeModules();

  const safeName = normalizeFileName(fileName);
  const folder = options.folder || 'LookyBackups';
  const path = `${folder}/${safeName}`;
  const base64Data = await blobToBase64(blob);

  await Filesystem.writeFile({
    path,
    data: base64Data,
    directory: Directory.Cache,
    recursive: true
  });

  try {
    const { uri } = await Filesystem.getUri({
      path,
      directory: Directory.Cache
    });

    await Share.share({
      title: options.shareTitle || safeName,
      text: options.shareText || 'Looky 备份文件',
      url: uri
    });
  } catch (error) {
    console.warn('[NativeBridge] Share skipped:', error);
  }

  return true;
}
