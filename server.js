'use strict';

require('dotenv').config();

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP ENV CHECK
// ─────────────────────────────────────────────────────────────────────────────
const REQUIRED_ENV = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'BASE_URL'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('❌ Missing env vars:', missing.join(', '));
  process.exit(1);
}
console.log('✅ Env loaded — BASE_URL:', process.env.BASE_URL);

const express = require('express');
const { createOrder, getOrder, captureOrder } = require('./paypal');
const { calculateShipping, buildCallbackResponse, isZipServiceable } = require('./shipping');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => { res.setHeader('bypass-tunnel-reminder', 'true'); next(); });
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// HOME PAGE
// Uses PayPal JS SDK with onShippingAddressChange callback.
//
// WHY JS SDK instead of pure server-side redirect?
//   With the Orders v2 server-side callback flow (redirect mode), PayPal shows
//   the 422 error banner but does NOT redirect the buyer when they click
//   "Complete Purchase" on an invalid address — the button just does nothing.
//
//   The JS SDK popup flow solves this properly:
//     - onShippingAddressChange fires when buyer changes address in the popup
//     - We call our /api/shipping-options to check the postcode
//     - If unsupported → we call actions.reject() which shows a proper error
//       and DISABLES the pay button inside the popup
//     - If supported → we PATCH the order with new amounts and call actions.resolve()
// ─────────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AU Shipping Demo</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body   { font-family: -apple-system, Arial, sans-serif; max-width: 640px;
             margin: 60px auto; padding: 0 20px; color: #333; }
    h1     { font-size: 1.3em; }
    .card  { border: 1px solid #ddd; padding: 24px; border-radius: 10px; margin-bottom: 20px; }
    .price { font-size: 1.6em; font-weight: 700; }
    .note  { font-size: 0.85em; color: #777; margin-top: 6px; line-height: 1.6; }
    .info  { background: #f0f7ff; border: 1px solid #b3d4f5; padding: 14px 18px;
             border-radius: 8px; font-size: 0.84em; margin-top: 16px; line-height: 2; }
    .ok    { color: #1a7340; font-weight: 600; }
    .no    { color: #c0392b; font-weight: 600; }
    .tag   { display:inline-block; background:#eaf3fb; color:#0070ba;
             font-size:0.75em; padding:2px 8px; border-radius:20px; font-weight:600; margin-left:6px; }
    ul     { margin: 4px 0; padding-left: 20px; line-height: 2; }
    #paypal-button-container { margin-top: 24px; }
    #status { margin-top: 12px; font-size: 0.85em; color: #555; min-height: 20px; }
  </style>
</head>
<body>
  <h1>🛒 PayPal Orders v2 — Shipping Callback Demo <span class="tag">Sandbox</span></h1>

  <div class="card">
    <h2 style="margin-top:0">Widget Pro 🇦🇺</h2>
    <div class="price">AUD $20.00 <span style="font-size:0.5em;color:#777">+ shipping &amp; GST</span></div>
    <p class="note">
      We ship to <strong>Australia only</strong>. Change your shipping address
      inside the PayPal popup — invalid postcodes disable the pay button immediately.
    </p>

    <div class="info">
      <strong>Delivery coverage:</strong><br>
      <span class="ok">✅ Supported postcode:</span> <strong>3000</strong> (Melbourne CBD)<br>
      <span class="no">❌ All other AU postcodes:</span> Pay button disabled, error shown<br>
      <span class="no">❌ Other countries:</span> Pay button disabled, error shown
      <br><br>
      <strong>Shipping options for postcode 3000:</strong>
      <ul>
        <li>Australia Post Standard (3-5 days) — AUD $8.00</li>
        <li>Australia Post Express (1-2 days) — AUD $15.00</li>
      </ul>
    </div>

    <!-- PayPal JS SDK renders the button here -->
    <div id="paypal-button-container"></div>
    <div id="status"></div>
  </div>

  <!-- PayPal JS SDK — currency=AUD, components=buttons -->
  <script src="https://www.paypal.com/sdk/js?client-id=${clientId}&currency=AUD&components=buttons"></script>
  <script>
    const BASE_URL = '${process.env.BASE_URL}';

    function setStatus(msg, isError) {
      const el = document.getElementById('status');
      el.textContent = msg;
      el.style.color = isError ? '#c0392b' : '#555';
    }

    paypal.Buttons({
      // ── Step 1: Create order on your server ──────────────────────────────
      createOrder: async () => {
        setStatus('Creating order...');
        const res  = await fetch('/api/create-order', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to create order');
        setStatus('Order created — opening PayPal...');
        return data.orderId;
      },

      // ── Step 2: Buyer changes shipping address in PayPal popup ────────────
      // This fires on initial load AND every time address changes.
      // actions.reject() → disables pay button + shows error in popup
      // actions.resolve() → enables pay button
      onShippingAddressChange: async (data, actions) => {
        const zip     = data.shippingAddress?.postalCode   || '';
        const country = data.shippingAddress?.countryCode  || '';
        const state   = data.shippingAddress?.state        || '';

        console.log('onShippingAddressChange:', { zip, country, state });
        setStatus('Checking delivery for postcode ' + zip + '...');

        try {
          const res = await fetch('/api/shipping-options', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              orderId: data.orderID,
              zip, country, state,
            }),
          });

          const result = await res.json();

          if (!res.ok || !result.supported) {
            // Postcode not supported — reject disables the pay button
            setStatus('❌ ' + (result.message || 'Delivery not available for this postcode'), true);
            return actions.reject();
          }

          setStatus('✅ Delivery available — shipping options updated');
          return actions.resolve();
        } catch (err) {
          console.error('Shipping check error:', err);
          setStatus('Error checking delivery. Please try again.', true);
          return actions.reject();
        }
      },

      // ── Step 3: Buyer approves — capture on your server ──────────────────
      onApprove: async (data) => {
        setStatus('Processing payment...');
        const res    = await fetch('/api/capture-order', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ orderId: data.orderID }),
        });
        const result = await res.json();
        if (!res.ok) {
          setStatus('❌ Payment failed: ' + (result.error || 'Unknown error'), true);
          return;
        }
        // Redirect to success page
        window.location.href = '/success?orderId=' + data.orderID
          + '&captureId=' + result.captureId
          + '&amount=' + result.amount
          + '&zip=' + result.zip;
      },

      onError: (err) => {
        console.error('PayPal error:', err);
        setStatus('❌ PayPal error: ' + err, true);
      },

      onCancel: () => {
        setStatus('Payment cancelled.');
      },

    }).render('#paypal-button-container');
  </script>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
// API: Create Order
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/create-order', async (req, res) => {
  try {
    const { orderId } = await createOrder();
    console.log('[API] Order created:', orderId);
    res.json({ orderId });
  } catch (err) {
    console.error('[API] Create order error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: Check shipping options for a postcode + PATCH order with new amounts
//
// Called by onShippingAddressChange in the JS SDK.
// Returns { supported: true/false, message, ... }
// If supported, also PATCHes the order with the correct shipping amount.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/shipping-options', async (req, res) => {
  const { orderId, zip, country, state } = req.body;

  console.log('\n📦 Shipping check:', { orderId, zip, country, state });

  const result = calculateShipping({
    country_code: country,
    admin_area_1: state,
    postal_code:  zip,
  });

  if (!result.supported) {
    const msg = country.toUpperCase() !== 'AU'
      ? 'We only ship to Australia.'
      : `We don't deliver to postcode ${zip}. Only postcode 3000 (Melbourne CBD) is supported.`;

    console.log('❌ Not supported:', msg);
    return res.status(422).json({ supported: false, message: msg });
  }

  // Supported — PATCH the order with correct amounts
  try {
    await patchOrder(orderId, result);
    console.log('✅ Order patched with shipping AUD $' + result.shippingAmount);
    res.json({
      supported: true,
      options:   result.options,
      total:     result.orderTotal,
    });
  } catch (err) {
    console.error('[API] PATCH error:', err.response?.data || err.message);
    res.status(500).json({ supported: false, message: 'Error updating order' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: Capture Order
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/capture-order', async (req, res) => {
  const { orderId } = req.body;

  try {
    // Final postcode check before capture
    const order   = await getOrder(orderId);
    const address = order.purchase_units?.[0]?.shipping?.address || {};
    const zip     = address.postal_code  || '';
    const country = address.country_code || '';

    if (!isZipServiceable(zip, country)) {
      console.log('🚫 Capture blocked — zip:', zip);
      return res.status(422).json({
        error: `Delivery not available for postcode ${zip}`,
      });
    }

    const capture     = await captureOrder(orderId);
    const captureData = capture.purchase_units?.[0]?.payments?.captures?.[0];
    const shippingAmt = order.purchase_units?.[0]?.amount?.breakdown?.shipping?.value || '0.00';

    res.json({
      captureId: captureData?.id,
      amount:    captureData?.amount?.value,
      currency:  captureData?.amount?.currency_code,
      zip,
      shipping:  shippingAmt,
    });
  } catch (err) {
    console.error('[API] Capture error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH ORDER — update amounts when shipping address changes
// ─────────────────────────────────────────────────────────────────────────────
async function patchOrder(orderId, shippingResult) {
  const axios = require('axios');
  const token = await require('./paypal').getAccessToken();

  const patches = [
    {
      op:    'replace',
      path:  '/purchase_units/@reference_id==\'default\'/amount',
      value: {
        currency_code: 'AUD',
        value:         shippingResult.orderTotal,
        breakdown: {
          item_total: { currency_code: 'AUD', value: shippingResult.itemTotal      },
          shipping:   { currency_code: 'AUD', value: shippingResult.shippingAmount },
          tax_total:  { currency_code: 'AUD', value: shippingResult.taxTotal       },
        },
      },
    },
  ];

  await axios.patch(
    `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}`,
    patches,
    {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUCCESS PAGE
// ─────────────────────────────────────────────────────────────────────────────
app.get('/success', (req, res) => {
  const { orderId, captureId, amount, zip } = req.query;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Payment Successful</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; }
    .success { background: #e6f9ee; border: 1px solid #27ae60; padding: 24px; border-radius: 10px; }
    .success h1 { color: #1a7340; margin-top: 0; }
    .row { margin: 10px 0; }
    code { background: #f0f0f0; padding: 2px 7px; border-radius: 4px; }
    a { color: #0070ba; }
  </style>
</head>
<body>
  <div class="success">
    <h1>✅ Payment Successful!</h1>
    <div class="row"><strong>Order ID:</strong> <code>${orderId}</code></div>
    <div class="row"><strong>Capture ID:</strong> <code>${captureId}</code></div>
    <div class="row"><strong>Amount:</strong> AUD $${amount}</div>
    <div class="row"><strong>Delivered to postcode:</strong> ${zip}</div>
  </div>
  <p><a href="/">← Back to shop</a></p>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 AU Shipping Demo (JS SDK mode)`);
  console.log(`   URL     : ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
  console.log(`   Coverage: AU postcode 3000 only`);
  console.log(`\n   Note: Using JS SDK onShippingAddressChange instead of`);
  console.log(`   server-side redirect callback — this properly disables`);
  console.log(`   the pay button for unsupported postcodes.\n`);
});
