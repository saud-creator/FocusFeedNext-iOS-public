import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Avatar } from './Avatar';

describe('account picture recovery',()=>{
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
