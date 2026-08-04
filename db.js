import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const ROSTER_PATH = path.join(DATA_DIR, 'roster.json');
const DAILY_STATE_PATH = path.join(DATA_DIR, 'daily_state.json');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const REMINDERS_LOG_PATH = path.join(DATA_DIR, 'reminders_log.json');

// Ensure data directory exists
async function ensureDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

// Atomic file writing
async function writeJsonAtomic(filePath, data) {
  await ensureDir();
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tempPath, filePath);
}

async function readJson(filePath, defaultValue) {
  await ensureDir();
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      await writeJsonAtomic(filePath, defaultValue);
      return defaultValue;
    }
    throw err;
  }
}

export async function initDb() {
  await ensureDir();
  
  // Initialize roster
  const defaultRoster = [
    {
      id: "usr-admin",
      name: "System Admin",
      email: "admin@company.com",
      phone: "",
      role: "Admin",
      passcode: "admin123"
    }
  ];
  await readJson(ROSTER_PATH, defaultRoster);

  // Initialize daily state
  const defaultDaily = {
    date: "", // Will be set on first request
    cutoffTime: "11:30",
    archiveTime: "14:00",
    menu: [],
    menuPublished: false,
    orders: {} // userId -> { status, itemId, timestamp }
  };
  await readJson(DAILY_STATE_PATH, defaultDaily);

  // Initialize history
  const defaultHistory = [];
  await readJson(HISTORY_PATH, defaultHistory);

  // Initialize reminders log
  const defaultRemindersLog = [];
  await readJson(REMINDERS_LOG_PATH, defaultRemindersLog);
}

export async function getRoster() {
  return readJson(ROSTER_PATH, []);
}

export async function saveRoster(roster) {
  return writeJsonAtomic(ROSTER_PATH, roster);
}

export async function getDailyState() {
  return readJson(DAILY_STATE_PATH, {});
}

export async function saveDailyState(state) {
  return writeJsonAtomic(DAILY_STATE_PATH, state);
}

export async function getHistory() {
  return readJson(HISTORY_PATH, []);
}

export async function saveHistory(history) {
  return writeJsonAtomic(HISTORY_PATH, history);
}

export async function getRemindersLog() {
  return readJson(REMINDERS_LOG_PATH, []);
}

export async function saveRemindersLog(logs) {
  return writeJsonAtomic(REMINDERS_LOG_PATH, logs);
}
