const { buildTweet } = require("./tweetTemplate");

const sampleSale = {
  id: "sample",
  name: "ROCK BOTTOM",
  collectionName: "ROCK BOTTOM",
  amount: "0.0018",
  symbol: "WETH",
  usdDisplay: "$3.12",
  buyerDisplay: "0x3d80...15e2",
  sellerDisplay: "0x80c3...4a53",
  buyer: "0x3d80618ea35d9936de784584a57ba0d4e94515e2",
  seller: "0x80c31fa2fd8aa96b3144a026e554f70757074a53",
  buyerShort: "0x3d80...15e2",
  sellerShort: "0x80c3...4a53",
  txShort: "0xf0d4...44d5",
  txHash: "0xf0d40000000000000000000000000000000000000000000000000000000044d5",
  txUrl: "https://etherscan.io/tx/0xf0d40000000000000000000000000000000000000000000000000000000044d5",
  imageUrl: "https://example.com/rock-bottom.png",
  permalink: "https://opensea.io/assets/ethereum/0x0000000000000000000000000000000000000000/123",
};

console.log(buildTweet(sampleSale, { hashtags: [] }));
