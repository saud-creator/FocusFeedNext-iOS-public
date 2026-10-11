import type { Catalog } from "./types";

/**
 * English message catalog.
 *
 * Flat and dot-namespaced on purpose: a flat map makes "do both catalogs have
 * the same keys?" a one-line test, and keeps lookup free of nested-path code.
 *
 * Conventions
 * - `{name}` placeholders are interpolated by `t()` / `plural()`.
 * - Count-driven strings are plural *sets*: `key.zero` … `key.other`. Both
 *   catalogs carry all six CLDR categories even though English only selects
 *   `one` and `other`, so the key sets stay identical.
 * - Never bake digits, units or punctuation-joined fragments into a value —
 *   numbers and dates come from the `Intl` formatters in `./index`.
 * - Product names stay untranslated: X, twitter-cli, Agent Reach, Tauri,
 *   auth_token, ct0, Focus Feed Next.
 */
export const en: Catalog = {
  "ios.error.rate_limited": "X has temporarily limited requests. Wait before checking again.",
  "ios.error.account_challenge": "Complete the verification requested on the X page, then tap Continue.",
  "ios.report.hint": "If sign-in fails, share this report so we can locate the failed step. It excludes passwords, cookies and account content.",
  "ios.report.generate": "View sign-in diagnostics",
  "ios.report.share": "Share diagnostic file",
  "ios.report.copy": "Copy report",
  "ios.report.copied": "Copied",
  "ios.report.label": "Sign-in diagnostic report",
  "ios.report.failed": "The report could not open. Try View diagnostics again.",
  "ios.report.copyFailed": "Copy failed. Select the report text or use Share diagnostic file.",

  "ios.metrics.title": "Connection timings",
  "ios.metrics.description": "Recent request timings on this iPhone. Provider time includes network transfer and Twitter processing; this does not measure frame rate.",
  "ios.metrics.queue": "Queue and spacing",
  "ios.metrics.bootstrap": "Connection preparation",
  "ios.metrics.provider": "Twitter and network",
  "ios.metrics.parse": "Response parsing",
  "ios.metrics.total": "Native request total",
  "ios.metrics.ms": "{value} ms",
  "ios.metrics.empty": "No completed request measurements yet.",
  "ios.metrics.failed": "Measurements are temporarily unavailable.",
  "ios.metrics.refresh": "Refresh measurements",

  "performance.ultra": "Ultra",
  "performance.ultra.description": "Larger nearby buffers and visible-first loading. Twitter response time and iOS refresh limits still apply.",
  "account.follow.pending": "Follow request pending",
  "account.controls": "Account controls",
  "account.subscription.open": "Open creator on Twitter",
  "account.subscription.description": "Paid subscriptions, when available, are managed on the creator’s official Twitter page.",
  "account.subscription.failed": "The creator’s page could not open. Try again.",
  "ios.error.bridge_failure": "The native connection bridge is unavailable. Reopen the app and retry.",
  "ios.error.missing_cookies": "Complete Twitter sign-in, then tap Continue.",
  "ios.error.transport_initialization": "The secure connection could not initialize. Retry the connection.",
  "ios.error.transaction_bootstrap": "Twitter’s connection metadata could not be read. Retry or update the app.",
  "ios.error.authentication_expired": "Twitter rejected this session. Sign in again.",
  "ios.error.provider_rejection": "Twitter could not accept this request. Try again later.",
  "ios.error.timeout": "Twitter took too long to respond. Try again.",
  "ios.error.cancelled": "The connection attempt was cancelled.",
  "ios.error.background_paused": "Sign-in will resume when you return to the app.",
  "ios.error.session_storage": "The session could not be saved securely. Your previous session is retained.",
  "ios.error.network_failure": "Twitter could not be reached. Check your connection and retry.",
  "ios.error.unsupported_response": "Twitter returned an unsupported response. Retry or update the app.",
  "ios.stage.login": "Twitter sign-in",
  "ios.stage.cookies": "Preparing session",
  "ios.stage.transport": "Preparing secure connection",
  "ios.stage.transport_navigation": "Starting the connection document",
  "ios.stage.transport_origin": "Checking the connection origin",
  "ios.stage.transport_process": "Restarting the connection engine",
  "ios.stage.transport_script": "Running the connection engine",
  "ios.stage.bootstrap": "Reading connection metadata",
  "ios.stage.identity": "Verifying your account",
  "ios.stage.provider": "Twitter request",
  "ios.stage.storage": "Saving session securely",
  "ios.stage.bridge": "Native connection",
  "ios.stage.queue": "Waiting for connection",
  "ios.stage.connected": "Connected",
  "ios.connection.retry": "Retry sign-in",
  "ios.connection.reference": "Request {id}",
  "post.video.back10": "Back 10 seconds",
  "post.video.forward10": "Forward 10 seconds",
  "post.video.lowerQuality": "Try a lower quality",
  "nav.short.following": "Following",
  "nav.short.focus": "Focus",
  "nav.short.bookmarks": "Saved",
  "nav.short.accounts": "Accounts",
  "nav.short.originals": "Originals",
  "nav.short.groups": "Lists",
  "nav.short.search": "Search",

  'localSearch.title': 'Search loaded posts',
  'localSearch.description': 'Search posts loaded in this account session. No additional Twitter requests.',
  'localSearch.placeholder': 'Text, name, or username…',
  'localSearch.start': 'Find something you have loaded',
  'localSearch.empty': 'No loaded posts match',
  'localSearch.failed': 'Search could not complete. Try again.',
  'performance.title': 'Performance and personalization',
  'performance.description': 'Keep reading responsive while controlling data, playback, and battery use.',
  'performance.mode': 'Performance mode',
  'performance.balanced': 'Balanced',
  'performance.fast': 'Fast',
  'performance.battery': 'Battery Saver',
  'performance.effective': 'Currently using',
  'performance.reason.normal': 'Your preferences',
  'performance.reason.background': 'App is in the background',
  'performance.reason.thermal': 'Device is warm',
  'performance.reason.lowPower': 'Low Power Mode',
  'performance.reason.lowData': 'Low Data Mode',
  'performance.readingSize': 'Reading text size',
  'performance.autoplay': 'Video and GIF autoplay',
  'performance.autoplay.off': 'Off',
  'performance.autoplay.wifi': 'Wi-Fi only',
  'performance.autoplay.any': 'Any connection',
  'performance.haptics': 'Selection haptics',
  'performance.navigation': 'Your four primary tabs',
  'performance.tab': 'Tab',
  'performance.moveUp': 'Move tab earlier',
  'performance.moveDown': 'Move tab later',
  'performance.export': 'Export preferences',
  'performance.import': 'Import preferences',
  'performance.imported': 'Preferences imported and saved.',
  'performance.importFailed': 'Preferences could not be imported or exported. Check the file and try again.',
  'performance.autoQuality': 'Auto — adapts to data and battery',
  'performance.quickSettings': 'Settings sections',
  'performance.section.appearance': 'Appearance',
  'performance.section.reading': 'Reading',
  'performance.section.media': 'Media',
  'performance.section.performance': 'Performance',
  'performance.section.connection': 'Connection',
  'ios.account.title': 'Twitter account',
  'ios.account.description': 'Connect directly from your iPhone. Your Windows app can stay closed.',
  'ios.account.switch': 'Switch account',
  'ios.account.privacy': 'You sign in on Twitter’s own page. Your session stays in this iPhone’s Keychain. Your password is never read by Focus Feed.',
  'ios.signin': 'Sign in with Twitter',
  'ios.signingIn': 'Connecting your account…',
  'ios.signout': 'Sign out',
  'ios.welcome.eyebrow': 'YOUR FEED. YOUR PACE.',
  'ios.welcome.title': 'A little less noise.\nA lot more focus.',
  'ios.welcome.description': 'Follow what matters, read comfortably, and keep your place. A thoughtful space for your Twitter feed.',
  // -- app -------------------------------------------------------------------
  "app.name": "Focus Feed Next",
  "app.nameLead": "Focus Feed",
  "app.nameSuffix": "Next",
  "app.tagline": "A quiet desktop reader for X",
  "app.description":
    "Read the accounts you follow on your own terms. Everything stays on this machine.",

  // -- navigation ------------------------------------------------------------
  "nav.home": "Home",
  "nav.following": "Following",
  "nav.followingFeed": "Following feed",
  "nav.originals": "Originals",
  "nav.peopleYouFollow": "People you follow",
  "nav.focus": "Focus Feed",
  "nav.groups": "Lists",
  "nav.bookmarks": "Bookmarks",
  "nav.profile": "Profile",
  "nav.connect": "X connection",
  "nav.diagnostics": "Diagnostics",
  "nav.settings": "Settings",
  "nav.section.following": "Following",
  "nav.section.read": "Read",
  "nav.section.organize": "Organize",
  "nav.section.lists": "My lists",
  "nav.section.system": "System",
  "nav.dataSource": "Data source",
  "nav.badgeOverflow": "{count}+",
  "nav.collapse": "Collapse sidebar",
  "nav.expand": "Expand sidebar",
  "nav.mobile.primary": "Main navigation",
  "nav.mobile.more": "More",
  "nav.mobile.closeMore": "Close the More menu",

  // -- session health --------------------------------------------------------
  "session.title": "Session",
  "session.status.connected": "Connected",
  "session.status.connected.desc":
    "The X session is valid and live posts are loading normally.",
  "session.status.degraded": "Degraded",
  "session.status.degraded.desc":
    "The session still works, but X is throttling or answering slowly. Refresh less often.",
  "session.status.expired": "Expired",
  "session.status.expired.desc":
    "X no longer accepts this session. Replace auth_token and ct0 to continue.",
  "session.status.disconnected": "Not connected",
  "session.status.disconnected.desc":
    "No X session has been added yet, so there is nothing to load.",
  "session.reconnectRequired": "Reconnect required",
  "session.checking": "Checking the session…",
  "session.lastChecked": "Last checked",
  "session.account": "Signed in as {username}",
  "session.rateLimitedUntil": "Rate limited until {time}",
  "session.fix": "Fix the connection",
  // One line per backend reason, so the interface can always say *why* rather
  // than only what colour the dot is.
  "session.reason.notChecked":
    "Credentials are stored but have not been checked yet this run.",
  "session.reason.requestFailed":
    "The session is valid, but the last request to X did not come back.",
  "session.reason.rateLimited":
    "X is rate limiting this account. Requests will work again shortly.",
  "session.reason.offline":
    "This machine appears to be offline, so nothing can be fetched.",
  "session.reason.stale":
    "The session has not been confirmed recently and is being re-checked.",
  "session.reason.toolMissing":
    "twitter-cli is not installed, so X cannot be reached at all.",

  // -- X connection ----------------------------------------------------------
  "connect.title": "X connection",
  "connect.subtitle": "Connect a burner X account to load live posts",
  "connect.explanation":
    "Focus Feed Next reads X with the session cookies of an account you sign in to yourself. It never asks for your password. Posting, liking, reposting, bookmarking, muting and blocking are refused by the backend; removing an existing bookmark is the one explicit post action, and always asks for confirmation. The only other actions that can change your account are Follow and Unfollow, and they are switched off until you turn them on below.",
  "connect.authToken": "auth_token",
  "connect.ct0": "ct0",
  "connect.authToken.help":
    "Sign in to X in a browser on a burner account, open the developer tools, and copy the value of the auth_token cookie for x.com.",
  "connect.ct0.help":
    "In the same cookie list, copy the value of ct0. It is the CSRF token that must accompany auth_token.",
  "connect.authToken.placeholder": "Paste the auth_token cookie value",
  "connect.ct0.placeholder": "Paste the ct0 cookie value",
  "connect.howTo.title": "Where to find these values",
  "connect.howTo.step1": "Sign in to x.com on a dedicated burner account.",
  "connect.howTo.step2":
    "Open the browser developer tools and go to the cookie list for x.com.",
  "connect.howTo.step3": "Copy the values of auth_token and ct0.",
  "connect.howTo.step4": "Paste both here and press Test connection.",
  "connect.save": "Save connection",
  "connect.test": "Test connection",
  "connect.replace": "Replace credentials",
  "connect.disconnect": "Disconnect",
  "connect.clear": "Clear stored credentials",
  "connect.refresh": "Refresh session status",
  "connect.saving": "Saving…",
  "connect.testing": "Testing…",
  "connect.success": "Connected. Live posts will load from now on.",
  "connect.failure": "The connection could not be established.",
  "connect.testSuccess": "The session works. X answered as {username}.",
  "connect.testFailure": "X rejected this session.",
  "connect.cleared": "The stored credentials were removed from this machine.",
  "connect.disconnected": "Disconnected. No live data will be requested.",
  "connect.storageWarning":
    "auth_token and ct0 are stored in Windows Credential Manager and never leave this machine. They are never written to the database, the settings file, logs, screenshots or diagnostic reports.",
  "connect.neverPassword":
    "Never enter your X password here. Focus Feed Next does not have a password field and never will.",
  "connect.burnerAdvice":
    "Use a burner account. A session cookie grants read access to whatever account it belongs to.",
  "connect.connectedAs": "Connected as {username}",
  "connect.notConnected": "No session is stored on this machine yet.",
  "connect.required": "Both auth_token and ct0 are required.",
  "connect.invalidFormat": "That does not look like a valid cookie value.",
  "connect.storedAt": "Saved {time}",
  "connect.openHelp": "How to get these values",
  "connect.credentials": "Credentials",
  "connect.credentials.stored": "Stored in Windows Credential Manager",
  "connect.credentials.none": "None stored",
  "connect.provider": "Backend",
  "connect.lastValidated": "Last checked",
  "connect.lastSuccess": "Last successful request",
  "connect.never": "Never",
  "connect.replaceHint":
    "Paste a new pair to replace the stored one. The current connection keeps working unless the new values are accepted.",
  "connect.working": "Working…",
  "connect.fieldsCleared":
    "Both fields were cleared. The values were sent straight to secure storage.",

  // -- iPhone companion -----------------------------------------------------
  "companion.address": "Windows address",
  "companion.code": "Pairing code",
  "companion.copy": "Copy {label}",
  "companion.copyFailed":
    "The value could not be copied. Select and copy it manually.",
  "companion.refresh": "Refresh",
  "companion.addressUnavailable":
    "No private Wi-Fi address was found. Connect Windows to the same Wi-Fi as the iPhone and restart the companion.",
  "companion.windows.title": "iPhone companion",
  "companion.windows.subtitle": "Let your iPhone read through this Windows app",
  "companion.windows.explanation":
    "Start the companion only when you want to pair or use the iPhone app. Focus Feed Next exposes a narrow, read-only feed service on your private network; the Windows app must remain open while the phone loads live data.",
  "companion.windows.running": "Available on this network",
  "companion.windows.notRunning": "Not running",
  "companion.windows.paired": "An iPhone paired",
  "companion.windows.start": "Start iPhone companion",
  "companion.windows.starting": "Starting…",
  "companion.windows.stop": "Stop companion",
  "companion.windows.stopping": "Stopping…",
  "companion.windows.started": "The iPhone companion is ready.",
  "companion.windows.stopped": "The iPhone companion was stopped.",
  "companion.windows.instructions":
    "On iPhone, open Settings → Windows companion, enter the address and eight-digit code shown above, then pair. Keep both devices on the same Wi-Fi. Windows Firewall may ask for private-network access the first time.",
  "companion.windows.security":
    "Your auth_token and ct0 stay in Windows Credential Manager and are never sent to the iPhone. The pairing code works once; stopping the companion revokes the phone immediately. This TestFlight transport is authenticated but not encrypted, so use it only on trusted private Wi-Fi.",
  "companion.iphone.title": "Windows companion",
  "companion.iphone.subtitle": "Pair this iPhone with your running Windows app",
  "companion.iphone.explanation":
    "The iPhone app reuses the Focus Feed Next reader, database, filters and lists. Windows performs the X requests because iOS cannot run the desktop twitter-cli provider.",
  "companion.iphone.notConnected": "This iPhone is not paired yet.",
  "companion.iphone.connected":
    "Paired. Live posts can now load through Windows.",
  "companion.iphone.connectedAs": "Paired. Windows answered as {username}.",
  "companion.iphone.disconnected": "This iPhone was disconnected from Windows.",
  "companion.iphone.keychainStored":
    "Companion token stored in iPhone Keychain",
  "companion.iphone.whereToFind":
    "Find both values in Focus Feed Next on Windows: Settings → iPhone companion. The code contains exactly eight digits and works once.",
  "companion.iphone.pair": "Pair with Windows",
  "companion.iphone.pairing": "Pairing…",
  "companion.iphone.pairAgain": "Pair again",
  "companion.iphone.security":
    "Only a random companion token and the local Windows address are stored in iPhone Keychain. Your X cookies and password never reach this phone. Companion access is read-only, but this TestFlight transport is not encrypted; use trusted private Wi-Fi only.",
  "companion.iphone.privacy":
    "The iPhone stores its companion token and local Windows address in Keychain. Posts, read state, lists and preferences stay in this app's private storage. X cookies remain only on Windows.",

  // -- posts -----------------------------------------------------------------
  "post.repostedBy": "{name} reposted",
  "post.promoted": "Promoted",
  "post.showMore": "Show more",
  "post.showLess": "Show less",
  "post.copyText": "Copy text",
  "post.textCopied": "Text copied",
  "post.hide": "Hide this post",
  "post.markRead": "Mark as read",
  "post.markUnread": "Mark as unread",
  "post.read": "Read",
  "post.unread": "Unread",
  "post.article": "Article",
  "post.quoted": "Quoted post",
  "post.verified": "Verified account",
  "post.moreActions": "More actions",
  "post.addAuthorToGroup": "Add author to list",
  "post.copyLink": "Copy post link",
  "post.linkCopied": "Post link copied",
  "post.removeBookmark": "Remove from bookmarks",
  "post.removeBookmark.confirm.title": "Remove this bookmark from X?",
  "post.removeBookmark.confirm.body": "This removes the bookmark from your X account itself. The post will disappear from Bookmarks here, but it remains in any other feed that contains it.",
  "post.removeBookmark.confirm.action": "Remove from X bookmarks",
  "post.removeBookmark.removing": "Removing…",
  "post.removeBookmark.failed": "Could not remove this bookmark from X. The post was kept here.",
  "post.openProfile": "Open the profile of {name}",
  "post.media.alt": "Image from a post",
  "post.media.openImage": "Open image",
  "post.media.openImageAlt": "Open image: {alt}",
  "post.media.gif": "GIF",
  "post.media.noPreview": "No preview available",
  "post.video.previewOnly": "Preview only",
  "post.video.previewOnly.desc":
    "This post has no playable video stream here. Open the original post on X to watch it.",
  "post.video.failed": "This video could not be played",
  "post.video.auto": "Auto",
  "post.video.autoHint": "This source exposes no quality variants",
  // Distinct playback states. A generic failure message tells the reader
  // nothing about whether to retry, reconnect, or give up.
  "post.video.state.loading": "Loading video…",
  "post.video.state.buffering": "Buffering…",
  "post.video.error.network":
    "The video could not be downloaded. Check the connection and try again.",
  "post.video.error.decode":
    "The video downloaded but could not be decoded. It may be damaged.",
  "post.video.error.unsupported":
    "This video format cannot be played here. Open the original post to watch it.",
  "post.video.error.aborted": "Loading the video was stopped.",
  "post.video.error.expired":
    "The video link has expired. Refresh the feed to get a fresh one.",
  // Connection area in the top bar.
  "connection.status": "Connection status",
  "connection.statusLabel": "Status",
  "connection.test": "Test Connection",
  "connection.testing": "Testing…",
  "connection.testAgain": "Test again",
  "connection.details": "Connection details",
  "connection.latency": "Latency",
  "connection.lastChecked": "Last checked",
  "connection.lastSuccess": "Last successful request",
  // Distinct from `connection.latency`: in a failed state the chip shows no
  // latency at all, because the old figure did not belong to the failed
  // request. The popover can still report it, labelled for what it is.
  "connection.lastSuccessLatency": "Last successful latency",
  "connection.monitoring": "Automatic connection monitoring",
  "connection.monitoring.desc":
    "Re-checks the connection every few minutes while the window is visible. Never while minimized.",
  "connection.lastFailure": "Last issue",
  "connection.account": "Account",
  "connection.provider": "Provider",
  "connection.refresh": "Refresh",
  "connection.refreshing": "Refreshing…",
  // Promoted content is excluded at source and filtered again defensively.
  // This is a statement of protection, never a control — there is deliberately
  // no way to turn it off.
  "feed.promotedBlocked": "Promoted posts blocked",
  "feed.promotedBlocked.desc":
    "Ads are excluded when the timeline is requested, and any that slip through are filtered out. This cannot be switched off.",
  // Genuine provider-operation stages. No percentages: the backend cannot
  // report progress, and an invented bar would be a lie about what is known.
  "progress.stage.checkingSession": "Checking session",
  "progress.stage.startingProvider": "Starting provider",
  "progress.stage.requesting": "Requesting data",
  "progress.stage.paging": "X is paging through results",
  "progress.stage.receiving": "Receiving response",
  "progress.stage.parsing": "Parsing response",
  "progress.stage.saving": "Saving session data",
  "progress.stage.preparing": "Preparing results",
  "progress.stage.complete": "Complete",
  "progress.slow": "X is taking longer than usual.",
  "progress.elapsed": "{seconds}s",
  "progress.loaded": "{count} loaded",
  "progress.cancel": "Cancel",
  "progress.retry": "Retry",
  "progress.loadFullList": "Load full list",
  "progress.loadMore": "Load more",
  "feed.loadMoreFailed": "Could not load older posts",
  "progress.loadingMore": "Loading more…",
  "progress.noMore": "That is everything X returned.",
  "post.video.error.upstream":
    "X did not send the video. This is usually temporary — try again shortly.",
  "post.video.error.proxyUnavailable": "Video is unavailable this session.",
  "post.video.error.proxyUnavailable.desc":
    "The local video service could not start, so videos cannot be played. Restarting Focus Feed Next usually fixes it.",
  "post.video.error.unknown": "The video could not be played.",
  "post.video.retry": "Retry video",
  "post.video.play": "Play",
  "post.video.pause": "Pause",
  "post.video.mute": "Mute",
  "post.video.unmute": "Unmute",
  "post.video.fullscreen": "Full screen",
  "post.video.loop": "Loop",
  "post.video.speed": "Playback speed",

  // -- feed ------------------------------------------------------------------
  "feed.newPosts.zero": "No new posts",
  "feed.newPosts.one": "Show {count} new post",
  "feed.newPosts.two": "Show {count} new posts",
  "feed.newPosts.few": "Show {count} new posts",
  "feed.newPosts.many": "Show {count} new posts",
  "feed.newPosts.other": "Show {count} new posts",
  "feed.refresh": "Refresh",
  "feed.refreshing": "Refreshing…",
  "feed.loading": "Loading posts…",
  "feed.loadingMore": "Loading more posts…",
  "feed.endOfFeed": "You have reached the end of this feed",
  "feed.cached": "Cached",
  "feed.cached.desc": "Shown from this machine while a refresh runs",
  "feed.updated": "Updated {time}",
  "feed.neverUpdated": "Never refreshed",
  "feed.empty.title": "Nothing to read here",
  "feed.empty.hint": "Turn a filter off, or refresh. Nothing has been deleted.",
  "feed.error.title": "Live refresh failed",
  "feed.error.repair":
    "Locally cached posts are shown instead. Live synchronization is temporarily unavailable.",
  "feed.markAllRead": "Mark everything as read",
  "feed.backToTop": "Back to top",
  "feed.filter.noPromoted": "No promoted",
  "feed.filter.noReposts": "No reposts",
  "feed.filter.unreadOnly": "Unread only",
  "feed.filter.images": "Images",
  "feed.filter.videos": "Videos",
  "feed.filter.textOnly": "Text only",
  "feed.filter.more": "More",
  "feed.filter.advanced": "Advanced filters",
  "feed.filter.close": "Close filters",
  "feed.filter.hideRead": "Hide posts I have read",
  "feed.filter.hidePromoted": "Hide promoted posts",
  "feed.filter.hidePromoted.desc":
    "Advertising is filtered before it reaches the feed",
  "feed.filter.maxAge": "Maximum age",
  "feed.filter.any": "Any",
  "feed.filter.anyTime": "Any time",
  "feed.filter.hours6": "6 hours",
  "feed.filter.hours24": "24 hours",
  "feed.filter.days3": "3 days",
  "feed.filter.week1": "1 week",
  "feed.filter.reset": "Reset all filters",
  "feed.filter.note":
    "Filters only change what is shown. Nothing is deleted — turning a filter off brings posts straight back.",
  "feed.filter.activeCount": "{count} active",

  // -- originals -------------------------------------------------------------
  "originals.title": "Originals",
  "originals.subtitle":
    "What the accounts you follow wrote themselves — reposts left out, quotes kept",
  "originals.empty.title": "Nothing written yet",
  "originals.empty.hint":
    "Everything in the timeline so far was reposted. Refresh, or read the Following feed.",

  // -- people you follow -----------------------------------------------------
  "people.title": "People you follow",
  "people.subtitle": "Everyone this account follows on X, organised locally",
  "people.search": "Find someone…",
  "people.search.aria": "Search the people you follow",
  "people.count.zero": "No accounts",
  "people.count.one": "{count} account",
  "people.count.two": "{count} accounts",
  "people.count.few": "{count} accounts",
  "people.count.many": "{count} accounts",
  "people.count.other": "{count} accounts",
  "people.showing": "Showing {shown} of {total}",
  "people.loading": "Loading the people you follow…",
  "people.empty.title": "No accounts found",
  "people.empty.hint":
    "Refresh the feed to discover the accounts this session follows.",
  "people.noMatch.title": "Nobody matches that search",
  "people.noMatch.hint": "Try a shorter term, or clear the search.",
  "people.pin": "Pin {name}",
  "people.unpin": "Unpin {name}",
  "people.pinned": "Pinned",
  "people.mute": "Mute {name}",
  "people.unmute": "Unmute {name}",
  "people.muted": "Muted",
  "people.addToGroup": "Add to list…",
  "people.addToGroup.aria": "Add {name} to a list",
  "people.repostRule": "Repost rule for {name}",
  "people.repostRule.global": "Reposts: global rule",
  "people.repostRule.always": "Reposts: always show",
  "people.repostRule.never": "Reposts: never show",
  "people.readOnlyNote":
    "Focus Feed Next is read-focused: other account-changing actions stay disabled by default. Pins, lists, mute and repost rules stay on this machine.",
  "people.unfollowToggle": "Allow Unfollow actions",
  "people.unfollowToggle.desc":
    "Enabled by default. Shows a confirmation button beside each person; switching it off hides the account-changing control.",
  "people.unfollowUnavailable":
    "Unfollow is unavailable with the current provider.",
  "people.unfollowOn":
    "Pins, lists, mute and repost rules are local. Unfollow is switched on and does change your X account.",

  // -- profile ---------------------------------------------------------------
  "profile.title": "Profile",
  "profile.bio": "Bio",
  "profile.noBio": "This account has no bio.",
  "profile.joined": "Joined {date}",
  "profile.location": "Location",
  "profile.website": "Website",
  "profile.verified": "Verified account",
  "profile.followers.label": "Followers",
  "profile.followers.zero": "No followers",
  "profile.followers.one": "{count} follower",
  "profile.followers.two": "{count} followers",
  "profile.followers.few": "{count} followers",
  "profile.followers.many": "{count} followers",
  "profile.followers.other": "{count} followers",
  "profile.following.label": "Following",
  "profile.following.zero": "Following nobody",
  "profile.following.one": "Following {count} account",
  "profile.following.two": "Following {count} accounts",
  "profile.following.few": "Following {count} accounts",
  "profile.following.many": "Following {count} accounts",
  "profile.following.other": "Following {count} accounts",
  "profile.posts.label": "Posts",
  "profile.posts.zero": "No posts",
  "profile.posts.one": "{count} post",
  "profile.posts.two": "{count} posts",
  "profile.posts.few": "{count} posts",
  "profile.posts.many": "{count} posts",
  "profile.posts.other": "{count} posts",
  "profile.back": "Back",
  "profile.tab.posts": "Posts",
  "profile.tab.originals": "Originals",
  "profile.tab.media": "Media",
  "profile.tabs.aria": "Which of this account's posts to show",
  "profile.loading": "Loading the profile…",
  "profile.empty.title": "No posts cached for this account",
  "profile.empty.hint": "Refresh the feed to pull in recent posts.",
  "profile.unavailable.title": "This profile could not be loaded",
  "profile.unavailable.hint":
    "The account may be protected, suspended, or the session may have expired.",
  "profile.pinnedPost": "Pinned post",

  // -- bookmarks -------------------------------------------------------------
  "bookmarks.title": "Bookmarks",
  "bookmarks.subtitle": "Bookmarks from the connected X account",
  "bookmarks.empty.title": "No bookmarks found",
  "bookmarks.empty.hint":
    "Bookmark a post on X and it will appear here after a refresh. You can remove it from X from the three-dot menu.",
  "bookmarks.readOnlyNote":
    "Removing a bookmark here also removes it from the connected X account after confirmation.",
  "bookmarks.discovered": "{count} discovered",
  "bookmarks.syncing": "Syncing…",
  "bookmarks.complete": "Complete",
  "bookmarks.sessionOnly": "This run",
  "bookmarks.refreshFailed": "Bookmark refresh failed",
  "bookmarks.loadFailed": "Bookmarks could not be loaded",
  "bookmarks.navigation.oldest": "Oldest",
  "bookmarks.navigation.older": "Older",
  "bookmarks.navigation.newer": "Newer",
  "bookmarks.navigation.newest": "Newest",

  // -- local library ---------------------------------------------------------

  // -- groups ----------------------------------------------------------------
  "groups.title": "Lists",
  "groups.subtitle":
    "Your own topic lists. Lists never change who you follow on X.",
  "groups.new": "New list",
  "groups.create": "Create list",
  "groups.createTitle": "Create a list",
  "groups.name": "List name",
  "groups.namePlaceholder": "List name, for example AI",
  "groups.colour": "Colour",
  "groups.colourOption": "Colour {colour}",
  "groups.delete": "Delete {name}",
  "groups.members": "Members",
  "groups.members.zero": "No members",
  "groups.members.one": "{count} member",
  "groups.members.two": "{count} members",
  "groups.members.few": "{count} members",
  "groups.members.many": "{count} members",
  "groups.members.other": "{count} members",
  // "known accounts" was the wrong word and the wrong data: it meant every
  // author the app had ever seen, including people the reader does not follow.
  "groups.membersOf": "{count} of {total} accounts you follow",
  "groups.postsInGroup": "Posts in this list",
  "groups.empty.title": "No lists yet",
  "groups.empty.hint":
    "Lists let you read one topic at a time without touching your X following list.",
  "groups.posts.empty.title": "No posts from this list yet",
  "groups.posts.empty.hint":
    "Add members above, or refresh the Following feed.",

  // -- X lists ---------------------------------------------------------------
  "lists.title": "Lists",
  "lists.subtitle": "Timelines from your X Lists",
  "lists.members.zero": "No members",
  "lists.members.one": "{count} member",
  "lists.members.two": "{count} members",
  "lists.members.few": "{count} members",
  "lists.members.many": "{count} members",
  "lists.members.other": "{count} members",
  "lists.loading": "Loading lists…",
  "lists.empty.title": "No lists available",
  "lists.empty.hint":
    "Lists come from the connected X account through the active provider.",
  "lists.choose.title": "Choose a list",
  "lists.choose.hint": "Select a list above to load its timeline.",
  "lists.posts.empty.title": "This list has no cached posts yet",
  "lists.posts.empty.hint": "Refresh to load its timeline.",
  "lists.new": "New list",
  "lists.createTitle": "Create a list",
  "lists.create": "Create list",
  "lists.emptySidebar": "Create your first list",

  // -- pinned accounts -------------------------------------------------------
  "pinned.title": "Pinned accounts",
  "pinned.subtitle": "Posts from these people only",
  "pinned.recentPosts": "Recent posts",
  "pinned.unpin": "Unpin {name}",
  "pinned.empty.title": "No pinned accounts",
  "pinned.empty.hint":
    "Pin accounts from the people you follow to give them a dedicated, quiet view.",
  "pinned.posts.empty.title": "No cached posts from these accounts yet",
  "pinned.posts.empty.hint": "Open the Following feed to pull in more posts.",

  // -- home ------------------------------------------------------------------
  "home.title": "Home",
  "home.lastSync": "Last synchronized {time}",
  "home.neverSynced": "No synchronization yet",
  "home.openFeed": "Open feed",
  "home.account.unavailable": "Account unavailable",
  "home.provider.title": "Session status",
  "home.provider.activeProvider": "Active provider",
  "home.provider.backend": "Backend",
  "home.provider.twitterCli": "twitter-cli",
  "home.provider.agentReach": "Agent Reach",
  "home.provider.checking": "Checking…",
  "home.provider.openDiagnostics": "Open diagnostics",
  "home.stat.unread": "Unread posts",
  "home.stat.new": "New since last read",
  "home.stat.readToday": "Read today",
  "home.stat.saved": "Saved posts",
  "home.stat.pinned": "Pinned accounts",
  "home.stat.cached": "Posts in this session",
  "home.pinned.title": "Pinned accounts",
  "home.pinned.subtitle": "Quick access to the people you never want to miss",
  "home.pinned.viewAll": "View all",
  "home.pinned.empty":
    "No pinned accounts yet. Pin someone from the people you follow.",
  "home.groups.title": "Custom lists",
  "home.groups.subtitle": "Your own topic lists, stored locally",
  "home.groups.manage": "Manage",
  "home.groups.empty": "No lists yet.",
  "home.activity.title": "Recent reading activity",
  "home.activity.readToday": "Read today: {count}",
  "home.activity.empty.title": "No reading activity yet",
  "home.activity.empty.hint":
    "Posts are marked read once they stay on screen for a moment.",
  "home.quickActions.title": "Quick actions",
  "home.quick.followingFeed": "Following feed",
  "home.quick.focusFeed": "Focus Feed",
  "home.quick.people": "People you follow",
  "home.quick.healthCheck": "Run health check",
  "home.quick.aboutBackend": "About the backend",

  // -- diagnostics -----------------------------------------------------------
  "diagnostics.title": "Diagnostics",
  "diagnostics.subtitle": "Everything about the data path, in plain language",
  "diagnostics.runHealthCheck": "Run health check",
  "diagnostics.running": "Running…",
  "diagnostics.dataPath.title": "Active data path",
  "diagnostics.field.provider": "Provider in use",
  "diagnostics.field.backend": "X backend",
  "diagnostics.field.authenticated": "Authenticated",
  "diagnostics.field.twitterCli": "twitter-cli",
  "diagnostics.field.agentReach": "Agent Reach",
  "diagnostics.field.lastCheck": "Last health check",
  "diagnostics.field.cachedPosts": "Posts held this session",
  "diagnostics.field.unread": "Unread",
  "diagnostics.field.saved": "Saved",
  "diagnostics.field.hidden": "Hidden",
  "diagnostics.field.lastSync": "Last sync",
  "diagnostics.field.dataDir": "Data folder",
  "diagnostics.value.notChecked": "Not checked yet",
  "diagnostics.value.notInstalled": "Not installed",
  "diagnostics.storage.title": "Storage",
  "diagnostics.reconnect": "Reconnect provider",
  "diagnostics.clearCache": "Clear session data",
  "diagnostics.openDataFolder": "Open data folder",
  "diagnostics.credentials.title": "Credentials",
  "diagnostics.credentials.subtitle":
    "Presence only. Focus Feed Next never reads, stores or logs these values.",
  "diagnostics.credentials.set": "Set",
  "diagnostics.credentials.notSet": "Not set",
  "diagnostics.credentials.hint":
    "To load live posts, add auth_token and ct0 in Settings, then press Reconnect provider.",
  "diagnostics.channels.title": "Agent Reach channels",
  "diagnostics.channels.notInstalled": "Agent Reach is not installed",
  "diagnostics.channels.empty": "No channel report yet. Run a health check.",
  "diagnostics.table.channel": "Channel",
  "diagnostics.table.status": "Status",
  "diagnostics.table.backend": "Active backend",
  "diagnostics.status.ok": "Working",
  "diagnostics.status.warn": "Degraded",
  "diagnostics.status.error": "Failing",
  "diagnostics.status.off": "Off",
  "diagnostics.report.title": "Sanitized diagnostic report",
  "diagnostics.report.subtitle":
    "Safe to share — cookies and tokens can never appear here",
  "diagnostics.report.generate": "Generate",
  "diagnostics.report.copy": "Copy",
  "diagnostics.report.copied": "Copied",
  "diagnostics.report.placeholder":
    "Press Generate to build a report you can paste into a bug report…",
  "diagnostics.report.aria": "Diagnostic report",

  // -- settings --------------------------------------------------------------
  "settings.title": "Settings",
  "settings.subtitle": "Everything is stored locally on this machine",
  "settings.appearance.title": "Appearance",
  "settings.theme": "Theme",
  "settings.theme.dark": "Dark",
  "settings.theme.light": "Light",
  "settings.theme.system": "Match the system",
  "settings.density": "Density",
  "settings.density.comfortable": "Comfortable",
  "settings.density.compact": "Compact",
  "settings.postDisplay.title": "Post display",
  "settings.timestampStyle": "Timestamp style",
  "settings.timestampStyle.relative": "Relative",
  "settings.timestampStyle.absolute": "Date and time",
  "settings.collapseLongPosts": "Collapse long posts",
  "settings.collapseLongPosts.desc":
    "Long posts show a Show more control instead of filling the screen",
  "settings.reading.title": "Reading",
  "settings.markReadAfter": "Mark as read after",
  "settings.markReadAfter.desc":
    "How long a post must stay on screen. A downloaded post is never counted as read.",
  "settings.dwell.manual": "Never (manual only)",
  "settings.dwell.halfSecond": "Half a second",
  "settings.dwell.oneSecond": "One second",
  "settings.dwell.twoSeconds": "Two seconds",
  "settings.dwell.fourSeconds": "Four seconds",
  "settings.video.title": "Video player",
  "settings.video.defaultSpeed": "Default playback speed",
  "settings.video.qualityNote":
    "Quality options appear only when the source actually exposes multiple variants. Otherwise the player shows an honest Auto.",
  "settings.mutedWords.title": "Muted words",
  "settings.mutedWords.placeholder": "Add a word or phrase to mute…",
  "settings.mutedWords.aria": "Muted word",
  "settings.mutedWords.add": "Add",
  "settings.mutedWords.unmute": "Unmute {word}",
  "settings.mutedWords.empty": "No muted words yet.",
  "settings.sync.title": "Synchronization",
  "settings.sync.autoRefresh": "Automatic refresh",
  "settings.sync.autoRefresh.desc":
    "Only while the app is open. There is no background crawler.",
  "settings.sync.manual": "Manual only",
  "settings.sync.every10": "Every 10 minutes",
  "settings.sync.every15": "Every 15 minutes",
  "settings.sync.every30": "Every 30 minutes",
  "settings.connection.title": "X connection",
  "settings.language.title": "Language",
  "settings.language.label": "Interface language",
  "settings.language.system": "Match the system",
  "settings.language.arabic": "العربية",
  "settings.language.english": "English",
  "settings.language.note":
    "Post text always renders in its own direction, so Arabic posts read right to left even in the English interface.",
  "settings.privacy.title": "Privacy and data",
  "settings.privacy.p1":
    "All data stays on this machine. There is no analytics, no telemetry, no remote logging and no cloud sync.",
  "settings.privacy.p2":
    "Session credentials are never written to the database, the settings file, logs, screenshots or diagnostic reports.",
  "settings.privacy.p3":
    "This release is read-focused toward X: posting, replying, liking, reposting and following are blocked in the backend. Removing a bookmark is available only from Bookmarks after confirmation.",
  "settings.about.title": "About",
  "settings.about.p1": "Focus Feed Next — a standalone desktop reader for X.",
  "settings.about.p2":
    "Built with Tauri, React, TypeScript and SQLite. Data is retrieved through Agent Reach and twitter-cli, never the paid X API.",
  "settings.about.agentReach": "About Agent Reach",

  // -- updates ---------------------------------------------------------------
  "updates.title": "Updates",
  "updates.currentVersion": "Current version",
  "updates.channel": "Update channel",
  "updates.channel.stable": "Stable",
  "updates.channel.beta": "Beta",
  "updates.lastChecked": "Last checked",
  "updates.never": "Never",
  "updates.check": "Check for updates",
  "updates.checking": "Checking…",
  "updates.upToDate": "Focus Feed Next is up to date.",
  "updates.available": "Version {version} is available.",
  "updates.download": "Download update",
  "updates.downloading": "Downloading…",
  "updates.progress": "{percent} downloaded",
  "updates.installAndRestart": "Install and restart",
  "updates.installing": "Installing…",
  "updates.automatic": "Check automatically",
  "updates.automatic.desc":
    "Checks once when the app starts. Nothing is installed without your confirmation.",
  "updates.releaseNotes": "Release notes",
  "updates.notConfigured": "Updates are not configured",
  "updates.notConfigured.desc":
    "This build has no update endpoint, so it cannot update itself. Install a new version manually.",
  "updates.failed": "The update check failed.",
  "updates.failed.repair":
    "Check the network connection and try again. You can always install a new version manually.",

  // -- errors ----------------------------------------------------------------
  "error.tool_missing.title": "twitter-cli is not installed",
  "error.tool_missing.repair":
    "Install twitter-cli, then open Diagnostics and press Reconnect provider.",
  "error.not_authenticated.title": "No X session is connected",
  "error.not_authenticated.repair":
    "Open Settings, add the auth_token and ct0 values from a burner X account, then press Test connection.",
  "error.cookie_expired.title": "The X session has expired",
  "error.cookie_expired.repair":
    "Sign in again on the burner account and replace auth_token and ct0 in Settings.",
  "error.rate_limited.title": "X is rate limiting this session",
  "error.rate_limited.repair":
    "Wait a few minutes before refreshing. Repeated manual refreshes make the limit last longer.",
  "error.api_error.title": "X returned an error",
  "error.api_error.repair":
    "Try again in a moment. If it keeps happening, run a health check in Diagnostics.",
  "error.schema_changed.title": "The data format from twitter-cli changed",
  "error.schema_changed.repair":
    "Update twitter-cli. Focus Feed Next stopped rather than show you an incomplete feed.",
  "error.empty_response.title": "The response contained nothing",
  "error.empty_response.repair":
    "The source returned no data. Refresh once; if it repeats, check the session in Diagnostics.",
  "error.process_timeout.title": "The request took too long",
  "error.process_timeout.repair":
    "The backend did not answer in time. Check the network connection and try again.",
  "error.process_crashed.title": "The backend stopped unexpectedly",
  "error.process_crashed.repair":
    "Run a health check in Diagnostics to see whether twitter-cli is still working.",
  "error.invalid_json.title": "The response could not be read",
  "error.invalid_json.repair":
    "twitter-cli returned something unreadable. Update it, then run a health check.",
  "error.database_error.title": "The local database could not be used",
  "error.database_error.repair":
    "Close and reopen the app. If the problem remains, clear the session data from Diagnostics.",
  "error.media_unavailable.title": "This media cannot be loaded",
  "error.media_unavailable.repair":
    "Open the original post on X to view it there.",
  "error.network_unavailable.title": "No network connection",
  "error.network_unavailable.repair":
    "Reconnect to the internet, then refresh. Saved posts stay available offline.",
  "error.provider_unavailable.title": "No data source is available",
  "error.provider_unavailable.repair":
    "Connect an X session in Settings, then refresh.",
  "error.agent_reach_unavailable.title": "Agent Reach is not available",
  "error.agent_reach_unavailable.repair":
    "Agent Reach is only used for health checks and repair advice. Install it to see channel diagnostics.",
  "error.blocked_operation.title": "This action is blocked by design",
  "error.blocked_operation.repair":
    "Focus Feed Next is read-focused toward X. Posting, liking, reposting, muting and blocking are refused by the backend, account-changing actions are off by default, and bookmark removal requires explicit confirmation.",
  "error.unknown.title": "Something went wrong",
  "error.unknown.repair":
    "Try again. If it repeats, generate a diagnostic report from Diagnostics.",

  // -- generic states --------------------------------------------------------
  "state.offline": "You are offline",
  "state.offline.desc":
    "Live posts need a network connection. Saved posts and the local library still work.",
  "state.loading": "Loading…",
  "state.loading.desc": "Fetching content from the active session.",
  "state.empty": "Nothing here yet",
  "state.empty.desc": "There is no content to show for this view.",
  "state.retry": "Try again",
  "state.retry.desc": "The last attempt failed. Retrying is safe.",
  "state.noLiveSession": "No live X session",
  "state.noLiveSession.desc":
    "Focus Feed Next never invents posts. Connect an X session in Settings to load real content.",
  "state.error": "Something went wrong",
  "state.error.desc": "The details are below, along with what to do next.",

  // -- accessibility ---------------------------------------------------------
  "a11y.mainNavigation": "Main navigation",
  "a11y.mainContent": "Main content",
  "a11y.skipToContent": "Skip to content",
  "a11y.currentPage": "Current page",
  "a11y.sessionStatus": "Session status",
  "a11y.unreadBadge": "{count} unread",
  "a11y.postCard": "Post by {name}",
  "a11y.readState": "Read state",
  "a11y.closeDialog": "Close dialog",
  "a11y.imageViewer": "Image viewer",
  "a11y.previousImage": "Previous image",
  "a11y.nextImage": "Next image",
  "a11y.zoomIn": "Zoom in",
  "a11y.zoomOut": "Zoom out",
  "a11y.fitToScreen": "Fit to screen",
  "a11y.imageCounter": "Image {index} of {total}",
  "a11y.video.play": "Play",
  "a11y.video.pause": "Pause",
  "a11y.video.mute": "Mute",
  "a11y.video.unmute": "Unmute",
  "a11y.video.seek": "Seek",
  "a11y.video.loop": "Toggle loop",
  "a11y.video.speed": "Playback speed",
  "a11y.video.quality": "Video quality",
  "a11y.video.fullscreen": "Full screen",
  "a11y.loading": "Loading",
  "a11y.required": "Required",

  // -- common ----------------------------------------------------------------
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.save": "Save",
  "common.retry": "Retry",
  "common.refresh": "Refresh",
  "common.clear": "Clear",
  "common.all": "All",
  "common.none": "None",
  "common.yes": "Yes",
  "common.no": "No",
  "common.unknown": "Unknown",
  "common.never": "Never",
  "common.add": "Add",
  "common.remove": "Remove",
  "common.delete": "Delete",
  "common.edit": "Edit",
  "common.back": "Back",
  "common.next": "Next",
  "common.previous": "Previous",
  "common.open": "Open",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.done": "Done",
  "common.on": "On",
  "common.off": "Off",
  "common.more": "More",
  "common.less": "Less",
  "common.apply": "Apply",
  "common.reset": "Reset",
  "common.loading": "Loading…",
  "common.notAvailable": "Not available",

  // -- group editing (correction sprint) --------------------------------------
  "groups.editMembers": "Edit members",
  "groups.doneEditing": "Done",
  "groups.saveMembers": "Save members",
  "groups.saving": "Saving…",
  "groups.saveFailed": "Could not save the member list",
  "groups.rename": "Rename {name}",
  "groups.renameTitle": "Rename list",
  "groups.deleteTitle": "Delete this list?",
  "groups.deleteBody":
    "“{name}” and its member list are removed from this app. Nothing changes on X — you keep following everyone in it.",
  "groups.candidates": "Accounts you follow",
  "groups.candidatesHint":
    "Only accounts you currently follow on X can be added to a list.",
  "groups.candidatesLoading": "Loading the accounts you follow…",
  "groups.candidatesFailed": "Could not load the accounts you follow",
  "groups.noCandidates.title": "Nothing to add yet",
  "groups.noCandidates.hint":
    "Open People you follow to load your following list, then come back here.",
  "groups.notFollowed": "Not followed",
  "groups.notFollowedHint":
    "Still a member of this list, but you no longer follow this account on X.",
  "groups.filterMembers": "Filter accounts…",
  "groups.selected": "{count} selected",
  "groups.discard": "Discard changes",
  "groups.unsavedMembers": "You have unsaved member changes.",
  "groups.selectPrompt.title": "Choose a list",
  "groups.selectPrompt.hint":
    "Pick a list above to read it or edit who is in it.",

  // -- feed pages (correction sprint) -----------------------------------------
  "following.title": "Following",
  "following.subtitle": "Chronological posts from accounts you follow",
  "following.empty.title": "No posts match your filters",
  "following.empty.hint":
    "Try turning off a filter — nothing has been deleted.",
  "focus.title": "Focus Feed",
  "focus.subtitle": "A stricter view: no ads, no reposts, unread only",
  "focus.empty.title": "Focus Feed is clear",
  "focus.empty.hint":
    "Everything matching your focus rules has been read. Loosen a rule to see more.",

  // ===========================================================================
  // Correction sprint — account identity, internal profile, people, search
  //
  // Appended as one region so the two catalogs stay easy to diff. Every key
  // below exists in ar.ts in the same order with the same placeholders.
  // ===========================================================================

  // -- account actions -------------------------------------------------------
  "account.follow": "Follow",
  "account.follow.aria": "Follow {handle}",
  "account.unfollow": "Unfollow",
  "account.unfollow.aria": "Unfollow {handle}",
  "account.following": "Following",
  // The relationship is genuinely unknown until the following list has been
  // read. Guessing from "this author is in the cache" would be a lie.
  "account.checking": "Checking…",
  "account.checking.aria": "Checking whether you follow {handle}",
  "account.recheck": "Check again",
  "account.recheck.aria": "Check again whether you follow {handle}",
  "account.unknown": "Whether you follow this account is not known yet.",
  "account.working": "Working…",
  "account.busy": "Another account change is still running.",
  "account.unfollow.confirm.title": "Unfollow this account?",
  "account.unfollow.confirm.body":
    "Their posts stop appearing in your feed. This changes your real X account, and Focus Feed Next cannot undo it — you would have to follow them again on X.",
  "account.unfollow.confirm.action": "Unfollow {handle}",
  "account.unfollow.failed": "{handle} could not be unfollowed.",
  "account.follow.failed": "{handle} could not be followed.",
  "account.noAutoRetry":
    "Nothing was retried. Try again yourself if you want to.",

  // -- internal profile ------------------------------------------------------
  "profile.filter.videos": "Videos",
  "profile.filter.photos": "Photos",
  "profile.filter.latest": "Latest first",
  "profile.loadMore": "Load more",
  "profile.loadingPosts": "Loading posts…",
  "profile.stopLoading": "Stop loading",
  "profile.postsFailed": "The posts of this account could not be loaded.",
  "profile.noMore": "That is everything loaded for this account.",
  "profile.loaded.zero": "No posts loaded",
  "profile.loaded.one": "{count} post loaded",
  "profile.loaded.two": "{count} posts loaded",
  "profile.loaded.few": "{count} posts loaded",
  "profile.loaded.many": "{count} posts loaded",
  "profile.loaded.other": "{count} posts loaded",

  // -- people you follow, loaded progressively -------------------------------

  // -- media: viewer and player, correction sprint -----------------------------
  // `a11y.zoomLevel` and `a11y.actualSize` were referenced by the image viewer
  // but never added to either catalogue, so both controls announced their own
  // key to a screen reader.
  "a11y.zoomLevel": "Zoom level",
  "a11y.actualSize": "Actual size",
  "a11y.video.volume": "Volume",
  "a11y.video.exitFullscreen": "Exit full screen",
  "post.video.volume": "Volume",
  "post.video.exitFullscreen": "Exit full screen",
  "post.video.controls": "Video controls",
  "post.video.quality": "Quality",
  "post.video.quality.best": "Best available",
  // Shown in place of a menu when the source offers exactly one stream, which
  // is the case for every post today. An empty menu would imply otherwise.
  "post.video.quality.only": "Only one quality available",
  "post.video.quality.switching": "Switching quality…",
  "post.video.quality.failed": "That quality would not play. Went back a step.",
  "post.video.quality.bitrate": "{kbps} kbps",

  // -- shared state components (src/components/state) ------------------------
  "state.partial": "Some of this could not be loaded",
  "state.partial.desc":
    "Part of the request failed. What did arrive is below and is still correct.",
  "state.partial.showing": "Nothing already loaded has been discarded.",
  "state.refreshFailed": "The refresh did not go through",
  "state.refreshFailed.desc":
    "What is on screen is what loaded earlier. It has not been thrown away.",
  "state.authExpired": "The X session has expired",
  "state.authExpired.desc":
    "X rejected the stored session, so nothing new can be loaded until it is replaced.",
  "state.authExpired.action": "Open Settings",
  "state.rateLimited": "X is rate limiting this session",
  "state.rateLimited.desc":
    "X is refusing further requests for now. Waiting is the only thing that helps; retrying sooner makes it last longer.",
  "state.unsupported": "This is not something the backend can do",
  "state.unsupported.desc":
    "The installed provider has no command for it, so there is nothing to retry.",

  // -- group timeline (correction sprint) -------------------------------------
  "groups.loadMorePosts": "Load more accounts",
  "groups.loadingPosts": "Loading…",
  "groups.allMembersLoaded": "All members loaded",
  "groups.membersLoaded": "{count} of {total} members loaded",
  "groups.someMembersFailed":
    "These accounts could not be read this time: {names}. Everything else is shown.",

  // -- settings sections and appearance (correction sprint) -------------------
  "settings.saving": "Saving…",
  "settings.saved": "Saved",
  "settings.unsaved": "Unsaved changes",
  "settings.unsavedElsewhere":
    "Another section has unsaved changes. Save or cancel it first.",
  "settings.resetSection": "Reset this section",
  "settings.saveFailed": "Could not save",
  "settings.saveFailed.desc":
    "The setting applies for this run, but it could not be written and will not survive a restart.",
  "settings.appearance.desc":
    "Preview applies immediately. Nothing is stored until you save.",
  "appearance.themeDefault": "Theme",
  "appearance.theme.dark": "Dark",
  "appearance.theme.oled": "OLED near-black",
  "appearance.theme.light": "Light",
  "appearance.theme.system": "Match the system",
  "appearance.custom": "Custom colours",
  "appearance.colors": "Colours",
  "appearance.colors.desc":
    "Leave a colour empty to use the theme's own value.",
  "appearance.color.background": "Background",
  "appearance.color.surface": "Card surface",
  "appearance.color.elevated": "Elevated surface",
  "appearance.color.border": "Border",
  "appearance.color.accent": "Accent",
  "appearance.color.mediaBackground": "Media background",
  "appearance.radius": "Corner radius",
  "appearance.radius.desc": "How rounded cards and controls are.",
  "appearance.shadow": "Shadow",
  "appearance.shadow.none": "None",
  "appearance.shadow.soft": "Soft",
  "appearance.shadow.strong": "Strong",
  "appearance.textContrast": "Text contrast",
  "appearance.textContrast.desc":
    "Raises body text against the background without changing the palette.",
  "appearance.preview": "Preview",
  "appearance.preview.desc": "How a post card looks with these values.",
  "appearance.preview.sample":
    "The quick brown fox jumps over the lazy dog. النص العربي يظهر باتجاهه الصحيح.",
  "appearance.preview.meta": "Preview only — not a real post",
  "appearance.reset": "Reset appearance",
  "appearance.warn.title": "Hard to read",
  "appearance.warn.ratio": "Contrast ratio {ratio}",
  "appearance.warn.allowed": "At least {ratio} is recommended",

  // -- settings: the sections the correction sprint added ----------------------
  "settings.monitoring.title": "Connection",
  "settings.monitoring.autoCheck": "Check the connection automatically",
  "settings.monitoring.autoCheck.desc":
    "While the window is open, re-check the X session on a timer so a lapsed session is reported rather than discovered from a failed refresh. Paused while the window is minimized.",
  "settings.monitoring.interval": "How often",
  "settings.monitoring.minutes.zero": "Never",
  "settings.monitoring.minutes.one": "Every minute",
  "settings.monitoring.minutes.two": "Every {count} minutes",
  "settings.monitoring.minutes.few": "Every {count} minutes",
  "settings.monitoring.minutes.many": "Every {count} minutes",
  "settings.monitoring.minutes.other": "Every {count} minutes",
  "settings.pageOpen.title": "When a page opens",
  "settings.pageOpen.desc":
    "What happens the moment you open a page. Reset clears that page's loaded data only — it never signs you out or removes credentials.",
  "settings.pageOpen.global": "Every page",
  "settings.pageOpen.perPage": "Per page",
  "settings.pageOpen.useDefault": "Use the default",
  "settings.pageOpen.off": "Show what is loaded",
  "settings.pageOpen.refresh": "Refresh in the background",
  "settings.pageOpen.reset": "Reset page data and reload",
  "settings.startup.title": "At startup",
  "settings.startup.desc":
    "Background work that begins once the session checks out. Both run at low priority and yield to anything you ask for.",
  "settings.startup.preloadBookmarks": "Preload bookmarks",
  "settings.startup.preloadBookmarks.desc":
    "Start fetching your X bookmarks in the background so the page is populated when you open it.",
  "settings.startup.preloadFollowing": "Preload people you follow",
  "settings.startup.preloadFollowing.desc":
    "Start traversing your following list in the background. List member choices come from this list.",
  "settings.content.title": "Reading",
  "settings.content.hideReposts": "Hide reposts by default",
  "settings.content.unreadOnly": "Show unread only by default",
  "settings.actions.title": "Account actions",
  "settings.actions.unfollow": "Allow Unfollow actions",
  "settings.actions.unfollow.desc":
    "Enabled by default, it adds an Unfollow control to People you follow. Every unfollow asks for confirmation first and cannot be undone from here. While this is off, the app refuses unfollow requests without starting any process.",
  "settings.actions.advanced": "Enable advanced account actions",
  "settings.actions.advanced.desc":
    "Reveals controls for operations beyond Follow and Unfollow. It does not grant permission: the backend still refuses anything the provider does not genuinely support, and the pinned twitter-cli build has no mute or block command.",
  "settings.video.loop": "Loop videos",
  "settings.video.loop.desc": "Replay a video when it reaches the end.",
  "settings.video.clickToggle": "Click the video to play or pause",
  "settings.video.clickToggle.desc":
    "Clicking the controls never toggles playback, only the picture itself.",
  "settings.video.gifAutoplay": "Play animated GIFs automatically",
  "settings.video.gifAutoplay.desc":
    "Only while visible, and never when the system asks for reduced motion.",
  "settings.video.offscreen": "Release video scrolled out of view",
  "settings.video.offscreen.desc":
    "Frees decoder resources and stops streaming. Position and quality are restored when it comes back.",
  "settings.video.quality": "Preferred quality",
  "settings.video.quality.best": "Best available",

  // -- fullscreen video (video sprint) ---------------------------------------
  // The fullscreen player is a different layout from the card's, so it needs a
  // name of its own: a screen reader reaching the region has no picture to go
  // on, and "Video controls" alone does not say that the window is now the
  // player.
  "a11y.video.fullscreenPlayer": "Full screen video player",
};

export default en;
