'use strict';
class AppError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code || 'error';
    this.details = details;
  }
}
const bad = (msg, details) => new AppError(400, msg, 'bad_request', details);
const unauthorized = (msg = 'Authentication required') => new AppError(401, msg, 'unauthorized');
const forbidden = (msg = 'You do not have permission to do this') => new AppError(403, msg, 'forbidden');
const notFound = (what = 'Resource') => new AppError(404, `${what} not found`, 'not_found');
const conflict = (msg) => new AppError(409, msg, 'conflict');
const unprocessable = (msg, details) => new AppError(422, msg, 'unprocessable', details);
module.exports = { AppError, bad, unauthorized, forbidden, notFound, conflict, unprocessable };
