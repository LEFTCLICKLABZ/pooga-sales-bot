const path = require("node:path");
require("dotenv").config();

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseNumber(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseTimestampMs(value) {
  if (!value) return 0;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

function splitHashtags(value) {
  return value
    .split(/\s+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`));
}

function splitList(value) {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCollectionLabels(value) {
  return Object.fromEntries(
    splitList(value)
      .map((entry) => {
        const separator = entry.includes(":") ? ":" : "=";
        const [slug, ...labelParts] = entry.split(separator);
        const label = labelParts.join(separator).trim();
        return [slug.trim(), label];
      })
      .filter(([slug, label]) => slug && label),
  );
}

const collectionSlugs = splitList(
  env("OPENSEA_COLLECTION_SLUGS", env("OPENSEA_COLLECTION_SLUG")),
);

const config = {
  dryRun: parseBoolean(env("DRY_RUN"), true),
  opensea: {
    apiKey: env("OPENSEA_API_KEY"),
    collectionSlugs,
    collectionLabels: parseCollectionLabels(env("COLLECTION_LABELS")),
    pollEnabled: parseBoolean(env("OPENSEA_POLL_ENABLED"), true),
    pollIntervalMs: parseNumber(env("OPENSEA_POLL_INTERVAL_MS"), 5 * 60_000),
    pollLookbackMs: parseNumber(env("OPENSEA_POLL_LOOKBACK_MS"), 10 * 60_000),
  },
  x: {
    apiKey: env("X_API_KEY"),
    apiSecret: env("X_API_SECRET"),
    accessToken: env("X_ACCESS_TOKEN"),
    accessSecret: env("X_ACCESS_SECRET"),
    oauth2ClientId: env("X_OAUTH2_CLIENT_ID"),
    oauth2ClientSecret: env("X_OAUTH2_CLIENT_SECRET"),
    oauth2AccessToken: env("X_OAUTH2_ACCESS_TOKEN"),
    oauth2RefreshToken: env("X_OAUTH2_REFRESH_TOKEN"),
    oauth2TokenFile: path.resolve(process.cwd(), env("X_OAUTH2_TOKEN_FILE", ".env")),
    authMode: normalizeUsername(env("X_AUTH_MODE", "auto")),
    expectedUsername: normalizeUsername(env("X_EXPECTED_USERNAME", "poogalabs")),
    postImages: parseBoolean(env("POST_IMAGES"), true),
    requireImages: parseBoolean(env("REQUIRE_IMAGES"), true),
    maxImageBytes: parseNumber(env("MAX_IMAGE_BYTES"), 5 * 1024 * 1024),
  },
  ens: {
    enabled: parseBoolean(env("ENS_LOOKUP"), true),
    rpcUrl: env("ETH_RPC_URL"),
    timeoutMs: parseNumber(env("ENS_TIMEOUT_MS"), 1500),
  },
  usd: {
    enabled: parseBoolean(env("USD_CONVERSION"), true),
    sourceUrl: env("ETH_USD_SOURCE_URL", "https://api.coinbase.com/v2/prices/ETH-USD/spot"),
    timeoutMs: parseNumber(env("ETH_USD_TIMEOUT_MS"), 3000),
    cacheTtlMs: parseNumber(env("ETH_USD_CACHE_MS"), 2 * 60_000),
  },
  bot: {
    name: env("BOT_NAME", "NFT Sales Bot"),
    minSaleEth: parseNumber(env("MIN_SALE_ETH"), 0),
    hashtags: splitHashtags(env("HASHTAGS", "")),
    ignoreSalesBeforeMs: parseTimestampMs(env("IGNORE_SALES_BEFORE")),
    stateFile: path.resolve(process.cwd(), env("STATE_FILE", ".state/posted-sales.json")),
    retryIntervalMs: parseNumber(env("RETRY_INTERVAL_MS"), 60_000),
    retryBatchSize: parseNumber(env("RETRY_BATCH_SIZE"), 3),
    maxPendingSales: parseNumber(env("MAX_PENDING_SALES"), 250),
    postIntervalMs: parseNumber(env("X_POST_INTERVAL_MS"), 30_000),
    forbiddenBackoffMs: parseNumber(env("X_FORBIDDEN_BACKOFF_MS"), 60 * 60_000),
  },
};

function requireValues(entries) {
  const missing = entries.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

function hasOAuth1Credentials(xConfig) {
  return Boolean(
    xConfig.apiKey && xConfig.apiSecret && xConfig.accessToken && xConfig.accessSecret,
  );
}

function validateConfig(currentConfig = config) {
  requireValues([
    ["OPENSEA_API_KEY", currentConfig.opensea.apiKey],
  ]);

  if (currentConfig.opensea.collectionSlugs.length === 0) {
    throw new Error("Missing required environment variable: OPENSEA_COLLECTION_SLUGS");
  }

  if (currentConfig.dryRun) return;
  requireValues([["X_EXPECTED_USERNAME", currentConfig.x.expectedUsername]]);
  if (hasOAuth1Credentials(currentConfig.x)) return;

  if (currentConfig.x.oauth2AccessToken) {
    requireValues([
      ["X_OAUTH2_CLIENT_ID", currentConfig.x.oauth2ClientId],
      ["X_OAUTH2_ACCESS_TOKEN", currentConfig.x.oauth2AccessToken],
      ["X_OAUTH2_REFRESH_TOKEN", currentConfig.x.oauth2RefreshToken],
    ]);
    return;
  }

  requireValues([
    ["X_API_KEY", currentConfig.x.apiKey],
    ["X_API_SECRET", currentConfig.x.apiSecret],
    ["X_ACCESS_TOKEN", currentConfig.x.accessToken],
    ["X_ACCESS_SECRET", currentConfig.x.accessSecret],
  ]);
}

module.exports = {
  config,
  normalizeUsername,
  validateConfig,
};
