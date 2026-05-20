// ============================================================
// NYUMBALINK BACKEND SERVER
// File: server.js
// Handles: M-Pesa Daraja webhooks + Africa's Talking SMS automation
//
// SETUP:
//   npm init -y
//   npm install express axios node-cron dotenv @supabase/supabase-js africastalking
//
// CREATE .env FILE with your real keys (see bottom of this file)
// RUN: node server.js
// DEPLOY FREE: railway.app or render.com
// ============================================================

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const AfricasTalking = require('africastalking');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CORS (allow your website to call this backend) ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// ── SUPABASE ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // Use SERVICE key on server (not anon key)
);

// ── AFRICA'S TALKING ──
const AT = AfricasTalking({
  apiKey: process.env.AT_API_KEY,
  username: process.env.AT_USERNAME    // 'sandbox' for testing, your username for live
});
const sms = AT.SMS;

// ── M-PESA CREDENTIALS ──
const MPESA = {
  consumerKey: process.env.MPESA_CONSUMER_KEY,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET,
  shortcode: process.env.MPESA_SHORTCODE,   // Your Paybill number e.g. 522522
  passkey: process.env.MPESA_PASSKEY,
  callbackUrl: process.env.MPESA_CALLBACK_URL,  // Your public server URL + /mpesa/callback
  baseUrl: process.env.NODE_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke'
};


// ============================================================
// ════ M-PESA DARAJA API ════
// ============================================================

// ── Get M-Pesa access token ──
async function getMpesaToken() {
  const credentials = Buffer.from(`${MPESA.consumerKey}:${MPESA.consumerSecret}`).toString('base64');
  const { data } = await axios.get(`${MPESA.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` }
  });
  return data.access_token;
}

// ── STK Push (prompt tenant's phone to pay) ──
app.post('/api/mpesa/stk-push', async (req, res) => {
  try {
    const { phone, amount, accountRef, description } = req.body;
    // accountRef = tenant's unit number e.g. "A3"

    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${MPESA.shortcode}${MPESA.passkey}${timestamp}`).toString('base64');

    const formattedPhone = phone.replace(/^0/, '254').replace(/\+/, '');

    const { data } = await axios.post(`${MPESA.baseUrl}/mpesa/stkpush/v1/processrequest`, {
      BusinessShortCode: MPESA.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.ceil(amount),
      PartyA: formattedPhone,
      PartyB: MPESA.shortcode,
      PhoneNumber: formattedPhone,
      CallBackURL: MPESA.callbackUrl,
      AccountReference: accountRef,
      TransactionDesc: description || 'NyumbaLink Payment'
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log(`📱 STK Push sent to ${phone} for KES ${amount}`);
    res.json({ success: true, checkoutRequestId: data.CheckoutRequestID });

  } catch (error) {
    console.error('STK Push error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── M-PESA CALLBACK WEBHOOK ──
// Safaricom calls this URL automatically when payment completes
app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const callback = req.body.Body?.stkCallback;
    if (!callback) return res.json({ ResultCode: 0, ResultDesc: 'OK' });

    const resultCode = callback.ResultCode;

    // Log raw callback to database
    await supabase.from('mpesa_callbacks').insert({
      merchant_request_id: callback.MerchantRequestID,
      checkout_request_id: callback.CheckoutRequestID,
      result_code: resultCode,
      result_desc: callback.ResultDesc,
      raw_payload: req.body
    });

    if (resultCode !== 0) {
      console.log(`❌ Payment failed: ${callback.ResultDesc}`);
      return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    // Extract payment details from callback
    const items = callback.CallbackMetadata?.Item || [];
    const getValue = (name) => items.find(i => i.Name === name)?.Value;

    const amount = getValue('Amount');
    const mpesaRef = getValue('MpesaReceiptNumber');
    const phone = String(getValue('PhoneNumber'));
    const transDate = getValue('TransactionDate');
    const accountRef = getValue('AccountReference')?.toString().trim().toUpperCase(); // Unit number e.g. "A3"

    console.log(`✅ Payment received: KES ${amount} from ${phone} · Ref: ${mpesaRef} · Unit: ${accountRef}`);

    // Update callback record with details
    await supabase.from('mpesa_callbacks').update({
      amount,
      mpesa_receipt_number: mpesaRef,
      phone_number: phone,
      account_reference: accountRef,
      transaction_date: new Date().toISOString()
    }).eq('checkout_request_id', callback.CheckoutRequestID);

    // ── MATCH PAYMENT TO TENANT ──
    // Find tenant by unit number (account reference)
    const { data: unit } = await supabase
      .from('units')
      .select('id, property_id, current_tenant_id, monthly_rent, properties(landlord_id, name, late_penalty_per_day)')
      .eq('unit_number', accountRef)
      .eq('status', 'occupied')
      .single();

    if (!unit || !unit.current_tenant_id) {
      console.log(`⚠️ Could not match unit: ${accountRef}`);
      return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    // Determine payment type and period
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const dayOfMonth = now.getDate();

    // Determine if late
    const rentDueDay = 10;
    const daysLate = Math.max(0, dayOfMonth - rentDueDay);
    const penalty = daysLate * (unit.properties?.late_penalty_per_day || 20);

    // Classify payment
    let paymentType = 'rent';
    if (amount < 1000) paymentType = 'garbage';
    else if (amount < 3000) paymentType = 'water';

    // Record payment in database
    const { data: payment } = await supabase.from('payments').insert({
      tenant_id: unit.current_tenant_id,
      unit_id: unit.id,
      property_id: unit.property_id,
      landlord_id: unit.properties?.landlord_id,
      amount,
      payment_type: paymentType,
      payment_method: 'mpesa',
      mpesa_reference: mpesaRef,
      period_month: month,
      period_year: year,
      status: 'confirmed'
    }).select().single();

    // Handle penalty if rent is late
    if (paymentType === 'rent' && daysLate > 0) {
      await supabase.from('penalties').upsert({
        tenant_id: unit.current_tenant_id,
        unit_id: unit.id,
        property_id: unit.property_id,
        days_overdue: daysLate,
        total_penalty: penalty,
        period_month: month,
        period_year: year,
        status: 'active'
      }, { onConflict: 'tenant_id,period_month,period_year' });
    }

    // Update callback record as processed
    await supabase.from('mpesa_callbacks').update({
      processed: true,
      matched_tenant_id: unit.current_tenant_id,
      matched_property_id: unit.property_id
    }).eq('mpesa_receipt_number', mpesaRef);

    // ── SEND RECEIPT SMS ──
    const { data: tenant } = await supabase
      .from('tenants')
      .select('name, phone')
      .eq('id', unit.current_tenant_id)
      .single();

    await sendSMS(
      tenant.phone,
      `✅ NYUMBALINK RECEIPT\nDear ${tenant.name}, KES ${amount} received.\nRef: ${mpesaRef}\nReceipt: ${payment.receipt_number}\nUnit: ${accountRef}\nBalance: KES 0\nThank you! – NyumbaLink`,
      unit.current_tenant_id,
      unit.property_id,
      'receipt'
    );

    // ── NOTIFY LANDLORD ──
    await supabase.from('notifications').insert({
      landlord_id: unit.properties?.landlord_id,
      property_id: unit.property_id,
      title: `💰 Payment Received – Unit ${accountRef}`,
      body: `${tenant.name} paid KES ${amount}. M-Pesa Ref: ${mpesaRef}.`,
      type: 'success'
    });

    // Update Rent Score
    await updateRentScore(unit.current_tenant_id, daysLate);

    console.log(`✅ Payment processed for ${tenant.name} (${accountRef}): KES ${amount}`);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  } catch (error) {
    console.error('Callback processing error:', error);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // Always respond OK to M-Pesa
  }
});

// ── C2B PAYBILL CONFIRMATION (for manual Paybill payments) ──
app.post('/api/mpesa/confirmation', async (req, res) => {
  const { TransactionType, TransID, TransAmount, BillRefNumber, MSISDN, FirstName } = req.body;
  console.log(`💳 C2B: ${FirstName} paid KES ${TransAmount} · Ref: ${BillRefNumber} · Code: ${TransID}`);
  // Process same as callback above
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});


// ============================================================
// ════ AFRICA'S TALKING SMS FUNCTIONS ════
// ============================================================

// ── Core SMS sender ──
async function sendSMS(phone, message, tenantId, propertyId, messageType) {
  try {
    const formattedPhone = phone.startsWith('+') ? phone : '+254' + phone.slice(1);

    const result = await sms.send({
      to: [formattedPhone],
      message,
      from: process.env.AT_SENDER_ID || 'NYUMBALINK' // Your registered sender ID
    });

    const msgData = result.SMSMessageData?.Recipients?.[0];

    // Log to database
    await supabase.from('sms_logs').insert({
      recipient_phone: phone,
      tenant_id: tenantId,
      property_id: propertyId,
      message_type: messageType,
      message_body: message,
      status: msgData?.status === 'Success' ? 'sent' : 'failed',
      africas_talking_id: msgData?.messageId,
      cost: parseFloat(msgData?.cost?.replace('KES ', '') || '0')
    });

    console.log(`📱 SMS sent to ${phone}: ${message.substring(0, 50)}...`);
    return true;
  } catch (error) {
    console.error(`SMS error for ${phone}:`, error.message);
    return false;
  }
}

// ── Welcome SMS (when tenant is enrolled) ──
app.post('/api/sms/welcome', async (req, res) => {
  const { phone, name, unitNumber, tempPassword } = req.body;
  const firstName = name.split(' ')[0];
  const message = `🏠 Welcome to NyumbaLink, ${firstName}!\n\nYour tenant portal is ready.\nPhone: ${phone}\nTemp Password: ${tempPassword}\nLogin: nyumbalink.co.ke/tenant\n\nChange password after first login. – NyumbaLink`;
  await sendSMS(phone, message, null, null, 'welcome');
  res.json({ success: true });
});

// ── Receipt SMS ──
app.post('/api/sms/receipt', async (req, res) => {
  const { phone, name, receiptNumber, amount, balance } = req.body;
  const firstName = name.split(' ')[0];
  const message = `✅ NYUMBALINK RECEIPT\nHi ${firstName}, KES ${amount} received.\nReceipt: ${receiptNumber}\nBalance: KES ${balance || 0}\nThank you for paying on time!\n– NyumbaLink`;
  await sendSMS(phone, message, null, null, 'receipt');
  res.json({ success: true });
});

// ── Manual broadcast (landlord sends custom message) ──
app.post('/api/sms/broadcast', async (req, res) => {
  try {
    const { propertyId, recipientType, message, landlordId } = req.body;

    let query = supabase.from('tenants').select('phone, name, id').eq('property_id', propertyId).eq('status', 'active');

    if (recipientType === 'overdue') {
      // Only get overdue tenants (would need more complex query in production)
      query = query.eq('has_overdue_rent', true);
    }

    const { data: tenants } = await query;
    if (!tenants || tenants.length === 0) return res.json({ success: true, sent: 0 });

    let sent = 0;
    for (const tenant of tenants) {
      const personalised = message.replace('[NAME]', tenant.name.split(' ')[0]).replace('[UNIT]', tenant.unit_number || '');
      const success = await sendSMS(tenant.phone, personalised, tenant.id, propertyId, 'broadcast');
      if (success) sent++;
    }

    console.log(`📢 Broadcast sent to ${sent}/${tenants.length} tenants`);
    res.json({ success: true, sent, total: tenants.length });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ============================================================
// ════ AUTOMATED SMS CRON JOBS ════
// ============================================================

// ── RENT REMINDER: Every 31st at 8:00 AM (Early reminder) ──
cron.schedule('0 8 31 * *', async () => {
  console.log('📅 Running 31st rent reminder...');
  await sendRentReminders('early', 'Friendly reminder: rent is due on the 10th. Pay early to avoid penalties!');
});

// ── RENT REMINDER: Every 5th at 8:00 AM ──
cron.schedule('0 8 5 * *', async () => {
  console.log('📅 Running 5th rent reminder...');
  await sendRentReminders('mid', 'Rent is due in 5 days (10th). Pay via M-Pesa Paybill 522522, Account: your unit number.');
});

// ── RENT REMINDER: Every 9th at 8:00 AM (Final warning) ──
cron.schedule('0 8 9 * *', async () => {
  console.log('📅 Running 9th final warning...');
  await sendRentReminders('final', 'FINAL REMINDER: Rent due TOMORROW (10th). Pay now to avoid KES 20/day late penalty!');
});

// ── PENALTY NOTICE: Every day from 11th onwards at 8:00 AM ──
cron.schedule('0 8 11-31 * *', async () => {
  const day = new Date().getDate();
  if (day < 11) return;
  console.log(`⚠️ Running day ${day} penalty notifications...`);
  await sendPenaltyNotices(day);
});

// ── GARBAGE REMINDER: Every Tuesday at 6:00 PM ──
cron.schedule('0 18 * * 2', async () => {
  console.log('🗑️ Sending Tuesday garbage reminder...');
  await sendGarbageReminders('evening');
});

// ── GARBAGE URGENT: Every Wednesday at 5:45 AM ──
cron.schedule('45 5 * * 3', async () => {
  console.log('🚨 Sending Wednesday morning garbage alert...');
  await sendGarbageReminders('morning');
});

// ── WATER BILL NOTICE: 1st of every month at 7:00 AM ──
cron.schedule('0 7 1 * *', async () => {
  console.log('💧 Sending water bill notifications...');
  await sendWaterBillNotices();
});

// ── LEASE EXPIRY ALERT: Daily at 9 AM (checks 90/60/30 day windows) ──
cron.schedule('0 9 * * *', async () => {
  await sendLeaseExpiryAlerts();
});


// ── HELPER: Send rent reminders to all unpaid tenants ──
async function sendRentReminders(type, customMessage) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  // Get all active tenants
  const { data: tenants } = await supabase
    .from('tenants')
    .select('id, name, phone, unit_id, property_id, units(unit_number), properties(name, mpesa_paybill)')
    .eq('status', 'active');

  if (!tenants) return;

  for (const tenant of tenants) {
    // Check if rent already paid this month
    const { data: payment } = await supabase
      .from('payments')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('payment_type', 'rent')
      .eq('period_month', month)
      .eq('period_year', year)
      .eq('status', 'confirmed')
      .limit(1);

    if (payment && payment.length > 0) continue; // Already paid, skip

    const firstName = tenant.name.split(' ')[0];
    const unitNum = tenant.units?.unit_number || '';
    const paybill = tenant.properties?.mpesa_paybill || '522522';

    const message = `💳 NYUMBALINK: Hi ${firstName}, ${customMessage}\nPaybill: ${paybill}, Account: ${unitNum}\n– NyumbaLink`;

    await sendSMS(tenant.phone, message, tenant.id, tenant.property_id, `rent_reminder_${type}`);

    // Add notification to app
    await supabase.from('notifications').insert({
      tenant_id: tenant.id,
      property_id: tenant.property_id,
      title: '💳 Rent Reminder',
      body: customMessage,
      type: 'warning'
    });
  }
}

// ── HELPER: Send penalty notices ──
async function sendPenaltyNotices(dayOfMonth) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const daysLate = dayOfMonth - 10;
  const penaltyPerDay = 20;
  const totalPenalty = daysLate * penaltyPerDay;

  const { data: tenants } = await supabase
    .from('tenants')
    .select('id, name, phone, property_id, unit_id, units(unit_number)')
    .eq('status', 'active');

  if (!tenants) return;

  for (const tenant of tenants) {
    const { data: payment } = await supabase
      .from('payments').select('id').eq('tenant_id', tenant.id)
      .eq('payment_type', 'rent').eq('period_month', month).eq('period_year', year).limit(1);

    if (payment && payment.length > 0) continue;

    const firstName = tenant.name.split(' ')[0];
    const message = `⚠️ NYUMBALINK PENALTY NOTICE\nHi ${firstName}, your rent is ${daysLate} day(s) overdue.\nPenalty: KES ${totalPenalty} (KES 20/day x ${daysLate} days).\nPay immediately to stop penalty growing.\n– NyumbaLink`;

    await sendSMS(tenant.phone, message, tenant.id, tenant.property_id, 'penalty_notice');

    // Update or create penalty record
    await supabase.from('penalties').upsert({
      tenant_id: tenant.id,
      unit_id: tenant.unit_id,
      property_id: tenant.property_id,
      days_overdue: daysLate,
      total_penalty: totalPenalty,
      period_month: month,
      period_year: year,
      status: 'active'
    }, { onConflict: 'tenant_id,period_month,period_year' });
  }
}

// ── HELPER: Garbage reminders ──
async function sendGarbageReminders(timing) {
  const { data: tenants } = await supabase
    .from('tenants')
    .select('id, name, phone, property_id, units(unit_number)')
    .eq('status', 'active');

  if (!tenants) return;

  const messages = {
    evening: (name, unit) => `🗑️ NYUMBALINK: Hi ${name}, garbage collection is TOMORROW (Wednesday) at 6:00 AM. Please put your bins outside Unit ${unit} by 10pm tonight. – NyumbaLink`,
    morning: (name, unit) => `⏰ NYUMBALINK: Garbage truck arriving in 15 MINUTES! Please take bins outside Unit ${unit} immediately! Don't miss it! – NyumbaLink`
  };

  for (const tenant of tenants) {
    const firstName = tenant.name.split(' ')[0];
    const unitNum = tenant.units?.unit_number || 'your unit';
    const message = messages[timing](firstName, unitNum);
    await sendSMS(tenant.phone, message, tenant.id, tenant.property_id, `garbage_${timing}`);
  }

  console.log(`🗑️ Garbage ${timing} alerts sent to ${tenants.length} tenants`);
}

// ── HELPER: Water bill notices ──
async function sendWaterBillNotices() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const { data: bills } = await supabase
    .from('water_readings')
    .select('*, tenants(name, phone, id), units(unit_number)')
    .eq('period_month', month)
    .eq('period_year', year)
    .eq('status', 'billed');

  if (!bills) return;

  for (const bill of bills) {
    const firstName = bill.tenants.name.split(' ')[0];
    const message = `💧 NYUMBALINK WATER BILL: Hi ${firstName}, your water bill for ${getMonthName(month)} is KES ${bill.bill_amount} (${bill.units_consumed} m³). Due by ${year}-${String(month).padStart(2,'0')}-20. Pay via Paybill. – NyumbaLink`;
    await sendSMS(bill.tenants.phone, message, bill.tenants.id, bill.property_id, 'water_bill');
  }
}

// ── HELPER: Lease expiry alerts ──
async function sendLeaseExpiryAlerts() {
  const today = new Date();
  const { data: leases } = await supabase
    .from('leases')
    .select('*, tenants(name, phone, id), units(unit_number)')
    .eq('status', 'active');

  if (!leases) return;

  for (const lease of leases) {
    const endDate = new Date(lease.end_date);
    const daysUntilExpiry = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));

    if ([90, 60, 30].includes(daysUntilExpiry)) {
      const firstName = lease.tenants.name.split(' ')[0];
      const message = `📋 NYUMBALINK LEASE NOTICE: Hi ${firstName}, your lease for Unit ${lease.units.unit_number} expires in ${daysUntilExpiry} days (${lease.end_date}). Your landlord will send a renewal offer. Contact management if you have questions. – NyumbaLink`;
      await sendSMS(lease.tenants.phone, message, lease.tenants.id, lease.property_id, 'lease_expiry');
    }
  }
}

function getMonthName(month) {
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][month - 1];
}

async function updateRentScore(tenantId, daysLate) {
  const { data: tenant } = await supabase.from('tenants').select('rent_score').eq('id', tenantId).single();
  if (!tenant) return;
  let score = tenant.rent_score;
  if (daysLate === 0) score = Math.min(850, score + 8);
  else if (daysLate <= 3) score = Math.max(300, score - 15);
  else if (daysLate <= 7) score = Math.max(300, score - 30);
  else score = Math.max(300, score - 50);
  await supabase.from('tenants').update({ rent_score: score }).eq('id', tenantId);
}


// ============================================================
// ════ HEALTH CHECK ════
// ============================================================
app.get('/', (req, res) => {
  res.json({
    service: 'NyumbaLink Backend',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: [
      'POST /api/mpesa/stk-push',
      'POST /api/mpesa/callback',
      'POST /api/mpesa/confirmation',
      'POST /api/sms/welcome',
      'POST /api/sms/receipt',
      'POST /api/sms/broadcast'
    ]
  });
});

// ── START SERVER ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 NyumbaLink Backend running on port ${PORT}`);
  console.log(`📱 M-Pesa Callback URL: ${process.env.MPESA_CALLBACK_URL}`);
  console.log(`💬 SMS via Africa's Talking: ${process.env.AT_USERNAME}`);
  console.log(`⏰ Cron jobs scheduled: Rent reminders, Garbage alerts, Water bills, Lease expiry\n`);
});


// ============================================================
// .env FILE TEMPLATE — Create this file in your project root
// ============================================================
/*
# .env file — NEVER commit this to GitHub!

# Supabase
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# M-Pesa Daraja (get from developer.safaricom.co.ke)
MPESA_CONSUMER_KEY=your_consumer_key_here
MPESA_CONSUMER_SECRET=your_consumer_secret_here
MPESA_SHORTCODE=522522
MPESA_PASSKEY=your_passkey_here
MPESA_CALLBACK_URL=https://your-server.railway.app/api/mpesa/callback

# Africa's Talking (get from africastalking.com)
AT_API_KEY=your_at_api_key_here
AT_USERNAME=sandbox
AT_SENDER_ID=NYUMBALINK

# App
PORT=3000
NODE_ENV=development
*/

// ============================================================
// package.json TEMPLATE
// ============================================================
/*
{
  "name": "nyumbalink-backend",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "axios": "^1.6.0",
    "node-cron": "^3.0.3",
    "dotenv": "^16.3.1",
    "@supabase/supabase-js": "^2.39.0",
    "africastalking": "^0.7.5"
  },
  "devDependencies": {
    "nodemon": "^3.0.2"
  }
}
*/
