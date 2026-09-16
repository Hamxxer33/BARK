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
    setDefaultChain() {}, async disconnect() { this.session = null; },
    async connect() {
      (h["display_uri"] || []).forEach((f) => f("wc:a1@2?relay-protocol=irn&symKey=beef"));
      await new Promise((r) => setTimeout(r, 120));
      this.session = { namespaces: { eip155: { accounts: ["eip155:8453:0x4444444444444444444444444444444444444444"], chains: ["eip155:8453"] } } };
      return this.session;
    },
    async request() { return null; },
  };
} };`;

// The wallet directory, as the Reown explorer would answer it.
const REGISTRY_URL = "https://explorer-api.walletconnect.com/v3/wallets";
const fetchCalls = [];
global.fetch = async (url) => {
  fetchCalls.push(String(url));
  if (!String(url).startsWith(REGISTRY_URL)) throw new Error("unexpected fetch " + url);
  return {
    ok: true,
    async json() {
      return {
        count: 3,
        listings: {
          a: { id: "a", name: "MetaMask", image_id: "img-mm", order: 10, rdns: "io.metamask", mobile: { native: "metamask://", universal: "https://metamask.app.link" } },
          b: { id: "b", name: "Trust Wallet", image_id: "img-tw", order: 20, mobile: { native: "", universal: "https://link.trustwallet.com" } },
          c: { id: "c", name: "Zerion", image_id: "img-z", order: 5, mobile: { native: "zerion:", universal: "" } },
          d: { id: "d", name: "No Links", image_id: "img-n", order: 1, mobile: { native: "", universal: "" } },
        },
      };
    },
  };
};

// Safari hand-off replaces the page location; capture it instead of navigating.
// jsdom's window.location is not configurable, so shadow it on the global wallet.js reads.
let navigatedTo = "";
const fakeLocation = new Proxy({ href: "https://claim.bark.test/", origin: "https://claim.bark.test" }, {
  set(target, key, value) {
    if (key === "href") navigatedTo = value;
    target[key] = value;
    return true;
  },
});
global.window = new Proxy(dom.window, {
  get(target, key) {
    if (key === "location") return fakeLocation;
    const value = target[key];
    return typeof value === "function" ? value.bind(target) : value;
  },
  set(target, key, value) {
    target[key] = value;
    return true;
  },
});

await wallet.init({ projectId: "pid", modules: { walletconnect: ["data:text/javascript," + encodeURIComponent(wcStub)] } });

const pending = wallet.connect();
await new Promise((r) => setTimeout(r, 30));

const tiles = [...document.querySelectorAll(".bw-tile")];
const names = tiles.map((t) => t.lastElementChild.textContent.trim());
assert.deepEqual(names, ["Zerion", "MetaMask", "Trust Wallet"], "sorted by order, link-less wallet dropped");
console.log("  ok  grid lists directory wallets in order, skipping ones with no deep link");

const logo = tiles[1].querySelector("img");
assert.equal(logo.getAttribute("src"), "https://explorer-api.walletconnect.com/v3/logo/md/img-mm?projectId=pid");
console.log("  ok  tiles use the real wallet logos from the directory");

assert.ok(fetchCalls[0].includes("platform=ios"), "iOS should ask for iOS wallets: " + fetchCalls[0]);
assert.ok(fetchCalls[0].includes("projectId=pid"));
console.log("  ok  directory request is scoped to the platform and project");

// search
const search = document.querySelector(".bw-search");
search.value = "trust";
search.dispatchEvent(new dom.window.Event("input"));
const filtered = [...document.querySelectorAll(".bw-tile")].map((t) => t.lastElementChild.textContent.trim());
assert.deepEqual(filtered, ["Trust Wallet"]);
search.value = "zzz";
search.dispatchEvent(new dom.window.Event("input"));
assert.match(document.querySelector(".bw-empty").textContent, /No wallet matches/);
search.value = "";
search.dispatchEvent(new dom.window.Event("input"));
console.log("  ok  search filters the grid and reports an empty result");

// Tapping a wallet must navigate *inside the tap*: iOS drops a custom-scheme
// navigation that happens a tick later, which is why the link is pre-generated.
[...document.querySelectorAll(".bw-tile")].find((t) => t.textContent.includes("MetaMask")).click();
assert.equal(
  navigatedTo,
  "metamask://wc?uri=wc%3Aa1%402%3Frelay-protocol%3Dirn%26symKey%3Dbeef",
  "deep link must fire synchronously in the click handler, not after an await",
);
console.log("  ok  tapping a wallet opens it synchronously, inside the user gesture");
await new Promise((r) => setTimeout(r, 20));
assert.match(document.body.textContent, /Continue in MetaMask/);
assert.match(document.body.textContent, /Show QR code instead/);
console.log("  ok  hand-off screen offers a retry and a QR fallback");

const state = await pending;
assert.equal(state.address, "0x4444444444444444444444444444444444444444");

// Zerion advertises "zerion:" (one colon) and Trust has no native scheme at all.
navigatedTo = "";
await wallet.disconnect();
const again = wallet.connect();
await new Promise((r) => setTimeout(r, 30));
[...document.querySelectorAll(".bw-tile")].find((t) => t.textContent.includes("Zerion")).click();
await new Promise((r) => setTimeout(r, 40));
assert.ok(navigatedTo.startsWith("zerion://wc?uri=wc%3A"), "single-colon scheme: " + navigatedTo);
console.log("  ok  a 'scheme:' wallet is normalised to scheme://wc?uri=");
await again;

navigatedTo = "";
await wallet.disconnect();
const third = wallet.connect();
await new Promise((r) => setTimeout(r, 30));
[...document.querySelectorAll(".bw-tile")].find((t) => t.textContent.includes("Trust")).click();
await new Promise((r) => setTimeout(r, 40));
assert.equal(navigatedTo, "https://link.trustwallet.com/wc?uri=wc%3Aa1%402%3Frelay-protocol%3Dirn%26symKey%3Dbeef");
console.log("  ok  a wallet with only a universal link still hands off");
await third;
console.log("  ok  mobile walletconnect connect resolves");
console.log("\nall green (mobile)");
