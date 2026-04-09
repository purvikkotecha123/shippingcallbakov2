'use strict';

require('dotenv').config();

const express = require('express');
const { createOrder, getOrder, captureOrder } = require('./paypal');
const { calculateShipping, buildCallbackResponse, isZipServiceable } = require('./shipping');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Render / localtunnel bypass
app.use((req, res, next) => {
  res.setHeader('bypass-tunnel-reminder', 'true');
  next();
});

// Request logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HTML HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const PAGE = (title, body) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body   { font-family: -apple-system, Arial, sans-serif; max-width: 660px;
             margin: 60px auto; padding: 0 20px; color: #333; }
    h1     { font-size: 1.3em; margin-top: 0; }
    .card  { border: 1px solid #ddd; padding: 24px; border-radius: 10px; margin-bottom: 20px; }
    .price { font-size: 1.6em; font-weight: 700; color: #111; }
    .note  { font-size: 0.85em; color: #777; margin-top: 6px; line-height: 1.5; }
    .btn   { display: inline-block; margin-top: 20px; padding: 13px 30px;
             background: #0070ba; color: #fff; border-radius: 6px;
             text-decoration: none; font-size: 1em; font-weight: 700; }
    .btn:hover { background: #005ea6; }
    .zips  { background: #f8f8f8; border: 1px solid #eee; padding: 14px 18px;
             border-radius: 8px; font-size: 0.84em; margin-top: 18px; line-height: 2; }
    .ok    { color: #1a7340; font-weight: 600; }
    .no    { color: #c0392b; font-weight: 600; }
    .diff  { background: #fff8e1; border: 1px solid #f9a825; padding: 14px 18px;
             border-radius: 8px; font-size: 0.84em; margin-top: 16px; line-height: 1.8; }
    .success { background: #e6f9ee; border: 1px solid #27ae60; padding: 24px; border-radius: 10px; }
    .success h1 { color: #1a7340; }
    .error   { background: #fdf0ef; border: 1px solid #e74c3c; padding: 24px; border-radius: 10px; }
    .error h1 { color: #c0392b; }
    .row   { margin: 10px 0; }
    code   { background: #f0f0f0; padding: 2px 7px; border-radius: 4px; font-size: 0.9em; }
    .back  { display: inline-block; margin-top: 18px; color: #0070ba; text-decoration: none; }
    .tag   { display: inline-block; background: #eaf3fb; color: #0070ba;
             font-size: 0.75em; padding: 2px 8px; border-radius: 20px; font-weight: 600; margin-left: 6px; }
  </style>
</head>
<body>${body}</body>
</html>`;

// ─────────────────────────────────────────────────────────────────────────────
// HOME PAGE
// ─────────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(PAGE('Orders v2 Shipping Callback Demo', `
  <h1>🛒 PayPal Orders v2 — Shipping Callback Demo <span class="tag">Sandbox</span></h1>

  <div class="card">
    <h2 style="margin-top:0">Widget Pro</h2>
    <div class="price">$20.00 <span style="font-size:0.55em;color:#777">+ shipping & tax</span></div>
    <p class="note">
      When you change your address on the PayPal review page, the server checks
      whether your <strong>zip code is serviceable</strong> and responds with
      shipping options in real time using the
      <strong>Orders v2 server-side shipping callback API</strong>.
    </p>
    <a class="btn" href="/checkout">Pay with PayPal</a>

    <div class="zips">
      <strong>Test with these sandbox shipping addresses:</strong><br>
      <span class="ok">✅ Supported zips:</span>
      10001 (New York) &nbsp;·&nbsp; 90001 (Los Angeles) &nbsp;·&nbsp; 60601 (Chicago)
      &nbsp;·&nbsp; 94102 (San Francisco) &nbsp;·&nbsp; 95101 (San Jose) &nbsp;·&nbsp; 98101 (Seattle)<br>
      <span class="no">❌ Not supported:</span>
      Any other US zip &nbsp;·&nbsp; e.g. 33101 (Miami), 70112 (New Orleans), 85001 (Phoenix)<br>
      <span class="ok">✅ Supported countries:</span> US, GB, CA, AU<br>
      <span class="no">❌ Not supported:</span> All other countries
    </div>

    <div class="diff">
      <strong>🆚 vs Legacy EC Instant Update API:</strong>
      REST JSON instead of NVP key=value &nbsp;·&nbsp;
      Client ID/Secret instead of API Username/Signature &nbsp;·&nbsp;
      HTTP 422 + <code>ZIP_ERROR</code> to decline (not <code>NO_SHIPPING_OPTION_DETAILS=1</code>) &nbsp;·&nbsp;
      Venmo supported &nbsp;·&nbsp; No <code>MAXAMT</code> hack needed
    </div>
  </div>
  `));
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Create Order → redirect buyer to PayPal
// ─────────────────────────────────────────────────────────────────────────────
app.get('/checkout', async (req, res) => {
  const base = process.env.BASE_URL;
  try {
    const { orderId, approveLink } = await createOrder(
      `${base}/shipping-callback`,
      `${base}/return`,
      `${base}/cancel`
    );
    console.log(`[Checkout] Order created: ${orderId}`);
    res.redirect(approveLink);
  } catch (err) {
    console.error('[Checkout] ERROR:', err.response?.data || err.message);
    res.status(500).send(PAGE('Error', `
      <div class="error">
        <h1>⚠️ Error creating order</h1>
        <p>Could not start checkout. Check your PayPal credentials in <code>.env</code>.</p>
        <pre style="font-size:0.8em;overflow:auto">${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>
        <a class="back" href="/">← Back to shop</a>
      </div>
    `));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — Server-side Shipping Callback (PayPal → your server)
//
// PayPal sends JSON POST with:
//   id                — order ID
//   shipping_address  — { country_code, admin_area_1, postal_code, admin_area_2 }
//   shipping_option   — currently selected option (SHIPPING_OPTIONS event only)
//   purchase_units    — current order state
//
// Respond:
//   HTTP 200 + updated purchase_units with amounts + shipping_options → address OK
//   HTTP 422 + { name, details:[{issue}] }                           → not serviceable
//     issue values: ZIP_ERROR | COUNTRY_ERROR | STATE_ERROR
//     PayPal shows the matching error on the review page automatically
// ─────────────────────────────────────────────────────────────────────────────
app.post('/shipping-callback', (req, res) => {
  const body        = req.body;
  const orderId     = body.id;
  const address     = body.shipping_address || {};
  const selectedOpt = body.shipping_option;
  const referenceId = body.purchase_units?.[0]?.reference_id || 'default';

  console.log('\n🔔 Shipping Callback received');
  console.log('   Order   :', orderId);
  console.log('   Event   :', selectedOpt ? 'SHIPPING_OPTIONS' : 'SHIPPING_ADDRESS');
  console.log('   Address :', JSON.stringify(address));
  if (selectedOpt) console.log('   Option  :', JSON.stringify(selectedOpt));

  const result   = calculateShipping(address);
  const response = buildCallbackResponse(result, orderId, referenceId);

  if (result.supported) {
    console.log(`   → 200  $${result.orderTotal} total, ${result.options.length} options`);
    result.options.forEach(o =>
      console.log(`      [${o.selected ? '●' : '○'}] ${o.label}  $${o.amount}`)
    );
  } else {
    console.log(`   → 422  ${result.errorIssue} (zip=${result.zip} country=${result.country})`);
  }

  res.status(response.status).json(response.body);
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Return URL: buyer approved → verify zip → capture
// ─────────────────────────────────────────────────────────────────────────────
app.get('/return', async (req, res) => {
  const { token: orderId } = req.query;

  if (!orderId) {
    return res.status(400).send(PAGE('Error', `
      <div class="error"><h1>⚠️ Missing order ID</h1>
      <a class="back" href="/">← Back</a></div>`));
  }

  try {
    const order       = await getOrder(orderId);
    const puShipping  = order.purchase_units?.[0]?.shipping;
    const zip         = puShipping?.address?.postal_code   || '';
    const country     = puShipping?.address?.country_code  || 'US';
    const city        = puShipping?.address?.admin_area_2  || '';
    const state       = puShipping?.address?.admin_area_1  || '';
    const shippingAmt = order.purchase_units?.[0]?.amount?.breakdown?.shipping?.value || '0.00';
    const totalAmt    = order.purchase_units?.[0]?.amount?.value || '0.00';

    console.log(`\n[Return] Order: ${orderId}  zip: ${zip}  shipping: $${shippingAmt}`);

    // ── SERVER-SIDE ENFORCEMENT ───────────────────────────────────────────────
    // The 422 callback is UX only — PayPal may still let the buyer proceed.
    // This is the authoritative gate: we never capture if zip is unsupported.
    if (!isZipServiceable(zip, country)) {
      console.log(`🚫 BLOCKED: zip ${zip} not serviceable`);
      return res.status(400).send(PAGE('Delivery Not Available', `
        <div class="error">
          <h1>🚫 Delivery Not Available</h1>
          <p>
            Sorry, we are unable to deliver to
            <strong>${city}${state ? ', ' + state : ''} ${zip}, ${country}</strong>.
          </p>
          <p>Your payment has <strong>not</strong> been charged.</p>
          <p class="note">
            Please go back and select a supported delivery address.<br>
            Supported US zip codes include: 10001, 90001, 60601, 94102, 95101, 98101
          </p>
          <a class="btn" href="/">← Back to shop</a>
        </div>
      `));
    }

    // Capture payment
    const capture    = await captureOrder(orderId);
    const puCapture  = capture.purchase_units?.[0];
    const captureData = puCapture?.payments?.captures?.[0];
    const buyerEmail  = capture.payment_source?.paypal?.email_address || '';

    res.send(PAGE('Payment Successful', `
      <div class="success">
        <h1>✅ Payment Successful!</h1>
        <div class="row"><strong>Order ID:</strong> <code>${orderId}</code></div>
        <div class="row"><strong>Capture ID:</strong> <code>${captureData?.id || 'N/A'}</code></div>
        <div class="row"><strong>Status:</strong> ${captureData?.status || 'N/A'}</div>
        <div class="row"><strong>Amount charged:</strong>
          <strong>$${captureData?.amount?.value}</strong> ${captureData?.amount?.currency_code}</div>
        <div class="row"><strong>Shipping:</strong> $${shippingAmt}</div>
        <div class="row"><strong>Delivered to:</strong> ${city}${state ? ', ' + state : ''} <strong>${zip}</strong>, ${country}</div>
        ${buyerEmail ? `<div class="row"><strong>Buyer:</strong> ${buyerEmail}</div>` : ''}
      </div>
      <a class="back" href="/">← Back to shop</a>
    `));
  } catch (err) {
    console.error('[Return] ERROR:', err.response?.data || err.message);
    res.status(500).send(PAGE('Payment Failed', `
      <div class="error">
        <h1>⚠️ Payment Failed</h1>
        <pre style="font-size:0.8em;overflow:auto">${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>
        <a class="back" href="/">← Back</a>
      </div>
    `));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL
// ─────────────────────────────────────────────────────────────────────────────
app.get('/cancel', (req, res) => {
  res.send(PAGE('Cancelled', `
    <div class="card">
      <h1>❌ Payment Cancelled</h1>
      <p>You cancelled the PayPal checkout. No payment was taken.</p>
      <a class="btn" href="/">← Back to shop</a>
    </div>
  `));
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Orders v2 Shipping Callback Demo`);
  console.log(`   URL     : ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
  console.log(`   Callback: ${process.env.BASE_URL}/shipping-callback`);
  console.log(`\n   Supported zips : 10001 90001 60601 94102 95101 98101`);
  console.log(`   Unsupported    : all others → 422 ZIP_ERROR`);
  console.log(`\n   Quick test:`);
  console.log(`   curl -s -X POST http://localhost:${PORT}/shipping-callback \\`);
  console.log(`     -H 'Content-Type: application/json' \\`);
  console.log(`     -d '{"id":"T1","shipping_address":{"country_code":"US","admin_area_1":"CA","postal_code":"95101"},"purchase_units":[{"reference_id":"default"}]}' | jq\n`);
});
