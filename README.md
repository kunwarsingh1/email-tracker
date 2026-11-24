# email-tracker

Email open-tracking pixel service with a dashboard. See `API.md` for the endpoints and `HOW_IT_WORKS.md` for the internals.

Two ways to run it (same API, same MongoDB collection):

| | Entry point | Use for |
|---|---|---|
| Express + Mongoose | `src/server.js` (`npm start`, or `docker compose up`) | Any Node/Docker host |
| Cloudflare Worker | `worker/index.js` (`wrangler.toml`) | Cloudflare Workers |

## Deploy on Cloudflare Workers

1. In the Worker's **Settings > Variables and Secrets** add:
   - `MONGODB_URI` (type **Secret**): your Atlas connection string, including the database name, e.g. `mongodb+srv://user:pass@cluster.mongodb.net/email_tracker`. If the `mongodb+srv://` form fails, use Atlas's non-SRV "standard connection string" instead.
   - `BASE_URL` (optional): your public URL. If unset, the Worker's own origin is used.
   - `ENABLE_SWAGGER` (optional): `true` to serve `/docs` and `/openapi.json`.
2. In Atlas **Network Access**, allow Cloudflare to connect (Workers have no fixed IPs, so use `0.0.0.0/0` with a strong DB password).
3. Make sure `name` in `wrangler.toml` matches your Worker's name in the dashboard, then push; the build runs `npx wrangler deploy`.
   - Locally: `npx wrangler dev` (put `MONGODB_URI=...` in a `.dev.vars` file) and `npx wrangler deploy`.

Routes: `/dashboard`, `/api/pixels`, `/api/pixels/link`, `/api/parents`, `/api/parents/:id`, `/t/<token>.gif`.
