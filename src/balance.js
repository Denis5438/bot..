// src/balance.js
// Простое хранилище баланса пользователей в памяти
// TODO: Перевести на PostgreSQL для персистентности

const userBalances = {};
const userPurchases = {}; // Количество купленных прокси

/**
 * Получить баланс пользователя
 */
function getBalance(userId) {
  return userBalances[userId] || 0;
}

/**
 * Добавить баланс пользователю
 */
function addBalance(userId, amount) {
  if (!userBalances[userId]) {
    userBalances[userId] = 0;
  }
  userBalances[userId] = parseFloat((userBalances[userId] + amount).toFixed(2));
  return userBalances[userId];
}

/**
 * Списать баланс пользователя
 */
function subtractBalance(userId, amount) {
  if (!userBalances[userId]) {
    userBalances[userId] = 0;
  }
  const newBalance = parseFloat((userBalances[userId] - amount).toFixed(2));
  if (newBalance < 0) {
    throw new Error('Недостаточно средств на балансе');
  }
  userBalances[userId] = newBalance;
  return userBalances[userId];
}

/**
 * Проверить, достаточно ли средств
 */
function hasEnoughBalance(userId, amount) {
  const balance = getBalance(userId);
  return balance >= amount;
}

/**
 * Получить количество купленных прокси
 */
function getPurchasedCount(userId) {
  return userPurchases[userId] || 0;
}

/**
 * Увеличить счётчик купленных прокси
 */
function incrementPurchasedCount(userId, count = 1) {
  if (!userPurchases[userId]) {
    userPurchases[userId] = 0;
  }
  userPurchases[userId] += count;
  return userPurchases[userId];
}

module.exports = {
  getBalance,
  addBalance,
  subtractBalance,
  hasEnoughBalance,
  getPurchasedCount,
  incrementPurchasedCount
};