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
// SHARED HTML WRAPPER
// ─────────────────────────────────────────────────────────────────────────────
const PAGE = (title, body) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body   { font-family: -apple-system, Arial, sans-serif; max-width: 640px;
             margin: 60px auto; padding: 0 20px; color: #333; }
    h1     { font-size: 1.3em; margin-top: 0; }
    .card  { border: 1px solid #ddd; padding: 24px; border-radius: 10px; margin-bottom: 20px; }
    .price { font-size: 1.6em; font-weight: 700; color: #111; }
    .note  { font-size: 0.85em; color: #777; margin-top: 6px; line-height: 1.6; }
    .btn   { display: inline-block; margin-top: 20px; padding: 13px 30px;
             background: #0070ba; color: #fff; border-radius: 6px;
             text-decoration: none; font-size: 1em; font-weight: 700; }
    .btn:hover { background: #005ea6; }
    .info  { background: #f0f7ff; border: 1px solid #b3d4f5; padding: 16px 18px;
             border-radius: 8px; font-size: 0.85em; margin-top: 18px; line-height: 2; }
    .ok    { color: #1a7340; font-weight: 600; }
    .no    { color: #c0392b; font-weight: 600; }
    .success { background: #e6f9ee; border: 1px solid #27ae60; padding: 24px; border-radius: 10px; }
    .success h1 { color: #1a7340; }
    .error   { background: #fdf0ef; border: 1px solid #e74c3c; padding: 24px; border-radius: 10px; }
    .error h1 { color: #c0392b; }
    .row   { margin: 10px 0; }
    code   { background: #f0f0f0; padding: 2px 7px; border-radius: 4px; font-size: 0.9em; }
    .back  { display: inline-block; margin-top: 18px; color: #0070ba; text-decoration: none; }
    .tag   { display:inline-block; background:#eaf3fb; color:#0070ba;
             font-size:0.75em; padding:2px 8px; border-radius:20px; font-weight:600; margin-left:6px; }
    ul { margin: 6px 0; padding-left: 20px; line-height: 2; }
  </style>
</head>
<body>${body}</body>
</html>`;

// ─────────────────────────────────────────────────────────────────────────────
// HOME PAGE
// ─────────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(PAGE('AU Shipping Demo', `
  <h1>🛒 PayPal Orders v2 — Shipping Callback Demo <span class="tag">Sandbox</span></h1>

  <div class="card">
    <h2 style="margin-top:0">Widget Pro 🇦🇺</h2>
    <div class="price">AUD $20.00 <span style="font-size:0.5em;color:#777">+ shipping &amp; GST</span></div>
    <p class="note">
      We ship <strong>to Australia only</strong>. When you change your shipping address
      on the PayPal review page, the server checks your postcode in real time and shows
      available delivery options — or an error if your postcode is not supported.
    </p>
    <a class="btn" href="/checkout">Pay with PayPal</a>

    <div class="info">
      <strong>Delivery coverage:</strong><br>
      <span class="ok">✅ Supported country:</span> Australia (AU) only<br>
      <span class="ok">✅ Supported postcode:</span> <strong>3000</strong> (Melbourne CBD)<br>
      <span class="no">❌ All other postcodes:</span>
        PayPal shows <em>"Your order can't be shipped to this zip"</em><br>
      <span class="no">❌ All other countries:</span>
        PayPal shows <em>"Your order can't be shipped to this country"</em>

      <br><br>
      <strong>Shipping options for postcode 3000:</strong>
      <ul>
        <li>Australia Post Standard (3-5 business days) — AUD $8.00</li>
        <li>Australia Post Express (1-2 business days) — AUD $15.00</li>
      </ul>
    </div>
  </div>
  `));
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Create Order → redirect to PayPal
// ─────────────────────────────────────────────────────────────────────────────
app.get('/checkout', async (req, res) => {
  const base = process.env.BASE_URL;
  try {
    const { orderId, approveLink } = await createOrder(
      `${base}/shipping-callback`,
      `${base}/return`,
      `${base}/cancel`
    );
    console.log(`[Checkout] Order: ${orderId}`);
    res.redirect(approveLink);
  } catch (err) {
    console.error('[Checkout] ERROR:', err.response?.data || err.message);
    res.status(500).send(PAGE('Error', `
      <div class="error">
        <h1>⚠️ Error creating order</h1>
        <p>Could not start checkout. Check your PayPal credentials in <code>.env</code>.</p>
        <pre style="font-size:0.8em;overflow:auto">${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>
        <a class="back" href="/">← Back</a>
      </div>
    `));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — Shipping Callback (PayPal → your server)
//
// PayPal POSTs JSON when buyer loads or changes their shipping address.
//
// We check:
//   1. country_code must be AU
//   2. postal_code must be 3000
//
// HTTP 200 + shipping options → address supported
// HTTP 422 + COUNTRY_ERROR   → wrong country (PayPal shows country error)
// HTTP 422 + ZIP_ERROR       → wrong postcode (PayPal shows zip error)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/shipping-callback', (req, res) => {
  const body        = req.body;
  const orderId     = body.id;
  const address     = body.shipping_address || {};
  const selectedOpt = body.shipping_option;
  const referenceId = body.purchase_units?.[0]?.reference_id || 'default';

  console.log('\n🔔 Shipping Callback');
  console.log('   Order   :', orderId);
  console.log('   Event   :', selectedOpt ? 'SHIPPING_OPTIONS' : 'SHIPPING_ADDRESS');
  console.log('   Address :', JSON.stringify(address));

  const result   = calculateShipping(address);
  const response = buildCallbackResponse(result, orderId, referenceId);

  if (result.supported) {
    console.log(`   → 200  AUD $${result.orderTotal} (shipping $${result.shippingAmount} + tax $${result.taxTotal})`);
    result.options.forEach(o =>
      console.log(`      [${o.selected ? '●' : '○'}] ${o.label}  AUD $${o.amount}`)
    );
  } else {
    console.log(`   → 422  ${result.errorIssue}  zip=${result.zip} country=${result.country}`);
  }

  res.status(response.status).json(response.body);
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Return URL: buyer approved → enforce postcode → capture
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
    const address     = puShipping?.address || {};
    const zip         = address.postal_code  || '';
    const country     = address.country_code || '';
    const city        = address.admin_area_2 || '';
    const state       = address.admin_area_1 || '';
    const shippingAmt = order.purchase_units?.[0]?.amount?.breakdown?.shipping?.value || '0.00';

    console.log(`\n[Return] Order: ${orderId}  zip: ${zip}  country: ${country}`);

    // ── SERVER-SIDE ENFORCEMENT ───────────────────────────────────────────────
    // Always re-check postcode here — buyer may have bypassed the PayPal warning.
    // Never capture payment for an unsupported address.
    if (!isZipServiceable(zip, country)) {
      console.log(`🚫 BLOCKED: ${country} postcode ${zip} — payment NOT captured`);

      const isWrongCountry = country.toUpperCase() !== 'AU';
      const reason = isWrongCountry
        ? `We only ship to Australia. Your address is in <strong>${country}</strong>.`
        : `We only deliver to postcode <strong>3000</strong> (Melbourne CBD). Your postcode is <strong>${zip}</strong>.`;

      return res.status(400).send(PAGE('Delivery Not Available', `
        <div class="error">
          <h1>🚫 Delivery Not Available</h1>
          <p>${reason}</p>
          <p>Your payment has <strong>not</strong> been charged.</p>
          <p class="note">
            Please go back and use a supported delivery address.<br>
            We currently deliver to: <strong>Australia, postcode 3000 only</strong>.
          </p>
          <a class="btn" href="/">← Back to shop</a>
        </div>
      `));
    }

    // Capture
    const capture     = await captureOrder(orderId);
    const captureData = capture.purchase_units?.[0]?.payments?.captures?.[0];
    const buyerEmail  = capture.payment_source?.paypal?.email_address || '';

    res.send(PAGE('Payment Successful', `
      <div class="success">
        <h1>✅ Payment Successful!</h1>
        <div class="row"><strong>Order ID:</strong> <code>${orderId}</code></div>
        <div class="row"><strong>Capture ID:</strong> <code>${captureData?.id || 'N/A'}</code></div>
        <div class="row"><strong>Status:</strong> ${captureData?.status || 'N/A'}</div>
        <div class="row"><strong>Amount charged:</strong>
          <strong>AUD $${captureData?.amount?.value}</strong></div>
        <div class="row"><strong>Shipping:</strong> AUD $${shippingAmt}</div>
        <div class="row"><strong>Delivered to:</strong>
          ${city}${state ? ', ' + state : ''} <strong>${zip}</strong>, ${country}</div>
        ${buyerEmail ? `<div class="row"><strong>Buyer:</strong> ${buyerEmail}</div>` : ''}
      </div>
      <a class="back" href="/">← Back to shop</a>
    `));
  } catch (err) {
    console.error('[Return] ERROR:', err.response?.data || err.message);
    res.status(500).send(PAGE('Error', `
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
      <p>No payment was taken.</p>
      <a class="btn" href="/">← Back to shop</a>
    </div>
  `));
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 AU Shipping Callback Demo`);
  console.log(`   URL      : ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
  console.log(`   Callback : ${process.env.BASE_URL}/shipping-callback`);
  console.log(`   Coverage : Australia (AU) only — postcode 3000 only`);
  console.log(`\n   Test supported postcode:`);
  console.log(`   curl -s -X POST http://localhost:${PORT}/shipping-callback \\`);
  console.log(`     -H 'Content-Type: application/json' \\`);
  console.log(`     -d '{"id":"T1","shipping_address":{"country_code":"AU","admin_area_1":"VIC","postal_code":"3000"},"purchase_units":[{"reference_id":"default"}]}' | jq`);
  console.log(`\n   Test unsupported postcode:`);
  console.log(`   curl -s -X POST http://localhost:${PORT}/shipping-callback \\`);
  console.log(`     -H 'Content-Type: application/json' \\`);
  console.log(`     -d '{"id":"T2","shipping_address":{"country_code":"AU","admin_area_1":"NSW","postal_code":"2000"},"purchase_units":[{"reference_id":"default"}]}' | jq\n`);
});
