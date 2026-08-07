import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { fileURLToPath } from 'url';
import {
  initDb,
  getRoster,
  saveRoster,
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
  deleteWeeklyPlan
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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database files
await initDb();

// Login-throttling settings, admin-editable at runtime via
// GET/PUT /api/settings/security — initDb() seeds a DB doc on first run.
let securitySettings = await getSecuritySettings();

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
async function archiveCurrentDay(dailyState) {
  if (dailyState.date && (dailyState.menu.length > 0 || Object.keys(dailyState.orders || {}).length > 0)) {
    const history = await getHistory();
    const existingIndex = history.findIndex(h => h.date === dailyState.date);

    const roster = await getRoster();
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
    await saveHistory(history);
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
async function applyWeeklyPlansForDate(dailyState) {
  if (
    !dailyState.date ||
    !dailyState.menuPublished ||
    !dailyState.menu?.length ||
    !isOperationalDay(dailyState) ||
    checkCutoff(dailyState)
  ) {
    return false;
  }

  const roster = await getRoster();
  const rosterIds = new Set(roster.map(u => u.id));
  const plans = await getAllWeeklyPlans();

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
      await saveWeeklyPlan(userId, plan);
    }
  }

  dailyState.weeklyPlansAppliedDate = dailyState.date;
  return true;
}

// Middleware: Check and handle daily transition/reset
// Serializes the check-archive-save sequence below across concurrent
// requests. Without this, two requests landing close together right as the
// business date rolls over can both read the same stale dailyState.date,
// both decide "this needs archiving," and both write a duplicate history
// entry — chaining onto this promise instead of a boolean flag closes the
// race regardless of how many requests arrive in the same tick.
let dailyRolloverChain = Promise.resolve();

async function handleDailyResetMiddleware(req, res, next) {
  const run = dailyRolloverChain.then(async () => {
    const dailyState = await getDailyState();
    const businessDate = getBusinessDateString(dailyState.archiveTime);

    if (!dailyState.date) {
      dailyState.date = businessDate;
      await applyWeeklyPlansForDate(dailyState);
      await saveDailyState(dailyState);
    } else if (dailyState.date !== businessDate) {
      // Archive time has passed, archive the previous business day
      await archiveCurrentDay(dailyState);

      // Reset daily state for the new business day
      dailyState.date = businessDate;
      dailyState.orders = {};
      dailyState.isManuallyLocked = null; // clear override; revert to time-based
      dailyState.cutoffExtensionMinutes = 0; // clear any extra time granted yesterday
      dailyState.foodArrival = null; // clear yesterday's "food's in" broadcast
      // Retain menu, menuPublished, cutoffTime and archiveTime — the menu
      // carries over day to day until an admin changes it
      await applyWeeklyPlansForDate(dailyState); // must run after orders={} above
      await saveDailyState(dailyState);
    } else if (dailyState.weeklyPlansAppliedDate !== businessDate) {
      // The apply bailed earlier today (e.g. menu wasn't published yet at
      // rollover time) — retry on every request until it succeeds. Cheap:
      // once weeklyPlansAppliedDate is set, this branch never runs again today.
      if (await applyWeeklyPlansForDate(dailyState)) {
        await saveDailyState(dailyState);
      }
    }
  });
  dailyRolloverChain = run.catch(() => {}); // keep the chain alive even if this run throws

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

// Helper: patch a single roster record by id
async function updateUser(id, patch) {
  const roster = await getRoster();
  const index = roster.findIndex(u => u.id === id);
  if (index === -1) return null;
  roster[index] = { ...roster[index], ...patch };
  await saveRoster(roster);
  return roster[index];
}

// Middleware: Authenticate request via signed session token & attach req.user.
// The token is only ever issued at /api/login after a verified passcode
// check, so a valid token is proof of identity for every role — there's no
// separate per-request passcode check to bypass.
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

  const roster = await getRoster();
  const user = roster.find(u => u.id === decoded.userId);

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

// --- Endpoints ---

// Slow down brute-forcing of the (short, numeric-ish) passcode. windowMs
// can't be changed on an existing express-rate-limit instance, so an admin
// edit to these settings rebuilds the instance — the route below calls
// through a wrapper so that swap takes effect without re-registering routes.
function buildLoginRateLimiter(settings) {
  const windowMs = settings.loginRateLimitWindowMinutes * 60 * 1000;
  return rateLimit({
    windowMs,
    max: settings.loginRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    // Key by the account being logged into, not the caller's IP — this app
    // runs behind a shared office IP, so an IP-keyed limit means one
    // person's failed attempts lock out everyone else trying to log in.
    // The per-account lockout below is the real brute-force defense; this
    // is just a lighter-weight first line against rapid automated attempts.
    keyGenerator: (req) => req.body?.userId || req.ip,
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

let loginRateLimiterInstance = buildLoginRateLimiter(securitySettings);

// Login: verify passcode, issue a signed session token
app.post('/api/login', (req, res, next) => loginRateLimiterInstance(req, res, next), async (req, res) => {
  const { userId, passcode } = req.body;
  if (!userId || !passcode) {
    return res.status(400).json({ error: 'User ID and passcode are required.' });
  }
  const roster = await getRoster();
  const user = roster.find(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const now = Date.now();
  if (user.lockedUntil && user.lockedUntil > now) {
    return res.status(429).json({
      error: `Account temporarily locked due to repeated failed attempts. Try again in ${formatDuration(user.lockedUntil - now)}.`,
      retryAfterMs: user.lockedUntil - now
    });
  }

  const valid = user.passcodeHash && await bcrypt.compare(passcode, user.passcodeHash);
  if (!valid) {
    const loginLockoutMs = securitySettings.loginLockoutMinutes * 60 * 1000;
    const fails = (user.failedAttempts || 0) + 1;
    const patch = { failedAttempts: fails };
    if (fails >= securitySettings.loginMaxFailedAttempts) {
      patch.lockedUntil = now + loginLockoutMs;
      patch.failedAttempts = 0;
      await updateUser(user.id, patch);
      return res.status(429).json({
        error: `Too many failed attempts. Account locked for ${formatDuration(loginLockoutMs)}.`,
        retryAfterMs: loginLockoutMs
      });
    }
    await updateUser(user.id, patch);
    const remaining = securitySettings.loginMaxFailedAttempts - fails;
    return res.status(401).json({
      error: `Incorrect passcode. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining before your account is locked.`
    });
  }

  if (user.failedAttempts || user.lockedUntil) {
    await updateUser(user.id, { failedAttempts: 0, lockedUntil: null });
  }

  const { passcodeHash: _, ...safeUser } = user;
  const token = issueToken(user);
  res.json({ success: true, token, user: safeUser });
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
// the mandatory first-login change and any later voluntary change.
app.post('/api/change-passcode', authMiddleware, async (req, res) => {
  const { newPasscode } = req.body;
  const validationError = validatePasscode(newPasscode, req.user);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const roster = await getRoster();
  const userIndex = roster.findIndex(u => u.id === req.user.id);
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found.' });
  }

  roster[userIndex] = {
    ...roster[userIndex],
    passcodeHash: await hashPasscode(newPasscode),
    mustChangePasscode: false,
    passcodeChangedAt: Date.now()
  };
  await saveRoster(roster);

  const { passcodeHash: _, ...safeUser } = roster[userIndex];
  // Reissue the token: authMiddleware rejects tokens older than
  // passcodeChangedAt, which would otherwise invalidate the very request
  // that just changed it.
  const token = issueToken(roster[userIndex]);
  res.json({ success: true, token, user: safeUser });
});

// Public, pre-login: just enough for the login name-picker. No email, phone,
// role, or passcode status — that's PII/recon value an unauthenticated
// caller has no reason to see.
app.get('/api/roster/login-list', async (req, res) => {
  const roster = await getRoster();
  res.json(roster.map(u => ({ id: u.id, name: u.name })));
});

// Retrieve full team roster (never exposes passcode data, hashed or
// otherwise) — requires a verified session; this is real PII (email, phone).
app.get('/api/roster', authMiddleware, async (req, res) => {
  const roster = await getRoster();
  const safeRoster = roster.map(({ passcode, passcodeHash, pushSubscriptions, ...rest }) => ({
    ...rest,
    hasPasscode: !!passcodeHash
  }));
  res.json(safeRoster);
});

// Admin: Add a user
app.post('/api/roster', authMiddleware, requireAdmin, async (req, res) => {
  const { name, email, phone, role, passcode } = req.body;
  if (!name || !role) {
    return res.status(400).json({ error: 'Name and Role are required.' });
  }

  const roster = await getRoster();
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
    name,
    email: email || '',
    phone: phone || '',
    role,
    passcodeHash: await hashPasscode(initialPasscode),
    passcodeChangedAt: Date.now(),
    // An admin-assigned passcode is known to more than just this person —
    // require them to set their own the first time they log in.
    mustChangePasscode: true
  };

  roster.push(newUser);
  await saveRoster(roster);
  const { passcodeHash: _, ...safeUser } = newUser;
  // Returned once so the admin can share it securely — it can't be
  // retrieved again after this response.
  res.status(201).json({ ...safeUser, initialPasscode });
});

// Admin: Edit a user
app.put('/api/roster/:id', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, role, passcode } = req.body;

  const roster = await getRoster();
  const userIndex = roster.findIndex(u => u.id === id);

  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found.' });
  }

  if (id === 'usr-admin' && role !== 'Admin') {
    return res.status(400).json({ error: 'Cannot change role of default system admin.' });
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
    passcodeHash: passcode ? await hashPasscode(passcode) : roster[userIndex].passcodeHash,
    passcodeChangedAt: passcode ? Date.now() : roster[userIndex].passcodeChangedAt,
    // Any admin-set passcode (including a reset) is known to the admin too —
    // require the person to set their own before it's trusted as private.
    mustChangePasscode: passcode ? true : roster[userIndex].mustChangePasscode
  };

  roster[userIndex] = updatedUser;
  await saveRoster(roster);
  const { passcodeHash: _, ...safeUser } = updatedUser;
  res.json(safeUser);
});

// Admin: Reset a user's passcode to a fresh random value (shown once)
app.post('/api/roster/:id/reset-passcode', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const roster = await getRoster();
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
  await saveRoster(roster);

  const { passcodeHash: _, ...safeUser } = roster[userIndex];
  res.json({ success: true, user: safeUser, newPasscode });
});

// Admin: Remove a user
app.delete('/api/roster/:id', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (id === 'usr-admin') {
    return res.status(400).json({ error: 'Cannot delete the default system admin user.' });
  }

  let roster = await getRoster();
  const userExists = roster.some(u => u.id === id);

  if (!userExists) {
    return res.status(404).json({ error: 'User not found.' });
  }

  roster = roster.filter(u => u.id !== id);
  await saveRoster(roster);

  const dailyState = await getDailyState();
  if (dailyState.orders && dailyState.orders[id]) {
    delete dailyState.orders[id];
    await saveDailyState(dailyState);
  }
  await deleteWeeklyPlan(id);

  res.json({ success: true, message: 'User removed from roster.' });
});

// Get daily menu, orders, and stats summaries
app.get('/api/daily', authMiddleware, async (req, res) => {
  const dailyState = await getDailyState();
  const roster = await getRoster();

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
    const logs = await getRemindersLog();
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

// Admin: Set daily menu
app.post('/api/menu', authMiddleware, requireAdmin, async (req, res) => {
  const { menu } = req.body;
  if (!Array.isArray(menu)) {
    return res.status(400).json({ error: 'Menu must be an array.' });
  }

  const dailyState = await getDailyState();
  if (checkCutoff(dailyState)) {
    return res.status(400).json({ error: 'Cutoff time has passed. Menu is locked.' });
  }

  dailyState.menu = menu.map(item => ({
    id: item.id || `dish-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    name: item.name,
    description: item.description || '',
    price: item.price || ''
  }));

  await saveDailyState(dailyState);
  res.json({ success: true, menu: dailyState.menu });
});

// Admin: Publish menu
app.post('/api/publish-menu', authMiddleware, requireAdmin, async (req, res) => {
  const { published } = req.body;
  const dailyState = await getDailyState();

  if (checkCutoff(dailyState)) {
    return res.status(400).json({ error: 'Cutoff time has passed. State is locked.' });
  }

  dailyState.menuPublished = !!published;
  await saveDailyState(dailyState);
  res.json({ success: true, menuPublished: dailyState.menuPublished });
});

// Admin: View current login-throttling settings
app.get('/api/settings/security', authMiddleware, requireAdmin, async (req, res) => {
  res.json(securitySettings);
});

// Admin: Update login-throttling settings (account lockout + rate limiting)
app.put('/api/settings/security', authMiddleware, requireAdmin, async (req, res) => {
  const updated = { ...securitySettings };

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

  await saveSecuritySettings(updated);
  securitySettings = updated;
  loginRateLimiterInstance = buildLoginRateLimiter(securitySettings);

  res.json(securitySettings);
});

// Admin: Change daily cutoff time
app.post('/api/cutoff', authMiddleware, requireAdmin, async (req, res) => {
  const { cutoffTime } = req.body;
  if (!cutoffTime || !/^\d{2}:\d{2}$/.test(cutoffTime)) {
    return res.status(400).json({ error: 'Invalid time format. Must be HH:MM.' });
  }

  const dailyState = await getDailyState();
  dailyState.cutoffTime = cutoffTime;
  dailyState.cutoffExtensionMinutes = 0; // setting a new base cutoff clears any prior extension
  await saveDailyState(dailyState);
  res.json({ success: true, cutoffTime: dailyState.cutoffTime });
});

// Admin: Grant extra minutes past today's cutoff, e.g. once it's already
// passed and people still need a bit more time. Additive across calls.
app.post('/api/cutoff/extend', authMiddleware, requireAdmin, async (req, res) => {
  const { minutes } = req.body;
  if (!Number.isInteger(minutes) || minutes <= 0) {
    return res.status(400).json({ error: 'minutes must be a positive whole number.' });
  }

  const dailyState = await getDailyState();
  dailyState.cutoffExtensionMinutes = (dailyState.cutoffExtensionMinutes || 0) + minutes;
  await saveDailyState(dailyState);

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

  const dailyState = await getDailyState();
  dailyState.archiveTime = archiveTime;
  await saveDailyState(dailyState);
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

  const dailyState = await getDailyState();
  dailyState.operationalDays = [...operationalDays].sort((a, b) => a - b);
  await saveDailyState(dailyState);
  res.json({ success: true, operationalDays: dailyState.operationalDays });
});

// Team Member: Place daily dish order
app.post('/api/order', authMiddleware, async (req, res) => {
  const { itemId, note } = req.body;
  const userId = req.user.id;

  const dailyState = await getDailyState();

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

  await saveDailyState(dailyState);
  res.json({ success: true, order });
});

// Team Member: Cancel today's own order (opt out entirely, not just change dish)
app.delete('/api/order', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const dailyState = await getDailyState();

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
  await saveDailyState(dailyState);
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

  const roster = await getRoster();
  const targetUser = roster.find(u => u.id === userId);
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found in roster.' });
  }

  const dailyState = await getDailyState();

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

  await saveDailyState(dailyState);
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

  if (isPast) {
    const pastOrder = pastEntry?.orders?.[userId];
    if (pastOrder) {
      source = 'order';
      dishName = pastEntry.menu.find(m => m.id === pastOrder.itemId)?.name || null;
      note = pastOrder.note || '';
      served = !!pastOrder.served;
      viaWeeklyPlan = !!pastOrder.viaWeeklyPlan;
    }
  } else if (isToday) {
    const order = dailyState.orders?.[userId];
    if (order) {
      source = 'order';
      dishName = dailyState.menu.find(m => m.id === order.itemId)?.name || null;
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
      dishStillOnMenu = !!findMenuItemByName(dailyState.menu, planEntry.dishName);
    }
  }

  return {
    date, weekday, dayName, isToday, isPast, isOperational, isLocked,
    cutoffTimestamp, source, dishName, note, served, viaWeeklyPlan, dishStillOnMenu,
    editable: !isLocked && isOperational && !!dailyState.menuPublished
  };
}

// Team Member: Read this week's plan — one card per operational day in the
// current Mon-Sun week, sourced from history/today's order/plan as above.
app.get('/api/week-plan', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  // getWeeklyPlan doesn't depend on dailyState, so run them concurrently
  // instead of paying two sequential Atlas round-trips back to back.
  const [dailyState, plan] = await Promise.all([getDailyState(), getWeeklyPlan(userId)]);
  const weekDates = getPlanWeekDates(dailyState);

  const pastDates = weekDates.filter(d => dailyState.date && d < dailyState.date);
  const history = await getHistoryForDates(pastDates);
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
app.put('/api/week-plan/:date', authMiddleware, async (req, res) => {
  const { date } = req.params;
  const { dishName, note } = req.body;
  const userId = req.user.id;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format.' });
  }

  const dailyState = await getDailyState();
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

  const plan = await getWeeklyPlan(userId);
  plan.entries = plan.entries || {};

  if (date === dailyState.date) {
    writeOrderForUser(dailyState, userId, matched.id, note);
    await saveDailyState(dailyState);
    // A real order now exists for today — drop any lingering plan entry so
    // the two stores never disagree about what "today" means.
    if (plan.entries[date]) {
      delete plan.entries[date];
      await saveWeeklyPlan(userId, plan);
    }
  } else {
    plan.entries[date] = {
      dishName: matched.name,
      note: sanitizeOrderNote(note),
      updatedAt: Date.now(),
      source: 'manual'
    };
    plan.updatedAt = Date.now();
    await saveWeeklyPlan(userId, plan);
  }

  res.json({ success: true, day: buildWeekDayInfo(dailyState, plan, date, userId, null) });
});

// Team Member: Clear one day back to "Skipped". Today follows the same
// already-served guard as DELETE /api/order.
app.delete('/api/week-plan/:date', authMiddleware, async (req, res) => {
  const { date } = req.params;
  const userId = req.user.id;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format.' });
  }

  const dailyState = await getDailyState();
  const weekDates = getPlanWeekDates(dailyState);
  if (!weekDates.includes(date)) {
    return res.status(400).json({ error: "That date isn't in this week's plan." });
  }

  const dayName = DAY_NAMES[getWeekdayForDate(date)];
  if (isDateLocked(dailyState, date)) {
    return res.status(400).json({ error: `Orders for ${dayName} are already locked.` });
  }

  const plan = await getWeeklyPlan(userId);
  plan.entries = plan.entries || {};

  if (date === dailyState.date) {
    const existingOrder = dailyState.orders?.[userId];
    if (existingOrder) {
      if (existingOrder.served) {
        return res.status(400).json({ error: 'This order has already been served and can\'t be cancelled. Contact an admin.' });
      }
      delete dailyState.orders[userId];
      await saveDailyState(dailyState);
    }
  } else if (plan.entries[date]) {
    delete plan.entries[date];
    plan.updatedAt = Date.now();
    await saveWeeklyPlan(userId, plan);
  }

  res.json({ success: true, day: buildWeekDayInfo(dailyState, plan, date, userId, null) });
});

// Team Member: "Use this dish for the rest of the week" — fans one pick out
// across the remaining unlocked/operational days after fromDate (default
// today), overwriting any existing picks on those days. Deliberately does
// NOT propagate the note — a note like "for the client meeting" should
// never silently apply to four other days, only the dish does.
app.post('/api/week-plan/repeat', authMiddleware, async (req, res) => {
  const { dishName, note, fromDate } = req.body;
  const userId = req.user.id;

  const dailyState = await getDailyState();
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

  const plan = await getWeeklyPlan(userId);
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
  await saveWeeklyPlan(userId, plan);
  if (dailyStateChanged) await saveDailyState(dailyState);

  res.json({ success: true, appliedDates, skippedDates });
});

// Admin/Abigail: Toggle whether a person's dish has physically been handed out
app.post('/api/order/serve', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const { userId, served } = req.body;
  if (!userId || typeof served !== 'boolean') {
    return res.status(400).json({ error: 'userId and a boolean served flag are required.' });
  }

  const dailyState = await getDailyState();
  const order = dailyState.orders?.[userId];
  if (!order) {
    return res.status(404).json({ error: 'This person has not placed an order yet.' });
  }

  order.served = served;
  await saveDailyState(dailyState);
  res.json({ success: true, order });
});

// Admin/Abigail: Remove a specific person's order from today's board (e.g.
// to fix a mistaken selection). Blocked once cutoff passes — at that point
// the list is treated as submitted to the vendor and shouldn't change.
app.delete('/api/order/:userId', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const { userId } = req.params;
  const dailyState = await getDailyState();

  if (checkCutoff(dailyState)) {
    return res.status(400).json({ error: 'The daily cutoff time has passed. The order list is locked.' });
  }

  if (!dailyState.orders?.[userId]) {
    return res.status(404).json({ error: 'This person has not placed an order.' });
  }

  delete dailyState.orders[userId];
  await saveDailyState(dailyState);
  res.json({ success: true });
});

// Admin: Clear every order placed today so the roster can make fresh selections
app.post('/api/order/clear-all', authMiddleware, requireAdmin, async (req, res) => {
  const dailyState = await getDailyState();
  dailyState.orders = {};
  await saveDailyState(dailyState);
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

  const dailyState = await getDailyState();
  dailyState.isManuallyLocked = locked;
  await saveDailyState(dailyState);

  const effectiveLocked = checkCutoff(dailyState);
  res.json({ success: true, isManuallyLocked: locked, isLocked: effectiveLocked });
});

// Admin: Bulk add team members
app.post('/api/roster/bulk', authMiddleware, requireAdmin, async (req, res) => {
  const { members } = req.body;
  if (!Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'members must be a non-empty array.' });
  }

  const roster = await getRoster();
  const added = [];
  const skipped = [];

  for (const m of members) {
    const name = (m.name || '').trim();
    if (!name) { skipped.push({ entry: m, reason: 'Missing name' }); continue; }

    const duplicate = roster.some(u => u.name.toLowerCase() === name.toLowerCase());
    if (duplicate) { skipped.push({ entry: m, reason: `"${name}" already exists` }); continue; }

    if (m.passcode) {
      const validationError = validatePasscode(m.passcode, { name, email: m.email });
      if (validationError) { skipped.push({ entry: m, reason: validationError }); continue; }
    }

    const role = m.role || 'Team Member';
    const initialPasscode = m.passcode || generatePasscode();
    const newUser = {
      id: `usr-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      name,
      email: (m.email || '').trim(),
      phone: (m.phone || '').trim(),
      role,
      passcodeHash: await hashPasscode(initialPasscode),
      passcodeChangedAt: Date.now(),
      mustChangePasscode: true
    };
    roster.push(newUser);
    added.push({ ...newUser, initialPasscode });
  }

  if (added.length > 0) await saveRoster(roster);

  res.json({
    success: true,
    added: added.length,
    skipped: skipped.length,
    skippedDetails: skipped,
    // Each member's one-time initialPasscode is included so the admin can
    // share it — it can't be retrieved again after this response.
    members: added.map(({ passcodeHash, ...rest }) => rest)
  });
});

// Any logged-in user: View their own past orders
app.get('/api/my-orders', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const history = await getHistory();

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

// Admin/Abigail: View historical records
app.get('/api/history', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const history = await getHistory();
  res.json(history.slice().reverse()); // Newest first
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

  const history = await getHistory();
  const entry = history.find(h => h.date === date);
  if (!entry) {
    return res.status(404).json({ error: 'No archived record for this date.' });
  }
  const order = entry.orders?.[userId];
  if (!order) {
    return res.status(404).json({ error: 'This person has no order on that date.' });
  }

  order.served = served;
  await saveHistory(history);
  res.json({ success: true, order });
});

// --- Push Notifications ---

// Public: the client needs this to call pushManager.subscribe()
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: pushEnabled ? VAPID_PUBLIC_KEY : null });
});

// Save a browser push subscription against the logged-in user. A person can
// have more than one (phone + laptop), keyed by the subscription's unique
// endpoint URL so re-subscribing the same device just updates it in place.
app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint || !subscription?.keys) {
    return res.status(400).json({ error: 'A valid push subscription is required.' });
  }

  const roster = await getRoster();
  const userIndex = roster.findIndex(u => u.id === req.user.id);
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const subs = roster[userIndex].pushSubscriptions || [];
  const withoutDupe = subs.filter(s => s.endpoint !== subscription.endpoint);
  roster[userIndex].pushSubscriptions = [...withoutDupe, subscription];
  await saveRoster(roster);

  console.log(`Push subscription saved for ${roster[userIndex].name} (now ${roster[userIndex].pushSubscriptions.length} device(s)).`);
  res.json({ success: true });
});

// Remove a push subscription (e.g. the user turned notifications off)
app.post('/api/push/unsubscribe', authMiddleware, async (req, res) => {
  const { endpoint } = req.body;
  const roster = await getRoster();
  const userIndex = roster.findIndex(u => u.id === req.user.id);
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found.' });
  }

  roster[userIndex].pushSubscriptions = (roster[userIndex].pushSubscriptions || [])
    .filter(s => s.endpoint !== endpoint);
  await saveRoster(roster);

  res.json({ success: true });
});

// Sends a push payload to every subscribed device across the whole roster.
// Dead subscriptions (expired/revoked — 404 or 410 from the push service)
// are dropped so they stop being retried forever.
async function sendPushToAllUsers(payload) {
  if (!pushEnabled) {
    console.warn('sendPushToAllUsers: push is disabled (missing VAPID keys) — nothing sent.');
    return;
  }

  const roster = await getRoster();
  const body = JSON.stringify(payload);
  let changed = false;
  let attempted = 0;
  let sent = 0;
  let dropped = 0;

  for (const user of roster) {
    const subs = user.pushSubscriptions || [];
    if (subs.length === 0) continue;

    const survivors = [];
    for (const sub of subs) {
      attempted++;
      try {
        await webpush.sendNotification(sub, body);
        sent++;
        survivors.push(sub);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          changed = true; // subscription is dead, drop it
          dropped++;
        } else {
          console.error(`Push failed for ${user.name}:`, err.statusCode, err.message);
          survivors.push(sub); // transient failure — keep it, don't drop on a fluke
        }
      }
    }
    user.pushSubscriptions = survivors;
  }

  console.log(`Push broadcast: ${sent}/${attempted} device(s) sent successfully, ${dropped} dead subscription(s) dropped.`);

  if (changed) await saveRoster(roster);
}

// Admin/Abigail: broadcast "the food has arrived" — shows an in-app banner
// to everyone currently on the page, and sends a real push notification to
// anyone who has notifications enabled (reaches them even with the tab closed).
app.post('/api/food-arrived', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const dailyState = await getDailyState();
  dailyState.foodArrival = { at: Date.now(), by: req.user.name };
  await saveDailyState(dailyState);

  sendPushToAllUsers({
    title: '🍽️ Lunch has arrived!',
    body: `${req.user.name} says today's food is here — come get it.`
  }).catch(err => console.error('Error broadcasting push notifications:', err));

  res.json({ success: true, foodArrival: dailyState.foodArrival });
});

// --- Reminders Endpoints ---

// Admin/Abigail: Trigger manual reminder (individual or bulk pending)
app.post('/api/reminders/send', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const { userId, bulk } = req.body;
  const dailyState = await getDailyState();
  const roster = await getRoster();
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

  const logs = await getRemindersLog();
  const notified = [];

  for (const user of usersToRemind) {
    const method = user.email ? 'email' : user.phone ? 'SMS' : 'Console';
    console.log(`[MOCK NOTIFICATION] Sent reminder to ${user.name} via ${method} - "Hi ${user.name}, please log your lunch choice today before cutoff."`);

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

  await saveRemindersLog(logs);
  res.json({ success: true, message: `Successfully sent reminders to ${notified.length} members.`, reminded: notified });
});

// Admin/Abigail: Retrieve history of reminders sent today
app.get('/api/reminders/logs', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const logs = await getRemindersLog();
  const dailyState = await getDailyState();
  const currentDate = dailyState.date || getLocalDateString();
  const todaysLogs = logs.filter(log => log.date === currentDate);
  res.json(todaysLogs);
});

// --- Background Automated Reminders Scheduler ---
async function checkAndSendAutoReminders() {
  try {
    const dailyState = await getDailyState();
    if (!dailyState.date || !dailyState.cutoffTime) return;

    const systemDate = getLocalDateString();
    if (dailyState.autoReminderSentDate === systemDate) {
      return; // Already triggered automated alerts today
    }

    const [cutoffHour, cutoffMin] = dailyState.cutoffTime.split(':').map(Number);
    const now = new Date();
    const cutoffTimeMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), cutoffHour, cutoffMin, 0, 0).getTime();
    const reminderTimeMs = cutoffTimeMs - 15 * 60 * 1000; // 15 mins before cutoff time
    const currentTimeMs = now.getTime();

    // Trigger alerts if within the 15 minute warning window
    if (currentTimeMs >= reminderTimeMs && currentTimeMs < cutoffTimeMs) {
      const roster = await getRoster();
      const checkedInUserIds = new Set([
        ...dailyState.orders.inOffice.map(o => o.userId),
        ...dailyState.orders.onTheWay.map(o => o.userId),
        ...dailyState.orders.notComing.map(o => o.userId)
      ]);
      const pendingUsers = roster.filter(u => !checkedInUserIds.has(u.id));

      if (pendingUsers.length > 0) {
        const logs = await getRemindersLog();
        console.log(`[AUTO REMINDER] Cutoff locks in 15 minutes. Auto-notifying ${pendingUsers.length} unconfirmed users.`);

        for (const user of pendingUsers) {
          const method = user.email ? 'email' : user.phone ? 'SMS' : 'Console';
          console.log(`[MOCK NOTIFICATION] Auto-sent cutoff warning to ${user.name} via ${method}`);

          logs.push({
            id: `rem-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
            date: dailyState.date,
            userId: user.id,
            userName: user.name,
            type: 'auto-cutoff-15m',
            sentAt: new Date().toISOString()
          });
        }
        await saveRemindersLog(logs);
      }

      dailyState.autoReminderSentDate = systemDate;
      await saveDailyState(dailyState);
    }
  } catch (err) {
    console.error('Error in background reminder loop:', err);
  }
}

// Check every minute
setInterval(checkAndSendAutoReminders, 60 * 1000);

// Start express server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
