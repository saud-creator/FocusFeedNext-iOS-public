import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Eye,
  Info,
  Play,
  Plug,
  Languages,
  RefreshCw,
  Rocket,
  ShieldCheck,
  UserMinus,
  VolumeX,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { APP_VERSION, BUILD_NUMBER, SOURCE_COMMIT } from "@/lib/appVersion";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Select, Switch, ToggleRow } from "@/components/ui/primitives";
import { PageHeader } from "@/components/layout/PageHeader";
import { XConnection } from "@/components/settings/XConnection";
import { IosConnection } from "@/components/settings/IosConnection";
import {
  WindowsIphoneCompanion,
} from "@/components/settings/IphoneCompanion";
import {
  SettingRow,
  SettingsSection,
} from "@/components/settings/SettingsSection";
import { AppearanceSection } from "@/components/settings/AppearanceSection";
import { PerformanceSection } from '@/components/settings/PerformanceSection';
import {
  MAX_MONITOR_MINUTES,
  MIN_MONITOR_MINUTES,
  OVERRIDABLE_ROUTES,
  useAppStore,
  type OverridableRoute,
  type PageOpenBehavior,
} from "@/stores/useAppStore";
import { useI18n } from "@/i18n";
import type { LanguagePref } from "@/i18n";
import { usePlatform } from "@/lib/platform";

const BEHAVIORS: PageOpenBehavior[] = ["off", "refresh", "reset"];
const INTERVALS = [1, 5, 10, 15, 30, 60].filter(
  (m) => m >= MIN_MONITOR_MINUTES && m <= MAX_MONITOR_MINUTES,
);

/** The navigation label each overridable route already has. */
const ROUTE_LABEL: Record<OverridableRoute, string> = {
  following: "nav.followingFeed",
  bookmarks: "nav.bookmarks",
  accounts: "nav.peopleYouFollow",
  groups: "nav.groups",
  profile: "nav.profile",
};

/**
 * Settings.
 *
 * Every section edits the shared draft in `useAppStore` and writes nothing
 * until its own Save. The page used to persist each control the instant it was
 * touched, which meant a half-considered toggle reached the backend — and, for
 * the connection settings, reached X.
 */
export function SettingsPage() {
  const { t, plural, formatNumber } = useI18n();
  const { isIphone } = usePlatform();
  const qc = useQueryClient();
  const prefs = useAppStore((s) => s.prefs);
  const draft = useAppStore((s) => s.draft);
  const setDraft = useAppStore((s) => s.setDraft);
  const setOverride = useAppStore((s) => s.setOverride);
  const setPref = useAppStore((s) => s.setPref);
  const [newWord, setNewWord] = useState("");

  const current = draft ?? prefs;

  const muted = useQuery({ queryKey: ["mutedWords"], queryFn: api.mutedWords });
  // Read from the backend rather than from local preference state: this one
  // governs what the app may do to the account, so the interface should show
  // what the backend will actually enforce, not what React last set.
  const allowUnfollow = useQuery({
    queryKey: ["unfollowAllowed"],
    queryFn: api.unfollowAllowed,
  });

  const setAllowUnfollow = async (on: boolean) => {
    await api.setSetting("actions.allowUnfollow", on ? "true" : "false");
    void qc.invalidateQueries({ queryKey: ["unfollowAllowed"] });
  };

  const addWord = async () => {
    const w = newWord.trim();
    if (!w) return;
    await api.setMutedWord(w, true);
    setNewWord("");
    void qc.invalidateQueries({ queryKey: ["mutedWords"] });
  };

  const removeWord = async (w: string) => {
    await api.setMutedWord(w, false);
    void qc.invalidateQueries({ queryKey: ["mutedWords"] });
  };

  return (
    <>
      <PageHeader
        title={t("settings.title")}
        subtitle={t("settings.subtitle")}
      />

      <div className="px-3 sm:px-6 py-4 sm:py-5 max-w-[760px] mx-auto w-full space-y-4">
        {/* First card on the page: nothing else works until this one does. */}
        {isIphone ? <IosConnection /> : <XConnection />}
        {isIphone ? null : <WindowsIphoneCompanion />}
        <nav aria-label={t('performance.quickSettings')} className="sticky top-0 z-10 flex gap-2 overflow-x-auto rounded-2xl border border-edge bg-surface-1 p-2 shadow-sm">
          {['appearance','reading','media','performance','connection'].map(section => <Button key={section} variant="ghost" size="sm" onClick={() => document.getElementById(`settings-${section}`)?.scrollIntoView({ block:'start' })}>{t(`performance.section.${section}`)}</Button>)}
        </nav>
        <div id="settings-performance" className="scroll-mt-16"><PerformanceSection /></div>
        <div id="settings-connection" className="scroll-mt-16" />

        <SettingsSection
          title={t("settings.monitoring.title")}
          icon={<Plug className="size-4" />}
          keys={["autoCheckConnection", "monitorIntervalMinutes"]}
        >
          <SettingRow
            label={t("settings.monitoring.autoCheck")}
            description={t("settings.monitoring.autoCheck.desc")}
            control={
              <Switch
                checked={current.autoCheckConnection}
                onCheckedChange={(v) => setDraft("autoCheckConnection", v)}
                aria-label={t("settings.monitoring.autoCheck")}
              />
            }
          />
          <SettingRow
            label={t("settings.monitoring.interval")}
            control={
              <Select
                value={String(current.monitorIntervalMinutes)}
                disabled={!current.autoCheckConnection}
                onChange={(e) =>
                  setDraft("monitorIntervalMinutes", Number(e.target.value))
                }
                aria-label={t("settings.monitoring.interval")}
              >
                {INTERVALS.map((m) => (
                  <option key={m} value={m}>
                    {plural("settings.monitoring.minutes", m)}
                  </option>
                ))}
              </Select>
            }
          />
        </SettingsSection>

        <SettingsSection
          title={t("settings.pageOpen.title")}
          description={t("settings.pageOpen.desc")}
          icon={<RefreshCw className="size-4" />}
          keys={["pageOpenBehavior", "pageOpenOverrides"]}
        >
          <SettingRow
            label={t("settings.pageOpen.global")}
            control={
              <Select
                value={current.pageOpenBehavior}
                onChange={(e) =>
                  setDraft(
                    "pageOpenBehavior",
                    e.target.value as PageOpenBehavior,
                  )
                }
                aria-label={t("settings.pageOpen.global")}
              >
                {BEHAVIORS.map((b) => (
                  <option key={b} value={b}>
                    {t(`settings.pageOpen.${b}`)}
                  </option>
                ))}
              </Select>
            }
          />
          <div className="pt-2 text-[12.5px] text-ink-mute">
            {t("settings.pageOpen.perPage")}
          </div>
          {OVERRIDABLE_ROUTES.map((route) => (
            <SettingRow
              key={route}
              label={t(ROUTE_LABEL[route])}
              control={
                <Select
                  value={current.pageOpenOverrides[route] ?? ""}
                  onChange={(e) =>
                    setOverride(
                      route,
                      e.target.value === ""
                        ? undefined
                        : (e.target.value as PageOpenBehavior),
                    )
                  }
                  aria-label={t(ROUTE_LABEL[route])}
                >
                  <option value="">{t("settings.pageOpen.useDefault")}</option>
                  {BEHAVIORS.map((b) => (
                    <option key={b} value={b}>
                      {t(`settings.pageOpen.${b}`)}
                    </option>
                  ))}
                </Select>
              }
            />
          ))}
        </SettingsSection>

        {!isIphone && <SettingsSection
          title={t("settings.startup.title")}
          description={t("settings.startup.desc")}
          icon={<Rocket className="size-4" />}
          keys={["preloadBookmarks", "preloadFollowing"]}
        >
          <SettingRow
            label={t("settings.startup.preloadBookmarks")}
            description={t("settings.startup.preloadBookmarks.desc")}
            control={
              <Switch
                checked={current.preloadBookmarks}
                onCheckedChange={(v) => setDraft("preloadBookmarks", v)}
                aria-label={t("settings.startup.preloadBookmarks")}
              />
            }
          />
          <SettingRow
            label={t("settings.startup.preloadFollowing")}
            description={t("settings.startup.preloadFollowing.desc")}
            control={
              <Switch
                checked={current.preloadFollowing}
                onCheckedChange={(v) => setDraft("preloadFollowing", v)}
                aria-label={t("settings.startup.preloadFollowing")}
              />
            }
          />
        </SettingsSection>}

        <div id="settings-reading" className="scroll-mt-16" />
        <SettingsSection
          title={t("settings.content.title")}
          icon={<Eye className="size-4" />}
          keys={[
            "hideRepostsDefault",
            "unreadOnlyDefault",
            "readDwellMs",
            "collapseLongPosts",
            "timestampStyle",
          ]}
        >
          <SettingRow
            label={t("settings.content.hideReposts")}
            control={
              <Switch
                checked={current.hideRepostsDefault}
                onCheckedChange={(v) => setDraft("hideRepostsDefault", v)}
                aria-label={t("settings.content.hideReposts")}
              />
            }
          />
          <SettingRow
            label={t("settings.content.unreadOnly")}
            control={
              <Switch
                checked={current.unreadOnlyDefault}
                onCheckedChange={(v) => setDraft("unreadOnlyDefault", v)}
                aria-label={t("settings.content.unreadOnly")}
              />
            }
          />
          <SettingRow
            label={t("settings.markReadAfter")}
            description={t("settings.markReadAfter.desc")}
            control={
              <Select
                value={String(current.readDwellMs)}
                onChange={(e) =>
                  setDraft("readDwellMs", Number(e.target.value))
                }
                aria-label={t("settings.markReadAfter")}
              >
                <option value="0">{t("settings.dwell.manual")}</option>
                <option value="500">{t("settings.dwell.halfSecond")}</option>
                <option value="1000">{t("settings.dwell.oneSecond")}</option>
                <option value="2000">{t("settings.dwell.twoSeconds")}</option>
                <option value="4000">{t("settings.dwell.fourSeconds")}</option>
              </Select>
            }
          />
          <SettingRow
            label={t("settings.collapseLongPosts")}
            description={t("settings.collapseLongPosts.desc")}
            control={
              <Switch
                checked={current.collapseLongPosts}
                onCheckedChange={(v) => setDraft("collapseLongPosts", v)}
                aria-label={t("settings.collapseLongPosts")}
              />
            }
          />
          <SettingRow
            label={t("settings.timestampStyle")}
            control={
              <Select
                value={current.timestampStyle}
                onChange={(e) =>
                  setDraft(
                    "timestampStyle",
                    e.target.value as "relative" | "absolute",
                  )
                }
                aria-label={t("settings.timestampStyle")}
              >
                <option value="relative">
                  {t("settings.timestampStyle.relative")}
                </option>
                <option value="absolute">
                  {t("settings.timestampStyle.absolute")}
                </option>
              </Select>
            }
          />
        </SettingsSection>

        {(
          <Card>
            <CardHeader
              title={t("settings.actions.title")}
              icon={<UserMinus className="size-4" />}
            />
            <CardBody className="divide-y divide-edge">
              {/* Not part of the draft: this one is read back from the backend so
                the interface shows what will actually be enforced, and it
                applies the moment it is switched — a control that changes what
                the app may do to an account should not sit in a pending state. */}
              <ToggleRow
                label={t("settings.actions.unfollow")}
                description={t("settings.actions.unfollow.desc")}
                checked={allowUnfollow.data === true}
                onCheckedChange={(v) => void setAllowUnfollow(v)}
              />
              <ToggleRow
                label={t("settings.actions.advanced")}
                description={t("settings.actions.advanced.desc")}
                checked={prefs.advancedAccountActions}
                onCheckedChange={(v) => setPref("advancedAccountActions", v)}
              />
            </CardBody>
          </Card>
        )}

        <div id="settings-media" className="scroll-mt-16" />
        <SettingsSection
          title={t("settings.video.title")}
          icon={<Play className="size-4" />}
          keys={[
            "videoLoop",
            "videoClickToggle",
            "gifAutoplay",
            "videoOffscreenCleanup",
            "videoQuality",
            "defaultSpeed",
          ]}
        >
          <SettingRow
            label={t("settings.video.loop")}
            description={t("settings.video.loop.desc")}
            control={
              <Switch
                checked={current.videoLoop}
                onCheckedChange={(v) => setDraft("videoLoop", v)}
                aria-label={t("settings.video.loop")}
              />
            }
          />
          <SettingRow
            label={t("settings.video.clickToggle")}
            description={t("settings.video.clickToggle.desc")}
            control={
              <Switch
                checked={current.videoClickToggle}
                onCheckedChange={(v) => setDraft("videoClickToggle", v)}
                aria-label={t("settings.video.clickToggle")}
              />
            }
          />
          <SettingRow
            label={t("settings.video.gifAutoplay")}
            description={t("settings.video.gifAutoplay.desc")}
            control={
              <Switch
                checked={current.gifAutoplay}
                onCheckedChange={(v) => setDraft("gifAutoplay", v)}
                aria-label={t("settings.video.gifAutoplay")}
              />
            }
          />
          <SettingRow
            label={t("settings.video.offscreen")}
            description={t("settings.video.offscreen.desc")}
            control={
              <Switch
                checked={current.videoOffscreenCleanup}
                onCheckedChange={(v) => setDraft("videoOffscreenCleanup", v)}
                aria-label={t("settings.video.offscreen")}
              />
            }
          />
          <SettingRow
            label={t("settings.video.quality")}
            description={t("settings.video.qualityNote")}
            control={
              <Select
                value={current.videoQuality}
                onChange={(e) =>
                  setDraft(
                    "videoQuality",
                    e.target.value as typeof current.videoQuality,
                  )
                }
                aria-label={t("settings.video.quality")}
              >
                <option value="auto">{t('performance.autoQuality')}</option>
                <option value="best">{t("settings.video.quality.best")}</option>
                <option value="1080">1080p</option>
                <option value="720">720p</option>
                <option value="480">480p</option>
                <option value="360">360p</option>
              </Select>
            }
          />
          <SettingRow
            label={t("settings.video.defaultSpeed")}
            control={
              <Select
                value={String(current.defaultSpeed)}
                onChange={(e) =>
                  setDraft("defaultSpeed", Number(e.target.value))
                }
                aria-label={t("settings.video.defaultSpeed")}
              >
                {[0.5, 1, 1.25, 1.5, 2].map((s) => (
                  <option key={s} value={s}>
                    {formatNumber(s)}×
                  </option>
                ))}
              </Select>
            }
          />
        </SettingsSection>

        <div id="settings-appearance" className="scroll-mt-16"><AppearanceSection /></div>

        <Card>
          <CardHeader
            title={t("settings.mutedWords.title")}
            icon={<VolumeX className="size-4" />}
          />
          <CardBody>
            <div className="flex gap-2">
              <Input
                value={newWord}
                onChange={(e) => setNewWord(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addWord()}
                placeholder={t("settings.mutedWords.placeholder")}
                aria-label={t("settings.mutedWords.aria")}
                dir="auto"
              />
              <Button variant="ghost" size="sm" onClick={() => void addWord()}>
                {t("settings.mutedWords.add")}
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {(muted.data ?? []).map((w) => (
                <span
                  key={w}
                  className="inline-flex items-center gap-1 rounded-full bg-surface-3 border border-edge px-2.5 py-1 text-[12.5px] text-ink"
                  dir="auto"
                >
                  {w}
                  <button
                    type="button"
                    onClick={() => void removeWord(w)}
                    aria-label={t("settings.mutedWords.unmute", { word: w })}
                    className="text-ink-mute hover:text-bad cursor-pointer"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {(muted.data ?? []).length === 0 ? (
                <span className="text-[12.5px] text-ink-mute">
                  {t("settings.mutedWords.empty")}
                </span>
              ) : null}
            </div>
          </CardBody>
        </Card>

        <SettingsSection
          title={t("settings.language.title")}
          icon={<Languages className="size-4" />}
          keys={["language"]}
        >
          <SettingRow
            label={t("settings.language.label")}
            description={t("settings.language.note")}
            control={
              <Select
                value={current.language}
                onChange={(e) =>
                  setDraft("language", e.target.value as LanguagePref)
                }
                aria-label={t("settings.language.label")}
              >
                <option value="system">{t("settings.language.system")}</option>
                <option value="en">{t("settings.language.english")}</option>
                <option value="ar">{t("settings.language.arabic")}</option>
              </Select>
            }
          />
        </SettingsSection>

        <Card>
          <CardHeader
            title={t("settings.privacy.title")}
            icon={<ShieldCheck className="size-4" />}
          />
          <CardBody>
            <p className="text-[13px] text-ink-mute">
              {isIphone
                ? t("ios.account.privacy")
                : t("connect.storageWarning")}
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={t("settings.about.title")}
            icon={<Info className="size-4" />}
          />
          <CardBody>
            <p className="text-[13px] text-ink-mute">
              {t("settings.about.p1")}
            </p>
            <div className="mt-3 flex items-center justify-between gap-3 rounded-[10px] border border-edge bg-surface-2 px-3 py-2 text-[13px]">
              <span className="text-ink-dim">
                {t("updates.currentVersion")}
              </span>
              <code className="text-ink tabular-nums" dir="ltr">
                v{APP_VERSION} · {BUILD_NUMBER} · {SOURCE_COMMIT.slice(0, 8)}
              </code>
            </div>
            <p className="text-[11.5px] text-ink-mute mt-3">
              {t("updates.notConfigured.desc")}
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
