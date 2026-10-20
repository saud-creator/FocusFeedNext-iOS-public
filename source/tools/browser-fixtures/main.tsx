import React, {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {PostCard} from '../../src/components/post/PostCard';
import {api} from '../../src/lib/api';
import {FeedList} from '../../src/components/feed/FeedList';
import {I18nProvider} from '../../src/i18n';
import {PlatformProvider} from '../../src/lib/platform';
import {TooltipProvider} from '../../src/components/ui/primitives';
import {defaultPreferences,useAppStore} from '../../src/stores/useAppStore';
import type {Post} from '../../src/lib/api';
import '../../src/index.css';
useAppStore.setState({prefs:{...defaultPreferences,autoplay:'off',videoQuality:'best'}});
const photo='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="500"><rect width="320" height="500" fill="#38bdf8"/><circle cx="160" cy="170" r="100" fill="#111827"/><rect x="70" y="280" width="180" height="150" fill="#f0f9ff"/></svg>');
const avatar='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#14b8a6"/><circle cx="32" cy="27" r="13" fill="white"/></svg>');
const author={id:'42',username:'reader_journal',displayName:'A reader with a long display name',avatarUrl:avatar,verified:true};
const base:Post={id:'99',author,text:'A long post stays within the screen. https://example.com/'+('long_address_'.repeat(15))+'\nتجربة القراءة على الآيفون مع نص عربي وصور واضحة.',createdAt:new Date().toISOString(),media:[],isRepost:false,isPromoted:false,metrics:{likes:0,reposts:0,replies:0,quotes:0,views:0,bookmarks:0}};
const high=location.origin+'/media/'+('1'.repeat(32))+'/'+('2'.repeat(32));
const low=location.origin+'/media/'+('1'.repeat(32))+'/'+('3'.repeat(32));
const movie={kind:'video' as const,url:high,width:320,height:568,durationMs:7000,variants:[{label:'568p',url:high},{label:'284p',url:low}]};
const posts=[{...base,media:[{kind:'image' as const,url:photo,width:320,height:500,alt:'Portrait geometry fixture',variants:[]}]},{...base,id:'100',text:'Phone video controls, quality switching and error recovery.',media:[movie]}];
posts.push({...base,id:'101',text:'Recoverable picture error',media:[{kind:'image' as const,url:location.origin+'/fixtures/missing.png',width:1600,height:1200,alt:'Failed fixture image',variants:[]}]});
const windowed=new URLSearchParams(location.search).has('windowed');
const preloading=new URLSearchParams(location.search).has('preload');
const articleTest=new URLSearchParams(location.search).has('article');
const aheadPost={...base,id:'preload-proof',text:'A picture just ahead of the viewport.',media:[{kind:'image' as const,url:location.origin+'/fixtures/ahead.svg',width:320,height:160,alt:'Ahead-of-viewport fixture',variants:[]}]};
const windowedPosts=Array.from({length:40},(_,index)=>({...posts[index%3],id:String(200+index),text:index%3===0 ? posts[0].text+'\n\n'+('A paragraph of authored text.\n'.repeat(index%5+1)) : posts[index%3].text}));
windowedPosts[0]={...windowedPosts[0],media:[{kind:'image',url:location.origin+'/fixtures/changing-photo.svg',width:320,height:80,alt:'Delayed intrinsic image',variants:[]}]};
const unread=new Set<string>();
function ArticleFixture() {
  const [reads,setReads]=useState(0);
  const post={...base,id:'123',isArticle:true,articleTitle:'عنوان مقالة طويل وكامل يجب أن يبقى مقروءًا على أصغر شاشة بدون اقتطاع',text:'An authored introduction.\n\nمقدمة عربية.',media:[]};
  useEffect(()=>{
    const previous=api.postContent;let attempt=0;
    api.postContent=async()=>{
      setReads(n=>n+1);
      if(attempt++===0)throw new Error('Controlled interrupted read');
      return {post,article:{title:post.articleTitle,blocks:[{kind:'heading2',text:'Full article chapter'},{kind:'paragraph',text:'First paragraph.\n\nفقرة عربية كاملة.'},{kind:'code',text:'<script>literal article text</script>'},{kind:'image',text:photo}]}};
    };
    return()=>{api.postContent=previous;};
  },[]);
  return <><output hidden data-testid="article-read-count">{reads}</output><PostCard post={post} read={false} readDwellMs={0}/></>;
}
function WindowedFixture() {
  const [returnedAt,setReturnedAt]=useState<number|null>(null);
  const [paintMs,setPaintMs]=useState<number|null>(null);
  const [stages,setStages]=useState('');
  useEffect(()=>{let frame=requestAnimationFrame(()=>{frame=requestAnimationFrame(()=>{performance.mark('fixture-page-returned');setReturnedAt(performance.now());});});return()=>cancelAnimationFrame(frame);},[]);
  useEffect(()=>{
    if(returnedAt===null) return;
    const effectMs=performance.now()-returnedAt;
    let frame=0,timer=0;
    const measure=()=>{
      const rect=document.querySelector('[data-testid="post-card"]')?.getBoundingClientRect();
      const viewport=document.querySelector('main')?.getBoundingClientRect();
      if(!rect || !viewport || rect.height===0 || rect.top>=viewport.bottom || rect.bottom<=viewport.top) {frame=requestAnimationFrame(measure);return;}
      const visibleMs=performance.now()-returnedAt;
      const cards=document.querySelectorAll('[data-testid="post-card"]').length;
      timer=window.setTimeout(()=>{performance.mark('fixture-first-paint');const elapsed=performance.now()-returnedAt;setPaintMs(elapsed);setStages(JSON.stringify({effectMs,visibleMs,afterPaintTask:elapsed-visibleMs,cards,visibility:document.visibilityState}));},0);
    };
    frame=requestAnimationFrame(measure);return()=>{cancelAnimationFrame(frame);window.clearTimeout(timer);};
  },[returnedAt]);
  return <><output hidden data-testid="fixture-paint" data-ms={paintMs??undefined} data-stages={stages}/><FeedList posts={returnedAt===null?[]:windowedPosts} loading={returnedAt===null} readIds={unread}/></>;
}
createRoot(document.getElementById('root')!).render(<PlatformProvider><I18nProvider locale="en"><QueryClientProvider client={new QueryClient()}><TooltipProvider><main className="overflow-y-auto p-3 space-y-4" style={{height:'calc(100dvh - var(--reader-bottom-inset,0px))'}}>{articleTest ? <ArticleFixture/> : preloading ? <><div aria-hidden style={{height:'calc(100dvh + 40px)'}}/><PostCard post={aheadPost} read={false} readDwellMs={0}/></> : windowed ? <WindowedFixture/> : posts.map(post=><PostCard key={post.id} post={post} read={false} readDwellMs={0} />)}</main></TooltipProvider></QueryClientProvider></I18nProvider></PlatformProvider>);
