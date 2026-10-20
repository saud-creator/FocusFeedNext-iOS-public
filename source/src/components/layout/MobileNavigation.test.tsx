import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MobileNavigation } from "./MobileNavigation";
import { renderWithProviders } from "@/test/factories";
import { defaultPreferences, useAppStore } from "@/stores/useAppStore";

describe("MobileNavigation", () => {
  beforeEach(() => {
    useAppStore.setState({ route: "following", profileUsername: null, prefs:defaultPreferences });
  });

  it("puts the four daily iPhone destinations in the persistent tab bar", () => {
    renderWithProviders(<MobileNavigation unread={12} />);

    expect(
      screen.getByRole("navigation", { name: "Main navigation" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Following feed/ }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("button", { name: "Focus Feed" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Bookmarks" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "People you follow" }),
    ).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });
  it('releases occupied reading space when returning to welcome',()=>{
    const rendered=renderWithProviders(<MobileNavigation unread={0}/>);
    expect(document.documentElement.style.getPropertyValue('--reader-bottom-inset')).toContain('safe-area-inset-bottom');
    rendered.unmount();
    expect(document.documentElement.style.getPropertyValue('--reader-bottom-inset')).toBe('0px');
  });

  it("keeps secondary destinations in an iPhone bottom sheet", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MobileNavigation unread={0} />);

    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByTestId("mobile-more-menu")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect(useAppStore.getState().route).toBe("settings");
    expect(screen.queryByTestId("mobile-more-menu")).not.toBeInTheDocument();
  });
  it('uses custom ordered tabs and keeps the remaining destinations in More',async()=>{
    useAppStore.setState({prefs:{...defaultPreferences,mobileTabs:['search','groups','originals','following']}});
    renderWithProviders(<MobileNavigation unread={0}/>);
    const navigation=screen.getByRole('navigation',{name:'Main navigation'});
    expect([...navigation.querySelectorAll('button')].map(button=>button.textContent)).toEqual(['Search','Lists','Originals','Following','More']);
    const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'More'}));
    expect(screen.getByRole('button',{name:'Bookmarks'})).toBeInTheDocument();
  });
});
