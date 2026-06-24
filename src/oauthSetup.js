const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { TwitterApi } = require("twitter-api-v2");
const { config, normalizeUsername } = require("./config");

const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8787/callback";
const SCOPES = ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"];

function requireValue(name, value) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

function quoteEnvValue(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:@~-]+$/.test(text) ? text : JSON.stringify(text);
}

function setEnvValue(contents, key, value) {
  if (value === undefined || value === null || value === "") return contents;

  const line = `${key}=${quoteEnvValue(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");

  if (pattern.test(contents)) {
    return contents.replace(pattern, line);
  }

  const separator = contents.endsWith("\n") || contents.length === 0 ? "" : "\n";
  return `${contents}${separator}${line}\n`;
}

function saveTokenFile(filePath, values) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const next = Object.entries(values).reduce(
    (contents, [key, value]) => setEnvValue(contents, key, value),
    current,
  );

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next, { mode: 0o600 });
}

function waitForCallback(redirectUri, expectedState) {
  const parsed = new URL(redirectUri);

  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("X_OAUTH2_REDIRECT_URI must be localhost for this setup helper.");
  }

  const port = Number(parsed.port || 80);

  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url, redirectUri);

      if (requestUrl.pathname !== parsed.pathname) {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Not found");
        return;
      }

      const error = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code");
      const state = requestUrl.searchParams.get("state");

      if (error) {
        response.writeHead(400, { "Content-Type": "text/plain" });
        response.end(`X authorization failed: ${error}`);
        server.close();
        reject(new Error(`X authorization failed: ${error}`));
        return;
      }

      if (!code || state !== expectedState) {
        response.writeHead(400, { "Content-Type": "text/plain" });
        response.end("Invalid X authorization callback.");
        server.close();
        reject(new Error("Invalid X authorization callback."));
        return;
      }

      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("Pooga Labs X authorization verified. You can close this tab.");
      server.close();
      resolve({ code });
    });

    server.once("error", reject);
    server.listen(port, parsed.hostname);
  });
}

async function main() {
  const expectedUsername = normalizeUsername(config.x.expectedUsername || "poogalabs");
  const redirectUri = process.env.X_OAUTH2_REDIRECT_URI || DEFAULT_REDIRECT_URI;

  requireValue("X_OAUTH2_CLIENT_ID", config.x.oauth2ClientId);
  requireValue("X_EXPECTED_USERNAME", expectedUsername);

  const authClient = new TwitterApi({
    clientId: config.x.oauth2ClientId,
    clientSecret: config.x.oauth2ClientSecret || undefined,
  });
  const { url, state, codeVerifier } = authClient.generateOAuth2AuthLink(redirectUri, {
    scope: SCOPES,
  });
  const callback = waitForCallback(redirectUri, state);

  console.log(`Authorize X posting for @${expectedUsername}:`);
  console.log(url);
  console.log("");
  console.log(`Waiting for callback on ${redirectUri} ...`);

  const { code } = await callback;
  const result = await authClient.loginWithOAuth2({
    code,
    codeVerifier,
    redirectUri,
  });
  const me = await result.client.v2.me();
  const actualUsername = normalizeUsername(me.data && me.data.username);

  if (actualUsername !== expectedUsername) {
    throw new Error(
      `Refusing to save tokens: authorized @${actualUsername || "unknown"}, expected @${expectedUsername}.`,
    );
  }

  if (!result.refreshToken) {
    throw new Error(
      "X did not return a refresh token. Confirm the app requested offline.access, then run this setup again.",
    );
  }

  saveTokenFile(config.x.oauth2TokenFile, {
    X_EXPECTED_USERNAME: expectedUsername,
    X_OAUTH2_CLIENT_ID: config.x.oauth2ClientId,
    X_OAUTH2_CLIENT_SECRET: config.x.oauth2ClientSecret,
    X_OAUTH2_REDIRECT_URI: redirectUri,
    X_OAUTH2_ACCESS_TOKEN: result.accessToken,
    X_OAUTH2_REFRESH_TOKEN: result.refreshToken,
    X_OAUTH2_TOKEN_FILE: path.relative(process.cwd(), config.x.oauth2TokenFile),
  });

  console.log(`Verified @${actualUsername}. Tokens saved to ${config.x.oauth2TokenFile}.`);
  console.log("No tweet was posted.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
