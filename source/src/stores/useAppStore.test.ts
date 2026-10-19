import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, isTauri } from "@/lib/api";
import {
  behaviorFor,
  coerceColor,
  defaultPreferences,
  durablePrefKeys,
  durableStorageKeys,
  MAX_MONITOR_MINUTES,
  preferencesFromStored,
  useAppStore,
} from "./useAppStore";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    isTauri: vi.fn(() => true),
    api: {
      ...actual.api,
      setPreferencesBatch: vi.fn(async () => {}),
      runtimePlatform: vi.fn(async () => 'web'),
      settings: vi.fn(),
    },
  };
});

const setSetting = vi.mocked(api.setPreferencesBatch);
const settings = vi.mocked(api.settings);

it('migrates iOS quality atomically once and preserves later manual choices',async()=>{
  vi.mocked(api.runtimePlatform).mockResolvedValue('ios');
  settings.mockResolvedValue([['video.quality','480'],['performance.mode','fast'],['video.autoplay','off']]);
  const before = setSetting.mock.calls.length;
  await useAppStore.getState().hydratePrefs();
  expect(useAppStore.getState().prefs).toMatchObject({videoQuality:'best',performanceMode:'fast',autoplay:'off'});
  expect(setSetting).toHaveBeenLastCalledWith([['video.quality','best'],['migration.iosVideoQuality080','true']],false);
  settings.mockResolvedValue([['migration.iosVideoQuality080','true'],['video.quality','360']]);
  await useAppStore.getState().hydratePrefs();
  expect(useAppStore.getState().prefs.videoQuality).toBe('360');
  expect(setSetting.mock.calls.length).toBe(before+1);
  vi.mocked(api.runtimePlatform).mockResolvedValue('web');
});

describe("preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTauri).mockReturnValue(true);
    useAppStore.setState({ prefs: defaultPreferences });
  });

  it("writes the durable preferences through to the backend", async () => {
    useAppStore.getState().setPref("language", "ar");
    await vi.waitFor(() => expect(setSetting).toHaveBeenCalledWith([["language", "ar"]]));
    await vi.waitFor(() => expect(useAppStore.getState().prefs.language).toBe("ar"));
    expect(useAppStore.getState().prefs.language).toBe("ar");
  });

  it("keeps preferences outside the map out of durable storage", () => {
    // Per-route page-open overrides are a real preference and they do persist,
    // but not through `setPref`: they are written one key per route by
    // `saveDraft`. Sending the field name would reach the backend as an
    // unknown key, be rejected, and be swallowed — the exact silent failure
    // this map exists to prevent.
    useAppStore
      .getState()
      .setPref("pageOpenOverrides", { bookmarks: "refresh" });
    expect(setSetting).not.toHaveBeenCalled();
    // It still takes effect for this run.
    expect(useAppStore.getState().prefs.pageOpenOverrides.bookmarks).toBe(
      "refresh",
    );
  });

  it("persists exactly the keys named in the storage map", () => {
    expect([...durablePrefKeys]).toEqual(Object.keys(durableStorageKeys));
    // Two fields sharing one stored key would make the later write clobber the
    // earlier one, and the loss would only show up after a restart.
    const stored = Object.values(durableStorageKeys);
    expect(new Set(stored).size).toBe(stored.length);
  });

  it("namespaces the stored key where the field name is not the key", () => {
    // Every namespaced key is a chance to send something the Rust allowlist
    // rejects. `ipc_contract.rs` checks the whole map against that allowlist;
    // this checks the shape the map is expected to have.
    expect(durableStorageKeys.videoQuality).toBe("video.quality");
    expect(durableStorageKeys.preloadBookmarks).toBe(
      "startup.preloadBookmarks",
    );
    expect(durableStorageKeys.hideRepostsDefault).toBe("content.hideReposts");
  });

  it("files the monitoring preference under its namespaced key", async () => {
    // The field name and the stored key differ for this one; sending the field
    // name would be rejected by the backend allowlist and silently swallowed.
    useAppStore.getState().setPref("autoCheckConnection", false);
    await vi.waitFor(() => expect(setSetting).toHaveBeenCalledWith([["monitoring.autoCheck", "false"]]));
  });

  it("leaves connection monitoring on unless it was switched off", () => {
    expect(defaultPreferences.autoCheckConnection).toBe(true);
  });

  it("restores connection monitoring from durable storage", async () => {
    settings.mockResolvedValue([["monitoring.autoCheck", "false"]]);
    await useAppStore.getState().hydratePrefs();
    expect(useAppStore.getState().prefs.autoCheckConnection).toBe(false);
  });

  it("restores stored preferences at startup", async () => {
    settings.mockResolvedValue([
      ["language", "ar"],
      ["theme", "light"],
      ["density", "compact"],
    ]);
    await useAppStore.getState().hydratePrefs();
    const prefs = useAppStore.getState().prefs;
    expect(prefs.language).toBe("ar");
    expect(prefs.theme).toBe("light");
    expect(prefs.density).toBe("compact");
  });

  it("ignores stored values it does not recognise", async () => {
    // A hand-edited preferences file must not be able to put the interface
    // into a state no code path can produce.
    settings.mockResolvedValue([
      ["language", "klingon"],
      ["theme", "<script>"],
    ]);
    await useAppStore.getState().hydratePrefs();
    // Both fall back to the shipped defaults rather than to the stored junk.
    expect(useAppStore.getState().prefs.language).toBe("system");
    expect(useAppStore.getState().prefs.theme).toBe("dark");
  });

  it("falls back to defaults when nothing is stored", async () => {
    settings.mockRejectedValue(new Error("no store"));
    await useAppStore.getState().hydratePrefs();
    expect(useAppStore.getState().prefs).toEqual(defaultPreferences);
  });

  it("does nothing outside the desktop shell", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    await useAppStore.getState().hydratePrefs();
    useAppStore.getState().setPref("theme", "light");
    expect(settings).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
  });
});

describe("reading stored preferences", () => {
  it("clamps a number rather than trusting it", () => {
    const prefs = preferencesFromStored({
      "monitoring.intervalMinutes": "99999",
    });
    expect(prefs.monitorIntervalMinutes).toBe(MAX_MONITOR_MINUTES);
  });

  it("drops a colour that is not a colour", () => {
    // This value ends up in a CSS custom property. Anything that is not a hex
    // triple is discarded rather than repaired.
    expect(coerceColor("#0b0b0f")).toBe("#0b0b0f");
    expect(coerceColor("#abc")).toBe("#abc");
    expect(coerceColor("")).toBe("");
    expect(coerceColor("red; background: url(x)")).toBeUndefined();
    expect(coerceColor("javascript:alert(1)")).toBeUndefined();
  });

  it("keeps every other field when one is unreadable", () => {
    const prefs = preferencesFromStored({
      theme: "not-a-theme",
      "video.quality": "720",
      "content.hideReposts": "true",
    });
    expect(prefs.theme).toBe(defaultPreferences.theme);
    expect(prefs.videoQuality).toBe("720");
    expect(prefs.hideRepostsDefault).toBe(true);
  });

  it("reads per-route page-open overrides", () => {
    const prefs = preferencesFromStored({
      "pages.openBehavior": "refresh",
      "pages.openBehavior.bookmarks": "reset",
      "pages.openBehavior.groups": "",
    });
    expect(prefs.pageOpenBehavior).toBe("refresh");
    expect(behaviorFor(prefs, "bookmarks")).toBe("reset");
    // An empty override means "follow the global default", which is how a
    // cleared override is stored — the allowlist has no delete.
    expect(behaviorFor(prefs, "groups")).toBe("refresh");
    expect(behaviorFor(prefs, "diagnostics")).toBe("refresh");
  });

  it("opens pages without touching X unless asked", () => {
    expect(defaultPreferences.pageOpenBehavior).toBe("off");
  });

  it("has no replies preference to turn on", () => {
    // Replies are not a setting: they are never fetched and never rendered.
    // A stored `content.showReplies` from an older build is ignored rather
    // than honoured, because the allowlist no longer names it.
    expect("showReplies" in defaultPreferences).toBe(false);
    expect(preferencesFromStored({ "content.showReplies": "true" })).toEqual(
      defaultPreferences,
    );
  });

  it("keeps advanced account actions off", () => {
    expect(defaultPreferences.advancedAccountActions).toBe(false);
  });
});

describe("the settings draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTauri).mockReturnValue(true);
    useAppStore.setState({ prefs: defaultPreferences, draft: null });
  });

  it("changes nothing until Save", () => {
    const s = useAppStore.getState();
    s.beginEdit();
    s.setDraft("theme", "oled");
    expect(useAppStore.getState().prefs.theme).toBe("dark");
    expect(useAppStore.getState().draft?.theme).toBe("oled");
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("reports a dirty draft, and a clean one", () => {
    const s = useAppStore.getState();
    s.beginEdit();
    expect(useAppStore.getState().isDirty()).toBe(false);
    s.setDraft("videoLoop", false);
    expect(useAppStore.getState().isDirty()).toBe(true);
    s.setDraft("videoLoop", true);
    expect(useAppStore.getState().isDirty()).toBe(false);
  });

  it("notices an override change on its own", () => {
    const s = useAppStore.getState();
    s.beginEdit();
    s.setOverride("bookmarks", "reset");
    expect(useAppStore.getState().isDirty()).toBe(true);
  });

  it("writes only what changed, on Save", async () => {
    const s = useAppStore.getState();
    s.beginEdit();
    s.setDraft("theme", "oled");
    s.setDraft("hideRepostsDefault", true);
    await useAppStore.getState().saveDraft();
    expect(setSetting).toHaveBeenCalledWith(expect.arrayContaining([["theme", "oled"], ["content.hideReposts", "true"]]));
    expect(setSetting).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().prefs.theme).toBe("oled");
    expect(useAppStore.getState().draft).toBeNull();
  });

  it("retains the draft and committed values on a failed atomic save, then retries", async () => {
    const s=useAppStore.getState(); s.beginEdit(); s.setDraft('theme','light'); s.setDraft('readingSize',130);
    setSetting.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(useAppStore.getState().saveDraft()).rejects.toThrow('storage unavailable');
    expect(useAppStore.getState().prefs.theme).toBe(defaultPreferences.theme);
    expect(useAppStore.getState().draft?.readingSize).toBe(130);
    await useAppStore.getState().saveDraft(); expect(useAppStore.getState().prefs.readingSize).toBe(130);
  });

  it("serializes saves and keeps edits made during an in-flight commit", async () => {
    let release!:()=>void; setSetting.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
    useAppStore.getState().setDraft('theme','light'); const first=useAppStore.getState().saveDraft();
    await vi.waitFor(()=>expect(setSetting).toHaveBeenCalledTimes(1));
    useAppStore.getState().setDraft('readingSize',140); const second=useAppStore.getState().saveDraft();
    await Promise.resolve();expect(setSetting).toHaveBeenCalledTimes(1);release();await first;
    expect(useAppStore.getState().draft?.readingSize).toBe(140);await second;
    expect(useAppStore.getState().prefs).toMatchObject({theme:'light',readingSize:140});
  });

  it("stores a cleared override as empty rather than leaving the old value", async () => {
    useAppStore.setState({
      prefs: {
        ...defaultPreferences,
        pageOpenOverrides: { bookmarks: "reset" },
      },
    });
    const s = useAppStore.getState();
    s.beginEdit();
    s.setOverride("bookmarks", undefined);
    await useAppStore.getState().saveDraft();
    expect(setSetting).toHaveBeenCalledWith([["pages.openBehavior.bookmarks", ""]]);
  });

  it("restores the saved values on Cancel", () => {
    const s = useAppStore.getState();
    s.beginEdit();
    s.setDraft("theme", "light");
    s.setDraft("radius", 0);
    useAppStore.getState().cancelDraft();
    expect(useAppStore.getState().draft).toBeNull();
    expect(useAppStore.getState().prefs.theme).toBe("dark");
    expect(useAppStore.getState().prefs.radius).toBe(defaultPreferences.radius);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("resets to defaults without saving them", () => {
    useAppStore.setState({
      prefs: { ...defaultPreferences, theme: "oled", radius: 2 },
    });
    const s = useAppStore.getState();
    s.beginEdit();
    useAppStore.getState().resetDraftToDefaults();
    expect(useAppStore.getState().draft?.theme).toBe("dark");
    expect(useAppStore.getState().prefs.theme).toBe("oled");
    expect(setSetting).not.toHaveBeenCalled();
  });
});

describe("navigation", () => {
  beforeEach(() => {
    useAppStore.setState({
      route: "following",
      profileUsername: null,
      history: [],
      scrollPositions: {},
    });
  });

  it("opens a profile and comes back to where it was", () => {
    const s = useAppStore.getState();
    s.navigate("bookmarks");
    useAppStore.getState().openProfile("reem_codes");
    expect(useAppStore.getState().route).toBe("profile");
    expect(useAppStore.getState().profileUsername).toBe("reem_codes");
    expect(useAppStore.getState().canGoBack()).toBe(true);

    expect(useAppStore.getState().goBack()).toBe(true);
    expect(useAppStore.getState().route).toBe("bookmarks");
    expect(useAppStore.getState().profileUsername).toBeNull();
  });

  it("walks back out of a chain of profiles", () => {
    const s = useAppStore.getState();
    s.openProfile("one");
    useAppStore.getState().openProfile("two");
    useAppStore.getState().goBack();
    expect(useAppStore.getState().profileUsername).toBe("one");
    useAppStore.getState().goBack();
    expect(useAppStore.getState().route).toBe("following");
  });

  it("reports that there is nowhere to go back to", () => {
    expect(useAppStore.getState().canGoBack()).toBe(false);
    expect(useAppStore.getState().goBack()).toBe(false);
    expect(useAppStore.getState().route).toBe("following");
  });

  it("does not record a step for navigating to where it already is", () => {
    const s = useAppStore.getState();
    s.navigate("bookmarks");
    useAppStore.getState().navigate("bookmarks");
    expect(useAppStore.getState().history).toHaveLength(1);
  });

  it("sends the routes with no destination somewhere sensible", () => {
    const s = useAppStore.getState();
    // Lists cannot be enumerated by this backend and Pinned had no working
    // workflow; both ids survive only so a stored value cannot crash startup.
    s.navigate("lists");
    expect(useAppStore.getState().route).toBe("following");
    useAppStore.getState().navigate("pinned");
    expect(useAppStore.getState().route).toBe("accounts");
  });

  it("clears history for a top-level jump", () => {
    const s = useAppStore.getState();
    s.openProfile("someone");
    useAppStore.getState().setRoute("settings");
    expect(useAppStore.getState().canGoBack()).toBe(false);
    expect(useAppStore.getState().profileUsername).toBeNull();
  });

  it("remembers a scroll offset per route", () => {
    const s = useAppStore.getState();
    s.rememberScroll("following", 1200);
    s.rememberScroll("profile:reem_codes", 340);
    expect(useAppStore.getState().scrollPositions.following).toBe(1200);
    expect(useAppStore.getState().scrollPositions["profile:reem_codes"]).toBe(
      340,
    );
  });
});
