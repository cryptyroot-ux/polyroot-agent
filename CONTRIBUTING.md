# Contributing to PolyRoot

Thank you for your interest in contributing to PolyRoot! We welcome contributions to improve our autonomous Polymarket trading agent platform.

## Code of Conduct

By participating, you are expected to uphold our open source standards. Please be respectful and constructive.

## How to Contribute

1. Fork the repository and create your branch from `main`.
2. Ensure you have Node.js >= 24.0.0 and pnpm/npm installed.
3. **Set up the test database** (one-time, before running tests):
   ```bash
   # PostgreSQL must be running. Create the test DB + user:
   sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD 'postgres';"
   sudo -u postgres psql -c "CREATE DATABASE polyroot_test;"
   # Run migrations against the test DB:
   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/polyroot_test" npm run migrate:latest
   ```
   > This is required for contract tests that spin up a real Postgres (e.g. `catalyst-bus-pg.test.ts`).
4. Install dependencies: `npm install`
5. Run tests and typechecks to verify your baseline: `npm run ci`
6. Make your changes adhering to strict TypeScript settings (`verbatimModuleSyntax: true`, `exactOptionalPropertyTypes: true`).
7. Add unit, contract, or property tests for any new behavior.
8. Run `npm run ci` again to ensure zero regressions.
9. Submit a Pull Request with a clear description of the problem and solution.

## Troubleshooting: `npm run ci` fails with a Postgres connection error

Contract tests talk to a real PostgreSQL instance. A clean clone starts with no
test database, so tests fail with connection errors that look like code
failures but are not. Fix it once with the step-3 commands above.

Quick check:

```bash
docker compose ps          # is Postgres up?
psql "postgresql://postgres:postgres@localhost:5432/polyroot_test" -c '\dt'
```

If `psql` is not installed, the repo ships a Compose service — start it with
`docker compose up -d postgres` and re-run step 3.

Symptom to key on:

| Symptom                                   | Cause                  | Fix                                       |
| ----------------------------------------- | ---------------------- | ----------------------------------------- |
| `ECONNREFUSED 127.0.0.1:5432`             | Postgres not running   | `docker compose up -d postgres`           |
| `database "polyroot_test" does not exist` | DB never created       | run step 3                                |
| `relation "..." does not exist`           | Migrations not applied | `DATABASE_URL=... npm run migrate:latest` |

## Pull Request Guidelines

- Keep PRs focused on a single concern.
- All CI checks must pass (Lint, Typecheck, Unit/Contract Tests, Gitleaks, Traceability).
- Include appropriate Changesets if public APIs or package versions are affected.
