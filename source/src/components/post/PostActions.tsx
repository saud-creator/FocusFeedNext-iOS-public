import { useState } from "react";
import {
  Check,
  Copy,
  EyeOff,
  FolderPlus,
  Link,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, Tip } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { toAppError, type Author } from "@/lib/api";
import { CreatorSubscription } from '@/components/account/CreatorSubscription';
import { FollowButton } from '@/components/account/FollowButton';
import { usePlatform } from '@/lib/platform';

/**
 * Local reader actions. The one deliberate X write is removing a bookmark;
 * it is hidden behind an explicit confirmation dialog and only rendered in
 * the Bookmarks feed.
 *
 * There is no Save either. The local library it saved into is gone: it was a
 * second, private copy of Bookmarks that only this machine could see, and X's
 * own bookmarks are the list the reader already keeps.
 *
 * Copy post link places the legal permalink on the clipboard and never opens a
 * browser or otherwise leaves the app.
 */
export function PostActions({
  read,
  onToggleRead,
  onHide,
  onCopyText,
  onAddToGroup,
  postUrl,
  onCopyLink,
  isBookmark = false,
  onRemoveBookmark,
  author,
}: {
  read: boolean;
  onToggleRead: () => void;
  onHide: () => void;
  onCopyText: () => void;
  onAddToGroup?: () => void;
  postUrl?: string | null;
  onCopyLink?: () => void;
  isBookmark?: boolean;
  onRemoveBookmark?: () => Promise<void>;
  author?: Author;
}) {
  const { t } = useI18n();
  const { isIphone } = usePlatform();
  const [accountOpen,setAccountOpen] = useState(false);
  const [copied, setCopied] = useState<"text" | "link" | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const copy = () => {
    onCopyText();
    setCopied("text");
    window.setTimeout(() => setCopied(null), 1400);
  };

  const copyLink = () => {
    if (!postUrl) return;
    if (onCopyLink) onCopyLink();
    else void navigator.clipboard?.writeText(postUrl);
    setCopied("link");
    window.setTimeout(() => setCopied(null), 1400);
  };

  const confirmRemove = async () => {
    if (!onRemoveBookmark || removing) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await onRemoveBookmark();
      setRemoveOpen(false);
    } catch (error) {
      const detail = toAppError(error);
      setRemoveError(
        detail.repair
          ? `${detail.message} ${detail.repair}`
          : detail.message,
      );
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div data-testid="post-actions" className="flex items-center gap-1 mt-2.5">
      <Tip label={read ? t("post.markUnread") : t("post.markRead")}>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleRead}
          aria-label={read ? t("post.markUnread") : t("post.markRead")}
          className={cn(read && "text-ok")}
        >
          <Check />
        </Button>
      </Tip>

      <Tip label={t("post.copyText")}>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={copy}
          aria-label={t("post.copyText")}
          className={cn(copied === "text" && "text-ok")}
        >
          <Copy />
        </Button>
      </Tip>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("post.moreActions")}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={4}
            className="z-50 min-w-[190px] rounded-xl border border-edge bg-surface-2 p-1 shadow-2xl"
          >
            {isIphone && author && <Item onSelect={() => setAccountOpen(true)} icon={<FolderPlus className="size-3.5" />}>{t('account.controls')}</Item>}
            {onAddToGroup ? (
              <Item
                onSelect={onAddToGroup}
                icon={<FolderPlus className="size-3.5" />}
              >
                {t("post.addAuthorToGroup")}
              </Item>
            ) : null}
            {postUrl ? (
              <Item onSelect={copyLink} icon={<Link className="size-3.5" />}>
                {t("post.copyLink")}
              </Item>
            ) : null}
            <Item onSelect={onHide} icon={<EyeOff className="size-3.5" />}>
              {t("post.hide")}
            </Item>
            {isBookmark && onRemoveBookmark ? (
              <Item
                onSelect={() => {
                  setRemoveError(null);
                  setRemoveOpen(true);
                }}
                icon={<Trash2 className="size-3.5" />}
                className="text-bad data-[highlighted]:text-bad"
              >
                {t("post.removeBookmark")}
              </Item>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {copied ? (
        <span className="text-[11.5px] text-ok ml-1">
          {copied === "link" ? t("post.linkCopied") : t("post.textCopied")}
        </span>
      ) : null}

      {isIphone && author && <Dialog open={accountOpen} onOpenChange={setAccountOpen}>
        <DialogContent title={t('account.controls')}>
          <p className="mb-4 text-sm" dir="auto">{author.displayName} · @{author.username}</p>
          {accountOpen && <FollowButton account={author} />}
          <div className="mt-4"><CreatorSubscription username={author.username} /></div>
        </DialogContent>
      </Dialog>}
      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent title={t("post.removeBookmark.confirm.title")}>
          <p className="text-[13px] text-ink-mute" dir="auto">
            {t("post.removeBookmark.confirm.body")}
          </p>
          {removeError ? (
            <div role="alert" className="mt-3 space-y-1 text-[12.5px] text-bad">
              <p>{t("post.removeBookmark.failed")}</p>
              <p dir="auto">{removeError}</p>
            </div>
          ) : null}
          <div className="flex justify-end gap-2 mt-5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRemoveOpen(false)}
              disabled={removing}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => void confirmRemove()}
              disabled={removing}
            >
              <Trash2 />
              {removing
                ? t("post.removeBookmark.removing")
                : t("post.removeBookmark.confirm.action")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Item({
  children,
  icon,
  onSelect,
  className,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  onSelect: () => void;
  className?: string;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-dim outline-none cursor-pointer data-[highlighted]:bg-surface-3 data-[highlighted]:text-ink",
        className,
      )}
    >
      {icon}
      {children}
    </DropdownMenu.Item>
  );
}
