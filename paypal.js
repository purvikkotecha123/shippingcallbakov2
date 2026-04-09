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
// No server-side callback config needed — JS SDK handles address changes
// via onShippingAddressChange which calls /api/shipping-options
// ─────────────────────────────────────────────────────────────────────────────
async function createOrder() {
  const token = await getAccessToken();

  const body = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: 'default',
        description:  'Widget Pro',
        items: [
          {
            name:        'Widget Pro',
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

  const res = await axios.post(`${BASE_URL}/v2/checkout/orders`, body, {
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
  });

  console.log('[PayPal] Order created:', res.data.id);
  return { orderId: res.data.id };
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
  const res   = await axios.post(
    `${BASE_URL}/v2/checkout/orders/${orderId}/capture`,
    {},
    {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
    }
  );
  console.log('[PayPal] Capture:', res.data.id, res.data.status);
  return res.data;
}

// exported so patchOrder in server.js can reuse it
module.exports = { createOrder, getOrder, captureOrder, getAccessToken };
