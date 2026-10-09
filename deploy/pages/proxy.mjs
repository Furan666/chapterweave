const API_PATHS = new Set(['/api/status', '/api/search', '/api/plan', '/api/recover']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS?.fetch(request) || new Response('Site unavailable', { status: 503 });
    }
    if (!API_PATHS.has(url.pathname)) {
      return new Response('Not found', { status: 404 });
    }
    if (!env.BACKEND?.fetch) {
      return new Response('API unavailable', { status: 503 });
    }
    // The backend has no public route. Only these headers pass through to it.
    const headers = new Headers();
    headers.set('x-chapterweave-client-ip', request.headers.get('cf-connecting-ip') || 'unknown');
    if (request.headers.has('content-type')) {
      headers.set('content-type', request.headers.get('content-type'));
    }
    try {
      const forwarded = new Request(request, { headers });
      return await env.BACKEND.fetch(forwarded);
    } catch {
      return new Response('API unavailable', { status: 503 });
    }
  },
};
