# iOS 27 device acceptance

Run this after Codemagic's candidate gates and IPA verification pass. Simulator evidence does not replace this session. Record the iPhone model, exact iOS version, app version/build and source commit shown in Settings.

## Twenty-minute reading session

| Time | Exercise | Pass condition |
| --- | --- | --- |
| 0–3 minutes | Open welcome, visit Settings, cancel sign-in, retry, background and return. Sign in normally. | Privacy and actions remain reachable; no reader tabs on welcome; one login view; every cancelled or failed attempt settles and permits a fresh retry. |
| 3–8 minutes | Read Following and Focus; refresh, scroll through several continuations, open two different profiles. | First returned posts appear promptly; avatars do not delay text; older posts append without duplicates, full reloads or lost position. Failed refresh retains existing posts. |
| 8–13 minutes | Open mixed portrait/landscape photos; page, pinch and double-tap; close. Play video, seek, change quality, enter native fullscreen, rotate, background/return and dismiss. | Complete pictures keep their proportions; controls avoid status indicators; one playback session; playhead and intended playback state return correctly; no trapped fullscreen. |
| 13–17 minutes | Open Accounts and search while results arrive. Briefly interrupt connectivity, then restore it and retry. | Completed account pages remain usable; loading ends in completion or an explicit error; retry works; failed avatars show initials and failed media shows useful recovery. |
| 17–20 minutes | Return to prior feeds/profiles, change English/Arabic and reading size, inspect portrait/landscape, reduced motion and reduced transparency. | Reading position restores; identity rows and buttons remain readable and usable; no duplicate navigation layer, hidden post content, frozen controls or accumulating audio. |

Record battery percentage and whether the device heats up, stalls, loses audio control or terminates the app. When developer tools are available, capture memory/CPU at the start, middle and end with repeated media opening/dismissal; check for a persistent upward trend after viewers close. Report the measurements rather than declaring resource use bounded from appearance alone.

## Targeted 0.8.9 checks

Use actual posts and profiles that previously showed the reported problems:

1. Open an article with **Read full article**. Read beyond its teaser, inspect its
   complete title, headings, paragraphs and pictures, then close and reopen it.
   Interrupt the connection once and verify **Retry article** recovers.
2. Refresh a post with attached media. Its provider-generated attachment link
   should be absent; an ordinary authored website link should remain readable,
   including in Arabic text. Preserve the author's paragraph breaks.
   Use **Copy original post URL** below the card and paste it to verify the exact
   original post; a rejected copy must show an error rather than success.
3. Open a profile whose bio is visible in X. Compare its bio and counts. Use
   **Refresh profile details** to retry an incomplete read; unknown data must not
   become invented zero counts or a claim that the person has no bio.
4. Replay a previously failing video and check its poster, seek and fullscreen.
   If it fails, verify a compact recovery panel appears, tap **Retry video**, and
   record whether the refreshed source plays or an explicit failure remains.
   Test a lower quality only when a real alternative rendition is offered.
   On an inline failure, try **Open native player** and verify its playhead and
   dismissal. Interrupt a transfer and confirm the compact retry state appears.
   Repeat with photo loading/retry, native progress indication, zoom and paging.

Record the version/build for each result. Automated fixtures establish recovery
behavior; they cannot establish the availability of every live provider asset.

## Account relationship check

The originally reported follow problem remains unconfirmed. Deliberately choose a public profile and record its current relationship in X before testing. Use the app's explicit confirmation, verify the resulting server relationship in X, reopen the profile and Accounts, and restore the initial relationship if desired. Do not automatically repeat a write whose result is uncertain.

## Record failures

Save the screen, route, action, network type, elapsed wait and app version/build. Connection diagnostics can identify a failed stage without copying passwords or session cookies. Keep the previous verified IPA available. Stop release acceptance on a failure and repair through an ordinary corrective or revert commit.

Convenience features in milestone 9 remain after the repair acceptance gates; their absence is not a passed implementation result.
