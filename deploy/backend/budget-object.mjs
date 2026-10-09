import { DurableObject } from 'cloudflare:workers';
import { initializeBudget } from './budget-core.mjs';
import { createCachedQlooFetch, initializeCache } from './cache-core.mjs';

export class QlooBudget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    initializeBudget(ctx.storage);
    initializeCache(ctx.storage);
    this.keyConfigured = Boolean(env.QLOO_API_KEY);
    this.fetchQloo = createCachedQlooFetch(ctx.storage, env.QLOO_API_KEY);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/request') {
      return new Response(null, { status: 404 });
    }
    if (!this.keyConfigured) return new Response(null, { status: 503 });
    try {
      const address = await request.text();
      if (address.length > 2048) return new Response(null, { status: 413 });
      return await this.fetchQloo(address);
    } catch {
      return new Response(null, { status: 503 });
    }
  }
}
