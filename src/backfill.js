const { config, validateConfig } = require("./config");
const { fetchCollectionSales } = require("./opensea");
const { createStateStore } = require("./stateStore");
const { createXPoster } = require("./xClient");
const { createEnsResolver } = require("./ensResolver");
const { createOpenSeaProfileResolver } = require("./accountProfiles");
const { createSalesProcessor } = require("./salesProcessor");
const { createEthUsdConverter } = require("./ethUsdConverter");

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortSales(sales) {
  return sales.sort((a, b) => {
    const aTime = Date.parse(a.eventTimestamp || 0);
    const bTime = Date.parse(b.eventTimestamp || 0);
    return aTime - bTime;
  });
}

async function main() {
  const hours = Number(argValue("hours", process.env.BACKFILL_HOURS || "12"));
  const dryRun = hasFlag("dry-run");
  const now = Math.floor(Date.now() / 1000);
  const after = Number(argValue("after", String(now - hours * 60 * 60)));
  const before = Number(argValue("before", String(now)));

  validateConfig();

  const runConfig = dryRun
    ? { ...config, dryRun: true }
    : config;
  const state = createStateStore(runConfig.bot.stateFile, {
    maxPendingSales: runConfig.bot.maxPendingSales,
  });
  const xPoster = runConfig.dryRun ? null : createXPoster(runConfig.x);
  const ensResolver = createEnsResolver(runConfig.ens);
  const profileResolver = createOpenSeaProfileResolver({
    apiKey: runConfig.opensea.apiKey,
  });
  const usdConverter = createEthUsdConverter(runConfig.usd);
  const salesProcessor = createSalesProcessor({
    config: runConfig,
    state,
    xPoster,
    ensResolver,
    profileResolver,
    usdConverter,
  });

  console.log(
    `Backfilling OpenSea sales from ${new Date(after * 1000).toISOString()} to ${new Date(
      before * 1000,
    ).toISOString()} with DRY_RUN=${runConfig.dryRun}`,
  );

  const salesByCollection = [];
  for (const collectionSlug of runConfig.opensea.collectionSlugs) {
    const sales = await fetchCollectionSales(collectionSlug, {
      after,
      before,
      apiKey: runConfig.opensea.apiKey,
      collectionLabels: runConfig.opensea.collectionLabels,
    });
    console.log(`Fetched ${sales.length} sale(s) for ${collectionSlug}`);
    salesByCollection.push(sales);
  }

  const sales = sortSales(salesByCollection.flat());
  const unposted = sales.filter((sale) => !state.has(sale));
  console.log(`Found ${sales.length} sale event(s), ${unposted.length} not yet posted`);

  for (const sale of unposted) {
    await salesProcessor.handleSale(sale);
    await sleep(500);
  }

  console.log(`Backfill complete. Pending queue contains ${state.pendingCount()} sale(s).`);
}

main().catch((error) => {
  console.error("Backfill failed", error);
  process.exit(1);
});
