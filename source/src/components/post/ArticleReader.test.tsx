import {describe,it,expect,vi} from 'vitest';
import {screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {api} from '@/lib/api';
import {makePost,renderWithProviders} from '@/test/factories';
import {ArticleReader} from './ArticleReader';

describe('article reading',()=>{
  it('loads one requested article, preserving headings, Arabic paragraphs and literal markup',async()=>{
    const post=makePost({id:'123',isArticle:true,articleTitle:'A full title that must remain readable',text:'Preview'});
    const read=vi.spyOn(api,'postContent').mockResolvedValue({post,article:{title:post.articleTitle!,blocks:[{kind:'heading2',text:'Chapter'},{kind:'paragraph',text:'مرحبا\n\nبالعالم'},{kind:'code',text:'<script>literal text</script>'}]}});
    renderWithProviders(<ArticleReader post={post}/>);
    expect(read).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button',{name:'Read full article'}));
    expect(await screen.findByRole('heading',{name:'Chapter'})).toBeInTheDocument();
    expect(within(screen.getByTestId('article-body')).getByText(/بالعالم/).textContent).toBe('مرحبا\n\nبالعالم');
    expect(screen.getByText('<script>literal text</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();expect(read).toHaveBeenCalledTimes(1);
    read.mockRestore();
  });
  it('settles a rejected article read and permits an explicit retry',async()=>{
    const post=makePost({id:'124',isArticle:true,articleTitle:'Title'});
    const read=vi.spyOn(api,'postContent').mockRejectedValueOnce(new Error('offline')).mockResolvedValue({post,article:{title:'Title',blocks:[{kind:'paragraph',text:'Recovered article'}]}});
    renderWithProviders(<ArticleReader post={post}/>);
    await userEvent.click(screen.getByRole('button',{name:'Read full article'}));
    await userEvent.click(await screen.findByRole('button',{name:'Retry article'}));
    expect(await screen.findByText('Recovered article')).toBeInTheDocument();expect(read).toHaveBeenCalledTimes(2);
    read.mockRestore();
  });
});
