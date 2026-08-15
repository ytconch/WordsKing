const FIELD_LIMITS = {
  username: { min: 3, max: 24 },
  displayName: { min: 1, max: 24 },
  password: { min: 6, max: 64 },
  recoveryNote: { min: 0, max: 160 },
  sourceName: { min: 1, max: 40 },
  unitName: { min: 1, max: 40 },
  notificationTitle: { min: 1, max: 40 },
  notificationMessage: { min: 1, max: 500 }
};

function createValidationError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validateTextField(value, label, options = {}) {
  const { min = 0, max = Infinity, required = true } = options;
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    if (required) {
      throw createValidationError(`${label}不能留白。`);
    }
    return "";
  }

  if (normalized.length < min) {
    throw createValidationError(`${label}至少需要 ${min} 個字元。`);
  }

  if (normalized.length > max) {
    throw createValidationError(`${label}不可超過 ${max} 個字元。`);
  }

  return normalized;
}

function validateSecretField(value, label, options = {}) {
  const { min = 0, max = Infinity, required = true } = options;
  const text = String(value ?? "");

  if (!text) {
    if (required) {
      throw createValidationError(`${label}不能留白。`);
    }
    return "";
  }

  if (text.length < min) {
    throw createValidationError(`${label}至少需要 ${min} 個字元。`);
  }

  if (text.length > max) {
    throw createValidationError(`${label}不可超過 ${max} 個字元。`);
  }

  return text;
}

module.exports = {
  FIELD_LIMITS,
  createValidationError,
  validateTextField,
  validateSecretField
};
