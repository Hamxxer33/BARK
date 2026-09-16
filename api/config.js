/**
 * Public client config. On Vercel index.html is served straight off the CDN, so the
 * page cannot be templated at request time — it fetches this instead. Only values
 * that are safe in a browser belong here (a WalletConnect project ID is one of them;
 * it is public by design and locked down by the allowed-domains list in the
 * WalletConnect dashboard).
 */
const TOKEN = process.env.TOKEN_ADDRESS || "0xB200000000000000000000B8A0253f93DE48B78c";
const AIRDROP = process.env.AIRDROP_ADDRESS || "0x3cfec2dd7480004a6902cb66f1e15e8e919c8185";

export default function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("cache-control", "public, max-age=60, s-maxage=300");
  if (req.method === "OPTIONS") return res.status(204).end();
  return res.status(200).json({
    token: TOKEN,
    airdrop: AIRDROP,
    chainId: 8453,
    name: process.env.TOKEN_NAME || "BARK",
    symbol: process.env.TOKEN_SYMBOL || "BARK",
    walletConnectProjectId:
      process.env.WALLETCONNECT_PROJECT_ID || process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "",
  });
}
