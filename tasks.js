// Patro tasks: sign-in, the "Up next" strip, the day view (agenda list on phones,
// timeline on computers) and the add/edit sheet. Data lives in Supabase.
// Loaded after the main calendar script and uses its globals (state, render, $, toBS, MON, ...).
(() => {
  const SB_URL = "https://usipczocwwortembguqf.supabase.co";
  // Publishable key: safe to ship in the page. Row level security limits every user to their own rows.
  const SB_KEY = "sb_publishable_IMcvneTU3cMrTDw4rSlJOg_ixtC0-Ea";
  const sb = window.supabase ? window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true } }) : null;

  const HOUR_PX = 48, PX_PER_MIN = HOUR_PX / 60;
  const UNTIMED_REMIND_AT = "09:00"; // reminders for tasks without a time fire at 9 am that day
  const CACHE_KEY = "patro-tasks";
  const REMIND_CHOICES = [[0,"At start time"],[5,"5 min before"],[10,"10 min before"],[15,"15 min before"],[30,"30 min before"],[60,"1 hour before"],[120,"2 hours before"],[1440,"1 day before"],["custom","Custom…"]];
  const mqList = matchMedia("(max-width:900px)"); // agenda list instead of timeline

  let user = null;
  let settings = { default_remind_before: 15 };
  let tasks = [];            // all of the user's tasks
  let byDay = {};            // "YYYY-MM-DD" -> tasks sorted by time
  let openDay = null;        // date shown in the day view, or null when the holiday list shows

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const toMin = t => { if (!t) return null; const [h,m] = t.split(":").map(Number); return h*60 + m; };
  const fmtTime = t => { const m = toMin(t); if (m == null) return ""; const h = Math.floor(m/60), mm = m%60; return `${((h+11)%12)+1}:${String(mm).padStart(2,"0")} ${h<12?"am":"pm"}`; };
  const hhmm = min => `${String(Math.floor(min/60)%24).padStart(2,"0")}:${String(min%60).padStart(2,"0")}`;
  const remindLabel = n => { const c = REMIND_CHOICES.find(x => x[0] === n); return c ? c[1] : (n % 60 === 0 ? `${n/60} h before` : `${n} min before`); };
  const nowMin = () => { const n = new Date(); return n.getHours()*60 + n.getMinutes(); };
  const todayKey = () => { const n = new Date(); return key(n.getFullYear(), n.getMonth(), n.getDate()); };
  const endMin = t => { const s = toMin(t.start_time), e = toMin(t.end_time); return e != null && e > s ? e : s + 30; };
  const relMin = m => m < 60 ? `${m} min` : `${Math.floor(m/60)} h${m%60 ? ` ${m%60} min` : ""}`;
  const bell = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;

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

  // ---------- data ----------
  function index(){
    byDay = {};
    for (const t of tasks) (byDay[t.date] ||= []).push(t);
    for (const d in byDay) byDay[d].sort((a,b) => (toMin(a.start_time) ?? -1) - (toMin(b.start_time) ?? -1) || a.created_at.localeCompare(b.created_at));
  }
  function saveCache(){ try { localStorage.setItem(CACHE_KEY, JSON.stringify({ uid: user?.id, tasks })); } catch(e){} }
  function loadCache(uid){
    try { const c = JSON.parse(localStorage.getItem(CACHE_KEY)); if (c && c.uid === uid) { tasks = c.tasks || []; index(); } } catch(e){}
  }

  async function fetchAll(){
    if (!sb || !user) return;
    const all = []; const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await sb.from("tasks").select("*").order("date").range(from, from + page - 1);
      if (error) { if (navigator.onLine) toast("Couldn't load tasks: " + error.message); return; }
      all.push(...data); if (data.length < page) break;
    }
    tasks = all; index(); saveCache(); refresh();
  }
  async function fetchSettings(){
    const { data } = await sb.from("user_settings").select("*").maybeSingle();
    if (data) settings = data;
  }

  function remindAt(t){
    if (!t.remind) return null;
    const time = t.start_time || UNTIMED_REMIND_AT;
    const base = new Date(`${t.date}T${time.slice(0,5)}:00`);
    return new Date(base.getTime() - (t.start_time ? t.remind_before : 0) * 60000).toISOString();
  }

  async function saveTask(t){
    const row = { date: t.date, start_time: t.start_time || null, end_time: t.start_time ? (t.end_time || null) : null,
      title: t.title, description: t.description || null, done: !!t.done, remind: !!t.remind,
      remind_before: t.remind_before ?? settings.default_remind_before };
    row.remind_at = remindAt(row);
    const old = t.id ? tasks.find(x => x.id === t.id) : null;
    // reminder time changed: let it fire again
    if (!old || old.remind_at !== row.remind_at) row.notified_at = null;
    const q = t.id ? sb.from("tasks").update(row).eq("id", t.id) : sb.from("tasks").insert(row);
    const { data, error } = await q.select().single();
    if (error) throw error;
    tasks = tasks.filter(x => x.id !== data.id).concat(data); index(); saveCache(); refresh();
    return data;
  }
  async function deleteTask(id){
    const { error } = await sb.from("tasks").delete().eq("id", id);
    if (error) throw error;
    tasks = tasks.filter(x => x.id !== id); index(); saveCache(); refresh();
  }
  async function toggleDone(id){
    const t = tasks.find(x => x.id === id); if (!t) return;
    try { await saveTask({ ...t, done: !t.done }); }
    catch(e){ toast(navigator.onLine ? "Couldn't update: " + e.message : "You're offline. Change not saved."); }
  }

  // ---------- month grid markers ----------
  function decorateMonth(){
    document.querySelectorAll("#grid .cell[data-k]").forEach(c => {
      c.querySelector(".tmark")?.remove();
      const list = byDay[c.dataset.k]; if (!list?.length) return;
      const open = list.filter(t => !t.done).length;
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
    const list = byDay[k] || [];
    return [...list.filter(t => t.start_time), ...list.filter(t => !t.start_time)];
  }
  function focusIndex(k, list){
    if (k !== todayKey()) return Math.max(0, list.findIndex(t => !t.done));
    const n = nowMin();
    let i = list.findIndex(t => t.start_time && !t.done && endMin(t) > n);
    if (i < 0) i = list.findIndex(t => !t.start_time && !t.done);
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
    const left = list.filter(t => !t.done).length, done = list.length - left;
    let head = isToday ? "Today's tasks" : "Tasks";
    const f = list[fi];
    if (isToday && f && !f.done && f.start_time) {
      const s = toMin(f.start_time);
      head = s <= n ? `Now · until ${fmtTime(hhmm(endMin(f)))}` : `Up next · in ${relMin(s - n)}`;
    }
    const cards = list.map((t, i) => {
      const past = isToday && t.start_time && endMin(t) <= n;
      const now = isToday && t.start_time && toMin(t.start_time) <= n && endMin(t) > n;
      const cls = ["up-card", t.done ? "done" : "", past && !t.done ? "past" : "", now && !t.done ? "now" : "", i === fi ? "focus" : ""].filter(Boolean).join(" ");
      return `<button class="${cls}" data-id="${t.id}" type="button">
        <span class="up-time">${t.start_time ? fmtTime(t.start_time) : "Any time"}${now && !t.done ? `<em>Now</em>` : ""}</span>
        <span class="up-title">${esc(t.title)}</span>
        <span class="up-meta">${t.done ? "Done" : t.remind ? `${bell}${t.start_time ? remindLabel(t.remind_before).replace(" before","") : "9 am"}` : ""}</span>
      </button>`;
    }).join("");
    const prevLeft = $("upStrip")?.scrollLeft;
    box.innerHTML = `<div class="up-head"><h3>${head}</h3>${list.length ? `<button class="linkbtn" data-act="day" type="button">View day</button>` : ""}</div>
      ${list.length ? `<div class="up-strip" id="upStrip">${cards}</div>` : `<p class="up-empty">Nothing planned for ${isToday ? "today" : "this day"}.</p>`}
      <div class="up-foot"><span>${list.length ? `${left} of ${list.length} left${done ? ` · ${done} done` : ""}` : ""}</span>
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
    const card = e.target.closest(".up-card"); if (card) { openTaskDlg(tasks.find(t => t.id === card.dataset.id)); return; }
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
    const [y,m] = k.split("-").map(Number);
    state.sel = k; state.y = y; state.m = m - 1;
    openDay = k;
    render();
    renderDay(true);
  }

  function weekHTML(){
    const [y,m,d] = openDay.split("-").map(Number);
    const start = new Date(y, m-1, d - new Date(y, m-1, d).getDay());
    const tk = todayKey();
    let days = "";
    for (let i = 0; i < 7; i++) {
      const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const k = key(dt.getFullYear(), dt.getMonth(), dt.getDate()), b = toBS(dt.getFullYear(), dt.getMonth(), dt.getDate());
      const open = (byDay[k] || []).filter(t => !t.done).length;
      const hol = (byDate[k] || []).some(h => h.t === "public");
      const cls = ["wk-day", k === openDay ? "sel" : "", k === tk ? "today" : "", (i === 0 || i === 6 || hol) ? "off" : ""].filter(Boolean).join(" ");
      days += `<button class="${cls}" data-day="${k}" type="button" aria-label="${dt.toDateString()}${open ? `, ${open} open tasks` : ""}" ${k === openDay ? 'aria-current="date"' : ""}>
        <small>${DOW[i][0]}</small><b>${dt.getDate()}</b><i>${b ? np(b.d) : ""}</i><span class="wk-dot${open ? "" : " none"}"></span></button>`;
    }
    const prevK = key(start.getFullYear(), start.getMonth(), start.getDate() - 7), nextK = key(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    const norm = s => { const [a,b,c] = s.split("-").map(Number); const t = new Date(a, b-1, c); return key(t.getFullYear(), t.getMonth(), t.getDate()); };
    return `<div class="wk"><button class="wk-nav" data-day="${norm(prevK)}" type="button" aria-label="Previous week">‹</button>
      <div class="wk-days">${days}</div>
      <button class="wk-nav" data-day="${norm(nextK)}" type="button" aria-label="Next week">›</button></div>`;
  }

  function agendaHTML(list){
    if (!list.length) return `<div class="ag-empty"><p>No tasks for this day.</p><button class="btn primary" id="agAdd" type="button">+ Add a task</button></div>`;
    const isToday = openDay === todayKey(), n = nowMin();
    const groups = [
      ["Any time", list.filter(t => !t.start_time)],
      ["Morning", list.filter(t => t.start_time && toMin(t.start_time) < 720)],
      ["Afternoon", list.filter(t => t.start_time && toMin(t.start_time) >= 720 && toMin(t.start_time) < 1020)],
      ["Evening", list.filter(t => t.start_time && toMin(t.start_time) >= 1020)],
    ];
    let nowShown = !isToday, html = "";
    const nowLine = `<div class="ag-now" role="presentation"><span>Now · ${fmtTime(hhmm(n))}</span></div>`;
    for (const [label, items] of groups) {
      if (!items.length) continue;
      html += `<div class="ag-group"><h4>${label}</h4>`;
      for (const t of items) {
        if (!nowShown && t.start_time && toMin(t.start_time) > n) { html += nowLine; nowShown = true; }
        const live = isToday && t.start_time && toMin(t.start_time) <= n && endMin(t) > n && !t.done;
        html += `<div class="ag-row${t.done ? " done" : ""}${live ? " live" : ""}" data-id="${t.id}" role="button" tabindex="0">
          <span class="tcheck" role="checkbox" aria-checked="${t.done}" aria-label="Mark done" data-done="${t.id}"></span>
          <span class="ag-time">${t.start_time ? `${fmtTime(t.start_time)}${t.end_time ? `<small>${fmtTime(t.end_time)}</small>` : ""}` : ""}</span>
          <span class="ag-main"><b>${esc(t.title)}</b>${t.description ? `<small>${esc(t.description.split("\n")[0])}</small>` : ""}</span>
          ${t.remind && !t.done ? `<span class="ag-bell" title="Reminder ${t.start_time ? remindLabel(t.remind_before) : "at 9 am"}">${bell}</span>` : ""}
        </div>`;
      }
      html += `</div>`;
    }
    if (!nowShown) html += nowLine;
    return `<div class="ag">${html}</div>`;
  }

  function timelineHTML(list){
    const untimed = list.filter(t => !t.start_time), timed = list.filter(t => t.start_time);
    const hours = Array.from({length:24}, (_,h) => `<div class="tl-hour" data-h="${h}"><span>${h===0?"":fmtTime(hhmm(h*60)).replace(":00","")}</span><div></div></div>`).join("");
    // lay out overlapping blocks side by side
    const items = timed.map(t => { const s = toMin(t.start_time); return { t, s, e: Math.max(endMin(t), s + 25) }; });
    let cluster = [], clusterEnd = -1;
    const flush = () => { const cols = []; for (const it of cluster) { let c = cols.findIndex(end => end <= it.s); if (c < 0) { c = cols.length; cols.push(0); } cols[c] = it.e; it.col = c; } cluster.forEach(it => it.cols = cols.length); cluster = []; };
    for (const it of items) { if (it.s >= clusterEnd) flush(); cluster.push(it); clusterEnd = Math.max(clusterEnd, it.e); }
    flush();
    const blocks = items.map(({t,s,e,col,cols}) => `<div class="tblock${t.done?" done":""}" role="button" tabindex="0" data-id="${t.id}"
        style="top:${s*PX_PER_MIN}px;height:${(e-s)*PX_PER_MIN-2}px;left:calc(${col}*100%/${cols});width:calc(100%/${cols} - 3px)">
        <span class="tcheck" role="checkbox" aria-checked="${t.done}" aria-label="Mark done" data-done="${t.id}"></span>
        <b>${esc(t.title)}</b><small>${fmtTime(t.start_time)}${t.end_time?` – ${fmtTime(t.end_time)}`:""}</small></div>`).join("");
    const nowLine = openDay === todayKey() ? `<div class="tl-now" style="top:${nowMin()*PX_PER_MIN}px"></div>` : "";
    const chips = untimed.length ? `<span class="lab">Any time</span>` + untimed.map(t => `<div class="tchip${t.done?" done":""}" role="button" tabindex="0" data-id="${t.id}">
        <span class="tcheck" role="checkbox" aria-checked="${t.done}" aria-label="Mark done" data-done="${t.id}"></span>${esc(t.title)}</div>`).join("") : "";
    return `<div class="dp-untimed">${chips}</div>
      <div class="dp-scroll" id="dpScroll"><div class="tl">${hours}<div class="tl-blocks">${blocks}</div>${nowLine}</div></div>`;
  }

  function renderDay(scroll){
    if (!openDay) return;
    const prevTop = $("dpScroll")?.scrollTop;
    const listMode = mqList.matches;
    const [y,m,d] = openDay.split("-").map(Number);
    const dt = new Date(y, m-1, d), b = toBS(y, m-1, d);
    const hols = (byDate[openDay] || []).filter(h => h.t !== "obs").map(h => `<span class="htag ${h.t}">${h.n.split(" · ")[0]}</span>`).join("");
    const head = `<div class="dp-head">
        <button class="iconbtn dp-back" id="dpClose" type="button" aria-label="Back to calendar">${listMode ? "‹" : "×"}</button>
        <div class="dp-title"><div class="dp-date">${dt.toLocaleDateString("en-GB",{weekday:"short"})}, ${MON[m-1]} ${d}${openDay===todayKey() ? ` <span class="dp-today">Today</span>` : ""}</div>
          <div class="dp-bs">${b ? `${BS_MONTHS_NP[b.m]} ${np(b.d)} · ${WEEKDAY_NP[dt.getDay()]}` : ""}</div>${hols ? `<div class="dp-hols">${hols}</div>` : ""}</div>
        ${user && !listMode ? `<button class="btn primary" id="dpAdd" type="button">+ Add</button>` : ""}
      </div>${weekHTML()}`;

    let body;
    if (!sb) body = `<div class="dp-empty">Tasks need an internet connection the first time you open the app.</div>`;
    else if (!user) body = `<div class="dp-empty">Sign in to add tasks and get reminders on your phone.<br><button class="btn primary" id="dpSignin" type="button">Sign in</button></div>`;
    else body = listMode ? `<div class="dp-scroll" id="dpScroll">${agendaHTML(byDay[openDay] || [])}</div>` : timelineHTML(byDay[openDay] || []);

    $("dayPanel").innerHTML = head + `<div class="dp-body">${body}</div>` + (user && listMode ? `<button class="fab" id="dpFab" type="button" aria-label="Add task">+</button>` : "");
    wire();
    if (!scroll && prevTop != null && $("dpScroll")) $("dpScroll").scrollTop = prevTop;
    if (scroll && !listMode && $("dpScroll")) {
      const timed = (byDay[openDay] || []).filter(t => t.start_time);
      const target = openDay === todayKey() ? nowMin() - 90 : (timed.length ? toMin(timed[0].start_time) : 8*60) - 60;
      $("dpScroll").scrollTop = Math.max(0, target) * PX_PER_MIN;
    }
    if (scroll && listMode) $("dayPanel").querySelector(".ag-now, .ag-row.live")?.scrollIntoView({ block: "center" });
    $("dayPanel").querySelector(".wk-day.sel")?.scrollIntoView({ inline: "center", block: "nearest" });
  }

  function wire(){
    $("dpClose").onclick = closeDay;
    const add = () => openTaskDlg({ date: openDay });
    ["dpAdd","dpFab","agAdd"].forEach(id => { if ($(id)) $(id).onclick = add; });
    if ($("dpSignin")) $("dpSignin").onclick = openAuthDlg;
    const panel = $("dayPanel");
    panel.onclick = e => {
      const day = e.target.closest("[data-day]"); if (day) { gotoDay(day.dataset.day); return; }
      const chk = e.target.closest("[data-done]"); if (chk) { e.stopPropagation(); toggleDone(chk.dataset.done); return; }
      const row = e.target.closest("[data-id]"); if (row) { openTaskDlg(tasks.find(t => t.id === row.dataset.id)); return; }
      const slot = e.target.closest(".tl-hour > div");
      if (slot && user) {
        const h = +slot.parentElement.dataset.h, r = slot.getBoundingClientRect();
        const min = h*60 + ((e.clientY - r.top) / r.height >= .5 ? 30 : 0);
        openTaskDlg({ date: openDay, start_time: hhmm(min), end_time: hhmm(Math.min(min + 60, 23*60 + 59)) });
      }
    };
    panel.onkeydown = e => { if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-id]")) { e.preventDefault(); openTaskDlg(tasks.find(t => t.id === e.target.dataset.id)); } };
  }

  // ---------- add / edit sheet ----------
  function openTaskDlg(t){
    if (!t) return;
    if (!user) { openAuthDlg(); return; }
    const isNew = !t.id;
    const rb = t.remind_before ?? settings.default_remind_before;
    const preset = REMIND_CHOICES.some(c => c[0] === rb);
    const dlg = $("taskDlg");
    dlg.classList.add("sheet");
    dlg.innerHTML = `<form method="dialog" class="sh" id="taskForm" novalidate>
      <div class="sh-grab" aria-hidden="true"></div>
      <div class="sh-top"><h2>${isNew ? "New task" : "Edit task"}</h2>
        <button type="button" class="iconbtn" id="tCancel" aria-label="Close">×</button></div>
      <input class="sh-title" id="tTitle" maxlength="200" value="${esc(t.title)}" placeholder="What needs doing?" autocomplete="off" aria-label="Task title">
      <div class="sh-rows">
        <label class="sh-row"><span>Date</span><input type="date" id="tDate" value="${t.date}" required></label>
        <div class="sh-row sh-times">
          <label><span>Start</span><input type="time" id="tStart" value="${(t.start_time||"").slice(0,5)}"></label>
          <label><span>End</span><input type="time" id="tEnd" value="${(t.end_time||"").slice(0,5)}"></label>
        </div>
        <p class="sh-hint" id="tTimeHint">Leave Start empty for a task you can do any time that day.</p>
        <div class="sh-row sh-remind">
          <label class="toggle"><input type="checkbox" id="tRemind" ${t.remind === false ? "" : "checked"}><span>${bell}Remind me</span></label>
          <select id="tBefore" aria-label="When to remind">${REMIND_CHOICES.map(([v,l]) => `<option value="${v}">${l}</option>`).join("")}</select>
        </div>
        <label class="sh-row" id="tCustomWrap" hidden><span>Minutes before</span><input type="number" id="tCustom" min="0" max="10080" step="1" value="${rb}"></label>
        <p class="sh-hint" id="tRemindHint" hidden>No start time, so the reminder comes at 9 am.</p>
        <button type="button" class="linkbtn sh-notebtn" id="tNoteBtn" ${t.description ? "hidden" : ""}>+ Add note</button>
        <label class="sh-note" id="tNoteWrap" ${t.description ? "" : "hidden"}><span>Note</span><textarea id="tDesc" rows="3">${esc(t.description)}</textarea></label>
        ${isNew ? "" : `<label class="toggle sh-done"><input type="checkbox" id="tDone" ${t.done ? "checked" : ""}><span>Done</span></label>`}
      </div>
      <p class="err" id="tErr"></p>
      <button type="submit" class="btn primary sh-save" id="tSave">${isNew ? "Add task" : "Save changes"}</button>
      ${isNew ? "" : `<button type="button" class="btn ghost danger sh-del" id="tDel">Delete task</button>`}
    </form>`;
    $("tBefore").value = preset ? String(rb) : "custom";

    const sync = () => {
      const on = $("tRemind").checked, timed = !!$("tStart").value;
      $("tBefore").hidden = !on || !timed;
      $("tCustomWrap").hidden = !on || !timed || $("tBefore").value !== "custom";
      $("tRemindHint").hidden = !on || timed;
      $("tTimeHint").hidden = timed;
    };
    ["tRemind","tStart","tBefore"].forEach(id => $(id).addEventListener("input", sync));
    $("tStart").addEventListener("change", () => {
      // keep an hour-long slot when the start moves and the end is empty or now before it
      const s = toMin($("tStart").value), e = toMin($("tEnd").value);
      if (s != null && (e == null || e <= s)) $("tEnd").value = hhmm(Math.min(s + 60, 23*60 + 59));
    });
    $("tNoteBtn").onclick = () => { $("tNoteBtn").hidden = true; $("tNoteWrap").hidden = false; $("tDesc").focus(); };
    sync();

    $("tCancel").onclick = () => dlg.close();
    if (!isNew) {
      $("tDel").onclick = async () => {
        if ($("tDel").dataset.armed !== "1") { $("tDel").dataset.armed = "1"; $("tDel").textContent = "Tap again to delete"; return; }
        try { await deleteTask(t.id); dlg.close(); toast("Task deleted"); }
        catch(e){ $("tErr").textContent = navigator.onLine ? e.message : "You're offline. Try again when connected."; }
      };
    }
    $("taskForm").onsubmit = async e => {
      e.preventDefault();
      const title = $("tTitle").value.trim();
      if (!title) { $("tErr").textContent = "Give the task a title."; $("tTitle").focus(); return; }
      if (!$("tDate").value) { $("tErr").textContent = "Pick a date."; return; }
      const s = $("tStart").value, en = $("tEnd").value;
      if (!s && en) { $("tErr").textContent = "Add a start time, or clear the end time."; return; }
      if (s && en && toMin(en) <= toMin(s)) { $("tErr").textContent = "End time must be after the start time."; return; }
      const before = $("tBefore").value === "custom" ? Math.round(+$("tCustom").value) : +$("tBefore").value;
      if (!(before >= 0 && before <= 10080)) { $("tErr").textContent = "Reminder must be between 0 and 10080 minutes before."; return; }
      $("tSave").disabled = true; $("tSave").textContent = "Saving…";
      try {
        const saved = await saveTask({ id: t.id, title, description: $("tDesc").value.trim(), date: $("tDate").value,
          start_time: s || null, end_time: en || null, remind: $("tRemind").checked, remind_before: before,
          done: isNew ? false : $("tDone").checked });
        dlg.close();
        toast(saved.date !== t.date ? `Saved on ${saved.date}` : isNew ? "Task added" : "Task saved");
      } catch(err) {
        $("tErr").textContent = navigator.onLine ? "Couldn't save: " + err.message : "You're offline. Try again when connected.";
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
        <p class="err" id="aErr"></p>
        <div class="dlg-foot"><button type="button" class="btn danger" id="aOut">Sign out</button><span class="sp"></span>
          <button type="button" class="btn ghost" id="aClose">Close</button><button type="submit" class="btn primary">Save</button></div></form>`;
      $("aClose").onclick = () => dlg.close();
      $("aOut").onclick = async () => { await sb.auth.signOut(); dlg.close(); toast("Signed out"); };
      $("acctForm").onsubmit = async e => {
        e.preventDefault();
        const v = +$("sDefault").value;
        const { data, error } = await sb.from("user_settings").upsert({ user_id: user.id, default_remind_before: v }).select().single();
        if (error) { $("aErr").textContent = error.message; return; }
        settings = data; dlg.close(); toast("Default reminder saved");
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
  function refresh(){ decorateMonth(); renderStrip(true); renderDay(false); }

  window.Tasks = {
    open: showDay,
    close: closeDay,
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
      if (!user) { tasks = []; index(); refresh(); }
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
