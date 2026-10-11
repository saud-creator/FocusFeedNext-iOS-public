import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, isTauri, type RuntimePlatform } from "@/lib/api";

interface PlatformContextValue {
  platform: RuntimePlatform;
  isIphone: boolean;
}

function initialPlatform(): RuntimePlatform {
  if (typeof window === "undefined") return "web";
  // A development-only query makes the exact iPhone layout renderable on the
  // Windows browser without changing a production transport decision.
  if (
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get("platform") === "ios"
  ) {
    return "ios";
  }
  return /iPhone|iPad|iPod/i.test(window.navigator.userAgent) ? "ios" : "web";
}

const PlatformContext = createContext<PlatformContextValue>({
  platform: "web",
  isIphone: false,
});

export function PlatformProvider({ children }: { children: ReactNode }) {
  const [platform, setPlatform] = useState<RuntimePlatform>(initialPlatform);

  useEffect(() => {
    let cancelled = false;
    if (isTauri()) {
      api
        .runtimePlatform()
        .then((value) => {
          if (!cancelled) setPlatform(value);
        })
        .catch(() => {
          /* The user-agent result remains a safe layout fallback. */
        });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.platform = platform;
  }, [platform]);

  const value = useMemo(
    () => ({ platform, isIphone: platform === "ios" }),
    [platform],
  );
  return (
    <PlatformContext.Provider value={value}>
      {children}
    </PlatformContext.Provider>
  );
}

export function usePlatform(): PlatformContextValue {
  return useContext(PlatformContext);
}
