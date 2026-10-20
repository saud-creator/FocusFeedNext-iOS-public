import {useEffect,useState} from 'react';
export function useSlowOperation(pending:boolean) {
  const [slow,setSlow]=useState(false);
  useEffect(()=>{
    if(!pending) {setSlow(false);return;}
    const timer=window.setTimeout(()=>setSlow(true),8000);
    return ()=>window.clearTimeout(timer);
  },[pending]);
  return pending && slow;
}
