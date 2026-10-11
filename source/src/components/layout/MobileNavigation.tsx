import { useEffect, useState } from "react";
import {
  Bookmark,
  BookMarked,
  Focus,
  Layers,
  Menu,
  PenLine,
  Settings,
  Search,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { useAppStore, type RouteId } from "@/stores/useAppStore";
import { api, isTauri } from "@/lib/api";
import { mobileTabIds } from '@/lib/navigation';
import { isOverlayActive } from '@/lib/nativeOverlay';

interface MobileItem {
  id: RouteId;
  label: string;
  icon: typeof Layers;
}

export function MobileNavigation({ unread }: { unread: number }) {
  const route = useAppStore((state) => state.route);
  const setRoute = useAppStore((state) => state.setRoute);
  const { t, formatNumber } = useI18n();
  const [moreOpen, setMoreOpen] = useState(false);
  const [nativeChrome, setNativeChrome] = useState(false);
  const theme = useAppStore(state => state.prefs.theme);
  const tabs = useAppStore(state => state.prefs.mobileTabs);
  const accent = useAppStore(state => state.prefs.accent);
  const haptics = useAppStore(state => state.prefs.haptics);
  const [fullscreen, setFullscreen] = useState(isOverlayActive);

  useEffect(() => setMoreOpen(false), [route]);

  const available: MobileItem[] = [
    { id: "following", label: t("nav.followingFeed"), icon: Layers },
    { id: "focus", label: t("nav.focus"), icon: Focus },
    { id: "bookmarks", label: t("nav.bookmarks"), icon: Bookmark },
    { id: "accounts", label: t("nav.peopleYouFollow"), icon: Users },
    { id: 'originals', label: t('nav.originals'), icon: PenLine },
    { id: 'groups', label: t('nav.groups'), icon: BookMarked },
    { id: 'search', label: t('localSearch.title'), icon: Search },
  ];
  const primary = tabs.map(id => available.find(item => item.id === id)!);
  const secondary: MobileItem[] = [
    ...available.filter(item => !tabs.includes(item.id as typeof tabs[number])),
    { id: "settings", label: t("nav.settings"), icon: Settings },
  ];
  const secondaryActive = secondary.some((item) => item.id === route);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const configure = () => {
      const dark = theme === 'dark' || theme === 'oled' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      void api.configureIosChrome([
        ...primary.map(item => t(`nav.short.${item.id}`)), t('nav.mobile.more'),
      ], route, dark, !fullscreen, [...tabs, 'more'], accent, haptics, document.documentElement.dir === 'rtl', [...primary.map(item=>item.label),t('nav.mobile.more')]).then(native => { if (!cancelled) setNativeChrome(native); }).catch(() => { if (!cancelled) setNativeChrome(false); });
    };
    configure();
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', configure);
    return () => { cancelled = true; scheme.removeEventListener('change', configure); };
  }, [route, theme, t, tabs, accent, haptics, fullscreen]);
  useEffect(() => {
    const update = (event: Event) => setFullscreen((event as CustomEvent<boolean>).detail);
    window.addEventListener('ffn-fullscreen', update);
    return () => window.removeEventListener('ffn-fullscreen', update);
  }, []);

  useEffect(() => {
    const onNativeRoute = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (id === 'more') setMoreOpen(open => !open);
      else if ((mobileTabIds as readonly string[]).includes(id)) {
        setRoute(id as RouteId); setMoreOpen(false);
      }
    };
    window.addEventListener('ffn-native-route', onNativeRoute);
    return () => window.removeEventListener('ffn-native-route', onNativeRoute);
  }, [setRoute]);

  const navigate = (id: RouteId) => {
    setRoute(id);
    setMoreOpen(false);
  };

  return (
    <>
      {moreOpen ? (
        <div className="fixed inset-0 z-40" data-testid="mobile-more-menu">
          <button
            type="button"
            className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
            aria-label={t("nav.mobile.closeMore")}
            onClick={() => setMoreOpen(false)}
          />
          <section className="absolute inset-x-3 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] surface-card shadow-2xl p-2">
            <div className="flex items-center justify-between px-2 py-1.5">
              <div className="text-[12px] font-semibold uppercase tracking-wider text-ink-mute">
                {t("nav.mobile.more")}
              </div>
              <button
                type="button"
                className="grid size-9 place-items-center rounded-full text-ink-dim active:bg-surface-3"
                aria-label={t("nav.mobile.closeMore")}
                onClick={() => setMoreOpen(false)}
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {secondary.map((item) => {
                const Icon = item.icon;
                const active = route === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.id)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-14 items-center gap-3 rounded-xl px-3 text-start text-[13px]",
                      active
                        ? "bg-accent-soft text-accent"
                        : "bg-surface-1 text-ink-dim active:bg-surface-3",
                    )}
                  >
                    <Icon className="size-5 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}

      {!nativeChrome && !fullscreen && <nav
        className="ios-tabbar fixed inset-x-0 bottom-0 z-50 border-t border-edge bg-[color-mix(in_srgb,var(--surface-1)_94%,transparent)] px-1 pt-1.5 pb-[max(0.45rem,env(safe-area-inset-bottom))] backdrop-blur-xl"
        aria-label={t("nav.mobile.primary")}
      >
        <div className="mx-auto grid max-w-xl grid-cols-5">
          {primary.map((item) => {
            const Icon = item.icon;
            const active = route === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(item.id)}
                aria-current={active ? "page" : undefined}
                aria-label={item.label}
                className={cn(
                  "relative flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-medium",
                  active ? "text-accent" : "text-ink-mute active:bg-surface-3",
                )}
              >
                <span className="inline-flex shrink-0 h-[21px] items-center gap-1">
                  <Icon
                    className="size-[21px]"
                    strokeWidth={active ? 2.4 : 1.9}
                  />
                  {item.id === "following" && unread > 0 ? (
                    <span className="min-w-4 rounded-full bg-accent px-1 text-[9px] leading-4 text-white tabular-nums">
                      {unread > 99 ? "99+" : formatNumber(unread)}
                    </span>
                  ) : null}
                </span>
                <span className="w-full truncate leading-[14px]">{t(`nav.short.${item.id}`)}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setMoreOpen((value) => !value)}
            aria-expanded={moreOpen}
            className={cn(
              "flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-medium",
              secondaryActive || moreOpen
                ? "text-accent"
                : "text-ink-mute active:bg-surface-3",
            )}
          >
            <Menu
              className="size-[21px]"
              strokeWidth={secondaryActive ? 2.4 : 1.9}
            />
            <span className="w-full truncate">{t("nav.mobile.more")}</span>
          </button>
        </div>
      </nav>}
    </>
  );
}
