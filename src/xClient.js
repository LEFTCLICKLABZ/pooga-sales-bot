const { TwitterApi } = require("twitter-api-v2");
const fs = require("node:fs");

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/bmp",
  "image/png",
  "image/webp",
  "image/pjpeg",
  "image/tiff",
]);

function normalizeUsername(value = "") {
  return String(value).trim().replace(/^@/, "").toLowerCase();
}

function assertExpectedUsername(user, expectedUsername) {
  const expected = normalizeUsername(expectedUsername);
  if (!expected) return user;

  const actual = normalizeUsername(user && user.username);
  if (actual !== expected) {
    const actualLabel = actual ? `@${actual}` : "an unknown X account";
    throw new Error(
      `Refusing to post: authenticated X user is ${actualLabel}, expected @${expected}.`,
    );
  }

  return user;
}

function normalizeImageUrl(url) {
  if (!url) return "";
  if (url.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${url.slice("ipfs://".length)}`;
  }
  return url;
}

function cleanMimeType(contentType = "") {
  return contentType.split(";")[0].trim().toLowerCase();
}

function setEnvValue(contents, key, value) {
  if (!value) return contents;
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");

  if (pattern.test(contents)) {
    return contents.replace(pattern, line);
  }

  const separator = contents.endsWith("\n") || contents.length === 0 ? "" : "\n";
  return `${contents}${separator}${line}\n`;
}

function persistOAuth2Tokens(config, tokens) {
  if (!config.oauth2TokenFile || !tokens.accessToken) return;

  try {
    const current = fs.existsSync(config.oauth2TokenFile)
      ? fs.readFileSync(config.oauth2TokenFile, "utf8")
      : "";
    let next = setEnvValue(current, "X_OAUTH2_ACCESS_TOKEN", tokens.accessToken);
    next = setEnvValue(next, "X_OAUTH2_REFRESH_TOKEN", tokens.refreshToken);
    fs.writeFileSync(config.oauth2TokenFile, next, { mode: 0o600 });
  } catch (error) {
    console.warn(`OAuth 2 token refresh succeeded but could not persist tokens: ${error.message}`);
  }
}

function shouldRefreshOAuth2(error) {
  const code = Number(error?.code || error?.status || error?.data?.status || 0);
  const message = String(error?.message || "");
  return code === 401 || message.includes("Unauthorized");
}

function isForbidden(error) {
  const code = Number(error?.code || error?.status || error?.data?.status || 0);
  return code === 403;
}

function tweetResponseId(response) {
  if (response?.data?.id) return response.data.id;
  if (response?.id_str) return response.id_str;
  if (response?.id) return String(response.id);
  return "";
}

async function postWithOAuth1Fallback(client, text, mediaId, originalError) {
  if (!isForbidden(originalError)) throw originalError;

  console.warn("X v2 create-post returned 403; trying OAuth1 v1.1 tweet fallback");
  const payload = mediaId ? { media_ids: String(mediaId) } : undefined;
  try {
    return await client.v1.tweet(text, payload);
  } catch (fallbackError) {
    console.warn(`OAuth1 v1.1 tweet fallback failed: ${fallbackError.message}`);
    throw originalError;
  }
}

function hasOAuth1Credentials(config) {
  return Boolean(config.apiKey && config.apiSecret && config.accessToken && config.accessSecret);
}

function assertRequiredImageConfig(config, options = {}) {
  if (!config.requireImages) return;

  if (!config.postImages) {
    throw new Error("Image upload is required but POST_IMAGES is disabled");
  }

  if (!options.imageUrl) {
    throw new Error("Image upload is required but the sale has no image URL");
  }
}

async function downloadImage(imageUrl, maxBytes) {
  const normalizedUrl = normalizeImageUrl(imageUrl);
  if (!normalizedUrl) return null;

  const response = await fetch(normalizedUrl, {
    headers: {
      Accept: "image/png,image/jpeg,image/webp,image/bmp,image/tiff",
      "User-Agent": "pooga-labs-sales-bot/0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`Image fetch failed with ${response.status} for ${normalizedUrl}`);
  }

  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > maxBytes) {
    throw new Error(`Image is too large: ${contentLength} bytes`);
  }

  const mimeType = cleanMimeType(response.headers.get("content-type") || "");
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    throw new Error(`Unsupported image type: ${mimeType || "unknown"}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(`Image is too large: ${buffer.length} bytes`);
  }

  return { buffer, mimeType };
}

function createXPoster(config) {
  if (config.authMode === "oauth1") {
    if (!hasOAuth1Credentials(config)) {
      throw new Error("X_AUTH_MODE=oauth1 requires OAuth 1.0a user tokens");
    }
    return createOAuth1Poster(config);
  }

  if (config.authMode === "oauth2") {
    if (!config.oauth2AccessToken) {
      throw new Error("X_AUTH_MODE=oauth2 requires X_OAUTH2_ACCESS_TOKEN");
    }
    return createOAuth2Poster(config);
  }

  if (hasOAuth1Credentials(config)) return createOAuth1Poster(config);
  if (config.oauth2AccessToken) return createOAuth2Poster(config);

  throw new Error(
    "Missing X credentials: configure OAuth 1.0a user tokens or OAuth 2.0 access token",
  );
}

function createOAuth1Poster(config) {
  const client = new TwitterApi({
    appKey: config.apiKey,
    appSecret: config.apiSecret,
    accessToken: config.accessToken,
    accessSecret: config.accessSecret,
  });
  let verifiedUser = null;

  async function verifyAccount({ force = false } = {}) {
    if (!config.expectedUsername) return null;
    if (verifiedUser && !force) return verifiedUser;

    const response = await client.v2.me();
    verifiedUser = assertExpectedUsername(response.data, config.expectedUsername);
    return verifiedUser;
  }

  return {
    authMode: "oauth1",
    verifyAccount,

    async post(text, options = {}) {
      assertRequiredImageConfig(config, options);
      await verifyAccount();

      let mediaId = null;
      let mediaError = null;

      if (config.postImages && options.imageUrl) {
        try {
          const image = await downloadImage(options.imageUrl, config.maxImageBytes);
          if (image) {
            mediaId = await client.v1.uploadMedia(image.buffer, {
              mimeType: image.mimeType,
              target: "tweet",
            });

            if (options.altText) {
              await client.v1.createMediaMetadata(mediaId, {
                alt_text: { text: options.altText.slice(0, 1000) },
              });
            }
          }
        } catch (error) {
          mediaError = error;
          if (config.requireImages) {
            throw new Error(`Image upload is required but failed: ${error.message}`);
          }
          console.warn(`Posting without image: ${error.message}`);
        }
      }

      let response;
      if (mediaId) {
        try {
          response = await client.v2.tweet({
            text,
            media: {
              media_ids: [String(mediaId)],
            },
          });
        } catch (error) {
          try {
            response = await postWithOAuth1Fallback(client, text, mediaId, error);
          } catch (fallbackError) {
            if (config.requireImages) throw fallbackError;
            mediaError = fallbackError;
            console.warn(`Posting without image after media tweet failed: ${fallbackError.message}`);
            response = await client.v2.tweet(text);
            mediaId = null;
          }
        }
      } else {
        if (config.requireImages) {
          throw new Error("Image upload is required but no media ID was created");
        }
        try {
          response = await client.v2.tweet(text);
        } catch (error) {
          response = await postWithOAuth1Fallback(client, text, null, error);
        }
      }

      return {
        data: {
          id: tweetResponseId(response),
        },
        mediaUploaded: Boolean(mediaId),
        mediaError,
      };
    },
  };
}

function createOAuth2Poster(config) {
  let accessToken = config.oauth2AccessToken;
  let refreshToken = config.oauth2RefreshToken;
  let client = new TwitterApi(accessToken);
  let verifiedUser = null;
  let verifiedMediaUser = null;
  const mediaClient =
    config.apiKey && config.apiSecret && config.accessToken && config.accessSecret
      ? new TwitterApi({
          appKey: config.apiKey,
          appSecret: config.apiSecret,
          accessToken: config.accessToken,
          accessSecret: config.accessSecret,
        })
      : null;

  const refreshClient = config.oauth2ClientId
    ? new TwitterApi({
        clientId: config.oauth2ClientId,
        clientSecret: config.oauth2ClientSecret || undefined,
      })
    : null;

  async function refreshAccessToken() {
    if (!refreshClient || !refreshToken) {
      throw new Error("OAuth 2 access token expired and no refresh token is configured");
    }

    const result = await refreshClient.refreshOAuth2Token(refreshToken);
    accessToken = result.accessToken;
    refreshToken = result.refreshToken || refreshToken;
    client = result.client || new TwitterApi(accessToken);
    persistOAuth2Tokens(config, {
      accessToken,
      refreshToken,
    });
    verifiedUser = null;
  }

  async function withRefresh(action) {
    try {
      return await action(client);
    } catch (error) {
      if (!shouldRefreshOAuth2(error)) throw error;
      await refreshAccessToken();
      return action(client);
    }
  }

  async function uploadMedia(options) {
    if (!config.postImages || !options.imageUrl) return null;

    const image = await downloadImage(options.imageUrl, config.maxImageBytes);
    if (!image) return null;

    if (mediaClient) {
      const mediaId = await mediaClient.v1.uploadMedia(image.buffer, {
        mimeType: image.mimeType,
        target: "tweet",
      });

      if (options.altText) {
        await mediaClient.v1.createMediaMetadata(mediaId, {
          alt_text: { text: options.altText.slice(0, 1000) },
        });
      }

      return mediaId;
    }

    const mediaId = await withRefresh((activeClient) =>
      activeClient.v2.uploadMedia(image.buffer, {
        media_type: image.mimeType,
        media_category: "tweet_image",
      }),
    );

    if (options.altText) {
      await withRefresh((activeClient) =>
        activeClient.v2.createMediaMetadata(mediaId, {
          alt_text: { text: options.altText.slice(0, 1000) },
        }),
      );
    }

    return mediaId;
  }

  async function createTweet(text, mediaId = null) {
    try {
      if (!mediaId) {
        return await withRefresh((activeClient) => activeClient.v2.tweet(text));
      }

      return await withRefresh((activeClient) =>
        activeClient.v2.tweet({
          text,
          media: {
            media_ids: [String(mediaId)],
          },
        }),
      );
    } catch (error) {
      if (!mediaClient) throw error;
      return postWithOAuth1Fallback(mediaClient, text, mediaId, error);
    }
  }

  async function verifyAccount({ force = false } = {}) {
    if (!config.expectedUsername) return null;
    if (verifiedUser && !force) return verifiedUser;

    const response = await withRefresh((activeClient) => activeClient.v2.me());
    verifiedUser = assertExpectedUsername(response.data, config.expectedUsername);
    if (mediaClient) {
      const mediaResponse = await mediaClient.v2.me();
      verifiedMediaUser = assertExpectedUsername(mediaResponse.data, config.expectedUsername);
    }
    return verifiedUser;
  }

  return {
    authMode: mediaClient ? "oauth2+oauth1-media" : "oauth2",
    verifyAccount,

    async post(text, options = {}) {
      assertRequiredImageConfig(config, options);
      await verifyAccount();

      let mediaId = null;
      let mediaError = null;

      if (config.postImages && options.imageUrl) {
        try {
          mediaId = await uploadMedia(options);
        } catch (error) {
          mediaError = error;
          if (config.requireImages) {
            throw new Error(`Image upload is required but failed: ${error.message}`);
          }
          console.warn(`Posting without image: ${error.message}`);
        }
      }

      let response;
      if (mediaId) {
        try {
          response = await createTweet(text, mediaId);
        } catch (error) {
          if (config.requireImages) throw error;
          mediaError = error;
          console.warn(`Posting without image after media tweet failed: ${error.message}`);
          response = await createTweet(text);
          mediaId = null;
        }
      } else {
        if (config.requireImages) {
          throw new Error("Image upload is required but no media ID was created");
        }
        response = await createTweet(text);
      }

      return {
        data: {
          id: tweetResponseId(response),
        },
        mediaUploaded: Boolean(mediaId),
        mediaError,
      };
    },
  };
}

module.exports = {
  assertExpectedUsername,
  createXPoster,
  downloadImage,
  normalizeUsername,
  normalizeImageUrl,
  persistOAuth2Tokens,
};
