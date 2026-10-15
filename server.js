const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors());

// ফায়ারবেস সার্ভিস অ্যাকাউন্ট কানেক্ট করা (serviceAccountKey.json ফাইল ফোল্ডারে থাকতে হবে)
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://tarzan-pay-ok-default-rtdb.firebaseio.com" // 👉 আপনার ফায়ারবেস ডেটাবেস ইউআরএল এখানে দিন
});

const db = admin.database();

// কনফিগারেশন
const NOWPAYMENTS_API_KEY = '8MV8F0J-VB2MQ56-MWM2RCV-F8XBD9P'; // 👉 আপনার NOWPayments API Key এখানে দিন
const IPN_SECRET = 'oKxHubU50XWxZhEWrzO4aUZcKyKQDXBv';     // 👉 আপনার NOWPayments IPN Secret এখানে দিন
const RENDER_SERVER_URL = 'https://tarzanpay-nowpayment.onrender.com';

// ১. পেমেন্ট ইনভয়েস তৈরির এপিআই (ইউজার অ্যাপ থেকে কল হবে)
app.post('/api/create-payment', async (req, res) => {
  const { userId, amount } = req.body;
  
  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid user or amount' });
  }

  try {
    const response = await axios.post('https://api.nowpayments.io/v1/invoice', {
      price_amount: amount,
      price_currency: 'usd',               // ডলারে অ্যামাউন্ট হিসাব হবে
      pay_currency: 'usdtbsc',             // USDT on Binance Smart Chain (BSC/BEP20)
      ipn_callback_url: `${RENDER_SERVER_URL}/api/nowpayments-ipn`,
      order_id: userId,
      order_description: `Deposit for Tarzan Pay User ID: ${userId}`
    }, {
      headers: {
        'x-api-key': NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    return res.status(200).json({ 
      success: true, 
      paymentURL: response.data.invoice_url 
    });
  } catch (error) {
    console.error('Payment Error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, message: 'Failed to create payment gateway' });
  }
});

// ২. NOWPayments Webhook / IPN API (পেমেন্ট সম্পন্ন হলে অটো ব্যালেন্স যোগ হবে)
app.post('/api/nowpayments-ipn', async (req, res) => {
  try {
    // নিরাপত্তা যাচাইয়ের জন্য IPN Sig চেক করা (ঐচ্ছিক কিন্তু সুরক্ষিত)
    const sigHeader = req.headers['x-nowpayments-sig'];
    if (IPN_SECRET && sigHeader) {
      const hmac = crypto.createHmac('sha512', IPN_SECRET);
      // রিকোয়েস্ট বডি সর্ট করে সিগনেচার মেলানো হয়
      function sortObject(o) {
        return Object.keys(o).sort().reduce((acc, key) => {
          if (o[key] !== null && typeof o[key] === 'object' && !Array.isArray(o[key])) {
            acc[key] = sortObject(o[key]);
          } else {
            acc[key] = o[key];
          }
          return acc;
        }, {});
      }
      const sortedPayload = JSON.stringify(sortObject(req.body));
      hmac.update(sortedPayload);
      const computedSig = hmac.digest('hex');
      
      if (computedSig !== sigHeader) {
        console.warn('Warning: IPN signature mismatch!');
      }
    }

    const paymentData = req.body;
    console.log('IPN Received:', paymentData);

    // পেমেন্ট স্ট্যাটাস 'finished' বা 'confirmed' হলে ব্যালেন্স যুক্ত হবে
    if (paymentData.payment_status === 'finished' || paymentData.payment_status === 'confirmed') {
      const userId = paymentData.order_id;
      const amount = Number(paymentData.price_amount);
      const paymentId = paymentData.payment_id;

      const depositRef = db.ref('deposits/' + paymentId);
      const snap = await depositRef.once('value');

      // চেক করা হচ্ছে ট্রানজাকশনটি আগে প্রসেস হয়েছে কি না
      if (!snap.exists()) {
        // ফায়ারবেসে ডিপোজিট রেকর্ড সেভ করা
        await depositRef.set({
          paymentId,
          userId,
          amount,
          status: 'success',
          timestamp: Date.now()
        });

        // ইউজারের ফায়ারবেস ব্যালেন্স স্বয়ংক্রিয়ভাবে আপডেট করা
        const userRef = db.ref('users/' + userId);
        const userSnap = await userRef.once('value');
        
        if (userSnap.exists()) {
          const userData = userSnap.val();
          const currentBalance = Number(userData.balance || 0);
          const totalEarned = Number(userData.totalEarned || 0);

          await userRef.update({
            balance: currentBalance + amount,
            totalEarned: totalEarned + amount
          });
          
          console.log(`Balance credited successfully for user ${userId}: +${amount}`);
        }
      }
    }

    return res.status(200).send({ success: true });
  } catch (error) {
    console.error('IPN Processing Error:', error);
    return res.status(500).send({ success: false, error: error.message });
  }
});

// সার্ভার স্টার্ট
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tarzan Pay Backend is running on port ${PORT}`);
});
