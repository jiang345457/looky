export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  const requestOrigin = request.headers.get('origin');
  const allowedOrigins = new Set([
    url.origin,
    'capacitor://localhost',
    'ionic://localhost',
    'http://localhost',
    'https://localhost',
    'null'
  ]);
  const isAllowedOrigin = !requestOrigin || allowedOrigins.has(requestOrigin);
  const corsOrigin = requestOrigin && isAllowedOrigin ? requestOrigin : url.origin;
  const corsHeaders = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Type',
    'Vary': 'Origin'
  };

  if (!isAllowedOrigin) {
    return new Response(JSON.stringify({ error: '不允许跨站使用 MiniMax 代理' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'MiniMax 代理仅支持 POST 请求' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // 1. 解析目标地址
  // 这里的逻辑是：把 /minimax-api/v1/xxxx 替换成 https://api.minimaxi.com/v1/xxxx
  const targetPath = url.pathname.replace('/minimax-api', '');
  if (targetPath !== '/v1/t2a_v2') {
    return new Response(JSON.stringify({ error: 'MiniMax 代理路径无效' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  const targetUrl = `https://api.minimaxi.com${targetPath}${url.search}`;

  // 2. 创建一个新的请求对象
  // 必须重新构建请求，才能把 POST 的数据(body)和头信息(headers)完美转发过去
  const forwardHeaders = new Headers();
  const authorization = request.headers.get('authorization');
  const contentType = request.headers.get('content-type');
  if (!authorization) {
    return new Response(JSON.stringify({ error: '缺少 MiniMax API 鉴权信息' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  if (authorization) forwardHeaders.set('Authorization', authorization);
  if (contentType) forwardHeaders.set('Content-Type', contentType);
  const proxyRequest = new Request(targetUrl, {
    method: request.method, // 继承 POST 方法
    headers: forwardHeaders,
    body: request.body, // 继承发送的数据
  });

  // 3. 发送给 Minimax 并等待结果
  try {
    const response = await fetch(proxyRequest);
    
    // 4. 把结果原封不动地返回给你的网页
    // 这里重新构建响应，是为了规避一些潜在的 CORS 问题
    const newResponse = new Response(response.body, response);
    Object.entries(corsHeaders).forEach(([key, value]) => newResponse.headers.set(key, value));
    return newResponse;
    
  } catch (err) {
    return new Response(JSON.stringify({ error: 'MiniMax API 无法连接' }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
