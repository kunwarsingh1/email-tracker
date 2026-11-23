const express = require('express');
const crypto = require('crypto');
const Pixel = require('../models/Pixel');

const router = express.Router();

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function pixelPayload(doc) {
  const url = `${process.env.BASE_URL.replace(/\/$/, '')}/t/${doc.token}.gif`;
  return {
    token: doc.token,
    email: doc.email,
    parent_id: doc.parent_id,
    pixel_url: url,
    html: `<img src="${url}" width="1" height="1" alt="" style="display:none" />`,
  };
}

// Step 1 (before sending): create a pixel for one email. parent_id is not known yet.
router.post('/api/pixels', async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) return res.status(400).json({ error: 'valid email is required' });
    const doc = await Pixel.create({ token: crypto.randomBytes(16).toString('hex'), email: email.trim().toLowerCase() });
    res.status(201).json(pixelPayload(doc));
  } catch (e) { next(e); }
});

// Step 2 (after sending): attach the parent_id to the pixel's token.
router.post('/api/pixels/link', async (req, res, next) => {
  try {
    const { token, parent_id } = req.body || {};
    if (typeof token !== 'string' || !token.trim()) return res.status(400).json({ error: 'token is required' });
    if (typeof parent_id !== 'string' || !parent_id.trim()) return res.status(400).json({ error: 'parent_id is required' });
    const pid = parent_id.trim();
    // Succeeds if unlinked, or already linked to the same parent_id (idempotent).
    const doc = await Pixel.findOneAndUpdate(
      { token: token.trim(), $or: [{ parent_id: null }, { parent_id: pid }] },
      { $set: { parent_id: pid } },
      { new: true }
    );
    if (!doc) {
      return (await Pixel.exists({ token: token.trim() }))
        ? res.status(409).json({ error: 'token is already linked to a different parent_id' })
        : res.status(404).json({ error: 'token not found' });
    }
    res.json(pixelPayload(doc));
  } catch (e) { next(e); }
});

// Public tracking endpoint hit by the email client.
router.get('/t/:token.gif', async (req, res) => {
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': GIF.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
  });
  res.end(GIF); // always respond fast, even if the token is unknown
  try {
    const now = new Date();
    const open = { at: now, ip: req.ip, userAgent: req.get('user-agent') };
    await Pixel.updateOne(
      { token: req.params.token },
      [{
        $set: {
          opens: { $slice: [{ $concatArrays: ['$opens', [open]] }, -200] }, // cap stored events
          openCount: { $add: ['$openCount', 1] },
          firstOpenedAt: { $ifNull: ['$firstOpenedAt', now] },
          lastOpenedAt: now,
        },
      }]
    );
  } catch (e) { console.error('track error', e.message); }
});

// Dashboard: list of parent_ids with summary.
router.get('/api/parents', async (req, res, next) => {
  try {
    const rows = await Pixel.aggregate([
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
    ]);
    res.json(rows.map(r => ({ parent_id: r._id, recipients: r.recipients, opened: r.opened, totalOpens: r.totalOpens, createdAt: r.createdAt, lastOpenedAt: r.lastOpenedAt || null })));
  } catch (e) { next(e); }
});

// Dashboard: detail for one parent_id.
router.get('/api/parents/:parentId', async (req, res, next) => {
  try {
    const docs = await Pixel.find({ parent_id: req.params.parentId }).sort({ createdAt: 1 }).lean();
    if (!docs.length) return res.status(404).json({ error: 'parent_id not found' });
    const timeline = {};
    for (const d of docs) for (const o of d.opens) {
      const h = new Date(o.at); h.setMinutes(0, 0, 0);
      timeline[h.toISOString()] = (timeline[h.toISOString()] || 0) + 1;
    }
    res.json({
      parent_id: req.params.parentId,
      recipients: docs.length,
      opened: docs.filter(d => d.openCount > 0).length,
      totalOpens: docs.reduce((s, d) => s + d.openCount, 0),
      timeline: Object.entries(timeline).sort().map(([hour, opens]) => ({ hour, opens })),
      emails: docs.map(d => ({
        email: d.email, sentAt: d.createdAt, openCount: d.openCount,
        firstOpenedAt: d.firstOpenedAt || null, lastOpenedAt: d.lastOpenedAt || null,
        opens: d.opens.slice(-20).reverse(),
      })),
    });
  } catch (e) { next(e); }
});

module.exports = router;
