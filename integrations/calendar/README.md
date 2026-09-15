# Calendar availability and session preferences

The classic homepage offers a **session preference picker**, with optional read-only Google Calendar availability. With no configured backend URL it retains the original working-hours-only mode. A connected backend removes overlapping busy times from the configured session calendar; neither mode reserves a time. Customers must agree the slot before paying. No payment, appointment or invitation is created by selecting a time.

`assets/booking-slots.js` supplies future-only, 30-minute-grid preferences in `Asia/Kolkata`: weekdays 16:00-23:00 and weekends 11:00-23:00. The selected 30/60-minute session must finish by 23:00. It does not query Google or invent free/busy data. `assets/booking.js` enhances the homepage with validation, review, a copyable payment note and a prefilled email request. Browser modules use `.js` because some Windows static servers serve `.mjs` as `text/plain`. No JavaScript, or a failed module load, leaves the original email/payment links available.

The hosted Razorpay URL is unchanged and opens in a new tab from the review step. It does not receive the selection automatically: the customer enters the fee and pastes the suggested note. Following the link is not proof of payment.

## Where credentials belong

- Keep the private `.env` and Google authorization JSON **outside the repository and outside any web server's publishing directory**. The local handoff provides the prepared file location.
- `.gitignore` is a second guard, not access control. It does not stop a local web server from serving an untracked file inside its document root.
- Restrict the private folder and files to the current Windows user and SYSTEM. Newly created token files inherit that folder's permissions. They are plaintext development secrets, not a replacement for a production secret manager.
- Never paste secrets or downloaded OAuth client JSON into chat, HTML, JavaScript, screenshots or Git. Do not upload or sync the private folder.
- The static site does not load `.env` files. It needs **no API key for the hosted Razorpay link**. Existing Node payment code already handles Test Mode API calls without an SDK; do not duplicate it or install an SDK just for this link.
- In a future Standard Checkout integration, only the Razorpay Key ID can reach the browser. The Key Secret and separate webhook secret stay server-side. `NEXT_PUBLIC_`, `VITE_` and `REACT_APP_` prefixes do not apply to this plain static website and must never be used for secrets.

The prepared private file has these fields:

| Variable | Source / use |
| --- | --- |
| `RAZORPAY_KEY_ID` | Actual Test Mode Key ID, if using the API core later; leave blank for hosted-link-only use |
| `RAZORPAY_KEY_SECRET` | Matching Test Mode secret; never a browser value |
| `RAZORPAY_WEBHOOK_SECRET` | Separate signing secret for a future webhook endpoint; currently unused |
| `GOOGLE_CLIENT_ID` | Google OAuth Web application client ID |
| `GOOGLE_CLIENT_SECRET` | The same client's secret |
| `GOOGLE_OWNER_EMAIL` | The account that owns the booking calendar |
| `GOOGLE_CALENDAR_ID` | The private dedicated calendar ID already supplied by the owner |
| `GOOGLE_BLOCKING_CALENDAR_IDS` | Optional comma-separated extra private calendars to block against. The owner's `primary` calendar is checked by default together with `GOOGLE_CALENDAR_ID`. |
| `GOOGLE_REDIRECT_URI` | Exactly `http://127.0.0.1:4174/oauth/google/callback` |
| `GOOGLE_TOKEN_FILE` | Absolute private JSON destination outside this repository |

The redacted values `rzp_tes` and `test` are not usable account credentials. Do not weaken validation to accept them.

## Set up Google OAuth

This local step does not need Cloud Run or a billing-enabled hosting deployment.

1. Select your existing personal Google Cloud project. Confirm that **Google Calendar API** is enabled under **APIs & Services -> Library**.
2. Open **Google Auth Platform -> Branding / Audience**. Complete the app details. If the app is External and in Testing, add the calendar owner's Google account as a test user.
3. Under **Data Access**, configure `openid`, your email address (`userinfo.email` in the scope picker), and `https://www.googleapis.com/auth/calendar.events.freebusy`. This helper only asks for availability access and identity verification. It does not request Gmail inbox access or permission to create/edit events.
4. Open **Clients -> Create client -> Web application**. Add this exact **Authorized redirect URI**:

   ```text
   http://127.0.0.1:4174/oauth/google/callback
   ```

   It is not the portfolio address or an Authorized JavaScript origin. Host, port and path must match.
5. Save the Client ID and Client Secret into the prepared private `.env`, not the repository. The owner email, calendar ID and local callback/token paths are already supplied in that local template.
6. In PowerShell, from the repository root, point to the private file and run:

   ```powershell
   $envFile = Read-Host 'Full path to your private .env file outside the repository'
   node --env-file="$envFile" .\integrations\calendar\connect-google.mjs
   ```

7. Open the **Google consent URL printed by the helper** yourself, on the same computer running the helper. Check the app identity and requested permission, select the configured owner account and grant access. Do not paste the returned code or URL into chat. The helper listens only on `127.0.0.1:4174` and waits up to ten minutes.
8. Google redirects to the local callback. The helper verifies state and PKCE, exchanges the code server-side, checks the verified account email, saves the refresh token privately and makes a read-only free/busy access check. It never creates a calendar event or sends an invitation. If authorization is saved but the calendar check fails, the helper reports that partial state instead of claiming success.

To recheck saved authorization after fixing API/calendar settings:

```powershell
node --env-file="$envFile" .\integrations\calendar\connect-google.mjs --check
```

Do not stop an unrelated process if port 4174 is occupied. The helper fails explicitly rather than selecting an unregistered redirect port.

External apps in Testing that request Calendar access can receive refresh tokens that expire after seven days. This is a development setup, not a permanent production authorization strategy. Sending invitations later needs an additional event-write scope and owner consent; the current grant is read-only.

For sustained production use, address Google's OAuth publishing/verification requirements and Testing-token expiry before relying on this grant. The owner can still authorize locally with the registered loopback helper; this availability backend does not expose an OAuth callback. A future public web-based authorization flow would require its own registered HTTPS callback.

## Run the read-only availability API

After completing the owner authorization above, run this separately from the static server:

```powershell
node --env-file="$envFile" .\integrations\calendar\availability-server.mjs
```

The API binds only to `127.0.0.1:4175` locally. It reads configuration and saved authorization at startup; restart this API process after changing credentials or reauthorizing. With the website preview on port 4173, open:

`http://127.0.0.1:4173/?calendar=local#direct-sessions`

The `calendar=local` switch works only on a loopback website hostname. It is ignored on GitHub Pages; a visitor cannot use a query parameter to substitute a production API endpoint. Without this switch or a configured HTTPS endpoint, the existing preference-only flow is unchanged.

- `GET /healthz` indicates process health, **not** valid Google authorization.
- `POST /api/availability` accepts exactly `{"serviceId":"mentorship","date":"YYYY-MM-DD"}` with `Content-Type: application/json`. Use a real future date.
- The response contains the approved fee, duration, IST date, eligible slots, check timestamp, freshness limit and `reserved: false`. It contains no calendar ID, raw busy intervals, event titles, owner credentials or tokens.
- Busy overlaps remove a slot for its entire duration. A busy interval ending exactly when a slot starts does not overlap. All-day busy intervals remove every applicable time.
- The configured dedicated calendar and the owner's primary Google Calendar are queried by default. Add other private calendars through `GOOGLE_BLOCKING_CALENDAR_IDS` if they should also remove slots. The browser never receives these calendar identifiers.
- Busy data is cached for at most 30 seconds across services, with at most 64 dates retained. Past starts are re-filtered on every response. Token refresh and same-date queries are shared; at most eight date queries can be pending.
- Missing or malformed provider data returns an error, never an empty busy list interpreted as free. Failures have a five-second provider cooldown.
- The browser cancels stale requests, validates the response against the selected service, and blocks times on failures. Returning to the page rechecks availability. Expired review links refresh first and require another explicit click, avoiding asynchronously blocked payment popups.
- Requests are limited to 1 KiB and 60 POSTs/minute per process. CORS allows the portfolio origin and local previews by default; use `ALLOWED_ORIGINS` to specify the exact production origin.
- This is a public availability API, not an authenticated booking endpoint. CORS does not stop non-browser callers. In-memory limits are not distributed quotas or a hard spending cap.

## Cloud Run preparation

Cloud Run deployment is separate from GitHub Pages publication. It requires the **actual existing Google Cloud project ID**, a management login with appropriate permissions, and an already billing-enabled project. Calendar OAuth does not grant Cloud administration access. Do not create or attach a billing account as part of these commands.

The provided Dockerfile uses Node 24, no installed application dependencies, a non-root runtime user, and explicit source copies. Prepare an empty, private source directory **outside** the website:

```powershell
$sourceDirectory = Read-Host 'Absolute empty deployment directory outside the repository'
node .\integrations\calendar\prepare-deployment.mjs "$sourceDirectory"
```

This copies exactly six allowlisted files: the Dockerfile, the schedule helper, the service/price model and three calendar runtime modules. It does not upload anything. Never add credentials to this directory and never deploy from the whole website root.

When the target project and private Secret Manager destination are approved:

```powershell
node --env-file="$envFile" .\integrations\calendar\prepare-runtime-secret.mjs
```

This first verifies Google access, then exclusively creates `calendar-runtime.json` beside the private token file, inheriting that private directory's Windows ACLs. It includes only the necessary Google configuration and saved refresh authorization, not Razorpay or access tokens. It refuses to overwrite an existing export. Treat it as a credential, not a source artifact; upload it only as a Secret Manager secret in the approved project. The tests use fictional bundles; do not paste a real bundle into chat or Git.

Deployment configuration:

| Setting | Value / requirement |
| --- | --- |
| Service / region | `nikhil-bookings-api` / `asia-south1` |
| Source | The six-file generated directory, not the repository |
| APIs | Cloud Run, Cloud Build, Artifact Registry and Secret Manager |
| Build identity | Dedicated build service account with `roles/run.builder`; deployer needs the documented source-deployment and service-account-use permissions |
| Runtime identity | Separate service account with `roles/secretmanager.secretAccessor` on this one secret only; do not generate a service-account key |
| Runtime secret | Mount a pinned secret version as `/secrets/calendar/calendar-runtime.json` |
| Runtime configuration | `CALENDAR_CREDENTIALS_FILE=/secrets/calendar/calendar-runtime.json`, `ALLOWED_ORIGINS=https://cracker-jack.github.io` |
| Resource settings | Request-based billing, minimum 0, service maximum 1 instance, concurrency 8, CPU 1, memory 256 MiB |
| Port | Cloud Run supplies `PORT`; `K_SERVICE` enables binding to `0.0.0.0` inside the container |
| Public invocation | Required for the static site's anonymous requests; do not bypass organization policies that disallow it |

Install the official Google Cloud CLI and use an isolated private `CLOUDSDK_CONFIG` directory for the owner's management login, rather than changing an unrelated global/cloud account. Verify the selected project and billing state before enabling APIs, granting roles, creating secrets or deploying. Source builds use the Dockerfile without requiring a local Docker daemon.

After a successful deployment, verify an actual future-date availability POST, including CORS, before adding the returned HTTPS service URL plus `/api/availability` to `data-availability-api` on the homepage's `#direct-sessions` section. Publish the frontend only after that check and publication authorization.

Minimum-zero instances and maximum-instance limits do not guarantee zero cost. Cloud Build, Artifact Registry storage, Secret Manager and network/request usage may incur charges; budgets/alerts are not hard caps. Rebuild periodically for Node/base-image patches. For credential rotation, create a new secret version, deploy a revision pinned to it, and check Google availability again; this runtime reads its bundle at startup.

## What is still not connected

Successful local OAuth and API startup do **not** connect the published GitHub Pages picker automatically. No Cloud Run deployment or public API URL is included in this source.

The personal Razorpay.me link still requires manual payment verification. Automatic booking confirmation needs a verifiable payment/booking association and backend reconciliation. No live gateway keys, cloud resources, payment transactions, calendar writes, email sending or public deployment are enabled by this helper.

## Tests

Using Node.js 24, from the repository root:

```powershell
node --test .\integrations\calendar\*.test.mjs .\integrations\razorpay\*.test.mjs
```

Tests use fictional credentials, in-process Google/Razorpay HTTP substitutes and temporary loopback listeners. They cover date/time boundaries, past selections, owner/scope checks, OAuth state/PKCE, callback replay, private token destinations, consent denial, saved-authorization failures and existing payment contracts. No real Google authorization or payment is tested by this suite.

The availability tests also cover busy boundaries, all-day conflicts, malformed data, caching, cooldowns, HTTP/CORS/body/rate guards, response privacy, browser request contracts, private runtime export and allowlisted deployment packaging. Container builds and actual Cloud Run checks are separate deployment prerequisites.

## Official references

- [Google web-server OAuth flow and client setup](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Calendar free/busy API and allowed scopes](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
- [Google refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Cloud Run source deployment](https://docs.cloud.google.com/run/docs/deploying-source-code)
- [Cloud Run secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets)
- [Cloud Run CLI deployment settings](https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy)
