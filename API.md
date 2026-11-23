# Email Tracker API

Base URL: the value of `BASE_URL` (e.g. `https://track.example.com`).

**Auth:** none. There is no login or API key, so restrict network access to the service (see HOW_IT_WORKS.md). Errors are always `{"error": "message"}`.

## Interactive docs (Swagger UI)
Set `ENABLE_SWAGGER=true` in `.env` and restart. Then:
- `GET /docs` – Swagger UI
- `GET /openapi.json` – raw OpenAPI 3 spec

Accepted truthy values: `true`, `1`. Anything else (or unset) disables both routes (404). Keep it off in production.

---

## Flow
1. **Before sending:** `POST /api/pixels` with the recipient's email -> get a `token` and the `<img>` tag. Embed the tag in the email.
2. **Send the email.** Your mail system gives you a `parent_id`.
3. **After sending:** `POST /api/pixels/link` with the `token` and `parent_id` -> the pixel is now mapped to that parent_id and shows up on the dashboard.

Opens that happen before step 3 are still recorded; they appear on the dashboard once linked.

## POST /api/pixels
Step 1. Creates a pixel for one email. Every call creates a new pixel (a new token).

Body:
```json
{ "email": "bob@example.com" }
```
Response `201`:
```json
{
  "token": "9f2c1a7e5b3d4c8a90e1f2a3b4c5d6e7",
  "email": "bob@example.com",
  "parent_id": null,
  "pixel_url": "http://localhost:3000/t/9f2c1a7e5b3d4c8a90e1f2a3b4c5d6e7.gif",
  "html": "<img src=\"http://localhost:3000/t/9f2c...gif\" width=\"1\" height=\"1\" alt=\"\" style=\"display:none\" />"
}
```
Errors: `400` (invalid `email`).

```bash
curl -X POST http://localhost:3000/api/pixels -H "Content-Type: application/json" -d '{"email":"bob@example.com"}'
```

## POST /api/pixels/link
Step 2. Maps the token to the `parent_id` you got after sending.

Body:
```json
{ "token": "9f2c1a7e5b3d4c8a90e1f2a3b4c5d6e7", "parent_id": "newsletter-nov" }
```
Response `200`: same shape as above, with `parent_id` filled in.
Errors: `400` (missing token / parent_id), `404` (unknown token), `409` (token already linked to a different `parent_id`). Repeating the call with the same `parent_id` is fine.

```bash
curl -X POST http://localhost:3000/api/pixels/link -H "Content-Type: application/json"   -d '{"token":"9f2c1a7e5b3d4c8a90e1f2a3b4c5d6e7","parent_id":"newsletter-nov"}'
```

## GET /t/{token}.gif
Public. Called by the recipient's email client. Always returns a 1x1 `image/gif` immediately (unknown tokens are ignored) and records an open (time, IP, user agent). Stores at most the last 200 opens per recipient.

## GET /api/parents
Campaign list, newest first (max 500). Only linked pixels (with a parent_id) are included.
```json
[{ "parent_id": "newsletter-nov", "recipients": 120, "opened": 54, "totalOpens": 91,
   "createdAt": "2026-11-23T09:00:00.000Z", "lastOpenedAt": "2026-11-23T14:12:03.000Z" }]
```
`opened` = recipients with at least one open. `lastOpenedAt` is `null` if none.

## GET /api/parents/{parentId}
Detail for one campaign. `404` if no pixel is linked to the `parent_id`.
```json
{
  "parent_id": "newsletter-nov", "recipients": 120, "opened": 54, "totalOpens": 91,
  "timeline": [{ "hour": "2026-11-23T09:00:00.000Z", "opens": 12 }],
  "emails": [{
    "email": "bob@example.com", "sentAt": "...", "openCount": 2,
    "firstOpenedAt": "...", "lastOpenedAt": "...",
    "opens": [{ "at": "...", "ip": "1.2.3.4", "userAgent": "..." }]
  }]
}
```
`opens` holds the 20 most recent events, newest first. `timeline` buckets opens per hour (UTC).

---

## Caveats
- Apple Mail Privacy Protection and Gmail's image proxy may load the pixel automatically, inflating opens and masking real IPs.
- Clients that block images will not register an open.
- Your own opens of a sent email are counted.
