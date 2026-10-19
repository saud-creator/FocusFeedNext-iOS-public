import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestScheduler, type RequestContext } from '../../src-tauri/plugins/ios-reader/transaction/scheduler';
const context = (id:string,priority=1,generation=1,ms=1000):RequestContext => ({id,priority,generation,deadline:Date.now()+ms});
afterEach(() => vi.useRealTimers());
describe('native provider scheduler', () => {
  it('never joins a resumed login to a cancelled promise, even before that promise settles',async()=>{
    const scheduler=new RequestScheduler();let failOld!:()=>void;
    const old=scheduler.enqueue({...context('old-login',0),authentication:true},false,'me',()=>new Promise((_,reject)=>{
      failOld=()=>reject(new Error('old cancellation'));
    }));
    const rejected=expect(old).rejects.toThrow('old cancellation');await Promise.resolve();
    const resumed=scheduler.enqueue({...context('new-login',0),authentication:true},false,'me',async()=>42);
    expect(resumed).not.toBe(old);
    // Native cancellation may reach WebKit after the resume has been queued.
    scheduler.cancel('old-login');failOld();await rejected;expect(await resumed).toBe(42);
  });
  it('protects sign-in validation from route changes and ordinary read cancellation',async()=>{
    const scheduler=new RequestScheduler();let release!:()=>void;let aborted=false;
    const login=scheduler.enqueue({...context('login',0),authentication:true},false,'me',async signal=>{
      signal.addEventListener('abort',()=>{aborted=true;});
      await new Promise<void>(resolve=>{release=resolve;});return 'account';
    });
    await Promise.resolve();scheduler.cancel(undefined,false,2);release();
    expect(await login).toBe('account');expect(aborted).toBe(false);
  });
  it('stops sign-in transport on backgrounding so it can resume as a fresh read',async()=>{
    const scheduler=new RequestScheduler();
    const login=scheduler.enqueue({...context('login',0),authentication:true},false,'me',signal=>new Promise((_,reject)=>{
      signal.addEventListener('abort',()=>reject(new Error('paused')));
    }));
    const rejected=expect(login).rejects.toThrow('paused');await Promise.resolve();scheduler.cancel(undefined,true);await rejected;
    expect(await scheduler.enqueue({...context('resumed',0,2),authentication:true},false,'me',async()=>42)).toBe(42);
  });
  it('promotes an identical queued read when a visible caller needs it',async()=>{
    const scheduler=new RequestScheduler();const order:string[]=[];
    const run=(name:string)=>async()=>{order.push(name);return name;};
    const nearby=scheduler.enqueue(context('near',3),false,'same',run('near'));
    const other=scheduler.enqueue(context('other',2),false,'other',run('other'));
    const visible=scheduler.enqueue(context('visible',1),false,'same',run('visible'));
    expect(nearby).toBe(visible);await Promise.all([nearby,other]);expect(order).toEqual(['near','other']);
  });
  it('prioritizes user work and coalesces identical reads with one active operation', async () => {
    const scheduler = new RequestScheduler(); const order:string[] = []; let active=0,max=0;
    const run = (id:string) => async () => { max=Math.max(max,++active); order.push(id); await Promise.resolve(); active--; return id; };
    const nearby=scheduler.enqueue(context('near',2),false,'same',run('near'));
    const duplicate=scheduler.enqueue(context('duplicate',2),false,'same',run('duplicate'));
    const action=scheduler.enqueue(context('action',0),true,'write',run('action'));
    const maintenance=scheduler.enqueue(context('maintenance',3),false,'health',run('health'));
    expect(duplicate).toBe(nearby); await Promise.all([nearby,duplicate,action,maintenance]);
    expect(order).toEqual(['action','near','health']); expect(max).toBe(1);
  });
  it('expires a queued request without executing it later', async () => {
    vi.useFakeTimers(); const scheduler=new RequestScheduler(); let release!:()=>void;
    const first=scheduler.enqueue(context('first'),false,'first',()=>new Promise<void>(resolve=>{release=resolve;}));
    const run=vi.fn(async()=>1); const queued=scheduler.enqueue(context('queued',2,1,10),false,'queued',run);
    const rejected=expect(queued).rejects.toThrow('expired'); await vi.advanceTimersByTimeAsync(20); await rejected;
    release(); await first; await Promise.resolve(); expect(run).not.toHaveBeenCalled();
  });
  it('cancels active and queued obsolete reads while retaining the new generation', async () => {
    const scheduler=new RequestScheduler(); const old=scheduler.enqueue(context('old'),false,'old',signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')))));
    const rejected=expect(old).rejects.toThrow('aborted'); await Promise.resolve();
    const stale=scheduler.enqueue(context('stale'),false,'stale',async()=>1); const staleRejected=expect(stale).rejects.toThrow('cancelled');
    const current=scheduler.enqueue(context('new',1,2),false,'new',async()=>2);
    scheduler.cancel(undefined,false,2); await Promise.all([rejected,staleRejected]); expect(await current).toBe(2);
  });
  it('never aborts or replays a write already sent when backgrounding', async () => {
    const scheduler=new RequestScheduler(); let release!:()=>void; let aborted=false; let calls=0;
    const write=scheduler.enqueue(context('write',0),true,'write',async(signal,sent)=>{calls++;sent();signal.addEventListener('abort',()=>{aborted=true;});await new Promise<void>(resolve=>{release=resolve;});return 1;});
    await Promise.resolve(); scheduler.cancel(undefined,true); release(); expect(await write).toBe(1);expect(aborted).toBe(false);expect(calls).toBe(1);
  });
  it('drops an unsent queued write during backgrounding', async () => {
    const scheduler=new RequestScheduler();const run=vi.fn(async()=>1); const write=scheduler.enqueue(context('write'),true,'write',run);
    const rejected=expect(write).rejects.toThrow('cancelled');scheduler.cancel(undefined,true);await rejected;expect(run).not.toHaveBeenCalled();
  });
});
