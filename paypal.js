'use strict';

const axios = require('axios');

const BASE_URL = 'https://api-m.sandbox.paypal.com';

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
// CREATE ORDER
// Currency: AUD — Australia only
// Shipping starts at 0 — callback populates real amount once address is known
// ─────────────────────────────────────────────────────────────────────────────
async function createOrder(callbackUrl, returnUrl, cancelUrl) {
  const token = await getAccessToken();

  const body = {
    intent: 'CAPTURE',
    payment_source: {
      paypal: {
        experience_context: {
          user_action:         'PAY_NOW',
          shipping_preference: 'GET_FROM_FILE',
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
            unit_amount: { currency_code: 'AUD', value: '20.00' },
            quantity:    '1',
            category:    'PHYSICAL_GOODS',
          },
        ],
        amount: {
          currency_code: 'AUD',
          value:         '20.00',
          breakdown: {
            item_total: { currency_code: 'AUD', value: '20.00' },
            shipping:   { currency_code: 'AUD', value: '0.00'  },
            tax_total:  { currency_code: 'AUD', value: '0.00'  },
          },
        },
      },
    ],
  };

  console.log('\n─── Create Order ───');
  console.log(JSON.stringify(body, null, 2));

  const res = await axios.post(`${BASE_URL}/v2/checkout/orders`, body, {
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
  });

  console.log('\n─── Create Order Response ───');
  console.log(JSON.stringify(res.data, null, 2));

  const approveLink = res.data.links.find(l => l.rel === 'payer-action')?.href
                   || res.data.links.find(l => l.rel === 'approve')?.href;

  return { orderId: res.data.id, approveLink };
}

async function getOrder(orderId) {
  const token = await getAccessToken();
  const res   = await axios.get(`${BASE_URL}/v2/checkout/orders/${orderId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return res.data;
}

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
  console.log('\n─── Capture Response ───');
  console.log(JSON.stringify(res.data, null, 2));
  return res.data;
}

module.exports = { createOrder, getOrder, captureOrder };
