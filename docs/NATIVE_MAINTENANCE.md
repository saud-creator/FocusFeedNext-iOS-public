# Native quality maintenance

The complete 0.10.0 update remains one user-facing candidate. A successful source
check or unsigned archive does not satisfy the signed upgrade and physical-device
acceptance gates in NATIVE_ACCEPTANCE.md.

## Every change

1. Add a behavioral regression for each reproducible stability defect, including
   its ownership and cancellation boundary. Avoid tests that only mirror code.
2. Run `cargo test --workspace --locked` and the existing desktop `npm run check`
   from `source` when shared code changes. The native workflow runs both before
   its macOS job.
3. On macOS, run `bash ios-native/tools/build-native.sh check`. This generates
   matching bindings, builds the standalone native target, executes service,
   linked bridge and UIKit fixtures, and retains the xcresult.
4. Inspect the typed connection/media report for newly unbounded queues, active
   transfer/player ownership, stale-account results and leaked pending work.
   Diagnostic data must remain bounded and must not contain content or secrets.

## Before each candidate

- Record source SHA, dependency locks, Apple/Rust toolchains, SDK, version/build,
  resource hashes, test receipts and IPA checksum. Run the native archive verifier.
- Keep the older signed owner artifact and its checksum separately. Retain the
  protected original preferences database until an actual upgrade test accepts
  account access, preferences and local List membership.
- Run the affected-phone interruption, fullscreen, Arabic/accessibility and
  performance matrix in NATIVE_ACCEPTANCE.md. Record failures explicitly. Require
  zero force-quit-required media recoveries before accepting the candidate.
- Review package contents for UIKit scene wiring, bundle identity, narrow local
  transport policy, device architecture and exclusion of legacy reader fixtures.

## Weekly during active development

Review reproducible stability reports by failure provenance: registration,
listener, local queue, upstream HTTP/network, metadata and decoder. Record the
affected build/source, scenario, recovery result and regression receipt. An
upstream 429 must remain distinct from local queue exhaustion. Confirm that
automatic recovery never retries remote account mutations or restarts login.

## Monthly and around iOS updates

Review locked Cargo/npm dependencies, UniFFI generator/runtime equality, Xcode
and Rust toolchains. Change one dependency family at a time, rerun all relevant
checks, and retain rollback evidence. Do not auto-merge dependency changes.

For a major iOS beta or release, repeat sign-in, verified saved-session loading,
background/watchdog behavior, native sheets and inline/fullscreen media on the
minimum supported iOS 16 runtime/device where available and the newer supported
OS. Record simulator and physical results separately.
