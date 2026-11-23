require('dotenv').config();
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');

for (const k of ['MONGODB_URI', 'BASE_URL']) {
  if (!process.env[k]) { console.error(`Missing env var ${k} (see .env.example)`); process.exit(1); }
}

const app = express();
app.set('trust proxy', true); // so req.ip is the real client behind a proxy
app.use(express.json());
app.use(require('./routes/pixels'));

// API docs (Swagger UI), toggled by ENABLE_SWAGGER=true
const swaggerOn = ['true', '1'].includes(String(process.env.ENABLE_SWAGGER || '').trim().toLowerCase());
if (swaggerOn) {
  const swaggerUi = require('swagger-ui-express');
  const spec = require('./openapi')();
  app.get('/openapi.json', (req, res) => res.json(spec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec, { swaggerOptions: { persistAuthorization: true } }));
}
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Internal error' }); });

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  await require('./models/Pixel').syncIndexes(); // drops the old unique (parent_id,email) index if present
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`email-tracker listening on :${port}`);
    if (swaggerOn) console.log(`Swagger UI: ${process.env.BASE_URL.replace(/\/$/, '')}/docs`);
  });
}).catch(e => { console.error('Mongo connection failed:', e.message); process.exit(1); });
