// A stand-in for Paystack's API and hosted payment page, for browser tests only.
import { createServer } from 'node:http';

const SECRET = 'sk_test_e2esecret123456';
const txs = new Map();
const read = async (req) => { const c = []; for await (const x of req) c.push(x); return c.length ? JSON.parse(Buffer.concat(c).toString()) : {}; };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (url.pathname === '/__stats') return json(200, { count: txs.size });
  if (url.pathname.startsWith('/pay/')) {
    const ref = decodeURIComponent(url.pathname.slice(5));
    const t = txs.get(ref);
    if (!t) return json(404, {});
    return res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Paystack (test)</title><h1>Pay ${t.amount / 100} ${t.currency}</h1>
      <a id="pay" href="/complete/${encodeURIComponent(ref)}?ok=1">Pay</a> <a id="cancel" href="/complete/${encodeURIComponent(ref)}?ok=0">Cancel</a>`);
  }
  if (url.pathname.startsWith('/complete/')) {
    const ref = decodeURIComponent(url.pathname.slice(10));
    const t = txs.get(ref);
    if (!t) return json(404, {});
    t.status = url.searchParams.get('ok') === '1' ? 'success' : 'abandoned';
    return res.writeHead(302, { location: t.callback_url }).end();
  }
  if (req.headers.authorization !== `Bearer ${SECRET}`) return json(401, { status: false, message: 'Invalid key' });
  if (url.pathname === '/transaction/initialize' && req.method === 'POST') {
    const b = await read(req);
    txs.set(b.reference, { ...b, status: 'pending' });
    return json(200, { status: true, data: { authorization_url: `http://localhost:3400/pay/${encodeURIComponent(b.reference)}`, reference: b.reference } });
  }
  if (url.pathname.startsWith('/transaction/verify/')) {
    const t = txs.get(decodeURIComponent(url.pathname.slice('/transaction/verify/'.length)));
    if (!t) return json(404, { status: false, message: 'Transaction not found' });
    return json(200, { status: true, data: { status: t.status, amount: t.amount, currency: t.currency, reference: t.reference } });
  }
  json(404, { status: false });
}).listen(3400, () => console.log('mock paystack on 3400'));
