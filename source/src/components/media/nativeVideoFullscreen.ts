interface IosVideo extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
  webkitSupportsFullscreen?: boolean;
}

/** Invoke within the tap gesture; iPhone presents its own accessible AV player. */
export function enterNativeVideoFullscreen(video: HTMLVideoElement | null): boolean {
  if (!video || video.readyState < 1) return false;
  try {
    const target = video as IosVideo;
    if (target.webkitSupportsFullscreen === false || typeof target.webkitEnterFullscreen !== 'function') return false;
    target.webkitEnterFullscreen();
    return true;
  } catch { return false; }
}

export function leaveNativeVideoFullscreen(video: HTMLVideoElement | null) {
  try {
    const target = video as IosVideo | null;
    if (target?.webkitDisplayingFullscreen !== false) target?.webkitExitFullscreen?.();
  } catch { /* An OS dismissal may have already completed. */ }
}

export function onNativeVideoFullscreen(video: HTMLVideoElement, begin: () => void, end: () => void) {
  video.addEventListener('webkitbeginfullscreen', begin);
  video.addEventListener('webkitendfullscreen', end);
  return () => {
    video.removeEventListener('webkitbeginfullscreen', begin);
    video.removeEventListener('webkitendfullscreen', end);
  };
}
