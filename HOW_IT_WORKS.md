# How the Email Tracker Works

A walkthrough of every part of the service: what each file does, how a request flows through it, and what is stored in MongoDB.

## 1. The big idea

An email "open" can't be observed directly. The trick is to put a tiny invisible image in the email whose URL is **unique to one sent email**. When the recipient's mail client downloads the image to display the email, that request reaches our server. The server then knows who opened it and when.

```
Your sender app                 Tracker service                       MongoDB
      │ 1. POST /api/pixels          │                                   │
      │    {email} ─────────────────►│ create pixel (parent_id = null) ─►│
      │◄──── {token, pixel_url, html}│                                   │
      │                                                                  │
      │ embed html, send the email -> your mail system gives a parent_id │
      │                                                                  │
      │ 2. POST /api/pixels/link     │                                   │
      │    {token, parent_id} ──────►│ set parent_id on that token ─────►│
      │                                                                  │
Recipient's mail client              │                                   │
      │  GET /t/<token>.gif ────────►│ reply 1x1 GIF immediately         │
      │◄──── image/gif ──────────────│ then record the open ────────────►│
                                                                         │
You in the dashboard                 │                                   │
      │  GET /api/parents… ─────────►│ aggregate / read ────────────────►│
      │◄──── stats ──────────────────│◄──────────────────────────────────│
```

Key terms:
- **parent_id**: the id you get after the email is sent (e.g. `newsletter-nov`). All dashboard grouping is by this. It is attached to the pixel later through the link call.
- **token**: a random 32-character hex string (16 random bytes) identifying one pixel (one sent email). It is the only thing in the public pixel URL, so it reveals nothing about the recipient.

## 2. Project layout

| File | Responsibility |
|---|---|
| `src/server.js` | Boots the app: loads env, validates it, wires middleware and routes, connects to MongoDB, starts listening |
| `src/routes/pixels.js` | All four API endpoints (create pixel, tracking pixel, list campaigns, campaign detail) |
| `src/models/Pixel.js` | The MongoDB schema and indexes |
| `src/openapi.js` | Builds the OpenAPI 3 spec used by Swagger UI |
| `public/index.html` | The dashboard (single static page, no build step) |
| `API.md` | Endpoint reference |
| `.env` / `.env.example` | Configuration |

## 3. Startup (`src/server.js`)

1. `dotenv` loads `.env`.
2. It checks that `MONGODB_URI` and `BASE_URL` exist; if either is missing it prints which one and exits.
3. `app.set('trust proxy', true)`: when deployed behind nginx/a load balancer, `req.ip` then comes from `X-Forwarded-For` (the real client) instead of the proxy's address.
4. `express.json()` parses JSON bodies.
5. Routes are mounted from `routes/pixels.js`.
6. If `ENABLE_SWAGGER` is `true` or `1` (case-insensitive), it mounts `/docs` (Swagger UI) and `/openapi.json`. Otherwise those paths do not exist.
7. `GET /dashboard` serves `public/index.html` (the dashboard); `GET /` redirects to `/dashboard`.
8. An error handler logs unexpected errors and returns `{"error":"Internal error"}` without leaking details.
9. It connects to MongoDB **first**, and only then starts listening, so the service never accepts requests it can't store.

## 4. The data model (`src/models/Pixel.js`)

There is **one collection, `pixels`, with one document per sent email** (one token each). `parent_id` is `null` until the link call. Opens are stored inside that document.

```js
{
  token: "9f2c1a7e…",          // unique, used in the pixel URL
  parent_id: "newsletter-nov",   // null until linked
  email: "bob@example.com",     // lowercased + trimmed
  opens: [ { at, ip, userAgent }, … ],   // capped at the last 200
  openCount: 3,                 // running total (can exceed opens.length once capped)
  firstOpenedAt: Date,
  lastOpenedAt: Date,
  createdAt, updatedAt          // from timestamps: true; createdAt = when the pixel was made ("sent")
}
```

Indexes:
- `token` unique: the pixel lookup on every open is an index hit.
- `parent_id`: speeds up the dashboard queries.

Why embed opens instead of a separate collection? The dashboard always reads opens together with their recipient, a single write updates everything atomically, and the 200-entry cap keeps documents small. The denormalised `openCount`, `firstOpenedAt` and `lastOpenedAt` make list/summary queries cheap and keep them accurate after the cap trims old events.

## 5. Authentication

There is none by design: no login, no API key. Every endpoint is open to anyone who can reach the service, so protect it at the network level (firewall, VPN, private network, or a reverse proxy with basic auth in front of everything except `/t/*`). The tracking pixel must stay publicly reachable so mail clients can load it; its protection is the unguessable random token.

## 6. Endpoints (`src/routes/pixels.js`)

### 6.1 `POST /api/pixels`: create a pixel (step 1, before sending)
1. Validates `email` (basic `x@y.z` pattern); otherwise `400`.
2. Creates a new document with a fresh random token, the lowercased email and `parent_id: null`. Every call makes a new pixel, because each call represents one email you are about to send.
3. Returns `token`, `pixel_url` (`BASE_URL/t/<token>.gif`) and a ready-made `<img>` tag, with `201`.

### 6.1b `POST /api/pixels/link`: map token to parent_id (step 2, after sending)
The parent_id only exists once your mail system has sent the email, so it is attached in a second call. It takes `{token, parent_id}` and does one atomic update: set `parent_id` on the document with that token, but only if it is still unlinked or already has the same `parent_id`. If nothing matched, a second lookup tells `404` (unknown token) from `409` (token linked to a different parent_id). Repeating the call with the same values is harmless. Opens recorded before linking are kept and appear once the pixel is linked.

**Grouping replies.** Each sent email has its own unique `parent_id` (e.g. its Message-ID), so a reply in a thread would show up as a separate campaign. The link call therefore accepts an optional `thread_id`: emails linked with the same one are grouped. The dashboard list groups by `thread_id`, falling back to `parent_id`, and shows a **Messages** count per group. The detail endpoint for a group id returns every email whose `thread_id` equals it, plus the root email whose own `parent_id` equals it.

### 6.2 `GET /t/:token.gif`: the tracking pixel (public)
This is the hot path, hit every time a recipient opens the email.
1. **It responds first.** It sets headers and sends a hard-coded 1×1 transparent GIF (decoded from a base64 constant at startup) *before* touching the database. The email client is never slowed down or broken by a database hiccup, and unknown/invalid tokens look identical to valid ones (nothing is revealed to scanners).
2. Headers include `Cache-Control: no-store, no-cache, must-revalidate, max-age=0` and `Pragma: no-cache`, so clients and proxies are asked to re-fetch the image every time and each open is counted rather than served from cache.
3. After responding, it records the open with one atomic update-with-pipeline on the document matching the token:
   - append `{at, ip, userAgent}` to `opens`, then `$slice` to the last 200 entries
   - `openCount + 1`
   - `firstOpenedAt` set only if it was empty (`$ifNull`)
   - `lastOpenedAt` = now
   
   Because it's one atomic operation, simultaneous opens can't lose each other's counts. If no document matches the token, nothing happens. Errors are logged only; they never affect the response that was already sent.

### 6.3 `GET /api/parents`: campaign list
A MongoDB aggregation grouping all pixel docs by `parent_id`:
- `recipients` = number of docs
- `opened` = docs where `openCount > 0`
- `totalOpens` = sum of `openCount`
- `createdAt` = earliest creation time, `lastOpenedAt` = latest open
Pixels without a `parent_id` are skipped (`$match`). Sorted newest first, limited to 500, and reshaped into `{parent_id, …}` objects.

### 6.4 `GET /api/parents/:parentId`: campaign detail
1. Loads all docs for that `parent_id` (`404` if none).
2. Computes totals (`recipients`, `opened`, `totalOpens`).
3. Builds the **timeline**: every stored open's timestamp is rounded down to its hour, counted per hour, and sorted; the dashboard draws this as a bar chart.
4. Returns each recipient's `openCount`, first/last open and their 20 most recent opens (newest first).

## 7. Dashboard (`public/index.html`)

A single static page with vanilla JavaScript: no framework, no build step, served by the same Express server, so there are no CORS issues.
- **List view** (`/dashboard`): calls `/api/parents` and shows one row per campaign with open rate (`opened / recipients`). Clicking a row navigates to `#<parent_id>`.
- **Detail view** (`/dashboard#<parent_id>`): calls `/api/parents/:id`; shows summary cards, the opens-per-hour bar chart (hover for exact values), and a per-recipient table with an expandable open history.
- Routing is the URL hash (`onhashchange`), so a campaign view is linkable/bookmarkable.
- All values from the server go through an `esc()` function before being put into the HTML, which prevents HTML/script injection through email addresses or `parent_id`s or user agents (an attacker can control the user agent of a request to the public pixel).

## 7b. Location and "was it me?" (Worker only)
Cloudflare attaches `request.cf` to every request (country, region, city, coordinates, timezone, ASN and network name, derived from the IP). Each open stores these plus a `source` classification (direct, Google/Apple/Yahoo proxy, or security scanner) from the user agent and ASN. Proxies fetch images on the reader's behalf, so their location is the proxy's, not the person's; the dashboard labels those. An open is flagged `owner` if its IP is in `OWNER_IPS`, or it is a direct fetch from a city in `OWNER_CITIES`. Owner opens stay in the history but are excluded from `openCount`, first/last opened and the hourly timeline. IP geolocation is approximate (city level, sometimes wrong).

## 8. Swagger / API docs

`src/openapi.js` exports a function that builds the OpenAPI 3.0.3 spec as a plain object (server URL from `BASE_URL`). `server.js` only loads `swagger-ui-express` and mounts `/docs` + `/openapi.json` when `ENABLE_SWAGGER` is true/1, so in production with the flag off the docs don't exist at all (404) and the library isn't even loaded.

## 9. Configuration

| Variable | Meaning |
|---|---|
| `PORT` | HTTP port (default 3000) |
| `MONGODB_URI` | MongoDB connection string |
| `BASE_URL` | Public URL of this service. Used to build `pixel_url`; recipients' mail clients must be able to reach it (HTTPS recommended) |
| `ENABLE_SWAGGER` | `true`/`1` to serve `/docs` and `/openapi.json`; default off |

## 10. Limitations and design trade-offs

- **Opens are an approximation.** Apple Mail Privacy Protection and Gmail's image proxy prefetch images, producing opens that may not be human and hiding the real IP. Clients that block images produce no open at all. Your own viewing of a sent email counts too.
- **Open history is capped** at 200 events per recipient; `openCount` keeps the true total.
- **The 1×1 image can be blocked** by privacy tools; nothing can be done about that server-side.
- **No authentication.** Anyone who can reach the service can create pixels and read all stats; restrict access at the network level.
- **The dashboard list is capped at 500 campaigns** and unpaginated.
- **Scaling:** the service is stateless, so you can run several instances behind a load balancer; all state lives in MongoDB, and the atomic updates stay correct across instances.
