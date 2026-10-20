import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Lightbox } from "./Lightbox";
import { MediaGallery } from "@/components/post/MediaGallery";
import { makeImage, renderWithProviders } from "@/test/factories";

const images = [
  makeImage({ alt: "first chart", width: 1200, height: 800 }),
  makeImage({ alt: "second chart", width: 800, height: 1200 }),
  makeImage({ alt: "third chart", width: 1000, height: 1000 }),
];

/**
 * The viewer's positioning contract.
 *
 * The bug being guarded is specific: opening an image from the bottom of a long
 * feed drew the overlay at the *top of the feed* rather than over the window.
 * The cause is that an ancestor running a transform becomes the containing
 * block for `position: fixed` descendants, and the app shell animates `<main>`.
 * Every assertion below is about the viewer being unreachable by that ancestor
 * — mounted on the body, fixed, and inset on all four sides.
 */
describe("image viewer escapes the feed", () => {
  it("mounts on the document body, not inside the card that opened it", () => {
    const { container } = renderWithProviders(
      <Lightbox media={images} index={0} onClose={vi.fn()} />,
    );
    const overlay = screen.getByTestId("lightbox");
    // Not anywhere under the component's own subtree.
    expect(container.contains(overlay)).toBe(false);
    expect(overlay.parentElement).toBe(document.body);
  });

  it("is fixed and inset on all four sides, set inline rather than by class", () => {
    renderWithProviders(<Lightbox media={images} index={0} onClose={vi.fn()} />);
    const overlay = screen.getByTestId("lightbox");
    // Inline, because the portal renders into a document the stylesheet may
    // not have reached, and because `inset` is a shorthand engines expand.
    expect(overlay.style.position).toBe("fixed");
    expect(overlay.style.top).toBe("0px");
    expect(overlay.style.right).toBe("0px");
    expect(overlay.style.bottom).toBe("0px");
    expect(overlay.style.left).toBe("0px");
    expect(Number(overlay.style.zIndex)).toBeGreaterThan(50);
  });

  it("opens over the window from a card anywhere in the feed", async () => {
    const user = userEvent.setup();
    // Stand-in for a card at the very bottom of a long list: a transformed
    // ancestor, which is exactly what breaks a naive fixed overlay.
    renderWithProviders(
      <div style={{ transform: "translateY(9000px)" }}>
        <MediaGallery media={images} />
      </div>,
    );

    await user.click(screen.getAllByRole("button")[0]);
    const overlay = screen.getByTestId("lightbox");
    expect(overlay.parentElement).toBe(document.body);
    expect(overlay.style.position).toBe("fixed");
  });
});

describe("image layout reservation", () => {
  it("gives a ratio-less single image a stable first frame", () => {
    renderWithProviders(
      <MediaGallery media={[makeImage({ width: null, height: null })]} />,
    );

    const frame = screen.getAllByRole("button")[0];
    // The reserved image frame exists before its bytes finish loading.
    const image = within(frame).getByRole("img", { hidden: true });
    expect(frame.style.aspectRatio).toContain("1.777777");
    expect(frame.style.aspectRatio).toContain("/");
    expect(image.style.height).toBe("100%");
  });
});

describe("image viewer lifecycle", () => {
  it("locks and restores scrolling across repeated open and close cycles", async () => {
    document.body.style.overflow = "visible";
    const user = userEvent.setup();

    for (let i = 0; i < 3; i++) {
      const { unmount } = renderWithProviders(
        <MediaGallery media={images} />,
      );
      await user.click(screen.getAllByRole("button")[0]);
      expect(document.body.style.overflow).toBe("hidden");

      await user.keyboard("{Escape}");
      // Whatever the page had before is what it gets back — not a blanket
      // reset, which after one cycle would leave the app unscrollable.
      expect(document.body.style.overflow).toBe("visible");
      unmount();
    }
    document.body.style.overflow = "";
  });

  it("takes focus on open and gives it back on close", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MediaGallery media={images} />);
    const thumbnail = screen.getAllByRole("button")[0];
    thumbnail.focus();
    expect(document.activeElement).toBe(thumbnail);

    await user.click(thumbnail);
    expect(screen.getByTestId("lightbox")).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("lightbox")).toBeNull();
    // Back to the picture they came from, not the top of the document.
    expect(document.activeElement).toBe(thumbnail);
  });

  it("keeps Tab inside the viewer", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Lightbox media={images} index={0} onClose={vi.fn()} />);
    const overlay = screen.getByTestId("lightbox");

    // Enough presses to have walked out of any real control set.
    for (let i = 0; i < 14; i++) {
      await user.tab();
      expect(overlay.contains(document.activeElement)).toBe(true);
    }
  });

  it("closes on Escape and on the close button, but not on the picture", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <Lightbox media={images} index={0} onClose={onClose} />,
    );

    await user.click(screen.getByTestId("lightbox-image"));
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("closes on a bare backdrop click", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <Lightbox media={images} index={0} onClose={onClose} />,
    );
    await user.click(screen.getByTestId("lightbox-stage"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("image viewer navigation", () => {
  it("counts the images and moves between them with the arrow keys", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Lightbox media={images} index={0} onClose={vi.fn()} />);
    const overlay = screen.getByTestId("lightbox");

    expect(within(overlay).getByLabelText("Image 1 of 3")).toBeInTheDocument();
    await user.keyboard("{ArrowRight}");
    expect(within(overlay).getByLabelText("Image 2 of 3")).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    await user.keyboard("{ArrowLeft}");
    // Wraps rather than stopping dead at the first picture.
    expect(within(overlay).getByLabelText("Image 3 of 3")).toBeInTheDocument();
  });

  it("offers no counter or arrows for a single image", () => {
    renderWithProviders(
      <Lightbox media={[images[0]]} index={0} onClose={vi.fn()} />,
    );
    expect(screen.queryByLabelText(/Image 1 of/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Next image" })).toBeNull();
  });

  it("returns to the fitted view when the picture changes", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Lightbox media={images} index={0} onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByLabelText("Zoom level").textContent).not.toBe("100%");

    await user.click(screen.getByRole("button", { name: "Next image" }));
    // A new subject is not a continuation of the last crop.
    expect(screen.getByLabelText("Zoom level").textContent).toBe("100%");
  });

  it("never zooms below the fitted view", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Lightbox media={images} index={0} onClose={vi.fn()} />);
    const out = screen.getByRole("button", { name: "Zoom out" });
    for (let i = 0; i < 8; i++) await user.click(out);
    // Fitted is the floor, so the image can never be shrunk into a speck the
    // reader then has to hunt for.
    expect(screen.getByLabelText("Zoom level").textContent).toBe("100%");
  });
});
