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
function FixtureReader({fixture,returnedAt}:{fixture:Fixture;returnedAt:number}) {
  const route=useAppStore(s=>s.route);
  const [welcome,setWelcome]=useState(false);
  const [paint,setPaint]=useState('Measuring first content paint');
  const [paintMs,setPaintMs]=useState<number|null>(null);
  useEffect(()=>{
    let id=0;
    const measure=()=>{
      const card=document.querySelector<HTMLElement>('[data-testid="post-card"]');
      const rect=card?.getBoundingClientRect();
      const ready=route==='accounts' ? document.body.textContent?.includes('Fixture connection interrupted') : rect && rect.height>0 && rect.top<innerHeight && rect.bottom>0;
      if(!ready && performance.now()-returnedAt<5000) {id=requestAnimationFrame(measure);return;}
      // A second frame observes a committed visible card, not an empty virtual
      // spacer or a loading skeleton. The 250 ms limit is unchanged.
      id=requestAnimationFrame(()=>{const elapsed=performance.now()-returnedAt;setPaintMs(elapsed);setPaint(ready && elapsed<=250 ? 'First content painted within 250 ms' : 'First content exceeded 250 ms');});
    };
    id=requestAnimationFrame(measure);return()=>cancelAnimationFrame(id);
  },[returnedAt,route]);
  const firstPage=useMemo(()=>{
  const author={id:'fixture',username:'fixture_reader',displayName:'Fixture reader',avatarUrl:fixture.failedImage,verified:false};
  const base:Post={id:'fixture-photo',author,text:'Complete pictures and authored paragraph breaks.\n\nنص عربي لاختبار القراءة والمحاذاة.',createdAt:new Date().toISOString(),media:[],isRepost:false,isPromoted:false,isArticle:false,provider:'fixture',metrics:{likes:0,reposts:0,replies:0,quotes:0,views:0,bookmarks:0}};
  const photos={...base,media:[{kind:'image' as const,url:fixture.image,width:128,height:128,alt:'Fixture photograph',variants:[]},{kind:'image' as const,url:fixture.image,width:128,height:128,alt:'Second fixture photograph',variants:[]}]};
  const video={...base,id:'fixture-video',text:'Native video playback',media:[{kind:'video' as const,url:fixture.video,width:320,height:284,alt:'Fixture video',variants:[]}]};
  const failed={...base,id:'fixture-failed',text:'Recoverable image failure',media:[{kind:'image' as const,url:fixture.failedImage,width:1600,height:1200,alt:'Failed fixture',variants:[]}]};
  return [...(fixture.scenario==='video'?[video,photos,failed]:[photos,failed,video]),...Array.from({length:17},(_,i)=>({...base,id:`fixture-text-${i}`,text:`First page post ${i+4}\n\nA separate authored paragraph.`}))];
  },[fixture]);
  return <main className="overflow-y-auto" style={{height:'calc(100dvh - var(--reader-bottom-inset,0px))'}}>
    <PageHeader title="Simulator fixture reader" subtitle="English and Arabic media, accounts and safe-area checks"/>
    <p role="status">{paint}</p>
    {paintMs!==null && <p>First content render: {Math.round(paintMs)} ms; {firstPage.length} posts returned</p>}
    <button className="min-h-11 p-3" onClick={()=>setWelcome(v=>!v)}>{welcome?'Enter reader':'Return to welcome'}</button>
    {welcome ? <p>Fixture welcome without reader navigation</p> : route==='accounts' ? <FollowingManagerPage/> : <div className="p-3"><FeedList posts={firstPage} readIds={unreadFixturePosts}/></div>}
    {!welcome && <MobileNavigation unread={0}/>}
  </main>;
}

export async function testApplication(normal:ReactElement) {
  const fixture=await api.uiTestFixture();
  if(!fixture) return normal;
  const returnedAt=performance.now();
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
  return <PlatformProvider><I18nProvider locale={arabic?'ar':'en'}><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><TooltipProvider>{fixture.scenario==='authentication'?<main className="h-[100dvh] overflow-y-auto"><IosWelcome/></main>:<FixtureReader fixture={fixture} returnedAt={returnedAt}/>}</TooltipProvider></QueryClientProvider></I18nProvider></PlatformProvider>;
}
