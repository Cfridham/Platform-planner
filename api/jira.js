// Vercel serverless function — proxies requests to Jira Cloud so the browser app
// can reach Jira without CORS. Deploy at /api/jira.js next to index.html.
// CommonJS format (no package.json needed).
//
// Auth: set JIRA_EMAIL and JIRA_TOKEN as Vercel Environment Variables (recommended,
// token stays off the browser). If not set, it forwards the browser's Authorization header.
// Only *.atlassian.net targets are allowed.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const target = req.query && req.query.url;
  if (!target) { res.status(400).json({ error: 'Missing ?url= parameter' }); return; }

  let host;
  try { host = new URL(target).hostname; } catch (e) {
    res.status(400).json({ error: 'Invalid url' }); return;
  }
  if (!/\.atlassian\.net$/i.test(host)) {
    res.status(403).json({ error: 'Only *.atlassian.net is allowed' }); return;
  }

  let authHeader = req.headers['authorization'];
  if (process.env.JIRA_EMAIL && process.env.JIRA_TOKEN) {
    authHeader = 'Basic ' + Buffer.from(process.env.JIRA_EMAIL + ':' + process.env.JIRA_TOKEN).toString('base64');
  }
  if (!authHeader) {
    res.status(401).json({ error: 'No credentials: set JIRA_EMAIL/JIRA_TOKEN env vars in Vercel' });
    return;
  }

  try {
    const upstream = await fetch(target, {
      method: req.method === 'POST' ? 'POST' : 'GET',
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: req.method === 'POST' ? JSON.stringify(req.body || {}) : undefined,
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: 'Proxy request failed', detail: String(err) });
  }
};
