// src/cryptoBot.js
require('dotenv').config();
const axios = require('axios');

// URL для CryptoPay API (продакшен)
const CRYPTO_BOT_API_URL = process.env.CRYPTO_BOT_API_URL || 'https://pay.crypt.bot/api';
const CRYPTO_BOT_TOKEN = process.env.CRYPTO_BOT_API_TOKEN; // ← из @CryptoBot → Merchant → API Token

// Проверка токена только при использовании функций (не при загрузке модуля)
function checkToken() {
  if (!CRYPTO_BOT_TOKEN) {
    throw new Error('❌ CRYPTO_BOT_API_TOKEN не найден в .env');
  }
}

const { Pool } = require('pg'); // если используешь Neon.tech

// Подключаемся к БД только если есть DATABASE_URL
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

/**
 * Создание инвойса через CryptoPay API
 */
async function createInvoice({ amount, payload, description = 'Пополнение баланса' }) {
  checkToken();
  
  try {
    // CryptoPay API использует токен в заголовке
    const response = await axios.post(
      `${CRYPTO_BOT_API_URL}/createInvoice`,
      {
        asset: 'USDT', // или 'TON', 'BTC' и т.д.
        amount: amount.toString(),
        description,
        payload, // ← твой deposit_123456
        paid_btn_name: 'viewItem',
        paid_btn_url: process.env.BOT_URL || 'https://t.me/CapitanMARKET_bot'
      },
      {
        headers: {
          'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    // Проверяем структуру ответа
    if (response.data.ok && response.data.result) {
      const result = response.data.result;
      return {
        invoiceId: result.invoice_id || result.invoiceId,
        payUrl: result.bot_invoice_url || result.pay_url || result.invoice_url
      };
    } else {
      console.error('❌ Неожиданный формат ответа API:', response.data);
      throw new Error('API вернул неожиданный формат ответа');
    }
  } catch (error) {
    console.error('❌ Ошибка создания инвойса:');
    console.error('   URL:', `${CRYPTO_BOT_API_URL}/createInvoice`);
    console.error('   Статус:', error.response?.status);
    console.error('   Данные:', error.response?.data || error.message);
    
    // Более подробная обработка ошибок
    if (error.response?.status === 401) {
      throw new Error('Неверный API токен. Убедитесь, что CRYPTO_BOT_API_TOKEN правильный и получен из @CryptoBot → Merchant → API.');
    } else if (error.response?.data?.error) {
      throw new Error(`Ошибка API: ${error.response.data.error.name || error.response.data.error.message || 'Неизвестная ошибка'}`);
    }
    
    throw new Error('Не удалось создать инвойс. Попробуйте позже.');
  }
}

function verifyWebhook(payload, signature) {
  if (!process.env.CRYPTO_BOT_SECRET) return true;
  const crypto = require('crypto');
  const hash = crypto
    .createHmac('sha256', process.env.CRYPTO_BOT_SECRET)
    .update(JSON.stringify(payload))
    .digest('hex');
  return hash === signature;
}

async function handlePayment(invoice) {
  if (invoice.status !== 'paid') return;

  const { payload, amount, user_id: telegramUserId } = invoice;

  // Обрабатываем пополнение баланса
  if (payload.startsWith('deposit_')) {
    const userId = parseInt(payload.replace('deposit_', ''));
    if (userId !== telegramUserId) {
      console.warn('⚠️ User ID mismatch in deposit');
      return;
    }

    // Используем модуль баланса для пополнения
    const { addBalance } = require('./balance');
    const newBalance = addBalance(telegramUserId, parseFloat(amount));

    // Если есть БД, также обновляем там
    if (pool) {
      try {
        await pool.query(
          'UPDATE users SET balance = balance + $1 WHERE telegram_id = $2',
          [parseFloat(amount), telegramUserId]
        );
      } catch (dbErr) {
        console.error('❌ Ошибка обновления БД:', dbErr.message);
      }
    }

    console.log(`✅ Баланс пополнен: user=${telegramUserId}, сумма=${amount}, новый баланс=${newBalance}`);
  }
}

/**
 * Проверка статуса инвойса через CryptoPay API
 */
async function checkInvoiceStatus(invoiceId) {
  checkToken();
  
  try {
    const response = await axios.get(
      `${CRYPTO_BOT_API_URL}/getInvoices`,
      {
        params: {
          invoice_ids: invoiceId
        },
        headers: {
          'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.ok && response.data.result && response.data.result.items) {
      const invoices = response.data.result.items;
      if (invoices.length > 0) {
        const invoice = invoices[0];
        return {
          status: invoice.status, // 'paid', 'active', 'expired'
          invoiceId: invoice.invoice_id || invoice.invoiceId,
          amount: invoice.amount,
          paidAt: invoice.paid_at
        };
      }
    }
    return null;
  } catch (error) {
    console.error('❌ Ошибка проверки статуса инвойса:', error.response?.data || error.message);
    return null;
  }
}

module.exports = { createInvoice, handlePayment, verifyWebhook, checkInvoiceStatus };