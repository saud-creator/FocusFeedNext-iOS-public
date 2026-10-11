import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { api } from "@/lib/api";
import { makeSnapshot } from "@/test/factories";
import {
  resetStartupSequenceForTests,
  useSessionReady,
} from "./useStartupSequence";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, checkSession: vi.fn() },
  };
});

const checkSession = vi.mocked(api.checkSession);

describe("startup session handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStartupSequenceForTests();
  });

  it("joins a launch probe even before its checking flag becomes visible", async () => {
    checkSession
      .mockResolvedValueOnce(
        makeSnapshot({
          state: "disconnected",
          reason: "not_checked",
          checking: false,
          hasCredentials: true,
        }),
      )
      .mockResolvedValueOnce(
        makeSnapshot({
          state: "connected",
          reason: "ok",
          checking: false,
          hasCredentials: true,
        }),
      );

    const { result } = renderHook(() => useSessionReady());
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.readyToken).toBe(1);
    expect(checkSession).toHaveBeenCalledTimes(2);
  });
});
