import { cloneElement, isValidElement, useId, useState, type ReactNode, type ReactElement } from "react";
import { Check } from "lucide-react";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ErrorState } from "@/components/state";
import {
  OVERRIDABLE_ROUTES,
  defaultPreferences,
  useAppStore,
  type Preferences,
} from "@/stores/useAppStore";

/**
 * One Settings section, and the whole of the edit workflow around it.
 *
 * Every section carries its own Save, Cancel and Reset to defaults, and its
 * own saved confirmation, because a settings page where the controls live only
 * at the bottom is a settings page where nobody scrolls far enough to find
 * them.
 *
 * What the three buttons actually do is stated rather than implied, because
 * the draft is one object shared by the whole page:
 *
 * - **Save** commits every pending change on the page, not only this section's.
 *   When other sections are also dirty, the footer says how many.
 * - **Cancel** discards every pending change, for the same reason.
 * - **Reset to defaults** touches *only* this section's keys. That one is
 *   genuinely local, and is the button a reader reaches for when they have
 *   made a mess of one thing.
 *
 * Nothing here writes to the backend until Save. Editing repaints the window,
 * because appearance previews the draft, but it persists nothing.
 */

/** A section is defined by the preference keys it owns. */
export type SectionKey = keyof Preferences;

function sameValue(a: Preferences, b: Preferences, key: SectionKey): boolean {
  if (key === 'mobileTabs') return JSON.stringify(a[key]) === JSON.stringify(b[key]);
  if (key !== "pageOpenOverrides") return a[key] === b[key];
  return OVERRIDABLE_ROUTES.every(
    (route) => a.pageOpenOverrides[route] === b.pageOpenOverrides[route],
  );
}

export function SettingsSection({
  title,
  icon,
  description,
  keys,
  children,
}: {
  title: string;
  icon?: ReactNode;
  description?: string;
  /** The preference fields this section edits. Drives dirty state and Reset. */
  keys: readonly SectionKey[];
  children: ReactNode;
}) {
  const { t, formatNumber } = useI18n();
  const prefs = useAppStore((s) => s.prefs);
  const draft = useAppStore((s) => s.draft);
  const setDraft = useAppStore((s) => s.setDraft);
  const setOverride = useAppStore((s) => s.setOverride);
  const saveDraft = useAppStore((s) => s.saveDraft);
  const cancelDraft = useAppStore((s) => s.cancelDraft);

  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const current = draft ?? prefs;

  const dirtyKeys = keys.filter((k) => !sameValue(prefs, current, k));
  const sectionDirty = dirtyKeys.length > 0;
  const pageDirty = draft !== null && !samePreferences(prefs, draft);
  const elsewhere = pageDirty && !sectionDirty;

  const atDefaults = keys.every((k) => sameValue(defaultPreferences, current, k));

  const resetSection = () => {
    setSaved(false);
    for (const key of keys) {
      if (key === "pageOpenOverrides") {
        for (const route of OVERRIDABLE_ROUTES) setOverride(route, undefined);
        continue;
      }
      setDraft(key, defaultPreferences[key]);
    }
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setFailure(null);
    try {
      await saveDraft();
      setSaved(true);
      // The confirmation is a statement about a moment, so it stops being
      // true after one. It is not an error to leave it on screen, but it is
      // noise, and this page has enough.
      setTimeout(() => setSaved(false), 4000);
    } catch (e) {
      setFailure(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader title={title} subtitle={description} icon={icon} />
      <CardBody className="divide-y divide-edge">{children}</CardBody>

      <div className="px-4 pb-4 pt-3 border-t border-edge flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={!pageDirty || saving}
        >
          {saving ? t("settings.saving") : t("common.save")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSaved(false);
            cancelDraft();
          }}
          disabled={!pageDirty}
        >
          {t("common.cancel")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={resetSection}
          disabled={atDefaults}
        >
          {t("settings.resetSection")}
        </Button>

        <div className="ms-auto text-[12.5px]" aria-live="polite">
          {saved ? (
            <span className="inline-flex items-center gap-1.5 text-ok">
              <Check className="size-3.5" aria-hidden="true" />
              {t("settings.saved")}
            </span>
          ) : sectionDirty ? (
            <span className="text-warn">{t("settings.unsaved")}</span>
          ) : elsewhere ? (
            // Honest about the shared draft: pressing Save here writes the
            // change somebody made three sections up as well.
            <span className="text-ink-mute">
              {t("settings.unsavedElsewhere", {
                count: formatNumber(countDirty(prefs, draft)),
              })}
            </span>
          ) : null}
        </div>
      </div>

      {failure ? (
        <div className="px-4 pb-4">
          <ErrorState
            title={t("settings.saveFailed")}
            message={t("settings.saveFailed.desc")}
            repair={failure}
            onRetry={() => void save()}
          />
        </div>
      ) : null}
    </Card>
  );
}

/** How many preference fields differ between the saved set and the draft. */
function countDirty(prefs: Preferences, draft: Preferences | null): number {
  if (!draft) return 0;
  const keys = Object.keys(defaultPreferences) as SectionKey[];
  return keys.filter((k) => !sameValue(prefs, draft, k)).length;
}

function samePreferences(a: Preferences, b: Preferences): boolean {
  return (Object.keys(defaultPreferences) as SectionKey[]).every((k) =>
    sameValue(a, b, k),
  );
}

/**
 * A labelled row with the control on the trailing edge.
 *
 * The label is a `<label>` only when the caller says the control can own one —
 * a `<select>` can, a group of radio buttons cannot without lying to a screen
 * reader about which one it names.
 */
export function SettingRow({
  label,
  description,
  control,
  htmlFor,
}: {
  label: string;
  description?: string;
  control: ReactNode;
  htmlFor?: string;
}) {
  const Label = htmlFor ? "label" : "div";
  const labelId = useId();
  const accessibleControl = isValidElement(control)
    ? cloneElement(control as ReactElement<Record<string,unknown>>, { 'aria-labelledby':labelId })
    : control;
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <Label
          id={labelId}
          {...(htmlFor ? { htmlFor } : {})}
          className="text-sm text-ink block"
        >
          {label}
        </Label>
        {description ? (
          <div className="text-[12.5px] text-ink-mute mt-0.5">{description}</div>
        ) : null}
      </div>
      <div className="shrink-0">{accessibleControl}</div>
    </div>
  );
}
