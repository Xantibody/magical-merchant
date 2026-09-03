# Sync Backend (Cloudflare Workers + R2)

The `workers/` directory contains a Cloudflare Workers backend that syncs
data via R2. Authentication uses Google OAuth with self-issued JWTs.

## How sync decides what to do

The Worker owns the sync state. `_sync-state/<user>.json` maps every key to a
content hash and a **server-issued version stamp**; both the Worker and each
client store exactly those values, so change detection never depends on the
filesystem mtime or on a device's clock.

Everything under `data/` takes part — timeline days, notes, templates, and
the glyph images under `data/glyphs/` — with no filter on the extension;
file contents travel base64-encoded, which is why a single glyph is capped
at 256 KiB.

One sync is `GET /sync-state` → local scan → diff → one `POST /sync/bulk`:

| Client sees                        | Action        | Effect on state       |
| ---------------------------------- | ------------- | --------------------- |
| Hash differs from the record       | Upload        | New hash, new stamp   |
| Stamp differs from the record      | Download      | Unchanged             |
| Both differ                        | Conflict      | Local wins, new stamp |
| Gone locally, stamp still matching | Delete remote | Key removed           |
| Gone remotely, hash still matching | Delete local  | (already removed)     |

> [!IMPORTANT]
> The client never sends a state of its own: doing so drops keys it has not
> downloaded yet, and the next sync would read that as "deleted everywhere"
> and erase the notes on every device. Writes use `expected_etag` for
> compare-and-swap, and the client retries a losing race automatically.

Only one sync at a time may touch a data directory. A run takes an exclusive
lock on `<base>/.sync.lock` before it does anything else and holds it to the
end; anyone who finds it taken gives up with `busy` rather than waiting. Two
runs would otherwise overwrite each other's `.sync-state.json`, and the keys
lost that way come back as conflicts on the next sync. The lock lives on the
open file descriptor, so a crash releases it — there is never a stale lock to
clear by hand.

Turning on **Auto sync** (sync popover, or `autoSync` in the nix-darwin
module) runs a sync a few seconds after any successful write, so a note taken
on the phone reaches the Mac without touching the sync button.

The session JWT lives in the macOS Keychain on desktop. Android has no
Keychain equivalent that `keyring` supports — it silently falls back to an
in-memory store, which loses the token immediately — so on Android the token
is written to the app-private data directory (mode `600`) instead.

On a conflict the local copy wins the key, and the overwritten remote copy is
kept both in R2 under `….sync-conflict-<timestamp>.md` and on disk next to
the note. Conflict copies are excluded from scanning, so they never sync
back.

## Deployment

### 1. Deploy the Worker

```sh
cd workers
pnpm install
wrangler login
pnpm run deploy:worker
```

> [!NOTE]
> The script is not called `deploy` because `pnpm deploy` resolves to pnpm's
> own workspace command and never runs the script.

### 2. Custom domain (optional)

If you want to use a custom domain instead of the default `*.workers.dev`
URL:

1. Go to **Cloudflare Dashboard** → **Workers & Pages** → **magical-merchant-sync**
2. **Settings** → **Domains & Routes** → **Add** → **Custom Domain**

### 3. Google OAuth setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. **Google Auth Platform** → **Overview** → Create branding (External, testing mode)
4. **Clients** → **Create OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URIs: `https://<your-worker-url>/auth/callback`
5. Copy the Client ID and Client Secret

### 4. Set secrets

```sh
cd workers

# Google OAuth credentials
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET

# Random signing key for JWTs (generate with: openssl rand -base64 32)
wrangler secret put JWT_SECRET
```

### 5. Configuration

| Variable               | Location           | Description                      | Default           |
| ---------------------- | ------------------ | -------------------------------- | ----------------- |
| `GOOGLE_CLIENT_ID`     | Secret             | Google OAuth Client ID           | —                 |
| `GOOGLE_CLIENT_SECRET` | Secret             | Google OAuth Client Secret       | —                 |
| `JWT_SECRET`           | Secret             | HMAC-SHA256 signing key for JWTs | —                 |
| `JWT_EXPIRY_SECONDS`   | Secret or `[vars]` | Token lifetime in seconds        | `259200` (3 days) |

### 6. App configuration

1. Open the app → Settings
2. Enter the Workers URL (e.g., `https://magical-merchant-sync.example.workers.dev`)
3. Click **Login with Google**
4. After authentication, sync is available
