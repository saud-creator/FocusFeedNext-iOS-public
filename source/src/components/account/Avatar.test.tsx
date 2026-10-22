import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { Avatar } from './Avatar';
import { api,isTauri } from '@/lib/api';
vi.mock('@/lib/api',()=>({isTauri:vi.fn(()=>false),api:{recoverAccountImage:vi.fn()}}));
beforeEach(()=>{vi.mocked(isTauri).mockReturnValue(false);vi.mocked(api.recoverAccountImage).mockReset();});

describe('account picture recovery',()=>{
  it('renews a failed registration once and can display the actual picture',async()=>{
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(api.recoverAccountImage).mockResolvedValue('http://127.0.0.1:8123/media/token/renewed');
    const view=render(<Avatar author={{username:'reader',avatarUrl:'http://127.0.0.1:8123/media/token/expired'}}/>);
    fireEvent.error(view.container.querySelector('img')!);
    await waitFor(()=>expect(view.container.querySelector('img')).toHaveAttribute('src','http://127.0.0.1:8123/media/token/renewed'));
    fireEvent.load(view.container.querySelector('img')!);
    expect(screen.getByText('RE')).not.toBeVisible();
    fireEvent.error(view.container.querySelector('img')!);
    expect(view.container.querySelector('img')).toBeNull();
    expect(api.recoverAccountImage).toHaveBeenCalledExactlyOnceWith('reader');
  });
  it('retries a transient failure even if the registration is unchanged',async()=>{
    vi.mocked(isTauri).mockReturnValue(true);
    const source='http://127.0.0.1:8123/media/token/picture';
    vi.mocked(api.recoverAccountImage).mockResolvedValue(source);
    const view=render(<Avatar author={{username:'reader',avatarUrl:source}}/>);
    const first=view.container.querySelector('img')!;
    fireEvent.error(first);
    await waitFor(()=>expect(view.container.querySelector('img')).not.toBe(first));
    expect(view.container.querySelector('img')).toHaveAttribute('loading','eager');
  });
  it('ignores a repair that finishes after switching account pictures',async()=>{
    vi.mocked(isTauri).mockReturnValue(true);
    let finish!:(value:string|null)=>void;
    vi.mocked(api.recoverAccountImage).mockReturnValue(new Promise(resolve=>{finish=resolve;}));
    const view=render(<Avatar author={{username:'old',avatarUrl:'old'}}/>);
    fireEvent.error(view.container.querySelector('img')!);
    view.rerender(<Avatar author={{username:'new',avatarUrl:'new'}}/>);
    await act(async()=>finish('stale'));
    expect(view.container.querySelector('img')).toHaveAttribute('src','new');
  });
  it('keeps initials visible until image loading actually completes',()=>{
    const view=render(<Avatar author={{username:'reader',avatarUrl:'http://127.0.0.1:8123/media/token/picture'}}/>);
    expect(screen.getByText('RE')).toBeVisible();
    fireEvent.load(view.container.querySelector('img')!);
    expect(screen.getByText('RE')).not.toBeVisible();
  });
  it('replaces a failed image with readable initials and retries only when its source changes',()=>{
    const author={username:'reader',displayName:'Reader',avatarUrl:'http://127.0.0.1:8123/media/token/first'};
    const view=render(<Avatar author={author} />);
    const image=view.container.querySelector('img')!;
    fireEvent.error(image);
    expect(view.container.querySelector('img')).toBeNull();
    expect(screen.getByText('RE')).toBeInTheDocument();
    view.rerender(<Avatar author={{...author,avatarUrl:'http://127.0.0.1:8123/media/token/new'}} />);
    expect(view.container.querySelector('img')).toHaveAttribute('src','http://127.0.0.1:8123/media/token/new');
  });
  it('shows initials for a blank source without reserving an empty black image',()=>{
    const view=render(<Avatar author={{username:'reader',avatarUrl:'   '}} size={48} />);
    expect(view.container.querySelector('img')).toBeNull();
    expect(screen.getByText('RE')).toHaveStyle({width:'48px',height:'48px'});
  });
});
