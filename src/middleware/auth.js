'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');

const COOKIE = 'wa_token';

function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.full_name, email: user.email, role: user.role },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.nodeEnv === 'production',
    maxAge: 1000 * 60 * 60 * 12,
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE] || (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, env.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired, please sign in again' });
  }
}

/** Only allow the listed roles (e.g. requireRole('admin','manager')). */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do this' });
    }
    next();
  };
}

const canEdit = requireRole('admin', 'manager');
const adminOnly = requireRole('admin');

module.exports = { COOKIE, signToken, setAuthCookie, requireAuth, requireRole, canEdit, adminOnly };
