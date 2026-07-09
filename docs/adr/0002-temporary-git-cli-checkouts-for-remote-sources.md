# Temporary Git CLI checkouts for remote sources

Remote HTTPS Git sources are resolved by cloning the repository with the user's installed `git` CLI into a temporary checkout, scanning that checkout with the existing filesystem scanner, and removing the checkout after the command completes.

This keeps artifact discovery and installation convention-based and avoids adding a second remote-specific install path. The persisted source identity is a sanitized `git+https://...` URL plus optional ref, not the temporary checkout path.

Alternatives considered:

- Persistent local cache: faster repeat scans, but requires cache invalidation, cleanup policy, and stale-content handling.
- Node Git implementation: avoids shelling out, but adds dependency and authentication behavior that may not match users' existing Git HTTPS credential helpers.

The trade-off is that each remote command performs a fresh network clone. That is acceptable for v1 because correctness and predictable cleanup matter more than repeated scan speed.
