/**
 * chain.js replaces viem on the page, so every encoder here is checked against viem
 * itself. viem stays a devDependency purely as the reference implementation.
 */
import assert from "node:assert/strict";
import { encodeFunctionData, formatUnits as viemFormatUnits, toFunctionSelector, isAddress as viemIsAddress, getAddress } from "viem";
import {
  SELECTOR, encodeClaim, encodeUint, encodeAddress, encodeBytes,
  formatUnits, isAddress, decodeUint, decodeBool, createReader, waitForReceipt, createRpc,
} from "../chain.js";

let failed = false;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}: ${err.message}`);
    failed = true;
  }
};

const claimAbi = [{
  type: "function", name: "claim", stateMutability: "nonpayable", outputs: [],
  inputs: [
    { name: "account", type: "address" },
    { name: "txCount", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "signature", type: "bytes" },
  ],
}];
const viewAbi = (name, inputs) => [{ type: "function", name, stateMutability: "view", inputs, outputs: [{ type: "uint256" }] }];

await check("selectors match keccak", () => {
  assert.equal(SELECTOR.claim, toFunctionSelector("claim(address,uint256,uint256,bytes)"));
  assert.equal(SELECTOR.claimed, toFunctionSelector("claimed(address)"));
  assert.equal(SELECTOR.claimedAmount, toFunctionSelector("claimedAmount(address)"));
  assert.equal(SELECTOR.remaining, toFunctionSelector("remaining()"));
});

await check("claim calldata is byte-for-byte viem, over random inputs", () => {
  const rand = (n) => "0x" + Array.from({ length: n }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("");
  const cases = [
    { account: rand(20), txCount: 0n, deadline: 0n, signature: "0x" + "11".repeat(65) },
    { account: rand(20), txCount: 1n, deadline: 1n, signature: "0x" + "ab".repeat(65) },
    { account: rand(20), txCount: 4242n, deadline: 1789565704n, signature: rand(65) },
    { account: rand(20), txCount: 2n ** 255n, deadline: 2n ** 64n, signature: rand(64) },   // exact word multiple
    { account: rand(20), txCount: 7n, deadline: 9n, signature: rand(1) },                    // 1 byte
    { account: rand(20), txCount: 7n, deadline: 9n, signature: rand(33) },                   // spills a word
    { account: rand(20), txCount: 7n, deadline: 9n, signature: "0x" },                       // empty
  ];
  for (const c of cases) {
    const mine = encodeClaim(c);
    const theirs = encodeFunctionData({
      abi: claimAbi, functionName: "claim",
      args: [getAddress(c.account), BigInt(c.txCount), BigInt(c.deadline), c.signature],
    });
    assert.equal(mine, theirs, `mismatch for signature length ${(c.signature.length - 2) / 2}`);
  }
  for (let i = 0; i < 200; i += 1) {
    const c = {
      account: rand(20),
      txCount: BigInt(Math.floor(Math.random() * 1e9)),
      deadline: BigInt(Math.floor(Math.random() * 1e12)),
      signature: rand(1 + Math.floor(Math.random() * 100)),
    };
    assert.equal(
      encodeClaim(c),
      encodeFunctionData({ abi: claimAbi, functionName: "claim", args: [getAddress(c.account), c.txCount, c.deadline, c.signature] }),
    );
  }
});

await check("view-call calldata matches viem", () => {
  const address = "0x1111111111111111111111111111111111111111";
  assert.equal(
    SELECTOR.claimed + encodeAddress(address),
    encodeFunctionData({ abi: viewAbi("claimed", [{ type: "address" }]), functionName: "claimed", args: [getAddress(address)] }),
  );
  assert.equal(
    SELECTOR.remaining,
    encodeFunctionData({ abi: [{ type: "function", name: "remaining", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "remaining" }),
  );
});

await check("formatUnits matches viem", () => {
  const cases = [0n, 1n, 70n, 10n ** 18n, 2940n * 10n ** 18n, 15_000_000_000n * 10n ** 18n, 123456789012345678n, 10n ** 17n, 999999999999999999n];
  for (const v of cases) assert.equal(formatUnits(v, 18), viemFormatUnits(v, 18), `for ${v}`);
  for (let i = 0; i < 200; i += 1) {
    const v = BigInt(Math.floor(Math.random() * 1e15)) * BigInt(Math.floor(Math.random() * 1e6) + 1);
    assert.equal(formatUnits(v, 18), viemFormatUnits(v, 18), `for ${v}`);
  }
});

await check("isAddress agrees with viem", () => {
  const samples = ["0x1111111111111111111111111111111111111111", "0xB200000000000000000000B8A0253f93DE48B78c", "0x123", "", "nope", "0x" + "g".repeat(40)];
  for (const s of samples) assert.equal(isAddress(s), viemIsAddress(s, { strict: false }), `for "${s}"`);
});

await check("decoders read what the node returns", () => {
  assert.equal(decodeUint("0x" + (2940n * 10n ** 18n).toString(16).padStart(64, "0")), 2940n * 10n ** 18n);
  assert.equal(decodeUint("0x"), 0n);
  assert.equal(decodeUint(undefined), 0n);
  assert.equal(decodeBool("0x" + "0".repeat(63) + "1"), true);
  assert.equal(decodeBool("0x" + "0".repeat(64)), false);
});

await check("reader issues the right JSON-RPC calls", async () => {
  const seen = [];
  const rpc = async (method, params) => {
    seen.push({ method, params });
    if (method === "eth_getTransactionCount") return "0x2a";
    return "0x" + (42n).toString(16).padStart(64, "0");
  };
  const reader = createReader(rpc, "0xcontract");
  assert.equal(await reader.transactionCount("0x1111111111111111111111111111111111111111"), 42);
  assert.equal(await reader.remaining(), 42n);
  assert.equal(await reader.claimed("0x1111111111111111111111111111111111111111"), true);
  assert.equal(seen[0].params[1], "latest");
  assert.equal(seen[1].params[0].data, SELECTOR.remaining);
  assert.equal(seen[2].params[0].data, SELECTOR.claimed + encodeAddress("0x1111111111111111111111111111111111111111"));
});

await check("receipt poll resolves on success, null on timeout", async () => {
  let calls = 0;
  const rpc = async () => (++calls < 3 ? null : { status: "0x1", transactionHash: "0xabc" });
  const receipt = await waitForReceipt(rpc, "0xabc", { timeoutMs: 5000, intervalMs: 5 });
  assert.equal(receipt.success, true);
  assert.equal(calls, 3);
  assert.equal(await waitForReceipt(async () => null, "0xabc", { timeoutMs: 30, intervalMs: 5 }), null);
  const reverted = await waitForReceipt(async () => ({ status: "0x0" }), "0xabc", { timeoutMs: 100, intervalMs: 5 });
  assert.equal(reverted.success, false);
});

await check("rpc surfaces node errors", async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ error: { message: "execution reverted" } }) });
  await assert.rejects(() => createRpc("http://x")("eth_call", []), /execution reverted/);
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(() => createRpc("http://x")("eth_call", []), /503/);
});

console.log(failed ? "\nFAILURES" : "\nall green (chain)");
process.exit(failed ? 1 : 0);
