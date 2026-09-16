function corsHeaders(allowedOrigin) {
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-Requested-With, *',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version, Content-Type',
    'Vary': 'Origin'
  };
}

const NATIVE_ORIGINS = new Set([
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'https://localhost',
  'null'
]);

function validateTargetUrl(rawUrl, baseUrl) {
  const targetUrl = new URL(rawUrl, baseUrl);
  if (!['http:', 'https:'].includes(targetUrl.protocol)
    || targetUrl.username
    || targetUrl.password
    || isPrivateHost(targetUrl.hostname)) throw new Error('目标地址不可代理');
  return targetUrl;
}

async function fetchSafeTarget(initialUrl, init) {
  let targetUrl = initialUrl;
  let method = init.method;
  let body = init.body;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const response = await fetch(targetUrl.toString(), { ...init, method, body, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location || redirectCount === 3) throw new Error('MCP 重定向无效或次数过多');
    targetUrl = validateTargetUrl(location, targetUrl);
    if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) {
      method = 'GET';
      body = undefined;
    }
  }
  throw new Error('MCP 重定向次数过多');
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host.startsWith('::ffff:')) return isPrivateHost(host.slice(7));
  return host === 'localhost'
    || host === '::1'
    || host === '0.0.0.0'
    || host === '127.0.0.1'
    || host.startsWith('127.')
    || host.startsWith('10.')
    || host.startsWith('192.168.')
    || host.startsWith('169.254.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
    || (host.includes(':') && /^(fc|fd|fe[89ab])/i.test(host));
}

export async function onRequest(context) {
  const { request } = context;
  const requestUrl = new URL(request.url);
  const requestOrigin = request.headers.get('origin');
  const isAllowedOrigin = !requestOrigin
    || requestOrigin === requestUrl.origin
    || NATIVE_ORIGINS.has(requestOrigin);
  const headers = corsHeaders(requestOrigin && isAllowedOrigin ? requestOrigin : requestUrl.origin);
  if (!isAllowedOrigin) return new Response(JSON.stringify({ error: '不允许跨站使用 MCP 代理' }), { status: 403, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (!['GET', 'POST'].includes(request.method)) return new Response(JSON.stringify({ error: '仅支持 GET / POST 请求' }), { status: 405, headers: { ...headers, 'Content-Type': 'application/json' } });

  const target = requestUrl.searchParams.get('target');
  let targetUrl;
  try {
    targetUrl = validateTargetUrl(target || '');
  } catch (error) {
    return new Response(JSON.stringify({ error: '目标地址无效或不允许代理' }), { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } });
  }

  const forwardHeaders = new Headers();
  request.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    const isBrowserIdentityHeader = lowerKey === 'cookie'
      || lowerKey === 'cookie2'
      || lowerKey === 'user-agent'
      || lowerKey === 'accept-language'
      || lowerKey === 'accept-encoding'
      || lowerKey === 'forwarded'
      || lowerKey.startsWith('sec-')
      || lowerKey.startsWith('cf-')
      || lowerKey.startsWith('x-forwarded-');
    if (!isBrowserIdentityHeader && !['host', 'content-length', 'origin', 'referer', 'connection'].includes(lowerKey)) forwardHeaders.set(key, value);
  });
  forwardHeaders.set('Accept', 'application/json, text/event-stream');

  try {
    const declaredLength = Number(request.headers.get('content-length')) || 0;
    if (declaredLength > 2 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: 'MCP 请求内容不能超过 2MB' }), { status: 413, headers: { ...headers, 'Content-Type': 'application/json' } });
    }
    const requestBody = request.method === 'POST' ? await request.arrayBuffer() : undefined;
    if (requestBody && requestBody.byteLength > 2 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: 'MCP 请求内容不能超过 2MB' }), { status: 413, headers: { ...headers, 'Content-Type': 'application/json' } });
    }
    const response = await fetchSafeTarget(targetUrl, {
      method: request.method,
      headers: forwardHeaders,
      body: requestBody
    });
    const responseHeaders = new Headers(headers);
    responseHeaders.set('Cache-Control', 'no-store');
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'set-cookie') responseHeaders.set(key, value);
    });
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'MCP 服务器无法连接' }), { status: 502, headers: { ...headers, 'Content-Type': 'application/json' } });
  }
}
