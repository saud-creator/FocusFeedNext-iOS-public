import {useId, useState} from 'react';
import {useInfiniteQuery} from '@tanstack/react-query';
import {MessageCircle} from 'lucide-react';
import {api, isTauri, type Post} from '@/lib/api';
import {useI18n} from '@/i18n';
import {AuthorHeader, Avatar} from './AuthorHeader';
import {PostText} from './PostText';
import {MediaGallery} from './MediaGallery';
import {QuotedPostCard} from './QuotedPostCard';
import {ArticleReader} from './ArticleReader';

/** Only bookmark cards mount this reader. Opening it makes the first request. */
export function BookmarkComments({post, onOpenProfile}: {post: Post; onOpenProfile?: (username:string)=>void}) {
  const {t}=useI18n();
  const region=useId();
  const [open,setOpen]=useState(false);
  const [linkError,setLinkError]=useState(false);
  const original=/^[0-9]{1,25}$/.test(post.id) && /^[A-Za-z0-9_]{1,15}$/.test(post.author.username) ? `https://x.com/${post.author.username}/status/${post.id}` : null;
  const replies=useInfiniteQuery({
    queryKey:['bookmarkReplies',post.id],
    initialPageParam:null as string|null,
    queryFn:({pageParam})=>api.bookmarkReplies(post.id,pageParam),
    getNextPageParam:(last,pages,_lastParam,params)=>
      pages.length<5 && last.cursor && !params.includes(last.cursor) ? last.cursor : undefined,
    enabled:open,retry:false,staleTime:60000,refetchOnWindowFocus:false,
  });
  const pages=replies.data?.pages ?? [];
  const comments=[...new Map(pages.flatMap(page=>page.posts).map(comment=>[comment.id,comment])).values()];
  const stopped=pages.length>0 && pages.at(-1)?.cursor && !replies.hasNextPage;
  return <section className="mt-3 border-t border-edge pt-2">
    <button type="button" className="min-h-11 inline-flex items-center gap-2 text-sm text-accent" aria-expanded={open} aria-controls={region} onClick={()=>setOpen(value=>!value)}>
      <MessageCircle className="size-4"/>{t(open?'comments.close':'comments.open')}
    </button>
    {open && <div id={region} role="region" aria-label={t('comments.title')} className="space-y-3">
      {replies.isPending && <p role="status" className="text-sm text-ink-mute">{t('comments.loading')}</p>}
      {comments.map(comment=><article key={comment.id} className="rounded-xl border border-edge bg-surface-1 p-3" data-testid="bookmark-comment">
        <div className="flex gap-2 items-start"><Avatar author={comment.author} size={32}/><AuthorHeader author={comment.author} createdAt={comment.createdAt} onOpenProfile={onOpenProfile}/></div>
        {comment.isArticle?<ArticleReader post={comment} onOpenProfile={onOpenProfile}/>:<PostText text={comment.text} postUrl={comment.url} onOpenProfile={onOpenProfile} className="mt-2"/>}
        <MediaGallery media={comment.media} postId={comment.id}/>
        {comment.quoted && <QuotedPostCard quoted={comment.quoted} onOpenProfile={onOpenProfile}/>}
      </article>)}
      {replies.isError && <div role="alert" className="text-sm text-ink-dim"><p>{t('comments.failed')}</p><button type="button" className="min-h-11 text-accent" onClick={()=>void (pages.length?replies.fetchNextPage():replies.refetch())}>{t('comments.retry')}</button></div>}
      {!replies.isPending && !replies.isError && comments.length===0 && <p className="text-sm text-ink-mute">{t('comments.empty')}</p>}
      {replies.hasNextPage && <button type="button" className="min-h-11 text-sm text-accent" disabled={replies.isFetching} onClick={()=>void replies.fetchNextPage()}>{t(replies.isFetchingNextPage?'comments.loading':'comments.more')}</button>}
      {original && <a className="min-h-11 flex items-center text-sm text-accent" href={original} target="_blank" rel="noopener noreferrer" onClick={event=>{if(!isTauri())return;event.preventDefault();setLinkError(false);void api.openExternal(original).catch(()=>setLinkError(true));}}>{t('comments.original')}</a>}
      {linkError && <p role="alert" className="text-xs text-bad">{t('post.linkFailed')}</p>}
      {stopped && <p className="text-xs text-ink-mute">{t('comments.stopped')}</p>}
    </div>}
  </section>;
}
