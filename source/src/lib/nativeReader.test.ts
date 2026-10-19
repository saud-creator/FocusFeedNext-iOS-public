/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

const frame = `<svg id="loading-x-anim-0"><g><path/><path d="M0000000010 20 30 40 50 60 70 80 90 100 110${'C10 20 30 40 50 60 70 80 90 100 110'.repeat(15)}"/></g></svg>`;
const home = `<html><head><meta name="twitter-site-verification" content="${btoa('\0'.repeat(32))}"><script src="https://abs.twimg.com/responsive-web/client-web/ondemand.s.fixturehasha.js"></script></head><body>${[0,1,2,3].map(i=>frame.replace('anim-0',`anim-${i}`)).join('')}</body></html>`;
const context = (id='1') => ({id,generation:1,priority:1,deadline:Date.now()+75000});
beforeEach(() => { vi.resetModules(); vi.stubGlobal('crypto',webcrypto); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function fixture(handler: (url:string,init?:RequestInit)=>Response = () => Response.json({users:[{user_id:'42',screen_name:'fixture'}]})) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'https://x.com/home') return new Response(home);
    if (url.includes('ondemand.s.')) return new Response('(keyBytes[0],16)(keyBytes[1],16)');
    if (!url.includes('multi/list.json')) expect((init?.headers as Record<string,string> | undefined)?.['x-client-transaction-id']).toMatch(/^[A-Za-z0-9+/]+$/);
    return handler(url,init);
  });
}
describe('production native reader engine', () => {
  it('keeps WebKit REST identity as an independent fallback when native identity did not complete', async()=>{
    const browserFetch=vi.fn(async()=>Response.json({users:[{user_id:'42',screen_name:'fixture'}]}));
    const native=vi.fn();
    vi.stubGlobal('fetch',browserFetch);
    vi.stubGlobal('webkit',{messageHandlers:{ffnHttp:{postMessage:native}}});
    const reader=await import('../../src-tauri/plugins/ios-reader/transaction/reader');
    expect(await reader.requestSafe('Me',{},'fixture',context())).toMatchObject({status:200});
    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(native).not.toHaveBeenCalled();
  });
  it('loads current timeline IDs and newly required flags before requesting content', async () => {
    const fetch = vi.fn(async(url:string, init?:RequestInit) => {
      if (url === 'https://x.com/home') return new Response(home.replace('</head>', '<link href="https://abs.twimg.com/responsive-web/client-web/vendor.a.js"><script src="https://abs.twimg.com/responsive-web/client-web/main.new.js"></script><script>var flags={"new_feed_flag":{"value":true}}</script></head>'));
      if (url.includes('ondemand.s.')) return new Response('(keyBytes[0],16)(keyBytes[1],16)');
      if (url.includes('main.new.js')) return new Response('queryId:"currentTimeline",operationName:"HomeLatestTimeline",operationType:"query",metadata:{featureSwitches:["new_feed_flag"]};operationName:"Following",queryId:"currentFollowing"');
      expect(init?.method).toBe('GET');
      if (url.includes('HomeLatestTimeline')) {
        expect(new URL(url).pathname).toBe('/i/api/graphql/currentTimeline/HomeLatestTimeline');
        expect(JSON.parse(new URL(url).searchParams.get('features')!)).toMatchObject({new_feed_flag:true});
      } else expect(new URL(url).pathname).toBe('/i/api/graphql/currentFollowing/Following');
      return Response.json({data:{timeline:{posts:['live-post']}}});
    });
    vi.stubGlobal('fetch',fetch);
    const reader = await import('../../src-tauri/plugins/ios-reader/transaction/reader');
    expect(await reader.requestSafe('HomeLatestTimeline',{count:30},'fixture',context())).toMatchObject({status:200,body:{data:{timeline:{posts:['live-post']}}}});
    expect(await reader.requestSafe('Following',{userId:'42'},'fixture',context('2'))).toMatchObject({status:200});
    expect(fetch.mock.calls.some(([url]) => url.includes('vendor.a.js'))).toBe(false);
  });
  it('uses the native HTTP bridge for bootstrap, CDN metadata and content and preserves its error details', async () => {
    const browserFetch = vi.fn(()=>{ throw new Error('WebKit fetch must not run'); });
    vi.stubGlobal('fetch',browserFetch);
    const native = vi.fn(async(message:Record<string,unknown>) => {
      expect(message.requestId).toBe('1');
      expect(message.headers).not.toHaveProperty('x-csrf-token');
      if (message.url === 'https://x.com/home') return {status:200,text:home,headers:{}};
      if (String(message.url).includes('ondemand.s.')) return {status:200,text:'(keyBytes[0],16)(keyBytes[1],16)',headers:{}};
      return {fault:{code:'provider_rejection',stage:'provider',retryable:false,httpStatus:403,nativeErrorDomain:'url',nativeErrorCode:-1009}};
    });
    vi.stubGlobal('webkit',{messageHandlers:{ffnHttp:{postMessage:native}}});
    const reader = await import('../../src-tauri/plugins/ios-reader/transaction/reader');
    expect(await reader.requestSafe('HomeLatestTimeline',{count:30},'fixture-secret',context())).toMatchObject({fault:{code:'provider_rejection',stage:'provider',httpStatus:403,nativeErrorCode:-1009,requestId:'1'}});
    expect(browserFetch).not.toHaveBeenCalled();
    expect(native.mock.calls).toHaveLength(3);
    expect(JSON.stringify(native.mock.calls)).not.toContain('fixture-secret');
  });
  it('preserves a homepage rate limit without attempting transaction metadata or a feed request',async()=>{
    const fetch = vi.fn(async()=>Response.json({}, {status:429})); vi.stubGlobal('fetch',fetch);
    const reader = await import('../../src-tauri/plugins/ios-reader/transaction/reader');
    expect(await reader.requestSafe('HomeLatestTimeline',{},'fixture',context())).toMatchObject({fault:{code:'rate_limited',stage:'bootstrap',httpStatus:429}});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bootstraps the real transaction generator, uses profile-specific flags and reuses initialization', async () => {
    const fetch = fixture(url=>Response.json(url.includes('UserByScreenName') ? {data:{user:{result:{rest_id:'42'}}}} : {users:[{user_id:'42',screen_name:'fixture'}]}));
    vi.stubGlobal('fetch',fetch);
    const reader = await import('../../src-tauri/plugins/ios-reader/transaction/reader');
    expect(await reader.requestSafe('Me',{},'fixture-csrf',context())).toMatchObject({status:200});
    expect(await reader.requestSafe('UserByScreenName',{screen_name:'fixture'},'fixture-csrf',context('2'))).toMatchObject({status:200});
    const url = fetch.mock.calls.map(([url])=>url).find(url=>url.includes('UserByScreenName'))!;
    const flags = JSON.parse(new URL(url).searchParams.get('features')!);
    expect(flags.subscriptions_verification_info_verified_since_enabled).toBe(true);
    expect(fetch.mock.calls.filter(([url])=>url==='https://x.com/home')).toHaveLength(1);
    expect(reader.metrics()).toHaveLength(2);
    expect(JSON.stringify(reader.metrics())).not.toContain('fixture-csrf');
  });
  it('returns a safe bootstrap fault without exposing document or cookie text', async () => {
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('<html>auth_token=secret</html>')));
    const reader = await import('../../src-tauri/plugins/ios-reader/transaction/reader');
    const result = await reader.requestSafe('UserByScreenName',{screen_name:'fixture'},'ct0-secret',context());
    expect(result).toMatchObject({fault:{code:'transaction_bootstrap',stage:'bootstrap'}});
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('validates cookie authentication without requiring a homepage or profile metadata',async()=>{
    const fetch = vi.fn(async(url:string,init?:RequestInit)=>{
      expect(url).toBe('https://x.com/i/api/1.1/account/multi/list.json');
      expect(((init?.headers ?? {}) as Record<string,string>)['x-csrf-token']).toBe('current-csrf');
      return Response.json({users:[{user_id:'42',screen_name:'fixture',name:'Fixture'}]});
    });
    vi.stubGlobal('fetch',fetch);
    const reader = await import('../../src-tauri/plugins/ios-reader/transaction/reader');
    expect(await reader.requestSafe('Me',{},'current-csrf',context())).toMatchObject({status:200,body:{users:[{user_id:'42'}]}});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves an authentication refusal instead of replacing it with a bootstrap failure',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({errors:[{code:89}]},{status:401})));
    const reader = await import('../../src-tauri/plugins/ios-reader/transaction/reader');
    expect(await reader.requestSafe('Me',{},'fixture',context())).toMatchObject({status:401,body:{errors:[{code:89}]}});
  });
  it('retries refused REST identity with transaction metadata once, when available',async()=>{
    let reads=0;
    vi.stubGlobal('fetch',fixture(()=>++reads === 1 ? Response.json({}, {status:403}) : Response.json({users:[{user_id:'42',screen_name:'fixture'}]})));
    const reader = await import('../../src-tauri/plugins/ios-reader/transaction/reader');
    expect(await reader.requestSafe('Me',{},'fixture',context())).toMatchObject({status:200});
    expect(reads).toBe(2);
  });
  it('retries a transient read once and never replays a sent write', async () => {
    let reads=0,writes=0;
    vi.stubGlobal('fetch',fixture(url=>{
      if (url.includes('create.json')) { writes++; throw new TypeError('lost response'); }
      if (++reads===1) throw new TypeError('network');
      return Response.json({users:[]});
    }));
    const reader = await import('../../src-tauri/plugins/ios-reader/transaction/reader');
    expect(await reader.requestSafe('Me',{},'fixture',context())).toMatchObject({status:200});
    expect(reads).toBe(2);
    expect(await reader.requestSafe('Follow',{screen_name:'fixture'},'fixture',context('2'))).toMatchObject({fault:{code:'network_failure'}});
    expect(writes).toBe(1);
  });
  it('stops on rate limits and does not accept malformed successful responses', async () => {
    const fetch = fixture(()=>new Response('not json',{status:200})); vi.stubGlobal('fetch',fetch);
    const reader = await import('../../src-tauri/plugins/ios-reader/transaction/reader');
    expect(await reader.requestSafe('Me',{},'fixture',context())).toMatchObject({fault:{code:'unsupported_response'}});
    fetch.mockImplementation(fixture(()=>Response.json({}, {status:429})));
    expect(await reader.requestSafe('Me',{},'fixture',context('2'))).toMatchObject({status:429});
    const count=fetch.mock.calls.length;
    expect(await reader.requestSafe('Me',{},'fixture',context('3'))).toMatchObject({status:429});
    expect(fetch).toHaveBeenCalledTimes(count);
  });
});
