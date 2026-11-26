export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // 遇到 /api 请求，就去连 DeepSeek
    if (url.pathname === '/api') {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      try {
        const requestBody = await request.json();
        const upstream = await fetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.DEEPSEEK_API_KEY}`,
          },
          body: JSON.stringify(requestBody),
        });

        return new Response(upstream.body, {
          status: upstream.status,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*"
          },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }
    
    // 其他请求就返回你的网页
    return env.ASSETS.fetch(request);
  }
};