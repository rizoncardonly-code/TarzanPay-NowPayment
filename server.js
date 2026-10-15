// ==========================================================
//  Tarzan Pay — NOWPayments TON Backend
//  Deploy on Render.com  •  Node.js 18+
//  Minimum deposit: $0.5
//  Includes: URL sanitization, TON payments, API key auth
// ==========================================================
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import crypto from 'crypto';
import admin from 'firebase-admin';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ========== 🔐 CONFIG (Render Environment Variables) ==========
const NOWPAYMENTS_API_KEY   = process.env.NOWPAYMENTS_API_KEY;   // required
const NOWPAYMENTS_IPN_KEY   = process.env.NOWPAYMENTS_IPN_KEY;   // required
const SHARED_API_KEY        = process.env.SHARED_API_KEY;        // required
const FIREBASE_SERVICE_JSON = process.env.FIREBASE_SERVICE_JSON; // required
const PUBLIC_URL            = process.env.PUBLIC_URL || '';
const NOWPAYMENTS_API       = 'https://api.nowpayments.io/v1';

// Deposit limits (USD)
const MIN_DEPOSIT_USD = 0.5;
const MAX_DEPOSIT_USD = 10000;

// ========== 🔥 Firebase Admin Init ==========
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_JSON)),
    databaseURL: 'https://tarzan-pay-ok-default-rtdb.firebaseio.com'
  });
}
const db = admin.database();

// ========== 🛡️ Auth Middleware ==========
function requireApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!key || key !== SHARED_API_KEY) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

// ========== 🧰 Helpers ==========
function sortObject(obj) {
  if (Array.isArray(obj)) return obj.map(sortObject);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, k) => {
      acc[k] = sortObject(obj[k]);
      return acc;
    }, {});
  }
  return obj;
}

function isValidUserId(id) {
  return typeof id === 'string' && id.length >= 3 && id.length <= 32 && /^[A-Za-z0-9_-]+$/.test(id);
}

// 🆕 Sanitize URLs — fixes "success_url must be valid url"
function safeUrl(u, fallback) {
  if (!u || typeof u !== 'string') return fallback;
  // Strip placeholders like {PAYMENT_ID}, {ORDER_ID} etc.
  const cleaned = u.replace(/\{[^}]+\}/g, '');
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== 'https:') return fallback;
    return parsed.toString();
  } catch (e) {
    return fallback;
  }
}

// ==========================================================
// 1️⃣ Create Payment (TON)
// ==========================================================
app.post('/api/create-payment', requireApiKey, async (req, res) => {
  try {
    const { userId, amount, returnUrl, cancelUrl } = req.body || {};

    if (!isValidUserId(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid userId' });
    }

    const amt = Number(amount);
    if (!amt || isNaN(amt)) {
      return res.status(400).json({ success: false, message: 'Amount required' });
    }
    if (amt < MIN_DEPOSIT_USD) {
      return res.status(400).json({
        success: false,
        message: `Minimum deposit is $${MIN_DEPOSIT_USD}`
      });
    }
    if (amt > MAX_DEPOSIT_USD) {
      return res.status(400).json({
        success: false,
        message: `Maximum deposit is $${MAX_DEPOSIT_USD}`
      });
    }

    // 🆕 Sanitize return/cancel URLs
    const finalReturn = safeUrl(returnUrl, `${PUBLIC_URL}/?deposit=success`);
    const finalCancel = safeUrl(cancelUrl, `${PUBLIC_URL}/?deposit=cancel`);

    const orderId = `TP_${userId}_${Date.now()}`;

    const body = {
      price_amount: amt,
      price_currency: 'usd',
      pay_currency: 'ton',                 // 🔥 TON (Toncoin)
      order_id: orderId,
      order_description: `Tarzan Pay deposit for user ${userId}`,
      ipn_callback_url: `${PUBLIC_URL}/api/webhook`,
      success_url: finalReturn,
      cancel_url: finalCancel
    };

    const r = await fetch(`${NOWPAYMENTS_API}/payment`, {
      method: 'POST',
      headers: {
        'x-api-key': NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await r.json();

    if (!r.ok || !data.payment_id) {
      console.error('NOWPayments error:', data);
      return res.status(500).json({
        success: false,
        message: data.message || 'Payment creation failed'
      });
    }

    // Save pending deposit to Firebase
    await db.ref(`users/${userId}/pendingDeposits/${data.payment_id}`).set({
      paymentId: data.payment_id,
      orderId,
      amount: amt,
      payAddress: data.pay_address || '',
      payAmount: data.pay_amount || 0,
      payCurrency: 'ton',
      status: 'pending',
      createdAt: Date.now()
    });

    return res.json({
      success: true,
      paymentId: data.payment_id,
      paymentURL: data.invoice_url || `https://nowpayments.io/payment/?iid=${data.payment_id}`,
      payAddress: data.pay_address || '',
      payAmount: data.pay_amount || 0
    });

  } catch (err) {
    console.error('create-payment error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==========================================================
// 2️⃣ Check Payment Status
// ==========================================================
app.get('/api/status/:paymentId', requireApiKey, async (req, res) => {
  try {
    const { paymentId } = req.params;
    if (!paymentId) {
      return res.status(400).json({ success: false, message: 'paymentId required' });
    }

    const r = await fetch(`${NOWPAYMENTS_API}/payment/${paymentId}`, {
      headers: { 'x-api-key': NOWPAYMENTS_API_KEY }
    });
    const data = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({ success: false, message: data.message || 'Not found' });
    }

    return res.json({
      success: true,
      paymentId: data.payment_id,
      status: data.payment_status,
      amount: data.price_amount,
      payAmount: data.actually_paid || data.pay_amount,
      payCurrency: data.pay_currency || 'ton'
    });

  } catch (err) {
    console.error('status error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==========================================================
// 3️⃣ Webhook (IPN) — NOWPayments calls this on status change
// ==========================================================
app.post('/api/webhook', async (req, res) => {
  try {
    // Verify HMAC signature
    const sig = req.header('x-nowpayments-sig');
    if (NOWPAYMENTS_IPN_KEY && sig) {
      const sorted = JSON.stringify(sortObject(req.body));
      const hmac = crypto.createHmac('sha512', NOWPAYMENTS_IPN_KEY).update(sorted).digest('hex');
      if (hmac !== sig) {
        console.warn('⚠️ Invalid webhook signature');
        return res.status(401).send('Invalid signature');
      }
    }

    const { payment_id, payment_status, order_id, price_amount } = req.body;
    if (!payment_id) return res.status(400).send('Missing payment_id');

    // Extract userId from order_id (format: TP_<userId>_<timestamp>)
    const parts = (order_id || '').split('_');
    const userId = parts.length >= 2 ? parts[1] : null;
    if (!userId) return res.status(400).send('Missing userId');

    const status = String(payment_status || '').toLowerCase();

    // Update pending deposit record
    await db.ref(`users/${userId}/pendingDeposits/${payment_id}`).update({
      status,
      webhookAt: Date.now(),
      actuallyPaid: req.body.actually_paid || null
    });

    // Credit only on finished / confirmed
    if (status === 'finished' || status === 'confirmed') {
      const amt = Number(price_amount || 0);
      if (amt <= 0) return res.send('ok');

      // Prevent double-credit
      const existing = await db.ref(`users/${userId}/deposits/${payment_id}`).once('value');
      if (existing.exists()) {
        console.log('⚠️ Deposit already credited:', payment_id);
        return res.send('ok');
      }

      // Save deposit to history
      await db.ref(`users/${userId}/deposits/${payment_id}`).set({
        paymentId: payment_id,
        orderId: order_id,
        amount: amt,
        payCurrency: 'ton',
        status: 'credited',
        createdAt: Date.now(),
        creditedAt: Date.now()
      });

      // Atomic balance increment
      await db.ref(`users/${userId}/balance`).transaction(cur => Number(cur || 0) + amt);

      // Remove pending
      await db.ref(`users/${userId}/pendingDeposits/${payment_id}`).remove();

      // Personal notification
      await db.ref(`users/${userId}/notifications`).push({
        title: 'Deposit Credited ✅',
        text: `Your TON deposit of $${amt.toFixed(2)} has been credited to your balance.`,
        status: 'success',
        txId: payment_id,
        timestamp: Date.now()
      });

      console.log(`✅ Credited $${amt} to user ${userId} (payment ${payment_id})`);
    }

    return res.send('ok');

  } catch (err) {
    console.error('webhook error:', err);
    return res.status(500).send('error');
  }
});

// ==========================================================
// 4️⃣ Health Check
// ==========================================================
app.get('/', (req, res) => {
  res.send('Tarzan Pay TON deposit API is running ✅');
});

// ==========================================================
// 🚀 Start Server
// ==========================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Tarzan Pay TON server running on port ${PORT}`);
  console.log(`   Min deposit: $${MIN_DEPOSIT_USD} | Max: $${MAX_DEPOSIT_USD}`);
});
