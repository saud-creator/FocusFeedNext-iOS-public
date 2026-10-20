// Request shapes and feature flags adapted from public-clis/twitter-cli (Apache-2.0).
// Transaction engine: Lqm1/x-client-transaction-id (MIT), vendored beside this file.
import ClientTransaction from './transaction';
import { RequestScheduler, type RequestContext } from './scheduler';
import { ClientTransactionInitializationError } from './errors';
import { NativeFetchError, providerFetch } from './transport';

class ConnectionFailure extends Error {
  code: string;
  stage: string;
  retryable: boolean;
  httpStatus: number | null;
  constructor(code: string, stage: string, retryable = true, httpStatus: number | null = null) {
    super(code); this.code = code; this.stage = stage; this.retryable = retryable; this.httpStatus = httpStatus;
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
  TweetResultByRestId: '7xflPyRiUxGVbJd4uWmbfg',
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
const requiredFeatures: Record<string, string[]> = {};
const metadataFlags: Record<string, boolean> = {};
let metadataDocument: Document | null = null;

function parseQueryMetadata(script: string) {
  // X rotates persisted query IDs and the required feature arguments. Parse
  // the query descriptors as data, including either property order.
  for (const match of script.matchAll(/(?:queryId\s*:\s*["']([A-Za-z0-9_-]+)["'][\s\S]{0,300}?operationName\s*:\s*["']([^"']+)["']|operationName\s*:\s*["']([^"']+)["'][\s\S]{0,300}?queryId\s*:\s*["']([A-Za-z0-9_-]+)["'])/g)) {
    const operation = match[2] ?? match[3];
    if (!(operation in queryIds)) continue;
    queryIds[operation] = match[1] ?? match[4];
    const after = script.slice(match.index! + match[0].length, match.index! + match[0].length + 4000);
    const switches = /^(?:(?!queryId|operationName)[\s\S]){0,500}?metadata\s*:\s*\{\s*featureSwitches\s*:\s*\[([^\]]{0,3500})\]/.exec(after)?.[1];
    if (switches) requiredFeatures[operation] = [...switches.matchAll(/["']([a-z][a-z0-9_]{0,127})["']/g)].map(m => m[1]).slice(0,100);
  }
}
function flagsFor(operation: string) {
  const flags = { ...(operation === 'UserByScreenName' ? profileFeatures : features) };
  if(operation==='TweetResultByRestId') Object.assign(flags,{articles_preview_enabled:true,responsive_web_twitter_article_tweet_consumption_enabled:true,longform_notetweets_consumption_enabled:true});
  for (const key of requiredFeatures[operation] ?? []) flags[key] = metadataFlags[key] ?? flags[key] ?? false;
  return flags;
}
function observeRateLimit(response: Response) {
  if (response.status !== 429) return;
  const reset = Number(response.headers.get('x-rate-limit-reset')) * 1000;
  rateLimitedUntil = Math.max(Date.now()+60000, Number.isFinite(reset) ? reset : 0);
}

async function boundedFetch(url: string, init: RequestInit = {}, requestId?: string) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 18000);
  try {
    const response = await providerFetch(url, { ...init, credentials: 'include', signal: controller.signal }, requestId);
    // Keep the timeout active through body consumption, not only response headers.
    const body = await response.text();
    return new Response(body || null, { status: response.status, headers: response.headers });
  }
  catch (error) {
    if (timedOut && !init.signal?.aborted) throw new ConnectionFailure('timeout',url === 'https://x.com/home' || url.startsWith('https://abs.twimg.com/') ? 'bootstrap' : 'provider');
    throw error;
  }
  finally { clearTimeout(timeout); init.signal?.removeEventListener('abort', abort); }
}
async function metadataFetch(url: string, init: RequestInit, requestId?: string) {
  for (let attempt=0; ; attempt++) {
    try {
      const response = await boundedFetch(url,init,requestId);
      if (attempt === 0 && [502,503,504].includes(response.status)) { if (init.signal) await pause(700,init.signal); continue; }
      return response;
    } catch (error) {
      const retryable = error instanceof NativeFetchError ? ['network_failure','timeout'].includes(error.fault.code) : error instanceof ConnectionFailure ? error.code === 'timeout' : error instanceof TypeError;
      if (attempt > 0 || init.signal?.aborted || !retryable) throw error;
      if (init.signal) await pause(700,init.signal);
    }
  }
}
async function initialize(force = false, signal?: AbortSignal, requestId?: string) {
  if (!force && transaction && Date.now() - initializedAt < 3600000) return;
  if (initialization) return initialization;
  initialization = (async () => {
    // The app-owned transport has no provider page. Fetch metadata only when a
    // GraphQL operation needs it; REST identity verification has no bootstrap.
    let doc = document;
    if (force || location.hostname !== 'x.com' || !doc.querySelector('[name="twitter-site-verification"]')) {
      const response = await metadataFetch('https://x.com/home', { signal }, requestId);
      observeRateLimit(response);
      if (!response.ok) throw new ConnectionFailure(response.status === 401 ? 'authentication_expired' : response.status === 429 ? 'rate_limited' : 'transaction_bootstrap', 'bootstrap', ![401,429].includes(response.status), response.status);
      doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    }
    const html = doc.documentElement.outerHTML;
    try { transaction = await ClientTransaction.create(doc, signal, ((url: RequestInfo | URL, init?: RequestInit) => metadataFetch(String(url),init ?? {},requestId)) as typeof fetch); }
    catch (error) {
      if (signal?.aborted || error instanceof NativeFetchError) throw error;
      throw new ConnectionFailure('transaction_bootstrap','bootstrap');
    }
    // Only data is parsed. No downloaded script is evaluated or installed.
    for (const match of html.matchAll(/"([a-z][a-z0-9_]+)":\s*\{\s*"value"\s*:\s*(true|false)/g)) {
      metadataFlags[match[1]] = match[2] === 'true';
      if (match[1] in features) features[match[1]] = match[2] === 'true';
      if (match[1] in profileFeatures) profileFeatures[match[1]] = match[2] === 'true';
    }
    metadataDocument = doc;
    // Refresh IDs before the first content request, so a working login does
    // not depend on the IDs bundled at the time the app was released.
    if (signal) await refreshQueryIds(signal,requestId,false);
    initializedAt = Date.now();
  })().finally(() => { initialization = null; });
  return initialization;
}
async function refreshQueryIds(signal: AbortSignal, requestId?: string, fresh = true) {
  let doc = metadataDocument;
  if (fresh || !doc) {
    const response = await metadataFetch('https://x.com/home',{signal},requestId);
    observeRateLimit(response);
    if (!response.ok) throw new ConnectionFailure(response.status === 429 ? 'rate_limited' : response.status === 401 ? 'authentication_expired' : 'transaction_bootstrap','bootstrap',![401,429].includes(response.status),response.status);
    doc = new DOMParser().parseFromString(await response.text(),'text/html');
    metadataDocument = doc;
  }
  parseQueryMetadata(doc.documentElement.outerHTML);
  const urls = [...new Set(Array.from(doc.querySelectorAll('script[src],link[href]')).map(node => node.getAttribute('src') ?? node.getAttribute('href') ?? '').filter(url => /^https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^/]*\/[A-Za-z0-9_.-]+\.js$/.test(url) && !url.includes('/ondemand.s.')))];
  urls.sort((a,b) => Number(/\/main[.-]/.test(b)) - Number(/\/main[.-]/.test(a)));
  // Main contains the persisted query descriptors; optional vendor bundles
  // are not required to establish an authenticated content connection.
  for (const url of urls.slice(0,4)) {
    const response = await metadataFetch(url,{signal},requestId);
    if (response.ok) parseQueryMetadata(await response.text());
    if (/\/main[.-]/.test(url)) break;
  }
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
    const failure = error instanceof NativeFetchError ? error.fault : error instanceof ConnectionFailure ? error
      : error instanceof ClientTransactionInitializationError ? new ConnectionFailure('transaction_bootstrap','bootstrap')
      : Date.now() >= context.deadline ? new ConnectionFailure('timeout','queue')
      : error instanceof Error && (error.message.includes('cancelled') || error.name === 'AbortError') ? new ConnectionFailure('cancelled','queue',false)
      : new ConnectionFailure('network_failure','provider');
    return { fault: { ...failure, code:failure.code, stage:failure.stage, requestId:context.id, retryable:failure.retryable, httpStatus:failure.httpStatus ?? null } };
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
  if (operation !== 'Me') await initialize(false, signal,context.id);
  timing.bootstrapMs = performance.now() - bootstrapStart;
  signal.throwIfAborted();
  for (let attempt = 0; attempt < 2; attempt++) {
    const isRest = ['Me', 'Follow', 'Unfollow'].includes(operation);
    const write = ['Follow', 'Unfollow', 'DeleteBookmark'].includes(operation);
    const method = write ? 'POST' : 'GET';
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
    const operationFeatures = flagsFor(operation);
    let body: string | undefined;
    if (write && isRest) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(variables as Record<string, string>).toString();
    } else if (method === 'POST') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify({ variables, features: operationFeatures, queryId: queryIds[operation] });
    } else if (!isRest) {
      const params=new URLSearchParams({ variables: JSON.stringify(variables), features: JSON.stringify(operationFeatures) });
      if(operation==='TweetResultByRestId') params.set('fieldToggles',JSON.stringify({withArticleRichContentState:true,withArticlePlainText:true}));
      url += '?' + params;
    }
    signal.throwIfAborted();
    sent();
    const providerStart = performance.now();
    let response: Response;
    // Swift already tries native REST identity first. Keep its independent
    // WebKit identity fallback; content and metadata use native HTTP.
    try { response = await boundedFetch(url, { method, headers, body, signal },operation === 'Me' ? undefined : context.id); }
    catch (error) {
      timing.providerMs += performance.now() - providerStart;
      if (signal.aborted) throw error;
      if (error instanceof NativeFetchError && !['network_failure','timeout'].includes(error.fault.code)) throw error;
      if (attempt === 0 && !write) { await pause(700,signal); continue; }
      if (error instanceof NativeFetchError) throw error;
      throw new ConnectionFailure('network_failure','provider');
    }
    timing.providerMs += performance.now() - providerStart;
    if ([502,503,504].includes(response.status) && attempt === 0 && !write) { await pause(700,signal); continue; }
    if (response.status === 404 && attempt === 0 && !isRest && !write) {
      await refreshQueryIds(signal,context.id); continue;
    }
    const parseStart = performance.now();
    let data: unknown = {};
    try { data = await response.json(); } catch {
      if (response.ok) throw new ConnectionFailure('unsupported_response','provider',false);
    }
    // Some provider deployments require transaction metadata even for REST.
    // Try it once after a refusal; preserve the real HTTP error if unavailable.
    if (operation === 'Me' && response.status === 403 && !transaction && attempt === 0) {
      try { await initialize(false,signal,context.id); } catch { signal.throwIfAborted(); }
      if (transaction) continue;
    }
    timing.parseMs += performance.now() - parseStart;
    observeRateLimit(response);
    timing.totalMs = performance.now() - start;
    recentTimings.push(timing); if (recentTimings.length > 32) recentTimings.shift();
    return { status: response.status, body: data, timing };
  }
  throw new Error('Twitter changed this endpoint. Please reconnect or update the app.');
}
