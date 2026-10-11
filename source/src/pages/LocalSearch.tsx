import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api } from '@/lib/api';
import { useI18n } from '@/i18n';
import { Input } from '@/components/ui/primitives';
import { PageHeader } from '@/components/layout/PageHeader';
import { FeedList } from '@/components/feed/FeedList';
import { usePostActions, useReadIds } from '@/hooks/useFeed';
import { useOpenProfile } from '@/components/account/AccountIdentity';
import { useSessionReady } from '@/hooks/useStartupSequence';

export function LocalSearchPage() {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const { readyToken } = useSessionReady();
  const actions = usePostActions();
  const openProfile = useOpenProfile();
  const qc = useQueryClient();
  useEffect(() => { const timer = setTimeout(() => setQuery(text.trim()),200); return () => clearTimeout(timer); },[text]);
  const results = useInfiniteQuery({
    queryKey: ['cachedSearch', readyToken, query], initialPageParam: 0,
    queryFn: ({ pageParam }) => api.searchCachedPosts(query,pageParam),
    getNextPageParam: page => page.nextOffset ?? undefined,
    enabled: query.length > 0, retry: false,
  });
  const posts = results.data?.pages.flatMap(page => page.posts) ?? [];
  const readIds = useReadIds(results.data?.pages.flatMap(page => page.readIds) ?? []);
  return <>
    <PageHeader title={t('localSearch.title')} subtitle={t('localSearch.description')} />
    <div className="mx-auto max-w-[920px] px-3 py-4 sm:px-6">
      <label className="mb-5 flex items-center gap-3 surface-card p-3">
        <Search className="size-5 text-ink-mute" aria-hidden="true" />
        <Input value={text} onChange={event => setText(event.target.value)} maxLength={256} placeholder={t('localSearch.placeholder')} aria-label={t('localSearch.title')} />
      </label>
      {results.isError && <p role="alert" className="mb-4 text-danger">{t('localSearch.failed')}</p>}
      <FeedList posts={posts} readIds={readIds} loading={results.isFetching && posts.length === 0}
        onOpenProfile={openProfile} onMarkRead={actions.markRead}
        onHide={id => { void actions.hide(id).then(() => qc.invalidateQueries({ queryKey: ['cachedSearch'] })); }}
        onLoadMore={() => { if (!results.isFetchingNextPage) void results.fetchNextPage(); }}
        hasMore={results.hasNextPage} loadingMore={results.isFetchingNextPage}
        emptyTitle={t(query ? 'localSearch.empty' : 'localSearch.start')} emptyHint={t('localSearch.description')} />
    </div>
  </>;
}
