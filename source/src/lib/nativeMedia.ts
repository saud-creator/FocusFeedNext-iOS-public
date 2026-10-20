import {useCallback,useEffect,useRef,useState} from 'react';
import {api} from './api';
import {useNativeOverlay} from './nativeOverlay';
import {pauseAllPlayback} from './mediaSession';

/** A cancelled route/account cannot resume a different page's media. */
export function useNativeMedia() {
  const [active,setActive]=useState(false);
  const owner=useRef({generation:0,mounted:true,active:false});
  useNativeOverlay(active);
  useEffect(()=>{
    const state=owner.current;
    state.mounted=true;
    return ()=>{state.mounted=false;state.generation++;if(state.active) void api.dismissIosMedia().catch(()=>{});};
  },[]);
  const present=useCallback(async (...args:Parameters<typeof api.presentIosMedia>)=>{
    const state=owner.current;const generation=++state.generation;
    pauseAllPlayback();
    state.active=true;setActive(true);
    try {
      const result=await api.presentIosMedia(...args);
      return state.mounted && generation===state.generation ? result : null;
    } catch(error) {
      if(!state.mounted || generation!==state.generation) return null;
      throw error;
    } finally {
      if(state.mounted && generation===state.generation) {state.active=false;setActive(false);}
    }
  },[]);
  return {active,present};
}
