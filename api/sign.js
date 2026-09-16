import { createPublicClient, getAddress, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const AIRDROP = process.env.AIRDROP_ADDRESS || "0x3cfec2dd7480004a6902cb66f1e15e8e919c8185";
const RPC = process.env.RPC_URL || "https://mainnet.base.org";

const client = createPublicClient({ chain: base, transport: http(RPC) });

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const address = req.body?.address || "";
  if (!isAddress(address)) return res.status(400).json({ error: "Enter a valid wallet address" });

  let key = process.env.SIGNER_PRIVATE_KEY || process.env.PRIVATE_KEY || "";
  if (!key) return res.status(500).json({ error: "SIGNER_PRIVATE_KEY is not set" });
  if (!key.startsWith("0x")) key = `0x${key}`;

  try {
    const account = getAddress(address);
    const txCount = await client.getTransactionCount({ address: account, blockTag: "latest" });
    if (txCount === 0) return res.status(400).json({ error: "This wallet has 0 Base transactions" });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 10 * 60);
    const signer = privateKeyToAccount(key);
    const signature = await signer.signTypedData({
      domain: {
        name: "B20Airdrop",
        version: "1",
        chainId: 8453,
        verifyingContract: AIRDROP,
      },
      types: {
        Claim: [
          { name: "account", type: "address" },
          { name: "txCount", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Claim",
      message: { account, txCount: BigInt(txCount), deadline },
    });
    return res.status(200).json({
      address: account,
      txCount,
      allocation: (BigInt(txCount) * 70n * 10n ** 18n).toString(),
      deadline: deadline.toString(),
      signature,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Sign failed" });
  }
}
