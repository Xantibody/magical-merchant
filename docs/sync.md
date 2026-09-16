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

One sync is a loop of rounds; one round is `GET /sync-state` → local scan →
diff → one `POST /sync/bulk`:

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

A bulk call carries at most **40 R2 operations** (`BULK_OPERATION_BUDGET` in
[`core/src/sync/round.rs`](../core/src/sync/round.rs)); what does not fit is
left for the next round, and rounds repeat until the diff comes out empty, at
most **200** of them (`MAX_ROUNDS` in
[`core/src/sync/engine.rs`](../core/src/sync/engine.rs)). The budget counts
operations, not files: an upload or a download costs one, a conflict three
(read the remote copy, keep it aside, store the winner), any number of remote
deletions costs one together, and a local deletion costs nothing. The hard
ceiling is 48 — the Workers Free plan allows 50 subrequests per invocation and
the Worker spends two of them reading and writing the state — and the budget
stops at 40 so that a Worker which grows an operation or two does not break
the clients already installed. A 529-note first sync sent in one call is
simply refused as `Too many subrequests`.

Within a round the order is deletions, then conflicts, then downloads, then
uploads, so another device's edits are taken in before yours are pushed. The
state file is written at the end of every round, which is what makes an
interrupted sync harmless: whatever was sent is recorded, and the next run
picks up the rest. A round that settles nothing stops the sync with `stalled`
instead of spinning — again, the earlier rounds' work is kept, and the answer
is to run sync again. The CLI prints a line per round
(`round 3  40 done, 449 left`); the app keeps its spinner turning instead.

Only one sync at a time may touch a data directory. A run takes an exclusive
lock on `<base>/.sync.lock` before it does anything else and holds it to the
end; anyone who finds it taken gives up with `busy` rather than waiting. Two
runs would otherwise overwrite each other's `.sync-state.json`, and the keys
lost that way come back as conflicts on the next sync. The lock lives on the
open file descriptor, so a crash releases it — there is never a stale lock to
clear by hand. Two processes start syncs today — the app and the CLI's
`magical-merchant sync` — and they share that one lock. The app treats `busy`
as nothing worth showing and, with Auto sync on, tries again a few seconds
later; the CLI says the app is syncing right now and exits non-zero, because
a command that printed nothing and returned 0 would read as a sync that
happened.

Turning on **Auto sync** (sync popover, or `autoSync` in the nix-darwin
module) runs a sync a few seconds after any successful write, so a note taken
on the phone reaches the Mac without touching the sync button.

The session JWT lives in the macOS Keychain on desktop. Android has no
Keychain equivalent that `keyring` supports — it silently falls back to an
in-memory store, which loses the token immediately — so on Android the token
is written to the app-private data directory (mode `600`) instead. Only the
app can put a token there: the OAuth round trip needs a browser, so
`magical-merchant sync` reads the entry the app wrote and, when it has
expired, stops before the first request and asks you to log in from the app's
Settings.

On a conflict the local copy wins the key, and the overwritten remote copy is
kept both in R2 under `….sync-conflict-<timestamp>.md` and on disk under
`conflicts/<key without its extension>/<timestamp>.md`. That directory sits
outside `data/`, so a copy neither syncs back nor appears in the notes list.

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
