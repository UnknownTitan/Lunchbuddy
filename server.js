import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import crypto from 'node:crypto';
import webpush from 'web-push';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'url';
import {
  initDb,
  getRoster,
  saveRoster,
  getUserById,
  updateUserById,
  getPlatformAdminByName,
  getDailyState,
  saveDailyState,
  getHistory,
  getHistoryForDates,
  saveHistory,
  getRemindersLog,
  saveRemindersLog,
  getSecuritySettings,
  saveSecuritySettings,
  getWeeklyPlan,
  saveWeeklyPlan,
  getAllWeeklyPlans,
  deleteWeeklyPlan,
  getCompanies,
  getCompanyById,
  getCompanyByCode,
  createCompany,
  updateCompany,
  seedCompanyDefaults,
  getDishes,
  getDishById,
  createDish,
  updateDish,
  setDishActive,
  saveDishImage,
  getDishImageById,
  deleteDishImage,
  getBranches,
  createBranch,
  updateBranch,
  deleteBranch,
  getHistoryInRange,
  getCompanySettings,
  saveCompanySettings,
  getScheduledNotifications,
  createScheduledNotification,
  updateScheduledNotification,
  logNotificationHistory,
  getNotificationHistory,
  getUserByEmail,
  createPasswordResetToken,
  getPasswordResetToken,
  markPasswordResetTokenUsed
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET is not set. Add it to your .env file.');
}
const TOKEN_EXPIRY = '8h';
const PASSCODE_SALT_ROUNDS = 10;

// Web Push (browser notifications) — optional. If unset, /api/push/* still
// respond, they just can't actually deliver anything; nothing else in the
// app depends on this being configured.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushEnabled) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications are disabled.');
}

// Passcode-reset email (Gmail SMTP) — optional, same graceful-degradation
// pattern as push above: if unset, /api/forgot-passcode still responds
// (generic message either way, to avoid confirming which emails exist) but
// nothing actually gets sent, and a warning is logged.
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const emailEnabled = !!(GMAIL_USER && GMAIL_APP_PASSWORD);
const emailTransporter = emailEnabled
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } })
  : null;
if (!emailEnabled) {
  console.warn('GMAIL_USER/GMAIL_APP_PASSWORD not set — passcode-reset emails are disabled.');
}

async function sendPasscodeResetEmail(toEmail, name, resetUrl) {
  if (!emailTransporter) {
    console.warn('sendPasscodeResetEmail: email is disabled (missing Gmail credentials) — nothing sent.');
    return;
  }
  await emailTransporter.sendMail({
    from: `Lunch Buddy <${GMAIL_USER}>`,
    to: toEmail,
    subject: 'Reset your Lunch Buddy passcode',
    text: `Hi ${name},\n\nSomeone requested a passcode reset for your Lunch Buddy account. Open this link to set a new passcode (it expires in 1 hour):\n\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email — your passcode won't change.`,
    html: `<p>Hi ${name},</p><p>Someone requested a passcode reset for your Lunch Buddy account. Click below to set a new one (this link expires in 1 hour):</p><p><a href="${resetUrl}">Reset my passcode</a></p><p>If you didn't request this, you can safely ignore this email — your passcode won't change.</p>`
  });
}

// Bounds accepted when an admin edits login-throttling settings
const SECURITY_SETTINGS_BOUNDS = {
  loginMaxFailedAttempts: { min: 1, max: 20 },
  loginLockoutMinutes: { min: 1, max: 1440 },
  loginRateLimitMax: { min: 1, max: 100 },
  loginRateLimitWindowMinutes: { min: 1, max: 1440 }
};

// Helper: turn a millisecond duration into "Xm Ys" / "Ys" for user-facing messages
function formatDuration(ms) {
  const totalSecs = Math.max(1, Math.ceil(ms / 1000));
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins === 0) return `${secs}s`;
  return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`;
}

// Endpoints reachable even while a user is blocked pending a passcode change
const PASSCODE_CHANGE_EXEMPT_PATHS = new Set(['/api/change-passcode', '/api/me']);

// Roles a company Admin is allowed to assign. Platform Admin is deliberately
// excluded — without this whitelist a company Admin could PUT their own
// role to 'Platform Admin' and escalate to platform control.
const COMPANY_ROLES = ['Admin', 'Abigail', 'Team Member'];

const COMPANY_CODE_REGEX = /^[A-Z0-9][A-Z0-9-]{2,11}$/;

const MAX_ORDER_NOTE_LENGTH = 140;

// Helper: trim and cap a free-text order note (e.g. protein choice, allergies)
function sanitizeOrderNote(note) {
  if (typeof note !== 'string') return '';
  return note.trim().slice(0, MAX_ORDER_NOTE_LENGTH);
}

// Helper: normalize a dish name for matching — mirrors the client's
// getDishImage() lookup so "Fried Rice" and "fried rice " are the same dish.
function normalizeDishName(name) {
  return String(name || '').trim().toLowerCase();
}

// Helper: find a menu item by name rather than id — dish ids regenerate
// whenever the admin re-saves the menu (see /api/menu), so name is the only
// durable key for matching a weekly plan entry against a future day's menu.
function findMenuItemByName(menu, dishName) {
  const key = normalizeDishName(dishName);
  if (!key) return null;
  return (menu || []).find(m => normalizeDishName(m.name) === key) || null;
}

// Helper: write a real order for a user on the given (already-loaded)
// dailyState. Shared by the self-serve endpoint, the admin assign endpoint's
// "today" path, and the weekly-plan rollover applier — one place that
// decides what an "order" object looks like.
function writeOrderForUser(dailyState, userId, itemId, note, extra = {}) {
  dailyState.orders = dailyState.orders || {};
  dailyState.orders[userId] = {
    itemId,
    timestamp: Date.now(),
    note: sanitizeOrderNote(note),
    ...extra
  };
  return dailyState.orders[userId];
}

// A small, deliberately-not-exhaustive blocklist of passcodes that defeat
// the point of requiring one. Length + this list catch the common failures
// without pretending to be a real password-strength library.
const WEAK_PASSCODES = new Set([
  '12345678', 'password', 'passcode', 'changeme', 'rfdfood', 'pass123', 'admin123'
]);

function generatePasscode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I/L)
  return Array.from(crypto.randomBytes(8), b => alphabet[b % alphabet.length]).join('');
}

function validatePasscode(passcode, user = {}) {
  if (typeof passcode !== 'string' || passcode.length < 8) {
    return 'Passcode must be at least 8 characters.';
  }
  if (/^\d+$/.test(passcode)) {
    return 'Passcode cannot be all digits.';
  }
  if (WEAK_PASSCODES.has(passcode.toLowerCase())) {
    return 'Passcode is too common.';
  }
  const nameParts = [user.name, (user.email || '').split('@')[0]]
    .filter(Boolean)
    .map(s => s.toLowerCase());
  if (nameParts.some(p => p && passcode.toLowerCase().includes(p))) {
    return 'Passcode cannot contain your name or email.';
  }
  return null;
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(morgan('dev'));
// Raised from the 100kb default to fit a base64-encoded dish image
// (client caps originals at ~300KB before upload — see /api/dishes/:id/image).
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Client-side route: the Platform Admin login screen lives at the same
// index.html, keyed off location.pathname in app.js.
app.get('/platform', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Client-side route: the "set a new passcode" screen a forgot-passcode
// email links to (?token=... is read client-side, same SPA either way).
app.get('/reset-passcode', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize database
await initDb();

// ---- Company resolution ----
// Small in-memory caches (by code and by id) — companies are created rarely
// and read on nearly every request, so this avoids a DB round-trip per call.
// Only hits are cached; a miss (unknown code) just falls through to the DB
// again next time, which is fine at this scale and avoids ever caching a
// stale "doesn't exist" for a company created moments ago.
const companyCacheByCode = new Map();
const companyCacheById = new Map();

function cacheCompany(company) {
  companyCacheByCode.set(company.code, company);
  companyCacheById.set(company._id, company);
}

function invalidateCompanyCache(company) {
  if (!company) return;
  companyCacheByCode.delete(company.code);
  companyCacheById.delete(company._id);
}

// Reads x-company-code, resolves it to a company, and sets req.companyId /
// req.company if found and active. Never rejects — an absent or unknown
// code just leaves req.companyId null, and routes decide what to do with
// that. Runs before auth, so this value is untrusted; authMiddleware
// overwrites req.companyId from the verified user record for any
// authenticated request (see the comment there).
async function resolveCompanyMiddleware(req, res, next) {
  req.companyId = null;
  req.company = null;
  const rawCode = req.headers['x-company-code'];
  if (rawCode) {
    const code = String(rawCode).trim().toUpperCase();
    let company = companyCacheByCode.get(code);
    if (!company) {
      company = await getCompanyByCode(code);
      if (company) cacheCompany(company);
    }
    if (company && company.status === 'active') {
      req.companyId = company._id;
      req.company = company;
    }
  }
  next();
}
app.use('/api', resolveCompanyMiddleware);

// Per-company login-throttling settings, lazily cached and self-healing
// (creates defaults on first read if a company somehow has none).
const securitySettingsCache = new Map();

function defaultSecuritySettings() {
  return {
    loginMaxFailedAttempts: Number(process.env.LOGIN_MAX_FAILED_ATTEMPTS) || 5,
    loginLockoutMinutes: Number(process.env.LOGIN_LOCKOUT_MINUTES) || 15,
    loginRateLimitMax: Number(process.env.LOGIN_RATE_LIMIT_MAX) || 5,
    loginRateLimitWindowMinutes: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES) || 15
  };
}

async function getSecuritySettingsCached(companyId) {
  if (!securitySettingsCache.has(companyId)) {
    let settings = await getSecuritySettings(companyId);
    if (!settings) {
      settings = defaultSecuritySettings();
      await saveSecuritySettings(companyId, settings);
    }
    securitySettingsCache.set(companyId, settings);
  }
  return securitySettingsCache.get(companyId);
}

function invalidateSecuritySettingsCache(companyId) {
  securitySettingsCache.delete(companyId);
}

// Helper: Format a Date as YYYY-MM-DD (local time)
function formatDateString(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const date = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${date}`;
}

// Helper: Get local date string YYYY-MM-DD
function getLocalDateString() {
  return formatDateString(new Date());
}

const DEFAULT_ARCHIVE_TIME = '14:00';

// Helper: The "business date" the app is currently operating on. Once the
// daily archive time passes, today's session is archived and the app rolls
// straight into tomorrow's business date rather than waiting for midnight.
function getBusinessDateString(archiveTime) {
  const [archiveHour, archiveMin] = (archiveTime || DEFAULT_ARCHIVE_TIME).split(':').map(Number);
  const now = new Date();
  const pastArchiveTime = now.getHours() > archiveHour ||
    (now.getHours() === archiveHour && now.getMinutes() >= archiveMin);

  if (pastArchiveTime) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return formatDateString(tomorrow);
  }
  return formatDateString(now);
}

// Helper: The cutoff Date/time for an ARBITRARY date string, given the
// single recurring daily cutoffTime — this applies unchanged to any date
// since it's a time-of-day, not a date-specific setting. cutoffExtensionMinutes
// is deliberately scoped to the CURRENT business date only: extra time an
// admin grants today must not silently extend some other day's cutoff too.
function getEffectiveCutoffDateFor(dailyState, dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [cutoffHour, cutoffMin] = (dailyState.cutoffTime || '00:00').split(':').map(Number);
  const cutoffDate = new Date(year, month - 1, day, cutoffHour, cutoffMin, 0, 0);
  if (dateStr === dailyState.date) {
    cutoffDate.setMinutes(cutoffDate.getMinutes() + (dailyState.cutoffExtensionMinutes || 0));
  }
  return cutoffDate;
}

// Helper: The actual cutoff Date/time for the current business date, after
// adding any extra minutes an admin has granted (see /api/cutoff/extend).
// Anchoring to dailyState.date (not just the wall-clock hour:minute) matters
// because a business date can span from archiveTime one calendar day to
// archiveTime the next — a bare hour:minute comparison would treat a brand
// new business date as already-past-cutoff for the rest of that calendar day.
function getEffectiveCutoffDate(dailyState) {
  return getEffectiveCutoffDateFor(dailyState, dailyState.date);
}

// Helper: Format a Date's time-of-day back to an HH:MM string
function formatMinutesAsHHMM(date) {
  const hour = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${hour}:${min}`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Helper: which weekday (0=Sun..6=Sat) an arbitrary YYYY-MM-DD date falls on
function getWeekdayForDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day).getDay();
}

// Helper: which weekday (0=Sun..6=Sat) the current business date falls on
function getBusinessDateWeekday(dailyState) {
  return getWeekdayForDate(dailyState.date);
}

// Helper: is an arbitrary date one Lunch Buddy is open on? Missing/empty
// operationalDays means "every day" — existing deployments keep working
// exactly as before until an admin actually configures this.
function isOperationalDate(dailyState, dateStr) {
  const days = dailyState.operationalDays;
  if (!Array.isArray(days) || days.length === 0) return true;
  if (!dateStr) return true;
  return days.includes(getWeekdayForDate(dateStr));
}

// Helper: is today's business date one Lunch Buddy is open on?
function isOperationalDay(dailyState) {
  return isOperationalDate(dailyState, dailyState.date);
}

// Helper: name of the next day Lunch Buddy will be open, starting the
// search the day after today's business date.
function getNextOperationalDayName(dailyState) {
  const days = dailyState.operationalDays;
  if (!Array.isArray(days) || days.length === 0 || !dailyState.date) return null;
  const todayWeekday = getBusinessDateWeekday(dailyState);
  for (let offset = 1; offset <= 7; offset++) {
    const candidate = (todayWeekday + offset) % 7;
    if (days.includes(candidate)) return DAY_NAMES[candidate];
  }
  return null;
}

// Helper: Check if orders are locked (manual lock OR effective cutoff time passed)
function checkCutoff(dailyState) {
  // Admin can force-lock early regardless of time
  if (dailyState.isManuallyLocked === true) return true;

  if (!dailyState.cutoffTime || !dailyState.date) return false;
  return Date.now() >= getEffectiveCutoffDate(dailyState).getTime();
}

// Helper: is an arbitrary date locked for editing? Past dates are always
// locked (already archived); today follows the real checkCutoff (including
// manual lock); future dates are never locked (they haven't had a chance to).
function isDateLocked(dailyState, dateStr) {
  if (!dailyState.date) return false;
  if (dateStr < dailyState.date) return true;
  if (dateStr === dailyState.date) return checkCutoff(dailyState);
  return false;
}

// Helper: the Monday..Sunday dates of the calendar week containing the
// current business date, filtered down to only the operational days — this
// is the row of day-cards the weekly planner shows. Always the CURRENT week
// (never jumps ahead just because today is late in the week), so days
// before today naturally render as past/read-only and today renders live.
function getPlanWeekDates(dailyState) {
  if (!dailyState.date) return [];
  const [year, month, day] = dailyState.date.split('-').map(Number);
  const today = new Date(year, month - 1, day);
  const isoWeekday = today.getDay() === 0 ? 7 : today.getDay(); // Mon=1..Sun=7
  const monday = new Date(today);
  monday.setDate(monday.getDate() - (isoWeekday - 1));

  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const dateStr = formatDateString(d);
    if (isOperationalDate(dailyState, dateStr)) dates.push(dateStr);
  }
  return dates;
}

// Helper: Archive daily state to history
async function archiveCurrentDay(companyId, dailyState) {
  if (dailyState.date && (dailyState.menu.length > 0 || Object.keys(dailyState.orders || {}).length > 0)) {
    const history = await getHistory(companyId);
    const existingIndex = history.findIndex(h => h.date === dailyState.date);

    const roster = await getRoster(companyId);
    const rosterMap = {};
    roster.forEach(u => {
      rosterMap[u.id] = { name: u.name, role: u.role, email: u.email, phone: u.phone };
    });

    const archiveEntry = {
      date: dailyState.date,
      menu: dailyState.menu,
      orders: dailyState.orders || {},
      rosterSnapshot: rosterMap,
      archivedAt: new Date().toISOString()
    };

    if (existingIndex !== -1) {
      history[existingIndex] = archiveEntry;
    } else {
      history.push(archiveEntry);
    }
    await saveHistory(companyId, history);
  }
}

// Helper: convert saved weekly plan entries for dailyState.date into real
// orders, matched by dish NAME against whatever menu is actually live right
// now. A plan is a pre-fill, never a bypass: if the menu isn't published yet,
// the day isn't operational, cutoff already passed, or the named dish is
// gone from the menu, the entry is simply dropped and the person picks
// manually — that's the intended fallback, not an error.
// Mutates `dailyState.orders` (and, on success, `dailyState.weeklyPlansAppliedDate`)
// in place. Returns true if it ran to completion (the caller must save
// dailyState either way in that case — even if no order actually changed,
// the applied-date marker did); false if it bailed out to retry later.
async function applyWeeklyPlansForDate(companyId, dailyState) {
  if (
    !dailyState.date ||
    !dailyState.menuPublished ||
    !dailyState.menu?.length ||
    !isOperationalDay(dailyState) ||
    checkCutoff(dailyState)
  ) {
    return false;
  }

  const roster = await getRoster(companyId);
  const rosterIds = new Set(roster.map(u => u.id));
  const plans = await getAllWeeklyPlans(companyId);

  for (const plan of plans) {
    const userId = plan.userId;
    if (!plan.entries || !rosterIds.has(userId)) continue;

    let planChanged = false;

    // Prune entries for dates that have already gone by — they're either
    // already applied (below) or were skipped days that are now moot.
    for (const date of Object.keys(plan.entries)) {
      if (date < dailyState.date) {
        delete plan.entries[date];
        planChanged = true;
      }
    }

    const entry = plan.entries[dailyState.date];
    if (entry) {
      if (!dailyState.orders?.[userId]) {
        // A manual pick always wins over a plan, so only apply if the user
        // hasn't already placed a real order for today some other way.
        const matched = findMenuItemByName(dailyState.menu, entry.dishName);
        if (matched) {
          writeOrderForUser(dailyState, userId, matched.id, entry.note, { viaWeeklyPlan: true });
        }
      }
      delete plan.entries[dailyState.date];
      planChanged = true;
    }

    if (planChanged) {
      plan.updatedAt = Date.now();
      await saveWeeklyPlan(companyId, userId, plan);
    }
  }

  dailyState.weeklyPlansAppliedDate = dailyState.date;
  return true;
}

// Paths that never need the per-company daily rollover — either genuinely
// global (VAPID key), or pre-company-resolution / platform-scoped, where
// there's no per-company dailyState to roll over in the first place.
const ROLLOVER_EXEMPT_PATHS = new Set([
  '/api/push/vapid-public-key',
  '/api/company/resolve',
  '/api/platform/login'
]);

// Middleware: Check and handle daily transition/reset, per company.
// Serializes the check-archive-save sequence below across concurrent
// requests FOR THE SAME COMPANY. Without this, two requests landing close
// together right as the business date rolls over can both read the same
// stale dailyState.date, both decide "this needs archiving," and both write
// a duplicate history entry — chaining onto that company's own promise
// instead of a boolean flag closes the race regardless of how many requests
// arrive in the same tick. Bounded by company count, so no eviction needed.
const dailyRolloverChains = new Map();

async function handleDailyResetMiddleware(req, res, next) {
  if (!req.companyId || ROLLOVER_EXEMPT_PATHS.has(req.path) || req.path.startsWith('/api/companies')) {
    return next();
  }
  const companyId = req.companyId;
  const previous = dailyRolloverChains.get(companyId) || Promise.resolve();

  const run = previous.then(async () => {
    const dailyState = await getDailyState(companyId);
    const businessDate = getBusinessDateString(dailyState.archiveTime);

    if (!dailyState.date) {
      dailyState.date = businessDate;
      await applyWeeklyPlansForDate(companyId, dailyState);
      await saveDailyState(companyId, dailyState);
    } else if (dailyState.date !== businessDate) {
      // Archive time has passed, archive the previous business day
      await archiveCurrentDay(companyId, dailyState);

      // Reset daily state for the new business day
      dailyState.date = businessDate;
      dailyState.orders = {};
      dailyState.isManuallyLocked = null; // clear override; revert to time-based
      dailyState.cutoffExtensionMinutes = 0; // clear any extra time granted yesterday
      dailyState.foodArrival = null; // clear yesterday's "food's in" broadcast
      dailyState.autoReminderFiredMinutes = []; // let today's checkpoints fire fresh
      // Retain menu, menuPublished, cutoffTime and archiveTime — the menu
      // carries over day to day until an admin changes it
      await applyWeeklyPlansForDate(companyId, dailyState); // must run after orders={} above
      await saveDailyState(companyId, dailyState);
    } else if (dailyState.weeklyPlansAppliedDate !== businessDate) {
      // The apply bailed earlier today (e.g. menu wasn't published yet at
      // rollover time) — retry on every request until it succeeds. Cheap:
      // once weeklyPlansAppliedDate is set, this branch never runs again today.
      if (await applyWeeklyPlansForDate(companyId, dailyState)) {
        await saveDailyState(companyId, dailyState);
      }
    }
  });
  dailyRolloverChains.set(companyId, run.catch(() => {})); // keep the chain alive even if this run throws

  try {
    await run;
    next();
  } catch (err) {
    console.error('Error in handleDailyResetMiddleware:', err);
    res.status(500).json({ error: 'Internal Database Error' });
  }
}

// Apply transition check on all API routes
app.use('/api', handleDailyResetMiddleware);

// Helper: hash a plaintext passcode for storage
async function hashPasscode(plain) {
  return bcrypt.hash(plain, PASSCODE_SALT_ROUNDS);
}

// Helper: issue a short-lived signed session token after a verified login
function issueToken(user) {
  return jwt.sign({ userId: user.id }, SESSION_SECRET, { expiresIn: TOKEN_EXPIRY });
}

// Middleware: Authenticate request via signed session token & attach req.user.
// The token is only ever issued after a verified passcode check, so a valid
// token is proof of identity for every role — there's no separate
// per-request passcode check to bypass.
//
// SECURITY-CRITICAL: this overwrites req.companyId with the value from the
// freshly-read user record, NOT whatever resolveCompanyMiddleware set from
// the (client-controlled) x-company-code header. A forged header on an
// authenticated request is simply ignored from this point on — every
// company-scoped db.js call downstream of authMiddleware must use
// req.user.companyId (or req.companyId, which is now the same value), never
// the raw header. This is the entire tenant-isolation guarantee.
async function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Session token missing.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, SESSION_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }

  const user = await getUserById(decoded.userId);

  if (!user) {
    return res.status(401).json({ error: 'User not found in roster.' });
  }

  // Reject tokens issued before the user's most recent passcode change —
  // otherwise a passcode change/reset wouldn't actually revoke access from
  // whoever already held a valid token for that account. JWT `iat` only has
  // second precision, so allow a 1s grace window against the millisecond
  // `passcodeChangedAt` timestamp to avoid rejecting the very token that
  // gets reissued in the same instant as the change.
  if (user.passcodeChangedAt && decoded.iat * 1000 < user.passcodeChangedAt - 1000) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  // A leaked/guessed shared or admin-assigned passcode should be able to do
  // exactly one thing: set a new one. Block everything else until it's changed.
  if (user.mustChangePasscode && !PASSCODE_CHANGE_EXEMPT_PATHS.has(req.path)) {
    return res.status(403).json({
      error: 'You must set a new passcode before continuing.',
      code: 'PASSCODE_CHANGE_REQUIRED'
    });
  }

  req.user = user;
  req.companyId = user.companyId ?? null;
  next();
}

// Role restriction helpers
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'Admin') {
    next();
  } else {
    res.status(403).json({ error: 'Access denied. Admin role required.' });
  }
}

function requireAdminOrAbigail(req, res, next) {
  if (req.user && (req.user.role === 'Admin' || req.user.role === 'Abigail')) {
    next();
  } else {
    res.status(403).json({ error: 'Access denied. Admin or Abigail role required.' });
  }
}

// Platform Admin is a distinct tier, not a superset of company Admin — it
// deliberately fails requireAdmin/requireAdminOrAbigail (blast-radius
// containment: a platform account can manage companies but can never touch
// a company's roster, menu, or orders).
function requirePlatformAdmin(req, res, next) {
  if (req.user && req.user.role === 'Platform Admin') {
    next();
  } else {
    res.status(403).json({ error: 'Access denied. Platform Admin role required.' });
  }
}

// A company-scoped route gated only by authMiddleware (no role requirement)
// must still reject a Platform Admin session — they have no companyId, and
// every db.js call here is companyId-scoped.
function requireCompanyUser(req, res, next) {
  if (req.user && req.user.companyId) {
    next();
  } else {
    res.status(403).json({ error: 'This action requires a company account.' });
  }
}

// --- Endpoints ---

// Slow down brute-forcing of the (short, numeric-ish) passcode. A single
// shared instance across all companies/platform logins — the meaningful,
// per-company-tunable defense is the account lockout below (driven by each
// company's own securitySettings); this is just a lighter-weight first line
// against rapid automated attempts, and it already keys by the account being
// logged into rather than IP, so it's effectively per-account already.
function buildLoginRateLimiter(settings) {
  const windowMs = settings.loginRateLimitWindowMinutes * 60 * 1000;
  return rateLimit({
    windowMs,
    max: settings.loginRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.body?.userId || req.body?.name || ipKeyGenerator(req.ip),
    handler: (req, res) => {
      const remainingMs = req.rateLimit?.resetTime
        ? req.rateLimit.resetTime.getTime() - Date.now()
        : windowMs;
      res.status(429).json({
        error: `Too many login attempts. Try again in ${formatDuration(remainingMs)}.`,
        retryAfterMs: Math.max(0, remainingMs)
      });
    }
  });
}

const loginRateLimiterInstance = buildLoginRateLimiter(defaultSecuritySettings());

const companyResolveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: (req, res) => res.status(429).json({ error: 'Too many attempts. Try again later.' })
});

// Shared verify/lockout/issue-token body for both /api/login and
// /api/platform/login, so lockout semantics can't drift between the two.
async function attemptLogin(user, passcode, settings) {
  const now = Date.now();
  if (user.lockedUntil && user.lockedUntil > now) {
    return {
      ok: false, status: 429,
      body: {
        error: `Account temporarily locked due to repeated failed attempts. Try again in ${formatDuration(user.lockedUntil - now)}.`,
        retryAfterMs: user.lockedUntil - now
      }
    };
  }

  const valid = user.passcodeHash && await bcrypt.compare(passcode, user.passcodeHash);
  if (!valid) {
    const loginLockoutMs = settings.loginLockoutMinutes * 60 * 1000;
    const fails = (user.failedAttempts || 0) + 1;
    const patch = { failedAttempts: fails };
    if (fails >= settings.loginMaxFailedAttempts) {
      patch.lockedUntil = now + loginLockoutMs;
      patch.failedAttempts = 0;
      await updateUserById(user.id, patch);
      return {
        ok: false, status: 429,
        body: {
          error: `Too many failed attempts. Account locked for ${formatDuration(loginLockoutMs)}.`,
          retryAfterMs: loginLockoutMs
        }
      };
    }
    await updateUserById(user.id, patch);
    const remaining = settings.loginMaxFailedAttempts - fails;
    return {
      ok: false, status: 401,
      body: { error: `Incorrect passcode. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining before your account is locked.` }
    };
  }

  if (user.failedAttempts || user.lockedUntil) {
    await updateUserById(user.id, { failedAttempts: 0, lockedUntil: null });
  }

  const { passcodeHash: _, ...safeUser } = user;
  const token = issueToken(user);
  return { ok: true, token, safeUser };
}

// Public: resolve a company code to its id/name, for the pre-login
// company-code screen. Its own IP-keyed rate limiter since there's no
// per-account lockout behind it the way login has.
app.post('/api/company/resolve', companyResolveLimiter, async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Company code is required.' });
  }
  const company = await getCompanyByCode(code);
  if (!company || company.status !== 'active') {
    return res.status(404).json({ error: 'Company not found.' });
  }
  cacheCompany(company);
  res.json({ id: company._id, code: company.code, name: company.name });
});

// Login: verify passcode, issue a signed session token
app.post('/api/login', (req, res, next) => loginRateLimiterInstance(req, res, next), async (req, res) => {
  const { userId, passcode } = req.body;
  if (!userId || !passcode) {
    return res.status(400).json({ error: 'User ID and passcode are required.' });
  }
  if (!req.companyId) {
    return res.status(400).json({ error: 'Company not resolved. Enter your company code first.', code: 'COMPANY_CODE_REQUIRED' });
  }

  const user = await getUserById(userId);
  // Same 404 whether the id doesn't exist at all or belongs to a different
  // company — this endpoint never confirms a userId exists elsewhere.
  if (!user || user.companyId !== req.companyId) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const settings = await getSecuritySettingsCached(req.companyId);
  const result = await attemptLogin(user, passcode, settings);
  if (!result.ok) return res.status(result.status).json(result.body);
  res.json({ success: true, token: result.token, user: result.safeUser });
});

// Platform Admin login — separate, non-enumerable route (name + passcode
// text entry, not a public dropdown; publishing platform-admin names via an
// unauthenticated list endpoint would be a recon risk on privileged accounts).
app.post('/api/platform/login', (req, res, next) => loginRateLimiterInstance(req, res, next), async (req, res) => {
  const { name, passcode } = req.body;
  if (!name || !passcode) {
    return res.status(400).json({ error: 'Name and passcode are required.' });
  }
  const user = await getPlatformAdminByName(name);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }
  const result = await attemptLogin(user, passcode, defaultSecuritySettings());
  if (!result.ok) return res.status(result.status).json(result.body);
  res.json({ success: true, token: result.token, user: result.safeUser });
});

// Verify an existing session token and return the current user (used to
// silently restore a saved session on page load, without re-sending a
// passcode over the wire).
app.get('/api/me', authMiddleware, async (req, res) => {
  const { passcodeHash: _, ...safeUser } = req.user;
  res.json({ success: true, user: safeUser });
});

// Self-service: set a new passcode. A valid session token is proof enough
// of identity (no need to re-verify the current passcode). Used both for
// the mandatory first-login change and any later voluntary change. Works
// for company users and Platform Admins alike (targeted patch by id, no
// companyId dependency).
app.post('/api/change-passcode', authMiddleware, async (req, res) => {
  const { newPasscode } = req.body;
  const validationError = validatePasscode(newPasscode, req.user);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const patch = {
    passcodeHash: await hashPasscode(newPasscode),
    mustChangePasscode: false,
    passcodeChangedAt: Date.now()
  };
  await updateUserById(req.user.id, patch);

  const { passcodeHash: _, ...restOfUser } = req.user;
  const safeUser = { ...restOfUser, mustChangePasscode: false, passcodeChangedAt: patch.passcodeChangedAt };
  // Reissue the token: authMiddleware rejects tokens older than
  // passcodeChangedAt, which would otherwise invalidate the very request
  // that just changed it.
  const token = issueToken(req.user);
  res.json({ success: true, token, user: safeUser });
});

const forgotPasscodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: (req, res) => res.status(429).json({ error: 'Too many attempts. Try again later.' })
});

// Public, pre-login: request a passcode-reset email. Deliberately responds
// with the same generic message whether or not the email matches an
// account — confirming/denying an email's existence to an unauthenticated
// caller is exactly the recon risk the login-list endpoint's own comment
// already warns about. Own rate limiter (tighter than login's, since a
// successful hit here sends real email — no point throttling by account
// the way login does when there's no "account" identified yet).
app.post('/api/forgot-passcode', forgotPasscodeLimiter, async (req, res) => {
  const { email } = req.body;
  const genericResponse = { success: true, message: 'If an account with that email exists, a reset link has been sent.' };

  if (!email || !req.companyId) {
    return res.json(genericResponse);
  }

  const user = await getUserByEmail(req.companyId, email);
  if (!user) {
    return res.json(genericResponse);
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await createPasswordResetToken(req.companyId, { token, userId: user.id, expiresAt });

  const resetUrl = `${req.protocol}://${req.get('host')}/reset-passcode?token=${token}`;
  sendPasscodeResetEmail(user.email, user.name, resetUrl)
    .catch(err => console.error('Error sending passcode-reset email:', err));

  res.json(genericResponse);
});

// Public: complete a passcode reset from the emailed link's token.
app.post('/api/reset-passcode', async (req, res) => {
  const { token, newPasscode } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Reset token is required.' });
  }

  const resetDoc = await getPasswordResetToken(token);
  if (!resetDoc || resetDoc.used || new Date(resetDoc.expiresAt).getTime() < Date.now()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  }

  const user = await getUserById(resetDoc.userId);
  if (!user) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  }

  const validationError = validatePasscode(newPasscode, user);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  await updateUserById(user.id, {
    passcodeHash: await hashPasscode(newPasscode),
    mustChangePasscode: false,
    passcodeChangedAt: Date.now(),
    failedAttempts: 0,
    lockedUntil: null
  });
  await markPasswordResetTokenUsed(token);

  res.json({ success: true });
});

// Public, pre-login: just enough for the login name-picker. No email, phone,
// role, or passcode status — that's PII/recon value an unauthenticated
// caller has no reason to see.
app.get('/api/roster/login-list', async (req, res) => {
  if (!req.companyId) {
    return res.status(400).json({ error: 'Company not resolved. Enter your company code first.', code: 'COMPANY_CODE_REQUIRED' });
  }
  const roster = await getRoster(req.companyId);
  res.json(roster.map(u => ({ id: u.id, name: u.name })));
});

// Retrieve full team roster (never exposes passcode data, hashed or
// otherwise) — requires a verified session; this is real PII (email, phone).
app.get('/api/roster', authMiddleware, requireCompanyUser, async (req, res) => {
  const roster = await getRoster(req.user.companyId);
  const safeRoster = roster.map(({ passcode, passcodeHash, pushSubscriptions, ...rest }) => ({
    ...rest,
    hasPasscode: !!passcodeHash
  }));
  res.json(safeRoster);
});

// Admin: Add a user
app.post('/api/roster', authMiddleware, requireAdmin, async (req, res) => {
  const { name, email, phone, role, passcode, branchId } = req.body;
  if (!name || !role) {
    return res.status(400).json({ error: 'Name and Role are required.' });
  }
  if (!COMPANY_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }

  const companyId = req.user.companyId;
  const roster = await getRoster(companyId);
  if (roster.some(u => u.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: 'A team member with this name already exists.' });
  }

  // No shared constant default — generate a unique random passcode per
  // person when the admin doesn't set one explicitly.
  const initialPasscode = passcode || generatePasscode();
  if (passcode) {
    const validationError = validatePasscode(passcode, { name, email });
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
  }

  const newUser = {
    id: `usr-${Date.now()}`,
    companyId,
    name,
    email: email || '',
    phone: phone || '',
    role,
    branchId: branchId || null,
    passcodeHash: await hashPasscode(initialPasscode),
    passcodeChangedAt: Date.now(),
    // An admin-assigned passcode is known to more than just this person —
    // require them to set their own the first time they log in.
    mustChangePasscode: true
  };

  roster.push(newUser);
  await saveRoster(companyId, roster);
  const { passcodeHash: _, ...safeUser } = newUser;
  // Returned once so the admin can share it securely — it can't be
  // retrieved again after this response.
  res.status(201).json({ ...safeUser, initialPasscode });
});

// Admin: Edit a user
app.put('/api/roster/:id', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, role, passcode, branchId } = req.body;

  const companyId = req.user.companyId;
  const roster = await getRoster(companyId);
  const userIndex = roster.findIndex(u => u.id === id);

  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found.' });
  }

  if (role && !COMPANY_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }

  if (role && role !== 'Admin' && roster[userIndex].role === 'Admin') {
    const otherAdmins = roster.filter(u => u.role === 'Admin' && u.id !== id);
    if (otherAdmins.length === 0) {
      return res.status(400).json({ error: 'Cannot change role: this is the last Admin for this company.' });
    }
  }

  if (name && roster.some(u => u.id !== id && u.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: 'Another team member with this name already exists.' });
  }

  if (passcode) {
    const validationError = validatePasscode(passcode, {
      name: name || roster[userIndex].name,
      email: email !== undefined ? email : roster[userIndex].email
    });
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
  }

  const updatedUser = {
    ...roster[userIndex],
    name: name || roster[userIndex].name,
    email: email !== undefined ? email : roster[userIndex].email,
    phone: phone !== undefined ? phone : roster[userIndex].phone,
    role: role || roster[userIndex].role,
    branchId: branchId !== undefined ? (branchId || null) : roster[userIndex].branchId,
    passcodeHash: passcode ? await hashPasscode(passcode) : roster[userIndex].passcodeHash,
    passcodeChangedAt: passcode ? Date.now() : roster[userIndex].passcodeChangedAt,
    // Any admin-set passcode (including a reset) is known to the admin too —
    // require the person to set their own before it's trusted as private.
    mustChangePasscode: passcode ? true : roster[userIndex].mustChangePasscode
  };

  roster[userIndex] = updatedUser;
  await saveRoster(companyId, roster);
  const { passcodeHash: _, ...safeUser } = updatedUser;
  res.json(safeUser);
});

// Admin: Reset a user's passcode to a fresh random value (shown once)
app.post('/api/roster/:id/reset-passcode', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const companyId = req.user.companyId;
  const roster = await getRoster(companyId);
  const userIndex = roster.findIndex(u => u.id === id);
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const newPasscode = generatePasscode();
  roster[userIndex] = {
    ...roster[userIndex],
    passcodeHash: await hashPasscode(newPasscode),
    passcodeChangedAt: Date.now(),
    mustChangePasscode: true,
    failedAttempts: 0,
    lockedUntil: null
  };
  await saveRoster(companyId, roster);

  const { passcodeHash: _, ...safeUser } = roster[userIndex];
  res.json({ success: true, user: safeUser, newPasscode });
});

// Admin: Remove a user
app.delete('/api/roster/:id', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const companyId = req.user.companyId;
  let roster = await getRoster(companyId);
  const target = roster.find(u => u.id === id);

  if (!target) {
    return res.status(404).json({ error: 'User not found.' });
  }

  if (target.role === 'Admin') {
    const otherAdmins = roster.filter(u => u.role === 'Admin' && u.id !== id);
    if (otherAdmins.length === 0) {
      return res.status(400).json({ error: 'Cannot delete the last Admin for this company.' });
    }
  }

  roster = roster.filter(u => u.id !== id);
  await saveRoster(companyId, roster);

  const dailyState = await getDailyState(companyId);
  if (dailyState.orders && dailyState.orders[id]) {
    delete dailyState.orders[id];
    await saveDailyState(companyId, dailyState);
  }
  await deleteWeeklyPlan(companyId, id);

  res.json({ success: true, message: 'User removed from roster.' });
});

// Get daily menu, orders, and stats summaries
app.get('/api/daily', authMiddleware, requireCompanyUser, async (req, res) => {
  const companyId = req.user.companyId;
  const dailyState = await getDailyState(companyId);
  const roster = await getRoster(companyId);

  const orders = dailyState.orders || {};
  const ordered = [];
  const pending = [];

  const dishTotals = {};
  dailyState.menu.forEach(item => {
    dishTotals[item.id] = 0;
  });

  roster.forEach(user => {
    const userOrder = orders[user.id];
    if (userOrder) {
      ordered.push({
        userId: user.id,
        name: user.name,
        itemId: userOrder.itemId,
        itemName: dailyState.menu.find(m => m.id === userOrder.itemId)?.name || 'None',
        timestamp: userOrder.timestamp,
        assignedBy: userOrder.assignedBy || null,
        served: !!userOrder.served,
        note: userOrder.note || '',
        viaWeeklyPlan: !!userOrder.viaWeeklyPlan
      });
      if (userOrder.itemId) {
        dishTotals[userOrder.itemId] = (dishTotals[userOrder.itemId] || 0) + 1;
      }
    } else {
      pending.push({
        userId: user.id,
        name: user.name
      });
    }
  });

  const isLocked = checkCutoff(dailyState);

  // Surface the most recent reminder sent to the requesting user today, if any
  let myReminder = null;
  if (dailyState.date) {
    const logs = await getRemindersLog(companyId);
    const myLogs = logs.filter(l => l.userId === req.user.id && l.date === dailyState.date);
    if (myLogs.length > 0) {
      myReminder = myLogs[myLogs.length - 1];
    }
  }

  const isOperationalToday = isOperationalDay(dailyState);

  res.json({
    date: dailyState.date,
    operationalDays: dailyState.operationalDays || [],
    isOperationalToday,
    nextOperationalDayName: isOperationalToday ? null : getNextOperationalDayName(dailyState),
    menu: dailyState.menu,
    menuPublished: dailyState.menuPublished,
    cutoffTime: dailyState.cutoffTime,
    cutoffExtensionMinutes: dailyState.cutoffExtensionMinutes || 0,
    effectiveCutoffTime: dailyState.cutoffTime
      ? formatMinutesAsHHMM(getEffectiveCutoffDate(dailyState))
      : dailyState.cutoffTime,
    // Full timestamp of the cutoff for *this* business date, so the client
    // can count down accurately even when the business date isn't the same
    // as the client's calendar "today" (see getEffectiveCutoffDate).
    cutoffTimestamp: dailyState.cutoffTime
      ? getEffectiveCutoffDate(dailyState).toISOString()
      : null,
    archiveTime: dailyState.archiveTime || DEFAULT_ARCHIVE_TIME,
    isLocked,
    myReminder,
    foodArrival: dailyState.foodArrival || null,
    orders: {
      ordered,
      pending
    },
    stats: {
      total: roster.length,
      ordered: ordered.length,
      pending: pending.length
    },
    dishTotals: Object.entries(dishTotals).map(([id, count]) => {
      const dish = dailyState.menu.find(m => m.id === id);
      return {
        itemId: id,
        name: dish ? dish.name : 'Unknown Dish',
        count
      };
    })
  });
});

// --- Dish Catalog ---
// A persistent, company-wide catalog of dishes (name/description/price/
// image) an Admin manages once, rather than re-typing the same dishes into
// the daily menu every day. Building a day's menu (POST /api/menu, below)
// snapshots a catalog dish's current fields onto that day's menu item —
// editing a catalog dish later never changes an already-built day.

const MAX_DISH_IMAGE_BYTES = 300 * 1024; // original file size, pre-base64
const ALLOWED_DISH_IMAGE_TYPES = new Set(['image/webp', 'image/jpeg', 'image/png']);

app.get('/api/dishes', authMiddleware, requireAdmin, async (req, res) => {
  const dishes = await getDishes(req.user.companyId, { includeInactive: req.query.includeInactive === 'true' });
  res.json(dishes.map(({ _id, ...rest }) => rest));
});

app.post('/api/dishes', authMiddleware, requireAdmin, async (req, res) => {
  const { name, description, price } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Dish name is required.' });
  }
  if (price !== undefined && price !== null && (!Number.isFinite(price) || price < 0)) {
    return res.status(400).json({ error: 'Price must be a non-negative number.' });
  }

  const companyId = req.user.companyId;
  const dish = {
    id: `dish-cat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim(),
    normalizedName: normalizeDishName(name),
    description: description || '',
    price: Number.isFinite(price) ? price : null,
    imageId: null,
    active: true,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  try {
    await createDish(companyId, dish);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'A dish with this name already exists in your catalog.' });
    }
    throw err;
  }

  res.status(201).json(dish);
});

app.put('/api/dishes/:id', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, description, price } = req.body;
  const companyId = req.user.companyId;

  const existing = await getDishById(companyId, id);
  if (!existing) {
    return res.status(404).json({ error: 'Dish not found.' });
  }
  if (price !== undefined && price !== null && (!Number.isFinite(price) || price < 0)) {
    return res.status(400).json({ error: 'Price must be a non-negative number.' });
  }

  const patch = { updatedAt: Date.now() };
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'Dish name is required.' });
    patch.name = name.trim();
    patch.normalizedName = normalizeDishName(name);
  }
  if (description !== undefined) patch.description = description;
  if (price !== undefined) patch.price = Number.isFinite(price) ? price : null;

  try {
    await updateDish(companyId, id, patch);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'A dish with this name already exists in your catalog.' });
    }
    throw err;
  }

  res.json({ ...existing, ...patch });
});

// Soft delete only — dailyState.menu items and history entries may still
// reference this dish by catalogDishId, so it must never be hard-deleted.
app.delete('/api/dishes/:id', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const companyId = req.user.companyId;
  const existing = await getDishById(companyId, id);
  if (!existing) {
    return res.status(404).json({ error: 'Dish not found.' });
  }
  await setDishActive(companyId, id, false);
  res.json({ success: true });
});

app.post('/api/dishes/:id/image', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { imageData } = req.body;
  const companyId = req.user.companyId;

  const dish = await getDishById(companyId, id);
  if (!dish) {
    return res.status(404).json({ error: 'Dish not found.' });
  }

  const match = /^data:([\w/+.-]+);base64,(.+)$/.exec(imageData || '');
  if (!match) {
    return res.status(400).json({ error: 'imageData must be a base64 data URL.' });
  }
  const [, contentType, base64] = match;
  if (!ALLOWED_DISH_IMAGE_TYPES.has(contentType)) {
    return res.status(400).json({ error: 'Image must be webp, jpeg, or png.' });
  }

  const data = Buffer.from(base64, 'base64');
  if (data.length > MAX_DISH_IMAGE_BYTES) {
    return res.status(400).json({ error: `Image must be under ${Math.round(MAX_DISH_IMAGE_BYTES / 1024)}KB.` });
  }

  const image = await saveDishImage(companyId, { contentType, data, size: data.length });
  await updateDish(companyId, id, { imageId: image._id, updatedAt: Date.now() });
  if (dish.imageId) {
    await deleteDishImage(companyId, dish.imageId); // replacing — old image is now unreferenced
  }

  // Unlike price (deliberately frozen at menu-build time for historical
  // accuracy — see POST /api/menu), a photo has no "historical accuracy"
  // concern: if today's live menu already picked this catalog dish before
  // the photo existed, there's no reason to make the admin re-save the
  // whole day's menu just to pick up an image. Propagate into today's
  // still-live dailyState.menu only — archived `history` days are never
  // touched, they stay a frozen record of what was actually shown that day.
  const dailyState = await getDailyState(companyId);
  let dailyStateChanged = false;
  const updatedMenu = (dailyState.menu || []).map(item => {
    if (item.catalogDishId === id && item.imageId !== image._id) {
      dailyStateChanged = true;
      return { ...item, imageId: image._id };
    }
    return item;
  });
  if (dailyStateChanged) {
    await saveDailyState(companyId, { ...dailyState, menu: updatedMenu });
  }

  res.json({ success: true, imageId: image._id });
});

// Public and unauthenticated, deliberately: this is rendered via <img src>,
// which cannot carry the x-auth-token header authMiddleware requires
// everywhere else. Served by opaque, unguessable id only — the same
// trade-off the app already made for the static dish photos under
// public/assets/, which have always been plain public files. Immutable
// once created (a re-upload gets a new imageId, never mutates in place),
// so it's safe to cache aggressively.
app.get('/api/dish-images/:imageId', async (req, res) => {
  const image = await getDishImageById(req.params.imageId);
  if (!image) {
    return res.status(404).end();
  }
  res.set('Content-Type', image.contentType);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(image.data.buffer ? Buffer.from(image.data.buffer) : image.data);
});

// Admin: Set daily menu
app.post('/api/menu', authMiddleware, requireAdmin, async (req, res) => {
  const { menu } = req.body;
  if (!Array.isArray(menu)) {
    return res.status(400).json({ error: 'Menu must be an array.' });
  }

  const companyId = req.user.companyId;
  const dailyState = await getDailyState(companyId);
  if (checkCutoff(dailyState)) {
    return res.status(400).json({ error: 'Cutoff time has passed. Menu is locked.' });
  }

  // Items picked from the catalog get their name/description/price/imageId
  // SNAPSHOTTED from the catalog dish right now — not a live reference — so
  // a later catalog price edit never retroactively changes an already-built
  // day (this is also what makes archiveCurrentDay's later verbatim copy
  // into `history` correct with no changes needed there).
  const catalogIds = menu.filter(item => item.catalogDishId).map(item => item.catalogDishId);
  const catalogById = new Map();
  if (catalogIds.length > 0) {
    (await getDishes(companyId)).forEach(d => catalogById.set(d.id, d));
  }

  const newMenu = [];
  for (const item of menu) {
    const id = item.id || `dish-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
    if (item.catalogDishId) {
      const dish = catalogById.get(item.catalogDishId);
      if (!dish) {
        return res.status(400).json({ error: 'A selected catalog dish was not found or is no longer active.' });
      }
      newMenu.push({
        id,
        name: dish.name,
        description: dish.description || '',
        price: typeof dish.price === 'number' ? dish.price : null,
        catalogDishId: dish.id,
        imageId: dish.imageId || null
      });
    } else {
      if (!item.name) {
        return res.status(400).json({ error: 'Each menu item needs a name.' });
      }
      newMenu.push({
        id,
        name: item.name,
        description: item.description || '',
        price: Number.isFinite(item.price) ? item.price : null,
        catalogDishId: null,
        imageId: null
      });
    }
  }
  dailyState.menu = newMenu;

  await saveDailyState(companyId, dailyState);
  res.json({ success: true, menu: dailyState.menu });
});

// Admin: Publish menu
app.post('/api/publish-menu', authMiddleware, requireAdmin, async (req, res) => {
  const { published } = req.body;
  const companyId = req.user.companyId;
  const dailyState = await getDailyState(companyId);

  if (checkCutoff(dailyState)) {
    return res.status(400).json({ error: 'Cutoff time has passed. State is locked.' });
  }

  dailyState.menuPublished = !!published;
  await saveDailyState(companyId, dailyState);
  res.json({ success: true, menuPublished: dailyState.menuPublished });
});

// Admin: View current login-throttling settings
app.get('/api/settings/security', authMiddleware, requireAdmin, async (req, res) => {
  const settings = await getSecuritySettingsCached(req.user.companyId);
  res.json(settings);
});

// Admin: Update login-throttling settings (account lockout + rate limiting).
// The two rate-limit fields are stored but currently unused — the shared
// loginRateLimiterInstance isn't per-company (see buildLoginRateLimiter) —
// left in place for a later phase to activate.
app.put('/api/settings/security', authMiddleware, requireAdmin, async (req, res) => {
  const companyId = req.user.companyId;
  const current = await getSecuritySettingsCached(companyId);
  const updated = { ...current };

  for (const [key, bounds] of Object.entries(SECURITY_SETTINGS_BOUNDS)) {
    if (req.body[key] === undefined) continue;
    const value = Number(req.body[key]);
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      return res.status(400).json({
        error: `${key} must be a whole number between ${bounds.min} and ${bounds.max}.`
      });
    }
    updated[key] = value;
  }

  await saveSecuritySettings(companyId, updated);
  securitySettingsCache.set(companyId, updated);

  res.json(updated);
});

// Admin: Change daily cutoff time
app.post('/api/cutoff', authMiddleware, requireAdmin, async (req, res) => {
  const { cutoffTime } = req.body;
  if (!cutoffTime || !/^\d{2}:\d{2}$/.test(cutoffTime)) {
    return res.status(400).json({ error: 'Invalid time format. Must be HH:MM.' });
  }

  const companyId = req.user.companyId;
  const dailyState = await getDailyState(companyId);
  dailyState.cutoffTime = cutoffTime;
  dailyState.cutoffExtensionMinutes = 0; // setting a new base cutoff clears any prior extension
  await saveDailyState(companyId, dailyState);
  res.json({ success: true, cutoffTime: dailyState.cutoffTime });
});

// Admin: Grant extra minutes past today's cutoff, e.g. once it's already
// passed and people still need a bit more time. Additive across calls.
app.post('/api/cutoff/extend', authMiddleware, requireAdmin, async (req, res) => {
  const { minutes } = req.body;
  if (!Number.isInteger(minutes) || minutes <= 0) {
    return res.status(400).json({ error: 'minutes must be a positive whole number.' });
  }

  const companyId = req.user.companyId;
  const dailyState = await getDailyState(companyId);
  dailyState.cutoffExtensionMinutes = (dailyState.cutoffExtensionMinutes || 0) + minutes;
  await saveDailyState(companyId, dailyState);

  const isLocked = checkCutoff(dailyState);
  res.json({
    success: true,
    cutoffExtensionMinutes: dailyState.cutoffExtensionMinutes,
    effectiveCutoffTime: formatMinutesAsHHMM(getEffectiveCutoffDate(dailyState)),
    isLocked
  });
});

// Admin: Change daily archive time (when the day's orders get archived and reset for the next business day)
app.post('/api/archive-time', authMiddleware, requireAdmin, async (req, res) => {
  const { archiveTime } = req.body;
  if (!archiveTime || !/^\d{2}:\d{2}$/.test(archiveTime)) {
    return res.status(400).json({ error: 'Invalid time format. Must be HH:MM.' });
  }

  const companyId = req.user.companyId;
  const dailyState = await getDailyState(companyId);
  dailyState.archiveTime = archiveTime;
  await saveDailyState(companyId, dailyState);
  res.json({ success: true, archiveTime: dailyState.archiveTime });
});

// Admin: Set which weekdays (0=Sun..6=Sat) Lunch Buddy accepts orders on
app.post('/api/operational-days', authMiddleware, requireAdmin, async (req, res) => {
  const { operationalDays } = req.body;
  if (
    !Array.isArray(operationalDays) ||
    operationalDays.length === 0 ||
    !operationalDays.every(d => Number.isInteger(d) && d >= 0 && d <= 6) ||
    new Set(operationalDays).size !== operationalDays.length
  ) {
    return res.status(400).json({ error: 'operationalDays must be a non-empty array of unique integers 0-6.' });
  }

  const companyId = req.user.companyId;
  const dailyState = await getDailyState(companyId);
  dailyState.operationalDays = [...operationalDays].sort((a, b) => a - b);
  await saveDailyState(companyId, dailyState);
  res.json({ success: true, operationalDays: dailyState.operationalDays });
});

// Team Member: Place daily dish order
app.post('/api/order', authMiddleware, requireCompanyUser, async (req, res) => {
  const { itemId, note } = req.body;
  const userId = req.user.id;
  const companyId = req.user.companyId;

  const dailyState = await getDailyState(companyId);

  if (!isOperationalDay(dailyState)) {
    return res.status(400).json({ error: 'Lunch Buddy is closed today.' });
  }

  if (checkCutoff(dailyState)) {
    return res.status(400).json({ error: 'The daily cutoff time has passed. Orders are locked.' });
  }

  if (!dailyState.menuPublished) {
    return res.status(400).json({ error: 'Today\'s menu has not been published by the Admin.' });
  }
  if (!itemId) {
    return res.status(400).json({ error: 'A dish selection is required.' });
  }
  const dishExists = dailyState.menu.some(m => m.id === itemId);
  if (!dishExists) {
    return res.status(400).json({ error: 'Dish is not on today\'s menu.' });
  }

  const order = writeOrderForUser(dailyState, userId, itemId, note);

  await saveDailyState(companyId, dailyState);
  res.json({ success: true, order });
});

// Team Member: Cancel today's own order (opt out entirely, not just change dish)
app.delete('/api/order', authMiddleware, requireCompanyUser, async (req, res) => {
  const userId = req.user.id;
  const companyId = req.user.companyId;
  const dailyState = await getDailyState(companyId);

  if (checkCutoff(dailyState)) {
    return res.status(400).json({ error: 'The daily cutoff time has passed. Orders are locked.' });
  }

  const existingOrder = dailyState.orders?.[userId];
  if (!existingOrder) {
    return res.status(404).json({ error: 'You don\'t have an order to cancel.' });
  }
  if (existingOrder.served) {
    return res.status(400).json({ error: 'This order has already been served and can\'t be cancelled. Contact an admin.' });
  }

  delete dailyState.orders[userId];
  await saveDailyState(companyId, dailyState);
  res.json({ success: true });
});

// Admin/Abigail: Place or change an order on behalf of a team member who
// informed a coordinator but couldn't submit it themselves. Subject to the
// same cutoff as self-serve orders — an admin needing more room to add
// stragglers should grant extra time via /api/cutoff/extend instead.
app.post('/api/order/assign', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const { userId, itemId, note } = req.body;
  if (!userId || !itemId) {
    return res.status(400).json({ error: 'userId and itemId are required.' });
  }

  const companyId = req.user.companyId;
  const roster = await getRoster(companyId);
  const targetUser = roster.find(u => u.id === userId);
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found in roster.' });
  }

  const dailyState = await getDailyState(companyId);

  if (!isOperationalDay(dailyState)) {
    return res.status(400).json({ error: 'Lunch Buddy is closed today.' });
  }

  if (checkCutoff(dailyState)) {
    return res.status(400).json({ error: 'The daily cutoff time has passed. Orders are locked.' });
  }

  if (!dailyState.menuPublished) {
    return res.status(400).json({ error: 'Today\'s menu has not been published yet.' });
  }
  const dishExists = dailyState.menu.some(m => m.id === itemId);
  if (!dishExists) {
    return res.status(400).json({ error: 'Dish is not on today\'s menu.' });
  }

  dailyState.orders = dailyState.orders || {};
  dailyState.orders[userId] = {
    itemId,
    timestamp: Date.now(),
    assignedBy: req.user.name,
    note: sanitizeOrderNote(note)
  };

  await saveDailyState(companyId, dailyState);
  res.json({ success: true, order: dailyState.orders[userId] });
});

// --- Weekly Planning ---
// A weekly "plan" is a pre-fill, never a bypass: today's card in the weekly
// view IS the real order (same store, same cutoff, same everything above),
// and every future day still has to clear its own cutoff/operational/menu
// checks — both when the person picks it here, and again for real when
// applyWeeklyPlansForDate() converts it into an actual order at rollover.

// Assembles the response shape for one day of the weekly view, from
// whichever store is actually authoritative for that date: `history` for a
// past day, live `dailyState.orders` for today, or the saved plan entry for
// a future day. `pastEntry` is the matching `history` doc, or null/undefined
// when the date isn't in the past (callers other than GET never need it,
// since PUT/DELETE only ever touch today-or-later dates).
function buildWeekDayInfo(dailyState, plan, date, userId, pastEntry) {
  const weekday = getWeekdayForDate(date);
  const dayName = DAY_NAMES[weekday];
  const isToday = date === dailyState.date;
  const isPast = !!dailyState.date && date < dailyState.date;
  const isOperational = isOperationalDate(dailyState, date);
  const isLocked = isDateLocked(dailyState, date);
  const cutoffTimestamp = getEffectiveCutoffDateFor(dailyState, date).toISOString();

  let source = 'none';
  let dishName = null;
  let note = '';
  let served = false;
  let viaWeeklyPlan = false;
  let dishStillOnMenu = null;
  let imageId = null;

  if (isPast) {
    const pastOrder = pastEntry?.orders?.[userId];
    if (pastOrder) {
      source = 'order';
      const dish = pastEntry.menu.find(m => m.id === pastOrder.itemId);
      dishName = dish?.name || null;
      imageId = dish?.imageId || null;
      note = pastOrder.note || '';
      served = !!pastOrder.served;
      viaWeeklyPlan = !!pastOrder.viaWeeklyPlan;
    }
  } else if (isToday) {
    const order = dailyState.orders?.[userId];
    if (order) {
      source = 'order';
      const dish = dailyState.menu.find(m => m.id === order.itemId);
      dishName = dish?.name || null;
      imageId = dish?.imageId || null;
      note = order.note || '';
      served = !!order.served;
      viaWeeklyPlan = !!order.viaWeeklyPlan;
    }
  } else {
    const planEntry = plan.entries?.[date];
    if (planEntry) {
      source = 'plan';
      dishName = planEntry.dishName;
      note = planEntry.note || '';
      const matched = findMenuItemByName(dailyState.menu, planEntry.dishName);
      dishStillOnMenu = !!matched;
      imageId = matched?.imageId || null;
    }
  }

  return {
    date, weekday, dayName, isToday, isPast, isOperational, isLocked,
    cutoffTimestamp, source, dishName, note, served, viaWeeklyPlan, dishStillOnMenu, imageId,
    editable: !isLocked && isOperational && !!dailyState.menuPublished
  };
}

// Team Member: Read this week's plan — one card per operational day in the
// current Mon-Sun week, sourced from history/today's order/plan as above.
app.get('/api/week-plan', authMiddleware, requireCompanyUser, async (req, res) => {
  const userId = req.user.id;
  const companyId = req.user.companyId;
  // getWeeklyPlan doesn't depend on dailyState, so run them concurrently
  // instead of paying two sequential Atlas round-trips back to back.
  const [dailyState, plan] = await Promise.all([getDailyState(companyId), getWeeklyPlan(companyId, userId)]);
  const weekDates = getPlanWeekDates(dailyState);

  const pastDates = weekDates.filter(d => dailyState.date && d < dailyState.date);
  const history = await getHistoryForDates(companyId, pastDates);
  const historyByDate = new Map(history.map(h => [h.date, h]));

  const days = weekDates.map(date =>
    buildWeekDayInfo(dailyState, plan, date, userId, historyByDate.get(date))
  );

  res.json({
    businessDate: dailyState.date,
    menu: dailyState.menu,
    menuPublished: dailyState.menuPublished,
    days
  });
});

// Team Member: Set (or change) one day's plan pick. If :date is today, this
// writes a real order through the same path POST /api/order uses — today is
// never a "plan", it's the live order.
app.put('/api/week-plan/:date', authMiddleware, requireCompanyUser, async (req, res) => {
  const { date } = req.params;
  const { dishName, note } = req.body;
  const userId = req.user.id;
  const companyId = req.user.companyId;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format.' });
  }

  const dailyState = await getDailyState(companyId);
  const weekDates = getPlanWeekDates(dailyState);
  if (!weekDates.includes(date)) {
    return res.status(400).json({ error: "That date isn't in this week's plan." });
  }

  const dayName = DAY_NAMES[getWeekdayForDate(date)];
  if (isDateLocked(dailyState, date)) {
    return res.status(400).json({ error: `Orders for ${dayName} are already locked.` });
  }
  if (!isOperationalDate(dailyState, date)) {
    return res.status(400).json({ error: `Lunch Buddy is closed on ${dayName}.` });
  }
  if (!dailyState.menuPublished) {
    return res.status(400).json({ error: 'The menu hasn\'t been published yet.' });
  }
  const matched = findMenuItemByName(dailyState.menu, dishName);
  if (!matched) {
    return res.status(400).json({ error: 'Dish is not on the menu.' });
  }

  const plan = await getWeeklyPlan(companyId, userId);
  plan.entries = plan.entries || {};

  if (date === dailyState.date) {
    writeOrderForUser(dailyState, userId, matched.id, note);
    await saveDailyState(companyId, dailyState);
    // A real order now exists for today — drop any lingering plan entry so
    // the two stores never disagree about what "today" means.
    if (plan.entries[date]) {
      delete plan.entries[date];
      await saveWeeklyPlan(companyId, userId, plan);
    }
  } else {
    plan.entries[date] = {
      dishName: matched.name,
      note: sanitizeOrderNote(note),
      updatedAt: Date.now(),
      source: 'manual'
    };
    plan.updatedAt = Date.now();
    await saveWeeklyPlan(companyId, userId, plan);
  }

  res.json({ success: true, day: buildWeekDayInfo(dailyState, plan, date, userId, null) });
});

// Team Member: Clear one day back to "Skipped". Today follows the same
// already-served guard as DELETE /api/order.
app.delete('/api/week-plan/:date', authMiddleware, requireCompanyUser, async (req, res) => {
  const { date } = req.params;
  const userId = req.user.id;
  const companyId = req.user.companyId;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format.' });
  }

  const dailyState = await getDailyState(companyId);
  const weekDates = getPlanWeekDates(dailyState);
  if (!weekDates.includes(date)) {
    return res.status(400).json({ error: "That date isn't in this week's plan." });
  }

  const dayName = DAY_NAMES[getWeekdayForDate(date)];
  if (isDateLocked(dailyState, date)) {
    return res.status(400).json({ error: `Orders for ${dayName} are already locked.` });
  }

  const plan = await getWeeklyPlan(companyId, userId);
  plan.entries = plan.entries || {};

  if (date === dailyState.date) {
    const existingOrder = dailyState.orders?.[userId];
    if (existingOrder) {
      if (existingOrder.served) {
        return res.status(400).json({ error: 'This order has already been served and can\'t be cancelled. Contact an admin.' });
      }
      delete dailyState.orders[userId];
      await saveDailyState(companyId, dailyState);
    }
  } else if (plan.entries[date]) {
    delete plan.entries[date];
    plan.updatedAt = Date.now();
    await saveWeeklyPlan(companyId, userId, plan);
  }

  res.json({ success: true, day: buildWeekDayInfo(dailyState, plan, date, userId, null) });
});

// Team Member: "Use this dish for the rest of the week" — fans one pick out
// across the remaining unlocked/operational days after fromDate (default
// today), overwriting any existing picks on those days. Deliberately does
// NOT propagate the note — a note like "for the client meeting" should
// never silently apply to four other days, only the dish does.
app.post('/api/week-plan/repeat', authMiddleware, requireCompanyUser, async (req, res) => {
  const { dishName, note, fromDate } = req.body;
  const userId = req.user.id;
  const companyId = req.user.companyId;

  const dailyState = await getDailyState(companyId);
  const weekDates = getPlanWeekDates(dailyState);
  const startDate = (fromDate && /^\d{4}-\d{2}-\d{2}$/.test(fromDate)) ? fromDate : dailyState.date;

  if (!weekDates.includes(startDate)) {
    return res.status(400).json({ error: "That date isn't in this week's plan." });
  }
  if (!dailyState.menuPublished) {
    return res.status(400).json({ error: 'The menu hasn\'t been published yet.' });
  }
  const matched = findMenuItemByName(dailyState.menu, dishName);
  if (!matched) {
    return res.status(400).json({ error: 'Dish is not on the menu.' });
  }

  const plan = await getWeeklyPlan(companyId, userId);
  plan.entries = plan.entries || {};

  const appliedDates = [];
  const skippedDates = [];
  let dailyStateChanged = false;

  // Repeating from today also places today's own order, if not already set —
  // one click does the intuitive thing instead of leaving today untouched.
  if (startDate === dailyState.date && !isDateLocked(dailyState, startDate) && !dailyState.orders?.[userId]) {
    writeOrderForUser(dailyState, userId, matched.id, note);
    dailyStateChanged = true;
    appliedDates.push(startDate);
    if (plan.entries[startDate]) delete plan.entries[startDate];
  }

  for (const date of weekDates) {
    if (date <= startDate) continue; // strictly after fromDate
    if (isDateLocked(dailyState, date)) {
      skippedDates.push({ date, reason: 'locked' });
      continue;
    }
    if (!isOperationalDate(dailyState, date)) {
      skippedDates.push({ date, reason: 'closed' });
      continue;
    }
    plan.entries[date] = { dishName: matched.name, note: '', updatedAt: Date.now(), source: 'repeat' };
    appliedDates.push(date);
  }

  plan.updatedAt = Date.now();
  await saveWeeklyPlan(companyId, userId, plan);
  if (dailyStateChanged) await saveDailyState(companyId, dailyState);

  res.json({ success: true, appliedDates, skippedDates });
});

// Admin/Abigail: Toggle whether a person's dish has physically been handed out
app.post('/api/order/serve', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const { userId, served } = req.body;
  if (!userId || typeof served !== 'boolean') {
    return res.status(400).json({ error: 'userId and a boolean served flag are required.' });
  }

  const companyId = req.user.companyId;
  const dailyState = await getDailyState(companyId);
  const order = dailyState.orders?.[userId];
  if (!order) {
    return res.status(404).json({ error: 'This person has not placed an order yet.' });
  }

  order.served = served;
  await saveDailyState(companyId, dailyState);
  res.json({ success: true, order });
});

// Admin/Abigail: Remove a specific person's order from today's board (e.g.
// to fix a mistaken selection). Blocked once cutoff passes — at that point
// the list is treated as submitted to the vendor and shouldn't change.
app.delete('/api/order/:userId', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const { userId } = req.params;
  const companyId = req.user.companyId;
  const dailyState = await getDailyState(companyId);

  if (checkCutoff(dailyState)) {
    return res.status(400).json({ error: 'The daily cutoff time has passed. The order list is locked.' });
  }

  if (!dailyState.orders?.[userId]) {
    return res.status(404).json({ error: 'This person has not placed an order.' });
  }

  delete dailyState.orders[userId];
  await saveDailyState(companyId, dailyState);
  res.json({ success: true });
});

// Admin: Clear every order placed today so the roster can make fresh selections
app.post('/api/order/clear-all', authMiddleware, requireAdmin, async (req, res) => {
  const companyId = req.user.companyId;
  const dailyState = await getDailyState(companyId);
  dailyState.orders = {};
  await saveDailyState(companyId, dailyState);
  res.json({ success: true });
});

// Admin: Manually force-lock order acceptance early, or revert to
// time-based cutoff. To give more time past cutoff, use
// /api/cutoff/extend instead of force-opening indefinitely.
app.post('/api/lock', authMiddleware, requireAdmin, async (req, res) => {
  const { locked } = req.body; // true = force lock, null = revert to time-based
  if (locked !== true && locked !== null) {
    return res.status(400).json({ error: 'locked must be true or null.' });
  }

  const companyId = req.user.companyId;
  const dailyState = await getDailyState(companyId);
  dailyState.isManuallyLocked = locked;
  await saveDailyState(companyId, dailyState);

  const effectiveLocked = checkCutoff(dailyState);
  res.json({ success: true, isManuallyLocked: locked, isLocked: effectiveLocked });
});

// Admin: Bulk add team members
app.post('/api/roster/bulk', authMiddleware, requireAdmin, async (req, res) => {
  const { members } = req.body;
  if (!Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'members must be a non-empty array.' });
  }

  const companyId = req.user.companyId;
  const roster = await getRoster(companyId);
  const branches = await getBranches(companyId);
  const branchByName = new Map(branches.map(b => [b.name.toLowerCase(), b.id]));
  const added = [];
  const skipped = [];
  const warnings = [];

  for (const m of members) {
    const name = (m.name || '').trim();
    if (!name) { skipped.push({ entry: m, reason: 'Missing name' }); continue; }

    const duplicate = roster.some(u => u.name.toLowerCase() === name.toLowerCase());
    if (duplicate) { skipped.push({ entry: m, reason: `"${name}" already exists` }); continue; }

    const role = m.role || 'Team Member';
    if (!COMPANY_ROLES.includes(role)) {
      skipped.push({ entry: m, reason: 'Invalid role' }); continue;
    }

    if (m.passcode) {
      const validationError = validatePasscode(m.passcode, { name, email: m.email });
      if (validationError) { skipped.push({ entry: m, reason: validationError }); continue; }
    }

    // Branch is matched by name (the pasteable format), not id. An
    // unrecognized branch name only drops the branch assignment for that
    // row — it never fails the whole import over a typo.
    let branchId = null;
    const branchName = (m.branch || '').trim();
    if (branchName) {
      branchId = branchByName.get(branchName.toLowerCase()) || null;
      if (!branchId) warnings.push(`"${name}": branch "${branchName}" not found, left unassigned`);
    }

    const initialPasscode = m.passcode || generatePasscode();
    const newUser = {
      id: `usr-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      companyId,
      name,
      email: (m.email || '').trim(),
      phone: (m.phone || '').trim(),
      role,
      branchId,
      passcodeHash: await hashPasscode(initialPasscode),
      passcodeChangedAt: Date.now(),
      mustChangePasscode: true
    };
    roster.push(newUser);
    added.push({ ...newUser, initialPasscode });
  }

  if (added.length > 0) await saveRoster(companyId, roster);

  res.json({
    success: true,
    added: added.length,
    skipped: skipped.length,
    skippedDetails: skipped,
    warnings,
    // Each member's one-time initialPasscode is included so the admin can
    // share it — it can't be retrieved again after this response.
    members: added.map(({ passcodeHash, ...rest }) => rest)
  });
});

// --- Branches ---
// Lightweight, admin-managed grouping within a company (e.g. office
// locations) — used to filter/group the roster. No cascade on delete: a
// roster member's now-orphaned branchId just fails to resolve client-side
// and displays "No branch", the same tolerance pattern used for a stale
// weekly-plan dish-name reference.

app.get('/api/branches', authMiddleware, requireAdmin, async (req, res) => {
  res.json(await getBranches(req.user.companyId));
});

app.post('/api/branches', authMiddleware, requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Branch name is required.' });
  }
  const companyId = req.user.companyId;
  const existing = await getBranches(companyId);
  if (existing.some(b => b.name.toLowerCase() === name.trim().toLowerCase())) {
    return res.status(400).json({ error: 'A branch with this name already exists.' });
  }
  const branch = await createBranch(companyId, {
    id: `brc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim(),
    createdAt: Date.now()
  });
  res.status(201).json(branch);
});

app.put('/api/branches/:id', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Branch name is required.' });
  }
  const companyId = req.user.companyId;
  const existing = await getBranches(companyId);
  if (!existing.some(b => b.id === id)) {
    return res.status(404).json({ error: 'Branch not found.' });
  }
  if (existing.some(b => b.id !== id && b.name.toLowerCase() === name.trim().toLowerCase())) {
    return res.status(400).json({ error: 'A branch with this name already exists.' });
  }
  await updateBranch(companyId, id, { name: name.trim() });
  res.json({ success: true });
});

app.delete('/api/branches/:id', authMiddleware, requireAdmin, async (req, res) => {
  await deleteBranch(req.user.companyId, req.params.id);
  res.json({ success: true });
});

// Any logged-in user: View their own past orders
app.get('/api/my-orders', authMiddleware, requireCompanyUser, async (req, res) => {
  const userId = req.user.id;
  const companyId = req.user.companyId;
  const history = await getHistory(companyId);

  // Build a personal history — one entry per archived day that the user appears in
  const personalHistory = history
    .slice()
    .reverse() // newest first
    .map(archive => {
      const userOrder = archive.orders?.[userId];
      if (!userOrder) return null; // user wasn't on roster / didn't submit that day

      const dishName = archive.menu?.find(m => m.id === userOrder.itemId)?.name || null;
      return {
        date: archive.date,
        itemId: userOrder.itemId || null,
        itemName: dishName,
        timestamp: userOrder.timestamp || null
      };
    })
    .filter(Boolean); // drop days with no entry

  res.json(personalHistory);
});

// Any logged-in company user: their own dish-popularity trend, filtered down
// to this one user's orders. Deliberately no spend/cost data here — company
// catering cost stays Admin/Abigail-only via GET /api/trends, even though
// it's technically "their own" order — team members don't need per-meal
// cost visibility.
app.get('/api/my-trends', authMiddleware, requireCompanyUser, async (req, res) => {
  const userId = req.user.id;
  const companyId = req.user.companyId;
  const history = await getHistory(companyId);

  const popularity = new Map();
  let mealsOrdered = 0;

  for (const entry of history) {
    const order = entry.orders?.[userId];
    if (!order || !order.itemId) continue;
    mealsOrdered++;

    const dish = (entry.menu || []).find(m => m.id === order.itemId);
    const dishName = dish?.name || 'Unknown Dish';
    popularity.set(dishName, (popularity.get(dishName) || 0) + 1);
  }

  const topDishes = [...popularity.entries()]
    .map(([dishName, totalCount]) => ({ dishName, totalCount }))
    .sort((a, b) => b.totalCount - a.totalCount);

  res.json({ mealsOrdered, topDishes });
});

// Admin/Abigail: View historical records
app.get('/api/history', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const history = await getHistory(req.user.companyId);
  res.json(history.slice().reverse()); // Newest first
});

// Admin: the per-head fallback cost Trends uses when an order's dish has no
// price of its own (most commonly orders archived before the Dish Catalog
// existed) — a company-wide flat rate, not a rewrite of any archived data.
app.get('/api/settings/company', authMiddleware, requireAdmin, async (req, res) => {
  res.json(await getCompanySettings(req.user.companyId));
});

app.put('/api/settings/company', authMiddleware, requireAdmin, async (req, res) => {
  const { defaultPricePerHead } = req.body;
  if (defaultPricePerHead !== null && defaultPricePerHead !== undefined) {
    if (!Number.isFinite(defaultPricePerHead) || defaultPricePerHead < 0) {
      return res.status(400).json({ error: 'defaultPricePerHead must be a non-negative number, or null to clear it.' });
    }
  }
  const settings = { defaultPricePerHead: defaultPricePerHead ?? null };
  await saveCompanySettings(req.user.companyId, settings);
  res.json(settings);
});

// --- Trends ---
// Cost + dish-popularity trends, computed in Node from `history` (no Mongo
// aggregation pipeline — nothing in db.js uses one, this stays consistent
// with the plain-driver, compute-in-JS style archiveCurrentDay already uses).
// Pre-catalog history has price:'' (not a number) on every dish. If the
// company has set a defaultPricePerHead, that flat rate is applied to any
// such order (past or present) for the SPEND total only — never written
// back into the archived history document itself, so this stays reversible
// (clear the setting and old days go back to being flagged/excluded) and
// never risks corrupting the original per-day record. Popularity was always
// name-keyed and never price-dependent, so it's unaffected either way.
app.get('/api/trends', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const { startDate, endDate } = req.query;
  const companyId = req.user.companyId;
  const [history, companySettings] = await Promise.all([
    getHistoryInRange(companyId, startDate || null, endDate || null),
    getCompanySettings(companyId)
  ]);
  const defaultPricePerHead = companySettings.defaultPricePerHead;

  const spendByDay = [];
  const popularity = new Map(); // dishName -> count

  for (const entry of history) {
    let total = 0;
    let hasUnpricedOrders = false;
    for (const order of Object.values(entry.orders || {})) {
      const dish = (entry.menu || []).find(m => m.id === order.itemId);
      if (dish && typeof dish.price === 'number') {
        total += dish.price;
      } else if (order.itemId) {
        if (typeof defaultPricePerHead === 'number') {
          total += defaultPricePerHead;
        } else {
          hasUnpricedOrders = true;
        }
      }
      const dishName = dish?.name || 'Unknown Dish';
      if (order.itemId) {
        popularity.set(dishName, (popularity.get(dishName) || 0) + 1);
      }
    }
    spendByDay.push({ date: entry.date, total, hasUnpricedOrders });
  }

  const topDishesOverall = [...popularity.entries()]
    .map(([dishName, totalCount]) => ({ dishName, totalCount }))
    .sort((a, b) => b.totalCount - a.totalCount);

  res.json({
    range: { startDate: startDate || null, endDate: endDate || null },
    defaultPricePerHead,
    spendByDay,
    topDishesOverall
  });
});

// Admin/Abigail: mark an archived day's order as served/unserved. Needed
// because the daily archive rolls over at archiveTime regardless of
// whether food has actually been handed out yet — a late vendor delivery
// can easily arrive after that point, so distribution tracking has to stay
// editable on past days, not just the live board.
app.post('/api/history/:date/order-serve', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const { date } = req.params;
  const { userId, served } = req.body;
  if (!userId || typeof served !== 'boolean') {
    return res.status(400).json({ error: 'userId and a boolean served flag are required.' });
  }

  const companyId = req.user.companyId;
  const history = await getHistory(companyId);
  const entry = history.find(h => h.date === date);
  if (!entry) {
    return res.status(404).json({ error: 'No archived record for this date.' });
  }
  const order = entry.orders?.[userId];
  if (!order) {
    return res.status(404).json({ error: 'This person has no order on that date.' });
  }

  order.served = served;
  await saveHistory(companyId, history);
  res.json({ success: true, order });
});

// --- Platform Admin: Company management ---

// List companies + a computed member count per company.
app.get('/api/companies', authMiddleware, requirePlatformAdmin, async (req, res) => {
  const companies = await getCompanies();
  const memberCounts = await Promise.all(companies.map(c => getRoster(c._id).then(r => r.length)));
  res.json(companies.map((c, i) => ({ ...c, memberCount: memberCounts[i] })));
});

// Create a company + its first Admin, in one step (manual onboarding —
// there's no public signup in this phase).
app.post('/api/companies', authMiddleware, requirePlatformAdmin, async (req, res) => {
  const { name, code, adminName, adminEmail } = req.body;
  if (!name || !code || !adminName) {
    return res.status(400).json({ error: 'name, code, and adminName are required.' });
  }

  const normalizedCode = code.trim().toUpperCase();
  if (!COMPANY_CODE_REGEX.test(normalizedCode)) {
    return res.status(400).json({ error: 'Company code must be 3-12 characters: letters, numbers, or hyphens.' });
  }
  const existing = await getCompanyByCode(normalizedCode);
  if (existing) {
    return res.status(400).json({ error: 'A company with this code already exists.' });
  }

  const companyId = `cmp-${normalizedCode.toLowerCase()}`;
  const company = await createCompany({ id: companyId, code: normalizedCode, name, createdBy: req.user.id });
  await seedCompanyDefaults(companyId);

  const initialPasscode = generatePasscode();
  const adminUser = {
    id: `usr-${Date.now()}`,
    companyId,
    name: adminName,
    email: adminEmail || '',
    phone: '',
    role: 'Admin',
    passcodeHash: await hashPasscode(initialPasscode),
    passcodeChangedAt: Date.now(),
    mustChangePasscode: true
  };
  await saveRoster(companyId, [adminUser]);

  const { passcodeHash: _, ...safeAdmin } = adminUser;
  // initialPasscode returned once so the platform admin can share it —
  // it can't be retrieved again after this response.
  res.status(201).json({ company, admin: { ...safeAdmin, initialPasscode } });
});

// Rename a company. Code is immutable after creation (it's the login key —
// changing it would silently break every saved login link/bookmark).
app.put('/api/companies/:id', authMiddleware, requirePlatformAdmin, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'name is required.' });
  }
  const company = await getCompanyById(id);
  if (!company) {
    return res.status(404).json({ error: 'Company not found.' });
  }
  await updateCompany(id, { name });
  invalidateCompanyCache(company);
  res.json({ ...company, name });
});

// Suspend/reactivate a company. No hard delete in this phase — a suspended
// company simply fails the status==='active' check in
// resolveCompanyMiddleware, so nobody can log in and nothing rolls over,
// while all of its data stays intact.
app.put('/api/companies/:id/status', authMiddleware, requirePlatformAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (status !== 'active' && status !== 'suspended') {
    return res.status(400).json({ error: "status must be 'active' or 'suspended'." });
  }
  const company = await getCompanyById(id);
  if (!company) {
    return res.status(404).json({ error: 'Company not found.' });
  }
  await updateCompany(id, { status });
  invalidateCompanyCache(company);
  invalidateSecuritySettingsCache(id);
  res.json({ ...company, status });
});

// --- Push Notifications ---

// Public: the client needs this to call pushManager.subscribe()
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: pushEnabled ? VAPID_PUBLIC_KEY : null });
});

// Save a browser push subscription against the logged-in user. A person can
// have more than one (phone + laptop), keyed by the subscription's unique
// endpoint URL so re-subscribing the same device just updates it in place.
// A targeted patch by id — works regardless of companyId (Platform Admins included).
app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint || !subscription?.keys) {
    return res.status(400).json({ error: 'A valid push subscription is required.' });
  }

  const subs = req.user.pushSubscriptions || [];
  const withoutDupe = subs.filter(s => s.endpoint !== subscription.endpoint);
  const pushSubscriptions = [...withoutDupe, subscription];
  await updateUserById(req.user.id, { pushSubscriptions });

  console.log(`Push subscription saved for ${req.user.name} (now ${pushSubscriptions.length} device(s)).`);
  res.json({ success: true });
});

// Remove a push subscription (e.g. the user turned notifications off)
app.post('/api/push/unsubscribe', authMiddleware, async (req, res) => {
  const { endpoint } = req.body;
  const pushSubscriptions = (req.user.pushSubscriptions || []).filter(s => s.endpoint !== endpoint);
  await updateUserById(req.user.id, { pushSubscriptions });
  res.json({ success: true });
});

// Sends a push payload to a subset of a company's roster (by id), or the
// whole roster if userIds is omitted — the shared primitive the Food's In
// broadcast, reminders, and the custom notification composer all go
// through. Dead subscriptions (expired/revoked — 404 or 410 from the push
// service) are dropped so they stop being retried forever.
//
// `meta` ({ type, target, sentBy }) is logged to notificationHistory in one
// place here — every current and future send path gets full history
// coverage automatically, rather than each call site having to remember to
// log it. `type` is one of 'custom' | 'scheduled' | 'food-arrived' |
// 'reminder-manual' | 'reminder-auto'; `sentBy` is a display name, or null
// for system-triggered sends (auto-reminders, the scheduler sweep).
async function sendPushToUsers(companyId, payload, userIds = null, meta = {}) {
  let result = { sent: 0, attempted: 0, dropped: 0 };

  if (!pushEnabled) {
    console.warn('sendPushToUsers: push is disabled (missing VAPID keys) — nothing sent.');
  } else {
    const roster = await getRoster(companyId);
    const targets = userIds ? roster.filter(u => userIds.includes(u.id)) : roster;
    const body = JSON.stringify(payload);
    let changed = false;

    for (const user of targets) {
      const subs = user.pushSubscriptions || [];
      if (subs.length === 0) continue;

      const survivors = [];
      for (const sub of subs) {
        result.attempted++;
        try {
          await webpush.sendNotification(sub, body);
          result.sent++;
          survivors.push(sub);
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            changed = true; // subscription is dead, drop it
            result.dropped++;
          } else {
            console.error(`Push failed for ${user.name}:`, err.statusCode, err.message);
            survivors.push(sub); // transient failure — keep it, don't drop on a fluke
          }
        }
      }
      user.pushSubscriptions = survivors; // targets are the same object refs as in `roster`
    }

    console.log(`Push: ${result.sent}/${result.attempted} device(s) sent successfully, ${result.dropped} dead subscription(s) dropped.`);
    if (changed) await saveRoster(companyId, roster);
  }

  if (meta.type) {
    logNotificationHistory(companyId, {
      title: payload.title,
      body: payload.body,
      type: meta.type,
      target: meta.target ?? null,
      sentBy: meta.sentBy ?? null,
      sentAt: Date.now(),
      result
    }).catch(err => console.error('Error logging notification history:', err));
  }

  return result;
}

// Admin/Abigail: broadcast "the food has arrived" — shows an in-app banner
// to everyone currently on the page, and sends a real push notification to
// anyone who has notifications enabled (reaches them even with the tab closed).
app.post('/api/food-arrived', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const companyId = req.user.companyId;
  const dailyState = await getDailyState(companyId);
  dailyState.foodArrival = { at: Date.now(), by: req.user.name };
  await saveDailyState(companyId, dailyState);

  sendPushToUsers(companyId, {
    title: '🍽️ Lunch has arrived!',
    body: `${req.user.name} says today's food is here — come get it.`
  }, null, { type: 'food-arrived', target: 'all', sentBy: req.user.name })
    .catch(err => console.error('Error broadcasting push notifications:', err));

  res.json({ success: true, foodArrival: dailyState.foodArrival });
});

const MAX_NOTIFICATION_TITLE_LENGTH = 80;
const MAX_NOTIFICATION_BODY_LENGTH = 300;

// Admin/Abigail: compose and send a custom push notification — to
// everyone, or just people who haven't ordered yet today.
// Shared title/body/target validation for both immediate and scheduled sends.
function validateNotificationInput({ title, body, target }) {
  if (!title || !title.trim() || !body || !body.trim()) {
    return 'A title and message body are required.';
  }
  if (title.length > MAX_NOTIFICATION_TITLE_LENGTH) {
    return `Title must be ${MAX_NOTIFICATION_TITLE_LENGTH} characters or fewer.`;
  }
  if (body.length > MAX_NOTIFICATION_BODY_LENGTH) {
    return `Message must be ${MAX_NOTIFICATION_BODY_LENGTH} characters or fewer.`;
  }
  if (target !== 'all' && target !== 'pending') {
    return "target must be 'all' or 'pending'.";
  }
  return null;
}

// Resolves 'pending' (not-yet-ordered) user ids fresh at send time — used
// both for an immediate send and, more importantly, for a scheduled one
// where the pending set may have changed a lot since it was scheduled.
async function resolvePendingUserIds(companyId) {
  const [dailyState, roster] = await Promise.all([getDailyState(companyId), getRoster(companyId)]);
  const orders = dailyState.orders || {};
  return roster.filter(u => !orders[u.id]).map(u => u.id);
}

app.post('/api/notifications/send', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const { title, body, target } = req.body;
  const validationError = validateNotificationInput({ title, body, target });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const companyId = req.user.companyId;
  let userIds = null;

  if (target === 'pending') {
    userIds = await resolvePendingUserIds(companyId);
    if (userIds.length === 0) {
      return res.json({ success: true, message: 'No pending users to notify.', result: { sent: 0, attempted: 0, dropped: 0 } });
    }
  }

  const result = await sendPushToUsers(companyId, { title: title.trim(), body: body.trim() }, userIds, {
    type: 'custom',
    target,
    sentBy: req.user.name
  });
  res.json({ success: true, result });
});

// Admin/Abigail: schedule a custom notification for a future time. Target
// (all/pending) is resolved fresh when the background sweep actually sends
// it, not at schedule-creation time.
// `repeat` is either omitted/null (one-time — client sends an exact
// `sendAt` timestamp) or { type: 'daily'|'weekdays', time: 'HH:MM' } (client
// sends a time only; the first occurrence is computed here).
// Shared by create and edit: resolves either an exact one-time `sendAt` or
// a { type, time } repeat rule into { sendAtMs, normalizedRepeat }, or
// returns a string error message.
function resolveScheduleTiming({ sendAt, repeat }) {
  if (repeat) {
    if (repeat.type !== 'daily' && repeat.type !== 'weekdays') {
      return "repeat.type must be 'daily' or 'weekdays'.";
    }
    if (!/^\d{2}:\d{2}$/.test(repeat.time || '')) {
      return 'repeat.time must be in HH:MM format.';
    }
    return {
      normalizedRepeat: { type: repeat.type, time: repeat.time },
      sendAtMs: computeNextOccurrence(repeat.time, Date.now(), repeat.type === 'weekdays')
    };
  }
  const sendAtMs = Number(sendAt);
  if (!Number.isFinite(sendAtMs) || sendAtMs <= Date.now()) {
    return 'Scheduled time must be in the future.';
  }
  return { normalizedRepeat: null, sendAtMs };
}

app.post('/api/notifications/schedule', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const { title, body, target, sendAt, repeat } = req.body;
  const validationError = validateNotificationInput({ title, body, target });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const timing = resolveScheduleTiming({ sendAt, repeat });
  if (typeof timing === 'string') {
    return res.status(400).json({ error: timing });
  }

  const companyId = req.user.companyId;
  const notification = {
    id: `sched-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: title.trim(),
    body: body.trim(),
    target,
    sendAt: timing.sendAtMs,
    repeat: timing.normalizedRepeat,
    status: 'pending',
    createdBy: req.user.name,
    createdAt: Date.now()
  };
  const saved = await createScheduledNotification(companyId, notification);
  res.status(201).json(saved);
});

// Admin/Abigail: edit a pending scheduled/recurring notification (title,
// body, target, and/or when it sends). Re-resolves sendAt from scratch —
// switching from one-time to recurring (or changing the repeat time) takes
// effect on save, same as creating fresh.
app.put('/api/notifications/scheduled/:id', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const { title, body, target, sendAt, repeat } = req.body;
  const validationError = validateNotificationInput({ title, body, target });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const timing = resolveScheduleTiming({ sendAt, repeat });
  if (typeof timing === 'string') {
    return res.status(400).json({ error: timing });
  }

  const companyId = req.user.companyId;
  const notifications = await getScheduledNotifications(companyId, { status: 'pending' });
  const existing = notifications.find(n => n.id === req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Scheduled notification not found.' });
  }

  const patch = {
    title: title.trim(),
    body: body.trim(),
    target,
    sendAt: timing.sendAtMs,
    repeat: timing.normalizedRepeat
  };
  await updateScheduledNotification(companyId, req.params.id, patch);
  res.json({ ...existing, ...patch });
});

// Admin/Abigail: list upcoming (not-yet-sent) scheduled notifications
app.get('/api/notifications/scheduled', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const notifications = await getScheduledNotifications(req.user.companyId, { status: 'pending' });
  res.json(notifications);
});

// Admin/Abigail: cancel a pending scheduled notification
app.delete('/api/notifications/scheduled/:id', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const companyId = req.user.companyId;
  const notifications = await getScheduledNotifications(companyId, { status: 'pending' });
  const target = notifications.find(n => n.id === req.params.id);
  if (!target) {
    return res.status(404).json({ error: 'Scheduled notification not found.' });
  }
  await updateScheduledNotification(companyId, req.params.id, { status: 'cancelled' });
  res.json({ success: true });
});

// Admin/Abigail: unified send history — every push notification the system
// has actually sent (custom, scheduled/recurring, Food's In, manual and
// auto reminders), logged in one place inside sendPushToUsers.
app.get('/api/notifications/history', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const history = await getNotificationHistory(req.user.companyId, { limit: 100 });
  res.json(history);
});

const MAX_AUTO_REMINDER_CHECKPOINTS = 5;

// Admin: current auto-reminder checkpoint configuration (falls back to the
// single-15-minutes default when a company hasn't customized it).
app.get('/api/settings/notifications', authMiddleware, requireAdmin, async (req, res) => {
  const settings = await getCompanySettings(req.user.companyId);
  res.json({
    autoReminderCheckpoints: settings.autoReminderCheckpoints && settings.autoReminderCheckpoints.length > 0
      ? settings.autoReminderCheckpoints
      : DEFAULT_AUTO_REMINDER_CHECKPOINTS
  });
});

// Admin: replace the full set of auto-reminder checkpoints (each an
// independent "X minutes before cutoff" nudge to anyone still pending).
app.put('/api/settings/notifications', authMiddleware, requireAdmin, async (req, res) => {
  const { autoReminderCheckpoints } = req.body;
  if (!Array.isArray(autoReminderCheckpoints) || autoReminderCheckpoints.length === 0) {
    return res.status(400).json({ error: 'autoReminderCheckpoints must be a non-empty array.' });
  }
  if (autoReminderCheckpoints.length > MAX_AUTO_REMINDER_CHECKPOINTS) {
    return res.status(400).json({ error: `You can configure at most ${MAX_AUTO_REMINDER_CHECKPOINTS} checkpoints.` });
  }
  const minutesSeen = new Set();
  for (const checkpoint of autoReminderCheckpoints) {
    const minutes = checkpoint.minutesBefore;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) {
      return res.status(400).json({ error: 'Each minutesBefore must be a whole number between 1 and 720.' });
    }
    if (minutesSeen.has(minutes)) {
      return res.status(400).json({ error: 'Checkpoints must have distinct minutesBefore values.' });
    }
    minutesSeen.add(minutes);
  }

  const normalized = autoReminderCheckpoints
    .map(c => ({ minutesBefore: c.minutesBefore, enabled: c.enabled !== false }))
    .sort((a, b) => b.minutesBefore - a.minutesBefore);

  const companyId = req.user.companyId;
  const current = await getCompanySettings(companyId);
  await saveCompanySettings(companyId, { ...current, autoReminderCheckpoints: normalized });
  res.json({ autoReminderCheckpoints: normalized });
});

// --- Reminders Endpoints ---

// Admin/Abigail: Trigger manual reminder (individual or bulk pending)
app.post('/api/reminders/send', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const { userId, bulk } = req.body;
  const companyId = req.user.companyId;
  const dailyState = await getDailyState(companyId);
  const roster = await getRoster(companyId);
  const orders = dailyState.orders || {};

  let usersToRemind = [];

  if (bulk) {
    // Collect all roster members not present in daily orders
    usersToRemind = roster.filter(u => !orders[u.id]);
  } else if (userId) {
    const targetUser = roster.find(u => u.id === userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found in roster.' });
    }
    if (orders[userId]) {
      return res.status(400).json({ error: 'User has already placed an order.' });
    }
    usersToRemind = [targetUser];
  } else {
    return res.status(400).json({ error: 'Either userId or bulk option must be specified.' });
  }

  if (usersToRemind.length === 0) {
    return res.json({ success: true, message: 'No pending users to remind.', reminded: [] });
  }

  const logs = await getRemindersLog(companyId);
  const notified = [];

  for (const user of usersToRemind) {
    const logEntry = {
      id: `rem-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      date: dailyState.date || getLocalDateString(),
      userId: user.id,
      userName: user.name,
      type: bulk ? 'bulk-manual' : 'single-manual',
      sentAt: new Date().toISOString()
    };

    logs.push(logEntry);
    notified.push({ id: user.id, name: user.name });
  }

  await saveRemindersLog(companyId, logs);

  sendPushToUsers(companyId, {
    title: '🍽️ Lunch reminder',
    body: `Hi! Please log your lunch choice today before cutoff.`
  }, notified.map(u => u.id), { type: 'reminder-manual', target: bulk ? 'pending' : 'single', sentBy: req.user.name })
    .catch(err => console.error('Error sending reminder push notifications:', err));

  res.json({ success: true, message: `Successfully sent reminders to ${notified.length} members.`, reminded: notified });
});

// Admin/Abigail: Retrieve history of reminders sent today
app.get('/api/reminders/logs', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const companyId = req.user.companyId;
  const logs = await getRemindersLog(companyId);
  const dailyState = await getDailyState(companyId);
  const currentDate = dailyState.date || getLocalDateString();
  const todaysLogs = logs.filter(log => log.date === currentDate);
  res.json(todaysLogs);
});

// --- Background Automated Reminders Scheduler ---
// Fallback when a company hasn't configured any checkpoints of its own —
// matches the single hardcoded "15 minutes before cutoff" this replaced.
const DEFAULT_AUTO_REMINDER_CHECKPOINTS = [{ minutesBefore: 15, enabled: true }];

async function checkAndSendAutoRemindersForCompany(companyId) {
  const [dailyState, companySettings] = await Promise.all([getDailyState(companyId), getCompanySettings(companyId)]);
  if (!dailyState.date || !dailyState.cutoffTime) return;

  const checkpoints = (companySettings.autoReminderCheckpoints && companySettings.autoReminderCheckpoints.length > 0)
    ? companySettings.autoReminderCheckpoints
    : DEFAULT_AUTO_REMINDER_CHECKPOINTS;

  const [cutoffHour, cutoffMin] = dailyState.cutoffTime.split(':').map(Number);
  const now = new Date();
  const cutoffTimeMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), cutoffHour, cutoffMin, 0, 0).getTime();
  const currentTimeMs = now.getTime();

  // Which checkpoints already fired today — reset to [] whenever the
  // business date rolls over (see handleDailyResetMiddleware), so this
  // field only ever reflects "today," no date comparison needed here.
  const firedMinutes = new Set(dailyState.autoReminderFiredMinutes || []);
  let changed = false;

  for (const checkpoint of checkpoints) {
    if (!checkpoint.enabled || firedMinutes.has(checkpoint.minutesBefore)) continue;

    const checkpointTimeMs = cutoffTimeMs - checkpoint.minutesBefore * 60 * 1000;
    if (currentTimeMs < checkpointTimeMs || currentTimeMs >= cutoffTimeMs) continue;

    const roster = await getRoster(companyId);
    const checkedInUserIds = new Set(Object.keys(dailyState.orders || {}));
    const pendingUsers = roster.filter(u => !checkedInUserIds.has(u.id));

    if (pendingUsers.length > 0) {
      console.log(`[AUTO REMINDER] Cutoff locks in ${checkpoint.minutesBefore} minutes for ${companyId}. Auto-notifying ${pendingUsers.length} unconfirmed users.`);

      // Per-user log entries drive each person's own dismissible "you were
      // reminded" banner (see myReminder in GET /api/daily) — distinct from
      // sendPushToUsers' notificationHistory write below, which is the
      // admin-facing "what did the system send" audit log.
      const logs = await getRemindersLog(companyId);
      for (const user of pendingUsers) {
        logs.push({
          id: `rem-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
          date: dailyState.date,
          userId: user.id,
          userName: user.name,
          type: 'auto-cutoff',
          sentAt: new Date().toISOString()
        });
      }
      await saveRemindersLog(companyId, logs);

      await sendPushToUsers(companyId, {
        title: `⏰ Cutoff in ${checkpoint.minutesBefore} minutes`,
        body: 'You haven\'t placed a lunch order yet today — pick your dish before the cutoff.'
      }, pendingUsers.map(u => u.id), { type: 'reminder-auto', target: 'pending', sentBy: null });
    }

    firedMinutes.add(checkpoint.minutesBefore);
    changed = true;
  }

  if (changed) {
    dailyState.autoReminderFiredMinutes = [...firedMinutes];
    await saveDailyState(companyId, dailyState);
  }
}

// Sends any scheduled notification whose sendAt has arrived. 'pending'
// target is resolved right now, not at schedule time — the set of people
// who haven't ordered yet can look very different an hour later.
// Computes the next occurrence of `time` (HH:MM) strictly after `afterMs`,
// optionally skipping Sat/Sun for weekday-only repeats.
function computeNextOccurrence(time, afterMs, weekdaysOnly) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(afterMs);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= afterMs) d.setDate(d.getDate() + 1);
  if (weekdaysOnly) {
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

async function checkScheduledNotificationsForCompany(companyId) {
  const due = await getScheduledNotifications(companyId, { status: 'pending' });
  const now = Date.now();

  for (const notification of due) {
    if (notification.sendAt > now) continue; // sorted by sendAt, but don't assume

    let userIds = null;
    if (notification.target === 'pending') {
      userIds = await resolvePendingUserIds(companyId);
    }

    try {
      await sendPushToUsers(companyId, { title: notification.title, body: notification.body }, userIds, {
        type: 'scheduled',
        target: notification.target,
        sentBy: notification.createdBy
      });
    } catch (err) {
      console.error(`Error sending scheduled notification ${notification.id}:`, err);
    }

    if (notification.repeat) {
      // Recurring — compute the next occurrence from its OWN scheduled time
      // (not "now"), so a slow or delayed tick never causes drift, and stay
      // 'pending' so the sweep picks it up again next time.
      const nextSendAt = computeNextOccurrence(notification.repeat.time, notification.sendAt, notification.repeat.type === 'weekdays');
      await updateScheduledNotification(companyId, notification.id, { sendAt: nextSendAt, lastSentAt: Date.now() });
    } else {
      await updateScheduledNotification(companyId, notification.id, { status: 'sent', sentAt: Date.now() });
    }
  }
}

// Sweeps every company each tick, one try/catch per company (and per sweep
// type) so one company's or one sweep's failure can't abort the rest.
async function runBackgroundSweep() {
  const companies = await getCompanies();
  for (const company of companies) {
    try {
      await checkAndSendAutoRemindersForCompany(company._id);
    } catch (err) {
      console.error(`Error in auto-reminder sweep for ${company._id}:`, err);
    }
    try {
      await checkScheduledNotificationsForCompany(company._id);
    } catch (err) {
      console.error(`Error in scheduled notification sweep for ${company._id}:`, err);
    }
  }
}

// Check every minute
setInterval(runBackgroundSweep, 60 * 1000);

// Start express server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
