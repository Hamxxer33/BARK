/**
 * The bit of Ethereum this page actually needs: four view calls, one transaction,
 * and a receipt poll. That used to be the whole of viem plus its chain list —
 * roughly 700KB over a pile of CDN requests before anything rendered.
 *
 * Selectors are fixed, so they are inlined rather than hashed at runtime. There is a
 * test that checks every encoder here against viem byte for byte.
 */

export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_HEX = "0x2105";

export const SELECTOR = {
  claimed: "0xc884ef83", // claimed(address)
  claimedAmount: "0x04e86903", // claimedAmount(address)
  remaining: "0x55234ec0", // remaining()
  claim: "0x2ada8a32", // claim(address,uint256,uint256,bytes)
};

/* ------------------------------------------------------------------ types */

export function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** Lowercases and validates. We deliberately don't checksum — that would need keccak. */
export function normalizeAddress(value) {
  if (!isAddress(value)) throw new Error("Invalid address");
  return value.toLowerCase();
}

export function shortAddress(value) {
  return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "";
}

export function sameAddress(a, b) {
  return Boolean(a) && Boolean(b) && a.toLowerCase() === b.toLowerCase();
}

/* --------------------------------------------------------------- encoding */

const word = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

export function encodeUint(value) {
  const n = BigInt(value);
  if (n < 0n) throw new Error("Negative uint");
  return word(n.toString(16));
}

export function encodeAddress(value) {
  return word(normalizeAddress(value).slice(2));
}

/** Dynamic `bytes`: a length word then the data, right-padded to a whole word. */
export function encodeBytes(value) {
  const raw = String(value).replace(/^0x/, "").toLowerCase();
  if (raw.length % 2) throw new Error("Odd-length bytes");
  const padded = raw.length % 64 ? raw.padEnd(raw.length + (64 - (raw.length % 64)), "0") : raw;
  return encodeUint(raw.length / 2) + padded;
}

/** claim(address,uint256,uint256,bytes) — three static words, then the tail. */
export function encodeClaim({ account, txCount, deadline, signature }) {
  const head =
    encodeAddress(account) +
    encodeUint(txCount) +
    encodeUint(deadline) +
    encodeUint(4 * 32); // offset to the bytes tail
  return SELECTOR.claim + head + encodeBytes(signature);
}

export const decodeUint = (hex) => BigInt(hex && hex !== "0x" ? hex : "0x0");
export const decodeBool = (hex) => decodeUint(hex) !== 0n;

/** 1000000000000000000n -> "1" ; drops trailing zeros in the fraction. */
export function formatUnits(value, decimals = 18) {
  const negative = BigInt(value) < 0n;
  const digits = (negative ? -BigInt(value) : BigInt(value)).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/* ------------------------------------------------------------------- rpc */

export function createRpc(url) {
  let nextId = 0;
  return async function rpc(method, params = []) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
    });
    if (!res.ok) throw new Error(`RPC ${method} failed (${res.status})`);
    const body = await res.json();
    if (body.error) throw new Error(body.error.message || `RPC ${method} failed`);
    return body.result;
  };
}

export function createReader(rpc, contract) {
  const call = (data) => rpc("eth_call", [{ to: contract, data }, "latest"]);
  return {
    transactionCount: async (address) => Number(decodeUint(await rpc("eth_getTransactionCount", [normalizeAddress(address), "latest"]))),
    remaining: async () => decodeUint(await call(SELECTOR.remaining)),
    claimed: async (address) => decodeBool(await call(SELECTOR.claimed + encodeAddress(address))),
    claimedAmount: async (address) => decodeUint(await call(SELECTOR.claimedAmount + encodeAddress(address))),
  };
}

/** Polls for a receipt. Resolves null if it has not landed before the timeout. */
export async function waitForReceipt(rpc, hash, { timeoutMs = 120000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let receipt = null;
    try {
      receipt = await rpc("eth_getTransactionReceipt", [hash]);
    } catch {
      /* a flaky read shouldn't end the wait */
    }
    if (receipt) return { ...receipt, success: decodeUint(receipt.status) === 1n };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}
