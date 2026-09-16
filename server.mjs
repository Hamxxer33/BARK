import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, isAddress, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const root = dirname(fileURLToPath(import.meta.url));
const repo = join(root, "..");

function loadEnv() {
  const out = { ...process.env };
  for (const file of [join(repo, ".env"), join(root, ".env")]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([^#=]+)=(.*)$/);
      if (m && out[m[1].trim()] === undefined) out[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return out;
}

function loadDeployed() {
  const p = join(repo, "deployed.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

const env = loadEnv();
const deployed = loadDeployed();
// Same live defaults the serverless handlers use, so a missing .env cannot blank these out.
const TOKEN = env.TOKEN_ADDRESS || deployed.token || "0xB200000000000000000000B8A0253f93DE48B78c";
const AIRDROP = env.AIRDROP_ADDRESS || deployed.airdrop || "0x3cfec2dd7480004a6902cb66f1e15e8e919c8185";
const RPC = env.RPC_URL || env.NEXT_PUBLIC_RPC_URL || "https://mainnet.base.org";
const PORT = Number(env.PORT || 3000);
const TOKEN_NAME = env.TOKEN_NAME || "BARK";
const TOKEN_SYMBOL = env.TOKEN_SYMBOL || "BARK";
const WC_PROJECT_ID = env.WALLETCONNECT_PROJECT_ID || env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

let signerKey = env.SIGNER_PRIVATE_KEY || env.PRIVATE_KEY || "";
if (signerKey && !signerKey.startsWith("0x")) signerKey = `0x${signerKey}`;

const publicClient = createPublicClient({ chain: base, transport: http(RPC) });
const html = readFileSync(join(root, "index.html"), "utf8");
const modules = {
  "/wallet.js": readFileSync(join(root, "wallet.js"), "utf8"),
  "/chain.js": readFileSync(join(root, "chain.js"), "utf8"),
};

const CLAIM_TYPES = {
  Claim: [
    { name: "account", type: "address" },
    { name: "txCount", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

async function history(address) {
  const account = getAddress(address);
  const [txCount, balance, code] = await Promise.all([
    publicClient.getTransactionCount({ address: account, blockTag: "latest" }),
    publicClient.getBalance({ address: account }),
    publicClient.getCode({ address: account }),
  ]);
  const allocation = (BigInt(txCount) * 70n * 10n ** 18n).toString();
  return {
    address: account,
    txCount,
    ethWei: balance.toString(),
    isContract: Boolean(code && code !== "0x"),
    tokensPerTx: "70",
    allocation,
  };
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(data);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    const page = html.replace(
      "/*__CONFIG__*/",
      `window.B20 = ${JSON.stringify({
        token: TOKEN,
        airdrop: AIRDROP,
        chainId: 8453,
        rpc: RPC,
        name: TOKEN_NAME,
        symbol: TOKEN_SYMBOL,
        walletConnectProjectId: WC_PROJECT_ID,
      })};`,
    );
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }

  if (modules[url.pathname]) {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end(modules[url.pathname]);
    return;
  }

  if (url.pathname === "/api/config" && req.method === "GET") {
    json(res, 200, {
      token: TOKEN,
      airdrop: AIRDROP,
      chainId: 8453,
      name: TOKEN_NAME,
      symbol: TOKEN_SYMBOL,
      walletConnectProjectId: WC_PROJECT_ID,
      configured: Boolean(TOKEN && AIRDROP),
    });
    return;
  }

  if (url.pathname === "/api/preview" && req.method === "GET") {
    const address = url.searchParams.get("address") || "";
    if (!isAddress(address)) return json(res, 400, { error: "Enter a valid wallet address" });
    try {
      json(res, 200, await history(address));
    } catch (err) {
      json(res, 500, { error: err.message || "Failed to read Base history" });
    }
    return;
  }

  if (url.pathname === "/api/sign" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      return json(res, 400, { error: "Invalid JSON" });
    }
    if (!isAddress(parsed.address || "")) return json(res, 400, { error: "Enter a valid wallet address" });
    if (!signerKey) return json(res, 500, { error: "SIGNER_PRIVATE_KEY is not set on the server" });
    if (!AIRDROP) return json(res, 500, { error: "Airdrop address missing — deploy first" });
    try {
      const hist = await history(parsed.address);
      if (hist.txCount === 0) return json(res, 400, { error: "This wallet has 0 Base transactions" });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 10 * 60);
      const account = privateKeyToAccount(signerKey);
      const signature = await account.signTypedData({
        domain: {
          name: "B20Airdrop",
          version: "1",
          chainId: 8453,
          verifyingContract: AIRDROP,
        },
        types: CLAIM_TYPES,
        primaryType: "Claim",
        message: {
          account: hist.address,
          txCount: BigInt(hist.txCount),
          deadline,
        },
      });
      json(res, 200, { ...hist, deadline: deadline.toString(), signature });
    } catch (err) {
      json(res, 500, { error: err.message || "Sign failed" });
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`BARK claim  http://127.0.0.1:${PORT}`);
  console.log("token  ", TOKEN || "(not deployed)");
  console.log("airdrop", AIRDROP || "(not deployed)");
});
