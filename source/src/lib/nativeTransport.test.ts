import { afterEach, describe, expect, it, vi } from 'vitest';
import { providerFetch } from '../../src-tauri/plugins/ios-reader/transaction/transport';
afterEach(()=>vi.unstubAllGlobals());
describe('native HTTP bridge cancellation',()=>{
  it('interrupts an outstanding native request and identifies precisely the job to cancel',async()=>{
    const postMessage=vi.fn((message:Record<string,unknown>)=> message.action === 'cancel' ? Promise.resolve({status:204,text:'',headers:{}}) : new Promise<never>(()=>{}));
    vi.stubGlobal('webkit',{messageHandlers:{ffnHttp:{postMessage}}});
    const controller=new AbortController();
    const request=providerFetch('https://x.com/home',{signal:controller.signal},'17');
    controller.abort();
    await expect(request).rejects.toMatchObject({name:'AbortError'});
    expect(postMessage.mock.calls[1][0]).toMatchObject({action:'cancel',requestId:'17',jobId:postMessage.mock.calls[0][0].jobId});
  });
});
