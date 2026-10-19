# Native iOS request engine provenance

Reviewed on 2026-10-10. No Python interpreter or command-line executable is bundled.

- Request shapes, operation names, query IDs, feature flags and public application
  identifier: [public-clis/twitter-cli](https://github.com/public-clis/twitter-cli),
  revision `7c634e0d396b1e7af9f63315b414925fe4f29ae7`, Apache-2.0.
  License retained as `TWITTER-CLI-LICENSE`.
- Transaction header algorithm: [Lqm1/x-client-transaction-id](https://github.com/Lqm1/x-client-transaction-id),
  revision `c061bc250e13a914b97d8c46b8aba9517efd0077`, MIT.
  Copyright and license retained as `LICENSE`.

Browser adaptation replaces Deno base64 imports with atob/btoa, replaces linkedom
with DOMParser, and bounds the ondemand fetch. The local reader.ts adds a fixed
operation set, serialized requests, rate-limit cooldown, response-body timeouts,
and one query-ID refresh for read requests. Remote bundles are parsed as text;
the application does not evaluate downloaded scripts in the isolated transport.
The official X login page itself runs its normal website scripts in its separate
browser context.

This integrates the upstream web-session technique. It does not reproduce Python
curl_cffi TLS impersonation. Successful native compilation does not establish
that X accepts this WebKit session; that requires a signed physical-device test.
