// 通用工具：错误、校验、规格与限制判断。所有金额为分（minor），数量为整数件。

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const fail = (status, code, message, details) => {
  throw new HttpError(status, code, message, details);
};
export const badRequest = (message, details) => fail(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = '缺少或无效的访问令牌') => fail(401, 'UNAUTHORIZED', message);
export const forbidden = (code, message, details) => fail(403, code, message, details);
export const notFound = (code, message, details) => fail(404, code, message, details);
export const conflict = (code, message, details) => fail(409, code, message, details);

export function requireRole(actor, roles) {
  if (!roles.includes(actor.role)) {
    forbidden('ROLE_NOT_ALLOWED', `该操作仅限角色：${roles.join('、')}，当前角色：${actor.role}`);
  }
}

export function assertPositiveInt(value, name = '数量') {
  if (!Number.isInteger(value) || value <= 0) badRequest(`${name}必须为正整数`, { value });
}

export function assertNonNegativeInt(value, name = '数量') {
  if (!Number.isInteger(value) || value < 0) badRequest(`${name}必须为非负整数`, { value });
}

// 用品规格：类别 + 尺码 + 适用年龄等。相似不等于相同，规格不符不能自动视为满足。
export function sameSpec(a, b) {
  return a.kind === b.kind && (a.size ?? null) === (b.size ?? null) && (a.age ?? null) === (b.age ?? null);
}

// 捐方限制：scope 为限定学校列表，purposes 为限定用品类别；空数组表示不限。
export function restrictionCovers(donor, school, kind) {
  if (!donor) return true;
  if (Array.isArray(donor.scope) && donor.scope.length > 0 && !donor.scope.includes(school)) return false;
  if (Array.isArray(donor.purposes) && donor.purposes.length > 0 && !donor.purposes.includes(kind)) return false;
  return true;
}

// 配捐比例：fixtures 中为字符串（如 "0.5"），解析为分子/分母避免浮点误差。
export function parseRatio(text) {
  const raw = String(text);
  const negative = raw.startsWith('-');
  const [intPart, fracPart = ''] = raw.replace(/^-/, '').split('.');
  const den = 10 ** fracPart.length;
  const num = Number(intPart) * den + Number(fracPart || 0);
  if (!Number.isFinite(num) || negative || num > den) badRequest('配捐比例必须在 0 到 1 之间', { ratio: text });
  return { num, den };
}

export const sumBy = (rows, field) => rows.reduce((total, row) => total + (row[field] ?? 0), 0);
