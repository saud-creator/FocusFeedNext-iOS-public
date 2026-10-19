import {
  Activity,
  BookMarked,
  Bookmark,
  Focus,
  Layers,
  List,
  PenLine,
  Plus,
  Settings,
  Users,
} from "lucide-react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { APP_VERSION } from "@/lib/appVersion";
import { cn } from "@/lib/utils";
import { useAppStore, type RouteId } from "@/stores/useAppStore";
import { SessionDot } from "@/components/session/SessionDot";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, Input } from "@/components/ui/primitives";

interface NavItem {
  id: RouteId;
  label: string;
  icon: typeof Layers;
  badge?: number;
}

export function Sidebar({ unread }: { unread: number }) {
  const route = useAppStore((s) => s.route);
  const setRoute = useAppStore((s) => s.setRoute);
  const selectedListId = useAppStore((s) => s.selectedListId);
  const setSelectedListId = useAppStore((s) => s.setSelectedListId);
  const { t, formatNumber } = useI18n();
  const qc = useQueryClient();
  const [creatingList, setCreatingList] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [newListColor, setNewListColor] = useState("#6366f1");
  const listColors = [
    "#6366f1",
    "#10b981",
    "#f59e0b",
    "#ec4899",
    "#0ea5e9",
    "#ef4444",
  ];

  // The account chip reads the same cached snapshot the connection screen
  // does, so the two can never disagree about who is signed in.
  const session = useQuery({
    queryKey: ["sessionStatus"],
    queryFn: api.sessionStatus,
  });
  const snapshot = session.data;
  const canEditLists = Boolean(snapshot?.account);
  const lists = useQuery({
    queryKey: ["groups"],
    queryFn: api.groups,
    enabled: Boolean(snapshot?.account),
  });
  const createList = useMutation({
    mutationFn: () =>
      api.createGroup(
        `g_${Date.now().toString(36)}`,
        newListName.trim(),
        newListColor,
      ),
    onSuccess: () => {
      setNewListName("");
      setNewListColor("#6366f1");
      setCreatingList(false);
      void qc.invalidateQueries({ queryKey: ["groups"] });
      void qc.invalidateQueries({ queryKey: ["accountLists"] });
    },
  });

  const groups: { title: string; items: NavItem[] }[] = [
    {
      // Following comes first and opens the app: this is a reader, so the
      // first thing on screen is what there is to read. There is no Home
      // entry — the dashboard it pointed at was a page about the app.
      title: t("nav.section.following"),
      items: [
        {
          id: "following",
          label: t("nav.followingFeed"),
          icon: Layers,
          badge: unread,
        },
        // What they wrote, with everything they merely passed along taken out.
        { id: "originals", label: t("nav.originals"), icon: PenLine },
        { id: "accounts", label: t("nav.peopleYouFollow"), icon: Users },
      ],
    },
    {
      // No Search. It was the only screen that talked to X while the reader
      // was still typing — a handle lookup per pause, each one its own child
      // process — and this is a reader for the accounts you already chose, not
      // a way to go looking for more.
      title: t("nav.section.read"),
      items: [{ id: "focus", label: t("nav.focus"), icon: Focus }],
    },
    {
      // No X Lists and no Pinned accounts. X Lists cannot be enumerated by this
      // backend at all — twitter-cli has no such command — so an X-list page
      // could only ever say "No lists available", which reads as "you have none"
      // rather than "this app cannot ask". Pinned accounts was a page whose
      // own empty state told the reader to go and use a screen that no longer
      // exists under that name. Both are gone rather than half-built.
      // No Local library either. It was a second, private bookmark list that
      // only this machine could see, sitting next to the reader's real one —
      // and "did I save this here or on X?" is a question the app was asking
      // rather than answering. Bookmarks below is X's own list.
      title: t("nav.section.organize"),
      items: [
        { id: "groups", label: t("nav.groups"), icon: BookMarked },
        { id: "bookmarks", label: t("nav.bookmarks"), icon: Bookmark },
      ],
    },
    {
      title: t("nav.section.system"),
      items: [
        { id: "diagnostics", label: t("nav.diagnostics"), icon: Activity },
        { id: "settings", label: t("nav.settings"), icon: Settings },
      ],
    },
  ];

  return (
    // `border-e` rather than `border-r`: the divider follows the writing
    // direction, so the sidebar sits on the correct edge in Arabic.
    <aside className="w-[236px] shrink-0 surface-panel border-e border-t-0 border-b-0 border-s-0 flex flex-col h-full">
      <div className="px-4 py-4 flex items-center gap-2.5">
        <div className="size-8 rounded-[10px] bg-accent grid place-items-center shrink-0">
          <Focus className="size-4 text-white" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <div className="text-[14px] font-semibold text-ink leading-tight truncate">
              Focus Feed
            </div>
            <span
              data-testid="app-version"
              className="shrink-0 rounded-md border border-edge px-1.5 py-0.5 text-[9px] font-medium leading-none tabular-nums text-ink-mute"
              dir="ltr"
            >
              v{APP_VERSION}
            </span>
          </div>
          <div className="text-[11px] text-ink-mute leading-tight">Next</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2 scrollbar-none">
        {groups.map((group) => (
          <div key={group.title} className="mb-4">
            <div className="px-2.5 mb-1 text-[10.5px] font-semibold tracking-wider text-ink-mute uppercase">
              {group.title}
            </div>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = route === item.id;
                const Icon = item.icon;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setRoute(item.id)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "w-full flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13.5px] transition-colors cursor-pointer",
                        active
                          ? "bg-accent-soft text-accent font-medium"
                          : "text-ink-dim hover:bg-surface-3 hover:text-ink",
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                      {item.badge && item.badge > 0 ? (
                        <span className="ms-auto text-[11px] tabular-nums text-ink-mute">
                          {item.badge > 999
                            ? t("nav.badgeOverflow", {
                                count: formatNumber(999),
                              })
                            : formatNumber(item.badge)}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        <div className="mb-4" data-testid="sidebar-lists">
          <div className="px-2.5 mb-1 flex items-center gap-1 text-[10.5px] font-semibold tracking-wider text-ink-mute uppercase">
            <span className="truncate">{t("nav.section.lists")}</span>
            <button
              type="button"
              disabled={!canEditLists || createList.isPending}
              className="ms-auto rounded-md p-0.5 text-ink-mute hover:bg-surface-3 hover:text-ink cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label={t("lists.new")}
              onClick={() => setCreatingList(true)}
            >
              <Plus className="size-3.5" />
            </button>
          </div>
          {lists.data?.length ? (
            <ul className="space-y-0.5">
              {lists.data.map((list) => {
                const active = route === "groups" && selectedListId === list.id;
                return (
                  <li key={list.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedListId(list.id);
                        setRoute("groups");
                      }}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "w-full flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13.5px] transition-colors cursor-pointer",
                        active
                          ? "bg-accent-soft text-accent font-medium"
                          : "text-ink-dim hover:bg-surface-3 hover:text-ink",
                      )}
                    >
                      <span
                        className="size-2.5 rounded-full shrink-0"
                        style={{ background: list.color }}
                      />
                      <List className="size-4 shrink-0" />
                      <span className="truncate" dir="auto">
                        {list.name}
                      </span>
                      <span className="ms-auto text-[11px] tabular-nums text-ink-mute">
                        {formatNumber(list.memberCount)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <button
              type="button"
              disabled={!canEditLists}
              onClick={() => setCreatingList(true)}
              className="w-full text-start rounded-[10px] px-2.5 py-2 text-[12px] text-ink-mute hover:bg-surface-3 hover:text-ink cursor-pointer disabled:cursor-not-allowed"
            >
              {t("lists.emptySidebar")}
            </button>
          )}
        </div>
      </nav>

      {/* The active account. Not a "data source" badge: 0.1.0 showed "Sample"
          here whenever the mock provider was serving, which is exactly the
          impression 0.2.0 must never give. There is no mock provider now, so
          this says who is actually signed in, or that nobody is. */}
      <div className="p-3 border-t border-edge">
        <button
          type="button"
          onClick={() => setRoute("settings")}
          className="w-full text-start rounded-[10px] bg-surface-2 border border-edge px-2.5 py-2 hover:border-edge-strong transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2.5">
            {snapshot?.account?.avatarUrl ? (
              <img
                src={snapshot.account.avatarUrl}
                alt=""
                width={28}
                height={28}
                className="size-7 rounded-full border border-edge object-cover shrink-0"
              />
            ) : (
              <div className="size-7 rounded-full border border-edge bg-surface-3 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              {snapshot?.account ? (
                <>
                  <div className="text-[12.5px] text-ink truncate leading-tight">
                    {snapshot.account.displayName}
                  </div>
                  {/* A handle is an identifier: LTR even in an RTL layout. */}
                  <div
                    className="text-[11.5px] text-ink-mute truncate leading-tight"
                    dir="ltr"
                  >
                    @{snapshot.account.username}
                  </div>
                </>
              ) : (
                // "No session is stored" is only true when nothing is stored.
                // With credentials present but the identity not yet resolved,
                // saying that contradicts the posts already on screen.
                <div className="text-[11.5px] text-ink-dim leading-tight">
                  {snapshot?.hasCredentials
                    ? t("session.checking")
                    : t("connect.notConnected")}
                </div>
              )}
            </div>
            {snapshot ? <SessionDot snapshot={snapshot} /> : null}
          </div>
        </button>
      </div>

      <Dialog open={creatingList} onOpenChange={setCreatingList}>
        <DialogContent title={t("lists.createTitle")}>
          <Input
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            placeholder={t("groups.namePlaceholder")}
            aria-label={t("groups.name")}
            dir="auto"
          />
          <div className="flex items-center gap-2 mt-3">
            <span className="text-[12.5px] text-ink-mute">
              {t("groups.colour")}
            </span>
            {listColors.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setNewListColor(color)}
                aria-label={t("groups.colourOption", { colour: color })}
                aria-pressed={newListColor === color}
                className={cn(
                  "size-6 rounded-full cursor-pointer border-2",
                  newListColor === color
                    ? "border-ink"
                    : "border-transparent",
                )}
                style={{ background: color }}
              />
            ))}
          </div>
          <div className="flex justify-end gap-2 mt-5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCreatingList(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!newListName.trim() || createList.isPending}
              onClick={() => createList.mutate()}
            >
              {createList.isPending ? t("groups.saving") : t("lists.create")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
