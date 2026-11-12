// Patro tasks: sign-in, the "Up next" strip, the day view (agenda list on phones,
// timeline on computers) and the add/edit sheet. Data lives in Supabase.
// Loaded after the main calendar script and uses its globals (state, render, $, toBS, MON, ...).
//
// A task row starts on `date`. Repeating tasks (repeat = daily|weekly|monthly|yearly, every N)
// are expanded on the fly into one "occurrence" per day; done_dates / skip_dates hold the
// per-day ticks and deletions. A task whose end time is earlier than its start runs overnight
// and also shows on the next morning.
(() => {
  const SB_URL = "https://usipczocwwortembguqf.supabase.co";
  // Publishable key: safe to ship in the page. Row level security limits every user to their own rows.
  const SB_KEY = "sb_publishable_IMcvneTU3cMrTDw4rSlJOg_ixtC0-Ea";
  const sb = window.supabase ? window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true } }) : null;

  const HOUR_PX = 48, PX_PER_MIN = HOUR_PX / 60;
  const UNTIMED_REMIND_AT = "09:00"; // reminders for tasks without a time fire at 9 am that day
  const CACHE_KEY = "patro-tasks";
  const REMIND_CHOICES = [[0,"At start time"],[5,"5 min before"],[10,"10 min before"],[15,"15 min before"],[30,"30 min before"],[60,"1 hour before"],[120,"2 hours before"],[1440,"1 day before"],["custom","Custom…"]];
  const REPEAT_CHOICES = [["none","Doesn't repeat"],["daily","Every day"],["weekly","Every week"],["weekly2","Every 2 weeks"],["monthly","Every month"],["yearly","Every year"],["custom","Custom…"]];
  const UNIT = { daily: ["day","days"], weekly: ["week","weeks"], monthly: ["month","months"], yearly: ["year","years"] };
  const mqList = matchMedia("(max-width:900px)"); // agenda list instead of timeline

  let user = null;
  let settings = { default_remind_before: 15, snooze_enabled: false, snooze_minutes: 5 };
  let loaded = false;        // tasks came from the cache or the server (so the phone schedule is trustworthy)
  const native = window.PatroNative || null; // set by the Android app; null in a browser
  let tasks = [];            // all of the user's task rows
  let oneOff = {};           // "YYYY-MM-DD" -> non-repeating rows starting that day
  let repeating = [];        // repeating rows
  let memo = new Map();      // "YYYY-MM-DD" -> occurrences shown that day
  let openDay = null;        // date shown in the day view, or null when the holiday list shows

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const toMin = t => { if (!t) return null; const [h,m] = t.split(":").map(Number); return h*60 + m; };
  const fmtTime = t => { const m = toMin(t); if (m == null) return ""; const h = Math.floor(m/60), mm = m%60; return `${((h+11)%12)+1}:${String(mm).padStart(2,"0")} ${h<12?"am":"pm"}`; };
  const hhmm = min => `${String(Math.floor(min/60)%24).padStart(2,"0")}:${String(min%60).padStart(2,"0")}`;
  const remindLabel = n => { const c = REMIND_CHOICES.find(x => x[0] === n); return c ? c[1] : (n % 60 === 0 ? `${n/60} h before` : `${n} min before`); };
  const nowMin = () => { const n = new Date(); return n.getHours()*60 + n.getMinutes(); };
  const todayKey = () => { const n = new Date(); return key(n.getFullYear(), n.getMonth(), n.getDate()); };
  const relMin = m => m < 60 ? `${m} min` : `${Math.floor(m/60)} h${m%60 ? ` ${m%60} min` : ""}`;
  const parts = k => k.split("-").map(Number);
  const addDays = (k, n) => { const [y,m,d] = parts(k); const t = new Date(y, m-1, d+n); return key(t.getFullYear(), t.getMonth(), t.getDate()); };
  const dayNum = k => { const [y,m,d] = parts(k); return Math.round(Date.UTC(y, m-1, d) / 864e5); };
  const shortDate = k => { const [y,m,d] = parts(k); return `${MON[m-1].slice(0,3)} ${d}${y !== new Date().getFullYear() ? `, ${y}` : ""}`; };
  const isRep = t => !!t.repeat && t.repeat !== "none";
  const overnight = t => { const s = toMin(t.start_time), e = toMin(t.end_time); return s != null && e != null && e < s; };
  const bell = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
  const loop = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const clock = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 9.5V13l2.5 2M4 5.5 7 3M20 5.5 17 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  // what the phone does for a task, in words ("Notification 15 min before and alarm at 4:00 pm.")
  function alertSummary(t){
    if (!t.start_time) return t.remind ? "Notification at 9 am that day." : "No notification.";
    const at = fmtTime(t.start_time), parts = [];
    if (t.remind && t.remind_before > 0) parts.push(`notification ${remindLabel(t.remind_before)}`);
    parts.push(t.alarm ? `alarm rings at ${at}` : `notification at ${at}`);
    if (t.end_time && t.end_alert === "notify") parts.push(`notification at ${fmtTime(t.end_time)}`);
    if (t.end_time && t.end_alert === "alarm") parts.push(`alarm rings at ${fmtTime(t.end_time)}`);
    const s = parts.length > 2 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts.join(" and ");
    return s[0].toUpperCase() + s.slice(1) + ".";
  }

  function toast(msg){
    let t = document.querySelector(".toast");
    if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role","status"); document.body.append(t); }
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 3200);
  }

  // ---------- back button ----------
  // Each open layer (day view, dialog) adds a history entry. Back pops the top layer.
  // Closing a layer from inside the page removes its entry, ignoring the popstate that causes.
  const layers = []; let skipPops = 0;
  function pushLayer(close){ const L = { close }; layers.push(L); history.pushState({ patroLayer: layers.length }, ""); return L; }
  function dropLayer(L){ const i = layers.lastIndexOf(L); if (i < 0) return; layers.splice(i, 1); skipPops++; history.back(); }
  addEventListener("popstate", () => { if (skipPops) { skipPops--; return; } const L = layers.pop(); if (L) L.close(); });
  function showDlg(dlg){
    let viaBack = false;
    const L = pushLayer(() => { viaBack = true; dlg.close(); });
    dlg.addEventListener("close", () => { if (!viaBack) dropLayer(L); }, { once: true });
    dlg.showModal();
  }

  // ---------- repeats ----------
  function occursOn(t, k){
    if (k < t.date) return false;
    if (!isRep(t)) return k === t.date;
    if (t.repeat_until && k > t.repeat_until) return false;
    if (t.skip_dates?.includes(k)) return false;
    const n = t.repeat_every || 1;
    const [y0,m0,d0] = parts(t.date), [y,m,d] = parts(k);
    switch (t.repeat) {
      case "daily":   return (dayNum(k) - dayNum(t.date)) % n === 0;
      case "weekly":  return (dayNum(k) - dayNum(t.date)) % (7*n) === 0;
      case "monthly": return d === d0 && ((y - y0)*12 + m - m0) % n === 0;   // months without that day are skipped
      case "yearly":  return d === d0 && m === m0 && (y - y0) % n === 0;
    }
    return false;
  }
  // date of the n-th repeat (1 = the first day), used for "ends after N times"
  function nthDate(t, n){
    const e = t.repeat_every || 1;
    if (t.repeat === "daily") return addDays(t.date, (n-1)*e);
    if (t.repeat === "weekly") return addDays(t.date, (n-1)*7*e);
    const [y,m,d] = parts(t.date); let c = 0;
    for (let i = 0; i < 100000; i += e) {
      const yy = t.repeat === "yearly" ? y + i : y + Math.floor((m - 1 + i) / 12);
      const mm = t.repeat === "yearly" ? m - 1 : (m - 1 + i) % 12;
      if (new Date(yy, mm, d).getMonth() === mm && ++c === n) return key(yy, mm, d);
    }
    return null;
  }
  function repeatLabel(t, long){
    const n = t.repeat_every || 1, [y,m,d] = parts(t.date);
    let s;
    if (n > 1) s = `Every ${n} ${UNIT[t.repeat][1]}`;
    else s = { daily: "Every day", weekly: `Every ${DOW[new Date(y, m-1, d).getDay()][0]}`,
      monthly: `Every month${long ? ` on the ${d}${[,"st","nd","rd"][d % 10 > 3 || Math.floor(d / 10) === 1 ? 0 : d % 10] || "th"}` : ""}`,
      yearly: `Every year${long ? ` on ${MON[m-1].slice(0,3)} ${d}` : ""}` }[t.repeat];
    if (!long) return s;
    if (t.repeat_count) return `${s}, ${t.repeat_count} times (until ${shortDate(t.repeat_until)}).`;
    if (t.repeat_until) return `${s}, until ${shortDate(t.repeat_until)}.`;
    return `${s}, with no end date.`;
  }

  // ---------- data ----------
  function index(){
    memo = new Map(); oneOff = {}; repeating = [];
    for (const t of tasks) isRep(t) ? repeating.push(t) : (oneOff[t.date] ||= []).push(t);
  }
  // one appearance of a task on a day. k = the day it starts; day = the day it is shown on.
  function occ(t, k, cont){
    const s = toMin(t.start_time), e = toMin(t.end_time);
    const done = isRep(t) ? !!t.done_dates?.includes(k) : !!t.done;
    if (cont) return { t, id: t.id, k, day: addDays(k, 1), cont: true, s: 0, e, done };
    return { t, id: t.id, k, day: k, cont: false, s, done,
      e: s == null ? null : e == null || e === s ? s + 30 : e < s ? e + 1440 : e };
  }
  const startsOn = k => [...(oneOff[k] || []), ...repeating.filter(t => occursOn(t, k))];
  function dayList(k){
    if (memo.has(k)) return memo.get(k);
    const list = startsOn(k).map(t => occ(t, k, false));
    const prev = addDays(k, -1);
    for (const t of startsOn(prev)) if (overnight(t)) list.push(occ(t, prev, true));
    list.sort((a,b) => (a.s ?? -1) - (b.s ?? -1) || (a.t.created_at || "").localeCompare(b.t.created_at || ""));
    memo.set(k, list);
    return list;
  }
  const findTask = id => tasks.find(t => t.id === id);

  function saveCache(){ try { localStorage.setItem(CACHE_KEY, JSON.stringify({ uid: user?.id, tasks })); } catch(e){} }
  function loadCache(uid){
    try { const c = JSON.parse(localStorage.getItem(CACHE_KEY)); if (c && c.uid === uid) { tasks = c.tasks || []; index(); loaded = true; } } catch(e){}
  }

  // ---------- phone notifications & alarms (Android app only) ----------
  // The page works out every notification/alarm for the next weeks and hands the list to the app,
  // which sets them with Android's alarm service (they fire even when the app is closed).
  //   Remind on  + alarm off: notification before + notification at start
  //   Remind off + alarm off: notification at start
  //   Remind off + alarm on : alarm at start
  //   Remind on  + alarm on : notification before + alarm at start
  const SCHEDULE_DAYS = 35, SCHEDULE_MAX = 250;
  function buildSchedule(){
    const out = [], now = Date.now(), today = todayKey();
    for (let i = 0; i <= SCHEDULE_DAYS; i++) {
      const k = addDays(today, i);
      for (const o of dayList(k)) {
        if (o.cont || o.done) continue;
        const t = o.t;
        const add = (at, kind, text, tag) => { if (at > now) out.push({ id: `${t.id}|${k}|${tag}`, at, kind, title: t.title, text, day: k }); };
        if (!t.start_time) {
          if (t.remind) add(new Date(`${k}T${UNTIMED_REMIND_AT}:00`).getTime(), "notify", "Today · any time", "start");
          continue;
        }
        const span = `${fmtTime(t.start_time)}${t.end_time ? ` – ${fmtTime(t.end_time)}` : ""}`;
        const start = new Date(`${k}T${t.start_time.slice(0,5)}:00`).getTime();
        if (t.remind && t.remind_before > 0) add(start - t.remind_before * 60000, "notify", `In ${relMin(t.remind_before)} · ${span}`, "before");
        if (t.alarm) add(start, "alarm", span, "alarm");
        else add(start, "notify", `Starting now · ${span}`, "start");
        if (t.end_time && (t.end_alert === "notify" || t.end_alert === "alarm")) {
          const end = new Date(`${k}T00:00:00`).getTime() + o.e * 60000;   // o.e runs past midnight for overnight tasks
          add(end, t.end_alert, t.end_alert === "alarm" ? `Ends · ${span}` : `Ending now · ${span}`, "end");
        }
      }
    }
    out.sort((a,b) => a.at - b.at);
    return out.slice(0, SCHEDULE_MAX);
  }
  let lastSchedule = null;
  function syncPhone(){
    if (!native) return;
    if (user && !loaded) return;           // don't wipe the phone's alarms before the tasks are known
    const json = JSON.stringify(user ? buildSchedule() : []);
    if (json === lastSchedule) return;
    lastSchedule = json;
    try { native.setSchedule(json); } catch(e){}
  }
  function syncPhoneSettings(){
    if (!native) return;
    try { native.setSettings(JSON.stringify({ snooze_enabled: !!settings.snooze_enabled, snooze_minutes: settings.snooze_minutes || 5 })); } catch(e){}
  }

  async function fetchAll(){
    if (!sb || !user) return;
    const all = []; const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await sb.from("tasks").select("*").order("date").range(from, from + page - 1);
      if (error) { if (navigator.onLine) toast("Couldn't load tasks: " + error.message); return; }
      all.push(...data); if (data.length < page) break;
    }
    tasks = all; loaded = true; index(); saveCache(); refresh();
  }
  async function fetchSettings(){
    const { data } = await sb.from("user_settings").select("*").maybeSingle();
    if (data) settings = { ...settings, ...data };
    syncPhoneSettings();
  }

  // when the next reminder fires (for a repeating task: the next repeat that isn't done yet)
  function remindAt(t){
    if (!t.remind) return null;
    const at = k => new Date(`${k}T${(t.start_time || UNTIMED_REMIND_AT).slice(0,5)}:00`).getTime() - (t.start_time ? t.remind_before : 0) * 60000;
    if (!isRep(t)) return new Date(at(t.date)).toISOString();
    const now = Date.now(), today = todayKey();
    for (let k = t.date > today ? t.date : today, i = 0; i < 1500; i++, k = addDays(k, 1)) {
      if (t.repeat_until && k > t.repeat_until) return null;
      if (occursOn(t, k) && !t.done_dates?.includes(k) && at(k) > now) return new Date(at(k)).toISOString();
    }
    return null;
  }

  const dbHint = msg => /repeat|done_dates|skip_dates|alarm|snooze|column/i.test(msg)
    ? "The database needs a small update: run supabase/schema.sql again in Supabase (SQL Editor)." : msg;

  async function saveTask(t){
    const rep = isRep(t) ? t.repeat : "none";
    const row = { date: t.date, start_time: t.start_time || null, end_time: t.start_time ? (t.end_time || null) : null,
      title: t.title, description: t.description || null, done: rep === "none" && !!t.done, remind: !!t.remind,
      alarm: !!t.alarm && !!t.start_time,
      end_alert: t.start_time && t.end_time && (t.end_alert === "notify" || t.end_alert === "alarm") ? t.end_alert : "none",
      remind_before: t.remind_before ?? settings.default_remind_before,
      repeat: rep, repeat_every: rep === "none" ? 1 : (t.repeat_every || 1),
      repeat_until: rep === "none" ? null : (t.repeat_until || null),
      repeat_count: rep === "none" ? null : (t.repeat_count || null),
      done_dates: rep === "none" ? [] : (t.done_dates || []),
      skip_dates: rep === "none" ? [] : (t.skip_dates || []) };
    row.remind_at = remindAt(row);
    const old = t.id ? findTask(t.id) : null;
    // reminder time changed: let it fire again
    if (!old || old.remind_at !== row.remind_at) row.notified_at = null;
    const q = t.id ? sb.from("tasks").update(row).eq("id", t.id) : sb.from("tasks").insert(row);
    const { data, error } = await q.select().single();
    if (error) throw new Error(dbHint(error.message));
    tasks = tasks.filter(x => x.id !== data.id).concat(data); index(); saveCache(); refresh();
    return data;
  }
  async function deleteTask(id){
    const { error } = await sb.from("tasks").delete().eq("id", id);
    if (error) throw error;
    tasks = tasks.filter(x => x.id !== id); index(); saveCache(); refresh();
  }
  // tick a task (for a repeating one: only the repeat starting on day k)
  async function toggleDone(id, k){
    const t = findTask(id); if (!t) return;
    let patch;
    if (isRep(t)) { const s = new Set(t.done_dates || []); s.has(k) ? s.delete(k) : s.add(k); patch = { done_dates: [...s].sort() }; }
    else patch = { done: !t.done };
    try { await saveTask({ ...t, ...patch }); }
    catch(e){ toast(navigator.onLine ? "Couldn't update: " + e.message : "You're offline. Change not saved."); }
  }

  // ---------- month grid markers ----------
  function decorateMonth(){
    document.querySelectorAll("#grid .cell[data-k]").forEach(c => {
      c.querySelector(".tmark")?.remove();
      const list = dayList(c.dataset.k).filter(o => !o.cont); if (!list.length) return;
      const open = list.filter(o => !o.done).length;
      const el = document.createElement("div");
      el.className = "tmark" + (open ? "" : " alldone");
      el.innerHTML = `<i></i><span>${open ? `${open} task${open>1?"s":""}` : "All done"}</span>`;
      c.querySelector(".row").after(el);
      c.setAttribute("aria-label", c.getAttribute("aria-label").replace(/ · \d+ tasks?$/, "") + ` · ${list.length} task${list.length>1?"s":""}`);
    });
  }

  // ---------- "Up next" strip in the day card ----------
  // Cards run in time order with "any time" tasks last. On today the strip scrolls to the task
  // in progress or coming next and keeps following the clock unless you scrolled it yourself.
  let stripTouched = 0;
  function stripOrder(k){
    const list = dayList(k);
    return [...list.filter(o => o.s != null), ...list.filter(o => o.s == null)];
  }
  function focusIndex(k, list){
    if (k !== todayKey()) return Math.max(0, list.findIndex(o => !o.done));
    const n = nowMin();
    let i = list.findIndex(o => o.s != null && !o.done && o.e > n);
    if (i < 0) i = list.findIndex(o => o.s == null && !o.done);
    return i < 0 ? Math.max(0, list.length - 1) : i;
  }
  function renderStrip(keepScroll){
    const box = $("dhTasks"); if (!box) return;
    const k = state.sel, isToday = k === todayKey();
    if (!sb) { box.innerHTML = ""; return; }
    if (!user) {
      box.innerHTML = `<h3>Tasks</h3><p class="up-empty">Sign in to see your tasks here and get reminders.</p>
        <div class="up-foot"><span></span><button class="btn primary sm" data-act="signin">Sign in</button></div>`;
      return;
    }
    const list = stripOrder(k), fi = focusIndex(k, list), n = nowMin();
    const counted = list.filter(o => !o.cont);
    const left = counted.filter(o => !o.done).length, done = counted.length - left;
    let head = isToday ? "Today's tasks" : "Tasks";
    const f = list[fi];
    if (isToday && f && !f.done && f.s != null) {
      head = f.s <= n ? `Now · until ${fmtTime(hhmm(f.e))}` : `Up next · in ${relMin(f.s - n)}`;
    }
    const cards = list.map((o, i) => {
      const t = o.t;
      const past = isToday && o.s != null && o.e <= n;
      const now = isToday && o.s != null && o.s <= n && o.e > n;
      const cls = ["up-card", o.done ? "done" : "", past && !o.done ? "past" : "", now && !o.done ? "now" : "", i === fi ? "focus" : ""].filter(Boolean).join(" ");
      const time = o.cont ? `Until ${fmtTime(t.end_time)}` : o.s != null ? fmtTime(t.start_time) : "Any time";
      const meta = o.done ? "Done"
        : `${t.remind && !o.cont ? `${bell}${t.start_time ? remindLabel(t.remind_before).replace(" before","") : "9 am"}` : ""}${(t.alarm || t.end_alert === "alarm") && !o.cont ? clock : ""}${isRep(t) ? loop : ""}`;
      return `<button class="${cls}" data-id="${t.id}" data-k="${o.k}" type="button">
        <span class="up-time">${time}${now && !o.done ? `<em>Now</em>` : ""}</span>
        <span class="up-title">${esc(t.title)}</span>
        <span class="up-meta">${meta}</span>
      </button>`;
    }).join("");
    const prevLeft = $("upStrip")?.scrollLeft;
    box.innerHTML = `<div class="up-head"><h3>${head}</h3>${list.length ? `<button class="linkbtn" data-act="day" type="button">View day</button>` : ""}</div>
      ${list.length ? `<div class="up-strip" id="upStrip">${cards}</div>` : `<p class="up-empty">Nothing planned for ${isToday ? "today" : "this day"}.</p>`}
      <div class="up-foot"><span>${counted.length ? `${left} of ${counted.length} left${done ? ` · ${done} done` : ""}` : ""}</span>
        <button class="btn primary sm" data-act="add" type="button">+ Add</button></div>`;
    const strip = $("upStrip");
    if (strip) {
      const follow = !keepScroll || Date.now() - stripTouched > 60000;
      if (follow) { const c = strip.children[fi]; if (c) strip.scrollLeft = c.offsetLeft - strip.offsetLeft - 2; }
      else if (prevLeft != null) strip.scrollLeft = prevLeft;
      ["pointerdown","wheel","touchstart"].forEach(ev => strip.addEventListener(ev, () => stripTouched = Date.now(), { passive: true }));
    }
  }
  document.addEventListener("click", e => {
    const box = e.target.closest("#dhTasks"); if (!box) return;
    const card = e.target.closest(".up-card"); if (card) { openTaskDlg(findTask(card.dataset.id), card.dataset.k); return; }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "add") openTaskDlg({ date: state.sel });
    if (act === "day") showDay(state.sel);
    if (act === "signin") openAuthDlg();
  });

  // ---------- day view ----------
  let dayLayer = null;
  function showDay(k){
    if (!dayLayer) dayLayer = pushLayer(() => { dayLayer = null; hideDay(); });
    openDay = k;
    $("holPanel").hidden = true;
    const p = $("dayPanel"); p.hidden = false; p.classList.add("open");
    if (mqList.matches) document.body.classList.add("dp-lock");
    renderDay(true);
  }
  function closeDay(){
    if (dayLayer) { const L = dayLayer; dayLayer = null; dropLayer(L); }
    hideDay();
  }
  function hideDay(){
    if (!openDay) return;
    openDay = null;
    $("dayPanel").hidden = true; $("dayPanel").classList.remove("open");
    $("holPanel").hidden = false;
    document.body.classList.remove("dp-lock");
  }
  // move the day view (and the calendar behind it) to another date
  function gotoDay(k){
    const [y,m] = parts(k);
    state.sel = k; state.y = y; state.m = m - 1;
    openDay = k;
    render();
    renderDay(true);
  }

  function weekHTML(){
    const [y,m,d] = parts(openDay);
    const start = new Date(y, m-1, d - new Date(y, m-1, d).getDay());
    const tk = todayKey();
    let days = "";
    for (let i = 0; i < 7; i++) {
      const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const k = key(dt.getFullYear(), dt.getMonth(), dt.getDate()), b = toBS(dt.getFullYear(), dt.getMonth(), dt.getDate());
      const open = dayList(k).filter(o => !o.cont && !o.done).length;
      const hol = (byDate[k] || []).some(h => h.t === "public");
      const cls = ["wk-day", k === openDay ? "sel" : "", k === tk ? "today" : "", (i === 0 || i === 6 || hol) ? "off" : ""].filter(Boolean).join(" ");
      days += `<button class="${cls}" data-day="${k}" type="button" aria-label="${dt.toDateString()}${open ? `, ${open} open tasks` : ""}" ${k === openDay ? 'aria-current="date"' : ""}>
        <small>${DOW[i][0]}</small><b>${dt.getDate()}</b><i>${b ? np(b.d) : ""}</i><span class="wk-dot${open ? "" : " none"}"></span></button>`;
    }
    const sk = key(start.getFullYear(), start.getMonth(), start.getDate());
    return `<div class="wk"><button class="wk-nav" data-day="${addDays(sk, -7)}" type="button" aria-label="Previous week">‹</button>
      <div class="wk-days">${days}</div>
      <button class="wk-nav" data-day="${addDays(sk, 7)}" type="button" aria-label="Next week">›</button></div>`;
  }

  const check = o => `<span class="tcheck" role="checkbox" aria-checked="${o.done}" aria-label="Mark done" data-done="${o.id}" data-k="${o.k}"></span>`;

  function agendaHTML(list){
    if (!list.length) return `<div class="ag-empty"><p>No tasks for this day.</p><button class="btn primary" id="agAdd" type="button">+ Add a task</button></div>`;
    const isToday = openDay === todayKey(), n = nowMin();
    const groups = [
      ["Any time", list.filter(o => o.s == null)],
      ["Morning", list.filter(o => o.s != null && o.s < 720)],
      ["Afternoon", list.filter(o => o.s != null && o.s >= 720 && o.s < 1020)],
      ["Evening", list.filter(o => o.s != null && o.s >= 1020)],
    ];
    let nowShown = !isToday, html = "";
    const nowLine = `<div class="ag-now" role="presentation"><span>Now · ${fmtTime(hhmm(n))}</span></div>`;
    for (const [label, items] of groups) {
      if (!items.length) continue;
      html += `<div class="ag-group"><h4>${label}</h4>`;
      for (const o of items) {
        const t = o.t;
        if (!nowShown && o.s != null && o.s > n) { html += nowLine; nowShown = true; }
        const live = isToday && o.s != null && o.s <= n && o.e > n && !o.done;
        const time = o.cont ? `Until<small>${fmtTime(t.end_time)}</small>`
          : o.s != null ? `${fmtTime(t.start_time)}${t.end_time ? `<small>${fmtTime(t.end_time)}${overnight(t) ? "<br>next day" : ""}</small>` : ""}` : "";
        const sub = [o.cont ? `Started yesterday ${fmtTime(t.start_time)}` : "", isRep(t) ? repeatLabel(t) : "",
          t.description ? t.description.split("\n")[0] : ""].filter(Boolean).map(esc).join(" · ");
        html += `<div class="ag-row${o.done ? " done" : ""}${live ? " live" : ""}" data-id="${t.id}" data-k="${o.k}" role="button" tabindex="0">
          ${check(o)}
          <span class="ag-time">${time}</span>
          <span class="ag-main"><b>${esc(t.title)}</b>${sub ? `<small>${isRep(t) ? loop : ""}${sub}</small>` : ""}</span>
          ${(t.remind || t.alarm || t.end_alert === "alarm") && !o.done && !o.cont ? `<span class="ag-bell" title="${esc(alertSummary(t))}">${t.alarm || t.end_alert === "alarm" ? clock : bell}</span>` : ""}
        </div>`;
      }
      html += `</div>`;
    }
    if (!nowShown) html += nowLine;
    html += `<p class="ag-tip">Tap a task to tick it off · double-tap to edit</p>`;
    return `<div class="ag">${html}</div>`;
  }

  function timelineHTML(list){
    const untimed = list.filter(o => o.s == null), timed = list.filter(o => o.s != null);
    const hours = Array.from({length:24}, (_,h) => `<div class="tl-hour" data-h="${h}"><span>${h===0?"":fmtTime(hhmm(h*60)).replace(":00","")}</span><div></div></div>`).join("");
    // lay out overlapping blocks side by side; overnight tasks are cut at midnight
    const items = timed.map(o => ({ o, s: o.s, e: Math.max(Math.min(o.e, 1440), o.s + 25) }));
    let cluster = [], clusterEnd = -1;
    const flush = () => { const cols = []; for (const it of cluster) { let c = cols.findIndex(end => end <= it.s); if (c < 0) { c = cols.length; cols.push(0); } cols[c] = it.e; it.col = c; } cluster.forEach(it => it.cols = cols.length); cluster = []; };
    for (const it of items) { if (it.s >= clusterEnd) flush(); cluster.push(it); clusterEnd = Math.max(clusterEnd, it.e); }
    flush();
    const blocks = items.map(({o,s,e,col,cols}) => { const t = o.t;
      const when = o.cont ? `until ${fmtTime(t.end_time)} · from yesterday`
        : `${fmtTime(t.start_time)}${t.end_time ? ` – ${fmtTime(t.end_time)}${overnight(t) ? " (next day)" : ""}` : ""}`;
      return `<div class="tblock${o.done?" done":""}" role="button" tabindex="0" data-id="${t.id}" data-k="${o.k}"
        style="top:${s*PX_PER_MIN}px;height:${(e-s)*PX_PER_MIN-2}px;left:calc(${col}*100%/${cols});width:calc(100%/${cols} - 3px)">
        ${check(o)}<b>${isRep(t) ? loop : ""}${esc(t.title)}</b><small>${when}</small></div>`; }).join("");
    const nowLine = openDay === todayKey() ? `<div class="tl-now" style="top:${nowMin()*PX_PER_MIN}px"></div>` : "";
    const chips = untimed.length ? `<span class="lab">Any time</span>` + untimed.map(o => `<div class="tchip${o.done?" done":""}" role="button" tabindex="0" data-id="${o.id}" data-k="${o.k}">
        ${check(o)}${isRep(o.t) ? loop : ""}${esc(o.t.title)}</div>`).join("") : "";
    return `<div class="dp-untimed">${chips}</div>
      <div class="dp-scroll" id="dpScroll"><div class="tl">${hours}<div class="tl-blocks">${blocks}</div>${nowLine}</div></div>`;
  }

  function renderDay(scroll){
    if (!openDay) return;
    const prevTop = $("dpScroll")?.scrollTop;
    const listMode = mqList.matches;
    const [y,m,d] = parts(openDay);
    const dt = new Date(y, m-1, d), b = toBS(y, m-1, d);
    const hols = (byDate[openDay] || []).filter(h => h.t !== "obs").map(h => `<span class="htag ${h.t}">${h.n.split(" · ")[0]}</span>`).join("");
    const head = `<div class="dp-head">
        <button class="iconbtn dp-back" id="dpClose" type="button" aria-label="Back to calendar">${listMode ? "‹" : "×"}</button>
        <div class="dp-title"><div class="dp-date">${dt.toLocaleDateString("en-GB",{weekday:"short"})}, ${MON[m-1]} ${d}${openDay===todayKey() ? ` <span class="dp-today">Today</span>` : ""}</div>
          <div class="dp-bs">${b ? `${BS_MONTHS_NP[b.m]} ${np(b.d)} · ${WEEKDAY_NP[dt.getDay()]}` : ""}</div>${hols ? `<div class="dp-hols">${hols}</div>` : ""}</div>
        ${user && !listMode ? `<button class="btn primary" id="dpAdd" type="button">+ Add</button>` : ""}
      </div>${weekHTML()}`;

    const list = dayList(openDay);
    let body;
    if (!sb) body = `<div class="dp-empty">Tasks need an internet connection the first time you open the app.</div>`;
    else if (!user) body = `<div class="dp-empty">Sign in to add tasks and get reminders on your phone.<br><button class="btn primary" id="dpSignin" type="button">Sign in</button></div>`;
    else body = listMode ? `<div class="dp-scroll" id="dpScroll">${agendaHTML(list)}</div>` : timelineHTML(list);

    $("dayPanel").innerHTML = head + `<div class="dp-body">${body}</div>` + (user && listMode ? `<button class="fab" id="dpFab" type="button" aria-label="Add task">+</button>` : "");
    wire();
    if (!scroll && prevTop != null && $("dpScroll")) $("dpScroll").scrollTop = prevTop;
    if (scroll && !listMode && $("dpScroll")) {
      const timed = list.filter(o => o.s != null && !o.cont);
      const target = openDay === todayKey() ? nowMin() - 90 : (timed.length ? timed[0].s : 8*60) - 60;
      $("dpScroll").scrollTop = Math.max(0, target) * PX_PER_MIN;
    }
    if (scroll && listMode) $("dayPanel").querySelector(".ag-now, .ag-row.live")?.scrollIntoView({ block: "center" });
    $("dayPanel").querySelector(".wk-day.sel")?.scrollIntoView({ inline: "center", block: "nearest" });
  }

  // in the day view one tap ticks a task off, a double tap opens it for editing
  let tapTimer = null, tapKey = null;
  function tapTask(el){
    const id = el.dataset.id, k = el.dataset.k, tk = id + "|" + k;
    if (tapTimer && tapKey === tk) { clearTimeout(tapTimer); tapTimer = null; openTaskDlg(findTask(id), k); return; }
    clearTimeout(tapTimer); tapKey = tk;
    const wasDone = el.classList.contains("done");
    tapTimer = setTimeout(() => { tapTimer = null; toggleDone(id, k); toast(wasDone ? "Marked not done" : "Done ✓"); }, 300);
  }

  function wire(){
    $("dpClose").onclick = closeDay;
    const add = () => openTaskDlg({ date: openDay });
    ["dpAdd","dpFab","agAdd"].forEach(id => { if ($(id)) $(id).onclick = add; });
    if ($("dpSignin")) $("dpSignin").onclick = openAuthDlg;
    const panel = $("dayPanel");
    panel.onclick = e => {
      const day = e.target.closest("[data-day]"); if (day) { gotoDay(day.dataset.day); return; }
      const chk = e.target.closest("[data-done]"); if (chk) { e.stopPropagation(); toggleDone(chk.dataset.done, chk.dataset.k); return; }
      const row = e.target.closest("[data-id]"); if (row) { tapTask(row); return; }
      const slot = e.target.closest(".tl-hour > div");
      if (slot && user) {
        const h = +slot.parentElement.dataset.h, r = slot.getBoundingClientRect();
        const min = h*60 + ((e.clientY - r.top) / r.height >= .5 ? 30 : 0);
        openTaskDlg({ date: openDay, start_time: hhmm(min), end_time: hhmm((min + 60) % 1440) });
      }
    };
    panel.onkeydown = e => { if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-id]")) { e.preventDefault(); openTaskDlg(findTask(e.target.dataset.id), e.target.dataset.k); } };
  }

  // ---------- add / edit sheet ----------
  // occK: for a repeating task, the repeat that was tapped (Done / "delete this day" apply to it)
  function openTaskDlg(t, occK){
    if (!t) return;
    if (!user) { openAuthDlg(); return; }
    const isNew = !t.id, rep = isRep(t);
    occK = occK || t.date;
    const rb = t.remind_before ?? settings.default_remind_before;
    const preset = REMIND_CHOICES.some(c => c[0] === rb);
    const every = t.repeat_every || 1;
    const repVal = !rep ? "none" : every === 1 ? t.repeat : t.repeat === "weekly" && every === 2 ? "weekly2" : "custom";
    const doneNow = rep ? !!t.done_dates?.includes(occK) : !!t.done;
    // one Alarm toggle plus when it rings: at the start, at the end, or both
    const endAlarm = t.end_alert === "alarm", alarmOn = !!t.alarm || endAlarm;
    const alarmWhen = t.alarm && endAlarm ? "both" : endAlarm ? "end" : "start";
    const dlg = $("taskDlg");
    dlg.classList.add("sheet");
    dlg.innerHTML = `<form method="dialog" class="sh" id="taskForm" novalidate>
      <div class="sh-grab" aria-hidden="true"></div>
      <div class="sh-top"><h2>${isNew ? "New task" : rep ? "Edit repeating task" : "Edit task"}</h2>
        <button type="button" class="iconbtn" id="tCancel" aria-label="Close">×</button></div>
      <input class="sh-title" id="tTitle" maxlength="200" value="${esc(t.title)}" placeholder="What needs doing?" autocomplete="off" aria-label="Task title">
      <button type="button" class="linkbtn sh-notebtn" id="tNoteBtn" ${t.description ? "hidden" : ""}>+ Add note</button>
      <label class="sh-note" id="tNoteWrap" ${t.description ? "" : "hidden"}><span>Note</span><textarea id="tDesc" rows="3">${esc(t.description)}</textarea></label>
      <div class="sh-rows">
        <label class="sh-row"><span id="tDateLab">Date</span><input type="date" id="tDate" value="${t.date}" required></label>
        <div class="sh-row sh-times">
          <label><span>Start</span><input type="time" id="tStart" value="${(t.start_time||"").slice(0,5)}"></label>
          <label><span>End</span><input type="time" id="tEnd" value="${(t.end_time||"").slice(0,5)}"></label>
        </div>
        <p class="sh-hint" id="tTimeHint"></p>
        <label class="sh-row"><span>${loop}Repeat</span><select id="tRepeat" aria-label="Repeat">${REPEAT_CHOICES.map(([v,l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
        <div class="sh-row" id="tEveryWrap" hidden><span>Every</span><span class="sh-pair">
          <input type="number" id="tEvery" min="1" max="99" step="1" value="${every}" aria-label="Repeat every">
          <select id="tUnit" aria-label="Repeat unit">${Object.entries(UNIT).map(([v,[,pl]]) => `<option value="${v}">${pl}</option>`).join("")}</select></span></div>
        <div class="sh-row" id="tEndsWrap" hidden><span>Ends</span><span class="sh-pair">
          <select id="tEnds" aria-label="When the repeats end"><option value="never">Never</option><option value="date">On date</option><option value="count">After</option></select>
          <input type="date" id="tUntil" value="${t.repeat_until || ""}" aria-label="Last day">
          <input type="number" id="tCount" min="2" max="500" step="1" value="${t.repeat_count || 10}" aria-label="Number of times"><em id="tCountLab">times</em></span></div>
        <p class="sh-hint" id="tRepeatHint" hidden></p>
        <div class="sh-row sh-remind">
          <label class="toggle"><input type="checkbox" id="tRemind" ${t.remind === false ? "" : "checked"}><span>${bell}Remind me</span></label>
          <select id="tBefore" aria-label="When to remind">${REMIND_CHOICES.map(([v,l]) => `<option value="${v}">${l}</option>`).join("")}</select>
        </div>
        <label class="sh-row" id="tCustomWrap" hidden><span>Minutes before</span><input type="number" id="tCustom" min="0" max="10080" step="1" value="${rb}"></label>
        <div class="sh-row sh-remind" id="tAlarmRow">
          <label class="toggle"><input type="checkbox" id="tAlarm" ${alarmOn ? "checked" : ""}><span>${clock}Alarm</span></label>
          <select id="tAlarmWhen" aria-label="When the alarm rings"><option value="start">At start</option><option value="end">At end</option><option value="both">Both</option></select>
        </div>
        <p class="sh-hint" id="tAlertHint"></p>
        ${isNew ? "" : `<label class="toggle sh-done"><input type="checkbox" id="tDone" ${doneNow ? "checked" : ""}><span>${rep ? `Done on ${shortDate(occK)}` : "Done"}</span></label>`}
      </div>
      <p class="err" id="tErr"></p>
      <button type="submit" class="btn primary sh-save" id="tSave">${isNew ? "Add task" : "Save changes"}</button>
      ${isNew ? "" : rep
        ? `<div class="sh-delrow"><button type="button" class="btn ghost danger sh-del" id="tSkip">Delete ${shortDate(occK)} only</button>
           <button type="button" class="btn ghost danger sh-del" id="tDel">Delete all repeats</button></div>`
        : `<button type="button" class="btn ghost danger sh-del" id="tDel">Delete task</button>`}
    </form>`;
    $("tBefore").value = preset ? String(rb) : "custom";
    $("tRepeat").value = repVal;
    $("tAlarmWhen").value = alarmWhen;
    // what the alarm row means for the start and the end
    const readAlarm = () => {
      const on = !!$("tStart").value && $("tAlarm").checked, w = $("tAlarmWhen").value, hasEnd = !!$("tEnd").value;
      return { alarm: on && (w === "start" || w === "both" || !hasEnd),
               end_alert: on && hasEnd && (w === "end" || w === "both") ? "alarm" : "none" };
    };
    $("tUnit").value = rep ? t.repeat : "daily";
    $("tEnds").value = t.repeat_count ? "count" : t.repeat_until ? "date" : "never";

    // read the repeat settings from the form
    const readRepeat = () => {
      const v = $("tRepeat").value;
      if (v === "none") return { repeat: "none", repeat_every: 1 };
      if (v === "custom") return { repeat: $("tUnit").value, repeat_every: Math.round(+$("tEvery").value) };
      if (v === "weekly2") return { repeat: "weekly", repeat_every: 2 };
      return { repeat: v, repeat_every: 1 };
    };
    const sync = () => {
      const on = $("tRemind").checked, timed = !!$("tStart").value;
      $("tBefore").hidden = !on || !timed;
      $("tCustomWrap").hidden = !on || !timed || $("tBefore").value !== "custom";
      $("tAlarmRow").hidden = !timed;
      // "At end" and "Both" need an end time
      const hasEnd = !!$("tEnd").value, sel = $("tAlarmWhen");
      [...sel.options].forEach(o => { if (o.value !== "start") o.disabled = !hasEnd; });
      if (!hasEnd) sel.value = "start";
      sel.hidden = !$("tAlarm").checked;
      const before = $("tBefore").value === "custom" ? Math.round(+$("tCustom").value) : +$("tBefore").value;
      $("tAlertHint").textContent = alertSummary({ start_time: $("tStart").value, end_time: $("tEnd").value, remind: on, remind_before: before, ...readAlarm() })
        + (native ? "" : " (on your phone, in the Patro app)");
      const s = toMin($("tStart").value), e = toMin($("tEnd").value), hint = $("tTimeHint");
      if (s == null) { hint.hidden = false; hint.textContent = "Leave Start empty for a task you can do any time that day."; }
      else if (e != null && e < s) { hint.hidden = false; hint.textContent = `Runs overnight: ends the next day at ${fmtTime($("tEnd").value)}.`; }
      else hint.hidden = true;

      const r = readRepeat(), repeats = r.repeat !== "none", ends = $("tEnds").value;
      $("tDateLab").textContent = repeats ? "Starts" : "Date";
      $("tEveryWrap").hidden = $("tRepeat").value !== "custom";
      $("tEndsWrap").hidden = !repeats;
      $("tUntil").hidden = ends !== "date";
      $("tCount").hidden = $("tCountLab").hidden = ends !== "count";
      const rh = $("tRepeatHint");
      rh.hidden = !repeats || !$("tDate").value || !(r.repeat_every >= 1);
      if (!rh.hidden) {
        const preview = { date: $("tDate").value, ...r, repeat_count: null, repeat_until: null };
        if (ends === "date" && $("tUntil").value) preview.repeat_until = $("tUntil").value;
        if (ends === "count" && +$("tCount").value >= 2) { preview.repeat_count = Math.round(+$("tCount").value); preview.repeat_until = nthDate(preview, preview.repeat_count); }
        rh.textContent = repeatLabel(preview, true) + (isNew || !rep ? "" : " Changes apply to every repeat.");
      }
    };
    ["tRemind","tAlarm","tAlarmWhen","tCustom","tStart","tEnd","tBefore","tRepeat","tEvery","tUnit","tEnds","tUntil","tCount","tDate"].forEach(id => $(id).addEventListener("input", sync));
    $("tEnds").addEventListener("change", () => {
      // pick a sensible last day the first time "On date" is chosen
      if ($("tEnds").value === "date" && !$("tUntil").value && $("tDate").value) $("tUntil").value = addDays($("tDate").value, 30);
      sync();
    });
    let prevStart = $("tStart").value;
    $("tStart").addEventListener("change", () => {
      // moving the start keeps the task's length; a new start with no end gets an hour
      const s = toMin($("tStart").value), e = toMin($("tEnd").value), p = toMin(prevStart);
      if (s != null) {
        if (e == null) $("tEnd").value = hhmm((s + 60) % 1440);
        else if (p != null) $("tEnd").value = hhmm((s + ((((e - p) % 1440) + 1440) % 1440 || 60)) % 1440);
      }
      prevStart = $("tStart").value;
      sync();
    });
    $("tNoteBtn").onclick = () => { $("tNoteBtn").hidden = true; $("tNoteWrap").hidden = false; $("tDesc").focus(); };
    sync();

    $("tCancel").onclick = () => dlg.close();
    const fail = e => { $("tErr").textContent = navigator.onLine ? e.message : "You're offline. Try again when connected."; };
    if (!isNew) {
      $("tDel").onclick = async () => {
        if ($("tDel").dataset.armed !== "1") { $("tDel").dataset.armed = "1"; $("tDel").textContent = "Tap again to delete"; return; }
        try { await deleteTask(t.id); dlg.close(); toast(rep ? "All repeats deleted" : "Task deleted"); }
        catch(e){ fail(e); }
      };
      if ($("tSkip")) $("tSkip").onclick = async () => {
        try { await saveTask({ ...t, skip_dates: [...new Set([...(t.skip_dates || []), occK])].sort() }); dlg.close(); toast(`Removed ${shortDate(occK)}`); }
        catch(e){ fail(e); }
      };
    }
    $("taskForm").onsubmit = async e => {
      e.preventDefault();
      const err = m => { $("tErr").textContent = m; };
      const title = $("tTitle").value.trim();
      if (!title) { err("Give the task a title."); $("tTitle").focus(); return; }
      const date = $("tDate").value;
      if (!date) { err("Pick a date."); return; }
      const s = $("tStart").value, en = $("tEnd").value;
      if (!s && en) { err("Add a start time, or clear the end time."); return; }
      if (s && en && toMin(en) === toMin(s)) { err("End time can't be the same as the start time."); return; }
      const before = $("tBefore").value === "custom" ? Math.round(+$("tCustom").value) : +$("tBefore").value;
      if (!(before >= 0 && before <= 10080)) { err("Reminder must be between 0 and 10080 minutes before."); return; }

      const r = readRepeat(), repeats = r.repeat !== "none";
      let repeat_until = null, repeat_count = null;
      if (repeats) {
        if (!(r.repeat_every >= 1 && r.repeat_every <= 99)) { err("Repeat every 1 to 99."); return; }
        if ($("tEnds").value === "date") {
          repeat_until = $("tUntil").value;
          if (!repeat_until || repeat_until < date) { err("The last day must be on or after the start date."); return; }
        }
        if ($("tEnds").value === "count") {
          repeat_count = Math.round(+$("tCount").value);
          if (!(repeat_count >= 2 && repeat_count <= 500)) { err("Repeat between 2 and 500 times."); return; }
          repeat_until = nthDate({ date, ...r }, repeat_count);
        }
      }
      // done: one flag for a one-off task, a list of ticked days for a repeating one
      const doneChecked = !isNew && $("tDone").checked;
      let done_dates = rep && repeats ? [...(t.done_dates || [])] : [];
      if (repeats && !isNew) { done_dates = done_dates.filter(k => k !== occK); if (doneChecked) done_dates.push(occK); }

      $("tSave").disabled = true; $("tSave").textContent = "Saving…";
      try {
        const saved = await saveTask({ id: t.id, title, description: $("tDesc").value.trim(), date,
          start_time: s || null, end_time: en || null, remind: $("tRemind").checked, remind_before: before,
          ...readAlarm(),
          done: !repeats && doneChecked, ...r, repeat_until, repeat_count, done_dates: done_dates.sort(),
          skip_dates: rep && repeats ? (t.skip_dates || []) : [] });
        dlg.close();
        toast(saved.date !== t.date ? `Saved on ${shortDate(saved.date)}` : isNew ? (repeats ? "Repeating task added" : "Task added") : "Task saved");
      } catch(e2) {
        fail(e2);
        $("tSave").disabled = false; $("tSave").textContent = isNew ? "Add task" : "Save changes";
      }
    };
    showDlg(dlg);
    if (isNew) $("tTitle").focus();
  }

  // ---------- account ----------
  function openAuthDlg(){
    const dlg = $("authDlg");
    if (user) {
      const rb = settings.default_remind_before;
      dlg.innerHTML = `<form method="dialog" class="dlg-in" id="acctForm">
        <h2>Account</h2><p class="dlg-sub">Signed in as ${esc(user.email)}</p>
        <label class="fld">Default reminder for new tasks<select id="sDefault">${REMIND_CHOICES.filter(c => c[0] !== "custom").map(([v,l]) => `<option value="${v}" ${v===rb?"selected":""}>${l}</option>`).join("")}${REMIND_CHOICES.some(c=>c[0]===rb)?"":`<option value="${rb}" selected>${rb} min before</option>`}</select></label>
        <div class="acct-snooze">
          <label class="toggle"><input type="checkbox" id="sSnooze" ${settings.snooze_enabled ? "checked" : ""}><span>Snooze button on alarms</span></label>
          <label class="acct-min" id="sSnoozeWrap" ${settings.snooze_enabled ? "" : "hidden"}><input type="number" id="sSnoozeMin" min="1" max="60" step="1" value="${settings.snooze_minutes || 5}" aria-label="Snooze minutes"> min</label>
        </div>
        ${native ? `<div class="acct-test"><span>Try it on this phone:</span>
          <button type="button" class="btn ghost sm" id="aTestN">Notification</button>
          <button type="button" class="btn ghost sm" id="aTestA">Alarm</button></div>
          <p class="dlg-sub acct-note">Both arrive in 10 seconds, even if you close the app.</p>`
        : `<p class="dlg-sub acct-note">Notifications and alarms ring on your phone through the Patro app.</p>`}
        <p class="err" id="aErr"></p>
        <div class="dlg-foot"><button type="button" class="btn danger" id="aOut">Sign out</button><span class="sp"></span>
          <button type="button" class="btn ghost" id="aClose">Close</button><button type="submit" class="btn primary">Save</button></div></form>`;
      $("aClose").onclick = () => dlg.close();
      $("aOut").onclick = async () => { await sb.auth.signOut(); dlg.close(); toast("Signed out"); };
      $("sSnooze").onchange = () => { $("sSnoozeWrap").hidden = !$("sSnooze").checked; };
      if (native) {
        const test = kind => { try { native.test(kind, JSON.stringify({ snooze_enabled: $("sSnooze").checked, snooze_minutes: Math.round(+$("sSnoozeMin").value) || 5 })); toast(kind === "alarm" ? "Alarm rings in 10 seconds" : "Notification in 10 seconds"); } catch(e){} };
        $("aTestN").onclick = () => test("notify");
        $("aTestA").onclick = () => test("alarm");
      }
      $("acctForm").onsubmit = async e => {
        e.preventDefault();
        const v = +$("sDefault").value, mins = Math.round(+$("sSnoozeMin").value);
        if (!(mins >= 1 && mins <= 60)) { $("aErr").textContent = "Snooze must be 1 to 60 minutes."; return; }
        const { data, error } = await sb.from("user_settings").upsert({ user_id: user.id, default_remind_before: v,
          snooze_enabled: $("sSnooze").checked, snooze_minutes: mins }).select().single();
        if (error) { $("aErr").textContent = dbHint(error.message); return; }
        settings = { ...settings, ...data }; syncPhoneSettings(); dlg.close(); toast("Settings saved");
      };
    } else {
      let mode = "in";
      const draw = () => {
        dlg.innerHTML = `<form method="dialog" class="dlg-in" id="authForm" novalidate>
          <h2>${mode==="in" ? "Sign in" : "Create account"}</h2>
          <p class="dlg-sub">${mode==="in" ? "Your tasks sync between your phone and computer." : "Use an email you can open; Supabase sends a confirmation link."}</p>
          <label class="fld">Email<input type="email" id="aEmail" autocomplete="email" required></label>
          <label class="fld">Password<input type="password" id="aPass" autocomplete="${mode==="in"?"current-password":"new-password"}" minlength="8" required></label>
          <p class="err" id="aErr"></p>
          <div class="dlg-foot"><button type="button" class="linkbtn" id="aSwitch">${mode==="in" ? "Create an account" : "I already have an account"}</button><span class="sp"></span>
            <button type="button" class="btn ghost" id="aClose">Cancel</button><button type="submit" class="btn primary" id="aGo">${mode==="in"?"Sign in":"Create account"}</button></div></form>`;
        $("aClose").onclick = () => dlg.close();
        $("aSwitch").onclick = () => { mode = mode === "in" ? "up" : "in"; draw(); };
        $("authForm").onsubmit = async e => {
          e.preventDefault();
          const email = $("aEmail").value.trim(), password = $("aPass").value;
          if (!email || !password) { $("aErr").textContent = "Enter your email and password."; return; }
          if (mode === "up" && password.length < 8) { $("aErr").textContent = "Use at least 8 characters for the password."; return; }
          $("aGo").disabled = true;
          const res = mode === "in"
            ? await sb.auth.signInWithPassword({ email, password })
            : await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
          $("aGo").disabled = false;
          if (res.error) { $("aErr").textContent = res.error.message; return; }
          if (mode === "up" && !res.data.session) { mode = "in"; draw(); $("aErr").textContent = "Check your email and click the confirmation link, then sign in here."; return; }
          dlg.close(); toast("Signed in");
        };
        $("aEmail").focus();
      };
      draw();
    }
    showDlg(dlg);
  }

  function drawAcctBtn(){
    const b = $("acctBtn");
    b.innerHTML = user ? `<span class="acct"><span class="av">${esc(user.email[0])}</span><span class="acct-l">Account</span></span>` : "Sign in";
    b.setAttribute("aria-label", user ? `Account: ${user.email}` : "Sign in");
  }

  // ---------- glue ----------
  function refresh(){ decorateMonth(); renderStrip(true); renderDay(false); syncPhone(); }

  window.Tasks = {
    open: showDay,
    close: closeDay,
    // used by the Android app when a notification is tapped
    openDate(k){
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return;
      const [y,m] = parts(k);
      state.sel = k; state.y = y; state.m = m - 1;
      if (state.view !== "month") setView("month"); else render();
      showDay(k);
    },
    afterRender(){
      decorateMonth(); renderStrip(false);
      if (openDay && openDay !== state.sel && state.view === "month") { openDay = state.sel; renderDay(true); }
    }
  };

  $("acctBtn").onclick = openAuthDlg;
  document.addEventListener("keydown", e => { if (e.key === "Escape" && openDay && !document.querySelector("dialog[open]")) closeDay(); });
  mqList.addEventListener("change", () => { if (openDay) { renderDay(true); document.body.classList.toggle("dp-lock", mqList.matches); } });

  if (sb) {
    sb.auth.onAuthStateChange((event, session) => {
      const was = user?.id;
      user = session?.user || null;
      drawAcctBtn();
      if (user && user.id !== was) { loadCache(user.id); refresh(); setTimeout(() => { fetchSettings(); fetchAll(); }, 0); }
      if (!user) { tasks = []; loaded = false; index(); refresh(); }
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && user) fetchAll(); });
  } else {
    drawAcctBtn();
  }
  renderStrip(false);

  // follow the clock: "Up next", the now line and past tasks update every minute
  setInterval(() => {
    if (document.hidden || document.querySelector("dialog[open]")) return;
    renderStrip(true);
    if (openDay === todayKey()) renderDay(false);
  }, 60000);

  if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
})();
