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

## Local

```bash
npm install
npm start
```

http://127.0.0.1:3000

Set `SIGNER_PRIVATE_KEY` (same key as the airdrop `signer`) in `.env`.

## Vercel

Import this repo. Root = this folder. Env:

```
SIGNER_PRIVATE_KEY=
AIRDROP_ADDRESS=0x3cfec2dd7480004a6902cb66f1e15e8e919c8185
RPC_URL=https://mainnet.base.org
```
