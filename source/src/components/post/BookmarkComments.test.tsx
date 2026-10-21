import {afterEach,describe,expect,it,vi} from 'vitest';
import {screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {api} from '@/lib/api';
import {makePost,renderWithProviders} from '@/test/factories';
import {PostCard} from './PostCard';

afterEach(()=>vi.restoreAllMocks());
describe('bookmark comments',()=>{
  it('never fetches or offers comments outside bookmarks',()=>{
    const read=vi.spyOn(api,'bookmarkReplies');
    renderWithProviders(<PostCard post={makePost({id:'123'})} read={false}/>);
    expect(screen.queryByRole('button',{name:'View comments'})).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
  it('loads on demand, preserves partial replies after failure and stops repeated cursors',async()=>{
    const post=makePost({id:'123'});
    const reply=makePost({id:'124',text:'First comment',inReplyTo:'123'});
    const read=vi.spyOn(api,'bookmarkReplies').mockResolvedValueOnce({posts:[reply],cursor:'next'})
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({posts:[reply,makePost({id:'125',text:'Second comment',inReplyTo:'123'})],cursor:'next'});
    renderWithProviders(<PostCard post={post} read={false} isBookmark/>);
    expect(read).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button',{name:'View comments'}));
    expect(await screen.findByText('First comment')).toBeInTheDocument();
    expect(read).toHaveBeenCalledExactlyOnceWith('123',null);
    await userEvent.click(screen.getByRole('button',{name:'Load more comments'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Comments could not load');
    expect(screen.getByText('First comment')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button',{name:'Retry comments'}));
    expect(await screen.findByText('Second comment')).toBeInTheDocument();
    expect(screen.getAllByTestId('bookmark-comment')).toHaveLength(2);
    expect(screen.queryByRole('button',{name:'Load more comments'})).toBeNull();
    await userEvent.click(screen.getByRole('button',{name:'Hide comments'}));
    expect(screen.queryByRole('region',{name:'Comments'})).toBeNull();
    await userEvent.click(screen.getByRole('button',{name:'View comments'}));
    await waitFor(()=>expect(screen.getByText('First comment')).toBeInTheDocument());
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('settles an initial failure and retries without losing the bookmark',async()=>{
    const read=vi.spyOn(api,'bookmarkReplies').mockRejectedValueOnce(new Error('offline')).mockResolvedValue({posts:[],cursor:null});
    renderWithProviders(<PostCard post={makePost({id:'123',text:'Saved original'})} read={false} isBookmark/>);
    await userEvent.click(screen.getByRole('button',{name:'View comments'}));
    await userEvent.click(await screen.findByRole('button',{name:'Retry comments'}));
    expect(await screen.findByText('No comments were returned by X.')).toBeInTheDocument();
    expect(screen.getByText('Saved original')).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
