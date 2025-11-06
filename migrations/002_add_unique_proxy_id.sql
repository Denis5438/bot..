-- Migration: Add UNIQUE constraint on proxy_id to prevent race conditions
-- This ensures that two users cannot claim the same proxy_id simultaneously

-- 1. Сначала удаляем дубликаты если они есть (оставляем только первый для каждого proxy_id)
DELETE FROM user_proxies
WHERE id NOT IN (
    SELECT MIN(id)
    FROM user_proxies
    WHERE proxy_id IS NOT NULL
    GROUP BY proxy_id
);

-- 2. Добавляем UNIQUE constraint на proxy_id
-- Это критично для предотвращения Race Condition!
ALTER TABLE user_proxies 
ADD CONSTRAINT unique_proxy_id UNIQUE (proxy_id);

-- 3. Создаём индекс если его еще нет (для быстрой проверки)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes 
        WHERE tablename = 'user_proxies' 
        AND indexname = 'idx_user_proxies_proxy_id'
    ) THEN
        CREATE INDEX idx_user_proxies_proxy_id ON user_proxies(proxy_id);
    END IF;
END $$;

-- 4. Добавляем комментарий к constraint
COMMENT ON CONSTRAINT unique_proxy_id ON user_proxies IS 
'Prevents race condition: ensures each proxy_id can only be assigned to one user';

COMMIT;

