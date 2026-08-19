# Doorstep

Neighbour-to-neighbour giveaway app, launching in London (London Fields first). Photograph something you're finished with, it gets listed for a short window, a neighbour claims it in one tap and collects it from your doorstep, porch, garden or lobby — never the pavement.

Sign up (with a real address picker), a home feed under a proper masthead (search with live suggestions, distance sort, custom radius), a map with photo pins, item detail with a sticky claim dock, the camera listing flow, claim/collect with a 30-minute hold, an arrangement thread per claim, two-way star ratings, wish lists with instant alerts, public asks, follows, badges, and the three mechanics nobody else has — last orders, rain checks and first dibs — all backed by a real API and database with genuine London geography (postcodes.io).

The London competitor analysis and launch strategy that shaped the current feature set lives in the "Doorstep in London" artifact (eight research streams: Olio, Freegle/Freecycle/Trash Nothing, Marketplace/Gumtree/Nextdoor, London reuse landscape, monetization, UK legal, launch playbooks, seed data).

## Run it

Two processes — the API and the web app:

```bash
npm install
npm run server   # API on http://localhost:4000
npm run dev      # web app on http://localhost:5173 (proxies /api to 4000)
```

The API needs Postgres. You do not have to install one: with no `DATABASE_URL` set it runs [PGlite](https://pglite.dev) — real Postgres compiled to WebAssembly, in-process — so the same SQL runs locally, in the tests, and on Supabase. Set `PGLITE_DIR=server/.pgdata` if you want local data to survive a restart. Point `DATABASE_URL` at Supabase and it uses that instead.

A demo account is seeded: `demo@doorstep.uk` / `doorstep123`. Two hundred listings across twenty real Hackney roads are re-seeded with fresh windows every time the server starts — food and non-food, full descriptions and details, real pictures — plus recent collections for the "Just gone" strip, live asks, and history so the personal screens and diversion figures are never empty.

## What's here

```
src/
  App.jsx      all screens and state, talks to the API (feed, detail, map, give, auth)
  styles.css   the full design system, incl. the desktop phone shell
  reset.css    minimal normalisation
  main.jsx     React root
server/
  index.js     Express API: auth, sessions, items, claims, strikes, wishes, SSE stream
  db.js        Postgres schema and access, scrypt password hashing, London seed
  geo.js       postcodes.io geocoding (cached), haversine distance, pin fuzzing
  autospec.js  photo → structured listing draft via the Claude API (optional)
  impact.js    diversion reporting: items, weight, CO2e, avoided cost by postcode
```

The database is Postgres — Supabase in production, PGlite locally. Sessions are opaque bearer tokens stored server-side, so sign-out genuinely revokes them.

## Tests

```bash
npm test
```

Sixty-nine tests and counting, no mocks: the API suite boots the real server against a throwaway Postgres (PGlite) and exercises the rules that matter — a claim race between two neighbours, addresses staying hidden from everyone but the claimer, map pins staying snapped to the grid, unsafe items being refused, saved searches firing only on genuine matches, and collected items moving from the feed into the diversion figures. The geo tests cover distance, formatting and pin blurring.

## The API

| Route | What it does |
|---|---|
| `POST /api/auth/signup` | name, email, postcode, password → token. Postcode is geocoded via postcodes.io — well-formed but non-existent postcodes are rejected. |
| `POST /api/auth/signin` | email, password → token |
| `POST /api/auth/signout` | revokes the session |
| `GET /api/me` | the signed-in user |
| `GET /api/items` | live items with real distances from the signed-in user and ~110m-fuzzed map pins. The full address (and exact pin) only appears on items you listed or claimed. Lapsed 30-minute holds are swept here — the item returns to the feed and the claimer gets a no-show strike. |
| `POST /api/items` | list an item (title, note, cat, kind, road, address, spot, optional windowMinutes, optional photo as a data URL — the app downscales camera shots to ~900px JPEG). Car seats, cot mattresses and age-restricted goods are refused. Item coordinates come from the giver's postcode. |
| `POST /api/items/:id/claim` | 30-minute hold; returns the address and collection spot. 409 if someone got there first, 410 if the window closed, 403 after three no-show strikes in 30 days. |
| `POST /api/items/:id/collected` | claimer confirms the pickup — closes the loop and protects them from a strike. |
| `GET /api/items/:id/fallback` | for your own listing: charity and council options if nobody takes it |
| `GET /api/stream?token=…` | Server-Sent Events. New listings matching a saved search arrive here instantly. |
| `GET/POST/DELETE /api/alerts` | saved searches — keyword, category, radius (max 10 per person) |
| `GET /api/notifications`, `POST /api/notifications/read` | alert history and marking it read |
| `POST /api/autospec` | photo (data URL) → drafted title, note, category, size, hazards. `GET /api/autospec/status` reports whether it's switched on. |
| `GET /api/impact` | your diversion figures and the neighbourhood's, split by postcode district |

### Photo auto-spec

Listing from a photo calls the Claude API (`claude-opus-5`, structured output) to draft the title, note, category and estimated size — the giver confirms instead of typing. The estimated size sets the window: 2 hours to carry, 3 for two-person, 4 for a van job. It also flags hazards (fire labels, untested electricals) and refuses items that can't be passed on second-hand.

It's optional. Set `ANTHROPIC_API_KEY` before `npm run server` to switch it on; without a key the app quietly falls back to the manual form.

### Alerts

A saved search is keyword + category + radius. When a listing matches, the server writes a notification and pushes it down the SSE stream — the bell in the header updates without a refresh. This is deliberately free: Olio charges £2.99/month for alerts that are fast enough to win an item, and slow alerts are the most-cited complaint about every competitor.

A lapsed 30-minute hold releases the item back to the feed automatically — no cron needed, status is computed on read.

## Try

- Submit the signup form empty, or type an invalid postcode — validation is real, on both client and server
- Sign up with an email twice — the server refuses the second account
- Claim something. It holds for you for 30 minutes and the card swaps the road name for the full address
- Open a second browser (or the Android app) as another user — the item shows "Already claimed" and no address
- List something yourself: "Give something away" opens the camera (on a phone; a file picker on desktop), you fill in the details, pick a 2- or 4-hour window, and confirm the not-on-the-pavement rule before it goes live
- Save a search ("lamp", within a mile), then list a matching item from another account in a second browser — the alert lands in the first window instantly, no refresh
- Open one of your own listings and tap "What if nobody takes it?" — charity collection first, council booking last
- Tap the person icon or the postcode chip to open your profile — given/collected counts, your no-show standing, saved searches, your diversion figures, and Sign out (the token is revoked server-side)

## The one rule

Items must be left on the user's own property — doorstep, front garden, porch or building lobby — never on the pavement.

This is not a style preference. Under the Environmental Protection Act 1990, leaving items on public land is fly-tipping, and fixed penalty notices now run up to £1,000 — 17+ London boroughs charge the maximum, and ~50,000 FPNs were issued in London in 2024/25 alone. A resident in Bournemouth was fined for furniture left outside her house with a note inviting people to take it; her appeal was rejected. Because 54% of London households are flats, the app offers collection spots that all stay on private property: doorstep, front garden, porch, building lobby, or "buzz and I'll bring it down".

The whole product depends on never encouraging that behaviour. It's stated on the signup screen for that reason, and it should stay prominent wherever an item is listed.

## Design notes

**Palette** comes from British street furniture rather than generic eco-green: bottle green (`#234A3B`) like Victorian park railings, pale weathered render (`#E5E7DF`) as the ground, hi-vis signal yellow (`#F5C518`) reserved for the countdown and nothing else.

**Type** is Bricolage Grotesque for display, Instrument Sans for body, DM Mono for the countdown. The mono timer is deliberate — it should read like a parking meter.

**The feed sorts by time remaining, not distance.** This is the opposite of every marketplace and it's correct here: an item 0.2 miles away with four minutes left is less useful than one half a mile away with ninety.

**Messaging exists only where a claim does.** Every claim opens exactly one arrangement thread, and the app itself writes the milestones into it — claimed (with where to go), handed back, collected — so the thread is the errand's own record. No thread exists without a claim behind it; there are no cold DMs, no social feed. That constraint is the differentiator: the back-and-forth that plagues Marketplace giveaways has nowhere to live here.

## Not built yet

1. **Native push.** Alerts are instant in-app over SSE, but a closed app stays quiet. Production push needs `@capacitor/push-notifications` with Firebase (Android) and APNs (iOS, needs an Apple Developer account). Until then the app must be open to hear an alert.
2. **Verified weight and CO2 factors.** `server/impact.js` uses placeholder constants — only the avoided-cost figure is grounded (Hackney's £15 per five bulky items). Replace them with WRAP's published reuse weights and CO2e factors before any figure is shown to a council or the public. The file says so in a comment; keep it that way until it's true.
3. **Charity booking as a real integration.** The fallback screen links out to BHF, Emmaus and Traid booking pages. Booking inside the app, with the collection tracked against the listing, is what makes the council reporting complete.
4. **Address verification.** Nextdoor's residency check is why its giveaways feel safe. Today "verified" only means the postcode geocoded — a postcard code or bank check would make the badge mean what people will read into it.
5. **Photo storage.** Photos are data URLs in Postgres, served by reference with immutable caching — fine at launch scale, wrong at real scale. Move to object storage with signed URLs.

## Known issues

- **The 30-minute hold is swept lazily**, on read. If nobody opens the app, a lapsed claim isn't recorded until someone does. Fine at this size; needs a timer or a cron job when volume grows.
- **The seed re-runs on every server start**, wiping and re-listing the demo catalogue. Real listings from other accounts survive, but don't build anything that assumes seed IDs are stable.

## Before launch

Take advice on the waste-carrier question. If someone regularly collects items to resell they may need a waste carrier registration, and a household that hands waste to an unregistered carrier can be liable. Keep the framing as goods being given between neighbours, not waste being disposed of — that distinction is legally load-bearing.

## Deploying

Two pieces: the web app goes to Vercel, the API goes to Render.

### Database — Supabase

Create a project, then **Project Settings → Database → Connection string → URI**. Use the **Session pooler** URI on port **5432**, not the transaction pooler on 6543: claiming an item takes a `SELECT … FOR UPDATE` row lock so two neighbours tapping at the same instant cannot both win, and transaction pooling breaks that. Replace `[YOUR-PASSWORD]` with the real password.

You do not need to create any tables. The API creates its own schema on first boot.

### API — Render

Render dashboard → **New → Blueprint** → point it at this repo, or **New → Web Service** and fill in:

- Build command: `npm ci`
- Start command: `npm run server`
- Health check path: `/api/health`
- Environment: `DATABASE_URL` (the Supabase URI) and `NODE_VERSION` = `22`

Do **not** add a Render Postgres or a disk. The database lives in Supabase, so this service holds no state and can sleep, restart or scale without losing anything.

On the free instance the service sleeps after about 15 minutes of inactivity and takes roughly a minute to wake, so the first request after a quiet spell is slow; long-lived connections are also cut, which means the live alerts stream reconnects rather than staying open. Neither matters for a demo. Both matter for real neighbours waiting on an alert.

Optional: set `ANTHROPIC_API_KEY` to switch on drafting a listing from its photo. Without it the app quietly falls back to the manual form.

### Web app — Vercel

Import the repo. `vercel.json` already sets the framework, the build and the SPA rewrite, so the only thing to add is one environment variable:

```
VITE_API_URL = https://<your-render-service>.onrender.com/api
```

It is read at build time, not at run time, so **changing it means redeploying**, not just saving it. Leave it unset and the app calls `/api` on its own origin, which is right for local development and wrong on Vercel.

### After both are up

```bash
curl https://<your-render-service>.onrender.com/api/health
```

should return `{"ok":true,...}`. Then sign in on the Vercel URL with the seeded demo account. The API allows any origin — every route is bearer-token authenticated rather than cookie based, so the web app, the Android app and the iOS app can all call it.

To point the phone apps at the hosted API instead of a machine on your LAN:

```bash
VITE_API_URL=https://<your-render-service>.onrender.com/api npm run build
npx cap sync
```

## Mobile apps (Capacitor)

The same codebase ships as native Android and iOS apps via [Capacitor](https://capacitorjs.com). The web build in `dist/` is wrapped in a native shell; the `android/` and `ios/` folders are the native projects and are committed as source.

After any change to the web app, rebuild and copy the assets into both platforms:

```bash
npm run build; npx cap sync
```

To build and run the Android app, open the project in Android Studio:

```bash
npx cap open android
```

The `ios/` project can only be built on a Mac (or macOS CI) with Xcode installed:

```bash
npx cap open ios
```

The native apps can't reach `localhost`, so point them at the machine running the API before building — the server already listens on all interfaces:

```bash
VITE_API_URL=http://<your-pc-lan-ip>:4000/api npm run build; npx cap sync
```

(PowerShell: `$env:VITE_API_URL = "http://<your-pc-lan-ip>:4000/api"; npm run build; npx cap sync`.) The phone must be on the same network, and Windows Firewall must allow inbound connections to Node on port 4000.
