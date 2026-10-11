import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enterFullscreen,
  fullscreenElement,
  fullscreenSupported,
  isNativelyFullscreen,
  leaveFullscreen,
  onFullscreenChange,
} from "./fullscreen";

/**
 * jsdom ships none of this API — no `requestFullscreen`, no
 * `document.fullscreenElement`, no `exitFullscreen` — which is why the module
 * has to treat absence as an ordinary answer rather than an error. These cases
 * install just enough of it to exercise both halves.
 */
function installApi(options: { reject?: boolean } = {}) {
  let element: Element | null = null;
  const grant = (el: Element) => {
    element = el;
    document.dispatchEvent(new Event("fullscreenchange"));
  };
  const request = vi.fn(function (this: Element) {
    if (options.reject) return Promise.reject(new Error("refused"));
    // Not an arrow: this is called as a method of the element being promoted.
    grant(this);
    return Promise.resolve();
  });
  const exit = vi.fn(() => {
    element = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  });

  Object.defineProperty(Element.prototype, "requestFullscreen", {
    configurable: true,
    writable: true,
    value: request,
  });
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => element,
  });
  Object.defineProperty(document, "exitFullscreen", {
    configurable: true,
    writable: true,
    value: exit,
  });
  return { request, exit };
}

function uninstallApi() {
  delete (Element.prototype as { requestFullscreen?: unknown })
    .requestFullscreen;
  delete (document as unknown as { fullscreenElement?: unknown })
    .fullscreenElement;
  delete (document as unknown as { exitFullscreen?: unknown }).exitFullscreen;
}

afterEach(() => {
  uninstallApi();
  vi.restoreAllMocks();
});

describe("without a Fullscreen API", () => {
  it("reports no fullscreen element rather than throwing", () => {
    expect(fullscreenElement()).toBeNull();
    expect(isNativelyFullscreen(document.createElement("div"))).toBe(false);
    expect(isNativelyFullscreen(null)).toBe(false);
  });

  it("says so before anything is asked of it", () => {
    expect(fullscreenSupported(document.createElement("div"))).toBe(false);
    expect(fullscreenSupported(null)).toBe(false);
  });

  it("answers a request with false instead of failing", async () => {
    await expect(enterFullscreen(document.createElement("div"))).resolves.toBe(
      false,
    );
    await expect(enterFullscreen(null)).resolves.toBe(false);
  });

  it("leaves quietly", async () => {
    await expect(leaveFullscreen()).resolves.toBeUndefined();
  });

  it("contains throwing host accessors instead of leaking a renderer error", async () => {
    const el = document.createElement("div");

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => {
        throw new Error("host accessor failed");
      },
    });
    Object.defineProperty(el, "requestFullscreen", {
      configurable: true,
      get: () => {
        throw new Error("host request accessor failed");
      },
    });

    expect(fullscreenElement()).toBeNull();
    expect(fullscreenSupported(el)).toBe(false);
    await expect(enterFullscreen(el)).resolves.toBe(false);
    await expect(leaveFullscreen()).resolves.toBeUndefined();
  });
});

describe("with a Fullscreen API", () => {
  it("grants a request and reports the element that holds it", async () => {
    const { request } = installApi();
    const el = document.createElement("div");

    expect(fullscreenSupported(el)).toBe(true);
    await expect(enterFullscreen(el)).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(fullscreenElement()).toBe(el);
    expect(isNativelyFullscreen(el)).toBe(true);
    expect(isNativelyFullscreen(document.createElement("div"))).toBe(false);
  });

  it("reports a refusal as false, because a refusal is ordinary", async () => {
    installApi({ reject: true });
    // A request outside a user gesture is rejected by design; the caller needs
    // to fall back to its own layout, not to see an unhandled rejection.
    await expect(enterFullscreen(document.createElement("div"))).resolves.toBe(
      false,
    );
  });

  it("exits only when there is something to exit", async () => {
    const { exit } = installApi();
    await leaveFullscreen();
    expect(exit).not.toHaveBeenCalled();

    const el = document.createElement("div");
    await enterFullscreen(el);
    await leaveFullscreen();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(fullscreenElement()).toBeNull();
  });

  it("contains a throwing exit accessor", async () => {
    const el = document.createElement("div");
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => el,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      get: () => {
        throw new Error("host exit accessor failed");
      },
    });

    await expect(leaveFullscreen()).resolves.toBeUndefined();
  });
});

describe("onFullscreenChange", () => {
  it("hears the standard event and the prefixed one", () => {
    const seen = vi.fn();
    const off = onFullscreenChange(seen);

    document.dispatchEvent(new Event("fullscreenchange"));
    document.dispatchEvent(new Event("webkitfullscreenchange"));
    expect(seen).toHaveBeenCalledTimes(2);

    off();
    document.dispatchEvent(new Event("fullscreenchange"));
    document.dispatchEvent(new Event("webkitfullscreenchange"));
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
