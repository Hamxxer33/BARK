/**
 * Compiles and deploys BarkClaimPass + BarkClaimMint to Base, then wires them together.
 *
 * Built to run on a phone: solc and viem are both plain JavaScript, so Termux needs
 * nothing heavier than Node.
 *
 *   PRIVATE_KEY=0x... node scripts/deploy.mjs          # dry run, spends nothing
 *   PRIVATE_KEY=0x... CONFIRM=yes node scripts/deploy.mjs
 *
 * The key is read from the environment and never printed. Put a space before the
 * command so it stays out of your shell history.
 */
import solc from "solc";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http, encodeDeployData, encodeFunctionData, formatEther, getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const RPC = process.env.RPC_URL || "https://mainnet.base.org";
const AIRDROP = process.env.AIRDROP_ADDRESS || "0x3cfec2dd7480004a6902cb66f1e15e8e919c8185";
const PRICE_WEI = BigInt(process.env.PRICE_WEI || "30000000000000"); // ~$0.10 at $3.3k ETH
const CONFIRM = process.env.CONFIRM === "yes";

const key = process.env.PRIVATE_KEY || "";
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("PRIVATE_KEY must be set to a 0x-prefixed 64-hex-character key.");
  process.exit(1);
}
const account = privateKeyToAccount(key);
const TREASURY = process.env.TREASURY ? getAddress(process.env.TREASURY) : account.address;
const OWNER = process.env.OWNER ? getAddress(process.env.OWNER) : account.address;

/* --------------------------------------------------------------- compile */

function compile() {
  const sources = {};
  for (const name of ["BarkClaimPass", "BarkClaimMint"]) {
    const path = `contracts/${name}.sol`;
    if (!existsSync(path)) throw new Error(`missing ${path} — run this from the repo root`);
    sources[path] = { content: readFileSync(path, "utf8") };
  }
  const out = JSON.parse(solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources,
      settings: {
        optimizer: { enabled: true, runs: 200 },
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      },
    }),
    {
      import: (p) => {
        try {
          return { contents: readFileSync(p.startsWith("@") ? `node_modules/${p}` : p, "utf8") };
        } catch (e) {
          return { error: e.message };
        }
      },
    },
  ));

  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) {
    for (const e of errors) console.error(e.formattedMessage);
    throw new Error("compilation failed");
  }
  const pick = (file, name) => {
    const c = out.contracts[file][name];
    return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
  };
  return {
    pass: pick("contracts/BarkClaimPass.sol", "BarkClaimPass"),
    mint: pick("contracts/BarkClaimMint.sol", "BarkClaimMint"),
  };
}

/* ---------------------------------------------------------------- deploy */

const publicClient = createPublicClient({ chain: base, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: base, transport: http(RPC) });

async function deploy(label, { abi, bytecode }, args) {
  const data = encodeDeployData({ abi, bytecode, args });
  const gas = await publicClient.estimateGas({ account: account.address, data });
  console.log(`  ${label}: ${(bytecode.length / 2 - 1).toLocaleString()} bytes, est. gas ${gas.toLocaleString()}`);
  if (!CONFIRM) return null;
  const hash = await wallet.sendTransaction({ data, gas: (gas * 12n) / 10n });
  console.log(`  ${label}: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${label} deployment reverted`);
  console.log(`  ${label}: deployed at ${receipt.contractAddress}`);
  return getAddress(receipt.contractAddress);
}

async function main() {
  console.log("Compiling…");
  const artifacts = compile();

  const chainId = await publicClient.getChainId();
  const balance = await publicClient.getBalance({ address: account.address });
  const airdropCode = await publicClient.getCode({ address: getAddress(AIRDROP) });

  console.log("\nPlan");
  console.log("  chain     ", chainId, chainId === 8453 ? "(Base)" : "(NOT BASE — stopping)");
  console.log("  deployer  ", account.address);
  console.log("  balance   ", formatEther(balance), "ETH");
  console.log("  owner     ", OWNER);
  console.log("  treasury  ", TREASURY, "  <- mint proceeds land here");
  console.log("  airdrop   ", getAddress(AIRDROP), airdropCode && airdropCode !== "0x" ? "(has code)" : "(NO CODE — wrong address?)");
  console.log("  price     ", formatEther(PRICE_WEI), "ETH per claim");

  if (chainId !== 8453) throw new Error(`expected Base (8453), got ${chainId}`);
  if (!airdropCode || airdropCode === "0x") throw new Error("airdrop address has no contract code");
  if (balance === 0n) throw new Error("deployer has no ETH for gas");
  if (!isAddress(TREASURY) || !isAddress(OWNER)) throw new Error("bad owner/treasury address");

  console.log("\nDeploying…");
  const passAddress = await deploy("BarkClaimPass", artifacts.pass, [OWNER]);
  const mintAddress = passAddress
    ? await deploy("BarkClaimMint", artifacts.mint, [OWNER, getAddress(AIRDROP), passAddress, TREASURY, PRICE_WEI])
    : await deploy("BarkClaimMint", artifacts.mint, [OWNER, getAddress(AIRDROP), account.address, TREASURY, PRICE_WEI]);

  if (!CONFIRM) {
    console.log("\nDry run only — nothing was sent. Re-run with CONFIRM=yes to deploy.");
    return;
  }

  // Without this the pass rejects every mint, so it is part of the deploy, not a follow-up.
  console.log("\nAuthorising the mint contract to mint passes…");
  const hash = await wallet.sendTransaction({
    to: passAddress,
    data: encodeFunctionData({ abi: artifacts.pass.abi, functionName: "setMinter", args: [mintAddress] }),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("setMinter reverted");
  console.log("  setMinter:", hash);

  const minter = await publicClient.readContract({ address: passAddress, abi: artifacts.pass.abi, functionName: "minter" });
  if (getAddress(minter) !== mintAddress) throw new Error(`minter is ${minter}, expected ${mintAddress}`);

  writeFileSync("deployed.json", JSON.stringify({ pass: passAddress, mint: mintAddress, treasury: TREASURY, priceWei: PRICE_WEI.toString() }, null, 2));

  console.log("\nDone.");
  console.log("  BarkClaimPass", passAddress);
  console.log("  BarkClaimMint", mintAddress);
  console.log("\nSet this in Vercel, then redeploy:");
  console.log("  MINT_ADDRESS=" + mintAddress);
}

main().catch((err) => {
  console.error("\nFailed:", err.shortMessage || err.message);
  process.exit(1);
});
