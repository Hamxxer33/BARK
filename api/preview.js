import { createPublicClient, getAddress, http, isAddress } from "viem";
import { base } from "viem/chains";

const AIRDROP = process.env.AIRDROP_ADDRESS || "0x3cfec2dd7480004a6902cb66f1e15e8e919c8185";
const RPC = process.env.RPC_URL || "https://mainnet.base.org";

const airdropAbi = [
  { type: "function", name: "claimed", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "claimedAmount", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "remaining", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];

const client = createPublicClient({ chain: base, transport: http(RPC) });

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  const address = req.query?.address || "";
  if (!isAddress(address)) return res.status(400).json({ error: "Enter a valid wallet address" });
  try {
    const account = getAddress(address);
    const [txCount, remaining, claimed, claimedAmount] = await Promise.all([
      client.getTransactionCount({ address: account, blockTag: "latest" }),
      client.readContract({ address: AIRDROP, abi: airdropAbi, functionName: "remaining" }),
      client.readContract({ address: AIRDROP, abi: airdropAbi, functionName: "claimed", args: [account] }),
      client.readContract({ address: AIRDROP, abi: airdropAbi, functionName: "claimedAmount", args: [account] }),
    ]);
    return res.status(200).json({
      address: account,
      txCount,
      tokensPerTx: "70",
      allocation: (BigInt(txCount) * 70n * 10n ** 18n).toString(),
      remaining: remaining.toString(),
      claimed,
      claimedAmount: claimedAmount.toString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to read Base history" });
  }
}
