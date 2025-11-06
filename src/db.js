// src/db.js
const { Pool } = require('pg');
require('dotenv').config();

let pool;

try {
  // Проверяем наличие DATABASE_URL
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL не задан в .env файле');
    throw new Error('DATABASE_URL не задан');
  }

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false // обязательно для Neon
    }
  });

  console.log('✅ Pool создан успешно');

  // Тест подключения
  pool.query('SELECT NOW()', (err, res) => {
    if (err) {
      console.error('❌ Ошибка подключения к БД:', err.message);
    } else {
      console.log('✅ Подключено к PostgreSQL (Neon)');
    }
  });
} catch (err) {
  console.error('❌ Ошибка при создании Pool:', err.message);
  console.error('   Stack:', err.stack);
  pool = null;
}

/**
 * Генерирует следующий уникальный CM ID для прокси
 * @returns {Promise<string>} CM ID в формате CM000001
 */
async function generateCmId() {
  if (!pool) throw new Error('Pool не инициализирован');
  
  try {
    const result = await pool.query("SELECT 'CM' || LPAD(nextval('cm_id_seq')::TEXT, 6, '0') as cm_id");
    return result.rows[0].cm_id;
  } catch (err) {
    console.error('❌ Ошибка генерации CM ID:', err.message);
    // Fallback: генерируем на основе timestamp
    return `CM${Date.now().toString().slice(-6)}`;
  }
}

/**
 * Выполняет операцию в транзакции
 * @param {Function} callback - async функция, которая получает client
 * @returns {Promise<*>} результат callback
 */
async function withTransaction(callback) {
  if (!pool) throw new Error('Pool не инициализирован');
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, generateCmId, withTransaction };