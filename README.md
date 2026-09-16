# BARK claim

Claim site for **BARK** on Base. Enter a wallet, we read its Base transaction count, pay **70 BARK per tx**.

## Live

| | |
| --- | --- |
| Token | [`0xB200000000000000000000B8A0253f93DE48B78c`](https://basescan.org/token/0xB200000000000000000000B8A0253f93DE48B78c) |
| Claim | [`0x3cfeC2Dd7480004A6902CB66F1e15E8e919c8185`](https://basescan.org/address/0x3cfec2dd7480004a6902cb66f1e15e8e919c8185) |
| Per tx | 70 BARK |
| Airdrop pool | 15,000,000,000 |

LP NFT is at `0x…dEaD`. Supply is 100B, 80B in Uniswap v4, 5B in the project wallet.

## Connecting a wallet

**Connect Wallet** opens a picker with two paths:

- **Installed** — every browser extension that announces itself over EIP-6963
  (MetaMask, Coinbase Wallet, Rabby, Phantom …), each listed by its own name. Wallets
  older than EIP-6963 still work through `window.ethereum`.
- **All wallets** — a searchable grid of a few hundred wallets with their real logos,
  pulled from the Reown/WalletConnect directory and filtered to the visitor's platform.
  Tapping one on a phone opens that app straight into the approval screen; on a desktop
  it shows a QR code to scan. The QR button next to the search box skips to the code.

If the directory cannot be reached the grid falls back to a built-in shortlist of the
dozen most common wallets, so the dialog is never empty.

Once connected the site fills in the address, reads the allocation, and keeps the
session across reloads. It watches for account and network changes, and offers to
switch (or add) Base when the wallet is on the wrong chain.

You can still paste someone else's address to check it. Claiming for an address that
isn't the connected one is allowed — the BARK goes to the address in the box, the
connected wallet only pays gas — and the page says so before you sign.

### WalletConnect project ID

The QR / mobile option needs a free project ID from
[dashboard.reown.com](https://dashboard.reown.com). Create a project, add the site's
domain to its allowed domains, then set:

```
WALLETCONNECT_PROJECT_ID=...
```

The ID is public by design — it ends up in the browser either way, and the
allowed-domains list is what stops other sites using it. Without it the page still
works; the WalletConnect row is simply greyed out and only extensions can connect.

## Local

```bash
npm install
npm start
```

http://127.0.0.1:3000

Set `SIGNER_PRIVATE_KEY` (same key as the airdrop `signer`) in `.env`.

```bash
npm test   # connector tests: discovery, chain switching, session restore, QR + deep links
```

## Vercel

Import this repo. Root = this folder. Env:

```
SIGNER_PRIVATE_KEY=
AIRDROP_ADDRESS=0x3cfec2dd7480004a6902cb66f1e15e8e919c8185
RPC_URL=https://mainnet.base.org
WALLETCONNECT_PROJECT_ID=
```

`index.html` is served straight off the CDN there, so the page reads
`/api/config` at boot to pick up the project ID.
