const $ = (id) => document.getElementById(id);

const state = {
  dir: "",
  scan: null,
  scanRoot: null,
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
  fsLoaded: false,
  drives: [],
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
    } else {
      $("tools-chip").hidden = true;
      showBanner(tools.error || "ffmpeg/ffprobe не найдены");
    }
  } catch (e) {
    showBanner(e.message);
  }

  $("rescan").addEventListener("click", () => state.dir && startScan(state.dir));
  $("scan-cancel").addEventListener("click", cancelScan);
  $("tree-refresh").addEventListener("click", refreshTree);
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

  await loadDrives();

  try {
    const cfg = await api("/api/config");
    if (cfg.last_dir && state.toolsReady) {
      await startScan(cfg.last_dir);
      return;
    }
  } catch {
    // конфиг не критичен
  }
  render(true);
}

function normPath(p) {
  return p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function withinRoot(p) {
  if (!state.dir) return false;
  const root = normPath(state.dir);
  const path = normPath(p);
  return path === root || path.startsWith(root + "\\");
}

function relToRoot(p) {
  if (!state.dir) return "";
  const root = state.dir.replace(/[\\/]+$/, "");
  const path = p.replace(/[\\/]+$/, "");
  if (normPath(path) === normPath(root)) return "";
  if (path.length <= root.length) return "";
  return path.slice(root.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
}

function makeFsNode(name, path, depth, isDrive) {
  return {
    name,
    path,
    depth,
    isDrive: !!isDrive,
    expanded: false,
    loaded: false,
    loading: false,
    loadingPromise: null,
    error: "",
    children: [],
  };
}

async function loadDrives() {
  try {
    const res = await api("/api/fs/drives");
    state.drives = ((res && res.drives) || []).map((d) => makeFsNode(d.name, d.path, 0, true));
  } catch (e) {
    showBanner("Не удалось получить список дисков: " + e.message);
  }
  state.fsLoaded = true;
  render(true);
}

function loadChildren(node) {
  if (node.loaded) return Promise.resolve();
  if (node.loadingPromise) return node.loadingPromise;
  node.loading = true;
  node.loadingPromise = api("/api/fs/list?path=" + encodeURIComponent(node.path))
    .then((res) => {
      node.children = ((res && res.dirs) || []).map((d) => makeFsNode(d.name, d.path, node.depth + 1, false));
      node.error = (res && res.error) || "";
      node.loaded = true;
    })
    .catch((err) => {
      node.error = err.message;
      node.loaded = true;
    })
    .finally(() => {
      node.loading = false;
      node.loadingPromise = null;
      render();
    });
  render();
  return node.loadingPromise;
}

async function toggleExpand(node) {
  node.expanded = !node.expanded;
  render();
  if (node.expanded && !node.loaded) {
    await loadChildren(node);
  }
}

async function revealPath(path) {
  const target = path.replace(/[\\/]+$/, "");
  const letter = target.slice(0, 2);
  const drive = state.drives.find((d) => d.isDrive && normPath(d.path) === normPath(letter));
  if (!drive) return;

  let node = drive;
  node.expanded = true;
  await loadChildren(node);

  let prefix = drive.path.replace(/[\\/]+$/, "");
  const rest = target.slice(2).split(/[\\/]/).filter(Boolean);
  for (const part of rest) {
    const wanted = normPath(prefix + "\\" + part);
    const child = node.children.find((c) => normPath(c.path) === wanted);
    if (!child) break;
    child.expanded = true;
    node = child;
    prefix = prefix + "\\" + part;
    await loadChildren(child);
  }

  render();
  scrollActiveIntoView("center");
}

async function refreshTree() {
  state.fsLoaded = false;
  state.drives = [];
  render(true);
  await loadDrives();
  if (state.dir) await revealPath(state.dir);
}

function onFsNodeClick(node, inRoot) {
  if (node.isDrive) {
    toggleExpand(node);
    return;
  }
  if (inRoot) {
    state.view = relToRoot(node.path);
    state.lastIndex = -1;
    render(true);
    if (!node.expanded) {
      node.expanded = true;
      loadChildren(node);
    }
    scrollActiveIntoView("nearest");
    return;
  }
  startScan(node.path);
}

function scrollActiveIntoView(block = "nearest") {
  const active = document.querySelector(".tree-item.active");
  if (active) active.scrollIntoView({ block });
}

async function startScan(dir) {
  if (!state.toolsReady) {
    showBanner("ffmpeg/ffprobe не найдены — сканирование недоступно.");
    return;
  }
  try {
    await api("/api/scan", "POST", { dir });
  } catch (e) {
    showBanner(e.message);
    return;
  }

  const sameDir = normPath(dir) === normPath(state.dir);
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
  $("rescan").hidden = false;
  $("rescan").disabled = true;
  $("scan-inline").hidden = false;
  $("scan-cancel").hidden = false;
  $("scan-cancel").disabled = false;
  $("scan-bar").style.width = "0%";
  $("scan-text").textContent = "Сканирование…";
  hideBanner();

  render(true);
  revealPath(dir);
  pollScan(state.scanToken);
}

async function cancelScan() {
  $("scan-cancel").disabled = true;
  try {
    await api("/api/scan/cancel", "POST", {});
  } catch {
    // следующий опрос покажет состояние
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
  state.scanRoot = root;

  const listEl = $("list");
  const treeEl = $("tree");
  const listScroll = listEl.scrollTop;
  const treeScroll = treeEl.scrollTop;

  renderSidebarTree(root);
  const visible = visibleFiles(root);
  state.visible = visible;
  renderRows(visible);
  renderCrumbs();
  renderFooters(files);
  renderSortMarks();

  const hasDir = !!state.dir;
  $("content-welcome").hidden = hasDir;
  $("content-main").hidden = !hasDir;
  $("actionbar").hidden = !hasDir;

  $("content-foot").textContent = files.length ? `Показано ${visible.length} из ${files.length}` : "";

  if (resetScroll) {
    listEl.scrollTop = 0;
  } else {
    listEl.scrollTop = listScroll;
  }
  treeEl.scrollTop = treeScroll;
}

function renderSidebarTree(scanRoot) {
  const treeEl = $("tree");
  treeEl.textContent = "";
  if (!state.fsLoaded) {
    treeEl.appendChild(el("div", "tree-msg", "Загрузка дисков…"));
    return;
  }
  if (!state.drives.length) {
    treeEl.appendChild(el("div", "tree-msg", "Диски не найдены"));
    return;
  }
  for (const drive of state.drives) {
    appendFsNode(treeEl, drive, scanRoot);
  }
}

function appendFsNode(container, node, scanRoot) {
  const inRoot = withinRoot(node.path);
  const rel = inRoot ? relToRoot(node.path) : "";
  const scanNode = inRoot ? findNode(scanRoot, rel) : null;

  const item = el("div", "tree-item");
  item.style.setProperty("--depth", String(node.depth));
  if (state.dir && normPath(node.path) === normPath(state.dir)) item.classList.add("scan-root");
  if (inRoot && state.view === rel) item.classList.add("active");

  const arrow = el("button", "tree-arrow" + (node.expanded ? " open" : ""), node.expanded ? "▾" : "▸");
  arrow.type = "button";
  arrow.title = node.expanded ? "Свернуть" : "Развернуть";
  if (node.loading) arrow.textContent = "…";
  arrow.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleExpand(node);
  });

  let checkCell;
  if (inRoot && scanNode) {
    const box = el("input");
    box.type = "checkbox";
    const eligible = scanNode.eligible;
    const chosen = eligible.filter((p) => state.selected.has(p)).length;
    box.checked = eligible.length > 0 && chosen === eligible.length;
    box.indeterminate = chosen > 0 && chosen < eligible.length;
    box.disabled = eligible.length === 0;
    box.title = eligible.length ? `Выбрать всё в этой папке: ${eligible.length}` : "Нет файлов со звуком";
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("change", () => {
      if (box.checked) {
        for (const p of eligible) state.selected.add(p);
      } else {
        for (const p of eligible) state.selected.delete(p);
      }
      state.lastIndex = -1;
      render();
    });
    checkCell = el("label", "check");
    checkCell.appendChild(box);
  } else {
    checkCell = el("span", "check-spacer");
  }

  const label = el("button", "tree-label");
  label.type = "button";
  label.title = node.path;
  label.appendChild(el("span", "tree-name", node.name));
  label.addEventListener("click", () => onFsNodeClick(node, inRoot));

  const badge = el("span", "badge");
  if (inRoot && scanNode && scanNode.eligible.length) {
    badge.textContent = String(scanNode.eligible.length);
    badge.title = `${scanNode.count} видео · ${scanNode.eligible.length} со звуком`;
  } else {
    badge.classList.add("hidden");
  }

  item.append(arrow, checkCell, label, badge);
  container.appendChild(item);

  if (!node.expanded) return;
  if (node.loading) {
    container.appendChild(treeMessage("Загрузка…", node.depth + 1, ""));
    return;
  }
  if (node.error) {
    container.appendChild(treeMessage(node.error, node.depth + 1, "err"));
    return;
  }
  if (!node.children.length) {
    container.appendChild(treeMessage("Пусто", node.depth + 1, ""));
    return;
  }
  for (const child of node.children) {
    appendFsNode(container, child, scanRoot);
  }
}

function treeMessage(text, depth, cls) {
  const msg = el("div", "tree-msg" + (cls ? " " + cls : ""), text);
  msg.style.setProperty("--depth", String(depth));
  return msg;
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
      const node = state.view ? findNode(state.scanRoot, state.view) : null;
      text = state.view && !node
        ? "В этой папке нет видео."
        : "В этой папке нет видео напрямую. Видео из подпапок — в дереве слева.";
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
    scrollActiveIntoView("nearest");
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

  if (!state.dir) {
    $("sidebar-foot").textContent = "Выберите папку";
  } else if (files.length) {
    $("sidebar-foot").textContent = `${files.length} видео · ${eligible.length} со звуком`;
  } else if (state.scan && state.scan.running) {
    $("sidebar-foot").textContent = "Сканирование…";
  } else {
    $("sidebar-foot").textContent = "Видео не найдено";
  }

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
