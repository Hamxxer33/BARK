/**
 * Wallet connection for the BARK claim page.
 *
 * Two kinds of connectors:
 *   injected       — browser extensions and in-app browsers, discovered with EIP-6963
 *   walletconnect  — WalletConnect v2, so phone wallets can scan a QR or deep link in
 *
 * No framework, no bundler. The WalletConnect client is loaded from a CDN the first
 * time someone picks it, so people on an extension never pay for that download.
 */

const CHAIN_ID = 8453;
const CHAIN_HEX = "0x2105";
const STORAGE_KEY = "bark.wallet.last";

const BASE_CHAIN_PARAMS = {
  chainId: CHAIN_HEX,
  chainName: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://mainnet.base.org"],
  blockExplorerUrls: ["https://basescan.org"],
};

const WC_METHODS = [
  "eth_sendTransaction",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v4",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  "wallet_watchAsset",
];


/**
 * Loaded on demand, first URL that answers wins. `wallet.init({ modules })` can point
 * these at self-hosted copies for a deployment with a strict script-src.
 */
const CDN = {
  walletconnect: [
    "https://cdn.jsdelivr.net/npm/@walletconnect/universal-provider@2.25.0/+esm",
    "https://esm.sh/@walletconnect/universal-provider@2.25.0",
  ],
  qrcode: [
    "https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/+esm",
    "https://esm.sh/qrcode-generator@2.0.4",
  ],
};

async function loadModule(name) {
  const urls = config.modules?.[name] || CDN[name];
  let lastError;
  for (const url of urls) {
    try {
      return await import(/* webpackIgnore: true */ url);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`Could not load ${name}`);
}

/* ------------------------------------------------------------------ state */

let config = { projectId: "", appName: "BARK", appUrl: "", appIcon: "" };
let provider = null; // the live EIP-1193 provider, whichever connector won
let connector = null; // { type, name, icon }
let account = "";
let chainId = 0;
let wcProvider = null; // cached UniversalProvider instance
let wcInitPromise = null;

const listeners = new Set();

function snapshot() {
  return {
    connected: Boolean(account),
    address: account,
    chainId,
    wrongChain: Boolean(account) && chainId !== CHAIN_ID,
    connector: connector ? { type: connector.type, name: connector.name, icon: connector.icon } : null,
  };
}

function emit() {
  const state = snapshot();
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      console.error(err);
    }
  }
}

function remember(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

function recall() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- discovery */

const injectedProviders = new Map(); // rdns -> { info, provider }

function announceHandler(event) {
  const detail = event.detail;
  if (!detail?.info?.rdns || !detail.provider) return;
  injectedProviders.set(detail.info.rdns, detail);
}

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", announceHandler);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

function listInjected() {
  const found = [...injectedProviders.values()].map((entry) => ({
    type: "injected",
    id: entry.info.rdns,
    name: entry.info.name,
    icon: entry.info.icon,
    provider: entry.provider,
  }));
  // Wallets that predate EIP-6963 only ever set window.ethereum.
  if (!found.length && typeof window !== "undefined" && window.ethereum) {
    const eth = window.ethereum;
    const name = eth.isCoinbaseWallet
      ? "Coinbase Wallet"
      : eth.isRabby
        ? "Rabby"
        : eth.isMetaMask
          ? "MetaMask"
          : "Browser Wallet";
    found.push({ type: "injected", id: "window.ethereum", name, icon: "", provider: eth });
  }
  return found;
}

/* ------------------------------------------------------------ wire events */

let boundProvider = null;
let boundHandlers = null;

function unbind() {
  if (boundProvider && boundHandlers) {
    for (const [event, handler] of Object.entries(boundHandlers)) {
      try {
        boundProvider.removeListener?.(event, handler);
      } catch {}
    }
  }
  boundProvider = null;
  boundHandlers = null;
}

function bind(target) {
  unbind();
  boundHandlers = {
    accountsChanged: (accounts) => {
      const next = accounts?.[0] || "";
      if (!next) {
        reset();
        return;
      }
      account = next;
      emit();
    },
    chainChanged: (value) => {
      chainId = Number(value);
      emit();
    },
    disconnect: () => reset(),
    // WalletConnect's name for "the user hung up from the phone".
    session_delete: () => reset(),
  };
  for (const [event, handler] of Object.entries(boundHandlers)) {
    try {
      target.on?.(event, handler);
    } catch {}
  }
  boundProvider = target;
}

function reset() {
  unbind();
  provider = null;
  connector = null;
  account = "";
  chainId = 0;
  remember(null);
  emit();
}

async function adopt(target, meta) {
  const accounts = await target.request({ method: "eth_accounts" });
  if (!accounts?.length) throw new Error("Wallet returned no accounts");
  let currentChain = 0;
  try {
    currentChain = Number(await target.request({ method: "eth_chainId" }));
  } catch {}
  provider = target;
  connector = meta;
  account = accounts[0];
  chainId = currentChain;
  bind(target);
  remember({ type: meta.type, id: meta.id });
  emit();
  return snapshot();
}

/* --------------------------------------------------------- walletconnect */

async function getWalletConnect() {
  if (wcProvider) return wcProvider;
  if (wcInitPromise) return wcInitPromise;
  if (!config.projectId) {
    throw new Error(
      "WalletConnect is not configured on this deployment (WALLETCONNECT_PROJECT_ID is missing).",
    );
  }
  wcInitPromise = (async () => {
    const mod = await loadModule("walletconnect");
    const UniversalProvider = mod.UniversalProvider || mod.default?.UniversalProvider || mod.default;
    const instance = await UniversalProvider.init({
      projectId: config.projectId,
      metadata: {
        name: config.appName,
        description: "Claim BARK on Base — 70 BARK per on-chain transaction.",
        url: config.appUrl || window.location.origin,
        icons: config.appIcon ? [config.appIcon] : [],
      },
    });
    wcProvider = instance;
    return instance;
  })();
  try {
    return await wcInitPromise;
  } finally {
    wcInitPromise = null;
  }
}

/**
 * UniversalProvider.request() wants the caller to name a chain, and a few wallet-scoped
 * methods are not part of the session namespace at all. This keeps the rest of the app
 * talking plain EIP-1193.
 */
function wrapWalletConnect(instance) {
  return {
    isWalletConnect: true,
    on: (...args) => instance.on(...args),
    removeListener: (...args) => instance.removeListener(...args),
    async request(args) {
      if (args.method === "eth_accounts") {
        const accounts = instance.session?.namespaces?.eip155?.accounts || [];
        return accounts.map((value) => value.split(":")[2]).filter(Boolean);
      }
      if (args.method === "eth_chainId") {
        const [namespace] = instance.session?.namespaces?.eip155?.chains || [];
        return namespace ? `0x${Number(namespace.split(":")[1]).toString(16)}` : CHAIN_HEX;
      }
      return instance.request(args, `eip155:${CHAIN_ID}`);
    },
  };
}

let pairing = null;

/**
 * One live pairing per page. The dialog can open, close and reopen freely: it
 * subscribes to the same proposal rather than starting another, because two
 * concurrent connect() calls on one provider make the relay fail the publish
 * ("Failed to publish custom payload").
 */
function sharedPairing() {
  if (pairing) return pairing;
  const subscribers = new Set();
  const entry = {
    uri: "",
    onUri(fn) {
      subscribers.add(fn);
      if (entry.uri) fn(entry.uri);
      return () => subscribers.delete(fn);
    },
  };
  entry.promise = connectWalletConnect((uri) => {
    entry.uri = uri;
    for (const fn of [...subscribers]) fn(uri);
  }).finally(() => {
    if (pairing === entry) pairing = null;
  });
  // A rejection is always handled by whichever dialog is open; this keeps a
  // closed-dialog rejection from surfacing as an unhandled promise.
  entry.promise.catch(() => {});
  return (pairing = entry);
}

/** Friendlier text for the relay's internal wording. */
function pairingErrorText(err) {
  const raw = err?.message || "";
  if (/Proposal expired/i.test(raw)) return "That request expired. Pick your wallet again.";
  if (/publish|relay|socket|network/i.test(raw)) return "Lost the WalletConnect relay. Tap your wallet to try again.";
  if (/rejected|User disapproved|cancel/i.test(raw)) return "The wallet rejected the connection.";
  return raw || "WalletConnect failed";
}

async function connectWalletConnect(onUri) {
  const instance = await getWalletConnect();

  if (instance.session) {
    const wrapped = wrapWalletConnect(instance);
    try {
      return await adopt(wrapped, { type: "walletconnect", id: "walletconnect", name: "WalletConnect", icon: "" });
    } catch {
      await instance.disconnect().catch(() => {});
    }
  }

  const handleUri = (uri) => onUri?.(uri);
  instance.on("display_uri", handleUri);
  try {
    await instance.connect({
      optionalNamespaces: {
        eip155: {
          methods: WC_METHODS,
          chains: [`eip155:${CHAIN_ID}`],
          events: ["chainChanged", "accountsChanged"],
        },
      },
    });
  } finally {
    instance.removeListener("display_uri", handleUri);
  }

  try {
    instance.setDefaultChain?.(`eip155:${CHAIN_ID}`);
  } catch {}

  const wrapped = wrapWalletConnect(instance);
  return adopt(wrapped, { type: "walletconnect", id: "walletconnect", name: "WalletConnect", icon: "" });
}

/* -------------------------------------------------------- wallet registry */

const REGISTRY = "https://explorer-api.walletconnect.com/v3";
let registryCache = null;

const isMobile = () =>
  typeof navigator !== "undefined" && /android|iphone|ipad|ipod/i.test(navigator.userAgent);
const isAndroid = () => typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);

/**
 * The same wallet directory AppKit shows: a few hundred wallets with real logos and
 * the deep-link scheme each one answers on. Needs the project ID, so when that is
 * missing (or the call fails) we fall back to the shortlist below.
 */
async function fetchWallets() {
  if (registryCache) return registryCache;
  const params = new URLSearchParams({
    projectId: config.projectId,
    entries: "100",
    page: "1",
  });
  if (isMobile()) params.set("platform", isAndroid() ? "android" : "ios");

  // Don't leave people watching a spinner if the directory is slow or unreachable.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 6000);
  let res;
  try {
    res = await fetch(`${REGISTRY}/wallets?${params}`, { signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Wallet directory returned ${res.status}`);
  const body = await res.json();
  // v3 hands back an object keyed by wallet id; tolerate an array too.
  const rows = Array.isArray(body.listings) ? body.listings : Object.values(body.listings || {});

  registryCache = rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      image: row.image_id ? `${REGISTRY}/logo/md/${row.image_id}?projectId=${config.projectId}` : "",
      native: row.mobile?.native || "",
      universal: row.mobile?.universal || "",
      rdns: row.rdns || "",
      order: typeof row.order === "number" ? row.order : 1e6,
    }))
    .filter((row) => row.name && (row.native || row.universal))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  if (!registryCache.length) throw new Error("Wallet directory came back empty");
  return registryCache;
}

/** Used when the directory cannot be reached, so the dialog is never empty. */
const FALLBACK_WALLETS = [
  { id: "metamask", name: "MetaMask", native: "metamask://", universal: "https://metamask.app.link" },
  { id: "coinbase", name: "Coinbase Wallet", native: "cbwallet://", universal: "https://go.cb-w.com" },
  { id: "rainbow", name: "Rainbow", native: "rainbow://", universal: "https://rnbwapp.com" },
  { id: "trust", name: "Trust Wallet", native: "trust://", universal: "https://link.trustwallet.com" },
  { id: "uniswap", name: "Uniswap", native: "uniswap://", universal: "https://uniswap.org/app" },
  { id: "zerion", name: "Zerion", native: "zerion://", universal: "https://wallet.zerion.io" },
  { id: "phantom", name: "Phantom", native: "phantom://", universal: "https://phantom.app/ul" },
  { id: "okx", name: "OKX Wallet", native: "okx://", universal: "https://www.okx.com/download" },
  { id: "bitget", name: "Bitget Wallet", native: "bitkeep://", universal: "https://bkcode.vip" },
  { id: "safepal", name: "SafePal", native: "safepalwallet://", universal: "https://link.safepal.io" },
  { id: "tokenpocket", name: "TokenPocket", native: "tpoutside://", universal: "https://tokenpocket.pro" },
  { id: "ledger", name: "Ledger Live", native: "ledgerlive://", universal: "https://ledger.com/ledger-live" },
].map((row) => ({ ...row, image: "", rdns: "", order: 0 }));

/**
 * Turns a pairing URI into a link that opens the wallet app. Native schemes are tried
 * first — a universal link can bounce to the App Store page instead of the app.
 */
function walletDeepLink(entry, uri) {
  const encoded = encodeURIComponent(uri);
  const scheme = entry.native || "";
  if (scheme) {
    const base = scheme.endsWith("://") ? scheme : scheme.endsWith(":") ? `${scheme}//` : `${scheme}://`;
    return `${base}wc?uri=${encoded}`;
  }
  if (entry.universal) return `${entry.universal.replace(/\/+$/, "")}/wc?uri=${encoded}`;
  return "";
}

/* ----------------------------------------------------------------- modal */

const STYLES = `
.bw-backdrop { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 1.25rem; background: rgb(3 5 10 / 0.72); backdrop-filter: blur(6px); }
.bw-modal { width: 100%; max-width: 23rem; max-height: min(88dvh, 44rem); overflow-y: auto; border-radius: 0.9rem; background: var(--surface, #0e121c); color: var(--fg, #eef3f8); box-shadow: 0 0 0 1px rgb(255 255 255 / 0.1), 0 24px 60px rgb(0 0 0 / 0.55); }
.bw-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 1rem 1rem 0.5rem; }
.bw-title { font-family: var(--font-display, inherit); font-size: 1.1rem; font-weight: 600; letter-spacing: 0.03em; }
.bw-x { display: grid; place-items: center; width: 1.9rem; height: 1.9rem; border: 0; border-radius: 0.5rem; background: var(--surface-2, #161c28); color: var(--muted, #8b93a7); font-size: 1rem; line-height: 1; cursor: pointer; }
.bw-x:hover { color: var(--fg, #eef3f8); }
.bw-body { padding: 0.25rem 1rem 1rem; }
.bw-hint { margin: 0.15rem 0 0.75rem; font-size: 0.8rem; line-height: 1.5; color: var(--muted, #8b93a7); }
.bw-list { display: flex; flex-direction: column; gap: 0.5rem; }
.bw-item { display: flex; align-items: center; gap: 0.7rem; width: 100%; border: 0; border-radius: 0.6rem; background: var(--surface-2, #161c28); color: var(--fg, #eef3f8); padding: 0.75rem 0.85rem; font: inherit; font-size: 0.95rem; text-align: left; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.06); cursor: pointer; }
.bw-item:hover:not(:disabled) { box-shadow: 0 0 0 1px rgb(61 220 255 / 0.4); }
.bw-item:disabled { opacity: 0.45; cursor: not-allowed; }
.bw-item .bw-sub { display: block; font-size: 0.72rem; color: var(--muted, #8b93a7); }
.bw-ico { display: grid; place-items: center; flex: none; width: 1.9rem; height: 1.9rem; border-radius: 0.45rem; overflow: hidden; background: #0b0f18; font-size: 0.75rem; font-weight: 700; }
.bw-ico img { width: 100%; height: 100%; object-fit: cover; }
.bw-sep { margin: 0.9rem 0 0.6rem; font-size: 0.68rem; font-weight: 500; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted, #8b93a7); }
.bw-qr { display: grid; place-items: center; margin: 0 auto; width: fit-content; padding: 0.75rem; border-radius: 0.7rem; background: #fff; }
.bw-qr svg { display: block; width: 13.5rem; height: 13.5rem; }
.bw-uri { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
.bw-err { margin-top: 0.75rem; font-size: 0.82rem; line-height: 1.5; color: var(--danger, #ff5c7a); word-break: break-word; }
.bw-spin { display: inline-block; width: 0.85rem; height: 0.85rem; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: bw-rotate 0.7s linear infinite; }
@keyframes bw-rotate { to { transform: rotate(360deg); } }
.bw-tools { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; }
.bw-search { flex: 1; min-width: 0; border: 0; border-radius: 0.6rem; background: var(--surface-2, #161c28); color: var(--fg, #eef3f8); padding: 0.7rem 0.85rem; font: inherit; font-size: 0.9rem; outline: none; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.06); }
.bw-search::placeholder { color: var(--muted, #8b93a7); }
.bw-search:focus { box-shadow: 0 0 0 1px rgb(61 220 255 / 0.45); }
.bw-qrbtn { display: grid; place-items: center; flex: none; width: 2.7rem; border: 0; border-radius: 0.6rem; background: var(--surface-2, #161c28); color: var(--fg, #eef3f8); cursor: pointer; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.06); }
.bw-qrbtn:hover, .bw-qrbtn[aria-pressed="true"] { box-shadow: 0 0 0 1px rgb(61 220 255 / 0.45); }
.bw-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.5rem; }
.bw-tile { display: flex; flex-direction: column; align-items: center; gap: 0.45rem; border: 0; border-radius: 0.7rem; background: var(--surface-2, #161c28); color: var(--fg, #eef3f8); padding: 0.8rem 0.4rem; font: inherit; cursor: pointer; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.06); }
.bw-tile:hover { box-shadow: 0 0 0 1px rgb(61 220 255 / 0.4); }
.bw-tile span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.73rem; }
.bw-logo { display: grid; place-items: center; width: 3rem; height: 3rem; border-radius: 0.75rem; overflow: hidden; background: #0b0f18; font-size: 1.1rem; font-weight: 700; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.06); }
.bw-logo img { width: 100%; height: 100%; object-fit: cover; }
.bw-badge { position: relative; }
.bw-badge::after { content: ""; position: absolute; right: -2px; bottom: -2px; width: 0.85rem; height: 0.85rem; border-radius: 50%; background: #3396ff; box-shadow: 0 0 0 2px var(--surface-2, #161c28); }
.bw-scroll { max-height: 22rem; overflow-y: auto; margin: 0 -0.25rem; padding: 0 0.25rem; }
.bw-empty { padding: 1.5rem 0; text-align: center; font-size: 0.85rem; color: var(--muted, #8b93a7); }
`;

let styleInjected = false;

function ensureStyles() {
  if (styleInjected) return;
  const tag = document.createElement("style");
  tag.textContent = STYLES;
  document.head.appendChild(tag);
  styleInjected = true;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.appendChild(child);
  return node;
}

function walletIcon(name, icon) {
  if (icon) return el("span", { class: "bw-ico" }, [el("img", { src: icon, alt: "" })]);
  return el("span", { class: "bw-ico", text: (name || "?").slice(0, 1).toUpperCase() });
}

function qrSvg(matrix) {
  const count = matrix.getModuleCount();
  const quiet = 2;
  const size = count + quiet * 2;
  let path = "";
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (matrix.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="WalletConnect QR code"><path fill="#fff" d="M0 0h${size}v${size}H0z"/><path fill="#05060a" d="${path}"/></svg>`;
}

function openModal() {
  ensureStyles();

  let settled = false;
  let resolve;
  let reject;
  const done = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const body = el("div", { class: "bw-body" });
  const modal = el("div", { class: "bw-modal", role: "dialog", "aria-modal": "true", "aria-label": "Connect a wallet" }, [
    el("div", { class: "bw-head" }, [
      el("div", { class: "bw-title", text: "Connect wallet" }),
      el("button", { class: "bw-x", type: "button", "aria-label": "Close", text: "✕", onclick: () => close() }),
    ]),
    body,
  ]);
  const backdrop = el("div", {
    class: "bw-backdrop",
    onclick: (event) => {
      if (event.target === backdrop) close();
    },
  }, [modal]);

  function onKey(event) {
    if (event.key === "Escape") close();
  }

  function close(error) {
    if (settled) return;
    settled = true;
    unsubscribe?.();
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    if (error) reject(error);
    else reject(Object.assign(new Error("Connection cancelled"), { cancelled: true }));
  }

  function finish(state) {
    if (settled) return;
    settled = true;
    unsubscribe?.();
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    resolve(state);
  }

  document.addEventListener("keydown", onKey);
  document.body.appendChild(backdrop);

  const showError = (message) => {
    body.querySelector(".bw-err")?.remove();
    body.appendChild(el("p", { class: "bw-err", text: message }));
  };

  /* --- screen 1: installed wallets + the searchable directory --- */

  let query = "";

  /**
   * iOS Safari only follows a custom scheme while a real tap is still on the stack, and
   * the pairing URI takes a CDN load plus a relay handshake to arrive. So subscribe to
   * the shared pairing as soon as the dialog opens: by the time someone picks a wallet
   * the link is ready and the tap handler can navigate synchronously.
   */
  let pairingUri = "";
  let waitingFor = null; // wallet picked before the URI landed
  let unsubscribe = null;

  function beginPairing() {
    if (unsubscribe || !config.projectId) return;
    const entry = sharedPairing();
    unsubscribe = entry.onUri((uri) => {
      pairingUri = uri;
      if (waitingFor === null) return;
      const picked = waitingFor;
      waitingFor = null;
      if (picked === "qr") renderQr(uri);
      else handOff(picked, uri);
    });
    entry.promise.then(finish).catch((err) => {
      if (settled) return;
      unsubscribe?.();
      unsubscribe = null;
      pairingUri = "";
      waitingFor = null;
      renderPicker();
      showError(pairingErrorText(err));
    });
  }

  function renderPicker() {
    body.replaceChildren();

    const injected = listInjected();
    if (injected.length) {
      body.appendChild(el("p", { class: "bw-sep", text: "Installed" }));
      const list = el("div", { class: "bw-list" });
      for (const entry of injected) {
        list.appendChild(
          el("button", { class: "bw-item", type: "button", onclick: () => useInjected(entry) }, [
            walletIcon(entry.name, entry.icon),
            el("span", { text: entry.name }),
          ]),
        );
      }
      body.appendChild(list);
    }

    if (!config.projectId) {
      body.appendChild(
        el("p", {
          class: "bw-hint",
          text: injected.length
            ? "Other wallets need WalletConnect, which is not configured on this deployment."
            : "No wallet found in this browser, and WalletConnect is not configured on this deployment.",
        }),
      );
      return;
    }

    body.appendChild(el("p", { class: "bw-sep", text: injected.length ? "All wallets" : "Choose your wallet" }));

    const search = el("input", {
      class: "bw-search",
      type: "search",
      placeholder: "Search wallet",
      "aria-label": "Search wallet",
      value: query,
    });
    const qrButton = el("button", {
      class: "bw-qrbtn",
      type: "button",
      "aria-label": "Show QR code",
      html: '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M3 3h5v5H3V3zm1.5 1.5v2h2v-2h-2zM12 3h5v5h-5V3zm1.5 1.5v2h2v-2h-2zM3 12h5v5H3v-5zm1.5 1.5v2h2v-2h-2zM12 12h2v2h-2v-2zm3 0h2v2h-2v-2zm-3 3h2v2h-2v-2zm3 0h2v2h-2v-2z"/></svg>',
      onclick: () => {
        if (pairingUri) renderQr(pairingUri);
        else {
          waitingFor = "qr";
          renderWaiting(null);
        }
      },
    });
    body.appendChild(el("div", { class: "bw-tools" }, [search, qrButton]));

    const scroll = el("div", { class: "bw-scroll" });
    const tiles = el("div", { class: "bw-tiles" });
    scroll.appendChild(tiles);
    body.appendChild(scroll);

    let all = [];
    const paint = () => {
      const needle = query.trim().toLowerCase();
      const rows = needle
        ? all
            .filter((row) => row.name.toLowerCase().includes(needle))
            .sort((a, b) => {
              const rank = (n) => (n.toLowerCase().startsWith(needle) ? 0 : 1);
              return rank(a.name) - rank(b.name);
            })
        : all;
      tiles.replaceChildren();
      if (!rows.length) {
        tiles.appendChild(el("p", { class: "bw-empty", style: "grid-column:1/-1", text: needle ? `No wallet matches "${query}"` : "No wallets available" }));
        return;
      }
      for (const row of rows) {
        const logo = row.image
          ? el("span", { class: "bw-logo bw-badge" }, [el("img", { src: row.image, alt: "", loading: "lazy" })])
          : el("span", { class: "bw-logo bw-badge", text: row.name.slice(0, 1).toUpperCase() });
        tiles.appendChild(
          el("button", { class: "bw-tile", type: "button", title: row.name, onclick: () => choose(row) }, [
            logo,
            el("span", { text: row.name }),
          ]),
        );
      }
    };

    search.addEventListener("input", () => {
      query = search.value;
      paint();
    });

    // Show the shortlist at once so nobody waits on a spinner, then swap in the
    // full directory when it answers.
    all = FALLBACK_WALLETS;
    paint();
    beginPairing();

    fetchWallets()
      .then((rows) => {
        all = rows;
        paint();
      })
      .catch(() => {
        all = FALLBACK_WALLETS;
        paint();
      });
  }

  async function useInjected(entry) {
    body.replaceChildren(el("p", { class: "bw-hint", text: `Approve the connection in ${entry.name}…` }));
    try {
      await entry.provider.request({ method: "eth_requestAccounts" });
      const state = await adopt(entry.provider, {
        type: "injected",
        id: entry.id,
        name: entry.name,
        icon: entry.icon,
      });
      finish(state);
    } catch (err) {
      renderPicker();
      showError(err?.code === 4001 ? "Connection rejected in the wallet." : err?.message || "Could not connect");
    }
  }

  /* --- screen 2: pairing, as a QR code or a hand-off into the chosen app --- */

  function renderWaiting(entry) {
    const logo = entry?.image
      ? el("span", { class: "bw-logo" }, [el("img", { src: entry.image, alt: "" })])
      : null;
    body.replaceChildren(
      el("div", { style: "display:grid;place-items:center;gap:0.75rem;padding:1.25rem 0" }, [
        logo,
        el("p", { class: "bw-hint", style: "margin:0;text-align:center" }, [
          el("span", { class: "bw-spin" }),
          el("span", { text: entry ? ` Opening ${entry.name}…` : " Starting WalletConnect…" }),
        ]),
      ]),
    );
  }

  async function renderQr(uri) {
    body.replaceChildren(el("p", { class: "bw-hint", text: "Scan this with the wallet app on your phone." }));
    let drawn = false;
    try {
      const mod = await loadModule("qrcode");
      const qrcode = mod.default || mod;
      const matrix = qrcode(0, "L");
      matrix.addData(uri);
      matrix.make();
      body.appendChild(el("div", { class: "bw-qr", html: qrSvg(matrix) }));
      drawn = true;
    } catch {
      /* no QR library — the copy button below is the way through */
    }
    const copy = el("button", { class: "bw-item", type: "button", style: "justify-content:center" }, [
      el("span", { text: drawn ? "Copy link instead" : "Copy connection link" }),
    ]);
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(uri);
        copy.replaceChildren(el("span", { text: "Copied — paste it in your wallet" }));
      } catch {
        copy.replaceChildren(el("span", { text: `${uri.slice(0, 28)}…` }));
      }
    });
    body.appendChild(el("div", { class: "bw-uri" }, [copy]));
  }

  /**
   * Runs inside the tap. If the pairing link is already here we navigate right away,
   * which is the only way iOS opens the wallet app; otherwise we wait for it.
   */
  function choose(entry) {
    if (!isMobile()) {
      // Those schemes are phone-only; a desktop needs the code on screen.
      if (pairingUri) renderQr(pairingUri);
      else {
        waitingFor = "qr";
        renderWaiting(null);
      }
      return;
    }
    if (pairingUri) return handOff(entry, pairingUri);
    waitingFor = entry;
    renderWaiting(entry);
  }

  function handOff(entry, uri) {
    const link = walletDeepLink(entry, uri);
    if (!link) return renderQr(uri);

    window.location.href = link;

    body.replaceChildren(
      el("div", { style: "display:grid;place-items:center;gap:0.75rem;padding:1rem 0" }, [
        entry.image ? el("span", { class: "bw-logo" }, [el("img", { src: entry.image, alt: "" })]) : null,
        el("p", {
          class: "bw-hint",
          style: "margin:0;text-align:center",
          text: `Continue in ${entry.name}, then come back to this tab.`,
        }),
      ]),
    );
    const retry = el("button", { class: "bw-item", type: "button", style: "justify-content:center" }, [
      el("span", { text: `Open ${entry.name} again` }),
    ]);
    retry.addEventListener("click", () => {
      window.location.href = link;
    });
    const useQr = el("button", { class: "bw-item", type: "button", style: "justify-content:center" }, [
      el("span", { text: "Show QR code instead" }),
    ]);
    useQr.addEventListener("click", () => renderQr(uri));
    body.appendChild(el("div", { class: "bw-list", style: "margin-top:0.75rem" }, [retry, useQr]));
  }

  renderPicker();
  return done;
}

/* ------------------------------------------------------------------- api */

export const wallet = {
  chainId: CHAIN_ID,

  init(options = {}) {
    config = { ...config, ...options };
    return wallet.restore();
  },

  subscribe(fn) {
    listeners.add(fn);
    fn(snapshot());
    return () => listeners.delete(fn);
  },

  get state() {
    return snapshot();
  },

  /** Reconnects silently on page load — never pops a wallet prompt. */
  async restore() {
    const last = recall();
    if (!last) return snapshot();
    try {
      if (last.type === "injected") {
        // Give extensions a moment to announce themselves over EIP-6963.
        await new Promise((r) => setTimeout(r, 120));
        const entry = listInjected().find((item) => item.id === last.id) || listInjected()[0];
        if (!entry) return snapshot();
        const accounts = await entry.provider.request({ method: "eth_accounts" });
        if (!accounts?.length) return snapshot();
        return await adopt(entry.provider, {
          type: "injected",
          id: entry.id,
          name: entry.name,
          icon: entry.icon,
        });
      }
      if (last.type === "walletconnect" && config.projectId) {
        const instance = await getWalletConnect();
        if (!instance.session) return snapshot();
        return await adopt(wrapWalletConnect(instance), {
          type: "walletconnect",
          id: "walletconnect",
          name: "WalletConnect",
          icon: "",
        });
      }
    } catch {
      remember(null);
    }
    return snapshot();
  },

  connect() {
    return openModal();
  },

  async disconnect() {
    if (connector?.type === "walletconnect" && wcProvider?.session) {
      await wcProvider.disconnect().catch(() => {});
    }
    reset();
  },

  getProvider() {
    return provider;
  },

  request(args) {
    if (!provider) throw new Error("No wallet connected");
    return provider.request(args);
  },

  /** Moves the wallet onto Base, adding the network if the wallet has never seen it. */
  async switchToBase() {
    if (!provider) throw new Error("No wallet connected");
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
    } catch (err) {
      if (err?.code === 4902 || /unrecognized chain|not added|Unsupported chain/i.test(err?.message || "")) {
        await provider.request({ method: "wallet_addEthereumChain", params: [BASE_CHAIN_PARAMS] });
      } else if (err?.code === 4001) {
        throw new Error("Switch your wallet to Base to continue.");
      } else {
        throw err;
      }
    }
    try {
      chainId = Number(await provider.request({ method: "eth_chainId" }));
    } catch {
      chainId = CHAIN_ID;
    }
    emit();
    return chainId === CHAIN_ID;
  },

  /** Offers to add BARK to the wallet's token list. Best effort — never throws. */
  async watchAsset({ address, symbol, decimals = 18, image }) {
    if (!provider) return false;
    try {
      return Boolean(
        await provider.request({
          method: "wallet_watchAsset",
          params: { type: "ERC20", options: { address, symbol, decimals, image } },
        }),
      );
    } catch {
      return false;
    }
  },
};

export default wallet;
