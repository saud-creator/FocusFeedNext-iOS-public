import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {screen,fireEvent,waitFor} from '@testing-library/react';
import {api,isTauri} from '@/lib/api';
import {MediaGallery} from './MediaGallery';
import {makeImage,makePost,renderWithProviders} from '@/test/factories';
vi.mock('@/lib/platform',()=>({usePlatform:()=>({isIphone:true})}));
vi.mock('@/lib/api',async importOriginal=>{
  const actual=await importOriginal<typeof import('@/lib/api')>();
  return {...actual,isTauri:vi.fn(()=>false),api:{...actual.api,post:vi.fn()}};
});
beforeEach(()=>{vi.mocked(isTauri).mockReturnValue(false);vi.mocked(api.post).mockReset();vi.stubGlobal('IntersectionObserver',undefined);});
afterEach(()=>vi.unstubAllGlobals());

describe('phone image delivery',()=>{
  it('renews an expired registration from the session post without replacing the card',async()=>{
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(api.post).mockResolvedValue(makePost({id:'123',media:[makeImage({url:'http://127.0.0.1:8123/media/secret/renewed'})]}));
    renderWithProviders(<MediaGallery media={[makeImage()]} postId="123"/>);
    fireEvent.error(screen.getByAltText('Benchmark chart'));
    fireEvent.click(screen.getByRole('button',{name:'Retry image'}));
    await waitFor(()=>expect(screen.getByAltText('Benchmark chart')).toHaveAttribute('src','http://127.0.0.1:8123/media/secret/renewed'));
    expect(api.post).toHaveBeenCalledExactlyOnceWith('123');
  });
  it('uses decoded photo proportions when provider dimensions are missing or wrong',()=>{
    renderWithProviders(<MediaGallery media={[makeImage({width:1600,height:900})]}/>);
    const image=screen.getByAltText('Benchmark chart');
    Object.defineProperties(image,{naturalWidth:{value:600},naturalHeight:{value:1200}});
    fireEvent.load(image);
    expect(image).toBeVisible();
    expect(screen.getByRole('button',{name:'Open image: Benchmark chart'}).style.aspectRatio).toBe('0.5 / 1');
  });
  it('does not force mixed-aspect photos into fixed padded rows',()=>{
    renderWithProviders(<MediaGallery media={[makeImage({width:1200,height:600}),makeImage({width:600,height:1200})]}/>);
    expect(screen.getByTestId('media-grid').style.gridTemplateRows).toBe('');
  });
  it('replaces a broken image with an accessible retry state',async()=>{
    renderWithProviders(<MediaGallery media={[makeImage()]}/>);
    const image=screen.getByAltText('Benchmark chart');
    fireEvent.error(image);
    expect(screen.queryByAltText('Benchmark chart')).not.toBeInTheDocument();
    const retry=screen.getByRole('button',{name:'Retry image'});
    fireEvent.click(retry);
    await waitFor(()=>expect(screen.getByAltText('Benchmark chart')).toBeInTheDocument());
  });
});
