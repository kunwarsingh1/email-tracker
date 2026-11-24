// Cloudflare Worker version of the email tracker (same API as the Express app in src/).
import { Hono } from 'hono';
import { MongoClient } from 'mongodb';
import dashboardHtml from '../public/index.html';
import buildSpec from '../src/openapi.js';

const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_OPENS = 200;

const app = new Hono();

const baseUrl = c => (c.env.BASE_URL || new URL(c.req.url).origin).replace(/\/$/, '');
const swaggerOn = c => ['true', '1'].includes(String(c.env.ENABLE_SWAGGER || '').trim().toLowerCase());
const randomToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');

function pixelPayload(c, doc) {
  const url = `${baseUrl(c)}/t/${doc.token}.gif`;
  return {
    token: doc.token,
    email: doc.email,
    parent_id: doc.parent_id ?? null,
    pixel_url: url,
    html: `<img src="${url}" width="1" height="1" alt="" style="display:none" />`,
  };
}

// Workers can't share sockets between requests, so open a short-lived client per request.
let indexesReady = false;
async function ensureIndexes(col) {
  if (indexesReady) return;
  await col.createIndex({ token: 1 }, { unique: true });
  await col.createIndex({ parent_id: 1 });
  // Older versions had a unique (parent_id,email) index that breaks unlinked pixels.
  await col.dropIndex('parent_id_1_email_1').catch(() => {});
  indexesReady = true;
}

async function withPixels(c, fn, { indexes = true } = {}) {
  if (!c.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  const client = new MongoClient(c.env.MONGODB_URI, { maxPoolSize: 1, serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    const col = client.db().collection('pixels');
    if (indexes) await ensureIndexes(col);
    return await fn(col);
  } finally {
    c.executionCtx.waitUntil(client.close().catch(() => {}));
  }
}

const readJson = async c => {
  try { const b = await c.req.json(); return b && typeof b === 'object' ? b : {}; } catch { return {}; }
};

// ---- Dashboard ----
app.get('/', c => c.redirect('/dashboard'));
app.get('/dashboard', c => c.html(dashboardHtml));

// ---- Swagger UI (ENABLE_SWAGGER=true) ----
app.get('/openapi.json', c => (swaggerOn(c) ? c.json(buildSpec(baseUrl(c))) : c.notFound()));
app.get('/docs', c => (swaggerOn(c) ? c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Email Tracker API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head><body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:'/openapi.json',dom_id:'#ui'})</script></body></html>`) : c.notFound()));

// ---- Step 1: create a pixel (before sending) ----
app.post('/api/pixels', async c => {
  const { email } = await readJson(c);
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) return c.json({ error: 'valid email is required' }, 400);
  const now = new Date();
  const doc = {
    token: randomToken(), email: email.trim().toLowerCase(), parent_id: null,
    opens: [], openCount: 0, createdAt: now, updatedAt: now,
  };
  await withPixels(c, col => col.insertOne(doc));
  return c.json(pixelPayload(c, doc), 201);
});

// ---- Step 2: link token -> parent_id (after sending) ----
app.post('/api/pixels/link', async c => {
  const { token, parent_id } = await readJson(c);
  if (typeof token !== 'string' || !token.trim()) return c.json({ error: 'token is required' }, 400);
  if (typeof parent_id !== 'string' || !parent_id.trim()) return c.json({ error: 'parent_id is required' }, 400);
  const t = token.trim();
  const pid = parent_id.trim();
  return withPixels(c, async col => {
    const doc = await col.findOneAndUpdate(
      { token: t, $or: [{ parent_id: null }, { parent_id: pid }] },
      { $set: { parent_id: pid, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!doc) {
      return (await col.countDocuments({ token: t }, { limit: 1 }))
        ? c.json({ error: 'token is already linked to a different parent_id' }, 409)
        : c.json({ error: 'token not found' }, 404);
    }
    return c.json(pixelPayload(c, doc));
  });
});

// ---- Public tracking pixel ----
app.get('/t/:file', c => {
  const file = c.req.param('file');
  if (!file.endsWith('.gif')) return c.notFound();
  const token = file.slice(0, -4);
  const now = new Date();
  const open = { at: now, ip: c.req.header('cf-connecting-ip') || null, userAgent: c.req.header('user-agent') || null };
  // Respond immediately; record the open in the background.
  c.executionCtx.waitUntil(
    withPixels(c, col => col.updateOne({ token }, [{
      $set: {
        opens: { $slice: [{ $concatArrays: ['$opens', [open]] }, -MAX_OPENS] },
        openCount: { $add: ['$openCount', 1] },
        firstOpenedAt: { $ifNull: ['$firstOpenedAt', now] },
        lastOpenedAt: now,
        updatedAt: now,
      },
    }]), { indexes: false }).catch(e => console.error('track error', e.message))
  );
  return new Response(GIF, {
    headers: {
      'Content-Type': 'image/gif',
      'Content-Length': String(GIF.length),
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
    },
  });
});

// ---- Dashboard API ----
app.get('/api/parents', c => withPixels(c, async col => {
  const rows = await col.aggregate([
    { $match: { parent_id: { $ne: null } } },
    {
      $group: {
        _id: '$parent_id',
        recipients: { $sum: 1 },
        opened: { $sum: { $cond: [{ $gt: ['$openCount', 0] }, 1, 0] } },
        totalOpens: { $sum: '$openCount' },
        createdAt: { $min: '$createdAt' },
        lastOpenedAt: { $max: '$lastOpenedAt' },
      },
    },
    { $sort: { createdAt: -1 } },
    { $limit: 500 },
  ]).toArray();
  return c.json(rows.map(r => ({
    parent_id: r._id, recipients: r.recipients, opened: r.opened, totalOpens: r.totalOpens,
    createdAt: r.createdAt, lastOpenedAt: r.lastOpenedAt || null,
  })));
}));

app.get('/api/parents/:parentId', c => withPixels(c, async col => {
  const parentId = c.req.param('parentId');
  const docs = await col.find({ parent_id: parentId }).sort({ createdAt: 1 }).toArray();
  if (!docs.length) return c.json({ error: 'parent_id not found' }, 404);
  const timeline = {};
  for (const d of docs) {
    for (const o of d.opens || []) {
      const h = new Date(o.at);
      h.setUTCMinutes(0, 0, 0);
      const k = h.toISOString();
      timeline[k] = (timeline[k] || 0) + 1;
    }
  }
  return c.json({
    parent_id: parentId,
    recipients: docs.length,
    opened: docs.filter(d => d.openCount > 0).length,
    totalOpens: docs.reduce((s, d) => s + (d.openCount || 0), 0),
    timeline: Object.entries(timeline).sort().map(([hour, opens]) => ({ hour, opens })),
    emails: docs.map(d => ({
      email: d.email, sentAt: d.createdAt, openCount: d.openCount || 0,
      firstOpenedAt: d.firstOpenedAt || null, lastOpenedAt: d.lastOpenedAt || null,
      opens: (d.opens || []).slice(-20).reverse(),
    })),
  });
}));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal error' }, 500);
});

export default app;
