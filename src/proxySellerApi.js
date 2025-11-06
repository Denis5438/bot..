// src/proxySellerApi.js
require('dotenv').config();

let ClientCtor = null;
let client = null;

async function getClient() {
  if (client) return client;
  if (!ClientCtor) {
    let mod = null;
    // Try local SDK first (user added folder), then npm package
    const candidates = [
      '../proxy-seller/index.js',
      '../proxy-seller-user-api/index.js',
      './proxy-seller/index.js',
      'proxy-seller-user-api',
    ];
    for (const p of candidates) {
      try {
        mod = await import(p);
        if (mod) { ClientCtor = mod.default || mod; break; }
      } catch (_) { /* try next */ }
    }
    if (!ClientCtor) {
      throw new Error('Не удалось загрузить Proxy-Seller SDK (ни локальный, ни из npm)');
    }
  }
  const apiKey = process.env.PROXY_SELLER_API_KEY || process.env.PROXY_SELLER_KEY || process.env.PS_API_KEY;
  if (!apiKey) {
    throw new Error('PROXY_SELLER_API_KEY не задан в .env');
  }
  client = new ClientCtor({ key: apiKey });
  if (typeof client.setPaymentId === 'function') client.setPaymentId(1);
  if (typeof client.setGenerateAuth === 'function') client.setGenerateAuth('N');
  return client;
}

async function initClient() {
  await getClient();
}

// Маппинг дней в periodId согласно API Proxy-Seller
// API использует: 1w, 2w, 1m, 2m, 3m, 6m (не 7d, 14d, 30d и т.д.)
// Функция для расчета процента markup в зависимости от срока аренды
function calculateMarkupPercent(periodDays) {
  // Базовый процент для 1 недели (7 дней)
  const baseMarkup = 80;
  
  // Определяем шаг уменьшения (каждый период -10%)
  let markupReduction = 0;
  
  if (periodDays <= 7) {
    // 1 неделя (7 дней) = 80%
    markupReduction = 0;
  } else if (periodDays <= 14) {
    // 2 недели (14 дней) = 70%
    markupReduction = 10;
  } else if (periodDays <= 30) {
    // 1 месяц (30 дней) = 60%
    markupReduction = 20;
  } else if (periodDays <= 60) {
    // 2 месяца (60 дней) = 50%
    markupReduction = 30;
  } else if (periodDays <= 90) {
    // 3 месяца (90 дней) = 40%
    markupReduction = 40;
  } else {
    // 6 месяцев и больше (180 дней) = 30%
    markupReduction = 40;
  }
  
  const markupPercent = baseMarkup - markupReduction;
  // Минимальный markup 0%
  return Math.max(0, markupPercent);
}

function convertDaysToPeriodId(days) {
  const d = Number(days) || 7;
  // Маппинг: дни -> periodId
  const mapping = {
    7: '1w',    // 1 неделя
    14: '2w',   // 2 недели
    30: '1m',   // 1 месяц
    60: '2m',   // 2 месяца
    90: '3m',   // 3 месяца
    180: '6m'   // 6 месяцев
  };
  return mapping[d] || '1w'; // По умолчанию 1 неделя
}

async function loadReferenceList(proxyType = 'ipv4') {
  const api = await getClient();
  let raw;
  try {
    raw = await api.referenceList(proxyType);
    const rawStr = JSON.stringify(raw, null, 2);
    console.log(`📋 referenceList(${proxyType}) ответ (первые 2000 символов):`, rawStr.slice(0, 2000));
    if (rawStr.length > 2000) console.log(`📋 ... (всего ${rawStr.length} символов)`);
  } catch (err) {
    console.error(`❌ Ошибка загрузки referenceList для ${proxyType}:`, err.message);
    throw err;
  }
  
  // SDK уже возвращает data из { status, data, errors }, поэтому raw = data
  // Может быть несколько форматов:
  // 1. { items: { country: [...], period: [...] } } - реальный формат API (объект items)
  // 2. { items: [{ country: [...], period: [...] }] } - массив items (документация)
  // 3. { country: [...], period: [...] } - прямой
  // 4. { ipv4: { country: [...], period: [...] } } - вложенный
  // 5. Массив [{ country: [...], period: [...] }] - массив items
  
  let section = raw;
  
  // Если items - это объект с country/period (реальный формат API)
  if (raw?.items && typeof raw.items === 'object' && !Array.isArray(raw.items)) {
    if (raw.items.country || raw.items.period) {
      section = raw.items;
      console.log(`📋 Использован items (объект) для ${proxyType}, countries: ${Array.isArray(section?.country) ? section.country.length : 0}`);
    }
  }
  // Если это массив items
  else if (Array.isArray(raw) && raw.length > 0) {
    const first = raw.find(it => it && (it.country || it.period)) || raw[0];
    section = first || {};
    console.log(`📋 Использован массив items[0] для ${proxyType}`);
  }
  // Если есть items массив внутри
  else if (Array.isArray(raw?.items) && raw.items.length > 0) {
    const first = raw.items.find(it => it && (it.country || it.period)) || raw.items[0];
    section = first || {};
    console.log(`📋 Использован items[0] (массив) для ${proxyType}, countries: ${Array.isArray(section?.country) ? section.country.length : 0}`);
  }
  // Если есть вложенный тип (ipv4, ipv6 и т.д.)
  else if (raw && raw[proxyType]) {
    section = raw[proxyType];
    console.log(`📋 Использован raw[${proxyType}] для ${proxyType}`);
  }
  // Если country/period на верхнем уровне
  else if (raw && (raw.country || raw.period)) {
    section = raw;
    console.log(`📋 Использован raw напрямую для ${proxyType}`);
  }

  const out = { country: [], period: [] };
  const countries = Array.isArray(section?.country)
    ? section.country
    : (section?.country && typeof section.country === 'object' ? Object.values(section.country) : []);
  const periods = Array.isArray(section?.period)
    ? section.period
    : (section?.period && typeof section.period === 'object' ? Object.values(section.period) : []);
  
  out.country = countries.map((c, idx) => {
    if (c && typeof c === 'object') return c;
    return { id: idx + 1, name: String(c) };
  });
  out.period = periods.map((p, idx) => {
    if (p && typeof p === 'object') return p;
    return { id: String(p), name: String(p) };
  });
  
  console.log(`📋 Нормализовано для ${proxyType}: стран=${out.country.length}, периодов=${out.period.length}`);
  if (out.country.length > 0) {
    console.log(`📋 Примеры стран (первые 3):`, out.country.slice(0, 3).map(c => ({ id: c.id, name: c.name, alpha3: c.alpha3, alpha2: c.alpha2, keys: Object.keys(c).slice(0, 10) })));
  } else {
    console.error(`❌ НЕ НАЙДЕНО СТРАН для ${proxyType}! Структура section:`, JSON.stringify(section, null, 2).slice(0, 500));
  }
  return out;
}

function findCountryRecord(refs, countryInput) {
  const list = Array.isArray(refs?.country) ? refs.country : [];
  if (list.length === 0) {
    console.warn(`🔍 findCountryRecord: список стран пуст для ввода "${countryInput}"`);
    return null;
  }
  const input = String(countryInput || '').trim();
  if (!input) return null;
  const upper = input.toUpperCase();
  const lower = input.toLowerCase();
  
  // direct id numeric match
  if (/^\d+$/.test(input)) {
    const idNum = Number(input);
    const byId = list.find(c => Number(c.id || c.value) === idNum);
    if (byId) {
      console.log(`✅ Найдена страна по ID: ${idNum} -> ${byId.name || byId.id}`);
      return byId;
    }
  }
  
  // try alpha3, alpha2
  let rec = list.find(c => String(c.alpha3 || c.code3 || c.alpha_3 || c.iso3 || c.iso_3 || '').toUpperCase() === upper);
  if (rec) {
    console.log(`✅ Найдена страна по alpha3: ${upper} -> ${rec.name || rec.id} (id=${rec.id})`);
    return rec;
  }
  rec = list.find(c => String(c.alpha2 || c.code2 || c.alpha_2 || c.iso2 || c.iso_2 || '').toUpperCase() === upper);
  if (rec) {
    console.log(`✅ Найдена страна по alpha2: ${upper} -> ${rec.name || rec.id} (id=${rec.id})`);
    return rec;
  }
  
  // try by id string equality
  rec = list.find(c => String(c.id || c.value) === input);
  if (rec) {
    console.log(`✅ Найдена страна по id (string): ${input} -> ${rec.name || rec.id}`);
    return rec;
  }
  
  // try by name
  rec = list.find(c => String(c.name || c.country || c.title).toLowerCase() === lower);
  if (rec) {
    console.log(`✅ Найдена страна по имени: ${lower} -> id=${rec.id}`);
    return rec;
  }
  
  // partial startsWith on name
  rec = list.find(c => String(c.name || c.country || c.title).toLowerCase().startsWith(lower));
  if (rec) {
    console.log(`✅ Найдена страна по префиксу имени: ${lower} -> ${rec.name} (id=${rec.id})`);
    return rec;
  }
  
  // as a last resort: scan all string props
  const matches = list.find((c) => {
    try {
      return Object.values(c).some(v => typeof v === 'string' && (v.toUpperCase() === upper || v.toLowerCase() === lower));
    } catch (_) { return false; }
  });
  if (matches) {
    console.log(`✅ Найдена страна по сканированию полей: ${input} -> ${matches.name || matches.id} (id=${matches.id})`);
    return matches;
  }
  
  // Покажем примеры стран для отладки
  const samples = list.slice(0, 3).map(c => ({ id: c.id, name: c.name, alpha3: c.alpha3, alpha2: c.alpha2, keys: Object.keys(c) }));
  console.warn(`❌ Страна "${input}" не найдена. Примеры доступных стран:`, samples);
  return null;
}

async function resolveCountryId(countryInput, preferredType = 'ipv4') {
  console.log(`🔍 resolveCountryId: ищем "${countryInput}" в типе ${preferredType}`);
  // Try preferred refs first
  try {
    const refs = await loadReferenceList(preferredType);
    const rec = findCountryRecord(refs, countryInput);
    if (rec) {
      const id = rec.id || rec.value;
      console.log(`✅ resolveCountryId: найдено в ${preferredType}, id=${id}`);
      return { id, record: rec };
    } else {
      console.warn(`⚠️ resolveCountryId: "${countryInput}" не найдено в ${preferredType}`);
    }
  } catch (err) {
    console.error(`❌ resolveCountryId: ошибка для ${preferredType}:`, err.message);
  }
  // Try opposite type as fallback
  try {
    const altType = preferredType === 'ipv6' ? 'ipv4' : 'ipv6';
    console.log(`🔍 resolveCountryId: пробуем альтернативный тип ${altType}`);
    const refsAlt = await loadReferenceList(altType);
    const rec2 = findCountryRecord(refsAlt, countryInput);
    if (rec2) {
      const id2 = rec2.id || rec2.value;
      console.log(`✅ resolveCountryId: найдено в ${altType}, id=${id2}`);
      return { id: id2, record: rec2 };
    }
  } catch (err) {
    console.error(`❌ resolveCountryId: ошибка для альтернативного типа:`, err.message);
  }
  console.error(`❌ resolveCountryId: страна "${countryInput}" не найдена ни в ${preferredType}, ни в альтернативном типе`);
  return { id: null, record: null };
}

function pickApiMethod(type, isCalc = true) {
  // По текущему боту используем приватные IPv4
  if (type === 'private_ipv4') return isCalc ? 'orderCalcIpv4' : 'orderMakeIpv4';
  if (type === 'shared_ipv4') return isCalc ? 'orderCalcMix' : 'orderMakeMix';
  if (type === 'private_ipv6') return isCalc ? 'orderCalcIpv6' : 'orderMakeIpv6';
  // Мобильные и ISP при необходимости
  if (type === 'mobile' || type === 'MOB') return isCalc ? 'orderCalcMobile' : 'orderMakeMobile';
  if (type === 'ISP' || type === 'isp' || type === 'isp_ipv4') return isCalc ? 'orderCalcIsp' : 'orderMakeIsp';
  return isCalc ? 'orderCalcIpv4' : 'orderMakeIpv4';
}

function extractPrice(calcResult) {
  const x = calcResult || {};
  // Проверяем стандартную структуру ответа API: { status, data, errors }
  if (x.status === 'success' && x.data) {
    // Согласно документации: data.total - итоговая стоимость, data.price - цена за единицу
    // Приоритет: total (итоговая стоимость), затем price (цена за единицу)
    if (typeof x.data.total === 'number' && Number.isFinite(x.data.total) && x.data.total > 0) {
      // Логируем предупреждения, если есть
      if (x.data.warning && String(x.data.warning).trim()) {
        console.warn(`⚠️ API предупреждение при калькуляции: ${x.data.warning}`);
      }
      return x.data.total;
    }
    if (typeof x.data.price === 'number' && Number.isFinite(x.data.price) && x.data.price > 0) {
      // Если есть quantity, умножаем price на quantity для получения total
      const qty = Number(x.data.quantity) || 1;
      const calculated = x.data.price * qty;
      if (calculated > 0) {
        if (x.data.warning && String(x.data.warning).trim()) {
          console.warn(`⚠️ API предупреждение при калькуляции: ${x.data.warning}`);
        }
        return calculated;
      }
    }
    // Fallback на другие поля
    const candidates = [x.data.amount, x.data.usd, x.data.cost, x.data.final, x.data.sum];
    for (const v of candidates) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  // Проверяем массив errors
  if (Array.isArray(x.errors) && x.errors.length > 0) {
    const errMsg = x.errors.map(e => typeof e === 'string' ? e : (e.message || e.error || String(e))).join('; ');
    throw new Error(`API ошибка: ${errMsg}`);
  }
  // Fallback на старую структуру (без status/data)
  const candidates = [x.total, x.price, x.amount, x.usd, x.cost, x.final, x.sum];
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // иногда ответ может быть объектом с полем result
  const r = x.result || x.data || x;
  if (r && typeof r === 'object') {
    const c2 = [r.total, r.price, r.amount, r.usd, r.cost, r.final, r.sum];
    for (const v of c2) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return 0;
}

async function calculatePrice({ type = 'private_ipv4', country = 'RUS', periodDays = 7, quantity = 1 }) {
  const api = await getClient();
  const proxyType = type === 'private_ipv6' ? 'ipv6' : 'ipv4';
  
  // 1. Получаем справочник стран и периодов
  const rawRefs = await api.referenceList(proxyType);
  console.log('📋 referenceList raw ответ:', JSON.stringify(rawRefs, null, 2).slice(0, 500));
  
  // Извлекаем данные из структуры { items: [ { country: [...], period: [...] } ] }
  let ref = null;
  if (rawRefs && rawRefs.items) {
    if (Array.isArray(rawRefs.items) && rawRefs.items.length > 0) {
      ref = rawRefs.items[0];
    } else if (typeof rawRefs.items === 'object' && (rawRefs.items.country || rawRefs.items.period)) {
      ref = rawRefs.items;
    }
  }
  if (!ref || (!ref.country && !ref.period)) {
    throw new Error('Не удалось извлечь страны и периоды из справочника');
  }
  
  const countries = Array.isArray(ref.country) ? ref.country : [];
  const periods = Array.isArray(ref.period) ? ref.period : [];
  
  // 2. Находим страну по ID, alpha3, alpha2 или имени
  const { id: countryId } = await resolveCountryId(country, proxyType);
  if (!countryId) {
    throw new Error(`Страна ${country} не найдена`);
  }
  
  // 3. Находим период
  let periodId = convertDaysToPeriodId(periodDays);
  let period = periods.find(p => String(p.id) === periodId);
  if (!period) {
    // Пробуем найти ближайший доступный период (используем правильные ID: 1w, 2w, 1m и т.д.)
    const pref = ['1w', '2w', '1m', '2m', '3m', '6m'];
    const ids = periods.map(p => String(p.id));
    const alt = pref.find(x => ids.includes(x));
    if (alt) {
      const altPeriod = periods.find(p => String(p.id) === alt);
      if (altPeriod) {
        console.warn(`⚠️ Период ${periodDays}д (${periodId}) не найден, используется ${altPeriod.id}`);
        periodId = String(altPeriod.id);
        period = altPeriod;
      }
    }
    if (!period) {
      throw new Error(`Период ${periodDays} дней (${periodId}) не найден в доступных периодах`);
    }
  }
  
  // 4. Расчёт цены с использованием методов SDK напрямую
  // ВАЖНО: customTargetName должен быть заполнен, иначе API вернёт ошибку
  let calcResult = null;
  let lastError = null;
  
  // Пробуем разные методы в зависимости от типа
  const methods = [];
  if (type === 'private_ipv4' || type === 'shared_ipv4') {
    methods.push('orderCalcIpv4');
    methods.push('orderCalcIsp');
    methods.push('orderCalcMix');
  } else if (type === 'private_ipv6') {
    methods.push('orderCalcIpv6');
  }
  // Добавляем все методы как fallback
  ['orderCalcIpv4', 'orderCalcIsp', 'orderCalcMix', 'orderCalcIpv6'].forEach(m => {
    if (!methods.includes(m)) methods.push(m);
  });
  
  for (const method of methods) {
    try {
      if (method === 'orderCalcIpv4') {
        calcResult = await api.orderCalcIpv4(
          countryId,
          periodId,
          quantity,
          '',              // authorization (пусто = логин/пароль)
          '',              // coupon
          'surfing'        // customTargetName (ОБЯЗАТЕЛЬНО!)
        );
      } else if (method === 'orderCalcIsp') {
        calcResult = await api.orderCalcIsp(
          countryId,
          periodId,
          quantity,
          '',
          '',
          'surfing'
        );
      } else if (method === 'orderCalcMix') {
        calcResult = await api.orderCalcMix(
          countryId,
          periodId,
          quantity,
          '',
          '',
          'surfing'
        );
      } else if (method === 'orderCalcIpv6') {
        calcResult = await api.orderCalcIpv6(
          countryId,
          periodId,
          quantity,
          '',
          '',
          'surfing',
          'HTTPS'
        );
      }
      
      console.log(`✅ ${method} успешно вызван, ответ:`, JSON.stringify(calcResult, null, 2).slice(0, 500));
      
      // 5. Извлекаем цену из ответа
      if (calcResult && typeof calcResult === 'object') {
        // Проверяем warning
        if (calcResult.warning && String(calcResult.warning).trim()) {
          console.warn(`⚠️ API предупреждение: ${calcResult.warning}`);
        }
        
        // Извлекаем цену
        const price = calcResult.total || calcResult.price || 0;
        if (price && price > 0) {
          console.log(`💰 ${method} вернул цену: $${price}`);
          
          // Применяем динамическую наценку в зависимости от срока аренды
          const base = Number(price);
          const markupPercent = calculateMarkupPercent(periodDays);
          const markup = Number(((base * markupPercent) / 100).toFixed(2));
          const finalUsd = Number((base + markup).toFixed(2));
          
          console.log(`📊 Наценка для ${periodDays} дней: ${markupPercent}% (markup: $${markup}, итого: $${finalUsd})`);
          
          return {
            baseUsd: base,
            markup: markup,
            finalUsd: finalUsd,
            warning: calcResult.warning || null
          };
        }
      }
    } catch (err) {
      console.warn(`⚠️ ${method} исключение:`, err.message);
      lastError = err;
      continue;
    }
  }
  
  // Если цена не найдена
  if (!calcResult) {
    console.warn(`⚠️ Не удалось рассчитать цену для ${type}, ${country}, период ${periodDays}д, количество ${quantity}`);
    if (lastError) {
      console.error('   Последняя ошибка:', lastError.message);
    }
    return { baseUsd: 0, markup: 0, finalUsd: 0 };
  }
  
  return { baseUsd: 0, markup: 0, finalUsd: 0 };
}

async function buyProxy({ type = 'private_ipv4', country = 'RUS', periodDays = 7, quantity = 1 }) {
  const api = await getClient();
  const proxyType = type === 'private_ipv6' ? 'ipv6' : 'ipv4';
  const { id: countryId } = await resolveCountryId(country, proxyType);
  if (!countryId) throw new Error(`Страна ${country} не найдена`);

  const refs = await loadReferenceList(proxyType);
  const desired = convertDaysToPeriodId(periodDays);
  let period = Array.isArray(refs.period) ? refs.period.find(p => String(p.id) === desired) : null;
  if (!period) {
    // Пробуем найти ближайший доступный период (используем правильные ID: 1w, 2w, 1m и т.д.)
    const pref = ['1w', '2w', '1m', '2m', '3m', '6m'];
    const ids = (Array.isArray(refs.period) ? refs.period : []).map(p => String(p.id));
    const alt = pref.find(x => ids.includes(x));
    period = (Array.isArray(refs.period) ? refs.period : []).find(p => String(p.id) === alt) || (Array.isArray(refs.period) ? refs.period[0] : null);
  }
  if (!period) throw new Error(`Период ${periodDays} дней (${desired}) не найден в доступных периодах`);
  const periodId = String(period.id);

  const methods = [];
  const prefMake = pickApiMethod(type, false);
  methods.push(prefMake);
  ['orderMakeIsp','orderMakeMobile','orderMakeMix','orderMakeIpv4','orderMakeIpv6'].forEach(m => {
    if (!methods.includes(m)) methods.push(m);
  });

  for (const m of methods) {
    try {
      let result;
      // Используем методы SDK напрямую с customTargetName = 'surfing'
      if (m === 'orderMakeIpv4') {
        result = await api.orderMakeIpv4(countryId, periodId, quantity, '', '', 'surfing');
      } else if (m === 'orderMakeIsp') {
        result = await api.orderMakeIsp(countryId, periodId, quantity, '', '', 'surfing');
      } else if (m === 'orderMakeMix') {
        result = await api.orderMakeMix(countryId, periodId, quantity, '', '', 'surfing');
      } else if (m === 'orderMakeIpv6') {
        result = await api.orderMakeIpv6(countryId, periodId, quantity, '', '', 'surfing', 'HTTPS');
      } else if (m === 'orderMakeMobile') {
        result = await api.orderMakeMobile(countryId, periodId, quantity, '', '', null, null);
      } else {
        continue;
      }
      
      // Проверяем структуру ответа согласно документации: { status, data, errors }
      if (result && typeof result === 'object') {
        if (result.status === 'success' && result.data) {
          // Если есть errors, но status success - всё равно возвращаем (API может вернуть предупреждения)
          if (Array.isArray(result.errors) && result.errors.length > 0) {
            console.warn('⚠️ API вернул предупреждения при покупке:', result.errors);
          }
          return result;
        }
        if (Array.isArray(result.errors) && result.errors.length > 0) {
          const errMsg = result.errors.map(e => typeof e === 'string' ? e : (e.message || e.error || String(e))).join('; ');
          throw new Error(`API ошибка: ${errMsg}`);
        }
      }
      return result;
    } catch (err) {
      // Если это ошибка из errors массива - пробуем следующий метод
      if (err.message && err.message.includes('API ошибка')) {
        console.warn(`⚠️ ${m} вернул ошибку:`, err.message);
        continue;
      }
      // Для других исключений тоже пробуем следующий
      console.warn(`⚠️ ${m} исключение:`, err.message);
    }
  }
  throw new Error('Не удалось оформить заказ на выбранные параметры');
}

/**
 * Получает список прокси после покупки
 * @param {string} type - тип прокси: 'ipv4', 'ipv6', 'mobile', 'isp', 'mix' или '' (все)
 * @returns {Promise<Array>} массив объектов с данными прокси
 */
async function getProxyList(type = '') {
  const api = await getClient();
  try {
    // SDK возвращает data из { status, data, errors }
    const result = await api.proxyList(type);
    
    // Если result - это объект с status и data
    if (result && typeof result === 'object' && result.status === 'success' && Array.isArray(result.data)) {
      return result.data;
    }
    // Если result - это массив напрямую
    if (Array.isArray(result)) {
      return result;
    }
    // Если result.data - массив
    if (result && typeof result === 'object' && Array.isArray(result.data)) {
      return result.data;
    }
    // Если result.items - массив (альтернативный формат)
    if (result && typeof result === 'object' && Array.isArray(result.items)) {
      return result.items;
    }
    
    // Если result - это объект, но не содержит массивов, это может означать, что прокси ещё не активированы
    if (result && typeof result === 'object') {
      // Не логируем предупреждение, так как это нормально когда прокси ещё не готовы
      return [];
    }
    
    console.warn('⚠️ getProxyList: неожиданный формат ответа:', typeof result, Array.isArray(result));
    return [];
  } catch (err) {
    console.error('❌ Ошибка при получении списка прокси:', err.message);
    throw err;
  }
}

/**
 * Скачивает список прокси через официальный экспорт (txt/csv/custom)
 * Возвращает массив строк без разделителей ';', пустые строки отфильтрованы
 * @param {Object} params
 * @param {string} params.type - ipv4 | ipv6 | mobile | isp | mix | mix_isp | resident
 * @param {string} [params.proto='https'] - https | socks5
 * @param {string} [params.ext='txt'] - txt | csv
 * @param {string} [params.format] - кастомный формат, напр. '%login%:%password%:%ip%:%port%'
 * @param {string} [params.country] - Alpha3 страны для фильтрации (например, RUS, FRA)
 * @param {string|number} [params.listId] - Proxy list id (для resident)
 * @param {string} [params.package_key] - package_key (для subresident)
 * @returns {Promise<string[]>}
 */
async function downloadProxies({ type, proto = 'https', ext = 'txt', format, country, listId, package_key } = {}) {
  const https = require('https');
  const apiKey = process.env.PROXY_SELLER_API_KEY || process.env.PROXY_SELLER_KEY || process.env.PS_API_KEY;
  if (!apiKey) throw new Error('PROXY_SELLER_API_KEY не задан в .env');
  if (!type) throw new Error('downloadProxies: параметр type обязателен');

  const baseUrl = `https://proxy-seller.com/personal/api/v1/${apiKey}/proxy/download/${encodeURIComponent(type)}`;
  const params = new URLSearchParams();
  if (ext) params.set('ext', ext);
  if (proto) params.set('proto', proto);
  // поддержка кастомного формата, если API принимает его как параметр 'format'
  if (format && typeof format === 'string') params.set('format', format);
  if (country) params.set('country', country);
  if (listId) params.set('listId', String(listId));
  if (package_key) params.set('package_key', String(package_key));

  const url = `${baseUrl}?${params.toString()}`;
  const body = await new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });

  // Ответ может быть "OK" с телом списка или строка ошибки в тексте
  // Разбиваем по строкам и по ';'
  const lines = body
    .split(/\r?\n|;\s*/)
    .map(s => s.trim())
    .filter(Boolean);

  return lines;
}

/**
 * Получает данные прокси после покупки с повторными попытками
 * Прокси могут активироваться с задержкой (от нескольких секунд до минуты)
 * Получает оба порта - HTTP и SOCKS5
 * @param {string} type - тип прокси
 * @param {number} maxAttempts - максимальное количество попыток
 * @param {number} delayMs - задержка между попытками в миллисекундах
 * @returns {Promise<Array>} массив объектов с данными прокси
 */
async function getProxyCredentials(type = '', maxAttempts = 6, delayMs = 10000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Сначала пробуем получить через getProxyList (должен возвращать оба порта)
      try {
        const proxies = await getProxyList(type);
        
        // Фильтруем только активные прокси
        const activeProxies = proxies.filter(p => 
          p && (p.status === 'Active' || p.status_type === 'ACTIVE' || p.status === 'active')
        );
        
        if (activeProxies.length > 0) {
          console.log(`✅ Получено ${activeProxies.length} активных прокси через getProxyList (попытка ${attempt}/${maxAttempts})`);
          return activeProxies;
        }
      } catch (listErr) {
        console.warn('⚠️ getProxyList не удалось, пробуем downloadProxies:', listErr.message);
      }

      // Fallback: используем официальный экспорт - делаем два запроса для получения обоих портов
      try {
        // Запрос для HTTP портов
        const httpLines = await downloadProxies({
          type: type || 'ipv4',
          proto: 'https',
          ext: 'txt',
          format: '%login%:%password%:%ip%:%port%'
        });
        
        // Запрос для SOCKS5 портов
        const socksLines = await downloadProxies({
          type: type || 'ipv4',
          proto: 'socks5',
          ext: 'txt',
          format: '%login%:%password%:%ip%:%port%'
        });

        if (Array.isArray(httpLines) && httpLines.length > 0) {
          // Парсим HTTP прокси
          const httpProxies = httpLines.map(line => {
            const parts = String(line).replace(/;$/,'').trim().split(':');
            if (parts.length >= 4) {
              const [login, password, ip, port] = [parts[0], parts[1], parts[2], parts[3]];
              return { login: login.trim(), password: password.trim(), ip: ip.trim(), port_http: port.trim(), status: 'Active' };
            }
            // возможный формат: login:pass@ip:port
            const m = String(line).match(/^(.*?):(.*?)@(.*?):(\d+)/);
            if (m) {
              return { login: m[1].trim(), password: m[2].trim(), ip: m[3].trim(), port_http: m[4].trim(), status: 'Active' };
            }
            return null;
          }).filter(Boolean);

          // Парсим SOCKS5 прокси и объединяем с HTTP прокси
          if (Array.isArray(socksLines) && socksLines.length > 0) {
            const socksProxies = socksLines.map(line => {
              const parts = String(line).replace(/;$/,'').trim().split(':');
              if (parts.length >= 4) {
                const [login, password, ip, port] = [parts[0], parts[1], parts[2], parts[3]];
                return { login: login.trim(), password: password.trim(), ip: ip.trim(), port_socks: port.trim() };
              }
              const m = String(line).match(/^(.*?):(.*?)@(.*?):(\d+)/);
              if (m) {
                return { login: m[1].trim(), password: m[2].trim(), ip: m[3].trim(), port_socks: m[4].trim() };
              }
              return null;
            }).filter(Boolean);

            // Объединяем данные: находим совпадающие прокси по login+ip и добавляем port_socks
            const proxyMap = new Map();
            httpProxies.forEach(p => {
              const key = `${p.login}:${p.ip}`;
              proxyMap.set(key, p);
            });

            socksProxies.forEach(s => {
              const key = `${s.login}:${s.ip}`;
              const httpProxy = proxyMap.get(key);
              if (httpProxy) {
                httpProxy.port_socks = s.port_socks;
              } else {
                // Если SOCKS5 прокси нет в HTTP списке, добавляем его
                proxyMap.set(key, { ...s, status: 'Active' });
              }
            });

            const mergedProxies = Array.from(proxyMap.values());
            if (mergedProxies.length > 0) {
              console.log(`✅ Получено ${mergedProxies.length} прокси через downloadProxies (оба порта) (попытка ${attempt}/${maxAttempts})`);
              return mergedProxies;
            }
          }

          // Если SOCKS5 не получены, возвращаем только HTTP
          if (httpProxies.length > 0) {
            console.log(`✅ Получено ${httpProxies.length} прокси через downloadProxies (только HTTP) (попытка ${attempt}/${maxAttempts})`);
            return httpProxies;
          }
        }
      } catch (dlErr) {
        console.warn('⚠️ downloadProxies не удалось:', dlErr.message);
      }
      
      // Если прокси еще не активированы, ждём и пробуем снова
      if (attempt < maxAttempts) {
        console.log(`⏳ Прокси ещё не активированы, повторная попытка через ${delayMs/1000} сек... (${attempt}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    } catch (err) {
      console.error(`❌ Ошибка при получении прокси (попытка ${attempt}/${maxAttempts}):`, err.message);
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  
  console.warn('⚠️ Не удалось получить данные прокси после всех попыток');
  return [];
}

// Тестовая функция для проверки доступности API
async function testApiConnection() {
  try {
    console.log('🔍 Проверяю доступность Proxy-Seller API...');
    const api = await getClient();
    
    // Тест 1: Проверка ping
    try {
      const pingResult = await api.ping();
      console.log('✅ Ping успешен:', pingResult);
    } catch (pingErr) {
      console.warn('⚠️ Ping не удался:', pingErr.message);
    }
    
    // Тест 2: Проверка баланса
    try {
      const balance = await api.balance();
      console.log('✅ Баланс получен: $' + balance);
    } catch (balanceErr) {
      console.warn('⚠️ Не удалось получить баланс:', balanceErr.message);
    }
    
    // Тест 3: Проверка referenceList
    try {
      const refs = await api.referenceList('ipv4');
      console.log('✅ referenceList получен, структура:', Object.keys(refs || {}));
      if (refs && refs.items) {
        console.log('   - items тип:', Array.isArray(refs.items) ? 'массив' : typeof refs.items);
      }
    } catch (refErr) {
      console.error('❌ Не удалось получить referenceList:', refErr.message);
      throw refErr; // Это критично
    }
    
    // Тест 4: Попытка расчета цены для тестовой страны
    try {
      const testPrice = await calculatePrice({ type: 'private_ipv4', country: 'RUS', periodDays: 7, quantity: 1 });
      if (testPrice && testPrice.finalUsd > 0) {
        console.log('✅ Тестовый расчет цены успешен: $' + testPrice.finalUsd);
      } else {
        console.warn('⚠️ Тестовый расчет цены вернул 0:', testPrice);
      }
    } catch (priceErr) {
      console.warn('⚠️ Тестовый расчет цены не удался:', priceErr.message);
    }
    
    console.log('✅ Проверка API завершена');
    return true;
  } catch (err) {
    console.error('❌ Критическая ошибка при проверке API:', err.message);
    console.error('   Полная ошибка:', err);
    return false;
  }
}

module.exports = { initClient, loadReferenceList, calculatePrice, buyProxy, getProxyCredentials, testApiConnection, downloadProxies };