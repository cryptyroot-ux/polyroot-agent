# Contributing to PolyRoot

Thank you for your interest in contributing to PolyRoot! We welcome contributions to improve our autonomous Polymarket trading agent platform.

## Code of Conduct

By participating, you are expected to uphold our open source standards. Please be respectful and constructive.

## How to Contribute

1. Fork the repository and create your branch from `main`.
2. Ensure you have Node.js >= 24.0.0 and pnpm/npm installed.
3. Install dependencies: `npm install`
4. Run tests and typechecks to verify your baseline: `npm run ci`
5. Make your changes adhering to strict TypeScript settings (`verbatimModuleSyntax: true`, `exactOptionalPropertyTypes: true`).
6. Add unit, contract, or property tests for any new behavior.
7. Run `npm run ci` again to ensure zero regressions.
8. Submit a Pull Request with a clear description of the problem and solution.

## Pull Request Guidelines

- Keep PRs focused on a single concern.
- All CI checks must pass (Lint, Typecheck, Unit/Contract Tests, Gitleaks, Traceability).
- Include appropriate Changesets if public APIs or package versions are affected.
