const mongoose = require('mongoose');

const openSchema = new mongoose.Schema(
  { at: { type: Date, default: Date.now }, ip: String, userAgent: String },
  { _id: false }
);

// One document per sent email. parent_id is null until linked via POST /api/pixels/link.
const pixelSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true },
    parent_id: { type: String, default: null, index: true },
    thread_id: { type: String, default: null, index: true }, // optional: groups replies on the dashboard
    email: { type: String, required: true, lowercase: true, trim: true },
    opens: { type: [openSchema], default: [] },
    openCount: { type: Number, default: 0 },
    firstOpenedAt: Date,
    lastOpenedAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model('Pixel', pixelSchema);
