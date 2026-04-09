'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SERVICEABLE PINCODES
// Replace with your real delivery coverage data
// ─────────────────────────────────────────────────────────────────────────────
const SERVICEABLE_ZIPS = new Set([
  '10001', // New York, NY
  '90001', // Los Angeles, CA
  '60601', // Chicago, IL
  '94102', // San Francisco, CA
  '95101', // San Jose, CA
  '98101', // Seattle, WA
  '77001', // Houston, TX
  '75201', // Dallas, TX
  '02101', // Boston, MA
  '30301', // Atlanta, GA
]);

const SERVICEABLE_COUNTRIES = new Set(['US', 'GB', 'CA', 'AU']);

function isZipServiceable(zip, country) {
  if (!zip) return false;
  const upperCountry = (country || 'US').toUpperCase();
  if (upperCountry !== 'US') return SERVICEABLE_COUNTRIES.has(upperCountry);
  return SERVICEABLE_ZIPS.has(zip.trim().substring(0, 5));
}

// ─────────────────────────────────────────────────────────────────────────────
// CALCULATE SHIPPING OPTIONS
// ─────────────────────────────────────────────────────────────────────────────
function calculateShipping(shippingAddress) {
  const country = (shippingAddress.country_code || 'US').toUpperCase();
  const state   = (shippingAddress.admin_area_1 || '').toUpperCase();
  const zip     = (shippingAddress.postal_code  || '').trim();

  console.log(`\n📦 Pincode check: zip=${zip} state=${state} country=${country}`);

  if (!isZipServiceable(zip, country)) {
    console.log(`❌ Not serviceable: zip=${zip} country=${country}`);
    return {
      supported:  false,
      zip,
      country,
      errorIssue: country !== 'US' ? 'COUNTRY_ERROR' : 'ZIP_ERROR',
    };
  }

  console.log(`✅ Serviceable: zip=${zip}`);

  const ITEM_TOTAL = '20.00';

  if (country !== 'US') {
    const shipping = '25.00', tax = '0.00';
    return {
      supported: true, zip, country,
      itemTotal: ITEM_TOTAL, shippingAmount: shipping, taxTotal: tax,
      orderTotal: (parseFloat(ITEM_TOTAL) + parseFloat(shipping)).toFixed(2),
      options: [
        { id: '1', label: 'International Standard (10-14 days)', amount: '25.00', selected: true,  type: 'SHIPPING' },
        { id: '2', label: 'International Express (5-7 days)',    amount: '45.00', selected: false, type: 'SHIPPING' },
      ],
    };
  }

  if (['HI', 'AK'].includes(state)) {
    const shipping = '12.00', tax = '0.00';
    return {
      supported: true, zip, country,
      itemTotal: ITEM_TOTAL, shippingAmount: shipping, taxTotal: tax,
      orderTotal: (parseFloat(ITEM_TOTAL) + parseFloat(shipping)).toFixed(2),
      options: [
        { id: '1', label: 'Standard (7-10 days)',  amount: '12.00', selected: true,  type: 'SHIPPING' },
        { id: '2', label: 'Expedited (3-5 days)',  amount: '22.00', selected: false, type: 'SHIPPING' },
      ],
    };
  }

  // Continental US
  const shipping = '5.00', tax = '1.00';
  return {
    supported: true, zip, country,
    itemTotal: ITEM_TOTAL, shippingAmount: shipping, taxTotal: tax,
    orderTotal: (parseFloat(ITEM_TOTAL) + parseFloat(shipping) + parseFloat(tax)).toFixed(2),
    options: [
      { id: '1', label: 'Standard (5-7 days)',  amount: '5.00',  selected: true,  type: 'SHIPPING' },
      { id: '2', label: 'Expedited (2-3 days)', amount: '12.00', selected: false, type: 'SHIPPING' },
      { id: '3', label: 'Overnight (next day)', amount: '25.00', selected: false, type: 'SHIPPING' },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD CALLBACK RESPONSE
//
// PayPal shows the error reason on the review page when you return 422:
//   ZIP_ERROR     → "Your order can't be shipped to this zip."
//   COUNTRY_ERROR → "Your order can't be shipped to this country."
//   STATE_ERROR   → "Your order can't be shipped to this state."
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
            currency_code: 'USD',
            value:         result.orderTotal,
            breakdown: {
              item_total: { currency_code: 'USD', value: result.itemTotal      },
              shipping:   { currency_code: 'USD', value: result.shippingAmount },
              tax_total:  { currency_code: 'USD', value: result.taxTotal       },
            },
          },
          shipping_options: result.options.map(opt => ({
            id:       opt.id,
            label:    opt.label,
            type:     opt.type,
            selected: opt.selected,
            amount:   { currency_code: 'USD', value: opt.amount },
          })),
        },
      ],
    },
  };
}

module.exports = { calculateShipping, buildCallbackResponse, isZipServiceable };
