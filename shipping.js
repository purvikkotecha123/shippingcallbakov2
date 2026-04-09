'use strict';

const SUPPORTED_COUNTRY = 'AU';
const SERVICEABLE_ZIPS  = new Set(['3000']);

function isZipServiceable(zip, country) {
  if (!country || country.toUpperCase() !== SUPPORTED_COUNTRY) return false;
  if (!zip) return false;
  return SERVICEABLE_ZIPS.has(zip.trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// CALCULATE SHIPPING
// ─────────────────────────────────────────────────────────────────────────────
function calculateShipping(shippingAddress) {
  const country = (shippingAddress.country_code || '').toUpperCase();
  const state   = (shippingAddress.admin_area_1 || '').toUpperCase();
  const zip     = (shippingAddress.postal_code  || '').trim();

  console.log(`\n📦 Delivery check: zip=${zip} state=${state} country=${country}`);

  if (country !== SUPPORTED_COUNTRY) {
    console.log(`❌ Country not supported: ${country}`);
    return { supported: false, errorIssue: 'COUNTRY_ERROR', zip, country };
  }

  if (!SERVICEABLE_ZIPS.has(zip)) {
    console.log(`❌ Postcode not supported: ${zip}`);
    return { supported: false, errorIssue: 'ZIP_ERROR', zip, country };
  }

  console.log(`✅ Supported: AU postcode ${zip}`);

  const ITEM_TOTAL = '20.00';
  const shipping   = '8.00';
  const tax        = '2.00';
  const total      = (parseFloat(ITEM_TOTAL) + parseFloat(shipping) + parseFloat(tax)).toFixed(2);

  return {
    supported:      true,
    zip,
    country,
    itemTotal:      ITEM_TOTAL,
    shippingAmount: shipping,
    taxTotal:       tax,
    orderTotal:     total,
    options: [
      { id: '1', label: 'Australia Post Standard (3-5 business days)', amount: '8.00',  selected: true,  type: 'SHIPPING' },
      { id: '2', label: 'Australia Post Express (1-2 business days)',  amount: '15.00', selected: false, type: 'SHIPPING' },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD CALLBACK RESPONSE
//
// KEY FINDING from live testing:
//   HTTP 422 → PayPal shows error banner BUT locks the page entirely.
//              "Complete Purchase" does nothing — return_url is never called.
//
//   HTTP 200 with empty shipping_options array → PayPal shows
//              "No shipping options available" and KEEPS the button active,
//              so the buyer IS redirected to return_url where we block capture.
//
// This means we must ALWAYS return 200, and enforce the real block at /return.
// ─────────────────────────────────────────────────────────────────────────────
function buildCallbackResponse(result, orderId, referenceId) {
  if (!result.supported) {
    // Return 200 with empty shipping options instead of 422
    // This keeps the redirect working so /return can show a proper error page
    return {
      status: 200,
      body: {
        id: orderId,
        purchase_units: [
          {
            reference_id: referenceId || 'default',
            amount: {
              currency_code: 'AUD',
              value:         '20.00',
              breakdown: {
                item_total: { currency_code: 'AUD', value: '20.00' },
                shipping:   { currency_code: 'AUD', value: '0.00'  },
                tax_total:  { currency_code: 'AUD', value: '0.00'  },
              },
            },
            // Empty array → PayPal shows "No shipping options available"
            // but keeps "Complete Purchase" active so return_url is reached
            shipping_options: [],
          },
        ],
      },
    };
  }

  return {
    status: 200,
    body: {
      id: orderId,
      purchase_units: [
        {
          reference_id: referenceId || 'default',
          amount: {
            currency_code: 'AUD',
            value:         result.orderTotal,
            breakdown: {
              item_total: { currency_code: 'AUD', value: result.itemTotal      },
              shipping:   { currency_code: 'AUD', value: result.shippingAmount },
              tax_total:  { currency_code: 'AUD', value: result.taxTotal       },
            },
          },
          shipping_options: result.options.map(opt => ({
            id:       opt.id,
            label:    opt.label,
            type:     opt.type,
            selected: opt.selected,
            amount:   { currency_code: 'AUD', value: opt.amount },
          })),
        },
      ],
    },
  };
}

module.exports = { calculateShipping, buildCallbackResponse, isZipServiceable };
