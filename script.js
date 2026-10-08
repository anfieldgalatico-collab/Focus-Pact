/* ============================================================
SUPABASE SQL — run once in Supabase Dashboard > SQL Editor
Tables + Row Level Security for Focus Pact
------------------------------------------------------------
create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  daily_min_minutes int not null default 60,
  created_at timestamptz default now()
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('focus','break')),
  start_at timestamptz not null default now(),
  end_at timestamptz,
  is_paused boolean not null default false,
  paused_at timestamptz,
  paused_seconds int not null default 0,
  created_at timestamptz default now(),
  check (end_at is null or end_at > start_at)
);

create index if not exists sessions_user_start_idx
  on public.sessions (user_id, start_at desc);
create index if not exists sessions_active_idx
  on public.sessions (user_id) where end_at is null;
create index if not exists sessions_start_idx
  on public.sessions (start_at desc);
create unique index if not exists profiles_display_name_lower_uniq
  on public.profiles (lower(display_name));

alter table public.profiles enable row level security;
alter table public.sessions enable row level security;

-- PROFILES: everyone signed in can view (leaderboard),
-- users can only insert/update their own row.
drop policy if exists "profiles select all" on public.profiles;
create policy "profiles select all" on public.profiles
  for select to authenticated using (true);
drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own" on public.profiles
  for insert to authenticated with check (auth.uid() = id);
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles
  for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- SESSIONS: everyone signed in can view all rows (shared board),
-- users can only insert/update/delete their own rows.
drop policy if exists "sessions select all" on public.sessions;
create policy "sessions select all" on public.sessions
  for select to authenticated using (true);
drop policy if exists "sessions insert own" on public.sessions;
create policy "sessions insert own" on public.sessions
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "sessions update own" on public.sessions;
create policy "sessions update own" on public.sessions
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "sessions delete own" on public.sessions;
create policy "sessions delete own" on public.sessions
  for delete to authenticated using (auth.uid() = user_id);

-- Auto-create a profile row on signup (optional; app also upserts).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- Username lookup for legacy login support
create or replace function public.get_email_for_username(p_username text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  select au.email into v_email
  from public.profiles p
  join auth.users au on au.id = p.id
  where lower(p.display_name) = lower(trim(p_username))
  limit 1;

  return v_email;
end;
$$;

grant execute on function public.get_email_for_username(text) to anon;
grant execute on function public.get_email_for_username(text) to authenticated;
============================================================ */

// ---- CONFIG: paste your Supabase project values here ----
const SUPABASE_URL = "https://vfoslwqnnkdtcyqfzccb.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_zPS-BxuZG6t6vAWJ5QpbKg_t3G66Y_a";
// ----------------------------------------------------------

(function () {
"use strict";

const LAGOS_TZ = "Africa/Lagos";
const DAY_MS = 86400000;

const $ = (id) => document.getElementById(id);
const els = {};
["authView","authModal","openAuthModalBtn","mainView","bottomNav","loginPanel","signupPanel",
"loginUsernameInput","loginPasswordInput","signupEmailInput","signupUsernameInput","signupPasswordInput",
"loginBtn","signupBtn","showSignupBtn","showLoginBtn","authMsgEl","userLabelEl","logoutBtn","themeToggleBtn",
"notifyToggleBtn","timerStatusEl","timerDisplayEl","timerMetaEl","focusStartBtn","focusPauseBtn","focusStopBtn",
"breakToggleBtn","todayDateEl","todayFocusEl","todayBreakEl","streakEl","goalBarEl","goalTextEl",
"weekTotalEl","weekChartEl","longestStreakEl","longestDayEl","longestSessionEl","leaderListEl",
"leaderRefreshBtn","leaderSummaryEl","historyListEl","displayNameInput","dailyMinInput","settingsSaveBtn","settingsMsgEl",
"accountInfoEl","configInfoEl","editModal","editStartInput","editEndInput","editMsgEl","editSaveBtn",
"editCancelBtn","sessionNoteInput","achievementList","avgDayEl","bestDayEl","focusScoreEl","trendEl"
].forEach((id) => { els[id] = $(id); });

let sb = null;
let user = null;
let profile = { display_name: "", daily_min_minutes: 60 };
let mySessions = [];
let activeSession = null;
let editingId = null;
let tickTimer = null;
let lastStatsAt = 0;
let currentPresetMinutes = Number(localStorage.getItem("focuspact-preset") || 25);
let themeMode = localStorage.getItem("focuspact-theme") || "dark";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
function pad2(n) { return String(n).padStart(2, "0"); }
function fmtClock(totalSec) {
  totalSec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
  return pad2(h) + ":" + pad2(m) + ":" + pad2(s);
}
function fmtDurShort(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + "s";
  const m = Math.floor(sec / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60), rm = m % 60;
  return rm === 0 ? h + "h" : h + "h " + rm + "m";
}
function fmtHours(sec) {
  return (sec / 3600).toFixed(1) + "h";
}
function fmtBreak(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 3600) return Math.floor(sec / 60) + "m";
  return (sec / 3600).toFixed(1) + "h";
}

// ---------- Lagos day helpers (Africa/Lagos is UTC+1, no DST) ----------
const lagosDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: LAGOS_TZ, year: "numeric", month: "2-digit", day: "2-digit"
});
const lagosTimeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: LAGOS_TZ, hour: "2-digit", minute: "2-digit"
});
const lagosWeekdayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: LAGOS_TZ, weekday: "short"
});
function lagosDayStr(d) { return lagosDayFmt.format(d); }
function lagosDayStartUTC(dayStr) { return Date.parse(dayStr + "T00:00:00+01:00"); }
function addDaysStr(dayStr, n) {
  return lagosDayStr(new Date(lagosDayStartUTC(dayStr) + n * DAY_MS));
}
function weekDaysMonToSun(todayStr) {
  const noon = lagosDayStartUTC(todayStr) + 12 * 3600 * 1000;
  const wd = lagosWeekdayFmt.format(new Date(noon));
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const idx = map[wd] || 1;
  const monUTC = lagosDayStartUTC(todayStr) - (idx - 1) * DAY_MS;
  const out = [];
  for (let i = 0; i < 7; i++) out.push(lagosDayStr(new Date(monUTC + i * DAY_MS)));
  return out;
}

// ---------- Session duration + per-day split ----------
function wallInterval(s, nowMs) {
  const startMs = Date.parse(s.start_at);
  let endMs;
  if (s.end_at) endMs = Date.parse(s.end_at);
  else if (s.is_paused && s.paused_at) endMs = Date.parse(s.paused_at);
  else endMs = nowMs;
  if (!isFinite(startMs) || !isFinite(endMs) || endMs < startMs) {
    return { startMs: startMs, endMs: startMs, pausedSec: 0 };
  }
  return { startMs: startMs, endMs: endMs, pausedSec: s.paused_seconds || 0 };
}
function effectiveSec(s, nowMs) {
  const w = wallInterval(s, nowMs);
  const wall = (w.endMs - w.startMs) / 1000;
  return Math.max(0, wall - w.pausedSec);
}
function splitByDay(sessions, kind, nowMs) {
  const perDay = new Map();
  for (const s of sessions) {
    if (s.kind !== kind) continue;
    const w = wallInterval(s, nowMs);
    const eff = Math.max(0, (w.endMs - w.startMs) / 1000 - w.pausedSec);
    if (eff <= 0) continue;
    const wallTotal = (w.endMs - w.startMs) / 1000;
    if (wallTotal <= 0) continue;
    let cursor = w.startMs;
    while (cursor < w.endMs) {
      const day = lagosDayStr(new Date(cursor));
      const dayEnd = lagosDayStartUTC(day) + DAY_MS;
      const segEnd = Math.min(dayEnd, w.endMs);
      const overlap = (segEnd - cursor) / 1000;
      const part = overlap * (eff / wallTotal);
      perDay.set(day, (perDay.get(day) || 0) + part);
      cursor = segEnd;
    }
  }
  return perDay;
}
function computeStats(sessions, dailyMinSec, nowMs) {
  const todayStr = lagosDayStr(new Date(nowMs));
  const weekDays = weekDaysMonToSun(todayStr);
  const focusByDay = splitByDay(sessions, "focus", nowMs);
  const breakByDay = splitByDay(sessions, "break", nowMs);
  const todayFocus = focusByDay.get(todayStr) || 0;
  const todayBreak = breakByDay.get(todayStr) || 0;
  const weekPerDay = weekDays.map((d) => focusByDay.get(d) || 0);
  const weekTotal = weekPerDay.reduce((a, b) => a + b, 0);

  const qual = new Set();
  for (const [day, sec] of focusByDay) {
    if (sec >= dailyMinSec) qual.add(day);
  }
  // current streak: count back from today if qualified, else from yesterday
  let anchor = todayStr;
  if (!qual.has(todayStr)) anchor = addDaysStr(todayStr, -1);
  let currentStreak = 0;
  if (qual.has(anchor)) {
    let d = anchor;
    while (qual.has(d)) { currentStreak++; d = addDaysStr(d, -1); }
  }
  // longest streak
  const sorted = Array.from(qual).sort();
  let longestStreak = 0, run = 0, prevUTC = null;
  for (const d of sorted) {
    const u = lagosDayStartUTC(d);
    if (prevUTC !== null && u - prevUTC === DAY_MS) run++;
    else run = 1;
    if (run > longestStreak) longestStreak = run;
    prevUTC = u;
  }
  let longestDay = 0;
  for (const sec of focusByDay.values()) if (sec > longestDay) longestDay = sec;
  let longestSession = 0;
  for (const s of sessions) {
    if (s.kind !== "focus") continue;
    const e = effectiveSec(s, nowMs);
    if (e > longestSession) longestSession = e;
  }
  return {
    todayStr: todayStr, weekDays: weekDays, todayFocus: todayFocus, todayBreak: todayBreak,
    weekPerDay: weekPerDay, weekTotal: weekTotal, currentStreak: currentStreak,
    longestStreak: longestStreak, longestDay: longestDay, longestSession: longestSession,
    focusByDay: focusByDay
  };
}

// ---------- UI helpers ----------
function setMsg(el, text) { el.textContent = text || ""; }
function applyTheme() {
  document.body.dataset.theme = themeMode;
  if (els.themeToggleBtn) {
    els.themeToggleBtn.textContent = themeMode === "dark" ? "☀️" : "🌙";
  }
}
function toggleTheme() {
  themeMode = themeMode === "dark" ? "light" : "dark";
  localStorage.setItem("focuspact-theme", themeMode);
  applyTheme();
}
function updatePresetButtons() {
  document.querySelectorAll(".preset-btn").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.preset) === currentPresetMinutes);
  });
}
function showNotification(title, body) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    new Notification(title, { body });
  }
}
function updateNotificationButton() {
  if (!els.notifyToggleBtn) return;
  const enabled = Notification.permission === "granted";
  els.notifyToggleBtn.textContent = enabled ? "Alerts on" : "Alerts off";
  els.notifyToggleBtn.classList.toggle("active", enabled);
}
function askNotificationPermission() {
  if (!("Notification" in window)) {
    setMsg(els.authMsgEl, "This browser does not support notifications.");
    return;
  }
  Notification.requestPermission().then((permission) => {
    if (permission === "granted") {
      updateNotificationButton();
      showNotification("Focus Pact", "Notifications enabled.");
    }
  });
}
function switchAuthMode(mode) {
  const isLogin = mode === "login";
  els.loginPanel.hidden = !isLogin;
  els.signupPanel.hidden = isLogin;
  setMsg(els.authMsgEl, "");
  if (isLogin) {
    setTimeout(() => els.loginUsernameInput && els.loginUsernameInput.focus(), 0);
  } else {
    setTimeout(() => els.signupEmailInput && els.signupEmailInput.focus(), 0);
  }
}
function showAuth() {
  els.authView.hidden = false;
  els.mainView.hidden = true;
  els.bottomNav.hidden = true;
  els.logoutBtn.hidden = true;
  els.userLabelEl.textContent = "";
  els.authModal.hidden = false;
  switchAuthMode("login");
}
function showMain() {
  els.authView.hidden = true;
  els.mainView.hidden = false;
  els.bottomNav.hidden = false;
  els.logoutBtn.hidden = false;
}
function switchTab(name) {
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  ["dashboard", "leaderboard", "history", "settings"].forEach((t) => {
    $("tab-" + t).hidden = (t !== name);
  });
  if (name === "dashboard") renderDashboard();
  if (name === "leaderboard") refreshLeaderboard();
  if (name === "history") { loadMySessions().then(renderHistory); }
}

// ---------- Auth + usernames ----------
const PENDING_USER_KEY = "focuspact_pending_username";
const LOCAL_USER_MAP_KEY = "focuspact_local_user_map";

function getStoredUserMap() {
  try {
    const raw = localStorage.getItem(LOCAL_USER_MAP_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}
function saveStoredUserMap(map) {
  try { localStorage.setItem(LOCAL_USER_MAP_KEY, JSON.stringify(map)); } catch (e) {}
}
function rememberLocalUser(username, email) {
  if (!username || !email) return;
  const map = getStoredUserMap();
  map[cleanUsername(username)] = String(email).trim().toLowerCase();
  saveStoredUserMap(map);
}
function lookupLocalUserEmail(username) {
  const clean = cleanUsername(username);
  if (!clean) return "";
  return getStoredUserMap()[clean] || "";
}
function cleanUsername(v) {
  return String(v || "").trim().replace(/\s+/g, "_").slice(0, 30);
}
function validUsername(v) {
  return /^[A-Za-z0-9_.-]{3,30}$/.test(v);
}
function getAuthErrorMessage(error) {
  const msg = (error && (error.message || String(error))) || "";
  const lower = msg.toLowerCase();
  if (lower.includes("invalid login credentials") || lower.includes("invalid_credentials") || lower.includes("wrong username") || lower.includes("wrong password") || lower.includes("password") && lower.includes("incorrect") || lower.includes("user not found")) {
    return "Wrong username or password.";
  }
  return msg || "Wrong username or password.";
}
async function isUsernameTaken(name, exceptId) {
  const { data, error } = await sb.from("profiles")
    .select("id").ilike("display_name", name).limit(5);
  if (error) throw error;
  return (data || []).some((r) => r.id !== exceptId);
}
async function resolveLoginEmail(username) {
  const name = cleanUsername(username);
  if (!name) return "";

  const localEmail = lookupLocalUserEmail(name);
  if (localEmail) return localEmail;

  try {
    const { data, error } = await sb.rpc("get_email_for_username", { p_username: name });
    if (!error && data) {
      const email = String(data).trim();
      if (email) {
        rememberLocalUser(name, email);
        return email;
      }
    }
  } catch (e) {
    // Ignore and fall back below if the RPC is not available yet.
  }

  const { data: profileRow, error: profileError } = await sb.from("profiles")
    .select("display_name")
    .ilike("display_name", name)
    .limit(1)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profileRow) return "";

  const fallbackEmail = lookupLocalUserEmail(profileRow.display_name || name);
  return fallbackEmail || "";
}
async function ensureProfile() {
  const { data, error } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (error) throw error;
  let pending = "";
  try { pending = cleanUsername(localStorage.getItem(PENDING_USER_KEY)); } catch (e) { pending = ""; }
  if (data) {
    profile = {
      display_name: data.display_name || "",
      daily_min_minutes: data.daily_min_minutes || 60
    };
    if (pending && pending !== profile.display_name) {
      if (!validUsername(pending)) pending = "";
      else if (await isUsernameTaken(pending, user.id)) pending = "";
    } else pending = "";
    if (pending) {
      const { error: upErr } = await sb.from("profiles")
        .update({ display_name: pending }).eq("id", user.id);
      if (!upErr) profile.display_name = pending;
    }
  } else {
    let pick = pending && validUsername(pending) ? pending : "";
    if (pick && await isUsernameTaken(pick, user.id)) pick = "";
    if (!pick) pick = (user.email || "friend").split("@")[0].slice(0, 30) || "friend";
    const { error: insErr } = await sb.from("profiles").insert({
      id: user.id, display_name: pick, daily_min_minutes: 60
    });
    if (insErr) throw insErr;
    profile = { display_name: pick, daily_min_minutes: 60 };
  }
  try { localStorage.removeItem(PENDING_USER_KEY); } catch (e) {}
  els.displayNameInput.value = profile.display_name || "";
  els.dailyMinInput.value = String(profile.daily_min_minutes || 60);
  if (els.signupUsernameInput && !els.signupUsernameInput.value) els.signupUsernameInput.value = profile.display_name || "";
  els.userLabelEl.textContent = profile.display_name || "friend";
  els.accountInfoEl.textContent = "Username " + (profile.display_name || "friend");
}

async function boot() {
  const configured = SUPABASE_URL && SUPABASE_URL.indexOf("YOUR_SUPABASE") !== 0 &&
    SUPABASE_ANON_KEY && SUPABASE_ANON_KEY.indexOf("YOUR_SUPABASE") !== 0;
  els.configInfoEl.textContent = configured
    ? "Supabase connected."
    : "Set SUPABASE_URL and SUPABASE_ANON_KEY at the top of script.js.";
  if (!configured) setMsg(els.authMsgEl, "Add your Supabase URL and anon key in script.js first.");
  if (!window.supabase || !window.supabase.createClient) {
    setMsg(els.authMsgEl, "Supabase CDN failed to load. Check connection and reload.");
    return;
  }
  sb = window.supabase.createClient(
    configured ? SUPABASE_URL : "https://placeholder.supabase.co",
    configured ? SUPABASE_ANON_KEY : "placeholder"
  );
  if (!configured) return;

  const { data } = await sb.auth.getSession();
  user = data && data.session ? data.session.user : null;
  sb.auth.onAuthStateChange((_evt, session) => {
    user = session ? session.user : null;
    if (user) onSignedIn();
    else { stopTick(); showAuth(); }
  });
  if (user) onSignedIn();
  else showAuth();
}

async function onSignedIn() {
  showMain();
  switchTab("dashboard");
  try {
    await ensureProfile();
    await loadMySessions();
    pickActive();
    startTick();
    renderDashboard();
  } catch (e) {
    setMsg(els.authMsgEl, "Load failed: " + (e.message || e));
  }
}

// ---------- Data ----------
async function loadMySessions() {
  const since = new Date(Date.now() - 400 * DAY_MS).toISOString();
  const { data, error } = await sb.from("sessions").select("*")
    .eq("user_id", user.id).gte("start_at", since)
    .order("start_at", { ascending: false }).limit(2000);
  if (error) throw error;
  mySessions = data || [];
  pickActive();
  return mySessions;
}
function pickActive() {
  activeSession = null;
  for (const s of mySessions) {
    if (!s.end_at) { activeSession = s; break; }
  }
}

// ---------- Timer actions ----------
async function dbInsertSession(kind) {
  const row = { user_id: user.id, kind: kind, start_at: new Date().toISOString() };
  const { data, error } = await sb.from("sessions").insert(row).select().single();
  if (error) throw error;
  mySessions.unshift(data);
  activeSession = data;
}
async function dbUpdateSession(id, patch) {
  const { data, error } = await sb.from("sessions").update(patch).eq("id", id).select().single();
  if (error) throw error;
  const i = mySessions.findIndex((s) => s.id === id);
  if (i >= 0) mySessions[i] = data;
  if (activeSession && activeSession.id === id) {
    if (data.end_at) activeSession = null;
    else activeSession = data;
  }
  return data;
}
async function endSessionRow(s, nowMs) {
  if (s.is_paused && s.paused_at) {
    return dbUpdateSession(s.id, {
      end_at: s.paused_at, is_paused: false, paused_at: null
    });
  }
  return dbUpdateSession(s.id, { end_at: new Date(nowMs).toISOString() });
}

async function startFocus() {
  if (activeSession && activeSession.kind === "focus" && !activeSession.is_paused) return;
  setMsg(els.authMsgEl, "");
  try {
    if (activeSession && activeSession.kind === "break") {
      await endSessionRow(activeSession, Date.now());
    }
    if (activeSession && activeSession.kind === "focus" && activeSession.is_paused) {
      await resumeFocus();
      return;
    }

    const note = (els.sessionNoteInput && els.sessionNoteInput.value || "").trim();
    if (note) localStorage.setItem("focuspact-last-note", note);
    const sessionSeconds = currentPresetMinutes * 60;
    const started = new Date();
    const row = { user_id: user.id, kind: "focus", start_at: started.toISOString(), session_note: note || null };

    const { data, error } = await sb.from("sessions").insert(row).select().single();
    if (error) throw error;
    mySessions.unshift(data);
    activeSession = data;
    renderDashboard();
    if (Notification.permission === "granted") {
      showNotification("Focus started", note ? "Working on: " + note : "Focus timer started.");
    }
    if (sessionSeconds > 0) {
      localStorage.setItem("focuspact-last-focus-seconds", String(sessionSeconds));
    }
  } catch (e) { alert("Start failed: " + (e.message || e)); }
}
async function pauseFocus() {
  if (!activeSession || activeSession.kind !== "focus" || activeSession.is_paused) return;
  try {
    await dbUpdateSession(activeSession.id, {
      is_paused: true, paused_at: new Date().toISOString()
    });
    renderDashboard();
  } catch (e) { alert("Pause failed: " + (e.message || e)); }
}
async function resumeFocus() {
  if (!activeSession || activeSession.kind !== "focus" || !activeSession.is_paused) return;
  try {
    const nowMs = Date.now();
    const pausedMs = nowMs - Date.parse(activeSession.paused_at);
    const add = Math.max(0, Math.floor(pausedMs / 1000));
    await dbUpdateSession(activeSession.id, {
      is_paused: false, paused_at: null,
      paused_seconds: (activeSession.paused_seconds || 0) + add
    });
    renderDashboard();
  } catch (e) { alert("Resume failed: " + (e.message || e)); }
}
async function stopActive() {
  if (!activeSession) return;
  if (!confirm("Stop and save this session?")) return;
  try {
    await endSessionRow(activeSession, Date.now());
    renderDashboard();
    renderHistory();
  } catch (e) { alert("Stop failed: " + (e.message || e)); }
}
async function toggleBreak() {
  try {
    if (activeSession && activeSession.kind === "break") {
      await endSessionRow(activeSession, Date.now());
    } else {
      if (activeSession && activeSession.kind === "focus" && !activeSession.is_paused) {
        await dbUpdateSession(activeSession.id, {
          is_paused: true, paused_at: new Date().toISOString()
        });
      }
      await dbInsertSession("break");
    }
    renderDashboard();
  } catch (e) { alert("Break failed: " + (e.message || e)); }
}

// ---------- Dashboard ----------
function activeElapsedSec() {
  if (!activeSession) return 0;
  return effectiveSec(activeSession, Date.now());
}
function renderAchievements() {
  const totalFocusSec = (mySessions || []).reduce((sum, s) => {
    if (s.kind !== "focus") return sum;
    return sum + effectiveSec(s, Date.now());
  }, 0);
  const streak = computeStats(mySessions, (profile.daily_min_minutes || 60) * 60, Date.now()).currentStreak;
  const longestSession = Math.max(0, ...mySessions.filter((s) => s.kind === "focus").map((s) => effectiveSec(s, Date.now())));

  const items = [
    { badge: "🔥", name: "3 day streak", unlocked: streak >= 3 },
    { badge: "⚡", name: "5h focused", unlocked: totalFocusSec >= 18000 },
    { badge: "🏆", name: "Longest session 30m", unlocked: longestSession >= 1800 },
    { badge: "💡", name: "Daily goal hit", unlocked: totalFocusSec >= (profile.daily_min_minutes || 60) * 60 }
  ];

  els.achievementList.innerHTML = items.map((item) => `
    <div class="achievement-item ${item.unlocked ? "unlocked" : ""}">
      <span class="badge">${item.badge}</span>
      <span class="name">${item.name}</span>
    </div>
  `).join("");
}
function renderDashboard() {
  if (!user) return;
  const nowMs = Date.now();
  const dailyMinSec = (profile.daily_min_minutes || 60) * 60;
  const st = computeStats(mySessions, dailyMinSec, nowMs);
  const avgPerDay = st.weekTotal / 7;
  const bestDay = Math.max(...st.weekPerDay, 0);
  const score = dailyMinSec > 0 ? Math.min(100, (st.todayFocus / dailyMinSec) * 100) : 0;
  const trend = st.weekTotal > 0
    ? "Momentum is up this week."
    : "Start a focus session to build momentum.";

  renderAchievements();
  els.avgDayEl.textContent = fmtHours(avgPerDay);
  els.bestDayEl.textContent = fmtHours(bestDay);
  els.focusScoreEl.textContent = Math.round(score) + "%";
  els.trendEl.textContent = trend;
  els.todayDateEl.textContent = st.todayStr;
  els.todayFocusEl.textContent = fmtHours(st.todayFocus);
  els.todayBreakEl.textContent = fmtBreak(st.todayBreak);
  els.streakEl.textContent = String(st.currentStreak);
  const pct = dailyMinSec > 0 ? Math.min(100, (st.todayFocus / dailyMinSec) * 100) : 0;
  els.goalBarEl.style.width = pct.toFixed(1) + "%";
  const remain = Math.max(0, dailyMinSec - st.todayFocus);
  els.goalTextEl.textContent = "Goal " + fmtDurShort(dailyMinSec) +
    (remain > 0 ? " — " + fmtDurShort(remain) + " to go" : " — done");
  els.weekTotalEl.textContent = fmtHours(st.weekTotal);
  els.longestStreakEl.textContent = st.longestStreak + " days";
  els.longestDayEl.textContent = fmtHours(st.longestDay);
  els.longestSessionEl.textContent = fmtDurShort(st.longestSession);

  const maxV = Math.max(3600, ...st.weekPerDay);
  const dayNames = ["M", "T", "W", "T", "F", "S", "S"];
  let html = "";
  for (let i = 0; i < 7; i++) {
    const v = st.weekPerDay[i];
    const h = Math.max(4, Math.round((v / maxV) * 110));
    const isToday = st.weekDays[i] === st.todayStr;
    html += '<div class="bar-col"><div class="bar-val">' +
      (v >= 60 ? (v / 3600).toFixed(1) : "") +
      '</div><div class="bar' + (isToday ? " today" : "") + '" style="height:' + h + 'px"></div>' +
      '<div class="bar-label">' + dayNames[i] + "</div></div>";
  }
  els.weekChartEl.innerHTML = html;
  updateTimerUI(nowMs);
  lastStatsAt = nowMs;
}
function updateTimerUI(nowMs) {
  nowMs = nowMs || Date.now();
  const a = activeSession;
  let status = "Idle", cls = "status";
  if (a && a.kind === "focus" && !a.is_paused) { status = "Focusing"; cls += " live"; }
  else if (a && a.kind === "focus" && a.is_paused) { status = "Paused"; cls += " paused"; }
  else if (a && a.kind === "break") { status = "On break"; cls += " onbreak"; }
  els.timerStatusEl.textContent = status;
  els.timerStatusEl.className = cls;
  els.timerDisplayEl.textContent = fmtClock(a ? effectiveSec(a, nowMs) : 0);
  if (!a) {
    els.timerMetaEl.textContent = "No active session";
  } else {
    const kind = a.kind === "focus" ? "Focus" : "Break";
    const extra = (a.kind === "focus" && a.is_paused) ? " (paused)" : "";
    const note = (a.session_note || localStorage.getItem("focuspact-last-note") || "");
    const noteText = note ? " · " + note : "";
    els.timerMetaEl.textContent = kind + " since " +
      lagosTimeFmt.format(new Date(a.start_at)) + " Lagos" + noteText + extra;
  }
  const focusActive = !!(a && a.kind === "focus");
  const breakActive = !!(a && a.kind === "break");
  els.focusStartBtn.disabled = !!(focusActive && !a.is_paused);
  els.focusPauseBtn.disabled = !focusActive;
  els.focusPauseBtn.textContent = (focusActive && a.is_paused) ? "Resume" : "Pause";
  els.focusStopBtn.disabled = !a;
  els.breakToggleBtn.textContent = breakActive ? "End break" : "Start break";
}
function startTick() {
  stopTick();
  tickTimer = setInterval(() => {
    if (!user || els.mainView.hidden) return;
    updateTimerUI();
    if (Date.now() - lastStatsAt > 15000 && !$("tab-dashboard").hidden) renderDashboard();
  }, 1000);
}
function stopTick() { if (tickTimer) clearInterval(tickTimer); tickTimer = null; }

// ---------- Leaderboard ----------
async function refreshLeaderboard() {
  if (!user) return;
  els.leaderListEl.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const since = new Date(Date.now() - 400 * DAY_MS).toISOString();
    const [profRes, sessRes] = await Promise.all([
      sb.from("profiles").select("id, display_name, daily_min_minutes"),
      sb.from("sessions").select("user_id, kind, start_at, end_at, is_paused, paused_at, paused_seconds")
        .gte("start_at", since).limit(10000)
    ]);
    if (profRes.error) throw profRes.error;
    if (sessRes.error) throw sessRes.error;
    const profiles = profRes.data || [];
    const sessions = sessRes.data || [];
    const byUser = new Map();
    for (const s of sessions) {
      if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
      byUser.get(s.user_id).push(s);
    }
    const nowMs = Date.now();
    const rows = profiles.map((p) => {
      const list = byUser.get(p.id) || [];
      const goal = (p.daily_min_minutes || 60) * 60;
      const st = computeStats(list, goal, nowMs);
      return {
        id: p.id,
        name: p.display_name || ("User " + String(p.id).slice(0, 6)),
        today: st.todayFocus, week: st.weekTotal,
        streak: st.currentStreak, best: st.longestStreak,
        detail: st
      };
    });
    rows.sort((a, b) => b.week - a.week);
    const topWeek = rows.length ? rows[0].week : 0;
    const myRank = rows.findIndex((row) => row.id === user.id) + 1;
    els.leaderSummaryEl.textContent = myRank > 0 ? "#" + myRank + " overall · " + fmtHours(topWeek) + " leader" : "No rankings yet";
    let html = "";
    rows.forEach((r, i) => {
      const isTop = i === 0 && rows.length > 1 && r.week > 0;
      html += '<div class="leader-row' + (isTop ? " top" : "") + '" data-uid="' + esc(r.id) + '">' +
        '<div class="leader-main"><span class="leader-name">' + esc(r.name) +
        (isTop ? ' <span class="crown">★ week leader</span>' : "") + "</span>" +
        '<span class="leader-week">' + fmtHours(r.week) + "</span></div>" +
        '<div class="leader-sub"><span>Today ' + fmtHours(r.today) + "</span>" +
        "<span>Streak " + r.streak + "</span><span>Best " + r.best + "</span></div>" +
        '<div class="leader-detail" hidden>' + leaderDetailHtml(r.detail) + "</div></div>";
    });
    els.leaderListEl.innerHTML = html || '<p class="muted">No profiles yet.</p>';
    els.leaderListEl.querySelectorAll(".leader-row").forEach((row) => {
      row.addEventListener("click", (ev) => {
        if (ev.target.tagName === "BUTTON") return;
        const d = row.querySelector(".leader-detail");
        if (d) d.hidden = !d.hidden;
      });
    });
  } catch (e) {
    els.leaderListEl.innerHTML = '<p class="msg">Load failed: ' + esc(e.message || e) + "</p>";
  }
}
function leaderDetailHtml(st) {
  const maxV = Math.max(3600, ...st.weekPerDay);
  const dayNames = ["M", "T", "W", "T", "F", "S", "S"];
  let bars = '<div class="chart">';
  for (let i = 0; i < 7; i++) {
    const v = st.weekPerDay[i];
    const h = Math.max(4, Math.round((v / maxV) * 80));
    bars += '<div class="bar-col"><div class="bar' +
      (st.weekDays[i] === st.todayStr ? " today" : "") +
      '" style="height:' + h + 'px"></div><div class="bar-label">' + dayNames[i] + "</div></div>";
  }
  bars += "</div>";
  return bars + '<div class="muted small">Longest day ' + fmtHours(st.longestDay) +
    " · Longest session " + fmtDurShort(st.longestSession) + "</div>";
}

// ---------- History ----------
function toLocalInputValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
    "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}
function renderHistory() {
  if (!user) return;
  const nowMs = Date.now();
  let html = "";
  const list = mySessions.slice(0, 120);
  for (const s of list) {
    const dur = fmtDurShort(effectiveSec(s, nowMs));
    const day = lagosDayStr(new Date(s.start_at));
    const t0 = lagosTimeFmt.format(new Date(s.start_at));
    const t1 = s.end_at ? lagosTimeFmt.format(new Date(s.end_at)) : "running";
    const running = s.end_at ? "" : " · running";
    html += '<div class="hist-row" data-id="' + esc(s.id) + '">' +
      '<div class="hist-info"><span class="hist-kind ' + s.kind + '">' + s.kind + "</span> " +
      '<span class="hist-dur">' + dur + "</span>" +
      '<div class="hist-time">' + day + " " + t0 + " → " + t1 + running + "</div></div>" +
      '<div class="hist-btns"><button class="btn edit-hist-btn">Edit</button>' +
      '<button class="btn del-hist-btn">Del</button></div></div>';
  }
  els.historyListEl.innerHTML = html || '<p class="muted">No sessions yet. Start your first focus.</p>';
  els.historyListEl.querySelectorAll(".hist-row").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector(".edit-hist-btn").addEventListener("click", () => openEdit(id));
    row.querySelector(".del-hist-btn").addEventListener("click", () => deleteSession(id));
  });
}
function openEdit(id) {
  const s = mySessions.find((x) => x.id === id);
  if (!s) return;
  editingId = id;
  els.editStartInput.value = toLocalInputValue(s.start_at);
  els.editEndInput.value = toLocalInputValue(s.end_at);
  setMsg(els.editMsgEl, s.kind + " session. Times in your device timezone.");
  els.editModal.hidden = false;
}
async function saveEdit() {
  if (!editingId) return;
  const s0 = new Date(els.editStartInput.value);
  const endRaw = els.editEndInput.value;
  if (!isFinite(s0.getTime())) { setMsg(els.editMsgEl, "Pick a valid start time."); return; }
  let patch = { start_at: s0.toISOString() };
  if (endRaw) {
    const e0 = new Date(endRaw);
    if (!isFinite(e0.getTime())) { setMsg(els.editMsgEl, "Pick a valid end time."); return; }
    if (e0 <= s0) { setMsg(els.editMsgEl, "End must be after start."); return; }
    patch.end_at = e0.toISOString();
    patch.is_paused = false;
    patch.paused_at = null;
  } else {
    patch.end_at = null;
  }
  try {
    await dbUpdateSession(editingId, patch);
    els.editModal.hidden = true;
    editingId = null;
    renderHistory();
    renderDashboard();
  } catch (e) { setMsg(els.editMsgEl, "Save failed: " + (e.message || e)); }
}
async function deleteSession(id) {
  if (!confirm("Delete this session permanently?")) return;
  try {
    const { error } = await sb.from("sessions").delete().eq("id", id);
    if (error) throw error;
    mySessions = mySessions.filter((s) => s.id !== id);
    pickActive();
    renderHistory();
    renderDashboard();
  } catch (e) { alert("Delete failed: " + (e.message || e)); }
}

// ---------- Settings ----------
async function saveSettings() {
  const name = cleanUsername(els.displayNameInput.value);
  let mins = parseInt(els.dailyMinInput.value, 10);
  if (!isFinite(mins) || mins < 1) mins = 60;
  mins = Math.min(1440, mins);
  if (!validUsername(name)) {
    setMsg(els.settingsMsgEl, "Username: 3-30 chars, letters/numbers/_ . - only.");
    return;
  }
  try {
    if (name !== profile.display_name && await isUsernameTaken(name, user.id)) {
      setMsg(els.settingsMsgEl, "That username is taken. Try another.");
      return;
    }
    const { error } = await sb.from("profiles").update({
      display_name: name, daily_min_minutes: mins
    }).eq("id", user.id);
    if (error) throw error;
    profile.display_name = name;
    profile.daily_min_minutes = mins;
    els.userLabelEl.textContent = name;
    setMsg(els.settingsMsgEl, "Saved. Friends now see you as " + name + ".");
  } catch (e) { setMsg(els.settingsMsgEl, "Save failed: " + (e.message || e)); }
}

// ---------- Events ----------
els.openAuthModalBtn.addEventListener("click", () => {
  els.authModal.hidden = false;
  switchAuthMode("login");
});
els.authModal.addEventListener("click", (event) => {
  if (event.target === els.authModal) {
    els.authModal.hidden = true;
  }
});
document.querySelectorAll(".preset-btn").forEach((button) => {
  button.addEventListener("click", () => {
    currentPresetMinutes = Number(button.dataset.preset);
    localStorage.setItem("focuspact-preset", String(currentPresetMinutes));
    updatePresetButtons();
  });
});
els.themeToggleBtn.addEventListener("click", toggleTheme);
els.notifyToggleBtn.addEventListener("click", () => {
  if (Notification.permission === "granted") {
    showNotification("Focus Pact", "Notifications are already enabled.");
    return;
  }
  askNotificationPermission();
});
els.loginBtn.addEventListener("click", async () => {
  const username = cleanUsername(els.loginUsernameInput.value);
  const password = els.loginPasswordInput.value;

  if (!username || !password) {
    setMsg(els.authMsgEl, "Enter your username and password.");
    return;
  }

  setMsg(els.authMsgEl, "Logging in…");
  try {
    const email = username.includes("@") ? username : await resolveLoginEmail(username);

    if (!email) {
      setMsg(els.authMsgEl, "Wrong username or password.");
      return;
    }

    const { error } = await sb.auth.signInWithPassword({
      email: email,
      password: password
    });
    if (error) throw error;
    els.authModal.hidden = true;
  } catch (e) { setMsg(els.authMsgEl, getAuthErrorMessage(e)); }
});
els.signupBtn.addEventListener("click", async () => {
  const email = (els.signupEmailInput ? els.signupEmailInput.value : "").trim();
  const uname = cleanUsername(els.signupUsernameInput ? els.signupUsernameInput.value : "");
  const password = els.signupPasswordInput ? els.signupPasswordInput.value : "";

  if (!email || !uname || !password) {
    setMsg(els.authMsgEl, "Email, username, and password are all required.");
    return;
  }
  if (!validUsername(uname)) {
    setMsg(els.authMsgEl, "Pick a username: 3-30 chars, letters/numbers/_ . - only.");
    return;
  }
  setMsg(els.authMsgEl, "Creating account…");
  try {
    if (await isUsernameTaken(uname, null)) {
      setMsg(els.authMsgEl, "That username is already taken. Try another.");
      return;
    }
    rememberLocalUser(uname, email);
    try { localStorage.setItem(PENDING_USER_KEY, uname); } catch (e) {}
    const { data, error } = await sb.auth.signUp({
      email: email,
      password: password,
      options: { data: { display_name: uname } }
    });
    if (error) throw error;
    if (data && data.session && data.session.user) {
      setMsg(els.authMsgEl, "Account created. Welcome, " + uname + "!");
    } else {
      setMsg(els.authMsgEl, "Account created as " + uname + ". If email confirmation is on, confirm then log in.");
    }
    switchAuthMode("login");
    els.loginUsernameInput.value = uname;
    els.loginPasswordInput.value = password;
  } catch (e) { setMsg(els.authMsgEl, e.message || String(e)); }
});
els.showSignupBtn.addEventListener("click", () => switchAuthMode("signup"));
els.showLoginBtn.addEventListener("click", () => switchAuthMode("login"));
els.logoutBtn.addEventListener("click", async () => { await sb.auth.signOut(); });
els.focusStartBtn.addEventListener("click", startFocus);
els.focusStopBtn.addEventListener("click", stopActive);
els.focusPauseBtn.addEventListener("click", () => {
  if (activeSession && activeSession.kind === "focus" && activeSession.is_paused) resumeFocus();
  else pauseFocus();
});
els.breakToggleBtn.addEventListener("click", toggleBreak);
els.leaderRefreshBtn.addEventListener("click", refreshLeaderboard);
els.settingsSaveBtn.addEventListener("click", saveSettings);
els.editSaveBtn.addEventListener("click", saveEdit);
els.editCancelBtn.addEventListener("click", () => { els.editModal.hidden = true; editingId = null; });
document.querySelectorAll(".nav-btn").forEach((b) => {
  b.addEventListener("click", () => switchTab(b.dataset.tab));
});
document.addEventListener("visibilitychange", async () => {
  if (!document.hidden && user) {
    try { await loadMySessions(); renderDashboard(); } catch (e) { /* keep timer */ }
  }
});

applyTheme();
updatePresetButtons();
updateNotificationButton();
boot();
})();
