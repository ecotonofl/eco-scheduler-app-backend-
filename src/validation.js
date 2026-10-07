export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function text(value, field, { required = false, max = 2000 } = {}) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new ApiError(400, `${field} is invalid`);
  return value.trim();
}
export function id(value, field = 'ID') {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new ApiError(400, `${field} must be a positive integer`);
  return Number(value);
}
export function choice(value, allowed, field) {
  if (!allowed.includes(value)) throw new ApiError(400, `${field} is invalid`);
  return value;
}
export function date(value, field, optional = false) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new ApiError(400, `${field} must be a valid YYYY-MM-DD date`);
  return value;
}
export function time(value, field) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new ApiError(400, `${field} must use HH:mm`);
  return value;
}
export function number(value, field, { min = 0, max = 1000000, integer = false } = {}) {
  if (value === '' || value == null || typeof value === 'boolean' || (typeof value !== 'number' && typeof value !== 'string')) throw new ApiError(400, `${field} is invalid`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isSafeInteger(n))) throw new ApiError(400, `${field} is invalid`);
  return n;
}
export function link(value, field) {
  const v = text(value, field);
  if (!v) return '';
  try { const u = new URL(v); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); } catch { throw new ApiError(400, `${field} must be an http or https URL`); }
  return v;
}
