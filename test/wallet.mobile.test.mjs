/** Same modal, but on a phone: deep links instead of a QR code. */
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const dom = new JSDOM(`<!doctype html><html><body></body></html>`, { url: "https://claim.bark.test/" });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, "navigator", {
  value: { userAgent: UA, clipboard: { writeText: async () => {} } },
  configurable: true,
});
global.localStorage = dom.window.localStorage;
global.Event = dom.window.Event;
global.CustomEvent = dom.window.CustomEvent;

const { wallet } = await import("../wallet.js");

const wcStub = `export const UniversalProvider = { async init() {
  const h = {};
  return {
    session: null,
    on(e, f) { (h[e] ||= []).push(f); },
    removeListener(e, f) { h[e] = (h[e] || []).filter((x) => x !== f); },
    setDefaultChain() {}, async disconnect() {},
    async connect() {
      (h["display_uri"] || []).forEach((f) => f("wc:a1@2?relay-protocol=irn&symKey=beef"));
      await new Promise((r) => setTimeout(r, 120));
      this.session = { namespaces: { eip155: { accounts: ["eip155:8453:0x4444444444444444444444444444444444444444"], chains: ["eip155:8453"] } } };
      return this.session;
    },
    async request() { return null; },
  };
} };`;

await wallet.init({ projectId: "pid", modules: { walletconnect: ["data:text/javascript," + encodeURIComponent(wcStub)] } });

const pending = wallet.connect();
await new Promise((r) => setTimeout(r, 10));
[...document.querySelectorAll(".bw-item")].find((n) => n.textContent.includes("WalletConnect")).click();
await new Promise((r) => setTimeout(r, 40));

const links = [...document.querySelectorAll(".bw-grid a")];
assert.ok(links.length >= 8, `expected deep links, got ${links.length}`);
const byName = Object.fromEntries(links.map((a) => [a.lastElementChild.textContent.trim(), a.getAttribute("href")]));
assert.equal(byName.MetaMask, "https://metamask.app.link/wc?uri=wc%3Aa1%402%3Frelay-protocol%3Dirn%26symKey%3Dbeef");
assert.equal(byName.Coinbase, "https://go.cb-w.com/wc?uri=wc%3Aa1%402%3Frelay-protocol%3Dirn%26symKey%3Dbeef");
assert.ok(byName.Rainbow.startsWith("https://rnbwapp.com/wc?uri=wc%3A"));
assert.ok(byName.Trust.startsWith("https://link.trustwallet.com/wc?uri="));
assert.equal(document.querySelector(".bw-qr"), null, "phones get deep links, not a QR");
assert.ok(document.body.textContent.includes("Copy connection link"));
console.log("  ok  mobile shows", links.length, "deep links with an encoded wc: uri");
console.log("  ok  no QR code on mobile, copy-link fallback present");

const state = await pending;
assert.equal(state.address, "0x4444444444444444444444444444444444444444");
console.log("  ok  mobile walletconnect connect resolves");
console.log("\nall green (mobile)");
