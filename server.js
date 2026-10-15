const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());

// ফায়ারবেস সার্ভিস অ্যাকাউন্ট কনফিগারেশন 
// আপনার প্রজেক্টের downloaded serviceAccountKey.json ফাইলটি ফোল্ডারে রাখবেন
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://YOUR_FIREBASE_PROJECT_ID-default-rtdb.firebaseio.com" // আপনার ফায়ারবেস রিয়েলটাইম ডেটাবেস ইউআরএল এখানে দিন
});

const db = admin.database();

// ১. NOWPayments ইনভয়েস বা পেমেন্ট লিংক তৈরির এপিআই (ইউজার অ্যাপ থেকে কল হবে)
app.post('/api/create-payment', async (req, res) => {
  const { userId, amount } = req.body;
  
  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid user or amount' });
  }

  try {
    const response = await axios.post('https://api.nowpayments.io/v1/invoice', {
      price_amount: amount,
      price_currency: 'usd', // টাকার অ্যামাউন্ট ডলারে হিসাব করা হবে
      pay_currency: 'usdttrc20', // ইউজার USDT TRC20 দিয়ে পেমেন্ট করবে
      ipn_callback_url: 'https://tarzan-pay-backend.onrender.com/api/nowpayments-ipn', // Render-এর লাইভ ব্যাকএন্ড URL এখানে বসাবেন
      order_id: userId,
      order_description: `Deposit for Tarzan Pay User ID: ${userId}`
    }, {
      headers: {
        'x-api-key': 'YOUR_NOWPAYMENTS_API_KEY', // আপনার NOWPayments ড্যাশবোর্ডের API Key এখানে দিন
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

// সার্ভার রানিং পোর্ট
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tarzan Pay Backend is running on port ${PORT}`);
});
