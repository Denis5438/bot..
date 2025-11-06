-- Migration: Add cm_id and indexes to user_proxies table
-- Description: Adds unique CM ID for each proxy and optimizes database structure

-- 1. Добавляем колонку cm_id (уникальный идентификатор в формате CM001, CM002...)
ALTER TABLE user_proxies 
ADD COLUMN IF NOT EXISTS cm_id TEXT UNIQUE;

-- 2. Создаем последовательность для генерации номеров CM ID
CREATE SEQUENCE IF NOT EXISTS cm_id_seq START WITH 1;

-- 3. Заполняем существующие записи уникальными cm_id
UPDATE user_proxies 
SET cm_id = 'CM' || LPAD(nextval('cm_id_seq')::TEXT, 6, '0')
WHERE cm_id IS NULL;

-- 4. Делаем cm_id обязательным после заполнения
ALTER TABLE user_proxies 
ALTER COLUMN cm_id SET NOT NULL;

-- 5. Добавляем индексы для оптимизации запросов

-- Индекс по telegram_id (для быстрого поиска прокси пользователя)
CREATE INDEX IF NOT EXISTS idx_user_proxies_telegram_id 
ON user_proxies(telegram_id);

-- Индекс по order_id (для связки с заказами)
CREATE INDEX IF NOT EXISTS idx_user_proxies_order_id 
ON user_proxies(order_id);

-- Индекс по proxy_id (для быстрого поиска по ID прокси от API)
CREATE INDEX IF NOT EXISTS idx_user_proxies_proxy_id 
ON user_proxies(proxy_id);

-- Композитный индекс для быстрого поиска прокси пользователя по стране
CREATE INDEX IF NOT EXISTS idx_user_proxies_user_country 
ON user_proxies(telegram_id, country);

-- Индекс по дате создания (для сортировки)
CREATE INDEX IF NOT EXISTS idx_user_proxies_created_at 
ON user_proxies(created_at DESC);

-- 6. Добавляем колонку status для отслеживания статуса прокси
ALTER TABLE user_proxies 
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';

-- Индекс по статусу
CREATE INDEX IF NOT EXISTS idx_user_proxies_status 
ON user_proxies(status);

-- 7. Добавляем колонку purchased_at для отслеживания времени покупки
ALTER TABLE user_proxies 
ADD COLUMN IF NOT EXISTS purchased_at TIMESTAMPTZ DEFAULT NOW();

-- 8. Оптимизируем таблицу users
CREATE INDEX IF NOT EXISTS idx_users_telegram_id 
ON users(telegram_id);

-- 9. Добавляем триггер для автоматической генерации cm_id
CREATE OR REPLACE FUNCTION generate_cm_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.cm_id IS NULL THEN
    NEW.cm_id := 'CM' || LPAD(nextval('cm_id_seq')::TEXT, 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Создаем триггер
DROP TRIGGER IF EXISTS trigger_generate_cm_id ON user_proxies;
CREATE TRIGGER trigger_generate_cm_id
  BEFORE INSERT ON user_proxies
  FOR EACH ROW
  EXECUTE FUNCTION generate_cm_id();

-- 10. Комментарии к таблице и колонкам
COMMENT ON TABLE user_proxies IS 'Таблица хранения прокси пользователей с уникальными CM ID';
COMMENT ON COLUMN user_proxies.cm_id IS 'Уникальный идентификатор прокси в формате CM000001';
COMMENT ON COLUMN user_proxies.telegram_id IS 'Telegram ID пользователя-владельца прокси';
COMMENT ON COLUMN user_proxies.proxy_id IS 'ID прокси из API Proxy-Seller';
COMMENT ON COLUMN user_proxies.order_id IS 'ID заказа из API Proxy-Seller';
COMMENT ON COLUMN user_proxies.status IS 'Статус прокси: active, expired, cancelled';

-- Анализируем таблицу для обновления статистики
ANALYZE user_proxies;
ANALYZE users;

