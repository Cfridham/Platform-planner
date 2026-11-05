// Shared planner state, stored as one private JSON blob in Vercel Blob.
// GET  /api/state[?rev=N]  -> { rev, at, data }   (404 when nothing saved yet; { same:true } if rev matches)
// POST /api/state          -> body { baseRev, data }; 409 + latest copy if someone else saved first
const { put, get } = require('@vercel/blob');

const PATH = 'platform-planner/state.json';

async function readState() {
  const r = await get(PATH, { access: 'private' });
  if (!r || r.statusCode !== 200) return null;
  const text = await new Response(r.stream).text();
  return JSON.parse(text);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const cur = await readState();
      if (!cur) return res.status(404).json({ empty: true });
      if (req.query && String(req.query.rev) === String(cur.rev)) return res.status(200).json({ same: true, rev: cur.rev });
      return res.status(200).json(cur);
    }
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      if (!body || typeof body.data !== 'object') return res.status(400).json({ error: 'bad body' });
      const cur = await readState();
      const curRev = cur ? cur.rev : 0;
      if ((body.baseRev || 0) !== curRev) return res.status(409).json(cur);
      const next = { rev: curRev + 1, at: new Date().toISOString(), data: body.data };
      await put(PATH, JSON.stringify(next), {
        access: 'private',
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: 'application/json',
      });
      return res.status(200).json({ rev: next.rev, at: next.at });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    const msg = String((e && e.message) || e);
    const notSet = /token|BLOB_|No token|store/i.test(msg);
    return res.status(notSet ? 503 : 500).json({ error: notSet ? 'storage not configured' : 'state error', detail: msg.slice(0, 200) });
  }
};
