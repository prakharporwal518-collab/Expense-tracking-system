import { unprocessable } from './errors.js';

/**
 * A dependency-free schema validator. Each field declares a type plus optional
 * constraints; `validate` returns a *coerced* object so routes never have to
 * re-parse strings coming from JSON or query params.
 */
const CHECKS = {
  string(value, rule, field, errors) {
    if (typeof value !== 'string') { errors.push(`${field} must be a string`); return undefined; }
    const v = rule.trim === false ? value : value.trim();
    if (rule.min != null && v.length < rule.min) errors.push(`${field} must be at least ${rule.min} characters`);
    if (rule.max != null && v.length > rule.max) errors.push(`${field} must be at most ${rule.max} characters`);
    if (rule.pattern && !rule.pattern.test(v)) errors.push(rule.message || `${field} has an invalid format`);
    if (rule.enum && !rule.enum.includes(v)) errors.push(`${field} must be one of: ${rule.enum.join(', ')}`);
    return v;
  },
  number(value, rule, field, errors) {
    const n = typeof value === 'string' ? Number(value.trim()) : Number(value);
    if (!Number.isFinite(n)) { errors.push(`${field} must be a number`); return undefined; }
    if (rule.integer && !Number.isInteger(n)) errors.push(`${field} must be a whole number`);
    if (rule.min != null && n < rule.min) errors.push(`${field} must be >= ${rule.min}`);
    if (rule.max != null && n > rule.max) errors.push(`${field} must be <= ${rule.max}`);
    return n;
  },
  boolean(value, _rule, field, errors) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
    errors.push(`${field} must be a boolean`);
    return undefined;
  },
  date(value, rule, field, errors) {
    if (typeof value !== 'string' && !(value instanceof Date)) {
      errors.push(`${field} must be a date`); return undefined;
    }
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) { errors.push(`${field} must be a valid date`); return undefined; }
    if (rule.notFuture && d.getTime() > Date.now() + 86_400_000) errors.push(`${field} cannot be in the future`);
    return d.toISOString();
  },
  array(value, rule, field, errors) {
    if (!Array.isArray(value)) { errors.push(`${field} must be an array`); return undefined; }
    if (rule.max != null && value.length > rule.max) errors.push(`${field} may hold at most ${rule.max} items`);
    if (rule.of === 'string') {
      const cleaned = value.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
      return cleaned.slice(0, rule.max ?? cleaned.length);
    }
    return value;
  },
  object(value, _rule, field, errors) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${field} must be an object`); return undefined;
    }
    return value;
  }
};

export function validate(input, schema) {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  const errors = [];

  for (const [field, rule] of Object.entries(schema)) {
    const raw = source[field];
    const missing = raw === undefined || raw === null || raw === '';
    if (missing) {
      if (rule.required) errors.push(`${field} is required`);
      else if (rule.default !== undefined) out[field] = typeof rule.default === 'function' ? rule.default() : rule.default;
      continue;
    }
    const check = CHECKS[rule.type];
    if (!check) throw new Error(`Unknown validator type "${rule.type}" for ${field}`);
    const value = check(raw, rule, field, errors);
    if (value !== undefined) out[field] = value;
  }

  if (errors.length) throw unprocessable('Some fields did not pass validation', errors);
  return out;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
