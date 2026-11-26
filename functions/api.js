// Cloudflare Pages Function：/api 代理到 DeepSeek。
// 行为对齐 src/worker.js：同样的请求体透传、上游地址、响应头与错误语义，
// 只是静态资源交给 Pages 托管，这里只处理 /api 一个路由。
const UPSTREAM = 'https://api.deepseek.com/v1/chat/completions';
// 比前端 45 秒略短：让代理先把「上游超时」讲清楚，避免浏览器干等到自己断开
const UPSTREAM_TIMEOUT_MS = 40000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: '只支持 POST' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  const key = env && env.DEEPSEEK_API_KEY;
  if (!key) {
    // 不静默失败：直接把原因告诉前端，避免上游返回一个看不懂的 401
    return new Response(JSON.stringify({ error: 'DEEPSEEK_API_KEY 未配置' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  try {
    const requestBody = await request.json();
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    const timedOut = !!err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return new Response(JSON.stringify({
      error: timedOut ? '上游响应超时' : ((err && err.message) || '代理请求失败'),
      code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR',
    }), {
      status: timedOut ? 504 : 500,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }
}
