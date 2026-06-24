const { config, validateConfig } = require("./config");
const { createOpenSeaSaleListener, fetchCollectionSales } = require("./opensea");
const { createStateStore } = require("./stateStore");
const { createXPoster } = require("./xClient");
const { createEnsResolver } = require("./ensResolver");
const { createOpenSeaProfileResolver } = require("./accountProfiles");
const { createSalesProcessor } = require("./salesProcessor");
const { createEthUsdConverter } = require("./ethUsdConverter");

validateConfig();

const state = createStateStore(config.bot.stateFile, {
  maxPendingSales: config.bot.maxPendingSales,
});
const xPoster = config.dryRun ? null : createXPoster(config.x);
const ensResolver = createEnsResolver(config.ens);
const profileResolver = createOpenSeaProfileResolver({
  apiKey: config.opensea.apiKey,
});
const usdConverter = createEthUsdConverter(config.usd);
const salesProcessor = createSalesProcessor({
  config,
  state,
  xPoster,
  ensResolver,
  profileResolver,
  usdConverter,
});
let retryDrainRunning = false;
let restPollRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortSales(sales) {
  return sales.sort((a, b) => Date.parse(a.eventTimestamp || 0) - Date.parse(b.eventTimestamp || 0));
}

async function drainPendingSales(reason) {
  if (config.dryRun || retryDrainRunning) return;

  retryDrainRunning = true;
  try {
    await salesProcessor.drainPendingSales(reason);
  } finally {
    retryDrainRunning = false;
  }
}

async function pollRecentSales(reason) {
  if (config.dryRun || !config.opensea.pollEnabled || restPollRunning) return;

  restPollRunning = true;
  const before = Math.floor(Date.now() / 1000);
  const after = before - Math.ceil(config.opensea.pollLookbackMs / 1000);

  try {
    const salesByCollection = [];
    for (const collectionSlug of config.opensea.collectionSlugs) {
      const sales = await fetchCollectionSales(collectionSlug, {
        after,
        before,
        apiKey: config.opensea.apiKey,
        collectionLabels: config.opensea.collectionLabels,
      });
      salesByCollection.push(sales);
    }

    const sales = sortSales(salesByCollection.flat());
    const unposted = sales.filter((sale) => !state.has(sale));
    if (sales.length > 0 || unposted.length > 0) {
      console.log(
        `OpenSea REST poll (${reason}) checked ${sales.length} sale(s), found ${unposted.length} new`,
      );
    }

    for (const sale of unposted) {
      await salesProcessor.handleSale(sale);
      await sleep(500);
    }
  } finally {
    restPollRunning = false;
  }
}

createOpenSeaSaleListener({
  apiKey: config.opensea.apiKey,
  collectionSlugs: config.opensea.collectionSlugs,
  collectionLabels: config.opensea.collectionLabels,
  onSale: (sale) => {
    salesProcessor.handleSale(sale).catch((error) => {
      console.error("Failed to handle sale", error);
    });
  },
  onError: (error) => {
    console.error("OpenSea stream error", error);
  },
});

console.log(
  `Listening for OpenSea sales on ${config.opensea.collectionSlugs.join(", ")} with DRY_RUN=${config.dryRun}`,
);
if (xPoster) {
  console.log(`Using X auth mode: ${xPoster.authMode}`);
}

if (!config.dryRun) {
  console.log(`Pending sale retry queue contains ${state.pendingCount()} sale(s)`);
  drainPendingSales("startup").catch((error) => {
    console.error("Failed to drain pending sales on startup", error);
  });
  setInterval(() => {
    drainPendingSales("timer").catch((error) => {
      console.error("Failed to drain pending sales", error);
    });
  }, config.bot.retryIntervalMs);

  if (config.opensea.pollEnabled) {
    console.log(
      `OpenSea REST polling enabled every ${config.opensea.pollIntervalMs}ms with ${config.opensea.pollLookbackMs}ms lookback`,
    );
    setInterval(() => {
      pollRecentSales("timer").catch((error) => {
        console.error("Failed to poll recent OpenSea sales", error);
      });
    }, config.opensea.pollIntervalMs);
  }
}
