# Telegram Onboarding & Extended Commands Design Spec

## Goal
Enable operators to perform full onboarding, wallet management (`/wallet`), and runtime mode switching (`/mode`) directly via Telegram, as well as enhancing `/update` feedback and remote management capabilities.

## Architecture & Components
1. **Telegram Onboarding Flow (`/onboard` or first interaction)**:
   - Stateful session tracking in memory / database for the operator's chat ID.
   - Step 1: AI Provider & API Key selection / configuration.
   - Step 2: Wallet setup (Generate or Import secret key + vault passphrase).
   - Step 3: Mode & Capital caps configuration (SHADOW, PAPER, MICRO_LIVE, LIVE).
   - Writes directly to `~/.polyroot/.env` and reloads configuration.

2. **Extended `/wallet` Command**:
   - `/wallet` (no args): Shows current balances (USDC/ETH), Signer address, Account address, and Funder address.
   - `/wallet import <private_key>`: Securely updates signer key in vault / `.env`.
   - `/wallet create`: Generates a new secure wallet and updates `.env`.

3. **Extended `/mode` Command**:
   - `/mode` (no args): Shows current runtime mode and autonomy bounds.
   - `/mode <PAPER|SHADOW|MICRO_LIVE|LIVE>`: Dynamically updates mode in database (`live_guard_state`) and `.env` with confirmation prompt.

4. **Enhanced `/update`**:
   - Detailed progress reporting (git pull status, build status, systemd restart status).

## Security & Access Control
- All commands remain strictly restricted to approved operator chat IDs (`isAllowed`).
- Sensitive data (private keys, passwords) handled securely and redacted in logs.
