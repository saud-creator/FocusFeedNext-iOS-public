import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { api, isTauri } from "@/lib/api";

// Repeated authors in visible cards share a single local registration repair.
const repairs = new Map<string, Promise<string | null>>();
function repairPicture(username: string, source: string) {
  const key = `${username.toLowerCase()}:${source}`;
  let pending = repairs.get(key);
  if (!pending) {
    pending = api.recoverAccountImage(username).finally(() => repairs.delete(key));
    repairs.set(key, pending);
  }
  return pending;
}

/**
 * The minimum an account has to carry to be shown and opened.
 *
 * Deliberately narrower than `Author`: a quoted post's author arrives with
 * only a handle and a display name, and a suggestion row built from a search
 * result has no counts either. Anything that can be identified by a handle can
 * be rendered here.
 */
export interface AccountRef {
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  verified?: boolean | null;
}

/** Strip a leading "@" and surrounding whitespace. Case is preserved. */
export function cleanHandle(username: string): string {
  return username.trim().replace(/^@+/, "");
}

/**
 * The form two handles are compared in: no "@", locale-lowercased.
 *
 * `toLocaleLowerCase` rather than `toLowerCase` because display names are
 * matched with the same helper and may be Arabic or Turkish, where the two
 * disagree.
 */
export function handleKey(username: string): string {
  return cleanHandle(username).toLocaleLowerCase();
}

/** What to show when there is no avatar image: the first two characters. */
export function accountInitials(account: AccountRef): string {
  const source = account.displayName?.trim() || cleanHandle(account.username);
  return Array.from(source).slice(0, 2).join('').toLocaleUpperCase() || "?";
}

/** The name to address an account by, falling back to its handle. */
export function accountLabel(account: AccountRef): string {
  const name = account.displayName?.trim();
  return name || cleanHandle(account.username);
}

/**
 * An account's picture, or its initials when it has none.
 *
 * Purely presentational and never interactive — the clickable wrapper lives in
 * `AccountIdentity`, so an avatar can also appear inside a row that is itself
 * a button without nesting one interactive element inside another.
 */
export function Avatar({
  author,
  size = 40,
  className,
  style,
}: {
  author: AccountRef;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return <AccountPicture key={`${handleKey(author.username)}:${author.avatarUrl ?? ''}`} author={author} size={size} className={className} style={style}/>;
}

function AccountPicture({author,size,className,style}: {author:AccountRef;size:number;className?:string;style?:CSSProperties}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [loadedSource,setLoadedSource]=useState<string|null>(null);
  const [renewed,setRenewed]=useState<string|null>(null);
  const [attempt,setAttempt]=useState(0);
  const recovering=useRef(false);
  const owner=useRef(true);
  useEffect(()=>{owner.current=true;return()=>{owner.current=false;};},[]);
  const source = renewed || author.avatarUrl?.trim();
  const fail=()=>{
    if(!source)return;
    if(recovering.current || !isTauri()) {setFailedSource(source);return;}
    recovering.current=true;
    void repairPicture(cleanHandle(author.username),source).then(fresh=>{
      if(!owner.current)return;
      if(!fresh){setFailedSource(source);return;}
      setLoadedSource(null);setRenewed(fresh);setAttempt(1);
    }).catch(()=>{if(owner.current)setFailedSource(source);});
  };
  return source && source !== failedSource ? (
    <div aria-hidden className={cn("relative rounded-full shrink-0 overflow-hidden bg-surface-4 text-ink-dim grid place-items-center font-semibold",className)} style={{width:size,height:size,fontSize:size*0.36,...style}}>
      <span style={{visibility:loadedSource===source?'hidden':'visible'}}>{accountInitials(author)}</span>
    <img
      key={`${source}:${attempt}`}
      src={source}
      alt=""
      width={size}
      height={size}
      loading="eager"
      decoding="async"
      draggable={false}
      onError={fail}
      onLoad={()=>setLoadedSource(source)}
      className={cn(
        "absolute inset-0 rounded-full object-cover",
      )}
      style={{ width: size, height: size, visibility:loadedSource===source?'visible':'hidden' }}
    />
    </div>
  ) : (
    <div
      aria-hidden
      className={cn(
        "rounded-full shrink-0 bg-surface-4 text-ink-dim grid place-items-center font-semibold",
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.36, ...style }}
    >
      {accountInitials(author)}
    </div>
  );
}
