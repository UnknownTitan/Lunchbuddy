import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import {
  initDb,
  getRoster,
  saveRoster,
  getDailyState,
  saveDailyState,
  getHistory,
  saveHistory,
  getRemindersLog,
  saveRemindersLog
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET is not set. Add it to your .env file.');
}
const TOKEN_EXPIRY = '24h';
const PASSCODE_SALT_ROUNDS = 10;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(morgan('dev'));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database files
await initDb();

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

// Helper: The actual cutoff Date/time for the current business date, after
// adding any extra minutes an admin has granted (see /api/cutoff/extend).
// Anchoring to dailyState.date (not just the wall-clock hour:minute) matters
// because a business date can span from archiveTime one calendar day to
// archiveTime the next — a bare hour:minute comparison would treat a brand
// new business date as already-past-cutoff for the rest of that calendar day.
function getEffectiveCutoffDate(dailyState) {
  const [year, month, day] = dailyState.date.split('-').map(Number);
  const [cutoffHour, cutoffMin] = dailyState.cutoffTime.split(':').map(Number);
  const cutoffDate = new Date(year, month - 1, day, cutoffHour, cutoffMin, 0, 0);
  cutoffDate.setMinutes(cutoffDate.getMinutes() + (dailyState.cutoffExtensionMinutes || 0));
  return cutoffDate;
}

// Helper: Format a Date's time-of-day back to an HH:MM string
function formatMinutesAsHHMM(date) {
  const hour = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${hour}:${min}`;
}

// Helper: Check if orders are locked (manual lock OR effective cutoff time passed)
function checkCutoff(dailyState) {
  // Admin can force-lock early regardless of time
  if (dailyState.isManuallyLocked === true) return true;

  if (!dailyState.cutoffTime || !dailyState.date) return false;
  return Date.now() >= getEffectiveCutoffDate(dailyState).getTime();
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

// Middleware: Check and handle daily transition/reset
async function handleDailyResetMiddleware(req, res, next) {
  try {
    const dailyState = await getDailyState();
    const businessDate = getBusinessDateString(dailyState.archiveTime);

    if (!dailyState.date) {
      dailyState.date = businessDate;
      await saveDailyState(dailyState);
    } else if (dailyState.date !== businessDate) {
      // Archive time has passed, archive the previous business day
      await archiveCurrentDay(dailyState);

      // Reset daily state for the new business day
      dailyState.date = businessDate;
      dailyState.orders = {};
      dailyState.isManuallyLocked = null; // clear override; revert to time-based
      dailyState.cutoffExtensionMinutes = 0; // clear any extra time granted yesterday
      // Retain menu, menuPublished, cutoffTime and archiveTime — the menu
      // carries over day to day until an admin changes it
      await saveDailyState(dailyState);
    }
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

// Slow down brute-forcing of the (short, numeric-ish) passcode
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait a few minutes and try again.' }
});

// Login: verify passcode, issue a signed session token
app.post('/api/login', loginRateLimiter, async (req, res) => {
  const { userId, passcode } = req.body;
  if (!userId || !passcode) {
    return res.status(400).json({ error: 'User ID and passcode are required.' });
  }
  const roster = await getRoster();
  const user = roster.find(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }
  const valid = user.passcodeHash && await bcrypt.compare(passcode, user.passcodeHash);
  if (!valid) {
    return res.status(401).json({ error: 'Incorrect passcode.' });
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
  if (!newPasscode || newPasscode.length < 4) {
    return res.status(400).json({ error: 'New passcode must be at least 4 characters.' });
  }

  const roster = await getRoster();
  const userIndex = roster.findIndex(u => u.id === req.user.id);
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found.' });
  }

  roster[userIndex] = {
    ...roster[userIndex],
    passcodeHash: await hashPasscode(newPasscode),
    mustChangePasscode: false
  };
  await saveRoster(roster);

  const { passcodeHash: _, ...safeUser } = roster[userIndex];
  res.json({ success: true, user: safeUser });
});

// Retrieve team roster (never exposes passcode data, hashed or otherwise)
app.get('/api/roster', async (req, res) => {
  const roster = await getRoster();
  const safeRoster = roster.map(({ passcode, passcodeHash, ...rest }) => ({
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

  const newUser = {
    id: `usr-${Date.now()}`,
    name,
    email: email || '',
    phone: phone || '',
    role,
    passcodeHash: await hashPasscode(passcode || '1234'),
    // An admin-assigned passcode is known to more than just this person —
    // require them to set their own the first time they log in.
    mustChangePasscode: true
  };

  roster.push(newUser);
  await saveRoster(roster);
  const { passcodeHash: _, ...safeUser } = newUser;
  res.status(201).json(safeUser);
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

  const updatedUser = {
    ...roster[userIndex],
    name: name || roster[userIndex].name,
    email: email !== undefined ? email : roster[userIndex].email,
    phone: phone !== undefined ? phone : roster[userIndex].phone,
    role: role || roster[userIndex].role,
    passcodeHash: passcode ? await hashPasscode(passcode) : roster[userIndex].passcodeHash,
    // Any admin-set passcode (including a reset) is known to the admin too —
    // require the person to set their own before it's trusted as private.
    mustChangePasscode: passcode ? true : roster[userIndex].mustChangePasscode
  };

  roster[userIndex] = updatedUser;
  await saveRoster(roster);
  const { passcodeHash: _, ...safeUser } = updatedUser;
  res.json(safeUser);
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

  res.json({ success: true, message: 'User removed from roster.' });
});

// Get daily menu, orders, and stats summaries
app.get('/api/daily', async (req, res) => {
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
        served: !!userOrder.served
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
  const requesterId = req.headers['x-user-id'];
  if (requesterId && dailyState.date) {
    const logs = await getRemindersLog();
    const myLogs = logs.filter(l => l.userId === requesterId && l.date === dailyState.date);
    if (myLogs.length > 0) {
      myReminder = myLogs[myLogs.length - 1];
    }
  }

  res.json({
    date: dailyState.date,
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

// Team Member: Place daily dish order
app.post('/api/order', authMiddleware, async (req, res) => {
  const { itemId } = req.body;
  const userId = req.user.id;

  const dailyState = await getDailyState();

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

  dailyState.orders = dailyState.orders || {};
  dailyState.orders[userId] = {
    itemId,
    timestamp: Date.now()
  };

  await saveDailyState(dailyState);
  res.json({ success: true, order: dailyState.orders[userId] });
});

// Admin/Abigail: Place or change an order on behalf of a team member who
// informed a coordinator but couldn't submit it themselves. Subject to the
// same cutoff as self-serve orders — an admin needing more room to add
// stragglers should grant extra time via /api/cutoff/extend instead.
app.post('/api/order/assign', authMiddleware, requireAdminOrAbigail, async (req, res) => {
  const { userId, itemId } = req.body;
  if (!userId || !itemId) {
    return res.status(400).json({ error: 'userId and itemId are required.' });
  }

  const roster = await getRoster();
  const targetUser = roster.find(u => u.id === userId);
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found in roster.' });
  }

  const dailyState = await getDailyState();

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
    assignedBy: req.user.name
  };

  await saveDailyState(dailyState);
  res.json({ success: true, order: dailyState.orders[userId] });
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

    const role = m.role || 'Team Member';
    const newUser = {
      id: `usr-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      name,
      email: (m.email || '').trim(),
      phone: (m.phone || '').trim(),
      role,
      passcodeHash: await hashPasscode(m.passcode || '1234'),
      mustChangePasscode: true
    };
    roster.push(newUser);
    added.push(newUser);
  }

  if (added.length > 0) await saveRoster(roster);

  res.json({
    success: true,
    added: added.length,
    skipped: skipped.length,
    skippedDetails: skipped,
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
