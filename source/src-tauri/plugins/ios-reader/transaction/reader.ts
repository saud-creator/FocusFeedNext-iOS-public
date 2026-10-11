// Request shapes and feature flags adapted from public-clis/twitter-cli (Apache-2.0).
// Transaction engine: Lqm1/x-client-transaction-id (MIT), vendored beside this file.
import ClientTransaction from './transaction';
import { RequestScheduler, type RequestContext } from './scheduler';
import { ClientTransactionInitializationError } from './errors';

class ConnectionFailure extends Error {
  code: string;
  stage: string;
  retryable: boolean;
  constructor(code: string, stage: string, retryable = true) {
    super(code); this.code = code; this.stage = stage; this.retryable = retryable;
  }
}
interface Timing { requestId: string; queueMs: number; bootstrapMs: number; providerMs: number; parseMs: number; totalMs: number }
const recentTimings: Timing[] = [];
export function metrics() { return recentTimings.slice(); }
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(new ConnectionFailure('cancelled','queue',false)); };
    const timer = setTimeout(() => { signal.removeEventListener('abort',abort); resolve(); },ms);
    signal.addEventListener('abort',abort,{once:true});
  });
}

const queryIds: Record<string, string> = {
  HomeTimeline: 'c-CzHF1LboFilMpsx4ZCrQ', HomeLatestTimeline: 'BKB7oi212Fi7kQtCBGE4zA',
  UserByScreenName: '1VOOyvKkiI3FMmkeDNxM9A', UserTweets: 'q6xj5bs0hapm9309hexA_g',
  Bookmarks: '2neUNDqrrFzbLui8yallcQ', ListLatestTweetsTimeline: 'RlZzktZY_9wJynoepm8ZsA',
  Following: 'zx6e-TLzRkeDO_a7p4b3JQ', DeleteBookmark: 'Wlmlj2-xzyS1GN3a6cj-mQ',
};
const features: Record<string, boolean> = {
  responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true, responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  c9s_tweet_anatomy_moderator_badge_enabled: true, tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true, graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true, longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true, tweet_awards_web_tipping_enabled: false,
  longform_notetweets_rich_text_read_enabled: true, longform_notetweets_inline_media_enabled: true,
  rweb_video_timestamps_enabled: true, responsive_web_media_download_video_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true, standardized_nudges_misinfo: true,
  responsive_web_enhance_cards_enabled: false,
};
const profileFeatures: Record<string, boolean> = {
  hidden_profile_subscriptions_enabled: true, rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true, highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true, subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};
// Public web-client application identifier, not a user credential.
const bearer = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
let transaction: ClientTransaction | null = null;
let initializedAt = 0;
let initialization: Promise<void> | null = null;
let nextRequestAt = 0;
let rateLimitedUntil = 0;

async function boundedFetch(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(url, { ...init, credentials: 'include', signal: controller.signal });
    // Keep the timeout active through body consumption, not only response headers.
    const body = await response.text();
    return new Response(body || null, { status: response.status, headers: response.headers });
  }
  finally { clearTimeout(timeout); init.signal?.removeEventListener('abort', abort); }
}
async function initialize(force = false, signal?: AbortSignal) {
  if (!force && transaction && Date.now() - initializedAt < 3600000) return;
  if (initialization) return initialization;
  initialization = (async () => {
    // The app-owned transport has no provider page. Fetch metadata only when a
    // GraphQL operation needs it; REST identity verification has no bootstrap.
    let doc = document;
    if (force || location.hostname !== 'x.com' || !doc.querySelector('[name="twitter-site-verification"]')) {
      const response = await boundedFetch('https://x.com/home', { signal });
      if (!response.ok) throw new ConnectionFailure(response.status === 401 ? 'authentication_expired' : 'transaction_bootstrap', 'bootstrap', response.status !== 401);
      doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    }
    const html = doc.documentElement.outerHTML;
    try { transaction = await ClientTransaction.create(doc, signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      throw new ConnectionFailure('transaction_bootstrap','bootstrap');
    }
    // Only data is parsed. No downloaded script is evaluated or installed.
    for (const match of html.matchAll(/"([a-z][a-z0-9_]+)":\s*\{\s*"value"\s*:\s*(true|false)/g)) {
      if (match[1] in features) features[match[1]] = match[2] === 'true';
      if (match[1] in profileFeatures) profileFeatures[match[1]] = match[2] === 'true';
    }
    initializedAt = Date.now();
  })().finally(() => { initialization = null; });
  return initialization;
}
async function refreshQueryIds(signal: AbortSignal) {
  const response = await boundedFetch('https://x.com/home', { signal });
  const html = await response.text();
  const urls = [...new Set([...html.matchAll(/(?:src|href)=["'](https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"']+\.js)["']/g)].map(m => m[1]))].slice(0, 3);
  await Promise.all(urls.map(async url => {
    const script = await (await boundedFetch(url, { signal })).text();
    for (const match of script.matchAll(/queryId:\s*"([A-Za-z0-9_-]+)"[^}]{0,200}operationName:\s*"([^"]+)"/g)) {
      if (match[2] in queryIds) queryIds[match[2]] = match[1];
    }
  }));
}

const queue = new RequestScheduler();
export function cancel(id?: string, all = false, beforeGeneration = Infinity) { queue.cancel(id, all, beforeGeneration); }
export function request(operation: string, variables: Record<string, unknown>, csrf: string, context: RequestContext) {
  const write = ['Follow', 'Unfollow', 'DeleteBookmark'].includes(operation);
  const key = JSON.stringify([operation, Object.entries(variables).sort(([a],[b]) => a.localeCompare(b)), csrf]);
  const start = performance.now();
  return queue.enqueue(context, write, key, (signal,sent) => perform(operation, variables, csrf, signal,sent,context,start));
}
export async function requestSafe(operation: string, variables: Record<string, unknown>, csrf: string, context: RequestContext) {
  try { return await request(operation,variables,csrf,context); }
  catch (error) {
    const failure = error instanceof ConnectionFailure ? error
      : error instanceof ClientTransactionInitializationError ? new ConnectionFailure('transaction_bootstrap','bootstrap')
      : Date.now() >= context.deadline ? new ConnectionFailure('timeout','queue')
      : error instanceof Error && (error.message.includes('cancelled') || error.name === 'AbortError') ? new ConnectionFailure('cancelled','queue',false)
      : new ConnectionFailure('network_failure','provider');
    return { fault: { code:failure.code, stage:failure.stage, requestId:context.id, retryable:failure.retryable, httpStatus:null } };
  }
}
async function perform(operation: string, variables: Record<string, unknown>, csrf: string, signal: AbortSignal, sent: () => void, context: RequestContext, start: number) {
  const timing: Timing = { requestId:context.id, queueMs:performance.now()-start, bootstrapMs:0, providerMs:0, parseMs:0, totalMs:0 };
  if (!(operation in queryIds) && !['Me', 'Follow', 'Unfollow'].includes(operation)) throw new ConnectionFailure('unsupported_response','bridge',false);
  if (Date.now() < rateLimitedUntil) return { status: 429, body: {} };
  // Small pages are queued by Rust; a shared budget also covers all native callers.
  await pause(Math.max(0, nextRequestAt - Date.now()),signal);
  timing.queueMs = performance.now()-start;
  signal.throwIfAborted();
  nextRequestAt = Date.now() + 700;
  const bootstrapStart = performance.now();
  // Cookie authentication is checked by the REST identity endpoint. Optional
  // GraphQL metadata and profile enrichment must not make a valid login fail.
  if (operation !== 'Me') await initialize(false, signal);
  timing.bootstrapMs = performance.now() - bootstrapStart;
  signal.throwIfAborted();
  for (let attempt = 0; attempt < 2; attempt++) {
    const isRest = ['Me', 'Follow', 'Unfollow'].includes(operation);
    const write = ['Follow', 'Unfollow', 'DeleteBookmark'].includes(operation);
    const method = write || operation === 'Following' ? 'POST' : 'GET';
    const path = operation === 'Me' ? '/i/api/1.1/account/multi/list.json'
      : operation === 'Follow' ? '/i/api/1.1/friendships/create.json'
      : operation === 'Unfollow' ? '/i/api/1.1/friendships/destroy.json'
      : `/i/api/graphql/${queryIds[operation]}/${operation}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${bearer}`, 'x-csrf-token': csrf,
      'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
    };
    if (transaction) headers['x-client-transaction-id'] = await transaction.generateTransactionId(method, path);
    let url = `https://x.com${path}`;
    const operationFeatures = operation === 'UserByScreenName' ? profileFeatures : features;
    let body: string | undefined;
    if (write && isRest) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(variables as Record<string, string>).toString();
    } else if (method === 'POST') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify({ variables, features: operationFeatures, queryId: queryIds[operation] });
    } else if (!isRest) {
      url += '?' + new URLSearchParams({ variables: JSON.stringify(variables), features: JSON.stringify(operationFeatures) });
    }
    signal.throwIfAborted();
    sent();
    const providerStart = performance.now();
    let response: Response;
    try { response = await boundedFetch(url, { method, headers, body, signal }); }
    catch (error) {
      timing.providerMs += performance.now() - providerStart;
      if (signal.aborted) throw error;
      if (attempt === 0 && !write) { await pause(700,signal); continue; }
      throw new ConnectionFailure('network_failure','provider');
    }
    timing.providerMs += performance.now() - providerStart;
    if ([502,503,504].includes(response.status) && attempt === 0 && !write) { await pause(700,signal); continue; }
    if (response.status === 404 && attempt === 0 && !isRest && !write) {
      await refreshQueryIds(signal); continue;
    }
    const parseStart = performance.now();
    let data: unknown = {};
    try { data = await response.json(); } catch {
      if (response.ok) throw new ConnectionFailure('unsupported_response','provider',false);
    }
    // Some provider deployments require transaction metadata even for REST.
    // Try it once after a refusal; preserve the real HTTP error if unavailable.
    if (operation === 'Me' && response.status === 403 && !transaction && attempt === 0) {
      try { await initialize(false,signal); } catch { signal.throwIfAborted(); }
      if (transaction) continue;
    }
    timing.parseMs += performance.now() - parseStart;
    if (response.status === 429) {
      const reset = Number(response.headers.get('x-rate-limit-reset')) * 1000;
      rateLimitedUntil = Math.max(Date.now() + 60000, Number.isFinite(reset) ? reset : 0);
    }
    timing.totalMs = performance.now() - start;
    recentTimings.push(timing); if (recentTimings.length > 32) recentTimings.shift();
    return { status: response.status, body: data, timing };
  }
  throw new Error('Twitter changed this endpoint. Please reconnect or update the app.');
}
