export const DEFAULT_CATEGORIES = [
  { name: 'Food',           icon: '🍔', color: '#f97316', kind: 'expense' },
  { name: 'Groceries',      icon: '🛒', color: '#22c55e', kind: 'expense' },
  { name: 'Transport',      icon: '🚕', color: '#3b82f6', kind: 'expense' },
  { name: 'Shopping',       icon: '🛍️', color: '#ec4899', kind: 'expense' },
  { name: 'Bills',          icon: '🧾', color: '#ef4444', kind: 'expense' },
  { name: 'Entertainment',  icon: '🎬', color: '#a855f7', kind: 'expense' },
  { name: 'Health',         icon: '💊', color: '#14b8a6', kind: 'expense' },
  { name: 'Education',      icon: '📚', color: '#6366f1', kind: 'expense' },
  { name: 'Travel',         icon: '✈️', color: '#0ea5e9', kind: 'expense' },
  { name: 'Subscriptions',  icon: '🔁', color: '#8b5cf6', kind: 'expense' },
  { name: 'Other',          icon: '💸', color: '#64748b', kind: 'expense' },
  { name: 'Salary',         icon: '💰', color: '#16a34a', kind: 'income' },
  { name: 'Freelance',      icon: '🧑‍💻', color: '#059669', kind: 'income' },
  { name: 'Refunds',        icon: '↩️', color: '#84cc16', kind: 'income' }
];

export const PAYMENT_METHODS = ['upi', 'card', 'cash', 'netbanking', 'wallet', 'other'];

export const ACHIEVEMENTS = [
  { code: 'first_expense',   name: 'First Step',        icon: '👣', description: 'Logged your very first expense' },
  { code: 'ten_expenses',    name: 'Getting Serious',   icon: '📝', description: 'Logged 10 expenses' },
  { code: 'fifty_expenses',  name: 'Power Tracker',     icon: '⚡', description: 'Logged 50 expenses' },
  { code: 'streak_7',        name: 'Week Warrior',      icon: '🔥', description: 'Tracked 7 days in a row' },
  { code: 'streak_30',       name: 'Habit Formed',      icon: '🏆', description: 'Tracked 30 days in a row' },
  { code: 'budget_set',      name: 'Planner',           icon: '🎯', description: 'Set your first budget' },
  { code: 'under_budget',    name: 'Disciplined',       icon: '🛡️', description: 'Finished a month under budget' },
  { code: 'goal_created',    name: 'Dreamer',           icon: '⭐', description: 'Created a savings goal' },
  { code: 'goal_reached',    name: 'Achiever',          icon: '🥇', description: 'Reached a savings goal' },
  { code: 'sub_hunter',      name: 'Subscription Hunter', icon: '🔍', description: 'Reviewed your detected subscriptions' },
  { code: 'split_master',    name: 'Split Master',      icon: '🤝', description: 'Settled a group expense' }
];
