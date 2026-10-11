import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterBar } from "./FilterBar";
import { defaultFilters } from "@/lib/api";

describe("FilterBar", () => {
  it("toggles a quick filter", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <FilterBar
        filters={defaultFilters}
        onChange={onChange}
        onReset={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "No reposts" }));
    expect(onChange).toHaveBeenCalledWith({ hideReposts: true });
  });

  it("turns an active filter back off", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <FilterBar
        filters={{ ...defaultFilters, hideReposts: true }}
        onChange={onChange}
        onReset={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "No reposts" }));
    expect(onChange).toHaveBeenCalledWith({ hideReposts: false });
  });

  it("states plainly that filtering never deletes posts", () => {
    render(
      <FilterBar
        filters={defaultFilters}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    expect(screen.getByText(/Nothing is deleted/i)).toBeInTheDocument();
  });

  it("reveals advanced controls and resets them", async () => {
    const onReset = vi.fn();
    const user = userEvent.setup();
    render(
      <FilterBar
        filters={defaultFilters}
        onChange={vi.fn()}
        onReset={onReset}
      />,
    );

    await user.click(screen.getByRole("button", { name: /More/ }));
    expect(screen.getByText("Advanced filters")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset all filters" }));
    expect(onReset).toHaveBeenCalled();
  });

  it("offers no engagement threshold, because no engagement figure is shown", async () => {
    const user = userEvent.setup();
    render(
      <FilterBar
        filters={defaultFilters}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /More/ }));
    expect(screen.queryByLabelText("Minimum engagement")).toBeNull();
    // The one advanced numeric control that remains.
    expect(screen.getByLabelText("Maximum age")).toBeInTheDocument();
  });
});
