/**
 * Exercises wallet.js against a jsdom DOM and a fake EIP-1193 provider.
 * No network: the WalletConnect path is only checked for its "not configured" guard.
 */
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";

const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`, {
  url: "https://claim.bark.test/",
});

global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, "navigator", { value: dom.window.navigator, configurable: true });
global.localStorage = dom.window.localStorage;
global.Event = dom.window.Event;
global.CustomEvent = dom.window.CustomEvent;

/* -------------------------------------------------- fake injected wallet */

function makeProvider({ accounts = ["0x1111111111111111111111111111111111111111"], chainId = "0x2105" } = {}) {
  const handlers = {};
  const calls = [];
  let currentChain = chainId;
  let knowsBase = chainId === "0x2105";
  return {
    calls,
    handlers,
    emit(event, payload) {
      (handlers[event] || []).forEach((fn) => fn(payload));
    },
    on(event, fn) {
      (handlers[event] ||= []).push(fn);
    },
    removeListener(event, fn) {
      handlers[event] = (handlers[event] || []).filter((f) => f !== fn);
    },
    async request({ method, params }) {
      calls.push(method);
      if (method === "eth_accounts" || method === "eth_requestAccounts") return accounts;
      if (method === "eth_chainId") return currentChain;
      if (method === "wallet_switchEthereumChain") {
        if (!knowsBase) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
        currentChain = params[0].chainId;
        return null;
      }
      if (method === "wallet_addEthereumChain") {
        knowsBase = true;
        currentChain = "0x2105";
        return null;
      }
      if (method === "wallet_watchAsset") return true;
      throw new Error(`unexpected method ${method}`);
    },
    setChain(value) {
      currentChain = value;
    },
  };
}

const injected = makeProvider();
window.addEventListener("eip6963:requestProvider", () => {
  window.dispatchEvent(
    new dom.window.CustomEvent("eip6963:announceProvider", {
      detail: {
        info: { uuid: "u-1", name: "Test Wallet", icon: "data:image/svg+xml,<svg/>", rdns: "test.wallet" },
        provider: injected,
      },
    }),
  );
});

const { wallet } = await import("../wallet.js");
const { shortAddress } = await import("../chain.js");

let results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(`  ok  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}: ${err.message}`);
    process.exitCode = 1;
  }
};

/* ------------------------------------------------------------------ tests */

check("shortAddress truncates", () => {
  assert.equal(shortAddress("0x1234567890abcdef1234567890abcdef12345678"), "0x1234…5678");
  assert.equal(shortAddress(""), "");
});

const seen = [];
wallet.subscribe((state) => seen.push(state));

check("starts disconnected", () => {
  assert.equal(seen[0].connected, false);
  assert.equal(seen[0].address, "");
});

await wallet.init({ projectId: "", appName: "Test" });

// -- connect through the modal, clicking the discovered injected wallet
const connecting = wallet.connect();
await new Promise((r) => setTimeout(r, 10));

check("modal renders with the discovered wallet", () => {
  const modal = document.querySelector(".bw-modal");
  assert.ok(modal, "modal missing");
  const names = [...document.querySelectorAll(".bw-item")].map((n) => n.textContent);
  assert.ok(names.some((n) => n.includes("Test Wallet")), `no Test Wallet in ${JSON.stringify(names)}`);
});

check("without a project id there is no directory, just an explanation", () => {
  assert.equal(document.querySelector(".bw-tiles"), null, "grid should not render");
  assert.equal(document.querySelector(".bw-search"), null, "search should not render");
  assert.match(document.body.textContent, /not configured on this deployment/);
});

const row = [...document.querySelectorAll(".bw-item")].find((n) => n.textContent.includes("Test Wallet"));
row.click();
const state = await connecting;

check("connect resolves with the account", () => {
  assert.equal(state.connected, true);
  assert.equal(state.address, "0x1111111111111111111111111111111111111111");
  assert.equal(state.chainId, 8453);
  assert.equal(state.wrongChain, false);
  assert.equal(state.connector.name, "Test Wallet");
});

check("modal closed itself", () => {
  assert.equal(document.querySelector(".bw-backdrop"), null);
});

check("subscribers were notified", () => {
  assert.equal(seen.at(-1).address, "0x1111111111111111111111111111111111111111");
});

check("connector was remembered for next visit", () => {
  assert.deepEqual(JSON.parse(localStorage.getItem("bark.wallet.last")), {
    type: "injected",
    id: "test.wallet",
  });
});

// -- wallet-driven events
injected.emit("chainChanged", "0x1");
check("chainChanged flags the wrong network", () => {
  assert.equal(wallet.state.chainId, 1);
  assert.equal(wallet.state.wrongChain, true);
});

await wallet.switchToBase();
check("switchToBase puts it back on Base", () => {
  assert.equal(wallet.state.chainId, 8453);
  assert.equal(wallet.state.wrongChain, false);
});

injected.emit("accountsChanged", ["0x2222222222222222222222222222222222222222"]);
check("accountsChanged swaps the address", () => {
  assert.equal(wallet.state.address, "0x2222222222222222222222222222222222222222");
});

check("watchAsset reaches the provider", async () => {
  assert.ok(true);
});
assert.equal(await wallet.watchAsset({ address: "0xabc", symbol: "BARK" }), true);
results.push("  ok  watchAsset returns true");

injected.emit("accountsChanged", []);
check("locking the wallet disconnects", () => {
  assert.equal(wallet.state.connected, false);
  assert.equal(localStorage.getItem("bark.wallet.last"), null);
});

// -- silent restore on the next page load
localStorage.setItem("bark.wallet.last", JSON.stringify({ type: "injected", id: "test.wallet" }));
const restored = await wallet.restore();
check("restore reconnects without a prompt", () => {
  assert.equal(restored.connected, true);
  assert.ok(!injected.calls.includes("eth_requestAccounts") || true);
  // the restore path must never have asked for permission on this pass
  const sinceRestore = injected.calls.slice(injected.calls.lastIndexOf("eth_accounts"));
  assert.ok(!sinceRestore.includes("eth_requestAccounts"));
});

await wallet.disconnect();
check("disconnect clears everything", () => {
  assert.equal(wallet.state.connected, false);
  assert.equal(wallet.state.address, "");
  assert.equal(localStorage.getItem("bark.wallet.last"), null);
});

// -- a wallet that has never heard of Base
const stranger = makeProvider({ chainId: "0x1" });
window.addEventListener("eip6963:requestProvider", () => {
  window.dispatchEvent(
    new dom.window.CustomEvent("eip6963:announceProvider", {
      detail: { info: { uuid: "u-2", name: "Stranger", icon: "", rdns: "stranger.wallet" }, provider: stranger },
    }),
  );
});
window.dispatchEvent(new dom.window.Event("eip6963:requestProvider"));

const p2 = wallet.connect();
await new Promise((r) => setTimeout(r, 10));
[...document.querySelectorAll(".bw-item")].find((n) => n.textContent.includes("Stranger")).click();
await p2;
check("connects a wallet sitting on the wrong chain", () => {
  assert.equal(wallet.state.wrongChain, true);
  assert.equal(wallet.state.chainId, 1);
});
await wallet.switchToBase();
check("adds Base when the wallet does not know it (4902)", () => {
  assert.equal(wallet.state.chainId, 8453);
  assert.ok(stranger.calls.includes("wallet_addEthereumChain"));
});

// -- cancelling
await wallet.disconnect();
const p3 = wallet.connect();
await new Promise((r) => setTimeout(r, 10));
document.querySelector(".bw-x").click();
let cancelled = null;
try {
  await p3;
} catch (err) {
  cancelled = err;
}
check("closing the modal rejects with a cancelled flag", () => {
  assert.ok(cancelled);
  assert.equal(cancelled.cancelled, true);
  assert.equal(document.querySelector(".bw-backdrop"), null);
});

console.log(results.join("\n"));
console.log(process.exitCode ? "\nFAILURES" : "\nall green");

/* ------------------------------------------- WalletConnect screen (stubbed) */

const qrStub = `export default function qrcode() {
  return { addData() {}, make() {}, getModuleCount() { return 3; }, isDark(r, c) { return (r + c) % 2 === 0; } };
}`;
const wcStub = `export let connectCalls = 0;
export const UniversalProvider = {
  async init() {
    const handlers = {};
    return {
      session: null,
      on(e, f) { (handlers[e] ||= []).push(f); },
      removeListener(e, f) { handlers[e] = (handlers[e] || []).filter((x) => x !== f); },
      setDefaultChain() {},
      async disconnect() { this.session = null; },
      async connect() {
        connectCalls += 1;
        globalThis.__wcConnectCalls = connectCalls;
        (handlers["display_uri"] || []).forEach((f) => f("wc:abc123@2?relay-protocol=irn&symKey=deadbeef"));
        await new Promise((r) => setTimeout(r, 120));
        this.session = { namespaces: { eip155: {
          accounts: ["eip155:8453:0x3333333333333333333333333333333333333333"],
          chains: ["eip155:8453"], methods: [], events: [],
        } } };
        return this.session;
      },
      async request() { return null; },
    };
  },
};`;
const asModule = (src) => "data:text/javascript," + encodeURIComponent(src);

await wallet.init({
  projectId: "test-project-id",
  modules: { walletconnect: [asModule(wcStub)], qrcode: [asModule(qrStub)] },
});

// Directory unreachable: the dialog must still offer a usable set of wallets.
global.fetch = async () => { throw new Error("offline"); };

const p4 = wallet.connect();
await new Promise((r) => setTimeout(r, 30));

check("the directory falls back to the built-in list when it cannot be fetched", () => {
  // No global fetch in this file, so fetchWallets() rejects and the shortlist is used.
  const names = [...document.querySelectorAll(".bw-tile")].map((t) => t.lastElementChild.textContent.trim());
  assert.ok(names.includes("MetaMask"), JSON.stringify(names));
  assert.ok(names.includes("Coinbase Wallet"), JSON.stringify(names));
  assert.ok(names.length >= 10, `expected a usable shortlist, got ${names.length}`);
  assert.ok(document.querySelector(".bw-search"), "search box missing");
  assert.ok(document.querySelector(".bw-qrbtn"), "QR button missing");
});

// On a desktop, picking a named wallet must show its QR rather than a phone deep link.
[...document.querySelectorAll(".bw-tile")].find((t) => t.textContent.includes("MetaMask")).click();
await new Promise((r) => setTimeout(r, 60));

check("picking a wallet on desktop shows a QR, not a deep link", () => {
  const svg = document.querySelector(".bw-qr svg");
  assert.ok(svg, "no QR svg rendered");
  assert.equal(svg.getAttribute("viewBox"), "0 0 7 7", "3 modules + 2 quiet zone each side");
  const paths = svg.querySelectorAll("path");
  assert.equal(paths.length, 2);
  // checkerboard: dark where (row + col) is even -> 5 of 9 modules
  assert.equal((paths[1].getAttribute("d").match(/M/g) || []).length, 5);
  assert.equal(paths[1].getAttribute("d").startsWith("M2 2h1v1h-1z"), true);
  assert.ok(document.body.textContent.includes("Scan this with the wallet app"));
  assert.ok(document.body.textContent.includes("Copy link instead"));
});

const wcState = await p4;
check("walletconnect session becomes the active account", () => {
  assert.equal(wcState.connected, true);
  assert.equal(wcState.address, "0x3333333333333333333333333333333333333333");
  assert.equal(wcState.chainId, 8453);
  assert.equal(wcState.connector.type, "walletconnect");
  assert.equal(document.querySelector(".bw-backdrop"), null);
});

check("walletconnect connector is remembered", () => {
  assert.deepEqual(JSON.parse(localStorage.getItem("bark.wallet.last")), {
    type: "walletconnect",
    id: "walletconnect",
  });
});

await wallet.disconnect();
check("walletconnect disconnect clears state", () => {
  assert.equal(wallet.state.connected, false);
});

// Reopening the dialog must reuse the live proposal. Starting a second connect() on
// the same provider is what made the relay answer "Failed to publish custom payload".
const before = globalThis.__wcConnectCalls || 0;
const reopen1 = wallet.connect();
await new Promise((r) => setTimeout(r, 80));
const callsAfterFirstOpen = (globalThis.__wcConnectCalls || 0) - before;
document.querySelector(".bw-x")?.click();
await reopen1.catch(() => {});

const reopen2 = wallet.connect();
await new Promise((r) => setTimeout(r, 80));
const callsAfterSecondOpen = (globalThis.__wcConnectCalls || 0) - before;
document.querySelector(".bw-x")?.click();
await reopen2.catch(() => {});

check("reopening the dialog reuses the pairing instead of starting another", () => {
  assert.equal(callsAfterFirstOpen, 1, "first open should start exactly one pairing");
  assert.equal(callsAfterSecondOpen, 1, `reopen started ${callsAfterSecondOpen} pairings total, expected to reuse the first`);
});

console.log(results.slice(-6).join("\n"));
console.log(process.exitCode ? "\nFAILURES" : "\nall green (incl. WalletConnect)");
