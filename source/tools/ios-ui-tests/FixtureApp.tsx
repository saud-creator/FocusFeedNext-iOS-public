// This module is removed from ordinary Vite builds by __FFN_UI_TEST__.
import {useEffect,useMemo,useState,type ReactElement} from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {api,type Post} from '../../src/lib/api';
import {PlatformProvider} from '../../src/lib/platform';
import {I18nProvider} from '../../src/i18n';
import {TooltipProvider} from '../../src/components/ui/primitives';
import {FeedList} from '../../src/components/feed/FeedList';
import {MobileNavigation} from '../../src/components/layout/MobileNavigation';
import {PageHeader} from '../../src/components/layout/PageHeader';
import {FollowingManagerPage} from '../../src/pages/FollowingManager';
import {IosWelcome} from '../../src/components/settings/IosConnection';
import {useAppStore,defaultPreferences} from '../../src/stores/useAppStore';

type Fixture=NonNullable<Awaited<ReturnType<typeof api.uiTestFixture>>>;
const unreadFixturePosts=new Set<string>();
const fixtureArticle:Post={id:'fixture-article',text:'An article preview.',author:{id:'fixture',username:'fixture_reader',displayName:'Fixture reader',verified:false},createdAt:'2026-10-20T00:00:00Z',isRepost:false,isPromoted:false,isArticle:true,articleTitle:'An article with a complete, readable title',media:[],metrics:{likes:0,reposts:0,replies:0,quotes:0,views:0,bookmarks:0},provider:'fixture'};
function FixtureReader({bootstrapAt}:{bootstrapAt:number}) {
  const [delivery,setDelivery]=useState<{fixture:Fixture;returnedAt:number;shellMs:number}|null>(null);
  useEffect(()=>{
    let active=true,id=0;
    // Like a live feed, mount its loading shell before requesting page data.
    // Keep cold shell startup separate from response-to-visible-content time.
    const requestPage=()=>{
      const style=getComputedStyle(document.documentElement);
      const nativeHeight=parseFloat(style.getPropertyValue('--native-tab-height'));
      const occupied=parseFloat(style.getPropertyValue('--reader-bottom-inset'));
      if(!(nativeHeight>0 && occupied===nativeHeight) && performance.now()-bootstrapAt<5000) {id=requestAnimationFrame(requestPage);return;}
      const shellMs=performance.now()-bootstrapAt;
      void api.uiTestFixture().then(fixture=>{if(active && fixture) setDelivery({fixture,returnedAt:performance.now(),shellMs});});
    };
    id=requestAnimationFrame(()=>{id=requestAnimationFrame(requestPage);});
    return()=>{active=false;cancelAnimationFrame(id);};
  },[bootstrapAt]);
  const fixture=delivery?.fixture;
  const route=useAppStore(s=>s.route);
  const [welcome,setWelcome]=useState(false);
  const [paint,setPaint]=useState('Measuring first content paint');
  const [paintMs,setPaintMs]=useState<number|null>(null);
  const [paintStages,setPaintStages]=useState('');
  const [geometry,setGeometry]=useState('Measuring card separation');
  useEffect(()=>{
    if(!delivery || welcome || route==='accounts') return;
    let id=0;
    const inspect=()=>{
      const rows=Array.from(document.querySelectorAll<HTMLElement>('[data-testid="feed-window-item"]')).sort((a,b)=>Number(a.dataset.index)-Number(b.dataset.index));
      const separated=rows.length>0 && rows.every((row,index)=>index===0 || Number(row.dataset.index)!==Number(rows[index-1].dataset.index)+1 || row.getBoundingClientRect().top>=rows[index-1].getBoundingClientRect().bottom-1);
      setGeometry(separated?'Feed cards do not overlap':'Feed cards overlap');
    };
    const update=()=>{cancelAnimationFrame(id);id=requestAnimationFrame(inspect);};
    const observer=new ResizeObserver(update);
    const observeRows=()=>document.querySelectorAll('[data-testid="feed-window-item"]').forEach(row=>observer.observe(row));
    observeRows();
    const mutation=new MutationObserver(()=>{observeRows();update();});
    const layer=document.querySelector('[data-testid="feed-window"]');
    if(layer) mutation.observe(layer,{childList:true});
    update();window.addEventListener('resize',update);
    return()=>{cancelAnimationFrame(id);observer.disconnect();mutation.disconnect();window.removeEventListener('resize',update);};
  },[delivery,welcome,route]);
  useEffect(()=>{
    if(!delivery) return;
    const returnedAt=delivery.returnedAt;
    const effectMs=performance.now()-returnedAt;
    let id=0,timer=0;
    const measure=()=>{
      const card=document.querySelector<HTMLElement>('[data-testid="post-card"]');
      const rect=card?.getBoundingClientRect();
      const viewport=card?.closest('main')?.getBoundingClientRect();
      const ready=delivery.fixture.scenario==='accounts' ? document.body.textContent?.includes('Fixture connection interrupted') : rect && viewport && rect.height>0 && rect.top<viewport.bottom && rect.bottom>viewport.top;
      if(!ready && performance.now()-returnedAt<5000) {id=requestAnimationFrame(measure);return;}
      // Queue a task after this rendering opportunity. A second rAF measures
      // WebKit's idle-frame scheduling, which can be hundreds of ms later.
      // The clock still starts before constructing any returned cards.
      const visibleMs=performance.now()-returnedAt;
      const cards=document.querySelectorAll('[data-testid="post-card"]').length;
      timer=window.setTimeout(()=>{const elapsed=performance.now()-returnedAt;setPaintStages(`Commit effects ${Math.round(effectMs)} ms; visible frame ${Math.round(visibleMs)} ms; ${cards} cards mounted at visibility; after-paint task ${Math.round(elapsed-visibleMs)} ms`);setPaintMs(elapsed);setPaint(ready && elapsed<=250 ? 'First content painted within 250 ms' : 'First content exceeded 250 ms');},0);
    };
    id=requestAnimationFrame(measure);return()=>{cancelAnimationFrame(id);window.clearTimeout(timer);};
  },[delivery]);
  const firstPage=useMemo(()=>{
  if(!fixture) return [];
  const author={id:'fixture',username:'fixture_reader',displayName:'Fixture reader',avatarUrl:fixture.failedImage,verified:false};
  const base:Post={id:'fixture-photo',author,text:'Complete pictures and authored paragraph breaks.\n\nنص عربي لاختبار القراءة والمحاذاة.',createdAt:new Date().toISOString(),media:[],isRepost:false,isPromoted:false,isArticle:false,provider:'fixture',metrics:{likes:0,reposts:0,replies:0,quotes:0,views:0,bookmarks:0}};
  const photos={...base,media:[{kind:'image' as const,url:fixture.image,width:128,height:128,alt:'Fixture photograph',variants:[]},{kind:'image' as const,url:fixture.image,width:128,height:128,alt:'Second fixture photograph',variants:[]}]};
  const video={...base,id:'fixture-video',text:'Native video playback',media:[{kind:'video' as const,url:fixture.video,width:320,height:284,alt:'Fixture video',variants:[]}]};
  const failed={...base,id:'fixture-failed',text:'Recoverable image failure',media:[{kind:'image' as const,url:fixture.failedImage,width:1600,height:1200,alt:'Failed fixture',variants:[]}]};
  return [...(fixture.scenario==='video'?[video,photos,failed]:[photos,failed,video]),fixtureArticle,...Array.from({length:16},(_,i)=>({...base,id:`fixture-text-${i}`,text:`First page post ${i+5}\n\nA separate authored paragraph.`}))];
  },[fixture]);
  return <main className="overflow-y-auto" style={{height:'calc(100dvh - var(--reader-bottom-inset,0px))'}}>
    <PageHeader title="Simulator fixture reader" subtitle={<div className="flex items-center gap-3"><button className="min-h-11 px-3 shrink-0" aria-label={welcome?'Enter reader':'Return to welcome'} onClick={()=>setWelcome(v=>!v)}>{welcome?'Enter reader':'Welcome'}</button><span>English and Arabic media, accounts and safe-area checks</span></div>}/>
    <p role="status">{paint}</p>
    {delivery && <p>Fixture page ready</p>}
    {delivery && <p>{geometry}</p>}
    {welcome ? <p>Fixture welcome without reader navigation</p> : !delivery ? <p role="status">Waiting for the first page</p> : route==='accounts' ? <FollowingManagerPage/> : <div className="p-3"><FeedList posts={firstPage} readIds={unreadFixturePosts}/></div>}
    {paintMs!==null && <div aria-label="Fixture diagnostics"><p>First content render: {Math.round(paintMs)} ms; reader shell: {Math.round(delivery!.shellMs)} ms; {firstPage.length} posts returned</p><p>{paintStages}</p></div>}
    {!welcome && <MobileNavigation unread={0}/>}
  </main>;
}

export async function testApplication(normal:ReactElement) {
  const bootstrapAt=performance.now();
  const fixture=await api.uiTestFixture();
  if(!fixture) return normal;
  api.postContent=async id=>{
    if(id!==fixtureArticle.id)throw new Error('Unknown article fixture');
    return {post:fixtureArticle,article:{title:fixtureArticle.articleTitle!,blocks:[{kind:'heading2',text:'Fixture article chapter'},{kind:'paragraph',text:'Complete article paragraph.\n\nفقرة عربية كاملة.'},{kind:'image',text:fixture.image}]}};
  };
  const arabic=fixture.scenario==='arabic';
  document.documentElement.dir=arabic?'rtl':'ltr';
  document.documentElement.style.setProperty('--reading-scale',fixture.scenario==='large-text'?'1.5':'1');
  document.documentElement.dataset.reduceMotion=String(fixture.scenario==='large-text');
  document.documentElement.dataset.reduceTransparency=String(fixture.scenario==='large-text');
  useAppStore.setState({route:fixture.scenario==='accounts'?'accounts':'following',prefs:{...defaultPreferences,language:arabic?'ar':'en',autoplay:'off',theme:'dark',readingSize:fixture.scenario==='large-text'?150:100}});
  let retried=false;
  api.followingSnapshot=async()=>({accounts:[],complete:retried,syncing:false,state:retried?'complete':'failed',lastError:retried?null:'Fixture connection interrupted'});
  api.startFollowingSync=async()=>{retried=true;return true;};
  api.providerCapabilities=async()=>({feedCursor:true,listCursor:true,followingCursor:true,userPostsCursor:true,promotedFlag:true,unfollow:false,follow:false,mute:false,block:false,unbookmark:false});
  api.unfollowAllowed=async()=>false;
  api.readIds=async()=>[];
  api.pinnedAccounts=async()=>[];
  api.accountLists=async()=>[];
  let loginAttempts=0;
  if(fixture.scenario==='authentication') api.signInIos=async()=>{
    loginAttempts++;
    throw {code:'provider_unavailable',message:'Fixture sign-in stopped',nativeConnectionFault:{code:loginAttempts===1?'transport_initialization':'cancelled',stage:'transport',retryable:loginAttempts===1}};
  };
  return <PlatformProvider><I18nProvider locale={arabic?'ar':'en'}><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><TooltipProvider>{fixture.scenario==='authentication'?<main className="h-[100dvh] overflow-y-auto"><IosWelcome/></main>:<FixtureReader bootstrapAt={bootstrapAt}/>}</TooltipProvider></QueryClientProvider></I18nProvider></PlatformProvider>;
}
