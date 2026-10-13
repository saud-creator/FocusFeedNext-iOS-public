import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { VideoPlayer } from './VideoPlayer';
import { renderWithProviders } from '@/test/factories';
import { defaultPreferences, useAppStore } from '@/stores/useAppStore';
import { resetPlayback } from '@/lib/mediaSession';
import { isOverlayActive } from '@/lib/nativeOverlay';

vi.mock('@/lib/platform',()=>({usePlatform:()=>({isIphone:true,platform:'ios'})}));
const clip={kind:'video' as const,url:'https://cdn.example.com/clip.mp4',width:320,height:568,durationMs:8000,variants:[]};
beforeEach(()=>{
  resetPlayback();
  useAppStore.setState({prefs:{...defaultPreferences,autoplay:'off'}});
  vi.stubGlobal('IntersectionObserver',undefined);
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
const video=()=>screen.getByTestId('video-element') as HTMLVideoElement;

describe('iPhone playback recovery',()=>{
  it('uses native video fullscreen without moving/replacing the decoder and returns on the OS Done event',()=>{
    renderWithProviders(<VideoPlayer media={clip} />);
    const element=video();
    Object.defineProperty(element,'readyState',{value:1});
    const enter=vi.fn(()=>{element.dispatchEvent(new Event('webkitbeginfullscreen'));});
    Object.assign(element,{webkitEnterFullscreen:enter,webkitDisplayingFullscreen:true});
    fireEvent.click(screen.getByTestId('video-enter-fullscreen'));
    expect(enter).toHaveBeenCalledTimes(1);
    expect(video()).toBe(element);
    expect(screen.queryByTestId('video-surface-placeholder')).not.toBeInTheDocument();
    expect(screen.queryByTestId('video-fullscreen-controls')).not.toBeInTheDocument();
    expect(isOverlayActive()).toBe(true);
    Object.assign(element,{webkitDisplayingFullscreen:false});
    act(()=>element.dispatchEvent(new Event('webkitendfullscreen')));
    expect(screen.getByTestId('video-surface')).toHaveAttribute('data-fullscreen','false');
    expect(isOverlayActive()).toBe(false);
  });
  it('keeps a working exit in fallback fullscreen after a playback error and hides unsupported software volume',()=>{
    renderWithProviders(<VideoPlayer media={clip} />);
    fireEvent.click(screen.getByTestId('video-enter-fullscreen'));
    expect(screen.queryByTestId('video-volume')).not.toBeInTheDocument();
    expect(screen.getByText('Use the volume buttons')).toBeInTheDocument();
    fireEvent.error(video());
    expect(screen.getByTestId('video-exit-fullscreen')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('video-exit-fullscreen'));
    expect(screen.getByTestId('video-surface')).toHaveAttribute('data-fullscreen','false');
    expect(isOverlayActive()).toBe(false);
  });
  it('releases the native overlay when the app backgrounds during native fullscreen',()=>{
    const runtime = import('@/lib/runtime');
    return runtime.then(({useRuntimeStore,defaultRuntime})=>{
      useRuntimeStore.setState({snapshot:defaultRuntime});
      renderWithProviders(<VideoPlayer media={clip} />);
      const element=video();
      Object.defineProperty(element,'readyState',{value:1});
      const leave=vi.fn();
      Object.assign(element,{webkitEnterFullscreen:vi.fn(),webkitExitFullscreen:leave});
      fireEvent.click(screen.getByTestId('video-enter-fullscreen'));
      act(()=>useRuntimeStore.setState({snapshot:{...defaultRuntime,foreground:false}}));
      expect(leave).toHaveBeenCalledTimes(1);
      expect(isOverlayActive()).toBe(false);
      act(()=>useRuntimeStore.setState({snapshot:defaultRuntime}));
      expect(screen.getByTestId('video-surface')).toHaveAttribute('data-fullscreen','false');
    });
  });
  it('treats an iOS play-permission refusal as paused instead of a broken source',async()=>{
    vi.spyOn(HTMLMediaElement.prototype,'play').mockRejectedValue(new DOMException('Needs a tap','NotAllowedError'));
    renderWithProviders(<VideoPlayer media={clip} />);
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Play'}));});
    expect(screen.queryByText(/could not be played|Unable to play/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Play'})).toBeEnabled();
  });
});
