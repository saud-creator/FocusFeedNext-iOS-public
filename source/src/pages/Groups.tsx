import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookMarked,
  Check,
  Pencil,
  Plus,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import {
  api,
  defaultFilters,
  type AccountFailure,
  type Author,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  EmptyState,
  Input,
} from "@/components/ui/primitives";
import { PageHeader } from "@/components/layout/PageHeader";
import { Avatar } from "@/components/post/AuthorHeader";
import { FeedList } from "@/components/feed/FeedList";
import { usePostActions, useReadIds } from "@/hooks/useFeed";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/useAppStore";

const COLORS = [
  "#6366f1",
  "#10b981",
  "#f59e0b",
  "#ec4899",
  "#0ea5e9",
  "#ef4444",
];

/**
 * What the page is doing right now.
 *
 * The previous version had no such thing, and the absence was the bug: an
 * effect re-selected the first group whenever `selected` became null, so
 * closing the member editor immediately reopened it on group one. There was no
 * state that meant "not editing", so the editor could not be left.
 *
 * `reading` and `editing` are now distinct, and nothing derives one from the
 * other.
 */
type Mode =
  | { kind: "reading" }
  | { kind: "editing"; groupId: string }
  | { kind: "saving"; groupId: string }
  | { kind: "failed"; groupId: string };

/** Normalize for filtering: fold case and drop a leading @. */
function fold(s: string): string {
  return s.trim().toLowerCase().replace(/^@/, "");
}

export function GroupsPage() {
  const { t, plural } = useI18n();
  const qc = useQueryClient();
  const selectedListId = useAppStore((s) => s.selectedListId);
  const setSelectedListId = useAppStore((s) => s.setSelectedListId);
  const actions = usePostActions();
  const readState = useQuery({ queryKey: ["readIds"], queryFn: api.readIds });
  const readIds = useReadIds(readState.data ?? []);

  const [mode, setMode] = useState<Mode>({ kind: "reading" });
  /** The membership being edited. `null` when no edit is in progress. */
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [filter, setFilter] = useState("");
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(COLORS[0]);
  const [creating, setCreating] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState(COLORS[0]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /** Where the next member slice starts. Reset whenever the group changes. */
  const [offset, setOffset] = useState(0);
  const [exhausted, setExhausted] = useState(false);
  const [failures, setFailures] = useState<AccountFailure[]>([]);

  const groups = useQuery({ queryKey: ["groups"], queryFn: api.groups });

  // The app store is the single source of truth for list selection. The page
  // may keep transient editor state, but it must never own a second selected
  // id that can drift from the sidebar.
  const selected = selectedListId;

  // The sidebar owns selection. When the route is opened directly, choose the
  // first list once; when a sidebar item changes, mirror it into this page.
  useEffect(() => {
    if (!groups.data?.length) {
      if (selectedListId !== null) setSelectedListId(null);
      return;
    }
    const target =
      selectedListId && groups.data.some((group) => group.id === selectedListId)
        ? selectedListId
        : groups.data[0].id;
    if (target !== selectedListId) setSelectedListId(target);
  }, [groups.data, selectedListId, setSelectedListId]);

  /**
   * Who may be added to a group.
   *
   * The backend answers from the traversed Following list and marks each row
   * with whether the account is still followed and whether it is already a
   * member. This used to be `api.knownAccounts()` — every author the app had
   * ever seen, which put people the reader does not follow into the picker and
   * labelled them "known accounts", a phrase that told the reader nothing true.
   */
  const candidates = useQuery({
    queryKey: ["groupCandidates", selected],
    queryFn: () => api.groupCandidates(selected!),
    enabled: Boolean(selected),
    staleTime: 5 * 60 * 1000,
  });

  const members = useQuery({
    queryKey: ["groupMembers", selected],
    queryFn: () => api.groupMembers(selected!),
    enabled: Boolean(selected),
  });

  /**
   * The combined timeline, as already held for this session.
   *
   * Shown immediately and never blanked; `loadMore` fills in behind it. This
   * replaced `postsByAuthors`, which read whatever happened to be cached and so
   * produced roughly one post per account — a group of twenty accounts looked
   * like a list of twenty single posts rather than a timeline.
   */
  const posts = useQuery({
    queryKey: ["groupFeed", selected],
    queryFn: () => api.groupFeed(selected!, defaultFilters, 200),
    enabled: Boolean(selected),
  });

  const savedMembers = useMemo(
    () => new Set(members.data ?? []),
    [members.data],
  );
  const shown = draft ?? savedMembers;

  /**
   * The picker rows.
   *
   * The backend returns followed accounts plus any existing member who is no
   * longer followed, flagged rather than dropped: X's follow graph changing is
   * not a reason for the app to edit somebody's own group behind their back.
   */
  const rows: { author: Author; followed: boolean }[] = useMemo(() => {
    const all = (candidates.data ?? []).map((c) => ({
      author: c.author,
      followed: c.following,
    }));
    const q = fold(filter);
    if (!q) return all;
    return all.filter(
      ({ author }) =>
        fold(author.displayName).includes(q) ||
        fold(author.username).includes(q),
    );
  }, [candidates.data, filter]);

  /** How many of the group's members have been fetched for so far. */
  const followedCount = rows.filter((r) => r.followed).length;

  const dirty =
    draft !== null &&
    (draft.size !== savedMembers.size ||
      [...draft].some((id) => !savedMembers.has(id)));

  /**
   * Fetch the next slice of members and merge their recent posts.
   *
   * `nextOffset` walks the member list, so a group of twenty accounts renders
   * after the first few rather than after all twenty. `null` means every member
   * has been read. Failures are reported per account and never empty the page —
   * one unreadable account must not cost the other nineteen.
   */
  const loadMore = useMutation({
    mutationFn: () => api.refreshGroupFeed(selected!, offset, defaultFilters),
    onSuccess: (res) => {
      setOffset(res.nextOffset ?? res.memberCount);
      setExhausted(res.nextOffset === null || res.nextOffset === undefined);
      setFailures(res.failures);
      void qc.invalidateQueries({ queryKey: ["groupFeed", selected] });
    },
  });

  const refreshGroups = () => {
    void qc.invalidateQueries({ queryKey: ["groups"] });
    void qc.invalidateQueries({ queryKey: ["accountLists"] });
    void qc.invalidateQueries({ queryKey: ["groupMembers"] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const create = useMutation({
    mutationFn: async () => {
      const id = `g_${Date.now().toString(36)}`;
      await api.createGroup(id, newName.trim(), newColor);
      return id;
    },
    onSuccess: (id) => {
      setNewName("");
      setNewColor(COLORS[0]);
      setCreating(false);
      // Land on the new group in reading mode. The old flow left the member
      // picker open on whatever had been selected before, which read as the
      // editor being stuck.
      setSelectedListId(id);
      setMode({ kind: "reading" });
      setDraft(null);
      refreshGroups();
    },
  });

  const update = useMutation({
    mutationFn: () =>
      api.updateGroup(editingGroupId!, editName.trim(), editColor),
    onSuccess: () => {
      setEditingGroupId(null);
      refreshGroups();
    },
  });

  const beginEdit = (groupId: string) => {
    setSelectedListId(groupId);
    setDraft(new Set(savedMembers));
    setFilter("");
    setMode({ kind: "editing", groupId });
  };

  const cancelEdit = () => {
    setDraft(null);
    setFilter("");
    setMode({ kind: "reading" });
  };

  const saveMembers = async () => {
    if (!selected || !draft) return;
    if (mode.kind === "saving") return; // no double submit
    setMode({ kind: "saving", groupId: selected });
    try {
      const added = [...draft].filter((id) => !savedMembers.has(id));
      const removed = [...savedMembers].filter((id) => !draft.has(id));
      await Promise.all([
        ...added.map((id) => api.setGroupMember(selected, id, true)),
        ...removed.map((id) => api.setGroupMember(selected, id, false)),
      ]);
      // Success leaves edit mode. That is the whole point of this rewrite.
      setDraft(null);
      setFilter("");
      setMode({ kind: "reading" });
      refreshGroups();
    } catch {
      // The draft survives so the work is not lost, and the state is not
      // "saving" forever.
      setMode({ kind: "failed", groupId: selected });
    }
  };

  const removeGroup = async (id: string) => {
    await api.deleteGroup(id);
    setConfirmDelete(null);
    if (selected === id) {
      setSelectedListId(null);
      setDraft(null);
      setMode({ kind: "reading" });
    }
    refreshGroups();
  };

  const editing = mode.kind !== "reading";
  const saving = mode.kind === "saving";

  return (
    <>
      <PageHeader
        title={t("groups.title")}
        subtitle={t("groups.subtitle")}
        actions={
          <Dialog open={creating} onOpenChange={setCreating}>
            <DialogTrigger asChild>
              <Button variant="primary" size="sm">
                <Plus />
                {t("groups.new")}
              </Button>
            </DialogTrigger>
            <DialogContent title={t("groups.createTitle")}>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t("groups.namePlaceholder")}
                aria-label={t("groups.name")}
                dir="auto"
              />
              <div className="flex items-center gap-2 mt-3">
                <span className="text-[12.5px] text-ink-mute">
                  {t("groups.colour")}
                </span>
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewColor(c)}
                    aria-label={t("groups.colourOption", { colour: c })}
                    aria-pressed={newColor === c}
                    className={cn(
                      "size-6 rounded-full cursor-pointer border-2",
                      newColor === c ? "border-ink" : "border-transparent",
                    )}
                    style={{ background: c }}
                  />
                ))}
              </div>
              <div className="flex justify-end gap-2 mt-5">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCreating(false)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!newName.trim() || create.isPending}
                  onClick={() => create.mutate()}
                >
                  {create.isPending ? t("groups.saving") : t("groups.create")}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="px-3 sm:px-6 py-4 sm:py-5 max-w-[900px] mx-auto w-full">
        {groups.data && groups.data.length > 0 ? (
          <div className="flex flex-wrap gap-2 mb-5">
            {groups.data.map((g) => (
              <div
                key={g.id}
                className={cn(
                  "flex items-center gap-1 rounded-full border pl-3 pr-1.5 py-1 transition-colors",
                  selected === g.id
                    ? "bg-accent-soft border-accent/40"
                    : "bg-surface-2 border-edge hover:border-edge-strong",
                )}
              >
                <button
                  type="button"
                  onClick={() => {
                    // Selecting a different group while editing would silently
                    // discard the draft, so editing is left first.
                    if (editing) cancelEdit();
                    setSelectedListId(g.id);
                    // A different group is a different member list, so the
                    // traversal starts again rather than resuming somebody
                    // else's offset.
                    setOffset(0);
                    setExhausted(false);
                    setFailures([]);
                  }}
                  aria-pressed={selected === g.id}
                  // The bare count reads as a stray number aloud, so the
                  // accessible name spells it out and the visible chip keeps
                  // the compact form.
                  aria-label={`${g.name} · ${plural("groups.members", g.memberCount)}`}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <span
                    className="size-2.5 rounded-full"
                    style={{ background: g.color }}
                  />
                  <span className="text-[13px] text-ink" dir="auto">
                    {g.name}
                  </span>
                  <span className="text-[11.5px] text-ink-mute tabular-nums">
                    {g.memberCount}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingGroupId(g.id);
                    setEditName(g.name);
                    setEditColor(g.color);
                  }}
                  aria-label={t("groups.rename", { name: g.name })}
                  className="text-ink-mute hover:text-ink p-1 cursor-pointer"
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(g.id)}
                  aria-label={t("groups.delete", { name: g.name })}
                  className="text-ink-mute hover:text-bad p-1 cursor-pointer"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<BookMarked className="size-8" />}
            title={t("groups.empty.title")}
            hint={t("groups.empty.hint")}
          />
        )}

        {selected ? (
          <>
            <div className="surface-card p-4 mb-5">
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <UserPlus className="size-4 text-accent" />
                <h2 className="text-[14px] font-semibold text-ink">
                  {t("groups.members")}
                </h2>
                <span className="text-[12px] text-ink-mute">
                  {t("groups.membersOf", {
                    count: shown.size,
                    total: followedCount,
                  })}
                </span>
                <div className="ms-auto flex items-center gap-2">
                  {editing ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={cancelEdit}
                        disabled={saving}
                      >
                        <X />
                        {dirty ? t("groups.discard") : t("common.cancel")}
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={saveMembers}
                        disabled={saving || !dirty}
                      >
                        <Check />
                        {saving ? t("groups.saving") : t("groups.saveMembers")}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => beginEdit(selected)}
                    >
                      <Pencil />
                      {t("groups.editMembers")}
                    </Button>
                  )}
                </div>
              </div>

              {mode.kind === "failed" ? (
                <p
                  role="alert"
                  className="flex items-center gap-2 text-[12.5px] text-bad mb-3"
                >
                  <AlertTriangle className="size-4 shrink-0" />
                  {t("groups.saveFailed")}
                </p>
              ) : null}

              {editing ? (
                <>
                  <p className="text-[12px] text-ink-mute mb-2">
                    {t("groups.candidatesHint")}
                  </p>
                  <Input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={t("groups.filterMembers")}
                    aria-label={t("groups.filterMembers")}
                    className="mb-3"
                    dir="auto"
                  />
                </>
              ) : null}

              {candidates.isLoading ? (
                <p className="text-[12.5px] text-ink-mute">
                  {t("groups.candidatesLoading")}
                </p>
              ) : candidates.isError ? (
                <p role="alert" className="text-[12.5px] text-bad">
                  {t("groups.candidatesFailed")}
                </p>
              ) : rows.length === 0 ? (
                <EmptyState
                  title={t("groups.noCandidates.title")}
                  hint={t("groups.noCandidates.hint")}
                />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 max-h-64 overflow-y-auto">
                  {rows.map(({ author, followed }) => {
                    const inGroup = shown.has(author.id);
                    // Outside edit mode the list is a read-only summary, so
                    // only the members are shown and nothing is clickable.
                    if (!editing && !inGroup) return null;
                    const label = followed
                      ? `${author.displayName} @${author.username}`
                      : `${author.displayName} — ${t("groups.notFollowed")}`;
                    const row = (
                      <>
                        <Avatar author={author} size={26} />
                        <div className="min-w-0">
                          <div
                            className="text-[12.5px] text-ink truncate"
                            dir="auto"
                          >
                            {author.displayName}
                          </div>
                          <div className="text-[11px] text-ink-mute truncate">
                            {followed ? (
                              `@${author.username}`
                            ) : (
                              <span title={t("groups.notFollowedHint")}>
                                {t("groups.notFollowed")}
                              </span>
                            )}
                          </div>
                        </div>
                      </>
                    );
                    return editing ? (
                      <button
                        key={author.id}
                        type="button"
                        role="checkbox"
                        aria-checked={inGroup}
                        aria-label={label}
                        disabled={saving}
                        onClick={() =>
                          setDraft((prev) => {
                            const next = new Set(prev ?? savedMembers);
                            if (next.has(author.id)) next.delete(author.id);
                            else next.add(author.id);
                            return next;
                          })
                        }
                        className={cn(
                          "flex items-center gap-2 rounded-lg px-2 py-1.5 text-left cursor-pointer transition-colors border disabled:cursor-default",
                          inGroup
                            ? "bg-accent-soft border-accent/30"
                            : "border-transparent hover:bg-surface-3",
                          !followed && "opacity-80",
                        )}
                      >
                        {row}
                      </button>
                    ) : (
                      <div
                        key={author.id}
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 border border-transparent"
                      >
                        {row}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 mb-3 flex-wrap">
              <h2 className="text-[14px] font-semibold text-ink">
                {t("groups.postsInGroup")}
              </h2>
              {savedMembers.size > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => loadMore.mutate()}
                  disabled={loadMore.isPending || exhausted}
                >
                  {loadMore.isPending
                    ? t("groups.loadingPosts")
                    : exhausted
                      ? t("groups.allMembersLoaded")
                      : t("groups.loadMorePosts")}
                </Button>
              ) : null}
              {offset > 0 ? (
                <span className="text-[12px] text-ink-mute">
                  {t("groups.membersLoaded", {
                    count: offset,
                    total: savedMembers.size,
                  })}
                </span>
              ) : null}
            </div>

            {failures.length > 0 ? (
              // Named, not counted: "3 accounts failed" is not something the
              // reader can act on, and the successful accounts are still shown.
              <p role="status" className="text-[12.5px] text-warn mb-3">
                {t("groups.someMembersFailed", {
                  names: failures.map((f) => `@${f.username}`).join(", "),
                })}
              </p>
            ) : null}

            <FeedList
              posts={posts.data?.posts ?? []}
              readIds={readIds}
              loading={posts.isLoading}
              onMarkRead={actions.markRead}
              onHide={actions.hide}
              emptyTitle={t("groups.posts.empty.title")}
              emptyHint={t("groups.posts.empty.hint")}
            />
          </>
        ) : groups.data && groups.data.length > 0 ? (
          <EmptyState
            title={t("groups.selectPrompt.title")}
            hint={t("groups.selectPrompt.hint")}
          />
        ) : null}
      </div>

      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <DialogContent title={t("groups.deleteTitle")}>
          <p className="text-[13px] text-ink-mute" dir="auto">
            {t("groups.deleteBody", {
              name:
                groups.data?.find((g) => g.id === confirmDelete)?.name ?? "",
            })}
          </p>
          <div className="flex justify-end gap-2 mt-5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDelete(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => confirmDelete && removeGroup(confirmDelete)}
            >
              {t("common.delete")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editingGroupId !== null}
        onOpenChange={(open) => !open && setEditingGroupId(null)}
      >
        <DialogContent title={t("groups.renameTitle")}>
          <Input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            aria-label={t("groups.name")}
            dir="auto"
          />
          <div className="flex items-center gap-2 mt-3">
            <span className="text-[12.5px] text-ink-mute">
              {t("groups.colour")}
            </span>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setEditColor(c)}
                aria-label={t("groups.colourOption", { colour: c })}
                aria-pressed={editColor === c}
                className={cn(
                  "size-6 rounded-full cursor-pointer border-2",
                  editColor === c ? "border-ink" : "border-transparent",
                )}
                style={{ background: c }}
              />
            ))}
          </div>
          <div className="flex justify-end gap-2 mt-5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditingGroupId(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!editName.trim() || update.isPending}
              onClick={() => update.mutate()}
            >
              {update.isPending ? t("groups.saving") : t("common.save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
