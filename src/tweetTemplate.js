const MAX_TWEET_LENGTH = 280;
const SELL_SHAME_TITLE = "SELL SHAME BOT: A WALLET HAS OFFICIALLY HIT ROCK BOTTOM.";

function compactLines(lines) {
  return lines.filter(Boolean).join("\n");
}

function estimatedTweetLength(text) {
  return text.length;
}

function fitsTweet(text) {
  return estimatedTweetLength(text) <= MAX_TWEET_LENGTH;
}

function priceWithUsd(sale) {
  const cryptoPrice = `${sale.amount} ${sale.symbol}`;
  return sale.usdDisplay ? `${cryptoPrice} (${sale.usdDisplay} USD)` : cryptoPrice;
}

function saleTitle(sale) {
  return SELL_SHAME_TITLE;
}

function identityLabel(primary, fallback) {
  return primary || fallback || "anonymous wallet";
}

function deterministicIndex(seed, length) {
  if (length <= 1) return 0;
  const text = String(seed || "");
  let hash = 0;

  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }

  return hash % length;
}

function sellerRoast(sale) {
  const seller = identityLabel(
    sale.sellerXHandle || sale.sellerDisplay || sale.sellerShort,
    "the seller wallet",
  );
  const buyer = sale.buyerXHandle || sale.buyerDisplay || sale.buyerShort || "a braver wallet";
  const roasts = [
    `Seller ${seller} paper-handed. Rock Bottom is now in witness protection with ${buyer}.`,
    `Seller ${seller} hit eject. The chair has been repossessed by culture.`,
    `Seller ${seller} released a Rock Bottom into the wild and immediately failed the vibe check.`,
    `Seller ${seller} folded; ${buyer} caught the falling masterpiece with oven mitts.`,
    `Seller ${seller} chose liquidity. History chose to giggle.`,
    `Seller ${seller} has been sent to the paper-hands timeout corner.`,
  ];

  return roasts[deterministicIndex(sale.id || sale.txHash || sale.name, roasts.length)];
}

function buildTweet(sale, options) {
  const title = saleTitle(sale);
  const collectionName = sale.collectionName || "NFT";
  const price = priceWithUsd(sale);
  const hashtags = options.hashtags.join(" ");
  const buyer = identityLabel(sale.buyerXHandle || sale.buyerDisplay || sale.buyerShort, "buyer");
  const txLine = sale.txShort ? `Tx: ${sale.txShort}` : "";
  const details = compactLines([
    title,
    `${collectionName}: ${sale.name}`,
    `Sold for ${price} to ${buyer}`,
    sellerRoast(sale),
    txLine,
    "",
    "Rock Bottom can only form here.",
    hashtags,
  ]);

  if (fitsTweet(details)) return details;

  const shorterName = sale.name.length > 56 ? `${sale.name.slice(0, 53)}...` : sale.name;
  const fallback = compactLines([
    title,
    `${collectionName}: ${shorterName}`,
    `Sold for ${price}`,
    sellerRoast(sale),
    txLine,
    "Rock Bottom can only form here.",
    hashtags,
  ]);

  if (fitsTweet(fallback)) return fallback;

  const minimal = compactLines([
    `SELL SHAME BOT: ${collectionName}: ${shorterName} sold for ${price}`,
    sellerRoast(sale),
    txLine,
    hashtags,
  ]);
  return minimal;
}

module.exports = {
  buildTweet,
  priceWithUsd,
  saleTitle,
  sellerRoast,
};
