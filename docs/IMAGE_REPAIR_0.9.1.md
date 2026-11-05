# Photo and profile-picture repair — 0.9.1

This repair builds on the public repository's current main branch.

- Photos and avatars have four dedicated upstream transfer slots, separate
  from the four video slots, so long video downloads cannot occupy their pool.
- A failed inline photo attempts one local registration renewal from its cached
  post. A manual retry can fall back to cached media when a provider metadata
  refresh fails. The image watchdog covers proxy queueing and transfer time.
- Failed avatars attempt one local registration renewal using active-session
  identity or cached authors, without fetching profiles from the provider.
  Initials remain readable while loading and after a final failure. Late repair
  replies cannot replace another account's picture.

The automated tests cover registration eviction, bounded retry, unchanged-source
retry, a late reply after an account change, and independent picture capacity
while every video slot is occupied. GitHub's unsigned iPhone workflow compiles
the native application and verifies the resulting IPA before uploading it.

After signing and installing with the existing bundle ID `com.focusfeed.next`
and signing identity, revisit the affected live photo and profile. Also return
to earlier cards after a long preload, open photos while video downloads, and
retry after briefly interrupting connectivity. Automated fixtures do not prove
live delivery for every provider asset or physical-iPhone acceptance.
