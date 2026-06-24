const { buildTweet } = require("./tweetTemplate");

function createSalesProcessor({
  config,
  state,
  xPoster,
  ensResolver,
  profileResolver,
  usdConverter,
}) {
  async function enrichSale(sale) {
    const ensSale = ensResolver ? await ensResolver.enrichSale(sale) : sale;
    const profileSale = profileResolver ? await profileResolver.enrichSale(ensSale) : ensSale;
    return usdConverter ? usdConverter.enrichSale(profileSale) : profileSale;
  }

  async function postSale(sale) {
    const displaySale = await enrichSale(sale);
    const tweet = buildTweet(displaySale, config.bot);

    if (config.dryRun) {
      console.log("DRY_RUN=true; would post this tweet:");
      console.log("---");
      console.log(tweet);
      console.log("---");
      if (displaySale.imageUrl && config.x.postImages) {
        console.log(`Would attach image: ${displaySale.imageUrl}`);
      }
      return;
    }

    try {
      const posted = await xPoster.post(tweet, {
        imageUrl: displaySale.imageUrl,
        altText: `${displaySale.collectionName || "NFT"} ${displaySale.name}`,
      });
      state.markPosted(sale);
      console.log(
        `Posted sale ${sale.id} to X as tweet ${posted.data.id} with image=${posted.mediaUploaded}`,
      );
    } catch (error) {
      const pending = state.scheduleRetry(sale, error);
      const retryAt =
        pending && pending.nextAttemptAt ? `; retrying at ${pending.nextAttemptAt}` : "";
      console.error(`Failed to post sale ${sale.id} to X${retryAt}`, error);
    }
  }

  async function handleSale(sale) {
    if (!sale.id) {
      console.warn("Skipping sale without a stable ID", sale.raw);
      return;
    }

    const saleTime = Date.parse(sale.eventTimestamp || "");
    if (
      config.bot.ignoreSalesBeforeMs &&
      Number.isFinite(saleTime) &&
      saleTime < config.bot.ignoreSalesBeforeMs
    ) {
      console.log(`Skipping pre-launch sale ${sale.id}`);
      state.markPosted(sale);
      return;
    }

    if (state.has(sale)) {
      console.log(`Skipping already-posted sale ${sale.id}`);
      return;
    }

    if (sale.ethValue < config.bot.minSaleEth) {
      console.log(`Skipping sale below MIN_SALE_ETH: ${sale.ethValue} ETH`);
      return;
    }

    if (!config.dryRun) {
      state.upsertPending(sale);
    }

    await postSale(sale);
  }

  async function drainPendingSales(reason, options = {}) {
    if (config.dryRun) return;

    const allDueSales = options.force ? state.pendingAll() : state.pendingDue();
    const retryBatchSize = Math.max(1, Number(config.bot.retryBatchSize || 1));
    const dueSales = allDueSales.slice(0, retryBatchSize);
    if (dueSales.length === 0) return;

    const suffix =
      allDueSales.length > dueSales.length ? ` (${allDueSales.length} due total)` : "";
    console.log(`Retrying ${dueSales.length} pending sale(s) from ${reason}${suffix}`);
    for (const sale of dueSales) {
      if (!state.has(sale)) {
        await postSale(sale);
      }
    }
  }

  return {
    drainPendingSales,
    handleSale,
    postSale,
  };
}

module.exports = {
  createSalesProcessor,
};
