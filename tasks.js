// Patro tasks: sign-in, per-day timeline and task editing, stored in Supabase.
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

  let user = null;
  let settings = { default_remind_before: 15 };
  let tasks = [];            // all of the user's tasks
  let byDay = {};            // "YYYY-MM-DD" -> tasks sorted by time
  let openDay = null;        // date shown in the day panel, or null when the holiday list shows

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const toMin = t => { if (!t) return null; const [h,m] = t.split(":").map(Number); return h*60 + m; };
  const fmtTime = t => { const m = toMin(t); if (m == null) return ""; const h = Math.floor(m/60), mm = m%60; return `${((h+11)%12)+1}:${String(mm).padStart(2,"0")} ${h<12?"am":"pm"}`; };
  const hhmm = min => `${String(Math.floor(min/60)%24).padStart(2,"0")}:${String(min%60).padStart(2,"0")}`;
  const remindLabel = n => { const c = REMIND_CHOICES.find(x => x[0] === n); return c ? c[1] : (n % 60 === 0 ? `${n/60} h before` : `${n} min before`); };

  function toast(msg){
    let t = document.querySelector(".toast");
    if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role","status"); document.body.append(t); }
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 3200);
  }

  // ---------- back button ----------
  // Each open layer (day panel, dialog) adds a history entry. Back pops the top layer.
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

  // ---------- day panel ----------
  let dayLayer = null;
  function showDay(k){
    if (!dayLayer) dayLayer = pushLayer(() => { dayLayer = null; hideDay(); });
    openDay = k;
    $("holPanel").hidden = true;
    const p = $("dayPanel"); p.hidden = false; p.classList.add("open");
    if (matchMedia("(max-width:900px)").matches) document.body.classList.add("dp-lock");
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

  function renderDay(scroll){
    if (!openDay) return;
    const prevTop = $("dpScroll")?.scrollTop;
    const [y,m,d] = openDay.split("-").map(Number);
    const dt = new Date(y, m-1, d), b = toBS(y, m-1, d);
    const head = `<div class="dp-head">
        <div><h3>${openDay===TODAY ? "Today's tasks" : "Tasks"}</h3>
          <div class="dp-date">${dt.toLocaleDateString("en-GB",{weekday:"short"})}, ${MON[m-1]} ${d}</div>
          <div class="dp-bs">${BS_MONTHS_NP[b.m]} ${np(b.d)} · ${WEEKDAY_NP[dt.getDay()]}</div></div>
        <div class="dp-actions">${user ? `<button class="btn primary" id="dpAdd">+ Add</button>` : ""}<button class="iconbtn" id="dpClose" aria-label="Close tasks">×</button></div>
      </div>`;

    if (!sb) { $("dayPanel").innerHTML = head + `<div class="dp-empty">Tasks need an internet connection the first time you open the app.</div>`; wire(); return; }
    if (!user) {
      $("dayPanel").innerHTML = head + `<div class="dp-empty">Sign in to add tasks and get reminders on your phone.<br><button class="btn primary" id="dpSignin">Sign in</button></div>`;
      wire(); return;
    }

    const list = byDay[openDay] || [];
    const untimed = list.filter(t => !t.start_time), timed = list.filter(t => t.start_time);
    const hours = Array.from({length:24}, (_,h) => `<div class="tl-hour" data-h="${h}"><span>${h===0?"":fmtTime(hhmm(h*60)).replace(":00","")}</span><div></div></div>`).join("");

    // lay out overlapping blocks side by side
    const items = timed.map(t => { const s = toMin(t.start_time); let e = toMin(t.end_time); if (e == null || e <= s) e = s + 30; return { t, s, e: Math.max(e, s + 25) }; });
    let cluster = [], clusterEnd = -1;
    const flush = () => { const cols = []; for (const it of cluster) { let c = cols.findIndex(end => end <= it.s); if (c < 0) { c = cols.length; cols.push(0); } cols[c] = it.e; it.col = c; } cluster.forEach(it => it.cols = cols.length); cluster = []; };
    for (const it of items) { if (it.s >= clusterEnd) flush(); cluster.push(it); clusterEnd = Math.max(clusterEnd, it.e); }
    flush();
    const blocks = items.map(({t,s,e,col,cols}) => `<div class="tblock${t.done?" done":""}" role="button" tabindex="0" data-id="${t.id}"
        style="top:${s*PX_PER_MIN}px;height:${(e-s)*PX_PER_MIN-2}px;left:calc(${col}*100%/${cols});width:calc(100%/${cols} - 3px)">
        <span class="tcheck" role="checkbox" aria-checked="${t.done}" aria-label="Mark done" data-done="${t.id}"></span>
        <b>${esc(t.title)}</b><small>${fmtTime(t.start_time)}${t.end_time?` – ${fmtTime(t.end_time)}`:""}${t.remind?`<span class="tbell" title="Reminder ${remindLabel(t.remind_before)}">🔔</span>`:""}</small></div>`).join("");

    const nowLine = openDay === TODAY ? (() => { const n = new Date(); return `<div class="tl-now" style="top:${(n.getHours()*60+n.getMinutes())*PX_PER_MIN}px"></div>`; })() : "";
    const chips = untimed.length ? `<span class="lab">Any time</span>` + untimed.map(t => `<div class="tchip${t.done?" done":""}" role="button" tabindex="0" data-id="${t.id}">
        <span class="tcheck" role="checkbox" aria-checked="${t.done}" aria-label="Mark done" data-done="${t.id}"></span>${esc(t.title)}${t.remind?`<span class="tbell" title="Reminder at 9 am">🔔</span>`:""}</div>`).join("") : "";

    $("dayPanel").innerHTML = head + `<div class="dp-body">
        <div class="dp-untimed">${chips}</div>
        <div class="dp-scroll" id="dpScroll"><div class="tl">${hours}<div class="tl-blocks">${blocks}</div>${nowLine}</div></div>
      </div>`;
    wire();
    if (!scroll && prevTop != null) $("dpScroll").scrollTop = prevTop;
    if (scroll) {
      const first = items[0]?.s, now = new Date();
      const target = openDay === TODAY ? now.getHours()*60 + now.getMinutes() - 90 : (first ?? 8*60) - 60;
      $("dpScroll").scrollTop = Math.max(0, target) * PX_PER_MIN;
    }
  }

  function wire(){
    $("dpClose").onclick = closeDay;
    $("dpAdd") && ($("dpAdd").onclick = () => openTaskDlg({ date: openDay }));
    $("dpSignin") && ($("dpSignin").onclick = openAuthDlg);
    const panel = $("dayPanel");
    panel.onclick = e => {
      const chk = e.target.closest("[data-done]"); if (chk) { e.stopPropagation(); toggleDone(chk.dataset.done); return; }
      const blk = e.target.closest("[data-id]"); if (blk) { openTaskDlg(tasks.find(t => t.id === blk.dataset.id)); return; }
      const slot = e.target.closest(".tl-hour > div");
      if (slot) {
        const h = +slot.parentElement.dataset.h, r = slot.getBoundingClientRect();
        const min = h*60 + ((e.clientY - r.top) / r.height >= .5 ? 30 : 0);
        openTaskDlg({ date: openDay, start_time: hhmm(min), end_time: hhmm(Math.min(min + 60, 23*60 + 59)) });
      }
    };
    panel.onkeydown = e => { if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-id]")) { e.preventDefault(); openTaskDlg(tasks.find(t => t.id === e.target.dataset.id)); } };
  }

  // ---------- task dialog ----------
  function openTaskDlg(t){
    if (!user) { openAuthDlg(); return; }
    const isNew = !t.id;
    const rb = t.remind_before ?? settings.default_remind_before;
    const preset = REMIND_CHOICES.some(c => c[0] === rb);
    const dlg = $("taskDlg");
    dlg.innerHTML = `<form method="dialog" class="dlg-in" id="taskForm" novalidate>
      <h2>${isNew ? "New task" : "Edit task"}</h2>
      <label class="fld">Title<input id="tTitle" maxlength="200" required value="${esc(t.title)}" placeholder="What needs doing?" autocomplete="off"></label>
      <label class="fld">Description<textarea id="tDesc" placeholder="Notes (optional)">${esc(t.description)}</textarea></label>
      <div class="row3">
        <label class="fld">Date<input type="date" id="tDate" value="${t.date}" required></label>
        <label class="fld">Start<input type="time" id="tStart" value="${(t.start_time||"").slice(0,5)}"></label>
        <label class="fld">End<input type="time" id="tEnd" value="${(t.end_time||"").slice(0,5)}"></label>
      </div>
      <p class="hint" id="tTimeHint">Leave the start time empty for a task that can be done any time that day.</p>
      <div class="remind-box">
        <label class="toggle"><input type="checkbox" id="tRemind" ${t.remind === false ? "" : "checked"}>Remind me</label>
        <div id="tRemindOpts">
          <label class="fld">When<select id="tBefore">${REMIND_CHOICES.map(([v,l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
          <label class="fld" id="tCustomWrap" hidden>Minutes before<input type="number" id="tCustom" min="0" max="10080" step="1" value="${rb}"></label>
          <p class="hint" id="tRemindHint"></p>
        </div>
      </div>
      ${isNew ? "" : `<label class="toggle"><input type="checkbox" id="tDone" ${t.done ? "checked" : ""}>Done</label>`}
      <p class="err" id="tErr"></p>
      <div class="dlg-foot">
        ${isNew ? "" : `<button type="button" class="btn danger" id="tDel">Delete</button>`}
        <span class="sp"></span>
        <button type="button" class="btn ghost" id="tCancel">Cancel</button>
        <button type="submit" class="btn primary" id="tSave">${isNew ? "Add task" : "Save"}</button>
      </div></form>`;
    $("tBefore").value = preset ? String(rb) : "custom";
    $("tCustomWrap").hidden = preset;

    const sync = () => {
      const on = $("tRemind").checked, timed = !!$("tStart").value;
      $("tRemindOpts").hidden = !on;
      $("tBefore").disabled = !timed;
      $("tCustomWrap").hidden = $("tBefore").value !== "custom" || !timed;
      $("tRemindHint").textContent = timed ? "" : "No start time set, so the reminder comes at 9 am that day.";
      $("tTimeHint").hidden = timed;
    };
    ["tRemind","tStart","tBefore"].forEach(id => $(id).addEventListener("input", sync));
    $("tStart").addEventListener("change", () => {
      // keep an hour-long slot when the start moves and the end is empty or now before it
      const s = toMin($("tStart").value), e = toMin($("tEnd").value);
      if (s != null && (e == null || e <= s)) $("tEnd").value = hhmm(Math.min(s + 60, 23*60 + 59));
    });
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
      if (s && en && toMin(en) <= toMin(s)) { $("tErr").textContent = "End time must be after the start time."; return; }
      let before = $("tBefore").value === "custom" ? Math.round(+$("tCustom").value) : +$("tBefore").value;
      if (!(before >= 0 && before <= 10080)) { $("tErr").textContent = "Reminder must be between 0 and 10080 minutes before."; return; }
      $("tSave").disabled = true; $("tSave").textContent = "Saving…";
      try {
        const saved = await saveTask({ id: t.id, title, description: $("tDesc").value.trim(), date: $("tDate").value,
          start_time: s || null, end_time: en || null, remind: $("tRemind").checked, remind_before: before,
          done: isNew ? false : $("tDone").checked });
        dlg.close();
        toast(isNew ? "Task added" : "Task saved");
        if (saved.date !== openDay) toast(`Saved on ${saved.date}`);
      } catch(err) {
        $("tErr").textContent = navigator.onLine ? "Couldn't save: " + err.message : "You're offline. Try again when connected.";
        $("tSave").disabled = false; $("tSave").textContent = isNew ? "Add task" : "Save";
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

  // ---------- day card button ----------
  function decorateDetail(){
    const col = document.querySelector("#detail > div"); if (!col || state.view !== "month") return;
    const k = state.sel, n = (byDay[k] || []).filter(t => !t.done).length;
    const row = document.createElement("div"); row.className = "dh-tasks";
    const touch = matchMedia("(pointer:coarse)").matches;
    row.innerHTML = `<button class="btn" type="button">${user ? (n ? `Tasks · ${n}` : "Tasks") : "Tasks"}</button><span class="hint">or ${touch ? "double-tap" : "double-click"} a date</span>`;
    row.querySelector("button").onclick = () => showDay(k);
    col.append(row);
  }

  // ---------- glue ----------
  function refresh(){ decorateMonth(); document.querySelector(".dh-tasks")?.remove(); decorateDetail(); renderDay(false); }

  window.Tasks = {
    open: showDay,
    close: closeDay,
    afterRender(){ decorateMonth(); decorateDetail(); if (openDay && openDay !== state.sel && state.view === "month") { openDay = state.sel; renderDay(true); } }
  };

  $("acctBtn").onclick = openAuthDlg;
  document.addEventListener("keydown", e => { if (e.key === "Escape" && openDay && !document.querySelector("dialog[open]")) closeDay(); });

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

  // keep the now-line moving on today's timeline
  setInterval(() => { if (openDay === TODAY && !document.hidden && !document.querySelector("dialog[open]")) renderDay(false); }, 60000);

  if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
})();
