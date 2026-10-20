import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {FileText} from 'lucide-react';
import {api,type Post} from '@/lib/api';
import {useI18n} from '@/i18n';
import {PostText} from './PostText';
import {MediaGallery} from './MediaGallery';

/** Explicit single-post reads keep long articles independent of feed loading. */
export function ArticleReader({post,onOpenProfile}:{post:Post;onOpenProfile?: (username:string)=>void}) {
  const {t}=useI18n();const [open,setOpen]=useState(false);
  const content=useQuery({queryKey:['postContent',post.id],queryFn:()=>api.postContent(post.id),enabled:open,retry:false,staleTime:300000});
  const article=content.data?.article;
  return <section className="mt-2 rounded-lg border border-edge bg-surface-1 p-3" aria-label={t('post.article')}>
    <div className="flex gap-2 items-start"><FileText className="size-5 shrink-0 text-accent" aria-hidden/><div className="min-w-0"><span className="text-xs text-ink-mute">{t('post.article')}</span><h3 className="font-semibold text-base leading-snug break-words" dir="auto">{article?.title??post.articleTitle??t('post.article')}</h3></div></div>
    <PostText text={content.data?.post.text??post.text} postUrl={post.url} onOpenProfile={onOpenProfile} className="mt-2"/>
    <button type="button" className="min-h-11 text-accent text-sm" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>{t(open?'article.close':'article.read')}</button>
    {open && <div className="space-y-4 border-t border-edge pt-4" data-testid="article-body">
      {content.isFetching && !article?<p role="status">{t('article.loading')}</p>:article?article.blocks.map((block,index)=>{
        const props={key:index,dir:'auto' as const,className:'whitespace-pre-wrap break-words leading-relaxed'};
        switch(block.kind) {
          case 'image':return <MediaGallery key={index} media={[{kind:'image',url:block.text,variants:[]}]} recoverOverride={async()=>{await content.refetch();}}/>;
          case 'heading1':return <h2 {...props} className="text-xl font-bold break-words">{block.text}</h2>;
          case 'heading2':return <h3 {...props} className="text-lg font-semibold break-words">{block.text}</h3>;
          case 'heading3':return <h4 {...props} className="font-semibold break-words">{block.text}</h4>;
          case 'quote':return <blockquote {...props} className="border-s-2 border-accent ps-3 whitespace-pre-wrap">{block.text}</blockquote>;
          case 'code':return <pre key={index} dir="ltr" className="overflow-x-auto p-3 bg-surface-2 rounded"><code>{block.text}</code></pre>;
          case 'bullet':return <p {...props}>• {block.text}</p>;
          case 'number':return <p {...props}>{index-article.blocks.slice(0,index).findLastIndex(b=>b.kind!=='number')}. {block.text}</p>;
          default:return <p {...props} className="whitespace-pre-wrap break-words leading-relaxed min-h-4">{block.text}</p>;
        }
      }):<div role="status"><p>{t('article.unavailable')}</p><button type="button" className="min-h-11 text-accent" onClick={()=>void content.refetch()}>{t('article.retry')}</button></div>}
    </div>}
  </section>;
}
