'use strict';

const axios = require('axios');

const BASE_URL = 'https://api-m.sandbox.paypal.com';

// ─────────────────────────────────────────────────────────────────────────────
// AUTH — get OAuth2 access token using Client ID + Secret
// ─────────────────────────────────────────────────────────────────────────────
async function getAccessToken() {
  const res = await axios.post(
    `${BASE_URL}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      auth: {
        username: process.env.PAYPAL_CLIENT_ID,
        password: process.env.PAYPAL_CLIENT_SECRET,
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );
  return res.data.access_token;
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE ORDER (Orders v2)
//
// Key fields for server-side shipping callbacks:
//   payment_source.paypal.experience_context.order_update_callback_config
//     callback_url    — PayPal POSTs shipping events here (must be public HTTPS)
//     callback_events — ["SHIPPING_ADDRESS"] and/or ["SHIPPING_OPTIONS"]
//   payment_source.paypal.experience_context.shipping_preference
//     GET_FROM_FILE   — use address from buyer's PayPal wallet (enables callbacks)
//
// Amount rule: amount.value = item_total + shipping + tax
//   On create we pass no shipping (shipping: 0.00) because the callback
//   will return the real shipping options once we know the buyer's address.
// ─────────────────────────────────────────────────────────────────────────────
async function createOrder(callbackUrl, returnUrl, cancelUrl) {
  const token = await getAccessToken();

  const body = {
    intent: 'CAPTURE',
    payment_source: {
      paypal: {
        experience_context: {
          user_action:         'PAY_NOW',
          shipping_preference: 'GET_FROM_FILE', // use address from buyer's wallet
          return_url:          returnUrl,
          cancel_url:          cancelUrl,
          order_update_callback_config: {
            callback_url:    callbackUrl,
            callback_events: ['SHIPPING_ADDRESS', 'SHIPPING_OPTIONS'],
          },
        },
      },
    },
    purchase_units: [
      {
        reference_id: 'default',
        description:  'Widget Pro order',
        items: [
          {
            name:        'Widget Pro',
            description: 'Premium widget',
            sku:         'SKU-001',
            unit_amount: { currency_code: 'USD', value: '20.00' },
            quantity:    '1',
            category:    'PHYSICAL_GOODS',
          },
        ],
        amount: {
          currency_code: 'USD',
          value:         '20.00', // item_total only — shipping added by callback
          breakdown: {
            item_total: { currency_code: 'USD', value: '20.00' },
            shipping:   { currency_code: 'USD', value: '0.00' },
            tax_total:  { currency_code: 'USD', value: '0.00' },
          },
        },
      },
    ],
  };

  console.log('\n─── Create Order REQUEST ───');
  console.log(JSON.stringify(body, null, 2));

  const res = await axios.post(`${BASE_URL}/v2/checkout/orders`, body, {
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
  });

  console.log('\n─── Create Order RESPONSE ───');
  console.log(JSON.stringify(res.data, null, 2));

  // Find the approve link to redirect the buyer
  const approveLink = res.data.links.find(l => l.rel === 'payer-action')?.href
                   || res.data.links.find(l => l.rel === 'approve')?.href;

  return { orderId: res.data.id, approveLink };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ORDER — fetch order details after buyer returns
// ─────────────────────────────────────────────────────────────────────────────
async function getOrder(orderId) {
  const token = await getAccessToken();
  const res   = await axios.get(`${BASE_URL}/v2/checkout/orders/${orderId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return res.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE ORDER — charge the buyer
// ─────────────────────────────────────────────────────────────────────────────
async function captureOrder(orderId) {
  const token = await getAccessToken();

  console.log(`\n─── Capture Order: ${orderId} ───`);

  const res = await axios.post(
    `${BASE_URL}/v2/checkout/orders/${orderId}/capture`,
    {},
    {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
    }
  );

  console.log('\n─── Capture RESPONSE ───');
  console.log(JSON.stringify(res.data, null, 2));

  return res.data;
}

module.exports = { createOrder, getOrder, captureOrder };
