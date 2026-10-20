import {act,renderHook} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {api} from './api';
import {useNativeMedia} from './nativeMedia';
import {isOverlayActive} from './nativeOverlay';
import {claimPlayback} from './mediaSession';

vi.mock('./api',()=>({api:{presentIosMedia:vi.fn(),dismissIosMedia:vi.fn()}}));
beforeEach(()=>{vi.clearAllMocks();vi.mocked(api.dismissIosMedia).mockResolvedValue();});
describe('native media ownership',()=>{
  it('pauses inline playback before a native photo or video takes ownership',async()=>{
    const video=document.createElement('video');const pause=vi.spyOn(video,'pause');claimPlayback(video);
    vi.mocked(api.presentIosMedia).mockResolvedValue({index:0,position:0,playing:false});
    const hook=renderHook(()=>useNativeMedia());
    await act(async()=>{await hook.result.current.present([{url:'registered',kind:'image'}],0);});
    expect(pause).toHaveBeenCalledOnce();hook.unmount();
  });
  it('dismisses on route removal and ignores the late playback position',async()=>{
    let finish!:(value:{index:number;position:number;playing:boolean})=>void;
    vi.mocked(api.presentIosMedia).mockReturnValue(new Promise(resolve=>{finish=resolve;}));
    const hook=renderHook(()=>useNativeMedia());
    let answer!:ReturnType<typeof api.presentIosMedia>;
    act(()=>{answer=hook.result.current.present([{url:'registered',kind:'video'}],0) as typeof answer;});
    expect(isOverlayActive()).toBe(true);
    hook.unmount();
    expect(api.dismissIosMedia).toHaveBeenCalledOnce();
    expect(isOverlayActive()).toBe(false);
    finish({index:0,position:42,playing:true});
    expect(await answer).toBeNull();
  });
  it('releases the navigation overlay after a presentation failure',async()=>{
    vi.mocked(api.presentIosMedia).mockRejectedValue(new Error('presentation unavailable'));
    const hook=renderHook(()=>useNativeMedia());
    await act(async()=>{await expect(hook.result.current.present([{url:'registered',kind:'image'}],0)).rejects.toThrow('presentation unavailable');});
    expect(hook.result.current.active).toBe(false);
    expect(isOverlayActive()).toBe(false);
    hook.unmount();
  });
});
