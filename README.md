# Pooga Labs Rock Bottom Sales Bot

Posts Rock Bottom NFT sales from the OpenSea collection slug `rockbottomofficial` to the Pooga Labs X account.

The bot is intentionally locked to `@poogalabs`. Before any tweet or media upload, it calls X's authenticated user endpoint and refuses to continue unless the configured token belongs to `@poogalabs`.

## Safety Defaults

- `DRY_RUN=true` by default.
- `X_EXPECTED_USERNAME=poogalabs` is required for live mode.
- `POST_IMAGES=true` and `REQUIRE_IMAGES=true` keep the bot from posting text-only sales.
- `OPENSEA_POLL_ENABLED=false` avoids bulk catch-up storms; the live stream handles new sales.
- `RETRY_BATCH_SIZE=3` keeps failed retries from hammering X.
- `IGNORE_SALES_BEFORE` can be set to the launch timestamp to prevent old sales from posting.
- `pnpm verify:x` checks the X account without posting.
- Seller roasts use the seller's linked X handle only when OpenSea returns one.

## Local Setup

```bash
cd "/Users/mitchgach/Downloads/ROCK BOTTOM SITE/pooga-sales-bot"
cp .env.example .env
pnpm install --frozen-lockfile --ignore-workspace
```

Fill in `.env` with:

- `OPENSEA_API_KEY`
- `X_API_KEY`
- `X_API_SECRET`
- `X_ACCESS_TOKEN`
- `X_ACCESS_SECRET`

OAuth 1.0a user credentials are required for image upload. OAuth 2 can post text, but the sales bot is configured to reject text-only posts.

In the X Developer app, add this callback URL for OAuth 2 user authentication:

```text
http://127.0.0.1:8787/callback
```

Then authorize while logged into `@poogalabs`:

```bash
pnpm --ignore-workspace run oauth:setup
```

The setup command saves OAuth 2 tokens only after it verifies the authorized X user is `@poogalabs`.

## Test Without Posting

```bash
pnpm --ignore-workspace run check
pnpm --ignore-workspace run preview
pnpm --ignore-workspace run verify:x
pnpm --ignore-workspace run backfill -- --hours=24 --dry-run
```

These commands do not post tweets. Keep `DRY_RUN=true` until the account and preview are approved.

## Go Live Later

Only after testing:

```env
DRY_RUN=false
```

Then:

```bash
pnpm --ignore-workspace run start
```

## Run When The Computer Is Off

Use a Render background worker, not the local LaunchAgent. The included `render.yaml` is configured as an always-on worker with persistent state mounted at `/var/data`.

Deploy checklist:

- Use the `main` branch in the `LEFTCLICKLABZ/pooga-sales-bot` GitHub repo.
- Create the Render Blueprint or worker from `render.yaml`.
- Set the `sync: false` secrets in Render: `OPENSEA_API_KEY`, `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`, and optional `ETH_RPC_URL`.
- Also set the OAuth 2 secrets used for final tweet creation: `X_OAUTH2_CLIENT_ID`, `X_OAUTH2_CLIENT_SECRET`, `X_OAUTH2_ACCESS_TOKEN`, and `X_OAUTH2_REFRESH_TOKEN`.
- Confirm `DRY_RUN=false` and `IGNORE_SALES_BEFORE` is set to the exact go-live timestamp before deploying.
- Confirm Render logs say `Using X auth mode: oauth2+oauth1-media` and never accept a run that logs `image=false`.

OAuth 1.0a uploads the image; OAuth 2 creates the final tweet.

## Collection

- OpenSea slug: `rockbottomofficial`
- Label: `ROCK BOTTOM`
- Hashtags: `#RockBottom #PoogaLabs`
