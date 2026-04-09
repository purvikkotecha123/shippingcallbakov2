'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// DELIVERY CONFIGURATION
// Only Australia (AU) is supported.
// Only postcode 3000 (Melbourne CBD) is valid.
// ─────────────────────────────────────────────────────────────────────────────
const SUPPORTED_COUNTRY  = 'AU';
const SERVICEABLE_ZIPS   = new Set(['3000']);

function isZipServiceable(zip, country) {
  if (!country || country.toUpperCase() !== SUPPORTED_COUNTRY) return false;
  if (!zip) return false;
  return SERVICEABLE_ZIPS.has(zip.trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// CALCULATE SHIPPING
//
// Orders v2 callback sends:
//   shipping_address.country_code  e.g. "AU"
//   shipping_address.postal_code   e.g. "3000"
//   shipping_address.admin_area_1  state e.g. "VIC"
//
// Returns:
//   { supported: false, errorIssue, zip, country }
//   { supported: true,  options, itemTotal, shippingAmount, taxTotal, orderTotal, zip, country }
// ─────────────────────────────────────────────────────────────────────────────
function calculateShipping(shippingAddress) {
  const country = (shippingAddress.country_code || '').toUpperCase();
  const zip     = (shippingAddress.postal_code  || '').trim();
  const state   = (shippingAddress.admin_area_1 || '').toUpperCase();

  console.log(`\n📦 Delivery check: zip=${zip} state=${state} country=${country}`);

  // Step 1 — country check
  if (country !== SUPPORTED_COUNTRY) {
    console.log(`❌ Country not supported: ${country}`);
    return { supported: false, errorIssue: 'COUNTRY_ERROR', zip, country };
  }

  // Step 2 — postcode check
  if (!SERVICEABLE_ZIPS.has(zip)) {
    console.log(`❌ Postcode not supported: ${zip}`);
    return { supported: false, errorIssue: 'ZIP_ERROR', zip, country };
  }

  console.log(`✅ Supported: AU postcode ${zip}`);

  const ITEM_TOTAL = '20.00';
  const shipping   = '8.00';   // flat rate AU delivery
  const tax        = '2.00';   // GST
  const total      = (
    parseFloat(ITEM_TOTAL) + parseFloat(shipping) + parseFloat(tax)
  ).toFixed(2);

  return {
    supported:      true,
    zip,
    country,
    itemTotal:      ITEM_TOTAL,
    shippingAmount: shipping,
    taxTotal:       tax,
    orderTotal:     total,
    options: [
      {
        id:       '1',
        label:    'Australia Post Standard (3-5 business days)',
        amount:   '8.00',
        selected: true,
        type:     'SHIPPING',
      },
      {
        id:       '2',
        label:    'Australia Post Express (1-2 business days)',
        amount:   '15.00',
        selected: false,
        type:     'SHIPPING',
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD CALLBACK RESPONSE
//
// HTTP 200 → address OK, return updated amounts + shipping options
// HTTP 422 → not supported, PayPal shows error on review page:
//   COUNTRY_ERROR → "Your order can't be shipped to this country."
//   ZIP_ERROR     → "Your order can't be shipped to this zip."
// ─────────────────────────────────────────────────────────────────────────────
function buildCallbackResponse(result, orderId, referenceId) {
  if (!result.supported) {
    return {
      status: 422,
      body: {
        name:    'UNPROCESSABLE_ENTITY',
        details: [{ issue: result.errorIssue }],
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
