import { isNativeRuntime } from './native-bridge.js';

const UPDATE_MANIFEST_URL = 'https://6-24xinlianjie.pages.dev/version.json';

let liveUpdatePromise = null;

async function getLiveUpdate() {
    if (!isNativeRuntime()) return null;
    if (!liveUpdatePromise) {
        liveUpdatePromise = import('@capawesome/capacitor-live-update')
            // Capacitor 插件对象是 Proxy，直接返回它会被 Promise 当成 thenable 读取 then。
            .then(module => ({ LiveUpdate: module.LiveUpdate }))
            .catch(error => {
                liveUpdatePromise = null;
                throw error;
            });
    }
    return liveUpdatePromise;
}

function addCacheBust(url, version) {
    const updateUrl = new URL(url);
    updateUrl.searchParams.set('v', version);
    return updateUrl.toString();
}

function parseReleaseVersion(version) {
    const match = String(version || '').trim().match(/^(\d{4})\.(\d{2})\.(\d{2})-(\d+)$/);
    return match ? match.slice(1).map(Number) : null;
}

export function isNewerReleaseVersion(candidateVersion, currentVersion) {
    const candidate = parseReleaseVersion(candidateVersion);
    const current = parseReleaseVersion(currentVersion);
    if (!candidate || !current) {
        return String(candidateVersion || '').trim() !== String(currentVersion || '').trim();
    }

    for (let index = 0; index < candidate.length; index += 1) {
        if (candidate[index] !== current[index]) {
            return candidate[index] > current[index];
        }
    }
    return false;
}

export async function fetchUpdateManifest() {
    const response = await fetch(`${UPDATE_MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`更新清单请求失败: ${response.status}`);
    }

    const manifest = await response.json();
    const remoteVersion = String(manifest.version || '').trim();
    const bundleUrl = String(manifest.bundleUrl || '').trim();
    if (!remoteVersion || !bundleUrl) {
        throw new Error('更新清单缺少版本号或下载地址');
    }
    return manifest;
}

export async function getNativeUpdateStatus(localVersion = '') {
    if (!isNativeRuntime()) return { supported: false, checked: false, updateAvailable: false };

    const liveUpdateModule = await getLiveUpdate();
    const LiveUpdate = liveUpdateModule?.LiveUpdate;
    if (!LiveUpdate) return { supported: false, checked: false, updateAvailable: false };

    let readyPromise = null;
    try {
        readyPromise = LiveUpdate.ready();
        const manifest = await fetchUpdateManifest();
        const remoteVersion = String(manifest.version || '').trim();
        const currentBundle = await LiveUpdate.getCurrentBundle();
        const currentVersion = String(localVersion || currentBundle?.bundleId || '').trim();
        const updateAvailable = Boolean(remoteVersion && isNewerReleaseVersion(remoteVersion, currentVersion));

        await readyPromise;
        return {
            supported: true,
            checked: true,
            updateAvailable,
            currentVersion,
            latestVersion: remoteVersion,
            manifest
        };
    } catch (error) {
        if (readyPromise) {
            try {
                await readyPromise;
            } catch (readyError) {
                console.warn('[LiveUpdate] ready failed:', readyError);
            }
        }
        return { supported: true, checked: true, updateAvailable: false, error };
    }
}

// APK 启动后要尽早确认当前 bundle，避免插件在 readyTimeout 内把新 bundle 回滚。
export async function confirmNativeBundleReady() {
    if (!isNativeRuntime()) return false;

    try {
        const liveUpdateModule = await getLiveUpdate();
        const LiveUpdate = liveUpdateModule?.LiveUpdate;
        if (!LiveUpdate) return false;
        await LiveUpdate.ready();
        return true;
    } catch (error) {
        console.warn('[LiveUpdate] 启动确认失败:', error);
        return false;
    }
}

export async function downloadNativeWebBundle(manifest) {
    if (!isNativeRuntime()) return { updated: false, checked: false };

    const liveUpdateModule = await getLiveUpdate();
    const LiveUpdate = liveUpdateModule?.LiveUpdate;
    if (!LiveUpdate) return { updated: false, checked: false };

    const remoteVersion = String(manifest?.version || '').trim();
    const bundleUrl = String(manifest?.bundleUrl || '').trim();
    const checksum = String(manifest?.checksum || '').trim();
    const signature = String(manifest?.signature || '').trim();
    if (!remoteVersion || !bundleUrl) {
        throw new Error('更新清单缺少版本号或下载地址');
    }

    try {
        const readyPromise = LiveUpdate.ready();
        const downloadResult = await LiveUpdate.downloadBundle({
            url: addCacheBust(bundleUrl, remoteVersion),
            bundleId: remoteVersion,
            ...(checksum ? { checksum } : {}),
            ...(signature ? { signature } : {})
        });
        const bundleId = downloadResult?.bundleId || remoteVersion;
        await LiveUpdate.setNextBundle({ bundleId });
        await readyPromise;
        await LiveUpdate.reload();
        return { updated: true, checked: true };
    } catch (error) {
        console.warn('[LiveUpdate] 保留当前本地版本:', error);
        try {
            await LiveUpdate.ready();
        } catch (readyError) {
            console.warn('[LiveUpdate] ready failed:', readyError);
        }
        return { updated: false, checked: true, error };
    }
}

export async function syncNativeWebBundle(localVersion) {
    if (!isNativeRuntime()) return { updated: false, checked: false };

    const status = await getNativeUpdateStatus(localVersion);
    if (!status.updateAvailable) {
        return status;
    }

    return downloadNativeWebBundle(status.manifest);
}

export { UPDATE_MANIFEST_URL };
