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
    thread_id: doc.thread_id || null,
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
// Optional grouping: emails linked with the same `thread_id` are shown together on the dashboard.
router.post('/api/pixels/link', async (req, res, next) => {
  try {
    const { token, parent_id, thread_id } = req.body || {};
    if (typeof token !== 'string' || !token.trim()) return res.status(400).json({ error: 'token is required' });
    if (typeof parent_id !== 'string' || !parent_id.trim()) return res.status(400).json({ error: 'parent_id is required' });
    const pid = parent_id.trim();

    const thread = typeof thread_id === 'string' && thread_id.trim() ? thread_id.trim() : null;
    const set = { parent_id: pid };
    if (thread && thread !== pid) set.thread_id = thread;

    // Succeeds if unlinked, or already linked to the same parent_id (idempotent).
    const doc = await Pixel.findOneAndUpdate(
      { token: token.trim(), $or: [{ parent_id: null }, { parent_id: pid }] },
      { $set: set },
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
      // Group by thread (replies share one), falling back to the pixel's own parent_id.
      { $addFields: { group: { $ifNull: ['$thread_id', '$parent_id'] } } },
      {
        $group: {
          _id: '$group',
          messages: { $addToSet: '$parent_id' },
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
    res.json(rows.map(r => ({ parent_id: r._id, messages: r.messages.length, recipients: r.recipients, opened: r.opened, totalOpens: r.totalOpens, createdAt: r.createdAt, lastOpenedAt: r.lastOpenedAt || null })));
  } catch (e) { next(e); }
});

// Latest opens across all campaigns (for the dashboard's Locations tab).
router.get('/api/opens', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const rows = await Pixel.aggregate([
      { $match: { parent_id: { $ne: null }, 'opens.0': { $exists: true } } },
      { $unwind: '$opens' },
      { $sort: { 'opens.at': -1 } },
      { $limit: limit },
      { $project: { _id: 0, email: 1, parent_id: 1, thread_id: 1, open: '$opens' } },
    ]);
    res.json(rows.map(r => ({ email: r.email, campaign: r.thread_id || r.parent_id, message: r.parent_id, ...r.open })));
  } catch (e) { next(e); }
});

// Dashboard: detail for one parent_id.
router.get('/api/parents/:parentId', async (req, res, next) => {
  try {
    const id = req.params.parentId;
    const docs = await Pixel.find({ $or: [{ thread_id: id }, { thread_id: null, parent_id: id }] }).sort({ createdAt: 1 }).lean();
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
        email: d.email, parent_id: d.parent_id, sentAt: d.createdAt, openCount: d.openCount,
        firstOpenedAt: d.firstOpenedAt || null, lastOpenedAt: d.lastOpenedAt || null,
        opens: d.opens.slice(-20).reverse(),
      })),
    });
  } catch (e) { next(e); }
});

module.exports = router;
