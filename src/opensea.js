const { OpenSeaStreamClient, Network } = require("@opensea/stream-js");
const { WebSocket } = require("ws");

function shortenAddress(address = "") {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatUnits(rawValue, decimals = 18) {
  if (!rawValue) return "0";
  const value = BigInt(rawValue);
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = value % divisor;

  if (fraction === 0n) return whole.toString();

  const paddedFraction = fraction.toString().padStart(decimals, "0");
  const trimmedFraction = paddedFraction.replace(/0+$/, "").slice(0, 4);
  return `${whole}.${trimmedFraction}`;
}

function normalizedSymbol(symbol) {
  return String(symbol || "ETH").trim().toUpperCase();
}

function isEthLikeSymbol(symbol) {
  return ["ETH", "WETH"].includes(normalizedSymbol(symbol));
}

function ethValueForPayment(amount, symbol, ethPrice = 0) {
  const amountAsNumber = Number.parseFloat(amount);
  if (!Number.isFinite(amountAsNumber)) return 0;
  if (isEthLikeSymbol(symbol)) return amountAsNumber;

  const parsedEthPrice = Number.parseFloat(ethPrice || "0");
  return Number.isFinite(parsedEthPrice) && parsedEthPrice > 0
    ? amountAsNumber * parsedEthPrice
    : 0;
}

function normalizeTimestamp(value) {
  if (!value) return "";

  if (typeof value === "number") {
    return new Date(value * 1000).toISOString();
  }

  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    return new Date(Number(text) * 1000).toISOString();
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}

function timestampLegacyValues(value) {
  const values = new Set();
  if (value) values.add(String(value));

  const normalized = normalizeTimestamp(value);
  if (normalized) {
    values.add(normalized);
    values.add(normalized.replace(".000Z", ".000000Z"));
  }

  return Array.from(values);
}

function stableSaleId({ txHash, orderHash, itemId, timestamp }) {
  const required = [txHash, orderHash, itemId].filter(Boolean);
  if (required.length === 3) return required.join(":");
  return [txHash, orderHash, itemId, normalizeTimestamp(timestamp)].filter(Boolean).join(":");
}

function legacySaleIds({ txHash, orderHash, itemId, timestamp }) {
  return timestampLegacyValues(timestamp)
    .map((timestampValue) => [txHash, orderHash, itemId, timestampValue].filter(Boolean).join(":"))
    .filter(Boolean);
}

function collectionLabelFor(slug, collectionLabels = {}) {
  if (!slug) return "NFT";
  return collectionLabels[slug] || slug.replace(/-/g, " ").toUpperCase();
}

function etherscanTxUrl(txHash) {
  return txHash ? `https://etherscan.io/tx/${txHash}` : "";
}

const CHAIN_EXPLORERS = {
  abstract: "https://abscan.org/tx/",
  ape_chain: "https://apescan.io/tx/",
  arbitrum: "https://arbiscan.io/tx/",
  arbitrum_nova: "https://nova.arbiscan.io/tx/",
  avalanche: "https://snowtrace.io/tx/",
  base: "https://basescan.org/tx/",
  bsc: "https://bscscan.com/tx/",
  ethereum: "https://etherscan.io/tx/",
  klaytn: "https://scope.klaytn.com/tx/",
  optimism: "https://optimistic.etherscan.io/tx/",
  polygon: "https://polygonscan.com/tx/",
  solana: "https://solscan.io/tx/",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transactionUrl(chain, txHash) {
  if (!txHash) return "";
  return `${CHAIN_EXPLORERS[chain] || CHAIN_EXPLORERS.ethereum}${txHash}`;
}

function normalizeRestSaleEvent(event, options = {}) {
  const nft = event.nft || {};
  const payment = event.payment || {};
  const decimals = Number.isFinite(payment.decimals) ? payment.decimals : 18;
  const amount = formatUnits(payment.quantity, decimals);
  const amountAsNumber = Number.parseFloat(amount);
  const symbol = normalizedSymbol(payment.symbol);
  const txHash = event.transaction;
  const timestamp = event.event_timestamp || event.closing_date;
  const eventTimestamp = normalizeTimestamp(timestamp);
  const chain = event.chain || "ethereum";
  const collectionSlug = nft.collection || options.collectionSlug;
  const itemId = `${chain}/${nft.contract}/${nft.identifier}`;
  const saleIdParts = {
    txHash,
    orderHash: event.order_hash,
    itemId,
    timestamp,
  };

  return {
    id: stableSaleId(saleIdParts),
    legacyIds: legacySaleIds(saleIdParts),
    name: nft.name || nft.identifier || "NFT",
    collectionSlug,
    collectionName: collectionLabelFor(collectionSlug, options.collectionLabels),
    permalink: nft.opensea_url,
    imageUrl: nft.display_image_url || nft.image_url || nft.original_image_url,
    amount,
    amountNumber: amountAsNumber,
    symbol,
    ethValue: ethValueForPayment(amount, symbol, payment.eth_price),
    buyer: event.buyer,
    seller: event.seller,
    buyerShort: shortenAddress(event.buyer),
    sellerShort: shortenAddress(event.seller),
    txHash,
    txShort: shortenAddress(txHash),
    txUrl: transactionUrl(chain, txHash),
    txLabel: chain === "ethereum" ? "Etherscan" : "Tx",
    chain,
    eventTimestamp,
    raw: event,
  };
}

function normalizeSaleEvent(event, options = {}) {
  const payload = event.payload || {};
  const item = payload.item || {};
  const metadata = item.metadata || {};
  const token = payload.payment_token || {};
  const transaction = payload.transaction || {};
  const decimals = Number.isFinite(token.decimals) ? token.decimals : 18;
  const amount = formatUnits(payload.sale_price, decimals);
  const ethPrice = Number.parseFloat(token.eth_price || "0");
  const amountAsNumber = Number.parseFloat(amount);
  const symbol = normalizedSymbol(token.symbol);
  const timestamp = payload.event_timestamp || event.sent_at;
  const itemId = item.nft_id;
  const saleIdParts = {
    txHash: transaction.hash,
    orderHash: payload.order_hash,
    itemId,
    timestamp,
  };

  return {
    id: stableSaleId(saleIdParts),
    legacyIds: legacySaleIds(saleIdParts),
    name: metadata.name || item.nft_id || "NFT",
    collectionSlug: payload.collection && payload.collection.slug,
    collectionName: collectionLabelFor(
      payload.collection && payload.collection.slug,
      options.collectionLabels,
    ),
    permalink: item.permalink,
    imageUrl: metadata.image_url,
    amount,
    amountNumber: amountAsNumber,
    symbol,
    ethValue: ethValueForPayment(amount, symbol, ethPrice),
    buyer: payload.taker && payload.taker.address,
    seller: payload.maker && payload.maker.address,
    buyerShort: shortenAddress(payload.taker && payload.taker.address),
    sellerShort: shortenAddress(payload.maker && payload.maker.address),
    txHash: transaction.hash,
    txShort: shortenAddress(transaction.hash),
    txUrl: etherscanTxUrl(transaction.hash),
    txLabel: "Etherscan",
    eventTimestamp: normalizeTimestamp(timestamp),
    raw: event,
  };
}

function createOpenSeaSaleListener({
  apiKey,
  collectionSlugs,
  collectionLabels,
  onSale,
  onError,
}) {
  const client = new OpenSeaStreamClient({
    token: apiKey,
    network: Network.MAINNET,
    connectOptions: {
      transport: WebSocket,
    },
    onError,
  });

  collectionSlugs.forEach((collectionSlug) => {
    client.onItemSold(collectionSlug, (event) => {
      onSale(normalizeSaleEvent(event, { collectionLabels }));
    });
  });

  return client;
}

async function fetchCollectionSales(collectionSlug, options) {
  const sales = [];
  let next = null;
  const limit = options.limit || 200;

  do {
    const url = new URL(
      `https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(collectionSlug)}`,
    );
    url.searchParams.set("event_type", "sale");
    url.searchParams.set("after", String(options.after));
    url.searchParams.set("before", String(options.before));
    url.searchParams.set("limit", String(limit));
    if (next) url.searchParams.set("next", next);

    let response;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      response = await fetch(url, {
        headers: {
          accept: "application/json",
          "x-api-key": options.apiKey,
        },
      });

      if (response.status !== 429) break;
      await sleep(attempt * 2500);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `OpenSea events fetch failed for ${collectionSlug} with ${response.status}: ${body}`,
      );
    }

    const body = await response.json();
    const events = Array.isArray(body.asset_events) ? body.asset_events : [];
    sales.push(
      ...events.map((event) =>
        normalizeRestSaleEvent(event, {
          collectionLabels: options.collectionLabels,
          collectionSlug,
        }),
      ),
    );
    next = body.next || null;

    if (next) await sleep(options.pageDelayMs || 250);
  } while (next);

  return sales;
}

module.exports = {
  createOpenSeaSaleListener,
  fetchCollectionSales,
  normalizeSaleEvent,
  formatUnits,
  shortenAddress,
  collectionLabelFor,
  etherscanTxUrl,
  normalizeRestSaleEvent,
  normalizeTimestamp,
  transactionUrl,
  ethValueForPayment,
  isEthLikeSymbol,
  normalizedSymbol,
};
