import { AppState, db, tempState } from '../state.js';
import { showConfirmModal, showDynamicIsland, showPage } from '../ui.js';
import { escapeHTML } from '../utils.js';

export const MCP_SETTINGS_KEY = 'mcpSettings';

const DEFAULT_MCP_SETTINGS = Object.freeze({
    enabled: true,
    servers: [],
    tools: {},
    toolCallMode: 'auto',
    maxRounds: 3,
    maxCalls: 5,
    timeoutSeconds: 30,
    confirmWrites: true
});

const READONLY_HINTS = ['get', 'list', 'search', 'read', 'query', 'fetch'];
const WRITE_HINTS = ['create', 'update', 'delete', 'write', 'send', 'post', 'execute', 'modify', 'remove', 'login', 'register', 'rotate', 'replace', 'change', 'submit', 'play'];
const STREAMABLE_HTTP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const LEGACY_SSE_PROTOCOL_VERSION = '2024-11-05';
const mcpSessions = new Map();
const legacySseSessions = new Map();
const initializedMcpServers = new Map();
const pendingMcpInitializations = new Map();
let mcpRequestId = 0;
let activeMcpServerId = '';
let activeMcpToolRenderLimit = 50;

function createDefaultSettings() {
    return {
        ...DEFAULT_MCP_SETTINGS,
        servers: [],
        tools: {}
    };
}

function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeServer(server = {}) {
    const transport = ['auto', 'streamable-http', 'sse'].includes(server.transport)
        ? server.transport
        : 'auto';
    const connectionStatus = ['connected', 'failed'].includes(server.connectionStatus)
        ? server.connectionStatus
        : 'unchecked';
    return {
        id: String(server.id || `mcp_server_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`),
        name: String(server.name || '未命名服务器').trim() || '未命名服务器',
        url: String(server.url || '').trim(),
        accessToken: normalizeAccessToken(server.accessToken ?? server.token),
        transport,
        protocolVersion: normalizeMcpProtocolVersion(server.protocolVersion, transport),
        headers: server.headers && typeof server.headers === 'object' && !Array.isArray(server.headers)
            ? { ...server.headers }
            : {},
        enabled: server.enabled !== false,
        connectionStatus,
        lastCheckedAt: Number(server.lastCheckedAt) || 0,
        lastError: connectionStatus === 'failed' ? String(server.lastError || '').slice(0, 300) : '',
        updatedAt: Number(server.updatedAt) || Date.now()
    };
}

function normalizeAccessToken(value) {
    return String(value || '').trim().replace(/^Bearer\s+/i, '').trim();
}

function normalizeTool(tool = {}, fallbackId = '') {
    const name = String(tool.name || '').trim();
    const permissionSource = tool.permissionSource === 'manual' ? 'manual' : 'inferred';
    return {
        id: String(tool.id || fallbackId || ''),
        source: tool.source === 'local' ? 'local' : 'remote',
        serverId: tool.serverId ? String(tool.serverId) : '',
        name,
        description: String(tool.description || '').trim(),
        inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
            ? tool.inputSchema
            : (tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} }),
        permission: permissionSource === 'manual'
            ? (tool.permission === 'readonly' ? 'readonly' : 'write')
            : inferToolPermission(tool),
        permissionSource,
        enabled: tool.enabled !== false,
        updatedAt: Number(tool.updatedAt) || Date.now()
    };
}

function normalizeSettings(raw = {}) {
    const settings = createDefaultSettings();
    settings.enabled = raw.enabled !== false;
    settings.servers = Array.isArray(raw.servers) ? raw.servers.map(normalizeServer) : [];
    settings.tools = {};
    if (raw.tools && typeof raw.tools === 'object' && !Array.isArray(raw.tools)) {
        Object.entries(raw.tools).forEach(([toolId, tool]) => {
            const normalized = normalizeTool(tool, toolId);
            if (normalized.id && normalized.name) settings.tools[normalized.id] = normalized;
        });
    }
    settings.maxRounds = clampInteger(raw.maxRounds, 1, 10, DEFAULT_MCP_SETTINGS.maxRounds);
    settings.maxCalls = clampInteger(raw.maxCalls, 1, 50, DEFAULT_MCP_SETTINGS.maxCalls);
    settings.timeoutSeconds = clampInteger(raw.timeoutSeconds, 5, 120, DEFAULT_MCP_SETTINGS.timeoutSeconds);
    settings.toolCallMode = ['auto', 'native', 'compat'].includes(raw.toolCallMode)
        ? raw.toolCallMode
        : DEFAULT_MCP_SETTINGS.toolCallMode;
    settings.confirmWrites = raw.confirmWrites !== false;
    return settings;
}

export async function loadMcpSettings(force = false) {
    if (!force && AppState.mcpSettings) return AppState.mcpSettings;
    const record = await db.appData.get(MCP_SETTINGS_KEY);
    AppState.mcpSettings = normalizeSettings(record?.value || {});
    return AppState.mcpSettings;
}

export async function saveMcpSettings(nextSettings) {
    const normalized = normalizeSettings(nextSettings);
    AppState.mcpSettings = normalized;
    await db.appData.put({ key: MCP_SETTINGS_KEY, value: normalized });
    window.dispatchEvent(new CustomEvent('looky:mcp-settings-updated'));
    return normalized;
}

export function isLocalUrl(rawUrl) {
    try {
        const parsed = new URL(String(rawUrl || '').trim());
        const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0' || hostname === '127.0.0.1') return true;
        if (hostname.startsWith('::ffff:')) return isLocalUrl(`${parsed.protocol}//${hostname.slice(7)}`);
        if (hostname.startsWith('127.')) return true;
        if (hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('169.254.')) return true;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
        if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname)) return true;
        if (hostname.includes(':') && /^(fc|fd|fe[89ab])/i.test(hostname)) return true;
        return false;
    } catch (error) {
        return false;
    }
}

function isLoopbackUrl(rawUrl) {
    try {
        const hostname = new URL(String(rawUrl || '').trim()).hostname.toLowerCase().replace(/^\[|\]$/g, '');
        return hostname === 'localhost'
            || hostname === '::1'
            || hostname === '0.0.0.0'
            || hostname === '127.0.0.1'
            || hostname.startsWith('127.')
            || hostname === '::ffff:127.0.0.1';
    } catch (error) {
        return false;
    }
}

function validateServerUrl(rawUrl) {
    const parsed = new URL(String(rawUrl || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('服务器地址必须以 http:// 或 https:// 开头');
        if (parsed.username || parsed.password) throw new Error('请把鉴权信息放在访问 Token 或自定义请求头中，不要写在地址里');
    return parsed.toString();
}

function parseCustomHeaders(value) {
    if (!value) return {};
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('自定义请求头必须是 JSON 对象');
    const headers = {};
    Object.entries(parsed).forEach(([key, headerValue]) => {
        if (headerValue === null || headerValue === undefined) return;
        headers[String(key)] = String(headerValue);
    });
    return headers;
}

function getMcpConnectionKey(server) {
    const headers = parseCustomHeaders(server.headers);
    const sortedHeaders = Object.fromEntries(Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)));
    return JSON.stringify([String(server.url || ''), String(server.transport || 'auto'), sortedHeaders, normalizeAccessToken(server.accessToken)]);
}

function getMcpCredentialKey(server) {
    const headers = parseCustomHeaders(server.headers);
    const sortedHeaders = Object.fromEntries(Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)));
    return JSON.stringify([sortedHeaders, normalizeAccessToken(server.accessToken)]);
}

function getMcpRequestHeaders(server, extraHeaders = {}) {
    const headers = {
        ...parseCustomHeaders(server.headers),
        ...extraHeaders
    };
    const accessToken = normalizeAccessToken(server.accessToken);
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    return headers;
}

function rememberInitializedMcpServer(server) {
    initializedMcpServers.set(String(server.id), {
        connectionKey: getMcpConnectionKey(server),
        server
    });
}

function forgetInitializedMcpServer(serverId) {
    const key = String(serverId);
    initializedMcpServers.delete(key);
    pendingMcpInitializations.delete(key);
    mcpSessions.delete(key);
    closeLegacySseSession(key);
}

function isCurrentPageLocalPreview() {
    if (typeof window === 'undefined') return false;
    if (window.location.protocol === 'file:') return true;
    return isLocalUrl(window.location.href);
}

function getMcpProxyUrl(targetUrl) {
    const proxyUrl = new URL('/mcp-proxy', window.location.origin);
    proxyUrl.searchParams.set('target', targetUrl);
    return proxyUrl.toString();
}

function getMcpRequestUrls(server, overrideUrl = '') {
    const targetUrl = validateServerUrl(overrideUrl || server.url);
    if (isLocalUrl(targetUrl)) return targetUrl;
    const proxyUrl = getMcpProxyUrl(targetUrl);
    return isCurrentPageLocalPreview()
        ? [targetUrl, proxyUrl]
        : [proxyUrl, targetUrl];
}
function isUnavailableLocalProxyResponse(response) {
    try {
        if (new URL(response.url).pathname !== '/mcp-proxy') return false;
    } catch (error) {
        return false;
    }
    if ([404, 405].includes(response.status)) return true;
    if (response.status === 200) {
        const ct = response.headers.get('content-type') || '';
        if (ct.includes('text/html')) return true;
    }
    return false;
}

async function fetchMcp(server, overrideUrl, init) {
    const urls = getMcpRequestUrls(server, overrideUrl);
    const candidates = Array.isArray(urls) ? urls : [urls];
    let firstNetworkError = null;
    let lastProxyResponse = null;
    for (const url of candidates) {
        try {
            const response = await fetch(url, init);
            if (isUnavailableLocalProxyResponse(response)) {
                lastProxyResponse = response;
                continue;
            }
            return response;
        } catch (error) {
            if (!firstNetworkError) firstNetworkError = error;
        }
    }
    if (firstNetworkError) throw firstNetworkError;
    if (lastProxyResponse) return lastProxyResponse;
    throw new Error('MCP 请求没有可用地址');
}

async function createMcpHttpError(response, server, phase = 'POST') {
    const responseText = await response.text().catch(() => '');
    const safeMessage = responseText.slice(0, 240).replace(/\s+/g, ' ').trim();
    if (isUnavailableLocalProxyResponse(response)) {
        const error = new Error('当前本地预览服务没有启用 /mcp-proxy，系统已改走直连；如果仍失败，请使用支持 Functions 的本地服务或部署后测试。');
        error.status = response.status;
        error.proxyUnavailable = true;
        return error;
    }
    if (response.status === 401) {
        const error = new Error('MCP 服务器拒绝鉴权（401）。如果该服务器需要 Bearer Token，请在“访问 Token”中填写；如果使用其它鉴权方式，请在“自定义请求头”中填写。');
        error.status = response.status;
        error.authRequired = true;
        return error;
    }
    if (response.status === 403) {
        const error = new Error('MCP 服务器拒绝请求（403）。请检查访问 Token 是否正确，以及 Termux 服务是否允许当前网页来源（CORS）。');
        error.status = response.status;
        error.authRequired = true;
        return error;
    }
    if (response.status === 405) {
        const error = new Error('MCP 连接被拒绝（405）。系统会自动继续尝试其它 MCP 接口方式，请确认地址是服务商给出的 MCP HTTP/SSE 地址。');
        error.status = response.status;
        error.transportMismatch = true;
        return error;
    }
    const error = new Error(`MCP 请求失败 (${response.status})${safeMessage ? `：${safeMessage}` : `，阶段：${phase}`}`);
    error.status = response.status;
    error.endpointMismatch = [400, 404].includes(response.status);
    return error;
}

function createMcpConnectionError(server, error) {
    if (!(error instanceof TypeError)) return error;
    if (isLocalUrl(server.url)) {
        const currentPageHint = !isCurrentPageLocalPreview() && isLoopbackUrl(server.url)
            ? '当前网页是线上地址；请确认网页和 Termux 确实在同一部手机上，因为 127.0.0.1/localhost 只指向当前设备。'
            : '';
        const currentOrigin = typeof window !== 'undefined' && window.location.origin && window.location.origin !== 'null'
            ? `当前网页来源是 ${window.location.origin}。`
            : '';
        return new Error(`本地 MCP 无法连接。${currentPageHint}${currentOrigin}请确认 Termux 服务已启动、填写的是 http://127.0.0.1:端口/mcp 或 /sse，并允许该网页来源跨域访问（CORS）。如果启动的是 npx/stdio 服务，还需要先用 HTTP/SSE 网关暴露端口；网页不能直接运行 npx/stdio 命令。`);
    }
    return new Error('浏览器无法直接访问这个远程 MCP，且当前本地预览没有可用代理。请用支持 /mcp-proxy 的本地服务或部署后再测试。');
}

function normalizeMcpProtocolVersion(value, transport = 'streamable-http') {
    const supportedVersions = transport === 'sse'
        ? [LEGACY_SSE_PROTOCOL_VERSION]
        : STREAMABLE_HTTP_PROTOCOL_VERSIONS;
    return supportedVersions.includes(value) ? value : supportedVersions[0];
}

function getMcpProtocolVersions(server) {
    const preferred = normalizeMcpProtocolVersion(server.protocolVersion, server.transport);
    const supportedVersions = server.transport === 'sse'
        ? [LEGACY_SSE_PROTOCOL_VERSION]
        : STREAMABLE_HTTP_PROTOCOL_VERSIONS;
    return [preferred, ...supportedVersions.filter(version => version !== preferred)];
}

function getMcpProtocolVersion(server, overrideVersion = '') {
    return normalizeMcpProtocolVersion(overrideVersion || server.protocolVersion, server.transport);
}

function failLegacySseSession(session, error) {
    if (!session || session.closed) return;
    session.closed = true;
    if (!session.endpointSettled) {
        session.endpointSettled = true;
        session.rejectEndpoint(error);
    }
    session.pending.forEach(({ reject }) => reject(error));
    session.pending.clear();
    legacySseSessions.delete(String(session.serverId));
}

function closeLegacySseSession(serverId) {
    const session = legacySseSessions.get(String(serverId));
    if (!session) return;
    session.closed = true;
    session.controller.abort();
    const closeError = new Error('MCP SSE 连接已关闭');
    if (!session.endpointSettled) {
        session.endpointSettled = true;
        session.rejectEndpoint(closeError);
    }
    session.pending.forEach(({ reject }) => reject(closeError));
    session.pending.clear();
    legacySseSessions.delete(String(serverId));
}

function processLegacySseEvent(session, rawEvent) {
    const lines = String(rawEvent || '').split(/\r?\n/);
    let eventName = 'message';
    const dataLines = [];
    lines.forEach(line => {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    });
    const data = dataLines.join('\n').trim();
    if (!data) return;
    if (eventName === 'endpoint') {
        try {
            const endpointUrl = new URL(data, session.server.url);
            const serverUrl = new URL(session.server.url);
            if (endpointUrl.origin !== serverUrl.origin) throw new Error('SSE 消息地址与服务器来源不一致');
            session.endpointUrl = endpointUrl.toString();
            if (!session.endpointSettled) {
                session.endpointSettled = true;
                session.resolveEndpoint(session.endpointUrl);
            }
        } catch (error) {
            failLegacySseSession(session, new Error(error?.message || 'SSE 服务器返回了无效消息地址'));
        }
        return;
    }
    try {
        const payload = JSON.parse(data);
        const pending = session.pending.get(String(payload?.id));
        if (!pending) return;
        session.pending.delete(String(payload.id));
        pending.resolve(payload);
    } catch (error) {
        // 与当前请求无关的 SSE 文本不会中断连接。
    }
}

async function pumpLegacySse(session, reader) {
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
        while (!session.closed) {
            const { done, value } = await reader.read();
            if (done) throw new Error('MCP SSE 连接已断开');
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() || '';
            events.forEach(event => processLegacySseEvent(session, event));
        }
    } catch (error) {
        if (!session.closed) failLegacySseSession(session, error);
    }
}

async function openLegacySseSession(server, timeoutMs) {
    const existing = legacySseSessions.get(String(server.id));
    if (existing && !existing.closed && existing.endpointUrl) return existing;
    closeLegacySseSession(server.id);

    const controller = new AbortController();
    let resolveEndpoint;
    let rejectEndpoint;
    const endpointPromise = new Promise((resolve, reject) => {
        resolveEndpoint = resolve;
        rejectEndpoint = reject;
    });
    endpointPromise.catch(() => {});
    const session = {
        serverId: server.id,
        server,
        controller,
        endpointUrl: '',
        endpointPromise,
        resolveEndpoint,
        rejectEndpoint,
        endpointSettled: false,
        pending: new Map(),
        closed: false
    };
    legacySseSessions.set(String(server.id), session);

    try {
        const response = await fetchMcp(server, '', {
            method: 'GET',
            headers: getMcpRequestHeaders(server, {
                'Accept': 'text/event-stream',
                'Mcp-Protocol-Version': getMcpProtocolVersion(server, options.protocolVersion)
            }),
            signal: controller.signal,
            cache: 'no-store'
        });
        if (!response.ok) throw await createMcpHttpError(response, server, 'SSE GET');
        if (!response.body) throw new Error('SSE 服务器没有返回数据流');
        pumpLegacySse(session, response.body.getReader());
        const timeoutId = setTimeout(() => {
            if (session.endpointSettled) return;
            session.endpointSettled = true;
            rejectEndpoint(new Error('等待 SSE 消息地址超时'));
        }, timeoutMs);
        try {
            await endpointPromise;
        } finally {
            clearTimeout(timeoutId);
        }
        return session;
    } catch (error) {
        closeLegacySseSession(server.id);
        throw createMcpConnectionError(server, error);
    }
}

async function sendLegacySseRequest(server, body, options, timeoutMs) {
    const session = await openLegacySseSession(server, timeoutMs);
    const requestId = body.id;
    let responsePromise = null;
    let responseTimeoutId = null;
    if (!options.notification) {
        responsePromise = new Promise((resolve, reject) => {
            session.pending.set(String(requestId), { resolve, reject });
            responseTimeoutId = setTimeout(() => {
                session.pending.delete(String(requestId));
                reject(new Error(`MCP 调用超过 ${Math.round(timeoutMs / 1000)} 秒，已停止`));
            }, timeoutMs);
        });
    }

    const controller = new AbortController();
    const postTimeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchMcp(server, session.endpointUrl, {
            method: 'POST',
            headers: getMcpRequestHeaders(server, {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Mcp-Protocol-Version': getMcpProtocolVersion(server, options.protocolVersion)
            }),
            body: JSON.stringify(body),
            signal: controller.signal,
            cache: 'no-store'
        });
        if (!response.ok) throw await createMcpHttpError(response, server, 'SSE POST');
        if (options.notification) return null;
        const contentType = response.headers.get('content-type') || '';
        let payload = null;
        if (contentType.includes('application/json')) {
            const responseText = await response.text();
            if (responseText.trim()) payload = JSON.parse(responseText);
        }
        if (payload) session.pending.delete(String(requestId));
        if (!payload) payload = await responsePromise;
        if (payload?.error) throw new Error(payload.error.message || 'MCP 服务器返回错误');
        return payload?.result;
    } catch (error) {
        if (requestId !== undefined) session.pending.delete(String(requestId));
        if (error?.name === 'AbortError') throw new Error(`MCP 调用超过 ${Math.round(timeoutMs / 1000)} 秒，已停止`);
        throw createMcpConnectionError(server, error);
    } finally {
        clearTimeout(postTimeoutId);
        if (responseTimeoutId) clearTimeout(responseTimeoutId);
    }
}

function parseEventStream(text, requestId) {
    const payloads = String(text || '')
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .filter(value => value && value !== '[DONE]')
        .map(value => {
            try { return JSON.parse(value); } catch (error) { return null; }
        })
        .filter(Boolean);
    return payloads.find(item => requestId !== undefined && String(item.id) === String(requestId)) || payloads[payloads.length - 1] || null;
}

async function sendMcpRequest(server, method, params = {}, options = {}) {
    const settings = await loadMcpSettings();
    const requestId = options.notification ? undefined : ++mcpRequestId;
    const body = {
        jsonrpc: '2.0',
        method,
        ...(options.notification ? {} : { id: requestId }),
        ...(params === undefined ? {} : { params })
    };
    const timeoutMs = clampInteger(options.timeoutSeconds, 1, 120, settings.timeoutSeconds) * 1000;
    if (server.transport === 'sse') return sendLegacySseRequest(server, body, options, timeoutMs);
    const headers = getMcpRequestHeaders(server, {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Mcp-Protocol-Version': getMcpProtocolVersion(server, options.protocolVersion)
    });
    const sessionId = mcpSessions.get(String(server.id));
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchMcp(server, '', {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
            cache: 'no-store'
        });
        const nextSessionId = response.headers.get('Mcp-Session-Id');
        if (nextSessionId) mcpSessions.set(String(server.id), nextSessionId);
        if (!response.ok) {
            throw await createMcpHttpError(response, server, 'Streamable HTTP POST');
        }
        if (options.notification || response.status === 202 || response.status === 204) return null;
        const responseText = await response.text();
        if (!responseText.trim()) return null;
        const contentType = response.headers.get('content-type') || '';
        const payload = contentType.includes('text/event-stream')
            ? parseEventStream(responseText, requestId)
            : JSON.parse(responseText);
        if (!payload) throw new Error('MCP 服务器没有返回可解析的数据');
        if (payload.error) throw new Error(payload.error.message || 'MCP 服务器返回错误');
        return payload.result;
    } catch (error) {
        if (error?.name === 'AbortError') throw new Error(`MCP 调用超过 ${Math.round(timeoutMs / 1000)} 秒，已停止`);
        if (error instanceof SyntaxError) throw new Error('MCP 服务器返回了无法解析的 JSON');
        throw createMcpConnectionError(server, error);
    } finally {
        clearTimeout(timeoutId);
    }
}

async function initializeServerWithTransport(server, options = {}) {
    let lastError = null;
    for (const protocolVersion of getMcpProtocolVersions(server)) {
        mcpSessions.delete(String(server.id));
        closeLegacySseSession(server.id);
        try {
            const requestOptions = { ...options, protocolVersion };
            await sendMcpRequest(server, 'initialize', {
                protocolVersion,
                capabilities: {},
                clientInfo: { name: 'LOOKY', version: '1.0.0' }
            }, requestOptions);
            await sendMcpRequest(server, 'notifications/initialized', {}, { ...requestOptions, notification: true });
            return normalizeServer({ ...server, protocolVersion });
        } catch (error) {
            lastError = error;
            if (Number(error?.status) !== 400) throw error;
        }
    }
    throw lastError || new Error('MCP 初始化失败');
}

function getTransportCandidates(transport) {
    if (transport === 'sse') return ['sse', 'streamable-http'];
    if (transport === 'streamable-http') return ['streamable-http', 'sse'];
    return ['streamable-http', 'sse'];
}

function replaceLastPathSegment(rawUrl, nextSegment) {
    const parsed = new URL(validateServerUrl(rawUrl));
    const parts = parsed.pathname.split('/').filter(Boolean);
    parts[parts.length - 1] = nextSegment;
    parsed.pathname = `/${parts.join('/')}`;
    return parsed.toString();
}

function appendPathSegment(rawUrl, nextSegment) {
    const parsed = new URL(validateServerUrl(rawUrl));
    const basePath = parsed.pathname.replace(/\/+$/g, '');
    parsed.pathname = `${basePath}/${nextSegment}`;
    return parsed.toString();
}

function getUrlCandidatesForTransport(rawUrl, transport) {
    const url = validateServerUrl(rawUrl);
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const lastPart = (parts[parts.length - 1] || '').toLowerCase();
    const candidates = [url];
    if (transport === 'streamable-http' && lastPart !== 'mcp') {
        candidates.push(lastPart === 'sse' ? replaceLastPathSegment(url, 'mcp') : appendPathSegment(url, 'mcp'));
    }
    if (transport === 'sse' && lastPart !== 'sse') {
        candidates.push(lastPart === 'mcp' ? replaceLastPathSegment(url, 'sse') : appendPathSegment(url, 'sse'));
    }
    return Array.from(new Set(candidates));
}

function shouldTryNextConnectionCandidate(error) {
    return error?.transportMismatch === true
        || error?.endpointMismatch === true
        || error?.proxyUnavailable === true;
}

async function initializeServer(server, options = {}) {
    const transportCandidates = getTransportCandidates(server.transport);
    let lastError = null;
    for (const transport of transportCandidates) {
        const urlCandidates = getUrlCandidatesForTransport(server.url, transport);
        for (const url of urlCandidates) {
            const candidate = normalizeServer({ ...server, url, transport });
            try {
                return await initializeServerWithTransport(candidate, options);
            } catch (error) {
                lastError = error;
                if (!shouldTryNextConnectionCandidate(error)) throw error;
            }
        }
    }
    throw lastError || new Error('MCP 连接失败');
}

async function getOrInitializeServer(server) {
    const serverId = String(server.id);
    const connectionKey = getMcpConnectionKey(server);
    const initialized = initializedMcpServers.get(serverId);
    if (initialized?.connectionKey === connectionKey) return initialized.server;

    const pending = pendingMcpInitializations.get(serverId);
    if (pending?.connectionKey === connectionKey) return pending.promise;

    const promise = initializeServer(server)
        .then(connectedServer => {
            if (pendingMcpInitializations.get(serverId)?.promise === promise) {
                initializedMcpServers.set(serverId, { connectionKey, server: connectedServer });
            }
            return connectedServer;
        })
        .catch(error => {
            if (pendingMcpInitializations.get(serverId)?.promise === promise) {
                initializedMcpServers.delete(serverId);
            }
            throw error;
        })
        .finally(() => {
            if (pendingMcpInitializations.get(serverId)?.promise === promise) {
                pendingMcpInitializations.delete(serverId);
            }
        });
    pendingMcpInitializations.set(serverId, { connectionKey, promise });
    return promise;
}

export function inferToolPermission(tool = {}) {
    const name = String(tool.name || '').trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const haystack = `${name} ${tool.description || ''}`.toLowerCase();
    const hasKeyword = hint => new RegExp(`(^|[^a-z0-9])${hint}([^a-z0-9]|$)`).test(haystack);
    if (WRITE_HINTS.some(hasKeyword)) return 'write';
    if (READONLY_HINTS.some(hint => name === hint || name.startsWith(`${hint}_`) || name.endsWith(`_${hint}`))) return 'readonly';
    return 'write';
}

export function getToolActionLabel(tool = {}) {
    const source = `${tool.name || ''} ${tool.description || ''}`.toLowerCase();
    const labels = [
        [['weather'], '查询天气'],
        [['search', 'find'], '搜索信息'],
        [['list'], '读取列表'],
        [['get', 'read', 'query', 'fetch'], '查询数据'],
        [['create', 'post', 'send'], '新增内容'],
        [['update', 'modify', 'write'], '修改内容'],
        [['delete', 'remove'], '删除内容'],
        [['execute', 'run'], '执行操作']
    ];
    return labels.find(([keywords]) => keywords.some(keyword => source.includes(keyword)))?.[1]
        || String(tool.description || tool.name || '调用工具').trim().slice(0, 24);
}

function buildRemoteToolId(serverId, toolName) {
    return `remote:${String(serverId)}:${String(toolName)}`;
}

async function testServerAndGetTools(server) {
    const connectedServer = await initializeServer(server);
    const result = await sendMcpRequest(connectedServer, 'tools/list', {});
    rememberInitializedMcpServer(connectedServer);
    return {
        server: normalizeServer({
            ...connectedServer,
            connectionStatus: 'connected',
            lastCheckedAt: Date.now(),
            lastError: ''
        }),
        tools: Array.isArray(result?.tools) ? result.tools : []
    };
}

async function syncServerTools(server, remoteTools) {
    const settings = await loadMcpSettings();
    const nextTools = { ...settings.tools };
    Object.keys(nextTools).forEach(toolId => {
        if (nextTools[toolId]?.source === 'remote' && String(nextTools[toolId]?.serverId) === String(server.id)) delete nextTools[toolId];
    });
    remoteTools.forEach(remoteTool => {
        const toolId = buildRemoteToolId(server.id, remoteTool.name);
        const previous = settings.tools[toolId];
        nextTools[toolId] = normalizeTool({
            id: toolId,
            source: 'remote',
            serverId: server.id,
            name: remoteTool.name,
            description: remoteTool.description || '',
            inputSchema: remoteTool.inputSchema || { type: 'object', properties: {} },
            permission: previous?.permissionSource === 'manual' ? previous.permission : inferToolPermission(remoteTool),
            permissionSource: previous?.permissionSource === 'manual' ? 'manual' : 'inferred',
            enabled: previous?.enabled !== false,
            updatedAt: Date.now()
        });
    });
    const nextServers = settings.servers.some(item => String(item.id) === String(server.id))
        ? settings.servers.map(item => String(item.id) === String(server.id) ? normalizeServer(server) : item)
        : [...settings.servers, normalizeServer(server)];
    return saveMcpSettings({ ...settings, servers: nextServers, tools: nextTools });
}

export async function testMcpServer(server) {
    const normalizedServer = normalizeServer({ ...server, url: validateServerUrl(server.url), headers: parseCustomHeaders(server.headers) });
    try {
        const result = await testServerAndGetTools(normalizedServer);
        await syncServerTools(result.server, result.tools);
        return result;
    } catch (error) {
        const settings = await loadMcpSettings();
        if (settings.servers.some(item => String(item.id) === String(normalizedServer.id))) {
            settings.servers = settings.servers.map(item => String(item.id) === String(normalizedServer.id)
                ? normalizeServer({
                    ...item,
                    connectionStatus: 'failed',
                    lastCheckedAt: Date.now(),
                    lastError: error?.message || '连接失败'
                })
                : item);
            await saveMcpSettings(settings);
        }
        throw error;
    }
}

export async function getEnabledToolsForCharacter(characterOrId) {
    const settings = await loadMcpSettings();
    if (!settings.enabled) return [];
    const character = typeof characterOrId === 'object'
        ? characterOrId
        : AppState.characterProfiles.find(item => String(item.id) === String(characterOrId));
    if (!character) return [];
    const enabledServerIds = new Set(settings.servers.filter(server => server.enabled).map(server => String(server.id)));
    const availableTools = Object.values(settings.tools).filter(tool => (
        tool.enabled
        && (tool.source === 'local' || enabledServerIds.has(String(tool.serverId)))
    ));
    if (!Array.isArray(character.mcpToolIds)) return availableTools;
    if (character.mcpToolIds.length === 0) return [];
    const selectedIds = new Set(character.mcpToolIds.map(String));
    return availableTools.filter(tool => selectedIds.has(String(tool.id)));
}

export function sanitizeMcpValue(value, depth = 0) {
    if (depth > 8) return '[内容层级过深，已省略]';
    if (Array.isArray(value)) return value.map(item => sanitizeMcpValue(item, depth + 1));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if (/(authorization|api[-_]?key|token|secret|password|cookie)/i.test(key)) return [key, '[已隐藏]'];
        return [key, sanitizeMcpValue(item, depth + 1)];
    }));
}

function stripMcpImageData(value, depth = 0) {
    if (depth > 8) return '[内容层级过深，已省略]';
    if (Array.isArray(value)) return value.map(item => stripMcpImageData(item, depth + 1));
    if (!value || typeof value !== 'object') return value;
    const type = String(value.type || '').trim().toLowerCase();
    const mimeType = String(value.mimeType || value.mime_type || '').trim().toLowerCase().split(';', 1)[0];
    if (type === 'image' && typeof value.data === 'string' && /^image\/(?:png|jpe?g|webp|gif)$/.test(mimeType)) {
        return { type: 'image', mimeType, note: '图片已作为视觉输入单独发送' };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripMcpImageData(item, depth + 1)]));
}

function summarizeToolResult(result) {
    // 图片块只用于视觉输入；摘要和调用记录不要携带 base64，避免污染数据库和文本上下文。
    const safeResult = stripMcpImageData(sanitizeMcpValue(result));
    const text = typeof safeResult === 'string' ? safeResult : JSON.stringify(safeResult);
    return String(text || '调用成功').replace(/\s+/g, ' ').slice(0, 500);
}

function getMcpToolErrorMessage(result) {
    const safeResult = sanitizeMcpValue(result);
    const contentText = Array.isArray(safeResult?.content)
        ? safeResult.content.map(item => item?.text).filter(text => typeof text === 'string' && text.trim()).join(' ')
        : '';
    return String(contentText || summarizeToolResult(safeResult) || 'MCP 工具返回执行错误')
        .replace(/\s+/g, ' ')
        .slice(0, 500);
}

export async function executeTool(toolId, args = {}) {
    const startedAt = performance.now();
    try {
        const settings = await loadMcpSettings();
        if (!settings.enabled) return { ok: false, status: 'failed', message: 'MCP 调用总开关已关闭', durationMs: 0 };
        const tool = settings.tools[String(toolId)];
        if (!tool) return { ok: false, status: 'failed', message: '工具不存在或已被移除', durationMs: 0 };
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            return { ok: false, status: 'failed', message: '工具参数必须是 JSON 对象', durationMs: 0 };
        }
        if (tool.source === 'local') {
            return { ok: false, status: 'failed', message: '本地工具将在后续阶段接入，本阶段尚未实现', durationMs: 0 };
        }
        const server = settings.servers.find(item => String(item.id) === String(tool.serverId));
        if (!server || !server.enabled || !tool.enabled) {
            return { ok: false, status: 'failed', message: '工具或所属服务器当前未启用', durationMs: 0 };
        }
        const connectedServer = await getOrInitializeServer(server);
        let result;
        try {
            result = await sendMcpRequest(connectedServer, 'tools/call', { name: tool.name, arguments: args });
        } catch (error) {
            forgetInitializedMcpServer(server.id);
            throw error;
        }
        const safeResult = sanitizeMcpValue(result);
        if (result?.isError === true) {
            return {
                ok: false,
                status: 'failed',
                result: safeResult,
                message: getMcpToolErrorMessage(result),
                durationMs: Math.round(performance.now() - startedAt)
            };
        }
        if (result === undefined || result === null) {
            return {
                ok: false,
                status: 'failed',
                message: 'MCP 服务器没有返回工具结果',
                durationMs: Math.round(performance.now() - startedAt)
            };
        }
        return {
            ok: true,
            status: 'success',
            result: safeResult,
            summary: summarizeToolResult(safeResult),
            durationMs: Math.round(performance.now() - startedAt)
        };
    } catch (error) {
        return {
            ok: false,
            status: 'failed',
            message: error?.message || '工具调用失败',
            durationMs: Math.round(performance.now() - startedAt)
        };
    }
}

function getToolsForServer(settings, serverId) {
    return Object.values(settings.tools).filter(tool => tool.source === 'remote' && String(tool.serverId) === String(serverId));
}

function getTransportLabel(transport) {
    if (transport === 'sse') return 'LEGACY SSE';
    if (transport === 'streamable-http') return 'STREAMABLE HTTP';
    return 'AUTO DETECT';
}

function getConnectionLabel(server) {
    if (server.connectionStatus === 'connected') return '可正常调用';
    if (server.connectionStatus === 'failed') return '连接异常';
    return '等待检测';
}

function getToolDisplayDescription(tool) {
    const description = String(tool?.description || '服务器未提供工具说明').replace(/\s+/g, ' ').trim();
    return description.length > 120 ? `${description.slice(0, 120)}...` : description;
}

function renderMcpSettingsPage(settings) {
    const serverList = document.getElementById('mcp-server-list');
    if (!serverList) return;
    const allTools = Object.values(settings.tools);
    const connectedCount = settings.servers.filter(server => server.connectionStatus === 'connected').length;
    const overviewStatus = document.getElementById('mcp-overview-status');
    const serverCount = document.getElementById('mcp-overview-server-count');
    const connected = document.getElementById('mcp-overview-connected-count');
    const toolCount = document.getElementById('mcp-overview-tool-count');
    const globalToggle = document.getElementById('mcp-enabled-toggle');
    if (overviewStatus) {
        overviewStatus.textContent = settings.enabled
            ? (settings.servers.length ? `${connectedCount}/${settings.servers.length} 个连接可用` : '等待添加 MCP')
            : '调用功能已暂停';
        overviewStatus.classList.toggle('is-paused', !settings.enabled);
    }
    if (serverCount) serverCount.textContent = String(settings.servers.length);
    if (connected) connected.textContent = String(connectedCount);
    if (toolCount) toolCount.textContent = String(allTools.length);
    if (globalToggle) globalToggle.checked = settings.enabled;
    serverList.innerHTML = settings.servers.length ? settings.servers.map(server => {
        const tools = getToolsForServer(settings, server.id);
        const enabledCount = tools.filter(tool => tool.enabled).length;
        return `
            <article class="mcp-server-item is-${server.connectionStatus}" data-server-id="${escapeHTML(server.id)}">
                <button type="button" class="mcp-server-summary" data-mcp-action="open-server" aria-label="打开 ${escapeHTML(server.name)} 的详情">
                    <span class="mcp-server-monogram">M</span>
                    <span class="mcp-server-copy">
                        <strong>${escapeHTML(server.name)}</strong>
                        <small>${getTransportLabel(server.transport)} · ${tools.length ? `${enabledCount}/${tools.length} 个工具已启用` : '尚未读取工具'}</small>
                    </span>
                    <span class="mcp-server-state"><i aria-hidden="true"></i>${getConnectionLabel(server)}</span>
                    <span class="mcp-server-chevron" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><polyline points="9 6 15 12 9 18"></polyline></svg></span>
                </button>
            </article>
        `;
    }).join('') : '<div class="mcp-empty-state"><span>MCP SERVERS</span><p>还没有 MCP 连接，点击上方“添加”开始配置。</p></div>';

    const maxRounds = document.getElementById('mcp-max-rounds-input');
    const maxCalls = document.getElementById('mcp-max-calls-input');
    const timeout = document.getElementById('mcp-timeout-input');
    const toolCallMode = document.getElementById('mcp-tool-call-mode-select');
    const confirmWrites = document.getElementById('mcp-confirm-writes-toggle');
    if (maxRounds) maxRounds.value = settings.maxRounds;
    if (maxCalls) maxCalls.value = settings.maxCalls;
    if (timeout) timeout.value = settings.timeoutSeconds;
    if (toolCallMode) toolCallMode.value = settings.toolCallMode;
    if (confirmWrites) confirmWrites.checked = settings.confirmWrites;
}

function renderMcpServerDetail(settings, serverId = activeMcpServerId) {
    const container = document.getElementById('mcp-server-detail');
    if (!container) return;
    const server = settings.servers.find(item => String(item.id) === String(serverId));
    if (!server) {
        container.innerHTML = '<div class="mcp-empty-state"><span>MCP SERVER</span><p>这个 MCP 连接已不存在。</p></div>';
        return;
    }
    activeMcpServerId = String(server.id);
    const tools = getToolsForServer(settings, server.id);
    const visibleTools = tools.slice(0, activeMcpToolRenderLimit);
    const enabledCount = tools.filter(tool => tool.enabled).length;
    const title = document.getElementById('mcp-server-detail-title');
    if (title) title.textContent = server.name;
    container.innerHTML = `
        <section class="mcp-detail-overview is-${server.connectionStatus}">
            <div class="mcp-detail-heading">
                <span class="mcp-server-monogram">M</span>
                <div><h2>${escapeHTML(server.name)}</h2><p><i aria-hidden="true"></i>${getConnectionLabel(server)} · ${enabledCount}/${tools.length} 个工具已启用</p></div>
            </div>
            <label class="mcp-detail-authorization"><span><strong>允许此 MCP</strong><small>关闭后，对话不能调用这个 MCP 下的任何工具</small></span><span class="switch"><input type="checkbox" data-mcp-server-enabled="${escapeHTML(server.id)}" ${server.enabled ? 'checked' : ''}><span class="slider round"></span></span></label>
            <div class="mcp-server-meta">
                <span>${getTransportLabel(server.transport)}</span>
                <p>${escapeHTML(server.url)}</p>
                <small>${server.lastCheckedAt ? `上次检测：${new Date(server.lastCheckedAt).toLocaleString()}` : '尚未检测'} · ${(Object.keys(server.headers || {}).length || server.accessToken) ? '鉴权信息已隐藏' : '无自定义请求头'}</small>
                ${server.connectionStatus === 'failed' && server.lastError ? `<em>${escapeHTML(server.lastError)}</em>` : ''}
            </div>
            <div class="mcp-detail-actions">
                <button type="button" data-mcp-action="test-server">重新检测</button>
                <button type="button" data-mcp-action="edit-server">编辑连接</button>
                <button type="button" class="is-danger" data-mcp-action="delete-server">删除</button>
            </div>
        </section>
        <section class="mcp-detail-tools">
            <header><div><span>TOOLS</span><h3>工具与授权</h3></div><strong>${tools.length} 个功能</strong></header>
            <p class="mcp-detail-help">只读工具只浏览和查阅信息；可执行工具会进行操作，并遵循二次确认设置。</p>
            <div class="mcp-tool-list">
                ${tools.length ? visibleTools.map(tool => `
                    <div class="mcp-tool-item" data-tool-id="${escapeHTML(tool.id)}">
                        <div class="mcp-tool-copy">
                            <strong>${escapeHTML(tool.name)}</strong>
                            <p>${escapeHTML(getToolDisplayDescription(tool))}</p>
                        </div>
                        <div class="mcp-tool-controls">
                            <button type="button" class="mcp-permission-tag is-${tool.permission}" data-mcp-action="toggle-permission">${tool.permission === 'readonly' ? '只读' : '可执行'}</button>
                            <label class="switch" aria-label="启用 ${escapeHTML(tool.name)}"><input type="checkbox" data-mcp-tool-enabled="${escapeHTML(tool.id)}" ${tool.enabled ? 'checked' : ''}><span class="slider round"></span></label>
                        </div>
                    </div>
                `).join('') : '<p class="mcp-empty-copy">点击“重新检测”连接服务器并读取工具清单。</p>'}
            </div>
            ${visibleTools.length < tools.length ? `<button type="button" class="mcp-tools-load-more" data-mcp-action="load-more-tools">继续显示（剩余 ${tools.length - visibleTools.length} 个）</button>` : ''}
        </section>
    `;
}

function createServerDraft(form, serverId) {
    return normalizeServer({
        id: serverId,
        name: form.querySelector('#mcp-server-name-input')?.value,
        url: form.querySelector('#mcp-server-url-input')?.value,
        accessToken: form.querySelector('#mcp-server-access-token-input')?.value,
        transport: 'auto',
        headers: parseCustomHeaders(form.querySelector('#mcp-server-headers-input')?.value.trim() || '{}'),
        enabled: form.querySelector('#mcp-server-enabled-input')?.checked
    });
}

async function openServerEditor(existingServer = null) {
    const settings = await loadMcpSettings();
    const serverId = existingServer?.id || `mcp_server_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay mcp-server-editor-overlay';
    overlay.innerHTML = `
        <form class="modal-card mcp-server-editor-card">
            <div class="mcp-editor-heading">
                <span>${existingServer ? 'EDIT SERVER' : 'NEW SERVER'}</span>
                <h3>${existingServer ? '编辑 MCP 服务器' : '添加 MCP 服务器'}</h3>
            </div>
            <label class="mcp-field"><span>服务器名称</span><input id="mcp-server-name-input" class="styled-input" value="${escapeHTML(existingServer?.name || '')}" placeholder="例如：地图服务"></label>
            <label class="mcp-field"><span>服务器地址</span><input id="mcp-server-url-input" class="styled-input" value="${escapeHTML(existingServer?.url || '')}" placeholder="https://example.com/mcp"></label>
            <div class="mcp-auto-transport-note"><span>AUTO DETECT</span><p>只填写服务地址即可，系统会自动尝试 Streamable HTTP、Legacy SSE，以及常见的 /mcp、/sse 地址。</p></div>
            <label class="mcp-field"><span>访问 Token（可选）</span><input id="mcp-server-access-token-input" class="styled-input" type="password" value="${escapeHTML(existingServer?.accessToken || '')}" placeholder="需要 Bearer 鉴权时填写" autocomplete="off"><small>填写后会自动发送 <code>Authorization: Bearer TOKEN</code>。如果服务器不用 Bearer 鉴权，请使用下面的自定义请求头。</small></label>
            <label class="mcp-field"><span>自定义请求头（可选 JSON）</span><textarea id="mcp-server-headers-input" class="styled-input" rows="4" placeholder='{"Authorization":"Bearer ..."}'>${escapeHTML(Object.keys(existingServer?.headers || {}).length ? JSON.stringify(existingServer.headers, null, 2) : '')}</textarea><small>密钥只用于请求，不会显示在服务器卡片或调用记录中。</small></label>
            <label class="mcp-editor-switch"><span>启用此服务器</span><span class="switch"><input id="mcp-server-enabled-input" type="checkbox" ${existingServer?.enabled === false ? '' : 'checked'}><span class="slider round"></span></span></label>
            <div class="mcp-editor-test-result" id="mcp-editor-test-result" aria-live="polite">尚未测试连接</div>
            <div class="modal-buttons mcp-editor-actions">
                <button type="button" class="btn btn-secondary" data-editor-action="cancel">取消</button>
                <button type="button" class="btn btn-secondary" data-editor-action="test">测试连接</button>
                <button type="submit" class="btn btn-primary">保存</button>
            </div>
        </form>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    const form = overlay.querySelector('form');
    const close = () => {
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 180);
    };
    overlay.addEventListener('click', event => {
        if (event.target === overlay || event.target.closest('[data-editor-action="cancel"]')) close();
    });
    overlay.querySelector('[data-editor-action="test"]')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        const result = overlay.querySelector('#mcp-editor-test-result');
        try {
            button.disabled = true;
            button.textContent = '测试中';
            result.textContent = '正在握手并读取工具清单...';
            const draft = createServerDraft(form, serverId);
            const testResult = await testMcpServer(draft);
            result.textContent = `连接成功，已保存 ${testResult.tools.length} 个工具`;
            const updated = await loadMcpSettings(true);
            renderMcpSettingsPage(updated);
            if (String(activeMcpServerId) === String(serverId)) renderMcpServerDetail(updated, serverId);
            showDynamicIsland('MCP 连接测试成功');
        } catch (error) {
            result.textContent = error?.message || '连接测试失败';
            showDynamicIsland(error?.message || 'MCP 连接测试失败');
        } finally {
            button.disabled = false;
            button.textContent = '测试连接';
        }
    });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        try {
            const current = await loadMcpSettings();
            const formDraft = createServerDraft(form, serverId);
            validateServerUrl(formDraft.url);
            const savedServer = current.servers.find(item => String(item.id) === String(serverId));
            const sameEndpoint = savedServer
                && savedServer.url === formDraft.url
                && getMcpCredentialKey(savedServer) === getMcpCredentialKey(formDraft);
            const draft = normalizeServer(sameEndpoint ? {
                ...formDraft,
                connectionStatus: savedServer.connectionStatus,
                lastCheckedAt: savedServer.lastCheckedAt,
                lastError: savedServer.lastError
            } : formDraft);
            const servers = current.servers.some(item => String(item.id) === String(serverId))
                ? current.servers.map(item => String(item.id) === String(serverId) ? draft : item)
                : [...current.servers, draft];
            await saveMcpSettings({ ...current, servers });
            mcpSessions.delete(String(serverId));
            closeLegacySseSession(serverId);
            const updated = await loadMcpSettings();
            renderMcpSettingsPage(updated);
            if (String(activeMcpServerId) === String(serverId)) renderMcpServerDetail(updated, serverId);
            showDynamicIsland('MCP 服务器已保存');
            close();
        } catch (error) {
            showDynamicIsland(error?.message || '服务器配置保存失败');
        }
    });
    return settings;
}

async function updateGlobalControls() {
    const settings = await loadMcpSettings();
    return saveMcpSettings({
        ...settings,
        enabled: document.getElementById('mcp-enabled-toggle')?.checked !== false,
        maxRounds: document.getElementById('mcp-max-rounds-input')?.value,
        maxCalls: document.getElementById('mcp-max-calls-input')?.value,
        timeoutSeconds: document.getElementById('mcp-timeout-input')?.value,
        toolCallMode: document.getElementById('mcp-tool-call-mode-select')?.value,
        confirmWrites: document.getElementById('mcp-confirm-writes-toggle')?.checked !== false
    });
}

function closeAllMcpSessions(settings) {
    settings.servers.forEach(server => {
        mcpSessions.delete(String(server.id));
        closeLegacySseSession(server.id);
    });
}

function exportMcpSettings(settings) {
    const exportSettings = {
        ...settings,
        servers: settings.servers.map(server => ({ ...server, headers: {}, accessToken: '' }))
    };
    const payload = {
        format: 'looky-mcp-settings',
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: exportSettings
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `looky-mcp-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

async function importMcpSettingsFile(file) {
    if (!file) return null;
    if (file.size > 1024 * 1024) throw new Error('MCP 配置文件不能超过 1MB');
    const raw = JSON.parse(await file.text());
    const source = raw?.format === 'looky-mcp-settings' ? raw.settings : raw;
    if (!source || !Array.isArray(source.servers) || !source.tools || typeof source.tools !== 'object') {
        throw new Error('这不是有效的 LOOKY MCP 配置文件');
    }
    const imported = normalizeSettings(source);
    const current = await loadMcpSettings();
    const allowed = await showConfirmModal({
        title: '导入 MCP 配置',
        message: `将用文件中的 ${imported.servers.length} 个 MCP 连接替换当前 MCP 配置，其他应用数据不会改变。`,
        confirmText: '确认导入'
    });
    if (!allowed) return null;
    closeAllMcpSessions(current);
    return saveMcpSettings(imported);
}

async function testAllMcpServers() {
    const settings = await loadMcpSettings();
    if (!settings.servers.length) {
        showDynamicIsland('请先添加 MCP 服务器');
        return;
    }
    let successCount = 0;
    for (const server of settings.servers) {
        try {
            await testMcpServer(server);
            successCount += 1;
        } catch (error) {
            // 每个服务器单独记录失败状态，继续检测剩余连接。
        }
    }
    renderMcpSettingsPage(await loadMcpSettings(true));
    showDynamicIsland(`检测完成：${successCount}/${settings.servers.length} 个连接可用`);
}

export function initMcpSettingsPage() {
    const page = document.getElementById('page-mcp-settings');
    if (!page || page.dataset.bound === '1') return;
    page.dataset.bound = '1';
    document.getElementById('mcp-add-server-btn')?.addEventListener('click', () => openServerEditor());
    document.getElementById('mcp-test-all-btn')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = '检测中';
        try {
            await testAllMcpServers();
        } finally {
            button.disabled = false;
            button.textContent = '全部检测';
        }
    });
    document.getElementById('mcp-export-btn')?.addEventListener('click', async () => {
        exportMcpSettings(await loadMcpSettings(true));
        showDynamicIsland('MCP 配置已导出，请求头和密钥未包含');
    });
    const importInput = document.getElementById('mcp-import-input');
    document.getElementById('mcp-import-btn')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', async event => {
        try {
            const settings = await importMcpSettingsFile(event.target.files?.[0]);
            if (settings) {
                renderMcpSettingsPage(settings);
                showDynamicIsland('MCP 配置已导入');
            }
        } catch (error) {
            showDynamicIsland(error?.message || 'MCP 配置导入失败');
        } finally {
            event.target.value = '';
        }
    });
    ['mcp-enabled-toggle', 'mcp-tool-call-mode-select', 'mcp-max-rounds-input', 'mcp-max-calls-input', 'mcp-timeout-input', 'mcp-confirm-writes-toggle'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', async () => {
            const settings = await updateGlobalControls();
            renderMcpSettingsPage(settings);
            showDynamicIsland(id === 'mcp-enabled-toggle'
                ? (settings.enabled ? 'MCP 调用已开启' : 'MCP 调用已暂停，连接配置已保留')
                : 'MCP 全局参数已保存');
        });
    });
    document.getElementById('mcp-server-list')?.addEventListener('click', async event => {
        const serverItem = event.target.closest('[data-server-id]');
        if (!serverItem) return;
        const serverId = serverItem.dataset.serverId;
        const settings = await loadMcpSettings();
        const server = settings.servers.find(item => String(item.id) === String(serverId));
        if (!server) return;
        const action = event.target.closest('[data-mcp-action]')?.dataset.mcpAction;
        if (action === 'open-server') {
            activeMcpServerId = String(serverId);
            activeMcpToolRenderLimit = 50;
            renderMcpServerDetail(settings, serverId);
            showPage('page-mcp-server-detail');
        }
    });
    document.getElementById('mcp-server-detail')?.addEventListener('click', async event => {
        const action = event.target.closest('[data-mcp-action]')?.dataset.mcpAction;
        if (!action) return;
        const settings = await loadMcpSettings();
        const server = settings.servers.find(item => String(item.id) === String(activeMcpServerId));
        if (!server) return;
        const serverId = server.id;
        if (action === 'load-more-tools') {
            activeMcpToolRenderLimit += 50;
            renderMcpServerDetail(settings);
        } else if (action === 'edit-server') {
            await openServerEditor(server);
        } else if (action === 'test-server') {
            try {
                showDynamicIsland('正在测试 MCP 连接...');
                const result = await testMcpServer(server);
                const updated = await loadMcpSettings(true);
                renderMcpSettingsPage(updated);
                renderMcpServerDetail(updated);
                showDynamicIsland(`连接成功，读取到 ${result.tools.length} 个工具`);
            } catch (error) {
                renderMcpServerDetail(await loadMcpSettings(true));
                showDynamicIsland(error?.message || 'MCP 连接失败');
            }
        } else if (action === 'delete-server') {
            const allowed = await showConfirmModal({
                title: '删除 MCP 服务器',
                message: `将同时移除“${server.name}”下的工具配置，角色已有勾选会自动失效。`,
                confirmText: '确认删除',
                danger: true
            });
            if (!allowed) return;
            const tools = { ...settings.tools };
            Object.keys(tools).forEach(toolId => {
                if (String(tools[toolId]?.serverId) === String(serverId)) delete tools[toolId];
            });
            await saveMcpSettings({ ...settings, servers: settings.servers.filter(item => String(item.id) !== String(serverId)), tools });
            forgetInitializedMcpServer(serverId);
            renderMcpSettingsPage(await loadMcpSettings());
            activeMcpServerId = '';
            showPage('page-mcp-settings');
            showDynamicIsland('MCP 服务器已删除');
        } else if (action === 'toggle-permission') {
            const toolId = event.target.closest('[data-tool-id]')?.dataset.toolId;
            const tool = settings.tools[toolId];
            if (!tool) return;
            settings.tools[toolId] = { ...tool, permission: tool.permission === 'readonly' ? 'write' : 'readonly', permissionSource: 'manual', updatedAt: Date.now() };
            await saveMcpSettings(settings);
            renderMcpServerDetail(await loadMcpSettings());
        }
    });
    document.getElementById('mcp-server-detail')?.addEventListener('change', async event => {
        const settings = await loadMcpSettings();
        const serverId = event.target.dataset.mcpServerEnabled;
        const toolId = event.target.dataset.mcpToolEnabled;
        if (serverId) {
            settings.servers = settings.servers.map(server => String(server.id) === String(serverId) ? { ...server, enabled: event.target.checked } : server);
        } else if (toolId && settings.tools[toolId]) {
            settings.tools[toolId] = { ...settings.tools[toolId], enabled: event.target.checked, updatedAt: Date.now() };
        } else return;
        await saveMcpSettings(settings);
        const updated = await loadMcpSettings();
        renderMcpSettingsPage(updated);
        renderMcpServerDetail(updated);
    });
    window.addEventListener('looky:page-opened', async event => {
        if (event.detail?.pageId === 'page-mcp-settings') renderMcpSettingsPage(await loadMcpSettings(true));
        if (event.detail?.pageId === 'page-mcp-server-detail' && activeMcpServerId) renderMcpServerDetail(await loadMcpSettings(true));
    });
    loadMcpSettings().then(renderMcpSettingsPage);
}

async function renderRoleMcpSettings() {
    const container = document.getElementById('chat-mcp-tool-groups');
    if (!container) return;
    document.getElementById('chat-mcp-settings-panel')?.removeAttribute('open');
    const character = AppState.characterProfiles.find(item => String(item.id) === String(tempState.currentChatId));
    if (!character || character.isGroup) {
        container.innerHTML = '<p class="mcp-role-empty">当前页面没有可配置的单人角色。</p>';
        return;
    }
    const settings = await loadMcpSettings(true);
    const enabledServers = settings.servers.filter(server => server.enabled);
    const groups = enabledServers.map(server => ({
        server,
        tools: getToolsForServer(settings, server.id).filter(tool => tool.enabled)
    })).filter(group => group.tools.length > 0);
    const availableToolIds = groups.flatMap(group => group.tools.map(tool => String(tool.id)));
    const selected = new Set(Array.isArray(character.mcpToolIds)
        ? character.mcpToolIds.map(String)
        : (settings.enabled ? availableToolIds : []));
    container.innerHTML = groups.length ? groups.map(({ server, tools }) => `
        <section class="mcp-role-group" data-role-mcp-server-id="${escapeHTML(server.id)}">
            <header>
                <div><strong>${escapeHTML(server.name)}</strong><span>${tools.length} TOOLS</span></div>
                <div class="mcp-role-group-actions">
                    <button type="button" data-role-mcp-action="select-group">全选本组</button>
                    <button type="button" data-role-mcp-action="clear-group">清空</button>
                </div>
            </header>
            <div class="mcp-role-tool-list">
                ${tools.map(tool => `
                    <label class="mcp-role-tool-item">
                        <input type="checkbox" value="${escapeHTML(tool.id)}" ${selected.has(String(tool.id)) ? 'checked' : ''}>
                        <span><strong>${escapeHTML(tool.name)}</strong><small>${escapeHTML(getToolActionLabel(tool))} · ${tool.permission === 'readonly' ? '只读' : '可执行'}</small></span>
                    </label>
                `).join('')}
            </div>
        </section>
    `).join('') : '<p class="mcp-role-empty">暂无可选工具，请先到“设置 → MCP 工具”添加服务器并启用工具。</p>';
    const liveReply = document.getElementById('chat-mcp-live-reply-toggle');
    const maxRounds = document.getElementById('chat-mcp-max-rounds-input');
    const confirmMode = document.getElementById('chat-mcp-confirm-mode-select');
    if (liveReply) liveReply.checked = character.mcpLiveReplyEnabled === true;
    if (maxRounds) maxRounds.value = character.mcpMaxRounds ?? '';
    if (confirmMode) confirmMode.value = ['always', 'never'].includes(character.mcpConfirmMode) ? character.mcpConfirmMode : 'inherit';
}

export function setupRoleMcpSettings() {
    const panel = document.getElementById('chat-mcp-settings-panel');
    if (!panel || panel.dataset.bound === '1') return;
    panel.dataset.bound = '1';
    panel.addEventListener('click', event => {
        const action = event.target.closest('[data-role-mcp-action]')?.dataset.roleMcpAction;
        if (!action) return;
        const group = event.target.closest('[data-role-mcp-server-id]');
        if (!group) return;
        group.querySelectorAll('input[type="checkbox"]').forEach(input => {
            input.checked = action === 'select-group';
        });
    });
    document.getElementById('chat-mcp-save-btn')?.addEventListener('click', async () => {
        const character = AppState.characterProfiles.find(item => String(item.id) === String(tempState.currentChatId));
        if (!character) return;
        const toolIds = Array.from(panel.querySelectorAll('.mcp-role-tool-item input:checked')).map(input => input.value);
        const rawMaxRounds = document.getElementById('chat-mcp-max-rounds-input')?.value;
        const mcpMaxRounds = rawMaxRounds === '' ? null : clampInteger(rawMaxRounds, 1, 10, null);
        const mcpConfirmMode = document.getElementById('chat-mcp-confirm-mode-select')?.value || 'inherit';
        const mcpLiveReplyEnabled = document.getElementById('chat-mcp-live-reply-toggle')?.checked === true;
        const updates = { mcpToolIds: toolIds, mcpMaxRounds, mcpConfirmMode, mcpLiveReplyEnabled };
        Object.assign(character, updates);
        await db.characterProfiles.update(character.id, updates);
        showDynamicIsland('角色 MCP 工具设置已保存');
    });
    window.addEventListener('looky:page-opened', event => {
        if (event.detail?.pageId === 'page-chat-settings') renderRoleMcpSettings();
    });
    window.addEventListener('looky:mcp-settings-updated', () => {
        const page = document.getElementById('page-chat-settings');
        if (page && page.style.display !== 'none') renderRoleMcpSettings();
    });
}
