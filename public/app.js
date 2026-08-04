// Lunch Buddy Client Application Logic

// --- Theme (light/dark) ---
// Applied immediately on load (before DOMContentLoaded) to avoid a flash of
// the wrong theme.
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('.theme-toggle .material-symbols-outlined').forEach(icon => {
    icon.textContent = theme === 'light' ? 'light_mode' : 'dark_mode';
  });
}

function initTheme() {
  const saved = localStorage.getItem('lunchsync_theme');
  const theme = saved || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  localStorage.setItem('lunchsync_theme', next);
  applyTheme(next);
}

initTheme();

// --- Prevent login-screen flash ---
// Applied immediately on load (before DOMContentLoaded), same as the theme
// fix above: if a saved session exists, hide the login view right away
// instead of waiting for initApp()'s async verification to finish.
if (localStorage.getItem('lunchsync_token')) {
  document.getElementById('login-view').classList.add('hidden');
}

// --- Global State ---
let currentUser = null;
let currentToken = '';
let roster = [];
let dailyState = null;
let selectedLoginUserId = '';
let activeTab = 'order-tab';
let pollInterval = null;
let isEditingOrder = false;

// --- DOM Elements ---
const headerInfo = document.getElementById('header-info');
const displayDate = document.getElementById('display-date');
const displayCutoff = document.getElementById('display-cutoff');
const headerUserName = document.getElementById('header-user-name');
const headerUserRole = document.getElementById('header-user-role');
const btnLogout = document.getElementById('btn-logout');
const btnThemeToggle = document.getElementById('btn-theme-toggle');

const loginView = document.getElementById('login-view');
const loginUserSearch = document.getElementById('login-user-search');
const loginRosterDropdown = document.getElementById('login-roster-dropdown');
const loginPasscodeGroup = document.getElementById('login-passcode-group');
const loginPasscode = document.getElementById('login-passcode');
const btnLogin = document.getElementById('btn-login');
const loginError = document.getElementById('login-error');

const forcePasscodeView = document.getElementById('force-passcode-view');
const newPasscode1 = document.getElementById('new-passcode-1');
const newPasscode2 = document.getElementById('new-passcode-2');
const btnSubmitNewPasscode = document.getElementById('btn-submit-new-passcode');
const forcePasscodeError = document.getElementById('force-passcode-error');

const dashboardView = document.getElementById('dashboard-view');
const navTabs = document.querySelectorAll('.nav-tab');
const tabPanels = document.querySelectorAll('.tab-panel');

// Order Tab
const countdownBanner = document.getElementById('countdown-banner');
const reminderBanner = document.getElementById('reminder-banner');
const btnDismissReminder = document.getElementById('btn-dismiss-reminder');
const countdownText = document.getElementById('countdown-text');
const orderFormCard = document.getElementById('order-form-card');
const orderForm = document.getElementById('order-form');
const menuStatusMsg = document.getElementById('menu-status-msg');
const menuItemsGrid = document.getElementById('menu-items-grid');
const orderSubmitStatus = document.getElementById('order-submit-status');
const confirmationCard = document.getElementById('confirmation-card');
const confirmationText = document.getElementById('confirmation-text');
const btnChangeOrder = document.getElementById('btn-change-order');

// Live Summary Tab
const statTotal = document.getElementById('stat-total');
const statOrdered = document.getElementById('stat-ordered');
const statPending = document.getElementById('stat-pending');
const summaryDishTotals = document.getElementById('summary-dish-totals');
const summaryListSearch = document.getElementById('summary-list-search');
const summaryGroups = document.getElementById('summary-groups');
const summaryUnconfirmed = document.getElementById('summary-unconfirmed');
const summaryUnconfirmedCount = document.getElementById('summary-unconfirmed-count');
const distributionSearch = document.getElementById('distribution-search');
const distributionGroups = document.getElementById('distribution-groups');
const btnCopyWhatsapp = document.getElementById('btn-copy-whatsapp');
const btnExportCsv = document.getElementById('btn-export-csv');
const btnRemindPending = document.getElementById('btn-remind-pending');
const btnClearOrders = document.getElementById('btn-clear-orders');
const exportFeedback = document.getElementById('export-feedback');

// Admin Controls Tab
const adminMenuList = document.getElementById('admin-menu-list');
const btnAdminAddDish = document.getElementById('btn-admin-add-dish');
const btnAdminSaveMenu = document.getElementById('btn-admin-save-menu');
const adminPublishToggle = document.getElementById('admin-publish-toggle');
const adminMenuStatus = document.getElementById('admin-menu-status');
const adminCutoffTime = document.getElementById('admin-cutoff-time');
const btnSaveCutoff = document.getElementById('btn-save-cutoff');
const adminCutoffStatus = document.getElementById('admin-cutoff-status');
const adminArchiveTime = document.getElementById('admin-archive-time');
const btnSaveArchiveTime = document.getElementById('btn-save-archive-time');
const adminArchiveTimeStatus = document.getElementById('admin-archive-time-status');
// Lock toggle
const btnForceLock = document.getElementById('btn-force-lock');
const btnLockRevert = document.getElementById('btn-lock-revert');
const lockIcon = document.getElementById('lock-icon');
const lockStatusLabel = document.getElementById('lock-status-label');
const lockStatusDesc = document.getElementById('lock-status-desc');
const adminLockStatus = document.getElementById('admin-lock-status');
const adminExtendMinutes = document.getElementById('admin-extend-minutes');
const btnExtendCutoff = document.getElementById('btn-extend-cutoff');

// Roster Tab
const rosterTableBody = document.getElementById('roster-table-body');
const rosterSearch = document.getElementById('roster-search');
const btnRosterSort = document.getElementById('btn-roster-sort');
const rosterSortIcon = document.getElementById('roster-sort-icon');
const rosterSortLabel = document.getElementById('roster-sort-label');
let rosterSortDirection = 'asc';
const rosterForm = document.getElementById('roster-form');
const rosterUserId = document.getElementById('roster-user-id');
const rosterName = document.getElementById('roster-name');
const rosterEmail = document.getElementById('roster-email');
const rosterPhone = document.getElementById('roster-phone');
const rosterRole = document.getElementById('roster-role');
const rosterPasscodeGroup = document.getElementById('roster-passcode-group');
const rosterPasscode = document.getElementById('roster-passcode');
const btnRosterSubmit = document.getElementById('btn-roster-submit');
const btnRosterCancel = document.getElementById('btn-roster-cancel');
const rosterFormStatus = document.getElementById('roster-form-status');
const rosterFormTitle = document.getElementById('roster-form-title');
const btnAddRosterMember = document.getElementById('btn-add-roster-member');
const rosterModalOverlay = document.getElementById('roster-modal-overlay');
const btnRosterModalClose = document.getElementById('btn-roster-modal-close');
const rosterModalExistingActions = document.getElementById('roster-modal-existing-actions');
const btnRosterModalReset = document.getElementById('btn-roster-modal-reset');
const btnRosterModalDelete = document.getElementById('btn-roster-modal-delete');

// History Tab
const historyDatesList = document.getElementById('history-dates-list');
const historyDetailPanel = document.getElementById('history-detail-panel');

// My Orders Tab
const myOrdersContainer = document.getElementById('my-orders-container');

// --- Helper Functions ---

// Unified API Caller with headers
async function apiCall(url, method = 'GET', body = null) {
  const headers = {
    'Content-Type': 'application/json'
  };
  if (currentUser) {
    headers['x-user-id'] = currentUser.id;
  }
  if (currentToken) {
    headers['x-auth-token'] = currentToken;
  }

  const config = { method, headers };
  if (body) {
    config.body = JSON.stringify(body);
  }

  const response = await fetch(url, config);
  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    if (response.status === 401 && currentToken) {
      // Session token expired or was invalidated server-side
      logout();
    }
    if (errData.code === 'PASSCODE_CHANGE_REQUIRED' && currentUser) {
      // Server-side backstop: the UI should already be showing this gate
      // right after login, but if some other call ever reaches here first,
      // force it open rather than surfacing a raw 403 elsewhere.
      showForcePasscodeView();
    }
    throw new Error(errData.error || `HTTP error! status: ${response.status}`);
  }
  return response.json();
}

// Show feedback message for exports
function showExportFeedback(text) {
  exportFeedback.textContent = text;
  exportFeedback.classList.remove('hidden');
  setTimeout(() => {
    exportFeedback.classList.add('hidden');
  }, 2000);
}

// Format date nicely
function formatDate(dateStr) {
  if (!dateStr) return '';
  const [year, month, day] = dateStr.split('-');
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

// Format time HH:MM to 12h format
function formatTime12h(timeStr) {
  if (!timeStr) return '';
  const [hours, minutes] = timeStr.split(':');
  const h = parseInt(hours, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const displayHr = h % 12 || 12;
  return `${displayHr}:${minutes} ${ampm}`;
}

// --- App Initialization & Auth ---

async function initApp() {
  // Fetch initial roster for the login screen — the minimal public
  // id+name list, not the full authenticated roster (no PII pre-login).
  try {
    roster = await apiCall('/api/roster/login-list');
    populateLoginDropdown(roster);
  } catch (err) {
    console.error('Failed to load roster on startup:', err);
  }

  // Check for a saved session token in localStorage
  const savedToken = localStorage.getItem('lunchsync_token');

  if (savedToken) {
    try {
      currentToken = savedToken;

      // Verify the token is still valid and fetch the current user record
      const check = await apiCall('/api/me');
      currentUser = check.user;

      if (currentUser.mustChangePasscode) {
        showForcePasscodeView();
      } else {
        loginSuccess();
      }
    } catch (err) {
      console.warn('Saved session invalid or expired, clearing credentials:', err);
      logout();
    }
  }

  setupEventListeners();
}

// Populates search dropdown list
function populateLoginDropdown(users) {
  loginRosterDropdown.innerHTML = '';
  if (users.length === 0) {
    loginRosterDropdown.innerHTML = '<div class="no-results">No team members found</div>';
    return;
  }

  users.forEach(user => {
    const div = document.createElement('div');
    div.className = 'dropdown-item';
    div.dataset.id = user.id;
    // Role is intentionally not shown here — the pre-login list is the
    // minimal public endpoint (id + name only), so it isn't available.
    div.innerHTML = `
      <span class="item-name">${escapeHtml(user.name)}</span>
    `;
    div.addEventListener('mousedown', (e) => {
      // Use mousedown to trigger before the search input's blur event hides the dropdown
      selectLoginUser(user);
    });
    loginRosterDropdown.appendChild(div);
  });
}

function selectLoginUser(user) {
  loginUserSearch.value = user.name;
  selectedLoginUserId = user.id;
  loginRosterDropdown.classList.add('hidden');

  loginPasscodeGroup.classList.remove('hidden');
  loginPasscode.value = '';
  loginPasscode.focus();
}

// Filter users in dropdown
function filterLoginDropdown() {
  const query = loginUserSearch.value.toLowerCase().trim();
  const filtered = roster.filter(u => u.name.toLowerCase().includes(query));
  populateLoginDropdown(filtered);
}

// Log in
async function handleLogin() {
  loginError.classList.add('hidden');
  if (!selectedLoginUserId) {
    loginError.textContent = 'Please select your name from the dropdown list.';
    loginError.classList.remove('hidden');
    return;
  }

  const pCode = loginPasscode.value.trim();

  try {
    const result = await apiCall('/api/login', 'POST', { userId: selectedLoginUserId, passcode: pCode });
    currentUser = result.user;
    currentToken = result.token;

    localStorage.setItem('lunchsync_token', currentToken);

    if (currentUser.mustChangePasscode) {
      showForcePasscodeView();
    } else {
      loginSuccess();
    }
  } catch (err) {
    loginError.textContent = err.message || 'Login failed. Please check your passcode.';
    loginError.classList.remove('hidden');
  }
}

// Blocks access behind a mandatory "set your own passcode" screen
function showForcePasscodeView() {
  loginView.classList.add('hidden');
  dashboardView.classList.add('hidden');
  forcePasscodeError.classList.add('hidden');
  newPasscode1.value = '';
  newPasscode2.value = '';
  forcePasscodeView.classList.remove('hidden');
  newPasscode1.focus();
}

async function handleForcePasscodeSubmit() {
  forcePasscodeError.classList.add('hidden');

  const p1 = newPasscode1.value.trim();
  const p2 = newPasscode2.value.trim();

  if (p1.length < 8) {
    forcePasscodeError.textContent = 'Passcode must be at least 8 characters.';
    forcePasscodeError.classList.remove('hidden');
    return;
  }
  if (p1 !== p2) {
    forcePasscodeError.textContent = 'Passcodes do not match.';
    forcePasscodeError.classList.remove('hidden');
    return;
  }

  try {
    const result = await apiCall('/api/change-passcode', 'POST', { newPasscode: p1 });
    currentUser = result.user;
    currentToken = result.token;
    localStorage.setItem('lunchsync_token', currentToken);
    forcePasscodeView.classList.add('hidden');
    loginSuccess();
  } catch (err) {
    forcePasscodeError.textContent = err.message || 'Failed to set new passcode.';
    forcePasscodeError.classList.remove('hidden');
  }
}

// Successful login configuration
async function loginSuccess() {
  loginView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  headerInfo.classList.remove('hidden');

  headerUserName.textContent = currentUser.name;
  headerUserRole.textContent = currentUser.role;

  // Render proper tabs based on roles
  document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.admin-abigail-only').forEach(el => el.classList.add('hidden'));

  if (currentUser.role === 'Admin') {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
    document.querySelectorAll('.admin-abigail-only').forEach(el => el.classList.remove('hidden'));
  } else if (currentUser.role === 'Abigail') {
    document.querySelectorAll('.admin-abigail-only').forEach(el => el.classList.remove('hidden'));
  }

  // Adjust display of Coordinator tools in Summary
  if (currentUser.role === 'Admin' || currentUser.role === 'Abigail') {
    document.querySelectorAll('.admin-abigail-only.hidden').forEach(el => el.classList.remove('hidden'));
  }

  // Reload roster snapshot now that we're authenticated
  try {
    roster = await apiCall('/api/roster');
  } catch (err) {
    console.error('Error updating roster snapshot:', err);
  }

  // Fetch initial state and start polling
  await fetchDailyState();
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(fetchDailyState, 10000);

  // Switch to default tab
  switchTab('order-tab');
}

function logout() {
  currentUser = null;
  currentToken = '';
  selectedLoginUserId = '';
  isEditingOrder = false;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }

  localStorage.removeItem('lunchsync_token');

  loginUserSearch.value = '';
  loginPasscode.value = '';
  loginPasscodeGroup.classList.add('hidden');
  loginError.classList.add('hidden');

  headerInfo.classList.add('hidden');
  dashboardView.classList.add('hidden');
  forcePasscodeView.classList.add('hidden');
  loginView.classList.remove('hidden');

  // Trigger Roster refetch for general logins
  apiCall('/api/roster/login-list')
    .then(r => {
      roster = r;
      populateLoginDropdown(roster);
    })
    .catch(console.error);
}

// --- Tab Navigation ---

function switchTab(tabId) {
  activeTab = tabId;
  navTabs.forEach(tab => {
    if (tab.dataset.target === tabId) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  tabPanels.forEach(panel => {
    if (panel.id === tabId) {
      panel.classList.add('active');
      onTabLoad(tabId);
    } else {
      panel.classList.remove('active');
    }
  });
}

function onTabLoad(tabId) {
  if (tabId === 'admin-tab') {
    loadAdminMenuBuilder();
    loadAdminSettings();
  } else if (tabId === 'roster-tab') {
    renderRosterTable();
    resetRosterForm();
  } else if (tabId === 'history-tab') {
    loadHistoryDates();
  } else if (tabId === 'summary-tab') {
    renderSummaryView();
  } else if (tabId === 'distribution-tab') {
    renderDistributionView();
  } else if (tabId === 'my-orders-tab') {
    loadMyOrders();
  }
}

// --- Data Fetching & UI Updaters ---

async function fetchDailyState() {
  try {
    dailyState = await apiCall('/api/daily');
    updateHeaderDisplay();
    updateCountdownBanner();
    updateReminderBanner();

    if (activeTab === 'order-tab') {
      renderFoodOrderForm();
    } else if (activeTab === 'summary-tab') {
      renderSummaryView();
    } else if (activeTab === 'distribution-tab') {
      renderDistributionView();
    }
  } catch (err) {
    console.error('Error fetching daily state:', err);
  }
}

// Shows a banner if the current user has an un-dismissed reminder for today
function updateReminderBanner() {
  if (!dailyState || !dailyState.myReminder || !currentUser) {
    reminderBanner.classList.add('hidden');
    return;
  }

  const alreadyOrdered = dailyState.orders.ordered.some(o => o.userId === currentUser.id);
  if (alreadyOrdered) {
    reminderBanner.classList.add('hidden');
    return;
  }

  const dismissedKey = `lunchsync_dismissed_reminder_${currentUser.id}`;
  const dismissedSentAt = localStorage.getItem(dismissedKey);

  if (dismissedSentAt === dailyState.myReminder.sentAt) {
    reminderBanner.classList.add('hidden');
    return;
  }

  reminderBanner.classList.remove('hidden');
}

function dismissReminderBanner() {
  if (dailyState && dailyState.myReminder && currentUser) {
    localStorage.setItem(`lunchsync_dismissed_reminder_${currentUser.id}`, dailyState.myReminder.sentAt);
  }
  reminderBanner.classList.add('hidden');
}

function updateHeaderDisplay() {
  if (!dailyState) return;
  displayDate.textContent = formatDate(dailyState.date);
  displayCutoff.textContent = formatTime12h(dailyState.effectiveCutoffTime || dailyState.cutoffTime);
}

// Computes remaining time and updates countdown banner styling/text
function updateCountdownBanner() {
  if (!dailyState) return;

  // Use the server's cutoffTimestamp (a full datetime anchored to the actual
  // business date) rather than reconstructing it from HH:MM against the
  // client's local "today" — the business date can already be tomorrow
  // relative to the client's calendar day, which would make a same-day
  // reconstruction wildly wrong (see server.js getEffectiveCutoffDate).
  const now = new Date();
  const targetDate = dailyState.cutoffTimestamp ? new Date(dailyState.cutoffTimestamp) : now;
  const diffMs = targetDate - now;

  countdownBanner.className = 'countdown-banner';

  // The server's isLocked is the source of truth, not the raw clock comparison.
  if (dailyState.isLocked) {
    countdownBanner.classList.add('locked');
    countdownText.innerHTML = dailyState.isManuallyLocked === true
      ? '<strong>LOCKED</strong> — An admin has manually locked orders.'
      : '<strong>LOCKED</strong> — Cutoff time has passed. Lunch orders are closed for the day.';
    disableOrderForm(true);
    return;
  }

  const totalSecs = Math.max(0, Math.floor(diffMs / 1000));
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  let timeString = '';
  if (hrs > 0) timeString += `${hrs}h `;
  timeString += `${mins}m ${secs}s`;

  if (totalSecs < 1800) { // Under 30 minutes
    countdownBanner.classList.add('danger');
    countdownText.innerHTML = `<strong>CLOSING SOON</strong> — Orders lock in <strong>${timeString}</strong>!`;
  } else {
    countdownBanner.classList.add('success');
    countdownText.innerHTML = `Orders are currently open. Time remaining until cutoff: <strong>${timeString}</strong>`;
  }

  disableOrderForm(false);
}

function disableOrderForm(disable) {
  const elements = orderForm.elements;
  for (let i = 0; i < elements.length; i++) {
    elements[i].disabled = disable;
  }
  const submitBtn = document.getElementById('btn-submit-order');
  if (submitBtn) submitBtn.disabled = disable;

  // Add style indicator to menu grid cards
  if (disable) {
    menuItemsGrid.classList.add('locked-menu');
  } else {
    menuItemsGrid.classList.remove('locked-menu');
  }
}

// --- Tab: Order View ---

function renderFoodOrderForm() {
  if (!dailyState) return;

  // Find logged in user's current selection, if any
  const userOrder = dailyState.orders.ordered.find(o => o.userId === currentUser.id);

  // Once a selection is saved, show the read-only confirmation with a
  // "Change Selection" button instead of the open form, until the user
  // explicitly asks to edit (or the cutoff forces a locked view either way).
  const showForm = !userOrder || isEditingOrder;

  orderFormCard.classList.toggle('hidden', !showForm);

  if (userOrder) {
    confirmationCard.classList.remove('hidden');
    confirmationText.innerHTML = `Selected dish: <strong>${escapeHtml(userOrder.itemName)}</strong>`;
    btnChangeOrder.classList.toggle('hidden', showForm || dailyState.isLocked);
  } else {
    confirmationCard.classList.add('hidden');
  }

  if (!showForm) return;

  // Check if menu is published
  if (!dailyState.menuPublished) {
    menuStatusMsg.classList.remove('hidden');
    menuItemsGrid.classList.add('hidden');
    return;
  }

  menuStatusMsg.classList.add('hidden');
  menuItemsGrid.classList.remove('hidden');

  // Render menu grid cards
  menuItemsGrid.innerHTML = '';
  dailyState.menu.forEach(item => {
    const card = document.createElement('label');
    card.className = 'menu-card';
    
    const isChecked = userOrder && userOrder.itemId === item.id;

    card.innerHTML = `
      <input type="radio" name="lunch-selection" value="${item.id}" ${isChecked ? 'checked' : ''} required>
      <div class="menu-card-inner">
        <div class="menu-card-header">
          <span class="menu-card-title">${escapeHtml(item.name)}</span>
          ${item.price ? `<span class="menu-card-price">${escapeHtml(item.price)}</span>` : ''}
        </div>
        <p class="menu-card-desc">${escapeHtml(item.description)}</p>
      </div>
    `;

    // Click handler to select and add highlight class
    card.addEventListener('click', () => {
      if (!dailyState.isLocked) {
        document.querySelectorAll('.menu-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
      }
    });

    menuItemsGrid.appendChild(card);
  });
}

// Submit Order action
async function handleOrderSubmit(e) {
  e.preventDefault();
  orderSubmitStatus.className = 'status-indicator';
  orderSubmitStatus.textContent = 'Saving...';

  const dish = orderForm.querySelector('input[name="lunch-selection"]:checked')?.value || null;

  if (!dish) {
    orderSubmitStatus.className = 'status-indicator error';
    orderSubmitStatus.textContent = 'Dish selection is required.';
    return;
  }

  try {
    await apiCall('/api/order', 'POST', { itemId: dish });
    orderSubmitStatus.className = 'status-indicator success';
    orderSubmitStatus.textContent = 'Selection submitted!';
    isEditingOrder = false;

    // Refresh state and UI
    await fetchDailyState();
  } catch (err) {
    orderSubmitStatus.className = 'status-indicator error';
    orderSubmitStatus.textContent = err.message || 'Failed to submit selection.';
  }
}

// --- Tab: Live Summary ---

function renderSummaryView() {
  if (!dailyState) return;

  // Stats Counters
  statTotal.textContent = dailyState.stats.total;
  statOrdered.textContent = dailyState.stats.ordered;
  statPending.textContent = dailyState.stats.pending;

  // Render Dish Quantities cards
  summaryDishTotals.innerHTML = '';
  const activeDishTotals = dailyState.dishTotals.filter(d => d.count > 0);

  if (activeDishTotals.length === 0) {
    summaryDishTotals.innerHTML = '<div class="no-results">No lunch orders placed yet.</div>';
  } else {
    activeDishTotals.forEach(dish => {
      const card = document.createElement('div');
      card.className = 'dish-total-card';
      card.innerHTML = `
        <span class="material-symbols-outlined">restaurant</span>
        <span class="dish-total-count">${dish.count}</span>
        <span class="dish-total-name">${escapeHtml(dish.name)}</span>
      `;
      summaryDishTotals.appendChild(card);
    });
  }

  // Render Detailed Roster Breakdown (Searchable)
  renderDetailedBreakdownList();
}

function renderDetailedBreakdownList() {
  if (!dailyState) return;
  summaryGroups.innerHTML = '';
  summaryUnconfirmed.innerHTML = '';

  const searchVal = summaryListSearch.value.toLowerCase().trim();

  const orderedList = (dailyState.orders.ordered || [])
    .filter(item => item.name.toLowerCase().includes(searchVal));
  const pendingList = (dailyState.orders.pending || [])
    .filter(item => item.name.toLowerCase().includes(searchVal));

  // Group ordered members by dish, in the same order as the menu
  const byDish = new Map();
  orderedList.forEach(item => {
    if (!byDish.has(item.itemName)) byDish.set(item.itemName, []);
    byDish.get(item.itemName).push(item);
  });

  // Show every dish on the menu as its own column, even ones nobody has
  // ordered yet, so the full menu is always visible.
  const columns = dailyState.dishTotals.map(dish => ({
    title: dish.name,
    members: byDish.get(dish.name) || []
  }));

  if (columns.length === 0) {
    summaryGroups.innerHTML = '<div class="no-results">No dishes on today\'s menu yet.</div>';
  } else {
    summaryGroups.innerHTML = columns.map(col => {
      const rows = col.members.map(member => {
        const assignedTag = member.assignedBy
          ? `<span class="text-muted"> (added by ${escapeHtml(member.assignedBy)})</span>`
          : '';
        return `<div class="summary-member-row">${escapeHtml(member.name)}${assignedTag}</div>`;
      }).join('') || '<div class="no-results">—</div>';

      return `
        <div class="breakdown-column">
          <div class="breakdown-column-title">${escapeHtml(col.title)} (${col.members.length})</div>
          <div class="breakdown-column-list">${rows}</div>
        </div>
      `;
    }).join('');
  }

  // Unconfirmed members get their own grid, separate from the dish columns —
  // each person is its own grid item so they lay out in a multi-column grid
  // rather than one long single-column list.
  summaryUnconfirmedCount.textContent = pendingList.length === 0
    ? 'Everyone has placed an order.'
    : `${pendingList.length} team member${pendingList.length === 1 ? '' : 's'} haven't placed an order yet.`;

  if (pendingList.length === 0) {
    summaryUnconfirmed.innerHTML = '<div class="no-results">Everyone has placed an order.</div>';
    return;
  }

  const menuOptions = dailyState.menu
    .map(dish => `<option value="${dish.id}">${escapeHtml(dish.name)}</option>`)
    .join('');

  summaryUnconfirmed.innerHTML = pendingList.map(member => `
    <div class="summary-member-row unconfirmed-row">
      <span>${escapeHtml(member.name)}</span>
      <select class="assign-dish-select" data-user-id="${member.userId}">
        <option value="">Assign dish…</option>
        ${menuOptions}
      </select>
    </div>
  `).join('');

  summaryUnconfirmed.querySelectorAll('.assign-dish-select').forEach(select => {
    select.addEventListener('change', () => {
      const userId = select.dataset.userId;
      const itemId = select.value;
      if (itemId) assignDishToMember(userId, itemId);
    });
  });
}

// Admin/Abigail: manually place an order for someone who couldn't submit
// their own but let a coordinator know their choice ahead of time.
async function assignDishToMember(userId, itemId) {
  try {
    await apiCall('/api/order/assign', 'POST', { userId, itemId });
    showExportFeedback('Order assigned!');
    await fetchDailyState();
  } catch (err) {
    alert(err.message || 'Failed to assign order.');
  }
}

// --- Tab: Distribution Checklist ---

function renderDistributionView() {
  if (!dailyState) return;
  distributionGroups.innerHTML = '';

  const searchVal = distributionSearch.value.toLowerCase().trim();

  const orderedList = (dailyState.orders.ordered || [])
    .filter(item => item.name.toLowerCase().includes(searchVal));

  const byDish = new Map();
  orderedList.forEach(item => {
    if (!byDish.has(item.itemName)) byDish.set(item.itemName, []);
    byDish.get(item.itemName).push(item);
  });

  const columns = dailyState.dishTotals
    .map(dish => ({ title: dish.name, members: byDish.get(dish.name) || [] }))
    .filter(col => col.members.length > 0);

  if (columns.length === 0) {
    distributionGroups.innerHTML = '<div class="no-results">No orders to hand out yet.</div>';
    return;
  }

  distributionGroups.innerHTML = columns.map(col => {
    const doneInCol = col.members.filter(m => m.served).length;
    const rows = col.members.map(member => `
      <button type="button" class="summary-member-row distribution-row ${member.served ? 'served' : ''}" data-user-id="${member.userId}">
        <span class="material-symbols-outlined">${member.served ? 'check_box' : 'check_box_outline_blank'}</span>
        <span>${escapeHtml(member.name)}</span>
      </button>
    `).join('');

    return `
      <div class="breakdown-column">
        <div class="breakdown-column-title">${escapeHtml(col.title)} (${doneInCol}/${col.members.length})</div>
        <div class="breakdown-column-list">${rows}</div>
      </div>
    `;
  }).join('');

  distributionGroups.querySelectorAll('.distribution-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const userId = btn.dataset.userId;
      const currentlyServed = btn.classList.contains('served');
      toggleServed(userId, !currentlyServed);
    });
  });
}

async function toggleServed(userId, served) {
  try {
    await apiCall('/api/order/serve', 'POST', { userId, served });
    await fetchDailyState();
  } catch (err) {
    alert(err.message || 'Failed to update.');
  }
}

// Copy Summary for WhatsApp clipboard API
function copyWhatsAppSummary() {
  if (!dailyState) return;

  const dateLabel = formatDate(dailyState.date);
  let text = `*LUNCH ORDER SUMMARY — ${dateLabel.toUpperCase()}*\n\n`;

  // Dish quantities
  text += `*DISH QUANTITIES:*\n`;
  const activeDishTotals = dailyState.dishTotals.filter(d => d.count > 0);
  if (activeDishTotals.length === 0) {
    text += `_No food items selected._\n`;
  } else {
    activeDishTotals.forEach(d => {
      text += `• ${d.name}: *${d.count}*\n`;
    });
  }

  // Order metrics
  text += `\n*OVERVIEW:*\n`;
  text += `• Ordered: ${dailyState.stats.ordered} of ${dailyState.stats.total}\n`;

  navigator.clipboard.writeText(text)
    .then(() => showExportFeedback('Summary copied!'))
    .catch(err => {
      console.error('Failed to copy text:', err);
      alert('Could not copy automatically. You can copy it manually from the screen.');
    });
}

// Send a reminder to everyone who hasn't ordered yet
async function remindPendingMembers() {
  if (!dailyState) return;

  if (dailyState.stats.pending === 0) {
    showExportFeedback('No pending members to remind!');
    return;
  }

  if (!confirm(`Send a reminder to ${dailyState.stats.pending} member(s) who haven't ordered yet?`)) {
    return;
  }

  btnRemindPending.disabled = true;

  try {
    const result = await apiCall('/api/reminders/send', 'POST', { bulk: true });
    showExportFeedback(result.message || 'Reminders sent!');
  } catch (err) {
    alert(err.message || 'Failed to send reminders.');
  } finally {
    btnRemindPending.disabled = false;
  }
}

// Admin: wipe today's orders so team members can make fresh selections
async function clearAllOrders() {
  if (!dailyState) return;

  const confirmed = confirm(
    `Clear ALL ${dailyState.stats.ordered} order(s) placed today? This cannot be undone — team members will need to select their dish again.`
  );
  if (!confirmed) return;

  btnClearOrders.disabled = true;

  try {
    await apiCall('/api/order/clear-all', 'POST');
    showExportFeedback('Sheet cleared!');
    await fetchDailyState();
  } catch (err) {
    alert(err.message || 'Failed to clear orders.');
  } finally {
    btnClearOrders.disabled = false;
  }
}

// Download raw CSV summary — mirrors the on-screen Roster Breakdown table:
// one column per dish (plus Unconfirmed), with names stacked underneath.
function exportCsvSummary() {
  if (!dailyState) return;

  const byDish = new Map();
  (dailyState.orders.ordered || []).forEach(item => {
    if (!byDish.has(item.itemName)) byDish.set(item.itemName, []);
    byDish.get(item.itemName).push(item.name);
  });

  const columns = dailyState.dishTotals
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(dish => ({
      title: `${dish.name} (${dish.count})`,
      names: (byDish.get(dish.name) || []).slice().sort((a, b) => a.localeCompare(b))
    }));

  const pendingList = dailyState.orders.pending || [];
  if (pendingList.length > 0) {
    columns.push({
      title: `Unconfirmed (${pendingList.length})`,
      names: pendingList.map(item => item.name).sort((a, b) => a.localeCompare(b))
    });
  }

  const maxRows = Math.max(0, ...columns.map(c => c.names.length));

  const rows = [columns.map(c => c.title)];
  for (let i = 0; i < maxRows; i++) {
    rows.push(columns.map(c => c.names[i] || ''));
  }

  const csvContent = "data:text/csv;charset=utf-8,"
    + rows.map(e => e.map(val => `"${val.replace(/"/g, '""')}"`).join(",")).join("\n");
  
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `LunchBuddy_Summary_${dailyState.date}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  showExportFeedback('CSV Downloaded!');
}

// --- Tab: Admin Menu Setup ---

function loadAdminMenuBuilder() {
  if (!dailyState) return;

  adminMenuList.innerHTML = '';
  
  if (dailyState.menu.length === 0) {
    addDishInputRow('', '', '');
  } else {
    dailyState.menu.forEach(item => {
      addDishInputRow(item.id, item.name, item.description);
    });
  }

  adminPublishToggle.checked = dailyState.menuPublished;
}

function addDishInputRow(id = '', name = '', description = '') {
  const div = document.createElement('div');
  div.className = 'admin-dish-row';
  div.dataset.id = id;

  div.innerHTML = `
    <input type="text" class="dish-name-input" placeholder="Dish Name (e.g. Sushi)" value="${escapeHtml(name)}" required>
    <input type="text" class="dish-desc-input" placeholder="Optional description" value="${escapeHtml(description)}">
    <button type="button" class="btn btn-icon btn-logout btn-delete-row" title="Delete Row">
      <span class="material-symbols-outlined">delete</span>
    </button>
  `;

  // Bind delete action
  div.querySelector('.btn-delete-row').addEventListener('click', () => {
    div.remove();
    if (adminMenuList.children.length === 0) {
      addDishInputRow();
    }
  });

  adminMenuList.appendChild(div);
}

// Save Daily Menu layout to server
async function saveAdminMenu() {
  adminMenuStatus.className = 'status-msg-inline';
  adminMenuStatus.textContent = 'Saving menu...';

  const rows = adminMenuList.querySelectorAll('.admin-dish-row');
  const menuItems = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const nameInput = row.querySelector('.dish-name-input');
    const name = nameInput.value.trim();
    const description = row.querySelector('.dish-desc-input').value.trim();

    if (!name) {
      adminMenuStatus.className = 'status-msg-inline error-text';
      adminMenuStatus.textContent = 'Dish Name is required for all food options.';
      nameInput.focus();
      return;
    }

    menuItems.push({
      id: row.dataset.id || null, // Keep same ID if editing, else make new
      name,
      description
    });
  }

  try {
    await apiCall('/api/menu', 'POST', { menu: menuItems });
    adminMenuStatus.className = 'status-msg-inline success';
    adminMenuStatus.style.color = 'var(--status-in-office)';
    adminMenuStatus.textContent = 'Menu structure saved successfully!';
    
    await fetchDailyState();
  } catch (err) {
    adminMenuStatus.className = 'status-msg-inline error-text';
    adminMenuStatus.textContent = err.message || 'Failed to save menu.';
  }
}

// Toggle Publication status
async function handlePublishToggle() {
  adminMenuStatus.className = 'status-msg-inline';
  adminMenuStatus.textContent = 'Updating status...';

  const published = adminPublishToggle.checked;

  try {
    await apiCall('/api/publish-menu', 'POST', { published });
    adminMenuStatus.className = 'status-msg-inline success';
    adminMenuStatus.style.color = 'var(--status-in-office)';
    adminMenuStatus.textContent = published ? 'Menu is now published to roster!' : 'Menu is now hidden from roster.';
    
    await fetchDailyState();
  } catch (err) {
    adminPublishToggle.checked = !published; // revert UI
    adminMenuStatus.className = 'status-msg-inline error-text';
    adminMenuStatus.textContent = err.message || 'Failed to update publishing state.';
  }
}

// --- Tab: Admin Settings ---

function loadAdminSettings() {
  if (!dailyState) return;
  adminCutoffTime.value = dailyState.cutoffTime;
  adminArchiveTime.value = dailyState.archiveTime;
  updateLockUI(dailyState.isManuallyLocked, dailyState.isLocked, dailyState.cutoffExtensionMinutes, dailyState.effectiveCutoffTime);
}

// Render lock toggle state
function updateLockUI(isManuallyLocked, isLocked, cutoffExtensionMinutes, effectiveCutoffTime) {
  // Reset all
  btnForceLock.classList.remove('hidden');
  btnLockRevert.classList.add('hidden');
  adminLockStatus.textContent = '';

  const extensionNote = cutoffExtensionMinutes > 0
    ? ` Extended by ${cutoffExtensionMinutes}m to ${formatTime12h(effectiveCutoffTime)}.`
    : '';

  if (isManuallyLocked === true) {
    // Force-locked by admin
    lockIcon.textContent = 'lock';
    lockIcon.style.color = 'var(--status-not-coming)';
    lockStatusLabel.textContent = 'Orders: Manually Locked';
    lockStatusDesc.textContent = 'No submissions are accepted. Click Reset to Auto to revert.';
    btnForceLock.classList.add('hidden');
    btnLockRevert.classList.remove('hidden');
  } else if (isLocked) {
    // Auto-locked by cutoff time
    lockIcon.textContent = 'alarm_off';
    lockIcon.style.color = 'var(--status-on-the-way)';
    lockStatusLabel.textContent = 'Orders: Locked by Cutoff';
    lockStatusDesc.textContent = `Cutoff time passed.${extensionNote || ' Add extra time below to accept late orders.'}`;
  } else {
    // Auto open (no override)
    lockIcon.textContent = 'lock_open';
    lockIcon.style.color = 'var(--text-secondary)';
    lockStatusLabel.textContent = 'Orders: Open';
    lockStatusDesc.textContent = `Accepting submissions until cutoff time.${extensionNote}`;
  }
}

async function saveAdminCutoff() {
  adminCutoffStatus.className = 'status-msg-inline';
  adminCutoffStatus.textContent = 'Saving...';

  const cutoffVal = adminCutoffTime.value;

  try {
    await apiCall('/api/cutoff', 'POST', { cutoffTime: cutoffVal });
    adminCutoffStatus.className = 'status-msg-inline success';
    adminCutoffStatus.style.color = 'var(--status-in-office)';
    adminCutoffStatus.textContent = 'Cutoff time updated!';
    
    await fetchDailyState();
  } catch (err) {
    adminCutoffStatus.className = 'status-msg-inline error-text';
    adminCutoffStatus.textContent = err.message || 'Failed to update cutoff.';
  }
}

async function saveAdminArchiveTime() {
  adminArchiveTimeStatus.className = 'status-msg-inline';
  adminArchiveTimeStatus.textContent = 'Saving...';

  const archiveTimeVal = adminArchiveTime.value;

  try {
    await apiCall('/api/archive-time', 'POST', { archiveTime: archiveTimeVal });
    adminArchiveTimeStatus.className = 'status-msg-inline success';
    adminArchiveTimeStatus.style.color = 'var(--status-in-office)';
    adminArchiveTimeStatus.textContent = 'Archive time updated!';

    await fetchDailyState();
  } catch (err) {
    adminArchiveTimeStatus.className = 'status-msg-inline error-text';
    adminArchiveTimeStatus.textContent = err.message || 'Failed to update archive time.';
  }
}

// --- Tab: Manual Lock ---

async function handleForceLock(locked) {
  adminLockStatus.className = 'status-msg-inline';
  adminLockStatus.textContent = 'Updating...';
  try {
    const result = await apiCall('/api/lock', 'POST', { locked });
    await fetchDailyState();
    updateLockUI(result.isManuallyLocked, result.isLocked, dailyState.cutoffExtensionMinutes, dailyState.effectiveCutoffTime);
    adminLockStatus.className = 'status-msg-inline success';
    adminLockStatus.style.color = 'var(--status-in-office)';
    adminLockStatus.textContent = locked === null
      ? 'Reverted to automatic time-based locking.'
      : 'Orders are now locked.';
  } catch (err) {
    adminLockStatus.className = 'status-msg-inline error-text';
    adminLockStatus.textContent = err.message || 'Failed to update lock state.';
  }
}

async function handleExtendCutoff() {
  const minutes = parseInt(adminExtendMinutes.value, 10);
  if (!Number.isInteger(minutes) || minutes <= 0) {
    adminLockStatus.className = 'status-msg-inline error-text';
    adminLockStatus.textContent = 'Enter a positive number of minutes.';
    return;
  }

  adminLockStatus.className = 'status-msg-inline';
  adminLockStatus.textContent = 'Updating...';
  try {
    const result = await apiCall('/api/cutoff/extend', 'POST', { minutes });
    await fetchDailyState();
    updateLockUI(dailyState.isManuallyLocked, result.isLocked, result.cutoffExtensionMinutes, result.effectiveCutoffTime);
    adminExtendMinutes.value = '';
    adminLockStatus.className = 'status-msg-inline success';
    adminLockStatus.style.color = 'var(--status-in-office)';
    adminLockStatus.textContent = `Cutoff extended by ${minutes}m — now ${formatTime12h(result.effectiveCutoffTime)}.`;
  } catch (err) {
    adminLockStatus.className = 'status-msg-inline error-text';
    adminLockStatus.textContent = err.message || 'Failed to extend cutoff.';
  }
}

// --- Tab: Bulk Roster Import ---

function parseBulkText(raw) {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const parts = line.split(',').map(p => p.trim());
      return {
        name: parts[0] || '',
        email: parts[1] || '',
        phone: parts[2] || '',
        role: parts[3] || 'Team Member'
      };
    });
}

async function handleBulkImport() {
  const textarea = document.getElementById('bulk-import-textarea');
  const resultEl = document.getElementById('bulk-import-result');
  const raw = textarea.value.trim();

  if (!raw) {
    resultEl.className = 'bulk-result error-text';
    resultEl.textContent = 'Please paste at least one name before importing.';
    resultEl.classList.remove('hidden');
    return;
  }

  const members = parseBulkText(raw);
  if (members.length === 0) {
    resultEl.className = 'bulk-result error-text';
    resultEl.textContent = 'Could not parse any valid entries.';
    resultEl.classList.remove('hidden');
    return;
  }

  const btn = document.getElementById('btn-bulk-import');
  btn.disabled = true;
  btn.querySelector('span:last-child').textContent = 'Importing...';

  try {
    const res = await apiCall('/api/roster/bulk', 'POST', { members });

    // Refresh the roster in memory and re-render table
    roster = await apiCall('/api/roster');
    renderRosterTable();

    // Show result summary
    let html = `<div class="bulk-result-header">`;
    if (res.added > 0) {
      html += `<span class="bulk-badge badge-success"><span class="material-symbols-outlined">check_circle</span>${res.added} added</span>`;
    }
    if (res.skipped > 0) {
      html += `<span class="bulk-badge badge-warn"><span class="material-symbols-outlined">warning</span>${res.skipped} skipped</span>`;
    }
    html += `</div>`;

    if (res.skippedDetails && res.skippedDetails.length > 0) {
      html += `<ul class="bulk-skip-list">`;
      res.skippedDetails.forEach(s => {
        html += `<li><strong>${escapeHtml(s.entry?.name || '?')}</strong> — ${escapeHtml(s.reason)}</li>`;
      });
      html += `</ul>`;
    }

    if (res.members && res.members.length > 0) {
      html += `<p class="help-text" style="margin-top:0.75rem;">Each person got a unique temporary passcode — share these securely; they won't be shown again:</p>`;
      html += `<ul class="bulk-skip-list">`;
      res.members.forEach(m => {
        html += `<li><strong>${escapeHtml(m.name)}</strong> — <code>${escapeHtml(m.initialPasscode)}</code></li>`;
      });
      html += `</ul>`;
    }

    if (res.added > 0) {
      textarea.value = '';
    }

    resultEl.className = 'bulk-result';
    resultEl.innerHTML = html;
    resultEl.classList.remove('hidden');
  } catch (err) {
    resultEl.className = 'bulk-result error-text';
    resultEl.textContent = err.message || 'Import failed.';
    resultEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.querySelector('span:last-child').textContent = 'Import Members';
  }
}

// --- Tab: Roster Manager ---

function renderRosterTable() {
  rosterTableBody.innerHTML = '';
  
  const searchVal = rosterSearch.value.toLowerCase().trim();
  const filteredRoster = roster
    .filter(u => u.name.toLowerCase().includes(searchVal))
    .sort((a, b) => {
      const cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      return rosterSortDirection === 'asc' ? cmp : -cmp;
    });

  if (filteredRoster.length === 0) {
    rosterTableBody.innerHTML = '<tr><td colspan="5" class="no-results">No team members found</td></tr>';
    return;
  }

  filteredRoster.forEach(user => {
    const tr = document.createElement('tr');

    const roleBadgeClass = user.role === 'Admin' ? 'admin' : user.role === 'Abigail' ? 'abigail' : 'member';
    const roleLabel = user.role === 'Admin' ? 'Admin' : user.role === 'Abigail' ? 'Abigail' : 'Team Member';

    tr.innerHTML = `
      <td><strong>${escapeHtml(user.name)}</strong></td>
      <td>${escapeHtml(user.email || '—')}</td>
      <td>${escapeHtml(user.phone || '—')}</td>
      <td><span class="table-role-badge ${roleBadgeClass}">${roleLabel}</span></td>
      <td>${user.hasPasscode ? '<code>Set</code>' : '<code class="no-passcode">None</code>'}</td>
    `;

    // Clicking the row opens the member's details in the modal
    tr.addEventListener('click', () => openRosterModal(user));

    rosterTableBody.appendChild(tr);
  });
}

let currentRosterModalUser = null;

function openRosterModal(user) {
  currentRosterModalUser = user || null;

  if (user) {
    rosterFormTitle.textContent = 'Edit Team Member';
    rosterUserId.value = user.id;
    rosterName.value = user.name;
    rosterEmail.value = user.email;
    rosterPhone.value = user.phone;
    rosterRole.value = user.role;
    // Passcodes are hashed server-side and can't be retrieved — leave blank;
    // a value here only gets sent (and applied) if the admin types a new one.
    rosterPasscode.value = '';
    rosterPasscode.placeholder = 'Leave blank to keep current passcode';
    rosterPasscode.required = false;
    btnRosterSubmit.textContent = 'Update Member';
    rosterModalExistingActions.classList.remove('hidden');
  } else {
    rosterFormTitle.textContent = 'Add Team Member';
    rosterUserId.value = '';
    rosterName.value = '';
    rosterEmail.value = '';
    rosterPhone.value = '';
    rosterRole.value = 'Team Member';
    // Leave blank by default — the server generates a unique random
    // passcode if none is set, shown once after saving. Admins can still
    // type a specific one (min 8 chars, not common/all-digits).
    rosterPasscode.value = '';
    rosterPasscode.placeholder = 'Leave blank to auto-generate';
    rosterPasscode.required = false;
    btnRosterSubmit.textContent = 'Save Member';
    rosterModalExistingActions.classList.add('hidden');
  }

  rosterPasscodeGroup.classList.remove('hidden');
  rosterFormStatus.textContent = '';
  rosterModalOverlay.classList.remove('hidden');
}

function closeRosterModal() {
  rosterModalOverlay.classList.add('hidden');
  currentRosterModalUser = null;
}

function resetRosterForm() {
  closeRosterModal();
}

// Roster Form Submit handler
async function handleRosterFormSubmit(e) {
  e.preventDefault();

  const id = rosterUserId.value;
  const name = rosterName.value.trim();
  const email = rosterEmail.value.trim();
  const phone = rosterPhone.value.trim();
  const role = rosterRole.value;
  const passcode = rosterPasscode.value.trim();

  // Native browser validation popups don't always render in embedded
  // webviews, so surface required-field errors in the status line too.
  if (!name) {
    rosterFormStatus.className = 'status-msg-inline error-text';
    rosterFormStatus.textContent = 'Full Name is required.';
    rosterForm.reportValidity();
    return;
  }
  rosterFormStatus.className = 'status-msg-inline';
  rosterFormStatus.textContent = 'Saving...';

  const payload = { name, email, phone, role };
  // Only include the passcode when the admin actually typed one — on edit,
  // a blank field means "keep the existing passcode" (it can't be shown);
  // on add, a blank field means "auto-generate one".
  if (passcode) payload.passcode = passcode;

  try {
    if (id) {
      // Edit mode
      await apiCall(`/api/roster/${id}`, 'PUT', payload);
      rosterFormStatus.style.color = 'var(--status-in-office)';
      rosterFormStatus.textContent = 'Member updated successfully!';
    } else {
      // Add mode
      const created = await apiCall('/api/roster', 'POST', payload);
      rosterFormStatus.style.color = 'var(--status-in-office)';
      rosterFormStatus.textContent = 'Member added successfully!';
      if (created.initialPasscode) {
        alert(`${created.name}'s temporary passcode is: ${created.initialPasscode}\n\nShare it with them securely — it won't be shown again. They'll be prompted to set their own on first login.`);
      }
    }

    // Refresh configurations
    roster = await apiCall('/api/roster');
    renderRosterTable();
    resetRosterForm();
  } catch (err) {
    rosterFormStatus.className = 'status-msg-inline error-text';
    rosterFormStatus.textContent = err.message || 'Failed to save team member.';
  }
}

async function deleteRosterMember(user) {
  if (!confirm(`Are you sure you want to delete ${user.name} from the team roster? This will clear their today's orders.`)) {
    return;
  }

  try {
    await apiCall(`/api/roster/${user.id}`, 'DELETE');
    roster = await apiCall('/api/roster');
    renderRosterTable();
    closeRosterModal();
  } catch (err) {
    alert(err.message || 'Failed to remove member.');
  }
}

async function resetRosterMemberPasscode(user) {
  if (!confirm(`Reset ${user.name}'s passcode to a new random value? They'll be asked to set their own on next login.`)) {
    return;
  }

  try {
    const result = await apiCall(`/api/roster/${user.id}/reset-passcode`, 'POST');
    roster = await apiCall('/api/roster');
    renderRosterTable();
    closeRosterModal();
    alert(`${user.name}'s new temporary passcode is: ${result.newPasscode}\n\nShare it with them securely — it won't be shown again. They'll be prompted to set their own passcode on next login.`);
  } catch (err) {
    alert(err.message || 'Failed to reset passcode.');
  }
}

// --- Tab: Order History ---

async function loadHistoryDates() {
  historyDatesList.innerHTML = '<div class="no-results">Loading history...</div>';
  historyDetailPanel.innerHTML = `
    <div class="panel-card history-empty-card">
      <div class="empty-state">
        <span class="material-symbols-outlined">inventory_2</span>
        <p>Select a date from the list to view its archived orders.</p>
      </div>
    </div>
  `;

  try {
    const history = await apiCall('/api/history');
    historyDatesList.innerHTML = '';

    if (history.length === 0) {
      historyDatesList.innerHTML = '<div class="no-results">No archived daily records found.</div>';
      return;
    }

    history.forEach((archive, index) => {
      const div = document.createElement('div');
      div.className = 'history-date-item';
      div.dataset.index = index;

      const orderCount = Object.keys(archive.orders).length;

      div.innerHTML = `
        <div>
          <div class="history-date-title">${escapeHtml(archive.date)}</div>
          <div class="history-date-meta">${orderCount} order${orderCount !== 1 ? 's' : ''} saved</div>
        </div>
        <span class="material-symbols-outlined text-muted" style="font-size:1.1rem">arrow_forward_ios</span>
      `;

      div.addEventListener('click', () => {
        document.querySelectorAll('.history-date-item').forEach(el => el.classList.remove('active'));
        div.classList.add('active');
        renderHistoryDetail(archive);
      });

      historyDatesList.appendChild(div);
    });
  } catch (err) {
    historyDatesList.innerHTML = '<div class="no-results error-text">Failed to fetch history</div>';
    console.error('Error loading history:', err);
  }
}

function renderHistoryDetail(archive) {
  const orders = archive.orders || {};
  const rosterSnapshot = archive.rosterSnapshot || {};

  const dishTotals = {};
  archive.menu.forEach(d => { dishTotals[d.id] = 0; });

  const rows = Object.values(rosterSnapshot).map(userSnapshot => {
    const id = Object.keys(rosterSnapshot).find(k => rosterSnapshot[k] === userSnapshot);
    const userOrder = orders[id];
    if (userOrder) {
      if (userOrder.itemId) dishTotals[userOrder.itemId] = (dishTotals[userOrder.itemId] || 0) + 1;
      return {
        name: userSnapshot.name,
        status: 'Ordered',
        dish: archive.menu.find(m => m.id === userOrder.itemId)?.name || 'Unknown Dish'
      };
    }
    return { name: userSnapshot.name, status: 'Unconfirmed', dish: '—' };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const orderedCount = rows.filter(r => r.status === 'Ordered').length;

  historyDetailPanel.innerHTML = `
    <!-- Stat Cards -->
    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-num">${rows.length}</span>
        <span class="stat-label">Total Roster</span>
      </div>
      <div class="stat-card status-in-office">
        <span class="stat-num">${orderedCount}</span>
        <span class="stat-label">Ordered</span>
      </div>
      <div class="stat-card status-pending">
        <span class="stat-num">${rows.length - orderedCount}</span>
        <span class="stat-label">Unconfirmed</span>
      </div>
    </div>

    <!-- Dish Quantities -->
    <div class="panel-card">
      <div class="card-header-compact-row">
        <div>
          <h2>Lunch Records for ${formatDate(archive.date)}</h2>
          <p>Required totals for food vendor order placement that day.</p>
        </div>
        <button type="button" class="btn btn-secondary btn-icon-text" id="btn-export-history-csv">
          <span class="material-symbols-outlined">download</span>
          <span>Export as CSV</span>
        </button>
      </div>
      <div class="dish-totals-grid">
        ${archive.menu.map(dish => `
          <div class="dish-total-card">
            <span class="material-symbols-outlined">restaurant</span>
            <span class="dish-total-count">${dishTotals[dish.id] || 0}</span>
            <span class="dish-total-name">${escapeHtml(dish.name)}</span>
          </div>
        `).join('') || '<div class="no-results">No menu published.</div>'}
      </div>
    </div>

    <!-- Roster Table -->
    <div class="panel-card">
      <div class="card-header">
        <h2>Roster Selections</h2>
        <p>Individual dish selections archived for this day.</p>
      </div>
      <div class="roster-table-container">
        <table class="roster-table">
          <thead><tr><th>Name</th><th>Status</th><th>Dish Selection</th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td><strong>${escapeHtml(r.name)}</strong></td>
                <td>${r.status}</td>
                <td>${escapeHtml(r.dish)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('btn-export-history-csv').addEventListener('click', () => {
    exportHistoryCsv(archive, archive.menu.map(dish => ({ name: dish.name, count: dishTotals[dish.id] || 0 })), rows);
  });
}

// Download a CSV of an archived day — mirrors the Live Summary export
function exportHistoryCsv(archive, dishTotalsList, rows) {
  const csvRows = [
    ['Dish', 'Quantity'],
    ...dishTotalsList.map(d => [d.name, String(d.count)]),
    [],
    ['Name', 'Status', 'Dish Selection'],
    ...rows.map(r => [r.name, r.status, r.dish])
  ];

  const csvContent = "data:text/csv;charset=utf-8,"
    + csvRows.map(row => row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(",")).join("\n");

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `LunchBuddy_History_${archive.date}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// --- Tab: My Past Orders ---

async function loadMyOrders() {
  myOrdersContainer.innerHTML = `
    <div class="my-orders-loading">
      <span class="material-symbols-outlined spinning">sync</span>
      <span>Loading your order history...</span>
    </div>
  `;
  try {
    const records = await apiCall('/api/my-orders');
    renderMyOrders(records);
  } catch (err) {
    myOrdersContainer.innerHTML = `<div class="no-results error-text">Failed to load your order history.</div>`;
    console.error('Error loading my orders:', err);
  }
}

function renderMyOrders(records) {
  myOrdersContainer.innerHTML = '';

  if (!records || records.length === 0) {
    myOrdersContainer.innerHTML = `
      <div class="my-orders-empty">
        <span class="material-symbols-outlined">receipt_long</span>
        <h3>No past orders yet</h3>
        <p>Your daily selections will appear here once a day has been archived.</p>
      </div>
    `;
    return;
  }

  // Build personal stats
  const daysOrdered = records.filter(r => r.itemName).length;

  myOrdersContainer.innerHTML = `
    <!-- Personal Stats Strip -->
    <div class="my-orders-stats">
      <div class="my-stat-pill">
        <span class="material-symbols-outlined">calendar_month</span>
        <span><strong>${records.length}</strong> days logged</span>
      </div>
      <div class="my-stat-pill">
        <span class="material-symbols-outlined">restaurant</span>
        <span><strong>${daysOrdered}</strong> meals ordered</span>
      </div>
    </div>

    <!-- Timeline -->
    <div class="my-orders-timeline" id="my-orders-timeline"></div>
  `;

  const timeline = document.getElementById('my-orders-timeline');

  records.forEach(record => {
    const timeLabel = record.timestamp
      ? new Date(record.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : null;

    const item = document.createElement('div');
    item.className = 'my-order-item';
    item.innerHTML = `
      <div class="my-order-dot"></div>
      <div class="my-order-card">
        <div class="my-order-card-top">
          <span class="my-order-date">${escapeHtml(formatDate(record.date))}</span>
        </div>
        <div class="my-order-card-bottom">
          ${
            record.itemName
              ? `<span class="my-order-dish"><span class="material-symbols-outlined">restaurant_menu</span>${escapeHtml(record.itemName)}</span>`
              : `<span class="my-order-dish text-muted"><span class="material-symbols-outlined">block</span>No food ordered</span>`
          }
          ${timeLabel ? `<span class="my-order-time"><span class="material-symbols-outlined">schedule</span>Submitted ${timeLabel}</span>` : ''}
        </div>
      </div>
    `;
    timeline.appendChild(item);
  });
}

// --- Event Listeners ---

function setupEventListeners() {
  // Login Inputs
  loginUserSearch.addEventListener('focus', () => {
    loginRosterDropdown.classList.remove('hidden');
    filterLoginDropdown();
  });
  
  loginUserSearch.addEventListener('input', () => {
    loginRosterDropdown.classList.remove('hidden');
    filterLoginDropdown();
  });

  // Hide dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-select-container')) {
      loginRosterDropdown.classList.add('hidden');
    }
  });

  btnLogin.addEventListener('click', handleLogin);
  btnSubmitNewPasscode.addEventListener('click', handleForcePasscodeSubmit);
  loginPasscode.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleLogin();
  });

  btnLogout.addEventListener('click', logout);
  btnThemeToggle.addEventListener('click', toggleTheme);

  // Tab Buttons Switching
  navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.target);
    });
  });

  // Order Submit Action
  orderForm.addEventListener('submit', handleOrderSubmit);

  // Change Selection Action
  btnChangeOrder.addEventListener('click', () => {
    isEditingOrder = true;
    renderFoodOrderForm();
  });

  // Live Summary Search
  summaryListSearch.addEventListener('input', renderDetailedBreakdownList);
  distributionSearch.addEventListener('input', renderDistributionView);

  // Live Summary Export actions
  btnCopyWhatsapp.addEventListener('click', copyWhatsAppSummary);
  btnExportCsv.addEventListener('click', exportCsvSummary);
  btnRemindPending.addEventListener('click', remindPendingMembers);
  btnClearOrders.addEventListener('click', clearAllOrders);
  btnDismissReminder.addEventListener('click', dismissReminderBanner);

  // Admin Setup Menu buttons
  btnAdminAddDish.addEventListener('click', () => addDishInputRow('', '', ''));
  btnAdminSaveMenu.addEventListener('click', saveAdminMenu);
  adminPublishToggle.addEventListener('change', handlePublishToggle);

  // Admin settings buttons
  btnSaveCutoff.addEventListener('click', saveAdminCutoff);
  btnSaveArchiveTime.addEventListener('click', saveAdminArchiveTime);

  // Manual lock toggle buttons
  btnForceLock.addEventListener('click', () => handleForceLock(true));
  btnLockRevert.addEventListener('click', () => handleForceLock(null));
  btnExtendCutoff.addEventListener('click', handleExtendCutoff);

  // Roster buttons
  rosterSearch.addEventListener('input', renderRosterTable);
  btnRosterSort.addEventListener('click', () => {
    rosterSortDirection = rosterSortDirection === 'asc' ? 'desc' : 'asc';
    rosterSortIcon.textContent = rosterSortDirection === 'asc' ? 'south' : 'north';
    rosterSortLabel.textContent = rosterSortDirection === 'asc' ? 'A–Z' : 'Z–A';
    renderRosterTable();
  });
  rosterForm.addEventListener('submit', handleRosterFormSubmit);
  btnRosterCancel.addEventListener('click', closeRosterModal);
  btnAddRosterMember.addEventListener('click', () => openRosterModal(null));
  btnRosterModalClose.addEventListener('click', closeRosterModal);
  rosterModalOverlay.addEventListener('click', (e) => {
    if (e.target === rosterModalOverlay) closeRosterModal();
  });
  btnRosterModalReset.addEventListener('click', () => {
    if (currentRosterModalUser) resetRosterMemberPasscode(currentRosterModalUser);
  });
  btnRosterModalDelete.addEventListener('click', () => {
    if (currentRosterModalUser) deleteRosterMember(currentRosterModalUser);
  });

  // Bulk import toggle (collapse/expand)
  document.getElementById('bulk-import-toggle').addEventListener('click', () => {
    const body = document.getElementById('bulk-import-body');
    const chevron = document.getElementById('bulk-chevron');
    body.classList.toggle('collapsed');
    chevron.textContent = body.classList.contains('collapsed') ? 'expand_more' : 'expand_less';
  });

  // Bulk import action
  document.getElementById('btn-bulk-import').addEventListener('click', handleBulkImport);
  document.getElementById('btn-bulk-clear').addEventListener('click', () => {
    document.getElementById('bulk-import-textarea').value = '';
    const result = document.getElementById('bulk-import-result');
    result.classList.add('hidden');
    result.innerHTML = '';
  });
}

// --- Utility Functions ---

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Start Application on Load
window.addEventListener('DOMContentLoaded', initApp);
