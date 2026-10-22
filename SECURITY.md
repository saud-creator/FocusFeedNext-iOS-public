# Security and publication privacy

Do not post passwords, session cookies, signing keys, personal account details,
HAR captures, or unredacted diagnostic files in issues or pull requests.
Use GitHub private vulnerability reporting when enabled. If it is unavailable,
request a private reporting channel without including the sensitive details.

Use a GitHub noreply email for commits. Keep local environment files, signing
material, databases and authentication exports outside version control. Ignore
rules do not remove data that has already been committed.

Before making a private repository public, inspect every branch and tag,
historical file revision, nested source archive, screenshot, release, pull
request, workflow log and downloadable artifact. Automated secret scanning is
only one part of that review; it cannot certify screenshots or account privacy.

`tools/audit-publication.py` scans reachable Git history and recursively inspects
ZIP/IPA contents with Gitleaks. It also rejects personal home-directory paths
and non-noreply commit emails. Install Gitleaks 8.30.1 or later and run:

```sh
python3 tools/audit-publication.py
```

The two credential values allowlisted in `.gitleaks.toml` are synthetic test
fixtures. The X web-client bearer constant in the reader is shared by the web
client; personal X sessions additionally require the user's private cookies.
Do not allowlist user cookies, private API keys or whole source directories.

If sensitive information entered history, keep the repository private while
remediating it. Revoke actual credentials, sanitize all affected history, and
check GitHub's retained pull-request references and cached commit views before
publication. Rewriting branch history alone does not remove every GitHub copy.

The older `source/SECURITY.md` documents a previous application architecture;
it is not a current publication clearance or a full application security audit.
