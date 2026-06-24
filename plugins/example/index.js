/**
 * Example FFXI Dashboard plugin.
 *
 * Drop a directory like this one in plugins/ (or set PLUGIN_DIR env var).
 * The init() function receives { pool, app } and may return an Express Router.
 * The router is mounted at /api/plugins/<name>.
 *
 * @type {import('../../src/plugin').Plugin}
 */
const { Router } = require('express');

/** @type {import('../../src/plugin').Plugin} */
const plugin = {
  name:    'example',
  version: '1.0.0',

  init({ pool }) {
    const router = Router();

    // GET /api/plugins/example/ping
    router.get('/ping', (_req, res) => {
      res.json({ pong: true, plugin: 'example' });
    });

    // GET /api/plugins/example/zone-count
    router.get('/zone-count', async (_req, res) => {
      const [rows] = await pool.execute('SELECT COUNT(*) AS n FROM zone_settings');
      res.json({ zones: rows[0].n });
    });

    return router;
  },
};

module.exports = plugin;
