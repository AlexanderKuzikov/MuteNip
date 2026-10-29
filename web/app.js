const $ = (id) => document.getElementById(id);

const state = {
  dir: "",
  scan: null,
  view: "",
  query: "",
  sortKey: "name",
  sortDir: 1,
  selected: new Set(),
  lastIndex: -1,
  visible: [],
  toolsReady: false,
  deleting: false,
  scanToken: 0,
  procToken: 0,
  proc: null,
  resultDir: "",
};

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(path, method = "GET", body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  if (n >= gb) return (n / gb).toFixed(1) + " GB";
  if (n >= mb) return (n / mb).toFixed(1) + " MB";
  if (n >= kb) return Math.round(n / kb) + " KB";
  return Math.round(n) + " B";
}

function fmtDur(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  return m + ":" + String(s).padStart(2, "0");
}

const CODEC_NAMES = {
  aac: "AAC",
  mp3: "MP3",
  opus: "Opus",
  vorbis: "Vorbis",
  ac3: "AC-3",
  eac3: "E-AC-3",
  dts: "DTS",
  flac: "FLAC",
  alac: "ALAC",
  pcm_s16le: "PCM",
  pcm_s24le: "PCM",
};

function audioLabel(f) {
  const codec = CODEC_NAMES[(f.audio_codec || "").toLowerCase()] || f.audio_codec || "звук";
  if (f.audio_bitrate > 0) return codec + " " + Math.round(f.audio_bitrate / 1000) + "k";
  return codec;
}

function baseName(rel) {
  const parts = rel.split("/");
  return parts[parts.length - 1];
}

function dirName(rel) {
  const parts = rel.split("/");
  parts.pop();
  return parts.join("/");
}

function isEligible(f) {
  return !!(f && f.probed && !f.error && f.has_video && f.has_audio);
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function showBanner(text) {
  const banner = $("banner");
  banner.textContent = text;
  banner.hidden = false;
}

function hideBanner() {
  $("banner").hidden = true;
}

function setDeleting(value) {
  state.deleting = value;
  $("delete-source").checked = value;
  renderFooters(state.scan ? state.scan.files : []);
}

async function init() {
  try {
    const tools = await api("/api/tools");
    state.toolsReady = !!tools.ready;
    if (state.toolsReady) {
      $("tools-chip").hidden = false;
      $("choose").disabled = false;
    } else {
      $("tools-chip").hidden = true;
      $("choose").disabled = true;
      showBanner(tools.error || "ffmpeg/ffprobe не найдены");
    }
  } catch (e) {
    showBanner(e.message);
  }

  $("choose").addEventListener("click", chooseFolder);
  $("rescan").addEventListener("click", () => state.dir && startScan(state.dir));
  $("scan-cancel").addEventListener("click", cancelScan);
  $("delete-source").addEventListener("change", () => setDeleting($("delete-source").checked));
  $("start").addEventListener("click", onStart);
  $("progress-cancel").addEventListener("click", cancelProcess);
  $("confirm-no").addEventListener("click", () => ($("confirm-overlay").hidden = true));
  $("confirm-yes").addEventListener("click", () => {
    $("confirm-overlay").hidden = true;
    startProcess();
  });
  $("result-open").addEventListener("click", openFolder);
  $("result-close").addEventListener("click", () => {
    $("result-overlay").hidden = true;
    if (state.dir) startScan(state.dir);
  });
  $("select-all").addEventListener("change", onSelectAll);
  $("search").addEventListener("input", () => {
    state.query = $("search").value;
    state.lastIndex = -1;
    render(true);
  });
  document.querySelectorAll(".th.sortable").forEach((btn) => {
    btn.addEventListener("click", () => onSort(btn.dataset.sort));
  });

  try {
    const cfg = await api("/api/config");
    if (cfg.last_dir && state.toolsReady) {
      await startScan(cfg.last_dir);
    }
  } catch {
    // конфиг не критичен
  }
}

async function chooseFolder() {
  try {
    const res = await api("/api/folder", "POST", {});
    if (res.path) await startScan(res.path);
  } catch (e) {
    showBanner(e.message);
  }
}

async function startScan(dir) {
  try {
    await api("/api/scan", "POST", { dir });
  } catch (e) {
    showBanner(e.message);
    return;
  }

  const sameDir = dir === state.dir;
  state.dir = dir;
  if (!sameDir) {
    state.view = "";
    state.query = "";
    $("search").value = "";
  }
  state.selected.clear();
  state.lastIndex = -1;
  state.scan = null;
  state.scanToken++;
  state.proc = null;

  $("root-path").textContent = dir;
  $("root-path").title = dir;
  $("root-path").classList.remove("muted");
  $("welcome").hidden = true;
  $("workspace").hidden = false;
  $("actionbar").hidden = false;
  $("rescan").hidden = false;
  $("rescan").disabled = true;
  $("choose").disabled = true;
  $("scan-inline").hidden = false;
  $("scan-cancel").hidden = false;
  $("scan-cancel").disabled = false;
  $("scan-bar").style.width = "0%";
  $("scan-text").textContent = "Сканирование…";
  hideBanner();

  render(true);
  pollScan(state.scanToken);
}

async function cancelScan() {
  $("scan-cancel").disabled = true;
  try {
    await api("/api/scan/cancel", "POST", {});
  } catch {
    // следующий опрос сам покажет состояние
  }
}

async function pollScan(token) {
  if (token !== state.scanToken) return;
  let st;
  try {
    st = await api("/api/scan/status");
  } catch (e) {
    showBanner(e.message);
    return;
  }
  if (token !== state.scanToken) return;

  state.scan = st;
  const pct = st.total > 0 ? Math.round((st.done / st.total) * 100) : 0;
  $("scan-bar").style.width = pct + "%";
  $("scan-text").textContent = st.total > 0
    ? `Проверено ${st.done} из ${st.total}`
    : "Ищу видео…";

  render(false);

  if (st.running) {
    setTimeout(() => pollScan(token), 400);
  } else {
    finishScan(st);
  }
}

function finishScan(st) {
  $("scan-inline").hidden = true;
  $("choose").disabled = !state.toolsReady;
  $("rescan").disabled = false;
  if (st.error) {
    showBanner(st.error);
  } else {
    hideBanner();
  }
  render(false);
}

function buildTree(files) {
  const root = { name: "Все файлы", path: "", children: new Map(), files: [], eligible: [], count: 0 };
  for (const f of files) {
    const parts = f.rel.split("/");
    parts.pop();
    let node = root;
    for (const part of parts) {
      let child = node.children.get(part);
      if (!child) {
        child = {
          name: part,
          path: node.path ? node.path + "/" + part : part,
          children: new Map(),
          files: [],
          eligible: [],
          count: 0,
        };
        node.children.set(part, child);
      }
      node = child;
    }
    node.files.push(f);
  }
  computeTree(root);
  return root;
}

function computeTree(node) {
  const eligible = [];
  for (const f of node.files) {
    node.count++;
    if (isEligible(f)) eligible.push(f.path);
  }
  const kids = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  node.sortedChildren = kids;
  for (const kid of kids) {
    computeTree(kid);
    node.count += kid.count;
    eligible.push(...kid.eligible);
  }
  node.eligible = eligible;
}

function findNode(node, path) {
  if (node.path === path) return node;
  for (const kid of node.sortedChildren || []) {
    const found = findNode(kid, path);
    if (found) return found;
  }
  return null;
}

function render(resetScroll) {
  const files = (state.scan && state.scan.files) || [];
  const root = buildTree(files);

  if (state.view && !findNode(root, state.view)) {
    state.view = "";
  }

  const listEl = $("list");
  const treeEl = $("tree");
  const listScroll = listEl.scrollTop;
  const treeScroll = treeEl.scrollTop;

  renderTree(root);
  const visible = visibleFiles(root);
  state.visible = visible;
  renderRows(visible);
  renderCrumbs();
  renderFooters(files);
  renderSortMarks();

  $("sidebar-head-count").textContent = files.length ? String(files.length) : "";
  $("content-foot").textContent = files.length
    ? `Показано ${visible.length} из ${files.length}`
    : "";

  if (resetScroll) {
    listEl.scrollTop = 0;
    treeEl.scrollTop = 0;
  } else {
    listEl.scrollTop = listScroll;
    treeEl.scrollTop = treeScroll;
  }
}

function renderTree(root) {
  const treeEl = $("tree");
  treeEl.textContent = "";
  const walk = (node, depth) => {
    treeEl.appendChild(treeItem(node, depth));
    for (const kid of node.sortedChildren || []) walk(kid, depth + 1);
  };
  walk(root, 0);
}

function treeItem(node, depth) {
  const item = el("div", "tree-item");
  item.style.setProperty("--depth", String(depth));
  if (state.view === node.path) item.classList.add("active");

  const box = el("input");
  box.type = "checkbox";
  const eligible = node.eligible.length;
  const chosen = node.eligible.filter((p) => state.selected.has(p)).length;
  box.checked = eligible > 0 && chosen === eligible;
  box.indeterminate = chosen > 0 && chosen < eligible;
  box.disabled = eligible === 0;
  box.title = eligible ? `Выбрать всё: ${eligible}` : "Нет файлов со звуком";
  box.addEventListener("click", (e) => e.stopPropagation());
  box.addEventListener("change", () => {
    if (box.checked) {
      for (const p of node.eligible) state.selected.add(p);
    } else {
      for (const p of node.eligible) state.selected.delete(p);
    }
    state.lastIndex = -1;
    render();
  });
  const wrap = el("label", "check");
  wrap.appendChild(box);

  const label = el("button", "tree-label");
  label.type = "button";
  label.title = node.path || "Все файлы";
  label.appendChild(el("span", "tree-name", node.name));
  label.addEventListener("click", () => {
    state.view = node.path;
    state.lastIndex = -1;
    render(true);
  });

  const badge = el("span", "badge", eligible ? String(eligible) : "");
  if (!eligible) badge.classList.add("empty");
  badge.title = `${node.count} видео · ${eligible} со звуком`;

  item.append(wrap, label, badge);
  return item;
}

function visibleFiles(root) {
  const files = (state.scan && state.scan.files) || [];
  const q = state.query.trim().toLowerCase();
  let list;
  if (!state.view) {
    list = files.slice();
  } else {
    const node = findNode(root, state.view);
    list = node ? node.files.slice() : [];
  }
  if (q) {
    list = list.filter((f) => f.rel.toLowerCase().includes(q));
  }

  list.sort((a, b) => {
    let cmp = 0;
    switch (state.sortKey) {
      case "size":
        cmp = a.size - b.size;
        break;
      case "savings":
        cmp = a.est_savings - b.est_savings;
        break;
      case "duration":
        cmp = a.duration - b.duration;
        break;
      default:
        cmp = a.rel.localeCompare(b.rel, "ru", { sensitivity: "base" });
    }
    if (cmp === 0) cmp = a.rel.localeCompare(b.rel, "ru");
    return cmp * state.sortDir;
  });
  return list;
}

function renderRows(list) {
  const listEl = $("list");
  listEl.textContent = "";
  const showSub = !state.view;
  for (let i = 0; i < list.length; i++) {
    listEl.appendChild(fileRow(list[i], i, showSub));
  }

  const empty = $("empty");
  empty.hidden = list.length > 0;
  if (list.length === 0) {
    const files = (state.scan && state.scan.files) || [];
    let text;
    if (state.query.trim()) {
      text = "По фильтру ничего не нашлось.";
    } else if (files.length) {
      text = "В этой папке нет видео напрямую. Видео из подпапок — в дереве слева.";
    } else if (state.scan && state.scan.running) {
      text = "Ищу видео…";
    } else {
      text = "Выберите другую папку.";
    }
    $("empty-text").textContent = text;
  }
  updateSelectAll();
}

function fileRow(f, index, showSub) {
  const ok = isEligible(f);
  const row = el("div", "row");
  row.dataset.path = f.path;
  if (ok && state.selected.has(f.path)) row.classList.add("selected");

  const box = el("input");
  box.type = "checkbox";
  box.checked = state.selected.has(f.path);
  box.disabled = !ok;
  box.addEventListener("click", (e) => e.stopPropagation());
  box.addEventListener("change", (e) => {
    applySelect(f.path, box.checked, e.shiftKey);
    render();
  });
  const wrap = el("label", "check");
  wrap.appendChild(box);

  const fileCell = el("div", "cell file");
  fileCell.appendChild(el("div", "name", baseName(f.rel)));

  const note = rowNote(f);
  if (showSub) {
    const dir = dirName(f.rel);
    if (dir) fileCell.appendChild(el("div", "sub", dir));
  }
  if (note.text) {
    fileCell.appendChild(el("div", "sub " + note.kind, note.text));
  }

  const dur = el("div", "cell num", f.probed ? fmtDur(f.duration) : "…");
  const size = el("div", "cell num", fmtBytes(f.size));
  const codec = el("div", "cell", f.probed ? (f.has_audio ? audioLabel(f) : "—") : "…");

  const save = el("div", "cell num save");
  if (!f.probed) {
    save.textContent = "…";
  } else if (f.has_audio && !f.error) {
    save.textContent = "≈ " + fmtBytes(f.est_savings);
    const pct = f.size > 0 ? Math.round((f.est_savings * 100) / f.size) : 0;
    save.appendChild(el("span", "pct", pct + "%"));
  } else {
    save.textContent = "—";
  }

  row.append(wrap, fileCell, dur, size, codec, save);
  row.addEventListener("click", (e) => {
    if (e.target.closest("input, label, button")) return;
    if (!ok) return;
    applySelect(f.path, !state.selected.has(f.path), e.shiftKey);
    render();
  });
  return row;
}

function rowNote(f) {
  if (f.error) return { text: f.error, kind: "err" };
  if (!f.probed) {
    return state.scan && state.scan.running
      ? { text: "проверяется…", kind: "muted" }
      : { text: "не проверен", kind: "muted" };
  }
  if (!f.has_video) return { text: "не видео", kind: "muted" };
  if (!f.has_audio) return { text: "звука нет — удалять нечего", kind: "muted" };
  return { text: "", kind: "" };
}

function applySelect(path, value, shift) {
  const idx = state.visible.findIndex((f) => f.path === path);
  if (shift && state.lastIndex >= 0 && idx >= 0) {
    const from = Math.min(state.lastIndex, idx);
    const to = Math.max(state.lastIndex, idx);
    for (let i = from; i <= to; i++) {
      const f = state.visible[i];
      if (!isEligible(f)) continue;
      if (value) state.selected.add(f.path);
      else state.selected.delete(f.path);
    }
  } else if (value) {
    state.selected.add(path);
  } else {
    state.selected.delete(path);
  }
  if (idx >= 0) state.lastIndex = idx;
}

function onSelectAll() {
  const value = $("select-all").checked;
  for (const f of state.visible) {
    if (!isEligible(f)) continue;
    if (value) state.selected.add(f.path);
    else state.selected.delete(f.path);
  }
  state.lastIndex = -1;
  render();
}

function updateSelectAll() {
  const eligible = state.visible.filter(isEligible);
  const chosen = eligible.filter((f) => state.selected.has(f.path)).length;
  const box = $("select-all");
  box.disabled = eligible.length === 0;
  box.checked = eligible.length > 0 && chosen === eligible.length;
  box.indeterminate = chosen > 0 && chosen < eligible.length;
}

function renderCrumbs() {
  const crumbs = $("crumbs");
  crumbs.textContent = "";
  crumbs.appendChild(crumbButton("Все файлы", "", state.view === ""));
  if (state.view) {
    let acc = "";
    for (const part of state.view.split("/")) {
      acc = acc ? acc + "/" + part : part;
      crumbs.appendChild(el("span", "crumb-sep", "›"));
      crumbs.appendChild(crumbButton(part, acc, acc === state.view));
    }
  }
  if (state.query.trim()) {
    crumbs.appendChild(el("span", "crumb-sep", "·"));
    crumbs.appendChild(el("span", "crumb-search", "поиск: " + state.query.trim()));
  }
}

function crumbButton(text, view, current) {
  const btn = el("button", "crumb-btn" + (current ? " current" : ""), text);
  btn.type = "button";
  btn.title = view || "Все файлы";
  btn.addEventListener("click", () => {
    state.view = view;
    state.lastIndex = -1;
    render(true);
  });
  return btn;
}

function renderFooters(files) {
  const eligible = files.filter(isEligible);
  const selected = files.filter((f) => isEligible(f) && state.selected.has(f.path));
  const savings = selected.reduce((sum, f) => sum + (f.est_savings || 0), 0);

  $("selinfo").textContent = selected.length
    ? `Выбрано ${selected.length} из ${eligible.length} · звук ≈ ${fmtBytes(savings)}`
    : `Выбрано 0 из ${eligible.length}`;

  $("sidebar-foot").textContent = files.length
    ? `${files.length} ${plural(files.length, "видео", "видео", "видео")} · ${eligible.length} со звуком`
    : (state.scan && state.scan.running ? "Сканирование…" : "Видео не найдено");

  const busy = (state.scan && state.scan.running) || (state.proc && state.proc.running);
  const start = $("start");
  start.disabled = selected.length === 0 || !state.toolsReady || !!busy;
  start.textContent = state.deleting ? "Удалить звук и файлы" : "Удалить звук";
}

function renderSortMarks() {
  document.querySelectorAll(".th.sortable").forEach((btn) => {
    const arrow = btn.querySelector(".arrow");
    if (btn.dataset.sort === state.sortKey) {
      arrow.textContent = state.sortDir > 0 ? "↑" : "↓";
    } else {
      arrow.textContent = "";
    }
  });
}

function onSort(key) {
  if (state.sortKey === key) {
    state.sortDir *= -1;
  } else {
    state.sortKey = key;
    state.sortDir = key === "name" ? 1 : -1;
  }
  render();
}

function selectedFiles() {
  const files = (state.scan && state.scan.files) || [];
  return files.filter((f) => isEligible(f) && state.selected.has(f.path));
}

function onStart() {
  const chosen = selectedFiles();
  if (!chosen.length) return;
  if (state.deleting) {
    const size = chosen.reduce((sum, f) => sum + (f.size || 0), 0);
    $("confirm-text").textContent =
      `Будет обработано ${chosen.length} ${plural(chosen.length, "файл", "файла", "файлов")} (${fmtBytes(size)}).`;
    $("confirm-overlay").hidden = false;
    return;
  }
  startProcess();
}

async function startProcess() {
  const paths = selectedFiles().map((f) => f.path);
  if (!paths.length) return;
  try {
    await api("/api/process", "POST", { paths, delete_source: state.deleting });
  } catch (e) {
    showBanner(e.message);
    return;
  }

  state.proc = null;
  state.procToken++;
  $("progress-title").textContent = state.deleting ? "Удаляю звук и исходники" : "Удаляю звук";
  $("progress-bar").style.width = "0%";
  $("progress-line").textContent = "Подготовка…";
  $("progress-cancel").disabled = false;
  $("progress-overlay").hidden = false;
  pollProcess(state.procToken);
}

async function cancelProcess() {
  $("progress-cancel").disabled = true;
  $("progress-line").textContent = "Останавливаю…";
  try {
    await api("/api/process/cancel", "POST", {});
  } catch {
    // опрос покажет фактическое состояние
  }
}

async function pollProcess(token) {
  if (token !== state.procToken) return;
  let st;
  try {
    st = await api("/api/process/status");
  } catch (e) {
    showBanner(e.message);
    $("progress-overlay").hidden = true;
    return;
  }
  if (token !== state.procToken) return;

  state.proc = st;
  const pct = Math.round((st.fraction || 0) * 100);
  $("progress-bar").style.width = pct + "%";

  if (st.running) {
    const cur = st.current_fraction ? Math.round(st.current_fraction * 100) + "%" : "…";
    const num = Math.min(st.done + 1, st.total);
    $("progress-line").textContent = `${num} из ${st.total} · ${st.current || "подготовка"} · ${cur}`;
    setTimeout(() => pollProcess(token), 300);
  } else {
    $("progress-overlay").hidden = true;
    showResult(st);
  }
}

function showResult(st) {
  const files = st.files || [];
  const done = files.filter((f) => f.status === "done");
  const errors = files.filter((f) => f.status === "error");
  const cancelled = files.filter((f) => f.status === "cancelled");
  const warnings = files.filter((f) => f.warning);
  const saved = done.reduce((sum, f) => sum + (f.saved || 0), 0);

  $("result-title").textContent = cancelled.length ? "Остановлено" : "Готово";

  const parts = [`Обработано ${done.length} из ${st.total}.`];
  if (saved > 0) {
    parts.push(st.delete_source
      ? `Освобождено ≈ ${fmtBytes(saved)}.`
      : `Файлы стали меньше на ≈ ${fmtBytes(saved)}.`);
  }
  if (errors.length) parts.push(`Ошибок: ${errors.length}.`);
  if (cancelled.length) parts.push(`Отменено: ${cancelled.length}.`);
  $("result-summary").textContent = parts.join(" ");

  const notes = [];
  for (const f of errors) notes.push({ kind: "err", text: `${f.rel}: ${f.error}` });
  for (const f of warnings) notes.push({ kind: "warn", text: `${f.rel}: ${f.warning}` });
  const notesEl = $("result-notes");
  notesEl.textContent = "";
  notesEl.hidden = notes.length === 0;
  for (const n of notes) notesEl.appendChild(el("div", "note " + n.kind, n.text));

  state.resultDir = st.dir || state.dir;
  $("result-overlay").hidden = false;
}

async function openFolder() {
  try {
    await api("/api/open", "POST", { path: state.resultDir || state.dir });
  } catch (e) {
    showBanner(e.message);
  }
}

init();
