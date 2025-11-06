// src/bot.js
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

// Проверка токена бота
if (!process.env.BOT_TOKEN) {
  throw new Error('❌ BOT_TOKEN не найден в .env');
}

// Интеграция Proxy-Seller API
const { initClient: initPsClient, calculatePrice: psCalculatePrice, buyProxy: psBuyProxy, getProxyCredentials, testApiConnection, downloadProxies } = require('./proxySellerApi');

// Импорт базы данных
let pool;
let generateCmId;
let withTransaction;
let dbModule;
try {
  dbModule = require('./db');
  pool = dbModule.pool;
  generateCmId = dbModule.generateCmId;
  withTransaction = dbModule.withTransaction;
  if (!pool) {
    console.error('❌ pool не найден в модуле db.js');
    console.error('   Экспортированный объект:', Object.keys(dbModule || {}));
  } else {
    console.log('✅ Pool загружен из db.js');
  }
} catch (err) {
  console.error('❌ Ошибка при загрузке db.js:', err.message);
  console.error('   Stack:', err.stack);
  throw new Error('Не удалось загрузить модуль базы данных');
}

// Проверка наличия pool
if (!pool) {
  console.error('❌ pool не инициализирован после импорта');
  console.error('⚠️ Бот будет работать, но функции, требующие БД, будут недоступны');
  console.error('   Убедитесь, что DATABASE_URL задан в .env файле');
}

// Функции управления балансом теперь работают напрямую с pool через SQL-запросы

// Гарантируем наличие таблицы хранения прокси пользователя
async function ensureUserProxiesTable() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_proxies (
        id BIGSERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        cm_id TEXT UNIQUE,
        proxy_id BIGINT,
        order_id BIGINT,
        type TEXT,
        login TEXT,
        password TEXT,
        ip TEXT,
        port INTEGER,
        port_http INTEGER,
        port_socks INTEGER,
        country TEXT,
        date_start TIMESTAMPTZ,
        date_end TIMESTAMPTZ,
        status TEXT DEFAULT 'active',
        purchased_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Добавляем новые колонки, если их еще нет (для существующих таблиц)
    try {
      await pool.query(`ALTER TABLE user_proxies ADD COLUMN IF NOT EXISTS cm_id TEXT UNIQUE`);
      await pool.query(`ALTER TABLE user_proxies ADD COLUMN IF NOT EXISTS port_http INTEGER`);
      await pool.query(`ALTER TABLE user_proxies ADD COLUMN IF NOT EXISTS port_socks INTEGER`);
      await pool.query(`ALTER TABLE user_proxies ADD COLUMN IF NOT EXISTS country TEXT`);
      await pool.query(`ALTER TABLE user_proxies ADD COLUMN IF NOT EXISTS date_start TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE user_proxies ADD COLUMN IF NOT EXISTS date_end TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE user_proxies ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`);
      await pool.query(`ALTER TABLE user_proxies ADD COLUMN IF NOT EXISTS purchased_at TIMESTAMPTZ DEFAULT NOW()`);
    } catch (alterErr) {
      // Игнорируем ошибки, если колонки уже существуют
    }
    
    // Создаем последовательность для CM ID, если не существует
    try {
      await pool.query(`CREATE SEQUENCE IF NOT EXISTS cm_id_seq START WITH 1`);
    } catch (seqErr) {
      console.warn('⚠️ Последовательность cm_id_seq уже существует или не может быть создана');
    }
    
    console.log('✅ Таблица user_proxies готова');
  } catch (e) {
    console.error('❌ Не удалось создать таблицу user_proxies:', e.message);
  }
}

ensureUserProxiesTable();

/**
 * Сохраняет прокси в БД с генерацией уникального CM ID
 * Использует транзакции для атомарности операций
 * @param {Object} params
 * @param {number} params.telegramId - Telegram ID пользователя
 * @param {number} params.orderId - ID заказа из API
 * @param {string} params.type - Тип прокси (ipv4/ipv6)
 * @param {Array} params.proxies - Массив объектов прокси из API
 * @returns {Promise<Array>} Массив сохраненных прокси с CM ID
 */
async function saveUserProxies({ telegramId, orderId, type, proxies = [] }) {
  if (!pool || !withTransaction || !generateCmId) {
    console.error('❌ Функции БД не инициализированы');
    return [];
  }
  
  if (!Array.isArray(proxies) || proxies.length === 0) {
    console.warn('⚠️ Нет прокси для сохранения');
    return [];
  }
  
  try {
    // Используем транзакцию для атомарности
    const savedProxies = await withTransaction(async (client) => {
      const saved = [];
      
      for (const p of proxies) {
        // Генерируем уникальный CM ID
        const cmId = await generateCmId();
        
        // Извлекаем данные из объекта прокси
        const proxyId = p.id != null ? Number(p.id) : null;
        const proxyOrderId = p.order_id != null ? Number(p.order_id) : (orderId != null ? Number(orderId) : null);
        const login = p.login || null;
        const password = p.password || null;
        const ip = p.ip || p.ip_only || null;
        const port = Number(p.port_http || p.port_socks || p.port) || null;
        const portHttp = p.port_http ? Number(p.port_http) : null;
        const portSocks = p.port_socks ? Number(p.port_socks) : null;
        const country = p.country || null;
        
        // Безопасный парсинг дат с проверкой валидности
        let dateStart = null;
        let dateEnd = null;
        try {
          if (p.date_start) {
            const parsedStart = new Date(p.date_start);
            dateStart = !isNaN(parsedStart.getTime()) ? parsedStart : null;
          }
          if (p.date_end) {
            const parsedEnd = new Date(p.date_end);
            dateEnd = !isNaN(parsedEnd.getTime()) ? parsedEnd : null;
          }
        } catch (dateErr) {
          console.warn(`⚠️ Ошибка парсинга дат:`, { date_start: p.date_start, date_end: p.date_end });
          dateStart = null;
          dateEnd = null;
        }
        
        // Проверяем минимальные данные
        if (!login || !ip) {
          console.warn(`⚠️ Пропускаем прокси без логина или IP: ${JSON.stringify(p).slice(0, 100)}`);
          continue;
        }
        
        // Вставляем прокси с уникальным CM ID
        const insertText = `
          INSERT INTO user_proxies 
          (telegram_id, cm_id, proxy_id, order_id, type, login, password, ip, port, port_http, port_socks, country, date_start, date_end, status, purchased_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
          RETURNING id, cm_id, telegram_id, login, password, ip, port_http, port_socks, country, date_start, date_end
        `;
        
        const result = await client.query(insertText, [
          telegramId,     // $1
          cmId,           // $2 - уникальный CM ID
          proxyId,        // $3
          proxyOrderId,   // $4
          type || null,   // $5
          login,          // $6
          password,       // $7
          ip,             // $8
          port,           // $9
          portHttp,       // $10
          portSocks,      // $11
          country,        // $12
          dateStart,      // $13
          dateEnd,        // $14
          'active'        // $15 - статус
        ]);
        
        if (result.rows.length > 0) {
          saved.push(result.rows[0]);
        }
      }
      
      return saved;
    });
    
    console.log(`✅ Сохранено ${savedProxies.length} прокси для пользователя ${telegramId} с уникальными CM ID`);
    savedProxies.forEach(p => console.log(`   - ${p.cm_id}: ${p.ip}`));
    
    return savedProxies;
  } catch (e) {
    console.error('❌ Критическая ошибка сохранения прокси в БД:', e.message);
    console.error('   Stack:', e.stack);
    throw e; // Пробрасываем ошибку для отката транзакции покупки
  }
}

// Функция для парсинга строки прокси формата login:password:ip:port
function parseProxyString(proxyString) {
  const parts = proxyString.split(':');
  if (parts.length >= 4) {
    return {
      login: parts[0].trim(),
      password: parts[1].trim(),
      ip: parts[2].trim(),
      port: parseInt(parts[3].trim(), 10) || null
    };
  }
  return null;
}

/**
 * Сохраняет прокси из строк (fallback метод) с генерацией CM ID
 * @param {Object} params
 * @param {number} params.telegramId - Telegram ID пользователя
 * @param {number} params.orderId - ID заказа
 * @param {string} params.type - Тип прокси
 * @param {Array<string>} params.proxyStrings - Массив строк формата login:password:ip:port
 * @returns {Promise<Array>} Массив сохраненных прокси с CM ID
 */
async function saveProxiesFromStrings({ telegramId, orderId, type, proxyStrings = [] }) {
  if (!pool || !withTransaction || !generateCmId) {
    console.error('❌ Функции БД не инициализированы');
    return [];
  }
  
  if (!Array.isArray(proxyStrings) || proxyStrings.length === 0) {
    console.warn('⚠️ Нет строк прокси для сохранения');
    return [];
  }
  
  try {
    const savedProxies = await withTransaction(async (client) => {
      const saved = [];
      
      for (const proxyStr of proxyStrings) {
        const parsed = parseProxyString(proxyStr.trim());
        if (!parsed || !parsed.login || !parsed.ip || !parsed.port) {
          console.warn(`⚠️ Не удалось распарсить строку прокси: ${proxyStr}`);
          continue;
        }
        
        // Проверяем, не существует ли уже такая запись для этого пользователя
        const checkText = `SELECT cm_id FROM user_proxies 
                          WHERE telegram_id = $1 AND login = $2 AND ip = $3 AND port = $4`;
        const checkRes = await client.query(checkText, [
          telegramId,
          parsed.login,
          parsed.ip,
          parsed.port
        ]);
        
        if (checkRes.rows.length > 0) {
          console.log(`⚠️ Прокси ${parsed.ip} уже существует у пользователя ${telegramId}, пропускаем`);
          continue;
        }
        
        // Генерируем уникальный CM ID
        const cmId = await generateCmId();
        
        // Сохраняем с CM ID
        const insertText = `
          INSERT INTO user_proxies 
          (telegram_id, cm_id, order_id, type, login, password, ip, port, status, purchased_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
          RETURNING id, cm_id, telegram_id, login, password, ip, port
        `;
        
        const result = await client.query(insertText, [
          telegramId,
          cmId,
          orderId || null,
          type || null,
          parsed.login,
          parsed.password,
          parsed.ip,
          parsed.port,
          'active'
        ]);
        
        if (result.rows.length > 0) {
          saved.push(result.rows[0]);
        }
      }
      
      return saved;
    });
    
    if (savedProxies.length > 0) {
      console.log(`✅ Сохранено ${savedProxies.length} прокси из строк для пользователя ${telegramId}`);
      savedProxies.forEach(p => console.log(`   - ${p.cm_id}: ${p.ip}`));
    }
    
    return savedProxies;
  } catch (e) {
    console.error('❌ Ошибка сохранения прокси из строк в БД:', e.message);
    throw e;
  }
}

// Импорт функций CryptoBot
const { createInvoice, checkInvoiceStatus } = require('./cryptoBot');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Простое хранилище сессий в памяти
const userSessions = {};

// Хранилище активных проверок платежей: userId -> intervalId
const activePaymentChecks = {};

// Middleware для инициализации сессии
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (userId) {
    ctx.session = userSessions[userId] || {};
    userSessions[userId] = ctx.session;
  } else {
    ctx.session = {};
  }
  return next();
});

// Инициализация клиента Proxy-Seller и проверка доступности API
(async () => {
  try { 
    await initPsClient();
    console.log('⏳ Инициализация Proxy-Seller API...');
    // Даем время на инициализацию
    await new Promise(resolve => setTimeout(resolve, 1000));
    // Запускаем тест подключения
    await testApiConnection();
  } catch (e) { 
    console.error('❌ Proxy-Seller init error:', e.message);
    console.error('   Полная ошибка:', e);
  }
})();

// Главное меню (Reply-кнопки)
const mainMenu = Markup.keyboard([
  ['🛒 Купить прокси', '📦 Мои прокси'],
  ['👤 Профиль'],
  ['ℹ️ Помощь', '👤 Поддержка']
])
  .oneTime(false)
  .resize();

// Меню выбора типа IP (упрощённое — только приватные IPv4)
const ipChoiceMenu = Markup.inlineKeyboard([
  [Markup.button.callback('👤 Приватные IPv4', 'proxy_private_ipv4')],
  [Markup.button.callback('< Назад', 'back_to_buy_menu')]
]);

// Меню категорий IP при ручном выборе
const ipCategoryMenu = Markup.inlineKeyboard([
  [Markup.button.callback('MOB', 'ip_category_MOB')],
  [Markup.button.callback('ISP/MOB', 'ip_category_ISP_MOB')],
  [Markup.button.callback('ISP', 'ip_category_ISP')],
  [Markup.button.callback('DCH', 'ip_category_DCH')],
  [Markup.button.callback('< Назад', 'back_to_buy_menu')]
]);

function buildBuyEntryMenu() {
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('Приватные IPv4', 'proxy_private_ipv4')],
    [Markup.button.callback('Общие IPv4', 'proxy_shared_ipv4')],
    [Markup.button.callback('Приватные IPv6', 'proxy_private_ipv6')]
  ]);
  const text = '<b>├ В нашем магазине используются только чистые и качественные прокси.\n\n ╰ Выбери тип прокси:</b>';
  return { text, kb };
}

// ====== Меню выбора континента и страны ======
const PAGE_SIZE = 18; // кол-во стран на странице
const COLUMNS = 3;    // кнопок в строке
const countryCache = { ipv4: null, ipv6: null };

const CONTINENTS = [
  { key: 'europe', title: 'Europe' },
  { key: 'asia', title: 'Asia' },
  { key: 'africa', title: 'Africa' },
  { key: 'north_america', title: 'North America' },
  { key: 'south_america', title: 'South America' },
  { key: 'oceania', title: 'Australia' }
];

// Явные списки стран по континентам (ISO alpha-3)
const CONTINENT_WHITELISTS = {
  europe: [
    'BEL','BGR','CZE','GBR','FIN','FRA','DEU','ITA','LVA','LTU','NLD','POL','PRT','ROU','RUS','ESP','SWE','CHE','UKR'
  ],
  asia: [
    'ARM','BGD','CHN','GEO','HKG','IND','IDN','JPN','KAZ','MYS','SGP','KOR','THA','TUR','ARE'
  ],
  africa: ['ZAF'],
  north_america: ['USA','CAN','MEX'],
  south_america: ['BRA'],
  oceania: ['AUS']
};

// Списки стран для IPv6
const CONTINENT_WHITELISTS_IPV6 = {
  europe: ['BGR','CZE','GBR','FRA','DEU','NLD','PRT','ROU','ESP'],
  asia: ['JPN','SGP','TUR','IND'],
  africa: [],
  north_america: ['USA','CAN'],
  south_america: ['BRA'],
  oceania: ['AUS']
};

// Фиксированный порядок и подписи для Европы (только указанные 19 стран)
const EUROPE_PINNED = [
  { alpha3: 'BEL', alpha2: 'BE', name: 'Belgium' },
  { alpha3: 'BGR', alpha2: 'BG', name: 'Bulgaria' },
  { alpha3: 'CZE', alpha2: 'CZ', name: 'Czech' },
  { alpha3: 'GBR', alpha2: 'GB', name: 'England' },
  { alpha3: 'FIN', alpha2: 'FI', name: 'Finland' },
  { alpha3: 'FRA', alpha2: 'FR', name: 'France' },
  { alpha3: 'DEU', alpha2: 'DE', name: 'Germany' },
  { alpha3: 'ITA', alpha2: 'IT', name: 'Italy' },
  { alpha3: 'LVA', alpha2: 'LV', name: 'Latvia' },
  { alpha3: 'LTU', alpha2: 'LT', name: 'Lithuania' },
  { alpha3: 'NLD', alpha2: 'NL', name: 'Netherlands' },
  { alpha3: 'POL', alpha2: 'PL', name: 'Poland' },
  { alpha3: 'PRT', alpha2: 'PT', name: 'Portugal' },
  { alpha3: 'ROU', alpha2: 'RO', name: 'Romania' },
  { alpha3: 'RUS', alpha2: 'RU', name: 'Russia' },
  { alpha3: 'ESP', alpha2: 'ES', name: 'Spain' },
  { alpha3: 'SWE', alpha2: 'SE', name: 'Sweden' },
  { alpha3: 'CHE', alpha2: 'CH', name: 'Switzerland' },
  { alpha3: 'UKR', alpha2: 'UA', name: 'Ukraine' }
];

// Порядок и подписи для Азии
const ASIA_PINNED = [
  { alpha3: 'ARM', alpha2: 'AM', name: 'Armenia' },
  { alpha3: 'BGD', alpha2: 'BD', name: 'Bangladesh' },
  { alpha3: 'CHN', alpha2: 'CN', name: 'China' },
  { alpha3: 'GEO', alpha2: 'GE', name: 'Georgia' },
  { alpha3: 'HKG', alpha2: 'HK', name: 'Hong Kong' },
  { alpha3: 'IND', alpha2: 'IN', name: 'India' },
  { alpha3: 'IDN', alpha2: 'ID', name: 'Indonesia' },
  { alpha3: 'JPN', alpha2: 'JP', name: 'Japan' },
  { alpha3: 'KAZ', alpha2: 'KZ', name: 'Kazakhstan' },
  { alpha3: 'MYS', alpha2: 'MY', name: 'Malaysia' },
  { alpha3: 'SGP', alpha2: 'SG', name: 'Singapore' },
  { alpha3: 'KOR', alpha2: 'KR', name: 'South Korea' },
  { alpha3: 'THA', alpha2: 'TH', name: 'Thailand' },
  { alpha3: 'TUR', alpha2: 'TR', name: 'Turkey' },
  { alpha3: 'ARE', alpha2: 'AE', name: 'UAE' }
];

// Порядок для остальных континентов
const AFRICA_PINNED = [
  { alpha3: 'ZAF', alpha2: 'ZA', name: 'South Africa' }
];

const NORTH_AMERICA_PINNED = [
  { alpha3: 'USA', alpha2: 'US', name: 'USA' },
  { alpha3: 'CAN', alpha2: 'CA', name: 'Canada' },
  { alpha3: 'MEX', alpha2: 'MX', name: 'Mexico' }
];

const SOUTH_AMERICA_PINNED = [
  { alpha3: 'BRA', alpha2: 'BR', name: 'Brazil' }
];

const OCEANIA_PINNED = [
  { alpha3: 'AUS', alpha2: 'AU', name: 'Australia' }
];

// Списки стран для IPv6
const EUROPE_PINNED_IPV6 = [
  { alpha3: 'BGR', alpha2: 'BG', name: 'Bulgaria' },
  { alpha3: 'CZE', alpha2: 'CZ', name: 'Czech' },
  { alpha3: 'GBR', alpha2: 'GB', name: 'England' },
  { alpha3: 'FRA', alpha2: 'FR', name: 'France' },
  { alpha3: 'DEU', alpha2: 'DE', name: 'Germany' },
  { alpha3: 'NLD', alpha2: 'NL', name: 'Netherlands' },
  { alpha3: 'PRT', alpha2: 'PT', name: 'Portugal' },
  { alpha3: 'ROU', alpha2: 'RO', name: 'Romania' },
  { alpha3: 'ESP', alpha2: 'ES', name: 'Spain' }
];

const ASIA_PINNED_IPV6 = [
  { alpha3: 'JPN', alpha2: 'JP', name: 'Japan' },
  { alpha3: 'SGP', alpha2: 'SG', name: 'Singapore' },
  { alpha3: 'TUR', alpha2: 'TR', name: 'Turkey' },
  { alpha3: 'IND', alpha2: 'IN', name: 'India' }
];

const NORTH_AMERICA_PINNED_IPV6 = [
  { alpha3: 'USA', alpha2: 'US', name: 'USA' },
  { alpha3: 'CAN', alpha2: 'CA', name: 'Canada' }
];

const SOUTH_AMERICA_PINNED_IPV6 = [
  { alpha3: 'BRA', alpha2: 'BR', name: 'Brazil' }
];

const OCEANIA_PINNED_IPV6 = [
  { alpha3: 'AUS', alpha2: 'AU', name: 'Australia' }
];

function toFlagEmoji(alpha2 = '') {
  if (!alpha2 || alpha2.length !== 2) return '';
  const base = 127397;
  return String.fromCodePoint(
    alpha2.toUpperCase().charCodeAt(0) + base,
    alpha2.toUpperCase().charCodeAt(1) + base
  );
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

async function safeAnswerCb(ctx) {
  try {
    await ctx.answerCbQuery();
  } catch (e) {
    // Игнорируем 400 (query is too old) и прочие ошибки подтверждения
  }
}

/**
 * Запускает автоматическую проверку статуса платежа
 */
function startPaymentCheck(invoiceId, amount, userId, chatId, messageId) {
  // Останавливаем предыдущую проверку, если она существует
  if (activePaymentChecks[userId]) {
    clearInterval(activePaymentChecks[userId]);
  }
  let checkCount = 0;
  const maxChecks = 180; // 15 минут * 60 секунд / 5 секунд = 180 проверок

  const checkInterval = setInterval(async () => {
    checkCount++;
    
    try {
      const invoiceStatus = await checkInvoiceStatus(invoiceId);
      
      if (!invoiceStatus) {
        // Если не удалось получить статус, продолжаем проверку
        if (checkCount >= maxChecks) {
          clearInterval(checkInterval);
          delete activePaymentChecks[userId];
        }
        return;
      }

      // Если платеж оплачен
      if (invoiceStatus.status === 'paid') {
        clearInterval(checkInterval);
        delete activePaymentChecks[userId];

        // Проверяем наличие pool
        if (!pool) {
          console.error('❌ pool не инициализирован, не могу обновить баланс');
          await bot.telegram.editMessageText(
            chatId,
            messageId,
            null,
            '❌ Ошибка базы данных. Обратитесь в поддержку.',
            { parse_mode: 'HTML' }
          );
          return;
        }

        // Добавляем деньги на баланс в базе данных
        try {
          // Проверяем, есть ли пользователь в базе
          let user = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
          
          if (user.rows.length === 0) {
            // Создаём нового пользователя
            await pool.query(
              'INSERT INTO users (telegram_id, username) VALUES ($1, $2)',
              [userId, null]
            );
            console.log(`✅ Создан новый пользователь: ${userId}`);
          }

          // Обновляем баланс
          await pool.query(
            'UPDATE users SET balance = balance + $1 WHERE telegram_id = $2',
            [amount, userId]
          );

          // Получаем обновлённый баланс
          const balanceRes = await pool.query('SELECT balance FROM users WHERE telegram_id = $1', [userId]);
          const newBalance = parseFloat(balanceRes.rows[0].balance || 0);
          
          const amountFormatted = amount.toFixed(2);
          const balanceFormatted = newBalance.toFixed(2);
          
          console.log(`💰 Баланс пополнен: пользователь ${userId}, сумма $${amount}, новый баланс $${newBalance}`);

          // Обновляем сообщение
          const successMessage = `<b>✅ Счёт успешно оплачен. Средства зачислены на ваш баланс.</b>\n\n├ Платёжная система: <b>CryptoBot</b>\n├ ID: #CB${invoiceId}\n├ Сумма: <b>$${amountFormatted}</b>\n╰ Баланс: <b>$${balanceFormatted}</b>`;
          
          try {
            await bot.telegram.editMessageText(
              chatId,
              messageId,
              null,
              successMessage,
              { parse_mode: 'HTML' }
            );
          } catch (err) {
            // Если не удалось обновить сообщение, отправляем новое
            if (!err.message?.includes('message is not modified')) {
              try {
                await bot.telegram.sendMessage(
                  chatId,
                  successMessage,
                  { parse_mode: 'HTML' }
                );
              } catch (sendErr) {
                console.error('❌ Ошибка отправки сообщения о пополнении:', sendErr.message);
              }
            }
          }
        } catch (dbErr) {
          console.error('❌ Ошибка при обновлении баланса в БД:', dbErr.message);
          console.error('   Stack:', dbErr.stack);
          try {
            await bot.telegram.editMessageText(
              chatId,
              messageId,
              null,
              '❌ Ошибка при зачислении средств. Обратитесь в поддержку.',
              { parse_mode: 'HTML' }
            );
          } catch (msgErr) {
            console.error('❌ Ошибка отправки сообщения об ошибке:', msgErr.message);
          }
          return;
        }

        // Очищаем данные о пополнении из сессии
        const session = userSessions[userId];
        if (session) {
          delete session.depositAmount;
          delete session.depositPayload;
          delete session.invoiceId;
          delete session.invoiceMessageId;
          delete session.invoiceChatId;
        }
      } else if (invoiceStatus.status === 'expired' || checkCount >= maxChecks) {
        // Если платеж истек или прошло 15 минут
        clearInterval(checkInterval);
        delete activePaymentChecks[userId];

        try {
          await bot.telegram.editMessageText(
            chatId,
            messageId,
            null,
            `⏰ Счёт истёк.\n\nСоздайте новый счёт для пополнения баланса.`
          );
        } catch (err) {
          // Игнорируем ошибки редактирования
        }

        // Очищаем данные
        const session = userSessions[userId];
        if (session) {
          delete session.depositAmount;
          delete session.depositPayload;
          delete session.invoiceId;
          delete session.invoiceMessageId;
          delete session.invoiceChatId;
        }
      }
    } catch (err) {
      console.error('❌ Ошибка при проверке платежа:', err.message);
      
      // Если произошла ошибка и прошло слишком много времени, останавливаем проверку
      if (checkCount >= maxChecks) {
        clearInterval(checkInterval);
        delete activePaymentChecks[userId];
      }
    }
  }, 5000); // Проверяем каждые 5 секунд

  activePaymentChecks[userId] = checkInterval;
}

/**
 * Останавливает проверку платежа для пользователя
 */
function stopPaymentCheck(userId) {
  if (activePaymentChecks[userId]) {
    clearInterval(activePaymentChecks[userId]);
    delete activePaymentChecks[userId];
  }
}

async function getCountriesForType(type) {
  const refType = type === 'private_ipv6' ? 'ipv6' : 'ipv4';
  if (countryCache[refType]) return countryCache[refType];

  // 1) Пытаемся получить список стран из Proxy-Seller API
  let normalized = [];
  try {
    const { loadReferenceList } = require('./proxySellerApi');
    const refs = await loadReferenceList(refType);
    const countries = Array.isArray(refs?.country) ? refs.country : [];
    const seen = new Set();
    normalized = countries
      .filter(c => c && (c.name || c.alpha3 || c.alpha2))
      .map(c => ({
        id: c.id || c.value || c.alpha3 || '',
        alpha3: (c.alpha3 || c.code3 || c.alpha_3 || '').toUpperCase(),
        alpha2: (c.alpha2 || c.code2 || c.alpha_2 || c.iso2 || '').toUpperCase(),
        name: c.name || c.country || c.title || c.alpha3 || '',
      }))
      .filter(c => {
        const key = c.alpha3 || c.name.toUpperCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  } catch (_) {
    // игнорируем, перейдём к локальному бэкапу
  }

  // 2) Если API не дал стран — используем наши закреплённые списки
  if (normalized.length === 0) {
    // Для IPv6 используем специальные списки, для остальных - обычные
    let lists;
    if (type === 'private_ipv6') {
      lists = [EUROPE_PINNED_IPV6, ASIA_PINNED_IPV6, NORTH_AMERICA_PINNED_IPV6, SOUTH_AMERICA_PINNED_IPV6, OCEANIA_PINNED_IPV6];
    } else {
      lists = [EUROPE_PINNED, ASIA_PINNED, AFRICA_PINNED, NORTH_AMERICA_PINNED, SOUTH_AMERICA_PINNED, OCEANIA_PINNED];
    }
    const merged = [].concat(...lists);
    const seen = new Set();
    normalized = merged
      .filter(c => {
        const key = String(c.alpha3).toUpperCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(c => ({ id: c.alpha3, alpha3: c.alpha3, alpha2: c.alpha2 || '', name: c.name }));
  }

  countryCache[refType] = normalized;
  return normalized;
}

function normalizeContinentName(value) {
  const v = (value || '').toString().trim().toLowerCase();
  if (!v) return '';
  if (v.includes('europe')) return 'europe';
  if (v.includes('asia') || v.includes('middle east')) return 'asia';
  if (v.includes('africa')) return 'africa';
  if (v.includes('north america')) return 'north_america';
  if (v.includes('south america')) return 'south_america';
  if (v.includes('oceania') || v.includes('australia')) return 'oceania';
  return '';
}

// минимальная карта для частых стран (alpha2 -> континент)
const ALPHA2_TO_CONTINENT = {
  RU: 'europe', UA: 'europe', BY: 'europe', KZ: 'asia', UZ: 'asia',
  DE: 'europe', NL: 'europe', BE: 'europe', FR: 'europe', IT: 'europe', ES: 'europe', PT: 'europe', PL: 'europe', CZ: 'europe', RO: 'europe', BG: 'europe', GR: 'europe', HU: 'europe', AT: 'europe', SK: 'europe', CH: 'europe', SE: 'europe', NO: 'europe', FI: 'europe', DK: 'europe', EE: 'europe', LV: 'europe', LT: 'europe', IE: 'europe', GB: 'europe', IS: 'europe', TR: 'asia', AZ: 'asia', AM: 'asia', GE: 'asia',
  US: 'north_america', CA: 'north_america', MX: 'north_america',
  BR: 'south_america', AR: 'south_america', CL: 'south_america', CO: 'south_america', PE: 'south_america', EC: 'south_america', UY: 'south_america', PY: 'south_america', VE: 'south_america',
  AU: 'oceania', NZ: 'oceania',
  JP: 'asia', KR: 'asia', CN: 'asia', HK: 'asia', MO: 'asia', TW: 'asia', SG: 'asia', TH: 'asia', VN: 'asia', MY: 'asia', PH: 'asia', ID: 'asia', IN: 'asia', PK: 'asia', BD: 'asia', SA: 'asia', AE: 'asia', IL: 'asia', QA: 'asia', KW: 'asia', OM: 'asia',
  EG: 'africa', TN: 'africa', MA: 'africa', DZ: 'africa', ZA: 'africa', KE: 'africa', NG: 'africa', GH: 'africa', TZ: 'africa', UG: 'africa'
};

function resolveCountryContinent(c) {
  const fromRef = normalizeContinentName(c.continent);
  if (fromRef) return fromRef;
  const key = (c.alpha2 || '').toUpperCase();
  return ALPHA2_TO_CONTINENT[key] || 'europe';
}

function buildContinentMenu(type) {
  const rows = [
    [
      Markup.button.callback('Europe', `continent_${type}_europe`),
      Markup.button.callback('Asia', `continent_${type}_asia`),
      Markup.button.callback('Africa', `continent_${type}_africa`)
    ],
    [
      Markup.button.callback('North America', `continent_${type}_north_america`),
      Markup.button.callback('South America', `continent_${type}_south_america`),
      Markup.button.callback('Australia', `continent_${type}_oceania`)
    ],
    [
      Markup.button.callback('< Назад', 'back_to_types')
    ]
  ];
  return Markup.inlineKeyboard(rows);
}

async function buildCountryKeyboard(type, page = 0, continentKey = null) {
  const list = await getCountriesForType(type);
  let filtered = list;
  if (continentKey) {
    const isIPv6 = type === 'private_ipv6';
    const wl = (isIPv6 ? CONTINENT_WHITELISTS_IPV6 : CONTINENT_WHITELISTS)[continentKey] || [];
    if (wl.length > 0) {
      filtered = list.filter(c => wl.includes((c.alpha3 || '').toUpperCase()) || /england/i.test(c.name || ''));
    } else {
      filtered = list.filter(c => resolveCountryContinent(c) === continentKey);
    }
  }

  // Определяем, какие списки использовать в зависимости от типа прокси
  const isIPv6 = type === 'private_ipv6';
  const EUROPE_LIST = isIPv6 ? EUROPE_PINNED_IPV6 : EUROPE_PINNED;
  const ASIA_LIST = isIPv6 ? ASIA_PINNED_IPV6 : ASIA_PINNED;
  const NORTH_AMERICA_LIST = isIPv6 ? NORTH_AMERICA_PINNED_IPV6 : NORTH_AMERICA_PINNED;
  const SOUTH_AMERICA_LIST = isIPv6 ? SOUTH_AMERICA_PINNED_IPV6 : SOUTH_AMERICA_PINNED;
  const OCEANIA_LIST = isIPv6 ? OCEANIA_PINNED_IPV6 : OCEANIA_PINNED;

  // Для Европы вставляем закреплённые страны в указанном порядке в начало
  if (continentKey === 'europe') {
    const byAlpha3 = new Map(filtered.map(c => [String(c.alpha3).toUpperCase(), c]));
    const pinnedNormalized = EUROPE_LIST.map(p => {
      const found = byAlpha3.get(p.alpha3) || {};
      return {
        ...found,
        id: found.id ?? p.alpha3,
        alpha3: p.alpha3,
        alpha2: p.alpha2 || found.alpha2 || '',
        name: p.name
      };
    });
    const pinnedSet = new Set(EUROPE_LIST.map(p => p.alpha3));
    const rest = filtered.filter(c => !pinnedSet.has(String(c.alpha3).toUpperCase()));
    filtered = [...pinnedNormalized, ...rest];
  }

  // Для Азии — закреплённые страны
  if (continentKey === 'asia') {
    const byAlpha3 = new Map(filtered.map(c => [String(c.alpha3).toUpperCase(), c]));
    const pinnedNormalized = ASIA_LIST.map(p => {
      const found = byAlpha3.get(p.alpha3) || {};
      return {
        ...found,
        id: found.id ?? p.alpha3,
        alpha3: p.alpha3,
        alpha2: p.alpha2 || found.alpha2 || '',
        name: p.name
      };
    });
    const pinnedSet = new Set(ASIA_LIST.map(p => p.alpha3));
    const rest = filtered.filter(c => !pinnedSet.has(String(c.alpha3).toUpperCase()));
    filtered = [...pinnedNormalized, ...rest];
  }

  // Африка — закреплённый порядок (только для IPv4)
  if (continentKey === 'africa' && !isIPv6) {
    const byAlpha3 = new Map(filtered.map(c => [String(c.alpha3).toUpperCase(), c]));
    const pinnedNormalized = AFRICA_PINNED.map(p => {
      const found = byAlpha3.get(p.alpha3) || {};
      return {
        ...found,
        id: found.id ?? p.alpha3,
        alpha3: p.alpha3,
        alpha2: p.alpha2 || found.alpha2 || '',
        name: p.name
      };
    });
    const pinnedSet = new Set(AFRICA_PINNED.map(p => p.alpha3));
    const rest = filtered.filter(c => !pinnedSet.has(String(c.alpha3).toUpperCase()));
    filtered = [...pinnedNormalized, ...rest];
  }

  // Северная Америка — закреплённый порядок
  if (continentKey === 'north_america') {
    const byAlpha3 = new Map(filtered.map(c => [String(c.alpha3).toUpperCase(), c]));
    const pinnedNormalized = NORTH_AMERICA_LIST.map(p => {
      const found = byAlpha3.get(p.alpha3) || {};
      return {
        ...found,
        id: found.id ?? p.alpha3,
        alpha3: p.alpha3,
        alpha2: p.alpha2 || found.alpha2 || '',
        name: p.name
      };
    });
    const pinnedSet = new Set(NORTH_AMERICA_LIST.map(p => p.alpha3));
    const rest = filtered.filter(c => !pinnedSet.has(String(c.alpha3).toUpperCase()));
    filtered = [...pinnedNormalized, ...rest];
  }

  // Южная Америка — закреплённый порядок
  if (continentKey === 'south_america') {
    const byAlpha3 = new Map(filtered.map(c => [String(c.alpha3).toUpperCase(), c]));
    const pinnedNormalized = SOUTH_AMERICA_LIST.map(p => {
      const found = byAlpha3.get(p.alpha3) || {};
      return {
        ...found,
        id: found.id ?? p.alpha3,
        alpha3: p.alpha3,
        alpha2: p.alpha2 || found.alpha2 || '',
        name: p.name
      };
    });
    const pinnedSet = new Set(SOUTH_AMERICA_LIST.map(p => p.alpha3));
    const rest = filtered.filter(c => !pinnedSet.has(String(c.alpha3).toUpperCase()));
    filtered = [...pinnedNormalized, ...rest];
  }

  // Австралия и Океания — закреплённый порядок
  if (continentKey === 'oceania') {
    const byAlpha3 = new Map(filtered.map(c => [String(c.alpha3).toUpperCase(), c]));
    const pinnedNormalized = OCEANIA_LIST.map(p => {
      const found = byAlpha3.get(p.alpha3) || {};
      return {
        ...found,
        id: found.id ?? p.alpha3,
        alpha3: p.alpha3,
        alpha2: p.alpha2 || found.alpha2 || '',
        name: p.name
      };
    });
    const pinnedSet = new Set(OCEANIA_LIST.map(p => p.alpha3));
    const rest = filtered.filter(c => !pinnedSet.has(String(c.alpha3).toUpperCase()));
    filtered = [...pinnedNormalized, ...rest];
  }
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);

  const rows = [];
  // создаём по COLUMNS в строке
  const btns = slice.map(c => {
    const flag = toFlagEmoji(c.alpha2);
    const text = `${flag ? flag + ' ' : ''}${c.name}`.trim();
    const cont = continentKey ? continentKey : 'all';
    return Markup.button.callback(text, `country_${type}_${cont}_${c.alpha3}`);
  });
  chunk(btns, COLUMNS).forEach(r => rows.push(r));

  // панель управления: сначала пагинация, ниже — назад
  const hasPrev = safePage > 0;
  const hasNext = safePage < totalPages - 1;
  const pagePrefix = continentKey ? `page_${type}_${continentKey}_` : `page_${type}_`;
  const prevCb = hasPrev ? `${pagePrefix}${safePage - 1}` : 'noop';
  const nextCb = hasNext ? `${pagePrefix}${safePage + 1}` : 'noop';
  rows.push([
    Markup.button.callback('<', prevCb),
    Markup.button.callback(`${safePage + 1} / ${totalPages}`, 'noop'),
    Markup.button.callback('>', nextCb)
  ]);

  const backAction = continentKey ? `back_to_continents_${type}` : 'back_to_types';
  rows.push([Markup.button.callback('< Назад', backAction)]);

  return Markup.inlineKeyboard(rows);
}

function formatTypeLabel(type) {
  if (type === 'private_ipv4') return 'Приватный (IPv4)';
  if (type === 'shared_ipv4') return 'Общий (IPv4)';
  return 'Приватный (IPv6)';
}

function formatPeriodLabel(days) {
  const d = Number(days) || 0;
  switch (d) {
    case 0: return '<b>x</b>';
    case 7: return '1 неделя';
    case 14: return '2 недели';
    case 30: return '1 месяц';
    case 60: return '2 месяца';
    case 90: return '3 месяца';
    case 180: return '6 месяцев';
    default: return `${d} дней`;
  }
}

// Функция для форматирования даты в МСК (Московское время)
function formatDateToMoscow(dateString) {
  if (!dateString) return 'x';
  try {
    // Парсим дату в формате d.m.Y H:i:s
    const parts = dateString.split(' ');
    if (parts.length < 2) return 'x';
    
    const datePart = parts[0].split('.');
    const timePart = parts[1].split(':');
    
    if (datePart.length !== 3 || timePart.length < 2) return 'x';
    
    const day = parseInt(datePart[0], 10);
    const month = parseInt(datePart[1], 10) - 1; // месяцы в JS начинаются с 0
    const year = parseInt(datePart[2], 10);
    const hours = parseInt(timePart[0], 10);
    const minutes = parseInt(timePart[1], 10);
    const seconds = timePart[2] ? parseInt(timePart[2], 10) : 0;
    
    // Проверяем валидность даты
    if (isNaN(day) || isNaN(month) || isNaN(year) || isNaN(hours) || isNaN(minutes)) {
      return 'x';
    }
    
    // Создаем дату в UTC и конвертируем в МСК (UTC+3)
    const date = new Date(Date.UTC(year, month, day, hours, minutes, seconds));
    // МСК = UTC+3
    const mskOffset = 3 * 60 * 60 * 1000; // 3 часа в миллисекундах
    const mskDate = new Date(date.getTime() + mskOffset);
    
    // Проверяем, что дата валидна
    if (isNaN(mskDate.getTime())) {
      return 'x';
    }
    
    // Форматируем в формат dd.mm.yyyy HH:mm МСК
    const dayStr = String(mskDate.getUTCDate()).padStart(2, '0');
    const monthStr = String(mskDate.getUTCMonth() + 1).padStart(2, '0');
    const yearStr = mskDate.getUTCFullYear();
    const hoursStr = String(mskDate.getUTCHours()).padStart(2, '0');
    const minutesStr = String(mskDate.getUTCMinutes()).padStart(2, '0');
    
    return `${dayStr}.${monthStr}.${yearStr} ${hoursStr}:${minutesStr} МСК`;
  } catch (e) {
    // Если не удалось распарсить, возвращаем x
    return 'x';
  }
}

// Функция для получения названия страны по alpha2/alpha3
async function getCountryName(countryCode, proxyType = 'ipv4') {
  if (!countryCode) return 'x';
  
  // Определяем codeUpper до try блока, чтобы использовать в fallback
  const codeUpper = String(countryCode).toUpperCase();
  
  try {
    const { loadReferenceList } = require('./proxySellerApi');
    const refs = await loadReferenceList(proxyType);
    const countries = Array.isArray(refs?.country) ? refs.country : [];
    
    const country = countries.find(c => 
      String(c.alpha2 || c.code2 || c.alpha_2 || '').toUpperCase() === codeUpper ||
      String(c.alpha3 || c.code3 || c.alpha_3 || '').toUpperCase() === codeUpper
    );
    
    if (country && country.name) {
      return country.name;
    }
  } catch (e) {
    console.warn('⚠️ Не удалось получить название страны:', e.message);
  }
  
  // Fallback на локальные данные
  try {
    const list = await getCountriesForType(proxyType === 'ipv6' ? 'private_ipv6' : 'private_ipv4');
    const country = list.find(c => 
      String(c.alpha2 || '').toUpperCase() === codeUpper ||
      String(c.alpha3 || '').toUpperCase() === codeUpper
    );
    
    return country?.name || countryCode || 'x';
  } catch (e) {
    return countryCode || 'x';
  }
}

// Функция для форматирования типа прокси для отображения
function formatProxyTypeDisplay(type) {
  if (!type) return 'x';
  const map = {
    'private_ipv4': 'Приватный (IPv4)',
    'private_ipv6': 'Приватный (IPv6)',
    'shared_ipv4': 'Общий (IPv4)',
    'ipv4': 'IPv4',
    'ipv6': 'IPv6',
    'mobile': 'Мобильный',
    'isp': 'Домашний (ISP)',
    'mix': 'Микс'
  };
  return map[type] || type || 'x';
}

// Функция для форматирования сообщения о прокси
async function formatProxyMessage(proxy, orderId, orderNumber, type, proxyType, quantity, totalPrice, finalBalance) {
  // Формируем номер заказа (BM + orderId или номер из orderNumber)
  const orderDisplay = orderNumber ? `BM${orderNumber}` : (orderId ? `BM${orderId}` : 'x');
  const proxyOrderId = proxy.order_id || orderId || 'x';
  const proxyStatus = proxy.status === 'Active' || proxy.status_type === 'ACTIVE' || proxy.status === 'active' ? 'Активный' : 'x';
  const proxyTypeDisplay = formatProxyTypeDisplay(type);
  
  let ip = proxy.ip || proxy.ip_only || 'x';
  const portHttp = proxy.port_http || '';
  const portSocks = proxy.port_socks || '';
  const login = proxy.login || 'x';
  const password = proxy.password || 'x';
  
  // Для IPv6: если в IP уже есть порт (формат ip:port), убираем его
  const isIPv6 = type === 'private_ipv6';
  if (isIPv6 && ip !== 'x' && ip.includes(':')) {
    // IPv6 адреса содержат двоеточия, но если есть формат [ipv6]:port или ip:port, проверяем
    // Если есть порт в конце (после последнего двоеточия идут только цифры), убираем его
    const lastColonIndex = ip.lastIndexOf(':');
    if (lastColonIndex > 0) {
      const afterLastColon = ip.substring(lastColonIndex + 1);
      // Если после последнего двоеточия только цифры (порт), убираем его
      if (/^\d+$/.test(afterLastColon)) {
        ip = ip.substring(0, lastColonIndex);
      }
    }
  }
  
  const countryCode = proxy.country || '';
  const countryName = await getCountryName(countryCode, proxyType);
  
  const dateStart = formatDateToMoscow(proxy.date_start || '');
  const dateEnd = formatDateToMoscow(proxy.date_end || '');
  
  let message = `<b>📦 Прокси #${orderDisplay}</b>\n`;
  message += `├ ID заказа: <code>${proxyOrderId}</code>\n`;
  message += `├ Статус: ${proxyStatus}\n`;
  message += `╰ Тип: ${proxyTypeDisplay}\n\n`;
  
  message += `<b>🔑 Подключение</b>\n`;
  if (portHttp) {
    message += `├ HTTP: <code>${ip}:${portHttp}</code>\n`;
  } else {
    message += `├ HTTP: x\n`;
  }
  if (portSocks) {
    message += `├ SOCKS5: <code>${ip}:${portSocks}</code>\n`;
  } else {
    // Если нет SOCKS5, но есть общий порт
    const port = proxy.port || '';
    if (port && !portHttp) {
      message += `├ SOCKS5: <code>${ip}:${port}</code>\n`;
    } else if (!portHttp) {
      message += `├ SOCKS5: x\n`;
    }
  }
  message += `├ Логин: <code>${login}</code>\n`;
  message += `╰ Пароль: <code>${password}</code>\n\n`;
  
  message += `<b>🌍 Локация</b>\n`;
  message += `├ Страна: ${countryName}\n`;
  message += `╰ Город: Случайный город\n\n`;
  
  message += `<b>⏳ Срок действия</b>\n`;
  message += `├ Начало: ${dateStart}\n`;
  message += `╰ Завершение: ${dateEnd}\n\n`;
  
  message += `<b>├ С вашего баланса списано: $${totalPrice.toFixed(2)}</b>\n`;
  message += `<b>╰ Остаток на балансе: $${finalBalance.toFixed(2)}</b>`;
  
  return message;
}

function buildPeriodKeyboard(type, continent, alpha3) {
  const periodOptions = [
    { label: '1 неделя', days: 7 },
    { label: '2 недели', days: 14 },
    { label: '1 месяц', days: 30 },
    { label: '2 месяца', days: 60 },
    { label: '3 месяца', days: 90 },
    { label: '6 месяцев', days: 180 }
  ];
  const buttons = periodOptions.map(p => Markup.button.callback(p.label, `period_${type}_${continent}_${alpha3}_${p.days}`));
  const rows = chunk(buttons, 3);
  rows.push([Markup.button.callback('< Назад', `back_to_countries_${type}_${continent}`)]);
  return Markup.inlineKeyboard(rows);
}

function getDisplayCountry(type, continent, alpha3, list) {
  const countries = list || [];
  let country = countries.find(c => String(c.alpha3).toUpperCase() === alpha3) || { alpha3, alpha2: '', name: alpha3 };
  const isIPv6 = type === 'private_ipv6';
  const PINNED_BY_CONT = {
    europe: isIPv6 ? EUROPE_PINNED_IPV6 : EUROPE_PINNED,
    asia: isIPv6 ? ASIA_PINNED_IPV6 : ASIA_PINNED,
    africa: isIPv6 ? [] : AFRICA_PINNED,
    north_america: isIPv6 ? NORTH_AMERICA_PINNED_IPV6 : NORTH_AMERICA_PINNED,
    south_america: isIPv6 ? SOUTH_AMERICA_PINNED_IPV6 : SOUTH_AMERICA_PINNED,
    oceania: isIPv6 ? OCEANIA_PINNED_IPV6 : OCEANIA_PINNED
  };
  const overrideArr = PINNED_BY_CONT[continent] || [];
  const override = overrideArr.find(p => p.alpha3 === alpha3);
  if (override) {
    country = { ...country, name: override.name, alpha2: override.alpha2 };
  }
  return country;
}

// Команда /start
bot.start(async (ctx) => {
  try {
    await ctx.replyWithHTML(
      '<b>👋 Добро пожаловать в Capitan MARKET.</b>\n╰ Приятных покупок',
    mainMenu
  );
  } catch (err) {
    // Игнорируем ошибки, если пользователь заблокировал бота
    if (err.message && err.message.includes('bot was blocked')) {
      console.log(`⚠️ Пользователь ${ctx.from?.id} заблокировал бота`);
      return;
    }
    console.error('❌ Ошибка при отправке приветствия:', err.message);
  }
});

// Кнопка "Купить прокси"
bot.hears('🛒 Купить прокси', async (ctx) => {
  try {
    const { text, kb } = buildBuyEntryMenu();
    await ctx.replyWithHTML(text, kb);
  } catch (err) {
    if (err.message && err.message.includes('bot was blocked')) {
      console.log(`⚠️ Пользователь ${ctx.from?.id} заблокировал бота`);
      return;
    }
    console.error('❌ Ошибка при отправке меню:', err.message);
  }
});

// Быстрый вход: сразу к выбору континента для приватных IPv4
bot.action('quick_buy', async (ctx) => {
  await safeAnswerCb(ctx);
  const keyboard = buildContinentMenu('private_ipv4');
  await ctx.editMessageText('🌏 Выберите континент', keyboard);
});

// Ручной выбор IP-типа (показываем только приватные IPv4)
bot.action('choose_ip', async (ctx) => {
  await safeAnswerCb(ctx);
  await ctx.editMessageText('Выберите категорию IP:', ipCategoryMenu);
});

// Обработка выбора категории IP → сохраняем и переходим к континентам
bot.action(/^ip_category_(MOB|ISP_MOB|ISP|DCH)$/, async (ctx) => {
  await safeAnswerCb(ctx);
  const [, category] = ctx.match;
  ctx.session = ctx.session || {};
  ctx.session.ipCategory = category; // MOB, ISP_MOB, ISP, DCH
  const keyboard = buildContinentMenu('private_ipv4');
  await ctx.editMessageText('🌏 Выберите континент', keyboard);
});

// Назад к начальному меню покупки
bot.action('back_to_buy_menu', async (ctx) => {
  await safeAnswerCb(ctx);
  const { text, kb } = buildBuyEntryMenu();
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb.reply_markup });
});

// === Обработка покупки прокси ===

bot.action('proxy_private_ipv4', async (ctx) => {
  await safeAnswerCb(ctx);
  const keyboard = buildContinentMenu('private_ipv4');
  await ctx.editMessageText('🌏 Выберите континент', keyboard);
});

bot.action('proxy_shared_ipv4', async (ctx) => {
  await safeAnswerCb(ctx);
  const keyboard = buildContinentMenu('shared_ipv4');
  await ctx.editMessageText('🌏 Выберите континент', keyboard);
});

bot.action('proxy_private_ipv6', async (ctx) => {
  await safeAnswerCb(ctx);
  const keyboard = buildContinentMenu('private_ipv6');
  await ctx.editMessageText('🌏 Выберите континент', keyboard);
});

// выбор континента -> список стран
bot.action(/^continent_(private_ipv4|shared_ipv4|private_ipv6)_(europe|asia|africa|north_america|south_america|oceania)$/,
  async (ctx) => {
    await safeAnswerCb(ctx);
    try {
      const [, type, cont] = ctx.match;
      const keyboard = await buildCountryKeyboard(type, 0, cont);
      await ctx.editMessageText('🌍 Выберите страну:', keyboard);
    } catch (err) {
      // Игнорируем ошибку "message is not modified" - это не критично
      if (err.message && err.message.includes('message is not modified')) {
        return; // Сообщение уже в правильном состоянии
      }
      console.error('❌ Ошибка при загрузке стран:', err);
      try {
        await ctx.editMessageText(`❌ Ошибка загрузки списка стран:\n${err.message}\n\nПопробуйте позже или обратитесь в поддержку.`);
      } catch (_) {
        // Игнорируем ошибки отправки сообщения
      }
    }
  }
);

// назад к выбору континента
bot.action(/^back_to_continents_(private_ipv4|shared_ipv4|private_ipv6)$/, async (ctx) => {
  await safeAnswerCb(ctx);
  const [, type] = ctx.match;
  const keyboard = buildContinentMenu(type);
  await ctx.editMessageText('🌏 Выберите континент', keyboard);
});

// пагинация стран
// пагинация без и с континентом
bot.action(/^(page)_(private_ipv4|shared_ipv4|private_ipv6)_(\d+)$/, async (ctx) => {
  await safeAnswerCb(ctx);
  const [, , type, pageStr] = ctx.match;
  const page = parseInt(pageStr, 10) || 0;
  const keyboard = await buildCountryKeyboard(type, page);
  await ctx.editMessageReplyMarkup(keyboard.reply_markup);
});

bot.action(/^(page)_(private_ipv4|shared_ipv4|private_ipv6)_(europe|asia|africa|north_america|south_america|oceania)_(\d+)$/, async (ctx) => {
  await safeAnswerCb(ctx);
  const [, , type, cont, pageStr] = ctx.match;
  const page = parseInt(pageStr, 10) || 0;
  const keyboard = await buildCountryKeyboard(type, page, cont);
  await ctx.editMessageReplyMarkup(keyboard.reply_markup);
});

// игнорируемая кнопка-индикатор
bot.action('noop', (ctx) => safeAnswerCb(ctx));

// назад к типам
bot.action('back_to_types', async (ctx) => {
  await safeAnswerCb(ctx);
  const { text, kb } = buildBuyEntryMenu();
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb.reply_markup });
});

// покупка после выбора страны
// выбор страны -> экран выбора периода
bot.action(/^country_(private_ipv4|shared_ipv4|private_ipv6)_(europe|asia|africa|north_america|south_america|oceania|all)_([A-Z]{3})$/, async (ctx) => {
  await safeAnswerCb(ctx);
  try {
    const [, type, continent, alpha3] = ctx.match;
    // найти страну для отображения
    const list = await getCountriesForType(type);
    let country = list.find(c => String(c.alpha3).toUpperCase() === alpha3) || { alpha3, alpha2: '', name: alpha3 };

    // переопределяем из закреплённых, чтобы имена/флаги совпадали
    const isIPv6 = type === 'private_ipv6';
    const PINNED_BY_CONT = {
      europe: isIPv6 ? EUROPE_PINNED_IPV6 : EUROPE_PINNED,
      asia: isIPv6 ? ASIA_PINNED_IPV6 : ASIA_PINNED,
      africa: isIPv6 ? [] : AFRICA_PINNED,
      north_america: isIPv6 ? NORTH_AMERICA_PINNED_IPV6 : NORTH_AMERICA_PINNED,
      south_america: isIPv6 ? SOUTH_AMERICA_PINNED_IPV6 : SOUTH_AMERICA_PINNED,
      oceania: isIPv6 ? OCEANIA_PINNED_IPV6 : OCEANIA_PINNED
    };
    const overrideArr = PINNED_BY_CONT[continent] || [];
    const override = overrideArr.find(p => p.alpha3 === alpha3);
    if (override) {
      country = { ...country, name: override.name, alpha2: override.alpha2 };
    }

    const typeLabel = type === 'private_ipv4' ? 'Приватный (IPv4)' : (type === 'shared_ipv4' ? 'Общий (IPv4)' : 'Приватный (IPv6)');
    const flag = toFlagEmoji(country.alpha2);
    const preview = `╰ Тип: ${typeLabel}\n\n🌍 Локация\n├ Страна: ${flag ? flag + ' ' : ''}${country.name}\n╰ Город: Случайный город`;
    const keyboard = buildPeriodKeyboard(type, continent, alpha3);
    await ctx.editMessageText(preview, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
  } catch (err) {
    try { await ctx.editMessageText(`❌ Ошибка:\n${err.message}`); } catch (_) {}
  }
});

// выбор периода -> покупка
bot.action(/^period_(private_ipv4|shared_ipv4|private_ipv6)_(europe|asia|africa|north_america|south_america|oceania|all)_([A-Z]{3})_(\d+)$/, async (ctx) => {
  await safeAnswerCb(ctx);
  const [, type, continent, alpha3, daysStr] = ctx.match;
  const periodDays = parseInt(daysStr, 10) || 7;
  // собрать превью без пустых строк
  const list = await getCountriesForType(type);
  const country = getDisplayCountry(type, continent, alpha3, list);
  const typeLabel = formatTypeLabel(type);
  const periodLabel = formatPeriodLabel(periodDays);
  const flag = toFlagEmoji(country.alpha2);
  const preview = `├ Тип: ${typeLabel}\n├ Срок аренды: ${periodLabel}\n╰ Доступно к покупке: ? шт.\n\n🌍 Локация\n├ Страна: ${flag ? flag + ' ' : ''}${country.name}\n╰ Город: Случайный город`;
  const keyboard = buildQuantityKeyboard(type, continent, alpha3, periodDays);
  await ctx.editMessageText(preview, keyboard);
});

// назад к выбору периода
bot.action(/^back_to_periods_(private_ipv4|shared_ipv4|private_ipv6)_(europe|asia|africa|north_america|south_america|oceania)_([A-Z]{3})$/, async (ctx) => {
  await safeAnswerCb(ctx);
  const [, type, continent, alpha3] = ctx.match;
  const keyboard = buildPeriodKeyboard(type, continent, alpha3);
  await ctx.editMessageText('Выберите срок аренды:', keyboard);
});

// подтверждение покупки после показа цены
bot.action(/^buy_(private_ipv4|shared_ipv4|private_ipv6)_(europe|asia|africa|north_america|south_america|oceania|all)_([A-Z]{3})_(\d+)_(\d+)$/, async (ctx) => {
  await safeAnswerCb(ctx);
  const userId = ctx.from.id;
  
  // Получаем параметры заказа из сессии
  const order = ctx.session?.order;
  if (!order) {
    await ctx.editMessageText('❌ Данные заказа утеряны. Начните заново.');
    return;
  }
  
  // Валидация параметров заказа
  const { type, country, periodDays, quantity, amount } = order;
  if (!type || !country || !periodDays || !quantity || quantity <= 0 || quantity > 100) {
    await ctx.editMessageText('❌ Некорректные параметры заказа. Начните заново.');
    return;
  }
  
  await ctx.editMessageText('⏳ Проверяю баланс и оформляю заказ...');
  
  try {
    // Используем ОГРОМНУЮ транзакцию для атомарности всей операции
    const result = await withTransaction(async (client) => {
      // 1. Валидация и расчет цены
      let totalPrice = amount || 0;
      if (totalPrice <= 0) {
        const priceInfo = await psCalculatePrice({ type, country, periodDays, quantity });
        totalPrice = priceInfo.finalUsd || priceInfo.finalPrice || 0;
        if (totalPrice <= 0) {
          throw new Error('Не удалось рассчитать цену');
        }
      }
      
      // 2. Проверяем и обновляем баланс АТОМАРНО
      const userRes = await client.query('SELECT balance FROM users WHERE telegram_id = $1 FOR UPDATE', [userId]);
      if (userRes.rows.length === 0) {
        // Создаём нового пользователя если нет
        await client.query(
          'INSERT INTO users (telegram_id, username, balance) VALUES ($1, $2, 0)',
          [userId, ctx.from.username || null]
        );
        throw new Error('Сначала пополните баланс');
      }
      
      const userBalance = parseFloat(userRes.rows[0].balance || 0);
      if (userBalance < totalPrice) {
        throw new Error(`Недостаточно средств! Баланс: $${userBalance.toFixed(2)}, требуется: $${totalPrice.toFixed(2)}`);
      }
      
      // 3. Списываем средства ВНУТРИ транзакции
      await client.query(
        'UPDATE users SET balance = balance - $1 WHERE telegram_id = $2',
        [totalPrice, userId]
      );
      console.log(`💸 Списание средств: пользователь ${userId}, сумма $${totalPrice}`);
      
      // 4. Покупаем прокси через API (НЕ откатывается автоматически, но средства вернём в catch)
      let buyResult;
      try {
        buyResult = await psBuyProxy({ type, country, periodDays, quantity });
      } catch (buyErr) {
        console.error('❌ Ошибка покупки прокси через API:', buyErr.message);
        throw new Error(`Не удалось купить прокси: ${buyErr.message}`);
      }
      
      // 5. Извлекаем данные из ответа API
      const orderInfo = buyResult?.status === 'success' && buyResult?.data ? buyResult.data : null;
      const orderId = orderInfo?.orderId || orderInfo?.order_id || null;
      
      // КРИТИЧНО: Получаем список ID купленных прокси из ответа API
      // API может вернуть массив proxy_id или items с информацией о прокси
      let boughtProxyIds = [];
      if (orderInfo) {
        // Вариант 1: массив proxy_id
        if (Array.isArray(orderInfo.proxy_id)) {
          boughtProxyIds = orderInfo.proxy_id.map(id => Number(id)).filter(id => !isNaN(id));
        } else if (orderInfo.proxy_id) {
          boughtProxyIds = [Number(orderInfo.proxy_id)].filter(id => !isNaN(id));
        }
        
        // Вариант 2: массив items с полной информацией о прокси
        if (Array.isArray(orderInfo.items) && orderInfo.items.length > 0) {
          orderInfo.items.forEach(item => {
            if (item.id) boughtProxyIds.push(Number(item.id));
          });
        }
        
        // Вариант 3: список в других полях
        if (Array.isArray(orderInfo.proxies)) {
          orderInfo.proxies.forEach(p => {
            if (p.id) boughtProxyIds.push(Number(p.id));
          });
        }
      }
      
      console.log(`📦 Ответ API покупки:`, JSON.stringify(buyResult, null, 2).slice(0, 500));
      console.log(`🎯 Купленные proxy_id:`, boughtProxyIds);
      console.log(`🎯 Order ID:`, orderId);
      
      // Определяем тип прокси для API
      const proxyType = (type === 'private_ipv6') ? 'ipv6' : 'ipv4';
      
      // 6. КРИТИЧНО: Получаем данные прокси и АТОМАРНО сохраняем с блокировкой по proxy_id
      await ctx.editMessageText('⏳ Получаю и сохраняю данные прокси...', { parse_mode: 'HTML' });
      
      let savedProxies = [];
      let attempts = 0;
      const maxAttempts = 12; // 12 попыток по 10 секунд = 2 минуты
      
      while (savedProxies.length < quantity && attempts < maxAttempts) {
        attempts++;
        
        try {
          // Получаем ВСЕ активные прокси через API
          const proxiesFromAPI = await getProxyCredentials(proxyType, 1, 10000);
          
          if (!proxiesFromAPI || proxiesFromAPI.length === 0) {
            if (attempts < maxAttempts) {
              console.log(`⏳ Попытка ${attempts}/${maxAttempts}: прокси еще не активированы, жду...`);
              await new Promise(resolve => setTimeout(resolve, 10000));
              continue;
            }
            throw new Error('API не вернул данные прокси после всех попыток');
          }
          
          console.log(`📋 Получено ${proxiesFromAPI.length} прокси от API (попытка ${attempts})`);
          
          // КРИТИЧНО: Фильтруем СТРОГО по купленным proxy_id
          let candidateProxies = [];
          
          // Приоритет 1: Если знаем конкретные ID купленных прокси - используем ТОЛЬКО их
          if (boughtProxyIds.length > 0) {
            candidateProxies = proxiesFromAPI.filter(p => {
              const pId = Number(p.id);
              return !isNaN(pId) && boughtProxyIds.includes(pId);
            });
            console.log(`🎯 Фильтрация по купленным ID: найдено ${candidateProxies.length} из ${boughtProxyIds.length}`);
          }
          // Приоритет 2: Если API не вернул proxy_id, фильтруем по orderId
          else if (orderId) {
            candidateProxies = proxiesFromAPI.filter(p => p.order_id == orderId);
            console.log(`🎯 Фильтрация по orderId=${orderId}: найдено ${candidateProxies.length}`);
          }
          // Приоритет 3: Берём последние N прокси (ОПАСНО! Может взять чужие!)
          else {
            console.warn(`⚠️ НЕТ proxy_id И orderId! Берём последние ${quantity} прокси по ID (может быть некорректно)`);
            candidateProxies = proxiesFromAPI
              .sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))
              .slice(0, quantity);
          }
          
          if (candidateProxies.length === 0 && attempts < maxAttempts) {
            console.log(`⏳ Попытка ${attempts}/${maxAttempts}: прокси для заказа еще не найдены, жду...`);
            await new Promise(resolve => setTimeout(resolve, 10000));
            continue;
          }
          
          // Добавляем страну из заказа
          const enrichedProxies = candidateProxies.map(p => ({
            ...p,
            country: p.country || order.country || ''
          }));
        
          // АТОМАРНО сохраняем прокси с БЛОКИРОВКОЙ по proxy_id
          // Важно: используем тот же client из транзакции!
          for (const p of enrichedProxies) {
            if (savedProxies.length >= quantity) break; // Уже набрали нужное количество
            
            const proxyId = p.id != null ? Number(p.id) : null;
            
            // Пропускаем прокси без ID (невозможно гарантировать уникальность)
            if (!proxyId) {
              console.warn(`⚠️ Пропускаем прокси без proxy_id`);
              continue;
            }
            
            // Проверяем, не занят ли уже этот proxy_id другим пользователем
            try {
              const checkExisting = await client.query(
                'SELECT cm_id, telegram_id FROM user_proxies WHERE proxy_id = $1',
                [proxyId]
              );
              
              if (checkExisting.rows.length > 0) {
                const existingOwner = checkExisting.rows[0].telegram_id;
                if (existingOwner !== userId) {
                  console.warn(`⚠️ Прокси ${proxyId} уже занят пользователем ${existingOwner}, пропускаем`);
                  continue; // Этот прокси уже занят другим пользователем!
                } else {
                  console.log(`✅ Прокси ${proxyId} уже сохранён для этого пользователя`);
                  continue; // Уже сохранили этот прокси ранее
                }
              }
            } catch (checkErr) {
              console.error(`❌ Ошибка проверки proxy_id ${proxyId}:`, checkErr.message);
              continue;
            }
            
            // Генерируем CM ID
            const cmId = await generateCmId();
            
            const proxyOrderId = p.order_id != null ? Number(p.order_id) : (orderId != null ? Number(orderId) : null);
            const login = p.login || null;
            const password = p.password || null;
            const ip = p.ip || p.ip_only || null;
            const port = Number(p.port_http || p.port_socks || p.port) || null;
            const portHttp = p.port_http ? Number(p.port_http) : null;
            const portSocks = p.port_socks ? Number(p.port_socks) : null;
            const countryCode = p.country || null;
            
            // Безопасный парсинг дат с проверкой валидности
            let dateStart = null;
            let dateEnd = null;
            try {
              if (p.date_start) {
                const parsedStart = new Date(p.date_start);
                dateStart = !isNaN(parsedStart.getTime()) ? parsedStart : null;
              }
              if (p.date_end) {
                const parsedEnd = new Date(p.date_end);
                dateEnd = !isNaN(parsedEnd.getTime()) ? parsedEnd : null;
              }
            } catch (dateErr) {
              console.warn(`⚠️ Ошибка парсинга дат для прокси:`, { date_start: p.date_start, date_end: p.date_end });
              dateStart = null;
              dateEnd = null;
            }
            
            if (!login || !ip) {
              console.warn(`⚠️ Пропускаем прокси ${proxyId} без логина или IP`);
              continue;
            }
            
            // Пытаемся вставить с блокировкой по proxy_id (UNIQUE constraint защитит от дубликатов)
            try {
              const insertText = `
                INSERT INTO user_proxies 
                (telegram_id, cm_id, proxy_id, order_id, type, login, password, ip, port, port_http, port_socks, country, date_start, date_end, status, purchased_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
                RETURNING id, cm_id, telegram_id, login, password, ip, port_http, port_socks, country, date_start, date_end, type
              `;
              
              const saveResult = await client.query(insertText, [
                userId, cmId, proxyId, proxyOrderId, proxyType, login, password, ip, port,
                portHttp, portSocks, countryCode, dateStart, dateEnd, 'active'
              ]);
              
              if (saveResult.rows.length > 0) {
                savedProxies.push(saveResult.rows[0]);
                console.log(`✅ Сохранён прокси ${cmId} (proxy_id: ${proxyId}) для пользователя ${userId}`);
              }
            } catch (insertErr) {
              // Если ошибка уникальности - значит другой пользователь уже занял этот прокси
              if (insertErr.message && insertErr.message.includes('duplicate key') && insertErr.message.includes('proxy_id')) {
                console.warn(`⚠️ Прокси ${proxyId} уже занят другим пользователем (race condition), пропускаем`);
                continue;
              }
              // Другие ошибки - пробрасываем
              throw insertErr;
            }
          }
          
          // Если набрали нужное количество - выходим из цикла попыток
          if (savedProxies.length >= quantity) {
            break;
          }
          
        } catch (proxyErr) {
          console.error(`❌ Ошибка получения/сохранения прокси (попытка ${attempts}):`, proxyErr.message);
          if (attempts >= maxAttempts) {
            throw new Error(`Не удалось получить данные прокси после ${maxAttempts} попыток: ${proxyErr.message}`);
          }
          // Ждём перед следующей попыткой
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      }
      
      // Проверяем, что сохранили хотя бы один прокси
      if (savedProxies.length === 0) {
        throw new Error('Не удалось сохранить ни одного прокси в БД');
      }
      
      // Если сохранили меньше, чем заказывали - это ок, главное что хоть что-то есть
      if (savedProxies.length < quantity) {
        console.warn(`⚠️ Сохранено ${savedProxies.length} из ${quantity} запрошенных прокси`);
      }
      
      // 7. Обновляем счетчик купленных прокси
      await client.query(
        'UPDATE users SET proxies_purchased = proxies_purchased + $1 WHERE telegram_id = $2',
        [savedProxies.length, userId]
      );
      
      // 8. Получаем финальный баланс
      const finalBalanceRes = await client.query('SELECT balance FROM users WHERE telegram_id = $1', [userId]);
      const finalBalance = parseFloat(finalBalanceRes.rows[0].balance || 0);
      
      return { savedProxies, totalPrice, finalBalance };
    });
    
    // Транзакция успешна! Показываем результат пользователю
    const { savedProxies, totalPrice, finalBalance } = result;
    
    console.log(`✅ Покупка завершена: пользователь ${userId}, прокси ${savedProxies.length}, сумма $${totalPrice}`);
    savedProxies.forEach(p => console.log(`   - ${p.cm_id}: ${p.ip}`));
    
    // Форматируем сообщение с данными ПЕРВОГО прокси
    const firstProxy = savedProxies[0];
    const countryName = await getCountryName(firstProxy.country, firstProxy.type || 'ipv4');
    
    let message = `<b>✅ Покупка прокси успешно завершена!</b>\n\n`;
    message += `<b>📦 Прокси #${firstProxy.cm_id}</b>\n`;
    message += `├ ID заказа: <code>${firstProxy.cm_id}</code>\n`;
    message += `├ Статус: Активный\n`;
    message += `╰ Тип: ${formatProxyTypeDisplay(firstProxy.type)}\n\n`;
    
    message += `<b>🔑 Подключение</b>\n`;
    if (firstProxy.port_http) {
      message += `├ HTTP: <code>${firstProxy.ip}:${firstProxy.port_http}</code>\n`;
    } else {
      message += `├ HTTP: x\n`;
    }
    if (firstProxy.port_socks) {
      message += `├ SOCKS5: <code>${firstProxy.ip}:${firstProxy.port_socks}</code>\n`;
    } else {
      message += `├ SOCKS5: x\n`;
    }
    message += `├ Логин: <code>${firstProxy.login}</code>\n`;
    message += `╰ Пароль: <code>${firstProxy.password}</code>\n\n`;
    
    message += `<b>🌍 Локация</b>\n`;
    message += `├ Страна: ${countryName}\n`;
    message += `╰ Город: Случайный город\n\n`;
    
    if (savedProxies.length > 1) {
      message += `<b>📊 Куплено прокси: ${savedProxies.length} шт.</b>\n`;
      message += `<i>Остальные прокси смотрите в разделе "Мои прокси"</i>\n\n`;
    }
    
    message += `<b>├ С вашего баланса списано: $${totalPrice.toFixed(2)}</b>\n`;
    message += `<b>╰ Остаток на балансе: $${finalBalance.toFixed(2)}</b>`;
    
    await ctx.editMessageText(message, { parse_mode: 'HTML' });
    
    // Очищаем сессию
    ctx.session.order = null;
    
  } catch (err) {
    console.error('❌ Критическая ошибка при покупке:', err.message);
    console.error('   Stack:', err.stack);
    
    const isTimeout = /timeout|timed out|ECONNABORTED/i.test(err.message || '');
    await ctx.editMessageText(
      isTimeout
        ? '⏳ Временная задержка магазина. Попробуйте снова через минуту.'
        : `❌ Ошибка при покупке:\n${err.message}\n\nЕсли средства были списаны, обратитесь в поддержку.`
    );
  }
});

// назад к списку стран для выбранного континента
bot.action(/^back_to_countries_(private_ipv4|shared_ipv4|private_ipv6)_(europe|asia|africa|north_america|south_america|oceania)$/, async (ctx) => {
  await safeAnswerCb(ctx);
  const [, type, continent] = ctx.match;
  const keyboard = await buildCountryKeyboard(type, 0, continent);
  await ctx.editMessageText('🌍 Выберите страну:', keyboard);
});

// выбор количества -> покупка
bot.action(/^qty_(private_ipv4|shared_ipv4|private_ipv6)_(europe|asia|africa|north_america|south_america|oceania|all)_([A-Z]{3})_(\d+)_(\d+)$/, async (ctx) => {
  await safeAnswerCb(ctx);
  const [, type, continent, alpha3, daysStr, qtyStr] = ctx.match;
  const periodDays = parseInt(daysStr, 10) || 7;
  const quantity = parseInt(qtyStr, 10) || 1;

  // получить данные страны
  const list = await getCountriesForType(type);
  let country = list.find(c => String(c.alpha3).toUpperCase() === alpha3) || { alpha3, alpha2: '', name: alpha3 };
  const isIPv6 = type === 'private_ipv6';
  const PINNED_BY_CONT = {
    europe: isIPv6 ? EUROPE_PINNED_IPV6 : EUROPE_PINNED,
    asia: isIPv6 ? ASIA_PINNED_IPV6 : ASIA_PINNED,
    africa: isIPv6 ? [] : AFRICA_PINNED,
    north_america: isIPv6 ? NORTH_AMERICA_PINNED_IPV6 : NORTH_AMERICA_PINNED,
    south_america: isIPv6 ? SOUTH_AMERICA_PINNED_IPV6 : SOUTH_AMERICA_PINNED,
    oceania: isIPv6 ? OCEANIA_PINNED_IPV6 : OCEANIA_PINNED
  };
  const overrideArr = PINNED_BY_CONT[continent] || [];
  const override = overrideArr.find(p => p.alpha3 === alpha3);
  if (override) country = { ...country, name: override.name, alpha2: override.alpha2 };

  // Показать мгновенную реакцию
  try {
    await ctx.editMessageText('⏳ Получаю актуальную цену...');
  } catch (_) {}

  // расчёт цены с наценкой 50% (через Proxy-Seller)
  let price;
  let amount = 0;
  const maxRetries = 2;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      price = await psCalculatePrice({ type, country: country.alpha3 || country.alpha2 || country.name || alpha3, periodDays, quantity });
      console.log(`💰 Рассчитанная цена (proxy-seller) для ${quantity} шт. ${country.name} (попытка ${attempt}):`, price);
      if (price && price.finalUsd && price.finalUsd > 0) {
        amount = Number(price.finalUsd);
        break; // Успешно получили цену
      } else if (price && price.finalUsd === 0 && attempt < maxRetries) {
        console.warn(`⚠️ Цена = 0, повторяю попытку ${attempt + 1}/${maxRetries}...`);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Ждём 1 секунду перед повтором
        continue;
      }
  } catch (err) {
      console.error(`❌ Ошибка расчёта цены (попытка ${attempt}):`, err.message);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Ждём 1 секунду перед повтором
        continue;
      }
      amount = 0;
    }
  }
  
  // Если цена всё ещё 0, показываем меню с 0, но логируем предупреждение
  if (amount === 0) {
    console.error(`❌ Не удалось получить цену после ${maxRetries} попыток для ${type}, ${country.name}, ${periodDays}д, ${quantity} шт.`);
  }

  // Показываем меню с информацией о заказе
  const typeLabel = formatTypeLabel(type);
  const periodDaysLabel = periodDays === 7 ? '1 неделя' : periodDays === 14 ? '2 недели' : periodDays === 30 ? '1 месяц' : periodDays === 60 ? '2 месяца' : periodDays === 90 ? '3 месяца' : periodDays === 180 ? '6 месяцев' : `${periodDays} дней`;
  const flag = toFlagEmoji(country.alpha2);

  const text = `├ Тип: <b>${typeLabel}</b>\n├ Срок аренды: <b>${periodDaysLabel}</b>\n├ Количество: <b>${quantity} шт.</b>\n╰ Стоимость: <b>$${amount.toFixed(2)}</b>\n\n🌍 Локация\n├ Страна: ${flag ? flag + ' ' : ''}<b>${country.name}</b>\n╰ Город: <b>Случайный город</b>`;

  // Сохраняем параметры заказа в сессии
  ctx.session = ctx.session || {};
  ctx.session.order = {
    type: type,
    continent: continent,
    country: country.alpha3 || country.alpha2 || country.name || alpha3,
    countryName: country.name,
    periodDays: periodDays,
    quantity: quantity,
    amount: amount
  };

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('Купить', `buy_${type}_${continent}_${alpha3}_${periodDays}_${quantity}`)],
    [Markup.button.callback('Назад', `back_to_quantities_${type}_${continent}_${alpha3}_${periodDays}`)]
  ]);

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
});

// Обработчик кнопки "Ввести свое количество" для IPv6
bot.action(/^custom_qty_(private_ipv6)_(europe|asia|africa|north_america|south_america|oceania)_([A-Z]{3})_(\d+)$/, async (ctx) => {
  await safeAnswerCb(ctx);
  const [, type, continent, alpha3, daysStr] = ctx.match;
  const periodDays = parseInt(daysStr, 10) || 7;
  
  // Сохраняем параметры в сессии для обработки пользовательского ввода
  ctx.session = ctx.session || {};
  ctx.session.awaitingCustomQuantity = {
    type: type,
    continent: continent,
    alpha3: alpha3,
    periodDays: periodDays
  };
  
  await ctx.editMessageText('Введите количество прокси (минимум 10 шт.):');
});

// назад к сетке количества
bot.action(/^back_to_quantities_(private_ipv4|shared_ipv4|private_ipv6)_(europe|asia|africa|north_america|south_america|oceania)_([A-Z]{3})_(\d+)$/, async (ctx) => {
  await safeAnswerCb(ctx);
  const [, type, continent, alpha3, daysStr] = ctx.match;
  const periodDays = parseInt(daysStr, 10) || 7;
  
  // Очищаем состояние ожидания пользовательского ввода
  if (ctx.session) {
    delete ctx.session.awaitingCustomQuantity;
  }
  
  const keyboard = buildQuantityKeyboard(type, continent, alpha3, periodDays);
  await ctx.editMessageText('Выберите количество:', keyboard);
});

function buildQuantityKeyboard(type, continent, alpha3, periodDays) {
  const isIPv6 = type === 'private_ipv6';
  
  if (isIPv6) {
    // Для IPv6: 10, 20, 30, 40, 50, 60 шт.
    const qtyValues = [10, 20, 30, 40, 50, 60];
    const qtyButtons = qtyValues.map(q => Markup.button.callback(`${q} шт.`, `qty_${type}_${continent}_${alpha3}_${periodDays}_${q}`));
    const rows = chunk(qtyButtons, 3);
    rows.push([Markup.button.callback('Ввести свое количество', `custom_qty_${type}_${continent}_${alpha3}_${periodDays}`)]);
    rows.push([Markup.button.callback('Назад', `back_to_countries_${type}_${continent}`)]);
    return Markup.inlineKeyboard(rows);
  } else {
    // Для IPv4: стандартные значения
    const qtyValues = [1,2,3,5,7,10,15,20,30];
    const qtyButtons = qtyValues.map(q => Markup.button.callback(`${q} шт.`, `qty_${type}_${continent}_${alpha3}_${periodDays}_${q}`));
    const rows = chunk(qtyButtons, 3);
    rows.push([Markup.button.callback('< Назад', `back_to_countries_${type}_${continent}`)]);
    return Markup.inlineKeyboard(rows);
  }
}

// === Остальные команды ===

/**
 * Форматирует детальную информацию о прокси для отображения пользователю
 * @param {Object} proxy - Объект прокси из БД
 * @returns {Promise<string>} Форматированное сообщение
 */
async function formatProxyDetails(proxy) {
  const cmId = proxy.cm_id || `#${proxy.id}`;
  let ip = proxy.ip || 'x';
  // Правильно читаем порты из БД - они могут быть числами или строками
  const portHttp = proxy.port_http ? String(proxy.port_http) : (proxy.port ? String(proxy.port) : '');
  const portSocks = proxy.port_socks ? String(proxy.port_socks) : '';
  const login = proxy.login || 'x';
  const password = proxy.password || 'x';
  
  // Для IPv6: если в IP уже есть порт (формат ip:port), убираем его
  const isIPv6 = proxy.type === 'private_ipv6';
  if (isIPv6 && ip !== 'x' && ip.includes(':')) {
    // IPv6 адреса содержат двоеточия, но если есть формат [ipv6]:port или ip:port, проверяем
    // Если есть порт в конце (после последнего двоеточия идут только цифры), убираем его
    const lastColonIndex = ip.lastIndexOf(':');
    if (lastColonIndex > 0) {
      const afterLastColon = ip.substring(lastColonIndex + 1);
      // Если после последнего двоеточия только цифры (порт), убираем его
      if (/^\d+$/.test(afterLastColon)) {
        ip = ip.substring(0, lastColonIndex);
      }
    }
  }
  
  // Определяем тип прокси для получения названия страны
  const proxyType = isIPv6 ? 'ipv6' : 'ipv4';
  const countryCode = proxy.country || '';
  let countryName = await getCountryName(countryCode, proxyType);
  // Если страна не найдена, пробуем использовать код страны как есть или показываем "Неизвестно"
  if (countryName === 'x' && countryCode) {
    countryName = countryCode;
  } else if (countryName === 'x') {
    countryName = 'Неизвестно';
  }
  
  // Форматируем даты
  let dateStart = 'x';
  let dateEnd = 'x';
  if (proxy.date_start) {
    const date = proxy.date_start instanceof Date ? proxy.date_start : new Date(proxy.date_start);
    if (!isNaN(date.getTime())) {
      dateStart = formatDateToMoscow(date.toISOString());
    }
  }
  if (proxy.date_end) {
    const date = proxy.date_end instanceof Date ? proxy.date_end : new Date(proxy.date_end);
    if (!isNaN(date.getTime())) {
      dateEnd = formatDateToMoscow(date.toISOString());
    }
  }
  
  // Определяем статус для отображения
  const statusDisplay = proxy.status === 'active' ? '✅ Активный' : 
                        (proxy.status === 'expired' ? '⏰ Истёк' : '❌ Отключен');
  
  let message = `<b>📦 Прокси ${cmId}</b>\n\n`;
  message += `├ Статус: ${statusDisplay}\n`;
  message += `╰ Тип: ${formatProxyTypeDisplay(proxy.type)}\n\n`;
  
  message += `<b>🔑 Подключение</b>\n\n`;
  // Используем port_http если есть, иначе общий port для HTTP
  if (portHttp && ip !== 'x') {
    message += `├ HTTP: <code>${ip}:${portHttp}</code>\n`;
  } else {
    message += `├ HTTP: x\n`;
  }
  // Для SOCKS5 используем port_socks, если есть, иначе общий port если нет HTTP порта
  if (portSocks && ip !== 'x') {
    message += `├ SOCKS5: <code>${ip}:${portSocks}</code>\n`;
  } else if (!portHttp && proxy.port && ip !== 'x') {
    message += `├ SOCKS5: <code>${ip}:${proxy.port}</code>\n`;
  } else {
    message += `├ SOCKS5: x\n`;
  }
  message += `├ Логин: <code>${login}</code>\n`;
  message += `╰ Пароль: <code>${password}</code>\n\n`;
  
  message += `<b>🌍 Локация</b>\n\n`;
  message += `├ Страна: ${countryName}\n`;
  message += `╰ Город: Случайный город\n\n`;
  
  message += `<b>⏳ Срок действия</b>\n\n`;
  message += `├ Начало: ${dateStart}\n`;
  message += `╰ Завершение: ${dateEnd}`;
  
  return message;
}

/**
 * Показывает список прокси пользователя с CM ID
 * @param {Object} ctx - Контекст Telegraf
 * @param {number} userId - Telegram ID пользователя
 * @param {boolean} useEdit - Использовать editMessageText вместо reply
 */
async function showProxyList(ctx, userId, useEdit = false) {
  if (!pool) {
    if (useEdit) {
      await ctx.editMessageText('❌ Ошибка базы данных. Попробуйте позже.');
    } else {
      await ctx.reply('❌ Ошибка базы данных. Попробуйте позже.');
    }
    return;
  }
  try {
    const res = await pool.query(
      'SELECT id, cm_id, proxy_id, login, password, ip, port, port_http, port_socks, country, type, date_start, date_end, status FROM user_proxies WHERE telegram_id = $1 AND status = $2 ORDER BY purchased_at DESC, created_at DESC LIMIT 100',
      [userId, 'active']
    );
    if (res.rows.length === 0) {
      if (useEdit) {
        await ctx.editMessageText('📦 У вас пока нет активных прокси.\n\nКупите прокси в разделе "🛒 Купить прокси"');
      } else {
        await ctx.reply('📦 У вас пока нет активных прокси.\n\nКупите прокси в разделе "🛒 Купить прокси"');
      }
      return;
    }
    
    // Создаем кнопки для каждого прокси в формате "#CM000001 | Страна | Статус"
    const buttons = [];
    for (const proxy of res.rows) {
      const cmId = proxy.cm_id || `#${proxy.id}`;
      const proxyType = proxy.type === 'ipv6' ? 'ipv6' : 'ipv4';
      const countryCode = proxy.country || '';
      let countryName = await getCountryName(countryCode, proxyType);
      
      // Если страна не найдена, используем код или "Неизвестно"
      if (countryName === 'x' && countryCode) {
        countryName = countryCode;
      } else if (countryName === 'x') {
        countryName = '🌍';
      }
      
      // Определяем статус для отображения
      const statusDisplay = proxy.status === 'active' ? '✅' : (proxy.status === 'expired' ? '⏰' : '❌');
      
      const buttonText = `${cmId} | ${countryName} | ${statusDisplay}`;
      buttons.push([Markup.button.callback(buttonText, `proxy_detail_${proxy.id}`)]);
    }
    
    // Добавляем кнопку "Назад"
    buttons.push([Markup.button.callback('< Назад', 'back_to_main_menu')]);
    
    const keyboard = Markup.inlineKeyboard(buttons);
    
    const headerText = `<b>📦 Ваши прокси (${res.rows.length})</b>\n\nФормат: <code>#CM_ID | Страна | Статус</code>`;
    
    if (useEdit) {
      await ctx.editMessageText(headerText, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
    } else {
      await ctx.reply(headerText, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
    }
  } catch (e) {
    console.error('❌ Ошибка загрузки списка прокси:', e.message);
    console.error('   Stack:', e.stack);
    if (useEdit) {
      await ctx.editMessageText('❌ Не удалось загрузить список прокси. Попробуйте позже.');
    } else {
      await ctx.reply('❌ Не удалось загрузить список прокси. Попробуйте позже.');
    }
  }
}

bot.hears('📦 Мои прокси', async (ctx) => {
  await showProxyList(ctx, ctx.from.id);
});

// Обработчик для детального просмотра прокси
bot.action(/^proxy_detail_(\d+)$/, async (ctx) => {
  await safeAnswerCb(ctx);
  const userId = ctx.from.id;
  const proxyDbId = parseInt(ctx.match[1]);
  
  if (!pool) {
    await ctx.reply('❌ Ошибка базы данных. Попробуйте позже.');
    return;
  }
  
  try {
    const res = await pool.query(
      'SELECT id, cm_id, proxy_id, login, password, ip, port, port_http, port_socks, country, type, date_start, date_end, status FROM user_proxies WHERE id = $1 AND telegram_id = $2',
      [proxyDbId, userId]
    );
    
    if (res.rows.length === 0) {
      await ctx.answerCbQuery('❌ Прокси не найдено');
      return;
    }
    
    const proxy = res.rows[0];
    const messageText = await formatProxyDetails(proxy);
    
    // Кнопка "Назад"
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('Назад', 'proxy_list_back')]
    ]);
    
    await ctx.editMessageText(messageText, { 
      parse_mode: 'HTML',
      reply_markup: keyboard.reply_markup 
    });
  } catch (e) {
    console.error('❌ Ошибка загрузки деталей прокси:', e.message);
    await ctx.answerCbQuery('❌ Ошибка загрузки данных');
  }
});

// Обработчик кнопки "Назад" в списке прокси
bot.action('proxy_list_back', async (ctx) => {
  await safeAnswerCb(ctx);
  await showProxyList(ctx, ctx.from.id, true);
});

// Обработчик кнопки "Назад" в главное меню из списка прокси
bot.action('back_to_main_menu', async (ctx) => {
  await safeAnswerCb(ctx);
  try {
    await ctx.editMessageText(
      '👋 Добро пожаловать!\n\nВыберите действие:',
      { reply_markup: mainMenu.reply_markup }
    );
  } catch (e) {
    // Если не удалось отредактировать сообщение, отправляем новое
    await ctx.reply(
      '👋 Добро пожаловать!\n\nВыберите действие:',
      { reply_markup: mainMenu.reply_markup }
    );
  }
});

// Кнопка "Профиль"
bot.hears('👤 Профиль', async (ctx) => {
  try {
    const userId = ctx.from.id;
    
    // Проверяем наличие pool
    if (!pool) {
      console.error('❌ pool не инициализирован');
      await ctx.reply('❌ Ошибка базы данных. Попробуйте позже.');
      return;
    }
    
    // Проверяем, есть ли пользователь в базе данных
    let user = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    
    let balance;
    let proxiesPurchased;
    
    if (user.rows.length === 0) {
      // Создаём нового пользователя
      await pool.query(
        'INSERT INTO users (telegram_id, username) VALUES ($1, $2)',
        [userId, ctx.from.username || null]
      );
      balance = 0;
      proxiesPurchased = 0;
    } else {
      balance = parseFloat(user.rows[0].balance || 0);
      proxiesPurchased = user.rows[0].proxies_purchased || 0;
    }
    
    const username = ctx.from.username ? `@${ctx.from.username}` : 'не указан';
    const balanceFormatted = balance.toFixed(2);
    
    const profileText = `👤 Информация\n├ Никнейм: ${username}\n├ ID: <code>${userId}</code>\n╰ Куплено прокси: ${proxiesPurchased}\n\n🏦 Финансы\n╰ Баланс: <b>$${balanceFormatted}</b>`;
    
    const profileKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('💳 Пополнить', 'profile_deposit')],
      [Markup.button.callback('< Назад', 'profile_back')]
    ]);
    
    await ctx.replyWithHTML(profileText, profileKeyboard);
  } catch (err) {
    if (err.message && err.message.includes('bot was blocked')) {
      console.log(`⚠️ Пользователь ${ctx.from?.id} заблокировал бота`);
      return;
    }
    console.error('❌ Ошибка при отправке профиля:', err.message);
    console.error('   Stack:', err.stack);
    await ctx.reply('❌ Произошла ошибка при загрузке профиля. Попробуйте позже.');
  }
});

// Обработчик кнопки "Пополнить" в профиле
bot.action('profile_deposit', async (ctx) => {
  await safeAnswerCb(ctx);
  try {
    await ctx.editMessageText('Способ пополнения: <b>🤖 CryptoBot</b>\n\n💰 Введите сумму пополнения в USD', { parse_mode: 'HTML' });
    
    // Устанавливаем сцену ожидания суммы (простой способ без сценариев)
    ctx.session = ctx.session || {};
    ctx.session.awaitingDepositAmount = true;
  } catch (err) {
    if (err.message && err.message.includes('message is not modified')) {
      return;
    }
    console.error('❌ Ошибка при отправке сообщения о пополнении:', err.message);
  }
});

// Обработчик кнопки "< Назад" в профиле
bot.action('profile_back', async (ctx) => {
  await safeAnswerCb(ctx);
  try {
    await ctx.deleteMessage();
    await ctx.replyWithHTML(
      '<b>👋 Добро пожаловать в Capitan MARKET.</b>\n╰ Приятных покупок',
      mainMenu
    );
  } catch (err) {
    if (err.message && err.message.includes('message is not modified')) {
      return;
    }
    if (err.message && err.message.includes('bot was blocked')) {
      console.log(`⚠️ Пользователь ${ctx.from?.id} заблокировал бота`);
      return;
    }
    console.error('❌ Ошибка при возврате в главное меню:', err.message);
  }
});

bot.hears('ℹ️ Помощь', (ctx) => {
  ctx.reply('📖 Как использовать прокси:\n1. Купите подходящий тип\n2. Скопируйте данные\n3. Настройте в своём приложении');
});

bot.hears('👤 Поддержка', async (ctx) => {
  try {
    await ctx.reply('Напишите нам: @ваш_ник_в_Telegram');
  } catch (err) {
    if (err.message && err.message.includes('bot was blocked')) {
      console.log(`⚠️ Пользователь ${ctx.from?.id} заблокировал бота`);
      return;
    }
    console.error('❌ Ошибка при отправке сообщения:', err.message);
  }
});

// Обработка текстового ввода (в том числе суммы и количества)
bot.on('text', async (ctx) => {
  // Пропускаем команды, которые обрабатываются другими обработчиками
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) {
    return; // Команды обрабатываются отдельно
  }

  const userId = ctx.from.id;

  // Проверяем, ожидаем ли мы пользовательское количество для IPv6
  if (ctx.session?.awaitingCustomQuantity) {
    const { type, continent, alpha3, periodDays } = ctx.session.awaitingCustomQuantity;
    const quantity = parseInt(text, 10);
    
    // Валидация: для IPv6 минимум 10
    if (isNaN(quantity) || quantity < 10) {
      await ctx.reply('❌ Некорректное количество. Для IPv6 минимальное количество - 10 шт. Введите число от 10 и выше.');
      return;
    }
    
    // Очищаем состояние ожидания
    delete ctx.session.awaitingCustomQuantity;
    
    // Используем тот же обработчик, что и для обычных кнопок количества
    // Создаем фиктивный callback для обработки
    const callbackData = `qty_${type}_${continent}_${alpha3}_${periodDays}_${quantity}`;
    
    // Получаем данные страны
    const list = await getCountriesForType(type);
    let country = list.find(c => String(c.alpha3).toUpperCase() === alpha3) || { alpha3, alpha2: '', name: alpha3 };
    const isIPv6 = type === 'private_ipv6';
    const PINNED_BY_CONT = {
      europe: isIPv6 ? EUROPE_PINNED_IPV6 : EUROPE_PINNED,
      asia: isIPv6 ? ASIA_PINNED_IPV6 : ASIA_PINNED,
      africa: isIPv6 ? [] : AFRICA_PINNED,
      north_america: isIPv6 ? NORTH_AMERICA_PINNED_IPV6 : NORTH_AMERICA_PINNED,
      south_america: isIPv6 ? SOUTH_AMERICA_PINNED_IPV6 : SOUTH_AMERICA_PINNED,
      oceania: isIPv6 ? OCEANIA_PINNED_IPV6 : OCEANIA_PINNED
    };
    const overrideArr = PINNED_BY_CONT[continent] || [];
    const override = overrideArr.find(p => p.alpha3 === alpha3);
    if (override) country = { ...country, name: override.name, alpha2: override.alpha2 };
    
    // Показать мгновенную реакцию
    try {
      await ctx.reply('⏳ Получаю актуальную цену...');
    } catch (_) {}
    
    // расчёт цены с наценкой 50% (через Proxy-Seller)
    let price;
    let amount = 0;
    const maxRetries = 2;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        price = await psCalculatePrice({ type, country: country.alpha3 || country.alpha2 || country.name || alpha3, periodDays, quantity });
        if (price && price.finalUsd && price.finalUsd > 0) {
          amount = price.finalUsd * 1.0; // наценка 100%
          break;
        }
      } catch (err) {
        console.warn(`⚠️ Ошибка расчёта цены (попытка ${attempt}/${maxRetries}):`, err.message);
        if (attempt === maxRetries) {
          await ctx.reply('❌ Не удалось получить цену. Попробуйте позже.');
          return;
        }
      }
    }
    
    if (amount === 0) {
      await ctx.reply('❌ Не удалось получить цену. Попробуйте позже.');
      return;
    }
    
    const typeLabel = type === 'private_ipv4' ? 'Приватный (IPv4)' : (type === 'shared_ipv4' ? 'Общий (IPv4)' : 'Приватный (IPv6)');
    const periodDaysLabel = formatPeriodLabel(periodDays);
    const flag = toFlagEmoji(country.alpha2);
    
    const messageText = `├ Тип: <b>${typeLabel}</b>\n├ Срок аренды: <b>${periodDaysLabel}</b>\n├ Количество: <b>${quantity} шт.</b>\n╰ Стоимость: <b>$${amount.toFixed(2)}</b>\n\n🌍 Локация\n├ Страна: ${flag ? flag + ' ' : ''}<b>${country.name}</b>\n╰ Город: <b>Случайный город</b>`;
    
    // Сохраняем параметры заказа в сессии
    ctx.session.order = {
      type: type,
      continent: continent,
      country: country.alpha3 || country.alpha2 || country.name || alpha3,
      countryName: country.name,
      periodDays: periodDays,
      quantity: quantity,
      amount: amount
    };
    
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('Купить', `buy_${type}_${continent}_${alpha3}_${periodDays}_${quantity}`)],
      [Markup.button.callback('Назад', `back_to_quantities_${type}_${continent}_${alpha3}_${periodDays}`)]
    ]);
    
    await ctx.reply(messageText, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
    return;
  }

  // Проверяем, ожидаем ли мы сумму пополнения
  if (ctx.session?.awaitingDepositAmount) {
    const amount = parseFloat(text);

    // Валидация суммы
    if (isNaN(amount) || amount < 0.01 || amount > 1000) {
      await ctx.reply('❌ Некорректная сумма. Введите число от 0.01 до 1000 USD.');
      return;
    }

    try {
      // Создаём инвойс через CryptoBot API
      const invoice = await createInvoice({
        amount,
        payload: `deposit_${userId}`,
        description: `Пополнение баланса на $${amount}`
      });

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.url(`💳 Оплатить $${amount}`, invoice.payUrl)],
        [Markup.button.callback('✖︎ Отмена', 'cancel_deposit')]
      ]);

      const invoiceMessage = await ctx.replyWithHTML(
        `<b>🤖 CryptoBot</b>: Создан счёт на оплату. У вас есть 15 минут для оплаты. По истечении времени счёт будет отменён.\n\n├ ID: #IV${invoice.invoiceId}\n╰ Сумма к оплате: $${amount.toFixed(2)}`,
        keyboard
      );

      // Сохраняем данные в сессии для проверки оплаты
      ctx.session.depositAmount = amount;
      ctx.session.depositPayload = `deposit_${userId}`;
      ctx.session.invoiceId = invoice.invoiceId;
      ctx.session.invoiceMessageId = invoiceMessage.message_id;
      ctx.session.invoiceChatId = ctx.chat.id;

      // Сбрасываем состояние
      ctx.session.awaitingDepositAmount = false;

      // Запускаем автоматическую проверку платежа
      startPaymentCheck(invoice.invoiceId, amount, userId, ctx.chat.id, invoiceMessage.message_id);
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
    
    return;
  }

  // Обработка других текстовых команд (если нужно)
  // Например, можно оставить старые "hears" команды
});

// Обработчик кнопки "Отмена" при пополнении
bot.action('cancel_deposit', async (ctx) => {
  await safeAnswerCb(ctx);
  try {
    const userId = ctx.from.id;
    
    // Останавливаем проверку платежа
    stopPaymentCheck(userId);
    
    // Очищаем данные из сессии
    const session = userSessions[userId];
    if (session) {
      delete session.depositAmount;
      delete session.depositPayload;
      delete session.invoiceId;
      delete session.invoiceMessageId;
      delete session.invoiceChatId;
    }

    // Возвращаемся к профилю
    if (!pool) {
      console.error('❌ pool не инициализирован');
      await ctx.editMessageText('❌ Ошибка базы данных. Попробуйте позже.');
      return;
    }
    
    let user = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    
    let balance;
    let proxiesPurchased;
    
    if (user.rows.length === 0) {
      // Создаём нового пользователя
      await pool.query(
        'INSERT INTO users (telegram_id, username) VALUES ($1, $2)',
        [userId, ctx.from.username || null]
      );
      balance = 0;
      proxiesPurchased = 0;
    } else {
      balance = parseFloat(user.rows[0].balance || 0);
      proxiesPurchased = user.rows[0].proxies_purchased || 0;
    }
    
    const username = ctx.from.username ? `@${ctx.from.username}` : 'не указан';
    const balanceFormatted = balance.toFixed(2);
    
    const profileText = `👤 Информация\n├ Никнейм: ${username}\n├ ID: <code>${userId}</code>\n╰ Куплено прокси: ${proxiesPurchased}\n\n🏦 Финансы\n╰ Баланс: <b>$${balanceFormatted}</b>`;
    
    const profileKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('💳 Пополнить', 'profile_deposit')],
      [Markup.button.callback('< Назад', 'profile_back')]
    ]);

    await ctx.editMessageText(profileText, { 
      parse_mode: 'HTML', 
      reply_markup: profileKeyboard.reply_markup 
    });
  } catch (err) {
    if (err.message && err.message.includes('message is not modified')) {
      return;
    }
    console.error('❌ Ошибка при отмене пополнения:', err.message);
  }
});

// Общий обработчик ошибок Telegram API
bot.catch((err, ctx) => {
  // Игнорируем ошибки, связанные с заблокированным ботом
  if (err.message && err.message.includes('bot was blocked')) {
    console.log(`⚠️ Пользователь ${ctx.from?.id} заблокировал бота`);
    return;
  }
  // Игнорируем ошибки "message is not modified"
  if (err.message && err.message.includes('message is not modified')) {
    return;
  }
  // Обрабатываем таймауты внешнего API
  if (/TimeoutError|timed out|ECONNABORTED/i.test(err.message || '')) {
    console.warn('⏳ Таймаут запроса к магазину, предложим повторить позже');
    return;
  }
  console.error('❌ Ошибка в боте:', err);
});

// Запуск бота
bot.launch();
console.log('🚀 Бот запущен с интеграцией Proxy-Seller');