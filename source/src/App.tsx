import { useEffect, useMemo, useRef, lazy, Suspense } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { api } from "@/lib/api";
import { I18nProvider, dirFor, resolveLocale } from "@/i18n";
import { TooltipProvider } from "@/components/ui/primitives";
import { Sidebar } from "@/components/layout/Sidebar";
import { MobileNavigation } from "@/components/layout/MobileNavigation";
import { PlatformProvider, usePlatform } from "@/lib/platform";
import { startStartupSequence } from "@/hooks/useStartupSequence";
import { scrollKey, useAppStore, type RouteId } from "@/stores/useAppStore";
import { FollowingPage } from "@/pages/Following";
import { IosWelcome } from "@/components/settings/IosConnection";
import { ReaderBoundary } from '@/components/layout/ReaderBoundary';
import { startRuntime, useRuntimeStore } from '@/lib/runtime';
import { setAutoCheck, setMonitoringInterval } from '@/hooks/useStartupSequence';
const OriginalsPage = lazy(() => import('@/pages/Originals').then(m => ({ default: m.OriginalsPage })));
const FocusFeedPage = lazy(() => import('@/pages/FocusFeed').then(m => ({ default: m.FocusFeedPage })));
const GroupsPage = lazy(() => import('@/pages/Groups').then(m => ({ default: m.GroupsPage })));
const BookmarksPage = lazy(() => import('@/pages/Bookmarks').then(m => ({ default: m.BookmarksPage })));
const FollowingManagerPage = lazy(() => import('@/pages/FollowingManager').then(m => ({ default: m.FollowingManagerPage })));
const ProfilePage = lazy(() => import('@/pages/Profile').then(m => ({ default: m.ProfilePage })));
const DiagnosticsPage = lazy(() => import('@/pages/Diagnostics').then(m => ({ default: m.DiagnosticsPage })));
const SettingsPage = lazy(() => import('@/pages/Settings').then(m => ({ default: m.SettingsPage })));
const SearchPage = lazy(() => import('@/pages/LocalSearch').then(m => ({ default: m.LocalSearchPage })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 20_000,
    },
  },
});

function Shell() {
  const { isIphone } = usePlatform();
  const route = useAppStore((s) => s.route);
  const profileUsername = useAppStore((s) => s.profileUsername);
  const setRoute = useAppStore((s) => s.setRoute);
  const rememberScroll = useAppStore((s) => s.rememberScroll);
  const prefs = useAppStore((s) => s.prefs);
  const runtime = useRuntimeStore(state => state.snapshot);

  const hydratePrefs = useAppStore((s) => s.hydratePrefs);

  const stats = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });
  const session = useQuery({ queryKey: ["sessionStatus"], queryFn: api.sessionStatus });
  const showWelcome = isIphone && session.data?.hasCredentials === false && route !== 'settings';

  // Validate the stored session once, at startup, through the startup sequence
  // and nowhere else.
  //
  // This used to call `api.checkSession()` directly, which was a second probe
  // racing the one `useStartupSequence` already runs — the same shape as the
  // bug that launched two `twitter.exe` processes at startup. Rust's
  // single-flight flag keeps that from costing a second process, but "exactly
  // one startup probe" is a property of this call site, not something the
  // backend can be asked to paper over.
  useEffect(() => {
    startRuntime();
    startStartupSequence();
  }, []);
  useEffect(() => { setAutoCheck(prefs.autoCheckConnection); setMonitoringInterval(prefs.monitorIntervalMinutes); }, [prefs.autoCheckConnection,prefs.monitorIntervalMinutes]);
  useEffect(() => {
    document.documentElement.style.setProperty('--reading-scale',String(prefs.readingSize / 100 * runtime.contentSizeScale));
    document.documentElement.dataset.reduceMotion = String(runtime.reduceMotion);
    document.documentElement.dataset.reduceTransparency = String(runtime.reduceTransparency);
  }, [prefs.readingSize,runtime.contentSizeScale,runtime.reduceMotion,runtime.reduceTransparency]);
  useEffect(() => {
    if (runtime.memoryRevision === 0) return;
    queryClient.removeQueries({ predicate: query => query.getObserversCount() === 0 && !['sessionStatus'].includes(String(query.queryKey[0])) });
  }, [runtime.memoryRevision]);

  // Language, theme and density are the only preferences that survive a
  // restart; everything else starts fresh with the session.
  useEffect(() => {
    void hydratePrefs();
  }, [hydratePrefs]);

  // Honour --page / FFN_PAGE so a window can open straight onto a given page.
  useEffect(() => {
    let cancelled = false;
    api
      .initialRoute()
      .then((r) => {
        if (!cancelled && r) setRoute(r as RouteId);
      })
      .catch(() => {
        /* no starting page requested */
      });
    return () => {
      cancelled = true;
    };
  }, [setRoute]);

  // "system" is resolved here rather than stored, so changing the Windows
  // language takes effect on the next launch without touching preferences.
  const locale = useMemo(() => resolveLocale(prefs.language), [prefs.language]);
  const dir = dirFor(locale);

  // Theme and document direction follow preferences. `dir` on <html> is what
  // makes the whole interface mirror, including scrollbars and focus order.
  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme;
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [prefs.theme, locale, dir]);

  // Keyboard shortcuts: Ctrl+1..9 jump between the main views,
  // Ctrl+0 opens the Following Manager, Ctrl+D Diagnostics, Ctrl+, Settings.
  useEffect(() => {
    // Ctrl+1 is the feed, because the feed is where the app opens. The order
    // follows the sidebar top to bottom, so the number is where the eye is.
    const order = [
      "following",
      "originals",
      "focus",
      "accounts",
      "groups",
      "bookmarks",
    ] as const;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey) return;
      if (e.key === "0") {
        e.preventDefault();
        setRoute("accounts");
        return;
      }
      if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        setRoute("diagnostics");
        return;
      }
      if (e.key === ",") {
        e.preventDefault();
        setRoute("settings");
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= order.length) {
        e.preventDefault();
        setRoute(order[n - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setRoute]);

  // The scrolling element is here, not inside the pages, so remembering an
  // offset has to happen here too. `key` remounts the page on navigation —
  // which is what keeps one page's state from leaking into the next — and a
  // remount starts at the top, so the offset is restored deliberately after
  // paint. Two profiles in a row are different pages, hence the username.
  const key = `${scrollKey(route, profileUsername)}:${session.data?.account?.id ?? 'signed-out'}`;
  const main = useRef<HTMLElement>(null);
  const latest = useRef(0);
  const restoring = useRef(false);

  const onScroll = () => {
    if (restoring.current) return;
    latest.current = main.current?.scrollTop ?? 0;
  };

  useEffect(() => {
    const el = main.current;
    if (!el) return;
    const saved = useAppStore.getState().scrollPositions[key] ?? 0;
    latest.current = saved;
    restoring.current = saved > 0;
    let observer: MutationObserver | null = null;
    const stop = () => { restoring.current = false; observer?.disconnect(); };
    const restore = () => {
      if (!restoring.current || el.scrollHeight - el.clientHeight < saved) return;
      el.scrollTop = saved; stop();
    };
    if (saved > 0) {
      observer = new MutationObserver(restore); observer.observe(el,{childList:true,subtree:true});
      requestAnimationFrame(restore);
      el.addEventListener('touchstart',stop,{once:true,passive:true});el.addEventListener('wheel',stop,{once:true,passive:true});
    }
    const deadline = window.setTimeout(stop,10000);
    return () => {
      stop(); window.clearTimeout(deadline); el.removeEventListener('touchstart',stop);el.removeEventListener('wheel',stop);
      rememberScroll(key, latest.current);
    };
  }, [key, rememberScroll]);

  // No `home` entry: `resolveRoute` sends it to the feed before it gets here,
  // so there is one feed implementation rather than a dashboard beside it.
  const pages: Record<string, React.ReactNode> = {
    following: <FollowingPage />,
    originals: <OriginalsPage />,
    focus: <FocusFeedPage />,
    groups: <GroupsPage />,
    bookmarks: <BookmarksPage />,
    search: <SearchPage />,
    accounts: <FollowingManagerPage />,
    // Keyed by handle as well as route, so following a mention from one
    // profile to another remounts rather than reusing the first one's state.
    profile: profileUsername ? (
      <ProfilePage key={profileUsername} />
    ) : (
      <FollowingPage />
    ),
    diagnostics: <DiagnosticsPage />,
    settings: <SettingsPage />,
  };

  return (
    <I18nProvider locale={locale}>
      <div className="flex h-full w-full overflow-hidden bg-surface-0">
        {isIphone ? null : <Sidebar unread={stats.data?.unreadCount ?? 0} />}
        <main
          key={key}
          ref={main}
          onScroll={onScroll}
          className={
            isIphone
              ? "flex-1 min-w-0 min-h-0 overflow-y-auto pb-[var(--reader-bottom-inset,0px)] ffn-rise"
              : "flex-1 min-w-0 min-h-0 overflow-y-auto ffn-rise"
          }
        >
          <ReaderBoundary key={key}><Suspense fallback={<div role="status" className="px-4 py-8 text-ink-mute">{locale === 'ar' ? 'جارٍ تحميل الصفحة…' : 'Loading page…'}</div>}>{showWelcome ? <IosWelcome /> : pages[route] ?? <FollowingPage />}</Suspense></ReaderBoundary>
        </main>
        {isIphone && !showWelcome ? (
          <MobileNavigation unread={stats.data?.unreadCount ?? 0} />
        ) : null}
      </div>
    </I18nProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <PlatformProvider>
        <TooltipProvider>
          <Shell />
        </TooltipProvider>
      </PlatformProvider>
    </QueryClientProvider>
  );
}
