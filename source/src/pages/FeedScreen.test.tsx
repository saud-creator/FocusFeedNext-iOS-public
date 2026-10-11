import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { makePost, renderWithProviders } from '@/test/factories';
import { FeedScreen } from './FeedScreen';
import type { Post, FeedFilters } from '@/lib/api';
import type { ReactNode } from 'react';

const model = vi.hoisted(() => ({
  posts: [] as Post[], readIds: new Set<string>(), lastSync:null, fromCache:true,
  refreshError:'X could not be reached.', refreshFailure:null, isLoading:false,
  isRefreshing:false, isLoadingMore:false, hasMore:false, loadMoreError:null,
  pendingCount:0, showPending:vi.fn(), setAtTop:vi.fn(), refresh:vi.fn(), loadMore:vi.fn(),
}));
vi.mock('@/hooks/useFeed', () => ({
  useFeed:()=>model, claimRefresh:()=>false, releaseRefreshClaim:vi.fn(),
  usePostActions:()=>({markRead:vi.fn(),hide:vi.fn(),removeBookmark:vi.fn()}),
}));
vi.mock('@/hooks/useStartupSequence', () => ({useSessionReady:()=>({phase:'ready',readyToken:1})}));
vi.mock('@/components/layout/PageHeader', () => ({PageHeader:({title,subtitle,actions}:{title:string;subtitle:ReactNode;actions:ReactNode})=><header>{title}{subtitle}{actions}</header>}));
vi.mock('@/components/feed/FeedList', () => ({FeedList:({posts,emptyTitle}:{posts:Post[];emptyTitle:string})=> <div>{posts.length ? 'Loaded post' : emptyTitle}</div>}));
vi.mock('@/components/settings/IosConnection', () => ({ConnectionError:()=>null,ConnectionReport:()=>null}));

beforeEach(()=>{model.posts=[];model.refreshError='X could not be reached.';});
function renderFeed() {
  renderWithProviders(<FeedScreen feed="following" title="Following" filters={{} as FeedFilters} showFilters={false} emptyTitle="No posts match your filters" />);
}
describe('feed loading failure',()=>{
  it('does not blame filters or claim cached posts when the initial content request failed',()=>{
    renderFeed();
    expect(screen.getByText('Posts have not loaded yet. Try again or share the diagnostic report to check the connection.')).toBeInTheDocument();
    expect(screen.queryByText('No posts match your filters')).not.toBeInTheDocument();
    expect(screen.queryByText('Cached')).not.toBeInTheDocument();
    expect(screen.queryByText(/Locally cached posts are shown/)).not.toBeInTheDocument();
  });
  it('keeps cached posts available when a subsequent refresh fails',()=>{
    model.posts=[makePost()];renderFeed();
    expect(screen.getByText('Loaded post')).toBeInTheDocument();
    expect(screen.getByText(/Locally cached posts are shown/)).toBeInTheDocument();
  });
  it('shows the normal filtered empty state after a successful request',()=>{
    model.refreshError='';renderFeed();
    expect(screen.getByText('No posts match your filters')).toBeInTheDocument();
    expect(screen.queryByText('Live refresh failed')).not.toBeInTheDocument();
  });
});
