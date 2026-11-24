module.exports = function buildSpec(baseUrl = process.env.BASE_URL) {
  const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  return {
    openapi: '3.0.3',
    info: {
      title: 'Email Tracker API',
      version: '1.0.0',
      description: 'Create tracking pixels for emails and read open statistics. Opens are recorded when an email client loads the pixel image.',
    },
    servers: [{ url: baseUrl }],
    tags: [{ name: 'Pixels' }, { name: 'Tracking' }, { name: 'Dashboard' }],
    paths: {
      '/api/pixels': {
        post: {
          tags: ['Pixels'], summary: 'Step 1 - create a tracking pixel (before sending the email)',
          description: 'Takes only the recipient email. Returns a token plus the pixel URL / <img> tag to embed. The parent_id is not known yet; attach it with /api/pixels/link after the email is sent. Every call creates a new pixel.',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreatePixel' } } } },
          responses: {
            201: { description: 'Pixel created', content: { 'application/json': { schema: { $ref: '#/components/schemas/PixelResponse' } } } },
            400: err,
          },
        },
      },
      '/api/pixels/link': {
        post: {
          tags: ['Pixels'], summary: 'Step 2 - link the token to a parent_id (after sending)',
          description: 'Maps the token to the parent_id you received once the email was sent. Idempotent for the same parent_id; 409 if the token is already linked to a different one.',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/LinkPixel' } } } },
          responses: {
            200: { description: 'Linked', content: { 'application/json': { schema: { $ref: '#/components/schemas/PixelResponse' } } } },
            400: err, 404: err, 409: err,
          },
        },
      },
      '/t/{token}.gif': {
        get: {
          tags: ['Tracking'], summary: 'Tracking pixel (hit by email clients)',
          description: 'Public. Always returns a 1x1 GIF immediately; an unknown token is silently ignored. Records an open event.',
          parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' }, example: '9f2c1a7e5b3d4c8a90e1f2a3b4c5d6e7' }],
          responses: { 200: { description: '1x1 transparent GIF', content: { 'image/gif': { schema: { type: 'string', format: 'binary' } } } } },
        },
      },
      '/api/parents': {
        get: {
          tags: ['Dashboard'], summary: 'List campaigns (parent_ids) with summary stats',
          description: 'Only linked pixels (with a parent_id) are included. Newest first, max 500.',
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ParentSummary' } } } } },
           
          },
        },
      },
      '/api/parents/{parentId}': {
        get: {
          tags: ['Dashboard'], summary: 'Detailed stats for one parent_id',
          parameters: [{ name: 'parentId', in: 'path', required: true, schema: { type: 'string' }, example: 'newsletter-nov' }],
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/ParentDetail' } } } },
            404: err,
          },
        },
      },
    },
    components: {
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' } }, example: { error: 'parent_id is required' } },
        CreatePixel: {
          type: 'object', required: ['email'],
          properties: { email: { type: 'string', format: 'email', example: 'bob@example.com' } },
        },
        LinkPixel: {
          type: 'object', required: ['token', 'parent_id'],
          properties: { token: { type: 'string', example: '9f2c1a7e5b3d4c8a90e1f2a3b4c5d6e7' }, parent_id: { type: 'string', example: 'newsletter-nov' } },
        },
        PixelResponse: {
          type: 'object',
          properties: {
            token: { type: 'string' }, email: { type: 'string' }, parent_id: { type: 'string', nullable: true, description: 'null until linked' },
            pixel_url: { type: 'string', example: 'https://track.example.com/t/9f2c1a7e5b3d4c8a90e1f2a3b4c5d6e7.gif' },
            html: { type: 'string', description: 'Ready-to-paste <img> tag', example: '<img src="https://track.example.com/t/abc.gif" width="1" height="1" alt="" style="display:none" />' },
          },
        },
        ParentSummary: {
          type: 'object',
          properties: {
            parent_id: { type: 'string' }, recipients: { type: 'integer' }, opened: { type: 'integer', description: 'Recipients with at least one open' },
            totalOpens: { type: 'integer' }, createdAt: { type: 'string', format: 'date-time' }, lastOpenedAt: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        OpenEvent: { type: 'object', properties: { at: { type: 'string', format: 'date-time' }, ip: { type: 'string' }, userAgent: { type: 'string' } } },
        EmailStats: {
          type: 'object',
          properties: {
            email: { type: 'string' }, sentAt: { type: 'string', format: 'date-time' }, openCount: { type: 'integer' },
            firstOpenedAt: { type: 'string', format: 'date-time', nullable: true }, lastOpenedAt: { type: 'string', format: 'date-time', nullable: true },
            opens: { type: 'array', description: 'Most recent 20 opens, newest first', items: { $ref: '#/components/schemas/OpenEvent' } },
          },
        },
        ParentDetail: {
          type: 'object',
          properties: {
            parent_id: { type: 'string' }, recipients: { type: 'integer' }, opened: { type: 'integer' }, totalOpens: { type: 'integer' },
            timeline: { type: 'array', items: { type: 'object', properties: { hour: { type: 'string', format: 'date-time' }, opens: { type: 'integer' } } } },
            emails: { type: 'array', items: { $ref: '#/components/schemas/EmailStats' } },
          },
        },
      },
    },
  };
};
