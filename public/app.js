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

// --- PWA installability ---
// Registered unconditionally (not gated behind push-notification opt-in,
// unlike the enablePushNotifications() flow below) so "Add to Home Screen"
// works on first visit — an active service worker + manifest.json are what
// browsers actually check for installability, independent of Push/Notification
// support. Safe to call even if the browser later also registers it again
// via enablePushNotifications(); the browser returns the same registration.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {}); // best-effort; unsupported browsers just stay non-installable
}

// --- Prevent pre-auth-screen flash ---
// Applied immediately on load (before DOMContentLoaded): show whichever
// pre-auth view is actually correct right away, instead of waiting for
// initApp()'s async work (and leaving every view hidden, or the wrong one
// visible, in the meantime). initApp() below re-derives and may override
// this once it has verified a saved session.
(function preAuthFlashGuard() {
  if (localStorage.getItem('lunchsync_token')) {
    return; // initApp() will verify the session and show the right view
  }
  if (location.pathname === '/platform') {
    document.getElementById('platform-login-view').classList.remove('hidden');
  } else if (location.pathname === '/reset-passcode') {
    document.getElementById('reset-passcode-view').classList.remove('hidden');
  } else if (localStorage.getItem('lunchsync_company')) {
    document.getElementById('login-view').classList.remove('hidden');
  } else {
    document.getElementById('company-view').classList.remove('hidden');
  }
})();

// --- Global State ---
let currentUser = null;
let currentToken = '';
let currentCompany = null; // { id, code, name } — null until resolved via /api/company/resolve
let roster = [];
let dailyState = null;
let selectedLoginUserId = '';
let activeTab = 'order-tab';
let pollInterval = null;
let isEditingOrder = false;
// True once the user has clicked a dish or typed a note that hasn't been
// submitted yet. The order form re-renders on every ~10s poll; without this,
// an in-progress selection gets silently wiped out by the next poll landing
// before the user hits Submit.
let orderFormDirty = false;

// "today" or "week" — which view the Order Lunch tab shows. Persisted so a
// reload doesn't dump someone back into today-mode mid-planning.
let orderMode = localStorage.getItem('lunchsync_order_mode') === 'week' ? 'week' : 'today';
let weekPlan = null;
let weekPlanFetchedAt = 0;
// Dates (YYYY-MM-DD) with an in-flight edit — mirrors orderFormDirty's role
// but per-card, since the weekly grid re-renders on every poll too.
const weekPlanDirtyDates = new Set();

// --- DOM Elements ---
const headerInfo = document.getElementById('header-info');
const displayDate = document.getElementById('display-date');
const displayCutoff = document.getElementById('display-cutoff');
const headerUserName = document.getElementById('header-user-name');
const headerUserRole = document.getElementById('header-user-role');
const headerAvatarInitials = document.getElementById('header-avatar-initials');
const userProfileToggle = document.getElementById('user-profile-toggle');
const userProfileDropdown = document.getElementById('user-profile-dropdown');
const btnLogout = document.getElementById('btn-logout');
const btnThemeToggle = document.getElementById('btn-theme-toggle');
const headerRight = document.querySelector('.header-right');
const notificationBellWrap = document.getElementById('notification-bell-wrap');
const btnNotificationBell = document.getElementById('btn-notification-bell');
const notificationBadge = document.getElementById('notification-badge');
const notificationDropdown = document.getElementById('notification-dropdown');
const notificationDropdownList = document.getElementById('notification-dropdown-list');
const btnMobileMenuToggle = document.getElementById('btn-mobile-menu-toggle');
const navSidebar = document.getElementById('nav-sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');

const loginView = document.getElementById('login-view');
const loginUserSearch = document.getElementById('login-user-search');
const loginRosterDropdown = document.getElementById('login-roster-dropdown');
const loginPasscodeGroup = document.getElementById('login-passcode-group');
const loginPasscode = document.getElementById('login-passcode');
const btnLogin = document.getElementById('btn-login');
const loginError = document.getElementById('login-error');
const linkNotYourCompany = document.getElementById('link-not-your-company');
const linkForgotPasscode = document.getElementById('link-forgot-passcode');

// Forgot Passcode view
const forgotPasscodeView = document.getElementById('forgot-passcode-view');
const forgotPasscodeEmail = document.getElementById('forgot-passcode-email');
const btnForgotPasscodeSubmit = document.getElementById('btn-forgot-passcode-submit');
const forgotPasscodeError = document.getElementById('forgot-passcode-error');
const forgotPasscodeStatus = document.getElementById('forgot-passcode-status');
const linkBackToLoginFromForgot = document.getElementById('link-back-to-login-from-forgot');

// Reset Passcode view (from an emailed link)
const resetPasscodeView = document.getElementById('reset-passcode-view');
const resetPasscode1 = document.getElementById('reset-passcode-1');
const resetPasscode2 = document.getElementById('reset-passcode-2');
const btnResetPasscodeSubmit = document.getElementById('btn-reset-passcode-submit');
const resetPasscodeError = document.getElementById('reset-passcode-error');

// Company code view
const companyView = document.getElementById('company-view');
const companyCodeInput = document.getElementById('company-code-input');
const btnCompanySubmit = document.getElementById('btn-company-submit');
const companyError = document.getElementById('company-error');
const linkPlatformLogin = document.getElementById('link-platform-login');

// Platform Admin login view
const platformLoginView = document.getElementById('platform-login-view');
const platformLoginName = document.getElementById('platform-login-name');
const platformLoginPasscode = document.getElementById('platform-login-passcode');
const btnPlatformLogin = document.getElementById('btn-platform-login');
const platformLoginError = document.getElementById('platform-login-error');
const linkBackToCompany = document.getElementById('link-back-to-company');

// Companies tab (Platform Admin)
const companiesTableBody = document.getElementById('companies-table-body');
const btnAddCompany = document.getElementById('btn-add-company');
const companyModalOverlay = document.getElementById('company-modal-overlay');
const btnCompanyModalClose = document.getElementById('btn-company-modal-close');
const companyForm = document.getElementById('company-form');
const companyFormId = document.getElementById('company-form-id');
const companyFormName = document.getElementById('company-form-name');
const companyFormCode = document.getElementById('company-form-code');
const companyFormCodeGroup = document.getElementById('company-form-code-group');
const companyFormAdminName = document.getElementById('company-form-admin-name');
const companyFormAdminEmail = document.getElementById('company-form-admin-email');
const companyFormAdminGroup = document.getElementById('company-form-admin-group');
const companyFormAdminEmailGroup = document.getElementById('company-form-admin-email-group');
const btnCompanyCancel = document.getElementById('btn-company-cancel');
const companyFormStatus = document.getElementById('company-form-status');
const companyFormTitle = document.getElementById('company-form-title');

const forcePasscodeView = document.getElementById('force-passcode-view');
const newPasscode1 = document.getElementById('new-passcode-1');
const newPasscode2 = document.getElementById('new-passcode-2');
const btnSubmitNewPasscode = document.getElementById('btn-submit-new-passcode');
const forcePasscodeError = document.getElementById('force-passcode-error');

const dashboardView = document.getElementById('dashboard-view');
const navTabs = document.querySelectorAll('.nav-tab');
const tabPanels = document.querySelectorAll('.tab-panel');

// Order Tab
const orderGreetingText = document.getElementById('order-greeting-text');
const orderGreetingSubtext = document.getElementById('order-greeting-subtext');
const countdownBanner = document.getElementById('countdown-banner');
const reminderBanner = document.getElementById('reminder-banner');
const btnDismissReminder = document.getElementById('btn-dismiss-reminder');
const foodArrivedBanner = document.getElementById('food-arrived-banner');
const foodArrivedText = document.getElementById('food-arrived-text');
const btnDismissFoodArrived = document.getElementById('btn-dismiss-food-arrived');
const notificationRequestBanner = document.getElementById('notification-request-banner');
const btnEnableNotifications = document.getElementById('btn-enable-notifications');
const btnFoodArrived = document.getElementById('btn-food-arrived');
const foodArrivedStatus = document.getElementById('food-arrived-status');
const notifyTitle = document.getElementById('notify-title');
const notifyBody = document.getElementById('notify-body');
const btnSendNotification = document.getElementById('btn-send-notification');
const notifyStatus = document.getElementById('notify-status');
const notifyRepeatGroup = document.getElementById('notify-repeat-group');
const notifyScheduleOnceGroup = document.getElementById('notify-schedule-once-group');
const notifyScheduleRepeatGroup = document.getElementById('notify-schedule-repeat-group');
const notifyScheduleTime = document.getElementById('notify-schedule-time');
const notifyScheduleRepeatTime = document.getElementById('notify-schedule-repeat-time');
const btnSendNotificationLabel = document.getElementById('btn-send-notification-label');
const notifyScheduledList = document.getElementById('notify-scheduled-list');
const notifyScheduledEmpty = document.getElementById('notify-scheduled-empty');
const checkpointList = document.getElementById('checkpoint-list');
const btnAddCheckpoint = document.getElementById('btn-add-checkpoint');
const btnSaveCheckpoints = document.getElementById('btn-save-checkpoints');
const checkpointStatus = document.getElementById('checkpoint-status');
const notifyHistoryList = document.getElementById('notify-history-list');
const notifyEditingBanner = document.getElementById('notify-editing-banner');
const btnCancelEditNotification = document.getElementById('btn-cancel-edit-notification');
const countdownText = document.getElementById('countdown-text');
const orderFormCard = document.getElementById('order-form-card');
const orderForm = document.getElementById('order-form');
const menuStatusMsg = document.getElementById('menu-status-msg');
const menuItemsGrid = document.getElementById('menu-items-grid');
const orderSubmitStatus = document.getElementById('order-submit-status');
const orderNoteInput = document.getElementById('order-note');
const orderVariantSection = document.getElementById('order-variant-section');
const orderVariantLabel = document.getElementById('order-variant-label');
const orderVariantSelect = document.getElementById('order-variant-select');
const confirmationCard = document.getElementById('confirmation-card');
const confirmationText = document.getElementById('confirmation-text');
const btnChangeOrder = document.getElementById('btn-change-order');
const btnCancelOrder = document.getElementById('btn-cancel-order');
const confThumbImg = document.querySelector('.confirmation-card .conf-thumb img');
const orderHeroArtImg = document.querySelector('.order-hero-art img');
const orderModeToggle = document.getElementById('order-mode-toggle');
const weeklyPlanCard = document.getElementById('weekly-plan-card');
const weeklyMenuStatusMsg = document.getElementById('weekly-menu-status-msg');
const weekGrid = document.getElementById('week-grid');
const weeklyPlanStatus = document.getElementById('weekly-plan-status');

// Live Summary Tab
const statTotal = document.getElementById('stat-total');
const statOrdered = document.getElementById('stat-ordered');
const statPending = document.getElementById('stat-pending');
const summaryDishTotals = document.getElementById('summary-dish-totals');
const summaryListSearch = document.getElementById('summary-list-search');
const summaryGroups = document.getElementById('summary-groups');
const summaryUnconfirmed = document.getElementById('summary-unconfirmed');
const summaryUnconfirmedCount = document.getElementById('summary-unconfirmed-count');
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
const otherDishesSection = document.getElementById('other-dishes-section');
const otherDishesList = document.getElementById('other-dishes-list');
const archivedDishesSection = document.getElementById('archived-dishes-section');
const archivedDishesList = document.getElementById('archived-dishes-list');
const archivedDishesCount = document.getElementById('archived-dishes-count');

// Add/Edit Dish Modal
const catalogModalOverlay = document.getElementById('catalog-modal-overlay');
const catalogModalTitle = document.getElementById('catalog-modal-title');
const btnCatalogModalClose = document.getElementById('btn-catalog-modal-close');
const catalogDishForm = document.getElementById('catalog-dish-form');
const catalogDishId = document.getElementById('catalog-dish-id');
const catalogDishName = document.getElementById('catalog-dish-name');
const catalogDishDesc = document.getElementById('catalog-dish-desc');
const catalogDishPrice = document.getElementById('catalog-dish-price');
const catalogDishVariantLabel = document.getElementById('catalog-dish-variant-label');
const catalogDishVariantOptions = document.getElementById('catalog-dish-variant-options');
const catalogDishImageInput = document.getElementById('catalog-dish-image');
const catalogDishImagePreview = document.getElementById('catalog-dish-image-preview');
const btnCatalogDishSubmit = document.getElementById('btn-catalog-dish-submit');
const btnCatalogDishCancel = document.getElementById('btn-catalog-dish-cancel');
const btnCatalogDishRemove = document.getElementById('btn-catalog-dish-remove');
const catalogDishStatus = document.getElementById('catalog-dish-status');
const adminCutoffTime = document.getElementById('admin-cutoff-time');
const btnSaveCutoff = document.getElementById('btn-save-cutoff');
const adminCutoffStatus = document.getElementById('admin-cutoff-status');
const adminArchiveTime = document.getElementById('admin-archive-time');
const btnSaveArchiveTime = document.getElementById('btn-save-archive-time');
const adminArchiveTimeStatus = document.getElementById('admin-archive-time-status');
const operationalDaysPicker = document.getElementById('operational-days-picker');
const btnSaveOperationalDays = document.getElementById('btn-save-operational-days');
const adminOperationalDaysStatus = document.getElementById('admin-operational-days-status');
const companyDefaultPrice = document.getElementById('company-default-price');
const btnSaveCompanySettings = document.getElementById('btn-save-company-settings');
const companySettingsStatus = document.getElementById('company-settings-status');
const closedDayPanel = document.getElementById('closed-day-panel');
const closedDayNextLabel = document.getElementById('closed-day-next-label');
const menuPromoBanner = document.getElementById('menu-promo-banner');
// Lock toggle
const btnForceLock = document.getElementById('btn-force-lock');
const btnLockRevert = document.getElementById('btn-lock-revert');
const lockIcon = document.getElementById('lock-icon');
const lockStatusLabel = document.getElementById('lock-status-label');
const lockStatusDesc = document.getElementById('lock-status-desc');
const adminLockStatus = document.getElementById('admin-lock-status');
const adminExtendMinutes = document.getElementById('admin-extend-minutes');
const btnExtendCutoff = document.getElementById('btn-extend-cutoff');

// Login Security Settings
const securityMaxFailedAttempts = document.getElementById('security-max-failed-attempts');
const securityLockoutMinutes = document.getElementById('security-lockout-minutes');
const securityRateLimitMax = document.getElementById('security-rate-limit-max');
const securityRateLimitWindow = document.getElementById('security-rate-limit-window');
const btnSaveSecuritySettings = document.getElementById('btn-save-security-settings');
const securitySettingsStatus = document.getElementById('security-settings-status');

// Roster Tab
const rosterTableBody = document.getElementById('roster-table-body');
const rosterSearch = document.getElementById('roster-search');
const rosterBranchFilter = document.getElementById('roster-branch-filter');
const btnRosterSort = document.getElementById('btn-roster-sort');
const rosterSortIcon = document.getElementById('roster-sort-icon');
const rosterSortLabel = document.getElementById('roster-sort-label');
let rosterSortDirection = 'asc';
const rosterForm = document.getElementById('roster-form');
const rosterUserId = document.getElementById('roster-user-id');
const rosterName = document.getElementById('roster-name');
const rosterEmail = document.getElementById('roster-email');
const rosterPhone = document.getElementById('roster-phone');
const rosterBranch = document.getElementById('roster-branch');
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

// Branches
const branchesTableBody = document.getElementById('branches-table-body');
const branchAddForm = document.getElementById('branch-add-form');
const branchAddName = document.getElementById('branch-add-name');
const branchFormStatus = document.getElementById('branch-form-status');

// History Tab
const historyDatesList = document.getElementById('history-dates-list');
const historyDetailPanel = document.getElementById('history-detail-panel');

// Trends Tab
const trendsStartDate = document.getElementById('trends-start-date');
const trendsEndDate = document.getElementById('trends-end-date');
const trendsSpendCaveat = document.getElementById('trends-spend-caveat');
const trendsSpendChartCanvas = document.getElementById('trends-spend-chart');
const trendsPopularityChartCanvas = document.getElementById('trends-popularity-chart');

// My Orders Tab
const myOrdersContainer = document.getElementById('my-orders-container');

// Catch the Food mini-game
const gameCanvas = document.getElementById('game-canvas');
const gameCanvasWrap = document.querySelector('.game-canvas-wrap');
const gameCountdownEl = document.getElementById('game-countdown');
const gameOverlay = document.getElementById('game-overlay');
const gameOverlayText = document.getElementById('game-overlay-text');
const gameOverlayTitleEl = document.getElementById('game-overlay-title');
const gameOverlayStatsEl = document.getElementById('game-overlay-stats');
const btnGameStart = document.getElementById('btn-game-start');
const gameScoreEl = document.getElementById('game-score');
const gameBestScoreEl = document.getElementById('game-best-score');
const gameStageLabelEl = document.getElementById('game-stage-label');
const gameStageToastEl = document.getElementById('game-stage-toast');
const gameHitFlashEl = document.getElementById('game-hit-flash');
const gamePopupLayerEl = document.getElementById('game-popup-layer');
const gameAvatarPickerEl = document.getElementById('game-avatar-picker');
const gameFullscreenBtn = document.getElementById('btn-game-fullscreen');
const gameFullscreenIconEl = document.getElementById('game-fullscreen-icon');
const gameLeaderboardListEl = document.getElementById('game-leaderboard-list');
const gameLeaderboardScopeEl = document.getElementById('game-leaderboard-scope');
const gamePauseOverlayEl = document.getElementById('game-pause-overlay');
const btnGameResume = document.getElementById('btn-game-resume');
const btnTouchLeft = document.getElementById('btn-touch-left');
const btnTouchRight = document.getElementById('btn-touch-right');
const btnTouchJump = document.getElementById('btn-touch-jump');
const btnTouchSlide = document.getElementById('btn-touch-slide');
const myTrendsCard = document.getElementById('my-trends-card');
const myTrendsStats = document.getElementById('my-trends-stats');
const myTrendsChartCanvas = document.getElementById('my-trends-chart');

// Generic app modal (replaces window.alert()/confirm())
const appModalOverlay = document.getElementById('app-modal-overlay');
const appModalTitle = document.getElementById('app-modal-title');
const appModalMessage = document.getElementById('app-modal-message');
const appModalCodeBlock = document.getElementById('app-modal-code-block');
const appModalCodeText = document.getElementById('app-modal-code-text');
const appModalCopyBtn = document.getElementById('app-modal-copy-btn');
const appModalConfirmBtn = document.getElementById('app-modal-confirm-btn');
const appModalCancelBtn = document.getElementById('app-modal-cancel-btn');
const appModalOkBtn = document.getElementById('app-modal-ok-btn');

// --- Helper Functions ---

// Core modal renderer. `type` is 'alert' (single OK button) or 'confirm'
// (Confirm/Cancel, resolves true/false). `code` optionally shows a
// highlighted, copyable value below the message (e.g. a generated passcode).
function showAppModal({ title, message, type = 'alert', danger = false, code = null }) {
  return new Promise((resolve) => {
    appModalTitle.textContent = title || (type === 'confirm' ? 'Please confirm' : 'Notice');
    appModalMessage.textContent = message;

    appModalCodeBlock.classList.toggle('hidden', !code);
    if (code) appModalCodeText.textContent = code;

    const isConfirm = type === 'confirm';
    appModalConfirmBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    appModalConfirmBtn.classList.toggle('hidden', !isConfirm);
    appModalCancelBtn.classList.toggle('hidden', !isConfirm);
    appModalOkBtn.classList.toggle('hidden', isConfirm);

    const cleanup = (result) => {
      appModalOverlay.classList.add('hidden');
      appModalConfirmBtn.removeEventListener('click', onConfirm);
      appModalCancelBtn.removeEventListener('click', onCancel);
      appModalOkBtn.removeEventListener('click', onOk);
      appModalCopyBtn.removeEventListener('click', onCopy);
      resolve(result);
    };
    const onConfirm = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOk = () => cleanup(true);
    const onCopy = () => {
      navigator.clipboard.writeText(appModalCodeText.textContent).catch(() => {});
      appModalCopyBtn.querySelector('.material-symbols-outlined').textContent = 'check';
      setTimeout(() => {
        appModalCopyBtn.querySelector('.material-symbols-outlined').textContent = 'content_copy';
      }, 1500);
    };

    appModalConfirmBtn.addEventListener('click', onConfirm);
    appModalCancelBtn.addEventListener('click', onCancel);
    appModalOkBtn.addEventListener('click', onOk);
    appModalCopyBtn.addEventListener('click', onCopy);

    appModalOverlay.classList.remove('hidden');
  });
}

function showAlert(message, opts = {}) {
  return showAppModal({ message, type: 'alert', ...opts });
}

function confirmDialog(message, opts = {}) {
  return showAppModal({ message, type: 'confirm', ...opts });
}

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
  if (currentCompany?.code) {
    headers['x-company-code'] = currentCompany.code;
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
    if (errData.code === 'COMPANY_CODE_REQUIRED') {
      // The remembered company code is stale/invalid (e.g. suspended) —
      // drop it and send the user back to the company-code screen.
      clearSavedCompany();
      showCompanyView();
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

// --- Company resolution (multi-tenancy) ---

function getSavedCompany() {
  const raw = localStorage.getItem('lunchsync_company');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveCompany(company) {
  currentCompany = company;
  localStorage.setItem('lunchsync_company', JSON.stringify(company));
}

// Clears the remembered company only — NOT the session token. Logging out
// of an account should never forget which company you're in; this is a
// separate, explicit "not your company?" action.
function clearSavedCompany() {
  currentCompany = null;
  localStorage.removeItem('lunchsync_company');
}

function hideAllPreAuthViews() {
  companyView.classList.add('hidden');
  platformLoginView.classList.add('hidden');
  loginView.classList.add('hidden');
  forcePasscodeView.classList.add('hidden');
  forgotPasscodeView.classList.add('hidden');
  resetPasscodeView.classList.add('hidden');
}

function showCompanyView() {
  hideAllPreAuthViews();
  companyCodeInput.value = '';
  companyError.classList.add('hidden');
  companyView.classList.remove('hidden');
}

function showPlatformLoginView() {
  hideAllPreAuthViews();
  platformLoginError.classList.add('hidden');
  platformLoginView.classList.remove('hidden');
}

function showLoginView() {
  hideAllPreAuthViews();
  loginView.classList.remove('hidden');
}

function showForgotPasscodeView() {
  hideAllPreAuthViews();
  forgotPasscodeEmail.value = '';
  forgotPasscodeError.classList.add('hidden');
  forgotPasscodeStatus.classList.add('hidden');
  forgotPasscodeView.classList.remove('hidden');
}

function showResetPasscodeView() {
  hideAllPreAuthViews();
  resetPasscode1.value = '';
  resetPasscode2.value = '';
  resetPasscodeError.classList.add('hidden');
  resetPasscodeView.classList.remove('hidden');
}

// Fetch the login screen's minimal public id+name roster list — the caller
// is responsible for having a resolved company (x-company-code header) first.
async function loadLoginList() {
  try {
    roster = await apiCall('/api/roster/login-list');
    populateLoginDropdown(roster);
  } catch (err) {
    console.error('Failed to load roster on startup:', err);
  }
}

async function handleCompanySubmit() {
  companyError.classList.add('hidden');
  const code = companyCodeInput.value.trim();
  if (!code) {
    companyError.textContent = 'Please enter your company code.';
    companyError.classList.remove('hidden');
    return;
  }
  try {
    const result = await apiCall('/api/company/resolve', 'POST', { code });
    saveCompany(result);
    await loadLoginList();
    showLoginView();
  } catch (err) {
    companyError.textContent = err.message || 'Company not found.';
    companyError.classList.remove('hidden');
  }
}

async function handlePlatformLogin() {
  platformLoginError.classList.add('hidden');
  const name = platformLoginName.value.trim();
  const passcode = platformLoginPasscode.value.trim();
  if (!name || !passcode) {
    platformLoginError.textContent = 'Name and passcode are required.';
    platformLoginError.classList.remove('hidden');
    return;
  }
  try {
    const result = await apiCall('/api/platform/login', 'POST', { name, passcode });
    currentUser = result.user;
    currentToken = result.token;
    localStorage.setItem('lunchsync_token', currentToken);
    if (currentUser.mustChangePasscode) {
      showForcePasscodeView();
    } else {
      loginSuccess();
    }
  } catch (err) {
    platformLoginError.textContent = err.message || 'Login failed.';
    platformLoginError.classList.remove('hidden');
  }
}

async function handleForgotPasscodeSubmit() {
  forgotPasscodeError.classList.add('hidden');
  forgotPasscodeStatus.classList.add('hidden');
  const email = forgotPasscodeEmail.value.trim();
  if (!email) {
    forgotPasscodeError.textContent = 'Enter your email address.';
    forgotPasscodeError.classList.remove('hidden');
    return;
  }

  btnForgotPasscodeSubmit.disabled = true;
  try {
    // The server always responds the same way whether or not the email
    // matches an account — that's deliberate (no confirming/denying an
    // email's existence to an unauthenticated caller), so this message is
    // shown regardless of the actual outcome.
    const result = await apiCall('/api/forgot-passcode', 'POST', { email });
    forgotPasscodeStatus.textContent = result.message;
    forgotPasscodeStatus.classList.remove('hidden');
  } catch (err) {
    forgotPasscodeError.textContent = err.message || 'Something went wrong. Please try again.';
    forgotPasscodeError.classList.remove('hidden');
  } finally {
    btnForgotPasscodeSubmit.disabled = false;
  }
}

async function handleResetPasscodeSubmit() {
  resetPasscodeError.classList.add('hidden');

  const token = new URLSearchParams(location.search).get('token');
  if (!token) {
    resetPasscodeError.textContent = 'This reset link is missing its token. Request a new one from the login screen.';
    resetPasscodeError.classList.remove('hidden');
    return;
  }

  const p1 = resetPasscode1.value.trim();
  const p2 = resetPasscode2.value.trim();
  if (p1.length < 8) {
    resetPasscodeError.textContent = 'Passcode must be at least 8 characters.';
    resetPasscodeError.classList.remove('hidden');
    return;
  }
  if (p1 !== p2) {
    resetPasscodeError.textContent = 'Passcodes do not match.';
    resetPasscodeError.classList.remove('hidden');
    return;
  }

  try {
    await apiCall('/api/reset-passcode', 'POST', { token, newPasscode: p1 });
    await showAlert('Your passcode has been reset. You can now log in with it.', { title: 'Passcode Reset' });
    history.pushState({}, '', '/');
    if (currentCompany) {
      await loadLoginList();
      showLoginView();
    } else {
      showCompanyView();
    }
  } catch (err) {
    resetPasscodeError.textContent = err.message || 'Failed to reset passcode.';
    resetPasscodeError.classList.remove('hidden');
  }
}

// --- App Initialization & Auth ---

// Installed (home-screen) PWAs run without browser chrome, so there's no
// reload button and no built-in pull-to-refresh. Adds one, only in that
// mode — a normal browser tab already has its own. A pull only starts at
// the very top of the page, and never from a dialog, the open side menu,
// the game, or a form field (a drag there means something else).
function setupPullToRefresh() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!standalone) return;

  const indicator = document.createElement('div');
  indicator.className = 'pull-refresh-indicator';
  indicator.innerHTML = '<span class="material-symbols-outlined">refresh</span>';
  document.body.appendChild(indicator);

  const THRESHOLD = 70;
  let startY = null;
  let startX = 0;
  let pull = 0;

  const reset = () => {
    startY = null;
    pull = 0;
    indicator.style.transform = '';
    indicator.style.opacity = '';
    indicator.classList.remove('ready');
  };

  document.addEventListener('touchstart', (e) => {
    if (window.scrollY > 0 || e.touches.length !== 1) return;
    if (e.target.closest('.modal-overlay, .nav-sidebar.open, .game-canvas-wrap, input, select, textarea')) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    const dx = Math.abs(e.touches[0].clientX - startX);
    if (dy <= 0 || dx > dy) { reset(); return; } // scrolling up or swiping sideways
    pull = Math.min(dy * 0.5, 110);
    indicator.style.transform = `translate(-50%, ${pull}px) rotate(${pull * 3}deg)`;
    indicator.style.opacity = String(Math.min(pull / THRESHOLD, 1));
    indicator.classList.toggle('ready', pull >= THRESHOLD);
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (startY === null) return;
    if (pull >= THRESHOLD) {
      indicator.classList.add('refreshing');
      location.reload();
      return;
    }
    reset();
  });
  document.addEventListener('touchcancel', reset);
}

async function initApp() {
  setupPullToRefresh();
  currentCompany = getSavedCompany();

  // A reset-passcode link is an explicit, unambiguous action — show it
  // even if this browser also happens to have an existing saved session,
  // rather than silently ignoring the link and dropping them into their
  // dashboard instead.
  if (location.pathname === '/reset-passcode') {
    showResetPasscodeView();
    setupEventListeners();
    return;
  }

  // Check for a saved session token in localStorage
  const savedToken = localStorage.getItem('lunchsync_token');

  if (savedToken) {
    try {
      currentToken = savedToken;

      // Verify the token is still valid and fetch the current user record
      const check = await apiCall('/api/me');
      currentUser = check.user;

      if (currentUser.role !== 'Platform Admin' && currentUser.mustChangePasscode) {
        showForcePasscodeView();
      } else {
        loginSuccess();
      }
      setupEventListeners();
      return;
    } catch (err) {
      console.warn('Saved session invalid or expired, clearing credentials:', err);
      logout();
    }
  }

  if (location.pathname === '/platform') {
    showPlatformLoginView();
  } else if (!currentCompany) {
    showCompanyView();
  } else {
    await loadLoginList();
    showLoginView();
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
  hideAllPreAuthViews();
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
  hideAllPreAuthViews();
  dashboardView.classList.remove('hidden');
  headerInfo.classList.remove('hidden');
  btnMobileMenuToggle.classList.remove('hidden');

  headerUserName.textContent = currentUser.name;
  headerUserRole.textContent = currentUser.role;
  headerAvatarInitials.textContent = getInitials(currentUser.name);

  // Render proper tabs based on role
  document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.admin-abigail-only').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.platform-admin-only').forEach(el => el.classList.add('hidden'));

  const navTabOrder = document.querySelector('.nav-tab[data-target="order-tab"]');
  const navTabMyOrders = document.getElementById('nav-tab-my-orders');

  if (currentUser.role === 'Platform Admin') {
    // A Platform Admin manages companies, not one company's roster/menu/orders —
    // deliberately skip the company-scoped bootstrap below entirely.
    document.querySelectorAll('.platform-admin-only').forEach(el => el.classList.remove('hidden'));
    navTabOrder.classList.add('hidden');
    navTabMyOrders.classList.add('hidden');
    notificationBellWrap.classList.add('hidden');
    switchTab('companies-tab');
    await loadCompanies();
    return;
  }

  navTabOrder.classList.remove('hidden');
  navTabMyOrders.classList.remove('hidden');
  notificationBellWrap.classList.remove('hidden');
  updateNotificationRequestBanner();

  if (currentUser.role === 'Admin') {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
    document.querySelectorAll('.admin-abigail-only').forEach(el => el.classList.remove('hidden'));
  } else if (currentUser.role === 'Abigail') {
    document.querySelectorAll('.admin-abigail-only').forEach(el => el.classList.remove('hidden'));
  }

  // Sync the today/week toggle buttons to the persisted mode before the
  // first fetch, so fetchDailyState's orderMode check is already correct.
  orderModeToggle.querySelectorAll('.order-mode-btn').forEach(btn => {
    const active = btn.dataset.mode === orderMode;
    btn.classList.toggle('selected', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  // Roster snapshot and today's state don't depend on each other — fetch
  // them in parallel rather than one round-trip after the other.
  const rosterLoad = apiCall('/api/roster')
    .then(result => { roster = result; })
    .catch(err => console.error('Error updating roster snapshot:', err));
  await Promise.all([rosterLoad, fetchDailyState()]);
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(fetchDailyState, 10000);

  // Switch to default tab
  switchTab('order-tab');
}

function logout() {
  const wasPlatformAdmin = currentUser?.role === 'Platform Admin';

  currentUser = null;
  currentToken = '';
  selectedLoginUserId = '';
  isEditingOrder = false;
  orderFormDirty = false;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }

  localStorage.removeItem('lunchsync_token');
  // The remembered company is deliberately kept — logging out of an
  // account shouldn't forget which company you're in.

  loginUserSearch.value = '';
  loginPasscode.value = '';
  loginPasscodeGroup.classList.add('hidden');
  loginError.classList.add('hidden');

  headerInfo.classList.add('hidden');
  notificationBellWrap.classList.add('hidden');
  btnMobileMenuToggle.classList.add('hidden');
  closeMobileNav();
  dashboardView.classList.add('hidden');

  if (wasPlatformAdmin) {
    showPlatformLoginView();
  } else if (currentCompany) {
    showLoginView();
    loadLoginList();
  } else {
    showCompanyView();
  }
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

  closeMobileNav();
}

// --- Mobile off-canvas sidebar ---
// Below the 1024px breakpoint the sidebar becomes a hamburger-triggered
// drawer. The header's date/cutoff/profile block physically moves into the
// drawer at that width (it doesn't fit the compact mobile header) and moves
// back into the header once the viewport is wide enough for the full row.
const mobileNavQuery = window.matchMedia('(max-width: 1024px)');

function relocateHeaderInfo(isMobile) {
  if (isMobile) {
    if (headerInfo.parentElement !== navSidebar) {
      navSidebar.insertBefore(headerInfo, navSidebar.firstChild);
    }
  } else {
    if (headerInfo.parentElement !== headerRight) {
      headerRight.insertBefore(headerInfo, btnThemeToggle);
    }
    closeMobileNav();
  }
}

function openMobileNav() {
  navSidebar.classList.add('open');
  sidebarOverlay.classList.remove('hidden');
}

function closeMobileNav() {
  navSidebar.classList.remove('open');
  sidebarOverlay.classList.add('hidden');
}

function toggleMobileNav() {
  if (navSidebar.classList.contains('open')) {
    closeMobileNav();
  } else {
    openMobileNav();
  }
}

relocateHeaderInfo(mobileNavQuery.matches);
mobileNavQuery.addEventListener('change', (e) => relocateHeaderInfo(e.matches));

function onTabLoad(tabId) {
  if (tabId === 'admin-tab') {
    loadAdminMenuBuilder();
    loadAdminSettings();
    loadSecuritySettings();
    loadCompanySettings();
  } else if (tabId === 'roster-tab') {
    loadBranches().then(renderRosterTable);
    renderRosterTable();
    resetRosterForm();
  } else if (tabId === 'history-tab') {
    loadHistoryDates();
  } else if (tabId === 'summary-tab') {
    renderSummaryView();
  } else if (tabId === 'my-orders-tab') {
    loadMyOrders();
  } else if (tabId === 'trends-tab') {
    loadTrends();
  } else if (tabId === 'notifications-tab') {
    loadScheduledNotifications();
    loadCheckpoints();
    loadNotificationHistory();
  } else if (tabId === 'game-tab') {
    initGameCanvas();
    loadGameLeaderboard();
  }
}

// --- Data Fetching & UI Updaters ---

async function fetchDailyState() {
  try {
    dailyState = await apiCall('/api/daily');
    updateHeaderDisplay();
    updateCountdownBanner();
    updateReminderBanner();
    updateFoodArrivedBanner();
    updateNotificationBell();

    if (activeTab === 'order-tab') {
      updateOrderGreeting();
      renderFoodOrderForm();
      // Apply mode visibility BEFORE the network await below — otherwise
      // today-mode elements (shown a moment ago by renderFoodOrderForm/
      // updateReminderBanner/etc, which don't know about orderMode) stay
      // visible on-screen for the whole round-trip and only get hidden once
      // fetchWeekPlan resolves, producing a visible flash every ~10s poll.
      applyOrderModeVisibility();
      if (orderMode === 'week') await fetchWeekPlan();
    } else if (activeTab === 'summary-tab') {
      renderSummaryView();
    }
  } catch (err) {
    console.error('Error fetching daily state:', err);
  }
}

// Shows a banner if the current user has an un-dismissed reminder for today
function updateReminderBanner() {
  if (!dailyState || !dailyState.myReminder || !currentUser || dailyState.isOperationalToday === false) {
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
  updateNotificationBell();
}

// Shows a banner if an admin has broadcast "food's in" today and this user
// hasn't dismissed that specific broadcast yet (keyed by its timestamp, so
// a second broadcast the same day — e.g. next-day rollover — reappears).
function updateFoodArrivedBanner() {
  if (!dailyState || !dailyState.foodArrival || !currentUser || dailyState.isOperationalToday === false) {
    foodArrivedBanner.classList.add('hidden');
    return;
  }

  const dismissedKey = `lunchsync_dismissed_food_${currentUser.id}`;
  const dismissedAt = localStorage.getItem(dismissedKey);
  if (dismissedAt === String(dailyState.foodArrival.at)) {
    foodArrivedBanner.classList.add('hidden');
    return;
  }

  foodArrivedText.textContent = `${dailyState.foodArrival.by} says lunch has arrived — come get it!`;
  foodArrivedBanner.classList.remove('hidden');
}

function dismissFoodArrivedBanner() {
  if (dailyState && dailyState.foodArrival && currentUser) {
    localStorage.setItem(`lunchsync_dismissed_food_${currentUser.id}`, String(dailyState.foodArrival.at));
  }
  foodArrivedBanner.classList.add('hidden');
  updateNotificationBell();
}

// Mirrors the reminder/food-arrived banners into the header bell dropdown,
// since both already track their own dismissed-state in localStorage.
function updateNotificationBell() {
  if (!btnNotificationBell) return;
  const items = [];
  if (reminderBanner && !reminderBanner.classList.contains('hidden')) {
    items.push({ icon: 'notifications_active', text: 'Reminder: please place your lunch order before the cutoff time.' });
  }
  if (foodArrivedBanner && !foodArrivedBanner.classList.contains('hidden')) {
    items.push({ icon: 'restaurant', text: foodArrivedText.textContent });
  }

  notificationBadge.textContent = String(items.length);
  notificationBadge.classList.toggle('hidden', items.length === 0);

  notificationDropdownList.innerHTML = items.length
    ? items.map(item => `
        <div class="notification-dropdown-item">
          <span class="material-symbols-outlined">${item.icon}</span>
          <span>${escapeHtml(item.text)}</span>
        </div>
      `).join('')
    : '<p class="notification-empty">No new notifications</p>';
}

function toggleNotificationDropdown() {
  notificationDropdown.classList.toggle('hidden');
  userProfileDropdown.classList.add('hidden');
}

function toggleUserProfileDropdown() {
  userProfileDropdown.classList.toggle('hidden');
  notificationDropdown.classList.add('hidden');
}

// --- Push Notifications ---

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}

function base64UrlToUint8Array(base64Url) {
  const padding = '='.repeat((4 - base64Url.length % 4) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function registerServiceWorker() {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.error('Service worker registration failed:', err);
    return null;
  }
}

async function enablePushNotifications() {
  if (!pushSupported()) {
    showAlert('Push notifications are not supported in this browser.');
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    updateNotificationRequestBanner();
    if (permission !== 'granted') return;

    const registration = await registerServiceWorker();
    if (!registration) throw new Error('Service worker unavailable.');

    const { publicKey } = await apiCall('/api/push/vapid-public-key');
    if (!publicKey) {
      showAlert('Push notifications are not configured on the server yet.');
      return;
    }

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(publicKey)
    });

    await apiCall('/api/push/subscribe', 'POST', { subscription: subscription.toJSON() });
    showExportFeedback('Notifications enabled!');
  } catch (err) {
    showAlert(err.message || 'Failed to enable notifications.');
  }
}

// Shows the "enable notifications" banner only while push is supported and
// the browser hasn't already been asked (permission is still the default
// undecided state) — once granted or denied, Notification.permission
// reflects that permanently and the banner stays hidden from then on.
function updateNotificationRequestBanner() {
  if (!notificationRequestBanner) return;
  if (!pushSupported() || Notification.permission !== 'default') {
    notificationRequestBanner.classList.add('hidden');
    return;
  }
  notificationRequestBanner.classList.remove('hidden');
}

// Admin/Abigail: broadcast that lunch has arrived
async function handleFoodArrived() {
  const confirmed = await confirmDialog(
    "Notify everyone that lunch has arrived? This shows an in-app banner to anyone on the page and sends a push notification to anyone who's enabled them."
  );
  if (!confirmed) return;

  foodArrivedStatus.className = 'status-msg-inline';
  foodArrivedStatus.textContent = 'Notifying everyone...';

  try {
    await apiCall('/api/food-arrived', 'POST');
    foodArrivedStatus.className = 'status-msg-inline success';
    foodArrivedStatus.style.color = 'var(--status-in-office)';
    foodArrivedStatus.textContent = 'Everyone has been notified!';
    await fetchDailyState();
  } catch (err) {
    foodArrivedStatus.className = 'status-msg-inline error-text';
    foodArrivedStatus.textContent = err.message || 'Failed to notify the team.';
  }
}

let editingScheduledId = null;

function updateNotifyScheduleUI() {
  const when = document.querySelector('input[name="notify-when"]:checked')?.value || 'now';
  const repeat = document.querySelector('input[name="notify-repeat"]:checked')?.value || 'once';
  const isLater = when === 'later';
  const isRepeating = isLater && repeat !== 'once';

  notifyRepeatGroup.classList.toggle('hidden', !isLater);
  notifyScheduleOnceGroup.classList.toggle('hidden', !isLater || isRepeating);
  notifyScheduleRepeatGroup.classList.toggle('hidden', !isRepeating);

  // Choosing "Send now" while editing a scheduled item doesn't map onto
  // anything the edit endpoint can do — treat it as abandoning the edit
  // and falling back to composing a fresh immediate send.
  if (editingScheduledId && !isLater) {
    cancelEditScheduledNotification();
    return;
  }

  btnSendNotificationLabel.textContent = editingScheduledId ? 'Update' : (isLater ? 'Schedule' : 'Send');
}

function startEditScheduledNotification(n) {
  editingScheduledId = n.id;
  notifyEditingBanner.classList.remove('hidden');

  notifyTitle.value = n.title;
  notifyBody.value = n.body;
  document.querySelector(`input[name="notify-target"][value="${n.target}"]`).checked = true;
  document.querySelector('input[name="notify-when"][value="later"]').checked = true;

  if (n.repeat) {
    document.querySelector(`input[name="notify-repeat"][value="${n.repeat.type}"]`).checked = true;
    notifyScheduleRepeatTime.value = n.repeat.time;
    notifyScheduleTime.value = '';
  } else {
    document.querySelector('input[name="notify-repeat"][value="once"]').checked = true;
    // datetime-local wants local time with no timezone/seconds
    const d = new Date(n.sendAt);
    const pad = (x) => String(x).padStart(2, '0');
    notifyScheduleTime.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  updateNotifyScheduleUI();
  notifyStatus.className = 'status-msg-inline';
  notifyStatus.textContent = '';
  notifyTitle.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditScheduledNotification() {
  editingScheduledId = null;
  notifyEditingBanner.classList.add('hidden');
  notifyTitle.value = '';
  notifyBody.value = '';
  notifyScheduleTime.value = '';
  notifyScheduleRepeatTime.value = '';
  document.querySelector('input[name="notify-target"][value="all"]').checked = true;
  document.querySelector('input[name="notify-when"][value="now"]').checked = true;
  document.querySelector('input[name="notify-repeat"][value="once"]').checked = true;
  updateNotifyScheduleUI();
}

async function handleSendNotification() {
  const title = notifyTitle.value.trim();
  const body = notifyBody.value.trim();
  const target = document.querySelector('input[name="notify-target"]:checked')?.value || 'all';
  const when = document.querySelector('input[name="notify-when"]:checked')?.value || 'now';
  const repeat = document.querySelector('input[name="notify-repeat"]:checked')?.value || 'once';

  if (!title || !body) {
    notifyStatus.className = 'status-msg-inline error-text';
    notifyStatus.textContent = 'Title and message are both required.';
    return;
  }

  const targetLabel = target === 'pending' ? "everyone who hasn't ordered yet" : 'everyone';

  if (when === 'later') {
    const payload = { title, body, target };

    if (repeat === 'once') {
      if (!notifyScheduleTime.value) {
        notifyStatus.className = 'status-msg-inline error-text';
        notifyStatus.textContent = 'Pick a date and time to send at.';
        return;
      }
      const sendAt = new Date(notifyScheduleTime.value).getTime();
      if (!Number.isFinite(sendAt) || sendAt <= Date.now()) {
        notifyStatus.className = 'status-msg-inline error-text';
        notifyStatus.textContent = 'Scheduled time must be in the future.';
        return;
      }
      payload.sendAt = sendAt;
    } else {
      if (!notifyScheduleRepeatTime.value) {
        notifyStatus.className = 'status-msg-inline error-text';
        notifyStatus.textContent = 'Pick a time of day to send at.';
        return;
      }
      payload.repeat = { type: repeat, time: notifyScheduleRepeatTime.value };
    }

    const whenLabel = repeat === 'once' ? '' : repeat === 'daily' ? ' every day' : ' on weekdays';
    const isEditing = !!editingScheduledId;
    const confirmed = await confirmDialog(
      `${isEditing ? 'Update this scheduled' : 'Schedule this'} notification${whenLabel} for ${targetLabel}?`
    );
    if (!confirmed) return;

    notifyStatus.className = 'status-msg-inline';
    notifyStatus.textContent = isEditing ? 'Updating...' : 'Scheduling...';

    try {
      if (isEditing) {
        await apiCall(`/api/notifications/scheduled/${editingScheduledId}`, 'PUT', payload);
      } else {
        await apiCall('/api/notifications/schedule', 'POST', payload);
      }
      notifyStatus.className = 'status-msg-inline success';
      notifyStatus.style.color = 'var(--status-in-office)';
      notifyStatus.textContent = isEditing ? 'Notification updated!' : 'Notification scheduled!';
      cancelEditScheduledNotification();
      await loadScheduledNotifications();
    } catch (err) {
      notifyStatus.className = 'status-msg-inline error-text';
      notifyStatus.textContent = err.message || 'Failed to save notification.';
    }
    return;
  }

  const confirmed = await confirmDialog(`Send this notification to ${targetLabel}?`);
  if (!confirmed) return;

  notifyStatus.className = 'status-msg-inline';
  notifyStatus.textContent = 'Sending...';

  try {
    const { result } = await apiCall('/api/notifications/send', 'POST', { title, body, target });
    notifyStatus.className = 'status-msg-inline success';
    notifyStatus.style.color = 'var(--status-in-office)';
    notifyStatus.textContent = result.attempted === 0
      ? 'No one has notifications enabled yet.'
      : `Sent to ${result.sent}/${result.attempted} device(s).`;
    notifyTitle.value = '';
    notifyBody.value = '';
    await loadNotificationHistory();
  } catch (err) {
    notifyStatus.className = 'status-msg-inline error-text';
    notifyStatus.textContent = err.message || 'Failed to send notification.';
  }
}

async function loadScheduledNotifications() {
  try {
    const notifications = await apiCall('/api/notifications/scheduled');
    renderScheduledNotifications(notifications);
  } catch (err) {
    console.error('Error loading scheduled notifications:', err);
  }
}

function renderScheduledNotifications(notifications) {
  notifyScheduledList.innerHTML = '';
  notifyScheduledEmpty.classList.toggle('hidden', notifications.length > 0);

  notifications.forEach(n => {
    const row = document.createElement('div');
    row.className = 'notify-scheduled-row';
    const when = new Date(n.sendAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const targetLabel = n.target === 'pending' ? 'Pending only' : 'Everyone';
    const repeatLabel = n.repeat
      ? ` · Repeats ${n.repeat.type === 'weekdays' ? 'weekdays' : 'daily'} at ${n.repeat.time}`
      : '';
    row.innerHTML = `
      <div class="notify-scheduled-row-info">
        <strong>${escapeHtml(n.title)}</strong>
        <span class="help-text">Next: ${when} · ${targetLabel}${repeatLabel}</span>
      </div>
      <div class="notify-scheduled-row-actions">
        <button type="button" class="btn btn-secondary btn-sm">Edit</button>
        <button type="button" class="btn btn-danger btn-sm">Cancel</button>
      </div>
    `;
    row.querySelector('.btn-secondary').addEventListener('click', () => startEditScheduledNotification(n));
    row.querySelector('.btn-danger').addEventListener('click', () => handleCancelScheduledNotification(n.id));
    notifyScheduledList.appendChild(row);
  });
}

async function handleCancelScheduledNotification(id) {
  const confirmed = await confirmDialog('Cancel this scheduled notification?');
  if (!confirmed) return;
  try {
    await apiCall(`/api/notifications/scheduled/${id}`, 'DELETE');
    await loadScheduledNotifications();
  } catch (err) {
    showAlert(err.message || 'Failed to cancel scheduled notification.');
  }
}

// --- Auto-reminder checkpoints ---

let checkpoints = [];

async function loadCheckpoints() {
  try {
    const settings = await apiCall('/api/settings/notifications');
    checkpoints = settings.autoReminderCheckpoints;
    renderCheckpoints();
  } catch (err) {
    console.error('Error loading auto-reminder checkpoints:', err);
  }
}

function renderCheckpoints() {
  checkpointList.innerHTML = '';
  checkpoints.forEach((cp, index) => {
    const row = document.createElement('div');
    row.className = 'checkpoint-row';
    row.innerHTML = `
      <input type="number" class="checkpoint-minutes-input" min="1" max="720" value="${cp.minutesBefore}">
      <span class="help-text">min before cutoff</span>
      <label class="switch">
        <input type="checkbox" class="checkpoint-enabled-input" ${cp.enabled ? 'checked' : ''}>
        <span class="slider round"></span>
      </label>
      <button type="button" class="btn btn-icon checkpoint-remove-btn" title="Remove">
        <span class="material-symbols-outlined">delete</span>
      </button>
    `;
    row.querySelector('.checkpoint-minutes-input').addEventListener('input', (e) => {
      checkpoints[index].minutesBefore = parseInt(e.target.value, 10) || 1;
    });
    row.querySelector('.checkpoint-enabled-input').addEventListener('change', (e) => {
      checkpoints[index].enabled = e.target.checked;
    });
    row.querySelector('.checkpoint-remove-btn').addEventListener('click', () => {
      checkpoints.splice(index, 1);
      renderCheckpoints();
    });
    checkpointList.appendChild(row);
  });
}

function handleAddCheckpoint() {
  if (checkpoints.length >= 5) {
    checkpointStatus.className = 'status-msg-inline error-text';
    checkpointStatus.textContent = 'You can configure at most 5 checkpoints.';
    return;
  }
  checkpoints.push({ minutesBefore: 15, enabled: true });
  renderCheckpoints();
}

async function handleSaveCheckpoints() {
  checkpointStatus.className = 'status-msg-inline';
  checkpointStatus.textContent = 'Saving...';
  try {
    const settings = await apiCall('/api/settings/notifications', 'PUT', { autoReminderCheckpoints: checkpoints });
    checkpoints = settings.autoReminderCheckpoints;
    renderCheckpoints();
    checkpointStatus.className = 'status-msg-inline success';
    checkpointStatus.style.color = 'var(--status-in-office)';
    checkpointStatus.textContent = 'Saved!';
  } catch (err) {
    checkpointStatus.className = 'status-msg-inline error-text';
    checkpointStatus.textContent = err.message || 'Failed to save checkpoints.';
  }
}

// --- Notification history ---

const NOTIFY_TYPE_LABELS = {
  'custom': 'Custom',
  'scheduled': 'Scheduled',
  'food-arrived': "Food's In",
  'reminder-manual': 'Reminder',
  'reminder-auto': 'Auto Reminder'
};

async function loadNotificationHistory() {
  try {
    const history = await apiCall('/api/notifications/history');
    renderNotificationHistory(history);
  } catch (err) {
    console.error('Error loading notification history:', err);
  }
}

function renderNotificationHistory(history) {
  notifyHistoryList.innerHTML = '';
  if (history.length === 0) {
    notifyHistoryList.innerHTML = '<p class="help-text">Nothing sent yet.</p>';
    return;
  }
  history.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'notify-history-row';
    const when = new Date(entry.sentAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const typeLabel = NOTIFY_TYPE_LABELS[entry.type] || entry.type;
    const by = entry.sentBy ? `by ${escapeHtml(entry.sentBy)}` : 'automatic';
    const delivery = entry.result ? `${entry.result.sent}/${entry.result.attempted} delivered` : '';
    row.innerHTML = `
      <strong>${escapeHtml(entry.title)}</strong>
      <span class="help-text">${escapeHtml(entry.body)}</span>
      <span class="help-text"><span class="notify-history-type-badge">${escapeHtml(typeLabel)}</span> ${when} · ${by} · ${delivery}</span>
    `;
    notifyHistoryList.appendChild(row);
  });
}

function updateHeaderDisplay() {
  if (!dailyState) return;
  displayDate.textContent = formatDate(dailyState.date);
  displayCutoff.textContent = formatTime12h(dailyState.effectiveCutoffTime || dailyState.cutoffTime);
}

// Computes remaining time and updates countdown banner styling/text
// Shows the "Lunch Buddy is Closed" panel instead of the countdown/order
// form/confirmation card on days the admin hasn't marked as operational.
// Returns true when closed, so callers can bail out of their own rendering.
function applyClosedDayState() {
  const closed = dailyState && dailyState.isOperationalToday === false;
  closedDayPanel.classList.toggle('hidden', !closed);
  countdownBanner.classList.toggle('hidden', closed);
  if (closed) {
    closedDayNextLabel.textContent = dailyState.nextOperationalDayName || 'the next operational day';
    orderFormCard.classList.add('hidden');
    confirmationCard.classList.add('hidden');
    reminderBanner.classList.add('hidden');
    foodArrivedBanner.classList.add('hidden');
    menuPromoBanner.classList.add('hidden');
  } else {
    menuPromoBanner.classList.remove('hidden');
  }
  return closed;
}

// --- Order mode: "Order for today" vs. "Plan my week" ---

function setOrderMode(mode) {
  orderMode = mode === 'week' ? 'week' : 'today';
  localStorage.setItem('lunchsync_order_mode', orderMode);
  orderModeToggle.querySelectorAll('.order-mode-btn').forEach(btn => {
    const active = btn.dataset.mode === orderMode;
    btn.classList.toggle('selected', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  applyOrderModeVisibility();
  if (orderMode === 'week') {
    // Skip the network round-trip if we already fetched recently (e.g. the
    // user is just toggling back and forth) — re-render instantly from the
    // cached data instead of re-waiting on the same slow query every time.
    if (weekPlan && Date.now() - weekPlanFetchedAt < 8000) {
      renderWeeklyPlan();
    } else {
      fetchWeekPlan();
    }
  }
}

// Single source of truth for which of the today-mode panels vs. the weekly
// planner card are visible. Must run after renderFoodOrderForm() and
// applyClosedDayState(), since both of those also toggle these same
// elements — week mode simply wins and hides all of it, showing the planner
// instead (today's own status is already visible as a card within the week
// grid, so there's no need to also show the closed/countdown banners).
function applyOrderModeVisibility() {
  const week = orderMode === 'week';
  weeklyPlanCard.classList.toggle('hidden', !week);
  if (week) {
    closedDayPanel.classList.add('hidden');
    countdownBanner.classList.add('hidden');
    orderFormCard.classList.add('hidden');
    confirmationCard.classList.add('hidden');
    reminderBanner.classList.add('hidden');
    foodArrivedBanner.classList.add('hidden');
    menuPromoBanner.classList.add('hidden');
  }
}

async function fetchWeekPlan() {
  // Only show a loading placeholder on the very first load — on subsequent
  // 10s polls, the existing cards should just stay put until fresh data
  // arrives, not flash to a loading state every time.
  if (!weekPlan) {
    weekGrid.innerHTML = '<p class="week-grid-loading">Loading your week…</p>';
  }
  try {
    weekPlan = await apiCall('/api/week-plan');
    weekPlanFetchedAt = Date.now();
    weeklyPlanStatus.textContent = '';
    weeklyPlanStatus.className = 'status-msg-inline';
    renderWeeklyPlan();
  } catch (err) {
    weeklyPlanStatus.className = 'status-msg-inline error-text';
    weeklyPlanStatus.textContent = err.message || 'Failed to load your weekly plan.';
  }
}

function renderWeeklyPlan() {
  if (!weekPlan) return;

  if (!weekPlan.menuPublished) {
    weeklyMenuStatusMsg.classList.remove('hidden');
    weekGrid.classList.add('hidden');
    return;
  }
  weeklyMenuStatusMsg.classList.add('hidden');
  weekGrid.classList.remove('hidden');
  weekGrid.querySelector('.week-grid-loading')?.remove();

  weekPlan.days.forEach(day => {
    if (weekPlanDirtyDates.has(day.date)) return; // in-flight edit — leave it alone

    let card = weekGrid.querySelector(`.week-day-card[data-date="${day.date}"]`);
    // A dropdown open on this card (e.g. a phone's native picker) closes if
    // the card is rebuilt under it — skip it this poll.
    if (card?.contains(document.activeElement)) return;
    const isNew = !card;
    if (isNew) {
      card = document.createElement('div');
      card.className = 'week-day-card';
      card.dataset.date = day.date;
      weekGrid.appendChild(card);
    }

    card.className = 'week-day-card' +
      (day.isToday ? ' today' : '') +
      (day.isLocked ? ' locked' : '') +
      (!day.isOperational ? ' closed' : '') +
      (!day.dishName ? ' skipped' : '');

    const shortDate = new Date(day.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const badge = day.isLocked ? (day.isPast ? 'Past' : 'Locked') : (!day.isOperational ? 'Closed' : (day.isToday ? 'Today' : ''));
    const disabled = !day.editable ? 'disabled' : '';

    // Each day offers its own menu — dishes with repeat days only show up
    // on the days they repeat.
    let dayMenu = day.menu || weekPlan.menu || [];
    // Never show "Skipped" for a day that has a dish just because that dish
    // isn't in the menu list we have for it (e.g. it was removed later).
    if (day.dishName && !dayMenu.some(item => item.name === day.dishName)) {
      dayMenu = [{ name: day.dishName, variantOptions: [] }, ...dayMenu];
    }
    const optionsHtml = ['<option value="">Skipped</option>']
      .concat(dayMenu.map(item =>
        `<option value="${escapeHtml(item.name)}" ${item.name === day.dishName ? 'selected' : ''}>${escapeHtml(item.name)}</option>`
      )).join('');

    // A dish with variants (e.g. Fufu's soup type) needs a second select
    // before the day counts as fully picked — hidden entirely for dishes
    // that don't have any configured.
    const matchedMenuItem = dayMenu.find(item => item.name === day.dishName);
    const dayVariantOptions = matchedMenuItem?.variantOptions || [];
    const variantHtml = dayVariantOptions.length > 0
      ? `<select class="week-day-variant" aria-label="${escapeHtml(matchedMenuItem.variantLabel)} for ${escapeHtml(day.dayName)}" title="${escapeHtml(day.variant || '')}" ${disabled}>
          <option value="">Select ${escapeHtml(matchedMenuItem.variantLabel)}…</option>
          ${dayVariantOptions.map(o => `<option value="${escapeHtml(o)}" ${o === day.variant ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
        </select>`
      : `<select class="week-day-variant hidden"></select>`;

    card.innerHTML = `
      <div class="week-day-head">
        <span class="week-day-name">${escapeHtml(day.dayName)}</span>
        <span class="week-day-date">${escapeHtml(shortDate)}</span>
        ${badge ? `<span class="week-day-badge">${escapeHtml(badge)}</span>` : ''}
      </div>
      ${weekDayStatusHtml(day)}
      <div class="week-day-thumb">${day.dishName
        ? `<img src="${getDishImage(day)}" alt="" loading="lazy">`
        : '<span class="material-symbols-outlined week-day-thumb-empty">no_meals</span>'}</div>
      <select class="week-day-select" aria-label="Dish for ${escapeHtml(day.dayName)}" ${disabled}>${optionsHtml}</select>
      ${variantHtml}
      <input type="text" class="week-day-note" maxlength="140" placeholder="Note (optional)" value="${escapeHtml(day.note || '')}" ${disabled}>
      ${(day.editable && day.dishName && dayVariantOptions.length === 0) ? `
        <button type="button" class="btn btn-secondary btn-sm week-day-repeat">
          <span class="material-symbols-outlined">repeat</span>
          <span>Use for rest of week</span>
        </button>
      ` : ''}
    `;
  });
}

// One line under each day's header saying where that day stands, so a pick
// is visibly confirmed on the card itself rather than only in a status
// message at the top of the section.
function weekDayStatusHtml(day) {
  let kind = 'muted';
  let text;
  if (!day.isOperational) {
    text = 'Closed';
  } else if (day.source === 'order') {
    kind = 'ok';
    text = day.served ? '✓ Served' : (day.isToday ? '✓ Ordered for today' : '✓ Ordered');
  } else if (day.source === 'plan') {
    kind = day.dishStillOnMenu === false ? 'warn' : 'ok';
    text = day.dishStillOnMenu === false
      ? 'Planned dish isn\'t on this day\'s menu'
      : `✓ Planned — orders automatically on ${day.dayName}`;
  } else {
    text = day.isPast ? 'No order' : (day.isLocked ? 'No order — locked' : 'Not planned yet');
  }
  return `<div class="week-day-status ${kind}">${escapeHtml(text)}</div>`;
}

// Temporary status on one card (saving, waiting on a variant) — replaced by
// weekDayStatusHtml's permanent status the next time the card re-renders.
function setWeekCardStatus(date, text, kind = 'muted') {
  const el = weekGrid.querySelector(`.week-day-card[data-date="${date}"] .week-day-status`);
  if (!el) return;
  el.className = `week-day-status ${kind}`;
  el.textContent = text;
}

// Briefly highlights a card after a successful save.
function flashWeekCardSaved(date) {
  const card = weekGrid.querySelector(`.week-day-card[data-date="${date}"]`);
  if (!card) return;
  card.classList.add('just-saved');
  setTimeout(() => card.classList.remove('just-saved'), 1500);
}

async function handleWeekDishChange(date, dishName) {
  weekPlanDirtyDates.add(date);

  // A dish with variants (soup type, sauce, etc.) can't be saved yet — show
  // the picker and wait for handleWeekVariantChange instead of PUTing with
  // no variant, which the server would reject.
  const card = weekGrid.querySelector(`.week-day-card[data-date="${date}"]`);
  const variantSelect = card?.querySelector('.week-day-variant');
  const dayMenu = weekPlan?.days.find(d => d.date === date)?.menu || weekPlan?.menu || [];
  const matched = dayMenu.find(item => item.name === dishName);
  const options = matched?.variantOptions || [];
  if (dishName && options.length > 0 && variantSelect) {
    variantSelect.classList.remove('hidden');
    variantSelect.disabled = false;
    variantSelect.innerHTML = `<option value="">Select ${escapeHtml(matched.variantLabel)}…</option>`
      + options.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
    variantSelect.focus();
    setWeekCardStatus(date, `Choose a ${matched.variantLabel || 'option'} to save`, 'warn');
    return;
  }
  if (variantSelect) {
    variantSelect.classList.add('hidden');
    variantSelect.value = '';
  }

  setWeekCardStatus(date, 'Saving…');
  try {
    const res = dishName
      ? await apiCall(`/api/week-plan/${date}`, 'PUT', { dishName, variant: '' })
      : await apiCall(`/api/week-plan/${date}`, 'DELETE');
    patchWeekDay(res.day);
    flashWeekCardSaved(date);
    weeklyPlanStatus.className = 'status-msg-inline success';
    weeklyPlanStatus.textContent = 'Saved!';
    if (date === weekPlan?.businessDate) await fetchDailyState();
  } catch (err) {
    weekPlanDirtyDates.delete(date);
    weeklyPlanStatus.className = 'status-msg-inline error-text';
    weeklyPlanStatus.textContent = err.message || 'Failed to save.';
    renderWeeklyPlan(); // revert the select back to the last known-good state
  }
}

// Fires once a variant is picked for a dish that needs one — the dish
// change itself was held back (see handleWeekDishChange) until this completes.
async function handleWeekVariantChange(date, dishName, variant) {
  if (!variant) return;
  weekPlanDirtyDates.add(date);
  setWeekCardStatus(date, 'Saving…');
  try {
    const res = await apiCall(`/api/week-plan/${date}`, 'PUT', { dishName, variant });
    patchWeekDay(res.day);
    flashWeekCardSaved(date);
    weeklyPlanStatus.className = 'status-msg-inline success';
    weeklyPlanStatus.textContent = 'Saved!';
    if (date === weekPlan?.businessDate) await fetchDailyState();
  } catch (err) {
    weekPlanDirtyDates.delete(date);
    weeklyPlanStatus.className = 'status-msg-inline error-text';
    weeklyPlanStatus.textContent = err.message || 'Failed to save.';
    renderWeeklyPlan();
  }
}

async function handleWeekNoteCommit(date, note) {
  const day = weekPlan?.days.find(d => d.date === date);
  if (!day || !day.dishName) { weekPlanDirtyDates.delete(date); return; } // nothing to attach a note to
  try {
    const res = await apiCall(`/api/week-plan/${date}`, 'PUT', { dishName: day.dishName, note, variant: day.variant || '' });
    patchWeekDay(res.day);
    flashWeekCardSaved(date);
    if (date === weekPlan?.businessDate) await fetchDailyState();
  } catch (err) {
    weekPlanDirtyDates.delete(date);
    weeklyPlanStatus.className = 'status-msg-inline error-text';
    weeklyPlanStatus.textContent = err.message || 'Failed to save note.';
    renderWeeklyPlan();
  }
}

async function handleRepeatRestOfWeek(date, dishName) {
  if (!(await confirmDialog(`Use ${dishName} for the rest of the week?`))) return;
  try {
    const result = await apiCall('/api/week-plan/repeat', 'POST', { dishName, fromDate: date });
    await fetchWeekPlan();
    await fetchDailyState();
    const parts = [];
    if (result.appliedDates?.length) parts.push(`${dishName} set for ${result.appliedDates.length} day(s).`);
    if (result.skippedDates?.length) {
      const reasons = result.skippedDates.map(s => `${s.date} (${s.reason.replace(/-/g, ' ')})`).join(', ');
      parts.push(`Skipped: ${reasons}.`);
    }
    weeklyPlanStatus.className = 'status-msg-inline success';
    weeklyPlanStatus.textContent = parts.join(' ') || 'Done.';
  } catch (err) {
    weeklyPlanStatus.className = 'status-msg-inline error-text';
    weeklyPlanStatus.textContent = err.message || 'Failed to repeat selection.';
  }
}

// Merges a single updated day (returned by PUT/DELETE) into the cached
// weekPlan and re-renders just that card, avoiding a full refetch/flicker.
function patchWeekDay(day) {
  if (!weekPlan || !day) return;
  weekPlanDirtyDates.delete(day.date);
  const idx = weekPlan.days.findIndex(d => d.date === day.date);
  if (idx !== -1) weekPlan.days[idx] = { ...weekPlan.days[idx], ...day };
  renderWeeklyPlan();
}

function updateCountdownBanner() {
  if (!dailyState) return;
  if (applyClosedDayState()) return;

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
    countdownText.innerHTML = `<span class="countdown-line1">Orders are currently open.</span><span class="countdown-line2">Time remaining until cutoff:<strong>${timeString}</strong></span>`;
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

// A friendly, time-of-day-aware greeting for the Order Lunch page — mirrors
// the "Good afternoon, Name" pattern from Claude's own web app.
function updateOrderGreeting() {
  if (!currentUser) return;

  const hour = new Date().getHours();
  const timeGreeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = currentUser.name.split(' ')[0];
  orderGreetingText.textContent = `${timeGreeting}, ${firstName}`;

  const userOrder = dailyState?.orders?.ordered?.find(o => o.userId === currentUser.id);
  if (dailyState?.isOperationalToday === false) {
    orderGreetingSubtext.textContent = "Lunch Buddy isn't taking orders today.";
  } else if (dailyState?.isLocked && !userOrder) {
    orderGreetingSubtext.textContent = "Cutoff's passed and you didn't get an order in today.";
  } else if (userOrder) {
    orderGreetingSubtext.textContent = `You're set for today — ${userOrder.itemName}.`;
  } else {
    orderGreetingSubtext.textContent = "Let's get your lunch sorted for today.";
  }
}

// Rebuilds the variant <select>'s options for whichever dish is currently
// selected, and shows/hides the whole section. Deliberately does NOT touch
// .value itself — callers decide what the post-rebuild value should be
// (preserved across polls, prefilled from a saved order, or reset to blank
// on a fresh dish pick), same division of responsibility as orderNoteInput.
function updateOrderVariantOptions(item) {
  const options = Array.isArray(item?.variantOptions) ? item.variantOptions : [];
  // Skip the rebuild when this dish's options are already showing. The form
  // re-renders every ~10s poll, and rewriting the options closes a picker
  // the user has open on a phone and resets what they'd chosen.
  const key = item ? `${item.id}|${options.join('\u0001')}` : '';
  if (orderVariantSelect.dataset.optionsKey === key) return;
  orderVariantSelect.dataset.optionsKey = key;
  if (options.length === 0) {
    orderVariantSection.classList.add('hidden');
    orderVariantSelect.required = false;
    orderVariantSelect.innerHTML = '<option value="">Select…</option>';
    return;
  }
  orderVariantSection.classList.remove('hidden');
  orderVariantSelect.required = true;
  orderVariantLabel.textContent = `Choose a ${item.variantLabel}`;
  orderVariantSelect.innerHTML = '<option value="">Select…</option>'
    + options.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
}

function renderFoodOrderForm() {
  if (!dailyState) return;
  if (dailyState.isOperationalToday === false) return;

  // Find logged in user's current selection, if any
  const userOrder = dailyState.orders.ordered.find(o => o.userId === currentUser.id);

  // Once a selection is saved, show the read-only confirmation with a
  // "Change Selection" button instead of the open form, until the user
  // explicitly asks to edit (or the cutoff forces a locked view either way).
  const showForm = !userOrder || isEditingOrder;

  orderFormCard.classList.toggle('hidden', !showForm);

  if (userOrder) {
    confirmationCard.classList.remove('hidden');
    const variantText = userOrder.variant ? ` (${escapeHtml(userOrder.variant)})` : '';
    const noteText = userOrder.note
      ? `<br><span class="text-muted">Note: ${escapeHtml(userOrder.note)}</span>`
      : '';
    confirmationText.innerHTML = `Selected dish: <strong>${escapeHtml(userOrder.itemName)}${variantText}</strong>${noteText}`;
    btnChangeOrder.classList.toggle('hidden', showForm || dailyState.isLocked);
    btnCancelOrder.classList.toggle('hidden', showForm || dailyState.isLocked || userOrder.served);

    const matchedMenuItem = dailyState.menu.find(m => m.id === userOrder.itemId);
    const dishImage = getDishImage(matchedMenuItem || { name: userOrder.itemName });
    if (confThumbImg) confThumbImg.src = dishImage;
    if (orderHeroArtImg) orderHeroArtImg.src = dishImage;
  } else {
    confirmationCard.classList.add('hidden');
    if (orderHeroArtImg) orderHeroArtImg.src = DEFAULT_DISH_IMAGE;
  }

  if (!showForm) return;

  // This form re-renders on every poll (~10s). If the user has already
  // clicked a dish or started typing a note, treat that as source of truth
  // instead of clobbering it with the last-saved server state.
  const preservedSelection = orderFormDirty
    ? orderForm.querySelector('input[name="lunch-selection"]:checked')?.value
    : null;
  orderNoteInput.value = orderFormDirty ? orderNoteInput.value : (userOrder?.note || '');

  const priorVariantValue = orderVariantSelect.value;
  const selectedItemId = preservedSelection || userOrder?.itemId || null;
  const selectedItem = selectedItemId ? dailyState.menu.find(m => m.id === selectedItemId) : null;
  updateOrderVariantOptions(selectedItem);
  orderVariantSelect.value = orderFormDirty ? priorVariantValue : (userOrder?.variant || '');

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

    const isChecked = preservedSelection
      ? item.id === preservedSelection
      : (userOrder && userOrder.itemId === item.id);

    card.innerHTML = `
      <input type="radio" name="lunch-selection" value="${item.id}" ${isChecked ? 'checked' : ''} required>
      <div class="menu-card-inner">
        <div class="menu-card-image-wrap">
          <img src="${getDishImage(item)}" class="menu-card-image" alt="" loading="lazy">
        </div>
        <div class="menu-card-body">
          <div class="menu-card-header">
            <span class="menu-card-title">${escapeHtml(item.name)}</span>
          </div>
          <p class="menu-card-desc">${escapeHtml(item.description)}</p>
        </div>
      </div>
    `;
    if (isChecked) card.classList.add('selected');

    // Click handler to select, add highlight class, and preview the dish
    // photo in the hero panel even before the selection is submitted.
    card.addEventListener('click', () => {
      if (!dailyState.isLocked) {
        orderFormDirty = true;
        document.querySelectorAll('.menu-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        if (orderHeroArtImg) orderHeroArtImg.src = getDishImage(item);
        // Switching dishes clears any variant pick from the dish just
        // deselected — a soup type chosen for Fufu has no meaning for Jollof.
        // Tapping the already-selected dish again keeps the pick.
        const keyBefore = orderVariantSelect.dataset.optionsKey;
        updateOrderVariantOptions(item);
        if (orderVariantSelect.dataset.optionsKey !== keyBefore) orderVariantSelect.value = '';
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

  if (!orderVariantSection.classList.contains('hidden') && !orderVariantSelect.value) {
    orderSubmitStatus.className = 'status-indicator error';
    orderSubmitStatus.textContent = `${orderVariantLabel.textContent} is required.`;
    return;
  }

  try {
    await apiCall('/api/order', 'POST', { itemId: dish, note: orderNoteInput.value.trim(), variant: orderVariantSelect.value });
    orderSubmitStatus.className = 'status-indicator success';
    orderSubmitStatus.textContent = 'Selection submitted!';
    isEditingOrder = false;
    orderFormDirty = false;

    // Refresh state and UI
    await fetchDailyState();
  } catch (err) {
    orderSubmitStatus.className = 'status-indicator error';
    orderSubmitStatus.textContent = err.message || 'Failed to submit selection.';
  }
}

async function handleCancelOrder() {
  if (!(await confirmDialog('Cancel your lunch order for today?', { danger: true }))) return;

  try {
    await apiCall('/api/order', 'DELETE');
    await fetchDailyState();
  } catch (err) {
    showAlert(err.message || 'Failed to cancel order.');
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
      const variantsHtml = (dish.variants || []).length > 0
        ? `<div class="dish-total-variants">${dish.variants.map(v => `<span>${escapeHtml(v.label)}: ${v.count}</span>`).join('')}</div>`
        : '';
      card.innerHTML = `
        <span class="material-symbols-outlined">restaurant</span>
        <span class="dish-total-count">${dish.count}</span>
        <span class="dish-total-name">${escapeHtml(dish.name)}</span>
        ${variantsHtml}
      `;
      summaryDishTotals.appendChild(card);
    });
  }

  // Render Detailed Roster Breakdown (Searchable)
  renderDetailedBreakdownList();
}

function renderDetailedBreakdownList() {
  if (!dailyState) return;

  // This runs on every ~10s auto-refresh poll, which would otherwise wipe
  // an admin's in-progress dish pick / note in the unconfirmed list mid-
  // keystroke. Snapshot each row's state (and which field has focus) before
  // rebuilding, then restore it below.
  const pendingEdits = new Map();
  summaryUnconfirmed.querySelectorAll('.unconfirmed-row').forEach(row => {
    const select = row.querySelector('.assign-dish-select');
    const variantSelect = row.querySelector('.assign-variant-select');
    const noteInput = row.querySelector('.assign-note-input');
    if (select.value || variantSelect.value || noteInput.value) {
      pendingEdits.set(select.dataset.userId, {
        itemId: select.value,
        variant: variantSelect.value,
        note: noteInput.value,
        focused: document.activeElement === noteInput ? 'note' : (document.activeElement === select ? 'select' : null),
        selectionStart: noteInput.selectionStart
      });
    }
  });

  // If an admin is mid-pick in the Unconfirmed list (a dropdown open on a
  // phone, or typing a note), leave it alone this poll — rebuilding it
  // closes an open native picker. It refreshes on the next poll after they
  // move on.
  const keepUnconfirmed = summaryUnconfirmed.contains(document.activeElement);

  summaryGroups.innerHTML = '';
  if (!keepUnconfirmed) summaryUnconfirmed.innerHTML = '';

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

  // Safety net: anyone whose ordered dish name doesn't match a current menu
  // column (e.g. that dish was removed from today's menu after they
  // ordered it) still gets a column instead of silently disappearing from
  // the breakdown while still counting toward "Ordered" in the stats above.
  const coveredNames = new Set(columns.map(c => c.title));
  byDish.forEach((members, itemName) => {
    if (!coveredNames.has(itemName)) {
      columns.push({ title: itemName, members });
    }
  });

  if (columns.length === 0) {
    summaryGroups.innerHTML = '<div class="no-results">No dishes on today\'s menu yet.</div>';
  } else {
    summaryGroups.innerHTML = columns.map(col => {
      const rows = col.members.map(member => {
        const assignedTag = member.assignedBy
          ? `<span class="text-muted"> (added by ${escapeHtml(member.assignedBy)})</span>`
          : '';
        const variantTag = member.variant
          ? `<span class="text-muted"> — ${escapeHtml(member.variant)}</span>`
          : '';
        const noteRow = member.note
          ? `<div class="member-row-note">${escapeHtml(member.note)}</div>`
          : '';
        return `
          <div class="summary-member-row">
            <div class="member-row-main">
              <span>${escapeHtml(member.name)}${variantTag}${assignedTag}</span>
              <button type="button" class="btn btn-icon btn-remove-order" data-user-id="${member.userId}" data-user-name="${escapeHtml(member.name)}" title="Remove this order">
                <span class="material-symbols-outlined">close</span>
              </button>
            </div>
            ${noteRow}
          </div>
        `;
      }).join('') || '<div class="no-results">—</div>';

      return `
        <div class="breakdown-column">
          <div class="breakdown-column-title">${escapeHtml(col.title)} (${col.members.length})</div>
          <div class="breakdown-column-list">${rows}</div>
        </div>
      `;
    }).join('');

    summaryGroups.querySelectorAll('.btn-remove-order').forEach(btn => {
      btn.addEventListener('click', () => {
        removeMemberOrder(btn.dataset.userId, btn.dataset.userName);
      });
    });
  }

  // Unconfirmed members get their own grid, separate from the dish columns —
  // each person is its own grid item so they lay out in a multi-column grid
  // rather than one long single-column list.
  summaryUnconfirmedCount.textContent = pendingList.length === 0
    ? 'Everyone has placed an order.'
    : `${pendingList.length} team member${pendingList.length === 1 ? '' : 's'} haven't placed an order yet.`;

  if (keepUnconfirmed) return;

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
      <select class="assign-variant-select hidden" data-user-id="${member.userId}">
        <option value="">Select…</option>
      </select>
      <input type="text" class="assign-note-input" data-user-id="${member.userId}" placeholder="Note (optional)" maxlength="140" disabled>
      <button type="button" class="btn btn-sm btn-primary btn-assign-dish" data-user-id="${member.userId}" disabled>Assign</button>
    </div>
  `).join('');

  // Selecting a dish no longer submits right away — it only unlocks the note
  // field and the Assign button, so there's time to type a note first. If
  // the chosen dish has variants (e.g. Fufu's soup type), a second select
  // appears and the button/note stay locked until that's picked too.
  // Submitting (button click, or Enter in the note field) sends it all together.
  summaryUnconfirmed.querySelectorAll('.unconfirmed-row').forEach(row => {
    const userId = row.querySelector('.assign-dish-select').dataset.userId;
    const select = row.querySelector('.assign-dish-select');
    const variantSelect = row.querySelector('.assign-variant-select');
    const noteInput = row.querySelector('.assign-note-input');
    const button = row.querySelector('.btn-assign-dish');

    // Only rebuilt when the dish changes — rebuilding the options resets
    // the select, so doing it on the variant's own change event wiped the
    // pick the moment it was made and the Assign button never unlocked.
    const populateVariants = () => {
      const item = dailyState.menu.find(m => m.id === select.value);
      const options = item?.variantOptions || [];
      variantSelect.classList.toggle('hidden', options.length === 0);
      variantSelect.innerHTML = '<option value="">Select…</option>'
        + options.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
    };

    const refreshUnlockState = () => {
      const needsVariant = !variantSelect.classList.contains('hidden');
      const ready = !!select.value && (!needsVariant || !!variantSelect.value);
      noteInput.disabled = !ready;
      button.disabled = !ready;
    };

    select.addEventListener('change', () => {
      populateVariants();
      refreshUnlockState();
    });
    variantSelect.addEventListener('change', refreshUnlockState);

    const submit = () => {
      if (!select.value) return;
      assignDishToMember(userId, select.value, noteInput.value, variantSelect.value);
    };
    button.addEventListener('click', submit);
    noteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });

    const edit = pendingEdits.get(userId);
    if (edit) {
      select.value = edit.itemId;
      populateVariants();
      if (edit.variant) variantSelect.value = edit.variant;
      refreshUnlockState();
      noteInput.value = edit.note;
      if (edit.focused === 'note') {
        noteInput.focus();
        noteInput.setSelectionRange(edit.selectionStart, edit.selectionStart);
      } else if (edit.focused === 'select') {
        select.focus();
      }
    }
  });
}

// Admin/Abigail: manually place an order for someone who couldn't submit
// their own but let a coordinator know their choice ahead of time. `note`
// carries along anything the coordinator was told (protein choice,
// allergies, etc.) — same free-text note a self-serve order can carry.
async function assignDishToMember(userId, itemId, note = '', variant = '') {
  try {
    await apiCall('/api/order/assign', 'POST', { userId, itemId, note, variant });
    showExportFeedback('Order assigned!');
    await fetchDailyState();
  } catch (err) {
    showAlert(err.message || 'Failed to assign order.');
  }
}

// Admin/Abigail: remove a specific person's order (e.g. a mistaken selection)
async function removeMemberOrder(userId, userName) {
  if (!(await confirmDialog(`Remove ${userName}'s order? They'll go back to unconfirmed.`, { danger: true }))) return;

  try {
    await apiCall(`/api/order/${userId}`, 'DELETE');
    showExportFeedback('Order removed.');
    await fetchDailyState();
  } catch (err) {
    showAlert(err.message || 'Failed to remove order.');
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
      (d.variants || []).forEach(v => {
        text += `   - ${v.label}: ${v.count}\n`;
      });
    });
  }

  // Order metrics
  text += `\n*OVERVIEW:*\n`;
  text += `• Ordered: ${dailyState.stats.ordered} of ${dailyState.stats.total}\n`;

  // Per-person breakdown, grouped by dish — only people with a variant
  // choice (soup type, sauce, etc.) or a note are listed, since that's the
  // only detail the vendor actually needs beyond the dish quantities above.
  const orderedList = dailyState.orders.ordered || [];
  const withDetails = orderedList.filter(item => item.note || item.variant);
  if (withDetails.length > 0) {
    const byDish = new Map();
    withDetails.forEach(item => {
      if (!byDish.has(item.itemName)) byDish.set(item.itemName, []);
      byDish.get(item.itemName).push(item);
    });

    text += `\n*DETAILS:*\n`;
    byDish.forEach((members, dishName) => {
      text += `\n*${dishName}:*\n`;
      members.forEach(m => {
        const bits = [m.variant, m.note].filter(Boolean).join(' — ');
        text += `- ${m.name}${bits ? ` (${bits})` : ''}\n`;
      });
    });
  }

  navigator.clipboard.writeText(text)
    .then(() => showExportFeedback('Summary copied!'))
    .catch(err => {
      console.error('Failed to copy text:', err);
      showAlert('Could not copy automatically. You can copy it manually from the screen.');
    });
}

// Send a reminder to everyone who hasn't ordered yet
async function remindPendingMembers() {
  if (!dailyState) return;

  if (dailyState.stats.pending === 0) {
    showExportFeedback('No pending members to remind!');
    return;
  }

  if (!(await confirmDialog(`Send a reminder to ${dailyState.stats.pending} member(s) who haven't ordered yet?`))) {
    return;
  }

  btnRemindPending.disabled = true;

  try {
    const result = await apiCall('/api/reminders/send', 'POST', { bulk: true });
    showExportFeedback(result.message || 'Reminders sent!');
  } catch (err) {
    showAlert(err.message || 'Failed to send reminders.');
  } finally {
    btnRemindPending.disabled = false;
  }
}

// Admin: wipe today's orders so team members can make fresh selections
async function clearAllOrders() {
  if (!dailyState) return;

  const confirmed = await confirmDialog(
    `Clear ALL ${dailyState.stats.ordered} order(s) placed today? This cannot be undone — team members will need to select their dish again.`,
    { danger: true }
  );
  if (!confirmed) return;

  btnClearOrders.disabled = true;

  try {
    await apiCall('/api/order/clear-all', 'POST');
    showExportFeedback('Sheet cleared!');
    await fetchDailyState();
  } catch (err) {
    showAlert(err.message || 'Failed to clear orders.');
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
    byDish.get(item.itemName).push(item.variant ? `${item.name} (${item.variant})` : item.name);
  });

  const columns = dailyState.dishTotals
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(dish => ({
      title: `${dish.name} (${dish.count})`,
      names: (byDish.get(dish.name) || []).slice().sort((a, b) => a.localeCompare(b))
    }));

  // Safety net: don't silently drop anyone whose dish name doesn't match a
  // current menu column (e.g. removed from today's menu after they ordered).
  const coveredDishNames = new Set(dailyState.dishTotals.map(d => d.name));
  byDish.forEach((names, itemName) => {
    if (!coveredDishNames.has(itemName)) {
      columns.push({ title: `${itemName} (${names.length})`, names: names.slice().sort((a, b) => a.localeCompare(b)) });
    }
  });

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

async function loadAdminMenuBuilder() {
  if (!dailyState) return;

  adminMenuList.innerHTML = '';

  // Needed before rows render so each catalog dish's row can show which
  // weekdays it's already configured to recur on.
  await loadMenuTemplate();

  if (dailyState.menu.length === 0) {
    addDishInputRow(adminMenuList);
  } else {
    dailyState.menu.forEach(item => {
      if (item.catalogDishId) {
        addCatalogPickRow(adminMenuList, { id: item.catalogDishId, name: item.name, price: item.price, imageId: item.imageId }, item.id);
      } else {
        addDishInputRow(adminMenuList, item.id, item.name, item.description, item.price);
      }
    });
  }

  adminPublishToggle.checked = dailyState.menuPublished;
  loadCatalogPicker();
}

// If the list is a single, still-empty one-off placeholder row (the default
// state when today's menu is blank), clear it before adding a real pick —
// otherwise saveAdminMenu would reject the empty name.
function removeEmptyPlaceholderRow(container) {
  const rows = container.querySelectorAll('.admin-dish-row:not(.admin-dish-row-catalog)');
  if (rows.length === 1 && !rows[0].querySelector('.dish-name-input')?.value.trim()) {
    rows[0].remove();
  }
}

function addDishInputRow(container, id = '', name = '', description = '', price = null) {
  const div = document.createElement('div');
  div.className = 'admin-dish-row';
  div.dataset.id = id;

  div.innerHTML = `
    <input type="text" class="dish-name-input" placeholder="Dish Name (e.g. Sushi)" value="${escapeHtml(name)}" required>
    <input type="text" class="dish-desc-input" placeholder="Optional description" value="${escapeHtml(description)}">
    <input type="number" class="dish-price-input" placeholder="Price (optional)" min="0" step="0.01" value="${price != null ? price : ''}">
    ${id ? `
      <button type="button" class="btn btn-icon btn-migrate-to-catalog" title="Move to Dish Catalog so it can have an image, variants, and recurring days">
        <span class="material-symbols-outlined">move_up</span>
      </button>
    ` : ''}
    <button type="button" class="btn btn-icon btn-logout btn-delete-row" title="Delete Row">
      <span class="material-symbols-outlined">delete</span>
    </button>
  `;

  // Bind delete action
  div.querySelector('.btn-delete-row').addEventListener('click', () => {
    div.remove();
    if (container.children.length === 0) {
      addDishInputRow(container);
    }
  });

  // One of today's menu's old free-text entries (predates the Dish Catalog)
  // — lets an admin upgrade it into a real catalog dish with one click
  // instead of retyping it, so it can finally have an image/variants/
  // recurring days. We can't fabricate a photo for it ourselves; this just
  // gives it somewhere to receive one.
  div.querySelector('.btn-migrate-to-catalog')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const dishName = div.querySelector('.dish-name-input').value.trim();
    if (!dishName) {
      showAlert('Enter a dish name before moving it to the catalog.');
      return;
    }
    const dishDescription = div.querySelector('.dish-desc-input').value.trim();
    const priceVal = div.querySelector('.dish-price-input').value.trim();
    btn.disabled = true;
    try {
      const dish = await apiCall('/api/dishes', 'POST', {
        name: dishName,
        description: dishDescription,
        price: priceVal ? Number(priceVal) : null
      });
      catalogDishes.push(dish);
      renderOtherDishes();
      div.remove();
      addCatalogPickRow(container, dish);
      adminMenuStatus.className = 'status-msg-inline';
      adminMenuStatus.textContent = `"${dish.name}" moved to your catalog — open it to add a photo, then Save Menu Layout.`;
    } catch (err) {
      showAlert(err.message || 'Failed to move this dish to the catalog.');
      btn.disabled = false;
    }
  });

  container.appendChild(div);
}

// A "catalog pick" row: read-only (thumbnail/name/price sourced from the
// catalog dish, snapshotted onto the daily menu item at save time), with a
// recurring-weekday toggle, a variants shortcut, and a remove button —
// editing the underlying dish values happens in the Manage Catalog modal,
// not here.
// onTodaysMenu=false renders the same row for the "Other dishes" list (see
// renderOtherDishes): days and edit still work, but there's no remove
// button, since the dish isn't on today's menu to remove it from.
function addCatalogPickRow(container, dish, existingDailyItemId = null, onTodaysMenu = true) {
  if (container.querySelector(`.admin-dish-row-catalog[data-catalog-dish-id="${dish.id}"]`)) return;
  if (onTodaysMenu) removeEmptyPlaceholderRow(container);

  const div = document.createElement('div');
  div.className = 'admin-dish-row admin-dish-row-catalog';
  div.dataset.catalogDishId = dish.id;
  div.dataset.id = existingDailyItemId || '';

  const recurringDays = WEEKDAY_LABELS.map((label, weekday) =>
    (menuTemplate?.days?.[String(weekday)] || []).some(item => item.catalogDishId === dish.id)
  );
  const recurringCount = recurringDays.filter(Boolean).length;
  const recurringBadge = recurringCount > 0 ? `<span class="recurring-count-badge">${recurringCount}</span>` : '';

  div.innerHTML = `
    <img src="${getDishImage(dish)}" class="admin-dish-row-thumb" alt="" loading="lazy">
    <div class="admin-dish-row-info">
      <strong>${escapeHtml(dish.name)}</strong>
      ${typeof dish.price === 'number' ? `<span class="menu-card-price">${formatPrice(dish.price)}</span>` : ''}
    </div>
    <button type="button" class="btn btn-icon btn-toggle-recurring ${recurringCount > 0 ? 'has-recurring' : ''}" title="Repeat this dish automatically on specific weekdays">
      <span class="material-symbols-outlined">event_repeat</span>
      ${recurringBadge}
    </button>
    <button type="button" class="btn btn-icon btn-edit-variants" title="Edit dish (name, photo, price, variants)">
      <span class="material-symbols-outlined">tune</span>
    </button>
    ${onTodaysMenu ? `
      <button type="button" class="btn btn-icon btn-logout btn-delete-row" title="Remove from today's menu">
        <span class="material-symbols-outlined">delete</span>
      </button>
    ` : ''}
    <div class="admin-dish-row-recurring hidden">
      <span class="help-text">Repeats every week on:</span>
      <div class="week-day-tabs inline-week-day-tabs">
        ${WEEKDAY_LABELS.map((label, weekday) => `
          <button type="button" class="week-day-tab ${recurringDays[weekday] ? 'active' : ''}" data-weekday="${weekday}">${label}</button>
        `).join('')}
      </div>
    </div>
  `;

  div.querySelector('.btn-toggle-recurring').addEventListener('click', () => {
    div.querySelector('.admin-dish-row-recurring').classList.toggle('hidden');
  });

  div.querySelectorAll('.admin-dish-row-recurring .week-day-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      const weekday = Number(btn.dataset.weekday);
      btn.disabled = true;
      const ok = await toggleRecurringDay(dish.id, weekday);
      btn.disabled = false;
      if (!ok) return;

      btn.classList.toggle('active');
      const count = div.querySelectorAll('.admin-dish-row-recurring .week-day-tab.active').length;
      const toggleBtn = div.querySelector('.btn-toggle-recurring');
      toggleBtn.classList.toggle('has-recurring', count > 0);
      const existingBadge = toggleBtn.querySelector('.recurring-count-badge');
      if (count > 0) {
        if (existingBadge) existingBadge.textContent = count;
        else toggleBtn.insertAdjacentHTML('beforeend', `<span class="recurring-count-badge">${count}</span>`);
      } else {
        existingBadge?.remove();
      }
    });
  });

  div.querySelector('.btn-edit-variants').addEventListener('click', () => editDishVariants(dish.id));

  div.querySelector('.btn-delete-row')?.addEventListener('click', () => {
    div.remove();
    if (container.children.length === 0) {
      addDishInputRow(container);
    }
    renderOtherDishes(); // the removed dish now belongs in "Other dishes"
  });

  container.appendChild(div);
}

// Jumps straight to a catalog dish's edit form (Manage Catalog modal),
// scrolled to the variant fields — the one-click path from a meal row in
// Today's Menu Builder, instead of making the admin hunt for it in the
// catalog list themselves.
function editDishVariants(catalogDishId) {
  const dish = catalogDishes.find(d => d.id === catalogDishId);
  if (!dish) return;
  openCatalogModal();
  populateCatalogDishForm(dish);
  catalogDishVariantLabel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  catalogDishVariantLabel.focus();
}

// Save Daily Menu layout to server
async function saveAdminMenu() {
  adminMenuStatus.className = 'status-msg-inline';
  adminMenuStatus.textContent = 'Saving menu...';

  const rows = adminMenuList.querySelectorAll('.admin-dish-row');
  const menuItems = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (row.dataset.catalogDishId) {
      menuItems.push({ id: row.dataset.id || null, catalogDishId: row.dataset.catalogDishId });
      continue;
    }

    const nameInput = row.querySelector('.dish-name-input');
    const name = nameInput.value.trim();
    const description = row.querySelector('.dish-desc-input').value.trim();
    const priceVal = row.querySelector('.dish-price-input').value.trim();

    if (!name) {
      adminMenuStatus.className = 'status-msg-inline error-text';
      adminMenuStatus.textContent = 'Dish Name is required for all food options.';
      nameInput.focus();
      return;
    }

    menuItems.push({
      id: row.dataset.id || null, // Keep same ID if editing, else make new
      name,
      description,
      price: priceVal ? Number(priceVal) : null
    });
  }

  if (menuItems.length === 0) {
    adminMenuStatus.className = 'status-msg-inline error-text';
    adminMenuStatus.textContent = 'Add at least one dish.';
    return;
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

// --- Dish Catalog (picker + management modal) ---

let catalogDishes = [];

async function loadCatalogPicker() {
  try {
    const all = await apiCall('/api/dishes?includeInactive=true');
    catalogDishes = all.filter(dish => dish.active !== false);
    archivedDishes = all.filter(dish => dish.active === false);
  } catch (err) {
    console.error('Error loading dish catalog:', err);
    catalogDishes = [];
    archivedDishes = [];
  }
  renderOtherDishes();
  renderArchivedDishes();
}

let archivedDishes = [];

function renderArchivedDishes() {
  archivedDishesList.innerHTML = '';
  archivedDishesCount.textContent = archivedDishes.length;
  archivedDishesSection.classList.toggle('hidden', archivedDishes.length === 0);

  archivedDishes.forEach(dish => {
    const row = document.createElement('div');
    row.className = 'admin-dish-row admin-dish-row-archived';
    row.innerHTML = `
      <img src="${getDishImage(dish)}" class="admin-dish-row-thumb" alt="" loading="lazy">
      <div class="admin-dish-row-info"><strong>${escapeHtml(dish.name)}</strong></div>
      <button type="button" class="btn btn-secondary btn-sm btn-restore-dish">
        <span class="material-symbols-outlined">unarchive</span>
        <span>Restore</span>
      </button>
    `;
    row.querySelector('.btn-restore-dish').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await apiCall(`/api/dishes/${dish.id}/restore`, 'POST');
        await loadCatalogPicker();
        showExportFeedback(`${dish.name} restored.`);
      } catch (err) {
        e.currentTarget.disabled = false;
        showAlert(err.message || 'Failed to restore dish.');
      }
    });
    archivedDishesList.appendChild(row);
  });
}

// Catalog dishes that aren't on today's menu — e.g. a Wednesday-only dish
// on a Monday. Listed here so their repeat days and details can be edited
// any day, not only on the days they're scheduled. A dish reaches the menu
// through its repeat days (applied at each day's rollover), not from here.
function renderOtherDishes() {
  const onMenuIds = new Set(
    [...adminMenuList.querySelectorAll('.admin-dish-row-catalog')].map(row => row.dataset.catalogDishId)
  );
  const others = catalogDishes.filter(dish => !onMenuIds.has(dish.id));

  otherDishesList.innerHTML = '';
  otherDishesSection.classList.toggle('hidden', others.length === 0);
  others.forEach(dish => addCatalogPickRow(otherDishesList, dish, null, false));
}

// True while the catalog modal was opened from Today's Menu Builder's
// "Add New Dish" button rather than "Manage Catalog" — in that mode,
// saving a brand-new dish also drops it straight onto today's menu and
// closes the modal, instead of leaving it open for more catalog edits.
let addNewDishToTodaysMenu = false;

function openCatalogModal(addToTodaysMenu = false) {
  addNewDishToTodaysMenu = addToTodaysMenu;
  resetCatalogDishForm();
  catalogModalOverlay.classList.remove('hidden');
  if (addToTodaysMenu) catalogDishName.focus();
}

function closeCatalogModal() {
  addNewDishToTodaysMenu = false;
  catalogModalOverlay.classList.add('hidden');
}

function resetCatalogDishForm() {
  catalogDishId.value = '';
  catalogDishName.value = '';
  catalogDishDesc.value = '';
  catalogDishPrice.value = '';
  catalogDishVariantLabel.value = '';
  catalogDishVariantOptions.value = '';
  catalogDishImageInput.value = '';
  catalogDishImagePreview.classList.add('hidden');
  catalogDishImagePreview.dataset.pendingUpload = '';
  catalogDishStatus.textContent = '';
  catalogModalTitle.textContent = 'Add New Dish';
  btnCatalogDishSubmit.textContent = 'Save Dish';
  btnCatalogDishRemove.classList.add('hidden');
}

function populateCatalogDishForm(dish) {
  catalogDishId.value = dish.id;
  catalogDishName.value = dish.name;
  catalogDishDesc.value = dish.description || '';
  catalogDishPrice.value = dish.price != null ? dish.price : '';
  catalogDishVariantLabel.value = dish.variantLabel || '';
  catalogDishVariantOptions.value = (dish.variantOptions || []).join(', ');
  catalogDishImageInput.value = '';
  catalogDishImagePreview.dataset.pendingUpload = '';
  if (dish.imageId) {
    catalogDishImagePreview.src = getDishImage(dish);
    catalogDishImagePreview.classList.remove('hidden');
  } else {
    catalogDishImagePreview.classList.add('hidden');
  }
  catalogDishStatus.textContent = '';
  catalogModalTitle.textContent = 'Edit Dish';
  btnCatalogDishSubmit.textContent = 'Update Dish';
  btnCatalogDishRemove.classList.remove('hidden');
}

// Resizes/compresses an uploaded image client-side (max 800x800) before it
// ever leaves the browser, keeping the upload well under the server's
// 300KB limit without the admin having to think about it.
function resizeImageFile(file, maxDim = 800) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read the selected image.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/webp', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

catalogDishImageInput?.addEventListener('change', async () => {
  const file = catalogDishImageInput.files?.[0];
  if (!file) return;
  try {
    const dataUrl = await resizeImageFile(file);
    catalogDishImagePreview.src = dataUrl;
    catalogDishImagePreview.classList.remove('hidden');
    catalogDishImagePreview.dataset.pendingUpload = dataUrl;
  } catch (err) {
    catalogDishStatus.className = 'status-msg-inline error-text';
    catalogDishStatus.textContent = err.message || 'Failed to process image.';
  }
});

async function handleCatalogDishFormSubmit(e) {
  e.preventDefault();
  catalogDishStatus.className = 'status-msg-inline';
  catalogDishStatus.textContent = 'Saving...';

  const id = catalogDishId.value;
  const name = catalogDishName.value.trim();
  const description = catalogDishDesc.value.trim();
  const priceVal = catalogDishPrice.value.trim();
  const price = priceVal ? Number(priceVal) : null;
  const variantLabel = catalogDishVariantLabel.value.trim();
  const variantOptions = catalogDishVariantOptions.value.split(',').map(o => o.trim()).filter(Boolean);
  const pendingImage = catalogDishImagePreview.dataset.pendingUpload || '';

  if (!name) {
    catalogDishStatus.className = 'status-msg-inline error-text';
    catalogDishStatus.textContent = 'Dish name is required.';
    return;
  }

  const isNewDish = !id;

  try {
    let dish;
    if (id) {
      dish = await apiCall(`/api/dishes/${id}`, 'PUT', { name, description, price, variantLabel, variantOptions });
    } else {
      dish = await apiCall('/api/dishes', 'POST', { name, description, price, variantLabel, variantOptions });
    }
    if (pendingImage) {
      const imageResult = await apiCall(`/api/dishes/${dish.id}/image`, 'POST', { imageData: pendingImage });
      dish = { ...dish, imageId: imageResult.imageId };
    }
    await loadCatalogPicker();

    // The point of this form is always to finish with the dish in hand —
    // for a brand-new dish from "Add New Dish" that means dropping it onto
    // today's menu too; either way, close rather than linger on a form with
    // nowhere left to browse to.
    if (isNewDish && addNewDishToTodaysMenu) {
      addCatalogPickRow(adminMenuList, dish);
      renderOtherDishes();
      closeCatalogModal();
      showExportFeedback(`${dish.name} added to today's menu!`);
    } else {
      closeCatalogModal();
      showExportFeedback('Dish saved!');
    }
  } catch (err) {
    catalogDishStatus.className = 'status-msg-inline error-text';
    catalogDishStatus.textContent = err.message || 'Failed to save dish.';
  }
}

// Archives the dish currently open in the Add/Edit Dish form (soft delete
// server-side — restorable from Archived dishes, and any day that already
// used it keeps its own frozen record).
async function handleCatalogDishRemove() {
  const id = catalogDishId.value;
  const name = catalogDishName.value.trim() || 'this dish';
  if (!id) return; // only ever shown while editing an existing dish

  const ok = await confirmDialog(`Archive "${name}"? It won't appear on any future menu, but you can restore it anytime from Archived dishes. If it's on today's menu, it stays there for today.`);
  if (!ok) return;
  try {
    await apiCall(`/api/dishes/${id}`, 'DELETE');
    await loadCatalogPicker();
    closeCatalogModal();
    showExportFeedback(`${name} archived.`);
  } catch (err) {
    showAlert(err.message || 'Failed to archive dish.');
  }
}

// --- Repeat days ---
// Which weekdays each catalog dish appears on, set with the calendar icon on
// its row (today's menu or "Other dishes"). Applied at each day's rollover
// by applyMenuTemplateForNewDate in server.js: a dish is added on its days
// and dropped on the others.

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let menuTemplate = null; // { companyId, days: { "0": [...], ..., "6": [...] } }

// Loads the recurring-dish template so each catalog row in Today's Menu
// Builder can show/toggle which weekdays it repeats on.
async function loadMenuTemplate() {
  try {
    menuTemplate = await apiCall('/api/menu-template');
  } catch (err) {
    console.error('Error loading recurring dish template:', err);
    menuTemplate = menuTemplate || { days: {} };
  }
}

// Toggles one catalog dish's membership in one weekday's recurring list —
// called from the repeat-icon toggle on its row in Today's Menu Builder.
// Returns true on success so the caller knows whether to flip its own UI state.
async function toggleRecurringDay(catalogDishId, weekday) {
  const existing = menuTemplate?.days?.[String(weekday)] || [];
  const isOn = existing.some(item => item.catalogDishId === catalogDishId);
  const updated = isOn
    ? existing.filter(item => item.catalogDishId !== catalogDishId)
    : [...existing, { catalogDishId }];

  try {
    const result = await apiCall(`/api/menu-template/${weekday}`, 'PUT', { items: updated });
    menuTemplate.days = { ...menuTemplate.days, [String(weekday)]: result.items };
    return true;
  } catch (err) {
    showAlert(err.message || 'Failed to update recurring days.');
    return false;
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

  const activeDays = dailyState.operationalDays && dailyState.operationalDays.length
    ? dailyState.operationalDays
    : [0, 1, 2, 3, 4, 5, 6];
  operationalDaysPicker.querySelectorAll('.day-toggle').forEach(btn => {
    btn.classList.toggle('selected', activeDays.includes(Number(btn.dataset.day)));
  });
}

async function saveOperationalDays() {
  adminOperationalDaysStatus.className = 'status-msg-inline';
  adminOperationalDaysStatus.textContent = 'Saving...';

  const selectedDays = [...operationalDaysPicker.querySelectorAll('.day-toggle.selected')]
    .map(btn => Number(btn.dataset.day));

  if (selectedDays.length === 0) {
    adminOperationalDaysStatus.className = 'status-msg-inline error-text';
    adminOperationalDaysStatus.textContent = 'Select at least one day.';
    return;
  }

  try {
    await apiCall('/api/operational-days', 'POST', { operationalDays: selectedDays });
    adminOperationalDaysStatus.className = 'status-msg-inline success';
    adminOperationalDaysStatus.style.color = 'var(--status-in-office)';
    adminOperationalDaysStatus.textContent = 'Operational days updated!';

    await fetchDailyState();
  } catch (err) {
    adminOperationalDaysStatus.className = 'status-msg-inline error-text';
    adminOperationalDaysStatus.textContent = err.message || 'Failed to update operational days.';
  }
}

async function loadCompanySettings() {
  try {
    const settings = await apiCall('/api/settings/company');
    companyDefaultPrice.value = settings.defaultPricePerHead != null ? settings.defaultPricePerHead : '';
  } catch (err) {
    companySettingsStatus.className = 'status-msg-inline error-text';
    companySettingsStatus.textContent = err.message || 'Failed to load catering cost settings.';
  }
}

async function saveCompanySettingsForm() {
  companySettingsStatus.className = 'status-msg-inline';
  companySettingsStatus.textContent = 'Saving...';

  const raw = companyDefaultPrice.value.trim();
  const defaultPricePerHead = raw ? Number(raw) : null;

  try {
    await apiCall('/api/settings/company', 'PUT', { defaultPricePerHead });
    companySettingsStatus.className = 'status-msg-inline success';
    companySettingsStatus.style.color = 'var(--status-in-office)';
    companySettingsStatus.textContent = 'Catering cost settings updated!';
  } catch (err) {
    companySettingsStatus.className = 'status-msg-inline error-text';
    companySettingsStatus.textContent = err.message || 'Failed to save catering cost settings.';
  }
}

async function loadSecuritySettings() {
  try {
    const settings = await apiCall('/api/settings/security');
    securityMaxFailedAttempts.value = settings.loginMaxFailedAttempts;
    securityLockoutMinutes.value = settings.loginLockoutMinutes;
    securityRateLimitMax.value = settings.loginRateLimitMax;
    securityRateLimitWindow.value = settings.loginRateLimitWindowMinutes;
  } catch (err) {
    securitySettingsStatus.className = 'status-msg-inline error-text';
    securitySettingsStatus.textContent = err.message || 'Failed to load login security settings.';
  }
}

async function saveSecuritySettings() {
  securitySettingsStatus.className = 'status-msg-inline';
  securitySettingsStatus.textContent = 'Saving...';

  const payload = {
    loginMaxFailedAttempts: parseInt(securityMaxFailedAttempts.value, 10),
    loginLockoutMinutes: parseInt(securityLockoutMinutes.value, 10),
    loginRateLimitMax: parseInt(securityRateLimitMax.value, 10),
    loginRateLimitWindowMinutes: parseInt(securityRateLimitWindow.value, 10)
  };

  try {
    await apiCall('/api/settings/security', 'PUT', payload);
    securitySettingsStatus.className = 'status-msg-inline success';
    securitySettingsStatus.style.color = 'var(--status-in-office)';
    securitySettingsStatus.textContent = 'Login security settings updated!';
  } catch (err) {
    securitySettingsStatus.className = 'status-msg-inline error-text';
    securitySettingsStatus.textContent = err.message || 'Failed to save login security settings.';
  }
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
        role: parts[3] || 'Team Member',
        branch: parts[4] || ''
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

    if (res.warnings && res.warnings.length > 0) {
      html += `<ul class="bulk-skip-list">`;
      res.warnings.forEach(w => {
        html += `<li>${escapeHtml(w)}</li>`;
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

const ROLE_META = {
  'Admin': { badgeClass: 'admin', label: 'Admin' },
  'Abigail': { badgeClass: 'abigail', label: 'Abigail' },
  'Team Member': { badgeClass: 'member', label: 'Team Member' }
};
function getRoleMeta(role) {
  return ROLE_META[role] || { badgeClass: 'member', label: role || 'Unknown' };
}

function renderRosterTable() {
  rosterTableBody.innerHTML = '';

  const searchVal = rosterSearch.value.toLowerCase().trim();
  const branchFilterVal = rosterBranchFilter.value;
  const filteredRoster = roster
    .filter(u => u.name.toLowerCase().includes(searchVal))
    .filter(u => !branchFilterVal || u.branchId === branchFilterVal)
    .sort((a, b) => {
      const cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      return rosterSortDirection === 'asc' ? cmp : -cmp;
    });

  if (filteredRoster.length === 0) {
    rosterTableBody.innerHTML = '<tr><td colspan="6" class="no-results">No team members found</td></tr>';
    return;
  }

  filteredRoster.forEach(user => {
    const tr = document.createElement('tr');

    const roleMeta = getRoleMeta(user.role);
    const branchName = getBranchName(user.branchId);

    tr.innerHTML = `
      <td data-label="Name"><strong>${escapeHtml(user.name)}</strong></td>
      <td data-label="Email">${escapeHtml(user.email || '—')}</td>
      <td data-label="Phone">${escapeHtml(user.phone || '—')}</td>
      <td data-label="Branch">${branchName ? escapeHtml(branchName) : '<span class="text-muted">No branch</span>'}</td>
      <td data-label="System Role"><span class="table-role-badge ${roleMeta.badgeClass}">${escapeHtml(roleMeta.label)}</span></td>
      <td data-label="Passcode">${user.hasPasscode ? '<code>Set</code>' : '<code class="no-passcode">None</code>'}</td>
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
    rosterBranch.value = user.branchId || '';
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
    rosterBranch.value = '';
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

// --- Branches ---

let branches = [];

async function loadBranches() {
  try {
    branches = await apiCall('/api/branches');
  } catch (err) {
    console.error('Error loading branches:', err);
    branches = [];
  }
  renderBranchesTable();
  populateBranchSelects();
}

function populateBranchSelects() {
  const options = branches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  const prevRosterValue = rosterBranch.value;
  const prevFilterValue = rosterBranchFilter.value;
  rosterBranch.innerHTML = '<option value="">No branch</option>' + options;
  rosterBranchFilter.innerHTML = '<option value="">All Branches</option>' + options;
  rosterBranch.value = prevRosterValue;
  rosterBranchFilter.value = prevFilterValue;
}

function getBranchName(branchId) {
  if (!branchId) return null;
  return branches.find(b => b.id === branchId)?.name || null;
}

function renderBranchesTable() {
  branchesTableBody.innerHTML = '';
  if (branches.length === 0) {
    branchesTableBody.innerHTML = '<tr><td colspan="2" class="no-results">No branches yet</td></tr>';
    return;
  }
  branches.forEach(branch => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Name"><strong>${escapeHtml(branch.name)}</strong></td>
      <td data-label=""></td>
    `;
    const actionsTd = tr.querySelector('td:last-child');

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'btn btn-secondary btn-sm';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', () => handleBranchRename(branch));
    actionsTd.appendChild(renameBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => handleBranchDelete(branch));
    actionsTd.appendChild(deleteBtn);

    branchesTableBody.appendChild(tr);
  });
}

// Doubles as both "Add Branch" and "Rename Branch" — handleBranchRename
// below populates the same field and stashes the id being edited on the
// form itself, rather than opening a second modal for a one-field edit.
async function handleBranchFormSubmit(e) {
  e.preventDefault();
  branchFormStatus.className = 'status-msg-inline';
  const name = branchAddName.value.trim();
  if (!name) return;

  const editingId = branchAddForm.dataset.editingId;
  try {
    if (editingId) {
      await apiCall(`/api/branches/${editingId}`, 'PUT', { name });
      delete branchAddForm.dataset.editingId;
    } else {
      await apiCall('/api/branches', 'POST', { name });
    }
    branchAddName.value = '';
    branchFormStatus.textContent = '';
    await loadBranches();
  } catch (err) {
    branchFormStatus.className = 'status-msg-inline error-text';
    branchFormStatus.textContent = err.message || 'Failed to save branch.';
  }
}

function handleBranchRename(branch) {
  branchAddName.value = branch.name;
  branchAddForm.dataset.editingId = branch.id;
  branchAddName.focus();
}

// No cascade — a roster member's now-orphaned branchId just fails to
// resolve (getBranchName returns null) and the table shows "No branch".
async function handleBranchDelete(branch) {
  const ok = await confirmDialog(`Delete branch "${branch.name}"? Team members assigned to it will show "No branch".`);
  if (!ok) return;
  try {
    await apiCall(`/api/branches/${branch.id}`, 'DELETE');
    await loadBranches();
    renderRosterTable();
  } catch (err) {
    showAlert(err.message || 'Failed to delete branch.');
  }
}

// --- Platform Admin: Companies ---

let companies = [];

async function loadCompanies() {
  try {
    companies = await apiCall('/api/companies');
    renderCompaniesTable();
  } catch (err) {
    console.error('Error loading companies:', err);
  }
}

function renderCompaniesTable() {
  companiesTableBody.innerHTML = '';

  if (companies.length === 0) {
    companiesTableBody.innerHTML = '<tr><td colspan="5" class="no-results">No companies yet</td></tr>';
    return;
  }

  companies.forEach(company => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Name"><strong>${escapeHtml(company.name)}</strong></td>
      <td data-label="Code"><code>${escapeHtml(company.code)}</code></td>
      <td data-label="Members">${company.memberCount}</td>
      <td data-label="Status"><span class="table-role-badge ${company.status === 'active' ? 'member' : 'admin'}">${company.status === 'active' ? 'Active' : 'Suspended'}</span></td>
      <td data-label=""></td>
    `;
    const actionsTd = tr.querySelector('td:last-child');

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-secondary btn-sm';
    editBtn.textContent = 'Rename';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCompanyModal(company);
    });
    actionsTd.appendChild(editBtn);

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-secondary btn-sm';
    toggleBtn.textContent = company.status === 'active' ? 'Suspend' : 'Reactivate';
    toggleBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const nextStatus = company.status === 'active' ? 'suspended' : 'active';
      const ok = await confirmDialog(`${nextStatus === 'suspended' ? 'Suspend' : 'Reactivate'} "${company.name}"?`);
      if (!ok) return;
      try {
        await apiCall(`/api/companies/${company.id}/status`, 'PUT', { status: nextStatus });
        await loadCompanies();
      } catch (err) {
        showAlert(err.message || 'Failed to update company status.');
      }
    });
    actionsTd.appendChild(toggleBtn);

    companiesTableBody.appendChild(tr);
  });
}

function openCompanyModal(company) {
  if (company) {
    companyFormTitle.textContent = 'Rename Company';
    companyFormId.value = company.id;
    companyFormName.value = company.name;
    companyFormCode.value = company.code;
    companyFormCode.disabled = true;
    companyFormCodeGroup.classList.add('hidden');
    companyFormAdminGroup.classList.add('hidden');
    companyFormAdminEmailGroup.classList.add('hidden');
  } else {
    companyFormTitle.textContent = 'New Company';
    companyFormId.value = '';
    companyFormName.value = '';
    companyFormCode.value = '';
    companyFormCode.disabled = false;
    companyFormCodeGroup.classList.remove('hidden');
    companyFormAdminGroup.classList.remove('hidden');
    companyFormAdminEmailGroup.classList.remove('hidden');
    companyFormAdminName.value = '';
    companyFormAdminEmail.value = '';
  }
  companyFormStatus.textContent = '';
  companyModalOverlay.classList.remove('hidden');
}

function closeCompanyModal() {
  companyModalOverlay.classList.add('hidden');
}

async function handleCompanyFormSubmit(e) {
  e.preventDefault();
  const id = companyFormId.value;
  const name = companyFormName.value.trim();

  try {
    if (id) {
      await apiCall(`/api/companies/${id}`, 'PUT', { name });
      closeCompanyModal();
      await loadCompanies();
    } else {
      const code = companyFormCode.value.trim();
      const adminName = companyFormAdminName.value.trim();
      const adminEmail = companyFormAdminEmail.value.trim();
      if (!code || !adminName) {
        companyFormStatus.textContent = 'Company code and the first Admin\'s name are required.';
        return;
      }
      const result = await apiCall('/api/companies', 'POST', { name, code, adminName, adminEmail });
      closeCompanyModal();
      await loadCompanies();
      await showAppModal({
        title: 'Company Created',
        message: `${result.company.name} is ready. Share this one-time passcode with ${result.admin.name} (code: ${result.company.code}):`,
        code: result.admin.initialPasscode
      });
    }
  } catch (err) {
    companyFormStatus.textContent = err.message || 'Failed to save company.';
  }
}

// Roster Form Submit handler
async function handleRosterFormSubmit(e) {
  e.preventDefault();

  const id = rosterUserId.value;
  const name = rosterName.value.trim();
  const email = rosterEmail.value.trim();
  const phone = rosterPhone.value.trim();
  const role = rosterRole.value;
  const branchId = rosterBranch.value || null;
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

  const payload = { name, email, phone, role, branchId };
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
        await showAppModal({
          title: `${created.name}'s temporary passcode`,
          message: `Share it with them securely — it won't be shown again. They'll be prompted to set their own on first login.`,
          code: created.initialPasscode
        });
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
  if (!(await confirmDialog(`Are you sure you want to delete ${user.name} from the team roster? This will clear their today's orders.`, { danger: true }))) {
    return;
  }

  try {
    await apiCall(`/api/roster/${user.id}`, 'DELETE');
    roster = await apiCall('/api/roster');
    renderRosterTable();
    closeRosterModal();
  } catch (err) {
    showAlert(err.message || 'Failed to remove member.');
  }
}

async function resetRosterMemberPasscode(user) {
  if (!(await confirmDialog(`Reset ${user.name}'s passcode to a new random value? They'll be asked to set their own on next login.`, { danger: true }))) {
    return;
  }

  try {
    const result = await apiCall(`/api/roster/${user.id}/reset-passcode`, 'POST');
    roster = await apiCall('/api/roster');
    renderRosterTable();
    closeRosterModal();
    await showAppModal({
      title: `${user.name}'s new temporary passcode`,
      message: `Share it with them securely — it won't be shown again. They'll be prompted to set their own passcode on next login.`,
      code: result.newPasscode
    });
  } catch (err) {
    showAlert(err.message || 'Failed to reset passcode.');
  }
}

// --- Tab: Distribution & Order History ---
// Unified checklist: "Today" is the live board (same tap-to-serve UX the old
// standalone Distribution tab had); past dates are archived history, kept
// editable so a late vendor delivery arriving after archive rollover can
// still be checked off (see /api/history/:date/order-serve).

async function loadHistoryDates() {
  historyDatesList.innerHTML = '<div class="no-results">Loading...</div>';
  historyDetailPanel.innerHTML = `
    <div class="panel-card history-empty-card">
      <div class="empty-state">
        <span class="material-symbols-outlined">inventory_2</span>
        <p>Loading today's checklist...</p>
      </div>
    </div>
  `;

  try {
    const [today, history] = await Promise.all([
      apiCall('/api/daily'),
      apiCall('/api/history')
    ]);
    historyDatesList.innerHTML = '';

    const todayItem = document.createElement('div');
    todayItem.className = 'history-date-item history-date-item-today active';
    todayItem.innerHTML = `
      <div>
        <div class="history-date-title">Today <span class="live-badge">LIVE</span></div>
        <div class="history-date-meta">${today.stats.ordered} order${today.stats.ordered !== 1 ? 's' : ''} so far</div>
      </div>
      <span class="material-symbols-outlined text-muted" style="font-size:1.1rem">arrow_forward_ios</span>
    `;
    todayItem.addEventListener('click', () => {
      document.querySelectorAll('.history-date-item').forEach(el => el.classList.remove('active'));
      todayItem.classList.add('active');
      renderHistoryDetail(buildChecklistData(today, true));
    });
    historyDatesList.appendChild(todayItem);

    history.forEach(archive => {
      const div = document.createElement('div');
      div.className = 'history-date-item';

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
        renderHistoryDetail(buildChecklistData(archive, false));
      });

      historyDatesList.appendChild(div);
    });

    // Land on today's live checklist immediately, same as the old
    // Distribution tab did, rather than an empty "pick a date" state.
    renderHistoryDetail(buildChecklistData(today, true));
  } catch (err) {
    historyDatesList.innerHTML = '<div class="no-results error-text">Failed to fetch history</div>';
    console.error('Error loading history:', err);
  }
}

// Normalizes either the live daily state or an archived history entry into
// one shape, so the rest of the checklist UI doesn't need to know which.
function buildChecklistData(source, isLive) {
  if (isLive) {
    const ordered = source.orders.ordered || [];
    const pending = source.orders.pending || [];

    const byDish = new Map();
    ordered.forEach(o => {
      if (!byDish.has(o.itemName)) byDish.set(o.itemName, []);
      byDish.get(o.itemName).push({ userId: o.userId, name: o.name, served: !!o.served, note: o.note || '', variant: o.variant || '' });
    });
    const columns = source.menu
      .map(d => ({ title: d.name, members: byDish.get(d.name) || [] }))
      .filter(c => c.members.length > 0);

    // Safety net: anyone whose dish isn't on today's current menu (e.g. it
    // was removed after they ordered) still gets a column instead of
    // silently disappearing from the handout checklist.
    const coveredDishNames = new Set(columns.map(c => c.title));
    byDish.forEach((members, itemName) => {
      if (!coveredDishNames.has(itemName)) columns.push({ title: itemName, members });
    });

    const rosterRows = [
      ...ordered.map(o => ({ name: o.name, status: 'Ordered', dish: o.itemName, variant: o.variant || '' })),
      ...pending.map(p => ({ name: p.name, status: 'Unconfirmed', dish: '—', variant: '' }))
    ];

    return {
      date: source.date,
      isLive: true,
      menu: source.menu,
      dishTotals: source.dishTotals,
      columns,
      rosterRows,
      totalRoster: source.stats.total,
      orderedCount: source.stats.ordered,
      servedCount: ordered.filter(o => o.served).length
    };
  }

  const archive = source;
  const dishTotals = {};
  archive.menu.forEach(d => { dishTotals[d.id] = 0; });
  const rosterSnapshot = archive.rosterSnapshot || {};
  const orders = archive.orders || {};

  const byDish = new Map();
  const rosterRows = [];
  let orderedCount = 0;
  let servedCount = 0;

  Object.entries(rosterSnapshot).forEach(([userId, u]) => {
    const o = orders[userId];
    if (o) {
      orderedCount++;
      if (o.served) servedCount++;
      if (o.itemId) dishTotals[o.itemId] = (dishTotals[o.itemId] || 0) + 1;
      const dishName = archive.menu.find(m => m.id === o.itemId)?.name || 'Unknown Dish';
      if (!byDish.has(dishName)) byDish.set(dishName, []);
      byDish.get(dishName).push({ userId, name: u.name, served: !!o.served, variant: o.variant || '' });
      rosterRows.push({ name: u.name, status: 'Ordered', dish: dishName, variant: o.variant || '' });
    } else {
      rosterRows.push({ name: u.name, status: 'Unconfirmed', dish: '—', variant: '' });
    }
  });

  const columns = archive.menu
    .map(d => ({ title: d.name, members: byDish.get(d.name) || [] }))
    .filter(c => c.members.length > 0);

  // Safety net: a dish removed from the menu before that day's archive was
  // taken would otherwise drop its orderer from view entirely.
  const archiveCoveredNames = new Set(columns.map(c => c.title));
  byDish.forEach((members, dishName) => {
    if (!archiveCoveredNames.has(dishName)) columns.push({ title: dishName, members });
  });

  return {
    date: archive.date,
    isLive: false,
    menu: archive.menu,
    dishTotals: archive.menu.map(d => ({ itemId: d.id, name: d.name, count: dishTotals[d.id] || 0 })),
    columns,
    rosterRows,
    totalRoster: Object.keys(rosterSnapshot).length,
    orderedCount,
    servedCount
  };
}

// Currently displayed checklist data (today or a past date) — kept around
// so search-filtering and optimistic serve-toggles don't need a re-fetch.
let currentChecklistData = null;

function renderHistoryDetail(data) {
  currentChecklistData = data;
  const unservedCount = data.orderedCount - data.servedCount;

  historyDetailPanel.innerHTML = `
    <!-- Stat Cards -->
    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-num">${data.totalRoster}</span>
        <span class="stat-label">Total Roster</span>
      </div>
      <div class="stat-card status-in-office">
        <span class="stat-num">${data.orderedCount}</span>
        <span class="stat-label">Ordered</span>
      </div>
      <div class="stat-card status-pending">
        <span class="stat-num">${data.totalRoster - data.orderedCount}</span>
        <span class="stat-label">Unconfirmed</span>
      </div>
      <div class="stat-card status-in-office">
        <span class="stat-num" id="history-stat-served">${data.servedCount}</span>
        <span class="stat-label">Served</span>
      </div>
      <div class="stat-card status-not-coming">
        <span class="stat-num" id="history-stat-unserved">${unservedCount}</span>
        <span class="stat-label">Not Served</span>
      </div>
    </div>

    <!-- Dish Quantities -->
    <div class="panel-card">
      <div class="card-header-compact-row">
        <div>
          <h2>${data.isLive ? "Today's Lunch Records" : `Lunch Records for ${formatDate(data.date)}`}</h2>
          <p>Required totals for food vendor order placement.</p>
        </div>
        <button type="button" class="btn btn-secondary btn-icon-text" id="btn-export-history-csv">
          <span class="material-symbols-outlined">download</span>
          <span>Export as CSV</span>
        </button>
      </div>
      <div class="dish-totals-grid">
        ${data.dishTotals.filter(d => d.count > 0).map(dish => `
          <div class="dish-total-card">
            <span class="material-symbols-outlined">restaurant</span>
            <span class="dish-total-count">${dish.count}</span>
            <span class="dish-total-name">${escapeHtml(dish.name)}</span>
          </div>
        `).join('') || '<div class="no-results">No orders placed yet.</div>'}
      </div>
    </div>

    <!-- Distribution Checklist -->
    <div class="panel-card">
      <div class="card-header">
        <h2>${data.isLive ? 'Handout Checklist' : 'Handout Record'}</h2>
        <p>${data.isLive ? "Tap a name as you hand out their dish to check it off." : "Correct this day's serve status if it wasn't checked off before archiving."}</p>
      </div>

      <div class="list-search-wrapper">
        <span class="material-symbols-outlined">search</span>
        <input type="text" id="history-checklist-search" placeholder="Search people...">
      </div>

      <div class="roster-breakdown-grid" id="history-checklist-groups">
        <!-- Populated by renderHistoryChecklistGrid -->
      </div>
    </div>
  `;

  document.getElementById('btn-export-history-csv').addEventListener('click', () => {
    exportHistoryCsv(data);
  });
  document.getElementById('history-checklist-search').addEventListener('input', renderHistoryChecklistGrid);

  renderHistoryChecklistGrid();
}

function renderHistoryChecklistGrid() {
  const data = currentChecklistData;
  const container = document.getElementById('history-checklist-groups');
  if (!data || !container) return;

  const searchVal = (document.getElementById('history-checklist-search')?.value || '').toLowerCase().trim();

  const columns = data.columns
    .map(col => ({ ...col, members: col.members.filter(m => m.name.toLowerCase().includes(searchVal)) }))
    .filter(col => col.members.length > 0);

  if (columns.length === 0) {
    container.innerHTML = `<div class="no-results">${data.orderedCount === 0 ? 'No orders to hand out yet.' : 'No matches.'}</div>`;
    return;
  }

  container.innerHTML = columns.map(col => {
    const doneInCol = col.members.filter(m => m.served).length;
    const rows = col.members.map(member => `
      <button type="button" class="summary-member-row distribution-row ${member.served ? 'served' : ''}" data-user-id="${member.userId}">
        <span class="material-symbols-outlined">${member.served ? 'check_box' : 'check_box_outline_blank'}</span>
        <span>${escapeHtml(member.name)}${member.variant ? `<span class="text-muted"> — ${escapeHtml(member.variant)}</span>` : ''}${member.note ? `<span class="text-muted"> — ${escapeHtml(member.note)}</span>` : ''}</span>
      </button>
    `).join('');

    return `
      <div class="breakdown-column" data-dish-title="${escapeHtml(col.title)}">
        <div class="breakdown-column-title">${escapeHtml(col.title)} (${doneInCol}/${col.members.length})</div>
        <div class="breakdown-column-list">${rows}</div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.distribution-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const userId = btn.dataset.userId;
      const nowServed = !btn.classList.contains('served');
      // Optimistic update — flip the UI immediately instead of waiting on a
      // full network round-trip, which felt laggy.
      applyChecklistServedState(userId, nowServed, btn);
      saveChecklistServed(userId, nowServed, btn);
    });
  });
}

// Updates the in-memory checklist data, the row's checkbox, its column
// count, and the overall stat totals together — computed from the cached
// data rather than the visible DOM, so totals stay correct even mid-search.
function applyChecklistServedState(userId, served, btn) {
  const data = currentChecklistData;
  if (!data) return;

  for (const col of data.columns) {
    const member = col.members.find(m => m.userId === userId);
    if (member) { member.served = served; break; }
  }
  data.servedCount = data.columns.reduce(
    (sum, col) => sum + col.members.filter(m => m.served).length, 0
  );

  if (btn) {
    btn.classList.toggle('served', served);
    btn.querySelector('.material-symbols-outlined').textContent = served ? 'check_box' : 'check_box_outline_blank';

    const column = btn.closest('.breakdown-column');
    if (column) {
      const title = column.querySelector('.breakdown-column-title');
      const total = column.querySelectorAll('.distribution-row').length;
      const done = column.querySelectorAll('.distribution-row.served').length;
      title.textContent = `${column.dataset.dishTitle} (${done}/${total})`;
    }
  }

  const statServed = document.getElementById('history-stat-served');
  const statUnserved = document.getElementById('history-stat-unserved');
  if (statServed) statServed.textContent = data.servedCount;
  if (statUnserved) statUnserved.textContent = data.orderedCount - data.servedCount;

  // Keep the live poll's copy of dailyState in sync too, so switching to
  // Live Summary/My Orders right after doesn't show stale served status.
  if (data.isLive) {
    const order = dailyState?.orders?.ordered?.find(o => o.userId === userId);
    if (order) order.served = served;
  }
}

async function saveChecklistServed(userId, served, btn) {
  const data = currentChecklistData;
  try {
    if (data.isLive) {
      await apiCall('/api/order/serve', 'POST', { userId, served });
    } else {
      await apiCall(`/api/history/${data.date}/order-serve`, 'POST', { userId, served });
    }
  } catch (err) {
    applyChecklistServedState(userId, !served, btn);
    showAlert(err.message || 'Failed to update served status.');
  }
}

// Download a CSV of the currently displayed day (today or archived)
function exportHistoryCsv(data) {
  const csvRows = [
    ['Dish', 'Quantity'],
    ...data.dishTotals.filter(d => d.count > 0).map(d => [d.name, String(d.count)]),
    [],
    ['Name', 'Status', 'Dish Selection', 'Variant'],
    ...data.rosterRows.map(r => [r.name, r.status, r.dish, r.variant || ''])
  ];

  const csvContent = "data:text/csv;charset=utf-8,"
    + csvRows.map(row => row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(",")).join("\n");

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `LunchBuddy_${data.date}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// --- Tab: My Past Orders ---

// --- Trends Tab ---

let trendsSpendChart = null;
let trendsPopularityChart = null;

function toDateInputValue(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function loadTrends() {
  if (!trendsStartDate.value || !trendsEndDate.value) {
    trendsStartDate.value = toDateInputValue(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    trendsEndDate.value = toDateInputValue(new Date());
  }

  const params = new URLSearchParams();
  if (trendsStartDate.value) params.set('startDate', trendsStartDate.value);
  if (trendsEndDate.value) params.set('endDate', trendsEndDate.value);

  try {
    const [data] = await Promise.all([apiCall(`/api/trends?${params.toString()}`), loadChartJs()]);
    renderTrendsCharts(data);
  } catch (err) {
    console.error('Error loading trends:', err);
  }
}

// Chart.js + its datalabels plugin are ~200KB combined and only needed by
// the Trends tab / My Orders' personal chart — loading them in <head> would
// block every page load (including the Order Lunch page, by far the most
// common view) for a feature most visits never touch. Loaded once, on
// first actual use, and cached so repeat tab visits are instant.
let chartJsLoadPromise = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}
function loadChartJs() {
  if (!chartJsLoadPromise) {
    chartJsLoadPromise = loadScript('https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js')
      .then(() => loadScript('https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2/dist/chartjs-plugin-datalabels.min.js'))
      .then(() => Chart.register(window.ChartDataLabels));
  }
  return chartJsLoadPromise;
}

function renderTrendsCharts(data) {
  const hasUnpriced = data.spendByDay.some(d => d.hasUnpricedOrders);
  trendsSpendCaveat.classList.toggle('hidden', !hasUnpriced);

  // Theme-aware colors, read live rather than hardcoded, so charts stay
  // legible if the viewer toggles light/dark mode.
  const style = getComputedStyle(document.documentElement);
  const textColor = style.getPropertyValue('--text-secondary').trim() || '#9ca3af';
  const cardBg = style.getPropertyValue('--bg-primary').trim() || '#ffffff';
  const gridColor = 'rgba(128,128,128,0.08)';
  const tooltipStyle = {
    backgroundColor: style.getPropertyValue('--bg-secondary').trim() || '#1f2937',
    titleColor: textColor,
    bodyColor: textColor,
    borderColor: 'rgba(128,128,128,0.2)',
    borderWidth: 1,
    padding: 10,
    cornerRadius: 8,
    displayColors: false
  };

  if (trendsSpendChart) trendsSpendChart.destroy();
  const spendCtx = trendsSpendChartCanvas.getContext('2d');
  const spendGradient = spendCtx.createLinearGradient(0, 0, 0, trendsSpendChartCanvas.clientHeight || 320);
  spendGradient.addColorStop(0, 'rgba(99, 102, 241, 0.35)');
  spendGradient.addColorStop(1, 'rgba(99, 102, 241, 0)');

  trendsSpendChart = new Chart(trendsSpendChartCanvas, {
    type: 'line',
    data: {
      labels: data.spendByDay.map(d => d.date),
      datasets: [{
        label: 'Spend',
        data: data.spendByDay.map(d => d.total),
        borderColor: '#6366f1',
        borderWidth: 2.5,
        backgroundColor: spendGradient,
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 6,
        pointHoverBackgroundColor: '#6366f1',
        pointHoverBorderColor: cardBg,
        pointHoverBorderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipStyle, callbacks: { label: (ctx) => formatPrice(ctx.parsed.y) } },
        datalabels: { display: false }
      },
      scales: {
        x: { ticks: { color: textColor, font: { size: 11 } }, grid: { display: false }, border: { display: false } },
        y: {
          ticks: { color: textColor, font: { size: 11 }, callback: (v) => `GHc ${v}` },
          grid: { color: gridColor },
          border: { display: false },
          beginAtZero: true
        }
      }
    }
  });

  if (trendsPopularityChart) trendsPopularityChart.destroy();
  const topDishes = data.topDishesOverall.slice(0, 8);
  const maxCount = Math.max(1, ...topDishes.map(d => d.totalCount));

  const popCtx = trendsPopularityChartCanvas.getContext('2d');
  const popGradient = popCtx.createLinearGradient(0, 0, popCtx.canvas.clientWidth || 600, 0);
  popGradient.addColorStop(0, '#6366f1');
  popGradient.addColorStop(1, '#10b981');

  trendsPopularityChart = new Chart(trendsPopularityChartCanvas, {
    type: 'bar',
    data: {
      labels: topDishes.map(d => d.dishName),
      datasets: [{
        label: 'Orders',
        data: topDishes.map(d => d.totalCount),
        backgroundColor: popGradient,
        borderRadius: 8,
        borderSkipped: false,
        barPercentage: 0.65,
        categoryPercentage: 0.8
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipStyle, callbacks: { label: (ctx) => `${ctx.parsed.x} order${ctx.parsed.x === 1 ? '' : 's'}` } },
        datalabels: {
          anchor: 'end',
          align: 'end',
          color: textColor,
          font: { weight: '600', size: 12 },
          formatter: (value) => value
        }
      },
      scales: {
        x: {
          display: false,
          beginAtZero: true,
          max: maxCount * 1.15 // headroom so the end-of-bar data label never clips off-canvas
        },
        y: {
          ticks: { color: textColor, font: { size: 12, weight: '600' } },
          grid: { display: false },
          border: { display: false }
        }
      }
    }
  });
}

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

  try {
    const [trends] = await Promise.all([apiCall('/api/my-trends'), loadChartJs()]);
    renderMyTrends(trends);
  } catch (err) {
    console.error('Error loading personal trends:', err);
    myTrendsCard.classList.add('hidden');
  }
}

let myTrendsChart = null;

function renderMyTrends(trends) {
  if (!trends.topDishes || trends.topDishes.length === 0) {
    myTrendsCard.classList.add('hidden');
    return;
  }
  myTrendsCard.classList.remove('hidden');

  myTrendsStats.innerHTML = `
    <div class="my-stat-pill">
      <span class="material-symbols-outlined">restaurant</span>
      <span><strong>${trends.mealsOrdered}</strong> meals logged</span>
    </div>
  `;

  const topDishes = trends.topDishes.slice(0, 5);
  const maxCount = Math.max(1, ...topDishes.map(d => d.totalCount));
  const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#9ca3af';

  const ctx = myTrendsChartCanvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, ctx.canvas.clientWidth || 500, 0);
  gradient.addColorStop(0, '#6366f1');
  gradient.addColorStop(1, '#10b981');

  if (myTrendsChart) myTrendsChart.destroy();
  myTrendsChart = new Chart(myTrendsChartCanvas, {
    type: 'bar',
    data: {
      labels: topDishes.map(d => d.dishName),
      datasets: [{
        data: topDishes.map(d => d.totalCount),
        backgroundColor: gradient,
        borderRadius: 8,
        borderSkipped: false,
        barPercentage: 0.6,
        categoryPercentage: 0.8
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (c) => `${c.parsed.x} order${c.parsed.x === 1 ? '' : 's'}` },
          displayColors: false
        },
        datalabels: {
          anchor: 'end',
          align: 'end',
          color: textColor,
          font: { weight: '600', size: 12 },
          formatter: (v) => v
        }
      },
      scales: {
        x: { display: false, beginAtZero: true, max: maxCount * 1.2 },
        y: { ticks: { color: textColor, font: { size: 12, weight: '600' } }, grid: { display: false }, border: { display: false } }
      }
    }
  });
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

// --- Tab: Lunch Run (3D mini-game) ---
// A small distraction for while people wait on lunch — not persisted
// server-side, just a Three.js endless runner with a per-browser high
// score. Three.js itself is lazy-loaded on first visit to this tab (same
// pattern as loadChartJs() for the Trends tab) so it never costs anything
// on the far more common Order Lunch page load.
//
// Mechanics: 4 lanes, the world scrolls toward the camera rather than the
// player moving through it (simpler endless-spawn logic). Obstacles come in
// three flavors — 'block' (full lane, must switch lanes), 'low' (must
// jump), 'high' (must slide) — and every spawned row guarantees at least
// one clear lane so a run is never unwinnable by bad luck. Food items are
// optional bonus pickups, always placed in a lane that's clear that row.
// Collision is resolved by game state (is the player jumping/sliding/in the
// right lane), not literal 3D mesh intersection — simpler and more
// reliable for a fast-reaction game than physics-accurate hit-testing.

let THREE = null;
let threeJsLoadPromise = null;
function loadThreeJs() {
  if (!threeJsLoadPromise) {
    // Resolved via the import map in index.html (needed anyway so the
    // loader/postprocessing addons below, which import "three" internally
    // as a bare specifier, resolve to the same module instance).
    threeJsLoadPromise = import('three').then(mod => { THREE = mod; });
  }
  return threeJsLoadPromise;
}

let GLTFLoaderClass = null;
let gltfLoaderLoadPromise = null;
function loadGLTFLoader() {
  if (!gltfLoaderLoadPromise) {
    gltfLoaderLoadPromise = import('three/addons/loaders/GLTFLoader.js')
      .then(mod => { GLTFLoaderClass = mod.GLTFLoader; });
  }
  return gltfLoaderLoadPromise;
}

let EffectComposerClass = null;
let RenderPassClass = null;
let UnrealBloomPassClass = null;
let OutputPassClass = null;
let postprocessingLoadPromise = null;
function loadPostprocessing() {
  if (!postprocessingLoadPromise) {
    postprocessingLoadPromise = Promise.all([
      import('three/addons/postprocessing/EffectComposer.js'),
      import('three/addons/postprocessing/RenderPass.js'),
      import('three/addons/postprocessing/UnrealBloomPass.js'),
      import('three/addons/postprocessing/OutputPass.js')
    ]).then(([ec, rp, bp, op]) => {
      EffectComposerClass = ec.EffectComposer;
      RenderPassClass = rp.RenderPass;
      UnrealBloomPassClass = bp.UnrealBloomPass;
      OutputPassClass = op.OutputPass;
    });
  }
  return postprocessingLoadPromise;
}

// The player model is a real rigged GLTF humanoid (three.js's own MIT-
// licensed example asset) rather than hand-built primitives, with its
// built-in "Run" animation driven by an AnimationMixer — see initGameCanvas
// and the mixer.update() call in gameLoop.
// The npm "three" package (used for the main module/addons above) doesn't
// include the examples/models/ assets — only the GitHub repo does — so this
// one file is pulled from jsdelivr's GitHub CDN instead of the npm CDN.
const GAME_PLAYER_MODEL_URL = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/models/gltf/Soldier.glb';
const GAME_PLAYER_TARGET_HEIGHT = 1.3; // world units — matches the old rig's height so lanes/camera framing still fit

const GAME_LANE_COUNT = 4;
const GAME_LANE_WIDTH = 2;
const GAME_ROAD_WIDTH = GAME_LANE_COUNT * GAME_LANE_WIDTH;
const GAME_LANE_CENTERS = Array.from({ length: GAME_LANE_COUNT }, (_, i) =>
  -GAME_ROAD_WIDTH / 2 + GAME_LANE_WIDTH * (i + 0.5)
);
const GAME_SPAWN_Z = -60;
const GAME_REMOVE_Z = 8;
const GAME_PLAYER_GROUND_Y = 0; // the rig's own leg geometry already plants its feet at local y=0
const GAME_JUMP_VELOCITY = 7;
const GAME_GRAVITY = 20;
const GAME_JUMP_CLEAR_HEIGHT = 0.45; // player.y above this clears a 'low' obstacle
const GAME_SLIDE_DURATION_MS = 600;
const GAME_COLLISION_WINDOW = 0.9; // how close (in z) an obstacle must be to the player to resolve
const GAME_LANE_KEY_COOLDOWN_MS = 150;
const GAME_SCENERY_X = GAME_ROAD_WIDTH / 2 + 2; // just outside the road's edge

// Discrete difficulty stages by distance traveled — each locks in its own
// target speed (eased into smoothly, see gameCurrentSpeed in gameLoop) and
// its own sky/fog color, so progression reads as distinct "stages" rather
// than a silent, continuous speed-up. Obstacle density/variety instead comes
// from which GAME_ROW_PATTERNS are unlocked per stage (see minStage below)
// and, past the last named stage, from gameGetEffectiveStage's "Overtime"
// escalation, which keeps raising speed indefinitely so skilled, very long
// runs keep getting harder instead of plateauing forever.
const GAME_STAGES = [
  { name: 'Warm-up', minDistance: 0, speed: 9, skyTop: '#ffe9c7', skyBottom: '#ffdca8', fog: 0xffdca8 },
  { name: 'Lunch Rush', minDistance: 150, speed: 13, skyTop: '#ffd1a9', skyBottom: '#ffb199', fog: 0xffb199 },
  { name: 'Rush Hour', minDistance: 350, speed: 17, skyTop: '#ffab91', skyBottom: '#ff8a65', fog: 0xff8a65 },
  { name: 'Last Call', minDistance: 600, speed: 21, skyTop: '#9586d1', skyBottom: '#6a5acd', fog: 0x6a5acd }
];
const GAME_OVERTIME_STEP = 200; // extra distance per additional "Overtime N" level past the last named stage
const GAME_OVERTIME_SPEED_INC = 2; // speed added per overtime level
const GAME_OVERTIME_MAX_SPEED = 36; // hard ceiling so it never becomes literally unplayable
const GAME_OVERTIME_MIN_GAP = 5; // floor for the row-spawn gap (see gameSpawnRow's interval), down from the base 8–14

// Curated row layouts rather than independently-rolled-per-lane randomness —
// hand-designed patterns read as intentional challenges instead of noise,
// and let us guarantee interesting variety (zigzags, walls, mixed rows).
// Every pattern keeps at least one 'C' (clear) lane. Later stages unlock
// busier/trickier patterns via minStage.
const GAME_ROW_PATTERNS = [
  { minStage: 0, pattern: ['C', 'C', 'C', 'C'] },
  { minStage: 0, pattern: ['B', 'C', 'C', 'C'] },
  { minStage: 0, pattern: ['C', 'B', 'C', 'C'] },
  { minStage: 0, pattern: ['C', 'C', 'B', 'C'] },
  { minStage: 0, pattern: ['C', 'C', 'C', 'B'] },
  { minStage: 0, pattern: ['L', 'L', 'L', 'C'] },
  { minStage: 0, pattern: ['C', 'L', 'L', 'L'] },
  { minStage: 1, pattern: ['H', 'H', 'H', 'C'] },
  { minStage: 1, pattern: ['C', 'H', 'H', 'H'] },
  { minStage: 1, pattern: ['B', 'C', 'B', 'C'] },
  { minStage: 1, pattern: ['C', 'B', 'C', 'B'] },
  { minStage: 2, pattern: ['L', 'C', 'H', 'C'] },
  { minStage: 2, pattern: ['C', 'H', 'C', 'L'] },
  { minStage: 2, pattern: ['B', 'L', 'C', 'H'] },
  { minStage: 3, pattern: ['H', 'C', 'L', 'B'] },
  { minStage: 3, pattern: ['B', 'H', 'C', 'B'] },
  { minStage: 3, pattern: ['L', 'B', 'C', 'L'] },
  // Ramp rows — a Subway-Surfers-style launch pad: hitting one auto-boosts
  // the player into a high arc (see the 'ramp' handling in gameLoop) with a
  // brief invulnerability window, so it always reads as a fun, rewarding
  // shortcut rather than a trap, regardless of what the next row holds.
  { minStage: 0, pattern: ['R', 'C', 'C', 'C'] },
  { minStage: 0, pattern: ['C', 'R', 'C', 'C'] },
  { minStage: 1, pattern: ['R', 'C', 'L', 'C'] },
  { minStage: 2, pattern: ['B', 'R', 'C', 'B'] },
  // Shield rows — rarer than ramps, and only appear once things are
  // genuinely busy (higher stages), since a shield's whole point is to buy
  // some breathing room through a dense stretch.
  { minStage: 2, pattern: ['S', 'C', 'C', 'C'] },
  { minStage: 3, pattern: ['C', 'S', 'C', 'C'] }
];
const GAME_PATTERN_KIND = { C: 'clear', B: 'block', L: 'low', H: 'high', R: 'ramp', S: 'shield' };
const GAME_FOOD_STREAK_WINDOW_MS = 4000; // consecutive catches within this gap keep the combo alive
const GAME_HIT_STUN_MS = 350; // freeze + shake/flash this long before the real game-over fires
const GAME_RAMP_LAUNCH_VELOCITY = 11; // well above GAME_JUMP_VELOCITY, for a dramatic soaring arc
const GAME_RAMP_INVULN_MS = 1200; // ignore collisions while airborne from a ramp boost
const GAME_SHIELD_DURATION_MS = 5000; // how long a collected shield power-up ignores collisions

// Subway-Surfers-style avatar choice — purely cosmetic (body/head/hat
// colors), applied by recoloring the existing player mesh materials.
// The player model's own baked textures aren't safely retintable by name
// (see gameApplyAvatarColors), so "avatar" choice is a colored accessory
// cap on the model rather than a full outfit recolor.
const GAME_AVATARS = [
  { id: 'classic', name: 'Classic', color: 0x6366f1 },
  { id: 'fire', name: 'Fire', color: 0xef4444 },
  { id: 'ocean', name: 'Ocean', color: 0x0891b2 },
  { id: 'sunshine', name: 'Sunshine', color: 0xf59e0b },
  { id: 'grape', name: 'Grape', color: 0x9333ea },
  { id: 'mint', name: 'Mint', color: 0x10b981 }
];
const GAME_AVATARS_DEFAULT_ID = GAME_AVATARS[0].id;

let gameRenderer = null;
let gameComposer = null;
let gameBloomPass = null;
let gameScene = null;
let gameCamera = null;
let gamePlayerMesh = null; // wrapper Group holding the loaded GLTF model, so it moves/leans/squashes as one unit
let gamePlayerModel = null; // the GLTF model's root scene node, inside gamePlayerMesh
let gamePlayerMixer = null; // drives the model's built-in run animation
let gamePlayerAvatarCap = null; // small colored accessory recolored per avatar (see GAME_AVATARS)
let gameGroundShadow = null;
let gameRoadTexture = null;
let gameObjects = []; // { mesh, lane, kind: 'block'|'low'|'high'|'food', resolved }
let gameScenery = []; // roadside decoration meshes, purely cosmetic
let gameRunning = false;
let gamePhase = 'playing'; // 'countdown' | 'playing'
let gameAnimHandle = null;
let gameLastTimestamp = 0;
let gameCountdownEndAt = 0;
let gameDistance = 0; // drives score + stage progression
let gameCurrentSpeed = GAME_STAGES[0].speed; // eases toward the current stage's target each frame
let gameStageIndex = 0;
let gameStageToastTimeout = null;
let gameSpawnAccumulator = 0;
let gameNextSpawnDistance = 10;
let gameNextSceneryDistance = 0;
let gamePlayerLane = Math.floor(GAME_LANE_COUNT / 2);
let gamePlayerX = 0;
let gamePlayerY = 0;
let gamePlayerVY = 0;
let gameIsJumping = false;
let gameIsSliding = false;
let gameSlideEndAt = 0;
let gameLastLaneKeyAt = 0;
let gameScore = 0;
let gameAudioCtx = null;
let gameDustTexture = null;
let gameBarrierTexture = null;
let gameDustParticles = []; // { sprite, vx, vy, life, maxLife }
let gameLandBounceAt = -Infinity; // timestamp of last landing, drives the squash-and-stretch
let gameFoodStreak = 0;
let gameLastFoodCatchAt = -Infinity;
let gameHitEndAt = 0;
let gameRampInvulnUntil = 0;
let gameShieldUntil = 0;
let gamePlayerShieldAura = null;
let gameOvertimeLevel = 0; // 0 while still within the named GAME_STAGES; increments past the last one
let gameSessionToken = null; // issued by POST /api/game/session/start, required by POST /api/game/score
let gamePaused = false;
let gameCoinsCollected = 0;
let gameRampsHit = 0;
let gameBestCombo = 0;
let gameSun = null;
let gameCloudTexture = null;
let gameClouds = [];
let gameNameSprite = null;
let gameSelectedAvatarId = GAME_AVATARS_DEFAULT_ID;

function gameHighScoreKey() {
  return `lunchsync_runner_best_${currentUser?.id || 'anon'}`;
}

function getGameBestScore() {
  return Number(localStorage.getItem(gameHighScoreKey())) || 0;
}

function gameAvatarStorageKey() {
  return `lunchsync_runner_avatar_${currentUser?.id || 'anon'}`;
}

function gameLoadAvatarPreference() {
  const saved = localStorage.getItem(gameAvatarStorageKey());
  gameSelectedAvatarId = GAME_AVATARS.some(a => a.id === saved) ? saved : GAME_AVATARS_DEFAULT_ID;
}

// The player model is now a real textured GLTF asset, so we can't safely
// retint its baked materials by name without inspecting this specific file.
// Avatar choice instead recolors a small accessory cap worn on the model —
// still a clear, reliable per-user visual distinction.
function gameApplyAvatarColors() {
  const avatar = GAME_AVATARS.find(a => a.id === gameSelectedAvatarId) || GAME_AVATARS[0];
  if (gamePlayerAvatarCap) gamePlayerAvatarCap.material.color.setHex(avatar.color);
}

function gameSelectAvatar(id) {
  if (!GAME_AVATARS.some(a => a.id === id) || id === gameSelectedAvatarId) return;
  gameSelectedAvatarId = id;
  localStorage.setItem(gameAvatarStorageKey(), id);
  gameApplyAvatarColors();
  gameRenderAvatarPicker();
  if (gameRenderer && !gameRunning) gameComposer.render();
}

// Builds the avatar swatch row shown in the start/game-over overlay —
// plain colored circles are enough to read as distinct characters without
// needing separate preview models.
function gameRenderAvatarPicker() {
  if (!gameAvatarPickerEl) return;
  gameAvatarPickerEl.innerHTML = '';
  GAME_AVATARS.forEach(avatar => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'game-avatar-swatch' + (avatar.id === gameSelectedAvatarId ? ' selected' : '');
    btn.title = avatar.name;
    btn.style.setProperty('--swatch-color', `#${avatar.color.toString(16).padStart(6, '0')}`);
    btn.addEventListener('click', () => gameSelectAvatar(avatar.id));
    gameAvatarPickerEl.appendChild(btn);
  });
}

// Renders an emoji onto a small canvas and wraps it as a camera-facing
// sprite — the cheapest way to get thematic "food" visuals in 3D without
// shipping/loading real model assets.
function gameMakeEmojiSprite(emoji, size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.font = `${Math.round(size * 0.8)}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, size / 2, size / 2 + size * 0.05);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
  sprite.scale.set(0.9, 0.9, 0.9);
  return sprite;
}

// A name-plate sprite that floats above the player's head — rendered once
// per game session (name doesn't change mid-run), not a child of
// gamePlayerMesh so squash/slide scaling never distorts it (see
// gameUpdatePlayerMesh, which repositions it manually instead).
function gameMakeNameTagSprite(name) {
  const label = (name || 'Player').trim().slice(0, 18) || 'Player';
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  measureCtx.font = '28px sans-serif';
  const textWidth = measureCtx.measureText(label).width;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(textWidth) + 32;
  canvas.height = 44;
  const ctx = canvas.getContext('2d');
  ctx.font = '28px sans-serif';

  const r = 10;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(canvas.width, 0, canvas.width, canvas.height, r);
  ctx.arcTo(canvas.width, canvas.height, 0, canvas.height, r);
  ctx.arcTo(0, canvas.height, 0, 0, r);
  ctx.arcTo(0, 0, canvas.width, 0, r);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, canvas.width / 2, canvas.height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(0.32 * aspect, 0.32, 1);
  return sprite;
}

// A simple striped lane-divider texture, scrolled each frame to sell the
// sense of forward motion even though the road plane itself never moves.
function gameMakeRoadTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#33415c';
  ctx.fillRect(0, 0, 64, 256);
  // subtle asphalt speckle so the road reads as a textured surface up close,
  // not a flat color fill
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.06})`;
    ctx.fillRect(Math.random() * 64, Math.random() * 256, 1, 1);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 2;
  ctx.setLineDash([22, 18]);
  for (let i = 1; i < GAME_LANE_COUNT; i++) {
    const x = (64 / GAME_LANE_COUNT) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 256);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 30);
  return texture;
}

// A simple vertical-gradient sky, regenerated per stage rather than
// animated/crossfaded — the hard cut doubles as a clear "new stage" beat.
function gameMakeSkyTexture(topColor, bottomColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, topColor);
  gradient.addColorStop(0.55, bottomColor);
  gradient.addColorStop(1, bottomColor);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 2, 256);
  return new THREE.CanvasTexture(canvas);
}

// A soft multi-blob cloud, drawn once and reused as a sprite texture for
// every drifting background cloud (see gameSpawnCloud).
function gameMakeCloudTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.filter = 'blur(4px)';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  [[32, 34, 22], [56, 26, 26], [82, 34, 20], [102, 30, 16]].forEach(([x, y, r]) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  });
  return new THREE.CanvasTexture(canvas);
}

// A slow-drifting background cloud — purely atmospheric parallax. Loops back
// to a far position once it passes the camera rather than being destroyed,
// so a small fixed pool runs for the whole game.
function gameSpawnCloud(far) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: gameCloudTexture, transparent: true, opacity: 0.8, fog: false, depthWrite: false
  }));
  const scale = 10 + Math.random() * 6;
  sprite.scale.set(scale, scale * 0.5, 1);
  sprite.position.set(
    (Math.random() - 0.5) * 60,
    10 + Math.random() * 10,
    far ? -100 - Math.random() * 30 : -40 - Math.random() * 60
  );
  gameScene.add(sprite);
  gameClouds.push(sprite);
}

// A roadside decoration — picked from a small set of street-market
// archetypes (food stall, lamp post, tree, building) rather than one plain
// box shape repeated, so the street reads as a place, not filler geometry.
function gameMakeSceneryMesh() {
  const kind = ['stall', 'lamp', 'tree', 'building'][Math.floor(Math.random() * 4)];
  const group = new THREE.Group();

  if (kind === 'stall') {
    const hue = Math.random() * 0.12;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 1.6, 8),
      new THREE.MeshStandardMaterial({ color: 0x8d6e63 })
    );
    pole.position.y = 0.8;
    group.add(pole);
    const canopy = new THREE.Mesh(
      new THREE.ConeGeometry(1.1, 0.9, 8),
      new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue, 0.65, 0.55) })
    );
    canopy.position.y = 2;
    group.add(canopy);
  } else if (kind === 'lamp') {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 3, 8),
      new THREE.MeshStandardMaterial({ color: 0x37474f })
    );
    pole.position.y = 1.5;
    group.add(pole);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 10, 10),
      new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xffdd88, emissiveIntensity: 0.6 })
    );
    bulb.position.y = 3.1;
    group.add(bulb);
  } else if (kind === 'tree') {
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.18, 1.4, 8),
      new THREE.MeshStandardMaterial({ color: 0x795548 })
    );
    trunk.position.y = 0.7;
    group.add(trunk);
    const foliage = new THREE.Mesh(
      new THREE.SphereGeometry(0.9 + Math.random() * 0.3, 10, 10),
      new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.3, 0.45, 0.35 + Math.random() * 0.1) })
    );
    foliage.position.y = 1.9;
    group.add(foliage);
  } else {
    const height = 2 + Math.random() * 4.5;
    const hue = 0.07 + Math.random() * 0.08;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(1.6 + Math.random(), height, 1.6 + Math.random()),
      new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue, 0.35, 0.4 + Math.random() * 0.15) })
    );
    box.position.y = height / 2;
    group.add(box);
  }

  group.traverse(obj => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });
  return group;
}

// A soft radial-gradient dot used for both landing-dust puffs — one shared
// texture, many cheap sprite instances.
function gameMakeDustTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(255,255,255,0.85)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(canvas);
}

// Hazard-yellow diagonal stripes, used for the block/jump obstacles —
// reads instantly as "barrier" the way a flat color block doesn't.
function gameMakeBarrierTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#facc15';
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 11;
  ctx.save();
  ctx.translate(32, 32);
  ctx.rotate(Math.PI / 4);
  for (let x = -96; x < 96; x += 24) {
    ctx.beginPath();
    ctx.moveTo(x, -96);
    ctx.lineTo(x, 96);
    ctx.stroke();
  }
  ctx.restore();
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 1);
  return texture;
}

// A short puff of dust at the player's feet on landing — classic cheap trick
// that sells "impact" far better than the squash-and-stretch alone.
function gameSpawnDust(x) {
  for (let i = 0; i < 5; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: gameDustTexture, transparent: true, opacity: 0.6, depthWrite: false
    }));
    sprite.scale.set(0.35, 0.35, 0.35);
    sprite.position.set(x + (Math.random() - 0.5) * 0.5, 0.05, (Math.random() - 0.5) * 0.3);
    gameScene.add(sprite);
    gameDustParticles.push({
      sprite,
      vx: (Math.random() - 0.5) * 1.4,
      vy: 0.5 + Math.random() * 0.6,
      life: 0,
      maxLife: 0.35 + Math.random() * 0.2
    });
  }
}

// A brief floating text cue (near-miss, combo) layered over the canvas —
// plain DOM is simpler and cheaper than world-space 3D text for this.
function gameShowPopup(text, variant) {
  const el = document.createElement('div');
  el.className = variant ? `game-popup ${variant}` : 'game-popup';
  el.textContent = text;
  gamePopupLayerEl.appendChild(el);
  setTimeout(() => el.remove(), 950);
}

function gameSpawnScenery() {
  [-1, 1].forEach(side => {
    const mesh = gameMakeSceneryMesh();
    mesh.position.x = side * (GAME_SCENERY_X + Math.random() * 3);
    mesh.position.z = GAME_SPAWN_Z - Math.random() * 15;
    gameScene.add(mesh);
    gameScenery.push(mesh);
  });
}

// Builds the renderer/scene/camera/road once Three.js is loaded, then
// paints a static first frame — called on first opening the tab and on
// resize (only while not mid-run, so a resize never disrupts a game).
async function initGameCanvas() {
  try {
    await Promise.all([loadThreeJs(), loadGLTFLoader(), loadPostprocessing()]);
  } catch (err) {
    console.error('Failed to load 3D engine:', err);
    gameOverlayText.textContent = "Couldn't load the 3D engine — check your connection and reopen this tab.";
    return;
  }

  const width = Math.round(gameCanvasWrap.clientWidth);
  const height = Math.round(width * 0.6);

  if (!gameRenderer) {
    try {
      gameRenderer = new THREE.WebGLRenderer({ canvas: gameCanvas, antialias: true });
    } catch (err) {
      console.error('WebGL unavailable:', err);
      gameOverlayText.textContent = '3D isn\'t supported in this browser.';
      return;
    }
    gameRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    gameRenderer.outputColorSpace = THREE.SRGBColorSpace;
    gameRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    gameRenderer.toneMappingExposure = 1.15;
    gameRenderer.shadowMap.enabled = true;
    gameRenderer.shadowMap.type = THREE.PCFSoftShadowMap;

    gameScene = new THREE.Scene();
    const stage0 = GAME_STAGES[0];
    gameScene.background = gameMakeSkyTexture(stage0.skyTop, stage0.skyBottom);
    gameScene.fog = new THREE.Fog(stage0.fog, 20, 55);

    gameCamera = new THREE.PerspectiveCamera(62, width / height, 0.1, 200);

    // Composer wraps the plain renderer with a bloom pass so bright
    // highlights (sun glints, lamp bulbs, gold coins) actually glow instead
    // of just being a flat bright color.
    gameComposer = new EffectComposerClass(gameRenderer);
    gameComposer.addPass(new RenderPassClass(gameScene, gameCamera));
    gameBloomPass = new UnrealBloomPassClass(new THREE.Vector2(width, height), 0.45, 0.4, 0.86);
    gameComposer.addPass(gameBloomPass);
    gameComposer.addPass(new OutputPassClass());

    gameScene.add(new THREE.AmbientLight(0xffffff, 0.5));
    gameScene.add(new THREE.HemisphereLight(0xffe9c7, 0x30261c, 0.5));
    gameSun = new THREE.DirectionalLight(0xffffff, 1);
    gameSun.position.set(4, 10, 6);
    gameSun.castShadow = true;
    gameSun.shadow.mapSize.set(1024, 1024);
    gameSun.shadow.camera.left = -8;
    gameSun.shadow.camera.right = 8;
    gameSun.shadow.camera.top = 10;
    gameSun.shadow.camera.bottom = -12;
    gameSun.shadow.camera.near = 1;
    gameSun.shadow.camera.far = 30;
    gameSun.shadow.bias = -0.002;
    gameScene.add(gameSun);
    gameScene.add(gameSun.target);

    gameDustTexture = gameMakeDustTexture();
    gameBarrierTexture = gameMakeBarrierTexture();
    gameCloudTexture = gameMakeCloudTexture();
    for (let i = 0; i < 5; i++) gameSpawnCloud(false);

    gameRoadTexture = gameMakeRoadTexture();
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(GAME_ROAD_WIDTH, 240),
      new THREE.MeshStandardMaterial({ map: gameRoadTexture })
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, -90);
    road.receiveShadow = true;
    gameScene.add(road);

    // Sidewalk curbs along both edges of the road — a cheap read of "street"
    // rather than a strip of asphalt floating in a void.
    const curbMat = new THREE.MeshStandardMaterial({ color: 0xcfd8dc });
    [-1, 1].forEach(side => {
      const curb = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.15, 240), curbMat);
      curb.position.set(side * (GAME_ROAD_WIDTH / 2 + 0.2), 0.075, -90);
      curb.receiveShadow = true;
      gameScene.add(curb);
    });

    // A soft blob shadow under the player — shrinks/fades with jump height.
    // Kept as a subtle extra on top of the real shadow map below since it
    // reacts instantly to jump height, which the shadow map alone reads less
    // clearly at a glance.
    gameGroundShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.45, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 })
    );
    gameGroundShadow.rotation.x = -Math.PI / 2;
    gameGroundShadow.position.y = 0.02;
    gameScene.add(gameGroundShadow);

    // Player is a real rigged GLTF humanoid (three.js's own MIT-licensed
    // example asset) rather than hand-built primitives, with its own "Run"
    // animation played through an AnimationMixer (updated in gameLoop).
    // gamePlayerMesh stays a plain wrapper Group so lean/squash/slide still
    // just scale/rotate one object, regardless of what model is inside it.
    gamePlayerMesh = new THREE.Group();
    gameScene.add(gamePlayerMesh);

    try {
      const loader = new GLTFLoaderClass();
      const gltf = await loader.loadAsync(GAME_PLAYER_MODEL_URL);
      gamePlayerModel = gltf.scene;

      gamePlayerModel.traverse(obj => {
        if (obj.isMesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
        }
      });

      // Auto-fit: scale the model (whatever its native units are) to a
      // known target height, then plant its feet at local y=0 — avoids
      // hardcoding a scale factor guessed from this specific file.
      // updateMatrixWorld(true) is required here: a freshly-loaded scene's
      // world matrices aren't computed until the next render, so measuring
      // the bounding box without it reads near-zero size — which is exactly
      // what blew the auto-fit scale up to "giant" (camera ends up inside
      // the oversized model).
      gamePlayerModel.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(gamePlayerModel);
      const rawHeight = box.max.y - box.min.y || 1;
      const scale = GAME_PLAYER_TARGET_HEIGHT / rawHeight;
      gamePlayerModel.scale.setScalar(scale);
      gamePlayerModel.updateMatrixWorld(true);
      const fittedBox = new THREE.Box3().setFromObject(gamePlayerModel);
      gamePlayerModel.position.y -= fittedBox.min.y;

      gamePlayerMesh.add(gamePlayerModel);

      gamePlayerMixer = new THREE.AnimationMixer(gamePlayerModel);
      const runClip = THREE.AnimationClip.findByName(gltf.animations, 'Run') || gltf.animations[0];
      if (runClip) {
        gamePlayerMixer.clipAction(runClip).play();
      }

      // A small colored accessory cap — the model's own baked clothing
      // textures aren't safely retintable by name, so this is what avatar
      // choice (see GAME_AVATARS) actually changes.
      // A full helmet rather than a thin top cap — sized/positioned to sit
      // over the model's actual head, so avatar color is obvious instead of
      // reading as a tiny disconnected dot floating above it.
      gamePlayerAvatarCap = new THREE.Mesh(
        new THREE.SphereGeometry(GAME_PLAYER_TARGET_HEIGHT * 0.095, 16, 16),
        new THREE.MeshStandardMaterial({ color: 0x6366f1 })
      );
      gamePlayerAvatarCap.position.y = GAME_PLAYER_TARGET_HEIGHT * 0.93;
      gamePlayerAvatarCap.castShadow = true;
      gamePlayerMesh.add(gamePlayerAvatarCap);

      // A translucent glowing shell shown only while a shield power-up is
      // active (see gameUpdatePlayerMesh and the 'shield' collision case).
      gamePlayerShieldAura = new THREE.Mesh(
        new THREE.SphereGeometry(GAME_PLAYER_TARGET_HEIGHT * 0.65, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.25, depthWrite: false })
      );
      gamePlayerShieldAura.position.y = GAME_PLAYER_TARGET_HEIGHT * 0.5;
      gamePlayerShieldAura.visible = false;
      gamePlayerMesh.add(gamePlayerShieldAura);
    } catch (err) {
      console.error('Failed to load player model:', err);
      gameOverlayText.textContent = "Couldn't load the player model — check your connection and reopen this tab.";
      return;
    }

    // A floating name tag above the player's head — a separate top-level
    // sprite (not a child of gamePlayerMesh) so the squash/slide scaling
    // applied to the body never distorts its size; position is synced in
    // gameUpdatePlayerMesh instead.
    gameNameSprite = gameMakeNameTagSprite(currentUser?.name);
    gameScene.add(gameNameSprite);

    gameLoadAvatarPreference();
    gameApplyAvatarColors();
    gameRenderAvatarPicker();
  }

  gameRenderer.setSize(width, height, false);
  gameComposer.setSize(width, height);
  gameBloomPass.resolution.set(width, height);
  gameCamera.aspect = width / height;
  gameCamera.updateProjectionMatrix();

  gameBestScoreEl.textContent = getGameBestScore();
  gameStageLabelEl.textContent = GAME_STAGES[0].name;
  gamePlayerLane = Math.floor(GAME_LANE_COUNT / 2);
  gamePlayerX = GAME_LANE_CENTERS[gamePlayerLane];
  gamePlayerY = 0;
  gameUpdatePlayerMesh();
  gameUpdateCamera();
  gameComposer.render(); // paint a static frame behind the "Start Game" overlay
}

function gameClearObjects() {
  gameObjects.forEach(obj => gameScene.remove(obj.mesh));
  gameObjects = [];
  gameScenery.forEach(mesh => gameScene.remove(mesh));
  gameScenery = [];
  gameDustParticles.forEach(p => gameScene.remove(p.sprite));
  gameDustParticles = [];
}

function resetGameState() {
  gameScore = 0;
  gameDistance = 0;
  gameStageIndex = 0;
  gameCurrentSpeed = GAME_STAGES[0].speed;
  gameSpawnAccumulator = 0;
  gameNextSpawnDistance = 10;
  gameNextSceneryDistance = 0;
  gamePlayerLane = Math.floor(GAME_LANE_COUNT / 2);
  gamePlayerX = GAME_LANE_CENTERS[gamePlayerLane];
  gamePlayerY = 0;
  gamePlayerVY = 0;
  gameIsJumping = false;
  gameIsSliding = false;
  gameLandBounceAt = -Infinity;
  gameFoodStreak = 0;
  gameLastFoodCatchAt = -Infinity;
  gameRampInvulnUntil = 0;
  gameShieldUntil = 0;
  gameOvertimeLevel = 0;
  gamePaused = false;
  gamePauseOverlayEl.classList.add('hidden');
  gameCoinsCollected = 0;
  gameRampsHit = 0;
  gameBestCombo = 0;
  gameOverlayStatsEl.classList.add('hidden');
  gameOverlayStatsEl.innerHTML = '';
  gameClearObjects();
  gameUpdatePlayerMesh();
  gameScoreEl.textContent = '0';
  gameStageLabelEl.textContent = GAME_STAGES[0].name;
  gameStageToastEl.classList.remove('visible');
  gameHitFlashEl.classList.remove('visible');
  gamePopupLayerEl.innerHTML = '';
}

// Returns the stage currently in effect — one of the named GAME_STAGES
// normally, or a synthesized "Overtime N" stage once distance runs past the
// last named one, with speed (and the row-spawn gap, see gameSpawnRow)
// continuing to escalate every GAME_OVERTIME_STEP distance so a long,
// skilled run never just plateaus.
function gameGetEffectiveStage() {
  const lastIndex = GAME_STAGES.length - 1;
  const last = GAME_STAGES[lastIndex];
  if (gameStageIndex !== lastIndex || gameDistance < last.minDistance) {
    return { ...GAME_STAGES[gameStageIndex], overtimeLevel: 0 };
  }
  const level = Math.floor((gameDistance - last.minDistance) / GAME_OVERTIME_STEP);
  if (level <= 0) return { ...last, overtimeLevel: 0 };
  return {
    ...last,
    name: `Overtime ${level}`,
    speed: Math.min(GAME_OVERTIME_MAX_SPEED, last.speed + level * GAME_OVERTIME_SPEED_INC),
    overtimeLevel: level
  };
}

// Called whenever gameDistance crosses into a new stage's threshold —
// swaps the sky/fog instantly (a clean beat, not a crossfade) and shows a
// brief "Stage N: Name!" toast + chime. Speed itself still eases in, see
// gameLoop, so the *feel* ramps smoothly even though the visuals cut hard.
function gameOnStageChange(stage, stageNumber) {
  gameScene.background = gameMakeSkyTexture(stage.skyTop, stage.skyBottom);
  gameScene.fog.color.set(stage.fog);
  gameStageLabelEl.textContent = stage.name;

  gameStageToastEl.textContent = `Stage ${stageNumber}: ${stage.name}!`;
  gameStageToastEl.classList.add('visible');
  clearTimeout(gameStageToastTimeout);
  gameStageToastTimeout = setTimeout(() => gameStageToastEl.classList.remove('visible'), 1800);

  gamePlayTone(700, 0.1, 'triangle', 0.06);
  setTimeout(() => gamePlayTone(920, 0.12, 'triangle', 0.06), 110);
}

// Auto-pauses a running game when its browser tab goes into the background,
// so leaving mid-run never comes back to a surprise death from obstacles
// that kept scrolling while unseen. Resuming is a deliberate tap, not
// automatic on return, so play only continues when the user is ready.
function gamePauseGame() {
  if (!gameRunning || gamePaused || gamePhase === 'hit') return;
  gamePaused = true;
  if (gameAnimHandle) cancelAnimationFrame(gameAnimHandle);
  gamePauseOverlayEl.classList.remove('hidden');
}

function gameResumeGame() {
  if (!gameRunning || !gamePaused) return;
  gamePaused = false;
  gamePauseOverlayEl.classList.add('hidden');
  gameLastTimestamp = performance.now(); // avoid a huge dt jump for the time spent paused
  gameAnimHandle = requestAnimationFrame(gameLoop);
}

function startGame() {
  if (!gameRenderer) return; // 3D engine failed to load — nothing to start
  resetGameState();
  gameEnsureAudio();
  gameOverlay.classList.add('hidden');
  gameRunning = true;
  gamePhase = 'countdown';
  gameCountdownEndAt = performance.now() + 3000;
  gameLastTimestamp = performance.now();
  gameAnimHandle = requestAnimationFrame(gameLoop);

  // Fetched in parallel rather than awaited, so the game starts instantly —
  // the server requires this token on score submission (see gameSubmitScore)
  // to sanity-check score against how long the run actually took.
  gameSessionToken = null;
  apiCall('/api/game/session/start', 'POST')
    .then(res => { gameSessionToken = res.sessionToken; })
    .catch(err => console.error('Failed to start game session:', err));
}

// Freezes gameplay for a short beat (camera shake + red flash, see gameLoop)
// before the real game-over fires, so a death reads as an impact.
function gameTriggerHit() {
  gamePhase = 'hit';
  gameHitEndAt = performance.now() + GAME_HIT_STUN_MS;
  gameHitFlashEl.classList.add('visible');
  setTimeout(() => gameHitFlashEl.classList.remove('visible'), GAME_HIT_STUN_MS);
}

function endGame() {
  gameRunning = false;
  if (gameAnimHandle) cancelAnimationFrame(gameAnimHandle);
  gamePlayGameOverChime();

  const best = getGameBestScore();
  if (gameScore > best) {
    localStorage.setItem(gameHighScoreKey(), String(gameScore));
    gameBestScoreEl.textContent = gameScore;
  }

  gameOverlayTitleEl.innerHTML = 'Game <span class="go-accent-red">Over!</span>';
  gameOverlayText.innerHTML = gameScore > best
    ? `New best! You scored <span class="go-accent-orange">${gameScore}</span>.`
    : `You scored <span class="go-accent-orange">${gameScore}</span>.`;
  btnGameStart.innerHTML = '<span class="material-symbols-outlined">replay</span><span>Play Again</span>';
  gameOverlayStatsEl.innerHTML = `<span>🪙 ${gameCoinsCollected}</span><span>⤴️ ${gameRampsHit}</span><span>x${Math.max(gameBestCombo, 1)} combo</span>`;
  gameOverlayStatsEl.classList.remove('hidden');
  gameOverlay.classList.remove('hidden');

  gameSubmitScore(gameScore);
}

// Reports the run to the company leaderboard — the server only ever raises
// the user's stored best (see submitGameScore in db.js), so it's safe to
// post every run rather than just new personal bests.
async function gameSubmitScore(score) {
  if (!gameSessionToken) return; // session token fetch hadn't resolved yet — skip rather than submit without proof of duration
  try {
    await apiCall('/api/game/score', 'POST', { score, sessionToken: gameSessionToken });
    loadGameLeaderboard();
  } catch (err) {
    console.error('Failed to submit game score:', err);
  }
}

let gameLeaderboardScope = 'week';

async function loadGameLeaderboard() {
  if (!gameLeaderboardListEl) return;
  try {
    const leaderboard = await apiCall(`/api/game/leaderboard?scope=${gameLeaderboardScope}`);
    gameRenderLeaderboard(leaderboard);
  } catch (err) {
    console.error('Failed to load leaderboard:', err);
  }
}

function gameRenderLeaderboard(entries) {
  gameLeaderboardListEl.innerHTML = '';
  if (!entries || entries.length === 0) {
    const li = document.createElement('li');
    li.className = 'game-leaderboard-empty';
    li.textContent = 'No scores yet — be the first!';
    gameLeaderboardListEl.appendChild(li);
    return;
  }
  entries.forEach((entry, i) => {
    const li = document.createElement('li');
    if (currentUser && entry.userId === currentUser.id) li.classList.add('me');
    const rank = document.createElement('span');
    rank.className = 'game-leaderboard-rank';
    rank.textContent = `#${i + 1}`;
    const name = document.createElement('span');
    name.className = 'game-leaderboard-name';
    name.textContent = entry.userName || 'Someone';
    const score = document.createElement('span');
    score.className = 'game-leaderboard-score';
    score.textContent = entry.score;
    li.append(rank, name, score);
    gameLeaderboardListEl.appendChild(li);
  });
}

function gameToggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    gameCanvasWrap.requestFullscreen?.().catch(() => {});
  }
}

// Resizes the renderer/camera to match the canvas wrap's current size
// without touching player/game state — safe to call mid-run (e.g. on
// entering/exiting fullscreen), unlike the fuller initGameCanvas() reset.
function gameResizeRendererOnly() {
  if (!gameRenderer) return;
  const width = Math.round(gameCanvasWrap.clientWidth);
  const height = Math.round(width * 0.6);
  gameRenderer.setSize(width, height, false);
  gameComposer.setSize(width, height);
  gameBloomPass.resolution.set(width, height);
  gameCamera.aspect = width / height;
  gameCamera.updateProjectionMatrix();
  if (!gameRunning) gameComposer.render();
}

function gameChangeLane(dir) {
  const now = performance.now();
  if (now - gameLastLaneKeyAt < GAME_LANE_KEY_COOLDOWN_MS) return;
  gameLastLaneKeyAt = now;
  gamePlayerLane = Math.max(0, Math.min(GAME_LANE_COUNT - 1, gamePlayerLane + dir));
}

function gameJump() {
  if (gameIsJumping || gameIsSliding) return;
  gameIsJumping = true;
  gamePlayerVY = GAME_JUMP_VELOCITY;
  gamePlayTone(480, 0.08, 'sine', 0.05);
}

function gameSlide() {
  if (gameIsJumping || gameIsSliding) return;
  gameIsSliding = true;
  gameSlideEndAt = performance.now() + GAME_SLIDE_DURATION_MS;
  gamePlayTone(300, 0.08, 'triangle', 0.05);
}

function gameUpdatePlayerMesh() {
  // A little bob while running on the ground (suppressed mid-air/slide) so
  // the character doesn't look like it's gliding.
  const bob = (!gameIsJumping && !gameIsSliding) ? Math.sin(gameDistance * 2.2) * 0.06 : 0;

  gamePlayerMesh.position.x = gamePlayerX;
  gamePlayerMesh.position.y = GAME_PLAYER_GROUND_Y + gamePlayerY + bob;

  // Squash-and-stretch on landing: briefly flatten vertically and bulge
  // horizontally, springing back to normal — classic weight/impact cue.
  const landT = Math.min((performance.now() - gameLandBounceAt) / 180, 1);
  const landSquash = landT < 1 ? 1 - Math.sin(landT * Math.PI) * 0.35 : 1;

  if (gameIsSliding) {
    gamePlayerMesh.scale.set(1, 0.5, 1);
    gamePlayerMesh.position.y -= 0.25; // keep feet on the ground while flattened
  } else {
    gamePlayerMesh.scale.set(1 + (1 - landSquash) * 0.3, landSquash, 1 + (1 - landSquash) * 0.3);
  }

  if (gameGroundShadow) {
    const shadowScale = Math.max(0.35, 1 - gamePlayerY * 0.45);
    gameGroundShadow.position.x = gamePlayerX;
    gameGroundShadow.scale.set(shadowScale, shadowScale, 1);
    gameGroundShadow.material.opacity = 0.22 * shadowScale;
  }

  if (gameNameSprite) {
    gameNameSprite.position.set(gamePlayerX, GAME_PLAYER_GROUND_Y + gamePlayerY + bob + GAME_PLAYER_TARGET_HEIGHT + 0.4, 0.1);
  }

  if (gamePlayerShieldAura) {
    const shieldActive = performance.now() < gameShieldUntil;
    gamePlayerShieldAura.visible = shieldActive;
    if (shieldActive) {
      gamePlayerShieldAura.scale.setScalar(1 + Math.sin(performance.now() * 0.01) * 0.05);
    }
  }
}

function gameUpdateCamera() {
  gameCamera.position.set(gamePlayerX * 0.6, 3.2, 6);
  gameCamera.lookAt(gamePlayerX * 0.3, 1, -8);
}

function gameLoop(timestamp) {
  if (!gameRunning) return;
  const dtMs = Math.min(timestamp - gameLastTimestamp, 50); // clamp to avoid huge jumps after a tab switch
  const dt = dtMs / 1000;
  gameLastTimestamp = timestamp;

  // Lane position eases toward its target for a smooth slide-between-lanes feel
  const targetX = GAME_LANE_CENTERS[gamePlayerLane];
  gamePlayerX += (targetX - gamePlayerX) * Math.min(1, 12 * dt);
  // Lean into the direction of travel — purely cosmetic, sells the lane change
  gamePlayerMesh.rotation.z = THREE.MathUtils.clamp((targetX - gamePlayerX) * -0.5, -0.35, 0.35);

  if (gameIsJumping) {
    gamePlayerY += gamePlayerVY * dt;
    gamePlayerVY -= GAME_GRAVITY * dt;
    if (gamePlayerY <= 0) {
      gamePlayerY = 0;
      gameIsJumping = false;
      gameLandBounceAt = performance.now();
      gameSpawnDust(gamePlayerX);
    }
  }
  if (gameIsSliding && performance.now() > gameSlideEndAt) {
    gameIsSliding = false;
  }

  gameUpdatePlayerMesh();
  gameUpdateCamera();
  if (gamePlayerMixer) gamePlayerMixer.update(dt);
  gameRoadTexture.offset.y -= dt * 0.8;

  // Keep the shadow-casting sun's target centered on the player so the
  // (necessarily tight) shadow frustum stays over the action as it moves
  // between lanes.
  if (gameSun) {
    gameSun.target.position.x = gamePlayerX;
    gameSun.position.x = gamePlayerX + 4;
  }

  // Background clouds drift at a constant, gentle pace regardless of game
  // speed/phase — pure atmosphere, looping back once they pass the camera.
  gameClouds.forEach(cloud => {
    cloud.position.z += dt * 0.6;
    if (cloud.position.z > 25) {
      cloud.position.z = -100 - Math.random() * 20;
      cloud.position.x = (Math.random() - 0.5) * 60;
      cloud.position.y = 10 + Math.random() * 10;
    }
  });

  if (gamePhase === 'countdown') {
    const remainingMs = gameCountdownEndAt - timestamp;
    if (remainingMs <= 0) {
      gamePhase = 'playing';
      gameCountdownEl.classList.add('hidden');
    } else {
      gameCountdownEl.classList.remove('hidden');
      gameCountdownEl.textContent = String(Math.ceil(remainingMs / 1000));
    }
    gameComposer.render();
    gameAnimHandle = requestAnimationFrame(gameLoop);
    return;
  }

  // A brief freeze-frame on collision — camera shakes and the screen flashes
  // red for a beat before the real game-over fires, so a death reads as an
  // impact rather than an abrupt stop.
  if (gamePhase === 'hit') {
    gameCamera.position.x += (Math.random() - 0.5) * 0.15;
    gameCamera.position.y += (Math.random() - 0.5) * 0.1;
    gameComposer.render();
    if (performance.now() >= gameHitEndAt) {
      endGame();
      return;
    }
    gameAnimHandle = requestAnimationFrame(gameLoop);
    return;
  }

  // Find the highest stage whose threshold we've crossed, and announce it
  // the moment it changes.
  let targetStageIndex = 0;
  for (let i = GAME_STAGES.length - 1; i >= 0; i--) {
    if (gameDistance >= GAME_STAGES[i].minDistance) { targetStageIndex = i; break; }
  }
  if (targetStageIndex !== gameStageIndex) {
    gameStageIndex = targetStageIndex;
    gameOvertimeLevel = 0;
    gameOnStageChange(GAME_STAGES[gameStageIndex], gameStageIndex + 1);
  }

  const effectiveStage = gameGetEffectiveStage();
  if (effectiveStage.overtimeLevel !== gameOvertimeLevel) {
    gameOvertimeLevel = effectiveStage.overtimeLevel;
    gameOnStageChange(effectiveStage, GAME_STAGES.length + gameOvertimeLevel);
  }

  // Actual speed eases toward the current stage's target rather than
  // snapping, so the stage-up *feels* like accelerating, not a jump-cut.
  gameCurrentSpeed += (effectiveStage.speed - gameCurrentSpeed) * Math.min(1, 1.5 * dt);
  const speed = gameCurrentSpeed;

  gameDistance += speed * dt;
  gameScore = Math.floor(gameDistance);
  gameScoreEl.textContent = gameScore;

  if (gameDistance >= gameNextSpawnDistance) {
    const gap = Math.max(GAME_OVERTIME_MIN_GAP, 8 - gameOvertimeLevel * 0.4) + Math.random() * 6;
    gameNextSpawnDistance = gameDistance + gap;
    gameSpawnRow();
  }
  if (gameDistance >= gameNextSceneryDistance) {
    gameNextSceneryDistance = gameDistance + 6 + Math.random() * 4;
    gameSpawnScenery();
  }

  const remainingScenery = [];
  for (const mesh of gameScenery) {
    mesh.position.z += speed * dt;
    if (mesh.position.z > GAME_REMOVE_Z + 10) {
      gameScene.remove(mesh);
      continue;
    }
    remainingScenery.push(mesh);
  }
  gameScenery = remainingScenery;

  const remainingDust = [];
  for (const p of gameDustParticles) {
    p.life += dt;
    const t = p.life / p.maxLife;
    if (t >= 1) {
      gameScene.remove(p.sprite);
      continue;
    }
    p.sprite.position.x += p.vx * dt;
    p.sprite.position.y += p.vy * dt;
    p.sprite.position.z += speed * dt; // scroll with the world like everything else
    p.sprite.material.opacity = 0.6 * (1 - t);
    p.sprite.scale.setScalar(0.35 + t * 0.3);
    remainingDust.push(p);
  }
  gameDustParticles = remainingDust;

  const remaining = [];
  for (const obj of gameObjects) {
    obj.mesh.position.z += speed * dt;
    if (obj.kind === 'food') obj.mesh.rotation.y += dt * 3;
    const z = obj.mesh.position.z;

    if (!obj.resolved && Math.abs(z) < GAME_COLLISION_WINDOW) {
      if (obj.lane === gamePlayerLane) {
        obj.resolved = true;
        if (obj.kind === 'food') {
          const now = performance.now();
          gameFoodStreak = (now - gameLastFoodCatchAt < GAME_FOOD_STREAK_WINDOW_MS) ? gameFoodStreak + 1 : 1;
          gameLastFoodCatchAt = now;
          gameBestCombo = Math.max(gameBestCombo, gameFoodStreak);
          gameCoinsCollected++;
          const bonus = 5 + Math.min(gameFoodStreak - 1, 10) * 2;
          gameScore += bonus;
          gameScoreEl.textContent = gameScore;
          gamePlayTone(640, 0.07, 'sine', 0.05);
          if (gameFoodStreak >= 3) gameShowPopup(`x${gameFoodStreak} Combo! +${bonus}`, 'combo');
          gameScene.remove(obj.mesh);
          continue;
        }
        if (obj.kind === 'ramp') {
          // Auto-launch into a high arc, Subway-Surfers-style, plus a brief
          // invulnerability window so whatever the flight path passes over
          // next can never cheaply end the run.
          gameIsJumping = true;
          gamePlayerVY = GAME_RAMP_LAUNCH_VELOCITY;
          gameRampInvulnUntil = performance.now() + GAME_RAMP_INVULN_MS;
          gameRampsHit++;
          gameScore += 5;
          gameScoreEl.textContent = gameScore;
          gamePlayTone(520, 0.1, 'sawtooth', 0.06);
          gameShowPopup('Boost!', 'combo');
          gameScene.remove(obj.mesh);
          continue;
        }
        if (obj.kind === 'shield') {
          gameShieldUntil = performance.now() + GAME_SHIELD_DURATION_MS;
          gameScore += 5;
          gameScoreEl.textContent = gameScore;
          gamePlayTone(880, 0.12, 'triangle', 0.06);
          gameShowPopup('Shield!', 'combo');
          gameScene.remove(obj.mesh);
          continue;
        }
        if (performance.now() < gameRampInvulnUntil || performance.now() < gameShieldUntil) {
          gameScene.remove(obj.mesh);
          continue;
        }
        const dodged = (obj.kind === 'low' && gamePlayerY > GAME_JUMP_CLEAR_HEIGHT)
          || (obj.kind === 'high' && gameIsSliding);
        if (!dodged) {
          gameScene.remove(obj.mesh);
          gameTriggerHit();
          // Keep the loop alive into the 'hit' phase handled at the top of
          // gameLoop — without scheduling the next frame here, the game
          // would just freeze forever and endGame() would never fire.
          gameComposer.render();
          gameAnimHandle = requestAnimationFrame(gameLoop);
          return;
        }
      } else if (obj.kind !== 'food' && obj.kind !== 'ramp' && obj.kind !== 'shield' && Math.abs(obj.lane - gamePlayerLane) === 1) {
        // Rewards tight dodges in an adjacent lane, not just surviving —
        // nudges players toward reading the road rather than drifting wide.
        obj.resolved = true;
        gameScore += 3;
        gameScoreEl.textContent = gameScore;
        gameShowPopup('Close one! +3', 'near-miss');
      }
    }

    if (z > GAME_REMOVE_Z) {
      gameScene.remove(obj.mesh);
      continue;
    }
    remaining.push(obj);
  }
  gameObjects = remaining;

  gameComposer.render();
  gameAnimHandle = requestAnimationFrame(gameLoop);
}

// Spawns one row by picking a curated pattern (see GAME_ROW_PATTERNS) rather
// than rolling each lane independently — every pattern already guarantees a
// clear lane and reads as a deliberate challenge instead of noise.
function gameSpawnRow() {
  const pool = GAME_ROW_PATTERNS.filter(p => p.minStage <= gameStageIndex);
  const choice = pool[Math.floor(Math.random() * pool.length)];

  // At most one food item per row, in one randomly chosen clear lane — food
  // is a pure bonus and should never tempt a cross-lane dash through
  // obstacle lanes to reach a second item in the same row.
  const clearLanes = [];
  choice.pattern.forEach((code, lane) => {
    if (GAME_PATTERN_KIND[code] === 'clear') clearLanes.push(lane);
  });
  const foodLane = clearLanes.length && Math.random() < 0.6
    ? clearLanes[Math.floor(Math.random() * clearLanes.length)]
    : -1;

  choice.pattern.forEach((code, lane) => {
    const kind = GAME_PATTERN_KIND[code];
    if (kind === 'clear') {
      if (lane === foodLane) gameSpawnFood(lane);
      return;
    }
    if (kind === 'ramp') {
      gameSpawnRamp(lane);
      return;
    }
    if (kind === 'shield') {
      gameSpawnShield(lane);
      return;
    }
    gameSpawnObstacle(lane, kind);
  });
}

// A ramp — a tilted wedge the player launches off automatically when it
// resolves in their lane (see gameLoop), Subway-Surfers-style. Visually a
// barrier-striped slope with an upward arrow so the "free boost" reads
// clearly rather than looking like another obstacle to dodge.
function gameSpawnRamp(lane) {
  const group = new THREE.Group();
  const wedge = new THREE.Mesh(
    new THREE.BoxGeometry(GAME_LANE_WIDTH * 0.8, 0.15, 1.6),
    new THREE.MeshStandardMaterial({ map: gameBarrierTexture })
  );
  wedge.rotation.x = -0.35;
  wedge.position.y = 0.3;
  wedge.position.z = -0.3;
  wedge.castShadow = true;
  wedge.receiveShadow = true;
  group.add(wedge);

  const label = gameMakeEmojiSprite('⤴️', 48);
  label.scale.set(0.5, 0.5, 0.5);
  label.position.y = 1.1;
  group.add(label);

  group.position.set(GAME_LANE_CENTERS[lane], 0, GAME_SPAWN_Z);
  gameScene.add(group);
  gameObjects.push({ mesh: group, lane, kind: 'ramp', resolved: false });
}

// A shield power-up — a glowing blue orb that grants temporary
// invulnerability on pickup (see the 'shield' collision case in gameLoop
// and the aura toggled in gameUpdatePlayerMesh).
function gameSpawnShield(lane) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 16, 16),
    new THREE.MeshStandardMaterial({
      color: 0x38bdf8, emissive: 0x0ea5e9, emissiveIntensity: 0.7, transparent: true, opacity: 0.85
    })
  );
  mesh.position.set(GAME_LANE_CENTERS[lane], 1, GAME_SPAWN_Z);
  gameScene.add(mesh);
  gameObjects.push({ mesh, lane, kind: 'shield', resolved: false });
}

// An obstacle is a small group (box + a floating emoji marker) rather than
// a bare box, so its required action (switch lane / jump / slide) reads at
// a glance instead of relying purely on color.
function gameSpawnObstacle(lane, kind) {
  const laneX = GAME_LANE_CENTERS[lane];
  const group = new THREE.Group();
  let box, boxY, labelEmoji, labelY;

  if (kind === 'block') {
    box = new THREE.Mesh(
      new THREE.BoxGeometry(GAME_LANE_WIDTH * 0.8, 1.4, 0.8),
      new THREE.MeshStandardMaterial({ map: gameBarrierTexture })
    );
    boxY = 0.7;
    labelEmoji = '🚫';
    labelY = 1.75;
  } else if (kind === 'low') {
    box = new THREE.Mesh(
      new THREE.BoxGeometry(GAME_LANE_WIDTH * 0.8, 0.5, 0.8),
      new THREE.MeshStandardMaterial({ map: gameBarrierTexture })
    );
    boxY = 0.25;
    labelEmoji = '⬆️';
    labelY = 0.95;
  } else {
    box = new THREE.Mesh(
      new THREE.BoxGeometry(GAME_LANE_WIDTH * 0.8, 0.4, 0.6),
      new THREE.MeshStandardMaterial({ color: 0x38bdf8 })
    );
    boxY = 1.3;
    labelEmoji = '⬇️';
    labelY = 1.85;
  }
  box.position.y = boxY;
  box.castShadow = true;
  box.receiveShadow = true;
  group.add(box);

  const label = gameMakeEmojiSprite(labelEmoji, 48);
  label.scale.set(0.5, 0.5, 0.5);
  label.position.y = labelY;
  group.add(label);

  group.position.set(laneX, 0, GAME_SPAWN_Z);
  gameScene.add(group);
  gameObjects.push({ mesh: group, lane, kind, resolved: false });
}

// A spinning gold coin rather than a food emoji — the classic runner-game
// pickup read, and it matches the barrier-and-coin visual language the rest
// of the scene is styled after. Spin is applied per-frame in gameLoop.
function gameSpawnFood(lane) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.28, 0.08, 20),
    new THREE.MeshStandardMaterial({
      color: 0xffd700, metalness: 0.75, roughness: 0.25, emissive: 0x7a5c00, emissiveIntensity: 0.2
    })
  );
  mesh.rotation.x = Math.PI / 2;
  mesh.castShadow = true;
  mesh.position.set(GAME_LANE_CENTERS[lane], 1, GAME_SPAWN_Z);
  gameScene.add(mesh);
  gameObjects.push({ mesh, lane, kind: 'food', resolved: false });
}

function gameSetupSwipeControls() {
  let touchStartX = 0, touchStartY = 0, touchStartTime = 0;
  gameCanvas.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchStartTime = performance.now();
  }, { passive: true });
  gameCanvas.addEventListener('touchend', (e) => {
    if (!gameRunning || gamePaused) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    if (performance.now() - touchStartTime > 600) return; // too slow to be a swipe
    if (Math.abs(dx) > Math.abs(dy)) {
      if (Math.abs(dx) > 30) gameChangeLane(dx > 0 ? 1 : -1);
    } else if (dy < -30) {
      gameJump();
    } else if (dy > 30) {
      gameSlide();
    }
  });
}

// On-screen tap buttons alongside swipe — shown only on touch devices via
// CSS (see .game-touch-controls), not feature-detected here. touchstart
// (rather than click) avoids the ~300ms synthetic-click delay and firing
// twice; preventDefault stops that trailing synthetic click from also firing.
function gameSetupTouchButtons() {
  const bind = (el, action) => {
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (!gameRunning || gamePaused) return;
      action();
    }, { passive: false });
  };
  bind(btnTouchLeft, () => gameChangeLane(-1));
  bind(btnTouchRight, () => gameChangeLane(1));
  bind(btnTouchJump, gameJump);
  bind(btnTouchSlide, gameSlide);
}

// Procedural sound effects via Web Audio — no audio files to ship or load.
// The context is created/resumed inside startGame(), which only ever runs
// from a real click, satisfying browsers' autoplay-requires-a-gesture rule.
function gameEnsureAudio() {
  try {
    if (!gameAudioCtx) gameAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    else if (gameAudioCtx.state === 'suspended') gameAudioCtx.resume();
  } catch (err) {
    gameAudioCtx = null; // Web Audio unavailable — game still works silently
  }
}

function gamePlayTone(freq, duration = 0.09, type = 'sine', gain = 0.06) {
  if (!gameAudioCtx) return;
  const osc = gameAudioCtx.createOscillator();
  const g = gameAudioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.value = gain;
  osc.connect(g).connect(gameAudioCtx.destination);
  const t0 = gameAudioCtx.currentTime;
  osc.start(t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.stop(t0 + duration);
}

function gamePlayGameOverChime() {
  [420, 340, 260].forEach((freq, i) => {
    setTimeout(() => gamePlayTone(freq, 0.18, 'triangle', 0.06), i * 140);
  });
}

// --- Event Listeners ---

function setupEventListeners() {
  // Show/hide toggles for every passcode field
  document.querySelectorAll('.toggle-passcode-visibility').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      const icon = btn.querySelector('.material-symbols-outlined');
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      icon.textContent = showing ? 'visibility' : 'visibility_off';
    });
  });

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

  // Company code / Platform Admin pre-auth screens
  btnCompanySubmit.addEventListener('click', handleCompanySubmit);
  companyCodeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleCompanySubmit();
  });
  linkPlatformLogin.addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState({}, '', '/platform');
    showPlatformLoginView();
  });
  linkBackToCompany.addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState({}, '', '/');
    if (currentCompany) {
      loadLoginList();
      showLoginView();
    } else {
      showCompanyView();
    }
  });
  linkNotYourCompany.addEventListener('click', (e) => {
    e.preventDefault();
    clearSavedCompany();
    roster = [];
    showCompanyView();
  });
  btnPlatformLogin.addEventListener('click', handlePlatformLogin);
  linkForgotPasscode.addEventListener('click', (e) => {
    e.preventDefault();
    showForgotPasscodeView();
  });
  linkBackToLoginFromForgot.addEventListener('click', (e) => {
    e.preventDefault();
    showLoginView();
  });
  btnForgotPasscodeSubmit.addEventListener('click', handleForgotPasscodeSubmit);
  btnResetPasscodeSubmit.addEventListener('click', handleResetPasscodeSubmit);
  platformLoginPasscode.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handlePlatformLogin();
  });

  // Companies tab (Platform Admin)
  btnAddCompany.addEventListener('click', () => openCompanyModal(null));
  btnCompanyModalClose.addEventListener('click', closeCompanyModal);
  btnCompanyCancel.addEventListener('click', closeCompanyModal);
  companyForm.addEventListener('submit', handleCompanyFormSubmit);

  btnLogout.addEventListener('click', logout);
  btnThemeToggle.addEventListener('click', toggleTheme);
  btnMobileMenuToggle.addEventListener('click', toggleMobileNav);
  sidebarOverlay.addEventListener('click', closeMobileNav);

  // Tab Buttons Switching
  navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.target);
    });
  });

  // Order Submit Action
  orderForm.addEventListener('submit', handleOrderSubmit);
  orderNoteInput.addEventListener('input', () => { orderFormDirty = true; });
  orderVariantSelect.addEventListener('change', () => { orderFormDirty = true; });

  // Change Selection Action
  btnChangeOrder.addEventListener('click', () => {
    isEditingOrder = true;
    orderFormDirty = false;
    renderFoodOrderForm();
  });
  btnCancelOrder.addEventListener('click', handleCancelOrder);

  // Order mode toggle: "Order for today" / "Plan my week"
  orderModeToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.order-mode-btn');
    if (btn) setOrderMode(btn.dataset.mode);
  });

  // Weekly plan grid — delegated since #week-grid is rebuilt on every render
  weekGrid.addEventListener('change', (e) => {
    const card = e.target.closest('.week-day-card');
    if (!card) return;
    const date = card.dataset.date;
    if (e.target.classList.contains('week-day-select')) {
      handleWeekDishChange(date, e.target.value);
    } else if (e.target.classList.contains('week-day-variant')) {
      const dishSelect = card.querySelector('.week-day-select');
      handleWeekVariantChange(date, dishSelect.value, e.target.value);
    }
  });
  weekGrid.addEventListener('input', (e) => {
    const card = e.target.closest('.week-day-card');
    if (!card) return;
    if (e.target.classList.contains('week-day-note')) {
      weekPlanDirtyDates.add(card.dataset.date);
    }
  });
  weekGrid.addEventListener('focusout', (e) => {
    const card = e.target.closest('.week-day-card');
    if (!card) return;
    if (e.target.classList.contains('week-day-note')) {
      handleWeekNoteCommit(card.dataset.date, e.target.value.trim());
    }
  });
  weekGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.week-day-card');
    const repeatBtn = e.target.closest('.week-day-repeat');
    if (!card || !repeatBtn) return;
    const select = card.querySelector('.week-day-select');
    if (select?.value) handleRepeatRestOfWeek(card.dataset.date, select.value);
  });

  // Live Summary Search
  summaryListSearch.addEventListener('input', renderDetailedBreakdownList);

  // Live Summary Export actions
  btnCopyWhatsapp.addEventListener('click', copyWhatsAppSummary);
  btnExportCsv.addEventListener('click', exportCsvSummary);
  btnRemindPending.addEventListener('click', remindPendingMembers);
  btnClearOrders.addEventListener('click', clearAllOrders);
  btnDismissReminder.addEventListener('click', dismissReminderBanner);
  btnDismissFoodArrived.addEventListener('click', dismissFoodArrivedBanner);
  btnEnableNotifications.addEventListener('click', enablePushNotifications);
  btnFoodArrived.addEventListener('click', handleFoodArrived);
  btnSendNotification.addEventListener('click', handleSendNotification);
  document.querySelectorAll('input[name="notify-when"], input[name="notify-repeat"]').forEach(radio => {
    radio.addEventListener('change', updateNotifyScheduleUI);
  });
  btnAddCheckpoint.addEventListener('click', handleAddCheckpoint);
  btnSaveCheckpoints.addEventListener('click', handleSaveCheckpoints);
  btnCancelEditNotification.addEventListener('click', cancelEditScheduledNotification);

  // Header: notification bell + user profile dropdowns
  btnNotificationBell.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleNotificationDropdown();
  });
  userProfileToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleUserProfileDropdown();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.notification-bell-wrap')) notificationDropdown.classList.add('hidden');
    if (!e.target.closest('.user-profile') && !e.target.closest('.user-profile-dropdown')) {
      userProfileDropdown.classList.add('hidden');
    }
  });

  // Admin Setup Menu buttons
  btnAdminAddDish.addEventListener('click', () => openCatalogModal(true));
  btnAdminSaveMenu.addEventListener('click', saveAdminMenu);

  // Add/Edit Dish modal
  btnCatalogModalClose.addEventListener('click', closeCatalogModal);
  btnCatalogDishCancel.addEventListener('click', closeCatalogModal);
  btnCatalogDishRemove.addEventListener('click', handleCatalogDishRemove);
  catalogDishForm.addEventListener('submit', handleCatalogDishFormSubmit);
  adminPublishToggle.addEventListener('change', handlePublishToggle);

  // Admin settings buttons
  btnSaveCutoff.addEventListener('click', saveAdminCutoff);
  btnSaveArchiveTime.addEventListener('click', saveAdminArchiveTime);
  btnSaveOperationalDays.addEventListener('click', saveOperationalDays);
  btnSaveCompanySettings.addEventListener('click', saveCompanySettingsForm);
  operationalDaysPicker.querySelectorAll('.day-toggle').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('selected'));
  });

  // Manual lock toggle buttons
  btnForceLock.addEventListener('click', () => handleForceLock(true));
  btnLockRevert.addEventListener('click', () => handleForceLock(null));
  btnExtendCutoff.addEventListener('click', handleExtendCutoff);
  btnSaveSecuritySettings.addEventListener('click', saveSecuritySettings);

  // Roster buttons
  rosterSearch.addEventListener('input', renderRosterTable);
  rosterBranchFilter.addEventListener('change', renderRosterTable);
  branchAddForm.addEventListener('submit', handleBranchFormSubmit);

  trendsStartDate.addEventListener('change', loadTrends);
  trendsEndDate.addEventListener('change', loadTrends);
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

  // Lunch Run mini-game
  btnGameStart.addEventListener('click', startGame);
  gameSetupSwipeControls();
  gameSetupTouchButtons();
  document.addEventListener('keydown', (e) => {
    if (activeTab !== 'game-tab' || !gameRunning || gamePaused) return;
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { gameChangeLane(-1); e.preventDefault(); }
    else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { gameChangeLane(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W' || e.key === ' ') { gameJump(); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') { gameSlide(); e.preventDefault(); }
  });
  window.addEventListener('resize', () => {
    if (activeTab !== 'game-tab') return;
    if (gameRunning) gameResizeRendererOnly();
    else initGameCanvas();
  });
  gameFullscreenBtn.addEventListener('click', gameToggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    gameFullscreenIconEl.textContent = document.fullscreenElement ? 'fullscreen_exit' : 'fullscreen';
    if (activeTab !== 'game-tab') return;
    // Let the browser finish resizing the fullscreen element before measuring it
    requestAnimationFrame(gameResizeRendererOnly);
  });
  btnGameResume.addEventListener('click', gameResumeGame);
  gameLeaderboardScopeEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-scope]');
    if (!btn || btn.classList.contains('active')) return;
    gameLeaderboardScopeEl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    gameLeaderboardScope = btn.dataset.scope;
    loadGameLeaderboard();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) gamePauseGame();
  });
}

// --- Utility Functions ---

// Ghana Cedis — matches the currency the catering costs are actually
// tracked in, rather than a hardcoded $.
function formatPrice(amount) {
  return `GHc ${Number(amount).toFixed(2)}`;
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

// Maps known dish names to a photo. Matched by normalized name so admin-side
// renaming/casing doesn't break it; anything unrecognized falls back to a
// generic hero shot rather than showing a broken image.
const DISH_IMAGES = {
  'plain rice': 'assets/dishes/plain-rice.webp',
  'jollof rice': 'assets/dishes/jollof-rice.webp',
  'fried rice': 'assets/dishes/fried-rice.webp',
  'waakye': 'assets/dishes/waakye.webp',
  'banku and okro': 'assets/dishes/banku-okro.webp',
  'fufu': 'assets/dishes/fufu.webp',
  'banku and pepper': 'assets/dishes/banku-pepper.webp'
};
const DEFAULT_DISH_IMAGE = 'assets/jollof-hero.webp';

// Accepts either a dish/menu-item object ({name, imageId?, dishName?}) or a
// plain name string. A catalog-sourced imageId always wins (served from
// MongoDB); otherwise falls back to the static name-lookup table above,
// then the generic default — this is also the graceful-degradation path for
// pre-catalog history and one-off dishes with no photo.
function getDishImage(item) {
  if (item && typeof item === 'object' && item.imageId) {
    return `/api/dish-images/${item.imageId}`;
  }
  const name = typeof item === 'string' ? item : (item?.name || item?.dishName || '');
  const key = name.trim().toLowerCase();
  return DISH_IMAGES[key] || DEFAULT_DISH_IMAGE;
}

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
