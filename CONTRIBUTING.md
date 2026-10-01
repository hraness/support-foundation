# Contributing

Use Bun 1.3.14 and Rust 1.97.1 with the rustfmt and Clippy components.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Keep the package independent from authentication, provider SDKs, product code,
and service credentials. Accounts manages products, prices, consent, and billing.
An incidental invitation must never change the product's output or exit status.
Tests use disposable state directories, never your saved invitation preferences.

## Protocol and package checks

`scripts/rust-contract.ts` derives the committed Rust protocol text, schemas,
and timing constants from the JavaScript implementation. The checks verify
these files without regenerating them and exercise both runtimes against the
same temporary state, including concurrent offers and acknowledgments.

The test-only Rust `interop` example exchanges JSON with the Bun suite. It is
not installed as a consumer executable.

`bun run check` runs TypeScript checks, Rust formatting, Clippy and tests,
JavaScript/Rust interoperability tests, and URL, state, concurrency, preference,
and command tests. It builds the package and verifies it under Node, in a
separate strict TypeScript consumer with an augmented `NODE_ENV`, and through
its browser-safe root entry.

These checks make no provider calls. Verify deployed Accounts routes and
payment configuration separately when changing their integration.

Commit the generated `dist` artifacts for immutable Git installs. Consumers
pin a reviewed tag or full commit. Deliver changes through a pull request with
the required checks passing.
