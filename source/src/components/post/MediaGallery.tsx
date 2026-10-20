import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { api, isTauri, type Post,type PostMedia } from "@/lib/api";
import { Lightbox } from "@/components/media/Lightbox";
import { isVideoLike } from "@/lib/media";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { VideoPlayer } from "./VideoPlayer";
import { usePlatform } from '@/lib/platform';
import { useEffectivePolicy } from '@/lib/runtime';
import { useNativeMedia } from '@/lib/nativeMedia';
import {intersectionRootOf} from '@/lib/scroll';

/**
 * The tallest a single image may render.
 *
 * A phone screenshot is roughly 1:2, so an uncapped portrait photo pushes the
 * text of the next post a full screen away. Expressed in `vh` so the cap tracks
 * the window rather than a laptop-sized guess, with a pixel term to stop it
 * becoming absurd on a very tall monitor.
 */
const SINGLE_MAX_HEIGHT = "min(65svh, 560px)";

/** A predictable first measurement when the provider omitted media bounds. */
const DEFAULT_MEDIA_RATIO = 16 / 9;

/** Row height for a multi-image grid, in px. Two rows is the deepest layout. */
const GRID_ROW_HEIGHT = 200;

/**
 * Images are requested only when their frame is roughly one screen-runway
 * away. Once the observer admits a source, eager loading avoids a second,
 * browser-specific lazy threshold delaying that bounded prefetch.
 */
function LazyFeedImage({
  media,
  style,
  onError,
  onLoad,
}: {
  media: PostMedia;
  style: CSSProperties;
  onError?: () => void;
  onLoad?: (width:number,height:number) => void;
}) {
  const frame = useRef<HTMLImageElement>(null);
  const [nearby, setNearby] = useState(false);
  const { isIphone } = usePlatform();
  const policy = useEffectivePolicy(isIphone);

  useEffect(() => {
    const image = frame.current;
    if (!image) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearby(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setNearby(true);
          observer.disconnect();
        }
      },
      { root:intersectionRootOf(image),rootMargin: `${policy.imageMargin}px 0px` },
    );
    observer.observe(image);
    return () => observer.disconnect();
  }, [policy.imageMargin]);

  return (
    <img
      ref={frame}
      src={nearby ? media.url : undefined}
      alt={media.alt ?? ""}
      loading={nearby ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      style={style}
      data-media-lazy="true"
      onError={onError}
      onLoad={event=>onLoad?.(event.currentTarget.naturalWidth,event.currentTarget.naturalHeight)}
    />
  );
}

function ImageTile({media, onOpen, onRecover, adaptive, single, spanFull}: {media:PostMedia;onOpen:()=>void;onRecover:()=>Promise<void>;adaptive:boolean;single:boolean;spanFull:boolean}) {
  const {t}=useI18n();
  const [status,setStatus]=useState<'loading'|'loaded'|'failed'>('loading');
  const [attempt,setAttempt]=useState(0);
  const [retrying,setRetrying]=useState(false);
  const [intrinsicRatio,setIntrinsicRatio]=useState<number|null>(null);
  const ratio=intrinsicRatio ?? (media.width && media.height ? media.width/media.height : DEFAULT_MEDIA_RATIO);
  if(status==='failed' || !media.url) return <div className="rounded-lg border border-edge bg-surface-2 p-4 text-center text-sm text-ink-dim" role="group" aria-label={t('post.media.imageFailed')}>
    <p>{t('post.media.imageFailed')}</p>
    {media.url && <button type="button" disabled={retrying} className="mt-2 min-h-11 px-3 text-accent" onClick={()=>{
      setRetrying(true);
      void onRecover().then(()=>{setAttempt(n=>n+1);setStatus('loading');}).catch(()=>setStatus('failed')).finally(()=>setRetrying(false));
    }}>{t('post.media.retryImage')}</button>}
  </div>;
  return <button type="button" onClick={onOpen}
    className={cn('relative block w-full overflow-hidden rounded-lg border border-edge bg-surface-3 cursor-zoom-in self-start',spanFull && !adaptive && 'row-span-2')}
    style={single || adaptive ? {aspectRatio:String(ratio),maxHeight:adaptive ? undefined : SINGLE_MAX_HEIGHT} : {height:'100%'}}
    aria-busy={status==='loading'}
    aria-label={media.alt ? t('post.media.openImageAlt',{alt:media.alt}) : t('post.media.openImage')}>
    <LazyFeedImage key={`${media.url}:${attempt}`} media={media} onLoad={(width,height)=>{if(width>0 && height>0)setIntrinsicRatio(width/height);setStatus('loaded');}} onError={()=>setStatus('failed')} style={{width:'100%',height:'100%',objectFit:'contain',visibility:status==='loaded'?'visible':'hidden'}}/>
  </button>;
}

/**
 * Post media, at the proportions it was actually taken in.
 *
 * ## Why nothing is cropped
 *
 * The gallery used to give every image in a multi-image post a squarish cell
 * and `object-fit: cover`, which is how X itself does it. On a feed of charts,
 * screenshots and code that is the wrong trade: the interesting part of a
 * benchmark plot is its axes, and cover removes whichever edge does not fit.
 * Every image here is `contain` instead — the frame stays tidy, the picture
 * keeps its own shape, and whatever space is left over is a neutral letterbox
 * rather than a stretched or silently clipped photograph.
 */
export function MediaGallery({
  media,
  defaultSpeed,
  postId,
  recoverOverride,
  onPostRecovered,
}: {
  media: PostMedia[];
  defaultSpeed?: number;
  postId?: string;
  recoverOverride?:()=>Promise<void>;
  onPostRecovered?:(post:Post)=>void;
}) {
  const { isIphone } = usePlatform();
  const {t,locale}=useI18n();
  const nativeMedia=useNativeMedia();
  const [lightboxAt, setLightboxAt] = useState<number | null>(null);
  const [recovered,setRecovered]=useState<{original:PostMedia[];items:PostMedia[]}|null>(null);
  const owner=useRef(true);
  useEffect(()=>{owner.current=true;return()=>{owner.current=false;};},[]);
  const recover=async(freshSource=false)=>{
    if(recoverOverride){await recoverOverride();return;}
    if(!postId || !isTauri())return;
    // Automatic registration repair reads the session cache. A deliberate
    // video retry refreshes that single post's provider URLs on iOS.
    const fresh=freshSource && isIphone && isTauri() ? (await api.postContent(postId)).post : await api.post(postId);
    if(owner.current && fresh) {setRecovered({original:media,items:fresh.media});onPostRecovered?.(fresh);}
  };
  const displayed=recovered?.original===media ? recovered.items : media;

  if (!media || media.length === 0) return null;

  // GIFs belong with the videos: X serves animated GIFs as MP4, so pointing an
  // <img> at one renders nothing at all. `isVideoLike` is the single place that
  // decision is made.
  const videos = displayed.filter(isVideoLike);
  const images = displayed.filter((m) => !isVideoLike(m));

  const single = images.length === 1;
  // Two images sit side by side in one row; three or four stack into two.
  const rows = images.length <= 2 ? 1 : 2;
  const openImage = async (index:number) => {
    if(isIphone && isTauri()) {
      try { await nativeMedia.present(images.map(m=>({url:m.url,kind:'image',alt:m.alt})),index,{retryLabel:t('post.media.retryImage'),locale});return; }
      catch { /* The safe-area-aware web viewer remains a recovery path. */ }
    }
    setLightboxAt(index);
  };

  return (
    <div className="mt-3 space-y-2">
      {videos.map((v, i) => (
        <VideoPlayer key={`v-${i}`} media={v} defaultSpeed={defaultSpeed} onRecover={recover} />
      ))}

      {images.length > 0 ? (
        <div
          data-testid="media-grid"
          className={cn(
            "grid gap-1.5 rounded-xl overflow-hidden",
            single ? "grid-cols-1" : "grid-cols-2",
          )}
          // A grid gets fixed rows so the cells stay aligned; the images inside
          // them do not, which is what keeps the tidiness from costing shape.
          style={
            single || isIphone
              ? undefined
              : { gridTemplateRows: `repeat(${rows}, ${isIphone ? 'clamp(120px, 35vw, 180px)' : `${GRID_ROW_HEIGHT}px`})` }
          }
        >
          {images.map((m, i) => <ImageTile key={`${m.url}:${i}`} media={m} single={single} adaptive={isIphone} spanFull={images.length===3 && i===0} onRecover={recover} onOpen={()=>void openImage(i)}/>)}
        </div>
      ) : null}

      {lightboxAt !== null ? (
        <Lightbox
          media={images}
          index={lightboxAt}
          onClose={() => setLightboxAt(null)}
        />
      ) : null}
    </div>
  );
}
