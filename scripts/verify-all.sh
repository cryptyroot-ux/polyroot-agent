#!/bin/bash
set -euo pipefail

echo "=== Polyroot Full Verification Suite ==="

echo "1. Installing clean dependencies..."
npm ci

echo "2. Running TypeScript typecheck..."
npm run typecheck

echo "3. Running ESLint..."
npm run lint

echo "4. Building all packages..."
npm run build

echo "5. Running migration smoke test..."
npm run test:migration

echo "6. Running contract test suite..."
npm run test:contract

echo "7. Running traceability verification..."
npm run traceability

echo "✅ All verification steps passed!"